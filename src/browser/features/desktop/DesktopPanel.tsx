import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertCircle, Loader2, MonitorOff } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { assertNever } from "@/common/utils/assertNever";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { DESKTOP_VIEWPORT_ATTR } from "@/browser/utils/ui/keybinds";
import { useAPI } from "@/browser/contexts/API";
import { getDesktopPopout } from "./desktopPopout";
import { DesktopToolbar } from "./DesktopToolbar";
import { useDesktopConnection, type UseDesktopConnectionResult } from "./useDesktopConnection";

interface StatusPresentation {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

function getStatusPresentation(desktop: UseDesktopConnectionResult): StatusPresentation {
  switch (desktop.state) {
    case "checking":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Checking desktop availability",
        description: "Starting desktop session…",
      };
    case "connecting":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Connecting to desktop",
        description: "Establishing the live desktop stream…",
      };
    case "unavailable":
      return {
        icon: <MonitorOff aria-hidden className="h-8 w-8" />,
        title: "Desktop unavailable",
        description: desktop.reason ?? "Desktop sessions are unavailable for this workspace.",
      };
    case "disconnected":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Reconnecting…",
        description: "Refreshing the desktop connection with a new session token.",
      };
    case "error":
      return {
        icon: <AlertCircle aria-hidden className="text-destructive h-8 w-8" />,
        title: "Desktop connection failed",
        description: desktop.reason ?? "An unexpected desktop connection error occurred.",
        action: (
          <Button onClick={desktop.connect} size="sm" variant="outline">
            Retry
          </Button>
        ),
      };
    case "idle":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Preparing desktop",
        description: "Waiting to connect to the live desktop.",
      };
    case "connected":
      return {
        icon: null,
        title: "",
        description: "",
      };
    default:
      return assertNever(desktop.state);
  }
}

function StatusOverlay(props: { desktop: UseDesktopConnectionResult }) {
  const presentation = getStatusPresentation(props.desktop);

  return (
    <div className="bg-background text-foreground flex h-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {presentation.icon}
      <div className="space-y-1">
        <p className="text-sm font-medium">{presentation.title}</p>
        <p className="text-muted-foreground text-sm">{presentation.description}</p>
      </div>
      {presentation.action}
    </div>
  );
}

