export const SERVER_UPDATE_CHECK_TIMEOUT_MS = 30_000;
export const SERVER_UPDATE_MONITOR_VERIFY_TIMEOUT_MS = 1_000;
export const SERVER_UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;
export const SERVER_UPDATE_SMOKE_TIMEOUT_MS = 30_000;
export const SERVER_UPDATE_STAGING_PREFIX = "xum-staging-";
export const SERVER_UPDATE_STAGE_MARKER = ".xum-stage.json";
export const SERVER_UPDATE_LOCKFILES = {
  bun: "bun.lock",
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
} as const;
export const SERVER_UPDATE_CLI_INTERPRETER = "node";
export const SERVER_UPDATE_CLI_SHEBANG = `#!/usr/bin/env ${SERVER_UPDATE_CLI_INTERPRETER}`;
export const SERVER_UPDATE_VERIFY_CONCURRENCY = 16;
export const SERVER_VERSION_CHECK_TIMEOUT_MS = 5_000;
