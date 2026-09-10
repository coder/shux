/**
 * RLM-mode compaction constants (rlm-mode experiment, nested under
 * Programmatic Tool Calling). These only affect behavior when the RLM
 * experiment is enabled; default compaction ignores them entirely.
 */

/**
 * Estimated token budget for the keep-recent tail preserved verbatim across an
 * RLM compaction. Compaction walks backward from the newest message and keeps
 * the largest recent suffix whose estimated size fits under this floor; the
 * older head is summarized as usual.
 */
export const RLM_KEEP_RECENT_FLOOR_TOKENS = 20_000;

/**
 * Provider-agnostic chars-per-token heuristic used for the keep-recent floor
 * estimate. Matches CHARS_PER_TOKEN_ESTIMATE used for sub-agent report sizing;
 * duplicated here because that constant lives in node-only code and the tail
 * selection helper must stay usable from common/ (request assembly + replay).
 */
export const RLM_COMPACTION_CHARS_PER_TOKEN = 4;

/**
 * Maximum number of cumulative read-file paths carried across compactions in
 * post-compaction state (newest-first). Paths only — never file contents.
 */
export const MAX_POST_COMPACTION_READ_FILES = 100;
