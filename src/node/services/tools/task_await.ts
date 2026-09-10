import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  TaskAwaitToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { canRetryWorkflowFromCheckpoint } from "@/common/utils/workflowRetryEligibility";
import {
  isActiveWorkflowRunStatus,
  isNestedWorkflowRun,
  isTerminalWorkflowRunStatus,
  type WorkflowRunRecord,
} from "@/common/types/workflow";

import { fromBashTaskId, isWorkflowRunTaskId, toBashTaskId } from "./taskId";
import { formatBashOutputReport } from "./bashTaskReport";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceTurnManager,
  requireWorkspaceId,
} from "./toolUtils";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isActiveWorkspaceTurnTaskStatus,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";
import { buildWorkflowProgressSummary, formatWorkflowProgressNote } from "./workflowProgress";
import type { AgentTaskStatus } from "@/node/services/taskWorkspaceSeam";
import {
  ForegroundWaitBackgroundedError,
  type AgentTaskStatusLookup,
  type AgentTaskTimestamps,
} from "@/node/services/taskService";

const DEFAULT_TASK_AWAIT_TIMEOUT_MS = 600_000;
const WORKFLOW_AWAIT_POLL_INTERVAL_MS = 250;
// Shared fallback used when a workspace-turn record errored without a specific message,
// so every error-status await result path reports identical text.
const WORKSPACE_TURN_DEFAULT_ERROR = "Workspace turn failed";

// Status values for which task_await still treats an agent task as live and
// should surface the live status (plus an `elapsed_ms` field) instead of
// awaiting a report. Centralised here so the timeout=0 and "timed out" error
// branches below stay in lockstep when shared fields are added — see #3234,
// which extended both branches symmetrically with `getAgentTaskElapsedField`.
type AgentTaskActiveStatus = "queued" | "starting" | "running" | "awaiting_report";

function isAgentTaskActiveStatus(status: AgentTaskStatus | null): status is AgentTaskActiveStatus {
  return (
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "awaiting_report"
  );
}

function coerceTimeoutMs(timeoutSecs: unknown): number | undefined {
  if (typeof timeoutSecs !== "number" || !Number.isFinite(timeoutSecs)) return undefined;
  if (timeoutSecs < 0) return undefined;
  const timeoutMs = Math.floor(timeoutSecs * 1000);
  return timeoutMs;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function getAgentTaskElapsedMs(
  timestamps: AgentTaskTimestamps | null | undefined
): number | undefined {
  const createdAtMs = parseTimestampMs(timestamps?.createdAt);
  if (createdAtMs == null) {
    return undefined;
  }

  const endAtMs = parseTimestampMs(timestamps?.reportedAt) ?? Date.now();
  return Math.max(0, endAtMs - createdAtMs);
}

function withElapsedMs(elapsedMs: number | undefined): { elapsed_ms?: number } {
  return elapsedMs == null ? {} : { elapsed_ms: elapsedMs };
}

function buildTaskAwaitSequencingError(taskId: string, suggestedTaskIds: string[]) {
  return {
    status: "error" as const,
    taskId,
    error:
      "Do not call task_await in the same parallel tool-call batch as task or bash. " +
      "Wait for the spawning tool result first, then call task_await in a later step. " +
      `Use one of these returned task IDs instead: ${suggestedTaskIds.join(", ")}.`,
  };
}

function getWorkflowRunElapsedMs(run: WorkflowRunRecord): number | undefined {
  const createdAtMs = parseTimestampMs(run.createdAt);
  if (createdAtMs == null) {
    return undefined;
  }
  const updatedAtMs = parseTimestampMs(run.updatedAt);
  const endAtMs = isTerminalWorkflowRunStatus(run.status) ? updatedAtMs : Date.now();
  return Math.max(0, (endAtMs ?? Date.now()) - createdAtMs);
}

function getWorkflowRunReport(run: WorkflowRunRecord): {
  reportMarkdown: string;
  structuredOutput?: unknown;
} {
  const result = run.events.findLast((event) => event.type === "result")?.result;
  if (result != null) {
    return result;
  }
  return { reportMarkdown: `Workflow ${run.workflow.name} completed without a final report.` };
}

function getWorkflowRunError(run: WorkflowRunRecord): string {
  const message =
    run.events.findLast((event) => event.type === "error")?.message ??
    `Workflow ${run.workflow.name} failed.`;
  // Surface the recovery affordance exactly where the agent sees the failure.
  if (canRetryWorkflowFromCheckpoint(run)) {
    return `${message} The run can be retried from its last durable checkpoint with workflow_resume (mode 'retry_from_checkpoint').`;
  }
  return message;
}

// Failure is the one case where workflow state helps the model decide between
// workflow_resume (retry_from_checkpoint) and a fresh workflow_run. Per-step outcomes are
// enough: completed steps keep their taskId so their durable reports stay re-fetchable via
// task_await without re-running anything.
function buildWorkflowFailureState(run: WorkflowRunRecord) {
  return {
    name: run.workflow.name,
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      ...(step.taskId != null ? { taskId: step.taskId } : {}),
      ...(step.error != null ? { error: step.error } : {}),
    })),
  };
}

