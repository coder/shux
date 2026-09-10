import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";

interface TestFixture {
  muxRoot: string;
  projectPath: string;
  workspacePath: string;
  workspaceId: string;
  workspaceName: string;
  baseSha: string;
  metadata: WorkspaceMetadata;
  config: Config;
  service: WorktreeArchiveSnapshotService;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Xum Test",
      GIT_AUTHOR_EMAIL: "mux@example.com",
      GIT_COMMITTER_NAME: "Xum Test",
      GIT_COMMITTER_EMAIL: "mux@example.com",
    },
  }).trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function createFixture(): Promise<TestFixture> {
  const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-worktree-archive-snapshot-"));
  const srcBaseDir = path.join(muxRoot, "src");
  const projectPath = path.join(muxRoot, "project");
  const workspaceName = "feature-snapshot";
  const workspacePath = path.join(srcBaseDir, "project", workspaceName);
  const workspaceId = "ws-snapshot";

  await fs.mkdir(projectPath, { recursive: true });
  runGit(projectPath, ["init", "-b", "main"]);
  await fs.writeFile(path.join(projectPath, "tracked.txt"), "base\n", "utf-8");
  runGit(projectPath, ["add", "tracked.txt"]);
  runGit(projectPath, ["commit", "-m", "base"]);
  const baseSha = runGit(projectPath, ["rev-parse", "HEAD"]);

  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  runGit(projectPath, ["worktree", "add", "-b", workspaceName, workspacePath, "main"]);

  const config = new Config(muxRoot);
  await config.editConfig((cfg) => {
    cfg.projects.set(projectPath, {
      trusted: false,
      workspaces: [
        {
          path: workspacePath,
          id: workspaceId,
          name: workspaceName,
          runtimeConfig: { type: "worktree", srcBaseDir },
          taskTrunkBranch: "main",
          taskBaseCommitSha: baseSha,
        },
      ],
    });
    return cfg;
  });

  const metadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceName,
    projectName: "project",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir },
  };

  return {
    muxRoot,
    projectPath,
    workspacePath,
    workspaceId,
    workspaceName,
    baseSha,
    metadata,
    config,
    service: new WorktreeArchiveSnapshotService(config),
  };
}

