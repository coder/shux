import React, { useEffect, useState, useCallback, useRef } from "react";
import { useTheme, THEME_OPTIONS, type ThemePreference } from "@/browser/contexts/ThemeContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { useTranscriptDensity } from "@/browser/hooks/useTranscriptDensity";
import { useAPI } from "@/browser/contexts/API";
import { useExperiment, useExperimentValue } from "@/browser/contexts/ExperimentsContext";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import assert from "@/common/utils/assert";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  EDITOR_CONFIG_KEY,
  DEFAULT_EDITOR_CONFIG,
  TERMINAL_FONT_CONFIG_KEY,
  DEFAULT_TERMINAL_FONT_CONFIG,
  TERMINAL_BADGE_CONFIG_KEY,
  TERMINAL_BADGE_POSITIONS,
  DEFAULT_TERMINAL_BADGE_CONFIG,
  LAUNCH_BEHAVIOR_KEY,
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  BASH_COLLAPSED_SUMMARY_MODES,
  CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
  DEFAULT_BASH_COLLAPSED_SUMMARY_MODE,
  SIDEBAR_AGE_GROUPING_KEY,
  SIDEBAR_FLAT_MODE_KEY,
  SIDEBAR_HIDE_SUBAGENTS_KEY,
  TRANSCRIPT_DENSITIES,
  normalizeBashCollapsedSummaryMode,
  normalizeEditorConfig,
  normalizeTerminalBadgeConfig,
  normalizeTerminalFontConfig,
  normalizeTranscriptDensity,
  type BashCollapsedSummaryMode,
  type TranscriptDensity,
  type EditorConfig,
  type EditorType,
  type LaunchBehavior,
  type TerminalBadgeConfig,
  type TerminalBadgePosition,
  type TerminalFontConfig,
} from "@/common/constants/storage";
import {
  appendTerminalIconFallback,
  getPrimaryFontFamily,
  isFontFamilyAvailableInBrowser,
  isGenericFontFamily,
} from "@/browser/terminal/terminalFontFamily";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  isCoderWorkspaceArchiveBehavior,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  isWorktreeArchiveBehavior,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";

function getTerminalFontAvailabilityWarning(config: TerminalFontConfig): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  const primary = getPrimaryFontFamily(config.fontFamily);
  if (!primary) {
    return undefined;
  }

  const normalizedPrimary = primary.trim();
  if (!normalizedPrimary) {
    return undefined;
  }

  // Geist Mono is bundled via @font-face. Treat it as always available so we don't show a
  // false-negative warning before the webfont finishes loading.
  if (normalizedPrimary.toLowerCase() === "geist mono") {
    return undefined;
  }

  if (isGenericFontFamily(normalizedPrimary)) {
    return undefined;
  }

  const primaryAvailable = isFontFamilyAvailableInBrowser(normalizedPrimary, config.fontSize);
  if (!primaryAvailable) {
    if (normalizedPrimary.endsWith("Nerd Font") && !normalizedPrimary.endsWith("Nerd Font Mono")) {
      const monoCandidate = `${normalizedPrimary} Mono`;
      if (isFontFamilyAvailableInBrowser(monoCandidate, config.fontSize)) {
        return `Font "${normalizedPrimary}" not found. Try "${monoCandidate}".`;
      }
    }

    return `Font "${normalizedPrimary}" not found in this browser.`;
  }

  return undefined;
}

const COMPACTION_STRATEGIES = [
  { value: "summarize", label: "Summarize" },
  { value: "continuous", label: "Continuous" },
  { value: "token-budget", label: "Token Budget" },
] as const;
type CompactionStrategy = (typeof COMPACTION_STRATEGIES)[number]["value"];

const EDITOR_OPTIONS: Array<{ value: EditorType; label: string }> = [
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "Custom" },
];

