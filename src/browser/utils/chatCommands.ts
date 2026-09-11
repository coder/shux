/**
 * Chat command execution utilities
 * Handles executing workspace operations from slash commands
 *
 * These utilities are shared between ChatInput command handlers and UI components
 * to ensure consistent behavior and avoid duplication.
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type {
  FilePart,
  ProviderModelEntry,
  ProvidersConfigMap,
  SendMessageOptions,
} from "@/common/orpc/types";
import {
  type MuxMessageMetadata,
  type CompactionRequestData,
  type CompactionFollowUpRequest,
  type CompactionFollowUpInput,
  pickPreservedSendOptions,
} from "@/common/types/message";
import type { GoalRecordV1, GoalSetError, GoalStatus } from "@/common/types/goal";
import type { ReviewNoteData } from "@/common/types/review";
import {
  isTerminalWorkflowRunStatus,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, parseRuntimeModeAndHost } from "@/common/types/runtime";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import type { Toast } from "@/browser/features/ChatInput/ChatInputToast";
import {
  formatCompactionCommandLine,
  getFollowUpContentText,
} from "@/browser/utils/compaction/format";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { type GoalDefaults } from "@/constants/goals";
import {
  hasBudgetedResumableGoal,
  hasGoalBudgetLimit,
  modelHasPricingData,
  UNPRICED_CURRENT_MODEL_GOAL_MESSAGE,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import { getContextResetSuccessMessage } from "@/browser/utils/contextResetFeedback";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";
import {
  WORKSPACE_ONLY_COMMAND_KEYS,
  WORKSPACE_ONLY_COMMAND_TYPES,
  type WorkspaceOnlyCommandType,
} from "@/constants/slashCommands";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import type { ChatAttachment } from "../features/ChatInput/ChatAttachments";
import { dispatchWorkspaceSwitch } from "./workspaceEvents";
import { getRuntimeKey, copyWorkspaceStorage } from "@/common/constants/storage";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { isValidProvider } from "@/common/constants/providers";
import { openInEditor } from "@/browser/utils/openInEditor";
import {
  appendStagedAttachmentNotice,
  getStagedAttachments,
} from "@/browser/features/ChatInput/stagedAttachments";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// ============================================================================
// Workspace Creation
// ============================================================================

import {
  createCommandToast,
  createInvalidCompactModelToast,
} from "@/browser/features/ChatInput/ChatInputToasts";
import { trackCommandUsed } from "@/common/telemetry";
import {
  addEphemeralMessage,
  getDisplayedRefineProposalHash,
} from "@/browser/stores/WorkspaceStore";
import { setGoalWithConflictRetry } from "@/browser/utils/goals/setGoalWithConflictRetry";
import { loadGoalDefaults, resolveGoalSetIntent } from "@/browser/utils/goals/resolveGoalSetIntent";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";

const BUILT_IN_MODEL_SET = new Set<string>(Object.values(KNOWN_MODELS).map((model) => model.id));

export interface ForkOptions {
  client: RouterClient<AppRouter>;
  sourceWorkspaceId: string;
  newName?: string;
  sourceMessageId?: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
}

export interface ForkResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Fork a workspace and switch to it
 * Handles copying storage, dispatching switch event, and optionally sending start message
 *
 * Caller is responsible for error handling, logging, and showing toasts
 */
export async function forkWorkspace(options: ForkOptions): Promise<ForkResult> {
  const { client } = options;
  const result = await client.workspace.fork({
    sourceWorkspaceId: options.sourceWorkspaceId,
    newName: options.newName,
    sourceMessageId: options.sourceMessageId,
    pendingAutoTitle: Boolean(options.startMessage && options.sendMessageOptions),
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to fork workspace" };
  }

  copyWorkspaceStorage(options.sourceWorkspaceId, result.metadata.id);

  // Get workspace info for switching
  const workspaceInfo = await client.workspace.getInfo({ workspaceId: result.metadata.id });
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after fork" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  // Using requestAnimationFrame ensures we wait for:
  // 1. React to process the workspace switch and update state
  // 2. Effects to run (workspaceStore.syncWorkspaces in App.tsx)
  // 3. WorkspaceStore to subscribe to the new workspace's IPC channel
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
        });
    });
  }

  return { success: true, workspaceInfo };
}

export type CommandInputDisposition = "consume" | "restore" | "restore-if-empty";

export type CommandAction =
  | { type: "clear-input" }
  | { type: "reset-input-height" }
  | { type: "show-toast"; toast: Toast }
  | { type: "set-preferred-model"; model: string }
  | { type: "toggle-vim" }
  | { type: "set-sending"; sending: boolean }
  | { type: "clear-attachments" }
  | { type: "detach-reviews" }
  | { type: "check-reviews"; reviewIds: string[] }
  | { type: "message-sent"; dispatchMode: QueueDispatchMode }
  | { type: "cancel-edit" };

export type CommandResult =
  | { kind: "phase"; actions: CommandAction[]; continue: () => Promise<CommandResult> }
  | {
      kind: "complete";
      actions: CommandAction[];
      inputDisposition: CommandInputDisposition;
      /** Detached work whose settle actions are applied independently of the command chain. */
      backgroundTask?: () => Promise<CommandAction[]>;
    };

export interface SlashCommandEnv {
  api: RouterClient<AppRouter> | null;
  workspaceId?: string;
  variant: "workspace" | "creation";
  projectPath?: string | null;
  /** Original slash command text as typed, for durable command display. */
  rawInput?: string;
  /** Current dynamic-workflows experiment assignment for executable workflow commands. */
  dynamicWorkflowsEnabled?: boolean;
  currentModel?: string | null;
  sendMessageOptions: SendMessageOptions;
  attachments?: ChatAttachment[];
  fileParts?: FilePart[];
  reviews?: ReviewNoteData[];
  editMessageId?: string;
  attachedReviewIds?: string[];
  resetContext?: () => Promise<"reset" | "noop">;
  truncateHistory?: (percentage?: number) => Promise<void>;
  isCurrent?: () => boolean;
}

interface WorkspaceCommandEnv extends SlashCommandEnv {
  api: RouterClient<AppRouter>;
  workspaceId: string;
}

function complete(
  inputDisposition: CommandInputDisposition,
  actions: CommandAction[] = [],
  backgroundTask?: () => Promise<CommandAction[]>
): CommandResult {
  return {
    kind: "complete",
    actions,
    inputDisposition,
    ...(backgroundTask ? { backgroundTask } : {}),
  };
}

