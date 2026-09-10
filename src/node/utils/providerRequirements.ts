/**
 * Provider credential resolution - single source of truth for provider authentication.
 *
 * Used by:
 * - providerService.ts: UI status (isConfigured flag for frontend)
 * - aiService.ts: runtime credential resolution before making API calls
 * - CLI bootstrap: buildProvidersFromEnv() to create initial providers.jsonc
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import { resolveConfigBaseUrl } from "@/common/utils/providers/baseUrl";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import type {
  BaseProviderConfig,
  BedrockProviderConfig,
  CoderProviderConfig,
  MuxGatewayProviderConfig,
  OpenAIProviderConfig,
} from "@/common/config/schemas/providersConfig";
import type { ProviderConfig, ProvidersConfig } from "@/node/config";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import { parseCoderOauthAuth } from "@/node/utils/coderOauthAuth";
import { normalizeCoderDeploymentUrl } from "@/common/constants/coderOAuth";

// ============================================================================
// Environment variable mappings - single source of truth
// ============================================================================

/** Env var names for each provider credential type (checked in order, first non-empty wins) */
export const PROVIDER_ENV_VARS: Partial<
  Record<
    ProviderName,
    {
      apiKey?: string[];
      baseUrl?: string[];
      organization?: string[];
      region?: string[];
    }
  >
