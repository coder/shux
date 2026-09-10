import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { LeftSidebar } from "./LeftSidebar";
import { PIXEL_DUAL_THEME } from "@/browser/stories/meta.js";
import { createOnChatAdapter, type ChatHandler } from "@/browser/stories/helpers/chatSetup";
import { setWorkspaceDrafts } from "@/browser/stories/helpers/drafts";
import { clearWorkspaceSelection, expandProjects } from "@/browser/stories/helpers/uiState";
import { createStreamingChatHandler } from "@/browser/stories/mocks/chatHandlers";
import { createGitStatusOutput, type GitStatusFixture } from "@/browser/stories/mocks/git";
import { createUserMessage } from "@/browser/stories/mocks/messages";
import {
  NOW,
  STABLE_TIMESTAMP,
  createLocalWorkspace,
  createSSHWorkspace,
  createWorkspace,
  groupWorkspacesByProject,
} from "@/browser/stories/mocks/workspaces";
import { within, userEvent, waitFor } from "storybook/test";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { ProjectProvider, useProjectContext } from "@/browser/contexts/ProjectContext";
import { WorkspaceProvider, useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { ConfirmDialogProvider } from "@/browser/contexts/ConfirmDialogContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { AboutDialogProvider } from "@/browser/contexts/AboutDialogContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { useWorkspaceRecency } from "@/browser/stores/WorkspaceStore";
import { buildSortedWorkspacesByProject } from "@/browser/utils/ui/workspaceFiltering";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  SELECTED_WORKSPACE_KEY,
  SIDEBAR_AGE_GROUPING_KEY,
  UI_THEME_KEY,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";

const meta: Meta<typeof LeftSidebar> = {
  title: "Components/LeftSidebar",
  component: LeftSidebar,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story: () => JSX.Element) => {
      // Sidebar stories are about list organization; keep the main panel unselected.
      clearWorkspaceSelection();
      return <Story />;
    },
  ],
};

export default meta;
type AppStory = StoryObj<typeof meta>;

interface LeftSidebarStoryShellProps {
  setup: () => APIClient;
  leftSidebarProps?: LeftSidebarStoryOverrides;
}

interface LeftSidebarStoryOverrides {
  collapsed?: boolean;
  widthPx?: number;
  isResizing?: boolean;
  onStartResize?: (e: React.MouseEvent) => void;
  onToggleCollapsed?: () => void;
}

// Vite re-evaluates this module on story edits; use a fresh token so the shell
// can deterministically remount provider state after each hot update.
const MODULE_RENDER_TOKEN = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function LeftSidebarStoryScene(props: { leftSidebarProps?: LeftSidebarStoryOverrides }) {
  const { userProjects } = useProjectContext();
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceRecency = useWorkspaceRecency();
  const sortedWorkspacesByProject = buildSortedWorkspacesByProject(
    userProjects,
    workspaceMetadata,
    workspaceRecency
  );
  const collapsed = props.leftSidebarProps?.collapsed ?? false;
  const widthPx = props.leftSidebarProps?.widthPx ?? 320;
  const isResizing = props.leftSidebarProps?.isResizing;
  const onStartResize = props.leftSidebarProps?.onStartResize;
  const onToggleCollapsed = props.leftSidebarProps?.onToggleCollapsed ?? (() => undefined);

  return (
    <div className="h-screen w-[320px] overflow-hidden">
      <LeftSidebar
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        widthPx={widthPx}
        isResizing={isResizing}
        onStartResize={onStartResize}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={workspaceRecency}
      />
    </div>
  );
}

function resetStorybookPersistedStateForStory(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));
    // FlatListWhenAgeGroupingDisabled writes this key; clear it so later
    // stories are not affected by story execution order.
    localStorage.removeItem(SIDEBAR_AGE_GROUPING_KEY);
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