export function DesktopViewer(props: {
  workspaceId: string;
  onDetach?: () => void;
  onBringBack?: () => void;
  attach?: (desktop: UseDesktopConnectionResult) => () => void;
  onStartupError?: () => void;
  /** See UseDesktopConnectionOptions.nativeWindowCleanup. */
  nativeWindowCleanup?: boolean;
  /** See UseDesktopConnectionOptions.unmountKeepsGrace. */
  unmountKeepsGrace?: () => boolean;
  /**
   * Mounted while the desktop is shown in a popout: do not connect; the popout coordinator
   * registers the pane once it has confirmed a live child and resumes the connection when the
   * desktop comes back.
   */
  suspended?: boolean;
  hidden?: boolean;
}) {
  const desktop = useDesktopConnection(props.workspaceId, {
    nativeWindowCleanup: props.nativeWindowCleanup,
    unmountKeepsGrace: props.unmountKeepsGrace,
  });

  useEffect(() => {
    const detach = props.attach?.(desktop);
    if (!props.suspended) desktop.connect();
    return detach;
    // disconnect handled by hook's own cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStartupError = props.onStartupError;
  useEffect(() => {
    if (desktop.state === "error" || desktop.state === "unavailable") onStartupError?.();
  }, [desktop.state, onStartupError]);

  return (
    <div
      className="bg-background @container flex h-full min-h-0 min-w-0 flex-col"
      hidden={props.hidden}
    >
      {desktop.sharedDesktop && (
        <div className="text-muted-foreground border-border shrink-0 truncate border-b px-3 py-1.5 text-xs">
          Shared desktop · {desktop.sharedDesktop.ownerName}
        </div>
      )}
      <DesktopToolbar
        connected={desktop.state === "connected"}
        controlling={desktop.controlling}
        scaleToFit={desktop.scaleToFit}
        onToggleControl={() => desktop.setControlling(!desktop.controlling)}
        onToggleScale={() => desktop.setScaleToFit(!desktop.scaleToFit)}
        onDetach={props.onDetach}
        onBringBack={props.onBringBack}
      />
      {desktop.state === "connected" ? null : <StatusOverlay desktop={desktop} />}
      <div
        ref={desktop.containerRef}
        {...{ [DESKTOP_VIEWPORT_ATTR]: "" }}
        className="bg-background min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{ display: desktop.state === "connected" ? "block" : "none" }}
      />
    </div>
  );
}

export function DesktopPanel(props: { workspaceId: string }) {
  // A workspace switch disposes its viewer, token, and shared-target label together.
  return <WorkspaceDesktopPanel key={props.workspaceId} workspaceId={props.workspaceId} />;
}

function WorkspaceDesktopPanel(props: { workspaceId: string }) {
  const { api } = useAPI();
  const [popout] = useState(() => getDesktopPopout(props.workspaceId));
  const snapshot = useSyncExternalStore(popout.subscribe, popout.getSnapshot);
  const [actionError, setActionError] = useState<string | null>(null);
  const reportError = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    if (!api) return;
    const reconcile = () => {
      popout.reconcile(api.desktop).catch(reportError);
    };
    reconcile();
    window.addEventListener("focus", reconcile);
    return () => window.removeEventListener("focus", reconcile);
  }, [api, popout]);
  // A new user action supersedes the previous failure, regardless of whether it came
  // from a button or its keyboard shortcut. Keep open() in the synchronous gesture.
  const detach = () => {
    setActionError(null);
    if (api) popout.open(api.desktop).catch(reportError);
  };
  const bringBack = () => {
    setActionError(null);
    popout.bringBack().catch(reportError);
  };
  const recover = () => {
    setActionError(null);
    if (api) popout.recover(api.desktop).catch(reportError);
  };
  const inline = snapshot.state === "inline" || snapshot.state === "opening";
  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      {(snapshot.error ?? actionError) ? (
        <p role="alert" className="text-destructive p-2 text-xs">
          {snapshot.error ?? actionError}
        </p>
      ) : null}
      {/* The viewer stays mounted (hidden) while detached so its viewer registration keeps the
          pane attached across the inline↔popout handoff; otherwise nothing would mark the
          desktop as in use between the source disconnecting and the destination registering,
          and an agent-driven archive could close it mid-handoff. */}
      {snapshot.state !== "checking" ? (
        <DesktopViewer
          workspaceId={props.workspaceId}
          attach={(desktop) =>
            popout.attach(desktop.suspend, desktop.connect, !inline, desktop.register)
          }
          // Unmounting while a popout is opening (or showing the desktop) is not this pane
          // giving the desktop up: the child takes over, so leave the grace for the gap.
          unmountKeepsGrace={() => popout.getSnapshot().state !== "inline"}
          onDetach={detach}
          suspended={!inline}
          hidden={!inline}
        />
      ) : null}
      {inline ? null : (
        <div
          className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-4 text-center"
          onKeyDown={(event) => {
            if (
              ["b", "r"].includes(event.key.toLowerCase()) &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              event.preventDefault();
              stopKeyboardPropagation(event);
              if (event.key.toLowerCase() === "b") bringBack();
              else recover();
            }
          }}
        >
          <MonitorOff aria-hidden className="h-8 w-8" />
          <p className="text-sm">
            {snapshot.state === "checking"
              ? "Checking desktop window…"
              : "Desktop is open in a separate window"}
          </p>
          <Button size="sm" variant="outline" onClick={bringBack} aria-keyshortcuts="B">
            Bring back
          </Button>
          <Button size="sm" variant="ghost" aria-keyshortcuts="R" onClick={recover}>
            Reconnect here
          </Button>
        </div>
      )}
    </div>
  );
}
