import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

import { WorktreeRuntime } from "./WorktreeRuntime";

describe("WorktreeRuntime workspacePath override", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-worktree-rt-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns the persisted path for its own workspace and the derived path otherwise", () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");
    const sharedPath = path.join(rootDir, "parent-checkout");

    // A shared (isolation: "none") task: unique child name, but path points at the parent checkout.
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "agent_explore_child",
      workspacePath: sharedPath,
    });

    // Its own identity resolves to the persisted shared path...
    expect(runtime.getWorkspacePath(projectPath, "agent_explore_child")).toBe(sharedPath);
    // ...while other workspaces still use the name-derived worktree path.
    const derivedSibling = runtime.getWorkspacePath(projectPath, "sibling");
    expect(derivedSibling).not.toBe(sharedPath);
    expect(derivedSibling).toContain("sibling");
  });

  it("reports ready when the shared checkout is a git repo even though the derived path is absent", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");
    const sharedPath = path.join(rootDir, "parent-checkout");
    await fs.mkdir(sharedPath, { recursive: true });
    execSync("git init -b main", { cwd: sharedPath, stdio: "ignore" });

    // Name-derived path (<srcBaseDir>/<project>/agent_explore_child) was never created.
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "agent_explore_child",
      workspacePath: sharedPath,
    });

    const ready = await runtime.ensureReady();
    expect(ready.ready).toBe(true);
  });

  it("executes the init hook from the persisted workspace checkout", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");
    const workspacePath = path.join(rootDir, "branch-checkout");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".xum", "init"), "#!/bin/sh\necho primary\n", {
      mode: 0o755,
    });
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".mux", "init"), "#!/bin/sh\necho target\n", {
      mode: 0o755,
    });

    const stdout: string[] = [];
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "feature",
      workspacePath,
    });
    const result = await runtime.initWorkspace({
      projectPath,
      workspacePath,
      branchName: "feature",
      trunkBranch: "main",
      trusted: true,
      initLogger: {
        logStep: () => undefined,
        logStdout: (line) => stdout.push(line),
        logStderr: () => undefined,
        logComplete: () => undefined,
      },
    });

    expect(result).toEqual({ success: true });
    expect(stdout).toEqual(["target"]);
  });

  it("reports not-ready without an override when the derived path does not exist", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");

    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "missing-workspace",
    });

    const ready = await runtime.ensureReady();
    expect(ready.ready).toBe(false);
  });

  it("forks from the persisted shared checkout, not the name-derived path", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");

    await fs.mkdir(projectPath, { recursive: true });
    execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
    // CI runners have no global git identity/signing config.
    execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
    execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
    execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", { cwd: projectPath, stdio: "ignore" });

    const nullLogger = {
      logStep: () => undefined,
      logStdout: () => undefined,
      logStderr: () => undefined,
      logComplete: () => undefined,
    };

    // Materialize a real parent worktree (branch "parent"), the checkout a shared task reuses.
    const parentRuntime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "parent",
    });
    const created = await parentRuntime.createWorkspace({
      projectPath,
      branchName: "parent",
      trunkBranch: "main",
      directoryName: "parent",
      initLogger: nullLogger,
    });
    expect(created.success).toBe(true);
    const parentPath = parentRuntime.getWorkspacePath(projectPath, "parent");

    // Shared (isolation: "none") task identity: synthetic name, persisted path = parent checkout.
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "agent_explore_child",
      workspacePath: parentPath,
    });

    // The name-derived path for agent_explore_child was never created; the fork source must be
    // resolved through the override to the parent checkout (branch "parent").
    const result = await runtime.forkWorkspace({
      projectPath,
      sourceWorkspaceName: "agent_explore_child",
      newWorkspaceName: "forked-from-shared",
      initLogger: nullLogger,
    });

    expect(result.success).toBe(true);
  });
});