function LeftSidebarStoryShell(props: LeftSidebarStoryShellProps) {
  const lastRenderKeyRef = useRef<string | null>(null);
  const lastModuleTokenRef = useRef<string | null>(null);
  const lastSetupRef = useRef<LeftSidebarStoryShellProps["setup"] | null>(null);
  const remountEpochRef = useRef(0);
  const clientRef = useRef<APIClient | null>(null);

  const renderKey = getStorybookRenderKey();
  // Storybook Fast Refresh preserves refs, so edits to a story's setup function
  // can otherwise keep showing stale mocked data until a full restart.
  const moduleChanged = lastModuleTokenRef.current !== MODULE_RENDER_TOKEN;
  const setupChanged = lastSetupRef.current !== props.setup;
  const shouldReset =
    clientRef.current === null ||
    lastRenderKeyRef.current !== renderKey ||
    moduleChanged ||
    setupChanged;
  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastRenderKeyRef.current = renderKey;
    lastModuleTokenRef.current = MODULE_RENDER_TOKEN;
    lastSetupRef.current = props.setup;
    remountEpochRef.current += 1;
    clientRef.current = null;
  }

  clientRef.current ??= props.setup();
  const providerTreeKey = `${renderKey ?? "left-sidebar"}:${MODULE_RENDER_TOKEN}:${remountEpochRef.current}`;

  return (
    <ThemeProvider key={providerTreeKey}>
      <APIProvider client={clientRef.current}>
        <PolicyProvider>
          <RouterProvider>
            <ExperimentsProvider>
              <TooltipProvider delayDuration={200}>
                <SettingsProvider>
                  <AboutDialogProvider>
                    <ConfirmDialogProvider>
                      <ProjectProvider>
                        <WorkspaceProvider>
                          <LeftSidebarStoryScene leftSidebarProps={props.leftSidebarProps} />
                        </WorkspaceProvider>
                      </ProjectProvider>
                    </ConfirmDialogProvider>
                  </AboutDialogProvider>
                </SettingsProvider>
              </TooltipProvider>
            </ExperimentsProvider>
          </RouterProvider>
        </PolicyProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

function createGitStatusExecutor(gitStatus?: Map<string, GitStatusFixture>) {
  const buildBranchDetailsOutput = (status: GitStatusFixture): string => {
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    const dirtyCount = status.dirty ?? 0;
    const headCommit = status.headCommit ?? "Latest commit";
    const originCommit = status.originCommit ?? "Latest commit";

    let hashIndex = 0;
    const nextHash = () => {
      hashIndex++;
      return hashIndex.toString(16).padStart(7, "0");
    };

    const commitHashes: string[] = [];

    const showBranchLines: string[] = [];
    showBranchLines.push(`! [HEAD] ${headCommit}`);
    showBranchLines.push(` ! [origin/main] ${originCommit}`);
    showBranchLines.push("--");

    for (let i = 0; i < ahead; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      showBranchLines.push(`+  [${hash}] Local commit ${i + 1}`);
    }

    for (let i = 0; i < behind; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      showBranchLines.push(` + [${hash}] Origin commit ${i + 1}`);
    }

    // Always include at least one shared commit so the tooltip has stable structure.
    const sharedHash = nextHash();
    commitHashes.push(sharedHash);
    showBranchLines.push(`++ [${sharedHash}] Shared commit`);

    const dates = commitHashes
      .map((hash, index) => `${hash}|Nov 14 0${(index % 9) + 1}:0${index % 6} PM`)
      .join("\n");

    const dirtyFiles =
      dirtyCount > 0
        ? [" M src/App.tsx", " M src/browser/components/GitStatusIndicatorView.tsx"].join("\n")
        : "";

    return [
      "__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__",
      showBranchLines.join("\n"),
      "__MUX_BRANCH_DATA__END_SHOW_BRANCH__",
      "__MUX_BRANCH_DATA__BEGIN_DATES__",
      dates,
      "__MUX_BRANCH_DATA__END_DATES__",
      "__MUX_BRANCH_DATA__BEGIN_DIRTY_FILES__",
      dirtyFiles,
      "__MUX_BRANCH_DATA__END_DIRTY_FILES__",
    ].join("\n");
  };

  return (workspaceId: string, script: string) => {
    const status = gitStatus?.get(workspaceId) ?? {};

    // useGitBranchDetails consolidated script (tooltip content)
    if (script.includes("__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__")) {
      const output = buildBranchDetailsOutput(status);
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // GitStatusStore consolidated status script
    if (script.includes("PRIMARY_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD")) {
      const output = createGitStatusOutput(status);
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    return Promise.resolve({
      success: true as const,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
    });
  };
}

/** Single project with multiple workspaces including SSH */
export const SingleProject: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
          createSSHWorkspace({
            id: "ws-2",
            name: "feature/auth",
            projectName: "my-app",
            host: "dev-server.example.com",
          }),
          createWorkspace({ id: "ws-3", name: "bugfix/memory-leak", projectName: "my-app" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Multiple projects showing sidebar organization */
export const MultipleProjects: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "frontend" }),
          createWorkspace({ id: "ws-2", name: "redesign", projectName: "frontend" }),
          createWorkspace({ id: "ws-3", name: "main", projectName: "backend" }),
          createWorkspace({ id: "ws-4", name: "api-v2", projectName: "backend" }),
          createSSHWorkspace({
            id: "ws-5",
            name: "db-migration",
            projectName: "backend",
            host: "staging.example.com",
          }),
          createWorkspace({ id: "ws-6", name: "main", projectName: "mobile" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Many workspaces testing sidebar scroll behavior */
export const ManyWorkspaces: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const names = [
          "main",
          "develop",
          "staging",
          "feature/authentication",
          "feature/dashboard",
          "feature/notifications",
          "feature/search",
          "bugfix/memory-leak",
          "bugfix/login-redirect",
          "refactor/components",
          "experiment/new-ui",
          "release/v1.2.0",
        ];

        const workspaces = names.map((name, i) =>
          createWorkspace({ id: `ws-${i}`, name, projectName: "big-app" })
        );

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Collapsed desktop sidebar rail */
export const CollapsedDesktop: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      leftSidebarProps={{ collapsed: true, widthPx: 320 }}
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-collapsed-1", name: "main", projectName: "my-app" }),
          createWorkspace({
            id: "ws-collapsed-2",
            name: "feature/collapsed-rail",
            projectName: "my-app",
          }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Desktop resize handle should render while sidebar is open */
export const ResizeHandleVisible: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      leftSidebarProps={{
        onStartResize: () => undefined,
      }}
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-resize-1", name: "main", projectName: "my-app" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const resizeHandle = canvasElement.querySelector(
        '[data-testid="left-sidebar-resize-handle"]'
      );
      if (!resizeHandle) {
        throw new Error("Expected left sidebar resize handle to be visible");
      }
    });
  },
};

/** Active resize state should use accent-colored resize handle */
export const ResizeHandleActive: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      leftSidebarProps={{
        isResizing: true,
        onStartResize: () => undefined,
      }}
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-resize-active-1", name: "main", projectName: "my-app" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Mobile open state should show overlay backdrop */
export const MobileOpenOverlay: AppStory = {
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: () => (
    <LeftSidebarStoryShell
      leftSidebarProps={{ collapsed: false }}
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-mobile-open-1", name: "main", projectName: "mobile-app" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Empty state with no projects/workspaces */
export const EmptySidebar: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() =>
        createMockORPCClient({
          projects: groupWorkspacesByProject([]),
          workspaces: [],
        })
      }
    />
  ),
};