function phase(
  actions: CommandAction[],
  continuation: () => Promise<CommandResult>
): CommandResult {
  return { kind: "phase", actions, continue: continuation };
}

function showToast(toast: Toast): CommandAction {
  return { type: "show-toast", toast };
}

export const WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE =
  "Freeform workflow arguments are unsupported. Use JSON args or ask the agent to run the workflow.";
const WORKFLOW_COMMAND_SUPERSEDED_MESSAGE = "Workflow command was superseded.";
const WORKFLOW_POLL_INTERVAL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForWorkflowTerminalRun(input: {
  client: RouterClient<AppRouter>;
  workspaceId: string;
  runId: string;
  initialStatus: WorkflowRunStatus;
  isCurrent?: () => boolean;
}): Promise<WorkflowRunRecord | null> {
  let run = await input.client.workflows.getRun({
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
  let status = run?.status ?? input.initialStatus;

  while (!isTerminalWorkflowRunStatus(status)) {
    if (input.isCurrent?.() === false) {
      throw new Error(WORKFLOW_COMMAND_SUPERSEDED_MESSAGE);
    }
    await delay(WORKFLOW_POLL_INTERVAL_MS);
    run = await input.client.workflows.getRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
    status = run?.status ?? status;
  }

  if (input.isCurrent?.() === false) {
    throw new Error(WORKFLOW_COMMAND_SUPERSEDED_MESSAGE);
  }

  return run;
}

function parseWorkflowSlashArgs(argsText: string | undefined): unknown {
  const trimmed = argsText?.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE);
  }
}

// ============================================================================
// Command Dispatcher
// ============================================================================

/** Compiles only when T is a subset of U; used to pin constants to the parser's union. */
type SubsetOf<T extends U, U> = T;

// A typo or stale entry in WORKSPACE_ONLY_COMMAND_TYPE_LIST fails this subset
// constraint at compile time instead of being silently dropped by Extract
// (which would leave the dispatch switch exhaustive while the real command
// falls through unhandled).
type CheckedWorkspaceOnlyCommandType = SubsetOf<
  WorkspaceOnlyCommandType,
  NonNullable<ParsedCommand>["type"]
>;

type WorkspaceOnlyParsedCommand = Extract<
  NonNullable<ParsedCommand>,
  { type: CheckedWorkspaceOnlyCommandType }
>;

/**
 * Narrow a parsed command to the workspace-only subset so the dispatch switch
 * below stays compiler-checked exhaustive: adding a type to
 * WORKSPACE_ONLY_COMMAND_TYPE_LIST without a handler fails lint instead of
 * silently falling through to the generic toast path.
 */
function isWorkspaceOnlyParsedCommand(
  parsed: NonNullable<ParsedCommand>
): parsed is WorkspaceOnlyParsedCommand {
  return WORKSPACE_ONLY_COMMAND_TYPES.has(parsed.type);
}

