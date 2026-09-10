import { useEffect, useState } from "react";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { SplashScreen } from "@/browser/features/SplashScreens/SplashScreen";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import { getErrorMessage } from "@/common/utils/errors";

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

export function MuxGatewaySessionExpiredDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isStartingLogin, setIsStartingLogin] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = () => {
      setLoginError(null);
      setIsStartingLogin(false);
      setIsOpen(true);
    };

    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler as EventListener);
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED,
        handler as EventListener
      );
    };
  }, []);

  const dismiss = () => {
    setIsOpen(false);
    setLoginError(null);
    setIsStartingLogin(false);
  };

  const startMuxGatewayLogin = async () => {
    if (isStartingLogin) {
      return;
    }

    setIsStartingLogin(true);
    setLoginError(null);

    try {
      const isDesktop = !!window.api;

      if (isDesktop) {
        const client = window.__ORPC_CLIENT__;
        if (!client) {
          throw new Error("Xum API not connected.");
        }

        const startResult = await client.muxGatewayOauth.startDesktopFlow();
        if (!startResult.success) {
          throw new Error(startResult.error);
        }

        // Desktop main process intercepts external window.open() calls and routes them via shell.openExternal.
        window.open(startResult.data.authorizeUrl, "_blank", "noopener");
        dismiss();
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      // Open popup synchronously to preserve user gesture context (avoids popup blockers).
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        throw new Error("Popup blocked - please allow popups and try again.");
      }

      const backendBaseUrl = getBrowserBackendBaseUrl();
      const startUrl = new URL(`${backendBaseUrl}/auth/mux-gateway/start`);
      const authToken = getServerAuthToken();

      let json: { authorizeUrl?: unknown; state?: unknown; error?: unknown };
      try {
        const res = await fetch(startUrl, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const body = await res.text();
          const prefix = body.trim().slice(0, 80);
          throw new Error(
            `Unexpected response from ${startUrl.toString()} (expected JSON, got ${
              contentType || "unknown"
            }): ${prefix}`
          );
        }

        json = (await res.json()) as typeof json;

        if (!res.ok) {
          const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
          throw new Error(message);
        }
      } catch (err) {
        popup.close();
        throw err;
      }

      if (typeof json.authorizeUrl !== "string") {
        popup.close();
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      popup.location.href = json.authorizeUrl;
      dismiss();
    } catch (err) {
      const message = getErrorMessage(err);
      setIsStartingLogin(false);
      setLoginError(message);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <SplashScreen
      title="Xum Gateway session expired"
      onDismiss={dismiss}
      dismissOnPrimaryAction={false}
      primaryAction={{
        label: isStartingLogin ? "Starting login..." : "Login to Xum Gateway",
        disabled: isStartingLogin,
        onClick: () => {
          void startMuxGatewayLogin();
        },
      }}
      dismissLabel="Cancel"
    >
      <p className="text-muted text-sm">{MUX_GATEWAY_SESSION_EXPIRED_MESSAGE}</p>

      {loginError && (
        <p className="mt-3 text-sm">
          <strong className="text-destructive">Login failed:</strong> {loginError}
        </p>
      )}
    </SplashScreen>
  );
}
