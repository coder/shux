import { fireEvent, userEvent, waitFor } from "@storybook/test";
import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  clearWorkspaceSelection,
  collapseRightSidebar,
  expandProjects,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { LEFT_SIDEBAR_COLLAPSED_KEY, SIDEBAR_FLAT_MODE_KEY } from "@/common/constants/storage";

const PROJECT_PATH = "/home/user/projects/my-app";

const meta = {
  ...appMeta,
  title: "Components/ProjectSidebar",
};

export default meta;

// Integration: story renders full app to test project removal confirmation flow via sidebar context menu.
export const ProjectRemovalDisabled: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
          createWorkspace({ id: "ws-2", name: "feature/auth", projectName: "my-app" }),
        ];
        expandProjects(["/home/user/projects/my-app"]);
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const projectOptionsButton = await waitFor(() => {
      const button = canvasElement.querySelector<HTMLButtonElement>(
        'button[aria-label="Project options for my-app"]'
      );
      if (!button) throw new Error("Project options button not found");
      return button;
    });

    // Action buttons are hidden (pointer-events: none) until row hover.
    // CSS :hover can't be triggered by testing-library's userEvent.hover(),
    // so use fireEvent.click which bypasses the pointer-events check.
    await fireEvent.click(projectOptionsButton);

    await waitFor(() => {
      const menuIsVisible = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Delete..."
      );
      if (!menuIsVisible) throw new Error("Project options menu did not open");
    });

    const deleteMenuItem = await waitFor(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === "Delete..."
      );
      if (!button) throw new Error("Delete menu item not found");
      return button;
    });

    await userEvent.click(deleteMenuItem);

    await waitFor(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) throw new Error("Confirmation modal not found");
        if (!dialog.textContent?.includes("my-app")) {
          throw new Error("Modal should reference the project name");
        }
      },
      { timeout: 2000 }
    );
  },
};

// A best-of group nested inside a sub-agent tree must keep continuous connector rails
// through the group header, and expanded members render as candidate rows.
export const NestedTaskGroupConnectors: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectName = "my-app";
        const workspaces = [
          createWorkspace({
            id: "ws-parent",
            name: "feature/orchestrator",
            projectName,
            title: "Orchestrate feature work",
          }),
          createWorkspace({
            id: "sub-backend",
            name: "task/backend",
            projectName,
            title: "Implement backend",
            parentWorkspaceId: "ws-parent",
            taskStatus: "running",
          }),
          createWorkspace({
            id: "candidate-a",
            name: "task/candidate-a",
            projectName,
            title: "Compare designs",
            parentWorkspaceId: "sub-backend",
            taskStatus: "running",
            bestOf: { groupId: "best-of-1", index: 0, total: 2 },
          }),
          createWorkspace({
            id: "candidate-b",
            name: "task/candidate-b",
            projectName,
            title: "Compare designs",
            parentWorkspaceId: "sub-backend",
            taskStatus: "queued",
            bestOf: { groupId: "best-of-1", index: 1, total: 2 },
          }),
          // Lower sibling: the parent trunk must continue through the group header.
          createWorkspace({
            id: "sub-docs",
            name: "task/docs",
            projectName,
            title: "Write docs",
            parentWorkspaceId: "ws-parent",
            taskStatus: "running",
          }),
        ];
        expandProjects([PROJECT_PATH]);
        localStorage.setItem(
          "expandedTaskGroups",
          JSON.stringify({ "task:sub-backend:best-of-1": true })
        );
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      if (!canvasElement.querySelector('[data-testid="task-group-best-of-1"]')) {
        throw new Error("Best-of group header not found");
      }
    });
  },
};

