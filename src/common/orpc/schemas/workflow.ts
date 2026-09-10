import { z } from "zod";

import { BackgroundWorkAttentionPolicySchema } from "@/common/types/backgroundWorkAttention";

export const WorkflowNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const WorkflowScriptScopeValues = ["project", "global", "built-in"] as const;
const LegacyWorkflowScriptScopeValue = "scratch";

export const WorkflowScriptScopeSchema = z.preprocess(
  (value) => (value === LegacyWorkflowScriptScopeValue ? "project" : value),
  z.enum(WorkflowScriptScopeValues)
);

export const WorkflowRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^wfr_[A-Za-z0-9_-]+$/);

export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "backgrounded",
  "interrupted",
  "completed",
  "failed",
]);

const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

// Kept only so older workflow run records with legacy host-step events remain parseable.
const LegacyWorkflowHostStepEffectSchema = z.enum(["read", "workspace", "external"]);

export const WorkflowMetadataSchema = z.record(z.string(), JsonValueSchema);

export const WorkflowArgSummarySchema = z
  .object({
    name: z.string().min(1),
    types: z.array(z.string().min(1)).min(1),
    required: z.boolean(),
    default: JsonValueSchema.optional(),
    enum: z.array(JsonValueSchema).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .strict();

// Limits for statically-declared workflow phases (meta.phases). Enforced both by
// parseDeclaredPhases (run-start validation) and by this wire schema so the two
// validators cannot drift.
export const WORKFLOW_DECLARED_PHASES_MAX = 64;
export const WORKFLOW_PHASE_NAME_MAX_LENGTH = 120;
export const WORKFLOW_PHASE_DESCRIPTION_MAX_LENGTH = 500;

export const WorkflowDeclaredPhaseSchema = z
  .object({
    /** Must match the string passed to phase(name) at runtime. */
    name: z.string().min(1).max(WORKFLOW_PHASE_NAME_MAX_LENGTH),
    label: z.string().min(1).max(WORKFLOW_PHASE_NAME_MAX_LENGTH).optional(),
    description: z.string().min(1).max(WORKFLOW_PHASE_DESCRIPTION_MAX_LENGTH).optional(),
    /** Renders a fan-out badge; purely presentational in v1. */
    parallel: z.boolean().optional(),
  })
  // Unknown keys are errors to keep the namespace free for future flow metadata.
  .strict();

/**
 * Derived phase manifest hydrated onto outbound workflow payloads at the API
 * boundary (never persisted to run.json — see WorkflowRunStore.writeRunFile).
 * "declared" comes from meta.phases; "inferred" from best-effort static analysis
 * of phase() callsites in legacy scripts without a declaration.
 */
export const WorkflowPhaseManifestSchema = z
  .object({
    provenance: z.enum(["declared", "inferred"]),
    phases: z.array(WorkflowDeclaredPhaseSchema).min(1).max(WORKFLOW_DECLARED_PHASES_MAX),
  })
  .strict();

export const WorkflowScriptDescriptorSchema = z
  .object({
    name: WorkflowNameSchema,
    description: z.string().min(1).max(1024),
    scope: WorkflowScriptScopeSchema,
    sourcePath: z.string().min(1).optional(),
    requestedScriptPath: z.string().min(1).optional(),
    canonicalScriptPath: z.string().min(1).optional(),
    sourceKind: z.enum(["skill", "workspace-file", "inline", "plugin"]).optional(),
    sourceHash: z.string().min(1).optional(),
    executable: z.boolean(),
    blockedReason: z.string().min(1).optional(),
    /**
     * Hydrated on read; never written to disk. `null` means "hydrated, none
     * derivable"; absent means the snapshot predates hydration (pre-upgrade
     * tool output) and a client may fetch the hydrated record once.
     */
    phaseManifest: WorkflowPhaseManifestSchema.nullish(),
  })
  .refine((value) => value.executable || value.blockedReason != null, {
    message: "Non-executable workflow scripts must include a blocked reason",
    path: ["blockedReason"],
  });

export const WorkflowResultSchema = z.object({
  reportMarkdown: z.string(),
  structuredOutput: JsonValueSchema.optional(),
});

export const StructuredTaskOutputSchema = z.object({
  reportMarkdown: z.string(),
  title: z.string().min(1).nullable().optional(),
  planFilePath: z.string().min(1).optional(),
  structuredOutput: JsonValueSchema.optional(),
  taskId: z.string().min(1).optional(),
});

export const WorkflowRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("status"),
    at: IsoDateTimeSchema,
    status: WorkflowRunStatusSchema,
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("phase"),
    at: IsoDateTimeSchema,
    name: z.string().min(1),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("log"),
    at: IsoDateTimeSchema,
    message: z.string().min(1),
    data: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("agent-step"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    inputHash: z.string().min(1),
    status: z.enum(["reserving", "reserved", "failed"]),
    title: z.string().min(1).optional(),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("task"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    taskId: z.string().min(1),
    status: z.string().min(1),
    // Human-readable sub-agent title (matches the spawned workspace title).
    // Optional so legacy persisted events without it still parse.
    title: z.string().min(1).optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("timeout"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    taskId: z.string().min(1),
    phase: z.enum(["soft", "finalization_prompt_sent", "recovered", "hard"]),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("workflow"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    runId: WorkflowRunIdSchema,
    name: WorkflowNameSchema,
    status: z.enum(["started", "running", "backgrounded", "completed", "failed", "interrupted"]),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("patch"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    sourceTaskId: z.string().min(1),
    status: z.enum(["started", "applied", "conflict", "failed"]),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("action"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["started", "completed", "failed", "cached", "reconciled"]),
    effect: LegacyWorkflowHostStepEffectSchema,
    sourcePath: z.string().min(1).optional(),
    sourceHash: z.string().min(1).optional(),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("validation"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    success: z.boolean(),
    message: z.string().min(1).optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("result"),
    at: IsoDateTimeSchema,
    result: WorkflowResultSchema,
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("error"),
    at: IsoDateTimeSchema,
    message: z.string().min(1),
  }),
]);

export const WorkflowEventSequenceSchema = z
  .array(WorkflowRunEventSchema)
  .superRefine((events, ctx) => {
    let previousSequence = 0;
    for (const [index, event] of events.entries()) {
      if (event.sequence <= previousSequence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Workflow events must be strictly ordered by increasing sequence",
          path: [index, "sequence"],
        });
      }
      previousSequence = event.sequence;
    }
  });

export const WorkflowStepStatusSchema = z.enum(["started", "completed", "failed", "interrupted"]);

export const WorkflowStepTimeoutMetadataSchema = z
  .object({
    executionStartedAt: IsoDateTimeSchema.optional(),
    softDeadlineAt: IsoDateTimeSchema.optional(),
    hardDeadlineAt: IsoDateTimeSchema.optional(),
    softTimedOutAt: IsoDateTimeSchema.optional(),
    finalizationToken: z.string().min(1).optional(),
    finalizationPromptSentAt: IsoDateTimeSchema.optional(),
    hardTimedOutAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const WorkflowStepRecordSchema = z.object({
  stepId: z.string().min(1),
  inputHash: z.string().min(1),
  status: WorkflowStepStatusSchema,
  taskId: z.string().min(1).optional(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  result: StructuredTaskOutputSchema.optional(),
  timeout: WorkflowStepTimeoutMetadataSchema.optional(),
  error: z.string().min(1).optional(),
});

const WorkflowRunStatusTransitions: Record<
  z.infer<typeof WorkflowRunStatusSchema>,
  ReadonlyArray<z.infer<typeof WorkflowRunStatusSchema>>
> = {
  pending: ["running", "backgrounded", "interrupted", "failed"],
  running: ["backgrounded", "interrupted", "completed", "failed"],
  backgrounded: ["running", "interrupted", "completed", "failed"],
  interrupted: ["running", "failed"],
  completed: [],
  failed: [],
};

export const WorkflowRunStatusTransitionSchema = z
  .object({
    from: WorkflowRunStatusSchema,
    to: WorkflowRunStatusSchema,
  })
  .refine((transition) => WorkflowRunStatusTransitions[transition.from].includes(transition.to), {
    message: "Invalid workflow run status transition",
    path: ["to"],
  });

export const WorkflowRunParentSchema = z
  .object({
    runId: WorkflowRunIdSchema,
    stepId: z.string().min(1),
    inputHash: z.string().min(1),
    depth: z.number().int().nonnegative(),
  })
  .strict();

export const WorkflowRunRecordSchema = z.object({
  id: WorkflowRunIdSchema,
  workspaceId: z.string().min(1),
  workflow: WorkflowScriptDescriptorSchema,
  source: z.string().min(1),
  sourceHash: z.string().min(1),
  args: JsonValueSchema,
  agentOutputSchemaRequired: z.boolean().optional(),
  agentTypeAliasAllowed: z.boolean().optional(),
  parentWorkflow: WorkflowRunParentSchema.optional(),
  // How the owner workspace's stream-end treats this run while active. Background
  // runs are "notify_on_terminal"; missing/legacy records default to blocking.
  attentionPolicy: BackgroundWorkAttentionPolicySchema.optional(),
  status: WorkflowRunStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  events: WorkflowEventSequenceSchema,
  steps: z.array(WorkflowStepRecordSchema),
});

// Live stream events for `workflows.subscribe`: an initial snapshot of all
// top-level runs, then a full-record delta whenever any run is persisted. The
// client upserts by id, so a snapshot followed by an in-flight delta converges.
export const WorkflowRunStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runs: z.array(WorkflowRunRecordSchema),
  }),
  z.object({
    type: z.literal("run-changed"),
    run: WorkflowRunRecordSchema,
  }),
]);

// A workflow script available to run in a workspace, with its declared args, for
// the Workflows tab's empty-state launcher. `scriptPath` is the canonical path
// to pass back to `workflows.start`.
export const AvailableWorkflowSchema = z.object({
  descriptor: WorkflowScriptDescriptorSchema,
  scriptPath: z.string().min(1),
  args: z.array(WorkflowArgSummarySchema),
  /**
   * Present when the script declares meta.phases but the declaration is invalid.
   * Discovery never fails for this; the launcher shows the warning and no phase
   * preview (run creation will reject with the same issues).
   */
  phaseManifestWarning: z.string().min(1).optional(),
});
