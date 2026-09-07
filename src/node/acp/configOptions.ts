import assert from "node:assert/strict";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { DEFAULT_HIDDEN_MODELS, KNOWN_MODELS } from "@/common/constants/knownModels";
import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import { getThinkingOptionLabel, isThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { resolveRemovedBuiltinAgentId } from "@/common/utils/agentIds";
import { getBuiltInAgentDefinitions } from "@/node/services/agentDefinitions/builtInAgentDefinitions";
import { resolveAgentVisibility } from "@/node/services/agentDefinitions/agentVisibility";
import type { ORPCClient } from "./serverConnection";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "./resolveAgentAiSettings";

export const AGENT_MODE_CONFIG_ID = "agentMode";
const MODEL_CONFIG_ID = "model";
const THINKING_LEVEL_CONFIG_ID = "thinkingLevel";

const DEFAULT_AGENT_MODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  exec: "Implement changes in the repository",
  plan: "Create a plan before coding",
};

interface ExposedAgentMode {
  value: string;
  label: string;
  description?: string;
}

function isUiSelectableAgentMode(frontmatter: AgentDefinitionFrontmatter): boolean {
  if (frontmatter.disabled === true) {
    return false;
  }
  return resolveAgentVisibility(frontmatter.ui).selectable;
}

const BUILTIN_AGENT_MODE_ORDER = getBuiltInAgentDefinitions()
  .filter((agent) => isUiSelectableAgentMode(agent.frontmatter))
  .map((agent) => agent.id);

const BUILTIN_AGENT_MODE_ORDER_INDEX = new Map<string, number>(
  BUILTIN_AGENT_MODE_ORDER.map((agentId, index) => [agentId, index])
);

assert(
  BUILTIN_AGENT_MODE_ORDER_INDEX.size === BUILTIN_AGENT_MODE_ORDER.length,
  "configOptions: BUILTIN_AGENT_MODE_ORDER must not contain duplicate agent IDs"
);

function sortAgentsForConfigOptions(
  agents: Awaited<ReturnType<ORPCClient["agents"]["list"]>>
): Awaited<ReturnType<ORPCClient["agents"]["list"]>> {
  return [...agents].sort((a, b) => {
    const aBuiltInIndex = BUILTIN_AGENT_MODE_ORDER_INDEX.get(a.id);
    const bBuiltInIndex = BUILTIN_AGENT_MODE_ORDER_INDEX.get(b.id);

    const aIsBuiltIn = aBuiltInIndex != null;
    const bIsBuiltIn = bBuiltInIndex != null;

    if (aIsBuiltIn && bIsBuiltIn) {
      return aBuiltInIndex - bBuiltInIndex;
    }

    if (aIsBuiltIn) {
      return -1;
    }

    if (bIsBuiltIn) {
      return 1;
    }

    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) {
      return byName;
    }

    return a.id.localeCompare(b.id);
  });
}

function resolveBuiltInExposedAgentModes(): ExposedAgentMode[] {
  return BUILTIN_AGENT_MODE_ORDER.flatMap((agentId) => {
    const builtIn = getBuiltInAgentDefinitions().find((agent) => agent.id === agentId);
    if (builtIn == null) {
      return [];
    }

    return [
      {
        value: builtIn.id,
        label: builtIn.frontmatter.name,
        description: builtIn.frontmatter.description ?? DEFAULT_AGENT_MODE_DESCRIPTIONS[builtIn.id],
      },
    ];
  });
}

async function resolveExposedAgentModes(
  client: ORPCClient,
  workspaceId: string
): Promise<ExposedAgentMode[]> {
  try {
    const selectableAgents = (await client.agents.list({ workspaceId })).filter(
      (agent) => agent.uiSelectable
    );

    return sortAgentsForConfigOptions(selectableAgents).map((agent) => ({
      value: agent.id,
      label: agent.name,
      description: agent.description ?? DEFAULT_AGENT_MODE_DESCRIPTIONS[agent.id],
    }));
  } catch {
    // ACP test harnesses and legacy embed points may provide partial ORPC clients
    // without the agents router. Fall back to built-in selectable agent metadata
    // so session config remains available.
    return resolveBuiltInExposedAgentModes();
  }
}

async function resolveAvailableAgentIds(
  client: ORPCClient,
  workspaceId: string
): Promise<string[]> {
  try {
    return (await client.agents.list({ workspaceId })).map((agent) => agent.id);
  } catch {
    return [];
  }
}

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;
type UpdateAgentAiSettingsResult = Awaited<
  ReturnType<ORPCClient["workspace"]["updateAgentAISettings"]>
>;

interface BuildConfigOptionsArgs {
  activeAgentId?: string;
}

interface HandleSetConfigOptionArgs {
  activeAgentId?: string;
  onAgentModeChanged?: (agentId: string, aiSettings: ResolvedAiSettings) => Promise<void> | void;
}

function isModeAgentId(agentId: string): agentId is "plan" | "exec" {
  return agentId === "plan" || agentId === "exec";
}

