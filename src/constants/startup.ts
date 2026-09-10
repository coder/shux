/**
 * Startup passes that take longer than this are logged at warn level so slow deployments
 * (thousands of workspaces, large session dirs) surface in logs without enabling debug output.
 * Chosen well above a healthy cold start (seconds) but below the point where a health check
 * would already have flagged the process.
 */
export const SLOW_STARTUP_WARN_THRESHOLD_MS = 30_000;
