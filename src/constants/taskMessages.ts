/**
 * RLM family messaging bounds (task_message_parent / task_message_sibling).
 *
 * A kernel guest can synthesize a multi-megabyte string in code_execution
 * without spending equivalent output tokens; without a cap the whole value
 * would be queued into a parent/sibling transcript, persisted, and sent to
 * that workspace's provider. 16K chars is generous for a status/handoff
 * message while keeping the receiving transcript bounded.
 */
export const TASK_FAMILY_MESSAGE_MAX_CHARS = 16 * 1024;

/**
 * Aggregate family-message budgets per sender→target pair, for the sender's
 * process-session lifetime. The per-message cap alone is not enough: a short
 * code_execution loop can invoke task_message_parent repeatedly with valid
 * 16K messages, and a busy target's message queue appends every one to a
 * single unbounded entry before joining it into history/provider input — a
 * prompt-influenced child could push tens of MB into another workspace.
 * These totals absolutely bound what one sender can deliver to one target:
 * 32 messages / 256K chars (= 16 max-size messages) is far beyond legitimate
 * status-update traffic, and the final result travels via agent_report,
 * which is not part of this budget.
 */
export const TASK_FAMILY_MESSAGE_MAX_TOTAL_MESSAGES = 32;
export const TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS = 256 * 1024;

/**
 * Receiver-side aggregate ceilings, independent of sender. The per-pair
 * budget alone still lets N children each spend a full allowance on the
 * same busy parent, reproducing the unbounded receiver-queue growth the
 * quota exists to prevent. One target workspace accepts at most this many
 * family messages / bytes per process session across ALL senders: 4x the
 * per-pair budget, sized for a full bench of concurrently chatty children
 * while keeping the worst-case queue join bounded (~1MB).
 */
export const TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES = 128;
export const TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_CHARS = 1024 * 1024;

/**
 * Cap on the sender title interpolated into a family-message payload row's
 * attribution. Titles are attacker-influenced (auto-titling derives them from
 * child content; spawn/retitle impose no cap), and the attribution framing is
 * rendered on EVERY send — an unbounded title would multiply through the
 * per-send accounting. Sanity bound only: budgets additionally charge the
 * complete rendered payload length, so accounting stays exact regardless.
 */
export const TASK_FAMILY_MESSAGE_MAX_TITLE_CHARS = 256;
