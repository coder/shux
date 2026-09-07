import type { TurnCompletion } from "./streamManager";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import type { CompactionHandler } from "./compactionHandler";
import assert from "@/common/utils/assert";
import type { ContinuousPrefixSwap } from "./continuousCompactionJournal";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { summarizeContinuousCompaction } from "./continuousCompactionSummary";
import type { SessionUsageService } from "./sessionUsageService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import type { AgentSession } from "./agentSession";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import type { ContinuousCompactor } from "./continuousCompactor";

const workspaceId = "continuous-session";
const model = "openai:gpt-4o";
const sendOptions: SendMessageOptions = {
  model,
  agentId: "exec",
  experiments: { continuousCompaction: true },
};

interface SessionInternals {
  continuousCompactor: ContinuousCompactor;
  activeStreamContext?: {
    modelString: string;
    options?: SendMessageOptions;
    providersConfig: ProvidersConfigMap | null;
  };
  finishContinuousCompaction: (
    applied: boolean,
    context: NonNullable<SessionInternals["activeStreamContext"]>
  ) => Promise<void>;
  interruptForContinuousCompaction: (
    apply: (followUp?: CompactionFollowUpRequest) => Promise<boolean>
  ) => Promise<boolean>;
}

function internals(session: AgentSession): SessionInternals {
  return session as unknown as SessionInternals;
}