> = {
  anthropic: {
    apiKey: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    baseUrl: ["ANTHROPIC_BASE_URL"],
  },
  openai: {
    apiKey: ["OPENAI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    organization: ["OPENAI_ORG_ID"],
  },
  google: {
    apiKey: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    baseUrl: ["GOOGLE_BASE_URL"],
  },
  xai: {
    apiKey: ["XAI_API_KEY"],
    baseUrl: ["XAI_BASE_URL"],
  },
  openrouter: {
    apiKey: ["OPENROUTER_API_KEY"],
  },
  deepseek: {
    apiKey: ["DEEPSEEK_API_KEY"],
  },
  moonshotai: {
    apiKey: ["MOONSHOT_API_KEY"],
  },
  zai: {
    apiKey: ["ZAI_API_KEY"],
  },
  "github-copilot": {
    apiKey: ["GITHUB_COPILOT_TOKEN"],
  },
  bedrock: {
    region: ["AWS_REGION", "AWS_DEFAULT_REGION"],
  },
};

/** Azure OpenAI env vars (special case: maps to "openai" provider) */
export const AZURE_OPENAI_ENV_VARS = {
  apiKey: "AZURE_OPENAI_API_KEY",
  endpoint: "AZURE_OPENAI_ENDPOINT",
  deployment: "AZURE_OPENAI_DEPLOYMENT",
  apiVersion: "AZURE_OPENAI_API_VERSION",
};

// Exported for sandbox env sanitization (scripts/sandboxUtils.ts), which needs
// the bedrock-specific bearer token name without duplicating it.
export const BEDROCK_AUTH_ENV_VARS = {
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  bearerToken: "AWS_BEARER_TOKEN_BEDROCK",
  profile: "AWS_PROFILE",
} as const;

/**
 * Secret-bearing provider env var names (API keys / auth tokens plus AWS
 * credential material). Consumed by repo-automation-off git executions
 * (gitNoHooksEnv) to blank provider secrets so repo-controlled processes
 * cannot exfiltrate them. Excludes non-secret vars (base URLs, org IDs,
 * regions), which unrelated tooling legitimately reads.
 */
export function providerSecretEnvVarNames(): string[] {
  const names = new Set<string>();
  for (const mapping of Object.values(PROVIDER_ENV_VARS)) {
    for (const key of mapping.apiKey ?? []) {
      names.add(key);
    }
  }
  names.add(AZURE_OPENAI_ENV_VARS.apiKey);
  names.add(BEDROCK_AUTH_ENV_VARS.accessKeyId);
  names.add(BEDROCK_AUTH_ENV_VARS.secretAccessKey);
  names.add(BEDROCK_AUTH_ENV_VARS.bearerToken);
  return [...names];
}

/** Resolve first non-empty env var from a list of candidates */
function resolveEnv(
  keys: string[] | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  for (const key of keys ?? []) {
    const val = env[key]?.trim();
    if (val) return val;
  }
  return undefined;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCredentialPair(accessKeyId: unknown, secretAccessKey: unknown): boolean {
  return hasNonEmptyString(accessKeyId) && hasNonEmptyString(secretAccessKey);
}

// ============================================================================
// Types
// ============================================================================

type ProviderSpecificCredentialFields = Partial<
  Pick<
    BedrockProviderConfig,
    "region" | "profile" | "bearerToken" | "accessKeyId" | "secretAccessKey"
  > &
    Pick<MuxGatewayProviderConfig, "couponCode" | "voucher"> &
    Pick<OpenAIProviderConfig, "organization"> &
    Pick<CoderProviderConfig, "deploymentUrl"> & {
      // Wider than the schema type: callers pass raw (unvalidated) config.
      coderOauth?: unknown;
    }
>;

// Raw provider config as read from disk — before validation.
// Omit enabled/models then re-add with looser types for defensive parsing.
export type ProviderConfigRaw = Omit<ProviderConfig, "enabled" | "models"> & {
  enabled?: unknown;
  models?: unknown[];
  baseUrl?: unknown;
  baseURL?: unknown;
} & ProviderSpecificCredentialFields;

/** Result of resolving provider credentials */
export interface ResolvedCredentials {
  isConfigured: boolean;
  /** What's missing, if not configured (for error messages) */
  missingRequirement?: "api_key" | "region" | "coupon_code" | "coder_login";

  // Resolved credential values - aiService uses these directly
  apiKey?: string; // anthropic, openai, etc.
  region?: string; // bedrock
  couponCode?: string; // mux-gateway
  deploymentUrl?: string; // coder
  baseUrl?: string; // runtime value from config or env when API-key auth is active
  baseUrlResolved?: string; // display-only metadata, including when API key auth is missing
  organization?: string; // openai
  apiKeySource?: "config" | "file" | "env";
  baseUrlSource?: "config" | "env";
}

/** Legacy alias for backward compatibility */
export type ProviderConfigCheck = Pick<
  ResolvedCredentials,
  | "isConfigured"
  | "missingRequirement"
  | "apiKeySource"
  | "baseUrl"
  | "baseUrlResolved"
  | "baseUrlSource"
>;

export type ProviderRequirementError =
  | { code: "missing_base_url"; providerId: string }
  | {
      code: "api_key_file_unreadable";
      path: string;
      reason: "missing" | "not_file" | "too_large" | "empty" | "read_failed";
    };

export type CustomProviderCredentialSource = "inline" | "file" | "none";

export type ResolvedCustomProviderCredentials =
  | {
      ok: true;
      apiKey?: string;
      baseURL: string;
      resolvedFrom: CustomProviderCredentialSource;
    }
  | {
      ok: false;
      apiKey?: string;
      baseURL?: string;
      resolvedFrom: CustomProviderCredentialSource;
      error: ProviderRequirementError;
    };

type ResolvedApiKeyCandidate =
  | { kind: "resolved"; apiKey: string; source: "config" | "file" | "env" }
  | { kind: "missing" }
  | { kind: "error"; error: ProviderRequirementError };

type ApiKeyFileResolution =
  | { kind: "not_configured" }
  | { kind: "resolved"; apiKey: string }
  | { kind: "error"; error: ProviderRequirementError };

function expandHomePath(filePath: string): string {
  return filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

function resolveBaseUrl(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined>
): Pick<ResolvedCredentials, "baseUrlResolved" | "baseUrlSource"> {
  const configBaseUrl = resolveConfigBaseUrl(config);
  if (configBaseUrl) {
    return { baseUrlResolved: configBaseUrl, baseUrlSource: "config" };
  }

  const envBaseUrl = resolveEnv(PROVIDER_ENV_VARS[provider]?.baseUrl, env);
  return envBaseUrl ? { baseUrlResolved: envBaseUrl, baseUrlSource: "env" } : {};
}

/**
 * Read an API key from a file path. Supports ~ for home directory.
 */
function resolveApiKeyFileDetailed(filePath: unknown): ApiKeyFileResolution {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return { kind: "not_configured" };
  }

  const expanded = expandHomePath(filePath);

  try {
    // Guard against non-regular files (FIFOs, devices) that could block indefinitely.
    const stat = statSync(expanded);
    if (!stat.isFile()) {
      return {
        kind: "error",
        error: { code: "api_key_file_unreadable", path: filePath, reason: "not_file" },
      };
    }
    if (stat.size > 65536) {
      return {
        kind: "error",
        error: { code: "api_key_file_unreadable", path: filePath, reason: "too_large" },
      };
    }

    const content = readFileSync(expanded, "utf-8").trim();
    if (!content) {
      return {
        kind: "error",
        error: { code: "api_key_file_unreadable", path: filePath, reason: "empty" },
      };
    }

    return { kind: "resolved", apiKey: content };
  } catch (error) {
    const reason =
      typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
        ? "missing"
        : "read_failed";
    return {
      kind: "error",
      error: { code: "api_key_file_unreadable", path: filePath, reason },
    };
  }
}

/**
 * Legacy 1Password `op://` references. The integration was removed; stored
 * references are preserved on disk for downgrade compatibility but are
 * unusable at runtime, so credential resolution and UI status must treat
 * them as absent (falling back to key files / env vars) instead of sending
 * the raw reference to a provider as a bearer token.
 */
export function isLegacyOpApiKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("op://");
}

function resolveApiKeyCandidate(
  config: { apiKey?: unknown; apiKeyFile?: unknown },
  options: {
    envApiKeys?: string[];
    env?: Record<string, string | undefined>;
    fileErrors: "ignore" | "return";
  }
): ResolvedApiKeyCandidate {
  const configKey =
    typeof config.apiKey === "string" &&
    config.apiKey.trim().length > 0 &&
    !isLegacyOpApiKey(config.apiKey)
      ? config.apiKey
      : null;
  if (configKey) {
    return { kind: "resolved", apiKey: configKey, source: "config" };
  }

  const fileResult = resolveApiKeyFileDetailed(config.apiKeyFile);
  if (fileResult.kind === "resolved") {
    return { kind: "resolved", apiKey: fileResult.apiKey, source: "file" };
  }
  if (fileResult.kind === "error" && options.fileErrors === "return") {
    return { kind: "error", error: fileResult.error };
  }

  const envKey = resolveEnv(options.envApiKeys, options.env ?? {});
  if (envKey) {
    return { kind: "resolved", apiKey: envKey, source: "env" };
  }

  return { kind: "missing" };
}

// ============================================================================
// Credential resolution
// ============================================================================

/**
 * Resolve provider credentials from config and environment.
 * Returns both configuration status AND resolved credential values.
 *
 * @param provider - Provider name
 * @param config - Raw config from providers.jsonc (or empty object)
 * @param env - Environment variables (defaults to process.env)
 */
export function resolveProviderCredentials(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): ResolvedCredentials {
  // Bedrock: region required (credentials via AWS SDK chain)
  if (provider === "bedrock") {
    const configRegion = typeof config.region === "string" && config.region ? config.region : null;
    const region = configRegion ?? resolveEnv(PROVIDER_ENV_VARS.bedrock?.region, env);
    return region
      ? { isConfigured: true, region }
      : { isConfigured: false, missingRequirement: "region" };
  }

  // Xum Gateway: coupon code required (no env var support)
  if (provider === "mux-gateway") {
    const couponCode = config.couponCode ?? config.voucher;
    return couponCode
      ? { isConfigured: true, couponCode }
      : { isConfigured: false, missingRequirement: "coupon_code" };
  }

  // Coder: deployment URL + OAuth tokens from "Login with Coder" required
  if (provider === "coder") {
    const deploymentUrl =
      typeof config.deploymentUrl === "string"
        ? normalizeCoderDeploymentUrl(config.deploymentUrl)
        : null;
    // Tokens are issuer-bound: an OAuth blob only counts when it was minted by
    // the currently configured deployment, so changing the URL never routes an
    // old deployment's bearer token to the new host.
    const oauth = parseCoderOauthAuth(config.coderOauth);
    const hasMatchingOauth = oauth !== null && oauth.deploymentUrl === deploymentUrl;
    return deploymentUrl && hasMatchingOauth
      ? { isConfigured: true, deploymentUrl }
      : { isConfigured: false, missingRequirement: "coder_login" };
  }

  // Keyless providers (e.g., ollama): require explicit opt-in via baseUrl/baseURL or models
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def.requiresApiKey) {
    const hasConfiguredModels = (config.models?.length ?? 0) > 0;
    const hasExplicitConfig = Boolean(resolveConfigBaseUrl(config) ?? hasConfiguredModels);
    return { isConfigured: hasExplicitConfig };
  }

  // Standard API key providers: check config first, then apiKeyFile, then env vars
  const envMapping = PROVIDER_ENV_VARS[provider];
  const apiKeyResult = resolveApiKeyCandidate(
    { apiKey: config.apiKey, apiKeyFile: config.apiKeyFile },
    {
      envApiKeys: envMapping?.apiKey,
      env,
      fileErrors: "ignore",
    }
  );
  const baseUrlInfo = resolveBaseUrl(provider, config, env);
  // Config organization takes precedence over env var (user's explicit choice)
  const configOrganization =
    typeof config.organization === "string" && config.organization
      ? config.organization
      : undefined;
  const organization = configOrganization ?? resolveEnv(envMapping?.organization, env);

  if (apiKeyResult.kind === "resolved") {
    const configuredBaseUrlInfo = baseUrlInfo.baseUrlResolved
      ? { ...baseUrlInfo, baseUrl: baseUrlInfo.baseUrlResolved }
      : baseUrlInfo;
    return {
      isConfigured: true,
      apiKey: apiKeyResult.apiKey,
      organization,
      apiKeySource: apiKeyResult.source,
      ...configuredBaseUrlInfo,
    };
  }

  return { isConfigured: false, missingRequirement: "api_key", ...baseUrlInfo };
}

