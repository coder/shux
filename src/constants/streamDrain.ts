/**
 * Bounded cleanup window for draining a deadline-cancelled provider stream
 * (reader.cancel + consumer settlement). Cancellation normally settles in
 * milliseconds, and draining before cleanup keeps provider teardown ordered —
 * but a provider wedged in its own cancel path must not hold the caller
 * (branch-summary edit-resend, the per-workspace refine lock, workspace
 * removal) past the deadline the drain exists to serve. After this window
 * the stuck consumer is detached: it can only settle into an
 * already-abandoned stream, and nothing observable depends on it afterward.
 */
export const STREAM_CANCEL_DRAIN_WINDOW_MS = 2_000;

/**
 * Bounded drain window for usage-telemetry writes that outlived their
 * producer's deadline (r57). Removal flows (clearPendingBranchSummary before
 * session-directory deletion, cancelInFlightRefinePass) give a wedged
 * recordUsage/recordHeadlessUsage write this long to land, then detach: a
 * write wedged in the filesystem must not hold workspace removal hostage.
 * Residual risk — a detached write completing after directory deletion — is
 * bounded to one file and accepted over an unbounded hang; write STARTS are
 * additionally gated on the producer's abort signal where available.
 */
export const USAGE_WRITE_DRAIN_WINDOW_MS = 2_000;
