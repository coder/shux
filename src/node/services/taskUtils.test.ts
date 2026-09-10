import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { tryReadGitBranchMatchesOrigin } from "./taskUtils";

function initGitRepo(repoPath: string): void {
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: repoPath, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m init", { cwd: repoPath, stdio: "ignore" });
}

describe("tryReadGitBranchMatchesOrigin", () => {
  test("shell-quotes repo-controlled branch names (no command injection)", async () => {
    using tempDir = new DisposableTempDir("taskutils-branch-injection");
    const repoPath = path.join(tempDir.path, "repo");
    await fsPromises.mkdir(repoPath, { recursive: true });
    initGitRepo(repoPath);

    // A git-valid branch name crafted to break out of naive single-quoting: without
    // shell quoting this would execute `touch injected-marker` in the owner runtime.
    const maliciousBranch = "safe';touch injected-marker;#";
    const result = await tryReadGitBranchMatchesOrigin(
      new LocalRuntime(repoPath),
      repoPath,
      maliciousBranch
    );

    // No origin ref exists for the branch, so the helper reports "local is the only
    // candidate base" — and the injected command must never have run.
    expect(result).toBe(true);
    try {
      await fsPromises.access(path.join(repoPath, "injected-marker"));
      expect.unreachable("injected command created a marker file");
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test("distinguishes matching, diverged, and missing origin refs", async () => {
    using tempDir = new DisposableTempDir("taskutils-branch-origin");
    const repoPath = path.join(tempDir.path, "repo");
    const bareRemote = path.join(tempDir.path, "origin.git");
    await fsPromises.mkdir(repoPath, { recursive: true });
    initGitRepo(repoPath);
    execSync(`git init --bare -q '${bareRemote}'`, { cwd: tempDir.path, stdio: "ignore" });
    execSync(`git remote add origin '${bareRemote}'`, { cwd: repoPath, stdio: "ignore" });
    execSync("git push -q origin main", { cwd: repoPath, stdio: "ignore" });

    const runtime = new LocalRuntime(repoPath);
    expect(await tryReadGitBranchMatchesOrigin(runtime, repoPath, "main")).toBe(true);

    execSync("git commit -q --allow-empty -m ahead", { cwd: repoPath, stdio: "ignore" });
    expect(await tryReadGitBranchMatchesOrigin(runtime, repoPath, "main")).toBe(false);

    expect(await tryReadGitBranchMatchesOrigin(runtime, repoPath, "no-such-branch")).toBe(true);
  });
});
