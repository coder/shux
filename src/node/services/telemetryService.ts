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
  /** User opt-out persisted in config.json (Settings → General). */
  disabledByConfig?: boolean;
}

export function shouldEnableTelemetry(context: TelemetryEnablementContext): boolean {
  // Telemetry is disabled by explicit env vars, CI, or test environments
  if (isTelemetryDisabledByEnv(context.env)) {
    return false;
  }

  // User opt-out via config.json (telemetryEnabled: false). The env var and
  // config switch are both hard-off; absence of both means enabled.
  if (context.disabledByConfig === true) {
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
  private readonly isDisabledByConfig?: () => boolean;
  private initInFlight: Promise<void> | null = null;
  private configApplyChain: Promise<void> = Promise.resolve();
  // Set once by shutdown() at final app teardown and never cleared: the lazy
  // capture()-path and initializeOnce()'s post-await re-check must refuse to
  // install a client during or after teardown. Runtime opt-outs
  // (setConfigEnabled(false)) deliberately do NOT set this — a peer process
  // re-enabling the shared config must be able to lazily re-init this one,
  // and the per-event config gate keeps capture() off in the meantime.
  private terminalShutdown = false;
  /** Rate limit for capture()'s lazy cross-process re-enable initialization. */
  private static readonly LAZY_INIT_RETRY_MS = 30_000;
  private lastLazyInitAttemptMs = 0;

  /**
   * Check if telemetry is effectively enabled.
   * A live client alone is not the truth: a peer process (or a manual shared
   * config edit) can opt out while this process still holds an initialized
   * client — capture() already gates per event, and status surfaces must
   * agree with it. The env gate needs no re-check here: the environment is
   * fixed for the process lifetime, and an env-disabled process never
   * creates a client in the first place.
   */
  isEnabled(): boolean {
    return this.client !== null && this.isDisabledByConfig?.() !== true;
  }

  /**
   * Check if telemetry was explicitly disabled by the user — either via
   * XUM_DISABLE_TELEMETRY=1 or the Settings → General opt-out. This is
   * different from isEnabled() which also returns false in test/CI contexts.
   * Consumers gating on explicit opt-out must treat both switches the same;
   * the docs present them as equivalent.
   */
  isExplicitlyDisabled(): boolean {
    return (
      resolveXumEnvironmentValue("DISABLE_TELEMETRY", process.env) === "1" ||
      this.isDisabledByConfig?.() === true
    );
  }

  /** The environment gate alone (env var, CI, tests) — surfaced to the UI so the Settings toggle can render as hard-disabled. */
  isDisabledByEnv(): boolean {
    return isTelemetryDisabledByEnv(process.env);
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
  constructor(xumHome?: string, isDisabledByConfig?: () => boolean) {
    this.xumHome = xumHome ?? getXumHome();
    this.isDisabledByConfig = isDisabledByConfig;
  }

  /**
   * Apply the Settings → General telemetry toggle at runtime: disabling shuts
   * the PostHog client down (capture() no-ops on a null client), enabling
   * re-runs initialize(), which re-checks every enablement gate.
   *
   * Applies are serialized across ALL callers: the desktop Settings pane and
   * API-server clients drive the same router in one process with no shared
   * frontend chain, and an unserialized shutdown/initialize interleaving can
   * resurrect a capturing client after an opt-out, kill telemetry while the
   * switch shows on, or orphan an unflushed client.
   */
  async setConfigEnabled(enabled: boolean): Promise<void> {
    const next = this.configApplyChain.then(() => {
      // Concurrent toggles can reorder persistence vs application across
      // RPCs: A persists false and pauses, B persists AND applies true, then
      // A applies its stale false — config says enabled while the client is
      // down. Re-read the persisted truth at APPLY time so queued applies
      // converge on the last persisted state instead of replaying their
      // caller's intent. Without a config reader (bare constructions) the
      // caller's value is the only truth available.
      const effectiveEnabled =
        this.isDisabledByConfig != null ? !this.isDisabledByConfig() : enabled;
      if (effectiveEnabled) {
        return this.initialize();
      }
      // Runtime opt-out, not the terminal latch: tear the client down but
      // leave lazy re-init armed, so a later re-enable — from this process or
      // a peer writing the shared config — can bring telemetry back without a
      // restart. While the config stays disabled, capture()'s per-event gate
      // keeps events off regardless.
      return this.teardownClient();
    });
    // Keep the chain usable after a failed apply.
    this.configApplyChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Initialize the PostHog client.
   * Should be called once on app startup.
   *
   * Re-entrancy-safe: the null-client guard and the client assignment are
   * separated by awaits, so two concurrent initializes would otherwise both
   * pass the guard and orphan a live client.
   */
  async initialize(): Promise<void> {
    if (this.initInFlight) {
      return this.initInFlight;
    }
    const run = this.initializeOnce().finally(() => {
      this.initInFlight = null;
    });
    this.initInFlight = run;
    return run;
  }

  private async initializeOnce(): Promise<void> {
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
    const disabledByConfig = this.isDisabledByConfig?.() === true;

    if (!shouldEnableTelemetry({ env, isElectron, isPackaged, disabledByConfig })) {
      return;
    }

    // Load or generate distinct ID
    this.distinctId = await this.loadOrCreateDistinctId();

    // Terminal teardown may have started while the awaits above ran — the
    // startup initialize() does not ride configApplyChain, so shutdown()'s
    // queued teardown can complete before we get here. Installing the client
    // now would leave a live PostHog past the final flush.
    if (this.terminalShutdown) {
      return;
    }

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
    // The config opt-out is re-checked per event, not just at initialize():
    // a second mux process sharing ~/.mux/config.json (mux server alongside
    // the desktop app) must stop capturing when the user opts out in the
    // other process. Event volume is low (discrete user actions), so the
    // config read is acceptable here for a privacy control.
    if (isTelemetryDisabledByEnv(process.env) || this.isDisabledByConfig?.() === true) {
      return;
    }

    if (!this.client || !this.distinctId) {
      // Cross-process re-enable: this process may have started while the
      // shared config said opted-out (client never created) and another
      // process has since re-enabled. Kick a lazy, serialized initialize —
      // rate-limited because every enablement gate (dev mode, packaging)
      // still applies and may legitimately keep the client null. The current
      // event is dropped; the process converges for subsequent ones.
      const now = Date.now();
      if (now - this.lastLazyInitAttemptMs > TelemetryService.LAZY_INIT_RETRY_MS) {
        this.lastLazyInitAttemptMs = now;
        // Serialized with toggle applies, and latched off once shutdown
        // begins: an unserialized initialize() here could install a fresh
        // client while shutdown() is still awaiting the PostHog flush,
        // leaving telemetry live after teardown. The queued task re-checks
        // every gate when it actually runs.
        this.configApplyChain = this.configApplyChain
          .then(async () => {
            if (this.terminalShutdown || this.client != null) {
              return;
            }
            if (isTelemetryDisabledByEnv(process.env) || this.isDisabledByConfig?.() === true) {
              return;
            }
            await this.initialize();
          })
          .then(
            () => undefined,
            () => undefined
          );
      }
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
   * Should be called on app close — this is the terminal teardown, distinct
   * from the runtime opt-out (setConfigEnabled(false)): it latches lazy
   * re-init off permanently.
   */
  async shutdown(): Promise<void> {
    // Latch first (synchronously): any lazy re-init task that runs from this
    // instant on refuses at its terminalShutdown re-check, and initializeOnce
    // re-checks after its awaits.
    this.terminalShutdown = true;
    // Ride the apply chain so an in-flight initialize() — a lazy task that
    // passed the latch check and is awaiting the Electron import or
    // telemetry-ID I/O — settles BEFORE the flush. A direct teardown here
    // could observe a null client, return, and leak the client that task
    // installs moments later; queued behind it, the teardown disposes
    // whatever state it left.
    const next = this.configApplyChain.then(() => this.teardownClient());
    this.configApplyChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** Null the client immediately (capture() no-ops), then flush it. */
  private async teardownClient(): Promise<void> {
    // Null BEFORE flushing: capture() must no-op the instant a teardown
    // begins, and a concurrent initialize() must never observe the stale
    // client and skip re-initialization.
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }

    try {
      await client.shutdown();
    } catch {
      // Silently ignore shutdown errors
    }
  }
}
