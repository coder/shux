import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useLocation } from "react-router-dom";
import type { FrontendWorkspaceMetadata, WorkspaceRemoveResult } from "@/common/types/workspace";
import type { ArchivePreflightResult, ArchiveWorkspaceResult } from "@/common/orpc/schemas/api";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar/ProjectSidebar";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { DeepLinkPayload } from "@/common/types/deepLink";
import {
  deleteWorkspaceStorage,
  getAgentIdKey,
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getWorkspaceNameStateKey,
  migrateWorkspaceStorage,
  DEFAULT_MODEL_KEY,
  GATEWAY_ENABLED_KEY,
  GATEWAY_MODELS_KEY,
  HIDDEN_MODELS_KEY,
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  type LaunchBehavior,
} from "@/common/constants/storage";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { useAPI } from "@/browser/contexts/API";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  readPersistedState,
  readPersistedString,
  subscribePersistedStateWrites,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isTerminalTab } from "@/browser/types/rightSidebar";
import {
  collectAllTabs,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
} from "@/browser/utils/rightSidebarLayout";
import { seedConfigMirrors } from "@/browser/utils/configMirrors";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { appendPinnedTimestamp, reassignPinnedTimestamps } from "@/common/utils/pin";
import { isAbortError } from "@/browser/utils/isAbortError";
import { findAdjacentWorkspaceId } from "@/browser/utils/ui/workspaceDomNav";
import { useRouter } from "@/browser/contexts/RouterContext";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { normalizeAgentId, resolvePersistedAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { APIClient } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";
import type { WorkspaceCreationScope } from "@/common/utils/subProjects";

/**
 * Preserve legacy local model choices across port/origin changes.
 * Exported for focused migration tests.
 */
export function migrateLocalModelPrefsToBackend(
  api: APIClient,
  cfg: Pick<
    Awaited<ReturnType<APIClient["config"]["getConfig"]>>,
    "defaultModel" | "hiddenModels" | "hiddenModelsInitialized"
  >,
  dirtyKeys: ReadonlySet<string> = new Set()
) {
  if (!api.config.updateModelPreferences) return cfg;

  const localDefaultModelRaw = readPersistedString(DEFAULT_MODEL_KEY);
  const localDefaultModel =
    typeof localDefaultModelRaw === "string"
      ? normalizeSelectedModel(localDefaultModelRaw).trim()
      : undefined;
  const localHiddenModels = readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null);

  const patch: {
    defaultModel?: string;
    hiddenModels?: string[];
  } = {};

  // localStorage presence implies explicit user choice (usePersistedState never
  // writes fallback defaults). Always migrate to backend so the preference
  // survives future changes to the built-in default constant.
  if (!dirtyKeys.has(DEFAULT_MODEL_KEY) && cfg.defaultModel === undefined && localDefaultModel) {
    patch.defaultModel = localDefaultModel;
  }

  if (
    !dirtyKeys.has(HIDDEN_MODELS_KEY) &&
    (cfg.hiddenModelsInitialized === false ||
      (cfg.hiddenModels === undefined &&
        Array.isArray(localHiddenModels) &&
        localHiddenModels.length > 0))
  ) {
    // Backend defaults are not evidence that legacy local preferences were imported.
    patch.hiddenModels = [
      ...new Set([
        ...(cfg.hiddenModels ?? []),
        ...(Array.isArray(localHiddenModels) ? localHiddenModels : []),
      ]),
    ];
  }

  if (Object.keys(patch).length > 0) {
    // Migration persistence must not delay hydration of unrelated settings.
    api.config.updateModelPreferences(patch).catch(() => undefined);
  }
  return { ...cfg, ...patch };
}

/**
 * One-time best-effort migration for gateway preferences.
 * Users upgrading from builds that only stored gateway state in localStorage
 * (keys: "gateway-enabled", "gateway-models") need their preferences migrated
 * to config.json so they aren't lost when localStorage is no longer read.
 */
function migrateLocalGatewayPrefsToBackend(
  api: APIClient,
  cfg: { muxGatewayEnabled?: boolean; muxGatewayModels?: string[] }
): void {
  // Only migrate if the backend doesn't have these values yet
  if (cfg.muxGatewayEnabled !== undefined && cfg.muxGatewayModels !== undefined) return;

  // Read legacy localStorage keys
  const localEnabled = readPersistedState<boolean>(GATEWAY_ENABLED_KEY, true);
  const localModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);

  const shouldMigrateEnabled = cfg.muxGatewayEnabled === undefined && localEnabled === false;
  const shouldMigrateModels = cfg.muxGatewayModels === undefined && localModels.length > 0;

  const clearLegacyGatewayPrefs = () => {
    updatePersistedState<boolean | undefined>(GATEWAY_ENABLED_KEY, undefined);
    updatePersistedState<string[] | undefined>(GATEWAY_MODELS_KEY, undefined);
  };

  if (shouldMigrateEnabled || shouldMigrateModels) {
    api.config
      .updateMuxGatewayPrefs({
        muxGatewayEnabled: cfg.muxGatewayEnabled ?? localEnabled,
        muxGatewayModels: cfg.muxGatewayModels ?? localModels,
      })
      .then(clearLegacyGatewayPrefs)
      .catch(() => {
        // Best-effort only.
      });
  }
}

/**
 * Seed per-workspace localStorage from backend workspace metadata.
 *
 * This keeps a workspace's model/thinking consistent across devices/browsers.
 */
function seedWorkspaceLocalStorageFromBackend(
  metadata: FrontendWorkspaceMetadata,
  previous?: FrontendWorkspaceMetadata
): void {
  // Snapshot all main-workspace choices on client load, not on navigation.
  // Later metadata must not overwrite unsent choices; reload to restore backend settings.
  if (metadata.parentWorkspaceId == null && previous != null) {
    return;
  }
  // Cache keyed by agentId (string) - includes exec, plan, and custom agents
  type WorkspaceAISettingsByAgentCache = Partial<
    Record<
      string,
      { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
    >
  >;

  const workspaceId = metadata.id;

  const metadataAgentId = resolvePersistedAgentId(metadata, "");
  if (metadataAgentId.length > 0) {
    const key = getAgentIdKey(workspaceId);
    const normalized = normalizeAgentId(metadataAgentId);
    const existing = readPersistedState<string | undefined>(key, undefined);
    if (existing !== normalized) {
      updatePersistedState(key, normalized);
    }
  }

  const aiByAgent =
    metadata.aiSettingsByAgent ??
    (metadata.aiSettings
      ? {
          plan: metadata.aiSettings,
          exec: metadata.aiSettings,
        }
      : undefined);

  if (!aiByAgent) {
    return;
  }

  // Merge backend values into a per-workspace per-agent cache.
  const byAgentKey = getWorkspaceAISettingsByAgentKey(workspaceId);
  const existingByAgent = readPersistedState<WorkspaceAISettingsByAgentCache>(byAgentKey, {});
  const nextByAgent: WorkspaceAISettingsByAgentCache = { ...existingByAgent };

  for (const [agentKey, entry] of Object.entries(aiByAgent)) {
    if (!entry) continue;
    if (typeof entry.model !== "string" || entry.model.length === 0) continue;

    nextByAgent[agentKey] = {
      model: entry.model,
      thinkingLevel: entry.thinkingLevel,
      ...(entry.reasoningMode != null ? { reasoningMode: entry.reasoningMode } : {}),
    };
  }

  if (JSON.stringify(existingByAgent) !== JSON.stringify(nextByAgent)) {
    updatePersistedState(byAgentKey, nextByAgent);
  }

  // Seed the active agent into the existing keys to avoid UI flash.
  const activeAgentId = readPersistedState<string>(
    getAgentIdKey(workspaceId),
    WORKSPACE_DEFAULTS.agentId
  );
  const active = nextByAgent[activeAgentId] ?? nextByAgent.exec ?? nextByAgent.plan;
  if (!active) {
    return;
  }

  const modelKey = getModelKey(workspaceId);
  const existingModel = readPersistedState<string | undefined>(modelKey, undefined);
  if (existingModel !== active.model) {
    setWorkspaceModelWithOrigin(workspaceId, active.model, "sync");
  }

  const thinkingKey = getThinkingLevelKey(workspaceId);
  const existingThinking = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
  if (existingThinking !== active.thinkingLevel) {
    updatePersistedState(thinkingKey, active.thinkingLevel);
  }

  // Absent reasoningMode means "standard": seed it explicitly so switching to
  // an agent whose settings never carried the field cannot inherit another
  // agent's "pro" from the shared workspace-scoped key.
  const reasoningKey = getReasoningModeKey(workspaceId);
  const nextReasoning = active.reasoningMode ?? "standard";
  const existingReasoning = readPersistedState<OpenAIReasoningMode | undefined>(
    reasoningKey,
    undefined
  );
  if (existingReasoning !== nextReasoning) {
    updatePersistedState(reasoningKey, nextReasoning);
  }
}

export function toWorkspaceSelection(metadata: FrontendWorkspaceMetadata): WorkspaceSelection {
  return {
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    projectName: metadata.projectName,
    namedWorkspacePath: metadata.namedWorkspacePath,
  };
}

/**
 * Ensure workspace metadata has createdAt timestamp.
 * DEFENSIVE: Backend guarantees createdAt, but default to 2025-01-01 if missing.
 * This prevents crashes if backend contract is violated.
 */
function ensureCreatedAt(metadata: FrontendWorkspaceMetadata): void {
  if (!metadata.createdAt) {
    console.warn(
      `[Frontend] Workspace ${metadata.id} missing createdAt - using default (2025-01-01)`
    );
    metadata.createdAt = "2025-01-01T00:00:00.000Z";
  }
}

export interface WorkspaceDraft {
  draftId: string;
  subProjectPath: string | null;
  createdAt: number;
}

type WorkspaceDraftsByProject = Record<string, WorkspaceDraft[]>;

type WorkspaceDraftPromotionsByProject = Record<string, Record<string, FrontendWorkspaceMetadata>>;

function isWorkspaceDraft(value: unknown): value is WorkspaceDraft {
  if (!value || typeof value !== "object") return false;

  const record = value as { draftId?: unknown; subProjectPath?: unknown; createdAt?: unknown };
  return (
    typeof record.draftId === "string" &&
    record.draftId.trim().length > 0 &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    (record.subProjectPath === null ||
      record.subProjectPath === undefined ||
      typeof record.subProjectPath === "string")
  );
}

function normalizeWorkspaceDraftsByProject(value: unknown): WorkspaceDraftsByProject {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: WorkspaceDraftsByProject = {};

  for (const [projectPath, drafts] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(drafts)) continue;

    const nextDrafts: WorkspaceDraft[] = [];
    for (const draft of drafts) {
      if (!isWorkspaceDraft(draft)) continue;

      const normalizedSubProjectPath =
        typeof draft.subProjectPath === "string" && draft.subProjectPath.trim().length > 0
          ? draft.subProjectPath
          : null;

      nextDrafts.push({
        draftId: draft.draftId,
        subProjectPath: normalizedSubProjectPath,
        createdAt: draft.createdAt,
      });
    }

    if (nextDrafts.length > 0) {
      result[projectPath] = nextDrafts;
    }
  }

  return result;
}

