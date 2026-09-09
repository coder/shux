import {
  STARTUP_RECOVERY_MAX_READ_ATTEMPTS,
  STARTUP_RECOVERY_READ_BASE_DELAY_MS,
  STARTUP_RECOVERY_READ_MAX_DELAY_MS,
} from "@/constants/startupRecovery";

export type StartupRecoveryState = "blocked" | "question" | "interrupted" | "idle";

export type StartupRecoveryOutcome = "completed" | "deferred" | "retryable";

interface StartupRecoveryOptions {
  signal: AbortSignal;
  steps: ReadonlyArray<() => Promise<unknown>>;
  check: () => Promise<StartupRecoveryOutcome>;
  wait: (delayMs: number) => Promise<void>;
  report: (error: unknown) => void;
}

/** Share bounded read retries without replaying recovery side effects. */
export async function retryStartupRead<T>(
  read: () => Promise<T>,
  retryable: (value: T) => boolean,
  options: Pick<StartupRecoveryOptions, "signal" | "wait">
): Promise<T | undefined> {
  for (let attempt = 0; attempt < STARTUP_RECOVERY_MAX_READ_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) return undefined;
    const value = await read();
    if (options.signal.aborted) return undefined;
    if (!retryable(value) || attempt + 1 === STARTUP_RECOVERY_MAX_READ_ATTEMPTS) return value;
    await options.wait(
      Math.min(
        STARTUP_RECOVERY_READ_BASE_DELAY_MS * 2 ** attempt,
        STARTUP_RECOVERY_READ_MAX_DELAY_MS
      )
    );
  }
}

/**
 * One startup attempt, with checkpoints for successful side effects. Read retries never
 * replay acknowledgment/compaction/follow-up work; a failed step needs a later explicit run.
 * Callbacks own their physical I/O leases. Deferred idle/backoff waits own no such lease.
 */
export class StartupRecovery {
  private nextStep = 0;
  private completed = false;
  private running?: Promise<void>;
  private waiting?: Promise<void>;

  constructor(private readonly options: StartupRecoveryOptions) {}

  get pending(): boolean {
    return !this.options.signal.aborted && (this.running != null || this.waiting != null);
  }

  run(check = this.options.check): Promise<void> {
    if (this.running) return this.running;
    if (this.completed || this.options.signal.aborted || this.waiting) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    // Publish ownership before callbacks: recovery can synchronously reenter through observers.
    this.running = done.promise;
    this.execute(check).then(
      (outcome) => {
        this.running = undefined;
        if (outcome === "deferred" && !this.options.signal.aborted) this.waitUntilIdle(check);
        done.resolve();
      },
      (error: unknown) => {
        this.running = undefined;
        if (!this.options.signal.aborted) this.options.report(error);
        done.resolve();
      }
    );
    return done.promise;
  }

  private async execute(check: StartupRecoveryOptions["check"]): Promise<StartupRecoveryOutcome> {
    while (this.nextStep < this.options.steps.length && !this.options.signal.aborted) {
      await this.options.steps[this.nextStep]();
      this.nextStep += 1;
    }
    const outcome =
      (await retryStartupRead(check, (value) => value === "retryable", this.options)) ??
      "completed";
    if (outcome === "completed") this.completed = true;
    return outcome;
  }

  private waitUntilIdle(check: StartupRecoveryOptions["check"]): void {
    this.waiting = this.options.wait(0).then(
      () => {
        this.waiting = undefined;
        return this.run(check);
      },
      (error: unknown) => {
        this.waiting = undefined;
        if (!this.options.signal.aborted) this.options.report(error);
      }
    );
  }
}
