import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import * as gitModule from "@/node/git";
import { getContainerName } from "@/node/runtime/DockerRuntime";
import type {
  InitLogger,
  Runtime,
  WorkspaceCreationResult,
  WorkspaceForkResult,
} from "@/node/runtime/Runtime";
import * as runtimeFactoryModule from "@/node/runtime/runtimeFactory";
import * as runtimeUpdatesModule from "@/node/services/utils/forkRuntimeUpdates";
import { orchestrateFork } from "./forkOrchestrator";

let applyForkRuntimeUpdatesMock!: ReturnType<
  typeof spyOn<typeof runtimeUpdatesModule, "applyForkRuntimeUpdates">
>;
let createRuntimeMock!: ReturnType<typeof spyOn<typeof runtimeFactoryModule, "createRuntime">>;
let detectDefaultTrunkBranchMock!: ReturnType<
  typeof spyOn<typeof gitModule, "detectDefaultTrunkBranch">
>;
let listLocalBranchesMock!: ReturnType<typeof spyOn<typeof gitModule, "listLocalBranches">>;

const PROJECT_PATH = "/projects/demo";
const SOURCE_WORKSPACE_NAME = "feature/source";
const NEW_WORKSPACE_NAME = "feature/new";
const SOURCE_WORKSPACE_ID = "workspace-source";
const SOURCE_RUNTIME_CONFIG: RuntimeConfig = { type: "local" };
const DEFAULT_FORKED_RUNTIME_CONFIG: RuntimeConfig = {
  type: "docker",
  image: "node:20",
  containerName: getContainerName(PROJECT_PATH, NEW_WORKSPACE_NAME),
};

function createInitLogger(): InitLogger {
  return {
    logStep: vi.fn(),
    logStdout: vi.fn(),
    logStderr: vi.fn(),
    logComplete: vi.fn(),
  };
}

function createConfig(): Config {
  return {
    updateWorkspaceMetadata: vi.fn(),
  } as unknown as Config;
}

function createSourceRuntimeMocks(): {
  sourceRuntime: Runtime;
  forkWorkspace: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
} {
  const forkWorkspace = vi.fn();
  const createWorkspace = vi.fn();
  const sourceRuntime = {
    forkWorkspace,
    createWorkspace,
  } as unknown as Runtime;

  return { sourceRuntime, forkWorkspace, createWorkspace };
}

interface RunOrchestrateForkOptions {
  sourceRuntime: Runtime;
  allowCreateFallback: boolean;
  config?: Config;
  sourceRuntimeConfig?: RuntimeConfig;
  preferredTrunkBranch?: string;
}

async function runOrchestrateFork(options: RunOrchestrateForkOptions) {
  const config = options.config ?? createConfig();

  return orchestrateFork({
    sourceRuntime: options.sourceRuntime,
    projectPath: PROJECT_PATH,
    sourceWorkspaceName: SOURCE_WORKSPACE_NAME,
    newWorkspaceName: NEW_WORKSPACE_NAME,
    initLogger: createInitLogger(),
    config,
    sourceWorkspaceId: SOURCE_WORKSPACE_ID,
    sourceRuntimeConfig: options.sourceRuntimeConfig ?? SOURCE_RUNTIME_CONFIG,
    allowCreateFallback: options.allowCreateFallback,
    preferredTrunkBranch: options.preferredTrunkBranch,
  });
}