function customCredentialSourceFromApiKeySource(
  source: Extract<ResolvedApiKeyCandidate, { kind: "resolved" }>["source"]
): Exclude<CustomProviderCredentialSource, "op" | "none"> {
  return source === "file" ? "file" : "inline";
}

export function resolveCustomProviderCredentials(
  providerId: string,
  providerConfig: BaseProviderConfig
): ResolvedCustomProviderCredentials {
  const baseURL = resolveConfigBaseUrl(providerConfig);
  if (!baseURL) {
    return {
      ok: false,
      resolvedFrom: "none",
      error: { code: "missing_base_url", providerId },
    };
  }

  const apiKeyResult = resolveApiKeyCandidate(providerConfig, {
    fileErrors: "return",
  });

  if (apiKeyResult.kind === "error") {
    return {
      ok: false,
      baseURL,
      resolvedFrom: "file",
      error: apiKeyResult.error,
    };
  }

  if (apiKeyResult.kind === "missing") {
    return { ok: true, baseURL, resolvedFrom: "none" };
  }

  return {
    ok: true,
    apiKey: apiKeyResult.apiKey,
    baseURL,
    resolvedFrom: customCredentialSourceFromApiKeySource(apiKeyResult.source),
  };
}

/**
 * Auto-route admission is stricter than general configured-state checks for Bedrock.
 * A region alone is enough to show Bedrock as configured in the UI, but routePriority
 * should only auto-admit it when we can also observe at least one auth signal.
 */
