/** Shared limits for opt-in, lossless context-window rollover and history retrieval. */
export const CONTEXT_NOTES_MEMORY_PATH = "/memories/workspace/context-notes.md";
export const CONTEXT_NOTES_RESERVED_BYTES = 8 * 1024;
export const CONTEXT_NOTES_RESERVED_TOKENS = 2_000;
export const CONTEXT_CONTINUE_DEDUPE_KEY = "context-budget-continue";
export const CONTEXT_WARNING_DEDUPE_KEY = "context-budget-warning";
/**
 * Appended to the inherited tool policy for the hidden final-flush turn: only `memory` (the
 * write it exists for) stays enabled. The turn is bounded to one provider step, so a read-only
 * `session_history` call would consume the whole preservation opportunity without a write; the
 * transcript is still in context anyway, and history retrieval belongs to the next window.
 * Rollover admission checks `session_history` against the inherited policy separately.
 */
export const CONTEXT_FLUSH_TOOL_POLICY_RULE = {
  regex_match: "(?!memory$).*",
  action: "disable",
} as const;
export const OUTPUT_RESERVE_TOKENS = 8_192;
export const MAX_OUTPUT_RESERVE_CONTEXT_RATIO = 0.25;
export const MAX_FALLBACK_SYSTEM_FLOOR_CONTEXT_RATIO = 0.5;
export const WARNING_RESERVE_TOKENS = 2_048;
// Absolute floor on how far ahead of the rollover point the advance warning fires. The
// percent-based advance shrinks with the window (a 15% gap is under 5k tokens at 32k), so
// reserve three WARNING_RESERVE_TOKENS: one notes flush plus roughly two working steps.
export const WARNING_ADVANCE_MIN_TOKENS = 3 * WARNING_RESERVE_TOKENS;
export const IMAGE_TOKEN_ESTIMATE = 1_024;
export const SYSTEM_FLOOR_TOKENS_ESTIMATE = 8_192;
export const SESSION_HISTORY_MAX_RESULT_BYTES = 16 * 1024;
export const SESSION_HISTORY_MAX_SCAN_BYTES = 2 * 1024 * 1024;
export const SESSION_HISTORY_MAX_SCAN_ROWS = 500;
export const SESSION_HISTORY_MAX_LINE_BYTES = 1024 * 1024;
export const SESSION_HISTORY_DEFAULT_LIMIT = 10;
export const SESSION_HISTORY_MAX_SEARCH_LIMIT = 25;
export const SESSION_HISTORY_MAX_WINDOW_LIMIT = 50;
export const SESSION_HISTORY_DEFAULT_READ_CHARS = 8_000;
export const SESSION_HISTORY_MAX_READ_CHARS = 16_000;
export const SESSION_HISTORY_SCAN_CHUNK_BYTES = 64 * 1024;
export const SESSION_HISTORY_ANCHOR_BYTES = 64;
export const SESSION_HISTORY_MAX_CURSOR_CHARS = 12 * 1024;
export const SESSION_HISTORY_MAX_QUERY_CHARS = 1024;
export const SESSION_HISTORY_MAX_ID_CHARS = 1024;
export const SESSION_HISTORY_RESULT_ENVELOPE_BYTES = 10 * 1024;
export const SESSION_HISTORY_READ_RESULT_ENVELOPE_BYTES = 512;
export const SESSION_HISTORY_SEARCH_SNIPPET_CHARS = 500;
// Compact JSON marker; the bounded scanner ignores JSON whitespace around it.
export const SESSION_HISTORY_RESET_NEEDLE = '"contextBoundaryKind":"reset"';
// Each marker character can occupy six raw characters as a JSON Unicode escape.
export const SESSION_HISTORY_RESET_PROBE_CHARS = SESSION_HISTORY_RESET_NEEDLE.length * 6;

// Allow for provider message/tool envelopes beyond encoded visible text.
export const REQUEST_FRAMING_TOKENS = 8;
export const BUDGET_TOKEN_COUNT_CHUNK_CHARS = 4096;
export const BUDGET_TOKEN_CHUNK_SLACK = 8;