/** Expanded project with no agents should show empty-state text */
export const ExpandedProjectNoAgents: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/empty-project";
        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: new Map([[projectPath, { workspaces: [] }]]),
          workspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      within(canvasElement).getByText("Empty");
    });
  },
};

/**
 * Best-of-n sub-agents are coalesced into a single expandable sidebar row.
 */
export const BestOfSubagents: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/best-of-demo";
        const parent = createWorkspace({
          id: "ws-parent",
          name: "main",
          title: "Main workspace",
          projectName: "best-of-demo",
          projectPath,
        });
        const bestOfBase = { groupId: "best-of-story", index: 0, total: 4 } as const;
        const workspaces = [
          parent,
          createWorkspace({
            id: "ws-best-of-1",
            name: "best-of-1",
            title: "Compare sidebar grouping approaches",
            projectName: "best-of-demo",
            projectPath,
            bestOf: bestOfBase,
          }),
          createWorkspace({
            id: "ws-best-of-2",
            name: "best-of-2",
            title: "Compare sidebar grouping approaches",
            projectName: "best-of-demo",
            projectPath,
            bestOf: { ...bestOfBase, index: 1 },
          }),
          createWorkspace({
            id: "ws-best-of-3",
            name: "best-of-3",
            title: "Compare sidebar grouping approaches",
            projectName: "best-of-demo",
            projectPath,
            bestOf: { ...bestOfBase, index: 2 },
          }),
          createWorkspace({
            id: "ws-best-of-4",
            name: "best-of-4",
            title: "Compare sidebar grouping approaches",
            projectName: "best-of-demo",
            projectPath,
            bestOf: { ...bestOfBase, index: 3 },
          }),
        ].map((workspace, index) =>
          index === 0
            ? workspace
            : {
                ...workspace,
                parentWorkspaceId: parent.id,
                taskStatus: index % 2 === 0 ? ("queued" as const) : ("running" as const),
              }
        );

        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const groupRow = canvasElement.querySelector('[data-testid="task-group-best-of-story"]');
      if (!groupRow) {
        throw new Error("Best-of sidebar group row not rendered");
      }
    });

    const groupRow = canvasElement.querySelector<HTMLElement>(
      '[data-testid="task-group-best-of-story"]'
    );
    if (!groupRow) {
      throw new Error("Best-of sidebar group row not found");
    }
    await userEvent.click(groupRow);

    await waitFor(() => {
      const member = canvasElement.querySelector('[data-workspace-id="ws-best-of-1"]');
      if (!member) {
        throw new Error("Expanded best-of member row not rendered");
      }
    });
  },
};

/**
 * Regression test: when active workspaces are older than 1 day, they still appear under the
 * "Older than 1 day" tier. Inactive persistent children remain out of the left sidebar.
 */
