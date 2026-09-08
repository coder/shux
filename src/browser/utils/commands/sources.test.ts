import { expect, test, mock } from "bun:test";
import { buildCoreSources } from "./sources";
import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { GlobalWindow } from "happy-dom";
import {
  getModelKey,
  SIDEBAR_FLAT_MODE_KEY,
  SIDEBAR_HIDE_SUBAGENTS_KEY,
} from "@/common/constants/storage";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { WorkspaceState } from "@/browser/stores/WorkspaceStore";
import type { APIClient } from "@/browser/contexts/API";
import type { UpdateChannel } from "@/common/types/project";
import { CommandIds } from "@/browser/utils/commandIds";

const mk = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) => {
  const userProjects = new Map<string, ProjectConfig>();
  userProjects.set("/repo/a", {
    workspaces: [{ path: "/repo/a/feat-x" }, { path: "/repo/a/feat-y" }],
  });
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  workspaceMetadata.set("w1", {
    id: "w1",
    name: "feat-x",
    projectName: "a",
    projectPath: "/repo/a",
    namedWorkspacePath: "/repo/a/feat-x",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });
  workspaceMetadata.set("w2", {
    id: "w2",
    name: "feat-y",
    projectName: "a",
    projectPath: "/repo/a",
    namedWorkspacePath: "/repo/a/feat-y",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });
  const params: Parameters<typeof buildCoreSources>[0] = {
    userProjects,
    themePreference: "dark",
    supportedUpdateChannels: ["stable", "nightly"],
    workspaceMetadata,
    selectedWorkspace: {
      projectPath: "/repo/a",
      projectName: "a",
      namedWorkspacePath: "/repo/a/feat-x",
      workspaceId: "w1",
    },
    confirmDialog: () => Promise.resolve(true),
    streamingModels: new Map<string, string>(),
    getThinkingLevel: () => "off",
    onSetThinkingLevel: () => undefined,
    getReasoningMode: () => "standard",
    onToggleReasoningMode: () => undefined,
    getFastMode: () => false,
    onToggleFastMode: () => undefined,
    getEffectiveComposerModel: () => "anthropic:claude-sonnet-4-5",
    onStartWorkspaceCreation: () => undefined,
    onStartScratchCreation: () => undefined,
    onStartMultiProjectWorkspaceCreation: () => undefined,
    multiProjectWorkspacesEnabled: true,
    agentPluginsEnabled: false,
    onArchiveMergedWorkspacesInProject: () => Promise.resolve(),
    onSelectWorkspace: () => undefined,
    onRemoveWorkspace: () => Promise.resolve({ success: true }),
    onUpdateTitle: () => Promise.resolve({ success: true }),
    onAddProject: () => undefined,
    onRemoveProject: () => undefined,
    onToggleSidebar: () => undefined,
    onNavigateWorkspace: () => undefined,
    onMovePinnedChat: () => undefined,
    onOpenWorkspaceInTerminal: () => undefined,
    onToggleTheme: () => undefined,
    onSetTheme: () => undefined,
    api: {
      workspace: {
        resetContext: () => Promise.resolve({ success: true, data: "reset" }),
        truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
        interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      },
      analytics: {
        rebuildDatabase: () => Promise.resolve({ success: true, workspacesIngested: 2 }),
      },
    } as unknown as APIClient,
    getBranchesForProject: () =>
      Promise.resolve({
        branches: ["main"],
        recommendedTrunk: "main",
      }),
    ...over,
  };
  return buildCoreSources(params);
};

interface ToastEventDetail {
  type: "success" | "error";
  message: string;
  title?: string;
}

const getActions = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) =>
  mk(over).flatMap((source) => source());

const workspaceApi = (workspace: Record<string, unknown>) =>
  ({
    workspace: {
      resetContext: () => Promise.resolve({ success: true as const, data: "reset" as const }),
      truncateHistory: () => Promise.resolve({ success: true as const, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true as const, data: undefined }),
      ...workspace,
    },
  }) as unknown as APIClient;

const getResetContextAction = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) => {
  const action = getActions(over).find(
    (candidate) => candidate.title === "Reset Context, Preserve History"
  );
  if (!action) {
    throw new Error("Expected reset context action");
  }
  return action;
};

const collectCommandEvents = () => {
  const receivedToasts: ToastEventDetail[] = [];
  const clearEvents: string[] = [];
  const handleToast = (event: Event) => {
    receivedToasts.push((event as CustomEvent<ToastEventDetail>).detail);
  };
  const handleComposerClear = (event: Event) => {
    clearEvents.push((event as CustomEvent<{ workspaceId: string }>).detail.workspaceId);
  };

  window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handleToast);
  window.addEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handleComposerClear);

  return {
    receivedToasts,
    clearEvents,
    dispose: () => {
      window.removeEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handleComposerClear);
      window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handleToast);
    },
  };
};

