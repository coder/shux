/**
 * LocalStorage Key Constants and Helpers
 * These keys are used for persisting state in localStorage
 */

/**
 * Scope ID Helpers
 * These create consistent scope identifiers for storage keys
 */

/**
 * Get project-scoped ID for storage keys (e.g., model preference before workspace creation)
 * Format: "__project__/{projectPath}"
 * Uses "/" delimiter to safely handle projectPath values containing special characters
 */
export function getProjectScopeId(projectPath: string): string {
  return `__project__/${projectPath}`;
}

/**
 * Get pending workspace scope ID for storage keys (e.g., input text during workspace creation)
 * Format: "__pending__{projectPath}"
 */
export function getPendingScopeId(projectPath: string): string {
  return `__pending__${projectPath}`;
}

/**
 * Get draft workspace scope ID for storage keys.
 *
 * This is used for UI-only workspace creation drafts so multiple pending drafts can
 * exist per project without colliding.
 *
 * Format: "__draft__/{projectPath}/{draftId}"
 */
export function getDraftScopeId(projectPath: string, draftId: string): string {
  return `__draft__/${projectPath}/${draftId}`;
}

/**
 * Global scope ID for workspace-independent preferences
 */
export const GLOBAL_SCOPE_ID = "__global__";

/**
 * Get the localStorage key for the UI theme preference (global)
 * Format: "uiTheme"
 */
export const UI_THEME_KEY = "uiTheme";

/**
 * LocalStorage key for the hidden Power Mode UI easter egg (global).
 */
export const POWER_MODE_ENABLED_KEY = "powerModeEnabled";

/**
 * Get the localStorage key for the last selected provider when adding custom models (global)
 * Format: "lastCustomModelProvider"
 */
export const LAST_CUSTOM_MODEL_PROVIDER_KEY = "lastCustomModelProvider";

/**
 * Get the localStorage key for the currently selected workspace (global)
 * Format: "selectedWorkspace"
 */
export const SELECTED_WORKSPACE_KEY = "selectedWorkspace";

/**
 * Get the localStorage key for the last visited app route (global).
 *
 * Desktop reloads and restarts boot from file:///index.html, so we persist the
 * in-app route separately to restore the page the user was already on.
 */
export const LAST_VISITED_ROUTE_KEY = "lastVisitedRoute";

/**
 * User preference for what to show on app launch (global).
 * Values: "dashboard" (legacy storage value that now opens the recent project page)
 * | "new-chat" | "last-workspace"
 */
export const LAUNCH_BEHAVIOR_KEY = "launchBehavior";

export type LaunchBehavior = "dashboard" | "new-chat" | "last-workspace";

/**
 * Synchronous mirror for the backend full-width transcript preference.
 */
export const CHAT_TRANSCRIPT_FULL_WIDTH_KEY = "chatTranscriptFullWidth";

/**
 * Ordered project paths in the left sidebar.
 * Format: "mux:projectOrder"
 */
export const PROJECT_ORDER_KEY = "mux:projectOrder";

/**
 * Get the localStorage key for expanded projects in sidebar (global)
 * Format: "expandedProjects"
 */
export const EXPANDED_PROJECTS_KEY = "expandedProjects";

/**
 * LocalStorage key for UI-only workspace creation drafts.
 *
 * Value: Record<string, Array<{ draftId: string; subProjectPath: string | null; createdAt: number }>>
 * Keyed by projectPath.
 */
export const WORKSPACE_DRAFTS_BY_PROJECT_KEY = "workspaceDraftsByProject";

/**
 * LocalStorage keys for Xum Gateway routing preferences (global).
 *
 * Note: localStorage is origin-scoped (includes port), so these values are also
 * mirrored into ~/.xum/config.json for portability across server ports.
 */
export const GATEWAY_MODELS_KEY = "gateway-models"; // enabled model IDs (canonical)
export const GATEWAY_ENABLED_KEY = "gateway-enabled"; // global on/off toggle

/**
 * Storage key for runtime enablement settings (shared via ~/.xum/config.json).
 */
export const RUNTIME_ENABLEMENT_KEY = "runtimeEnablement";