export const SingleOldWorkspaceInOlderTier: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/age-tier-demo";
        const oldCreatedAt = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
        const oldWorkspace = createWorkspace({
          id: "ws-old-only",
          name: "old-workspace",
          title: "Old workspace",
          projectName: "age-tier-demo",
          projectPath,
          createdAt: oldCreatedAt,
        });
        const activeSubAgent = {
          ...createWorkspace({
            id: "ws-old-active-subagent",
            name: "active-subagent",
            title: "Active sub-agent",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: oldCreatedAt,
          }),
          parentWorkspaceId: oldWorkspace.id,
          taskStatus: "running" as const,
        };
        const completedSubAgentOne = {
          ...createWorkspace({
            id: "ws-old-completed-subagent-1",
            name: "completed-subagent-1",
            title: "Completed sub-agent 1",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: oldCreatedAt,
          }),
          parentWorkspaceId: oldWorkspace.id,
          taskStatus: "reported" as const,
          reportedAt: oldCreatedAt,
        };
        const completedSubAgentTwo = {
          ...createWorkspace({
            id: "ws-old-completed-subagent-2",
            name: "completed-subagent-2",
            title: "Completed sub-agent 2",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: oldCreatedAt,
          }),
          parentWorkspaceId: oldWorkspace.id,
          taskStatus: "reported" as const,
          reportedAt: oldCreatedAt,
        };
        const workspaces = [
          oldWorkspace,
          activeSubAgent,
          completedSubAgentOne,
          completedSubAgentTwo,
        ];

        expandProjects([projectPath]);
        // Keep this regression deterministic even when Storybook reuses localStorage
        // across stories/runs and a prior interaction expanded an old-age tier.
        localStorage.setItem("expandedOldWorkspaces", JSON.stringify({}));
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const getTierToggle = () =>
      within(canvasElement).getByRole("button", {
        name: /workspaces older than 1 day/i,
      });

    await waitFor(() => {
      const tierToggle = getTierToggle();
      if (!tierToggle.textContent?.includes("(2)")) {
        throw new Error("Expected older-than-1-day tier count to include only active rows");
      }
    });

    // Storybook can reuse storage between stories/runs, so force a known collapsed
    // starting point before asserting that old rows are still hidden.
    if (getTierToggle().getAttribute("aria-expanded") === "true") {
      await userEvent.click(getTierToggle());
    }

    await waitFor(() => {
      const tierToggle = getTierToggle();
      if (tierToggle.getAttribute("aria-expanded") !== "false") {
        throw new Error("Expected older-than-1-day tier to be collapsed before expansion");
      }
    });

    for (const workspaceId of ["ws-old-only", "ws-old-active-subagent"]) {
      if (canvasElement.querySelector(`[data-workspace-id="${workspaceId}"]`)) {
        throw new Error(`Workspace ${workspaceId} rendered before expanding old tier`);
      }
    }

    await userEvent.click(getTierToggle());

    await waitFor(() => {
      for (const workspaceId of ["ws-old-only", "ws-old-active-subagent"]) {
        const row = canvasElement.querySelector<HTMLElement>(
          `[data-workspace-id="${workspaceId}"]`
        );
        if (!row) {
          throw new Error(`Workspace ${workspaceId} did not appear after expanding old tier`);
        }
      }
    });
    for (const workspaceId of ["ws-old-completed-subagent-1", "ws-old-completed-subagent-2"]) {
      if (canvasElement.querySelector(`[data-workspace-id="${workspaceId}"]`)) {
        throw new Error(`Inactive workspace ${workspaceId} should stay out of the left sidebar`);
      }
    }
  },
};

/**
 * Regression variant: the parent and active child are less than 1 day old, so they render in the
 * recent section while inactive persistent children remain available only in the transcript.
 */
export const SingleRecentWorkspaceInTopTier: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/age-tier-demo";
        const recentCreatedAt = new Date(NOW - 6 * 60 * 60 * 1000).toISOString();
        const recentWorkspace = createWorkspace({
          id: "ws-recent-only",
          name: "recent-workspace",
          title: "Recent workspace",
          projectName: "age-tier-demo",
          projectPath,
          createdAt: recentCreatedAt,
        });
        const activeSubAgent = {
          ...createWorkspace({
            id: "ws-recent-active-subagent",
            name: "active-subagent",
            title: "Active sub-agent",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: recentCreatedAt,
          }),
          parentWorkspaceId: recentWorkspace.id,
          taskStatus: "running" as const,
        };
        const completedSubAgentOne = {
          ...createWorkspace({
            id: "ws-recent-completed-subagent-1",
            name: "completed-subagent-1",
            title: "Completed sub-agent 1",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: recentCreatedAt,
          }),
          parentWorkspaceId: recentWorkspace.id,
          taskStatus: "reported" as const,
          reportedAt: recentCreatedAt,
        };
        const completedSubAgentTwo = {
          ...createWorkspace({
            id: "ws-recent-completed-subagent-2",
            name: "completed-subagent-2",
            title: "Completed sub-agent 2",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: recentCreatedAt,
          }),
          parentWorkspaceId: recentWorkspace.id,
          taskStatus: "reported" as const,
          reportedAt: recentCreatedAt,
        };
        const workspaces = [
          recentWorkspace,
          activeSubAgent,
          completedSubAgentOne,
          completedSubAgentTwo,
        ];

        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const tierToggle = within(canvasElement).queryByRole("button", {
        name: /workspaces older than 1 day/i,
      });
      if (tierToggle) {
        throw new Error("Did not expect an older-than-1-day tier for a recent parent workspace");
      }
    });

    await waitFor(() => {
      for (const workspaceId of ["ws-recent-only", "ws-recent-active-subagent"]) {
        const row = canvasElement.querySelector<HTMLElement>(
          `[data-workspace-id="${workspaceId}"]`
        );
        if (!row) {
          throw new Error(`Workspace ${workspaceId} did not render in the recent tier`);
        }
      }
    });
    for (const workspaceId of [
      "ws-recent-completed-subagent-1",
      "ws-recent-completed-subagent-2",
    ]) {
      if (canvasElement.querySelector(`[data-workspace-id="${workspaceId}"]`)) {
        throw new Error(`Inactive workspace ${workspaceId} should stay out of the left sidebar`);
      }
    }
  },
};

