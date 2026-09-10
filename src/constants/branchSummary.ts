/**
 * Branch summarization on fork/truncate (rlm-mode experiment, nested under
 * Programmatic Tool Calling). When RLM mode is on and history branches (fork
 * from an earlier message or edit-resend truncation), the abandoned tail is
 * summarized via a cheap side-channel model call and appended to the new
 * branch as a durable labeled row. With RLM off these constants are unused
 * and forks/truncations behave exactly as before.
 */

/**
 * Minimum estimated token size (chars/4 heuristic over serialized parts) of
 * the abandoned segment before a summary is worth a model call. Tiny tails
 * (a quick retry of the last message, a one-line answer) carry no context
 * worth preserving.
 */
export const BRANCH_SUMMARY_MIN_SEGMENT_TOKENS = 1_000;

/**
 * Word target given to the summarizer prompt. Deliberately well below the
 * output-token cap (250 words ≈ 325 tokens at WORDS_TO_TOKENS_RATIO, ~1.6x
 * headroom under BRANCH_SUMMARY_MAX_OUTPUT_TOKENS): when the word target
 * matches the token cap the model always stops at max_tokens and every
 * summary ends mid-sentence. The gap lets summaries finish naturally.
 */
export const BRANCH_SUMMARY_TARGET_WORDS = 250;

/**
 * Hard output-token cap for the summary call. This is a safety bound only —
 * the prompt's word target (BRANCH_SUMMARY_TARGET_WORDS) sits well below it
 * so a well-behaved model never hits this cap.
 */
export const BRANCH_SUMMARY_MAX_OUTPUT_TOKENS = 512;

/**
 * Hard wall-clock bound for the whole summary generation (all candidate
 * models share one deadline). Sized to cover the full output cap at real
 * side-channel throughput: dogfooded haiku streams ~100 tok/s with ~0.6s
 * TTFB, so a worst-case max_tokens stream is ~0.6s + 512/100 ≈ 5.7s and the
 * typical natural stop (~325 tokens) lands around 3.9s. The edit-resend path
 * waits synchronously on this deadline (see maybeAppendAbandonedBranchSummary
 * for why), so it also caps how long that user-facing operation can stall.
 */
export const BRANCH_SUMMARY_TIMEOUT_MS = 6_000;

/**
 * Hard cap on characters accumulated from the summary stream. Purely
 * defensive: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS already bounds well-behaved
 * providers (~4 chars/token ≈ 2k chars), but a pathological provider that
 * ignores both max_tokens and abort could otherwise grow the buffer without
 * bound between the consume loop's deadline checks. Generous multiple of the
 * worst-case legitimate output so it can never clip a real summary.
 */
export const BRANCH_SUMMARY_MAX_ACCUMULATED_CHARS = 32_000;

/**
 * Input cap for the thinking-stripped transcript fed to the summarizer.
 * Oldest messages are dropped first: the newest abandoned work carries the
 * most context worth preserving. ~40k tokens at the chars/4 heuristic keeps
 * the side-channel call cheap even for a large abandoned tail.
 */
export const BRANCH_SUMMARY_MAX_TRANSCRIPT_CHARS = 160_000;
