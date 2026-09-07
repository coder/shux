import assert from "@/common/utils/assert";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import type { StreamAbortEvent, StreamStartEvent } from "@/common/types/stream";
import type { TurnCompletion, TurnStreamHandle } from "./streamManager";
import type { ActiveTurnThinkingOverride } from "./thinkingOverride";

export type TurnId = symbol;
export type OperationId = symbol;
export type TurnPhase = "idle" | "preparing" | "streaming" | "completing";
export type StreamErrorRecoveryOutcome = "retry-started" | "terminal";
export type QueueDrainTrigger = "idle" | "terminal" | "provider-tool" | "send-immediately";
export type PreparationRequest =
  | {
      kind: "fresh";
      intent: "direct" | "resume" | "handoff" | QueueDrainTrigger;
      expectedTurnId: TurnId;
      editReservation?: symbol;
      compactionHandoff?: CompactionToken;
    }
  | { kind: "adopt"; turnId: TurnId };
export type PreparationAdmission =
  | { status: "admitted"; turnId: TurnId }
  | { status: "rejected"; reason: "closing" | "blocked" | "retired" }
  | { status: "deferred"; reason: "busy" };

type ReservationKind = "admission" | "edit" | "manual";
type DecisionKind = "error" | "compaction";
type DecisionOutcome = StreamErrorRecoveryOutcome | boolean;

export interface CompactionToken {
  readonly id: symbol;
  readonly epoch: number;
}
type CompactionObservation = CompactionToken & {
  readonly kind: "continuous" | "legacy";
  readonly stage: "observing" | "stopping" | "stopped" | "dispatching";
};
interface CompactionIntent {
  readonly epoch: number;
  readonly status: "ready" | "abandoned";
  readonly observation?: CompactionObservation;
  readonly followUp?: CompactionToken;
  readonly summaryId: string | null;
}

type Operation = {
  readonly id: OperationId;
  readonly startupMessageId?: string;
  readonly startupAbortNotified: boolean;
  readonly compaction: boolean;
  readonly delivery: "waiting" | "policy";
} & (
  | { readonly stage: "registered"; readonly messageId?: string }
  | { readonly stage: "started"; readonly messageId: string }
);

type Turn =
  | {
      readonly phase: "idle";
      readonly id: TurnId;
      readonly observedMessageId?: string;
      readonly operation?: Operation;
    }
  | {
      readonly phase: Exclude<TurnPhase, "idle">;
      readonly id: TurnId;
      readonly observedMessageId?: string;
      readonly operation?: Operation;
    };
interface Decision {
  readonly kind: DecisionKind;
  readonly messageId: string;
  readonly outcome?: DecisionOutcome;
}

/** Lifecycle ownership only. Timers, persistence, queue and recovery policy stay in collaborators. */
export interface CoordinatorState {
  readonly lifetime: "open" | "shutting-down" | "disposed";
  readonly turn: Turn;
  readonly reservations: ReadonlyArray<{ id: symbol; kind: ReservationKind }>;
  readonly retry?: symbol;
  readonly decisions: readonly Decision[];
  readonly compaction: CompactionIntent;
}

export type CoordinatorEvent =
  | { type: "prepare"; id: TurnId; request: PreparationRequest }
  | { type: "finish"; id: TurnId; preparingOnly: boolean }
  | { type: "preempt"; id: TurnId }
  | { type: "forget-compaction"; messageId: string }
  | { type: "register"; id: OperationId; turnId: TurnId }
  | { type: "configure-operation"; id: OperationId; compaction: boolean }
  | { type: "starting"; id: OperationId; messageId: string }
  | { type: "started"; payload: StreamStartEvent }
  | { type: "observe-stream"; messageId: string }
  | { type: "finish-observed-stream"; id: TurnId; messageId: string }
  | { type: "raw-terminal"; kind: "completed" | "aborted"; messageId: string }
  | { type: "startup-abort"; messageId: string }
  | { type: "completion"; id: OperationId; messageId: string; outcome: TurnCompletion }
  | { type: "complete-policy"; id: TurnId }
  | { type: "reserve" | "release"; id: symbol; kind: ReservationKind }
  | { type: "retry-start" | "retry-finish"; id: symbol }
  | { type: "decision"; kind: DecisionKind; messageId: string; outcome?: DecisionOutcome }
  | { type: "compaction-observe"; token: CompactionToken; kind: CompactionObservation["kind"] }
  | { type: "compaction-stage"; token: CompactionToken; stage: CompactionObservation["stage"] }
  | { type: "compaction-finish"; token: CompactionToken }
  | { type: "compaction-invalidate"; abandon: boolean }
  | {
      type: "compaction-follow-up" | "compaction-follow-up-cleanup" | "compaction-follow-up-finish";
      token: CompactionToken;
    }
  | { type: "compaction-summary"; summaryId: string | null }
  | { type: "shutdown" | "dispose" };

type CoordinatorCommand =
  | { type: "phase"; previous: Turn; next: Turn }
  | { type: "retire"; id: OperationId }
  | { type: "record-start"; turnId: TurnId; payload: StreamStartEvent }
  | {
      type: "policy";
      id: OperationId;
      messageId: string;
      outcome: TurnCompletion;
      started: boolean;
      notifyStartup: boolean;
    }
  | { type: "decision"; decision: Decision }
  | { type: "drain"; turnId: TurnId }
  | { type: "dispose" };

