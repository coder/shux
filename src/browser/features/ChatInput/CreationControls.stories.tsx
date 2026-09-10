import { useState, type ComponentProps, type ReactNode, useEffect, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "@storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  mockCoderInfoAvailable,
  mockCoderInfoMissing,
  mockCoderInfoOutdated,
} from "@/browser/stories/mocks/coder";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import {
  RUNTIME_MODE,
  type ParsedRuntime,
  type RuntimeAvailabilityStatus,
} from "@/common/types/runtime";
import {
  CreationControls,
  RuntimeButtonGroup,
  type RuntimeButtonGroupProps,
} from "./CreationControls";
import type { RuntimeAvailabilityState } from "./useCreationWorkspace";
import {
  SettingsSectionStory,
  setupSettingsStory,
} from "../Settings/Sections/settingsStoryUtils.js";

const BASE_RUNTIME_AVAILABILITY = {
  local: { available: true },
  worktree: { available: true },
  ssh: { available: true },
  docker: { available: true },
} as const;

function getLoadedRuntimeAvailability(
  devcontainer: RuntimeAvailabilityStatus
): RuntimeAvailabilityState {
  return {
    status: "loaded",
    data: {
      ...BASE_RUNTIME_AVAILABILITY,
      devcontainer,
    },
  };
}

const DEVCONTAINER_UNAVAILABLE = getLoadedRuntimeAvailability({
  available: false,
  reason: "devcontainer CLI not found. Install from https://containers.dev/",
});

const DEVCONTAINER_SINGLE_CONFIG = getLoadedRuntimeAvailability({
  available: true,
  cliVersion: "0.81.1",
  configs: [
    {
      path: ".devcontainer/devcontainer.json",
      label: "Default (.devcontainer/devcontainer.json)",
    },
  ],
});

const DEVCONTAINER_MULTI_CONFIG = getLoadedRuntimeAvailability({
  available: true,
  cliVersion: "0.81.1",
  configs: [
    {
      path: ".devcontainer/devcontainer.json",
      label: "Default (.devcontainer/devcontainer.json)",
    },
    {
      path: ".devcontainer/backend/devcontainer.json",
      label: "Backend (.devcontainer/backend/devcontainer.json)",
    },
    {
      path: ".devcontainer/frontend/devcontainer.json",
      label: "Frontend (.devcontainer/frontend/devcontainer.json)",
    },
  ],
});

const BASE_ARGS = {
  value: RUNTIME_MODE.WORKTREE,
  defaultMode: RUNTIME_MODE.WORKTREE,
  onChange: fn(),
  onSetDefault: fn(),
  runtimeAvailabilityState: getLoadedRuntimeAvailability({ available: true }),
} satisfies RuntimeButtonGroupProps;

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Creation Controls",
  component: RuntimeButtonGroup,
  render: (args) => (
    <div className="bg-background p-6">
      <div className="w-full max-w-64">
        <RuntimeButtonGroup {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof RuntimeButtonGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

type CreationControlsProps = ComponentProps<typeof CreationControls>;

const DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS: Omit<
  CreationControlsProps,
  "selectedRuntime" | "onSelectedRuntimeChange" | "runtimeAvailabilityState"
> = {
  branches: ["main", "develop"],
  branchesLoaded: true,
  trunkBranch: "main",
  onTrunkBranchChange: fn(),
  coderConfigFallback: {},
  sshHostFallback: "devbox.internal",
  defaultRuntimeMode: RUNTIME_MODE.WORKTREE,
  onSetDefaultRuntime: fn(),
  disabled: false,
  projectPath: "/home/user/projects/my-app",
  userProjects: new Map(),
  onSelectedProjectPathChange: fn(),
  projectName: "my-app",
  nameState: {
    name: "devcontainer-story",
    title: "Devcontainer Story",
    isGenerating: false,
    autoGenerate: true,
    error: null,
    setAutoGenerate: fn(),
    setName: fn(),
  },
};

function DevcontainerCreationControlsStory(props: {
  runtimeAvailabilityState: RuntimeAvailabilityState;
}) {
  const [selectedRuntime, setSelectedRuntime] = useState<ParsedRuntime>({
    mode: "devcontainer",
    configPath: "",
  });

  return (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <div className="bg-background p-6">
        <div className="max-w-3xl">
          <CreationControls
            {...DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS}
            selectedRuntime={selectedRuntime}
            onSelectedRuntimeChange={setSelectedRuntime}
            runtimeAvailabilityState={props.runtimeAvailabilityState}
          />
        </div>
      </div>
    </SettingsSectionStory>
  );
}

async function openWorkspaceTypeMenu(storyRoot: HTMLElement): Promise<void> {
  const canvas = within(storyRoot);
  const trigger = await canvas.findByLabelText("Workspace type", {}, { timeout: 10000 });
  await userEvent.click(trigger);
}

/** Coder option is visible and selectable when Coder CLI is available. */
export const CoderAvailable: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoAvailable,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    await within(document.body).findByRole("option", { name: /^Coder/i }, { timeout: 10000 });
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option is hidden when Coder CLI is missing. */
export const CoderNotAvailable: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoMissing,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    await within(document.body).findByRole("option", { name: /^SSH/i }, { timeout: 10000 });
    await expect(within(document.body).queryByRole("option", { name: /^Coder/i })).toBeNull();
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option remains visible but disabled when CLI version is outdated. */
export const CoderOutdated: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoOutdated,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    const coderOption = await within(document.body).findByRole(
      "option",
      { name: /^Coder/i },
      { timeout: 10000 }
    );

    await expect(coderOption).toHaveAttribute("aria-disabled", "true");
    await expect(coderOption).toHaveTextContent("2.20.0");
    await expect(coderOption).toHaveTextContent("2.25.0");
    await userEvent.keyboard("{Escape}");
  },
};

