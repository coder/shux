/**
 * ImmersiveReviewView — Full-screen, keyboard-first code review mode.
 * Rendered via portal into #review-immersive-root overlay.
 * Shows one file at a time with keyboard navigation for files, hunks, and lines.
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  MessageSquare,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SelectableDiffRenderer } from "../../Shared/DiffRenderer";
import { ImmersiveDiffRevealLoadingState } from "./ImmersiveDiffRevealLoadingState";
import { ImmersiveMinimap } from "./ImmersiveMinimap";
import { ImmersiveReviewAgentStatusBar } from "./ImmersiveReviewAgentStatusBar";
import {
  buildFileHunksContentVersion,
  useImmersiveOverlay,
  type HunkLineRange,
  type ImmersiveOverlayData,
} from "./useImmersiveOverlay";
import {
  buildNewLineNumberToIndexMap,
  buildOldLineNumberToIndexMap,
  parseDiffLines,
} from "./immersiveMinimapMath";
import { KeycapGroup } from "@/browser/components/Keycap/Keycap";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { useAPI } from "@/browser/contexts/API";
import { formatLineRangeCompact } from "@/browser/utils/review/lineRange";
import {
  findAdjacentFileHunkId,
  findNextHunkId,
  findNextHunkIdAfterFileRemoval,
  flattenFileTreeLeaves,
  getFileHunks,
  sortHunksInFileOrder,
} from "@/browser/utils/review/navigation";
import {
  formatKeybind,
  isDialogOpen,
  isEditableElement,
  isDesktopViewportFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  buildReadFileScript,
  decodeBase64Utf8,
  EXIT_CODE_TOO_LARGE,
  MAX_COPY_FILE_SIZE_BYTES,
  processFileContents,
} from "@/browser/utils/fileRead";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { getReviewSelectedHunkKey } from "@/common/constants/storage";
import {
  parseReviewLineRange,
  type DiffHunk,
  type Review,
  type ReviewNoteData,
} from "@/common/types/review";
import type { FileStats, FileTreeNode } from "@/common/utils/git/numstatParser";
import type { ReviewActionCallbacks } from "../../Shared/InlineReviewNote";

interface ImmersiveReviewViewProps {
  workspaceId: string;
  fileTree: FileTreeNode | null;
  /** Filtered hunks (respects current filters) */
  hunks: DiffHunk[];
  /** All hunks for the active file set (bypasses frontend filters like read/search) */
  allHunks: DiffHunk[];
  /** True while diff/tree payload for this workspace is still loading. */
  isLoading?: boolean;
  isRead: (hunkId: string) => boolean;
  onToggleRead: (hunkId: string) => void;
  onMarkFileAsRead: (hunkId: string) => void;
  selectedHunkId: string | null;
  onSelectHunk: (hunkId: string | null) => void;
  /** Whether immersive review should use touch/mobile UX affordances. */
  isTouchImmersive?: boolean;
  onExit: () => void;
  onReviewNote?: (data: ReviewNoteData) => void;
  reviewActions?: ReviewActionCallbacks;
  reviewsByFilePath: Map<string, Review[]>;
  /** Map of hunkId -> first-seen timestamp */
  firstSeenMap: Record<string, number>;
  /**
   * Set of hunkIds the agent flagged for review (via `review_pane_update`).
   * When the selected hunk is in this set, the header surfaces an "Assisted"
   * indicator so the agent's focus signal survives the immersive transition.
   */
  assistedHunkIds?: ReadonlySet<string>;
  /**
   * Per-hunkId agent comments, when available. Rendered next to the assisted
   * indicator so the user gets the same "why was this flagged?" context they
   * see in the side panel.
   */
  assistedCommentByHunkId?: Map<string, string>;
  /**
   * Whether the "Assisted" filter (show only agent-flagged hunks) is active.
   * The control bar that hosts this toggle is hidden behind the immersive
   * overlay, so we surface a header badge to keep the active filter mode
   * visible. Distinct from the per-hunk assisted banner: this means "the
   * worklist filter is on", not "this hunk was flagged".
   */
  assistedOnly?: boolean;
  /** Total agent-flagged hunks (mirrors the control bar's Assisted count). */
  assistedCount?: number;
  /** Agent-flagged hunks still unread (mirrors the control bar's count). */
  assistedUnreadCount?: number;
  /**
   * Multi-project workspaces reproject hunk paths onto the shared container root,
   * which is default script mode's cwd; single-project (incl. subproject) workspaces
   * keep repo-root-relative paths and need repo-root execution for file reads.
   */
  isMultiProjectWorkspace?: boolean;
}

interface InlineComposerRequest {
  requestId: number;
  prefill: string;
  hunkId: string;
  /** Absolute overlay indices so composer placement stays locked to marked rows. */
  startIndex: number;
  endIndex: number;
  /** Absolute overlay index for composer placement (cursor position). */
  cursorIndex: number;
}

interface InlineReviewEditRequest {
  requestId: number;
  reviewId: string;
}

interface SelectedLineRange {
  startIndex: number;
  endIndex: number;
}

interface PendingComposerHunkSwitch {
  fromHunkId: string | null;
  toHunkId: string;
}

const LINE_JUMP_SIZE = 10;
const ACTIVE_LINE_OUTLINE = "1px solid hsl(from var(--color-review-accent) h s l / 0.45)";
const HUNK_RANGE_OUTLINE_COLOR = "hsl(from var(--color-review-accent) h s l / 0.45)";
const LIKE_NOTE_PREFIX = "I like this change";
const DISLIKE_NOTE_PREFIX = "I don't like this change";
const EMPTY_REVIEWS: Review[] = [];
const EMPTY_COMMENT_LINE_INDICES = new Set<number>();

function getFileBaseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

function getChangedLineCount(hunk: DiffHunk): number {
  // Reuse the shared diff-line parser so completion weighting matches the minimap's
  // notion of which rows are actual changes instead of ad-hoc string checks here.
  return parseDiffLines(hunk.content).reduce((count, lineCategory) => {
    return lineCategory === "context" ? count : count + 1;
  }, 0);
}

function getReviewStatusSidebarClasses(status: Review["status"]): {
  accent: string;
  badge: string;
  icon: string;
} {
  if (status === "checked") {
    return {
      accent: "bg-success",
      badge: "bg-success/20 text-success",
      icon: "text-success",
    };
  }

  if (status === "attached") {
    return {
      accent: "bg-warning",
      badge: "bg-warning/20 text-warning",
      icon: "text-warning",
    };
  }

  return {
    accent: "bg-muted",
    badge: "bg-muted/25 text-muted",
    icon: "text-muted",
  };
}

function isSelectionInsideRange(selection: SelectedLineRange, range: HunkLineRange): boolean {
  const start = Math.min(selection.startIndex, selection.endIndex);
  const end = Math.max(selection.startIndex, selection.endIndex);
  return start >= range.startIndex && end <= range.endIndex;
}

function isLineInsideSelection(lineIndex: number, selection: SelectedLineRange): boolean {
  const start = Math.min(selection.startIndex, selection.endIndex);
  const end = Math.max(selection.startIndex, selection.endIndex);
  return lineIndex >= start && lineIndex <= end;
}

export function shouldPreserveImmersiveContextCursor(input: {
  cursorLineIndex: number | null;
  previousRange: { startIndex: number; endIndex: number } | null;
  previousHunkId: string | null;
  currentHunkId: string | null;
  previousOverlayContent: string | null;
  currentOverlayContent: string;
}): boolean {
  if (
    input.cursorLineIndex === null ||
    !input.previousRange ||
    input.previousHunkId !== input.currentHunkId ||
    input.previousOverlayContent !== input.currentOverlayContent
  ) {
    return false;
  }

  return (
    input.cursorLineIndex < input.previousRange.startIndex ||
    input.cursorLineIndex > input.previousRange.endIndex
  );
}

