import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { DesktopViewer } from "@/browser/features/desktop/DesktopPanel";
import {
  desktopPopoutChannel,
  isDesktopPopoutMessage,
  type DesktopPopoutCloseRequest,
} from "@/browser/features/desktop/desktopPopout";
import {
  DESKTOP_POPOUT_READY_TIMEOUT_MS,
  DESKTOP_POPOUT_CLOSE_EVENT,
} from "@/common/constants/desktop";
import { getErrorMessage } from "@/common/utils/errors";
import "./styles/globals.css";

function DesktopWindow(props: { workspaceId: string; instanceId: string }) {
  const [granted, setGranted] = useState(false);
  const grantedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const disconnectRef = useRef<(() => Promise<void>) | null>(null);
  const disconnectNowRef = useRef<(() => void) | null>(null);
  const finishingRef = useRef<Promise<void> | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const finishedRef = useRef(false);
  const finish = (failed = false): Promise<void> => {
    if (finishingRef.current) return finishingRef.current;
    finishedRef.current = true;
    const closing = (async () => {
      // Wait for the transport close before acknowledging cleanup or destroying this renderer.
      await disconnectRef.current?.();
      setGranted(false);
      channelRef.current?.postMessage({
        type: failed ? "failed" : "closed",
        instanceId: props.instanceId,
      });
      window.close();
    })();
    finishingRef.current = closing;
    return closing;
  };
  const requestFinish = (failed = false) => {
    finish(failed).catch((error: unknown) => setError(getErrorMessage(error)));
  };

  useEffect(() => {
    let channel: BroadcastChannel;
    try {
      channel = desktopPopoutChannel(props.workspaceId);
    } catch (error) {
      setError(getErrorMessage(error));
      return;
    }
    channelRef.current = channel;
    const deadline = setTimeout(() => {
      setError(
        "The desktop handoff did not complete. Close this window and reconnect in the workspace."
      );
    }, DESKTOP_POPOUT_READY_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        !isDesktopPopoutMessage(event.data) ||
        event.data.instanceId !== props.instanceId ||
        finishedRef.current
      )
        return;
      if (event.data.type === "grant") {
        clearTimeout(deadline);
        setError(null);
        grantedRef.current = true;
        setGranted(true);
        channel.postMessage({ type: "opened", instanceId: props.instanceId });
      } else if (event.data.type === "bring-back") requestFinish();
      else if (event.data.type === "ping" && grantedRef.current) {
        // A reloaded parent only holds a persisted hint; confirm this window is still live.
        channel.postMessage({ type: "opened", instanceId: props.instanceId });
      }
    };
    const onDirectClose = (event: Event) => {
      const request = (event as CustomEvent<DesktopPopoutCloseRequest | undefined>).detail;
      if (!request || request.instanceId !== props.instanceId) return;
      request.handled = true;
      request.completion = finish();
      request.completion.catch((error: unknown) => setError(getErrorMessage(error)));
    };
    window.addEventListener(DESKTOP_POPOUT_CLOSE_EVENT, onDirectClose);
    const onClose = () => requestFinish();
    window.addEventListener("pagehide", onClose);
    channel.postMessage({ type: "ready", instanceId: props.instanceId });
    return () => {
      clearTimeout(deadline);
      window.removeEventListener("pagehide", onClose);
      window.removeEventListener(DESKTOP_POPOUT_CLOSE_EVENT, onDirectClose);
      disconnectNowRef.current?.();
      channel.close();
      channelRef.current = null;
    };
    // This window's identity is fixed for its entire lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return granted ? (
    <DesktopViewer
      workspaceId={props.workspaceId}
      nativeWindowCleanup
      attach={(desktop) => {
        disconnectNowRef.current = desktop.disconnect;
        disconnectRef.current = desktop.disconnectAndWait;
        return () => {
          disconnectRef.current = null;
          disconnectNowRef.current = null;
        };
      }}
      onBringBack={() => requestFinish()}
      onStartupError={() => requestFinish(true)}
    />
  ) : (
    <p role="status" className="text-muted-foreground p-6 text-sm">
      {error ?? "Waiting for the workspace to release its desktop…"}
    </p>
  );
}

const params = new URLSearchParams(window.location.search);
const workspaceId = params.get("workspaceId");
const instanceId = params.get("instanceId");
const root = document.getElementById("root");
if (root) {
  document.title = "Desktop";
  ReactDOM.createRoot(root).render(
    <APIProvider>
      <ThemeProvider>
        {workspaceId && instanceId ? (
          <DesktopWindow workspaceId={workspaceId} instanceId={instanceId} />
        ) : (
          <p role="alert" className="text-destructive p-6">
            Missing desktop workspace or window identity.
          </p>
        )}
      </ThemeProvider>
    </APIProvider>
  );
}