function buildWorkflowAwaitResult(run: WorkflowRunRecord) {
  // Deliberately omit the full run record (script source, event log, step snapshots):
  // it is huge and model-facing only. In-progress events may never materialize in the final
  // result, so the model only needs the status plus the final report/error.
  const base = {
    taskId: run.id,
    ...withElapsedMs(getWorkflowRunElapsedMs(run)),
  };
  const workflowProgress = buildWorkflowProgressSummary(run);
  const workflowProgressField = workflowProgress == null ? {} : { workflowProgress };

  switch (run.status) {
    case "completed": {
      const result = getWorkflowRunReport(run);
      return {
        status: "completed" as const,
        ...base,
        reportMarkdown: result.reportMarkdown,
        ...(result.structuredOutput !== undefined
          ? { structuredOutput: result.structuredOutput }
          : {}),
        title: run.workflow.name,
        note: COMPLETED_REPORT_REFETCH_NOTE,
      };
    }
    case "failed":
      return {
        status: "error" as const,
        ...base,
        error: getWorkflowRunError(run),
        workflow: buildWorkflowFailureState(run),
      };
    case "interrupted":
      return {
        status: "interrupted" as const,
        ...base,
        note: `Workflow ${run.workflow.name} was interrupted. Durable state is preserved; resume it with workflow_resume.`,
      };
    case "pending":
      return {
        status: "queued" as const,
        ...base,
        ...workflowProgressField,
        note: formatWorkflowProgressNote(`Workflow ${run.workflow.name} is queued.`, run),
      };
    case "backgrounded":
      return {
        status: "backgrounded" as const,
        ...base,
        ...workflowProgressField,
        note: formatWorkflowProgressNote(
          `Workflow ${run.workflow.name} is backgrounded. Use task_await to monitor progress.`,
          run
        ),
      };
    case "running":
      return {
        status: "running" as const,
        ...base,
        ...workflowProgressField,
        note: formatWorkflowProgressNote(`Workflow ${run.workflow.name} is still running.`, run),
      };
  }
}

