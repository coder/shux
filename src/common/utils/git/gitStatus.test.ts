import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";

import { generateGitStatusScript } from "./gitStatus";

describe("generateGitStatusScript", () => {
  test("single-quotes preferred branch to prevent shell interpolation", () => {
    const script = generateGitStatusScript("origin/$(touch /tmp/pwned)\"'branch");

    expect(script).toContain("PREFERRED_BRANCH='$(touch /tmp/pwned)\"'\\''branch'");
    expect(script).not.toContain('PREFERRED_BRANCH="$(touch /tmp/pwned)');
  });

  test("uses the local primary ref for divergent local-only branches", async () => {
    using tmp = new DisposableTempDir("git-status-local-divergence");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init -b main`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8");
    await Bun.$`git add base.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m base`.cwd(repo).quiet();
    await Bun.$`git checkout -b feature`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "feature.txt"), "feature\n", "utf-8");
    await Bun.$`git add feature.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m feature`.cwd(repo).quiet();
    await Bun.$`git checkout main`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "main.txt"), "main\n", "utf-8");
    await Bun.$`git add main.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m main`.cwd(repo).quiet();
    await Bun.$`git checkout feature`.cwd(repo).quiet();

    const result = await Bun.$`bash -c ${generateGitStatusScript()}`.cwd(repo).quiet();
    expect(result.stdout.toString()).toContain("---AHEAD_BEHIND---\n1\t1");
  });
});
