/**
 * Codex OAuth token parsing + JWT claim extraction.
 *
 * We intentionally do not validate token signatures here; we only need to
 * extract non-sensitive claims (e.g. ChatGPT-Account-Id) from OAuth responses.
 */

import { z } from "zod";

import {
  CODEX_OAUTH_DEFAULT_ACCOUNT_ID,
  CODEX_OAUTH_ACCOUNT_ID_MAX_LENGTH,
  CODEX_OAUTH_ACCOUNT_ID_PATTERN,
  CODEX_OAUTH_RESERVED_ACCOUNT_IDS,
} from "@/common/constants/codexOauthAccounts";

const credentialIdSchema = z.string().uuid().optional();

export interface CodexOauthAuth {
  type: "oauth";
  /** Identifies this login across token rotations and processes. */
  credentialId?: string;
  /** Matches a backfilled ID while requests still pin the original undefined identity. */
  legacyCredentialId?: string;
  /** Blocks requests while retaining the login identity for reconnect. */
  invalidReason?: "invalid_grant";
  /** OAuth access token (JWT). */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Unix epoch milliseconds when the access token expires. */
  expires: number;
  /** Value to send as the ChatGPT-Account-Id header. */
  accountId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseCodexOauthAuth(value: unknown): CodexOauthAuth | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const type = value.type;
  const access = value.access;
  const refresh = value.refresh;
  const expires = value.expires;
  const accountId = value.accountId;
  const credentialId = credentialIdSchema.safeParse(value.credentialId);
  const legacyCredentialId = credentialIdSchema.safeParse(value.legacyCredentialId);
  const invalidReason = value.invalidReason;

  if (type !== "oauth") return null;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;

  if (typeof accountId !== "undefined") {
    if (typeof accountId !== "string" || !accountId) return null;
  }

  if (invalidReason !== undefined && invalidReason !== "invalid_grant") return null;

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    accountId,
    // Treat a damaged optional ID as legacy state so reconnect can assign a valid ID.
    credentialId: credentialId.success ? credentialId.data : undefined,
    // A mismatched or malformed alias must not authorize an old request.
    legacyCredentialId:
      credentialId.success &&
      legacyCredentialId.success &&
      credentialId.data === legacyCredentialId.data
        ? legacyCredentialId.data
        : undefined,
    invalidReason,
  };
}

/** Validate local slot IDs at input and storage boundaries. */
export function isValidCodexOauthAccountId(accountId: string): boolean {
  return (
    accountId.length <= CODEX_OAUTH_ACCOUNT_ID_MAX_LENGTH &&
    CODEX_OAUTH_ACCOUNT_ID_PATTERN.test(accountId) &&
    !CODEX_OAUTH_RESERVED_ACCOUNT_IDS.has(accountId)
  );
}

/** Read stored slots, including invalid credentials that need reconnect. */
export function getCodexOauthAccounts(config: unknown): Array<{
  id: string;
  label: string;
  auth: CodexOauthAuth;
}> {
  if (!isPlainObject(config)) return [];
  const accounts: Array<{ id: string; label: string; auth: CodexOauthAuth }> = [];
  const legacy = parseCodexOauthAuth(config.codexOauth);
  if (legacy) {
    accounts.push({
      id: CODEX_OAUTH_DEFAULT_ACCOUNT_ID,
      label:
        typeof config.codexOauthLabel === "string" && config.codexOauthLabel.trim()
          ? config.codexOauthLabel.trim()
          : "Default",
      auth: legacy,
    });
  }
  if (isPlainObject(config.codexOauthAccounts)) {
    for (const [id, entry] of Object.entries(config.codexOauthAccounts)) {
      // The legacy slot owns this ID, even if malformed disk data repeats it.
      if (
        id === CODEX_OAUTH_DEFAULT_ACCOUNT_ID ||
        !isValidCodexOauthAccountId(id) ||
        !isPlainObject(entry)
      )
        continue;
      const auth = parseCodexOauthAuth(entry.credentials);
      if (!auth) continue;
      // Damaged display labels must not hide credentials from reconnect, rename, or disconnect.
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      accounts.push({ id, label: label || id, auth });
    }
  }
  return accounts;
}

/** Resolve a local slot ID without substituting another connected account. */
export function getCodexOauthAccountId(config: unknown, override?: string): string {
  if (override !== undefined) return override;
  if (isPlainObject(config) && typeof config.codexOauthDefaultAccountId === "string") {
    return config.codexOauthDefaultAccountId;
  }
  return CODEX_OAUTH_DEFAULT_ACCOUNT_ID;
}

/** Read the selected slot. Missing selections do not fall back to another slot. */
export function getCodexOauthAuth(config: unknown, accountId?: string): CodexOauthAuth | null {
  const selected = getCodexOauthAccountId(config, accountId);
  return getCodexOauthAccounts(config).find((account) => account.id === selected)?.auth ?? null;
}

export function isCodexOauthAuthExpired(
  auth: CodexOauthAuth,
  opts?: { nowMs?: number; skewMs?: number }
): boolean {
  const now = opts?.nowMs ?? Date.now();
  const skew = opts?.skewMs ?? 30_000;
  return now + skew >= auth.expires;
}

/**
 * Best-effort JWT claim decoding (no signature verification).
 */
export function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | null {
  // OpenCode guide extraction order:
  // 1) claims.chatgpt_account_id
  // 2) claims["https://api.openai.com/auth"].chatgpt_account_id
  // 3) claims.organizations?.[0]?.id

  const direct = claims.chatgpt_account_id;
  if (typeof direct === "string" && direct) {
    return direct;
  }

  const openAiAuth = claims["https://api.openai.com/auth"];
  if (isPlainObject(openAiAuth)) {
    const candidate = openAiAuth.chatgpt_account_id;
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  const organizations = claims.organizations;
  if (isUnknownArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (isPlainObject(first)) {
      const candidate = first.id;
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
    }
  }

  return null;
}

export function extractAccountIdFromToken(token: string): string | null {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return null;
  }

  return extractAccountIdFromClaims(claims);
}

export function extractAccountIdFromTokens(input: {
  accessToken: string;
  idToken?: string;
}): string | null {
  // Prefer id_token when present; fall back to access token.
  if (typeof input.idToken === "string" && input.idToken) {
    const fromId = extractAccountIdFromToken(input.idToken);
    if (fromId) {
      return fromId;
    }
  }

  return extractAccountIdFromToken(input.accessToken);
}