/**
 * Storage key for global default runtime selection (shared via ~/.xum/config.json).
 */
export const DEFAULT_RUNTIME_KEY = "defaultRuntime";

/**
 * Get the localStorage key for cached MCP server test results (per project)
 * Format: "mcpTestResults:{projectPath}"
 * Stores: Record<serverName, CachedMCPTestResult>
 */
export function getMCPTestResultsKey(projectPath: string, workspaceId?: string): string {
  // Workspace-scoped results (agent-plugins experiment): plugin tool lists
  // follow each workspace's checkout, so they must not be shared per-project.
  return workspaceId
    ? `mcpTestResults:${projectPath}:${workspaceId}`
    : `mcpTestResults:${projectPath}`;
}

/**
 * Get the localStorage key for cached archived workspaces per project
 * Format: "archivedWorkspaces:{projectPath}"
 * Stores: Array of workspace metadata objects (optimistic cache)
 */
export function getArchivedWorkspacesKey(projectPath: string): string {
  return `archivedWorkspaces:${projectPath}`;
}

/**
 * Get the localStorage key for archived workspaces expand/collapse state.
 * Format: "archivedWorkspacesExpanded:{projectPath}"
 * Stores: boolean (true = expanded)
 */
export function getArchivedWorkspacesExpandedKey(projectPath: string): string {
  return `archivedWorkspacesExpanded:${projectPath}`;
}

/**
 * Get the localStorage key for cached MCP servers per project
 * Format: "mcpServers:{projectPath}"
 * Stores: Record<serverName, MCPServerInfo> (optimistic cache)
 */
export function getMCPServersKey(projectPath: string): string {
  return `mcpServers:${projectPath}`;
}

/**
 * Get the localStorage key for the last selected Browser-tab session for a project.
 * Format: "browserSelectedSession:{projectPath}"
 */
export function getBrowserSelectedSessionKey(projectPath: string): string {
  return `browserSelectedSession:${projectPath}`;
}

/**
 * Get the localStorage key for thinking level preference per scope (workspace/project).
 * Format: "thinkingLevel:{scopeId}"
 */
export function getThinkingLevelKey(scopeId: string): string {
  return `thinkingLevel:${scopeId}`;
}

/**
 * Get the localStorage key for the OpenAI pro reasoning-mode toggle per scope
 * (workspace/project). Format: "reasoningMode:{scopeId}"
 */
export function getReasoningModeKey(scopeId: string): string {
  return `reasoningMode:${scopeId}`;
}

/**
 * Get the localStorage key for per-agent workspace AI overrides cache.
 * Format: "workspaceAiSettingsByAgent:{workspaceId}"
 */
export function getWorkspaceAISettingsByAgentKey(workspaceId: string): string {
  return `workspaceAiSettingsByAgent:${workspaceId}`;
}

/**
 * LEGACY: Get the localStorage key for thinking level preference per model (global).
 * Format: "thinkingLevel:model:{modelName}"
 *
 * Kept for one-time migration to per-workspace thinking.
 */
export function getThinkingLevelByModelKey(modelName: string): string {
  return `thinkingLevel:model:${modelName}`;
}

/**
 * Get the localStorage key for the user's preferred model for a workspace
 */
export function getModelKey(workspaceId: string): string {
  return `model:${workspaceId}`;
}

/**
 * Get the localStorage key for the input text for a workspace
 */
export function getInputKey(workspaceId: string): string {
  return `input:${workspaceId}`;
}

/**
 * Get the localStorage key for the pinned TODO panel expansion state.
 * Format: "pinnedTodoExpanded:{workspaceId}"
 */
export function getPinnedTodoExpandedKey(workspaceId: string): string {
  return `pinnedTodoExpanded:${workspaceId}`;
}

/**
 * Get the localStorage key for the sub-agent chat decoration expansion state.
 * Format: "subAgentTasksExpanded:{workspaceId}"
 */
export function getSubAgentTasksExpandedKey(workspaceId: string): string {
  return `subAgentTasksExpanded:${workspaceId}`;
}

