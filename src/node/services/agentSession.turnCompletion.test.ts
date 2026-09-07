import type { TurnCoordinator } from "./turnCoordinator";
import { createMuxMessage } from "@/common/types/message";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Exit, Scope } from "effect";
import { defaultEffectRunner as runner } from "./di/effectRunner";
import { log } from "./log";
import { EventEmitter } from "events";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { Err, Ok } from "@/common/types/result";
import type { StreamMessageOptions } from "./turnRequestBuilder";
import type { TurnCompletion } from "./streamManager";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { AgentSession } from "./agentSession";
import { createStartedTurnHandle, createAgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "session-completion";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };

interface InternalSession {
  lastSystemMessageTokens?: number;
  activeCompactionRequest?: { id: string; modelString: string };
  clearStartupAutoRetryAbandon(): Promise<void>;
  recordGoalAccountingFromUsage(input: unknown): Promise<void>;
  updateStartupAutoRetryAbandonFromAbort(...args: unknown[]): Promise<void>;
  observeContinuousCompactionAtStreamEnd(...args: unknown[]): Promise<void>;
  coordinator: TurnCoordinator;
  getEditTruncateTargetId(messageId: string): Promise<string>;
}
const internal = (session: AgentSession) => session as unknown as InternalSession;
const end = (messageId = "assistant-1"): StreamEndEvent => ({
  type: "stream-end",
  workspaceId,
  messageId,
  metadata: { model },
  parts: [{ type: "text", text: "Finished answer" }],
});
const abort = (messageId = "assistant-1"): StreamAbortEvent => ({
  type: "stream-abort",
  workspaceId,
  messageId,
  abortReason: "user",
});
function start(emitter: EventEmitter, messageId = "assistant-1") {
  emitter.emit("stream-start", {
    type: "stream-start",
    workspaceId,
    messageId,
    model,
    startTime: Date.now(),
  });
}

// Observe the already-detached consumer promise without introducing a second policy path.
function policyPromise(spy: ReturnType<typeof observePolicy>): Promise<void> {
  const result = spy.mock.results.at(-1);
  if (result?.type !== "return") throw new Error("No completion consumer registered");
  return result.value;
}
function observePolicy(session: AgentSession) {
  return spyOn(internal(session).coordinator, "consumeCompletion");
}

