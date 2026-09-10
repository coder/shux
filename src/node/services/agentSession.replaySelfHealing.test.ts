/**
 * onChat replay self-healing: a persisted row that fails the wire schema must be
 * skipped (rest of the transcript intact, caught-up still delivered) instead of
 * killing the subscription. oRPC output-validates every yielded event, so before
 * this guard one corrupt chat.jsonl row terminated the iterator and permanently
 * bricked workspace fetch in server mode.
 */
import { describe, expect, it, mock, afterEach } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import { isMuxMessage, type WorkspaceChatMessage } from "@/common/orpc/types";
import { createAgentSessionHarness } from "./agentSession.testHarness";

async function createReplayHarness(workspaceId: string) {
  return await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
        Promise.resolve()
      ),
    },
    initStateManagerOverrides: { replayInit: mock((_workspaceId: string) => Promise.resolve()) },
  });
}

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp: number
): MuxMessage {
  return { id, role, parts: [{ type: "text", text, timestamp }], metadata: { timestamp } };
}

async function replayAll(
  session: Awaited<ReturnType<typeof createReplayHarness>>["session"]
): Promise<WorkspaceChatMessage[]> {
  const events: WorkspaceChatMessage[] = [];
  await session.replayHistory(
    ({ message }: { message: WorkspaceChatMessage }) => {
      events.push(message);
    },
    { type: "full" }
  );
  return events;
}

describe("onChat replay self-healing", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it("skips a persisted row that fails the wire schema instead of failing replay", async () => {
    const workspaceId = "ws-replay-self-healing";
    const harness = await createReplayHarness(workspaceId);
    cleanup = harness.cleanup;
    const { session, historyService } = harness;

    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          textMessage("user-1", "user", "hi", 1_000)
        )
      ).success
    ).toBe(true);

    // Recorder-bug shape: an output-available tool part whose output key was
    // dropped by JSON serialization (output: undefined). Fails the wire schema.
    const corrupt = {
      id: "assistant-corrupt",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "true" },
          state: "output-available",
        },
      ],
      metadata: { timestamp: 2_000 },
    } as unknown as MuxMessage;
    expect((await historyService.appendToHistory(workspaceId, corrupt)).success).toBe(true);

    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          textMessage("assistant-2", "assistant", "done", 3_000)
        )
      ).success
    ).toBe(true);

    const events = await replayAll(session);

    // The corrupt row is skipped; every other row still replays in order.
    expect(events.filter(isMuxMessage).map((row) => row.id)).toEqual(["user-1", "assistant-2"]);
    // caught-up still arrives so the client leaves its loading state.
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
    // The invariant the guard protects: every replayed event survives the oRPC
    // output validation that killed the subscription before.
    for (const event of events) {
      expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
    }
  });

  it("replays rows whose nested kernel calls were persisted without input", async () => {
    // Regression for real-world data: zero-arg kernel capability calls
    // (mux.tool()) persisted nestedCalls entries without an input key. Such
    // rows must replay (not be skipped) so the transcript stays complete.
    const workspaceId = "ws-replay-nested-no-input";
    const harness = await createReplayHarness(workspaceId);
    cleanup = harness.cleanup;
    const { session, historyService } = harness;

    const legacyRow = {
      id: "assistant-nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "parent-1",
          toolName: "code_execution",
          input: { code: "mux.linear_get_issue_status()" },
          state: "output-available",
          output: { result: "ok" },
          nestedCalls: [
            {
              toolCallId: "nested-1",
              toolName: "linear_get_issue_status",
              state: "output-available",
              output: { error: "missing args" },
              timestamp: 1_500,
            },
          ],
        },
      ],
      metadata: { timestamp: 1_000 },
    } as unknown as MuxMessage;
    expect((await historyService.appendToHistory(workspaceId, legacyRow)).success).toBe(true);

    const events = await replayAll(session);

    expect(events.filter(isMuxMessage).map((row) => row.id)).toEqual(["assistant-nested"]);
    for (const event of events) {
      expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
    }
  });
});
