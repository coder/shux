import { getErrorMessage } from "@/common/utils/errors";
import type { RestartBlocker, UpdateStatus } from "@/common/orpc/types";
import type { UpdateChannel } from "@/common/types/project";
import { log } from "@/node/services/log";
import { activateUpdate } from "./activation";
import {
  inferChannel,
  isExactVersion,
  type InstallLayout,
  type LayoutResult,
} from "./installLayout";
import { fetchDistTags, fetchNewestVersion } from "./registry";
import { stageUpdate } from "./staging";

export interface ServerUpdaterDeps {
  /** Refreshes lazily updated blocker sources; the snapshot that follows stays synchronous. */
  refreshBlockers?: () => Promise<void>;
  collectBlockers: () => RestartBlocker[];
  restart: () => Promise<void>;
  fetchDistTags?: typeof fetchDistTags;
  fetchNewestVersion?: typeof fetchNewestVersion;
  runInstall?: typeof stageUpdate;
  activate?: typeof activateUpdate;
}

export class ServerUpdater {
  private status: UpdateStatus;
  private channel: UpdateChannel;
  private readonly layout: InstallLayout | null;
  private readonly subscribers = new Set<(status: UpdateStatus) => void>();
  private availableVersion: string | null = null;
  private staged: { entry: string; version: string } | null = null;
  private installing = false;
  private shuttingDown = false;
  private download: { abort: AbortController; settled: Promise<void> } | null = null;

  constructor(
    result: LayoutResult,
    channel: UpdateChannel | undefined,
    private readonly deps: ServerUpdaterDeps
  ) {
    this.layout = result.supported ? result.layout : null;
    this.channel = channel ?? inferChannel(this.layout?.version ?? "");
    this.status = result.supported
      ? { type: "idle" }
      : { type: "unsupported", reason: result.reason };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }
  getChannel(): UpdateChannel {
    return this.channel;
  }

  subscribe(callback: (status: UpdateStatus) => void): () => void {
    this.subscribers.add(callback);
    callback(this.status);
    return () => this.subscribers.delete(callback);
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    for (const callback of this.subscribers) {
      try {
        callback(status);
      } catch (error) {
        log.error("Server update subscriber failed", error);
      }
    }
  }

  setChannel(channel: UpdateChannel): void {
    if (channel === this.channel) return;
    if (this.installing || this.status.type === "checking" || this.status.type === "downloading")
      throw new Error("An update operation is in progress");
    // An unsupported layout still records the preference so it applies once the operator has
    // met the reported requirement and restarted.
    this.channel = channel;
    if (!this.layout) return;
    this.availableVersion = null;
    this.staged = null;
    this.setStatus({ type: "idle" });
  }

  async checkForUpdates(options?: { source?: "auto" | "manual" }): Promise<void> {
    if (
      !this.layout ||
      this.shuttingDown ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading"
    )
      return;
    const previous = this.status;
    this.setStatus({ type: "checking" });
    try {
      const version =
        this.channel === "npm"
          ? await (this.deps.fetchNewestVersion ?? fetchNewestVersion)(this.layout.registry)
          : (await (this.deps.fetchDistTags ?? fetchDistTags)(this.layout.registry))[
              this.channel === "stable" ? "latest" : "next"
            ];
      if (!isExactVersion(version))
        throw new Error("Registry has no valid version for the selected channel");
      this.availableVersion = version === this.layout.version ? null : version;
      // A staged download stays installable while the channel still points at it, so a re-check
      // after a failed install returns to the ready state instead of discarding the download.
      if (this.staged && this.staged.version !== this.availableVersion) this.staged = null;
      this.setStatus(
        this.staged
          ? { type: "downloaded", info: { version } }
          : this.availableVersion
            ? { type: "available", info: { version } }
            : { type: "up-to-date" }
      );
    } catch (error) {
      // A verified stage stays installable while the registry is unreachable; the dialog offers no
      // install action on a check error.
      if (this.staged) {
        log.warn("Update check failed; the staged update remains installable", error);
        this.setStatus({ type: "downloaded", info: { version: this.staged.version } });
        return;
      }
      this.setStatus(
        options?.source === "auto"
          ? previous
          : { type: "error", phase: "check", message: getErrorMessage(error) }
      );
    }
  }

  async downloadUpdate(): Promise<void> {
    if (
      !this.layout ||
      this.shuttingDown ||
      !this.availableVersion ||
      this.staged ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading"
    )
      return;
    this.setStatus({ type: "downloading", percent: null });
    const abort = new AbortController();
    const download = {
      abort,
      settled: this.stage(this.layout, this.availableVersion, abort.signal),
    };
    this.download = download;
    await download.settled;
    if (this.download === download) this.download = null;
  }

  private async stage(layout: InstallLayout, version: string, signal: AbortSignal): Promise<void> {
    try {
      const entry = await (this.deps.runInstall ?? stageUpdate)(layout, version, { signal });
      this.staged = { entry, version };
      this.setStatus({ type: "downloaded", info: { version } });
    } catch (error) {
      this.setStatus({ type: "error", phase: "download", message: getErrorMessage(error) });
    }
  }

  /** A detached package manager must not outlive the server and keep writing into the stage. */
  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.download?.abort.abort();
    await this.download?.settled;
  }

  /**
   * `force` skips the blocker gate: the restart callback is the same graceful shutdown a
   * supervisor restart runs, so in-flight streams are aborted with their partials committed and
   * terminals and background processes are closed rather than left orphaned.
   */
  async installUpdate(options?: { force?: boolean }): Promise<void> {
    if (!this.layout || this.shuttingDown || !this.staged || this.installing) return;
    const staged = this.staged;
    this.installing = true;
    try {
      if (!options?.force) {
        await this.deps.refreshBlockers?.();
        // An unrelated teardown (SIGTERM) may have begun during the refresh; it must not inherit
        // the launcher swap.
        if (this.shuttingDown) {
          this.installing = false;
          return;
        }
        const blockers = this.deps.collectBlockers();
        if (blockers.length) {
          this.installing = false;
          this.setStatus({
            type: "install-blocked",
            info: { version: staged.version },
            blockers,
          });
          return;
        }
      }
      // No await between the idle snapshot, atomic swap, and the CLI's shutdown latch.
      (this.deps.activate ?? activateUpdate)(this.layout, staged.entry);
      await this.deps.restart();
    } catch (error) {
      this.installing = false;
      this.setStatus({ type: "error", phase: "install", message: getErrorMessage(error) });
    }
  }
}