export function isProviderAutoRouteEligible(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): boolean {
  // Keep auto-route admission aligned with runtime availability: saved credentials alone
  // must not reinsert a provider the user has explicitly disabled.
  if (isProviderDisabledInConfig(config)) {
    return false;
  }

  const credentials = resolveProviderCredentials(provider, config, env);
  if (!credentials.isConfigured) {
    return false;
  }

  if (provider !== "bedrock") {
    return true;
  }

  return (
    hasCredentialPair(config.accessKeyId, config.secretAccessKey) ||
    hasNonEmptyString(config.bearerToken) ||
    hasNonEmptyString(config.profile) ||
    hasCredentialPair(
      env[BEDROCK_AUTH_ENV_VARS.accessKeyId],
      env[BEDROCK_AUTH_ENV_VARS.secretAccessKey]
    ) ||
    hasNonEmptyString(env[BEDROCK_AUTH_ENV_VARS.bearerToken]) ||
    hasNonEmptyString(env[BEDROCK_AUTH_ENV_VARS.profile])
  );
}

/**
 * Check if a provider is configured (has necessary credentials).
 * Convenience wrapper around resolveProviderCredentials for UI status checks.
 */
export function checkProviderConfigured(
  provider: ProviderName,
  config: ProviderConfigRaw,
  env: Record<string, string | undefined> = process.env
): ProviderConfigCheck {
  const {
    isConfigured,
    missingRequirement,
    apiKeySource,
    baseUrl,
    baseUrlResolved,
    baseUrlSource,
  } = resolveProviderCredentials(provider, config, env);
  return {
    isConfigured,
    missingRequirement,
    apiKeySource,
    baseUrl,
    baseUrlResolved,
    baseUrlSource,
  };
}

