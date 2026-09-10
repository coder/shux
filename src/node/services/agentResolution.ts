/**
 * Agent resolution: resolves the active agent and computes tool policy for a stream.
 *
 * Extracted from `streamMessage()` to make the agent resolution logic
 * explicit and testable. Contains:
 * - Agent ID normalization & fallback to exec
 * - Agent definition loading with error recovery
 * - Disabled-agent enforcement (subagent workspaces error, top-level falls back)
 * - Inheritance chain resolution + plan-like detection
 * - Task nesting depth enforcement
 * - Tool policy composition (agent → caller)
 */

import { resolveAdvisorEnabledForAgent } from "@/common/constants/advisor";
import { AgentIdSchema } from "@/common/orpc/schemas";
import type { SendMessageError } from "@/common/types/errors";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ErrorEvent } from "@/common/types/stream";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { resolvePersistedAgentIdCandidates } from "@/common/utils/agentIds";
import { getErrorMessage } from "@/common/utils/errors";
import { type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { createRuntimeContextForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentVisibility } from "@/node/services/agentDefinitions/agentVisibility";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { resolveToolPolicyForAgent } from "@/node/services/agentDefinitions/resolveToolPolicy";
import { log } from "./log";
import { getTaskDepthFromConfig } from "./taskUtils";
import { createAssistantMessageId } from "./utils/messageIds";
import { createErrorEvent } from "./utils/sendMessageError";

/** Options for agent resolution. */
export interface ResolveAgentOptions {
  workspaceId: string;
  metadata: WorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  /** Requested agent ID from the frontend (may be undefined → defaults to exec). */
  requestedAgentId: string | undefined;
  /** When true, skip workspace-specific agents (for "unbricking" broken agent files). */
  disableWorkspaceAgents: boolean;
  /**
   * When truthy, a top-level requested agent that cannot be resolved (or is
   * hidden or disabled) fails the stream loudly instead of silently falling back
   * to exec. Set by workspace-turn launches with explicit agent overrides: their
   * pre-dispatch validation races init hooks and user edits, so this post-init
   * resolution is the last sound gate against running a different agent than
   * the caller asked for. The object form additionally pins the validated
   * definition's provenance (scope) — see SendMessageOptionsSchema. Sub-agent
   * workspaces already fail loudly.
   */
  strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  /** Caller-supplied tool policy (applied AFTER agent policy for further restriction). */
  callerToolPolicy: ToolPolicy | undefined;
  /** Loaded config from Config.loadConfigOrDefault(). */
  cfg: ProjectsConfig;
  /** Emit an error event on the AIService EventEmitter (for disabled-agent subagent errors). */
  emitError: (event: ErrorEvent) => void;
  /** Whether the advisor-tool experiment is enabled (from ExperimentsService). */
  isAdvisorExperimentEnabled?: boolean;
  /** agent-plugins experiment: also resolve agents contributed by Agent Plugins. */
  includeAgentPlugins?: boolean;
}

/** Result of agent resolution — all computed values needed by the stream pipeline. */
export interface AgentResolutionResult {
  effectiveAgentId: string;
  agentDefinition: Awaited<ReturnType<typeof readAgentDefinition>>;
  /** Runtime used for agent discovery (child workspace or parent fallback for untracked agents). */
  agentDiscoveryRuntime: Runtime;
  /** Path used for agent discovery (workspace path or project path if agents disabled). */
  agentDiscoveryPath: string;
  isSubagentWorkspace: boolean;
  /** Resolved inheritance chain in child → base order for capability checks. */
  agentInheritanceChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>>;
  /** Whether the resolved agent inherits plan-like behavior (has propose_plan in tool chain). */
  agentIsPlanLike: boolean;
  effectiveMode: "plan" | "exec" | "compact";
  taskSettings: ProjectsConfig["taskSettings"] & {};
  taskDepth: number;
  shouldDisableTaskToolsForDepth: boolean;
  /** Composed tool policy: agent → caller (in application order). */
  effectiveToolPolicy: ToolPolicy | undefined;
}

/**
 * Resolve the active agent and compute tool policy for a stream request.
 *
 * This is the first major phase of `streamMessage()` after workspace/runtime setup.
 * It determines which agent definition to use, whether plan mode is active, and what
 * tools are available (via policy). The result feeds into system prompt construction
 * and tool assembly.
 *
 * Returns `Err` only when a disabled agent is requested in a subagent workspace
 * (top-level workspaces silently fall back to exec).
 */
// Derived agents (for example Explore, which uses Exec as its tool-policy base) should not
// be labeled as their base mode in persisted/public metadata; `agentId` is the source of truth.
export function getLegacyModeForAgentMetadata(
  effectiveAgentId: string,
  effectiveMode: "plan" | "exec" | "compact"
): "plan" | "exec" | "compact" | undefined {
  return effectiveAgentId === effectiveMode ? effectiveMode : undefined;
}

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRequestedAgentId(value: unknown, fallback: "exec" = "exec"): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : fallback;
  const parsed = AgentIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

interface AgentDiscoveryCandidate {
  runtime: Runtime;
  workspacePath: string;
}

function findWorkspaceById(
  cfg: ProjectsConfig,
  workspaceId: string
): { projectPath: string; workspace: WorkspaceConfigEntry } | undefined {
  for (const [projectPath, project] of cfg.projects) {
    const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace != null) {
      return { projectPath, workspace };
    }
  }
  return undefined;
}

