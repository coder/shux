/**
 * Types for code review system
 */

/**
 * Type of change for a file in a diff
 */
export type FileChangeType = "added" | "deleted" | "modified" | "renamed";

/**
 * Individual hunk within a file diff
 */
export interface DiffHunk {
  /** Unique identifier for this hunk (hash of file path + line ranges) */
  id: string;
  /** Path to the file relative to workspace root */
  filePath: string;
  /** Starting line number in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Starting line number in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Diff content (lines starting with +/-/space) */
  content: string;
  /** Hunk header line (e.g., "@@ -1,5 +1,6 @@") */
  header: string;
  /** Change type from parent file */
  changeType?: FileChangeType;
  /** Old file path (if renamed) */
  oldPath?: string;
}

/**
 * Parsed file diff containing multiple hunks
 */
export interface FileDiff {
  /** Path to the file relative to workspace root */
  filePath: string;
  /** Old file path (different if renamed) */
  oldPath?: string;
  /** Type of change */
  changeType: FileChangeType;
  /** Whether this is a binary file */
  isBinary: boolean;
  /** Hunks in this file */
  hunks: DiffHunk[];
}

/**
 * Read state for a single hunk
 */
export interface HunkReadState {
  /** ID of the hunk */
  hunkId: string;
  /** Whether this hunk has been marked as read */
  isRead: boolean;
  /** Timestamp when read state was last updated */
  timestamp: number;
}

/**
 * Workspace review state (persisted to localStorage)
 */
export interface ReviewState {
  /** Workspace ID this review belongs to */
  workspaceId: string;
  /** Read state keyed by hunk ID */
  readState: Record<string, HunkReadState>;
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Sort order options for review panel hunks
 */
export type ReviewSortOrder = "file-order" | "last-edit";

/**
 * Filter options for review panel
 */
export interface ReviewFilters {
  /** Whether to show hunks marked as read (used outside of Assisted mode). */
  showReadHunks: boolean;
  /**
   * Whether to show read hunks while {@link assistedOnly} is on. Tracked
   * separately so the "Read:" toggle in Assisted mode is a worklist
   * affordance ("hide done") without overwriting the user's general
   * review preference. Defaults to false so marking an assisted pin
   * as read actually clears it from the view — the user's most-asked
   * fix once Assisted shipped.
   */
  assistedShowReadHunks: boolean;
  /** File path filter (regex or glob pattern) */
  filePathFilter?: string;
  /** Base reference to diff against (e.g., "HEAD", "main", "origin/main") */
  diffBase: string;
  /** Whether to include uncommitted changes (staged + unstaged) in the diff */
  includeUncommitted: boolean;
  /** Sort order for hunks */
  sortOrder: ReviewSortOrder;
  /**
   * When true, only show hunks the agent flagged via `review_pane_update`.
   * Independent of pin-first behavior, which always applies when any
   * assisted hunks exist.
   */
  assistedOnly: boolean;
}

/**
 * A single agent-flagged review hint targeting one file (and optionally a
 * line range on the *new* side of the diff). Stored in-memory per workspace
 * via the {@link review_pane_update} tool.
 */
export interface AssistedReviewHunk {
  /** File path relative to workspace root, as the agent specified it. */
  path: string;
  /** Optional inclusive new-file line range, e.g. {start:10,end:24}. */
  range?: { start: number; end: number };
  /** Optional agent comment explaining why this area needs review. */
  comment?: string;
  /**
   * Frontend-only: timestamp (ms since epoch) when this pin was first
   * observed during this client's lifetime — i.e., when `review_pane_update`
   * introduced the path:range key. Used to render a transient "new" badge
   * on freshly-added pins so the user can tell incremental adds apart from
   * carried-over entries.
   *
   * Not persisted to disk; recomputed from the transcript on every load.
   */
  addedAt?: number;
}

/**
 * Review statistics
 */
export interface ReviewStats {
  /** Total number of hunks */
  total: number;
  /** Number of hunks marked as read */
  read: number;
  /** Number of unread hunks */
  unread: number;
}

/**
 * Status of a review
 * - pending: In banner, not attached to chat input
 * - attached: Currently attached to chat input draft
 * - checked: Marked as done (after being sent)
 */
export type ReviewStatus = "pending" | "attached" | "checked";

/**
 * Structured data for a review note.
 * Passed from DiffRenderer when user creates a review.
 * Stored as-is for rich UI display, formatted to message only when sending to chat.
 */
export interface ReviewNoteData {
  /** File path being reviewed */
  filePath: string;
  /** Line range (e.g., "-10-12 +14-16", "-10", "+14", or legacy "42-45") */
  lineRange: string;

  /**
   * Human-readable selected code included in the message payload.
   * Historically this included embedded line numbers; keep for backwards compatibility.
   */
  selectedCode: string;

  /**
   * Raw diff snippet for UI rendering (lines start with + / - / space).
   * When present, the UI should prefer this for consistent syntax highlighting.
   */
  selectedDiff?: string;

  /** Starting old line number for rendering selectedDiff (if present). */
  oldStart?: number;
  /** Starting new line number for rendering selectedDiff (if present). */
  newStart?: number;

