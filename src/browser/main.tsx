import React from "react";
import ReactDOM from "react-dom/client";
import { installBrowserLogCapture } from "@/browser/utils/browserLog";
import { installWindowOpenLocalhostProxyNormalization } from "@/browser/utils/windowOpenLocalhostProxy";
import { installInactiveAnimationPause } from "@/browser/utils/inactiveAnimations";
import { installViewportHeightSync } from "@/browser/utils/viewportHeight";
import { AppLoader } from "@/browser/components/AppLoader/AppLoader";
import { initTelemetry, trackAppStarted } from "@/common/telemetry";
import { initTitlebarInsets } from "@/browser/hooks/useDesktopTitlebar";
import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";

// Initialize telemetry on app startup
try {
  installBrowserLogCapture();
} catch {
  // Silent failure — never crash the app for logging capture
}

try {
  installInactiveAnimationPause();
} catch {
  // Animation throttling is an optimization and must never block renderer startup.
}

installWindowOpenLocalhostProxyNormalization();
installViewportHeightSync();

initTelemetry();
trackAppStarted();

// Initialize titlebar CSS custom properties (platform-specific insets)
initTitlebarInsets();

// Global error handlers for renderer process
// These catch errors that escape the ErrorBoundary
window.addEventListener("error", (event) => {
  console.error("Uncaught error in renderer:", event.error);
  console.error("Error details:", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
    stack: event.error?.stack,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection in renderer:", event.reason);
  console.error("Promise:", event.promise);
  if (event.reason instanceof Error) {
    console.error("Stack:", event.reason.stack);
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppLoader />
  </React.StrictMode>
);

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  const isHttpProtocol =
    window.location.protocol === "http:" || window.location.protocol === "https:";
  if (isHttpProtocol) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register(resolveBrowserAssetUrl("service-worker.js"))
        .then((registration) => {
          console.log("Service Worker registered:", registration);
        })
        .catch((error) => {
          console.log("Service Worker registration failed:", error);
        });
    });
  }
}