export function initialCoordinatorState(id: TurnId): CoordinatorState {
  return {
    lifetime: "open",
    turn: { phase: "idle", id },
    reservations: [],
    decisions: [],
    compaction: { epoch: 0, status: "ready", summaryId: null },
  };
}

function hasConflictingEdit(state: CoordinatorState, owner?: symbol): boolean {
  return state.reservations.some((entry) => entry.kind === "edit" && entry.id !== owner);
}

/** Pure transition seam: stale events cannot publish, launch policy, or release another owner. */
export function transition(
  state: CoordinatorState,
  event: CoordinatorEvent
): {
  state: CoordinatorState;
  commands: readonly CoordinatorCommand[];
  admission?: PreparationAdmission;
} {
  const commands: CoordinatorCommand[] = [];
  let next = state;
  let admission: PreparationAdmission | undefined;
  const phase = (turn: Turn) => {
    const previous = next.turn;
    next = { ...next, turn };
    commands.push({ type: "phase", previous, next: turn });
  };
  const operation = (value: Operation) => {
    next = { ...next, turn: { ...next.turn, operation: value } };
  };
  const decision = (kind: DecisionKind, messageId: string, outcome?: DecisionOutcome) => {
    const previous = next.decisions.find(
      (entry) => entry.kind === kind && entry.messageId === messageId
    );
    if (previous?.outcome != null || (previous != null && outcome == null)) return;
    // Resolution never creates a missing decision: a late fallback cannot resurrect a consumed one.
    if (previous == null && outcome != null) return;
    const value = { kind, messageId, outcome };
    let retained = [...next.decisions];
    if (previous != null) retained = retained.map((entry) => (entry === previous ? value : entry));
    else {
      // Error outcomes retain insertion order for late observers; never evict a pending waiter.
      const maxRetainedDecisions = 8;
      if (kind === "error") {
        for (const entry of retained) {
          if (
            retained.filter((candidate) => candidate.kind === "error").length < maxRetainedDecisions
          )
            break;
          if (entry.kind === "error" && entry.outcome != null)
            retained = retained.filter((candidate) => candidate !== entry);
        }
      }
      retained.push(value);
    }
    next = { ...next, decisions: retained };
    commands.push({ type: "decision", decision: value });
  };
  const current = state.turn.operation;
  // A retained Stop cleanup may finish while destructive disposal drains its lease.
  // Only its exact release remains legal; disposal never admits new work.
  if (state.lifetime === "disposed" && event.type !== "compaction-follow-up-finish")
    return {
      state,
      commands,
      ...(event.type === "prepare"
        ? { admission: { status: "rejected", reason: "closing" } as const }
        : {}),
    };
  switch (event.type) {
    case "prepare": {
      if (state.lifetime !== "open") {
        admission = { status: "rejected", reason: "closing" };
        break;
      }
      if (state.reservations.some((entry) => entry.kind === "admission")) {
        admission = { status: "rejected", reason: "blocked" };
        break;
      }
      const request = event.request;
      // An edit owns history before PREPARING. Only its exact reservation can claim the
      // replacement; sharing the idle turn epoch never authorizes a competing send.
      const editOwner =
        request.kind === "fresh" && request.intent === "direct"
          ? request.editReservation
          : undefined;
      if (hasConflictingEdit(state, editOwner)) {
        admission = { status: "deferred", reason: "busy" };
        break;
      }
      if (request.kind === "adopt") {
        if (state.turn.id !== request.turnId || state.turn.phase !== "preparing") {
          admission = { status: "rejected", reason: "retired" };
          break;
        }
        // Adoption attaches startup to the exact queued owner, without retiring or republishing it.
      } else {
        if (state.turn.id !== request.expectedTurnId) {
          admission = { status: "rejected", reason: "retired" };
          break;
        }
        const idleOnly = request.intent === "resume" || request.intent === "idle";
        const queue =
          request.intent === "terminal" ||
          request.intent === "provider-tool" ||
          request.intent === "send-immediately" ||
          request.intent === "idle";
        if (
          (idleOnly && state.turn.phase !== "idle") ||
          ((queue || request.intent === "direct") && state.turn.phase === "preparing") ||
          (request.intent === "direct" && state.turn.phase === "streaming")
        ) {
          admission = { status: "deferred", reason: "busy" };
          break;
        }
        const handoff = request.compactionHandoff;
        if (handoff != null) {
          if (
            state.compaction.status !== "ready" ||
            handoff.epoch !== state.compaction.epoch ||
            (state.compaction.observation?.id !== handoff.id &&
              state.compaction.followUp?.id !== handoff.id)
          ) {
            admission = { status: "rejected", reason: "retired" };
            break;
          }
          // This admission belongs to the captured handoff. It changes TurnId, but
          // must keep the source intent alive until actual send acceptance is known.
        } else {
          next = {
            ...next,
            compaction: {
              epoch: state.compaction.epoch + 1,
              status: "ready",
              summaryId: null,
            },
          };
        }
        if (current) commands.push({ type: "retire", id: current.id });
        phase({ phase: "preparing", id: event.id });
      }
      admission = { status: "admitted", turnId: event.id };
      break;
    }
    case "preempt":
      if (state.turn.id !== event.id || state.turn.phase !== "preparing") break;
      if (current) commands.push({ type: "retire", id: current.id });
      phase({ phase: "idle", id: event.id });
      break;
    case "forget-compaction":
      next = {
        ...state,
        decisions: state.decisions.filter(
          (entry) => entry.kind !== "compaction" || entry.messageId !== event.messageId
        ),
      };
      break;
    case "finish":
      if (state.turn.phase === "idle") break;
      if (state.turn.id !== event.id || (event.preparingOnly && state.turn.phase !== "preparing"))
        break;
      phase({ ...state.turn, phase: "idle" });
      break;
    case "register":
      if (state.lifetime !== "open" || state.turn.id !== event.turnId) break;
      if (current) commands.push({ type: "retire", id: current.id });
      operation({
        id: event.id,
        stage: "registered",
        startupAbortNotified: false,
        compaction: false,
        delivery: "waiting",
      });
      break;
    case "configure-operation":
      if (current?.id === event.id) operation({ ...current, compaction: event.compaction });
      break;
    case "starting":
      if (current?.id === event.id) operation({ ...current, startupMessageId: event.messageId });
      break;
    case "observe-stream":
      if (
        state.lifetime === "open" &&
        !current &&
        state.turn.observedMessageId == null &&
        (state.turn.phase === "idle" || state.turn.phase === "streaming")
      )
        phase({ ...state.turn, phase: "streaming", observedMessageId: event.messageId });
      break;
    case "finish-observed-stream":
      if (
        !current &&
        state.turn.id === event.id &&
        state.turn.observedMessageId === event.messageId
      ) {
        phase({ id: state.turn.id, phase: "idle" });
        commands.push({ type: "drain", turnId: state.turn.id });
      }
      break;
    case "started":
      if (current && (current.delivery !== "waiting" || current.stage === "started")) break;
      if (current?.delivery === "waiting") {
        operation({ ...current, stage: "started", messageId: event.payload.messageId });
      }
      if (next.compaction.status === "abandoned")
        next = {
          ...next,
          compaction: {
            epoch: next.compaction.epoch + 1,
            status: "ready",
            summaryId: null,
          },
        };
      commands.push({ type: "record-start", turnId: state.turn.id, payload: event.payload });
      // Existing raw streams also restore sessions constructed around an already-running engine.
      phase({ ...next.turn, phase: "streaming" });
      break;
    case "raw-terminal":
      if (current?.messageId !== event.messageId || current.delivery !== "waiting") break;
      if (event.kind === "completed" && current.compaction) decision("compaction", event.messageId);
      if (current.stage === "started" && state.turn.phase === "streaming")
        phase({ ...next.turn, phase: "completing" });
      break;
    case "startup-abort":
      if (
        current &&
        (!event.messageId ||
          (current.startupMessageId === event.messageId && !current.startupAbortNotified))
      ) {
        operation({ ...current, startupAbortNotified: true });
      }
      break;
    case "completion":
      if (current?.id !== event.id || current.delivery !== "waiting") break;
      operation({
        ...current,
        messageId: event.messageId,
        delivery: "policy",
        startupAbortNotified:
          current.startupAbortNotified ||
          (current.stage === "registered" &&
            event.outcome.status === "aborted" &&
            event.outcome.streamAbort != null),
      });
      commands.push({
        type: "policy",
        id: event.id,
        messageId: event.messageId,
        outcome: event.outcome,
        started: current.stage === "started",
        notifyStartup: !current.startupAbortNotified,
      });
      break;
    case "complete-policy":
      if (state.turn.id === event.id) phase({ ...state.turn, phase: "completing" });
      break;
    case "reserve":
      if (state.reservations.some((entry) => entry.id === event.id)) break;
      next = {
        ...state,
        reservations: [...state.reservations, { id: event.id, kind: event.kind }],
      };
      break;
    case "release":
      if (!state.reservations.some((entry) => entry.id === event.id && entry.kind === event.kind))
        break;
      next = {
        ...state,
        reservations: state.reservations.filter((entry) => entry.id !== event.id),
      };
      if (
        event.kind !== "manual" &&
        state.turn.phase === "idle" &&
        !next.reservations.some((entry) => entry.kind === event.kind)
      ) {
        commands.push({ type: "drain", turnId: state.turn.id });
      }
      break;
    case "retry-start":
      next = { ...state, retry: event.id };
      break;
    case "retry-finish":
      if (state.retry === event.id) next = { ...state, retry: undefined };
      break;
    case "decision":
      decision(event.kind, event.messageId, event.outcome);
      break;
    case "compaction-observe":
      if (
        state.lifetime === "open" &&
        !state.compaction.observation &&
        state.compaction.status === "ready" &&
        event.token.epoch === state.compaction.epoch
      )
        next = {
          ...state,
          compaction: {
            ...state.compaction,
            observation: { ...event.token, kind: event.kind, stage: "observing" },
          },
        };
      break;
    case "compaction-stage":
      if (
        state.compaction.observation?.id === event.token.id &&
        state.compaction.epoch === event.token.epoch
      )
        next = {
          ...state,
          compaction: {
            ...state.compaction,
            observation: { ...state.compaction.observation, stage: event.stage },
          },
        };
      break;
    case "compaction-finish":
      if (state.compaction.observation?.id === event.token.id)
        next = { ...state, compaction: { ...state.compaction, observation: undefined } };
      break;
    case "compaction-invalidate":
      next = {
        ...state,
        compaction: {
          ...state.compaction,
          epoch: state.compaction.epoch + 1,
          // Abandonment belongs to this canceled epoch, not a replacement context.
          status: event.abandon ? "abandoned" : "ready",
          // User Stop retains only cleanup ownership for its just-committed boundary.
          // Context mutation retires semantic observation immediately; physical leases remain.
          observation: event.abandon ? state.compaction.observation : undefined,
          followUp: event.abandon ? state.compaction.followUp : undefined,
          summaryId: null,
        },
      };
      break;
    case "compaction-follow-up":
    case "compaction-follow-up-cleanup":
      if (
        (state.lifetime === "open" ||
          (state.lifetime === "shutting-down" && event.type === "compaction-follow-up-cleanup")) &&
        state.compaction.status ===
          (event.type === "compaction-follow-up" ? "ready" : "abandoned") &&
        !state.compaction.followUp &&
        event.token.epoch === state.compaction.epoch
      )
        next = { ...state, compaction: { ...state.compaction, followUp: event.token } };
      break;
    case "compaction-follow-up-finish":
      if (state.compaction.followUp?.id === event.token.id)
        next = { ...state, compaction: { ...state.compaction, followUp: undefined } };
      break;
    case "compaction-summary":
      next = { ...state, compaction: { ...state.compaction, summaryId: event.summaryId } };
      break;
    case "shutdown":
      next = { ...state, lifetime: "shutting-down" };
      break;
    case "dispose":
      next = { ...state, lifetime: "disposed", retry: undefined, reservations: [] };
      for (const entry of state.decisions)
        decision(entry.kind, entry.messageId, entry.kind === "error" ? "terminal" : false);
      if (current) commands.push({ type: "retire", id: current.id });
      phase({ phase: "idle", id: state.turn.id });
      commands.push({ type: "dispose" });
      break;
  }
  return { state: next, commands, admission };
}