describe("orchestrateFork", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    applyForkRuntimeUpdatesMock = spyOn(
      runtimeUpdatesModule,
      "applyForkRuntimeUpdates"
    ).mockResolvedValue({
      forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
    });

    createRuntimeMock = spyOn(runtimeFactoryModule, "createRuntime").mockReturnValue({
      marker: "target-runtime",
    } as unknown as Runtime);
    listLocalBranchesMock = spyOn(gitModule, "listLocalBranches").mockResolvedValue(["main"]);
    detectDefaultTrunkBranchMock = spyOn(gitModule, "detectDefaultTrunkBranch").mockResolvedValue(
      "main"
    );
  });

  afterEach(() => {
    // Later suites must receive real runtimes, not this suite's factory stub.
    vi.restoreAllMocks();
  });

  it("returns Ok with fork metadata when forkWorkspace succeeds", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    const forkResult: WorkspaceForkResult = {
      success: true,
      workspacePath: "/workspaces/forked",
      sourceBranch: "feature/source-branch",
    };
    forkWorkspace.mockResolvedValue(forkResult);

    const targetRuntime = { marker: "fresh-runtime" } as unknown as Runtime;
    createRuntimeMock.mockReturnValue(targetRuntime);
    const config = createConfig();

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
      config,
    });

    expect(result).toEqual({
      success: true,
      data: {
        workspacePath: "/workspaces/forked",
        trunkBranch: "feature/source-branch",
        forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      },
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
    expect(applyForkRuntimeUpdatesMock).toHaveBeenCalledWith(
      config,
      SOURCE_WORKSPACE_ID,
      SOURCE_RUNTIME_CONFIG,
      forkResult,
      { persistSourceRuntimeConfigUpdate: false }
    );
    expect(createRuntimeMock).toHaveBeenCalledWith(DEFAULT_FORKED_RUNTIME_CONFIG, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
      workspacePath: "/workspaces/forked",
    });
  });

  it("falls back to createWorkspace when fork fails and fallback is allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockResolvedValue(["main", "develop"]);
    detectDefaultTrunkBranchMock.mockResolvedValue("develop");
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/created",
    } satisfies WorkspaceCreationResult);

    const targetRuntime = { marker: "runtime-after-create-fallback" } as unknown as Runtime;
    createRuntimeMock.mockReturnValue(targetRuntime);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_PATH,
        branchName: NEW_WORKSPACE_NAME,
        trunkBranch: "develop",
        directoryName: NEW_WORKSPACE_NAME,
      })
    );

    expect(result).toEqual({
      success: true,
      data: {
        workspacePath: "/workspaces/created",
        trunkBranch: "develop",
        forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
        targetRuntime,
        forkedFromSource: false,
        sourceRuntimeConfigUpdated: false,
      },
    });

    expect(createRuntimeMock).toHaveBeenCalledWith(DEFAULT_FORKED_RUNTIME_CONFIG, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
      workspacePath: "/workspaces/created",
    });
  });

  it("returns Err immediately when fork fails and fallback is not allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork denied",
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
    });

    expect(result).toEqual({ success: false, error: "fork denied" });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
    expect(createRuntimeMock).not.toHaveBeenCalled();
  });

  it("returns Err for fatal fork failures even when fallback is allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fatal fork failure",
      failureIsFatal: true,
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual({ success: false, error: "fatal fork failure" });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("prefers sourceWorkspaceName as trunk branch when listed locally during fallback", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({ success: false } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockResolvedValue([SOURCE_WORKSPACE_NAME, "main", "develop"]);
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/from-source-workspace-branch",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success result, got error: ${result.error}`);
    }

    expect(result.data.trunkBranch).toBe(SOURCE_WORKSPACE_NAME);
    expect(result.data.forkedFromSource).toBe(false);
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("falls back to main when trunk branch detection throws", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({ success: false } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockRejectedValue(new Error("git unavailable"));
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/main-fallback",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success result, got error: ${result.error}`);
    }

    expect(result.data.trunkBranch).toBe("main");
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("uses preferredTrunkBranch when fork fails and git discovery is unavailable", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();

    forkWorkspace.mockResolvedValue({
      success: false,
      failureIsFatal: false,
      error: "fork not supported",
    } satisfies WorkspaceForkResult);

    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/new",
    } satisfies WorkspaceCreationResult);

    // Simulate SSH/Docker where local git discovery is unavailable.
    // Use mockImplementation instead of mockRejectedValue so Bun does not surface an
    // eager unhandled rejection when preferredTrunkBranch short-circuits git discovery.
    listLocalBranchesMock.mockImplementation(() => {
      throw new Error("git not available");
    });

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
      preferredTrunkBranch: "develop",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success result, got error: ${result.error}`);
    }

    expect(result.data.trunkBranch).toBe("develop");
    expect(result.data.forkedFromSource).toBe(false);

    // createWorkspace should receive the preferred trunk branch.
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ trunkBranch: "develop" })
    );

    // preferredTrunkBranch short-circuits local git discovery.
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
  });

  it("surfaces sourceRuntimeConfigUpdate without persisting it in orchestrator", async () => {
    const { sourceRuntime, forkWorkspace } = createSourceRuntimeMocks();
    const sourceRuntimeConfigUpdate: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "/tmp/shared-src",
    };
    forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/forked-with-source-update",
      sourceBranch: "main",
      sourceRuntimeConfig: sourceRuntimeConfigUpdate,
    } satisfies WorkspaceForkResult);
    applyForkRuntimeUpdatesMock.mockResolvedValue({
      forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
      sourceRuntimeConfigUpdate,
    });
    const config = createConfig();

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
      config,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success result, got error: ${result.error}`);
    }

    expect(result.data.sourceRuntimeConfigUpdated).toBe(true);
    expect(result.data.sourceRuntimeConfigUpdate).toEqual(sourceRuntimeConfigUpdate);
    expect(applyForkRuntimeUpdatesMock).toHaveBeenCalledWith(
      config,
      SOURCE_WORKSPACE_ID,
      SOURCE_RUNTIME_CONFIG,
      expect.objectContaining({
        sourceRuntimeConfig: sourceRuntimeConfigUpdate,
      }),
      { persistSourceRuntimeConfigUpdate: false }
    );
  });

  it("uses the runtime config from applyForkRuntimeUpdates when creating target runtime", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/created-with-custom-runtime",
    } satisfies WorkspaceCreationResult);

    const customForkedRuntimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "ssh.example.com",
      srcBaseDir: "~/mux",
    };
    applyForkRuntimeUpdatesMock.mockResolvedValue({
      forkedRuntimeConfig: customForkedRuntimeConfig,
    });

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success result, got error: ${result.error}`);
    }

    expect(result.data.forkedRuntimeConfig).toEqual(customForkedRuntimeConfig);
    expect(createRuntimeMock).toHaveBeenCalledWith(customForkedRuntimeConfig, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
      workspacePath: "/workspaces/created-with-custom-runtime",
    });
  });

  it("normalizes Docker containerName to destination workspace identity", async () => {
    const { sourceRuntime, forkWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/new",
    } satisfies WorkspaceForkResult);

    // Source Docker config with a container name belonging to the source workspace
    const sourceDockerConfig: RuntimeConfig = {
      type: "docker",
      image: "node:20",
      containerName: "mux-demo-source-aaaaaa",
    };

    // applyForkRuntimeUpdates returns the source config unchanged (simulating fallback)
    applyForkRuntimeUpdatesMock.mockResolvedValue({
      forkedRuntimeConfig: sourceDockerConfig,
    });

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
      sourceRuntimeConfig: sourceDockerConfig,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    // Must use destination-derived container name, not the inherited source name
    const expectedContainerName = getContainerName(PROJECT_PATH, NEW_WORKSPACE_NAME);
    expect(result.data.forkedRuntimeConfig).toEqual({
      type: "docker",
      image: "node:20",
      containerName: expectedContainerName,
    });
    expect(result.data.forkedRuntimeConfig).not.toEqual(
      expect.objectContaining({ containerName: "mux-demo-source-aaaaaa" })
    );

    // createRuntime should also receive the normalized config and the created workspace path.
    expect(createRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: expectedContainerName }),
      {
        projectPath: PROJECT_PATH,
        workspaceName: NEW_WORKSPACE_NAME,
        workspacePath: "/workspaces/new",
      }
    );
  });
  it("returns Err when create fallback also fails", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    createWorkspace.mockResolvedValue({
      success: false,
      error: "create failed",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual({ success: false, error: "create failed" });
    expect(createRuntimeMock).not.toHaveBeenCalled();
  });
});
