import { test, expect, mock, spyOn } from "bun:test";
import { StreamManager } from "../services/streamManager";
import type { TurnCoordinator } from "../services/turnCoordinator";
import { EventEmitter } from "node:events";
import { subscribeWorkspaceChat } from "./routerSubscriptions";
import type { ORPCContext } from "./context";
import { createAgentSessionHarness } from "../services/agentSession.testHarness";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

test("active-operation reconnect replays the stream envelope and live deltas before terminal", async () => {
  const workspaceId = "live-replay-smoke";
  const messageId = "assistant-active";
  const emitter = new EventEmitter();
  const replayEntered = Promise.withResolvers<void>();
  const releaseReplay = Promise.withResolvers<void>();
  const caughtUp = Promise.withResolvers<void>();
  const overlappingDelta = Promise.withResolvers<void>();
  const subsequentDelta = Promise.withResolvers<void>();
  let active = true;
  const streamInfo = {
    messageId,
    model: "anthropic:claude-test",
    historySequence: 1,
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    startTime: 100,
    parts: [],
    toolCompletionTimestamps: new Map<string, number>(),
  };
  const delta = (text: string, timestamp: number, replay = false) => ({
    type: "stream-delta",
    workspaceId,
    messageId,
    delta: text,
    timestamp,
    replay,
  });
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiEmitter: emitter,
    captureEvents: true,
    aiServiceOverrides: {
      isStreaming: mock(() => active),
      getStreamInfo: mock(() => (active ? streamInfo : undefined)),
      replayStream: mock(async () => {
        emitEngineStart(true);
        emitter.emit("stream-delta", delta("replayed", 101, true));
        replayEntered.resolve();
        await releaseReplay.promise;
      }),
    },
    initStateManagerOverrides: { replayInit: mock(() => Promise.resolve()) },
  });
  const engine = new StreamManager(harness.historyService, undefined, undefined, (event) => {
    emitter.emit(event.type, event);
  });
  const actualEmit = (
    engine as unknown as {
      emitStreamStart: (
        workspaceId: string,
        info: object,
        sequence: number,
        options: { replay: boolean }
      ) => void;
    }
  ).emitStreamStart;
  const emitEngineStart = (replay: boolean) =>
    actualEmit.call(engine, workspaceId, { ...streamInfo, model: "anthropic:claude-test" }, 1, {
      replay,
    });
  const coordinator = (harness.session as unknown as { coordinator: TurnCoordinator }).coordinator;
  const startPolicy = spyOn(coordinator, "streamStarted");
  const operation = coordinator.registerOperation(coordinator.turnId);
  emitEngineStart(false);
  await harness.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("user", "user", "hello")
  );
  const controller = new AbortController();
  const events: WorkspaceChatMessage[] = [];
  const context = {
    workspaceService: { getOrCreateSession: () => harness.session },
  } as unknown as ORPCContext;
  const consumed = (async () => {
    for await (const event of subscribeWorkspaceChat(context, { workspaceId }, controller.signal)) {
      events.push(event);
      if (event.type === "caught-up") caughtUp.resolve();
      if (event.type === "stream-delta" && event.delta === "overlap") overlappingDelta.resolve();
      if (event.type === "stream-delta" && event.delta === "after") subsequentDelta.resolve();
    }
  })();
  try {
    await replayEntered.promise;
    emitter.emit("stream-delta", delta("overlap", 102));
    releaseReplay.resolve();
    await Promise.all([caughtUp.promise, overlappingDelta.promise]);
    emitter.emit("stream-delta", delta("after", 103));
    await subsequentDelta.promise;
    // The same envelope must not become a second live admission or resurrect a
    // terminal operation; mismatched engine identity is also rejected.
    const startsBefore = harness.events.filter((event) => event.type === "stream-start").length;
    expect(startsBefore).toBe(1);
    expect(startPolicy).toHaveBeenCalledTimes(1);
    emitEngineStart(false);
    emitter.emit("stream-start", {
      type: "stream-start",
      ...streamInfo,
      workspaceId,
      messageId: "stale",
      replay: true,
    });
    expect(harness.events.filter((event) => event.type === "stream-start")).toHaveLength(
      startsBefore
    );
    expect(startPolicy).toHaveBeenCalledTimes(2);
    coordinator.rawTerminal("completed", messageId);
    emitEngineStart(true);
    expect(harness.events.filter((event) => event.type === "stream-start")).toHaveLength(
      startsBefore
    );
    const envelopeIndex = events.findIndex((event) => event.type === "stream-start");
    expect(envelopeIndex).toBeGreaterThanOrEqual(0);
    expect(envelopeIndex).toBeLessThan(events.findIndex((event) => event.type === "stream-delta"));
    expect(envelopeIndex).toBeLessThan(events.findIndex((event) => event.type === "caught-up"));
    expect(
      events.some((event) => event.type === "stream-end" || event.type === "stream-abort")
    ).toBe(false);
    expect(events.find((event) => event.type === "caught-up")).toMatchObject({
      cursor: { stream: { messageId } },
    });
  } finally {
    releaseReplay.resolve();
    controller.abort();
    await consumed;
    active = false;
    coordinator.finishStartup(operation);
    await harness.session.dispose();
    await harness.cleanup();
  }
}, 5000);
