import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { Config } from "@/node/config";
import { Ok } from "@/common/types/result";
import { ORPCError } from "@orpc/server";
import type { SshPromptRequest } from "@/common/orpc/schemas/ssh";
import { SshPromptService } from "@/node/services/sshPromptService";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { ProjectService, type CloneEvent } from "./projectService";
import {
  projectRegistrationLockFilePath,
  withProjectRegistrationLock,
} from "@/node/config/projectRegistrationLock";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";

async function createLocalGitRepository(rootDir: string, repoName: string): Promise<string> {
  const repoPath = path.join(rootDir, repoName);
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(path.join(repoPath, "README.md"), "# test\n", "utf-8");

  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: repoPath, stdio: "ignore" });
  execSync('git -c user.name="test" -c user.email="test@test" commit -m "initial"', {
    cwd: repoPath,
    stdio: "ignore",
  });

  return repoPath;
}

const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const originals = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const DEFAULT_FAKE_GIT_SHIM = `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_GIT_ARGS_LOG"
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`;

async function installFakeGit(tempDir: string, testCaseId: string, shimBody: string) {
  const fakeBinDir = path.join(tempDir, `fake-bin-${testCaseId}`);
  const fakeGitArgsLogPath = path.join(tempDir, `fake-git-${testCaseId}-args.log`);
  await fs.mkdir(fakeBinDir, { recursive: true });
  const fakeGitPath = path.join(fakeBinDir, "git");
  await fs.writeFile(fakeGitPath, shimBody, "utf-8");
  await fs.chmod(fakeGitPath, 0o755);
  return {
    fakeGitArgsLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_GIT_ARGS_LOG: fakeGitArgsLogPath,
      HOME: tempDir,
    },
  };
}

async function cloneWithFakeGit(
  tempDir: string,
  service: ProjectService,
  input: { testCaseId: string; repoUrl: string; cloneParentDir: string; sshAuthSock?: string }
) {
  if (process.platform === "win32") {
    // These tests rely on a POSIX shell shim named "git" in PATH.
    return null;
  }

  const fakeGit = await installFakeGit(tempDir, input.testCaseId, DEFAULT_FAKE_GIT_SHIM);

  const result = await withEnv({ ...fakeGit.env, SSH_AUTH_SOCK: input.sshAuthSock }, () =>
    service.clone({ repoUrl: input.repoUrl, cloneParentDir: input.cloneParentDir })
  );

  expect(result.success).toBe(true);
  if (!result.success) throw new Error("Expected success");
  const loggedArgs = (await fs.readFile(fakeGit.fakeGitArgsLogPath, "utf-8")).trim().split("\n");
  return { result, loggedArgs, cloneWorkPath: loggedArgs[4] ?? "" };
}

async function collectCloneEvents(
  tempDir: string,
  service: ProjectService,
  input: {
    testCaseId: string;
    repoUrl: string;
    cloneParentDir: string;
    sshAuthSock?: string;
    gitShimBody: string;
    signal?: AbortSignal;
    onEvent?: (event: CloneEvent) => void;
  }
) {
  if (process.platform === "win32") {
    // These tests rely on a POSIX shell shim named "git" in PATH.
    return null;
  }

  const fakeGit = await installFakeGit(tempDir, input.testCaseId, input.gitShimBody);

  const events: CloneEvent[] = [];
  await withEnv({ ...fakeGit.env, SSH_AUTH_SOCK: input.sshAuthSock }, async () => {
    for await (const event of service.cloneWithProgress(
      { repoUrl: input.repoUrl, cloneParentDir: input.cloneParentDir },
      input.signal
    )) {
      events.push(event);
      input.onEvent?.(event);
    }
  });

  const clonedUrls = (await fs.readFile(fakeGit.fakeGitArgsLogPath, "utf-8")).trim().split("\n");
  return { events, clonedUrls };
}

/**
 * Simulated concurrent registration for create()'s in-transform duplicate re-check. Real
 * writers are serialized with create() by the registration lock (Config.editConfig takes
 * it for any project-set change), so the interleaving these tests exercise is reproduced by
 * marking the edit as a same-window writer; the re-check stays as defense in depth.
 */
const REGISTER_CONCURRENTLY = {
  withinRegistrationLock: { assertStillOwned: () => Promise.resolve() },
} as const;