/** Dispatch a parsed slash command into caller-applied result phases. */
export async function processSlashCommand(
  parsed: ParsedCommand,
  env: SlashCommandEnv
): Promise<CommandResult> {
  if (!parsed) return complete("restore");
  const client = env.api;
  const notConnected = () =>
    complete("restore", [
      showToast({ id: Date.now().toString(), type: "error", message: "Not connected to server" }),
    ]);

  if (parsed.type === "model-set") {
    const normalized = normalizeModelInput(parsed.modelString);
    if (!normalized.model) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: 'Invalid model format: expected "provider:model"',
        }),
      ]);
    }
    const selectedModel = normalized.model;
    const separatorIndex = selectedModel.indexOf(":");
    const provider = selectedModel.slice(0, separatorIndex);
    const modelId = selectedModel.slice(separatorIndex + 1);
    const canonicalModel = normalizeToCanonical(selectedModel);
    const explicitGateway = getExplicitGatewayPrefix(selectedModel);
    try {
      let providersConfig: ProvidersConfigMap | null = null;
      let providersConfigLoadFailed = false;
      if (client) {
        try {
          providersConfig = await client.providers.getConfig();
        } catch (error) {
          providersConfigLoadFailed = true;
          console.error("Failed to load provider settings:", error);
        }
      }
      const providerConfig = providersConfig?.[provider];
      if (!isValidProvider(provider) && !isCustomProviderConfig(providerConfig)) {
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: providersConfigLoadFailed
              ? 'Could not verify provider "' + provider + '": backend unreachable. Please retry.'
              : 'Unknown provider "' + provider + '"',
          }),
        ]);
      }
      if (
        !modelHasPricingData(selectedModel, providersConfig ?? null) &&
        (await hasBudgetedResumableGoalForWorkspaceModelSwitch(env))
      ) {
        return complete("restore", [showToast(createUnpricedModelGoalToast("target"))]);
      }
      if (
        client &&
        providersConfig &&
        !BUILT_IN_MODEL_SET.has(canonicalModel) &&
        !explicitGateway
      ) {
        try {
          const existingModels: ProviderModelEntry[] = providerConfig?.models ?? [];
          if (!existingModels.some((entry) => getProviderModelEntryId(entry) === modelId)) {
            await client.providers.setModels({ provider, models: [...existingModels, modelId] });
          }
        } catch (error) {
          console.error("Failed to sync model settings:", error);
        }
      }
      trackCommandUsed("model");
      return complete("consume", [
        { type: "clear-input" },
        { type: "set-preferred-model", model: selectedModel },
        showToast({
          id: Date.now().toString(),
          type: "success",
          message: "Model changed to " + selectedModel,
        }),
      ]);
    } catch (error) {
      console.error("Failed to update model:", error);
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Failed to update model",
        }),
      ]);
    }
  }

  if (parsed.type === "model-oneshot") {
    return complete("restore", [
      showToast({
        id: Date.now().toString(),
        type: "error",
        message: "Model one-shot is handled in the chat input.",
      }),
    ]);
  }

  if (parsed.type === "workflow-run") {
    const workflowsEnabled =
      env.dynamicWorkflowsEnabled ?? isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS) === true;
    if (!workflowsEnabled) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: "Dynamic workflows are disabled",
        }),
      ]);
    }
    if (!client) return notConnected();
    if (!env.workspaceId) {
      return complete("restore", [
        showToast({ id: Date.now().toString(), type: "error", message: "No workspace selected" }),
      ]);
    }
    let args: unknown;
    try {
      args = parseWorkflowSlashArgs(parsed.argsText);
    } catch (error) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Invalid workflow arguments",
        }),
      ]);
    }
    const workspaceId = env.workspaceId;
    const scriptPath = parsed.scriptPath;
    const rawInput = env.rawInput?.trim();
    const rawCommand = rawInput && rawInput.length > 0 ? rawInput : "/" + scriptPath;
    const commandPrefix = rawCommand.split(/\s+/u)[0] ?? "/" + scriptPath;
    let sendingStateActive = false;
    const setWorkflowSending = (sending: boolean): CommandAction[] => {
      if (sendingStateActive === sending) return [];
      sendingStateActive = sending;
      return [{ type: "set-sending", sending }];
    };
    return phase([{ type: "clear-input" }, ...setWorkflowSending(true)], async () => {
      try {
        const result = await client.workflows.start({
          workspaceId,
          scriptPath,
          runInBackground: true,
          args,
          continuationOptions: env.sendMessageOptions,
          rawCommand,
        });
        const stoppedActions = setWorkflowSending(false);
        if (result.invocationMessagePersisted === true) {
          trackCommandUsed("workflow");
          return complete("consume", [
            ...stoppedActions,
            showToast({
              id: Date.now().toString(),
              type: "success",
              message: "Workflow " + scriptPath + " started",
            }),
          ]);
        }
        return phase(stoppedActions, async () => {
          try {
            const run = await waitForWorkflowTerminalRun({
              client,
              workspaceId,
              runId: result.runId,
              initialStatus: result.status,
              isCurrent: env.isCurrent,
            });
            const terminalStatus = run?.status ?? result.status;
            if (terminalStatus === "interrupted") {
              trackCommandUsed("workflow");
              return complete("consume", [
                showToast({
                  id: Date.now().toString(),
                  type: "success",
                  message: "Workflow " + scriptPath + " interrupted",
                }),
              ]);
            }
            const workflowResultMessage = buildWorkflowResultContextMessage({
              rawCommand,
              name: scriptPath,
              runId: result.runId,
              status: terminalStatus,
              result: result.result,
              run,
            });
            return phase(setWorkflowSending(true), async () => {
              try {
                const sendResult = await client.workspace.sendMessage({
                  workspaceId,
                  message: workflowResultMessage,
                  options: {
                    ...env.sendMessageOptions,
                    muxMetadata: {
                      type: WORKFLOW_RESULT_METADATA_TYPE,
                      rawCommand,
                      commandPrefix,
                      runId: result.runId,
                      requestedModel: env.sendMessageOptions.model,
                    },
                  },
                });
                if (!sendResult.success) {
                  throw new Error("Failed to send workflow result to the agent");
                }
                trackCommandUsed("workflow");
                return complete("consume", [
                  ...setWorkflowSending(false),
                  {
                    type: "message-sent",
                    dispatchMode: env.sendMessageOptions.queueDispatchMode ?? "tool-end",
                  },
                  showToast({
                    id: Date.now().toString(),
                    type: "success",
                    message: "Workflow " + scriptPath + " " + terminalStatus,
                  }),
                ]);
              } catch (error) {
                return complete("restore-if-empty", [
                  ...setWorkflowSending(false),
                  showToast({
                    id: Date.now().toString(),
                    type: "error",
                    message: error instanceof Error ? error.message : "Failed to run workflow",
                  }),
                ]);
              }
            });
          } catch (error) {
            if (error instanceof Error && error.message === WORKFLOW_COMMAND_SUPERSEDED_MESSAGE) {
              return complete("consume");
            }
            return complete("restore-if-empty", [
              showToast({
                id: Date.now().toString(),
                type: "error",
                message: error instanceof Error ? error.message : "Failed to run workflow",
              }),
            ]);
          }
        });
      } catch (error) {
        return complete("restore-if-empty", [
          ...setWorkflowSending(false),
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: error instanceof Error ? error.message : "Failed to run workflow",
          }),
        ]);
      }
    });
  }

  if (parsed.type === "debug-llm-request") {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST));
    return complete("consume", [{ type: "clear-input" }]);
  }

  if (parsed.type === "idle-compaction") {
    if (!client) return notConnected();
    if (!env.projectPath) {
      return complete("restore", [
        showToast({ id: Date.now().toString(), type: "error", message: "No project selected" }),
      ]);
    }
    const projectPath = env.projectPath;
    return phase([{ type: "clear-input" }], async () => {
      try {
        const result = await client.projects.idleCompaction.set({
          projectPath,
          hours: parsed.hours,
        });
        if (!result.success) {
          return complete("restore", [
            showToast({
              id: Date.now().toString(),
              type: "error",
              message: result.error ?? "Failed to update setting",
            }),
          ]);
        }
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: parsed.hours
              ? "Idle compaction set to " + parsed.hours + " hours"
              : "Idle compaction disabled",
          }),
        ]);
      } catch (error) {
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: error instanceof Error ? error.message : "Failed to update setting",
          }),
        ]);
      }
    });
  }

  if (parsed.type === "heartbeat-set") {
    if (!client) return notConnected();
    let heartbeatExperimentEnabled: boolean | undefined;
    try {
      heartbeatExperimentEnabled = isExperimentEnabled(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);
    } catch {
      heartbeatExperimentEnabled = false;
    }
    if (!heartbeatExperimentEnabled) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message:
            "Heartbeat configuration requires the Workspace Heartbeats experiment to be enabled",
        }),
      ]);
    }
    if (!env.workspaceId) {
      return complete("restore", [
        showToast({ id: Date.now().toString(), type: "error", message: "No workspace selected" }),
      ]);
    }
    const workspaceId = env.workspaceId;
    return phase([{ type: "clear-input" }], async () => {
      try {
        let currentHeartbeatSettings: Awaited<
          ReturnType<typeof client.workspace.heartbeat.get>
        > | null = null;
        try {
          currentHeartbeatSettings = await client.workspace.heartbeat.get({ workspaceId });
        } catch {
          currentHeartbeatSettings = null;
        }
        const intervalMs =
          parsed.minutes === null
            ? (currentHeartbeatSettings?.intervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS)
            : parsed.minutes * 60 * 1000;
        const result = await client.workspace.heartbeat.set({
          workspaceId,
          enabled: parsed.minutes !== null,
          intervalMs,
          ...(currentHeartbeatSettings?.message != null
            ? { message: currentHeartbeatSettings.message }
            : {}),
        });
        if (!result.success) {
          return complete("restore", [
            showToast({
              id: Date.now().toString(),
              type: "error",
              message: result.error ?? "Failed to update setting",
            }),
          ]);
        }
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message:
              parsed.minutes === null
                ? "Heartbeat disabled"
                : "Heartbeat set to every " + parsed.minutes + " minutes",
          }),
        ]);
      } catch (error) {
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: error instanceof Error ? error.message : "Failed to update setting",
          }),
        ]);
      }
    });
  }

  if (parsed.type === "vim-toggle") {
    trackCommandUsed("vim");
    return complete("consume", [{ type: "clear-input" }, { type: "toggle-vim" }]);
  }

  const workspaceOnlyKey = (() => {
    switch (parsed.type) {
      case "command-missing-args":
      case "command-invalid-args":
      case "command-unknown-flag":
      case "unknown-command":
        return parsed.command;
      default:
        return null;
    }
  })();
  const isWorkspaceCommandType = isWorkspaceOnlyParsedCommand(parsed);
  const isWorkspaceOnlyCommand =
    isWorkspaceCommandType ||
    (workspaceOnlyKey ? WORKSPACE_ONLY_COMMAND_KEYS.has(workspaceOnlyKey) : false);
  if (isWorkspaceOnlyCommand && env.variant !== "workspace") {
    return complete("restore", [
      showToast({
        id: Date.now().toString(),
        type: "error",
        message: "Command not available during workspace creation",
      }),
    ]);
  }

  if (isWorkspaceCommandType) {
    switch (parsed.type) {
      case "clear":
        return handleClearCommand(parsed, env);
      case "compact":
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        return handleCompactCommand(parsed, { ...env, api: client, workspaceId: env.workspaceId });
      case "dream": {
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        const workspaceId = env.workspaceId;
        return complete("consume", [{ type: "clear-input" }], async () => {
          try {
            const result = await client.memory.consolidate({ workspaceId });
            const applied = result.success
              ? result.data.ops.filter((operation) => operation.applied).length
              : 0;
            return [
              showToast(
                result.success
                  ? {
                      id: Date.now().toString(),
                      type: "success",
                      message:
                        applied === 0
                          ? "Memory consolidation: no changes needed"
                          : "Memory consolidated: " + applied + " change(s)",
                    }
                  : {
                      id: Date.now().toString(),
                      type: "error",
                      message: "Memory consolidation failed: " + result.error,
                    }
              ),
            ];
          } catch (error) {
            return [
              showToast({
                id: Date.now().toString(),
                type: "error",
                message: "Memory consolidation failed: " + String(error),
              }),
            ];
          }
        });
      }
      case "refine": {
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        const workspaceId = env.workspaceId;
        const apply = parsed.apply === true;
        const displayedProposalHash = apply ? getDisplayedRefineProposalHash(workspaceId) : null;
        if (apply && displayedProposalHash === null) {
          return complete("consume", [
            { type: "clear-input" },
            showToast({
              id: Date.now().toString(),
              type: "error",
              message:
                "Refine failed: no staged /refine proposal is visible in this chat; run /refine first",
            }),
          ]);
        }
        const experiments = env.sendMessageOptions.experiments;
        return complete("consume", [{ type: "clear-input" }], async () => {
          try {
            const result =
              apply && displayedProposalHash !== null
                ? await client.refinements.apply({
                    workspaceId,
                    approvedProposalHash: displayedProposalHash,
                    experiments,
                  })
                : await client.refinements.run({ workspaceId, experiments });
            const appliedCount = result.success
              ? result.data.applied.length + (result.data.untrackedApplied ?? 0)
              : 0;
            const failedCount = result.success ? (result.data.failed?.length ?? 0) : 0;
            const allFailed =
              result.success && apply && !result.data.noOp && appliedCount === 0 && failedCount > 0;
            return [
              showToast(
                result.success
                  ? {
                      id: Date.now().toString(),
                      type: allFailed ? "error" : "success",
                      message: result.data.noOp
                        ? apply
                          ? "Refine: nothing was applied"
                          : "Refine: nothing worth distilling"
                        : apply
                          ? "Refine: " +
                            appliedCount +
                            " edit(s) applied" +
                            (failedCount > 0 ? ", " + failedCount + " failed" : "") +
                            " (see chat summary)"
                          : "Refine: " +
                            (result.data.staged?.length ?? 0) +
                            " edit(s) staged — approve with /refine apply",
                    }
                  : {
                      id: Date.now().toString(),
                      type: "error",
                      message: "Refine failed: " + result.error,
                    }
              ),
            ];
          } catch (error) {
            return [
              showToast({
                id: Date.now().toString(),
                type: "error",
                message: "Refine failed: " + String(error),
              }),
            ];
          }
        });
      }
      case "fork":
        if (!client) return notConnected();
        return handleForkCommand(parsed, { ...env, api: client });
      case "new":
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        return handleNewCommand(parsed, { ...env, api: client, workspaceId: env.workspaceId });
      case "plan-show":
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        return handlePlanShowCommand({ ...env, api: client, workspaceId: env.workspaceId });
      case "plan-open":
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        return handlePlanOpenCommand({ ...env, api: client, workspaceId: env.workspaceId });
      case "goal-show":
      case "goal-set":
      case "goal-budget":
      case "goal-pause":
      case "goal-resume":
      case "goal-complete":
      case "goal-clear":
        if (!env.workspaceId) throw new Error("Workspace ID required");
        if (!client) return notConnected();
        return handleGoalCommand(parsed, { ...env, api: client, workspaceId: env.workspaceId });
    }
  }

  const commandToast = createCommandToast(parsed);
  if (commandToast) return complete("restore", [showToast(commandToast)]);
  return complete("restore");
}