/**
 * Get the localStorage key for per-workspace transcript auto-expand preferences.
 *
 * Stores the user's last expand/collapse intent, shaped like
 * { thinking?: boolean; tools?: Record<toolName, boolean> } (see AutoExpandPrefs in
 * useStickyExpand.ts). Thinking blocks share one preference; tool blocks are keyed
 * by tool name so each tool remembers its own intent. New thinking/tool blocks
 * inherit this as their initial expand state; already-mounted blocks are never
 * retroactively changed.
 *
 * Format: "auto-expand:{workspaceId}"
 */
export function getAutoExpandPrefsKey(workspaceId: string): string {
  return `auto-expand:${workspaceId}`;
}

/**
 * Get the localStorage key for persisted workspace name-generation state.
 *
 * This is used by the workspace creation flow so drafts can preserve their
 * auto-generated (or manually edited) workspace name independently.
 *
 * Format: "workspaceNameState:{scopeId}"
 */
export function getWorkspaceNameStateKey(scopeId: string): string {
  return `workspaceNameState:${scopeId}`;
}

/**
 * Get the localStorage key for the input attachments for a scope.
 * Format: "inputAttachments:{scopeId}"
 *
 * Note: The input key functions accept any string scope ID. For normal workspaces
 * this is the workspaceId; for creation mode it's a pending scope ID.
 */
export function getInputAttachmentsKey(scopeId: string): string {
  return `inputAttachments:${scopeId}`;
}

/**
 * Get the localStorage key for pending initial send errors after workspace creation.
 * Stored so the workspace view can surface a toast after navigation.
 * Format: "pendingSendError:{workspaceId}"
 */
export function getPendingWorkspaceSendErrorKey(workspaceId: string): string {
  return `pendingSendError:${workspaceId}`;
}

/**
 * Get the localStorage key marking that a creation draft transferred into this
 * workspace was sent with forced project-path skill discovery. The retry from
 * the workspace composer reads it so the slash skill resolves against the same
 * source as the original send. Cleared after the next successful send.
 * Format: "pendingDraftProjectSkillDiscovery:{workspaceId}"
 */
export function getPendingDraftSkillDiscoveryKey(workspaceId: string): string {
  return `pendingDraftProjectSkillDiscovery:${workspaceId}`;
}

/**
 * LEGACY: Get the localStorage key for pre-backend auto-retry preference.
 *
 * Kept only for one-way migration during onChat subscription.
 */
export function getAutoRetryKey(workspaceId: string): string {
  return `${workspaceId}-autoRetry`;
}

/**
 * Get the localStorage key for the selected agent definition id for a scope.
 * Format: "agentId:{scopeId}"
 */
export function getAgentIdKey(scopeId: string): string {
  return `agentId:${scopeId}`;
}

/**
 * Get the localStorage key for the pinned third agent id for a scope.
 * Format: "pinnedAgentId:{scopeId}"
 */
export function getPinnedAgentIdKey(scopeId: string): string {
  return `pinnedAgentId:${scopeId}`;
}
/**
 * Get the localStorage key for "disable workspace agents" toggle per scope.
 * When true, workspace-specific agents are disabled - only built-in and global agents are loaded.
 * Useful for "unbricking" when iterating on agent files in a workspace worktree.
 * Format: "disableWorkspaceAgents:{scopeId}"
 */
export function getDisableWorkspaceAgentsKey(scopeId: string): string {
  return `disableWorkspaceAgents:${scopeId}`;
}
/**
 * Get the localStorage key for the default runtime for a project
 * Defaults to worktree if not set; can only be changed via the "Default for project" checkbox.
 * Format: "runtime:{projectPath}"
 */
export function getRuntimeKey(projectPath: string): string {
  return `runtime:${projectPath}`;
}

/**
 * Get the localStorage key for trunk branch preference for a project
 * Stores the last used trunk branch when creating a workspace
 * Format: "trunkBranch:{projectPath}"
 */
export function getTrunkBranchKey(projectPath: string): string {
  return `trunkBranch:${projectPath}`;
}

/**
 * Get the localStorage key for whether to show the "Initialize with AGENTS.md" nudge for a project.
 * Set to true when a project is first added; cleared when user dismisses or runs /init.
 * Format: "agentsInitNudge:{projectPath}"
 */
