import { tool } from "ai";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeErrorMessageForDisplay } from "@/common/utils/providerOutputSanitization";
import type { IntuitionToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { runMemoryIntuition } from "@/node/services/memoryIntuition";
import { memoryScopeContextFromToolConfig } from "./memory";
import { deriveToolHookConfig } from "./withHooks";

export const createIntuitionTool: ToolFactory = (config: ToolConfiguration) => {
  const runtime = config.intuitionRuntime;
  const memoryService = config.memoryService;
  assert(runtime, "intuition tool requires intuitionRuntime");
  assert(memoryService, "intuition tool requires memoryService");
  const model = runtime.modelString.trim();
  assert(model.length > 0, "intuition model must be non-empty");
  assert(
    Number.isSafeInteger(runtime.maxUsesPerTurn) && runtime.maxUsesPerTurn > 0,
    "intuition maxUsesPerTurn must be a positive integer"
  );
  assert(
    Number.isSafeInteger(runtime.usesThisTurn) && runtime.usesThisTurn >= 0,
    "intuition usesThisTurn must be a non-negative integer"
  );
  const ctx = memoryScopeContextFromToolConfig(config);
  const hooks = deriveToolHookConfig(config) ?? undefined;

  return tool({
    description: TOOL_DEFINITIONS.intuition.description,
    inputSchema: TOOL_DEFINITIONS.intuition.schema,
    execute: async ({ cue }, { abortSignal, toolCallId }): Promise<IntuitionToolResult> => {
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, runtime.abortSignal])
        : runtime.abortSignal;
      const cancelled = (): IntuitionToolResult => ({
        kind: "error",
        isError: true,
        message: "Intuition request cancelled.",
      });
      if (signal.aborted) return cancelled();
      if (runtime.usesThisTurn >= runtime.maxUsesPerTurn) {
        return {
          kind: "limit_reached",
          message: `Intuition limit reached for this turn (max ${runtime.maxUsesPerTurn} uses).`,
        };
      }
      // Reserve before awaiting so parallel calls cannot bypass the per-turn cap.
      runtime.usesThisTurn++;
      try {
        const result = await runMemoryIntuition({
          createModel: () => runtime.createModel(model),
          hooks,
          resolveAgentBody: () => runtime.resolveAgentBody(),
          modelString: model,
          thinkingLevel: runtime.thinkingLevel,
          memoryService,
          ctx,
          cue,
          abortSignal: signal,
          recordUsage: (usage, providerMetadata, metadataModel) =>
            Promise.resolve(
              config.reportModelUsage?.({
                source: "tool",
                toolName: "intuition",
                model,
                metadataModel,
                usage,
                providerMetadata,
                toolCallId,
                timestamp: Date.now(),
              })
            ),
        });
        // The runner also uses abort for its own timeout. Only caller cancellation
        // is an error; exhausting the bounded search is uncertainty, not a failure.
        if (signal.aborted) return cancelled();
        if (result.kind === "error") {
          return {
            kind: "error",
            isError: true,
            message: sanitizeErrorMessageForDisplay(result.message),
          };
        }
        const fields = { cue, model, stats: result.stats };
        if (result.kind === "report") {
          if (result.memories.length > 0) {
            // Commit point: cancellation was checked above. Once recall metadata
            // starts persisting it cannot be rolled back; return the recognized
            // result rather than an error with already-recorded side effects.
            for (const path of new Set(result.memories.map((memory) => memory.path))) {
              await memoryService.recordRecall(ctx, path);
            }
            return {
              kind: "recognized",
              ...fields,
              memories: result.memories,
              candidates: result.candidates,
            };
          }
          return { kind: "uncertain", ...fields, candidates: result.candidates };
        }
        return {
          kind: "uncertain",
          ...fields,
          candidates: [],
          note: result.stats.timedOut
            ? "Memory search timed out without a verified report."
            : result.stats.indexEntriesConsidered === 0
              ? "No memories are available yet."
              : "Memory search ended without a verified report.",
        };
      } catch (error) {
        return {
          kind: "error",
          isError: true,
          message: sanitizeErrorMessageForDisplay(getErrorMessage(error)),
        };
      }
    },
  });
};
