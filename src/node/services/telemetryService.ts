/**
 * Backend Telemetry Service
 *
 * Sends telemetry events to PostHog from the main process (Node.js).
 * This avoids ad-blocker issues that affect browser-side telemetry.
 *
 * Telemetry is enabled by default, including in development mode.
 * It is automatically disabled in CI, test environments, and automation contexts
 * (NODE_ENV=test, CI, XUM_E2E=1, JEST_WORKER_ID, etc.).
 * Users can manually disable telemetry by setting XUM_DISABLE_TELEMETRY=1.
 *
 * Uses posthog-node which batches events and flushes asynchronously.
 */

import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import { PostHog } from "posthog-node";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { VERSION } from "@/version";
import type { TelemetryEventPayload, BaseTelemetryProperties } from "@/common/telemetry/payload";

// Default configuration (public keys, safe to commit)
const DEFAULT_POSTHOG_KEY = "phc_vF1bLfiD5MXEJkxojjsmV5wgpLffp678yhJd3w9Sl4G";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// File to persist anonymous distinct ID across sessions
const TELEMETRY_ID_FILE = "telemetry_id";

/**
 * Check if running in a CI/automation environment.
 * Covers major CI providers: GitHub Actions, GitLab CI, Jenkins, CircleCI,
 * Travis, Azure Pipelines, Bitbucket, TeamCity, Buildkite, etc.
 */
function isCIEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    // Generic CI indicator (set by most CI systems)
    env.CI === "true" ||
    env.CI === "1" ||
    // GitHub Actions
    env.GITHUB_ACTIONS === "true" ||
    // GitLab CI
    env.GITLAB_CI === "true" ||
    // Jenkins
    env.JENKINS_URL !== undefined ||
    // CircleCI
    env.CIRCLECI === "true" ||
    // Travis CI
    env.TRAVIS === "true" ||
    // Azure Pipelines
    env.TF_BUILD === "True" ||
    // Bitbucket Pipelines
    env.BITBUCKET_BUILD_NUMBER !== undefined ||
    // TeamCity
    env.TEAMCITY_VERSION !== undefined ||
    // Buildkite
    env.BUILDKITE === "true" ||
    // AWS CodeBuild
    env.CODEBUILD_BUILD_ID !== undefined ||
    // Drone CI
    env.DRONE === "true" ||
    // AppVeyor
    env.APPVEYOR === "True" ||
    // Vercel / Netlify (build environments)
    env.VERCEL === "1" ||
    env.NETLIFY === "true"
  );
}

/**
 * Check if telemetry is disabled via environment variable or automation context
 */
function isTelemetryDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    resolveXumEnvironmentValue("DISABLE_TELEMETRY", env) === "1" ||
    resolveXumEnvironmentValue("E2E", env) === "1" ||
    env.NODE_ENV === "test" ||
    env.JEST_WORKER_ID !== undefined ||
    env.VITEST !== undefined ||
    env.TEST_INTEGRATION === "1" ||
    isCIEnvironment(env)
  );
}

export interface TelemetryEnablementContext {
  env: NodeJS.ProcessEnv;
  isElectron: boolean;
  isPackaged: boolean | null;
}

export function shouldEnableTelemetry(context: TelemetryEnablementContext): boolean {
  // Telemetry is disabled by explicit env vars, CI, or test environments
  if (isTelemetryDisabledByEnv(context.env)) {
    return false;
  }

  // Otherwise, telemetry is enabled (including dev mode)
  return true;
}

async function getElectronIsPackaged(isElectron: boolean): Promise<boolean | null> {
  if (!isElectron) {
    return null;
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- Electron is unavailable in `xum server`; avoid top-level import
    const { app } = await import("electron");
    return app.isPackaged;
  } catch {
    // If we can't determine packaging status, fail closed.
    return null;
  }
}

/**
 * Get the version string for telemetry
 */
function getVersionString(): string {
  if (
    typeof VERSION === "object" &&
    VERSION !== null &&
    typeof (VERSION as Record<string, unknown>).git_describe === "string"
  ) {
    return (VERSION as { git_describe: string }).git_describe;
  }
  return "unknown";
}

export class TelemetryService {
  private client: PostHog | null = null;
  private distinctId: string | null = null;
  private featureFlagVariants: Record<string, string | boolean> = {};
  private readonly xumHome: string;

