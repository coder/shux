import { describe, expect, test, mock } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import { cancelCompaction } from "./handler";

const STAGED_ATTACHMENT = {
  kind: "staged" as const,
  id: "zip-1",
  filename: "archive.zip",
  mediaType: "application/zip",
  sizeBytes: 199,
  stagedPath: ".mux/user-attachments/id/archive.zip",
};

describe("cancelCompaction", () => {
  test("enters edit mode with full text before interrupting", async () => {
    const calls: string[] = [];

    const interruptStream = mock(() => {
      calls.push("interrupt");
      return Promise.resolve({ success: true });
    });

    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-1",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact -t 100",
              parsed: { followUpContent: { text: "Do the thing" } },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => {
      calls.push("edit");
      return undefined;
    });

    const result = await cancelCompaction(client, "ws-1", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-1",
      pending: {
        content: "/compact -t 100\nDo the thing",
        fileParts: [],
        stagedAttachments: [],
        reviews: [],
      },
    });
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { abandonPartial: true, disableAutoRetry: true, retireBashMonitorAttention: true },
    });
    expect(calls).toEqual(["edit", "interrupt"]);
  });

  test("strips generated staged notices from raw compaction commands", async () => {
    const interruptStream = mock(() => Promise.resolve({ success: true }));
    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-raw-staged",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: appendStagedAttachmentNotice("/compact", [STAGED_ATTACHMENT]),
              parsed: {
                followUpContent: {
                  text: appendStagedAttachmentNotice("", [STAGED_ATTACHMENT]),
                },
              },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => undefined);

    const result = await cancelCompaction(client, "ws-raw-staged", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-raw-staged",
      pending: {
        content: "/compact",
        fileParts: [],
        stagedAttachments: [
          {
            ...STAGED_ATTACHMENT,
            id: "compaction-user-raw-staged-staged-0",
          },
        ],
        reviews: [],
      },
    });
  });

  test("preserves follow-up attachments and reviews on cancel", async () => {
    const calls: string[] = [];

    const interruptStream = mock(() => {
      calls.push("interrupt");
      return Promise.resolve({ success: true });
    });

    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const mockFilePart = {
      type: "file" as const,
      data: "data",
      name: "test.txt",
      mimeType: "text/plain",
    };
    const mockReview = { noteText: "Fix this bug", filePath: "src/app.ts" };

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-2",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {
                followUpContent: {
                  text: "Continue work",
                  fileParts: [mockFilePart],
                  reviews: [mockReview],
                },
              },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => {
      calls.push("edit");
      return undefined;
    });

    const result = await cancelCompaction(client, "ws-2", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-2",
      pending: {
        content: "/compact\nContinue work",
        fileParts: [mockFilePart],
        stagedAttachments: [],
        reviews: [mockReview],
      },
    });
    expect(calls).toEqual(["edit", "interrupt"]);
  });

  test("restores staged follow-up attachments without exposing the hidden notice", async () => {
    const interruptStream = mock(() => Promise.resolve({ success: true }));
    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-3",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {
                followUpContent: {
                  text: appendStagedAttachmentNotice("Continue work", [STAGED_ATTACHMENT]),
                },
              },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => undefined);

    const result = await cancelCompaction(client, "ws-3", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-3",
      pending: {
        content: "/compact\nContinue work",
        fileParts: [],
        stagedAttachments: [
          {
            ...STAGED_ATTACHMENT,
            id: "compaction-user-3-staged-0",
          },
        ],
        reviews: [],
      },
    });
  });
});
