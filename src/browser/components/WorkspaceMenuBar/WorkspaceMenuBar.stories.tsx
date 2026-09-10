import type { ComponentType } from "react";
import { userEvent, waitFor, within } from "@storybook/test";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { createGitStatusExecutor } from "@/browser/stories/helpers/git";
import {
  collapseRightSidebar,
  collapseLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_SIDEBAR_SECTION_ID } from "@/common/constants/scratch";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

export default {
  ...appMeta,
  title: "Components/WorkspaceMenuBar",
};

// Integration: stories render full app to show devcontainer runtime indicator in WorkspaceMenuBar context.

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

/**
 * Build a mock executor that handles BranchSelector's `git rev-parse --abbrev-ref HEAD`
 * plus GitStatusStore's consolidated status script, using a per-workspace branch map.
 */
function createBranchAwareExecutor(
  branches: Map<string, string>,
  gitStatus?: Map<string, { ahead?: number; behind?: number; dirty?: number }>
) {
  const baseExecutor = createGitStatusExecutor(gitStatus);
  return (workspaceId: string, script: string) => {
    // BranchSelector uses `git rev-parse --abbrev-ref HEAD` to detect the current branch
    if (script.includes("git rev-parse --abbrev-ref HEAD")) {
      const branch = branches.get(workspaceId) ?? "main";
      return Promise.resolve({
        success: true as const,
        output: branch,
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }
    return baseExecutor(workspaceId, script);
  };
}

function createDevcontainerClient(runtimeStatus: "running" | "stopped" | "unknown") {
  const stableCreatedAt = "2023-11-14T22:13:20.000Z";

  const workspaces = [
    createWorkspace({
      id: "dc-1",
      name: "feature/lazy-start",
      projectName: "mux",
      runtimeConfig: DEVCONTAINER_RUNTIME,
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "dc-2",
      name: "fix/sidebar-overflow",
      projectName: "mux",
      createdAt: stableCreatedAt,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspaces[0]);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();
  collapseLeftSidebar();

  const branches = new Map([
    // dc-1 branch is only available from git when the runtime is running;
    // otherwise BranchSelector falls back to branchCache / workspaceName.
    ...(runtimeStatus === "running" ? [["dc-1", "feature/lazy-start"] as const] : []),
    ["dc-2", "fix/sidebar-overflow"],
  ]);
  const gitStatus = new Map([
    // Passive git status is gated behind runtime eligibility — stopped/unknown
    // devcontainers have no git status data until the runtime starts.
    ...(runtimeStatus === "running" ? [["dc-1", { ahead: 2, dirty: 1 }] as const] : []),
    ["dc-2", { ahead: 0, behind: 3 }],
  ]);

  return createMockORPCClient({
    projects,
    workspaces,
    executeBash: createBranchAwareExecutor(branches, gitStatus),
    runtimeStatuses: new Map([
      ["dc-1", runtimeStatus],
      ["dc-2", "unsupported"],
    ]),
  });
}

/**
 * Devcontainer workspace with a running container.
 * The top bar shows a "Container running" indicator next to the branch selector.
 */
export const DevcontainerRunning: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => <AppWithMocks setup={() => createDevcontainerClient("running")} />,
};

/**
 * Devcontainer workspace with a stopped container.
 * The top bar does NOT show a container indicator — verifies absence.
 */
export const DevcontainerStopped: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("stopped")} />,
};

/** Devcontainer with unknown runtime status — no status chip should be visible. */
export const DevcontainerUnknown: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("unknown")} />,
};

const PHONE_WIDTH_PX = 390;

function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div style={{ width: PHONE_WIDTH_PX, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

/**
 * Archive in flight: the header shows "Archiving..." next to the title. Pinned to the phone
 * viewport because the status is non-shrinking and the truncating title must yield to it
 * without pushing the right-side controls off-screen.
 */
export const ArchivingPhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  decorators: [PhoneWidthDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspace = createWorkspace({
          id: "archiving-1",
          name: "feature/long-branch-name-that-truncates-on-phones",
          projectName: "mux",
          createdAt: "2023-11-14T22:13:20.000Z",
        });
        const projects = groupWorkspacesByProject([workspace]);
        selectWorkspace(workspace);
        expandProjects([...projects.keys()]);
        collapseRightSidebar();
        collapseLeftSidebar();
        const client = createMockORPCClient({ projects, workspaces: [workspace] });
        // Never settle so the story holds the in-flight state for the snapshot.
        client.workspace.archive = () => new Promise(() => undefined);
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId("workspace-more-actions"));
    await userEvent.click(
      await waitFor(() => within(document.body).getByRole("button", { name: /Archive chat/ }))
    );

    await waitFor(() => {
      const bar = canvas.getByTestId("workspace-menu-bar").getBoundingClientRect();
      const status = canvas.getByTestId("workspace-archiving-status").getBoundingClientRect();
      const more = canvas.getByTestId("workspace-more-actions").getBoundingClientRect();
      if (status.width === 0 || status.right > bar.right + 1 || more.right > bar.right + 1) {
        throw new Error(
          `Archiving status or header controls overflow the ${bar.width}px header (status right=${status.right}, more right=${more.right})`
        );
      }
    });
  },
};

export const ScratchWorkspace: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["laptop", "phone"] },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const scratchPath = "/home/user/.mux/scratch/scratch-1";
        const workspace = {
          ...createWorkspace({
            id: "scratch-1",
            name: "scratch-scratch-1",
            projectName: "Scratch",
            projectPath: scratchPath,
            runtimeConfig: { type: "local" },
          }),
          kind: "scratch" as const,
          namedWorkspacePath: scratchPath,
        };
        selectWorkspace(workspace);
        expandProjects([SCRATCH_SIDEBAR_SECTION_ID]);
        collapseRightSidebar();

        return createMockORPCClient({
          projects: new Map([
            [
              SCRATCH_PROJECT_CONFIG_KEY,
              {
                projectKind: "system",
                trusted: true,
                workspaces: [
                  {
                    kind: "scratch",
                    path: scratchPath,
                    id: workspace.id,
                    name: workspace.name,
                    runtimeConfig: { type: "local" },
                  },
                ],
              },
            ],
          ]),
          workspaces: [workspace],
        });
      }}
    />
  ),
};
