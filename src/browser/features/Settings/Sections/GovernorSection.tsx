/**
 * Governor Section - Enrollment UI for Xum Governor (enterprise policy service).
 * Gated behind the MUX_GOVERNOR experiment flag.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, ShieldCheck, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { useAPI } from "@/browser/contexts/API";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { JsonHighlight } from "@/browser/features/Tools/Shared/HighlightedCode";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { getErrorMessage } from "@/common/utils/errors";

/** Get server auth token from URL query param or localStorage. */
function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

type EnrollStatus = "idle" | "starting" | "waiting" | "success" | "error";

export function GovernorSection() {
  const { api } = useAPI();
  const isDesktop = !!window.api;

  const policyState = usePolicy();

  // Enrollment state from config
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [governorUrl, setGovernorUrl] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Policy refresh (enrolled only)
  const [refreshingPolicy, setRefreshingPolicy] = useState(false);
  const [refreshPolicyError, setRefreshPolicyError] = useState<string | null>(null);

  // URL prompt dialog
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlWarning, setUrlWarning] = useState<string | null>(null);

  // OAuth flow state
  const [enrollStatus, setEnrollStatus] = useState<EnrollStatus>("idle");
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [desktopFlowId, setDesktopFlowId] = useState<string | null>(null);
  const enrollAttemptRef = useRef(0);
  // Cleanup function for browser OAuth flow (listener + interval)
  const browserFlowCleanupRef = useRef<(() => void) | null>(null);

  // Load config on mount
  useEffect(() => {
    if (!api) return;
    const apiRef = api; // capture for closure
    async function loadConfig() {
      try {
        const config = await apiRef.config.getConfig();
        setEnrolled(config.muxGovernorEnrolled);
        setGovernorUrl(config.muxGovernorUrl);
      } catch {
        // Ignore load errors - show as not enrolled
        setEnrolled(false);
        setGovernorUrl(null);
      } finally {
        setLoadingConfig(false);
      }
    }
    void loadConfig();
  }, [api]);

  // Cleanup desktop flow on unmount only
  // We use refs to access current values without triggering re-runs of the cleanup
  const desktopFlowIdRef = useRef(desktopFlowId);
  desktopFlowIdRef.current = desktopFlowId;
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    return () => {
      // Cleanup desktop flow
      if (isDesktop && apiRef.current && desktopFlowIdRef.current) {
        void apiRef.current.muxGovernorOauth.cancelDesktopFlow({
          flowId: desktopFlowIdRef.current,
        });
      }
      // Cleanup browser flow (listener + interval)
      browserFlowCleanupRef.current?.();
      browserFlowCleanupRef.current = null;
      enrollAttemptRef.current += 1;
    };
  }, [isDesktop]);

  // Validate and normalize URL input
  const validateUrl = (input: string): { valid: boolean; origin?: string; warning?: string } => {
    if (!input.trim()) {
      return { valid: false };
    }

    try {
      const url = new URL(input.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { valid: false };
      }
      const warning =
        url.protocol === "http:"
          ? "Warning: Using HTTP is not secure. Use HTTPS in production."
          : undefined;
      return { valid: true, origin: url.origin, warning };
    } catch {
      return { valid: false };
    }
  };

  const handleUrlInputChange = (value: string) => {
    setUrlInput(value);
    setUrlError(null);

    const result = validateUrl(value);
    if (value.trim() && !result.valid) {
      setUrlError("Please enter a valid URL (e.g., https://governor.corp.com)");
      setUrlWarning(null);
    } else {
      setUrlWarning(result.warning ?? null);
    }
  };

  const handleStartEnroll = async () => {
    if (!api) return;

    const result = validateUrl(urlInput);
    if (!result.valid || !result.origin) {
      setUrlError("Please enter a valid URL");
      return;
    }

    const governorOrigin = result.origin;
    const currentAttempt = ++enrollAttemptRef.current;

    setShowUrlDialog(false);
    setEnrollStatus("starting");
    setEnrollError(null);

    if (isDesktop) {
      // Desktop flow: opens in system browser
      const startResult = await api.muxGovernorOauth.startDesktopFlow({ governorOrigin });

      if (currentAttempt !== enrollAttemptRef.current) return;

      if (!startResult.success) {
        setEnrollStatus("error");
        setEnrollError(startResult.error);
        return;
      }

      const { flowId, authorizeUrl } = startResult.data;
      setDesktopFlowId(flowId);
      setEnrollStatus("waiting");

      // Open in system browser
      window.open(authorizeUrl, "_blank", "noopener");

      const waitResult = await api.muxGovernorOauth.waitForDesktopFlow({ flowId });

      if (currentAttempt !== enrollAttemptRef.current) return;

      if (waitResult.success) {
        setEnrollStatus("success");
        // Reload config to show enrolled state
        const config = await api.config.getConfig();
        setEnrolled(config.muxGovernorEnrolled);
        setGovernorUrl(config.muxGovernorUrl);
      } else {
        setEnrollStatus("error");
        setEnrollError(waitResult.error);
      }
    } else {
      // Server/browser flow: open popup, fetch start URL, then navigate popup to authorize URL
      // (Matches gateway pattern - popup must be opened synchronously before async fetch)
      const popup = window.open(
        "about:blank",
        "mux-governor-oauth",
        "width=600,height=700,popup=1"
      );

      if (!popup) {
        setEnrollStatus("error");
        setEnrollError("Failed to open popup. Please allow popups for this site.");
        return;
      }

      setEnrollStatus("waiting");

      const backendBaseUrl = getBrowserBackendBaseUrl();

      // Fetch the authorize URL from the start endpoint
      const startUrl = new URL(`${backendBaseUrl}/auth/mux-governor/start`);
      startUrl.searchParams.set("governorUrl", governorOrigin);

      const authToken = getServerAuthToken();
      let json: { authorizeUrl?: unknown; state?: unknown; error?: unknown };
      try {
        const res = await fetch(startUrl.toString(), {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const body = await res.text();
          const prefix = body.trim().slice(0, 80);
          throw new Error(
            `Unexpected response (expected JSON, got ${contentType || "unknown"}): ${prefix}`
          );
        }
        json = (await res.json()) as typeof json;
        if (!res.ok) {
          const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
          throw new Error(message);
        }
      } catch (err) {
        popup.close();
        if (currentAttempt !== enrollAttemptRef.current) return;
        setEnrollStatus("error");
        setEnrollError(getErrorMessage(err));
        return;
      }

      if (currentAttempt !== enrollAttemptRef.current) {
        popup.close();
        return;
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        popup.close();
        setEnrollStatus("error");
        setEnrollError("Invalid response from start endpoint");
        return;
      }

      const oauthState = json.state;
      // Origin for callback validation (respects VITE_BACKEND_URL overrides)
      const backendOrigin = new URL(backendBaseUrl).origin;

      // Navigate popup to the authorize URL
      popup.location.href = json.authorizeUrl;

      // Type for OAuth callback message
      interface GovernorOAuthMessage {
        type: "mux-governor-oauth";
        ok: boolean;
        state?: string;
        error?: string | null;
      }

      function isGovernorOAuthMessage(data: unknown): data is GovernorOAuthMessage {
        return (
          typeof data === "object" &&
          data !== null &&
          (data as GovernorOAuthMessage).type === "mux-governor-oauth"
        );
      }

      // Listen for postMessage from callback page
      const handleMessage = (event: MessageEvent<unknown>) => {
        // Validate origin to prevent cross-origin attacks
        if (event.origin !== backendOrigin) return;
        if (!isGovernorOAuthMessage(event.data)) return;
        // Validate state to prevent CSRF
        if (event.data.state !== oauthState) return;

        window.removeEventListener("message", handleMessage);

        if (currentAttempt !== enrollAttemptRef.current) return;

        if (event.data.ok) {
          setEnrollStatus("success");
          // Reload config
          void (async () => {
            const config = await api.config.getConfig();
            setEnrolled(config.muxGovernorEnrolled);
            setGovernorUrl(config.muxGovernorUrl);
          })();
        } else {
          setEnrollStatus("error");
          setEnrollError(event.data.error ?? "OAuth failed");
        }
      };

      window.addEventListener("message", handleMessage);

      // Cleanup listener if popup is closed without completing
      // Note: we don't check enrollStatus here since it's captured at closure time
      // and may be stale. The attempt ref ensures we only reset for the current flow.
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          window.removeEventListener("message", handleMessage);
          browserFlowCleanupRef.current = null;
          if (currentAttempt === enrollAttemptRef.current) {
            setEnrollStatus("idle");
          }
        }
      }, 500);

      // Store cleanup function for unmount
      browserFlowCleanupRef.current = () => {
        clearInterval(checkClosed);
        window.removeEventListener("message", handleMessage);
        popup.close();
      };
    }
  };

  const handleRefreshPolicy = async () => {
    if (!api) return;

    setRefreshingPolicy(true);
    setRefreshPolicyError(null);

    try {
      const result = await api.policy.refreshNow();
      if (!result.success) {
        setRefreshPolicyError(result.error);
      }
    } catch (error) {
      setRefreshPolicyError(getErrorMessage(error));
    } finally {
      setRefreshingPolicy(false);
    }
  };

  const handleUnenroll = async () => {
    if (!api) return;

    try {
      await api.config.unenrollMuxGovernor();
      setEnrolled(false);
      setGovernorUrl(null);
      setRefreshPolicyError(null);
    } catch (error) {
      // Show error but don't crash
      console.error("Failed to unenroll from Governor:", error);
    }
  };

  const handleOpenUrlDialog = () => {
    setUrlInput("");
    setUrlError(null);
    setUrlWarning(null);
    setShowUrlDialog(true);
  };

  if (loadingConfig) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Xum Governor</h2>
        <p className="text-muted-foreground text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Xum Governor</h2>

      {enrolled ? (
        // Enrolled state
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            You are enrolled in Xum Governor for enterprise policy delivery.
          </p>
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-green-500" />
            <span className="font-medium">Governor URL:</span>
            <code className="rounded bg-zinc-700/50 px-2 py-0.5">{governorUrl}</code>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRefreshPolicy()}
              disabled={refreshingPolicy}
            >
              {refreshingPolicy ? "Refreshing..." : "Refresh policy"}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleUnenroll()}>
              Unenroll from Xum Governor
            </Button>
          </div>

          {refreshPolicyError && (
            <div className="text-destructive flex items-start gap-2 text-sm">
              <X className="mt-0.5 h-4 w-4" />
              <span>{refreshPolicyError}</span>
            </div>
          )}

          {/* Current policy display */}
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Policy source:</span>
              <code className="rounded bg-zinc-700/50 px-2 py-0.5">{policyState.source}</code>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Policy status:</span>
              <code className="rounded bg-zinc-700/50 px-2 py-0.5">{policyState.status.state}</code>
              {policyState.status.state === "blocked" && policyState.status.reason && (
                <span className="text-destructive text-xs">({policyState.status.reason})</span>
              )}
            </div>

            {policyState.policy && (
              <div className="space-y-1">
                <span className="text-sm font-medium">Effective policy:</span>
                <JsonHighlight value={policyState.policy} />
              </div>
            )}
          </div>
        </div>
      ) : enrollStatus === "idle" || enrollStatus === "success" ? (
        // Not enrolled - show enroll button
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Xum Governor enables enterprise policy delivery for centralized agent control. Enroll to
            connect to your organization&apos;s Governor server.
          </p>
          <Button onClick={handleOpenUrlDialog}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Enroll in Xum Governor
          </Button>
        </div>
      ) : enrollStatus === "starting" ? (
        // Starting OAuth
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">Starting enrollment...</p>
        </div>
      ) : enrollStatus === "waiting" ? (
        // Waiting for OAuth callback
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Complete the sign-in in your browser, then return here.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              // Bump attempt to invalidate any in-flight browser flow listeners
              enrollAttemptRef.current += 1;
              if (isDesktop && desktopFlowId && api) {
                void api.muxGovernorOauth.cancelDesktopFlow({ flowId: desktopFlowId });
              }
              setEnrollStatus("idle");
              setDesktopFlowId(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        // Error state
        <div className="space-y-4">
          <div className="text-destructive flex items-start gap-2 text-sm">
            <X className="mt-0.5 h-4 w-4" />
            <span>{enrollError ?? "Enrollment failed"}</span>
          </div>
          <Button onClick={handleOpenUrlDialog}>Try Again</Button>
        </div>
      )}

      {/* URL Input Dialog */}
      <Dialog open={showUrlDialog} onOpenChange={setShowUrlDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter Governor URL</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <p className="text-muted-foreground text-sm">
              Enter the URL of your organization&apos;s Xum Governor server.
            </p>
            <Input
              placeholder="https://governor.corp.com"
              value={urlInput}
              onChange={(e) => handleUrlInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !urlError) {
                  void handleStartEnroll();
                }
              }}
            />
            {urlError && <p className="text-destructive text-sm">{urlError}</p>}
            {urlWarning && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{urlWarning}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowUrlDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleStartEnroll()}
                disabled={!urlInput.trim() || !!urlError}
              >
                Continue
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
