/**
 * ReviewPanel - Main code review interface
 * Displays diff hunks for viewing changes in the workspace
 *
 * FILTERING ARCHITECTURE:
 *
 * Two-tier pipeline:
 *
 * 1. Git-level filters (affect data fetching):
 *    - diffBase: target branch/commit to diff against
 *    - includeUncommitted: include working directory changes
 *    - selectedFilePath: CRITICAL for truncation handling - when full diff
 *      exceeds bash output limits, path filter retrieves specific files
 *
 * 2. Frontend filters (applied in-memory to loaded hunks):
 *    - showReadHunks: hide hunks marked as reviewed
 *    - searchTerm: substring match on filenames + hunk content
 *
 * Why hybrid? Performance and necessity:
 * - selectedFilePath MUST be git-level (truncation recovery)
 * - search/read filters are better frontend (more flexible, simpler UX)
 * - Frontend filtering is fast even for 1000+ hunks (<5ms)
 */

import { LRUCache } from "lru-cache";
import { AlertTriangle, Lightbulb, Loader2, Sparkles } from "lucide-react";
import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  buildAssistedReviewPathCandidates,
  findAssistedCandidateMatch,
  normalizeAssistedReviewHunks,
  resolveAssistedReviewPathCandidatesForHunks,
  type ProjectRelativePathContext,
} from "@/common/utils/review/assistedReview";
import { createPortal } from "react-dom";
import { HunkViewer } from "./HunkViewer";
import { InlineReviewNote, type ReviewActionCallbacks } from "../../Shared/InlineReviewNote";
import { ReviewControls } from "./ReviewControls";
import { preloadHighlightedDiff } from "../../Shared/DiffRenderer";
import { ImmersiveReviewView } from "./ImmersiveReviewView";
import { FileTree } from "./FileTree";
import { UntrackedStatus } from "./UntrackedStatus";
import { shellQuote } from "@/common/utils/shell";
import {
  normalizeRepoRootFilePath,
  reprojectRepoRootFilePath,
  repoRootBashOptions,
  resolveRepoRootProjectPath,
} from "@/browser/utils/executeBash";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useReviewState } from "@/browser/hooks/useReviewState";
import { useReviews } from "@/browser/hooks/useReviews";
import { useHunkFirstSeen } from "@/browser/hooks/useHunkFirstSeen";
import {
  RefreshController,
  type LastRefreshInfo,
  type RefreshFailureInfo,
} from "@/browser/utils/RefreshController";
import { parseDiff, extractAllHunks, buildGitDiffCommand } from "@/common/utils/git/diffParser";
import {
  getReviewImmersiveKey,
  getReviewDefaultBaseKey,
  getReviewSelectedHunkKey,
  getReviewSearchStateKey,
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  REVIEW_SORT_ORDER_KEY,
} from "@/common/constants/storage";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { parseNumstat, buildFileTree, extractNewPath } from "@/common/utils/git/numstatParser";
import { parseNameStatus } from "@/common/utils/git/nameStatusParser";
import { isPlanFilePath } from "@/common/types/review";
import type {
  AssistedReviewHunk,
  DiffHunk,
  ReviewFilters as ReviewFiltersType,
  ReviewNoteData,
  ReviewSortOrder,
} from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  matchesKeybind,
  KEYBINDS,
  formatKeybind,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import { applyFrontendFilters } from "@/browser/utils/review/filterHunks";
import { findNextHunkId, findNextHunkIdAfterFileRemoval } from "@/browser/utils/review/navigation";
import { cn } from "@/common/lib/utils";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { workspaceStore, useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { invalidateGitStatus } from "@/browser/stores/GitStatusStore";
import { getErrorMessage } from "@/common/utils/errors";

/** Stats reported to parent for tab display */
interface ReviewPanelStats {
  total: number;
  read: number;
  /** Agent-flagged hunks in the current diff that the user hasn't read yet. */
  unreadAssisted: number;
}

interface FileReadStatusSummary {
  total: number;
  read: number;
}

interface ReviewPanelProps {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Trigger to focus panel (increment to trigger) */
  focusTrigger?: number;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
  /** Callback to report stats changes (for tab badge) */
  onStatsChange?: (stats: ReviewPanelStats) => void;
  /** Whether immersive review should use touch/mobile UX affordances. */
  isTouchImmersive?: boolean;
  /** Allow parent to switch touch/mobile immersive affordances before entering immersive UI. */
  onTouchImmersiveChange?: (isTouch: boolean) => void;
}

interface ReviewSearchState {
  input: string;
  useRegex: boolean;
  matchCase: boolean;
}

interface DiagnosticInfo {
  command: string;
  outputLength: number;
  fileDiffCount: number;
  hunkCount: number;
}

/**
 * Discriminated union for diff loading state.
 * Makes it impossible to show "No changes" while loading.
 *
 * Note: Parent uses key={workspaceId} so component remounts on workspace change,
 * guaranteeing fresh state. No need to track workspaceId in state.
 */
type DiffState =
  | { status: "loading" }
  | { status: "refreshing"; hunks: DiffHunk[]; truncationWarning: string | null }
  | { status: "loaded"; hunks: DiffHunk[]; truncationWarning: string | null }
  | { status: "error"; message: string };

const LARGE_REVIEW_COLLAPSE_HUNK_THRESHOLD = 200;
const LARGE_REVIEW_COLLAPSE_OUTPUT_BYTES = 250_000;

const REVIEW_PANEL_CACHE_MAX_ENTRIES = 20;
const REVIEW_PANEL_CACHE_MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Preserve object references for unchanged hunks to prevent re-renders.
 * Compares by ID and content - if a hunk exists in prev with same content, reuse it.
 */
function preserveHunkReferences(prev: DiffHunk[], next: DiffHunk[]): DiffHunk[] {
  if (prev.length === 0) return next;

  const prevById = new Map(prev.map((h) => [h.id, h]));
  let allSame = prev.length === next.length;

  const result = next.map((hunk, i) => {
    const prevHunk = prevById.get(hunk.id);
    // Fast path: same ID and content means unchanged (content hash is part of ID)
    if (prevHunk?.content === hunk.content) {
      if (allSame && prev[i]?.id !== hunk.id) allSame = false;
      return prevHunk;
    }
    allSame = false;
    return hunk;
  });

  // If all hunks are reused in same order, return prev array to preserve top-level reference
  return allSame ? prev : result;
}

interface ReviewPanelDiffCacheValue {
  hunks: DiffHunk[];
  truncationWarning: string | null;
  diagnosticInfo: DiagnosticInfo | null;
}

type ReviewPanelCacheValue = ReviewPanelDiffCacheValue | FileTreeNode;

function estimateJsonSizeBytes(value: unknown): number {
  // Rough bytes for JS strings (UTF-16). Used only for LRU sizing.
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    // If we ever hit an unserializable structure, treat it as huge so it won't stick in cache.
    return Number.MAX_SAFE_INTEGER;
  }
}

const reviewPanelCache = new LRUCache<string, ReviewPanelCacheValue>({
  max: REVIEW_PANEL_CACHE_MAX_ENTRIES,
  maxSize: REVIEW_PANEL_CACHE_MAX_SIZE_BYTES,
  sizeCalculation: (value) => estimateJsonSizeBytes(value),
});

function getOriginBranchForFetch(diffBase: string): string | null {
  const trimmed = diffBase.trim();
  if (!trimmed.startsWith("origin/")) return null;

  const branch = trimmed.slice("origin/".length);
  if (branch.length === 0) return null;

  return branch;
}

function toOriginDiffBase(trunkBranch: string | null | undefined): string | null {
  if (typeof trunkBranch !== "string") {
    return null;
  }

  const trimmed = trunkBranch.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("origin/")) {
    return trimmed;
  }

  const refsHeadsPrefix = "refs/heads/";
  const branchName = trimmed.startsWith(refsHeadsPrefix)
    ? trimmed.slice(refsHeadsPrefix.length)
    : trimmed;

  if (branchName.length === 0) {
    return null;
  }

  return `origin/${branchName}`;
}

function toMetadataDiffBase(trunkBranch: string | null | undefined): string | null {
  if (typeof trunkBranch !== "string") {
    return null;
  }

  const trimmed = trunkBranch.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const refsHeadsPrefix = "refs/heads/";
  if (trimmed.startsWith(refsHeadsPrefix)) {
    const branchName = trimmed.slice(refsHeadsPrefix.length);
    return branchName.length > 0 ? branchName : null;
  }

  return trimmed;
}

interface OriginFetchState {
  key: string;
  promise: Promise<void>;
}

async function ensureOriginFetched(params: {
  api: APIClient;
  workspaceId: string;
  diffBase: string;
  refreshToken: number;
  originFetchRef: React.MutableRefObject<OriginFetchState | null>;
  repoRootProjectPath?: string | null;
}): Promise<void> {
  const originBranch = getOriginBranchForFetch(params.diffBase);
  if (!originBranch) return;

  const key = [
    params.workspaceId,
    params.diffBase,
    params.repoRootProjectPath ?? "",
    String(params.refreshToken),
  ].join("\u0000");
  const existing = params.originFetchRef.current;
  if (existing?.key === key) {
    await existing.promise;
    return;
  }

  // Ensure manual refresh doesn't hang on credential prompts.
  // When a selected-file diff targets a secondary project, fetch in that repo instead of always
  // defaulting repo-root execution back to the primary checkout.
  const promise = params.api.workspace
    .executeBash({
      workspaceId: params.workspaceId,
      script: `GIT_TERMINAL_PROMPT=0 git fetch origin ${shellQuote(originBranch)} --quiet || true`,
      options: repoRootBashOptions(30, params.repoRootProjectPath),
    })
    .then(() => undefined)
    .catch(() => undefined);

  params.originFetchRef.current = { key, promise };
  await promise;
}
function makeReviewPanelCacheKey(params: {
  workspaceId: string;
  workspacePath: string;
  gitCommand: string;
  repoRootProjectPath?: string | null;
}): string {
  // Key off the actual git command plus repo-root target so multi-project selected-file diffs do
  // not reuse cache entries from a different project checkout that happened to run the same command.
  return [
    params.workspaceId,
    params.workspacePath,
    params.repoRootProjectPath ?? "",
    params.gitCommand,
  ].join("\u0000");
}

type ExecuteBashResult = Awaited<ReturnType<APIClient["workspace"]["executeBash"]>>;
type ExecuteBashSuccess = Extract<ExecuteBashResult, { success: true }>;

async function executeWorkspaceBashAndCache<T extends ReviewPanelCacheValue>(params: {
  api: APIClient;
  workspaceId: string;
  script: string;
  cacheKey: string;
  timeoutSecs: number;
  repoRootProjectPath?: string | null;
  parse: (result: ExecuteBashSuccess) => T;
}): Promise<T> {
  const result = await params.api.workspace.executeBash({
    workspaceId: params.workspaceId,
    script: params.script,
    options: repoRootBashOptions(params.timeoutSecs, params.repoRootProjectPath),
  });

  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }

  if (!result.data.success) {
    throw new Error(result.data.output ?? result.data.error ?? "Command failed");
  }

  const value = params.parse(result);
  reviewPanelCache.set(params.cacheKey, value);
  return value;
}

