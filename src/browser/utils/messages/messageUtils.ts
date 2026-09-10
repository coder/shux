import {
  displayStagedAttachmentsToChatAttachments,
  parseStagedAttachmentNotice,
} from "@/browser/features/ChatInput/stagedAttachments";
import type { StagedChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import type { DisplayedMessage, ReviewNoteDataForDisplay } from "@/common/types/message";
import { formatReviewForModel } from "@/common/types/review";
import type { BashOutputToolArgs } from "@/common/types/tools";

export interface EditableUserMessageDraftContent {
  text: string;
  stagedAttachments: StagedChatAttachment[];
}

/**
 * Returns the text and staged attachments that should be placed into ChatInput when editing.
 */
export function getEditableUserMessageDraftContent(
  message: Extract<DisplayedMessage, { type: "user" }>
): EditableUserMessageDraftContent {
  const parsed = parseStagedAttachmentNotice(message.content);
  return {
    text: stripRenderedReviews(parsed.text, message.reviews),
    stagedAttachments: displayStagedAttachmentsToChatAttachments(
      parsed.attachments,
      `edited-${message.historyId}`
    ),
  };
}

function stripRenderedReviews(content: string, reviews?: ReviewNoteDataForDisplay[]): string {
  if (!reviews || reviews.length === 0) {
    return content;
  }

  // Reviews are already stored in metadata; strip their rendered tags to avoid duplication on edit.
  const reviewText = reviews.map(formatReviewForModel).join("\n\n");
  if (!content.startsWith(reviewText)) {
    return content;
  }

  const remainder = content.slice(reviewText.length);
  if (remainder.startsWith("\n\n")) {
    return remainder.slice(2);
  }
  if (remainder.startsWith("\n")) {
    return remainder.slice(1);
  }
  return remainder;
}

/**
 * Type guard to check if a message is a bash_output tool call with valid args
 */
function isBashOutputTool(
  msg: DisplayedMessage
): msg is DisplayedMessage & { type: "tool"; toolName: "bash_output"; args: BashOutputToolArgs } {
  if (msg.type !== "tool" || msg.toolName !== "bash_output") {
    return false;
  }
  // Validate args has required process_id field
  const args = msg.args;
  return (
    typeof args === "object" &&
    args !== null &&
    "process_id" in args &&
    typeof (args as { process_id: unknown }).process_id === "string"
  );
}

/**
 * Information about a bash_output message's position in a consecutive group.
 * Used at render-time to determine how to display the message.
 */
export interface BashOutputGroupInfo {
  /** Position in the group: 'first', 'last', or 'middle' (collapsed) */
  position: "first" | "last" | "middle";
  /** Total number of calls in this group */
  totalCount: number;
  /** Number of collapsed (hidden) calls between first and last */
  collapsedCount: number;
  /** Process ID for the collapsed indicator */
  processId: string;
  /** Index of the first message in this group (used as expand/collapse key) */
  firstIndex: number;
}

interface InterruptedBarrierVisibilityOptions {
  isHydratingTranscript?: boolean;
  isAutoRetryActive?: boolean;
}

/**
 * Determines if the interrupted barrier should be shown for a DisplayedMessage.
 *
 * The barrier should show when:
 * - Message was interrupted (isPartial) AND not currently streaming
 * - For multi-part messages, only show on the last part
 *
 * Recovery-in-progress states intentionally suppress the barrier so restart-driven
 * auto-resume does not briefly look like a user-visible failure.
 */
export function shouldShowInterruptedBarrier(
  msg: DisplayedMessage,
  options?: InterruptedBarrierVisibilityOptions
): boolean {
  if (
    msg.type === "user" ||
    msg.type === "stream-error" ||
    msg.type === "compaction-boundary" ||
    msg.type === "history-hidden" ||
    msg.type === "workspace-init" ||
    msg.type === "plan-display"
  )
    return false;

  if (options?.isHydratingTranscript || options?.isAutoRetryActive) {
    return false;
  }

  // ask_user_question is intentionally a "waiting for input" state. Even if the
  // underlying message is a persisted partial (e.g. after app restart), we keep
  // it answerable instead of showing "Interrupted".
  if (msg.type === "tool" && msg.toolName === "ask_user_question" && msg.status === "executing") {
    return false;
  }

  // Only show on the last part of multi-part messages
  if (!msg.isLastPartOfMessage) return false;

  // Show if interrupted and not actively streaming (tools don't have isStreaming property)
  const isStreaming = "isStreaming" in msg ? msg.isStreaming : false;
  return msg.isPartial && !isStreaming;
}

/**
 * Returns whether ChatPane should bypass useDeferredValue and render the immediate
 * message list. We bypass deferral while assistant content is streaming, while the
 * init hook is still running, OR while any tool call is still executing (for example,
 * live bash output).
 *
 * We also bypass when the deferred snapshot appears stale (it still has active
 * streaming/executing rows after the immediate snapshot is idle), or when both
 * snapshots have diverged in row identity/order. Showing stale deferred rows can
 * cause hidden-marker placement, hide live init logs after a workspace switch, and
 * flash tool state at stream completion.
 */
export function shouldBypassDeferredMessages(
  messages: DisplayedMessage[],
  deferredMessages: DisplayedMessage[],
  options?: {
    immediateWorkspaceId?: string;
    deferredWorkspaceId?: string;
  }
): boolean {
  if (
    options?.immediateWorkspaceId !== undefined &&
    options?.deferredWorkspaceId !== undefined &&
    options.immediateWorkspaceId !== options.deferredWorkspaceId
  ) {
    return true;
  }

  const hasActiveRows = (rows: DisplayedMessage[]) =>
    rows.some(
      (m) =>
        ("isStreaming" in m && m.isStreaming) ||
        (m.type === "tool" && m.status === "executing") ||
        // Keep SSH/Coder init output on the immediate path when a user returns to a
        // workspace mid-setup; otherwise the deferred snapshot can keep showing an
        // older empty/stale init row because workspace-init uses a stable display ID.
        (m.type === "workspace-init" && m.status === "running")
    );

  if (messages.length !== deferredMessages.length) {
    return true;
  }

  for (let i = 0; i < messages.length; i++) {
    const immediateMessage = messages[i];
    const deferredMessage = deferredMessages[i];
    if (!immediateMessage || !deferredMessage) {
      return true;
    }

    if (
      immediateMessage.id !== deferredMessage.id ||
      immediateMessage.type !== deferredMessage.type
    ) {
      return true;
    }
  }

  return hasActiveRows(messages) || hasActiveRows(deferredMessages);
}

/**
 * Merges consecutive stream-error messages with identical content.
 * Returns a new array where consecutive identical errors are represented as a single message
 * with an errorCount field indicating how many times it occurred.
 *
 * @param messages - Array of DisplayedMessages to process
 * @returns Array with consecutive identical errors merged (errorCount added to stream-error variants)
 */
export function mergeConsecutiveStreamErrors(messages: DisplayedMessage[]): DisplayedMessage[] {
  if (messages.length === 0) return [];

  const result: DisplayedMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // If it's not a stream-error, just add it and move on
    if (msg.type !== "stream-error") {
      result.push(msg);
      i++;
      continue;
    }

    // Count consecutive identical errors
    let count = 1;
    let j = i + 1;
    while (j < messages.length) {
      const nextMsg = messages[j];
      if (
        nextMsg.type === "stream-error" &&
        nextMsg.error === msg.error &&
        nextMsg.errorType === msg.errorType
      ) {
        count++;
        j++;
      } else {
        break;
      }
    }

    // Add the error with count
    result.push({
      ...msg,
      errorCount: count,
    });

    // Skip all the merged errors
    i = j;
  }

  return result;
}