function createWorkspaceDraftId(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    const id = maybeCrypto.randomUUID();
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  return `draft_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Check if a draft workspace is empty (no input text, no attachments, and no workspace name set).
 * An empty draft can be reused when the user clicks "New Workspace" instead of creating another.
 */
function isDraftEmpty(projectPath: string, draftId: string): boolean {
  const scopeId = getDraftScopeId(projectPath, draftId);

  const inputText = readPersistedState<string>(getInputKey(scopeId), "");
  if (inputText.trim().length > 0) {
    return false;
  }

  // Check for attachments
  const attachments = readPersistedState<unknown[]>(getInputAttachmentsKey(scopeId), []);
  if (Array.isArray(attachments) && attachments.length > 0) {
    return false;
  }

  // Check for workspace name state (auto-generated or manual)
  const nameState = readPersistedState<unknown>(getWorkspaceNameStateKey(scopeId), null);
  if (nameState !== null) {
    return false;
  }

  return true;
}

/**
 * Find an existing empty draft for a project (optionally within a specific sub-project).
 * Returns the draft ID if found, or null if no empty draft exists.
 */
function findExistingEmptyDraft(
  workspaceDrafts: WorkspaceDraft[],
  projectPath: string,
  subProjectPath?: string
): string | null {
  const normalizedSubProjectPath = subProjectPath ?? null;

  for (const draft of workspaceDrafts) {
    // Keep draft reuse scoped to the current sub-project. When subProjectPath is undefined
    // (project-level "New Workspace"), only reuse drafts with a null sub-project so
    // we don't silently move sub-project-specific drafts into the root flow.
    if ((draft.subProjectPath ?? null) !== normalizedSubProjectPath) {
      continue;
    }
    if (isDraftEmpty(projectPath, draft.draftId)) {
      return draft.draftId;
    }
  }
  return null;
}

// ─── Metadata context (changes on every workspace create/archive/rename) ─────
// Separated so components that only need actions/selection don't re-render on
// metadata map changes.

export interface WorkspaceMetadataContextValue {
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  loading: boolean;
  loaded: boolean;
  loadError: string | null;
}

const WorkspaceMetadataContext = createContext<WorkspaceMetadataContextValue | undefined>(
  undefined
);

// ─── Actions context (stable unless selection/drafts change) ─────────────────

export interface WorkspaceContext extends WorkspaceMetadataContextValue {
  // UI-only draft workspace promotions (draftId -> created workspace).
  // This is intentionally ephemeral: it makes the sidebar feel like the draft
  // "turns into" the created workspace, but doesn't pin ordering permanently.
  workspaceDraftPromotionsByProject: WorkspaceDraftPromotionsByProject;
  promoteWorkspaceDraft: (
    projectPath: string,
    draftId: string,
    metadata: FrontendWorkspaceMetadata
  ) => void;

  // Workspace operations
  createWorkspace: (
    projectPath: string,
    branchName: string,
    trunkBranch: string,
    runtimeConfig?: RuntimeConfig
  ) => Promise<{
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  }>;
  removeWorkspace: (
    workspaceId: string,
    options?: Parameters<APIClient["workspace"]["remove"]>[0]["options"]
  ) => Promise<WorkspaceRemoveResult>;
  updateWorkspaceTitle: (
    workspaceId: string,
    newTitle: string
  ) => Promise<{ success: boolean; error?: string }>;
  setWorkspacePinned: (
    workspaceId: string,
    pinned: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  reorderPinnedWorkspaces: (
    workspaceIds: string[]
  ) => Promise<{ success: boolean; error?: string }>;
  preflightArchiveWorkspace: (
    workspaceId: string
  ) => Promise<{ success: boolean; error?: string; data?: ArchivePreflightResult }>;
  archiveWorkspace: (
    workspaceId: string,
    options?: { acknowledgedUntrackedPaths?: string[] }
  ) => Promise<{ success: boolean; error?: string; data?: ArchiveWorkspaceResult }>;
  unarchiveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  /**
   * Workspaces with an archive preflight or archive request in flight. Archive can take tens
   * of seconds server-side (snapshot + worktree removal), so this lives here rather than in
   * the component that started it: the sidebar row and the menu bar both show "Archiving..."
   * no matter which one the user clicked.
   */
  archivingWorkspaceIds: ReadonlySet<string>;
  refreshWorkspaceMetadata: () => Promise<void>;
  setWorkspaceMetadata: React.Dispatch<
    React.SetStateAction<Map<string, FrontendWorkspaceMetadata>>
  >;

  // Selection
  selectedWorkspace: WorkspaceSelection | null;
  setSelectedWorkspace: React.Dispatch<React.SetStateAction<WorkspaceSelection | null>>;

  // Workspace creation flow
  pendingNewWorkspaceProject: string | null;
  /** SubProject ID to pre-select when creating a new workspace (from URL) */
  pendingNewWorkspaceSubProjectPath: string | null;
  /** Draft ID to open when creating a UI-only workspace draft (from URL) */
  pendingNewWorkspaceDraftId: string | null;
  /** Legacy entry point: open the creation screen (no new draft is created) */
  beginWorkspaceCreation: (projectPath: string) => void;

  // UI-only workspace creation drafts (placeholders)
  workspaceDraftsByProject: WorkspaceDraftsByProject;
  createWorkspaceDraft: (
    projectPath: string,
    subProjectPath?: string,
    options?: { replace?: boolean }
  ) => void;
  updateWorkspaceDraftSubProject: (
    projectPath: string,
    draftId: string,
    subProjectPath: string | null
  ) => void;
  openWorkspaceDraft: (projectPath: string, draftId: string) => void;
  deleteWorkspaceDraft: (projectPath: string, draftId: string) => void;

  // Helpers
  getWorkspaceInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
}

const WorkspaceActionsContext = createContext<
  Omit<WorkspaceContext, "workspaceMetadata" | "loading" | "loaded" | "loadError"> | undefined
>(undefined);

export const WorkspaceContext = {
  Provider(props: { value: WorkspaceContext; children: ReactNode }) {
    const { workspaceMetadata, loading, loaded, loadError, ...actionsValue } = props.value;

    // Some focused tests only need to provide metadata. Route the public provider
    // shape into the split contexts so they avoid mounting WorkspaceProvider and
    // its API subscriptions.
    return (
      <WorkspaceMetadataContext.Provider value={{ workspaceMetadata, loading, loaded, loadError }}>
        <WorkspaceActionsContext.Provider value={actionsValue}>
          {props.children}
        </WorkspaceActionsContext.Provider>
      </WorkspaceMetadataContext.Provider>
    );
  },
};

interface WorkspaceProviderProps {
  children: ReactNode;
}

/**
 * Keeps `workspaceId` in the archiving set while `run` is outstanding. Requests for one
 * workspace can overlap (the sidebar shortcut fires while a header-started archive is still
 * in flight), so the id is reference-counted and only removed when the last one settles.
 */
async function trackArchivingRequest<T>(
  counts: Map<string, number>,
  setArchivingWorkspaceIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  workspaceId: string,
  run: () => Promise<T>
): Promise<T> {
  counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  setArchivingWorkspaceIds((prev) =>
    prev.has(workspaceId) ? prev : new Set(prev).add(workspaceId)
  );
  try {
    return await run();
  } finally {
    const remaining = (counts.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(workspaceId, remaining);
    } else {
      counts.delete(workspaceId);
      setArchivingWorkspaceIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  }
}

/**
 * Startup auto-navigation should yield once the user already has meaningful route state.
 * Desktop launch-project is the exception: its first pass may override a restored
 * file:// route when the backend reports explicit startup intent.
 */
function shouldBlockStartupAutoNavigation(options: {
  hasExplicitRootRoute: boolean;
  hasBlockingRouteState: boolean;
  shouldOverrideRestoredDesktopRoute?: boolean;
}): boolean {
  return (
    options.hasExplicitRootRoute ||
    (!options.shouldOverrideRestoredDesktopRoute && options.hasBlockingRouteState)
  );
}

function getWorkspaceProjectRoutePath(
  metadata: Pick<FrontendWorkspaceMetadata, "kind" | "projectPath">
): string {
  return metadata.kind === "scratch" ? SCRATCH_PROJECT_CONFIG_KEY : metadata.projectPath;
}

function getMostRecentVisibleWorkspaceScope(
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>,
  workspaceRecency: Record<string, number>,
  getProjectConfig: (projectPath: string) => { projectKind?: "user" | "system" } | undefined
): WorkspaceCreationScope | null {
  const recentWorkspace = [...workspaceMetadata.values()]
    .filter((workspace) => {
      if (workspace.kind === "scratch") {
        return true;
      }
      const projectConfig = getProjectConfig(workspace.projectPath);
      if (!projectConfig) {
        return false;
      }
      if (projectConfig.projectKind !== "system") {
        return true;
      }

      return workspace.projectPath === MULTI_PROJECT_CONFIG_KEY;
    })
    .sort((a, b) => {
      const aRecency = workspaceRecency[a.id] ?? 0;
      const bRecency = workspaceRecency[b.id] ?? 0;
      if (aRecency !== bRecency) {
        return bRecency - aRecency;
      }

      const aCreatedAtRaw = Date.parse(a.createdAt ?? "");
      const bCreatedAtRaw = Date.parse(b.createdAt ?? "");
      const aCreatedAt = Number.isFinite(aCreatedAtRaw) ? aCreatedAtRaw : 0;
      const bCreatedAt = Number.isFinite(bCreatedAtRaw) ? bCreatedAtRaw : 0;
      return bCreatedAt - aCreatedAt;
    })[0];

  return recentWorkspace
    ? {
        projectPath: getWorkspaceProjectRoutePath(recentWorkspace),
        subProjectPath: recentWorkspace.subProjectPath ?? null,
      }
    : null;
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const { api } = useAPI();

  // Cache global agent defaults (plus legacy mode defaults) so non-react code paths can read them.
  useEffect(() => {
    if (!api?.config?.getConfig) return;

    let active = true;
    // Track writes, not just equality: toggling twice is still local intent.
    const dirtyKeys = new Set<string>();
    const initialPreferences = [DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY].map((key) => ({
      key,
      value: JSON.stringify(readPersistedState<unknown>(key, undefined)),
    }));
    const markDirty = (key: string | null) => {
      for (const preference of initialPreferences) {
        if (key === null || key === preference.key) dirtyKeys.add(preference.key);
      }
    };
    const unsubscribeWrites = subscribePersistedStateWrites(({ key, source }) => {
      if (source === "local") markDirty(key);
    });
    const storageWindow = window;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === storageWindow.localStorage) markDirty(event.key);
    };
    storageWindow.addEventListener("storage", onStorage);
    const stopTrackingWrites = () => {
      unsubscribeWrites();
      storageWindow.removeEventListener("storage", onStorage);
    };

    api.config
      .getConfig()
      .then((cfg) => {
        if (!active) return;
        // Cross-tab writes can land before their queued storage events arrive.
        for (const { key, value } of initialPreferences) {
          if (JSON.stringify(readPersistedState<unknown>(key, undefined)) !== value)
            dirtyKeys.add(key);
        }
        // Read legacy local preferences before backend hydration can overwrite them.
        // Seeding from the backend is what lets a port switch keep the same UI state.
        seedConfigMirrors(
          { ...cfg, ...migrateLocalModelPrefsToBackend(api, cfg, dirtyKeys) },
          dirtyKeys
        );

        // One-time gateway pref migration: if the backend doesn't have gateway prefs yet,
        // check if the user had non-default values in the old localStorage keys.
        // This covers users upgrading from builds that only stored gateway state locally.
        migrateLocalGatewayPrefsToBackend(api, cfg);
      })
      .catch(() => {
        // Best-effort only.
      })
      .finally(stopTrackingWrites);

    return () => {
      active = false;
      stopTrackingWrites();
    };
  }, [api]);
  // Get project refresh function from ProjectContext
  const {
    resolveProjectPath,
    resolveNewChatProjectPath,
    getProjectConfig,
    hasAnyProject,
    refreshProjects,
    loading: projectsLoading,
  } = useProjectContext();
  // Get router navigation functions and current route state
  const {
    navigateToWorkspace,
    navigateToProject,
    navigateToHome,
    currentWorkspaceId,
    currentProjectId,
    currentProjectPathFromState,
    currentSettingsSection,
    isAnalyticsOpen,
    pendingDraftId,
  } = useRouter();
  const location = useLocation();

  const workspaceStore = useWorkspaceStoreRaw();

  useLayoutEffect(() => {
    // When the user navigates to settings, currentWorkspaceId becomes null
    // (URL is /settings/...). Preserve the active workspace subscription so
    // chat messages aren't cleared. Only null it out when truly leaving a
    // workspace context (for example, via the compatibility root route).
    if (currentWorkspaceId) {
      workspaceStore.setActiveWorkspaceId(currentWorkspaceId);
    } else if (!currentSettingsSection && !isAnalyticsOpen) {
      // Only null out the active workspace when truly leaving a workspace
      // context (for example, via the compatibility root route). Settings and
      // analytics pages should preserve the subscription so chat messages aren't cleared.
      workspaceStore.setActiveWorkspaceId(null);
    }
  }, [workspaceStore, currentWorkspaceId, currentSettingsSection, isAnalyticsOpen]);
  const [workspaceMetadata, setWorkspaceMetadataState] = useState<
    Map<string, FrontendWorkspaceMetadata>
  >(new Map());
  const setWorkspaceMetadata = useCallback(
    (update: SetStateAction<Map<string, FrontendWorkspaceMetadata>>) => {
      setWorkspaceMetadataState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        // IMPORTANT: Sync the imperative WorkspaceStore first so hooks (AIView,
        // LeftSidebar, etc.) never render with a selected workspace ID before
        // the store has subscribed and created its aggregator. Otherwise the
        // render path hits WorkspaceStore.assertGet() and throws the
        // "Workspace <id> not found - must call addWorkspace() first" assert.
        workspaceStore.syncWorkspaces(next);
        return next;
      });
    },
    [workspaceStore]
  );
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaceDraftPromotionsByProject, setWorkspaceDraftPromotionsByProject] =
    useState<WorkspaceDraftPromotionsByProject>({});
  const [workspaceDraftsByProjectState, setWorkspaceDraftsByProjectState] =
    usePersistedState<WorkspaceDraftsByProject>(
      WORKSPACE_DRAFTS_BY_PROJECT_KEY,
      {},
      { listener: true }
    );

  const workspaceDraftsByProject = useMemo(
    () => normalizeWorkspaceDraftsByProject(workspaceDraftsByProjectState),
    [workspaceDraftsByProjectState]
  );

  const pendingDeepLinksRef = useRef<DeepLinkPayload[]>([]);

  const handleDeepLink = useCallback(
    (payload: DeepLinkPayload) => {
      if (payload.type !== "new_chat") {
        return;
      }

      const resolvedProjectPath = resolveNewChatProjectPath({
        projectPath: payload.projectPath,
        projectId: payload.projectId,
        project: payload.project,
      });

      if (!resolvedProjectPath) {
        // Startup deep links can arrive before the projects list is populated.
        //
        // NOTE: ProjectContext can set `projectsLoading=false` even when the API isn't
        // connected yet (refreshProjects() returns early but the effect still flips loading).
        // In that window, buffer unresolved links in-memory and retry once projects load.
        const shouldBuffer = projectsLoading || !api || !hasAnyProject;
        if (shouldBuffer) {
          const queue = pendingDeepLinksRef.current;
          if (queue.length >= 10) {
            queue.shift();
          }
          queue.push(payload);
        }
        return;
      }

      const resolvedProjectConfig = getProjectConfig(resolvedProjectPath);
      const owningProjectPath = resolvedProjectConfig?.parentProjectPath ?? resolvedProjectPath;
      const normalizedSubProjectPath = resolvedProjectConfig?.parentProjectPath
        ? resolvedProjectPath
        : null;

      // IMPORTANT: Deep links should always create a fresh draft, even if an existing draft
      // is empty. This keeps deep-link navigations predictable and avoids surprising reuse.
      const draftId = createWorkspaceDraftId();
      const createdAt = Date.now();

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[owningProjectPath] ?? [];

        return {
          ...current,
          [owningProjectPath]: [
            ...existing,
            {
              draftId,
              subProjectPath: normalizedSubProjectPath,
              createdAt,
            },
          ],
        };
      });

      const prompt =
        typeof payload.prompt === "string" && payload.prompt.trim().length > 0
          ? payload.prompt
          : null;

      if (prompt) {
        updatePersistedState(getInputKey(getDraftScopeId(owningProjectPath, draftId)), prompt);
      }

      navigateToProject(owningProjectPath, draftId);
    },
    [
      api,
      navigateToProject,
      projectsLoading,
      resolveNewChatProjectPath,
      getProjectConfig,
      hasAnyProject,
      setWorkspaceDraftsByProjectState,
    ]
  );

  const deepLinkHandlerRef = useRef(handleDeepLink);
  deepLinkHandlerRef.current = handleDeepLink;

  useEffect(() => {
    const unsubscribe = window.api?.onDeepLink?.((payload) => {
      deepLinkHandlerRef.current(payload);
    });

    const pending = window.api?.consumePendingDeepLinks?.() ?? [];
    for (const payload of pending) {
      deepLinkHandlerRef.current(payload);
    }

    return () => {
      unsubscribe?.();
    };
  }, [deepLinkHandlerRef]);

  useEffect(() => {
    if (pendingDeepLinksRef.current.length === 0) {
      return;
    }

    const queued = pendingDeepLinksRef.current;
    pendingDeepLinksRef.current = [];

    for (const payload of queued) {
      deepLinkHandlerRef.current(payload);
    }
  }, [projectsLoading, resolveNewChatProjectPath, hasAnyProject, deepLinkHandlerRef]);

  // Clean up promotions that point at removed drafts or archived workspaces so
  // promoted entries never hide the real workspace list.
  useEffect(() => {
    if (loading) {
      return;
    }

    setWorkspaceDraftPromotionsByProject((prev) => {
      let changed = false;
      const next: WorkspaceDraftPromotionsByProject = {};

      for (const [projectPath, promotions] of Object.entries(prev)) {
        const draftIds = new Set(
          (workspaceDraftsByProject[projectPath] ?? []).map((draft) => draft.draftId)
        );
        if (draftIds.size === 0) {
          if (Object.keys(promotions).length > 0) {
            changed = true;
          }
          continue;
        }

        const nextPromotions: Record<string, FrontendWorkspaceMetadata> = {};
        for (const [draftId, metadata] of Object.entries(promotions)) {
          if (!draftIds.has(draftId)) {
            changed = true;
            continue;
          }

          const liveMetadata = workspaceMetadata.get(metadata.id);
          if (!liveMetadata) {
            changed = true;
            continue;
          }

          nextPromotions[draftId] = liveMetadata;
        }

        if (Object.keys(nextPromotions).length > 0) {
          next[projectPath] = nextPromotions;
          if (Object.keys(nextPromotions).length !== Object.keys(promotions).length) {
            changed = true;
          }
        } else if (Object.keys(promotions).length > 0) {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [loading, workspaceDraftsByProject, workspaceMetadata]);

  const currentProjectPath = useMemo(() => {
    if (currentProjectPathFromState) return currentProjectPathFromState;
    if (!currentProjectId) return null;

    return (
      resolveProjectPath({ type: "path", value: currentProjectId }) ??
      resolveProjectPath({ type: "routeId", value: currentProjectId })
    );
  }, [currentProjectId, currentProjectPathFromState, resolveProjectPath]);

  // pendingNewWorkspaceProject is derived from current project in URL/state
  const pendingNewWorkspaceProject = currentProjectPath;
  const pendingNewWorkspaceDraftId = pendingNewWorkspaceProject ? pendingDraftId : null;
  const pendingNewWorkspaceSubProjectPathRaw =
    pendingNewWorkspaceProject && pendingNewWorkspaceDraftId
      ? ((workspaceDraftsByProject[pendingNewWorkspaceProject] ?? []).find(
          (draft) => draft.draftId === pendingNewWorkspaceDraftId
        )?.subProjectPath ?? null)
      : null;
  // Drop the draft's stored sub-project path if the sub-project has since been
  // removed/unregistered. WorkspaceService.create rejects unknown sub-project
  // paths under the parent, so leaking a stale value would brick reopening a
  // legacy draft. Coerce to null and let creation fall back to the parent cwd.
  const pendingNewWorkspaceSubProjectPath = (() => {
    if (!pendingNewWorkspaceProject || !pendingNewWorkspaceSubProjectPathRaw) {
      return null;
    }
    const pendingSubProjectConfig = getProjectConfig(pendingNewWorkspaceSubProjectPathRaw);
    return pendingSubProjectConfig?.parentProjectPath === pendingNewWorkspaceProject
      ? pendingNewWorkspaceSubProjectPathRaw
      : null;
  })();

  // selectedWorkspace is derived from currentWorkspaceId in URL + workspaceMetadata
  const selectedWorkspace = useMemo(() => {
    if (!currentWorkspaceId) return null;
    const metadata = workspaceMetadata.get(currentWorkspaceId);
    if (!metadata) return null;
    return toWorkspaceSelection(metadata);
  }, [currentWorkspaceId, workspaceMetadata]);

  const hasBlockingStartupRouteState =
    selectedWorkspace != null ||
    currentSettingsSection != null ||
    isAnalyticsOpen ||
    pendingNewWorkspaceProject != null;

  const resolveFallbackWorkspaceScope = useCallback((): WorkspaceCreationScope | null => {
    const recentScope = getMostRecentVisibleWorkspaceScope(
      workspaceMetadata,
      workspaceStore.getWorkspaceRecency(),
      getProjectConfig
    );
    if (recentScope) {
      return recentScope;
    }

    const projectPath = resolveNewChatProjectPath({});
    return projectPath ? { projectPath, subProjectPath: null } : null;
  }, [workspaceMetadata, workspaceStore, getProjectConfig, resolveNewChatProjectPath]);

  // Keep a ref to the current selectedWorkspace for use in functional updates.
  // Update synchronously so route-driven selection changes are visible before
  // any async creation callbacks decide whether to auto-navigate.
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // Sticky in-memory flag to preserve explicit root-route navigation intent.
  // Prevents startup-only launch-project/new-chat fallbacks from overriding later
  // user-driven visits to the compatibility "/" route.
  const hasExplicitRootRouteRef = useRef(false);
  const hasProcessedInitialLocationRef = useRef(false);

  const hasCheckedDesktopLaunchProjectRef = useRef(false);
  const hasHandledStartupRootRouteRef = useRef(false);
  const hasSkippedPostStartupRootRedirectRef = useRef(false);
  const hasCheckedStaleRouteRef = useRef(false);

  useEffect(() => {
    // Skip initial mount so cold startup at "/" can still honor launch-project.
    if (!hasProcessedInitialLocationRef.current) {
      hasProcessedInitialLocationRef.current = true;
      return;
    }

    // Browser history can still land on / even though the dedicated home page is gone.
    // Treat that as explicit root navigation so startup-only auto-routing stays out of the way.
    if (location.pathname === "/") {
      hasExplicitRootRouteRef.current = true;
    }
  }, [location.pathname]);

  // setSelectedWorkspace navigates to the workspace URL (or clears if null)
  const setSelectedWorkspace = useCallback(
    (update: SetStateAction<WorkspaceSelection | null>) => {
      // Handle functional updates by resolving against the ref (always fresh)
      const current = selectedWorkspaceRef.current;
      const newValue = typeof update === "function" ? update(current) : update;

      // Keep the ref in sync immediately so async handlers (metadata events, etc.) can
      // reliably see the user's latest navigation intent.
      selectedWorkspaceRef.current = newValue;

      if (newValue) {
        hasExplicitRootRouteRef.current = false;
        navigateToWorkspace(newValue.workspaceId);
        // Persist to localStorage for next session
        updatePersistedState(SELECTED_WORKSPACE_KEY, newValue);
      } else {
        hasExplicitRootRouteRef.current = true;
        navigateToHome();
        updatePersistedState(SELECTED_WORKSPACE_KEY, null);
      }
    },
    [navigateToWorkspace, navigateToHome]
  );

  /**
   * Clear the workspace selection and navigate to a specific project page
   * instead of bouncing through the compatibility root route. Use this when
   * deselecting a workspace where we know which project the user was working in.
   */
  const clearSelectionToProject = useCallback(
    (projectPath: string) => {
      selectedWorkspaceRef.current = null;
      hasExplicitRootRouteRef.current = false;
      updatePersistedState(SELECTED_WORKSPACE_KEY, null);
      navigateToProject(projectPath);
    },
    [navigateToProject]
  );

  // Used by async subscription handlers to safely access the most recent metadata map
  // without triggering render-phase state updates.
  const workspaceMetadataRef = useRef(workspaceMetadata);
  useEffect(() => {
    workspaceMetadataRef.current = workspaceMetadata;
  }, [workspaceMetadata]);

  const loadWorkspaceMetadata = useCallback(async () => {
    if (!api) {
      setLoaded(false);
      setLoadError("API not connected");
      return false; // Return false to indicate metadata wasn't attempted.
    }

    try {
      const metadataList = await api.workspace.list();

      const metadataMap = new Map<string, FrontendWorkspaceMetadata>();
      for (const metadata of metadataList) {
        // Skip archived workspaces - they should not be tracked by the app
        if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) continue;

        ensureCreatedAt(metadata);
        // Use stable workspace ID as key (not path, which can change)
        seedWorkspaceLocalStorageFromBackend(
          metadata,
          workspaceMetadataRef.current.get(metadata.id)
        );
        metadataMap.set(metadata.id, metadata);
      }

      setWorkspaceMetadata(metadataMap);
      setLoaded(true);
      setLoadError(null);
      return true; // Return true to indicate metadata was attempted.
    } catch (error) {
      console.error("Failed to load workspace metadata:", error);
      // Keep the previous metadata map on failure so scoped preferences are not pruned.
      setLoadError(getErrorMessage(error));
      return true; // Still return true because the request completed with a failure.
    }
  }, [setWorkspaceMetadata, api]);

  // Load metadata once on mount (and again when api becomes available)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const initialLoad = async () => {
      const attempted = await loadWorkspaceMetadata();
      if (!attempted || cancelled) {
        // api not available yet - effect will run again when api connects
        return;
      }
      // After loading metadata (which may trigger migration), reload projects
      // to ensure frontend has the updated config with workspace IDs
      await refreshProjects();
      if (!cancelled) {
        setLoading(false);
      }
    };

    const loadPromise = initialLoad();
    loadPromise.catch((error) => {
      if (!cancelled) {
        setLoadError(getErrorMessage(error));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadWorkspaceMetadata, refreshProjects]);

  // URL restoration is now handled by RouterContext which parses the URL on load
  // and provides currentWorkspaceId/currentProjectId that we derive state from.

  // Check for launch project from server (for --add-project flag).
  // The backend decides when launch-project applies, so the frontend should
  // trust any returned path as explicit startup intent.
  useEffect(() => {
    if (loading || !api) return;

    const shouldOverrideRestoredDesktopRoute =
      window.location.protocol === "file:" && !hasCheckedDesktopLaunchProjectRef.current;
    if (
      shouldBlockStartupAutoNavigation({
        hasExplicitRootRoute: hasExplicitRootRouteRef.current,
        hasBlockingRouteState: hasBlockingStartupRouteState,
        shouldOverrideRestoredDesktopRoute,
      })
    ) {
      return;
    }

    let cancelled = false;
    if (shouldOverrideRestoredDesktopRoute) {
      hasCheckedDesktopLaunchProjectRef.current = true;
    }

    const checkLaunchProject = async () => {
      // Only available in server mode (checked via platform/capabilities in future)
      // For now, try the call - it will return null if not applicable
      try {
        const launchProjectPath = await api.server.getLaunchProject(undefined);
        if (cancelled || !launchProjectPath) return;

        // Find first workspace in this project
        const projectWorkspaces = Array.from(workspaceMetadata.values()).filter(
          (meta) => meta.projectPath === launchProjectPath
        );

        if (cancelled) return;

        if (projectWorkspaces.length > 0) {
          const metadata = projectWorkspaces[0];
          if (shouldOverrideRestoredDesktopRoute) {
            setSelectedWorkspace(toWorkspaceSelection(metadata));
          } else {
            // Use functional update to avoid race: user may have clicked a workspace
            // while this async call was in flight.
            setSelectedWorkspace((current) => current ?? toWorkspaceSelection(metadata));
          }
          return;
        }

        // If --add-project created a project but there are no workspaces yet, route
        // directly to the project creation view so first-time users can start
        // chatting immediately instead of parking on the compatibility root route.
        navigateToProject(launchProjectPath);
      } catch (error) {
        if (!cancelled) {
          // Ignore errors (e.g. method not found if running against old backend)
          console.debug("Failed to check launch project:", error);
        }
      }
      // If no workspaces exist yet, just leave the project in the sidebar
      // The user will need to create a workspace
    };

    void checkLaunchProject();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    loading,
    selectedWorkspace,
    currentSettingsSection,
    isAnalyticsOpen,
    pendingNewWorkspaceProject,
    hasBlockingStartupRouteState,
    workspaceMetadata,
    setSelectedWorkspace,
    navigateToProject,
  ]);

  // Self-heal: if the initial route targets a workspace that no longer exists
  // in metadata (e.g., deleted since last session), clear the stale route and
  // persisted selection so the user isn't stuck in a restore loop.
  useEffect(() => {
    if (loading || !loaded || loadError) return;
    if (hasCheckedStaleRouteRef.current) return;
    hasCheckedStaleRouteRef.current = true;

    if (!currentWorkspaceId) return;
    if (workspaceMetadata.has(currentWorkspaceId)) return;

    // If metadata is empty, a transient backend failure may have caused
    // workspace.list to return nothing (it swallows getAllWorkspaceMetadata
    // errors and resolves []), so don't clear a potentially valid route.
    if (workspaceMetadata.size === 0) return;

    setSelectedWorkspace(null);
  }, [loading, loaded, loadError, currentWorkspaceId, workspaceMetadata, setSelectedWorkspace]);

  // Subscribe to metadata updates (for create/rename/delete operations)
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.workspace.onMetadata(undefined, { signal });

        for await (const event of iterator) {
          if (signal.aborted) break;

          const meta = event.metadata;

          // 1. ALWAYS normalize incoming metadata first - this is the critical data update.
          if (meta !== null) {
            ensureCreatedAt(meta);
            seedWorkspaceLocalStorageFromBackend(meta, workspaceMetadataRef.current.get(meta.id));
          }

          const isNowArchived =
            meta !== null && isWorkspaceArchived(meta.archivedAt, meta.unarchivedAt);

          // If the currently-selected workspace is being archived, navigate away *before*
          // removing it from the active metadata map. Otherwise we can briefly render the
          // root-route empty shell while still on `/workspace/:id`.
          //
          // Prefer nearby chats in the same project first so archive does not jump the
          // user into another project; fall back to the project page when none remain.
          if (meta !== null && isNowArchived) {
            const currentSelection = selectedWorkspaceRef.current;
            if (currentSelection?.workspaceId === event.workspaceId) {
              const nextId = findAdjacentWorkspaceId(event.workspaceId, {
                preferredProjectPath: getWorkspaceProjectRoutePath(meta),
                getProjectPath: (workspaceId) => {
                  const workspace = workspaceMetadataRef.current.get(workspaceId);
                  return workspace ? getWorkspaceProjectRoutePath(workspace) : undefined;
                },
              });
              const nextMeta = nextId ? workspaceMetadataRef.current.get(nextId) : null;

              if (nextMeta) {
                setSelectedWorkspace(toWorkspaceSelection(nextMeta));
              } else {
                clearSelectionToProject(getWorkspaceProjectRoutePath(meta));
              }
            }
          }

          // Capture deleted workspace info before removing from map (needed for navigation)
          const deletedMeta =
            meta === null ? workspaceMetadataRef.current.get(event.workspaceId) : null;

          setWorkspaceMetadata((prev) => {
            const updated = new Map(prev);
            const isNewWorkspace = !prev.has(event.workspaceId) && meta !== null;
            const existingMeta = prev.get(event.workspaceId);
            const wasInitializing = existingMeta?.isInitializing === true;
            const isNowReady = meta !== null && meta.isInitializing !== true;

            if (meta === null || isNowArchived) {
              // Remove deleted or newly-archived workspaces from active map
              updated.delete(event.workspaceId);
            } else {
              // Only add/update non-archived workspaces (including unarchived ones)
              updated.set(event.workspaceId, meta);
            }

            // Reload projects when archive state changes so the sidebar's
            // embedded workspace arrays stay in sync (projects.list excludes
            // archived workspaces, so archiving/unarchiving changes them).
            const wasInActiveMap = prev.has(event.workspaceId);
            const archiveStateChanged = isNowArchived
              ? wasInActiveMap // was active, now archived
              : !wasInActiveMap && meta !== null; // was absent (archived), now active (unarchived)

            // Config notifications refresh deleted workspace lists once after a cascade.
            // Keep metadata refreshes for new workspaces and completed initialization.
            if (isNewWorkspace || (wasInitializing && isNowReady) || archiveStateChanged) {
              void refreshProjects();
            }

            return updated;
          });

          // 2. THEN handle side effects (cleanup, navigation) - these can't break data updates
          if (meta === null) {
            deleteWorkspaceStorage(event.workspaceId);

            // Navigate away only if the deleted workspace was selected
            const currentSelection = selectedWorkspaceRef.current;
            if (currentSelection?.workspaceId !== event.workspaceId) continue;

            // Try parent workspace first
            const parentWorkspaceId = deletedMeta?.parentWorkspaceId;
            const parentMeta = parentWorkspaceId
              ? workspaceMetadataRef.current.get(parentWorkspaceId)
              : null;

            if (parentMeta) {
              setSelectedWorkspace({
                workspaceId: parentMeta.id,
                projectPath: parentMeta.projectPath,
                projectName: parentMeta.projectName,
                namedWorkspacePath: parentMeta.namedWorkspacePath,
              });
              continue;
            }

            // Try sibling workspace in same project
            const projectPath = deletedMeta ? getWorkspaceProjectRoutePath(deletedMeta) : undefined;
            const fallbackMeta =
              (projectPath
                ? Array.from(workspaceMetadataRef.current.values()).find(
                    (meta) =>
                      getWorkspaceProjectRoutePath(meta) === projectPath &&
                      meta.id !== event.workspaceId
                  )
                : null) ??
              Array.from(workspaceMetadataRef.current.values()).find(
                (meta) => meta.id !== event.workspaceId
              );

            if (fallbackMeta) {
              setSelectedWorkspace(toWorkspaceSelection(fallbackMeta));
            } else if (projectPath) {
              clearSelectionToProject(projectPath);
            } else {
              setSelectedWorkspace(null);
            }
          }
        }
      } catch (err) {
        if (!signal.aborted && !isAbortError(err)) {
          console.error("Failed to subscribe to metadata:", err);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [clearSelectionToProject, refreshProjects, setSelectedWorkspace, setWorkspaceMetadata, api]);

  const createWorkspace = useCallback(
    async (
      projectPath: string,
      branchName: string,
      trunkBranch: string,
      runtimeConfig?: RuntimeConfig
    ) => {
      if (!api) throw new Error("API not connected");
      console.assert(
        typeof trunkBranch === "string" && trunkBranch.trim().length > 0,
        "Expected trunk branch to be provided when creating a workspace"
      );
      const result = await api.workspace.create({
        projectPath,
        branchName,
        trunkBranch,
        runtimeConfig,
      });
      if (result.success) {
        // Backend has already updated the config - reload projects to get updated state
        await refreshProjects();

        // Update metadata immediately to avoid race condition with validation effect
        ensureCreatedAt(result.metadata);
        seedWorkspaceLocalStorageFromBackend(
          result.metadata,
          workspaceMetadataRef.current.get(result.metadata.id)
        );
        setWorkspaceMetadata((prev) => {
          const updated = new Map(prev);
          updated.set(result.metadata.id, result.metadata);
          return updated;
        });

        // Return the new workspace selection
        return {
          projectPath,
          projectName: result.metadata.projectName,
          namedWorkspacePath: result.metadata.namedWorkspacePath,
          workspaceId: result.metadata.id,
        };
      } else {
        throw new Error(result.error);
      }
    },
    [api, refreshProjects, setWorkspaceMetadata]
  );

  const removeWorkspace = useCallback(
    async (
      workspaceId: string,
      options?: Parameters<APIClient["workspace"]["remove"]>[0]["options"]
    ): Promise<WorkspaceRemoveResult> => {
      if (!api) return { success: false, error: "API not connected" };

      // Capture state before the async operation.
      // We check currentWorkspaceId (from URL) rather than selectedWorkspace
      // because it's the source of truth for what's actually selected.
      const wasSelected = currentWorkspaceId === workspaceId;
      const metadata = workspaceMetadata.get(workspaceId);
      const projectPath = metadata
        ? getWorkspaceProjectRoutePath(metadata)
        : selectedWorkspace?.projectPath;

      try {
        const result = await api.workspace.remove({ workspaceId, options });
        if (result.success) {
          // Clean up workspace-specific localStorage keys
          deleteWorkspaceStorage(workspaceId);

          // Optimistically remove from the local metadata map so the sidebar updates immediately.
          // Relying on the metadata subscription can leave the item visible until the next refresh.
          setWorkspaceMetadata((prev) => {
            const updated = new Map(prev);
            updated.delete(workspaceId);
            return updated;
          });

          // Backend has already updated the config - reload projects to get updated state
          await refreshProjects();

          // Workspace metadata subscription handles the removal automatically.
          // No need to refetch all metadata - this avoids expensive post-compaction
          // state checks for all workspaces.

          // If the removed workspace was selected (URL was on this workspace),
          // navigate to its project page instead of bouncing through root.
          if (wasSelected && projectPath) {
            navigateToProject(projectPath);
          }
          // If not selected, don't navigate at all - stay where we are
          return { success: true };
        } else {
          console.error("Failed to remove workspace:", result.error);
          return result;
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to remove workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [
      currentWorkspaceId,
      navigateToProject,
      refreshProjects,
      selectedWorkspace,
      workspaceMetadata,
      api,
      setWorkspaceMetadata,
    ]
  );

  /**
   * Update workspace title (formerly "rename").
   * Unlike the old rename which changed the git branch/directory name,
   * this only updates the display title and can be called during streaming.
   *
   * Note: This is simpler than the old rename because the workspace ID doesn't change.
   * We just reload metadata after the update - no need to update selectedWorkspace
   * since the ID stays the same and the metadata map refresh handles the title update.
   */
  const updateWorkspaceTitle = useCallback(
    async (
      workspaceId: string,
      newTitle: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.updateTitle({ workspaceId, title: newTitle });
        if (result.success) {
          // Workspace metadata subscription handles the title update automatically.
          // No need to refetch all metadata - this avoids expensive post-compaction
          // state checks for all workspaces (which can be slow for SSH workspaces).
          return { success: true };
        } else {
          console.error("Failed to update workspace title:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to update workspace title:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  /**
   * Pin or unpin a chat. Applies an optimistic pinnedAt locally so the row
   * moves on click, even over slow connections; the workspace metadata
   * subscription round-trip then reconciles all clients with the server's
   * authoritative monotonic timestamp (and reverts on failure).
   */
  const setWorkspacePinned = useCallback(
    async (workspaceId: string, pinned: boolean): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };

      let previousPinnedAtById: Map<string, string | undefined> | null = null;
      setWorkspaceMetadata((prev) => {
        const meta = prev.get(workspaceId);
        if (!meta || Boolean(meta.pinnedAt) === pinned) return prev;
        const touched = new Map<string, string | undefined>([[workspaceId, meta.pinnedAt]]);
        const next = new Map(prev);
        // Mirror the server's global append-only ordering (all projects, not
        // just this one), including its write-path healing of corrupted pin
        // timestamps, so every row sits where authoritative metadata will
        // keep it.
        let optimisticPinnedAt: string | undefined;
        if (pinned) {
          const { changed, pinnedAt } = appendPinnedTimestamp(
            [...prev.values()]
              .filter((other) => other.pinnedAt)
              .map((other) => ({ id: other.id, pinnedAt: other.pinnedAt }))
          );
          for (const [id, healedPinnedAt] of changed) {
            const other = next.get(id);
            if (!other) continue;
            touched.set(id, other.pinnedAt);
            next.set(id, { ...other, pinnedAt: healedPinnedAt });
          }
          optimisticPinnedAt = pinnedAt;
        }
        next.set(workspaceId, { ...meta, pinnedAt: optimisticPinnedAt });
        previousPinnedAtById = touched;
        return next;
      });
      const revert = () => {
        const touched: Map<string, string | undefined> | null = previousPinnedAtById;
        if (!touched) return;
        setWorkspaceMetadata((prev) => {
          const next = new Map(prev);
          for (const [id, priorPinnedAt] of touched) {
            const meta = next.get(id);
            if (meta) next.set(id, { ...meta, pinnedAt: priorPinnedAt });
          }
          return next;
        });
      };

      try {
        const result = await api.workspace.setPinned({ workspaceId, pinned });
        if (result.success) {
          return { success: true };
        }
        revert();
        console.error("Failed to update workspace pin state:", result.error);
        return { success: false, error: result.error };
      } catch (error) {
        revert();
        const errorMessage = getErrorMessage(error);
        console.error("Failed to update workspace pin state:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api, setWorkspaceMetadata]
  );

  /**
   * Reorder pinned chats within one project bucket. `workspaceIds` is the full
   * desired pinned order for that bucket. Optimistically re-deals the existing
   * pinnedAt pool locally (same algorithm as the server) so rows move on drop;
   * the metadata subscription round-trip then reconciles all clients with the
   * server's authoritative values (and we revert on failure).
   */
  const reorderPinnedWorkspaces = useCallback(
    async (workspaceIds: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };

      let previousPinnedAtById: Map<string, string> | undefined;
      let optimisticPinnedAtById: Map<string, string> | undefined;
      setWorkspaceMetadata((prev) => {
        const currentPinnedAtById = new Map<string, string>();
        for (const id of workspaceIds) {
          const meta = prev.get(id);
          if (meta?.pinnedAt) currentPinnedAtById.set(id, meta.pinnedAt);
        }
        const orderedIds = workspaceIds.filter((id) => currentPinnedAtById.has(id));
        const changes = reassignPinnedTimestamps(orderedIds, currentPinnedAtById);
        if (changes.size === 0) return prev;

        const snapshot = new Map<string, string>();
        const applied = new Map<string, string>();
        const next = new Map(prev);
        for (const [id, pinnedAt] of changes) {
          const meta = prev.get(id);
          const previousPinnedAt = currentPinnedAtById.get(id);
          if (!meta || previousPinnedAt === undefined) continue;
          snapshot.set(id, previousPinnedAt);
          applied.set(id, pinnedAt);
          next.set(id, { ...meta, pinnedAt });
        }
        previousPinnedAtById = snapshot;
        optimisticPinnedAtById = applied;
        return next;
      });
      const revert = () => {
        const snapshot = previousPinnedAtById;
        const applied = optimisticPinnedAtById;
        if (!snapshot || !applied) return;
        setWorkspaceMetadata((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [id, pinnedAt] of snapshot) {
            const meta = prev.get(id);
            // Unawaited reorders can interleave; only roll back entries this
            // request still owns (current value == our optimistic value).
            // Otherwise a stale failure would clobber a newer reorder's state.
            if (!meta || meta.pinnedAt !== applied.get(id)) continue;
            next.set(id, { ...meta, pinnedAt });
            changed = true;
          }
          return changed ? next : prev;
        });
      };

      try {
        const result = await api.workspace.reorderPinned({ workspaceIds });
        if (result.success) {
          return { success: true };
        }
        revert();
        console.error("Failed to reorder pinned chats:", result.error);
        return { success: false, error: result.error };
      } catch (error) {
        revert();
        const errorMessage = getErrorMessage(error);
        console.error("Failed to reorder pinned chats:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api, setWorkspaceMetadata]
  );

  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const archivingRequestCounts = useRef(new Map<string, number>());

  const preflightArchiveWorkspace = useCallback(
    async (
      workspaceId: string
    ): Promise<{ success: boolean; error?: string; data?: ArchivePreflightResult }> => {
      if (!api) return { success: false, error: "API not connected" };

      try {
        const result = await trackArchivingRequest(
          archivingRequestCounts.current,
          setArchivingWorkspaceIds,
          workspaceId,
          () => api.workspace.preflightArchive({ workspaceId })
        );
        if (result.success) {
          return { success: true, data: result.data };
        }
        return { success: false, error: result.error };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
    [api]
  );

  const archiveWorkspace = useCallback(
    async (
      workspaceId: string,
      options?: { acknowledgedUntrackedPaths?: string[] }
    ): Promise<{ success: boolean; error?: string; data?: ArchiveWorkspaceResult }> => {
      if (!api) return { success: false, error: "API not connected" };

      try {
        const result = await trackArchivingRequest(
          archivingRequestCounts.current,
          setArchivingWorkspaceIds,
          workspaceId,
          () =>
            api.workspace.archive({
              workspaceId,
              acknowledgedUntrackedPaths: options?.acknowledgedUntrackedPaths,
            })
        );
        if (result.success) {
          // Older mocks/story fixtures may still return `{ success: true }` without the newer
          // typed archive payload. Treat that legacy success shape as an ordinary archive so
          // archive flows stay downgrade-friendly instead of crashing on `result.data.kind`.
          const archiveResult: ArchiveWorkspaceResult = result.data ?? { kind: "archived" };

          if (archiveResult.kind === "archived") {
            // Terminal PTYs are killed on archive; clear persisted terminal tabs so
            // unarchive doesn't briefly flash dead terminal tabs.
            const layoutKey = getRightSidebarLayoutKey(workspaceId);
            const rawLayout = readPersistedState<unknown>(layoutKey, null);

            if (rawLayout != null) {
              // Use parseRightSidebarLayoutState to handle legacy migrations
              // (e.g. "stats" tab stripped) before cleaning terminal tabs.
              const layout = parseRightSidebarLayoutState(rawLayout, "costs");
              const terminalTabs = collectAllTabs(layout.root).filter(isTerminalTab);
              let cleanedLayout = layout;
              for (const tab of terminalTabs) {
                cleanedLayout = removeTabEverywhere(cleanedLayout, tab);
              }
              updatePersistedState(layoutKey, cleanedLayout);
            }

            // Also clear persisted terminal titles since those sessions are gone.
            updatePersistedState(getTerminalTitlesKey(workspaceId), {});
          }

          // Workspace list + navigation are driven by the workspace metadata subscription.
          return { success: true, data: archiveResult };
        }

        console.error("Failed to archive workspace:", result.error);
        return { success: false, error: result.error };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to archive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  const unarchiveWorkspace = useCallback(
    async (workspaceId: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.unarchive({ workspaceId });
        if (result.success) {
          // Workspace metadata subscription handles the state update automatically.
          return { success: true };
        } else {
          console.error("Failed to unarchive workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to unarchive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  const refreshWorkspaceMetadata = useCallback(async () => {
    await loadWorkspaceMetadata();
  }, [loadWorkspaceMetadata]);

  const getWorkspaceInfo = useCallback(
    async (workspaceId: string) => {
      if (!api) return null;
      const metadata = await api.workspace.getInfo({ workspaceId });
      if (metadata) {
        ensureCreatedAt(metadata);
        seedWorkspaceLocalStorageFromBackend(
          metadata,
          workspaceMetadataRef.current.get(metadata.id)
        );
      }
      return metadata;
    },
    [api]
  );

  const promoteWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string, metadata: FrontendWorkspaceMetadata) => {
      if (projectPath.trim().length === 0) return;
      if (draftId.trim().length === 0) return;

      setWorkspaceDraftPromotionsByProject((prev) => {
        const currentProject = prev[projectPath] ?? {};
        const existing = currentProject[draftId];
        if (existing?.id === metadata.id) {
          return prev;
        }

        return {
          ...prev,
          [projectPath]: {
            ...currentProject,
            [draftId]: metadata,
          },
        };
      });
    },
    []
  );
  const beginWorkspaceCreation = useCallback(
    (projectPath: string) => {
      navigateToProject(projectPath);
    },
    [navigateToProject]
  );
  // Persist sub-project selection + URL updates so draft sub-project switches stick across navigation.
  const updateWorkspaceDraftSubProject = useCallback(
    (projectPath: string, draftId: string, subProjectPath: string | null) => {
      if (projectPath.trim().length === 0) return;
      if (draftId.trim().length === 0) return;

      const normalizedSubProjectPath =
        typeof subProjectPath === "string" && subProjectPath.trim().length > 0
          ? subProjectPath
          : null;

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];
        if (existing.length === 0) {
          return prev;
        }

        let didUpdate = false;
        const nextDrafts = existing.map((draft) => {
          if (draft.draftId !== draftId) {
            return draft;
          }
          if (draft.subProjectPath === normalizedSubProjectPath) {
            return draft;
          }
          didUpdate = true;
          return {
            ...draft,
            subProjectPath: normalizedSubProjectPath,
          };
        });

        if (!didUpdate) {
          return prev;
        }

        return {
          ...current,
          [projectPath]: nextDrafts,
        };
      });

      navigateToProject(projectPath, draftId);
    },
    [navigateToProject, setWorkspaceDraftsByProjectState]
  );

  const createWorkspaceDraft = useCallback(
    (projectPath: string, subProjectPath?: string, options?: { replace?: boolean }) => {
      // Read directly from localStorage to get the freshest value, avoiding stale closure issues.
      // The React state (workspaceDraftsByProject) may be out of date if this is called rapidly.
      const freshDrafts = normalizeWorkspaceDraftsByProject(
        readPersistedState<WorkspaceDraftsByProject>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {})
      );
      const existingDrafts = freshDrafts[projectPath] ?? [];

      // If there's an existing empty draft (optionally in the same sub-project), reuse it
      // instead of creating yet another empty draft.
      const existingEmptyDraftId = findExistingEmptyDraft(
        existingDrafts,
        projectPath,
        subProjectPath
      );
      if (existingEmptyDraftId) {
        navigateToProject(projectPath, existingEmptyDraftId, {
          replace: options?.replace,
        });
        return;
      }

      const draftId = createWorkspaceDraftId();
      const createdAt = Date.now();
      const draft: WorkspaceDraft = {
        draftId,
        subProjectPath: subProjectPath ?? null,
        createdAt,
      };

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];

        // One-time migration: if the user has an old per-project pending draft, move it
        // into the first draft scope so it stays accessible.
        if (existing.length === 0) {
          const pendingScopeId = getPendingScopeId(projectPath);
          const legacyInput = readPersistedState<string>(getInputKey(pendingScopeId), "");
          const legacyAttachments = readPersistedState<unknown>(
            getInputAttachmentsKey(pendingScopeId),
            []
          );
          const hasLegacyAttachments =
            Array.isArray(legacyAttachments) && legacyAttachments.length > 0;
          if (legacyInput.trim().length > 0 || hasLegacyAttachments) {
            migrateWorkspaceStorage(pendingScopeId, getDraftScopeId(projectPath, draftId));
          }
        }

        return {
          ...current,
          [projectPath]: [...existing, draft],
        };
      });

      navigateToProject(projectPath, draftId, { replace: options?.replace });
    },
    [navigateToProject, setWorkspaceDraftsByProjectState]
  );

  useEffect(() => {
    if (loading || projectsLoading || hasHandledStartupRootRouteRef.current) return;

    if (
      shouldBlockStartupAutoNavigation({
        hasExplicitRootRoute: hasExplicitRootRouteRef.current,
        hasBlockingRouteState: hasBlockingStartupRouteState,
      })
    ) {
      return;
    }

    const behavior = readPersistedState<LaunchBehavior>(LAUNCH_BEHAVIOR_KEY, "dashboard");
    let cancelled = false;

    const resolveStartupRootRoute = async () => {
      // Defer to launch-project whenever the backend reports one so explicit startup
      // intent can win before the local fallback chooses a project route.
      try {
        const launchProject = await api?.server.getLaunchProject(undefined);
        if (cancelled || launchProject) return;
      } catch {
        // Ignore backend capability errors and continue with the local startup fallback.
      }

      if (cancelled) return;

      const fallbackScope = resolveFallbackWorkspaceScope();
      if (!fallbackScope) return;

      hasHandledStartupRootRouteRef.current = true;

      // The old landing page is gone. Treat "/" as a compatibility entrypoint and
      // immediately replace it with a concrete project route instead of rendering a dashboard.
      if (behavior === "new-chat") {
        createWorkspaceDraft(fallbackScope.projectPath, fallbackScope.subProjectPath ?? undefined, {
          replace: true,
        });
        return;
      }

      navigateToProject(fallbackScope.projectPath, undefined, { replace: true });
    };

    void resolveStartupRootRoute();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    loading,
    projectsLoading,
    hasBlockingStartupRouteState,
    resolveFallbackWorkspaceScope,
    createWorkspaceDraft,
    navigateToProject,
  ]);

  useEffect(() => {
    if (!hasSkippedPostStartupRootRedirectRef.current) {
      hasSkippedPostStartupRootRedirectRef.current = true;
      return;
    }
    if (loading || projectsLoading) return;
    if (location.pathname !== "/") return;

    const fallbackScope = resolveFallbackWorkspaceScope();
    if (!fallbackScope) return;

    navigateToProject(fallbackScope.projectPath, undefined, { replace: true });
  }, [
    loading,
    projectsLoading,
    location.pathname,
    resolveFallbackWorkspaceScope,
    navigateToProject,
  ]);

  const openWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string) => {
      navigateToProject(projectPath, draftId);
    },
    [navigateToProject]
  );

  const deleteWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string) => {
      setWorkspaceDraftPromotionsByProject((prev) => {
        const currentProject = prev[projectPath];
        if (!currentProject || !(draftId in currentProject)) {
          return prev;
        }

        const nextProject = { ...currentProject };
        delete nextProject[draftId];

        const next: WorkspaceDraftPromotionsByProject = { ...prev };
        if (Object.keys(nextProject).length === 0) {
          delete next[projectPath];
        } else {
          next[projectPath] = nextProject;
        }
        return next;
      });

      deleteWorkspaceStorage(getDraftScopeId(projectPath, draftId));

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];
        const nextDrafts = existing.filter((draft) => draft.draftId !== draftId);

        const next: WorkspaceDraftsByProject = { ...current };
        if (nextDrafts.length === 0) {
          delete next[projectPath];
        } else {
          next[projectPath] = nextDrafts;
        }
        return next;
      });
    },
    [setWorkspaceDraftPromotionsByProject, setWorkspaceDraftsByProjectState]
  );

  // Split into two context values so metadata-Map churn doesn't re-render
  // components that only need actions/selection/drafts.
  const metadataValue = useMemo<WorkspaceMetadataContextValue>(
    () => ({ workspaceMetadata, loading, loaded, loadError }),
    [workspaceMetadata, loading, loaded, loadError]
  );

  const actionsValue = useMemo(
    () => ({
      createWorkspace,
      removeWorkspace,
      updateWorkspaceTitle,
      setWorkspacePinned,
      reorderPinnedWorkspaces,
      preflightArchiveWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      archivingWorkspaceIds,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      pendingNewWorkspaceSubProjectPath,
      pendingNewWorkspaceDraftId,
      beginWorkspaceCreation,
      workspaceDraftsByProject,
      workspaceDraftPromotionsByProject,
      promoteWorkspaceDraft,
      createWorkspaceDraft,
      updateWorkspaceDraftSubProject,
      openWorkspaceDraft,
      deleteWorkspaceDraft,
      getWorkspaceInfo,
    }),
    [
      createWorkspace,
      removeWorkspace,
      updateWorkspaceTitle,
      setWorkspacePinned,
      reorderPinnedWorkspaces,
      preflightArchiveWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      archivingWorkspaceIds,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      pendingNewWorkspaceSubProjectPath,
      pendingNewWorkspaceDraftId,
      beginWorkspaceCreation,
      workspaceDraftsByProject,
      workspaceDraftPromotionsByProject,
      promoteWorkspaceDraft,
      createWorkspaceDraft,
      updateWorkspaceDraftSubProject,
      openWorkspaceDraft,
      deleteWorkspaceDraft,
      getWorkspaceInfo,
    ]
  );

  return (
    <WorkspaceMetadataContext.Provider value={metadataValue}>
      <WorkspaceActionsContext.Provider value={actionsValue}>
        {props.children}
      </WorkspaceActionsContext.Provider>
    </WorkspaceMetadataContext.Provider>
  );
}

/**
 * Subscribe to workspace metadata only. Use this in components that need the
 * metadata Map but don't need actions/selection (avoids re-rendering on
 * selection or draft changes).
 */
export function useWorkspaceMetadata(): WorkspaceMetadataContextValue {
  const context = useContext(WorkspaceMetadataContext);
  if (!context) {
    throw new Error("useWorkspaceMetadata must be used within WorkspaceProvider");
  }
  return context;
}

/**
 * Subscribe to workspace actions/selection/drafts only. This context value is
 * stable across metadata-Map changes, so sidebar-like components that don't
 * need the full Map can avoid re-renders.
 */
export function useWorkspaceActions(): Omit<
  WorkspaceContext,
  "workspaceMetadata" | "loading" | "loaded" | "loadError"
> {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("useWorkspaceActions must be used within WorkspaceProvider");
  }
  return context;
}

/**
 * Like useWorkspaceActions, but returns undefined outside WorkspaceProvider.
 * For components (e.g. AgentListItem) that are also rendered in Storybook or
 * tests without the full provider tree.
 */
export function useWorkspaceActionsOptional():
  | Omit<WorkspaceContext, "workspaceMetadata" | "loading" | "loaded" | "loadError">
  | undefined {
  return useContext(WorkspaceActionsContext) ?? undefined;
}

/**
 * Backward-compatible hook that merges both contexts into the full
 * WorkspaceContext shape. Subscribes to BOTH metadata and actions contexts,
 * so it re-renders on any change. Prefer the narrower hooks above when possible.
 */
export function useWorkspaceContext(): WorkspaceContext {
  const metadata = useWorkspaceMetadata();
  const actions = useWorkspaceActions();
  return useMemo(() => ({ ...metadata, ...actions }), [metadata, actions]);
}

/**
 * Optional version of useWorkspaceContext.
 *
 * This is useful for environments that render message/tool components without the full
 * workspace shell (e.g. VS Code webviews).
 */
export function useOptionalWorkspaceContext(): WorkspaceContext | null {
  const metadataCtx = useContext(WorkspaceMetadataContext);
  const actionsCtx = useContext(WorkspaceActionsContext);
  if (!metadataCtx || !actionsCtx) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- both arms are stable across renders
  return useMemo(() => ({ ...metadataCtx, ...actionsCtx }), [metadataCtx, actionsCtx]);
}
