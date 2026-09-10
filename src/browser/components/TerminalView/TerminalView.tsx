import { useRef, useEffect, useState, useCallback, useLayoutEffect } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_TERMINAL_FONT_CONFIG,
  TERMINAL_FONT_CONFIG_KEY,
  normalizeTerminalFontConfig,
  type TerminalFontConfig,
} from "@/common/constants/storage";
import { useTerminalRouter } from "@/browser/terminal/TerminalRouterContext";
import {
  appendTerminalIconFallback,
  formatCssFontFamilyList,
  isFontFamilyAvailableInBrowser,
  isGenericFontFamily,
  splitFontFamilyList,
  stripOuterQuotes,
  TERMINAL_ICON_FALLBACK_FAMILY,
} from "@/browser/terminal/terminalFontFamily";
import { TERMINAL_CONTAINER_ATTR } from "@/browser/utils/ui/keybinds";
import { TerminalBadgeOverlay } from "@/browser/components/TerminalView/TerminalBadgeOverlay";
import { getTerminalTabFallbackName } from "@/browser/types/rightSidebar";

function canLoadFontFamily(primary: string, fontSize: number): boolean {
  const family = stripOuterQuotes(primary).trim();
  if (!family) {
    return false;
  }

  if (isGenericFontFamily(family)) {
    return true;
  }

  return isFontFamilyAvailableInBrowser(family, fontSize);
}

function resolveTerminalFontFamily(fontFamily: string, fontSize: number): string {
  const formatted = formatCssFontFamilyList(fontFamily);
  const parts = splitFontFamilyList(fontFamily).map(stripOuterQuotes).filter(Boolean);
  const primary = parts.at(0);
  if (!primary) {
    return appendTerminalIconFallback(formatted);
  }

  const primaryOk = canLoadFontFamily(primary, fontSize);
  if (primaryOk) {
    return appendTerminalIconFallback(formatted);
  }

  // Common mismatch: "Nerd Font" vs "Nerd Font Mono". Try the Mono variant even if the user
  // didn't list it explicitly.
  if (primary.endsWith("Nerd Font") && !primary.endsWith("Nerd Font Mono")) {
    const monoCandidate = `${primary} Mono`;
    const monoOk = canLoadFontFamily(monoCandidate, fontSize);
    if (monoOk) {
      const remaining = parts.slice(1).join(", ");
      const withMono = remaining ? `${monoCandidate}, ${remaining}` : monoCandidate;
      return appendTerminalIconFallback(withMono);
    }
  }

  // If the primary isn't available, try to promote the first available fallback font.
  for (const candidate of parts.slice(1)) {
    if (isGenericFontFamily(candidate)) {
      continue;
    }

    const candidateOk = canLoadFontFamily(candidate, fontSize);
    if (candidateOk) {
      const remaining = parts.filter((part) => part !== candidate).join(", ");
      const reordered = remaining ? `${candidate}, ${remaining}` : candidate;
      return appendTerminalIconFallback(reordered);
    }
  }

  return appendTerminalIconFallback(formatted);
}

const TERMINAL_FONT_LOAD_TEST_STRING = "abcdefghijklmnopqrstuvwxyz0123456789";
const TERMINAL_ICON_LOAD_TEST_STRING = String.fromCodePoint(0xf024b);

async function preloadTerminalWebfonts(
  resolvedFontFamily: string,
  fontSize: number
): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  const fontFaceSet = document.fonts;
  if (!fontFaceSet || typeof fontFaceSet.load !== "function") {
    return;
  }

  try {
    await Promise.all([
      fontFaceSet.load(`${fontSize}px ${resolvedFontFamily}`, TERMINAL_FONT_LOAD_TEST_STRING),
      fontFaceSet.load(
        `${fontSize}px ${formatCssFontFamilyList(TERMINAL_ICON_FALLBACK_FAMILY)}`,
        TERMINAL_ICON_LOAD_TEST_STRING
      ),
    ]);
  } catch (err) {
    console.warn("[TerminalView] Failed to preload webfonts:", err);
  }
}