async function applyThenFinish(
  session: AgentSession,
  apply: (followUp?: CompactionFollowUpRequest) => Promise<boolean>
): Promise<boolean> {
  const state = internals(session);
  const context = state.activeStreamContext;
  if (!context) throw new Error("Expected active stream context");
  const applied = await state.interruptForContinuousCompaction(apply);
  await state.finishContinuousCompaction(applied, context);
  return applied;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentSession continuous compaction wiring", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
    mock.restore();
  });

  async function setup(usagePercent = 0) {
    harness = await createAgentSessionHarness({ workspaceId, captureEvents: true });
    harness.session.setAutoCompactionThreshold(0.7);
    if (usagePercent > 0) {
      await harness.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("old-user", "user", "Earlier work")
      );
      await harness.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("old-assistant", "assistant", "Earlier answer", {
          model,
          contextUsage: {
            inputTokens: usagePercent * 1_280,
            outputTokens: 1,
            totalTokens: usagePercent * 1_280 + 1,
          },
        })
      );
    }
    return harness;
  }

  async function rows(h: AgentSessionHarness): Promise<MuxMessage[]> {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data;
  }

  async function appendBoundary(
    h: AgentSessionHarness,
    pendingFollowUp?: CompactionFollowUpRequest
  ) {
    const result = await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("continuous-boundary", "assistant", "Summary of earlier work", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary", strategy: "continuous", pendingFollowUp },
      })
    );
    expect(result.success).toBe(true);
  }

  test.each([
    "startup",
    "disabled-terminal",
    "threshold-terminal",
    "disabled-usage-terminal",
    "terminal-error",
    "failed-consumed-apply",
  ] as const)("%s commits a consumed journal before retry or new work", async (mode) => {
    const h = await setup();
    const source = createMuxMessage("live-answer", "assistant", "", {
      partial: true,
      stepStartPartIndices: [0, 1, 2],
    });
    source.parts = [
      { type: "text", text: "completed investigation ".repeat(4_000) },
      {
        type: "dynamic-tool",
        toolCallId: "kept-tool",
        toolName: "bash",
        state: "output-available",
        input: { script: "pwd" },
        output: { success: true },
      },
      { type: "text", text: "still generating" },
    ];
    for (const row of [
      createMuxMessage("old-user", "user", "Earlier request"),
      createMuxMessage("old-answer", "assistant", "old context ".repeat(6_000)),
      createMuxMessage("new-user", "user", "Continue the task"),
      source,
    ]) {
      expect((await h.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    }
    const compactor = internals(h.session).continuousCompactor;
    const deps = Reflect.get(compactor, "deps") as ConstructorParameters<
      typeof ContinuousCompactor
    >[0];
    let streaming = true;
    let swap: ContinuousPrefixSwap | undefined;
    deps.streamManager = {
      isStreaming: () => streaming,
      getStreamInfo: () =>
        streaming
          ? {
              messageId: source.id,
              parts: source.parts,
              stepStartIndices: [0, 1, 2],
              currentStepStartIndex: 2,
            }
          : undefined,
      setPrefixSwap: (_id, value) => {
        swap = value;
        return true;
      },
      getPrefixSwapState: () => (streaming ? (swap?.consumed ? "consumed" : "pending") : "none"),
    };
    deps.prepare = () => Promise.resolve();
    deps.estimateAttachmentTokens = () => Promise.resolve(0);
    deps.summarize = () => Promise.resolve({ text: "Earlier work summarized", model });
    deps.prepareSwap = () =>
      Promise.resolve({
        preparation: {
          modelString: model,
          providerForMessages: "openai",
          effectiveAgentId: "exec",
          effectiveThinkingLevel: "off",
          toolNamesForSentinel: ["bash"],
        },
        attachments: [],
        systemPrefix: [],
        cacheEnabled: false,
      });
    const context = {
      enabled: true,
      model,
      thresholdPercent: 70,
      contextWindowTokens: 100_000,
      phase: "mid-stream" as const,
    };
    await compactor.observe(60, context);
    const job = Reflect.get(compactor, "job") as { done: Promise<void> };
    await job.done;
    expect(await compactor.observe(70, context)).toBe("none");
    assert(swap, "Expected pending swap");
    const store = h.historyService.getContinuousCompactionJournal(workspaceId);
    const journal = await store.write(swap.journal, swap.prefix, () => true);
    assert(journal, "Expected durable swap journal");
    swap.consumed = true;
    if (mode === "threshold-terminal") h.session.setAutoCompactionThreshold(1);
    if (mode === "disabled-terminal") compactor.reset("disabled");
    if (mode === "disabled-usage-terminal") {
      internals(h.session).activeStreamContext = {
        modelString: model,
        providersConfig: null,
        options: { ...sendOptions, experiments: { continuousCompaction: false } },
      };
      const observed = deferred<void>();
      const observe = compactor.observe.bind(compactor);
      spyOn(compactor, "observe").mockImplementation(async (...args) => {
        const result = await observe(...args);
        observed.resolve();
        return result;
      });
      h.aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: source.id,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      await observed.promise;
      expect(await store.read()).not.toBeNull();
      internals(h.session).activeStreamContext = undefined;
    }
    source.parts.push({ type: "text", text: "post-swap crash growth" });
    await h.historyService.writePartial(workspaceId, source);
    streaming = false;
    if (mode === "failed-consumed-apply") {
      Reflect.set(h.session, "continuousCompactionStopped", true);
      const reset = spyOn(compactor, "reset");
      await internals(h.session).finishContinuousCompaction(false, {
        modelString: model,
        options: sendOptions,
        providersConfig: null,
      });
      expect(reset).not.toHaveBeenCalled();
      expect(await store.read()).not.toBeNull();
      Reflect.set(h.session, "continuousCompactionStopped", false);
    }
    if (mode !== "startup") {
      const terminal = Reflect.get(h.session, "observeContinuousCompactionAtStreamEnd") as (
        model: string,
        options: SendMessageOptions
      ) => Promise<void>;
      const options = { ...sendOptions, experiments: { continuousCompaction: false } };
      if (mode === "terminal-error") {
        spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(() =>
          Promise.reject(new Error("temporary terminal history failure"))
        );
        await terminal.call(h.session, model, options);
        expect(await store.read()).not.toBeNull();
        expect(compactor.hasConsumedSwap()).toBe(true);
      }
      await terminal.call(h.session, model, options);
      await terminal.call(h.session, model, options);
      const history = await rows(h);
      expect(history[0].id).toBe(journal.boundary.id);
      expect(history.at(-1)?.parts).toEqual(source.parts.slice(journal.liveTailCopySpec.partIndex));
      expect(history.filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
      expect(await store.read()).toBeNull();
      return;
    }
    const order: string[] = [];
    const commit = h.historyService.commitPartial.bind(h.historyService);
    spyOn(h.historyService, "commitPartial").mockImplementation((id) => {
      order.push("commit");
      return commit(id);
    });
    const read = store.read.bind(store);
    spyOn(store, "read").mockImplementation(() => {
      order.push("journal");
      return read();
    });
    let retryChecks = 0;
    Reflect.set(h.session, "scheduleStartupAutoRetryIfNeeded", async () => {
      const history = await rows(h);
      expect(history[0].id).toBe(journal.boundary.id);
      expect(history.at(-1)?.parts).toEqual(source.parts.slice(journal.liveTailCopySpec.partIndex));
      retryChecks++;
      return "completed";
    });
    await h.session.runStartupRecovery();
    expect(order.slice(0, 2)).toEqual(["commit", "journal"]);
    expect(retryChecks).toBe(1);
    expect(await store.read()).toBeNull();
  });

  test("does not activate a prefix without the captured options required by fast-stop fallback", async () => {
    const h = await setup();
    internals(h.session).activeStreamContext = { modelString: model, providersConfig: null };
    const deps = Reflect.get(
      internals(h.session).continuousCompactor,
      "deps"
    ) as ConstructorParameters<typeof ContinuousCompactor>[0];
    assert(deps.prepareSwap !== undefined, "Expected session prefix preparation");
    expect(await deps.prepareSwap([])).toBeNull();
  });

  test("resumeless continuous fold cannot divert a later legacy compaction's saved follow-up", async () => {
    const h = await setup();
    const retained = createMuxMessage("retained-user", "user", "Earlier task");
    await h.historyService.appendToHistory(workspaceId, retained);
    const handler = Reflect.get(h.session, "compactionHandler") as CompactionHandler;
    expect(
      await handler.persistContinuousCompaction({
        messages: await rows(h),
        text: "Continuous summary",
        model,
        tail: [retained],
        systemMessageTokens: 0,
        attachmentTokens: 0,
        shouldPersist: () => true,
      })
    ).toBe(true);
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("legacy-request", "user", "Please compact", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: { text: "Current saved follow-up", model, agentId: "exec" } },
        },
      })
    );
    Reflect.set(h.session, "activeCompactionRequest", { id: "legacy-request", modelString: model });
    const completion = h.session.waitForPendingCompactionCompletionDecision("legacy-summary");
    void runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "legacy-summary",
      metadata: { model, agentId: "compact", finishReason: "stop" },
      parts: [{ type: "text", text: "Legacy summary" }],
    });
    expect(await completion).toBe(true);
    const current = await rows(h);
    expect(current.at(-1)?.role).toBe("user");
    expect(current.at(-1)?.parts).toMatchObject([
      { type: "text", text: "Current saved follow-up" },
    ]);
  });

  test("on-send apply preserves the new user turn without running a compact turn", async () => {
    const h = await setup(72);
    spyOn(internals(h.session).continuousCompactor, "observe").mockImplementation(
      async (_percent, context) => {
        expect(context.phase).toBe("on-send");
        await appendBoundary(h);
        return "applied";
      }
    );
    const result = await h.session.sendMessage("Keep going with the next task", sendOptions);
    expect(result.success).toBe(true);
    const history = await rows(h);
    expect(history[0].id).toBe("continuous-boundary");
    expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
      text: "Keep going with the next task",
    });
    expect(history.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
      false
    );
  });

  test.each([72, 76])(
    "without a staged summary on-send falls back only at force (%s%%)",
    async (percent) => {
      const h = await setup(percent);
      // Isolate trigger policy from model latency; the engine reports fallback only
      // when pressure reaches force, regardless of an in-flight background job.
      spyOn(internals(h.session).continuousCompactor, "observe").mockResolvedValue(
        percent >= 75 ? "fallback" : "none"
      );
      expect((await h.session.sendMessage("New work", sendOptions)).success).toBe(true);
      const history = await rows(h);
      const compactRequest = history.find(
        (row) => row.metadata?.muxMetadata?.type === "compaction-request"
      );
      expect(compactRequest !== undefined).toBe(percent >= 75);
      if (percent >= 75 && compactRequest?.metadata?.muxMetadata?.type === "compaction-request") {
        expect(compactRequest.metadata.muxMetadata.parsed.followUpContent?.text).toBe("New work");
      }
    }
  );

  test("explicit experiment disable wins over backend enable and keeps legacy on-send policy", async () => {
    const h = await setup(72);
    spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
      (id) => id === EXPERIMENT_IDS.CONTINUOUS_COMPACTION
    );
    const observe = spyOn(internals(h.session).continuousCompactor, "observe");
    expect(
      (
        await h.session.sendMessage("New work", {
          ...sendOptions,
          experiments: { continuousCompaction: false },
        })
      ).success
    ).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(
      (await rows(h)).some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(true);
  });

  test("threshold 100 disables both automatic strategies even above the context limit", async () => {
    const h = await setup(110);
    h.session.setAutoCompactionThreshold(1);
    const observe = spyOn(internals(h.session).continuousCompactor, "observe");
    expect((await h.session.sendMessage("New work", sendOptions)).success).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(
      (await rows(h)).some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(false);
  });

  test("resyncing an unchanged threshold preserves staged work", async () => {
    const h = await setup();
    const reset = spyOn(internals(h.session).continuousCompactor, "reset");
    h.session.setAutoCompactionThreshold(0.7);
    expect(reset).not.toHaveBeenCalled();
    h.session.setAutoCompactionThreshold(0.8);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  function startStream(h: AgentSessionHarness) {
    h.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: "live-assistant",
      model,
      historySequence: 1,
      startTime: Date.now(),
    });
  }

  function endStream(h: AgentSessionHarness) {
    void runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "live-assistant",
      parts: [],
      metadata: {
        model,
        contextUsage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
      },
    });
  }

  test("terminal apply runs after stream reset and before queued sends", async () => {
    const h = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const queuedStarted = deferred<void>();
    let starts = 0;
    spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      starts++;
      startStream(h);
      if (starts === 2) queuedStarted.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
    });
    spyOn(internals(h.session).continuousCompactor, "observe").mockImplementation(
      async (_percent, context) => {
        if (context.phase !== "stream-end") return "none";
        expect(internals(h.session).activeStreamContext).toBeUndefined();
        entered.resolve();
        await release.promise;
        await appendBoundary(h);
        return "applied";
      }
    );
    expect((await h.session.sendMessage("First", sendOptions)).success).toBe(true);
    h.session.queueMessage("Queued", sendOptions);
    endStream(h);
    await entered.promise;
    expect(starts).toBe(1);
    release.resolve();
    await queuedStarted.promise;
    const history = await rows(h);
    expect(history[0].id).toBe("continuous-boundary");
    expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
      text: "Queued",
    });
  });

  test("invalidation contains an initial wait rejection and safely stops the blocked stream", async () => {
    const h = await setup();
    const compactor = internals(h.session).continuousCompactor;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    let streaming = true;
    internals(h.session).activeStreamContext = {
      modelString: model,
      options: sendOptions,
      providersConfig: null,
    };
    spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
    spyOn(h.aiService, "getStreamInfo").mockReturnValue({
      messageId: "live-assistant",
      parts: [],
      toolCompletionTimestamps: new Map(),
    });
    Reflect.set(Reflect.get(h.session, "streamManager"), "getPrefixSwapState", () => "invalidated");
    spyOn(compactor, "waitForIdle").mockImplementationOnce(() =>
      Promise.reject(new Error("apply wait failed"))
    );
    const reset = spyOn(compactor, "reset");
    const drain = spyOn(h.session, "drainQueuedMessagesIfIdle");
    const stop = spyOn(h.aiService, "stopStream").mockImplementation((_id, options) => {
      expect(options?.abortReason).toBe("system");
      streaming = false;
      void runSessionTerminalPolicy(h.session, h.aiEmitter, {
        type: "stream-abort",
        workspaceId,
        messageId: "live-assistant",
        abortReason: "system",
      });
      return Promise.resolve(Ok(undefined));
    });
    try {
      startStream(h);
      h.aiEmitter.emit("prefix-swap-invalidated", {
        type: "prefix-swap-invalidated",
        workspaceId,
        messageId: "live-assistant",
      });
      await h.session.waitForIdle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(reset).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      expect(h.session.isBusy()).toBe(false);
    } finally {
      stop.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("duplicate invalidations wait for the owner and never clear another observation's flags", async () => {
    const h = await setup();
    let streaming = true;
    internals(h.session).activeStreamContext = {
      modelString: model,
      options: sendOptions,
      providersConfig: null,
    };
    spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
    spyOn(h.aiService, "getStreamInfo").mockReturnValue({
      messageId: "live-assistant",
      parts: [],
      toolCompletionTimestamps: new Map(),
    });
    const release = deferred<void>();
    const invoked = deferred<void>();
    const drain = spyOn(h.session, "drainQueuedMessagesIfIdle").mockImplementation(() => undefined);
    const run = Reflect.get(h.session, "runContinuousCompactionObservation") as (
      observe: () => Promise<void>
    ) => Promise<void>;
    const first = run.call(h.session, async () => {
      Reflect.set(h.session, "midStreamCompactionPending", true);
      await release.promise;
    });
    const observe = spyOn(internals(h.session).continuousCompactor, "observe").mockImplementation(
      () => {
        streaming = false;
        internals(h.session).activeStreamContext = undefined;
        invoked.resolve();
        return Promise.resolve("none");
      }
    );
    const event = { type: "prefix-swap-invalidated", workspaceId, messageId: "live-assistant" };
    h.aiEmitter.emit("prefix-swap-invalidated", event);
    h.aiEmitter.emit("prefix-swap-invalidated", event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Reflect.get(h.session, "continuousCompactionObserving")).toBe(true);
    expect(Reflect.get(h.session, "midStreamCompactionPending")).toBe(true);
    expect(drain).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    release.resolve();
    await first;
    await invoked.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(Reflect.get(h.session, "continuousCompactionObserving")).toBe(false);
    expect(Reflect.get(h.session, "midStreamCompactionPending")).toBe(false);
  });

  test.each(["usage-delta", "prefix-swap-invalidated"] as const)(
    "%s contains a follow-up history read rejection and preserves durable retry",
    async (eventType) => {
      const h = await setup();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      process.on("unhandledRejection", onUnhandled);
      const drained = deferred<void>();
      const failedRead = deferred<void>();
      let watching = false;
      spyOn(h.session, "drainQueuedMessagesIfIdle").mockImplementation(() => {
        if (watching) drained.resolve();
      });
      let streaming = false;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        streaming = true;
        startStream(h);
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      const stop = spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        streaming = false;
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("live-assistant", "assistant", "Committed partial")
        );
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Ok(undefined);
      });
      let failRead = false;
      const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementation((id) => {
        if (failRead) {
          failRead = false;
          failedRead.resolve();
          return Promise.reject(new Error("transient follow-up history read"));
        }
        return read(id);
      });
      const handler = Reflect.get(h.session, "compactionHandler") as CompactionHandler;
      spyOn(internals(h.session).continuousCompactor, "observe").mockImplementation(
        async (_usage, context) => {
          if (context.phase !== "mid-stream") return "none";
          const applied = await internals(h.session).interruptForContinuousCompaction(
            async (followUp) => {
              const history = await rows(h);
              const applied = await handler.persistContinuousCompaction({
                messages: history,
                text: "Recovered summary",
                model,
                tail: history.slice(-1),
                pendingFollowUp: followUp,
                systemMessageTokens: 0,
                attachmentTokens: 0,
                shouldPersist: () => true,
              });
              failRead = true;
              return applied;
            }
          );
          return applied ? "applied" : "none";
        }
      );
      try {
        expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
        spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
        spyOn(h.aiService, "getStreamInfo").mockReturnValue({
          messageId: "live-assistant",
          parts: [],
          toolCompletionTimestamps: new Map(),
        });
        watching = true;
        h.aiEmitter.emit(eventType, {
          type: eventType,
          workspaceId,
          messageId: "live-assistant",
          usage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
        });
        await failedRead.promise;
        await drained.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(h.session.isBusy()).toBe(false);
        expect(Reflect.get(h.session, "continuousCompactionObserving")).toBe(false);
        expect(Reflect.get(h.session, "midStreamCompactionPending")).toBe(false);
        const boundary = (await rows(h))[0];
        expect(Reflect.get(h.session, "pendingCompactionFollowUpSummaryId")).toBe(boundary.id);
        expect(boundary.metadata?.muxMetadata?.type).toBe("compaction-summary");
        expect(
          boundary.metadata?.muxMetadata?.type === "compaction-summary" &&
            boundary.metadata.muxMetadata.pendingFollowUp?.text
        ).toBe("Continue");
        expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded(boundary.id)).toBe(true);
        expect((await rows(h)).at(-1)?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
      } finally {
        stop.mockRestore();
        process.off("unhandledRejection", onUnhandled);
      }
    }
  );

  test.each(["usage-delta", "prefix-swap-invalidated"] as const)(
    "%s fast apply commits after system stop then resumes without a compact turn or latch recursion",
    async (eventType) => {
      const h = await setup();
      const resumed = deferred<void>();
      const settled = deferred<void>();
      const order: string[] = [];
      let starts = 0;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        starts++;
        startStream(h);
        if (starts === 2) {
          order.push("resume");
          resumed.resolve();
        }
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      spyOn(h.aiService, "stopStream").mockImplementation(async (_id, options) => {
        if (eventType === "prefix-swap-invalidated")
          spyOn(h.aiService, "isStreaming").mockReturnValue(false);
        expect(options?.abortReason).toBe("system");
        order.push("stop");
        const result = await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("live-assistant", "assistant", "Committed partial")
        );
        expect(result.success).toBe(true);
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Ok(undefined);
      });
      let observedMidstream = false;
      let applying = false;
      spyOn(internals(h.session).continuousCompactor, "isApplying").mockImplementation(
        () => applying
      );
      spyOn(internals(h.session).continuousCompactor, "observe").mockImplementation(
        async (_percent, context) => {
          // Resumed on-send observation is allowed, but only after the mid-stream
          // apply latch has been released.
          expect(applying).toBe(false);
          if (context.phase !== "mid-stream") return "none";
          expect(observedMidstream).toBe(false);
          observedMidstream = true;
          applying = true;
          const applied = await internals(h.session).interruptForContinuousCompaction(
            async (followUp) => {
              expect(h.session.isBusy()).toBe(false);
              expect(internals(h.session).activeStreamContext).toBeUndefined();
              expect((await rows(h)).at(-1)?.id).toBe("live-assistant");
              expect(followUp).toMatchObject({
                text: "Continue",
                model,
                goalKind: GOAL_CONTINUATION_KIND,
                goalId: "11111111-1111-4111-8111-111111111111",
                dispatchOptions: { source: "internal-resume" },
              });
              order.push("apply");
              // Idle waiters (monitor wakes) must stay parked until the continuation is sent.
              void h.session.waitForMidStreamCompactionSettled().then(() => {
                order.push("settled");
                settled.resolve();
              });
              await appendBoundary(h, followUp);
              return true;
            }
          );
          expect(starts).toBe(1);
          applying = false;
          order.push("latch-released");
          return applied ? "applied" : "none";
        }
      );
      expect(
        (
          await h.session.sendMessage("Working", sendOptions, {
            synthetic: true,
            agentInitiated: true,
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: "11111111-1111-4111-8111-111111111111",
          })
        ).success
      ).toBe(true);
      const observationFinished = deferred<void>();
      if (eventType === "prefix-swap-invalidated") {
        spyOn(h.aiService, "isStreaming").mockReturnValue(true);
        spyOn(h.aiService, "getStreamInfo").mockReturnValue({
          messageId: "live-assistant",
          parts: [],
          toolCompletionTimestamps: new Map(),
        });
        spyOn(internals(h.session).continuousCompactor, "waitForIdle").mockReturnValueOnce(
          observationFinished.promise
        );
        Reflect.set(h.session, "continuousCompactionObserving", true);
      }
      h.aiEmitter.emit(eventType, {
        type: eventType,
        workspaceId,
        messageId: "live-assistant",
        usage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
      });
      if (eventType === "prefix-swap-invalidated") {
        expect(order).toEqual([]);
        Reflect.set(h.session, "continuousCompactionObserving", false);
        observationFinished.resolve();
      }
      await resumed.promise;
      await settled.promise;
      expect(order).toEqual(["stop", "apply", "latch-released", "resume", "settled"]);
      const history = await rows(h);
      expect(history.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
        false
      );
      expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
        text: "Continue",
      });
      // Disposal's stop is intentionally not the fast-apply stop under test.
      mock.restore();
    }
  );

  test.each([72, 76])(
    "a failed post-stop apply recovers the interrupted turn at %s%%",
    async (percent) => {
      const h = await setup(percent);
      spyOn(internals(h.session).continuousCompactor, "observe").mockResolvedValue("none");
      let starts = 0;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        starts++;
        startStream(h);
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      spyOn(h.aiService, "stopStream").mockImplementation(() => {
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Promise.resolve(Ok(undefined));
      });
      expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
      expect(await applyThenFinish(h.session, () => Promise.resolve(false))).toBe(false);
      expect(starts).toBe(2);
      const history = await rows(h);
      expect(history.at(-1)?.metadata?.muxMetadata?.type === "compaction-request").toBe(
        percent >= 75
      );
      if (percent < 75)
        expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
          text: "Continue",
        });
      mock.restore();
    }
  );

  // These callbacks interrupt an already-started turn, so model the engine's
  // completion handle rather than invoking terminal policy without settling it.
  function mockAbortableStream(h: AgentSessionHarness) {
    let completion: ReturnType<typeof Promise.withResolvers<TurnCompletion>> | undefined;
    const streamMessage = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      completion = Promise.withResolvers<TurnCompletion>();
      startStream(h);
      return Promise.resolve(Ok({ messageId: "live-assistant", completion: completion.promise }));
    });
    spyOn(h.aiService, "stopStream").mockImplementation((_id, options) => {
      const streamAbort = {
        type: "stream-abort" as const,
        workspaceId,
        messageId: completion ? "live-assistant" : "",
        abortReason: options?.abortReason,
      };
      h.aiEmitter.emit("stream-abort", streamAbort);
      completion?.resolve({
        status: "aborted",
        abortReason: options?.abortReason ?? "system",
        streamAbort,
      });
      completion = undefined;
      return Promise.resolve(Ok(undefined));
    });
    return streamMessage;
  }

  test("abandon during fast apply cannot resume the abandoned turn", async () => {
    const h = await setup();
    spyOn(internals(h.session).continuousCompactor, "observe").mockResolvedValue("none");
    const streamMessage = mockAbortableStream(h);
    expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
    const applied = await applyThenFinish(h.session, async () => {
      await h.session.interruptStream({ abandonPartial: true });
      return false;
    });
    expect(applied).toBe(false);
    expect(streamMessage).toHaveBeenCalledTimes(1);
    mock.restore();
  });

  test("abandon after the boundary commit preserves the fold but clears durable resume intent", async () => {
    const h = await setup();
    spyOn(internals(h.session).continuousCompactor, "observe").mockResolvedValue("none");
    const streamMessage = mockAbortableStream(h);
    expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
    const applied = await applyThenFinish(h.session, async (followUp) => {
      await appendBoundary(h, followUp);
      await h.session.interruptStream({ abandonPartial: true });
      return true;
    });
    expect(applied).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);
    const history = await rows(h);
    expect(history[0].id).toBe("continuous-boundary");
    expect(history[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
    mock.restore();
  });

  test.each(["manual", "idle", "fallback"] as const)(
    "%s compaction requests invalidate staged automatic work",
    async (source) => {
      const h = await setup();
      const reset = spyOn(internals(h.session).continuousCompactor, "reset");
      expect(
        (
          await h.session.sendMessage("Summarize", {
            ...sendOptions,
            agentId: "compact",
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {},
              ...(source !== "manual"
                ? { source: source === "idle" ? "idle-compaction" : "auto-compaction" }
                : {}),
            },
          })
        ).success
      ).toBe(true);
      expect(reset).toHaveBeenCalled();
      reset.mockClear();
    }
  );

  async function summarySetup() {
    const h = await setup();
    spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: workspaceId,
        name: workspaceId,
        projectName: "continuous-test",
        projectPath: h.config.rootDir,
        runtimeConfig: { type: "local" },
      })
    );
    return {
      h,
      args: {
        workspaceId,
        config: h.config,
        aiService: h.aiService,
        head: [
          createMuxMessage("head", "user", "Preserve the root cause and the failed approaches"),
        ],
        signal: new AbortController().signal,
        context: { enabled: true, model, contextWindowTokens: 128_000, thresholdPercent: 70 },
        baseOptions: sendOptions,
        compactOptions: { ...sendOptions, model: "openai:gpt-4.1-mini", agentId: "compact" },
      },
    };
  }

  function modelChunks(): LanguageModelV3StreamPart[] {
    return [
      { type: "text-start", id: "summary" },
      {
        type: "text-delta",
        id: "summary",
        delta: "The root cause was found; avoid retrying the failed approach.",
      },
      { type: "text-end", id: "summary" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
      },
    ];
  }

  test("headless summaries use the compact model and account usage with its pinned identity", async () => {
    const { h, args } = await summarySetup();
    args.head.push(
      createMuxMessage("display-only", "user", "UI-only summarizer bait", {
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/flow",
          commandPrefix: "/flow",
          runId: "wfr_test",
        },
      }),
      createMuxMessage("interrupted-head", "assistant", "unfinished investigation", {
        partial: true,
      }),
      createMuxMessage("later-head", "assistant", "later investigation")
    );
    const requests: LanguageModelV3CallOptions[] = [];
    const sdkModel = new MockLanguageModelV3({
      doStream: (request) => {
        requests.push(request);
        return Promise.resolve({ stream: simulateReadableStream({ chunks: modelChunks() }) });
      },
    });
    const create = spyOn(h.aiService, "createModelWithPinnedMetadata").mockResolvedValue(
      Ok({ model: sdkModel, metadataModel: "openai:gpt-4.1" })
    );
    const record = mock<SessionUsageService["recordHeadlessUsage"]>(() =>
      Promise.resolve(undefined)
    );
    const result = await summarizeContinuousCompaction({
      ...args,
      sessionUsageService: { recordHeadlessUsage: record },
    });
    expect(create.mock.calls[0]?.[0]).toBe(args.compactOptions.model);
    expect(result?.model).toBe(args.compactOptions.model);
    expect(requests[0].tools ?? []).toHaveLength(0);
    expect(JSON.stringify(requests[0].prompt)).not.toContain("UI-only summarizer bait");
    const interruptedIndex = requests[0].prompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) => part.type === "text" && part.text === "unfinished investigation"
        )
    );
    expect(interruptedIndex).toBeGreaterThan(-1);
    expect(requests[0].prompt[interruptedIndex + 1].role).toBe("user");
    expect(requests[0].prompt[interruptedIndex + 2].role).toBe("assistant");
    expect(
      requests[0].prompt.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text.includes("Preserve the root cause")
          )
      )
    ).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toBe(args.compactOptions.model);
    expect(record.mock.calls[0]?.[2]?.inputTokens).toBe(50);
    expect(record.mock.calls[0]?.[4]?.metadataModel).toBe("openai:gpt-4.1");
    expect(await rows(h)).toHaveLength(0);
  });

  test("a compact model too small for the head falls back to the configured parent route without truncating", async () => {
    const { h, args } = await summarySetup();
    spyOn(h.aiService, "getProvidersConfig").mockReturnValue({
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "gpt-4.1-mini", contextWindowTokens: 1_000 }],
      },
    });
    const sdkModel = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({ stream: simulateReadableStream({ chunks: modelChunks() }) }),
    });
    const create = spyOn(h.aiService, "createModelWithPinnedMetadata").mockResolvedValue(
      Ok({ model: sdkModel, metadataModel: model })
    );
    const result = await summarizeContinuousCompaction({
      ...args,
      head: [createMuxMessage("large-head", "user", "Important context to retain. ".repeat(1_000))],
    });
    expect(create.mock.calls[0]?.[0]).toBe(model);
    expect(result?.model).toBe(model);
  });

  test("returns null without calling a model when neither configured context can fit the head", async () => {
    const { h, args } = await summarySetup();
    spyOn(h.aiService, "getProvidersConfig").mockReturnValue({
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "gpt-4.1-mini", contextWindowTokens: 100 }],
      },
    });
    const create = spyOn(h.aiService, "createModelWithPinnedMetadata");
    const result = await summarizeContinuousCompaction({
      ...args,
      context: { ...args.context, contextWindowTokens: 100 },
      head: [createMuxMessage("oversize", "user", "Important evidence. ".repeat(1_000))],
    });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test("reset cancellation actively cancels a stalled headless provider", async () => {
    const { h, args } = await summarySetup();
    const entered = deferred<void>();
    const cancelled = deferred<void>();
    const controller = new AbortController();
    const sdkModel = new MockLanguageModelV3({
      doStream: () => {
        entered.resolve();
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            cancel: () => {
              cancelled.resolve();
            },
          }),
        });
      },
    });
    spyOn(h.aiService, "createModelWithPinnedMetadata").mockResolvedValue(
      Ok({ model: sdkModel, metadataModel: model })
    );
    const result = summarizeContinuousCompaction({ ...args, signal: controller.signal }).catch(
      (error: unknown) => error
    );
    await entered.promise;
    controller.abort();
    await cancelled.promise;
    expect(await result).toBeInstanceOf(Error);
  });

  test("context mutations and teardown synchronously invalidate staged work", async () => {
    const h = await setup();
    const reset = spyOn(internals(h.session).continuousCompactor, "reset");
    using _admission = h.session.holdTurnAdmission();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    await h.session.discardAutoRetryForContextMutation();
    await h.session.interruptStream({ abandonPartial: true });
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    h.session.beginShutdown();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    h.session.beginDispose();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
  });
});
