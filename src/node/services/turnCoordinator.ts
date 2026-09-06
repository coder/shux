import assert from "@/common/utils/assert";
import type { StreamAbortEvent, StreamStartEvent } from "@/common/types/stream";
import type { TurnCompletion, TurnStreamHandle } from "./streamManager";
import type { ActiveTurnThinkingOverride } from "./thinkingOverride";

export type TurnId = symbol;
export type OperationId = symbol;
export type TurnPhase = "idle" | "preparing" | "streaming" | "completing";
export type StreamErrorRecoveryOutcome = "retry-started" | "terminal";
type ReservationKind = "admission" | "edit" | "manual";
type DecisionKind = "error" | "compaction";
type DecisionOutcome = StreamErrorRecoveryOutcome | boolean;

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
  | { readonly phase: "idle"; readonly id: TurnId; readonly operation?: Operation }
  | {
      readonly phase: Exclude<TurnPhase, "idle">;
      readonly id: TurnId;
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
}

export type CoordinatorEvent =
  | { type: "prepare"; id: TurnId }
  | { type: "finish"; id: TurnId; preparingOnly: boolean }
  | { type: "preempt"; id: TurnId }
  | { type: "forget-compaction"; messageId: string }
  | { type: "register"; id: OperationId; turnId: TurnId }
  | { type: "configure-operation"; id: OperationId; compaction: boolean }
  | { type: "starting"; id: OperationId; messageId: string }
  | { type: "started"; payload: StreamStartEvent }
  | { type: "raw-terminal"; kind: "completed" | "aborted"; messageId: string }
  | { type: "startup-abort"; messageId: string }
  | { type: "completion"; id: OperationId; messageId: string; outcome: TurnCompletion }
  | { type: "complete-policy"; id: TurnId }
  | { type: "reserve" | "release"; id: symbol; kind: ReservationKind }
  | { type: "retry-start" | "retry-finish"; id: symbol }
  | { type: "decision"; kind: DecisionKind; messageId: string; outcome?: DecisionOutcome }
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
  return { lifetime: "open", turn: { phase: "idle", id }, reservations: [], decisions: [] };
}