interface CoordinatorCallbacks {
  streamStarted?: (payload: StreamStartEvent) => void;
  phaseChanged: (phase: TurnPhase, isCurrent: () => boolean) => void;
  drainQueue: () => void;
  policy: (
    id: OperationId,
    messageId: string,
    outcome: TurnCompletion,
    started: boolean,
    notifyStartup: boolean
  ) => Promise<void>;
  policyError: (error: unknown) => void;
}

/** Physical resources only: the reducer remains the authority for admission and turn ownership. */
class TurnExecution {
  private readonly scope = Scope.makeUnsafe("parallel");
  // Registered producers may add correlated terminal work while closing. The app retains its
  // bounded shutdown: timing out this drain does not cancel non-cooperative Promise I/O.
  private readonly pending = new Set<Promise<void>>();
  private readonly policies = new Set<Fiber.Fiber<void>>();
  private guardian?: Fiber.Fiber<void>;
  private closePromise?: Promise<void>;

  constructor(private runner: EffectRunner) {}

  lease(): Disposable {
    const settled = Promise.withResolvers<void>();
    this.pending.add(settled.promise);
    return {
      [Symbol.dispose]: () => {
        this.pending.delete(settled.promise);
        settled.resolve();
      },
    };
  }

  resource(release: () => void): Disposable {
    const scope = this.runner.runSync(Scope.fork(this.scope, "sequential"));
    this.runner.runSync(Scope.addFinalizer(scope, Effect.sync(release)));
    return { [Symbol.dispose]: () => this.runner.runSync(Scope.close(scope, Exit.void)) };
  }

