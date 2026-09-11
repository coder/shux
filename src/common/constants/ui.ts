/**
 * UI-related constants shared across components
 */

/**
 * Auto-compaction threshold bounds (percentage)
 * MIN: Allow any value - user can choose aggressive compaction if desired
 * MAX: Cap at 90% to leave buffer before hitting context limit
 */
export const AUTO_COMPACTION_THRESHOLD_MIN = 0;
export const AUTO_COMPACTION_THRESHOLD_MAX = 90;

/**
 * Stored threshold upper bound. A value of 100 disables auto-compaction.
 */
export const AUTO_COMPACTION_THRESHOLD_STORAGE_MAX = 100;

/**
 * Default auto-compaction threshold percentage (50-90 range)
 * Applied when creating new workspaces
 */
export const DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT = 70;

/**
 * Default threshold as decimal for calculations (0.7 = 70%)
 */
export const DEFAULT_AUTO_COMPACTION_THRESHOLD = DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT / 100;

/**
 * Default word target for compaction summaries
 */
export const DEFAULT_COMPACTION_WORD_TARGET = 2000;

/**
 * Approximate ratio of tokens to words (tokens per word)
 * Used for converting between word counts and token counts
 */
export const WORDS_TO_TOKENS_RATIO = 1.3;

/**
 * Build the compaction prompt for a given word target.
 * Shared across desktop and mobile clients.
 */
export function buildCompactionPrompt(targetWords: number): string {
  return `Summarize this conversation for a new Assistant to continue helping the user.

Your summary must be approximately ${targetWords} words.

Include:
- The user's overall goal and current task
- Key decisions made and their rationale
- Current state of the work (what's done, what's in progress)
- Important technical details (file paths, function names, configurations)
- Any errors encountered and how they were resolved
- Unresolved issues or blockers

Do not include:
- Suggestions for next steps
- Conversational filler or pleasantries
- Redundant information

Write in a factual, dense style. Every sentence should convey essential context.`;
}

/**
 * Force-compact this many percentage points after threshold.
 * Gives user a buffer zone between warning and force-compaction.
 * E.g., with 70% threshold, force-compact triggers at 75%.
 */
export const FORCE_COMPACTION_BUFFER_PERCENT = 5;

/**
 * Headroom (percentage points of the routed model's context window) reserved
 * for the pending turn when deciding whether a skill-routed send must compact
 * first. Routed sends deliberately ignore the user's compaction threshold —
 * a cheap skill invocation must not force an unrequested workspace-wide
 * compaction of a history far under the workspace model's limit — but the
 * recorded usage excludes the new message, attachments, and skill snapshot,
 * so requiring a full 100% would let a near-limit history overrun the routed
 * model at request startup instead of compacting.
 */
export const ROUTED_SEND_COMPACTION_HEADROOM_PERCENT = 10;

/**
 * Duration (ms) to show "copied" feedback after copying to clipboard
 */
export const COPY_FEEDBACK_DURATION_MS = 2000;

/**
 * Maximum number of log entries retained in memory for Output tab views.
 *
 * This cap is shared by the backend log ring buffer and frontend Output tab
 * state to prevent unbounded growth during long-running verbose sessions.
 */
export const MAX_LOG_ENTRIES = 1000;

/**
 * Predefined color palette for project sections.
 * Each color is designed to work well with the dark theme.
 * Format: [name, hex value]
 */
export const SECTION_COLOR_PALETTE = [
  ["Gray", "#6b7280"],
  ["Slate", "#64748b"],
  ["Blue", "#5a9bd4"],
  ["Cyan", "#22d3ee"],
  ["Teal", "#4ab5a7"],
  ["Green", "#4caf7c"],
  ["Yellow", "#d9b836"],
  ["Orange", "#e5853a"],
  ["Red", "#e54545"],
  ["Pink", "#d465a5"],
] as const;

/**
 * Default color for new sections (neutral gray)
 */
export const DEFAULT_SECTION_COLOR = SECTION_COLOR_PALETTE[0][1];

/**
 * Resolve a section color string (hex value or preset name) to a canonical hex color.
 *
 * Sections persist their color to config.json as a string, which may be either:
 * - a hex color (e.g. "#5a9bd4")
 * - a palette name (e.g. "Blue")
 *
 * For consistent rendering (and for safely appending hex alpha like "10"), we normalize
 * to a 6-digit "#rrggbb" string.
 */
export function resolveSectionColor(color: string | null | undefined): string {
  if (!color) {
    return DEFAULT_SECTION_COLOR;
  }

  const trimmed = color.trim();
  if (trimmed.length === 0) {
    return DEFAULT_SECTION_COLOR;
  }

  const paletteMatch = SECTION_COLOR_PALETTE.find(
    ([name]) => name.toLowerCase() === trimmed.toLowerCase()
  );
  if (paletteMatch) {
    return paletteMatch[1];
  }

  const hex3Match = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (hex3Match) {
    const [r, g, b] = hex3Match[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  const hex6Match = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex6Match) {
    return `#${hex6Match[1]}`.toLowerCase();
  }

  // If the stored value includes an alpha channel, drop it so downstream code can
  // safely apply its own alpha.
  const hex8Match = /^#([0-9a-fA-F]{8})$/.exec(trimmed);
  if (hex8Match) {
    return `#${hex8Match[1].slice(0, 6)}`.toLowerCase();
  }

  return DEFAULT_SECTION_COLOR;
}
