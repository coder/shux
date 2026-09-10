import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DockerRuntime, getContainerName, type DockerRuntimeConfig } from "./DockerRuntime";
import type { ExecOptions, ExecStream, InitLogger, WorkspaceInitParams } from "./Runtime";

const noopInitLogger: InitLogger = {
  logStep: () => {
    // no-op
  },
  logStdout: () => {
    // no-op
  },
  logStderr: () => {
    // no-op
  },
  logComplete: () => {
    // no-op
  },
};

interface ContainerUserFixture {
  uid: string;
  gid: string;
  home: string;
}

interface ExecCall {
  command: string;
  options: ExecOptions;
  stdinChunks: Uint8Array[];
}

function createTextStream(text = ""): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

class CredentialTestDockerRuntime extends DockerRuntime {
  readonly log: string[] = [];
  readonly execCalls: ExecCall[] = [];

  constructor(
    config: DockerRuntimeConfig,
    private readonly userFixture: ContainerUserFixture
  ) {
    super(config);
  }

  protected override checkExistingContainer(
    _containerName: string,
    _workspacePath: string,
    _branchName: string
  ): Promise<{ action: "skip" }> {
    this.log.push("checkExistingContainer");
    return Promise.resolve({ action: "skip" });
  }

  protected override detectContainerUser(
    _containerName: string,
    _abortSignal?: AbortSignal
  ): Promise<ContainerUserFixture> {
    this.log.push("detectContainerUser");
    return Promise.resolve(this.userFixture);
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const call: ExecCall = { command, options, stdinChunks: [] };
    this.log.push(`exec:${command}`);
    this.execCalls.push(call);

    return Promise.resolve({
      stdout: createTextStream(),
      stderr: createTextStream(),
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          call.stdinChunks.push(chunk.slice());
        },
      }),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

function buildPostCreateSetupParams(
  overrides: Partial<WorkspaceInitParams> = {}
): WorkspaceInitParams {
  return {
    projectPath: "/tmp/project",
    branchName: "feature",
    trunkBranch: "main",
    workspacePath: "/src",
    initLogger: noopInitLogger,
    ...overrides,
  };
}

function getGitconfigWriteCall(runtime: CredentialTestDockerRuntime): ExecCall | undefined {
  return runtime.execCalls.find((call) => call.command.includes(".gitconfig"));
}

function getGhSetupCall(runtime: CredentialTestDockerRuntime): ExecCall | undefined {
  return runtime.execCalls.find((call) => call.command.includes("gh auth setup-git"));
}

describe("DockerRuntime constructor", () => {
  it("should return image via getImage()", () => {
    const runtime = new DockerRuntime({ image: "node:20" });
    expect(runtime.getImage()).toBe("node:20");
  });

  it("should return /src for workspace path", () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    expect(runtime.getWorkspacePath("/any/project", "any-branch")).toBe("/src");
  });

  it("should accept containerName for existing workspaces", () => {
    // When recreating runtime for existing workspace, containerName is passed in config
    const runtime = new DockerRuntime({
      image: "ubuntu:22.04",
      containerName: "mux-myproject-my-feature",
    });
    expect(runtime.getImage()).toBe("ubuntu:22.04");
    // Runtime should be ready for exec operations without calling createWorkspace
  });
});

describe("DockerRuntime.postCreateSetup credentials", () => {
  const hostGitconfigContents = Buffer.from("[user]\n\tname = Mux Test\n");
  let originalHome: string | undefined;
  let originalGhToken: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalGhToken = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mux-docker-credentials-"));
    await fs.writeFile(path.join(tempHome, ".gitconfig"), hostGitconfigContents);
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("detects and caches a non-root user before writing gitconfig to its home", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "codercom/enterprise-base", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    const writeCall = getGitconfigWriteCall(runtime);
    expect(writeCall).toBeDefined();
    expect(runtime.log.indexOf("detectContainerUser")).toBeLessThan(
      runtime.log.findIndex((entry) => entry.includes(".gitconfig"))
    );
    expect(writeCall?.command).toContain("$HOME/.gitconfig");
    expect(writeCall?.command).not.toContain("/root/.gitconfig");
    expect([...Buffer.concat(writeCall?.stdinChunks ?? [])]).toEqual([...hostGitconfigContents]);
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
  });

  it("preserves root container home behavior", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "0", gid: "0", home: "/root" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    const writeCall = getGitconfigWriteCall(runtime);
    expect(writeCall?.command).toContain("$HOME/.gitconfig");
    expect([...Buffer.concat(writeCall?.stdinChunks ?? [])]).toEqual([...hostGitconfigContents]);
    expect(await runtime.resolvePath("~")).toBe("/root");
  });

  it("runs gh credential setup after user detection when a token is provided", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams({ env: { GH_TOKEN: "test-token" } }));

    const ghCall = getGhSetupCall(runtime);
    expect(ghCall).toBeDefined();
    expect(runtime.log.indexOf("detectContainerUser")).toBeLessThan(
      runtime.log.findIndex((entry) => entry.includes("gh auth setup-git"))
    );
    expect(ghCall?.options.env).toEqual({ GH_TOKEN: "test-token" });
  });

  it("does not run gh credential setup without a token", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    expect(getGhSetupCall(runtime)).toBeUndefined();
  });

  it("skips credential commands when credential sharing is disabled or absent", async () => {
    for (const shareCredentials of [false, undefined]) {
      const runtime = new CredentialTestDockerRuntime(
        {
          image: "ubuntu:22.04",
          containerName: "mux-test",
          ...(shareCredentials === undefined ? {} : { shareCredentials }),
        },
        { uid: "1000", gid: "1000", home: "/home/coder" }
      );

      await runtime.postCreateSetup(buildPostCreateSetupParams());

      expect(getGitconfigWriteCall(runtime)).toBeUndefined();
      expect(getGhSetupCall(runtime)).toBeUndefined();
    }
  });
});

describe("DockerRuntime.forkWorkspace", () => {
  it("stops before Docker commands when the fork is already aborted", async () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    const abortController = new AbortController();
    abortController.abort();

    const result = await runtime.forkWorkspace({
      projectPath: "/tmp/project",
      sourceWorkspaceName: "main",
      newWorkspaceName: "feature",
      initLogger: noopInitLogger,
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });
});

describe("getContainerName", () => {
  it("should generate container name from project and workspace", () => {
    expect(getContainerName("/home/user/myproject", "feature-branch")).toBe(
      "mux-myproject-feature-branch-a8d18a"
    );
  });

  it("should sanitize special characters", () => {
    expect(getContainerName("/home/user/my@project", "feature/branch")).toBe(
      "mux-my-project-feature-branch-b354b4"
    );
  });

  it("should handle long names", () => {
    const longName = "a".repeat(100);
    const result = getContainerName("/project", longName);
    // Docker has 64 char limit, function uses 63 to be safe
    expect(result.length).toBeLessThanOrEqual(63);
  });
});