  /**
   * Check if telemetry is enabled.
   * Returns true only after initialize() completes and telemetry was not disabled.
   */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * Check if telemetry was explicitly disabled by the user via XUM_DISABLE_TELEMETRY=1.
   * This is different from isEnabled() which also returns false in dev mode.
   * Used to gate features like link sharing that should only be hidden when
   * the user explicitly opts out of xum services.
   */
  isExplicitlyDisabled(): boolean {
    return resolveXumEnvironmentValue("DISABLE_TELEMETRY", process.env) === "1";
  }

  /**
   * Set the current PostHog feature flag/experiment assignment.
   *
   * This is used to attach `$feature/<flagKey>` properties to all telemetry events so
   * PostHog can break down metrics by experiment variant (required for server-side capture).
   */
  setFeatureFlagVariant(flagKey: string, variant: string | boolean | null): void {
    assert(typeof flagKey === "string", "flagKey must be a string");
    const trimmed = flagKey.trim();
    assert(trimmed.length > 0, "flagKey must not be empty");

    const key = `$feature/${trimmed}`;

    if (variant === null) {
      // Removing the property avoids emitting null values which can pollute breakdowns.
      // Note: This is safe even if telemetry is disabled.
      delete this.featureFlagVariants[key];
      return;
    }

    assert(
      typeof variant === "string" || typeof variant === "boolean",
      "variant must be a string | boolean | null"
    );

    this.featureFlagVariants[key] = variant;
  }
  constructor(xumHome?: string) {
    this.xumHome = xumHome ?? getXumHome();
  }

  /**
   * Initialize the PostHog client.
   * Should be called once on app startup.
   */
  async initialize(): Promise<void> {
    if (this.client) {
      return;
    }

    const env = process.env;

    // Fast path: avoid Electron imports when telemetry is obviously disabled.
    if (isTelemetryDisabledByEnv(env)) {
      return;
    }

    const isElectron = typeof process.versions.electron === "string";
    const isPackaged = await getElectronIsPackaged(isElectron);

    if (!shouldEnableTelemetry({ env, isElectron, isPackaged })) {
      return;
    }

    // Load or generate distinct ID
    this.distinctId = await this.loadOrCreateDistinctId();

    this.client = new PostHog(DEFAULT_POSTHOG_KEY, {
      host: DEFAULT_POSTHOG_HOST,
      // Avoid geo-IP enrichment (we don't need coarse location for xum telemetry)
      disableGeoip: true,
    });

    console.debug("[TelemetryService] Initialized", { host: DEFAULT_POSTHOG_HOST });
  }

  /**
   * Load existing distinct ID or create a new one.
   * Persisted in ~/.xum/telemetry_id for cross-session identity.
   */
  private async loadOrCreateDistinctId(): Promise<string> {
    const idPath = path.join(this.xumHome, TELEMETRY_ID_FILE);

    try {
      // Try to read existing ID
      const id = (await fs.readFile(idPath, "utf-8")).trim();
      if (id) {
        return id;
      }
    } catch {
      // File doesn't exist or read error, will create new ID
    }

    // Generate new ID
    const newId = randomUUID();

    try {
      // Ensure directory exists
      await fs.mkdir(this.xumHome, { recursive: true });
      await fs.writeFile(idPath, newId, "utf-8");
    } catch {
      // Silently ignore persistence failures
    }

    return newId;
  }

  /**
   * Get base properties included with all events
   */
  private getBaseProperties(): BaseTelemetryProperties & Record<string, string | boolean> {
    return {
      version: getVersionString(),
      backend_platform: process.platform,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node ?? "unknown",
      bunVersion: process.versions.bun ?? "unknown",
      ...this.featureFlagVariants,
    };
  }

  /**
   * Track a telemetry event.
   * Events are silently ignored when disabled.
   */
  capture(payload: TelemetryEventPayload): void {
    if (isTelemetryDisabledByEnv(process.env) || !this.client || !this.distinctId) {
      return;
    }

    // Merge base properties with event-specific properties
    const properties = {
      ...this.getBaseProperties(),
      ...payload.properties,
    };

    this.client.capture({
      distinctId: this.distinctId,
      event: payload.event,
      properties,
    });
  }

  /**
   * Shutdown telemetry and flush any pending events.
   * Should be called on app close.
   */
  async shutdown(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.shutdown();
    } catch {
      // Silently ignore shutdown errors
    }

    this.client = null;
  }
}
