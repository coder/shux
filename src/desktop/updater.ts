import { autoUpdater } from "electron-updater";
import type { UpdateInfo } from "electron-updater";
import packageJson from "../../package.json";
import { log } from "@/node/services/log";
import type { UpdateChannel } from "@/common/types/project";
import { parseDebugUpdater } from "@/common/utils/env";
import {
  clearUpdateInstallInProgress,
  markUpdateInstallInProgress,
} from "@/desktop/updateInstallState";

// Update check timeout in milliseconds (30 seconds)
const UPDATE_CHECK_TIMEOUT_MS = 30_000;

/** Derive GitHub owner/repo from package.json repository URL instead of hardcoding. */
function getGitHubRepo(): { owner: string; repo: string } {
  const url =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;

  if (url) {
    // Matches github.com/owner/repo in URLs like:
    //   git+https://github.com/coder/mux.git
    //   https://github.com/coder/mux
    //   git@github.com:coder/mux.git
    //   git+https://github.com/acme/mux.desktop.git
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  // Fallback for non-standard repository URLs
  return { owner: "coder", repo: "mux" };
}

// Nightly releases are published in phases, so latest-*.yml can briefly 404.
// Keep manual checks actionable with a friendly retry message instead of
// exposing low-level electron-updater stack traces in the About dialog.
const MISSING_UPDATE_METADATA_MESSAGE =
  "Update metadata isn't available yet. The latest release may still be publishing; please try again in a few minutes.";
const MAX_USER_VISIBLE_UPDATE_ERROR_LENGTH = 240;

/**
 * Detect transient errors that should trigger silent backoff rather than
 * surfacing an error to the user. Covers:
 * - 404 (latest.yml not yet uploaded for a new release)
 * - Network errors (offline, DNS, timeout)
 * - GitHub rate-limiting (explicit rate-limit signatures only — bare 403s
 *   may indicate persistent auth/config issues and should remain visible)
 */
function isTransientUpdateError(error: Error): boolean {
  const msg = error.message;
  return (
    /404|Not Found/i.test(msg) ||
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg) ||
    /network|socket hang up/i.test(msg) ||
    /rate limit/i.test(msg)
  );
}

function isMissingLatestManifestError(error: Error): boolean {
  const msg = error.message;
  return /404|Not Found/i.test(msg) && /latest-[^\s"']+\.yml/i.test(msg);
}

function sanitizeUpdateCheckErrorMessage(message: string): string {
  const firstLine = message.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return "Unknown error";
  }

  if (firstLine.length <= MAX_USER_VISIBLE_UPDATE_ERROR_LENGTH) {
    return firstLine;
  }

  return `${firstLine.slice(0, MAX_USER_VISIBLE_UPDATE_ERROR_LENGTH - 1)}…`;
}

function getUserVisibleCheckErrorMessage(error: Error): string {
  if (isMissingLatestManifestError(error)) {
    return MISSING_UPDATE_METADATA_MESSAGE;
  }

  return sanitizeUpdateCheckErrorMessage(error.message);
}

// Backend UpdateStatus type (uses full UpdateInfo from electron-updater)
export type UpdateStatus =
  | { type: "idle" } // Initial state, no check performed yet
  | { type: "checking" }
  | { type: "available"; info: UpdateInfo }
  | { type: "up-to-date" } // Explicitly checked, no updates available
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; info: UpdateInfo }
  | { type: "error"; phase: "check" | "download" | "install"; message: string };

/**
 * Manages application updates using electron-updater.
 *
 * This service integrates with Electron's auto-updater to:
 * - Check for updates automatically and on-demand
 * - Download updates in the background
 * - Notify the renderer process of update status changes
 * - Install updates when requested by the user
 */
export class UpdaterService {
  private updateStatus: UpdateStatus = { type: "idle" };
  private checkTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly fakeVersion: string | undefined;
  private readonly failPhase: "check" | "download" | "install" | undefined;
  private readonly debugFailureAttempts: Record<"check" | "download" | "install", number> = {
    check: 0,
    download: 0,
    install: 0,
  };
  private checkSource: "auto" | "manual" = "auto";
  private subscribers = new Set<(status: UpdateStatus) => void>();
  private currentChannel: UpdateChannel = "stable";