async function withTestWindow<T>(fn: () => Promise<T> | T): Promise<T> {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;
  document.body
    .appendChild(document.createElement("div"))
    .setAttribute("data-component", "ChatInputSection");

  try {
    return await fn();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
}

test("chat commands include separate reset context and clear history actions", async () => {
  await withTestWindow(async () => {
    const resetContext = mock(() =>
      Promise.resolve({ success: true as const, data: "reset" as const })
    );
    const truncateHistory = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const actions = getActions({
      api: workspaceApi({ resetContext, truncateHistory }),
    });

    const resetAction = actions.find(
      (action) => action.title === "Reset Context, Preserve History"
    );
    const clearAction = actions.find((action) => action.title === "Clear History");

    if (!resetAction) {
      throw new Error("Expected reset context action");
    }
    expect(resetAction.keywords).toEqual([
      "context reset",
      "soft clear",
      "preserve history",
      "reset chat",
    ]);
    if (!clearAction) {
      throw new Error("Expected clear history action");
    }

    await Promise.resolve(resetAction.run());
    expect(resetContext).toHaveBeenCalledWith({ workspaceId: "w1" });
    expect(truncateHistory).not.toHaveBeenCalled();

    await Promise.resolve(clearAction.run());
    expect(truncateHistory).toHaveBeenCalledWith({ workspaceId: "w1", percentage: 1.0 });
  });
});

test("reset context command dispatches composer and toast outcomes", async () => {
  await withTestWindow(async () => {
    const cases = [
      {
        result: { success: true as const, data: "reset" as const },
        clearEvents: ["w1"],
        receivedToasts: [{ type: "success" as const, message: "Context reset; history preserved" }],
      },
      {
        result: { success: true as const, data: "noop" as const },
        clearEvents: [],
        receivedToasts: [{ type: "success" as const, message: "No context to reset" }],
      },
      {
        result: { success: false as const, error: "reset failed" },
        clearEvents: [],
        receivedToasts: [{ type: "error" as const, message: "reset failed" }],
        errorMessage: "reset failed",
      },
    ];

    for (const testCase of cases) {
      const resetContext = mock(() => Promise.resolve(testCase.result));
      const events = collectCommandEvents();
      try {
        const resetAction = getResetContextAction({
          api: workspaceApi({ resetContext }),
        });

        let thrown: unknown;
        try {
          await Promise.resolve(resetAction.run());
        } catch (error) {
          thrown = error;
        }

        if (testCase.errorMessage) {
          expect(thrown).toBeInstanceOf(Error);
          expect(thrown instanceof Error ? thrown.message : undefined).toBe(testCase.errorMessage);
        } else {
          expect(thrown).toBeUndefined();
        }
        expect(events.clearEvents).toEqual(testCase.clearEvents);
        expect(events.receivedToasts).toEqual(testCase.receivedToasts);
      } finally {
        events.dispose();
      }
    }
  });
});

test("buildCoreSources includes create/switch workspace actions", () => {
  const actions = getActions();
  const titles = actions.map((a) => a.title);
  expect(titles.some((t) => t.startsWith("Create New Workspace"))).toBe(true);
  // Workspace switcher shows workspace name (or title) as primary label
  expect(titles.some((t) => t.includes("feat-x") || t.includes("feat-y"))).toBe(true);
  expect(titles.includes("Right Sidebar: Split Horizontally")).toBe(true);
  expect(titles.includes("Right Sidebar: Split Vertically")).toBe(true);
  expect(titles.includes("Right Sidebar: Add Tool…")).toBe(true);
  expect(titles.includes("Right Sidebar: Focus Terminal")).toBe(true);
  expect(titles.includes("New Terminal Window")).toBe(true);
  expect(titles.includes("Open Terminal Window for Workspace…")).toBe(true);
});

test("appearance commands offer auto when a manual theme is selected", () => {
  const actions = getActions({ themePreference: "dark" });

  const autoAction = actions.find((action) => action.id === "appearance:theme:set:auto");
  expect(autoAction?.title).toBe("Use Auto Theme");
  expect(actions.some((action) => action.id === "appearance:theme:set:dark")).toBe(false);
});

test("appearance commands omit auto when auto preference is already selected", () => {
  const actions = getActions({ themePreference: "auto" });

  const themeSetCommandIds = actions
    .map((action) => action.id)
    .filter((id) => id.startsWith("appearance:theme:set:"));

  expect(themeSetCommandIds).toContain("appearance:theme:set:dark");
  expect(themeSetCommandIds).toContain("appearance:theme:set:light");
  expect(themeSetCommandIds).not.toContain("appearance:theme:set:auto");
});

test("buildCoreSources adds thinking effort command", () => {
  const actions = getActions({ getThinkingLevel: () => "medium" });
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction).toBeDefined();
  expect(thinkingAction?.subtitle).toContain("Medium");
});

test("thinking effort options use the visible effective model", async () => {
  const actions = getActions({
    selectedWorkspaceState: {
      lifecycle: "active",
      goal: null,
      currentModel: "anthropic:claude-sonnet-4-5",
    } as unknown as WorkspaceState,
    getEffectiveComposerModel: () => "openai:gpt-5.6-sol",
  });
  const thinkingAction = actions.find((action) => action.id === "thinking:set-level");
  const thinkingField = thinkingAction?.prompt?.fields.find((field) => field.type === "select");
  if (thinkingField?.type !== "select") {
    throw new Error("Expected thinking effort select field");
  }
  const options = await thinkingField.getOptions({});

  expect(options.map((option) => option.id)).toEqual(["medium", "high", "xhigh", "max"]);
});

test("workspace switch commands include keywords for filtering", () => {
  const actions = getActions();
  const switchAction = actions.find((a) => a.id.startsWith("ws:switch:"));

  expect(switchAction).toBeDefined();
  expect(switchAction?.keywords).toBeDefined();
  // Keywords should include name, projectName for matching
  expect(switchAction?.keywords).toContain("feat-x");
  expect(switchAction?.keywords).toContain("a"); // projectName from mk()
});

