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
import {
  isGatewayModelAccessibleForUi,
  isModelAllowedByPolicy,
} from "../../../src/browser/utils/policyUi";
import type { MobileClient } from "./api";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import type { SendMessageOptions } from "../../../src/common/orpc/types";
import type { ThinkingLevel } from "../../../src/common/types/thinking";

export type SettingsData = {
  // Null is unavailable, never an implicit policy-disabled fallback.
  policy: Awaited<ReturnType<MobileClient["policy"]["get"]>> | null;
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

function modelRouting(data: SettingsData) {
  const policy = data.policy?.status.state === "enforced" ? data.policy.policy : null;
  return {
    policy,
    isConfigured: (provider: string) =>
      data.providers[provider]?.isConfigured === true &&
      data.providers[provider]?.isEnabled !== false,
    isAccessible: (gateway: string, modelId: string) =>
      isGatewayModelAccessibleForUi(policy, data.providers, gateway, modelId),
  };
}

export function getPolicyStateBlockReason(data: SettingsData): string | null {
  if (!data.policy || (data.policy.status.state === "enforced" && !data.policy.policy))
    return "Server policy unavailable. Retry to reload it.";
  // The server owns minimum-client/version semantics, including its blocked reason.
  if (data.policy.status.state === "blocked")
    return data.policy.status.reason || "Blocked by server policy.";
  return null;
}

export function getModelBlockReason(data: SettingsData, model: string): string | null {
  return getPolicyStateBlockReason(data) ?? getModelRouteBlockReason(data, model);
}

function getModelRouteBlockReason(data: SettingsData, model: string): string | null {
  const { policy, isConfigured, isAccessible } = modelRouting(data);
  const route = resolveRoute(
    model,
    data.config.routePriority ?? ["direct"],
    data.config.routeOverrides ?? {},
    isConfigured,
    isAccessible
  );
  if (!isModelAllowedByPolicy(policy, `${route.routeProvider}:${route.routeModelId}`))
    return "The selected model's route is blocked by server policy. Choose another model.";
  // resolveRoute has a direct fallback even when no route is configured. A visible
  // current selection must still pass the same availability/auth gates as the picker.
  if (
    !isModelAvailable(
      model,
      data.config.routePriority ?? ["direct"],
      data.config.routeOverrides ?? {},
      isConfigured,
      isAccessible
    )
  )
    return "No configured route can serve the selected model. Choose another model or configure a provider.";
  // Gate only the actual direct route; gateways supply their own credentials.
  if (route.routeProvider !== "openai") return null;
  const openai = data.providers.openai;
  // apiKeySet omits env/file credentials; keyless is not API-key authentication.
  const hasApiKey =
    openai?.apiKeySet === true ||
    openai?.apiKeySource === "config" ||
    openai?.apiKeySource === "file" ||
    openai?.apiKeySource === "env";
  const supported =
    hasApiKey && openai?.codexOauthSet
      ? true
      : !hasApiKey && openai?.codexOauthSet
        ? isCodexOauthAllowedModel(model, data.providers)
        : !isCodexOauthRequiredModel(model, data.providers);
  return supported
    ? null
    : "The selected model is unavailable with the configured OpenAI authentication. Choose another model or update credentials.";
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
  const isAuthoritativeModelAccessible = (provider: string, modelId: string) => {
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
    if (!isAuthoritativeModelAccessible(model.slice(0, colon), model.slice(colon + 1)))
      return false;
    // Keep Settings available during a global block; model restrictions follow the
    // resolved route, not the canonical identity (gateways own their credentials/policy).
    return (
      (data.policy?.status.state === "enforced"
        ? getModelBlockReason(data, model)
        : getModelRouteBlockReason(data, model)) === null
    );
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
