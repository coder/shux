import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { ProjectGitStatusResult as ApiProjectGitStatusResult } from "@/common/orpc/schemas/api";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { RefreshController } from "@/browser/utils/RefreshController";
import { repoRootBashOptions } from "@/browser/utils/executeBash";
import {
  canRunPassiveRuntimeCommand,
  onPassiveRuntimeEligible,
} from "@/browser/utils/runtimeExecutionPolicy";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { isSSHRuntime } from "@/common/types/runtime";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import assert from "@/common/utils/assert";
import {
  generateGitStatusScript,
  GIT_FETCH_SCRIPT,
  parseGitStatusScriptOutput,
} from "@/common/utils/git/gitStatus";
import { useSyncExternalStore } from "react";
import { MapStore } from "./MapStore";
import {
  useRuntimeStatusStoreRaw as getRuntimeStatusStore,
  type RuntimeStatusStore,
} from "./RuntimeStatusStore";

/**
 * External store for git status of all workspaces.
 *
 * Architecture:
 * - Lives outside React lifecycle (stable references)
 * - Event-driven updates (no polling):
 *   - Initial subscription triggers immediate fetch
 *   - File-modifying tools trigger debounced refresh (3s)
 *   - Window focus triggers refresh for visible workspaces
 *   - Explicit invalidation (branch switch, etc.)
 * - Manages git fetch with exponential backoff
 * - Notifies subscribers when status changes
 * - Components only re-render when their specific workspace status changes
 *
 * Uses RefreshController for debouncing, focus handling, and in-flight guards.
 */

// Configuration
const MAX_CONCURRENT_GIT_OPS = 5;

// Fetch configuration - aggressive intervals for fresh data
const FETCH_BASE_INTERVAL_MS = 3 * 1000; // 3 seconds
const FETCH_MAX_INTERVAL_MS = 60 * 1000; // 60 seconds
// Background fetches are unfiltered (see GIT_FETCH_SCRIPT) and may run a
// one-time full --refetch to heal repos poisoned into promisor/partial
// clones, so transfers can be much larger than the old blob-filtered ones.
// Killing a slow-but-progressing fetch wastes the entire transfer and leaves
// ahead/behind state permanently stale behind retry backoff, so budget for a
// full-object transfer instead.
const FETCH_TIMEOUT_SECS = 300; // 5 minutes

interface FetchState {
  lastFetch: number;
  inProgress: boolean;
  consecutiveFailures: number;
}

export interface ProjectGitStatusResult {
  projectPath: string;
  projectName: string;
  gitStatus: GitStatus | null;
  error: string | null;
}

export interface MultiProjectGitSummary {
  totalProjectCount: number;
  divergedProjectCount: number;
  dirtyProjectCount: number;
  unknownProjectCount: number;
  projects: ProjectGitStatusResult[];
}

interface SingleWorkspaceStatusUpdate {
  kind: "single";
  workspaceId: string;
  status: GitStatus | null;
}

interface MultiWorkspaceStatusUpdate {
  kind: "multi";
  workspaceId: string;
  legacyStatus: GitStatus | null;
  projectStatuses: ProjectGitStatusResult[] | null;
  summary: MultiProjectGitSummary | null;
}

function sumGitStatusField(
  statuses: readonly GitStatus[],
  getValue: (status: GitStatus) => number
): number {
  return statuses.reduce((sum, status) => sum + getValue(status), 0);
}

export class GitStatusStore {
  private statuses = new MapStore<string, GitStatus | null>();
  private projectStatuses = new MapStore<string, ProjectGitStatusResult[] | null>();
  private fetchCache = new Map<string, FetchState>();
  private runtimeStatusRetryUnsubscribers = new Map<string, () => void>();
  private runtimeFetchRetryUnsubscribers = new Map<string, () => void>();
  private client: RouterClient<AppRouter> | null = null;
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private isActive = true;

  // File modification subscription
  private fileModifyUnsubscribe: (() => void) | null = null;

  // RefreshController handles debouncing, focus/visibility, and in-flight guards
  private readonly refreshController: RefreshController;

  // Per-workspace refreshing state for UI shimmer effects
  private refreshingWorkspaces = new MapStore<string, boolean>();

  constructor(
    private readonly runtimeStatusStore: Pick<
      RuntimeStatusStore,
      "getStatus" | "subscribeKey"
    > = getRuntimeStatusStore()
  ) {
    // Create refresh controller with proactive focus refresh (catches external git changes)
    this.refreshController = new RefreshController({
      onRefresh: () => this.updateGitStatus(),
      onRefreshError: (failure) => {
        console.error("[GitStatusStore] refresh failed:", failure.errorMessage);
      },
      debounceMs: 3000, // Same as TOOL_REFRESH_DEBOUNCE_MS in ReviewPanel
      refreshOnFocus: true, // Proactively refresh on focus to catch external changes
      focusDebounceMs: 500, // Prevent spam from rapid alt-tabbing
    });
  }

