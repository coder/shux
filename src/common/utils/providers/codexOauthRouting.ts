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