test("workspace switch with title shows title as primary label", () => {
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>([
    [
      "w-titled",
      {
        id: "w-titled",
        name: "feature-branch",
        projectPath: "/proj",
        projectName: "my-project",
        namedWorkspacePath: "/proj/feature-branch",
        createdAt: "2024-01-01T00:00:00Z",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        title: "Fix login button styling",
      },
    ],
  ]);
  const actions = getActions({ workspaceMetadata });
  const switchAction = actions.find((a) => a.id === "ws:switch:w-titled");

  expect(switchAction).toBeDefined();
  // Title should be primary label
  expect(switchAction?.title).toContain("Fix login button styling");
  // Subtitle should include name and project
  expect(switchAction?.subtitle).toContain("feature-branch");
  expect(switchAction?.subtitle).toContain("my-project");
  // Keywords should include both title and name for filtering
  expect(switchAction?.keywords).toContain("feature-branch");
  expect(switchAction?.keywords).toContain("my-project");
  expect(switchAction?.keywords).toContain("Fix login button styling");
});

test("thinking effort command submits selected level", async () => {
  const onSetThinkingLevel = mock();
  const actions = getActions({ onSetThinkingLevel, getThinkingLevel: () => "low" });
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction?.prompt).toBeDefined();
  await thinkingAction!.prompt!.onSubmit({ thinkingLevel: "high" });

  expect(onSetThinkingLevel).toHaveBeenCalledWith("w1", "high");
});

