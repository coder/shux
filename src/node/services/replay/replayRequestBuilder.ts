/**
 * Replay builder: reconstructs the provider request (system prompt + messages
 * + LanguageModel-level prompt) for one assistant turn purely from durable
 * session logs — chat.jsonl rows plus a turn-envelope row and its blob-stored
 * system prompt. This is the enforcement half of "model-visible ⟹ logged":
 * if a request can be rebuilt byte-for-byte from the log, no request-time
 * injection of live state exists.
 *
 * The reconstruction reuses the production assemblePromptPayload entry point
 * and the real AI SDK streamText conversion (ModelMessage → LanguageModelV4
 * prompt), captured through a stub model that never performs network I/O,
 * with the same per-step message transforms StreamManager's prepareStep
 * applies.
 *
 * Guarantee scope: same log + same config + same binary. Request-time inputs
 * that chat.jsonl alone cannot provide (plan-transition content,
 * post-compaction attachments, the per-send Anthropic cache TTL, the resolved
 * wire provider name) are logged in the turn-envelope row and passed back in
 * here. Only turns whose envelope predates those fields (legacy rows) report
 * a divergence — surfacing them is the point of the auditor.
 */

import { streamText, type ModelMessage, type SystemModelMessage, type Tool } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { filterOrphanedMcpPromptSnapshots, type MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import { replaceOrAppendMessageById } from "@/node/services/aiService";
import { assemblePromptPayload } from "@/node/services/turnContextAssembler";
import { parseModelString } from "@/node/services/providerModelFactory";
import { extractToolMediaAsUserMessagesFromModelMessages } from "@/node/utils/messages/extractToolMediaAsUserMessagesFromModelMessages";
import { stripWorkflowRunRecordsFromModelMessages } from "@/node/utils/messages/stripWorkflowRunRecordsFromModelMessages";

/** Everything needed to rebuild one turn's provider request from logs. */
export interface ReplayRequestInputs {
  /**
   * chat.jsonl rows visible to this turn's request build (current compaction
   * epoch, already sliced to historySequence <= the turn's
   * requestHistorySequence by the caller).
   */
  historyMessages: MuxMessage[];
  /** Blob-resolved system prompt (turn-envelope systemPromptHash). */
  systemPrompt: string;
  /** From the turn-envelope row. */
  modelString: string;
  /** From the turn-envelope row. */
  thinkingLevel: ThinkingLevel;
  /** From the turn's assistant row metadata (agent transitions read it). */
  effectiveAgentId: string;
  /** Model-visible tool names — the turn-envelope manifest names. */
  toolNamesForSentinel: string[];
  /** From the turn's assistant row metadata (OpenAI cache eligibility). */
  routeProvider?: string;
  providersConfig?: ProvidersConfigMap | null;
  anthropicCacheTtl?: AnthropicCacheTtl | null;
  /**
   * Resolved wire provider name from the turn-envelope row. Falls back to
   * name-canonicalization of the model string when absent (legacy envelopes) —
   * Coder instance-typed gateway strings then report a divergence.
   */
  wireProviderName?: string;
  /** Plan→exec handoff content from the turn-envelope blob (model-visible). */
  planContentForTransition?: string;
  planFilePath?: string;
  /** Post-compaction attachments from the turn-envelope blob (model-visible). */
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /**
   * Refusal-fallback partial continuation from the turn-envelope blob. The
   * eventual assistant row lands after requestHistorySequence, so this
   * message exists only in the envelope; production appends it to the
   * fallback request via replaceOrAppendMessageById.
   */
  partialContinuation?: MuxMessage | null;
  workspaceId: string;
}

/** The rebuilt request at both comparison levels. */
export interface ReplayBuiltRequest {
  /** streamText `system` argument after production cache wrapping. */
  system: string | SystemModelMessage | undefined;
  /** Provider-ready ModelMessages (post prepareMessagesForProvider + cache system prepend). */
  messages: ModelMessage[];
  /**
   * The LanguageModelV4 `prompt` exactly as a provider call would receive it
   * — comparable byte-for-byte against devtools.jsonl step input.prompt.
   */
  lmPrompt: unknown;
}

/**
 * Wire-canonical provider name for message preparation, derived from the
 * model string alone. Matches providerModelFactory's resolution for direct
 * and name-canonicalizable gateway strings; Coder instance-typed gateways
 * need live instance metadata and are out of replay scope (documented
 * limitation — such turns report a divergence instead of silently passing).
 */
export function deriveWireProviderName(modelString: string): string {
  const [provider] = parseModelString(normalizeToCanonical(modelString));
  return provider;
}

/**
 * Run the real AI SDK streamText conversion (standardize + ModelMessage →
 * LanguageModelV4 prompt) against a capture-only stub model. No network I/O:
 * the stub's stream finishes immediately, and permissive supportedUrls keep
 * the SDK from downloading URL attachments (replay must stay pure — a request
 * whose bytes depended on a live download is not log-reconstructible anyway).
 */
export async function captureLanguageModelPrompt(params: {
  system: string | SystemModelMessage | undefined;
  messages: ModelMessage[];
  modelId: string;
  /** Optional: capture the wire tool definitions too (fixture generation). */
  tools?: Record<string, Tool>;
}): Promise<{ prompt: unknown; tools: unknown }> {
  let captured: LanguageModelV4CallOptions | undefined;

  const finishParts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
    },
  ];

  const captureModel: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "mux-replay",
    modelId: params.modelId,
    // Everything "supported" ⇒ the SDK passes URLs through instead of
    // downloading them at replay time.
    supportedUrls: { "*/*": [/.*/] },
    doGenerate: () => {
      // streamText never calls doGenerate; crash fast if that assumption breaks.
      throw new Error("replay capture model does not implement doGenerate");
    },
    doStream: (options) => {
      captured = options;
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of finishParts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      });
    },
  };

  const result = streamText({
    model: captureModel,
    messages: params.messages,
    ...(params.system !== undefined ? { system: params.system } : {}),
    // Mirrors StreamManager.createStreamResult: cached system messages live
    // inside `messages` and must be accepted there.
    allowSystemInMessages: true,
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    prepareStep: async ({ messages: stepMessages }) => {
      // Same per-step transforms as StreamManager.createStreamResult's
      // prepareStep — they run on step 0 too, so the recorded prompt
      // includes them.
      const withoutWorkflowRunRecords = stripWorkflowRunRecordsFromModelMessages(stepMessages);
      const rewritten =
        await extractToolMediaAsUserMessagesFromModelMessages(withoutWorkflowRunRecords);
      return rewritten === stepMessages ? undefined : { messages: rewritten };
    },
  });
  await result.consumeStream();

  assert(captured !== undefined, "capture model doStream was never invoked");
  return { prompt: captured.prompt, tools: captured.tools };
}