/**
 * With sidebar age grouping disabled (Settings toggle), workspaces older than
 * the first tier threshold render inline as one flat recency-sorted list:
 * no "Older than X" toggle and no expansion needed to see old rows.
 */
export const FlatListWhenAgeGroupingDisabled: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/age-tier-demo";
        const oldCreatedAt = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
        const oldWorkspace = createWorkspace({
          id: "ws-flat-old",
          name: "old-workspace",
          title: "Old workspace",
          projectName: "age-tier-demo",
          projectPath,
          createdAt: oldCreatedAt,
        });
        const activeSubAgent = {
          ...createWorkspace({
            id: "ws-flat-old-active-subagent",
            name: "active-subagent",
            title: "Active sub-agent",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: oldCreatedAt,
          }),
          parentWorkspaceId: oldWorkspace.id,
          taskStatus: "running" as const,
        };
        const completedSubAgent = {
          ...createWorkspace({
            id: "ws-flat-old-completed-subagent",
            name: "completed-subagent",
            title: "Completed sub-agent",
            projectName: "age-tier-demo",
            projectPath,
            createdAt: oldCreatedAt,
          }),
          parentWorkspaceId: oldWorkspace.id,
          taskStatus: "reported" as const,
          reportedAt: oldCreatedAt,
        };
        const workspaces = [oldWorkspace, activeSubAgent, completedSubAgent];

        expandProjects([projectPath]);
        updatePersistedState(SIDEBAR_AGE_GROUPING_KEY, false);
        // Grouping is off, so no tier should need expansion for rows to show.
        localStorage.setItem("expandedOldWorkspaces", JSON.stringify({}));
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      for (const workspaceId of ["ws-flat-old", "ws-flat-old-active-subagent"]) {
        const row = canvasElement.querySelector<HTMLElement>(
          `[data-workspace-id="${workspaceId}"]`
        );
        if (!row) {
          throw new Error(`Workspace ${workspaceId} did not render inline with grouping off`);
        }
      }
    });

    if (canvasElement.querySelector('[data-workspace-id="ws-flat-old-completed-subagent"]')) {
      throw new Error("Inactive sub-agent should stay out of the flat left-sidebar list");
    }

    const tierToggle = within(canvasElement).queryByRole("button", {
      name: /workspaces older than/i,
    });
    if (tierToggle) {
      throw new Error("Did not expect an age-tier toggle when grouping is disabled");
    }
  },
};

/** Long workspace names - tests truncation and prevents horizontal scroll regression */
export const LongWorkspaceNames: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-short",
            name: "main",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-medium",
            name: "feature/user-authentication",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-long",
            name: "feature/implement-oauth2-authentication-with-google-provider",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-very-long",
            name: "bugfix/fix-critical-memory-leak-in-websocket-connection-handler-that-causes-oom",
            projectName: "my-app",
          }),
          createSSHWorkspace({
            id: "ws-ssh-long",
            name: "deploy/production-kubernetes-cluster-rolling-update-with-zero-downtime",
            projectName: "my-app",
            host: "very-long-hostname.internal.company-infrastructure.example.com",
          }),
        ];

        // Set up git status to verify GitStatusIndicator remains visible
        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-short", { ahead: 1 }],
          ["ws-medium", { dirty: 3 }],
          ["ws-long", { ahead: 2, behind: 1 }],
          ["ws-very-long", { dirty: 5, ahead: 3 }],
          ["ws-ssh-long", { behind: 2 }],
        ]);

        expandProjects(["/home/user/projects/my-app"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          executeBash: createGitStatusExecutor(gitStatus),
        });
      }}
    />
  ),
};

/**
 * Sidebar rows should not render git status indicators.
 * This story seeds diverse git states to ensure rows remain visually stable
 * even when workspace git data changes.
 */