  constructor(initialChannel: UpdateChannel = "stable") {
    // Configure auto-updater
    autoUpdater.autoDownload = false; // Wait for user confirmation
    autoUpdater.autoInstallOnAppQuit = true;

    this.setupEventHandlers();

    this.currentChannel = initialChannel;
    this.applyChannel(initialChannel);

    // Parse DEBUG_UPDATER for dev mode and optional fake version/fail phase
    const debugConfig = parseDebugUpdater(
      process.env.DEBUG_UPDATER,
      process.env.DEBUG_UPDATER_FAIL
    );
    this.fakeVersion = debugConfig.fakeVersion;
    // DEBUG_UPDATER_FAIL only applies to fake version flows.
    this.failPhase = this.fakeVersion ? debugConfig.failPhase : undefined;

    if (debugConfig.enabled) {
      log.debug("Forcing dev update config (DEBUG_UPDATER is set)");
      autoUpdater.forceDevUpdateConfig = true;

      if (this.fakeVersion) {
        log.debug(`DEBUG_UPDATER fake version enabled: ${this.fakeVersion}`);

        if (this.failPhase) {
          log.debug(`DEBUG_UPDATER_FAIL: will simulate ${this.failPhase} failure`);
        }

        // Surface a pending update immediately in debug mode so the UI can
        // reliably exercise the "update available" state without waiting for
        // an explicit check action.
        //
        // When simulating check failures, keep the initial state as-is so
        // checkForUpdates() can drive the phase-aware error state.
        if (this.failPhase !== "check") {
          const version = this.fakeVersion;
          const fakeInfo = { version } satisfies Partial<UpdateInfo> as UpdateInfo;
          this.updateStatus = {
            type: "available",
            info: fakeInfo,
          };
        }
      }
    }
  }

  private applyChannel(channel: UpdateChannel) {
    const { owner, repo } = getGitHubRepo();
    if (channel === "nightly") {
      autoUpdater.allowPrerelease = true;
      autoUpdater.channel = "nightly";
      // Point at GitHub pre-releases for the nightly channel
      autoUpdater.setFeedURL({
        provider: "github",
        owner,
        repo,
        releaseType: "prerelease",
      });
    } else {
      autoUpdater.allowPrerelease = false;
      autoUpdater.channel = "latest";
      autoUpdater.setFeedURL({
        provider: "github",
        owner,
        repo,
        releaseType: "release",
      });
    }
  }

