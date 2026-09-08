import { describe, expect, mock, test } from "bun:test";
import assert from "@/common/utils/assert";
import { Effect, Exit, Scope } from "effect";
import { defaultEffectRunner as runner } from "./di/effectRunner";
import {
  TurnCoordinator,
  initialCoordinatorState,
  transition,
  type CoordinatorEvent,
  type TurnId,
} from "./turnCoordinator";
import type { StreamStartEvent } from "@/common/types/stream";
import type { TurnCompletion } from "./streamManager";
import type { ActiveTurnThinkingOverride } from "./thinkingOverride";

const completed: TurnCompletion = {
  status: "completed",
  streamEnd: {
    type: "stream-end",
    workspaceId: "test",
    metadata: { model: "openai:gpt-4o" },
    parts: [],
  },
};

function startEvent(messageId: string): StreamStartEvent {
  return {
    type: "stream-start",
    workspaceId: "test",
    messageId,
    model: "openai:gpt-4o",
    startTime: 1,
    historySequence: 1,
  };
}

function prepare(coordinator: TurnCoordinator, controller?: AbortController): TurnId {
  const result = coordinator.prepare(
    { kind: "fresh", intent: "handoff", expectedTurnId: coordinator.turnId },
    controller
  );
  if (result.status !== "admitted") throw new Error(`Preparation ${result.status}`);
  return result.turnId;
}

function setup(overrides: Partial<ConstructorParameters<typeof TurnCoordinator>[0]> = {}) {
  const callbacks = {
    phaseChanged: mock(() => undefined),
    drainQueue: mock(() => undefined),
    policy: mock(() => Promise.resolve()),
    policyError: mock(() => undefined),
    ...overrides,
  };
  return { coordinator: new TurnCoordinator(callbacks), callbacks };
}

const initialTurn = Symbol("idle");

// Commands are observable work, so a stale event must not merely leave the phase looking right.
function reduce(events: CoordinatorEvent[]) {
  let state = initialCoordinatorState(initialTurn);
  for (const event of events) state = transition(state, event).state;
  return state;
}

