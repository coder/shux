/**
 * Store for managing GitHub PR status information.
 *
 * Architecture:
 * - Lives outside React lifecycle (stable references)
 * - Detects workspace PR via branch, tracked merge ref, then commit SHA fallbacks
 * - Caches status with TTL
 * - Refreshes on focus (like GitStatusStore)
 * - Notifies subscribers when status changes
 *
 * PR detection:
 * - Tries `gh pr view` for the current branch, its tracked merge ref, then its commit SHA
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type {
  GitHubPRLink,
  GitHubPRStatus,
  GitHubPRLinkWithStatus,
  MergeQueueEntry,
  WorkspaceStackBranch,
  WorkspaceStackInfo,
} from "@/common/types/links";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createLRUCache } from "@/browser/utils/lruCache";
import {
  canRunPassiveRuntimeCommand,
  onPassiveRuntimeEligible,
  type PassiveRuntimeDeps,
} from "@/browser/utils/runtimeExecutionPolicy";
/**
 * Parse a GitHub PR URL to extract owner, repo, and number.
 * Returns null if the URL is not a valid GitHub PR URL.
 */
function parseGitHubPRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}
import { MapStore } from "./MapStore";
import { RefreshController } from "@/browser/utils/RefreshController";
import { repoRootBashOptions } from "@/browser/utils/executeBash";
import { useSyncExternalStore } from "react";
import {
  useRuntimeStatusStoreRaw as getRuntimeStatusStore,
  type RuntimeStatusStore,
} from "./RuntimeStatusStore";

// Cache TTL: PR status is refreshed at most every 5 seconds
const STATUS_CACHE_TTL_MS = 5 * 1000;

// How long to wait before retrying after an error
const ERROR_RETRY_DELAY_MS = 5 * 1000;
const STACK_CACHE_TTL_MS = 60_000;

// GraphQL query for merge queue data (not available in `gh pr view --json`).
const MERGE_QUEUE_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){mergeQueueEntry{state position}}}}";

export const DETECT_PR_SCRIPT = `fields='number,url,state,mergeable,mergeStateStatus,title,isDraft,headRefName,baseRefName,statusCheckRollup'
if out=$(gh pr view --json "$fields" 2>/dev/null); then printf '%s\n' "$out"; exit 0; fi
branch=$(git branch --show-current 2>/dev/null)
merge_ref=$(git config "branch.$branch.merge" 2>/dev/null)
merge_ref=\${merge_ref#refs/heads/}
# The tracked merge ref covers local branches tracking a differently named remote branch.
if [ -n "$merge_ref" ] && [ "$merge_ref" != "$branch" ]; then
  if out=$(gh pr view "$merge_ref" --json "$fields" 2>/dev/null); then printf '%s\n' "$out"; exit 0; fi
fi
sha=$(git rev-parse HEAD 2>/dev/null)
if [ -n "$sha" ]; then
  # The SHA lookup is the only fallback with zero local hints after a differently named refspec push.
  # Open-only avoids matching the merged PR that introduced an ancestor of a fresh workspace HEAD.
  num=$(gh api "repos/{owner}/{repo}/commits/$sha/pulls" --jq '[.[] | select(.state == "open")][0].number' 2>/dev/null)
  if [ -n "$num" ] && [ "$num" != "null" ]; then
    if out=$(gh pr view "$num" --json "$fields" 2>/dev/null); then printf '%s\n' "$out"; exit 0; fi
  fi
fi
echo '{"no_pr":true}'`;

interface PersistedPRStatus {
  prLink: GitHubPRLink | null;
  status?: GitHubPRStatus;
  stack?: WorkspaceStackInfo;
}

const prStatusLRU = createLRUCache<PersistedPRStatus>({
  entryPrefix: "prStatus:",
  indexKey: "prStatusIndex",
  maxEntries: 50,
  // No TTL - we refresh on mount anyway, just want instant display
});