test("selected-workspace create action targets the workspace sub-project", async () => {
  const userProjects = new Map<string, ProjectConfig>([
    ["/repo/a", { workspaces: [] }],
    ["/repo/a/packages/api", { workspaces: [], parentProjectPath: "/repo/a", displayName: "API" }],
  ]);
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>([
    [
      "w1",
      {
        id: "w1",
        name: "feat-x",
        projectName: "a",
        projectPath: "/repo/a",
        subProjectPath: "/repo/a/packages/api",
        namedWorkspacePath: "/repo/a/feat-x",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    ],
  ]);
  const onStartWorkspaceCreation = mock();
  const actions = getActions({ userProjects, workspaceMetadata, onStartWorkspaceCreation });
  const createAction = actions.find((action) => action.id === "ws:new");

  expect(createAction?.subtitle).toBe("for a / API");
  await createAction?.run();
  expect(onStartWorkspaceCreation).toHaveBeenCalledWith("/repo/a/packages/api");
});

test("selected scratch workspace omits the generic create-workspace action", () => {
  // A scratch chat's projectPath is its app-managed workdir, not a configured
  // project, so the generic action would target the wrong project.
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>([
    [
      "ws-scratch",
      {
        id: "ws-scratch",
        kind: "scratch",
        name: "scratch-1",
        projectName: "Scratch",
        projectPath: "/home/user/.mux/scratch/ws-scratch",
        namedWorkspacePath: "/home/user/.mux/scratch/ws-scratch",
        runtimeConfig: { type: "local" },
      },
    ],
  ]);
  const actions = getActions({
    workspaceMetadata,
    selectedWorkspace: {
      projectPath: "/home/user/.mux/scratch/ws-scratch",
      projectName: "Scratch",
      namedWorkspacePath: "/home/user/.mux/scratch/ws-scratch",
      workspaceId: "ws-scratch",
    },
  });

  expect(actions.find((action) => action.id === "ws:new")).toBeUndefined();
  expect(actions.find((action) => action.id === "ws:new-scratch")).toBeDefined();
});

test("buildCoreSources includes archive merged workspaces in project action", () => {
  const actions = getActions();
  const archiveAction = actions.find((a) => a.id === "ws:archive-merged-in-project");

  expect(archiveAction).toBeDefined();
  expect(archiveAction?.title).toBe("Archive Merged Workspaces in Project…");
});

test("archive merged workspaces prompt submits selected project", async () => {
  const onArchiveMergedWorkspacesInProject = mock(() => Promise.resolve());
  const actions = getActions({ onArchiveMergedWorkspacesInProject });
  const archiveAction = actions.find((a) => a.id === "ws:archive-merged-in-project");

  expect(archiveAction).toBeDefined();
  expect(archiveAction?.prompt).toBeDefined();

  // buildCoreSources uses confirm(...) in onSubmit.
  const originalConfirm = (globalThis as unknown as { confirm?: typeof confirm }).confirm;
  (globalThis as unknown as { confirm: typeof confirm }).confirm = () => true;
  try {
    await archiveAction!.prompt!.onSubmit({ projectPath: "/repo/a" });
  } finally {
    if (originalConfirm) {
      (globalThis as unknown as { confirm: typeof confirm }).confirm = originalConfirm;
    } else {
      delete (globalThis as unknown as { confirm?: typeof confirm }).confirm;
    }
  }

  expect(onArchiveMergedWorkspacesInProject).toHaveBeenCalledTimes(1);
  expect(onArchiveMergedWorkspacesInProject).toHaveBeenCalledWith("/repo/a");
});

test("multi-project workspace command triggers creation flow", async () => {
  const onStartMultiProjectWorkspaceCreation = mock();
  const actions = getActions({ onStartMultiProjectWorkspaceCreation });
  const multiProjectAction = actions.find((a) => a.id === "ws:new-multi-project");

  expect(multiProjectAction).toBeDefined();
  expect(multiProjectAction?.title).toBe("New Multi-Project Workspace");
  expect(multiProjectAction?.visible?.()).toBe(true);

  await multiProjectAction!.run();

  expect(onStartMultiProjectWorkspaceCreation).toHaveBeenCalledTimes(1);
});

test("multi-project workspace command hides itself when the experiment is disabled", async () => {
  const onStartMultiProjectWorkspaceCreation = mock();
  const actions = getActions({
    onStartMultiProjectWorkspaceCreation,
    multiProjectWorkspacesEnabled: false,
  });
  const multiProjectAction = actions.find((a) => a.id === "ws:new-multi-project");

  expect(multiProjectAction).toBeDefined();
  expect(multiProjectAction?.visible?.()).toBe(false);

  await multiProjectAction!.run();

  expect(onStartMultiProjectWorkspaceCreation).not.toHaveBeenCalled();
});

test("Login with Coder command opens providers expanded on Coder and starts the login", async () => {
  // Regression: the command must reach the login operation (expand the Coder
  // provider and start the OAuth flow via the one-shot hints consumed by
  // ProvidersSection), not merely open the generic Providers section.
  const onOpenSettings = mock();
  const actions = getActions({ onOpenSettings });
  const loginAction = actions.find((a) => a.title === "Settings: Login with Coder");

  expect(loginAction).toBeDefined();
  await loginAction!.run();

  expect(onOpenSettings).toHaveBeenCalledWith("providers", {
    expandProvider: "coder",
    startCoderLogin: true,
  });
});

test.each([
  ["Electron", ["stable", "nightly"]],
  ["server", ["stable", "nightly", "npm"]],
  ["unknown", []],
] satisfies Array<[string, UpdateChannel[]]>)(
  "update channel actions follow %s capabilities",
  (_runtime, supportedUpdateChannels) => {
    const actions = getActions({ onOpenAbout: mock(), supportedUpdateChannels });
    expect(actions.filter((a) => a.id.startsWith("update:channel:")).map((a) => a.id)).toEqual(
      supportedUpdateChannels.map(CommandIds.updateChannel)
    );
  }
);

test.each(["stable", "nightly", "npm"] as const)(
  "update commands persist %s before opening About and need an About opener",
  async (channel) => {
    const onOpenAbout = mock();
    const install = mock(() => Promise.resolve());
    let settleChannel!: () => void;
    const setChannel = mock(
      () =>
        new Promise<void>((resolve) => {
          settleChannel = resolve;
        })
    );
    const actions = getActions({
      onOpenAbout,
      api: { update: { install, setChannel } } as unknown as APIClient,
      supportedUpdateChannels: ["stable", "nightly", "npm"],
    });
    await actions.find((a) => a.title === "Install Update and Restart")!.run();
    expect(install).toHaveBeenCalledTimes(1);
    expect(onOpenAbout).toHaveBeenCalledTimes(1);
    // About reads the channel when it opens, so the switch must persist before the dialog appears.
    const switchAction = actions.find((a) => a.id === CommandIds.updateChannel(channel));
    expect(switchAction).toBeDefined();
    const switched = switchAction!.run();
    expect(setChannel).toHaveBeenCalledWith({ channel });
    expect(onOpenAbout).toHaveBeenCalledTimes(1);
    settleChannel();
    await switched;
    expect(onOpenAbout).toHaveBeenCalledTimes(2);
    expect(getActions().some((a) => a.title === "Check for Updates")).toBe(false);
  }
);

test("Login with Coder command hides itself when a custom provider shadows the coder id", () => {
  // Regression: an upgraded install can carry a custom OpenAI-compatible
  // provider named "coder". ProvidersSection hides the OAuth block for
  // shadowed providers, so the login hint would either surface an invisible
  // "Set the deployment URL first" error or inject built-in OAuth credentials
  // into the custom provider's section. The command must follow the UI's
  // shadow handling and hide itself.
  const onOpenSettings = mock();
  const shadowed = getActions({
    onOpenSettings,
    providersConfig: {
      coder: { isCustom: true, baseUrl: "http://localhost:9000/v1" },
    } as unknown as Parameters<typeof buildCoreSources>[0]["providersConfig"],
  }).find((a) => a.title === "Settings: Login with Coder");
  expect(shadowed).toBeDefined();
  expect(shadowed?.visible?.()).toBe(false);

  // Built-in Coder (no shadow): visible, including when no config exists yet.
  const builtIn = getActions({
    onOpenSettings,
    providersConfig: {
      coder: { coderOauthSet: false },
    } as unknown as Parameters<typeof buildCoreSources>[0]["providersConfig"],
  }).find((a) => a.title === "Settings: Login with Coder");
  expect(builtIn?.visible?.()).toBe(true);

  const noConfig = getActions({ onOpenSettings }).find(
    (a) => a.title === "Settings: Login with Coder"
  );
  expect(noConfig?.visible?.()).toBe(true);
});

test("Disconnect Coder command revokes via RPC and is gated on a stored credential", async () => {
  // Regression: Disconnect must be keyboard-reachable and must key its
  // visibility off credential PRESENCE (coderOauthCredentialStored), not
  // routability — a blob minted for a previously configured deployment URL
  // must stay revocable.
  const disconnect = mock(() => Promise.resolve({ success: true as const, data: undefined }));
  const actions = getActions({
    api: { coderOauth: { disconnect } } as unknown as APIClient,
    providersConfig: {
      coder: { coderOauthSet: false, coderOauthCredentialStored: true },
    } as unknown as Parameters<typeof buildCoreSources>[0]["providersConfig"],
  });
  const disconnectAction = actions.find((a) => a.title === "Settings: Disconnect Coder");

  expect(disconnectAction).toBeDefined();
  expect(disconnectAction?.visible?.()).toBe(true);
  await disconnectAction!.run();
  expect(disconnect).toHaveBeenCalledTimes(1);

  // Without a stored credential there is nothing to revoke: hidden.
  const hidden = getActions({
    providersConfig: {
      coder: { coderOauthSet: false, coderOauthCredentialStored: false },
    } as unknown as Parameters<typeof buildCoreSources>[0]["providersConfig"],
  }).find((a) => a.title === "Settings: Disconnect Coder");
  expect(hidden?.visible?.()).toBe(false);
});

test("project commands exclude system projects from options", async () => {
  const allProjects = new Map<string, ProjectConfig>([
    [
      "/repo/a",
      {
        workspaces: [{ path: "/repo/a/feat-x" }, { path: "/repo/a/feat-y" }],
      },
    ],
    [
      "/repo/a/packages/api",
      {
        workspaces: [],
        parentProjectPath: "/repo/a",
        displayName: "API",
      },
    ],
    ["/repo/system", { workspaces: [], projectKind: "system" }],
  ]);

  const userProjects = new Map(
    [...allProjects].filter(([, config]) => config.projectKind !== "system")
  );

  const actions = getActions({ userProjects });

  const createWorkspaceAction = actions.find((a) => a.title === "Create New Workspace in Project…");
  expect(createWorkspaceAction).toBeDefined();
  const createProjectField = createWorkspaceAction?.prompt?.fields[0];
  expect(createProjectField?.type).toBe("select");
  if (createProjectField?.type !== "select") {
    throw new Error("Create workspace command is missing project select options");
  }

  const createOptions = await createProjectField.getOptions({});
  expect(createOptions.map((option) => option.id)).toEqual(["/repo/a", "/repo/a/packages/api"]);
  expect(createOptions.find((option) => option.id === "/repo/a/packages/api")?.label).toBe(
    "a / API"
  );
  expect(createOptions.some((option) => option.id === "/repo/system")).toBe(false);

  const archiveAction = actions.find((a) => a.title === "Archive Merged Workspaces in Project…");
  expect(archiveAction).toBeDefined();
  const archiveProjectField = archiveAction?.prompt?.fields[0];
  expect(archiveProjectField?.type).toBe("select");
  if (archiveProjectField?.type !== "select") {
    throw new Error("Archive command is missing project select options");
  }

  const archiveOptions = await archiveProjectField.getOptions({});
  expect(archiveOptions.some((option) => option.id === "/repo/a/packages/api")).toBe(false);
  expect(archiveOptions.map((option) => option.id)).toEqual(["/repo/a"]);
  expect(archiveOptions.some((option) => option.id === "/repo/system")).toBe(false);
});

const makeGoalSnapshot = (
  status: "active" | "paused" | "budget_limited" | "complete",
  overrides: Partial<NonNullable<WorkspaceState["goal"]>> = {}
) => ({
  goalId: "00000000-0000-4000-8000-000000000001",
  status,
  objective: "Ship palette parity",
  budgetCents: 500,
  costCents: 125,
  turnsUsed: 2,
  turnCap: null,
  startedAtMs: 1_700_000_000_000,
  ...overrides,
});

const makeGoalRecord = (status: "active" | "paused" | "budget_limited" | "complete") => ({
  version: 1 as const,
  goalId: "00000000-0000-4000-8000-000000000001",
  status,
  objective: "Ship palette parity",
  budgetCents: 500,
  turnCap: null,
  costCents: 125,
  turnsUsed: 2,
  attributedChildren: [],
  budgetLimitInjectedForGoalId: null,
  requireUserAcknowledgmentSinceMs: null,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
});

function makeWorkspaceState(goal: WorkspaceState["goal"]): WorkspaceState {
  return {
    name: "feat-x",
    messages: [],
    queuedMessage: null,
    canInterrupt: false,
    isCompacting: false,
    isStreamStarting: false,
    awaitingUserQuestion: false,
    loading: false,
    isTranscriptCaughtUp: true,
    isHydratingTranscript: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    muxMessages: [],
    currentModel: null,
    currentThinkingLevel: null,
    recencyTimestamp: null,
    todos: [],
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    activeWorkflowRunCount: 0,
    activeBashMonitorCount: 0,
    lastAbortReason: null,
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    autoRetryStatus: null,
    goal,
  };
}

const getVisibleGoalActions = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) => {
  const sources = mk(over);
  return sources
    .flatMap((source) => source())
    .filter((action) => action.visible?.() ?? true)
    .filter((action) => action.title.startsWith("Goal:"));
};

