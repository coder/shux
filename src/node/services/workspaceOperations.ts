import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import type * as schemas from "@/common/orpc/schemas";
import type { ORPCContext } from "@/node/orpc/context";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { ProjectRef } from "@/common/types/workspace";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  WorkspaceGoalChildWorkspaceError,
  WorkspaceGoalTransitionError,
} from "./workspaceGoalService";

export async function createMultiProjectWorkspace(
  context: ORPCContext,
  input: {
    projects: ProjectRef[];
    branchName: string;
    trunkBranch?: string;
    title?: string;
    runtimeConfig?: RuntimeConfig;
  }
) {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Multi-project workspaces experiment is disabled",
    });
  }
  const result = await context.workspaceService.createMultiProject(
    input.projects,
    input.branchName,
    input.trunkBranch,
    input.title,
    input.runtimeConfig
  );
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

export async function getWorkspacePlanContent(context: ORPCContext, workspaceId: string) {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata)
    return { success: false as const, error: "Workspace not found: " + (workspaceId ?? "<none>") };
  const result = await readPlanFile(
    createRuntimeForWorkspace(metadata),
    metadata.name,
    metadata.projectName,
    workspaceId
  );
  return result.exists
    ? { success: true as const, data: { content: result.content, path: result.path } }
    : { success: false as const, error: "Plan file not found at " + result.path };
}

export async function getBackgroundBashOutput(
  context: ORPCContext,
  input: {
    workspaceId: string;
    processId: string;
    fromOffset?: number | null;
    tailBytes?: number | null;
  }
) {
  const result = await context.workspaceService.getBackgroundProcessOutput(
    input.workspaceId,
    input.processId,
    { fromOffset: input.fromOffset ?? undefined, tailBytes: input.tailBytes ?? undefined }
  );
  return result.success
    ? { success: true as const, data: result.data }
    : { success: false as const, error: result.error };
}

async function withGoalErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof WorkspaceGoalTransitionError ||
      error instanceof WorkspaceGoalChildWorkspaceError
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: error.message,
        cause: error,
        data: { code: error.code },
      });
    }
    throw error;
  }
}

export async function getWorkspaceGoal(context: ORPCContext, workspaceId: string) {
  return {
    goal: (await context.workspaceService.getInfo(workspaceId))
      ? await context.workspaceGoalService.getGoal(workspaceId)
      : null,
  };
}
export async function setWorkspaceGoal(
  context: ORPCContext,
  input: Parameters<ORPCContext["workspaceGoalService"]["setGoal"]>[0]
) {
  if (!(await context.workspaceService.getInfo(input.workspaceId)))
    return {
      success: false as const,
      error: { type: "invalid_transition" as const, message: "Workspace not found." },
    };
  return context.workspaceGoalService.setGoal(input);
}
export async function clearWorkspaceGoal(context: ORPCContext, workspaceId: string) {
  if (!(await context.workspaceService.getInfo(workspaceId))) return { cleared: false };
  return { cleared: (await context.workspaceGoalService.clearGoal(workspaceId)) !== null };
}
export async function getWorkspaceGoalBoard(context: ORPCContext, workspaceId: string) {
  if (!(await context.workspaceService.getInfo(workspaceId))) return { entries: [] };
  return context.workspaceGoalService.getGoalBoard(workspaceId);
}
export function addUpcomingWorkspaceGoal(
  context: ORPCContext,
  input: {
    workspaceId: string;
    objective: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }
) {
  return withGoalErrorTranslation(() => context.workspaceGoalService.addUpcomingGoal(input));
}
export function archiveWorkspaceGoal(context: ORPCContext, workspaceId: string, goalId: string) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.archiveGoal(workspaceId, goalId)
  );
}
export function reviveArchivedWorkspaceGoal(
  context: ORPCContext,
  workspaceId: string,
  goalId: string
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.reviveArchivedGoal(workspaceId, goalId)
  );
}
export function reorderUpcomingWorkspaceGoals(
  context: ORPCContext,
  workspaceId: string,
  upcomingIds: string[]
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.reorderUpcomingGoals(workspaceId, upcomingIds)
  );
}
export function promoteUpcomingWorkspaceGoal(
  context: ORPCContext,
  workspaceId: string,
  goalId: string
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.promoteUpcomingGoal(workspaceId, goalId)
  );
}
export function updateUpcomingWorkspaceGoal(
  context: ORPCContext,
  input: {
    workspaceId: string;
    goalId: string;
    objective?: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }
) {
  return withGoalErrorTranslation(() => context.workspaceGoalService.updateUpcomingGoal(input));
}

type CreateWorkspaceInput = z.infer<typeof schemas.workspace.create.input>;
type ForkWorkspaceInput = z.infer<typeof schemas.workspace.fork.input>;
type ResumeStreamInput = z.infer<typeof schemas.workspace.resumeStream.input>;

