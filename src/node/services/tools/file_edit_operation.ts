import {
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  type FileEditDiffSuccessBase,
  type FileEditErrorResult,
} from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  generateDiff,
  resolvePathWithinCwd,
  validateFileSize,
  validatePlanModeAccess,
} from "./fileCommon";
import { RuntimeError } from "@/node/runtime/Runtime";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

type FileEditOperationResult<TMetadata> =
  | {
      success: true;
      newContent: string;
      metadata: TMetadata;
    }
  | {
      success: false;
      error: string;
      note?: string; // Agent-only message (not displayed in UI)
    };

type ExecuteFileEditReturn<TMetadata> = FileEditErrorResult | (FileEditDiffSuccessBase & TMetadata);

interface ExecuteFileEditOperationOptions<TMetadata> {
  config: ToolConfiguration;
  filePath: string;
  operation: (
    originalContent: string
  ) => FileEditOperationResult<TMetadata> | Promise<FileEditOperationResult<TMetadata>>;
  abortSignal?: AbortSignal;
}
const fileEditLocksByRuntime = new WeakMap<Runtime, MutexMap<string>>();

function getFileEditLocks(runtime: Runtime): MutexMap<string> {
  let locks = fileEditLocksByRuntime.get(runtime);
  if (!locks) {
    locks = new MutexMap<string>();
    fileEditLocksByRuntime.set(runtime, locks);
  }
  return locks;
}

function getAbortedFileEditResult(abortSignal?: AbortSignal): FileEditErrorResult | null {
  if (!abortSignal?.aborted) {
    return null;
  }

  const abortReason: unknown =
    abortSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  return {
    success: false,
    error: `Failed to edit file: ${getErrorMessage(abortReason)}`,
  };
}

async function waitForFileEditOrAbort<TMetadata>(
  operationPromise: Promise<ExecuteFileEditReturn<TMetadata>>,
  abortSignal: AbortSignal | undefined,
  canReturnAbortBeforeWrite: () => boolean
): Promise<ExecuteFileEditReturn<TMetadata>> {
  const abortedResult = getAbortedFileEditResult(abortSignal);
  if (abortedResult) {
    return abortedResult;
  }

  if (!abortSignal) {
    return operationPromise;
  }

  return new Promise<ExecuteFileEditReturn<TMetadata>>((resolve, reject) => {
    const onAbort = () => {
      if (!canReturnAbortBeforeWrite()) {
        return;
      }

      abortSignal.removeEventListener("abort", onAbort);
      resolve(getAbortedFileEditResult(abortSignal)!);
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (result) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    );
  });
}

/**
 * Shared execution pipeline for file edit tools.
 * Handles validation, file IO, diff generation, and common error handling.
 */
export async function executeFileEditOperation<TMetadata>({
  config,
  filePath,
  operation,
  abortSignal,
}: ExecuteFileEditOperationOptions<TMetadata>): Promise<
  FileEditErrorResult | (FileEditDiffSuccessBase & TMetadata)
> {
  try {
    const {
      correctedPath: validatedPath,
      warning: pathWarning,
      resolvedPath,
    } = await resolvePathWithinCwd(filePath, config.cwd, config.runtime);
    filePath = validatedPath;

    // Validate plan mode access restrictions
    const planModeError = await validatePlanModeAccess(filePath, config);
    if (planModeError) {
      return planModeError;
    }

    const abortedBeforeLock = getAbortedFileEditResult(abortSignal);
    if (abortedBeforeLock) {
      return abortedBeforeLock;
    }

    // Serialize same-file edits so a later operation re-reads the file after the
    // earlier write lands instead of racing on stale content or temp-file writes.
    let writeStarted = false;
    const lockedEditPromise: Promise<ExecuteFileEditReturn<TMetadata>> = getFileEditLocks(
      config.runtime
    ).withLock(resolvedPath, async () => {
      // Abort can fire while we wait on the lock, and local runtime file I/O does
      // not observe abort signals on its own, so re-check before touching disk.
      const abortedAfterLock = getAbortedFileEditResult(abortSignal);
      if (abortedAfterLock) {
        return abortedAfterLock;
      }

      // Check if file exists and get stats using runtime
      let fileStat;
      try {
        fileStat = await config.runtime.stat(resolvedPath, abortSignal);
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false,
            error: err.message,
          };
        }
        throw err;
      }

      if (fileStat.isDirectory) {
        return {
          success: false,
          error: `Path is a directory, not a file: ${resolvedPath}`,
        };
      }

      const sizeValidation = validateFileSize(fileStat);
      if (sizeValidation) {
        return {
          success: false,
          error: sizeValidation.error,
        };
      }

      // Read file content using runtime helper
      let originalContent: string;
      try {
        originalContent = await readFileString(config.runtime, resolvedPath, abortSignal);
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false,
            error: err.message,
          };
        }
        throw err;
      }

      const operationResult = await operation(originalContent);
      if (!operationResult.success) {
        return {
          success: false,
          error: operationResult.error,
          note: operationResult.note, // Pass through agent-only message
        };
      }

      const abortedBeforeWrite = getAbortedFileEditResult(abortSignal);
      if (abortedBeforeWrite) {
        return abortedBeforeWrite;
      }

      // Write file using runtime helper
      writeStarted = true;
      try {
        await writeFileString(
          config.runtime,
          resolvedPath,
          operationResult.newContent,
          abortSignal
        );
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false,
            error: err.message,
          };
        }
        throw err;
      }

      // Record file state for post-compaction attachment tracking
      if (config.recordFileState) {
        try {
          const newStat = await config.runtime.stat(resolvedPath, abortSignal);
          await config.recordFileState(resolvedPath, {
            content: operationResult.newContent,
            timestamp: newStat.modifiedTime.getTime(),
          });
        } catch {
          // File stat failed, skip recording (shouldn't happen since we just wrote it)
        }
      }

      const diff = generateDiff(resolvedPath, originalContent, operationResult.newContent);

      return {
        success: true,
        diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
        ui_only: {
          file_edit: {
            diff,
          },
        },
        ...operationResult.metadata,
        ...(pathWarning && { warning: pathWarning }),
      };
    });

    return waitForFileEditOrAbort(lockedEditPromise, abortSignal, () => !writeStarted);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const nodeError = error as { code?: string };
      if (nodeError.code === "ENOENT") {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      if (nodeError.code === "EACCES") {
        return {
          success: false,
          error: `Permission denied: ${filePath}`,
        };
      }
    }

    const message = getErrorMessage(error);
    return {
      success: false,
      error: `Failed to edit file: ${message}`,
    };
  }
}