// Best-of group rendering contract: collapsed header reads "Best of 3 · <title>";
// expanded members drop the repeated title and render as "Candidate A/B/C".
export const BestOfGroup: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectName = "my-app";
        const candidate = (index: number, taskStatus: "running" | "queued") =>
          createWorkspace({
            id: `cand-${index}`,
            name: `task/cand-${index}`,
            projectName,
            title: "Compare implementation options",
            parentWorkspaceId: "ws-parent",
            taskStatus,
            bestOf: { groupId: "bo-1", index, total: 3 },
          });
        const workspaces = [
          createWorkspace({
            id: "ws-parent",
            name: "feature/compare",
            projectName,
            title: "Pick the best approach",
          }),
          candidate(0, "running"),
          candidate(1, "running"),
          candidate(2, "queued"),
        ];
        expandProjects([PROJECT_PATH]);
        localStorage.setItem("expandedTaskGroups", JSON.stringify({ "task:ws-parent:bo-1": true }));
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      if (!canvasElement.querySelector('[data-testid="task-group-bo-1"]')) {
        throw new Error("Best-of group header not found");
      }
      if (!canvasElement.querySelector('[aria-label="Select workspace Candidate A"]')) {
        throw new Error("Expected label-only candidate rows");
      }
    });
  },
};

// Phase 2 visual contract: two concurrent workflow runs form separate collapsible
// groups (one with a stamped name, one falling back to the run id), active runs
// default to expanded, and a variants group coexists under the same workspace.
export const WorkflowRunGroups: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectName = "my-app";
        const reviewRun = (
          id: string,
          stepId: string,
          opts: Partial<Parameters<typeof createWorkspace>[0]>
        ) =>
          createWorkspace({
            id,
            name: `task/${id}`,
            projectName,
            parentWorkspaceId: "ws-main",
            workflowTask: { runId: "wfr_review1234", stepId, workflowName: "review-pipeline" },
            ...opts,
          } as Parameters<typeof createWorkspace>[0]);
        const workspaces = [
          createWorkspace({
            id: "ws-main",
            name: "feature/payments",
            projectName,
            title: "Payments integration",
          }),
          reviewRun("wf-claims", "claims", {
            title: "Extract claims",
            taskStatus: "reported",
            createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "wf-tests",
            name: "task/wf-tests",
            projectName,
            title: "Run test matrix",
            parentWorkspaceId: "ws-main",
            taskStatus: "running",
            createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
            workflowTask: { runId: "wfr_legacy567890", stepId: "tests" },
          }),
          reviewRun("wf-verify", "verify", {
            title: "Verify claims",
            taskStatus: "running",
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "candidate-review-a",
            name: "task/candidate-review-a",
            projectName,
            title: "Compare reviews",
            parentWorkspaceId: "ws-main",
            taskStatus: "queued",
            bestOf: { groupId: "best-of-2", index: 0, total: 2 },
          }),
          createWorkspace({
            id: "candidate-review-b",
            name: "task/candidate-review-b",
            projectName,
            title: "Compare reviews",
            parentWorkspaceId: "ws-main",
            taskStatus: "queued",
            bestOf: { groupId: "best-of-2", index: 1, total: 2 },
          }),
        ];
        expandProjects([PROJECT_PATH]);
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      const named = canvasElement.querySelector('[data-testid="task-group-wfr_review1234"]');
      const fallback = canvasElement.querySelector('[data-testid="task-group-wfr_legacy567890"]');
      if (!named || !fallback) {
        throw new Error("Expected two workflow run group headers");
      }
      if (canvasElement.querySelector('[aria-label="Select workspace Extract claims"]')) {
        throw new Error("Expected completed workflow members to stay out of the left sidebar");
      }
      if (!canvasElement.querySelector('[aria-label="Select workspace Verify claims"]')) {
        throw new Error("Expected the active workflow member to remain visible");
      }
    });
  },
};

