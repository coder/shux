export const STARTUP_RECOVERY_MAX_READ_ATTEMPTS = 4;
export const STARTUP_RECOVERY_READ_BASE_DELAY_MS = 1_000;
export const STARTUP_RECOVERY_READ_MAX_DELAY_MS = 30_000;
// Leave room for retries without blocking application startup on an unavailable session.
export const STARTUP_RECOVERY_PROBE_TIMEOUT_MS = 15_000;
