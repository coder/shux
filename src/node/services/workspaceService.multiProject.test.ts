import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { Config, SecretsStore } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { createStreamLifecycleMocks } from "@/node/services/agentSession.testHarness";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as gitModule from "@/node/git";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import * as bashToolModule from "@/node/services/tools/bash";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { Ok } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-multi-project-"));
  process.env.MUX_ROOT = tempRoot;
  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
function createMockInitStateManager(): InitStateManager {
  return {
    on: mock(() => undefined as unknown as InitStateManager),
    getInitState: mock(() => undefined),
    startInit: mock(() => undefined),
    endInit: mock(() => Promise.resolve()),
    appendOutput: mock(() => undefined),
    enterHookPhase: mock(() => undefined),
    clearInMemoryState: mock(() => undefined),
  } as unknown as InitStateManager;
}
const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
};
function createMockExperimentsService(enabled: boolean): ExperimentsService {
  return {
    isExperimentEnabled: mock(() => enabled),
  } as unknown as ExperimentsService;
}
type BashToolConfig = Parameters<typeof bashToolModule.createBashTool>[0];
interface WorkspaceServiceTestOptions {
  config: Partial<Config>;
  historyService: HistoryService;
  aiService?: AIService;
  initStateManager?: InitStateManager;
  experimentsEnabled?: boolean;
  secretsStore?: Pick<SecretsStore, "getEffectiveSecrets">;
}
function createMockAIService(metadata?: WorkspaceMetadata): AIService {
  return {
    ...createStreamLifecycleMocks(),
    getWorkspaceMetadata: mock(() => Promise.resolve(metadata ? Ok(metadata) : Ok(undefined))),
    on: mock(() => undefined),
    off: mock(() => undefined),
  } as unknown as AIService;
}
function createWorkspaceServiceForTest(options: WorkspaceServiceTestOptions): WorkspaceService {
  return new WorkspaceService(
    options.config as Config,
    options.historyService,
    options.aiService ?? createMockAIService(),
    options.initStateManager ?? createMockInitStateManager(),
    mockExtensionMetadataService as ExtensionMetadataService,
    mockBackgroundProcessManager as BackgroundProcessManager,
    undefined,
    undefined,
    undefined,
    createMockExperimentsService(options.experimentsEnabled ?? true),
    undefined,
    undefined,
    options.secretsStore
  );
}
interface ExecuteBashHarnessOptions {
  historyService: HistoryService;
  workspaceId: string;
  workspaceName: string;
  srcDir?: string;
  projectAPath?: string;
  projectBPath?: string;
  primaryWorkspacePath?: string;
  runtimeConfig?: WorkspaceMetadata["runtimeConfig"];
  projects?: WorkspaceMetadata["projects"];
  trustedProjects?: Array<[string, boolean]>;
  runtimeWorkspacePaths?: Record<string, string>;
  findWorkspaceProjectPath?: string;
  getEffectiveSecrets?: SecretsStore["getEffectiveSecrets"];
  secretsStore?: Pick<SecretsStore, "getEffectiveSecrets">;
  onCreateRuntime?: (
    projectPath: string,
    options: Parameters<typeof runtimeFactory.createRuntime>[1]
  ) => void;
}
function createExecuteBashHarness(options: ExecuteBashHarnessOptions) {
  const srcDir = options.srcDir ?? "/tmp/src";
  const projectAPath = options.projectAPath ?? "/tmp/project-a";
  const projectBPath = options.projectBPath ?? "/tmp/project-b";
  const projects = options.projects ?? [
    { projectPath: projectAPath, projectName: "project-a" },
    { projectPath: projectBPath, projectName: "project-b" },
  ];
  const primaryWorkspacePath =
    options.primaryWorkspacePath ?? `/tmp/workspaces/project-a/${options.workspaceName}`;
  const runtimeWorkspacePaths = options.runtimeWorkspacePaths ?? {
    [projectAPath]: `/tmp/workspaces/project-a/${options.workspaceName}`,
    [projectBPath]: `/tmp/workspaces/project-b/${options.workspaceName}`,
  };
  const metadata: WorkspaceMetadata = {
    id: options.workspaceId,
    name: options.workspaceName,
    projectPath: projects[0]?.projectPath ?? projectAPath,
    projectName: projects[0]?.projectName ?? "project-a",
    projects,
    runtimeConfig: options.runtimeConfig ?? { type: "local" },
  };
  const waitForInitMock = mock(() => Promise.resolve());
  const ensureReadyMocks = new Map(
    projects.map((project) => [
      project.projectPath,
      mock(() => Promise.resolve({ ready: true as const })),
    ])
  );
  const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
    (_runtimeConfig, runtimeOptions) => {
      const projectPath = runtimeOptions?.projectPath;
      if (projectPath == null) {
        throw new Error("Missing projectPath");
      }
      const ensureReady = ensureReadyMocks.get(projectPath);
      if (ensureReady == null) {
        throw new Error(`Unexpected projectPath: ${projectPath}`);
      }
      options.onCreateRuntime?.(projectPath, runtimeOptions);
      return {
        ensureReady,
        getWorkspacePath: mock(() => runtimeWorkspacePaths[projectPath]),
      } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    }
  );
  const bashExecuteMock = mock(() =>
    Promise.resolve({ success: true as const, output: "ok", exitCode: 0, wall_duration_ms: 1 })
  );
  let capturedToolConfig: BashToolConfig | undefined;
  const createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockImplementation((config) => {
    capturedToolConfig = config;
    return { execute: bashExecuteMock } as unknown as ReturnType<
      typeof bashToolModule.createBashTool
    >;
  });
  const trustedProjects =
    options.trustedProjects ??
    projects.map((project) => [project.projectPath, true] as [string, boolean]);
  const workspaceService = createWorkspaceServiceForTest({
    historyService: options.historyService,
    aiService: createMockAIService(metadata),
    initStateManager: {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    } as unknown as InitStateManager,
    secretsStore:
      options.secretsStore ??
      ({ getEffectiveSecrets: options.getEffectiveSecrets ?? mock(() => []) } satisfies Pick<
        SecretsStore,
        "getEffectiveSecrets"
      >),
    config: {
      srcDir,
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => ({
        projectPath: options.findWorkspaceProjectPath ?? projectAPath,
        workspacePath: primaryWorkspacePath,
      })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map(
          trustedProjects.map(([projectPath, trusted]) => [
            projectPath,
            { workspaces: [], trusted },
          ])
        ),
      })),
    },
  });
  return {
    bashExecuteMock,
    capturedToolConfig: () => {
      assert(capturedToolConfig);
      return capturedToolConfig;
    },
    createRuntimeSpy,
    dispose: () => {
      createBashToolSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    },
    ensureReadyMock: (projectPath: string) => ensureReadyMocks.get(projectPath),
    metadata,
    waitForInitMock,
    workspaceService,
  };
}
describe("WorkspaceService executeBash runtime selection", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });
  afterEach(async () => {
    await cleanupHistory();
  });
  test("uses the shared container-root cwd for multi-project script mode even when the persisted workspace path points at the primary checkout", async () => {
    const workspaceId = "ws-multi-bash";
    const workspaceName = "feature-multi-bash";
    const harness = createExecuteBashHarness({ historyService, workspaceId, workspaceName });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "pwd");
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.createRuntimeSpy).toHaveBeenCalledTimes(2);
      expect(harness.createRuntimeSpy).toHaveBeenNthCalledWith(1, harness.metadata.runtimeConfig, {
        projectPath: "/tmp/project-a",
        workspaceName,
        workspacePath: undefined,
      });
      expect(harness.createRuntimeSpy).toHaveBeenNthCalledWith(2, harness.metadata.runtimeConfig, {
        projectPath: "/tmp/project-b",
        workspaceName,
        workspacePath: undefined,
      });
      const toolConfig = harness.capturedToolConfig();
      expect(toolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(toolConfig.cwd).toBe(new ContainerManager("/tmp/src").getContainerPath(workspaceName));
      expect(toolConfig.trusted).toBe(true);
      expect(harness.ensureReadyMock("/tmp/project-a")).toHaveBeenCalledTimes(1);
      expect(harness.ensureReadyMock("/tmp/project-b")).toHaveBeenCalledTimes(1);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("preserves the current SSH repo root and derives sibling legacy repo roots for multi-project repo-root bash mode when the persisted root matches that layout", async () => {
    const workspaceId = "ws-multi-bash-ssh";
    const workspaceName = "feature-multi-bash-ssh";
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName,
      primaryWorkspacePath: `/tmp/src/project-a/${workspaceName}`,
      runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "/tmp/src" },
      runtimeWorkspacePaths: {
        "/tmp/project-a": `/tmp/src/project-a/${workspaceName}`,
        "/tmp/project-b": `/tmp/src/project-b/${workspaceName}`,
      },
      onCreateRuntime: (projectPath, options) => {
        expect(options?.workspacePath).toBe(
          `/tmp/src/${path.basename(projectPath)}/${workspaceName}`
        );
      },
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "git status --short", {
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-b",
      });
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.capturedToolConfig().cwd).toBe(`/tmp/src/project-b/${workspaceName}`);
      expect(harness.ensureReadyMock("/tmp/project-a")).toHaveBeenCalledTimes(1);
      expect(harness.ensureReadyMock("/tmp/project-b")).toHaveBeenCalledTimes(1);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("lets multi-project script mode target a secondary repo checkout explicitly", async () => {
    const workspaceId = "ws-multi-bash-repo-root";
    const workspaceName = "feature-multi-bash-repo-root";
    const harness = createExecuteBashHarness({ historyService, workspaceId, workspaceName });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "git status --short", {
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-b",
      });
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.createRuntimeSpy).toHaveBeenCalledTimes(2);
      const toolConfig = harness.capturedToolConfig();
      expect(toolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(toolConfig.cwd).toBe(`/tmp/workspaces/project-b/${workspaceName}`);
      expect(toolConfig.trusted).toBe(true);
      expect(harness.ensureReadyMock("/tmp/project-a")).toHaveBeenCalledTimes(1);
      expect(harness.ensureReadyMock("/tmp/project-b")).toHaveBeenCalledTimes(1);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("normalizes repo-root project paths before matching secondary runtimes", async () => {
    const workspaceId = "ws-multi-bash-repo-root-windows";
    const workspaceName = "feature-multi-bash-repo-root-windows";
    const projectAPath = "C:\\tmp\\project-a\\";
    const projectBPath = "C:\\tmp\\project-b\\";
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName,
      projectAPath,
      projectBPath,
      trustedProjects: [
        ["C:\\tmp\\project-a", true],
        ["C:\\tmp\\project-b", true],
      ],
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "git status --short", {
        cwdMode: "repo-root",
        repoRootProjectPath: "C:/tmp/project-b",
      });
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.createRuntimeSpy).toHaveBeenCalledTimes(2);
      const toolConfig = harness.capturedToolConfig();
      expect(toolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(toolConfig.cwd).toBe(`/tmp/workspaces/project-b/${workspaceName}`);
      expect(toolConfig.trusted).toBe(true);
      expect(harness.ensureReadyMock(projectAPath)).toHaveBeenCalledTimes(1);
      expect(harness.ensureReadyMock(projectBPath)).toHaveBeenCalledTimes(1);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("marks multi-project executeBash untrusted when any secondary project is untrusted", async () => {
    const workspaceId = "ws-multi-bash-untrusted";
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName: "feature-multi-bash-untrusted",
      trustedProjects: [
        ["/tmp/project-a", true],
        ["/tmp/project-b", false],
      ],
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "pwd");
      expect(result.success).toBe(true);
      expect(harness.capturedToolConfig().trusted).toBe(false);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("merges multi-project executeBash secrets across all repos with primary-project precedence", async () => {
    const workspaceId = "ws-multi-bash-secrets";
    const workspaceName = "feature-multi-bash-secrets";
    const getEffectiveSecretsMock = mock((projectPath: string) => {
      if (projectPath === "/tmp/project-a") {
        return [
          { key: "SHARED_SECRET", value: "primary" },
          { key: "PRIMARY_ONLY_SECRET", value: "alpha" },
        ];
      }
      if (projectPath === "/tmp/project-b") {
        return [
          { key: "SHARED_SECRET", value: "secondary" },
          { key: "SECONDARY_ONLY_SECRET", value: "beta" },
        ];
      }
      throw new Error(`Unexpected secrets lookup: ${projectPath}`);
    });
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName,
      secretsStore: {
        getEffectiveSecrets: getEffectiveSecretsMock,
      },
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "pwd");
      expect(result.success).toBe(true);
      expect(harness.capturedToolConfig().secrets).toEqual({
        SHARED_SECRET: "primary",
        PRIMARY_ONLY_SECRET: "alpha",
        SECONDARY_ONLY_SECRET: "beta",
      });
      expect(getEffectiveSecretsMock.mock.calls).toEqual([["/tmp/project-a"], ["/tmp/project-b"]]);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("keeps multi-project git command mode on the primary repo checkout even when the persisted workspace path points at that checkout", async () => {
    const workspaceId = "ws-multi-git";
    const workspaceName = "feature-multi-git";
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName,
      trustedProjects: [["/tmp/project-a", true]],
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "", undefined, "git", [
        "status",
        "--short",
      ]);
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.createRuntimeSpy).toHaveBeenCalledTimes(2);
      const toolConfig = harness.capturedToolConfig();
      expect(toolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(toolConfig.cwd).toBe(`/tmp/workspaces/project-a/${workspaceName}`);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("uses the primary project runtime workspace path for _multi git command mode", async () => {
    const workspaceId = "ws-multi-git-container";
    const workspaceName = "feature-multi-git-container";
    const harness = createExecuteBashHarness({
      historyService,
      workspaceId,
      workspaceName,
      trustedProjects: [["/tmp/project-a", true]],
    });
    try {
      const result = await harness.workspaceService.executeBash(workspaceId, "", undefined, "git", [
        "status",
        "--short",
        "--repo-mode=_multi",
      ]);
      expect(result.success).toBe(true);
      expect(harness.waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(harness.createRuntimeSpy).toHaveBeenCalledTimes(2);
      const toolConfig = harness.capturedToolConfig();
      expect(toolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(toolConfig.cwd).toBe(`/tmp/workspaces/project-a/${workspaceName}`);
      expect(harness.bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });
  test("keeps single-project executeBash on the workspace runtime path", async () => {
    const workspaceId = "ws-single-bash";
    const workspaceName = "feature-single-bash";
    const projectPath = "/tmp/project-a";
    const workspacePath = `/tmp/workspaces/project-a/${workspaceName}`;
    const metadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceName,
      projectPath,
      projectName: "project-a",
      runtimeConfig: { type: "local" },
    };
    const waitForInitMock = mock(() => Promise.resolve());
    const singleRuntime = {
      ensureReady: mock(() => Promise.resolve({ ready: true as const })),
      getWorkspacePath: mock(() => workspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(singleRuntime);
    const bashExecuteMock = mock(() =>
      Promise.resolve({ success: true as const, output: "ok", exitCode: 0, wall_duration_ms: 1 })
    );
    let capturedToolConfig: BashToolConfig | undefined;
    const createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockImplementation(
      (config) => {
        capturedToolConfig = config;
        return { execute: bashExecuteMock } as unknown as ReturnType<
          typeof bashToolModule.createBashTool
        >;
      }
    );
    const workspaceService = createWorkspaceServiceForTest({
      historyService,
      aiService: createMockAIService(metadata),
      initStateManager: {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        waitForInit: waitForInitMock,
      } as unknown as InitStateManager,
      config: {
        srcDir: "/tmp/src",
        sessionsDir: "/tmp/test/sessions",
        findWorkspace: mock(() => ({ projectPath, workspacePath })),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([[projectPath, { workspaces: [], trusted: true }]]),
        })),
      },
      secretsStore: { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore,
    });
    try {
      const result = await workspaceService.executeBash(workspaceId, "pwd");
      expect(result.success).toBe(true);
      expect(waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(1);
      assert(capturedToolConfig);
      expect(capturedToolConfig.runtime).toBe(singleRuntime);
      expect(capturedToolConfig.cwd).toBe(workspacePath);
      expect(capturedToolConfig.trusted).toBe(true);
      expect(bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      createBashToolSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    }
  });
});
describe("WorkspaceService multi-project lifecycle", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });
  afterEach(async () => {
    await cleanupHistory();
  });
  test("list() and getInfo() hide persisted multi-project metadata when experiment is disabled", async () => {
    const singleProjectMetadata: FrontendWorkspaceMetadata = {
      id: "ws-single",
      name: "feature-single",
      projectPath: "/tmp/project-a",
      projectName: "project-a",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: "/tmp/project-a/feature-single",
    };
    const multiProjectMetadata: FrontendWorkspaceMetadata = {
      id: "ws-multi",
      name: "feature-multi",
      projectPath: "/tmp/project-a",
      projectName: "project-a+project-b",
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
      runtimeConfig: { type: "local" },
      namedWorkspacePath: "/tmp/project-a/feature-multi",
    };
    const mockConfig: Partial<Config> = {
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve([singleProjectMetadata, multiProjectMetadata])
      ),
    };
    const mockAIService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      createMockInitStateManager(),
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      undefined,
      undefined,
      undefined,
      createMockExperimentsService(false)
    );
    expect((await workspaceService.list()).map((metadata) => metadata.id)).toEqual(["ws-single"]);
    const singleProjectInfo = await workspaceService.getInfo(singleProjectMetadata.id);
    assert(singleProjectInfo, "Expected single-project metadata when the experiment is disabled");
    expect(singleProjectInfo.id).toBe(singleProjectMetadata.id);
    expect(await workspaceService.getInfo(multiProjectMetadata.id)).toBeNull();
  });
  test("list() and getInfo() expose multi-project metadata when experiment is enabled", async () => {
    const singleProjectMetadata: FrontendWorkspaceMetadata = {
      id: "ws-single",
      name: "feature-single",
      projectPath: "/tmp/project-a",
      projectName: "project-a",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: "/tmp/project-a/feature-single",
    };
    const multiProjectMetadata: FrontendWorkspaceMetadata = {
      id: "ws-multi",
      name: "feature-multi",
      projectPath: "/tmp/project-a",
      projectName: "project-a+project-b",
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
      runtimeConfig: { type: "local" },
      namedWorkspacePath: "/tmp/project-a/feature-multi",
    };
    const mockConfig: Partial<Config> = {
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve([singleProjectMetadata, multiProjectMetadata])
      ),
    };
    const mockAIService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      createMockInitStateManager(),
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      undefined,
      undefined,
      undefined,
      createMockExperimentsService(true)
    );
    expect((await workspaceService.list()).map((metadata) => metadata.id)).toEqual([
      "ws-single",
      "ws-multi",
    ]);
    const multiProjectInfo = await workspaceService.getInfo(multiProjectMetadata.id);
    assert(multiProjectInfo, "Expected multi-project metadata when the experiment is enabled");
    expect(multiProjectInfo.id).toBe(multiProjectMetadata.id);
    expect(multiProjectInfo.projects).toEqual(multiProjectMetadata.projects);
  });
  test("createMultiProject rejects when the experiment is disabled", async () => {
    const generateStableIdMock = mock(() => "ws-disabled");
    const loadConfigOrDefaultMock = mock(() => ({ projects: new Map() }));
    const workspaceService = new WorkspaceService(
      {
        generateStableId: generateStableIdMock,
        loadConfigOrDefault: loadConfigOrDefaultMock,
      } as unknown as Config,
      historyService,
      {
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService,
      createMockInitStateManager(),
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      undefined,
      undefined,
      undefined,
      createMockExperimentsService(false)
    );
    const result = await workspaceService.createMultiProject(
      [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
      "feature-disabled",
      "main"
    );
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toBe("Multi-project workspaces experiment is disabled");
    expect(generateStableIdMock).not.toHaveBeenCalled();
    expect(loadConfigOrDefaultMock).not.toHaveBeenCalled();
  });
  test("createMultiProject creates per-project workspaces and persists metadata", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-create";
      const branchName = "feature-multi";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const containerPath = path.join(srcDir, "_workspaces", branchName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir,
        generateStableId: mock(() => workspaceId),
        loadConfigOrDefault: mock(() => configState),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspaces = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
          return Promise.resolve(
            workspaces.map((workspace) => {
              const metadata: FrontendWorkspaceMetadata = {
                id: workspace.id ?? "",
                name: workspace.name ?? "",
                title: workspace.title,
                projectPath: workspace.projects?.[0]?.projectPath ?? "",
                projectName:
                  workspace.projects?.map((project) => project.projectName).join("+") ?? "",
                projects: workspace.projects,
                createdAt: workspace.createdAt,
                runtimeConfig: workspace.runtimeConfig ?? {
                  type: "worktree",
                  srcBaseDir: srcDir,
                },
                namedWorkspacePath: workspace.path,
              };
              return metadata;
            })
          );
        }),
        sessionsDir: path.join(rootDir, "sessions"),
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const createWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-a", branchName),
        })
      );
      const createWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-b", branchName),
        })
      );
      const initWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const initWorkspaceBMock = mock(() => Promise.resolve({ success: true as const }));
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              initWorkspace: initWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              initWorkspace: initWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(containerPath);
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          branchName,
          "main",
          "Multi-project title"
        );
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }
        expect(result.data.id).toBe(workspaceId);
        expect(result.data.projectPath).toBe(projectAPath);
        expect(result.data.projectName).toBe("project-a+project-b");
        expect(result.data.projects).toEqual([
          { projectPath: projectAPath, projectName: "project-a" },
          { projectPath: projectBPath, projectName: "project-b" },
        ]);
        expect(createWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, branchName })
        );
        expect(createWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, branchName })
        );
        expect(createContainerSpy).toHaveBeenCalledWith(branchName, [
          {
            projectName: "project-a",
            workspacePath: path.join(srcDir, "project-a", branchName),
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", branchName),
          },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(initWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectPath: projectAPath,
            branchName,
            trunkBranch: "main",
            workspacePath: path.join(srcDir, "project-a", branchName),
          })
        );
        expect(initWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectPath: projectBPath,
            branchName,
            trunkBranch: "main",
            workspacePath: path.join(srcDir, "project-b", branchName),
          })
        );
        const storedMultiWorkspaces =
          configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
        expect(storedMultiWorkspaces).toHaveLength(1);
        expect(configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.projectKind).toBe("system");
        expect(storedMultiWorkspaces[0]?.projects).toEqual([
          { projectPath: projectAPath, projectName: "project-a" },
          { projectPath: projectBPath, projectName: "project-b" },
        ]);
      } finally {
        createContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("createMultiProject re-emits cleared init metadata when background init aborts", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-abort-init";
      const branchName = "feature-multi-abort";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const containerPath = path.join(srcDir, "_workspaces", branchName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir,
        generateStableId: mock(() => workspaceId),
        loadConfigOrDefault: mock(() => configState),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspaces = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
          return Promise.resolve(
            workspaces.map((workspace) => ({
              id: workspace.id ?? "",
              name: workspace.name ?? "",
              title: workspace.title,
              projectPath: workspace.projects?.[0]?.projectPath ?? "",
              projectName:
                workspace.projects?.map((project) => project.projectName).join("+") ?? "",
              projects: workspace.projects,
              createdAt: workspace.createdAt,
              runtimeConfig: workspace.runtimeConfig ?? {
                type: "worktree",
                srcBaseDir: srcDir,
              },
              namedWorkspacePath: workspace.path,
            }))
          );
        }),
        sessionsDir: path.join(rootDir, "sessions"),
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const createWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-a", branchName),
        })
      );
      const createWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-b", branchName),
        })
      );
      const initWorkspaceADeferred = Promise.withResolvers<{ success: true }>();
      let workspaceService: WorkspaceService;
      const initWorkspaceAMock = mock(() => {
        (workspaceService as unknown as { removingWorkspaces: Set<string> }).removingWorkspaces.add(
          workspaceId
        );
        return initWorkspaceADeferred.promise;
      });
      const initWorkspaceBMock = mock(() => Promise.resolve({ success: true as const }));
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              initWorkspace: initWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              initWorkspace: initWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(containerPath);
      let initStateCleared = false;
      const clearInMemoryStateMock = mock(() => {
        initStateCleared = true;
      });
      const getInitStateMock = mock(() =>
        initStateCleared ? undefined : ({ status: "running" } as const)
      );
      try {
        workspaceService = new WorkspaceService(
          mockConfig as Config,
          historyService,
          mockAIService,
          {
            on: mock(() => undefined as unknown as InitStateManager),
            getInitState: getInitStateMock,
            startInit: mock(() => undefined),
            endInit: mock(() => Promise.resolve()),
            appendOutput: mock(() => undefined),
            enterHookPhase: mock(() => undefined),
            clearInMemoryState: clearInMemoryStateMock,
          } as unknown as InitStateManager,
          mockExtensionMetadataService as ExtensionMetadataService,
          mockBackgroundProcessManager as BackgroundProcessManager,
          undefined,
          undefined,
          undefined,
          createMockExperimentsService(true)
        );
        const metadataEvents: FrontendWorkspaceMetadata[] = [];
        workspaceService.on("metadata", (event) => {
          metadataEvents.push((event as { metadata: FrontendWorkspaceMetadata }).metadata);
        });
        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          branchName,
          "main"
        );
        expect(result.success).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(initWorkspaceAMock).toHaveBeenCalledTimes(1);
        expect(metadataEvents[0]?.isInitializing).toBe(true);
        initWorkspaceADeferred.resolve({ success: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
        expect(getInitStateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(initWorkspaceBMock).not.toHaveBeenCalled();
        expect(metadataEvents.at(-1)).toMatchObject({
          id: workspaceId,
          isRemoving: true,
          isInitializing: undefined,
        });
      } finally {
        createContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("createMultiProject preserves a pre-existing container when branchName collides", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-existing-container";
      const branchName = "feature-existing-container";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const originalProjectAWorkspacePath = path.join(rootDir, "existing-project-a-workspace");
      await fsPromises.mkdir(originalProjectAWorkspacePath, { recursive: true });
      await fsPromises.writeFile(
        path.join(originalProjectAWorkspacePath, "marker.txt"),
        "pre-existing marker",
        "utf8"
      );
      const containerManager = new ContainerManager(srcDir);
      const existingContainerPath = await containerManager.createContainer(branchName, [
        {
          projectName: "project-a",
          workspacePath: originalProjectAWorkspacePath,
        },
      ]);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir,
        generateStableId: mock(() => workspaceId),
        loadConfigOrDefault: mock(() => configState),
        sessionsDir: path.join(rootDir, "sessions"),
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const createWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-a", branchName),
        })
      );
      const createWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-b", branchName),
        })
      );
      const deleteWorkspaceAMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-a" })
      );
      const deleteWorkspaceBMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-b" })
      );
      const initWorkspaceMock = mock(() => Promise.resolve({ success: true as const }));
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceAMock,
              initWorkspace: initWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceBMock,
              initWorkspace: initWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(ContainerManager.prototype, "removeContainer");
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          branchName,
          "main"
        );
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain("already exists");
        expect(deleteWorkspaceAMock).toHaveBeenCalledTimes(1);
        expect(deleteWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          branchName,
          false,
          expect.any(AbortSignal),
          true
        );
        expect(deleteWorkspaceBMock).toHaveBeenCalledTimes(1);
        expect(deleteWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          branchName,
          false,
          expect.any(AbortSignal),
          true
        );
        expect(initWorkspaceMock).not.toHaveBeenCalled();
        expect(removeContainerSpy).not.toHaveBeenCalled();
        await fsPromises.access(existingContainerPath);
        expect(await fsPromises.realpath(path.join(existingContainerPath, "project-a"))).toBe(
          await fsPromises.realpath(originalProjectAWorkspacePath)
        );
        expect(
          await fsPromises.readFile(
            path.join(existingContainerPath, "project-a", "marker.txt"),
            "utf8"
          )
        ).toBe("pre-existing marker");
      } finally {
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("createMultiProject resolves trunk branch per project when requested branch is missing", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-project-trunk-resolution";
      const branchName = "feature-per-project-trunk";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const containerPath = path.join(srcDir, "_workspaces", branchName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir,
        generateStableId: mock(() => workspaceId),
        loadConfigOrDefault: mock(() => configState),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspaces = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
          return Promise.resolve(
            workspaces.map((workspace) => ({
              id: workspace.id ?? "",
              name: workspace.name ?? "",
              title: workspace.title,
              projectPath: workspace.projects?.[0]?.projectPath ?? "",
              projectName:
                workspace.projects?.map((project) => project.projectName).join("+") ?? "",
              projects: workspace.projects,
              createdAt: workspace.createdAt,
              runtimeConfig: workspace.runtimeConfig ?? {
                type: "worktree",
                srcBaseDir: srcDir,
              },
              namedWorkspacePath: workspace.path,
            }))
          );
        }),
        sessionsDir: path.join(rootDir, "sessions"),
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const createWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-a", branchName),
        })
      );
      const createWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-b", branchName),
        })
      );
      const initWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const initWorkspaceBMock = mock(() => Promise.resolve({ success: true as const }));
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              initWorkspace: initWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              initWorkspace: initWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const listLocalBranchesSpy = spyOn(gitModule, "listLocalBranches").mockImplementation(
        (projectPath) => {
          if (projectPath === projectAPath) {
            return Promise.resolve(["main", "feature-a"]);
          }
          if (projectPath === projectBPath) {
            return Promise.resolve(["master", "feature-b"]);
          }
          throw new Error(`Unexpected project path for listLocalBranches: ${projectPath}`);
        }
      );
      const detectDefaultTrunkBranchSpy = spyOn(
        gitModule,
        "detectDefaultTrunkBranch"
      ).mockImplementation((_projectPath, branches) => {
        assert(branches, "Expected branches to be provided for trunk detection");
        return Promise.resolve(branches.includes("master") ? "master" : "main");
      });
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(containerPath);
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          branchName,
          "main"
        );
        expect(result.success).toBe(true);
        expect(createWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, trunkBranch: "main" })
        );
        expect(createWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, trunkBranch: "master" })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(initWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, trunkBranch: "main" })
        );
        expect(initWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, trunkBranch: "master" })
        );
        expect(detectDefaultTrunkBranchSpy).toHaveBeenCalledWith(projectBPath, [
          "master",
          "feature-b",
        ]);
      } finally {
        createContainerSpy.mockRestore();
        detectDefaultTrunkBranchSpy.mockRestore();
        listLocalBranchesSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("createMultiProject rejects fewer than two projects", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
        sessionsDir: path.join(rootDir, "sessions"),
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        createMockInitStateManager(),
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined,
        undefined,
        undefined,
        createMockExperimentsService(true)
      );
      await assert.rejects(
        workspaceService.createMultiProject(
          [{ projectPath: path.join(rootDir, "project-a"), projectName: "project-a" }],
          "feature",
          "main"
        ),
        /createMultiProject requires at least two projects/
      );
    });
  });
  test("createMultiProject rejects runtimes that are not local/worktree", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        generateStableId: mock(() => "ws-unsupported-runtime"),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [projectAPath, { workspaces: [], trusted: true }],
            [projectBPath, { workspaces: [], trusted: true }],
          ]),
        })),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime");
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          "feature-unsupported-runtime",
          "main",
          "Unsupported runtime",
          {
            type: "docker",
            image: "ubuntu:22.04",
          }
        );
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain(
          "Multi-project workspaces currently require local or worktree runtime, got: docker"
        );
        expect(createRuntimeSpy).not.toHaveBeenCalled();
      } finally {
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("remove() deletes all project workspaces and the shared container for multi-project workspaces", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-remove";
      const workspaceName = "feature-remove";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const removeWorkspaceMock = mock(() => Promise.resolve());
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [projectAPath, { workspaces: [], trusted: true }],
            [projectBPath, { workspaces: [], trusted: true }],
          ]),
        })),
        sessionsDir: path.join(rootDir, "sessions"),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve(Ok(undefined))),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: workspaceName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "src") },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const deleteWorkspaceAMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-a" })
      );
      const deleteWorkspaceBMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-b" })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              deleteWorkspace: deleteWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              deleteWorkspace: deleteWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.remove(workspaceId, true);
        expect(result.success).toBe(true);
        expect(deleteWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          workspaceName,
          true,
          undefined,
          true
        );
        expect(deleteWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          workspaceName,
          true,
          undefined,
          true
        );
        expect(removeContainerSpy).toHaveBeenCalledWith(workspaceName);
        expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
      } finally {
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("remove() preflights all project workspaces before deleting any when force=false", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-remove-preflight";
      const workspaceName = "feature-remove-preflight";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const removeWorkspaceMock = mock(() => Promise.resolve());
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [projectAPath, { workspaces: [], trusted: true }],
            [projectBPath, { workspaces: [], trusted: true }],
          ]),
        })),
        sessionsDir: path.join(rootDir, "sessions"),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve(Ok(undefined))),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: workspaceName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "src") },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const preflightWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const preflightWorkspaceBMock = mock(() =>
        Promise.resolve({ success: false as const, error: "Workspace has uncommitted changes" })
      );
      const deleteWorkspaceAMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-a" })
      );
      const deleteWorkspaceBMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-b" })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              canDeleteWorkspaceWithoutForce: preflightWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              canDeleteWorkspaceWithoutForce: preflightWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.remove(workspaceId, false);
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain(
          "Failed to delete multi-project workspace from disk: [project-b] Workspace has uncommitted changes"
        );
        expect(preflightWorkspaceAMock).toHaveBeenCalledWith(projectAPath, workspaceName, true);
        expect(preflightWorkspaceBMock).toHaveBeenCalledWith(projectBPath, workspaceName, true);
        expect(deleteWorkspaceAMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceBMock).not.toHaveBeenCalled();
        expect(removeContainerSpy).not.toHaveBeenCalled();
        expect(removeWorkspaceMock).not.toHaveBeenCalled();
      } finally {
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("rename() renames all project workspaces and recreates the shared container", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
          [
            MULTI_PROJECT_CONFIG_KEY,
            {
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldContainerPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
        ]),
      };
      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
          return Promise.resolve(
            workspace
              ? [
                  {
                    id: workspace.id ?? workspaceId,
                    name: workspace.name ?? oldName,
                    projectPath: workspace.projects?.[0]?.projectPath ?? projectAPath,
                    projectName:
                      workspace.projects?.map((project) => project.projectName).join("+") ?? "",
                    projects: workspace.projects,
                    runtimeConfig: workspace.runtimeConfig ?? {
                      type: "worktree",
                      srcBaseDir: srcDir,
                    },
                    namedWorkspacePath: workspace.path,
                  } satisfies FrontendWorkspaceMetadata,
                ]
              : []
          );
        }),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const renameWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: path.join(srcDir, "project-a", oldName),
          newPath: path.join(srcDir, "project-a", newName),
        })
      );
      const renameWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: path.join(srcDir, "project-b", oldName),
          newPath: path.join(srcDir, "project-b", newName),
        })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
              getXumHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
              getXumHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(newContainerPath);
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.rename(workspaceId, newName);
        expect(result.success).toBe(true);
        expect(renameWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledWith(newName, [
          {
            projectName: "project-a",
            workspacePath: path.join(srcDir, "project-a", newName),
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", newName),
          },
        ]);
        const renamedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(renamedWorkspace?.name).toBe(newName);
        expect(renamedWorkspace?.path).toBe(newContainerPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("rename() preserves per-project git-root paths for multi-project task entries", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-task-entry";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [
            projectAPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldWorkspaceAPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };
      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldWorkspaceAPath,
          projectPath: projectAPath,
          workspaceName: oldName,
        })),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspace = configState.projects.get(projectAPath)?.workspaces[0];
          return Promise.resolve(
            workspace
              ? [
                  {
                    id: workspace.id ?? workspaceId,
                    name: workspace.name ?? oldName,
                    projectPath: projectAPath,
                    projectName:
                      workspace.projects?.map((project) => project.projectName).join("+") ?? "",
                    projects: workspace.projects,
                    runtimeConfig: workspace.runtimeConfig ?? {
                      type: "worktree",
                      srcBaseDir: srcDir,
                    },
                    namedWorkspacePath: workspace.path,
                  } satisfies FrontendWorkspaceMetadata,
                ]
              : []
          );
        }),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const renameWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: oldWorkspaceAPath,
          newPath: newWorkspaceAPath,
        })
      );
      const renameWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: path.join(srcDir, "project-b", oldName),
          newPath: path.join(srcDir, "project-b", newName),
        })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
              getXumHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
              getXumHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(newContainerPath);
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.rename(workspaceId, newName);
        expect(result.success).toBe(true);
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledWith(newName, [
          {
            projectName: "project-a",
            workspacePath: newWorkspaceAPath,
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", newName),
          },
        ]);
        const renamedWorkspace = configState.projects.get(projectAPath)?.workspaces[0];
        expect(renamedWorkspace?.name).toBe(newName);
        expect(renamedWorkspace?.path).toBe(newWorkspaceAPath);
        expect(renamedWorkspace?.path).not.toBe(newContainerPath);
        expect(oldContainerPath).not.toBe(newWorkspaceAPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("rename() rolls back already-renamed projects when a later project rename fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-rollback";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
          [
            MULTI_PROJECT_CONFIG_KEY,
            {
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldContainerPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
        ]),
      };
      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });
      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (sourceName === oldName && targetName === newName) {
            return Promise.resolve({
              success: true as const,
              oldPath: path.join(srcDir, "project-a", oldName),
              newPath: path.join(srcDir, "project-a", newName),
            });
          }
          if (sourceName === newName && targetName === oldName) {
            return Promise.resolve({
              success: true as const,
              oldPath: path.join(srcDir, "project-a", newName),
              newPath: path.join(srcDir, "project-a", oldName),
            });
          }
          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: false as const,
          error: "project-b rename failed",
        })
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(path.join(srcDir, "_workspaces", newName));
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.rename(workspaceId, newName);
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain("Failed to rename workspace for project project-b");
        expect(renameWorkspaceAMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          1,
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          2,
          projectAPath,
          newName,
          oldName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledTimes(1);
        expect(removeContainerSpy).not.toHaveBeenCalled();
        expect(createContainerSpy).not.toHaveBeenCalled();
        expect(editConfigMock).not.toHaveBeenCalled();
        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("rename() rolls back all renamed projects when container recreation fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-container-rollback";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const oldWorkspaceBPath = path.join(srcDir, "project-b", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);
      const newWorkspaceBPath = path.join(srcDir, "project-b", newName);
      await fsPromises.mkdir(oldWorkspaceAPath, { recursive: true });
      await fsPromises.mkdir(oldWorkspaceBPath, { recursive: true });
      await fsPromises.mkdir(oldContainerPath, { recursive: true });
      await fsPromises.symlink(oldWorkspaceAPath, path.join(oldContainerPath, "project-a"));
      await fsPromises.symlink(oldWorkspaceBPath, path.join(oldContainerPath, "project-b"));
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
          [
            MULTI_PROJECT_CONFIG_KEY,
            {
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldContainerPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
        ]),
      };
      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });
      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
              newPath: targetName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
            });
          }
          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
              newPath: targetName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
            });
          }
          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
              getWorkspacePath: mock(() => oldWorkspaceAPath),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
              getWorkspacePath: mock(() => oldWorkspaceBPath),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockImplementation(async (workspaceName: string) => {
        await fsPromises.rm(path.join(srcDir, "_workspaces", workspaceName), {
          recursive: true,
          force: true,
        });
      });
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockImplementation(async () => {
        await fsPromises.mkdir(newContainerPath, { recursive: true });
        await fsPromises.symlink(newWorkspaceAPath, path.join(newContainerPath, "project-a"));
        throw new Error("container create failed");
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.rename(workspaceId, newName);
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain("Failed to recreate container");
        expect(renameWorkspaceAMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          1,
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          2,
          projectAPath,
          newName,
          oldName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceBMock).toHaveBeenNthCalledWith(
          1,
          projectBPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenNthCalledWith(
          2,
          projectBPath,
          newName,
          oldName,
          undefined,
          true
        );
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledTimes(1);
        expect(editConfigMock).not.toHaveBeenCalled();
        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
        expect(await pathExists(newContainerPath)).toBe(false);
        const recreatedProjectALink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-a")
        );
        const recreatedProjectBLink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-b")
        );
        expect(recreatedProjectALink).toBe(oldWorkspaceAPath);
        expect(recreatedProjectBLink).toBe(oldWorkspaceBPath);
        expect(recreatedProjectBLink).not.toBe(oldWorkspaceAPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
  test("rename() preserves a pre-existing new container when recreation fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-preexisting-new-container";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const oldWorkspaceBPath = path.join(srcDir, "project-b", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);
      const newWorkspaceBPath = path.join(srcDir, "project-b", newName);
      const preexistingMarkerPath = path.join(newContainerPath, "marker.txt");
      await fsPromises.mkdir(oldWorkspaceAPath, { recursive: true });
      await fsPromises.mkdir(oldWorkspaceBPath, { recursive: true });
      await fsPromises.mkdir(oldContainerPath, { recursive: true });
      await fsPromises.symlink(oldWorkspaceAPath, path.join(oldContainerPath, "project-a"));
      await fsPromises.symlink(oldWorkspaceBPath, path.join(oldContainerPath, "project-b"));
      await fsPromises.mkdir(newContainerPath, { recursive: true });
      await fsPromises.writeFile(preexistingMarkerPath, "keep me", "utf8");
      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
          [
            MULTI_PROJECT_CONFIG_KEY,
            {
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldContainerPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
        ]),
      };
      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });
      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
        sessionsDir: path.join(rootDir, "sessions"),
      };
      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
              newPath: targetName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
            });
          }
          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
              newPath: targetName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
            });
          }
          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );
      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockImplementation(async (workspaceName: string) => {
        await fsPromises.rm(path.join(srcDir, "_workspaces", workspaceName), {
          recursive: true,
          force: true,
        });
      });
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockImplementation(() => Promise.reject(new Error("container create failed")));
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config: mockConfig,
          historyService,
          aiService: mockAIService,
        });
        const result = await workspaceService.rename(workspaceId, newName);
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expect(result.error).toContain("Failed to recreate container");
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledTimes(1);
        expect(editConfigMock).not.toHaveBeenCalled();
        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
        expect(await pathExists(newContainerPath)).toBe(true);
        expect(await fsPromises.readFile(preexistingMarkerPath, "utf8")).toBe("keep me");
        const recreatedProjectALink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-a")
        );
        const recreatedProjectBLink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-b")
        );
        expect(recreatedProjectALink).toBe(oldWorkspaceAPath);
        expect(recreatedProjectBLink).toBe(oldWorkspaceBPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
});