function summarizeStatusCheckRollup(raw: unknown): {
  hasPendingChecks: boolean;
  hasFailedChecks: boolean;
} {
  if (!Array.isArray(raw)) {
    return { hasPendingChecks: false, hasFailedChecks: false };
  }

  let hasPendingChecks = false;
  let hasFailedChecks = false;

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const status = record.status;
    const conclusion = record.conclusion;

    // Many check APIs represent "pending" as a non-COMPLETED status and/or a null conclusion.
    if (typeof status === "string" && status !== "COMPLETED") {
      hasPendingChecks = true;
    }

    if (conclusion == null) {
      hasPendingChecks = true;
      continue;
    }

    if (typeof conclusion === "string") {
      // GitHub-style conclusions (StatusState is different from CheckConclusionState, but this is close enough)
      const normalized = conclusion.toUpperCase();
      if (
        normalized === "FAILURE" ||
        normalized === "CANCELLED" ||
        normalized === "TIMED_OUT" ||
        normalized === "ACTION_REQUIRED" ||
        normalized === "STARTUP_FAILURE"
      ) {
        hasFailedChecks = true;
      }
    }
  }

  return { hasPendingChecks, hasFailedChecks };
}

/**
 * Parse merge queue entry data from GitHub GraphQL response payloads.
 */
export function parseMergeQueueEntry(raw: unknown): MergeQueueEntry | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const state = typeof record.state === "string" ? record.state : "QUEUED";
  const positionRaw = record.position;
  const position =
    typeof positionRaw === "number" && Number.isInteger(positionRaw) && positionRaw >= 0
      ? positionRaw
      : null;

  return { state, position };
}

function isStackPRState(value: unknown): value is NonNullable<WorkspaceStackBranch["pr"]>["state"] {
  return value === "OPEN" || value === "MERGED" || value === "QUEUED" || value === "CLOSED";
}

export function parseStackViewOutput(output: string): WorkspaceStackInfo | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (record.no_stack === true || typeof record.trunk !== "string") {
      return null;
    }
    if (!Array.isArray(record.branches) || record.branches.length < 2) {
      return null;
    }

    const branches: WorkspaceStackBranch[] = [];
    for (const rawBranch of record.branches) {
      if (typeof rawBranch !== "object" || rawBranch === null) {
        return null;
      }

      const branchRecord = rawBranch as Record<string, unknown>;
      if (
        typeof branchRecord.name !== "string" ||
        typeof branchRecord.isCurrent !== "boolean" ||
        typeof branchRecord.isMerged !== "boolean" ||
        typeof branchRecord.isQueued !== "boolean" ||
        typeof branchRecord.needsRebase !== "boolean"
      ) {
        return null;
      }

      let pr: WorkspaceStackBranch["pr"];
      if (branchRecord.pr != null) {
        if (typeof branchRecord.pr !== "object") {
          return null;
        }

        const prRecord = branchRecord.pr as Record<string, unknown>;
        if (
          typeof prRecord.number !== "number" ||
          !Number.isInteger(prRecord.number) ||
          prRecord.number <= 0 ||
          !isStackPRState(prRecord.state) ||
          (prRecord.url != null && typeof prRecord.url !== "string")
        ) {
          return null;
        }

        const state = branchRecord.isMerged
          ? "MERGED"
          : branchRecord.isQueued
            ? "QUEUED"
            : prRecord.state;
        pr = {
          number: prRecord.number,
          state,
          ...(typeof prRecord.url === "string" ? { url: prRecord.url } : {}),
        };
      }

      branches.push({
        branch: branchRecord.name,
        isCurrent: branchRecord.isCurrent,
        needsRebase: branchRecord.needsRebase,
        ...(pr ? { pr } : {}),
      });
    }

    return { trunk: record.trunk, branches };
  } catch {
    return null;
  }
}

