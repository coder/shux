import { expect, test, spyOn } from "bun:test";
import type { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
} from "../services/agentSession.testHarness";
import { subscribeWorkspaceChat } from "./routerSubscriptions";
import type { ORPCContext } from "./context";
import { createMuxMessage } from "@/common/types/message";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { TurnCoordinator, OperationId } from "../services/turnCoordinator";
import { Ok } from "@/common/types/result";

async function setup(
  onReplayResumed?: () => void,
  beforeReplayStart?: () => Promise<void>,
  initiallyActive = true
) {
  let active = initiallyActive;
  const workspaceId = "observed-engine";
  const emitter = new EventEmitter();
  const info = {
    messageId: "engine-A",
    model: "anthropic:claude-test",
    historySequence: 1,
    startTime: 1,
    parts: [{ type: "text" as const, text: "earlier", timestamp: 30 }],
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    toolCompletionTimestamps: new Map<string, number>(),
  };
  const start = { ...info, type: "stream-start" as const, workspaceId, replay: true };
  const gates: Array<{
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  let invocation = 0;
  const replayOffsets: Array<number | undefined> = [];
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiEmitter: emitter,
    aiServiceOverrides: {
      isStreaming: () => active,
      getStreamInfo: () => (active ? { ...info } : undefined),
      replayStream: async (_workspaceId, options) => {
        replayOffsets.push(options?.afterTimestamp);
        const index = invocation++;
        await beforeReplayStart?.();
        emitter.emit("stream-start", start);
        const gate = gates[index];
        gate?.entered.resolve();
        if (gate) await gate.release.promise;
        onReplayResumed?.();
        emitter.emit("stream-delta", {
          type: "stream-delta",
          workspaceId,
          messageId: info.messageId,
          delta: `window-${index}`,
          timestamp: index + 10,
          replay: true,
        });
      },
    },
    initStateManagerOverrides: { replayInit: () => Promise.resolve() },
  });
  await harness.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("seed", "user", "seed")
  );
  const context = {
    workspaceService: { getOrCreateSession: () => harness.session },
  } as unknown as ORPCContext;
  const clients: Array<{ stop: () => Promise<void> }> = [];
  const subscribe = (mode?: OnChatMode) => {
    const abort = new AbortController();
    const caught = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const live = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const events: WorkspaceChatMessage[] = [];
    const done = (async () => {
      for await (const event of subscribeWorkspaceChat(
        context,
        { workspaceId, mode },
        abort.signal
      )) {
        events.push(event);
        if (event.type === "stream-start") aggregator.handleStreamStart(event);
        if (event.type === "queued-message-changed") {
          aggregator.setActiveQueuedFollowUp(event.hasQueuedMessages === true);
          if (event.hasQueuedMessages) queued.resolve();
        }
        if (event.type === "caught-up") caught.resolve();
        if (event.type === "stream-end") terminal.resolve();
        if (event.type === "stream-delta" && event.delta === "live") live.resolve();
      }
    })();
    const stop = async () => {
      abort.abort();
      await done;
    };
    clients.push({ stop });
    return {
      caught: caught.promise,
      queued: queued.promise,
      live: live.promise,
      terminal: terminal.promise,
      events,
      aggregator,
      stop,
    };
  };
  return {
    ...harness,
    workspaceId,
    emitter,
    gates,
    replayOffsets,
    startReplacement: () => {
      active = true;
      info.messageId = "engine-B";
      emitter.emit("stream-start", { ...info, workspaceId, type: "stream-start" });
    },
    setActive: (value: boolean) => {
      active = value;
    },
    subscribe,
    close: async () => {
      for (const gate of gates) gate?.release.resolve();
      await Promise.all(clients.map((client) => client.stop()));
      harness.session.clearQueue();
      await harness.session.dispose();
      await harness.cleanup();
    },
  };
}

