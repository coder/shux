import { isAbortError } from "@/browser/utils/isAbortError";

export const SUBSCRIPTION_RETRY_BASE_MS = 250;
export const SUBSCRIPTION_RETRY_MAX_MS = 5000;
const SUBSCRIPTION_STALL_TIMEOUT_MS = 10_000;
const SUBSCRIPTION_STALL_CHECK_INTERVAL_MS = 2_000;

export function calculateSubscriptionBackoffMs(attempt: number): number {
  return Math.min(SUBSCRIPTION_RETRY_BASE_MS * 2 ** attempt, SUBSCRIPTION_RETRY_MAX_MS);
}

interface SubscriptionAttemptResult<TEvent, TContext> {
  events: AsyncIterable<TEvent>;
  context: TContext;
}

interface SubscriptionRetryImmediately {
  retryImmediately: true;
}

interface AttemptStatus {
  attemptSignal: AbortSignal;
  attemptAborted: boolean;
}

interface SubscriptionLoopOptions<TClient, TEvent, TContext> {
  name: string;
  signal: AbortSignal;
  getClient: (signal: AbortSignal) => Promise<TClient | null>;
  getClientChangeSignal: () => AbortSignal;
  subscribe: (
    client: TClient,
    attemptSignal: AbortSignal,
    abortAttempt: () => void
  ) => Promise<SubscriptionAttemptResult<TEvent, TContext> | SubscriptionRetryImmediately | null>;
  onEvent: (event: TEvent, context: TContext, attemptSignal: AbortSignal) => void;
  onError?: (error: unknown, status: AttemptStatus) => boolean | void;
  onUnexpectedEnd?: (status: AttemptStatus) => void;
  onAttemptFinished?: (status: AttemptStatus) => void;
  watchdog?: false | { timeoutMs?: number; checkIntervalMs?: number };
  backoffAfterAbort?: boolean;
  sleep?: (timeoutMs: number, signal: AbortSignal) => Promise<void>;
}

export function sleepWithAbort(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(cleanup, timeoutMs);
    const onAbort = cleanup;

    function cleanup(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runSubscriptionLoop<TClient, TEvent, TContext>(
  options: SubscriptionLoopOptions<TClient, TEvent, TContext>
): Promise<void> {
  let attempt = 0;

  while (!options.signal.aborted) {
    // Capture before awaiting the client: a swap during the await would
    // otherwise bind the old client to the new generation's change signal.
    const clientChangeSignal = options.getClientChangeSignal();
    const client = await options.getClient(options.signal);
    if (!client || options.signal.aborted) return;
    if (clientChangeSignal.aborted) continue;

    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    options.signal.addEventListener("abort", abortAttempt, { once: true });
    clientChangeSignal.addEventListener("abort", abortAttempt, { once: true });

    let lastEventAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;

    try {
      const result = await options.subscribe(client, attemptController.signal, abortAttempt);
      if (!result) return;
      if ("retryImmediately" in result) continue;

      if (options.watchdog !== false) {
        const timeoutMs = options.watchdog?.timeoutMs ?? SUBSCRIPTION_STALL_TIMEOUT_MS;
        const checkIntervalMs =
          options.watchdog?.checkIntervalMs ?? SUBSCRIPTION_STALL_CHECK_INTERVAL_MS;
        lastEventAt = Date.now();
        watchdog = setInterval(() => {
          if (attemptController.signal.aborted) return;
          const elapsedMs = Date.now() - lastEventAt;
          if (elapsedMs < timeoutMs) return;
          console.warn(
            `[subscriptionTransport] ${options.name} stalled (no events for ${elapsedMs}ms); retrying...`
          );
          attemptController.abort();
        }, checkIntervalMs);
      }

      for await (const event of result.events) {
        if (options.signal.aborted) return;
        lastEventAt = Date.now();
        attempt = 0;
        options.onEvent(event, result.context, attemptController.signal);
      }

      if (!options.signal.aborted) {
        options.onUnexpectedEnd?.({
          attemptSignal: attemptController.signal,
          attemptAborted: attemptController.signal.aborted,
        });
      }
    } catch (error) {
      if (options.signal.aborted) return;
      const stop = options.onError?.(error, {
        attemptSignal: attemptController.signal,
        attemptAborted: attemptController.signal.aborted,
      });
      // An aborted attempt (watchdog/client change) must retry even if the caller says stop.
      const expectedAbort = isAbortError(error) && attemptController.signal.aborted;
      if (stop === true && !expectedAbort) return;
    } finally {
      options.signal.removeEventListener("abort", abortAttempt);
      clientChangeSignal.removeEventListener("abort", abortAttempt);
      if (watchdog) clearInterval(watchdog);
    }

    if (options.signal.aborted) return;

    const status = {
      attemptSignal: attemptController.signal,
      attemptAborted: attemptController.signal.aborted,
    };
    options.onAttemptFinished?.(status);

    if (options.backoffAfterAbort !== false || !attemptController.signal.aborted) {
      await (options.sleep ?? sleepWithAbort)(
        calculateSubscriptionBackoffMs(attempt),
        options.signal
      );
      attempt++;
    }
  }
}