  supervise(runner: EffectRunner, appScope: Scope.Scope | undefined, shutdown: () => void): void {
    assert(this.guardian == null, "Turn execution supervision already attached");
    this.runner = runner;
    // The session calls this only after its collaborators exist. A closed parent interrupts
    // synchronously, latching shutdown before a newly constructed session can accept a send.
    const guardian = Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(shutdown).pipe(Effect.ensuring(Effect.promise(() => this.close())))
      )
    );
    this.guardian = appScope
      ? this.runner.runSync(Effect.forkIn(guardian, appScope, { startImmediately: true }))
      : this.runner.runFork(guardian);
  }

  requestClose(): void {
    if (this.guardian) this.guardian.interruptUnsafe();
    else this.runner.runFork(Effect.promise(() => this.close()));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closed = Promise.withResolvers<void>();
    // Publish the close latch before interrupting fibers: their finalizers can reenter disposal.
    this.closePromise = closed.promise;
    this.runner
      .runPromise(
        Effect.gen({ self: this }, function* () {
          // Interruption cannot cancel existing Promise I/O. Policy finalizers join the exact
          // original Promise before releasing resources. Late terminals still have an open scope.
          for (const fiber of this.policies) fiber.interruptUnsafe();
          while (this.pending.size > 0) {
            yield* Effect.promise(() => Promise.all([...this.pending]));
          }
          // Engine supervisors close in parallel with the guardian. A direct child policy scope
          // would close before those engines deliver their final abort, silently losing policy.
          yield* Scope.close(this.scope, Exit.void);
        })
      )
      .then(closed.resolve, closed.reject);
    return closed.promise;
  }

  policy(
    start: () => Promise<void>,
    finalize: () => void,
    report: (error: unknown) => void
  ): Promise<void> {
    const lease = this.lease();
    let original: Promise<void> | undefined;
    const program = Effect.tryPromise({
      try: () => (original = start()),
      catch: (error) => error,
    }).pipe(
      Effect.onInterrupt(() => {
        const started = original;
        return started
          ? Effect.tryPromise({ try: () => started, catch: (error) => error }).pipe(
              Effect.catch((error) => Effect.sync(() => report(error)))
            )
          : Effect.void;
      }),
      Effect.catch((error) => Effect.sync(() => report(error))),
      Effect.ensuring(
        Effect.sync(() => {
          try {
            finalize();
          } finally {
            lease[Symbol.dispose]();
          }
        })
      )
    );
    // rc112 requires startImmediately to preserve callback execution through its first await.
    const fiber = this.runner.runSync(
      Effect.forkIn(program, this.scope, { startImmediately: true })
    );
    this.policies.add(fiber);
    fiber.addObserver(() => this.policies.delete(fiber));
    return this.runner.runPromise(Fiber.await(fiber)).then((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) report(exit.cause);
    });
  }
}