async function makeWorkspaceDirty(fixture: TestFixture): Promise<void> {
  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);
  runGit(fixture.workspacePath, ["commit", "-m", "commit one"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);
  runGit(fixture.workspacePath, ["commit", "-m", "commit two"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\nstaged change\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\nstaged change\nunstaged change\n",
    "utf-8"
  );
}

async function renameWorkspaceWithoutRenamingBranch(
  fixture: TestFixture,
  newWorkspaceName: string
): Promise<void> {
  const renamedWorkspacePath = path.join(path.dirname(fixture.workspacePath), newWorkspaceName);
  runGit(fixture.projectPath, ["worktree", "move", fixture.workspacePath, renamedWorkspacePath]);

  await fixture.config.editConfig((cfg) => {
    const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
    if (!workspace) {
      throw new Error("Missing workspace entry");
    }
    workspace.path = renamedWorkspacePath;
    workspace.name = newWorkspaceName;
    return cfg;
  });

  fixture.workspacePath = renamedWorkspacePath;
  fixture.metadata.name = newWorkspaceName;
}

async function writeWorkspaceBranchMap(
  projectPath: string,
  branchMap: Record<string, string>
): Promise<void> {
  await fs.writeFile(
    path.join(projectPath, ".git", "mux-workspace-branches.json"),
    `${JSON.stringify(branchMap, null, 2)}\n`,
    "utf-8"
  );
}

describe("WorktreeArchiveSnapshotService", () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fs.rm(fixture.muxRoot, { recursive: true, force: true });
  });

  test("preflightSnapshotForArchive supports legacy path-only workspace entries", async () => {
    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      delete workspace.id;
      delete workspace.name;
      return cfg;
    });
    await fs.mkdir(path.join(fixture.config.sessionsDir, fixture.workspaceName), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(fixture.config.sessionsDir, fixture.workspaceName, "metadata.json"),
      JSON.stringify({ id: fixture.workspaceId }),
      "utf-8"
    );

    const preflightResult = await fixture.service.preflightSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(preflightResult).toEqual({ success: true, data: undefined });
  });

  test("captures a durable snapshot and restores tracked staged + unstaged changes", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    expect(captureResult.data.projects).toHaveLength(1);
    expect(
      await pathExists(
        path.join(
          path.join(fixture.config.sessionsDir, fixture.workspaceId),
          "archive-state",
          "metadata.json"
        )
      )
    ).toBe(true);

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    expect(await pathExists(fixture.workspacePath)).toBe(false);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(fixture.workspacePath)).toBe(true);
    expect(runGit(fixture.workspacePath, ["log", "--format=%s", "-n", "3"])).toContain(
      "commit two"
    );
    expect(runGit(fixture.workspacePath, ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
    expect(runGit(fixture.workspacePath, ["diff", "--name-only"])).toBe("tracked.txt");
    expect(
      runGit(fixture.workspacePath, ["status", "--short"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    ).toEqual(["MM tracked.txt"]);

    const storedWorkspace = fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)
      ?.workspaces[0];
    expect(storedWorkspace?.worktreeArchiveSnapshot).toBeUndefined();
    expect(
      await pathExists(path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state"))
    ).toBe(false);
  });

  test("falls back to base commit + mailbox replay when the archived head commit is gone", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const headSha = captureResult.data.projects[0]?.headSha;
    expect(typeof headSha).toBe("string");

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    runGit(fixture.projectPath, ["branch", "-D", fixture.workspaceName]);
    runGit(fixture.projectPath, ["reflog", "expire", "--expire=now", "--all"]);
    runGit(fixture.projectPath, ["gc", "--prune=now"]);

    expect(() => runGit(fixture.projectPath, ["cat-file", "-e", `${headSha}^{commit}`])).toThrow();

    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const emptyHome = path.join(fixture.muxRoot, "empty-home");
    await fs.mkdir(emptyHome, { recursive: true });
    process.env.HOME = emptyHome;
    process.env.XDG_CONFIG_HOME = path.join(emptyHome, ".config");
    process.env.GIT_CONFIG_GLOBAL = path.join(emptyHome, ".gitconfig");

    let restoreResult: Awaited<ReturnType<typeof fixture.service.restoreSnapshotAfterUnarchive>>;
    try {
      restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
        workspaceId: fixture.workspaceId,
        workspaceMetadata: fixture.metadata,
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      if (originalGitConfigGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
      }
    }

    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(runGit(fixture.workspacePath, ["log", "--format=%s", "-n", "3"])).toContain(
      "commit two"
    );
    expect(runGit(fixture.workspacePath, ["status", "--short"]).includes("MM tracked.txt")).toBe(
      true
    );
  });

  test("falls back to the archived worktree merge-base even when the primary checkout trunk has advanced", async () => {
    await makeWorkspaceDirty(fixture);
    await fs.writeFile(path.join(fixture.projectPath, "main-only.txt"), "main advanced\n", "utf-8");
    runGit(fixture.projectPath, ["add", "main-only.txt"]);
    runGit(fixture.projectPath, ["commit", "-m", "main advanced"]);

    const expectedBaseSha = runGit(fixture.workspacePath, ["merge-base", "main", "HEAD"]);
    const primaryHeadSha = runGit(fixture.projectPath, ["rev-parse", "HEAD"]);
    expect(primaryHeadSha).not.toBe(expectedBaseSha);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    expect(captureResult.data.projects[0]?.baseSha).toBe(expectedBaseSha);
  });

  test("captures the checked-out branch name when a renamed workspace kept its original branch", async () => {
    const originalBranchName = fixture.workspaceName;
    const renamedWorkspaceName = "renamed-workspace";
    await renameWorkspaceWithoutRenamingBranch(fixture, renamedWorkspaceName);
    await writeWorkspaceBranchMap(fixture.projectPath, {
      [renamedWorkspaceName]: originalBranchName,
    });
    await makeWorkspaceDirty(fixture);
    runGit(fixture.projectPath, ["branch", renamedWorkspaceName, fixture.baseSha]);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    expect(captureResult.data.projects[0]?.branchName).toBe(originalBranchName);

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(fixture.workspacePath)).toBe(true);
    expect(runGit(fixture.workspacePath, ["branch", "--show-current"])).toBe(originalBranchName);
  });

  test("prefers the snapshot branch when it already matches despite a stale persisted mapping", async () => {
    await makeWorkspaceDirty(fixture);
    await writeWorkspaceBranchMap(fixture.projectPath, {
      [fixture.workspaceName]: "missing-legacy-branch",
    });

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(fixture.workspacePath)).toBe(true);
    expect(runGit(fixture.workspacePath, ["branch", "--show-current"])).toBe(fixture.workspaceName);
  });

  test("restores legacy snapshots for renamed workspaces via the persisted branch mapping", async () => {
    const originalBranchName = fixture.workspaceName;
    const renamedWorkspaceName = "renamed-workspace";
    await renameWorkspaceWithoutRenamingBranch(fixture, renamedWorkspaceName);
    await writeWorkspaceBranchMap(fixture.projectPath, {
      [renamedWorkspaceName]: originalBranchName,
    });
    await makeWorkspaceDirty(fixture);
    runGit(fixture.projectPath, ["branch", renamedWorkspaceName, fixture.baseSha]);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const legacySnapshot = {
      ...captureResult.data,
      projects: captureResult.data.projects.map((projectSnapshot) => ({
        ...projectSnapshot,
        branchName: renamedWorkspaceName,
      })),
    };

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = legacySnapshot;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(fixture.workspacePath)).toBe(true);
    expect(runGit(fixture.workspacePath, ["branch", "--show-current"])).toBe(originalBranchName);
  });

  test("cleans up partially restored worktrees when patch replay fails", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    const stagedPatchPath = captureResult.data.projects[0]?.stagedPatchPath;
    expect(typeof stagedPatchPath).toBe("string");
    if (!stagedPatchPath) {
      throw new Error("Expected staged patch path");
    }
    await fs.writeFile(
      path.join(fixture.config.sessionsDir, fixture.workspaceId, stagedPatchPath),
      "this is not a valid patch\n",
      "utf-8"
    );

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    expect(await pathExists(fixture.workspacePath)).toBe(false);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult.success).toBe(false);
    expect(await pathExists(fixture.workspacePath)).toBe(false);
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toBeDefined();
  });

  test("skips restore and clears snapshot state when the archived checkout already matches the snapshot", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult).toEqual({ success: true, data: "skipped" });
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toBeUndefined();
    expect(
      await pathExists(path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state"))
    ).toBe(false);
  });

  test("keeps snapshot state when the persisted workspace path already exists", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    await fs.mkdir(fixture.workspacePath, { recursive: true });
    await fs.writeFile(path.join(fixture.workspacePath, "orphan.txt"), "stale checkout\n", "utf-8");

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("Persisted workspace path already exists");
    }
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toEqual(captureResult.data);
  });

  test("keeps snapshot state when a stale checkout exists at the persisted path", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    runGit(fixture.projectPath, [
      "worktree",
      "add",
      "-b",
      "wrong-branch",
      fixture.workspacePath,
      "main",
    ]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("Persisted workspace path already exists");
    }
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toEqual(captureResult.data);
  });

  test("does not skip diff checks when no tracked patch artifacts were captured", async () => {
    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    await fs.writeFile(path.join(fixture.workspacePath, "tracked.txt"), "base\ndrift\n", "utf-8");

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("Persisted workspace path already exists");
    }
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toEqual(captureResult.data);
  });

  test("does not clear snapshot state when only some tracked patch artifacts remain and the checkout still differs", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const stagedPatchPath = captureResult.data.projects[0]?.stagedPatchPath;
    expect(typeof stagedPatchPath).toBe("string");
    if (!stagedPatchPath) {
      throw new Error("Expected staged patch path");
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    await fs.rm(path.join(fixture.config.sessionsDir, fixture.workspaceId, stagedPatchPath), {
      force: true,
    });
    await fs.writeFile(
      path.join(fixture.workspacePath, "tracked.txt"),
      "base\ncommit one\ncommit two\nstaged change\nunstaged change\nextra drift\n",
      "utf-8"
    );

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("Persisted workspace path already exists");
    }
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toEqual(captureResult.data);
  });

  test("does not treat unreadable tracked patch artifacts as missing during retry checks", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const stagedPatchPath = captureResult.data.projects[0]?.stagedPatchPath;
    expect(typeof stagedPatchPath).toBe("string");
    if (!stagedPatchPath) {
      throw new Error("Expected staged patch path");
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = spyOn(fs, "readFile").mockImplementation(((
      ...args: Parameters<typeof fs.readFile>
    ): ReturnType<typeof fs.readFile> => {
      const [targetPath] = args;
      if (typeof targetPath === "string" && targetPath.endsWith(stagedPatchPath)) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        return Promise.reject(error);
      }
      return originalReadFile(...args);
    }) as typeof fs.readFile);

    try {
      const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
        workspaceId: fixture.workspaceId,
        workspaceMetadata: fixture.metadata,
      });

      expect(restoreResult.success).toBe(false);
      if (!restoreResult.success) {
        expect(restoreResult.error).toContain("permission denied");
      }
      expect(
        fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
          ?.worktreeArchiveSnapshot
      ).toEqual(captureResult.data);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("fails restore when committed history is unavailable and the mailbox artifact is missing", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const projectSnapshot = captureResult.data.projects[0];
    if (!projectSnapshot?.committedPatchPath) {
      throw new Error("Expected committed patch path");
    }

    const snapshotWithoutMailbox = {
      ...captureResult.data,
      projects: captureResult.data.projects.map((snapshotProject) => ({
        ...snapshotProject,
        committedPatchPath: undefined,
      })),
    };

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = snapshotWithoutMailbox;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    runGit(fixture.projectPath, ["branch", "-D", fixture.workspaceName]);
    runGit(fixture.projectPath, ["reflog", "expire", "--expire=now", "--all"]);
    runGit(fixture.projectPath, ["gc", "--prune=now"]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("archived committed history is unavailable");
    }
    expect(await pathExists(fixture.workspacePath)).toBe(false);
  });

  test("fails restore when tracked patch artifacts are unavailable", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const stagedPatchPath = captureResult.data.projects[0]?.stagedPatchPath;
    if (!stagedPatchPath) {
      throw new Error("Expected staged patch path");
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    await fs.rm(path.join(fixture.config.sessionsDir, fixture.workspaceId, stagedPatchPath), {
      force: true,
    });
    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult.success).toBe(false);
    if (!restoreResult.success) {
      expect(restoreResult.error).toContain("staged patch artifact is unavailable");
    }
    expect(await pathExists(fixture.workspacePath)).toBe(false);
  });

  test("preserves snapshot metadata when artifact cleanup fails after a successful restore", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const originalRm = fs.rm.bind(fs);
    const rmSpy = spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (
        typeof targetPath === "string" &&
        targetPath.endsWith(
          path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state")
        )
      ) {
        throw new Error("snapshot cleanup failed");
      }
      return originalRm(targetPath, options);
    });

    try {
      const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
        workspaceId: fixture.workspaceId,
        workspaceMetadata: fixture.metadata,
      });
      expect(restoreResult).toEqual({ success: true, data: "restored" });
      expect(
        fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
          ?.worktreeArchiveSnapshot
      ).toEqual(captureResult.data);
      expect(
        await pathExists(
          path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state")
        )
      ).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  test("recognizes a restored legacy checkout on retry after snapshot-state writeback fails", async () => {
    const originalBranchName = fixture.workspaceName;
    const renamedWorkspaceName = "renamed-workspace";
    await renameWorkspaceWithoutRenamingBranch(fixture, renamedWorkspaceName);
    await writeWorkspaceBranchMap(fixture.projectPath, {
      [renamedWorkspaceName]: originalBranchName,
    });
    await makeWorkspaceDirty(fixture);
    runGit(fixture.projectPath, ["branch", renamedWorkspaceName, fixture.baseSha]);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const legacySnapshot = {
      ...captureResult.data,
      projects: captureResult.data.projects.map((projectSnapshot) => ({
        ...projectSnapshot,
        branchName: renamedWorkspaceName,
      })),
    };

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = legacySnapshot;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const originalEditConfig = fixture.config.editConfig.bind(fixture.config);
    const editConfigSpy = spyOn(fixture.config, "editConfig").mockImplementation((_mutate) =>
      Promise.reject(new Error("config writeback failed"))
    );

    try {
      const firstRestoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
        workspaceId: fixture.workspaceId,
        workspaceMetadata: fixture.metadata,
      });
      expect(firstRestoreResult).toEqual({ success: true, data: "restored" });
      expect(await pathExists(fixture.workspacePath)).toBe(true);
    } finally {
      editConfigSpy.mockRestore();
      fixture.config.editConfig = originalEditConfig;
    }

    const secondRestoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(secondRestoreResult).toEqual({ success: true, data: "skipped" });
    expect(
      fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
        ?.worktreeArchiveSnapshot
    ).toBeUndefined();
  });

  test("keeps the restored worktree when snapshot-state writeback fails", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const originalEditConfig = fixture.config.editConfig.bind(fixture.config);
    const editConfigSpy = spyOn(fixture.config, "editConfig").mockImplementation((_mutate) =>
      Promise.reject(new Error("config writeback failed"))
    );

    try {
      const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
        workspaceId: fixture.workspaceId,
        workspaceMetadata: fixture.metadata,
      });
      expect(restoreResult).toEqual({ success: true, data: "restored" });
      expect(await pathExists(fixture.workspacePath)).toBe(true);
      expect(
        fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)?.workspaces[0]
          ?.worktreeArchiveSnapshot
      ).toEqual(captureResult.data);
      expect(
        await pathExists(
          path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state")
        )
      ).toBe(false);
    } finally {
      editConfigSpy.mockRestore();
      fixture.config.editConfig = originalEditConfig;
    }
  });

  test("refuses snapshot cleanup paths that resolve to the session root", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const rootScopedSnapshot = {
      ...captureResult.data,
      stateDirPath: ".",
    };

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = rootScopedSnapshot;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(path.join(fixture.config.sessionsDir, fixture.workspaceId))).toBe(true);
  });

  test("rejects archive snapshots when untracked files are present", async () => {
    await fs.writeFile(path.join(fixture.workspacePath, "untracked.txt"), "hello\n", "utf-8");

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(captureResult).toEqual(
      Err({ kind: "confirm-lossy-untracked-files", paths: ["untracked.txt"] })
    );
    expect(
      await pathExists(path.join(fixture.config.sessionsDir, fixture.workspaceId, "archive-state"))
    ).toBe(false);
  });

  test("getUnsupportedUntrackedPaths returns empty array for clean workspace", async () => {
    const result = await fixture.service.getUnsupportedUntrackedPaths({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });

  test("getUnsupportedUntrackedPaths returns sorted untracked paths", async () => {
    await fs.writeFile(path.join(fixture.workspacePath, "z-file.txt"), "z\n", "utf-8");
    await fs.writeFile(path.join(fixture.workspacePath, "a-file.txt"), "a\n", "utf-8");
    await fs.mkdir(path.join(fixture.workspacePath, "cache-dir"));
    await fs.writeFile(path.join(fixture.workspacePath, "cache-dir", "tmp"), "t\n", "utf-8");

    const result = await fixture.service.getUnsupportedUntrackedPaths({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["a-file.txt", "cache-dir/", "z-file.txt"]);
    }
  });

  test("captureSnapshotForArchive succeeds with matching acknowledgedUntrackedPaths", async () => {
    // Make workspace dirty (tracked changes) so snapshot captures something meaningful.
    await makeWorkspaceDirty(fixture);

    // Add untracked files that would normally block capture.
    await fs.writeFile(path.join(fixture.workspacePath, "untracked.txt"), "hello\n", "utf-8");

    // Without acknowledgement, capture should fail.
    const failResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(failResult.success).toBe(false);

    // Clean up the failed attempt's state dir (if any).
    const sessionDir = path.join(fixture.config.sessionsDir, fixture.workspaceId);
    await fs.rm(path.join(sessionDir, "archive-state"), { recursive: true, force: true });

    // With matching acknowledged paths, capture should succeed.
    const okResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
      acknowledgedUntrackedPaths: ["untracked.txt"],
    });
    expect(okResult.success).toBe(true);
    if (okResult.success) {
      expect(okResult.data.version).toBe(1);
      expect(okResult.data.projects.length).toBeGreaterThan(0);
    }
  });

  test("captureSnapshotForArchive fails when new untracked files appear after acknowledgement", async () => {
    // Make workspace dirty (tracked changes).
    await makeWorkspaceDirty(fixture);

    // Add untracked files.
    await fs.writeFile(path.join(fixture.workspacePath, "old-file.txt"), "old\n", "utf-8");
    await fs.writeFile(path.join(fixture.workspacePath, "new-file.txt"), "new\n", "utf-8");

    // User only acknowledged "old-file.txt" — "new-file.txt" appeared after the dialog.
    const result = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
      acknowledgedUntrackedPaths: ["old-file.txt"],
    });

    expect(result).toEqual(
      Err({
        kind: "confirm-lossy-untracked-files",
        paths: ["new-file.txt", "old-file.txt"],
      })
    );

    const sessionDirEntries = await fs.readdir(
      path.join(fixture.config.sessionsDir, fixture.workspaceId)
    );
    expect(sessionDirEntries.filter((entry) => entry.startsWith("archive-state.tmp-")).length).toBe(
      0
    );
  });
});