function ensureUpdateSucceeded(result: UpdateAgentAiSettingsResult, operation: string): void {
  if (!result.success) {
    throw new Error(`${operation} failed: ${result.error}`);
  }
}

async function getWorkspaceInfoOrThrow(
  client: ORPCClient,
  workspaceId: string
): Promise<WorkspaceInfo> {
  const workspace = await client.workspace.getInfo({ workspaceId });
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' was not found`);
  }

  return workspace;
}

function getCurrentAgentId(workspace: WorkspaceInfo): string {
  return workspace.agentId ?? "exec";
}

function resolveCurrentAgentId(agentId: string, availableAgentIds: Iterable<string>): string {
  return resolveRemovedBuiltinAgentId(agentId, availableAgentIds);
}

async function resolveCurrentAiSettings(
  client: ORPCClient,
  workspace: WorkspaceInfo,
  workspaceId: string,
  agentId: string
): Promise<ResolvedAiSettings> {
  const workspaceAiSettings = workspace.aiSettingsByAgent?.[agentId] ?? workspace.aiSettings;
  if (workspaceAiSettings) {
    return {
      model: workspaceAiSettings.model,
      thinkingLevel: enforceThinkingPolicy(
        workspaceAiSettings.model,
        workspaceAiSettings.thinkingLevel
      ),
      ...(workspaceAiSettings.reasoningMode != null
        ? { reasoningMode: workspaceAiSettings.reasoningMode }
        : {}),
    };
  }

  const resolvedDefaults = await resolveAgentAiSettings(client, agentId, workspaceId);
  return {
    model: resolvedDefaults.model,
    thinkingLevel: enforceThinkingPolicy(resolvedDefaults.model, resolvedDefaults.thinkingLevel),
    ...(resolvedDefaults.reasoningMode != null
      ? { reasoningMode: resolvedDefaults.reasoningMode }
      : {}),
  };
}

function buildAgentModeSelectOptions(
  modes: ExposedAgentMode[],
  currentAgentId: string
): SessionConfigSelectOption[] {
  const options: SessionConfigSelectOption[] = modes.map((mode) => ({
    value: mode.value,
    name: mode.label,
    description: mode.description,
  }));

  if (!options.some((option) => option.value === currentAgentId)) {
    options.unshift({ value: currentAgentId, name: currentAgentId });
  }

  return options;
}

function buildModelSelectOptions(
  currentModel: string,
  hiddenModels: readonly string[]
): SessionConfigSelectOption[] {
  const hidden = new Set(hiddenModels);
  const options: SessionConfigSelectOption[] = Object.values(KNOWN_MODELS)
    .filter((model) => !hidden.has(model.id))
    .map((model) => ({ value: model.id, name: model.id }));

  if (!options.some((option) => option.value === currentModel)) {
    options.unshift({ value: currentModel, name: currentModel });
  }

  return options;
}

function buildThinkingLevelSelectOptions(modelString: string): SessionConfigSelectOption[] {
  const allowedThinkingLevels = getThinkingPolicyForModel(modelString);

  return allowedThinkingLevels.map((level) => ({
    value: level,
    name: getThinkingOptionLabel(level, modelString),
  }));
}

async function persistAgentAiSettings(
  client: ORPCClient,
  workspaceId: string,
  agentId: string,
  aiSettings: ResolvedAiSettings
): Promise<void> {
  if (isModeAgentId(agentId)) {
    const updateModeResult = await client.workspace.updateModeAISettings({
      workspaceId,
      mode: agentId,
      aiSettings,
    });
    ensureUpdateSucceeded(updateModeResult, "workspace.updateModeAISettings");
    return;
  }

  const updateAgentResult = await client.workspace.updateAgentAISettings({
    workspaceId,
    agentId,
    aiSettings,
  });
  ensureUpdateSucceeded(updateAgentResult, "workspace.updateAgentAISettings");
}

export async function buildConfigOptions(
  client: ORPCClient,
  workspaceId: string,
  args?: BuildConfigOptionsArgs
): Promise<SessionConfigOption[]> {
  assert(workspaceId.trim().length > 0, "buildConfigOptions: workspaceId must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, workspaceId);
  const overrideAgentId = args?.activeAgentId?.trim();
  const [exposedAgentModes, availableAgentIds, config] = await Promise.all([
    resolveExposedAgentModes(client, workspaceId),
    resolveAvailableAgentIds(client, workspaceId),
    client.config.getConfig(),
  ]);
  const currentAgentId = resolveCurrentAgentId(
    typeof overrideAgentId === "string" && overrideAgentId.length > 0
      ? overrideAgentId
      : getCurrentAgentId(workspace),
    availableAgentIds.length > 0 ? availableAgentIds : exposedAgentModes.map((mode) => mode.value)
  );
  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    workspaceId,
    currentAgentId
  );
  const agentModeOptions = buildAgentModeSelectOptions(exposedAgentModes, currentAgentId);

  const effectiveThinkingLevel = enforceThinkingPolicy(
    currentAiSettings.model,
    currentAiSettings.thinkingLevel
  );

  const configOptions: SessionConfigOption[] = [
    {
      id: AGENT_MODE_CONFIG_ID,
      name: "Agent Mode",
      type: "select",
      category: "mode",
      currentValue: currentAgentId,
      options: agentModeOptions,
    },
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      type: "select",
      category: "model",
      currentValue: currentAiSettings.model,
      options: buildModelSelectOptions(
        currentAiSettings.model,
        config.hiddenModels ?? DEFAULT_HIDDEN_MODELS
      ),
    },
    {
      id: THINKING_LEVEL_CONFIG_ID,
      name: "Thinking Level",
      type: "select",
      category: "thought_level",
      currentValue: effectiveThinkingLevel,
      options: buildThinkingLevelSelectOptions(currentAiSettings.model),
    },
  ];

  return configOptions;
}

