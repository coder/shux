import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import type { ExecOptions, ExecStream } from "./Runtime";

interface RuntimeState {
  remoteHomeDir?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  currentWorkspacePath?: string;
}

function createRuntime(state: RuntimeState): DevcontainerRuntime {
  const runtime = new DevcontainerRuntime({
    srcBaseDir: "/tmp/mux",
    configPath: ".devcontainer/devcontainer.json",
  });
  const internal = runtime as unknown as RuntimeState;
  internal.remoteHomeDir = state.remoteHomeDir;
  internal.remoteUser = state.remoteUser;
  internal.remoteWorkspaceFolder = state.remoteWorkspaceFolder;
  internal.currentWorkspacePath = state.currentWorkspacePath;
  return runtime;
}

function createTextStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function createSinkStream(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>();
}

class RecordingDevcontainerRuntime extends DevcontainerRuntime {
  execOptions: ExecOptions | undefined;

  override exec(_command: string, options: ExecOptions): Promise<ExecStream> {
    this.execOptions = options;
    return Promise.resolve({
      stdout: createTextStream("123 456 regular file\n"),
      stderr: createTextStream(""),
      stdin: createSinkStream(),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

describe("DevcontainerRuntime.stat", () => {
  it("forwards abort signals to exec-backed container stats", async () => {
    const runtime = new RecordingDevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });
    const abortController = new AbortController();

    await runtime.stat("relative/file.txt", abortController.signal);

    expect(runtime.execOptions?.abortSignal).toBe(abortController.signal);
    expect(runtime.execOptions?.pathEnv).toEqual({
      XUM_INTERNAL_FILE_PATH: "relative/file.txt",
    });
  });
});

describe("DevcontainerRuntime.resolvePath", () => {
  it("resolves ~ to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/home/coder" });
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
  });

  it("throws when home is unknown", async () => {
    const runtime = createRuntime({});
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects requires await
    await expect(runtime.resolvePath("~")).rejects.toThrow("container home directory unavailable");
  });

  it("resolves ~/path to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/opt/user" });
    expect(await runtime.resolvePath("~/.mux")).toBe("/opt/user/.mux");
  });

  it("falls back to /home/<user> without cached home", async () => {
    const runtime = createRuntime({ remoteUser: "node" });
    expect(await runtime.resolvePath("~")).toBe("/home/node");
  });

  it("falls back to /root for root user", async () => {
    const runtime = createRuntime({ remoteUser: "root" });
    expect(await runtime.resolvePath("~")).toBe("/root");
  });

  it("resolves relative paths against remoteWorkspaceFolder", async () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/demo" });
    expect(await runtime.resolvePath("./foo")).toBe("/workspaces/demo/foo");
    expect(await runtime.resolvePath("bar")).toBe("/workspaces/demo/bar");
  });

  it("resolves relative paths against / when no workspace set", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("foo")).toBe("/foo");
  });

  it("passes absolute paths through", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("/tmp/test")).toBe("/tmp/test");
  });
});

describe("DevcontainerRuntime.resolveContainerCwd", () => {
  // Access the private method for testing
  function resolveContainerCwd(
    runtime: DevcontainerRuntime,
    optionsCwd: string | undefined,
    workspaceFolder: string
  ): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveContainerCwd(optionsCwd, workspaceFolder);
  }

  it("uses POSIX absolute path as cwd", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "/tmp/test", "/host/workspace")).toBe("/tmp/test");
  });

  it("rejects Windows drive letter paths and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "C:\\Users\\dev", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("rejects paths with backslashes and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "some\\path", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("falls back to workspaceFolder when remoteWorkspaceFolder not set", () => {
    const runtime = createRuntime({});
    expect(resolveContainerCwd(runtime, "C:\\", "/host/workspace")).toBe("/host/workspace");
  });

  it("falls back when cwd is undefined", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, undefined, "/host/workspace")).toBe("/workspaces/project");
  });
});