  private setupEventHandlers() {
    autoUpdater.on("checking-for-update", () => {
      log.debug("Checking for updates...");
      this.updateStatus = { type: "checking" };
      this.notifyRenderer();
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      log.info("Update available:", info.version);
      this.clearCheckTimeout();
      this.updateStatus = { type: "available", info };
      this.notifyRenderer();
    });

    autoUpdater.on("update-not-available", () => {
      log.debug("No updates available - up to date");
      this.clearCheckTimeout();
      this.updateStatus = { type: "up-to-date" };
      this.notifyRenderer();
    });

    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.round(progress.percent);
      log.debug(`Download progress: ${percent}%`);
      this.updateStatus = { type: "downloading", percent };
      this.notifyRenderer();
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      log.info("Update downloaded:", info.version);
      this.updateStatus = { type: "downloaded", info };
      this.notifyRenderer();
    });

    autoUpdater.on("error", (error) => {
      this.clearCheckTimeout();

      if (this.updateStatus.type === "checking") {
        if (isTransientUpdateError(error)) {
          if (this.checkSource === "manual") {
            log.warn("Manual update check hit transient error:", error.message);
            this.updateStatus = {
              type: "error",
              phase: "check",
              message: getUserVisibleCheckErrorMessage(error),
            };
            this.notifyRenderer();
            return;
          }

          log.debug("Auto update check hit transient error, backing off:", error.message);
          this.updateStatus = { type: "idle" };
          this.notifyRenderer();
          return;
        }

        log.error("Update check failed:", error);
        this.updateStatus = {
          type: "error",
          phase: "check",
          message: getUserVisibleCheckErrorMessage(error),
        };
        this.notifyRenderer();
        return;
      }

      const phase =
        this.updateStatus.type === "downloading"
          ? "download"
          : this.updateStatus.type === "downloaded"
            ? "install"
            : this.updateStatus.type === "error"
              ? this.updateStatus.phase
              : "check";
      log.error("Update error:", error);
      this.updateStatus = { type: "error", phase, message: error.message };
      this.notifyRenderer();
    });
  }

  private getDebugFailureMessage(phase: "check" | "download" | "install"): string {
    this.debugFailureAttempts[phase] += 1;
    const attempt = this.debugFailureAttempts[phase];

    if (attempt === 1) {
      return `Simulated ${phase} failure (DEBUG_UPDATER_FAIL)`;
    }

    return `Simulated ${phase} failure (DEBUG_UPDATER_FAIL, attempt ${attempt})`;
  }

  /**
   * Clear the check timeout
   */
  private clearCheckTimeout() {
    if (this.checkTimeout) {
      clearTimeout(this.checkTimeout);
      this.checkTimeout = null;
    }
  }

  /**
   * Check for updates manually
   *
   * This triggers the check but returns immediately. The actual results
   * will be delivered via event handlers (checking-for-update, update-available, etc.)
   *
   * A 30-second timeout ensures we don't stay in "checking" state indefinitely.
   */
  checkForUpdates(options?: { source?: "auto" | "manual" }): void {
    // Skip when a check/download is already in progress or an update
    // is ready to install — the 4-hour interval fires unconditionally,
    // and we don't want it clobbering active states.
    const dominated = ["checking", "downloading", "downloaded"] as const;
    if ((dominated as readonly string[]).includes(this.updateStatus.type)) {
      // If a check is already in flight and the user explicitly triggers a manual
      // check, upgrade the source so transient failures surface to the user.
      if (this.updateStatus.type === "checking" && options?.source === "manual") {
        this.checkSource = "manual";
      }
      log.debug(`checkForUpdates() skipped — current state: ${this.updateStatus.type}`);
      return;
    }

    this.checkSource = options?.source ?? "auto";

    log.debug("checkForUpdates() called");
    try {
      // Clear any existing timeout
      this.clearCheckTimeout();

      // Set checking status immediately
      log.debug("Setting status to 'checking'");
      this.updateStatus = { type: "checking" };
      this.notifyRenderer();

      // If fake version is set, simulate check completion or configured failure.
      if (this.fakeVersion) {
        log.debug(`Faking update available: ${this.fakeVersion}`);

        if (this.failPhase === "check") {
          setTimeout(() => {
            this.updateStatus = {
              type: "error",
              phase: "check",
              message: this.getDebugFailureMessage("check"),
            };
            this.notifyRenderer();
          }, 500);
          return;
        }

        const version = this.fakeVersion;
        setTimeout(() => {
          const fakeInfo = {
            version,
          } satisfies Partial<UpdateInfo> as UpdateInfo;
          this.updateStatus = {
            type: "available",
            info: fakeInfo,
          };
          this.notifyRenderer();
        }, 500); // Small delay to simulate check
        return;
      }

      // Set timeout to prevent hanging in "checking" state
      log.debug(`Setting ${UPDATE_CHECK_TIMEOUT_MS}ms timeout`);
      this.checkTimeout = setTimeout(() => {
        if (this.updateStatus.type === "checking") {
          if (this.checkSource === "manual") {
            log.warn(`Manual update check timed out after ${UPDATE_CHECK_TIMEOUT_MS}ms`);
            this.updateStatus = {
              type: "error",
              phase: "check",
              message: "Update check timed out",
            };
          } else {
            log.warn(
              `Auto update check timed out after ${UPDATE_CHECK_TIMEOUT_MS}ms — ` +
                `reverting to idle (will retry on next trigger)`
            );
            this.updateStatus = { type: "idle" };
          }
          this.notifyRenderer();
        } else {
          log.debug(`Timeout fired but status already changed to: ${this.updateStatus.type}`);
        }
      }, UPDATE_CHECK_TIMEOUT_MS);

      // Trigger the check (don't await - it never resolves, just fires events)
      log.debug("Calling autoUpdater.checkForUpdates()");
      autoUpdater.checkForUpdates().catch((error) => {
        this.clearCheckTimeout();
        const err = error instanceof Error ? error : new Error(String(error));
        if (isTransientUpdateError(err)) {
          if (this.checkSource === "manual") {
            log.warn("Manual update check promise rejected with transient error:", err.message);
            this.updateStatus = {
              type: "error",
              phase: "check",
              message: getUserVisibleCheckErrorMessage(err),
            };
          } else {
            log.debug(
              "Auto update check promise rejected with transient error, backing off:",
              err.message
            );
            this.updateStatus = { type: "idle" };
          }
          this.notifyRenderer();
          return;
        }
        log.error("Update check failed:", err.message);
        this.updateStatus = {
          type: "error",
          phase: "check",
          message: getUserVisibleCheckErrorMessage(err),
        };
        this.notifyRenderer();
      });
    } catch (error) {
      this.clearCheckTimeout();
      const err = error instanceof Error ? error : new Error("Unknown error");
      log.error("Update check error:", err.message);
      this.updateStatus = {
        type: "error",
        phase: "check",
        message: getUserVisibleCheckErrorMessage(err),
      };
      this.notifyRenderer();
    }
  }

  /**
   * Download an available update
   */
  async downloadUpdate(): Promise<void> {
    if (
      this.updateStatus.type !== "available" &&
      !(this.updateStatus.type === "error" && this.updateStatus.phase === "download")
    ) {
      throw new Error("No update available to download");
    }

    // If using fake version, simulate download progress
    if (this.fakeVersion) {
      log.debug(`Faking download for version ${this.fakeVersion}`);
      this.updateStatus = { type: "downloading", percent: 0 };
      this.notifyRenderer();

      if (this.failPhase === "download") {
        // Simulate partial progress before a phase-aware failure.
        for (let percent = 0; percent <= 40; percent += 10) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          this.updateStatus = { type: "downloading", percent };
          this.notifyRenderer();
        }

        this.updateStatus = {
          type: "error",
          phase: "download",
          message: this.getDebugFailureMessage("download"),
        };
        this.notifyRenderer();
        return;
      }

      // Simulate download progress
      for (let percent = 10; percent <= 100; percent += 10) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        this.updateStatus = { type: "downloading", percent };
        this.notifyRenderer();
      }

      // Mark as downloaded
      const version = this.fakeVersion;
      const fakeDownloadedInfo = { version } satisfies Partial<UpdateInfo> as UpdateInfo;
      this.updateStatus = {
        type: "downloaded",
        info: fakeDownloadedInfo,
      };
      this.notifyRenderer();
      return;
    }

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed";
      this.updateStatus = { type: "error", phase: "download", message };
      this.notifyRenderer();
    }
  }

  /**
   * Install a downloaded update and restart the app
   */
  installUpdate(): void {
    if (
      this.updateStatus.type !== "downloaded" &&
      !(this.updateStatus.type === "error" && this.updateStatus.phase === "install")
    ) {
      throw new Error("No update downloaded to install");
    }

    // If using fake version, simulate install behavior without restarting.
    if (this.fakeVersion) {
      if (this.failPhase === "install") {
        this.updateStatus = {
          type: "error",
          phase: "install",
          message: this.getDebugFailureMessage("install"),
        };
        this.notifyRenderer();
        return;
      }

      log.debug(`Fake update install requested for ${this.fakeVersion} - would restart app here`);
      return;
    }

    try {
      markUpdateInstallInProgress();
      autoUpdater.quitAndInstall();
    } catch (error) {
      clearUpdateInstallInProgress();
      const message = error instanceof Error ? error.message : "Install failed";
      this.updateStatus = { type: "error", phase: "install", message };
      this.notifyRenderer();
    }
  }

  getChannel(): UpdateChannel {
    return this.currentChannel;
  }

  setChannel(channel: UpdateChannel): void {
    if (this.currentChannel === channel) {
      return;
    }

    const blockedStates = ["checking", "downloading", "downloaded"] as const;
    if ((blockedStates as readonly string[]).includes(this.updateStatus.type)) {
      throw new Error(
        `Cannot switch update channel while ${this.updateStatus.type === "checking" ? "checking for updates" : this.updateStatus.type === "downloading" ? "downloading an update" : "an update is ready to install"}`
      );
    }

    this.currentChannel = channel;
    this.applyChannel(channel);
    this.updateStatus = { type: "idle" };
    this.notifyRenderer();
  }

  /**
   * Get the current update status
   */

  /**
   * Subscribe to status updates
   */
  subscribe(callback: (status: UpdateStatus) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
  getStatus(): UpdateStatus {
    return this.updateStatus;
  }

  /**
   * Notify the renderer process of status changes
   */
  private notifyRenderer() {
    log.debug("notifyRenderer() called, status:", this.updateStatus);
    // Notify subscribers (ORPC)
    for (const subscriber of this.subscribers) {
      try {
        subscriber(this.updateStatus);
      } catch (err) {
        log.error("Error notifying subscriber:", err);
      }
    }
  }
}