const getVisibleGoalTitles = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) =>
  getVisibleGoalActions(over)
    .map((action) => action.title)
    .sort();

test("goal palette commands are hidden when no workspace is selected", () => {
  expect(getVisibleGoalTitles({ selectedWorkspace: null })).toEqual([]);
});

test("goal palette commands are hidden for child task workspaces", () => {
  const childMetadata = new Map<string, FrontendWorkspaceMetadata>();
  childMetadata.set("child-ws", {
    id: "child-ws",
    name: "child-task",
    projectName: "a",
    projectPath: "/repo/a",
    namedWorkspacePath: "/repo/a/child-task",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: "parent-ws",
  });

  expect(
    getVisibleGoalTitles({
      workspaceMetadata: childMetadata,
      selectedWorkspace: {
        projectPath: "/repo/a",
        projectName: "a",
        namedWorkspacePath: "/repo/a/child-task",
        workspaceId: "child-ws",
      },
    })
  ).toEqual([]);
});

test("goal palette commands only show set objective with no current goal", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(null),
    })
  ).toEqual(["Goal: Set objective"]);
});

test("goal palette commands match the Active lifecycle state", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("active")),
    })
  ).toEqual([
    "Goal: Clear",
    "Goal: Mark complete",
    "Goal: Open panel",
    "Goal: Pause",
    "Goal: Set objective",
  ]);
});

test("goal palette hides mutating lifecycle commands for pending goals", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(
        makeGoalSnapshot("active", { pendingPersistence: true })
      ),
    })
  ).toEqual(["Goal: Open panel", "Goal: Set objective"]);
});

test("goal palette commands match the Paused lifecycle state", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("paused")),
    })
  ).toEqual(["Goal: Clear", "Goal: Open panel", "Goal: Resume", "Goal: Set objective"]);
});

test("goal palette commands match the BudgetLimited lifecycle state", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("budget_limited")),
    })
  ).toEqual(["Goal: Clear", "Goal: Mark complete", "Goal: Open panel", "Goal: Set objective"]);
});

