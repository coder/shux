import { useEffect, useState } from "react";
import { cn } from "@/common/lib/utils";
import { VERSION } from "@/version";
import { SettingsButton } from "../SettingsButton/SettingsButton";
import { GatewayIcon } from "../icons/GatewayIcon/GatewayIcon";
import { ProviderIcon } from "../ProviderIcon/ProviderIcon";
import { Button } from "../Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import type { UpdateStatus } from "@/common/orpc/types";
import {
  AlertTriangle,
  BarChart3,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useRouting } from "@/browser/hooks/useRouting";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  formatMuxGatewayBalance,
  useMuxGatewayAccountStatus,
} from "@/browser/hooks/useMuxGatewayAccountStatus";
import {
  isDesktopMode,
  getTitlebarLeftInset,
  DESKTOP_TITLEBAR_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";

import { DEFAULT_MODEL_KEY, getModelKey } from "@/common/constants/storage";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import {
  getExplicitGatewayPrefix,
  normalizeSelectedModel,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Tooltip CTAs mirror their triggers so pointer users can act on the copy directly.
const TOOLTIP_CTA_CLASSNAME =
  "text-muted hover:text-foreground cursor-pointer border-0 bg-transparent p-0 text-left underline underline-offset-2 transition-colors";

interface VersionRecord {
  git?: unknown;
  git_describe?: unknown;
}

function getGitDescribe(version: unknown): string | undefined {
  if (typeof version !== "object" || version === null) {
    return undefined;
  }

  const versionRecord = version as VersionRecord;

  if (typeof versionRecord.git_describe === "string") {
    return versionRecord.git_describe;
  }

  if (typeof versionRecord.git === "string") {
    return versionRecord.git;
  }

  return undefined;
}

interface TitleBarProps {
  onBeforeOpenSettings?: () => void;
}

export function TitleBar(props: TitleBarProps) {
  const { api } = useAPI();
  const { open: openAboutDialog } = useAboutDialog();
  const policyState = usePolicy();
  const policyEnforced = policyState.status.state === "enforced";
  const { open: openSettings } = useSettings();
  const { isAnalyticsOpen, navigateToAnalytics, navigateFromAnalytics, currentWorkspaceId } =
    useRouter();
  const routing = useRouting();
  const [defaultModel] = usePersistedState<string>(DEFAULT_MODEL_KEY, WORKSPACE_DEFAULTS.model, {
    listener: true,
  });
  const workspaceModelKey = getModelKey(currentWorkspaceId ?? "__titlebar__");
  const [workspaceModelOverride] = usePersistedState<string | null>(workspaceModelKey, null, {
    listener: true,
  });
  const rawActiveModel =
    currentWorkspaceId &&
    typeof workspaceModelOverride === "string" &&
    workspaceModelOverride.trim().length > 0
      ? workspaceModelOverride.trim()
      : defaultModel;
  const activeModel = normalizeSelectedModel(rawActiveModel);
  const explicitGateway = getExplicitGatewayPrefix(activeModel);
  const canonicalActiveModel = normalizeToCanonical(activeModel);
  // Explicit gateway selections short-circuit route resolution: the user
  // intentionally pinned a gateway, so display that gateway directly.
  const activeRoute = explicitGateway
    ? {
        route: explicitGateway,
        isAuto: false,
        displayName: PROVIDER_DISPLAY_NAMES[explicitGateway] ?? explicitGateway,
      }
    : routing.resolveRoute(canonicalActiveModel);
  const activeRouteProvider = activeRoute.route;
  const isNonDirectRoute = activeRouteProvider !== "direct";
  const isMuxGatewayRoute = activeRouteProvider === "mux-gateway";
  const {
    data: muxGatewayAccountStatus,
    error: muxGatewayAccountError,
    refresh: refreshMuxGatewayAccountStatus,
  } = useMuxGatewayAccountStatus();

  const gitDescribe = getGitDescribe(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [versionTooltipOpen, setVersionTooltipOpen] = useState(false);
  const [routeTooltipOpen, setRouteTooltipOpen] = useState(false);

  const handleOpenAboutDialog = () => {
    setVersionTooltipOpen(false);
    openAboutDialog();
  };

  const handleOpenRouteSettings = () => {
    setRouteTooltipOpen(false);
    openSettings("providers", { expandProvider: activeRouteProvider });
  };

  useEffect(() => {
    // Skip update checks in browser mode - app updates only apply to Electron
    if (!window.api) {
      return;
    }

    if (!api) {
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
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Update status stream error:", error);
        }
      }
    })();

    // Check for updates on mount
    api.update.check({ source: "auto" }).catch(console.error);

    // Check periodically
    const checkInterval = setInterval(() => {
      api.update.check({ source: "auto" }).catch(console.error);
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(checkInterval);
    };
  }, [api]);

  const updateBadgeIcon = (() => {
    if (updateStatus.type === "available") {
      return <Download className="size-3.5" />;
    }

    if (updateStatus.type === "downloaded") {
      return <RefreshCw className="size-3.5" />;
    }

    if (updateStatus.type === "downloading" || updateStatus.type === "checking") {
      return <Loader2 className="size-3.5 animate-spin" />;
    }

    if (updateStatus.type === "error") {
      return <AlertTriangle className="size-3.5" />;
    }

    return null;
  })();

  // In desktop mode, add left padding for macOS traffic lights
  const leftInset = getTitlebarLeftInset();
  const isDesktop = isDesktopMode();

  return (
    <div
      className={cn(
        "bg-sidebar border-border-light font-primary text-muted titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center justify-between border-b px-4 text-[11px] select-none",
        isDesktop ? DESKTOP_TITLEBAR_HEIGHT_CLASS : "h-8",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag"
      )}
    >
      <div
        // Desktop titlebar: this wrapper is `flex-1` (for version ellipsis) so it fills the gap.
        // Keep it draggable; apply `titlebar-no-drag` only to the interactive controls inside.
        className={cn(
          "mr-4 flex min-w-0 flex-1",
          leftInset > 0 ? "flex-col" : "items-center gap-2"
        )}
      >
        <Tooltip open={versionTooltipOpen} onOpenChange={setVersionTooltipOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Open about dialog"
              className={cn(
                // Keep the version row shrinkable so long git-describe values ellipsize
                // instead of overlapping the gateway/settings controls.
                "flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit transition-opacity hover:opacity-70",
                isDesktop && "titlebar-no-drag"
              )}
              onClick={handleOpenAboutDialog}
            >
              <div
                className={cn(
                  "min-w-0 flex-1 truncate font-normal tracking-wider",
                  leftInset > 0 ? "text-[10px]" : "text-xs"
                )}
              >
                {gitDescribe ?? "(dev)"}
              </div>
              {updateBadgeIcon && (
                <div className="text-accent flex h-3.5 w-3.5 items-center justify-center">
                  {updateBadgeIcon}
                </div>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent align="start">
            <button type="button" className={TOOLTIP_CTA_CLASSNAME} onClick={handleOpenAboutDialog}>
              Click for more details
            </button>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className={cn("flex shrink-0 items-center gap-1.5", isDesktop && "titlebar-no-drag")}>
        {isNonDirectRoute && (
          <Tooltip open={routeTooltipOpen} onOpenChange={setRouteTooltipOpen}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenRouteSettings}
                onMouseEnter={() => {
                  if (isMuxGatewayRoute) {
                    void refreshMuxGatewayAccountStatus();
                  }
                }}
                className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 flex h-5 w-5 cursor-pointer items-center justify-center rounded border transition-opacity hover:opacity-70"
                aria-label={`${activeRoute.displayName} routing`}
              >
                {isMuxGatewayRoute ? (
                  <GatewayIcon className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ProviderIcon provider={activeRouteProvider} className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent align="end" className={cn(isMuxGatewayRoute ? "w-56" : "w-64")}>
              <div className="text-foreground text-[11px] font-medium">
                {activeRoute.displayName}
              </div>
              {isMuxGatewayRoute ? (
                <>
                  <div className="mt-1.5 space-y-0.5 text-[11px]">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted">Balance</span>
                      <span className="text-foreground font-mono">
                        {formatMuxGatewayBalance(muxGatewayAccountStatus?.remaining_microdollars)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted">Concurrent requests</span>
                      <span className="text-foreground font-mono">
                        {muxGatewayAccountStatus?.ai_gateway_concurrent_requests_per_user ?? "—"}
                      </span>
                    </div>
                  </div>
                  {muxGatewayAccountError && (
                    <div className="text-destructive mt-1.5 text-[10px]">
                      {muxGatewayAccountError}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-muted mt-1.5 text-[11px]">
                  Requests for this model route via {activeRoute.displayName}.
                </div>
              )}
              <div className="border-separator-light mt-2 border-t pt-1.5 text-[10px]">
                <button
                  type="button"
                  className={TOOLTIP_CTA_CLASSNAME}
                  onClick={handleOpenRouteSettings}
                >
                  {isMuxGatewayRoute
                    ? "Click to open gateway settings"
                    : "Click to open provider settings"}
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        {policyEnforced && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="img"
                aria-label="Settings controlled by policy"
                className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 flex h-5 w-5 items-center justify-center rounded border"
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              </div>
            </TooltipTrigger>
            <TooltipContent align="end">Your settings are controlled by a policy.</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (isAnalyticsOpen) {
                  navigateFromAnalytics();
                  return;
                }
                navigateToAnalytics();
              }}
              className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
              aria-label={isAnalyticsOpen ? "Close analytics" : "Open analytics"}
              data-testid="analytics-button"
            >
              {isAnalyticsOpen ? (
                <X className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <BarChart3 className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isAnalyticsOpen
              ? "Close analytics"
              : `Open analytics (${formatKeybind(KEYBINDS.OPEN_ANALYTICS)})`}
          </TooltipContent>
        </Tooltip>
        <SettingsButton
          // On touch/mobile, opening settings from the sidebar should also dismiss the
          // off-canvas sidebar so users are not stuck with it covering the settings page.
          onBeforeOpenSettings={props.onBeforeOpenSettings}
        />
      </div>
    </div>
  );
}
