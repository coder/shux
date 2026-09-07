import { z } from "zod";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { ThinkingLevelSchema } from "../../types/thinking";
import { AgentIdSchema } from "./agentDefinition";
import { StreamErrorTypeSchema } from "./errors";
import { AgentSkillScopeSchema, SkillNameSchema } from "./agentSkill";
import { WorkflowRunIdSchema, WorkflowRunRecordSchema } from "./workflow";

export const ContextWindowTokensSchema = z.number().int().positive().nullable().meta({
  description:
    "Request-pinned effective context capacity; null means unknown, absent means legacy metadata",
});

export const FilePartSchema = z.object({
  url: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
});

export const MuxTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  timestamp: z.number().optional(),
});

export const MuxReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  timestamp: z.number().optional(),
});

export const WorkflowRunToolAttachmentSchema = z.object({
  runId: WorkflowRunIdSchema,
  run: WorkflowRunRecordSchema.optional(),
  timestamp: z.number(),
});

export type WorkflowRunToolAttachment = z.infer<typeof WorkflowRunToolAttachmentSchema>;

// Base schema for tool parts - shared fields
const MuxToolPartBase = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  timestamp: z.number().optional(),
  // When the tool's execute() actually began running. Parallel tool calls are
  // serialized (withSequentialExecution), so this can be much later than
  // `timestamp` (when the model emitted the call). UI elapsed timers must use
  // this so queued-but-not-yet-executing tools don't appear to run.
  executionStartedAt: z.number().optional(),
  workflowRun: WorkflowRunToolAttachmentSchema.optional(),
});

/**
 * Schema for nested tool calls within code_execution.
 *
 * PERSISTENCE:
 * - During live streaming: parentToolCallId on events → streamManager persists to part.nestedCalls
 * - In chat.jsonl: nestedCalls is persisted alongside result.toolCalls (for interrupted streams)
 * - On history replay: Aggregator uses persisted nestedCalls, or reconstructs from result.toolCalls
 *
 * The reconstruction from result.toolCalls provides backward compatibility for older history.
 */
export const NestedToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  // Optional: kernel guests can invoke a capability with zero arguments
  // (mux.tool()), and JSON.stringify drops the resulting `input: undefined`
  // key on persist. Requiring the key here made onChat replay of such
  // persisted rows fail oRPC output validation and permanently brick
  // workspace fetch (one corrupt row killed the whole subscription).
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  state: z.enum(["input-available", "output-available", "output-redacted"]),
  failed: z.boolean().optional(),
  timestamp: z.number().optional(),
  // Durable run identity for nested workflow_run/workflow_resume calls, set
  // by streamManager when the workflow-run-attached event targets a nested
  // call. Kernel bounding can replace the nested args/result with a marker,
  // so without this the transcript card loses the run after reload.
  workflowRun: WorkflowRunToolAttachmentSchema.optional(),
});

export type NestedToolCall = z.infer<typeof NestedToolCallSchema>;

// Discriminated tool part schemas - output required only when state is "output-available"
export const DynamicToolPartPendingSchema = MuxToolPartBase.extend({
  state: z.literal("input-available"),
  nestedCalls: z.array(NestedToolCallSchema).optional(),
});

const DynamicToolPartAvailableSchema = MuxToolPartBase.extend({
  state: z.literal("output-available"),
  output: z.unknown(),
  nestedCalls: z.array(NestedToolCallSchema).optional(),
});
const DynamicToolPartRedactedSchema = MuxToolPartBase.extend({
  state: z.literal("output-redacted"),
  failed: z.boolean().optional(),
  nestedCalls: z.array(NestedToolCallSchema).optional(),
});

export const DynamicToolPartSchema = z.discriminatedUnion("state", [
  DynamicToolPartAvailableSchema,
  DynamicToolPartPendingSchema,
  DynamicToolPartRedactedSchema,
]);

// Alias for message schemas
export const MuxToolPartSchema = DynamicToolPartSchema;

export const MuxFilePartSchema = FilePartSchema.extend({
  type: z.literal("file"),
});

// Export types inferred from schemas for reuse across app/test code.
export type FilePart = z.infer<typeof FilePartSchema>;

const CompactionEpochSchema = z.optional(
  z.preprocess(
    (value) =>
      typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined,
    z.number().int().positive().or(z.undefined())
  )
);

// Fallback record persisted when a configured model-fallback chain answered
// after refusal(s). Must survive the IPC boundary so the transcript can show
// which model was originally requested.
export const ModelFallbackRecordSchema = z.object({
  requestedModel: z.string(),
  refusedModels: z.array(z.string()),
});

