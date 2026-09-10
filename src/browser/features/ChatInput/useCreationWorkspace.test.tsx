import type { APIClient } from "@/browser/contexts/API";
import * as APIModule from "@/browser/contexts/API";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as RouterContextModule from "@/browser/contexts/RouterContext";
import type { DraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import * as PersistedStateModule from "@/browser/hooks/usePersistedState";
import * as DraftWorkspaceSettingsModule from "@/browser/hooks/useDraftWorkspaceSettings";
import type { ProjectConfig } from "@/common/types/project";
import {
  GLOBAL_SCOPE_ID,
  getAgentIdKey,
  getInputKey,
  getInputAttachmentsKey,
  getModelKey,
  getPendingScopeId,
  getPendingDraftSkillDiscoveryKey,
  getPendingWorkspaceSendErrorKey,
  getProjectScopeId,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

import {
  CODER_RUNTIME_PLACEHOLDER,
  type CoderWorkspaceConfig,
  type ParsedRuntime,
} from "@/common/types/runtime";
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { isInitialStagingLocked } from "@/browser/features/ChatInput/initialStagingLock";
import { GlobalWindow } from "happy-dom";
import type { PendingFileChatAttachment } from "./ChatAttachments";
import type { WorkspaceCreatedOptions } from "./types";
import { useCreationWorkspace, type CreationSendResult } from "./useCreationWorkspace";

const readPersistedStateCalls: Array<[string, unknown]> = [];
let persistedPreferences: Record<string, unknown> = {};
const readPersistedStateMock = mock((key: string, defaultValue: unknown) => {
  readPersistedStateCalls.push([key, defaultValue]);
  if (Object.prototype.hasOwnProperty.call(persistedPreferences, key)) {
    return persistedPreferences[key];
  }
  if (typeof window === "undefined" || !window.localStorage) {
    return defaultValue;
  }
  try {
    const storedValue = window.localStorage.getItem(key);
    if (storedValue === null || storedValue === "undefined") {
      return defaultValue;
    }
    return JSON.parse(storedValue) as unknown;
  } catch {
    return defaultValue;
  }
});

const updatePersistedStateCalls: Array<[string, unknown]> = [];
const updatePersistedStateMock = mock((key: string, value: unknown) => {
  updatePersistedStateCalls.push([key, value]);
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  if (value === undefined || value === null) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
});

const readPersistedStringMock = mock((key: string) => {
  if (Object.prototype.hasOwnProperty.call(persistedPreferences, key)) {
    const value = persistedPreferences[key];
    return typeof value === "string" ? value : undefined;
  }
  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }
  const storedValue = window.localStorage.getItem(key);
  if (storedValue === null || storedValue === "undefined") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Fall through to raw string.
  }
  return storedValue;
});

function installPersistedStateMocks(): () => void {
  const readPersistedStateSpy = spyOn(
    PersistedStateModule,
    "readPersistedState"
  ).mockImplementation(readPersistedStateMock as typeof PersistedStateModule.readPersistedState);
  const readPersistedStringSpy = spyOn(
    PersistedStateModule,
    "readPersistedString"
  ).mockImplementation(readPersistedStringMock as typeof PersistedStateModule.readPersistedString);
  const updatePersistedStateSpy = spyOn(
    PersistedStateModule,
    "updatePersistedState"
  ).mockImplementation(
    updatePersistedStateMock as typeof PersistedStateModule.updatePersistedState
  );

  return () => {
    readPersistedStateSpy.mockRestore();
    readPersistedStringSpy.mockRestore();
    updatePersistedStateSpy.mockRestore();
  };
}

interface DraftSettingsInvocation {
  projectPath: string;
  branches: string[];
  recommendedTrunk: string | null;
}
let draftSettingsInvocations: DraftSettingsInvocation[] = [];
let draftSettingsState: DraftSettingsHarness;
const useDraftWorkspaceSettingsMock = mock(
  (projectPath: string, branches: string[], recommendedTrunk: string | null) => {
    draftSettingsInvocations.push({ projectPath, branches, recommendedTrunk });
    if (!draftSettingsState) {
      throw new Error("Draft settings state not initialized");
    }
    return draftSettingsState.snapshot();
  }
);

const actualAPIModule = { ...APIModule };
const actualDraftWorkspaceSettingsModule = { ...DraftWorkspaceSettingsModule };
const actualProjectContextModule = { ...ProjectContextModule };
const actualRouterContextModule = { ...RouterContextModule };

let currentORPCClient: MockOrpcClient | null = null;
const noop = () => undefined;
const routerState = {
  currentWorkspaceId: null as string | null,
  currentProjectId: null as string | null,
  pendingDraftId: null as string | null,
};

// Synchronous mock for useProjectContext — eliminates the async race from
// ProjectProvider's useEffect → refreshProjects() that caused CI-only hangs.
// Tests that need untrusted projects set mockProjectConfigMap directly.
let mockProjectConfigMap = new Map<string, ProjectConfig>();

// Keep module mocks inside test hooks: Bun loads test files before afterAll runs, so
// file-scope mock.module() calls can pollute unrelated files during collection.
async function installUseCreationWorkspaceModuleMocks() {
  await mock.module("@/browser/hooks/useDraftWorkspaceSettings", () => ({
    ...actualDraftWorkspaceSettingsModule,
    useDraftWorkspaceSettings: useDraftWorkspaceSettingsMock,
  }));
  await mock.module("@/browser/contexts/RouterContext", () => ({
    ...actualRouterContextModule,
    useRouter: () => ({
      navigateToWorkspace: noop,
      navigateToProject: noop,
      navigateToHome: noop,
      currentWorkspaceId: routerState.currentWorkspaceId,
      currentProjectId: routerState.currentProjectId,
      currentProjectPathFromState: null,
      pendingSectionId: null,
      pendingDraftId: routerState.pendingDraftId,
    }),
  }));
  await mock.module("@/browser/contexts/API", () => ({
    ...actualAPIModule,
    useAPI: () => {
      if (!currentORPCClient) {
        return { api: null, status: "connecting" as const, error: null };
      }
      return {
        api: currentORPCClient as APIClient,
        status: "connected" as const,
        error: null,
      };
    },
  }));
  await mock.module("@/browser/contexts/ProjectContext", () => ({
    ...actualProjectContextModule,
    useProjectContext: () => ({
      loading: false,
      getProjectConfig: (path: string) => mockProjectConfigMap.get(path),
      refreshProjects: mock(() => Promise.resolve()),
      userProjects: mockProjectConfigMap,
      hasAnyProject: mockProjectConfigMap.size > 0,
      systemProjectPath: null,
      resolveProjectPath: () => null,
      addProject: noop,
      removeProject: mock(() => Promise.resolve({ success: true })),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: noop,
      closeProjectCreateModal: noop,
      workspaceModalState: { isOpen: false },
      openWorkspaceModal: mock(() => Promise.resolve()),
      closeWorkspaceModal: noop,
      getBranchesForProject: mock(() => Promise.resolve({ branches: [], recommendedTrunk: null })),
      getSecrets: mock(() => Promise.resolve([])),
      updateSecrets: mock(() => Promise.resolve()),
      updateDisplayName: mock(() => Promise.resolve({ success: true })),
      createSection: mock(() => Promise.resolve({ success: true })),
      updateSection: mock(() => Promise.resolve({ success: true })),
      removeSection: mock(() => Promise.resolve({ success: true })),
      reorderSections: mock(() => Promise.resolve({ success: true })),
      assignWorkspaceToSection: mock(() => Promise.resolve({ success: true })),
      resolveNewChatProjectPath: () => null,
    }),
    ProjectProvider: (props: Record<string, unknown>) => props.children,
  }));
}

