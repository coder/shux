/**
 * Message pipeline: transforms XumMessages into provider-ready ModelMessages.
 *
 * This module extracts the message preparation pipeline from `streamMessage()`,
 * making the sequential transform steps explicit and testable.
 *
 * The pipeline is purely functional — it has no service dependencies (`this.*`).
 * All contextual data is passed via the options object.
 */

import { convertToModelMessages, type AssistantModelMessage, type ModelMessage } from "ai";
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { sanitizeToolInputs } from "@/browser/utils/messages/sanitizeToolInput";
import { inlineSvgAsTextForProvider } from "@/node/utils/messages/inlineSvgAsTextForProvider";
import { neutralizeAgentEnvelopeLookalikesForProvider } from "@/node/utils/messages/neutralizeAgentEnvelopeLookalikesForProvider";
import { extractToolMediaAsUserMessages } from "@/node/utils/messages/extractToolMediaAsUserMessages";
import { sanitizeAnthropicPdfFilenames } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import { convertDataUriFilePartsForSdk } from "@/node/utils/messages/convertDataUriFilePartsForSdk";
import { attachReasoningReplayMetadata } from "@/node/utils/messages/reasoningProviderOptions";
import type { MuxMessage } from "@/common/types/message";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  injectAgentTransition,
  injectPostCompactionAttachments,
} from "@/browser/utils/messages/modelMessageTransform";
import { normalizeLegacyToolSearchMessages } from "@/common/utils/tools/toolCatalog";
import { applyCacheControl, type AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { log } from "./log";

/** Options for the full message preparation pipeline. */
export interface PrepareMessagesOptions {
  /** Pre-filtered messages (with interrupted-sentinel already added). */
  messagesWithSentinel: MuxMessage[];
  /** Active agent ID for transition injection. */
  effectiveAgentId: string;
  /** Tool names for mode-transition sentinel detection. */
  toolNamesForSentinel: string[];
  /** Plan content for plan→exec handoff injection. */
  planContentForTransition?: string;
  /** Plan file path for transition context. */
  planFilePath?: string;
  /** Post-compaction attachments (plan file, loaded skills, edited files). */
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /** Canonical provider name for provider-specific transforms. */
  providerForMessages: string;
  /** Thinking level for provider-specific behavior. */
  effectiveThinkingLevel: ThinkingLevel;
  /** Full model string (used for cache control). */
  modelString: string;
  /**
   * Providers config for cache-control eligibility: gateway-scoped Coder
   * strings (coder:<instance>/<model>) resolve their wire protocol from
   * instance metadata, so Anthropic cache markers apply to custom-named
   * Anthropic instances too.
   */
  providersConfig?: ProvidersConfigMap | null;
  /** Optional Anthropic cache TTL override for prompt caching. */
  anthropicCacheTtl?: AnthropicCacheTtl | null;
  /** Workspace ID (used only for debug logging). */
  workspaceId: string;
}

/**
 * Run the full message preparation pipeline.
 *
 * Transforms pre-filtered `XumMessage[]` into provider-ready `ModelMessage[]` by:
 * 1. Injecting agent-transition context (plan→exec handoff)
 * 2. Injecting post-compaction attachments
 * 3. Redacting heavy tool outputs
 * 4. Sanitizing tool inputs
 * 5. Inlining SVG attachments as text
 * 6. Neutralizing user-typed <mux_agent_message> lookalikes (peer-envelope provenance)
 * 7. Sanitizing PDF filenames for Anthropic
 * 8. Extracting tool-result media as user message attachments
 * 9. Rewriting data-URI file parts to SDK-safe inline base64
 * 10. Converting to Vercel AI SDK ModelMessage format
 * 11. Self-healing: filtering empty/whitespace assistant messages
 * 12. Applying provider-specific message transforms
 * 13. Applying cache control headers
 * 14. Validating Anthropic compliance (logs warnings only)
 *
 * Log purity: this pipeline never reads live workspace state (disk, file
 * trackers). File-change notifications and @file mention snapshots are
 * materialized into chat.jsonl by AgentSession before the request is built,
 * so replaying the same history always produces the same provider messages.
 * Old histories that predate send-time @mention materialization simply keep
 * their @mentions as plain text — they still build, just without file content.
 */
export async function prepareMessagesForProvider(
  opts: PrepareMessagesOptions
): Promise<ModelMessage[]> {
  const {
    messagesWithSentinel,
    effectiveAgentId,
    toolNamesForSentinel,
    planContentForTransition,
    planFilePath,
    postCompactionAttachments,
    providerForMessages,
    effectiveThinkingLevel,
    modelString,
    providersConfig,
    anthropicCacheTtl,
    workspaceId,
  } = opts;

  // --- XumMessage-level transforms ---

  // Inject agent transition context with plan content (for plan→exec handoff)
  const messagesWithAgentContext = injectAgentTransition(
    messagesWithSentinel,
    effectiveAgentId,
    toolNamesForSentinel,
    planContentForTransition,
    planContentForTransition ? planFilePath : undefined
  );

  // Inject post-compaction attachments (plan file, loaded skills, edited files) after compaction summary
  const messagesWithPostCompaction = injectPostCompactionAttachments(
    messagesWithAgentContext,
    postCompactionAttachments
  );

  // Apply centralized tool-output redaction BEFORE converting to provider ModelMessages.
  // Keeps the persisted/UI history intact while trimming heavy fields for the request.
  const redactedForProvider = applyToolOutputRedaction(messagesWithPostCompaction);
  log.debug_obj(`${workspaceId}/2a_redacted_messages.json`, redactedForProvider);

  // Sanitize tool inputs to ensure they are valid objects (not strings or arrays).
  // Fixes cases where corrupted data in history has malformed tool inputs
  // that would cause API errors like "Input should be a valid dictionary".
  const sanitizedMessages = sanitizeToolInputs(redactedForProvider);
  log.debug_obj(`${workspaceId}/2b_sanitized_messages.json`, sanitizedMessages);

  // Inline SVG user attachments as text (providers generally don't accept image/svg+xml).
  // Request-only — does not mutate persisted history.
  const messagesWithInlinedSvg = inlineSvgAsTextForProvider(sanitizedMessages);

  // Rewrite user-typed <mux_agent_message> lookalikes so only server-authored peer envelopes
  // reach the provider with the exact wrapper (pasted envelopes keep user authority).
  const messagesWithNeutralizedEnvelopes =
    neutralizeAgentEnvelopeLookalikesForProvider(messagesWithInlinedSvg);

  // Sanitize PDF filenames for Anthropic (request-only, preserves original in UI/history).
  // Anthropic rejects document names containing periods, underscores, etc.
  const messagesWithSanitizedPdf =
    providerForMessages === "anthropic"
      ? sanitizeAnthropicPdfFilenames(messagesWithNeutralizedEnvelopes)
      : messagesWithNeutralizedEnvelopes;

  // Rewrite supported tool-result attachments to small text placeholders + file parts.
  // Prevents providers from treating large base64 payloads as text/JSON context.
  const messagesWithToolMediaExtracted =
    await extractToolMediaAsUserMessages(messagesWithSanitizedPdf);

  // Rewrite user file-part data URIs to raw base64 payloads before SDK conversion.
  // convertToModelMessages maps FileUIPart.url -> FilePart.data; keeping data: URLs here
  // can trigger URL-download validation in downstream provider utilities.
  const messagesWithSdkSafeFileParts = convertDataUriFilePartsForSdk(
    messagesWithToolMediaExtracted
  );

  // Mirror persisted reasoning replay data (signatures, encrypted reasoning) into
  // providerMetadata, the only field convertToModelMessages forwards to the request.
  const messagesWithReasoningReplay = attachReasoningReplayMetadata(messagesWithSdkSafeFileParts);

  // --- Convert to ModelMessage format ---

  // Type assertion needed because XumMessage has custom tool parts for interrupted tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  const rawModelMessages = await convertToModelMessages(messagesWithReasoningReplay as any, {
    // Drop unfinished tool calls (input-streaming/input-available) so downstream
    // transforms only see tool calls that actually produced outputs.
    ignoreIncompleteToolCalls: true,
  });

  // --- ModelMessage-level transforms ---

  const modelMessages = normalizeLegacyToolSearchMessages(
    sanitizeAssistantModelMessages(rawModelMessages, workspaceId)
  );

  log.debug_obj(`${workspaceId}/2_model_messages.json`, modelMessages);

  // Apply ModelMessage transforms based on provider requirements
  const transformedMessages = transformModelMessages(modelMessages, providerForMessages, {
    anthropicThinkingEnabled:
      providerForMessages === "anthropic" && effectiveThinkingLevel !== "off",
  });

  // Apply cache control for Anthropic models AFTER transformation
  const finalMessages = applyCacheControl(
    transformedMessages,
    modelString,
    anthropicCacheTtl,
    providersConfig
  );

  log.debug_obj(`${workspaceId}/3_final_messages.json`, finalMessages);

  // Validate the messages meet Anthropic requirements (Anthropic only)
  if (providerForMessages === "anthropic") {
    const validation = validateAnthropicCompliance(finalMessages);
    if (!validation.valid) {
      log.error(`Anthropic compliance validation failed: ${validation.error ?? "unknown error"}`);
      // Continue anyway, as the API might be more lenient
    }
  }

  return finalMessages;
}

