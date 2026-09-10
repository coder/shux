import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Config } from "@/node/config";
import { materializeResolvedTrust, replaceRunTrustProjects, resolveProjectDir } from "./trust";

const BUN_EXECUTABLE = process.execPath;
const TRUST_ENTRY = path.join(import.meta.dir, "trust.ts");
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");

describe("xum trust CLI", () => {
  test("normalizes implicit cwd to git root but preserves explicit --dir", async () => {
    using tmp = new DisposableTempDir("trust-cli-dir");
    const repo = path.join(tmp.path, "repo");
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();

    expect(await resolveProjectDir({ cwd: nested })).toBe(repo);
    expect(await resolveProjectDir({ cwd: tmp.path, explicitDir: nested })).toBe(nested);
  });

  test("grants and revokes project trust headlessly", async () => {
    using tmp = new DisposableTempDir("trust-cli-cycle");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    const env = { ...process.env, MUX_ROOT: muxRoot };

    // Grant trust for a project that was never added to mux (no desktop/server
    // involved). Route through index.ts to cover top-level subcommand dispatch;
    // no experiment flag is required for trust.
    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} trust --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });

    const revokeResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(revokeResult.exitCode).toBe(0);
    expect(JSON.parse(revokeResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: false,
    });
  }, 15_000);

  test("revoke from a worktree also clears a direct trust entry for the worktree path", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree-revoke");
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const muxRoot = path.join(base, "mux-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    // Older/manual configs (or a worktree added as its own project) can hold a
    // direct trusted entry for the worktree path alongside the main repo entry.
    // Revoke must clear both; the direct entry alone would keep the checkout
    // trusted via resolveProjectTrusted's exact-path lookup.
    await fs.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [repo, { workspaces: [], trusted: true }],
          [worktree, { workspaces: [], trusted: true }],
        ],
      }),
      "utf-8"
    );
    const env = { ...process.env, MUX_ROOT: muxRoot };

    const revokeResult =
      await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${worktree} --json`
        .env(env)
        .quiet();
    expect(revokeResult.exitCode).toBe(0);

    const config = JSON.parse(await fs.readFile(path.join(muxRoot, "config.json"), "utf-8")) as {
      projects: Array<[string, { trusted?: boolean }]>;
    };
    const trustByPath = new Map(config.projects.map(([p, c]) => [p, c.trusted]));
    expect(trustByPath.get(repo)).toBe(false);
    expect(trustByPath.get(worktree)).toBe(false);
  }, 15_000);

  test("replaceRunTrustProjects rebuilds config without foreign settings", async () => {
    using tmp = new DisposableTempDir("trust-replace-run");
    const realConfig = new Config(path.join(tmp.path, "real-root"));
    const targetConfig = new Config(path.join(tmp.path, "run-root"));
    const intendedProject = path.join(tmp.path, "intended-project");
    const staleProject = path.join(tmp.path, "removed-project");
    await realConfig.editConfig((config) => {
      config.projects.set(intendedProject, { workspaces: [], trusted: true });
      return config;
    });
    await targetConfig.editConfig((config) => {
      config.projects.set(staleProject, { workspaces: [], trusted: true });
      config.routeOverrides = { "anthropic:claude-opus-5": "direct" };
      return config;
    });

    await replaceRunTrustProjects(realConfig, targetConfig);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(targetConfig.rootDir, "config.json"), "utf8")
    ) as {
      projects: Array<[string, { workspaces: unknown[]; trusted?: boolean }]>;
      routeOverrides?: Record<string, string>;
    };
    expect(onDisk.projects).toEqual([[intendedProject, { workspaces: [], trusted: true }]]);
    expect(onDisk.routeOverrides).toBeUndefined();
    const reloaded = targetConfig.loadConfigOrDefault();
    expect(reloaded.projects.has(staleProject)).toBe(false);
    expect(reloaded.projects.get(intendedProject)?.trusted).toBe(true);
    expect(reloaded.routeOverrides).toBeUndefined();
  });

  test("materializeResolvedTrust copies main-repo trust onto the exact worktree entry", async () => {
    using tmp = new DisposableTempDir("trust-materialize");
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    const realConfig = new Config(path.join(base, "real-root"));
    await realConfig.editConfig((cfg) => {
      cfg.projects.set(repo, { workspaces: [], trusted: true });
      return cfg;
    });
    const targetConfig = new Config(path.join(base, "ephemeral-root"));

    // Main-repo trust must land on the worktree's own entry in the target config
    // (the task-spawn gate does an exact-path lookup there).
    expect(await materializeResolvedTrust(realConfig, targetConfig, worktree)).toBe(true);
    expect(targetConfig.loadConfigOrDefault().projects.get(worktree)?.trusted).toBe(true);

    // Untrusted paths must not gain entries.
    const other = path.join(base, "other");
    await fs.mkdir(other, { recursive: true });
    expect(await materializeResolvedTrust(realConfig, targetConfig, other)).toBe(false);
    expect(targetConfig.loadConfigOrDefault().projects.has(other)).toBe(false);

    // A subdirectory inside a registered worktree keeps the fallback:
    // registration lists worktree roots, so the check compares the git
    // toplevel, while trust still materializes onto the requested
    // subdirectory (the task-spawn gate's exact-path lookup).
    const nested = path.join(worktree, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    expect(await materializeResolvedTrust(realConfig, targetConfig, nested)).toBe(true);
    expect(targetConfig.loadConfigOrDefault().projects.get(nested)?.trusted).toBe(true);

    // Worktree paths ending in whitespace must survive porcelain parsing
    // verbatim: the -z NUL-delimited output is parsed without trimming, so
    // the realpath comparison sees the genuine registered path.
    const trailing = path.join(base, "wt-trailing ");
    await Bun.$`git worktree add ${trailing} -b feature-trailing`.cwd(repo).quiet();
    expect(await materializeResolvedTrust(realConfig, targetConfig, trailing)).toBe(true);
    expect(targetConfig.loadConfigOrDefault().projects.get(trailing)?.trusted).toBe(true);

    // A trailing carriage return is likewise a valid Unix path byte: git
    // emits "<path>\r" + LF, so only the LF terminator may be stripped.
    if (process.platform !== "win32") {
      const trailingCr = path.join(base, "wt-cr\r");
      await Bun.$`git worktree add ${trailingCr} -b feature-cr`.cwd(repo).quiet();
      expect(await materializeResolvedTrust(realConfig, targetConfig, trailingCr)).toBe(true);
      expect(targetConfig.loadConfigOrDefault().projects.get(trailingCr)?.trusted).toBe(true);
    }

    // A crafted .git file pointing gitdir at the trusted repository must not
    // inherit its trust: the checkout is not registered as a linked worktree,
    // so treating it as one would let arbitrary directories run repo-controlled
    // automation under the trusted project's grant.
    const spoofed = path.join(base, "spoofed");
    await fs.mkdir(spoofed, { recursive: true });
    await fs.writeFile(path.join(spoofed, ".git"), `gitdir: ${path.join(repo, ".git")}\n`, "utf-8");
    expect(await materializeResolvedTrust(realConfig, targetConfig, spoofed)).toBe(false);
    expect(targetConfig.loadConfigOrDefault().projects.has(spoofed)).toBe(false);

    // A trusted source must fail loudly when Config swallows the target write error.
    const unwritableRoot = path.join(base, "unwritable-root");
    await fs.writeFile(unwritableRoot, "not a directory\n", "utf-8");
    const unwritableConfig = new Config(unwritableRoot);
    let error: unknown;
    try {
      await materializeResolvedTrust(realConfig, unwritableConfig, worktree);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  }, 15_000);

  test("fails loudly when the trust change cannot be persisted", async () => {
    using tmp = new DisposableTempDir("trust-cli-unwritable");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    // MUX_ROOT pointing at a regular file makes config.json unwritable;
    // Config.saveConfig swallows the write error, so only the post-write
    // verification can surface the failure.
    const muxRootFile = path.join(tmp.path, "mux-root-file");
    await fs.writeFile(muxRootFile, "not a directory\n", "utf-8");

    const result = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${repo} --json`
      .env({ ...process.env, MUX_ROOT: muxRootFile })
      .nothrow()
      .quiet();

    expect(result.exitCode).not.toBe(0);
    // Either failure surface is acceptable: the corrupt-config write gate
    // (config.json exists but cannot be read, so editConfig refuses to write
    // defaults over it) or the post-write trust verification (the write was
    // silently swallowed). Both must fail loudly instead of reporting
    // success.
    expect(result.stderr.toString()).toMatch(
      /Failed to persist trust change|Skipping config write/
    );
    expect(result.stdout.toString()).toBe("");
  }, 15_000);

  test("trust from a linked worktree records trust for the main repository", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree");
    // realpath: git reports physical paths (macOS /var -> /private/var) and the trust
    // entry written to config must match what trust resolution compares against.
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const muxRoot = path.join(base, "mux-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${worktree} --json`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    // Trust must land on the main repository path, not the ephemeral worktree path.
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });
  }, 15_000);
});
