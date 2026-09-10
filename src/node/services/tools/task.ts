import { randomUUID } from "node:crypto";

import { tool, type Tool } from "ai";
import type { z } from "zod";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskToolResultSchema,
  TOOL_DEFINITIONS,
  buildTaskToolAgentArgsSchema,
  buildTaskToolDescription,
} from "@/common/utils/tools/toolDefinitions";
import {
  RUNTIME_MODE,
  runtimeModeSupportsSharedTaskWorkspace,
  type RuntimeMode,
} from "@/common/types/runtime";
import type { TaskCreatedEvent } from "@/common/types/stream";
import { log } from "@/node/services/log";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";

import { buildTaskGroupLaunches } from "@/common/utils/tools/taskGroups";
import {
  emitChatEventBestEffort,
  parseToolResult,
  requireTaskService,
  requireWorkspaceTurnManager,
  requireWorkspaceId,
} from "./toolUtils";
import { getErrorMessage } from "@/common/utils/errors";
import {
  coerceThinkingLevel,
  parseThinkingInput,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { coerceNonEmptyString } from "@/node/services/taskUtils";

// Plan agent is read-only: only `explore` sub-agent tasks may be spawned. Shared by both the
// workspace-turn guard and the per-launch agent-id guard so the message can't drift between them.
const PLAN_AGENT_EXPLORE_ONLY_ERROR =
  'In the plan agent you may only spawn agentId: "explore" tasks.';

const BUILT_IN_TASK_TOOL_MARKER = Symbol("muxBuiltInTaskTool");

export function markBuiltInTaskTool<TParameters, TResult>(
  taskTool: Tool<TParameters, TResult>
): Tool<TParameters, TResult> {
  Object.defineProperty(taskTool, BUILT_IN_TASK_TOOL_MARKER, {
    value: true,
    // enumerable so object spread (wrapWithInitWait) and descriptor clones (withHooks,
    // cloneToolPreservingDescriptors, cache control) carry the marker forward to every wrapper —
    // that is what lets sibling explore task calls share the parallel reader lock downstream.
    enumerable: true,
    configurable: true,
  });
  return taskTool;
}

export function isBuiltInTaskTool(tool: Tool | undefined): boolean {
  return Boolean(
    (tool as (Tool & Record<symbol, unknown>) | undefined)?.[BUILT_IN_TASK_TOOL_MARKER] === true
  );
}

/** Resolve the parent workspace's runtime mode from the injected MUX_RUNTIME env. */
function resolveRuntimeMode(config: ToolConfiguration): RuntimeMode | undefined {
  const runtimeValue = config.xumEnv?.MUX_RUNTIME;
  return runtimeValue != null && Object.values(RUNTIME_MODE).includes(runtimeValue as RuntimeMode)
    ? (runtimeValue as RuntimeMode)
    : undefined;
}

/**
 * Build dynamic task tool description with runtime-specific workspace visibility
 * guidance and the currently available sub-agents.
 */
function buildTaskDescription(config: ToolConfiguration): string {
  const runtimeMode = resolveRuntimeMode(config);
  const baseDescription = buildTaskToolDescription(runtimeMode);
  const subagents = config.availableSubagents?.filter((a) => a.subagentRunnable) ?? [];

  if (subagents.length === 0) {
    return baseDescription;
  }

  const subagentLines = subagents.map((agent) => {
    const desc = agent.description ? `: ${agent.description}` : "";
    return `- ${agent.id}${desc}`;
  });

  return `${baseDescription}\n\nAvailable sub-agents (use \`agentId\` parameter):\n${subagentLines.join("\n")}`;
}

function buildParentRuntimeAiSettings(
  config: ToolConfiguration
): { modelString?: string; thinkingLevel?: ThinkingLevel } | undefined {
  const modelString = coerceNonEmptyString(config.xumEnv?.MUX_MODEL_STRING);
  const thinkingLevel = coerceThinkingLevel(config.xumEnv?.MUX_THINKING_LEVEL);

  if (modelString == null && thinkingLevel == null) {
    return undefined;
  }

  return {
    ...(modelString != null ? { modelString } : {}),
    ...(thinkingLevel != null ? { thinkingLevel } : {}),
  };
}

/**
 * Parse the optional `model`/`thinking` overrides supplied on a task launch,
 * reusing the exact parsing the UI uses (`normalizeModelInput` for model alias
 * resolution; `parseThinkingInput` for named levels OR numeric indices). Numeric
 * thinking indices stay deferred as a `ParsedThinkingInput` so they resolve
 * against the sub-agent's chosen model in `resolveTaskAISettings`. Throws a
 * descriptive error on invalid input so the model can correct the call.
 */
function parseTaskAiOverrides(args: { model?: string | null; thinking?: string | null }): {
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
} {
  const overrides: { modelString?: string; thinkingLevel?: ParsedThinkingInput } = {};

  if (args.model != null) {
    const normalized = normalizeModelInput(args.model);
    if (normalized.model == null) {
      throw new Error(
        `task tool: invalid model "${args.model}". Provide a known alias or a "provider:model" string.`
      );
    }
    overrides.modelString = normalized.model;
  }

  if (args.thinking != null) {
    const parsed = parseThinkingInput(args.thinking);
    if (parsed == null) {
      throw new Error(
        `task tool: invalid thinking "${args.thinking}". Use a level name (off, low, medium, high, xhigh, max) or a numeric index.`
      );
    }
    overrides.thinkingLevel = parsed;
  }

  return overrides;
}

interface SpawnedTaskInfo {
  taskId: string;
  status: "queued" | "starting" | "running";
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  desktopOwnerWorkspaceId?: string;
}

interface PendingTaskInfo {
  taskId: string;
  status: "queued" | "starting" | "running" | "completed" | "interrupted";
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  desktopOwnerWorkspaceId?: string;
}

interface CompletedTaskInfo {
  taskId: string;
  reportMarkdown: string;
  structuredOutput?: unknown;
  title?: string;
  agentId: string;
  agentType: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  desktopOwnerWorkspaceId?: string;
}

type ForegroundWaitOutcome =
  | { kind: "completed"; report: CompletedTaskInfo }
  | { kind: "backgrounded" }
  | { kind: "timed_out" }
  | { kind: "interrupted" }
  | { kind: "task_interrupted" }
  | { kind: "error"; error: unknown };

function buildTaskGroupId(workspaceId: string, toolCallId: string | undefined): string {
  return `task-group:${workspaceId}:${toolCallId ?? randomUUID()}`;
}

function emitTaskCreatedEvent(params: {
  config: ToolConfiguration;
  workspaceId: string;
  toolCallId: string | undefined;
  taskId: string;
}): void {
  if (!params.config.emitChatEvent || !params.config.workspaceId || !params.toolCallId) {
    return;
  }

  emitChatEventBestEffort(
    params.config,
    {
      type: "task-created",
      workspaceId: params.workspaceId,
      toolCallId: params.toolCallId,
      taskId: params.taskId,
      timestamp: Date.now(),
    } satisfies TaskCreatedEvent,
    "task"
  );
}

function toAggregatePendingStatus(
  statuses: ReadonlyArray<PendingTaskInfo["status"]>
): "queued" | "starting" | "running" {
  if (statuses.every((status) => status === "queued")) return "queued";
  if (statuses.every((status) => status === "starting")) return "starting";
  return "running";
}

function serializeCompletedReport(report: CompletedTaskInfo) {
  return {
    taskId: report.taskId,
    reportMarkdown: report.reportMarkdown,
    structuredOutput: report.structuredOutput,
    title: report.title,
    agentId: report.agentId,
    agentType: report.agentType,
    modelString: report.modelString,
    thinkingLevel: report.thinkingLevel,
    desktopOwnerWorkspaceId: report.desktopOwnerWorkspaceId,
  };
}

function serializeCompletedReports(reports: readonly CompletedTaskInfo[]) {
  return reports.map(serializeCompletedReport);
}

function buildBackgroundStartNote(taskCount: number): string {
  return taskCount === 1
    ? "Task started in background. Use task_await to monitor progress."
    : "Tasks started in background. Use task_await to monitor progress.";
}

function buildForegroundContinuationNote(
  taskCount: number,
  reason: "backgrounded" | "timed_out"
): string {
  if (reason === "backgrounded") {
    return taskCount === 1
      ? "Task sent to background because a new message was queued. Use task_await to monitor progress."
      : "Tasks were sent to background because a new message was queued. Use task_await to monitor progress.";
  }

  return taskCount === 1
    ? "Task exceeded foreground wait limit and continues running in background. Use task_await to monitor progress."
    : "Tasks exceeded the foreground wait limit and continue running in background. Use task_await to monitor progress.";
}

function buildInterruptedTaskNote(taskCount: number): string {
  return taskCount === 1
    ? "Task was interrupted before reporting. Use task_await to inspect the final task state."
    : "Some tasks were interrupted before reporting. Use task_await to inspect the final task states.";
}

function buildPendingTaskResult(params: {
  tasks: readonly PendingTaskInfo[];
  note: string;
  reports?: readonly CompletedTaskInfo[];
  forceGrouped?: boolean;
}): z.infer<typeof TaskToolResultSchema> {
  const status = toAggregatePendingStatus(params.tasks.map((task) => task.status));
  const serializedReports =
    params.reports && params.reports.length > 0
      ? serializeCompletedReports(params.reports)
      : undefined;

  if (params.tasks.length === 1 && !params.forceGrouped) {
    const task = params.tasks[0];
    return {
      status,
      taskId: task.taskId,
      modelString: task.modelString,
      thinkingLevel: task.thinkingLevel,
      desktopOwnerWorkspaceId: task.desktopOwnerWorkspaceId,
      note: params.note,
    };
  }

  return {
    status,
    taskIds: params.tasks.map((task) => task.taskId),
    tasks: params.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      modelString: task.modelString,
      thinkingLevel: task.thinkingLevel,
      desktopOwnerWorkspaceId: task.desktopOwnerWorkspaceId,
    })),
    note: params.note,
    ...(serializedReports ? { reports: serializedReports } : {}),
  };
}

