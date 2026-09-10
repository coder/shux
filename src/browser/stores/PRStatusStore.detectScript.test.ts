import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DETECT_PR_SCRIPT } from "./PRStatusStore";

const LOCAL_BRANCH = "local-branch";
const FIELDS =
  "number,url,state,mergeable,mergeStateStatus,title,isDraft,headRefName,baseRefName,statusCheckRollup";
const GH_SHIM = [
  "#!/usr/bin/env bash",
  `printf '%s\n' "$*" >> "$GH_LOG"`,
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
  '  if [ "$3" = "--json" ]; then',
  `    if [ -n "$GH_ARGLESS_JSON" ]; then printf '%s\n' "$GH_ARGLESS_JSON"; exit 0; fi`,
  "    exit 1",
  "  fi",
  '  if [ "$3" = "$GH_VIEW_SELECTOR" ] && [ -n "$GH_VIEW_JSON" ]; then',
  `    printf '%s\n' "$GH_VIEW_JSON"`,
  "    exit 0",
  "  fi",
  "  exit 1",
  "fi",
  'if [ "$1" = "api" ]; then',
  '  if [ "$GH_API_EXIT" = "1" ]; then exit 1; fi',
  "  printf '%s\n' \"${GH_API_NUM-}\"",
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe("DETECT_PR_SCRIPT", () => {
  let tempDir: string;
  let repoDir: string;
  let fakeBin: string;
  let logPath: string;
  let headSha: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xum-detect-pr-"));
    repoDir = join(tempDir, "repo");
    fakeBin = join(tempDir, "bin");
    logPath = join(tempDir, "gh.log");

    run(["mkdir", "-p", repoDir, fakeBin], tempDir);
    run(["git", "init", "-b", LOCAL_BRANCH], repoDir);
    run(["git", "config", "user.email", "test@example.com"], repoDir);
    run(["git", "config", "user.name", "Test User"], repoDir);
    run(["git", "commit", "--allow-empty", "-m", "initial"], repoDir);
    headSha = run(["git", "rev-parse", "HEAD"], repoDir);

    await writeFile(join(fakeBin, "gh"), GH_SHIM);
    await chmod(join(fakeBin, "gh"), 0o755);
    await writeFile(logPath, "");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function detect(env: Record<string, string> = {}) {
    const result = Bun.spawnSync(["bash", "-c", DETECT_PR_SCRIPT], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        GH_LOG: logPath,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
    };
  }

  async function invocations(): Promise<string[]> {
    const contents = (await readFile(logPath, "utf8")).trim();
    return contents ? contents.split("\n") : [];
  }

  it("returns the argument-less branch match without fallbacks", async () => {
    const json = '{"number":1,"url":"https://github.com/coder/xum/pull/1"}';

    const result = detect({ GH_ARGLESS_JSON: json });

    expect(result).toEqual({ exitCode: 0, stdout: `${json}\n` });
    expect(await invocations()).toEqual([`pr view --json ${FIELDS}`]);
  });

  it("falls back to a differently named tracked merge ref", async () => {
    const json = '{"number":2,"url":"https://github.com/coder/xum/pull/2"}';
    run(["git", "config", `branch.${LOCAL_BRANCH}.merge`, "refs/heads/mike/other"], repoDir);

    const result = detect({ GH_VIEW_SELECTOR: "mike/other", GH_VIEW_JSON: json });

    expect(result).toEqual({ exitCode: 0, stdout: `${json}\n` });
    expect(await invocations()).toEqual([
      `pr view --json ${FIELDS}`,
      `pr view mike/other --json ${FIELDS}`,
    ]);
  });

  it("skips a tracked merge ref equal to the local branch", async () => {
    const json = '{"number":3,"url":"https://github.com/coder/xum/pull/3"}';
    run(["git", "config", `branch.${LOCAL_BRANCH}.merge`, `refs/heads/${LOCAL_BRANCH}`], repoDir);

    const result = detect({ GH_API_NUM: "3", GH_VIEW_SELECTOR: "3", GH_VIEW_JSON: json });

    expect(result).toEqual({ exitCode: 0, stdout: `${json}\n` });
    expect(await invocations()).toEqual([
      `pr view --json ${FIELDS}`,
      `api repos/{owner}/{repo}/commits/${headSha}/pulls --jq [.[] | select(.state == "open")][0].number`,
      `pr view 3 --json ${FIELDS}`,
    ]);
  });

  it("falls back from an untracked branch to an open PR containing HEAD", async () => {
    const json = '{"number":123,"url":"https://github.com/coder/xum/pull/123"}';

    const result = detect({ GH_API_NUM: "123", GH_VIEW_SELECTOR: "123", GH_VIEW_JSON: json });

    expect(result).toEqual({ exitCode: 0, stdout: `${json}\n` });
    expect(await invocations()).toEqual([
      `pr view --json ${FIELDS}`,
      `api repos/{owner}/{repo}/commits/${headSha}/pulls --jq [.[] | select(.state == "open")][0].number`,
      `pr view 123 --json ${FIELDS}`,
    ]);
  });

  it.each(["null", ""])("returns no PR when the commit lookup yields %p", async (apiNum) => {
    const result = detect({ GH_API_NUM: apiNum });

    expect(result).toEqual({ exitCode: 0, stdout: '{"no_pr":true}\n' });
    expect(await invocations()).toEqual([
      `pr view --json ${FIELDS}`,
      `api repos/{owner}/{repo}/commits/${headSha}/pulls --jq [.[] | select(.state == "open")][0].number`,
    ]);
  });

  it("returns no PR with exit code zero when every lookup fails", async () => {
    const result = detect({ GH_API_EXIT: "1" });

    expect(result).toEqual({ exitCode: 0, stdout: '{"no_pr":true}\n' });
    expect(await invocations()).toEqual([
      `pr view --json ${FIELDS}`,
      `api repos/{owner}/{repo}/commits/${headSha}/pulls --jq [.[] | select(.state == "open")][0].number`,
    ]);
  });
});
