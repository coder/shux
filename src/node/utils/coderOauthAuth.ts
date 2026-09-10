/**
 * Coder OAuth token blob parsing + expiry checks.
 *
 * The blob is persisted in providers.jsonc under coder.coderOauth and also
 * carries the dynamically registered OAuth client (RFC 7591/7592) so later
 * logins can update the registered loopback redirect URI instead of
 * registering a new client per login.
 */

export interface CoderOauthAuth {
  type: "oauth";
  /**
   * Login-session lineage id: minted once per completed login (token
   * exchange) and preserved across refresh rotations. Refresh tokens rotate
   * on every use, so this is the only stable way to tell "the same login,
   * rotated" apart from "a genuinely newer login" — disconnect must clear the
   * former but preserve the latter.
   */
  sessionId: string;
  /**
   * Normalized deployment URL (issuer) these tokens were obtained from.
   * Consumers must verify it matches the configured deployment URL so a URL
   * change can never send the old deployment's bearer token to a new host.
   */
  deploymentUrl: string;
  /** Coder OAuth access token (a regular Coder API key). */
  access: string;
  /** Coder OAuth refresh token. Rotates on every refresh. */
  refresh: string;
  /** Unix epoch milliseconds when the access token expires. */
  expires: number;
  /** Dynamically registered OAuth client id. */
  clientId: string;
  /** Client secret issued by dynamic client registration (required by Coder's token endpoint). */
  clientSecret: string;
  /** RFC 7592 registration access token for updating the registered redirect URI. */
  registrationAccessToken?: string;
  /** RFC 7592 client configuration endpoint. */
  registrationClientUri?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown): string | undefined | null {
  if (typeof value === "undefined") return undefined;
  if (typeof value === "string" && value) return value;
  return null; // present but invalid
}

export function parseCoderOauthAuth(value: unknown): CoderOauthAuth | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const { type, sessionId, deploymentUrl, access, refresh, expires, clientId, clientSecret } =
    value;

  if (type !== "oauth") return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof deploymentUrl !== "string" || !deploymentUrl) return null;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  if (typeof clientId !== "string" || !clientId) return null;
  if (typeof clientSecret !== "string" || !clientSecret) return null;

  const registrationAccessToken = optionalNonEmptyString(value.registrationAccessToken);
  if (registrationAccessToken === null) return null;
  const registrationClientUri = optionalNonEmptyString(value.registrationClientUri);
  if (registrationClientUri === null) return null;

  return {
    type: "oauth",
    sessionId,
    deploymentUrl,
    access,
    refresh,
    expires,
    clientId,
    clientSecret,
    registrationAccessToken,
    registrationClientUri,
  };
}

export function isCoderOauthAuthExpired(
  auth: CoderOauthAuth,
  opts?: { nowMs?: number; skewMs?: number }
): boolean {
  const now = opts?.nowMs ?? Date.now();
  const skew = opts?.skewMs ?? 30_000;
  return now + skew >= auth.expires;
}