export const GitStatusVariations: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-clean",
            name: "main",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          createWorkspace({
            id: "ws-ahead",
            name: "feature/new-ui",
            projectName: "my-app",
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          createWorkspace({
            id: "ws-behind",
            name: "feature/api",
            projectName: "my-app",
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
          createWorkspace({
            id: "ws-dirty",
            name: "bugfix/crash",
            projectName: "my-app",
            createdAt: new Date(NOW - 14400000).toISOString(),
          }),
          createWorkspace({
            id: "ws-diverged",
            name: "refactor/db",
            projectName: "my-app",
            createdAt: new Date(NOW - 18000000).toISOString(),
          }),
          createSSHWorkspace({
            id: "ws-ssh",
            name: "deploy/prod",
            projectName: "my-app",
            host: "prod.example.com",
            createdAt: new Date(NOW - 21600000).toISOString(),
          }),
        ];

        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-clean", {}],
          [
            "ws-ahead",
            {
              ahead: 2,
              outgoingAdditions: 150,
              outgoingDeletions: 30,
              headCommit: "Add new dashboard",
            },
          ],
          ["ws-behind", { behind: 5, originCommit: "Latest API changes" }],
          ["ws-dirty", { dirty: 7, outgoingAdditions: 42, outgoingDeletions: 8 }],
          [
            "ws-diverged",
            { ahead: 3, behind: 2, dirty: 5, outgoingAdditions: 12313, outgoingDeletions: 1231 },
          ],
          ["ws-ssh", { ahead: 1, outgoingAdditions: 25 }],
        ]);

        expandProjects(["/home/user/projects/my-app"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          executeBash: createGitStatusExecutor(gitStatus),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]');
      if (!row) throw new Error("ws-diverged row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]')!;

    // Select the diverged workspace, then assert the sidebar row itself never
    // renders the git divergence control in this left-sidebar-only story shell.
    await userEvent.click(row);

    if (within(row).queryByLabelText("View git divergence details") !== null) {
      throw new Error("Sidebar rows should not render git divergence indicators");
    }
  },
};

/**
 * All runtime badge variations showing different runtime types.
 * Each type has distinct colors:
 * - SSH: blue theme
 * - Worktree: purple theme
 * - Local: gray theme
 *
 * The streaming workspaces show the "working" state with pulse animation.
 */
export const RuntimeBadgeVariations: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        // Idle workspaces (one of each type)
        const sshIdle = createSSHWorkspace({
          id: "ws-ssh-idle",
          name: "ssh-idle",
          projectName: "runtime-demo",
          host: "dev.example.com",
          createdAt: new Date(NOW - 3600000).toISOString(),
        });
        const worktreeIdle = createWorkspace({
          id: "ws-worktree-idle",
          name: "worktree-idle",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 7200000).toISOString(),
        });
        const localIdle = createLocalWorkspace({
          id: "ws-local-idle",
          name: "local-idle",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 10800000).toISOString(),
        });

        // Working workspaces (streaming - shows pulse animation)
        const sshWorking = createSSHWorkspace({
          id: "ws-ssh-working",
          name: "ssh-working",
          projectName: "runtime-demo",
          host: "prod.example.com",
          createdAt: new Date(NOW - 1800000).toISOString(),
        });
        const worktreeWorking = createWorkspace({
          id: "ws-worktree-working",
          name: "worktree-working",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 900000).toISOString(),
        });
        const localWorking = createLocalWorkspace({
          id: "ws-local-working",
          name: "local-working",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 300000).toISOString(),
        });

        const workspaces = [
          sshIdle,
          worktreeIdle,
          localIdle,
          sshWorking,
          worktreeWorking,
          localWorking,
        ];

        // Create streaming handlers for working workspaces
        const workingMessage = createUserMessage("msg-1", "Working on task...", {
          historySequence: 1,
          timestamp: STABLE_TIMESTAMP,
        });

        const chatHandlers = new Map<string, ChatHandler>([
          [
            "ws-ssh-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-ssh",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing SSH task...",
            }),
          ],
          [
            "ws-worktree-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-worktree",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing worktree task...",
            }),
          ],
          [
            "ws-local-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-local",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing local task...",
            }),
          ],
        ]);

        // Expand the project so badges are visible
        expandProjects(["/home/user/projects/runtime-demo"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
        });
      }}
    />
  ),
};

/**
 * Workspace title hover behavior.
 * Verifies that hovering a workspace title no longer opens a preview card.
 */
export const WorkspaceTitleHoverCard: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const sshWorkspace = createSSHWorkspace({
          id: "ws-ssh-hover",
          name: "feature-branch",
          title: "Implement new feature with detailed description",
          projectName: "hover-demo",
          host: "dev.example.com",
          createdAt: new Date(NOW - 3600000).toISOString(),
        });

        expandProjects(["/home/user/projects/hover-demo"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject([sshWorkspace]),
          workspaces: [sshWorkspace],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    // Wait for the workspace row to appear
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-ssh-hover"]');
      if (!row) throw new Error("ws-ssh-hover row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-ssh-hover"]')!;

    // Hovering titles should no longer open a workspace preview card.
    const titleSpan = within(row).getByText("Implement new feature with detailed description");
    await userEvent.hover(titleSpan);

    // Wait past the prior HoverCard openDelay window to prove no delayed preview appears.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const hoverCard = document.body.querySelector<HTMLElement>(
      "[data-radix-popper-content-wrapper] .bg-modal-bg"
    );
    if (hoverCard) {
      throw new Error("Workspace title hover preview should not be visible");
    }
  },
};

/**
 * Draft workspaces (UI-only placeholders) in the sidebar.
 * Shows drafts with various states: empty title, named, with prompt preview.
 * Drafts are visually differentiated with italic text and dashed selection bar.
 */
