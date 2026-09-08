import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { VERSION } from "@/version";
import type { RestartBlocker, UpdateStatus } from "@/common/orpc/types";
import type { UpdateChannel } from "@/common/types/project";
import { UPDATE_CHANNEL_LABELS } from "@/constants/updateChannels";
import XumLogoDark from "@/browser/assets/logos/xum-logo-dark.svg?react";
import XumLogoLight from "@/browser/assets/logos/xum-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { useAPI } from "@/browser/contexts/API";
import { useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { Button } from "@/browser/components/Button/Button";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";

const channelDescriptions: Record<UpdateChannel, string> = {
  stable: "Official releases only.",
  nightly: "Nightly pre-release builds from main.",
  npm: "Most recently published npm package, including pre-releases.",
};

const blockerLabels: Record<RestartBlocker["kind"], string> = {
  "active-streams": "Active streams",
  "pending-turns": "Pending turns",
  "workspace-inits": "Workspaces still initializing",
  "workspace-lifecycle": "Workspaces being archived, removed, forked, or staged",
  workflows: "Workflow runs in progress",
  projects: "Projects being cloned or created",
  requests: "Requests in flight",
  "desktop-sessions": "Live desktop sessions",
  "queued-messages": "Sessions with queued messages",
  "auto-retries": "Pending auto-retries",
  terminals: "Open terminals",
  "background-processes": "Running background processes",
};

interface VersionRecord {
  buildTime?: unknown;
  git?: unknown;
  git_describe?: unknown;
}

function formatExtendedTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function parseVersionInfo(version: unknown): { gitDescribe: string; buildTime: string } {
  if (typeof version !== "object" || version === null) {
    return {
      gitDescribe: "dev",
      buildTime: "Unknown build time",
    };
  }

  const versionRecord = version as VersionRecord;
  const gitDescribe =
    typeof versionRecord.git_describe === "string"
      ? versionRecord.git_describe
      : typeof versionRecord.git === "string"
        ? versionRecord.git
        : "dev";

  return {
    gitDescribe,
    buildTime:
      typeof versionRecord.buildTime === "string"
        ? formatExtendedTimestamp(versionRecord.buildTime)
        : "Unknown build time",
  };
}

export function AboutDialog() {
  const { isOpen, close } = useAboutDialog();
  const { api } = useAPI();
  const { theme } = useTheme();
  const XumLogo = theme === "dark" || theme.endsWith("-dark") ? XumLogoDark : XumLogoLight;
  const { gitDescribe, buildTime } = parseVersionInfo(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [supportedChannels, setSupportedChannels] = useState<UpdateChannel[]>([]);
  const [channelLoading, setChannelLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<"check" | "download" | "install" | null>(null);
  const channelRequestTokenRef = useRef(0);

  useEffect(() => {
    if (!isOpen || !api) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.update.onStatus(undefined, { signal });
        for await (const status of iterator) {
          if (signal.aborted) {
            break;
          }
          setUpdateStatus(status);
          setPendingAction(null);
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Update status stream error:", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api, isOpen]);

  useEffect(() => {
    if (!isOpen || !api) {
      return;
    }

    let active = true;
    // Ignore stale getChannel() responses when a newer request or manual selection has already happened.
    const requestToken = ++channelRequestTokenRef.current;

    api.update
      .getChannel()
      .then((result) => {
        if (active && requestToken === channelRequestTokenRef.current) {
          setChannel(result.channel);
          setSupportedChannels(result.supportedChannels);
        }
      })
      .catch(console.error);

    return () => {
      active = false;
    };
  }, [api, isOpen]);

  const canUseUpdateApi = Boolean(api);
  const isChecking =
    canUseUpdateApi &&
    (updateStatus.type === "checking" ||
      updateStatus.type === "downloading" ||
      pendingAction === "check");

  const handleChannelChange = (next: UpdateChannel) => {
    if (!api || next === channel || channelLoading) {
      return;
    }

    // Invalidate any in-flight getChannel() request so late responses cannot overwrite user intent.
    channelRequestTokenRef.current += 1;
    setChannelLoading(true);
    api.update
      .setChannel({ channel: next })
      .then(() => setChannel(next))
      .catch(console.error)
      .finally(() => setChannelLoading(false));
  };

  const handleCheckForUpdates = () => {
    if (!api) {
      return;
    }

    setPendingAction("check");
    api.update
      .check({ source: "manual" })
      .catch(console.error)
      // Clear pending if the backend no-ops (e.g. a check is already running) and emits no status event.
      .finally(() => setPendingAction((prev) => (prev === "check" ? null : prev)));
  };

  const handleDownload = () => {
    if (!api) {
      return;
    }

    setPendingAction("download");
    api.update
      .download(undefined)
      .catch(console.error)
      .finally(() => setPendingAction((prev) => (prev === "download" ? null : prev)));
  };

  const handleInstall = () => {
    if (!api) {
      return;
    }

    setPendingAction("install");
    api.update
      .install(undefined)
      .catch(console.error)
      .finally(() => setPendingAction((prev) => (prev === "install" ? null : prev)));
  };

  return (
    <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent
        maxWidth="520px"
        aria-describedby={undefined}
        className="titlebar-no-drag space-y-4"
      >
        <DialogTitle>About</DialogTitle>

        <div className="border-border-medium bg-modal-bg flex justify-center rounded-md border py-6">
          <XumLogo className="h-14 w-auto" aria-hidden="true" />
        </div>

        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted">Version</span>
            <span className="text-foreground font-mono">{gitDescribe}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted">Built</span>
            <span className="text-foreground text-right text-xs">{buildTime}</span>
          </div>
        </div>

        <div className="border-border-medium space-y-3 border-t pt-3">
          <div className="text-foreground text-sm font-medium">Updates</div>

          {updateStatus.type === "unsupported" ? (
            <div className="text-muted text-xs">{updateStatus.reason}</div>
          ) : !canUseUpdateApi ? (
            <div className="text-muted text-xs">Connecting to update service…</div>
          ) : (
            <>
              {channel !== null && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted text-xs">Channel</span>
                    <ToggleGroup
                      type="single"
                      value={channel}
                      onValueChange={(next) => {
                        if (next === "stable" || next === "nightly" || next === "npm") {
                          handleChannelChange(next);
                        }
                      }}
                      disabled={channelLoading || isChecking || pendingAction !== null}
                      aria-label="Update channel"
                      size="sm"
                    >
                      {supportedChannels.map((option) => (
                        <ToggleGroupItem key={option} value={option} size="sm">
                          {UPDATE_CHANNEL_LABELS[option]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="text-muted text-xs">{channelDescriptions[channel]}</div>
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                disabled={isChecking}
                onClick={handleCheckForUpdates}
              >
                {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Check for Updates
              </Button>

              {updateStatus.type === "checking" && (
                <div className="text-muted text-xs">Checking for updates…</div>
              )}

              {updateStatus.type === "available" && (
                <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="text-foreground min-w-0 text-xs break-words">
                    Update available: <span className="font-mono">{updateStatus.info.version}</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleDownload}
                    disabled={pendingAction === "download"}
                  >
                    {pendingAction === "download" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    Download
                  </Button>
                </div>
              )}

              {updateStatus.type === "downloading" && (
                <div className="text-muted text-xs">
                  {updateStatus.percent === null ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Downloading update…
                    </span>
                  ) : (
                    <>Downloading update: {updateStatus.percent}%</>
                  )}
                </div>
              )}

              {(updateStatus.type === "downloaded" || updateStatus.type === "install-blocked") && (
                <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="text-foreground min-w-0 text-xs break-words">
                    Ready to install: <span className="font-mono">{updateStatus.info.version}</span>
                  </div>
                  <Button size="sm" onClick={handleInstall} disabled={pendingAction === "install"}>
                    {pendingAction === "install" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {pendingAction === "install" ? "Installing…" : "Install & restart"}
                  </Button>
                </div>
              )}

              {updateStatus.type === "install-blocked" && (
                <div className="text-muted space-y-1 text-xs" role="status">
                  <div>Finish or stop this work, then retry the restart:</div>
                  <ul>
                    {updateStatus.blockers.map((blocker) => (
                      <li key={blocker.kind}>
                        {blockerLabels[blocker.kind]}:{" "}
                        <span className="counter-nums">{blocker.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {updateStatus.type === "up-to-date" && (
                <div className="text-muted text-xs">Xum is up to date.</div>
              )}

              {updateStatus.type === "idle" && (
                <div className="text-muted text-xs">Run a manual check to look for updates.</div>
              )}

              {updateStatus.type === "error" && (
                <div className="space-y-2">
                  <div className="text-destructive text-xs">
                    {updateStatus.phase === "download"
                      ? `Download failed: ${updateStatus.message}`
                      : updateStatus.phase === "install"
                        ? `Install failed: ${updateStatus.message}`
                        : `Update check failed: ${updateStatus.message}`}
                  </div>
                  <div className="flex items-center gap-2">
                    {updateStatus.phase === "download" && (
                      <Button
                        size="sm"
                        onClick={handleDownload}
                        disabled={pendingAction === "download"}
                      >
                        {pendingAction === "download" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Retry download
                      </Button>
                    )}
                    {updateStatus.phase === "install" && (
                      <Button
                        size="sm"
                        onClick={handleInstall}
                        disabled={pendingAction === "install"}
                      >
                        {pendingAction === "install" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Try install again
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCheckForUpdates}
                      disabled={isChecking}
                    >
                      {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {updateStatus.phase === "check" ? "Try again" : "Check again"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          <a
            href="https://github.com/coder/mux/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="titlebar-no-drag text-accent inline-block text-xs hover:underline"
          >
            View all releases
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
