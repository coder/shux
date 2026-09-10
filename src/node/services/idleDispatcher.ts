import { Duration, Effect, type Fiber } from "effect";
import assert from "@/common/utils/assert";
import { log } from "./log";

/**
 * Global cap on concurrent idle-dispatch executions across all consumers
 * (goal continuations, heartbeats, and any future idle work). Despite the
 * "GOAL" history in the codebase, this dispatcher is shared, so the cap
 * applies to every consumer (Coder-agents-review nit DEREM-30).
 */
export const MAX_CONCURRENT_IDLE_DISPATCHES = 1;

export interface IdleDispatchPayload {
  dispatch(): Promise<void>;
}

export interface IdleConsumer {
  name: string;
  priority: number;
  buildPayload(workspaceId: string): Promise<IdleDispatchPayload | null>;
}

interface IdleDispatcherOptions {
  debounceMs?: number;
  maxConcurrentDispatches?: number;
}

interface PendingDispatchRequest {
  readonly sources: Set<string>;
  readonly resolvers: Array<() => void>;
  /**
   * Debounce fiber: sleeps for `debounceMs` (Effect's clock registers a plain
   * `setTimeout` under the hood), then marks the workspace ready. Non-null
   * exactly while the debounce window is open — later requests for the same
   * workspace coalesce into this pending entry instead of re-arming it.
   */
  debounceFiber: Fiber.Fiber<void> | null;
}

export class IdleDispatcher {
  private readonly consumersByName = new Map<string, IdleConsumer>();
  private readonly pendingByWorkspaceId = new Map<string, PendingDispatchRequest>();
  private readonly readyWorkspaceIds: string[] = [];
  private readonly readyWorkspaceIdSet = new Set<string>();
  private readonly activeWorkspaceIds = new Set<string>();
  private readonly debounceMs: number;
  private readonly maxConcurrentDispatches: number;
  private activeDispatchCount = 0;

  constructor(options: IdleDispatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? 0;
    this.maxConcurrentDispatches =
      options.maxConcurrentDispatches ?? MAX_CONCURRENT_IDLE_DISPATCHES;

    assert(
      Number.isFinite(this.debounceMs) && this.debounceMs >= 0,
      "IdleDispatcher requires a non-negative debounceMs"
    );
    assert(
      Number.isInteger(this.maxConcurrentDispatches) && this.maxConcurrentDispatches > 0,
      "IdleDispatcher requires a positive integer dispatch concurrency cap"
    );
  }

  registerConsumer(consumer: IdleConsumer): () => void {
    this.assertValidConsumer(consumer);
    assert(
      !this.consumersByName.has(consumer.name),
      `IdleDispatcher consumer already registered: ${consumer.name}`
    );

    this.consumersByName.set(consumer.name, consumer);
    return () => {
      if (this.consumersByName.get(consumer.name) === consumer) {
        this.consumersByName.delete(consumer.name);
      }
    };
  }