// ============================================================================
// Command Handlers
// ============================================================================

// Slash-command intents only ever produce user-facing transitions; the
// internal `budget_limited` status is now excluded from the public oRPC
// `setGoal` input shape (Coder-agents-review nit DEREM-53).
type PublicSetGoalStatus = Exclude<GoalStatus, "budget_limited">;

interface GoalSetCommandIntent {
  objective?: string | null;
  status?: PublicSetGoalStatus | null;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string | null;
}

type GoalSetCommandResult =
  | { success: true; goal: GoalRecordV1 }
  | { success: false; error: GoalSetError };

async function setGoalWithSingleConflictRetry(
  env: WorkspaceCommandEnv,
  intent: GoalSetCommandIntent
): Promise<GoalSetCommandResult> {
  const result = await setGoalWithConflictRetry(env.api, env.workspaceId, intent);
  if (result.success) return { success: true, goal: result.data };
  return { success: false, error: result.error };
}

async function getGoalDefaults(env: WorkspaceCommandEnv): Promise<GoalDefaults> {
  return loadGoalDefaults(env.api, env.workspaceId);
}

function resolveSlashGoalSetIntent(
  parsed: Extract<ParsedCommand, { type: "goal-set" }>,
  defaults: GoalDefaults
): GoalSetCommandIntent {
  return resolveGoalSetIntent(
    {
      objective: parsed.objective,
      ...(Object.hasOwn(parsed, "budgetCents") ? { budgetCents: parsed.budgetCents ?? null } : {}),
      ...(Object.hasOwn(parsed, "turnCap") ? { turnCap: parsed.turnCap ?? null } : {}),
    },
    defaults
  );
}