export function getAgentsInitNudgeKey(projectPath: string): string {
  return `agentsInitNudge:${projectPath}`;
}

/**
 * Get the localStorage key for the last runtime config used per provider for a project.
 *
 * Value shape is a provider-keyed object (e.g. { ssh: { host }, docker: { image } }) so we can
 * add new options without adding more storage keys.
 *
 * Format: "lastRuntimeConfig:{projectPath}"
 */
export function getLastRuntimeConfigKey(projectPath: string): string {
  return `lastRuntimeConfig:${projectPath}`;
}

/**
 * Get the localStorage key for the default model (global).
 *
 * Note: This is used as a fallback when creating new workspaces.
 * Format: "model-default"
 */
export const DEFAULT_MODEL_KEY = "model-default";

/**
 * Get the localStorage key for the hidden models list (global).
 * Format: "hidden-models"
 */
export const HIDDEN_MODELS_KEY = "hidden-models";

/**
 * Get the localStorage key for cached per-agent AI defaults (global).
 * Format: "agentAiDefaults"
 */
export const AGENT_AI_DEFAULTS_KEY = "agentAiDefaults";

/**
 * Provider-specific AI options, synced through userPreferences.
 */
export const PROVIDER_OPTIONS_ANTHROPIC_KEY = "provider_options_anthropic";
export const PROVIDER_OPTIONS_GOOGLE_KEY = "provider_options_google";

/**
 * Get the localStorage key for vim mode preference (global)
 * Format: "vimEnabled"
 */
export const VIM_ENABLED_KEY = "vimEnabled";

/**
 * Git status indicator display mode (global)
 * Stores: "line-delta" | "divergence"
 */

export const GIT_STATUS_INDICATOR_MODE_KEY = "gitStatusIndicatorMode";

/**
 * Editor configuration for "Open in Editor" feature (global)
 * Format: "editorConfig"
 */
export const EDITOR_CONFIG_KEY = "editorConfig";

export type EditorType = "vscode" | "cursor" | "zed" | "custom";

export interface EditorConfig {
  editor: EditorType;
  customCommand?: string; // Only when editor='custom'
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  editor: "vscode",
};

export const EDITOR_TYPES = ["vscode", "cursor", "zed", "custom"] as const;

export function isEditorType(value: unknown): value is EditorType {
  return typeof value === "string" && EDITOR_TYPES.includes(value as EditorType);
}

export function normalizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_EDITOR_CONFIG;
  }

  const record = value as { editor?: unknown; customCommand?: unknown };
  const editor = isEditorType(record.editor) ? record.editor : DEFAULT_EDITOR_CONFIG.editor;
  const customCommand =
    typeof record.customCommand === "string" && record.customCommand.trim()
      ? record.customCommand
      : undefined;

  return { editor, customCommand };
}

/**
 * Transcript density display preference (global)
 * Stores: "normal" | "hyper"
 */
export const TRANSCRIPT_DENSITY_KEY = "transcriptDensity";

export const TRANSCRIPT_DENSITIES = ["normal", "hyper"] as const;

export type TranscriptDensity = (typeof TRANSCRIPT_DENSITIES)[number];

export const DEFAULT_TRANSCRIPT_DENSITY: TranscriptDensity = "normal";

function isTranscriptDensity(value: unknown): value is TranscriptDensity {
  return typeof value === "string" && TRANSCRIPT_DENSITIES.includes(value as TranscriptDensity);
}

export function normalizeTranscriptDensity(value: unknown): TranscriptDensity {
  return isTranscriptDensity(value) ? value : DEFAULT_TRANSCRIPT_DENSITY;
}

/**
 * Collapsed bash tool summary display mode (global)
 * Stores: "command" | "intent-command" | "intent"
 */
export const BASH_COLLAPSED_SUMMARY_MODE_KEY = "bashCollapsedSummaryMode";

export const BASH_COLLAPSED_SUMMARY_MODES = ["command", "intent-command", "intent"] as const;

export type BashCollapsedSummaryMode = (typeof BASH_COLLAPSED_SUMMARY_MODES)[number];