const TranscriptAnchorSchema = z.object({
  messageId: z.string(),
  historySequence: z.number(),
  textLength: z.number().nonnegative(),
  reasoningLength: z.number().nonnegative(),
  partIndex: z.number().int().nonnegative(),
});

const MuxMessagePartsSchema = z.array(
  z.discriminatedUnion("type", [
    MuxTextPartSchema,
    MuxReasoningPartSchema,
    MuxToolPartSchema,
    MuxFilePartSchema,
  ])
);

export const ContextBudgetRejectedMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  parts: MuxMessagePartsSchema,
  // Original metadata stays inert until explicitly validated for display.
  metadata: z.any().optional(),
});

// XumMessage (simplified)
export const MuxMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: MuxMessagePartsSchema,
  createdAt: z.date().optional(),
  metadata: z
    .object({
      historySequence: z.number().optional(),
      // Step cuts are an optimization; malformed legacy metadata must not block chat replay.
      stepStartPartIndices: z.array(z.number()).optional().catch(undefined),
      timestamp: z.number().optional(),
      model: z.string().optional(),
      metadataModel: z.string().optional(),
      contextWindowTokens: ContextWindowTokensSchema.optional().catch(undefined),
      thinkingLevel: ThinkingLevelSchema.optional(),
      routedThroughGateway: z.boolean().optional(),
      routeProvider: z.string().optional(), // Preserve replayed/non-stream route attribution.
      // Self-healing read path (like agentId/compactionEpoch): the badge is purely
      // decorative, so a shape-corrupt persisted record must degrade to "no badge"
      // instead of failing whole-chat loading at the oRPC output boundary.
      modelFallback: ModelFallbackRecordSchema.optional().catch(undefined),
      usage: z.any().optional(),
      contextUsage: z.any().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      ttftMs: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      muxMetadata: z.any().optional(),
      cmuxMetadata: z.any().optional(), // Legacy field for backward compatibility
      kind: z.union([z.literal("goal_continuation"), z.literal("goal_budget_limit")]).optional(),
      // ACP prompt correlation id for reconnect/diagnostic continuity.
      acpPromptId: z.string().optional(),
      // Compaction source: "user" (manual), "idle" (auto), "heartbeat" (synthetic reset), or legacy boolean (true)
      compacted: z
        .union([z.literal("user"), z.literal("idle"), z.literal("heartbeat"), z.boolean()])
        .optional(),
      // Monotonic compaction epoch id. Incremented whenever compaction succeeds.
      // Self-healing read path: malformed persisted compactionEpoch is ignored.
      compactionEpoch: CompactionEpochSchema,
      // Durable boundary marker for compaction summaries.
      compactionBoundary: z.boolean().optional(),
      contextBoundaryKind: z.literal(CONTEXT_BOUNDARY_KINDS.RESET).optional(),
      toolPolicy: z.any().optional(),
      disableWorkspaceAgents: z.boolean().optional(),
      retrySendOptions: z.any().optional(),
      agentId: AgentIdSchema.optional().catch(undefined),
      partial: z.boolean().optional(),
      synthetic: z.boolean().optional(),
      uiVisible: z.boolean().optional(),
      contextBudgetRejected: z.literal(true).optional(),
      contextBudgetRejectedMessage: ContextBudgetRejectedMessageSchema.optional().catch(undefined),
      requestPreludeMessageIds: z.array(z.string()).optional(),
      // RLM keep-recent floor: sanitized post-boundary copy of a pre-compaction row.
      rlmPreservedTailCopy: z.boolean().optional(),
      transcriptAnchor: TranscriptAnchorSchema.optional().catch(undefined),

      // Ignore malformed snapshot metadata so one row cannot fail the whole history parse.
      agentSkillSnapshot: z
        .object({
          skillName: SkillNameSchema,
          scope: AgentSkillScopeSchema,
          sha256: z.string(),
          frontmatterYaml: z.string().optional(),
        })
        .optional()
        .catch(undefined),
      mcpPromptSnapshot: z
        .object({
          serverName: z.string(),
          promptName: z.string(),
          commandKey: z.string(),
          invokingMessageId: z.string().optional(),
          description: z.string().optional(),
        })
        .optional()
        .catch(undefined),
      // Marks the hidden @file snapshot turn, which the timeline skips as context plumbing.
      fileAtMentionSnapshot: z.array(z.string()).optional(),
      error: z.string().optional(),
      errorType: StreamErrorTypeSchema.optional(),
    })
    .optional(),
});

export const BranchListResultSchema = z.object({
  branches: z.array(z.string()),
  /** Recommended trunk branch, or null for non-git directories */
  recommendedTrunk: z.string().nullable(),
});
