/**
 * Loop protection for intra-tree agent peer messaging: task_send_message sends whose target is
 * NOT the sender's descendant (siblings/cousins and ancestors, including the root workspace).
 * Parent→descendant guidance is unthrottled and unaffected by these constants.
 *
 * All counters live in-memory on TaskService (mirroring consecutiveAutoResumes): a restart clears
 * them, which is an accepted tradeoff — peer messages have no durable crash replay either.
 */

/** Max peer/ancestor sends per sender→target pair within PEER_MESSAGE_RATE_WINDOW_MS. */
export const PEER_MESSAGE_RATE_LIMIT_MAX = 5;
export const PEER_MESSAGE_RATE_WINDOW_MS = 60_000;

/** Max peer/ancestor sends per target across all senders (catches many-sender flooding). */
export const PEER_MESSAGE_TARGET_RATE_LIMIT_MAX = 10;

/** Identical (sender, target, trimmed text) within this window is refused as a duplicate. */
export const PEER_MESSAGE_DEDUPE_WINDOW_MS = 120_000;

/** Max peer messages queued (not yet dispatched) behind one busy target. */
export const MAX_QUEUED_PEER_MESSAGES_PER_TARGET = 10;

/**
 * Queue dedupe-key prefix for peer-message wake triggers (`agent-msg:<sender>:<uuid>`). The
 * unique suffix prevents coalescing; the prefix lets the queue count peer entries even when a
 * trigger's muxMetadata carries a workspace-turn correlation instead of peer attribution.
 */
export const AGENT_PEER_MESSAGE_DEDUPE_PREFIX = "agent-msg:";

/**
 * Queue dedupe-key prefix for incremental `agent_report` updates queued behind a busy parent.
 * Full key: `agent-report:<child>:<toolCallId>` for a child's original run, or
 * `agent-report:<child>:<executionId>:<toolCallId>` while a reawakened child runs as a
 * workspace-turn continuation, so a terminal settlement can drop exactly the updates that
 * execution superseded (a successor execution's updates keep their own prefix).
 */
export const AGENT_REPORT_PROGRESS_DEDUPE_PREFIX = "agent-report:";

/** Prefix matching every queued incremental update from one child (optionally one execution). */
export function agentReportProgressDedupePrefix(
  childWorkspaceId: string,
  executionId?: string
): string {
  return executionId == null
    ? `${AGENT_REPORT_PROGRESS_DEDUPE_PREFIX}${childWorkspaceId}:`
    : `${AGENT_REPORT_PROGRESS_DEDUPE_PREFIX}${childWorkspaceId}:${executionId}:`;
}

/** onCanceled reason for queued incremental updates dropped by the child's terminal outcome. */
export const AGENT_REPORT_PROGRESS_SUPERSEDED_REASON =
  "Incremental sub-agent update superseded by the terminal report.";

/**
 * Max peer messages admitted for a target without any user-authored input or parent guidance in
 * between; at the cap the target is deemed to need user attention. Charged when a send is
 * admitted (queued or delivered), so dispatch timing cannot exceed the advertised turn count.
 */
export const MAX_CONSECUTIVE_PEER_WAKES = 3;