export const DEFAULT_BASH_COLLAPSED_SUMMARY_MODE: BashCollapsedSummaryMode = "intent-command";

export function isBashCollapsedSummaryMode(value: unknown): value is BashCollapsedSummaryMode {
  return (
    typeof value === "string" &&
    BASH_COLLAPSED_SUMMARY_MODES.includes(value as BashCollapsedSummaryMode)
  );
}

export function normalizeBashCollapsedSummaryMode(value: unknown): BashCollapsedSummaryMode {
  return isBashCollapsedSummaryMode(value) ? value : DEFAULT_BASH_COLLAPSED_SUMMARY_MODE;
}

/**
 * Integrated terminal font configuration (global)
 * Stores: { fontFamily: string; fontSize: number }
 */
export const TERMINAL_FONT_CONFIG_KEY = "terminalFontConfig";

export interface TerminalFontConfig {
  fontFamily: string;
  fontSize: number;
}

export const DEFAULT_TERMINAL_FONT_CONFIG: TerminalFontConfig = {
  fontFamily: "Geist Mono, ui-monospace, monospace",
  fontSize: 13,
};

export function normalizeTerminalFontConfig(value: unknown): TerminalFontConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TERMINAL_FONT_CONFIG;
  }

  const record = value as { fontFamily?: unknown; fontSize?: unknown };
  const fontFamily =
    typeof record.fontFamily === "string" && record.fontFamily.trim()
      ? record.fontFamily
      : DEFAULT_TERMINAL_FONT_CONFIG.fontFamily;
  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_FONT_CONFIG.fontSize;

  return { fontFamily, fontSize };
}

/**
 * Terminal badge overlay configuration (global)
 * Scroll-fixed workspace/tab watermark rendered above the terminal canvas,
 * similar to iTerm2 badges. Stores: { enabled, template, position, opacity, fontSize }
 */
export const TERMINAL_BADGE_CONFIG_KEY = "terminalBadgeConfig";

export const TERMINAL_BADGE_POSITIONS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type TerminalBadgePosition = (typeof TERMINAL_BADGE_POSITIONS)[number];

export interface TerminalBadgeConfig {
  enabled: boolean;
  /** Supports {workspace}, {tab}, and {project} tokens. */
  template: string;
  position: TerminalBadgePosition;
  /** 0-1 */
  opacity: number;
  fontSize: number;
}

export const DEFAULT_TERMINAL_BADGE_CONFIG: TerminalBadgeConfig = {
  enabled: false,
  template: "{workspace} · {tab}",
  position: "top-right",
  opacity: 0.4,
  fontSize: 16,
};

function isTerminalBadgePosition(value: unknown): value is TerminalBadgePosition {
  return (
    typeof value === "string" && TERMINAL_BADGE_POSITIONS.includes(value as TerminalBadgePosition)
  );
}

export function normalizeTerminalBadgeConfig(value: unknown): TerminalBadgeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TERMINAL_BADGE_CONFIG;
  }

  const record = value as {
    enabled?: unknown;
    template?: unknown;
    position?: unknown;
    opacity?: unknown;
    fontSize?: unknown;
  };
  const enabled = record.enabled === true;
  const template =
    typeof record.template === "string" ? record.template : DEFAULT_TERMINAL_BADGE_CONFIG.template;
  const position = isTerminalBadgePosition(record.position)
    ? record.position
    : DEFAULT_TERMINAL_BADGE_CONFIG.position;
  const opacityNumber = Number(record.opacity);
  const opacity =
    Number.isFinite(opacityNumber) && opacityNumber > 0 && opacityNumber <= 1
      ? opacityNumber
      : DEFAULT_TERMINAL_BADGE_CONFIG.opacity;
  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_BADGE_CONFIG.fontSize;

  return { enabled, template, position, opacity, fontSize };
}

/**
 * Tutorial state storage key (global)
 * Stores: { disabled: boolean, completed: { creation?: true, workspace?: true, review?: true } }
 */
export const TUTORIAL_STATE_KEY = "tutorialState";

export type TutorialSequence = "creation" | "workspace" | "review";

export interface TutorialState {
  disabled: boolean;
  completed: Partial<Record<TutorialSequence, true>>;
}

