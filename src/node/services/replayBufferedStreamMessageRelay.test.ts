import { describe, expect, test } from "bun:test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createReplayBufferedStreamMessageRelay } from "./replayBufferedStreamMessageRelay";

describe("createReplayBufferedStreamMessageRelay", () => {
  test("keeps early live successor events ordered across independent replay windows", () => {
    const outputs: WorkspaceChatMessage[][] = [[], []];
    const relays = outputs.map((output) =>
      createReplayBufferedStreamMessageRelay((message) => output.push(message))
    );
    const start: WorkspaceChatMessage = {
      type: "stream-start",
      workspaceId: "workspace",
      messageId: "B",
      model: "model",
      historySequence: 1,
      startTime: 1,
    };
    const delta: WorkspaceChatMessage = {
      type: "stream-delta",
      workspaceId: "workspace",
      messageId: "B",
      delta: "live text",
      tokens: 1,
      timestamp: 20,
    };
    for (const relay of relays) {
      relay.handleSessionMessage({
        type: "stream-abort",
        workspaceId: "workspace",
        messageId: "A",
        abortReason: "user",
      });
      relay.handleSessionMessage(start);
      relay.handleSessionMessage(delta);
      relay.handleReplayMessage({
        type: "stream-lifecycle",
        workspaceId: "workspace",
        phase: "streaming",
        hadAnyOutput: true,
      });
    }
    expect(outputs.map((output) => output.map((message) => message.type))).toEqual([
      ["stream-lifecycle"],
      ["stream-lifecycle"],
    ]);
    relays[0].handleReplayMessage({ ...start, replay: true });
    relays[0].handleReplayMessage({ ...delta, replay: true });
    relays[0].finishReplay();
    // The second replay has its own cursor window and has not reached B's snapshot yet.
    expect(outputs[1]).toHaveLength(1);
    relays[1].handleReplayMessage({ ...start, replay: true });
    relays[1].finishReplay();
    for (const output of outputs) {
      expect(output.map((message) => message.type)).toEqual([
        "stream-lifecycle",
        "stream-abort",
        "stream-start",
        "stream-start",
        "stream-delta",
      ]);
      expect(output.filter((message) => message.type === "stream-delta")).toHaveLength(1);
    }
  });

  test("buffers live init events until replay finishes", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Live init output",
      isError: false,
      timestamp: 1_002,
    });

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
    ]);

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
      {
        type: "init-output",
        line: "Live init output",
        isError: false,
        timestamp: 1_002,
      },
    ]);
  });

  test("keeps buffered init lines with the same text/timestamp when lineNumber differs", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "duplicate line",
      isError: false,
      timestamp: 1_001,
      lineNumber: 0,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "duplicate line",
      isError: false,
      timestamp: 1_001,
      lineNumber: 1,
    });

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "duplicate line",
        isError: false,
        timestamp: 1_001,
        lineNumber: 0,
        replay: true,
      },
      {
        type: "init-output",
        line: "duplicate line",
        isError: false,
        timestamp: 1_001,
        lineNumber: 1,
      },
    ]);
  });

  test("drops buffered init events that replay already covered", () => {
    const pushed: WorkspaceChatMessage[] = [];
    const relay = createReplayBufferedStreamMessageRelay((message) => {
      pushed.push(message);
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
      replay: true,
    });
    relay.handleSessionMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: 1_005,
      replay: true,
    });

    relay.handleSessionMessage({
      type: "init-start",
      hookPath: "/tmp/project/.mux/init",
      timestamp: 1_000,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Replayed init output",
      isError: false,
      timestamp: 1_001,
    });
    relay.handleSessionMessage({
      type: "init-output",
      line: "Live init tail",
      isError: false,
      timestamp: 1_002,
    });
    relay.handleSessionMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: 1_005,
    });

    relay.finishReplay();

    expect(pushed).toEqual([
      {
        type: "init-start",
        hookPath: "/tmp/project/.mux/init",
        timestamp: 1_000,
        replay: true,
      },
      {
        type: "init-output",
        line: "Replayed init output",
        isError: false,
        timestamp: 1_001,
        replay: true,
      },
      {
        type: "init-end",
        exitCode: 0,
        timestamp: 1_005,
        replay: true,
      },
      {
        type: "init-output",
        line: "Live init tail",
        isError: false,
        timestamp: 1_002,
      },
    ]);
  });
});
