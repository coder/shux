import { log } from "@/node/services/log";
import type { UpdateStatus } from "@/common/orpc/types";
import type { UpdateChannel } from "@/common/types/project";
import { parseDebugUpdater } from "@/common/utils/env";
import type { Config } from "@/node/config";
import { ServerUpdater, type ServerUpdaterDeps } from "./serverUpdate/serverUpdater";
import type { LayoutResult } from "./serverUpdate/installLayout";

// Keep the Electron implementation out of CLI value imports.
interface UpdaterImpl {
  checkForUpdates(options?: { source?: "auto" | "manual" }): void | Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): void | Promise<void>;
  beginShutdown?(): Promise<void>;
  subscribe(callback: (status: UpdateStatus) => void): () => void;
  getStatus(): UpdateStatus;
  getChannel(): UpdateChannel;
  setChannel(channel: UpdateChannel): void;
}

export class UpdateService {
  private impl: UpdaterImpl | null = null;
  private currentStatus: UpdateStatus = {
    type: "unsupported",
    reason: "Server updater is not enabled for this process",
  };
  // Keep the user's stable/nightly preference loaded from config at startup so
  // the About dialog and updater initialization share the same persisted value.
  private currentChannel: UpdateChannel;
  private subscribers = new Set<(status: UpdateStatus) => void>();
  private readonly ready: Promise<void>;
  private channelChange: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {
    this.currentChannel = this.config.getUpdateChannel();
    this.ready = this.initialize().catch((err) => {
      log.error("Failed to initialize UpdateService:", err);
    });
  }

  private async initialize() {
    // Check if running in Electron Main process
    if (process.versions.electron) {
      try {
        // Dynamic import to avoid loading electron-updater in CLI
        // eslint-disable-next-line no-restricted-syntax
        const { UpdaterService: DesktopUpdater } = await import("@/desktop/updater");
        this.impl = new DesktopUpdater(this.currentChannel);

        // Forward updates
        this.impl.subscribe((status: UpdateStatus) => {
          this.currentStatus = status;
          this.notifySubscribers();
        });

        // Sync initial status and push it in case subscribers connected before
        // the updater implementation finished initializing.
        this.currentStatus = this.impl.getStatus();
        this.notifySubscribers();
      } catch (err) {
        log.debug(
          "UpdateService: Failed to load desktop updater (likely CLI mode or missing dep):",
          err
        );
      }
    }
  }

  async enableServerUpdater(layout: LayoutResult, deps: ServerUpdaterDeps): Promise<void> {
    await this.ready;
    if (process.versions.electron) return;
    this.impl = new ServerUpdater(layout, this.config.loadConfigOrDefault().updateChannel, deps);
    this.impl.subscribe((status) => {
      this.currentStatus = status;
      this.notifySubscribers();
    });
  }

  async check(options?: { source?: "auto" | "manual" }): Promise<void> {
    await this.ready;
    if (this.impl) {
      if (process.versions.electron) {
        try {
          // eslint-disable-next-line no-restricted-syntax
          const { app } = await import("electron");

          const debugConfig = parseDebugUpdater(process.env.DEBUG_UPDATER);
          if (!app.isPackaged && !debugConfig.enabled) {
            log.debug("UpdateService: Updates disabled in dev mode");
            // Ensure status is idle so frontend doesn't show spinner.
            // Always notify so frontend clears isCheckingOnHover state.
            this.currentStatus = { type: "idle" };
            this.notifySubscribers();
            return;
          }
        } catch (err) {
          // Ignore errors (e.g. if modules not found), proceed to check
          log.debug("UpdateService: Error checking env:", err);
        }
      }
      await this.impl.checkForUpdates(options);
    } else {
      log.debug("UpdateService: check() called but no implementation (CLI mode)");
    }
  }

  async download(): Promise<void> {
    await this.ready;
    if (this.impl) {
      await this.impl.downloadUpdate();
    }
  }

  async install(): Promise<void> {
    if (this.impl) {
      await this.impl.installUpdate();
    }
  }

  async beginShutdown(): Promise<void> {
    await this.impl?.beginShutdown?.();
  }

  getChannel(): UpdateChannel {
    if (this.impl) {
      return this.impl.getChannel();
    }

    return this.currentChannel;
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    // Persist, switch, and roll back run as one transaction: a second change interleaving with
    // them could leave the runtime on one channel and the config on another.
    const change = this.channelChange.then(() => this.changeChannel(channel));
    this.channelChange = change.catch(() => undefined);
    await change;
  }

  private async changeChannel(channel: UpdateChannel): Promise<void> {
    await this.ready;
    if (this.impl && this.currentStatus.type === "unsupported") return;
    // The runtime switch discards a staged update, so persist first: a failed write then costs
    // nothing, and a runtime refusal (operation in progress) reverts the write so the two never
    // disagree.
    const previous = this.impl?.getChannel() ?? this.currentChannel;
    await this.config.setUpdateChannel(channel);
    try {
      this.impl?.setChannel(channel);
    } catch (error) {
      await this.config.setUpdateChannel(previous);
      throw error;
    }
    this.currentChannel = channel;
  }

  onStatus(callback: (status: UpdateStatus) => void): () => void {
    // Send current status immediately
    callback(this.currentStatus);

    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers() {
    for (const sub of this.subscribers) {
      try {
        sub(this.currentStatus);
      } catch (err) {
        log.error("Error in UpdateService subscriber:", err);
      }
    }
  }
}
