import * as path from "node:path";
import { listBackupManagedPathSpellings } from "@/common/compat/legacyMux";
import { VERSION } from "@/version";
import type { Config } from "@/node/config";
import type { BackupFileChange, BackupProjectImport } from "@/common/orpc/schemas/backup";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import {
  MAX_BACKUP_PROJECT_ENTRIES,
  MAX_BACKUP_PROJECT_PATH_CHARS,
  sanitizeBackupGitRemote,
  type BackupProjectBundleEntry,
} from "@/common/config/schemas/settingsBackup";
import { log } from "@/node/services/log";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { isSystemProjectEntry } from "@/common/utils/systemProjects";
import type { ProjectConfig } from "@/common/types/project";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import { projectMemoryDirName } from "@/node/services/memoryService";
import {
  memoryMutationLockKey,
  withTargetMutationLock,
} from "@/node/services/refinement/targetMutationLocks";
import {
  type ProjectRegistrationLockHandle,
  withProjectRegistrationLock,
} from "@/node/config/projectRegistrationLock";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayloadStore,
  type PreparedBackupRepository,
} from "./backupService";
import { BACKUP_GIT_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { BackupRepoCache } from "./gitRepo";
import {
  PROJECT_BUNDLE_DIR,
  PROJECT_BUNDLE_MANIFEST_PATH,
  ProjectMemoryRestoreError,
  ProjectMemoryWriteError,
  assertManagedTreeWithinLimits,
  assertProjectMemoryWritesAllowed,
  backupPayloadExists,
  bundleEntryFiles,
  collectOverwritableProjectMemory,
  matchedProjectWrites,
  readProjectMemoryOrigins,
  serializeProjectBundleManifest,
  writeProjectMemoryOrigin,
  collectProjectBundle,
  planProjectBundleRestore,
  projectBundleExists,
  projectImportToken,
  readProjectBundle,
  rekeyProjectMemoryPath,
  resolveContainedPath,
  writeProjectBundle,
  writeProjectMemoryFiles,
  assertBackupCommandsApproved,
  collectMcpCommandApprovals,
  resolveRestoredContent,
  collectAllowlistedFiles,
  createBackupPayload,
  mergeBackupPreferences,
  projectBackupPreferences,
  localOnlyPayloadFiles,
  planRestoreWrites,
  readBackupPayload,
  restoreBackupPayload,
  backupSecretApprovalDigest,
  scanBackupFilesForSecrets,
  serializeBackupPreferences,
  writeBackupPayload,
  type BackupFile,
  type BackupProjectBundle,
  type MatchedProjectEntry,
  type ProjectBundleRestorePlan,
} from "./payload";

/**
 * Parses `git status --porcelain=v1 -z`, whose records are NUL-terminated with verbatim
 * pathnames. A rename or copy spends a second record on its source path, which is consumed
 * here rather than reported: the destination is what a push writes.
 */
function parsePorcelainStatus(output: string): BackupFileChange[] {
  const records = output.split("\0").filter(Boolean);
  const changes: BackupFileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2).trim() || "?";
    changes.push({ status, path: record.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * BackupService prepares the cache before push-related calls. Retaining that instance
 * preserves the fetched base commit used by the push guard.
 */
export function createBackupGitRepo(options: {
  cacheRoot: string;
  timeoutMs?: number;
}): BackupGitRepo {
  const prepared = new WeakMap<PreparedBackupRepository, BackupRepoCache>();

  function newCache(settings: { repoUrl: string; branch: string; path: string }): BackupRepoCache {
    return new BackupRepoCache({
      ...settings,
      managedPath: settings.path,
      cacheRoot: options.cacheRoot,
      timeoutMs: options.timeoutMs ?? BACKUP_GIT_TIMEOUT_MS,
    });
  }

  function cacheFor(repository: PreparedBackupRepository): BackupRepoCache {
    const cache = prepared.get(repository);
    if (!cache) throw new Error("Backup repository was not prepared");
    return cache;
  }

  return {
    async validate(settings) {
      const cache = newCache(settings);
      const refs = await cache.lsRemote();
      return { credential: refs.credential, empty: refs.refs.size === 0 };
    },

    async prepare(settings, options) {
      const cache = newCache(settings);
      let remoteCommit: string | null;
      try {
        remoteCommit = await cache.materialize();
      } catch (error) {
        const cleanup = options?.onPrepareError?.(cache.cachePath);
        await cleanup?.catch(() => undefined);
        throw error;
      }
      const repository = {
        rootDir: cache.cachePath,
        credential: cache.credential ?? "ambient",
        remoteCommit,
        managedPath: cache.effectiveManagedPath,
      };
      prepared.set(repository, cache);
      return repository;
    },

    async getPushChanges(repository) {
      return parsePorcelainStatus(await cacheFor(repository).porcelainStatus());
    },

    async commitAndPush(repository, commitOptions) {
      const cache = cacheFor(repository);
      const commit = await cache.stageAndCommit(commitOptions.message);
      if (commit == null) {
        // Nothing to commit, but the remote may have moved since prepare(). Reporting
        // "unchanged" without checking would persist a commit that no longer describes
        // the repository, and this path never reaches the check inside push().
        await cache.assertRemoteUnchanged();
        return {
          commit: commitOptions.expectedRemoteCommit ?? "",
          changed: false,
          credential: cache.credential ?? repository.credential,
        };
      }
      const commitSha = await cache.push();
      return {
        commit: commitSha,
        changed: true,
        credential: cache.credential ?? repository.credential,
      };
    },
  };
}

/**
 * `muxVersion` is provenance only, but writing it as undefined drops the key from the
 * manifest and makes the backup unreadable, so never let a missing build stamp through.
 */
function resolveMuxVersion(): string {
  const describe: unknown = VERSION.git_describe;
  return typeof describe === "string" && describe.length > 0 ? describe : "unknown";
}

/**
 * Bridges payload collection to the service-level contract. Preferences are read
 * from and written through `Config` rather than the config file so restores reuse
 * schema validation and reach open windows through the existing change stream.
 */
function sameMode(a: BackupFile, b: BackupFile): boolean {
  return (a.executable === true) === (b.executable === true);
}

/**
 * Names every spelling that was considered, so the error explains the legacy fallback.
 * The repository preparation selects the legacy `mux` spelling whenever it holds a
 * manifest and the configured spelling does not, so reaching this with the configured
 * path means the legacy spelling was checked and held no backup either.
 */
function describeMissingBackup(managedPath: string): string {
  const [, ...legacySpellings] = listBackupManagedPathSpellings(managedPath);
  const fallbacks = legacySpellings.map((spelling) => `'${spelling}'`).join(" or ");
  return fallbacks === ""
    ? `No Xum backup found in '${managedPath}' on this branch`
    : `No Xum backup found in '${managedPath}' or legacy ${fallbacks} on this branch`;
}

/** Concurrent `git remote get-url` probes during bundle export. */
const REMOTE_DISCOVERY_CONCURRENCY = 8;
/** Per-probe ceiling and the deadline for the whole discovery pass; remotes are hints, not requirements. */
const REMOTE_PROBE_TIMEOUT_MS = 5_000;
const REMOTE_DISCOVERY_DEADLINE_MS = 20_000;

/** Best-effort: a missing origin, a non-git directory, or a hung git must never fail an export. */
async function readProjectGitRemote(
  projectPath: string,
  timeoutMs: number
): Promise<string | undefined> {
  if (timeoutMs <= 0) return undefined;
  try {
    using gitProcess = execFileAsync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
      timeoutMs,
      maxOutputBytes: 64 * 1024,
      killTreeOnTermination: true,
    });
    const { stdout } = await gitProcess.result;
    return sanitizeBackupGitRemote(stdout.trim());
  } catch {
    return undefined;
  }
}

export function createBackupPayloadStore(options: { config: Config }): BackupPayloadStore {
  const muxRoot = options.config.rootDir;

  // Walks the chain so a symlinked ancestor is rejected before writeBackupPayload's
  // recursive removal could follow it out of the cache clone.
  async function managedDir(repositoryRoot: string, managedPath: string): Promise<string> {
    const segments = managedPath.split("/").filter((segment) => segment !== "");
    return await resolveContainedPath(repositoryRoot, segments.join("/"));
  }

  function localPreferences() {
    return options.config.loadConfigOrDefault().userPreferences;
  }

  /** The portable subset an export writes. Machine-local keys are excluded by design. */
  function exportablePreferences() {
    return projectBackupPreferences(localPreferences() ?? {});
  }

  async function localFilesByPath(): Promise<Map<string, BackupFile>> {
    return new Map((await collectAllowlistedFiles(muxRoot)).map((file) => [file.path, file]));
  }

  async function buildPayload(overrides?: { keepLocalSecrets: true }) {
    return await createBackupPayload({
      muxRoot,
      preferences: exportablePreferences(),
      muxVersion: resolveMuxVersion(),
      sourceLabel: path.basename(muxRoot),
      // The service owns the user-facing override, so report rather than throw.
      reportSecrets: true,
      ...overrides,
    });
  }

  /**
   * The same lock MemoryService mutations take (its project stores resolve to the shared
   * `<muxRoot>/memory` key), so backup never becomes an uncoordinated memory writer.
   */
  function withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
    return withTargetMutationLock(
      muxRoot,
      memoryMutationLockKey(muxRoot, path.join(muxRoot, "memory")),
      operation
    );
  }

  /**
   * The registered projects the bundle can carry: user projects (system entries keep no
   * memory) whose path fits the manifest schema — registration itself caps nothing, and a
   * path past the cap has no valid manifest entry; such a project stays local rather than
   * failing every push for all the others, and counts toward nothing here (the entry cap,
   * remote discovery) since it will not be in the bundle.
   */
  function userProjects(): Array<[string, ProjectConfig]> {
    return [...options.config.loadConfigOrDefault().projects.entries()].filter(
      ([projectPath, projectConfig]) =>
        !isSystemProjectEntry(projectPath, projectConfig) &&
        projectPath.length <= MAX_BACKUP_PROJECT_PATH_CHARS
    );
  }

  /** The user projects userProjects leaves out, for saying so once per export. */
  function unsupportedUserProjects(): string[] {
    return [...options.config.loadConfigOrDefault().projects.entries()]
      .filter(
        ([projectPath, projectConfig]) =>
          !isSystemProjectEntry(projectPath, projectConfig) &&
          projectPath.length > MAX_BACKUP_PROJECT_PATH_CHARS
      )
      .map(([projectPath]) => projectPath);
  }

  /**
   * The registry as a remote-discovery pass saw it. Remote hints are keyed by path and found
   * outside the registration lock; a project removed and another registered at the same path
   * during discovery would otherwise carry the removed project's remote into the new
   * project's entry. The listing under the lock uses the hints only if nothing has been
   * written to the registry since: the config file's write generation differs for every save
   * — so a removal and a re-registration with identical config, invisible in the content, is
   * seen — and the content is compared too. Conservative by design, since config records no
   * per-registration identity: any write in the window costs this export its hints, never
   * gives an entry a wrong one.
   */
  async function registrySnapshot(): Promise<string> {
    return `${await options.config.configFileWriteGeneration()}\0${JSON.stringify(userProjects())}`;
  }

  /**
   * Remote hints for the registered user projects, discovered outside any lock: each probe
   * has its own timeout, so sequential discovery over many projects on slow filesystems
   * could stall a preview or push for minutes; bounded parallelism plus one deadline for the
   * whole pass caps the wait regardless of the project count. Projects probed after the
   * deadline simply record no remote.
   */
  async function discoverProjectRemotes(): Promise<{
    remotes: Map<string, string | undefined>;
    registry: string;
  }> {
    for (const projectPath of unsupportedUserProjects()) {
      log.warn(
        `Settings backup: not backing up project '${projectPath.slice(0, 80)}…': its path is longer than ${MAX_BACKUP_PROJECT_PATH_CHARS} characters`
      );
    }
    const registry = await registrySnapshot();
    const projects = userProjects();
    // Before any lookup: an over-limit config would otherwise run every remote probe
    // only to be refused by the bundle collector afterwards.
    if (projects.length > MAX_BACKUP_PROJECT_ENTRIES) {
      throw new Error(`Backup has more than ${MAX_BACKUP_PROJECT_ENTRIES} projects`);
    }
    const probes = new AsyncSemaphore(REMOTE_DISCOVERY_CONCURRENCY);
    const deadline = Date.now() + REMOTE_DISCOVERY_DEADLINE_MS;
    const remotes = new Map<string, string | undefined>();
    await Promise.all(
      projects.map(async ([projectPath]) => {
        const slot = await probes.acquire();
        try {
          remotes.set(
            projectPath,
            await readProjectGitRemote(
              projectPath,
              Math.min(REMOTE_PROBE_TIMEOUT_MS, deadline - Date.now())
            )
          );
        } finally {
          slot.release();
        }
      })
    );
    return { remotes, registry };
  }

  /**
   * Every user project becomes an entry, including zero-memory ones: the project list is
   * half the feature. `memoryDir` records this install's actual directory name, which is
   * also what restore-side matching recomputes. Listed from the registry as it is now —
   * the caller holds the registration lock — so the bundle names exactly the projects
   * registered when it is written, not the ones registered when the (long) remote
   * discovery began; a project added since carries no remote hint, one removed since is
   * gone along with its memory.
   */
  async function listProjectBundleEntries(discovered: {
    remotes: ReadonlyMap<string, string | undefined>;
    registry: string;
  }): Promise<BackupProjectBundleEntry[]> {
    const projects = userProjects();
    if (projects.length > MAX_BACKUP_PROJECT_ENTRIES) {
      throw new Error(`Backup has more than ${MAX_BACKUP_PROJECT_ENTRIES} projects`);
    }
    // See registrySnapshot: hints found for a registry written to since are dropped.
    const remotes = discovered.registry === (await registrySnapshot()) ? discovered.remotes : null;
    if (remotes === null) {
      log.debug("Settings backup: projects changed during remote discovery; omitting remote hints");
    }
    return projects.map(([projectPath, projectConfig]) => {
      const gitRemote = remotes?.get(projectPath);
      return {
        path: projectPath,
        // Clamped to the manifest schema's cap so a long custom title cannot produce a
        // bundle this build's own restore would refuse.
        name: getProjectDisplayName(projectPath, projectConfig).slice(0, 256),
        ...(gitRemote !== undefined ? { gitRemote } : {}),
        memoryDir: projectMemoryDirName(projectPath),
      };
    });
  }

  function registeredProjectDirs(): Map<string, string> {
    return new Map(
      userProjects().map(([projectPath]) => [projectPath, projectMemoryDirName(projectPath)])
    );
  }

  function toProjectImports(plan: ProjectBundleRestorePlan): BackupProjectImport[] {
    // Remotes were already sanitized when the manifest was parsed, so a crafted checkout
    // cannot reach the UI through this field.
    return plan.imports.map(({ entry, files, token }) => ({
      sourcePath: entry.path,
      name: entry.name,
      ...(entry.gitRemote !== undefined ? { gitRemote: entry.gitRemote } : {}),
      memoryFileCount: files.length,
      token,
    }));
  }

  async function readBundleWithPlan(
    sourceDir: string
  ): Promise<{ bundle: BackupProjectBundle; plan: ProjectBundleRestorePlan } | null> {
    const bundle = await readProjectBundle(sourceDir);
    if (bundle === null) return null;
    const registered = registeredProjectDirs();
    return {
      bundle,
      plan: planProjectBundleRestore(
        bundle,
        registered,
        await readProjectMemoryOrigins(muxRoot, registered, bundleSourcePaths(bundle))
      ),
    };
  }

  function bundleSourcePaths(bundle: BackupProjectBundle): string[] {
    return bundle.manifest.projects.map((entry) => entry.path);
  }

  /** Restore-preview statuses for matched entries, diffed against the local memory files. */
  async function matchedProjectChanges(
    plan: ProjectBundleRestorePlan
  ): Promise<BackupFileChange[]> {
    if (plan.matched.length === 0) return [];
    // Only the destinations the restore would write, under the memory lock like every
    // other backup read of project memory: a whole-directory read would let an unrelated
    // local-only note fail the preview, and a concurrent edit could tear the diff.
    const localBundle = await withMemoryLock(() =>
      collectOverwritableProjectMemory(muxRoot, plan.matched)
    );
    const localByPath = new Map(localBundle.files.map((file) => [file.path, file]));
    const changes: BackupFileChange[] = [];
    for (const match of plan.matched) {
      // Reported at the local destination, which differs from the bundle path for a
      // project matched through an earlier import.
      for (const write of matchedProjectWrites(match)) {
        const existing = localByPath.get(write.path);
        if (existing === undefined) {
          changes.push({ status: "A", path: write.path });
        } else if (!existing.content.equals(write.content)) {
          changes.push({ status: "M", path: write.path });
        }
      }
    }
    return changes;
  }

  return {
    async exportTo(exportOptions) {
      const payload = await buildPayload();
      const destination = await managedDir(exportOptions.repositoryRoot, exportOptions.managedPath);
      // Owner-only like the safety snapshot: the export copies allowlisted sources that may
      // themselves be owner-only, and it lands here before the secret scan has said anything
      // about it. Git records only the exec bit, so the modes never reach the remote.
      await writeBackupPayload(destination, payload, { ownerOnly: true });
      // The core write wiped the whole managed path, so with the toggle off a previously
      // pushed bundle disappears from the next tree, and with it on the sidecar is written
      // fresh after the core payload.
      let scanFiles = payload.files;
      if (exportOptions.includeProjects) {
        const discovered = await discoverProjectRemotes();
        // The project list is read, the memory collected, and the bundle written under the
        // registration lock (taken before the memory lock, the fixed order), so a project
        // registered or removed during the seconds of remote discovery above is reflected
        // and none can change between the listing and the bundle that publishes it. Memory
        // is collected under the memory lock so an agent writing memory mid-export cannot
        // produce a torn bundle or trip the collector's identity checks.
        const bundle = await withProjectRegistrationLock(muxRoot, async (registration) => {
          const entries = await listProjectBundleEntries(discovered);
          const collected = await withMemoryLock(() =>
            collectProjectBundle(
              muxRoot,
              entries,
              // Restore refuses files past the memory subsystem's read limit, so exporting
              // them would only produce a backup no build can bring back.
              { portableMemoryOnly: true }
            )
          );
          // Before the irreversible write: a hold lost while collecting (this process frozen
          // past the lease) would mean the list no longer describes the registered projects.
          await registration.assertStillOwned();
          await writeProjectBundle(path.join(destination, PROJECT_BUNDLE_DIR), collected, {
            ownerOnly: true,
          });
          return collected;
        });
        // Core and bundle were budgeted separately; the next checkout will bound them as
        // one tree, so refuse here what it would refuse there.
        await assertManagedTreeWithinLimits(destination);
        // One scan and one digest over everything the push would publish: core files,
        // bundle files, and the bundle manifest itself — project paths, names, and remotes
        // are published text too, and a token in a remote's path survives the URL
        // credential sanitizer.
        scanFiles = [
          ...payload.files,
          ...bundle.files,
          {
            path: PROJECT_BUNDLE_MANIFEST_PATH,
            content: serializeProjectBundleManifest(bundle.manifest),
          },
        ];
      }
      const secretFiles = scanBackupFilesForSecrets(scanFiles);
      return {
        redactions: payload.redactions,
        secretFiles,
        secretApproval: backupSecretApprovalDigest(scanFiles, secretFiles),
      };
    },

    async previewRestore(previewOptions) {
      const sourceDir = await managedDir(previewOptions.repositoryRoot, previewOptions.managedPath);
      const local = await localFilesByPath();
      // A repository with no backup yet is a normal first-run state, not an error:
      // nothing would be restored, and every local file is local-only.
      if (!(await backupPayloadExists(sourceDir))) {
        return {
          changes: [],
          localOnlyFiles: [...local.keys()].sort(),
          commandApprovals: [],
          projectImports: [],
          projectBundleSkipped: false,
        };
      }

      const payload = await readBackupPayload(sourceDir);
      // The preflight restore itself runs, so a destination this payload cannot be written to
      // fails here instead of after the user accepts a plan that cannot execute. Recomputed
      // rather than carried over to the restore, for the same reason the approvals are.
      await planRestoreWrites(muxRoot, payload);
      const restoredPaths = new Set(
        payload.files.filter((file) => file.path !== "preferences.json").map((file) => file.path)
      );
      const { localOnly, overwritten } = await localOnlyPayloadFiles(
        muxRoot,
        local.keys(),
        restoredPaths
      );
      const changes: BackupFileChange[] = [];
      for (const file of payload.files) {
        // Preferences live in config, and restore merges them rather than replacing the
        // file, so compare the merge result. A backup that only repeats values the local
        // config already holds changes nothing.
        if (file.path === "preferences.json") {
          const local = localPreferences();
          const merged = mergeBackupPreferences(local, JSON.parse(file.content.toString("utf-8")));
          if (!serializeBackupPreferences(local).equals(serializeBackupPreferences(merged))) {
            changes.push({ status: "M", path: file.path });
          }
          continue;
        }
        // Under a spelling the filesystem actually resolves this path to, so a restore that
        // overwrites a differently-cased local file reads as a change to it. Any alias will
        // do: they are one file, so they read the same content and mode.
        const existing = local.get(overwritten.get(file.path)?.[0] ?? file.path);
        if (!existing) {
          changes.push({ status: "A", path: file.path });
          continue;
        }
        // Diff what restore would write, not the raw backup: rehydrated redactions
        // would otherwise read as a change on every preview.
        const restored = await resolveRestoredContent(
          muxRoot,
          file,
          payload.manifest.mcpRedactions
        );
        if (!existing.content.equals(restored) || !sameMode(existing, file)) {
          changes.push({ status: "M", path: file.path });
        }
      }

      let projectImports: BackupProjectImport[] = [];
      let projectBundleSkipped = false;
      if (!previewOptions.includeProjects) {
        // Existence-only: with the toggle off the sidecar is never parsed, so a malformed
        // bundle cannot block a core-only preview.
        projectBundleSkipped = await projectBundleExists(sourceDir);
      } else {
        const bundlePlan = await readBundleWithPlan(sourceDir);
        if (bundlePlan !== null) {
          projectImports = toProjectImports(bundlePlan.plan);
          changes.push(...(await matchedProjectChanges(bundlePlan.plan)));
        }
      }
      return {
        changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
        localOnlyFiles: localOnly,
        commandApprovals: await collectMcpCommandApprovals(
          muxRoot,
          payload.files,
          payload.manifest.mcpRedactions
        ),
        projectImports,
        projectBundleSkipped,
      };
    },

    async validateRestore(validateOptions) {
      const sourceDir = await managedDir(
        validateOptions.repositoryRoot,
        validateOptions.managedPath
      );
      if (!(await backupPayloadExists(sourceDir))) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          describeMissingBackup(validateOptions.managedPath)
        );
      }
      const payload = await readBackupPayload(sourceDir);
      assertBackupCommandsApproved(
        await collectMcpCommandApprovals(muxRoot, payload.files, payload.manifest.mcpRedactions),
        validateOptions.approvedCommandTokens
      );
      // The same preflight the restore runs, so a payload it would refuse is refused here,
      // before the caller takes a safety snapshot it would have no use for.
      await planRestoreWrites(muxRoot, payload);
      if (!validateOptions.includeProjects) {
        return { hasProjectBundle: false, projectImports: [], matchedProjects: [] };
      }
      // A bundle the restore would refuse is refused here too, for the same reason.
      const bundlePlan = await readBundleWithPlan(sourceDir);
      if (bundlePlan === null) {
        return { hasProjectBundle: false, projectImports: [], matchedProjects: [] };
      }
      // The matched writes' own refusals (memory size and count limits, non-file
      // destinations) belong to the preflight too: found only inside the restore, they
      // would surface after the core settings were already overwritten.
      for (const match of bundlePlan.plan.matched) {
        await assertProjectMemoryWritesAllowed(muxRoot, matchedProjectWrites(match), {
          addOnly: false,
        });
      }
      // So does the recovery copy: a destination that cannot be snapshotted (a local file
      // past the backup budgets) refuses the restore here, not after the core writes. The
      // restore takes the real snapshot again inside its lock window.
      if (bundlePlan.plan.matched.length > 0) {
        await withMemoryLock(() =>
          collectOverwritableProjectMemory(muxRoot, bundlePlan.plan.matched)
        );
      }
      return {
        hasProjectBundle: true,
        projectImports: toProjectImports(bundlePlan.plan),
        // The classification the caller validated against, destination included. Restore
        // re-partitions the bundle but only writes entries that resolve to the very same
        // local project here, so neither a project registered mid-restore nor a fallback
        // to a different origin can be written outside the plan the snapshot covered.
        matchedProjects: bundlePlan.plan.matched.map((match) => ({
          sourcePath: match.entry.path,
          projectPath: match.projectPath,
          localMemoryDir: match.localMemoryDir,
        })),
      };
    },

    async writeSafetySnapshot(snapshotRoot) {
      // Unredacted: this copy never leaves the machine, and a redacted snapshot could
      // not restore a credential whose MCP server the restore removed.
      // Project memory is intentionally absent here: restore snapshots exactly the
      // matched entries it will overwrite, inside the same memory-lock window as the
      // write, so nothing can edit a file between its snapshot bytes and its overwrite.
      await writeBackupPayload(snapshotRoot, await buildPayload({ keepLocalSecrets: true }), {
        portable: false,
        ownerOnly: true,
      });
    },

    async restore(restoreOptions) {
      const sourceDir = await managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath);
      const payload = await readBackupPayload(sourceDir);
      const before = await localFilesByPath();

      const restoreCore = async (
        registration: ProjectRegistrationLockHandle | null
      ): Promise<{ localOnlyFiles: string[] }> => {
        const result = await restoreBackupPayload({
          muxRoot,
          payload,
          approvedCommandTokens: restoreOptions.approvedCommandTokens,
        });
        if (result.backupPreferences !== undefined) {
          let merged: ReturnType<typeof normalizeUserPreferences> | undefined;
          await options.config.editConfig(
            (current) => {
              // Merged against the config this edit reads, not a snapshot taken before the
              // restore: a whole-object write would otherwise discard preferences another
              // window saved meanwhile, including the machine-local keys no backup carries.
              merged = normalizeUserPreferences(
                mergeBackupPreferences(current.userPreferences, result.backupPreferences)
              );
              return { ...current, userPreferences: merged };
            },
            // Inside the project restore's registration window the edit must ride that
            // window's hold: taking its own would wait on itself.
            registration === null ? {} : { withinRegistrationLock: registration }
          );
          // saveConfig logs and swallows write failures, so a resolved edit does not prove
          // the preferences landed. Compared through the backup projection because every
          // key a restore can change is portable, so a lost write is visible there, while
          // machine-local keys the load path normalizes differently stay out of the check.
          const stored = options.config.loadConfigOrDefault().userPreferences;
          if (
            merged !== undefined &&
            !serializeBackupPreferences(stored ?? {}).equals(serializeBackupPreferences(merged))
          ) {
            throw new BackupServiceError(
              "IO_ERROR",
              "The restored preferences could not be written to config.json"
            );
          }
        }
        return { localOnlyFiles: result.localOnlyFiles };
      };

      let projectBundleSkipped = false;
      const restoredProjectMemory: Array<{ projectPath: string; files: string[] }> = [];
      const memoryChanges: string[] = [];
      let core: { localOnlyFiles: string[] };
      // The bundle itself is read here — the repo lock holds the checkout stable — but its
      // plan is computed inside the memory lock below, where the inputs it depends on are.
      const bundle = restoreOptions.includeProjects ? await readProjectBundle(sourceDir) : null;
      if (bundle === null) {
        // Existence-only, like the preview: a malformed sidecar must never block a
        // core-only restore, but its presence is reported so the skip is visible.
        projectBundleSkipped =
          !restoreOptions.includeProjects && (await projectBundleExists(sourceDir));
        core = await restoreCore(null);
      } else {
        // Only entries the caller validated as matched, to the very same destination. A
        // project registered at its recorded path since validation was previewed as an
        // import and is not covered by the snapshot, so it must not be overwritten here.
        const matchKey = (sourcePath: string, projectPath: string, localMemoryDir: string) =>
          `${sourcePath}\0${projectPath}\0${localMemoryDir}`;
        const planKey = (match: MatchedProjectEntry) =>
          matchKey(match.entry.path, match.projectPath, match.localMemoryDir);
        const validatedMatched = new Set(
          restoreOptions.matchedProjects.map((match) =>
            matchKey(match.sourcePath, match.projectPath, match.localMemoryDir)
          )
        );
        // One lock window from the memory preflight through the matched write, entered
        // before the core settings change: an in-app memory edit between the caller's
        // preflight and this point can no longer turn a still-valid plan into a failure
        // discovered only after the core files were already overwritten, and nothing can
        // edit a file between its snapshot bytes and its overwrite. The registration lock
        // is taken first (the fixed order; `ProjectService.remove` takes only it) and holds
        // project unregistration off for the same window, so the registration read below
        // stays true until the matched memory has landed.
        core = await withProjectRegistrationLock(muxRoot, (registration) =>
          withMemoryLock(async () => {
            // The plan is recomputed at the write boundary, from registration and the origin
            // markers as they are now: origin markers are written under the memory lock (by
            // an import) and registration cannot change under the registration lock, so a
            // project re-pointed at another source or unregistered since validation no
            // longer matches the old entry here, and what matches here is what gets written.
            const registered = registeredProjectDirs();
            const plan = planProjectBundleRestore(
              bundle,
              registered,
              await readProjectMemoryOrigins(muxRoot, registered, bundleSourcePaths(bundle))
            );
            const matched = plan.matched.filter((match) => validatedMatched.has(planKey(match)));
            // A validated match that no longer writes — its project unregistered since, or
            // resolved to a different local project now — is refused rather than dropped:
            // the caller reports unapproved candidates from its validation, so a silently
            // omitted entry would leave a "completed" restore with that project's memory
            // neither written nor offered. Nothing has changed yet; a new preview re-offers it.
            const stillMatched = new Set(matched.map(planKey));
            const dropped = restoreOptions.matchedProjects.find(
              (match) =>
                !stillMatched.has(
                  matchKey(match.sourcePath, match.projectPath, match.localMemoryDir)
                )
            );
            if (dropped !== undefined) {
              throw new BackupServiceError(
                "IO_ERROR",
                `Cannot restore: the project registration for '${dropped.projectPath}' changed since the restore was validated; preview again to continue`
              );
            }
            if (matched.length > 0) {
              for (const match of matched) {
                await assertProjectMemoryWritesAllowed(muxRoot, matchedProjectWrites(match), {
                  addOnly: false,
                });
              }
              // Exactly the files these writes can overwrite: not whole project directories,
              // whose unrelated local-only notes neither need covering nor may fail the
              // restore, and never other registered projects.
              const localBundle = await collectOverwritableProjectMemory(muxRoot, matched);
              await writeProjectBundle(
                path.join(restoreOptions.snapshotPath, PROJECT_BUNDLE_DIR),
                localBundle,
                { portable: false, ownerOnly: true }
              );
            }
            // Before each irreversible step: this process must still hold the registration
            // lock, or the registration read above may no longer describe the project set.
            await registration.assertStillOwned();
            const coreResult = await restoreCore(registration);
            // Matched entries restore verbatim, exactly what the preview promised. Imports
            // are executed separately by the service, after project registration.
            for (const match of matched) {
              let written: string[];
              try {
                await registration.assertStillOwned();
                written = (
                  await writeProjectMemoryFiles(muxRoot, matchedProjectWrites(match), {
                    addOnly: false,
                  })
                ).written;
              } catch (error) {
                // Files written so far — earlier entries and this one's partial progress —
                // are on disk; the failure must still announce them.
                if (error instanceof ProjectMemoryWriteError && error.written.length > 0) {
                  restoredProjectMemory.push({
                    projectPath: match.projectPath,
                    files: error.written,
                  });
                }
                throw new ProjectMemoryRestoreError(
                  error instanceof Error ? error.message : String(error),
                  restoredProjectMemory,
                  { cause: error }
                );
              }
              if (written.length > 0) {
                memoryChanges.push(...written);
                restoredProjectMemory.push({ projectPath: match.projectPath, files: written });
              }
            }
            return coreResult;
          })
        );
      }

      const after = await localFilesByPath();
      const changedFiles = [...after.entries()]
        .filter(([file, current]) => {
          const previous = before.get(file);
          return !previous?.content.equals(current.content) || !sameMode(previous, current);
        })
        .map(([file]) => file);
      return {
        changedFiles: [...changedFiles, ...memoryChanges].sort(),
        localOnlyFiles: core.localOnlyFiles,
        projectBundleSkipped,
        restoredProjectMemory,
      };
    },

    async prepareProjectImports(prepareOptions) {
      const sourceDir = await managedDir(prepareOptions.repositoryRoot, prepareOptions.managedPath);
      const bundle = await readProjectBundle(sourceDir);
      if (bundle === null) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          "The backup no longer carries a project bundle"
        );
      }
      // Tokens computed once for the parsed bundle: the repo lock has held the checkout
      // stable since the service validated it, so per-import rehashing would only repeat
      // this work.
      const entriesByToken = new Map(
        bundle.manifest.projects.map((entry) => [projectImportToken(entry, bundle.files), entry])
      );
      // Token lookup rather than trusting any caller-named entry: the token binds the
      // approval to the exact entry and content, so a miss here is defensive only.
      const entryFor = (token: string): BackupProjectBundleEntry => {
        const entry = entriesByToken.get(token);
        if (entry === undefined) {
          throw new BackupServiceError(
            "INVALID_BACKUP",
            "The approved project import no longer matches the backup"
          );
        }
        return entry;
      };
      const rekeyedWrites = (importOptions: { token: string; targetPath: string }) => {
        const entry = entryFor(importOptions.token);
        const targetDir = projectMemoryDirName(importOptions.targetPath);
        return bundleEntryFiles(bundle.files, entry).map((file) => ({
          path: rekeyProjectMemoryPath(file.path, targetDir),
          content: file.content,
        }));
      };
      return {
        async assertProjectMemoryAllowed(importOptions) {
          await assertProjectMemoryWritesAllowed(muxRoot, rekeyedWrites(importOptions), {
            addOnly: true,
          });
        },
        async importProjectMemory(importOptions) {
          const entry = entryFor(importOptions.token);
          const targetDir = projectMemoryDirName(importOptions.targetPath);
          const { written, skipped } = await withMemoryLock(async () => {
            const result = await writeProjectMemoryFiles(muxRoot, rekeyedWrites(importOptions), {
              addOnly: true,
            });
            // From now on this project is the local identity of the recorded source: later
            // restores match it and can update its memory instead of re-offering an
            // add-only import that can never change an existing file. Only once every file
            // landed, though: a matched restore overwrites, so recording the origin over
            // skipped conflicts would let the next restore replace exactly the local files
            // this import promised to leave alone. Until the conflicts are resolved, the
            // source stays an import candidate.
            if (result.skipped.length > 0) return result;
            try {
              await writeProjectMemoryOrigin(muxRoot, targetDir, entry.path);
            } catch (error) {
              // The memory files are already on disk; the failure must keep reporting them.
              throw new ProjectMemoryWriteError(
                error instanceof Error ? error.message : String(error),
                result,
                { cause: error }
              );
            }
            return result;
          });
          return { writtenFiles: written, skippedFiles: skipped };
        },
      };
    },
  };
}