async function hasBudgetedResumableGoalForWorkspaceModelSwitch(
  env: SlashCommandEnv
): Promise<boolean> {
  if (env.variant !== "workspace" || !env.api || !env.workspaceId) return false;
  try {
    const result = await env.api.workspace.getGoal({ workspaceId: env.workspaceId });
    return hasBudgetedResumableGoal(result.goal);
  } catch {
    return false;
  }
}

async function currentModelHasPricingData(env: WorkspaceCommandEnv): Promise<boolean> {
  let providersConfig: unknown = null;
  try {
    providersConfig = await env.api.providers.getConfig();
  } catch {
    providersConfig = null;
  }
  return modelHasPricingData(env.sendMessageOptions.model, providersConfig);
}

function createUnpricedModelGoalToast(modelPosition: "current" | "target" = "current"): Toast {
  return {
    id: Date.now().toString(),
    type: "error",
    message:
      modelPosition === "current"
        ? UNPRICED_CURRENT_MODEL_GOAL_MESSAGE
        : UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
  };
}

function getGoalSetErrorMessage(error: GoalSetError): string {
  if (error.type === "goal_conflict") {
    return "Goal changed in another window. Please try again.";
  }
  return error.message;
}

function createGoalSetErrorToast(error: GoalSetError): Toast {
  return {
    id: Date.now().toString(),
    type: "error",
    message: getGoalSetErrorMessage(error),
  };
}

function handleGoalCommand(
  parsed: Extract<
    ParsedCommand,
    {
      type:
        | "goal-show"
        | "goal-set"
        | "goal-budget"
        | "goal-pause"
        | "goal-resume"
        | "goal-complete"
        | "goal-clear";
    }
  >,
  env: WorkspaceCommandEnv
): CommandResult {
  return phase([{ type: "clear-input" }], async () => {
    try {
      if (parsed.type === "goal-show") {
        const result = await env.api.workspace.getGoal({ workspaceId: env.workspaceId });
        if (result.goal) {
          window.dispatchEvent?.(
            createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: env.workspaceId })
          );
          return complete("consume");
        }
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: "No goal is set. Use /goal <objective> to create one.",
          }),
        ]);
      }

      if (parsed.type === "goal-pause") {
        const result = await setGoalWithSingleConflictRetry(env, { status: "paused" });
        if (!result.success) {
          return complete("restore", [showToast(createGoalSetErrorToast(result.error))]);
        }
        trackCommandUsed("goal");
        return complete("consume", [
          showToast({ id: Date.now().toString(), type: "success", message: "Goal paused" }),
        ]);
      }

      if (parsed.type === "goal-resume") {
        const currentGoal = await env.api.workspace.getGoal({ workspaceId: env.workspaceId });
        if (
          hasBudgetedResumableGoal(currentGoal.goal) &&
          !(await currentModelHasPricingData(env))
        ) {
          return complete("restore", [showToast(createUnpricedModelGoalToast())]);
        }
        const result = await setGoalWithSingleConflictRetry(env, { status: "active" });
        if (!result.success) {
          return complete("restore", [showToast(createGoalSetErrorToast(result.error))]);
        }
        trackCommandUsed("goal");
        return complete("consume", [
          showToast({ id: Date.now().toString(), type: "success", message: "Goal resumed" }),
        ]);
      }

      if (parsed.type === "goal-complete") {
        if (!parsed.summary) {
          window.dispatchEvent?.(
            createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, {
              workspaceId: env.workspaceId,
              openCompleteInput: true,
            })
          );
          return complete("consume");
        }
        const result = await setGoalWithSingleConflictRetry(env, {
          status: "complete",
          completionSummary: parsed.summary,
        });
        if (!result.success) {
          return complete("restore", [showToast(createGoalSetErrorToast(result.error))]);
        }
        window.dispatchEvent?.(
          createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: env.workspaceId })
        );
        trackCommandUsed("goal");
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: "Goal marked complete",
          }),
        ]);
      }

      if (parsed.type === "goal-clear") {
        const result = await env.api.workspace.clearGoal({ workspaceId: env.workspaceId });
        trackCommandUsed("goal");
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: result.cleared ? "Goal cleared" : "No goal was set",
          }),
        ]);
      }

      if (parsed.type === "goal-budget") {
        if (hasGoalBudgetLimit(parsed.budgetCents) && !(await currentModelHasPricingData(env))) {
          return complete("restore", [showToast(createUnpricedModelGoalToast())]);
        }
        const result = await setGoalWithSingleConflictRetry(env, {
          budgetCents: parsed.budgetCents,
        });
        if (!result.success) {
          return complete("restore", [showToast(createGoalSetErrorToast(result.error))]);
        }
        window.dispatchEvent?.(
          createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: env.workspaceId })
        );
        trackCommandUsed("goal");
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: "Goal budget updated",
          }),
        ]);
      }

      const goalDefaults = await getGoalDefaults(env);
      const goalSetIntent = resolveSlashGoalSetIntent(parsed, goalDefaults);
      if (
        hasGoalBudgetLimit(goalSetIntent.budgetCents) &&
        !(await currentModelHasPricingData(env))
      ) {
        return complete("restore", [showToast(createUnpricedModelGoalToast())]);
      }
      const result = await setGoalWithSingleConflictRetry(env, goalSetIntent);
      if (!result.success) {
        return complete("restore", [showToast(createGoalSetErrorToast(result.error))]);
      }
      window.dispatchEvent?.(
        createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: env.workspaceId })
      );
      trackCommandUsed("goal");
      return complete("consume");
    } catch (error) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Goal command failed",
        }),
      ]);
    }
  });
}

