import type http from "node:http";
import { Duration, Effect, Exit, Scope } from "effect";
import type { Result } from "@/common/types/result";
import { Err } from "@/common/types/result";
import { closeServer } from "@/node/utils/oauthUtils";
import { log } from "@/node/services/log";

/**
 * Shared desktop OAuth flow lifecycle manager.
 *
 * Four OAuth services (Gateway, Governor, Codex, MCP) track in-flight desktop
 * flows with an identical `Map<string, DesktopFlow>` + `waitFor`/`cancel`/
 * `finish`/`shutdownAll` pattern. This class extracts that shared lifecycle
 * so each service can delegate flow bookkeeping here.
 *
 * Internals are Effect-native: every registered flow owns a per-flow
 * `Scope` holding one release finalizer per resource (registration timeout,
 * deferred settlement, loopback server close), so cleanup is guaranteed on
 * every termination path — finish, cancel, caller-timeout race, duplicate
 * registration, shutdownAll, and defects while releasing a sibling resource.
 * The Promise-based public API is preserved as thin `Effect.runPromise`
 * facades so the not-yet-converted OAuth services and existing tests keep
 * working unchanged; Effect-native callers (muxGatewayOauthService) can use
 * the `*Effect` surface directly without runPromise round-trips.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthFlowEntry {
  /** The loopback HTTP server (null for device-code flows). */
  server: http.Server | null;
  /** Deferred that resolves with the final flow result. */
  resultDeferred: {
    promise: Promise<Result<void, string>>;
    resolve: (value: Result<void, string>) => void;
  };
  /** Handle for the server-side timeout (set at registration time by the caller). */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

interface ActiveFlow {
  entry: OAuthFlowEntry;
  /**
   * Owns the flow's resources. Closing it runs the release finalizers in
   * reverse acquisition order: clear the registration timeout, settle the
   * deferred, then close the loopback server (awaited).
   */
  scope: Scope.Closeable;
  /**
   * Result the deferred-settle finalizer resolves `resultDeferred` with.
   * Mutable so every termination path (finish/cancel/shutdown/replace) routes
   * its result through the same scope-guaranteed finalizer instead of ad-hoc
   * resolve calls. The initial value is a defensive fallback for the
   * (should-be-impossible) case of the scope closing before any path staged
   * a real result — waiters must never hang on an unsettled deferred.
   */
  finalResult: Result<void, string>;
}

interface CompletedOAuthFlowEntry {
  result: Result<void, string>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_COMPLETED_FLOW_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Per-flow resource scope
// ---------------------------------------------------------------------------

/**
 * Move ownership of the caller-acquired flow resources into the per-flow
 * scope. One `acquireRelease` per resource: a combined acquisition would
 * install its finalizer only after every step succeeded, so a defect in a
 * later step would leak the earlier resources (Codex P2 on #4031).
 *
 * Resource state (`server`, `timeoutHandle`, `finalResult`) is read at
 * release time, not captured at acquisition, matching the pre-Effect code
 * that read the entry fields inside `finish`.
 *
 * Release order (reverse acquisition) preserves the pre-Effect `finish`
 * ordering: clear the registration timeout, settle the deferred (so waiters
 * unblock before the async close), then close the loopback server.
 */
function acquireFlowResources(flow: ActiveFlow): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => {
      const server = flow.entry.server;
      if (server === null) {
        return Effect.void;
      }
      // Stop accepting new connections and wait for the (bounded) drain.
      return Effect.promise(async () => closeServer(server));
    });
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        flow.entry.resultDeferred.resolve(flow.finalResult);
      })
    );
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        if (flow.entry.timeoutHandle !== null) {
          clearTimeout(flow.entry.timeoutHandle);
        }
      })
    );
  });
}

/**
 * Close a flow's scope, releasing its resources. A defect while releasing one
 * resource cannot skip the others (each finalizer is independent), and the
 * aggregated defect must never escape — flow teardown runs on shutdown paths
 * that must not crash the app — so it is logged at debug level like the
 * pre-Effect try/catch did.
 */
