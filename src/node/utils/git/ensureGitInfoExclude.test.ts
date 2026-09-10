import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { STAGED_ATTACHMENT_DIR } from "@/common/constants/stagedAttachments";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import { ensureGitInfoExclude } from "./ensureGitInfoExclude";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("ensureGitInfoExclude", () => {
  test("adds the staged attachment directory to a git repo exclude file once", async () => {
    const repo = await makeTempDir("mux-git-exclude-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const first = await ensureGitInfoExclude({
      runtime,
      workspacePath: repo,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    const second = await ensureGitInfoExclude({
      runtime,
      workspacePath: repo,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });

    expect(first.status).toBe("ensured");
    expect(second.status).toBe("ensured");
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const exclude = await readFile(path.join(repo, excludePath), "utf8");
    expect(exclude.match(/^\/\.xum\/user-attachments\/$/gm)).toHaveLength(1);
  });

  test("uses a git-root-relative pattern for subdirectory workspaces", async () => {
    const repo = await makeTempDir("mux-git-exclude-subdir-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const workspacePath = path.join(repo, "packages", "app");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, ".keep"), "");
    const runtime = new LocalRuntime(repo);

    const result = await ensureGitInfoExclude({
      runtime,
      workspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });

    expect(result.status).toBe("ensured");
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const exclude = await readFile(path.join(repo, excludePath), "utf8");
    expect(exclude).toContain("/packages/app/.xum/user-attachments/");
  });

  test("reports non-git directories without writing an exclude file", async () => {
    const dir = await makeTempDir("mux-git-exclude-nongit-");
    const runtime = new LocalRuntime(dir);

    const result = await ensureGitInfoExclude({
      runtime,
      workspacePath: dir,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    expect(result).toEqual({ status: "notGit" });
  });
});
