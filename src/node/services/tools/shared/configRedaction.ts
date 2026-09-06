import type { ConfigFileKey } from "@/common/config/schemaRegistry";
import { deepClone, isObjectRecord } from "@/node/services/tools/shared/configToolUtils";

// Config read tools can surface file contents to chat, so secret-like values must be
// scrubbed before responses are returned.
export const REDACTED_SECRET_VALUE = "[REDACTED]";

const PROVIDER_SECRET_KEYS = new Set([
  "apiKey",
  "bearerToken",
  "accessKeyId",
  "secretAccessKey",
  "couponCode",
  "voucher",
  "codexOauth",
  "codexOauthAccounts",
]);

const APP_SECRET_KEYS = new Set(["muxGovernorToken"]);

interface RedactionPolicy {
  explicitSecretKeys: ReadonlySet<string>;
  redactSensitiveHeaders: boolean;
  redactGenericSecretLikeKeys: boolean;
}

const CONFIG_REDACTION_POLICIES: Record<ConfigFileKey, RedactionPolicy> = {
  config: {
    explicitSecretKeys: APP_SECRET_KEYS,
    redactSensitiveHeaders: true,
    redactGenericSecretLikeKeys: false,
  },
  providers: {
    explicitSecretKeys: PROVIDER_SECRET_KEYS,
    redactSensitiveHeaders: true,
    redactGenericSecretLikeKeys: true,
  },
};

const AUTH_HEADER_NAME_PATTERN = /(authorization|api[-_]?key|token|secret|password|cookie)/i;
const SECRET_TAIL_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "credentials",
  "key",
]);
const SECRET_TAIL_PAIRS = new Set([
  "api_key",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
]);

export function redactConfigDocument(fileKey: ConfigFileKey, document: unknown): unknown {
  const policy = CONFIG_REDACTION_POLICIES[fileKey];
  const cloned = deepClone(document);
  redactSecretsRecursively(cloned, policy);
  return cloned;
}

function redactSecretsRecursively(node: unknown, policy: RedactionPolicy): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      redactSecretsRecursively(item, policy);
    }
    return;
  }

  if (!isObjectRecord(node)) {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (policy.redactSensitiveHeaders && isHeaderContainerKey(key) && isObjectRecord(value)) {
      redactSensitiveHeaders(value);
      continue;
    }

    const shouldRedact =
      policy.explicitSecretKeys.has(key) ||
      (policy.redactGenericSecretLikeKeys && looksLikeProviderSecretKey(key));

    if (shouldRedact && shouldRedactValue(value)) {
      node[key] = REDACTED_SECRET_VALUE;
      continue;
    }

    redactSecretsRecursively(value, policy);
  }
}

function splitKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Normalized aliases for header container keys. Matching is case-insensitive and
// plural-aware so httpHeaders, Headers, requestHeaders, etc. all trigger redaction.
const HEADER_CONTAINER_ALIASES = new Set([
  "header",
  "http_header",
  "request_header",
  "custom_header",
  "default_header",
]);

function isHeaderContainerKey(key: string): boolean {
  const segments = splitKeySegments(key);
  if (segments.length === 0) {
    return false;
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment === undefined) {
    return false;
  }

  const normalizedTail = singularizeTailWord(lastSegment);
  const normalized = [...segments.slice(0, -1), normalizedTail].join("_");
  return HEADER_CONTAINER_ALIASES.has(normalized);
}

// Lightweight singularization for secret-tail detection: strips trailing "s" so
// pluralized custom-provider key names (e.g. apiKeys, accessTokens, clientSecrets)
// match the canonical set.
function singularizeTailWord(word: string): string {
  return word.endsWith("s") && word.length > 1 ? word.slice(0, -1) : word;
}

// Provider configs are catchall-based, so custom providers can store credentials under
// non-standard key names that are unknown to our explicit allowlist.
function looksLikeProviderSecretKey(key: string): boolean {
  const segments = splitKeySegments(key);

  if (segments.length === 0) {
    return false;
  }

  const tail1 = segments.at(-1);
  if (tail1 && SECRET_TAIL_WORDS.has(singularizeTailWord(tail1))) {
    return true;
  }

  if (segments.length >= 2) {
    const secondToLast = segments[segments.length - 2];
    const last = segments[segments.length - 1];

    if (secondToLast === undefined || last === undefined) {
      return false;
    }

    const tail2 = `${secondToLast}_${singularizeTailWord(last)}`;
    return SECRET_TAIL_PAIRS.has(tail2);
  }

  return false;
}

function redactSensitiveHeaders(headers: Record<string, unknown>): void {
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (AUTH_HEADER_NAME_PATTERN.test(headerName) && shouldRedactValue(headerValue)) {
      headers[headerName] = REDACTED_SECRET_VALUE;
    }
  }
}

function shouldRedactValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== null && value !== undefined;
}
