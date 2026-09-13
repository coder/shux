import { tool } from "ai";
import type { FileEditInsertToolArgs, FileEditInsertToolResult } from "@/common/types/tools";
import {
  EDIT_FAILED_NOTE_PREFIX,
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  NOTE_READ_FILE_RETRY,
} from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { generateDiff, resolvePathWithinCwd, validatePlanModeAccess } from "./fileCommon";
import { executeFileEditOperation } from "./file_edit_operation";
import { convertNewlines, detectFileEol } from "./eol";
import { fileExists } from "@/node/utils/runtime/fileExists";
import { writeFileString } from "@/node/utils/runtime/helpers";
import { RuntimeError } from "@/node/runtime/Runtime";
import { getErrorMessage } from "@/common/utils/errors";

const READ_AND_RETRY_NOTE = `${EDIT_FAILED_NOTE_PREFIX} ${NOTE_READ_FILE_RETRY}`;

interface InsertOperationSuccess {
  success: true;
  newContent: string;
  metadata: Record<string, never>;
}

interface InsertOperationFailure {
  success: false;
  error: string;
  note?: string;
}

type InsertContentOptions = Pick<FileEditInsertToolArgs, "insert_before" | "insert_after">;

interface GuardResolutionSuccess {
  success: true;
  index: number;
}

function guardFailure(error: string): InsertOperationFailure {
  return {
    success: false,
    error,
    note: READ_AND_RETRY_NOTE,
  };
}

export const createFileEditInsertTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.file_edit_insert.description,
    inputSchema: TOOL_DEFINITIONS.file_edit_insert.schema,
    execute: async (
      { path, content, insert_before, insert_after }: FileEditInsertToolArgs,
      { abortSignal }
    ): Promise<FileEditInsertToolResult> => {
      try {
        const {
          correctedPath,
          warning: pathWarning,
          resolvedPath,
        } = await resolvePathWithinCwd(path, config.cwd, config.runtime);
        path = correctedPath;

        // Validate plan mode access restrictions
        const planModeError = await validatePlanModeAccess(path, config);
        if (planModeError) {
          return planModeError;
        }

        const exists = await fileExists(config.runtime, resolvedPath, abortSignal);

        if (!exists) {
          try {
            await writeFileString(config.runtime, resolvedPath, content, abortSignal);
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
                content,
                timestamp: newStat.modifiedTime.getTime(),
              });
            } catch {
              // File stat failed, skip recording
            }
          }

          const diff = generateDiff(resolvedPath, "", content);
          return {
            success: true,
            diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
            ui_only: {
              file_edit: {
                diff,
              },
            },
            ...(pathWarning && { warning: pathWarning }),
          };
        }

        return executeFileEditOperation({
          config,
          filePath: path,
          abortSignal,
          operation: (originalContent) =>
            insertContent(originalContent, content, {
              insert_before,
              insert_after,
            }),
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EACCES") {
          return {
            success: false,
            error: `Permission denied: ${path}`,
          };
        }

        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to insert content: ${message}`,
        };
      }
    },
  });
};

function insertContent(
  originalContent: string,
  contentToInsert: string,
  options: InsertContentOptions
): InsertOperationSuccess | InsertOperationFailure {
  const { insert_before, insert_after } = options;

  if (insert_before != null && insert_after != null) {
    return guardFailure("Provide only one of insert_before or insert_after (not both).");
  }

  if (insert_before == null && insert_after == null) {
    // Empty existing files have no anchors to match against, so allow guardless
    // inserts that simply populate the file (mirrors the create-on-missing path).
    if (originalContent.length === 0) {
      return {
        success: true,
        newContent: contentToInsert,
        metadata: {},
      };
    }
    return guardFailure(
      "Provide either insert_before or insert_after guard when editing existing files."
    );
  }

  const fileEol = detectFileEol(originalContent);
  const normalizedContentToInsert = convertNewlines(contentToInsert, fileEol);

  return insertWithGuards(originalContent, normalizedContentToInsert, {
    insert_before,
    insert_after,
  });
}

function insertWithGuards(
  originalContent: string,
  contentToInsert: string,
  anchors: InsertContentOptions
): InsertOperationSuccess | InsertOperationFailure {
  const anchorResult = resolveGuardAnchor(originalContent, anchors);
  if (!anchorResult.success) {
    return anchorResult;
  }

  const newContent =
    originalContent.slice(0, anchorResult.index) +
    contentToInsert +
    originalContent.slice(anchorResult.index);

  return {
    success: true,
    newContent,
    metadata: {},
  };
}

function findUniqueSubstringIndex(
  haystack: string,
  needle: string,
  label: "insert_before" | "insert_after"
): GuardResolutionSuccess | InsertOperationFailure {
  const firstIndex = haystack.indexOf(needle);
  if (firstIndex === -1) {
    return guardFailure(`Guard mismatch: unable to find ${label} substring in the current file.`);
  }

  const secondIndex = haystack.indexOf(needle, firstIndex + needle.length);
  if (secondIndex !== -1) {
    return guardFailure(
      `Guard mismatch: ${label} substring matched multiple times. Include more surrounding context (e.g., full signature, adjacent lines) to make it unique.`
    );
  }

  return { success: true, index: firstIndex };
}

function resolveGuardAnchor(
  originalContent: string,
  { insert_before, insert_after }: InsertContentOptions
): GuardResolutionSuccess | InsertOperationFailure {
  const fileEol = detectFileEol(originalContent);

  // insert_after: content goes after this anchor, so insertion point is at end of anchor
  if (insert_after != null) {
    const exactResult = findUniqueSubstringIndex(originalContent, insert_after, "insert_after");
    if (exactResult.success) {
      return { success: true, index: exactResult.index + insert_after.length };
    }

    const normalized = convertNewlines(insert_after, fileEol);
    if (normalized !== insert_after) {
      const normalizedResult = findUniqueSubstringIndex(
        originalContent,
        normalized,
        "insert_after"
      );
      if (!normalizedResult.success) {
        return normalizedResult;
      }
      return {
        success: true,
        index: normalizedResult.index + normalized.length,
      };
    }

    return exactResult;
  }

  // insert_before: content goes before this anchor, so insertion point is at start of anchor
  if (insert_before != null) {
    const exactResult = findUniqueSubstringIndex(originalContent, insert_before, "insert_before");
    if (exactResult.success) {
      return { success: true, index: exactResult.index };
    }

    const normalized = convertNewlines(insert_before, fileEol);
    if (normalized !== insert_before) {
      const normalizedResult = findUniqueSubstringIndex(
        originalContent,
        normalized,
        "insert_before"
      );
      if (!normalizedResult.success) {
        return normalizedResult;
      }
      return { success: true, index: normalizedResult.index };
    }

    return exactResult;
  }

  return guardFailure("Unable to determine insertion point from guards.");
}
