/**
 * Transform ModelMessages to ensure Anthropic API compliance.
 * This operates on already-converted ModelMessages from Vercel AI SDK.
 */

import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";
import type { MuxMessage } from "@/common/types/message";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { MAX_POST_COMPACTION_INJECTION_CHARS } from "@/common/constants/attachments";
import { hasProviderReplayableContent } from "@/common/utils/messages/providerEligibility";
import { findLatestCompactionBoundaryIndex } from "@/common/utils/messages/compactionBoundary";
import { renderAttachmentsToContentWithBudget } from "./attachmentRenderer";

/**
 * Filter out assistant messages that are empty or only contain reasoning parts.
 * Empty messages (no parts or only empty text) and reasoning-only messages are
 * invalid for the API and provide no value to the model.
 *
 * Common scenarios:
 * 1. Placeholder messages with empty parts arrays (stream interrupted before any content)
 * 2. Messages interrupted during thinking phase before producing text
 *
 * EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages.
 * The Extended Thinking API requires thinking blocks to be present in message history,
 * even if they were interrupted before producing text content.
 *
 * Note: This function filters out reasoning-only messages but does NOT strip reasoning
 * parts from messages that have other content. Reasoning parts are handled differently
 * per provider (see stripReasoningForOpenAI).
 *
 * @param messages - The messages to filter
 * @param preserveReasoningOnly - If true, keep reasoning-only messages (for Extended Thinking)
 */
export function filterEmptyAssistantMessages(
  messages: MuxMessage[],
  preserveReasoningOnly = false
): MuxMessage[] {
  return messages.filter((msg) => {
    // Keep all non-assistant messages
    if (msg.role !== "assistant") {
      return true;
    }

    return hasProviderReplayableContent(msg, { preserveReasoningOnly });
  });
}

/**
 * Add [CONTINUE] sentinel to partial messages by inserting a user message.
 * This helps the model understand that a message was interrupted and to continue.
 * The sentinel is ONLY for model context, not shown in UI.
 *
 * OPTIMIZATION: If a user message already follows the partial assistant message,
 * we skip the sentinel - the user message itself provides the continuation signal.
 * This saves tokens and creates more natural conversation flow.
 *
 * We insert a separate user message instead of modifying the assistant message
 * because if the assistant message only has reasoning (no text), it will be
 * filtered out, and we'd lose the interruption context. A user message always
 * survives filtering.
 */
export function addInterruptedSentinel(messages: MuxMessage[]): MuxMessage[] {
  const result: MuxMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    // If this is a partial assistant message, conditionally insert [CONTINUE] sentinel
    if (msg.role === "assistant" && msg.metadata?.partial) {
      const nextMsg = messages[i + 1];

      // Only add sentinel if there's NO user message following
      // If user message follows, it provides the continuation context itself
      if (!nextMsg || nextMsg.role !== "user") {
        result.push({
          id: `interrupted-${msg.id}`,
          role: "user",
          parts: [{ type: "text", text: "[CONTINUE]" }],
          metadata: {
            timestamp: msg.metadata.timestamp,
            // Mark as synthetic so it can be identified if needed
            synthetic: true,
          },
        });
      }
    }
  }

  return result;
}

/**
 * Inject agent transition context when the active agent changes mid-conversation.
 * Inserts a synthetic user message before the final user message to signal the agent switch.
 * This provides temporal context that helps models understand they should follow new agent instructions.
 *
 * When transitioning from plan → exec with plan content, includes the plan so the model
 * can evaluate its relevance to the current request.
 *
 * @param messages The conversation history
 * @param currentAgentId The agent id for the upcoming assistant response
 * @param toolNames Optional list of available tool names to include in transition message
 * @param planContent Optional plan content to include when transitioning plan → exec
 * @param planFilePath Optional plan file path to include when transitioning plan → exec
 * @returns Messages with agent transition context injected if needed
 */
