import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import { isSystemProjectEntry } from "@/common/utils/systemProjects";
import { MAX_BACKUP_PROJECT_PATH_CHARS } from "@/common/config/schemas/settingsBackup";
import {
  BackupOperationErrorSchema,
  type BackupCommandApproval,
  type BackupCredentialKind,
  type BackupFileChange,
  type BackupOperationError,
  type BackupProjectImport,
  type BackupProjectImportResult,
} from "@/common/orpc/schemas/backup";
import {
  SettingsBackupInputSchema,
  type SettingsBackup,
  type SettingsBackupInput,
} from "@/common/config/schemas/settingsBackup";
import {
  assertNotSymlink,
  backupCacheName,
  discardBackupCache,
  isBackupCacheName,
  reapDiscardedBackupCaches,
} from "./gitRepo";
import {
  BackupCommandApprovalRequiredError,
  BackupProjectImportApprovalRequiredError,
  ProjectMemoryRestoreError,
  ProjectMemoryWriteError,
} from "./payload";

export interface PreparedBackupRepository {
  rootDir: string;
  credential: BackupCredentialKind;
  remoteCommit: string | null;
  /**
   * The managed path the prepared cache actually holds: the configured spelling, or its
   * legacy `mux` spelling when only that tree carries a backup manifest (backups pushed
   * before the product rename). Payload reads and writes must use this path — only this
   * tree is materialized, validated, and staged.
   */
  managedPath: string;
}

export interface BackupGitRepo {
  validate(settings: SettingsBackupInput): Promise<{
    credential: BackupCredentialKind;
    empty: boolean;
  }>;
  prepare(
    settings: SettingsBackupInput,
    options?: { onPrepareError?(repositoryRoot: string): Promise<void> }
  ): Promise<PreparedBackupRepository>;
  getPushChanges(repository: PreparedBackupRepository): Promise<BackupFileChange[]>;
  commitAndPush(
    repository: PreparedBackupRepository,
    options: {
      message: string;
      expectedRemoteCommit: string | null;
    }
  ): Promise<{ commit: string; changed: boolean; credential: BackupCredentialKind }>;
}

export interface BackupPayloadStore {
  exportTo(options: {
    repositoryRoot: string;
    managedPath: string;
    includeProjects: boolean;
  }): Promise<{ redactions: string[]; secretFiles: string[]; secretApproval: string }>;
  previewRestore(options: {
    repositoryRoot: string;
    managedPath: string;
    includeProjects: boolean;
  }): Promise<{
    changes: BackupFileChange[];
    localOnlyFiles: string[];
    commandApprovals: BackupCommandApproval[];
    projectImports: BackupProjectImport[];
    projectBundleSkipped: boolean;
  }>;
  validateRestore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
    includeProjects: boolean;
  }): Promise<{
    hasProjectBundle: boolean;
    projectImports: BackupProjectImport[];
    /**
     * Bundle entries classified as matched, with the local destination each one resolved
     * to; restore writes only these exact pairs, never a newer or different match.
     */
    matchedProjects: BackupMatchedProject[];
  }>;
  /** Core settings only; matched project memory is snapshotted by `restore` under its lock. */
  writeSafetySnapshot(snapshotRoot: string): Promise<void>;
  restore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
    includeProjects: boolean;
    /** Receives the matched project memory snapshot, taken in the write's lock window. */
    snapshotPath: string;
    matchedProjects: readonly BackupMatchedProject[];
  }): Promise<{
    changedFiles: string[];
    localOnlyFiles: string[];
    projectBundleSkipped: boolean;
    /** Matched memory actually written, per registered project, for change notification. */
    restoredProjectMemory: Array<{ projectPath: string; files: string[] }>;
  }>;
  /**
   * Reads and validates the checked-out bundle once for a whole restore's approved
   * imports; the returned importer then writes each one from that parsed copy. Per-import
   * rereads would hash the entire bundle once per candidate.
   */
  prepareProjectImports(options: {
    repositoryRoot: string;
    managedPath: string;
  }): Promise<BackupProjectImporter>;
}

/** A validated matched entry: the recorded source and the local project it restores into. */
export interface BackupMatchedProject {
  sourcePath: string;
  projectPath: string;
  localMemoryDir: string;
}

export interface BackupProjectImporter {
  /**
   * The write-side refusals for one approved import against its target — memory size and
   * count limits, non-file destinations — without writing. Run before the snapshot so a
   * predictably impossible import never leaves a registered project behind.
   */
  assertProjectMemoryAllowed(options: { token: string; targetPath: string }): Promise<void>;
  /**
   * Writes one approved import's memory files, re-keyed to the target path's locally
   * computed directory, add-only. Runs after the project was registered so no path ever
   * holds the memory mutation lock while entering config edits.
   */
  importProjectMemory(options: {
    token: string;
    targetPath: string;
  }): Promise<{ writtenFiles: string[]; skippedFiles: string[] }>;
}

/**
 * The slice of ProjectService a restore needs to register an approved import. Injected via
 * setter because the container constructs BackupService before ProjectService.
 */
export interface BackupProjectRegistrar {
  /**
   * Runs `fn` with project registration held stable — nothing is registered or removed
   * underneath it — and a `create` that registers inside that window. An import resolves its
   * target's identity, registers it when needed, and writes its memory within one window, so
   * a removal cannot land between the registration it checked and the memory it wrote.
   */
  withRegistrationLock<T>(
    fn: (registrar: {
      create(
        projectPath: string,
        options?: { displayName?: string }
      ): Promise<Result<{ normalizedPath: string }, string>>;
      /** Throws once this process no longer holds the lock; called before each commit. */
      assertStillOwned(): Promise<void>;
    }) => Promise<T>
  ): Promise<T>;
}

/**
 * The slice of MemoryService a restore needs to announce the project memory it wrote
 * directly. Memory subscribers refresh from disk only on change events, so a silent
 * external writer would leave an open memory browser showing pre-restore contents.
 */
export interface BackupMemoryNotifier {
  notifyExternalProjectChange(projectPath: string): void;
}

/** Registered project keys plus a real-path → key index, built once per restore. */
interface RegisteredProjectLookup {
  /** Registered user projects (system entries excluded: memory is never kept for them). */
  keys: ReadonlySet<string>;
  /** Each key's real path, or null when it does not resolve or could not be resolved in time. */
  canonicalByKey: ReadonlyMap<string, string | null>;
  byCanonical: ReadonlyMap<string, string>;
  /**
   * Keys whose real path is not known — probed past their time or not probed at all — as
   * opposed to keys that resolve to nothing. Any of them could still be another spelling of
   * a directory an import is about to register.
   */
  unresolved: ReadonlySet<string>;
}

/**
 * Bounds on resolving registered projects' real paths; see registeredProjectLookup. One probe
 * in flight, deliberately: Node's fs has no cancellation, so a `realpath` that a timed-out
 * race stopped waiting for keeps its libuv threadpool worker until the mount answers. The
 * deadline bounds how long the restore itself waits, shared out equally among the keys still
 * to probe rather than spent by whichever comes first, so a project on an unavailable mount
 * cannot leave every key after it unprobed. Each stalled probe is one worker held until its
 * mount answers; after REGISTRY_MAX_STALLED_PROBES of them the pass stops probing, so a
 * pass can hold at most that many of the pool's threads, not the whole pool.
 */