interface TerminalViewProps {
  workspaceId: string;
  /** Session ID to connect to (required - must be created before mounting) */
  sessionId: string;
  visible: boolean;
  /**
   * Whether to set document.title based on workspace name.
   *
   * Default: true (used by the dedicated terminal window).
   * Set to false when embedding inside the app (e.g. RightSidebar).
   */
  setDocumentTitle?: boolean;
  /** Called when the terminal title changes (via OSC escape sequences from running processes) */
  onTitleChange?: (title: string) => void;
  /** Called once after auto-focus successfully lands (used to clear parent state). */
  onAutoFocusConsumed?: () => void;
  /**
   * Whether to auto-focus the terminal on mount/visibility change.
   *
   * Default: true (used by dedicated terminal window).
   * Set to false when embedding (e.g. RightSidebar) to avoid stealing focus on workspace switch.
   */
  autoFocus?: boolean;
  /** Called when the terminal process exits. */
  onExit?: (exitCode: number) => void;
  /**
   * Workspace/tab identity for the badge overlay. When omitted (pop-out
   * window), workspace names are resolved via the API and the tab name
   * falls back to the latest OSC title.
   */
  workspaceName?: string;
  projectName?: string;
  tabName?: string;
  /** 0-based tab position for the badge's {index} token; unknown in pop-out windows. */
  tabIndex?: number;
  /**
   * OSC title carried over from before a pop-out handoff, so the badge doesn't
   * reset to "Terminal" until the shell emits another title.
   */
  initialTitle?: string;
}