export const DEFAULT_TUTORIAL_STATE: TutorialState = {
  disabled: false,
  completed: {},
};

/**
 * Get the localStorage key for review (hunk read) state per workspace
 * Stores which hunks have been marked as read during code review
 * Format: "review-state:{workspaceId}"
 */
export function getReviewStateKey(workspaceId: string): string {
  return `review-state:${workspaceId}`;
}

/**
 * Get the localStorage key for selected review hunk per workspace.
 * Format: "review-selected-hunk:{workspaceId}"
 */
export function getReviewSelectedHunkKey(workspaceId: string): string {
  return `review-selected-hunk:${workspaceId}`;
}

/**
 * Get the localStorage key for hunk first-seen timestamps per workspace
 * Tracks when each hunk content address was first observed (for LIFO sorting)
 * Format: "hunkFirstSeen:{workspaceId}"
 */
export function getHunkFirstSeenKey(workspaceId: string): string {
  return `hunkFirstSeen:${workspaceId}`;
}

/**
 * Project-scoped default diff base for code review.
 * Format: "review-default-base:{projectPath}"
 */
export function getReviewDefaultBaseKey(projectPath: string): string {
  return `review-default-base:${projectPath}`;
}

/**
 * Global code review behavior for including uncommitted changes.
 * Format: "review-include-uncommitted"
 */
export const REVIEW_INCLUDE_UNCOMMITTED_KEY = "review-include-uncommitted";

/**
 * Get the localStorage key for review sort order preference (global)
 * Format: "review-sort-order"
 */
export const REVIEW_SORT_ORDER_KEY = "review-sort-order";

/**
 * Get the localStorage key for hunk expand/collapse state in Review tab
 * Stores user's manual expand/collapse preferences per hunk
 * Format: "reviewExpandState:{workspaceId}"
 */
export function getReviewExpandStateKey(workspaceId: string): string {
  return `reviewExpandState:${workspaceId}`;
}

/**
 * Get the localStorage key for read-more expansion state per hunk.
 * Tracks how many lines are expanded up/down for each hunk.
 * Format: "reviewReadMore:{workspaceId}"
 */
export function getReviewReadMoreKey(workspaceId: string): string {
  return `reviewReadMore:${workspaceId}`;
}

/**
 * Get the localStorage key for FileTree expand/collapse state in Review tab
 * Stores directory expand/collapse preferences per workspace
 * Format: "fileTreeExpandState:{workspaceId}"
 */
export function getFileTreeExpandStateKey(workspaceId: string): string {
  return `fileTreeExpandState:${workspaceId}`;
}

/**
 * LocalStorage key for file tree view mode in the Review tab (global).
 * Format: "reviewFileTreeViewMode"
 */
export const REVIEW_FILE_TREE_VIEW_MODE_KEY = "reviewFileTreeViewMode";

/**
 * Get the localStorage key for persisted legacy agent status for a workspace.
 * Stores the most recent successful status_set payload (emoji, message, url)
 * so historical status rows and older sessions can still be reconstructed.
 * Format: "statusState:{workspaceId}"
 */

/**
 * Get the localStorage key for "notify on response" toggle per workspace.
 * When true, a browser notification is shown when assistant responses complete.
 * Format: "notifyOnResponse:{workspaceId}"
 */
export function getNotifyOnResponseKey(workspaceId: string): string {
  return `notifyOnResponse:${workspaceId}`;
}

/**
 * Get the localStorage key for "auto-enable notifications" toggle per project.
 * When true, new workspaces in this project automatically have notifications enabled.
 * Format: "notifyOnResponseAutoEnable:{projectPath}"
 */
export function getNotifyOnResponseAutoEnableKey(projectPath: string): string {
  return `notifyOnResponseAutoEnable:${projectPath}`;
}

export function getStatusStateKey(workspaceId: string): string {
  return `statusState:${workspaceId}`;
}

/**
 * Get the localStorage key for last-read timestamps per workspace.
 * Format: "workspaceLastRead:{workspaceId}"
 */
export function getWorkspaceLastReadKey(workspaceId: string): string {
  return `workspaceLastRead:${workspaceId}`;
}

