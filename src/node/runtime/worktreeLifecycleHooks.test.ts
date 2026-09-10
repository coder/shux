import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { log } from "@/node/services/log";
import * as disposableExec from "@/node/utils/disposableExec";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import { createWorktreeArchiveHook } from "./worktreeLifecycleHooks";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(noop);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: noop,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

function createWorkspaceMetadata(
  overrides?: Partial<FrontendWorkspaceMetadata>
): FrontendWorkspaceMetadata {
  const runtimeConfig = overrides?.runtimeConfig ?? {
    type: "worktree" as const,
    srcBaseDir: "/tmp/src",
  };
  const name = overrides?.name ?? "workspace-name";
  const defaultNamedWorkspacePath =
    runtimeConfig.type === "worktree"
      ? path.join(runtimeConfig.srcBaseDir, "_workspaces", name)
      : path.join("/tmp", name);

  return {
    id: "ws",
    name,
    projectName: "project-name",
    projectPath: "/tmp/project-name",
    runtimeConfig,
    namedWorkspacePath: overrides?.namedWorkspacePath ?? defaultNamedWorkspacePath,
    ...overrides,
  };
}

function getManagedPath(workspaceMetadata: FrontendWorkspaceMetadata): string {
  return workspaceMetadata.namedWorkspacePath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.promises
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

describe("createWorktreeArchiveHook", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mock.restore();

    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-worktree-archive-"));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  it("skips deletion when worktree archive behavior keeps the checkout", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "keep",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(managedPath)).toBe(true);
  });

  it("never deletes the ancestor checkout used by an isolation-none task", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
      taskIsolation: "none",
      namedWorkspacePath: path.join(srcBaseDir, "_workspaces", "parent-workspace"),
    });
    const sharedPath = getManagedPath(workspaceMetadata);
    await mkdir(sharedPath, { recursive: true });
    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync");

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).not.toHaveBeenCalled();
    expect(await pathExists(sharedPath)).toBe(true);
  });

  it("deletes the managed worktree with git worktree remove when cleanup is enabled", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        if (
          file === "git" &&
          args[0] === "-C" &&
          args[1] === workspaceMetadata.projectPath &&
          args[2] === "worktree" &&
          args[3] === "remove" &&
          args[4] === "--force" &&
          args[5] === managedPath
        ) {
          expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });
          return createMockExecResult(
            rm(managedPath, { recursive: true, force: true }).then(() => ({
              stdout: "",
              stderr: "",
            }))
          );
        }

        throw new Error(`Unexpected git command: ${file} ${args.join(" ")}`);
      }
    );

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).toHaveBeenCalledWith(
      "git",
      ["-C", workspaceMetadata.projectPath, "worktree", "remove", "--force", managedPath],
      { env: GIT_NO_HOOKS_ENV }
    );
    expect(await pathExists(managedPath)).toBe(false);
  });

  it("skips snapshot cleanup for multi-project workspaces so restore can rehydrate safely", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "snapshot",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(managedPath)).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      "Skipping snapshot worktree cleanup for multi-project archive",
      { workspaceId: workspaceMetadata.id }
    );
  });

  it("skips cleanup for non-worktree runtimes even when cleanup is enabled", async () => {
    const tempRoot = await createTempRoot();
    const untouchedPath = path.join(tempRoot, "project-name", "workspace-name");
    await mkdir(untouchedPath, { recursive: true });

    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "local" },
    });

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "snapshot",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(untouchedPath)).toBe(true);
  });

  it("returns Ok and prunes stale metadata when the managed worktree directory is already missing", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        expect(file).toBe("git");
        expect(args).toEqual(["-C", workspaceMetadata.projectPath, "worktree", "prune"]);
        expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).toHaveBeenCalledWith(
      "git",
      ["-C", workspaceMetadata.projectPath, "worktree", "prune"],
      { env: GIT_NO_HOOKS_ENV }
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("prunes stale metadata when git reports the worktree is already gone", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        expect(file).toBe("git");
        expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });

        if (args[3] === "remove") {
          return createMockExecResult(
            rm(managedPath, { recursive: true, force: true }).then(() => {
              throw new Error("fatal: '/missing' does not exist");
            })
          );
        }

        expect(args).toEqual(["-C", workspaceMetadata.projectPath, "worktree", "prune"]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("falls back to recursive removal when git reports a missing worktree but the managed path still exists", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    const removeError = new Error("fatal: '/missing' does not exist");
    await mkdir(managedPath, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        expect(file).toBe("git");
        expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });

        if (args[3] === "remove") {
          expect(args).toEqual([
            "-C",
            workspaceMetadata.projectPath,
            "worktree",
            "remove",
            "--force",
            managedPath,
          ]);
          return createMockExecResult(Promise.reject(removeError));
        }

        expect(args).toEqual(["-C", workspaceMetadata.projectPath, "worktree", "prune"]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(await pathExists(managedPath)).toBe(false);
  });

  it("falls back to recursive removal when git worktree remove fails and still returns Ok", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    const removeError = new Error("git worktree remove failed");
    await mkdir(managedPath, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        expect(file).toBe("git");
        expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });

        if (args[3] === "remove") {
          expect(args).toEqual([
            "-C",
            workspaceMetadata.projectPath,
            "worktree",
            "remove",
            "--force",
            managedPath,
          ]);
          return createMockExecResult(Promise.reject(removeError));
        }

        expect(args).toEqual(["-C", workspaceMetadata.projectPath, "worktree", "prune"]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(await pathExists(managedPath)).toBe(false);
  });
});