async function restoreUseCreationWorkspaceModuleMocks() {
  // Bun's mock.module() has no disposer, and mock.restore() does not undo module
  // mocks. Restore the real exports so these stubs do not leak into later files.
  await mock.module(
    "@/browser/hooks/useDraftWorkspaceSettings",
    () => actualDraftWorkspaceSettingsModule
  );
  await mock.module("@/browser/contexts/RouterContext", () => actualRouterContextModule);
  await mock.module("@/browser/contexts/API", () => actualAPIModule);
  await mock.module("@/browser/contexts/ProjectContext", () => actualProjectContextModule);
}

const TEST_PROJECT_PATH = "/projects/demo";
const FALLBACK_BRANCH = "main";
const TEST_WORKSPACE_ID = "ws-created";
type BranchListResult = Awaited<ReturnType<APIClient["projects"]["listBranches"]>>;
type ProjectListResult = Awaited<ReturnType<APIClient["projects"]["list"]>>;
type ListBranchesArgs = Parameters<APIClient["projects"]["listBranches"]>[0];
type WorkspaceSendMessageArgs = Parameters<APIClient["workspace"]["sendMessage"]>[0];
type WorkspaceSendMessageResult = Awaited<ReturnType<APIClient["workspace"]["sendMessage"]>>;
type WorkspaceCreateArgs = Parameters<APIClient["workspace"]["create"]>[0];
type WorkspaceUpdateAgentAISettingsArgs = Parameters<
  APIClient["workspace"]["updateAgentAISettings"]
>[0];
type WorkspaceUpdateAgentAISettingsResult = Awaited<
  ReturnType<APIClient["workspace"]["updateAgentAISettings"]>
>;
type WorkspaceGetGoalArgs = Parameters<APIClient["workspace"]["getGoal"]>[0];
type WorkspaceGetGoalResult = Awaited<ReturnType<APIClient["workspace"]["getGoal"]>>;
type WorkspaceSetGoalArgs = Parameters<APIClient["workspace"]["setGoal"]>[0];
type WorkspaceSetGoalResult = Awaited<ReturnType<APIClient["workspace"]["setGoal"]>>;
type WorkflowStartArgs = Parameters<APIClient["workflows"]["start"]>[0];
type WorkflowStartResult = Awaited<ReturnType<APIClient["workflows"]["start"]>>;
type WorkflowGetRunArgs = Parameters<APIClient["workflows"]["getRun"]>[0];
type WorkflowGetRunResult = Awaited<ReturnType<APIClient["workflows"]["getRun"]>>;
type WorkspaceCreateScratchArgs = Parameters<APIClient["workspace"]["createScratch"]>[0];
type WorkspaceCreateScratchResult = Awaited<ReturnType<APIClient["workspace"]["createScratch"]>>;
type WorkspaceCreateResult = Awaited<ReturnType<APIClient["workspace"]["create"]>>;
type NameGenerationArgs = Parameters<APIClient["nameGeneration"]["generate"]>[0];
type NameGenerationResult = Awaited<ReturnType<APIClient["nameGeneration"]["generate"]>>;
type WorkspaceStageAttachmentArgs = Parameters<APIClient["workspace"]["stageAttachment"]>[0];
type WorkspaceStageAttachmentResult = Awaited<
  ReturnType<APIClient["workspace"]["stageAttachment"]>
>;
type MockOrpcProjectsClient = Pick<
  APIClient["projects"],
  "list" | "listBranches" | "runtimeAvailability" | "setTrust"
>;
type MockOrpcWorkspaceClient = Pick<
  APIClient["workspace"],
  | "sendMessage"
  | "create"
  | "createScratch"
  | "updateAgentAISettings"
  | "getGoal"
  | "setGoal"
  | "stageAttachment"
>;
type MockOrpcWorkflowsClient = Pick<APIClient["workflows"], "start" | "getRun">;
type MockOrpcNameGenerationClient = Pick<APIClient["nameGeneration"], "generate">;
type WindowWithApi = Window & typeof globalThis;
type WindowApi = WindowWithApi["api"];

function rejectNotImplemented(method: string) {
  return (..._args: unknown[]): Promise<never> =>
    Promise.reject(new Error(`${method} is not implemented in useCreationWorkspace tests`));
}

function throwNotImplemented(method: string) {
  return (..._args: unknown[]): never => {
    throw new Error(`${method} is not implemented in useCreationWorkspace tests`);
  };
}

const noopUnsubscribe = () => () => undefined;
interface MockOrpcClient {
  projects: MockOrpcProjectsClient;
  workspace: MockOrpcWorkspaceClient;
  workflows: MockOrpcWorkflowsClient;
  nameGeneration: MockOrpcNameGenerationClient;
}
interface SetupWindowOptions {
  listProjects?: ReturnType<typeof mock<() => Promise<ProjectListResult>>>;
  listBranches?: ReturnType<typeof mock<(args: ListBranchesArgs) => Promise<BranchListResult>>>;
  sendMessage?: ReturnType<
    typeof mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>
  >;
  updateAgentAISettings?: ReturnType<
    typeof mock<
      (args: WorkspaceUpdateAgentAISettingsArgs) => Promise<WorkspaceUpdateAgentAISettingsResult>
    >
  >;
  getGoal?: ReturnType<
    typeof mock<(args: WorkspaceGetGoalArgs) => Promise<WorkspaceGetGoalResult>>
  >;
  setGoal?: ReturnType<
    typeof mock<(args: WorkspaceSetGoalArgs) => Promise<WorkspaceSetGoalResult>>
  >;
  workflowStart?: ReturnType<
    typeof mock<(args: WorkflowStartArgs) => Promise<WorkflowStartResult>>
  >;
  workflowGetRun?: ReturnType<
    typeof mock<(args: WorkflowGetRunArgs) => Promise<WorkflowGetRunResult>>
  >;
  createScratch?: ReturnType<
    typeof mock<(args: WorkspaceCreateScratchArgs) => Promise<WorkspaceCreateScratchResult>>
  >;
  create?: ReturnType<typeof mock<(args: WorkspaceCreateArgs) => Promise<WorkspaceCreateResult>>>;
  nameGeneration?: ReturnType<
    typeof mock<(args: NameGenerationArgs) => Promise<NameGenerationResult>>
  >;
  stageAttachment?: ReturnType<
    typeof mock<(args: WorkspaceStageAttachmentArgs) => Promise<WorkspaceStageAttachmentResult>>
  >;
}