function buildCompletedTaskResult(params: {
  reports: readonly CompletedTaskInfo[];
}): z.infer<typeof TaskToolResultSchema> {
  const serializedReports = serializeCompletedReports(params.reports);
  if (serializedReports.length === 1) {
    const report = serializedReports[0];
    return {
      status: "completed",
      taskId: report.taskId,
      reportMarkdown: report.reportMarkdown,
      structuredOutput: report.structuredOutput,
      title: report.title,
      agentId: report.agentId,
      agentType: report.agentType,
      modelString: report.modelString,
      thinkingLevel: report.thinkingLevel,
      desktopOwnerWorkspaceId: report.desktopOwnerWorkspaceId,
    };
  }

  return {
    status: "completed",
    taskIds: serializedReports.map((report) => report.taskId),
    reports: serializedReports,
  };
}

function normalizePendingTaskStatuses(params: {
  taskService: ReturnType<typeof requireTaskService>;
  createdTasks: readonly SpawnedTaskInfo[];
  completedReports?: readonly CompletedTaskInfo[];
}): PendingTaskInfo[] {
  const completedReportsByTaskId = new Map(
    (params.completedReports ?? []).map((report) => [report.taskId, report])
  );
  return params.createdTasks.map((createdTask) => {
    const completedReport = completedReportsByTaskId.get(createdTask.taskId);
    if (completedReport) {
      return {
        taskId: createdTask.taskId,
        status: "completed",
        modelString: completedReport.modelString ?? createdTask.modelString,
        thinkingLevel: completedReport.thinkingLevel ?? createdTask.thinkingLevel,
        desktopOwnerWorkspaceId: createdTask.desktopOwnerWorkspaceId,
      };
    }

    const currentStatus =
      params.taskService.getAgentTaskStatus(createdTask.taskId) ?? createdTask.status;
    return {
      taskId: createdTask.taskId,
      status:
        currentStatus === "queued"
          ? "queued"
          : currentStatus === "starting"
            ? "starting"
            : currentStatus === "interrupted"
              ? "interrupted"
              : "running",
      modelString: createdTask.modelString,
      thinkingLevel: createdTask.thinkingLevel,
      desktopOwnerWorkspaceId: createdTask.desktopOwnerWorkspaceId,
    };
  });
}

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  // Only advertise the `isolation` parameter on runtimes where sharing the parent checkout is
  // supported. On local runtimes the field is omitted from the schema entirely, so it never
  // enters LLM context.
  const runtimeMode = resolveRuntimeMode(config);
  const inputSchema = buildTaskToolAgentArgsSchema({
    includeIsolation: runtimeModeSupportsSharedTaskWorkspace(runtimeMode),
  });
  const taskTool = tool({
    description: buildTaskDescription(config),
    inputSchema,
    execute: async (args, { abortSignal, toolCallId }): Promise<unknown> => {
      // Defensive: tool() should have already validated args via inputSchema,
      // but keep runtime validation here to preserve type-safety.
      const parsedArgs = TOOL_DEFINITIONS.task.schema.safeParse(args);
      if (!parsedArgs.success) {
        const keys =
          args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
        log.warn(
          "[task tool] Unexpected input validation failure (should have been caught by AI SDK)",
          {
            issues: parsedArgs.error.issues,
            keys,
          }
        );
        throw new Error(`task tool input validation failed: ${parsedArgs.error.message}`);
      }
      const validatedArgs = parsedArgs.data;
      if (abortSignal?.aborted) {
        throw new Error("Interrupted");
      }

      const {
        kind,
        agentId,
        subagent_type,
        prompt,
        title,
        run_in_background,
        n,
        model,
        thinking,
        isolation,
        desktop,
        workspace,
      } = validatedArgs;

      // Explicit per-launch model/thinking overrides. Omitted by default so delegated work
      // inherits the parent's live settings unless the caller requests an override.
      const aiOverrides = parseTaskAiOverrides({ model, thinking });

      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");
      const workspaceTurnManager = requireWorkspaceTurnManager(config, "task");

      const parentRuntimeAiSettings = buildParentRuntimeAiSettings(config);

      if (config.planFileOnly && kind === "workspace") {
        throw new Error(PLAN_AGENT_EXPLORE_ONLY_ERROR);
      }

      if (kind === "workspace") {
        const created = await workspaceTurnManager.createWorkspaceTurn({
          ownerWorkspaceId: workspaceId,
          prompt,
          title,
          // Agent mode for the launched turn (e.g. "plan"); createWorkspaceTurn defaults to exec.
          ...(agentId != null ? { agentId } : {}),
          experiments: config.experiments,
          ...(aiOverrides.modelString != null ? { modelString: aiOverrides.modelString } : {}),
          ...(aiOverrides.thinkingLevel != null
            ? { thinkingLevel: aiOverrides.thinkingLevel }
            : {}),
          ...(parentRuntimeAiSettings != null ? { parentRuntimeAiSettings } : {}),
          // Background launches are non-blocking with terminal wake-up; foreground/default block.
          attentionPolicy: run_in_background ? "notify_on_terminal" : "blocking_until_terminal",
          workspace: {
            mode: workspace?.mode ?? "new",
            ...(workspace?.workspaceId != null ? { workspaceId: workspace.workspaceId } : {}),
            ...(workspace?.branchName != null ? { branchName: workspace.branchName } : {}),
            ...(workspace?.trunkBranch != null ? { trunkBranch: workspace.trunkBranch } : {}),
            ...(workspace?.queueDispatchMode != null
              ? { queueDispatchMode: workspace.queueDispatchMode }
              : {}),
            ...(workspace?.disposable != null ? { disposable: workspace.disposable } : {}),
          },
        });
        if (!created.success) {
          throw new Error(created.error);
        }

        // Announce the probable quiet supersession at creation time so the
        // owner is not surprised when its old handle settles interrupted
        // without a separate wake. Pending (queued/running) results carry the
        // forward-looking note; the foreground terminal result carries a
        // past-tense equivalent because the old handle's suppressed wake means
        // this result is the owner's only notification about that handle.
        const supersedeNote =
          created.data.maySupersedeTaskId != null
            ? ` Queued behind your active turn ${created.data.maySupersedeTaskId}; at the target's next tool boundary this follow-up may supersede it — if so, ${created.data.maySupersedeTaskId} settles as interrupted quietly (no separate wake) and this new handle carries the workspace's continuation.`
            : "";
        const completedSupersedeNote =
          created.data.maySupersedeTaskId != null
            ? `This follow-up was queued behind your earlier turn ${created.data.maySupersedeTaskId}; if it cut that turn at a tool boundary, ${created.data.maySupersedeTaskId} settled as interrupted quietly (no separate wake) and this result carries the workspace's continuation.`
            : undefined;
        const pendingResult = {
          status: created.data.status,
          taskId: created.data.taskId,
          workspaceId: created.data.workspaceId,
          handleKind: "workspace_turn" as const,
          note: buildBackgroundStartNote(1) + supersedeNote,
        };
        if (run_in_background) {
          return parseToolResult(TaskToolResultSchema, pendingResult, "task");
        }

        try {
          const report = await workspaceTurnManager.waitForWorkspaceTurn(created.data.taskId, {
            abortSignal,
            requestingWorkspaceId: workspaceId,
            backgroundOnMessageQueued: true,
          });
          return parseToolResult(
            TaskToolResultSchema,
            {
              status: "completed" as const,
              taskId: created.data.taskId,
              workspaceId: report.workspaceId ?? created.data.workspaceId,
              handleKind: "workspace_turn" as const,
              reportMarkdown: report.reportMarkdown,
              title: report.title,
              messageId: report.messageId,
              finalMessageRef: report.finalMessageRef,
              ...(completedSupersedeNote != null ? { note: completedSupersedeNote } : {}),
            },
            "task"
          );
        } catch (error: unknown) {
          if (abortSignal?.aborted) {
            throw new Error("Interrupted");
          }
          if (error instanceof ForegroundWaitBackgroundedError) {
            return parseToolResult(
              TaskToolResultSchema,
              {
                ...pendingResult,
                note: buildForegroundContinuationNote(1, "backgrounded") + supersedeNote,
              },
              "task"
            );
          }
          const errorMessage = getErrorMessage(error);
          if (errorMessage === "Timed out waiting for workspace turn") {
            // The foreground wait exceeded its budget but the workspace turn keeps running. Make it
            // non-blocking so the owner's stream-end does not re-force a task_await; Xum wakes the
            // owner with the terminal output instead.
            await taskService.markBackgroundWorkNotifyOnTerminal?.(
              created.data.taskId,
              workspaceId
            );
            return parseToolResult(
              TaskToolResultSchema,
              {
                ...pendingResult,
                note: buildForegroundContinuationNote(1, "timed_out") + supersedeNote,
              },
              "task"
            );
          }
          throw error;
        }
      }

      const requestedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0 ? agentId : subagent_type;
      if (!requestedAgentId) {
        throw new Error("task tool input validation failed: expected agent task args");
      }

      const taskGroupLaunches = buildTaskGroupLaunches({ prompt, n });
      const taskGroupCount = taskGroupLaunches.length;
      const taskGroupId =
        taskGroupCount > 1 ? buildTaskGroupId(workspaceId, toolCallId) : undefined;

      // Nested task spawning is allowed and enforced via maxTaskNestingDepth in TaskService
      // (and by tool policy at/over the depth limit).

      // Plan agent is explicitly non-executing. Allow only read-only exploration tasks.
      if (config.planFileOnly && requestedAgentId !== "explore") {
        throw new Error(PLAN_AGENT_EXPLORE_ONLY_ERROR);
      }

      // Parent runtime model and thinking are forwarded as a low-priority fallback so
      // unconfigured delegated runs still inherit the parent's live model. Do not
      // restore the previous top-priority forwarding through explicit task args.
      const createdTasks: SpawnedTaskInfo[] = [];
      for (const launch of taskGroupLaunches) {
        if (abortSignal?.aborted) {
          throw new Error("Interrupted");
        }

        const created = await taskService.create({
          parentWorkspaceId: workspaceId,
          kind: "agent",
          agentId: requestedAgentId,
          // Legacy alias (persisted for older clients / on-disk compatibility).
          agentType: requestedAgentId,
          prompt: launch.prompt,
          title,
          experiments: config.experiments,
          ...(aiOverrides.modelString != null ? { modelString: aiOverrides.modelString } : {}),
          ...(aiOverrides.thinkingLevel != null
            ? { thinkingLevel: aiOverrides.thinkingLevel }
            : {}),
          ...(isolation != null ? { isolation } : {}),
          ...(desktop != null ? { desktop } : {}),
          ...(parentRuntimeAiSettings != null ? { parentRuntimeAiSettings } : {}),
          // Background launches are non-blocking with terminal wake-up; foreground/default block.
          attentionPolicy: run_in_background ? "notify_on_terminal" : "blocking_until_terminal",
          bestOf:
            taskGroupId != null
              ? {
                  groupId: taskGroupId,
                  index: launch.index,
                  total: launch.total,
                }
              : undefined,
        });

        if (!created.success) {
          if (createdTasks.length > 0) {
            return parseToolResult(
              TaskToolResultSchema,
              buildPendingTaskResult({
                tasks: createdTasks,
                note:
                  `Grouped task creation stopped after spawning ${createdTasks.length} of ${taskGroupCount} task(s): ${created.error}. ` +
                  "Use task_await on the returned task metadata before retrying, or you may duplicate work.",
                forceGrouped: taskGroupCount > 1,
              }),
              "task"
            );
          }

          throw new Error(created.error);
        }

        const task = {
          taskId: created.data.taskId,
          status: created.data.status,
          modelString: created.data.modelString,
          thinkingLevel: created.data.thinkingLevel,
          desktopOwnerWorkspaceId: created.data.desktopOwnerWorkspaceId,
        } satisfies SpawnedTaskInfo;
        createdTasks.push(task);

        // UI-only signal: expose spawned taskIds as soon as the workspaces exist.
        emitTaskCreatedEvent({
          config,
          workspaceId,
          toolCallId,
          taskId: task.taskId,
        });
      }

      if (run_in_background) {
        return parseToolResult(
          TaskToolResultSchema,
          buildPendingTaskResult({
            tasks: createdTasks,
            note: buildBackgroundStartNote(createdTasks.length),
            forceGrouped: taskGroupCount > 1,
          }),
          "task"
        );
      }

      const waitOutcomes = await Promise.all(
        createdTasks.map(async (createdTask): Promise<ForegroundWaitOutcome> => {
          try {
            const report = await taskService.waitForAgentReport(createdTask.taskId, {
              abortSignal,
              requestingWorkspaceId: workspaceId,
              backgroundOnMessageQueued: true,
            });

            return {
              kind: "completed",
              report: {
                taskId: createdTask.taskId,
                reportMarkdown: report.reportMarkdown,
                structuredOutput: report.structuredOutput,
                title: report.title,
                agentId: requestedAgentId,
                agentType: requestedAgentId,
                // Prefer the settings the report was produced with: a plan child that
                // auto-handoffs to exec rewrites its task settings after launch.
                modelString: report.model ?? createdTask.modelString,
                thinkingLevel: report.thinkingLevel ?? createdTask.thinkingLevel,
                desktopOwnerWorkspaceId: createdTask.desktopOwnerWorkspaceId,
              } satisfies CompletedTaskInfo,
            };
          } catch (error: unknown) {
            if (abortSignal?.aborted) {
              return { kind: "interrupted" };
            }
            if (error instanceof ForegroundWaitBackgroundedError) {
              return { kind: "backgrounded" };
            }
            const errorMessage = getErrorMessage(error);
            if (errorMessage === "Timed out waiting for agent_report") {
              return { kind: "timed_out" };
            }
            if (errorMessage === "Task interrupted") {
              return { kind: "task_interrupted" };
            }
            return { kind: "error", error };
          }
        })
      );

      if (waitOutcomes.some((outcome) => outcome.kind === "interrupted")) {
        throw new Error("Interrupted");
      }

      const unexpectedFailure = waitOutcomes.find(
        (outcome): outcome is Extract<ForegroundWaitOutcome, { kind: "error" }> =>
          outcome.kind === "error"
      );
      if (unexpectedFailure) {
        throw unexpectedFailure.error;
      }

      const completedReports = waitOutcomes.flatMap((outcome) =>
        outcome.kind === "completed" ? [outcome.report] : []
      );
      if (completedReports.length === createdTasks.length) {
        return parseToolResult(
          TaskToolResultSchema,
          buildCompletedTaskResult({ reports: completedReports }),
          "task"
        );
      }

      const wasBackgrounded = waitOutcomes.some((outcome) => outcome.kind === "backgrounded");
      const didTimeOut = waitOutcomes.some((outcome) => outcome.kind === "timed_out");
      const hadInterruptedTask = waitOutcomes.some(
        (outcome) => outcome.kind === "task_interrupted"
      );

      // Foreground waits that exceeded their budget but whose tasks keep running become
      // non-blocking: persist notify_on_terminal so the owner is not re-forced to await them.
      await Promise.all(
        waitOutcomes.flatMap((outcome, index) => {
          const task = createdTasks[index];
          return outcome.kind === "timed_out" && task != null
            ? [taskService.markBackgroundWorkNotifyOnTerminal?.(task.taskId, workspaceId)]
            : [];
        })
      );
      if (wasBackgrounded || didTimeOut || hadInterruptedTask) {
        return parseToolResult(
          TaskToolResultSchema,
          buildPendingTaskResult({
            tasks: normalizePendingTaskStatuses({
              taskService,
              createdTasks,
              completedReports,
            }),
            reports: completedReports,
            note: hadInterruptedTask
              ? buildInterruptedTaskNote(createdTasks.length)
              : buildForegroundContinuationNote(
                  createdTasks.length,
                  wasBackgrounded ? "backgrounded" : "timed_out"
                ),
            forceGrouped: taskGroupCount > 1,
          }),
          "task"
        );
      }

      throw new Error("Task foreground wait ended without a terminal result");
    },
  });
  return markBuiltInTaskTool(taskTool);
};