  setClient(client: RouterClient<AppRouter> | null): void {
    this.client = client;

    if (!client) {
      return;
    }

    if (this.workspaceMetadata.size > 0) {
      this.refreshController.requestImmediate();
    }
  }

  /**
   * Subscribe to git status changes (any workspace).
   * Delegates to MapStore's subscribeAny.
   */
  subscribe = this.statuses.subscribeAny;

  private queueImmediateUpdate(): void {
    if (this.immediateUpdateQueued || !this.isActive || !this.client) {
      return;
    }

    this.immediateUpdateQueued = true;
    queueMicrotask(() => {
      this.immediateUpdateQueued = false;
      this.refreshController.requestImmediate();
    });
  }

  /**
   * Subscribe to git status changes for a specific workspace.
   * Only notified when this workspace's status changes.
   */
  subscribeKey = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.statuses.subscribeKey(workspaceId, listener);

    // If a component subscribes after initial load, kick an immediate update
    // so the UI doesn't wait. Uses microtask to batch multiple subscriptions.
    // Routes through RefreshController to respect in-flight guards.
    this.queueImmediateUpdate();

    return unsubscribe;
  };

  subscribeProjectStatusesKey = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.projectStatuses.subscribeKey(workspaceId, listener);
    this.queueImmediateUpdate();
    return unsubscribe;
  };

  /**
   * Get git status for a specific workspace.
   * Returns cached status or null if never fetched.
   */
  getStatus(workspaceId: string): GitStatus | null {
    // If workspace has never been checked, return null
    if (!this.statuses.has(workspaceId)) {
      return null;
    }

    // Return cached status (lazy computation)
    return this.statuses.get(workspaceId, () => {
      return this.statusCache.get(workspaceId) ?? null;
    });
  }

  getProjectStatuses(workspaceId: string): ProjectGitStatusResult[] | null {
    if (!this.projectStatuses.has(workspaceId)) {
      return null;
    }

    return this.projectStatuses.get(workspaceId, () => {
      return this.projectStatusCache.get(workspaceId) ?? null;
    });
  }

  getMultiProjectSummary(workspaceId: string): MultiProjectGitSummary | null {
    if (!this.projectStatuses.has(workspaceId)) {
      return null;
    }

    return this.multiProjectSummaryCache.get(workspaceId) ?? null;
  }

  /**
   * Invalidate status for a workspace, triggering immediate refresh.
   * Call after operations that change git state (e.g., branch switch).
   *
   * Note: Old status is preserved during refresh to avoid UI flash.
   * Components can use isWorkspaceRefreshing() to show a shimmer effect.
   */
  invalidateWorkspace(workspaceId: string): void {
    // Increment generation to mark any in-flight status checks as stale
    const currentGen = this.invalidationGeneration.get(workspaceId) ?? 0;
    this.invalidationGeneration.set(workspaceId, currentGen + 1);
    // Mark workspace as refreshing (for shimmer effect)
    this.setWorkspaceRefreshing(workspaceId, true);
    // Trigger immediate refresh (routes through RefreshController for in-flight guard)
    this.refreshController.requestImmediate();
  }

  clearWorkspace(workspaceId: string): void {
    const currentGen = this.invalidationGeneration.get(workspaceId) ?? 0;
    this.invalidationGeneration.set(workspaceId, currentGen + 1);
    this.statusCache.delete(workspaceId);
    this.statuses.delete(workspaceId);
    this.clearMultiProjectState(workspaceId);
    this.setWorkspaceRefreshing(workspaceId, false);
  }

  /**
   * Set the refreshing state for a workspace and notify subscribers.
   */
  private setWorkspaceRefreshing(workspaceId: string, refreshing: boolean): void {
    this.refreshingWorkspaces.bump(workspaceId);
    // Store the actual value in a simple map (MapStore is for notifications)
    this.refreshingWorkspacesCache.set(workspaceId, refreshing);
  }

  private refreshingWorkspacesCache = new Map<string, boolean>();
  private statusCache = new Map<string, GitStatus | null>();
  private projectStatusCache = new Map<string, ProjectGitStatusResult[] | null>();
  private multiProjectSummaryCache = new Map<string, MultiProjectGitSummary | null>();

  /**
   * Check if a workspace is currently refreshing.
   */
  isWorkspaceRefreshing(workspaceId: string): boolean {
    return this.refreshingWorkspacesCache.get(workspaceId) ?? false;
  }

  /**
   * Check if any git status fetch is currently in-flight.
   * Use this to ensure no background fetch can race with operations that change git state.
   */
  isAnyRefreshInFlight(): boolean {
    return this.refreshController.isRefreshing;
  }

  /**
   * Subscribe to refreshing state changes for a specific workspace.
   */
  subscribeRefreshingKey = (workspaceId: string, listener: () => void) => {
    return this.refreshingWorkspaces.subscribeKey(workspaceId, listener);
  };

  private hasWorkspaceSubscribers(workspaceId: string): boolean {
    return (
      this.statuses.hasKeySubscribers(workspaceId) ||
      this.projectStatuses.hasKeySubscribers(workspaceId)
    );
  }

  private clearMultiProjectState(workspaceId: string): void {
    this.projectStatusCache.delete(workspaceId);
    this.multiProjectSummaryCache.delete(workspaceId);
    this.projectStatuses.delete(workspaceId);
  }

  // Generation counter to detect and ignore stale status updates after invalidation.
  // Incremented on invalidate; status updates check generation to avoid race conditions.
  private invalidationGeneration = new Map<string, number>();

  private cleanupRuntimeRetryMap(
    retryUnsubscribers: Map<string, () => void>,
    metadata: ReadonlyMap<string, FrontendWorkspaceMetadata>
  ): void {
    for (const [id, unsub] of retryUnsubscribers) {
      if (!metadata.has(id)) {
        unsub();
        retryUnsubscribers.delete(id);
      }
    }
  }

  private registerRuntimeEligibilityRetry(
    retryUnsubscribers: Map<string, () => void>,
    metadata: FrontendWorkspaceMetadata,
    onEligible: () => void
  ): void {
    if (retryUnsubscribers.has(metadata.id)) {
      return;
    }

    retryUnsubscribers.set(
      metadata.id,
      onPassiveRuntimeEligible(metadata.id, metadata.runtimeConfig, this.runtimeStatusStore, () => {
        retryUnsubscribers.delete(metadata.id);
        onEligible();
      })
    );
  }

  /**
   * Sync workspaces with metadata.
   * Called when workspace list changes.
   */
  syncWorkspaces(metadata: Map<string, FrontendWorkspaceMetadata>): void {
    // Reactivate if disposed by React Strict Mode (dev only)
    // In dev, Strict Mode unmounts/remounts, disposing the store but reusing the ref
    if (!this.isActive && metadata.size > 0) {
      this.isActive = true;
    }

    this.workspaceMetadata = metadata;

    this.cleanupRuntimeRetryMap(this.runtimeStatusRetryUnsubscribers, metadata);
    this.cleanupRuntimeRetryMap(this.runtimeFetchRetryUnsubscribers, metadata);

    // Remove statuses for deleted workspaces
    // Iterate plain map (statusCache) for membership, not reactive store
    for (const id of Array.from(this.statusCache.keys())) {
      if (!metadata.has(id)) {
        this.statusCache.delete(id);
        this.invalidationGeneration.delete(id);
        this.statuses.delete(id); // Also clean up reactive state
        this.clearMultiProjectState(id);
      }
    }

    for (const [id, workspace] of metadata) {
      if (!isMultiProject(workspace)) {
        this.clearMultiProjectState(id);
      }
    }

    // Bind focus/visibility listeners once (catches external git changes)
    this.refreshController.bindListeners();

    // Initial fetch for all workspaces (routes through RefreshController)
    this.refreshController.requestImmediate();
  }

  /**
   * Update git status for all workspaces.
   */
  private async updateGitStatus(): Promise<void> {
    if (this.workspaceMetadata.size === 0 || !this.isActive) {
      return;
    }

    // Only poll workspaces that have active subscribers.
    const workspaces = Array.from(this.workspaceMetadata.values()).filter((ws) =>
      this.hasWorkspaceSubscribers(ws.id)
    );

    if (workspaces.length === 0) {
      return;
    }

    // Capture current generation for each workspace to detect stale results.
    const generationSnapshot = new Map<string, number>();
    for (const ws of workspaces) {
      generationSnapshot.set(ws.id, this.invalidationGeneration.get(ws.id) ?? 0);
    }

    // Try to fetch workspaces that need it (background, non-blocking)
    const workspacesMap = new Map(workspaces.map((ws) => [ws.id, ws]));
    this.tryFetchWorkspaces(workspacesMap);

    // Query git status for each workspace.
    // Rate limit: Process in batches to prevent bash process explosion.
    const results: Array<SingleWorkspaceStatusUpdate | MultiWorkspaceStatusUpdate> = [];

    for (let i = 0; i < workspaces.length; i += MAX_CONCURRENT_GIT_OPS) {
      if (!this.isActive) {
        break;
      }

      const batch = workspaces.slice(i, i + MAX_CONCURRENT_GIT_OPS);
      const batchPromises = batch.map((metadata) => {
        if (isMultiProject(metadata)) {
          return this.checkMultiProjectWorkspaceStatus(metadata);
        }
        return this.checkWorkspaceStatus(metadata);
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    if (!this.isActive) {
      return;
    }

    for (const result of results) {
      const workspaceId = result.workspaceId;

      // Skip stale results: if generation changed since we started, the result is outdated.
      const snapshotGen = generationSnapshot.get(workspaceId) ?? 0;
      const currentGen = this.invalidationGeneration.get(workspaceId) ?? 0;
      if (snapshotGen !== currentGen) {
        continue;
      }

      if (this.refreshingWorkspacesCache.get(workspaceId)) {
        this.setWorkspaceRefreshing(workspaceId, false);
      }

      if (result.kind === "multi") {
        const { legacyStatus, projectStatuses, summary } = result;
        if (legacyStatus === null || projectStatuses === null || summary === null) {
          continue;
        }

        const oldProjectStatuses = this.projectStatusCache.get(workspaceId) ?? null;
        const oldSummary = this.multiProjectSummaryCache.get(workspaceId) ?? null;
        const oldStatus = this.statusCache.get(workspaceId) ?? null;
        const projectStatusesChanged = !this.areProjectStatusResultsEqual(
          oldProjectStatuses,
          projectStatuses
        );
        const summaryChanged = !this.areMultiProjectSummariesEqual(oldSummary, summary);

        if (projectStatusesChanged || summaryChanged) {
          this.projectStatusCache.set(workspaceId, projectStatuses);
          this.multiProjectSummaryCache.set(workspaceId, summary);
          this.projectStatuses.bump(workspaceId);
        }

        if (!this.areStatusesEqual(oldStatus, legacyStatus)) {
          this.statusCache.set(workspaceId, legacyStatus);
          this.statuses.bump(workspaceId);
        }

        continue;
      }

      this.clearMultiProjectState(workspaceId);

      const oldStatus = this.statusCache.get(workspaceId) ?? null;
      if (!this.areStatusesEqual(oldStatus, result.status)) {
        // Only update cache on successful status check (preserve old status on failure).
        // This prevents UI flicker when git operations timeout or fail transiently.
        if (result.status !== null) {
          this.statusCache.set(workspaceId, result.status);
          this.statuses.bump(workspaceId);
        }
      }
    }
  }

  private getBaseRef(metadata: FrontendWorkspaceMetadata): string {
    const projectDefaultBase = readPersistedState<string>(
      STORAGE_KEYS.reviewDefaultBase(metadata.projectPath),
      WORKSPACE_DEFAULTS.reviewBase
    );
    return readPersistedState<string>(STORAGE_KEYS.reviewDiffBase(metadata.id), projectDefaultBase);
  }

  private buildMultiProjectSummary(results: ProjectGitStatusResult[]): MultiProjectGitSummary {
    return {
      totalProjectCount: results.length,
      divergedProjectCount: results.filter(
        (row) => row.gitStatus !== null && (row.gitStatus.ahead > 0 || row.gitStatus.behind > 0)
      ).length,
      dirtyProjectCount: results.filter((row) => row.gitStatus?.dirty === true).length,
      unknownProjectCount: results.filter((row) => row.gitStatus === null).length,
      projects: results,
    };
  }

  private buildLegacyMultiProjectStatus(
    metadata: FrontendWorkspaceMetadata,
    results: ProjectGitStatusResult[]
  ): GitStatus {
    const knownStatuses = results.flatMap((row) => (row.gitStatus ? [row.gitStatus] : []));

    // Multi-project workspaces still expose the primary project's branch string for
    // backcompat because existing branch consumers only understand one branch label.
    const primaryRow =
      results.find((row) => row.projectPath === metadata.projectPath && row.gitStatus !== null) ??
      results.find((row) => row.gitStatus !== null) ??
      null;

    return {
      branch: primaryRow?.gitStatus?.branch ?? "",
      ahead: sumGitStatusField(knownStatuses, (status) => status.ahead),
      behind: sumGitStatusField(knownStatuses, (status) => status.behind),
      dirty: knownStatuses.some((status) => status.dirty),
      outgoingAdditions: sumGitStatusField(knownStatuses, (status) => status.outgoingAdditions),
      outgoingDeletions: sumGitStatusField(knownStatuses, (status) => status.outgoingDeletions),
      incomingAdditions: sumGitStatusField(knownStatuses, (status) => status.incomingAdditions),
      incomingDeletions: sumGitStatusField(knownStatuses, (status) => status.incomingDeletions),
    };
  }

  /**
   * Compare two git statuses for equality.
   * Returns true if they're effectively the same.
   */
  private areStatusesEqual(a: GitStatus | null, b: GitStatus | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;

    return (
      a.branch === b.branch &&
      a.ahead === b.ahead &&
      a.behind === b.behind &&
      a.dirty === b.dirty &&
      a.outgoingAdditions === b.outgoingAdditions &&
      a.outgoingDeletions === b.outgoingDeletions &&
      a.incomingAdditions === b.incomingAdditions &&
      a.incomingDeletions === b.incomingDeletions
    );
  }

  private areProjectStatusResultsEqual(
    a: ProjectGitStatusResult[] | null,
    b: ProjectGitStatusResult[] | null
  ): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.length !== b.length) return false;

    return a.every((row, index) => {
      const other = b[index];
      return (
        row.projectPath === other.projectPath &&
        row.projectName === other.projectName &&
        (row.error ?? null) === (other.error ?? null) &&
        this.areStatusesEqual(row.gitStatus ?? null, other.gitStatus ?? null)
      );
    });
  }

  private areMultiProjectSummariesEqual(
    a: MultiProjectGitSummary | null,
    b: MultiProjectGitSummary | null
  ): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;

    return (
      a.totalProjectCount === b.totalProjectCount &&
      a.divergedProjectCount === b.divergedProjectCount &&
      a.dirtyProjectCount === b.dirtyProjectCount &&
      a.unknownProjectCount === b.unknownProjectCount &&
      this.areProjectStatusResultsEqual(a.projects, b.projects)
    );
  }

  /**
   * Check git status for a single workspace.
   */
  private async checkWorkspaceStatus(
    metadata: FrontendWorkspaceMetadata
  ): Promise<SingleWorkspaceStatusUpdate> {
    // Defensive: Return null if client is unavailable
    if (!this.client) {
      return { kind: "single", workspaceId: metadata.id, status: null };
    }

    // Passive git status is skipped for devcontainer workspaces whose runtime is
    // not already running, matching the same contract as passive fetch.
    if (
      !canRunPassiveRuntimeCommand(
        metadata.runtimeConfig,
        this.runtimeStatusStore.getStatus(metadata.id)
      )
    ) {
      // Arm a one-shot retry so status repopulates when the runtime starts.
      this.registerRuntimeEligibilityRetry(this.runtimeStatusRetryUnsubscribers, metadata, () => {
        this.refreshController.requestImmediate();
      });
      // Passive runtime gating means we have no fresh snapshot, not that the last known
      // git status became invalid. Preserve cached branch/status data until an explicit
      // user action or a running runtime produces a newer result.
      return {
        kind: "single",
        workspaceId: metadata.id,
        status: this.statusCache.get(metadata.id) ?? null,
      };
    }

    try {
      const baseRef = this.getBaseRef(metadata);

      // Generate script with the configured base ref
      const script = generateGitStatusScript(baseRef);

      const result = await this.client.workspace.executeBash({
        workspaceId: metadata.id,
        script,
        options: repoRootBashOptions(5),
      });

      if (!result.success) {
        console.debug(`[gitStatus] IPC failed for ${metadata.id}:`, result.error);
        return { kind: "single", workspaceId: metadata.id, status: null };
      }

      if (!result.data.success) {
        // Don't log output overflow errors at all (common in large repos, handled gracefully)
        if (
          !result.data.error?.includes("OUTPUT TRUNCATED") &&
          !result.data.error?.includes("OUTPUT OVERFLOW")
        ) {
          console.debug(`[gitStatus] Script failed for ${metadata.id}:`, result.data.error);
        }
        return { kind: "single", workspaceId: metadata.id, status: null };
      }

      if (result.data.note?.includes("OUTPUT OVERFLOW")) {
        return { kind: "single", workspaceId: metadata.id, status: null };
      }

      // Parse the output using centralized function
      const parsed = parseGitStatusScriptOutput(result.data.output);

      if (!parsed) {
        console.debug(`[gitStatus] Could not parse output for ${metadata.id}`);
        return { kind: "single", workspaceId: metadata.id, status: null };
      }

      const {
        headBranch,
        ahead,
        behind,
        dirtyCount,
        outgoingAdditions,
        outgoingDeletions,
        incomingAdditions,
        incomingDeletions,
      } = parsed;
      const dirty = dirtyCount > 0;

      return {
        kind: "single",
        workspaceId: metadata.id,
        status: {
          branch: headBranch,
          ahead,
          behind,
          dirty,
          outgoingAdditions,
          outgoingDeletions,
          incomingAdditions,
          incomingDeletions,
        },
      };
    } catch (err) {
      // Silently fail - git status failures shouldn't crash the UI
      console.debug(`[gitStatus] Exception for ${metadata.id}:`, err);
      return { kind: "single", workspaceId: metadata.id, status: null };
    }
  }

  private async checkMultiProjectWorkspaceStatus(
    metadata: FrontendWorkspaceMetadata
  ): Promise<MultiWorkspaceStatusUpdate> {
    assert(
      isMultiProject(metadata),
      "Multi-project refresh requires multi-project workspace metadata"
    );

    if (!this.client) {
      return {
        kind: "multi",
        workspaceId: metadata.id,
        legacyStatus: null,
        projectStatuses: null,
        summary: null,
      };
    }

    if (
      !canRunPassiveRuntimeCommand(
        metadata.runtimeConfig,
        this.runtimeStatusStore.getStatus(metadata.id)
      )
    ) {
      // Multi-project git status goes through the runtime-backed backend path,
      // so passive refreshes must not wake stopped runtimes.
      return {
        kind: "multi",
        workspaceId: metadata.id,
        legacyStatus: null,
        projectStatuses: null,
        summary: null,
      };
    }

    try {
      const baseRef = this.getBaseRef(metadata);
      const results: ApiProjectGitStatusResult[] =
        await this.client.workspace.getProjectGitStatuses({
          workspaceId: metadata.id,
          baseRef,
        });
      assert(results.length > 0, `Expected project git statuses for workspace ${metadata.id}`);

      const normalizedResults = results.map((row) => {
        assert(row.projectPath.trim().length > 0, "Project git status rows require a projectPath");
        assert(row.projectName.trim().length > 0, "Project git status rows require a projectName");
        return {
          projectPath: row.projectPath,
          projectName: row.projectName,
          gitStatus: row.gitStatus ?? null,
          error: row.error ?? null,
        } satisfies ProjectGitStatusResult;
      });

      const expectedProjects = getProjects(metadata);
      assert(
        normalizedResults.length === expectedProjects.length,
        `Expected ${expectedProjects.length} project git status rows for workspace ${metadata.id}`
      );

      return {
        kind: "multi",
        workspaceId: metadata.id,
        legacyStatus: this.buildLegacyMultiProjectStatus(metadata, normalizedResults),
        projectStatuses: normalizedResults,
        summary: this.buildMultiProjectSummary(normalizedResults),
      };
    } catch (err) {
      console.debug(`[gitStatus] Multi-project exception for ${metadata.id}:`, err);
      return {
        kind: "multi",
        workspaceId: metadata.id,
        legacyStatus: null,
        projectStatuses: null,
        summary: null,
      };
    }
  }

  /**
   * Get a unique fetch key for a workspace.
   * For local workspaces: project name (shared git repo)
   * For SSH workspaces: workspace ID (each has its own git repo)
   */
  private getFetchKey(metadata: FrontendWorkspaceMetadata): string {
    const isSSH = isSSHRuntime(metadata.runtimeConfig);
    return isSSH ? metadata.id : metadata.projectName;
  }

  private getSecondaryRepoProjectPathsForFetchKey(
    fetchKey: string,
    workspaces: ReadonlyMap<string, FrontendWorkspaceMetadata>
  ): ReadonlyMap<string, string> {
    const secondaryRepoProjectPaths = new Map<string, string>();

    for (const metadata of workspaces.values()) {
      if (this.getFetchKey(metadata) !== fetchKey || !isMultiProject(metadata)) {
        continue;
      }

      for (const project of getProjects(metadata)) {
        assert(
          project.projectPath.trim().length > 0,
          "Secondary repo fetch requires a projectPath"
        );
        if (project.projectPath === metadata.projectPath) {
          continue;
        }

        const existingWorkspaceId = secondaryRepoProjectPaths.get(project.projectPath);
        if (existingWorkspaceId != null) {
          // Workspaces that share a fetch key can also share the same secondary repo.
          // Prefer an owner whose runtime can passively run git commands so a stopped
          // workspace does not suppress fetches that another workspace could perform.
          const existingMetadata = workspaces.get(existingWorkspaceId);
          assert(
            existingMetadata != null,
            `Secondary repo fetch owner ${existingWorkspaceId} must still exist in the workspace map`
          );
          const existingWorkspaceCanFetch = canRunPassiveRuntimeCommand(
            existingMetadata.runtimeConfig,
            this.runtimeStatusStore.getStatus(existingWorkspaceId)
          );
          const nextWorkspaceCanFetch = canRunPassiveRuntimeCommand(
            metadata.runtimeConfig,
            this.runtimeStatusStore.getStatus(metadata.id)
          );
          if (!existingWorkspaceCanFetch && nextWorkspaceCanFetch) {
            secondaryRepoProjectPaths.set(project.projectPath, metadata.id);
          }
          continue;
        }
        secondaryRepoProjectPaths.set(project.projectPath, metadata.id);
      }
    }

    return secondaryRepoProjectPaths;
  }

  /**
   * Try to fetch workspaces that need it most urgently.
   * For SSH workspaces: each workspace has its own repo, so fetch each one.
   * For local workspaces: workspaces share a repo, so fetch once per project.
   */
  private tryFetchWorkspaces(workspaces: Map<string, FrontendWorkspaceMetadata>): void {
    const representativeWorkspaces = new Map<
      string,
      {
        metadata: FrontendWorkspaceMetadata;
        secondaryRepoProjectPathsByWorkspaceId: ReadonlyMap<string, string>;
      }
    >();

    // Passive fetches are skipped for devcontainer workspaces whose runtime is not
    // already running. Stale ahead/behind metadata while stopped is intentional to
    // preserve lazy-start.
    for (const metadata of workspaces.values()) {
      const fetchKey = this.getFetchKey(metadata);
      if (representativeWorkspaces.has(fetchKey) || !this.shouldFetch(fetchKey)) {
        continue;
      }
      if (
        !canRunPassiveRuntimeCommand(
          metadata.runtimeConfig,
          this.runtimeStatusStore.getStatus(metadata.id)
        )
      ) {
        // Arm a one-shot retry so the workspace gets a fetch
        // once the runtime becomes passively runnable.
        this.registerRuntimeEligibilityRetry(this.runtimeFetchRetryUnsubscribers, metadata, () => {
          // Clear fetch backoff so the retry isn't suppressed.
          const retryMetadata = this.workspaceMetadata.get(metadata.id);
          if (retryMetadata) {
            this.fetchCache.delete(this.getFetchKey(retryMetadata));
          }
          this.refreshController.requestImmediate();
        });
        continue;
      }

      representativeWorkspaces.set(fetchKey, {
        metadata,
        secondaryRepoProjectPathsByWorkspaceId: this.getSecondaryRepoProjectPathsForFetchKey(
          fetchKey,
          workspaces
        ),
      });
    }

    // Find the workspace that needs fetching most urgently
    let targetFetchKey: string | null = null;
    let targetWorkspaceId: string | null = null;
    let targetSecondaryRepoProjectPathsByWorkspaceId: ReadonlyMap<string, string> = new Map();
    let oldestTime = Date.now();

    for (const [fetchKey, representative] of representativeWorkspaces) {
      const cache = this.fetchCache.get(fetchKey);
      const lastFetch = cache?.lastFetch ?? 0;

      if (lastFetch < oldestTime) {
        oldestTime = lastFetch;
        targetFetchKey = fetchKey;
        targetWorkspaceId = representative.metadata.id;
        targetSecondaryRepoProjectPathsByWorkspaceId =
          representative.secondaryRepoProjectPathsByWorkspaceId;
      }
    }

    if (targetFetchKey && targetWorkspaceId) {
      // Fetch in background (don't await - don't block status checks)
      void this.fetchWorkspace(
        targetFetchKey,
        targetWorkspaceId,
        targetSecondaryRepoProjectPathsByWorkspaceId
      );
    }
  }

  /**
   * Check if a workspace/project should be fetched.
   */
  private shouldFetch(fetchKey: string): boolean {
    const cached = this.fetchCache.get(fetchKey);
    if (!cached) return true;
    if (cached.inProgress) return false;

    // Calculate delay with exponential backoff: 3s, 6s, 12s, 24s, 48s, 60s (max)
    const delay = Math.min(
      FETCH_BASE_INTERVAL_MS * Math.pow(2, cached.consecutiveFailures),
      FETCH_MAX_INTERVAL_MS
    );
    return Date.now() - cached.lastFetch > delay;
  }

  private async executeWorkspaceFetch(
    workspaceId: string,
    repoRootProjectPath?: string | null
  ): Promise<void> {
    assert(this.client, "Git fetch requires an initialized client");

    const result = await this.client.workspace.executeBash({
      workspaceId,
      script: GIT_FETCH_SCRIPT,
      // Passive fetches use the runtime path because git fetch / git ls-remote
      // may need remote credentials that only exist inside the runtime. These
      // background fetches are only scheduled when that runtime is already running.
      options: repoRootBashOptions(FETCH_TIMEOUT_SECS, repoRootProjectPath),
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    if (!result.data.success) {
      throw new Error(result.data.error || "Unknown error");
    }
  }

  private async fetchSecondaryWorkspaceRepos(
    fetchKey: string,
    projectPathsByWorkspaceId: ReadonlyMap<string, string>
  ): Promise<void> {
    if (!this.client || !this.isActive) {
      return;
    }

    for (const [projectPath, workspaceId] of projectPathsByWorkspaceId) {
      const metadata = this.workspaceMetadata.get(workspaceId);
      if (!this.client || !this.isActive) {
        return;
      }
      if (!metadata) {
        console.debug(
          `[fetch] Skipping secondary repo fetch for ${fetchKey} (${projectPath}): workspace ${workspaceId} is no longer tracked`
        );
        continue;
      }
      if (
        !canRunPassiveRuntimeCommand(
          metadata.runtimeConfig,
          this.runtimeStatusStore.getStatus(workspaceId)
        )
      ) {
        // Secondary repo fetches also run in the runtime context, so re-check passive
        // eligibility before each repo in case the owning runtime stopped after the
        // primary fetch or another workspace on the same fetch key scheduled this repo.
        console.debug(
          `[fetch] Skipping secondary repo fetch for ${fetchKey} (${projectPath}): workspace ${workspaceId} is no longer eligible`
        );
        continue;
      }

      assert(projectPath.trim().length > 0, "Secondary repo fetch requires a projectPath");
      assert(workspaceId.trim().length > 0, "Secondary repo fetch requires a workspaceId");
      try {
        await this.executeWorkspaceFetch(workspaceId, projectPath);
      } catch (secondaryError) {
        // Secondary fetches are best-effort so a single stale repo does not back off
        // the entire workspace's primary background refresh loop.
        console.debug(
          `[fetch] Secondary repo fetch failed for ${fetchKey} (${projectPath}) via ${workspaceId}:`,
          secondaryError
        );
      }
    }
  }

  /**
   * Fetch updates for a workspace.
   * For local workspaces: fetches the shared primary repo and any secondary repo roots
   * in multi-project workspaces.
   * For SSH workspaces: fetches the workspace's individual repo.
   */
  private async fetchWorkspace(
    fetchKey: string,
    workspaceId: string,
    secondaryRepoProjectPathsByWorkspaceId: ReadonlyMap<string, string> = new Map()
  ): Promise<void> {
    // Defensive: Return early if client is unavailable
    if (!this.client || !this.workspaceMetadata.has(workspaceId)) {
      return;
    }

    const cache = this.fetchCache.get(fetchKey) ?? {
      lastFetch: 0,
      inProgress: false,
      consecutiveFailures: 0,
    };

    if (cache.inProgress) return;

    // Mark as in progress
    this.fetchCache.set(fetchKey, { ...cache, inProgress: true });

    try {
      await this.executeWorkspaceFetch(workspaceId);

      if (secondaryRepoProjectPathsByWorkspaceId.size > 0) {
        // Keep passive refreshes non-blocking for the current status check while still
        // refreshing every repo root covered by workspaces that share this fetch key.
        setTimeout(() => {
          this.fetchSecondaryWorkspaceRepos(fetchKey, secondaryRepoProjectPathsByWorkspaceId).catch(
            (secondaryError) => {
              console.debug(
                `[fetch] Secondary repo refresh loop failed for ${fetchKey}:`,
                secondaryError
              );
            }
          );
        }, 0);
      }

      // Success - reset failure counter
      console.debug(`[fetch] Success for ${fetchKey}`);
      this.fetchCache.set(fetchKey, {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });
    } catch (error) {
      // All errors logged to console, never shown to user
      console.debug(`[fetch] Failed for ${fetchKey}:`, error);

      const newFailures = cache.consecutiveFailures + 1;
      const nextDelay = Math.min(
        FETCH_BASE_INTERVAL_MS * Math.pow(2, newFailures),
        FETCH_MAX_INTERVAL_MS
      );

      console.debug(
        `[fetch] Will retry ${fetchKey} after ${Math.round(nextDelay / 1000)}s ` +
          `(failure #${newFailures})`
      );

      this.fetchCache.set(fetchKey, {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: newFailures,
      });
    }
  }

  /**
   * Cleanup resources.
   */
  dispose(): void {
    this.isActive = false;
    this.statuses.clear();
    this.projectStatuses.clear();
    this.refreshingWorkspaces.clear();
    this.refreshingWorkspacesCache.clear();
    this.statusCache.clear();
    this.projectStatusCache.clear();
    this.multiProjectSummaryCache.clear();
    this.invalidationGeneration.clear();
    this.fetchCache.clear();
    this.fileModifyUnsubscribe?.();
    this.fileModifyUnsubscribe = null;
    for (const unsub of this.runtimeStatusRetryUnsubscribers.values()) {
      unsub();
    }
    this.runtimeStatusRetryUnsubscribers.clear();
    for (const unsub of this.runtimeFetchRetryUnsubscribers.values()) {
      unsub();
    }
    this.runtimeFetchRetryUnsubscribers.clear();
    this.refreshController.dispose();
  }

  /**
   * Subscribe to file-modifying tool completions from WorkspaceStore.
   * Triggers debounced git status refresh when files change.
   * Idempotent: only subscribes once, subsequent calls are no-ops.
   */
  subscribeToFileModifications(
    subscribeAny: (listener: (workspaceId: string) => void) => () => void
  ): void {
    // Only subscribe once - subsequent calls are no-ops
    if (this.fileModifyUnsubscribe) {
      return;
    }

    this.fileModifyUnsubscribe = subscribeAny((workspaceId) => {
      // Only schedule if workspace has subscribers (same optimization as before)
      if (!this.hasWorkspaceSubscribers(workspaceId)) {
        return;
      }

      // RefreshController handles debouncing, focus gating, and in-flight guards
      this.refreshController.schedule();
    });
  }
}

// ============================================================================
// React Integration with useSyncExternalStore
// ============================================================================

// Singleton store instance
let gitStoreInstance: GitStatusStore | null = null;

/**
 * Get or create the singleton GitStatusStore instance.
 */
function getGitStoreInstance(): GitStatusStore {
  gitStoreInstance ??= new GitStatusStore();
  return gitStoreInstance;
}

/**
 * Hook to get git status for a specific workspace.
 * Only re-renders when THIS workspace's status changes.
 *
 * Uses per-key subscription for surgical updates - only notified when
 * this specific workspace's git status changes.
 */
export function useGitStatus(workspaceId: string): GitStatus | null {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getStatus(workspaceId)
  );
}