describe("ProjectService", () => {
  let tempDir: string;
  let config: Config;
  let service: ProjectService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "projectservice-test-"));
    config = new Config(tempDir);
    service = new ProjectService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates and registers a git project at a new path", async () => {
      const projectPath = path.join(tempDir, "new-git-project");

      const result = await service.create(projectPath, { initGit: true });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");
      expect(result.data.normalizedPath).toBe(projectPath);
      expect((await fs.stat(path.join(projectPath, ".git"))).isDirectory()).toBe(true);
      expect(
        execSync("git branch --show-current", { cwd: projectPath, encoding: "utf-8" }).trim()
      ).toBe("main");
      expect(
        execSync("git rev-list --count HEAD", { cwd: projectPath, encoding: "utf-8" }).trim()
      ).toBe("1");
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    it("initializes and registers an existing empty directory", async () => {
      const projectPath = path.join(tempDir, "empty-git-project");
      await fs.mkdir(projectPath);

      const result = await service.create(projectPath, { initGit: true });

      expect(result.success).toBe(true);
      expect((await fs.stat(path.join(projectPath, ".git"))).isDirectory()).toBe(true);
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    it("rejects an existing non-empty directory without modifying it", async () => {
      const projectPath = path.join(tempDir, "non-empty-project");
      const existingFile = path.join(projectPath, "README.md");
      await fs.mkdir(projectPath);
      await fs.writeFile(existingFile, "existing content", "utf-8");

      const result = await service.create(projectPath, { initGit: true });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("already exists and is not empty");
      expect(await fs.readFile(existingFile, "utf-8")).toBe("existing content");
      expect(fs.stat(path.join(projectPath, ".git"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
    });

    it("rejects invalid paths without registering a project", async () => {
      const filePath = path.join(tempDir, "not-a-directory");
      await fs.writeFile(filePath, "content", "utf-8");

      const fileResult = await service.create(filePath, { initGit: true });
      const emptyResult = await service.create("", { initGit: true });

      expect(fileResult.success).toBe(false);
      expect(emptyResult.success).toBe(false);
      expect(await fs.readFile(filePath, "utf-8")).toBe("content");
      expect(config.loadConfigOrDefault().projects.size).toBe(0);
    });

    it("rejects initGit inside a registered project tree", async () => {
      const parentPath = await createLocalGitRepository(tempDir, "parent-repo");
      const parentResult = await service.create(parentPath);
      expect(parentResult.success).toBe(true);

      const nestedPath = path.join(parentPath, "nested-new-repo");
      const result = await service.create(nestedPath, { initGit: true });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain(
        "Cannot create a new git repository inside an existing project"
      );
      // The rejected nested directory must not linger inside the parent checkout.
      expect(fs.stat(nestedPath)).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(nestedPath)).toBe(false);
    });

    it("rejects initGit reached through a symlink into a registered project tree", async () => {
      if (process.platform === "win32") return;

      // Canonicalize the temp root (macOS /var is itself a symlink) so the registered
      // parent path matches what realpath resolves the alias to.
      const realTempDir = await fs.realpath(tempDir);
      const parentPath = await createLocalGitRepository(realTempDir, "symlink-parent-repo");
      const parentResult = await service.create(parentPath);
      expect(parentResult.success).toBe(true);

      const aliasPath = path.join(realTempDir, "parent-alias");
      await fs.symlink(parentPath, aliasPath);
      const nestedAliasPath = path.join(aliasPath, "nested-new-repo");

      const result = await service.create(nestedAliasPath, { initGit: true });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain(
        "Cannot create a new git repository inside an existing project"
      );
      expect(fs.stat(path.join(parentPath, "nested-new-repo"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(nestedAliasPath)).toBe(false);
    });

    it("rejects initGit when the canonical parent registers concurrently via symlink", async () => {
      if (process.platform === "win32") return;

      const realTempDir = await fs.realpath(tempDir);
      const parentPath = await createLocalGitRepository(realTempDir, "late-parent-repo");
      const aliasPath = path.join(realTempDir, "late-parent-alias");
      await fs.symlink(parentPath, aliasPath);
      const nestedAliasPath = path.join(aliasPath, "nested-late-repo");

      // Deterministic interleaving: queue the parent registration so create()'s
      // snapshot read misses it while its transform sees it. The lexical fresh-parent
      // check cannot catch this (the alias is not lexically beneath the real path);
      // only the canonical re-check in the transform can reject it.
      const registerParent = config.editConfig((cfg) => {
        cfg.projects.set(parentPath, { workspaces: [] });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const result = await service.create(nestedAliasPath, { initGit: true });
      await registerParent;

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("changed concurrently");
      // The nested repository must not survive inside the registered checkout.
      expect(fs.stat(path.join(parentPath, "nested-late-repo"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(nestedAliasPath)).toBe(false);
    });

    it("fails initGit create without leaving .git when config persistence fails", async () => {
      const projectPath = path.join(tempDir, "persist-fail-project");
      const nonPersistingConfig = new Config(tempDir);
      // Run the transform (so create() reaches its success path) but drop the save,
      // modeling saveConfig's log-and-continue behavior on write failures.
      nonPersistingConfig.editConfig = (transform) => {
        transform(nonPersistingConfig.loadConfigOrDefault());
        return Promise.resolve();
      };
      const nonPersistingService = new ProjectService(nonPersistingConfig);

      const result = await nonPersistingService.create(projectPath, { initGit: true });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("save project configuration");
      // Roll back the created directory so a retry is not blocked by leftover .git.
      expect(fs.stat(projectPath)).rejects.toThrow();
    });

    it("rolls back a partial .git when git init itself fails", async () => {
      if (process.platform === "win32") return;

      const projectPath = path.join(tempDir, "partial-init-project");
      await fs.mkdir(projectPath);
      // Model a broken init template: init creates a partial .git, then fails.
      const fakeGit = await installFakeGit(
        tempDir,
        "create-partial-init-failure",
        `#!/bin/sh
prev=""
for arg in "$@"; do
  if [ "$arg" = "init" ]; then
    mkdir -p "$prev/.git"
    printf 'init failed' >&2
    exit 1
  fi
  prev="$arg"
done
exit 1
`
      );

      const result = await withEnv(fakeGit.env, () =>
        service.create(projectPath, { initGit: true })
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("init failed");
      expect((await fs.stat(projectPath)).isDirectory()).toBe(true);
      expect(fs.stat(path.join(projectPath, ".git"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
    });

    it("removes only .git when a plain create wins the same pre-existing directory", async () => {
      const projectPath = path.join(tempDir, "plain-vs-initgit");
      await fs.mkdir(projectPath);

      // Deterministic interleaving: queue the plain registration so the initGit
      // create's snapshot misses it (git init runs) while its transform hits the
      // duplicate re-check; the loser must strip its .git from the winner's project.
      const registerPlain = config.editConfig((cfg) => {
        cfg.projects.set(projectPath, { workspaces: [] });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const result = await service.create(projectPath, { initGit: true });
      await registerPlain;

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("already exists");
      expect((await fs.stat(projectPath)).isDirectory()).toBe(true);
      expect(fs.stat(path.join(projectPath, ".git"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    it("initializes the new project even when GIT_DIR/GIT_WORK_TREE point elsewhere", async () => {
      const externalRepoPath = await createLocalGitRepository(tempDir, "external-selected-repo");
      const externalCommitsBefore = execSync("git rev-list --count HEAD", {
        cwd: externalRepoPath,
        encoding: "utf-8",
      }).trim();
      const projectPath = path.join(tempDir, "env-selected-project");

      const result = await withEnv(
        { GIT_DIR: path.join(externalRepoPath, ".git"), GIT_WORK_TREE: externalRepoPath },
        () => service.create(projectPath, { initGit: true })
      );

      expect(result.success).toBe(true);
      // The new project owns its own repository; the externally selected one is untouched.
      expect((await fs.stat(path.join(projectPath, ".git"))).isDirectory()).toBe(true);
      expect(
        execSync("git rev-list --count HEAD", { cwd: externalRepoPath, encoding: "utf-8" }).trim()
      ).toBe(externalCommitsBefore);
    });

    it("serializes concurrent gitInit calls for the same directory", async () => {
      const projectPath = path.join(tempDir, "concurrent-gitinit");
      await fs.mkdir(projectPath);

      const [first, second] = await Promise.all([
        service.gitInit(projectPath),
        service.gitInit(projectPath),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((r) => r.success)).toHaveLength(1);
      const loser = outcomes.find((r) => !r.success);
      expect(loser && !loser.success ? loser.error : "").toContain("already initializing");
      // The winner's repository survives with exactly its initial commit.
      expect(
        execSync("git rev-list --count HEAD", { cwd: projectPath, encoding: "utf-8" }).trim()
      ).toBe("1");
    });

    it("removes only .git when a descendant wins registration during an initGit create", async () => {
      const parentPath = path.join(tempDir, "late-descendant-parent");
      const descendantPath = path.join(parentPath, "child-project");

      // Deterministic interleaving: queue the descendant registration so create()'s
      // snapshot misses it (git init runs) while its transform sees it and records
      // hierarchy-changed-descendant, which must strip our .git but keep the tree.
      const registerDescendant = config.editConfig((cfg) => {
        cfg.projects.set(descendantPath, { workspaces: [] });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const result = await service.create(parentPath, { initGit: true });
      await registerDescendant;

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("changed concurrently");
      // The winner's tree survives, but our unregistered outer repository must not.
      expect((await fs.stat(parentPath)).isDirectory()).toBe(true);
      expect(fs.stat(path.join(parentPath, ".git"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(parentPath)).toBe(false);
      expect(config.loadConfigOrDefault().projects.has(descendantPath)).toBe(true);
    });

    it("serializes concurrent initGit creates of the same pre-existing empty directory", async () => {
      const projectPath = path.join(tempDir, "shared-empty-project");
      await fs.mkdir(projectPath);

      const [first, second] = await Promise.all([
        service.create(projectPath, { initGit: true }),
        service.create(projectPath, { initGit: true }),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((r) => r.success)).toHaveLength(1);
      // The loser must never touch the winner's git state: the repository stays
      // intact with its initial commit and stays registered.
      expect(
        execSync("git rev-list --count HEAD", { cwd: projectPath, encoding: "utf-8" }).trim()
      ).toBe("1");
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    it("rolls back git init in a pre-existing directory when the initial commit fails", async () => {
      if (process.platform === "win32") return;

      const projectPath = path.join(tempDir, "existing-empty-project");
      await fs.mkdir(projectPath);
      // Real `git init` so the .git rollback has something to remove; the shim fails
      // only the commit step to model hook/signing failures after a successful init.
      const realGit = execSync("command -v git", { encoding: "utf-8" }).trim();
      const fakeGit = await installFakeGit(
        tempDir,
        "create-commit-failure",
        `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "commit" ]; then
    printf 'commit failed' >&2
    exit 1
  fi
done
exec ${realGit} "$@"
`
      );

      const result = await withEnv(fakeGit.env, () =>
        service.create(projectPath, { initGit: true })
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("commit failed");
      // The user's directory survives, but the partial .git must be rolled back so a
      // retry is not rejected as non-empty.
      expect((await fs.stat(projectPath)).isDirectory()).toBe(true);
      expect(fs.stat(path.join(projectPath, ".git"))).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);

      const retry = await service.create(projectPath, { initGit: true });
      expect(retry.success).toBe(true);
    });

    it("removes a newly created directory when git initialization fails", async () => {
      if (process.platform === "win32") return;

      const projectPath = path.join(tempDir, "failed-git-project");
      const fakeGit = await installFakeGit(
        tempDir,
        "create-init-failure",
        "#!/bin/sh\nprintf 'git failed' >&2\nexit 1\n"
      );

      const result = await withEnv(fakeGit.env, () =>
        service.create(projectPath, { initGit: true })
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("git failed");
      expect(fs.stat(projectPath)).rejects.toThrow();
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
    });

    it("concurrent initGit creates of the same new path leave one intact repository", async () => {
      const projectPath = path.join(tempDir, "concurrent-git-project");

      const [first, second] = await Promise.all([
        service.create(projectPath, { initGit: true }),
        service.create(projectPath, { initGit: true }),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((r) => r.success)).toHaveLength(1);
      // The loser must never run git operations in the winner's directory, so the
      // winner's repository stays intact and registered.
      expect(
        execSync("git rev-list --count HEAD", { cwd: projectPath, encoding: "utf-8" }).trim()
      ).toBe("1");
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    // Regression (PR #3694 Codex P1): two concurrent create() calls for the same
    // not-yet-existing path both compute createdDirectory === true before either
    // registration is serialized. The loser hits the duplicate re-check inside the
    // editConfig transform; it must NOT recursively delete the directory, which now
    // belongs to the winning registration.
    it("concurrent create of the same new path keeps the winner's directory", async () => {
      const projectPath = path.join(tempDir, "concurrent-project");

      const [first, second] = await Promise.all([
        service.create(projectPath),
        service.create(projectPath),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((r) => r.success)).toHaveLength(1);
      const loser = outcomes.find((r) => !r.success);
      expect(loser && !loser.success ? loser.error : "").toContain("already exists");

      // The winner's registered checkout must survive the loser's failure path.
      const stat = await fs.stat(projectPath);
      expect(stat.isDirectory()).toBe(true);
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);
    });

    // Regression (PR #3694 Codex P2): the snapshot-time depth check can miss a
    // sub-project ancestor registered concurrently, persisting a project nested
    // under a registered sub-project ("one level deep" invariant violation). The
    // serialized transform must re-validate depth against the fresh hierarchy.
    it("create rejects a path nested under a concurrently registered sub-project", async () => {
      const repoPath = path.join(tempDir, "repo");
      const pkgPath = path.join(repoPath, "pkg");
      const apiPath = path.join(pkgPath, "api");
      await fs.mkdir(apiPath, { recursive: true });
      // Same-git-repo hierarchy so the snapshot-time git-root validations pass.
      const git = Bun.spawn(["git", "init", "-q", repoPath]);
      await git.exited;

      const topLevel = await service.create(repoPath);
      expect(topLevel.success).toBe(true);

      // Deterministic interleaving: enqueue the concurrent sub-project registration
      // of /repo/pkg first (not yet written), then call create(/repo/pkg/api). The
      // create's synchronous snapshot read runs before the queued write lands, so
      // its snapshot-time depth check misses pkg; its transform is queued after and
      // sees pkg — only the fresh in-transform depth re-check can reject it.
      const registerPkg = config.editConfig((cfg) => {
        cfg.projects.set(pkgPath, { workspaces: [], parentProjectPath: repoPath });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const api = await service.create(apiPath);
      await registerPkg;

      expect(api.success).toBe(false);
      expect(!api.success && api.error).toContain("one level deep");
      const persisted = config.loadConfigOrDefault().projects;
      expect(persisted.has(apiPath)).toBe(false);
      // The pre-existing directory was not created by this call; it must survive.
      const stat = await fs.stat(apiPath);
      expect(stat.isDirectory()).toBe(true);
    });

    // Regression (PR #3694 Codex P2): the same-git-repo validations only run against
    // the snapshot. A concurrent registration can introduce a parent (or descendant)
    // that was never git-validated; the transform must reject rather than persist an
    // unvalidated hierarchy (here: a sub-project from a DIFFERENT git repository).
    it("create rejects when a concurrent registration changes the unvalidated hierarchy", async () => {
      const repoPath = path.join(tempDir, "hier-repo");
      const pkgPath = path.join(repoPath, "pkg");
      await fs.mkdir(pkgPath, { recursive: true });
      await Bun.spawn(["git", "init", "-q", repoPath]).exited;
      // pkg is a SEPARATE git repository: had /repo existed at snapshot time, the
      // same-git-repo validation would have rejected registering pkg beneath it.
      await Bun.spawn(["git", "init", "-q", pkgPath]).exited;

      // Deterministic interleaving: queue the registration of /hier-repo (the would-be
      // parent) so create(pkg)'s synchronous snapshot read misses it — its git-root
      // validation therefore never runs — while its queued transform sees it.
      const registerRepo = config.editConfig((cfg) => {
        cfg.projects.set(repoPath, { workspaces: [] });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const result = await service.create(pkgPath);
      await registerRepo;

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("changed concurrently");
      expect(config.loadConfigOrDefault().projects.has(pkgPath)).toBe(false);
      // Pre-existing directory not created by this call must survive the rejection.
      expect((await fs.stat(pkgPath)).isDirectory()).toBe(true);
    });

    // Regression (PR #3694 Codex P1): when create() made the directory itself and the
    // hierarchy rejection is caused by a NEW DESCENDANT registered concurrently, the
    // descendant's checkout lives inside that directory tree — recursive cleanup would
    // delete the winning project's files.
    it("create keeps the directory when a descendant project registered concurrently", async () => {
      const parentPath = path.join(tempDir, "race-parent");
      const descendantPath = path.join(parentPath, "pkg");

      // Deterministic interleaving: queue the descendant registration so create()'s
      // synchronous snapshot read misses it (createdDirectory === true, no validated
      // descendants) while its queued transform sees the new descendant.
      const registerDescendant = config.editConfig((cfg) => {
        cfg.projects.set(descendantPath, { workspaces: [] });
        return cfg;
      }, REGISTER_CONCURRENTLY);
      const result = await service.create(parentPath);
      await registerDescendant;

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("changed concurrently");
      // The created directory now hosts the registered descendant project's tree:
      // it must NOT be recursively deleted by the loser's cleanup.
      expect((await fs.stat(parentPath)).isDirectory()).toBe(true);
      expect(config.loadConfigOrDefault().projects.has(descendantPath)).toBe(true);
    });
  });

  describe("listDirectory", () => {
    it("returns root node with the actual requested path, not empty string", async () => {
      // Create test directory structure
      const testDir = path.join(tempDir, "test-project");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "subdir1"));
      await fs.mkdir(path.join(testDir, "subdir2"));
      await fs.writeFile(path.join(testDir, "file.txt"), "test");

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Critical regression test: root.path must be the actual path, not ""
      // This was broken when buildFileTree() was used, which always returns path: ""
      expect(result.data.path).toBe(testDir);
      expect(result.data.name).toBe(testDir);
      expect(result.data.isDirectory).toBe(true);
    });

    it("returns only immediate subdirectories as children", async () => {
      const testDir = path.join(tempDir, "nested");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "child1"));
      await fs.mkdir(path.join(testDir, "child1", "grandchild")); // nested
      await fs.mkdir(path.join(testDir, "child2"));
      await fs.writeFile(path.join(testDir, "file.txt"), "test"); // file, not dir

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Should only have child1 and child2, not grandchild or file.txt
      expect(result.data.children.length).toBe(2);
      const childNames = result.data.children.map((c) => c.name).sort();
      expect(childNames).toEqual(["child1", "child2"]);
    });

    it("children have correct full paths", async () => {
      const testDir = path.join(tempDir, "paths-test");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "mysubdir"));

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.children.length).toBe(1);
      const child = result.data.children[0];
      expect(child.name).toBe("mysubdir");
      expect(child.path).toBe(path.join(testDir, "mysubdir"));
      expect(child.isDirectory).toBe(true);
    });

    it("resolves relative paths to absolute", async () => {
      // Create a subdir in tempDir
      const subdir = path.join(tempDir, "relative-test");
      await fs.mkdir(subdir);

      const result = await service.listDirectory(subdir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Should be resolved to absolute path
      expect(path.isAbsolute(result.data.path)).toBe(true);
      expect(result.data.path).toBe(subdir);
    });

    it("handles empty directory", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const result = await service.listDirectory(emptyDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(emptyDir);
      expect(result.data.children).toEqual([]);
    });

    it("handles '.' path by resolving to current working directory", async () => {
      // Save cwd and change to tempDir for this test
      const originalCwd = process.cwd();
      // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
      const realTempDir = await fs.realpath(tempDir);
      process.chdir(realTempDir);

      try {
        const result = await service.listDirectory(".");

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected success");

        expect(result.data.path).toBe(realTempDir);
        expect(path.isAbsolute(result.data.path)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns error for non-existent directory", async () => {
      const result = await service.listDirectory(path.join(tempDir, "does-not-exist"));

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("ENOENT");
    });

    it("expands ~ to home directory", async () => {
      const result = await service.listDirectory("~");

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(os.homedir());
    });

    it("expands ~/subpath to home directory subpath", async () => {
      const result = await service.listDirectory("~/.");

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(os.homedir());
    });
  });

  describe("clone", () => {
    it("clones a local repository and registers it as a project", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo");
      const cloneParentDir = path.join(tempDir, "clones");

      const result = await service.clone({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo");
      expect(result.data.normalizedPath).toBe(expectedProjectPath);
      expect(result.data.projectConfig).toEqual({ workspaces: [] });

      const gitDir = await fs.stat(path.join(expectedProjectPath, ".git"));
      expect(gitDir.isDirectory()).toBe(true);

      const loadedConfig = config.loadConfigOrDefault();
      expect(loadedConfig.projects.has(expectedProjectPath)).toBe(true);
      expect(loadedConfig.defaultProjectDir).toBeUndefined();
    });

    const fakeGitCloneCases = [
      {
        name: "normalizes trailing-slash owner/repo shorthand to GitHub HTTPS when SSH agent is unavailable",
        testCaseId: "shorthand",
        cloneDir: "shorthand-clones",
        repoUrl: "owner/repo/",
        expectedRepoUrl: "https://github.com/owner/repo.git",
        expectedFolderName: "repo",
        sshAuthSock: undefined,
      },
      {
        name: "normalizes owner/repo shorthand to GitHub SSH when SSH credentials are available",
        testCaseId: "ssh-shorthand",
        cloneDir: "ssh-shorthand-clones",
        repoUrl: "owner/repo",
        expectedRepoUrl: "git@github.com:owner/repo.git",
        expectedFolderName: "repo",
        sshAuthSock: "fake-ssh-agent.sock",
      },
      {
        name: "preserves combining-mark script names when deriving clone folder names",
        testCaseId: "unicode",
        cloneDir: "unicode-clones",
        repoUrl: "https://example.com/org/हिन्दी.git",
        expectedFolderName: "हिन्दी",
      },
      {
        name: "falls back to deterministic safe folder names when repo basename sanitizes to empty",
        testCaseId: "fallback",
        cloneDir: "fallback-clones",
        repoUrl: "https://example.com/org/🚀🚀.git",
        expectedFolderName: `repo-${createHash("sha256")
          .update("https://example.com/org/🚀🚀.git")
          .digest("hex")
          .slice(0, 10)}`,
      },
      {
        name: "avoids Windows reserved destination names",
        testCaseId: "reserved",
        cloneDir: "reserved-name-clones",
        repoUrl: "https://example.com/org/con.txt.git",
        expectedFolderName: "con-repo.txt",
      },
    ];

    for (const testCase of fakeGitCloneCases) {
      it(testCase.name, async () => {
        const cloneParentDir = path.join(tempDir, testCase.cloneDir);
        const captured = await cloneWithFakeGit(tempDir, service, {
          testCaseId: testCase.testCaseId,
          repoUrl: testCase.repoUrl,
          cloneParentDir,
          sshAuthSock: testCase.sshAuthSock
            ? path.join(tempDir, testCase.sshAuthSock)
            : testCase.sshAuthSock,
        });
        if (!captured) return;

        if (testCase.expectedRepoUrl) {
          expect(captured.loggedArgs[0]).toBe("clone");
          expect(captured.loggedArgs[1]).toBe("--progress");
          expect(captured.loggedArgs[2]).toBe("--");
          expect(captured.loggedArgs[3]).toBe(testCase.expectedRepoUrl);
        }
        expect(path.dirname(captured.cloneWorkPath)).toBe(path.resolve(cloneParentDir));
        expect(path.basename(captured.cloneWorkPath)).toMatch(
          new RegExp(`^${testCase.expectedFolderName}[.]mux-clone-[a-f0-9]{12}$`)
        );
        expect(captured.result.data.normalizedPath).toBe(
          path.resolve(cloneParentDir, testCase.expectedFolderName)
        );
      });
    }

    it("sanitizes repo-derived folder names that contain shell metacharacters", async () => {
      const markerName = `WIN_marker_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const cloneParentDir = path.join(tempDir, "sanitized-clones");
      const captured = await cloneWithFakeGit(tempDir, service, {
        testCaseId: "sanitize",
        repoUrl: `git://localhost/$(touch ${markerName}).git`,
        cloneParentDir,
      });
      if (!captured) return;

      const expectedFolderName = `touch-${markerName}`;
      expect(captured.cloneWorkPath).not.toContain("$(");
      expect(path.dirname(captured.cloneWorkPath)).toBe(path.resolve(cloneParentDir));
      expect(path.basename(captured.cloneWorkPath)).toMatch(
        new RegExp(`^${expectedFolderName}[.]mux-clone-[a-f0-9]{12}$`)
      );
      expect(captured.result.data.normalizedPath).toBe(
        path.resolve(cloneParentDir, expectedFolderName)
      );
    });

    it("falls back to GitHub HTTPS when the SSH shorthand clone fails", async () => {
      const cloneParentDir = path.join(tempDir, "fallback-transport-clones");
      const captured = await collectCloneEvents(tempDir, service, {
        testCaseId: "ssh-to-https-fallback",
        repoUrl: "owner/repo",
        cloneParentDir,
        sshAuthSock: path.join(tempDir, "fake-ssh-agent.sock"),
        gitShimBody: `#!/bin/sh
printf '%s\\n' "$4" >> "$FAKE_GIT_ARGS_LOG"
case "$4" in
  git@github.com:*)
    echo "git@github.com: Permission denied (publickey)." >&2
    exit 128
    ;;
esac
mkdir -p "$5/.git"
exit 0
`,
      });
      if (!captured) return;

      expect(captured.clonedUrls).toEqual([
        "git@github.com:owner/repo.git",
        "https://github.com/owner/repo.git",
      ]);
      const progressLines = captured.events
        .filter((event) => event.type === "progress")
        .map((event) => event.line);
      expect(
        progressLines.some((line) =>
          line.includes("retrying with https://github.com/owner/repo.git")
        )
      ).toBe(true);

      const lastEvent = captured.events.at(-1);
      expect(lastEvent?.type).toBe("success");
      if (lastEvent?.type !== "success") throw new Error("Expected success event");
      const expectedProjectPath = path.resolve(cloneParentDir, "repo");
      expect(lastEvent.normalizedPath).toBe(expectedProjectPath);
      expect(config.loadConfigOrDefault().projects.has(expectedProjectPath)).toBe(true);
    });

    it("does not start the fallback clone when aborted between attempts", async () => {
      const cloneParentDir = path.join(tempDir, "abort-between-attempts-clones");
      const abortController = new AbortController();
      const captured = await collectCloneEvents(tempDir, service, {
        testCaseId: "abort-between-attempts",
        repoUrl: "owner/repo",
        cloneParentDir,
        sshAuthSock: path.join(tempDir, "fake-ssh-agent.sock"),
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "progress" && event.line.includes("retrying with")) {
            abortController.abort();
          }
        },
        gitShimBody: `#!/bin/sh
printf '%s\n' "$4" >> "$FAKE_GIT_ARGS_LOG"
case "$4" in
  git@github.com:*)
    echo "git@github.com: Permission denied (publickey)." >&2
    exit 128
    ;;
esac
mkdir -p "$5/.git"
exit 0
`,
      });
      if (!captured) return;

      expect(captured.clonedUrls).toEqual(["git@github.com:owner/repo.git"]);
      const lastEvent = captured.events.at(-1);
      expect(lastEvent?.type).toBe("error");
      if (lastEvent?.type !== "error") throw new Error("Expected error event");
      expect(lastEvent.error).toBe("Clone cancelled");
      const leftovers = (await fs.readdir(cloneParentDir)).filter((name) =>
        name.includes(".mux-clone-")
      );
      expect(leftovers).toEqual([]);
      expect(config.loadConfigOrDefault().projects.size).toBe(0);
    });

    it("does not fall back to HTTPS for explicit SSH clone URLs", async () => {
      const cloneParentDir = path.join(tempDir, "explicit-ssh-clones");
      const captured = await collectCloneEvents(tempDir, service, {
        testCaseId: "explicit-ssh-no-fallback",
        repoUrl: "git@github.com:owner/private.git",
        cloneParentDir,
        gitShimBody: `#!/bin/sh
printf '%s\\n' "$4" >> "$FAKE_GIT_ARGS_LOG"
echo "git@github.com: Permission denied (publickey)." >&2
exit 128
`,
      });
      if (!captured) return;

      expect(captured.clonedUrls).toEqual(["git@github.com:owner/private.git"]);
      const lastEvent = captured.events.at(-1);
      expect(lastEvent?.type).toBe("error");
      if (lastEvent?.type !== "error") throw new Error("Expected error event");
      expect(lastEvent.error).toContain("Permission denied");
      expect(lastEvent.error).not.toContain("read access");
    });

    it("explains GitHub's misleading write-access error on failed clones", async () => {
      const cloneParentDir = path.join(tempDir, "write-access-clones");
      const captured = await collectCloneEvents(tempDir, service, {
        testCaseId: "write-access-hint",
        repoUrl: "https://github.com/owner/private.git",
        cloneParentDir,
        gitShimBody: `#!/bin/sh
printf '%s\\n' "$4" >> "$FAKE_GIT_ARGS_LOG"
echo "remote: Write access to repository not granted." >&2
echo "fatal: unable to access 'https://github.com/owner/private.git/': The requested URL returned error: 403" >&2
exit 128
`,
      });
      if (!captured) return;

      expect(captured.clonedUrls).toEqual(["https://github.com/owner/private.git"]);
      const lastEvent = captured.events.at(-1);
      expect(lastEvent?.type).toBe("error");
      if (lastEvent?.type !== "error") throw new Error("Expected error event");
      expect(lastEvent.error).toContain("Write access to repository not granted");
      expect(lastEvent.error).toContain("Cloning needs only read access");
    });

    it("returns error when clone destination already exists", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo");
      const cloneParentDir = path.join(tempDir, "clones");
      const existingDestination = path.join(cloneParentDir, "source-repo");

      await fs.mkdir(existingDestination, { recursive: true });

      const result = await service.clone({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("Destination already exists");
    });
  });

  describe("cloneWithProgress", () => {
    it("emits progress events and registers project on success", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-progress");
      const cloneParentDir = path.join(tempDir, "progress-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-progress");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo 'progress: starting' >&2
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      try {
        const events: CloneEvent[] = [];
        for await (const event of service.cloneWithProgress({
          repoUrl: sourceRepoPath,
          cloneParentDir,
        })) {
          events.push(event);
        }

        const progressEvent = events.find((event) => event.type === "progress");
        expect(progressEvent?.type).toBe("progress");
        if (progressEvent?.type !== "progress") throw new Error("Expected progress event");
        expect(progressEvent.line).toContain("progress: starting");

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");
        if (successEvent?.type !== "success") throw new Error("Expected success event");

        const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-progress");
        expect(successEvent.normalizedPath).toBe(expectedProjectPath);

        const loadedConfig = config.loadConfigOrDefault();
        expect(loadedConfig.projects.has(expectedProjectPath)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("yields error and rolls back when cloned project cannot be persisted in config", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-persist-fail");
      const cloneParentDir = path.join(tempDir, "persist-fail-clones");
      const nonPersistingConfig = new Config(tempDir);
      nonPersistingConfig.editConfig = () => Promise.resolve();
      const nonPersistingService = new ProjectService(nonPersistingConfig);

      const events: CloneEvent[] = [];
      for await (const event of nonPersistingService.cloneWithProgress({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      })) {
        events.push(event);
      }

      const terminalEvent = events[events.length - 1];
      expect(terminalEvent?.type).toBe("error");
      if (terminalEvent?.type !== "error") throw new Error("Expected error event");
      expect(terminalEvent.error).toContain("persist");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-persist-fail");
      expect(nonPersistingConfig.loadConfigOrDefault().projects.has(expectedProjectPath)).toBe(
        false
      );

      try {
        await fs.stat(expectedProjectPath);
        throw new Error("Expected clone destination to be rolled back");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        expect(err.code).toBe("ENOENT");
      }
    });

    it("cleans up partial clone and yields cancellation event when aborted", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-cancel");
      const cloneParentDir = path.join(tempDir, "cancel-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-cancel");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo 'progress: starting' >&2
  mkdir -p "$5/.git"
  sleep 1000 &
  pid=$!
  trap 'kill $pid 2>/dev/null; exit 0' TERM INT
  wait $pid
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      const controller = new AbortController();
      let sawProgress = false;
      let lastEvent: CloneEvent | null = null;

      try {
        for await (const event of service.cloneWithProgress(
          {
            repoUrl: sourceRepoPath,
            cloneParentDir,
          },
          controller.signal
        )) {
          lastEvent = event;
          if (!sawProgress && event.type === "progress") {
            sawProgress = true;
            controller.abort();
          }
        }
      } finally {
        process.env.PATH = originalPath;
      }

      expect(sawProgress).toBe(true);
      expect(lastEvent?.type).toBe("error");
      if (lastEvent?.type !== "error") throw new Error("Expected error event");
      expect(lastEvent.error).toContain("Clone cancelled");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-cancel");
      expect(config.loadConfigOrDefault().projects.has(expectedProjectPath)).toBe(false);

      try {
        await fs.stat(expectedProjectPath);
        throw new Error("Expected clone destination to be cleaned up");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        expect(err.code).toBe("ENOENT");
      }
    });

    it("cleans up temp clone directories when consumer stops iterating after abort", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-stop");
      const cloneParentDir = path.join(tempDir, "stop-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-stop");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo 'progress: starting' >&2
  mkdir -p "$5/.git"
  sleep 1000 &
  pid=$!
  trap 'kill $pid 2>/dev/null; exit 0' TERM INT
  wait $pid
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      const controller = new AbortController();

      try {
        for await (const event of service.cloneWithProgress(
          {
            repoUrl: sourceRepoPath,
            cloneParentDir,
          },
          controller.signal
        )) {
          if (event.type === "progress") {
            controller.abort();
            break;
          }
        }
      } finally {
        process.env.PATH = originalPath;
      }

      const cloneEntries = await fs
        .readdir(cloneParentDir)
        .catch((error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? [] : Promise.reject(error)
        );

      expect(
        cloneEntries.filter((entry) => entry.startsWith("source-repo-stop.mux-clone-"))
      ).toEqual([]);
      expect(cloneEntries).not.toContain("source-repo-stop");
    });

    it("does not delete destination created concurrently during clone failure cleanup", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-race");
      const cloneParentDir = path.join(tempDir, "race-clones");
      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-race");
      const concurrentMarkerPath = path.join(expectedProjectPath, "keep.txt");
      const fakeBinDir = path.join(tempDir, "fake-bin-race");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalConcurrentDestPath = process.env.CONCURRENT_DEST_PATH;
      const originalConcurrentMarkerPath = process.env.CONCURRENT_MARKER_PATH;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  mkdir -p "$CONCURRENT_DEST_PATH"
  printf 'keep\n' > "$CONCURRENT_MARKER_PATH"
  exit 1
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.CONCURRENT_DEST_PATH = expectedProjectPath;
      process.env.CONCURRENT_MARKER_PATH = concurrentMarkerPath;

      try {
        const events: CloneEvent[] = [];
        for await (const event of service.cloneWithProgress({
          repoUrl: sourceRepoPath,
          cloneParentDir,
        })) {
          events.push(event);
        }

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.error).toContain("Clone failed");

        const destinationStat = await fs.stat(expectedProjectPath);
        expect(destinationStat.isDirectory()).toBe(true);
        expect((await fs.readFile(concurrentMarkerPath, "utf-8")).trim()).toBe("keep");

        const cloneParentEntries = await fs.readdir(cloneParentDir);
        const tempCloneEntries = cloneParentEntries.filter((entry) =>
          entry.startsWith("source-repo-race.mux-clone-")
        );
        expect(tempCloneEntries).toEqual([]);
      } finally {
        process.env.PATH = originalPath;
        if (originalConcurrentDestPath === undefined) {
          delete process.env.CONCURRENT_DEST_PATH;
        } else {
          process.env.CONCURRENT_DEST_PATH = originalConcurrentDestPath;
        }
        if (originalConcurrentMarkerPath === undefined) {
          delete process.env.CONCURRENT_MARKER_PATH;
        } else {
          process.env.CONCURRENT_MARKER_PATH = originalConcurrentMarkerPath;
        }
      }
    });
  });

  describe("cloneWithProgress SSH askpass", () => {
    async function collectCloneEvents(
      projectService: ProjectService,
      repoUrl: string,
      cloneParentDir: string
    ): Promise<CloneEvent[]> {
      const events: CloneEvent[] = [];
      for await (const event of projectService.cloneWithProgress({ repoUrl, cloneParentDir })) {
        events.push(event);
      }
      return events;
    }

    async function readLoggedEnv(logPath: string): Promise<Record<string, string>> {
      const envContent = await fs.readFile(logPath, "utf-8");
      return Object.fromEntries(
        envContent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("="))
          .map((line) => {
            const separatorIndex = line.indexOf("=");
            return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
          })
      );
    }

    async function writeFakeGitCloneEnvLoggingShim(
      fakeGitPath: string,
      options: { failIfSshAskpassIsSet: boolean }
    ): Promise<void> {
      const sshAskpassGuard = options.failIfSshAskpassIsSet
        ? `
  if [ -n "$SSH_ASKPASS" ]; then
    echo "Unexpected SSH_ASKPASS for non-SSH clone" >&2
    exit 128
  fi`
        : "";

      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"${sshAskpassGuard}
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);
    }

    async function cloneAndCaptureAskpassEnv(options: {
      testCaseId: string;
      repoUrl: string;
      failIfSshAskpassIsSet: boolean;
    }): Promise<Record<string, string>> {
      const cloneParentDir = path.join(tempDir, `${options.testCaseId}-clone-parent`);
      const fakeBinDir = path.join(tempDir, `fake-bin-${options.testCaseId}`);
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, `fake-git-${options.testCaseId}-env.log`);

      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeGitCloneEnvLoggingShim(fakeGitPath, {
        failIfSshAskpassIsSet: options.failIfSshAskpassIsSet,
      });

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const onRequest = (request: SshPromptRequest) => {
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      try {
        return await withEnv(
          {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
            HOME: tempDir,
            SSH_AUTH_SOCK: path.join(tempDir, "fake-ssh-agent.sock"),
            FAKE_GIT_ENV_LOG: fakeGitEnvLogPath,
          },
          async () => {
            const events = await collectCloneEvents(
              sshCloneService,
              options.repoUrl,
              cloneParentDir
            );
            const successEvent = events.find((event) => event.type === "success");
            expect(successEvent?.type).toBe("success");

            return await readLoggedEnv(fakeGitEnvLogPath);
          }
        );
      } finally {
        sshPromptService.off("request", onRequest);
        release();
      }
    }

    it("SSH clone invokes askpass for host-key prompt and succeeds when accepted", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-accept");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-accept");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, "fake-git-ssh-host-key-accept-env.log");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
      const originalFakeGitEnvLogPath = process.env.FAKE_GIT_ENV_LOG;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");
      process.env.FAKE_GIT_ENV_LOG = fakeGitEnvLogPath;

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        const promptRequest = capturedRequests[0];
        expect(promptRequest?.kind).toBe("host-key");
        if (promptRequest?.kind !== "host-key") throw new Error("Expected host-key prompt request");
        expect(promptRequest.prompt).toContain("continue connecting");

        const env = await readLoggedEnv(fakeGitEnvLogPath);
        expect(env.SSH_ASKPASS).toContain("mux-askpass");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
        if (originalFakeGitEnvLogPath === undefined) {
          delete process.env.FAKE_GIT_ENV_LOG;
        } else {
          process.env.FAKE_GIT_ENV_LOG = originalFakeGitEnvLogPath;
        }
      }
    });

    it("coalesces concurrent host-key prompts for the same SSH endpoint", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-dedupe");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-dedupe");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        setTimeout(() => {
          sshPromptService.respond(request.requestId, "yes");
        }, 200);
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const [eventsA, eventsB] = await Promise.all([
          collectCloneEvents(sshCloneService, "github.com:org/repo-a.git", cloneParentDir),
          collectCloneEvents(sshCloneService, "github.com:org/repo-b.git", cloneParentDir),
        ]);

        expect(eventsA.some((event) => event.type === "success")).toBe(true);
        expect(eventsB.some((event) => event.type === "success")).toBe(true);

        const hostKeyRequests = capturedRequests.filter((request) => request.kind === "host-key");
        expect(hostKeyRequests).toHaveLength(1);
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("SSH clone yields ssh_host_key_rejected when host-key prompt is rejected", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-reject");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-reject");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "no");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_host_key_rejected");
        expect(terminalEvent.error).toContain("Host key verification failed");

        expect(capturedRequests[0]?.kind).toBe("host-key");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("SSH clone yields ssh_prompt_timeout when host-key prompt expires", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-timeout");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-timeout");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(50);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-timeout.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_prompt_timeout");
      } finally {
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("keeps ambiguous SSH transport failures as clone_failed", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-ambiguous-failure");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-ambiguous-failure");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo "Connection closed by remote host" >&2
  exit 128
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-ambiguous.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("clone_failed");
        expect(terminalEvent.error).toContain("Connection closed by remote host");
      } finally {
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("SSH clone yields ssh_credential_cancelled when credential prompt is cancelled", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-credential-cancel");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-credential-cancel");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Enter passphrase for key '/home/user/.ssh/id_ed25519':")
  if [ -z "$RESPONSE" ]; then
    echo "Permission denied, please try again." >&2
    echo "git@github.com: Permission denied (publickey,password)." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-credential-cancel.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_credential_cancelled");
        expect(terminalEvent.error).toContain("Permission denied");

        expect(capturedRequests[0]?.kind).toBe("credential");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("clone failures include the last three meaningful stderr lines", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "clone-stderr-summary");
      const fakeBinDir = path.join(tempDir, "fake-bin-clone-stderr-summary");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo "remote: Resolving deltas: 100% (1/1)" >&2
  echo "fatal: Could not read from remote repository." >&2
  echo "Please make sure you have the correct access rights" >&2
  echo "and the repository exists." >&2
  exit 128
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      try {
        const events = await collectCloneEvents(
          service,
          "https://github.com/org/repo-summary.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("clone_failed");
        expect(terminalEvent.error).toBe(
          [
            "fatal: Could not read from remote repository.",
            "Please make sure you have the correct access rights",
            "and the repository exists.",
          ].join("\n")
        );
        expect(terminalEvent.error).toContain("\n");
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("SSH clone invokes askpass for credential prompt and succeeds", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-credential");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-credential");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Enter passphrase for key '/home/user/.ssh/id_ed25519':")
  if [ -z "$RESPONSE" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "test-passphrase");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        const promptRequest = capturedRequests[0];
        expect(promptRequest?.kind).toBe("credential");
        if (promptRequest?.kind !== "credential")
          throw new Error("Expected credential prompt request");
        expect(promptRequest.prompt).toContain("Enter passphrase");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("HTTPS clone does not set SSH askpass env vars", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "https-no-askpass");
      const fakeBinDir = path.join(tempDir, "fake-bin-https-no-askpass");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, "fake-git-https-no-askpass-env.log");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
      const originalFakeGitEnvLogPath = process.env.FAKE_GIT_ENV_LOG;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"
  if [ -n "$SSH_ASKPASS" ]; then
    echo "Unexpected SSH_ASKPASS for HTTPS clone" >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      let sawPromptRequest = false;
      const onRequest = (request: SshPromptRequest) => {
        sawPromptRequest = true;
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");
      process.env.FAKE_GIT_ENV_LOG = fakeGitEnvLogPath;

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "https://github.com/testuser/testrepo.git",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        expect(sawPromptRequest).toBe(false);

        const env = await readLoggedEnv(fakeGitEnvLogPath);
        expect(env.SSH_ASKPASS).toBe("");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
        if (originalFakeGitEnvLogPath === undefined) {
          delete process.env.FAKE_GIT_ENV_LOG;
        } else {
          process.env.FAKE_GIT_ENV_LOG = originalFakeGitEnvLogPath;
        }
      }
    });

    const askpassTransportCases = [
      {
        name: "sets SSH askpass env for ssh:// clone URL",
        testCaseId: "ssh-transport-ssh-scheme",
        repoUrl: "ssh://github.com/testuser/testrepo.git",
        expectAskpass: true,
      },
      {
        name: "sets SSH askpass env for git+ssh:// clone URL",
        testCaseId: "ssh-transport-git-plus-ssh",
        repoUrl: "git+ssh://github.com/testuser/testrepo.git",
        expectAskpass: true,
      },
      {
        name: "sets SSH askpass env for ssh+git:// clone URL",
        testCaseId: "ssh-transport-ssh-plus-git",
        repoUrl: "ssh+git://github.com/testuser/testrepo.git",
        expectAskpass: true,
      },
      {
        name: "does not set SSH askpass env for git:// clone URL",
        testCaseId: "ssh-transport-git-scheme",
        repoUrl: "git://github.com/testuser/testrepo.git",
        expectAskpass: false,
      },
    ];

    for (const testCase of askpassTransportCases) {
      it(testCase.name, async () => {
        if (process.platform === "win32") {
          // This test relies on a POSIX shell shim named "git" in PATH.
          return;
        }

        const env = await cloneAndCaptureAskpassEnv({
          testCaseId: testCase.testCaseId,
          repoUrl: testCase.repoUrl,
          failIfSshAskpassIsSet: !testCase.expectAskpass,
        });

        if (testCase.expectAskpass) {
          expect(env.SSH_ASKPASS).not.toBe("");
          expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
        } else {
          expect(env.SSH_ASKPASS).toBe("");
          expect(env.SSH_ASKPASS_REQUIRE).toBe("");
        }
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      });
    }
  });

  describe("beginShutdown", () => {
    it("refuses new project mutations once teardown starts", async () => {
      const projectPath = path.join(tempDir, "late-project");
      await fs.mkdir(projectPath);
      service.beginShutdown();

      const outcomes = await Promise.allSettled([
        service.create(projectPath),
        service.gitInit(projectPath),
        service.remove(projectPath),
        service.cloneWithProgress({ repoUrl: "https://example.invalid/repo.git" }).next(),
      ]);
      expect(
        outcomes.map((outcome) =>
          outcome.status === "rejected" ? String(outcome.reason) : "fulfilled"
        )
      ).toEqual(Array<string>(4).fill("Error: Server is shutting down"));
      expect(service.getMutationCount()).toBe(0);
    });
  });

  describe("gitInit", () => {
    it("initializes git repo in non-git directory with initial commit", async () => {
      const testDir = path.join(tempDir, "new-project");
      await fs.mkdir(testDir);

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(true);

      // Verify .git directory was created
      const gitDir = path.join(testDir, ".git");
      const stat = await fs.stat(gitDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify a branch exists (main) after the initial commit
      const branchResult = await service.listBranches(testDir);
      expect(branchResult.branches).toContain("main");
      expect(branchResult.recommendedTrunk).toBe("main");
    });

    it("succeeds for unborn git repo (git init but no commits)", async () => {
      const testDir = path.join(tempDir, "unborn-git");
      await fs.mkdir(testDir);

      // Create an unborn repo (git init without commits)
      execSync("git init -b main", { cwd: testDir, stdio: "ignore" });

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(true);

      // Verify branch exists after the commit
      const branchResult = await service.listBranches(testDir);
      expect(branchResult.branches).toContain("main");
    });

    it("returns error for git repo with existing commits", async () => {
      const testDir = path.join(tempDir, "existing-git");
      await fs.mkdir(testDir);

      // Create a repo with a commit
      execSync("git init -b main", { cwd: testDir, stdio: "ignore" });
      execSync('git -c user.name="test" -c user.email="test@test" commit --allow-empty -m "test"', {
        cwd: testDir,
        stdio: "ignore",
      });

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("already a git repository");
    });

    it("returns error for empty project path", async () => {
      const result = await service.gitInit("");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("required");
    });

    it("returns error for non-existent directory", async () => {
      const result = await service.gitInit("/non-existent-path-12345");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("does not exist");
    });
  });

  describe("getFileCompletions", () => {
    it("works for subdirectories inside a parent git repository", async () => {
      const repoPath = await createLocalGitRepository(tempDir, "repo-with-sub-project");
      const subProjectPath = path.join(repoPath, "packages", "api");
      await fs.mkdir(subProjectPath, { recursive: true });
      await fs.writeFile(path.join(subProjectPath, "service.ts"), "export {};\n", "utf-8");

      const result = await service.getFileCompletions(subProjectPath, "service");

      expect(result.paths).toContain("service.ts");
    });
  });

  describe("project settings mutations", () => {
    it("propagates parent trust to MCP state", async () => {
      const parentPath = path.join(tempDir, "project");
      const childPath = path.join(parentPath, "packages", "api");
      await config.editConfig((current) => {
        current.projects.set(parentPath, { workspaces: [] });
        current.projects.set(childPath, { workspaces: [], parentProjectPath: parentPath });
        return current;
      });
      const updates: Array<Array<{ projectPath: string; trusted: boolean }>> = [];
      service.setMcpServerManager({
        applyProjectTrust: (value) => updates.push(value),
        forgetProjectTrust: () => undefined,
      });

      await service.setTrust(`${parentPath}/`, true);

      expect(config.loadConfigOrDefault().projects.get(parentPath)?.trusted).toBe(true);
      expect(updates).toEqual([
        [
          { projectPath: parentPath, trusted: true },
          { projectPath: childPath, trusted: true },
        ],
      ]);
    });

    it("validates, writes, and clears code workspace sync paths", async () => {
      const projectPath = path.join(tempDir, "project");
      await fs.mkdir(projectPath, { recursive: true });
      await config.editConfig((current) => {
        current.projects.set(projectPath, { workspaces: [] });
        return current;
      });

      let invalid: unknown;
      try {
        await service.setCodeWorkspaceSyncPath(projectPath, "notes.txt");
      } catch (error) {
        invalid = error;
      }
      expect(invalid).toBeInstanceOf(ORPCError);
      expect((invalid as Error).message).toContain(".code-workspace");

      await service.setCodeWorkspaceSyncPath(projectPath, "  proj.code-workspace  ");
      const workspaceFile = path.join(projectPath, "proj.code-workspace");
      expect(config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath).toBe(
        "proj.code-workspace"
      );
      expect(JSON.parse(await fs.readFile(workspaceFile, "utf-8"))).toEqual({
        folders: [{ path: projectPath }],
      });

      await service.setCodeWorkspaceSyncPath(projectPath, null);
      expect(
        config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath
      ).toBeUndefined();
      expect((await fs.stat(workspaceFile)).isFile()).toBe(true);
    });

    it("rolls back code workspace paths when explicit sync fails", async () => {
      const projectPath = path.join(tempDir, "project");
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(path.join(projectPath, "broken.code-workspace"), "{ not valid jsonc");
      await config.editConfig((current) => {
        current.projects.set(projectPath, { workspaces: [] });
        return current;
      });

      let thrown: unknown;
      try {
        await service.setCodeWorkspaceSyncPath(projectPath, "broken.code-workspace");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ORPCError);
      expect((thrown as Error).message).toContain("not valid JSONC");
      expect(
        config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath
      ).toBeUndefined();
    });
  });

  describe("assignWorkspaceToSubProject", () => {
    it("syncs both code workspace files after reassignment", async () => {
      const parentPath = path.join(tempDir, "project");
      const subProjectA = path.join(parentPath, "packages", "a");
      const subProjectB = path.join(parentPath, "packages", "b");
      const worktreePath = path.join(config.srcDir, "project", "feat-1");
      await Promise.all([
        fs.mkdir(subProjectA, { recursive: true }),
        fs.mkdir(subProjectB, { recursive: true }),
        fs.mkdir(worktreePath, { recursive: true }),
      ]);
      await config.editConfig((current) => {
        current.projects.set(parentPath, {
          workspaces: [
            {
              path: worktreePath,
              id: "aaaaaaaaaa",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
              subProjectPath: subProjectA,
            },
          ],
        });
        current.projects.set(subProjectA, {
          workspaces: [],
          parentProjectPath: parentPath,
          codeWorkspaceSyncPath: "a.code-workspace",
        });
        current.projects.set(subProjectB, {
          workspaces: [],
          parentProjectPath: parentPath,
          codeWorkspaceSyncPath: "b.code-workspace",
        });
        return current;
      });
      const fileA = path.join(subProjectA, "a.code-workspace");
      const fileB = path.join(subProjectB, "b.code-workspace");
      await fs.writeFile(fileA, JSON.stringify({ folders: [{ path: worktreePath }] }));
      let refreshed = "";
      service.setWorkspaceMetadataRefresher({
        refreshAndEmitMetadata: (workspaceId) => {
          refreshed = workspaceId;
          return Promise.resolve();
        },
      });

      const result = await service.assignWorkspaceToSubProjectAndSync(
        parentPath,
        "aaaaaaaaaa",
        subProjectB
      );

      const foldersOf = async (file: string) =>
        (JSON.parse(await fs.readFile(file, "utf-8")) as { folders: Array<{ path: string }> })
          .folders;
      expect(result.success).toBe(true);
      expect(refreshed).toBe("aaaaaaaaaa");
      expect((await foldersOf(fileA)).map((folder) => folder.path)).not.toContain(worktreePath);
      expect((await foldersOf(fileB)).map((folder) => folder.path)).toContain(worktreePath);
    });

    it("accepts either parent or sub-project path as the owner selector", async () => {
      const parentPath = "/fake/project";
      const subProjectPath = "/fake/project/packages/api";
      const workspaceId = "workspace-1";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(parentPath, {
        workspaces: [{ id: workspaceId, path: path.join(tempDir, "workspace-1") }],
      });
      cfg.projects.set(subProjectPath, {
        parentProjectPath: parentPath,
        workspaces: [],
      });
      await config.editConfig(() => cfg);

      const result = await service.assignWorkspaceToSubProject(
        subProjectPath,
        workspaceId,
        subProjectPath
      );

      expect(result.success).toBe(true);
      const afterAssign = config.loadConfigOrDefault();
      expect(afterAssign.projects.get(parentPath)?.workspaces[0]?.subProjectPath).toBe(
        subProjectPath
      );

      const clearResult = await service.assignWorkspaceToSubProject(
        subProjectPath,
        workspaceId,
        null
      );

      expect(clearResult.success).toBe(true);
      const afterClear = config.loadConfigOrDefault();
      expect(afterClear.projects.get(parentPath)?.workspaces[0]?.subProjectPath).toBeUndefined();
    });

    it("rejects target sub-projects from a different parent", async () => {
      const parentPath = "/fake/project";
      const otherSubProjectPath = "/other/project/packages/web";
      const workspaceId = "workspace-1";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(parentPath, {
        workspaces: [{ id: workspaceId, path: path.join(tempDir, "workspace-1") }],
      });
      cfg.projects.set(otherSubProjectPath, {
        parentProjectPath: "/other/project",
        workspaces: [],
      });
      await config.editConfig(() => cfg);

      const result = await service.assignWorkspaceToSubProject(
        parentPath,
        workspaceId,
        otherSubProjectPath
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("Sub-project not found under parent");
    });

    // Regression (PR #3694 Codex P2): the sub-project is validated on the snapshot
    // read; if it is removed while the edit is queued, the transform must not persist
    // the stale pointer (send/runtime paths use subProjectPath as the execution root).
    it("rejects when the sub-project is removed while the edit is queued", async () => {
      const parentPath = "/fake/project";
      const subProjectPath = "/fake/project/packages/api";
      const workspaceId = "workspace-1";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(parentPath, {
        workspaces: [{ id: workspaceId, path: path.join(tempDir, "workspace-1") }],
      });
      cfg.projects.set(subProjectPath, {
        parentProjectPath: parentPath,
        workspaces: [],
      });
      await config.editConfig(() => cfg);

      // Deterministic interleaving: queue the sub-project removal so the assign call's
      // synchronous snapshot read still sees it while its queued transform does not.
      const removeSubProject = config.editConfig((fresh) => {
        fresh.projects.delete(subProjectPath);
        return fresh;
      });
      const result = await service.assignWorkspaceToSubProject(
        parentPath,
        workspaceId,
        subProjectPath
      );
      await removeSubProject;

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("Sub-project not found under parent");
      const workspace = config.loadConfigOrDefault().projects.get(parentPath)?.workspaces[0];
      expect(workspace?.subProjectPath).toBeUndefined();
    });
  });

  describe("list", () => {
    it("excludes archived workspaces while preserving live ones", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          { id: "live-1", path: "/fake/project/ws-live" },
          { id: "archived-1", path: "/fake/project/ws-archived", archivedAt: ARCHIVED_AT },
          {
            id: "unarchived-1",
            path: "/fake/project/ws-unarchived",
            archivedAt: ARCHIVED_AT,
            unarchivedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });
      await config.editConfig(() => cfg);

      const listed = service.list();

      const project = listed.find(([listedPath]) => listedPath === projectPath)?.[1];
      expect(project).toBeDefined();
      expect(project?.workspaces.map((workspace) => workspace.id)).toEqual([
        "live-1",
        "unarchived-1",
      ]);
    });

    it("keeps live multi-project workspaces in their bucket", async () => {
      const projectPath = "/fake/project";
      const otherProjectPath = "/fake/other";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            id: "multi-live",
            path: "/fake/project/ws-multi",
            projects: [
              { projectPath, projectName: "project" },
              { projectPath: otherProjectPath, projectName: "other" },
            ],
          },
          {
            id: "multi-archived",
            path: "/fake/project/ws-multi-archived",
            archivedAt: ARCHIVED_AT,
            projects: [
              { projectPath, projectName: "project" },
              { projectPath: otherProjectPath, projectName: "other" },
            ],
          },
        ],
      });
      await config.editConfig(() => cfg);

      const listed = service.list();

      const project = listed.find(([listedPath]) => listedPath === projectPath)?.[1];
      expect(project?.workspaces.map((workspace) => workspace.id)).toEqual(["multi-live"]);
      expect(project?.workspaces[0]?.projects?.map((ref) => ref.projectPath)).toEqual([
        projectPath,
        otherProjectPath,
      ]);
    });

    it("does not modify archived entries in persisted config", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          { id: "live-1", path: "/fake/project/ws-live" },
          { id: "archived-1", path: "/fake/project/ws-archived", archivedAt: ARCHIVED_AT },
        ],
      });
      await config.editConfig(() => cfg);

      service.list();

      // The projection must not leak into the in-memory or persisted config:
      // archived entries stay on disk for older builds (downgrade safety).
      const after = config.loadConfigOrDefault();
      expect(after.projects.get(projectPath)?.workspaces.map((workspace) => workspace.id)).toEqual([
        "live-1",
        "archived-1",
      ]);
    });
  });

  describe("getRemovalBlockers", () => {
    it("counts own-bucket and cross-project blockers without mutating config", async () => {
      const projectPath = "/fake/project";
      const otherPath = "/fake/other";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          // Missing checkout directory on purpose: unlike remove(), the
          // preflight must not prune stale entries (or delete the project).
          { id: "stale-live", path: path.join(tempDir, "missing-checkout") },
          { id: "own-archived", path: path.join(tempDir, "archived"), archivedAt: ARCHIVED_AT },
        ],
      });
      cfg.projects.set(otherPath, {
        workspaces: [
          {
            id: "cross-ref",
            path: path.join(tempDir, "cross"),
            projects: [
              { projectPath: otherPath, projectName: "other" },
              { projectPath, projectName: "project" },
            ],
          },
        ],
      });
      await config.editConfig(() => cfg);

      const counts = service.getRemovalBlockers(projectPath);

      expect(counts).toEqual({ activeCount: 2, archivedCount: 1 });
      const after = config.loadConfigOrDefault();
      expect(after.projects.get(projectPath)?.workspaces.map((ws) => ws.id)).toEqual([
        "stale-live",
        "own-archived",
      ]);
    });

    it("returns zero counts for unknown projects", () => {
      expect(service.getRemovalBlockers("/no/such/project")).toEqual({
        activeCount: 0,
        archivedCount: 0,
      });
    });
  });

  describe("remove", () => {
    it("force removal fails fast on cross-project references without deleting owned workspaces", async () => {
      const projectPath = "/fake/project";
      const otherPath = "/fake/other";
      const ownWorkspaceDir = path.join(tempDir, "owned-workspace");
      await fs.mkdir(ownWorkspaceDir, { recursive: true });
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ id: "owned-1", path: ownWorkspaceDir }],
      });
      cfg.projects.set(otherPath, {
        workspaces: [
          {
            id: "cross-ref",
            path: path.join(tempDir, "cross"),
            projects: [
              { projectPath: otherPath, projectName: "other" },
              { projectPath, projectName: "project" },
            ],
          },
        ],
      });
      await config.editConfig(() => cfg);

      const removedWorkspaceIds: string[] = [];
      service.setWorkspaceService({
        remove: async (workspaceId) => {
          removedWorkspaceIds.push(workspaceId);
          await config.removeWorkspace(workspaceId);
          return Ok(undefined);
        },
      });

      const result = await service.remove(projectPath, true);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toEqual({
        type: "workspace_blockers",
        activeCount: 2,
        archivedCount: 0,
      });
      // The cascade must not have started: a partial deletion would destroy
      // owned workspaces and still leave the project registered.
      expect(removedWorkspaceIds).toEqual([]);
      const after = config.loadConfigOrDefault();
      expect(after.projects.get(projectPath)?.workspaces.map((ws) => ws.id)).toEqual(["owned-1"]);
    });

    it("removes project with no workspaces", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces: [] });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(true);
      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(false);
    });

    it("returns project_not_found for unknown project", async () => {
      const result = await service.remove("/no/such/project");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("project_not_found");
    });

    it("waits for a settings-backup restore holding the registration lock", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces: [] });
      await config.editConfig(() => cfg);

      // A restore writing this project's matched memory holds the lock; the removal must
      // land after it, never between its registration read and its memory write.
      const held = Promise.withResolvers<void>();
      const lockAcquired = Promise.withResolvers<void>();
      const holding = withProjectRegistrationLock(tempDir, async () => {
        lockAcquired.resolve();
        await held.promise;
      });
      await lockAcquired.promise;

      let removed = false;
      const removing = service.remove(projectPath).then((result) => {
        removed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(removed).toBe(false);
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(true);

      held.resolve();
      await holding;
      expect((await removing).success).toBe(true);
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
    });

    it("lets a backup import register and write inside one registration window", async () => {
      const existing = "/fake/existing";
      const target = path.join(tempDir, "imported");
      await fs.mkdir(target);
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(existing, { workspaces: [] });
      await config.editConfig(() => cfg);

      const inside = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      let removed = false;
      const window = service.withRegistrationLock(async ({ create }) => {
        // create() registers within the window rather than deadlocking on its own lock.
        const created = await create(target);
        expect(created.success).toBe(true);
        inside.resolve();
        await proceed.promise;
        // A removal requested meanwhile has not landed: the registry is stable until the
        // window closes, so an import writing memory here cannot lose its project.
        expect(removed).toBe(false);
        expect(config.loadConfigOrDefault().projects.has(existing)).toBe(true);
      });
      await inside.promise;
      const removing = service.remove(existing).then((result) => {
        removed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      proceed.resolve();
      await window;

      expect((await removing).success).toBe(true);
      expect(config.loadConfigOrDefault().projects.has(existing)).toBe(false);
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(true);
    });

    it("gates every registration path through Config, not just create and remove", async () => {
      // setTrust registers a missing entry as a side effect — one of several writers that
      // add a project key without going through create(). Config.editConfig serializes it
      // with the restore window all the same — as it does every edit, since each one saves
      // the whole config.
      const unregistered = "/fake/trusted-later";
      const held = Promise.withResolvers<void>();
      const lockAcquired = Promise.withResolvers<void>();
      const holding = withProjectRegistrationLock(tempDir, async () => {
        lockAcquired.resolve();
        await held.promise;
      });
      await lockAcquired.promise;

      let trusted = false;
      const trusting = service.setTrust(unregistered, true).then(() => {
        trusted = true;
      });
      let valueSaved = false;
      const valueEdit = config
        .editConfig((cfg) => ({ ...cfg, llmDebugLogs: true }))
        .then(() => {
          valueSaved = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(trusted).toBe(false);
      expect(valueSaved).toBe(false);
      expect(config.loadConfigOrDefault().projects.has(unregistered)).toBe(false);

      held.resolve();
      await holding;
      await Promise.all([trusting, valueEdit]);
      expect(config.loadConfigOrDefault().projects.get(unregistered)?.trusted).toBe(true);
      expect(config.loadConfigOrDefault().llmDebugLogs).toBe(true);
    });

    it("waits for another process's registration hold and re-reads config under it", async () => {
      // The cross-process leg, as `mux trust` or a restore in another process would hold it.
      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      let transformRuns = 0;
      let registered = false;
      const registering = config
        .editConfig((cfg) => {
          transformRuns += 1;
          cfg.projects.set("/fake/from-this-process", { workspaces: [] });
          return cfg;
        })
        .then(() => {
          registered = true;
        });
      // A window in this process waits too.
      let windowRan = false;
      const window = withProjectRegistrationLock(tempDir, () => {
        windowRan = true;
        return Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(registered).toBe(false);
      expect(windowRan).toBe(false);

      // The other process registers a project while ours waits: our transform must run on
      // those bytes — once, under the lock — or a pre-wait snapshot would clobber that
      // registration.
      const otherConfig = new Config(tempDir);
      await otherConfig.editConfig(
        (cfg) => {
          cfg.projects.set("/fake/from-other-process", { workspaces: [] });
          return cfg;
        },
        { withinRegistrationLock: otherProcess }
      );
      await otherProcess[Symbol.asyncDispose]();
      await registering;
      await window;

      expect(transformRuns).toBe(1);
      const projects = config.loadConfigOrDefault().projects;
      expect(projects.has("/fake/from-this-process")).toBe(true);
      expect(projects.has("/fake/from-other-process")).toBe(true);
    });

    it("validates a new project without holding the registration lock", async () => {
      const target = path.join(tempDir, "validated-unlocked");
      await fs.mkdir(target);
      // Another process holds the lock throughout the validation. Every config save waits
      // for that lock, so a create that took it around its stats, realpath, and git probes
      // would hold up unrelated saves for as long as a slow filesystem keeps it busy.
      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      // The path resolution is the last filesystem probe of the validation; the registering
      // write is the first thing the lock covers.
      const realpath = spyOn(fs, "realpath");
      const editConfig = spyOn(config, "editConfig");
      const creating = service.create(target);
      const deadline = Date.now() + 2_000;
      while (realpath.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Validated while the lock is still held elsewhere, but not yet registering.
      expect(realpath).toHaveBeenCalledWith(target);
      expect(editConfig).not.toHaveBeenCalled();
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(false);

      await otherProcess[Symbol.asyncDispose]();
      expect((await creating).success).toBe(true);
      expect(editConfig).toHaveBeenCalledTimes(1);
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(true);
      realpath.mockRestore();
    });

    it("does not git-initialize a directory an import registers while it waits for the lock", async () => {
      const target = path.join(tempDir, "imported-empty");
      await fs.mkdir(target);
      const initializeGit = spyOn(
        service as unknown as { initializeGitRepository: () => unknown },
        "initializeGitRepository"
      );
      // A restore window registers the same empty directory as an import target while an
      // initGit create of it waits for the lock. The create must fail as a duplicate without
      // having run `git init` there: initializing and rolling back inside a directory that
      // is the import's by then would touch the imported project's checkout.
      const windowOpen = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const window = service.withRegistrationLock(async ({ create }) => {
        windowOpen.resolve();
        await proceed.promise;
        expect((await create(target)).success).toBe(true);
      });
      await windowOpen.promise;
      const creating = service.create(target, { initGit: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      proceed.resolve();
      await window;

      const result = await creating;
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBe("Project already exists");
      expect(initializeGit).not.toHaveBeenCalled();
      expect(await fs.lstat(path.join(target, ".git")).catch(() => null)).toBeNull();
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(true);
    });

    it("rolls back git init when the registering write finds the hold reclaimed", async () => {
      const target = path.join(tempDir, "reclaimed-init");
      await fs.mkdir(target);
      const result = await service.withRegistrationLock(async ({ create }) => {
        // Displaced while git init runs, by a holder whose pid is dead: the registering
        // write's ownership check refuses, and the rollback's own hold can reclaim the lock.
        await fs.writeFile(projectRegistrationLockFilePath(tempDir), "9999999:reclaimed", "utf-8");
        return create(target, { initGit: true });
      });
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("no longer owned");
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(false);
      // Left behind, the .git would fail every retry on the non-empty-directory check.
      expect(await fs.lstat(path.join(target, ".git")).catch(() => null)).toBeNull();
      expect((await service.create(target, { initGit: true })).success).toBe(true);
    });

    it("keeps a directory registered under another spelling while its hold was reclaimed", async () => {
      const target = path.join(tempDir, "reclaimed-target");
      const alias = path.join(tempDir, "reclaimed-alias");
      await fs.symlink(target, alias, "dir");
      const result = await service.withRegistrationLock(async ({ create }) => {
        await fs.writeFile(projectRegistrationLockFilePath(tempDir), "9999999:reclaimed", "utf-8");
        // The process that reclaimed the lock registered the same directory through a
        // symlink: neither spelling create() knows is a registry key.
        await new Config(tempDir).editConfig((cfg) => {
          cfg.projects.set(alias, { workspaces: [] });
          return cfg;
        }, REGISTER_CONCURRENTLY);
        return create(target, { initGit: true });
      });
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain("no longer owned");
      // The directory this request created is the winner's checkout now and stays; only the
      // .git the request initialized into it goes.
      expect((await fs.stat(target)).isDirectory()).toBe(true);
      expect(await fs.lstat(path.join(target, ".git")).catch(() => null)).toBeNull();
      expect(config.loadConfigOrDefault().projects.has(alias)).toBe(true);
    });

    it("refuses to register once another process has displaced the registration lock", async () => {
      const target = path.join(tempDir, "displaced");
      await fs.mkdir(target);
      // A holder frozen past the lease is judged stale and displaced; when it resumes, its
      // registration must not commit as if it still held the lock.
      const result = await service.withRegistrationLock(async ({ create }) => {
        await fs.writeFile(projectRegistrationLockFilePath(tempDir), "another holder", "utf-8");
        return create(target);
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("no longer owned");
      expect(config.loadConfigOrDefault().projects.has(target)).toBe(false);
    });

    it("covers an edit that leaves the project set alone against another process's write", async () => {
      // Every edit persists the whole config from the bytes it read, so a registration made
      // by another process between this edit's read and its write would be dropped unless
      // the edit, too, runs under the cross-process lock.
      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      let saved = false;
      const saving = config
        .editConfig((cfg) => ({ ...cfg, llmDebugLogs: true }))
        .then(() => {
          saved = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(saved).toBe(false);

      const otherConfig = new Config(tempDir);
      await otherConfig.editConfig(
        (cfg) => {
          cfg.projects.set("/fake/registered-meanwhile", { workspaces: [] });
          return cfg;
        },
        { withinRegistrationLock: otherProcess }
      );
      await otherProcess[Symbol.asyncDispose]();
      await saving;

      const after = config.loadConfigOrDefault();
      expect(after.llmDebugLogs).toBe(true);
      expect(after.projects.has("/fake/registered-meanwhile")).toBe(true);
    });

    it("does not let a value-only edit slip past a foreign hold while another edit waits for it", async () => {
      // A registration edit waiting for another process's hold must not make a concurrent
      // value-only edit believe this process holds the lock: both have to wait, or the
      // value-only edit's whole-config save drops what the other process registers.
      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      let registered = false;
      const registering = config
        .editConfig((cfg) => {
          cfg.projects.set("/fake/waiting-registration", { workspaces: [] });
          return cfg;
        })
        .then(() => {
          registered = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(registered).toBe(false);
      let valueSaved = false;
      const valueEdit = config
        .editConfig((cfg) => ({ ...cfg, llmDebugLogs: true }))
        .then(() => {
          valueSaved = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(valueSaved).toBe(false);

      const otherConfig = new Config(tempDir);
      await otherConfig.editConfig(
        (cfg) => {
          cfg.projects.set("/fake/from-other-process", { workspaces: [] });
          return cfg;
        },
        { withinRegistrationLock: otherProcess }
      );
      await otherProcess[Symbol.asyncDispose]();
      await Promise.all([registering, valueEdit]);

      const after = config.loadConfigOrDefault();
      expect(after.llmDebugLogs).toBe(true);
      expect(after.projects.has("/fake/waiting-registration")).toBe(true);
      expect(after.projects.has("/fake/from-other-process")).toBe(true);
    });

    it("returns an Err when the registration lock cannot be taken", async () => {
      const target = path.join(tempDir, "locked-out");
      await fs.mkdir(target);
      // The lock directory is a file, so the cross-process leg cannot be created.
      await fs.mkdir(path.dirname(projectRegistrationLockFilePath(tempDir)), { recursive: true });
      await fs.rm(path.dirname(projectRegistrationLockFilePath(tempDir)), { recursive: true });
      await fs.writeFile(path.dirname(projectRegistrationLockFilePath(tempDir)), "file", "utf-8");

      const result = await service.create(target);
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("Failed to create project");
    });

    it("forgets retained trust for cascade-removed sub-projects", async () => {
      const parentPath = "/fake/parent";
      const childPath = "/fake/parent/packages/api";
      const forgottenPaths: string[] = [];
      service.setMcpServerManager({
        applyProjectTrust: () => undefined,
        forgetProjectTrust: (projectPath) => forgottenPaths.push(projectPath),
      });
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(parentPath, { workspaces: [] });
      cfg.projects.set(childPath, { workspaces: [], parentProjectPath: parentPath });
      await config.editConfig(() => cfg);

      expect((await service.remove(parentPath)).success).toBe(true);
      expect(forgottenPaths.sort()).toEqual([parentPath, childPath]);
      const after = config.loadConfigOrDefault();
      expect(after.projects.has(parentPath)).toBe(false);
      expect(after.projects.has(childPath)).toBe(false);
    });

    const forceRemovalCases = [
      {
        name: "with force=true cascade-deletes archived workspaces then removes project",
        workspaces: [
          { id: "archived-workspace-1", dir: "archived-workspace-one", archived: true },
          { id: "archived-workspace-2", dir: "archived-workspace-two", archived: true },
        ],
        expectedRemovedIds: ["archived-workspace-1", "archived-workspace-2"],
      },
      {
        name: "with force=true deletes active and archived workspaces then removes project",
        workspaces: [
          { id: "active-workspace-1", dir: "active-workspace" },
          { id: "archived-workspace-1", dir: "archived-workspace", archived: true },
        ],
        expectedRemovedIds: ["active-workspace-1", "archived-workspace-1"],
      },
      {
        name: "force=true cascade-deletes active workspaces then removes project",
        workspaces: [
          { id: "active-workspace-1", dir: "active-workspace-one" },
          { id: "active-workspace-2", dir: "active-workspace-two" },
        ],
        expectedRemovedIds: ["active-workspace-1", "active-workspace-2"],
      },
      {
        name: "force=true cascade-deletes mixed active + archived workspaces then removes project",
        workspaces: [
          { id: "mixed-active-workspace-id", dir: "mixed-active-workspace" },
          {
            id: "mixed-archived-workspace-id",
            dir: "mixed-archived-workspace",
            archived: true,
          },
        ],
        expectedRemovedIds: ["mixed-active-workspace-id", "mixed-archived-workspace-id"],
      },
    ];

    for (const testCase of forceRemovalCases) {
      it(testCase.name, async () => {
        const projectPath = "/fake/project";
        const workspaces = testCase.workspaces.map((workspace) => ({
          id: workspace.id,
          path: path.join(tempDir, workspace.dir),
          ...(workspace.archived ? { archivedAt: ARCHIVED_AT } : {}),
        }));
        await Promise.all(
          workspaces.map((workspace) => fs.mkdir(workspace.path, { recursive: true }))
        );

        const cfg = config.loadConfigOrDefault();
        cfg.projects.set(projectPath, { workspaces });
        await config.editConfig(() => cfg);

        const removedWorkspaceIds: string[] = [];
        service.setWorkspaceService({
          remove: async (workspaceId) => {
            removedWorkspaceIds.push(workspaceId);
            await config.removeWorkspace(workspaceId);
            return Ok(undefined);
          },
        });

        const result = await service.remove(projectPath, true);

        expect(result.success).toBe(true);
        expect(removedWorkspaceIds.sort()).toEqual(testCase.expectedRemovedIds);
        const after = config.loadConfigOrDefault();
        expect(after.projects.has(projectPath)).toBe(false);
      });
    }

    it("with force=true removes nested sub-agents before their parents", async () => {
      const projectPath = "/fake/project";
      const rootWorkspaceId = "root-workspace";
      const stickyTaskId = "sticky-task";
      const nestedTaskId = "nested-task";
      const workspaces = [
        { id: rootWorkspaceId, path: path.join(tempDir, "root-workspace") },
        {
          id: stickyTaskId,
          path: path.join(tempDir, "sticky-task"),
          parentWorkspaceId: rootWorkspaceId,
          taskSticky: true,
        },
        {
          id: nestedTaskId,
          path: path.join(tempDir, "nested-task"),
          parentWorkspaceId: stickyTaskId,
        },
      ];
      await Promise.all(
        workspaces.map((workspace) => fs.mkdir(workspace.path, { recursive: true }))
      );

      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces });
      await config.editConfig(() => cfg);

      const removedWorkspaceIds: string[] = [];
      service.setWorkspaceService({
        remove: async (workspaceId) => {
          removedWorkspaceIds.push(workspaceId);
          await config.removeWorkspace(workspaceId);
          return Ok(undefined);
        },
      });

      const result = await service.remove(projectPath, true);

      expect(result.success).toBe(true);
      expect(removedWorkspaceIds).toEqual([nestedTaskId, stickyTaskId, rootWorkspaceId]);
      expect(config.loadConfigOrDefault().projects.has(projectPath)).toBe(false);
    });

    it("with force=true resolves metadata IDs for workspaces missing config IDs", async () => {
      const archivedWorkspaceDir = path.join(tempDir, "legacy-archived-workspace");
      await fs.mkdir(archivedWorkspaceDir, { recursive: true });

      const projectPath = "/fake/project";
      const migratedWorkspaceId = "migrated-archived-workspace-id";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: archivedWorkspaceDir, archivedAt: ARCHIVED_AT }],
      });
      await config.editConfig(() => cfg);

      const legacyWorkspaceId = config.generateLegacyId(projectPath, archivedWorkspaceDir);
      const metadataPath = path.join(
        path.join(config.sessionsDir, legacyWorkspaceId),
        "metadata.json"
      );
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      await fs.writeFile(
        metadataPath,
        JSON.stringify({ id: migratedWorkspaceId, name: "legacy-archived-workspace" }),
        "utf-8"
      );

      const removedWorkspaceIds: string[] = [];
      service.setWorkspaceService({
        remove: async (workspaceId) => {
          removedWorkspaceIds.push(workspaceId);
          await config.removeWorkspace(workspaceId);
          return Ok(undefined);
        },
      });

      const result = await service.remove(projectPath, true);

      expect(result.success).toBe(true);
      expect(removedWorkspaceIds).toEqual([migratedWorkspaceId]);

      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(false);
    });

    it("with force=false (default) still returns workspace_blockers when archived exist", async () => {
      const archivedWorkspaceDir = path.join(tempDir, "default-force-flag-test");
      await fs.mkdir(archivedWorkspaceDir, { recursive: true });

      const archivedAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ id: "archived-workspace-1", path: archivedWorkspaceDir, archivedAt }],
      });
      await config.editConfig(() => cfg);

      let removeCallCount = 0;
      service.setWorkspaceService({
        remove: () => {
          removeCallCount += 1;
          return Promise.resolve(Ok(undefined));
        },
      });

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");
      if (result.error.type !== "workspace_blockers") {
        throw new Error("Expected workspace blockers error");
      }
      expect(result.error.activeCount).toBe(0);
      expect(result.error.archivedCount).toBe(1);
      expect(removeCallCount).toBe(0);
    });

    it("blocks removal when workspaces still exist on disk", async () => {
      const wsDir = path.join(tempDir, "real-workspace");
      await fs.mkdir(wsDir, { recursive: true });

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: wsDir }],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");
    });

    it("blocks removal when active multi-project workspaces reference the project", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces: [] });
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            path: "/fake/multi-workspace",
            projects: [
              { projectPath, projectName: "project" },
              { projectPath: "/fake/other", projectName: "other" },
            ],
          },
        ],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");
      if (result.error.type !== "workspace_blockers")
        throw new Error("Expected workspace blockers");
      expect(result.error.activeCount).toBe(1);
      expect(result.error.archivedCount).toBe(0);

      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(true);
    });

    it("blocks removal when multi-project workspaces in other project buckets reference the project", async () => {
      const projectPath = "/fake/project";
      const otherProjectPath = "/fake/other-project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces: [] });
      cfg.projects.set(otherProjectPath, {
        workspaces: [
          {
            path: "/fake/other-project-multi-workspace",
            projects: [
              { projectPath: `${projectPath}/`, projectName: "project" },
              { projectPath: otherProjectPath, projectName: "other" },
            ],
          },
        ],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");
      if (result.error.type !== "workspace_blockers") {
        throw new Error("Expected workspace blockers");
      }
      expect(result.error.activeCount).toBe(1);
      expect(result.error.archivedCount).toBe(0);

      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(true);
    });

    it("auto-prunes stale workspace entries and removes project", async () => {
      const stalePath = path.join(tempDir, "deleted-workspace-dir");
      // Do NOT create the directory — simulating manual deletion

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: stalePath }],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(true);
      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(false);
    });

    it("preserves remote runtime workspace entries even if path is not local", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: "/remote/host/workspace",
            runtimeConfig: { type: "ssh", host: "remote", srcBaseDir: "/remote" },
          },
        ],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      // Should block on the SSH workspace, not prune it
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");

      // Workspace entry should still be in config
      const after = config.loadConfigOrDefault();
      const project = after.projects.get(projectPath);
      expect(project).toBeDefined();
      expect(project!.workspaces).toHaveLength(1);
    });

    it("prunes stale entries but blocks on remaining real workspaces", async () => {
      const stalePath = path.join(tempDir, "gone-workspace");
      const realDir = path.join(tempDir, "still-here");
      await fs.mkdir(realDir, { recursive: true });

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: stalePath }, { path: realDir }],
      });
      await config.editConfig(() => cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");

      // Stale entry should have been pruned from config even though removal was blocked
      const after = config.loadConfigOrDefault();
      const project = after.projects.get(projectPath);
      expect(project).toBeDefined();
      expect(project!.workspaces).toHaveLength(1);
      expect(project!.workspaces[0]?.path).toBe(realDir);
    });
  });
});
