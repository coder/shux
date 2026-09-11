import type { ReactNode } from "react";
import { useRef } from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ConfirmDialogProvider } from "@/browser/contexts/ConfirmDialogContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { UILayoutsProvider } from "@/browser/contexts/UILayoutsContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import { selectWorkspace } from "@/browser/stories/helpers/uiState";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import {
  getExperimentKey,
  getExperimentList,
  type ExperimentId,
} from "@/common/constants/experiments";
import {
  SELECTED_WORKSPACE_KEY,
  SIDEBAR_AGE_GROUPING_KEY,
  TERMINAL_BADGE_CONFIG_KEY,
  UI_THEME_KEY,
} from "@/common/constants/storage";
import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import type { ServerAuthSession } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ProjectConfig } from "@/common/types/project";
import type { TaskSettings } from "@/common/types/tasks";
import type { GoalDefaults } from "@/constants/goals";
import type { LayoutPresetsConfig } from "@/common/types/uiLayouts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface SettingsSectionStoryProps {
  setup: () => APIClient;
  children: ReactNode;
}

export function resetStorybookPersistedStateForStory(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));

    // Storybook reuses one browser origin across stories, so experiment
    // localStorage overrides from one story must not decide another story's
    // switch positions. Each story can opt back in through setupSettingsStory().
    for (const experiment of getExperimentList()) {
      localStorage.removeItem(getExperimentKey(experiment.id));
    }

    // Sidebar stories can write sidebarAgeGrouping=false into the shared
    // origin; clear it so the GeneralSection switch snapshots its default.
    localStorage.removeItem(SIDEBAR_AGE_GROUPING_KEY);

    // Terminal badge stories seed an enabled badge config; clear it so the
    // default GeneralSection story snapshots the disabled (collapsed) rows.
    localStorage.removeItem(TERMINAL_BADGE_CONFIG_KEY);
  }
}

function getStorybookRenderKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const storyId = params.get("id") ?? params.get("path");
  const viewportBucket = window.innerWidth <= 768 ? "narrow" : "wide";
  return storyId ? `${storyId}:${viewportBucket}` : viewportBucket;
}

/**
 * Shared story wrapper for settings section stories.
 *
 * Mirrors the minimal provider stack needed by settings sections while allowing
 * each story to inject a mock ORPC client via setup().
 */
export function SettingsSectionStory(props: SettingsSectionStoryProps) {
  const lastRenderKeyRef = useRef<string | null>(null);
  const clientRef = useRef<APIClient | null>(null);
  const wiredProvidersClientRef = useRef<APIClient | null>(null);

  const renderKey = getStorybookRenderKey();
  const shouldReset = clientRef.current === null || lastRenderKeyRef.current !== renderKey;

  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastRenderKeyRef.current = renderKey;
    clientRef.current = null;
  }

  clientRef.current ??= props.setup();

  // useProvidersConfig consumers (ProvidersSection, ModelsSection, ...) read
  // the shared ProvidersConfigStore, which gets its client from AppLoader in
  // the real app. These stories bypass AppLoader, so wire the store to the
  // story client (once per client instance, alongside the client creation
  // above, so the config fetch starts before the section mounts).
  if (wiredProvidersClientRef.current !== clientRef.current) {
    wiredProvidersClientRef.current = clientRef.current;
    getProvidersConfigStore().setClient(clientRef.current);
    // useRouting/useMinThinkingLevels consumers read the shared AppConfigStore.
    getAppConfigStore().setClient(clientRef.current);
  }

  return (
    <APIProvider key={renderKey ?? "settings-section-story"} client={clientRef.current}>
      <PolicyProvider>
        <RouterProvider>
          <ProjectProvider>
            <WorkspaceProvider>
              <ExperimentsProvider>
                <UILayoutsProvider>
                  <SettingsProvider>
                    <ProviderOptionsProvider>
                      <ConfirmDialogProvider>{props.children}</ConfirmDialogProvider>
                    </ProviderOptionsProvider>
                  </SettingsProvider>
                </UILayoutsProvider>
              </ExperimentsProvider>
            </WorkspaceProvider>
          </ProjectProvider>
        </RouterProvider>
      </PolicyProvider>
    </APIProvider>
  );
}