  requestDispatch(workspaceId: string, source: string): Promise<void> {
    this.assertValidWorkspaceId(workspaceId, "requestDispatch");
    assert(source.trim().length > 0, "IdleDispatcher.requestDispatch requires a source");

    if (!this.consumersByName.has(source)) {
      log.debug("IdleDispatcher: ignoring dispatch request for unregistered consumer", {
        workspaceId,
        source,
      });
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const pending = this.getOrCreatePendingDispatch(workspaceId);
      pending.sources.add(source);
      pending.resolvers.push(resolve);

      if (pending.debounceFiber != null) {
        return;
      }

      // Effect.runFork executes synchronously up to the sleep, so the debounce
      // timer is registered before this callback returns (same observable
      // ordering as the previous setTimeout call); a zero-duration sleep still
      // defers to a timer tick rather than firing inline.
      pending.debounceFiber = Effect.runFork(
        Effect.sleep(Duration.millis(this.debounceMs)).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              pending.debounceFiber = null;
              this.markWorkspaceReady(workspaceId);
            })
          )
        )
      );
    });
  }

  private getOrCreatePendingDispatch(workspaceId: string): PendingDispatchRequest {
    const existing = this.pendingByWorkspaceId.get(workspaceId);
    if (existing != null) {
      return existing;
    }

    const pending: PendingDispatchRequest = {
      sources: new Set<string>(),
      resolvers: [],
      debounceFiber: null,
    };
    this.pendingByWorkspaceId.set(workspaceId, pending);
    return pending;
  }

  private markWorkspaceReady(workspaceId: string): void {
    if (!this.pendingByWorkspaceId.has(workspaceId)) {
      return;
    }
    if (!this.readyWorkspaceIdSet.has(workspaceId)) {
      this.readyWorkspaceIdSet.add(workspaceId);
      this.readyWorkspaceIds.push(workspaceId);
    }

    this.processQueue();
  }

  private processQueue(): void {
    while (this.activeDispatchCount < this.maxConcurrentDispatches) {
      const nextWorkspaceIndex = this.readyWorkspaceIds.findIndex(
        (workspaceId) => !this.activeWorkspaceIds.has(workspaceId)
      );
      if (nextWorkspaceIndex < 0) {
        return;
      }

      const [workspaceId] = this.readyWorkspaceIds.splice(nextWorkspaceIndex, 1);
      if (workspaceId == null) {
        return;
      }
      this.readyWorkspaceIdSet.delete(workspaceId);
      this.dispatchWorkspace(workspaceId).catch((error: unknown) => {
        log.error("IdleDispatcher: unexpected dispatch worker failure", { workspaceId, error });
      });
    }
  }

  private async dispatchWorkspace(workspaceId: string): Promise<void> {
    const pending = this.pendingByWorkspaceId.get(workspaceId);
    if (pending == null) {
      return;
    }

    this.pendingByWorkspaceId.delete(workspaceId);
    this.activeWorkspaceIds.add(workspaceId);
    this.activeDispatchCount += 1;

    try {
      await this.dispatchRequestedSources(workspaceId, pending.sources);
    } finally {
      this.resolvePending(pending);
      this.activeWorkspaceIds.delete(workspaceId);
      this.activeDispatchCount -= 1;
      assert(
        this.activeDispatchCount >= 0,
        "IdleDispatcher active dispatch count underflowed after completion"
      );
      this.processQueue();
    }
  }

  private async dispatchRequestedSources(workspaceId: string, sources: Set<string>): Promise<void> {
    const consumers = Array.from(sources)
      .map((source) => this.consumersByName.get(source) ?? null)
      .filter((consumer): consumer is IdleConsumer => consumer != null)
      .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name));

    for (const consumer of consumers) {
      let payload: IdleDispatchPayload | null;
      try {
        payload = await consumer.buildPayload(workspaceId);
      } catch (error) {
        // A buildPayload failure for this consumer must not silently suppress
        // the rest of the priority-ordered chain (e.g. a goal payload throwing
        // EACCES on goal.json must not block the heartbeat consumer at
        // priority 50 from running). The success path returns after a
        // dispatch (line below) by design — the error path needs `continue`
        // to fall through to the next consumer (Coder-agents-review P2
        // DEREM-15).
        log.error("IdleDispatcher: failed to build idle dispatch payload", {
          workspaceId,
          consumer: consumer.name,
          error,
        });
        continue;
      }

      if (payload == null) {
        log.debug("IdleDispatcher: skipped stale dispatch payload", {
          workspaceId,
          consumer: consumer.name,
        });
        continue;
      }

      try {
        await payload.dispatch();
      } catch (error) {
        log.error("IdleDispatcher: idle dispatch failed", {
          workspaceId,
          consumer: consumer.name,
          error,
        });
      }
      return;
    }
  }

  private resolvePending(pending: PendingDispatchRequest): void {
    for (const resolve of pending.resolvers) {
      resolve();
    }
  }

  private assertValidConsumer(consumer: IdleConsumer): void {
    assert(consumer.name.trim().length > 0, "IdleDispatcher consumer requires a name");
    assert(
      Number.isFinite(consumer.priority),
      "IdleDispatcher consumer requires a finite priority"
    );
    assert(
      typeof consumer.buildPayload === "function",
      "IdleDispatcher consumer requires a buildPayload function"
    );
  }

  private assertValidWorkspaceId(workspaceId: string, caller: string): void {
    assert(workspaceId.trim().length > 0, `IdleDispatcher.${caller} requires a workspaceId`);
  }
}