  /** User's review comment */
  userNote: string;
}

/**
 * A single review note
 * Created when user adds a review note from the diff viewer
 */
export interface Review {
  /** Unique identifier */
  id: string;
  /** Structured review data for rich UI display */
  data: ReviewNoteData;
  /** Current status */
  status: ReviewStatus;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when status changed (checked/unchecked) */
  statusChangedAt?: number;
}

/**
 * Persisted state for reviews (per workspace)
 * Contains reviews in all states: pending, attached, and checked
 */
export interface ReviewsState {
  /** Workspace ID */
  workspaceId: string;
  /** All reviews keyed by ID */
  reviews: Record<string, Review>;
  /** Last update timestamp */
  lastUpdated: number;
}

/**
 * Helpers for parsing ReviewNoteData.lineRange.
 */

export interface ReviewLineNumberRange {
  start: number;
  end: number;
}

export interface ParsedReviewLineRange {
  old?: ReviewLineNumberRange;
  new?: ReviewLineNumberRange;
}

function parseNumberRange(rangeText: string): ReviewLineNumberRange | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(rangeText.trim());
  if (!match) return null;

  const startNum = Number(match[1]);
  const endNum = match[2] ? Number(match[2]) : startNum;
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return null;

  return {
    start: Math.min(startNum, endNum),
    end: Math.max(startNum, endNum),
  };
}

/**
 * Parse a ReviewNoteData.lineRange string into numeric old/new ranges.
 *
 * Supports:
 * - Current format: "-10-12 +14-16", "-10 +14", "-10", "+14-16"
 * - Legacy format: "42" or "42-45" (treated as both old and new)
 */
export function parseReviewLineRange(lineRange: string): ParsedReviewLineRange | null {
  const tokens = lineRange.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let oldRange: ReviewLineNumberRange | undefined;
  let newRange: ReviewLineNumberRange | undefined;

  for (const token of tokens) {
    if (token.startsWith("-") && token.length > 1) {
      const parsed = parseNumberRange(token.slice(1));
      if (parsed) oldRange = parsed;
      continue;
    }

    if (token.startsWith("+") && token.length > 1) {
      const parsed = parseNumberRange(token.slice(1));
      if (parsed) newRange = parsed;
      continue;
    }

    // Legacy: range without +/- prefix. Treat as matching either old or new line numbers.
    const legacyRange = parseNumberRange(token);
    if (legacyRange) {
      oldRange ??= legacyRange;
      newRange ??= legacyRange;
    }
  }

  if (!oldRange && !newRange) return null;

  return {
    old: oldRange,
    new: newRange,
  };
}
/**
 * Normalize a plan file path for cross-platform matching.
 *
 * Converts Windows separators and strips canonical or legacy home prefixes. The
 * normalized `.mux/plans/...` suffix is intentionally retained as a serialized
 * compatibility shape for older review transcripts.
 *
 * Accepts `/.xum/plans/`, legacy `/.mux/plans/`, suffixed development homes,
 * Docker `/var/mux/plans/`, and their tilde-prefixed equivalents.
 */
export function normalizePlanFilePath(filePath: string): string | null {
  if (!filePath) return null;

  const normalized = filePath.replace(/\\/g, "/");

  const tildeMatch = /^~\/\.(?:xum|mux)(?:-[^/]+)?\/plans\/(.+)/.exec(normalized);
  if (tildeMatch?.[1]) {
    return `.mux/plans/${tildeMatch[1]}`;
  }

  // Already-normalized relative path from a previous normalizePlanFilePath call.
  // This ensures round-trip stability: normalize(normalize(path)) === normalize(path).
  if (normalized.startsWith(".mux/plans/")) {
    return normalized;
  }

  // Only match absolute paths to avoid false positives from relative paths like
  // "project/.mux/plans/foo.md".
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!isAbsolute) return null;

  const xumHomeMatch = /\/\.(?:xum|mux)(?:-[^/]+)?\/plans\/(.+)/.exec(normalized);
  if (xumHomeMatch?.[1]) {
    return `.mux/plans/${xumHomeMatch[1]}`;
  }

  const dockerMatch = /\/var\/mux\/plans\/(.+)/.exec(normalized);
  if (dockerMatch?.[1]) {
    return `.mux/plans/${dockerMatch[1]}`;
  }

  return null;
}

/**
 * Returns true when a review note references plan content under .mux/plans.
 */
export function isPlanFilePath(filePath: string): boolean {
  return normalizePlanFilePath(filePath) !== null;
}

function formatPlanLineRange(lineRange: string): string {
  const trimmedLineRange = lineRange.trim();

  const newRangeMatch = /\+(\d+(?:-\d+)?)/.exec(trimmedLineRange);
  if (newRangeMatch?.[1]) {
    return `L${newRangeMatch[1]}`;
  }

  const oldRangeMatch = /(?:^|\s)-(\d+(?:-\d+)?)(?=\s|$)/.exec(trimmedLineRange);
  if (oldRangeMatch?.[1]) {
    return `L${oldRangeMatch[1]}`;
  }

  const bareRangeMatch = /^(\d+(?:-\d+)?)$/.exec(trimmedLineRange);
  if (bareRangeMatch?.[1]) {
    return `L${bareRangeMatch[1]}`;
  }

  return lineRange;
}

/**
 * Format a ReviewNoteData into the message format for the model.
 * Used when preparing reviews for sending to chat.
 */
export function formatReviewForModel(data: ReviewNoteData): string {
  const location = isPlanFilePath(data.filePath)
    ? `Plan:${formatPlanLineRange(data.lineRange)}`
    : `${data.filePath}:${data.lineRange}`;

  return `<review>\nRe ${location}\n\`\`\`\n${data.selectedCode}\n\`\`\`\n> ${data.userNote.trim()}\n</review>`;
}