/**
 * The sole owner of lifecycle state and runtime registries. Dispatch publishes state before any
 * callback; cleanup captures retired resources before publication so observer reentrancy is safe.
 * Promise policy is deliberately outside the engine sink: a follow-up can await engine cleanup.
 */
export class TurnCoordinator {
  private state = initialCoordinatorState(Symbol("idle"));
  private readonly closingController = new AbortController();
  get closingSignal(): AbortSignal {
    return this.closingController.signal;
  }
  private readonly settlements = new Map<
    OperationId,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  private readonly decisions = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<DecisionOutcome>>
  >();
  private idleWaiters = new Set<() => void>();
  private unbusyWaiters = new Set<() => void>();
  private admissionWaiters = new Set<() => void>();
  private prepared?: { id: TurnId; controller: AbortController };
  private thinking: { holder: ActiveTurnThinkingOverride; resource?: Disposable } | null = null;
  private readonly execution = new TurnExecution(defaultEffectRunner);
  private readonly operations = new Map<OperationId, Disposable>();

  constructor(private readonly callbacks: CoordinatorCallbacks) {}

  /** Attach after AgentSession initialization, including when the app scope is already closed. */
  supervise(runner: EffectRunner, scope: Scope.Scope | undefined, shutdown: () => void): void {
    this.execution.supervise(runner, scope, shutdown);
  }

  /** An opaque physical lease must never reserve semantic admission or change queue priority. */
  enterExecution(): Disposable {
    return this.execution.lease();
  }

  get compactionIntent(): CompactionIntent {
    return this.state.compaction;
  }

  beginCompactionObservation(kind: CompactionObservation["kind"]): CompactionToken | undefined {
    if (this.admissionBlocked || this.editReserved) return undefined;
    const token = { id: Symbol("compaction observation"), epoch: this.state.compaction.epoch };
    this.dispatch({ type: "compaction-observe", token, kind });
    return this.state.compaction.observation?.id === token.id ? token : undefined;
  }

  isCurrentCompaction(token: CompactionToken): boolean {
    return (
      !this.closing &&
      this.state.compaction.status === "ready" &&
      token.epoch === this.state.compaction.epoch &&
      (this.state.compaction.observation?.id === token.id ||
        this.state.compaction.followUp?.id === token.id)
    );
  }

  setCompactionStage(token: CompactionToken, stage: CompactionObservation["stage"]): void {
    this.dispatch({ type: "compaction-stage", token, stage });
  }

  finishCompactionObservation(token: CompactionToken): boolean {
    const owns = this.state.compaction.observation?.id === token.id;
    this.dispatch({ type: "compaction-finish", token });
    return owns;
  }

  invalidateCompaction(abandon = this.state.compaction.status === "abandoned"): void {
    this.dispatch({ type: "compaction-invalidate", abandon });
  }

  claimCompactionFollowUp(): CompactionToken | undefined {
    const token = { id: Symbol("compaction follow-up"), epoch: this.state.compaction.epoch };
    this.dispatch({ type: "compaction-follow-up", token });
    return this.state.compaction.followUp?.id === token.id ? token : undefined;
  }

  claimCompactionFollowUpCleanup(): CompactionToken | undefined {
    // Stop may precede the first dispatch claim. This owner can only clear the
    // abandoned durable intent; it is never current or admissible for sending.
    const token = {
      id: Symbol("compaction follow-up cleanup"),
      epoch: this.state.compaction.epoch,
    };
    this.dispatch({ type: "compaction-follow-up-cleanup", token });
    return this.state.compaction.followUp?.id === token.id ? token : undefined;
  }

  finishCompactionFollowUp(token: CompactionToken): void {
    this.dispatch({ type: "compaction-follow-up-finish", token });
  }

  canClearCompactionFollowUp(token: CompactionToken): boolean {
    // Closing forbids dispatch, but cannot revoke Stop cleanup already joined
    // by a physical lease. Replacement still retires the exact token.
    return (
      this.state.compaction.followUp?.id === token.id &&
      (!this.closing || this.state.compaction.status === "abandoned")
    );
  }

  recordCompactionSummary(summaryId: string | null): void {
    this.dispatch({ type: "compaction-summary", summaryId });
  }

  /** Physical completion, distinct from semantic idle and operation policy settlement. */
  drain(): Promise<void> {
    return this.execution.close();
  }

  get phase(): TurnPhase {
    return this.state.turn.phase;
  }
  get turnId(): TurnId {
    return this.state.turn.id;
  }
  get operationId(): OperationId | undefined {
    return this.state.turn.operation?.id;
  }
  get terminalMessageId(): string | undefined {
    const operation = this.state.turn.operation;
    return operation?.messageId ?? operation?.startupMessageId;
  }
  get disposed(): boolean {
    return this.state.lifetime === "disposed";
  }
  get closing(): boolean {
    return this.state.lifetime !== "open";
  }
  get admissionBlocked(): boolean {
    return this.hasReservation("admission");
  }
  get editReserved(): boolean {
    return this.hasReservation("edit");
  }
  editBlocked(owner?: symbol): boolean {
    return hasConflictingEdit(this.state, owner);
  }
  get manualFollowUpPending(): boolean {
    return this.hasReservation("manual");
  }
  get retryStarting(): boolean {
    return this.state.retry != null;
  }
  get thinkingOverride(): ActiveTurnThinkingOverride | null {
    return this.thinking?.holder ?? null;
  }
  isBusy(): boolean {
    return this.phase !== "idle" || this.editReserved;
  }
  isCurrentTurn(id: TurnId): boolean {
    return !this.disposed && this.turnId === id;
  }
  isCurrentOperation(id: OperationId | undefined): boolean {
    return !this.disposed && this.operationId === id;
  }

