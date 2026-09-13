import { describe, expect, test } from "bun:test";
import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  QueuedMessage,
} from "@/common/types/message";
import {
  buildEditingStateFromCompaction,
  buildEditingStateFromDisplayed,
  buildPendingFromDisplayed,
  buildPendingFromRestoredInput,
  canEditDisplayedUserMessage,
  normalizeQueuedMessage,
} from "./chatEditing";

function userMessage(overrides: Partial<DisplayedUserMessage> = {}): DisplayedUserMessage {
  return {
    type: "user",
    id: "user-message",
    historyId: "user-message",
    content: "hello",
    historySequence: 1,
    ...overrides,
  };
}

const STAGED_ATTACHMENT = {
  kind: "staged" as const,
  id: "zip-1",
  filename: "archive.zip",
  mediaType: "application/zip",
  sizeBytes: 199,
  stagedPath: ".mux/user-attachments/id/archive.zip",
};

describe("canEditDisplayedUserMessage", () => {
  test("excludes goal-synthetic messages from all edit paths", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isGoalContinuation: true }))).toBe(false);
    expect(canEditDisplayedUserMessage(userMessage({ isBudgetLimitWrapup: true }))).toBe(false);
  });

  test("excludes the not-yet-persisted first message of a new workspace", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isPendingSend: true }))).toBe(false);
  });

  test("excludes local command output messages", () => {
    expect(
      canEditDisplayedUserMessage(
        userMessage({ content: "<local-command-stdout>output</local-command-stdout>" })
      )
    ).toBe(false);
  });

  test("allows messages before the latest context boundary", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isBeforeLatestContextBoundary: true }))).toBe(
      true
    );
  });

  test("marks pre-boundary edits so the send flow can confirm destructive rewind", () => {
    expect(
      buildEditingStateFromDisplayed(userMessage({ isBeforeLatestContextBoundary: true }))
        .isBeforeLatestContextBoundary
    ).toBe(true);
  });

  test("restores staged files as attachments when editing sent messages", () => {
    const content = appendStagedAttachmentNotice("Inspect this archive.", [STAGED_ATTACHMENT]);

    const pending = buildPendingFromDisplayed(userMessage({ content, historyId: "history-1" }));

    expect(pending.content).toBe("Inspect this archive.");
    expect(pending.fileParts).toEqual([]);
    expect(pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "edited-history-1-staged-0",
      },
    ]);
  });

  test("restores staged files as attachments when normalizing queued messages", () => {
    const queued: QueuedMessage = {
      id: "queued-1",
      content: appendStagedAttachmentNotice("Queued archive.", [STAGED_ATTACHMENT]),
    };

    const pending = normalizeQueuedMessage(queued);

    expect(pending.content).toBe("Queued archive.");
    expect(pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "queued-queued-1-staged-0",
      },
    ]);
  });

  test("restores staged files from restore-to-input payloads with attachments", () => {
    const filePart = {
      url: "data:text/plain;base64,ZGF0YQ==",
      mediaType: "text/plain",
      filename: "context.txt",
    };
    const review = {
      filePath: "src/app.ts",
      lineRange: "+1",
      selectedCode: "const value = 1;",
      userNote: "Review this",
    };

    const pending = buildPendingFromRestoredInput({
      content: appendStagedAttachmentNotice("Restore queued work.", [STAGED_ATTACHMENT]),
      fileParts: [filePart],
      reviews: [review],
      idPrefix: "restored-queue",
    });

    expect(pending).toEqual({
      content: "Restore queued work.",
      fileParts: [filePart],
      stagedAttachments: [
        {
          ...STAGED_ATTACHMENT,
          id: "restored-queue-staged-0",
        },
      ],
      reviews: [review],
    });
  });

  test("restores staged files from compaction follow-up content", () => {
    const followUp: CompactionFollowUpRequest = {
      text: appendStagedAttachmentNotice("Continue after compaction.", [STAGED_ATTACHMENT]),
      model: "claude-sonnet-4-5",
      agentId: "exec",
    };

    const editingState = buildEditingStateFromCompaction("compact-message", "/compact", followUp);

    expect(editingState.pending.content).toBe("/compact");
    expect(editingState.pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "compaction-compact-message-staged-0",
      },
    ]);
  });

  test("allows normal user messages", () => {
    expect(canEditDisplayedUserMessage(userMessage())).toBe(true);
  });
});
