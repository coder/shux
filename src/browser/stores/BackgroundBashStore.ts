import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import { isAbortError } from "@/browser/utils/isAbortError";
import { MapStore } from "./MapStore";

const EMPTY_SET = new Set<string>();
const EMPTY_PROCESSES: BackgroundProcessInfo[] = [];
const BASH_RETRY_BASE_MS = 250;
const BASH_RETRY_MAX_MS = 5_000;

function areMonitorSnapshotsEqual(
  a: BackgroundProcessInfo["monitor"],
  b: BackgroundProcessInfo["monitor"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.filter === b.filter &&
    a.filter_exclude === b.filter_exclude &&
    a.cooldown_ms === b.cooldown_ms &&
    a.max_events === b.max_events &&
    a.totalMatches === b.totalMatches &&
    a.droppedLines === b.droppedLines &&
    a.stopped === b.stopped &&
    a.pendingWakeKind === b.pendingWakeKind &&
    a.lastLines.length === b.lastLines.length &&
    a.lastLines.every((line, index) => line === b.lastLines[index])
  );
}

function areProcessesEqual(a: BackgroundProcessInfo[], b: BackgroundProcessInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((proc, index) => {
    const other = b[index];
    return (
      proc.id === other.id &&
      proc.pid === other.pid &&
      proc.script === other.script &&
      proc.displayName === other.displayName &&
      // A synthesized wake-only row and a manager-backed row can otherwise compare equal,
      // deduping the transition that restores (or removes) the View output action.
      proc.synthesized === other.synthesized &&
      proc.startTime === other.startTime &&
      proc.status === other.status &&
      areMonitorSnapshotsEqual(proc.monitor, other.monitor) &&
      proc.exitCode === other.exitCode
    );
  });
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export class BackgroundBashStore {
  private client: APIClient | null = null;
  private processesStore = new MapStore<string, BackgroundProcessInfo[]>();
  private foregroundIdsStore = new MapStore<string, Set<string>>();
  private terminatingIdsStore = new MapStore<string, Set<string>>();
  private stateKnownStore = new MapStore<string, boolean>();

  private processesCache = new Map<string, BackgroundProcessInfo[]>();
  private autoBackgroundFetches = new Map<string, Promise<void>>();
  private foregroundIdsCache = new Map<string, Set<string>>();
  private terminatingIdsCache = new Map<string, Set<string>>();
  // Workspaces whose background-bash state is KNOWN (the live subscription
  // delivered at least one snapshot, or it failed and we self-healed).
  // The chat view's first-paint barrier (useChatViewDataReady) waits on this
  // so the banner can never pop in after the transcript reveals: an empty
  // process list is only renderable as "no banner" once it is known-empty
  // rather than not-yet-loaded. Kept across unsubscribes (last-known state).
  private stateKnownWorkspaces = new Set<string>();

  private subscriptions = new Map<
    string,
    {
      controller: AbortController;
      iterator: AsyncIterator<{
        processes: BackgroundProcessInfo[];
        foregroundToolCallIds: string[];
      }> | null;
    }
  >();
  private subscriptionCounts = new Map<string, number>();
  private retryAttempts = new Map<string, number>();
  private retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  setClient(client: APIClient | null): void {
    this.client = client;

    if (!client) {
      for (const subscription of this.subscriptions.values()) {
        subscription.controller.abort();
        void subscription.iterator?.return?.();
      }
      this.subscriptions.clear();

      for (const timeout of this.retryTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.retryTimeouts.clear();
      this.retryAttempts.clear();
      return;
    }

    for (const workspaceId of this.subscriptionCounts.keys()) {
      this.ensureSubscribed(workspaceId);
    }
  }

  subscribeProcesses = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.processesStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  subscribeForegroundIds = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.foregroundIdsStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  subscribeTerminatingIds = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.terminatingIdsStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  /**
   * Subscribe to the "state known" signal. Like the data subscriptions, this
   * ref-counts the live backend subscription — so the chat view's readiness
   * barrier both observes AND drives the initial snapshot fetch, keeping the
   * per-workspace subscription warm for the whole chat pane lifetime even
   * while the banner itself renders nothing.
   */
  subscribeStateKnown = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.stateKnownStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  isStateKnown(workspaceId: string): boolean {
    return this.stateKnownStore.get(workspaceId, () => this.stateKnownWorkspaces.has(workspaceId));
  }

  private markStateKnown(workspaceId: string): void {
    if (this.stateKnownWorkspaces.has(workspaceId)) {
      return;
    }
    this.stateKnownWorkspaces.add(workspaceId);
    this.stateKnownStore.bump(workspaceId);
  }

  getProcesses(workspaceId: string): BackgroundProcessInfo[] {
    return this.processesStore.get(
      workspaceId,
      () => this.processesCache.get(workspaceId) ?? EMPTY_PROCESSES
    );
  }

  getForegroundIds(workspaceId: string): Set<string> {
    return this.foregroundIdsStore.get(
      workspaceId,
      () => this.foregroundIdsCache.get(workspaceId) ?? EMPTY_SET
    );
  }

  getTerminatingIds(workspaceId: string): Set<string> {
    return this.terminatingIdsStore.get(
      workspaceId,
      () => this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET
    );
  }

  async terminate(workspaceId: string, processId: string): Promise<void> {
    if (!this.client) {
      throw new Error("API not available");
    }

    this.markTerminating(workspaceId, processId);

    try {
      const result = await this.client.workspace.backgroundBashes.terminate({
        workspaceId,
        processId,
      });

      if (!result.success) {
        this.clearTerminating(workspaceId, processId);
        throw new Error(result.error);
      }
    } catch (error) {
      this.clearTerminating(workspaceId, processId);
      throw error;
    }
  }

  async sendToBackground(workspaceId: string, toolCallId: string): Promise<void> {
    if (!this.client) {
      throw new Error("API not available");
    }

    const result = await this.client.workspace.backgroundBashes.sendToBackground({
      workspaceId,
      toolCallId,
    });

    if (!result.success) {
      throw new Error(result.error);
    }
  }

  autoBackgroundOnSend(workspaceId: string): void {
    const foregroundIds = this.foregroundIdsCache.get(workspaceId);
    if (foregroundIds && foregroundIds.size > 0) {
      for (const toolCallId of foregroundIds) {
        this.sendToBackground(workspaceId, toolCallId).catch(() => {
          // Ignore failures - bash may have completed before the request.
        });
      }
      return;
    }

    void this.fetchForegroundIdsForAutoBackground(workspaceId);
  }

  private fetchForegroundIdsForAutoBackground(workspaceId: string): Promise<void> {
    const existing = this.autoBackgroundFetches.get(workspaceId);
    if (existing) {
      return existing;
    }

    const client = this.client;
    if (!client) {
      return Promise.resolve();
    }

    const controller = new AbortController();
    const { signal } = controller;

    const task = (async () => {
      let iterator: AsyncIterator<{
        processes: BackgroundProcessInfo[];
        foregroundToolCallIds: string[];
      }> | null = null;

      try {
        const subscribedIterator = await client.workspace.backgroundBashes.subscribe(
          { workspaceId },
          { signal }
        );
        iterator = subscribedIterator;

        for await (const state of subscribedIterator) {
          controller.abort();
          void subscribedIterator.return?.();

          const latestForegroundIds = new Set(state.foregroundToolCallIds);
          this.foregroundIdsCache.set(workspaceId, latestForegroundIds);

          if (latestForegroundIds.size === 0) {
            return;
          }

          for (const toolCallId of latestForegroundIds) {
            this.sendToBackground(workspaceId, toolCallId).catch(() => {
              // Ignore failures - bash may have completed before the request.
            });
          }
          return;
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to read foreground bash state:", err);
        }
      } finally {
        void iterator?.return?.();
        this.autoBackgroundFetches.delete(workspaceId);
      }
    })();

    this.autoBackgroundFetches.set(workspaceId, task);
    return task;
  }

  private trackSubscription(workspaceId: string): void {
    const next = (this.subscriptionCounts.get(workspaceId) ?? 0) + 1;
    this.subscriptionCounts.set(workspaceId, next);
    if (next === 1) {
      this.ensureSubscribed(workspaceId);
    }
  }

  private untrackSubscription(workspaceId: string): void {
    const next = (this.subscriptionCounts.get(workspaceId) ?? 1) - 1;
    if (next > 0) {
      this.subscriptionCounts.set(workspaceId, next);
      return;
    }

    this.subscriptionCounts.delete(workspaceId);
    this.stopSubscription(workspaceId);
  }

  private stopSubscription(workspaceId: string): void {
    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      subscription.controller.abort();
      void subscription.iterator?.return?.();
      this.subscriptions.delete(workspaceId);
    }

    this.clearRetry(workspaceId);

    // Intentionally KEEP the per-workspace caches and the state-known flag.
    // Revisiting a workspace then renders the last-known state synchronously
    // at first paint (the fresh subscription reconciles within a tick) instead
    // of re-learning "are there background bashes?" after paint — which made
    // the banner pop in and shift the transcript on every workspace switch.
    // The retained data is a handful of small lists per visited workspace.
  }

  private clearRetry(workspaceId: string): void {
    const timeout = this.retryTimeouts.get(workspaceId);
    if (timeout) {
      clearTimeout(timeout);
    }
    this.retryTimeouts.delete(workspaceId);
    this.retryAttempts.delete(workspaceId);
  }

  private scheduleRetry(workspaceId: string): void {
    if (this.retryTimeouts.has(workspaceId)) {
      return;
    }

    const attempt = this.retryAttempts.get(workspaceId) ?? 0;
    const delay = Math.min(BASH_RETRY_BASE_MS * 2 ** attempt, BASH_RETRY_MAX_MS);
    this.retryAttempts.set(workspaceId, attempt + 1);

    const timeout = setTimeout(() => {
      this.retryTimeouts.delete(workspaceId);
      this.ensureSubscribed(workspaceId);
    }, delay);

    this.retryTimeouts.set(workspaceId, timeout);
  }

  private ensureSubscribed(workspaceId: string): void {
    const client = this.client;
    if (!client || this.subscriptions.has(workspaceId)) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    const subscription: {
      controller: AbortController;
      iterator: AsyncIterator<{
        processes: BackgroundProcessInfo[];
        foregroundToolCallIds: string[];
      }> | null;
    } = {
      controller,
      iterator: null,
    };

    this.subscriptions.set(workspaceId, subscription);

    (async () => {
      try {
        const subscribedIterator = await client.workspace.backgroundBashes.subscribe(
          { workspaceId },
          { signal }
        );

        // If we unsubscribed while subscribe() was in-flight, force-close the iterator so
        // the backend can drop its EventEmitter listener.
        if (signal.aborted || this.subscriptions.get(workspaceId) !== subscription) {
          void subscribedIterator.return?.();
          return;
        }

        subscription.iterator = subscribedIterator;

        for await (const state of subscribedIterator) {
          if (signal.aborted) break;

          const previousProcesses = this.processesCache.get(workspaceId) ?? EMPTY_PROCESSES;
          if (!areProcessesEqual(previousProcesses, state.processes)) {
            this.processesCache.set(workspaceId, state.processes);
            this.processesStore.bump(workspaceId);
          }

          const nextForeground = new Set(state.foregroundToolCallIds);
          const previousForeground = this.foregroundIdsCache.get(workspaceId) ?? EMPTY_SET;
          if (!areSetsEqual(previousForeground, nextForeground)) {
            this.foregroundIdsCache.set(workspaceId, nextForeground);
            this.foregroundIdsStore.bump(workspaceId);
          }

          const previousTerminating = this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET;
          if (previousTerminating.size > 0) {
            const runningIds = new Set(
              state.processes.filter((proc) => proc.status === "running").map((proc) => proc.id)
            );
            const nextTerminating = new Set(
              [...previousTerminating].filter((id) => runningIds.has(id))
            );
            if (!areSetsEqual(previousTerminating, nextTerminating)) {
              this.terminatingIdsCache.set(workspaceId, nextTerminating);
              this.terminatingIdsStore.bump(workspaceId);
            }
          }

          // Mark known AFTER applying the snapshot so observers that wake on
          // the known-flip read fully-populated caches.
          this.markStateKnown(workspaceId);
        }
      } catch (err) {
        if (!signal.aborted && !isAbortError(err)) {
          console.error("Failed to subscribe to background bash state:", err);
          // Self-heal: a broken subscription must not hold the chat view's
          // first-paint barrier — treat the state as known (empty) and let
          // the retry deliver real data later.
          this.markStateKnown(workspaceId);
        }
      } finally {
        void subscription.iterator?.return?.();
        subscription.iterator = null;

        if (this.subscriptions.get(workspaceId) === subscription) {
          this.subscriptions.delete(workspaceId);
        }

        if (!signal.aborted && this.client && this.subscriptionCounts.has(workspaceId)) {
          // Retry after unexpected disconnects so background bash status recovers without refresh.
          this.scheduleRetry(workspaceId);
        }
      }
    })();
  }

  private markTerminating(workspaceId: string, processId: string): void {
    const previous = this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET;
    if (previous.has(processId)) {
      return;
    }

    const next = new Set(previous);
    next.add(processId);
    this.terminatingIdsCache.set(workspaceId, next);
    this.terminatingIdsStore.bump(workspaceId);
  }

  private clearTerminating(workspaceId: string, processId: string): void {
    const previous = this.terminatingIdsCache.get(workspaceId);
    if (!previous?.has(processId)) {
      return;
    }

    const next = new Set(previous);
    next.delete(processId);
    this.terminatingIdsCache.set(workspaceId, next);
    this.terminatingIdsStore.bump(workspaceId);
  }
}

let storeInstance: BackgroundBashStore | null = null;

function getStoreInstance(): BackgroundBashStore {
  storeInstance ??= new BackgroundBashStore();
  return storeInstance;
}

export function useBackgroundBashStoreRaw(): BackgroundBashStore {
  return getStoreInstance();
}

export function useBackgroundProcesses(workspaceId: string | undefined): BackgroundProcessInfo[] {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeProcesses(workspaceId, listener) : () => undefined),
    () => (workspaceId ? store.getProcesses(workspaceId) : EMPTY_PROCESSES)
  );
}

export function useForegroundBashToolCallIds(workspaceId: string | undefined): Set<string> {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) =>
      workspaceId ? store.subscribeForegroundIds(workspaceId, listener) : () => undefined,
    () => (workspaceId ? store.getForegroundIds(workspaceId) : EMPTY_SET)
  );
}

export function useBackgroundBashTerminatingIds(workspaceId: string | undefined): Set<string> {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) =>
      workspaceId ? store.subscribeTerminatingIds(workspaceId, listener) : () => undefined,
    () => (workspaceId ? store.getTerminatingIds(workspaceId) : EMPTY_SET)
  );
}

/**
 * True once this workspace's background-bash state is known (first snapshot
 * received this app session, or self-healed after a subscription failure).
 * Subscribing also keeps the live backend subscription alive — see
 * subscribeStateKnown.
 */
export function useBackgroundBashStateKnown(workspaceId: string): boolean {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeStateKnown(workspaceId, listener),
    () => store.isStateKnown(workspaceId)
  );
}