export const FlatChatList: AppStory = {
  // The flat list replaces the whole sidebar layout, so validate the compact
  // badge/truncation behavior at the phone width alongside the laptop capture.
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] } },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        updatePersistedState(SIDEBAR_FLAT_MODE_KEY, true);
        // Keep the sidebar visible at the phone width: no selected workspace
        // (mobile shows the chat over the sidebar) and the sidebar expanded.
        clearWorkspaceSelection();
        collapseRightSidebar();
        updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
        const workspaces = [
          createWorkspace({
            id: "alpha-pinned",
            name: "alpha-pinned",
            title: "Pinned from a long project name",
            projectName: "alpha-application-with-a-long-name",
            pinnedAt: "2026-01-02T00:00:00.000Z",
          }),
          createWorkspace({
            id: "beta-pinned",
            name: "beta-pinned",
            title: "Pinned beta chat",
            projectName: "beta-service",
            pinnedAt: "2026-01-01T00:00:00.000Z",
          }),
          createWorkspace({
            id: "alpha-recent",
            name: "alpha-recent",
            title: "Recent alpha work",
            projectName: "alpha-application-with-a-long-name",
          }),
          {
            ...createWorkspace({
              id: "scratch-flat",
              name: "scratch-flat",
              title: "Scratch idea",
              projectName: "Scratch",
              projectPath: "/home/user/.xum/scratch/scratch-flat",
            }),
            kind: "scratch" as const,
          },
        ];
        const projects = groupWorkspacesByProject(workspaces);
        const alphaPath = "/home/user/projects/alpha-application-with-a-long-name";
        const betaPath = "/home/user/projects/beta-service";
        const alphaConfig = projects.get(alphaPath);
        const betaConfig = projects.get(betaPath);
        if (alphaConfig) projects.set(alphaPath, { ...alphaConfig, color: "Blue" });
        if (betaConfig) projects.set(betaPath, { ...betaConfig, color: "Green" });
        return createMockORPCClient({ projects, workspaces });
      }}
    />
  ),
  // Contract: the flat list (badges) and the project management headers are
  // actually on screen, so a viewport variant cannot silently snapshot the
  // wrong UI (e.g. the sidebar hidden behind a selected chat on mobile).
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      if (!canvasElement.querySelector('[data-testid="workspace-project-badge-alpha-pinned"]')) {
        throw new Error("Expected a project badge on a flat-list chat row");
      }
      if (
        !canvasElement.querySelector(
          'button[aria-label="Project options for alpha-application-with-a-long-name"]'
        )
      ) {
        throw new Error("Expected project management headers below the flat list");
      }
    });
  },
};
// Pinned chats sort by pinnedAt (user-reorderable), not by name or recency:
// the pinned block deliberately renders as charlie, alpha, bravo while the
// newest unpinned chat stays below the block.
export const PinnedChatsCustomOrder: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-alpha",
            name: "alpha",
            projectName: "my-app",
            pinnedAt: "2026-01-01T00:00:01.000Z",
          }),
          createWorkspace({
            id: "ws-bravo",
            name: "bravo",
            projectName: "my-app",
            pinnedAt: "2026-01-01T00:00:02.000Z",
          }),
          createWorkspace({
            id: "ws-charlie",
            name: "charlie",
            projectName: "my-app",
            pinnedAt: "2026-01-01T00:00:00.000Z",
          }),
          createWorkspace({ id: "ws-recent", name: "recent-work", projectName: "my-app" }),
        ];
        expandProjects([PROJECT_PATH]);
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      // Scope to workspace rows (role="button"): inline action controls inside
      // AgentListItem carry data-workspace-id too and would duplicate entries.
      const rows = Array.from(
        canvasElement.querySelectorAll<HTMLElement>('[data-workspace-id][role="button"]')
      ).map((row) => row.dataset.workspaceId);
      const expected = ["ws-charlie", "ws-alpha", "ws-bravo", "ws-recent"];
      if (rows.length !== expected.length || expected.some((id, i) => rows[i] !== id)) {
        throw new Error(`Expected pinned order ${expected.join(", ")} but saw ${rows.join(", ")}`);
      }
    });
  },
};