export function injectAgentTransition(
  messages: MuxMessage[],
  currentAgentId?: string,
  toolNames?: string[],
  planContent?: string,
  planFilePath?: string
): MuxMessage[] {
  // No agent specified, nothing to do
  if (!currentAgentId) {
    return messages;
  }

  // Need at least one message to have a conversation
  if (messages.length === 0) {
    return messages;
  }

  // Find the last assistant message to check its agent
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const lastAgentId = lastAssistantMessage?.metadata?.agentId;

  // No agent transition if no previous agent or same agent
  if (!lastAgentId || lastAgentId === currentAgentId) {
    return messages;
  }

  // Agent transition detected! Inject a synthetic user message before the last user message
  // This provides temporal context: user says "switch agents" before their actual request

  // Find the index of the last user message
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // If there's no user message, can't inject transition (nothing to inject before)
  if (lastUserIndex === -1) {
    return messages;
  }

  const result: MuxMessage[] = [];

  // Add all messages up to (but not including) the last user message
  for (let i = 0; i < lastUserIndex; i++) {
    result.push(messages[i]);
  }

  // Inject agent transition message right before the last user message
  let transitionText = `[Agent switched from ${lastAgentId} to ${currentAgentId}. Follow ${currentAgentId} agent instructions.`;

  // Append tool availability if provided
  if (toolNames && toolNames.length > 0) {
    transitionText += ` Available tools: ${toolNames.join(", ")}.]`;
  } else {
    transitionText += "]";
  }

  // When transitioning from the plan agent to exec, include the plan for context.
  // This avoids wasting tokens on tool calls just to re-read the plan file.
  const transitioningFromPlan = lastAgentId === "plan";
  const transitioningToExec = currentAgentId === "exec";
  if (planContent && transitioningFromPlan && transitioningToExec) {
    const planFilePathText = planFilePath ? `Plan file path: ${planFilePath}\n\n` : "";
    transitionText += `

${planFilePathText}The following plan was developed in the plan agent. Based on the user's message, determine if they have accepted the plan. If accepted and relevant, implement it directly (do not re-plan).
Only do extra exploration or spawn sub-agents if the plan is missing critical details or conflicts with the repo:

<plan>
${planContent}
</plan>`;
  }

  const transitionMessage: MuxMessage = {
    id: `agent-transition-${Date.now()}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: transitionText,
      },
    ],
    metadata: {
      timestamp: Date.now(),
      synthetic: true,
    },
  };
  result.push(transitionMessage);

  // Add the last user message and any remaining messages
  for (let i = lastUserIndex; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

// NOTE: File-change notifications are no longer injected at request time.
// AgentSession appends the <system-file-update> row durably to chat.jsonl at
// turn start (see createFileChangeNotificationMessage in fileChangeTracker.ts),
// keeping the provider request a pure function of the session log.

function findLatestLegacyCompactionSummaryIndex(messages: MuxMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }

    const compacted = message.metadata?.compacted;
    if (compacted === undefined || compacted === false) {
      continue;
    }

    return i;
  }

  return -1;
}

/**
 * Inject post-compaction attachments as a synthetic user message.
 * When compaction occurs, this injects a message containing plan file content
 * and/or edited files to preserve context that would otherwise be lost.
 *
 * The message is inserted AFTER the compaction summary message to ensure
 * the model receives this context for the next turn.
 *
 * @param messages The conversation history
 * @param attachments Post-compaction attachments (plan file, loaded skills, edited files)
 * @returns Messages with attachments injected after compaction summary
 */
export function injectPostCompactionAttachments(
  messages: MuxMessage[],
  attachments?: PostCompactionAttachment[] | null
): MuxMessage[] {
  if (!attachments || attachments.length === 0) {
    return messages;
  }

  const durableCompactionIndex = findLatestCompactionBoundaryIndex(messages);
  // Durable boundaries are authoritative for current histories. Legacy histories
  // only have metadata.compacted, so fall back to that marker when needed.
  const compactionIndex =
    durableCompactionIndex !== -1
      ? durableCompactionIndex
      : findLatestLegacyCompactionSummaryIndex(messages);

  if (compactionIndex === -1) {
    // No compaction message found - this shouldn't happen if attachments are provided,
    // but append at end as a fallback
    const syntheticMessage: MuxMessage = {
      id: `post-compaction-${Date.now()}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: renderAttachmentsToContentWithBudget(attachments, {
            maxChars: MAX_POST_COMPACTION_INJECTION_CHARS,
          }),
        },
      ],
      metadata: {
        timestamp: Date.now(),
        synthetic: true,
      },
    };
    return [...messages, syntheticMessage];
  }

  // Insert the synthetic message immediately after the compaction summary
  const syntheticMessage: MuxMessage = {
    id: `post-compaction-${Date.now()}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: renderAttachmentsToContentWithBudget(attachments, {
          maxChars: MAX_POST_COMPACTION_INJECTION_CHARS,
        }),
      },
    ],
    metadata: {
      timestamp: messages[compactionIndex].metadata?.timestamp ?? Date.now(),
      synthetic: true,
    },
  };

  const result = [...messages];
  result.splice(compactionIndex + 1, 0, syntheticMessage);
  return result;
}

/**
 * Filter out assistant messages that only contain reasoning parts (no text or tool parts).
 * Anthropic API rejects messages that have reasoning but no actual content.
 * This happens when a message is interrupted during thinking before producing any text.
 */
/**
 * Split assistant messages with mixed text and tool calls into separate messages
 * to comply with Anthropic's requirement that tool_use blocks must be immediately
 * followed by their tool_result blocks without intervening text.
 */
function splitMixedContentMessages(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg;

    if (typeof assistantMsg.content === "string") {
      result.push(msg);
      continue;
    }

    const toolCallParts = assistantMsg.content.filter((c) => c.type === "tool-call");

    if (toolCallParts.length === 0) {
      result.push(msg);
      continue;
    }

    const nextMsg = messages[i + 1];
    const hasToolResults = nextMsg?.role === "tool";

    if (!hasToolResults) {
      result.push(msg);
      continue;
    }

    const toolMsg = nextMsg;

    type ContentArray = Exclude<typeof assistantMsg.content, string>;
    const groups: Array<{ type: "text" | "tool-call"; parts: ContentArray }> = [];
    let currentGroup: { type: "text" | "tool-call"; parts: ContentArray } | null = null;

    for (const part of assistantMsg.content) {
      const partType = part.type === "tool-call" ? "tool-call" : "text";

      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (!currentGroup || currentGroup.type !== partType) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { type: partType, parts: [] };
      }

      currentGroup.parts.push(part);
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    if (groups.length <= 1) {
      result.push(msg);
      continue;
    }

    const toolResultsById = new Map<string, Array<ToolModelMessage["content"][number]>>();
    for (const content of toolMsg.content) {
      if (content.type === "tool-result") {
        const existing = toolResultsById.get(content.toolCallId);
        if (existing) {
          existing.push(content);
        } else {
          toolResultsById.set(content.toolCallId, [content]);
        }
      }
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group.parts.length === 0) {
        continue;
      }

      // If text is immediately followed by tool calls, keep them together.
      // Text before tool_use is allowed by Anthropic; only *text after tool_use* is invalid.
      if (group.type === "text") {
        const nextGroup = groups[groupIndex + 1];
        if (nextGroup?.type === "tool-call" && nextGroup.parts.length > 0) {
          const toolPartsToInclude = nextGroup.parts.filter(
            (p) => p.type === "tool-call" && toolResultsById.has(p.toolCallId)
          );

          // If none of the tool calls have results, keep just the text portion.
          if (toolPartsToInclude.length === 0) {
            result.push({ role: "assistant", content: group.parts });
            groupIndex++;
            continue;
          }

          const newAssistantMsg: AssistantModelMessage = {
            role: "assistant",
            content: [...group.parts, ...toolPartsToInclude],
          };
          result.push(newAssistantMsg);

          const relevantResults: ToolModelMessage["content"] = [];
          for (const part of toolPartsToInclude) {
            if (part.type !== "tool-call") {
              continue;
            }
            const results = toolResultsById.get(part.toolCallId);
            if (results) {
              relevantResults.push(...results);
              toolResultsById.delete(part.toolCallId);
            }
          }

          if (relevantResults.length > 0) {
            const newToolMsg: ToolModelMessage = {
              role: "tool",
              content: relevantResults,
            };
            result.push(newToolMsg);
          }

          groupIndex++;
          continue;
        }

        result.push({ role: "assistant", content: group.parts });
        continue;
      }

      const partsToInclude = group.parts.filter(
        (p) => p.type === "tool-call" && toolResultsById.has(p.toolCallId)
      );

      if (partsToInclude.length === 0) {
        continue;
      }

      const newAssistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: partsToInclude,
      };
      result.push(newAssistantMsg);

      const relevantResults: ToolModelMessage["content"] = [];
      for (const part of partsToInclude) {
        if (part.type !== "tool-call") {
          continue;
        }
        const results = toolResultsById.get(part.toolCallId);
        if (results) {
          relevantResults.push(...results);
          toolResultsById.delete(part.toolCallId);
        }
      }

      if (relevantResults.length > 0) {
        const newToolMsg: ToolModelMessage = {
          role: "tool",
          content: relevantResults,
        };
        result.push(newToolMsg);
      }
    }

    i++;
  }

  return result;
}

function filterReasoningOnlyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") {
      return true;
    }

    // Check if content is string or array
    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0;
    }

    // For array content, check if there's at least one non-reasoning part
    const hasNonReasoningContent = msg.content.some((part) => part.type !== "reasoning");

    return hasNonReasoningContent;
  });
}

/**
 * Remove tool-call/tool-result parts that do not have a matching counterpart.
 *
 * Some providers (e.g., OpenAI responses) reject requests when a tool call is
 * present without its tool output. If history is interrupted or corrupted, we
 * can end up with orphaned tool-call/tool-result parts. Drop them to keep the
 * request valid and self-healing.
 */
export function stripOrphanedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMsg = msg;
      if (typeof assistantMsg.content === "string") {
        continue;
      }
      for (const part of assistantMsg.content) {
        if (part.type === "tool-call") {
          toolCallIds.add(part.toolCallId);
        }
        if (part.type === "tool-result") {
          toolResultIds.add(part.toolCallId);
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          toolResultIds.add(part.toolCallId);
        }
      }
    }
  }

  const missingResults = new Set(
    [...toolCallIds].filter((toolCallId) => !toolResultIds.has(toolCallId))
  );
  const orphanResults = new Set(
    [...toolResultIds].filter((toolCallId) => !toolCallIds.has(toolCallId))
  );

  if (missingResults.size === 0 && orphanResults.size === 0) {
    return messages;
  }

  const cleaned: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMsg = msg;
      if (typeof assistantMsg.content === "string") {
        cleaned.push(msg);
        continue;
      }

      const filteredContent = assistantMsg.content.filter((part) => {
        if (part.type === "tool-call") {
          return !missingResults.has(part.toolCallId);
        }
        if (part.type === "tool-result") {
          return !orphanResults.has(part.toolCallId);
        }
        return true;
      });

      if (filteredContent.length === 0) {
        continue;
      }

      if (filteredContent.length === assistantMsg.content.length) {
        cleaned.push(msg);
      } else {
        cleaned.push({
          ...assistantMsg,
          content: filteredContent,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg;
      const filteredContent = toolMsg.content.filter((part) => {
        if (part.type !== "tool-result") {
          return true;
        }
        return !orphanResults.has(part.toolCallId);
      });

      if (filteredContent.length === 0) {
        continue;
      }

      if (filteredContent.length === toolMsg.content.length) {
        cleaned.push(msg);
      } else {
        cleaned.push({
          ...toolMsg,
          content: filteredContent,
        });
      }
      continue;
    }

    cleaned.push(msg);
  }

  return cleaned;
}

/**
 * Coalesce consecutive no-progress `task_await` tool-call/tool-result message pairs.
 *
 * `task_await` is commonly polled in a loop while waiting on sub-agent tasks.
 * When there's no new output, those polls add near-duplicate tool messages to
 * provider context, increasing tokens without adding information.
 *
 * This pass removes consecutive *identical* no-progress pairs (same tool input
 * fingerprint), keeping only the last pair in each run.
 *
 * IMPORTANT: To preserve Anthropic tool_use/tool_result adjacency rules, we only
 * remove messages in (assistant + immediately following tool) pairs.
 *
 * Self-healing: If we see anything unexpected (shape mismatch, unstringifiable
 * inputs, unparseable outputs), we leave messages unchanged.
 */
function coalesceConsecutiveNoProgressTaskAwaitPairs(messages: ModelMessage[]): ModelMessage[] {
  function tryJsonStringify(value: unknown): string | undefined {
    try {
      const result = JSON.stringify(value);
      if (typeof result !== "string") {
        return undefined;
      }
      return result;
    } catch {
      return undefined;
    }
  }

  function getToolCallInputFingerprint(
    part: { input?: unknown } | { args?: unknown }
  ): string | undefined {
    const input = (part as { input?: unknown }).input ?? (part as { args?: unknown }).args;
    return tryJsonStringify(input);
  }

  function extractToolResultValue(part: { output?: unknown } | { result?: unknown }): unknown {
    const raw = (part as { result?: unknown }).result ?? (part as { output?: unknown }).output;

    // The AI SDK wraps tool results as `{ type: 'json' | 'text', value: unknown }`.
    if (raw && typeof raw === "object" && "type" in raw && "value" in raw) {
      return (raw as { value?: unknown }).value;
    }

    return raw;
  }

  function isNoProgressTaskAwaitResultValue(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      return false;
    }

    const results = (value as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      return false;
    }

    for (const entry of results) {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const status = (entry as { status?: unknown }).status;
      if (
        status !== "queued" &&
        status !== "starting" &&
        status !== "running" &&
        status !== "awaiting_report"
      ) {
        return false;
      }

      // Treat any non-empty output/report as progress.
      const output = (entry as { output?: unknown }).output;
      if (output !== undefined) {
        if (typeof output !== "string") {
          return false;
        }
        if (output.length > 0) {
          return false;
        }
      }

      const reportMarkdown = (entry as { reportMarkdown?: unknown }).reportMarkdown;
      if (typeof reportMarkdown === "string" && reportMarkdown.length > 0) {
        return false;
      }
    }

    return true;
  }

  function getTaskAwaitPairInfo(
    allMessages: ModelMessage[],
    index: number
  ):
    | {
        fingerprint: string;
        noProgress: boolean;
      }
    | undefined {
    const assistantMsg = allMessages[index];
    const toolMsg = allMessages[index + 1];

    if (!assistantMsg || !toolMsg) {
      return undefined;
    }

    if (assistantMsg.role !== "assistant" || toolMsg.role !== "tool") {
      return undefined;
    }

    const assistant = assistantMsg;
    if (typeof assistant.content === "string") {
      return undefined;
    }

    if (assistant.content.length !== 1) {
      return undefined;
    }

    const toolCallPart = assistant.content[0];
    if (toolCallPart?.type !== "tool-call") {
      return undefined;
    }

    if (toolCallPart.toolName !== "task_await") {
      return undefined;
    }

    const fingerprint = getToolCallInputFingerprint(toolCallPart);
    if (!fingerprint) {
      return undefined;
    }

    if (!Array.isArray(toolMsg.content) || toolMsg.content.length !== 1) {
      return undefined;
    }

    const toolResultPart = toolMsg.content[0];
    if (toolResultPart?.type !== "tool-result") {
      return undefined;
    }

    if (toolResultPart.toolName !== "task_await") {
      return undefined;
    }

    // Only coalesce when the tool-result matches the immediately preceding tool-call.
    if (toolResultPart.toolCallId !== toolCallPart.toolCallId) {
      return undefined;
    }

    const toolResultValue = extractToolResultValue(toolResultPart);

    return {
      fingerprint,
      noProgress: isNoProgressTaskAwaitResultValue(toolResultValue),
    };
  }

  try {
    let changed = false;
    const result: ModelMessage[] = [];

    for (let i = 0; i < messages.length; ) {
      const info = getTaskAwaitPairInfo(messages, i);
      if (!info) {
        result.push(messages[i]);
        i++;
        continue;
      }

      // Not a no-progress poll, keep it.
      if (!info.noProgress) {
        result.push(messages[i], messages[i + 1]);
        i += 2;
        continue;
      }

      // Scan ahead for a run of consecutive identical no-progress polls.
      let runEnd = i;
      for (let j = i + 2; j < messages.length; j += 2) {
        const nextInfo = getTaskAwaitPairInfo(messages, j);
        if (!nextInfo) {
          break;
        }
        if (!nextInfo.noProgress) {
          break;
        }
        if (nextInfo.fingerprint !== info.fingerprint) {
          break;
        }
        runEnd = j;
      }

      if (runEnd !== i) {
        changed = true;
      }

      result.push(messages[runEnd], messages[runEnd + 1]);
      i = runEnd + 2;
    }

    return changed ? result : messages;
  } catch {
    // Self-healing: request-time transforms should never brick a workspace.
    return messages;
  }
}
/**
 * Strip Anthropic reasoning parts that lack a valid signature.
 *
 * Anthropic's Extended Thinking API requires thinking blocks to include a signature
 * for replay. The Vercel AI SDK's Anthropic provider only sends reasoning parts to
 * the API if they have providerOptions.anthropic.signature. Reasoning parts we create
 * (placeholders) or from history (where we didn't capture the signature) will be
 * silently dropped by the SDK.
 *
 * If all parts of an assistant message are unsigned reasoning, the SDK drops them all,
 * leaving an empty message that Anthropic rejects with:
 * "all messages must have non-empty content except for the optional final assistant message"
 *
 * This function removes unsigned reasoning upfront and filters resulting empty messages.
 *
 * NOTE: This is Anthropic-specific. Other providers (e.g., OpenAI) handle reasoning
 * differently and don't require signatures.
 */
function stripUnsignedAnthropicReasoning(messages: ModelMessage[]): ModelMessage[] {
  const stripped = messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }

    const assistantMsg = msg;
    if (typeof assistantMsg.content === "string") {
      return msg;
    }

    // Filter out reasoning parts without anthropic.signature in providerOptions
    const content = assistantMsg.content.filter((part) => {
      if (part.type !== "reasoning") {
        return true;
      }
      // Check for anthropic.signature in providerOptions
      const anthropicMeta = (part.providerOptions as { anthropic?: { signature?: string } })
        ?.anthropic;
      return anthropicMeta?.signature != null;
    });

    const result: typeof assistantMsg = { ...assistantMsg, content };
    return result;
  });

  // Filter out messages that became empty after stripping reasoning.
  //
  // Important: Anthropic rejects whitespace-only text content blocks (e.g. "\n\n").
  // If we strip unsigned reasoning from an interrupted message, we can be left with
  // only whitespace text, which would otherwise survive a simple `content.length > 0` check.
  return stripped.filter((msg) => {
    if (msg.role !== "assistant") {
      return true;
    }

    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0;
    }

    return msg.content.some((part) => part.type !== "text" || part.text.trim().length > 0);
  });
}

/**
 * Coalesce consecutive parts of the same type within each message.
 * Streaming creates many individual text/reasoning parts; merge them for easier debugging.
 * Also reduces JSON overhead when sending messages to the API.
 * Tool calls remain atomic (not merged).
 */
function coalesceConsecutiveParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    // Only process assistant messages with array content
    if (msg.role !== "assistant") {
      return msg;
    }

    const assistantMsg = msg;

    // Skip string content
    if (typeof assistantMsg.content === "string") {
      return msg;
    }

    // Now TypeScript knows content is an array
    type ContentArray = Exclude<typeof assistantMsg.content, string>;
    const coalesced: ContentArray = [];

    for (const part of assistantMsg.content) {
      const lastPart = coalesced[coalesced.length - 1];

      // Merge consecutive text parts
      if (part.type === "text" && lastPart?.type === "text") {
        lastPart.text += part.text;
        continue;
      }

      // Merge consecutive reasoning parts (extended thinking)
      if (part.type === "reasoning" && lastPart?.type === "reasoning") {
        lastPart.text += part.text;
        // Streaming splits one reasoning block across many parts and replay
        // metadata can land on any of them: Anthropic signatures arrive on the
        // LAST part of a run, while OpenAI/xAI itemId/encrypted content attach
        // to the FIRST (and itemId may repeat on later deltas). Merge per
        // provider namespace so a later partial object cannot clobber fields
        // accumulated earlier (e.g. reasoningEncryptedContent under ZDR).
        if (part.providerOptions) {
          const existing = lastPart.providerOptions ?? {};
          const merged: NonNullable<typeof lastPart.providerOptions> = { ...existing };
          for (const [provider, fields] of Object.entries(part.providerOptions)) {
            merged[provider] = { ...existing[provider], ...fields };
          }
          lastPart.providerOptions = merged;
        }
        // The legacy top-level `signature` field predates providerOptions and
        // survives here only for defensiveness (conversion strips it upstream).
        const partWithSig = part as typeof part & { signature?: string };
        const lastWithSig = lastPart as typeof lastPart & { signature?: string };
        if (partWithSig.signature) {
          lastWithSig.signature = partWithSig.signature;
        }
        continue;
      }

      // Keep tool calls and first occurrence of each type
      coalesced.push(part);
    }

    return {
      ...assistantMsg,
      content: coalesced,
    };
  });
}
/**
 * Merge consecutive user messages with newline separators.
 * When filtering removes assistant messages, we can end up with consecutive user messages.
 * Anthropic requires alternating user/assistant, so we merge them.
 */
function mergeConsecutiveUserMessages(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && merged.length > 0 && merged[merged.length - 1].role === "user") {
      // Consecutive user message - merge with previous
      const prevMsg = merged[merged.length - 1];

      // Get text content from both messages
      const prevText = Array.isArray(prevMsg.content)
        ? (prevMsg.content.find((c) => c.type === "text")?.text ?? "")
        : prevMsg.content;

      const currentText = Array.isArray(msg.content)
        ? (msg.content.find((c) => c.type === "text")?.text ?? "")
        : typeof msg.content === "string"
          ? msg.content
          : "";

      // Merge with newline prefix
      const mergedText = prevText + "\n" + currentText;

      // Collect file/image parts from both messages
      const prevImageParts = Array.isArray(prevMsg.content)
        ? prevMsg.content.filter((c) => c.type === "file")
        : [];
      const currentImageParts = Array.isArray(msg.content)
        ? msg.content.filter((c) => c.type === "file")
        : [];

      // Update the previous message with merged text and all image parts
      merged[merged.length - 1] = {
        role: "user",
        content: [
          { type: "text" as const, text: mergedText },
          ...prevImageParts,
          ...currentImageParts,
        ],
      };
    } else {
      // Not consecutive user message, add as-is
      merged.push(msg);
    }
  }

  return merged;
}

type AssistantContentArray = Exclude<AssistantModelMessage["content"], string>;

/** True when the content is plain text: a string, or an array of only text parts. */
function isTextOnlyAssistantContent(content: AssistantModelMessage["content"]): boolean {
  if (typeof content === "string") return true;
  return content.every((part) => part.type === "text");
}

/**
 * Merge a text-only assistant message into a directly preceding assistant
 * message. Synthetic assistant rows (branch summaries; potentially other
 * generated notices) can land right after a streamed assistant turn, and
 * Anthropic requires alternating user/assistant roles. Deliberately narrow:
 * the INCOMING message must be text-only, and the previous message must not
 * end in tool calls (their tool-result adjacency must stay intact — a
 * tool-call assistant message is followed by a tool message, so those pairs
 * never reach this merge anyway). Reasoning parts already in the previous
 * message are preserved ahead of the appended text.
 */
function mergeConsecutiveAssistantTextMessages(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];

  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (
      msg.role === "assistant" &&
      prev?.role === "assistant" &&
      isTextOnlyAssistantContent(msg.content) &&
      (typeof prev.content === "string" || !prev.content.some((part) => part.type === "tool-call"))
    ) {
      // Preserve the original text parts verbatim instead of re-joining them
      // into one string: rebuilding parts as plain {type,text} would discard
      // part-level providerOptions (e.g. cacheControl) carried by the folded
      // row. Only the message envelope of the merged-away row is dropped.
      // Empty and whitespace-only text parts are filtered from BOTH sides —
      // the previous row can itself carry one (extended thinking preserves
      // signed-reasoning rows whose text part is empty, and an interrupted
      // stream can persist a whitespace-only delta) and Anthropic rejects
      // text blocks without non-whitespace content; non-text parts
      // (reasoning) pass through with their providerOptions.
      const dropEmptyText = <T extends { type: string; text?: unknown }>(part: T) =>
        part.type !== "text" || (typeof part.text === "string" && part.text.trim().length > 0);
      const currentParts: AssistantContentArray =
        typeof msg.content === "string"
          ? msg.content.trim().length > 0
            ? [{ type: "text", text: msg.content }]
            : []
          : msg.content.filter(dropEmptyText);
      const prevParts: AssistantContentArray =
        typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
      const prevContent: AssistantContentArray = prevParts.filter(dropEmptyText);
      merged[merged.length - 1] = { ...prev, content: [...prevContent, ...currentParts] };
      continue;
    }
    merged.push(msg);
  }

  return merged;
}

function ensureAnthropicThinkingBeforeToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg;
    if (typeof assistantMsg.content === "string") {
      result.push(msg);
      continue;
    }

    const content = assistantMsg.content;
    const hasToolCall = content.some((part) => part.type === "tool-call");
    if (!hasToolCall) {
      result.push(msg);
      continue;
    }

    let reasoningParts = content.filter((part) => part.type === "reasoning");
    const nonReasoningParts = content.filter((part) => part.type !== "reasoning");

    // If no reasoning is present, try to merge it from the immediately preceding assistant message
    // if that message consists of reasoning-only parts. This commonly happens after splitting.
    if (reasoningParts.length === 0 && result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.role === "assistant") {
        const prevAssistant = prev;
        if (typeof prevAssistant.content !== "string") {
          const prevIsReasoningOnly =
            prevAssistant.content.length > 0 &&
            prevAssistant.content.every((part) => part.type === "reasoning");
          if (prevIsReasoningOnly) {
            result.pop();
            reasoningParts = prevAssistant.content.filter((part) => part.type === "reasoning");
          }
        }
      }
    }

    // Anthropic extended thinking requires tool-use assistant messages to start with a thinking block.
    // If we still have no reasoning available, insert a minimal placeholder reasoning part.
    // NOTE: The text cannot be empty - Anthropic API rejects empty content.
    if (reasoningParts.length === 0) {
      reasoningParts = [{ type: "reasoning" as const, text: "..." }];
    }

    result.push({
      ...assistantMsg,
      content: [...reasoningParts, ...nonReasoningParts],
    });
  }

  // Anthropic extended thinking also requires the *final* assistant message in the request
  // to start with a thinking block. If the last assistant message is text-only (common for
  // synthetic messages like sub-agent reports), insert an empty reasoning part as a minimal
  // placeholder. This transformation affects only the provider request, not stored history/UI.
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "assistant") {
      continue;
    }

    const assistantMsg = msg;

    if (typeof assistantMsg.content === "string") {
      // String-only assistant messages need converting to part arrays to insert reasoning.
      const text = assistantMsg.content;
      // If it's truly empty, leave it unchanged (it will be filtered elsewhere).
      if (text.length === 0) break;
      result[i] = {
        ...assistantMsg,
        content: [
          { type: "reasoning" as const, text: "..." },
          { type: "text" as const, text },
        ],
      };
      break;
    }

    const content = assistantMsg.content;
    if (content.length === 0) {
      break;
    }
    if (content[0].type === "reasoning") {
      break;
    }

    result[i] = {
      ...assistantMsg,
      content: [{ type: "reasoning" as const, text: "..." }, ...content],
    };
    break;
  }

  return result;
}

/**
 * Transform messages to ensure provider API compliance.
 * Applies multiple transformation passes based on provider requirements:
 * 0. Coalesce consecutive parts (text/reasoning) - all providers, reduces JSON overhead
 * 1. Split mixed content messages (text + tool calls) - all providers
 * 2. Drop orphaned tool calls/results (self-healing)
 * 3. Coalesce consecutive no-progress `task_await` polls - all providers
 * 4. Filter reasoning-only messages:
 *    - OpenAI: Keep reasoning parts in explicit history, filter reasoning-only messages
 *    - Anthropic: Filter out reasoning-only messages (API rejects them)
 * 5. Merge consecutive user messages - all providers
 *
 * Note: encryptedContent stripping happens earlier in streamManager when tool results
 * are first stored, not during message transformation.
 *
 * @param messages The messages to transform
 * @param provider The provider name (e.g., "anthropic", "openai")
 */
export function transformModelMessages(
  messages: ModelMessage[],
  provider: string,
  options?: {
    anthropicThinkingEnabled?: boolean;
  }
): ModelMessage[] {
  // Pass 0: Coalesce consecutive parts to reduce JSON overhead from streaming (applies to all providers)
  const coalesced = coalesceConsecutiveParts(messages);

  // Pass 1: Split mixed content messages (applies to all providers)
  const split = splitMixedContentMessages(coalesced);

  // Pass 2: Drop orphaned tool-call/tool-result pairs (applies to all providers)
  const toolPaired = stripOrphanedToolCalls(split);

  // Pass 3: Coalesce consecutive no-progress task_await polls (applies to all providers)
  const taskAwaitCoalesced = coalesceConsecutiveNoProgressTaskAwaitPairs(toolPaired);

  // Pass 4: Provider-specific reasoning handling
  let reasoningHandled: ModelMessage[];
  if (provider === "openai") {
    // OpenAI: Keep reasoning parts in explicit history so later turns can
    // preserve reasoning context without chaining previous_response_id.
    // Only filter out reasoning-only messages (messages with no text/tool-call content)
    reasoningHandled = filterReasoningOnlyMessages(taskAwaitCoalesced);
  } else if (provider === "anthropic") {
    // Anthropic: When extended thinking is enabled, preserve reasoning-only messages and ensure
    // tool-call messages start with reasoning. When it's disabled, filter reasoning-only messages.
    if (options?.anthropicThinkingEnabled) {
      // First strip reasoning without signatures (SDK will drop them anyway, causing empty messages)
      const signedReasoning = stripUnsignedAnthropicReasoning(taskAwaitCoalesced);
      reasoningHandled = ensureAnthropicThinkingBeforeToolCalls(signedReasoning);
    } else {
      reasoningHandled = filterReasoningOnlyMessages(taskAwaitCoalesced);
    }
  } else {
    // Unknown provider: no reasoning handling
    reasoningHandled = taskAwaitCoalesced;
  }

  // Pass 5: Merge consecutive user messages (applies to all providers)
  const merged = mergeConsecutiveUserMessages(reasoningHandled);

  // Pass 6: Merge text-only synthetic assistant rows (branch summaries) into
  // a preceding assistant turn — Anthropic rejects consecutive assistant
  // messages just as it rejects consecutive user messages. Anthropic-only:
  // other providers accept adjacent assistant rows, and an unconditional
  // merge would change provider-request bytes for histories that contain
  // them outside this path (recovery, imported history).
  return provider === "anthropic" ? mergeConsecutiveAssistantTextMessages(merged) : merged;
}

/**
 * Validate that the transformed messages follow Anthropic's requirements:
 * - Every tool-call must be immediately followed by its tool-result message
 */
export function validateAnthropicCompliance(messages: ModelMessage[]): {
  valid: boolean;
  error?: string;
} {
  const pendingToolCalls = new Map<string, number>(); // toolCallId -> message index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      const assistantMsg = msg;

      // Skip if content is just a string
      if (typeof assistantMsg.content === "string") {
        continue;
      }

      // Track any tool calls in this message
      for (const content of assistantMsg.content) {
        if (content.type === "tool-call") {
          pendingToolCalls.set(content.toolCallId, i);
        }
      }

      // If we have pending tool calls and encounter text or more tool calls,
      // check if the next message has the results
      if (pendingToolCalls.size > 0) {
        const nextMsg = messages[i + 1];

        // The next message MUST be a tool result message if we have pending calls
        if (nextMsg?.role !== "tool") {
          const pendingIds = Array.from(pendingToolCalls.keys()).join(", ");
          return {
            valid: false,
            error: `Message ${i}: tool_use blocks found without tool_result blocks immediately after: ${pendingIds}`,
          };
        }
      }
    } else if (msg.role === "tool") {
      const toolMsg = msg;

      // Process tool results and clear pending calls
      for (const content of toolMsg.content) {
        if (content.type === "tool-result") {
          const toolCallId = content.toolCallId;

          // Check if this result corresponds to a pending call
          if (!pendingToolCalls.has(toolCallId)) {
            return {
              valid: false,
              error: `Message ${i}: tool_result for ${toolCallId} has no corresponding tool_use`,
            };
          }

          // Check if the tool call was in the immediately previous assistant message
          const callIndex = pendingToolCalls.get(toolCallId);
          if (callIndex !== i - 1) {
            return {
              valid: false,
              error: `Message ${i}: tool_result for ${toolCallId} is not immediately after its tool_use (was in message ${callIndex ?? "unknown"})`,
            };
          }

          pendingToolCalls.delete(toolCallId);
        }
      }
    }
  }

  // Check for any remaining pending tool calls
  if (pendingToolCalls.size > 0) {
    const pendingIds = Array.from(pendingToolCalls.keys()).join(", ");
    return {
      valid: false,
      error: `Unresolved tool_use blocks without corresponding tool_result: ${pendingIds}`,
    };
  }

  return { valid: true };
}

function hasAnthropicThinkingSignature(part: { providerOptions?: unknown } | undefined): boolean {
  const providerOptions = part?.providerOptions as
    | { anthropic?: { signature?: unknown } }
    | undefined;
  return (
    typeof providerOptions?.anthropic?.signature === "string" &&
    providerOptions.anthropic.signature.length > 0
  );
}

/**
 * Anthropic Extended Thinking self-healing check.
 *
 * When Anthropic `thinking` is enabled, the API requires that assistant messages containing
 * tool calls begin with a thinking block. The AI SDK only replays thinking blocks when the
 * reasoning part includes a valid Anthropic signature.
 *
 * If we have tool-call messages but no signed reasoning to replay, Anthropic rejects the
 * request with errors like:
 * "Expected thinking or redacted_thinking, but found tool_use."
 *
 * In that case, the safest fallback is to disable thinking for the request.
 */
export function getAnthropicThinkingDisableReason(messages: ModelMessage[]): string | undefined {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      continue;
    }

    // String-only assistant messages never contain tool calls.
    if (typeof msg.content === "string") {
      continue;
    }

    // Treat unsigned reasoning as absent (the AI SDK will drop it).
    const content = msg.content.filter(
      (part) => part.type !== "reasoning" || hasAnthropicThinkingSignature(part)
    );

    const hasToolCall = content.some((part) => part.type === "tool-call");
    if (!hasToolCall) {
      continue;
    }

    const firstPart = content[0];
    if (!firstPart) {
      // Shouldn't happen, but defensively treat it as unsupported.
      return `Message ${i}: tool-call assistant message became empty after stripping unsigned reasoning`;
    }

    if (firstPart.type !== "reasoning") {
      return `Message ${i}: tool-call assistant message does not start with signed reasoning (starts with ${firstPart.type})`;
    }

    if (!hasAnthropicThinkingSignature(firstPart)) {
      // Shouldn't happen because we filtered, but keep error message explicit.
      return `Message ${i}: assistant message starts with reasoning but is missing anthropic.signature`;
    }
  }

  return undefined;
}