test.each(["stream-end", "stream-abort", "error"])(
  "operationless replay holds manual input until its exact %s",
  async (terminal) => {
    const h = await setup();
    const order: string[] = [];
    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const read = h.historyService.getLastMessages.bind(h.historyService);
    // Replay publishes caught-up before startup recovery finishes. Hold its continuation
    // observation so the terminal event must leave queued input behind that physical owner.
    let held = false;
    spyOn(h.historyService, "getLastMessages").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1] === 1 && !held) {
        held = true;
        readEntered.resolve();
        await releaseRead.promise;
        order.push("recovery-read-settled");
      }
      return result;
    });
    const sent = Promise.withResolvers<void>();
    const send = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      order.push("manual-stream");
      sent.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
    });
    h.session.onChatEvent(({ message }) => {
      if (
        (message.type === "stream-end" ||
          message.type === "stream-abort" ||
          message.type === "stream-error") &&
        message.messageId === "engine-A"
      )
        order.push("exact-terminal");
    });
    try {
      const client = h.subscribe();
      await client.caught;
      await readEntered.promise;
      expect(h.session.isBusy()).toBe(true);
      h.session.queueMessage("manual follow-up", { model: "openai:gpt-4o", agentId: "exec" });
      h.session.drainQueuedMessagesIfIdle();
      expect(send).not.toHaveBeenCalled();
      h.emitter.emit(terminal, {
        type: terminal === "error" ? "stream-error" : terminal,
        error: "provider failed",
        errorType: "unknown",
        abortReason: "user",
        workspaceId: h.workspaceId,
        messageId: "stale",
        parts: [],
        metadata: {},
      });
      expect(h.session.isBusy()).toBe(true);
      h.setActive(false);
      h.emitter.emit(terminal, {
        type: terminal === "error" ? "stream-error" : terminal,
        error: "provider failed",
        errorType: "unknown",
        abortReason: "user",
        workspaceId: h.workspaceId,
        messageId: "engine-A",
        parts: [],
        metadata: {},
      });
      expect(h.session.isBusy()).toBe(false);
      expect(h.session.hasActiveOrPendingTurnWork()).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(order).toEqual(["exact-terminal"]);
      releaseRead.resolve();
      await sent.promise;
      expect(send).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["exact-terminal", "recovery-read-settled", "manual-stream"]);
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.filter((message) => message.id !== "seed")).toMatchObject([
          { role: "user", parts: [{ type: "text", text: "manual follow-up" }] },
        ]);
      }
    } finally {
      releaseRead.resolve();
      await h.close();
    }
  }
);

test("overlapping replays preserve an existing client's queue and isolate each replay window", async () => {
  const h = await setup();
  try {
    const existing = h.subscribe();
    await existing.caught;
    h.session.queueMessage("follow-up");
    await existing.queued;
    expect(existing.aggregator.getActiveStreams()[0]?.hasQueuedFollowUp).toBe(true);
    h.gates[1] = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    h.gates[2] = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const caughtUp = existing.events.find((event) => event.type === "caught-up");
    const history = caughtUp?.cursor?.history;
    if (!history) throw new Error("Expected history cursor");
    const a = h.subscribe({
      type: "since",
      cursor: { history, stream: { messageId: "engine-A", lastTimestamp: 10 } },
    });
    await h.gates[1].entered.promise;
    const b = h.subscribe({
      type: "since",
      cursor: { history, stream: { messageId: "engine-A", lastTimestamp: 20 } },
    });
    await h.gates[2].entered.promise;
    h.emitter.emit("stream-delta", {
      type: "stream-delta",
      workspaceId: h.workspaceId,
      messageId: "engine-A",
      delta: "live",
      timestamp: 100,
    });
    await existing.live;
    h.gates[2].release.resolve();
    await b.caught;
    h.gates[1].release.resolve();
    await a.caught;
    await Promise.all([a.live, b.live]);
    expect(existing.aggregator.getActiveStreams()[0]?.hasQueuedFollowUp).toBe(true);
    const windows = (events: WorkspaceChatMessage[]) =>
      events.filter((event) => event.type === "stream-delta").map((event) => event.delta);
    expect(windows(existing.events)).toEqual(["window-0", "live"]);
    expect(windows(a.events)).toEqual(["window-1", "live"]);
    expect(windows(b.events)).toEqual(["window-2", "live"]);
    expect(h.replayOffsets).toEqual([undefined, 10, 20]);
  } finally {
    await h.close();
  }
});

test("an aborted replay cannot publish its delayed window to another subscriber", async () => {
  const h = await setup();
  try {
    const existing = h.subscribe();
    await existing.caught;
    h.gates[1] = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const abandoned = h.subscribe();
    await h.gates[1].entered.promise;
    await abandoned.stop();
    const before = abandoned.events.length;
    h.gates[1].release.resolve();
    // A succeeding replay is an explicit barrier past the abandoned replay's release.
    const next = h.subscribe();
    await next.caught;
    expect(abandoned.events).toHaveLength(before);
    expect(
      existing.events.filter((event) => event.type === "stream-delta").map((event) => event.delta)
    ).toEqual(["window-0"]);
  } finally {
    await h.close();
  }
});

test("disposing a held replay releases its async context without affecting a sibling session", async () => {
  const resumed = Promise.withResolvers<unknown>();
  const h = await setup(() => resumed.resolve(publication.getStore()));
  const publication = (h.session as unknown as { replayPublication: AsyncLocalStorage<unknown> })
    .replayPublication;
  const sibling = await setup();
  let held: ReturnType<typeof h.subscribe> | undefined;
  try {
    h.gates[0] = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    held = h.subscribe();
    await h.gates[0].entered.promise;
    await h.session.dispose();
    h.gates[0].release.resolve();
    expect(await resumed.promise).toBeUndefined();
    await held.caught;
    expect(held.events.some((event) => event.type === "stream-delta")).toBe(false);
    const surviving = sibling.subscribe();
    await surviving.caught;
    expect(
      surviving.events.filter((event) => event.type === "stream-delta").map((event) => event.delta)
    ).toEqual(["window-0"]);
    expect(surviving.aggregator.hasInterruptibleActiveStream()).toBe(true);
  } finally {
    // The disposed session rejects queue APIs; its subscription and disk fixture are
    // still independently owned by the test while the delayed replay finishes.
    for (const gate of h.gates) gate?.release.resolve();
    await held?.stop();
    await h.cleanup();
    await sibling.close();
  }
});

