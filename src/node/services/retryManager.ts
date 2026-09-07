import { Duration, Effect, Fiber } from "effect";
import assert from "@/common/utils/assert";
import {
  calculateBackoffDelay,
  createFailedRetryState,
  createFreshRetryState,
  type RetryState,
} from "@/common/utils/messages/retryState";
import {
  isNonRetryableSendError,
  isNonRetryableStreamError,
} from "@/common/utils/messages/retryEligibility";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";

export interface RetryFailureError {
  type: string;
  message?: string;
}

// Status events emitted during auto-retry lifecycle
export interface AutoRetryScheduledEvent {
  type: "auto-retry-scheduled";
  attempt: number;
  delayMs: number;
  scheduledAt: number;
}
export interface AutoRetryStartingEvent {
  type: "auto-retry-starting";
  attempt: number;
}
export interface AutoRetryAbandonedEvent {
  type: "auto-retry-abandoned";
  reason: string;
}
export type RetryStatusEvent =
  | AutoRetryScheduledEvent
  | AutoRetryStartingEvent
  | AutoRetryAbandonedEvent;

export class RetryManager {
  private state: RetryState<RetryFailureError>;
  /**
   * The forked retry fiber: sleeps for the backoff delay (Effect's clock
   * registers a plain `setTimeout` under the hood), then emits
   * `auto-retry-starting` and runs the onRetry callback. Fiber interruption
   * replaces hand-rolled `clearTimeout` bookkeeping: interrupting a sleeping
   * fiber cancels its timer, and interrupting a fiber awaiting onRetry
   * discards the (now stale) settlement so late rejections cannot emit events.
   */
  private retryFiber: Fiber.Fiber<void> | null = null;
  /** True only while the backoff sleep is pending (scheduled, not yet fired). */
  private retryPending = false;
  private enabled = true;
  /**
   * Guard for re-entrant synchronous cancellation: a status callback may call
   * cancel()/setEnabled(false) while the retry fiber is executing
   * synchronously, and fiber interruption only lands at the next yield point.
   * The fiber therefore re-checks its generation after every callback it
   * invokes, mirroring interruption for purely synchronous re-entrancy.
   */
  private retryGeneration = 0;
  private pendingScheduledEvent: AutoRetryScheduledEvent | null = null;
  private retryOwnership?: Disposable;

  constructor(
    private readonly workspaceId: string,
    private readonly onRetry: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
    private readonly onStatusChange: (event: RetryStatusEvent) => void,
    /**
     * Runs the retry fiber fork and its interrupt. The global runtime by
     * default (direct construction in tests); AgentSession passes its stream
     * manager's runner, so the backoff sleep shares the stream's `Clock` — the
     * app runtime's in production, a `TestClock` in tests.
     */
    private readonly runner: EffectRunner = defaultEffectRunner,
    /** Logical ownership precedes status publication; it never leases sleeping or physical work. */
    private readonly beginRetry?: () => Disposable
  ) {
    assert(this.workspaceId.trim().length > 0, "RetryManager: workspaceId must be non-empty");
    assert(typeof this.onRetry === "function", "RetryManager: onRetry must be a function");
    assert(
      typeof this.onStatusChange === "function",
      "RetryManager: onStatusChange must be a function"
    );

    this.state = createFreshRetryState<RetryFailureError>();
  }

  handleStreamFailure(error: RetryFailureError): void {
    assert(
      typeof error.type === "string" && error.type.length > 0,
      "RetryManager: error.type required"
    );

    if (!this.enabled) {
      return;
    }

    const scheduledGeneration = ++this.retryGeneration;
    this.interruptRetryFiber();
    // Retiring ownership can synchronously schedule a replacement through its finalizer.
    if (scheduledGeneration !== this.retryGeneration) return;

    // Check non-retryable errors using extracted common utils.
    // Cancel any pending retry first — a retryable error may have scheduled
    // a timer, but a later non-retryable error supersedes it.
    if (isNonRetryableSendError(error) || isNonRetryableStreamError(error)) {
      this.onStatusChange({ type: "auto-retry-abandoned", reason: error.type });
      return;
    }

    // If a retry is already pending, cancel it and reschedule with updated backoff.
    // This can happen when multiple error events arrive before the timer fires.
    this.state = createFailedRetryState(this.state.attempt, error);
    const delay = calculateBackoffDelay(this.state.attempt);

    const scheduledEvent: AutoRetryScheduledEvent = {
      type: "auto-retry-scheduled",
      attempt: this.state.attempt,
      delayMs: delay,
      scheduledAt: Date.now(),
    };
    this.pendingScheduledEvent = scheduledEvent;
    this.retryPending = true;
    try {
      this.onStatusChange(scheduledEvent);
    } catch (error) {
      if (scheduledGeneration === this.retryGeneration) this.cancel();
      throw error;
    }

    this.scheduleRetry(delay, scheduledGeneration, scheduledEvent.attempt);
  }

