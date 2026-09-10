import { SUPPORTED_PROVIDERS, type ProviderName } from "@/common/constants/providers";
import { RUNTIME_MODE, type ParsedRuntime, type RuntimeMode } from "@/common/types/runtime";
import type { EffectivePolicy, PolicyRuntimeId, ProvidersConfigMap } from "@/common/orpc/types";
import {
  getCustomProviderIds,
  type ProvidersConfigWithProviderType,
} from "@/common/utils/providers/customProviders";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";

/**
 * Parse a model string into provider and modelId.
 * Returns null if the string doesn't match the expected "provider:modelId" format.
 */
export function parseModelString(
  modelString: string
): { provider: string; modelId: string } | null {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex <= 0 || colonIndex === modelString.length - 1) {
    return null;
  }

  return {
    provider: modelString.slice(0, colonIndex),
    modelId: modelString.slice(colonIndex + 1),
  };
}

/**
 * Check if a model is allowed by the effective policy.
 * Returns true if no policy is set, or if the model's provider is in the allowlist
 * and either no model restrictions exist or the model is in the allowed list.
 */
export function isModelAllowedByPolicy(
  policy: EffectivePolicy | null,
  modelString: string
): boolean {
  const providerAccess = policy?.providerAccess;
  if (providerAccess == null) {
    return true;
  }

  const parsed = parseModelString(modelString);
  if (!parsed) {
    return true;
  }

  const providerPolicy = providerAccess.find((p) => p.id === parsed.provider);
  if (!providerPolicy) {
    return false;
  }

  const allowedModels = providerPolicy.allowedModels ?? null;
  if (allowedModels === null) {
    return true;
  }

  return allowedModels.includes(parsed.modelId);
}

/**
 * Can this gateway serve the model? Mirrors the backend's routing-time check
 * (createGatewayModelAccessibilityChecker): the gateway's authoritative catalog
 * must list the model and the policy must allow the gateway model. A gateway
 * model that fails either check falls back to other routes on the backend, so
 * UI route resolution must not count it as a route.
 */
export function isGatewayModelAccessibleForUi(
  policy: EffectivePolicy | null,
  providersConfig: ProvidersConfigMap | null,
  gateway: string,
  modelId: string
): boolean {
  return (
    isModelAllowedByPolicy(policy, `${gateway}:${modelId}`) &&
    isGatewayModelAccessibleFromAuthoritativeCatalog(
      gateway,
      modelId,
      providersConfig?.[gateway]?.models,
      providersConfig?.[gateway]?.discoveredModels,
      providersConfig?.[gateway]?.removedModels
    )
  );
}

export function getAllowedProvidersForUi(policy: EffectivePolicy | null): ProviderName[];
export function getAllowedProvidersForUi(
  policy: EffectivePolicy | null,
  providersConfig: ProvidersConfigWithProviderType | null | undefined
): string[];
export function getAllowedProvidersForUi(
  policy: EffectivePolicy | null,
  providersConfig?: ProvidersConfigWithProviderType | null
): string[] {
  const customProviders = providersConfig ? getCustomProviderIds(providersConfig) : [];
  const access = policy?.providerAccess;
  if (access == null) {
    return Array.from(new Set([...SUPPORTED_PROVIDERS, ...customProviders]));
  }

  const allowed = new Set(access.map((p) => p.id));
  return Array.from(
    new Set([
      ...SUPPORTED_PROVIDERS.filter((p) => allowed.has(p)),
      ...customProviders.filter((p) => allowed.has(p)),
    ])
  );
}

export function getPolicyRuntimeIdFromParsedRuntime(runtime: ParsedRuntime): PolicyRuntimeId {
  if (runtime.mode === RUNTIME_MODE.SSH) {
    return runtime.coder ? "ssh+coder" : "ssh";
  }

  return runtime.mode;
}

export function isParsedRuntimeAllowedByPolicy(
  policy: EffectivePolicy | null,
  runtime: ParsedRuntime
): boolean {
  const allowedRuntimes = policy?.runtimes;
  if (allowedRuntimes == null) {
    return true;
  }

  return allowedRuntimes.includes(getPolicyRuntimeIdFromParsedRuntime(runtime));
}

export function getAllowedRuntimeModesForUi(policy: EffectivePolicy | null): {
  /** null means "allow all modes" */
  allowedModes: RuntimeMode[] | null;
  /** true when policy allows plain host SSH */
  allowSshHost: boolean;
  /** true when policy allows SSH backed by a Coder workspace */
  allowSshCoder: boolean;
} {
  const allowedRuntimes = policy?.runtimes;
  if (allowedRuntimes == null) {
    return { allowedModes: null, allowSshHost: true, allowSshCoder: true };
  }

  const allowSshHost = allowedRuntimes.includes("ssh");
  const allowSshCoder = allowedRuntimes.includes("ssh+coder");

  const allowedModes: RuntimeMode[] = [];
  if (allowedRuntimes.includes("local")) {
    allowedModes.push(RUNTIME_MODE.LOCAL);
  }
  if (allowedRuntimes.includes("worktree")) {
    allowedModes.push(RUNTIME_MODE.WORKTREE);
  }
  if (allowSshHost || allowSshCoder) {
    allowedModes.push(RUNTIME_MODE.SSH);
  }
  if (allowedRuntimes.includes("docker")) {
    allowedModes.push(RUNTIME_MODE.DOCKER);
  }
  if (allowedRuntimes.includes("devcontainer")) {
    allowedModes.push(RUNTIME_MODE.DEVCONTAINER);
  }

  return { allowedModes, allowSshHost, allowSshCoder };
}
