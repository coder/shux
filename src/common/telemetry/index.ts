/**
 * Telemetry module public API
 *
 * This module provides telemetry tracking via PostHog.
 * Events are forwarded to the backend via ORPC to avoid ad-blocker issues.
 * Backend controls whether telemetry is enabled (MUX_DISABLE_TELEMETRY env var).
 * See payload.ts for all data structures sent to PostHog.
 *
 * USAGE:
 * - Use the track* functions for event tracking (they handle rounding internally)
 * - Use getRuntimeTypeForTelemetry to convert RuntimeConfig to telemetry-safe type
 */

export { initTelemetry } from "./client";
export { trackAppStarted } from "./lifecycle";

// Tracking functions - callers pass raw values, rounding handled internally
export {
  trackWorkspaceCreated,
  trackWorkspaceSwitched,
  trackMessageSent,
  trackStatsTabOpened,
  trackStreamCompleted,
  trackProviderConfigured,
  trackCommandUsed,
  trackVoiceTranscription,
  trackErrorOccurred,
  trackExperimentOverridden,
} from "./tracking";

// Utility for converting RuntimeConfig to telemetry-safe runtime type
export { getRuntimeTypeForTelemetry } from "./utils";
