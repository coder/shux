import { describe, expect, it, spyOn } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import * as disposableExec from "@/node/utils/disposableExec";
import type { InitLogger } from "@/node/runtime/Runtime";
import * as submoduleSync from "@/node/runtime/submoduleSync";
import { WorktreeManager } from "./WorktreeManager";

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

function createNullInitLogger(): InitLogger {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
  };
}

async function createWorktreeManagerFixture(options?: {
  existingBranchName?: string;
  currentBranchName?: string;
  tempDirPrefix?: string;
  fetchTimeoutMs?: number;
}) {
  const rootDir = await fsPromises.realpath(
    await fsPromises.mkdtemp(
      path.join(os.tmpdir(), options?.tempDirPrefix ?? "worktree-manager-create-")
    )
  );
  const projectPath = path.join(rootDir, "repo");
  await fsPromises.mkdir(projectPath, { recursive: true });
  initGitRepo(projectPath);

  if (options?.currentBranchName) {
    execSync(`git checkout -b ${options.currentBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  if (options?.existingBranchName) {
    execSync(`git branch ${options.existingBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  const srcBaseDir = path.join(rootDir, "src");
  await fsPromises.mkdir(srcBaseDir, { recursive: true });

  return {
    rootDir,
    projectPath,
    manager: new WorktreeManager(
      srcBaseDir,
      options?.fetchTimeoutMs === undefined ? undefined : { fetchTimeoutMs: options.fetchTimeoutMs }
    ),
    initLogger: createNullInitLogger(),
    cleanup: () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
}

/**
 * Point origin at an upload-pack shim that never answers and leaves a background child holding
 * the inherited stdio pipes, like a credential helper blocked on external authentication.
 */
async function installStalledOriginFetch(fixture: { rootDir: string; projectPath: string }) {
  const pidFile = path.join(fixture.rootDir, "stall-pids");
  const shim = path.join(fixture.rootDir, "stalled-upload-pack.sh");
  await fsPromises.writeFile(
    shim,
    `#!/bin/sh\nsleep 600 &\nprintf '%s\\n%s\\n' "$$" "$!" > "${pidFile}"\nwait\n`,
    "utf-8"
  );
  await fsPromises.chmod(shim, 0o755);
  execFileSync("git", ["remote", "add", "origin", "."], {
    cwd: fixture.projectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "remote.origin.uploadpack", shim], {
    cwd: fixture.projectPath,
    stdio: "ignore",
  });

  return {
    async waitForPids(): Promise<number[]> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const lines = await fsPromises.readFile(pidFile, "utf-8").then(
          (content) => content.trim().split("\n"),
          () => []
        );
        if (lines.length === 2) return lines.map(Number);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("stalled upload-pack shim did not start");
    },
  };
}

async function isProcessGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  // A killed orphan that PID 1 has not reaped yet still answers signal 0.
  return fsPromises.readFile(`/proc/${pid}/stat`, "utf-8").then(
    (stat) => stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"),
    () => false
  );
}

async function waitForProcessesToExit(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const gone = await Promise.all(pids.map(isProcessGone));
    if (gone.every(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function gitRevParseHead(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

describe("WorktreeManager constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const manager = new WorktreeManager("~/workspace");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const manager = new WorktreeManager("/absolute/path");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const manager = new WorktreeManager("~");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("WorktreeManager.createWorkspace", () => {
  for (const existing of [false, true]) {
    it(`populates a clean ${existing ? "existing-branch" : "new-branch"} worktree and streams checkout output`, async () => {
      const branchName = "feature-progress";
      const fixture = await createWorktreeManagerFixture({
        existingBranchName: existing ? branchName : undefined,
      });
      const realExecFile = disposableExec.execFileAsync;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const progress: Array<[string, number]> = [];
      const initLogger = {
        ...fixture.initLogger,
        logStdout: (line: string) => stdout.push(line),
        logStderr: (line: string) => stderr.push(line),
        logProgress: (label: string, percent: number) => progress.push([label, percent]),
      };
      const workspacePath = fixture.manager.getWorkspacePath(fixture.projectPath, branchName);
      const hookMarker = path.join(fixture.rootDir, "checkout-hook-ran");
      const hook = path.join(fixture.projectPath, ".git", "hooks", "post-checkout");
      let checkoutStarted = false;
      const execSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
        (file, args, options) => {
          if (file === "git" && args[2] === "checkout") {
            checkoutStarted = true;
            expect(existsSync(path.join(workspacePath, "README.md"))).toBe(false);
          }
          const proc = realExecFile(file, args, options);
          if (file === "git" && args[2] === "worktree" && args[3] === "add") {
            // Inject stdout so forwarding coverage does not depend on Git's output.
            const result = proc.result;
            Object.defineProperty(proc, "result", {
              value: result.then((output) => ({
                ...output,
                stdout: "worktree metadata ready\r\n",
              })),
            });
          }
          return proc;
        }
      );
      try {
        let expectedContent = "hello\n";
        if (existing) {
          execFileSync("git", ["checkout", branchName], {
            cwd: fixture.projectPath,
            stdio: "ignore",
          });
          expectedContent = "existing branch contents\n";
          await fsPromises.writeFile(path.join(fixture.projectPath, "README.md"), expectedContent);
          execFileSync("git", ["commit", "-am", "branch contents"], {
            cwd: fixture.projectPath,
            stdio: "ignore",
          });
          execFileSync("git", ["checkout", "main"], { cwd: fixture.projectPath, stdio: "ignore" });
        }
        await fsPromises.writeFile(hook, '#!/bin/sh\nprintf ran > "' + hookMarker + '"\n');
        await fsPromises.chmod(hook, 0o755);
        const result = await fixture.manager.createWorkspace({
          projectPath: fixture.projectPath,
          branchName,
          trunkBranch: "main",
          skipRemoteSync: true,
          trusted: false,
          initLogger,
        });
        expect(result).toEqual({ success: true, workspacePath });
        expect(checkoutStarted).toBe(true);
        expect(await fsPromises.readFile(path.join(workspacePath, "README.md"), "utf8")).toBe(
          expectedContent
        );
        expect(
          execFileSync("git", ["status", "--porcelain"], { cwd: workspacePath }).toString()
        ).toBe("");
        expect(
          execFileSync("git", ["branch", "--show-current"], { cwd: workspacePath })
            .toString()
            .trim()
        ).toBe(branchName);
        expect(existsSync(hookMarker)).toBe(false);
        expect(stdout).toContain("worktree metadata ready");
        expect(stderr.some((line) => line.includes("Preparing worktree"))).toBe(true);
        // Real git progress: a one-file checkout only reports progress because the
        // checkout disables git's 2s progress delay.
        expect(stderr.some((line) => /^Updating files: 100% \(1\/1\), done\.$/.test(line))).toBe(
          true
        );
        expect(stderr.some((line) => line.includes(branchName))).toBe(true);
        expect(progress).toEqual([["Updating files", 100]]);
      } finally {
        execSpy.mockRestore();
        await fixture.cleanup();
      }
    }, 20_000);

    it(`removes a failed ${existing ? "existing-branch" : "new-branch"} worktree checkout`, async () => {
      const branchName = "feature-checkout-failure";
      const fixture = await createWorktreeManagerFixture({
        existingBranchName: existing ? branchName : undefined,
      });
      const stderr: string[] = [];
      try {
        await fsPromises.writeFile(
          path.join(fixture.projectPath, ".gitattributes"),
          "README.md filter=fail\n"
        );
        execFileSync("git", ["add", ".gitattributes"], {
          cwd: fixture.projectPath,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "require checkout filter"], {
          cwd: fixture.projectPath,
          stdio: "ignore",
        });
        if (existing) {
          execFileSync("git", ["branch", "-f", branchName, "main"], {
            cwd: fixture.projectPath,
            stdio: "ignore",
          });
        }
        execFileSync("git", ["config", "filter.fail.smudge", "exit 1"], {
          cwd: fixture.projectPath,
        });
        execFileSync("git", ["config", "filter.fail.required", "true"], {
          cwd: fixture.projectPath,
        });
        const result = await fixture.manager.createWorkspace({
          projectPath: fixture.projectPath,
          branchName,
          trunkBranch: "main",
          skipRemoteSync: true,
          trusted: true,
          initLogger: { ...fixture.initLogger, logStderr: (line) => stderr.push(line) },
        });
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected checkout to fail");
        expect(result.error).toContain("smudge filter fail failed");
        expect(stderr.some((line) => line.includes("smudge filter fail failed"))).toBe(true);
        const workspacePath = fixture.manager.getWorkspacePath(fixture.projectPath, branchName);
        expect(existsSync(workspacePath)).toBe(false);
        expect(
          execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd: fixture.projectPath,
          }).toString()
        ).not.toContain(workspacePath);
        expect(
          execFileSync("git", ["branch", "--list", branchName], { cwd: fixture.projectPath })
            .toString()
            .trim()
        ).toBe(existing ? branchName : "");
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);
  }

  const rollbackCases = [
    {
      name: "rolls back failed new worktrees when submodule materialization fails",
      branchName: "feature-rollback",
      existingBranchName: undefined,
      expectedBranchAfter: "",
    },
    {
      name: "preserves existing branches when rollback removes a failed worktree",
      branchName: "feature-existing",
      existingBranchName: "feature-existing",
      expectedBranchAfter: "feature-existing",
    },
  ] as const;

  for (const testCase of rollbackCases) {
    it(
      testCase.name,
      async () => {
        const fixture = await createWorktreeManagerFixture({
          existingBranchName: testCase.existingBranchName,
        });

        try {
          const workspacePath = fixture.manager.getWorkspacePath(
            fixture.projectPath,
            testCase.branchName
          );
          const syncSpy = spyOn(submoduleSync, "syncLocalGitSubmodules").mockImplementation(() =>
            Promise.reject(new Error("submodule auth failed"))
          );

          try {
            const result = await fixture.manager.createWorkspace({
              projectPath: fixture.projectPath,
              branchName: testCase.branchName,
              trunkBranch: "main",
              initLogger: fixture.initLogger,
              trusted: true,
            });

            expect(result.success).toBe(false);
            if (result.success) {
              throw new Error("Expected createWorkspace to fail");
            }
            expect(result.error).toContain("submodule auth failed");

            let workspaceExists = true;
            try {
              await fsPromises.access(workspacePath);
            } catch {
              workspaceExists = false;
            }
            expect(workspaceExists).toBe(false);

            const branchAfter = execSync(`git branch --list "${testCase.branchName}"`, {
              cwd: fixture.projectPath,
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim();
            expect(branchAfter).toBe(testCase.expectedBranchAfter);
          } finally {
            syncSpy.mockRestore();
          }
        } finally {
          await fixture.cleanup();
        }
      },
      20_000
    );
  }
  it("returns a structured failure when git preflight cannot inspect the repository", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      await fsPromises.rm(fixture.projectPath, { recursive: true, force: true });
      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: "feature-missing-repo",
        trunkBranch: "main",
        initLogger: fixture.initLogger,
        trusted: false,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected createWorkspace to fail");
      }
      expect(result.error).toContain("Failed to inspect repository automation drivers");
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips repo-configured upload-pack commands when project automation is disabled", async () => {
    const fixture = await createWorktreeManagerFixture();
    const marker = path.join(fixture.rootDir, "upload-pack-ran");
    const uploadPack = path.join(fixture.rootDir, "upload-pack.sh");
    const previous = process.env.XUM_DISABLE_PROJECT_AUTOMATION;

    try {
      await fsPromises.writeFile(
        uploadPack,
        `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`,
        "utf-8"
      );
      await fsPromises.chmod(uploadPack, 0o755);
      execFileSync("git", ["remote", "add", "origin", "."], {
        cwd: fixture.projectPath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "remote.origin.uploadpack", uploadPack], {
        cwd: fixture.projectPath,
        stdio: "ignore",
      });
      process.env.XUM_DISABLE_PROJECT_AUTOMATION = "1";
      const steps: string[] = [];

      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: "feature-no-upload-pack",
        trunkBranch: "main",
        trusted: true,
        initLogger: {
          ...fixture.initLogger,
          logStep: (message) => steps.push(message),
        },
      });

      expect(result.success).toBe(true);
      expect(steps).toContain(
        "Skipping origin fetch while project automation is disabled; using local state."
      );
      const uploadPackRan = await fsPromises.access(marker).then(
        () => true,
        () => false
      );
      expect(uploadPackRan).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.XUM_DISABLE_PROJECT_AUTOMATION;
      } else {
        process.env.XUM_DISABLE_PROJECT_AUTOMATION = previous;
      }
      await fixture.cleanup();
    }
  }, 20_000);

  it("bounds a stalled origin fetch, kills its process tree, and falls back to the local trunk", async () => {
    const fixture = await createWorktreeManagerFixture({ fetchTimeoutMs: 1_000 });

    try {
      const stall = await installStalledOriginFetch(fixture);
      const stderrLines: string[] = [];

      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: "feature-stalled-fetch",
        trunkBranch: "main",
        trusted: true,
        initLogger: {
          ...fixture.initLogger,
          logStderr: (line) => stderrLines.push(line),
        },
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to fall back to the local trunk");
      }
      expect(stderrLines.some((line) => line.includes("did not finish within"))).toBe(true);
      expect(gitRevParseHead(result.workspacePath)).toBe(gitRevParseHead(fixture.projectPath));

      const pids = await stall.waitForPids();
      expect(await waitForProcessesToExit(pids)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("keeps caller cancellation a cancellation while the origin fetch stalls", async () => {
    const fixture = await createWorktreeManagerFixture({ fetchTimeoutMs: 30_000 });

    try {
      const stall = await installStalledOriginFetch(fixture);
      const controller = new AbortController();
      const stderrLines: string[] = [];
      const workspacePath = fixture.manager.getWorkspacePath(
        fixture.projectPath,
        "feature-cancelled-fetch"
      );

      const pending = fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: "feature-cancelled-fetch",
        trunkBranch: "main",
        trusted: true,
        abortSignal: controller.signal,
        initLogger: {
          ...fixture.initLogger,
          logStderr: (line) => stderrLines.push(line),
        },
      });
      const pids = await stall.waitForPids();
      controller.abort();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(stderrLines).toEqual([]);
      const workspaceExists = await fsPromises.access(workspacePath).then(
        () => true,
        () => false
      );
      expect(workspaceExists).toBe(false);
      expect(await waitForProcessesToExit(pids)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("bases new branches on the freshly fetched origin trunk", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      const remotePath = path.join(fixture.rootDir, "remote");
      execFileSync("git", ["clone", "--quiet", fixture.projectPath, remotePath], {
        stdio: "ignore",
      });
      execSync(
        'git config user.email "test@example.com" && git config user.name "test" && ' +
          'git config commit.gpgsign false && git commit --allow-empty -m "remote-only"',
        { cwd: remotePath, stdio: "ignore" }
      );
      execFileSync("git", ["remote", "add", "origin", remotePath], {
        cwd: fixture.projectPath,
        stdio: "ignore",
      });
      const remoteHead = gitRevParseHead(remotePath);
      expect(remoteHead).not.toBe(gitRevParseHead(fixture.projectPath));

      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: "feature-fresh-origin",
        trunkBranch: "main",
        trusted: true,
        initLogger: fixture.initLogger,
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to return a workspace path");
      }
      expect(gitRevParseHead(result.workspacePath)).toBe(remoteHead);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("uses a sanitized directory for slash branch names and persists the mapping", async () => {
    const fixture = await createWorktreeManagerFixture();
    const branchName = "feature/foo";
    const directoryName = "feature-foo";

    try {
      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
        trusted: true,
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to return a workspace path");
      }

      expect(result.workspacePath).toBe(
        fixture.manager.getWorkspacePath(fixture.projectPath, directoryName)
      );
      const nestedBranchDirectoryExists = await fsPromises
        .access(fixture.manager.getWorkspacePath(fixture.projectPath, "feature"))
        .then(
          () => true,
          () => false
        );
      expect(nestedBranchDirectoryExists).toBe(false);

      const checkedOutBranch = execSync("git branch --show-current", {
        cwd: result.workspacePath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(checkedOutBranch).toBe(branchName);

      const branchMapPath = path.join(fixture.projectPath, ".git", "mux-workspace-branches.json");
      const branchMap = JSON.parse(await fsPromises.readFile(branchMapPath, "utf8")) as Record<
        string,
        string
      >;
      expect(branchMap[directoryName]).toBe(branchName);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.renameWorkspace", () => {
  it("does not rename unrelated branches when the workspace tracks a different branch", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      const { projectPath, manager, initLogger } = fixture;
      const branchName = "feature-branch";
      const oldName = "review-slot";
      const newName = "renamed-slot";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        directoryName: oldName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      execSync(`git branch ${oldName}`, { cwd: projectPath, stdio: "ignore" });

      const renameResult = await manager.renameWorkspace(projectPath, oldName, newName, true);
      expect(renameResult.success).toBe(true);

      const trackedBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(trackedBranchAfter).toContain(branchName);

      const unrelatedBranchAfter = execSync(`git branch --list "${oldName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(unrelatedBranchAfter).toContain(oldName);

      const newNameBranchAfter = execSync(`git branch --list "${newName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(newNameBranchAfter).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("returns a structured failure when git preflight cannot inspect the repository", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      const oldName = "rename-preflight-old";
      const createResult = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: oldName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      await fsPromises.rm(fixture.projectPath, { recursive: true, force: true });

      const result = await fixture.manager.renameWorkspace(
        fixture.projectPath,
        oldName,
        "rename-preflight-new",
        false
      );

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected renameWorkspace to fail");
      }
      expect(result.error).toContain("Failed to inspect repository automation drivers");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.deleteWorkspace", () => {
  it("keeps returning declared results and force-deletes when the main checkout is gone", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;
      const branchName = "feature-stale-cleanup";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Simulate a deleted main checkout with a stale managed workspace left
      // behind: repo-aware filter discovery fails closed for it.
      await fsPromises.rm(projectPath, { recursive: true, force: true });

      const preflight = await manager.canDeleteWorkspaceWithoutForce(projectPath, branchName);
      expect(preflight.success).toBe(false);

      const nonForce = await manager.deleteWorkspace(projectPath, branchName, false);
      expect(nonForce.success).toBe(false);

      const forced = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(forced.success).toBe(true);
      const workspaceRemains = await fsPromises.access(workspacePath).then(
        () => true,
        () => false
      );
      expect(workspaceRemains).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("deletes non-agent branches when removing worktrees (force)", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Make the branch unmerged (so -d would fail); force delete should still delete it.
      execSync("bash -lc 'echo \"change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "change"', { cwd: workspacePath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("force-delete fallback does not execute shell payloads embedded in branch names", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });
    const sentinelPath = path.join(
      os.tmpdir(),
      `mux_injection_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
    const branchName = `feature/inject-$(touch\${IFS}${sentinelPath})`;

    let execFileAsyncSpy: { mockRestore: () => void } | null = null;

    try {
      const { projectPath, manager, initLogger } = fixture;

      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      const originalExecFileAsync = disposableExec.execFileAsync;
      execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
        (file, args, options) => {
          if (file === "git" && args[2] === "worktree" && args[3] === "remove") {
            return originalExecFileAsync("git", ["definitely-invalid-command"]);
          }

          return originalExecFileAsync(file, args, options);
        }
      );

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      let workspaceExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        workspaceExists = false;
      }
      expect(workspaceExists).toBe(false);

      let sentinelExists = true;
      try {
        await fsPromises.access(sentinelPath);
      } catch {
        sentinelExists = false;
      }
      expect(sentinelExists).toBe(false);
    } finally {
      execFileAsyncSpy?.mockRestore();
      await fsPromises.rm(sentinelPath, { force: true });
      await fixture.cleanup();
    }
  }, 20_000);

  it("deletes the checked-out branch instead of the workspace directory name", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature-dir-split";
      const directoryName = "review-slot";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      execSync(`git branch ${directoryName}`, { cwd: projectPath, stdio: "ignore" });
      execSync("git checkout -b temp-checkout", {
        cwd: createResult.workspacePath,
        stdio: "ignore",
      });

      const deleteResult = await manager.deleteWorkspace(projectPath, directoryName, true);
      expect(deleteResult.success).toBe(true);

      const featureBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(featureBranchAfter).toBe("");

      const directoryBranchAfter = execSync(`git branch --list "${directoryName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(directoryBranchAfter).toBe(directoryName);

      const tempBranchAfter = execSync('git branch --list "temp-checkout"', {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(tempBranchAfter).toBe("temp-checkout");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("uses the persisted workspace branch when branch lookup is unavailable", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { rootDir, projectPath: mainProjectPath, manager, initLogger } = fixture;
      const linkedProjectPath = path.join(rootDir, "source-worktree");
      execSync(`git worktree add -b source-worktree "${linkedProjectPath}"`, {
        cwd: mainProjectPath,
        stdio: "ignore",
      });

      const branchName = "feature-missing-branch";
      const directoryName = "review-slot-missing";
      const createResult = await manager.createWorkspace({
        projectPath: linkedProjectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }

      execSync(`git branch ${directoryName}`, { cwd: linkedProjectPath, stdio: "ignore" });
      await fsPromises.rm(createResult.workspacePath, { recursive: true, force: true });
      execSync("git worktree prune", { cwd: linkedProjectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(linkedProjectPath, directoryName, true);
      expect(deleteResult.success).toBe(true);

      const featureBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: linkedProjectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(featureBranchAfter).toBe("");

      const directoryBranchAfter = execSync(`git branch --list "${directoryName}"`, {
        cwd: linkedProjectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(directoryBranchAfter).toBe(directoryName);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("falls back to the workspace name when this workspace has no branch map entry", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;
      const workspaceName = "feature-legacy-workspace";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }

      const survivingWorkspace = await manager.createWorkspace({
        projectPath,
        branchName: "feature-mapped-workspace",
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(survivingWorkspace.success).toBe(true);
      const branchMapPath = path.join(projectPath, ".git", "mux-workspace-branches.json");
      const branchMap = JSON.parse(await fsPromises.readFile(branchMapPath, "utf8")) as Record<
        string,
        string
      >;
      delete branchMap[workspaceName];
      await fsPromises.writeFile(branchMapPath, `${JSON.stringify(branchMap, null, 2)}\n`);

      await fsPromises.rm(createResult.workspacePath, { recursive: true, force: true });
      execSync("git worktree prune", { cwd: projectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, workspaceName, true);
      expect(deleteResult.success).toBe(true);

      const branchAfter = execSync(`git branch --list "${workspaceName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(branchAfter).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("deletes merged branches when removing worktrees (safe delete)", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature_merge_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Commit on the workspace branch.
      execSync("bash -lc 'echo \"merged-change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "merged-change"', {
        cwd: workspacePath,
        stdio: "ignore",
      });

      // Merge into main so `git branch -d` succeeds.
      execSync(`git merge "${branchName}"`, { cwd: projectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, false);
      expect(deleteResult.success).toBe(true);

      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("does not delete protected branches", async () => {
    const fixture = await createWorktreeManagerFixture({
      currentBranchName: "other",
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "main";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      // The worktree directory should be removed.
      let worktreeExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        worktreeExists = false;
      }
      expect(worktreeExists).toBe(false);

      // But protected branches (like main) should never be deleted.
      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("main");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