const setupWindow = ({
  listProjects,
  listBranches,
  sendMessage,
  create,
  createScratch,
  updateAgentAISettings,
  getGoal,
  setGoal,
  workflowStart,
  workflowGetRun,
  nameGeneration,
  stageAttachment,
}: SetupWindowOptions = {}) => {
  // Sync the useProjectContext mock with the default trusted config.
  // Tests that need untrusted projects override mockProjectConfigMap directly.
  if (!listProjects && mockProjectConfigMap.get(TEST_PROJECT_PATH)?.trusted !== false) {
    mockProjectConfigMap = new Map([[TEST_PROJECT_PATH, { workspaces: [], trusted: true }]]);
  }

  const listProjectsMock =
    listProjects ??
    mock<() => Promise<ProjectListResult>>(() => {
      const trustedProjectConfig: ProjectConfig = {
        workspaces: [],
        trusted: true,
      };
      return Promise.resolve([[TEST_PROJECT_PATH, trustedProjectConfig]]);
    });

  const listBranchesMock =
    listBranches ??
    mock<(args: ListBranchesArgs) => Promise<BranchListResult>>(({ projectPath }) => {
      if (!projectPath) {
        throw new Error("listBranches mock requires projectPath");
      }
      return Promise.resolve({
        branches: [FALLBACK_BRANCH],
        recommendedTrunk: FALLBACK_BRANCH,
      });
    });

  const sendMessageMock =
    sendMessage ??
    mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>(() => {
      const result: WorkspaceSendMessageResult = {
        success: true,
        data: {},
      };
      return Promise.resolve(result);
    });

  const getGoalMock =
    getGoal ??
    mock<(args: WorkspaceGetGoalArgs) => Promise<WorkspaceGetGoalResult>>(() => {
      return Promise.resolve({ goal: null } as WorkspaceGetGoalResult);
    });

  const setGoalMock =
    setGoal ??
    mock<(args: WorkspaceSetGoalArgs) => Promise<WorkspaceSetGoalResult>>(() => {
      return Promise.resolve({
        success: true,
        data: {
          goalId: "33333333-3333-4333-8333-333333333333",
          objective: "test goal",
          status: "active",
        },
      } as WorkspaceSetGoalResult);
    });

  const workflowStartMock =
    workflowStart ??
    mock<(args: WorkflowStartArgs) => Promise<WorkflowStartResult>>(() => {
      return Promise.resolve({
        runId: "wfr_test",
        status: "running",
        result: null,
      } as WorkflowStartResult);
    });

  const workflowGetRunMock =
    workflowGetRun ??
    mock<(args: WorkflowGetRunArgs) => Promise<WorkflowGetRunResult>>(() => {
      return Promise.resolve(null as WorkflowGetRunResult);
    });

  const createMock =
    create ??
    mock<(args: WorkspaceCreateArgs) => Promise<WorkspaceCreateResult>>(() => {
      return Promise.resolve({
        success: true,
        metadata: TEST_METADATA,
      } as WorkspaceCreateResult);
    });

  const createScratchMock =
    createScratch ??
    mock<(args: WorkspaceCreateScratchArgs) => Promise<WorkspaceCreateScratchResult>>(() => {
      return Promise.resolve({
        success: true,
        metadata: { ...TEST_METADATA, kind: "scratch" },
      } as WorkspaceCreateScratchResult);
    });

  const updateAgentAISettingsMock =
    updateAgentAISettings ??
    mock<
      (args: WorkspaceUpdateAgentAISettingsArgs) => Promise<WorkspaceUpdateAgentAISettingsResult>
    >(() => {
      return Promise.resolve({
        success: true,
        data: undefined,
      } as WorkspaceUpdateAgentAISettingsResult);
    });

  const nameGenerationMock =
    nameGeneration ??
    mock<(args: NameGenerationArgs) => Promise<NameGenerationResult>>(() => {
      return Promise.resolve({
        success: true,
        data: {
          name: "test-workspace",
          modelUsed: "anthropic:claude-haiku-4-5",
        },
      } as NameGenerationResult);
    });

  const stageAttachmentMock =
    stageAttachment ??
    mock<(args: WorkspaceStageAttachmentArgs) => Promise<WorkspaceStageAttachmentResult>>(
      (args) => {
        return Promise.resolve({
          success: true,
          data: {
            filename: args.filename,
            mediaType: args.mediaType ?? "application/octet-stream",
            sizeBytes: args.sizeBytes,
            stagedPath: `.mux/user-attachments/uuid/${args.filename}`,
          },
        } as WorkspaceStageAttachmentResult);
      }
    );

  currentORPCClient = {
    projects: {
      list: () => listProjectsMock(),
      listBranches: (input: ListBranchesArgs) => listBranchesMock(input),
      runtimeAvailability: () =>
        Promise.resolve({
          local: { available: true },
          worktree: { available: true },
          ssh: { available: true },
          docker: { available: true },
          devcontainer: { available: false, reason: "No devcontainer.json found" },
        }),
      setTrust: mock(() => Promise.resolve()),
    },
    workspace: {
      sendMessage: (input: WorkspaceSendMessageArgs) => sendMessageMock(input),
      create: (input: WorkspaceCreateArgs) => createMock(input),
      createScratch: (input: WorkspaceCreateScratchArgs) => createScratchMock(input),
      updateAgentAISettings: (input: WorkspaceUpdateAgentAISettingsArgs) =>
        updateAgentAISettingsMock(input),
      getGoal: (input: WorkspaceGetGoalArgs) => getGoalMock(input),
      setGoal: (input: WorkspaceSetGoalArgs) => setGoalMock(input),
      stageAttachment: (input: WorkspaceStageAttachmentArgs) => stageAttachmentMock(input),
    },
    workflows: {
      start: (input: WorkflowStartArgs) => workflowStartMock(input),
      getRun: (input: WorkflowGetRunArgs) => workflowGetRunMock(input),
    },
    nameGeneration: {
      generate: (input: NameGenerationArgs) => nameGenerationMock(input),
    },
  };

  const windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as WindowWithApi;
  const windowWithApi = globalThis.window as WindowWithApi;

  const apiMock: WindowApi = {
    tokenizer: {
      countTokens: rejectNotImplemented("tokenizer.countTokens"),
      countTokensBatch: rejectNotImplemented("tokenizer.countTokensBatch"),
      calculateStats: rejectNotImplemented("tokenizer.calculateStats"),
    },
    providers: {
      setProviderConfig: rejectNotImplemented("providers.setProviderConfig"),
    },
    projects: {
      create: rejectNotImplemented("projects.create"),
      pickDirectory: rejectNotImplemented("projects.pickDirectory"),
      remove: rejectNotImplemented("projects.remove"),
      list: rejectNotImplemented("projects.list"),
      listBranches: (projectPath: string) => listBranchesMock({ projectPath }),
      secrets: {
        get: rejectNotImplemented("projects.secrets.get"),
        update: rejectNotImplemented("projects.secrets.update"),
      },
    },
    nameGeneration: {
      generate: (args: NameGenerationArgs) => nameGenerationMock(args),
    },
    workspace: {
      list: rejectNotImplemented("workspace.list"),
      create: (args: WorkspaceCreateArgs) => createMock(args),
      createScratch: (args: WorkspaceCreateScratchArgs) => createScratchMock(args),
      updateAgentAISettings: (args: WorkspaceUpdateAgentAISettingsArgs) =>
        updateAgentAISettingsMock(args),
      remove: rejectNotImplemented("workspace.remove"),
      rename: rejectNotImplemented("workspace.rename"),
      fork: rejectNotImplemented("workspace.fork"),
      sendMessage: (
        workspaceId: WorkspaceSendMessageArgs["workspaceId"],
        message: WorkspaceSendMessageArgs["message"],
        options: WorkspaceSendMessageArgs["options"]
      ) => sendMessageMock({ workspaceId, message, options }),
      resumeStream: rejectNotImplemented("workspace.resumeStream"),
      interruptStream: rejectNotImplemented("workspace.interruptStream"),
      clearQueue: rejectNotImplemented("workspace.clearQueue"),
      truncateHistory: rejectNotImplemented("workspace.truncateHistory"),
      replaceChatHistory: rejectNotImplemented("workspace.replaceChatHistory"),
      getInfo: rejectNotImplemented("workspace.getInfo"),
      executeBash: rejectNotImplemented("workspace.executeBash"),
      openTerminal: rejectNotImplemented("workspace.openTerminal"),
      onChat: (_workspaceId: string, _callback: (data: WorkspaceChatMessage) => void) =>
        noopUnsubscribe(),
      onMetadata: (
        _callback: (data: { workspaceId: string; metadata: FrontendWorkspaceMetadata }) => void
      ) => noopUnsubscribe(),
      activity: {
        list: rejectNotImplemented("workspace.activity.list"),
        subscribe: (
          _callback: (payload: {
            workspaceId: string;
            activity: WorkspaceActivitySnapshot | null;
          }) => void
        ) => noopUnsubscribe(),
      },
    },
    window: {
      setTitle: rejectNotImplemented("window.setTitle"),
    },
    terminal: {
      create: rejectNotImplemented("terminal.create"),
      close: rejectNotImplemented("terminal.close"),
      resize: rejectNotImplemented("terminal.resize"),
      sendInput: throwNotImplemented("terminal.sendInput"),
      onOutput: () => noopUnsubscribe(),
      onExit: () => noopUnsubscribe(),
      openWindow: rejectNotImplemented("terminal.openWindow"),
      closeWindow: rejectNotImplemented("terminal.closeWindow"),
    },
    update: {
      check: rejectNotImplemented("update.check"),
      download: rejectNotImplemented("update.download"),
      install: throwNotImplemented("update.install"),
      onStatus: () => noopUnsubscribe(),
    },
    platform: "linux",
    versions: {
      node: "0",
      chrome: "0",
      electron: "0",
    },
  };

  windowWithApi.api = apiMock;

  globalThis.document = windowInstance.document as unknown as Document;
  globalThis.localStorage = windowInstance.localStorage as unknown as Storage;

  return {
    projectsApi: { listBranches: listBranchesMock },
    workspaceApi: {
      sendMessage: sendMessageMock,
      create: createMock,
      createScratch: createScratchMock,
      updateAgentAISettings: updateAgentAISettingsMock,
      getGoal: getGoalMock,
      setGoal: setGoalMock,
      stageAttachment: stageAttachmentMock,
    },
    workflowsApi: { start: workflowStartMock, getRun: workflowGetRunMock },
    nameGenerationApi: { generate: nameGenerationMock },
  };
};
const TEST_METADATA: FrontendWorkspaceMetadata = {
  id: TEST_WORKSPACE_ID,
  name: "demo-branch",
  projectName: "Demo",
  projectPath: TEST_PROJECT_PATH,
  namedWorkspacePath: "/worktrees/demo/demo-branch",
  runtimeConfig: { type: "local", srcBaseDir: "/home/user/.mux/src" },
  createdAt: "2025-01-01T00:00:00.000Z",
};