export async function createWorkspace(context: ORPCContext, input: CreateWorkspaceInput) {
  const result = await context.workspaceService.create(
    input.projectPath,
    input.branchName,
    input.trunkBranch,
    input.title,
    input.runtimeConfig,
    input.subProjectPath,
    input.pendingAutoTitle,
    input.tags
  );
  return result.success
    ? { success: true as const, metadata: result.data.metadata }
    : { success: false as const, error: result.error };
}

export async function createScratchWorkspace(context: ORPCContext, title?: string) {
  const result = await context.workspaceService.createScratch(title);
  return result.success
    ? { success: true as const, metadata: result.data.metadata }
    : { success: false as const, error: result.error };
}

export async function removeWorkspace(
  context: ORPCContext,
  input: z.infer<typeof schemas.workspace.remove.input>
) {
  const result = await context.workspaceService.remove(input.workspaceId, input.options?.force, {
    acknowledgedDescendantIds: input.options?.acknowledgedDescendantIds,
  });
  return result.success
    ? { success: true as const }
    : { success: false as const, error: result.error, descendants: result.descendants };
}

export async function forkWorkspace(context: ORPCContext, input: ForkWorkspaceInput) {
  const result = await context.workspaceService.fork(
    input.sourceWorkspaceId,
    input.newName,
    input.sourceMessageId,
    input.pendingAutoTitle
  );
  return result.success
    ? {
        success: true as const,
        metadata: result.data.metadata,
        projectPath: result.data.projectPath,
      }
    : { success: false as const, error: result.error };
}

export async function sendWorkspaceMessage(
  context: ORPCContext,
  input: z.infer<typeof schemas.workspace.sendMessage.input>
) {
  const result = await context.workspaceService.sendMessage(
    input.workspaceId,
    input.message,
    input.options
  );
  return result.success
    ? {
        success: true as const,
        // Routed skill sends report the class model (and effective thinking)
        // so the frontend can attribute send telemetry to what actually
        // streams instead of the workspace's selected model. `queued` marks
        // acknowledgements taken BEFORE routing resolved (busy session), so
        // absence of routedModel there means "unknown", not "unrouted".
        data: {
          ...(result.data?.routedModel != null ? { routedModel: result.data.routedModel } : {}),
          ...(result.data?.routedThinkingLevel != null
            ? { routedThinkingLevel: result.data.routedThinkingLevel }
            : {}),
          ...(result.data?.queued === true ? { queued: true } : {}),
          // Accepted (rows durable) but refused before any provider request:
          // the renderer must not attribute send telemetry to it.
          ...(result.data?.acceptedWithoutStream === true ? { acceptedWithoutStream: true } : {}),
        },
      }
    : { success: false as const, error: result.error };
}

export async function answerWorkspaceQuestion(
  context: ORPCContext,
  input: z.infer<typeof schemas.workspace.answerAskUserQuestion.input>
) {
  const result = await context.workspaceService.answerAskUserQuestion(
    input.workspaceId,
    input.toolCallId,
    input.answers
  );
  return result.success
    ? { success: true as const, data: undefined }
    : { success: false as const, error: result.error };
}

export function answerDelegatedWorkspaceToolCall(
  context: ORPCContext,
  input: z.infer<typeof schemas.workspace.answerDelegatedToolCall.input>
) {
  const result = context.workspaceService.answerDelegatedToolCall(
    input.workspaceId,
    input.toolCallId,
    input.result
  );
  return result.success
    ? { success: true as const, data: undefined }
    : { success: false as const, error: result.error };
}

export async function resumeWorkspaceStream(context: ORPCContext, input: ResumeStreamInput) {
  const result = await context.workspaceService.resumeStream(input.workspaceId, input.options);
  if (result.success) {
    return { success: true as const, data: result.data };
  }
  return {
    success: false as const,
    error:
      typeof result.error === "string"
        ? { type: "unknown" as const, raw: result.error }
        : result.error,
  };
}

export async function setWorkspaceHeartbeat(
  context: ORPCContext,
  input: z.infer<typeof schemas.workspace.heartbeat.set.input>
) {
  const settings: Parameters<ORPCContext["workspaceService"]["setHeartbeatSettings"]>[1] = {
    enabled: input.enabled,
    intervalMs: input.intervalMs,
  };
  if (input.message != null) settings.message = input.message;
  if (input.contextMode != null) settings.contextMode = input.contextMode;
  // Presence with null clears these values; absence preserves them.
  if ("trigger" in input) settings.trigger = input.trigger ?? null;
  if ("whenBusy" in input) settings.whenBusy = input.whenBusy ?? null;
  const result = await context.workspaceService.setHeartbeatSettings(input.workspaceId, settings);
  return result.success ? { success: true as const, data: undefined } : result;
}