export const WorkspaceDrafts: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/draft-demo";

        // Create one regular workspace to show alongside drafts
        const regularWorkspace = createWorkspace({
          id: "ws-regular",
          name: "existing-feature",
          title: "Existing feature branch",
          projectName: "draft-demo",
          projectPath,
          createdAt: new Date(NOW - 86400000).toISOString(),
        });

        // Set up workspace drafts (UI-only placeholders)
        setWorkspaceDrafts(projectPath, [
          {
            draftId: "draft-1",
            workspaceName: "New API endpoint",
            prompt: "Implement a new REST API endpoint for user authentication",
            createdAt: NOW - 1000,
          },
          {
            draftId: "draft-2",
            // No name - will show "Draft"
            prompt: "Fix the bug where the sidebar flickers on hover",
            createdAt: NOW - 2000,
          },
          {
            draftId: "draft-3",
            workspaceName: "Performance optimization",
            // No prompt - just title
            createdAt: NOW - 3000,
          },
        ]);

        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject([regularWorkspace]),
          workspaces: [regularWorkspace],
        });
      }}
    />
  ),
};

/**
 * Draft workspace selected state.
 * Shows the dashed selection indicator that differentiates drafts from regular workspaces.
 * Uses play function to click on a draft and select it.
 */
export const WorkspaceDraftSelected: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/draft-selected";

        const regularWorkspace = createWorkspace({
          id: "ws-regular-2",
          name: "main-branch",
          title: "Main development branch",
          projectName: "draft-selected",
          projectPath,
          createdAt: new Date(NOW - 86400000).toISOString(),
        });

        setWorkspaceDrafts(projectPath, [
          {
            draftId: "selected-draft",
            workspaceName: "My new workspace",
            prompt: "Build a feature that does something amazing",
            createdAt: NOW,
          },
        ]);

        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject([regularWorkspace]),
          workspaces: [regularWorkspace],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    // Wait for the draft row to appear
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-draft-id="selected-draft"]');
      if (!row) throw new Error("selected-draft row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-draft-id="selected-draft"]')!;
    await userEvent.click(row);
  },
};

export const MixedAgentStatesAndAges: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/sidebar-state-mix";
        const projectName = "sidebar-state-mix";
        const activeCreatedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
        const idleUnreadCreatedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
        const errorCreatedAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
        const olderThanOneDayCreatedAt = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
        const olderThanSevenDaysCreatedAt = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();

        const activeWorkspace = createWorkspace({
          id: "ws-mixed-active",
          name: "active-agent",
          title: "Active agent",
          projectName,
          projectPath,
          createdAt: activeCreatedAt,
        });
        const idleUnreadWorkspace = createWorkspace({
          id: "ws-mixed-idle-unread",
          name: "idle-unread-agent",
          title: "Idle unread agent",
          projectName,
          projectPath,
          createdAt: idleUnreadCreatedAt,
        });
        const errorWorkspace = createWorkspace({
          id: "ws-mixed-error",
          name: "error-agent",
          title: "Error agent",
          projectName,
          projectPath,
          createdAt: errorCreatedAt,
        });
        const olderThanOneDayWorkspace = createWorkspace({
          id: "ws-mixed-older-than-1-day",
          name: "older-than-1-day-agent",
          title: "Older than 1 day agent",
          projectName,
          projectPath,
          createdAt: olderThanOneDayCreatedAt,
        });
        const olderThanSevenDaysWorkspace = createWorkspace({
          id: "ws-mixed-older-than-7-days",
          name: "older-than-7-days-agent",
          title: "Older than 7 days agent",
          projectName,
          projectPath,
          createdAt: olderThanSevenDaysCreatedAt,
        });
        const parentWithActiveSubagentsWorkspace = {
          ...createWorkspace({
            id: "ws-mixed-parent-with-active-subagents",
            name: "parent-with-active-subagents",
            title: "Parent with active subagents",
            projectName,
            projectPath,
            createdAt: activeCreatedAt,
          }),
          isInitializing: true,
          taskStatus: "running" as const,
        };
        const activeSubagentOne = {
          ...createWorkspace({
            id: "ws-mixed-active-subagent-1",
            name: "active-subagent-1",
            title: "Active subagent 1",
            projectName,
            projectPath,
            createdAt: activeCreatedAt,
          }),
          parentWorkspaceId: parentWithActiveSubagentsWorkspace.id,
          taskStatus: "running" as const,
        };
        const activeSubagentTwo = {
          ...createWorkspace({
            id: "ws-mixed-active-subagent-2",
            name: "active-subagent-2",
            title: "Active subagent 2",
            projectName,
            projectPath,
            createdAt: activeCreatedAt,
          }),
          parentWorkspaceId: parentWithActiveSubagentsWorkspace.id,
          taskStatus: "running" as const,
        };
        const activeSubagentThree = {
          ...createWorkspace({
            id: "ws-mixed-active-subagent-3",
            name: "active-subagent-3",
            title: "Active subagent 3",
            projectName,
            projectPath,
            createdAt: activeCreatedAt,
          }),
          parentWorkspaceId: parentWithActiveSubagentsWorkspace.id,
          taskStatus: "running" as const,
        };
        const workspaces = [
          activeWorkspace,
          idleUnreadWorkspace,
          errorWorkspace,
          parentWithActiveSubagentsWorkspace,
          activeSubagentOne,
          activeSubagentTwo,
          activeSubagentThree,
          olderThanOneDayWorkspace,
          olderThanSevenDaysWorkspace,
        ];

        setWorkspaceDrafts(projectPath, [
          {
            draftId: "draft-mixed-1",
            workspaceName: "Draft agent",
            prompt: "Draft prompt preview",
            createdAt: NOW - 1_000,
          },
        ]);

        // Ensure the unread indicator appears for the idle workspace.
        updatePersistedState(
          getWorkspaceLastReadKey(idleUnreadWorkspace.id),
          Date.parse(idleUnreadCreatedAt) - 60_000
        );

        // Expand age tiers so older-than-1-day and older-than-7-days rows are visible.
        updatePersistedState("expandedOldWorkspaces", {
          [`${projectPath}:0`]: true,
          [`${projectPath}:1`]: true,
        });

        const chatHandlers = new Map<string, ChatHandler>([
          [
            activeWorkspace.id,
            (emit) => {
              emit({ type: "caught-up", hasOlderHistory: false });
              emit({
                type: "stream-start",
                workspaceId: activeWorkspace.id,
                messageId: "mixed-active-stream",
                model: "mock-model",
                historySequence: 1_000,
                startTime: NOW,
              });
              return () => undefined;
            },
          ],
          [
            parentWithActiveSubagentsWorkspace.id,
            (emit) => {
              emit({ type: "caught-up", hasOlderHistory: false });
              emit({
                type: "stream-start",
                workspaceId: parentWithActiveSubagentsWorkspace.id,
                messageId: "mixed-parent-with-active-subagents-stream",
                model: "mock-model",
                historySequence: 1_001,
                startTime: NOW,
              });
              return () => undefined;
            },
          ],
          [
            errorWorkspace.id,
            (emit) => {
              emit({ type: "caught-up", hasOlderHistory: false });
              emit({
                type: "stream-start",
                workspaceId: errorWorkspace.id,
                messageId: "mixed-error-stream",
                model: "mock-model",
                historySequence: 1_002,
                startTime: NOW,
              });
              emit({
                type: "stream-abort",
                workspaceId: errorWorkspace.id,
                messageId: "mixed-error-stream",
                abortReason: "system",
              });
              return () => undefined;
            },
          ],
        ]);

        expandProjects([projectPath]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          workspaceActivitySnapshots: {
            [parentWithActiveSubagentsWorkspace.id]: {
              recency: NOW,
              streaming: true,
              lastModel: "mock-model",
              lastThinkingLevel: null,
            },
          },
        });
      }}
    />
  ),
};