test("goal palette commands match the Complete lifecycle state", () => {
  expect(
    getVisibleGoalTitles({
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("complete")),
    })
  ).toEqual(["Goal: Clear", "Goal: Open panel", "Goal: Set objective"]);
});

test("goal set objective prompt treats blank budget as explicit no-budget", async () => {
  // The palette placeholder promises that blank means no budget; unlike the
  // slash-command path, there is no separate --no-budget flag in this prompt.
  const setGoalCalls: Array<Record<string, unknown>> = [];
  const sources = mk({
    selectedWorkspaceState: {
      lifecycle: "active",
      goal: null,
    } as unknown as WorkspaceState,
    api: {
      config: {
        // Even with default budget settings, blank palette budget means no budget.
        getConfig: () =>
          Promise.resolve({
            goalDefaults: {
              alwaysRequireExplicitBudget: true,
              defaultBudgetCents: 800,
              defaultTurnCap: 5,
            },
          }),
      },
      workspace: {
        getGoal: () => Promise.resolve({ goal: null }),
        setGoal: (input: Record<string, unknown>) => {
          setGoalCalls.push(input);
          return Promise.resolve({
            success: true,
            data: {
              version: 1,
              goalId: "11111111-1111-4111-8111-111111111111",
              objective: input.objective,
              status: "active",
              budgetCents: input.budgetCents ?? null,
              turnCap: input.turnCap ?? null,
              costCents: 0,
              turnsUsed: 0,
              attributedChildren: [],
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              budgetLimitInjectedForGoalId: null,
              requireUserAcknowledgmentSinceMs: null,
              lastContinuationFiredAtMs: null,
            },
          });
        },
      },
    } as unknown as APIClient,
  });
  const actions = sources.flatMap((s) => s());
  const setObjectiveAction = actions.find((action) => action.id === "goal:set-objective");
  expect(setObjectiveAction?.prompt?.onSubmit).toBeDefined();

  // Blank budget — palette should send explicit null instead of applying defaults.
  await setObjectiveAction?.prompt?.onSubmit?.({
    objective: "Ship the feature",
    budget: "",
  });

  expect(setGoalCalls.length).toBe(1);
  expect(setGoalCalls[0]).toMatchObject({
    objective: "Ship the feature",
    budgetCents: null,
    turnCap: 5,
  });
});

test("goal set objective prompt allows zero budget on unpriced model", async () => {
  const setGoal = mock(() => Promise.resolve({ success: true, data: makeGoalRecord("active") }));
  const actions = getVisibleGoalActions({
    api: {
      config: { getConfig: mock(() => Promise.resolve({})) },
      providers: { getConfig: mock(() => Promise.resolve({})) },
      workspace: { getGoal: mock(() => Promise.resolve({ goal: null })), setGoal },
    } as unknown as APIClient,
    selectedWorkspaceState: {
      ...makeWorkspaceState(null),
      currentModel: "custom:unpriced-model",
    },
  });

  const setObjectiveAction = actions.find((action) => action.id === "goal:set-objective");
  await setObjectiveAction!.prompt!.onSubmit({
    objective: "Track without dollar limit",
    budget: "0",
  });

  expect(setGoal).toHaveBeenCalledWith(
    expect.objectContaining({
      objective: "Track without dollar limit",
      budgetCents: null,
    })
  );
});

test("goal set objective prompt submits objective and parsed budget", async () => {
  const getGoal = mock(() => Promise.resolve({ goal: null }));
  const setGoal = mock(() => Promise.resolve({ success: true, data: makeGoalRecord("active") }));
  const actions = getVisibleGoalActions({
    api: {
      workspace: { getGoal, setGoal },
    } as unknown as APIClient,
    selectedWorkspaceState: makeWorkspaceState(null),
  });

  const setObjectiveAction = actions.find((action) => action.id === "goal:set-objective");
  expect(setObjectiveAction?.prompt?.fields.map((field) => field.name)).toEqual([
    "objective",
    "budget",
  ]);

  await setObjectiveAction!.prompt!.onSubmit({
    objective: "  Finish the feature  ",
    budget: "$5.25",
  });

  expect(setGoal).toHaveBeenCalledWith({
    workspaceId: "w1",
    objective: "Finish the feature",
    expectedGoalId: null,
    budgetCents: 525,
  });
});