function closeFlowScope(scope: Scope.Closeable, failureLogMessage: string): Effect.Effect<void> {
  return Scope.close(scope, Exit.void).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        log.debug(failureLogMessage, defect);
      })
    )
  );
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class OAuthFlowManager {
  private readonly flows = new Map<string, ActiveFlow>();
  private readonly completed = new Map<string, CompletedOAuthFlowEntry>();

  constructor(private readonly completedFlowTtlMs = DEFAULT_COMPLETED_FLOW_TTL_MS) {}

  /** Register a new in-flight flow. */
  register(flowId: string, entry: OAuthFlowEntry): void {
    // If a flow ID is re-used before the completed-flow TTL expires, ensure the
    // old cleanup timer can't delete the new result.
    this.clearCompleted(flowId);

    const existing = this.flows.get(flowId);
    if (existing) {
      // Defensive: avoid silently overwriting an active flow entry.
      //
      // This can happen if a provider accidentally re-uses a flow ID, or if a
      // stale in-flight start attempt races a newer one. Clean up to avoid
      // leaking timeouts, deferred promises, or loopback servers.
      log.debug(`[OAuthFlowManager] Duplicate register — replacing active flow (flowId=${flowId})`);

      this.flows.delete(flowId);
      existing.finalResult = Err("OAuth flow replaced");
      // register must stay synchronous while the replaced flow's server close
      // is async, so run the release in a detached fiber. runFork executes it
      // synchronously up to the first suspension: the old timeout is cleared
      // and the old deferred settles before register returns (same observable
      // ordering as before); only the server close continues in background.
      Effect.runFork(closeFlowScope(existing.scope, "Failed to clean up replaced OAuth flow:"));
    }

    const scope = Scope.makeUnsafe();
    const flow: ActiveFlow = { entry, scope, finalResult: Err("OAuth flow terminated") };
    try {
      Effect.runSync(Scope.provide(scope)(acquireFlowResources(flow)));
    } catch (error) {
      // Defensive: the acquisition steps are infallible ownership handovers,
      // but if one ever defects, release whatever was acquired so a partial
      // registration cannot leak resources.
      Effect.runFork(closeFlowScope(scope, "Failed to clean up partially registered OAuth flow:"));
      throw error;
    }
    this.flows.set(flowId, flow);
  }

  private clearCompleted(flowId: string): void {
    const existing = this.completed.get(flowId);
    if (!existing) return;

    if (existing.cleanupTimeout !== null) {
      clearTimeout(existing.cleanupTimeout);
    }

    this.completed.delete(flowId);
  }

  /**
   * Preserve the final result briefly so late waiters can still retrieve it.
   *
   * Old per-service DesktopFlow implementations kept completed flows around for
   * ~60s (cleanupTimeout) to avoid a race where the OAuth callback finishes
   * before the frontend begins `waitFor`-ing.
   */
  private recordCompleted(flowId: string, result: Result<void, string>): void {
    this.clearCompleted(flowId);
    const cleanupTimeout = setTimeout(() => {
      this.completed.delete(flowId);
    }, this.completedFlowTtlMs);

    // Don't keep the node process alive just to delete old completed entries.
    if (typeof cleanupTimeout !== "number") {
      cleanupTimeout.unref?.();
    }

    this.completed.set(flowId, { result, cleanupTimeout });
  }

  /** Get a flow entry by ID, or undefined if not found. */
  get(flowId: string): OAuthFlowEntry | undefined {
    return this.flows.get(flowId)?.entry;
  }

  /** Check whether a flow exists. */
  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  /**
   * Synchronous head of `finish`: remove the flow from the active map (so
   * re-entrant calls and `has` liveness checks observe the removal
   * immediately), record the completed result for late waiters, and stage the
   * final result for the deferred-settle finalizer. Returns the async release
   * (scope close) for the caller to run — awaited by `finishEffect`,
   * fire-and-forget in a detached fiber on the `waitFor` error path.
   */
  private beginFinish(flowId: string, result: Result<void, string>): Effect.Effect<void> | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;

    this.flows.delete(flowId);
    this.recordCompleted(flowId, result);

    flow.finalResult = result;
    return closeFlowScope(flow.scope, "Failed to close OAuth callback listener:");
  }

  /**
   * Wait for a flow to complete with a caller-facing timeout race.
   *
   * Mirrors the `waitForDesktopFlow` pattern shared across all four services:
   * - `Effect.timeout` bounds this wait call only; on timeout it interrupts
   *   the promise-wait fiber (the shared deferred is unaffected for other
   *   waiters) and its own timer is cleared by the interruption when the
   *   deferred wins.
   * - Registration-time timeout remains on `flow.timeoutHandle` and is cleared
   *   by the flow scope's release.
   * - On any error result (caller timeout or flow error), runs `finish` for
   *   shared cleanup.
   */
  waitForEffect(flowId: string, timeoutMs: number): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flow = self.flows.get(flowId);
      if (!flow) {
        const completed = self.completed.get(flowId);
        if (completed) {
          return completed.result;
        }

        return Err("OAuth flow not found");
      }

      const result: Result<void, string> = yield* Effect.promise(
        async () => flow.entry.resultDeferred.promise
      ).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catch(() =>
          Effect.succeed<Result<void, string>>(Err("Timed out waiting for OAuth callback"))
        )
      );

      if (!result.success) {
        // Ensure listener is closed on timeout/errors. Bookkeeping runs
        // synchronously (the flow is unregistered before waitFor resolves);
        // the async release runs in a detached fiber so waiters aren't held
        // up by the server close — same fire-and-forget shape as the
        // pre-Effect `void this.finish(...)`, but as a supervised fiber that
        // survives this effect's completion.
        //
        // Uninterruptible: waitForEffect now runs on interruptible handler
        // fibers (handlerGen), and an interrupt landing between beginFinish
        // (sync unregister) and the release fork would strand a flow that is
        // no longer in the map but whose scope release (timeout clear,
        // deferred settle, server close) never runs.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const release = self.beginFinish(flowId, result);
            if (release !== null) {
              yield* Effect.forkDetach(release);
            }
          })
        );
      }

      return result;
    });
  }

  async waitFor(flowId: string, timeoutMs: number): Promise<Result<void, string>> {
    return Effect.runPromise(this.waitForEffect(flowId, timeoutMs));
  }

  /**
   * Cancel a flow — resolves the deferred with an error and cleans up.
   *
   * Mirrors the `cancelDesktopFlow` pattern.
   */
  cancelEffect(flowId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (!self.flows.has(flowId)) return;

      yield* self.finishEffect(flowId, Err("OAuth flow cancelled"));
    });
  }

  async cancel(flowId: string): Promise<void> {
    return Effect.runPromise(this.cancelEffect(flowId));
  }

  /**
   * Finish a flow: resolve the deferred, clear the timeout, close the server
   * (all via the flow scope's release), and remove the entry from the map.
   *
   * Idempotent — no-op if the flow was already removed. Mirrors the
   * `finishDesktopFlow` pattern. Never fails: release defects are logged.
   *
   * Uninterruptible: finish is the atomic teardown primitive — once it
   * begins, the sync unregister and the scope release must complete together,
   * even when run on an interruptible handler fiber (a client abort mid-finish
   * must not strand an unregistered flow with live resources).
   */
  finishEffect(flowId: string, result: Result<void, string>): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const release = self.beginFinish(flowId, result);
        if (release !== null) {
          yield* release;
        }
      })
    );
  }

  async finish(flowId: string, result: Result<void, string>): Promise<void> {
    return Effect.runPromise(this.finishEffect(flowId, result));
  }

  /**
   * Cancel every active flow. Used when an operation must be authoritative
   * over in-flight logins (e.g. disconnect: an outstanding flow could
   * otherwise commit a replacement login right after credentials are
   * cleared). Each flow is removed from the manager before this resolves,
   * so commit-path liveness checks (`has`) fail for the cancelled flows.
   */
  cancelAllEffect(): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flowIds = [...self.flows.keys()];
      yield* Effect.all(
        flowIds.map((id) => self.cancelEffect(id)),
        { concurrency: "unbounded", discard: true }
      );
    });
  }

  async cancelAll(): Promise<void> {
    return Effect.runPromise(this.cancelAllEffect());
  }

  /**
   * Shut down all active flows — resolves each with an error.
   *
   * Mirrors the `dispose` pattern where services iterate all flows and finish
   * them with `Err("App shutting down")`. Stays async (callers' `dispose`
   * awaits the loopback-server closes, which are bounded by the server's
   * force-finish socket handling) and never rejects.
   */
  shutdownAllEffect(): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flowIds = [...self.flows.keys()];
      yield* Effect.all(
        flowIds.map((id) => self.finishEffect(id, Err("App shutting down"))),
        { concurrency: "unbounded", discard: true }
      );
    });
  }

  async shutdownAll(): Promise<void> {
    return Effect.runPromise(this.shutdownAllEffect());
  }
}