  private hasReservation(kind: ReservationKind): boolean {
    return this.state.reservations.some((entry) => entry.kind === kind);
  }

  private dispatch(
    event: Extract<CoordinatorEvent, { type: "prepare" }>,
    install: () => void
  ): PreparationAdmission;
  private dispatch(
    event: Extract<CoordinatorEvent, { type: "completion" }>
  ): Promise<void> | undefined;
  private dispatch(event: Exclude<CoordinatorEvent, { type: "completion" }>): void;
  private dispatch(
    event: CoordinatorEvent,
    install?: () => void
  ): Promise<void> | PreparationAdmission | undefined {
    let launchedPolicy: Promise<void> | undefined;
    let publicationError: { error: unknown } | undefined;
    const previousCompactionEpoch = this.state.compaction.epoch;
    const result = transition(this.state, event);
    this.state = result.state;
    if (result.admission?.status === "admitted") install?.();
    // Detach before *any* callback. An idle observer may synchronously admit a new turn and waiter.
    const idle = result.commands.some(
      (command) => command.type === "phase" && command.next.phase === "idle"
    );
    const waiters = idle ? this.idleWaiters : undefined;
    const admissionWaiters =
      !this.admissionBlocked ||
      this.closing ||
      previousCompactionEpoch !== this.state.compaction.epoch
        ? this.admissionWaiters
        : undefined;
    if (admissionWaiters) this.admissionWaiters = new Set();
    const unbusyWaiters = !this.isBusy() ? this.unbusyWaiters : undefined;
    if (unbusyWaiters) this.unbusyWaiters = new Set();
    const retiredThinking = idle ? this.thinking : undefined;
    const retiredPrepared =
      idle && this.prepared?.id === result.state.turn.id ? this.prepared : undefined;
    if (idle) {
      this.idleWaiters = new Set();
      this.thinking = null;
      if (this.prepared?.id === result.state.turn.id) this.prepared = undefined;
    }
    for (const command of result.commands) {
      switch (command.type) {
        case "phase": {
          const isCurrent = () =>
            this.state.turn.id === command.next.id &&
            this.phase === command.next.phase &&
            !this.disposed;
          if (isCurrent() || (event.type === "dispose" && this.disposed)) {
            try {
              this.callbacks.phaseChanged(command.next.phase, isCurrent);
            } catch (error) {
              publicationError ??= { error };
            }
          }
          break;
        }
        case "record-start":
          if (this.isCurrentTurn(command.turnId)) this.callbacks.streamStarted?.(command.payload);
          break;
        case "retire":
          this.settleOperation(command.id);
          break;
        case "decision": {
          const key = this.decisionKey(command.decision.kind, command.decision.messageId);
          if (command.decision.outcome == null)
            this.decisions.set(key, Promise.withResolvers<DecisionOutcome>());
          else this.decisions.get(key)?.resolve(command.decision.outcome);
          break;
        }
        case "policy":
          if (this.isCurrentOperation(command.id)) {
            launchedPolicy = this.execution.policy(
              () =>
                this.callbacks.policy(
                  command.id,
                  command.messageId,
                  command.outcome,
                  command.started,
                  command.notifyStartup
                ),
              () => {
                this.resolveErrorDecision(command.messageId, "terminal");
                this.resolveCompactionDecision(command.messageId, false);
                this.settleOperation(command.id);
              },
              this.callbacks.policyError
            );
          }
          break;
        case "drain":
          if (
            this.state.lifetime === "open" &&
            this.isCurrentTurn(command.turnId) &&
            !this.isBusy() &&
            !this.admissionBlocked
          )
            this.callbacks.drainQueue();
          break;
        case "dispose": {
          const prepared = retiredPrepared ?? this.prepared;
          this.prepared = undefined;
          prepared?.controller.abort();
          for (const id of this.settlements.keys()) this.settleOperation(id);
          break;
        }
      }
    }
    for (const resolve of admissionWaiters ?? []) resolve();
    for (const resolve of waiters ?? []) resolve();
    for (const resolve of unbusyWaiters ?? []) resolve();
    retiredThinking?.resource?.[Symbol.dispose]();
    // Outcomes live in pure state; the registry holds resources only, including pending waiters.
    const keys = new Set(
      this.state.decisions.map((entry) => this.decisionKey(entry.kind, entry.messageId))
    );
    for (const key of this.decisions.keys()) if (!keys.has(key)) this.decisions.delete(key);
    // Publication failures retain their original propagation, but cannot orphan the detached
    // batch or skip disposal's retired resources. A later dispose no longer owns that batch.
    if (publicationError) throw publicationError.error;
    return result.admission ?? launchedPolicy;
  }