export function mergeStackPullRequestMetadata(
  stack: WorkspaceStackInfo,
  raw: unknown
): WorkspaceStackInfo {
  if (typeof raw !== "object" || raw === null) {
    return stack;
  }

  const data = (raw as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) {
    return stack;
  }

  const repository = (data as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null) {
    return stack;
  }

  const pullRequests = repository as Record<string, unknown>;
  return {
    ...stack,
    branches: stack.branches.map((branch) => {
      if (!branch.pr) {
        return branch;
      }

      const rawPullRequest = pullRequests[`p${branch.pr.number}`];
      if (typeof rawPullRequest !== "object" || rawPullRequest === null) {
        return branch;
      }

      const pullRequest = rawPullRequest as Record<string, unknown>;
      if (pullRequest.number !== branch.pr.number) {
        return branch;
      }

      const graphqlState = pullRequest.state;
      const state =
        branch.pr.state === "QUEUED" && graphqlState === "OPEN"
          ? "QUEUED"
          : isStackPRState(graphqlState)
            ? graphqlState
            : branch.pr.state;

      return {
        ...branch,
        pr: {
          ...branch.pr,
          state,
          ...(typeof pullRequest.title === "string" ? { title: pullRequest.title } : {}),
          ...(typeof pullRequest.isDraft === "boolean" ? { isDraft: pullRequest.isDraft } : {}),
        },
      };
    }),
  };
}

/**
 * Workspace PR detection result (from branch, not chat).
 */
interface WorkspacePRCacheEntry {
  /** The detected PR link (null if no PR for this branch) */
  prLink: GitHubPRLink | null;
  /** PR status if available */
  status?: GitHubPRStatus;
  error?: string;
  fetchedAt: number;
  loading: boolean;
}

interface WorkspaceStackCacheEntry {
  stack: WorkspaceStackInfo | null;
  fetchedAt: number;
  loading: boolean;
}

interface MergeQueueRefreshRequest {
  prLinkBase: { owner: string; repo: string; number: number };
  prUrl: string;
  statusFetchedAt: number;
}

/**
 * Store for GitHub PR status. Fetches status via gh CLI and caches results.
 */
export class PRStatusStore {
  private client: RouterClient<AppRouter> | null = null;
  private readonly refreshController: RefreshController;
  private isActive = true;

  private workspacePRSubscriptions = new MapStore<string, WorkspacePRCacheEntry>();
  private workspacePRCache = new Map<string, WorkspacePRCacheEntry>();
  private workspaceStackCache = new Map<string, WorkspaceStackCacheEntry>();
  private runtimeRetryUnsubscribers = new Map<string, () => void>();

  // Track active subscriptions per workspace so we only refresh workspaces that are actually visible.
  private workspaceSubscriptionCounts = new Map<string, number>();

  // Track latest merge queue enrichment request while an in-flight fetch is running.
  private mergeQueueRefreshPending = new Map<string, MergeQueueRefreshRequest>();

  // Track per-workspace async merge queue enrichment to avoid overlapping gh api calls.
  private mergeQueueRefreshInFlight = new Map<string, Promise<void>>();

  // Like GitStatusStore: batch immediate refreshes triggered by subscriptions.
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private readonly runtimeStatusStore: PassiveRuntimeDeps;

  constructor(runtimeStatusStore?: PassiveRuntimeDeps);
  constructor(runtimeStatusStore?: Pick<RuntimeStatusStore, "getStatus">);
  constructor(
    runtimeStatusStore:
      | PassiveRuntimeDeps
      | Pick<RuntimeStatusStore, "getStatus"> = getRuntimeStatusStore()
  ) {
    this.runtimeStatusStore = {
      getStatus: (workspaceId) => runtimeStatusStore.getStatus(workspaceId),
      subscribeKey:
        "subscribeKey" in runtimeStatusStore
          ? (workspaceId, listener) => runtimeStatusStore.subscribeKey(workspaceId, listener)
          : () => () => undefined,
    };
    this.refreshController = new RefreshController({
      onRefresh: () => this.refreshAll(),
      onRefreshError: (failure) => {
        console.error("[PRStatusStore] refresh failed:", failure.errorMessage);
      },
      debounceMs: 5000,
      refreshOnFocus: true,
      focusDebounceMs: 1000,
    });
  }

  setClient(client: RouterClient<AppRouter> | null): void {
    this.client = client;

    if (!client) {
      return;
    }

    // If hooks subscribed before the client was ready, ensure we refresh once it is.
    if (this.workspaceSubscriptionCounts.size > 0) {
      this.refreshController.requestImmediate();
    }
  }

  syncWorkspaces(metadata: Map<string, FrontendWorkspaceMetadata>): void {
    if (!this.isActive && metadata.size > 0) {
      this.isActive = true;
    }

    this.workspaceMetadata = metadata;
    for (const [id, unsubscribe] of this.runtimeRetryUnsubscribers) {
      if (!metadata.has(id)) {
        unsubscribe();
        this.runtimeRetryUnsubscribers.delete(id);
      }
    }
    this.refreshController.bindListeners();
    this.refreshController.requestImmediate();
  }