/** Dev container runtime unavailable (option remains visible but disabled). */
export const DevcontainerUnavailable: Story = {
  args: {
    ...BASE_ARGS,
    runtimeAvailabilityState: DEVCONTAINER_UNAVAILABLE,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);

    const devcontainerOption = await within(document.body).findByRole("option", {
      name: /^Dev container/i,
    });

    await expect(devcontainerOption).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
  },
};

/** Dev container runtime with a single config. */
export const DevcontainerSingleConfig: Story = {
  render: () => (
    <DevcontainerCreationControlsStory runtimeAvailabilityState={DEVCONTAINER_SINGLE_CONFIG} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const configSelect = await canvas.findByRole("combobox", { name: "Dev container config" });
    await expect(configSelect).toBeEnabled();
    await expect(
      canvas.findByText("Default (.devcontainer/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

/** Dev container runtime with multiple configs. */
export const DevcontainerMultiConfig: Story = {
  render: () => (
    <DevcontainerCreationControlsStory runtimeAvailabilityState={DEVCONTAINER_MULTI_CONFIG} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const configSelect = await canvas.findByRole("combobox", { name: "Dev container config" });
    await userEvent.click(configSelect);

    const backendOption = await within(document.body).findByRole("option", {
      name: /Backend \(\.devcontainer\/backend\/devcontainer\.json\)/i,
    });
    await userEvent.click(backendOption);

    await expect(
      canvas.findByText("Backend (.devcontainer/backend/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

const CREATION_PROJECT_PATH = "/Users/dev/my-project";

function CreationControlsStoryShell(props: { children: ReactNode }) {
  const workspaceStore = useWorkspaceStoreRaw();
  const client = useMemo(
    () =>
      createMockORPCClient({
        projects: new Map([[CREATION_PROJECT_PATH, { workspaces: [] }]]),
        workspaces: [],
      }),
    []
  );

  useEffect(() => {
    workspaceStore.setClient(client);
    // useProvidersConfig consumers read the shared store, which gets its
    // client from AppLoader in the real app — wire it manually here too.
    getProvidersConfigStore().setClient(client);
    return () => {
      workspaceStore.setClient(null);
      getProvidersConfigStore().setClient(null);
    };
  }, [client, workspaceStore]);

  return (
    <APIProvider client={client}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            <SettingsProvider>{props.children}</SettingsProvider>
          </WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

const BASE_CREATION_NAME_STATE: WorkspaceNameState = {
  name: "workspace-name",
  title: null,
  isGenerating: false,
  autoGenerate: true,
  error: null,
  setAutoGenerate: fn(),
  setName: fn(),
};

const CREATION_ERROR_BASE_CONTROLS_PROPS = {
  branches: ["main"],
  branchesLoaded: true,
  trunkBranch: "main",
  onTrunkBranchChange: fn(),
  selectedRuntime: { mode: RUNTIME_MODE.WORKTREE },
  coderConfigFallback: {},
  sshHostFallback: "devbox",
  defaultRuntimeMode: RUNTIME_MODE.WORKTREE,
  onSelectedRuntimeChange: fn(),
  onSetDefaultRuntime: fn(),
  disabled: false,
  projectPath: CREATION_PROJECT_PATH,
  userProjects: new Map(),
  onSelectedProjectPathChange: fn(),
  projectName: "my-project",
  runtimeAvailabilityState: BASE_ARGS.runtimeAvailabilityState,
  nameState: BASE_CREATION_NAME_STATE,
} satisfies CreationControlsProps;

function renderCreationControls(nameState: WorkspaceNameState) {
  return (
    <CreationControlsStoryShell>
      <div className="bg-background p-6">
        <div className="max-w-4xl">
          <CreationControls {...CREATION_ERROR_BASE_CONTROLS_PROPS} nameState={nameState} />
        </div>
      </div>
    </CreationControlsStoryShell>
  );
}

function createNameState(overrides: Partial<WorkspaceNameState>): WorkspaceNameState {
  return {
    ...BASE_CREATION_NAME_STATE,
    ...overrides,
  };
}

/** Name generation failure when provider blocks access for the current account scope. */
export const NameGenerationPermissionDenied: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "permission_denied",
            provider: "anthropic",
            raw: "Forbidden",
          },
        },
      })
    ),
};

/** Name generation failure when provider rate limits requests. */
export const NameGenerationRateLimited: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "rate_limit",
            raw: "Too many requests",
          },
        },
      })
    ),
};

/** Name generation failure when API credentials are invalid. */
export const NameGenerationAuthError: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "authentication",
            authKind: "invalid_credentials",
            provider: "openai",
            raw: "Invalid API key",
          },
        },
      })
    ),
};

export const NameValidationError: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        autoGenerate: false,
        name: "invalid name!",
        error: {
          kind: "validation",
          message:
            'Branch names can only contain lowercase letters, numbers, hyphens, underscores, and "/" separators',
        },
      })
    ),
};
