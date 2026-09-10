/**
 * Per-step `[shutdown]` timing for the hand-ordered teardown lists
 * (`ServiceContainer.dispose()`, the CLI roots' cleanup lists, `xum server`'s
 * signal handler). Each step writes a start marker before it runs and a
 * completion line with its duration, so a shutdown transcript shows where the
 * time goes and — when a step hangs, whether in an awaited disposer that never
 * settles or in a blocking synchronous call — the last line before silence
 * names the culprit rather than its predecessor. Debug level: production logs
 * stay quiet unless the log level is raised.
 *
 * A synchronous step is timed and logged before this returns and no Promise is
 * created, so wrapping one adds no suspension point: adjacent synchronous
 * teardown statements still run back-to-back on the same tick and their
 * interleaving with a concurrently running `shutdown()` is unchanged. The
 * Promise overload is listed first so an async step can never bind to the
 * synchronous signature (a `Promise<void>` return is assignable to `void`);
 * `@typescript-eslint/no-misused-promises` guards the reverse direction.
 *
 * Errors propagate unchanged after the completion line is written;
 * containment (or not) stays with the caller exactly as before.
 */
import { log } from "./log";

export function shutdownStep(name: string, run: () => Promise<void>): Promise<void>;
export function shutdownStep(name: string, run: () => void): void;
export function shutdownStep(name: string, run: () => void | Promise<void>): void | Promise<void> {
  log.debug(`[shutdown] ${name} starting`);
  const startedAt = performance.now();
  const done = () => {
    log.debug(`[shutdown] ${name}`, { ms: Math.round(performance.now() - startedAt) });
  };
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (error) {
    done();
    throw error;
  }
  if (isThenable(result)) {
    // Thenable check rather than `instanceof Promise`: a promise created in
    // another realm (vm context, worker boundary) must still be awaited.
    return Promise.resolve(result).finally(done);
  }
  done();
}

function isThenable(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