  /** Subscriptions drive refresh, so consumers do not monitor workspaces separately. */
  subscribeWorkspace = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.workspacePRSubscriptions.subscribeKey(workspaceId, listener);

    // Track active subscriptions so focus refresh only runs for visible workspaces.
    const current = this.workspaceSubscriptionCounts.get(workspaceId) ?? 0;
    this.workspaceSubscriptionCounts.set(workspaceId, current + 1);

    // Bind focus/visibility listeners once we have any subscribers.
    this.refreshController.bindListeners();

    // Kick an immediate refresh so the UI doesn't wait for the next focus event.
    // Use a microtask to batch multiple subscribe calls in the same render.
    if (!this.immediateUpdateQueued && this.isActive && this.client) {
      this.immediateUpdateQueued = true;
      queueMicrotask(() => {
        this.immediateUpdateQueued = false;
        this.refreshController.requestImmediate();
      });
    }

    return () => {
      unsubscribe();
      const next = (this.workspaceSubscriptionCounts.get(workspaceId) ?? 1) - 1;
      if (next <= 0) {
        this.workspaceSubscriptionCounts.delete(workspaceId);
        this.runtimeRetryUnsubscribers.get(workspaceId)?.();
        this.runtimeRetryUnsubscribers.delete(workspaceId);
      } else {
        this.workspaceSubscriptionCounts.set(workspaceId, next);
      }
    };
  };

  /**
   * Get workspace PR detection result.
   * Checks in-memory cache first, then falls back to localStorage for persistence
   * across app restarts.
   */
  getWorkspacePR(workspaceId: string): WorkspacePRCacheEntry | undefined {
    const memCached = this.workspacePRCache.get(workspaceId);
    if (memCached) return memCached;

    // Check localStorage for persisted status (app restart scenario)
    const persisted = prStatusLRU.get(workspaceId);
    if (persisted) {
      // Hydrate memory cache from localStorage, mark as loading to trigger refresh
      // but show the cached value immediately (optimistic UI)
      const entry: WorkspacePRCacheEntry = {
        prLink: persisted.prLink,
        status: persisted.status,
        loading: true,
        fetchedAt: 0,
      };
      this.workspacePRCache.set(workspaceId, entry);
      return entry;
    }

    return undefined;
  }

  getWorkspaceStack(workspaceId: string): WorkspaceStackCacheEntry | undefined {
    const memCached = this.workspaceStackCache.get(workspaceId);
    if (memCached) return memCached;

    const persisted = prStatusLRU.get(workspaceId);
    if (!persisted?.stack) {
      return undefined;
    }

    const entry: WorkspaceStackCacheEntry = {
      stack: persisted.stack,
      loading: true,
      fetchedAt: 0,
    };
    this.workspaceStackCache.set(workspaceId, entry);
    return entry;
  }

  private persistWorkspacePR(
    workspaceId: string,
    prLink: GitHubPRLink,
    status: GitHubPRStatus
  ): void {
    const stackEntry = this.workspaceStackCache.get(workspaceId);
    const persistedStack = stackEntry
      ? (stackEntry.stack ?? undefined)
      : prStatusLRU.get(workspaceId)?.stack;
    prStatusLRU.set(workspaceId, {
      prLink,
      status,
      ...(persistedStack ? { stack: persistedStack } : {}),
    });
  }

  private persistWorkspaceStack(workspaceId: string, stack: WorkspaceStackInfo | null): void {
    const persisted = prStatusLRU.get(workspaceId);
    if (!stack) {
      if (persisted?.stack) {
        prStatusLRU.set(workspaceId, {
          prLink: persisted.prLink,
          status: persisted.status,
        });
      }
      return;
    }

    const prEntry = this.workspacePRCache.get(workspaceId);
    prStatusLRU.set(workspaceId, {
      prLink: prEntry ? prEntry.prLink : (persisted?.prLink ?? null),
      status: prEntry ? prEntry.status : persisted?.status,
      stack,
    });
  }

  private writeWorkspaceStack(workspaceId: string, stack: WorkspaceStackInfo | null): void {
    this.workspaceStackCache.set(workspaceId, {
      stack,
      loading: false,
      fetchedAt: Date.now(),
    });
    this.persistWorkspaceStack(workspaceId, stack);
    this.workspacePRSubscriptions.bump(workspaceId);
  }

  private async detectWorkspaceStack(workspaceId: string): Promise<void> {
    if (!this.client || !this.isActive) return;

    const existing = this.workspaceStackCache.get(workspaceId);
    this.workspaceStackCache.set(workspaceId, {
      stack: existing?.stack ?? null,
      loading: true,
      fetchedAt: Date.now(),
    });
    this.workspacePRSubscriptions.bump(workspaceId);

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId,
        script: `gh stack view --json 2>/dev/null || echo '{"no_stack":true}'`,
        options: repoRootBashOptions(20),
      });

      if (!this.isActive) return;
      if (!result.success || !result.data.success || !result.data.output) {
        this.writeWorkspaceStack(workspaceId, null);
        return;
      }

      const stack = parseStackViewOutput(result.data.output);
      if (!stack) {
        this.writeWorkspaceStack(workspaceId, null);
        return;
      }

      const enrichedStack = await this.enrichWorkspaceStack(workspaceId, stack);
      if (this.isActive) {
        this.writeWorkspaceStack(workspaceId, enrichedStack);
      }
    } catch {
      if (this.isActive) {
        this.writeWorkspaceStack(workspaceId, null);
      }
    }
  }

  private async enrichWorkspaceStack(
    workspaceId: string,
    stack: WorkspaceStackInfo
  ): Promise<WorkspaceStackInfo> {
    if (!this.client || !this.isActive) {
      return stack;
    }

    const repository = stack.branches
      .map((branch) => branch.pr?.url)
      .filter((url): url is string => url != null)
      .map(parseGitHubPRUrl)
      .find((parsed) => parsed != null);
    const numbers = Array.from(
      new Set(stack.branches.flatMap((branch) => (branch.pr ? [branch.pr.number] : [])))
    );
    if (!repository || numbers.length === 0) {
      return stack;
    }

    const fields = numbers
      .map((number) => `p${number}:pullRequest(number:${number}){number title state isDraft}`)
      .join(" ");
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`;

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId,
        script: [
          "gh api graphql",
          `-f query='${query}'`,
          `-f owner='${repository.owner}'`,
          `-f name='${repository.repo}'`,
          "2>/dev/null",
        ].join(" "),
        options: repoRootBashOptions(20),
      });

      if (!this.isActive || !result.success || !result.data.success || !result.data.output) {
        return stack;
      }

      return mergeStackPullRequestMetadata(stack, JSON.parse(result.data.output));
    } catch {
      return stack;
    }
  }

  /**
   * Detect a workspace PR using branch, tracked merge ref, and commit SHA fallbacks.
   */
  private async detectWorkspacePR(workspaceId: string): Promise<void> {
    if (!this.client || !this.isActive) return;

    // Mark as loading
    const existing = this.workspacePRCache.get(workspaceId);
    this.workspacePRCache.set(workspaceId, {
      prLink: existing?.prLink ?? null,
      status: existing?.status,
      loading: true,
      fetchedAt: Date.now(),
    });
    this.workspacePRSubscriptions.bump(workspaceId);

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId,
        script: DETECT_PR_SCRIPT,
        // gh requires the runtime environment for devcontainer workspaces where
        // the CLI / auth may only exist inside the container.
        options: repoRootBashOptions(30),
      });

      if (!this.isActive) return;

      if (!result.success || !result.data.success) {
        const existing = this.workspacePRCache.get(workspaceId);
        this.workspacePRCache.set(workspaceId, {
          prLink: existing?.prLink ?? null,
          status: existing?.status,
          error: "Failed to run gh CLI",
          loading: false,
          fetchedAt: Date.now(),
        });
        this.workspacePRSubscriptions.bump(workspaceId);
        return;
      }

      const output = result.data.output;
      if (output) {
        const parsed = JSON.parse(output) as Record<string, unknown>;

        if ("no_pr" in parsed) {
          // No PR for this branch
          this.workspacePRCache.set(workspaceId, {
            prLink: null,
            loading: false,
            fetchedAt: Date.now(),
          });
        } else {
          // Parse PR link from URL
          const prUrl = parsed.url as string;
          const prLinkBase = parseGitHubPRUrl(prUrl);

          if (!prLinkBase) {
            this.workspacePRCache.set(workspaceId, {
              prLink: null,
              error: "Invalid PR URL from gh CLI",
              loading: false,
              fetchedAt: Date.now(),
            });
          } else {
            const { hasPendingChecks, hasFailedChecks } = summarizeStatusCheckRollup(
              parsed.statusCheckRollup
            );

            const status: GitHubPRStatus = {
              state: (parsed.state as GitHubPRStatus["state"]) ?? "OPEN",
              mergeable: (parsed.mergeable as GitHubPRStatus["mergeable"]) ?? "UNKNOWN",
              mergeStateStatus:
                (parsed.mergeStateStatus as GitHubPRStatus["mergeStateStatus"]) ?? "UNKNOWN",
              title: (parsed.title as string) ?? "",
              isDraft: (parsed.isDraft as boolean) ?? false,
              headRefName: (parsed.headRefName as string) ?? "",
              baseRefName: (parsed.baseRefName as string) ?? "",
              hasPendingChecks,
              hasFailedChecks,
              fetchedAt: Date.now(),
            };

            const prLink: GitHubPRLink = {
              type: "github-pr",
              url: prUrl,
              ...prLinkBase,
              detectedAt: Date.now(),
              occurrenceCount: 1,
            };

            this.workspacePRCache.set(workspaceId, {
              prLink,
              status,
              loading: false,
              fetchedAt: Date.now(),
            });

            // Persist to localStorage for instant display on app restart
            this.persistWorkspacePR(workspaceId, prLink, status);

            this.scheduleMergeQueueRefresh(workspaceId, prLinkBase, prUrl, status.fetchedAt);
          }
        }
      } else {
        const existing = this.workspacePRCache.get(workspaceId);
        this.workspacePRCache.set(workspaceId, {
          prLink: existing?.prLink ?? null,
          status: existing?.status,
          error: "Empty response from gh CLI",
          loading: false,
          fetchedAt: Date.now(),
        });
      }

      this.workspacePRSubscriptions.bump(workspaceId);
    } catch (err) {
      if (!this.isActive) return;

      const existing = this.workspacePRCache.get(workspaceId);
      this.workspacePRCache.set(workspaceId, {
        prLink: existing?.prLink ?? null,
        status: existing?.status,
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
        fetchedAt: Date.now(),
      });
      this.workspacePRSubscriptions.bump(workspaceId);
    }
  }

  /**
   * Enqueue merge queue enrichment and retain a single follow-up request if one arrives
   * while a fetch is already in flight.
   */
  private scheduleMergeQueueRefresh(
    workspaceId: string,
    prLinkBase: { owner: string; repo: string; number: number },
    prUrl: string,
    statusFetchedAt: number
  ): void {
    const request: MergeQueueRefreshRequest = {
      prLinkBase,
      prUrl,
      statusFetchedAt,
    };

    if (this.mergeQueueRefreshInFlight.has(workspaceId)) {
      this.mergeQueueRefreshPending.set(workspaceId, request);
      return;
    }

    this.startMergeQueueRefresh(workspaceId, request);
  }

  private startMergeQueueRefresh(workspaceId: string, request: MergeQueueRefreshRequest): void {
    const refreshPromise = this.fetchMergeQueueEntry(workspaceId, request.prLinkBase)
      .then((mergeQueueEntry) => {
        if (!this.isActive || mergeQueueEntry == null) {
          return;
        }

        const currentEntry = this.workspacePRCache.get(workspaceId);
        if (!currentEntry?.status || !currentEntry.prLink) {
          return;
        }

        // Ignore stale async updates from older refresh cycles.
        if (
          currentEntry.status.fetchedAt !== request.statusFetchedAt ||
          currentEntry.prLink.url !== request.prUrl
        ) {
          return;
        }

        const updatedStatus: GitHubPRStatus = {
          ...currentEntry.status,
          mergeQueueEntry,
        };
        this.workspacePRCache.set(workspaceId, {
          ...currentEntry,
          status: updatedStatus,
        });
        this.persistWorkspacePR(workspaceId, currentEntry.prLink, updatedStatus);
        this.workspacePRSubscriptions.bump(workspaceId);
      })
      .catch(() => {
        // Non-fatal: merge queue metadata is best-effort.
      })
      .finally(() => {
        const inFlight = this.mergeQueueRefreshInFlight.get(workspaceId);
        if (inFlight === refreshPromise) {
          this.mergeQueueRefreshInFlight.delete(workspaceId);
        }

        const pendingRequest = this.mergeQueueRefreshPending.get(workspaceId);
        if (!this.isActive || !pendingRequest) {
          return;
        }

        this.mergeQueueRefreshPending.delete(workspaceId);
        this.startMergeQueueRefresh(workspaceId, pendingRequest);
      });

    this.mergeQueueRefreshInFlight.set(workspaceId, refreshPromise);
  }

  /**
   * Fetch merge queue details via GraphQL.
   * Best-effort only: failures should not block normal PR status updates.
   */
  private async fetchMergeQueueEntry(
    workspaceId: string,
    prLink: { owner: string; repo: string; number: number }
  ): Promise<MergeQueueEntry | null> {
    if (!this.client || !this.isActive) {
      return null;
    }

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId,
        script: [
          "gh api graphql",
          `-f query='${MERGE_QUEUE_QUERY}'`,
          `-f owner='${prLink.owner}'`,
          `-f repo='${prLink.repo}'`,
          `-F number=${prLink.number}`,
          "2>/dev/null",
        ].join(" "),
        // gh requires the runtime environment for devcontainer workspaces where
        // the CLI / auth may only exist inside the container.
        options: repoRootBashOptions(10),
      });

      if (!this.isActive || !result.success || !result.data.success) {
        return null;
      }

      if (!result.data.output) {
        return null;
      }

      const parsed = JSON.parse(result.data.output) as Record<string, unknown>;
      const data = parsed.data;
      if (typeof data !== "object" || data === null) {
        return null;
      }

      const repository = (data as Record<string, unknown>).repository;
      if (typeof repository !== "object" || repository === null) {
        return null;
      }

      const pullRequest = (repository as Record<string, unknown>).pullRequest;
      if (typeof pullRequest !== "object" || pullRequest === null) {
        return null;
      }

      return parseMergeQueueEntry((pullRequest as Record<string, unknown>).mergeQueueEntry);
    } catch {
      return null;
    }
  }

  private shouldFetchWorkspace(entry: WorkspacePRCacheEntry | undefined, now: number): boolean {
    if (!entry) return true;
    // Allow refresh if entry was hydrated from localStorage (fetchedAt === 0)
    // but is marked loading - this means we have stale cached data and need fresh data.
    if (entry.loading && entry.fetchedAt !== 0) return false;

    if (entry.error) {
      return now - entry.fetchedAt > ERROR_RETRY_DELAY_MS;
    }

    return now - entry.fetchedAt > STATUS_CACHE_TTL_MS;
  }

  private shouldFetchStack(entry: WorkspaceStackCacheEntry | undefined, now: number): boolean {
    if (!entry) return true;
    if (entry.loading && entry.fetchedAt !== 0) return false;
    return now - entry.fetchedAt > STACK_CACHE_TTL_MS;
  }

  private async refreshAll(): Promise<void> {
    if (!this.client || !this.isActive) return;

    const workspaceIds = Array.from(this.workspaceSubscriptionCounts.keys());
    if (workspaceIds.length === 0) {
      return;
    }

    const now = Date.now();
    const refreshes: Array<Promise<void>> = [];

    for (const workspaceId of workspaceIds) {
      const shouldFetchPR = this.shouldFetchWorkspace(this.workspacePRCache.get(workspaceId), now);
      const shouldFetchStack = this.shouldFetchStack(
        this.workspaceStackCache.get(workspaceId),
        now
      );
      if (!shouldFetchPR && !shouldFetchStack) {
        continue;
      }

      // Skip passive GitHub refreshes for devcontainer workspaces whose runtime is
      // not already running, to avoid waking stopped containers.
      const metadata = this.workspaceMetadata.get(workspaceId);
      if (
        metadata &&
        !canRunPassiveRuntimeCommand(
          metadata.runtimeConfig,
          this.runtimeStatusStore.getStatus(workspaceId)
        )
      ) {
        if (!this.runtimeRetryUnsubscribers.has(workspaceId)) {
          let firedSynchronously = false;
          const unsubscribe = onPassiveRuntimeEligible(
            workspaceId,
            metadata.runtimeConfig,
            this.runtimeStatusStore,
            () => {
              firedSynchronously = true;
              this.runtimeRetryUnsubscribers.delete(workspaceId);
              // Clear due entries so cache TTLs cannot suppress the deferred refresh.
              if (shouldFetchPR) {
                this.workspacePRCache.delete(workspaceId);
              }
              if (shouldFetchStack) {
                this.workspaceStackCache.delete(workspaceId);
              }
              this.refreshController.requestImmediate();
            }
          );
          if (!firedSynchronously) {
            this.runtimeRetryUnsubscribers.set(workspaceId, unsubscribe);
          }
        }
        continue;
      }

      if (shouldFetchPR) {
        refreshes.push(this.detectWorkspacePR(workspaceId));
      }
      if (shouldFetchStack) {
        refreshes.push(this.detectWorkspaceStack(workspaceId));
      }
    }

    await Promise.all(refreshes);
  }

  /**
   * Dispose the store.
   */
  dispose(): void {
    this.isActive = false;
    this.mergeQueueRefreshPending.clear();
    this.mergeQueueRefreshInFlight.clear();
    for (const unsubscribe of this.runtimeRetryUnsubscribers.values()) {
      unsubscribe();
    }
    this.runtimeRetryUnsubscribers.clear();
    this.refreshController.dispose();
  }
}

// Singleton instance
let storeInstance: PRStatusStore | null = null;

export function getPRStatusStoreInstance(): PRStatusStore {
  storeInstance ??= new PRStatusStore();
  return storeInstance;
}

// ─────────────────────────────────────────────────────────────────────────────
// React hooks
// ─────────────────────────────────────────────────────────────────────────────

// Cache for useWorkspacePR hook to return stable references
const workspacePRHookCache = new Map<string, GitHubPRLinkWithStatus | null>();

/**
 * Hook to get PR for a workspace (branch-based detection).
 * Returns the detected PR with status, or null if no PR for this branch.
 */
export function useWorkspacePR(workspaceId: string): GitHubPRLinkWithStatus | null {
  const store = getPRStatusStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeWorkspace(workspaceId, listener),
    () => {
      const cached = store.getWorkspacePR(workspaceId);
      const existing = workspacePRHookCache.get(workspaceId);

      // No data yet
      if (!cached) {
        if (existing === null) return existing;
        workspacePRHookCache.set(workspaceId, null);
        return null;
      }

      // No PR for this branch
      if (!cached.prLink) {
        if (existing === null) return existing;
        workspacePRHookCache.set(workspaceId, null);
        return null;
      }

      // Return same reference if nothing meaningful changed
      if (
        existing?.url === cached.prLink.url &&
        existing.status === cached.status &&
        existing.loading === cached.loading &&
        existing.error === cached.error
      ) {
        return existing;
      }

      // Build new object and cache it
      const newResult: GitHubPRLinkWithStatus = {
        ...cached.prLink,
        status: cached.status,
        loading: cached.loading,
        error: cached.error,
      };
      workspacePRHookCache.set(workspaceId, newResult);
      return newResult;
    }
  );
}

const workspaceStackHookCache = new Map<string, WorkspaceStackInfo | null>();

export function useWorkspaceStack(workspaceId: string): WorkspaceStackInfo | null {
  const store = getPRStatusStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeWorkspace(workspaceId, listener),
    () => {
      const stack = store.getWorkspaceStack(workspaceId)?.stack ?? null;
      const existing = workspaceStackHookCache.get(workspaceId);
      if (existing === stack) {
        return existing;
      }

      workspaceStackHookCache.set(workspaceId, stack);
      return stack;
    }
  );
}