function handleClearCommand(
  parsed: Extract<ParsedCommand, { type: "clear" }>,
  env: SlashCommandEnv
): CommandResult {
  if (parsed.mode === "soft") {
    if (!env.resetContext) return complete("consume");
    return phase([], async () => {
      try {
        const result = await env.resetContext?.();
        const actions: CommandAction[] = [{ type: "clear-input" }, { type: "reset-input-height" }];
        if (result === "reset") {
          actions.push({ type: "clear-attachments" }, { type: "detach-reviews" });
        }
        trackCommandUsed("clear:soft");
        actions.push(
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: getContextResetSuccessMessage(result ?? "noop"),
          })
        );
        return complete("consume", actions);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("Failed to reset context");
        console.error("Failed to reset context:", normalized);
        return complete("restore", [
          showToast({ id: Date.now().toString(), type: "error", message: normalized.message }),
        ]);
      }
    });
  }

  const initialActions: CommandAction[] = [{ type: "clear-input" }, { type: "reset-input-height" }];
  if (!env.truncateHistory) {
    return phase(initialActions, () => Promise.resolve(complete("consume")));
  }
  return phase(initialActions, async () => {
    try {
      await env.truncateHistory?.(1.0);
      trackCommandUsed("clear:hard");
      return complete("consume", [
        { type: "clear-attachments" },
        { type: "detach-reviews" },
        showToast({
          id: Date.now().toString(),
          type: "success",
          message: "Chat history cleared",
        }),
      ]);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to clear history");
      console.error("Failed to clear history:", normalized);
      return complete("restore", [
        showToast({ id: Date.now().toString(), type: "error", message: normalized.message }),
      ]);
    }
  });
}

function handleForkCommand(
  parsed: Extract<ParsedCommand, { type: "fork" }>,
  env: SlashCommandEnv & { api: RouterClient<AppRouter> }
): CommandResult {
  return phase([{ type: "clear-input" }, { type: "set-sending", sending: true }], async () => {
    try {
      if (!env.workspaceId) throw new Error("Workspace ID required for fork");
      const result = await forkWorkspace({
        client: env.api,
        sourceWorkspaceId: env.workspaceId,
        startMessage: parsed.startMessage,
        sendMessageOptions: env.sendMessageOptions,
      });
      if (!result.success) {
        const message = result.error ?? "Failed to fork workspace";
        console.error("Failed to fork workspace:", message);
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            title: "Fork Failed",
            message,
          }),
          { type: "set-sending", sending: false },
        ]);
      }
      trackCommandUsed("fork");
      const displayName =
        result.workspaceInfo?.title ?? result.workspaceInfo?.name ?? "new workspace";
      return complete("consume", [
        showToast({
          id: Date.now().toString(),
          type: "success",
          message: 'Forked to workspace "' + displayName + '"',
        }),
        { type: "set-sending", sending: false },
      ]);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to fork workspace");
      console.error("Fork error:", normalized);
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          title: "Fork Failed",
          message: normalized.message,
        }),
        { type: "set-sending", sending: false },
      ]);
    }
  });
}

/**
 * Parse runtime string from -r flag into RuntimeConfig for backend.
 * Uses shared parseRuntimeModeAndHost for parsing, then converts to RuntimeConfig.
 *
 * Supports formats:
 * - "ssh <host>" or "ssh <user@host>" -> SSH runtime
 * - "docker <image>" -> Docker container runtime
 * - "worktree" -> Worktree runtime (git worktrees)
 * - "local" -> Local runtime (project-dir, no isolation)
 * - "devcontainer <configPath>" -> Dev container runtime
 * - undefined -> Worktree runtime (default)
 */
export function parseRuntimeString(runtime: string | undefined): RuntimeConfig | undefined {
  // Use shared parser from common/types/runtime
  const parsed = parseRuntimeModeAndHost(runtime);

  // null means invalid input (e.g., "ssh" without host, "docker" without image)
  if (parsed === null) {
    // Determine which error to throw based on input
    const trimmed = runtime?.trim().toLowerCase() ?? "";
    if (trimmed === RUNTIME_MODE.SSH || trimmed.startsWith("ssh ")) {
      throw new Error("SSH runtime requires host (e.g., 'ssh hostname' or 'ssh user@host')");
    }
    if (trimmed === RUNTIME_MODE.DOCKER || trimmed.startsWith("docker ")) {
      throw new Error("Docker runtime requires image (e.g., 'docker ubuntu:22.04')");
    }
    if (trimmed === RUNTIME_MODE.DEVCONTAINER || trimmed.startsWith("devcontainer")) {
      throw new Error(
        "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
      );
    }
    throw new Error(
      `Unknown runtime type: '${runtime ?? ""}'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'`
    );
  }

  // Convert ParsedRuntime to RuntimeConfig
  switch (parsed.mode) {
    case RUNTIME_MODE.WORKTREE:
      return undefined; // Let backend use default worktree config

    case RUNTIME_MODE.LOCAL:
      return { type: RUNTIME_MODE.LOCAL };

    case RUNTIME_MODE.SSH:
      return {
        type: RUNTIME_MODE.SSH,
        host: parsed.host,
        // Stable SSH remote layout is still ~/mux (same as buildRuntimeConfig /
        // CLI parseRuntimeConfig). Local Xum home and SSH product-home compat
        // live elsewhere; this default is a persisted remote path contract.
        srcBaseDir: "~/mux",
      };

    case RUNTIME_MODE.DEVCONTAINER: {
      const configPath = parsed.configPath.trim();
      if (!configPath) {
        throw new Error(
          "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
        );
      }
      return {
        type: RUNTIME_MODE.DEVCONTAINER,
        configPath,
      };
    }
    case RUNTIME_MODE.DOCKER:
      return {
        type: RUNTIME_MODE.DOCKER,
        image: parsed.image,
      };
  }
}

export interface CreateWorkspaceOptions {
  client: RouterClient<AppRouter>;
  projectPath: string;
  /**
   * Workspace branch name. When omitted, the backend auto-generates one
   * (e.g., "workspace-1", "workspace-2") so /new can mirror /fork's
   * seamless creation flow.
   */
  workspaceName?: string;
  trunkBranch?: string;
  runtime?: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
  /**
   * When true, ask the backend to mark the workspace with `pendingAutoTitle`
   * so the start message drives LLM-based title generation (mirrors /fork).
   */
  pendingAutoTitle?: boolean;
}

export interface CreateWorkspaceResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Create a new workspace and switch to it
 * Handles backend creation, dispatching switch event, and optionally sending start message
 *
 * Shared between /new command and NewWorkspaceModal
 */
