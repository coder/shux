import assert from "node:assert/strict";

import { streamText, tool, type Tool } from "ai";

import {
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
  ADVISOR_SYSTEM_PROMPT,
} from "@/common/constants/advisor";
import type { ModelMessage } from "@/common/types/message";
import { THINKING_LEVEL_OFF, coerceThinkingLevel } from "@/common/types/thinking";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { normalizeUsage, withCacheWriteMetadata } from "@/common/utils/tokens/usageHelpers";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeErrorMessageForDisplay } from "@/common/utils/providerOutputSanitization";
import type {
  AdvisorOutputEvent,
  AdvisorPhaseEvent,
  AdvisorReasoningOutputEvent,
} from "@/common/types/stream";
import { AdvisorToolInputSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { AdvisorToolCallSnapshot, ToolConfiguration } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import { flattenProviderExecutedToolParts } from "@/node/utils/messages/flattenProviderExecutedToolParts";
import { emitChatEventBestEffort } from "./toolUtils";

type StreamTextProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

type AdvisorHandoffMessage = Extract<ModelMessage, { role: "user" }>;

function hasNonWhitespaceContent(value: string | undefined): value is string {
  return value != null && value.trim().length > 0;
}

function tailTruncate(value: string, maxChars: number): string {
  assert(
    Number.isInteger(maxChars) && maxChars > 0,
    "advisor truncation maxChars must be positive"
  );

  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 3) {
    return value.slice(-maxChars);
  }

  return `...${value.slice(-(maxChars - 3))}`;
}

function buildAdvisorHandoffMessage(
  question: string | undefined,
  snapshot: AdvisorToolCallSnapshot | undefined
): AdvisorHandoffMessage | undefined {
  const stepText =
    snapshot != null && hasNonWhitespaceContent(snapshot.stepText)
      ? tailTruncate(snapshot.stepText, ADVISOR_HANDOFF_MAX_TEXT_CHARS)
      : undefined;
  const stepReasoning =
    snapshot != null && hasNonWhitespaceContent(snapshot.stepReasoning)
      ? tailTruncate(snapshot.stepReasoning, ADVISOR_HANDOFF_MAX_REASONING_CHARS)
      : undefined;

  if (question == null && stepText == null && stepReasoning == null) {
    return undefined;
  }

  const sections: string[] = ["## Advisor Handoff"];

  if (question != null) {
    sections.push(`**Question:** ${question}`);
  }

  if (stepText != null) {
    sections.push(`**Current-step commentary:**\n${stepText}`);
  }

  if (stepReasoning != null) {
    sections.push(`**Current-step reasoning:**\n${stepReasoning}`);
  }

  return {
    role: "user",
    content: sections.join("\n\n"),
  };
}

const ADVISOR_DELTA_TEXT_FIELDS = ["text", "delta", "textDelta"] as const;
const ADVISOR_TEXT_DELTA_TYPES = ["text-delta", "text"] as const;
const ADVISOR_REASONING_DELTA_TYPES = ["reasoning-delta", "reasoning"] as const;

function getAdvisorChunkDelta(
  chunk: unknown,
  acceptedTypes: readonly string[]
): string | undefined {
  if (typeof chunk !== "object" || chunk === null) {
    return undefined;
  }

  const record = chunk as Record<string, unknown>;
  if (typeof record.type !== "string" || !acceptedTypes.includes(record.type)) {
    return undefined;
  }

  const text = extractChunkDeltaText(record, ADVISOR_DELTA_TEXT_FIELDS);
  return text.length > 0 ? text : undefined;
}

function getAdvisorTextDelta(chunk: unknown): string | undefined {
  return getAdvisorChunkDelta(chunk, ADVISOR_TEXT_DELTA_TYPES);
}

function getAdvisorReasoningDelta(chunk: unknown): string | undefined {
  return getAdvisorChunkDelta(chunk, ADVISOR_REASONING_DELTA_TYPES);
}

