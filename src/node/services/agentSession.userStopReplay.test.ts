import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { ChatMuxMessageSchema } from "@/common/orpc/schemas/stream";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const initStateManagerOverrides = { replayInit: () => Promise.resolve() };

for (const partialFile of [false, true]) {
  test(`replay projects durable user Stop onto the latest partial without rewriting history (partialFile=${partialFile})`, async () => {
    const workspaceId = "stopped-question-replay";
    const original = await createAgentSessionHarness({ workspaceId, initStateManagerOverrides });
    const { config, historyService } = original;
    const older: MuxMessage = {
      id: "older",
      role: "assistant",
      parts: [{ type: "text", text: "Older partial" }],
      metadata: { partial: true },
    };
    const user = createMuxMessage("user-1", "user", "Choose a branch");
    const partial: MuxMessage = {
      id: "question",
      role: "assistant",
      metadata: { partial: true },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "question",
          toolName: "ask_user_question",
          state: "output-available",
          input: {},
          output: { summary: "main" },
        },
      ],
    };
    try {
      expect((await historyService.appendToHistory(workspaceId, older)).success).toBe(true);
      expect((await historyService.appendToHistory(workspaceId, user)).success).toBe(true);
      expect((await historyService.appendToHistory(workspaceId, partial)).success).toBe(true);
      if (partialFile)
        expect((await historyService.writePartial(workspaceId, partial)).success).toBe(true);
      const preferencePath = (
        original.session as unknown as { getAutoRetryPreferencePath(): string }
      ).getAutoRetryPreferencePath();
      await writeFile(
        preferencePath,
        JSON.stringify({
          enabled: false,
          startupAutoRetryAbandon: { reason: "aborted", userMessageId: user.id },
        })
      );
      await original.session.dispose();
      const restarted = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService,
        initStateManagerOverrides,
      });
      try {
        const rows: WorkspaceChatMessage[] = [];
        await restarted.session.replayHistory(({ message }) => rows.push(message));
        const stopped = rows.find((row) => row.type === "message" && row.id === partial.id);
        expect(ChatMuxMessageSchema.parse(stopped).metadata?.userStopped).toBe(true);
        const prior = rows.find((row) => row.type === "message" && row.id === older.id);
        expect(ChatMuxMessageSchema.parse(prior).metadata?.userStopped).toBeUndefined();
        const disk = await historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!disk.success) throw new Error(disk.error);
        expect(disk.data.every((row) => row.metadata?.userStopped === undefined)).toBe(true);
        expect(
          (await historyService.readPartial(workspaceId))?.metadata?.userStopped
        ).toBeUndefined();
        // The same durable marker must not suppress a later user turn's crash recovery.
        expect((await historyService.deletePartial(workspaceId)).success).toBe(true);
        expect(
          (
            await historyService.appendToHistory(
              workspaceId,
              createMuxMessage("next-user", "user", "Continue differently")
            )
          ).success
        ).toBe(true);
        const nextPartial = { ...partial, id: "next-answer", metadata: { partial: true } };
        expect((await historyService.appendToHistory(workspaceId, nextPartial)).success).toBe(true);
        const nextRows: WorkspaceChatMessage[] = [];
        await restarted.session.replayHistory(({ message }) => nextRows.push(message));
        const next = nextRows.find((row) => row.type === "message" && row.id === nextPartial.id);
        expect(ChatMuxMessageSchema.parse(next).metadata?.userStopped).toBeUndefined();
      } finally {
        await restarted.session.dispose();
      }
    } finally {
      await original.session.dispose();
      await original.cleanup();
    }
  });
}

test("post-answer crashes, unrelated stops and active streams are not marked user-stopped", async () => {
  for (const [marker, streaming] of [
    [undefined, false],
    [{ reason: "aborted", userMessageId: "other-user" }, false],
    [{ reason: "runtime_start_failed", userMessageId: "user" }, false],
    [{ reason: "aborted", userMessageId: "user" }, true],
  ] as const) {
    const workspaceId = "recoverable-question-replay";
    const { session, historyService, cleanup } = await createAgentSessionHarness({
      workspaceId,
      initStateManagerOverrides,
      aiServiceOverrides: { isStreaming: () => streaming },
    });
    try {
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("user", "user", "Choose")
          )
        ).success
      ).toBe(true);
      const partial: MuxMessage = {
        id: "answer",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "question",
            toolName: "ask_user_question",
            state: "output-available",
            input: {},
            output: { summary: "answered" },
          },
        ],
        metadata: { partial: true },
      };
      expect((await historyService.appendToHistory(workspaceId, partial)).success).toBe(true);
      if (marker) {
        const preferencePath = (
          session as unknown as { getAutoRetryPreferencePath(): string }
        ).getAutoRetryPreferencePath();
        await writeFile(preferencePath, JSON.stringify({ startupAutoRetryAbandon: marker }));
      }
      const rows: WorkspaceChatMessage[] = [];
      await session.replayHistory(({ message }) => rows.push(message));
      const answer = rows.find((row) => row.type === "message" && row.id === partial.id);
      expect(ChatMuxMessageSchema.parse(answer).metadata?.userStopped).toBeUndefined();
    } finally {
      await session.dispose();
      await cleanup();
    }
  }
});
