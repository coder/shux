import { useContext, useEffect, useState } from "react";

import { APIContext, useAPI, type APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";
import { assertNever } from "@/common/utils/assertNever";

export interface UseWorkflowRunsResult {
  /** Top-level runs for the workspace, most-recently-updated first. */
  runs: WorkflowRunRecord[];
  /** True until the first snapshot arrives. */
  loading: boolean;
  error: string | null;
}

export interface UseWorkflowRunLiveSnapshotResult {
  run: WorkflowRunRecord | null;
  failed: boolean;
}

function recency(run: WorkflowRunRecord): number {
  const value = Date.parse(run.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Live workflow-run feed for one workspace. Subscribes to `workflows.subscribe`
 * (snapshot + per-write deltas) and keeps a local id→record map in sync, so the
 * tab reflects step/status progress in real time without polling. Mirrors
 * `useDevToolsSubscription`.
 */
export function useWorkflowRuns(workspaceId: string): UseWorkflowRunsResult {
  const { api } = useAPI();
  const [runsById, setRunsById] = useState<Map<string, WorkflowRunRecord>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setRunsById(new Map());
      setLoading(false);
      return;
    }

    setRunsById(new Map());
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<WorkflowRunStreamEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.workflows.subscribe({ workspaceId }, { signal });
      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }
      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) {
          break;
        }
        switch (event.type) {
          case "snapshot":
            setRunsById(new Map(event.runs.map((run) => [run.id, run])));
            setLoading(false);
            break;
          case "run-changed":
            setRunsById((previous) => {
              const next = new Map(previous);
              next.set(event.run.id, event.run);
              return next;
            });
            break;
          default:
            assertNever(event);
        }
      }
    };

    subscribe().catch((subscriptionError: unknown) => {
      if (signal.aborted || isAbortError(subscriptionError)) {
        return;
      }
      setError(
        subscriptionError instanceof Error
          ? subscriptionError.message
          : "Workflow subscription failed"
      );
      setLoading(false);
    });

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, workspaceId]);

  // React Compiler memoizes this derivation; no manual useMemo needed.
  const runs = [...runsById.values()].sort((a, b) => recency(b) - recency(a));
  return { runs, loading, error };
}

interface WorkflowFeedListener {
  runId: string;
  onRun: (run: WorkflowRunRecord) => void;
  onFailure: () => void;
}

interface WorkspaceWorkflowFeed {
  controller: AbortController;
  iterator: AsyncIterator<WorkflowRunStreamEvent> | null;
  listeners: Set<WorkflowFeedListener>;
  latestByRunId: Map<string, WorkflowRunRecord>;
  failed: boolean;
}

// One workflows.subscribe stream per (api, workspace), shared by every transcript card: the
// backend runs crash recovery plus a full listRuns for each new stream and fans every delta out
// to every stream, so N concurrent cards must not open N workspace-wide streams. Keying by api
// instance drops feeds naturally when a connection is replaced.
const workflowFeedsByApi = new WeakMap<APIClient, Map<string, WorkspaceWorkflowFeed>>();

function notifyWorkflowFeedRun(feed: WorkspaceWorkflowFeed, run: WorkflowRunRecord): void {
  for (const listener of [...feed.listeners]) {
    if (listener.runId === run.id) {
      listener.onRun(run);
    }
  }
}

function createWorkspaceWorkflowFeed(api: APIClient, workspaceId: string): WorkspaceWorkflowFeed {
  const controller = new AbortController();
  const { signal } = controller;
  const feed: WorkspaceWorkflowFeed = {
    controller,
    iterator: null,
    listeners: new Set(),
    latestByRunId: new Map(),
    failed: false,
  };

  const pump = async () => {
    const iterator = await api.workflows.subscribe({ workspaceId }, { signal });
    if (signal.aborted) {
      void iterator.return?.();
      return;
    }
    feed.iterator = iterator;

    for await (const event of iterator) {
      if (signal.aborted) {
        break;
      }
      switch (event.type) {
        case "snapshot":
          for (const run of event.runs) {
            feed.latestByRunId.set(run.id, run);
            notifyWorkflowFeedRun(feed, run);
          }
          break;
        case "run-changed":
          feed.latestByRunId.set(event.run.id, event.run);
          notifyWorkflowFeedRun(feed, event.run);
          break;
        default:
          assertNever(event);
      }
    }
  };

  pump().catch((subscriptionError: unknown) => {
    if (signal.aborted || isAbortError(subscriptionError)) {
      return;
    }
    feed.failed = true;
    for (const listener of [...feed.listeners]) {
      listener.onFailure();
    }
  });

  return feed;
}

/**
 * Attach a listener to the shared per-workspace feed, creating it on first use. Replays the
 * cached state for the listener's run (or the failure) so late subscribers do not wait for the
 * next delta. Returns a release callback; the last release tears the stream down.
 */
function acquireWorkflowFeed(
  api: APIClient,
  workspaceId: string,
  listener: WorkflowFeedListener
): () => void {
  let feeds = workflowFeedsByApi.get(api);
  if (feeds == null) {
    feeds = new Map();
    workflowFeedsByApi.set(api, feeds);
  }
  let feed = feeds.get(workspaceId);
  if (feed == null) {
    feed = createWorkspaceWorkflowFeed(api, workspaceId);
    feeds.set(workspaceId, feed);
  }
  feed.listeners.add(listener);

  const cachedRun = feed.latestByRunId.get(listener.runId);
  if (cachedRun != null) {
    listener.onRun(cachedRun);
  }
  if (feed.failed) {
    listener.onFailure();
  }

  return () => {
    feed.listeners.delete(listener);
    if (feed.listeners.size === 0) {
      feeds.delete(workspaceId);
      feed.controller.abort();
      void feed.iterator?.return?.();
    }
  };
}

/** Live snapshots for one known run, used by transcript tool cards while the run is active. */
export function useWorkflowRunLiveSnapshot(input: {
  workspaceId?: string;
  runId?: string;
  enabled: boolean;
}): UseWorkflowRunLiveSnapshotResult {
  const api = useContext(APIContext)?.api;
  const subscriptionKey =
    input.enabled && api != null && input.workspaceId != null && input.runId != null
      ? `${input.workspaceId}:${input.runId}`
      : null;
  const [state, setState] = useState<{
    key: string;
    run: WorkflowRunRecord | null;
    failed: boolean;
  }>({ key: "", run: null, failed: false });
  const run = state.key === subscriptionKey ? state.run : null;
  const failed = state.key === subscriptionKey && state.failed;

  useEffect(() => {
    if (
      subscriptionKey == null ||
      api == null ||
      input.workspaceId == null ||
      input.runId == null
    ) {
      return;
    }

    setState({ key: subscriptionKey, run: null, failed: false });
    return acquireWorkflowFeed(api, input.workspaceId, {
      runId: input.runId,
      onRun: (nextRun) => {
        setState({ key: subscriptionKey, run: nextRun, failed: false });
      },
      onFailure: () => {
        setState((current) =>
          current.key === subscriptionKey ? { ...current, failed: true } : current
        );
      },
    });
  }, [api, input.runId, input.workspaceId, subscriptionKey]);

  return { run, failed };
}