const REGISTRY_CANONICALIZE_CONCURRENCY = 1;
const REGISTRY_CANONICALIZE_DEADLINE_MS = 5_000;
const REGISTRY_MAX_STALLED_PROBES = 2;

/**
 * One approved import after planning: its resolved target, the directory's filesystem
 * identity at approval, and, if already registered, the project identity it imports into.
 */
interface PlannedProjectImport {
  candidate: BackupProjectImport;
  targetPath: string;
  /**
   * A handle on the approved directory, held open until the import is done (restore() closes
   * it). Execution accepts only the directory whose device and inode match this handle's;
   * comparing against numbers recorded at approval would not do, since a directory deleted
   * and recreated at the path meanwhile can be given the same inode number back — but not
   * while a handle keeps that inode allocated.
   */
  target: fs.FileHandle;
  registeredPath: string | null;
  /**
   * Whether the candidate's recorded source path was already registered when it was offered.
   * It can be: an entry registered here whose recorded memory directory name is not the one
   * this host computes (a path from another OS) is offered as an import on purpose, and
   * stays importable. Only a registration that appears after planning reclassifies it.
   */
  sourceRegisteredAtPlanning: boolean;
}

/** planProjectImports' result: the imports and the registry lookup they were resolved against. */
interface PlannedProjectImports {
  imports: PlannedProjectImport[];
  registry: RegisteredProjectLookup | null;
}

export interface BackupServiceDependencies {
  gitRepo: BackupGitRepo;
  payload: BackupPayloadStore;
}

type BackupErrorCode = BackupOperationError["code"];

const SNAPSHOT_NAME_PREFIX = "restore-";

/**
 * Written beside a snapshot as the restore that owns it finishes, which is what makes the
 * snapshot reapable. A sibling rather than a file inside, so the snapshot directory stays a
 * payload `readBackupPayload(dir, { portable: false })` can read for a manual recovery.
 *
 * Absent covers a restore still running, one killed partway, and one whose marker write failed.
 * None are distinguishable from outside, so all are left alone: leaking a snapshot the user can
 * delete is recoverable, and deleting the recovery point of a live restore is not.
 */
const SNAPSHOT_RELEASED_SUFFIX = ".released";

/** Fixed width so the sequence sorts as text alongside the stamp. */
const SNAPSHOT_SEQUENCE_DIGITS = 6;

async function releaseSnapshot(snapshotPath: string): Promise<void> {
  await fs
    .writeFile(`${snapshotPath}${SNAPSHOT_RELEASED_SUFFIX}`, "", { mode: 0o600 })
    .catch(() => undefined);
}

const STAMPED_SNAPSHOT_NAME = /^restore-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(?:(\d{6})-)?/;

/**
 * Snapshots are ordered by the stamp and sequence in their own name, never by mtime or by the
 * random `mkdtemp` suffix: several restores can land in the same millisecond, and neither a
 * filesystem timestamp nor a random suffix can put those in creation order. A name from before
 * either part existed sorts oldest, so those are reclaimed first rather than kept forever.
 */
function snapshotOrder(name: string): string {
  const match = STAMPED_SNAPSHOT_NAME.exec(name);
  return `${match?.[1] ?? ""}\u0000${match?.[2] ?? ""}\u0000${name}`;
}

export class BackupServiceError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string,
    public readonly files?: string[],
    public readonly secretApproval?: string
  ) {
    super(message);
    this.name = "BackupServiceError";
  }
}

function toOperationError(error: unknown): BackupOperationError {
  if (error instanceof BackupServiceError) {
    return {
      code: error.code,
      message: error.message,
      files: error.files,
      secretApproval: error.secretApproval,
    };
  }

  // A restore attempted without a preview, or after the backup's commands drifted, fails
  // with an approval list the UI has not seen yet. Dropping it would leave the user unable
  // to approve anything without guessing that Preview must be run again.
  if (error instanceof BackupCommandApprovalRequiredError) {
    return {
      code: error.code,
      message: error.message,
      commandApprovals: [...error.approvals],
    };
  }

  // A matched-memory write that failed midway may have created files no snapshot can
  // remove (the snapshot holds only pre-existing destinations); the error lists them as
  // the user's cleanup list.
  if (error instanceof ProjectMemoryRestoreError) {
    const written = error.restoredProjectMemory.flatMap((restored) => restored.files);
    return {
      code: "IO_ERROR",
      message:
        written.length === 0
          ? error.message
          : `${error.message}. Project memory written before the failure`,
      ...(written.length === 0 ? {} : { files: written }),
    };
  }

  // Same round trip for project imports: the error carries the candidates recomputed from
  // the currently checked-out payload, so a stale approval can be re-made from fresh data.
  if (error instanceof BackupProjectImportApprovalRequiredError) {
    return {
      code: error.code,
      message: error.message,
      projectImports: [...error.projectImports],
    };
  }

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; files?: unknown };
    const code = BackupOperationErrorSchema.shape.code.safeParse(candidate.code);
    if (code.success) {
      return {
        code: code.data,
        message: candidate.message,
        files: Array.isArray(candidate.files)
          ? candidate.files.filter((file): file is string => typeof file === "string")
          : undefined,
      };
    }
    return { code: "IO_ERROR", message: error.message };
  }

  return { code: "IO_ERROR", message: "Settings backup failed" };
}

/** `\\server\share`, `//server/share`, and `\\?\` / `\\.\` device namespaces. */
function isNetworkOrDevicePath(targetPath: string): boolean {
  return /^(?:\\\\|\/\/)/.test(targetPath);
}

async function realpathOrNull(target: string): Promise<string | null> {
  return fs.realpath(target).catch(() => null);
}

/** Releases the directory handles a plan holds (see PlannedProjectImport.target). */
async function closeProjectImportTargets(planned: readonly PlannedProjectImport[]): Promise<void> {
  await Promise.all(planned.map((imported) => imported.target.close().catch(() => undefined)));
}

/**
 * A registered path's real path, bounded by `timeoutMs`. `unknown` when the probe says nothing
 * about what the path is: the time ran out first (the resolution, still blocked on an
 * unavailable mount, then finishes on its own in the threadpool; nothing waits for it — see
 * REGISTRY_MAX_STALLED_PROBES), or it failed for a reason other than the path not existing
 * (EACCES, EIO): such a path may still be another spelling of a reachable directory. Only a
 * path that provably leads nowhere resolves to a known null.
 */
