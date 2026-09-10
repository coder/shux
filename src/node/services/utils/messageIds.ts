/**
 * Centralized message ID generation helpers.
 *
 * Each message type uses a consistent prefix + timestamp + random suffix pattern.
 * Prefixes are preserved for backward compatibility with existing history.
 */

import { MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX } from "@/common/types/message";

const randomSuffix = (len = 9) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + len);

/** User message IDs: user-{timestamp}-{random} */
export const createUserMessageId = (): string => `user-${Date.now()}-${randomSuffix(9)}`;

/** Assistant message IDs: assistant-{timestamp}-{random} */
export const createAssistantMessageId = (): string => `assistant-${Date.now()}-${randomSuffix(9)}`;

/** File snapshot message IDs: file-snapshot-{timestamp}-{random} */
export const createFileSnapshotMessageId = (): string =>
  `file-snapshot-${Date.now()}-${randomSuffix(7)}`;

/** Agent skill snapshot message IDs: agent-skill-snapshot-{timestamp}-{random} */
export const createAgentSkillSnapshotMessageId = (): string =>
  `agent-skill-snapshot-${Date.now()}-${randomSuffix(7)}`;

export const createMcpPromptSnapshotMessageId = (): string =>
  `${MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX}${Date.now()}-${randomSuffix(7)}`;

/** Compaction summary message IDs: summary-{timestamp}-{random} */
export const createCompactionSummaryMessageId = (): string =>
  `summary-${Date.now()}-${randomSuffix(9)}`;

/**
 * RLM keep-recent tail copy IDs: rlm-tail-{timestamp}-{random}.
 * Fresh IDs (never the original row's) so UI aggregation keyed by message ID
 * cannot collapse a hidden post-boundary copy over its visible original.
 */
export const createPreservedTailCopyMessageId = (): string =>
  `rlm-tail-${Date.now()}-${randomSuffix(9)}`;

/** Abandoned-branch summary IDs (rlm-mode fork/edit truncation): branch-summary-{timestamp}-{random} */
export const createBranchSummaryMessageId = (): string =>
  `branch-summary-${Date.now()}-${randomSuffix(9)}`;

/** Refine pass summary IDs (rlm-mode /refine): refine-summary-{timestamp}-{random} */
export const createRefineSummaryMessageId = (): string =>
  `refine-summary-${Date.now()}-${randomSuffix(9)}`;

/** Family-message payload row IDs (task_message_parent): family-message-{timestamp}-{random} */
export const createFamilyMessageId = (): string =>
  `family-message-${Date.now()}-${randomSuffix(9)}`;

/** Context reset boundary IDs: context-reset-{timestamp}-{random} */
export const createContextResetBoundaryMessageId = (): string =>
  `context-reset-${Date.now()}-${randomSuffix(9)}`;

/** Task report message IDs: task-report-{timestamp}-{random} */
export const createTaskReportMessageId = (): string =>
  `task-report-${Date.now()}-${randomSuffix(9)}`;

/** Task terminal-failure message IDs: task-failure-{timestamp}-{random} */
export const createTaskFailureMessageId = (): string =>
  `task-failure-${Date.now()}-${randomSuffix(9)}`;

/** External file-change notification message IDs: file-change-{timestamp}-{random} */
export const createFileChangeNotificationMessageId = (): string =>
  `file-change-${Date.now()}-${randomSuffix(9)}`;
