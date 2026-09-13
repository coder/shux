/**
 * DiffRenderer - Shared diff rendering component
 * Used by FileEditToolCall for read-only diff display.
 * ReviewPanel and ImmersiveReviewView both use SelectableDiffRenderer for
 * interactive line selection.
 */

import React, { useEffect, useMemo, useState } from "react";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { getLanguageFromPath } from "@/common/utils/git/languageDetector";
import { useOverflowDetection } from "@/browser/hooks/useOverflowDetection";
import { MessageSquare } from "lucide-react";
import { InlineReviewNote, type ReviewActionCallbacks } from "./InlineReviewNote";
import { groupDiffLines } from "@/browser/utils/highlighting/diffChunking";
import { useTheme, type ThemeMode } from "@/browser/contexts/ThemeContext";
import {
  escapeHtml,
  highlightDiffChunks,
  type HighlightedChunk,
} from "@/browser/utils/highlighting/highlightDiffChunk";
import { LRUCache } from "lru-cache";
import {
  highlightSearchMatches,
  type SearchHighlightConfig,
} from "@/browser/utils/highlighting/highlightSearchTerms";
import {
  parseReviewLineRange,
  type ParsedReviewLineRange,
  type Review,
  type ReviewNoteData,
} from "@/common/types/review";

// Shared type for diff line types
export type DiffLineType = "add" | "remove" | "context" | "header";

export type LineNumberMode = "both" | "old" | "new";

interface DiffLineStyles {
  tintBase: string | null;
  codeTintTransparentPct: number;
  gutterTintTransparentPct: number;
  contentColor: string;
}

const tint = (base: string, transparentPct: number): string =>
  `color-mix(in srgb, ${base}, transparent ${transparentPct}%)`;

const DIFF_LINE_STYLES: Record<DiffLineType, DiffLineStyles> = {
  add: {
    tintBase: "var(--color-success)",
    codeTintTransparentPct: 94,
    gutterTintTransparentPct: 86,
    contentColor: "var(--color-text)",
  },
  remove: {
    tintBase: "var(--color-danger)",
    codeTintTransparentPct: 94,
    gutterTintTransparentPct: 86,
    contentColor: "var(--color-text)",
  },
  header: {
    tintBase: "var(--color-accent)",
    codeTintTransparentPct: 95,
    gutterTintTransparentPct: 90,
    contentColor: "var(--color-accent-light)",
  },
  context: {
    tintBase: null,
    codeTintTransparentPct: 100,
    gutterTintTransparentPct: 100,
    contentColor: "var(--color-text-secondary)",
  },
};

// Helper function for the diff *code* background. This should stay relatively subtle.
const getDiffLineBackground = (type: DiffLineType): string => {
  const style = DIFF_LINE_STYLES[type];
  return style.tintBase ? tint(style.tintBase, style.codeTintTransparentPct) : "transparent";
};

// Helper function for the diff *gutter* background (line numbers / +/- area).
// This is intentionally more saturated than the code background for contrast.
// Context lines have no special background (same as code area).
const getDiffLineGutterBackground = (type: DiffLineType): string => {
  const style = DIFF_LINE_STYLES[type];
  return style.tintBase ? tint(style.tintBase, style.gutterTintTransparentPct) : "transparent";
};

// Helper function for getting line content color.
// Only headers/context are tinted; actual code stays the normal foreground color.
const getLineContentColor = (type: DiffLineType): string => DIFF_LINE_STYLES[type].contentColor;