export function createAdvisorTool(config: ToolConfiguration): Tool {
  assert(config.advisorRuntime, "advisorRuntime must be set when advisor tool is registered");

  const runtime = config.advisorRuntime;
  const advisorModelString = runtime.advisorModelString.trim();
  const reasoningLevel = runtime.reasoningLevel?.trim();
  const effectiveReasoningLevel = coerceThinkingLevel(reasoningLevel) ?? THINKING_LEVEL_OFF;

  assert(advisorModelString.length > 0, "advisorModelString must be a non-empty string");
  assert(
    reasoningLevel === undefined || reasoningLevel.length > 0,
    "advisor reasoningLevel must be undefined or a non-empty string"
  );
  assert(
    reasoningLevel === undefined || effectiveReasoningLevel === reasoningLevel,
    "advisor reasoningLevel must be a valid ThinkingLevel when provided"
  );
  assert(
    runtime.maxUsesPerTurn === null ||
      (Number.isInteger(runtime.maxUsesPerTurn) && runtime.maxUsesPerTurn > 0),
    "advisor maxUsesPerTurn must be null or a positive integer"
  );
  assert(
    runtime.maxOutputTokens === undefined ||
      (Number.isInteger(runtime.maxOutputTokens) && runtime.maxOutputTokens > 0),
    "advisor maxOutputTokens must be undefined or a positive integer"
  );
  assert(
    typeof runtime.getTranscriptSnapshot === "function",
    "advisor getTranscriptSnapshot must be a function"
  );
  assert(
    typeof runtime.takeToolCallSnapshot === "function",
    "advisor takeToolCallSnapshot must be a function"
  );
  assert(typeof runtime.createModel === "function", "advisor createModel must be a function");

  let usesThisTurn = 0;

  return tool({
    description: TOOL_DEFINITIONS.advisor.description,
    inputSchema: AdvisorToolInputSchema,
    execute: async (args, { abortSignal, toolCallId }) => {
      const question = args.question != null ? args.question.trim() || undefined : undefined;
      assert(
        question == null || question.length > 0,
        "advisor question must be undefined or a non-empty string after trimming"
      );

      const emitAdvisorPhase = (phase: AdvisorPhaseEvent["phase"]): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) {
          return;
        }

        emitChatEventBestEffort(
          config,
          {
            type: "advisor-phase",
            workspaceId: config.workspaceId,
            toolCallId,
            phase,
            timestamp: Date.now(),
          } satisfies AdvisorPhaseEvent,
          "advisor"
        );
      };

      const emitAdvisorOutput = (text: string): void => {
        assert(text.length > 0, "advisor output chunks must be non-empty");
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) {
          return;
        }

        emitChatEventBestEffort(
          config,
          {
            type: "advisor-output",
            workspaceId: config.workspaceId,
            toolCallId,
            text,
            timestamp: Date.now(),
          } satisfies AdvisorOutputEvent,
          "advisor"
        );
      };

      const emitAdvisorReasoningOutput = (text: string): void => {
        assert(text.length > 0, "advisor reasoning output chunks must be non-empty");
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) {
          return;
        }

        emitChatEventBestEffort(
          config,
          {
            type: "advisor-reasoning-output",
            workspaceId: config.workspaceId,
            toolCallId,
            text,
            timestamp: Date.now(),
          } satisfies AdvisorReasoningOutputEvent,
          "advisor"
        );
      };

      emitAdvisorPhase("preparing_context");

      if (runtime.maxUsesPerTurn !== null && usesThisTurn >= runtime.maxUsesPerTurn) {
        return {
          type: "limit_reached" as const,
          advisorModel: advisorModelString,
          reasoningLevel,
          message: `Advisor limit reached for this turn (max ${runtime.maxUsesPerTurn} uses).`,
        };
      }
      // Reserve the slot before any await so concurrent advisor calls cannot bypass the per-turn cap.
      usesThisTurn++;
      const remainingUses =
        runtime.maxUsesPerTurn !== null ? runtime.maxUsesPerTurn - usesThisTurn : null;

      // Flatten provider-executed (server-side) tool parts to text: the live
      // step transcript keeps them as assistant tool-call/tool-result parts,
      // which cannot be replayed against a different provider (e.g. OpenAI
      // rejects foreign `srvtoolu_...` ids as unknown item_references). See
      // flattenProviderExecutedToolParts for details.
      const transcript = flattenProviderExecutedToolParts(runtime.getTranscriptSnapshot());
      assert(Array.isArray(transcript), "advisor transcript snapshot must be an array");
      assert(transcript.length > 0, "advisor transcript snapshot must not be empty");
      assert(toolCallId, "advisor requires toolCallId");

      const snapshot = runtime.takeToolCallSnapshot(toolCallId);
      const handoffMessage = buildAdvisorHandoffMessage(question, snapshot);
      const messages: ModelMessage[] =
        handoffMessage != null ? [...transcript, handoffMessage] : transcript;

      try {
        const {
          model,
          metadataModel,
          optionsModelString,
          optionsProvidersConfig,
          optionsMuxProviderOptions,
          optionsRouteProvider,
        } = await runtime.createModel(advisorModelString);
        // Keep the creation-time identity, including the actual Coder instance
        // and scoped aliases. buildProviderOptions resolves its wire namespace
        // from the same captured config and returns provider SDK option types;
        // streamText accepts the same JSON-shaped values through its shared
        // providerOptions slot.
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        const providerOptions = buildProviderOptions(
          optionsModelString,
          effectiveReasoningLevel,
          undefined,
          undefined,
          optionsMuxProviderOptions,
          undefined,
          undefined,
          optionsProvidersConfig,
          optionsRouteProvider,
          undefined,
          runtime.reasoningMode
        ) as unknown as StreamTextProviderOptions;

        emitAdvisorPhase("waiting_for_response");

        let advisorStreamError: unknown;
        const streamedAdviceChunks: string[] = [];
        const result = streamText({
          model,
          system: ADVISOR_SYSTEM_PROMPT,
          messages,
          // The parent transcript snapshot can start with the cached
          // { role: "system" } message StreamManager prepends for Anthropic
          // caching; AI SDK 7 rejects it unless opted in. Trusted: mux builds
          // the transcript server-side.
          allowSystemInMessages: true,
          // Advisor requests are intentionally tool-less strategic consultations.
          tools: {},
          providerOptions,
          abortSignal: abortSignal ?? runtime.abortSignal,
          ...(runtime.maxOutputTokens != null ? { maxOutputTokens: runtime.maxOutputTokens } : {}),
          onError: ({ error }) => {
            advisorStreamError = error;
          },
          onChunk: ({ chunk }) => {
            const reasoningText = getAdvisorReasoningDelta(chunk);
            if (reasoningText != null) {
              emitAdvisorReasoningOutput(reasoningText);
              return;
            }

            const text = getAdvisorTextDelta(chunk);
            if (text == null) {
              return;
            }

            streamedAdviceChunks.push(text);
            emitAdvisorOutput(text);
          },
        });
        const finalAdvice = await result.text;
        const finishReason = await result.finishReason;
        if (advisorStreamError != null || finishReason === "error") {
          return {
            type: "error" as const,
            isError: true,
            message: `Advisor request failed: ${sanitizeErrorMessageForDisplay(
              getErrorMessage(advisorStreamError ?? new Error("Stream finished with an error."))
            )}`,
          };
        }

        const advice = finalAdvice.length > 0 ? finalAdvice : streamedAdviceChunks.join("");
        // Normalize AI SDK 7 usage to mux's persisted flat shape and re-inject
        // cache-write tokens (moved off providerMetadata in v7) for pricing.
        const rawUsage = await result.usage;
        const usage = normalizeUsage(rawUsage);
        const providerMetadata = withCacheWriteMetadata(
          (await result.providerMetadata) as Record<string, unknown> | undefined,
          rawUsage
        );

        emitAdvisorPhase("finalizing_result");

        if (config.reportModelUsage != null && usage != null) {
          try {
            assert(
              advisorModelString.length > 0,
              "advisorModelString must remain non-empty when reporting usage"
            );
            // Keep advisor costs under the advisor model bucket instead of folding them into
            // the parent chat stream's model totals.
            config.reportModelUsage({
              source: "tool",
              toolName: "advisor",
              model: advisorModelString,
              metadataModel,
              usage,
              providerMetadata,
              toolCallId,
              timestamp: Date.now(),
            });
          } catch (error) {
            log.debug("advisor: failed to report model usage", {
              error: getErrorMessage(error),
            });
          }
        }

        // An empty stream (for example a gateway hiccup) used to surface as a
        // success-shaped result, so the caller saw "advice" that said nothing.
        if (advice.trim().length === 0) {
          return {
            type: "error" as const,
            isError: true,
            message: `Advisor returned no advice (finish reason: ${finishReason}). Retry once or continue without it.`,
          };
        }

        return {
          type: "advice" as const,
          advice,
          advisorModel: advisorModelString,
          reasoningLevel,
          remainingUses,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return {
            type: "error" as const,
            isError: true,
            message: "Advisor request was aborted.",
          };
        }

        return {
          type: "error" as const,
          isError: true,
          message: `Advisor request failed: ${sanitizeErrorMessageForDisplay(getErrorMessage(error))}`,
        };
      }
    },
  });
}
