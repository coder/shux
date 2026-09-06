// Local slot IDs differ from ChatGPT account IDs in token claims.
export const CODEX_OAUTH_DEFAULT_ACCOUNT_ID = "default";
export const CODEX_OAUTH_REFRESH_TIMEOUT_MS = 30_000;
export const CODEX_OAUTH_START_TIMEOUT_MS = 30_000;
export const CODEX_OAUTH_REFRESH_LOCK_TIMEOUT_MS = 45_000;
export const CODEX_OAUTH_REFRESH_LOCK_STALE_MS = 60_000;
export const CODEX_OAUTH_ACCOUNT_ID_MAX_LENGTH = 200;
export const CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH = 100;
export const CODEX_OAUTH_ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const CODEX_OAUTH_RESERVED_ACCOUNT_IDS = new Set(["__proto__", "constructor", "prototype"]);