describe("DevcontainerRuntime.resolveHostPathForMounted", () => {
  function resolveHostPathForMounted(
    runtime: DevcontainerRuntime,
    filePath: string
  ): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveHostPathForMounted(filePath);
  }

  it("accepts Windows host paths under the workspace root", () => {
    const runtime = createRuntime({ currentWorkspacePath: "C:\\ws\\proj" });
    const filePath = "C:\\ws\\proj\\.mux\\mcp.local.jsonc";
    expect(resolveHostPathForMounted(runtime, filePath)).toBe(filePath);
  });
});
describe("DevcontainerRuntime exec path translation", () => {
  function mapPathForExec(runtime: DevcontainerRuntime, filePath: string): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).mapPathForExec(filePath);
  }

  it("maps workspace roots and nested paths into the container", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/xum/project/branch",
    });

    expect(mapPathForExec(runtime, "/home/user/xum/project/branch")).toBe("/workspaces/project");
    expect(mapPathForExec(runtime, "/home/user/xum/project/branch/nested/file")).toBe(
      "/workspaces/project/nested/file"
    );
  });

  it("keeps paths outside the workspace unchanged", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/xum/project/branch",
    });

    expect(mapPathForExec(runtime, "/tmp/other")).toBe("/tmp/other");
  });

  it("keeps paths unchanged when the container workspace is unknown", () => {
    const runtime = createRuntime({ currentWorkspacePath: "/home/user/xum/project/branch" });

    expect(mapPathForExec(runtime, "/home/user/xum/project/branch/nested/file")).toBe(
      "/home/user/xum/project/branch/nested/file"
    );
  });
});

describe("DevcontainerRuntime.mapHostPathToContainer", () => {
  // Access the private method for testing
  function mapHostPathToContainer(runtime: DevcontainerRuntime, hostPath: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).mapHostPathToContainer(hostPath);
  }

  it("maps host workspace root to container workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch")).toBe(
      "/workspaces/project"
    );
  });

  it("maps host subpath to container subpath", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch/src/file.ts")).toBe(
      "/workspaces/project/src/file.ts"
    );
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "C:\\Users\\dev\\mux\\project\\branch",
    });
    // Windows-style path with backslashes should map correctly
    expect(
      mapHostPathToContainer(runtime, "C:\\Users\\dev\\mux\\project\\branch\\src\\file.ts")
    ).toBe("/workspaces/project/src/file.ts");
  });

  it("returns null for paths outside workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/tmp/other")).toBeNull();
  });

  it("returns null when workspace not set", () => {
    const runtime = createRuntime({});
    expect(mapHostPathToContainer(runtime, "/some/path")).toBeNull();
  });
});

interface RuntimeWithContainerRequirements {
  computeContainerRequirements(workspacePath: string, runtimeEnv?: Record<string, string>): void;
  containerMounts: Array<{ source: string; target: string }>;
}

describe("DevcontainerRuntime.getContainerEnv", () => {
  const trackedEnvKeys = ["GIT_ASKPASS"] as const;
  const tempDirs: string[] = [];
  let originalValues = new Map<string, string | undefined>();

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    originalValues = new Map(trackedEnvKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(async () => {
    for (const key of trackedEnvKeys) {
      const value = originalValues.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("returns empty by default", () => {
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });

    expect(runtime.getContainerEnv()).toEqual({});
  });

  it("returns cached env after computeContainerRequirements", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-env-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      shareCredentials: true,
    });
    const internal = runtime as unknown as RuntimeWithContainerRequirements;

    internal.computeContainerRequirements(workspacePath);

    expect(runtime.getContainerEnv()).toMatchObject({ GIT_ASKPASS: "/usr/bin/coder" });
  });

  it("with shareCredentials=false keeps env empty and only adds gitdir mount when present", async () => {
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });
    const internal = runtime as unknown as RuntimeWithContainerRequirements;

    const workspaceWithoutGit = await createTempDir("mux-devcontainer-no-git-");
    internal.computeContainerRequirements(workspaceWithoutGit);
    expect(runtime.getContainerEnv()).toEqual({});
    expect(internal.containerMounts).toEqual([]);

    const workspaceWithGitdir = await createTempDir("mux-devcontainer-worktree-");
    const projectPath = await createTempDir("mux-devcontainer-project-");
    const gitdirPath = path.join(projectPath, ".git", "worktrees", "feature");
    const dotGitDir = path.join(projectPath, ".git");

    await fs.mkdir(gitdirPath, { recursive: true });
    await fs.writeFile(path.join(workspaceWithGitdir, ".git"), `gitdir: ${gitdirPath}\n`, "utf-8");

    internal.computeContainerRequirements(workspaceWithGitdir);

    expect(runtime.getContainerEnv()).toEqual({});
    expect(internal.containerMounts).toEqual([{ source: dotGitDir, target: dotGitDir }]);
  });

  it("returns credential env after setCurrentWorkspacePath with shareCredentials=true", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-setpath-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      shareCredentials: true,
    });

    runtime.setCurrentWorkspacePath(workspacePath);

    // Env should be populated without calling ensureReady()
    expect(runtime.getContainerEnv()).toMatchObject({ GIT_ASKPASS: "/usr/bin/coder" });
  });

  it("keeps env empty after setCurrentWorkspacePath with shareCredentials=false", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-setpath-nocred-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      // shareCredentials defaults to false
    });

    runtime.setCurrentWorkspacePath(workspacePath);

    expect(runtime.getContainerEnv()).toEqual({});
  });
});