/**
 * Left sidebar collapsed state (global, manual toggle)
 * Format: "sidebarCollapsed"
 */
export const LEFT_SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

/**
 * Whether the sidebar groups older workspaces under collapsible
 * "Older than X days" age tiers (boolean, default true).
 * When false, all workspaces render as one flat recency-sorted list.
 * Format: "sidebarAgeGrouping"
 */
export const SIDEBAR_AGE_GROUPING_KEY = "sidebarAgeGrouping";

/**
 * When true, show all sidebar chats in one list instead of project folders.
 * Format: "sidebarFlatMode" (boolean, default false)
 */
export const SIDEBAR_FLAT_MODE_KEY = "sidebarFlatMode";

/**
 * Hide sub-agent rows in the left sidebar and summarize their activity on
 * parent rows instead.
 * Format: "sidebarHideSubAgents" (boolean, default false)
 */
export const SIDEBAR_HIDE_SUBAGENTS_KEY = "sidebarHideSubAgents";

/**
 * Left sidebar width
 * Format: "left-sidebar:width"
 */
export const LEFT_SIDEBAR_WIDTH_KEY = "left-sidebar:width";

/**
 * Mobile left sidebar scroll position.
 *
 * The mobile sidebar content unmounts when collapsed, so we persist scrollTop
 * to restore the previous browse position when the menu is reopened.
 * Format: "mobile-left-sidebar:scroll-top"
 */
export const MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY = "mobile-left-sidebar:scroll-top";

/**
 * Right sidebar tab selection (global)
 * Format: "right-sidebar-tab"
 */
export const RIGHT_SIDEBAR_TAB_KEY = "right-sidebar-tab";

/**
 * Right sidebar collapsed state (global, manual toggle)
 * Format: "right-sidebar:collapsed"
 */
export const RIGHT_SIDEBAR_COLLAPSED_KEY = "right-sidebar:collapsed";

/**
 * Right sidebar width (unified across all tabs)
 * Format: "right-sidebar:width"
 */
export const RIGHT_SIDEBAR_WIDTH_KEY = "right-sidebar:width";

/**
 * Get the localStorage key for right sidebar dock-lite layout per workspace.
 * Each workspace can have its own split/tab configuration (e.g., different
 * numbers of terminals). Width and collapsed state remain global.
 * Format: "right-sidebar:layout:{workspaceId}"
 */
export function getRightSidebarLayoutKey(workspaceId: string): string {
  return `right-sidebar:layout:${workspaceId}`;
}

/**
 * Get the localStorage key for terminal titles per workspace.
 * Maps sessionId -> title for persisting OSC-set terminal titles.
 * Format: "right-sidebar:terminal-titles:{workspaceId}"
 */
export function getTerminalTitlesKey(workspaceId: string): string {
  return `right-sidebar:terminal-titles:${workspaceId}`;
}

/**
 * Get the localStorage key for unified Review search state per workspace
 * Stores: { input: string, useRegex: boolean, matchCase: boolean }
 * Format: "reviewSearchState:{workspaceId}"
 */
export function getReviewSearchStateKey(workspaceId: string): string {
  return `reviewSearchState:${workspaceId}`;
}

/**
 * Get the localStorage key for reviews per workspace
 * Stores: ReviewsState (reviews created from diff viewer - pending, attached, or checked)
 * Format: "reviews:{workspaceId}"
 */
export function getReviewsKey(workspaceId: string): string {
  return `reviews:${workspaceId}`;
}

/**
 * Get the localStorage key for immersive review mode state per workspace
 * Tracks whether immersive mode is active
 * Format: "review-immersive:{workspaceId}"
 */