export function TerminalView({
  workspaceId,
  sessionId,
  visible,
  setDocumentTitle = true,
  onTitleChange,
  onAutoFocusConsumed,
  autoFocus = true,
  onExit,
  workspaceName,
  projectName,
  tabName,
  tabIndex,
  initialTitle,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const autoFocusRef = useRef(autoFocus);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const exitHandledRef = useRef(false);
  const onExitRef = useRef(onExit);
  // The right sidebar can recreate onExit while chat streams. Sync the latest committed
  // callback through a ref so subscriptions stay stable without exposing render-time props.
  useLayoutEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // Track whether we've received the initial screen state from backend
  const [isLoading, setIsLoading] = useState(true);

  const [rawTerminalFontConfig] = usePersistedState<TerminalFontConfig>(
    TERMINAL_FONT_CONFIG_KEY,
    DEFAULT_TERMINAL_FONT_CONFIG,
    { listener: true }
  );
  const terminalFontConfig = normalizeTerminalFontConfig(rawTerminalFontConfig);
  const { api } = useAPI();
  const router = useTerminalRouter();
  const routerRef = useRef(router);
  const sessionIdRef = useRef(sessionId);
  // Keep refs in sync so input/resize handlers always use the latest router/session.
  routerRef.current = router;
  sessionIdRef.current = sessionId;

  // Pop-out windows have no WorkspaceProvider, so the badge overlay's
  // workspace identity is resolved here alongside the window title.
  const [resolvedNames, setResolvedNames] = useState<{
    workspaceName: string;
    projectName: string;
  } | null>(null);
  // Latest OSC 0/1/2 title; badge fallback for pop-out windows where the
  // sidebar's per-tab title map is unavailable.
  const [oscTitle, setOscTitle] = useState<string | null>(initialTitle ?? null);

  // Set window title (dedicated terminal window only)
  useEffect(() => {
    if (!api || !setDocumentTitle) return;
    const setWindowDetails = async () => {
      try {
        const workspaces = await api.workspace.list();
        const workspace = workspaces.find((ws) => ws.id === workspaceId);
        if (workspace) {
          document.title = `Terminal — ${workspace.projectName}/${workspace.name}`;
          setResolvedNames({ workspaceName: workspace.name, projectName: workspace.projectName });
        } else {
          document.title = `Terminal — ${workspaceId}`;
        }
      } catch {
        document.title = `Terminal — ${workspaceId}`;
      }
    };
    void setWindowDetails();
  }, [api, workspaceId, setDocumentTitle]);

  const autoFocusConsumedRef = useRef(false);

  const consumeAutoFocus = useCallback(() => {
    if (autoFocusConsumedRef.current) {
      return;
    }
    autoFocusConsumedRef.current = true;
    onAutoFocusConsumed?.();
  }, [onAutoFocusConsumed]);

  const handleExit = useCallback((code: number) => {
    if (exitHandledRef.current) {
      return;
    }
    exitHandledRef.current = true;

    const term = termRef.current;
    if (term) {
      try {
        term.write(`\r\n[Process exited with code ${code}]\r\n`);
      } catch (err) {
        console.warn("[TerminalView] Error writing exit message:", err);
      }
    }

    onExitRef.current?.(code);
  }, []);

  useEffect(() => {
    autoFocusRef.current = autoFocus;
    autoFocusConsumedRef.current = false;
  }, [autoFocus]);

  useEffect(() => {
    if (!autoFocus || !visible || !terminalReady || autoFocusConsumedRef.current) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 60;

    const tryFocus = () => {
      if (cancelled) {
        return;
      }

      const term = termRef.current;
      const container = containerRef.current;
      if (!term || !container) {
        return;
      }

      term.focus();
      const textarea = container.querySelector("textarea");
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.focus();
      }

      const active = document.activeElement;
      const isFocused = active instanceof HTMLElement && container.contains(active);
      if (isFocused) {
        consumeAutoFocus();
        return;
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        requestAnimationFrame(tryFocus);
      } else {
        consumeAutoFocus();
      }
    };

    const rafId = requestAnimationFrame(tryFocus);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [autoFocus, visible, terminalReady, consumeAutoFocus]);

  // Reset loading state when session changes
  useEffect(() => {
    setIsLoading(true);
  }, [sessionId]);

  // Listen for exit events even when the terminal is hidden.
  useEffect(() => {
    exitHandledRef.current = false;
    if (!api) {
      return;
    }

    const controller = new AbortController();
    const listen = async () => {
      try {
        const iterator = await api.terminal.onExit({ sessionId }, { signal: controller.signal });
        for await (const code of iterator) {
          if (!controller.signal.aborted) {
            handleExit(code);
          }
          break;
        }
      } catch {
        if (!controller.signal.aborted) {
          // Treat failed subscriptions as exits (session ended before listener attached).
          handleExit(0);
        }
      }
    };

    listen().catch((err) => {
      console.warn("[TerminalView] Exit listener failed:", err);
    });

    return () => {
      controller.abort();
    };
  }, [api, sessionId, handleExit]);

  // Subscribe to router when terminal is ready and visible
  useEffect(() => {
    // Router may be null during API reconnection - skip subscription until it's back
    if (!visible || !terminalReady || !termRef.current || !router) {
      return;
    }

    // Capture current terminal ref for this subscription's lifetime
    const term = termRef.current;

    // Clear terminal before subscribing to prevent any stale content flash
    try {
      term.clear();
    } catch (err) {
      console.warn("[TerminalView] Error clearing terminal:", err);
    }

    const unsubscribe = router.subscribe(sessionId, {
      onOutput: (data) => {
        try {
          term.write(data);
        } catch (err) {
          // xterm WASM can throw "memory access out of bounds" intermittently
          console.warn("[TerminalView] Error writing output:", err);
        }
      },
      onScreenState: (state) => {
        // Write screen state (may be empty for new sessions)
        if (state) {
          try {
            term.write(state);
          } catch (err) {
            // xterm WASM can throw "memory access out of bounds" intermittently
            console.warn("[TerminalView] Error writing screenState:", err);
          }
        }
        // Mark loading complete - we now have valid content to show
        setIsLoading(false);
      },
      onExit: handleExit,
    });

    // Send initial resize to sync PTY dimensions
    const { cols, rows } = term;
    void router.resize(sessionId, cols, rows);

    return unsubscribe;
  }, [visible, terminalReady, sessionId, router, handleExit]);

  // Keep ref to onTitleChange for use in terminal callback
  const onTitleChangeRef = useRef(onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  const disposeOnDataRef = useRef<{ dispose: () => void } | null>(null);
  const disposeOnTitleChangeRef = useRef<{ dispose: () => void } | null>(null);
  const initInProgressRef = useRef(false);

  // Clean up the terminal instance when workspace changes (or component unmounts).
  useEffect(() => {
    const containerEl = containerRef.current;

    return () => {
      disposeOnDataRef.current?.dispose();
      disposeOnTitleChangeRef.current?.dispose();
      disposeOnDataRef.current = null;
      disposeOnTitleChangeRef.current = null;

      termRef.current?.dispose();

      // Ensure the DOM is clean even if the terminal init was interrupted.
      containerEl?.replaceChildren();

      termRef.current = null;
      fitAddonRef.current = null;
      initInProgressRef.current = false;
      setTerminalReady(false);
    };
  }, [workspaceId]);

  // Initialize terminal when it first becomes visible.
  // We intentionally keep the terminal instance alive when hidden so we don't lose
  // frontend-only state (like scrollback) and so TUI apps don't thrash on tab switches.
  useEffect(() => {
    if (!visible) return;
    if (termRef.current || initInProgressRef.current) return;

    const containerEl = containerRef.current;
    if (!containerEl) {
      return;
    }

    const shouldAutoFocusOnInit = autoFocusRef.current;

    // StrictMode will run this effect twice in dev (setup → cleanup → setup).
    // If the first async init completes after cleanup, we can end up with two ghostty-web
    // terminals wired to the same DOM node (double cursor + duplicated input). Make the
    // init path explicitly cancelable.
    let cancelled = false;
    initInProgressRef.current = true;

    let terminal: Terminal | null = null;
    let disposeOnData: { dispose: () => void } | null = null;
    let disposeOnTitleChange: { dispose: () => void } | null = null;

    setTerminalError(null);

    const initTerminal = async () => {
      try {
        // Initialize ghostty-web WASM module (idempotent, safe to call multiple times)
        await init();

        if (cancelled) {
          return;
        }

        // Be defensive: if anything previously mounted into this container (e.g. from an
        // interrupted init), clear it before opening a new terminal.
        containerEl.replaceChildren();

        // Resolve CSS variables for xterm.js (canvas rendering doesn't support CSS vars)
        const styles = getComputedStyle(document.documentElement);
        const terminalBg = styles.getPropertyValue("--color-terminal-bg").trim() || "#1e1e1e";

        const resolvedFontFamily = resolveTerminalFontFamily(
          terminalFontConfig.fontFamily,
          terminalFontConfig.fontSize
        );

        await preloadTerminalWebfonts(resolvedFontFamily, terminalFontConfig.fontSize);

        if (cancelled) {
          return;
        }
        const terminalFg = styles.getPropertyValue("--color-terminal-fg").trim() || "#d4d4d4";

        terminal = new Terminal({
          fontSize: terminalFontConfig.fontSize,
          fontFamily: resolvedFontFamily,
          // Start with no blinking - we enable it on focus
          cursorBlink: false,
          theme: {
            background: terminalBg,
            foreground: terminalFg,
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        terminal.open(containerEl);
        fitAddon.fit();

        // Platform-aware clipboard shortcuts matching VS Code's integrated terminal:
        // https://code.visualstudio.com/docs/terminal/basics#_copy-paste
        //
        // - macOS: Cmd+C/V (standard Mac shortcuts, Cmd is distinct from Ctrl)
        // - Linux: Ctrl+Shift+C/V (Ctrl+C reserved for SIGINT, so terminals use Shift)
        // - Windows: Ctrl+C/V (copy only when selection exists, otherwise SIGINT)
        //
        // Copy only triggers when there's a selection. Without selection, Ctrl+C falls
        // through to ghostty-web which sends SIGINT to the running process.
        const isMac = navigator.platform.includes("Mac");
        const isWindows = navigator.platform.includes("Win");

        // Capture terminal reference for the closure
        const term = terminal;
        // ghostty-web custom key handler: return true to PREVENT default, false to ALLOW default
        term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
          // Only handle keydown events, let ghostty handle keyup/keypress
          if (ev.type !== "keydown") return false;

          // Use ev.key.toLowerCase() for layout-aware detection that handles Caps Lock.
          // This ensures Dvorak/Colemak users get shortcuts on their layout's C/V keys.
          const key = ev.key.toLowerCase();

          // Paste shortcuts
          const isPaste =
            (isMac && ev.metaKey && key === "v") ||
            (!isMac && !isWindows && ev.ctrlKey && ev.shiftKey && key === "v") ||
            (isWindows && ev.ctrlKey && !ev.shiftKey && key === "v");

          if (isPaste) {
            void navigator.clipboard.readText().then((text) => {
              if (text) term.paste(text);
            });
            return true; // Prevent default - we handled it
          }

          // Copy shortcuts
          const isMacCopy = isMac && ev.metaKey && key === "c";
          const isLinuxCopy = !isMac && !isWindows && ev.ctrlKey && ev.shiftKey && key === "c";
          const isWindowsCopy = isWindows && ev.ctrlKey && !ev.shiftKey && key === "c";

          // Linux: Always swallow Ctrl+Shift+C to prevent it becoming SIGINT (no-op if no selection)
          // Mac/Windows: Only intercept when there's a selection (Cmd+C/Ctrl+C without selection is harmless)
          if (isLinuxCopy) {
            if (term.hasSelection()) {
              void navigator.clipboard.writeText(term.getSelection());
            }
            return true; // Prevent default on Linux to avoid SIGINT
          }

          if ((isMacCopy || isWindowsCopy) && term.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection());
            return true; // Prevent default - we handled it
          }

          // Let ghostty handle everything else (including Ctrl+C → SIGINT on Linux when no selection)
          return false;
        });

        // ghostty-web calls focus() internally in open(), which steals focus.
        // It also schedules a delayed focus with setTimeout(0) as "backup".
        // If autoFocus is disabled, blur immediately AND with a delayed blur to counteract.
        // If autoFocus is enabled, focus the hidden textarea to avoid browser caret.
        if (shouldAutoFocusOnInit) {
          const textarea = containerEl.querySelector("textarea");
          if (textarea instanceof HTMLTextAreaElement) {
            textarea.focus();
          }
        } else {
          // Blur immediately
          terminal.blur();
          // Counter the delayed focus() in ghostty-web
          const termToBlur = terminal;
          setTimeout(() => {
            termToBlur.blur();
          }, 0);
        }

        // User input → router
        // Drop input when the router has been disposed during reconnects.
        disposeOnData = terminal.onData((data: string) => {
          const activeRouter = routerRef.current;
          if (!activeRouter) {
            return;
          }
          activeRouter.sendInput(sessionIdRef.current, data);
        });

        // Terminal title changes (from OSC escape sequences like "echo -ne '\033]0;Title\007'")
        // Use ref to always get latest callback
        disposeOnTitleChange = terminal.onTitleChange((title: string) => {
          setOscTitle(title);
          onTitleChangeRef.current?.(title);
        });

        termRef.current = terminal;
        fitAddonRef.current = fitAddon;
        disposeOnDataRef.current = disposeOnData;
        disposeOnTitleChangeRef.current = disposeOnTitleChange;

        setTerminalReady(true);
      } catch (err) {
        if (cancelled) {
          return;
        }

        console.error("Failed to initialize terminal:", err);
        setTerminalError(err instanceof Error ? err.message : "Failed to initialize terminal");
      } finally {
        initInProgressRef.current = false;
      }
    };

    void initTerminal();

    return () => {
      cancelled = true;

      // If the terminal finished initializing, we keep it alive across visible toggles.
      if (termRef.current) {
        return;
      }

      // Otherwise, clean up any partially created resources so a future attempt can succeed.
      disposeOnData?.dispose();
      disposeOnTitleChange?.dispose();
      terminal?.dispose();
      containerEl.replaceChildren();
      initInProgressRef.current = false;
    };
  }, [
    visible,
    workspaceId,
    router,
    sessionId,
    terminalFontConfig.fontFamily,
    terminalFontConfig.fontSize,
  ]);

  // Apply persisted terminal font options and keep PTY size in sync.

  useEffect(() => {
    if (!terminalReady) {
      return;
    }

    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) {
      return;
    }

    let cancelled = false;

    const applyFont = async () => {
      const resolvedFontFamily = resolveTerminalFontFamily(
        terminalFontConfig.fontFamily,
        terminalFontConfig.fontSize
      );

      await preloadTerminalWebfonts(resolvedFontFamily, terminalFontConfig.fontSize);

      if (cancelled || term !== termRef.current) {
        return;
      }

      term.options.fontFamily = resolvedFontFamily;
      term.options.fontSize = terminalFontConfig.fontSize;

      // Avoid resizing the PTY when hidden (container may be 0x0).
      if (!visible) {
        return;
      }

      // ghostty-web measures character sizes asynchronously after font changes.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      if (cancelled || term !== termRef.current) {
        return;
      }

      const proposed = fitAddon.proposeDimensions();
      const activeRouter = routerRef.current;
      if (!proposed || !activeRouter || activeRouter !== router) {
        return;
      }

      try {
        await activeRouter.resize(sessionId, proposed.cols, proposed.rows);

        if (cancelled || term !== termRef.current || routerRef.current !== activeRouter) {
          return;
        }

        term.resize(proposed.cols, proposed.rows);
      } catch (err) {
        console.error("[TerminalView] Error resizing after terminal font change:", err);
      }
    };

    void applyFont();

    return () => {
      cancelled = true;
    };
  }, [
    router,
    sessionId,
    terminalReady,
    terminalFontConfig.fontFamily,
    terminalFontConfig.fontSize,
    visible,
  ]);

  // Track focus/blur on the terminal container to control cursor blinking
  useEffect(() => {
    if (!terminalReady || !containerRef.current) {
      return;
    }

    const container = containerRef.current;

    const handleFocusIn = () => {
      container.setAttribute("data-terminal-autofocus", "true");
      if (termRef.current) {
        termRef.current.options.cursorBlink = true;
      }
      if (autoFocus) {
        consumeAutoFocus();
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      // Only blur if focus is leaving the container entirely
      if (!container.contains(e.relatedTarget as Node)) {
        container.removeAttribute("data-terminal-autofocus");
        if (termRef.current) {
          termRef.current.options.cursorBlink = false;
        }
      }
    };

    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);

    return () => {
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
      container.removeAttribute("data-terminal-autofocus");
    };
  }, [autoFocus, consumeAutoFocus, terminalReady]);

  // Resize on container size change
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !containerRef.current || !termRef.current) {
      return;
    }

    let lastCols = 0;
    let lastRows = 0;
    let resizeInFlight = false;
    let pendingResize = false;
    let rafId: number | null = null;
    let disposed = false;

    // PTY-first resize: calculate desired dimensions, resize the PTY, then resize the
    // frontend terminal to match.
    //
    // This eliminates the race that causes output clobbering when the frontend resizes
    // before the PTY (shell output is formatted for old dimensions but displayed in the
    // already-resized frontend terminal).
    const doResize = async () => {
      const activeRouter = routerRef.current;
      // Router may be null during API reconnection - skip resize
      if (!fitAddonRef.current || !activeRouter || activeRouter !== router) return;

      // Calculate what size we want without applying it yet.
      // (fit() would resize the frontend immediately, reintroducing the race.)
      const proposed = fitAddonRef.current.proposeDimensions();
      if (!proposed) return;

      const { cols, rows } = proposed;
      if (cols === lastCols && rows === lastRows) return;

      // Record the requested dimensions up front so we don't re-request the same resize
      // if more resize events arrive while awaiting the backend.
      lastCols = cols;
      lastRows = rows;

      try {
        // Resize PTY first - wait for backend to confirm.
        await activeRouter.resize(sessionId, cols, rows);

        if (disposed || routerRef.current !== activeRouter) {
          return;
        }

        // Now resize frontend to match the PTY *exactly*.
        // We intentionally do NOT call fit() here because it can recompute dimensions
        // (if the container changed while awaiting) and would resize the frontend without
        // resizing the PTY, reintroducing the mismatch.
        termRef.current?.resize(cols, rows);
      } catch (err) {
        // Allow future retries if the resize call failed.
        lastCols = 0;
        lastRows = 0;
        console.error("[TerminalView] Error resizing terminal:", err);
      }
    };

    const handleResize = () => {
      if (disposed) {
        return;
      }

      // If a resize is already in flight, mark that we need another one
      if (resizeInFlight) {
        pendingResize = true;
        return;
      }

      resizeInFlight = true;
      pendingResize = false;

      // Use RAF to batch rapid resize events (e.g., window drag)
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;

        void doResize().finally(() => {
          resizeInFlight = false;
          // If another resize was requested while we were busy, handle it
          if (pendingResize) {
            handleResize();
          }
        });
      });
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Also listen to window resize as backup
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [visible, terminalReady, router, sessionId]);

  const errorMessage = terminalError;

  // Focus the terminal when the container is clicked
  const handleContainerClick = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus();
    }
  }, []);

  // Show loading overlay until we receive initial screen state
  const showLoading = isLoading && terminalReady && visible;

  return (
    <div
      className="terminal-view"
      style={{
        display: visible ? "flex" : "none",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        backgroundColor: "var(--color-terminal-bg)",
        position: "relative",
      }}
      onClick={handleContainerClick}
    >
      {errorMessage && (
        <div className="border-b border-red-900/30 bg-red-900/20 p-2 text-sm text-red-400">
          Terminal Error: {errorMessage}
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-container"
        {...{ [TERMINAL_CONTAINER_ATTR]: true }}
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          // ghostty-web uses a contenteditable root for input; hide the browser caret
          // so we don't show a "second cursor".
          caretColor: "transparent",
          // Hide terminal content while loading to prevent flash
          visibility: showLoading ? "hidden" : "visible",
          // Add padding so text doesn't touch edges (FitAddon accounts for this)
          padding: 4,
        }}
      />
      {/* Loading overlay - shows until we receive screen state from backend */}
      {showLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "var(--color-terminal-bg)",
          }}
        >
          <span className="text-muted animate-pulse text-sm">Connecting...</span>
        </div>
      )}
      {!showLoading && (
        <TerminalBadgeOverlay
          workspaceName={workspaceName ?? resolvedNames?.workspaceName ?? workspaceId}
          projectName={projectName ?? resolvedNames?.projectName ?? ""}
          tabName={tabName ?? oscTitle ?? getTerminalTabFallbackName(0)}
          tabIndex={tabIndex}
        />
      )}
    </div>
  );
}
