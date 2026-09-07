import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "../../../src/common/constants/knownModels";
import {
  isCodexOauthAllowedModel,
  isCodexOauthRequiredModel,
} from "../../../src/common/constants/codexOAuth";
import { isModelAvailable, resolveRoute } from "../../../src/common/routing";
import { collectDeclaredAncestorLayers } from "../../../src/common/utils/ai/agentAncestorLayers";
import { resolveAgentAiSettings } from "../../../src/common/utils/ai/resolveAgentAiSettings";
import { targetWorkspaceBucketToLayer } from "../../../src/common/types/agentAiSettings";
import { normalizeToCanonical } from "../../../src/common/utils/ai/models";
import { formatModelDisplayName } from "../../../src/common/utils/ai/modelDisplay";
import { isProviderModelAccessibleFromAuthoritativeCatalog } from "../../../src/common/utils/providers/gatewayModelCatalog";
import type { MobileClient } from "./api";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import type { SendMessageOptions } from "../../../src/common/orpc/types";
import type { ThinkingLevel } from "../../../src/common/types/thinking";

export type SettingsData = {
  config: Pick<
    Awaited<ReturnType<MobileClient["config"]["getConfig"]>>,
    | "agentAiDefaults"
    | "defaultModel"
    | "hiddenModels"
    | "routePriority"
    | "routeOverrides"
    | "userPreferences"
  >;
  providers: Awaited<ReturnType<MobileClient["providers"]["getConfig"]>>;
  agents: Awaited<ReturnType<MobileClient["agents"]["list"]>>;
};
export type ChatSettings = Pick<
  SendMessageOptions,
  "model" | "agentId" | "thinkingLevel" | "reasoningMode" | "providerOptions" | "allowAgentSetGoal"
>;
export const thinkingLevels: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export function resolveSettings(
  workspace: Pick<FrontendWorkspaceMetadata, "aiSettingsByAgent" | "agentId" | "aiSettings">,
  data: SettingsData,
  agentId: string,
  selection?: ChatSettings | null
): ChatSettings {
  const workspaceDefaults =
    workspace.aiSettingsByAgent?.[agentId] ??
    (workspace.agentId === agentId ? workspace.aiSettings : undefined);
  const descriptors = new Map(
    data.agents.map((agent) => [
      agent.id,
      {
        base: agent.base,
        definitionAiDefaults: agent.aiDefaults,
      },
    ])
  );
  // Reuse desktop/server field-wise inheritance, including Off and standard defaults.
  const resolved = resolveAgentAiSettings({
    targetAgentId: agentId,
    profile: "interactive",
    explicit: selection ?? undefined,
    targetWorkspaceSettings: workspaceDefaults
      ? targetWorkspaceBucketToLayer(workspaceDefaults)
      : undefined,
    agentAiDefaults: data.config.agentAiDefaults,
    targetDefinitionAiDefaults: descriptors.get(agentId)?.definitionAiDefaults,
    ancestors: collectDeclaredAncestorLayers(agentId, descriptors),
    defaultModel: data.config.defaultModel,
    providersConfig: data.providers,
  });
  return {
    ...resolved.selected,
    agentId,
    // App-initiated turns retain the same goal capability as desktop, including recovery.
    allowAgentSetGoal: true,
    // Server-synced preferences own privacy/cache settings, even after a local model switch.
    providerOptions: data.config.userPreferences?.ai?.providerOptions,
  };
}

export function modelChoices(data: SettingsData, currentModel: string): string[] {
  const models = new Set<string>();
  if (currentModel) models.add(currentModel);
  // Match the web Settings catalog: `models` is the user-visible union; raw discovery
  // can still contain removed entries. Gateway duplicates use canonical model rows.
  for (const [provider, config] of Object.entries(data.providers)) {
    if (!config.isEnabled || provider === "mux-gateway" || provider === "github-copilot") continue;
    for (const entry of config.models ?? []) {
      models.add(`${provider}:${typeof entry === "string" ? entry : entry.id}`);
    }
  }
  for (const model of Object.values(KNOWN_MODELS)) models.add(model.id);
  const isConfigured = (provider: string) =>
    data.providers[provider]?.isConfigured === true &&
    data.providers[provider]?.isEnabled !== false;
  const isAccessible = (provider: string, modelId: string) => {
    const config = data.providers[provider];
    return isProviderModelAccessibleFromAuthoritativeCatalog(
      provider,
      modelId,
      config?.models,
      config?.discoveredModels,
      config?.removedModels
    );
  };
  return [...models].filter((model) => {
    // Retain the active choice even if Settings subsequently hides or disables it.
    if (model === currentModel) return true;
    if (data.config.hiddenModels?.includes(model)) return false;
    const colon = model.indexOf(":");
    if (!isAccessible(model.slice(0, colon), model.slice(colon + 1))) return false;
    if (
      !isModelAvailable(
        model,
        data.config.routePriority ?? ["direct"],
        data.config.routeOverrides ?? {},
        isConfigured,
        isAccessible
      )
    )
      return false;
    // Gate only the actual direct route; gateways supply their own credentials.
    if (
      resolveRoute(
        model,
        data.config.routePriority ?? ["direct"],
        data.config.routeOverrides ?? {},
        isConfigured,
        isAccessible
      ).routeProvider !== "openai"
    )
      return true;
    const openai = data.providers.openai;
    if (openai?.apiKeySet && openai.codexOauthSet) return true;
    if (!openai?.apiKeySet && openai?.codexOauthSet)
      return isCodexOauthAllowedModel(model, data.providers);
    return !isCodexOauthRequiredModel(model, data.providers);
  });
}

export function modelName(id: string): string {
  return formatModelDisplayName(
    id
      .slice(id.indexOf(":") + 1)
      .split("/")
      .at(-1) ?? id
  );
}

export function modelMatchesSearch(model: string, query: string, providerName: string): boolean {
  const search = query.trim().toLowerCase();
  if (`${model} ${modelName(model)} ${providerName}`.toLowerCase().includes(search)) return true;
  const canonical = normalizeToCanonical(model);
  return Object.entries(MODEL_ABBREVIATIONS).some(
    ([alias, id]) => id === canonical && alias.includes(search)
  );
}