describe("AgentSession turn completion", () => {
  test("late abort bookkeeping failure preserves output in the renderer lifecycle", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    const bookkeeping = spyOn(
      internal(h.session),
      "updateStartupAutoRetryAbandonFromAbort"
    ).mockRejectedValueOnce(new Error("late bookkeeping failure"));
    try {
      await h.session.sendMessage("original", sendOptions);
      emitter.emit("stream-delta", {
        type: "stream-delta",
        workspaceId,
        messageId: "assistant-1",
        delta: "Visible partial output",
        tokens: 3,
        timestamp: Date.now(),
      });
      completion.resolve({ status: "aborted", abortReason: "user", streamAbort: abort() });
      await policyPromise(consumer);
      expect(bookkeeping).toHaveBeenCalledTimes(1);
      expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
      expect(h.events.filter((event) => event.type === "stream-lifecycle").at(-1)).toMatchObject({
        phase: "interrupted",
        hadAnyOutput: true,
        abortReason: "user",
      });
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("abort failure finalization cannot finish a replacement admitted by its renderer event", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    const coordinator = internal(h.session).coordinator;
    const replacementThinking = {};
    let replacement: symbol | undefined;
    let aborted = 0;
    h.session.onChatEvent(({ message }) => {
      if (message.type !== "stream-abort") return;
      aborted++;
      const admission = coordinator.prepare({
        kind: "fresh",
        intent: "handoff",
        expectedTurnId: coordinator.turnId,
      });
      if (admission.status !== "admitted") throw new Error("Expected replacement admission");
      replacement = admission.turnId;
      coordinator.acceptThinkingOverride(replacementThinking, replacement);
    });
    try {
      await h.session.sendMessage("original", sendOptions);
      Reflect.set(h.session, "workspaceGoalService", {
        recordUserStoppedStream: mock(() => Promise.reject(new Error("accounting failed"))),
      } satisfies Partial<WorkspaceGoalService>);
      completion.resolve({ status: "aborted", abortReason: "user", streamAbort: abort() });
      await policyPromise(consumer);
      expect(aborted).toBe(1);
      if (replacement == null) throw new Error("Renderer did not admit the replacement");
      expect(coordinator.turnId).toBe(replacement);
      expect(coordinator.phase).toBe("preparing");
      expect(coordinator.thinkingOverride).toBe(replacementThinking);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("failed abort accounting releases a waiting edit before app shutdown drains", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const completion = Promise.withResolvers<TurnCompletion>();
    const accountingEntered = Promise.withResolvers<void>();
    const releaseAccounting = Promise.withResolvers<void>();
    const editWaiting = Promise.withResolvers<void>();
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      appFiberScope,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    const accountingError = new Error("abort accounting failed");
    const recordUserStoppedStream = mock(async () => {
      accountingEntered.resolve();
      await releaseAccounting.promise;
      throw accountingError;
    });
    const errorLog = spyOn(log, "error");
    const coordinator = internal(h.session).coordinator;
    const waitForIdle = coordinator.waitForIdle.bind(coordinator);
    spyOn(coordinator, "waitForIdle").mockImplementation((signal) => {
      editWaiting.resolve();
      return waitForIdle(signal);
    });
    let edit: ReturnType<AgentSession["sendMessage"]> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await h.session.sendMessage("original", sendOptions);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const user = history.data.find((message) => message.role === "user")!;
      Reflect.set(h.session, "workspaceGoalService", {
        recordUserStoppedStream,
        assertPricedModelForBudgetedGoal: () => Promise.resolve(Ok(undefined)),
      } satisfies Partial<WorkspaceGoalService>);
      emitter.emit("stream-abort", abort());
      completion.resolve({ status: "aborted", abortReason: "user", streamAbort: abort() });
      await accountingEntered.promise;
      edit = h.session.sendMessage("edited", { ...sendOptions, editMessageId: user.id });
      await editWaiting.promise;
      closing = runner.runPromise(Scope.close(appFiberScope, Exit.void));
      releaseAccounting.resolve();
      await policyPromise(consumer);
      // This used to remain COMPLETING forever: the edit lease waited for idle while the
      // guardian waited for that lease before closing the idle-waiter resource scope.
      expect(coordinator.phase).toBe("idle");
      expect((await edit).success).toBe(false);
      await closing;
      expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
      expect(spyOn(h.aiService, "streamMessage")).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith("Failed to consume turn completion", {
        workspaceId,
        error: accountingError.message,
      });
    } finally {
      releaseAccounting.resolve();
      await h.session.dispose();
      await edit;
      await closing;
      errorLog.mockRestore();
      await h.cleanup();
    }
  });

  test("raw success defers policy; completion uses handle identity and runs policy once", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    const handle = { messageId: "assistant-1", completion: completion.promise };
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok(handle));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    try {
      expect((await h.session.sendMessage("hello", sendOptions)).success).toBe(true);
      emitter.emit("stream-end", end());
      expect(h.session.isBusy()).toBe(true);
      expect(h.events.filter((event) => event.type === "stream-end")).toHaveLength(0);
      const operation = internal(h.session).coordinator.operationId!;
      // Even a malformed producer's redundant event ID cannot override handle identity.
      completion.resolve({ status: "completed", streamEnd: end("wrong-id") });
      await policyPromise(consumer);
      await internal(h.session).coordinator.consumeCompletion(operation, handle);
      emitter.emit("stream-end", end());
      expect(h.events.filter((event) => event.type === "stream-end")).toMatchObject([
        { messageId: handle.messageId },
      ]);
      expect(h.session.isBusy()).toBe(false);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test.each([false, true])(
    "delivered abort with started=%s applies the matching policy once",
    async (started) => {
      const envelopeEntered = Promise.withResolvers<void>();
      const releaseEnvelope = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<TurnCompletion>();
      const emitter = new EventEmitter();
      const recordUserStoppedStream = mock(() => Promise.resolve());
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          streamMessage: mock(async (opts: StreamMessageOptions) => {
            opts.onStreamStarting?.("starting-1");
            if (started) start(emitter);
            envelopeEntered.resolve();
            await releaseEnvelope.promise;
            return Ok({ messageId: "assistant-1", completion: completion.promise });
          }),
        },
      });
      const consumer = observePolicy(h.session);
      const accounting = spyOn(internal(h.session), "recordGoalAccountingFromUsage");
      const compaction = spyOn(internal(h.session), "observeContinuousCompactionAtStreamEnd");
      const send = h.session.sendMessage("hello", sendOptions);
      try {
        await envelopeEntered.promise;
        Reflect.set(h.session, "workspaceGoalService", {
          recordUserStoppedStream,
          recordStreamAccounting: mock(() => Promise.resolve(null)),
        } satisfies Partial<WorkspaceGoalService>);
        emitter.emit("stream-abort", abort());
        expect(recordUserStoppedStream).not.toHaveBeenCalled();
        expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(0);
        completion.resolve({
          status: "aborted",
          abortReason: "user",
          streamAbort: abort(),
          systemMessageTokens: 417,
        });
        releaseEnvelope.resolve();
        await send;
        await policyPromise(consumer);
        expect(recordUserStoppedStream).toHaveBeenCalledTimes(1);
        expect(accounting).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(compaction).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(internal(h.session).lastSystemMessageTokens).toBe(started ? 417 : undefined);
        expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
        expect(h.session.isBusy()).toBe(false);
      } finally {
        releaseEnvelope.resolve();
        await send;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["stream-end", "stream-abort"] as const)(
    "edit from raw %s waits for delivered completion without interrupting again",
    async (terminal) => {
      const completion = Promise.withResolvers<TurnCompletion>();
      const replacementStarted = Promise.withResolvers<void>();
      const emitter = new EventEmitter();
      let calls = 0;
      const stopStream = mock(() => {
        // The engine registry has already been cleared by the raw terminal.
        emitter.emit("stream-abort", abort(""));
        return Promise.resolve(Ok(undefined));
      });
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          stopStream,
          streamMessage: mock(() => {
            const messageId = `assistant-${++calls}`;
            start(emitter, messageId);
            if (calls === 2) replacementStarted.resolve();
            return Promise.resolve(
              Ok({
                messageId,
                completion:
                  calls === 1
                    ? completion.promise
                    : createStartedTurnHandle(h.session.closingSignal).completion,
              })
            );
          }),
        },
      });
      const consumer = observePolicy(h.session);
      const accounting = spyOn(internal(h.session), "recordGoalAccountingFromUsage");
      const editAdmissionEntered = Promise.withResolvers<void>();
      const interruptStream = h.session.interruptStream.bind(h.session);
      const interrupt = spyOn(h.session, "interruptStream").mockImplementation((options) => {
        editAdmissionEntered.resolve();
        return interruptStream(options);
      });
      const waitForIdle = h.session.waitForIdle.bind(h.session);
      spyOn(h.session, "waitForIdle").mockImplementation((signal) => {
        editAdmissionEntered.resolve();
        return waitForIdle(signal);
      });
      const payload = { ...abort(), abortReason: "system" as const };
      const outcome: TurnCompletion =
        terminal === "stream-end"
          ? { status: "completed", streamEnd: end() }
          : { status: "aborted", abortReason: "system", streamAbort: payload };
      let edit: ReturnType<AgentSession["sendMessage"]> | undefined;
      try {
        await h.session.sendMessage("original", sendOptions);
        const firstPolicy = policyPromise(consumer);
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const userId = history.data.find((message) => message.role === "user")!.id;
        emitter.once(terminal, () => {
          edit = h.session.sendMessage("edited", { ...sendOptions, editMessageId: userId });
        });
        emitter.emit(terminal, terminal === "stream-end" ? end() : payload);
        // Observe the actual edit admission branch after its asynchronous history reads.
        await editAdmissionEntered.promise;
        expect(edit).toBeDefined();
        expect(interrupt).not.toHaveBeenCalled();
        expect(stopStream).not.toHaveBeenCalled();
        expect(accounting).not.toHaveBeenCalled();
        expect(calls).toBe(1);
        expect(h.session.isBusy()).toBe(true);
        completion.resolve(outcome);
        await firstPolicy;
        expect((await edit)?.success).toBe(true);
        await replacementStarted.promise;
        expect(calls).toBe(2);
        expect(h.session.isBusy()).toBe(true);
        expect(h.events.filter((event) => event.type === terminal)).toHaveLength(1);
        expect(
          h.events.filter((event) => event.type === "stream-abort" && event.abortReason === "user")
        ).toHaveLength(0);
      } finally {
        completion.resolve(outcome);
        await edit;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["user", "system"] as const)(
    "startup %s cancellation handle does not duplicate its delayed notification",
    async (reason) => {
      const emitter = new EventEmitter();
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          streamMessage: mock((opts: StreamMessageOptions) => {
            opts.onStreamStarting?.("starting-1");
            return Promise.resolve(
              Ok({
                messageId: "starting-1",
                completion: Promise.resolve<TurnCompletion>({
                  status: "aborted",
                  abortReason: reason,
                }),
              })
            );
          }),
        },
      });
      const consumer = observePolicy(h.session);
      try {
        await h.session.sendMessage("hello", sendOptions);
        await policyPromise(consumer);
        const received = Promise.withResolvers<void>();
        h.session.onChatEvent(({ message }) => {
          if (message.type === "stream-abort") received.resolve();
        });
        const payload = { ...abort("starting-1"), abortReason: reason };
        emitter.emit("stream-abort", payload);
        await received.promise;
        emitter.emit("stream-abort", payload);
        expect(h.events.filter((event) => event.type === "stream-abort")).toMatchObject([
          { abortReason: reason },
        ]);
      } finally {
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test("budget recovery paused in history cannot reset or reject a replacement turn", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    let calls = 0;
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++calls}`;
          start(emitter, messageId);
          return Promise.resolve(
            Ok({
              messageId,
              completion:
                calls === 1
                  ? completion.promise
                  : createStartedTurnHandle(h.session.closingSignal).completion,
            })
          );
        }),
      },
    });
    const consumer = observePolicy(h.session);
    const reset = spyOn(
      h.session as unknown as { applyContextResetSideEffects(): Promise<void> },
      "applyContextResetSideEffects"
    );
    const historyEntered = Promise.withResolvers<void>();
    const releaseHistory = Promise.withResolvers<void>();
    let oldPolicy: Promise<void> | undefined;
    try {
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "assistant", "Earlier completed work")
      );
      const options = { ...sendOptions, experiments: { tokenBudget: true } };
      expect((await h.session.sendMessage("original request", options)).success).toBe(true);
      oldPolicy = policyPromise(consumer);
      const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(async (id) => {
        historyEntered.resolve();
        await releaseHistory.promise;
        return read(id);
      });
      completion.resolve({
        status: "failed",
        streamError: {
          messageId: "assistant-1",
          error: "context overflow",
          errorType: "context_exceeded",
        },
      });
      await historyEntered.promise;
      const coordinator = internal(h.session).coordinator;
      const originalOperation = coordinator.operationId;
      coordinator.finishTurn(coordinator.turnId);
      expect((await h.session.sendMessage("replacement request", options)).success).toBe(true);
      const replacementOperation = coordinator.operationId;
      expect(replacementOperation).toBeDefined();
      expect(replacementOperation).not.toBe(originalOperation);
      releaseHistory.resolve();
      await oldPolicy;
      expect(calls).toBe(2);
      expect(reset).not.toHaveBeenCalled();
      expect(coordinator.operationId).toBe(replacementOperation);
      expect(coordinator.phase).toBe("streaming");
      const rows = await read(workspaceId);
      expect(rows.success).toBe(true);
      if (!rows.success) throw new Error(rows.error);
      expect(rows.data.some((row) => row.metadata?.contextBudgetRejected)).toBe(false);
      expect(
        rows.data.some((row) => row.metadata?.muxMetadata?.type === "context-window-rollover")
      ).toBe(false);
    } finally {
      releaseHistory.resolve();
      await h.session.dispose();
      await oldPolicy;
      await h.cleanup();
    }
  });

  test.each(["completed", "aborted", "failed"] as const)(
    "late %s completion cannot change a replacement paused in history preparation",
    async (status) => {
      const completion = Promise.withResolvers<TurnCompletion>();
      const emitter = new EventEmitter();
      let calls = 0;
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          streamMessage: mock(() => {
            const messageId = `assistant-${++calls}`;
            start(emitter, messageId);
            return Promise.resolve(
              Ok({
                messageId,
                completion:
                  calls === 1
                    ? completion.promise
                    : createStartedTurnHandle(h.session.closingSignal).completion,
              })
            );
          }),
        },
      });
      const consumer = observePolicy(h.session);
      const historyEntered = Promise.withResolvers<void>();
      const releaseHistory = Promise.withResolvers<void>();
      let replacement: Promise<unknown> | undefined;
      try {
        await h.session.sendMessage("hello", sendOptions);
        const oldPolicy = policyPromise(consumer);
        internal(h.session).coordinator.finishTurn(internal(h.session).coordinator.turnId);
        const commit = h.historyService.commitPartial.bind(h.historyService);
        spyOn(h.historyService, "commitPartial").mockImplementationOnce(async (id) => {
          historyEntered.resolve();
          await releaseHistory.promise;
          return commit(id);
        });
        replacement = h.session.sendMessage("replacement", sendOptions);
        await historyEntered.promise;
        // Old raw terminals must not mark the replacement as completing either.
        if (status === "completed") emitter.emit("stream-end", end());
        if (status === "aborted") emitter.emit("stream-abort", abort());
        expect(h.session.isPreparingTurn()).toBe(true);
        completion.resolve(
          status === "completed"
            ? { status, streamEnd: end() }
            : status === "aborted"
              ? { status, abortReason: "user", streamAbort: abort() }
              : {
                  status,
                  streamError: { messageId: "assistant-1", error: "old failure", errorType: "api" },
                }
        );
        await oldPolicy;
        expect(h.session.isPreparingTurn()).toBe(true);
        expect(
          h.events.filter((event) =>
            ["stream-end", "stream-abort", "stream-error"].includes(event.type)
          )
        ).toHaveLength(0);
        releaseHistory.resolve();
        await replacement;
        expect(calls).toBe(2);
      } finally {
        releaseHistory.resolve();
        await replacement;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test("disposal during success policy resolves compaction waiters and skips further accounting", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await h.session.sendMessage("hello", sendOptions);
      internal(h.session).activeCompactionRequest = { id: "compact", modelString: model };
      internal(h.session).coordinator.configureOperation(
        internal(h.session).coordinator.operationId!,
        true
      );
      spyOn(internal(h.session), "clearStartupAutoRetryAbandon").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const accounting = spyOn(internal(h.session), "recordGoalAccountingFromUsage");
      emitter.emit("stream-end", end());
      const decision = h.session.waitForPendingCompactionCompletionDecision("assistant-1");
      completion.resolve({ status: "completed", streamEnd: end() });
      await entered.promise;
      h.session.beginDispose();
      expect(await decision).toBe(false);
      expect(await h.session.waitForPendingCompactionCompletionDecision("late-observer")).toBe(
        false
      );
      release.resolve();
      await policyPromise(consumer);
      expect(accounting).not.toHaveBeenCalled();
      expect(h.session.isBusy()).toBe(false);
    } finally {
      release.resolve();
      await h.session.dispose();
      await h.cleanup();
    }
  });
  test("synchronous compaction completion publishes its decision, sanitizes the renderer and starts its follow-up", async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    const rawEnd = {
      ...end(),
      metadata: {
        model,
        providerMetadata: { openai: { responseId: "stale" } },
        contextProviderMetadata: { openai: { responseId: "stale" } },
      },
      parts: [
        { type: "reasoning" as const, text: "Private compaction reasoning" },
        { type: "text" as const, text: "Durable summary" },
      ],
    };
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++calls}`;
          start(emitter, messageId);
          if (calls > 1)
            return Promise.resolve(
              Ok({
                messageId,
                completion: createStartedTurnHandle(h.session.closingSignal).completion,
              })
            );
          emitter.emit("stream-end", rawEnd);
          return Promise.resolve(
            Ok({
              messageId,
              completion: Promise.resolve<TurnCompletion>({
                status: "completed",
                streamEnd: rawEnd,
              }),
            })
          );
        }),
      },
    });
    let lifecycleDecision: Promise<boolean> | undefined;
    h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-lifecycle" && message.phase === "completing") {
        lifecycleDecision = h.session.waitForPendingCompactionCompletionDecision("assistant-1");
      }
    });
    let decision: Promise<boolean> | undefined;
    // Raw terminal observation must happen before the handle is returned to sendMessage.
    emitter.on("stream-end", () => {
      decision = h.session.waitForPendingCompactionCompletionDecision("assistant-1");
    });
    const consumer = observePolicy(h.session);
    try {
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "Keep this context")
      );
      const result = await h.session.sendMessage(
        "Please compact",
        {
          model,
          agentId: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {
              followUpContent: { text: "Continue after summary", model, agentId: "exec" },
            },
          },
        },
        { synthetic: true }
      );
      expect(result.success).toBe(true);
      const firstPolicy = consumer.mock.results[0];
      if (firstPolicy?.type !== "return") throw new Error("Missing first policy");
      await firstPolicy.value;
      expect(decision).toBeDefined();
      expect(await decision).toBe(true);
      expect(lifecycleDecision).toBeDefined();
      expect(await lifecycleDecision).toBe(true);
      expect(calls).toBe(2);
      expect(h.session.isBusy()).toBe(true);
      const rendererEnds = h.events.filter((event) => event.type === "stream-end");
      expect(rendererEnds).toHaveLength(1);
      expect(rendererEnds[0].parts).toEqual(rawEnd.parts);
      expect(rendererEnds[0].metadata).not.toHaveProperty("providerMetadata");
      expect(rendererEnds[0].metadata).not.toHaveProperty("contextProviderMetadata");
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      expect(history.data[0].metadata?.compactionBoundary).toBe(true);
      expect(history.data.at(-1)?.parts).toMatchObject([
        { type: "text", text: "Continue after summary" },
      ]);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("edit preemption drops the old completion while truncation lookup is paused", async () => {
    const envelopeEntered = Promise.withResolvers<void>();
    const releaseEnvelope = Promise.withResolvers<void>();
    const lookupEntered = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<TurnCompletion>();
    let calls = 0;
    const replacementStarted = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(async () => {
          const messageId = `assistant-${++calls}`;
          if (calls === 1) {
            envelopeEntered.resolve();
            await releaseEnvelope.promise;
          }
          if (calls === 2) replacementStarted.resolve();
          return Ok({
            messageId,
            completion:
              calls === 1
                ? completion.promise
                : createStartedTurnHandle(h.session.closingSignal).completion,
          });
        }),
      },
    });
    const consumer = observePolicy(h.session);
    let edit: Promise<unknown> | undefined;
    const original = h.session.sendMessage("original", sendOptions);
    try {
      await envelopeEntered.promise;
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const userId = history.data.find((message) => message.role === "user")!.id;
      const lookup = internal(h.session).getEditTruncateTargetId.bind(h.session);
      spyOn(internal(h.session), "getEditTruncateTargetId").mockImplementation(async (id) => {
        lookupEntered.resolve();
        await releaseLookup.promise;
        return lookup(id);
      });
      edit = h.session.sendMessage("edited", { ...sendOptions, editMessageId: userId });
      await lookupEntered.promise;
      completion.resolve({ status: "completed", streamEnd: end() });
      releaseEnvelope.resolve();
      await original;
      await policyPromise(consumer);
      expect(h.events.filter((event) => event.type === "stream-end")).toHaveLength(0);
      expect(h.session.isBusy()).toBe(true);
      releaseLookup.resolve();
      await edit;
      await replacementStarted.promise;
      expect(calls).toBe(2);
    } finally {
      releaseEnvelope.resolve();
      releaseLookup.resolve();
      await original;
      await edit;
      await h.session.dispose();
      await h.cleanup();
    }
  });
  test("provider-tool-end abort dispatches the queued turn only after delivered completion", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const emitter = new EventEmitter();
    const nextStarted = Promise.withResolvers<void>();
    let calls = 0;
    const stopStream = mock(() => Promise.resolve(Ok(undefined)));
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        stopStream,
        streamMessage: mock(() => {
          const messageId = `assistant-${++calls}`;
          start(emitter, messageId);
          if (calls === 2) nextStarted.resolve();
          return Promise.resolve(
            Ok({
              messageId,
              completion:
                calls === 1
                  ? completion.promise
                  : createStartedTurnHandle(h.session.closingSignal).completion,
            })
          );
        }),
      },
    });
    const consumer = observePolicy(h.session);
    try {
      await h.session.sendMessage("hello", sendOptions);
      const firstPolicy = policyPromise(consumer);
      h.session.queueMessage("queued follow-up", sendOptions);
      emitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "search-1",
        toolName: "web_search",
        providerExecuted: true,
        result: { success: true },
        timestamp: Date.now(),
      });
      expect(stopStream).toHaveBeenCalledWith(workspaceId, { soft: true, abortReason: "system" });
      const payload = { ...abort(), abortReason: "system" as const };
      emitter.emit("stream-abort", payload);
      expect(calls).toBe(1);
      expect(h.session.hasQueuedMessages()).toBe(true);
      completion.resolve({ status: "aborted", abortReason: "system", streamAbort: payload });
      await firstPolicy;
      await nextStarted.promise;
      expect(calls).toBe(2);
      expect(h.session.hasQueuedMessages()).toBe(false);
      expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
      expect(h.session.isBusy()).toBe(true);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("a duplicate compaction terminal cannot create a second pending decision", async () => {
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          emitter.emit("stream-end", end());
          return Promise.resolve(
            Ok({
              messageId: "assistant-1",
              completion: Promise.resolve<TurnCompletion>({
                status: "completed",
                streamEnd: end(),
              }),
            })
          );
        }),
      },
    });
    const consumer = observePolicy(h.session);
    let decision: Promise<boolean> | undefined;
    emitter.once("stream-end", () => {
      decision = h.session.waitForPendingCompactionCompletionDecision("assistant-1");
    });
    try {
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "context")
      );
      await h.session.sendMessage(
        "compact",
        {
          model,
          agentId: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
          },
        },
        { synthetic: true }
      );
      await policyPromise(consumer);
      expect(await decision).toBe(false);
      emitter.emit("stream-end", end());
      expect(await h.session.waitForPendingCompactionCompletionDecision("assistant-1")).toBe(false);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });
  test.each(["hard", "soft", "dispose"] as const)(
    "%s interruption handles stream-start before the handle is returned",
    async (mode) => {
      const emitter = new EventEmitter();
      const started = Promise.withResolvers<void>();
      const releaseHandle = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<TurnCompletion>();
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          streamMessage: mock(async () => {
            start(emitter);
            started.resolve();
            await releaseHandle.promise;
            return Ok({ messageId: "assistant-1", completion: completion.promise });
          }),
          stopStream: mock(() => {
            emitter.emit("stream-abort", abort());
            completion.resolve({ status: "aborted", abortReason: "user", streamAbort: abort() });
            stopped.resolve();
            return Promise.resolve(Ok(undefined));
          }),
        },
      });
      const consumer = observePolicy(h.session);
      const sending = h.session.sendMessage("hello", sendOptions);
      let interrupt: Promise<unknown> | undefined;
      try {
        await started.promise;
        let returned = false;
        interrupt = h.session.interruptStream({ soft: mode === "soft" }).then((result) => {
          returned = true;
          return result;
        });
        await stopped.promise;
        if (mode === "dispose") h.session.beginDispose();
        if (mode === "hard") {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(returned).toBe(false);
        } else {
          await interrupt;
          expect(returned).toBe(true);
        }
        releaseHandle.resolve();
        await sending;
        await interrupt;
        await policyPromise(consumer);
        // Disposal retains the captured attempt's raw terminal even before its handle returns.
        expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
      } finally {
        releaseHandle.resolve();
        await h.session.dispose();
        await sending;
        await interrupt;
        await h.cleanup();
      }
    }
  );
  test.each(["error", "rejection"] as const)(
    "a preempted preparation's delayed history %s cannot apply failure policy to its replacement",
    async (failure) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const emitter = new EventEmitter();
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        captureEvents: true,
        aiServiceOverrides: {
          streamMessage: mock(() => {
            start(emitter, "replacement");
            return Promise.resolve(
              Ok({
                messageId: "replacement",
                completion: createStartedTurnHandle(h.session.closingSignal).completion,
              })
            );
          }),
        },
      });
      try {
        spyOn(h.historyService, "commitPartial").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          if (failure === "rejection") throw new Error("retired startup history failure");
          return Err("retired startup history failure");
        });
        const original = h.session
          .sendMessage("original", sendOptions)
          .catch((error: unknown) => error);
        await entered.promise;
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const messageId = history.data.find((message) => message.role === "user")!.id;
        const replacementStarted = Promise.withResolvers<void>();
        const unsubscribe = h.session.onChatEvent(({ message: event }) => {
          if (event.type === "stream-start" && event.messageId === "replacement")
            replacementStarted.resolve();
        });
        await h.session.sendMessage("replacement", { ...sendOptions, editMessageId: messageId });
        await replacementStarted.promise;
        unsubscribe();
        release.resolve();
        await original;
        expect(h.session.isBusy()).toBe(true);
        expect(h.session.isPreparingTurn()).toBe(false);
        expect(h.events.some((event) => event.type === "stream-error")).toBe(false);
        expect(h.session.hasPendingAutoRetry()).toBe(false);
        expect(h.session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: true });
      } finally {
        release.resolve();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );
  test("shutdown followed by disposal cannot reopen retry after a suspended preference read", async () => {
    const completion = Promise.withResolvers<TurnCompletion>();
    const preferenceEntered = Promise.withResolvers<void>();
    const preference = Promise.withResolvers<boolean>();
    const emitter = new EventEmitter();
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          start(emitter);
          return Promise.resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
        }),
      },
    });
    const consumer = observePolicy(h.session);
    try {
      await h.session.sendMessage("hello", sendOptions);
      const retryPolicy = h.session as unknown as {
        loadAutoRetryEnabledPreference(): Promise<boolean>;
      };
      spyOn(retryPolicy, "loadAutoRetryEnabledPreference").mockImplementationOnce(() => {
        preferenceEntered.resolve();
        return preference.promise;
      });
      completion.resolve({
        status: "failed",
        streamError: { messageId: "assistant-1", error: "provider failed", errorType: "api" },
      });
      await preferenceEntered.promise;
      h.session.beginShutdown();
      h.session.beginDispose();
      preference.resolve(true);
      await policyPromise(consumer);
      expect(h.session.hasPendingAutoRetry()).toBe(false);
      expect(h.events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    } finally {
      preference.resolve(true);
      await h.session.dispose();
      await h.cleanup();
    }
  });
});