describe("useCreationWorkspace", () => {
  let restorePersistedStateMocks: (() => void) | null = null;

  afterAll(async () => {
    await restoreUseCreationWorkspaceModuleMocks();
  });

  beforeEach(async () => {
    await installUseCreationWorkspaceModuleMocks();
    restorePersistedStateMocks = installPersistedStateMocks();
    mockProjectConfigMap = new Map([[TEST_PROJECT_PATH, { workspaces: [], trusted: true }]]);
    persistedPreferences = {};
    readPersistedStateCalls.length = 0;
    updatePersistedStateCalls.length = 0;
    draftSettingsInvocations = [];
    draftSettingsState = createDraftSettingsHarness();
    routerState.currentWorkspaceId = null;
    routerState.currentProjectId = null;
    routerState.pendingDraftId = null;
  });

  afterEach(async () => {
    cleanup();
    restorePersistedStateMocks?.();
    restorePersistedStateMocks = null;
    await restoreUseCreationWorkspaceModuleMocks();
    mock.restore();
    // Reset global window/document/localStorage between tests
    // @ts-expect-error - test cleanup
    globalThis.window = undefined;
    // @ts-expect-error - test cleanup
    globalThis.document = undefined;
    // @ts-expect-error - test cleanup
    globalThis.localStorage = undefined;
  });

  test("loads branches when projectPath is provided", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main", "dev"],
          recommendedTrunk: "dev",
        })
    );
    const { projectsApi } = setupWindow({ listBranches: listBranchesMock });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
    });

    await waitFor(() => expect(projectsApi.listBranches.mock.calls.length).toBe(1));
    // ORPC uses object argument
    expect(projectsApi.listBranches.mock.calls[0][0]).toEqual({ projectPath: TEST_PROJECT_PATH });

    await waitFor(() => expect(getHook().branches).toEqual(["main", "dev"]));
    expect(draftSettingsInvocations[0]).toEqual({
      projectPath: TEST_PROJECT_PATH,
      branches: [],
      recommendedTrunk: null,
    });
    expect(draftSettingsInvocations.at(-1)).toEqual({
      projectPath: TEST_PROJECT_PATH,
      branches: ["main", "dev"],
      recommendedTrunk: "dev",
    });
    expect(getHook().trunkBranch).toBe(draftSettingsState.state.trunkBranch);
  });

  test("does not load branches when projectPath is empty", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    setupWindow({ listBranches: listBranchesMock });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: "",
      onWorkspaceCreated,
    });

    await waitFor(() => expect(draftSettingsInvocations.length).toBeGreaterThan(0));
    expect(listBranchesMock.mock.calls.length).toBe(0);
    expect(getHook().branches).toEqual([]);
  });

  test("scratch creation skips project loading and uses createScratch", async () => {
    const listBranchesMock = mock(() =>
      Promise.reject(new Error("scratch creation should not load branches"))
    );
    const scratchMetadata: FrontendWorkspaceMetadata = {
      ...TEST_METADATA,
      kind: "scratch",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-created",
      namedWorkspacePath: "/tmp/mux/scratch/ws-created",
      runtimeConfig: { type: "local" },
    };
    const createScratchMock = mock(
      (_args: WorkspaceCreateScratchArgs): Promise<WorkspaceCreateScratchResult> =>
        Promise.resolve({ success: true, metadata: scratchMetadata })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.reject(new Error("regular create should not run"))
    );
    const { workspaceApi } = setupWindow({
      listBranches: listBranchesMock,
      create: createMock,
      createScratch: createScratchMock,
    });
    const onWorkspaceCreated = mock(
      (metadata: FrontendWorkspaceMetadata, _options?: WorkspaceCreatedOptions) => metadata
    );
    const getHook = renderUseCreationWorkspace({
      kind: "scratch",
      projectPath: "_scratch",
      onWorkspaceCreated,
      message: "Inspect this idea",
    });

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend("Inspect this idea");
    });

    expect(result).toEqual({ success: true });
    expect(listBranchesMock).not.toHaveBeenCalled();
    expect(workspaceApi.create).not.toHaveBeenCalled();
    expect(workspaceApi.createScratch).toHaveBeenCalledTimes(1);
    expect(workspaceApi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: scratchMetadata.id, message: "Inspect this idea" })
    );
    expect(onWorkspaceCreated).toHaveBeenCalledTimes(1);
    expect(onWorkspaceCreated.mock.calls[0]?.[0]).toEqual(scratchMetadata);
    expect(typeof onWorkspaceCreated.mock.calls[0]?.[1]?.pendingStreamModel).toBe("string");
  });

  test("scratch creation skips the devcontainer preflight for a devcontainer default runtime", async () => {
    // Scratch never loads runtime availability, so the devcontainer preflight
    // would otherwise block forever in the "loading" availability state.
    draftSettingsState = createDraftSettingsHarness({
      selectedRuntime: { mode: "devcontainer", configPath: "" },
    });
    const scratchMetadata: FrontendWorkspaceMetadata = {
      ...TEST_METADATA,
      kind: "scratch",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-created",
      namedWorkspacePath: "/tmp/mux/scratch/ws-created",
      runtimeConfig: { type: "local" },
    };
    const createScratchMock = mock(
      (_args: WorkspaceCreateScratchArgs): Promise<WorkspaceCreateScratchResult> =>
        Promise.resolve({ success: true, metadata: scratchMetadata })
    );
    const { workspaceApi } = setupWindow({ createScratch: createScratchMock });
    const onWorkspaceCreated = mock(
      (metadata: FrontendWorkspaceMetadata, _options?: WorkspaceCreatedOptions) => metadata
    );
    const getHook = renderUseCreationWorkspace({
      kind: "scratch",
      projectPath: "_scratch",
      onWorkspaceCreated,
      message: "Inspect this idea",
    });

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend("Inspect this idea");
    });

    expect(result).toEqual({ success: true });
    expect(workspaceApi.createScratch).toHaveBeenCalledTimes(1);
  });

  test("handleSend creates workspace and sends message on success", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: true as const,
          data: {},
        })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    persistedPreferences[getAgentIdKey(getProjectScopeId(TEST_PROJECT_PATH))] = "plan";
    // Set model preference for the project scope (read by getSendOptionsFromStorage)
    persistedPreferences[getModelKey(getProjectScopeId(TEST_PROJECT_PATH))] = "gpt-4";

    draftSettingsState = createDraftSettingsHarness({
      selectedRuntime: { mode: "ssh", host: "example.com" },
      runtimeString: "ssh example.com",
      trunkBranch: "dev",
    });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "launch workspace",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    // Wait for name generation to trigger (happens on debounce)
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("launch workspace");
    });

    expect(handleSendResult).toEqual({ success: true });

    // workspace.create should be called with the generated name
    expect(workspaceApi.create.mock.calls.length).toBe(1);
    const createCall = workspaceApi.create.mock.calls[0];
    if (!createCall) {
      throw new Error("Expected workspace.create to be called at least once");
    }
    const [createRequest] = createCall;
    expect(createRequest?.branchName).toBe("generated-name");
    expect(createRequest?.trunkBranch).toBe("dev");
    expect(createRequest?.runtimeConfig).toEqual({
      type: "ssh",
      host: "example.com",
      // SSH remotes keep the stable ~/mux layout; local Xum home is separate.
      srcBaseDir: "~/mux",
    });

    // workspace.sendMessage should be called with the created workspace ID
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);
    const sendCall = workspaceApi.sendMessage.mock.calls[0];
    if (!sendCall) {
      throw new Error("Expected workspace.sendMessage to be called at least once");
    }
    const [sendRequest] = sendCall;
    expect(sendRequest?.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(sendRequest?.message).toBe("launch workspace");

    await waitFor(() => expect(onWorkspaceCreated.mock.calls.length).toBe(1));
    expect(onWorkspaceCreated.mock.calls[0][0]).toEqual(TEST_METADATA);

    const pendingScopeId = getPendingScopeId(TEST_PROJECT_PATH);
    const pendingInputKey = getInputKey(pendingScopeId);
    const pendingImagesKey = getInputAttachmentsKey(pendingScopeId);
    // Thinking is workspace-scoped, but this test doesn't set a project-scoped thinking preference.
    expect(updatePersistedStateCalls).toContainEqual([pendingInputKey, ""]);
    expect(updatePersistedStateCalls).toContainEqual([pendingImagesKey, undefined]);
  });

  test("handleSend stages pending files after create and appends the attached-files notice", async () => {
    const callOrder: string[] = [];
    const createMock = mock((_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> => {
      callOrder.push("create");
      return Promise.resolve({ success: true, metadata: TEST_METADATA } as WorkspaceCreateResult);
    });
    const lockObservedDuringStaging: boolean[] = [];
    const stageAttachmentMock = mock(
      (args: WorkspaceStageAttachmentArgs): Promise<WorkspaceStageAttachmentResult> => {
        callOrder.push(`stage:${args.filename}`);
        lockObservedDuringStaging.push(isInitialStagingLocked(TEST_WORKSPACE_ID));
        return Promise.resolve({
          success: true,
          data: {
            filename: args.filename,
            mediaType: args.mediaType ?? "application/octet-stream",
            sizeBytes: args.sizeBytes,
            stagedPath: `.mux/user-attachments/uuid/${args.filename}`,
          },
        } as WorkspaceStageAttachmentResult);
      }
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> => {
        callOrder.push("send");
        return Promise.resolve({ success: true as const, data: {} });
      }
    );
    const { workspaceApi } = setupWindow({
      create: createMock,
      sendMessage: sendMessageMock,
      stageAttachment: stageAttachmentMock,
    });

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated: mock((metadata: FrontendWorkspaceMetadata) => {
        callOrder.push("navigate");
        return metadata;
      }),
      message: "check these files",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    const pendingFiles: PendingFileChatAttachment[] = [
      {
        kind: "pending-file",
        id: "p1",
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        dataBase64: "bWFya2Rvd24=",
      },
      {
        kind: "pending-file",
        id: "p2",
        filename: "data.bin",
        mediaType: "application/octet-stream",
        sizeBytes: 3,
        dataBase64: "Ymlu",
      },
    ];

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend(
        "check these files",
        undefined,
        undefined,
        undefined,
        pendingFiles
      );
    });

    expect(result).toEqual({ success: true });
    // Navigation must not wait on staging: stageAttachment blocks on runtime
    // init, which can take minutes on deferred runtimes.
    expect(callOrder).toEqual(["create", "navigate", "stage:notes.md", "stage:data.bin", "send"]);
    // The composer lock is held during staging and released once the send is done.
    expect(lockObservedDuringStaging).toEqual([true, true]);
    expect(isInitialStagingLocked(TEST_WORKSPACE_ID)).toBe(false);
    expect(workspaceApi.stageAttachment.mock.calls[0]?.[0]?.workspaceId).toBe(TEST_WORKSPACE_ID);

    const sendRequest = workspaceApi.sendMessage.mock.calls[0]?.[0];
    expect(sendRequest?.message).toContain("check these files");
    expect(sendRequest?.message).toContain(".mux/user-attachments/uuid/notes.md");
    expect(sendRequest?.message).toContain(".mux/user-attachments/uuid/data.bin");
  });

  test("handleSend fails closed when staging fails and transfers the draft to the workspace", async () => {
    const stageAttachmentMock = mock(
      (args: WorkspaceStageAttachmentArgs): Promise<WorkspaceStageAttachmentResult> => {
        if (args.filename === "bad.bin") {
          return Promise.resolve({
            success: false,
            error: "disk full",
          } as WorkspaceStageAttachmentResult);
        }
        return Promise.resolve({
          success: true,
          data: {
            filename: args.filename,
            mediaType: args.mediaType ?? "application/octet-stream",
            sizeBytes: args.sizeBytes,
            stagedPath: `.mux/user-attachments/uuid/${args.filename}`,
          },
        } as WorkspaceStageAttachmentResult);
      }
    );
    const onWorkspaceCreated = mock(
      (metadata: FrontendWorkspaceMetadata, _options?: WorkspaceCreatedOptions) => metadata
    );
    const clearPendingInitialSendSpy = spyOn(workspaceStore, "clearPendingInitialSendState");
    const { workspaceApi } = setupWindow({ stageAttachment: stageAttachmentMock });

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "review my files",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    const good: PendingFileChatAttachment = {
      kind: "pending-file",
      id: "p1",
      filename: "good.md",
      mediaType: "text/markdown",
      sizeBytes: 8,
      dataBase64: "bWFya2Rvd24=",
    };
    const bad: PendingFileChatAttachment = {
      kind: "pending-file",
      id: "p2",
      filename: "bad.bin",
      mediaType: "application/octet-stream",
      sizeBytes: 3,
      dataBase64: "Ymlu",
    };

    let result: CreationSendResult | undefined;
    await act(async () => {
      // Simulates a slash-skill send: messageText is the rewritten skill text
      // while muxMetadata.rawCommand preserves the original typed command.
      result = await getHook().handleSend(
        "review my files",
        undefined,
        {
          muxMetadata: {
            type: "agent-skill",
            rawCommand: "/review my files",
            commandPrefix: "/review",
            skillName: "review",
            scope: "project",
          },
          disableWorkspaceAgents: true,
        },
        undefined,
        [good, bad]
      );
    });

    expect(result).toEqual({ success: false });
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(0);

    // The transferred draft restores the original slash command so a retry
    // re-invokes the skill, and preserves the forced project-path discovery.
    expect(updatePersistedStateCalls).toContainEqual([
      getInputKey(TEST_WORKSPACE_ID),
      "/review my files",
    ]);
    expect(updatePersistedStateCalls).toContainEqual([
      getPendingDraftSkillDiscoveryKey(TEST_WORKSPACE_ID),
      true,
    ]);
    const attachmentsWrite = updatePersistedStateCalls.find(
      ([key]) => key === getInputAttachmentsKey(TEST_WORKSPACE_ID)
    );
    expect(attachmentsWrite?.[1]).toEqual([
      {
        kind: "staged",
        id: "p1",
        filename: "good.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        stagedPath: ".mux/user-attachments/uuid/good.md",
      },
      bad,
    ]);
    const errorWrite = updatePersistedStateCalls.find(
      ([key]) => key === getPendingWorkspaceSendErrorKey(TEST_WORKSPACE_ID)
    );
    expect(errorWrite?.[1]).toMatchObject({ type: "unknown" });
    expect((errorWrite?.[1] as { raw: string }).raw).toContain("bad.bin: disk full");

    // Navigation happens optimistically before staging; the pending-send
    // barrier is cleared once staging fails.
    expect(onWorkspaceCreated.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls[0][1]).toMatchObject({ markPendingInitialSend: true });
    expect(clearPendingInitialSendSpy.mock.calls).toContainEqual([TEST_WORKSPACE_ID]);
    clearPendingInitialSendSpy.mockRestore();

    const pendingScopeId = getPendingScopeId(TEST_PROJECT_PATH);
    expect(updatePersistedStateCalls).toContainEqual([getInputKey(pendingScopeId), ""]);
  });

  test("handleSend transfers the staged draft when the first send fails after staging", async () => {
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: false as const,
          error: { type: "unknown", raw: "provider exploded" },
        })
    );
    const { workspaceApi } = setupWindow({ sendMessage: sendMessageMock });

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated: mock((metadata: FrontendWorkspaceMetadata) => metadata),
      message: "send my files",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    const pendingFile: PendingFileChatAttachment = {
      kind: "pending-file",
      id: "p1",
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: 8,
      dataBase64: "bWFya2Rvd24=",
    };

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend("send my files", undefined, undefined, undefined, [
        pendingFile,
      ]);
    });

    expect(result).toMatchObject({ success: false });
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);

    // Staged files live in the new workspace; the draft must be transferred so
    // the user can retry the send with the chips/notice intact.
    expect(updatePersistedStateCalls).toContainEqual([
      getInputKey(TEST_WORKSPACE_ID),
      "send my files",
    ]);
    const attachmentsWrite = updatePersistedStateCalls.find(
      ([key]) => key === getInputAttachmentsKey(TEST_WORKSPACE_ID)
    );
    expect(attachmentsWrite?.[1]).toEqual([
      {
        kind: "staged",
        id: "p1",
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        stagedPath: ".mux/user-attachments/uuid/notes.md",
      },
    ]);
    const errorWrite = updatePersistedStateCalls.find(
      ([key]) => key === getPendingWorkspaceSendErrorKey(TEST_WORKSPACE_ID)
    );
    expect(errorWrite?.[1]).toMatchObject({ type: "unknown", raw: "provider exploded" });
  });

  test("handleSend transfers the staged draft when the first send rejects after staging", async () => {
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.reject(new Error("orpc disconnected"))
    );
    const { workspaceApi } = setupWindow({ sendMessage: sendMessageMock });

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated: mock((metadata: FrontendWorkspaceMetadata) => metadata),
      message: "send my files",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    const pendingFile: PendingFileChatAttachment = {
      kind: "pending-file",
      id: "p1",
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: 8,
      dataBase64: "bWFya2Rvd24=",
    };

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend("send my files", undefined, undefined, undefined, [
        pendingFile,
      ]);
    });

    expect(result).toMatchObject({ success: false });
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);

    expect(updatePersistedStateCalls).toContainEqual([
      getInputKey(TEST_WORKSPACE_ID),
      "send my files",
    ]);
    const attachmentsWrite = updatePersistedStateCalls.find(
      ([key]) => key === getInputAttachmentsKey(TEST_WORKSPACE_ID)
    );
    expect(attachmentsWrite?.[1]).toEqual([
      {
        kind: "staged",
        id: "p1",
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        stagedPath: ".mux/user-attachments/uuid/notes.md",
      },
    ]);
    const errorWrite = updatePersistedStateCalls.find(
      ([key]) => key === getPendingWorkspaceSendErrorKey(TEST_WORKSPACE_ID)
    );
    expect(errorWrite?.[1]).toMatchObject({ type: "unknown", raw: "orpc disconnected" });
  });

  test("handleSend keeps small retryable files when trimming an over-cap transfer", async () => {
    const stageAttachmentMock = mock(
      (_args: WorkspaceStageAttachmentArgs): Promise<WorkspaceStageAttachmentResult> =>
        Promise.resolve({ success: false, error: "disk full" } as WorkspaceStageAttachmentResult)
    );
    setupWindow({ stageAttachment: stageAttachmentMock });

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated: mock((metadata: FrontendWorkspaceMetadata) => metadata),
      message: "send my files",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    const failedPendingFile: PendingFileChatAttachment = {
      kind: "pending-file",
      id: "p1",
      filename: "small.bin",
      mediaType: "application/octet-stream",
      sizeBytes: 3,
      dataBase64: "Ymlu",
    };
    // A provider attachment whose data URL alone exceeds the persistence cap.
    const oversizedFilePart = {
      type: "file" as const,
      url: `data:application/pdf;base64,${"a".repeat(4_000_001)}`,
      mediaType: "application/pdf",
      filename: "big.pdf",
    };

    let result: CreationSendResult | undefined;
    await act(async () => {
      result = await getHook().handleSend(
        "send my files",
        [oversizedFilePart],
        undefined,
        undefined,
        [failedPendingFile]
      );
    });

    expect(result).toEqual({ success: false });

    // The trim drops only the oversized attachment; the small failed pending
    // file survives so the user can retry staging it.
    const attachmentsWrite = updatePersistedStateCalls.find(
      ([key]) => key === getInputAttachmentsKey(TEST_WORKSPACE_ID)
    );
    expect(attachmentsWrite?.[1]).toEqual([failedPendingFile]);
  });

  test("handleSend creates workspace and applies initial goal command without sending chat text", async () => {
    const setGoalMock = mock(
      (_args: WorkspaceSetGoalArgs): Promise<WorkspaceSetGoalResult> =>
        Promise.resolve({
          success: true,
          data: {
            goalId: "33333333-3333-4333-8333-333333333333",
            objective: "ship the feature",
            status: "active",
          },
        } as WorkspaceSetGoalResult)
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({ success: true, data: {} } as WorkspaceSendMessageResult)
    );
    const { workspaceApi } = setupWindow({ setGoal: setGoalMock, sendMessage: sendMessageMock });

    const onWorkspaceCreated = mock(
      (
        metadata: FrontendWorkspaceMetadata,
        options?: {
          autoNavigate?: boolean;
          pendingStreamModel?: string | null;
          markPendingInitialSend?: boolean;
        }
      ) => ({ metadata, options })
    );
    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "/goal -b 5 ship the feature",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("ship the feature", undefined, undefined, {
        type: "goal-set",
        objective: "ship the feature",
        budgetCents: 500,
      });
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(workspaceApi.create.mock.calls.length).toBe(1);
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(0);
    expect(workspaceApi.updateAgentAISettings.mock.calls.length).toBe(1);
    expect(workspaceApi.updateAgentAISettings).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      agentId: "exec",
      aiSettings: { model: "gpt-4", thinkingLevel: "medium", reasoningMode: "standard" },
      persistSelectedAgentId: true,
    });
    expect(workspaceApi.getGoal.mock.calls.length).toBe(1);
    expect(workspaceApi.setGoal).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      objective: "ship the feature",
      budgetCents: 500,
      turnCap: null,
      expectedGoalId: null,
    });
    expect(onWorkspaceCreated.mock.calls[0][1]).toEqual({
      autoNavigate: true,
      pendingStreamModel: "anthropic:claude-opus-5",
      markPendingInitialSend: false,
    });
  });

  test("handleSend sends workflow-looking creation prompts to the agent", async () => {
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({ success: true, data: {} } as WorkspaceSendMessageResult)
    );
    const { workspaceApi, workflowsApi } = setupWindow({
      sendMessage: sendMessageMock,
    });

    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);
    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      dynamicWorkflowsEnabled: true,
      onWorkspaceCreated,
      message: "/deep-research mux workflows",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("/deep-research mux workflows");
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(workspaceApi.create.mock.calls.length).toBe(1);
    expect(workflowsApi.start).not.toHaveBeenCalled();
    expect(workflowsApi.getRun).not.toHaveBeenCalled();
    expect(workspaceApi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        message: "/deep-research mux workflows",
      })
    );
  });

  test("handleSend uses a deterministic workspace name when AI name generation fails", async () => {
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: false,
          error: { type: "permission_denied", provider: "anthropic", raw: "Forbidden" },
        } as NameGenerationResult)
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({ success: true, data: {} } as WorkspaceSendMessageResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      create: createMock,
      sendMessage: sendMessageMock,
      nameGeneration: nameGenerationMock,
    });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);
    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "/security-scan",
    });

    await waitFor(() => expect(getHook().branches).toEqual([FALLBACK_BRANCH]));
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("/security-scan");
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(workspaceApi.create.mock.calls.length).toBe(1);
    const createRequest = workspaceApi.create.mock.calls[0]?.[0];
    expect(createRequest?.branchName).toBe("security-scan");
    expect(createRequest?.title).toBe("security-scan");
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);
  });

  test("handleSend shows trust dialog for untrusted projects", async () => {
    mockProjectConfigMap = new Map([[TEST_PROJECT_PATH, { workspaces: [], trusted: false }]]);
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      nameGeneration: nameGenerationMock,
    });

    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "main" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "trust check",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    let handleSendPromise: Promise<CreationSendResult> | null = null;
    act(() => {
      handleSendPromise = getHook().handleSend("trust check");
    });

    await waitFor(() => expect(getHook().trustDialog).not.toBeNull());
    expect(workspaceApi.create.mock.calls.length).toBe(0);

    const trustDialog = getHook().trustDialog;
    if (!trustDialog || typeof trustDialog !== "object" || !("props" in trustDialog)) {
      throw new Error("Expected trust dialog props");
    }

    const trustDialogProps = trustDialog.props as {
      onCancel: () => void;
    };

    act(() => {
      trustDialogProps.onCancel();
    });

    // handleSendPromise is assigned inside act() which TypeScript's control flow cannot track
    const handleSendResult = await (handleSendPromise as unknown as Promise<CreationSendResult>);
    expect(handleSendResult).toEqual({ success: false });
    expect(workspaceApi.create.mock.calls.length).toBe(0);
  });

  test("syncs global default agent to workspace when project agent is unset", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: true as const,
          data: {},
        })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    persistedPreferences[getAgentIdKey(GLOBAL_SCOPE_ID)] = "ask";
    persistedPreferences[getModelKey(getProjectScopeId(TEST_PROJECT_PATH))] = "gpt-4";

    draftSettingsState = createDraftSettingsHarness({
      selectedRuntime: { mode: "ssh", host: "example.com" },
      runtimeString: "ssh example.com",
      trunkBranch: "dev",
      agentId: "ask",
    });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "launch workspace",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));
    await waitFor(() => expect(nameGenerationMock.mock.calls.length).toBe(1));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("launch workspace");
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(updatePersistedStateCalls).toContainEqual([getAgentIdKey(TEST_WORKSPACE_ID), "ask"]);

    const sendCall = sendMessageMock.mock.calls[0];
    if (!sendCall) {
      throw new Error("Expected workspace.sendMessage to be called at least once");
    }
    const [sendRequest] = sendCall;
    expect(sendRequest?.options?.agentId).toBe("ask");
  });

  test("handleSend returns failure when sendMessage fails and clears draft", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendError = { type: "api_key_not_found", provider: "openai" } as const;
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: false,
          error: sendError,
        } as WorkspaceSendMessageResult)
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "main" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "test message",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("test message");
    });

    expect(handleSendResult).toEqual({ success: false, error: sendError });
    expect(onWorkspaceCreated.mock.calls.length).toBe(1);

    const pendingScopeId = getPendingScopeId(TEST_PROJECT_PATH);
    const pendingInputKey = getInputKey(pendingScopeId);
    const pendingImagesKey = getInputAttachmentsKey(pendingScopeId);
    const pendingErrorKey = getPendingWorkspaceSendErrorKey(TEST_WORKSPACE_ID);
    expect(updatePersistedStateCalls).toContainEqual([pendingInputKey, ""]);
    expect(updatePersistedStateCalls).toContainEqual([pendingImagesKey, undefined]);
    expect(updatePersistedStateCalls).toContainEqual([pendingErrorKey, sendError]);
  });
  test("onWorkspaceCreated is called before sendMessage resolves (no blocking)", async () => {
    // This test ensures we don't regress #1146 - the fix that makes workspace creation
    // navigate immediately without waiting for sendMessage to complete.
    // Regression occurred in #1896 when sendMessage became awaited again.
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    let resolveSend!: (result: WorkspaceSendMessageResult) => void;
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "main" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "test message",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    let handleSendPromise!: Promise<CreationSendResult>;
    act(() => {
      handleSendPromise = getHook().handleSend("test message");
    });

    await waitFor(() => expect(onWorkspaceCreated.mock.calls.length).toBe(1));
    expect(onWorkspaceCreated.mock.calls[0][0]).toEqual(TEST_METADATA);

    resolveSend({ success: true, data: {} });
    const handleSendResult = await handleSendPromise;
    expect(handleSendResult).toEqual({ success: true });
  });

  test("marks pending initial send only for auto-navigated creations", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({ success: true, data: {} } as WorkspaceSendMessageResult)
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "main" });
    routerState.pendingDraftId = "different-draft";
    const onWorkspaceCreated = mock(
      (
        metadata: FrontendWorkspaceMetadata,
        options?: {
          autoNavigate?: boolean;
          pendingStreamModel?: string | null;
          markPendingInitialSend?: boolean;
        }
      ) => ({
        metadata,
        options,
      })
    );

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "test message",
      draftId: "draft-being-created",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("test message");
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(onWorkspaceCreated.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls[0][1]).toEqual({
      autoNavigate: false,
      pendingStreamModel: null,
      markPendingInitialSend: true,
    });
  });

  test("handleSend passes the pending stream model only for auto-navigated workspaces", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: true as const,
          data: {},
        })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "main" });
    routerState.pendingDraftId = "draft-being-created";
    const onWorkspaceCreated = mock(
      (
        metadata: FrontendWorkspaceMetadata,
        options?: {
          autoNavigate?: boolean;
          pendingStreamModel?: string | null;
          markPendingInitialSend?: boolean;
        }
      ) => ({ metadata, options })
    );

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "test message",
      draftId: "draft-being-created",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    let handleSendResult: CreationSendResult | undefined;
    await act(async () => {
      handleSendResult = await getHook().handleSend("test message");
    });

    expect(handleSendResult).toEqual({ success: true });
    expect(onWorkspaceCreated.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls[0][1]).toEqual({
      autoNavigate: true,
      pendingStreamModel: "anthropic:claude-opus-5",
      markPendingInitialSend: true,
    });
  });

  test("handleSend surfaces backend errors and resets state", async () => {
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: false,
          error: "backend exploded",
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "test-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      create: createMock,
      nameGeneration: nameGenerationMock,
    });
    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "dev" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "make workspace",
    });

    // Wait for name generation to trigger
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    await act(async () => {
      await getHook().handleSend("make workspace");
    });

    expect(workspaceApi.create.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls.length).toBe(0);
    await waitFor(() => expect(getHook().toast?.message).toBe("backend exploded"));
    await waitFor(() => expect(getHook().isSending).toBe(false));

    // Side effect: send-options reader may migrate thinking level into the project scope.
    const thinkingKey = getThinkingLevelKey(getProjectScopeId(TEST_PROJECT_PATH));
    if (updatePersistedStateCalls.length > 0) {
      expect(updatePersistedStateCalls).toEqual([[thinkingKey, "off"]]);
    }
  });
});