export async function handleSetConfigOption(
  client: ORPCClient,
  workspaceId: string,
  configId: string,
  value: string,
  args?: HandleSetConfigOptionArgs
): Promise<SessionConfigOption[]> {
  const trimmedWorkspaceId = workspaceId.trim();
  const trimmedConfigId = configId.trim();
  const trimmedValue = value.trim();

  assert(trimmedWorkspaceId.length > 0, "handleSetConfigOption: workspaceId must be non-empty");
  assert(trimmedConfigId.length > 0, "handleSetConfigOption: configId must be non-empty");
  assert(trimmedValue.length > 0, "handleSetConfigOption: value must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, trimmedWorkspaceId);
  const overrideAgentId = args?.activeAgentId?.trim();
  const [exposedAgentModes, availableAgentIds] = await Promise.all([
    resolveExposedAgentModes(client, trimmedWorkspaceId),
    resolveAvailableAgentIds(client, trimmedWorkspaceId),
  ]);
  const knownAgentIds =
    availableAgentIds.length > 0 ? availableAgentIds : exposedAgentModes.map((mode) => mode.value);
  const currentAgentId = resolveCurrentAgentId(
    typeof overrideAgentId === "string" && overrideAgentId.length > 0
      ? overrideAgentId
      : getCurrentAgentId(workspace),
    knownAgentIds
  );

  if (trimmedConfigId === AGENT_MODE_CONFIG_ID) {
    const nextAgentId = resolveCurrentAgentId(trimmedValue, knownAgentIds);

    // Prefer workspace-specific settings already saved for the target agent
    // (e.g., user customized model/thinking for this mode).  Only fall back
    // to resolved defaults when no prior settings exist for the agent.
    const existingSettings = workspace.aiSettingsByAgent?.[nextAgentId];
    const resolvedAiSettings =
      existingSettings?.model != null && existingSettings?.thinkingLevel != null
        ? {
            model: existingSettings.model,
            thinkingLevel: existingSettings.thinkingLevel,
            reasoningMode: existingSettings.reasoningMode,
          }
        : await resolveAgentAiSettings(client, nextAgentId, trimmedWorkspaceId);

    const normalizedAiSettings: ResolvedAiSettings = {
      model: resolvedAiSettings.model,
      thinkingLevel: enforceThinkingPolicy(
        resolvedAiSettings.model,
        resolvedAiSettings.thinkingLevel
      ),
      ...(resolvedAiSettings.reasoningMode != null
        ? { reasoningMode: resolvedAiSettings.reasoningMode }
        : {}),
    };

    await persistAgentAiSettings(client, trimmedWorkspaceId, nextAgentId, normalizedAiSettings);
    if (args?.onAgentModeChanged != null) {
      await args.onAgentModeChanged(nextAgentId, normalizedAiSettings);
    }

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: nextAgentId });
  }

  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    trimmedWorkspaceId,
    currentAgentId
  );

  if (trimmedConfigId === MODEL_CONFIG_ID) {
    const clampedThinkingLevel = enforceThinkingPolicy(
      trimmedValue,
      currentAiSettings.thinkingLevel
    );

    // Retain pro mode across model changes (matching the settings UI); the
    // send path re-gates per model so unsupported models are unaffected.
    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: trimmedValue,
      thinkingLevel: clampedThinkingLevel,
      ...(currentAiSettings.reasoningMode != null
        ? { reasoningMode: currentAiSettings.reasoningMode }
        : {}),
    });

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: currentAgentId });
  }

  if (trimmedConfigId === THINKING_LEVEL_CONFIG_ID) {
    if (!isThinkingLevel(trimmedValue)) {
      throw new Error(
        `handleSetConfigOption: value must be a valid ThinkingLevel, got '${trimmedValue}'`
      );
    }

    const clampedThinkingLevel = enforceThinkingPolicy(currentAiSettings.model, trimmedValue);

    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: currentAiSettings.model,
      thinkingLevel: clampedThinkingLevel,
      ...(currentAiSettings.reasoningMode != null
        ? { reasoningMode: currentAiSettings.reasoningMode }
        : {}),
    });

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: currentAgentId });
  }

  throw new Error(`Unsupported config option id '${trimmedConfigId}'`);
}