export function useProjectGitStatuses(workspaceId: string): ProjectGitStatusResult[] | null {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeProjectStatusesKey(workspaceId, listener),
    () => store.getProjectStatuses(workspaceId)
  );
}

export function useMultiProjectGitSummary(workspaceId: string): MultiProjectGitSummary | null {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeProjectStatusesKey(workspaceId, listener),
    () => store.getMultiProjectSummary(workspaceId)
  );
}

/**
 * Hook to check if a workspace's git status is currently being refreshed.
 * Use this to show shimmer/loading effects while preserving old status.
 */
export function useGitStatusRefreshing(workspaceId: string): boolean {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeRefreshingKey(workspaceId, listener),
    () => store.isWorkspaceRefreshing(workspaceId)
  );
}

/**
 * Hook to access the raw store for imperative operations.
 */
export function useGitStatusStoreRaw(): GitStatusStore {
  return getGitStoreInstance();
}

/**
 * Invalidate git status for a workspace, triggering an immediate refresh.
 * Call this after operations that change git state (e.g., branch switch).
 */
export function invalidateGitStatus(workspaceId: string): void {
  const store = getGitStoreInstance();
  store.invalidateWorkspace(workspaceId);
}

export function clearGitStatus(workspaceId: string): void {
  const store = getGitStoreInstance();
  store.clearWorkspace(workspaceId);
}