type DraftSettingsHarness = ReturnType<typeof createDraftSettingsHarness>;

function createDraftSettingsHarness(
  initial?: Partial<{
    selectedRuntime: ParsedRuntime;
    trunkBranch: string;
    runtimeString?: string | undefined;
    defaultRuntimeMode?: RuntimeChoice;
    agentId?: string;
    coderConfigFallback?: CoderWorkspaceConfig;
    sshHostFallback?: string;
  }>
) {
  const state = {
    selectedRuntime: initial?.selectedRuntime ?? { mode: "local" as const },
    defaultRuntimeMode: initial?.defaultRuntimeMode ?? "worktree",
    agentId: initial?.agentId ?? "exec",
    trunkBranch: initial?.trunkBranch ?? "main",
    runtimeString: initial?.runtimeString,
    coderConfigFallback: initial?.coderConfigFallback ?? { existingWorkspace: false },
    sshHostFallback: initial?.sshHostFallback ?? "",
  } satisfies {
    selectedRuntime: ParsedRuntime;
    defaultRuntimeMode: RuntimeChoice;
    agentId: string;
    trunkBranch: string;
    runtimeString: string | undefined;
    coderConfigFallback: CoderWorkspaceConfig;
    sshHostFallback: string;
  };

  const setTrunkBranch = mock((branch: string) => {
    state.trunkBranch = branch;
  });

  const getRuntimeString = mock(() => state.runtimeString);

  const setSelectedRuntime = mock((runtime: ParsedRuntime) => {
    state.selectedRuntime = runtime;
    if (runtime.mode === "ssh") {
      state.runtimeString = runtime.host ? `ssh ${runtime.host}` : "ssh";
    } else if (runtime.mode === "docker") {
      state.runtimeString = runtime.image ? `docker ${runtime.image}` : "docker";
    } else {
      state.runtimeString = undefined;
    }
  });

  const setDefaultRuntimeChoice = mock((choice: RuntimeChoice) => {
    state.defaultRuntimeMode = choice;
    // Update selected runtime to match new default
    if (choice === "coder") {
      state.selectedRuntime = {
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: { existingWorkspace: false },
      };
      state.runtimeString = `ssh ${CODER_RUNTIME_PLACEHOLDER}`;
      return;
    }
    if (choice === "ssh") {
      const host = state.selectedRuntime.mode === "ssh" ? state.selectedRuntime.host : "";
      state.selectedRuntime = { mode: "ssh", host };
      state.runtimeString = host ? `ssh ${host}` : "ssh";
    } else if (choice === "docker") {
      const image = state.selectedRuntime.mode === "docker" ? state.selectedRuntime.image : "";
      state.selectedRuntime = { mode: "docker", image };
      state.runtimeString = image ? `docker ${image}` : "docker";
    } else if (choice === "local") {
      state.selectedRuntime = { mode: "local" };
      state.runtimeString = undefined;
    } else {
      state.selectedRuntime = { mode: "worktree" };
      state.runtimeString = undefined;
    }
  });

  return {
    state,
    setSelectedRuntime,
    setDefaultRuntimeChoice,
    setTrunkBranch,
    getRuntimeString,
    snapshot(): {
      settings: DraftWorkspaceSettings;
      coderConfigFallback: CoderWorkspaceConfig;
      sshHostFallback: string;
      setSelectedRuntime: typeof setSelectedRuntime;
      setDefaultRuntimeChoice: typeof setDefaultRuntimeChoice;
      setTrunkBranch: typeof setTrunkBranch;
      getRuntimeString: typeof getRuntimeString;
    } {
      const settings: DraftWorkspaceSettings = {
        model: "gpt-4",
        thinkingLevel: "medium",
        reasoningMode: "standard",
        agentId: state.agentId,
        selectedRuntime: state.selectedRuntime,
        defaultRuntimeMode: state.defaultRuntimeMode,
        trunkBranch: state.trunkBranch,
      };
      return {
        settings,
        coderConfigFallback: state.coderConfigFallback,
        sshHostFallback: state.sshHostFallback,
        setSelectedRuntime,
        setDefaultRuntimeChoice,
        setTrunkBranch,
        getRuntimeString,
      };
    },
  };
}

interface HookOptions {
  kind?: "scratch";
  projectPath: string;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: {
      autoNavigate?: boolean;
      pendingStreamModel?: string | null;
      markPendingInitialSend?: boolean;
    }
  ) => void;
  dynamicWorkflowsEnabled?: boolean;
  message?: string;
  draftId?: string | null;
}

function renderUseCreationWorkspace(options: HookOptions) {
  const resultRef: {
    current: ReturnType<typeof useCreationWorkspace> | null;
  } = { current: null };

  function Harness(props: HookOptions) {
    resultRef.current = useCreationWorkspace({
      ...props,
      message: props.message ?? "",
    });
    return null;
  }

  render(<Harness {...options} />);

  return () => {
    if (!resultRef.current) {
      throw new Error("Hook result not initialized");
    }
    return resultRef.current;
  };
}
