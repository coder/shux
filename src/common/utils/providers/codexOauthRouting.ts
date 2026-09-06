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
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { CODEX_OAUTH_DEFAULT_ACCOUNT_ID } from "@/common/constants/codexOauthAccounts";

/** Request-level inputs the stored providers config cannot carry. */
export interface CodexOauthRoutingOptions {
  /**
   * Request-level OpenAI wire format (muxProviderOptions.openai.wireFormat).
   * The stored `openai.wireFormat` wins when set, matching providerModelFactory.
   */
  openaiWireFormat?: OpenAIWireFormat | null;
  /** Local account slot selected for this request. */
  codexOauthAccountId?: string;
}

/** Use the same account scope as backend model construction. */
export function getCodexOauthProjectPath(
  scope?:
    | (Partial<Pick<WorkspaceMetadata, "projectPath" | "projects" | "subProjectPath">> & {
        attributionProjectPath?: string;
      })
    | null
): string | undefined {
  return (
    scope?.projects?.[0]?.projectPath ??
    scope?.subProjectPath ??
    scope?.attributionProjectPath ??
    scope?.projectPath
  );
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

export function hasCodexOauthTokens(config: unknown, accountId?: string): boolean {
  const record = asRecord(config);
  if (!record) {
    return false;
  }

  const selectedId =
    accountId ?? record.codexOauthDefaultAccountId ?? CODEX_OAUTH_DEFAULT_ACCOUNT_ID;
  if (Array.isArray(record.codexOauthAccounts)) {
    return record.codexOauthAccounts.some((account: unknown) => {
      const entry = asRecord(account);
      return entry?.id === selectedId && entry.reconnectRequired !== true;
    });
  }

  // Old metadata contains only the legacy connection flag.
  if (record.codexOauthSet === true && selectedId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID) {
    return true;
  }

  // Raw configs contain tokens. Never substitute another connected account.
  const accounts = asRecord(record.codexOauthAccounts);
  const selectedAccount = typeof selectedId === "string" ? asRecord(accounts?.[selectedId]) : null;
  if (selectedId !== CODEX_OAUTH_DEFAULT_ACCOUNT_ID && !hasNonEmptyString(selectedAccount?.label)) {
    return false;
  }
  const oauth = asRecord(
    selectedId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID ? record.codexOauth : selectedAccount?.credentials
  );
  return (
    oauth?.type === "oauth" &&
    oauth.invalidReason === undefined &&
    hasNonEmptyString(oauth.access) &&
    hasNonEmptyString(oauth.refresh) &&
    typeof oauth.expires === "number" &&
    Number.isFinite(oauth.expires) &&
    (oauth.accountId === undefined || hasNonEmptyString(oauth.accountId))
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

export type CodexOauthRouting = "oauth" | "missing-account" | "other";

/** Resolve OAuth routing without treating a missing selection as API-key fallback. */
export function resolveCodexOauthRouting(
  model: string,
  providersConfig: ProvidersConfigMap | null | undefined,
  options?: CodexOauthRoutingOptions
): CodexOauthRouting {
  const openAIConfig = providersConfig?.openai;
  if (!isCodexOauthAllowedModel(model, providersConfig ?? null)) {
    return "other";
  }
  const record = asRecord(openAIConfig);
  const hasApiKey = hasOpenAIApiKey(openAIConfig);
  const hasSelectedAccount = hasCodexOauthTokens(openAIConfig, options?.codexOauthAccountId);
  const required = isCodexOauthRequiredModel(model, providersConfig ?? null);
  if (required && !hasSelectedAccount && !hasApiKey) {
    return "missing-account";
  }
  // Chat Completions uses the API key, even when OAuth is preferred.
  const wireFormat = record?.wireFormat ?? options?.openaiWireFormat;
  if (wireFormat === "chatCompletions" && hasApiKey) {
    return "other";
  }
  if (!required && hasApiKey && record?.codexOauthDefaultAuth === "apiKey") {
    return "other";
  }
  if (hasSelectedAccount) {
    return "oauth";
  }

  const hasExplicitSelection =
    options?.codexOauthAccountId !== undefined || record?.codexOauthDefaultAccountId !== undefined;
  const accounts = record?.codexOauthAccounts;
  const hasInvalidStoredAccount =
    asRecord(record?.codexOauth)?.invalidReason === "invalid_grant" ||
    Object.values(asRecord(accounts) ?? {}).some(
      (account) => asRecord(asRecord(account)?.credentials)?.invalidReason === "invalid_grant"
    );
  const hasAccountSlots = Array.isArray(accounts)
    ? accounts.length > 0
    : record?.codexOauthSet === true ||
      hasInvalidStoredAccount ||
      hasCodexOauthTokens(openAIConfig, CODEX_OAUTH_DEFAULT_ACCOUNT_ID) ||
      Object.keys(asRecord(accounts) ?? {}).some((id) => hasCodexOauthTokens(openAIConfig, id));
  // Missing slots must not enable API-only controls or remove the OAuth context cap.
  return hasExplicitSelection || hasAccountSlots ? "missing-account" : "other";
}

/** Return true only when the selected OAuth account can serve the request. */
export function wouldRouteOpenAIThroughCodexOauth(
  model: string,
  providersConfig: ProvidersConfigMap | null | undefined,
  options?: CodexOauthRoutingOptions
): boolean {
  return resolveCodexOauthRouting(model, providersConfig, options) === "oauth";
}
