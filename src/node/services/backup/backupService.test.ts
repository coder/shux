import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BackupProjectImport, SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { Err, Ok } from "@/common/types/result";
import { BackupNonFastForwardError, backupCachePath, isBackupCacheName } from "./gitRepo";
import { BackupRemoteUnreachableError } from "./credentials";
import {
  BackupCommandApprovalRequiredError,
  ProjectMemoryRestoreError,
  ProjectMemoryWriteError,
} from "./payload";
import {
  BackupService,
  type BackupMatchedProject,
  type BackupProjectImporter,
  type BackupProjectRegistrar,
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayloadStore,
  type PreparedBackupRepository,
} from "./backupService";
import { TestBackupConfig } from "./testHelpers";

const SETTINGS: SettingsBackupInput = {
  repoUrl: "git@github.com:example/settings.git",
  branch: "main",
  path: "mux",
};

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function snapshotDirectories(cacheRoot: string): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("restore-"))
    .map((entry) => entry.name);
}

async function cacheDirectories(cacheRoot: string): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isBackupCacheName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function createCacheDirectory(
  cacheRoot: string,
  settings: SettingsBackupInput
): Promise<string> {
  const cachePath = backupCachePath(cacheRoot, settings.repoUrl, settings.branch);
  await fs.mkdir(path.join(cachePath, ".git"), { recursive: true });
  return cachePath;
}

function createRepository(
  overrides: Partial<PreparedBackupRepository> = {}
): PreparedBackupRepository {
  return {
    rootDir: "/cache/repository",
    credential: "ssh",
    remoteCommit: "remote-commit",
    managedPath: SETTINGS.path,
    ...overrides,
  };
}

function createGitRepo(overrides: Partial<BackupGitRepo> = {}): BackupGitRepo {
  return {
    validate: () => Promise.resolve({ credential: "ssh", empty: false }),
    prepare: () => Promise.resolve(createRepository()),
    getPushChanges: () => Promise.resolve([]),
    commitAndPush: () =>
      Promise.resolve({ commit: "pushed-commit", changed: true, credential: "gh" as const }),
    ...overrides,
  };
}

function createPayload(overrides: Partial<BackupPayloadStore> = {}): BackupPayloadStore {
  return {
    exportTo: () => Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" }),
    previewRestore: () =>
      Promise.resolve({
        changes: [],
        localOnlyFiles: [],
        commandApprovals: [],
        projectImports: [],
        projectBundleSkipped: false,
      }),
    validateRestore: () =>
      Promise.resolve({ hasProjectBundle: false, projectImports: [], matchedProjects: [] }),
    writeSafetySnapshot: () => Promise.resolve(),
    restore: () =>
      Promise.resolve({
        changedFiles: [],
        localOnlyFiles: [],
        projectBundleSkipped: false,
        restoredProjectMemory: [],
      }),
    prepareProjectImports: () =>
      Promise.resolve(importsWith(() => Promise.resolve({ writtenFiles: [], skippedFiles: [] }))),
    ...overrides,
  };
}
/** A payload store slice whose single prepared importer runs the given import implementation. */
function importsWith(
  importProjectMemory: BackupProjectImporter["importProjectMemory"],
  assertProjectMemoryAllowed: BackupProjectImporter["assertProjectMemoryAllowed"] = () =>
    Promise.resolve()
): BackupProjectImporter {
  return { assertProjectMemoryAllowed, importProjectMemory };
}

/** The validated identity of an entry registered at its own recorded path. */
function matchedIdentity(projectPath: string): BackupMatchedProject {
  return {
    sourcePath: projectPath,
    projectPath,
    localMemoryDir: `${path.basename(projectPath)}-abc`,
  };
}

/** A registrar mock around the given create(). */
type RegistrarCreate = Parameters<
  Parameters<BackupProjectRegistrar["withRegistrationLock"]>[0]
>[0]["create"];

function registrar(create: RegistrarCreate): BackupProjectRegistrar {
  return {
    withRegistrationLock: (fn) => fn({ create, assertStillOwned: () => Promise.resolve() }),
  };
}

function createService(
  rootDir: string,
  overrides: {
    config?: TestBackupConfig;
    gitRepo?: BackupGitRepo;
    payload?: BackupPayloadStore;
  } = {}
): BackupService {
  return new BackupService(overrides.config ?? new TestBackupConfig(rootDir), {
    gitRepo: overrides.gitRepo ?? createGitRepo(),
    payload: overrides.payload ?? createPayload(),
  });
}