// Keep the legacy "dashboard" storage value for backwards compatibility even
// though the dedicated landing page has been removed. It now means "open the
// recent project page".
const LAUNCH_BEHAVIOR_OPTIONS = [
  { value: "dashboard", label: "Recent project" },
  { value: "new-chat", label: "New chat on recent project" },
  { value: "last-workspace", label: "Last visited workspace" },
] as const;
const BASH_COLLAPSED_SUMMARY_MODE_LABELS: Record<BashCollapsedSummaryMode, string> = {
  command: "Command",
  "intent-command": "Intent and command",
  intent: "Intent",
};
const BASH_COLLAPSED_SUMMARY_MODE_OPTIONS = BASH_COLLAPSED_SUMMARY_MODES.map((value) => ({
  value,
  label: BASH_COLLAPSED_SUMMARY_MODE_LABELS[value],
}));
const TRANSCRIPT_DENSITY_LABELS: Record<TranscriptDensity, string> = {
  normal: "Normal",
  hyper: "Hyper",
};
const TRANSCRIPT_DENSITY_OPTIONS = TRANSCRIPT_DENSITIES.map((value) => ({
  value,
  label: TRANSCRIPT_DENSITY_LABELS[value],
}));
const TERMINAL_BADGE_POSITION_LABELS: Record<TerminalBadgePosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};
const TERMINAL_BADGE_POSITION_OPTIONS = TERMINAL_BADGE_POSITIONS.map((value) => ({
  value,
  label: TERMINAL_BADGE_POSITION_LABELS[value],
}));
const ARCHIVE_BEHAVIOR_OPTIONS = [
  { value: "keep", label: "Keep running" },
  { value: "stop", label: "Stop workspace" },
  { value: "delete", label: "Delete workspace" },
] as const;
const WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS: Array<{
  value: WorktreeArchiveBehavior;
  label: string;
}> = [
  { value: "keep", label: "Keep checkout" },
  { value: "delete", label: "Delete checkout" },
  { value: "snapshot", label: "Snapshot and delete" },
];

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

