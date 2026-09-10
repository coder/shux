/**
 * Terminal Window Entry Point
 *
 * Separate entry point for pop-out terminal windows.
 * Each window connects to a terminal session via WebSocket.
 */

import { installInactiveAnimationPause } from "@/browser/utils/inactiveAnimations";
import ReactDOM from "react-dom/client";
import { TerminalView } from "@/browser/components/TerminalView/TerminalView";
import { APIProvider, useAPI } from "@/browser/contexts/API";
import { TerminalRouterProvider } from "@/browser/terminal/TerminalRouterContext";
import { installWindowOpenLocalhostProxyNormalization } from "@/browser/utils/windowOpenLocalhostProxy";
import "./styles/globals.css";

function TerminalWindowContent(props: {
  workspaceId: string;
  sessionId: string;
  initialTitle?: string;
}) {
  const { api } = useAPI();

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      initialTitle={props.initialTitle}
      visible={true}
      onExit={() => {
        api?.terminal.closeWindow({ workspaceId: props.workspaceId }).catch((err) => {
          console.warn("[TerminalWindow] Failed to close terminal window:", err);
        });
      }}
    />
  );
}

try {
  installInactiveAnimationPause();
} catch {
  // Animation throttling is an optimization and must never block renderer startup.
}

installWindowOpenLocalhostProxyNormalization();

// Get workspace ID from query parameter
const params = new URLSearchParams(window.location.search);
const workspaceId = params.get("workspaceId");
const sessionId = params.get("sessionId");
const initialTitle = params.get("title") ?? undefined;

if (!workspaceId || !sessionId) {
  document.body.innerHTML = `
    <div style="color: #f44; padding: 20px; font-family: monospace;">
      Error: Missing workspace ID or session ID
    </div>
  `;
} else {
  document.title = `Terminal — ${workspaceId}`;

  // Don't use StrictMode for terminal windows to avoid double-mounting issues
  // StrictMode intentionally double-mounts components in dev, which causes
  // race conditions with WebSocket connections and terminal lifecycle
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <APIProvider>
      <TerminalRouterProvider>
        <TerminalWindowContent
          workspaceId={workspaceId}
          sessionId={sessionId}
          initialTitle={initialTitle}
        />
      </TerminalRouterProvider>
    </APIProvider>
  );
}