  prepare(
    request: PreparationRequest,
    controller?: AbortController,
    install?: (turnId: TurnId) => void
  ): PreparationAdmission {
    const id = request.kind === "adopt" ? request.turnId : Symbol("turn");
    let admission: PreparationAdmission;
    try {
      admission = this.dispatch({ type: "prepare", id, request }, () => {
        // Ownership and abort resources precede callbacks, including synchronous shutdown.
        this.prepared = controller ? { id, controller } : undefined;
        install?.(id);
      });
    } catch (error) {
      if (!install) this.finishPreparation(id);
      throw error;
    }
    // A PREPARING observer can retire this claim before dispatch returns. Never signal a
    // service preflight handoff or dequeue on the strength of that obsolete publication.
    if (
      admission.status === "admitted" &&
      (!this.isCurrentTurn(id) || this.closing || this.phase !== "preparing")
    )
      return { status: "rejected", reason: "retired" };
    return admission;
  }

  finishPreparation(id: TurnId): void {
    if (this.prepared?.id === id) this.prepared = undefined;
    this.dispatch({ type: "finish", id, preparingOnly: true });
  }

  preemptPreparation(): boolean {
    if (this.phase !== "preparing" || this.prepared?.id !== this.turnId) return false;
    const prepared = this.prepared;
    this.prepared = undefined;
    // Invalidate before abort callbacks or lifecycle observers can admit the replacement.
    try {
      this.dispatch({ type: "preempt", id: prepared.id });
    } finally {
      prepared.controller.abort();
    }
    return true;
  }

  finishTurn(id: TurnId): void {
    this.dispatch({ type: "finish", id, preparingOnly: false });
  }
  beginPolicy(id: TurnId): void {
    this.dispatch({ type: "complete-policy", id });
  }
  acceptThinkingOverride(holder: ActiveTurnThinkingOverride, turnId: TurnId): void {
    if (!this.isCurrentTurn(turnId)) return;
    this.thinking?.resource?.[Symbol.dispose]();
    const thinking: NonNullable<typeof this.thinking> = { holder };
    this.thinking = thinking;
    thinking.resource = this.execution.resource(() => {
      if (this.thinking === thinking) this.thinking = null;
    });
  }
  releaseThinkingOverride(holder: ActiveTurnThinkingOverride): void {
    if (this.thinking?.holder === holder) this.thinking.resource?.[Symbol.dispose]();
  }
  beginShutdown(): void {
    this.dispatch({ type: "shutdown" });
    this.closingController.abort();
    // Lifetime waits must retire before physical leases: a leased retry/startup callback
    // can be waiting for idle itself. This does not publish semantic idle or drain jobs.
    const waiters = this.idleWaiters;
    this.idleWaiters = new Set();
    for (const finish of waiters) finish();
    const unbusyWaiters = this.unbusyWaiters;
    this.unbusyWaiters = new Set();
    for (const finish of unbusyWaiters) finish();
  }
  dispose(): void {
    this.beginShutdown();
    try {
      this.dispatch({ type: "dispose" });
    } finally {
      this.execution.requestClose();
    }
  }

  reserve(kind: ReservationKind): Disposable & { readonly id: symbol } {
    const id = Symbol(kind);
    this.dispatch({ type: "reserve", id, kind });
    return { id, [Symbol.dispose]: () => this.dispatch({ type: "release", id, kind }) };
  }

  registerManualFollowUp(signal?: AbortSignal): () => void {
    assert(
      signal == null || typeof signal.aborted === "boolean",
      "registerExternalManualFollowUp signal must be an AbortSignal"
    );
    if (signal?.aborted) throw new Error("External manual follow-up canceled.");
    const reservation = this.reserve("manual");
    const release = () => {
      signal?.removeEventListener("abort", release);
      reservation[Symbol.dispose]();
    };
    signal?.addEventListener("abort", release, { once: true });
    return release;
  }

  /** Admission holds are policy waits, not physical work joined by shutdown. */
  waitForAdmissionRelease(): Promise<void> {
    if (!this.admissionBlocked || this.closing) return Promise.resolve();
    return new Promise((resolve) => this.admissionWaiters.add(resolve));
  }

  waitForIdle(signal?: AbortSignal): Promise<void> {
    return this.waitForIdleState(false, signal);
  }

  /** Recovery also waits for edits which reserve history while the visible phase stays idle. */
  waitForUnbusy(signal?: AbortSignal): Promise<void> {
    return this.waitForIdleState(true, signal);
  }

