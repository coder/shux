import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import { isActiveWorkflowRunStatus, type WorkflowRunRecord } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import {
  emitWorkflowRunAttachedEvent,
  parseToolResult,
  recordBackgroundWorkflowRunReference,
  requireWorkspaceId,
} from "./toolUtils";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  resolveWorkflowScript,
  type ResolvedWorkflowScript,
} from "@/node/services/workflows/workflowScriptResolver";
import type { Runtime } from "@/node/runtime/Runtime";

function requireWorkflowService(config: ToolConfiguration) {
  if (!config.workflowService) {
    throw new Error("workflow_run requires workflowService");
  }
  return config.workflowService;
}

function requireForegroundWorkflowStart(
  workflowService: NonNullable<ToolConfiguration["workflowService"]>
) {
  if (workflowService.startWorkflow == null) {
    throw new Error("workflow_run requires startWorkflow");
  }
  return workflowService.startWorkflow.bind(workflowService);
}

function requireBackgroundWorkflowStart(
  workflowService: NonNullable<ToolConfiguration["workflowService"]>
) {
  if (workflowService.startWorkflowInBackground == null) {
    throw new Error("workflow_run background mode requires startWorkflowInBackground");
  }
  return workflowService.startWorkflowInBackground.bind(workflowService);
}

/**
 * Serialize the duplicate-run check and durable run creation per workspace + script identity so
 * two overlapping workflow_run calls cannot both pass the check before either persists a run.
 * Released once the run record exists (or the launch fails before creating one), not at workflow
 * completion, so a later duplicate launch fails fast instead of queueing behind a foreground run.
 */
const scriptAdmissionTails = new Map<string, Promise<void>>();

async function acquireScriptAdmission(key: string): Promise<() => void> {
  const previous = scriptAdmissionTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  scriptAdmissionTails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (scriptAdmissionTails.get(key) === tail) {
      scriptAdmissionTails.delete(key);
    }
    releaseGate();
  };
}

function scriptIdentityKey(workspaceId: string, script: ResolvedWorkflowScript): string {
  // Workspace files key on the physical resolved path so equivalent spellings of the same
  // file ("./x.js" vs "x.js") contend on one admission gate; skill/plugin canonical paths
  // are already spelling-independent.
  const pathIdentity =
    script.sourceKind === "workspace-file"
      ? (script.resolvedPath ?? script.canonicalScriptPath)
      : script.canonicalScriptPath;
  const identity =
    script.sourceKind === "inline"
      ? `inline\u0000${script.sourceHash}`
      : `path\u0000${pathIdentity}`;
  return `${workspaceId}\u0000${identity}`;
}

/**
 * Same-script identity is the canonical identity persisted at run creation: source hash for
 * inline scripts, canonical script path otherwise. Plain path spellings are normalized so
 * "./x.js" and "x.js" match; alternate identities for the same file (symlinks, copies) are
 * deliberately not chased: that would need filesystem probing on every launch, and a missed
 * match for an exotic alias merely degrades to the pre-guard duplicate behavior.
 */
function hasSameCanonicalScript(
  run: WorkflowRunRecord,
  script: ResolvedWorkflowScript,
  runtime: Runtime,
  workspacePath: string
): boolean {
  if (script.sourceKind === "inline" || run.workflow.sourceKind === "inline") {
    // Match inline launches by source hash alone: legacy records may omit the optional
    // workflow.sourceKind, and identical source is the same workflow either way.
    return (
      script.sourceKind === "inline" &&
      (run.workflow.sourceHash ?? run.sourceHash) === script.sourceHash
    );
  }
  const stored = run.workflow.canonicalScriptPath ?? run.workflow.sourcePath;
  if (stored == null || stored.length === 0) {
    return false;
  }
  if (stored === script.canonicalScriptPath) {
    return true;
  }
  if (stored.includes("://") || script.canonicalScriptPath.includes("://")) {
    return false;
  }
  const normalizedStored = runtime.normalizePath(stored, workspacePath);
  return (
    normalizedStored === script.canonicalScriptPath ||
    (script.resolvedPath != null && normalizedStored === script.resolvedPath)
  );
}