function parseReviewDiffCacheValue(params: {
  result: ExecuteBashSuccess;
  workspaceMetadata: ReturnType<typeof useWorkspaceMetadata>["workspaceMetadata"];
  workspaceId: string;
  repoRootProjectPath?: string | null;
  diffCommand: string;
  selectedFilePath?: string | null;
  isImmersive: boolean;
}): ReviewPanelDiffCacheValue {
  const diffOutput = params.result.data.output ?? "";
  const truncationInfo =
    "truncated" in params.result.data ? params.result.data.truncated : undefined;

  // Git diff always reports repo-relative paths from the checkout we executed in.
  // Reproject them onto the shared container root so immersive/plain file reads can
  // open the same files without having to know which project supplied the diff.
  const fileDiffs = parseDiff(diffOutput).map((fileDiff) => ({
    ...fileDiff,
    filePath: reprojectRepoRootFilePath(
      params.workspaceMetadata.get(params.workspaceId),
      fileDiff.filePath,
      params.repoRootProjectPath
    ),
    oldPath: fileDiff.oldPath
      ? reprojectRepoRootFilePath(
          params.workspaceMetadata.get(params.workspaceId),
          fileDiff.oldPath,
          params.repoRootProjectPath
        )
      : undefined,
    hunks: fileDiff.hunks.map((hunk) => ({
      ...hunk,
      filePath: reprojectRepoRootFilePath(
        params.workspaceMetadata.get(params.workspaceId),
        hunk.filePath,
        params.repoRootProjectPath
      ),
      oldPath: hunk.oldPath
        ? reprojectRepoRootFilePath(
            params.workspaceMetadata.get(params.workspaceId),
            hunk.oldPath,
            params.repoRootProjectPath
          )
        : undefined,
    })),
  }));
  const allHunks = extractAllHunks(fileDiffs);

  const diagnosticInfo: DiagnosticInfo = {
    command: params.diffCommand,
    outputLength: diffOutput.length,
    fileDiffCount: fileDiffs.length,
    hunkCount: allHunks.length,
  };

  const truncationWarning =
    truncationInfo && (!params.selectedFilePath || params.isImmersive)
      ? `Diff truncated (${truncationInfo.reason}). Filter by file to see more.`
      : null;

  return { hunks: allHunks, truncationWarning, diagnosticInfo };
}

function mergeReviewDiffCacheValues(
  values: readonly ReviewPanelDiffCacheValue[]
): ReviewPanelDiffCacheValue {
  const hunks = values.flatMap((value) => value.hunks);
  const truncationWarnings = values.flatMap((value) =>
    value.truncationWarning ? [value.truncationWarning] : []
  );
  const diagnostics = values.flatMap((value) =>
    value.diagnosticInfo ? [value.diagnosticInfo] : []
  );

  return {
    hunks,
    truncationWarning: truncationWarnings.length > 0 ? truncationWarnings.join("\n") : null,
    diagnosticInfo:
      diagnostics.length > 0
        ? {
            command: diagnostics.map((info) => info.command).join("\n\n"),
            outputLength: diagnostics.reduce((sum, info) => sum + info.outputLength, 0),
            fileDiffCount: diagnostics.reduce((sum, info) => sum + info.fileDiffCount, 0),
            hunkCount: diagnostics.reduce((sum, info) => sum + info.hunkCount, 0),
          }
        : null,
  };
}

export function countUnreadAssistedHunks(
  hunks: readonly DiffHunk[],
  assistedHunks: readonly AssistedReviewHunk[],
  isRead: (hunkId: string) => boolean,
  pathContext?: ProjectRelativePathContext
): number {
  if (assistedHunks.length === 0) return 0;
  const candidates = resolveAssistedReviewPathCandidatesForHunks(assistedHunks, hunks, pathContext);
  let count = 0;
  for (const hunk of hunks) {
    if (findAssistedCandidateMatch(hunk, candidates) && !isRead(hunk.id)) {
      count += 1;
    }
  }
  return count;
}

interface ReviewDiffPathFilterSpec {
  repoRootProjectPath: string | null | undefined;
  pathFilter: string;
  /** Truthy when this request is path-filtered enough to suppress full-diff truncation messaging. */
  selectedFilePath: string | null;
}

function toPathFilter(pathspecs: readonly string[]): string {
  const uniquePathspecs = Array.from(new Set(pathspecs.filter((pathspec) => pathspec.length > 0)));
  return uniquePathspecs.length > 0
    ? ` -- ${uniquePathspecs.map((pathspec) => shellQuote(pathspec)).join(" ")}`
    : "";
}

export function buildReviewDiffPathFilterSpecs(params: {
  isImmersive: boolean;
  assistedOnly: boolean;
  assistedHunks: readonly AssistedReviewHunk[];
  selectedFilePath: string | null;
  selectedDiffPath: string;
  selectedRepoRootProjectPath?: string | null;
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined;
  projectPath: string;
  pathContext?: ProjectRelativePathContext;
}): ReviewDiffPathFilterSpec[] {
  if (!params.assistedOnly) {
    return [
      {
        repoRootProjectPath:
          params.selectedFilePath && !params.isImmersive
            ? (params.selectedRepoRootProjectPath ?? params.projectPath)
            : params.projectPath,
        pathFilter:
          params.selectedFilePath && !params.isImmersive
            ? toPathFilter([params.selectedDiffPath])
            : "",
        selectedFilePath:
          params.selectedFilePath && !params.isImmersive ? params.selectedFilePath : null,
      },
    ];
  }

  const pathspecsByRepoRoot = new Map<
    string,
    { repoRootProjectPath: string | null | undefined; pathspecs: string[] }
  >();

  for (const candidate of buildAssistedReviewPathCandidates(
    params.assistedHunks,
    params.pathContext
  )) {
    // In multi-project workspaces, assisted pins use workspace-relative paths
    // like `project-b/src/file.ts`. Fetch each repo-root group from the owning
    // checkout so an accepted pin cannot disappear just because the Review pane
    // was currently rooted to another project.
    const repoRootProjectPath =
      resolveRepoRootProjectPath(params.workspaceMetadata, candidate.path) ?? params.projectPath;
    const key = repoRootProjectPath ?? "";
    const pathspec = normalizeRepoRootFilePath(
      params.workspaceMetadata,
      candidate.path,
      repoRootProjectPath
    );
    const existing = pathspecsByRepoRoot.get(key);
    if (existing) {
      existing.pathspecs.push(pathspec);
    } else {
      pathspecsByRepoRoot.set(key, { repoRootProjectPath, pathspecs: [pathspec] });
    }
  }

  if (pathspecsByRepoRoot.size === 0) {
    return [{ repoRootProjectPath: params.projectPath, pathFilter: "", selectedFilePath: null }];
  }

  return Array.from(pathspecsByRepoRoot.values()).map((spec) => ({
    repoRootProjectPath: spec.repoRootProjectPath,
    pathFilter: toPathFilter(spec.pathspecs),
    selectedFilePath: spec.pathspecs.length > 0 ? spec.pathspecs[0] : null,
  }));
}

export function buildReviewDiffPathFilter(params: {
  isImmersive: boolean;
  assistedOnly: boolean;
  assistedHunks: readonly AssistedReviewHunk[];
  selectedFilePath: string | null;
  selectedDiffPath: string;
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined;
  repoRootProjectPath: string | null | undefined;
  pathContext?: ProjectRelativePathContext;
}): string {
  return (
    buildReviewDiffPathFilterSpecs({
      ...params,
      projectPath: params.repoRootProjectPath ?? "",
    })[0]?.pathFilter ?? ""
  );
}

export function getEffectiveReviewIncludeUncommitted(params: {
  assistedOnly: boolean;
  includeUncommitted: boolean;
}): boolean {
  // Agent-pinned regions commonly point at the agent's latest working-tree edits.
  // Assisted mode opts into uncommitted changes so accepted pins cannot disappear
  // solely because the user's review toggle was left off.
  return params.assistedOnly ? true : params.includeUncommitted;
}

export function getEffectiveReviewFrontendFilters(params: {
  assistedOnly: boolean;
  showReadHunks: boolean;
  assistedShowReadHunks: boolean;
  searchTerm: string;
}): { showReadHunks: boolean; searchTerm: string } {
  // Honor the user's read-state filter in both modes, but pick which one to
  // consult based on whether Assisted is on. Outside of Assisted mode we use
  // `showReadHunks` (the long-standing global preference, defaults true).
  // While Assisted is on we use `assistedShowReadHunks` (defaults false so
  // marking an assisted pin as read clears it from the worklist — the most
  // common user complaint after Assisted shipped).
  //
  // We intentionally do NOT override the user's search term here anymore:
  // the previous behavior cleared it whenever Assisted toggled on, which
  // surprised users who had legitimately narrowed the diff and discarded
  // their query without warning. Searching across the assisted subset is a
  // useful workflow that the override prevented.
  const effectiveShowRead = params.assistedOnly
    ? params.assistedShowReadHunks
    : params.showReadHunks;
  return { showReadHunks: effectiveShowRead, searchTerm: params.searchTerm };
}

function getReviewPanelPathContext(params: {
  workspaceMetadata:
    | Pick<FrontendWorkspaceMetadata, "projectPath" | "subProjectPath">
    | null
    | undefined;
  projectPath: string;
}): ProjectRelativePathContext {
  const projectPath = params.workspaceMetadata?.projectPath ?? params.projectPath;
  return {
    projectPath,
    executionRootPath: params.workspaceMetadata?.subProjectPath ?? projectPath,
  };
}

export function normalizeReviewPanelAssistedHunks(params: {
  assistedHunks: readonly AssistedReviewHunk[];
  workspaceMetadata:
    | Pick<FrontendWorkspaceMetadata, "projectPath" | "subProjectPath">
    | null
    | undefined;
  projectPath: string;
}): AssistedReviewHunk[] {
  return normalizeAssistedReviewHunks(params.assistedHunks, getReviewPanelPathContext(params));
}

interface ReviewAssistedStatsReporterProps {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating?: boolean;
  onUnreadAssistedChange: (count: number) => void;
}