  private waitForIdleState(includeEdits: boolean, signal?: AbortSignal): Promise<void> {
    assert(
      signal == null || typeof signal.aborted === "boolean",
      "waitForIdle signal must be an AbortSignal"
    );
    if (signal?.aborted) return Promise.reject(new Error("Waiting for session idle canceled."));
    if ((includeEdits ? !this.isBusy() : this.phase === "idle") || this.closing)
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const batch = includeEdits ? this.unbusyWaiters : this.idleWaiters;
      let canceled = false;
      const finish = () => resource[Symbol.dispose]();
      const abort = () => {
        canceled = true;
        finish();
      };
      batch.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
      // Session scope finalization also releases waiters without a future idle publication.
      // Capture this batch: closing a retired waiter must never delete a replacement's waiter.
      const resource = this.execution.resource(() => {
        signal?.removeEventListener("abort", abort);
        batch.delete(finish);
        if (canceled) reject(new Error("Waiting for session idle canceled."));
        else resolve();
      });
    });
  }

  beginRetry(): symbol {
    const id = Symbol("retry");
    this.dispatch({ type: "retry-start", id });
    return id;
  }
  finishRetry(id: symbol): void {
    this.dispatch({ type: "retry-finish", id });
  }
  registerOperation(turnId: TurnId): OperationId {
    const id = Symbol("operation");
    this.settlements.set(id, Promise.withResolvers<void>());
    this.operations.set(id, this.enterExecution());
    this.dispatch({ type: "register", id, turnId });
    if (!this.isCurrentOperation(id)) this.finishStartup(id);
    return id;
  }
  configureOperation(id: OperationId, compaction: boolean): void {
    this.dispatch({ type: "configure-operation", id, compaction });
  }
  streamStarting(id: OperationId, messageId: string): void {
    this.dispatch({ type: "starting", id, messageId });
  }
  observeStreamReplay(messageId: string): boolean {
    if (!this.canReplayStreamStart(messageId)) return false;
    this.dispatch({ type: "observe-stream", messageId });
    return this.canReplayStreamStart(messageId);
  }

  finishObservedStream(messageId: string, publish: () => void): boolean {
    const turn = this.state.turn;
    if (turn.operation || turn.observedMessageId !== messageId) return false;
    try {
      publish();
    } finally {
      this.dispatch({ type: "finish-observed-stream", id: turn.id, messageId });
    }
    return true;
  }

  canReplayStreamStart(messageId: string): boolean {
    if (this.closing) return false;
    const operation = this.state.turn.operation;
    // A newly constructed session can observe an existing engine without owning
    // its operation. The caller also verifies the engine's current message ID.
    if (!operation)
      return (
        this.phase === "idle" ||
        (this.phase === "streaming" &&
          (this.state.turn.observedMessageId == null ||
            this.state.turn.observedMessageId === messageId))
      );
    return (
      this.phase === "streaming" &&
      operation.stage === "started" &&
      operation.delivery === "waiting" &&
      operation.messageId === messageId
    );
  }

  streamStarted(payload: StreamStartEvent): boolean {
    const previous = this.state;
    const turn = this.turnId;
    this.dispatch({ type: "started", payload });
    return (
      this.state !== previous &&
      this.isCurrentTurn(turn) &&
      this.phase === "streaming" &&
      (this.state.turn.operation == null ||
        this.state.turn.operation.messageId === payload.messageId)
    );
  }
  rawTerminal(kind: "completed" | "aborted", messageId: string): void {
    this.dispatch({ type: "raw-terminal", kind, messageId });
  }
  observeStartupAbort(payload: StreamAbortEvent): boolean {
    const operation = this.state.turn.operation;
    const notify =
      !payload.messageId ||
      (operation?.startupMessageId === payload.messageId && !operation.startupAbortNotified);
    if (notify && !this.disposed)
      this.dispatch({ type: "startup-abort", messageId: payload.messageId });
    return notify && !this.disposed;
  }

  captureInterruptSettlement(soft?: boolean): Promise<void> | undefined {
    const operation = this.state.turn.operation;
    return !soft && operation?.stage === "started"
      ? this.settlements.get(operation.id)?.promise
      : undefined;
  }
  finishStartup(id: OperationId): void {
    this.settleOperation(id);
    this.operations.get(id)?.[Symbol.dispose]();
    this.operations.delete(id);
  }
  private settleOperation(id: OperationId): void {
    this.settlements.get(id)?.resolve();
    this.settlements.delete(id);
  }
  consumeCompletion(id: OperationId, handle: TurnStreamHandle): Promise<void> {
    return handle.completion
      .then((outcome) => {
        if (!this.isCurrentOperation(id)) {
          this.resolveErrorDecision(handle.messageId, "terminal");
          this.resolveCompactionDecision(handle.messageId, false);
          this.settleOperation(id);
          return;
        }
        return this.dispatch({ type: "completion", id, messageId: handle.messageId, outcome });
      })
      .catch((error: unknown) => {
        this.settleOperation(id);
        this.callbacks.policyError(error);
      })
      .finally(() => this.finishStartup(id));
  }

  private decisionKey(kind: DecisionKind, messageId: string): string {
    return `${kind}:${messageId}`;
  }
  beginErrorDecision(messageId: string): void {
    this.dispatch({ type: "decision", kind: "error", messageId });
  }
  resolveErrorDecision(messageId: string, outcome: StreamErrorRecoveryOutcome): void {
    this.dispatch({ type: "decision", kind: "error", messageId, outcome });
  }
  resolveCompactionDecision(messageId: string, outcome: boolean): void {
    this.dispatch({ type: "decision", kind: "compaction", messageId, outcome });
  }
  async waitForErrorDecision(messageId: string): Promise<StreamErrorRecoveryOutcome | undefined> {
    const decision = this.state.decisions.find(
      (entry) => entry.kind === "error" && entry.messageId === messageId
    );
    const outcome =
      decision?.outcome ??
      (await this.decisions.get(this.decisionKey("error", messageId))?.promise);
    return typeof outcome === "string" ? outcome : undefined;
  }
  async waitForCompactionDecision(messageId: string, allowPending: boolean): Promise<boolean> {
    if (allowPending && !this.disposed)
      this.dispatch({ type: "decision", kind: "compaction", messageId });
    const decision = this.state.decisions.find(
      (entry) => entry.kind === "compaction" && entry.messageId === messageId
    );
    const outcome =
      decision?.outcome ??
      (await this.decisions.get(this.decisionKey("compaction", messageId))?.promise);
    this.dispatch({ type: "forget-compaction", messageId });
    return outcome === true;
  }
}