test("goal set objective prompt blocks budgeted goals on unpriced selected model", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  window.localStorage.setItem(getModelKey("w1"), JSON.stringify("custom:unpriced-model"));

  try {
    const getGoal = mock(() => Promise.resolve({ goal: null }));
    const setGoal = mock(() => Promise.resolve({ success: true, data: makeGoalRecord("active") }));
    const state = makeWorkspaceState(null);
    state.currentModel = "openai:gpt-4o";
    const actions = getVisibleGoalActions({
      api: {
        workspace: { getGoal, setGoal },
      } as unknown as APIClient,
      selectedWorkspaceState: state,
    });

    const setObjectiveAction = actions.find((action) => action.id === "goal:set-objective");
    expect(setObjectiveAction?.prompt?.onSubmit).toBeDefined();

    await setObjectiveAction!.prompt!.onSubmit({
      objective: "Ship the feature",
      budget: "$5.25",
    });

    expect(setGoal).not.toHaveBeenCalled();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("goal mark complete prompt submits completion summary", async () => {
  const getGoal = mock(() => Promise.resolve({ goal: makeGoalRecord("active") }));
  const setGoal = mock(() => Promise.resolve({ success: true, data: makeGoalRecord("complete") }));
  const actions = getVisibleGoalActions({
    api: {
      workspace: { getGoal, setGoal },
    } as unknown as APIClient,
    selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("active")),
  });

  const completeAction = actions.find((action) => action.id === "goal:mark-complete");
  expect(completeAction?.prompt?.fields.map((field) => field.name)).toEqual(["summary"]);

  await completeAction!.prompt!.onSubmit({ summary: "  Done and verified.  " });

  expect(setGoal).toHaveBeenCalledWith({
    workspaceId: "w1",
    status: "complete",
    completionSummary: "Done and verified.",
    expectedGoalId: "00000000-0000-4000-8000-000000000001",
  });
});

test("goal palette surfaces invalid transition messages without throwing", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;
  const alert = mock(() => undefined);
  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;
  window.alert = alert;

  try {
    const setGoal = mock(() =>
      Promise.resolve({
        success: false,
        error: { type: "invalid_transition", message: "Cannot complete a missing goal." },
      })
    );
    const actions = getVisibleGoalActions({
      api: {
        workspace: {
          getGoal: mock(() => Promise.resolve({ goal: makeGoalRecord("active") })),
          setGoal,
        },
      } as unknown as APIClient,
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("active")),
    });

    const completeAction = actions.find((action) => action.id === "goal:mark-complete");
    await completeAction!.prompt!.onSubmit({ summary: "Done." });

    expect(alert).toHaveBeenCalledWith("Cannot complete a missing goal.");
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("goal open panel command dispatches the right-sidebar goal event", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  const receivedWorkspaceIds: string[] = [];
  const handleOpenGoalTab = (event: Event) => {
    receivedWorkspaceIds.push((event as CustomEvent<{ workspaceId: string }>).detail.workspaceId);
  };
  window.addEventListener(CUSTOM_EVENTS.OPEN_GOAL_TAB, handleOpenGoalTab);

  try {
    const actions = getVisibleGoalActions({
      selectedWorkspaceState: makeWorkspaceState(makeGoalSnapshot("complete")),
    });
    const openPanelAction = actions.find((action) => action.id === "goal:open-panel");

    await openPanelAction!.run();

    expect(receivedWorkspaceIds).toEqual(["w1"]);
  } finally {
    window.removeEventListener(CUSTOM_EVENTS.OPEN_GOAL_TAB, handleOpenGoalTab);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("buildCoreSources includes rebuild analytics database action with discoverable keywords", () => {
  const actions = getActions();
  const rebuildAction = actions.find((a) => a.id === "analytics:rebuild-database");

  expect(rebuildAction).toBeDefined();
  expect(rebuildAction?.title).toBe("Rebuild Analytics Database");
  expect(rebuildAction?.keywords).toContain("analytics");
  expect(rebuildAction?.keywords).toContain("rebuild");
  expect(rebuildAction?.keywords).toContain("recompute");
  expect(rebuildAction?.keywords).toContain("database");
  expect(rebuildAction?.keywords).toContain("stats");
});

test("analytics rebuild command calls route and dispatches toast feedback", async () => {
  const rebuildDatabase = mock(() => Promise.resolve({ success: true, workspacesIngested: 4 }));

  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  const chatInputHost = document.createElement("div");
  chatInputHost.setAttribute("data-component", "ChatInputSection");
  document.body.appendChild(chatInputHost);

  const receivedToasts: Array<{
    type: "success" | "error";
    message: string;
    title?: string;
  }> = [];
  const handleToast = (event: Event) => {
    receivedToasts.push(
      (event as CustomEvent<{ type: "success" | "error"; message: string; title?: string }>).detail
    );
  };
  window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handleToast);

  try {
    const actions = getActions({
      api: {
        workspace: {
          truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
          interruptStream: () => Promise.resolve({ success: true, data: undefined }),
        },
        analytics: { rebuildDatabase },
      } as unknown as APIClient,
    });
    const rebuildAction = actions.find((a) => a.id === "analytics:rebuild-database");

    expect(rebuildAction).toBeDefined();
    await rebuildAction!.run();

    expect(rebuildDatabase).toHaveBeenCalledWith({});
    expect(receivedToasts).toEqual([
      {
        type: "success",
        message: "Analytics database rebuilt successfully (4 workspaces ingested).",
      },
    ]);
  } finally {
    window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handleToast);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("analytics rebuild command falls back to alert when chat input toast host is unavailable", async () => {
  const rebuildDatabase = mock(() => Promise.resolve({ success: true, workspacesIngested: 1 }));

  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  const alertMock = mock(() => undefined);
  window.alert = alertMock as unknown as typeof window.alert;

  try {
    const actions = getActions({
      api: {
        workspace: {
          truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
          interruptStream: () => Promise.resolve({ success: true, data: undefined }),
        },
        analytics: { rebuildDatabase },
      } as unknown as APIClient,
    });
    const rebuildAction = actions.find((a) => a.id === "analytics:rebuild-database");

    expect(rebuildAction).toBeDefined();
    await rebuildAction!.run();

    expect(rebuildDatabase).toHaveBeenCalledWith({});
    expect(alertMock).toHaveBeenCalledWith(
      "Analytics database rebuilt successfully (1 workspace ingested)."
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("fast mode command is route-aware and keyboard accessible", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  try {
    const onToggleFastMode = mock(() => undefined);
    const directOpenAIActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "anthropic:claude-sonnet-4-5",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "openai:gpt-5.6-sol",
      providersConfig: {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "direct",
      onToggleFastMode,
    });
    const fastAction = directOpenAIActions.find(
      (action) => action.id === "thinking:toggle-fast-mode"
    );

    expect(fastAction?.shortcutHint).toBeDefined();
    await fastAction?.run();
    expect(onToggleFastMode).toHaveBeenCalledTimes(1);

    const directXAIActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "xai:grok-4.5",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "xai:grok-4.5",
      providersConfig: {
        xai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "direct",
      onToggleFastMode,
    });
    const xaiFastAction = directXAIActions.find(
      (action) => action.id === "thinking:toggle-fast-mode"
    );
    expect(xaiFastAction?.shortcutHint).toBeDefined();
    await xaiFastAction?.run();
    expect(onToggleFastMode).toHaveBeenCalledTimes(2);

    const creationScopeId = "project:/repo/a";
    const creationActions = getActions({
      selectedWorkspace: null,
      selectedWorkspaceState: null,
      creationScopeId,
      getEffectiveComposerModel: (scopeId) =>
        scopeId === creationScopeId ? "openai:gpt-5.6-sol" : "anthropic:claude-sonnet-4-5",
      providersConfig: {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "direct",
      onToggleFastMode,
    });
    const creationFastAction = creationActions.find(
      (action) => action.id === "thinking:toggle-fast-mode"
    );
    expect(creationFastAction?.shortcutHint).toBeDefined();
    await creationFastAction?.run();
    expect(onToggleFastMode).toHaveBeenCalledTimes(3);

    const staleOpenAIActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "openai:gpt-5.6-sol",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "anthropic:claude-sonnet-4-5",
      providersConfig: {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "direct",
    });
    expect(staleOpenAIActions.some((action) => action.id === "thinking:toggle-fast-mode")).toBe(
      false
    );

    const gatewayXAIActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "xai:grok-4.5",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "xai:grok-4.5",
      providersConfig: {
        xai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "openrouter",
    });
    expect(gatewayXAIActions.some((action) => action.id === "thinking:toggle-fast-mode")).toBe(
      false
    );

    const unloadedActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "openai:gpt-5.6-sol",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "openai:gpt-5.6-sol",
      providersConfig: null,
      getRouteForModel: () => "direct",
    });
    expect(unloadedActions.some((action) => action.id === "thinking:toggle-fast-mode")).toBe(false);

    const gatewayActions = getActions({
      selectedWorkspaceState: {
        lifecycle: "active",
        goal: null,
        currentModel: "openai:gpt-5.6-sol",
      } as unknown as WorkspaceState,
      getEffectiveComposerModel: () => "openai:gpt-5.6-sol",
      providersConfig: {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      },
      getRouteForModel: () => "openrouter",
    });
    expect(gatewayActions.some((action) => action.id === "thinking:toggle-fast-mode")).toBe(false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("workspace generate title command is available for the current workspace", () => {
  const actions = getActions({
    selectedWorkspace: {
      projectPath: "/repo/a",
      projectName: "a",
      namedWorkspacePath: "/repo/a/feat-x",
      workspaceId: "w1",
    },
  });

  expect(actions.some((action) => action.id === "ws:generate-title")).toBe(true);
});

test("workspace generate title command dispatches a title-generation request event", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  const receivedWorkspaceIds: string[] = [];
  const handleRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
    receivedWorkspaceIds.push(detail.workspaceId);
  };

  window.addEventListener(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, handleRequest);

  try {
    const actions = getActions();
    const generateTitleAction = actions.find((a) => a.id === "ws:generate-title");

    expect(generateTitleAction).toBeDefined();

    await generateTitleAction!.run();

    expect(receivedWorkspaceIds).toEqual(["w1"]);
  } finally {
    window.removeEventListener(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, handleRequest);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test("toggle flat chat list command flips the persisted sidebar setting", () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;

  try {
    const toggle = () => {
      const action = getActions().find((a) => a.id === "nav:toggle-flat-chat-list");
      expect(action).toBeDefined();
      void action!.run();
    };

    toggle();
    expect(window.localStorage.getItem(SIDEBAR_FLAT_MODE_KEY)).toBe("true");
    expect(getActions().find((a) => a.id === "nav:toggle-flat-chat-list")?.subtitle).toContain(
      "Flat"
    );
    toggle();
    expect(window.localStorage.getItem(SIDEBAR_FLAT_MODE_KEY)).toBe("false");
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("toggle hide sub-agents command flips the persisted sidebar setting", () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;

  try {
    const toggle = () => {
      const action = getActions().find((a) => a.id === "nav:toggle-hide-subagents");
      expect(action).toBeDefined();
      void action!.run();
    };

    toggle();
    expect(window.localStorage.getItem(SIDEBAR_HIDE_SUBAGENTS_KEY)).toBe("true");

    const rebuilt = getActions().find((a) => a.id === "nav:toggle-hide-subagents");
    expect(rebuilt?.subtitle).toContain("Hidden");
    toggle();
    expect(window.localStorage.getItem(SIDEBAR_HIDE_SUBAGENTS_KEY)).toBe("false");
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test.each(["coder", "mux-gateway", "direct"])(
  "Pro palette uses the effective %s route instead of stale settings routing",
  async (route) =>
    withTestWindow(() => {
      const model = "coder:prod-openai/gpt-6-astra";
      const resolveEffectiveRoute = mock((selection: string) => {
        expect(selection).toBe(model);
        return route;
      });
      const actions = getActions({
        getEffectiveComposerModel: () => model,
        providersConfig: {
          openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
          coder: {
            apiKeySet: false,
            isEnabled: true,
            isConfigured: true,
            discoveredProviders: [{ name: "prod-openai", type: "openai" }],
          },
        },
        getRouteForModel: () => "direct",
        getEffectiveRouteForModel: resolveEffectiveRoute,
      });
      expect(actions.some((action) => action.id === "thinking:toggle-pro-reasoning")).toBe(
        route !== "mux-gateway"
      );
      expect(resolveEffectiveRoute).toHaveBeenCalled();
    })
);