export const ReviewAssistedStatsReporter: React.FC<ReviewAssistedStatsReporterProps> = ({
  workspaceId,
  workspacePath,
  projectPath,
  isCreating = false,
  onUnreadAssistedChange,
}) => {
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceMetadata();
  const originFetchRef = useRef<OriginFetchState | null>(null);
  const { isRead } = useReviewState(workspaceId);

  const rawWorkspaceStore = useWorkspaceStoreRaw();
  const subscribeAssistedHunks = useCallback(
    (callback: () => void) => rawWorkspaceStore.subscribeKey(workspaceId, callback),
    [rawWorkspaceStore, workspaceId]
  );
  const assistedHunks = useSyncExternalStore(subscribeAssistedHunks, () =>
    rawWorkspaceStore.getAssistedReviewHunks(workspaceId)
  );
  const workspaceReviewMetadata = workspaceMetadata.get(workspaceId);
  const reviewPathContext = useMemo(
    () => getReviewPanelPathContext({ workspaceMetadata: workspaceReviewMetadata, projectPath }),
    [projectPath, workspaceReviewMetadata]
  );
  const normalizedAssistedHunks = useMemo(
    () => normalizeAssistedReviewHunks(assistedHunks, reviewPathContext),
    [assistedHunks, reviewPathContext]
  );

  const projectDefaultBaseKey = getReviewDefaultBaseKey(projectPath);
  const workspaceDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspaceId);
  const [defaultBase] = usePersistedState<string>(
    projectDefaultBaseKey,
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );
  const [diffBase] = usePersistedState(workspaceDiffBaseKey, defaultBase, { listener: true });
  const [includeUncommitted] = usePersistedState(REVIEW_INCLUDE_UNCOMMITTED_KEY, false, {
    listener: true,
  });

  useEffect(() => {
    if (normalizedAssistedHunks.length === 0) {
      onUnreadAssistedChange(0);
      return;
    }
    if (!api || isCreating) return;

    let cancelled = false;
    const effectiveIncludeUncommitted = getEffectiveReviewIncludeUncommitted({
      assistedOnly: true,
      includeUncommitted,
    });
    const diffRequests = buildReviewDiffPathFilterSpecs({
      isImmersive: false,
      assistedOnly: true,
      assistedHunks: normalizedAssistedHunks,
      selectedFilePath: null,
      selectedDiffPath: "",
      workspaceMetadata: workspaceMetadata.get(workspaceId),
      projectPath,
      pathContext: reviewPathContext,
    }).map((spec) => ({
      ...spec,
      diffCommand: buildGitDiffCommand(
        diffBase,
        effectiveIncludeUncommitted,
        spec.pathFilter,
        "diff"
      ),
    }));

    const loadUnreadAssisted = async () => {
      try {
        const values = await Promise.all(
          diffRequests.map(async (request) => {
            await ensureOriginFetched({
              api,
              workspaceId,
              diffBase,
              refreshToken: 0,
              originFetchRef,
              repoRootProjectPath: request.repoRootProjectPath,
            });
            if (cancelled) return null;

            // Deliberately bypass `reviewPanelCache`: this reporter is mounted
            // specifically so agent flags show up while the Review panel is not,
            // and a stale panel cache would hide newly edited assisted hunks.
            const result = await api.workspace.executeBash({
              workspaceId,
              script: request.diffCommand,
              options: repoRootBashOptions(30, request.repoRootProjectPath),
            });
            if (cancelled || !result.success || !result.data.success) {
              return null;
            }

            return parseReviewDiffCacheValue({
              result,
              workspaceMetadata,
              workspaceId,
              repoRootProjectPath: request.repoRootProjectPath,
              diffCommand: request.diffCommand,
              selectedFilePath: request.selectedFilePath,
              isImmersive: true,
            });
          })
        );
        if (cancelled) return;
        const data = mergeReviewDiffCacheValues(values.filter((value) => value !== null));
        onUnreadAssistedChange(
          countUnreadAssistedHunks(data.hunks, normalizedAssistedHunks, isRead, reviewPathContext)
        );
      } catch {
        if (!cancelled) onUnreadAssistedChange(0);
      }
    };

    void loadUnreadAssisted();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    workspaceId,
    workspacePath,
    projectPath,
    workspaceMetadata,
    diffBase,
    includeUncommitted,
    normalizedAssistedHunks,
    reviewPathContext,
    isRead,
    isCreating,
    onUnreadAssistedChange,
  ]);

  return null;
};

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  workspaceId,
  workspacePath,
  projectPath,
  onReviewNote,
  focusTrigger,
  isCreating = false,
  onStatsChange,
  isTouchImmersive = false,
  onTouchImmersiveChange,
}) => {
  const originFetchRef = useRef<OriginFetchState | null>(null);
  const { api } = useAPI();
  const { theme } = useTheme();
  const { workspaceMetadata } = useWorkspaceMetadata();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Review is a code-heavy surface; warm the worker/highlighter during diff loading
    // so immersive mode does not reveal plain text before Shiki is ready.
    preloadHighlightedDiff({
      content: "+const muxReviewSyntaxWarmup = true;",
      filePath: "review-warmup.ts",
      themeMode: theme,
    }).catch(() => undefined);
  }, [theme]);

  // Unified diff state - discriminated union makes invalid states unrepresentable
  // Note: Parent renders with key={workspaceId}, so component remounts on workspace change.
  const [diffState, setDiffState] = useState<DiffState>({ status: "loading" });

  const selectedHunkStorageKey = getReviewSelectedHunkKey(workspaceId);
  // Keep hunk selection local during navigation; persisting every J/K step writes
  // localStorage synchronously and dominates large immersive-review iteration.
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(() =>
    readPersistedState(selectedHunkStorageKey, null)
  );
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [diagnosticInfo, setDiagnosticInfo] = useState<DiagnosticInfo | null>(null);
  const [isPanelFocused, setIsPanelFocused] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null);

  // Map of hunkId -> toggle function for expand/collapse
  const toggleExpandFnsRef = useRef<Map<string, () => void>>(new Map());

  // Ref to hold current filteredHunks for use in navigation callbacks.
  // Avoids needing filteredHunks as a dependency (which changes frequently).
  const filteredHunksRef = useRef<DiffHunk[]>([]);

  // Track refresh trigger changes so we can distinguish initial mount vs manual refresh.
  // Each effect gets its own ref to avoid cross-effect interference.
  const lastDiffRefreshTriggerRef = useRef<number | null>(null);
  const lastFileTreeRefreshTriggerRef = useRef<number | null>(null);

  // Check if tools completed while we were unmounted - skip cache on initial mount if so.
  // Computed once on mount, consumed after first load to avoid re-fetching on every mount.
  const skipCacheOnMountRef = useRef(
    workspaceStore.getFileModifyingToolMs(workspaceId) !== undefined
  );

  // Unified search state (per-workspace persistence)
  const [searchState, setSearchState] = usePersistedState<ReviewSearchState>(
    getReviewSearchStateKey(workspaceId),
    { input: "", useRegex: false, matchCase: false }
  );
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

  // Persist file filter per workspace
  const [selectedFilePath, setSelectedFilePath] = usePersistedState<string | null>(
    `review-file-filter:${workspaceId}`,
    null
  );

  const selectedRepoRootProjectPath = resolveRepoRootProjectPath(
    workspaceMetadata.get(workspaceId),
    selectedFilePath
  );

  const selectedDiffPath = normalizeRepoRootFilePath(
    workspaceMetadata.get(workspaceId),
    selectedFilePath ? extractNewPath(selectedFilePath) : null,
    selectedRepoRootProjectPath
  );

  const projectDefaultBaseKey = getReviewDefaultBaseKey(projectPath);
  const workspaceDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspaceId);

  // Per-project default base (shared across workspaces in the same project).
  // Falls back to a static value only if trunk detection fails.
  const [defaultBase, setDefaultBase] = usePersistedState<string>(
    projectDefaultBaseKey,
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );

  // Persist diff base per workspace (falls back to project default)
  // Uses listener: true to sync with GitStatusIndicator base selector
  const [diffBase, setDiffBase] = usePersistedState(workspaceDiffBaseKey, defaultBase, {
    listener: true,
  });

  // Persist includeUncommitted flag globally
  const [includeUncommitted, setIncludeUncommitted] = usePersistedState(
    REVIEW_INCLUDE_UNCOMMITTED_KEY,
    false,
    { listener: true }
  );

  // Persist showReadHunks flag globally
  const [showReadHunks, setShowReadHunks] = usePersistedState("review-show-read", true);

  // Persist sort order globally
  const [sortOrder, setSortOrder] = usePersistedState<ReviewSortOrder>(
    REVIEW_SORT_ORDER_KEY,
    "last-edit"
  );

  // Auto-detect trunk for new review base keys so repos using master/develop
  // don't start on the hard-coded fallback. Existing user selections are preserved.
  //
  // IMPORTANT: workspace task trunk metadata may represent a fork source branch, not
  // the repository's canonical trunk. So we only apply metadata trunk to the workspace-
  // scoped diff base, while the project default comes from listBranches().recommendedTrunk.
  useEffect(() => {
    const projectBaseIsPersisted = readPersistedString(projectDefaultBaseKey) !== undefined;
    const workspaceBaseIsPersisted = readPersistedString(workspaceDiffBaseKey) !== undefined;
    const shouldInitializeWorkspaceBase = !workspaceBaseIsPersisted;

    const metadataTrunkBase = toMetadataDiffBase(
      workspaceMetadata.get(workspaceId)?.taskTrunkBranch
    );
    const initializedWorkspaceFromMetadata =
      shouldInitializeWorkspaceBase && metadataTrunkBase != null;
    if (initializedWorkspaceFromMetadata) {
      setDiffBase(metadataTrunkBase);
    }

    if (projectBaseIsPersisted || !api) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const branchResult = await api.projects.listBranches({ projectPath });
        const detectedBase = toOriginDiffBase(branchResult.recommendedTrunk);
        if (cancelled) {
          return;
        }
        if (!detectedBase) {
          // Persist fallback once so repeated metadata updates don't keep re-trying
          // trunk detection for repos that currently have no usable recommended trunk.
          if (readPersistedString(projectDefaultBaseKey) === undefined) {
            setDefaultBase(WORKSPACE_DEFAULTS.reviewBase);
          }
          return;
        }

        if (readPersistedString(projectDefaultBaseKey) === undefined) {
          setDefaultBase(detectedBase);
        }
        if (shouldInitializeWorkspaceBase && !initializedWorkspaceFromMetadata) {
          const currentWorkspaceBase = readPersistedString(workspaceDiffBaseKey);
          if (currentWorkspaceBase === undefined) {
            setDiffBase(detectedBase);
          }
        }
      } catch {
        // Best effort only; keep WORKSPACE_DEFAULTS.reviewBase when detection fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    projectDefaultBaseKey,
    projectPath,
    setDefaultBase,
    setDiffBase,
    workspaceDiffBaseKey,
    workspaceId,
    workspaceMetadata,
  ]);

  // Initialize review state hook
  const { isRead, toggleRead, markAsRead, markAsUnread } = useReviewState(workspaceId);

  // Refs for values that change frequently but are only read at callback invocation time.
  // Using refs allows callbacks to stay stable (same reference) while still accessing current values.
  // This prevents all HunkViewer components from re-rendering when these values change.
  const isReadRef = useRef(isRead);
  isReadRef.current = isRead;
  const selectedHunkIdRef = useRef(selectedHunkId);
  selectedHunkIdRef.current = selectedHunkId;

  useEffect(() => {
    updatePersistedState(selectedHunkStorageKey, selectedHunkId);
  }, [selectedHunkStorageKey, selectedHunkId]);

  useEffect(() => {
    return () => {
      updatePersistedState(selectedHunkStorageKey, selectedHunkIdRef.current);
    };
  }, [selectedHunkStorageKey]);
  const showReadHunksRef = useRef(false); // Will be updated after filters state is declared

  // Track hunk first-seen timestamps for LIFO sorting
  const { recordFirstSeen, firstSeenMap } = useHunkFirstSeen(workspaceId);

  const {
    reviews,
    updateReviewNote,
    checkReview,
    uncheckReview,
    attachReview,
    detachReview,
    removeReview,
  } = useReviews(workspaceId);

  // Immersive review mode - persisted so WorkspaceShell overlay can react
  const [isImmersive, setIsImmersive] = usePersistedState<boolean>(
    getReviewImmersiveKey(workspaceId),
    false,
    { listener: true }
  );

  const toggleImmersive = useCallback(() => {
    setIsImmersive((prev) => {
      const next = !prev;
      if (next) {
        // The in-panel immersive button defaults to keyboard-first navigation.
        onTouchImmersiveChange?.(false);
      }
      return next;
    });
  }, [onTouchImmersiveChange, setIsImmersive]);

  const reviewsByFilePath = useMemo(() => {
    const grouped = new Map<string, typeof reviews>();

    for (const review of reviews) {
      const filePath = review.data?.filePath;
      if (!filePath) continue;

      const existing = grouped.get(filePath);
      if (existing) {
        existing.push(review);
      } else {
        grouped.set(filePath, [review]);
      }
    }

    return grouped;
  }, [reviews]);

  // Derive hunks from diffState for use in filters and rendering
  const hunks = useMemo(
    () =>
      diffState.status === "loaded" || diffState.status === "refreshing" ? diffState.hunks : [],
    [diffState]
  );

  const syntaxPrewarmHunk = useMemo(() => {
    if (hunks.length === 0) {
      return null;
    }

    if (!selectedHunkId) {
      return hunks[0];
    }

    return hunks.find((hunk) => hunk.id === selectedHunkId) ?? hunks[0];
  }, [hunks, selectedHunkId]);

  useEffect(() => {
    if (!syntaxPrewarmHunk) {
      return;
    }

    // Start Shiki/language loading while the user is still in the review list so
    // entering immersive review does not visibly repaint plain rows as colored tokens.
    preloadHighlightedDiff({
      content: syntaxPrewarmHunk.content,
      filePath: syntaxPrewarmHunk.filePath,
      oldStart: syntaxPrewarmHunk.oldStart,
      newStart: syntaxPrewarmHunk.newStart,
      themeMode: theme,
    }).catch(() => undefined);
  }, [syntaxPrewarmHunk, theme]);

  const orphanReviews = useMemo(() => {
    const diffFilePaths = new Set<string>();
    for (const hunk of hunks) {
      diffFilePaths.add(hunk.filePath);
      if (hunk.oldPath) {
        diffFilePaths.add(hunk.oldPath);
      }
    }

    const plan: typeof reviews = [];
    const nonPlan: typeof reviews = [];

    for (const review of reviews) {
      const filePath = review.data?.filePath;
      if (!filePath || diffFilePaths.has(filePath)) {
        continue;
      }

      if (isPlanFilePath(filePath)) {
        plan.push(review);
      } else {
        nonPlan.push(review);
      }
    }

    return { plan, nonPlan };
  }, [hunks, reviews]);

  const planOrphanReviews = orphanReviews.plan;
  // `assistedShowReadHunks` is intentionally NOT persisted across workspaces:
  // it's a transient worklist preference scoped to a single Assisted session.
  // Defaulting to `false` makes the "Read:" toggle behave as the user expects
  // when Assisted is on — marking an assisted pin as read clears it from the
  // view. A user who wants to inspect already-read pins can flip it on.
  const [filters, setFilters] = useState<ReviewFiltersType>({
    showReadHunks: showReadHunks,
    assistedShowReadHunks: false,
    diffBase: diffBase,
    includeUncommitted: includeUncommitted,
    sortOrder: sortOrder,
    assistedOnly: false,
  });

  // Subscribe to the agent's Assisted Review hunks for this workspace. The
  // aggregator returns a stable reference (only changes when review_pane_update
  // succeeds), so this snapshot is safe to use in useSyncExternalStore.
  const rawWorkspaceStore = useWorkspaceStoreRaw();
  const subscribeAssistedHunks = useCallback(
    (callback: () => void) => rawWorkspaceStore.subscribeKey(workspaceId, callback),
    [rawWorkspaceStore, workspaceId]
  );
  const assistedHunks = useSyncExternalStore(subscribeAssistedHunks, () =>
    rawWorkspaceStore.getAssistedReviewHunks(workspaceId)
  );

  const workspaceReviewMetadata = workspaceMetadata.get(workspaceId);
  const reviewPathContext = useMemo(
    () => getReviewPanelPathContext({ workspaceMetadata: workspaceReviewMetadata, projectPath }),
    [projectPath, workspaceReviewMetadata]
  );
  const normalizedAssistedHunks = useMemo(
    () => normalizeAssistedReviewHunks(assistedHunks, reviewPathContext),
    [assistedHunks, reviewPathContext]
  );

  const hasAssistedHunks = assistedHunks.length > 0;

  // Auto-focus the Review pane on the agent's flagged hunks the first time
  // they appear in a session: flip `assistedOnly` to true so the user lands
  // directly on the critical changes. Subsequent manual toggles stick because
  // the ref guards against re-arming until the agent clears + re-flags.
  //
  // - First rise (false → true): force-on, set the latch.
  // - Subsequent flag updates while latched: do nothing (respect user choice).
  // - Drop (true → false): reset the toggle AND re-arm the latch so the next
  //   batch of flagged hunks gets focus again.
  const hasAutoEnabledAssistedRef = useRef(false);
  useEffect(() => {
    if (hasAssistedHunks) {
      if (!hasAutoEnabledAssistedRef.current) {
        hasAutoEnabledAssistedRef.current = true;
        setFilters((prev) => (prev.assistedOnly ? prev : { ...prev, assistedOnly: true }));
      }
      return;
    }
    // Agent cleared its hint set — drop the filter and re-arm auto-focus
    // so the next round of flags re-triggers focus mode.
    hasAutoEnabledAssistedRef.current = false;
    setFilters((prev) => (prev.assistedOnly ? { ...prev, assistedOnly: false } : prev));
  }, [hasAssistedHunks]);

  const handleDiffBaseInteraction = useCallback(
    (value: string) => {
      // Persist immediately so async trunk detection can observe explicit selections,
      // even when the selected value matches the current fallback base.
      setDiffBase(value);
    },
    [setDiffBase]
  );

  // Keep filters in sync with persisted state when updates come from outside this panel
  // (e.g., GitStatusIndicator base selector).
  useEffect(() => {
    setFilters((prev) => {
      if (prev.diffBase === diffBase) {
        return prev;
      }

      return { ...prev, diffBase };
    });
  }, [diffBase]);

  // Git status uses diffBase too; refresh immediately when it changes.
  const lastGitStatusBaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastGitStatusBaseRef.current !== null && lastGitStatusBaseRef.current !== diffBase) {
      invalidateGitStatus(workspaceId);
    }

    lastGitStatusBaseRef.current = diffBase;
  }, [workspaceId, diffBase]);

  // Keep showReadHunksRef in sync for stable callbacks.
  //
  // We deliberately mirror the *effective* show-read value here (i.e. the
  // assisted-scoped flag while Assisted is on, the global flag otherwise) so
  // `handleToggleRead`/`handleMarkAsRead` can compute the correct
  // "will this hunk still be visible after marking it read?" decision
  // without needing the filters object as a dependency. Previously this
  // mirrored only `filters.showReadHunks`, which caused the panel to
  // navigate away from a hunk that was actually still visible whenever
  // Assisted's override forced show-read true.
  showReadHunksRef.current = filters.assistedOnly
    ? filters.assistedShowReadHunks
    : filters.showReadHunks;

  // Track if user is drafting a review note (selection or editing an existing note).
  // We only pause scheduled refreshes while drafting so tool-driven refresh stays unified
  // (and keeps the untracked banner in sync) when the panel is focused.
  // Uses Sets to track which hunks have active selections / inline notes in edit mode.
  const isComposingReviewNoteRef = useRef(false);
  const composingHunksRef = useRef(new Set<string>());
  const editingReviewIdsRef = useRef(new Set<string>());

  const updateRefreshBlockState = useCallback(() => {
    const wasComposing = isComposingReviewNoteRef.current;
    const nowComposing = composingHunksRef.current.size > 0 || editingReviewIdsRef.current.size > 0;
    isComposingReviewNoteRef.current = nowComposing;

    // Update UI state for button disabled state
    setIsRefreshBlocked(nowComposing);

    // If we just stopped composing and there was a pending refresh, flush it
    if (wasComposing && !nowComposing) {
      controllerRef.current?.notifyUnpaused();
    }
  }, []);

  const handleHunkComposingChange = useCallback(
    (hunkId: string, isComposing: boolean) => {
      if (isComposing) {
        composingHunksRef.current.add(hunkId);
      } else {
        composingHunksRef.current.delete(hunkId);
      }
      updateRefreshBlockState();
    },
    [updateRefreshBlockState]
  );

  const handleInlineReviewEditingChange = useCallback(
    (reviewId: string, isEditing: boolean) => {
      if (isEditing) {
        editingReviewIdsRef.current.add(reviewId);
      } else {
        editingReviewIdsRef.current.delete(reviewId);
      }
      updateRefreshBlockState();
    },
    [updateRefreshBlockState]
  );

  // Memoized review action callbacks for inline review notes
  const reviewActions: ReviewActionCallbacks = useMemo(
    () => ({
      onEditComment: updateReviewNote,
      onEditingChange: handleInlineReviewEditingChange,
      onComplete: checkReview,
      onUncheck: uncheckReview,
      onAttach: attachReview,
      onDetach: detachReview,
      onDelete: removeReview,
    }),
    [
      updateReviewNote,
      handleInlineReviewEditingChange,
      checkReview,
      uncheckReview,
      attachReview,
      detachReview,
      removeReview,
    ]
  );

  // Track last fetch time for detecting tool completions while unmounted
  const lastFetchTimeRef = useRef(0);

  // Last refresh info for UI display (tooltip showing trigger reason + time)
  const [lastRefreshInfo, setLastRefreshInfo] = useState<LastRefreshInfo | null>(null);
  // Last refresh failure for UI display (tooltip showing latest refresh error)
  const [lastRefreshFailure, setLastRefreshFailure] = useState<RefreshFailureInfo | null>(null);
  // Track if refresh button should be disabled (drafting or editing a review note)
  const [isRefreshBlocked, setIsRefreshBlocked] = useState(false);

  // RefreshController - handles debouncing, in-flight guards, etc.
  // Created in useEffect to survive React StrictMode double-mount.
  // (StrictMode calls cleanup then re-mounts; refs persist but controller would be disposed)
  const controllerRef = useRef<RefreshController | null>(null);

  useEffect(() => {
    const controller = new RefreshController({
      debounceMs: 3000,
      // Pause scheduled refreshes while drafting to avoid wiping draft notes.
      isPaused: () => isComposingReviewNoteRef.current,
      // Block manual refresh while drafting (e.g., user clicks refresh or presses Ctrl+R).
      isManualBlocked: () => isComposingReviewNoteRef.current,
      onRefresh: () => {
        lastFetchTimeRef.current = Date.now();
        setRefreshTrigger((prev) => prev + 1);
        invalidateGitStatus(workspaceId);
      },
      onRefreshComplete: (info) => {
        setLastRefreshInfo(info);
        setLastRefreshFailure(null);
      },
      onRefreshError: setLastRefreshFailure,
    });
    controllerRef.current = controller;

    // Subscribe to tool completions
    const unsubscribe = workspaceStore.subscribeFileModifyingTool((wsId) => {
      if (wsId === workspaceId) {
        controller.schedule();
      }
    });

    // Check for tool completions that happened while unmounted
    const lastToolMs = workspaceStore.getFileModifyingToolMs(workspaceId);
    if (lastToolMs && lastToolMs > lastFetchTimeRef.current) {
      controller.requestImmediate();
      workspaceStore.clearFileModifyingToolMs(workspaceId);
    }

    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [workspaceId]);

  const handleRefresh = () => {
    controllerRef.current?.requestImmediate();
  };

  // Focus panel when focusTrigger changes (preserves current hunk selection)
  useEffect(() => {
    if (focusTrigger && focusTrigger > 0) {
      panelRef.current?.focus();
    }
  }, [focusTrigger]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchState.input);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchState.input]);

  // Load file tree - when workspace, diffBase, or refreshTrigger changes
  useEffect(() => {
    // Skip data loading while workspace is being created
    if (!api || isCreating) return;
    let cancelled = false;

    const isManualRefresh =
      refreshTrigger !== 0 && lastFileTreeRefreshTriggerRef.current !== refreshTrigger;

    const numstatCommand = buildGitDiffCommand(
      filters.diffBase,
      filters.includeUncommitted,
      "", // No path filter for file tree
      "numstat"
    );

    const nameStatusCommand = buildGitDiffCommand(
      filters.diffBase,
      filters.includeUncommitted,
      "", // No path filter for file tree
      "name-status"
    );

    const numstatMarker = "__MUX_REVIEW_FILE_TREE_NUMSTAT__";
    const nameStatusMarker = "__MUX_REVIEW_FILE_TREE_NAME_STATUS__";
    const fileTreeCommand = [
      `echo ${shellQuote(numstatMarker)}`,
      numstatCommand,
      `echo ${shellQuote(nameStatusMarker)}`,
      nameStatusCommand,
    ].join("\n");
    const fileTreeRepoRootProjectPath = projectPath;

    const cacheKey = makeReviewPanelCacheKey({
      workspaceId,
      workspacePath,
      gitCommand: fileTreeCommand,
      repoRootProjectPath: fileTreeRepoRootProjectPath,
    });

    // Fast path: use cached tree when switching workspaces (unless user explicitly refreshed
    // or tools completed while we were unmounted).
    if (!isManualRefresh && !skipCacheOnMountRef.current) {
      const cachedTree = reviewPanelCache.get(cacheKey) as FileTreeNode | undefined;
      if (cachedTree) {
        setFileTree(cachedTree);
        setIsLoadingTree(false);
        return () => {
          cancelled = true;
        };
      }
    }

    const loadFileTree = async () => {
      setIsLoadingTree(true);
      try {
        await ensureOriginFetched({
          api,
          workspaceId,
          diffBase: filters.diffBase,
          refreshToken: refreshTrigger,
          originFetchRef,
          repoRootProjectPath: fileTreeRepoRootProjectPath,
        });
        if (cancelled) return;

        const tree = await executeWorkspaceBashAndCache({
          api,
          workspaceId,
          script: fileTreeCommand,
          cacheKey,
          timeoutSecs: 30,
          repoRootProjectPath: fileTreeRepoRootProjectPath,
          parse: (result) => {
            const output = result.data.output ?? "";

            const marker1 = `${numstatMarker}\n`;
            const marker2 = `${nameStatusMarker}\n`;

            let numstatOutput = output;
            let nameStatusOutput = "";
            const markerSplit = output.split(marker1);
            if (markerSplit.length >= 2) {
              const afterMarker1 = markerSplit[1] ?? "";
              const sections = afterMarker1.split(marker2);
              numstatOutput = sections[0] ?? "";
              nameStatusOutput = sections[1] ?? "";
            }

            const fileStats = parseNumstat(numstatOutput).map((stat) => ({
              ...stat,
              filePath: reprojectRepoRootFilePath(
                workspaceMetadata.get(workspaceId),
                stat.filePath,
                fileTreeRepoRootProjectPath
              ),
            }));
            const nameStatus = parseNameStatus(nameStatusOutput).map((entry) => ({
              ...entry,
              filePath: reprojectRepoRootFilePath(
                workspaceMetadata.get(workspaceId),
                entry.filePath,
                fileTreeRepoRootProjectPath
              ),
              oldPath: entry.oldPath
                ? reprojectRepoRootFilePath(
                    workspaceMetadata.get(workspaceId),
                    entry.oldPath,
                    fileTreeRepoRootProjectPath
                  )
                : undefined,
            }));
            const statusByPath = new Map(nameStatus.map((entry) => [entry.filePath, entry]));

            for (const stat of fileStats) {
              const key = extractNewPath(stat.filePath);
              const status = statusByPath.get(key);
              stat.changeType = status?.changeType ?? "modified";
              if (status?.oldPath) {
                stat.oldPath = status.oldPath;
              }
            }

            // Repo-root git output is reprojected back onto the shared container root here so
            // downstream plain reads can keep using `cat project-a/src/file.ts` without caring
            // which repo checkout produced the review metadata.
            return buildFileTree(fileStats);
          },
        });

        if (cancelled) return;
        lastFileTreeRefreshTriggerRef.current = refreshTrigger;
        setFileTree(tree);
      } catch (err) {
        console.error("Failed to load file tree:", err);
      } finally {
        if (!cancelled) {
          setIsLoadingTree(false);
        }
      }
    };

    void loadFileTree();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    workspaceId,
    workspacePath,
    projectPath,
    workspaceMetadata,
    filters.diffBase,
    filters.includeUncommitted,
    refreshTrigger,
    isCreating,
  ]);

  // Load diff hunks - when workspace, diffBase, selected path, or refreshTrigger changes
  useEffect(() => {
    // Skip data loading while workspace is being created
    if (!api || isCreating) return;
    let cancelled = false;

    const isManualRefresh =
      refreshTrigger !== 0 && lastDiffRefreshTriggerRef.current !== refreshTrigger;

    const effectiveIncludeUncommitted = getEffectiveReviewIncludeUncommitted({
      assistedOnly: filters.assistedOnly,
      includeUncommitted: filters.includeUncommitted,
    });

    const diffRequests = buildReviewDiffPathFilterSpecs({
      isImmersive,
      assistedOnly: filters.assistedOnly,
      assistedHunks: normalizedAssistedHunks,
      selectedFilePath,
      selectedDiffPath,
      selectedRepoRootProjectPath,
      workspaceMetadata: workspaceMetadata.get(workspaceId),
      projectPath,
      pathContext: reviewPathContext,
    }).map((spec) => {
      const diffCommand = buildGitDiffCommand(
        filters.diffBase,
        effectiveIncludeUncommitted,
        spec.pathFilter,
        "diff"
      );
      return {
        ...spec,
        diffCommand,
        cacheKey: makeReviewPanelCacheKey({
          workspaceId,
          workspacePath,
          gitCommand: diffCommand,
          repoRootProjectPath: spec.repoRootProjectPath,
        }),
      };
    });

    // Fast path: use cached diff when switching workspaces (unless user explicitly refreshed
    // or tools completed while we were unmounted).
    if (!isManualRefresh && !skipCacheOnMountRef.current) {
      const cachedValues: ReviewPanelDiffCacheValue[] = [];
      let allRequestsCached = true;
      for (const request of diffRequests) {
        const cached = reviewPanelCache.get(request.cacheKey) as
          | ReviewPanelDiffCacheValue
          | undefined;
        if (!cached) {
          allRequestsCached = false;
          break;
        }
        cachedValues.push(cached);
      }

      if (allRequestsCached) {
        const cached = mergeReviewDiffCacheValues(cachedValues);
        setDiagnosticInfo(cached.diagnosticInfo);
        setDiffState({
          status: "loaded",
          hunks: cached.hunks,
          truncationWarning: cached.truncationWarning,
        });

        return () => {
          cancelled = true;
        };
      }
    }

    // Clear the skip-cache flag and store timestamp after first load.
    // This prevents re-fetching on every filter change.
    if (skipCacheOnMountRef.current) {
      skipCacheOnMountRef.current = false;
      workspaceStore.clearFileModifyingToolMs(workspaceId);
    }

    // Transition to appropriate loading state:
    // - "refreshing" if we have data (keeps UI stable during refresh)
    // - "loading" if no data yet
    setDiffState((prev) => {
      if (prev.status === "loaded" || prev.status === "refreshing") {
        return {
          status: "refreshing",
          hunks: prev.hunks,
          truncationWarning: prev.truncationWarning,
        };
      }
      return { status: "loading" };
    });

    const loadDiff = async () => {
      try {
        const values = await Promise.all(
          diffRequests.map(async (request) => {
            await ensureOriginFetched({
              api,
              workspaceId,
              diffBase: filters.diffBase,
              refreshToken: refreshTrigger,
              originFetchRef,
              repoRootProjectPath: request.repoRootProjectPath,
            });
            if (cancelled) return null;

            // Git-level filters (affect what data is fetched):
            // - diffBase: what to diff against
            // - includeUncommitted: include working directory changes
            // - selectedFilePath / assisted pins: ESSENTIAL for truncation and
            //   multi-project parity; path filters retrieve specific files' hunks.
            return executeWorkspaceBashAndCache({
              api,
              workspaceId,
              script: request.diffCommand,
              cacheKey: request.cacheKey,
              timeoutSecs: 30,
              repoRootProjectPath: request.repoRootProjectPath,
              parse: (result) =>
                parseReviewDiffCacheValue({
                  result,
                  workspaceMetadata,
                  workspaceId,
                  repoRootProjectPath: request.repoRootProjectPath,
                  diffCommand: request.diffCommand,
                  selectedFilePath: request.selectedFilePath,
                  isImmersive,
                }),
            });
          })
        );
        const data = mergeReviewDiffCacheValues(values.filter((value) => value !== null));

        if (cancelled) return;

        lastDiffRefreshTriggerRef.current = refreshTrigger;
        setDiagnosticInfo(data.diagnosticInfo);

        // Preserve object references for unchanged hunks to prevent unnecessary re-renders.
        // HunkViewer is memoized on hunk object identity, so reusing references avoids
        // re-rendering (and re-highlighting) hunks that haven't actually changed.
        setDiffState((prev) => {
          const prevHunks =
            prev.status === "loaded" || prev.status === "refreshing" ? prev.hunks : [];
          const hunks = preserveHunkReferences(prevHunks, data.hunks);
          return {
            status: "loaded",
            hunks,
            truncationWarning: data.truncationWarning,
          };
        });
      } catch (err) {
        if (cancelled) return;
        const errorMsg = `Failed to load diff: ${getErrorMessage(err)}`;
        console.error(errorMsg);
        setDiffState({ status: "error", message: errorMsg });
        setDiagnosticInfo(null);
      }
    };

    void loadDiff();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    workspaceId,
    workspacePath,
    projectPath,
    workspaceMetadata,
    filters.diffBase,
    filters.includeUncommitted,
    filters.assistedOnly,
    normalizedAssistedHunks,
    reviewPathContext,
    selectedFilePath,
    selectedRepoRootProjectPath,
    selectedDiffPath,
    refreshTrigger,
    isCreating,
    isImmersive,
  ]);

  // Persist includeUncommitted when it changes
  useEffect(() => {
    setIncludeUncommitted(filters.includeUncommitted);
  }, [filters.includeUncommitted, setIncludeUncommitted]);

  // Persist showReadHunks when it changes
  useEffect(() => {
    setShowReadHunks(filters.showReadHunks);
  }, [filters.showReadHunks, setShowReadHunks]);

  // Persist sortOrder when it changes
  useEffect(() => {
    setSortOrder(filters.sortOrder);
  }, [filters.sortOrder, setSortOrder]);

  // Record first-seen timestamps for new hunks
  useEffect(() => {
    if (hunks.length > 0) {
      recordFirstSeen(hunks.map((h) => h.id));
    }
  }, [hunks, recordFirstSeen]);

  // Precompute per-file read summaries once so FileTree badges can do O(1) lookups
  // instead of rescanning every hunk for each rendered node.
  const { fileReadStatusByPath, readHunkCount } = useMemo(() => {
    const summaries = new Map<string, FileReadStatusSummary>();
    let nextReadHunkCount = 0;

    for (const hunk of hunks) {
      const hunkIsRead = isRead(hunk.id);
      if (hunkIsRead) {
        nextReadHunkCount += 1;
      }

      const existing = summaries.get(hunk.filePath);
      if (existing) {
        existing.total += 1;
        if (hunkIsRead) {
          existing.read += 1;
        }
        continue;
      }

      summaries.set(hunk.filePath, {
        total: 1,
        read: hunkIsRead ? 1 : 0,
      });
    }

    return {
      fileReadStatusByPath: summaries,
      readHunkCount: nextReadHunkCount,
    };
  }, [hunks, isRead]);

  const getFileReadStatus = useCallback(
    (filePath: string) => {
      return fileReadStatusByPath.get(filePath) ?? null;
    },
    [fileReadStatusByPath]
  );

  // Compute per-hunk assisted-match index so we can both gate the Assisted
  // filter AND pin matching hunks to the top (in agent-declared order).
  // Comments are looked up off this same map by HunkViewer.
  const assistedMatchByHunkId = useMemo(() => {
    if (normalizedAssistedHunks.length === 0)
      return new Map<string, { entry: AssistedReviewHunk; index: number }>();
    const candidates = resolveAssistedReviewPathCandidatesForHunks(
      normalizedAssistedHunks,
      hunks,
      reviewPathContext
    );
    const map = new Map<string, { entry: AssistedReviewHunk; index: number }>();
    for (const h of hunks) {
      const match = findAssistedCandidateMatch(h, candidates);
      if (match) map.set(h.id, match);
    }
    return map;
  }, [hunks, normalizedAssistedHunks, reviewPathContext]);

  const assistedCommentByHunkId = useMemo(() => {
    if (assistedMatchByHunkId.size === 0) return new Map<string, string>();
    const result = new Map<string, string>();
    for (const [hunkId, match] of assistedMatchByHunkId) {
      if (match.entry.comment) result.set(hunkId, match.entry.comment);
    }
    return result;
  }, [assistedMatchByHunkId]);

  // Mirror map of new-side ranges so HunkViewer can trim to just the
  // agent-flagged lines. Built off the same matchByHunkId so identity is
  // stable across renders (React.memo on HunkViewer relies on this).
  const assistedRangeByHunkId = useMemo(() => {
    if (assistedMatchByHunkId.size === 0) return new Map<string, { start: number; end: number }>();
    const result = new Map<string, { start: number; end: number }>();
    for (const [hunkId, match] of assistedMatchByHunkId) {
      if (match.entry.range) result.set(hunkId, match.entry.range);
    }
    return result;
  }, [assistedMatchByHunkId]);

  // Set of hunkIds whose pin was added recently enough to qualify for the
  // transient "new" badge.
  //
  // Subtle: we need wall-clock invalidation, not just structural — otherwise
  // a badge can linger far beyond the threshold if no further assisted
  // updates land (the memo never re-runs). To fix that we drive recomputation
  // off a `newPinTick` state and schedule a single `setTimeout` for the next
  // pending expiry; the timeout re-bumps the tick and the effect itself
  // re-evaluates, which schedules the following expiry (or stops if none).
  // This is cheaper than a periodic interval and keeps idle workspaces
  // completely quiet once every pin has expired.
  //
  // We schedule against the FULL normalized assisted list rather than just the
  // currently-matched subset: a pin that's added while it doesn't match the
  // diff (e.g., wrong base) still needs its 60s clock to tick down, so that
  // if/when it becomes matched later (refresh, rebase) the badge has already
  // expired and we don't surface a stale "new" cue.
  const newAssistedPinThresholdMs = 60_000;
  const [newPinTick, setNewPinTick] = useState(() => Date.now());
  useEffect(() => {
    if (normalizedAssistedHunks.length === 0) return;
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const entry of normalizedAssistedHunks) {
      const addedAt = entry.addedAt;
      if (!addedAt) continue;
      const expiry = addedAt + newAssistedPinThresholdMs;
      if (expiry > now && expiry < nextExpiry) {
        nextExpiry = expiry;
      }
    }
    if (nextExpiry === Infinity) return;
    // Round up by 50ms so the recompute lands just after the boundary —
    // avoids a flap where the tick fires a hair too early and re-schedules
    // itself for the same expiry.
    const delay = nextExpiry - now + 50;
    const id = window.setTimeout(() => setNewPinTick(Date.now()), delay);
    return () => window.clearTimeout(id);
  }, [normalizedAssistedHunks, newPinTick, newAssistedPinThresholdMs]);

  const assistedNewByHunkId = useMemo(() => {
    if (assistedMatchByHunkId.size === 0) return new Set<string>();
    const cutoff = newPinTick - newAssistedPinThresholdMs;
    const result = new Set<string>();
    for (const [hunkId, match] of assistedMatchByHunkId) {
      const addedAt = match.entry.addedAt;
      if (addedAt && addedAt >= cutoff) result.add(hunkId);
    }
    return result;
  }, [assistedMatchByHunkId, newPinTick, newAssistedPinThresholdMs]);

  // Stable Set view over the match-map keys so the immersive view (and any
  // future read-only consumer) can do O(1) "is this assisted?" lookups
  // without re-deriving from the Map on every render.
  const assistedHunkIdSet = useMemo(
    () => new Set(assistedMatchByHunkId.keys()),
    [assistedMatchByHunkId]
  );

  // Count of agent-flagged hunks the user hasn't read yet, restricted to
  // pins that actually match a currently-loaded diff hunk. We pin this in
  // the control bar so the toggle's "(unread/total)" label matches the
  // Review-tab badge and avoids the bug where the static `assistedCount`
  // tooltip never decremented as the user worked through the worklist.
  const unreadAssistedInDiff = useMemo(() => {
    if (assistedMatchByHunkId.size === 0) return 0;
    let count = 0;
    for (const hunkId of assistedMatchByHunkId.keys()) {
      if (!isRead(hunkId)) count += 1;
    }
    return count;
  }, [assistedMatchByHunkId, isRead]);

  // Apply frontend filters (read state, search term) and sorting
  // Note: selectedFilePath is a git-level filter, applied when fetching hunks
  const filteredHunks = useMemo(() => {
    // Apply the predicate whenever the toggle is on, even when the match map
    // is empty — otherwise enabling Assisted in a mismatch case (e.g. after
    // rebase or file rename invalidated the agent's filters) would silently
    // fall back to "show everything" instead of giving the user the empty
    // state they need to notice the mismatch.
    const assistedPredicate = filters.assistedOnly
      ? (hunk: DiffHunk) => assistedMatchByHunkId.has(hunk.id)
      : undefined;

    const effectiveFrontendFilters = getEffectiveReviewFrontendFilters({
      assistedOnly: filters.assistedOnly,
      showReadHunks: filters.showReadHunks,
      assistedShowReadHunks: filters.assistedShowReadHunks,
      searchTerm: debouncedSearchTerm,
    });

    const filtered = applyFrontendFilters(hunks, {
      showReadHunks: effectiveFrontendFilters.showReadHunks,
      isRead,
      searchTerm: effectiveFrontendFilters.searchTerm,
      useRegex: searchState.useRegex,
      matchCase: searchState.matchCase,
      isAssisted: assistedPredicate,
    });

    // Apply sorting based on sortOrder
    let ordered: DiffHunk[];
    if (filters.sortOrder === "last-edit") {
      // Sort by first-seen timestamp (newest first = LIFO)
      // Hunks without a first-seen record use current time (treated as newest)
      const now = Date.now();
      ordered = [...filtered].sort((a, b) => {
        const aTime = firstSeenMap[a.id] ?? now;
        const bTime = firstSeenMap[b.id] ?? now;
        return bTime - aTime; // Descending (newest first)
      });
    } else {
      // Default: file-order (maintain original order from git diff)
      ordered = filtered;
    }

    // Pin assisted hunks to the top, preserving the agent's declared order.
    // We do this regardless of the assistedOnly toggle so the agent's
    // focus is always surfaced when present.
    if (assistedMatchByHunkId.size === 0) return ordered;

    const assistedBucket: DiffHunk[] = [];
    const rest: DiffHunk[] = [];
    for (const hunk of ordered) {
      if (assistedMatchByHunkId.has(hunk.id)) {
        assistedBucket.push(hunk);
      } else {
        rest.push(hunk);
      }
    }
    assistedBucket.sort((a, b) => {
      const ai = assistedMatchByHunkId.get(a.id)?.index ?? 0;
      const bi = assistedMatchByHunkId.get(b.id)?.index ?? 0;
      return ai - bi;
    });
    return [...assistedBucket, ...rest];
  }, [
    hunks,
    filters.showReadHunks,
    // `assistedShowReadHunks` is the effective read filter while Assisted is
    // on; if we don't list it, toggling the scoped checkbox won't recompute
    // `filteredHunks` and the user's input becomes a no-op.
    filters.assistedShowReadHunks,
    filters.sortOrder,
    filters.assistedOnly,
    assistedMatchByHunkId,
    isRead,
    debouncedSearchTerm,
    searchState.useRegex,
    searchState.matchCase,
    firstSeenMap,
  ]);

  // Huge reviews are useful for navigation, but eagerly expanding every hunk can mount
  // tens of thousands of diff-line nodes next to the transcript. Keep the list scannable
  // by expanding only the selected hunk once review scale crosses this threshold.
  const preferCollapsedHunks =
    hunks.length >= LARGE_REVIEW_COLLAPSE_HUNK_THRESHOLD ||
    (diagnosticInfo?.outputLength ?? 0) >= LARGE_REVIEW_COLLAPSE_OUTPUT_BYTES ||
    (diffState.status === "loaded" || diffState.status === "refreshing"
      ? diffState.truncationWarning !== null
      : false);

  // Keep ref in sync so callbacks can access current filtered list without dependency
  filteredHunksRef.current = filteredHunks;

  // Ensure selectedHunkId is valid after filtering/sorting:
  // - If no selection or selection not in the validity list, select first visible hunk
  // - This runs after sorting, so we always select the top-most hunk in current order
  //
  // Immersive review can intentionally navigate to a hunk that is hidden by
  // the active filter (e.g. clicking a pending review whose hunk has been
  // marked read while hide-read is on). The immersive view falls back to
  // `allHunks` for those selections, so when we're in immersive mode we only
  // reset when the hunk has truly disappeared from the diff (e.g. after a
  // refresh removed it). The non-immersive panel only ever renders
  // `filteredHunks`, so it keeps the original auto-advance to a visible hunk.
  useEffect(() => {
    if (filteredHunks.length === 0) return;

    // Picking the validity list up front keeps the immersive and non-immersive
    // behavior in lockstep — the only difference is which list we accept the
    // current selection against.
    const validityList = isImmersive ? hunks : filteredHunks;
    const selectionValid = selectedHunkId && validityList.some((h) => h.id === selectedHunkId);
    if (!selectionValid) {
      setSelectedHunkId(filteredHunks[0].id);
    }
  }, [filteredHunks, hunks, isImmersive, selectedHunkId, setSelectedHunkId]);

  // Memoize search config to prevent re-creating object on every render
  // This allows React.memo on HunkViewer to work properly
  const searchConfig = useMemo(
    () =>
      debouncedSearchTerm
        ? {
            searchTerm: debouncedSearchTerm,
            useRegex: searchState.useRegex,
            matchCase: searchState.matchCase,
          }
        : undefined,
    [debouncedSearchTerm, searchState.useRegex, searchState.matchCase]
  );

  // Handle toggling read state with auto-navigation
  // Uses refs to keep callback stable across state changes - prevents HunkViewer re-renders
  const handleToggleRead = useCallback(
    (hunkId: string) => {
      const wasRead = isReadRef.current(hunkId);
      toggleRead(hunkId);

      // If toggling the selected hunk, check if it will still be visible after toggle
      if (hunkId === selectedHunkIdRef.current) {
        // Hunk is visible if: showReadHunks is on OR it will be unread after toggle
        const willBeVisible = showReadHunksRef.current || wasRead;

        if (!willBeVisible) {
          // Use ref to get current filtered/sorted list for navigation
          setSelectedHunkId(findNextHunkId(filteredHunksRef.current, hunkId));
        }
      }
    },
    [toggleRead, setSelectedHunkId]
  );

  // Handle marking hunk as read with auto-navigation
  // Uses refs to keep callback stable across state changes - prevents HunkViewer re-renders
  const handleMarkAsRead = useCallback(
    (hunkId: string) => {
      const wasRead = isReadRef.current(hunkId);
      markAsRead(hunkId);

      // If marking the selected hunk as read and it will be filtered out, navigate
      if (hunkId === selectedHunkIdRef.current && !wasRead && !showReadHunksRef.current) {
        // Use ref to get current filtered/sorted list for navigation
        setSelectedHunkId(findNextHunkId(filteredHunksRef.current, hunkId));
      }
    },
    [markAsRead, setSelectedHunkId]
  );

  // Handle marking hunk as unread (no navigation needed - unread hunks are always visible)
  const handleMarkAsUnread = useCallback(
    (hunkId: string) => {
      markAsUnread(hunkId);
    },
    [markAsUnread]
  );

  // Stable callbacks for HunkViewer (single callback shared across all hunks)
  const handleHunkClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) setSelectedHunkId(hunkId);
    },
    [setSelectedHunkId]
  );

  const handleHunkToggleRead = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) handleToggleRead(hunkId);
    },
    [handleToggleRead]
  );

  const handleRegisterToggleExpand = useCallback((hunkId: string, toggleFn: () => void) => {
    toggleExpandFnsRef.current.set(hunkId, toggleFn);
  }, []);

  // Handle marking all hunks in a file as read
  const handleMarkFileAsRead = useCallback(
    (hunkId: string) => {
      // Find the hunk to determine its file path
      const hunk = hunks.find((h) => h.id === hunkId);
      if (!hunk) return;

      // Find all hunks in the same file
      const fileHunkIds = hunks.filter((h) => h.filePath === hunk.filePath).map((h) => h.id);

      markAsRead(fileHunkIds);

      // If marking the selected hunk's file as read and hunks will be filtered out, navigate.
      // Consult the *effective* show-read flag via `showReadHunksRef` so this stays in sync
      // with Assisted mode (which uses `assistedShowReadHunks`). Reading `filters.showReadHunks`
      // directly meant that marking a file read in Assisted mode left the selection on a now-
      // hidden hunk, breaking subsequent keyboard navigation when `currentIndex` became -1.
      if (hunkId === selectedHunkIdRef.current && !showReadHunksRef.current) {
        // Use ref to get current filtered/sorted list, then find next hunk not in same file
        setSelectedHunkId(
          findNextHunkIdAfterFileRemoval(filteredHunksRef.current, hunkId, hunk.filePath)
        );
      }
    },
    [hunks, markAsRead, setSelectedHunkId]
  );

  // Count agent-flagged hunks the user hasn't acked. The panel still reports
  // it for local stats, while the always-mounted reporter below is the tab
  // badge source when this panel is not selected. Both use the same helper so
  // assisted filters that don't intersect the current diff aren't counted.
  const unreadAssistedCount = useMemo(
    () => countUnreadAssistedHunks(hunks, normalizedAssistedHunks, isRead, reviewPathContext),
    [hunks, normalizedAssistedHunks, isRead, reviewPathContext]
  );

  // Calculate stats from the same precomputed read summaries so read toggles do one pass.
  const stats = useMemo(() => {
    const total = hunks.length;
    return {
      total,
      read: readHunkCount,
      unread: total - readHunkCount,
      unreadAssisted: unreadAssistedCount,
    };
  }, [hunks.length, readHunkCount, unreadAssistedCount]);

  // Report stats to parent for tab badge
  useEffect(() => {
    onStatsChange?.({
      total: stats.total,
      read: stats.read,
      unreadAssisted: stats.unreadAssisted,
    });
  }, [stats.total, stats.read, stats.unreadAssisted, onStatsChange]);

  // Scroll selected hunk into view
  useEffect(() => {
    if (!selectedHunkId) return;

    // Find the hunk container element by data attribute
    const hunkElement = document.querySelector(`[data-hunk-id="${selectedHunkId}"]`);
    if (hunkElement) {
      hunkElement.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [selectedHunkId]);

  // Keyboard navigation (j/k or arrow keys) - only when panel is focused
  useEffect(() => {
    if (!isPanelFocused) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with text input in chat or other editable elements
      if (isEditableElement(e.target)) return;

      // Immersive mode has its own keyboard handler; don't double-handle
      if (isImmersive) return;

      // The Assisted-toggle shortcut must work even in empty states (no
      // selected hunk, or selection filtered out by the active set of
      // pins). Handle it BEFORE the selection-required guards below so
      // the escape hatch advertised in the empty-state UI ("press p")
      // actually fires.
      if (matchesKeybind(e, KEYBINDS.TOGGLE_ASSISTED_REVIEW)) {
        // Skip the keystroke only when nothing assisted is reachable: no
        // live pins and no currently-active worklist mode. Otherwise we
        // toggle so the user can leave Assisted even when its set just
        // emptied.
        if (assistedHunks.length === 0 && !filters.assistedOnly) {
          return;
        }
        e.preventDefault();
        setFilters((prev) => ({ ...prev, assistedOnly: !prev.assistedOnly }));
        return;
      }

      if (!selectedHunkId) return;

      const currentIndex = filteredHunks.findIndex((h) => h.id === selectedHunkId);
      if (currentIndex === -1) return;

      // Navigation
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (currentIndex < filteredHunks.length - 1) {
          setSelectedHunkId(filteredHunks[currentIndex + 1].id);
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (currentIndex > 0) {
          setSelectedHunkId(filteredHunks[currentIndex - 1].id);
        }
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_READ)) {
        // Toggle read state of selected hunk
        e.preventDefault();
        handleToggleRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_HUNK_READ)) {
        // Mark selected hunk as read
        e.preventDefault();
        handleMarkAsRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_HUNK_UNREAD)) {
        // Mark selected hunk as unread
        e.preventDefault();
        handleMarkAsUnread(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.MARK_FILE_READ)) {
        // Mark entire file (all hunks) as read
        e.preventDefault();
        handleMarkFileAsRead(selectedHunkId);
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_COLLAPSE)) {
        // Toggle expand/collapse state of selected hunk
        e.preventDefault();
        const toggleFn = toggleExpandFnsRef.current.get(selectedHunkId);
        if (toggleFn) {
          toggleFn();
        }
      }
      // Note: TOGGLE_ASSISTED_REVIEW is handled above the selection guards so
      // it works in empty-state cases (no selected hunk, all pins filtered).
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPanelFocused,
    selectedHunkId,
    setSelectedHunkId,
    filteredHunks,
    handleToggleRead,
    handleMarkAsRead,
    handleMarkAsUnread,
    assistedHunks.length,
    filters.assistedOnly,
    setFilters,
    handleMarkFileAsRead,
    isImmersive,
  ]);

  // Global keyboard shortcuts (refresh/search)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.REFRESH_REVIEW)) {
        e.preventDefault();
        controllerRef.current?.requestImmediate();
      } else if (matchesKeybind(e, KEYBINDS.FOCUS_REVIEW_SEARCH)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (matchesKeybind(e, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const isNonGitWorkspace =
    diffState.status === "error" &&
    (/not a git repository\b/i.test(diffState.message) ||
      /repository not found\b/i.test(diffState.message));
  // Show loading state while workspace is being created
  if (isCreating) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <Loader2 aria-hidden="true" className="text-secondary mb-4 h-6 w-6 animate-spin" />
        <p className="text-secondary text-sm">Setting up workspace...</p>
        <p className="text-secondary mt-1 text-xs">Review will be available once ready</p>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      data-testid="review-panel"
      onFocus={() => setIsPanelFocused(true)}
      onBlur={() => setIsPanelFocused(false)}
      className="bg-surface-primary [container-type:inline-size] flex h-full min-h-0 flex-col outline-none [container-name:review-panel]"
    >
      {/* Always show controls so user can change diff base */}
      <ReviewControls
        filters={filters}
        stats={stats}
        onFiltersChange={setFilters}
        onDiffBaseInteraction={handleDiffBaseInteraction}
        onRefresh={handleRefresh}
        isLoading={
          diffState.status === "loading" || diffState.status === "refreshing" || isLoadingTree
        }
        isRefreshBlocked={isRefreshBlocked}
        isImmersive={isImmersive}
        onToggleImmersive={toggleImmersive}
        projectPath={projectPath}
        lastRefreshInfo={lastRefreshInfo}
        lastRefreshFailure={lastRefreshFailure}
        assistedCount={assistedHunks.length}
        assistedUnreadCount={unreadAssistedInDiff}
      />

      {diffState.status === "error" ? (
        isNonGitWorkspace ? (
          <div className="text-muted flex flex-col items-center justify-start gap-3 px-6 pt-12 pb-6 text-center">
            <div className="text-foreground text-base font-medium">Not a git repository</div>
            <div className="text-[13px] leading-[1.5]">
              This project is not a git repository, so changes {"can't"} be computed.
            </div>
          </div>
        ) : (
          <div className="text-danger-soft bg-danger-soft/10 border-danger-soft/30 font-monospace m-3 rounded border p-6 text-xs leading-[1.5] break-words whitespace-pre-wrap">
            {diffState.message}
            {/* Show helpful hint when ref doesn't exist */}
            {diffState.message.includes("unknown revision") && (
              <div className="text-muted mt-3 flex items-start gap-2 border-t border-current/20 pt-3 font-sans text-[11px]">
                <Lightbulb aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  The ref <code className="text-foreground">{filters.diffBase}</code> does not exist
                  in this repository. Use the dropdown above to select a different base (e.g., HEAD,
                  origin/master).
                </span>
              </div>
            )}
          </div>
        )
      ) : diffState.status === "loading" ? (
        <div className="text-muted flex h-full items-center justify-center text-sm">
          Loading diff...
        </div>
      ) : !isImmersive ? (
        // Immersive review renders into its own overlay, so skip the regular review DOM
        // while it's active to avoid rerendering the hidden file tree and hunk list.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {diffState.truncationWarning && (
            <div className="bg-warning/10 border-warning/30 text-warning mx-3 my-3 flex items-center gap-1.5 rounded border px-3 py-1.5 text-[10px] leading-[1.3]">
              <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span>{diffState.truncationWarning}</span>
            </div>
          )}

          {/* Search bar - always visible at top, not sticky */}
          <div className="border-border-light flex items-center gap-1.5 border-b px-2 py-1">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={`Search... (${formatKeybind(KEYBINDS.FOCUS_REVIEW_SEARCH)}, ${formatKeybind(KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)})`}
              value={searchState.input}
              onChange={(e) => setSearchState({ ...searchState, input: e.target.value })}
              className="bg-dark text-foreground border-border-medium placeholder:text-dim hover:border-accent focus:border-accent min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-[border-color] duration-150 focus:outline-none"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                    searchState.useRegex ? "text-accent-light" : "text-muted hover:text-foreground"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, useRegex: !searchState.useRegex })
                  }
                >
                  .*
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {searchState.useRegex ? "Using regex search" : "Using substring search"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                    searchState.matchCase ? "text-accent-light" : "text-muted hover:text-foreground"
                  )}
                  onClick={() =>
                    setSearchState({ ...searchState, matchCase: !searchState.matchCase })
                  }
                >
                  Aa
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {searchState.matchCase
                  ? "Match case (case-sensitive)"
                  : "Ignore case (case-insensitive)"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Single scrollable area containing both file tree and hunks */}
          <div ref={scrollContainerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* FileTree at the top. Immersive review keeps the sidebar mounted but inert,
                so skip hidden read-status work until the user exits. */}
            {(fileTree ?? isLoadingTree) && (
              <div className="border-border-light flex w-full flex-[0_0_auto] flex-col overflow-hidden border-b">
                <FileTree
                  root={fileTree}
                  selectedPath={selectedFilePath}
                  onSelectFile={setSelectedFilePath}
                  isLoading={isLoadingTree}
                  getFileReadStatus={isImmersive ? undefined : getFileReadStatus}
                  workspaceId={workspaceId}
                />
              </div>
            )}

            {/* Untracked files banner - shown above hunks */}
            <UntrackedStatus
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              refreshTrigger={refreshTrigger}
              onRefresh={handleRefresh}
            />

            {/* Hunks below the file tree */}
            <div className="flex flex-[0_0_auto] flex-col p-3">
              {planOrphanReviews.length > 0 && (
                <div className="border-border-light mb-2 border-b pb-2">
                  <div className="text-muted mb-1 px-2 text-[10px] font-medium tracking-wider uppercase">
                    Plan annotations
                  </div>
                  <div className="flex flex-col gap-1">
                    {planOrphanReviews.map((review) => (
                      <InlineReviewNote
                        key={review.id}
                        review={review}
                        showFilePath={false}
                        actions={reviewActions}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Assisted-mode mode banner. Surfaces the worklist status above
                  the hunk list so the user always has a glanceable cue and a
                  one-click exit from the focused view. Only renders when the
                  user is actually in Assisted mode AND there are pins to
                  describe — keeps the panel quiet during normal review. */}
              {filters.assistedOnly && assistedHunks.length > 0 && (
                <div
                  className="border-review-accent/40 bg-review-accent/5 text-foreground mb-2 flex items-start gap-2 rounded border px-2 py-1.5 text-[11px] leading-[1.4]"
                  data-testid="assisted-mode-banner"
                  role="status"
                  aria-live="polite"
                >
                  <Sparkles
                    aria-hidden="true"
                    className="text-review-accent mt-[2px] h-3 w-3 shrink-0"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-1">
                      <span className="text-foreground font-medium">Assisted review</span>
                      {assistedMatchByHunkId.size === 0 ? (
                        <span className="text-muted">
                          · {assistedHunks.length} agent pin
                          {assistedHunks.length === 1 ? "" : "s"} — none match the current diff
                        </span>
                      ) : unreadAssistedInDiff === 0 ? (
                        <span className="text-muted">
                          · all caught up ({assistedMatchByHunkId.size} read)
                        </span>
                      ) : (
                        <span className="text-muted">
                          · {unreadAssistedInDiff} of {assistedMatchByHunkId.size} unread
                        </span>
                      )}
                    </div>
                    <div className="text-muted flex flex-wrap items-center gap-3 text-[10px]">
                      <button
                        type="button"
                        onClick={() => setFilters((prev) => ({ ...prev, assistedOnly: false }))}
                        className="hover:text-foreground cursor-pointer border-none bg-transparent p-0 underline-offset-2 transition-colors hover:underline"
                        data-testid="assisted-mode-banner-exit"
                      >
                        Exit Assisted ({formatKeybind(KEYBINDS.TOGGLE_ASSISTED_REVIEW)})
                      </button>
                      {!filters.assistedShowReadHunks && unreadAssistedInDiff === 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setFilters((prev) => ({
                              ...prev,
                              assistedShowReadHunks: true,
                            }))
                          }
                          className="hover:text-foreground cursor-pointer border-none bg-transparent p-0 underline-offset-2 transition-colors hover:underline"
                        >
                          Show read pins
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {hunks.length === 0 ? (
                <div className="text-muted flex flex-col items-center justify-start gap-3 px-6 pt-12 pb-6 text-center">
                  <div className="text-foreground text-base font-medium">No changes found</div>
                  <div className="text-[13px] leading-[1.5]">
                    No changes found for the selected diff base.
                    <br />
                    Try selecting a different base or make some changes.
                  </div>
                  {diagnosticInfo && (
                    <details className="bg-modal-bg border-border-light [&_summary]:text-muted mt-4 w-full max-w-96 cursor-pointer rounded border p-3 [&_summary]:flex [&_summary]:list-none [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:text-xs [&_summary]:font-medium [&_summary]:select-none [&_summary::-webkit-details-marker]:hidden [&_summary::before]:text-[10px] [&_summary::before]:transition-transform [&_summary::before]:duration-200 [&_summary::before]:content-['▶'] [&[open]_summary::before]:rotate-90">
                      <summary>Show diagnostic info</summary>
                      <div className="font-monospace text-foreground mt-3 text-[11px] leading-[1.6]">
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Command:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.command}
                          </div>
                        </div>
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Output size:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.outputLength.toLocaleString()} bytes
                          </div>
                        </div>
                        <div className="[&:not(:last-child)]:border-border-light grid grid-cols-[140px_1fr] gap-3 py-1 [&:not(:last-child)]:border-b">
                          <div className="text-muted font-medium">Files parsed:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.fileDiffCount}
                          </div>
                        </div>
                        <div className="grid grid-cols-[140px_1fr] gap-3 py-1">
                          <div className="text-muted font-medium">Hunks extracted:</div>
                          <div className="text-foreground break-all select-all">
                            {diagnosticInfo.hunkCount}
                          </div>
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              ) : filteredHunks.length === 0 ? (
                <div className="text-muted flex flex-col items-center justify-start gap-3 px-6 pt-12 pb-6 text-center">
                  <div className="text-[13px] leading-[1.5]">
                    {filters.assistedOnly
                      ? assistedHunks.length === 0
                        ? "The agent hasn't pinned any hunks."
                        : assistedMatchByHunkId.size === 0
                          ? "None of the agent-flagged hunks match the current diff. The branch may have moved since the agent flagged them."
                          : debouncedSearchTerm.trim()
                            ? // Search-driven empty state takes precedence over
                              // the read-state copy: claiming "all read" when
                              // the user simply has unmatched search terms is
                              // confusing (they'd flip Read and still see
                              // nothing). Point them at clearing the search.
                              `No agent-flagged hunks match "${debouncedSearchTerm}". Clear the search or try a different term.`
                            : unreadAssistedInDiff === 0
                              ? "You've read every agent-flagged hunk. Toggle Read to see them again, or exit Assisted to keep reviewing the rest of the diff."
                              : "All agent-flagged hunks in this diff are read. Toggle Read or exit Assisted to see more."
                      : debouncedSearchTerm.trim()
                        ? `No hunks match "${debouncedSearchTerm}". Try a different search term.`
                        : selectedFilePath
                          ? `No hunks in ${selectedFilePath}. Try selecting a different file.`
                          : "No hunks match the current filters. Try adjusting your filter settings."}
                  </div>
                  {filters.assistedOnly && (
                    <div className="flex flex-wrap items-center justify-center gap-2 text-[11px]">
                      {/* Most likely escape hatches for the assisted-only empty
                          state. Keep them inline rather than only in the
                          control bar so the user doesn't have to scroll back
                          up to recover. */}
                      <button
                        type="button"
                        onClick={() => setFilters((prev) => ({ ...prev, assistedOnly: false }))}
                        className="border-border-light hover:bg-hover hover:text-foreground rounded border bg-transparent px-2 py-0.5 transition-colors"
                        data-testid="review-assisted-empty-exit"
                      >
                        Exit Assisted
                      </button>
                      {assistedHunks.length > 0 && !filters.assistedShowReadHunks && (
                        <button
                          type="button"
                          onClick={() =>
                            setFilters((prev) => ({ ...prev, assistedShowReadHunks: true }))
                          }
                          className="border-border-light hover:bg-hover hover:text-foreground rounded border bg-transparent px-2 py-0.5 transition-colors"
                          data-testid="review-assisted-empty-show-read"
                        >
                          Show read pins
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                filteredHunks.map((hunk) => {
                  const isSelected = hunk.id === selectedHunkId;
                  const hunkIsRead = isRead(hunk.id);
                  // Default to now for hunks without first-seen (e.g., old mux versions)
                  const hunkFirstSeenAt = firstSeenMap[hunk.id] ?? Date.now();

                  return (
                    <HunkViewer
                      key={hunk.id}
                      hunk={hunk}
                      hunkId={hunk.id}
                      workspaceId={workspaceId}
                      inlineReviews={reviewsByFilePath.get(hunk.filePath)}
                      isSelected={isSelected}
                      isRead={hunkIsRead}
                      firstSeenAt={hunkFirstSeenAt}
                      onClick={handleHunkClick}
                      onToggleRead={handleHunkToggleRead}
                      onRegisterToggleExpand={handleRegisterToggleExpand}
                      onReviewNote={onReviewNote}
                      searchConfig={searchConfig}
                      onComposingChange={handleHunkComposingChange}
                      diffBase={filters.diffBase}
                      includeUncommitted={filters.includeUncommitted}
                      preferCollapsed={preferCollapsedHunks}
                      reviewActions={reviewActions}
                      assistedComment={assistedCommentByHunkId.get(hunk.id)}
                      isAssisted={assistedMatchByHunkId.has(hunk.id)}
                      isAssistedNew={assistedNewByHunkId.has(hunk.id)}
                      visibleNewLineRange={assistedRangeByHunkId.get(hunk.id)}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Immersive review mode: render into workspace overlay */}
      {isImmersive &&
        (() => {
          const root =
            typeof document !== "undefined"
              ? document.getElementById("review-immersive-root")
              : null;
          if (!root) return null;
          return createPortal(
            <ImmersiveReviewView
              workspaceId={workspaceId}
              fileTree={fileTree}
              hunks={filteredHunks}
              allHunks={hunks}
              isLoading={diffState.status === "loading" || isLoadingTree}
              isRead={isRead}
              onToggleRead={handleToggleRead}
              onMarkFileAsRead={handleMarkFileAsRead}
              selectedHunkId={selectedHunkId}
              onSelectHunk={setSelectedHunkId}
              onExit={toggleImmersive}
              isTouchImmersive={isTouchImmersive}
              onReviewNote={onReviewNote}
              reviewActions={reviewActions}
              reviewsByFilePath={reviewsByFilePath}
              firstSeenMap={firstSeenMap}
              assistedHunkIds={assistedHunkIdSet}
              assistedCommentByHunkId={assistedCommentByHunkId}
              assistedOnly={filters.assistedOnly}
              assistedCount={assistedHunks.length}
              assistedUnreadCount={unreadAssistedInDiff}
              isMultiProjectWorkspace={(workspaceReviewMetadata?.projects?.length ?? 0) > 1}
            />,
            root
          );
        })()}
    </div>
  );
};
