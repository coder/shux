// Fixture-driven tests for scripts/gate_fingerprint.sh: each test spawns the
// real script against a throwaway git repo and asserts the memoization
// contract (check hits only while the worktree fingerprint is unchanged).
//
// Not part of the `bun test src` CI lane (like other scripts/ tooling tests);
// run explicitly: bun test ./scripts/gate_fingerprint.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "gate_fingerprint.sh");

// Hermetic git environment: host GIT_* vars and global config (hooks, commit
// trailers, diff drivers) must not leak into fixture repos or fingerprints.
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_")) {
      continue;
    }
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_AUTHOR_NAME = "Gate Test";
  env.GIT_AUTHOR_EMAIL = "gate-test@example.com";
  env.GIT_COMMITTER_NAME = "Gate Test";
  env.GIT_COMMITTER_EMAIL = "gate-test@example.com";
  return env;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(cwd: string, cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await run(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`);
  }
}

async function gate(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(cwd, ["bash", SCRIPT, ...args]);
}

async function fingerprint(cwd: string): Promise<string> {
  const result = await gate(cwd, "fingerprint");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^[0-9a-f]{64}$/);
  return result.stdout;
}

// The documented workflow: capture the fingerprint BEFORE the gate runs,
// then bind the record to it (record refuses when the tree changed mid-run).
async function record(cwd: string, gateName: string, result: "pass" | "fail"): Promise<RunResult> {
  const fp = await fingerprint(cwd);
  return gate(cwd, "record", gateName, result, fp);
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "gate-fingerprint-test-"));
  await git(repo, "init", "-q");
  await writeFile(path.join(repo, "tracked.txt"), "hello\n");
  await git(repo, "add", "tracked.txt");
  await git(repo, "commit", "-q", "-m", "initial");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("fingerprint is stable across runs and unperturbed by record", async () => {
  const before = await fingerprint(repo);
  expect(await fingerprint(repo)).toBe(before);

  const recorded = await record(repo, "static-check", "pass");
  expect(recorded.exitCode).toBe(0);
  // The store lives inside the git dir, so recording must not change the
  // fingerprint (a self-invalidating cache would never hit).
  expect(await fingerprint(repo)).toBe(before);
  // ...and the repo stays clean from git's perspective.
  const status = await run(repo, ["git", "status", "--porcelain"]);
  expect(status.stdout).toBe("");
});

test("check hits with unchanged tree; pass and fail both round-trip", async () => {
  // No record yet: miss.
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  expect((await record(repo, "static-check", "pass")).exitCode).toBe(0);
  expect((await record(repo, "unit-tests", "fail")).exitCode).toBe(0);

  const pass = await gate(repo, "check", "static-check");
  expect(pass.exitCode).toBe(0);
  expect(pass.stdout).toBe("pass");

  const fail = await gate(repo, "check", "unit-tests");
  expect(fail.exitCode).toBe(0);
  expect(fail.stdout).toBe("fail");

  // A gate that was never recorded stays a miss even with a populated store.
  expect((await gate(repo, "check", "other-gate")).exitCode).toBe(1);
});

test("check misses after editing a tracked file", async () => {
  await record(repo, "static-check", "pass");
  await appendFile(path.join(repo, "tracked.txt"), "edited\n");

  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  // Re-recording against the changed tree makes check hit again.
  expect((await record(repo, "static-check", "fail")).exitCode).toBe(0);
  const rechecked = await gate(repo, "check", "static-check");
  expect(rechecked.exitCode).toBe(0);
  expect(rechecked.stdout).toBe("fail");
});

test("check misses when an untracked file appears or changes", async () => {
  await record(repo, "static-check", "pass");
  await writeFile(path.join(repo, "scratch.txt"), "one\n");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  // Content changes of an existing untracked file must also invalidate.
  await record(repo, "static-check", "pass");
  await writeFile(path.join(repo, "scratch.txt"), "two\n");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  // Fingerprint is content-based: deleting the file restores the original
  // fingerprint, so the very first record becomes fresh again.
  await rm(path.join(repo, "scratch.txt"));
  await record(repo, "static-check", "pass");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(0);
});

test("check misses after staging a change", async () => {
  await record(repo, "static-check", "pass");

  // Stage a brand-new file: it leaves the untracked list and must be caught
  // via the tracked diff instead.
  await writeFile(path.join(repo, "staged.txt"), "staged\n");
  await git(repo, "add", "staged.txt");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);
});

test("check misses when an untracked file's executable bit or symlink target changes", async () => {
  // Executable bit: builds/tests can execute the file differently, so a
  // chmod alone must invalidate the recorded gate.
  const scriptPath = path.join(repo, "run.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho hi\n");
  await record(repo, "static-check", "pass");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(0);
  await chmod(scriptPath, 0o755);
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  // Symlink identity: retargeting a link without touching contents must
  // invalidate too (the manifest hashes the target string, not the referent).
  const linkPath = path.join(repo, "link");
  await symlink("tracked.txt", linkPath);
  await record(repo, "static-check", "pass");
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(0);
  await unlink(linkPath);
  await symlink("run.sh", linkPath);
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);
});

test("newline-bearing filenames cannot forge another worktree's manifest", async () => {
  // Pre-fix, records were newline-terminated with the raw path as the last
  // field, so ONE file named `a\n<hash> - b` (same contents as `a`) emitted
  // the exact manifest bytes of TWO files `a` and `b` — letting a cached
  // passing gate be reused for a different worktree. NUL terminators make
  // the encoding injective (paths cannot contain NUL).
  const contents = "same contents";
  const contentsHash = new Bun.CryptoHasher("sha256").update(contents).digest("hex");

  await writeFile(path.join(repo, "a"), contents);
  await writeFile(path.join(repo, "b"), contents);
  const twoFiles = await fingerprint(repo);

  await rm(path.join(repo, "a"));
  await rm(path.join(repo, "b"));
  // Legal Linux filename: embedded newline + spaces forging b's record.
  await writeFile(path.join(repo, `a\n${contentsHash} - b`), contents);
  const forged = await fingerprint(repo);

  expect(forged).not.toBe(twoFiles);
});

test("record is refused when the worktree changed after the fingerprint was captured", async () => {
  // Simulates a mid-gate worktree change: fingerprint captured, then another
  // process edits a file before record runs. The stale outcome must not be
  // bound to the new tree, or check would skip validating untested changes.
  const before = await fingerprint(repo);
  await appendFile(path.join(repo, "tracked.txt"), "changed while gate ran\n");

  const rejected = await gate(repo, "record", "static-check", "pass", before);
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr).toContain("worktree changed while the gate ran");
  // Nothing was recorded: check still misses on the current tree.
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);

  // A malformed fingerprint argument is rejected up front.
  const malformed = await gate(repo, "record", "static-check", "pass", "not-a-sha");
  expect(malformed.exitCode).toBe(1);
  expect(malformed.stderr).toContain("sha256");
});

test("corrupt store self-heals instead of failing the caller", async () => {
  const storePath = await run(repo, [
    "git",
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "gate_fingerprints.json",
  ]);
  expect(storePath.exitCode).toBe(0);
  await writeFile(storePath.stdout, "not json {{{");

  // check treats a corrupt store as a miss; record rewrites it cleanly.
  expect((await gate(repo, "check", "static-check")).exitCode).toBe(1);
  expect((await record(repo, "static-check", "pass")).exitCode).toBe(0);
  const rechecked = await gate(repo, "check", "static-check");
  expect(rechecked.exitCode).toBe(0);
  expect(rechecked.stdout).toBe("pass");
});