/**
 * Archiving workspace alignment regression test.
 *
 * When a workspace enters the "archiving" transient state, the overflow menu
 * button is hidden. Without a spacer, the title shifts ~24px to the left.
 * This story triggers archive on one workspace so the "Archiving..." row
 * stays visible (the mock archive call never resolves).
 */
export const ArchivingWorkspaceAlignment: AppStory = {
  render: () => (
    <LeftSidebarStoryShell
      setup={() => {
        const projectPath = "/home/user/projects/my-app";
        const workspaces = [
          createWorkspace({
            id: "ws-active-1",
            name: "main",
            title: "Main development branch",
            projectName: "my-app",
            projectPath,
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          createWorkspace({
            id: "ws-to-archive",
            name: "feature/old-experiment",
            title: "Old experiment workspace",
            projectName: "my-app",
            projectPath,
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          createWorkspace({
            id: "ws-active-2",
            name: "bugfix/login",
            title: "Fix login redirect",
            projectName: "my-app",
            projectPath,
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
        ];

        expandProjects([projectPath]);

        const client = createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });

        // Make archive hang forever so the workspace stays in "Archiving..." state
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        client.workspace.archive = () => new Promise(() => {});

        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    // Wait for the target workspace row to appear
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-to-archive"]');
      if (!row) throw new Error("ws-to-archive row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-to-archive"]')!;

    // Hover to reveal the overflow (ellipsis) button
    await userEvent.hover(row);

    // Click the overflow menu button
    const menuButton = within(row).getByLabelText("Workspace actions for Old experiment workspace");
    await userEvent.click(menuButton);

    // Wait for the popover to open, then click "Archive chat"
    await waitFor(() => {
      const archiveButton = document.body.querySelector<HTMLElement>(
        "[data-radix-popper-content-wrapper] button"
      );
      if (!archiveButton) throw new Error("popover not open yet");
    });

    // Find and click the Archive chat button in the popover
    const popoverContent = document.body.querySelector<HTMLElement>(
      "[data-radix-popper-content-wrapper]"
    )!;
    const archiveButton = within(popoverContent).getByText("Archive chat").closest("button")!;
    await userEvent.click(archiveButton);

    // Wait for the "Archiving..." text to appear (confirms the transient state is active)
    await waitFor(() => {
      within(canvasElement).getByText("Archiving...");
    });
  },
};
