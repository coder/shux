export interface CompactionCompletionMetadata {
  workspaceId: string;
  /**
   * Whether the workspace's agent may write `/memories/workspace` (its memory
   * access policy on the last non-compaction turn). Post-compaction harvest
   * writes candidates into that store — for a sub-agent, the OWNER's shared
   * notebook — so a read-only (explore-like) agent must not harvest. Absent on
   * legacy records; only an explicit `false` refuses.
   */
  workspaceMemoryWritable?: boolean;
  summaryMessageId: string;
  summaryHistorySequence: number;
  compactionEpoch: number;
  previousBoundaryHistorySequence?: number;
  compactionRequestMessageId: string;
  /**
   * RLM keep-recent floor: number of preserved-tail copies appended after the
   * boundary. When > 0 the summary is no longer the last history row, so
   * follow-up dispatch must target it by ID instead of "last message".
   * Optional so persisted legacy records (memory harvest) stay valid.
   */
  preservedTailMessageCount?: number;
}
