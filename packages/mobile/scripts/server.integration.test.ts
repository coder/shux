import { expect, test } from "bun:test";
import { connect } from "../src/api";
import { applyChatEvent, createTranscriptState } from "../src/transcript";

// Opt in only against a disposable XUM_MOCK_AI=1 server. All RPC, persistence,
// authentication and replay paths are real; only model output is deterministic.
const endpoint = process.env.XUM_MOBILE_TEST_ENDPOINT;
const token = process.env.XUM_MOBILE_TEST_TOKEN;

test.skipIf(!endpoint || !token)(
  "real server persists chat and replays it through a new connection",
  async () => {
    const connection = await connect(endpoint!, token!);
    let workspaceId: string | undefined;
    const subscription = new AbortController();
    try {
      const created = await connection.client.workspace.createScratch({
        title: "Mobile protocol integration",
      });
      if (!created.success) throw new Error(created.error);
      workspaceId = created.metadata.id;
      const events = await connection.client.workspace.onChat(
        { workspaceId, mode: { type: "full" } },
        { signal: subscription.signal }
      );
      let state = createTranscriptState();
      for await (const event of events) {
        state = applyChatEvent(state, event);
        if (state.caughtUp) break;
      }
      expect(state.caughtUp).toBe(true);

      const live = await connection.client.workspace.onChat(
        { workspaceId, mode: { type: "full" } },
        { signal: subscription.signal }
      );
      const result = await connection.client.workspace.sendMessage({
        workspaceId,
        message: "list 3 programming languages",
        options: { model: "anthropic:claude-sonnet-5", agentId: "exec" },
      });
      expect(result.success).toBe(true);
      state = createTranscriptState();
      for await (const event of live) {
        state = applyChatEvent(state, event);
        if (event.type === "stream-error") throw new Error(event.error);
        if (event.type === "stream-end") break;
      }
      const assistant = state.messages.find((message) => message.role === "assistant");
      expect(assistant?.parts.some((part) => part.type === "text" && part.text.length > 0)).toBe(
        true
      );
      subscription.abort();
      connection.close();

      const reconnected = await connection.reconnect();
      try {
        let replay = createTranscriptState();
        const replayEvents = await reconnected.client.workspace.onChat({
          workspaceId,
          mode: { type: "full" },
        });
        for await (const event of replayEvents) {
          replay = applyChatEvent(replay, event);
          if (replay.caughtUp) break;
        }
        expect(replay.messages.map((message) => message.id)).toEqual(
          state.messages.map((message) => message.id)
        );
        expect(replay.messages.find((message) => message.id === assistant?.id)?.parts).toEqual(
          assistant?.parts
        );
        expect((await reconnected.client.workspace.remove({ workspaceId })).success).toBe(true);
        workspaceId = undefined;
      } finally {
        reconnected.close();
      }
    } finally {
      subscription.abort();
      if (workspaceId) {
        const cleanup = await connection.reconnect();
        try {
          await cleanup.client.workspace.remove({ workspaceId });
        } finally {
          cleanup.close();
        }
      }
      connection.close();
    }
  },
  30_000
);