interface SetupSettingsStoryOptions {
  layoutPresets?: LayoutPresetsConfig;
  /** Initial model classes for Settings → Models → Model Classes. */
  modelClasses?: Record<string, string>;
  providersConfig?: Record<
    string,
    {
      apiKeySet: boolean;
      apiKeySource?: "config" | "file" | "env";
      isEnabled: boolean;
      isConfigured: boolean;
      baseUrl?: string;
      baseUrlSource?: "config" | "env";
      baseUrlResolved?: string;
      serviceTier?: ServiceTier;
      models?: string[];
    }
  >;
  providersList?: string[];
  agentAiDefaults?: AgentAiDefaults;
  taskSettings?: Partial<TaskSettings>;
  /** Initial global heartbeat default prompt for config.getConfig */
  heartbeatDefaultPrompt?: string;
  /** Initial global heartbeat default interval for config.getConfig */
  heartbeatDefaultIntervalMs?: number;
  /** Initial global goal defaults for config.getConfig */
  goalDefaults?: GoalDefaults;
  /** Sessions shown in Settings → Server Access. */
  serverAuthSessions?: ServerAuthSession[];
  /** Pre-set experiment states in localStorage before render */
  experiments?: Partial<Record<string, boolean>>;
}

/** Setup basic workspace for settings stories. */
export function setupSettingsStory(options: SetupSettingsStoryOptions): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

  if (options.experiments) {
    for (const [experimentId, enabled] of Object.entries(options.experiments)) {
      const key = getExperimentKey(experimentId as ExperimentId);
      window.localStorage.setItem(key, JSON.stringify(enabled));
    }
  }

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    providersConfig: options.providersConfig ?? {},
    agentAiDefaults: options.agentAiDefaults,
    providersList: options.providersList ?? ["anthropic", "openai", "xai"],
    heartbeatDefaultPrompt: options.heartbeatDefaultPrompt,
    heartbeatDefaultIntervalMs: options.heartbeatDefaultIntervalMs,
    goalDefaults: options.goalDefaults,
    taskSettings: options.taskSettings,
    serverAuthSessions: options.serverAuthSessions,
    layoutPresets: options.layoutPresets,
    modelClasses: options.modelClasses,
  });
}

/** Setup projects with explicit trust states for Security section stories. */
export function setupSecurityStory(
  projectEntries: Array<{
    name: string;
    path: string;
    trusted: boolean;
    workspaces?: string[];
  }>
): APIClient {
  const allWorkspaces: FrontendWorkspaceMetadata[] = [];
  const projects = new Map<string, ProjectConfig>();

  for (const entry of projectEntries) {
    const workspaceNames = entry.workspaces ?? ["main"];
    const entryWorkspaces = workspaceNames.map((workspaceName) =>
      createWorkspace({
        id: `ws-${entry.name}-${workspaceName}`,
        name: workspaceName,
        projectName: entry.name,
        projectPath: entry.path,
      })
    );

    allWorkspaces.push(...entryWorkspaces);
    projects.set(entry.path, {
      workspaces: entryWorkspaces.map((workspace) => ({
        path: workspace.namedWorkspacePath,
        id: workspace.id,
        name: workspace.name,
      })),
      trusted: entry.trusted,
    });
  }

  if (allWorkspaces.length > 0) {
    selectWorkspace(allWorkspaces[0]);
  }

  return createMockORPCClient({
    projects,
    workspaces: allWorkspaces,
  });
}

export const MOCK_SERVER_AUTH_SESSIONS: ServerAuthSession[] = [
  {
    id: "session-current",
    label: "Safari on iPhone",
    createdAtMs: 1_735_689_600_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: true,
  },
  {
    id: "session-macbook",
    label: "Chrome on Mac",
    createdAtMs: 1_735_776_000_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: false,
  },
  {
    id: "session-tablet",
    label: "Firefox on Android",
    createdAtMs: 1_735_862_400_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: false,
  },
];