export function getReviewImmersiveKey(workspaceId: string): string {
  return `review-immersive:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction enabled preference per workspace
 * Format: "autoCompaction:enabled:{workspaceId}"
 */
export function getAutoCompactionEnabledKey(workspaceId: string): string {
  return `autoCompaction:enabled:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction threshold percentage per model
 * Format: "autoCompaction:threshold:{model}"
 * Stored per-model because different models have different context windows
 */
export function getAutoCompactionThresholdKey(model: string): string {
  return `autoCompaction:threshold:${model}`;
}

/**
 * List of workspace-scoped key functions that should be copied on fork and deleted on removal
 */
const PERSISTENT_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getWorkspaceAISettingsByAgentKey,
  getModelKey,
  getInputKey,
  getAutoExpandPrefsKey,
  getWorkspaceNameStateKey,
  getInputAttachmentsKey,
  getAgentIdKey,
  getPinnedAgentIdKey,
  getThinkingLevelKey,
  getReviewSelectedHunkKey,
  getReviewStateKey,
  getHunkFirstSeenKey,
  getReviewExpandStateKey,
  getReviewReadMoreKey,
  getFileTreeExpandStateKey,
  getReviewSearchStateKey,
  getReviewsKey,
  getReviewImmersiveKey,
  getAutoCompactionEnabledKey,
  getWorkspaceLastReadKey,
  getStatusStateKey,
  // Note: auto-compaction threshold is per-model, not per-workspace
];

/**
 * Get the localStorage key for cached plan content for a workspace
 * Stores: { content: string; path: string } - used for optimistic rendering
 * Format: "planContent:{workspaceId}"
 */
export function getPlanContentKey(workspaceId: string): string {
  return `planContent:${workspaceId}`;
}

/**
 * Get the localStorage key for cached post-compaction state for a workspace
 * Stores: { planPath: string | null; trackedFilePaths: string[]; excludedItems: string[] }
 * Format: "postCompactionState:{workspaceId}"
 */
export function getPostCompactionStateKey(workspaceId: string): string {
  return `postCompactionState:${workspaceId}`;
}

/**
 * Additional ephemeral keys to delete on workspace removal (not copied on fork)
 */
const EPHEMERAL_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getPendingWorkspaceSendErrorKey,
  getPendingDraftSkillDiscoveryKey,
  getNotifyOnResponseKey,
  getPlanContentKey, // Cache only, no need to preserve on fork
  getPostCompactionStateKey, // Cache only, no need to preserve on fork
];

function isStagedPersistedAttachment(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "staged"
  );
}

function stripStagedDraftAttachments(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return value;
    }
    // Forked worktrees do not share staged draft files. Keep provider attachments, but drop
    // workspace-local staged file chips so the fork cannot point at missing source-worktree paths.
    return JSON.stringify(parsed.filter((attachment) => !isStagedPersistedAttachment(attachment)));
  } catch {
    return value;
  }
}

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace.
 * Includes keys listed in PERSISTENT_WORKSPACE_KEY_FUNCTIONS (model, draft input text/attachments, etc).
 */
export function copyWorkspaceStorage(sourceWorkspaceId: string, destWorkspaceId: string): void {
  for (const getKey of PERSISTENT_WORKSPACE_KEY_FUNCTIONS) {
    const sourceKey = getKey(sourceWorkspaceId);
    const destKey = getKey(destWorkspaceId);
    const value = localStorage.getItem(sourceKey);
    if (value !== null) {
      localStorage.setItem(
        destKey,
        getKey === getInputAttachmentsKey ? stripStagedDraftAttachments(value) : value
      );
    }
  }
}

/**
 * Delete all workspace-specific localStorage keys for a workspace
 * Should be called when a workspace is deleted to prevent orphaned data
 */
export function deleteWorkspaceStorage(workspaceId: string): void {
  const allKeyFunctions = [
    ...PERSISTENT_WORKSPACE_KEY_FUNCTIONS,
    ...EPHEMERAL_WORKSPACE_KEY_FUNCTIONS,
  ];

  for (const getKey of allKeyFunctions) {
    const key = getKey(workspaceId);
    localStorage.removeItem(key);
  }
}

/**
 * Migrate all workspace-specific localStorage keys from old to new workspace ID
 * Should be called when a workspace is renamed to preserve settings
 */
export function migrateWorkspaceStorage(oldWorkspaceId: string, newWorkspaceId: string): void {
  copyWorkspaceStorage(oldWorkspaceId, newWorkspaceId);
  deleteWorkspaceStorage(oldWorkspaceId);
}