async function assertNoActiveSameScriptRun(input: {
  workflowService: NonNullable<ToolConfiguration["workflowService"]>;
  workspaceId: string;
  script: ResolvedWorkflowScript;
  runtime: Runtime;
  workspacePath: string;
}): Promise<void> {
  if (input.workflowService.listRuns == null) {
    return;
  }
  let rawRuns: unknown[];
  try {
    rawRuns = await input.workflowService.listRuns({ workspaceId: input.workspaceId });
  } catch (error: unknown) {
    // Fail closed: skipping the check on a store read error could mint exactly the duplicate
    // this guard exists to prevent, and the caller has an explicit allow_concurrent escape hatch.
    throw new Error(
      "workflow_run refused: could not verify that no active run of this script exists " +
        `(workflow store read failed: ${getErrorMessage(error)}). ` +
        "Retry once the workflow store is readable, or pass allow_concurrent=true to bypass the duplicate guard."
    );
  }
  const conflicts: WorkflowRunRecord[] = [];
  for (const rawRun of rawRuns) {
    // Records that fail to parse are skipped, matching listRuns' own self-healing treatment of
    // unreadable runs: one malformed record must not brick every workflow launch.
    const parsed = WorkflowRunRecordSchema.safeParse(rawRun);
    if (!parsed.success || !isActiveWorkflowRunStatus(parsed.data.status)) {
      continue;
    }
    if (hasSameCanonicalScript(parsed.data, input.script, input.runtime, input.workspacePath)) {
      conflicts.push(parsed.data);
    }
  }
  if (conflicts.length === 0) {
    return;
  }
  const conflictDetails = conflicts
    .map((run) => `- runId=${run.id}, status=${run.status}, createdAt=${run.createdAt}`)
    .join("\n");
  throw new Error(
    "workflow_run refused because this script already has an active run in this workspace:\n" +
      conflictDetails +
      "\nReattach to running/backgrounded runs with task_await, resume pending runs with workflow_resume, " +
      "or pass allow_concurrent=true to intentionally start another concurrent run."
  );
}

function isBackgroundWorkflowResult(
  args: { run_in_background?: boolean | null },
  status: string
): boolean {
  return args.run_in_background === true || status === "backgrounded";
}

function isAwaitableRecoveredWorkflowStatus(status: WorkflowRunRecord["status"]): boolean {
  return status === "running" || status === "backgrounded";
}

function latestCompletedWorkflowResult(run: WorkflowRunRecord): unknown {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event?.type === "result") {
      return event.result;
    }
  }
  return null;
}

function workflowRunRecoveryNote(run: WorkflowRunRecord, error: unknown): string {
  const statusGuidance: Record<WorkflowRunRecord["status"], string> = {
    pending: "resume it with workflow_resume because no runner may be active yet",
    running: "await it with task_await",
    backgrounded: "await it with task_await",
    interrupted: "resume it with workflow_resume",
    failed: "use workflow_resume({ mode: 'retry_from_checkpoint' }) only if the run is eligible",
    completed: "inspect the returned durable result instead of rerunning",
  };
  return (
    `workflow_run errored after creating durable run \`${run.id}\`: ${getErrorMessage(error)}. ` +
    `The durable run is ${run.status}; ${statusGuidance[run.status]}. Do not start another copy.`
  );
}

