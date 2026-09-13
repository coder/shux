import type { FilePart } from "@/common/orpc/types";
import type { StagedChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import {
  displayStagedAttachmentsToChatAttachments,
  parseStagedAttachmentNotice,
} from "@/browser/features/ChatInput/stagedAttachments";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  QueuedMessage,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { getEditableUserMessageDraftContent } from "@/browser/utils/messages/messageUtils";

// Keep pending edit data normalized with required arrays so edits can't drop attachments/reviews.
export interface PendingUserMessage extends Omit<
  QueuedMessage,
  "id" | "hasCompactionRequest" | "queueDispatchMode"
> {
  fileParts: FilePart[];
  stagedAttachments: StagedChatAttachment[];
  reviews: ReviewNoteDataForDisplay[];
}

export interface EditingMessageState {
  id: string;
  pending: PendingUserMessage;
  /**
   * Sending this edit will truncate across the latest context boundary, so the
   * composer must confirm before discarding the compaction/reset summary.
   */
  isBeforeLatestContextBoundary?: boolean;
}

function stagedAttachmentsFromText(
  text: string | undefined,
  idPrefix: string
): StagedChatAttachment[] {
  if (!text) {
    return [];
  }
  const parsed = parseStagedAttachmentNotice(text);
  return displayStagedAttachmentsToChatAttachments(parsed.attachments, idPrefix);
}

export const normalizeQueuedMessage = (queued: QueuedMessage): PendingUserMessage =>
  buildPendingFromRestoredInput({
    content: queued.content,
    fileParts: queued.fileParts ?? [],
    reviews: queued.reviews ?? [],
    idPrefix: `queued-${queued.id}`,
  });

export function buildPendingFromRestoredInput(params: {
  content: string;
  fileParts: FilePart[];
  reviews: ReviewNoteDataForDisplay[];
  idPrefix: string;
}): PendingUserMessage {
  const parsed = parseStagedAttachmentNotice(params.content);
  return {
    content: parsed.text,
    fileParts: params.fileParts,
    stagedAttachments: displayStagedAttachmentsToChatAttachments(
      parsed.attachments,
      params.idPrefix
    ),
    reviews: params.reviews,
  };
}

const LOCAL_COMMAND_STDOUT_OPEN_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDOUT_CLOSE_TAG = "</local-command-stdout>";

export const canEditDisplayedUserMessage = (message: DisplayedUserMessage): boolean => {
  if (message.isPendingSend === true) return false;
  if (message.isGoalContinuation === true || message.isBudgetLimitWrapup === true) return false;
  if (message.content.startsWith(LOCAL_COMMAND_STDOUT_OPEN_TAG)) {
    return !message.content.endsWith(LOCAL_COMMAND_STDOUT_CLOSE_TAG);
  }
  return true;
};

export const buildPendingFromDisplayed = (message: DisplayedUserMessage): PendingUserMessage => {
  const draft = getEditableUserMessageDraftContent(message);
  return {
    content: draft.text,
    fileParts: message.fileParts ?? [],
    stagedAttachments: draft.stagedAttachments,
    reviews: message.reviews ?? [],
  };
};

export const buildEditingStateFromDisplayed = (
  message: DisplayedUserMessage
): EditingMessageState => ({
  id: message.historyId,
  pending: buildPendingFromDisplayed(message),
  ...(message.isBeforeLatestContextBoundary === true
    ? { isBeforeLatestContextBoundary: true }
    : {}),
});

/**
 * Build editing state from a compaction command and its follow-up content.
 * Preserves file attachments and reviews that would be sent after compaction completes.
 */
export const buildEditingStateFromCompaction = (
  messageId: string,
  command: string,
  followUp?: CompactionFollowUpRequest
): EditingMessageState => ({
  id: messageId,
  pending: {
    content: command,
    fileParts: followUp?.fileParts ?? [],
    stagedAttachments: stagedAttachmentsFromText(followUp?.text, `compaction-${messageId}`),
    reviews: followUp?.reviews ?? [],
  },
});