/**
 * Rebuild one turn's provider request from durable log rows, reusing the
 * production request pipeline end-to-end.
 */
export async function buildReplayRequest(inputs: ReplayRequestInputs): Promise<ReplayBuiltRequest> {
  assert(inputs.systemPrompt.length > 0, "replay requires the envelope's system prompt blob");
  const wireProviderName = inputs.wireProviderName ?? deriveWireProviderName(inputs.modelString);

  // AgentSession.streamWithHistory → AIService.streamMessage, in order.
  const filteredMessages = filterOrphanedMcpPromptSnapshots(inputs.historyMessages);
  // Refusal fallback: production builds the fallback request from history plus
  // the refused attempt's partial continuation (same helper, same order).
  const requestMessages =
    inputs.partialContinuation != null
      ? replaceOrAppendMessageById(filteredMessages, inputs.partialContinuation)
      : filteredMessages;
  const payload = await assemblePromptPayload({
    history: requestMessages,
    systemMessage: inputs.systemPrompt,
    modelString: inputs.modelString,
    routeProvider: inputs.routeProvider,
    providerForMessages: wireProviderName,
    effectiveThinkingLevel: inputs.thinkingLevel,
    effectiveAgentId: inputs.effectiveAgentId,
    toolNamesForSentinel: inputs.toolNamesForSentinel,
    planContentForTransition: inputs.planContentForTransition,
    planFilePath: inputs.planFilePath,
    postCompactionAttachments: inputs.postCompactionAttachments,
    providersConfig: inputs.providersConfig,
    anthropicCacheTtl: inputs.anthropicCacheTtl,
    workspaceId: inputs.workspaceId,
  });

  const { prompt } = await captureLanguageModelPrompt({
    system: payload.system,
    messages: payload.messages,
    modelId: inputs.modelString,
  });

  return { system: payload.system, messages: payload.messages, lmPrompt: prompt };
}