// ============================================================================
// Bootstrap: build providers config from environment variables
// ============================================================================

/**
 * Build a ProvidersConfig from environment variables.
 * Used during CLI bootstrap when no providers.jsonc exists.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns ProvidersConfig with all providers that have credentials in env
 */
export function buildProvidersFromEnv(
  env: Record<string, string | undefined> = process.env
): ProvidersConfig {
  const providers: ProvidersConfig = {};

  // Check each provider that has env var mappings
  for (const provider of Object.keys(PROVIDER_ENV_VARS) as ProviderName[]) {
    // Skip bedrock - it uses AWS credential chain, not simple API key
    if (provider === "bedrock") continue;

    const creds = resolveProviderCredentials(provider, {}, env);
    if (creds.isConfigured && creds.apiKey) {
      const entry: ProviderConfig = { apiKey: creds.apiKey };
      if (creds.baseUrl) entry.baseUrl = creds.baseUrl;
      if (creds.organization) entry.organization = creds.organization;
      providers[provider] = entry;
    }
  }

  // Azure OpenAI special case: maps to "openai" provider if not already set
  if (!providers.openai) {
    const azureKey = env[AZURE_OPENAI_ENV_VARS.apiKey]?.trim();
    const azureEndpoint = env[AZURE_OPENAI_ENV_VARS.endpoint]?.trim();

    if (azureKey && azureEndpoint) {
      const entry: ProviderConfig = {
        apiKey: azureKey,
        baseUrl: azureEndpoint,
      };

      const deployment = env[AZURE_OPENAI_ENV_VARS.deployment]?.trim();
      if (deployment) entry.defaultModel = deployment;

      const apiVersion = env[AZURE_OPENAI_ENV_VARS.apiVersion]?.trim();
      if (apiVersion) entry.apiVersion = apiVersion;

      providers.openai = entry;
    }
  }

  return providers;
}

/**
 * Check whether any provider is configured well enough for the CLI to start.
 *
 * This intentionally mirrors runtime/provider status checks instead of only
 * looking for API keys so keyless providers (e.g. Ollama) and OpenAI Codex
 * OAuth-only setups are treated as valid.
 */
export function hasAnyConfiguredProvider(providers: ProvidersConfig | null | undefined): boolean {
  if (!providers) return false;

  for (const [providerKey, rawConfig] of Object.entries(providers)) {
    if (!rawConfig || typeof rawConfig !== "object") {
      continue;
    }

    // OpenAI Codex OAuth is a valid credential path even without apiKey.
    if (
      providerKey === "openai" &&
      parseCodexOauthAuth((rawConfig as { codexOauth?: unknown }).codexOauth) !== null
    ) {
      return true;
    }

    if (!(providerKey in PROVIDER_DEFINITIONS)) {
      if (
        isCustomProviderConfig(rawConfig) &&
        !isProviderDisabledInConfig(rawConfig) &&
        resolveConfigBaseUrl(rawConfig) !== undefined
      ) {
        return true;
      }

      // Be permissive for unknown providers written by future versions.
      const apiKey = (rawConfig as { apiKey?: unknown }).apiKey;
      if (typeof apiKey === "string" && apiKey.trim().length > 0) {
        return true;
      }
      continue;
    }

    if (
      checkProviderConfigured(providerKey as ProviderName, rawConfig as ProviderConfigRaw)
        .isConfigured
    ) {
      return true;
    }
  }

  return false;
}
