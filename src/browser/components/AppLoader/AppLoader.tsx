import { useState, useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import App from "../../App";
import { AuthTokenModal } from "../AuthTokenModal/AuthTokenModal";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { LoadingScreen } from "../LoadingScreen/LoadingScreen";
import { StartupConnectionError } from "../StartupConnectionError/StartupConnectionError";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useWorkspaceStoreRaw, workspaceStore } from "../../stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "../../stores/GitStatusStore";
import { useRuntimeStatusStoreRaw } from "../../stores/RuntimeStatusStore";
import { useBackgroundBashStoreRaw } from "../../stores/BackgroundBashStore";
import { getPRStatusStoreInstance } from "../../stores/PRStatusStore";
import { getAppConfigStore } from "../../stores/AppConfigStore";
import { getProvidersConfigStore } from "../../stores/ProvidersConfigStore";
import { ProjectProvider, useProjectContext } from "../../contexts/ProjectContext";
import { PolicyProvider, usePolicy } from "@/browser/contexts/PolicyContext";
import { PolicyBlockedScreen } from "@/browser/components/PolicyBlockedScreen/PolicyBlockedScreen";
import { APIProvider, useAPI, type APIClient } from "@/browser/contexts/API";
import { WorkspaceProvider, useWorkspaceContext } from "../../contexts/WorkspaceContext";
import { RouterProvider } from "../../contexts/RouterContext";
import {
  hydrateUserPreferencesLocalCache,
  UserPreferencesProvider,
} from "@/browser/contexts/UserPreferencesContext";
import { TerminalRouterProvider } from "../../terminal/TerminalRouterContext";

const USER_PREFERENCES_BOOTSTRAP_TIMEOUT_MS = 2000;

function UserPreferencesStartupGate(props: { children: ReactNode }) {
  const apiState = useAPI();
  const [ready, setReady] = useState(false);
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current || !apiState.api) {
      return;
    }

    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(resolve, USER_PREFERENCES_BOOTSTRAP_TIMEOUT_MS, "timeout");
    });
    const hydratePromise = hydrateUserPreferencesLocalCache({
      configClient: apiState.api.config,
      signal: abortController.signal,
    }).catch((error) => {
      console.warn("Failed to bootstrap user preferences:", error);
      return undefined;
    });

    const startup = Promise.race([hydratePromise, timeoutPromise]);
    // User preference hydration must happen before RouterProvider reads launch behavior, but
    // startup still needs a hard fallback so a slow backend cannot trap users on the boot screen.
    void startup
      .then((result) => {
        if (result === "timeout") {
          abortController.abort();
        }
        if (abortController.signal.aborted && result !== "timeout") {
          return;
        }

        bootstrappedRef.current = true;
        setReady(true);
      })
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });

    return () => {
      abortController.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [apiState.api]);

  if (bootstrappedRef.current || ready) {
    return <>{props.children}</>;
  }

  if (apiState.status === "auth_required") {
    return (
      <AuthTokenModal
        isOpen={true}
        onSubmit={apiState.authenticate}
        onSessionAuthenticated={apiState.retry}
        error={apiState.error}
      />
    );
  }

  if (apiState.status === "error") {
    return <StartupConnectionError error={apiState.error} onRetry={apiState.retry} />;
  }

  return (
    <LoadingScreen
      statusText={
        apiState.status === "reconnecting"
          ? `Reconnecting to backend (attempt ${apiState.attempt})...`
          : "Loading preferences"
      }
    />
  );
}

interface AppLoaderProps {
  /** Optional pre-created ORPC api?. If provided, skips internal connection setup. */
  client?: APIClient;
}

/**
 * AppLoader handles all initialization before rendering the main App:
 * 1. Load workspace metadata and projects (via contexts)
 * 2. Sync stores with loaded data
 * 3. Only render App when everything is ready
 *
 * WorkspaceContext handles workspace selection restoration from URL.
 * RouterProvider must wrap WorkspaceProvider since workspace state is derived from URL.
 * WorkspaceProvider must be nested inside ProjectProvider so it can call useProjectContext().
 * This ensures App.tsx can assume stores are always synced and removes
 * the need for conditional guards in effects.
 */
