/**
 * Shared exec-backed file I/O for runtimes whose file operations run shell
 * commands (RemoteRuntime and DevcontainerRuntime's in-container fallback).
 * Callers own command construction and path canonicalization via the
 * startExec factory; these helpers own the streaming, abort, and error
 * plumbing so all exec-backed runtimes behave identically.
 */

import type { ExecStream, FileStat } from "./Runtime";
import { RuntimeError } from "./Runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { streamToString } from "./streamUtils";

/** Starts the exec for one file operation; must honor the given signal. */
type StartExec = (abortSignal: AbortSignal) => Promise<ExecStream>;

/**
 * Read file contents as a stream via exec.
 */
export function readFileViaExec(
  filePath: string,
  startExec: StartExec,
  abortSignal?: AbortSignal
): ReadableStream<Uint8Array> {
  // Internal controller so CANCELLING the returned stream kills the remote
  // cat: the eager pump below has no other path to the exec, and without
  // it a cancelled wrapper (e.g. mux.load's byte ceiling) left cat blocked
  // until its 300s timeout, accumulating remote processes (r18). The
  // caller's abortSignal forwards into the same controller.
  const readAbort = new AbortController();
  const forwardAbort = () => readAbort.abort();
  if (abortSignal?.aborted) {
    readAbort.abort();
  } else {
    abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const cleanupAbortForwarder = () => {
    abortSignal?.removeEventListener("abort", forwardAbort);
  };

  return new ReadableStream<Uint8Array>({
    cancel: () => {
      readAbort.abort();
      cleanupAbortForwarder();
    },
    start: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      try {
        const stream = await startExec(readAbort.signal);
        const reader = stream.stdout.getReader();
        const exitCodePromise = stream.exitCode;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }

        const code = await exitCodePromise;
        if (code !== 0) {
          const stderr = await streamToString(stream.stderr);
          throw new RuntimeError(`Failed to read file ${filePath}: ${stderr}`, "file_io");
        }

        controller.close();
      } catch (err) {
        if (err instanceof RuntimeError) {
          controller.error(err);
        } else {
          controller.error(
            new RuntimeError(
              `Failed to read file ${filePath}: ${getErrorMessage(err)}`,
              "file_io",
              err instanceof Error ? err : undefined
            )
          );
        }
      } finally {
        // Natural completion/error: stop listening on the caller's signal
        // so long-lived signals don't accumulate forwarders.
        cleanupAbortForwarder();
      }
    },
  });
}

/**
 * Write file contents atomically via exec. The exec starts lazily on the
 * first write, so an abort before any chunk never spawns a process.
 */
export function writeFileViaExec(
  filePath: string,
  startExec: StartExec,
  abortSignal?: AbortSignal
): WritableStream<Uint8Array> {
  let execPromise: Promise<ExecStream> | null = null;
  const writeAbortController = new AbortController();
  const abortWrite = () => writeAbortController.abort();
  if (abortSignal?.aborted) {
    writeAbortController.abort();
  } else {
    abortSignal?.addEventListener("abort", abortWrite, { once: true });
  }
  const cleanupAbortForwarder = () => {
    abortSignal?.removeEventListener("abort", abortWrite);
  };

  const getExecStream = () => {
    execPromise ??= startExec(writeAbortController.signal);
    return execPromise;
  };

  return new WritableStream<Uint8Array>({
    write: async (chunk: Uint8Array) => {
      const stream = await getExecStream();
      const writer = stream.stdin.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    },
    close: async () => {
      try {
        const stream = await getExecStream();
        await stream.stdin.close();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          throw new RuntimeError(`Failed to write file ${filePath}: ${stderr}`, "file_io");
        }
      } finally {
        cleanupAbortForwarder();
      }
    },
    abort: async (reason?: unknown) => {
      writeAbortController.abort();
      if (execPromise) {
        try {
          const stream = await execPromise;
          await stream.stdin.abort(reason).catch(() => undefined);
          await stream.exitCode.catch(() => undefined);
        } finally {
          cleanupAbortForwarder();
        }
      } else {
        cleanupAbortForwarder();
      }
      throw new RuntimeError(`Failed to write file ${filePath}: ${String(reason)}`, "file_io");
    },
  });
}

/**
 * Ensure a directory exists (mkdir -p semantics).
 */
export async function ensureDirViaExec(
  dirPath: string,
  startExec: () => Promise<ExecStream>
): Promise<void> {
  const stream = await startExec();
  await stream.stdin.close();

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
  ]);

  if (exitCode !== 0) {
    const extra = stderr.trim() || stdout.trim();
    throw new RuntimeError(
      `Failed to create directory ${dirPath}: exit code ${exitCode}${extra ? `: ${extra}` : ""}`,
      "file_io"
    );
  }
}

// -L follows symlinks so symlinked paths report the target's type.
export const STAT_VIA_EXEC_COMMAND = "stat -L -c '%s %Y %F'";

/**
 * Get file statistics via exec; parses STAT_VIA_EXEC_COMMAND output.
 */
export async function statViaExec(
  filePath: string,
  startExec: () => Promise<ExecStream>
): Promise<FileStat> {
  const stream = await startExec();
  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
  ]);

  if (exitCode !== 0) {
    throw new RuntimeError(`Failed to stat ${filePath}: ${stderr}`, "file_io");
  }

  const parts = stdout.trim().split(" ");
  if (parts.length < 3) {
    throw new RuntimeError(`Failed to parse stat output for ${filePath}: ${stdout}`, "file_io");
  }

  const size = parseInt(parts[0], 10);
  const mtime = parseInt(parts[1], 10);
  const fileType = parts.slice(2).join(" ");

  return {
    size,
    modifiedTime: new Date(mtime * 1000),
    isDirectory: fileType === "directory",
  };
}