type AssistantContentArray = Exclude<AssistantModelMessage["content"], string>;
type AssistantContentPart = AssistantContentArray[number];

function isTextPart(
  part: AssistantContentPart
): part is Extract<AssistantContentPart, { type: "text" }> {
  return part.type === "text";
}

function normalizeAssistantContent(content: AssistantContentArray): AssistantContentArray {
  let changed = false;
  const coalesced: AssistantContentArray = [];

  for (const part of content) {
    const lastPart = coalesced.at(-1);
    if (isTextPart(part) && lastPart && isTextPart(lastPart)) {
      // Preserve provider-emitted whitespace separators before filtering whitespace-only
      // blocks; dropping a standalone "\n\n" delta can corrupt headings in future prompts.
      lastPart.text += part.text;
      changed = true;
      continue;
    }

    coalesced.push(isTextPart(part) ? { ...part } : part);
  }

  const filtered = coalesced.filter(
    (part): part is AssistantContentPart => !isTextPart(part) || part.text.trim().length > 0
  );

  return changed || filtered.length !== content.length ? filtered : content;
}

/**
 * Self-healing: filter empty or whitespace-only assistant model messages.
 *
 * The SDK's `ignoreIncompleteToolCalls` can drop all parts from a message,
 * leaving an assistant with an empty content array. The API rejects these with
 * "all messages must have non-empty content except for the optional final
 * assistant message".
 *
 * Anthropic also rejects text content blocks that contain only whitespace
 * (e.g. "\n\n"). This can happen after an interrupted stream where we
 * persisted a whitespace-only text delta (often the first text after thinking).
 *
 * Kept provider-agnostic and request-only (does not mutate persisted history).
 */
export function sanitizeAssistantModelMessages(
  messages: ModelMessage[],
  workspaceId?: string
): ModelMessage[] {
  const result = messages.flatMap<ModelMessage>((msg): ModelMessage[] => {
    if (msg.role !== "assistant") {
      return [msg];
    }

    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0 ? [msg] : [];
    }

    if (!Array.isArray(msg.content)) {
      return [];
    }

    const normalizedContent = normalizeAssistantContent(msg.content);

    if (normalizedContent.length === 0) {
      return [];
    }

    // Avoid mutating the original message (which can be reused in debug logging).
    if (normalizedContent === msg.content) {
      return [msg];
    }

    return [{ ...msg, content: normalizedContent }];
  });

  if (result.length < messages.length) {
    log.debug(
      `Self-healing: Filtered ${messages.length - result.length} empty ModelMessage(s)${workspaceId ? ` [${workspaceId}]` : ""}`
    );
  }

  return result;
}
