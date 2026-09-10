import React from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "xum/browser/components/ErrorBoundary/ErrorBoundary";
import { App } from "./App";
import { getVscodeBridge } from "./vscodeBridge";

const bridge = getVscodeBridge();

const rootEl = document.getElementById("root");
if (!rootEl) {
  bridge.debugLog("fatal: missing #root element");
  throw new Error("mux webview: missing #root element");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary workspaceInfo="VS Code webview">
      <App bridge={bridge} />
    </ErrorBoundary>
  </React.StrictMode>
);