export const createWorkflowRunTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_run.description,
    inputSchema: TOOL_DEFINITIONS.workflow_run.schema,
    execute: async (args, options): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "workflow_run");
      const workflowService = requireWorkflowService(config);
      const toolCallId = options.toolCallId;

      const skillCtx =
        config.xumScope?.type === "project"
          ? resolveSkillStorageContext({
              runtime: config.runtime,
              workspacePath: config.cwd,
              xumScope: config.xumScope,
              includeAgentPlugins: config.experiments?.agentPlugins === true,
            })
          : null;
      const script = await resolveWorkflowScript({
        scriptPath: args.script_path,
        scriptSource: args.script_source,
        runtime: config.runtime,
        workspacePath: config.cwd,
        projectTrusted: config.trusted === true,
        includeAgentPlugins: config.experiments?.agentPlugins === true,
        ...(skillCtx != null ? { skillStorageContext: skillCtx } : {}),
      });
      // Duplicate guard: a retried or replayed turn must not mint a second active run of the
      // same script. The admission gate serializes check + creation for one script identity.
      const releaseAdmission =
        args.allow_concurrent === true
          ? null
          : await acquireScriptAdmission(scriptIdentityKey(workspaceId, script));
      if (releaseAdmission != null) {
        try {
          await assertNoActiveSameScriptRun({
            workflowService,
            workspaceId,
            script,
            runtime: config.runtime,
            workspacePath: config.cwd,
          });
        } catch (error: unknown) {
          releaseAdmission();
          throw error;
        }
      }
      const createdRun: { id: string | null } = { id: null };
      const invocationStartedAtMs = Date.now();
      const startInput = {
        script,
        workspaceId,
        projectTrusted: config.trusted === true,
        args: args.args ?? {},
        onRunCreated: async (event: { runId: string; run: unknown }) => {
          createdRun.id = event.runId;
          // The run record is durable now, so a concurrent duplicate launch will see it.
          releaseAdmission?.();
          // Provenance must be durable BEFORE the runner starts: a fast background run (or a
          // process exit mid-dispatch) can reach terminal state before any post-dispatch
          // write, and a terminal wake with no sidecar reference is permanently superseded.
          if (args.run_in_background === true) {
            await recordBackgroundWorkflowRunReference(config, event.runId, invocationStartedAtMs, {
              propagateWriteFailure: true,
            });
          }
          await emitWorkflowRunAttachedEvent({
            config,
            workspaceId,
            toolCallId,
            runId: event.runId,
            run: event.run,
          });
        },
      };
      let result: { runId: string; status: string; result: unknown };
      try {
        result =
          args.run_in_background === true
            ? await requireBackgroundWorkflowStart(workflowService)({
                ...startInput,
                // Background runs are non-blocking; terminal result is delivered by
                // AIService.onBackgroundRunTerminal rather than a forced task_await.
                attentionPolicy: "notify_on_terminal",
              })
            : await requireForegroundWorkflowStart(workflowService)({
                ...startInput,
                ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
              });
      } catch (error: unknown) {
        const createdRunId = createdRun.id;
        if (createdRunId == null) {
          throw error;
        }
        if (workflowService.getRun == null) {
          throw new Error(
            `${getErrorMessage(error)} (workflow_run created durable run ${createdRunId} before failing)`
          );
        }

        const durableRun = await workflowService.getRun({ workspaceId, runId: createdRunId });
        const parsedRun = WorkflowRunRecordSchema.safeParse(durableRun);
        if (!parsedRun.success) {
          throw new Error(
            `${getErrorMessage(error)} (workflow_run created durable run ${createdRunId}, but the run could not be fetched or parsed)`
          );
        }

        const run = parsedRun.data;
        if (isAwaitableRecoveredWorkflowStatus(run.status)) {
          await recordBackgroundWorkflowRunReference(config, run.id, invocationStartedAtMs);
        }

        return parseToolResult(
          WorkflowRunToolResultSchema,
          {
            status: run.status,
            runId: run.id,
            result: run.status === "completed" ? latestCompletedWorkflowResult(run) : null,
            run,
            note: workflowRunRecoveryNote(run, error),
          },
          "workflow_run"
        );
      } finally {
        // Covers launches that fail before creating a durable run; release is idempotent.
        releaseAdmission?.();
      }

      // Explicit background launches already recorded provenance in onRunCreated; this covers
      // a foreground dispatch that backgrounded itself, where the run ID outcome is only
      // knowable post-dispatch.
      if (args.run_in_background !== true && isBackgroundWorkflowResult(args, result.status)) {
        await recordBackgroundWorkflowRunReference(config, result.runId, invocationStartedAtMs);
      }

      const run = await workflowService.getRun?.({ workspaceId, runId: result.runId });

      return parseToolResult(
        WorkflowRunToolResultSchema,
        {
          status: result.status,
          runId: result.runId,
          result: result.result,
          ...(run != null ? { run } : {}),
          ...(result.status === "completed" ? { note: COMPLETED_REPORT_REFETCH_NOTE } : {}),
        },
        "workflow_run"
      );
    },
  });
};
