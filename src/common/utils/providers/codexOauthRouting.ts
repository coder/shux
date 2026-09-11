/**
 * Browser-safe mirror of providerModelFactory's Codex OAuth routing decision.
 *
 * The factory decides `shouldRouteThroughCodexOauth` from parsed stored tokens
 * (node-only); this mirror detects the same outcome from the providers config
 * shapes visible to common/browser code (API config map with `codexOauthSet`,
 * or raw providers.jsonc with stored token objects). Used by compaction
 * context-limit capping and pro-mode availability, both of which must match
 * where requests actually route.
 */

import { isCodexOauthAllowedModel, isCodexOauthRequiredModel } from "@/common/constants/codexOAuth";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";

/** Request-level inputs the stored providers config cannot carry. */
export interface CodexOauthRoutingOptions {
  /**
   * Request-level OpenAI wire format (muxProviderOptions.openai.wireFormat).
   * The stored `openai.wireFormat` wins when set, matching providerModelFactory.
   */
  openaiWireFormat?: OpenAIWireFormat | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasCodexOauthTokens(config: unknown): boolean {
  const record = asRecord(config);
  if (!record) {
    return false;
  }

  if (record.codexOauthSet === true) {
    return true;
  }

  // Backend compaction can receive raw providers.jsonc config in older tests/fallback paths.
  // Detect the stored token shape without importing node-only OAuth parsing into common code.
  const oauth = asRecord(record.codexOauth);
  return (
    oauth?.type === "oauth" &&
    hasNonEmptyString(oauth.access) &&
    hasNonEmptyString(oauth.refresh) &&
    typeof oauth.expires === "number" &&
    Number.isFinite(oauth.expires)
  );
}

export function hasOpenAIApiKey(config: unknown): boolean {
  const record = asRecord(config);
  if (!record) {
    return false;
  }

  const apiKeySource = record.apiKeySource;
  if (apiKeySource === "config" || apiKeySource === "file" || apiKeySource === "env") {
    return true;
  }

  return record.apiKeySet === true || hasNonEmptyString(record.apiKey);
}

/**
 * Would a direct-OpenAI request for this model route through Codex OAuth?
 *
 * Mirrors providerModelFactory: allowed model + stored OAuth tokens, then
 * Chat Completions with an API key never routes OAuth, required models always
 * route OAuth; otherwise OAuth wins when no API key is configured or when
 * `codexOauthDefaultAuth` prefers OAuth over a present key.
 */
/**
 * Can a DIRECT OpenAI route serve this model with the credentials on hand?
 *
 * `isConfigured` alone over-reports: a Codex-OAuth-only config serves only the
 * OAuth-allowed model set. Mirrors providerModelFactory's credential outcome —
 * an API key always attempts (OAuth-required models fall back to the key and
 * let the API decide), while stored tokens without a key serve only allowed
 * models — so availability checks can't claim a direct route the factory
 * would reject with api_key_not_found.
 */
export function canDirectOpenAIServeModel(
  model: string,
  providersConfig: ProvidersConfigMap | null | undefined,
  options?: CodexOauthRoutingOptions
): boolean {
  const openAIConfig = providersConfig?.openai;
  // A custom provider (any wire type) shadowing the built-in "openai" id is
  // direct-only and authenticates against its own endpoint (key optional):
  // built-in OpenAI credential rules don't apply to it.
  if (isCustomProviderConfig(openAIConfig)) {
    return true;
  }
  if (hasOpenAIApiKey(openAIConfig)) {
    return true;
  }
  // Codex OAuth speaks only the Responses endpoint: a provider pinned to the
  // Chat Completions wire format cannot be served by OAuth-only credentials —
  // createModel rejects that combination with api_key_not_found — so direct
  // routing must not win over a configured gateway for it. The REQUEST's own
  // wire format counts the same way: with no stored format the factory honors
  // providerOptions.openai.wireFormat, so a chatCompletions send is judged as
  // the factory will judge it.
  const wireFormat = asRecord(openAIConfig)?.wireFormat ?? options?.openaiWireFormat;
  if (wireFormat === "chatCompletions") {
    return false;
  }
  return (
    hasCodexOauthTokens(openAIConfig) && isCodexOauthAllowedModel(model, providersConfig ?? null)
  );
}

export function wouldRouteOpenAIThroughCodexOauth(
  model: string,
  providersConfig: ProvidersConfigMap | null | undefined,
  options?: CodexOauthRoutingOptions
): boolean {
  const openAIConfig = providersConfig?.openai;
  if (!isCodexOauthAllowedModel(model, providersConfig ?? null)) {
    return false;
  }
  if (!hasCodexOauthTokens(openAIConfig)) {
    return false;
  }
  // Codex OAuth serves only the Responses API. With Chat Completions selected,
  // the factory falls back to the API key whenever one exists.
  const wireFormat = asRecord(openAIConfig)?.wireFormat ?? options?.openaiWireFormat;
  if (wireFormat === "chatCompletions" && hasOpenAIApiKey(openAIConfig)) {
    return false;
  }
  if (isCodexOauthRequiredModel(model, providersConfig ?? null)) {
    return true;
  }
  if (!hasOpenAIApiKey(openAIConfig)) {
    return true;
  }

  return asRecord(openAIConfig)?.codexOauthDefaultAuth !== "apiKey";
}