/**
 * Precompute bash_output grouping metadata for all rows in one linear pass.
 *
 * Why: workspace-open now renders full history in a single commit. Doing a backward+forward
 * scan per row turns long transcripts into O(n²) grouping work right on the critical path.
 */
export function computeBashOutputGroupInfos(
  messages: DisplayedMessage[]
): Array<BashOutputGroupInfo | undefined> {
  const groupInfos = new Array<BashOutputGroupInfo | undefined>(messages.length);

  let index = 0;
  while (index < messages.length) {
    const msg = messages[index];
    if (!isBashOutputTool(msg)) {
      index++;
      continue;
    }

    const processId = msg.args.process_id;
    let groupEnd = index;

    while (groupEnd < messages.length - 1) {
      const nextMsg = messages[groupEnd + 1];
      if (!isBashOutputTool(nextMsg) || nextMsg.args.process_id !== processId) {
        break;
      }
      groupEnd++;
    }

    const groupSize = groupEnd - index + 1;
    if (groupSize >= 3) {
      const collapsedCount = groupSize - 2;

      for (let groupIndex = index; groupIndex <= groupEnd; groupIndex++) {
        let position: BashOutputGroupInfo["position"] = "middle";
        if (groupIndex === index) {
          position = "first";
        } else if (groupIndex === groupEnd) {
          position = "last";
        }

        groupInfos[groupIndex] = {
          position,
          totalCount: groupSize,
          collapsedCount,
          processId,
          firstIndex: index,
        };
      }
    }

    index = groupEnd + 1;
  }

  return groupInfos;
}
