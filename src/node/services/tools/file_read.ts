import { tool } from "ai";
import type { FileReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { resolvePathWithinCwd, validateFileSize } from "./fileCommon";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * File read tool factory for AI assistant
 * Creates a tool that allows the AI to read file contents from the file system
 * @param config Required configuration including working directory
 */
export const createFileReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.file_read.description,
    inputSchema: TOOL_DEFINITIONS.file_read.schema,
    execute: async (
      { path, offset, limit },
      { abortSignal: _abortSignal }
    ): Promise<FileReadToolResult> => {
      // Note: abortSignal available but not used - file reads are fast and complete quickly

      let filePath = path;
      try {
        const {
          correctedPath: validatedPath,
          warning: pathWarning,
          resolvedPath,
        } = await resolvePathWithinCwd(filePath, config.cwd, config.runtime);
        filePath = validatedPath;

        // Check if file exists using runtime
        let fileStat;
        try {
          fileStat = await config.runtime.stat(resolvedPath);
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

        // Read full file content using runtime helper
        let fullContent: string;
        try {
          fullContent = await readFileString(config.runtime, resolvedPath);
        } catch (err) {
          if (err instanceof RuntimeError) {
            return {
              success: false,
              error: err.message,
            };
          }
          throw err;
        }

        const startLineNumber = offset ?? 1;

        // Validate offset
        if (offset != null && offset < 1) {
          return {
            success: false,
            error: `Offset must be positive (got ${offset})`,
          };
        }

        // Split content into lines for processing
        // Handle empty file case: splitting "" by "\n" gives [""], but we want []
        const lines = fullContent === "" ? [] : fullContent.split("\n");

        // Validate offset
        if (offset != null && offset > lines.length) {
          return {
            success: false,
            error: `Offset ${offset} is beyond file length`,
          };
        }

        const numberedLines: string[] = [];
        let totalBytesAccumulated = 0;
        const MAX_LINE_BYTES = 1024;
        const MAX_LINES = 1000;
        const MAX_TOTAL_BYTES = 16 * 1024; // 16KB

        // Process lines with offset and limit
        const startIdx = startLineNumber - 1; // Convert to 0-based index
        const endIdx = limit != null ? startIdx + limit : lines.length;

        for (let i = startIdx; i < Math.min(endIdx, lines.length); i++) {
          const line = lines[i];
          const lineNumber = i + 1;

          // Truncate line if it exceeds max bytes
          let processedLine = line;
          const lineBytes = Buffer.byteLength(line, "utf-8");
          if (lineBytes > MAX_LINE_BYTES) {
            // Truncate to MAX_LINE_BYTES
            processedLine = Buffer.from(line, "utf-8")
              .subarray(0, MAX_LINE_BYTES)
              .toString("utf-8");
            processedLine += "... [truncated]";
          }

          // Format line with number prefix
          const numberedLine = `${lineNumber}\t${processedLine}`;
          const numberedLineBytes = Buffer.byteLength(numberedLine, "utf-8");

          // Check if adding this line would exceed byte limit
          if (totalBytesAccumulated + numberedLineBytes > MAX_TOTAL_BYTES) {
            return {
              success: false,
              error: `Output would exceed ${MAX_TOTAL_BYTES} bytes. Please read less at a time using offset and limit parameters.`,
            };
          }

          numberedLines.push(numberedLine);
          totalBytesAccumulated += numberedLineBytes + 1; // +1 for newline

          // Check if we've exceeded max lines
          if (numberedLines.length > MAX_LINES) {
            return {
              success: false,
              error: `Output would exceed ${MAX_LINES} lines. Please read less at a time using offset and limit parameters.`,
            };
          }
        }

        // Join lines with newlines
        const content = numberedLines.join("\n");

        // Return file info and content
        return {
          success: true,
          file_size: fileStat.size,
          modifiedTime: fileStat.modifiedTime.toISOString(),
          lines_read: numberedLines.length,
          content,
          ...(pathWarning && { warning: pathWarning }),
        };
      } catch (error) {
        // Handle specific errors
        if (error && typeof error === "object" && "code" in error) {
          if (error.code === "ENOENT") {
            return {
              success: false,
              error: `File not found: ${filePath}`,
            };
          } else if (error.code === "EACCES") {
            return {
              success: false,
              error: `Permission denied: ${filePath}`,
            };
          }
        }

        // Generic error
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to read file: ${message}`,
        };
      }
    },
  });
};
