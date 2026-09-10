export interface CompactionCompletionMetadata {
  workspaceId: string;
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