export async function createNewWorkspace(
  options: CreateWorkspaceOptions
): Promise<CreateWorkspaceResult> {
  // Get recommended trunk if not provided
  let effectiveTrunk = options.trunkBranch;
  if (!effectiveTrunk) {
    const { recommendedTrunk } = await options.client.projects.listBranches({
      projectPath: options.projectPath,
    });
    effectiveTrunk = recommendedTrunk ?? "main";
  }

  // Use saved default runtime preference if not explicitly provided
  let effectiveRuntime = options.runtime;
  if (effectiveRuntime === undefined) {
    const runtimeKey = getRuntimeKey(options.projectPath);
    const savedRuntime = localStorage.getItem(runtimeKey);
    if (savedRuntime) {
      effectiveRuntime = savedRuntime;
    }
  }

  // Parse runtime config if provided.
  const runtimeConfig = parseRuntimeString(effectiveRuntime);

  const result = await options.client.workspace.create({
    projectPath: options.projectPath,
    branchName: options.workspaceName,
    trunkBranch: effectiveTrunk,
    runtimeConfig,
    pendingAutoTitle: options.pendingAutoTitle,
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to create workspace" };
  }

  // Get workspace info for switching
  const workspaceInfo = await options.client.workspace.getInfo({ workspaceId: result.metadata.id });
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after creation" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  const client = options.client;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
        });
    });
  }

  return { success: true, workspaceInfo };
}

// ============================================================================
// Workspace Forking (Inline implementation)
// ============================================================================

// ============================================================================
// Compaction
// ============================================================================

export interface CompactionOptions {
  api?: RouterClient<AppRouter>;
  workspaceId: string;
  maxOutputTokens?: number;
  /**
   * Content to continue with after compaction.
   * Accepts CompactionFollowUpInput (without model/agentId) - prepareCompactionMessage
   * will add model/agentId from sendMessageOptions to produce CompactionFollowUpRequest.
   */
  followUpContent?: CompactionFollowUpInput;
  model?: string;
  sendMessageOptions: SendMessageOptions;
  editMessageId?: string;
  /** Source of compaction request (e.g., "idle-compaction" for auto-triggered) */
  source?: "idle-compaction";
}

export interface CompactionResult {
  success: boolean;
  error?: string;
}

/**
 * Prepare compaction message from options
 * Returns the actual message text (summarization request), metadata, and options
 */
export function prepareCompactionMessage(options: CompactionOptions): {
  messageText: string;
  metadata: MuxMessageMetadata;
  sendOptions: SendMessageOptions;
} {
  // followUpContent is the content that will be auto-sent after compaction.
  // For forced compaction (no explicit follow-up), we inject a short resume sentinel ("Continue").
  // Keep that sentinel out of the *compaction prompt* (summarization request), otherwise the model can
  // misread it as a competing instruction. We still keep it in metadata so the backend resumes.
  // Only treat it as the default resume when there's no other queued content (images/reviews).
  //
  // Convert CompactionFollowUpInput to CompactionFollowUpRequest by adding model/agentId.
  // Compaction uses its own agentId ("compact") and potentially a different model for
  // summarization, so we capture the user's original settings for the follow-up message.
  //
  // In compaction recovery (retrying a failed /compact), followUpContent may already be
  // a CompactionFollowUpRequest with preserved model/agentId. Only fill in missing fields
  // to avoid overwriting the original settings when the user changes model/agent before retry.
  let fc: CompactionFollowUpRequest | undefined;
  if (options.followUpContent) {
    // Check if already a CompactionFollowUpRequest (has model/agentId from previous compaction)
    const existingModel =
      "model" in options.followUpContent &&
      typeof options.followUpContent.model === "string" &&
      options.followUpContent.model
        ? options.followUpContent.model
        : undefined;
    const existingAgentId =
      "agentId" in options.followUpContent &&
      typeof options.followUpContent.agentId === "string" &&
      options.followUpContent.agentId
        ? options.followUpContent.agentId
        : undefined;

    fc = {
      ...options.followUpContent,
      model: existingModel ?? options.sendMessageOptions.model,
      agentId: existingAgentId ?? options.sendMessageOptions.agentId ?? WORKSPACE_DEFAULTS.agentId,
      ...pickPreservedSendOptions(options.sendMessageOptions),
      // One-shot overrides reconstructed from the original send (model /
      // thinking carried by the follow-up content) must win over the ambient
      // stored options that pickPreservedSendOptions just spread — otherwise a
      // compact-and-retry of "/haiku+0 /skill" re-dispatches with the
      // workspace's thinking and persistence semantics instead of the
      // one-shot's.
      ...(options.followUpContent.thinkingLevel != null
        ? { thinkingLevel: options.followUpContent.thinkingLevel }
        : {}),
      ...(options.followUpContent.oneShotThinkingIndex != null
        ? { oneShotThinkingIndex: options.followUpContent.oneShotThinkingIndex }
        : {}),
      ...(options.followUpContent.skipSkillModelRouting != null
        ? { skipSkillModelRouting: options.followUpContent.skipSkillModelRouting }
        : {}),
      ...(options.followUpContent.skipAiSettingsPersistence != null
        ? { skipAiSettingsPersistence: options.followUpContent.skipAiSettingsPersistence }
        : {}),
    };
  }

  // Build compaction message with optional continue context.
  // Shared helper is also used by backend-triggered idle compaction.
  const messageText = buildCompactionMessageText({
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  });

  // Handle model preference (sticky globally)
  const effectiveModel = resolveCompactionModel(options.model);

  const commandLine = formatCompactionCommandLine(options);
  const continueText = getFollowUpContentText(fc);
  const fullRawCommand = continueText ? `${commandLine}\n${continueText}` : commandLine;

  const compactData: CompactionRequestData = {
    model: effectiveModel,
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  };

  const sendOptions = applyCompactionOverrides(options.sendMessageOptions, compactData);

  const metadata: MuxMessageMetadata = {
    type: "compaction-request",
    rawCommand: fullRawCommand,
    commandPrefix: commandLine,
    parsed: compactData,
    // requestedModel keeps the "starting" banner aligned with compaction overrides.
    requestedModel: sendOptions.model,
    ...(options.source === "idle-compaction" && {
      source: options.source,
      displayStatus: { emoji: "💤", message: "Compacting idle workspace..." },
    }),
  };

  return { messageText, metadata, sendOptions };
}

/**
 * Execute a compaction command
 */
