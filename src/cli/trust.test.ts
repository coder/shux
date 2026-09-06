import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Config } from "@/node/config";
import {
  materializeCodexOauthAccount,
  materializeResolvedTrust,
  replaceRunTrustProjects,
  resolveProjectDir,
} from "./trust";

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

  test("copies Codex overrides without requiring project trust", async () => {
    using tmp = new DisposableTempDir("codex-project-copy");
    const real = new Config(path.join(tmp.path, "real"));
    const target = new Config(path.join(tmp.path, "target"));
    const projectPath = path.join(tmp.path, "project");
    await real.editConfig((config) => {
      config.projects.set(projectPath, { workspaces: [], codexOauthAccountId: "work" });
      return config;
    });
    await replaceRunTrustProjects(real, target);
    expect(target.loadConfigOrDefault().projects.get(projectPath)).toMatchObject({
      codexOauthAccountId: "work",
      workspaces: [],
    });
    await real.editConfig((config) => {
      config.projects.delete(projectPath);
      return config;
    });
    await replaceRunTrustProjects(real, target);
    expect(target.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
  });

  test("materializes subproject accounts onto temporary CLI workspace projects", async () => {
    using tmp = new DisposableTempDir("codex-worktree-copy");
    const real = new Config(path.join(tmp.path, "real"));
    const target = new Config(path.join(tmp.path, "target"));
    const root = path.join(tmp.path, "project");
    const subproject = path.join(root, "subproject");
    const worktree = path.join(tmp.path, "checkout");
    const cliProject = path.join(tmp.path, "cli-project");
    await real.editConfig((config) => {
      config.projects.set(root, {
        codexOauthAccountId: "personal",
        workspaces: [{ path: worktree, id: "test-account-workspace", subProjectPath: subproject }],
      });
      config.projects.set(subproject, { workspaces: [], codexOauthAccountId: "work" });
      return config;
    });
    await materializeCodexOauthAccount(real, target, worktree, cliProject);
    expect(target.loadConfigOrDefault().projects.get(cliProject)?.codexOauthAccountId).toBe("work");
    await real.editConfig((config) => {
      delete config.projects.get(subproject)!.codexOauthAccountId;
      return config;
    });
    await materializeCodexOauthAccount(real, target, worktree, cliProject);
    expect(
      target.loadConfigOrDefault().projects.get(cliProject)?.codexOauthAccountId
    ).toBeUndefined();
  });

  test("copies a physical non-git project's account through a requested symlink", async () => {
    using tmp = new DisposableTempDir("codex-requested-symlink");
    const real = new Config(path.join(tmp.path, "real"));
    const target = new Config(path.join(tmp.path, "target"));
    const projectPath = path.join(tmp.path, "project");
    const alias = path.join(tmp.path, "alias");
    await fs.mkdir(projectPath);
    await fs.symlink(projectPath, alias, "junction");
    await real.editConfig((config) => {
      config.projects.set(projectPath, { workspaces: [], codexOauthAccountId: "work" });
      return config;
    });
    await materializeCodexOauthAccount(real, target, alias, alias);
    expect(target.loadConfigOrDefault().projects.get(alias)?.codexOauthAccountId).toBe("work");
  });

  test("resolves linked worktree fallback through a registered repository alias", async () => {
    using tmp = new DisposableTempDir("codex-linked-worktree-alias");
    const real = new Config(path.join(tmp.path, "real"));
    const target = new Config(path.join(tmp.path, "target"));
    const repo = path.join(tmp.path, "repo");
    const repoAlias = path.join(tmp.path, "repo-alias");
    const worktree = path.join(tmp.path, "worktree");
    const worktreeAlias = path.join(tmp.path, "worktree-alias");
    await fs.mkdir(repo);
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m init`
      .cwd(repo)
      .quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();
    await fs.mkdir(path.join(worktree, "src"));
    await fs.symlink(repo, repoAlias, "junction");
    await fs.symlink(worktree, worktreeAlias, "junction");
    await real.editConfig((config) => {
      config.projects.set(repoAlias, { workspaces: [], codexOauthAccountId: "work" });
      return config;
    });
    await materializeCodexOauthAccount(
      real,
      target,
      path.join(worktreeAlias, "src"),
      worktreeAlias
    );
    expect(target.loadConfigOrDefault().projects.get(worktreeAlias)?.codexOauthAccountId).toBe(
      "work"
    );
  });

  test.each(["work", undefined])(
    "resolves non-git account scopes through directory aliases: %s",
    async (accountId) => {
      using tmp = new DisposableTempDir("codex-symlink-account");
      const real = new Config(path.join(tmp.path, "real"));
      const target = new Config(path.join(tmp.path, "target"));
      const root = path.join(tmp.path, "project");
      const subproject = path.join(root, "packages", "api");
      const rootAlias = path.join(tmp.path, "a-long-parent-alias");
      const subprojectAlias = path.join(tmp.path, "child");
      const targetProject = path.join(tmp.path, "cli-project");
      await fs.mkdir(path.join(subproject, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "packages", "api-other"), { recursive: true });
      await fs.symlink(root, rootAlias, "junction");
      await fs.symlink(subproject, subprojectAlias, "junction");
      await real.editConfig((config) => {
        // Alias length must not let a parent displace a deeper physical project.
        config.projects.set(rootAlias, { workspaces: [], codexOauthAccountId: "personal" });
        config.projects.set(subprojectAlias, { workspaces: [], codexOauthAccountId: accountId });
        return config;
      });
      for (const requestedPath of [
        subproject,
        subprojectAlias,
        path.join(rootAlias, "packages", "api"),
        path.join(subproject, "src"),
        path.join(rootAlias, "packages", "api", "src"),
      ]) {
        await target.editConfig((config) => {
          config.projects.set(targetProject, { workspaces: [], codexOauthAccountId: "stale" });
          return config;
        });
        await materializeCodexOauthAccount(real, target, requestedPath, targetProject);
        const project = target.loadConfigOrDefault().projects.get(targetProject);
        expect(project?.codexOauthAccountId).toBe(accountId);
        expect(Object.hasOwn(project ?? {}, "codexOauthAccountId")).toBe(accountId !== undefined);
      }
      await materializeCodexOauthAccount(
        real,
        target,
        path.join(root, "packages", "api-other"),
        targetProject
      );
      expect(target.loadConfigOrDefault().projects.get(targetProject)?.codexOauthAccountId).toBe(
        "personal"
      );
      // An exact configured path still wins over another spelling of the same directory.
      await real.editConfig((config) => {
        config.projects.set(subproject, { workspaces: [], codexOauthAccountId: "exact" });
        return config;
      });
      await materializeCodexOauthAccount(real, target, subproject, targetProject);
      expect(target.loadConfigOrDefault().projects.get(targetProject)?.codexOauthAccountId).toBe(
        "exact"
      );
    }
  );

  test("matches aliased workspace paths and subproject references", async () => {
    using tmp = new DisposableTempDir("codex-symlink-workspace");
    const real = new Config(path.join(tmp.path, "real"));
    const target = new Config(path.join(tmp.path, "target"));
    const root = path.join(tmp.path, "project");
    const subproject = path.join(root, "subproject");
    const subprojectAlias = path.join(tmp.path, "subproject-alias");
    const checkout = path.join(tmp.path, "checkout");
    const checkoutAlias = path.join(tmp.path, "checkout-alias");
    const cliProject = path.join(tmp.path, "cli-project");
    await fs.mkdir(subproject, { recursive: true });
    await fs.mkdir(checkout);
    await fs.symlink(subproject, subprojectAlias, "junction");
    await fs.symlink(checkout, checkoutAlias, "junction");
    await real.editConfig((config) => {
      config.projects.set(root, {
        codexOauthAccountId: "personal",
        workspaces: [{ id: "aliased-workspace", path: checkoutAlias, subProjectPath: subproject }],
      });
      config.projects.set(subprojectAlias, { workspaces: [], codexOauthAccountId: "work" });
      return config;
    });
    await materializeCodexOauthAccount(real, target, checkout, cliProject);
    expect(target.loadConfigOrDefault().projects.get(cliProject)?.codexOauthAccountId).toBe("work");
    await real.editConfig((config) => {
      delete config.projects.get(subprojectAlias)!.codexOauthAccountId;
      return config;
    });
    await materializeCodexOauthAccount(real, target, checkoutAlias, cliProject);
    expect(
      target.loadConfigOrDefault().projects.get(cliProject)?.codexOauthAccountId
    ).toBeUndefined();
  });

  test.each(["work", undefined])(
    "uses the deepest registered account scope: %s",
    async (accountId) => {
      using tmp = new DisposableTempDir("codex-nested-account");
      const real = new Config(path.join(tmp.path, "real"));
      const target = new Config(path.join(tmp.path, "target"));
      const root = path.join(tmp.path, "project");
      const subproject = path.join(root, "packages", "api");
      const targetProject = path.join(tmp.path, "cli-project");
      await real.editConfig((config) => {
        config.projects.set(subproject, { workspaces: [], codexOauthAccountId: accountId });
        config.projects.set(root, { workspaces: [], codexOauthAccountId: "personal" });
        return config;
      });
      await materializeCodexOauthAccount(real, target, path.join(subproject, "src"), targetProject);
      expect(target.loadConfigOrDefault().projects.get(targetProject)?.codexOauthAccountId).toBe(
        accountId
      );

      await materializeCodexOauthAccount(
        real,
        target,
        path.join(root, "packages", "api-other", "src"),
        targetProject
      );
      expect(target.loadConfigOrDefault().projects.get(targetProject)?.codexOauthAccountId).toBe(
        "personal"
      );
    }
  );

  test.each(["work", undefined])(
    "rejects a lost account selection write: %s",
    async (accountId) => {
      using tmp = new DisposableTempDir("codex-account-write-failure");
      const real = new Config(path.join(tmp.path, "real"));
      const target = new Config(path.join(tmp.path, "target"));
      const projectPath = path.join(tmp.path, "project");
      await real.editConfig((config) => {
        config.projects.set(projectPath, { workspaces: [], codexOauthAccountId: accountId });
        return config;
      });
      await target.editConfig((config) => {
        config.projects.set(projectPath, { workspaces: [], codexOauthAccountId: "personal" });
        return config;
      });
      // Simulate a config edit that reports success without writing the selection.
      const edit = spyOn(target, "editConfig").mockResolvedValue(undefined);
      try {
        let error: unknown;
        try {
          await materializeCodexOauthAccount(real, target, projectPath, projectPath);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("Failed to persist Codex OAuth account");
        expect(target.loadConfigOrDefault().projects.get(projectPath)?.codexOauthAccountId).toBe(
          "personal"
        );
      } finally {
        edit.mockRestore();
      }
    }
  );

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