async function waitForDelayOrAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export const createTaskAwaitTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_await.description,
    inputSchema: TOOL_DEFINITIONS.task_await.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_await");
      const taskService = requireTaskService(config, "task_await");
      const workspaceTurnManager = requireWorkspaceTurnManager(config, "task_await");

      const timeoutMs = coerceTimeoutMs(args.timeout_secs);
      // Preserve the documented 600s default when the model sends null
      // (Zod .default() only replaces undefined, not null).
      const timeoutSecsForBash = args.timeout_secs ?? 600;

      const requestedIds: string[] | null =
        args.task_ids && args.task_ids.length > 0 ? args.task_ids : null;

      const activeDescendantAgentTaskIds = taskService.listActiveDescendantAgentTaskIds(
        workspaceId,
        { excludeWorkflowTasks: true }
      );
      const isWorkflowOwnedDescendantAgentTask = async (taskId: string): Promise<boolean> =>
        (await taskService.isWorkflowOwnedDescendantAgentTask?.(workspaceId, taskId)) ?? false;

      const listInScopeBackgroundBashTaskIds = async (): Promise<string[]> => {
        if (!config.backgroundProcessManager) {
          return [];
        }

        const bashTaskIds: string[] = [];
        const processes = await config.backgroundProcessManager.list();
        for (const proc of processes) {
          if (proc.status !== "running") continue;
          const inScope =
            proc.workspaceId === workspaceId ||
            (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
          if (!inScope) continue;
          if (
            proc.workspaceId !== workspaceId &&
            (await isWorkflowOwnedDescendantAgentTask(proc.workspaceId))
          ) {
            continue;
          }

          bashTaskIds.push(toBashTaskId(proc.id));
        }

        return dedupeStrings(bashTaskIds);
      };
      const listInScopeWorkflowRunIds = async (): Promise<string[]> => {
        if (config.workflowService?.listRuns == null) {
          return [];
        }

        const workflowRunIds: string[] = [];
        const runs = await config.workflowService.listRuns({ workspaceId });
        for (const rawRun of runs) {
          const parsed = WorkflowRunRecordSchema.safeParse(rawRun);
          if (
            !parsed.success ||
            !isActiveWorkflowRunStatus(parsed.data.status) ||
            isNestedWorkflowRun(parsed.data)
          ) {
            continue;
          }
          workflowRunIds.push(parsed.data.id);
        }
        return dedupeStrings(workflowRunIds);
      };
      const listInScopeWorkspaceTurnTaskIds = async (): Promise<string[]> => {
        if (workspaceTurnManager.listWorkspaceTurnTasks == null) {
          return [];
        }
        const turns = await workspaceTurnManager.listWorkspaceTurnTasks(workspaceId, {
          statuses: ["queued", "starting", "running"],
        });
        const publicTurnIds: string[] = [];
        for (const turn of turns) {
          // Reactivated sub-agents use private workspace-turn executions. The stable child task ID
          // already represents that work, so enumerating the internal handle would await it twice.
          if (await taskService.isDescendantAgentTask(workspaceId, turn.workspaceId)) {
            continue;
          }
          publicTurnIds.push(turn.handleId);
        }
        return publicTurnIds;
      };
      const listInScopeAwaitableTaskIds = async (): Promise<string[]> => {
        const awaitableTaskIds = [...activeDescendantAgentTaskIds];
        awaitableTaskIds.push(...(await listInScopeWorkspaceTurnTaskIds()));
        awaitableTaskIds.push(...(await listInScopeBackgroundBashTaskIds()));
        awaitableTaskIds.push(...(await listInScopeWorkflowRunIds()));
        return dedupeStrings(awaitableTaskIds);
      };
      let suggestionBashTaskIdsPromise: Promise<string[]> | undefined;
      const getSuggestionBashTaskIds = async (): Promise<string[]> => {
        suggestionBashTaskIdsPromise ??= listInScopeBackgroundBashTaskIds().catch(() => []);
        return await suggestionBashTaskIdsPromise;
      };
      let suggestionWorkflowRunIdsPromise: Promise<string[]> | undefined;
      const getSuggestionWorkflowRunIds = async (): Promise<string[]> => {
        suggestionWorkflowRunIdsPromise ??= listInScopeWorkflowRunIds().catch(() => []);
        return await suggestionWorkflowRunIdsPromise;
      };
      const uniqueTaskIds = requestedIds
        ? dedupeStrings(requestedIds)
        : await listInScopeAwaitableTaskIds();

      const agentTaskIds = uniqueTaskIds.filter(
        (taskId) =>
          !taskId.startsWith("bash:") &&
          !isWorkflowRunTaskId(taskId) &&
          !isWorkspaceTurnTaskId(taskId)
      );
      const bulkFilter = taskService.filterDescendantAgentTaskIds?.bind(taskService);

      // Read patch artifacts lazily (after waiting) to avoid stale results. Patch generation
      // runs asynchronously (started in `finalizeAgentTaskReport` before waiters resolve), so
      // the artifact may still be "pending" at read time — task_apply_git_patch does a fresh read.
      const readGitFormatPatchArtifact = async (childTaskId: string) => {
        if (!config.workspaceSessionDir) return null;
        return await readSubagentGitPatchArtifact(config.workspaceSessionDir, childTaskId);
      };

      // Agent task records currently store creation/report timestamps, but not a separate
      // running-start timestamp, so this elapsed value intentionally includes queued time.
      const getAgentTaskElapsedField = (taskId: string) =>
        withElapsedMs(getAgentTaskElapsedMs(taskService.getAgentTaskTimestamps?.(taskId)));

      const descendantAgentTaskIds =
        typeof bulkFilter === "function"
          ? await bulkFilter(workspaceId, agentTaskIds)
          : (
              await Promise.all(
                agentTaskIds.map(async (taskId) =>
                  (await taskService.isDescendantAgentTask(workspaceId, taskId)) ? taskId : null
                )
              )
            ).filter((taskId): taskId is string => typeof taskId === "string");

      const awaitableAgentTaskIds: string[] = [];
      for (const taskId of descendantAgentTaskIds) {
        if (await isWorkflowOwnedDescendantAgentTask(taskId)) {
          continue;
        }
        awaitableAgentTaskIds.push(taskId);
      }

      const descendantAgentTaskIdSet = new Set(awaitableAgentTaskIds);
      const rejectedAgentTaskIds = agentTaskIds.filter(
        (taskId) => !descendantAgentTaskIdSet.has(taskId)
      );
      const rejectedAgentTaskStatuses =
        rejectedAgentTaskIds.length > 0
          ? taskService.getAgentTaskStatuses(rejectedAgentTaskIds)
          : new Map<string, AgentTaskStatusLookup>();

      const getWorkflowRun = async (runId: string): Promise<WorkflowRunRecord | null> => {
        if (config.workflowService?.getRun == null) {
          throw new Error("workflowService not available for workflow run awaits");
        }
        const run = await config.workflowService.getRun({ workspaceId, runId });
        if (run == null) {
          return null;
        }
        return WorkflowRunRecordSchema.parse(run);
      };

      const markWorkflowTerminalAttentionConsumed = async (
        run: WorkflowRunRecord
      ): Promise<void> => {
        if (!isTerminalWorkflowRunStatus(run.status)) {
          return;
        }
        await taskService.markWorkflowRunTerminalAttentionSettled?.({
          ownerWorkspaceId: workspaceId,
          status: run.status,
          runId: run.id,
          runUpdatedAt: run.updatedAt,
          settledAs: "delivered",
        });
      };

      const awaitWorkflowRun = async (runId: string, taskSignal: AbortSignal) => {
        let run = await getWorkflowRun(runId);
        if (run == null) {
          return { status: "not_found" as const, taskId: runId };
        }
        if (timeoutMs === 0 || isTerminalWorkflowRunStatus(run.status)) {
          await markWorkflowTerminalAttentionConsumed(run);
          return buildWorkflowAwaitResult(run);
        }

        const deadline = Date.now() + (timeoutMs ?? DEFAULT_TASK_AWAIT_TIMEOUT_MS);
        while (!isTerminalWorkflowRunStatus(run.status)) {
          if (abortSignal?.aborted) {
            return { status: "error" as const, taskId: runId, error: "Interrupted" };
          }
          if (taskSignal.aborted || Date.now() >= deadline) {
            return buildWorkflowAwaitResult(run);
          }

          const remainingMs = Math.max(1, deadline - Date.now());
          await waitForDelayOrAbort(
            Math.min(WORKFLOW_AWAIT_POLL_INTERVAL_MS, remainingMs),
            taskSignal
          );
          if (taskSignal.aborted) {
            return buildWorkflowAwaitResult(run);
          }

          const nextRun = await getWorkflowRun(runId);
          if (nextRun == null) {
            return { status: "not_found" as const, taskId: runId };
          }
          run = nextRun;
        }

        await markWorkflowTerminalAttentionConsumed(run);
        return buildWorkflowAwaitResult(run);
      };

      // task_await resolves once `min_completed` tasks have completed (default 1 = return on the
      // first completion) rather than always blocking on every awaited task. Each task gets its
      // own AbortController chained to the tool-call signal so that, once we have enough
      // completions, we can detach the still-pending waiters/reads without terminating those
      // children — they keep running and remain re-awaitable later (reports stay cached in
      // TaskService and the child's bash poll is merely interrupted, not killed).
      const awaitOne = async (taskId: string, taskSignal: AbortSignal) => {
        const maybeProcessId = fromBashTaskId(taskId);
        if (taskId.startsWith("bash:") && !maybeProcessId) {
          return { status: "error" as const, taskId, error: "Invalid bash taskId." };
        }

        if (maybeProcessId) {
          if (!config.backgroundProcessManager) {
            return {
              status: "error" as const,
              taskId,
              error: "Background process manager not available",
            };
          }

          const proc = await config.backgroundProcessManager.getProcess(maybeProcessId);
          if (!proc) {
            return { status: "not_found" as const, taskId };
          }

          const inScope =
            proc.workspaceId === workspaceId ||
            (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
          if (!inScope) {
            return { status: "invalid_scope" as const, taskId };
          }
          if (
            proc.workspaceId !== workspaceId &&
            (await isWorkflowOwnedDescendantAgentTask(proc.workspaceId))
          ) {
            return { status: "invalid_scope" as const, taskId };
          }

          const outputResult = await config.backgroundProcessManager.getOutput(
            maybeProcessId,
            args.filter ?? undefined,
            args.filter_exclude ?? undefined,
            timeoutSecsForBash,
            taskSignal,
            workspaceId,
            "task_await"
          );

          if (!outputResult.success) {
            return { status: "error" as const, taskId, error: outputResult.error };
          }

          if (outputResult.status === "running" || outputResult.status === "interrupted") {
            return {
              status: "running" as const,
              taskId,
              output: outputResult.output,
              elapsed_ms: outputResult.elapsed_ms,
              note: outputResult.note,
            };
          }

          return {
            status: "completed" as const,
            taskId,
            title: proc.displayName ?? proc.id,
            reportMarkdown: formatBashOutputReport({
              processId: proc.id,
              status: outputResult.status,
              exitCode: outputResult.exitCode,
              output: outputResult.output,
            }),
            elapsed_ms: outputResult.elapsed_ms,
            exitCode: outputResult.exitCode,
            note: outputResult.note,
          };
        }

        const getAgentTaskExecutionId = taskService.getAgentTaskExecutionId?.bind(taskService);
        const workspaceTurnTaskId = isWorkspaceTurnTaskId(taskId)
          ? taskId
          : getAgentTaskExecutionId?.(taskId);
        if (workspaceTurnTaskId != null) {
          const isAgentContinuation = workspaceTurnTaskId !== taskId;
          const resolveAgentExecution =
            taskService.getDescendantAgentTaskExecutionSnapshot?.bind(taskService);
          const resolvedExecution =
            isAgentContinuation && resolveAgentExecution != null
              ? await resolveAgentExecution(workspaceId, taskId, {
                  consumingWorkspaceId: workspaceId,
                })
              : null;
          const workspaceTurnOwnerId = resolvedExecution?.ownerWorkspaceId ?? workspaceId;
          const getWorkspaceTurnSnapshotForAwait = () =>
            workspaceTurnManager.getWorkspaceTurnSnapshot(
              workspaceTurnOwnerId,
              workspaceTurnTaskId,
              {
                consumingWorkspaceId: workspaceId,
              }
            );
          const snapshot =
            resolvedExecution?.record ??
            (resolveAgentExecution == null || !isAgentContinuation
              ? await getWorkspaceTurnSnapshotForAwait()
              : null);
          if (snapshot == null) {
            const activeTaskIds = requestedIds
              ? await listInScopeWorkspaceTurnTaskIds().catch(() => undefined)
              : undefined;
            return {
              status: requestedIds ? ("invalid_scope" as const) : ("not_found" as const),
              taskId,
              activeTaskIds,
            };
          }
          const workspaceTurnIdentityFields = (targetWorkspaceId: string) =>
            isAgentContinuation
              ? {}
              : { handleKind: "workspace_turn" as const, workspaceId: targetWorkspaceId };
          const markWorkspaceTurnTerminalAttentionConsumed = async (record: {
            status: WorkspaceTurnTaskStatus;
            updatedAt: string;
          }): Promise<void> => {
            await workspaceTurnManager.markWorkspaceTurnTerminalAttentionConsumed?.({
              ownerWorkspaceId: workspaceTurnOwnerId,
              consumingWorkspaceId: workspaceId,
              handleId: workspaceTurnTaskId,
              status: record.status,
              updatedAt: record.updatedAt,
            });
          };
          // task_await returns the terminal "completed" workspace-turn result from
          // several await paths (immediate snapshot, task-signal abort race, timeout
          // race, and generic wait rejection). Build the shared shape once so those
          // paths cannot drift on the reported fields or fallback copy.
          const completedWorkspaceTurnResult = (record: WorkspaceTurnTaskHandleRecord) => ({
            status: "completed" as const,
            taskId,
            ...workspaceTurnIdentityFields(record.workspaceId),
            reportMarkdown:
              record.reportMarkdown ?? "Workspace turn completed without final text output.",
            title: record.title,
            messageId: record.messageId,
            finalMessageRef: record.finalMessageRef,
            note: COMPLETED_REPORT_REFETCH_NOTE,
          });
          // Interrupted handles persist a human-readable reason (e.g. "superseded by
          // new input in the target workspace") that lets the owner distinguish
          // supersession from an explicit cancellation — surface it in the note.
          const interruptedWorkspaceTurnResult = (record: WorkspaceTurnTaskHandleRecord) => ({
            status: "interrupted" as const,
            taskId,
            ...workspaceTurnIdentityFields(record.workspaceId),
            note:
              record.error != null && record.error.length > 0
                ? `Workspace turn was interrupted: ${record.error}. The full workspace is preserved.`
                : "Workspace turn was interrupted. The full workspace is preserved.",
          });
          if (timeoutMs === 0 || !isActiveWorkspaceTurnTaskStatus(snapshot.status)) {
            if (snapshot.status === "completed") {
              await markWorkspaceTurnTerminalAttentionConsumed(snapshot);
              return completedWorkspaceTurnResult(snapshot);
            }
            if (snapshot.status === "interrupted") {
              await markWorkspaceTurnTerminalAttentionConsumed(snapshot);
              return interruptedWorkspaceTurnResult(snapshot);
            }
            if (snapshot.status === "error") {
              await markWorkspaceTurnTerminalAttentionConsumed(snapshot);
              return {
                status: "error" as const,
                taskId,
                error: snapshot.error ?? WORKSPACE_TURN_DEFAULT_ERROR,
              };
            }
          }
          if (timeoutMs === 0) {
            return {
              status: snapshot.status as "queued" | "starting" | "running",
              taskId,
              ...workspaceTurnIdentityFields(snapshot.workspaceId),
              note: "Workspace turn is still running.",
            };
          }
          try {
            const report = await workspaceTurnManager.waitForWorkspaceTurn(workspaceTurnTaskId, {
              timeoutMs: timeoutMs ?? DEFAULT_TASK_AWAIT_TIMEOUT_MS,
              abortSignal: taskSignal,
              requestingWorkspaceId: workspaceId,
              ownerWorkspaceId: workspaceTurnOwnerId,
              backgroundOnMessageQueued: true,
            });
            await markWorkspaceTurnTerminalAttentionConsumed({
              status: "completed",
              updatedAt: report.updatedAt,
            });
            return {
              status: "completed" as const,
              taskId,
              ...workspaceTurnIdentityFields(report.workspaceId),
              reportMarkdown: report.reportMarkdown,
              title: report.title,
              messageId: report.messageId,
              finalMessageRef: report.finalMessageRef,
              note: COMPLETED_REPORT_REFETCH_NOTE,
            };
          } catch (error: unknown) {
            const message = getErrorMessage(error);
            if (error instanceof ForegroundWaitBackgroundedError) {
              const latest = await getWorkspaceTurnSnapshotForAwait();
              const status =
                latest != null && isActiveWorkspaceTurnTaskStatus(latest.status)
                  ? latest.status
                  : ("running" as const);
              return {
                status,
                taskId,
                ...(latest?.workspaceId != null
                  ? workspaceTurnIdentityFields(latest.workspaceId)
                  : {}),
                note: "Workspace turn sent to background because a new message was queued. Use task_await to monitor progress.",
              };
            }
            if (abortSignal?.aborted) {
              return { status: "error" as const, taskId, error: "Interrupted" };
            }
            if (taskSignal.aborted) {
              const latest = await getWorkspaceTurnSnapshotForAwait();
              if (latest == null) return { status: "not_found" as const, taskId };
              if (latest.status === "completed") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return completedWorkspaceTurnResult(latest);
              }
              if (latest.status === "error") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return {
                  status: "error" as const,
                  taskId,
                  error: latest.error ?? WORKSPACE_TURN_DEFAULT_ERROR,
                };
              }
              if (latest.status === "interrupted") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return interruptedWorkspaceTurnResult(latest);
              }
              return {
                status: latest.status,
                taskId,
                ...workspaceTurnIdentityFields(latest.workspaceId),
                note: "Workspace turn await detached; task continues in background.",
              };
            }
            if (/timed out/i.test(message)) {
              const latest = await getWorkspaceTurnSnapshotForAwait();
              if (latest == null) return { status: "not_found" as const, taskId };
              if (latest.status === "completed") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return completedWorkspaceTurnResult(latest);
              }
              if (latest.status === "error") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return {
                  status: "error" as const,
                  taskId,
                  error: latest.error ?? WORKSPACE_TURN_DEFAULT_ERROR,
                };
              }
              if (latest.status === "interrupted") {
                await markWorkspaceTurnTerminalAttentionConsumed(latest);
                return interruptedWorkspaceTurnResult(latest);
              }
              return {
                status: latest.status,
                taskId,
                ...workspaceTurnIdentityFields(latest.workspaceId),
              };
            }
            if (/out of scope/i.test(message) || /not found/i.test(message)) {
              return { status: "invalid_scope" as const, taskId };
            }
            const latest = await getWorkspaceTurnSnapshotForAwait().catch(() => null);
            if (latest?.status === "completed") {
              await markWorkspaceTurnTerminalAttentionConsumed(latest);
              return completedWorkspaceTurnResult(latest);
            }
            if (latest?.status === "error") {
              await markWorkspaceTurnTerminalAttentionConsumed(latest);
              return {
                status: "error" as const,
                taskId,
                error: latest.error ?? WORKSPACE_TURN_DEFAULT_ERROR,
              };
            }
            if (latest?.status === "interrupted") {
              await markWorkspaceTurnTerminalAttentionConsumed(latest);
              return interruptedWorkspaceTurnResult(latest);
            }
            return { status: "error" as const, taskId, error: message };
          }
        }

        if (isWorkflowRunTaskId(taskId)) {
          return await awaitWorkflowRun(taskId, taskSignal);
        }

        if (!descendantAgentTaskIdSet.has(taskId)) {
          const lookup = rejectedAgentTaskStatuses.get(taskId);
          const activeTaskIds =
            activeDescendantAgentTaskIds.length > 0 ? activeDescendantAgentTaskIds : undefined;
          if (requestedIds) {
            const suggestedTaskIds = dedupeStrings([
              ...activeDescendantAgentTaskIds,
              ...(await listInScopeWorkspaceTurnTaskIds().catch(() => [])),
              ...(await getSuggestionBashTaskIds()),
              ...(await getSuggestionWorkflowRunIds()),
            ]);
            if (suggestedTaskIds.length > 0) {
              return buildTaskAwaitSequencingError(taskId, suggestedTaskIds);
            }
          }
          if (!lookup?.exists) {
            return { status: "not_found" as const, taskId, activeTaskIds };
          }
          return { status: "invalid_scope" as const, taskId, activeTaskIds };
        }

        // When timeout_secs=0 (or rounds down to 0ms), task_await should be non-blocking.
        // `waitForAgentReport` asserts timeoutMs > 0, so handle 0 explicitly by returning the
        // current task status instead of awaiting.
        if (timeoutMs === 0) {
          const status = taskService.getAgentTaskStatus(taskId);
          if (isAgentTaskActiveStatus(status)) {
            return { status, taskId, ...getAgentTaskElapsedField(taskId) };
          }

          // Best-effort: the task might already have a cached report (even if its workspace was
          // cleaned up). Avoid blocking when it isn't available.
          try {
            const report = await taskService.waitForAgentReport(taskId, {
              timeoutMs: 1,
              abortSignal: taskSignal,
              requestingWorkspaceId: workspaceId,
              backgroundOnMessageQueued: true,
            });

            const gitFormatPatch = await readGitFormatPatchArtifact(taskId);
            return {
              status: "completed" as const,
              taskId,
              reportMarkdown: report.reportMarkdown,
              structuredOutput: report.structuredOutput,
              title: report.title,
              ...(report.model != null ? { modelString: report.model } : {}),
              ...(report.thinkingLevel != null ? { thinkingLevel: report.thinkingLevel } : {}),
              ...getAgentTaskElapsedField(taskId),
              ...(gitFormatPatch ? { artifacts: { gitFormatPatch } } : {}),
              note: COMPLETED_REPORT_REFETCH_NOTE,
            };
          } catch (error: unknown) {
            const message = getErrorMessage(error);
            if (/not found/i.test(message)) {
              return { status: "not_found" as const, taskId };
            }
            return { status: "error" as const, taskId, error: message };
          }
        }

        try {
          const report = await taskService.waitForAgentReport(taskId, {
            timeoutMs,
            abortSignal: taskSignal,
            requestingWorkspaceId: workspaceId,
            backgroundOnMessageQueued: true,
          });

          const gitFormatPatch = await readGitFormatPatchArtifact(taskId);
          return {
            status: "completed" as const,
            taskId,
            reportMarkdown: report.reportMarkdown,
            structuredOutput: report.structuredOutput,
            title: report.title,
            ...(report.model != null ? { modelString: report.model } : {}),
            ...(report.thinkingLevel != null ? { thinkingLevel: report.thinkingLevel } : {}),
            ...getAgentTaskElapsedField(taskId),
            ...(gitFormatPatch ? { artifacts: { gitFormatPatch } } : {}),
            note: COMPLETED_REPORT_REFETCH_NOTE,
          };
        } catch (error: unknown) {
          if (error instanceof ForegroundWaitBackgroundedError) {
            const currentStatus = taskService.getAgentTaskStatus(taskId);
            const normalizedStatus = isAgentTaskActiveStatus(currentStatus)
              ? currentStatus
              : ("running" as const);
            return {
              status: normalizedStatus,
              taskId,
              ...getAgentTaskElapsedField(taskId),
              note: "Task sent to background because a new message was queued. Use task_await to monitor progress.",
            };
          }

          if (abortSignal?.aborted) {
            return { status: "error" as const, taskId, error: "Interrupted" };
          }

          // Intentional early-stop: this task's per-task signal was aborted because
          // `min_completed` was already satisfied by other tasks (the outer tool-call signal is
          // not aborted). The child keeps running and its report stays re-awaitable on a later
          // task_await call, so report a live status snapshot instead of an error.
          if (taskSignal.aborted) {
            const status = taskService.getAgentTaskStatus(taskId);
            const normalizedStatus = isAgentTaskActiveStatus(status)
              ? status
              : ("running" as const);
            return { status: normalizedStatus, taskId, ...getAgentTaskElapsedField(taskId) };
          }

          const message = getErrorMessage(error);
          if (/not found/i.test(message)) {
            return { status: "not_found" as const, taskId };
          }
          if (/timed out/i.test(message)) {
            const status = taskService.getAgentTaskStatus(taskId);
            if (isAgentTaskActiveStatus(status)) {
              return { status, taskId, ...getAgentTaskElapsedField(taskId) };
            }
            if (!status) {
              return { status: "not_found" as const, taskId };
            }
            return {
              status: "error" as const,
              taskId,
              error: `Task status is '${status}' (not awaitable via task_await).`,
            };
          }
          return { status: "error" as const, taskId, error: message };
        }
      };

      const requestedMinCompleted = typeof args.min_completed === "number" ? args.min_completed : 1;
      // Clamp to [1, number of awaited tasks]; values above the count behave like "wait for all".
      // timeout_secs=0 is an explicit non-blocking snapshot of every task, so never early-return
      // there — wait for all per-task results (which all resolve immediately) instead.
      const wantCount =
        timeoutMs === 0
          ? Math.max(uniqueTaskIds.length, 1)
          : Math.min(Math.max(requestedMinCompleted, 1), Math.max(uniqueTaskIds.length, 1));

      const taskControllers = new Map<string, AbortController>();
      for (const taskId of uniqueTaskIds) {
        const controller = new AbortController();
        // Propagate a real tool-call interrupt to every per-task wait.
        if (abortSignal) {
          if (abortSignal.aborted) {
            controller.abort();
          } else {
            abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
          }
        }
        taskControllers.set(taskId, controller);
      }

      const resultsByTaskId = new Map<string, Awaited<ReturnType<typeof awaitOne>>>();
      let completedCount = 0;
      const taskPromises = uniqueTaskIds.map((taskId) => {
        // awaitOne resolves to a result object for every documented path, but a few calls (e.g. the
        // bash getProcess/getOutput reads) run outside its internal try/catch and could reject.
        // Convert any stray rejection into an `error` result so the task still counts as settled —
        // otherwise the gate below could never reach `wantCount` or "all settled" and would stall.
        const promise = awaitOne(taskId, taskControllers.get(taskId)!.signal).catch(
          (error: unknown): Awaited<ReturnType<typeof awaitOne>> => ({
            status: "error",
            taskId,
            error: getErrorMessage(error),
          })
        );
        // Record results as they settle so we can both count completions and assemble the final
        // array. Registered before the gate listener below, so recording always runs first for a
        // given promise.
        void promise.then((res) => {
          resultsByTaskId.set(taskId, res);
          if (res.status === "completed") {
            completedCount += 1;
          }
        });
        return promise;
      });

      // Resolve once `wantCount` tasks have completed, or every awaited task has otherwise settled
      // (failed/interrupted/timed out) — so an unreachable threshold still returns promptly.
      await new Promise<void>((resolveGate) => {
        if (uniqueTaskIds.length === 0) {
          resolveGate();
          return;
        }
        let gateResolved = false;
        const checkGate = () => {
          if (gateResolved) return;
          if (completedCount >= wantCount || resultsByTaskId.size >= uniqueTaskIds.length) {
            gateResolved = true;
            resolveGate();
          }
        };
        for (const promise of taskPromises) {
          void promise.then(checkGate, checkGate);
        }
      });

      // Detach the still-pending waiters/reads for tasks we are not returning as completed.
      // Aborting only removes the in-memory waiter (and interrupts a bash poll); the child keeps
      // running and its report stays cached for a later task_await call.
      for (const [taskId, controller] of taskControllers) {
        if (!resultsByTaskId.has(taskId)) {
          controller.abort();
        }
      }

      // Aborted waits resolve to live-status snapshots (agent) or running output (bash); wait for
      // those to land so every awaited task has a result before assembling the ordered array.
      await Promise.all(taskPromises);

      const results = uniqueTaskIds.map((taskId) => resultsByTaskId.get(taskId)!);

      return parseToolResult(TaskAwaitToolResultSchema, { results }, "task_await");
    },
  });
};