export function GeneralSection() {
  const { themePreference, setTheme } = useTheme();
  const { api } = useAPI();
  const telemetry = useTelemetry();
  const [continuousCompaction, setContinuousCompaction] = useExperiment(
    EXPERIMENT_IDS.CONTINUOUS_COMPACTION
  );
  const [tokenBudget, setTokenBudget] = useExperiment(EXPERIMENT_IDS.TOKEN_BUDGET);
  const ptc = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const rlm = useExperimentValue(EXPERIMENT_IDS.RLM);
  // Preserve legacy both-enabled precedence without rewriting preferences on load.
  const compactionStrategy: CompactionStrategy = continuousCompaction
    ? "continuous"
    : tokenBudget
      ? "token-budget"
      : "summarize";
  const tokenBudgetInactive = compactionStrategy === "token-budget" && ptc && rlm;
  const [compactionOpen, setCompactionOpen] = useState(false);
  const sameStrategyActivation = useRef<CompactionStrategy | null>(null);
  const markCompactionActivation = (value: CompactionStrategy) => {
    if (value !== compactionStrategy) return;
    // Radix omits onValueChange for an unchanged value. Only normalize if its
    // activation also closes the menu, not on Escape or a typeahead-only Space.
    sameStrategyActivation.current = value;
    queueMicrotask(() => {
      sameStrategyActivation.current = null;
    });
  };
  const handleCompactionStrategyChange = (value: string) => {
    assert(
      value === "summarize" || value === "continuous" || value === "token-budget",
      `Unexpected compaction strategy: ${value}`
    );
    switch (value) {
      case "continuous":
        setContinuousCompaction(true);
        setTokenBudget(false);
        break;
      case "token-budget":
        setTokenBudget(true);
        setContinuousCompaction(false);
        break;
      case "summarize":
        setTokenBudget(false);
        setContinuousCompaction(false);
        break;
      default: {
        const exhaustive: never = value;
        return exhaustive;
      }
    }
    // Retain the override events previously emitted by the individual experiment switches.
    telemetry.experimentOverridden(EXPERIMENT_IDS.CONTINUOUS_COMPACTION, value === "continuous");
    telemetry.experimentOverridden(EXPERIMENT_IDS.TOKEN_BUDGET, value === "token-budget");
  };
  const [launchBehavior, setLaunchBehavior] = usePersistedState<LaunchBehavior>(
    LAUNCH_BEHAVIOR_KEY,
    "dashboard"
  );
  const [rawBashCollapsedSummaryMode, setBashCollapsedSummaryMode] = usePersistedState<unknown>(
    BASH_COLLAPSED_SUMMARY_MODE_KEY,
    DEFAULT_BASH_COLLAPSED_SUMMARY_MODE
  );
  const bashCollapsedSummaryMode = normalizeBashCollapsedSummaryMode(rawBashCollapsedSummaryMode);
  const [sidebarAgeGrouping, setSidebarAgeGrouping] = usePersistedState<boolean>(
    SIDEBAR_AGE_GROUPING_KEY,
    true
  );
  const [sidebarFlatMode, setSidebarFlatMode] = usePersistedState<boolean>(
    SIDEBAR_FLAT_MODE_KEY,
    false,
    { listener: true }
  );
  // The command palette also toggles this key, so stay subscribed to
  // external updates while Settings is mounted.
  const [sidebarHideSubAgents, setSidebarHideSubAgents] = usePersistedState<boolean>(
    SIDEBAR_HIDE_SUBAGENTS_KEY,
    false,
    { listener: true }
  );
  const [transcriptDensity, setTranscriptDensity] = useTranscriptDensity();
  const [rawTerminalFontConfig, setTerminalFontConfig] = usePersistedState<TerminalFontConfig>(
    TERMINAL_FONT_CONFIG_KEY,
    DEFAULT_TERMINAL_FONT_CONFIG
  );
  const terminalFontConfig = normalizeTerminalFontConfig(rawTerminalFontConfig);
  const terminalFontWarning = getTerminalFontAvailabilityWarning(terminalFontConfig);

  const terminalFontPreviewFamily = appendTerminalIconFallback(terminalFontConfig.fontFamily);
  const terminalFontPreviewText = [
    String.fromCodePoint(0xf024b), // md-folder
    String.fromCodePoint(0xf0214), // md-file
    String.fromCodePoint(0xf02a2), // md-git
    String.fromCodePoint(0xea85), // cod-terminal
    String.fromCodePoint(0xe725), // dev-git_branch
    String.fromCodePoint(0xf135), // fa-rocket
  ].join(" ");

  // The command palette also toggles this key, so stay subscribed to
  // external updates while Settings is mounted.
  const [rawTerminalBadgeConfig, setTerminalBadgeConfig] = usePersistedState<TerminalBadgeConfig>(
    TERMINAL_BADGE_CONFIG_KEY,
    DEFAULT_TERMINAL_BADGE_CONFIG,
    { listener: true }
  );
  const terminalBadgeConfig = normalizeTerminalBadgeConfig(rawTerminalBadgeConfig);

  const [rawEditorConfig, setEditorConfig] = usePersistedState<EditorConfig>(
    EDITOR_CONFIG_KEY,
    DEFAULT_EDITOR_CONFIG
  );
  const editorConfig = normalizeEditorConfig(rawEditorConfig);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshHostLoaded, setSshHostLoaded] = useState(false);
  const [defaultProjectDir, setDefaultProjectDir] = useState("");
  const [cloneDirLoaded, setCloneDirLoaded] = useState(false);
  // Track whether the initial load succeeded to prevent saving empty string
  // (which would clear the config) when the initial fetch failed.
  const [cloneDirLoadedOk, setCloneDirLoadedOk] = useState(false);

  // Backend config: default to the safest archive behavior until config finishes loading.
  const [archiveBehavior, setArchiveBehavior] = useState<CoderWorkspaceArchiveBehavior>(
    DEFAULT_CODER_ARCHIVE_BEHAVIOR
  );
  const [worktreeArchiveBehavior, setWorktreeArchiveBehavior] = useState<WorktreeArchiveBehavior>(
    DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
  );
  const [archiveSettingsLoaded, setArchiveSettingsLoaded] = useState(false);
  const [chatTranscriptFullWidth, setChatTranscriptFullWidth] = useState(false);
  const [llmDebugLogs, setLlmDebugLogs] = useState(false);
  const archiveBehaviorLoadNonceRef = useRef(0);
  const archiveBehaviorRef = useRef<CoderWorkspaceArchiveBehavior>(DEFAULT_CODER_ARCHIVE_BEHAVIOR);
  const worktreeArchiveBehaviorRef = useRef<WorktreeArchiveBehavior>(
    DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
  );

  const chatTranscriptFullWidthLoadNonceRef = useRef(0);
  const llmDebugLogsLoadNonceRef = useRef(0);

  // updateCoderPrefs writes config.json on the backend. Serialize (and coalesce) updates so rapid
  // selections can't race and persist a stale value via out-of-order writes.
  const archiveBehaviorUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const chatTranscriptFullWidthUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const llmDebugLogsUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const archiveBehaviorPendingUpdateRef = useRef<CoderWorkspaceArchiveBehavior | undefined>(
    undefined
  );
  const worktreeArchiveBehaviorPendingUpdateRef = useRef<WorktreeArchiveBehavior | undefined>(
    undefined
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    setArchiveSettingsLoaded(false);
    const archiveBehaviorNonce = ++archiveBehaviorLoadNonceRef.current;
    const chatTranscriptFullWidthNonce = ++chatTranscriptFullWidthLoadNonceRef.current;
    const llmDebugLogsNonce = ++llmDebugLogsLoadNonceRef.current;

    void api.config
      .getConfig()
      .then((cfg) => {
        // If the user changed the setting while this request was in flight, keep the UI selection.
        if (archiveBehaviorNonce === archiveBehaviorLoadNonceRef.current) {
          const nextArchiveBehavior = isCoderWorkspaceArchiveBehavior(
            cfg.coderWorkspaceArchiveBehavior
          )
            ? cfg.coderWorkspaceArchiveBehavior
            : DEFAULT_CODER_ARCHIVE_BEHAVIOR;
          setArchiveBehavior(nextArchiveBehavior);
          archiveBehaviorRef.current = nextArchiveBehavior;

          const nextWorktreeArchiveBehavior = isWorktreeArchiveBehavior(cfg.worktreeArchiveBehavior)
            ? cfg.worktreeArchiveBehavior
            : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
          setWorktreeArchiveBehavior(nextWorktreeArchiveBehavior);
          worktreeArchiveBehaviorRef.current = nextWorktreeArchiveBehavior;
          setArchiveSettingsLoaded(true);
        }

        // Use independent nonces so appearance/debug toggles do not discard archive updates.
        if (chatTranscriptFullWidthNonce === chatTranscriptFullWidthLoadNonceRef.current) {
          const enabled = cfg.chatTranscriptFullWidth === true;
          setChatTranscriptFullWidth(enabled);
          updatePersistedState<boolean | undefined>(
            CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
            enabled ? true : undefined
          );
        }

        if (llmDebugLogsNonce === llmDebugLogsLoadNonceRef.current) {
          setLlmDebugLogs(cfg.llmDebugLogs === true);
        }
      })
      .catch(() => {
        if (archiveBehaviorNonce === archiveBehaviorLoadNonceRef.current) {
          // Fall back to the safe defaults already in state so the controls can recover after a
          // config read failure and the next user change can persist a fresh value.
          setArchiveSettingsLoaded(true);
        }
      });
  }, [api]);

  const queueArchiveBehaviorUpdate = useCallback(() => {
    if (!api?.config?.updateCoderPrefs || !archiveSettingsLoaded) {
      return;
    }

    archiveBehaviorUpdateChainRef.current = archiveBehaviorUpdateChainRef.current
      .then(async () => {
        // Drain pending refs so changes that happen while updateCoderPrefs is in-flight always
        // schedule another serialized write with the latest combined preferences.
        for (;;) {
          const pendingArchiveBehavior = archiveBehaviorPendingUpdateRef.current;
          const pendingWorktreeArchiveBehavior = worktreeArchiveBehaviorPendingUpdateRef.current;
          if (
            pendingArchiveBehavior === undefined &&
            pendingWorktreeArchiveBehavior === undefined
          ) {
            return;
          }

          // Clear before awaiting so rapid changes coalesce into a new pending value.
          archiveBehaviorPendingUpdateRef.current = undefined;
          worktreeArchiveBehaviorPendingUpdateRef.current = undefined;

          try {
            await api.config.updateCoderPrefs({
              coderWorkspaceArchiveBehavior: pendingArchiveBehavior ?? archiveBehaviorRef.current,
              worktreeArchiveBehavior:
                pendingWorktreeArchiveBehavior ?? worktreeArchiveBehaviorRef.current,
            });
          } catch {
            // Best-effort only. Swallow errors so the queue doesn't get stuck.
          }
        }
      })
      .catch(() => {
        // Best-effort only.
      });
  }, [api, archiveSettingsLoaded]);

  const handleArchiveBehaviorChange = useCallback(
    (behavior: CoderWorkspaceArchiveBehavior) => {
      if (!archiveSettingsLoaded || !api?.config?.updateCoderPrefs) {
        return;
      }

      // Invalidate any in-flight initial load so it doesn't overwrite the user's selection.
      archiveBehaviorLoadNonceRef.current++;
      setArchiveBehavior(behavior);
      archiveBehaviorRef.current = behavior;

      archiveBehaviorPendingUpdateRef.current = behavior;
      queueArchiveBehaviorUpdate();
    },
    [api, archiveSettingsLoaded, queueArchiveBehaviorUpdate]
  );

  const handleWorktreeArchiveBehaviorChange = useCallback(
    (behavior: WorktreeArchiveBehavior) => {
      if (!archiveSettingsLoaded || !api?.config?.updateCoderPrefs) {
        return;
      }

      // Invalidate any in-flight archive config load so it does not overwrite the user's choice.
      archiveBehaviorLoadNonceRef.current++;
      setWorktreeArchiveBehavior(behavior);
      worktreeArchiveBehaviorRef.current = behavior;

      worktreeArchiveBehaviorPendingUpdateRef.current = behavior;
      queueArchiveBehaviorUpdate();
    },
    [api, archiveSettingsLoaded, queueArchiveBehaviorUpdate]
  );

  const handleChatTranscriptFullWidthChange = (checked: boolean) => {
    // Invalidate any in-flight config load so it does not overwrite the user's selection.
    chatTranscriptFullWidthLoadNonceRef.current++;
    setChatTranscriptFullWidth(checked);
    updatePersistedState<boolean | undefined>(
      CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
      checked ? true : undefined
    );

    if (!api?.config?.updateChatTranscriptFullWidth) {
      return;
    }

    chatTranscriptFullWidthUpdateChainRef.current = chatTranscriptFullWidthUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() => api.config.updateChatTranscriptFullWidth({ enabled: checked }))
      .catch(() => {
        // Best-effort persistence.
      });
  };

  const handleLlmDebugLogsChange = (checked: boolean) => {
    // Invalidate any in-flight debug-log load so it doesn't overwrite the user's selection.
    llmDebugLogsLoadNonceRef.current++;
    setLlmDebugLogs(checked);
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.LLM_DEBUG_LOGS_CHANGED, {
        enabled: checked,
      })
    );

    if (!api?.config?.updateLlmDebugLogs) {
      return;
    }

    // Serialize writes so rapid toggles always persist the last user choice.
    llmDebugLogsUpdateChainRef.current = llmDebugLogsUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() => api.config.updateLlmDebugLogs({ enabled: checked }))
      .then(() => {
        // Coerce the chain back to Promise<void>.
      })
      .catch(() => {
        // Best-effort persistence.
      });
  };

  // Load SSH host from server on mount (browser mode only)
  useEffect(() => {
    if (isBrowserMode && api) {
      void api.server.getSshHost().then((host) => {
        setSshHost(host ?? "");
        setSshHostLoaded(true);
      });
    }
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }

    void api.projects
      .getDefaultProjectDir()
      .then((dir) => {
        setDefaultProjectDir(dir);
        setCloneDirLoaded(true);
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort only. Keep the input editable if load fails,
        // but don't mark as successfully loaded to prevent clearing config on blur.
        setCloneDirLoaded(true);
      });
  }, [api]);

  const handleEditorChange = (editor: EditorType) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), editor }));
  };

  const handleTerminalFontFamilyChange = (fontFamily: string) => {
    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontFamily }));
  };

  const handleTerminalFontSizeChange = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontSize: parsed }));
  };
  const handleCustomCommandChange = (customCommand: string) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), customCommand }));
  };

  const handleTerminalBadgeEnabledChange = (enabled: boolean) => {
    setTerminalBadgeConfig((prev) => ({ ...normalizeTerminalBadgeConfig(prev), enabled }));
  };

  const handleTerminalBadgeTemplateChange = (template: string) => {
    setTerminalBadgeConfig((prev) => ({ ...normalizeTerminalBadgeConfig(prev), template }));
  };

  const handleTerminalBadgePositionChange = (position: TerminalBadgePosition) => {
    setTerminalBadgeConfig((prev) => ({ ...normalizeTerminalBadgeConfig(prev), position }));
  };

  const handleTerminalBadgeOpacityChange = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      return;
    }

    setTerminalBadgeConfig((prev) => ({
      ...normalizeTerminalBadgeConfig(prev),
      opacity: parsed / 100,
    }));
  };

  const handleTerminalBadgeFontSizeChange = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    setTerminalBadgeConfig((prev) => ({ ...normalizeTerminalBadgeConfig(prev), fontSize: parsed }));
  };

  const handleSshHostChange = useCallback(
    (value: string) => {
      setSshHost(value);
      // Save to server (debounced effect would be better, but keeping it simple)
      void api?.server.setSshHost({ sshHost: value || null });
    },
    [api]
  );

  const handleCloneDirBlur = useCallback(() => {
    // Only persist once the initial load has completed (success or failure).
    // After a failed load, allow saves only if the user has actively typed
    // a non-empty value, so we never silently clear a configured directory.
    if (!cloneDirLoaded || !api) {
      return;
    }

    const trimmedProjectDir = defaultProjectDir.trim();
    if (!cloneDirLoadedOk && !trimmedProjectDir) {
      return;
    }

    void api.projects
      .setDefaultProjectDir({ path: defaultProjectDir })
      .then(() => {
        // A successful save means subsequent clears are safe, even if the
        // initial getDefaultProjectDir() request failed earlier in this session.
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort save: keep current UI state on failure.
      });
  }, [api, cloneDirLoaded, cloneDirLoadedOk, defaultProjectDir]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Theme</div>
              <div className="text-muted text-xs">Choose your preferred theme</div>
            </div>
            <Select
              value={themePreference}
              onValueChange={(value) => setTheme(value as ThemePreference)}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Launch behavior</div>
              <div className="text-muted text-xs">What to show when Xum starts</div>
            </div>
            <Select
              value={launchBehavior}
              onValueChange={(value) => setLaunchBehavior(value as LaunchBehavior)}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAUNCH_BEHAVIOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Sidebar</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Flat chat list</div>
              <div className="text-muted text-xs">
                Show all chats in a single list with project badges instead of project folders.
              </div>
            </div>
            <Switch
              checked={sidebarFlatMode}
              onCheckedChange={setSidebarFlatMode}
              aria-label="Toggle flat chat list"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Group sidebar workspaces by age</div>
              <div className="text-muted text-xs">
                Collect older workspaces under collapsible &quot;Older than X days&quot; sections.
                When off, all workspaces are listed together.
              </div>
            </div>
            <Switch
              checked={sidebarAgeGrouping}
              onCheckedChange={setSidebarAgeGrouping}
              aria-label="Toggle sidebar workspace age grouping"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Hide sub-agents in the sidebar</div>
              <div className="text-muted text-xs">
                Show only top-level workspaces. Parents summarize hidden sub-agent and workflow
                activity in their status line.
              </div>
            </div>
            <Switch
              checked={sidebarHideSubAgents}
              onCheckedChange={setSidebarHideSubAgents}
              aria-label="Toggle hiding sub-agents in the sidebar"
            />
          </div>
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Transcript</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Full-width chat transcript</div>
              <div className="text-muted text-xs">
                Let messages use the full chat pane instead of the default readable column.
              </div>
            </div>
            <Switch
              checked={chatTranscriptFullWidth}
              onCheckedChange={handleChatTranscriptFullWidthChange}
              aria-label="Toggle full-width chat transcript"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Transcript density</div>
              <div className="text-muted text-xs">
                Control how much detail the transcript shows. Hyper collapses completed work into
                expandable summaries.
              </div>
            </div>
            <Select
              value={transcriptDensity}
              onValueChange={(value) => setTranscriptDensity(normalizeTranscriptDensity(value))}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSCRIPT_DENSITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Collapsed bash summaries</div>
              <div className="text-muted text-xs">
                Choose whether collapsed bash tools show the raw command, the model&apos;s intent,
                or both.
              </div>
            </div>
            <Select
              value={bashCollapsedSummaryMode}
              onValueChange={(value) =>
                setBashCollapsedSummaryMode(value as BashCollapsedSummaryMode)
              }
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASH_COLLAPSED_SUMMARY_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Compaction</h3>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-sm">Compaction strategy</div>
            <div className="text-muted text-xs">How to manage context as conversations grow.</div>
          </div>
          <Select
            value={compactionStrategy}
            onValueChange={handleCompactionStrategyChange}
            open={compactionOpen}
            onOpenChange={(open) => {
              setCompactionOpen(open);
              const activated = sameStrategyActivation.current;
              sameStrategyActivation.current = null;
              if (!open && activated) handleCompactionStrategyChange(activated);
            }}
          >
            <SelectTrigger
              aria-label="Compaction strategy"
              aria-describedby={tokenBudgetInactive ? "token-budget-inactive" : undefined}
              className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto shrink-0 cursor-pointer rounded-md border px-3 text-sm transition-colors"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPACTION_STRATEGIES.map((strategy) => (
                <SelectItem
                  key={strategy.value}
                  value={strategy.value}
                  onPointerUp={() => markCompactionActivation(strategy.value)}
                  onClick={() => markCompactionActivation(strategy.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      markCompactionActivation(strategy.value);
                    }
                  }}
                >
                  {strategy.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {tokenBudgetInactive && (
          <div id="token-budget-inactive" role="status" className="text-warning mt-2 text-xs">
            Token Budget is saved but inactive while Programmatic Tool Calling and RLM Mode are both
            enabled. Disable either in Experiments to use it.
          </div>
        )}
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Terminal</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font</div>
              {terminalFontWarning ? (
                <div className="text-warning text-xs">{terminalFontWarning}</div>
              ) : null}
              <div className="text-muted text-xs">Set this to a monospace font you like.</div>
              <div className="text-muted text-xs">
                Preview:{" "}
                <span className="text-foreground" style={{ fontFamily: terminalFontPreviewFamily }}>
                  {terminalFontPreviewText}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Input
                value={terminalFontConfig.fontFamily}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleTerminalFontFamilyChange(e.target.value)
                }
                placeholder={DEFAULT_TERMINAL_FONT_CONFIG.fontFamily}
                className="border-border-medium bg-background-secondary h-9 w-80"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font Size</div>
              <div className="text-muted text-xs">Font size for the integrated terminal</div>
            </div>
            <Input
              type="number"
              value={terminalFontConfig.fontSize}
              min={6}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalFontSizeChange(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Badge</div>
              <div className="text-muted text-xs">
                Show a scroll-fixed workspace/tab watermark over the terminal
              </div>
            </div>
            <Switch
              checked={terminalBadgeConfig.enabled}
              onCheckedChange={handleTerminalBadgeEnabledChange}
              aria-label="Toggle Terminal Badge"
            />
          </div>

          {terminalBadgeConfig.enabled && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Terminal Badge Template</div>
                  <div className="text-muted text-xs">
                    Tokens: {"{workspace}"}, {"{tab}"}, {"{project}"}, {"{index}"}
                  </div>
                  <div className="text-muted text-xs">
                    {"{tab}"} follows the tab label (shell titles); {"{index}"} is the stable tab
                    number
                  </div>
                </div>
                <Input
                  value={terminalBadgeConfig.template}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTerminalBadgeTemplateChange(e.target.value)
                  }
                  placeholder={DEFAULT_TERMINAL_BADGE_CONFIG.template}
                  aria-label="Terminal Badge Template"
                  className="border-border-medium bg-background-secondary h-9 w-80 max-w-full"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Terminal Badge Position</div>
                  <div className="text-muted text-xs">
                    Corner of the terminal to pin the badge to
                  </div>
                </div>
                <Select
                  value={terminalBadgeConfig.position}
                  onValueChange={(value) =>
                    handleTerminalBadgePositionChange(value as TerminalBadgePosition)
                  }
                >
                  <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TERMINAL_BADGE_POSITION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Terminal Badge Opacity</div>
                  <div className="text-muted text-xs">Percent (1-100)</div>
                </div>
                <Input
                  type="number"
                  value={Math.round(terminalBadgeConfig.opacity * 100)}
                  min={1}
                  max={100}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTerminalBadgeOpacityChange(e.target.value)
                  }
                  aria-label="Terminal Badge Opacity"
                  className="border-border-medium bg-background-secondary h-9 w-28"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Terminal Badge Font Size</div>
                  <div className="text-muted text-xs">Font size for the badge text</div>
                </div>
                <Input
                  type="number"
                  value={terminalBadgeConfig.fontSize}
                  min={6}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTerminalBadgeFontSizeChange(e.target.value)
                  }
                  aria-label="Terminal Badge Font Size"
                  className="border-border-medium bg-background-secondary h-9 w-28"
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Archiving</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Coder workspace on archive</div>
              <div className="text-muted text-xs">
                Action to take on dedicated Coder workspaces when archiving a chat. Delete is
                permanent.
              </div>
            </div>
            <Select
              value={archiveBehavior}
              onValueChange={(value) =>
                handleArchiveBehaviorChange(value as CoderWorkspaceArchiveBehavior)
              }
              disabled={!api?.config?.updateCoderPrefs || !archiveSettingsLoaded}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Worktree archive behavior</div>
              <div className="text-muted text-xs">
                Control whether archived xum-managed worktrees stay on disk, are deleted, or are
                snapshotted so they can be restored on unarchive.
              </div>
            </div>
            <Select
              value={worktreeArchiveBehavior}
              onValueChange={(value) =>
                handleWorktreeArchiveBehaviorChange(value as WorktreeArchiveBehavior)
              }
              disabled={!api?.config?.updateCoderPrefs || !archiveSettingsLoaded}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Editor & debugging</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Editor</div>
              <div className="text-muted text-xs">Editor to open files in</div>
            </div>
            <Select value={editorConfig.editor} onValueChange={handleEditorChange}>
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {editorConfig.editor === "custom" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-foreground text-sm">Custom Command</div>
                  <div className="text-muted text-xs">Command to run (path will be appended)</div>
                </div>
                <Input
                  value={editorConfig.customCommand ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleCustomCommandChange(e.target.value)
                  }
                  placeholder="e.g., nvim"
                  className="border-border-medium bg-background-secondary h-9 w-40"
                />
              </div>
              {isBrowserMode && (
                <div className="text-warning text-xs">
                  Custom editors are not supported in browser mode. Use VS Code or Cursor instead.
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">API Debug Logs</div>
              <div className="text-muted mt-0.5 text-xs">
                Record the full input and output of every AI API call
              </div>
            </div>
            <Switch
              checked={llmDebugLogs}
              onCheckedChange={handleLlmDebugLogsChange}
              aria-label="Toggle API Debug Logs"
            />
          </div>

          {isBrowserMode && sshHostLoaded && (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-foreground text-sm">SSH Host</div>
                <div className="text-muted text-xs">
                  SSH hostname for &apos;Open in Editor&apos; deep links
                </div>
              </div>
              <Input
                value={sshHost}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleSshHostChange(e.target.value)
                }
                placeholder={window.location.hostname}
                className="border-border-medium bg-background-secondary h-9 w-40"
              />
            </div>
          )}
        </div>
      </div>

      <div className="border-border-light border-t pt-6">
        <h3 className="text-foreground mb-4 text-sm font-medium">Projects</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Default project directory</div>
              <div className="text-muted text-xs">
                Parent folder for new projects and cloned repositories
              </div>
            </div>
            <Input
              value={defaultProjectDir}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setDefaultProjectDir(e.target.value)
              }
              onBlur={handleCloneDirBlur}
              placeholder="~/.xum/projects"
              disabled={!cloneDirLoaded}
              className="border-border-medium bg-background-secondary h-9 w-80"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