/** Pure transition seam: stale events cannot publish, launch policy, or release another owner. */
export function transition(
  state: CoordinatorState,
  event: CoordinatorEvent
): { state: CoordinatorState; commands: readonly CoordinatorCommand[] } {
  const commands: CoordinatorCommand[] = [];
  let next = state;
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
  if (state.lifetime === "disposed") return { state, commands };
  switch (event.type) {
    case "prepare":
      if (
        state.lifetime !== "open" ||
        state.reservations.some((entry) => entry.kind === "admission")
      )
        break;
      if (current) commands.push({ type: "retire", id: current.id });
      phase({ phase: "preparing", id: event.id });
      break;
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
    case "started":
      if (current && (current.delivery !== "waiting" || current.stage === "started")) break;
      if (current?.delivery === "waiting") {
        operation({ ...current, stage: "started", messageId: event.payload.messageId });
      }
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
  return { state: next, commands };
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

/**
 * The sole owner of lifecycle state and runtime registries. Dispatch publishes state before any
 * callback; cleanup captures retired resources before publication so observer reentrancy is safe.
 * Promise policy is deliberately outside the engine sink: a follow-up can await engine cleanup.
 */
export class TurnCoordinator {
  private state = initialCoordinatorState(Symbol("idle"));
  private readonly settlements = new Map<
    OperationId,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  private readonly decisions = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<DecisionOutcome>>
  >();
  private idleWaiters = new Set<() => void>();
  private prepared?: { id: TurnId; controller: AbortController };
  private thinking: ActiveTurnThinkingOverride | null = null;

  constructor(private readonly callbacks: CoordinatorCallbacks) {}

  get phase(): TurnPhase {
    return this.state.turn.phase;
  }
  get turnId(): TurnId {
    return this.state.turn.id;
  }
  get operationId(): OperationId | undefined {
    return this.state.turn.operation?.id;
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
  get manualFollowUpPending(): boolean {
    return this.hasReservation("manual");
  }
  get retryStarting(): boolean {
    return this.state.retry != null;
  }
  get thinkingOverride(): ActiveTurnThinkingOverride | null {
    return this.thinking;
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
    event: Extract<CoordinatorEvent, { type: "completion" }>
  ): Promise<void> | undefined;
  private dispatch(event: Exclude<CoordinatorEvent, { type: "completion" }>): void;
  private dispatch(event: CoordinatorEvent): Promise<void> | undefined {
    let launchedPolicy: Promise<void> | undefined;
    let publicationError: { error: unknown } | undefined;
    const result = transition(this.state, event);
    this.state = result.state;
    // Detach before *any* callback. An idle observer may synchronously admit a new turn and waiter.
    const idle = result.commands.some(
      (command) => command.type === "phase" && command.next.phase === "idle"
    );
    const waiters = idle ? this.idleWaiters : undefined;
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
            // Invoke synchronously up to the policy's first await; never insert an admission gap.
            let policy: Promise<void>;
            try {
              policy = this.callbacks.policy(
                command.id,
                command.messageId,
                command.outcome,
                command.started,
                command.notifyStartup
              );
            } catch (error) {
              policy = Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
            launchedPolicy = policy
              .catch(this.callbacks.policyError)
              .finally(() => {
                this.resolveErrorDecision(command.messageId, "terminal");
                this.resolveCompactionDecision(command.messageId, false);
                this.settleOperation(command.id);
              })
              .catch(this.callbacks.policyError);
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
    for (const resolve of waiters ?? []) resolve();
    // Outcomes live in pure state; the registry holds resources only, including pending waiters.
    const keys = new Set(
      this.state.decisions.map((entry) => this.decisionKey(entry.kind, entry.messageId))
    );
    for (const key of this.decisions.keys()) if (!keys.has(key)) this.decisions.delete(key);
    // Publication failures retain their original propagation, but cannot orphan the detached
    // batch or skip disposal's retired resources. A later dispose no longer owns that batch.
    if (publicationError) throw publicationError.error;
    return launchedPolicy;
  }

  prepare(controller?: AbortController, reservation?: TurnId): TurnId {
    const id = reservation ?? Symbol("turn");
    if (reservation && (!this.isCurrentTurn(reservation) || this.phase !== "preparing"))
      return Symbol("rejected admission");
    // Resource publication precedes lifecycle callbacks, just like ownership publication.
    if (this.state.lifetime !== "open" || this.admissionBlocked)
      return Symbol("rejected admission");
    this.prepared = controller ? { id, controller } : undefined;
    this.dispatch({ type: "prepare", id });
    return id;
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
    if (this.isCurrentTurn(turnId)) this.thinking = holder;
  }
  releaseThinkingOverride(holder: ActiveTurnThinkingOverride): void {
    if (this.thinking === holder) this.thinking = null;
  }
  beginShutdown(): void {
    this.dispatch({ type: "shutdown" });
  }
  dispose(): void {
    this.dispatch({ type: "dispose" });
  }

  reserve(kind: ReservationKind): Disposable {
    const id = Symbol(kind);
    this.dispatch({ type: "reserve", id, kind });
    return { [Symbol.dispose]: () => this.dispatch({ type: "release", id, kind }) };
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

  waitForIdle(signal?: AbortSignal): Promise<void> {
    assert(
      signal == null || typeof signal.aborted === "boolean",
      "waitForIdle signal must be an AbortSignal"
    );
    if (signal?.aborted) return Promise.reject(new Error("Waiting for session idle canceled."));
    if (this.phase === "idle") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const batch = this.idleWaiters;
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        batch.delete(finish);
        resolve();
      };
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        batch.delete(finish);
        reject(new Error("Waiting for session idle canceled."));
      };
      batch.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
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
  clearRetryStarting(): void {
    if (this.state.retry) this.finishRetry(this.state.retry);
  }

  registerOperation(turnId: TurnId): OperationId {
    const id = Symbol("operation");
    this.settlements.set(id, Promise.withResolvers<void>());
    this.dispatch({ type: "register", id, turnId });
    if (!this.isCurrentOperation(id)) this.settleOperation(id);
    return id;
  }
  configureOperation(id: OperationId, compaction: boolean): void {
    this.dispatch({ type: "configure-operation", id, compaction });
  }
  streamStarting(id: OperationId, messageId: string): void {
    this.dispatch({ type: "starting", id, messageId });
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
      });
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