function getAgentDiscoveryCandidates(params: {
  metadata: WorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  disableWorkspaceAgents: boolean;
  cfg: ProjectsConfig;
}): AgentDiscoveryCandidate[] {
  if (params.disableWorkspaceAgents) {
    return [{ runtime: params.runtime, workspacePath: params.metadata.projectPath }];
  }

  // Child project definitions must keep normal project > global > built-in precedence.
  // Parent discovery is a fallback for untracked project agents that never reached the child worktree.
  const candidates: AgentDiscoveryCandidate[] = [
    { runtime: params.runtime, workspacePath: params.workspacePath },
  ];

  const parentWorkspace = params.metadata.parentWorkspaceId
    ? findWorkspaceById(params.cfg, params.metadata.parentWorkspaceId)
    : undefined;
  const parentWorkspaceName = coerceNonEmptyString(parentWorkspace?.workspace.name);
  if (parentWorkspace != null && parentWorkspaceName != null) {
    try {
      candidates.push(
        createRuntimeContextForWorkspace({
          runtimeConfig: parentWorkspace.workspace.runtimeConfig ?? params.metadata.runtimeConfig,
          projectPath: parentWorkspace.projectPath,
          name: parentWorkspaceName,
          namedWorkspacePath: coerceNonEmptyString(parentWorkspace.workspace.path),
        })
      );
    } catch (error) {
      log.debug("Failed to build parent agent-discovery runtime", {
        parentWorkspaceId: params.metadata.parentWorkspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  return candidates;
}

export async function resolveAgentForStream(
  opts: ResolveAgentOptions
): Promise<Result<AgentResolutionResult, SendMessageError>> {
  const {
    workspaceId,
    metadata,
    runtime,
    workspacePath,
    requestedAgentId: rawAgentId,
    disableWorkspaceAgents,
    strictAgentResolution,
    callerToolPolicy,
    cfg,
    emitError,
    isAdvisorExperimentEnabled,
    includeAgentPlugins,
  } = opts;

  const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

  // --- Agent ID resolution ---
  // Precedence:
  // - Child workspaces (tasks) use their persisted agentId/agentType.
  // - Main workspaces use the requested agentId (frontend), falling back to exec.
  const requestedAgentIds = metadata.parentWorkspaceId
    ? [...resolvePersistedAgentIdCandidates(metadata), "exec"].filter(
        (agentId, index, candidates) => candidates.indexOf(agentId) === index
      )
    : [normalizeRequestedAgentId(rawAgentId)];
  const requestedAgentId = requestedAgentIds[0] ?? ("exec" as const);
  let effectiveAgentId = requestedAgentId;

  // When disableWorkspaceAgents is true, skip workspace-specific agents entirely.
  // Use project path so only built-in/global agents are available. This allows "unbricking"
  // when iterating on agent files — a broken agent in the worktree won't affect message sending.
  const agentDiscoveryCandidates = getAgentDiscoveryCandidates({
    metadata,
    runtime,
    workspacePath,
    disableWorkspaceAgents,
    cfg,
  });
  let agentDiscoveryRuntime = agentDiscoveryCandidates[0]?.runtime ?? runtime;
  let agentDiscoveryPath = agentDiscoveryCandidates[0]?.workspacePath ?? workspacePath;

  const isSubagentWorkspace = Boolean(metadata.parentWorkspaceId);
  // Strict explicit-agent gating applies only to top-level sends: sub-agent workspaces
  // already fail loudly and legitimately run hidden agents (explore, compact).
  const strictTopLevel =
    strictAgentResolution != null && strictAgentResolution !== false && !isSubagentWorkspace;
  const strictExpectedScope =
    typeof strictAgentResolution === "object" ? strictAgentResolution.expectedScope : undefined;

  // --- Load agent definition (with fallback to exec) ---
  let agentDefinition: Awaited<ReturnType<typeof readAgentDefinition>> | undefined;
  for (const candidateAgentId of requestedAgentIds) {
    let fallbackDefinition:
      | {
          definition: Awaited<ReturnType<typeof readAgentDefinition>>;
          discovery: AgentDiscoveryCandidate;
        }
      | undefined;

    for (const discovery of agentDiscoveryCandidates) {
      try {
        const definition = await readAgentDefinition(
          discovery.runtime,
          discovery.workspacePath,
          candidateAgentId,
          { includeAgentPlugins }
        );
        if (definition.scope === "project") {
          agentDefinition = definition;
          agentDiscoveryRuntime = discovery.runtime;
          agentDiscoveryPath = discovery.workspacePath;
          break;
        }
        fallbackDefinition ??= { definition, discovery };
      } catch {
        // Parent-only project agents may be untracked and absent from child worktrees.
        // Try the next discovery context before moving to the next persisted agent id.
      }
    }

    if (agentDefinition != null) {
      break;
    }
    if (fallbackDefinition != null) {
      agentDefinition = fallbackDefinition.definition;
      agentDiscoveryRuntime = fallbackDefinition.discovery.runtime;
      agentDiscoveryPath = fallbackDefinition.discovery.workspacePath;
      break;
    }
  }

  if (agentDefinition == null) {
    if (strictTopLevel) {
      const errorMessage = `Agent '${requestedAgentId}' could not be resolved in this workspace; refusing to fall back to exec for an explicit agent request.`;
      emitError(
        createErrorEvent(workspaceId, {
          messageId: createAssistantMessageId(),
          error: errorMessage,
          errorType: "agent_resolution",
        })
      );
      return Err({ type: "unknown", raw: errorMessage });
    }
    workspaceLog.warn("Failed to load agent definition; falling back", {
      requestedAgentIds,
      agentDiscoveryPaths: agentDiscoveryCandidates.map((candidate) => candidate.workspacePath),
      disableWorkspaceAgents,
    });
    agentDefinition = await readAgentDefinition(agentDiscoveryRuntime, agentDiscoveryPath, "exec", {
      includeAgentPlugins,
    });
  }

  // Strict provenance pin: launch validation approved a specific definition, not just
  // an id. If that definition vanished (e.g. an init hook or edit deleted a validated
  // project shadow) and a different candidate now resolves the same id — a lower
  // scope, or a same-scope sibling like a project plugin taking over for a removed
  // project file — the turn would run a different prompt/tool policy with AI settings
  // derived from the validated one. Scope alone is not a provenance identifier, so
  // the exact source (discovery root / "built-in") is compared when pinned.
  if (strictTopLevel && strictExpectedScope != null) {
    const expectedSource =
      typeof strictAgentResolution === "object" ? strictAgentResolution.expectedSource : undefined;
    const scopeMismatch = agentDefinition.scope !== strictExpectedScope;
    const sourceMismatch = expectedSource != null && agentDefinition.source !== expectedSource;
    if (scopeMismatch || sourceMismatch) {
      const errorMessage = `Agent '${requestedAgentId}' now resolves from a different definition than launch validation saw (expected ${strictExpectedScope}${expectedSource != null ? ` @ ${expectedSource}` : ""}, found ${agentDefinition.scope}${agentDefinition.source != null ? ` @ ${agentDefinition.source}` : ""}); refusing to stream an explicit agent request.`;
      emitError(
        createErrorEvent(workspaceId, {
          messageId: createAssistantMessageId(),
          error: errorMessage,
          errorType: "agent_resolution",
        })
      );
      return Err({ type: "unknown", raw: errorMessage });
    }
  }

  // Keep agent ID aligned with the actual definition used (may fall back to exec).
  effectiveAgentId = agentDefinition.id;

  // --- Disabled-agent enforcement ---
  // Disabled agents should never run as sub-agents, even if a task workspace already exists
  // on disk (e.g., config changed since creation).
  // For top-level workspaces, fall back to exec to keep the workspace usable.
  // Strict sends also verify exec itself: discovery can select a project/global exec
  // shadow, and a hidden shadow must hit the selectability gate below like any other id.
  if (agentDefinition.id !== "exec" || strictTopLevel) {
    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        agentDiscoveryRuntime,
        agentDiscoveryPath,
        agentDefinition.id,
        {
          includeAgentPlugins,
          skipScopesAbove: getSkipScopesAboveForKnownScope(agentDefinition.scope),
        }
      );

      // Strict explicit-agent sends must also reject definitions that are no longer
      // selectable: the workspace-task contract excludes internal (ui.hidden) agents,
      // and an init hook or concurrent edit could hide the definition between
      // launch-time validation and this stream. Sub-agent workspaces legitimately run
      // hidden agents (explore, compact), so only strict top-level sends are gated.
      if (strictTopLevel && !resolveAgentVisibility(resolvedFrontmatter.ui).selectable) {
        const errorMessage = `Agent '${agentDefinition.id}' is not selectable for explicit agent requests.`;
        emitError(
          createErrorEvent(workspaceId, {
            messageId: createAssistantMessageId(),
            error: errorMessage,
            errorType: "agent_resolution",
          })
        );
        return Err({ type: "unknown", raw: errorMessage });
      }

      const effectivelyDisabled = isAgentEffectivelyDisabled({
        cfg,
        agentId: agentDefinition.id,
        resolvedFrontmatter,
      });

      if (effectivelyDisabled) {
        const errorMessage = `Agent '${agentDefinition.id}' is disabled.`;

        if (isSubagentWorkspace || strictAgentResolution) {
          const errorMessageId = createAssistantMessageId();
          emitError(
            createErrorEvent(workspaceId, {
              messageId: errorMessageId,
              error: errorMessage,
              errorType: strictTopLevel ? "agent_resolution" : "unknown",
            })
          );
          return Err({ type: "unknown", raw: errorMessage });
        }

        workspaceLog.warn("Selected agent is disabled; falling back to exec", {
          agentId: agentDefinition.id,
          requestedAgentId,
        });
        agentDefinition = await readAgentDefinition(
          agentDiscoveryRuntime,
          agentDiscoveryPath,
          "exec",
          { includeAgentPlugins }
        );
        effectiveAgentId = agentDefinition.id;
      }
    } catch (error: unknown) {
      // Strict sends fail closed when eligibility cannot be verified: a hook or edit
      // that breaks the definition (e.g. a base pointing at a missing definition) after
      // launch validation would otherwise stream a partially resolved prompt/tool policy.
      if (strictTopLevel) {
        const errorMessage = `Agent '${agentDefinition.id}' eligibility could not be verified (${getErrorMessage(error)}); refusing to stream an explicit agent request.`;
        emitError(
          createErrorEvent(workspaceId, {
            messageId: createAssistantMessageId(),
            error: errorMessage,
            errorType: "agent_resolution",
          })
        );
        return Err({ type: "unknown", raw: errorMessage });
      }
      // Best-effort only — do not fail a stream due to disablement resolution.
      workspaceLog.debug("Failed to resolve agent enablement; continuing", {
        agentId: agentDefinition.id,
        error: getErrorMessage(error),
      });
    }
  }

  // --- Inheritance chain & plan-like detection ---
  const agentsForInheritance = await resolveAgentInheritanceChain({
    runtime: agentDiscoveryRuntime,
    workspacePath: agentDiscoveryPath,
    agentId: agentDefinition.id,
    agentDefinition,
    workspaceId,
    includeAgentPlugins,
  });

  // Strict chain pin: inheritance resolution reloads every base independently, so a
  // vanished base shadow could otherwise silently swap a different definition into
  // the chain's prompt/tool policy even though the validated leaf is unchanged.
  const strictExpectedChain =
    typeof strictAgentResolution === "object" ? strictAgentResolution.expectedChain : undefined;
  if (strictTopLevel && strictExpectedChain != null) {
    const chainMatches =
      agentsForInheritance.length === strictExpectedChain.length &&
      strictExpectedChain.every((expected, index) => {
        const actual = agentsForInheritance[index];
        return (
          actual != null &&
          actual.id === expected.id &&
          actual.scope === expected.scope &&
          (expected.source == null || actual.source === expected.source)
        );
      });
    if (!chainMatches) {
      const describeChain = (
        entries: ReadonlyArray<{ id: string; scope: string; source?: string }>
      ) =>
        entries
          .map(
            (entry) =>
              `${entry.id}(${entry.scope}${entry.source != null ? ` @ ${entry.source}` : ""})`
          )
          .join(" -> ");
      const errorMessage = `Agent '${requestedAgentId}' base chain now resolves differently than launch validation saw (expected ${describeChain(strictExpectedChain)}, found ${describeChain(agentsForInheritance)}); refusing to stream an explicit agent request.`;
      emitError(
        createErrorEvent(workspaceId, {
          messageId: createAssistantMessageId(),
          error: errorMessage,
          errorType: "agent_resolution",
        })
      );
      return Err({ type: "unknown", raw: errorMessage });
    }
  }

  const agentIsPlanLike = isPlanLikeInResolvedChain(agentsForInheritance);
  const effectiveMode =
    agentDefinition.id === "compact" ? "compact" : agentIsPlanLike ? "plan" : "exec";

  // --- Task nesting depth enforcement ---
  const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
  const taskDepth = getTaskDepthFromConfig(cfg, workspaceId);
  const shouldDisableTaskToolsForDepth = taskDepth >= taskSettings.maxTaskNestingDepth;

  // --- Tool policy composition ---
  // Agent policy establishes baseline (deny-all + enable whitelist + runtime restrictions).
  // Caller policy then narrows further if needed.
  const advisorEnabled =
    isAdvisorExperimentEnabled === true &&
    resolveAdvisorEnabledForAgent(
      effectiveAgentId,
      cfg.agentAiDefaults?.[effectiveAgentId]?.advisorEnabled
    );
  const agentToolPolicy = resolveToolPolicyForAgent({
    agents: agentsForInheritance,
    isSubagent: isSubagentWorkspace,
    disableTaskToolsForDepth: shouldDisableTaskToolsForDepth,
    advisorEnabled,
  });

  // Caller require policies (e.g. task completion enforcement) must take precedence.
  // Drop agent-level require filters in that case to avoid multiple-required-tool conflicts.
  const callerRequiresTool =
    callerToolPolicy?.some((filter) => filter.action === "require") === true;
  const agentToolPolicyForComposition = callerRequiresTool
    ? agentToolPolicy.filter((filter) => filter.action !== "require")
    : agentToolPolicy;

  const effectiveToolPolicy: ToolPolicy | undefined =
    callerToolPolicy || agentToolPolicyForComposition.length > 0
      ? [...agentToolPolicyForComposition, ...(callerToolPolicy ?? [])]
      : undefined;

  return Ok({
    effectiveAgentId,
    agentDefinition,
    agentDiscoveryRuntime,
    agentDiscoveryPath,
    isSubagentWorkspace,
    agentInheritanceChain: agentsForInheritance,
    agentIsPlanLike,
    effectiveMode,
    taskSettings,
    taskDepth,
    shouldDisableTaskToolsForDepth,
    effectiveToolPolicy,
  });
}