// Split diff into lines while preserving indices.
// We only remove the trailing empty line if the input ends with a newline.
const splitDiffLines = (diff: string): string[] => {
  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

// Line number color - brighter for changed lines, dimmed for context.
const getLineNumberColor = (type: DiffLineType): string => {
  return type === "context"
    ? "color-mix(in srgb, var(--color-muted) 40%, transparent)"
    : "var(--color-text)";
};

// Indicator (+/-/space) character and color
const getIndicatorChar = (type: DiffLineType): string => {
  switch (type) {
    case "add":
      return "+";
    case "remove":
      return "−"; // Use proper minus sign for aesthetics
    default:
      return " ";
  }
};

const REVIEW_RANGE_TINT = "hsl(from var(--color-review-accent) h s l / 0.08)";

const applyReviewRangeOverlay = (base: string, isActive: boolean): string => {
  if (!isActive) return base;
  return `linear-gradient(${REVIEW_RANGE_TINT}, ${REVIEW_RANGE_TINT}), ${base}`;
};

const doesLineMatchReviewRange = (
  line: { oldLineNum: number | null; newLineNum: number | null },
  range: ParsedReviewLineRange
): boolean => {
  const matchesOld = Boolean(
    range.old &&
    line.oldLineNum !== null &&
    line.oldLineNum >= range.old.start &&
    line.oldLineNum <= range.old.end
  );

  const matchesNew = Boolean(
    range.new &&
    line.newLineNum !== null &&
    line.newLineNum >= range.new.start &&
    line.newLineNum <= range.new.end
  );

  return matchesOld || matchesNew;
};

const getIndicatorColor = (type: DiffLineType): string => {
  switch (type) {
    case "add":
      return "var(--color-success)";
    case "remove":
      return "var(--color-danger)";
    default:
      return "transparent";
  }
};

// Shared line number widths interface
interface LineNumberWidths {
  oldWidthCh: number;
  newWidthCh: number;
}

const getLineNumberModeFlags = (lineNumberMode: LineNumberMode) => ({
  showOld: lineNumberMode !== "new",
  showNew: lineNumberMode !== "old",
});

/**
 * Calculate minimum column widths needed to display line numbers.
 * Works with any iterable of lines that have old/new line number properties.
 */
function calculateLineNumberWidths(
  lines: Iterable<{ oldLineNum: number | null; newLineNum: number | null }>,
  lineNumberMode: LineNumberMode
): LineNumberWidths {
  let oldWidthCh = 0;
  let newWidthCh = 0;
  const { showOld, showNew } = getLineNumberModeFlags(lineNumberMode);

  for (const line of lines) {
    if (showOld && line.oldLineNum !== null) {
      oldWidthCh = Math.max(oldWidthCh, String(line.oldLineNum).length);
    }
    if (showNew && line.newLineNum !== null) {
      newWidthCh = Math.max(newWidthCh, String(line.newLineNum).length);
    }
  }

  return {
    oldWidthCh: showOld ? Math.max(2, oldWidthCh) : 0,
    newWidthCh: showNew ? Math.max(2, newWidthCh) : 0,
  };
}

// Shared line gutter component (line numbers) - renders as a CSS Grid cell
interface DiffLineGutterProps {
  type: DiffLineType;
  oldLineNum: number | null;
  newLineNum: number | null;
  showLineNumbers: boolean;
  lineNumberMode: LineNumberMode;
  lineNumberWidths: LineNumberWidths;
  background?: string;
}

const DiffLineGutter: React.FC<DiffLineGutterProps> = ({
  type,
  oldLineNum,
  newLineNum,
  showLineNumbers,
  lineNumberMode,
  lineNumberWidths,
  background,
}) => {
  const { showOld, showNew } = getLineNumberModeFlags(lineNumberMode);
  const resolvedBackground = background ?? getDiffLineGutterBackground(type);

  return (
    <span
      className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"
      style={{ background: resolvedBackground }}
    >
      {showLineNumbers && (
        <>
          {showOld && (
            <span
              className="text-right"
              style={{
                width: `${lineNumberWidths.oldWidthCh}ch`,
                color: getLineNumberColor(type),
              }}
            >
              {oldLineNum ?? ""}
            </span>
          )}
          {showNew && (
            <span
              className={showOld ? "ml-3 text-right" : "text-right"}
              style={{
                width: `${lineNumberWidths.newWidthCh}ch`,
                color: getLineNumberColor(type),
              }}
            >
              {newLineNum ?? ""}
            </span>
          )}
        </>
      )}
    </span>
  );
};

// Shared indicator component (+/- with optional hover replacement) - renders as a CSS Grid cell
interface DiffIndicatorProps {
  type: DiffLineType;
  /** Background color for this cell (matches code background) */
  background: string;
  /** Render review button overlay on hover */
  reviewButton?: React.ReactNode;
  /** When provided, enables drag-to-select behavior in SelectableDiffRenderer */
  onMouseDown?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLSpanElement>;
  isInteractive?: boolean;
  lineIndex?: number;
}

const DiffIndicator: React.FC<DiffIndicatorProps> = ({
  type,
  background,
  reviewButton,
  onMouseDown,
  onMouseEnter,
  isInteractive,
  lineIndex,
}) => (
  <span
    data-diff-indicator={true}
    data-line-index={lineIndex}
    className={cn("relative text-center select-none", isInteractive && "cursor-pointer")}
    style={{ background }}
    onMouseDown={onMouseDown}
    onMouseEnter={onMouseEnter}
  >
    <span
      className={cn("transition-opacity", reviewButton && "group-hover:opacity-0")}
      style={{ color: getIndicatorColor(type) }}
    >
      {getIndicatorChar(type)}
    </span>
    {reviewButton}
  </span>
);

/**
 * Container component for diff rendering - exported for custom diff displays
 * Used by FileEditToolCall for wrapping custom diff content
 *
 * Uses CSS Grid for layout alignment:
 * - Column 1 (gutter): auto-sized to fit line numbers
 * - Column 2 (indicator): fixed 1rem for +/- symbols
 * - Column 3 (code): fills remaining space
 *
 * This ensures PaddingStrip alignment matches diff lines by construction,
 * without any JS-side width calculations.
 */
export const DiffContainer: React.FC<
  React.PropsWithChildren<{
    fontSize?: string;
    maxHeight?: string;
    className?: string;
    /** Type of the first line in the diff (for top padding background) */
    firstLineType?: DiffLineType;
    /** Type of the last line in the diff (for bottom padding background) */
    lastLineType?: DiffLineType;
  }>
> = ({ children, fontSize, maxHeight, className, firstLineType, lastLineType }) => {
  const resolvedMaxHeight = maxHeight ?? "400px";
  const [isExpanded, setIsExpanded] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const clampContent = resolvedMaxHeight !== "none" && !isExpanded;

  React.useEffect(() => {
    if (maxHeight === "none") {
      setIsExpanded(false);
    }
  }, [maxHeight]);

  // Use RAF-throttled overflow detection to avoid forced reflows during React commit
  const isOverflowing = useOverflowDetection(contentRef, { enabled: clampContent });
  const showOverflowControls = clampContent && isOverflowing;

  // PaddingStrip uses CSS Grid columns to align with diff lines:
  // - Gutter cell (col 1): saturated background
  // - Code cells (cols 2-3): less saturated background
  // Alignment is guaranteed by CSS Grid - no width calculation needed.
  const PaddingStrip = ({ lineType }: { lineType?: DiffLineType }) => (
    <>
      <div
        className="h-1.5"
        style={{ background: lineType ? getDiffLineGutterBackground(lineType) : undefined }}
      />
      <div
        className="col-span-2 h-1.5"
        style={{ background: lineType ? getDiffLineBackground(lineType) : undefined }}
      />
    </>
  );

  return (
    <div
      className={cn(
        "relative m-0 overflow-x-auto rounded-sm border border-border-light bg-code-bg [&_*]:text-[inherit]",
        className
      )}
    >
      <div
        ref={contentRef}
        className={cn(
          "font-monospace grid",
          clampContent ? "overflow-y-hidden" : "overflow-y-visible",
          showOverflowControls && "pb-6"
        )}
        style={{
          fontSize: fontSize ?? "12px",
          lineHeight: 1.4,
          maxHeight: clampContent ? resolvedMaxHeight : undefined,
          // CSS Grid columns: [gutter] auto | [indicator] 1rem | [code] 1fr
          gridTemplateColumns: "auto 1rem 1fr",
          // Ensure grid expands to content width so backgrounds span full width when scrolling
          minWidth: "max-content",
        }}
      >
        <PaddingStrip lineType={firstLineType} />
        {children}
        <PaddingStrip lineType={lastLineType} />
      </div>

      {showOverflowControls && (
        <>
          <div className="via-[color-mix(in srgb, var(--color-code-bg) 80%, transparent)] pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--color-code-bg)] to-transparent" />
          <div className="absolute inset-x-0 bottom-0 flex justify-center pb-1.5">
            <button
              className="bg-dark/60 text-foreground/80 hover:text-foreground border border-white/20 px-2 py-0.5 text-[10px] tracking-wide uppercase backdrop-blur transition hover:border-white/40"
              onClick={() => setIsExpanded(true)}
            >
              Expand diff
            </button>
          </div>
        </>
      )}
    </div>
  );
};

interface DiffRendererProps {
  /** Raw diff content with +/- prefixes */
  content: string;
  /** Whether to show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Which line numbers to show when enabled (default: "both") */
  lineNumberMode?: LineNumberMode;
  /** Starting old line number for context */
  oldStart?: number;
  /** Starting new line number for context */
  newStart?: number;
  /** File path for language detection (optional, enables syntax highlighting) */
  filePath?: string;
  /** Font size for diff content (default: "12px") */
  fontSize?: string;
  /** Max height for diff container (default: "400px", use "none" for no limit) */
  maxHeight?: string;
  /** Additional className for container (e.g., "rounded-none" to remove rounding) */
  className?: string;
}

/**
 * Module-level cache for fully-highlighted diff results.
 * Key: `${contentHash}:${content.length}:${oldStart}:${newStart}:${language}:${themeMode}`
 *
 * This allows synchronous cache hits, avoiding visible plain-text-to-token-color
 * swaps when immersive review preloads a full-file overlay before rendering it.
 */
const highlightedDiffCache = new LRUCache<string, HighlightedChunk[]>({
  max: 10000, // High limit - rely on maxSize for eviction
  maxSize: 4 * 1024 * 1024, // 4MB total
  sizeCalculation: (chunks) =>
    chunks.reduce(
      (total, chunk) =>
        total + chunk.lines.reduce((lineTotal, line) => lineTotal + line.html.length * 2, 0),
      0
    ),
});

const highlightedDiffInFlight = new Map<string, Promise<HighlightedChunk[]>>();

// Fast string hash (djb2 algorithm) - O(n) but very low constant factor
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

function getDiffCacheKey(
  content: string,
  language: string,
  oldStart: number,
  newStart: number,
  themeMode: ThemeMode
): string {
  // Use hash of full content to avoid collisions where diffs differ only in the middle
  // (e.g., deletion vs addition of same line - only the +/- prefix differs)
  const contentHash = hashString(content);
  return `${contentHash}:${content.length}:${oldStart}:${newStart}:${language}:${themeMode}`;
}

/** Synchronous plain-text chunks for instant rendering (no "Processing..." flash) */
function createPlainTextChunks(
  content: string,
  oldStart: number,
  newStart: number
): HighlightedChunk[] {
  const lines = splitDiffLines(content);
  return groupDiffLines(lines, oldStart, newStart).map((chunk) => ({
    type: chunk.type,
    lines: chunk.lines.map((line, i) => ({
      html: escapeHtml(line),
      oldLineNumber: chunk.oldLineNumbers[i],
      newLineNumber: chunk.newLineNumbers[i],
      originalIndex: chunk.startIndex + i,
    })),
    usedFallback: true,
  }));
}

interface HighlightedDiffRequest {
  content: string;
  language: string;
  oldStart: number;
  newStart: number;
  themeMode: ThemeMode;
}

async function loadHighlightedDiff(request: HighlightedDiffRequest): Promise<HighlightedChunk[]> {
  const cacheKey = getDiffCacheKey(
    request.content,
    request.language,
    request.oldStart,
    request.newStart,
    request.themeMode
  );
  const cached = highlightedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = highlightedDiffInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const highlightPromise = (async () => {
    const lines = splitDiffLines(request.content);
    const diffChunks = groupDiffLines(lines, request.oldStart, request.newStart);
    const highlighted = await highlightDiffChunks(diffChunks, request.language, request.themeMode);
    highlightedDiffCache.set(cacheKey, highlighted);
    return highlighted;
  })();

  highlightedDiffInFlight.set(cacheKey, highlightPromise);
  try {
    return await highlightPromise;
  } finally {
    if (highlightedDiffInFlight.get(cacheKey) === highlightPromise) {
      highlightedDiffInFlight.delete(cacheKey);
    }
  }
}

export async function preloadHighlightedDiff(options: {
  content: string;
  filePath: string | null;
  oldStart?: number;
  newStart?: number;
  themeMode: ThemeMode;
}): Promise<void> {
  const language = options.filePath ? getLanguageFromPath(options.filePath) : "text";
  await loadHighlightedDiff({
    content: options.content,
    language,
    oldStart: options.oldStart ?? 1,
    newStart: options.newStart ?? 1,
    themeMode: options.themeMode,
  });
}

interface HighlightedDiffState {
  cacheKey: string;
  chunks: HighlightedChunk[];
  isSettled: boolean;
}

function isPlainTextLanguage(language: string): boolean {
  return language === "text" || language === "plaintext";
}

/**
 * Hook to highlight diff content. Returns plain-text immediately, then upgrades
 * to syntax-highlighted when ready. Never returns null (no loading flash).
 */
function useHighlightedDiff(
  content: string,
  language: string,
  oldStart: number,
  newStart: number,
  themeMode: ThemeMode
): HighlightedDiffState {
  const cacheKey = useMemo(
    () => getDiffCacheKey(content, language, oldStart, newStart, themeMode),
    [content, language, oldStart, newStart, themeMode]
  );
  const cachedResult = highlightedDiffCache.get(cacheKey);
  const isPlainText = isPlainTextLanguage(language);

  // Sync fallback: plain-text chunks for instant render. Cache hits return the
  // preloaded highlighted chunks directly so tooltip/selection state inside the
  // renderer does not rebuild a throwaway full-file fallback on every local render.
  const plainText = useMemo(
    () => cachedResult ?? createPlainTextChunks(content, oldStart, newStart),
    [cachedResult, content, oldStart, newStart]
  );

  const [state, setState] = useState<HighlightedDiffState>(() => ({
    cacheKey,
    chunks: cachedResult ?? plainText,
    isSettled: cachedResult != null || isPlainText,
  }));

  useEffect(() => {
    const setHighlightedState = (nextState: HighlightedDiffState) => {
      setState((currentState) => {
        if (
          currentState.cacheKey === nextState.cacheKey &&
          currentState.chunks === nextState.chunks &&
          currentState.isSettled === nextState.isSettled
        ) {
          return currentState;
        }
        return nextState;
      });
    };

    const cached = highlightedDiffCache.get(cacheKey);
    if (cached) {
      setHighlightedState({ cacheKey, chunks: cached, isSettled: true });
      return;
    }

    if (isPlainText) {
      setHighlightedState({ cacheKey, chunks: plainText, isSettled: true });
      return;
    }

    // Show plain text immediately unless a caller preloaded this diff into the cache.
    setHighlightedState({ cacheKey, chunks: plainText, isSettled: false });

    let cancelled = false;
    loadHighlightedDiff({ content, language, oldStart, newStart, themeMode })
      .then((highlighted) => {
        if (!cancelled) {
          setHighlightedState({ cacheKey, chunks: highlighted, isSettled: true });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedState({ cacheKey, chunks: plainText, isSettled: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, content, isPlainText, language, oldStart, newStart, themeMode, plainText]);

  if (cachedResult) {
    return { cacheKey, chunks: cachedResult, isSettled: true };
  }

  if (state.cacheKey === cacheKey) {
    return state;
  }

  return { cacheKey, chunks: plainText, isSettled: isPlainText };
}

/**
 * DiffRenderer - Renders diff content with consistent styling
 *
 * Expects content with standard diff format:
 * - Lines starting with '+' are additions (green)
 * - Lines starting with '-' are removals (red)
 * - Lines starting with ' ' or anything else are context
 * - Lines starting with '@@' are headers (blue)
 */
export const DiffRenderer: React.FC<DiffRendererProps> = ({
  content,
  showLineNumbers = true,
  lineNumberMode = "both",
  oldStart = 1,
  newStart = 1,
  filePath,
  fontSize,
  maxHeight,
  className,
}) => {
  // Detect language for syntax highlighting (memoized to prevent repeated detection)
  const { theme } = useTheme();
  const language = React.useMemo(
    () => (filePath ? getLanguageFromPath(filePath) : "text"),
    [filePath]
  );

  const highlightedDiff = useHighlightedDiff(content, language, oldStart, newStart, theme);
  const highlightedChunks = highlightedDiff.chunks;

  const lineNumberWidths = React.useMemo(() => {
    if (!showLineNumbers) {
      return { oldWidthCh: 2, newWidthCh: 2 };
    }
    // Flatten chunks and map HighlightedLine property names to common interface
    const lines = highlightedChunks.flatMap((chunk) =>
      chunk.lines.map((line) => ({
        oldLineNum: line.oldLineNumber,
        newLineNum: line.newLineNumber,
      }))
    );
    return calculateLineNumberWidths(lines, lineNumberMode);
  }, [highlightedChunks, showLineNumbers, lineNumberMode]);

  // Get first and last line types for padding background colors
  const firstLineType = highlightedChunks[0]?.type;
  const lastLineType = highlightedChunks[highlightedChunks.length - 1]?.type;

  return (
    <DiffContainer
      fontSize={fontSize}
      maxHeight={maxHeight}
      className={className}
      firstLineType={firstLineType}
      lastLineType={lastLineType}
    >
      {highlightedChunks.flatMap((chunk) =>
        chunk.lines.map((line) => {
          const codeBg = getDiffLineBackground(chunk.type);
          // Each line renders as 3 CSS Grid cells: gutter | indicator | code
          return (
            <React.Fragment key={line.originalIndex}>
              <DiffLineGutter
                type={chunk.type}
                oldLineNum={line.oldLineNumber}
                newLineNum={line.newLineNumber}
                showLineNumbers={showLineNumbers}
                lineNumberMode={lineNumberMode}
                lineNumberWidths={lineNumberWidths}
              />
              <DiffIndicator type={chunk.type} background={codeBg} />
              {/* SECURITY AUDIT: line.html comes from Shiki token output or escapeHtml fallback.
                  User/repo text is escaped before insertion and search highlighting only wraps text nodes. */}
              <span
                className="min-w-0 whitespace-pre [&_span:not(.search-highlight)]:!bg-transparent"
                style={{
                  background: codeBg,
                  color: getLineContentColor(chunk.type),
                }}
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
            </React.Fragment>
          );
        })
      )}
    </DiffContainer>
  );
};

// Selectable version of DiffRenderer for Code Review
interface SelectableDiffRendererProps extends Omit<DiffRendererProps, "filePath"> {
  /** File path for generating review notes */
  filePath: string;
  /** Reviews for this file to render inline next to matching lines */
  inlineReviews?: Review[];
  /** Callback when user submits a review note with structured data */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Callback when user clicks on a line (to activate parent hunk) */
  onLineClick?: () => void;
  /** Search highlight configuration (optional) */
  searchConfig?: SearchHighlightConfig;
  /** Enable syntax highlighting (default: true). Set to false to skip highlighting for off-screen hunks */
  enableHighlighting?: boolean;
  /** Callback when the current diff has finished syntax highlighting or fallback. */
  onHighlightSettledChange?: (isSettled: boolean) => void;
  /** Callback when review note composition state changes (selection active/inactive) */
  onComposingChange?: (isComposing: boolean) => void;
  /** Action callbacks for inline review notes (edit, check, delete, etc.) */
  reviewActions?: ReviewActionCallbacks;
  /** Active line for immersive keyboard navigation */
  activeLineIndex?: number | null;
  /** Selected line range for immersive keyboard navigation */
  selectedLineRange?: LineSelection | null;
  /** Called when user selects a line via click in immersive mode */
  onLineIndexSelect?: (lineIndex: number, shiftKey: boolean) => void;
  /** External request to open/update inline composer at a specific line selection */
  externalSelectionRequest?: {
    requestId: number;
    selection: LineSelection;
    initialNoteText?: string;
    /** Which display line to render the composer after (defaults to selection bottom) */
    composerAfterIndex?: number;
  } | null;
  /** External request to open an existing inline review note in edit mode */
  externalEditRequest?: {
    requestId: number;
    reviewId: string;
  } | null;
  /** Callback when the inline composer is canceled (for parent/child sync). */
  onComposerCancel?: () => void;
}

interface LineSelection {
  startIndex: number;
  endIndex: number;
}

// CSS class for diff line wrapper - used by arbitrary selector in CommentButton
const SELECTABLE_DIFF_LINE_CLASS = "selectable-diff-line";

// Separate component to prevent re-rendering diff lines on every keystroke
interface ReviewNoteInputProps {
  selection: LineSelection;
  lineData: Array<{
    index: number;
    type: DiffLineType;
    oldLineNum: number | null;
    newLineNum: number | null;
    raw: string; // Original line with +/- prefix
  }>;
  filePath: string;
  showLineNumbers: boolean;
  lineNumberMode: LineNumberMode;
  lineNumberWidths: { oldWidthCh: number; newWidthCh: number };
  onSubmit: (data: ReviewNoteData) => void;
  onCancel: () => void;
  initialNoteText?: string;
}

const ReviewNoteInput: React.FC<ReviewNoteInputProps> = React.memo(
  ({
    selection,
    lineData,
    filePath,
    showLineNumbers,
    lineNumberMode,
    lineNumberWidths,
    onSubmit,
    onCancel,
    initialNoteText,
  }) => {
    const { showOld, showNew } = getLineNumberModeFlags(lineNumberMode);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    // Keep the composer uncontrolled so typing does not trigger per-key React re-renders
    // through immersive diff overlays. Parent-initiated prefill changes are synced here.
    React.useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.value = initialNoteText ?? "";
    }, [initialNoteText]);

    // Auto-focus on mount.
    React.useEffect(() => {
      textareaRef.current?.focus();
    }, []);

    const handleSubmit = () => {
      const text = textareaRef.current?.value ?? "";
      if (!text.trim()) return;

      const [start, end] = [selection.startIndex, selection.endIndex].sort((a, b) => a - b);
      const selectedLineData = lineData.slice(start, end + 1);

      const oldLineNumbers = selectedLineData
        .map((lineInfo) => lineInfo.oldLineNum)
        .filter((lineNum): lineNum is number => lineNum !== null);
      const newLineNumbers = selectedLineData
        .map((lineInfo) => lineInfo.newLineNum)
        .filter((lineNum): lineNum is number => lineNum !== null);

      const formatRange = (nums: number[]) => {
        if (nums.length === 0) return null;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        return min === max ? `${min}` : `${min}-${max}`;
      };

      const oldRange = formatRange(oldLineNumbers);
      const newRange = formatRange(newLineNumbers);
      const lineRange = [oldRange ? `-${oldRange}` : null, newRange ? `+${newRange}` : null]
        .filter((part): part is string => Boolean(part))
        .join(" ");

      const oldWidth = Math.max(1, ...oldLineNumbers.map((n) => String(n).length));
      const newWidth = Math.max(1, ...newLineNumbers.map((n) => String(n).length));

      const allLines = selectedLineData.map((lineInfo) => {
        const indicator = lineInfo.raw[0] ?? " "; // +, -, or space
        const content = lineInfo.raw.slice(1); // Remove the indicator

        const oldStr = lineInfo.oldLineNum === null ? "" : String(lineInfo.oldLineNum);
        const newStr = lineInfo.newLineNum === null ? "" : String(lineInfo.newLineNum);

        return `${oldStr.padStart(oldWidth)} ${newStr.padStart(newWidth)} ${indicator} ${content}`;
      });

      // Elide middle lines if more than 20 lines selected (show 10 at start, 10 at end)
      let selectedCode: string;
      const CONTEXT_LINES = 10;
      const MAX_FULL_LINES = CONTEXT_LINES * 2;
      if (allLines.length <= MAX_FULL_LINES) {
        selectedCode = allLines.join("\n");
      } else {
        const omittedCount = allLines.length - MAX_FULL_LINES;
        selectedCode = [
          ...allLines.slice(0, CONTEXT_LINES),
          `    (${omittedCount} lines omitted)`,
          ...allLines.slice(-CONTEXT_LINES),
        ].join("\n");
      }

      const selectedDiff = selectedLineData.map((lineInfo) => lineInfo.raw).join("\n");
      const oldStart = oldLineNumbers.length ? Math.min(...oldLineNumbers) : 1;
      const newStart = newLineNumbers.length ? Math.min(...newLineNumbers) : 1;

      // Pass structured data instead of formatted message
      onSubmit({
        filePath,
        lineRange,
        selectedCode,
        selectedDiff,
        oldStart,
        newStart,
        userNote: text.trim(),
      });
    };

    // Determine the predominant line type for background matching
    const [start, end] = [selection.startIndex, selection.endIndex].sort((a, b) => a - b);
    const selectedTypes = lineData.slice(start, end + 1).map((l) => l.type);
    // Use the last selected line's type (where the input appears)
    const lineType = selectedTypes[selectedTypes.length - 1] ?? "context";

    const codeBg = getDiffLineBackground(lineType);

    // Renders as a subgrid row with 3 cells to align with diff lines: gutter | indicator | input
    return (
      <div className="col-span-3 grid min-w-0 grid-cols-subgrid">
        {/* Gutter spacer to align with diff lines */}
        <span
          className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"
          style={{ background: getDiffLineGutterBackground(lineType) }}
        >
          {showLineNumbers && (
            <>
              {showOld && <span style={{ width: `${lineNumberWidths.oldWidthCh}ch` }} />}
              {showNew && (
                <span
                  className={showOld ? "ml-3" : undefined}
                  style={{ width: `${lineNumberWidths.newWidthCh}ch` }}
                />
              )}
            </>
          )}
        </span>
        {/* Indicator spacer */}
        <span style={{ background: codeBg }} />
        {/* Input container with accent styling */}
        <div className="min-w-0 py-1.5 pr-3 [contain:inline-size]" style={{ background: codeBg }}>
          <div
            className="flex w-full overflow-hidden rounded border border-[var(--color-review-accent)]/30 shadow-sm"
            style={{
              background: "hsl(from var(--color-review-accent) h s l / 0.08)",
              maxWidth: "min(560px, calc(100vw - 8rem))",
            }}
          >
            {/* Left accent bar */}
            <div
              className="w-[3px] shrink-0"
              style={{ background: "var(--color-review-accent)" }}
            />
            {/* Avoid JS autosize here. Reading scrollHeight on every input forces layout across
                large immersive diffs, which can make each typed character feel delayed. */}
            <textarea
              ref={textareaRef}
              className="text-primary placeholder:text-muted/70 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-[12px] leading-[1.5] transition-colors focus:outline-none"
              style={{
                minHeight: "calc(12px * 1.5 * 3 + 12px)",
                maxHeight: "12rem",
              }}
              placeholder="Add a review note… (Enter to submit, Shift+Enter for newline, Esc to cancel)"
              defaultValue={initialNoteText ?? ""}
              rows={3}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                stopKeyboardPropagation(e);

                const isEnter = e.key === "Enter" || e.keyCode === 13;
                const isEscape = e.key === "Escape" || e.keyCode === 27;

                if (isEnter) {
                  if (e.shiftKey) {
                    // Shift+Enter: allow newline (default behavior)
                    return;
                  }
                  // Enter: submit
                  e.preventDefault();
                  handleSubmit();
                } else if (isEscape) {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
            <button
              type="button"
              className="text-muted hover:text-primary shrink-0 px-2"
              aria-label="Submit review note"
              onClick={(e) => {
                e.stopPropagation();
                handleSubmit();
              }}
            >
              ↵
            </button>
          </div>
        </div>
      </div>
    );
  }
);

ReviewNoteInput.displayName = "ReviewNoteInput";

interface InlineReviewNoteRowProps {
  review: Review;
  lineType: DiffLineType;
  showLineNumbers: boolean;
  lineNumberMode: LineNumberMode;
  lineNumberWidths: LineNumberWidths;
  /** Optional action callbacks for review actions */
  reviewActions?: ReviewActionCallbacks;
  /** Request id that should trigger this note to enter edit mode */
  editRequestId?: number | null;
}

const InlineReviewNoteRow: React.FC<InlineReviewNoteRowProps> = React.memo(
  ({
    review,
    lineType,
    showLineNumbers,
    lineNumberMode,
    lineNumberWidths,
    reviewActions,
    editRequestId,
  }) => {
    const codeBg = getDiffLineBackground(lineType);
    const { showOld, showNew } = getLineNumberModeFlags(lineNumberMode);

    return (
      <div
        className="col-span-3 grid min-w-0 grid-cols-subgrid"
        data-inline-review-note={true}
        data-review-id={review.id}
      >
        {/* Gutter spacer to align with diff lines */}
        <span
          className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"
          style={{ background: getDiffLineGutterBackground(lineType) }}
        >
          {showLineNumbers && (
            <>
              {showOld && <span style={{ width: `${lineNumberWidths.oldWidthCh}ch` }} />}
              {showNew && (
                <span
                  className={showOld ? "ml-3" : undefined}
                  style={{ width: `${lineNumberWidths.newWidthCh}ch` }}
                />
              )}
            </>
          )}
        </span>
        {/* Indicator spacer */}
        <span style={{ background: codeBg }} />
        {/* Inline note using shared component */}
        <div className="min-w-0 py-0.5 pr-3 [contain:inline-size]" style={{ background: codeBg }}>
          <InlineReviewNote
            review={review}
            showFilePath={false}
            actions={reviewActions}
            editRequestId={editRequestId}
          />
        </div>
      </div>
    );
  }
);

InlineReviewNoteRow.displayName = "InlineReviewNoteRow";

export const SelectableDiffRenderer = React.memo<SelectableDiffRendererProps>(
  ({
    content,
    showLineNumbers = true,
    lineNumberMode = "both",
    oldStart = 1,
    newStart = 1,
    filePath,
    inlineReviews,
    fontSize,
    maxHeight,
    className,
    onReviewNote,
    onLineClick,
    searchConfig,
    enableHighlighting = true,
    onHighlightSettledChange,
    onComposingChange,
    reviewActions,
    activeLineIndex,
    selectedLineRange,
    onLineIndexSelect,
    externalSelectionRequest,
    externalEditRequest,
    onComposerCancel,
  }) => {
    const dragAnchorRef = React.useRef<number | null>(null);
    const dragUpdateFrameRef = React.useRef<number | null>(null);
    const pendingDragLineIndexRef = React.useRef<number | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const [selection, setSelection] = React.useState<LineSelection | null>(null);
    const [selectionInitialNoteText, setSelectionInitialNoteText] = React.useState("");

    const flushPendingDragSelection = React.useCallback(() => {
      const anchorIndex = dragAnchorRef.current;
      const pendingLineIndex = pendingDragLineIndexRef.current;
      if (anchorIndex === null || pendingLineIndex === null) {
        return;
      }

      pendingDragLineIndexRef.current = null;
      onLineIndexSelect?.(pendingLineIndex, true);
      setSelection((previousSelection) => {
        if (
          previousSelection?.startIndex === anchorIndex &&
          previousSelection?.endIndex === pendingLineIndex
        ) {
          return previousSelection;
        }

        return { startIndex: anchorIndex, endIndex: pendingLineIndex };
      });
    }, [onLineIndexSelect]);

    const scheduleDragSelectionUpdate = React.useCallback(
      (lineIndex: number) => {
        pendingDragLineIndexRef.current = lineIndex;

        if (dragUpdateFrameRef.current !== null) {
          return;
        }

        dragUpdateFrameRef.current = window.requestAnimationFrame(() => {
          dragUpdateFrameRef.current = null;
          flushPendingDragSelection();
        });
      },
      [flushPendingDragSelection]
    );

    React.useEffect(() => {
      const stopDragging = () => {
        if (dragUpdateFrameRef.current !== null) {
          cancelAnimationFrame(dragUpdateFrameRef.current);
          dragUpdateFrameRef.current = null;
        }

        flushPendingDragSelection();
        setIsDragging(false);
        dragAnchorRef.current = null;
        pendingDragLineIndexRef.current = null;
      };

      window.addEventListener("mouseup", stopDragging);
      window.addEventListener("blur", stopDragging);

      return () => {
        window.removeEventListener("mouseup", stopDragging);
        window.removeEventListener("blur", stopDragging);
      };
    }, [flushPendingDragSelection]);

    React.useEffect(() => {
      return () => {
        if (dragUpdateFrameRef.current !== null) {
          cancelAnimationFrame(dragUpdateFrameRef.current);
        }
      };
    }, []);

    const { theme } = useTheme();

    const lastExternalSelectionRequestIdRef = React.useRef<number | null>(null);
    const dismissedExternalSelectionRequestIdRef = React.useRef<number | null>(null);

    React.useEffect(() => {
      if (!externalSelectionRequest) {
        if (lastExternalSelectionRequestIdRef.current !== null) {
          lastExternalSelectionRequestIdRef.current = null;
          setSelection(null);
          setSelectionInitialNoteText("");
        }
        return;
      }

      // If the composer was closed for this request ID, keep it dismissed even
      // if the parent prop lingers and re-renders before clearing.
      if (dismissedExternalSelectionRequestIdRef.current === externalSelectionRequest.requestId) {
        return;
      }

      // Reset only when a new request arrives; selection churn from the parent
      // for the same request should not wipe an in-progress composer draft.
      if (lastExternalSelectionRequestIdRef.current === externalSelectionRequest.requestId) {
        return;
      }

      lastExternalSelectionRequestIdRef.current = externalSelectionRequest.requestId;
      setSelection({
        startIndex: externalSelectionRequest.selection.startIndex,
        endIndex: externalSelectionRequest.selection.endIndex,
      });
      setSelectionInitialNoteText(externalSelectionRequest.initialNoteText ?? "");
    }, [externalSelectionRequest]);

    // Render newly-issued external composer requests immediately so immersive actions
    // don't show a one-frame delay while local state catches up in the effect above.
    const pendingExternalSelectionRequest =
      externalSelectionRequest &&
      dismissedExternalSelectionRequestIdRef.current !== externalSelectionRequest.requestId &&
      lastExternalSelectionRequestIdRef.current !== externalSelectionRequest.requestId
        ? externalSelectionRequest
        : null;

    const renderSelection: LineSelection | null =
      pendingExternalSelectionRequest?.selection ?? selection;
    // Where to render the composer: cursor position if provided, else selection bottom
    const composerAfterIndex: number | undefined = (
      pendingExternalSelectionRequest ?? externalSelectionRequest
    )?.composerAfterIndex;
    const renderNoteText = pendingExternalSelectionRequest
      ? (pendingExternalSelectionRequest.initialNoteText ?? "")
      : selectionInitialNoteText;
    const renderSelectionStartIndex = renderSelection?.startIndex ?? null;

    // Notify parent when composition state changes
    const isComposing = renderSelection !== null;
    React.useEffect(() => {
      onComposingChange?.(isComposing);
    }, [isComposing, onComposingChange]);

    // On unmount, ensure we release the pause if we were composing
    // (separate effect with empty deps so cleanup only runs on unmount)
    React.useEffect(() => {
      return () => {
        onComposingChange?.(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only clean up on unmount
    }, []);

    // Detect language for syntax highlighting (memoized to prevent repeated detection)
    const language = React.useMemo(
      () => (filePath ? getLanguageFromPath(filePath) : "text"),
      [filePath]
    );

    // Only highlight if enabled (for viewport optimization)
    const highlightedDiff = useHighlightedDiff(
      content,
      enableHighlighting ? language : "text",
      oldStart,
      newStart,
      theme
    );
    const highlightedChunks = highlightedDiff.chunks;

    React.useEffect(() => {
      onHighlightSettledChange?.(highlightedDiff.isSettled);
    }, [highlightedDiff.isSettled, onHighlightSettledChange]);

    // Parse raw lines once for use in lineData
    const rawLines = React.useMemo(() => splitDiffLines(content), [content]);

    // Build lineData from highlighted chunks (memoized to prevent repeated parsing)
    // Includes raw content for review note submission
    const lineData = React.useMemo(() => {
      const data: Array<{
        index: number;
        type: DiffLineType;
        oldLineNum: number | null;
        newLineNum: number | null;
        html: string;
        raw: string; // Original line with +/- prefix
      }> = [];

      highlightedChunks.forEach((chunk) => {
        chunk.lines.forEach((line) => {
          data.push({
            index: line.originalIndex,
            type: chunk.type,
            oldLineNum: line.oldLineNumber,
            newLineNum: line.newLineNumber,
            html: line.html,
            raw: rawLines[line.originalIndex] ?? "",
          });
        });
      });

      return data;
    }, [highlightedChunks, rawLines]);

    // Memoize highlighted line data to avoid re-parsing HTML on every render
    // Only recalculate when lineData or searchConfig changes
    const highlightedLineData = React.useMemo(() => {
      if (!searchConfig) return lineData;

      return lineData.map((line) => ({
        ...line,
        html: highlightSearchMatches(line.html, searchConfig),
      }));
    }, [lineData, searchConfig]);

    const lineNumberWidths = React.useMemo(
      () =>
        showLineNumbers
          ? calculateLineNumberWidths(lineData, lineNumberMode)
          : { oldWidthCh: 2, newWidthCh: 2 },
      [lineData, showLineNumbers, lineNumberMode]
    );

    const parsedInlineReviews = React.useMemo<
      Array<{ review: Review; range: ParsedReviewLineRange }>
    >(() => {
      if (!inlineReviews?.length) return [];

      const parsed: Array<{ review: Review; range: ParsedReviewLineRange }> = [];

      for (const review of inlineReviews) {
        if (review.data?.filePath !== filePath) continue;

        const parsedRange = parseReviewLineRange(review.data?.lineRange ?? "");
        if (!parsedRange) continue;

        parsed.push({ review, range: parsedRange });
      }

      return parsed;
    }, [inlineReviews, filePath]);

    const { inlineReviewsByAnchor, reviewRangeByLineIndex } = React.useMemo<{
      inlineReviewsByAnchor: Map<number, Review[]>;
      reviewRangeByLineIndex: boolean[];
    }>(() => {
      if (!parsedInlineReviews.length) {
        return {
          inlineReviewsByAnchor: new Map<number, Review[]>(),
          reviewRangeByLineIndex: new Array<boolean>(lineData.length).fill(false),
        };
      }

      const anchored = new Map<number, Review[]>();
      const rangeMatches = new Array<boolean>(lineData.length).fill(false);

      for (const { review, range } of parsedInlineReviews) {
        let anchorIndex: number | null = null;

        for (let i = 0; i < lineData.length; i++) {
          const line = lineData[i];

          if (doesLineMatchReviewRange(line, range)) {
            rangeMatches[i] = true;
            anchorIndex = i;
          }
        }

        if (anchorIndex === null) continue;

        const existing = anchored.get(anchorIndex);
        if (existing) {
          existing.push(review);
        } else {
          anchored.set(anchorIndex, [review]);
        }
      }

      return {
        inlineReviewsByAnchor: anchored,
        reviewRangeByLineIndex: rangeMatches,
      };
    }, [lineData, parsedInlineReviews]);
    const startDragSelection = React.useCallback(
      (lineIndex: number, shiftKey: boolean) => {
        if (!onReviewNote) {
          return;
        }

        // Notify parent that this hunk should become active.
        onLineClick?.();
        onLineIndexSelect?.(lineIndex, shiftKey);

        if (dragUpdateFrameRef.current !== null) {
          cancelAnimationFrame(dragUpdateFrameRef.current);
          dragUpdateFrameRef.current = null;
        }
        pendingDragLineIndexRef.current = null;

        const anchor =
          shiftKey && renderSelectionStartIndex !== null ? renderSelectionStartIndex : lineIndex;
        dragAnchorRef.current = anchor;
        setIsDragging(true);
        setSelectionInitialNoteText("");
        setSelection((previousSelection) => {
          if (
            previousSelection?.startIndex === anchor &&
            previousSelection?.endIndex === lineIndex
          ) {
            return previousSelection;
          }

          return { startIndex: anchor, endIndex: lineIndex };
        });
      },
      [onLineClick, onLineIndexSelect, onReviewNote, renderSelectionStartIndex]
    );

    const updateDragSelection = React.useCallback(
      (lineIndex: number) => {
        if (!isDragging || dragAnchorRef.current === null) {
          return;
        }

        // Dragging can emit dozens of mouseenter events per second; coalesce updates
        // to one per animation frame so immersive line-range selection stays responsive.
        scheduleDragSelectionUpdate(lineIndex);
      },
      [isDragging, scheduleDragSelectionUpdate]
    );

    const handleCommentButtonClick = (lineIndex: number, shiftKey: boolean) => {
      // Keep immersive cursor/hunk selection in sync with inline comment actions.
      onLineClick?.();
      onLineIndexSelect?.(lineIndex, shiftKey);

      // Shift-click: extend existing selection
      if (shiftKey && renderSelection) {
        const start = renderSelection.startIndex;
        setSelectionInitialNoteText("");
        setSelection({
          startIndex: start,
          endIndex: lineIndex,
        });
        return;
      }

      // Regular click: start new selection
      setSelectionInitialNoteText("");
      setSelection({
        startIndex: lineIndex,
        endIndex: lineIndex,
      });
    };

    const handleSubmitNote = (data: ReviewNoteData) => {
      if (!onReviewNote) return;
      if (externalSelectionRequest) {
        dismissedExternalSelectionRequestIdRef.current = externalSelectionRequest.requestId;
      }
      onReviewNote(data);
      setSelection(null);
      setSelectionInitialNoteText("");
    };

    const handleCancelNote = () => {
      if (externalSelectionRequest) {
        dismissedExternalSelectionRequestIdRef.current = externalSelectionRequest.requestId;
      }
      setSelection(null);
      setSelectionInitialNoteText("");
      onComposerCancel?.();
    };

    const isLineInSelection = (index: number, lineSelection: LineSelection | null | undefined) => {
      if (!lineSelection) {
        return false;
      }

      const [start, end] = [lineSelection.startIndex, lineSelection.endIndex].sort((a, b) => a - b);
      return index >= start && index <= end;
    };

    // Get first and last line types for padding background colors
    const firstLineType = highlightedLineData[0]?.type;
    const lastLineType = highlightedLineData[highlightedLineData.length - 1]?.type;

    const cursorLikeOutlineColor = "hsl(from var(--color-review-accent) h s l / 0.45)";
    const normalizedSelectedLineRange = selectedLineRange
      ? {
          startIndex: Math.min(selectedLineRange.startIndex, selectedLineRange.endIndex),
          endIndex: Math.max(selectedLineRange.startIndex, selectedLineRange.endIndex),
        }
      : null;

    const isCursorHighlightedLine = (index: number): boolean =>
      index === activeLineIndex ||
      isLineInSelection(index, renderSelection) ||
      isLineInSelection(index, normalizedSelectedLineRange);

    const getCursorLikeOutlineStyle = (index: number): React.CSSProperties | undefined => {
      if (!isCursorHighlightedLine(index)) {
        return undefined;
      }

      const hasPrevHighlightedLine = index > 0 && isCursorHighlightedLine(index - 1);
      const hasNextHighlightedLine =
        index < highlightedLineData.length - 1 && isCursorHighlightedLine(index + 1);

      const edgeShadows = [
        `inset 1px 0 0 ${cursorLikeOutlineColor}`,
        `inset -1px 0 0 ${cursorLikeOutlineColor}`,
        hasPrevHighlightedLine ? null : `inset 0 1px 0 ${cursorLikeOutlineColor}`,
        hasNextHighlightedLine ? null : `inset 0 -1px 0 ${cursorLikeOutlineColor}`,
      ].filter((shadow): shadow is string => Boolean(shadow));

      return { boxShadow: edgeShadows.join(", ") };
    };

    return (
      <>
        <DiffContainer
          fontSize={fontSize}
          maxHeight={maxHeight}
          className={className}
          firstLineType={firstLineType}
          lastLineType={lastLineType}
        >
          {highlightedLineData.map((lineInfo, displayIndex) => {
            const isComposerSelected = isLineInSelection(displayIndex, renderSelection);
            const isRangeSelected = isLineInSelection(displayIndex, normalizedSelectedLineRange);
            const lineOutlineStyle = getCursorLikeOutlineStyle(displayIndex);
            const isInReviewRange = reviewRangeByLineIndex[displayIndex] ?? false;
            const baseCodeBg = getDiffLineBackground(lineInfo.type);
            const codeBg = applyReviewRangeOverlay(baseCodeBg, isInReviewRange);
            const gutterBg = applyReviewRangeOverlay(
              getDiffLineGutterBackground(lineInfo.type),
              isInReviewRange
            );
            const anchoredReviews = inlineReviewsByAnchor.get(displayIndex);

            // Each line renders as 3 CSS Grid cells: gutter | indicator | code
            // Use display:contents wrapper for selection state + group hover behavior
            return (
              <React.Fragment key={displayIndex}>
                <div
                  className={cn(
                    SELECTABLE_DIFF_LINE_CLASS,
                    "group relative col-span-3 grid grid-cols-subgrid",
                    onLineIndexSelect ? "cursor-pointer" : "cursor-text"
                  )}
                  style={lineOutlineStyle}
                  data-line-index={displayIndex}
                  data-selected={isComposerSelected || isRangeSelected ? "true" : "false"}
                  onClick={(e) => {
                    if (!onLineIndexSelect) {
                      return;
                    }
                    onLineClick?.();
                    onLineIndexSelect(displayIndex, e.shiftKey);
                  }}
                >
                  <DiffLineGutter
                    type={lineInfo.type}
                    oldLineNum={lineInfo.oldLineNum}
                    newLineNum={lineInfo.newLineNum}
                    showLineNumbers={showLineNumbers}
                    lineNumberMode={lineNumberMode}
                    lineNumberWidths={lineNumberWidths}
                    background={gutterBg}
                  />
                  <DiffIndicator
                    type={lineInfo.type}
                    background={codeBg}
                    lineIndex={displayIndex}
                    isInteractive={Boolean(onReviewNote ?? onLineIndexSelect)}
                    onMouseDown={(e) => {
                      if (!onReviewNote) return;
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      startDragSelection(displayIndex, e.shiftKey);
                    }}
                    onMouseEnter={() => {
                      if (!onReviewNote) return;
                      updateDragSelection(displayIndex);
                    }}
                    reviewButton={
                      onReviewNote && (
                        <>
                          {/* Both review panes share SelectableDiffRenderer, so keep the
                              review action inline without an extra floating tooltip
                              covering nearby lines. */}
                          <button
                            type="button"
                            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm text-[var(--color-review-accent)]/60 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:text-[var(--color-review-accent)] active:scale-90"
                            style={{ position: "absolute", inset: 0 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCommentButtonClick(displayIndex, e.shiftKey);
                            }}
                            aria-label="Add review comment"
                          >
                            <MessageSquare className="size-3" />
                          </button>
                        </>
                      )
                    }
                  />
                  {/* SECURITY AUDIT: lineInfo.html is derived from Shiki/escapeHtml output
                      (optionally transformed by text-node-only search highlighting). */}
                  <span
                    className="min-w-0 whitespace-pre [&_span:not(.search-highlight)]:!bg-transparent"
                    style={{
                      background: codeBg,
                      color: getLineContentColor(lineInfo.type),
                    }}
                    dangerouslySetInnerHTML={{ __html: lineInfo.html }}
                  />
                </div>

                {/* Show textarea after the current cursor line (selection end). */}
                {isComposerSelected &&
                  renderSelection &&
                  displayIndex === (composerAfterIndex ?? renderSelection.endIndex) && (
                    <ReviewNoteInput
                      selection={renderSelection}
                      lineData={lineData}
                      filePath={filePath}
                      showLineNumbers={showLineNumbers}
                      lineNumberMode={lineNumberMode}
                      lineNumberWidths={lineNumberWidths}
                      onSubmit={handleSubmitNote}
                      onCancel={handleCancelNote}
                      initialNoteText={renderNoteText}
                    />
                  )}

                {anchoredReviews?.map((review) => (
                  <InlineReviewNoteRow
                    key={review.id}
                    review={review}
                    lineType={lineInfo.type}
                    showLineNumbers={showLineNumbers}
                    lineNumberMode={lineNumberMode}
                    lineNumberWidths={lineNumberWidths}
                    reviewActions={reviewActions}
                    editRequestId={
                      externalEditRequest?.reviewId === review.id
                        ? externalEditRequest.requestId
                        : null
                    }
                  />
                ))}
              </React.Fragment>
            );
          })}
        </DiffContainer>
      </>
    );
  }
);

SelectableDiffRenderer.displayName = "SelectableDiffRenderer";
