import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Globe2, Loader2, Play, TriangleAlert } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getBrowserSelectedSessionKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import type {
  BrowserDiscoveredOtherSession,
  BrowserDiscoveredSession,
  BrowserDiscoveredSessionStatus,
  BrowserPageTab,
  BrowserSession,
  BrowserSessionStatus,
} from "./browserBridgeTypes";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserBridgeConnection } from "./useBrowserBridgeConnection";

type BrowserSelectedSession =
  | { sessionName: string; source: "current" }
  | { sessionName: string; source: "other" };

interface BrowserTabProps {
  workspaceId: string;
  projectPath: string;
}

const STATUS_BADGES: Record<BrowserSessionStatus, { label: string; className: string }> = {
  starting: {
    label: "Connecting",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
  live: {
    label: "Live",
    className: "bg-success/20 text-success",
  },
  error: {
    label: "Unavailable",
    className: "border-destructive/20 bg-destructive/10 text-destructive",
  },
  ended: {
    label: "Stopped",
    className: "border-border-light bg-background-secondary text-muted",
  },
};

const DISCOVERY_BADGES: Record<
  BrowserDiscoveredSessionStatus,
  { label: string; className: string }
> = {
  attachable: {
    label: "Ready",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
  missing_stream: {
    label: "Activating",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
};

const BROWSER_VIEWPORT_PANEL_ID = "browser-preview-viewport";
export const BROWSER_PREVIEW_RETRY_INTERVAL_MS = 2_000;

function isRetryableBrowserError(error: string | null): boolean {
  if (error == null) {
    return false;
  }

  return /disconnected|session unavailable|is unavailable|stream connect failed|invalid token|failed to enable streaming|failed to verify streaming/i.test(
    error
  );
}

export function shouldBackOffBrowserReconnect(params: {
  selectedSessionName: string;
  session: BrowserSession | null;
  visibleError: string | null;
  lastConnectAttempt: { sessionName: string; attemptedAtMs: number } | null;
  nowMs: number;
}): boolean {
  const isSameSessionRetry =
    params.session?.sessionName === params.selectedSessionName &&
    (params.session.status === "ended" ||
      (params.session.status === "error" && isRetryableBrowserError(params.visibleError)));
  if (!isSameSessionRetry) {
    return false;
  }

  return (
    params.lastConnectAttempt?.sessionName === params.selectedSessionName &&
    params.nowMs - params.lastConnectAttempt.attemptedAtMs < BROWSER_PREVIEW_RETRY_INTERVAL_MS
  );
}

function chooseSelectedSession(
  currentSessionName: string | null,
  sessions: BrowserDiscoveredSession[]
): string | null {
  if (
    currentSessionName != null &&
    sessions.some((session) => session.sessionName === currentSessionName)
  ) {
    return currentSessionName;
  }

  return sessions[0]?.sessionName ?? null;
}

export function chooseExplicitOtherSession(
  currentSessionName: string | null,
  otherSessions: BrowserDiscoveredOtherSession[]
): string | null {
  return currentSessionName != null &&
    otherSessions.some((otherSession) => otherSession.sessionName === currentSessionName)
    ? currentSessionName
    : null;
}

function matchesBrowserPageTabRef(tab: BrowserPageTab, tabRef: string | null): boolean {
  return tabRef != null && tab.tabId === tabRef;
}

function areBrowserPageTabsEqual(first: BrowserPageTab[], second: BrowserPageTab[]): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const lastConnectAttemptRef = useRef<{ sessionName: string; attemptedAtMs: number } | null>(null);
  const discoveryRefreshInFlightRef = useRef(false);
  const tabRefreshInFlightSessionNameRef = useRef<string | null>(null);
  const pageTabsSessionNameRef = useRef<string | null>(null);
  const tabRefreshGenerationRef = useRef(0);
  const pendingTabIdRef = useRef<string | null>(null);
  const selectedSessionNameRef = useRef<string | null>(null);
  const { api } = useAPI();
  const [discoveredSessions, setDiscoveredSessions] = useState<BrowserDiscoveredSession[]>([]);
  const [otherDiscoveredSessions, setOtherDiscoveredSessions] = useState<
    BrowserDiscoveredOtherSession[]
  >([]);
  const [selectedCurrentSessionName, setSelectedCurrentSessionName] = usePersistedState<
    string | null
  >(getBrowserSelectedSessionKey(props.projectPath), null, { listener: true });
  const [explicitOtherSessionName, setExplicitOtherSessionName] = useState<string | null>(null);
  const [pageTabs, setPageTabs] = useState<BrowserPageTab[]>([]);
  const [pageTabsError, setPageTabsError] = useState<string | null>(null);
  const [pendingTabId, setPendingTabId] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const { session, connect, disconnect, sendInput, setPendingUrl } = useBrowserBridgeConnection(
    props.workspaceId
  );

  const selectedSession: BrowserSelectedSession | null =
    explicitOtherSessionName != null
      ? { sessionName: explicitOtherSessionName, source: "other" }
      : selectedCurrentSessionName != null
        ? { sessionName: selectedCurrentSessionName, source: "current" }
        : null;
  const selectedSessionName = selectedSession?.sessionName ?? null;
  selectedSessionNameRef.current = selectedSessionName;
  const isOtherSessionSelected = selectedSession?.source === "other";
  const selectedDiscoveredSession = isOtherSessionSelected
    ? (otherDiscoveredSessions.find((candidate) => candidate.sessionName === selectedSessionName) ??
      null)
    : (discoveredSessions.find((candidate) => candidate.sessionName === selectedSessionName) ??
      null);

  const selectedDiscoveredSessionStatus = selectedDiscoveredSession?.status ?? null;

  const isStarting = session?.status === "starting";
  const screenshotSrc =
    session?.frameBase64 != null ? `data:image/jpeg;base64,${session.frameBase64}` : null;
  const visibleError = session?.lastError ?? session?.streamErrorMessage ?? discoveryError ?? null;
  const headerBadge =
    session != null
      ? STATUS_BADGES[session.status]
      : selectedDiscoveredSession != null
        ? DISCOVERY_BADGES[selectedDiscoveredSession.status]
        : null;
  const headerTitle = "Browser preview";
  const shouldShowPageTabStrip = pageTabs.length > 1 || pageTabsError != null;

  useEffect(() => {
    if (api == null) {
      setDiscoveryError("Browser API client is unavailable.");
      setDiscoveredSessions([]);
      setOtherDiscoveredSessions([]);
      return;
    }

    let cancelled = false;

    const refreshSessions = async (): Promise<void> => {
      if (discoveryRefreshInFlightRef.current) {
        return;
      }
      discoveryRefreshInFlightRef.current = true;

      try {
        const result = await api.browser.listSessions({ workspaceId: props.workspaceId });
        if (cancelled) {
          return;
        }

        setDiscoveryError(null);
        setDiscoveredSessions(result.sessions);
        setOtherDiscoveredSessions(result.otherSessions);
        setExplicitOtherSessionName((currentSessionName) =>
          chooseExplicitOtherSession(currentSessionName, result.otherSessions)
        );
        setSelectedCurrentSessionName((currentSessionName) =>
          chooseSelectedSession(currentSessionName, result.sessions)
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        // Preserve the last known discovery result so transient refresh failures do not
        // tear down an otherwise healthy browser bridge.
        setDiscoveryError(
          error instanceof Error ? error.message : "Failed to discover browser sessions."
        );
      } finally {
        discoveryRefreshInFlightRef.current = false;
      }
    };

    void refreshSessions();
    const refreshTimer = setInterval(() => {
      void refreshSessions();
    }, BROWSER_PREVIEW_RETRY_INTERVAL_MS);
    refreshTimer.unref?.();

    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [api, props.workspaceId, setSelectedCurrentSessionName]);

  useEffect(() => {
    if (
      api == null ||
      selectedSessionName == null ||
      selectedDiscoveredSessionStatus !== "attachable"
    ) {
      tabRefreshInFlightSessionNameRef.current = null;
      pageTabsSessionNameRef.current = null;
      setPageTabs((currentTabs) => (currentTabs.length === 0 ? currentTabs : []));
      setPageTabsError(null);
      pendingTabIdRef.current = null;
      setPendingTabId(null);
      return;
    }

    let cancelled = false;
    if (pageTabsSessionNameRef.current !== selectedSessionName) {
      pageTabsSessionNameRef.current = selectedSessionName;
      setPageTabs((currentTabs) => (currentTabs.length === 0 ? currentTabs : []));
      setPageTabsError(null);
      pendingTabIdRef.current = null;
      setPendingTabId(null);
    }

    const refreshTabs = async (): Promise<void> => {
      if (tabRefreshInFlightSessionNameRef.current === selectedSessionName) {
        return;
      }
      tabRefreshInFlightSessionNameRef.current = selectedSessionName;
      const refreshGeneration = tabRefreshGenerationRef.current;

      try {
        const result = await api.browser.listTabs({
          workspaceId: props.workspaceId,
          sessionName: selectedSessionName,
          ...(isOtherSessionSelected ? { allowOtherWorkspaceSession: true } : {}),
        });
        if (cancelled || refreshGeneration !== tabRefreshGenerationRef.current) {
          return;
        }

        if (pendingTabIdRef.current != null) {
          return;
        }

        if (result.error != null) {
          // Keep the last tab list visible while transient CLI errors recover.
          setPageTabsError(result.error);
          return;
        }

        setPageTabs((currentTabs) =>
          areBrowserPageTabsEqual(currentTabs, result.tabs) ? currentTabs : result.tabs
        );
        setPageTabsError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setPageTabsError(
          error instanceof Error
            ? error.message
            : `Failed to list browser tabs for session "${selectedSessionName}".`
        );
      } finally {
        if (tabRefreshInFlightSessionNameRef.current === selectedSessionName) {
          tabRefreshInFlightSessionNameRef.current = null;
        }
      }
    };

    void refreshTabs();
    const refreshTimer = setInterval(() => {
      void refreshTabs();
    }, BROWSER_PREVIEW_RETRY_INTERVAL_MS);
    refreshTimer.unref?.();

    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [
    api,
    props.workspaceId,
    selectedSessionName,
    selectedDiscoveredSessionStatus,
    isOtherSessionSelected,
  ]);

  useEffect(() => {
    if (api == null || selectedSessionName == null || selectedDiscoveredSession == null) {
      lastConnectAttemptRef.current = null;
      disconnect();
      return;
    }

    if (
      session?.sessionName === selectedSessionName &&
      (session.status === "starting" || session.status === "live")
    ) {
      return;
    }

    const shouldRetryConnection =
      session?.sessionName !== selectedSessionName ||
      session?.status === "ended" ||
      (session?.status === "error" && isRetryableBrowserError(visibleError));
    if (!shouldRetryConnection) {
      lastConnectAttemptRef.current = null;
      return;
    }

    const now = Date.now();
    if (
      shouldBackOffBrowserReconnect({
        selectedSessionName,
        session,
        visibleError,
        lastConnectAttempt: lastConnectAttemptRef.current,
        nowMs: now,
      })
    ) {
      return;
    }

    // Bootstrap failures can flip the bridge session into "error" almost immediately.
    // Remember the most recent attempt so the next render waits for the normal discovery
    // polling cadence instead of hammering browser.getBootstrap in a tight loop.
    lastConnectAttemptRef.current = {
      sessionName: selectedSessionName,
      attemptedAtMs: now,
    };
    if (isOtherSessionSelected) {
      connect(selectedSessionName, { allowOtherWorkspaceSession: true });
    } else {
      connect(selectedSessionName);
    }
  }, [
    api,
    connect,
    disconnect,
    selectedDiscoveredSession,
    selectedSessionName,
    isOtherSessionSelected,
    session,
    visibleError,
  ]);

  const handleSelectPageTab = async (tabRef: string): Promise<void> => {
    const trimmedTabRef = tabRef.trim();
    if (
      api == null ||
      selectedSessionName == null ||
      selectedDiscoveredSessionStatus !== "attachable" ||
      trimmedTabRef.length === 0 ||
      pendingTabIdRef.current != null
    ) {
      return;
    }

    const targetSessionName = selectedSessionName;
    tabRefreshGenerationRef.current += 1;
    pendingTabIdRef.current = trimmedTabRef;
    setPendingTabId(trimmedTabRef);
    setPageTabsError(null);

    try {
      const result = await api.browser.selectTab({
        workspaceId: props.workspaceId,
        sessionName: targetSessionName,
        tabRef: trimmedTabRef,
        ...(isOtherSessionSelected ? { allowOtherWorkspaceSession: true } : {}),
      });
      if (selectedSessionNameRef.current !== targetSessionName) {
        return;
      }

      if (!result.success) {
        setPageTabsError(result.error ?? `Failed to switch browser tab "${trimmedTabRef}".`);
        return;
      }

      setPageTabs((currentTabs) =>
        currentTabs.map((tab) => ({
          ...tab,
          active: tab.tabId === trimmedTabRef,
        }))
      );
    } catch (error) {
      if (selectedSessionNameRef.current !== targetSessionName) {
        return;
      }

      setPageTabsError(
        error instanceof Error
          ? error.message
          : `Failed to switch browser tab "${trimmedTabRef}" for session "${targetSessionName}".`
      );
    } finally {
      if (selectedSessionNameRef.current === targetSessionName) {
        pendingTabIdRef.current = null;
        setPendingTabId(null);
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border-light flex items-start justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-foreground min-w-0 flex-1 truncate text-xs font-semibold">
              {headerTitle}
            </h3>
            {headerBadge && <BrowserHeaderBadge badge={headerBadge} />}
          </div>
        </div>
        {discoveredSessions.length + otherDiscoveredSessions.length > 0 && (
          <BrowserSessionPicker
            currentSessions={discoveredSessions}
            otherSessions={otherDiscoveredSessions}
            selectedSessionName={selectedSessionName}
            isOtherSessionSelected={isOtherSessionSelected}
            onSelectCurrent={(sessionName) => {
              setExplicitOtherSessionName(null);
              setSelectedCurrentSessionName(sessionName);
            }}
            onSelectOther={setExplicitOtherSessionName}
          />
        )}
      </div>

      {shouldShowPageTabStrip && (
        <BrowserPageTabStrip
          tabs={pageTabs}
          error={pageTabsError}
          pendingTabId={pendingTabId}
          onSelect={(tabRef) => {
            void handleSelectPageTab(tabRef);
          }}
        />
      )}

      <BrowserToolbar
        workspaceId={props.workspaceId}
        sessionName={selectedSessionName}
        allowOtherWorkspaceSession={isOtherSessionSelected}
        currentUrl={session?.currentUrl ?? null}
        pendingUrl={session?.pendingUrl ?? null}
        isPageLoading={session?.isPageLoading ?? false}
        isConnected={session?.status === "live" && session?.sessionName === selectedSessionName}
        onSetPendingUrl={setPendingUrl}
      />

      {visibleError && !screenshotSrc && (
        <div className="border-border-light border-b px-3 py-2">
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{visibleError}</span>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <BrowserViewport
          panelId={shouldShowPageTabStrip ? BROWSER_VIEWPORT_PANEL_ID : undefined}
          workspaceId={props.workspaceId}
          session={session}
          screenshotSrc={screenshotSrc}
          visibleError={visibleError}
          sendInput={sendInput}
          placeholder={
            <BrowserViewerState
              sessionStatus={session?.status ?? null}
              isStarting={isStarting}
              selectedSession={selectedDiscoveredSession}
              hasOtherSessions={otherDiscoveredSessions.length > 0}
              hasDiscoveredSessions={discoveredSessions.length > 0}
            />
          }
        />
      </div>
    </div>
  );
}

function BrowserHeaderBadge(props: { badge: { label: string; className: string } }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        props.badge.className
      )}
    >
      {props.badge.label}
    </span>
  );
}

function BrowserPageTabStrip(props: {
  tabs: BrowserPageTab[];
  error: string | null;
  pendingTabId: string | null;
  onSelect: (tabRef: string) => void;
}) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null);
  const activeTabId = props.tabs.find((tab) => tab.active)?.tabId ?? props.tabs[0]?.tabId ?? null;
  const focusedTabExists = props.tabs.some((tab) => tab.tabId === focusedTabId);
  const tabStopId = focusedTabExists ? focusedTabId : activeTabId;

  const focusTabAtIndex = (index: number): void => {
    const tab = props.tabs[index];
    if (tab == null) {
      return;
    }

    setFocusedTabId(tab.tabId);
    const button = buttonRefs.current.get(tab.tabId);
    button?.focus();
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  useEffect(() => {
    if (activeTabId == null) {
      return;
    }

    buttonRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void => {
    const nextIndex = (() => {
      switch (event.key) {
        case "ArrowLeft":
          return (currentIndex - 1 + props.tabs.length) % props.tabs.length;
        case "ArrowRight":
          return (currentIndex + 1) % props.tabs.length;
        case "Home":
          return 0;
        case "End":
          return props.tabs.length - 1;
        default:
          return null;
      }
    })();
    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    stopKeyboardPropagation(event);
    focusTabAtIndex(nextIndex);
  };

  return (
    <div className="border-border-light bg-background-secondary/70 border-b px-2 pt-1.5">
      <div className="flex min-w-0 items-end gap-2">
        {props.tabs.length > 0 && (
          <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-px">
            <div
              role="tablist"
              aria-label="Browser tabs"
              className="flex w-max min-w-full items-end gap-1 pr-1"
            >
              {props.tabs.map((tab, index) => (
                <BrowserPageTabStripButton
                  key={tab.tabId}
                  refCallback={(button) => {
                    if (button == null) {
                      buttonRefs.current.delete(tab.tabId);
                      return;
                    }
                    buttonRefs.current.set(tab.tabId, button);
                  }}
                  tab={tab}
                  pendingTabId={props.pendingTabId}
                  tabIndex={tab.tabId === tabStopId ? 0 : -1}
                  onFocus={() => setFocusedTabId(tab.tabId)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  onSelect={() => props.onSelect(tab.tabId)}
                />
              ))}
            </div>
          </div>
        )}
        {props.error != null && (
          <span
            role="alert"
            title={props.error}
            className="text-destructive flex max-w-[14rem] shrink-0 items-center gap-1 truncate pb-1.5 text-[10px]"
          >
            <TriangleAlert className="h-3 w-3 shrink-0" />
            <span className="truncate">{props.error}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function BrowserPageTabStripButton(props: {
  tab: BrowserPageTab;
  pendingTabId: string | null;
  tabIndex: number;
  refCallback: (button: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
}) {
  const primaryLabel = formatBrowserPageTabPrimaryLabel(props.tab);
  const auxLabel = formatBrowserPageTabAuxLabel(props.tab, primaryLabel);
  const isSwitching = props.pendingTabId != null;
  const isPending = matchesBrowserPageTabRef(props.tab, props.pendingTabId);

  return (
    <button
      ref={props.refCallback}
      type="button"
      role="tab"
      aria-selected={props.tab.active}
      aria-label={`Browser tab: ${primaryLabel}`}
      aria-controls={BROWSER_VIEWPORT_PANEL_ID}
      aria-disabled={isSwitching ? true : undefined}
      aria-busy={isPending ? true : undefined}
      data-testid={`browser-page-tab-${props.tab.tabId}`}
      tabIndex={props.tabIndex}
      onFocus={props.onFocus}
      onKeyDown={props.onKeyDown}
      onClick={() => {
        if (!props.tab.active && !isSwitching) {
          props.onSelect();
        }
      }}
      className={cn(
        "flex h-8 min-w-[7.5rem] max-w-[12rem] shrink-0 items-center gap-1.5 rounded-t-md border px-2 text-left transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none",
        props.tab.active
          ? "border-border-light border-b-[var(--color-background)] bg-background text-foreground shadow-sm"
          : "border-transparent bg-transparent text-muted hover:bg-hover hover:text-foreground",
        isSwitching && !isPending && "opacity-60",
        isSwitching && "cursor-default"
      )}
    >
      <span
        className={cn(
          "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded",
          props.tab.active ? "bg-accent/15 text-accent" : "bg-background-tertiary text-muted"
        )}
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe2 className="h-3 w-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] leading-4 font-medium">
        {primaryLabel}
      </span>
      <span className="text-muted counter-nums-mono shrink-0 text-[9px] leading-none">
        {isPending ? "…" : auxLabel}
      </span>
      {isPending && <span className="sr-only">Switching</span>}
    </button>
  );
}

function formatBrowserPageTabPrimaryLabel(tab: BrowserPageTab): string {
  const title = tab.title.trim();
  if (title.length > 0 && !isBrowserPageTabTitleUrlLike(title, tab.url)) {
    return title;
  }

  const label = tab.label?.trim();
  if (label != null && label.length > 0) {
    return label;
  }

  const urlLabel = formatBrowserPageTabUrl(tab.url);
  return urlLabel ?? tab.tabId;
}

function formatBrowserPageTabAuxLabel(tab: BrowserPageTab, primaryLabel: string): string {
  const label = tab.label?.trim();
  return label != null && label.length > 0 && label !== primaryLabel ? label : tab.tabId;
}

function isBrowserPageTabTitleUrlLike(title: string, url: string): boolean {
  const trimmedUrl = url.trim();
  if (title === trimmedUrl || (title.startsWith("data:") && trimmedUrl.startsWith("data:"))) {
    return true;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    const urlWithoutProtocol = `${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    return title === parsedUrl.href || title === urlWithoutProtocol;
  } catch {
    return false;
  }
}

function formatBrowserPageTabUrl(url: string): string | null {
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    if (parsedUrl.protocol === "data:") {
      return "data URL";
    }
    if (parsedUrl.hostname.length > 0) {
      return parsedUrl.host;
    }
    return parsedUrl.href;
  } catch {
    return trimmedUrl;
  }
}

function BrowserSessionPicker(props: {
  currentSessions: BrowserDiscoveredSession[];
  otherSessions: BrowserDiscoveredOtherSession[];
  selectedSessionName: string | null;
  isOtherSessionSelected: boolean;
  onSelectCurrent: (sessionName: string) => void;
  onSelectOther: (sessionName: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        className="border-border-light bg-background-secondary text-foreground hover:bg-hover inline-flex max-w-[16rem] items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="truncate">{props.selectedSessionName ?? "Select session"}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {isOpen && (
        <div className="bg-dark border-border absolute top-full right-0 z-[10001] mt-1 min-w-[16rem] overflow-hidden rounded-md border shadow-md">
          <div
            role="listbox"
            aria-label="Browser sessions"
            className="max-h-[280px] overflow-y-auto p-1"
          >
            {props.currentSessions.map((session) => (
              <BrowserSessionPickerOption
                key={session.sessionName}
                session={session}
                isSelected={
                  !props.isOtherSessionSelected && session.sessionName === props.selectedSessionName
                }
                testId={`browser-session-${session.sessionName}`}
                onSelect={() => {
                  props.onSelectCurrent(session.sessionName);
                  setIsOpen(false);
                }}
              />
            ))}
            {props.otherSessions.length > 0 && (
              <div className="text-muted px-2 pt-1 pb-0.5 text-[10px] font-medium">
                Other sessions
              </div>
            )}
            {props.otherSessions.map((session) => (
              <BrowserSessionPickerOption
                key={session.sessionName}
                session={session}
                isSelected={
                  props.isOtherSessionSelected && session.sessionName === props.selectedSessionName
                }
                testId={`browser-other-session-${session.sessionName}`}
                onSelect={() => {
                  props.onSelectOther(session.sessionName);
                  setIsOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BrowserSessionPickerOption(props: {
  session: BrowserDiscoveredSession | BrowserDiscoveredOtherSession;
  isSelected: boolean;
  testId: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.isSelected}
      data-testid={props.testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
      className="hover:bg-hover flex w-full items-start gap-1.5 rounded-sm px-2 py-1 text-left text-[11px]"
    >
      <Check
        className={cn("mt-0.5 h-3 w-3 shrink-0", props.isSelected ? "opacity-100" : "opacity-0")}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.session.sessionName}</span>
        {"cwd" in props.session && (
          <span className="text-muted block truncate text-[10px]" title={props.session.cwd}>
            {props.session.cwd}
          </span>
        )}
      </span>
      {props.session.status === "missing_stream" && (
        <span className="text-accent mt-0.5 shrink-0 text-[10px]">Activating</span>
      )}
    </button>
  );
}

function BrowserViewerState(props: {
  sessionStatus: BrowserSessionStatus | null;
  isStarting: boolean;
  selectedSession: BrowserDiscoveredSession | null;
  hasOtherSessions: boolean;
  hasDiscoveredSessions: boolean;
}) {
  const content = (() => {
    if (props.selectedSession?.status === "missing_stream") {
      return {
        title: "Starting live preview…",
        description: `Enabling streaming for session "${props.selectedSession.sessionName}"…`,
      };
    }

    if (props.isStarting || props.sessionStatus === "starting") {
      return {
        title: "Connecting to browser preview",
        description: "Xum is attaching to the selected agent-owned browser session.",
      };
    }

    if (props.sessionStatus === "error") {
      return {
        title: "Browser preview unavailable",
        description: "Xum will keep retrying while the selected browser session is available.",
      };
    }

    if (props.selectedSession != null || props.hasDiscoveredSessions) {
      return {
        title: "Waiting for browser frames",
        description: "Xum found a browser session and is waiting for live preview frames.",
      };
    }

    if (props.hasOtherSessions) {
      return {
        title: "Choose a browser session",
        description: "Select another session from the picker to connect.",
      };
    }

    return {
      title: "Waiting for browser preview",
      description:
        "Xum will attach automatically when an agent-owned browser session is available for this project.",
    };
  })();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex h-12 w-12 items-center justify-center rounded-full">
          <Play className="text-accent h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h4 className="text-foreground text-sm font-medium">{content.title}</h4>
          <div className="text-muted text-xs leading-relaxed">{content.description}</div>
        </div>
      </div>
    </div>
  );
}