describe("BackupService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-service-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates a safety snapshot before restoring and records the restored commit", async () => {
    const events: string[] = [];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => {
          events.push("validate");
          return Promise.resolve({
            hasProjectBundle: false,
            projectImports: [],
            matchedProjects: [],
          });
        },
        writeSafetySnapshot: async (snapshotRoot) => {
          events.push("snapshot");
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
        restore: () => {
          events.push("restore");
          return Promise.resolve({
            changedFiles: ["AGENTS.md"],
            localOnlyFiles: ["skills/local/SKILL.md"],
            projectBundleSkipped: false,
            restoredProjectMemory: [],
          });
        },
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    expect(result.data.commit).toBe("remote-commit");
    expect(
      result.data.snapshotPath.startsWith(path.join(tempDir, "backup-cache", "restore-"))
    ).toBe(true);
    expect(result.data.changedFiles).toEqual(["AGENTS.md"]);
    expect(result.data.localOnlyFiles).toEqual(["skills/local/SKILL.md"]);
    expect(events).toEqual(["validate", "snapshot", "restore"]);
    expect(await fs.readFile(path.join(result.data.snapshotPath, "AGENTS.md"), "utf8")).toBe(
      "before restore"
    );
    expect(service.getSettings()?.lastRestoredCommit).toBe("remote-commit");
  });

  test("keeps a bounded number of restore snapshots", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });
    const cacheRoot = path.join(tempDir, "backup-cache");
    await fs.mkdir(cacheRoot, { recursive: true });
    // A cache clone lives beside the snapshots and must survive the reap.
    const clone = path.join(cacheRoot, "0123456789ab");
    await fs.mkdir(clone, { recursive: true });

    const snapshots: string[] = [];
    for (let restore = 0; restore < 5; restore++) {
      const result = await service.restore(SETTINGS);
      if (!result.success) throw new Error(result.error.message);
      snapshots.push(result.data.snapshotPath);
    }

    const surviving = new Set(await snapshotDirectories(cacheRoot));
    expect(surviving.size).toBe(3);
    // The newest are the ones a recovery would reach for.
    for (const kept of snapshots.slice(-3)) {
      expect(surviving.has(path.basename(kept))).toBe(true);
    }
    expect((await fs.stat(clone)).isDirectory()).toBe(true);
  });

  test("keeps a returned snapshot until later restores have replaced it", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });

    const first = await service.restore(SETTINGS);
    if (!first.success) throw new Error(first.error.message);
    // The path handed to the caller has to stay readable for as many later restores as the
    // retention promises, which is what makes it usable after the call returns.
    for (let later = 0; later < BackupService.RETAINED_SNAPSHOTS - 1; later++) {
      const next = await service.restore(SETTINGS);
      if (!next.success) throw new Error(next.error.message);
      expect(await fs.readFile(path.join(first.data.snapshotPath, "AGENTS.md"), "utf8")).toBe(
        "before restore"
      );
    }
  });

  test("keeps only the two most recently used inactive repository caches", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const gitRepo = createGitRepo({
      prepare: async (settings) =>
        createRepository({ rootDir: await createCacheDirectory(cacheRoot, settings) }),
    });
    const service = createService(tempDir, { gitRepo });
    const settings: [
      SettingsBackupInput,
      SettingsBackupInput,
      SettingsBackupInput,
      SettingsBackupInput,
    ] = [
      { ...SETTINGS, branch: "a" },
      { ...SETTINGS, branch: "b" },
      { ...SETTINGS, branch: "c" },
      { ...SETTINGS, branch: "d" },
    ];

    for (const current of settings.slice(0, 3)) {
      expect((await service.preview(current)).success).toBe(true);
    }
    for (const [index, current] of settings.slice(0, 3).entries()) {
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(backupCachePath(cacheRoot, current.repoUrl, current.branch), usedAt, usedAt);
    }

    const snapshot = path.join(cacheRoot, "restore-in-progress");
    const tombstone = path.join(cacheRoot, "000000000000.discarded-1234-test");
    await fs.mkdir(snapshot, { recursive: true });
    await fs.mkdir(tombstone, { recursive: true });

    expect((await service.preview(settings[3])).success).toBe(true);

    const surviving = await cacheDirectories(cacheRoot);
    expect(surviving).toEqual(
      settings
        .slice(1)
        .map((current) =>
          path.basename(backupCachePath(cacheRoot, current.repoUrl, current.branch))
        )
        .sort()
    );
    expect(
      await pathExists(backupCachePath(cacheRoot, settings[0].repoUrl, settings[0].branch))
    ).toBe(false);
    expect(await pathExists(snapshot)).toBe(true);
    expect(await pathExists(tombstone)).toBe(false);
  });

  test("reaps inactive repository caches when preparation rejects", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const settings = ["a", "b", "c", "d"].map((branch) => ({ ...SETTINGS, branch }));
    for (const [index, current] of settings.slice(0, 3).entries()) {
      const cachePath = await createCacheDirectory(cacheRoot, current);
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(cachePath, usedAt, usedAt);
    }
    const gitRepo = createGitRepo({
      prepare: async (current, options) => {
        const repositoryRoot = await createCacheDirectory(cacheRoot, current);
        const cleanup = options?.onPrepareError?.(repositoryRoot);
        await cleanup?.catch(() => undefined);
        throw new BackupServiceError("INVALID_BACKUP", "Invalid remote payload");
      },
    });
    const service = createService(tempDir, { gitRepo });

    const result = await service.preview(settings[3]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid preparation to fail");
    expect(result.error.code).toBe("INVALID_BACKUP");
    expect(await cacheDirectories(cacheRoot)).toEqual(
      settings
        .slice(1)
        .map((current) =>
          path.basename(backupCachePath(cacheRoot, current.repoUrl, current.branch))
        )
        .sort()
    );
  });

  test("never reaps a repository cache while another operation is using it", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const settings = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((branch) => [branch, { ...SETTINGS, branch }])
    ) as Record<"a" | "b" | "c" | "d" | "e", SettingsBackupInput>;
    const gitRepo = createGitRepo({
      prepare: async (current) =>
        createRepository({ rootDir: await createCacheDirectory(cacheRoot, current) }),
    });
    for (const [index, current] of [settings.b, settings.c, settings.d].entries()) {
      const cachePath = await createCacheDirectory(cacheRoot, current);
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(cachePath, usedAt, usedAt);
    }

    let releaseActive: (() => void) | undefined;
    const activeHeld = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let activeEntered: (() => void) | undefined;
    const activeInPayload = new Promise<void>((resolve) => {
      activeEntered = resolve;
    });
    const activeService = createService(tempDir, {
      gitRepo,
      payload: createPayload({
        previewRestore: async () => {
          activeEntered?.();
          await activeHeld;
          return {
            changes: [],
            localOnlyFiles: [],
            commandApprovals: [],
            projectImports: [],
            projectBundleSkipped: false,
          };
        },
      }),
    });
    const otherService = createService(tempDir, { gitRepo });

    const active = activeService.preview(settings.a);
    await activeInPayload;
    const activeCache = backupCachePath(cacheRoot, settings.a.repoUrl, settings.a.branch);
    const old = new Date(500);
    await fs.utimes(activeCache, old, old);

    try {
      expect((await otherService.preview(settings.e)).success).toBe(true);
      expect(await pathExists(activeCache)).toBe(true);
      expect(
        await pathExists(backupCachePath(cacheRoot, settings.b.repoUrl, settings.b.branch))
      ).toBe(false);
    } finally {
      releaseActive?.();
    }
    expect((await active).success).toBe(true);
  });

  test("holds a push out of a Xum root a restore is still writing", async () => {
    const events: string[] = [];
    let releaseRestore: (() => void) | undefined;
    const restoreHeld = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered: (() => void) | undefined;
    const restoreInFlight = new Promise<void>((resolve) => {
      restoreEntered = resolve;
    });
    const service = createService(tempDir, {
      payload: createPayload({
        restore: async () => {
          events.push("restore-start");
          restoreEntered?.();
          await restoreHeld;
          events.push("restore-end");
          return {
            changedFiles: ["AGENTS.md"],
            localOnlyFiles: [],
            projectBundleSkipped: false,
            restoredProjectMemory: [],
          };
        },
        exportTo: () => {
          events.push("export");
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "digest" });
        },
      }),
    });

    const restoring = service.restore(SETTINGS);
    await restoreInFlight;
    // A different repository, so withRepoLock does not serialize these two.
    const pushing = service.push({ ...SETTINGS, repoUrl: `${SETTINGS.repoUrl}-other` });
    // Every step between push() and its export is a microtask here (the git repo is a test double),
    // so draining the queue parks the push on the payload lock instead of merely unscheduled. Without
    // the drain the push exports after this restore regardless, and the test passes with no lock.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    releaseRestore?.();
    const [restored, pushed] = await Promise.all([restoring, pushing]);

    expect(restored.success).toBe(true);
    expect(pushed.success).toBe(true);
    // The export must read the root after the restore finished writing it, not during.
    expect(events).toEqual(["restore-start", "restore-end", "export"]);
  });

  test("never reaps a snapshot whose restore has not returned", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    // withRepoLock is per repository, so this stands in for restores of other repositories
    // that are still running while this one completes.
    await fs.mkdir(cacheRoot, { recursive: true });
    const inFlight: string[] = [];
    for (const stamp of ["2020-01-01T00-00-00-000Z", "2020-01-02T00-00-00-000Z"]) {
      const directory = path.join(cacheRoot, `restore-${stamp}-aaaaaa`);
      await fs.mkdir(directory, { recursive: true });
      inFlight.push(path.basename(directory));
    }

    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });

    for (let restore = 0; restore < 4; restore++) {
      const result = await service.restore(SETTINGS);
      if (!result.success) throw new Error(result.error.message);
    }

    const surviving = await snapshotDirectories(cacheRoot);
    for (const unreleased of inFlight) {
      expect(surviving).toContain(unreleased);
    }
  });

  test("reports the completed snapshot when the restore fails after it", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
        // Fails after the snapshot, when files may already be overwritten, so the snapshot
        // is the only recovery path and the failure must carry it.
        restore: () => Promise.reject(new Error("disk full")),
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the restore to fail");
    const snapshotPath = result.error.snapshotPath;
    if (snapshotPath == null) throw new Error("Expected the failure to carry the snapshot path");
    expect(snapshotPath.startsWith(path.join(tempDir, "backup-cache", "restore-"))).toBe(true);
    expect(await fs.readFile(path.join(snapshotPath, "AGENTS.md"), "utf8")).toBe("before restore");
  });

  test("does not attach a snapshot path to failures before the snapshot exists", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => Promise.reject(new Error("no backup here")),
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the restore to fail");
    // Nothing was restored and no snapshot survives, so a path here would send the user
    // hunting for a recovery copy that does not exist.
    expect(result.error.snapshotPath == null).toBe(true);
  });

  test("computes restore preview before materializing the local export", async () => {
    const events: string[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        getPushChanges: () => {
          events.push("push-preview");
          return Promise.resolve([{ path: "AGENTS.md", status: "M" }]);
        },
      }),
      payload: createPayload({
        previewRestore: () => {
          events.push("restore-preview");
          return Promise.resolve({
            changes: [{ path: "preferences.json", status: "M" }],
            localOnlyFiles: [],
            commandApprovals: [],
            projectImports: [],
            projectBundleSkipped: false,
          });
        },
        exportTo: () => {
          events.push("export");
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" });
        },
      }),
    });

    const result = await service.preview(SETTINGS);

    expect(result.success).toBe(true);
    expect(events).toEqual(["restore-preview", "export", "push-preview"]);
  });

  test("addresses payload operations to the prepared repository's managed path", async () => {
    // prepare() may select the legacy `mux` spelling of the configured path (backups
    // pushed before the product rename); every payload call must follow that selection
    // rather than the configured settings path.
    const managedPaths: string[] = [];
    const recordManagedPath = (options: { managedPath: string }) => {
      managedPaths.push(options.managedPath);
    };
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: () => Promise.resolve(createRepository({ managedPath: "legacy-spelling" })),
      }),
      payload: createPayload({
        previewRestore: (options) => {
          recordManagedPath(options);
          return Promise.resolve({
            changes: [],
            localOnlyFiles: [],
            commandApprovals: [],
            projectImports: [],
            projectBundleSkipped: false,
          });
        },
        exportTo: (options) => {
          recordManagedPath(options);
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" });
        },
        validateRestore: (options) => {
          recordManagedPath(options);
          return Promise.resolve({
            hasProjectBundle: false,
            projectImports: [],
            matchedProjects: [],
          });
        },
        restore: (options) => {
          recordManagedPath(options);
          return Promise.resolve({
            changedFiles: [],
            localOnlyFiles: [],
            projectBundleSkipped: false,
            restoredProjectMemory: [],
          });
        },
      }),
    });

    expect((await service.preview(SETTINGS)).success).toBe(true);
    expect((await service.push(SETTINGS)).success).toBe(true);
    expect((await service.restore(SETTINGS)).success).toBe(true);
    expect(managedPaths).not.toContain(SETTINGS.path);
    expect(new Set(managedPaths)).toEqual(new Set(["legacy-spelling"]));
  });

  test("returns repository drift as expected Result data without updating settings", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          throw new BackupServiceError(
            "REPOSITORY_CHANGED",
            "The backup changed since you last read it"
          );
        },
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result).toEqual({
      success: false,
      error: {
        code: "REPOSITORY_CHANGED",
        message: "The backup changed since you last read it",
        files: undefined,
      },
    });
    expect(service.getSettings()).toBeNull();
  });

  test("blocks a push when the payload secret scan reports files", async () => {
    let commitAttempted = false;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          commitAttempted = true;
          return Promise.resolve({
            commit: "unexpected",
            changed: true,
            credential: "gh" as const,
          });
        },
      }),
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["skills/private/SKILL.md"],
            secretApproval: "digest-v1",
          }),
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected secret detection to block the push");
    expect(result.error.code).toBe("SECRET_DETECTED");
    expect(result.error.files).toEqual(["skills/private/SKILL.md"]);
    expect(commitAttempted).toBe(false);
    expect(result.error.secretApproval).toBe("digest-v1");
  });

  test("rejects an override issued for a payload that has since changed", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["skills/private/SKILL.md"],
            secretApproval: "digest-v2",
          }),
      }),
    });

    const stale = await service.push(SETTINGS, { approvedSecretDigest: "digest-v1" });
    expect(stale.success).toBe(false);
    if (stale.success) throw new Error("Expected the stale override to be refused");
    expect(stale.error.code).toBe("SECRET_DETECTED");

    const current = await service.push(SETTINGS, { approvedSecretDigest: "digest-v2" });
    expect(current.success).toBe(true);
  });

  test("maps a real non-fast-forward failure to repository drift", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => Promise.reject(new BackupNonFastForwardError()),
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the drifted remote to block the push");
    expect(result.error.code).toBe("REPOSITORY_CHANGED");
    expect(result.error.message).toBe("The backup changed since you last read it");
  });

  test("surfaces an unreachable remote to the client as REMOTE_UNREACHABLE", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        validate: () => Promise.reject(new BackupRemoteUnreachableError(new Error("no dns"))),
      }),
    });

    const result = await service.validate(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the unreachable remote to fail validation");
    expect(result.error.code).toBe("REMOTE_UNREACHABLE");
  });

  const managedPathRejectionCases = [
    { name: "rejects a managed path that targets the git directory", managedPath: ".git" },
    { name: "rejects a reserved Windows device name", managedPath: "CON/mux" },
    { name: "rejects a Windows path containing a colon", managedPath: "foo:bar/mux" },
    { name: "rejects a Windows path ending in a period", managedPath: "mux." },
  ];

  for (const testCase of managedPathRejectionCases) {
    test(testCase.name, async () => {
      const service = createService(tempDir);

      const result = await service.saveSettings({ ...SETTINGS, path: testCase.managedPath });

      expect(result.success).toBe(false);
      if (result.success) throw new Error(`Expected '${testCase.managedPath}' to be rejected`);
      expect(result.error.code).toBe("INVALID_BACKUP");
    });
  }

  test("reports a config write that never landed instead of claiming success", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });
    // saveConfig logs and swallows write errors, so a full disk looks exactly like this:
    // the edit callback runs, editConfig resolves, and the stored config never changes.
    spyOn(config, "editConfig").mockImplementation((edit) => {
      edit(config.loadConfigOrDefault());
      return Promise.resolve();
    });

    const result = await service.saveSettings(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the lost write to be reported");
    expect(result.error.code).toBe("IO_ERROR");
  });

  test("rejects and does not persist a repository URL that embeds a credential", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });

    for (const repoUrl of [
      "https://oauth2:hunter2@example.com/repo.git",
      "https://oauth2:hunter2@",
      "https:oauth2:hunter2@",
      "ssh://user:hunter2@",
      "ssh:user:hunter2@",
      "https://example.com/repo.git?access_token=hunter2",
      "https://example.com/repo.git#access_token=hunter2",
    ]) {
      const result = await service.saveSettings({ ...SETTINGS, repoUrl });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected the credential URL to be rejected");
      expect(result.error.code).toBe("INVALID_BACKUP");
      expect(service.getSettings()).toBeNull();
    }
  });

  test("rejects invalid settings before config or repository access", async () => {
    const config = new TestBackupConfig(tempDir);
    let validateCalls = 0;
    let prepareCalls = 0;
    const service = createService(tempDir, {
      config,
      gitRepo: createGitRepo({
        validate: () => {
          validateCalls += 1;
          return Promise.resolve({ credential: "ssh", empty: false });
        },
        prepare: () => {
          prepareCalls += 1;
          return Promise.resolve(createRepository());
        },
      }),
    });

    for (const settings of [
      { ...SETTINGS, branch: "my branch" },
      { ...SETTINGS, branch: "-backup" },
      { ...SETTINGS, branch: "refs/heads/main" },
      { ...SETTINGS, repoUrl: "   " },
      { ...SETTINGS, branch: null } as unknown as SettingsBackupInput,
    ]) {
      const results = await Promise.all([
        service.saveSettings(settings),
        service.validate(settings),
        service.preview(settings),
        service.push(settings),
        service.restore(settings),
      ]);

      for (const result of results) {
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected the invalid settings to be rejected");
        expect(result.error.code).toBe("INVALID_BACKUP");
      }
      expect(service.getSettings()).toBeNull();
    }
    expect(validateCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  test("normalizes direct service input like the ORPC schema", async () => {
    const seen: SettingsBackupInput[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        validate: (settings) => {
          seen.push(settings);
          return Promise.resolve({ credential: "ssh", empty: false });
        },
      }),
    });
    const input = {
      repoUrl: ` ${SETTINGS.repoUrl} `,
      branch: ` ${SETTINGS.branch} `,
      path: ` ${SETTINGS.path} `,
    };

    const saved = await service.saveSettings(input);
    const validated = await service.validate(input);

    expect(saved.success).toBe(true);
    expect(validated.success).toBe(true);
    expect(service.getSettings()).toMatchObject(SETTINGS);
    expect(seen).toEqual([SETTINGS]);
  });

  test("surfaces the current command approvals when a restore is blocked", async () => {
    const approvals = [
      { path: "servers.notes.command", command: "npx notes-mcp", token: "token-notes" },
    ];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => Promise.reject(new BackupCommandApprovalRequiredError(approvals)),
      }),
    });
    await service.saveSettings(SETTINGS);

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the unapproved restore to be blocked");
    expect(result.error.code).toBe("COMMAND_APPROVAL_REQUIRED");
    // Without the list, a restore attempted before any preview leaves the user with an
    // empty approval box and no way forward except guessing to run Preview again.
    expect(result.error.commandApprovals).toEqual(approvals);
  });

  test("does not revert a repository saved while a push was still running", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });
    await service.saveSettings(SETTINGS);

    const other = { ...SETTINGS, repoUrl: "https://example.com/other.git" };
    await service.saveSettings(other);
    await service.push(SETTINGS);

    const stored = service.getSettings();
    expect(stored?.repoUrl).toBe(other.repoUrl);
  });

  test("serializes operations for the same repository", async () => {
    const firstCanFinish = Promise.withResolvers<void>();
    const starts: string[] = [];
    let prepareCount = 0;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCount += 1;
          starts.push(`prepare-${prepareCount}`);
          if (prepareCount === 1) {
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await Promise.resolve();
    const second = service.preview(SETTINGS);
    await Promise.resolve();

    expect(starts).toEqual(["prepare-1"]);
    firstCanFinish.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual(["prepare-1", "prepare-2"]);
  });

  test("rejects invalid settings before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          firstStarted.resolve();
          await firstCanFinish.promise;
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const invalid = service.preview({ ...SETTINGS, path: ".git" });
    const pending = Symbol("pending");
    try {
      const result = await Promise.race([
        invalid,
        new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
      ]);
      if (result === pending) throw new Error("Invalid settings waited for the repository lock");
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected the invalid settings to be rejected");
      expect(result.error.code).toBe("INVALID_BACKUP");
    } finally {
      firstCanFinish.resolve();
      await Promise.all([first, invalid]);
    }
  });

  test("snapshots settings before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    const prepared: SettingsBackupInput[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async (settings) => {
          prepared.push(settings);
          if (prepared.length === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const mutable = { ...SETTINGS };
    const second = service.preview(mutable);
    mutable.branch = "refs/heads/main";
    firstCanFinish.resolve();
    await Promise.all([first, second]);

    expect(prepared).toEqual([SETTINGS, SETTINGS]);
  });

  test("snapshots push approval before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    let prepareCalls = 0;
    let pushCalls = 0;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
        commitAndPush: () => {
          pushCalls += 1;
          return Promise.resolve({ commit: "pushed-commit", changed: true, credential: "gh" });
        },
      }),
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["AGENTS.md"],
            secretApproval: "approved-digest",
          }),
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const options = { approvedSecretDigest: "stale-digest" };
    const second = service.push(SETTINGS, options);
    options.approvedSecretDigest = "approved-digest";
    firstCanFinish.resolve();
    const [, result] = await Promise.all([first, second]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the stale approval to be rejected");
    expect(result.error.code).toBe("SECRET_DETECTED");
    expect(pushCalls).toBe(0);
  });

  test("snapshots restore approvals before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    let prepareCalls = 0;
    const approvals = [
      { path: "servers.notes.command", command: "npx notes-mcp", token: "approved-token" },
    ];
    const seenTokens: string[][] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
      payload: createPayload({
        validateRestore: ({ approvedCommandTokens }) => {
          const tokens = [...(approvedCommandTokens ?? [])];
          seenTokens.push(tokens);
          return tokens.includes("approved-token")
            ? Promise.resolve({
                hasProjectBundle: false,
                projectImports: [],
                matchedProjects: [],
              })
            : Promise.reject(new BackupCommandApprovalRequiredError(approvals));
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const options = { approvedCommandTokens: ["stale-token"] };
    const second = service.restore(SETTINGS, options);
    options.approvedCommandTokens[0] = "approved-token";
    firstCanFinish.resolve();
    const [, result] = await Promise.all([first, second]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the stale approval to be rejected");
    expect(result.error.code).toBe("COMMAND_APPROVAL_REQUIRED");
    expect(seenTokens).toEqual([["stale-token"]]);
  });

  test("preserves commit metadata when saving the same repository settings", async () => {
    const service = createService(tempDir);

    const pushed = await service.push(SETTINGS);
    expect(pushed.success).toBe(true);

    const saved = await service.saveSettings(SETTINGS);

    expect(saved).toEqual({
      success: true,
      data: {
        ...SETTINGS,
        lastPushedCommit: "pushed-commit",
        lastRestoredCommit: undefined,
      },
    });
  });
});

describe("BackupService project imports", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-imports-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function candidate(overrides: Partial<BackupProjectImport> = {}): BackupProjectImport {
    return {
      sourcePath: "/home/dev/src/alpha",
      name: "alpha",
      memoryFileCount: 1,
      token: "candidate-token",
      ...overrides,
    };
  }

  test("persists includeProjects and passes it to the payload store", async () => {
    const seen: boolean[] = [];
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        exportTo: (options) => {
          seen.push(options.includeProjects);
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" });
        },
      }),
    });

    const saved = await service.saveSettings({ ...SETTINGS, includeProjects: true });
    expect(saved.success).toBe(true);
    expect(service.getSettings()?.includeProjects).toBe(true);

    expect((await service.push({ ...SETTINGS, includeProjects: true })).success).toBe(true);
    expect((await service.push(SETTINGS)).success).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  test("refuses an unknown import token with fresh candidates before the snapshot", async () => {
    const fresh = candidate();
    let snapshots = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [fresh],
            matchedProjects: [],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "stale-token", targetPath: tempDir }] }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PROJECT_IMPORT_APPROVAL_REQUIRED");
      expect(result.error.projectImports).toEqual([fresh]);
      expect(result.error.snapshotPath).toBeUndefined();
    }
    expect(snapshots).toBe(0);
  });

  test("refuses an unusable import target before the snapshot", async () => {
    let snapshots = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    for (const targetPath of [path.join(tempDir, "missing"), "relative/path"]) {
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath }] }
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("IO_ERROR");
        expect(result.error.snapshotPath).toBeUndefined();
      }
    }
    expect(snapshots).toBe(0);
  });

  test("registers a project before writing its memory and isolates per-candidate failures", async () => {
    const goodDir = path.join(tempDir, "good");
    const badDir = path.join(tempDir, "bad");
    await fs.mkdir(goodDir);
    await fs.mkdir(badDir);
    const candidates = [
      candidate({ sourcePath: "/src/good", name: "good", token: "good-token" }),
      candidate({ sourcePath: "/src/bad", name: "bad", token: "bad-token" }),
    ];
    const events: string[] = [];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: candidates,
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              events.push(`import:${options.targetPath}`);
              return Promise.resolve({
                writtenFiles: ["memory/project/good-abc/notes.md"],
                skippedFiles: [],
              });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        events.push(`create:${projectPath}`);
        return Promise.resolve(
          projectPath === goodDir ? Ok({ normalizedPath: projectPath }) : Err("registration failed")
        );
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      {
        projectImports: [
          { token: "good-token", targetPath: goodDir },
          { token: "bad-token", targetPath: badDir },
        ],
      }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults).toEqual([
        {
          sourcePath: "/src/good",
          targetPath: goodDir,
          name: "good",
          status: "imported",
          writtenFiles: ["memory/project/good-abc/notes.md"],
          skippedFiles: [],
          registered: true,
        },
        {
          sourcePath: "/src/bad",
          targetPath: badDir,
          name: "bad",
          status: "failed",
          message: "registration failed",
          writtenFiles: [],
          skippedFiles: [],
          registered: false,
        },
      ]);
    }
    // Registration always completes before the memory write for its candidate; the failed
    // registration never reaches the memory write.
    expect(events).toEqual([`create:${goodDir}`, `import:${goodDir}`, `create:${badDir}`]);
  });

  test("tolerates a project already registered at the target path", async () => {
    const target = path.join(tempDir, "already");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(target, { workspaces: [] });
    const importedTo: string[] = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(registrar(() => Promise.resolve(Err("Project already exists"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]?.status).toBe("imported");
    }
    expect(importedTo).toEqual([target]);
  });

  test("imports to the registered identity when the target is a symlink alias of it", async () => {
    const realParent = path.join(tempDir, "real");
    const registered = path.join(realParent, "proj");
    await fs.mkdir(registered, { recursive: true });
    const aliasParent = path.join(tempDir, "alias");
    await fs.symlink(realParent, aliasParent, "dir");
    const aliasTarget = path.join(aliasParent, "proj");

    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(registered, { workspaces: [] });
    const importedTo: string[] = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // ProjectService resolves the alias to the registered project and reports a duplicate.
    service.setProjectService(registrar(() => Promise.resolve(Err("Project already exists"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: aliasTarget }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      // Memory is keyed by the registered path's hash; the alias would land it where the
      // project never looks.
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "imported",
        targetPath: registered,
      });
    }
    expect(importedTo).toEqual([registered]);
  });

  test("reports candidates a restore left unimported for lack of approval", async () => {
    const target = path.join(tempDir, "approved");
    await fs.mkdir(target);
    const approved = candidate();
    const skipped = candidate({ name: "beta", token: "beta-token", sourcePath: "/src/beta" });
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [approved, skipped],
            matchedProjects: [],
          }),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => Promise.resolve(Ok({ normalizedPath: projectPath })))
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults.map((item) => item.status)).toEqual(["imported"]);
      // A "completed" restore never silently omits backed-up projects.
      expect(result.data.unapprovedProjectImports).toEqual([skipped]);
    }
  });

  test("refuses an approved import whose memory cannot land before taking a snapshot", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    let snapshots = 0;
    let registrations = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(
              () => Promise.resolve({ writtenFiles: [], skippedFiles: [] }),
              () => Promise.reject(new Error("larger than the memory file limit"))
            )
          ),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("memory file limit");
    }
    // Refused while nothing had changed: no snapshot, no registered project left behind.
    expect(snapshots).toBe(0);
    expect(registrations).toBe(0);
  });

  test("preflights an alias target against the registered project it imports into", async () => {
    const realParent = path.join(tempDir, "real");
    const registered = path.join(realParent, "proj");
    await fs.mkdir(registered, { recursive: true });
    const aliasParent = path.join(tempDir, "alias");
    await fs.symlink(realParent, aliasParent, "dir");
    const aliasTarget = path.join(aliasParent, "proj");
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(registered, { workspaces: [] });
    const preflighted: string[] = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(
              () => Promise.resolve({ writtenFiles: [], skippedFiles: [] }),
              (options) => {
                preflighted.push(options.targetPath);
                return Promise.resolve();
              }
            )
          ),
      }),
    });
    service.setProjectService(registrar(() => Promise.resolve(Err("Project already exists"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: aliasTarget }] }
    );

    expect(result.success).toBe(true);
    // The memory scope actually written is the registered project's, not the alias's.
    expect(preflighted).toEqual([registered]);
  });

  test("imports into a project registered under a different alias of the same directory", async () => {
    const realParent = path.join(tempDir, "real");
    await fs.mkdir(path.join(realParent, "repo"), { recursive: true });
    const aliasA = path.join(tempDir, "alias-a");
    const aliasB = path.join(tempDir, "alias-b");
    await fs.symlink(realParent, aliasA, "dir");
    await fs.symlink(realParent, aliasB, "dir");
    const registeredAlias = path.join(aliasA, "repo");
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(registeredAlias, { workspaces: [] });
    const importedTo: string[] = [];
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // create() would happily register the second alias; the service must not ask it to.
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: path.join(aliasB, "repo") }] }
    );

    expect(result.success).toBe(true);
    expect(registrations).toBe(0);
    // One checkout, one registration, one memory scope.
    expect(importedTo).toEqual([registeredAlias]);
  });

  test("applies the backed-up name to a newly registered project only", async () => {
    const fresh = path.join(tempDir, "checkout");
    const existing = path.join(tempDir, "existing");
    await fs.mkdir(fresh);
    await fs.mkdir(existing);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(existing, { workspaces: [], displayName: "Local name" });
    const created: Array<[string, string | undefined]> = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [
              candidate({ name: "Rocket Science" }),
              candidate({ name: "Probe", token: "probe-token", sourcePath: "/src/probe" }),
            ],
            matchedProjects: [],
          }),
      }),
    });
    service.setProjectService(
      registrar((projectPath, options) => {
        created.push([projectPath, options?.displayName]);
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      {
        projectImports: [
          { token: "candidate-token", targetPath: fresh },
          { token: "probe-token", targetPath: existing },
        ],
      }
    );

    expect(result.success).toBe(true);
    // "checkout" would otherwise show up under its basename, not the name it was backed up
    // with — set in the registration itself. The already registered project is never
    // re-created, so its local name is untouched.
    expect(created).toEqual([[fresh, "Rocket Science"]]);
  });

  test("keeps a candidate on offer when its import fails per-candidate", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const failing = candidate();
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [failing],
            matchedProjects: [],
          }),
      }),
    });
    service.setProjectService(registrar(() => Promise.resolve(Err("registration failed"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]?.status).toBe("failed");
      // Retryable without another preview: the token is still current.
      expect(result.data.unapprovedProjectImports).toEqual([failing]);
    }
  });

  test("keeps a candidate on offer when its import skipped conflicting files", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const conflicted = candidate();
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [conflicted],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() =>
              Promise.resolve({
                writtenFiles: ["memory/project/target-abc/notes.md"],
                skippedFiles: ["memory/project/target-abc/conflict.md"],
              })
            )
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => Promise.resolve(Ok({ normalizedPath: projectPath })))
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]?.status).toBe("imported");
      // No origin was recorded over the conflict, so the source is still an import
      // candidate; the card must stay so the user can resolve and retry without a preview.
      expect(result.data.unapprovedProjectImports).toEqual([conflicted]);
    }
  });

  test("refuses an import whose source became a registered project since the preview", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    const reclassified = candidate();
    const importedTo: string[] = [];
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [reclassified],
            matchedProjects: [],
          }),
        // Another window registers the entry's recorded source path itself while the
        // snapshot is written: the entry is an exact match from now on.
        writeSafetySnapshot: () => {
          config.state.projects.set(reclassified.sourcePath, { workspaces: [] });
          return Promise.resolve();
        },
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    // Neither registered nor written: memory imported into the target would be orphaned
    // there once every later restore writes the entry into its own registered project.
    expect(registrations).toBe(0);
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("registered on this machine since the preview") as string,
      });
      // Not re-offered: only a new preview can present this entry, as a matched one, and
      // retrying the stale approval could only fail again.
      expect(result.data.unapprovedProjectImports).toEqual([]);
    }
  });

  test("re-registers a target whose planned registration vanished before the import", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(target, { workspaces: [] });
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        // Another window unregisters the project while the snapshot is being written —
        // after planning resolved the target as already registered.
        writeSafetySnapshot: () => {
          config.state.projects.delete(target);
          return Promise.resolve();
        },
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]?.status).toBe("imported");
    }
    // Memory must not be written into an unregistered scope on a stale identity.
    expect(registrations).toBe(1);
  });

  test("refuses an import whose target was registered under another alias after planning", async () => {
    const realParent = path.join(tempDir, "real");
    await fs.mkdir(path.join(realParent, "repo"), { recursive: true });
    const aliasA = path.join(tempDir, "alias-a");
    const aliasB = path.join(tempDir, "alias-b");
    await fs.symlink(realParent, aliasA, "dir");
    await fs.symlink(realParent, aliasB, "dir");
    const registeredAlias = path.join(aliasA, "repo");
    const config = new TestBackupConfig(tempDir);
    const importedTo: string[] = [];
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        // Nothing was registered when planning ran; another window then adds the same
        // checkout through a different symlinked spelling before the imports execute.
        writeSafetySnapshot: () => {
          config.state.projects.set(registeredAlias, { workspaces: [] });
          return Promise.resolve();
        },
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // create() checks only the target spelling and its canonical path, so it would register
    // the second alias and split the project identity; the service must not ask it to.
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: path.join(aliasB, "repo") }] }
    );

    expect(result.success).toBe(true);
    expect(registrations).toBe(0);
    // Nor may it write into the alias's memory scope: the preflight checked the target's,
    // so the candidate fails without a write and is re-offered for a checked retry.
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining(registeredAlias) as string,
      });
      expect(result.data.unapprovedProjectImports.map((item) => item.token)).toEqual([
        "candidate-token",
      ]);
    }
  });

  test("never resolves an import target to a system project entry", async () => {
    // A system-kind entry registered at a real directory: MemoryService keeps no project
    // memory for it, so an import resolving to that identity would land notes nowhere.
    const target = path.join(tempDir, "system-checkout");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(target, { workspaces: [], projectKind: "system" });
    const importedTo: string[] = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // Not found in the identity lookup, so registration is attempted — and ProjectService
    // refuses the path as already taken; the candidate fails instead of writing.
    service.setProjectService(registrar(() => Promise.resolve(Err("Project already exists"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("different path") as string,
      });
    }
  });

  test("refuses an import whose target directory was replaced since approval", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    const importedTo: string[] = [];
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        // The approved checkout is moved away and another directory created at its path
        // while the snapshot is being written.
        writeSafetySnapshot: async () => {
          await fs.rename(target, path.join(tempDir, "target-moved"));
          await fs.mkdir(target);
        },
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    // Neither registered nor written into: it is not the directory the user approved.
    expect(registrations).toBe(0);
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("replaced") as string,
      });
    }
  });

  test("refuses an import whose target directory was deleted and recreated since approval", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const importedTo: string[] = [];
    let registrations = 0;
    let approvedInode: bigint | null = null;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        // Deleted and recreated, not moved: the freed inode number is what a filesystem hands
        // out again, so the new directory can report the identity recorded at approval.
        writeSafetySnapshot: async () => {
          approvedInode = (await fs.stat(target, { bigint: true })).ino;
          await fs.rm(target, { recursive: true });
          await fs.mkdir(target);
        },
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    expect(registrations).toBe(0);
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("replaced") as string,
      });
    }
    // The plan held the approved directory open, so its inode stayed allocated and the
    // replacement could not be given it — that, not luck in allocation, is what the check
    // relies on. Released once the restore returned.
    expect((await fs.stat(target, { bigint: true })).ino).not.toBe(approvedInode);
  });

  test("does not import into a target replaced while it was being registered", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    const importedTo: string[] = [];
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith((options) => {
              importedTo.push(options.targetPath);
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // The swap lands during create()'s own asynchronous validation, after the pre-create
    // identity check passed: registration goes through by path, for the new directory.
    service.setProjectService(
      registrar(async (projectPath) => {
        await fs.rename(target, path.join(tempDir, "target-moved"));
        await fs.mkdir(target);
        return Ok({ normalizedPath: projectPath });
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    // The approved source's memory must not follow the path into the other checkout.
    expect(importedTo).toEqual([]);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("registration was kept") as string,
      });
    }
  });

  test("refuses an import target longer than the manifest's path cap before the snapshot", async () => {
    // Deep enough to pass 1024 characters while every component stays under NAME_MAX.
    const target = path.join(tempDir, ...Array.from({ length: 6 }, () => "p".repeat(200)));
    await fs.mkdir(target, { recursive: true });
    let snapshots = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    // The import itself could land, but the recovery copy a later matched restore of this
    // project takes could not record the path, failing every such restore after its snapshot.
    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("longer than");
      expect(result.error.snapshotPath).toBeUndefined();
    }
    expect(snapshots).toBe(0);
  });

  test("re-probes a registered path whose real path did not resolve during planning", async () => {
    const realParent = path.join(tempDir, "real");
    await fs.mkdir(path.join(realParent, "repo"), { recursive: true });
    const aliasA = path.join(tempDir, "alias-a");
    const aliasB = path.join(tempDir, "alias-b");
    await fs.symlink(realParent, aliasA, "dir");
    await fs.symlink(realParent, aliasB, "dir");
    const registeredAlias = path.join(aliasA, "repo");
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(registeredAlias, { workspaces: [] });
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => Promise.resolve({ writtenFiles: [], skippedFiles: [] }))
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );
    // The registered alias fails to resolve once (a stalled mount at planning time) and
    // resolves on the next attempt.
    const realRealpath = fs.realpath.bind(fs);
    let stalledOnce = false;
    // Cast through unknown: `typeof fs.realpath` also carries the `.native` member, which a
    // plain implementation function cannot satisfy.
    const realpath = spyOn(fs, "realpath").mockImplementation(((target: string) => {
      if (target === registeredAlias && !stalledOnce) {
        stalledOnce = true;
        return Promise.reject(new Error("EIO: mount unavailable"));
      }
      return realRealpath(target);
    }) as unknown as typeof fs.realpath);
    try {
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath: path.join(aliasB, "repo") }] }
      );
      expect(result.success).toBe(true);
      // Reusing the unresolved planning result would have registered the second alias; the
      // execution-time lookup must probe it again and see the same directory.
      expect(registrations).toBe(0);
      if (result.success) {
        expect(result.data.projectImportResults[0]).toMatchObject({
          status: "failed",
          message: expect.stringContaining(registeredAlias) as string,
        });
      }
    } finally {
      realpath.mockRestore();
    }
  });

  test("refuses an import into a project that a matched entry restores in the same run", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(target, { workspaces: [] });
    let snapshots = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            // Another backed-up project already restores into `target` on this machine.
            matchedProjects: [
              { sourcePath: "/home/dev/src/other", projectPath: target, localMemoryDir: "t-abc" },
            ],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("already receives a backed-up project's memory");
    }
    // Refused during planning: two project identities would otherwise merge into one scope.
    expect(snapshots).toBe(0);
  });

  test("still resolves a registered alias of the target behind a project on an unavailable mount", async () => {
    const realParent = path.join(tempDir, "real");
    await fs.mkdir(path.join(realParent, "repo"), { recursive: true });
    const aliasA = path.join(tempDir, "alias-a");
    const aliasB = path.join(tempDir, "alias-b");
    await fs.symlink(realParent, aliasA, "dir");
    await fs.symlink(realParent, aliasB, "dir");
    const registeredAlias = path.join(aliasA, "repo");
    const unavailable = path.join(tempDir, "unavailable-mount");
    const config = new TestBackupConfig(tempDir);
    // Probed first, in registration order, at planning and again at execution.
    config.state.projects.set(unavailable, { workspaces: [] });
    config.state.projects.set(registeredAlias, { workspaces: [] });
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => Promise.resolve({ writtenFiles: [], skippedFiles: [] }))
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );
    const realRealpath = fs.realpath.bind(fs);
    const realpath = spyOn(fs, "realpath").mockImplementation(((target: string) =>
      // A mount that never answers: the probe pins its worker for good.
      target === unavailable
        ? new Promise<string>(() => undefined)
        : realRealpath(target)) as unknown as typeof fs.realpath);
    try {
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath: path.join(aliasB, "repo") }] }
      );
      expect(result.success).toBe(true);
      // Given the whole pass, the unavailable project would have left the alias unprobed
      // at planning and again at execution, and the target would have been registered as
      // a second spelling of the same directory. With its share only, the alias resolves
      // and the import goes into the registered project.
      expect(registrations).toBe(0);
      if (result.success) {
        expect(result.data.projectImportResults[0]).toMatchObject({
          status: "imported",
          targetPath: registeredAlias,
        });
      }
    } finally {
      realpath.mockRestore();
    }
  }, 20_000);

  test("does not register a target while registered paths it could not check remain", async () => {
    const realParent = path.join(tempDir, "real");
    await fs.mkdir(path.join(realParent, "repo"), { recursive: true });
    const aliasA = path.join(tempDir, "alias-a");
    const aliasB = path.join(tempDir, "alias-b");
    await fs.symlink(realParent, aliasA, "dir");
    await fs.symlink(realParent, aliasB, "dir");
    const registeredAlias = path.join(aliasA, "repo");
    const unavailable = [path.join(tempDir, "mount-1"), path.join(tempDir, "mount-2")];
    const config = new TestBackupConfig(tempDir);
    // Two projects on mounts that never answer are probed first; the pass stops probing after
    // them, so the alias behind them is never checked.
    for (const mount of unavailable) config.state.projects.set(mount, { workspaces: [] });
    config.state.projects.set(registeredAlias, { workspaces: [] });
    let registrations = 0;
    let imports = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => {
              imports += 1;
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );
    const realRealpath = fs.realpath.bind(fs);
    const realpath = spyOn(fs, "realpath").mockImplementation(((target: string) =>
      unavailable.includes(target)
        ? new Promise<string>(() => undefined)
        : realRealpath(target)) as unknown as typeof fs.realpath);
    try {
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath: path.join(aliasB, "repo") }] }
      );
      expect(result.success).toBe(true);
      // An incomplete lookup is not proof that no alias exists: registering would have given
      // the directory a second project identity. Refused, not registered, still on offer.
      // Three unresolved: the two that stalled and the alias the pass then did not probe.
      expect(registrations).toBe(0);
      expect(imports).toBe(0);
      if (result.success) {
        expect(result.data.projectImportResults[0]).toMatchObject({
          status: "failed",
          message: expect.stringContaining("could not be checked against 3 registered") as string,
        });
        expect(result.data.unapprovedProjectImports).toHaveLength(1);
      }
    } finally {
      realpath.mockRestore();
    }
  }, 20_000);

  test("imports an entry registered here under another memory directory name", async () => {
    // The entry's recorded path is registered on this machine, but its recorded memory
    // directory name is not the one this host computes (a path from another OS), so it is
    // offered as an import into its own registered path — which must stay importable rather
    // than being refused as "registered since the preview" every time.
    const registered = path.join(tempDir, "alpha");
    await fs.mkdir(registered);
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(registered, { workspaces: [] });
    let registrations = 0;
    let imports = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate({ sourcePath: registered })],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => {
              imports += 1;
              return Promise.resolve({ writtenFiles: ["notes.md"], skippedFiles: [] });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar(() => {
        registrations += 1;
        return Promise.resolve(Err("Project already exists"));
      })
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: registered }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "imported",
        targetPath: registered,
        registered: false,
      });
      expect(result.data.unapprovedProjectImports).toEqual([]);
    }
    expect(imports).toBe(1);
    expect(registrations).toBe(0);
  });

  test("does not register a target while a registered path failed to resolve", async () => {
    const target = path.join(tempDir, "target");
    await fs.mkdir(target);
    const denied = path.join(tempDir, "denied");
    const config = new TestBackupConfig(tempDir);
    config.state.projects.set(denied, { workspaces: [] });
    let registrations = 0;
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => Promise.resolve({ writtenFiles: [], skippedFiles: [] }))
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => {
        registrations += 1;
        return Promise.resolve(Ok({ normalizedPath: projectPath }));
      })
    );
    const realRealpath = fs.realpath.bind(fs);
    const realpath = spyOn(fs, "realpath").mockImplementation(((probed: string) =>
      // Not a stall, an immediate refusal: what the path leads to is as unknown either way.
      probed === denied
        ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
        : realRealpath(probed)) as unknown as typeof fs.realpath);
    try {
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath: target }] }
      );
      expect(result.success).toBe(true);
      expect(registrations).toBe(0);
      if (result.success) {
        expect(result.data.projectImportResults[0]).toMatchObject({
          status: "failed",
          message: expect.stringContaining("could not be checked against 1 registered") as string,
        });
      }
    } finally {
      realpath.mockRestore();
    }
  });

  test("refuses an import into a directory at another backed-up project's recorded path", async () => {
    // Local directories at two other entries' recorded paths: one still on offer, one matched.
    const otherCandidatePath = path.join(tempDir, "beta");
    const matchedSourcePath = path.join(tempDir, "gamma-source");
    await fs.mkdir(otherCandidatePath);
    await fs.mkdir(matchedSourcePath);
    let snapshots = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [
              candidate(),
              candidate({ sourcePath: otherCandidatePath, name: "beta", token: "beta-token" }),
            ],
            matchedProjects: [
              {
                sourcePath: matchedSourcePath,
                projectPath: path.join(tempDir, "gamma-local"),
                localMemoryDir: "g-abc",
              },
            ],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    for (const targetPath of [otherCandidatePath, matchedSourcePath]) {
      // Registering it would make every later restore match the other entry there by exact
      // path, writing that entry's memory into this candidate's scope.
      const result = await service.restore(
        { ...SETTINGS, includeProjects: true },
        { projectImports: [{ token: "candidate-token", targetPath }] }
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("recorded path of another backed-up project");
      }
    }
    expect(snapshots).toBe(0);
  });

  test("refuses network and device import targets before probing them", async () => {
    let probes = 0;
    const realLstat = fs.lstat.bind(fs);
    const lstat = spyOn(fs, "lstat").mockImplementation(((target, options) => {
      probes += 1;
      return realLstat(target, options);
    }) as typeof fs.lstat);
    try {
      const service = createService(tempDir, {
        payload: createPayload({
          validateRestore: () =>
            Promise.resolve({
              hasProjectBundle: true,
              projectImports: [candidate()],
              matchedProjects: [],
            }),
        }),
      });
      for (const targetPath of [
        "\\\\attacker\\share\\repo",
        "//attacker/share/repo",
        "\\\\?\\C:\\x",
      ]) {
        const result = await service.restore(
          { ...SETTINGS, includeProjects: true },
          { projectImports: [{ token: "candidate-token", targetPath }] }
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toContain("network or device path");
        }
      }
      // A stat of a UNC path would already start SMB authentication.
      expect(probes).toBe(0);
    } finally {
      lstat.mockRestore();
    }
  });

  test("refuses two imports whose targets are aliases of one directory", async () => {
    const realParent = path.join(tempDir, "real");
    const target = path.join(realParent, "proj");
    await fs.mkdir(target, { recursive: true });
    const aliasParent = path.join(tempDir, "alias");
    await fs.symlink(realParent, aliasParent, "dir");
    const aliasTarget = path.join(aliasParent, "proj");
    let snapshots = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate(), candidate({ name: "beta", token: "beta-token" })],
            matchedProjects: [],
          }),
        writeSafetySnapshot: () => {
          snapshots += 1;
          return Promise.resolve();
        },
      }),
    });

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      {
        projectImports: [
          { token: "candidate-token", targetPath: target },
          { token: "beta-token", targetPath: aliasTarget },
        ],
      }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("another import already targets");
    }
    // Refused during planning: two backed-up projects would otherwise merge into one.
    expect(snapshots).toBe(0);
  });

  test("fails an import whose duplicate registration cannot be resolved to a path", async () => {
    const target = path.join(tempDir, "unresolved");
    await fs.mkdir(target);
    let imports = 0;
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => {
              imports += 1;
              return Promise.resolve({ writtenFiles: [], skippedFiles: [] });
            })
          ),
      }),
    });
    // Duplicate reported, but nothing in config matches the target or its real path.
    service.setProjectService(registrar(() => Promise.resolve(Err("Project already exists"))));

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const [imported] = result.data.projectImportResults;
      expect(imported).toMatchObject({ status: "failed", writtenFiles: [] });
      expect(imported?.message).toContain("already registered under a different path");
    }
    expect(imports).toBe(0);
  });

  test("reports the files a failed import had already written", async () => {
    const target = path.join(tempDir, "partial");
    await fs.mkdir(target);
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() =>
              Promise.reject(
                new ProjectMemoryWriteError("disk full", {
                  written: ["memory/project/alpha-abc/first.md"],
                  skipped: ["memory/project/alpha-abc/kept.md"],
                })
              )
            )
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => Promise.resolve(Ok({ normalizedPath: projectPath })))
    );

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      // The partial progress is the user's cleanup list; an empty list would claim the
      // failed import changed nothing.
      expect(result.data.projectImportResults[0]).toMatchObject({
        status: "failed",
        message: "disk full",
        writtenFiles: ["memory/project/alpha-abc/first.md"],
        skippedFiles: ["memory/project/alpha-abc/kept.md"],
      });
    }
  });

  test("carries the validated match set and the snapshot path into the restore", async () => {
    const seen: Array<{ snapshotPath: string; matched: readonly BackupMatchedProject[] }> = [];
    const snapshot = { root: null as string | null };
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [],
            matchedProjects: [matchedIdentity("/home/dev/src/alpha")],
          }),
        writeSafetySnapshot: (root) => {
          snapshot.root = root;
          return Promise.resolve();
        },
        restore: (options) => {
          seen.push({ snapshotPath: options.snapshotPath, matched: options.matchedProjects });
          return Promise.resolve({
            changedFiles: [],
            localOnlyFiles: [],
            projectBundleSkipped: false,
            restoredProjectMemory: [],
          });
        },
      }),
    });

    expect((await service.restore({ ...SETTINGS, includeProjects: true })).success).toBe(true);
    // The store re-partitions the bundle itself but must only write what validation (and
    // therefore the snapshot) covered, into the same snapshot directory.
    const snapshotRoot = snapshot.root;
    if (snapshotRoot === null) throw new Error("Expected the safety snapshot to be written");
    expect(seen).toEqual([
      { snapshotPath: snapshotRoot, matched: [matchedIdentity("/home/dev/src/alpha")] },
    ]);
  });

  test("announces restored and imported project memory to the memory notifier", async () => {
    const target = path.join(tempDir, "imported");
    await fs.mkdir(target);
    const notified: string[] = [];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [matchedIdentity("/home/dev/src/matched")],
          }),
        restore: () =>
          Promise.resolve({
            changedFiles: ["memory/project/matched-abc/deep/notes.md"],
            localOnlyFiles: [],
            projectBundleSkipped: false,
            restoredProjectMemory: [
              {
                projectPath: "/home/dev/src/matched",
                files: ["memory/project/matched-abc/deep/notes.md"],
              },
            ],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() =>
              Promise.resolve({
                writtenFiles: ["memory/project/imported-def/todo.md"],
                skippedFiles: [],
              })
            )
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => Promise.resolve(Ok({ normalizedPath: projectPath })))
    );
    service.setMemoryNotifier({
      notifyExternalProjectChange: (projectPath) => {
        notified.push(projectPath);
      },
    });

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    // One event per project, not per file.
    expect(notified).toEqual(["/home/dev/src/matched", target]);
  });

  test("records the restored commit before running imports so their results survive", async () => {
    const target = path.join(tempDir, "imported");
    await fs.mkdir(target);
    const events: string[] = [];
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [candidate()],
            matchedProjects: [],
          }),
        prepareProjectImports: () =>
          Promise.resolve(
            importsWith(() => {
              events.push(`import:${config.state.settingsBackup?.lastRestoredCommit ?? "none"}`);
              return Promise.resolve({
                writtenFiles: ["memory/project/alpha-abc/notes.md"],
                skippedFiles: [],
              });
            })
          ),
      }),
    });
    service.setProjectService(
      registrar((projectPath) => Promise.resolve(Ok({ normalizedPath: projectPath })))
    );
    expect((await service.saveSettings({ ...SETTINGS, includeProjects: true })).success).toBe(true);

    const result = await service.restore(
      { ...SETTINGS, includeProjects: true },
      { projectImports: [{ token: "candidate-token", targetPath: target }] }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectImportResults[0]?.status).toBe("imported");
    }
    // The commit was already persisted when the import ran: no config write can fail
    // afterwards and discard the import results, which the snapshot cannot undo.
    expect(events).toEqual(["import:remote-commit"]);
  });

  test("announces restored memory even when recording the commit fails afterwards", async () => {
    const notified: string[] = [];
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [],
            matchedProjects: [matchedIdentity("/home/dev/src/alpha")],
          }),
        restore: () =>
          Promise.resolve({
            changedFiles: ["memory/project/alpha-abc/notes.md"],
            localOnlyFiles: [],
            projectBundleSkipped: false,
            restoredProjectMemory: [
              { projectPath: "/home/dev/src/alpha", files: ["memory/project/alpha-abc/notes.md"] },
            ],
          }),
      }),
    });
    service.setMemoryNotifier({
      notifyExternalProjectChange: (projectPath) => {
        notified.push(projectPath);
      },
    });
    expect((await service.saveSettings({ ...SETTINGS, includeProjects: true })).success).toBe(true);
    // config.json stops accepting writes after the restore has already landed on disk.
    spyOn(config, "editConfig").mockImplementation(() => Promise.resolve());

    const result = await service.restore({ ...SETTINGS, includeProjects: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("IO_ERROR");
      expect(result.error.snapshotPath).toBeDefined();
    }
    // Restored memory was on disk before the persist step failed.
    expect(notified).toEqual(["/home/dev/src/alpha"]);
  });

  test("announces memory a failed matched restore already wrote", async () => {
    const notified: string[] = [];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () =>
          Promise.resolve({
            hasProjectBundle: true,
            projectImports: [],
            matchedProjects: [
              matchedIdentity("/home/dev/src/alpha"),
              matchedIdentity("/home/dev/src/beta"),
            ],
          }),
        restore: () =>
          Promise.reject(
            new ProjectMemoryRestoreError("EIO: disk fault", [
              { projectPath: "/home/dev/src/alpha", files: ["memory/project/alpha-abc/notes.md"] },
            ])
          ),
      }),
    });
    service.setMemoryNotifier({
      notifyExternalProjectChange: (projectPath) => {
        notified.push(projectPath);
      },
    });

    const result = await service.restore({ ...SETTINGS, includeProjects: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("disk fault");
      expect(result.error.snapshotPath).toBeDefined();
      // Newly created files are not in the snapshot; the error is the cleanup list.
      expect(result.error.files).toEqual(["memory/project/alpha-abc/notes.md"]);
    }
    // Disk changed for alpha even though the restore failed on beta.
    expect(notified).toEqual(["/home/dev/src/alpha"]);
  });

  test("keeps the restore half of a preview when the export half fails", async () => {
    const fresh = candidate();
    let pushChangeLookups = 0;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        getPushChanges: () => {
          pushChangeLookups += 1;
          return Promise.resolve([]);
        },
      }),
      payload: createPayload({
        previewRestore: () =>
          Promise.resolve({
            changes: [{ status: "M", path: "AGENTS.md" }],
            localOnlyFiles: [],
            commandApprovals: [],
            projectImports: [fresh],
            projectBundleSkipped: false,
          }),
        exportTo: () => Promise.reject(new Error("Backup has more than 256 projects")),
      }),
    });

    const result = await service.preview({ ...SETTINGS, includeProjects: true });

    expect(result.success).toBe(true);
    if (result.success) {
      // The import tokens a cross-machine restore needs survive a local export problem.
      expect(result.data.projectImports).toEqual([fresh]);
      expect(result.data.restoreChanges).toEqual([{ status: "M", path: "AGENTS.md" }]);
      expect(result.data.pushError).toContain("more than 256 projects");
      expect(result.data.pushChanges).toEqual([]);
    }
    // No export landed in the checkout, so there is nothing to diff.
    expect(pushChangeLookups).toBe(0);
  });

  test("keeps a concurrently saved project-backup toggle when recording a commit", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
      gitRepo: createGitRepo({
        commitAndPush: () => {
          // Another window saved the same repository with the toggle flipped while this
          // push was running against the old settings.
          config.state = {
            ...config.state,
            settingsBackup: { ...SETTINGS, includeProjects: true },
          };
          return Promise.resolve({
            commit: "pushed-commit",
            changed: true,
            credential: "gh" as const,
          });
        },
      }),
    });
    expect((await service.saveSettings(SETTINGS)).success).toBe(true);

    expect((await service.push(SETTINGS)).success).toBe(true);

    // Recording the commit must not revert the newer save to the stale in-flight value.
    expect(service.getSettings()).toEqual({
      ...SETTINGS,
      includeProjects: true,
      lastPushedCommit: "pushed-commit",
    });
  });
});
