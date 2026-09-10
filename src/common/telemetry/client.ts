/**
 * PostHog Telemetry Client (Frontend)
 *
 * Forwards telemetry events to the backend via ORPC.
 * The backend decides whether to actually send events to PostHog
 * (controlled by MUX_DISABLE_TELEMETRY environment variable).
 *
 * This design avoids ad-blocker issues and centralizes control.
 * All payloads are defined in ./payload.ts for transparency.
 */

import type { TelemetryEventPayload } from "./payload";

/**
 * Check if running in a CI/automation environment.
 * Covers major CI providers. This is a subset of what the backend checks
 * since the browser process has limited env var access.
 */
function isCIEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return (
    process.env.CI === "true" ||
    process.env.CI === "1" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true" ||
    process.env.JENKINS_URL !== undefined ||
    process.env.CIRCLECI === "true"
  );
}

/**
 * Check if we're running in a test or CI environment
 */
function isTestEnvironment(): boolean {
  return (
    (typeof process !== "undefined" &&
      (process.env.NODE_ENV === "test" ||
        process.env.JEST_WORKER_ID !== undefined ||
        process.env.VITEST !== undefined ||
        process.env.TEST_INTEGRATION === "1")) ||
    isCIEnvironment()
  );
}

/**
 * Check if we're running under the Vite dev server.
 *
 * We avoid import.meta.env here because this module is shared across the
 * renderer and the main-process builds (tsconfig.main uses module=CommonJS).
 */
function isViteDevEnvironment(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  // Vite injects /@vite/client in dev for HMR.
  return document.querySelector('script[src^="/@vite/client"]') !== null;
}

/**
 * Initialize telemetry (no-op, kept for API compatibility)
 */
export function initTelemetry(): void {
  // No-op - backend handles initialization
}

/**
 * Send a telemetry event via the backend
 * Events are type-safe and must match definitions in payload.ts
 *
 * The backend decides whether to actually send to PostHog.
 */
export function trackEvent(payload: TelemetryEventPayload): void {
  // Telemetry is a no-op in tests/CI/E2E, and also in SSR-ish test contexts
  // where `window` isn't available.
  //
  // Under the Vite dev server we also require explicit opt-in from the preload
  // script (window.api.enableTelemetryInDev) to avoid accidentally emitting data
  // from local development.
  if (
    typeof window === "undefined" ||
    isTestEnvironment() ||
    window.api?.isE2E === true ||
    (isViteDevEnvironment() && window.api?.enableTelemetryInDev !== true)
  ) {
    return;
  }

  const client = window.__ORPC_CLIENT__;
  if (!client?.telemetry?.track) {
    return;
  }

  // Fire and forget - don't block on telemetry
  client.telemetry.track(payload).catch(() => {
    // Silently ignore errors
  });
}