test.each([
  ["history", "full"],
  ["history", "since"],
  ["before-start", "full"],
  ["before-start", "since"],
  ["before-start", "live"],
])("replay owns the active engine before %s awaits in %s mode", async (boundary, modeName) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const h = await setup(undefined, boundary === "before-start" ? hold : undefined, false);
  h.setActive(true);
  if (boundary === "history") {
    const read = h.historyService.readPartial.bind(h.historyService);
    spyOn(h.historyService, "readPartial").mockImplementationOnce(async (...args) => {
      await hold();
      return read(...args);
    });
  }
  const coordinator = (h.session as unknown as { coordinator: TurnCoordinator }).coordinator;
  let replacementOperation: OperationId | undefined;
  const send = spyOn(h.session, "sendMessage").mockImplementation(() => {
    // Queue dispatch has already claimed B's real preparation owner. Only its
    // provider boundary is controlled here; start and replay use session ingress.
    replacementOperation = coordinator.registerOperation(coordinator.turnId);
    h.startReplacement();
    return Promise.resolve(Ok(undefined));
  });
  try {
    const mode: OnChatMode | undefined =
      modeName === "live"
        ? { type: "live" }
        : modeName === "since"
          ? {
              type: "since",
              cursor: {
                history: { messageId: "seed", historySequence: 0 },
                stream: { messageId: "engine-A", lastTimestamp: 10 },
              },
            }
          : undefined;
    const client = h.subscribe(mode);
    await entered.promise;
    expect(h.session.isBusy()).toBe(true);
    h.session.queueMessage("manual during replay");
    h.session.drainQueuedMessagesIfIdle();
    expect(send).not.toHaveBeenCalled();
    h.emitter.emit("stream-end", {
      type: "stream-end",
      workspaceId: h.workspaceId,
      messageId: "stale",
      parts: [],
      metadata: {},
    });
    expect(h.session.isBusy()).toBe(true);
    h.setActive(false);
    expect(h.session.isBusy()).toBe(true);
    expect(send).not.toHaveBeenCalled();
    h.emitter.emit("stream-end", {
      type: "stream-end",
      workspaceId: h.workspaceId,
      messageId: "engine-A",
      parts: [],
      metadata: {},
    });
    expect(send).toHaveBeenCalledTimes(1);
    const replacementTurn = coordinator.turnId;
    expect(coordinator.phase).toBe("streaming");
    release.resolve();
    await client.caught;
    await client.terminal;
    expect(client.events.filter((event) => event.type === "stream-end")).toHaveLength(1);
    expect(
      client.events.some((event) => event.type === "stream-start" && event.messageId === "engine-A")
    ).toBe(false);
    expect(coordinator.turnId).toBe(replacementTurn);
    expect(coordinator.phase).toBe("streaming");
    expect(client.events.find((event) => event.type === "caught-up")).toMatchObject({
      cursor: { stream: { messageId: "engine-B" } },
    });
  } finally {
    release.resolve();
    if (replacementOperation) coordinator.finishStartup(replacementOperation);
    await h.close();
  }
});

test("a constructed session reserves an existing engine before a lazy subscription is pulled", async () => {
  const h = await setup();
  const send = spyOn(h.session, "sendMessage").mockResolvedValue(Ok(undefined));
  try {
    const context = {
      workspaceService: { getOrCreateSession: () => h.session },
    } as unknown as ORPCContext;
    const subscription = subscribeWorkspaceChat(context, { workspaceId: h.workspaceId });
    expect(h.session.isBusy()).toBe(true);
    h.session.queueMessage("manual before first pull");
    h.session.drainQueuedMessagesIfIdle();
    expect(send).not.toHaveBeenCalled();
    h.setActive(false);
    h.emitter.emit("stream-end", {
      type: "stream-end",
      workspaceId: h.workspaceId,
      messageId: "engine-A",
      parts: [],
      metadata: {},
    });
    expect(send).toHaveBeenCalledTimes(1);
    await subscription.return(undefined);
  } finally {
    await h.close();
  }
});

test("a later observed engine is reserved before replay lifecycle listeners can submit input", async () => {
  const h = await setup(undefined, undefined, false);
  const send = spyOn(h.session, "sendMessage").mockResolvedValue(Ok(undefined));
  try {
    h.setActive(true);
    let busyAtFirstPublication: boolean | undefined;
    await h.session.replayHistory(({ message }) => {
      if (message.type === "stream-lifecycle" && busyAtFirstPublication === undefined) {
        busyAtFirstPublication = h.session.isBusy();
        h.session.queueMessage("reentrant manual");
        h.session.drainQueuedMessagesIfIdle();
      }
    });
    expect(busyAtFirstPublication).toBe(true);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
