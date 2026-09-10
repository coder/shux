import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackupRepoCache,
  BackupCacheSafetyError,
  BackupNonFastForwardError,
  BackupOriginMismatchError,
  MAX_NETWORK_GIT_OUTPUT_BYTES,
  type BackupRepoCacheOptions,
} from "./gitRepo";
import { BackupRemoteUnreachableError } from "./credentials";
import { BackupInvalidPayloadError, MAX_BACKUP_PATH_DEPTH } from "./payload";
import { commitAll, runGit, writeFixtureFile } from "./testHelpers";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
  await fs.chmod(filePath, 0o755);
}

async function writeManagedFile(
  repo: BackupRepoCache,
  name: string,
  content: string
): Promise<void> {
  const filePath = path.join(repo.cachePath, "mux", name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function findHardLinkedFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findHardLinkedFiles(entryPath)));
    } else if (entry.isFile() && (await fs.lstat(entryPath)).nlink > 1) {
      found.push(entryPath);
    }
  }
  return found;
}

describe("BackupRepoCache", () => {
  let tempDir: string;
  let originPath: string;
  let cacheRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-git-"));
    originPath = path.join(tempDir, "origin.git");
    cacheRoot = path.join(tempDir, "cache");
    await runGit(["init", "--bare", "--initial-branch=main", originPath]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createRepo(
    managedPath = "mux",
    materializationLimits?: BackupRepoCacheOptions["materializationLimits"]
  ): BackupRepoCache {
    return new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath,
      materializationLimits,
    });
  }

  function createRepoWithObjectBudget(maxCacheObjectKib: number): BackupRepoCache {
    return new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      maxCacheObjectKib,
    });
  }

  async function seedManagedFiles(files: Readonly<Record<string, string>>): Promise<string> {
    const seed = path.join(tempDir, "seed");
    await runGit(["clone", originPath, seed]);
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(seed, "mux", relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    }
    await commitAll(seed, "seed");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    return seed;
  }

  async function addOutsideTree(seed: string, directoryCount: number): Promise<void> {
    for (let index = 0; index < directoryCount; index++) {
      await writeFixtureFile(seed, `outside/directory-${index}/file.txt`, `${index}\n`);
    }
  }

  async function createSha256Origin(name: string, seedContent?: string): Promise<string> {
    const origin = path.join(tempDir, `${name}.git`);
    await runGit(["init", "--bare", "--object-format=sha256", "--initial-branch=main", origin]);
    if (seedContent == null) return origin;

    const seed = path.join(tempDir, `${name}-seed`);
    await runGit(["clone", origin, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), seedContent, "utf-8");
    await commitAll(seed, "seed");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    return origin;
  }

  it("uses filtered transport for a local repository", async () => {
    const seed = path.join(tempDir, "local-clone-seed");
    await runGit(["clone", originPath, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await fs.writeFile(path.join(seed, "unrelated.txt"), "outside managed path\n", "utf-8");
    await commitAll(seed, "seed");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);

    const repo = createRepo();
    await repo.ensureCache();

    expect(await findHardLinkedFiles(path.join(repo.cachePath, ".git"))).toEqual([]);
    const localObjects = async () =>
      await runGit(["-C", repo.cachePath, "cat-file", "--batch-all-objects", "--batch-check"]);
    expect(await localObjects()).not.toContain(" blob ");

    await fs.writeFile(path.join(seed, "mux", "second.md"), "second managed blob\n", "utf-8");
    await fs.writeFile(path.join(seed, "unrelated-2.txt"), "second unrelated blob\n", "utf-8");
    await commitAll(seed, "next");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    const pushedCommit = await runGit(["-C", seed, "rev-parse", "HEAD"]);

    expect(await repo.fetch()).toBe(pushedCommit);
    expect(await findHardLinkedFiles(path.join(repo.cachePath, ".git"))).toEqual([]);
    expect(await localObjects()).not.toContain(" blob ");
  });

  it("does not transfer 200 commits outside the managed path into the cache", async () => {
    const seed = path.join(tempDir, "history-seed");
    await runGit(["clone", originPath, seed]);
    await runGit(["-C", seed, "config", "gc.auto", "0"]);
    await runGit(["-C", seed, "config", "maintenance.auto", "false"]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.mkdir(path.join(seed, "outside"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await fs.writeFile(path.join(seed, "outside", "history.txt"), "0\n", "utf-8");
    await commitAll(seed, "seed");
    for (let index = 1; index <= 200; index++) {
      await fs.writeFile(path.join(seed, "outside", "history.txt"), `${index}\n`, "utf-8");
      await commitAll(seed, `outside history ${index}`);
    }
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);

    const repo = createRepo();
    await repo.ensureCache();

    const objectTypes = (
      await runGit([
        "-C",
        repo.cachePath,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objecttype)",
      ])
    ).split("\n");
    expect(objectTypes.filter((type) => type === "commit")).toHaveLength(1);
    expect(objectTypes.filter((type) => type === "tree")).toHaveLength(3);
    expect(await runGit(["-C", repo.cachePath, "rev-list", "--count", "origin/main"])).toBe("1");
  });

  it("discards a clone whose object store exceeds the cache budget", async () => {
    const seed = path.join(tempDir, "large-tree-seed");
    await runGit(["clone", originPath, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await addOutsideTree(seed, 128);
    await commitAll(seed, "large tip tree");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    const repo = createRepoWithObjectBudget(1);

    const caught = await repo.ensureCache().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("object data");
    expect(await pathExists(repo.cachePath)).toBe(false);
  });

  it("discards an oversized fetched cache before the next materialization", async () => {
    const seed = await seedManagedFiles({ "AGENTS.md": "managed\n" });
    const repo = createRepoWithObjectBudget(1);
    await repo.ensureCache();
    const marker = path.join(repo.cachePath, ".git", "mux-clone-marker");
    await fs.writeFile(marker, "original\n", "utf-8");
    await addOutsideTree(seed, 128);
    await commitAll(seed, "large tip tree");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("object data");
    expect(await pathExists(repo.cachePath)).toBe(false);

    expect(await createRepo().materialize()).not.toBeNull();
    expect(await pathExists(marker)).toBe(false);
  });

  it("pushes after shallow materialization and a later depth-one fetch", async () => {
    const seed = await seedManagedFiles({ "AGENTS.md": "first\n" });
    const repo = createRepo();

    await repo.materialize();
    expect(await pathExists(path.join(repo.cachePath, ".git", "shallow"))).toBe(true);
    await writeManagedFile(repo, "AGENTS.md", "second\n");
    const firstPush = await repo.stageAndCommit("Back up settings");
    if (firstPush === null) throw new Error("Expected the first shallow commit");
    expect(await repo.push()).toBe(firstPush);

    await runGit(["-C", seed, "fetch", "origin", "main"]);
    await runGit(["-C", seed, "reset", "--hard", "origin/main"]);
    await fs.writeFile(path.join(seed, "mux", "remote.md"), "remote\n", "utf-8");
    await commitAll(seed, "remote update");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    const remoteCommit = await runGit(["-C", seed, "rev-parse", "HEAD"]);

    expect(await repo.materialize()).toBe(remoteCommit);
    expect(await runGit(["-C", repo.cachePath, "rev-list", "--count", "origin/main"])).toBe("1");
    await writeManagedFile(repo, "AGENTS.md", "third\n");
    const secondPush = await repo.stageAndCommit("Back up settings again");
    if (secondPush === null) throw new Error("Expected the second shallow commit");
    expect(await repo.push()).toBe(secondPush);
    expect(await runGit(["--git-dir", originPath, "show", "main:mux/AGENTS.md"])).toBe("third");
  });

  it("caps diagnostic output from network Git commands", async () => {
    if (process.platform === "win32") return;
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await seedManagedFiles({ "AGENTS.md": "seed\n" });
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "fetch" ]; then
    head -c "$SPEW_BYTES" /dev/zero | tr '\\0' x >&2
    exec sleep 30
  fi
done
exec "$REAL_GIT" "$@"
`
    );
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      timeoutMs: 2000,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        SPEW_BYTES: String(MAX_NETWORK_GIT_OUTPUT_BYTES + 1),
      },
    });
    await repo.ensureCache();

    const caught = await repo.fetch().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupRemoteUnreachableError);
    expect((caught as Error).message).toBe(
      "Could not reach the backup repository. Check the URL and your network connection."
    );
    const cause = (caught as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain(
      `more than ${MAX_NETWORK_GIT_OUTPUT_BYTES} bytes of output`
    );
  });

  it("refuses a remote tree path above the backup depth limit before checkout", async () => {
    const relativePath = [
      "skills",
      ...Array.from({ length: MAX_BACKUP_PATH_DEPTH - 1 }, (_, index) => `level-${index}`),
      "file.md",
    ].join("/");
    await seedManagedFiles({ [relativePath]: "deep" });
    const repo = createRepo();

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain(
      `more than ${MAX_BACKUP_PATH_DEPTH} path components`
    );
    expect(await pathExists(path.join(repo.cachePath, "mux"))).toBe(false);
  });

  it("refuses a remote tree above the materialization file-count limit before checkout", async () => {
    await seedManagedFiles({
      "one.txt": "one",
      "two.txt": "two",
      "three.txt": "three",
    });
    const repo = createRepo("mux", { maxFileCount: 2 });

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("more than 2 files");
    expect(await pathExists(path.join(repo.cachePath, "mux"))).toBe(false);
  });

  it("refuses an oversized remote blob before checkout", async () => {
    await seedManagedFiles({ "oversized.txt": "12345" });
    const repo = createRepo("mux", { maxFileBytes: 4 });

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("larger than the per-file limit");
    expect(await pathExists(path.join(repo.cachePath, "mux"))).toBe(false);
  });

  it("refuses a remote tree above the materialization total-byte limit", async () => {
    await seedManagedFiles({
      "one.txt": "123",
      "two.txt": "456",
    });
    const repo = createRepo("mux", { maxFileBytes: 4, maxTotalBytes: 5 });

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("larger than the total limit");
    expect(await pathExists(path.join(repo.cachePath, "mux"))).toBe(false);
  });

  it("refuses gitlinks under the managed path before checkout", async () => {
    const seed = await seedManagedFiles({ "one.txt": "one" });
    const linkedCommit = await runGit(["-C", seed, "rev-parse", "HEAD"]);
    await runGit([
      "-C",
      seed,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${linkedCommit},mux/submodule`,
    ]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=mux@example.com",
      "-c",
      "user.name=Xum",
      "commit",
      "-m",
      "add gitlink",
    ]);
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    const repo = createRepo();

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect((caught as Error).message).toContain("gitlink 'mux/submodule'");
    expect(await pathExists(path.join(repo.cachePath, "mux"))).toBe(false);
  });

  it("keeps the cache when remote materialization limits are exceeded", async () => {
    await seedManagedFiles({
      "one.txt": "one",
      "two.txt": "two",
    });
    const repo = createRepo("mux", { maxFileCount: 1 });
    await repo.ensureCache();
    const marker = path.join(repo.cachePath, ".git", "mux-clone-marker");
    await fs.writeFile(marker, "original\n", "utf-8");

    const caught = await repo.materialize().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(BackupInvalidPayloadError);
    expect(await fs.readFile(marker, "utf-8")).toBe("original\n");
  });

  it("materializes a remote tree under the default backup limits", async () => {
    await seedManagedFiles({
      "AGENTS.md": "instructions\n",
      "skills/demo/SKILL.md": "skill\n",
    });
    const repo = createRepo();

    expect(await repo.materialize()).not.toBeNull();
    expect(await fs.readFile(path.join(repo.cachePath, "mux", "AGENTS.md"), "utf-8")).toBe(
      "instructions\n"
    );
    expect(
      await fs.readFile(path.join(repo.cachePath, "mux", "skills", "demo", "SKILL.md"), "utf-8")
    ).toBe("skill\n");
  });

  it("recovers malformed cache config without losing SHA-256 object format", async () => {
    const shaOrigin = await createSha256Origin("sha256-origin", "sha256 managed\n");
    const repo = new BackupRepoCache({
      repoUrl: shaOrigin,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    await repo.ensureCache();
    await fs.writeFile(path.join(repo.cachePath, ".git", "config"), "[core\n", "utf-8");

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await runGit(["-C", repo.cachePath, "config", "--get", "extensions.objectformat"])).toBe(
      "sha256"
    );
    expect(await fs.readFile(path.join(repo.cachePath, "mux", "AGENTS.md"), "utf-8")).toBe(
      "sha256 managed\n"
    );
  });

  it("recovers a cache left holding stale git lock files", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    const gitDir = path.join(repo.cachePath, ".git");
    await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
    const staleLocks = [
      path.join(gitDir, "index.lock"),
      path.join(gitDir, "config.lock"),
      path.join(gitDir, "refs", "heads", "main.lock"),
    ];
    for (const lock of staleLocks) await fs.writeFile(lock, "", "utf-8");

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "after lock recovery\n");

    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit after the stale locks were cleared");
    expect(await repo.push()).toBe(commit);
    for (const lock of staleLocks) expect(await pathExists(lock)).toBe(false);
  });

  const incompleteCacheCases: Array<{
    name: string;
    damage: (cachePath: string) => Promise<void>;
  }> = [
    {
      name: "rebuilds a cache missing .git/HEAD",
      damage: (cachePath) => fs.rm(path.join(cachePath, ".git", "HEAD")),
    },
    {
      name: "rebuilds a cache whose .git/HEAD is a directory",
      damage: async (cachePath) => {
        await fs.rm(path.join(cachePath, ".git", "HEAD"));
        await fs.mkdir(path.join(cachePath, ".git", "HEAD"));
      },
    },
    {
      name: "recovers when only the cache directory itself was created",
      damage: async (cachePath) => {
        await fs.rm(cachePath, { recursive: true, force: true });
        await fs.mkdir(cachePath, { recursive: true });
      },
    },
  ];

  for (const testCase of incompleteCacheCases) {
    it(testCase.name, async () => {
      const repo = createRepo();
      await repo.ensureCache();
      await repo.fetch();
      await repo.resetHardToRemote();
      await writeManagedFile(repo, "AGENTS.md", "before the interruption\n");
      const seeded = await repo.stageAndCommit("Back up settings");
      if (seeded === null) throw new Error("Expected the seed commit");
      await repo.push();

      await testCase.damage(repo.cachePath);

      const reopened = createRepo();
      await reopened.ensureCache();
      await reopened.fetch();
      await reopened.resetHardToRemote();

      expect(await fs.readFile(path.join(reopened.cachePath, "mux", "AGENTS.md"), "utf-8")).toBe(
        "before the interruption\n"
      );
    });
  }

  it("leaves no half-deleted cache behind when a discard is interrupted", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "before the interruption\n");
    // Config the sanitize pass cannot parse, so ensureCache discards the cache.
    await fs.writeFile(path.join(repo.cachePath, ".git", "config"), "[core\n", "utf-8");

    const rename = fs.rename;
    // Interrupt immediately after the rename, the point where a partial recursive delete would
    // otherwise leave the cache directory populated but without a `.git`.
    const interrupted = new Error("killed mid-discard");
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from as string, to as string);
      throw interrupted;
    });
    const caught = await repo.ensureCache().catch((error: unknown) => error);
    spy.mockRestore();
    expect(caught).toBe(interrupted);

    // The cache path must be absent rather than a populated directory with no `.git`.
    expect(await pathExists(repo.cachePath)).toBe(false);

    const reopened = createRepo();
    await reopened.ensureCache();
    await reopened.fetch();
    await reopened.resetHardToRemote();
    expect(await pathExists(path.join(reopened.cachePath, ".git"))).toBe(true);
  });

  it("reaps a cache left by an interrupted discard", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const tombstone = `${repo.cachePath}.discarded-1234-abcd`;
    await fs.rename(repo.cachePath, tombstone);

    await createRepo().ensureCache();

    expect(await pathExists(tombstone)).toBe(false);
    expect(await pathExists(path.join(repo.cachePath, ".git"))).toBe(true);
  });

  it("rebuilds a cache whose git metadata is corrupt rather than structurally wrong", async () => {
    // Each of these keeps the entries and types `isCompleteGitDirectory` checks and fails a
    // later git command instead. A ref naming nothing even survives `git status` and fails at
    // reset, and a `config` directory fails inside `ensureCache`, before any remote command.
    const corruptions: Array<(gitDir: string) => Promise<void>> = [
      (gitDir) => fs.writeFile(path.join(gitDir, "HEAD"), "", "utf-8"),
      (gitDir) => fs.writeFile(path.join(gitDir, "index"), "DIRC", "utf-8"),
      (gitDir) => fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/\n", "utf-8"),
      async (gitDir) => {
        await fs.rm(path.join(gitDir, "config"));
        await fs.mkdir(path.join(gitDir, "config"));
      },
    ];
    for (const corrupt of corruptions) {
      const seed = createRepo();
      await seed.materialize();
      await writeManagedFile(seed, "AGENTS.md", "backed up\n");
      if ((await seed.stageAndCommit("Back up settings")) !== null) await seed.push();
      await corrupt(path.join(seed.cachePath, ".git"));

      const reopened = createRepo();
      expect(await reopened.materialize()).not.toBeNull();
      expect(await fs.readFile(path.join(reopened.cachePath, "mux", "AGENTS.md"), "utf-8")).toBe(
        "backed up\n"
      );
    }
  });

  it("keeps a healthy cache when the remote is unreachable", async () => {
    const repo = createRepo();
    await repo.materialize();
    // Identifies this exact clone: a discard would replace the cache with a fresh one, and the
    // rebuilt `.git` alone cannot tell the two apart.
    const clonedAt = path.join(repo.cachePath, ".git", "mux-clone-marker");
    await fs.writeFile(clonedAt, "original\n", "utf-8");
    const unreachable = new BackupRemoteUnreachableError(new Error("Could not resolve host"));
    const spy = spyOn(repo, "fetch").mockImplementation(() => Promise.reject(unreachable));

    const caught = await repo.materialize().catch((error: unknown) => error);
    spy.mockRestore();

    // Rebuilding would discard the cache and the retried fetch would still fail, so an outage
    // would cost the whole local copy.
    expect(caught).toBe(unreachable);
    expect(await pathExists(clonedAt)).toBe(true);
  });

  it("keeps the cache when metadata is swapped after it was checked", async () => {
    const repo = createRepo();
    await repo.materialize();
    const clonedAt = path.join(repo.cachePath, ".git", "mux-clone-marker");
    await fs.writeFile(clonedAt, "original\n", "utf-8");
    const outside = path.join(cacheRoot, "outside-target");
    await fs.writeFile(outside, "not mux's\n", "utf-8");
    // The swap lands after ensureCache accepted this cache, so the refusal comes from the
    // recheck inside applySparseCheckout.
    const sparsePath = path.join(repo.cachePath, ".git", "info", "sparse-checkout");
    const spy = spyOn(repo, "fetch").mockImplementation(async () => {
      await fs.rm(sparsePath, { force: true });
      await fs.symlink(outside, sparsePath);
      return null;
    });

    const caught = await repo.materialize().catch((error: unknown) => error);
    spy.mockRestore();

    expect(caught).toBeInstanceOf(BackupCacheSafetyError);
    expect(await pathExists(clonedAt)).toBe(true);
    expect(await fs.readFile(outside, "utf-8")).toBe("not mux's\n");
  });

  it("refuses to discard a cache path that was replaced after it was checked", async () => {
    const repo = createRepo();
    await repo.materialize();
    const foreign = path.join(repo.cachePath, "important.txt");
    // The discard follows a failure, which cannot say what is at the path by then. Swapping the
    // whole cache directory reaches discardCache with content it never validated.
    const spy = spyOn(repo, "fetch").mockImplementation(async () => {
      await fs.rm(repo.cachePath, { recursive: true, force: true });
      await fs.mkdir(repo.cachePath, { recursive: true });
      await fs.writeFile(foreign, "not mux's\n", "utf-8");
      throw new Error("index file corrupt");
    });

    const caught = await repo.materialize().catch((error: unknown) => error);
    spy.mockRestore();

    expect(caught).toBeInstanceOf(BackupCacheSafetyError);
    expect(await fs.readFile(foreign, "utf-8")).toBe("not mux's\n");
  });

  it("refuses a cache path holding content it did not create", async () => {
    const repo = createRepo();
    await fs.mkdir(repo.cachePath, { recursive: true });
    const bystander = path.join(repo.cachePath, "important.txt");
    await fs.writeFile(bystander, "not mux's\n", "utf-8");

    const rejected = await repo.ensureCache().catch((error: unknown) => error);

    expect((rejected as Error).message).toContain("is not a git repository");
    expect(await fs.readFile(bystander, "utf-8")).toBe("not mux's\n");
  });

  const sha256BootstrapCases: Array<{
    name: string;
    originName: string;
    seedContent?: string;
  }> = [
    {
      name: "creates a missing backup branch with the remote's SHA-256 object format",
      originName: "sha256-new-branch",
      seedContent: "existing branch\n",
    },
    {
      name: "creates a first backup in an empty SHA-256 repository",
      originName: "sha256-empty",
    },
  ];

  for (const testCase of sha256BootstrapCases) {
    it(testCase.name, async () => {
      const shaOrigin = await createSha256Origin(testCase.originName, testCase.seedContent);
      const repo = new BackupRepoCache({
        repoUrl: shaOrigin,
        branch: "backup",
        cacheRoot,
        managedPath: "mux",
      });

      await repo.ensureCache();
      expect(await repo.fetch()).toBeNull();
      expect(await repo.resetHardToRemote()).toBeNull();
      await writeManagedFile(repo, "AGENTS.md", "first backup\n");
      const commit = await repo.stageAndCommit("Back up settings");
      if (commit === null) throw new Error("Expected the bootstrap commit");

      expect(commit).toMatch(/^[0-9a-f]{64}$/);
      expect(await repo.push()).toBe(commit);
      expect(await runGit(["--git-dir", shaOrigin, "rev-parse", "refs/heads/backup"])).toBe(commit);
    });
  }

  it("creates a missing SHA-1 branch despite a SHA-256 init default", async () => {
    const seed = path.join(tempDir, "sha1-new-branch-seed");
    await runGit(["clone", originPath, seed]);
    await fs.writeFile(path.join(seed, "existing.txt"), "existing branch\n", "utf-8");
    await commitAll(seed, "seed");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "backup",
      cacheRoot,
      managedPath: "mux",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "init.defaultObjectFormat",
        GIT_CONFIG_VALUE_0: "sha256",
      },
    });

    await repo.ensureCache();
    expect(await repo.fetch()).toBeNull();
    expect(await repo.resetHardToRemote()).toBeNull();
    await writeManagedFile(repo, "AGENTS.md", "first backup\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected the bootstrap commit");

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.push()).toBe(commit);
    expect(await runGit(["--git-dir", originPath, "rev-parse", "refs/heads/backup"])).toBe(commit);
  });

  it("materializes a blob-filtered clone through the credential ladder", async () => {
    const seedPath = path.join(tempDir, "seed");
    await runGit(["clone", originPath, seedPath]);
    await fs.mkdir(path.join(seedPath, "mux"), { recursive: true });
    await fs.writeFile(path.join(seedPath, "mux", "note.md"), "managed content\n", "utf-8");
    await runGit(["-C", seedPath, "add", "."]);
    await runGit([
      "-C",
      seedPath,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-m",
      "seed",
    ]);
    await runGit(["-C", seedPath, "push", "origin", "HEAD:main"]);

    const repo = new BackupRepoCache({
      repoUrl: `file://${originPath}`,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    await repo.ensureCache();
    await repo.fetch();
    // The blob-filtered clone forces pre-checkout validation to fetch the blob.
    const objects = await runGit([
      "-C",
      repo.cachePath,
      "cat-file",
      "--batch-all-objects",
      "--batch-check",
    ]);
    expect(objects).not.toContain(" blob ");

    // A fresh instance has no recorded credential, so this proves materialization used the ladder.
    const reader = new BackupRepoCache({
      repoUrl: `file://${originPath}`,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    expect(await reader.resetHardToRemote()).not.toBeNull();
    expect(reader.credential).toBe("ambient");
    const restored = await fs.readFile(path.join(reader.cachePath, "mux", "note.md"), "utf-8");
    expect(restored).toBe("managed content\n");
  });

  it("bootstraps an empty repo, commits the managed path, and pushes", async () => {
    const repo = createRepo();
    expect((await repo.lsRemote()).branchCommit).toBeNull();

    await repo.ensureCache();
    expect(await repo.fetch()).toBeNull();
    expect(await repo.resetHardToRemote()).toBeNull();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    expect(await repo.porcelainStatus()).toContain("mux/AGENTS.md");

    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected the bootstrap commit");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.push()).toBe(commit);
    expect(await runGit(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
  });

  it("materializes only the managed path and preserves the rest of the branch", async () => {
    // Nothing outside the managed path may reach the filesystem, because a name this
    // platform cannot create (say `linux/CON` on Windows) would fail the checkout before Xum
    // reads its own directory. A scoped commit must still leave that file in the tree.
    const seed = path.join(tempDir, "seed");
    await fs.mkdir(path.join(seed, "outside"), { recursive: true });
    await fs.writeFile(path.join(seed, "outside", "keep.txt"), "outside\n", "utf-8");
    await fs.mkdir(path.join(seed, "mux", "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "skills", "demo", "SKILL.md"), "skill\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "outside content",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "outside"))).toBe(false);
    // A restore reads nested payload files out of this checkout, so the pattern must reach
    // below the managed directory rather than only its direct children.
    expect(await pathExists(path.join(repo.cachePath, "mux/skills/demo/SKILL.md"))).toBe(true);
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    const tracked = await runGit(["--git-dir", originPath, "ls-tree", "-r", "--name-only", "main"]);
    expect(tracked.split("\n")).toContain("outside/keep.txt");
    expect(tracked.split("\n")).toContain("mux/AGENTS.md");
  });

  it("does not report a server-side push denial as remote drift", async () => {
    // A protected branch or policy hook. Telling the user the backup changed would send them to
    // re-read a backup that is not stale, and the push would be refused again.
    const hook = path.join(originPath, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'policy: review required' >&2\nexit 1\n", "utf-8");
    await fs.chmod(hook, 0o755);
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");

    const rejected = await repo.push().then(
      () => null,
      (error: unknown) => error
    );

    expect(rejected).not.toBeInstanceOf(BackupNonFastForwardError);
    expect((rejected as Error | null)?.message).toContain("pre-receive hook declined");
  });

  it("keeps payload bytes verbatim when git is asked to convert line endings", async () => {
    const seed = path.join(tempDir, "crlf-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "line one\nline two\n", "utf-8");
    // The backup repository asking for conversion itself, which outranks any config setting.
    await fs.writeFile(path.join(seed, ".gitattributes"), "* text=auto eol=crlf\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "-c", "core.autocrlf=false", "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "ask for crlf",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // core.autocrlf=true is an ordinary Windows setting. The manifest records a SHA-256 per
    // file and a restore writes what it reads, so any conversion here corrupts both.
    const globalConfig = path.join(tempDir, "converting-gitconfig");
    await fs.writeFile(globalConfig, "[core]\n\tautocrlf = true\n", "utf-8");
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "line one\nline two\n"
    );
  });

  it("keeps payload bytes verbatim when the repository asks for ident expansion", async () => {
    const seed = path.join(tempDir, "ident-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    // $Id$ is what the ident attribute expands at checkout; the manifest hash covers the
    // unexpanded bytes, so expansion makes every later Preview/Restore reject the backup.
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "ident line: $Id$\n", "utf-8");
    await fs.writeFile(path.join(seed, ".gitattributes"), "mux/** ident\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "ask for ident",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "ident line: $Id$\n"
    );
  });

  it("rejects a cache whose config redirects the working tree", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // With this key in place, `clean -fdx -- mux` would delete `mux/` beneath the redirected
    // worktree instead of inside the cache.
    const outside = path.join(tempDir, "outside-worktree");
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    await runGit(["-C", repo.cachePath, "config", "core.worktree", outside]);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("core.worktree");
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("rejects a cache whose config is a symlink and leaves the target unwritten", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const configPath = path.join(repo.cachePath, ".git", "config");
    const target = path.join(tempDir, "victim-config");
    const targetContent = "[core]\n\tbare = false\n";
    await fs.writeFile(target, targetContent, "utf-8");
    await fs.rm(configPath);
    await fs.symlink(target, configPath);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(target, "utf-8")).toBe(targetContent);
  });

  it("drops a cache-local pushInsteadOf rewrite so the push reaches the configured repository", async () => {
    const evil = path.join(tempDir, "evil.git");
    await runGit(["init", "--bare", "--initial-branch=main", evil]);
    const repo = createRepo();
    await repo.ensureCache();
    // Cache-local config is not the user's own git configuration: this rewrite redirects the
    // push while the stored `remote.origin.url` still reads as the configured repository.
    await runGit(["-C", repo.cachePath, "config", `url.${evil}.pushInsteadOf`, originPath]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    expect(await runGit(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
    const evilRefs = await runGit(["--git-dir", evil, "show-ref"]).then(
      (refs) => refs,
      () => "none"
    );
    expect(evilRefs).toBe("none");
  });

  it("does not run hooks planted in the cache", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const marker = path.join(tempDir, "hook-ran");
    const hookPath = path.join(repo.cachePath, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, `#!/bin/sh\ntouch '${marker}'\n`, "utf-8");
    await fs.chmod(hookPath, 0o755);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    // Post-sanitize tamper: the rebuilt config pins hooksPath off too, so drop that pin to
    // prove the per-invocation option protects commands after the config is altered again.
    await runGit(["-C", repo.cachePath, "config", "--unset", "core.hookspath"]);
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    expect(await repo.stageAndCommit("Back up settings")).not.toBeNull();

    expect(await pathExists(marker)).toBe(false);
  });

  it("ignores replace refs when materializing the backup", async () => {
    const seed = path.join(tempDir, "replace-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "note.md"), "original\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "s",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    // A replace ref substitutes another object's bytes at read time without changing any
    // commit hash, so a tampered cache could hand later reads different content than the
    // commit everything else verified.
    const original = await runGit([
      "-C",
      repo.cachePath,
      "rev-parse",
      "refs/remotes/origin/main:mux/note.md",
    ]);
    const evilFile = path.join(tempDir, "evil-content");
    await fs.writeFile(evilFile, "evil\n", "utf-8");
    const evil = await runGit(["-C", repo.cachePath, "hash-object", "-w", evilFile]);
    await runGit(["-C", repo.cachePath, "update-ref", `refs/replace/${original}`, evil]);
    await fs.rm(path.join(repo.cachePath, "mux", "note.md"));

    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux", "note.md"), "utf-8")).toBe(
      "original\n"
    );
  });

  it("removes worktree-scoped config left behind in the cache", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const outside = path.join(tempDir, "outside-worktree");
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    // `git sparse-checkout set` used to enable this extension, and the worktree-scoped file
    // it activates is trusted by git like the main config, including for `core.worktree`.
    await runGit(["-C", repo.cachePath, "config", "extensions.worktreeConfig", "true"]);
    await runGit(["-C", repo.cachePath, "config", "--worktree", "core.worktree", outside]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await repo.cleanWorktree();

    expect(await pathExists(path.join(repo.cachePath, ".git", "config.worktree"))).toBe(false);
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("ignores inherited GIT_DIR and GIT_WORK_TREE instead of operating on their repository", async () => {
    const seed = path.join(tempDir, "env-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "s",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // Xum may be launched from a git hook or alias, where these are exported. Git reads them
    // ahead of `-C`, so without stripping, checkout materializes under the outside worktree
    // and `clean -fdx -- mux` deletes the victim file there.
    const outside = path.join(tempDir, "outside-repo");
    await runGit(["init", "-q", outside]);
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: {
        ...process.env,
        GIT_DIR: path.join(outside, ".git"),
        GIT_WORK_TREE: outside,
      },
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await repo.cleanWorktree();

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "managed\n"
    );
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("ignores environment-supplied git config instead of letting it redirect the push", async () => {
    const evil = path.join(tempDir, "env-evil.git");
    await runGit(["init", "--bare", "--initial-branch=main", evil]);
    // Command-scope config arrives through the environment (git -c exports it to hooks), so
    // the cache config rebuild cannot remove it: only stripping the variables can.
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${evil}.pushInsteadOf`,
        GIT_CONFIG_VALUE_0: originPath,
        GIT_CONFIG_PARAMETERS: `'url.${evil}.pushInsteadOf'='${originPath}'`,
      },
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    expect(await runGit(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
    const evilRefs = await runGit(["--git-dir", evil, "show-ref"]).then(
      (refs) => refs,
      () => "none"
    );
    expect(evilRefs).toBe("none");
  });

  it("preserves valid platform flags and drops malformed values", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const configPath = path.join(repo.cachePath, ".git", "config");
    const retained = [
      ["core.filemode", "false"],
      ["core.logallrefupdates", "true"],
      ["core.ignorecase", "false"],
      ["core.precomposeunicode", "true"],
      ["core.symlinks", "false"],
      ["extensions.partialclone", "origin"],
    ] as const;
    for (const [key, value] of retained) {
      await runGit(["config", "--file", configPath, key, value]);
    }

    await repo.ensureCache();
    for (const [key, value] of retained) {
      expect(await runGit(["config", "--file", configPath, "--get", key])).toBe(value);
    }

    for (const [key] of retained) {
      await runGit(["config", "--file", configPath, key, "garbage"]);
    }
    await runGit(["config", "--file", configPath, "extensions.objectformat", "garbage"]);
    await runGit(["config", "--file", configPath, "core.repositoryformatversion", "garbage"]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await repo.porcelainStatus()).toBe("");
    expect(
      await runGit(["config", "--file", configPath, "--get", "core.repositoryformatversion"])
    ).toBe("1");
    expect(await fs.readFile(configPath, "utf-8")).not.toContain("garbage");
  });

  it("repairs a cache whose config was left claiming the repository is bare", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // An interrupted tool or stray edit; preserved, it fails every worktree command with
    // "this operation must be run in a work tree" until the cache is deleted by hand.
    await runGit(["-C", repo.cachePath, "config", "core.bare", "true"]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await repo.porcelainStatus()).toBe("");
  });

  it("rejects a cache with symlinked git metadata and leaves the target unwritten", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    // A fetch writes the fetched ref record through this link, truncating whatever it names.
    const victim = path.join(tempDir, "victim-fetch-head");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    await fs.rm(path.join(repo.cachePath, ".git", "FETCH_HEAD"), { force: true });
    await fs.symlink(victim, path.join(repo.cachePath, ".git", "FETCH_HEAD"));

    const failure = await repo
      .ensureCache()
      .then(() => repo.fetch())
      .then(
        () => null,
        (error: unknown) => error
      );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
  });

  it("severs hard-linked git metadata before fetch overwrites its outside alias", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    if ((await repo.stageAndCommit("Back up settings")) === null) {
      throw new Error("Expected a commit");
    }
    await repo.push();
    await repo.fetch();

    const victim = path.join(tempDir, "victim-hard-link");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    const fetchHead = path.join(repo.cachePath, ".git", "FETCH_HEAD");
    await fs.rm(fetchHead, { force: true });
    await fs.link(victim, fetchHead);

    await repo.ensureCache();
    await repo.fetch();

    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
    expect((await fs.lstat(fetchHead)).nlink).toBe(1);
  });

  it("migrates hard-linked objects left by older local clones", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    const objectPath = path.join(
      repo.cachePath,
      ".git",
      "objects",
      commit.slice(0, 2),
      commit.slice(2)
    );
    const outsideAlias = path.join(tempDir, "legacy-object-alias");
    await fs.link(objectPath, outsideAlias);
    const objectBytes = await fs.readFile(outsideAlias);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(outsideAlias)).toEqual(objectBytes);
    expect((await fs.lstat(objectPath)).nlink).toBe(1);
  });

  it("rejects symlinked git metadata below the top level of .git", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // Reflogs are appended to on every ref update, through a symlink like any other
    // metadata file, so the rule has to hold for the whole tree rather than only the
    // filenames at the top.
    const victim = path.join(tempDir, "victim-reflog");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    const reflog = path.join(repo.cachePath, ".git", "logs", "HEAD");
    await fs.mkdir(path.dirname(reflog), { recursive: true });
    await fs.rm(reflog, { force: true });
    await fs.symlink(victim, reflog);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
  });

  it("keeps the cache tree traversable by its owner alone", async () => {
    // The tree holds exported payload bytes and unredacted restore snapshots, written with
    // modes that assume nobody else can traverse this far.
    const repo = createRepo();
    const previousUmask = process.umask(0o022);
    try {
      await repo.ensureCache();
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.stat(cacheRoot)).mode & 0o077).toBe(0);
  });

  it("materializes the managed path when the configured value has a trailing separator", async () => {
    const seed = path.join(tempDir, "slash-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "managed content",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // The settings default is `mux/`, and an unnormalized `/mux//*` sparse pattern selects
    // nothing, so the backup reads as absent and a push lands outside the sparse definition.
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux/",
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "mux/AGENTS.md"))).toBe(true);

    await fs.writeFile(path.join(repo.cachePath, "mux", "AGENTS.md"), "updated\n", "utf-8");
    expect(await repo.porcelainStatus()).toContain("mux/AGENTS.md");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();
    expect(await runGit(["--git-dir", originPath, "show", "main:mux/AGENTS.md"])).toBe("updated");
  });

  it("treats a managed path containing glob characters literally", async () => {
    const seed = path.join(tempDir, "glob-seed");
    await fs.mkdir(path.join(seed, "mux[1]"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux[1]", "AGENTS.md"), "managed\n", "utf-8");
    await fs.mkdir(path.join(seed, "mux1"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux1", "other.txt"), "sibling\n", "utf-8");
    await runGit(["-C", seed, "init", "-q"]);
    await runGit(["-C", seed, "add", "-A"]);
    await runGit([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "glob siblings",
    ]);
    await runGit(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux[1]",
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "mux[1]/AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(repo.cachePath, "mux1"))).toBe(false);

    // The worktree-wide clean removes strays anywhere, including glob-confusable
    // siblings; what stays literal is the sparse pattern and the staging pathspec.
    const stray = path.join(repo.cachePath, "mux1", "stray.txt");
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, "untracked\n", "utf-8");
    await repo.cleanWorktree();
    expect(await pathExists(stray)).toBe(false);

    await fs.writeFile(path.join(repo.cachePath, "mux[1]", "AGENTS.md"), "updated\n", "utf-8");
    const commit = await repo.stageAndCommit("Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();
    expect(await runGit(["--git-dir", originPath, "show", `main:mux[1]/AGENTS.md`])).toBe(
      "updated"
    );
  });

  it("anchors relative local repository paths to the cache root's parent", async () => {
    const seed = path.join(tempDir, "relative-origin-seed");
    await runGit(["clone", originPath, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await commitAll(seed, "seed");
    await runGit(["-C", seed, "push", "origin", "HEAD:main"]);

    const stableRoot = path.join(tempDir, "mux-root");
    const relativeOrigin = path.relative(stableRoot, originPath);
    const repo = new BackupRepoCache({
      repoUrl: relativeOrigin,
      branch: "main",
      cacheRoot: path.join(stableRoot, "backup-cache"),
      managedPath: "mux",
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    const storedOrigin = await runGit([
      "-C",
      repo.cachePath,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(path.isAbsolute(storedOrigin)).toBe(true);
    expect(await fs.realpath(storedOrigin)).toBe(await fs.realpath(originPath));

    for (const compatibleOrigin of [relativeOrigin, originPath]) {
      await runGit(["-C", repo.cachePath, "remote", "set-url", "origin", compatibleOrigin]);
      await repo.ensureCache();
      expect(await runGit(["-C", repo.cachePath, "config", "--get", "remote.origin.url"])).toBe(
        storedOrigin
      );
    }

    const other = path.join(tempDir, "relative-other.git");
    await runGit(["init", "--bare", other]);
    await runGit(["-C", repo.cachePath, "remote", "set-url", "origin", other]);
    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(BackupOriginMismatchError);
  });

  it("reuses the cache and rejects an origin mismatch", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await runGit([
      "-C",
      repo.cachePath,
      "remote",
      "set-url",
      "origin",
      path.join(tempDir, "other.git"),
    ]);

    try {
      await repo.ensureCache();
      throw new Error("Expected origin mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupOriginMismatchError);
    }
  });

  it("refuses a cache whose .git is a gitfile pointing at another repository", async () => {
    const outside = path.join(tempDir, "outside");
    await runGit(["init", outside]);
    await runGit(["-C", outside, "config", "core.autocrlf", "input"]);

    const repo = createRepo();
    await fs.mkdir(repo.cachePath, { recursive: true });
    // Not a symlink: a plain file `.git` redirects every `git -C` command the same way.
    await fs.writeFile(
      path.join(repo.cachePath, ".git"),
      `gitdir: ${path.join(outside, ".git")}\n`,
      "utf-8"
    );

    try {
      await repo.ensureCache();
      throw new Error("Expected the gitfile cache to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("not a directory");
    }
    // The outside repository's config must not have taken the cache's writes.
    expect(await runGit(["-C", outside, "config", "--get", "core.autocrlf"])).toBe("input");
  });

  it("refuses a cache whose .git carries a commondir indirection", async () => {
    const outside = path.join(tempDir, "outside");
    await runGit(["init", outside]);
    await runGit(["-C", outside, "config", "core.autocrlf", "input"]);

    const repo = createRepo();
    await repo.ensureCache();
    await fs.writeFile(
      path.join(repo.cachePath, ".git", "commondir"),
      `${path.join(outside, ".git")}\n`,
      "utf-8"
    );

    try {
      await repo.ensureCache();
      throw new Error("Expected the commondir cache to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("redirects to another repository");
    }
    expect(await runGit(["-C", outside, "config", "--get", "core.autocrlf"])).toBe("input");
  });

  it("accepts a cache whose url the user's insteadOf rules rewrite", async () => {
    const repo = createRepo();
    await repo.ensureCache();

    // A user-level rewrite: `remote get-url` reports the rewritten spelling while the
    // stored value stays what Xum wrote, so an effective-url comparison rejected every
    // operation for this user.
    const globalConfig = path.join(tempDir, "gitconfig");
    await fs.writeFile(
      globalConfig,
      `[url "file://${originPath}"]\n\tinsteadOf = ${originPath}\n`,
      "utf-8"
    );
    const rewritten = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: { GIT_CONFIG_GLOBAL: globalConfig },
    });

    await rewritten.ensureCache();
    await rewritten.fetch();
  });

  it("reports cache status", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "first\n");
    const commit = await repo.stageAndCommit("Initial backup");
    if (commit === null) throw new Error("Expected the initial commit");

    await writeManagedFile(repo, "AGENTS.md", "second\n");
    expect(await repo.porcelainStatus()).toContain("mux/AGENTS.md");
  });

  it("reclaims exports left under a previously configured managed path", async () => {
    await seedManagedFiles({ "AGENTS.md": "seed\n" });
    const oldPathRepo = createRepo("old-mux");
    await oldPathRepo.materialize();
    const leftover = path.join(oldPathRepo.cachePath, "old-mux", "stale-export.md");
    await fs.mkdir(path.dirname(leftover), { recursive: true });
    await fs.writeFile(leftover, "abandoned preview export\n", "utf-8");

    const marker = path.join(oldPathRepo.cachePath, ".git", "reuse-marker");
    await fs.writeFile(marker, "x", "utf-8");

    // Same repository and branch, so the cache is reused under the new subdirectory.
    await createRepo("mux").materialize();

    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(leftover)).toBe(false);
  });

  it("refuses managed paths that are not a real subdirectory", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    for (const unsafe of [".", "./", "..", "mux/../..", "/mux", "mux\\..\\.."]) {
      try {
        await createRepo(unsafe).stageAndCommit("unsafe");
        throw new Error(`Expected '${unsafe}' to be rejected`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("safe relative path");
      }
    }
  });

  it("rejects a push when the remote branch moved after reset", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "initial\n");
    const initialCommit = await repo.stageAndCommit("Initial backup");
    if (initialCommit === null) throw new Error("Expected the initial commit");
    await repo.push();

    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "local update\n");
    const localCommit = await repo.stageAndCommit("Local update");
    if (localCommit === null) throw new Error("Expected the local update commit");

    const otherPath = path.join(tempDir, "other");
    await runGit(["clone", originPath, otherPath]);
    await fs.writeFile(path.join(otherPath, "remote.txt"), "remote update\n", "utf-8");
    await runGit(["-C", otherPath, "add", "remote.txt"]);
    await runGit([
      "-C",
      otherPath,
      "-c",
      "user.name=Other",
      "-c",
      "user.email=other@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Remote update",
    ]);
    await runGit(["-C", otherPath, "push", "origin", "main"]);

    try {
      await repo.push();
      throw new Error("Expected non-fast-forward rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupNonFastForwardError);
    }
  });

  it("rejects a push when the remote branch disappears after the drift check", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "initial\n");
    if ((await repo.stageAndCommit("Initial backup")) === null) {
      throw new Error("Expected the initial commit");
    }
    await repo.push();

    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "local update\n");
    if ((await repo.stageAndCommit("Local update")) === null) {
      throw new Error("Expected the local update commit");
    }

    // Deleting the branch only after the drift check passes leaves the exact window the
    // lease closes: an ordinary push would recreate the branch with the deleted history.
    const originalAssert = repo.assertRemoteUnchanged.bind(repo);
    repo.assertRemoteUnchanged = async () => {
      await originalAssert();
      await runGit(["-C", originPath, "update-ref", "-d", "refs/heads/main"]);
    };

    try {
      await repo.push();
      throw new Error("Expected the lease to reject the push");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupNonFastForwardError);
    }
    expect(await runGit(["-C", originPath, "for-each-ref", "refs/heads/main"])).toBe("");
  });
});