describe("TurnCoordinator", () => {
  test("continuation admission keeps only its own source current across a turn change", () => {
    const { coordinator } = setup();
    const token = coordinator.claimCompactionFollowUp();
    assert(token != null, "Expected follow-up owner");
    expect(coordinator.claimCompactionFollowUp()).toBeUndefined();
    const previous = coordinator.turnId;
    const admission = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: previous,
      compactionHandoff: token,
    });
    expect(admission.status).toBe("admitted");
    expect(coordinator.turnId).not.toBe(previous);
    expect(coordinator.isCurrentCompactionFollowUp(token)).toBe(true);
    coordinator.finishTurn(coordinator.turnId);
    prepare(coordinator);
    expect(coordinator.isCurrentCompactionFollowUp(token)).toBe(false);
    expect(coordinator.canClearCompactionFollowUp(token)).toBe(false);
    coordinator.finishCompactionFollowUp(token);
  });

  test.each(["edit", "mutation", "replacement", "abandon", "dispose"] as const)(
    "%s cannot release a continuation's physical slot or its waiting batch",
    async (action) => {
      const { coordinator } = setup();
      const token = coordinator.claimCompactionFollowUp();
      assert(token != null, "Expected follow-up owner");
      let settled = false;
      const wait = coordinator.waitForMidStreamCompactionSettled().then(() => {
        settled = true;
      });
      if (action === "edit") coordinator.reserve("edit")[Symbol.dispose]();
      if (action === "mutation") coordinator.retireCompactionFollowUp();
      if (action === "replacement") coordinator.finishTurn(prepare(coordinator));
      if (action === "abandon") coordinator.abandonCompaction();
      if (action === "dispose") coordinator.dispose();
      expect(coordinator.isCurrentCompactionFollowUp(token)).toBe(false);
      expect(coordinator.canClearCompactionFollowUp(token)).toBe(action === "abandon");
      expect(coordinator.claimCompactionFollowUp()).toBeUndefined();
      coordinator.finishCompactionFollowUp(Symbol("not the owner"));
      await Promise.resolve();
      expect(settled).toBe(false);
      coordinator.finishCompactionFollowUp(token);
      await wait;
      expect(settled).toBe(true);
      if (action !== "dispose") {
        const next = coordinator.claimCompactionFollowUp();
        assert(next != null, "Expected replacement slot after physical finish");
        coordinator.finishCompactionFollowUp(token);
        expect(coordinator.midStreamCompactionPending).toBe(true);
        coordinator.finishCompactionFollowUp(next);
      }
    }
  );

  test("compaction waiters join both the observation and its pending continuation", async () => {
    const { coordinator } = setup();
    const observation = coordinator.beginCompactionObservation("continuous");
    const followUp = coordinator.claimCompactionFollowUp();
    assert(observation != null && followUp != null, "Expected both owners");
    coordinator.setCompactionStage(observation, "stopped");
    let settled = false;
    const wait = coordinator.waitForMidStreamCompactionSettled().then(() => {
      settled = true;
    });
    coordinator.finishCompactionObservation(observation);
    await Promise.resolve();
    expect(settled).toBe(false);
    coordinator.finishCompactionFollowUp(followUp);
    await wait;
    expect(settled).toBe(true);
  });

  test("an existing edit excludes observation and an abandoned handoff cannot admit a turn", () => {
    const phaseChanged = mock(() => undefined);
    const { coordinator } = setup({ phaseChanged });
    const edit = coordinator.reserve("edit");
    expect(coordinator.claimCompactionFollowUp()).toBeUndefined();
    edit[Symbol.dispose]();
    const token = coordinator.claimCompactionFollowUp();
    assert(token != null, "Expected follow-up owner after edit settles");
    coordinator.abandonCompaction();
    coordinator.streamStarted(startEvent("new-stream"));
    coordinator.finishTurn(coordinator.turnId);
    const install = mock(() => undefined);
    phaseChanged.mockClear();
    const result = coordinator.prepare(
      {
        kind: "fresh",
        intent: "direct",
        expectedTurnId: coordinator.turnId,
        compactionHandoff: token,
      },
      new AbortController(),
      install
    );
    expect(result).toEqual({ status: "rejected", reason: "retired" });
    expect(install).not.toHaveBeenCalled();
    expect(phaseChanged).not.toHaveBeenCalled();
    coordinator.finishCompactionFollowUp(token);
  });

  test.each(["continuous", "legacy"] as const)(
    "%s observation completion cannot change a replacement or release its waiter",
    async (kind) => {
      const { coordinator, callbacks } = setup();
      const first = coordinator.beginCompactionObservation(kind);
      assert(first != null, "Expected first observation");
      expect(coordinator.beginCompactionObservation(kind)).toBeUndefined();
      coordinator.setCompactionStage(first, "stopping");
      const firstSettled = coordinator.waitForMidStreamCompactionSettled();
      expect(coordinator.finishCompactionObservation(first)).toBe(true);
      const replacement = coordinator.beginCompactionObservation(kind);
      assert(replacement != null, "Expected replacement observation");
      coordinator.setCompactionStage(replacement, "stopping");
      let settled = false;
      const replacementSettled = coordinator.waitForMidStreamCompactionSettled().then(() => {
        settled = true;
      });
      await firstSettled;
      coordinator.setCompactionStage(first, "stopped");
      expect(coordinator.finishCompactionObservation(first)).toBe(false);
      await Promise.resolve();
      expect(coordinator.compactionIntent.observation?.stage).toBe("stopping");
      expect(settled).toBe(false);
      expect(callbacks.phaseChanged).not.toHaveBeenCalled();
      expect(callbacks.drainQueue).not.toHaveBeenCalled();
      coordinator.finishCompactionObservation(replacement);
      await replacementSettled;
      expect(settled).toBe(true);
    }
  );

  test.each(["abandon", "shutdown", "dispose"] as const)(
    "%s retains the compaction pending window until its owner finishes",
    async (action) => {
      const { coordinator } = setup();
      const token = coordinator.beginCompactionObservation("continuous");
      assert(token != null, "Expected observation");
      coordinator.setCompactionStage(token, "stopping");
      let settled = false;
      const wait = coordinator.waitForMidStreamCompactionSettled().then(() => {
        settled = true;
      });
      if (action === "abandon") coordinator.abandonCompaction();
      else if (action === "shutdown") coordinator.beginShutdown();
      else coordinator.dispose();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(coordinator.midStreamCompactionPending).toBe(true);
      expect(coordinator.beginCompactionObservation("legacy")).toBeUndefined();
      // Stop may resolve after disposal; it still has to release its own pending window.
      coordinator.setCompactionStage(token, "stopped");
      expect(coordinator.finishCompactionObservation(token)).toBe(true);
      await wait;
      expect(settled).toBe(true);
      expect(coordinator.midStreamCompactionPending).toBe(false);
    }
  );

  test("compaction bookkeeping preserves admission policy and resets abandonment at stream start", () => {
    const { coordinator } = setup();
    coordinator.abandonCompaction();
    using _admission = coordinator.reserve("admission");
    using _edit = coordinator.reserve("edit");
    const token = coordinator.beginCompactionObservation("continuous");
    assert(token != null, "Observation policy remains with the session");
    expect(coordinator.compactionIntent.abandoned).toBe(true);
    coordinator.setCompactionStage(token, "stopped");
    coordinator.recordCompactionSummary("saved-boundary");
    coordinator.streamStarted(startEvent("resumed"));
    expect(coordinator.compactionIntent.abandoned).toBe(false);
    expect(coordinator.compactionIntent.summaryId).toBe("saved-boundary");
    expect(coordinator.compactionIntent.observation?.token).toBe(token);
    expect(coordinator.midStreamCompactionPending).toBe(true);
    coordinator.finishCompactionObservation(token);
  });

  test("observed terminal publishes before idle/drain and cannot retire a reentrant replacement", () => {
    const order: string[] = [];
    const { coordinator, callbacks } = setup({
      phaseChanged: () => {
        order.push(coordinator.phase);
      },
      drainQueue: () => {
        order.push("drain");
      },
    });
    expect(coordinator.observeStreamReplay("A")).toBe(true);
    expect(coordinator.isBusy()).toBe(true);
    order.length = 0;
    expect(coordinator.finishObservedStream("stale", () => order.push("wrong"))).toBe(false);
    expect(coordinator.finishObservedStream("A", () => order.push("terminal"))).toBe(true);
    expect(order).toEqual(["terminal", "idle", "drain"]);
    expect(callbacks.policy).not.toHaveBeenCalled();
    expect(coordinator.observeStreamReplay("B")).toBe(true);
    let replacement: TurnId | undefined;
    coordinator.finishObservedStream("B", () => {
      replacement = prepare(coordinator);
    });
    expect(replacement).toBeDefined();
    expect(replacement === coordinator.turnId).toBe(true);
    expect(coordinator.phase).toBe("preparing");
    coordinator.dispose();
  });

  test("replay eligibility observes existing streams without starting or reviving operations", () => {
    const streamStarted = mock(() => undefined);
    const { coordinator, callbacks } = setup({ streamStarted });
    expect(coordinator.canReplayStreamStart("existing-engine")).toBe(true);
    expect(coordinator.phase).toBe("idle");
    expect(callbacks.phaseChanged).not.toHaveBeenCalled();
    expect(streamStarted).not.toHaveBeenCalled();
    const op = coordinator.registerOperation(prepare(coordinator));
    expect(coordinator.canReplayStreamStart("active")).toBe(false);
    coordinator.streamStarted(startEvent("active"));
    expect(coordinator.canReplayStreamStart("active")).toBe(true);
    expect(coordinator.canReplayStreamStart("stale")).toBe(false);
    expect(streamStarted).toHaveBeenCalledTimes(1);
    coordinator.rawTerminal("completed", "active");
    expect(coordinator.canReplayStreamStart("active")).toBe(false);
    coordinator.finishStartup(op);
    coordinator.dispose();

    const closing = setup().coordinator;
    const closingOp = closing.registerOperation(prepare(closing));
    closing.streamStarted(startEvent("closing"));
    expect(closing.canReplayStreamStart("closing")).toBe(true);
    closing.beginShutdown();
    expect(closing.canReplayStreamStart("closing")).toBe(false);
    closing.finishStartup(closingOp);
    closing.dispose();
  });

  test("session scope releases thinking and idle listeners even without another idle event", async () => {
    const scope = Scope.makeUnsafe("parallel");
    const { coordinator } = setup();
    coordinator.supervise(runner, scope, () => coordinator.beginShutdown());
    const turn = prepare(coordinator);
    coordinator.acceptThinkingOverride({}, turn);
    const signal = new AbortController();
    const canceled = coordinator.waitForIdle(signal.signal);
    signal.abort();
    expect(await canceled.catch((error: unknown) => error)).toBeInstanceOf(Error);
    const idle = coordinator.waitForIdle();
    await runner.runPromise(Scope.close(scope, Exit.void));
    await idle;
    expect(coordinator.thinkingOverride).toBeNull();
    expect(coordinator.phase).toBe("preparing");
  });

  test("completion callback reserves synchronously before the next Promise observer", async () => {
    const order: string[] = [];
    const { coordinator } = setup({
      policy: async () => {
        order.push("policy");
        await Promise.resolve();
        order.push("settled");
      },
    });
    const op = coordinator.registerOperation(prepare(coordinator));
    const engine = Promise.resolve(completed);
    const consumed = coordinator.consumeCompletion(op, { messageId: "sync", completion: engine });
    await engine.then(() => order.push("observer"));
    await consumed;
    expect(order).toEqual(["policy", "observer", "settled"]);
    coordinator.dispose();
  });

  test("app shutdown accepts a registered engine's late terminal and joins its policy", async () => {
    const scope = Scope.makeUnsafe("parallel");
    const engine = Promise.withResolvers<TurnCompletion>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { coordinator, callbacks } = setup({
      policy: () => {
        entered.resolve();
        return release.promise;
      },
    });
    coordinator.supervise(runner, scope, () => coordinator.beginShutdown());
    const turn = prepare(coordinator);
    const op = coordinator.registerOperation(turn);
    coordinator.streamStarted(startEvent("late"));
    const consumed = coordinator.consumeCompletion(op, {
      messageId: "late",
      completion: engine.promise,
    });
    let closed = false;
    const closing = runner.runPromise(Scope.close(scope, Exit.void)).then(() => {
      closed = true;
    });
    expect(coordinator.closing).toBe(true);
    expect(
      coordinator.prepare({ kind: "fresh", intent: "resume", expectedTurnId: coordinator.turnId })
        .status
    ).toBe("rejected");
    engine.resolve(completed);
    await entered.promise;
    // Engine completion never joins the policy that may itself need engine cleanup.
    expect(await engine.promise).toBe(completed);
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([consumed, closing]);
    expect(callbacks.policyError).not.toHaveBeenCalled();
  });

  test("interruption joins the original policy once and retains retired physical work", async () => {
    const scope = Scope.makeUnsafe("parallel");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const { coordinator } = setup({
      policy: () => {
        calls++;
        entered.resolve();
        return release.promise;
      },
    });
    coordinator.supervise(runner, scope, () => coordinator.beginShutdown());
    const turn = prepare(coordinator);
    const op = coordinator.registerOperation(turn);
    coordinator.streamStarted(startEvent("retired"));
    coordinator.beginErrorDecision("retired");
    const logical = coordinator.captureInterruptSettlement();
    const consumed = coordinator.consumeCompletion(op, {
      messageId: "retired",
      completion: Promise.resolve(completed),
    });
    await entered.promise;
    const replacement = prepare(coordinator);
    await logical;
    let settled = false;
    const decision = coordinator.waitForErrorDecision("retired").then((outcome) => {
      settled = true;
      return outcome;
    });
    let closed = false;
    const closing = runner.runPromise(Scope.close(scope, Exit.void)).then(() => {
      closed = true;
    });
    // A turn may retire logically while its Promise is still writing. Interruption cannot
    // finalize its decisions or let app teardown pass that write.
    await runner.runPromise(Effect.yieldNow);
    expect(closed).toBe(false);
    expect(settled).toBe(false);
    expect(calls).toBe(1);
    expect(coordinator.turnId).toBe(replacement);
    release.resolve();
    await Promise.all([consumed, closing]);
    expect(await decision).toBe("terminal");
    expect(calls).toBe(1);
    expect(coordinator.turnId).toBe(replacement);
  });

  test.each(["throw", "reject"])(
    "policy %s finalizes decisions and physical shutdown",
    async (failure) => {
      const scope = Scope.makeUnsafe("parallel");
      const error = new Error("policy failed");
      const { coordinator, callbacks } = setup({
        policy: () => {
          if (failure === "throw") throw error;
          return Promise.reject(error);
        },
      });
      coordinator.supervise(runner, scope, () => coordinator.beginShutdown());
      const op = coordinator.registerOperation(prepare(coordinator));
      coordinator.beginErrorDecision("failed");
      await coordinator.consumeCompletion(op, {
        messageId: "failed",
        completion: Promise.resolve(completed),
      });
      await runner.runPromise(Scope.close(scope, Exit.void));
      expect(await coordinator.waitForErrorDecision("failed")).toBe("terminal");
      expect(callbacks.policyError).toHaveBeenCalledWith(error);
    }
  );

  test("retired preparation, operation, reservation and retry events cannot affect their replacements", () => {
    const a = Symbol("A"),
      b = Symbol("B"),
      op = Symbol("operation"),
      retryA = Symbol("retry A"),
      retryB = Symbol("retry B");
    const state = reduce([
      {
        type: "prepare",
        id: a,
        request: { kind: "fresh", intent: "handoff", expectedTurnId: initialTurn },
      },
      { type: "register", id: op, turnId: a },
      { type: "prepare", id: b, request: { kind: "fresh", intent: "handoff", expectedTurnId: a } },
      { type: "retry-start", id: retryA },
      { type: "retry-start", id: retryB },
    ]);
    for (const event of [
      { type: "finish", id: a, preparingOnly: false },
      { type: "register", id: Symbol("late operation"), turnId: a },
      { type: "completion", id: op, messageId: "A", outcome: completed },
      { type: "retry-finish", id: retryA },
      { type: "release", id: Symbol("released"), kind: "edit" },
    ] satisfies CoordinatorEvent[]) {
      expect(transition(state, event)).toEqual({ state, commands: [] });
    }
  });

  test("idle publication detaches A's resources and waiters before reentrant B admission", async () => {
    let replacement: TurnId | undefined;
    let replacementWait: Promise<void> | undefined;
    let bIdle = false;
    const thinkingA: ActiveTurnThinkingOverride = {};
    const thinkingB: ActiveTurnThinkingOverride = {};
    const { coordinator } = setup({
      phaseChanged: (phase) => {
        if (phase !== "idle" || replacement) return;
        replacement = prepare(coordinator);
        coordinator.acceptThinkingOverride(thinkingB, replacement);
        replacementWait = coordinator.waitForIdle().then(() => {
          bIdle = true;
        });
      },
    });
    const a = prepare(coordinator);
    coordinator.acceptThinkingOverride(thinkingA, a);
    const aWait = coordinator.waitForIdle();
    coordinator.finishTurn(a);
    await aWait;
    expect(bIdle).toBe(false);
    expect(coordinator.thinkingOverride).toBe(thinkingB);
    coordinator.finishTurn(a);
    await Promise.resolve();
    expect(bIdle).toBe(false);
    expect(coordinator.isBusy()).toBe(true);
    coordinator.finishTurn(replacement!);
    await replacementWait;
    expect(bIdle).toBe(true);
  });

  test("preemption abort callbacks cannot finish or overwrite the replacement", () => {
    const { coordinator } = setup();
    const controller = new AbortController();
    const a = prepare(coordinator, controller);
    const operation = coordinator.registerOperation(a);
    const thinkingB = {};
    controller.signal.addEventListener("abort", () => {
      const b = prepare(coordinator);
      coordinator.acceptThinkingOverride(thinkingB, b);
    });
    expect(coordinator.preemptPreparation()).toBe(true);
    coordinator.finishPreparation(a);
    coordinator.acceptThinkingOverride({}, a);
    expect(coordinator.isCurrentOperation(operation)).toBe(false);
    expect(coordinator.isBusy()).toBe(true);
    expect(coordinator.thinkingOverride).toBe(thinkingB);
    // Controllerless B does not inherit A's preparation cancellation resource.
    expect(coordinator.preemptPreparation()).toBe(false);
  });

  test("disposal from lifecycle publication releases captured waiters and preparation exactly once", async () => {
    let disposeOnIdle = false;
    const { coordinator, callbacks } = setup({
      phaseChanged: (phase) => {
        if (phase === "idle" && disposeOnIdle) coordinator.dispose();
      },
    });
    const controller = new AbortController();
    const aborted = mock(() => undefined);
    controller.signal.addEventListener("abort", aborted);
    prepare(coordinator, controller);
    const idle = coordinator.waitForIdle();
    disposeOnIdle = true;
    coordinator.dispose();
    await idle;
    coordinator.dispose();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(coordinator.disposed).toBe(true);
    expect(
      coordinator.prepare({ kind: "fresh", intent: "resume", expectedTurnId: coordinator.turnId })
        .status
    ).toBe("rejected");
    expect(callbacks.drainQueue).not.toHaveBeenCalled();
  });

  test("admission, edit busy reservations, and manual work remain independent of phase idle", async () => {
    const { coordinator, callbacks } = setup();
    const admission = coordinator.reserve("admission");
    const edit = coordinator.reserve("edit");
    const manual = coordinator.registerManualFollowUp();
    await coordinator.waitForIdle();
    expect(coordinator.isBusy()).toBe(true);
    const rejected = coordinator.prepare({
      kind: "fresh",
      intent: "resume",
      expectedTurnId: coordinator.turnId,
    });
    expect(rejected.status).toBe("rejected");
    admission[Symbol.dispose]();
    admission[Symbol.dispose]();
    expect(callbacks.drainQueue).not.toHaveBeenCalled();
    edit[Symbol.dispose]();
    expect(callbacks.drainQueue).toHaveBeenCalledTimes(1);
    edit[Symbol.dispose]();
    expect(callbacks.drainQueue).toHaveBeenCalledTimes(1);
    expect(coordinator.manualFollowUpPending).toBe(true);
    expect(coordinator.isBusy()).toBe(false);
    manual();
    manual();
    expect(coordinator.manualFollowUpPending).toBe(false);
    const shutdownHold = coordinator.reserve("admission");
    coordinator.beginShutdown();
    shutdownHold[Symbol.dispose]();
    expect(callbacks.drainQueue).toHaveBeenCalledTimes(1);
  });

  test("raw success publishes its pending decision before reentrant completing observers", async () => {
    let observed: Promise<boolean> | undefined;
    const { coordinator } = setup({
      phaseChanged: (phase) => {
        if (phase === "completing") observed = coordinator.waitForCompactionDecision("A", false);
      },
    });
    const a = prepare(coordinator);
    const operation = coordinator.registerOperation(a);
    coordinator.configureOperation(operation, true);
    coordinator.streamStarted(startEvent("A"));
    coordinator.rawTerminal("completed", "A");
    coordinator.resolveCompactionDecision("A", true);
    coordinator.resolveCompactionDecision("A", false);
    expect(await observed).toBe(true);
    coordinator.resolveCompactionDecision("A", false);
    expect(await coordinator.waitForCompactionDecision("A", false)).toBe(false);
  });

  test.each(["error", "compaction"] as const)(
    "stale delivered completion settles A's %s decision without touching B",
    async (kind) => {
      const { coordinator, callbacks } = setup();
      const a = prepare(coordinator);
      const operation = coordinator.registerOperation(a);
      coordinator.configureOperation(operation, true);
      coordinator.streamStarted(startEvent("A"));
      let oldDecision: Promise<unknown>;
      if (kind === "error") {
        coordinator.beginErrorDecision("A");
        oldDecision = coordinator.waitForErrorDecision("A");
      } else {
        coordinator.rawTerminal("completed", "A");
        oldDecision = coordinator.waitForCompactionDecision("A", false);
      }
      const b = prepare(coordinator);
      await coordinator.consumeCompletion(operation, {
        messageId: "A",
        completion: Promise.resolve(completed),
      });
      expect(await oldDecision).toBe(kind === "error" ? "terminal" : false);
      expect(coordinator.isCurrentTurn(b)).toBe(true);
      expect(coordinator.phase).toBe("preparing");
      expect(callbacks.policy).not.toHaveBeenCalled();
    }
  );

  test("A policy may hand off B; A finally settles A without publishing or draining B", async () => {
    const continueA = Promise.withResolvers<void>();
    let b: TurnId | undefined;
    const { coordinator, callbacks } = setup({
      policy: async () => {
        b = prepare(coordinator);
        await continueA.promise;
      },
    });
    const a = prepare(coordinator);
    const operation = coordinator.registerOperation(a);
    coordinator.streamStarted(startEvent("A"));
    const hardStop = coordinator.captureInterruptSettlement();
    const policy = coordinator.consumeCompletion(operation, {
      messageId: "A",
      completion: Promise.resolve(completed),
    });
    await hardStop;
    expect(coordinator.isCurrentTurn(b!)).toBe(true);
    continueA.resolve();
    await policy;
    expect(coordinator.isCurrentTurn(b!)).toBe(true);
    expect(coordinator.phase).toBe("preparing");
    expect(callbacks.drainQueue).not.toHaveBeenCalled();
  });

  test("hard stop joins started policy, but soft and registered startup stop do not", async () => {
    const done = Promise.withResolvers<void>();
    const { coordinator } = setup({ policy: () => done.promise });
    const a = prepare(coordinator);
    const operation = coordinator.registerOperation(a);
    expect(coordinator.captureInterruptSettlement()).toBeUndefined();
    coordinator.streamStarted(startEvent("A"));
    expect(coordinator.captureInterruptSettlement(true)).toBeUndefined();
    let settled = false;
    const interrupted = coordinator.captureInterruptSettlement()!.then(() => {
      settled = true;
    });
    const consumed = coordinator.consumeCompletion(operation, {
      messageId: "A",
      completion: Promise.resolve(completed),
    });
    await Promise.resolve();
    coordinator.finishTurn(a);
    await coordinator.waitForIdle();
    expect(settled).toBe(false);
    done.resolve();
    await consumed;
    await interrupted;
    expect(settled).toBe(true);
  });
  test.each([true, false])(
    "delivered startup abort with payload=%s claims only its matching notification",
    async (withPayload) => {
      const { coordinator, callbacks } = setup();
      const a = prepare(coordinator);
      const operation = coordinator.registerOperation(a);
      coordinator.streamStarting(operation, "synthetic-A");
      await coordinator.consumeCompletion(operation, {
        messageId: "registered-A",
        completion: Promise.resolve({
          status: "aborted",
          abortReason: "user",
          ...(withPayload
            ? { streamAbort: { type: "stream-abort" as const, workspaceId: "test" } }
            : {}),
        }),
      });
      const notified = coordinator.observeStartupAbort({
        type: "stream-abort",
        workspaceId: "test",
        messageId: "synthetic-A",
        abortReason: "user",
      });
      expect(notified).toBe(!withPayload);
      expect(callbacks.policy).toHaveBeenCalledTimes(1);
    }
  );
  test("throwing idle publication still releases its detached waiter and disposal resources", async () => {
    const { coordinator } = setup({
      phaseChanged: (phase) => {
        if (phase === "idle") throw new Error("observer failed");
      },
    });
    const controller = new AbortController();
    prepare(coordinator, controller);
    const idle = coordinator.waitForIdle();
    expect(() => coordinator.dispose()).toThrow("observer failed");
    await idle;
    expect(controller.signal.aborted).toBe(true);
    coordinator.dispose();
    await coordinator.waitForIdle();
  });

  test("start bookkeeping observes ownership before callbacks; reentrant replacement rejects stale publication", () => {
    let reentered = false;
    const { coordinator, callbacks } = setup({
      streamStarted: () => {
        expect(coordinator.captureInterruptSettlement()).toBeDefined();
        reentered = true;
        prepare(coordinator);
      },
    });
    const a = prepare(coordinator);
    coordinator.registerOperation(a);
    expect(coordinator.streamStarted(startEvent("A"))).toBe(false);
    expect(reentered).toBe(true);
    expect(coordinator.phase).toBe("preparing");
    expect(callbacks.phaseChanged).not.toHaveBeenCalledWith("streaming", expect.any(Function));
  });
  test("duplicate stream start cannot reopen a raw-terminal completing turn", () => {
    const streamStarted = mock(() => undefined);
    const { coordinator } = setup({ streamStarted });
    const a = prepare(coordinator);
    coordinator.registerOperation(a);
    expect(coordinator.streamStarted(startEvent("A"))).toBe(true);
    expect(coordinator.streamStarted(startEvent("A"))).toBe(false);
    coordinator.rawTerminal("completed", "A");
    expect(coordinator.streamStarted(startEvent("A"))).toBe(false);
    expect(coordinator.phase).toBe("completing");
    expect(streamStarted).toHaveBeenCalledTimes(1);
  });
  test("throwing preemption publication still aborts retired preparation", async () => {
    const { coordinator } = setup({
      phaseChanged: (phase) => {
        if (phase === "idle") throw new Error("observer failed");
      },
    });
    const controller = new AbortController();
    const a = prepare(coordinator, controller);
    const idle = coordinator.waitForIdle();
    expect(() => coordinator.preemptPreparation()).toThrow("observer failed");
    await idle;
    expect(controller.signal.aborted).toBe(true);
    // The old reservation cannot restart an idle owner after preemption.
    expect(coordinator.prepare({ kind: "adopt", turnId: a }).status).toBe("rejected");
  });
  test("fresh admission cannot replace a busy direct owner, but exact queue adoption does not republish", () => {
    const published = mock(() => undefined);
    const { coordinator } = setup({ phaseChanged: published });
    const first = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: coordinator.turnId,
    });
    if (first.status !== "admitted") throw new Error("Expected admission");
    const events = published.mock.calls.length;
    for (const intent of [
      "direct",
      "resume",
      "idle",
      "terminal",
      "provider-tool",
      "send-immediately",
    ] as const) {
      expect(
        coordinator.prepare({ kind: "fresh", intent, expectedTurnId: first.turnId }).status
      ).toBe("deferred");
    }
    expect(coordinator.prepare({ kind: "adopt", turnId: first.turnId })).toEqual(first);
    expect(published.mock.calls).toHaveLength(events);
    coordinator.finishPreparation(first.turnId);
    expect(coordinator.prepare({ kind: "adopt", turnId: first.turnId }).status).toBe("rejected");
  });

  test("a stale handoff cannot install resources or retire its replacement", () => {
    const { coordinator } = setup();
    const first = prepare(coordinator);
    const replacement = prepare(coordinator);
    const installed = mock(() => undefined);
    expect(
      coordinator.prepare(
        { kind: "fresh", intent: "handoff", expectedTurnId: first },
        undefined,
        installed
      )
    ).toEqual({ status: "rejected", reason: "retired" });
    expect(installed).not.toHaveBeenCalled();
    expect(coordinator.turnId).toBe(replacement);
    expect(coordinator.phase).toBe("preparing");
  });

  test("publication retirement returns rejection even when a replacement also publishes PREPARING", () => {
    let replace = true;
    let replacement: TurnId | undefined;
    const { coordinator } = setup({
      phaseChanged: (phase) => {
        if (phase !== "preparing" || !replace) return;
        replace = false;
        replacement = prepare(coordinator);
      },
    });
    const result = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: coordinator.turnId,
    });
    expect(result).toEqual({ status: "rejected", reason: "retired" });
    if (replacement == null) throw new Error("Expected replacement admission");
    expect(coordinator.turnId).toBe(replacement);
    expect(coordinator.phase).toBe("preparing");
  });
  test("only the exact edit reservation can claim its idle replacement", () => {
    const { coordinator } = setup();
    using edit = coordinator.reserve("edit");
    const expectedTurnId = coordinator.turnId;
    for (const editReservation of [undefined, Symbol("unrelated")]) {
      expect(
        coordinator.prepare({ kind: "fresh", intent: "direct", expectedTurnId, editReservation })
      ).toEqual({ status: "deferred", reason: "busy" });
    }
    expect(coordinator.turnId).toBe(expectedTurnId);
    expect(coordinator.prepare({ kind: "fresh", intent: "handoff", expectedTurnId }).status).toBe(
      "deferred"
    );
    expect(
      coordinator.prepare({
        kind: "fresh",
        intent: "direct",
        expectedTurnId,
        editReservation: edit.id,
      }).status
    ).toBe("admitted");
  });
});