async function registeredRealpathWithin(
  target: string,
  timeoutMs: number
): Promise<{ canonical: string | null; unknown: boolean; stalled: boolean }> {
  if (timeoutMs <= 0) return { canonical: null, unknown: true, stalled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ canonical: null; unknown: true; stalled: true }>((resolve) => {
    timer = setTimeout(() => resolve({ canonical: null, unknown: true, stalled: true }), timeoutMs);
  });
  const probe = fs.realpath(target).then(
    (canonical) => ({ canonical, unknown: false, stalled: false }),
    (error: NodeJS.ErrnoException) => ({
      canonical: null,
      unknown: error.code !== "ENOENT" && error.code !== "ENOTDIR",
      stalled: false,
    })
  );
  try {
    return await Promise.race([probe, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function repoLockKey(settings: SettingsBackupInput): string {
  return `${settings.repoUrl}\0${settings.branch}`;
}

const activeCacheUses = new Map<string, number>();
const cacheReapClaims = new Map<string, Promise<void>>();

type ReleaseActiveCache = () => void;

function registerActiveCache(cacheName: string): ReleaseActiveCache | Promise<ReleaseActiveCache> {
  const pendingReap = cacheReapClaims.get(cacheName);
  if (pendingReap !== undefined) {
    return pendingReap.then(() => registerActiveCache(cacheName));
  }

  activeCacheUses.set(cacheName, (activeCacheUses.get(cacheName) ?? 0) + 1);
  return () => {
    const remaining = (activeCacheUses.get(cacheName) ?? 1) - 1;
    if (remaining === 0) activeCacheUses.delete(cacheName);
    else activeCacheUses.set(cacheName, remaining);
  };
}

function isCacheActive(cacheName: string): boolean {
  return activeCacheUses.has(cacheName);
}

async function discardInactiveCache(cachePath: string): Promise<void> {
  const cacheName = path.basename(cachePath);
  if (isCacheActive(cacheName)) return;
  const existingClaim = cacheReapClaims.get(cacheName);
  if (existingClaim !== undefined) {
    await existingClaim;
    return;
  }

  let releaseClaim: () => void;
  const claim = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  cacheReapClaims.set(cacheName, claim);
  try {
    await discardBackupCache(cachePath);
  } finally {
    cacheReapClaims.delete(cacheName);
    releaseClaim!();
  }
}

/** Service-level validation prevents direct callers from bypassing schema invariants. */
function normalizeBackupSettings(settings: SettingsBackupInput): SettingsBackupInput {
  const parsed = SettingsBackupInputSchema.safeParse(settings);
  if (!parsed.success) {
    throw new BackupServiceError(
      "INVALID_BACKUP",
      parsed.error.issues[0]?.message ?? "Invalid backup settings"
    );
  }
  return parsed.data;
}

export class BackupService {
  /** Keeps quick switches among recent repository settings from forcing a fresh clone. */
  static readonly RETAINED_INACTIVE_CACHES = 2;

  private readonly locks = new MutexMap<string>();

  /**
   * `locks` is keyed per repository, so different repository and branch tuples overlap on the one
   * Xum root every payload adapter reads and writes: a push can publish a half-restored mixture.
   * Held only around local payload work, so git and network work stays parallel.
   */
  private readonly localPayload = new MutexMap<string>();

  /**
   * Orders snapshots the stamp cannot separate. Restores that land in the same millisecond would
   * otherwise be ranked by `mkdtemp`'s random suffix, which can reap a newer recovery point and
   * keep an older one.
   */
  private snapshotSequence = 0;

  /** Absent until the container wires ProjectService; imports fail per candidate without it. */
  private projectRegistrar: BackupProjectRegistrar | null = null;
  private memoryNotifier: BackupMemoryNotifier | null = null;

  constructor(
    private readonly config: Config,
    private readonly dependencies: BackupServiceDependencies
  ) {}

  setProjectService(projectRegistrar: BackupProjectRegistrar): void {
    this.projectRegistrar = projectRegistrar;
  }

  setMemoryNotifier(memoryNotifier: BackupMemoryNotifier): void {
    this.memoryNotifier = memoryNotifier;
  }

  getSettings(): SettingsBackup | null {
    return this.config.loadConfigOrDefault().settingsBackup ?? null;
  }

  async saveSettings(
    settings: SettingsBackupInput
  ): Promise<Result<SettingsBackup, BackupOperationError>> {
    try {
      const normalized = normalizeBackupSettings(settings);
      const saved = await this.persistSettings(normalized);
      return Ok(saved);
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async validate(
    settings: SettingsBackupInput
  ): Promise<
    Result<
      { reachable: true; credential: BackupCredentialKind; empty: boolean },
      BackupOperationError
    >
  > {
    try {
      const normalized = normalizeBackupSettings(settings);
      const result = await this.dependencies.gitRepo.validate(normalized);
      return Ok({ reachable: true, ...result });
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async preview(settings: SettingsBackupInput): Promise<
    Result<
      {
        pushChanges: BackupFileChange[];
        restoreChanges: BackupFileChange[];
        localOnlyFiles: string[];
        redactions: string[];
        commandApprovals: BackupCommandApproval[];
        projectImports: BackupProjectImport[];
        projectBundleSkipped: boolean;
        pushError: string | null;
      },
      BackupOperationError
    >
  > {
    return this.withRepoLock(settings, async (normalized) => {
      const includeProjects = normalized.includeProjects === true;
      const repository = await this.prepareRepository(normalized);
      // One critical section: the reported restore plan and the exported payload must describe
      // the same local state, or the two halves of the preview disagree.
      const { restorePreview, exported } = await this.withLocalPayload(async () => {
        const restorePreview = await this.dependencies.payload.previewRestore({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
          includeProjects,
        });
        // The push half fails on local state alone (an over-limit project list, an
        // unexportable path); that must not hide the restore half, which is the only
        // way to obtain the import approvals a cross-machine restore needs.
        let exported: { redactions: string[] } | { pushError: string };
        try {
          exported = await this.dependencies.payload.exportTo({
            repositoryRoot: repository.rootDir,
            managedPath: repository.managedPath,
            includeProjects,
          });
        } catch (error) {
          exported = { pushError: toOperationError(error).message };
        }
        return { restorePreview, exported };
      });
      const pushChanges =
        "pushError" in exported ? [] : await this.dependencies.gitRepo.getPushChanges(repository);
      return Ok({
        pushChanges,
        restoreChanges: restorePreview.changes,
        localOnlyFiles: restorePreview.localOnlyFiles,
        redactions: "pushError" in exported ? [] : exported.redactions,
        commandApprovals: restorePreview.commandApprovals,
        projectImports: restorePreview.projectImports,
        projectBundleSkipped: restorePreview.projectBundleSkipped,
        pushError: "pushError" in exported ? exported.pushError : null,
      });
    });
  }

  pushWithApproval(input: SettingsBackupInput & { approvedSecretDigest?: string | null }) {
    const { approvedSecretDigest, ...settings } = input;
    return this.push(settings, { approvedSecretDigest: approvedSecretDigest ?? undefined });
  }

  restoreWithApproval(
    input: SettingsBackupInput & {
      approvedCommandTokens?: readonly string[] | null;
      projectImports?: ReadonlyArray<{ token: string; targetPath: string }> | null;
    }
  ) {
    const { approvedCommandTokens, projectImports, ...settings } = input;
    return this.restore(settings, {
      approvedCommandTokens: approvedCommandTokens ?? undefined,
      projectImports: projectImports ?? undefined,
    });
  }

  async push(
    settings: SettingsBackupInput,
    options: { approvedSecretDigest?: string } = {}
  ): Promise<
    Result<
      {
        commit: string;
        changed: boolean;
        credential: BackupCredentialKind;
        redactions: string[];
      },
      BackupOperationError
    >
  > {
    const approvedSecretDigest = options.approvedSecretDigest;
    return this.withRepoLock(settings, async (normalized) => {
      const repository = await this.prepareRepository(normalized);
      const exported = await this.withLocalPayload(() =>
        this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
          includeProjects: normalized.includeProjects === true,
        })
      );
      // Approval is bound to the exact flagged bytes, so an override the user granted for
      // one payload cannot publish a different one another window wrote in between.
      if (exported.secretFiles.length > 0 && approvedSecretDigest !== exported.secretApproval) {
        throw new BackupServiceError(
          "SECRET_DETECTED",
          "Potential secrets were found in the backup payload",
          exported.secretFiles,
          exported.secretApproval
        );
      }

      const pushed = await this.dependencies.gitRepo.commitAndPush(repository, {
        message: "Back up Xum settings",
        expectedRemoteCommit: repository.remoteCommit,
      });
      await this.persistSettings(normalized, { lastPushedCommit: pushed.commit });
      // The pushing credential, not the one prepare() used: the ladder can fall through
      // to a later rung when the earlier one can read but not write.
      return Ok({
        ...pushed,
        redactions: exported.redactions,
      });
    });
  }

  async restore(
    settings: SettingsBackupInput,
    options: {
      approvedCommandTokens?: readonly string[];
      projectImports?: ReadonlyArray<{ token: string; targetPath: string }>;
    } = {}
  ): Promise<
    Result<
      {
        commit: string;
        snapshotPath: string;
        changedFiles: string[];
        localOnlyFiles: string[];
        projectImportResults: BackupProjectImportResult[];
        projectBundleSkipped: boolean;
        /**
         * Candidates the restore did not import because no approval was given — a restore
         * run without a preview, or with candidates left unchecked. Reported so a
         * "completed" restore never silently omits backed-up projects.
         */
        unapprovedProjectImports: BackupProjectImport[];
      },
      BackupOperationError
    >
  > {
    const approvedCommandTokens =
      options.approvedCommandTokens == null ? undefined : [...options.approvedCommandTokens];
    const requestedImports = options.projectImports == null ? [] : [...options.projectImports];
    return this.withRepoLock(settings, async (normalized) => {
      const includeProjects = normalized.includeProjects === true;
      const repository = await this.prepareRepository(normalized);
      const remoteCommit = repository.remoteCommit;
      if (remoteCommit == null) {
        throw new BackupServiceError("INVALID_BACKUP", "The backup repository is empty");
      }

      // One critical section from the check through the write loop: a concurrent push must not
      // collect a half-restored Xum root, and a concurrent restore must not interleave its
      // writes with this one.
      return await this.withLocalPayload(async () => {
        // Before the snapshot, so a restore blocked on command approval does not leave an
        // unredacted copy of the local settings on disk.
        const validated = await this.dependencies.payload.validateRestore({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
          approvedCommandTokens,
          includeProjects,
        });
        // Import approvals are also checked before the snapshot and before any mutation: a
        // stale token or an unusable target directory refuses the whole restore while
        // nothing has changed yet. Runtime failures after this point are per-candidate.
        const { imports: plannedImports, registry } = await this.planProjectImports(
          requestedImports,
          validated.projectImports,
          validated.matchedProjects,
          includeProjects
        );
        // The plan holds a handle per approved target from here until the imports are done
        // (see PlannedProjectImport.target), released however this ends.
        try {
          // The bundle is read once for every approved import, and each import's write-side
          // refusals run now: an import that cannot land must fail while nothing has changed
          // yet, not after the core restore and its project registration.
          const importer =
            plannedImports.length === 0
              ? null
              : await this.dependencies.payload.prepareProjectImports({
                  repositoryRoot: repository.rootDir,
                  managedPath: repository.managedPath,
                });
          for (const planned of plannedImports) {
            await importer?.assertProjectMemoryAllowed({
              token: planned.candidate.token,
              // Against the identity the import will actually write to: a target that is an
              // alias of an already registered project imports into that project.
              targetPath: planned.registeredPath ?? planned.targetPath,
            });
          }
          const plannedTokens = new Set(plannedImports.map((planned) => planned.candidate.token));
          const unapprovedProjectImports = validated.projectImports.filter(
            (candidate) => !plannedTokens.has(candidate.token)
          );
          const snapshotPath = await this.createSnapshotPath();
          try {
            await this.dependencies.payload.writeSafetySnapshot(snapshotPath);
          } catch (error) {
            // Nothing has been restored yet, so a snapshot that did not finish is an empty or
            // partial unredacted copy that no recovery can use, and every retry would add one.
            await fs.rm(snapshotPath, { recursive: true, force: true });
            throw error;
          }
          try {
            const restored = await this.dependencies.payload.restore({
              repositoryRoot: repository.rootDir,
              managedPath: repository.managedPath,
              approvedCommandTokens,
              includeProjects,
              snapshotPath,
              matchedProjects: validated.matchedProjects,
            });
            // Announced as soon as the memory is on disk: a failure recording the commit below
            // must not leave subscribers showing pre-restore contents.
            this.notifyProjectMemoryChanges(restored.restoredProjectMemory, []);
            // Recorded before the imports: they register projects and create files the snapshot
            // does not cover, and their per-candidate results are the user's only undo list, so
            // nothing that can fail may run after them and discard those results.
            await this.persistSettings(normalized, { lastRestoredCommit: remoteCommit });
            const { results: projectImportResults, reclassified } =
              importer === null
                ? { results: [], reclassified: new Set<string>() }
                : await this.executeProjectImports(importer, plannedImports, registry);
            this.notifyProjectMemoryChanges([], projectImportResults);
            // A candidate whose import failed per-candidate, or landed only partly because
            // existing files conflicted, stays on offer so the user can fix the target or the
            // conflicts and retry without another preview; its token is still current, and a
            // conflicted import records no origin, so the source is still an import candidate.
            // Not one whose source became a registered project here: only a new preview can
            // present it, as a matched entry, so offering it again would only fail.
            const stillOfferedTokens = new Set(
              projectImportResults.flatMap((result, index) => {
                const token = plannedImports[index]?.candidate.token;
                if (token === undefined || reclassified.has(token)) return [];
                return result.status === "failed" || result.skippedFiles.length > 0 ? [token] : [];
              })
            );
            return Ok({
              commit: remoteCommit,
              snapshotPath,
              changedFiles: restored.changedFiles,
              localOnlyFiles: restored.localOnlyFiles,
              projectImportResults,
              projectBundleSkipped: restored.projectBundleSkipped,
              unapprovedProjectImports: [
                ...unapprovedProjectImports,
                ...validated.projectImports.filter((candidate) =>
                  stillOfferedTokens.has(candidate.token)
                ),
              ],
            });
          } catch (error) {
            // Memory the failed restore already overwrote is on disk; subscribers must
            // hear about it even though the restore is being reported as failed.
            if (error instanceof ProjectMemoryRestoreError) {
              this.notifyProjectMemoryChanges(error.restoredProjectMemory, []);
            }
            // Past the snapshot, the restore may have overwritten files before failing, and
            // the snapshot is the only recovery path, so the failure must carry it.
            return Err({ ...toOperationError(error), snapshotPath });
          } finally {
            // Released only now, because until this restore returns its snapshot is the recovery
            // point it may still hand back. Reaping is safe here rather than gated on other
            // restores because the local payload lock already excludes them.
            await releaseSnapshot(snapshotPath);
            await this.reapOldSnapshots(path.dirname(snapshotPath), snapshotPath);
          }
        } finally {
          await closeProjectImportTargets(plannedImports);
        }
      });
    });
  }

  /**
   * Everything about an import request that can be refused while the restore has changed
   * nothing yet: tokens must match the candidates recomputed from the currently checked-out
   * payload, and each target must already be a real local directory — `ProjectService.create`
   * would otherwise mkdir a typo into existence.
   */
  private async planProjectImports(
    requested: ReadonlyArray<{ token: string; targetPath: string }>,
    candidates: readonly BackupProjectImport[],
    matched: readonly BackupMatchedProject[],
    includeProjects: boolean
  ): Promise<PlannedProjectImports> {
    if (requested.length === 0) return { imports: [], registry: null };
    if (!includeProjects) {
      throw new BackupServiceError(
        "IO_ERROR",
        "Project imports require the project backup setting to be enabled"
      );
    }
    const byToken = new Map(candidates.map((candidate) => [candidate.token, candidate]));
    const planned: PlannedProjectImport[] = [];
    const claimedTargets = new Set<string>();
    const registry = await this.registeredProjectLookup();
    const matchedProjectPaths = new Set(matched.map((match) => match.projectPath));
    // Every source path the bundle records, whichever entry recorded it.
    const recordedSources = new Set([...candidates, ...matched].map((entry) => entry.sourcePath));
    try {
      for (const request of requested) {
        planned.push(
          await this.planProjectImport(request, byToken, registry, {
            claimedTargets,
            matchedProjectPaths,
            recordedSources,
            candidates,
          })
        );
      }
    } catch (error) {
      // A refused request refuses the whole restore; the handles opened for the requests
      // before it would otherwise stay open.
      await closeProjectImportTargets(planned);
      throw error;
    }
    return { imports: planned, registry };
  }

  private async planProjectImport(
    request: { token: string; targetPath: string },
    byToken: Map<string, BackupProjectImport>,
    registry: RegisteredProjectLookup,
    run: {
      claimedTargets: Set<string>;
      matchedProjectPaths: ReadonlySet<string>;
      recordedSources: ReadonlySet<string>;
      candidates: readonly BackupProjectImport[];
    }
  ): Promise<PlannedProjectImport> {
    const { claimedTargets, matchedProjectPaths, recordedSources, candidates } = run;
    {
      const candidate = byToken.get(request.token);
      // Unknown and stale tokens are indistinguishable here; both mean the user approved
      // something other than what the repository currently holds.
      if (candidate === undefined) {
        throw new BackupProjectImportApprovalRequiredError(candidates);
      }
      byToken.delete(request.token);
      const targetPath = request.targetPath.trim();
      // Refused before any filesystem probe: merely stat-ing a UNC or device path on
      // Windows starts SMB authentication against whatever host it names, and a target
      // is meant to be a local checkout in any case. Checked before the absolute-path rule
      // so the refusal reads the same on every platform.
      if (isNetworkOrDevicePath(targetPath)) {
        throw new BackupServiceError(
          "IO_ERROR",
          `Cannot import '${candidate.name}': the target must be a local directory, not a network or device path`
        );
      }
      if (!path.isAbsolute(targetPath)) {
        throw new BackupServiceError(
          "IO_ERROR",
          `Cannot import '${candidate.name}': the target path must be absolute`
        );
      }
      const resolved = path.resolve(targetPath);
      // The recovery copy a later matched restore of this project takes records the local
      // path in the bundle manifest schema; a target past its cap would import today and
      // fail every restore that later matches it, after the core snapshot.
      if (resolved.length > MAX_BACKUP_PROJECT_PATH_CHARS) {
        throw new BackupServiceError(
          "IO_ERROR",
          `Cannot import '${candidate.name}': the target path is longer than ${MAX_BACKUP_PROJECT_PATH_CHARS} characters`
        );
      }
      const stat = await fs.lstat(resolved).catch(() => null);
      // A symlinked target would register the link's path while memory lands under a dir
      // name derived from it; require the plain directory itself.
      if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new BackupServiceError(
          "IO_ERROR",
          `Cannot import '${candidate.name}': '${resolved}' is not an existing directory`
        );
      }
      // The directory itself, pinned (see PlannedProjectImport.target): opened after the
      // checks above, and confirmed to be the very directory they checked, since the path
      // could have been re-pointed in between.
      const target = await fs.open(resolved, "r");
      try {
        const opened = await target.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new BackupServiceError(
            "IO_ERROR",
            `Cannot import '${candidate.name}': '${resolved}' changed while it was being checked`
          );
        }
        // Claimed by real path: two lexically different targets that reach one directory
        // through a symlinked parent would otherwise both register/resolve to the same
        // project and merge two backed-up projects' memories into it.
        const canonical = (await realpathOrNull(resolved)) ?? resolved;
        if (claimedTargets.has(canonical)) {
          throw new BackupServiceError(
            "IO_ERROR",
            `Cannot import '${candidate.name}': another import already targets '${resolved}'`
          );
        }
        claimedTargets.add(canonical);
        // Known up front when the target is already registered (directly or as an alias),
        // so the preflight checks the memory scope the import will really write to.
        const registeredPath = this.resolveRegisteredProjectPath(resolved, canonical, registry);
        // A project that a matched entry restores into in this same run cannot also take an
        // import: the two would merge into one memory scope and the import's origin marker
        // would displace the matched entry's identity.
        if (matchedProjectPaths.has(registeredPath ?? resolved)) {
          throw new BackupServiceError(
            "IO_ERROR",
            `Cannot import '${candidate.name}': '${resolved}' already receives a backed-up project's memory in this restore`
          );
        }
        // Nor a directory at another backed-up project's recorded path: registering it would
        // make every later restore match that other entry there directly, by exact path — over
        // an origin record and ahead of anywhere its memory was imported — so the other entry's
        // notes would be written into this candidate's scope. Its own recorded path is fine:
        // that is the entry being restored where it came from.
        for (const spelling of new Set([resolved, canonical, registeredPath ?? resolved])) {
          if (recordedSources.has(spelling) && spelling !== candidate.sourcePath) {
            throw new BackupServiceError(
              "IO_ERROR",
              `Cannot import '${candidate.name}': '${resolved}' is the recorded path of another backed-up project`
            );
          }
        }
        return {
          candidate,
          targetPath: resolved,
          target,
          registeredPath,
          sourceRegisteredAtPlanning: registry.keys.has(candidate.sourcePath),
        };
      } catch (error) {
        await target.close().catch(() => undefined);
        throw error;
      }
    }
  }

  /**
   * Registration before the memory write, per candidate: a crash between the two leaves a
   * registered project without memory, which is benign, rather than orphaned live memory.
   * Failures land in the result instead of aborting the restore or the other candidates —
   * the safety snapshot cannot revert a project registration, so an abort here would not
   * roll anything back anyway; the result is the user's undo list.
   */
  private async executeProjectImports(
    importer: BackupProjectImporter,
    planned: readonly PlannedProjectImport[],
    planningRegistry: RegisteredProjectLookup | null
  ): Promise<{ results: BackupProjectImportResult[]; reclassified: Set<string> }> {
    const results: BackupProjectImportResult[] = [];
    /** Tokens refused because their source is a registered project now; not retryable. */
    const reclassified = new Set<string>();
    if (planned.length === 0) return { results, reclassified };
    const registrar = this.projectRegistrar;
    if (registrar === null) {
      return {
        results: planned.map(({ candidate, targetPath }) => ({
          sourcePath: candidate.sourcePath,
          targetPath,
          name: candidate.name,
          status: "failed",
          message: "Project registration is unavailable",
          writtenFiles: [],
          skippedFiles: [],
          registered: false,
        })),
        reclassified,
      };
    }
    // One registration window for the imports: registration is re-read inside it — so a
    // target unregistered since planning is registered again rather than written into on a
    // stale identity, and one registered meanwhile through another symlinked spelling is
    // detected instead of registered twice — and nothing can be registered or removed
    // between that read and the memory writes, so the project an import wrote into is the
    // project registered when it reports success.
    return registrar.withRegistrationLock(async (locked) => {
      // Real paths resolved during planning are reused; only projects registered since are
      // probed, so a slow mount is waited on once per restore, not again under this lock.
      const registry = await this.registeredProjectLookup(planningRegistry ?? undefined);
      // Paths this very loop registers: the lookup above predates them, and a later
      // candidate's recorded source may be one of them (planning refuses the case it can
      // see; this is the check under the lock).
      const registeredHere = new Set<string>();
      for (const {
        candidate,
        targetPath,
        target,
        registeredPath: plannedRegisteredPath,
        sourceRegisteredAtPlanning,
      } of planned) {
        // The identity the preflight checked (memory limits, non-file destinations,
        // permissions) is the only one this import may write to. A different identity now —
        // the checkout registered under another alias since planning — names a memory scope
        // nothing has checked, so the candidate fails without a write and stays on offer;
        // the next preview resolves the new registration and preflights it.
        const preflightedPath = plannedRegisteredPath ?? targetPath;
        // Once registration resolves the project identity, failures report that path: it is
        // where any partially written memory actually lives. Whether this import registered
        // it is reported either way: a registration is the one effect the snapshot cannot
        // undo, so the result must say when there is one to remove.
        let registeredPath: string | null = null;
        let registered = false;
        const failed = (
          message: string,
          progress: { written: string[]; skipped: string[] } = { written: [], skipped: [] }
        ): BackupProjectImportResult => ({
          sourcePath: candidate.sourcePath,
          targetPath: registeredPath ?? targetPath,
          name: candidate.name,
          status: "failed",
          message,
          writtenFiles: progress.written,
          skippedFiles: progress.skipped,
          registered,
        });
        const unchecked = (registered: string): BackupProjectImportResult =>
          failed(
            `'${targetPath}' is now registered as '${registered}', which this import was not checked against; approve it again`
          );
        try {
          // Reclassified since validation: the candidate's recorded source path was registered
          // on this machine after it was offered, so the next restore may write the entry
          // directly into that project — memory imported into the approved target would be
          // orphaned there and its origin record overridden by the exact-path match. Refused
          // under the registration lock, where this cannot change again before the write; the
          // next preview shows the entry as matched, or offers it again if it still cannot
          // be (see sourceRegisteredAtPlanning).
          if (
            !sourceRegisteredAtPlanning &&
            (registry.keys.has(candidate.sourcePath) || registeredHere.has(candidate.sourcePath))
          ) {
            reclassified.add(candidate.token);
            results.push(
              failed(
                `'${candidate.sourcePath}' was registered on this machine since the preview and is now restored directly; preview again`
              )
            );
            continue;
          }
          // Re-verify under the local payload lock: the preflight ran before the snapshot and
          // the directory may have vanished since.
          const stat = await fs.lstat(targetPath).catch(() => null);
          if (!stat?.isDirectory() || stat.isSymbolicLink()) {
            results.push(failed(`'${targetPath}' is not an existing directory`));
            continue;
          }
          // The same directory the user approved, not merely one at the same path: a checkout
          // moved away and another created here since would otherwise be registered and
          // receive the approved source's memory. Compared against the handle planning has
          // kept open, whose inode a replacement cannot have been given (see
          // PlannedProjectImport.target). Checked again after create() below, which
          // re-resolves the path itself during its own asynchronous validation.
          const approved = await target.stat();
          const replaced = (current: { dev: number; ino: number } | null): boolean =>
            current === null || current.dev !== approved.dev || current.ino !== approved.ino;
          if (replaced(stat)) {
            results.push(
              failed(`'${targetPath}' was replaced by a different directory since it was approved`)
            );
            continue;
          }
          // An alias of an already registered project imports into that project without a
          // second registration; create() would otherwise register the alias as a duplicate
          // when its own duplicate check misses the aliased key.
          const registeredIdentity = this.resolveRegisteredProjectPath(
            targetPath,
            await realpathOrNull(targetPath),
            registry
          );
          // Checked before create() so a refused candidate leaves no registration behind.
          if ((registeredIdentity ?? targetPath) !== preflightedPath) {
            results.push(unchecked(registeredIdentity ?? targetPath));
            continue;
          }
          // No alias found is only proof of none when every registered path was resolved. A
          // lookup left incomplete by unavailable mounts (see registeredProjectLookup) says
          // nothing about the keys it could not probe, and registering on its word could
          // give one directory a second project identity and split its memory. Importing
          // into a project that did resolve is fine either way; a new registration waits for
          // a pass that can see every key. The candidate stays on offer.
          if (registeredIdentity === null && registry.unresolved.size > 0) {
            results.push(
              failed(
                `'${targetPath}' could not be checked against ${registry.unresolved.size} registered ${registry.unresolved.size === 1 ? "project whose location" : "projects whose locations"} could not be resolved in time; it was not registered. Retry once every project's location is reachable`
              )
            );
            continue;
          }
          // Before each irreversible step: this process must still hold the registration
          // lock, or another process has judged it stale and may be registering meanwhile.
          await locked.assertStillOwned();
          // The backed-up name travels with a newly registered project (in the same config
          // write as the registration); an already registered target keeps its local name.
          const created =
            registeredIdentity === null
              ? await locked.create(
                  targetPath,
                  candidate.name === getProjectDisplayName(targetPath)
                    ? undefined
                    : { displayName: candidate.name }
                )
              : Err("Project already exists");
          if (created.success) {
            registeredPath = created.data.normalizedPath;
            registered = true;
            registeredHere.add(registeredPath);
          } else if (created.error === "Project already exists") {
            // Resolved above, or registered by an earlier candidate of this very loop (the
            // lock excludes everyone else): the lookup built inside the window predates that.
            registeredPath =
              registeredIdentity ??
              this.resolveRegisteredProjectPath(
                targetPath,
                await realpathOrNull(targetPath),
                await this.registeredProjectLookup()
              );
            if (registeredPath === null) {
              results.push(failed(`'${targetPath}' is already registered under a different path`));
              continue;
            }
            if (registeredPath !== preflightedPath) {
              results.push(unchecked(registeredPath));
              continue;
            }
          } else {
            results.push(failed(created.error));
            continue;
          }
          // Re-pinned after registration, immediately before the write: a directory swapped
          // in while create() ran was registered by path, and the approved source's memory
          // must not follow it into that other checkout. The registration stays (the safety
          // snapshot cannot revert it) and is reported as this candidate's failure.
          if (replaced(await fs.lstat(targetPath).catch(() => null))) {
            results.push(
              failed(
                `'${targetPath}' was replaced by a different directory while it was being registered; the registration was kept, nothing was imported`
              )
            );
            continue;
          }
          await locked.assertStillOwned();
          const written = await importer.importProjectMemory({
            token: candidate.token,
            targetPath: registeredPath,
          });
          results.push({
            sourcePath: candidate.sourcePath,
            targetPath: registeredPath,
            name: candidate.name,
            status: "imported",
            writtenFiles: written.writtenFiles,
            skippedFiles: written.skippedFiles,
            registered,
          });
        } catch (error) {
          // A write that failed midway already created files; the result must list them or
          // the user has nothing to clean up by.
          results.push(
            error instanceof ProjectMemoryWriteError
              ? failed(error.message, error)
              : failed(error instanceof Error ? error.message : String(error))
          );
        }
      }
      return { results, reclassified };
    });
  }

  /**
   * `ProjectService.create` reports "already exists" both for the exact registered path
   * and for a target that only reaches a registered project through a symlinked parent.
   * Memory is keyed by the registered path's hash, so an alias must import to the
   * registered identity — writing under the alias would land files the project never
   * reads while reporting them as imported. Null when neither spelling is registered.
   */
  private resolveRegisteredProjectPath(
    targetPath: string,
    canonicalPath: string | null,
    registry: RegisteredProjectLookup
  ): string | null {
    const resolved = path.resolve(targetPath);
    if (registry.keys.has(resolved)) return resolved;
    if (canonicalPath === null) return null;
    if (registry.keys.has(canonicalPath)) return canonicalPath;
    // Registered keys may themselves be aliases (a project added through a symlinked
    // parent), so the target's real path is compared with each registered project's real
    // path rather than only looked up literally.
    return registry.byCanonical.get(canonicalPath) ?? null;
  }

  /**
   * Registered user projects and their real paths. Resolved once per restore, then extended
   * for import execution with only the projects registered since (`previous` supplies the
   * rest): per-candidate resolution would cost registered × approved filesystem calls.
   * Real paths are probed under one deadline for the whole pass, so a project on an
   * unavailable mount cannot make the restore look hung or hold the registration lock for
   * as long as that mount blocks; a project probed after the deadline records no real path
   * and is matched by its registered spelling only. That is safe for alias detection in all
   * but one exotic case: an import target resolved, so its directory is reachable, and a
   * registered spelling of that same directory can only be unreachable through a symlink
   * that itself sits on an unavailable mount.
   */
  private async registeredProjectLookup(
    previous?: RegisteredProjectLookup
  ): Promise<RegisteredProjectLookup> {
    const keys = new Set(
      [...this.config.loadConfigOrDefault().projects.entries()]
        .filter(([projectPath, projectConfig]) => !isSystemProjectEntry(projectPath, projectConfig))
        .map(([projectPath]) => projectPath)
    );
    const canonicalByKey = new Map<string, string | null>();
    const pending: string[] = [];
    for (const key of keys) {
      // Only resolved paths carry over: a key the planning pass could not resolve in time
      // is probed again, so a transient stall does not leave an alias undetected at the
      // moment an import decides whether to register.
      const known = previous?.canonicalByKey.get(key);
      if (known != null) canonicalByKey.set(key, known);
      else pending.push(key);
    }
    const probes = new AsyncSemaphore(REGISTRY_CANONICALIZE_CONCURRENCY);
    const deadline = Date.now() + REGISTRY_CANONICALIZE_DEADLINE_MS;
    const unresolved = new Set<string>();
    let unprobed = pending.length;
    let stalled = 0;
    await Promise.all(
      pending.map(async (key) => {
        const slot = await probes.acquire();
        try {
          // An equal share of the time left for each key still to probe, not all of it: a
          // key on an unavailable mount would otherwise use up the pass and leave every key
          // after it unprobed — at planning and, in the same order, again at execution, so
          // an alias of the import target behind it would never be seen and the target
          // registered as a second spelling of one directory.
          const budget =
            stalled < REGISTRY_MAX_STALLED_PROBES
              ? Math.ceil((deadline - Date.now()) / unprobed)
              : 0;
          unprobed -= 1;
          const probe = await registeredRealpathWithin(key, budget);
          if (probe.stalled) stalled += 1;
          if (probe.unknown) unresolved.add(key);
          canonicalByKey.set(key, probe.canonical);
        } finally {
          slot.release();
        }
      })
    );
    // Sorted so the project a shared real path resolves to does not depend on probe timing.
    const byCanonical = new Map<string, string>();
    for (const key of [...keys].sort()) {
      const canonical = canonicalByKey.get(key);
      if (canonical != null && !byCanonical.has(canonical)) byCanonical.set(canonical, key);
    }
    return { keys, canonicalByKey, byCanonical, unresolved };
  }

  /** One notification per project whose memory changed; failed imports' partial writes count too. */
  private notifyProjectMemoryChanges(
    restoredProjectMemory: ReadonlyArray<{ projectPath: string; files: string[] }>,
    importResults: readonly BackupProjectImportResult[]
  ): void {
    if (this.memoryNotifier === null) return;
    const changed = new Set<string>();
    for (const { projectPath, files } of restoredProjectMemory) {
      if (files.length > 0) changed.add(projectPath);
    }
    for (const result of importResults) {
      if (result.writtenFiles.length > 0) changed.add(result.targetPath);
    }
    for (const projectPath of changed) {
      this.memoryNotifier.notifyExternalProjectChange(projectPath);
    }
  }

  private async prepareRepository(
    settings: SettingsBackupInput
  ): Promise<PreparedBackupRepository> {
    const repository = await this.dependencies.gitRepo.prepare(settings, {
      onPrepareError: (repositoryRoot) => this.reapInactiveCaches(repositoryRoot),
    });
    await this.reapInactiveCaches(repository.rootDir);
    return repository;
  }

  private async reapInactiveCaches(repositoryRoot: string): Promise<void> {
    const currentCache = path.resolve(repositoryRoot);
    const currentName = path.basename(currentCache);
    if (!isBackupCacheName(currentName)) return;

    const cacheRoot = path.dirname(currentCache);
    await assertNotSymlink(cacheRoot);
    const now = new Date();
    await fs.utimes(currentCache, now, now).catch(() => undefined);

    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const inactive: Array<{ cachePath: string; mtimeMs: number; name: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isBackupCacheName(entry.name)) continue;
      if (entry.name === currentName || isCacheActive(entry.name)) continue;
      const cachePath = path.join(cacheRoot, entry.name);
      const stat = await fs.lstat(cachePath).catch(() => null);
      if (stat?.isDirectory() === true) {
        inactive.push({ cachePath, mtimeMs: stat.mtimeMs, name: entry.name });
      }
    }
    inactive.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    const stale = inactive.slice(BackupService.RETAINED_INACTIVE_CACHES);
    for (const cache of stale) {
      await discardInactiveCache(cache.cachePath).catch(() => undefined);
    }
    if (stale.length > 0) await reapDiscardedBackupCaches(cacheRoot);
  }

  private async persistSettings(
    settings: SettingsBackupInput,
    commitUpdate: Pick<SettingsBackup, "lastPushedCommit" | "lastRestoredCommit"> = {}
  ): Promise<SettingsBackup> {
    let saved: SettingsBackup | undefined;
    await this.config.editConfig((current) => {
      const previous = current.settingsBackup;
      const sameRepository =
        previous?.repoUrl === settings.repoUrl &&
        previous.branch === settings.branch &&
        previous.path === settings.path;
      const isCommitUpdate = Object.keys(commitUpdate).length > 0;
      // Commit metadata must not rewrite the repository settings tuple. Another window can
      // save a different repository while a push or restore is in flight.
      if (previous !== undefined && !sameRepository && isCommitUpdate) {
        saved = previous;
        return current;
      }
      saved = {
        // Recording a commit re-applies on top of the settings currently saved, not the
        // ones the operation started with: same repository, but another window may have
        // toggled includeProjects meanwhile, and that save must survive.
        ...(sameRepository && isCommitUpdate ? previous : settings),
        ...(sameRepository
          ? {
              lastPushedCommit: previous.lastPushedCommit,
              lastRestoredCommit: previous.lastRestoredCommit,
            }
          : {}),
        ...commitUpdate,
      };
      return { ...current, settingsBackup: saved };
    });

    if (saved == null) {
      throw new BackupServiceError("IO_ERROR", "Settings backup configuration was not saved");
    }
    // saveConfig logs and swallows write failures by design, so a resolved editConfig does
    // not prove the write landed; on a full disk this method would otherwise report saved
    // settings, a recorded push, or a recorded restore that config.json never received.
    // loadConfigOrDefault reads the file fresh, so a lost write reads back as the old value.
    const stored = this.config.loadConfigOrDefault().settingsBackup;
    if (
      stored?.repoUrl !== saved.repoUrl ||
      stored.branch !== saved.branch ||
      stored.path !== saved.path ||
      stored.includeProjects !== saved.includeProjects ||
      stored.lastPushedCommit !== saved.lastPushedCommit ||
      stored.lastRestoredCommit !== saved.lastRestoredCommit
    ) {
      throw new BackupServiceError(
        "IO_ERROR",
        "The backup settings could not be written to config.json"
      );
    }
    return saved;
  }

  /**
   * A snapshot is an unredacted copy of the whole local payload, and one is kept per restore as
   * its only recovery path, so they would otherwise grow without limit. Older ones are dropped
   * once this many newer released recovery points exist.
   */
  static readonly RETAINED_SNAPSHOTS = 3;

  private async reapOldSnapshots(cacheRoot: string, keepFrom: string): Promise<void> {
    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const released = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(SNAPSHOT_RELEASED_SUFFIX))
        .map((entry) => entry.name.slice(0, -SNAPSHOT_RELEASED_SUFFIX.length))
    );
    const keepName = path.basename(keepFrom);
    // Released only, which is what keeps a concurrent restore's snapshot out of reach; every
    // candidate's own restore has returned, so the order below only chooses which recovery
    // points to keep, never whether one is still in use.
    const reapable = entries
      // `isDirectory` is false for a symlink here, so a link is never followed or removed.
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SNAPSHOT_NAME_PREFIX))
      .map((entry) => entry.name)
      .filter((name) => name !== keepName && released.has(name))
      .sort((a, b) => (snapshotOrder(a) < snapshotOrder(b) ? 1 : -1));
    for (const stale of reapable.slice(BackupService.RETAINED_SNAPSHOTS - 1)) {
      // Per entry, because one snapshot nobody can delete must not stop the rest from being
      // reclaimed, and the restore it belongs to has already returned either way.
      await fs
        .rm(path.join(cacheRoot, stale), { recursive: true, force: true })
        .then(() => fs.rm(path.join(cacheRoot, `${stale}${SNAPSHOT_RELEASED_SUFFIX}`)))
        .catch(() => undefined);
    }
  }

  private async createSnapshotPath(): Promise<string> {
    // Mode matches the chmod `ensureCache` applies to this same directory: the snapshot
    // below is unredacted, so the tree above it must not be traversable by other users.
    const cacheRoot = path.join(this.config.rootDir, "backup-cache");
    // The snapshot holds the local settings unredacted, so a link here would put the copy
    // wherever it points (a world-readable /tmp, say).
    await assertNotSymlink(cacheRoot);
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    // Stamped so `reapOldSnapshots` can order snapshots by name; `mkdtemp` still supplies the
    // uniqueness, since two restores can start in the same millisecond.
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const sequence = String(this.snapshotSequence++).padStart(SNAPSHOT_SEQUENCE_DIGITS, "0");
    return fs.mkdtemp(path.join(cacheRoot, `${SNAPSHOT_NAME_PREFIX}${stamp}-${sequence}-`));
  }

  /**
   * One key, because the resource is the Xum root itself rather than any repository. Taken inside
   * `withRepoLock` everywhere, so the two are always acquired in the same order.
   */
  private withLocalPayload<T>(operation: () => Promise<T>): Promise<T> {
    return this.localPayload.withLock("mux-root", operation);
  }

  private withRepoLock<T>(
    settings: SettingsBackupInput,
    operation: (normalized: SettingsBackupInput) => Promise<Result<T, BackupOperationError>>
  ): Promise<Result<T, BackupOperationError>> {
    let normalized: SettingsBackupInput;
    try {
      normalized = normalizeBackupSettings(settings);
    } catch (error) {
      return Promise.resolve(Err(toOperationError(error)));
    }
    const cacheName = backupCacheName(normalized.repoUrl, normalized.branch);
    return this.locks.withLock(repoLockKey(normalized), async () => {
      const registration = registerActiveCache(cacheName);
      const releaseCache = typeof registration === "function" ? registration : await registration;
      try {
        return await operation(normalized);
      } catch (error) {
        return Err(toOperationError(error));
      } finally {
        releaseCache();
      }
    });
  }
}
