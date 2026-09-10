import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { XumConfigReadToolArgs, XumConfigReadToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  hasOwnRecordKey,
  isObjectRecord,
  parseArrayIndex,
} from "@/node/services/tools/shared/configToolUtils";
import { redactConfigDocument } from "@/node/services/tools/shared/configRedaction";
// Parse-only read: schema validation is deferred to write boundaries,
// so callers can inspect schema-invalid configs before repair.
import { readConfigDocumentUnvalidated } from "@/node/services/tools/shared/configReadWrite";

export const createXumConfigReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_config_read.description,
    inputSchema: TOOL_DEFINITIONS.mux_config_read.schema,
    execute: async (
      args: XumConfigReadToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<XumConfigReadToolResult> => {
      try {
        const xumHome = config.xumScope!.xumHome;
        const rawDocument = await readConfigDocumentUnvalidated(xumHome, args.file);
        const redactedDocument = redactConfigDocument(args.file, rawDocument);
        const data = args.path != null ? getAtPath(redactedDocument, args.path) : redactedDocument;

        return {
          success: true,
          file: args.file,
          data,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to read mux config (${args.file}): ${message}`,
        };
      }
    },
  });
};

function getAtPath(root: unknown, pathSegments: readonly string[]): unknown {
  let current: unknown = root;

  for (const segment of pathSegments) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(segment);
      if (index === null || index >= current.length) {
        return null;
      }

      current = current[index];
      continue;
    }

    if (!isObjectRecord(current) || !hasOwnRecordKey(current, segment)) {
      return null;
    }

    current = current[segment];
  }

  return current;
}