export async function executeCompaction(
  options: CompactionOptions & { api: RouterClient<AppRouter> }
): Promise<CompactionResult> {
  const { messageText, metadata, sendOptions } = prepareCompactionMessage(options);

  const result = await options.api.workspace.sendMessage({
    workspaceId: options.workspaceId,
    message: messageText,
    options: {
      ...sendOptions,
      muxMetadata: metadata,
      editMessageId: options.editMessageId,
    },
  });

  if (!result.success) {
    // Convert SendMessageError to string for error display
    const errorString = result.error
      ? typeof result.error === "string"
        ? result.error
        : "type" in result.error
          ? result.error.type
          : "Failed to compact"
      : undefined;
    return { success: false, error: errorString };
  }

  return { success: true };
}

/** Handle /new command execution. */
function handleNewCommand(
  parsed: Extract<ParsedCommand, { type: "new" }>,
  env: WorkspaceCommandEnv
): CommandResult {
  return phase([{ type: "clear-input" }, { type: "set-sending", sending: true }], async () => {
    try {
      const workspaceInfo = await env.api.workspace.getInfo({ workspaceId: env.workspaceId });
      if (!workspaceInfo) throw new Error("Failed to get workspace info");
      const trimmedStartMessage = parsed.startMessage?.trim() ?? "";
      const startMessage = trimmedStartMessage.length > 0 ? trimmedStartMessage : undefined;
      const result = await createNewWorkspace({
        client: env.api,
        projectPath: workspaceInfo.projectPath,
        startMessage,
        sendMessageOptions: env.sendMessageOptions,
        pendingAutoTitle: Boolean(startMessage),
      });
      if (!result.success) {
        const message = result.error ?? "Failed to create workspace";
        console.error("Failed to create workspace:", message);
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            title: "Create Failed",
            message,
          }),
          { type: "set-sending", sending: false },
        ]);
      }
      trackCommandUsed("new");
      const displayName =
        result.workspaceInfo?.title ?? result.workspaceInfo?.name ?? "new workspace";
      return complete("consume", [
        showToast({
          id: Date.now().toString(),
          type: "success",
          message: 'Created workspace "' + displayName + '"',
        }),
        { type: "set-sending", sending: false },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create workspace";
      console.error("Create error:", error);
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          title: "Create Failed",
          message,
        }),
        { type: "set-sending", sending: false },
      ]);
    }
  });
}

/** Handle /compact command execution. */
function handleCompactCommand(
  parsed: Extract<ParsedCommand, { type: "compact" }>,
  env: WorkspaceCommandEnv
): CommandResult {
  const normalizedModel = normalizeModelInput(parsed.model);
  if (parsed.model && !normalizedModel.model) {
    return complete("restore", [showToast(createInvalidCompactModelToast(parsed.model))]);
  }

  return phase(
    [
      { type: "clear-input" },
      { type: "clear-attachments" },
      { type: "set-sending", sending: true },
    ],
    async () => {
      try {
        const stagedAttachments = env.attachments ? getStagedAttachments(env.attachments) : [];
        const hasContent =
          parsed.continueMessage ??
          env.fileParts?.length ??
          env.reviews?.length ??
          stagedAttachments.length;
        const followUpContent: CompactionFollowUpInput | undefined = hasContent
          ? {
              text: appendStagedAttachmentNotice(parsed.continueMessage ?? "", stagedAttachments),
              fileParts: env.fileParts,
              reviews: env.reviews,
            }
          : undefined;
        const result = await executeCompaction({
          api: env.api,
          workspaceId: env.workspaceId,
          maxOutputTokens: parsed.maxOutputTokens,
          followUpContent,
          model: normalizedModel.model ?? undefined,
          sendMessageOptions: env.sendMessageOptions,
          editMessageId: env.editMessageId,
        });
        if (!result.success) {
          console.error("Failed to initiate compaction:", result.error);
          return complete("restore", [
            showToast({
              id: Date.now().toString(),
              type: "error",
              message: result.error ?? "Failed to start compaction",
            }),
            { type: "set-sending", sending: false },
          ]);
        }
        trackCommandUsed("compact");
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "success",
            message: parsed.continueMessage
              ? "Compaction started. Will continue automatically after completion."
              : "Compaction started. AI will summarize the conversation.",
          }),
          ...(env.editMessageId ? ([{ type: "cancel-edit" }] satisfies CommandAction[]) : []),
          { type: "set-sending", sending: false },
          { type: "check-reviews", reviewIds: env.attachedReviewIds ?? [] },
          {
            type: "message-sent",
            dispatchMode: env.sendMessageOptions.queueDispatchMode ?? "tool-end",
          },
        ]);
      } catch (error) {
        console.error("Compaction error:", error);
        return complete("restore", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: error instanceof Error ? error.message : "Failed to start compaction",
          }),
          { type: "set-sending", sending: false },
        ]);
      }
    }
  );
}

function handlePlanShowCommand(env: WorkspaceCommandEnv): CommandResult {
  return phase([{ type: "clear-input" }], async () => {
    try {
      const result = await env.api.workspace.getPlanContent({ workspaceId: env.workspaceId });
      if (!result.success) {
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: "No plan found for this workspace",
          }),
        ]);
      }
      addEphemeralMessage(env.workspaceId, {
        id: "plan-display-preview",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: result.data.content }],
        metadata: {
          historySequence: Number.MAX_SAFE_INTEGER,
          muxMetadata: { type: "plan-display" as const, path: result.data.path },
        },
      });
      trackCommandUsed("plan");
      return complete("consume");
    } catch (error) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Failed to show plan",
        }),
      ]);
    }
  });
}

function handlePlanOpenCommand(env: WorkspaceCommandEnv): CommandResult {
  return phase([{ type: "clear-input" }], async () => {
    try {
      const planResult = await env.api.workspace.getPlanContent({ workspaceId: env.workspaceId });
      if (!planResult.success) {
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: "No plan found for this workspace",
          }),
        ]);
      }
      const workspaceInfo = await env.api.workspace.getInfo({ workspaceId: env.workspaceId });
      const openResult = await openInEditor({
        api: env.api,
        workspaceId: env.workspaceId,
        targetPath: planResult.data.path,
        runtimeConfig: workspaceInfo?.runtimeConfig,
        isFile: true,
      });
      if (!openResult.success) {
        return complete("consume", [
          showToast({
            id: Date.now().toString(),
            type: "error",
            message: openResult.error ?? "Failed to open editor",
          }),
        ]);
      }
      trackCommandUsed("plan");
      return complete("consume", [
        showToast({
          id: Date.now().toString(),
          type: "success",
          message: "Opened plan in editor",
        }),
      ]);
    } catch (error) {
      return complete("restore", [
        showToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Failed to open plan",
        }),
      ]);
    }
  });
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Dispatch a custom event to switch workspaces
 */