  /**
   * Fork the retry fiber. `runner.runFork` executes synchronously up to the
   * sleep, so the backoff timer is registered before this method returns —
   * the same observable ordering as the previous `setTimeout` call.
   *
   * The backoff policy itself stays the hand-rolled pure
   * `calculateBackoffDelay`: attempts are driven by external stream events
   * (not by retrying an effect), so an Effect `Schedule` would only re-encode
   * the same shared one-liner behind effectful stepping machinery.
   */
  private scheduleRetry(delayMs: number, scheduledGeneration: number, attempt: number): void {
    // A scheduled observer can cancel or recursively schedule a replacement before
    // we fork. The retired call must not overwrite that replacement's fiber/status.
    if (!this.enabled || scheduledGeneration !== this.retryGeneration) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    let ownership: Disposable | undefined;
    const abandon = (retryError: unknown) => {
      if (!self.enabled || scheduledGeneration !== self.retryGeneration) return;
      self.releaseRetryOwnership(ownership);
      const reason =
        retryError instanceof Error && retryError.message.length > 0
          ? retryError.message
          : "retry_callback_failed";
      self.onStatusChange({ type: "auto-retry-abandoned", reason });
    };
    this.retryPending = true;
    this.retryFiber = this.runner.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(delayMs));

        // Guard against stale wake-ups or stop requests that race with fiber
        // resumption (e.g. a cancel() issued re-entrantly while the scheduled
        // event was still being emitted, before this fiber was forked).
        if (!self.enabled || scheduledGeneration !== self.retryGeneration) {
          return;
        }

        self.retryPending = false;
        self.pendingScheduledEvent = null;

        let acquired = self.beginRetry?.();
        ownership = acquired && {
          [Symbol.dispose]: () => {
            const retired = acquired;
            acquired = undefined;
            retired?.[Symbol.dispose]();
          },
        };
        if (!self.enabled || scheduledGeneration !== self.retryGeneration) return;
        self.retryOwnership = ownership;

        try {
          self.onStatusChange({ type: "auto-retry-starting", attempt });
        } catch (error) {
          abandon(error);
          return;
        }

        // Re-check after status emission so a synchronous stop handler can cancel
        // before we attempt to resume the stream.
        if (!self.enabled || scheduledGeneration !== self.retryGeneration) {
          return;
        }

        yield* Effect.tryPromise({
          try: (signal) => {
            if (!self.enabled || scheduledGeneration !== self.retryGeneration)
              return Promise.resolve();
            return self.onRetry(() => scheduledGeneration === self.retryGeneration, signal);
          },
          catch: (retryError) => retryError,
        }).pipe(Effect.catch((retryError) => Effect.sync(() => abandon(retryError))));
      }).pipe(Effect.ensuring(Effect.sync(() => self.releaseRetryOwnership(ownership))))
    );
  }

  /** Capture before an await so cancellation/supersession also fences original Promise work. */
  captureGeneration(): () => boolean {
    const generation = this.retryGeneration;
    return () => generation === this.retryGeneration;
  }

  private releaseRetryOwnership(ownership: Disposable | undefined): void {
    if (!ownership) return;
    if (this.retryOwnership === ownership) this.retryOwnership = undefined;
    ownership[Symbol.dispose]();
  }

  handleStreamSuccess(): void {
    // Cancel any stale retry timer (e.g., if a manual retry succeeded
    // before the scheduled timer fired) and reset state.
    this.cancel();
  }

  /**
   * Interrupt any in-flight retry fiber without resetting state. Interruption
   * of a sleeping fiber clears its backoff timer synchronously; a fiber
   * already awaiting onRetry is discarded at settlement.
   */
  private interruptRetryFiber(): void {
    const fiber = this.retryFiber;
    const ownership = this.retryOwnership;
    // Detach everything before either finalizer can reenter and install another generation.
    this.retryFiber = null;
    this.retryOwnership = undefined;
    this.retryPending = false;
    this.pendingScheduledEvent = null;
    this.releaseRetryOwnership(ownership);
    if (fiber !== null) {
      // Fire-and-forget: the interrupt signal lands synchronously; awaiting
      // full fiber exit is unnecessary (and impossible from sync callers).
      this.runner.runFork(Fiber.interrupt(fiber));
    }
  }

  cancel(): void {
    this.retryGeneration += 1;
    this.state = createFreshRetryState<RetryFailureError>();
    this.interruptRetryFiber();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Cancel any pending/in-flight retry and notify the frontend so the UI
      // clears the retry status (e.g., "Retrying…" or countdown).
      // Check state.attempt rather than isRetryPending because the timer may
      // have already fired (retryTimer is null) while the onRetry callback is
      // still executing — the UI would otherwise remain stuck in retry state.
      const hadActiveRetry = this.isRetryPending || this.state.attempt > 0;
      this.cancel();
      if (hadActiveRetry) {
        this.onStatusChange({ type: "auto-retry-abandoned", reason: "disabled_by_user" });
      }
    }
  }

  get isRetryPending(): boolean {
    return this.retryPending;
  }

  getScheduledStatusSnapshot(): AutoRetryScheduledEvent | null {
    if (!this.pendingScheduledEvent) {
      return null;
    }

    // Return a copy so callers cannot mutate internal retry state.
    return { ...this.pendingScheduledEvent };
  }

  dispose(): void {
    this.cancel();
  }
}
