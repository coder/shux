import type { TurnCoordinator } from "./turnCoordinator";
import { createMuxMessage } from "@/common/types/message";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { Err, Ok } from "@/common/types/result";
import type { StreamMessageOptions } from "./turnRequestBuilder";
import type { TurnCompletion } from "./streamManager";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "session-completion";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };

interface InternalSession {
  lastSystemMessageTokens?: number;
  activeCompactionRequest?: { id: string; modelString: string };
  clearStartupAutoRetryAbandon(): Promise<void>;
  recordGoalAccountingFromUsage(input: unknown): Promise<void>;
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
      h.session.dispose();
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
        h.session.dispose();
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
                  calls === 1 ? completion.promise : new Promise<TurnCompletion>(() => undefined),
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
        h.session.dispose();
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
        h.session.dispose();
        await h.cleanup();
      }
    }
  );

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
                  calls === 1 ? completion.promise : new Promise<TurnCompletion>(() => undefined),
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
        h.session.dispose();
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
      h.session.dispose();
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
      h.session.dispose();
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
              Ok({ messageId, completion: new Promise<TurnCompletion>(() => undefined) })
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
      h.session.dispose();
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
              calls === 1 ? completion.promise : new Promise<TurnCompletion>(() => undefined),
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
      h.session.dispose();
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
                calls === 1 ? completion.promise : new Promise<TurnCompletion>(() => undefined),
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
      h.session.dispose();
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
      h.session.dispose();
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
        if (mode === "dispose") h.session.dispose();
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
        expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(
          mode === "dispose" ? 0 : 1
        );
      } finally {
        releaseHandle.resolve();
        h.session.dispose();
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
                completion: new Promise<TurnCompletion>(() => undefined),
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
        h.session.dispose();
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
      h.session.dispose();
      preference.resolve(true);
      await policyPromise(consumer);
      expect(h.session.hasPendingAutoRetry()).toBe(false);
      expect(h.events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    } finally {
      preference.resolve(true);
      h.session.dispose();
      await h.cleanup();
    }
  });
});