/** Find the numstat entry for a file leaf; carries change status even for hunk-less files. */
function findFileTreeStats(node: FileTreeNode | null, filePath: string): FileStats | undefined {
  if (!node) {
    return undefined;
  }
  if (!node.isDirectory && node.path === filePath) {
    return node.stats;
  }
  for (const child of node.children) {
    const found = findFileTreeStats(child, filePath);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Resolve the hunk that contains a given overlay line index using the lineHunkIds lookup. */
function findHunkAtLine(
  lineIndex: number,
  overlayData: ImmersiveOverlayData,
  fileHunks: DiffHunk[]
): { hunk: DiffHunk; range: HunkLineRange } | null {
  const hunkId = overlayData.lineHunkIds[lineIndex];
  if (!hunkId) {
    return null;
  }
  const hunk = fileHunks.find((h) => h.id === hunkId);
  const range = overlayData.hunkLineRanges.get(hunkId);
  if (!hunk || !range) {
    return null;
  }
  return { hunk, range };
}

function getLineSpan(start: number, lineCount: number): { start: number; end: number } | null {
  if (lineCount <= 0) {
    return null;
  }

  return {
    start,
    end: start + lineCount - 1,
  };
}

function rangesOverlap(
  lhs: { start: number; end: number } | undefined,
  rhs: { start: number; end: number } | null
): boolean {
  if (!lhs || !rhs) {
    return false;
  }

  return lhs.start <= rhs.end && rhs.start <= lhs.end;
}

function findReviewHunkId(review: Review, fileHunks: DiffHunk[]): string | null {
  const parsedRange = parseReviewLineRange(review.data.lineRange);
  if (!parsedRange) {
    return null;
  }

  const matchingHunk = fileHunks.find((hunk) => {
    const oldSpan = getLineSpan(hunk.oldStart, hunk.oldLines);
    const newSpan = getLineSpan(hunk.newStart, hunk.newLines);

    return rangesOverlap(parsedRange.old, oldSpan) || rangesOverlap(parsedRange.new, newSpan);
  });

  return matchingHunk?.id ?? null;
}

export const ImmersiveReviewView: React.FC<ImmersiveReviewViewProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const notesSidebarRef = useRef<HTMLDivElement>(null);
  const hunkJumpScrollBlockRef = useRef<ScrollLogicalPosition>("center");
  const hunkJumpRef = useRef(false);
  const pendingJumpSelectAllHunkIdRef = useRef<string | null>(null);
  const { api } = useAPI();
  const { theme } = useTheme();

  const {
    fileTree,
    hunks,
    allHunks,
    selectedHunkId: externalSelectedHunkId,
    onSelectHunk: commitSelectedHunk,
    onToggleRead,
    onMarkFileAsRead,
    onExit: commitExit,
    onReviewNote,
    isRead,
    isTouchImmersive,
    assistedHunkIds,
    assistedCommentByHunkId,
  } = props;
  const selectedHunkStorageKey = getReviewSelectedHunkKey(props.workspaceId);
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(externalSelectedHunkId);
  const externalSelectedHunkIdRef = useRef<string | null>(externalSelectedHunkId);
  const ignoredExternalSelectionEchoRef = useRef<string | null>(null);
  useEffect(() => {
    externalSelectedHunkIdRef.current = externalSelectedHunkId;
    if (ignoredExternalSelectionEchoRef.current === externalSelectedHunkId) {
      ignoredExternalSelectionEchoRef.current = null;
      return;
    }

    setSelectedHunkId(externalSelectedHunkId);
  }, [externalSelectedHunkId]);
  const onSelectHunk = useCallback((hunkId: string | null) => {
    setSelectedHunkId(hunkId);
  }, []);
  const onExit = useCallback(() => {
    commitSelectedHunk(selectedHunkId);
    commitExit();
  }, [commitExit, commitSelectedHunk, selectedHunkId]);

  const selectedAssistedComment =
    selectedHunkId !== null ? (assistedCommentByHunkId?.get(selectedHunkId) ?? null) : null;
  const isSelectedAssisted =
    selectedHunkId !== null && (assistedHunkIds?.has(selectedHunkId) ?? false);
  const selectedAssistedLabel = selectedAssistedComment ?? "Flagged by agent for review";
  const isTouchExperience = isTouchImmersive === true;

  // Flatten file tree into ordered file list
  const fileList = useMemo(() => flattenFileTreeLeaves(fileTree), [fileTree]);
  const reviewProgress = useMemo(() => {
    // Cursor movement should stay lightweight even in large diff-heavy files, so memoize
    // the per-hunk diff parsing instead of rescanning every hunk on each immersive render.
    let reviewedHunkCount = 0;
    let totalChangedLineCount = 0;
    let reviewedChangedLineCount = 0;

    for (const hunk of allHunks) {
      const changedLineCount = getChangedLineCount(hunk);
      totalChangedLineCount += changedLineCount;
      if (isRead(hunk.id)) {
        reviewedHunkCount += 1;
        reviewedChangedLineCount += changedLineCount;
      }
    }

    return {
      reviewedHunkCount,
      totalChangedLineCount,
      reviewedChangedLineCount,
    };
  }, [allHunks, isRead]);
  const reviewedHunkCount = reviewProgress.reviewedHunkCount;
  const totalChangedLineCount = reviewProgress.totalChangedLineCount;
  const reviewedChangedLineCount = reviewProgress.reviewedChangedLineCount;
  const reviewCompletionWidthPercent =
    totalChangedLineCount === 0 ? 0 : (reviewedChangedLineCount / totalChangedLineCount) * 100;
  const reviewCompletionPercent = Math.round(reviewCompletionWidthPercent);
  const reviewCompletionSummary =
    totalChangedLineCount === 0
      ? "No changed lines to review"
      : `${reviewCompletionPercent}% of changed lines reviewed`;
  const reviewCompletionDetails =
    totalChangedLineCount === 0
      ? reviewCompletionSummary
      : `${reviewCompletionSummary} (${reviewedChangedLineCount}/${totalChangedLineCount})`;
  const reviewCompletionHunkDetails = `${reviewedHunkCount}/${allHunks.length} hunks marked read`;
  const isReviewComplete =
    allHunks.length > 0 && hunks.length === 0 && reviewedHunkCount === allHunks.length;
  const reviewedHunkLabel = `${reviewedHunkCount} ${reviewedHunkCount === 1 ? "hunk" : "hunks"}`;

  // When hide-read removes the last visible hunk, keep immersive review on an explicit
  // completion state instead of falling back to the first file's empty diff view.
  const activeFilePath = useMemo(() => {
    if (isReviewComplete) {
      return null;
    }

    if (selectedHunkId) {
      const selectedHunk =
        hunks.find((item) => item.id === selectedHunkId) ??
        allHunks.find((item) => item.id === selectedHunkId);
      if (selectedHunk) {
        return selectedHunk.filePath;
      }
    }

    // Fallback: first file that has currently visible hunks.
    if (hunks.length > 0) {
      return hunks[0].filePath;
    }

    if (fileList.length > 0) {
      return fileList[0];
    }

    return null;
  }, [selectedHunkId, hunks, allHunks, fileList, isReviewComplete]);

  const selectedHunkFromAll = useMemo(
    () => (selectedHunkId ? (allHunks.find((item) => item.id === selectedHunkId) ?? null) : null),
    [selectedHunkId, allHunks]
  );

  const selectedHunkIsFilteredOut = Boolean(
    selectedHunkFromAll && !hunks.some((item) => item.id === selectedHunkFromAll.id)
  );

  const activeFileHunks = selectedHunkIsFilteredOut ? allHunks : hunks;

  // Hunks for the active file only, always sorted in file order.
  // When the selected hunk is filtered out, keep using unfiltered hunks so
  // note-driven navigation can still land on the review context.
  const currentFileHunks = useMemo(
    () =>
      activeFilePath ? sortHunksInFileOrder(getFileHunks(activeFileHunks, activeFilePath)) : [],
    [activeFileHunks, activeFilePath]
  );

  // Version the cached full-file body by the active file's UNFILTERED diff content so it is
  // re-read when the file's diff actually changes (a tool edits it / the diff is refreshed)
  // but reused when a hunk is only filtered out by mark-read. `allHunks` is the complete
  // diff set for the workspace (read-state independent), so this stays stable across
  // marking hunks read while still busting on a real content change.
  const activeFileContentVersion = useMemo(
    () =>
      activeFilePath ? buildFileHunksContentVersion(getFileHunks(allHunks, activeFilePath)) : "",
    [allHunks, activeFilePath]
  );

  const selectedHunk = useMemo(() => {
    if (selectedHunkId) {
      const matchingHunk = currentFileHunks.find((hunk) => hunk.id === selectedHunkId);
      if (matchingHunk) {
        return matchingHunk;
      }
    }

    return currentFileHunks[0] ?? null;
  }, [selectedHunkId, currentFileHunks]);

  const selectedHunkRef = useRef<DiffHunk | null>(selectedHunk);
  useEffect(() => {
    selectedHunkRef.current = selectedHunk;
  }, [selectedHunk]);

  const shouldReserveAssistedBannerSlot =
    assistedHunkIds != null &&
    activeFilePath != null &&
    getFileHunks(allHunks, activeFilePath).some((hunk) => assistedHunkIds.has(hunk.id));

  // Ensure we always have a selected hunk when the active file has hunks.
  useEffect(() => {
    if (currentFileHunks.length === 0) {
      return;
    }

    if (!selectedHunkId || !currentFileHunks.some((hunk) => hunk.id === selectedHunkId)) {
      pendingJumpSelectAllHunkIdRef.current = null;
      onSelectHunk(currentFileHunks[0].id);
    }
  }, [currentFileHunks, selectedHunkId, onSelectHunk]);

  const setHunkJumpScroll = useCallback((block: ScrollLogicalPosition) => {
    hunkJumpRef.current = true;
    hunkJumpScrollBlockRef.current = block;
  }, []);

  const {
    overlayData,
    shouldEnableHighlighting,
    isActiveOverlayRevealPending,
    isActiveFileRevealPending,
    isActiveOverlayReadyForReveal,
    activeOverlayRevealIdentity,
    revealLoadingLabel,
    revealActiveOverlayNow,
    scheduleOverlayReveal,
    handleDiffHighlightSettledChange,
  } = useImmersiveOverlay({
    api,
    workspaceId: props.workspaceId,
    activeFilePath,
    currentFileHunks,
    selectedHunk,
    theme,
    fileContentVersion: activeFileContentVersion,
    isMultiProjectWorkspace: props.isMultiProjectWorkspace,
    onRevealPending: setHunkJumpScroll,
  });

  const selectedHunkRange = useMemo(
    () => (selectedHunk ? (overlayData.hunkLineRanges.get(selectedHunk.id) ?? null) : null),
    [selectedHunk, overlayData]
  );

  const selectedHunkLineCount = selectedHunkRange
    ? selectedHunkRange.endIndex - selectedHunkRange.startIndex + 1
    : 0;

  const allReviews = useMemo(
    () =>
      Array.from(props.reviewsByFilePath.values())
        .flat()
        .sort((a, b) => {
          const createdAtDelta = b.createdAt - a.createdAt;
          if (createdAtDelta !== 0) {
            return createdAtDelta;
          }

          return a.id.localeCompare(b.id);
        }),
    [props.reviewsByFilePath]
  );
  const activeFileReviews = useMemo(
    () =>
      activeFilePath
        ? (props.reviewsByFilePath.get(activeFilePath) ?? EMPTY_REVIEWS)
        : EMPTY_REVIEWS,
    [activeFilePath, props.reviewsByFilePath]
  );

  // Map review line ranges → diff line indices for minimap comment indicators.
  // Memoize the line-number lookups so cursor movement does not rebuild multi-thousand-line
  // maps when neither the rendered overlay nor the file's review set changed.
  const commentLineIndices = useMemo<ReadonlySet<number>>(() => {
    if (overlayData.content.length === 0 || activeFileReviews.length === 0) {
      return EMPTY_COMMENT_LINE_INDICES;
    }

    const newLineMap = buildNewLineNumberToIndexMap(overlayData.content);
    let oldLineMap: Map<number, number> | null = null;
    const indices = new Set<number>();
    for (const review of activeFileReviews) {
      const parsed = parseReviewLineRange(review.data.lineRange);
      if (!parsed) continue;

      let lineMap: Map<number, number>;
      let range: { start: number; end: number } | undefined;

      if (parsed.new) {
        lineMap = newLineMap;
        range = parsed.new;
      } else if (parsed.old) {
        oldLineMap ??= buildOldLineNumberToIndexMap(overlayData.content);
        lineMap = oldLineMap;
        range = parsed.old;
      } else {
        continue;
      }

      for (let ln = range.start; ln <= range.end; ln++) {
        const idx = lineMap.get(ln);
        if (idx != null) indices.add(idx);
      }
    }
    return indices;
  }, [activeFileReviews, overlayData.content]);

  const [inlineComposerRequest, setInlineComposerRequest] = useState<InlineComposerRequest | null>(
    null
  );
  const [inlineReviewEditRequest, setInlineReviewEditRequest] =
    useState<InlineReviewEditRequest | null>(null);
  const nextComposerRequestIdRef = useRef(0);
  const nextInlineReviewEditRequestIdRef = useRef(0);
  const pendingComposerHunkSwitchRef = useRef<PendingComposerHunkSwitch | null>(null);

  // Keyboard line cursor state within the whole rendered file.
  const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [minimapRedrawNonce, setMinimapRedrawNonce] = useState(0);
  const [boundaryToast, setBoundaryToast] = useState<string | null>(null);

  // Which panel has keyboard focus while in immersive mode.
  const [focusedPanel, setFocusedPanel] = useState<"diff" | "notes">("diff");
  const [focusedNoteIndex, setFocusedNoteIndex] = useState(0);

  // Keep an immersive-local stack of single-hunk read actions so U can step back through
  // hide-read auto-advance without changing the main review panel's unread shortcut semantics.
  const readUndoStackRef = useRef<string[]>([]);

  const selectedHunkRevealTargetLineIndex =
    selectedHunkRange?.firstModifiedIndex ?? selectedHunkRange?.startIndex ?? null;
  const revealTargetLineIndex = isActiveOverlayRevealPending
    ? selectedHunkRevealTargetLineIndex
    : (activeLineIndex ?? selectedHunkRevealTargetLineIndex);
  const hasResolvedSelectedHunkForReveal =
    selectedHunkId !== null && currentFileHunks.some((hunk) => hunk.id === selectedHunkId);

  useLayoutEffect(() => {
    if (!isActiveOverlayRevealPending || !activeOverlayRevealIdentity) {
      return;
    }

    // Fail open so the UI cannot get stuck if a file has no hunks.
    if (currentFileHunks.length === 0) {
      revealActiveOverlayNow();
      return;
    }

    // Avoid dropping the reveal gate while selected hunk state is still settling.
    if (!hasResolvedSelectedHunkForReveal) {
      return;
    }

    if (!isActiveOverlayReadyForReveal) {
      return;
    }

    // Fail open once selection is stable if we still cannot resolve a reveal target.
    if (selectedHunkRevealTargetLineIndex === null) {
      revealActiveOverlayNow();
    }
  }, [
    activeOverlayRevealIdentity,
    currentFileHunks.length,
    hasResolvedSelectedHunkForReveal,
    isActiveOverlayReadyForReveal,
    isActiveOverlayRevealPending,
    revealActiveOverlayNow,
    selectedHunkRevealTargetLineIndex,
  ]);

  useEffect(() => {
    if (!boundaryToast) return;
    const timer = setTimeout(() => setBoundaryToast(null), 2500);
    return () => clearTimeout(timer);
  }, [boundaryToast]);

  useEffect(() => {
    if (focusedNoteIndex < allReviews.length) {
      return;
    }

    setFocusedNoteIndex(Math.max(0, allReviews.length - 1));
  }, [allReviews.length, focusedNoteIndex]);

  useEffect(() => {
    if (focusedPanel !== "notes") {
      return;
    }

    const noteEl = notesSidebarRef.current?.querySelector<HTMLElement>(
      `[data-note-index="${focusedNoteIndex}"]`
    );
    noteEl?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [focusedPanel, focusedNoteIndex]);

  useEffect(() => {
    if (!inlineComposerRequest) {
      pendingComposerHunkSwitchRef.current = null;
      return;
    }

    if (selectedHunk?.id === inlineComposerRequest.hunkId) {
      pendingComposerHunkSwitchRef.current = null;
      return;
    }

    const pendingSwitch = pendingComposerHunkSwitchRef.current;
    const isAwaitingRequestedHunk =
      pendingSwitch?.toHunkId === inlineComposerRequest.hunkId &&
      (selectedHunkId === pendingSwitch.fromHunkId || selectedHunkId === null);

    if (isAwaitingRequestedHunk) {
      const requestedHunkStillExists = currentFileHunks.some(
        (hunk) => hunk.id === inlineComposerRequest.hunkId
      );
      if (requestedHunkStillExists) {
        return;
      }
    }

    pendingComposerHunkSwitchRef.current = null;
    setInlineComposerRequest(null);
  }, [currentFileHunks, inlineComposerRequest, selectedHunk, selectedHunkId]);

  // Refs keep hot-path callbacks stable so cursor movement doesn't trigger expensive re-renders.
  const activeLineIndexRef = useRef<number | null>(null);
  const hunkJumpLineRangeRef = useRef<SelectedLineRange | null>(null);
  const selectedLineRangeRef = useRef<SelectedLineRange | null>(null);
  const selectedHunkIdRef = useRef<string | null>(selectedHunkId);
  const isReadRef = useRef(isRead);
  const commitSelectedHunkRef = useRef(commitSelectedHunk);
  const onToggleReadRef = useRef(onToggleRead);
  const onSelectHunkRef = useRef(onSelectHunk);
  const allHunksRef = useRef(allHunks);
  const hunkLineRangesRef = useRef(overlayData.hunkLineRanges);
  const previousOverlayContentRef = useRef<string | null>(null);
  const previousSelectedHunkIdRef = useRef<string | null>(null);
  const previousSelectedHunkRangeRef = useRef<HunkLineRange | null>(null);
  const skipScrollUntilCursorSettlesRef = useRef(false);
  const hunkRangeLineElementsRef = useRef<HTMLElement[]>([]);
  const highlightedLineElementRef = useRef<HTMLElement | null>(null);

  const clearHunkJumpRangeHighlight = useCallback(() => {
    for (const lineElement of hunkRangeLineElementsRef.current) {
      lineElement.dataset.selected = "false";
      lineElement.style.boxShadow = "";
    }
    hunkRangeLineElementsRef.current = [];
  }, []);

  const applyHunkJumpRangeHighlight = useCallback(
    (range: SelectedLineRange) => {
      clearHunkJumpRangeHighlight();
      const startIndex = Math.min(range.startIndex, range.endIndex);
      const endIndex = Math.max(range.startIndex, range.endIndex);
      const highlightedElements: HTMLElement[] = [];

      for (let lineIndex = startIndex; lineIndex <= endIndex; lineIndex += 1) {
        const lineElement = containerRef.current?.querySelector<HTMLElement>(
          `[data-line-index="${lineIndex}"]`
        );
        if (!lineElement) {
          continue;
        }

        const edgeShadows = [
          `inset 1px 0 0 ${HUNK_RANGE_OUTLINE_COLOR}`,
          `inset -1px 0 0 ${HUNK_RANGE_OUTLINE_COLOR}`,
          lineIndex === startIndex ? `inset 0 1px 0 ${HUNK_RANGE_OUTLINE_COLOR}` : null,
          lineIndex === endIndex ? `inset 0 -1px 0 ${HUNK_RANGE_OUTLINE_COLOR}` : null,
        ].filter((shadow): shadow is string => Boolean(shadow));

        lineElement.dataset.selected = "true";
        lineElement.style.boxShadow = edgeShadows.join(", ");
        highlightedElements.push(lineElement);
      }

      hunkRangeLineElementsRef.current = highlightedElements;
    },
    [clearHunkJumpRangeHighlight]
  );

  useEffect(() => {
    activeLineIndexRef.current = activeLineIndex;
  }, [activeLineIndex]);

  useEffect(() => {
    selectedLineRangeRef.current = selectedLineRange;
  }, [selectedLineRange]);

  useEffect(() => {
    selectedHunkIdRef.current = selectedHunkId;
  }, [selectedHunkId]);

  useEffect(() => {
    return () => {
      // Global immersive toggles or page teardown can unmount this view without
      // calling onExit; persist directly instead of relying on parent cleanup.
      updatePersistedState(selectedHunkStorageKey, selectedHunkIdRef.current);
      commitSelectedHunkRef.current(selectedHunkIdRef.current);
    };
  }, [selectedHunkStorageKey]);

  useEffect(() => {
    isReadRef.current = isRead;
  }, [isRead]);

  useEffect(() => {
    commitSelectedHunkRef.current = commitSelectedHunk;
  }, [commitSelectedHunk]);

  useEffect(() => {
    onToggleReadRef.current = onToggleRead;
  }, [onToggleRead]);

  useEffect(() => {
    onSelectHunkRef.current = onSelectHunk;
  }, [onSelectHunk]);

  useEffect(() => {
    allHunksRef.current = allHunks;
  }, [allHunks]);

  useEffect(() => {
    hunkLineRangesRef.current = overlayData.hunkLineRanges;
  }, [overlayData.hunkLineRanges]);

  // Keep cursor and selection aligned to the selected hunk before paint so J/K hunk
  // iteration does not flash the previous cursor/selection for a frame.
  useLayoutEffect(() => {
    const resolvedSelectedHunkId = selectedHunk?.id ?? null;
    const previousOverlayContent = previousOverlayContentRef.current;
    const previousSelectedHunkId = previousSelectedHunkIdRef.current;
    const previousSelectedHunkRange = previousSelectedHunkRangeRef.current;

    previousOverlayContentRef.current = overlayData.content;
    previousSelectedHunkIdRef.current = resolvedSelectedHunkId;
    previousSelectedHunkRangeRef.current = selectedHunkRange;

    if (!selectedHunkRange || !resolvedSelectedHunkId) {
      pendingJumpSelectAllHunkIdRef.current = null;
      clearHunkJumpRangeHighlight();
      hunkJumpLineRangeRef.current = null;
      skipScrollUntilCursorSettlesRef.current = false;
      setActiveLineIndex(null);
      setSelectedLineRange(null);
      return;
    }

    const shouldSelectEntireHunk = pendingJumpSelectAllHunkIdRef.current === resolvedSelectedHunkId;
    if (shouldSelectEntireHunk) {
      pendingJumpSelectAllHunkIdRef.current = null;
      // Use actual modified boundaries (without context padding) for the highlight
      const modifiedStart = selectedHunkRange.firstModifiedIndex ?? selectedHunkRange.startIndex;
      const modifiedEnd = selectedHunkRange.lastModifiedIndex ?? selectedHunkRange.endIndex;
      skipScrollUntilCursorSettlesRef.current = activeLineIndexRef.current !== modifiedEnd;
      hunkJumpLineRangeRef.current = {
        startIndex: modifiedStart,
        endIndex: modifiedEnd,
      };
      applyHunkJumpRangeHighlight(hunkJumpLineRangeRef.current);
      setActiveLineIndex(modifiedEnd);
      setSelectedLineRange(null);
      return;
    }

    if (
      hunkJumpLineRangeRef.current &&
      !isSelectionInsideRange(hunkJumpLineRangeRef.current, selectedHunkRange)
    ) {
      clearHunkJumpRangeHighlight();
      hunkJumpLineRangeRef.current = null;
    }

    const cursorLineIndex = activeLineIndexRef.current;
    const shouldPreserveContextCursor = shouldPreserveImmersiveContextCursor({
      cursorLineIndex,
      previousRange: previousSelectedHunkRange,
      previousHunkId: previousSelectedHunkId,
      currentHunkId: resolvedSelectedHunkId,
      previousOverlayContent,
      currentOverlayContent: overlayData.content,
    });

    if (shouldPreserveContextCursor) {
      // Preserve intentional context-row cursor movement only while the rendered
      // overlay is unchanged. Compact hunk overlays and hydrated full-file
      // overlays use different numeric indices, so carrying a context-row index
      // across that geometry swap would reveal at the wrong row.
      skipScrollUntilCursorSettlesRef.current = false;
      return;
    }

    skipScrollUntilCursorSettlesRef.current = Boolean(
      cursorLineIndex !== null &&
      (cursorLineIndex < selectedHunkRange.startIndex ||
        cursorLineIndex > selectedHunkRange.endIndex)
    );

    setActiveLineIndex((previousLineIndex) => {
      if (
        previousLineIndex !== null &&
        previousLineIndex >= selectedHunkRange.startIndex &&
        previousLineIndex <= selectedHunkRange.endIndex
      ) {
        return previousLineIndex;
      }
      return selectedHunkRange.firstModifiedIndex ?? selectedHunkRange.startIndex;
    });

    setSelectedLineRange((previousSelection) => {
      if (!previousSelection) {
        return null;
      }

      if (isSelectionInsideRange(previousSelection, selectedHunkRange)) {
        return previousSelection;
      }

      const cursorLineIndex = activeLineIndexRef.current;
      if (cursorLineIndex !== null && isLineInsideSelection(cursorLineIndex, previousSelection)) {
        // Keep cross-hunk Shift selections alive while the moving cursor edge
        // tracks into the next hunk.
        return previousSelection;
      }

      return null;
    });
  }, [
    applyHunkJumpRangeHighlight,
    clearHunkJumpRangeHighlight,
    overlayData.content,
    selectedHunk?.id,
    selectedHunkRange?.startIndex,
    selectedHunkRange?.endIndex,
    selectedHunkRange,
  ]);

  // File index for display
  const fileIndex = activeFilePath ? fileList.indexOf(activeFilePath) : -1;
  const fileCount = fileList.length;

  // --- Navigation callbacks ---

  const navigateFile = useCallback(
    (direction: 1 | -1) => {
      if (!activeFilePath) {
        return;
      }

      // Skip files with no currently visible hunks (e.g. filtered out by read/search filters).
      // This keeps file navigation moving forward instead of getting stuck on empty files.
      const targetHunkId = findAdjacentFileHunkId(
        fileList,
        activeFilePath,
        hunks,
        direction,
        "first"
      );
      if (!targetHunkId) {
        return;
      }

      pendingJumpSelectAllHunkIdRef.current = null;
      setHunkJumpScroll("center");
      onSelectHunk(targetHunkId);
    },
    [activeFilePath, fileList, hunks, onSelectHunk, setHunkJumpScroll]
  );

  const navigateHunk = useCallback(
    (direction: 1 | -1) => {
      if (currentFileHunks.length === 0) return;

      const currentIdx = selectedHunkId
        ? currentFileHunks.findIndex((hunk) => hunk.id === selectedHunkId)
        : -1;

      let targetHunkId: string | null;
      if (currentIdx === -1) {
        targetHunkId =
          currentFileHunks[direction === 1 ? 0 : currentFileHunks.length - 1]?.id ?? null;
      } else {
        const nextIdx = currentIdx + direction;
        if (nextIdx < 0 || nextIdx >= currentFileHunks.length) {
          // Keep J/K feeling like one continuous hunk stream instead of forcing an
          // extra file-navigation step at every file boundary.
          targetHunkId = activeFilePath
            ? findAdjacentFileHunkId(
                fileList,
                activeFilePath,
                selectedHunkIsFilteredOut ? allHunks : hunks,
                direction,
                direction === 1 ? "first" : "last"
              )
            : null;
          if (!targetHunkId) {
            setBoundaryToast(
              direction === 1
                ? "Reached the last hunk in review"
                : "Reached the first hunk in review"
            );
            return;
          }
        } else {
          targetHunkId = currentFileHunks[nextIdx].id;
        }
      }

      const targetHunk = (selectedHunkIsFilteredOut ? allHunks : hunks).find(
        (hunk) => hunk.id === targetHunkId
      );
      pendingJumpSelectAllHunkIdRef.current = targetHunkId;
      // Same-file J/K iteration should avoid re-centering every nearby hunk;
      // nearest keeps the viewport anchored unless the target actually leaves view.
      setHunkJumpScroll(targetHunk?.filePath === activeFilePath ? "nearest" : "center");
      // Keyboard hunk iteration should commit before the next key event so the
      // browser can paint each step without waiting for React's default batching.
      flushSync(() => onSelectHunk(targetHunkId));
    },
    [
      activeFilePath,
      allHunks,
      currentFileHunks,
      fileList,
      hunks,
      onSelectHunk,
      selectedHunkId,
      setHunkJumpScroll,
      selectedHunkIsFilteredOut,
    ]
  );

  const navigateToReview = useCallback(
    (review: Review, options?: { startEditing?: boolean }) => {
      const fileHunks = sortHunksInFileOrder(getFileHunks(allHunks, review.data.filePath));
      if (fileHunks.length === 0) {
        return;
      }

      const targetHunkId = findReviewHunkId(review, fileHunks) ?? fileHunks[0].id;
      pendingJumpSelectAllHunkIdRef.current = null;
      setHunkJumpScroll("center");
      const targetRange =
        activeFilePath === review.data.filePath
          ? (overlayData.hunkLineRanges.get(targetHunkId) ?? null)
          : null;
      if (targetRange) {
        // Note/sidebar jumps are explicit hunk navigation, even when the note maps
        // to the already-selected hunk. Reset any context-row cursor first so the
        // centered jump lands on the note's hunk instead of a stale context line.
        skipScrollUntilCursorSettlesRef.current = false;
        setSelectedLineRange(null);
        setActiveLineIndex(targetRange.firstModifiedIndex ?? targetRange.startIndex);
      }

      onSelectHunk(targetHunkId);
      commitSelectedHunk(targetHunkId);
      // Force scroll effect to re-fire even when activeLineIndex is unchanged
      // (for example when the cursor is already inside the selected hunk).
      setScrollNonce((previousNonce) => previousNonce + 1);

      if (options?.startEditing && props.reviewActions?.onEditComment) {
        nextInlineReviewEditRequestIdRef.current += 1;
        setInlineReviewEditRequest({
          requestId: nextInlineReviewEditRequestIdRef.current,
          reviewId: review.id,
        });
      }
    },
    [
      activeFilePath,
      allHunks,
      commitSelectedHunk,
      onSelectHunk,
      overlayData.hunkLineRanges,
      setHunkJumpScroll,
      props.reviewActions?.onEditComment,
    ]
  );

  const diffReviewActions = useMemo<ReviewActionCallbacks | undefined>(() => {
    if (!props.reviewActions) {
      return undefined;
    }

    return {
      ...props.reviewActions,
      onEditingChange: (reviewId: string, isEditing: boolean) => {
        props.reviewActions?.onEditingChange?.(reviewId, isEditing);
        if (isEditing) {
          setInlineReviewEditRequest((currentRequest) =>
            currentRequest?.reviewId === reviewId ? null : currentRequest
          );
        }
      },
    };
  }, [props.reviewActions]);

  const getCurrentLineSelection = useCallback((): SelectedLineRange | null => {
    if (selectedLineRange) {
      return selectedLineRange;
    }

    if (hunkJumpLineRangeRef.current) {
      return hunkJumpLineRangeRef.current;
    }

    if (activeLineIndex === null) {
      return null;
    }

    return { startIndex: activeLineIndex, endIndex: activeLineIndex };
  }, [activeLineIndex, selectedLineRange]);

  const selectedLineSummary = useMemo(() => {
    const selection = getCurrentLineSelection();
    if (!selection) {
      return null;
    }

    return {
      startIndex: Math.min(selection.startIndex, selection.endIndex),
      endIndex: Math.max(selection.startIndex, selection.endIndex),
    };
  }, [getCurrentLineSelection]);

  const openComposer = useCallback(
    (prefill: string, selectionOverride?: SelectedLineRange) => {
      const lineCount = overlayData.lineHunkIds.length;
      if (lineCount === 0) {
        return;
      }

      const clampToOverlay = (lineIndex: number): number =>
        Math.max(0, Math.min(lineCount - 1, lineIndex));

      const selection = selectionOverride ??
        selectedLineRangeRef.current ??
        hunkJumpLineRangeRef.current ?? {
          startIndex: activeLineIndexRef.current ?? 0,
          endIndex: activeLineIndexRef.current ?? 0,
        };
      const effectiveSelection: SelectedLineRange = {
        startIndex: clampToOverlay(selection.startIndex),
        endIndex: clampToOverlay(selection.endIndex),
      };
      // Keep a single cursor source of truth: the moving edge of the selection.
      const cursorIndex = clampToOverlay(effectiveSelection.endIndex);

      pendingComposerHunkSwitchRef.current = null;

      const resolvedTarget =
        findHunkAtLine(cursorIndex, overlayData, currentFileHunks) ??
        findHunkAtLine(effectiveSelection.startIndex, overlayData, currentFileHunks);
      const targetHunk = resolvedTarget?.hunk ?? selectedHunkRef.current;
      if (!targetHunk) {
        return;
      }

      const currentSelectedHunkId = selectedHunkIdRef.current;
      if (targetHunk.id !== currentSelectedHunkId) {
        // Record the in-flight hunk switch so mismatch guards do not clear
        // this composer request before onSelectHunk propagates.
        pendingJumpSelectAllHunkIdRef.current = null;
        pendingComposerHunkSwitchRef.current = {
          fromHunkId: currentSelectedHunkId,
          toHunkId: targetHunk.id,
        };
        onSelectHunk(targetHunk.id);
      }

      // Keep the keyboard cursor on the last selected line so comment placement,
      // selection visuals, and subsequent actions all share the same anchor.
      setActiveLineIndex(cursorIndex);

      nextComposerRequestIdRef.current += 1;
      setInlineComposerRequest({
        requestId: nextComposerRequestIdRef.current,
        prefill,
        hunkId: targetHunk.id,
        startIndex: effectiveSelection.startIndex,
        endIndex: effectiveSelection.endIndex,
        cursorIndex,
      });
    },
    [overlayData, currentFileHunks, onSelectHunk]
  );

  const handleReviewNoteSubmit = useCallback(
    (data: ReviewNoteData) => {
      onReviewNote?.(data);
      // DiffRenderer clears its internal selection after submit, but immersive mode may
      // still keep an external selection request active. Clear it to close the composer
      // and prevent accidental duplicate submissions on repeated Enter presses.
      setInlineComposerRequest(null);
      // Clear the line selection so the next Shift+C targets the current keyboard
      // cursor (activeLineIndex) rather than the stale range from this comment.
      clearHunkJumpRangeHighlight();
      hunkJumpLineRangeRef.current = null;
      setSelectedLineRange(null);
      containerRef.current?.focus();
    },
    [clearHunkJumpRangeHighlight, onReviewNote]
  );

  const handleInlineComposerCancel = useCallback(() => {
    // Keep immersive parent state aligned with child composer teardown so canceled
    // keyboard-initiated requests do not linger or steal focus.
    setInlineComposerRequest(null);
    clearHunkJumpRangeHighlight();
    hunkJumpLineRangeRef.current = null;
    setSelectedLineRange(null);
    containerRef.current?.focus();
  }, [clearHunkJumpRangeHighlight]);

  const moveLineCursor = useCallback(
    (delta: number, extendRange: boolean) => {
      const lineCount = overlayData.lineHunkIds.length;
      if (lineCount === 0) {
        return;
      }

      const currentIndex = activeLineIndexRef.current ?? selectedHunkRange?.startIndex ?? 0;
      const nextIndex = Math.max(0, Math.min(lineCount - 1, currentIndex + delta));

      clearHunkJumpRangeHighlight();
      hunkJumpLineRangeRef.current = null;
      setActiveLineIndex(nextIndex);

      if (extendRange) {
        const anchorIndex = selectedLineRangeRef.current?.startIndex ?? currentIndex;
        setSelectedLineRange({ startIndex: anchorIndex, endIndex: nextIndex });
      } else {
        setSelectedLineRange(null);
      }

      const lineHunkId = overlayData.lineHunkIds[nextIndex];
      if (lineHunkId && lineHunkId !== selectedHunkIdRef.current) {
        pendingJumpSelectAllHunkIdRef.current = null;
        onSelectHunk(lineHunkId);
      }
    },
    [clearHunkJumpRangeHighlight, overlayData.lineHunkIds, selectedHunkRange, onSelectHunk]
  );

  const resetViewCursorForHunk = useCallback(
    (hunkId: string) => {
      pendingJumpSelectAllHunkIdRef.current = null;
      setHunkJumpScroll("center");
      setSelectedLineRange(null);

      if (selectedHunkIdRef.current === hunkId) {
        const hunkRange = hunkLineRangesRef.current.get(hunkId) ?? null;
        setActiveLineIndex(hunkRange?.firstModifiedIndex ?? hunkRange?.startIndex ?? null);
        setScrollNonce((previousNonce) => previousNonce + 1);
      } else {
        setActiveLineIndex(null);
      }

      onSelectHunkRef.current(hunkId);
    },
    [setHunkJumpScroll]
  );

  const getNextHunkAfterMarkRead = useCallback(
    (hunkId: string) => {
      const navigationHunks = selectedHunkIsFilteredOut ? allHunks : hunks;
      const targetHunkId = findNextHunkId(navigationHunks, hunkId);
      if (!targetHunkId) {
        return null;
      }

      return {
        targetHunkId,
        targetHunk: navigationHunks.find((hunk) => hunk.id === targetHunkId),
      };
    },
    [allHunks, hunks, selectedHunkIsFilteredOut]
  );

  const selectNextHunkAfterMarkRead = useCallback(
    (nextHunk: { targetHunkId: string; targetHunk: DiffHunk | undefined }) => {
      pendingJumpSelectAllHunkIdRef.current = nextHunk.targetHunkId;
      setHunkJumpScroll(nextHunk.targetHunk?.filePath === activeFilePath ? "nearest" : "center");
      flushSync(() => onSelectHunkRef.current(nextHunk.targetHunkId));
    },
    [activeFilePath, setHunkJumpScroll]
  );

  const commitSelectionForParentAction = useCallback((hunkId: string) => {
    flushSync(() => commitSelectedHunkRef.current(hunkId));
  }, []);

  const getNextHunkAfterMarkFileRead = useCallback(
    (hunkId: string) => {
      const navigationHunks = selectedHunkIsFilteredOut ? allHunks : hunks;
      const currentHunk = navigationHunks.find((hunk) => hunk.id === hunkId);
      if (!currentHunk) {
        return null;
      }

      const targetHunkId = findNextHunkIdAfterFileRemoval(
        navigationHunks,
        hunkId,
        currentHunk.filePath
      );
      if (!targetHunkId) {
        return null;
      }

      return {
        targetHunkId,
        targetHunk: navigationHunks.find((hunk) => hunk.id === targetHunkId),
      };
    },
    [allHunks, hunks, selectedHunkIsFilteredOut]
  );

  const selectNextHunkAfterMarkFileRead = useCallback(
    (nextHunk: { targetHunkId: string; targetHunk: DiffHunk | undefined }) => {
      pendingJumpSelectAllHunkIdRef.current = nextHunk.targetHunkId;
      setHunkJumpScroll(nextHunk.targetHunk?.filePath === activeFilePath ? "nearest" : "center");
      flushSync(() => onSelectHunkRef.current(nextHunk.targetHunkId));
    },
    [activeFilePath, setHunkJumpScroll]
  );

  const handleMarkFileAsRead = useCallback(
    (hunkId: string) => {
      const nextHunkAfterFileRead = getNextHunkAfterMarkFileRead(hunkId);
      if (nextHunkAfterFileRead && externalSelectedHunkIdRef.current !== hunkId) {
        ignoredExternalSelectionEchoRef.current = hunkId;
      }

      commitSelectionForParentAction(hunkId);
      onMarkFileAsRead(hunkId);
      if (nextHunkAfterFileRead) {
        selectNextHunkAfterMarkFileRead(nextHunkAfterFileRead);
      }
    },
    [
      commitSelectionForParentAction,
      getNextHunkAfterMarkFileRead,
      onMarkFileAsRead,
      selectNextHunkAfterMarkFileRead,
    ]
  );

  const handleToggleReadWithUndo = useCallback(
    (hunkId: string) => {
      const wasRead = isReadRef.current(hunkId);
      readUndoStackRef.current = wasRead
        ? readUndoStackRef.current.filter((trackedHunkId) => trackedHunkId !== hunkId)
        : [...readUndoStackRef.current.filter((trackedHunkId) => trackedHunkId !== hunkId), hunkId];
      const nextHunkAfterRead = wasRead ? null : getNextHunkAfterMarkRead(hunkId);
      if (nextHunkAfterRead && externalSelectedHunkIdRef.current !== hunkId) {
        // Parent selection is intentionally stale during hot immersive navigation.
        // Ignore the parent echo for this committed read action so it cannot replay
        // over the local work-queue advance to the next hunk.
        ignoredExternalSelectionEchoRef.current = hunkId;
      }

      commitSelectionForParentAction(hunkId);
      onToggleReadRef.current(hunkId);
      if (nextHunkAfterRead) {
        // Immersive review is a keyboard-first work queue: marking a hunk read
        // should advance even when the main panel is configured to keep read hunks visible.
        selectNextHunkAfterMarkRead(nextHunkAfterRead);
      }
    },
    [commitSelectionForParentAction, getNextHunkAfterMarkRead, selectNextHunkAfterMarkRead]
  );

  const handleUndoLastRead = useCallback(() => {
    while (readUndoStackRef.current.length > 0) {
      const targetHunkId = readUndoStackRef.current[readUndoStackRef.current.length - 1];
      readUndoStackRef.current = readUndoStackRef.current.slice(0, -1);

      if (
        !isReadRef.current(targetHunkId) ||
        !allHunksRef.current.some((hunk) => hunk.id === targetHunkId)
      ) {
        continue;
      }

      onToggleReadRef.current(targetHunkId);
      resetViewCursorForHunk(targetHunkId);
      return;
    }
  }, [resetViewCursorForHunk]);

  const [copyFileFeedback, setCopyFileFeedback] = useState<{
    kind: "copied" | "failed";
    filePath: string;
    contentVersion: string;
    /** Failure-specific user-facing message; falls back to the generic copy for other failures. */
    message?: string;
  } | null>(null);
  const copyFileRequestIdRef = useRef(0);
  const pendingCopyFilePathRef = useRef<string | null>(null);
  // Both refs update during render so isStale() sees path AND content-version
  // changes before passive effects run; a resolved read's microtask can otherwise
  // beat the invalidation effect after a same-path refresh commits.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const activeFileContentVersionRef = useRef(activeFileContentVersion);
  activeFileContentVersionRef.current = activeFileContentVersion;

  useEffect(() => {
    return () => {
      // Invalidate any in-flight copy so a read that resolves after unmount cannot
      // write to the clipboard (isStale() sees the bumped request id).
      copyFileRequestIdRef.current += 1;
    };
  }, []);

  // File navigation and in-place edits (same path, new diff content) invalidate
  // in-flight copies and free the pending slot. The request-id bump also covers the
  // A -> B -> A case, where the path check alone would wrongly treat the stale read
  // for A as current again.
  useEffect(() => {
    copyFileRequestIdRef.current += 1;
    pendingCopyFilePathRef.current = null;
  }, [activeFilePath, activeFileContentVersion]);

  // Feedback persists until a deterministic event (file navigation, an in-place edit,
  // or the next copy) instead of a wall-clock timer, and never shows against content
  // the copy did not target. Render-time adjustment per the React docs pattern.
  if (
    copyFileFeedback &&
    (copyFileFeedback.filePath !== activeFilePath ||
      copyFileFeedback.contentVersion !== activeFileContentVersion)
  ) {
    setCopyFileFeedback(null);
  }

  const showCopyFileFeedback = (
    kind: "copied" | "failed",
    filePath: string,
    contentVersion: string,
    extra?: { message?: string }
  ) => {
    setCopyFileFeedback({ kind, filePath, contentVersion, message: extra?.message });
  };

  // Deleted files no longer exist on disk, so a copy read would always fail;
  // hide the affordance instead of offering a broken action. The file tree keeps
  // deletion status even when the file contributes no hunks (empty/binary files),
  // and the UNFILTERED hunk set covers trees without status while search/assisted
  // filters empty the visible hunk list.
  const isActiveFileDeleted =
    activeFilePath != null &&
    (findFileTreeStats(props.fileTree, activeFilePath)?.changeType === "deleted" ||
      getFileHunks(allHunks, activeFilePath)[0]?.changeType === "deleted");

  // Copy the entire on-disk file, not the overlay content: the overlay may hold only
  // compact diff hunks (large files) or prefixed diff rows rather than raw file text.
  const handleCopyFile = async () => {
    const filePath = activeFilePath;
    const contentVersion = activeFileContentVersion;
    if (!filePath || isActiveFileDeleted) {
      return;
    }
    // The API union supplies api: null while connecting/reconnecting/errored; the
    // already-rendered view keeps its copy affordance, so fail visibly, not silently.
    if (!api) {
      showCopyFileFeedback("failed", filePath, contentVersion, {
        message: "Copy failed: backend connection unavailable",
      });
      return;
    }
    // Serialize same-file copies so key repeat or double-clicks cannot fan out
    // concurrent reads; navigating to another file still supersedes normally.
    if (pendingCopyFilePathRef.current === filePath) {
      return;
    }
    const requestId = ++copyFileRequestIdRef.current;
    pendingCopyFilePathRef.current = filePath;
    // Clear the previous result so a slow re-copy cannot keep advertising success
    // for clipboard contents this operation is about to replace.
    setCopyFileFeedback(null);
    // Discard stale completions: the user may have navigated away, an edit may have
    // changed the file in place, or a newer copy may have started while this read
    // was in flight. Path and content version are read from render-updated refs so
    // staleness is visible even before the invalidation effect runs.
    const isStale = () =>
      requestId !== copyFileRequestIdRef.current ||
      activeFilePathRef.current !== filePath ||
      activeFileContentVersionRef.current !== contentVersion;
    try {
      const result = await api.workspace.executeBash({
        workspaceId: props.workspaceId,
        script: buildReadFileScript(filePath, {
          // The IPC bash channel truncates output beyond 1MiB, so cap copies at what
          // fits after base64 expansion and fail deterministically with a clear
          // message instead of surfacing an opaque truncation.
          maxSizeBytes: MAX_COPY_FILE_SIZE_BYTES,
          // Hunk paths are container-root-relative in multi-project workspaces, where
          // project entries are symlinks that containment must anchor to.
          ...(props.isMultiProjectWorkspace ? { containmentAnchor: "first-segment" as const } : {}),
        }),
        // Multi-project default mode runs from the container root matching those
        // paths; single-project hunk paths are repo-root-relative, where default
        // mode would run from a subproject cwd and miss the file.
        options: props.isMultiProjectWorkspace ? undefined : { cwdMode: "repo-root" },
      });
      if (isStale()) {
        return;
      }
      // Any unsuccessful script exit (budget/containment codes or partial failures
      // like base64 dying after stat) means the output cannot be trusted as the
      // full file; the IPC truncation marker likewise signals a partial payload.
      if (!result.success || !result.data.success || result.data.truncated) {
        const isTooLarge = result.success && result.data.exitCode === EXIT_CODE_TOO_LARGE;
        showCopyFileFeedback("failed", filePath, contentVersion, {
          message: isTooLarge
            ? `Copy failed: file is larger than ${Math.floor(MAX_COPY_FILE_SIZE_BYTES / 1024)} KB`
            : undefined,
        });
        return;
      }
      const contents = processFileContents(result.data.output ?? "", result.data.exitCode);
      // SVGs are classified as images for preview purposes, but they are text
      // source and this action promises the file's contents; copy the markup.
      const text =
        contents.type === "text"
          ? contents.content
          : contents.type === "image" && contents.mimeType === "image/svg+xml"
            ? decodeBase64Utf8(contents.base64)
            : null;
      if (text == null) {
        showCopyFileFeedback("failed", filePath, contentVersion);
        return;
      }
      await copyToClipboard(text);
      if (!isStale()) {
        showCopyFileFeedback("copied", filePath, contentVersion);
      }
    } catch (error) {
      console.error("Failed to copy file contents:", error);
      if (!isStale()) {
        showCopyFileFeedback("failed", filePath, contentVersion);
      }
    } finally {
      // A superseding request owns the pending slot; only the current one releases it.
      if (
        pendingCopyFilePathRef.current === filePath &&
        copyFileRequestIdRef.current === requestId
      ) {
        pendingCopyFilePathRef.current = null;
      }
    }
  };

  // Keyboard handling reads the handler through a ref (matching onToggleReadRef) so the
  // effect does not depend on a per-render function identity.
  const handleCopyFileRef = useRef(handleCopyFile);
  handleCopyFileRef.current = handleCopyFile;

  const activeCopyFileFeedback = copyFileFeedback?.kind ?? null;

  const handleLineIndexSelect = useCallback(
    (lineIndex: number, shiftKey: boolean) => {
      const resolvedHunk = findHunkAtLine(lineIndex, overlayData, currentFileHunks);
      if (resolvedHunk && selectedHunkIdRef.current !== resolvedHunk.hunk.id) {
        pendingJumpSelectAllHunkIdRef.current = null;
        onSelectHunk(resolvedHunk.hunk.id);
      }

      clearHunkJumpRangeHighlight();
      hunkJumpLineRangeRef.current = null;
      const anchorIndex = shiftKey
        ? (selectedLineRangeRef.current?.startIndex ?? activeLineIndexRef.current ?? lineIndex)
        : lineIndex;
      setActiveLineIndex((previousLineIndex) =>
        previousLineIndex === lineIndex ? previousLineIndex : lineIndex
      );

      if (shiftKey) {
        setSelectedLineRange((previousRange) => {
          if (previousRange?.startIndex === anchorIndex && previousRange?.endIndex === lineIndex) {
            return previousRange;
          }

          return { startIndex: anchorIndex, endIndex: lineIndex };
        });
      } else {
        setSelectedLineRange((previousRange) => (previousRange === null ? previousRange : null));
      }

      if (isTouchExperience && !shiftKey && resolvedHunk) {
        // Mobile row tap should only open a composer for lines backed by a diff hunk.
        openComposer("", { startIndex: lineIndex, endIndex: lineIndex });
      }
    },
    [
      clearHunkJumpRangeHighlight,
      overlayData,
      currentFileHunks,
      isTouchExperience,
      onSelectHunk,
      openComposer,
    ]
  );

  const handleMinimapSelectLine = useCallback(
    (lineIndex: number) => {
      const hunkId = overlayData.lineHunkIds[lineIndex] ?? null;
      if (hunkId && hunkId !== selectedHunkIdRef.current) {
        onSelectHunk(hunkId);
      }

      clearHunkJumpRangeHighlight();
      setActiveLineIndex(lineIndex);
      setSelectedLineRange(null);
    },
    [clearHunkJumpRangeHighlight, overlayData.lineHunkIds, onSelectHunk]
  );

  // Auto-focus only for keyboard-first immersive mode.
  useEffect(() => {
    if (isTouchExperience) {
      return;
    }

    containerRef.current?.focus();
  }, [isTouchExperience]);

  // --- Keyboard handler ---
  useLayoutEffect(() => {
    if (isTouchExperience) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      // Tab: toggle between diff and notes panels.
      if (matchesKeybind(e, KEYBINDS.REVIEW_FOCUS_NOTES)) {
        // Keep normal tab behavior when typing in inline note editors.
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        if (focusedPanel === "diff") {
          if (allReviews.length > 0) {
            setFocusedPanel("notes");
          }
        } else {
          setFocusedPanel("diff");
          containerRef.current?.focus();
        }
        return;
      }

      // --- Notes sidebar keyboard mode ---
      if (focusedPanel === "notes") {
        // Don't intercept when typing in editable elements.
        if (isEditableElement(e.target)) return;

        // Esc: return to diff panel (not exit immersive).
        if (matchesKeybind(e, KEYBINDS.CANCEL)) {
          e.preventDefault();
          stopKeyboardPropagation(e);
          setFocusedPanel("diff");
          containerRef.current?.focus();
          return;
        }

        // J / ArrowDown: next note.
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          const maxNoteIndex = Math.max(0, allReviews.length - 1);
          setFocusedNoteIndex((previousIndex) => Math.min(maxNoteIndex, previousIndex + 1));
          return;
        }

        // K / ArrowUp: previous note.
        if (e.key === "k" || e.key === "ArrowUp") {
          e.preventDefault();
          setFocusedNoteIndex((previousIndex) => Math.max(0, previousIndex - 1));
          return;
        }

        // Enter: navigate to focused note in diff and return to diff panel.
        if (e.key === "Enter") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note) {
            navigateToReview(note);
            setFocusedPanel("diff");
            containerRef.current?.focus();
          }
          return;
        }

        if (e.key === "e" || e.key === "E") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note) {
            // Keep note triage keyboard-first: jump directly from notes list into
            // editing the exact inline note comment in the diff pane.
            navigateToReview(note, { startEditing: true });
            setFocusedPanel("diff");
            containerRef.current?.focus();
          }
          return;
        }

        // Backspace/Delete: delete focused note.
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note && props.reviewActions?.onDelete) {
            props.reviewActions.onDelete(note.id);
          }
          return;
        }

        // Swallow all other keys in notes mode so diff shortcuts do not fire.
        return;
      }

      // --- Diff panel keyboard mode ---
      // Don't intercept when typing in editable elements
      if (isEditableElement(e.target)) return;

      // Don't intercept Escape (or any shortcut) while a modal dialog is open.
      // This handler runs in capture phase, so bubble-phase stopPropagation
      // from dialog onKeyDown can't block it; check the DOM directly.
      if (isDialogOpen()) return;

      // Esc: exit immersive
      if (matchesKeybind(e, KEYBINDS.CANCEL)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        onExit();
        return;
      }

      // L/H: next/prev file
      if (matchesKeybind(e, KEYBINDS.REVIEW_NEXT_FILE)) {
        e.preventDefault();
        navigateFile(1);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_PREV_FILE)) {
        e.preventDefault();
        navigateFile(-1);
        return;
      }

      // J/K: next/prev hunk
      if (matchesKeybind(e, KEYBINDS.REVIEW_NEXT_HUNK)) {
        e.preventDefault();
        navigateHunk(1);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_PREV_HUNK)) {
        e.preventDefault();
        navigateHunk(-1);
        return;
      }

      // Arrow line cursor controls
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_JUMP_DOWN)) {
        e.preventDefault();
        moveLineCursor(LINE_JUMP_SIZE, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_JUMP_UP)) {
        e.preventDefault();
        moveLineCursor(-LINE_JUMP_SIZE, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_DOWN)) {
        e.preventDefault();
        moveLineCursor(1, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_UP)) {
        e.preventDefault();
        moveLineCursor(-1, e.shiftKey);
        return;
      }

      // Shift+C: add comment
      if (matchesKeybind(e, KEYBINDS.REVIEW_COMMENT)) {
        e.preventDefault();
        openComposer("");
        return;
      }

      // Shift+L: quick like
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_LIKE)) {
        e.preventDefault();
        openComposer(LIKE_NOTE_PREFIX);
        return;
      }

      // Shift+D: quick dislike
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_DISLIKE)) {
        e.preventDefault();
        openComposer(DISLIKE_NOTE_PREFIX);
        return;
      }

      // Mark entire file as read (Shift+M) — check before TOGGLE_HUNK_READ
      // since matchesKeybind for 'm' could match if shift isn't checked first
      if (matchesKeybind(e, KEYBINDS.MARK_FILE_READ)) {
        e.preventDefault();
        if (selectedHunkId) {
          handleMarkFileAsRead(selectedHunkId);
        }
        return;
      }

      if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_READ)) {
        e.preventDefault();
        if (selectedHunkId) handleToggleReadWithUndo(selectedHunkId);
        return;
      }

      // U: step back to the last hunk marked read in immersive review.
      if (matchesKeybind(e, KEYBINDS.MARK_HUNK_UNREAD)) {
        e.preventDefault();
        handleUndoLastRead();
        return;
      }

      // Copy the active file's full contents to the clipboard. Ignore OS key
      // repeat so holding the key cannot fan out repeated backend reads.
      if (matchesKeybind(e, KEYBINDS.REVIEW_COPY_FILE)) {
        e.preventDefault();
        if (!e.repeat) {
          void handleCopyFileRef.current();
        }
        return;
      }
    };

    // Run in capture phase so immersive Escape handling can swallow the event before
    // bubble-phase global stream-interrupt listeners see it.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    focusedPanel,
    allReviews,
    focusedNoteIndex,
    navigateToReview,
    props.reviewActions,
    onExit,
    navigateFile,
    navigateHunk,
    moveLineCursor,
    openComposer,
    selectedHunkId,
    commitSelectionForParentAction,
    handleToggleReadWithUndo,
    handleMarkFileAsRead,
    handleUndoLastRead,
    isTouchExperience,
  ]);

  const previousContentRef = useRef(overlayData.content);

  // Keep the active line visible while moving with keyboard shortcuts, without
  // forcing the full diff tree to re-render on every cursor move. This is a layout
  // effect because scroll/outline writes must happen before paint to avoid hunk
  // navigation flashing at the previous viewport position.
  useLayoutEffect(() => {
    const contentChanged = previousContentRef.current !== overlayData.content;
    previousContentRef.current = overlayData.content;

    const previousLineElement = highlightedLineElementRef.current;
    if (previousLineElement) {
      previousLineElement.style.outline = "";
      previousLineElement.style.outlineOffset = "";
      highlightedLineElementRef.current = null;
    }

    // When overlay content structure changes (fallback hunks -> full-file view),
    // defer regular scrolling until the selected-hunk effect has recalculated
    // activeLineIndex. Preserve ordinary context-row cursor movement: if the user
    // is already outside the selected hunk and no hunk sync is pending, do not arm
    // a center jump for the next scroll.
    if (contentChanged) {
      const cursorIsInsideSelectedHunk = Boolean(
        activeLineIndex !== null &&
        selectedHunkRange &&
        activeLineIndex >= selectedHunkRange.startIndex &&
        activeLineIndex <= selectedHunkRange.endIndex
      );
      hunkJumpRef.current = Boolean(
        isActiveOverlayRevealPending ||
        skipScrollUntilCursorSettlesRef.current ||
        activeLineIndex === null ||
        !selectedHunkRange ||
        cursorIsInsideSelectedHunk
      );
      if (!isActiveOverlayRevealPending) {
        return;
      }
    }

    const lineIndexForScroll = isActiveOverlayRevealPending
      ? revealTargetLineIndex
      : activeLineIndex;
    if (lineIndexForScroll === null) {
      return;
    }

    if (skipScrollUntilCursorSettlesRef.current) {
      const cursorHasSettled =
        isActiveOverlayRevealPending ||
        activeLineIndex === null ||
        !selectedHunkRange ||
        (activeLineIndex >= selectedHunkRange.startIndex &&
          activeLineIndex <= selectedHunkRange.endIndex);

      if (!cursorHasSettled) {
        // A hunk jump renders once with the previous hunk's activeLineIndex before
        // the selected-hunk layout effect commits the new cursor. Do not issue a
        // stale scrollIntoView in that intermediate commit; the next layout pass
        // will scroll directly to the selected hunk. Plain line-cursor movement to
        // full-file context lines never sets this ref, so it still scrolls normally.
        return;
      }

      skipScrollUntilCursorSettlesRef.current = false;
    }

    const lineElement = containerRef.current?.querySelector<HTMLElement>(
      `[data-line-index="${lineIndexForScroll}"]`
    );
    if (!lineElement) {
      if (!isActiveOverlayRevealPending || !activeOverlayRevealIdentity || contentChanged) {
        return;
      }

      scheduleOverlayReveal(activeOverlayRevealIdentity);
      return;
    }

    const shouldRenderActiveLineOutline =
      activeLineIndex !== null && lineIndexForScroll === activeLineIndex;

    if (shouldRenderActiveLineOutline) {
      lineElement.style.outline = ACTIVE_LINE_OUTLINE;
      lineElement.style.outlineOffset = "-1px";
      highlightedLineElementRef.current = lineElement;
    }

    const block = hunkJumpRef.current ? hunkJumpScrollBlockRef.current : "nearest";
    hunkJumpRef.current = false;
    hunkJumpScrollBlockRef.current = "center";
    lineElement.scrollIntoView({ behavior: "auto", block });

    if (!isActiveOverlayRevealPending || !activeOverlayRevealIdentity) {
      return;
    }

    if (!isActiveOverlayReadyForReveal) {
      return;
    }

    if (!isTouchExperience) {
      // The minimap redraws from scrollTop; after a hidden hydration/file-swap
      // scroll, force one hidden redraw before the shared reveal gate opens.
      setMinimapRedrawNonce((previousNonce) => previousNonce + 1);
    }
    scheduleOverlayReveal(activeOverlayRevealIdentity);
  }, [
    activeLineIndex,
    activeOverlayRevealIdentity,
    isActiveOverlayReadyForReveal,
    isActiveOverlayRevealPending,
    isTouchExperience,
    overlayData.content,
    revealTargetLineIndex,
    scheduleOverlayReveal,
    scrollNonce,
    selectedHunkRange,
  ]);

  useEffect(() => {
    return () => {
      const previousLineElement = highlightedLineElementRef.current;
      if (!previousLineElement) {
        return;
      }

      previousLineElement.style.outline = "";
      previousLineElement.style.outlineOffset = "";
      highlightedLineElementRef.current = null;
    };
  }, []);

  const currentHunkIdx = selectedHunkId
    ? currentFileHunks.findIndex((hunk) => hunk.id === selectedHunkId)
    : -1;

  const selectedLineSummaryLabel = useMemo(() => {
    if (!selectedLineSummary) {
      return "–";
    }

    if (!selectedHunkRange || !isSelectionInsideRange(selectedLineSummary, selectedHunkRange)) {
      return `${selectedLineSummary.startIndex + 1}-${selectedLineSummary.endIndex + 1}`;
    }

    const relativeStart = selectedLineSummary.startIndex - selectedHunkRange.startIndex + 1;
    const relativeEnd = selectedLineSummary.endIndex - selectedHunkRange.startIndex + 1;
    return `${relativeStart}-${relativeEnd}`;
  }, [selectedLineSummary, selectedHunkRange]);

  const externalComposerSelectionRequest = useMemo(() => {
    if (!inlineComposerRequest || !selectedHunk) {
      return null;
    }

    if (inlineComposerRequest.hunkId !== selectedHunk.id) {
      return null;
    }

    const lineCount = overlayData.lineHunkIds.length;
    if (lineCount === 0) {
      return null;
    }

    const clampToOverlay = (lineIndex: number) => Math.max(0, Math.min(lineCount - 1, lineIndex));

    return {
      requestId: inlineComposerRequest.requestId,
      selection: {
        startIndex: clampToOverlay(inlineComposerRequest.startIndex),
        endIndex: clampToOverlay(inlineComposerRequest.endIndex),
      },
      composerAfterIndex: clampToOverlay(inlineComposerRequest.cursorIndex),
      initialNoteText: inlineComposerRequest.prefill,
    };
  }, [inlineComposerRequest, overlayData.lineHunkIds.length, selectedHunk]);

  const immersiveOverlayState = isReviewComplete
    ? "complete"
    : props.isLoading && currentFileHunks.length === 0
      ? "loading"
      : isActiveFileRevealPending
        ? "pending"
        : overlayData.content.length > 0
          ? "revealed"
          : "empty";

  return (
    <div
      ref={containerRef}
      tabIndex={isTouchExperience ? -1 : 0}
      className="flex h-full flex-col overflow-hidden outline-none"
      data-active-file-path={activeFilePath ?? undefined}
      data-overlay-line-count={overlayData.lineHunkIds.length}
      data-overlay-state={immersiveOverlayState}
      data-selected-line-index={activeLineIndex ?? selectedHunkRevealTargetLineIndex ?? undefined}
      data-selected-hunk-position={currentHunkIdx >= 0 ? currentHunkIdx + 1 : undefined}
      data-current-file-hunk-count={currentFileHunks.length}
      data-testid="immersive-review-view"
    >
      {/* Header */}
      <div className="border-border-light bg-dark flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {/* Back button */}
        <button
          onClick={onExit}
          className="text-muted hover:text-foreground flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-xs transition-colors"
          aria-label="Exit immersive review"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </button>

        <div className="bg-border-light hidden h-4 w-px shrink-0 sm:block" />

        {/* File navigation */}
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-initial">
          <button
            onClick={() => navigateFile(-1)}
            disabled={isReviewComplete || fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Previous file"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {/* Mobile: show filename only */}
          <TooltipIfPresent
            tooltip={isReviewComplete ? null : activeFilePath}
            side="bottom"
            align="start"
          >
            <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs sm:hidden">
              {isReviewComplete
                ? "Review complete"
                : (activeFilePath?.split("/").pop() ?? "No files")}
            </span>
          </TooltipIfPresent>
          {/* Desktop: show full path */}
          <TooltipIfPresent
            tooltip={isReviewComplete ? null : activeFilePath}
            side="bottom"
            align="start"
          >
            <span className="text-foreground hidden max-w-[400px] truncate font-mono text-xs sm:block">
              {isReviewComplete ? "Review complete" : (activeFilePath ?? "No files")}
            </span>
          </TooltipIfPresent>
          <span className="text-dim hidden shrink-0 text-[10px] sm:inline">
            {!isReviewComplete && fileIndex >= 0 ? `${fileIndex + 1}/${fileCount}` : ""}
          </span>
          <button
            onClick={() => navigateFile(1)}
            disabled={isReviewComplete || fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Next file"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {!isReviewComplete && activeFilePath && !isActiveFileDeleted && (
            <TooltipIfPresent
              tooltip={
                activeCopyFileFeedback === "copied" ? (
                  "Copied!"
                ) : activeCopyFileFeedback === "failed" ? (
                  (copyFileFeedback?.message ?? "Copy failed: not a copyable text file")
                ) : (
                  <span>
                    Copy file{" "}
                    <span className="mobile-hide-shortcut-hints">
                      ({formatKeybind(KEYBINDS.REVIEW_COPY_FILE)})
                    </span>
                  </span>
                )
              }
              side="bottom"
              align="start"
            >
              <button
                onClick={() => void handleCopyFile()}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors",
                  activeCopyFileFeedback === "copied"
                    ? "text-read"
                    : activeCopyFileFeedback === "failed"
                      ? "text-danger-soft"
                      : "text-muted hover:text-foreground"
                )}
                aria-label="Copy file contents"
                data-copy-file-feedback={activeCopyFileFeedback ?? undefined}
              >
                {activeCopyFileFeedback === "copied" ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : activeCopyFileFeedback === "failed" ? (
                  <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipIfPresent>
          )}
          {/* The keyboard shortcut never focuses the button, so announce copy
              outcomes through a live region. Rendered as a SIBLING: a button is an
              accessibility leaf whose aria-label replaces descendant text, so a
              nested status would not be exposed. */}
          <span className="sr-only" role="status">
            {activeCopyFileFeedback === "copied"
              ? "File copied to clipboard"
              : activeCopyFileFeedback === "failed"
                ? (copyFileFeedback?.message ?? "Copy failed: not a copyable text file")
                : ""}
          </span>
        </div>

        <div className="bg-border-light hidden h-4 w-px shrink-0 sm:block" />

        {/* Hunk read toggle — mobile only (desktop copy lives inside the summary div below) */}
        {selectedHunk && (
          <button
            type="button"
            className={cn(
              "text-muted hover:text-read flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors duration-150 sm:hidden",
              isRead(selectedHunk.id) && "text-read"
            )}
            onClick={() => handleToggleReadWithUndo(selectedHunk.id)}
            aria-label={isRead(selectedHunk.id) ? "Mark hunk as unread" : "Mark hunk as read"}
          >
            {isRead(selectedHunk.id) ? (
              <Check aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Circle aria-hidden="true" className="h-3 w-3" />
            )}
          </button>
        )}
        {/* Hunk selection summary — hidden on mobile, includes toggle on desktop */}
        {(isReviewComplete || currentFileHunks.length > 0) && (
          <div className="text-muted hidden items-center gap-1 text-[10px] sm:flex">
            {isReviewComplete ? (
              <span>All {reviewedHunkLabel} reviewed</span>
            ) : (
              <>
                {selectedHunk && (
                  <button
                    type="button"
                    className={cn(
                      "text-muted hover:text-read flex cursor-pointer items-center border-none bg-transparent p-0 transition-colors duration-150",
                      isRead(selectedHunk.id) && "text-read"
                    )}
                    onClick={() => handleToggleReadWithUndo(selectedHunk.id)}
                    aria-label={
                      isRead(selectedHunk.id) ? "Mark hunk as unread" : "Mark hunk as read"
                    }
                  >
                    {isRead(selectedHunk.id) ? (
                      <Check aria-hidden="true" className="h-3 w-3" />
                    ) : (
                      <Circle aria-hidden="true" className="h-3 w-3" />
                    )}
                  </button>
                )}
                <span>
                  Hunk {currentHunkIdx >= 0 ? currentHunkIdx + 1 : "–"}/{currentFileHunks.length}
                </span>
                <span className="text-dim">·</span>
                <span>Lines {selectedLineSummaryLabel}</span>
                {selectedHunkLineCount > 0 && (
                  <>
                    <span className="text-dim">·</span>
                    <span>{selectedHunkLineCount} lines</span>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {/* Assisted-mode indicator — the control bar that hosts the Assisted
            toggle is hidden behind the immersive overlay, so without this the
            user has no way to tell the diff is filtered to agent-flagged hunks.
            ml-auto anchors it to the row's trailing edge as a mode indicator. */}
        {props.assistedOnly === true && (
          <div
            className="border-review-accent/40 bg-review-accent/10 text-review-accent ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium"
            data-testid="immersive-assisted-mode-badge"
            role="status"
          >
            <Sparkles aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>Assisted</span>
            {(props.assistedCount ?? 0) > 0 && (
              <span className="text-review-accent/70 counter-nums">
                {props.assistedUnreadCount ?? 0}/{props.assistedCount ?? 0}
              </span>
            )}
          </div>
        )}
        {allHunks.length > 0 && (
          <div className="w-full pt-0.5">
            <TooltipIfPresent
              tooltip={
                <>
                  <span>{reviewCompletionSummary}</span>
                  <span className="text-muted block text-[10px]">
                    {reviewedChangedLineCount}/{totalChangedLineCount} changed lines reviewed
                  </span>
                  <span className="text-muted block text-[10px]">
                    {reviewCompletionHunkDetails}
                  </span>
                </>
              }
              side="bottom"
              align="start"
            >
              <div
                role="progressbar"
                tabIndex={0}
                aria-label="Review completion by changed lines"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={reviewCompletionPercent}
                aria-valuetext={reviewCompletionDetails}
                className="bg-border-light h-0.5 cursor-help overflow-hidden"
              >
                <div
                  className="h-full"
                  style={{
                    width: `${reviewCompletionWidthPercent}%`,
                    backgroundColor: "var(--color-read)",
                  }}
                />
              </div>
            </TooltipIfPresent>
          </div>
        )}
      </div>

      {/* Agent status bar — keeps the TODO plan + live streaming status visible
          while reviewing, since the chat transcript/composer are hidden behind
          the immersive overlay. Self-subscribes so its updates don't re-render
          the diff tree; renders nothing when there's no plan and no stream. */}
      <ImmersiveReviewAgentStatusBar workspaceId={props.workspaceId} />

      {/* Unified whole-file diff with hunk overlays + notes sidebar */}
      <div className="flex min-h-0 flex-1">
        {/* Diff column. The assisted-review callout lives INSIDE this column (not
            above the whole body) so the agent's per-hunk comment spans only the
            diff width and lines up with the code it refers to — rather than
            stretching across the minimap and notes sidebar. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shouldReserveAssistedBannerSlot &&
            (isSelectedAssisted ? (
              <TooltipIfPresent
                tooltip={<span className="whitespace-pre-wrap">{selectedAssistedLabel}</span>}
                side="bottom"
                align="start"
              >
                <div
                  className="border-review-accent/40 bg-review-accent/5 text-foreground flex h-[calc(1lh+0.75rem+1px)] shrink-0 cursor-help items-start gap-2 overflow-hidden border-b px-3 py-1.5 text-[11px] leading-[1.4]"
                  data-assisted-banner-slot="true"
                  data-testid="immersive-assisted-banner"
                  role="status"
                  aria-live="polite"
                  aria-label={selectedAssistedLabel}
                  title={selectedAssistedLabel}
                >
                  {/* Reserve a stable row for files that contain assisted hunks so J/K
                      iteration doesn't reflow the diff when the selected hunk enters
                      or leaves the agent's focus. */}
                  <Sparkles
                    aria-hidden="true"
                    className="text-review-accent mt-[2px] h-3 w-3 shrink-0"
                  />
                  <span className="min-w-0 break-words whitespace-pre-wrap">
                    {selectedAssistedLabel}
                  </span>
                </div>
              </TooltipIfPresent>
            ) : (
              <div
                className="border-border-light bg-dark h-[calc(1lh+0.75rem+1px)] shrink-0 border-b text-[11px] leading-[1.4]"
                data-assisted-banner-slot="true"
                data-testid="immersive-assisted-banner-slot"
              />
            ))}
          {/* Avoid top padding here; it reads as a blank block between the controls and diff. */}
          <div className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={scrollContainerRef}
              className="scrollbar-none h-full min-h-0 min-w-0 overflow-y-auto pb-3 [overflow-anchor:none]"
            >
              {props.isLoading && currentFileHunks.length === 0 ? (
                <div className="text-muted flex items-center justify-center py-12 text-sm">
                  <span className="animate-pulse">Loading diff...</span>
                </div>
              ) : isReviewComplete ? (
                <div className="flex min-h-full items-center justify-center px-6 py-12">
                  <div
                    data-testid="immersive-review-complete"
                    className="flex max-w-md flex-col items-center gap-4 text-center"
                  >
                    <div className="bg-accent/10 text-accent rounded-full p-3">
                      <CheckCircle2 aria-hidden="true" className="h-8 w-8" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-foreground text-base font-medium">Review complete</h2>
                      <p className="text-muted text-sm leading-relaxed">
                        You have already reviewed all {reviewedHunkLabel} in this diff. Return to
                        chat to keep going, or reopen reviewed hunks from the review panel if you
                        want another pass.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onExit}
                      className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                    >
                      Return to chat
                    </button>
                  </div>
                </div>
              ) : currentFileHunks.length === 0 ? (
                <div className="text-muted flex items-center justify-center py-12 text-sm">
                  {activeFilePath ? "No hunks for this file" : "No files to review"}
                </div>
              ) : (
                <div
                  className={cn(
                    "bg-dark relative overflow-hidden",
                    isActiveFileRevealPending && "min-h-56"
                  )}
                >
                  <div
                    className={cn(isActiveFileRevealPending && "invisible")}
                    data-active-file-path={activeFilePath ?? undefined}
                    data-overlay-line-count={overlayData.lineHunkIds.length}
                    data-overlay-state={immersiveOverlayState}
                    data-selected-line-index={
                      activeLineIndex ?? selectedHunkRevealTargetLineIndex ?? undefined
                    }
                    data-testid="immersive-diff-reveal-stage"
                  >
                    {overlayData.content.length > 0 && (
                      <SelectableDiffRenderer
                        content={overlayData.content}
                        filePath={activeFilePath ?? currentFileHunks[0].filePath}
                        inlineReviews={activeFileReviews}
                        oldStart={1}
                        newStart={1}
                        fontSize="11px"
                        maxHeight="none"
                        className="rounded-none border-0 [&>div]:overflow-x-visible"
                        onHighlightSettledChange={handleDiffHighlightSettledChange}
                        onReviewNote={handleReviewNoteSubmit}
                        onComposerCancel={handleInlineComposerCancel}
                        reviewActions={diffReviewActions}
                        enableHighlighting={shouldEnableHighlighting}
                        selectedLineRange={selectedLineRange}
                        onLineIndexSelect={handleLineIndexSelect}
                        externalSelectionRequest={externalComposerSelectionRequest}
                        externalEditRequest={inlineReviewEditRequest}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
            {isActiveFileRevealPending && currentFileHunks.length > 0 && !isReviewComplete && (
              <div
                className="bg-dark/95 absolute inset-0 z-10 min-h-56 overflow-hidden"
                data-testid="immersive-diff-reveal-overlay"
              >
                <ImmersiveDiffRevealLoadingState label={revealLoadingLabel} />
              </div>
            )}
          </div>
        </div>

        {!isReviewComplete && !isTouchExperience && (
          <div
            className={cn("h-full self-stretch", isActiveFileRevealPending && "invisible")}
            data-testid="immersive-minimap-reveal-stage"
          >
            <ImmersiveMinimap
              content={overlayData.content}
              scrollContainerRef={scrollContainerRef}
              activeLineIndex={activeLineIndex}
              redrawNonce={minimapRedrawNonce}
              onSelectLineIndex={handleMinimapSelectLine}
              commentLineIndices={commentLineIndices}
            />
          </div>
        )}

        {!isReviewComplete && !isTouchExperience && (
          <aside className="border-border-light bg-dark flex w-[280px] min-w-[280px] flex-col border-l">
            <div className="border-border-light flex items-center justify-between border-b px-3 py-2">
              <h2
                className={cn(
                  "text-foreground text-xs font-medium",
                  focusedPanel === "notes" && "text-[var(--color-review-accent)]"
                )}
              >
                Notes
              </h2>
              <span className="bg-muted/20 text-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
                {allReviews.length}
              </span>
            </div>

            <div ref={notesSidebarRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {allReviews.length === 0 ? (
                <div className="text-muted flex h-full flex-col items-center justify-center text-center text-xs">
                  <p>No notes yet</p>
                  <p className="text-dim mt-1">Press Shift+L to add one</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {allReviews.map((review, noteIndex) => {
                    const normalizedUserNote = review.data.userNote.trimStart();
                    const isDislike = normalizedUserNote.startsWith(DISLIKE_NOTE_PREFIX);
                    const isLike = normalizedUserNote.startsWith(LIKE_NOTE_PREFIX);
                    const statusClasses = getReviewStatusSidebarClasses(review.status);
                    const ReviewTypeIcon = isDislike
                      ? ThumbsDown
                      : isLike
                        ? ThumbsUp
                        : MessageSquare;
                    const isActiveFileReview = review.data.filePath === activeFilePath;

                    return (
                      <div
                        key={review.id}
                        role="button"
                        tabIndex={0}
                        data-note-index={noteIndex}
                        className={cn(
                          "group/review-item border-border-light hover:bg-muted/10 focus-visible:ring-primary/40 flex w-full cursor-pointer overflow-hidden rounded border text-left outline-none transition-colors focus-visible:ring-2",
                          isActiveFileReview && "bg-muted/10",
                          focusedPanel === "notes" &&
                            noteIndex === focusedNoteIndex &&
                            "ring-2 ring-[var(--color-review-accent)]/40 bg-muted/10"
                        )}
                        onClick={() => navigateToReview(review)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigateToReview(review);
                          }
                        }}
                      >
                        <div className={cn("w-[3px] shrink-0", statusClasses.accent)} />

                        <div className="min-w-0 flex-1 px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <ReviewTypeIcon className={cn("size-3 shrink-0", statusClasses.icon)} />

                            <TooltipIfPresent
                              tooltip={`${review.data.filePath}:L${formatLineRangeCompact(review.data.lineRange)}`}
                              side="top"
                              align="start"
                            >
                              <span className="text-muted min-w-0 flex-1 truncate font-mono text-[10px]">
                                {`${getFileBaseName(review.data.filePath)}:L${formatLineRangeCompact(review.data.lineRange)}`}
                              </span>
                            </TooltipIfPresent>

                            <span
                              className={cn(
                                "shrink-0 rounded px-1 py-0.5 text-[9px] uppercase",
                                statusClasses.badge
                              )}
                            >
                              {review.status}
                            </span>
                          </div>

                          <div className="mt-1 flex flex-col">
                            <p
                              className="text-foreground overflow-hidden text-[11px] leading-[1.4] break-words whitespace-pre-wrap"
                              style={{
                                display: "-webkit-box",
                                WebkitBoxOrient: "vertical",
                                WebkitLineClamp: 2,
                              }}
                            >
                              {review.data.userNote || "(No note text)"}
                            </p>

                            {/* Keep preview actions in a reserved footer so hover reveals do not shift note content. */}
                            {props.reviewActions?.onDelete && (
                              <div className="mt-1 flex min-h-4 items-center justify-end">
                                <button
                                  type="button"
                                  className="text-muted hover:text-error invisible cursor-pointer rounded p-0.5 opacity-0 transition-colors transition-opacity group-focus-within/review-item:visible group-focus-within/review-item:opacity-100 group-hover/review-item:visible group-hover/review-item:opacity-100"
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      stopKeyboardPropagation(event);
                                    }
                                  }}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    props.reviewActions?.onDelete?.(review.id);
                                  }}
                                  aria-label="Delete review note"
                                >
                                  <Trash2 className="size-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Boundary toast */}
      {boundaryToast && (
        <div className="pointer-events-none absolute right-0 bottom-12 left-0 z-10 flex justify-center">
          <div className="bg-background-secondary text-muted border-border-light pointer-events-auto rounded-md border px-3 py-1.5 text-xs shadow-md">
            {boundaryToast}
          </div>
        </div>
      )}

      {!isTouchExperience && (
        <>
          {/* Shortcut bar */}
          <div className="border-border-light bg-dark flex flex-wrap items-center justify-center gap-3 border-t px-3 py-1.5">
            <KeycapGroup keys={["Esc"]} label="back" />
            <KeycapGroup keys={["H", "L"]} label="file" />
            <KeycapGroup keys={["J", "K"]} label="hunk" />
            <KeycapGroup keys={["↑", "↓"]} label="line" />
            <KeycapGroup keys={["Shift", "↑↓"]} label="select" />
            <KeycapGroup keys={["m"]} label="read" />
            <KeycapGroup keys={["u"]} label="undo" />
            <KeycapGroup keys={["⇧M"]} label="file read" />
            <KeycapGroup keys={["⇧C"]} label="comment" />
            <KeycapGroup keys={["⇧L", "⇧D"]} label="like / dislike" />
            <KeycapGroup keys={["Enter"]} label="submit" />
            <KeycapGroup keys={["Tab"]} label="notes" />
          </div>
        </>
      )}
    </div>
  );
};
