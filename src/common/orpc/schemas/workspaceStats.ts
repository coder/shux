import { z } from "zod";
import { AgentModeSchema } from "../../types/mode";
import { AgentIdSchema } from "./agentDefinition";

// Mode is an enum, but we defensively drop unknown values when replaying old history.
const ModeSchema = AgentModeSchema.optional().catch(undefined);
// Agent IDs should already be safe (they come from filenames), but defensively drop unknown values
// when replaying old history.
const AgentIdStatsSchema = AgentIdSchema.optional().catch(undefined);

export const TimingAnomalySchema = z.enum([
  "negative_duration",
  "tool_gt_total",
  "ttft_gt_total",
  "percent_out_of_range",
  "nan",
]);

export const ActiveStreamStatsSchema = z.object({
  messageId: z.string(),
  model: z.string(),
  mode: ModeSchema,
  agentId: AgentIdStatsSchema,

  elapsedMs: z.number(),
  ttftMs: z.number().nullable(),
  toolExecutionMs: z.number(),
  modelTimeMs: z.number(),
  streamingMs: z.number(),

  outputTokens: z.number(),
  reasoningTokens: z.number(),

  /** Total tokens streamed so far (text + reasoning + tool args). */
  liveTokenCount: z.number(),
  /** Tokens/sec, trailing window. */
  liveTPS: z.number(),

  invalid: z.boolean(),
  anomalies: z.array(TimingAnomalySchema),
});

export const CompletedStreamStatsSchema = z.object({
  messageId: z.string(),
  model: z.string(),
  mode: ModeSchema,
  agentId: AgentIdStatsSchema,

  totalDurationMs: z.number(),
  ttftMs: z.number().nullable(),
  toolExecutionMs: z.number(),
  modelTimeMs: z.number(),
  streamingMs: z.number(),

  outputTokens: z.number(),
  reasoningTokens: z.number(),

  invalid: z.boolean(),
  anomalies: z.array(TimingAnomalySchema),
});

export const ModelTimingStatsSchema = z.object({
  model: z.string(),
  mode: ModeSchema,
  agentId: AgentIdStatsSchema,

  totalDurationMs: z.number(),
  totalToolExecutionMs: z.number(),
  totalStreamingMs: z.number(),

  totalTtftMs: z.number(),
  ttftCount: z.number(),
  responseCount: z.number(),

  totalOutputTokens: z.number(),
  totalReasoningTokens: z.number(),
});

export const SessionTimingStatsSchema = z.object({
  totalDurationMs: z.number(),
  totalToolExecutionMs: z.number(),
  totalStreamingMs: z.number(),

  totalTtftMs: z.number(),
  ttftCount: z.number(),
  responseCount: z.number(),

  totalOutputTokens: z.number(),
  totalReasoningTokens: z.number(),

  /**
   * Per-model breakdown.
   *
   * Key is a stable identifier like normalizeToCanonical(model) or model:agentId (fallback: model:mode).
   */
  byModel: z.record(z.string(), ModelTimingStatsSchema),
});

export const WorkspaceStatsSnapshotSchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.number(),

  active: ActiveStreamStatsSchema.optional(),
  lastRequest: CompletedStreamStatsSchema.optional(),
  session: SessionTimingStatsSchema.optional(),
});

export const SessionTimingFileSchema = z.object({
  version: z.literal(2),
  lastRequest: CompletedStreamStatsSchema.optional(),
  session: SessionTimingStatsSchema,

  /**
   * Idempotency ledger for rolled-up sub-agent timing.
   *
   * When a child workspace is deleted, we merge its session timing into the parent.
   * This tracks which children have already been merged to prevent double-counting
   * if removal is retried.
   */
  rolledUpFrom: z.record(z.string(), z.literal(true)).optional(),
});

// Convenient TypeScript type exports
export type TimingAnomaly = z.infer<typeof TimingAnomalySchema>;
export type ActiveStreamStats = z.infer<typeof ActiveStreamStatsSchema>;
export type CompletedStreamStats = z.infer<typeof CompletedStreamStatsSchema>;
export type WorkspaceStatsSnapshot = z.infer<typeof WorkspaceStatsSnapshotSchema>;
export type SessionTimingFile = z.infer<typeof SessionTimingFileSchema>;