export function AppLoader(props: AppLoaderProps) {
  return (
    <ThemeProvider>
      <APIProvider client={props.client}>
        <UserPreferencesStartupGate>
          <PolicyProvider>
            <RouterProvider>
              <ProjectProvider>
                <WorkspaceProvider>
                  <UserPreferencesProvider>
                    <AppLoaderInner />
                  </UserPreferencesProvider>
                </WorkspaceProvider>
              </ProjectProvider>
            </RouterProvider>
          </PolicyProvider>
        </UserPreferencesStartupGate>
      </APIProvider>
    </ThemeProvider>
  );
}

/**
 * Inner component that has access to both ProjectContext and WorkspaceContext.
 * Syncs stores and shows loading screen until ready.
 */
function AppLoaderInner() {
  const policyState = usePolicy();
  const workspaceContext = useWorkspaceContext();
  const projectContext = useProjectContext();
  const apiState = useAPI();
  const api = apiState.api;

  const workspaceStoreInstance = useWorkspaceStoreRaw();
  const gitStatusStore = useGitStatusStoreRaw();
  const runtimeStatusStore = useRuntimeStatusStoreRaw();
  const backgroundBashStore = useBackgroundBashStoreRaw();

  const prefersReducedMotion = useReducedMotion();

  // Track whether stores have been synced
  const [storesSynced, setStoresSynced] = useState(false);

  // Track whether the initial load has completed. After the first successful
  // load, we keep rendering the UI during reconnects instead of flashing the
  // full-screen LoadingScreen again.
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // Sync stores when metadata finishes loading
  useEffect(() => {
    // Keep store clients in sync even during backend restarts (api can be null while reconnecting).
    workspaceStoreInstance.setClient(api ?? null);
    gitStatusStore.setClient(api ?? null);
    runtimeStatusStore.setClient(api ?? null);
    backgroundBashStore.setClient(api ?? null);
    getPRStatusStoreInstance().setClient(api ?? null);
    getProvidersConfigStore().setClient(api ?? null);
    getAppConfigStore().setClient(api ?? null);

    if (!workspaceContext.loading) {
      workspaceStoreInstance.syncWorkspaces(workspaceContext.workspaceMetadata);
      gitStatusStore.syncWorkspaces(workspaceContext.workspaceMetadata);
      runtimeStatusStore.syncWorkspaces(workspaceContext.workspaceMetadata);
      getPRStatusStoreInstance().syncWorkspaces(workspaceContext.workspaceMetadata);

      // Wire up file-modification subscription (idempotent - only subscribes once)
      gitStatusStore.subscribeToFileModifications((listener) =>
        workspaceStore.subscribeFileModifyingTool(listener)
      );

      setStoresSynced(true);
    } else {
      setStoresSynced(false);
    }
  }, [
    workspaceContext.loading,
    workspaceContext.workspaceMetadata,
    workspaceStoreInstance,
    gitStatusStore,
    runtimeStatusStore,
    backgroundBashStore,
    api,
  ]);

  useEffect(() => {
    if (initialLoadComplete) {
      return;
    }

    if (!projectContext.loading && !workspaceContext.loading && storesSynced) {
      setInitialLoadComplete(true);
    }
  }, [initialLoadComplete, projectContext.loading, storesSynced, workspaceContext.loading]);

  if (policyState.status.state === "blocked") {
    return <PolicyBlockedScreen reason={policyState.status.reason} />;
  }

  // If we're in browser mode and auth is required, show the token prompt before any data loads.
  if (apiState.status === "auth_required") {
    return (
      <AuthTokenModal
        isOpen={true}
        onSubmit={apiState.authenticate}
        onSessionAuthenticated={apiState.retry}
        error={apiState.error}
      />
    );
  }

  // AnimatePresence provides a smooth fade-out when the loading screen
  // transitions to the main app. mode="wait" ensures the exit animation
  // completes before the enter animation starts.
  return (
    <AnimatePresence mode="wait">
      {!initialLoadComplete ? (
        <motion.div
          key="loading"
          initial={{ opacity: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -20 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.4, ease: "easeInOut" }}
          className="bg-surface-primary h-full"
        >
          {apiState.status === "error" ? (
            <StartupConnectionError error={apiState.error} onRetry={apiState.retry} />
          ) : (
            <LoadingScreen
              statusText={
                apiState.status === "reconnecting"
                  ? `Reconnecting to backend (attempt ${apiState.attempt})...`
                  : "Loading Xum"
              }
            />
          )}
        </motion.div>
      ) : (
        <motion.div
          key="app"
          initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
          className="bg-surface-primary h-full"
        >
          <TerminalRouterProvider>
            <App />
          </TerminalRouterProvider>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
