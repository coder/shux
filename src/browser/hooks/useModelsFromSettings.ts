import { useCallback, useMemo } from "react";
import { readPersistedString, usePersistedState } from "./usePersistedState";
import { DEFAULT_HIDDEN_MODELS, KNOWN_MODELS } from "@/common/constants/knownModels";
import { isCodexOauthAllowedModel, isCodexOauthRequiredModel } from "@/common/constants/codexOAuth";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useProvidersConfig } from "./useProvidersConfig";
import { useRouting } from "./useRouting";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { isValidProvider } from "@/common/constants/providers";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { isGatewayModelAccessibleForUi, isModelAllowedByPolicy } from "@/browser/utils/policyUi";
import {
  getExplicitGatewayPrefix,
  normalizeSelectedModel,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import { isModelAvailable, resolveRoute } from "@/common/routing";
import type { EffectivePolicy, ProviderModelEntry, ProvidersConfigMap } from "@/common/orpc/types";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";

import { isProviderModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";

const BUILT_IN_MODELS: string[] = Object.values(KNOWN_MODELS).map((m) => m.id);
const BUILT_IN_MODEL_SET = new Set<string>(BUILT_IN_MODELS);

function getCustomModels(config: ProvidersConfigMap | null): string[] {
  if (!config) return [];
  const models: string[] = [];
  for (const [provider, info] of Object.entries(config)) {
    // Skip mux-gateway - those models are accessed via the cloud toggle, not listed separately
    if (provider === "mux-gateway") continue;
    // Keep github-copilot's persisted catalog for authoritative model gating, not direct selector entries.
    if (provider === "github-copilot") continue;
    // Only surface custom models from enabled providers
    if (!info.isEnabled) continue;
    if (!info.models) continue;
    for (const modelEntry of info.models) {
      const modelId = getProviderModelEntryId(modelEntry);
      models.push(`${provider}:${modelId}`);
    }
  }
  return models;
}

function getAllCustomModels(config: ProvidersConfigMap | null): string[] {
  if (!config) return [];

  const models: string[] = [];
  for (const [provider, info] of Object.entries(config)) {
    // Skip mux-gateway - those models are accessed via the cloud toggle, not listed separately
    if (provider === "mux-gateway") continue;
    // Keep github-copilot's persisted catalog for authoritative model gating, not direct selector entries.
    if (provider === "github-copilot") continue;
    if (!info.models) continue;

    for (const modelEntry of info.models) {
      const modelId = getProviderModelEntryId(modelEntry);
      models.push(`${provider}:${modelId}`);
    }
  }

  return models;
}

function isSupportedSettingsProvider(
  provider: string,
  providerConfig: ProvidersConfigMap
): boolean {
  if (isValidProvider(provider)) {
    return true;
  }

  const info = providerConfig[provider];
  // Custom providers accept arbitrary model IDs, but unknown strings
  // should not create provider settings entries.
  return info?.isCustom === true && isCustomProviderConfig(info);
}

export function filterHiddenModels(models: string[], hiddenModels: string[]): string[] {
  if (hiddenModels.length === 0) {
    return models;
  }

  const hidden = new Set(hiddenModels);
  return models.filter((m) => !hidden.has(m));
}
function dedupeKeepFirst(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export function getSuggestedModels(config: ProvidersConfigMap | null): string[] {
  const customModels = getCustomModels(config);
  return dedupeKeepFirst([...customModels, ...BUILT_IN_MODELS]);
}

/**
 * The OpenAI auth gates in this hook apply to the direct route only. A gateway
 * route (mux-gateway, openrouter, ...) supplies its own credentials, so the
 * user's OpenAI auth state must not hide, or warn about, models the gateway
 * serves. For a model with no active route, resolveRoute falls back to direct,
 * which keeps the gate in place.
 */
function resolvesToDirectOpenAI(
  modelId: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible: (gateway: string, modelId: string) => boolean
): boolean {
  return (
    resolveRoute(modelId, routePriority, routeOverrides, isConfigured, isGatewayModelAccessible)
      .routeProvider === "openai"
  );
}

/**
 * Policy check on the identity the backend enforces. createModel resolves the
 * route first and then checks `isModelAllowed(routeProvider, routeModelId)`,
 * so a policy that lists only a gateway permits a canonical model whose active
 * route is that gateway. A model with no active route resolves to direct and is
 * checked under its canonical identity.
 */
function isModelAllowedByPolicyOnActiveRoute(
  policy: EffectivePolicy | null,
  modelId: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible: (gateway: string, modelId: string) => boolean
): boolean {
  const route = resolveRoute(
    modelId,
    routePriority,
    routeOverrides,
    isConfigured,
    isGatewayModelAccessible
  );
  return isModelAllowedByPolicy(policy, `${route.routeProvider}:${route.routeModelId}`);
}

export function getDefaultModel(): string {
  const fallback = WORKSPACE_DEFAULTS.model;
  const persisted = readPersistedString(DEFAULT_MODEL_KEY);
  if (!persisted) return fallback;

  const selectedModel = normalizeSelectedModel(persisted);
  return selectedModel || fallback;
}

/**
 * Source-of-truth for selectable models.
 *
 * The model selector should be driven by Settings (built-in + custom).
 * When a model is selected that isn't built-in, we persist it into Settings so it becomes
 * discoverable/manageable there.
 */
export function useModelsFromSettings() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const { api } = useAPI();

  const persistModelPrefs = useCallback(
    (patch: { defaultModel?: string; hiddenModels?: string[] }) => {
      if (!api?.config?.updateModelPreferences) {
        return;
      }

      api.config.updateModelPreferences(patch).catch(() => {
        // Best-effort only; startup seeding will heal the cache next time.
      });
    },
    [api]
  );
  const { config, refresh } = useProvidersConfig();
  const { routePriority, routeOverrides } = useRouting();

  const [defaultModel, setDefaultModel] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );

  const setDefaultModelAndPersist = useCallback(
    (next: string | ((prev: string) => string)) => {
      setDefaultModel((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        const selectedModel = normalizeSelectedModel(resolved);
        const previousSelectedModel = normalizeSelectedModel(prev);

        if (selectedModel !== previousSelectedModel) {
          persistModelPrefs({ defaultModel: selectedModel });
        }

        return selectedModel;
      });
    },
    [persistModelPrefs, setDefaultModel]
  );

  const [hiddenModels, setHiddenModels] = usePersistedState<string[]>(
    HIDDEN_MODELS_KEY,
    DEFAULT_HIDDEN_MODELS,
    {
      listener: true,
    }
  );

  const isConfigured = useCallback(
    (provider: string) =>
      config?.[provider]?.isConfigured === true && config?.[provider]?.isEnabled !== false,
    [config]
  );

  const isGatewayModelAccessible = useCallback(
    (gateway: string, modelId: string) =>
      isGatewayModelAccessibleForUi(effectivePolicy, config, gateway, modelId),
    [config, effectivePolicy]
  );

  const isAuthoritativeProviderModelAccessible = useCallback(
    (modelString: string) => {
      const colonIndex = modelString.indexOf(":");
      if (colonIndex <= 0 || colonIndex >= modelString.length - 1) {
        return true;
      }

      const provider = modelString.slice(0, colonIndex);
      const providerModelId = modelString.slice(colonIndex + 1);
      return isProviderModelAccessibleFromAuthoritativeCatalog(
        provider,
        providerModelId,
        config?.[provider]?.models,
        config?.[provider]?.discoveredModels,
        config?.[provider]?.removedModels
      );
    },
    [config]
  );

  const customModels = useMemo(() => {
    const next = filterHiddenModels(getCustomModels(config), hiddenModels).filter(
      isAuthoritativeProviderModelAccessible
    );
    return effectivePolicy ? next.filter((m) => isModelAllowedByPolicy(effectivePolicy, m)) : next;
  }, [config, hiddenModels, effectivePolicy, isAuthoritativeProviderModelAccessible]);

  const openaiApiKeySet = config === null ? null : config.openai?.apiKeySet === true;
  const codexOauthSet = config === null ? null : config.openai?.codexOauthSet === true;

  const isAllowedByPolicyOnActiveRoute = (modelId: string) =>
    isModelAllowedByPolicyOnActiveRoute(
      effectivePolicy,
      modelId,
      routePriority,
      routeOverrides,
      isConfigured,
      isGatewayModelAccessible
    );

  const requiresCodexOauth = (modelId: string) =>
    isCodexOauthRequiredModel(modelId, config) &&
    resolvesToDirectOpenAI(
      modelId,
      routePriority,
      routeOverrides,
      isConfigured,
      isGatewayModelAccessible
    );

  const providerHiddenModels = useMemo(() => {
    if (config == null) {
      return [];
    }

    const allModels = dedupeKeepFirst([...getAllCustomModels(config), ...BUILT_IN_MODELS]);
    const userHiddenSet = new Set(hiddenModels);

    const hasOpenaiApiKey = openaiApiKeySet === true;
    const hasCodexOauth = codexOauthSet === true;

    const next = allModels.filter((modelId) => {
      if (userHiddenSet.has(modelId)) {
        return false;
      }

      if (!isAuthoritativeProviderModelAccessible(modelId)) {
        return true;
      }

      if (
        isModelAvailable(
          modelId,
          routePriority,
          routeOverrides,
          isConfigured,
          isGatewayModelAccessible
        )
      ) {
        return false;
      }

      // Exclude OpenAI models that would also be filtered by OAuth gating.
      // Surfacing them in the hidden bucket would let users select models that
      // fail at send time (oauth_not_connected / api_key_not_found).
      if (modelId.startsWith("openai:")) {
        if (!hasOpenaiApiKey && hasCodexOauth) {
          return isCodexOauthAllowedModel(modelId, config);
        }
        if (hasOpenaiApiKey && hasCodexOauth) {
          return true;
        }
        return !isCodexOauthRequiredModel(modelId, config);
      }

      return true;
    });

    return effectivePolicy ? next.filter((m) => isModelAllowedByPolicy(effectivePolicy, m)) : next;
  }, [
    config,
    hiddenModels,
    effectivePolicy,
    isConfigured,
    isGatewayModelAccessible,
    isAuthoritativeProviderModelAccessible,
    routePriority,
    routeOverrides,
    openaiApiKeySet,
    codexOauthSet,
  ]);

  const hiddenModelsForSelector = useMemo(
    () => dedupeKeepFirst([...hiddenModels, ...providerHiddenModels]),
    [hiddenModels, providerHiddenModels]
  );

  const models = useMemo(() => {
    const suggested = filterHiddenModels(getSuggestedModels(config), hiddenModels);

    // Hide models that are unavailable from both direct and gateway routes.
    // Keep all models visible while provider config is still loading to avoid UI flicker.
    const providerFiltered =
      config == null
        ? suggested
        : suggested.filter(
            (modelId) =>
              isAuthoritativeProviderModelAccessible(modelId) &&
              isModelAvailable(
                modelId,
                routePriority,
                routeOverrides,
                isConfigured,
                isGatewayModelAccessible
              )
          );

    const allowedByPolicy = (modelId: string) =>
      isModelAllowedByPolicyOnActiveRoute(
        effectivePolicy,
        modelId,
        routePriority,
        routeOverrides,
        isConfigured,
        isGatewayModelAccessible
      );
    if (config == null) {
      return effectivePolicy ? providerFiltered.filter(allowedByPolicy) : providerFiltered;
    }
    const hasOpenaiApiKey = openaiApiKeySet === true;
    const hasCodexOauth = codexOauthSet === true;

    // OpenAI model gating (direct route only; see resolvesToDirectOpenAI):
    // - API key + OAuth: allow everything.
    // - API key only: hide models that require OAuth.
    // - OAuth only: show only models routable via OAuth.
    // - Neither: hide models that require OAuth (status quo).
    // providerFiltered already guarantees an active route, so the resolved
    // route is the real one rather than the direct fallback.
    const next = providerFiltered.filter((modelId) => {
      if (!modelId.startsWith("openai:")) {
        return true;
      }

      if (
        !resolvesToDirectOpenAI(
          modelId,
          routePriority,
          routeOverrides,
          isConfigured,
          isGatewayModelAccessible
        )
      ) {
        return true;
      }

      if (hasOpenaiApiKey && hasCodexOauth) {
        return true;
      }

      if (!hasOpenaiApiKey && hasCodexOauth) {
        return isCodexOauthAllowedModel(modelId, config);
      }

      return !isCodexOauthRequiredModel(modelId, config);
    });

    return effectivePolicy ? next.filter(allowedByPolicy) : next;
  }, [
    config,
    hiddenModels,
    effectivePolicy,
    isConfigured,
    isGatewayModelAccessible,
    isAuthoritativeProviderModelAccessible,
    routePriority,
    routeOverrides,
    openaiApiKeySet,
    codexOauthSet,
  ]);

  /**
   * If a model is selected that isn't built-in, persist it as a provider custom model.
   */
  const ensureModelInSettings = useCallback(
    (modelString: string) => {
      if (!api) return;

      const selectedModel = normalizeSelectedModel(modelString);
      if (!selectedModel) return;

      const canonicalModel = normalizeToCanonical(selectedModel).trim();
      if (BUILT_IN_MODEL_SET.has(canonicalModel)) return;
      if (!isModelAllowedByPolicy(effectivePolicy, canonicalModel)) {
        return;
      }
      if (getExplicitGatewayPrefix(selectedModel)) return;

      const colonIndex = selectedModel.indexOf(":");
      if (colonIndex === -1) return;

      const provider = selectedModel.slice(0, colonIndex);
      const modelId = selectedModel.slice(colonIndex + 1);
      if (!provider || !modelId) return;

      const run = async () => {
        const providerConfig = config ?? (await api.providers.getConfig());
        if (!isSupportedSettingsProvider(provider, providerConfig)) return;

        const existingModels: ProviderModelEntry[] = providerConfig[provider]?.models ?? [];
        if (existingModels.some((entry) => getProviderModelEntryId(entry) === modelId)) return;

        await api.providers.setModels({ provider, models: [...existingModels, modelId] });
        await refresh();
      };

      run().catch(() => {
        // Ignore failures - user can still manage models via Settings
      });
    },
    [api, config, refresh, effectivePolicy]
  );

  // Hidden-model preferences use the gateway-preserving identity: model lists
  // surface explicit gateway entries raw (e.g. coder:openai/<model>), and
  // filterHiddenModels/ModelsSection compare exact strings. Name-only
  // canonicalization would persist openai:<model> instead — leaving the
  // gateway entry visible while hiding the distinct direct model.
  const hideModel = useCallback(
    (modelString: string) => {
      const canonical = normalizeSelectedModel(modelString).trim();
      if (!canonical) {
        return;
      }

      setHiddenModels((prev) => {
        if (prev.includes(canonical)) {
          return prev;
        }

        const nextHiddenModels = [...prev, canonical];
        persistModelPrefs({ hiddenModels: nextHiddenModels });
        return nextHiddenModels;
      });
    },
    [persistModelPrefs, setHiddenModels]
  );

  const unhideModel = useCallback(
    (modelString: string) => {
      const canonical = normalizeSelectedModel(modelString).trim();
      if (!canonical) {
        return;
      }

      setHiddenModels((prev) => {
        const nextHiddenModels = prev.filter((m) => m !== canonical);
        if (nextHiddenModels.length === prev.length) {
          return prev;
        }

        persistModelPrefs({ hiddenModels: nextHiddenModels });
        return nextHiddenModels;
      });
    },
    [persistModelPrefs, setHiddenModels]
  );

  return {
    ensureModelInSettings,
    models,
    customModels,
    hiddenModels,
    hiddenModelsForSelector,
    hideModel,
    unhideModel,
    defaultModel,
    setDefaultModel: setDefaultModelAndPersist,
    openaiApiKeySet,
    codexOauthSet,
    requiresCodexOauth,
    isAllowedByPolicyOnActiveRoute,
  };
}
