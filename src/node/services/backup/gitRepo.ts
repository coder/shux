import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listBackupManagedPathSpellings } from "@/common/compat/legacyMux";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { isErrnoWithCode } from "@/node/utils/fs";
import {
  BackupAuthFailedError,
  BackupRemoteUnreachableError,
  GIT_SCOPE_ENV_UNSET,
  runGitWithCredentialLadder,
  type BackupCredential,
  type GitCredentialOptions,
} from "./credentials";
import {
  assertBackupPathComplexity,
  BACKUP_MANIFEST_FILE,
  BackupInvalidPayloadError,
  isParseableBackupManifest,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_FILE_COUNT,
  MAX_BACKUP_TOTAL_BYTES,
} from "./payload";

/**
 * Only the managed directory is ever read out of the cache, so blobs are fetched on demand
 * rather than up front. A dotfiles repository can hold anything elsewhere in its tree.
 */
const BLOB_FILTER = "blob:none";
const SHALLOW_FILTER_ARGS = ["--depth=1", `--filter=${BLOB_FILTER}`] as const;

/**
 * True only for the rejections that mean the remote branch moved, which is what the user can fix
 * by reading the backup again. git distinguishes these by status token: `[rejected]` is the ref
 * update git itself declined, while `[remote rejected]` is the server declining, so a protected
 * branch or a pre-receive hook must not be reported as drift. Matching the whole line rather
 * than the word `rejected` keeps a hook's own message out of it too.
 */
function isRemoteMovedRejection(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some(
      (line) =>
        /^\s*!\s*\[rejected\]/.test(line) &&
        /\((stale info|fetch first|non-fast-forward)\)/.test(line)
    );
}

/** Remote transports and credential helpers are untrusted and can emit output without bound. */
export const MAX_NETWORK_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

// The subprocess timeout limits transfer duration; this rejects caches retaining excess object data.
export const MAX_BACKUP_CACHE_OBJECT_KIB = 512 * 1024;

/**
 * `ls-remote` is asked for every ref rather than only the configured branch, because emptiness
 * decides whether a repository can be initialized and any ref at all answers that. A backup
 * repository is writable by whoever holds the credential, so the answer is bounded instead: this
 * admits far more refs than a settings repository has, while refusing to buffer without end.
 */
const MAX_LS_REMOTE_OUTPUT_BYTES = 1024 * 1024;

/**
 * Applied to every git command that runs against the cache. The cache directory is reachable
 * by other processes, and these two git features execute or substitute based on repository
 * state that `sanitizeCacheConfig` cannot rewrite: an executable dropped into `.git/hooks`
 * would run on commit and checkout, and a ref under `refs/replace/` substitutes another
 * object's content at read time without changing the commit hash the stored settings pin.
 * Command-line options rather than config, so state written after the sanitize pass cannot
 * override them. Nothing exists under `os.devNull`, so no hook resolves.
 *
 * Auto gc detaches by default (`gc.autoDetach`), which would leave a git holding cache locks
 * after the command that started it was awaited, so it is disabled here too.
 */
const GIT_HARDENING_ARGS = [
  "--no-replace-objects",
  "-c",
  `core.hooksPath=${os.devNull}`,
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/**
 * Only valid platform flags written by `git init` or `git clone`, plus recognized repository
 * extensions, survive. Malformed values are dropped; repository format and
 * `core.bare` are forced below because this cache always has known values for them.
 */
function shouldKeepCacheConfigEntry(key: string, value: string): boolean {
  if (
    key === "core.filemode" ||
    key === "core.logallrefupdates" ||
    key === "core.ignorecase" ||
    key === "core.precomposeunicode" ||
    key === "core.symlinks"
  ) {
    return value === "true" || value === "false";
  }
  if (key === "extensions.partialclone") return value === "origin";
  return key === "extensions.objectformat" && value === "sha256";
}

/**
 * Config alone is not enough: `.gitattributes` in the backup repository outranks it, so a
 * dotfiles repo carrying `* text=auto eol=crlf` still converts (verified against git 2.54).
 * `.git/info/attributes` is the per-repository layer that outranks the tree's own file.
 * Every attribute that can transform bytes between the object store and the worktree is
 * unset here, not just `text`: `ident` expands `$Id$` at checkout, `filter` runs
 * smudge/clean drivers, and `working-tree-encoding` transcodes, so any of them under the
 * managed path would break the manifest's SHA-256s the same way EOL conversion does.
 */
const VERBATIM_ATTRIBUTES = "* -text -eol -ident -filter -working-tree-encoding\n";

const GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Xum Settings Backup",
  "-c",
  "user.email=mux-settings-backup@localhost",
  "-c",
  "commit.gpgsign=false",
] as const;

/**
 * Refusals to touch content this cache cannot prove it owns, typed so `materialize` rethrows
 * them instead of answering them with a discard. No `code`, so they keep the IO_ERROR mapping
 * they had as plain errors.
 */
export class BackupCacheSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCacheSafetyError";
  }
}

// `code` is what BackupService.toOperationError maps onto the typed result, so these
// must carry one or they degrade to IO_ERROR and the UI loses the actionable message.
export class BackupOriginMismatchError extends Error {
  readonly code = "GIT_ERROR";

  constructor(actual: string, expected: string) {
    super(`Backup cache origin is '${actual}', expected '${expected}'`);
    this.name = "BackupOriginMismatchError";
  }
}

export class BackupNonFastForwardError extends Error {
  readonly code = "REPOSITORY_CHANGED";

  constructor() {
    super("The backup changed since you last read it");
    this.name = "BackupNonFastForwardError";
  }
}

export interface BackupRepoCacheOptions extends Omit<GitCredentialOptions, "repoUrl"> {
  repoUrl: string;
  branch: string;
  cacheRoot: string;
  /**
   * Scopes the sparse checkout, so nothing outside it is ever materialized. materialize()
   * may swap in the legacy `mux` spelling of this path; see `effectiveManagedPath`.
   */
  managedPath: string;
  materializationLimits?: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxFileCount?: number;
  };
  maxCacheObjectKib?: number;
}

type BackupMaterializationLimits = Required<
  NonNullable<BackupRepoCacheOptions["materializationLimits"]>
>;

function resolveBoundedLimit(value: number | undefined, maximum: number, name: string): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a safe integer between 0 and ${maximum}`);
  }
  return value;
}

function parseObjectStoreKib(stdout: string): number {
  const sizes = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(size|size-pack|size-garbage): ([0-9]+)$/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) {
      throw new Error("Git returned an invalid object store size");
    }
    sizes.set(match[1], value);
  }
  const looseKib = sizes.get("size");
  const packedKib = sizes.get("size-pack");
  const garbageKib = sizes.get("size-garbage");
  if (looseKib === undefined || packedKib === undefined || garbageKib === undefined) {
    throw new Error("Git returned an invalid object store size");
  }
  const totalKib = looseKib + packedKib + garbageKib;
  if (!Number.isSafeInteger(totalKib)) {
    throw new Error("Git returned an invalid object store size");
  }
  return totalKib;
}

interface ManagedBlobEntry {
  objectId: string;
  path: string;
  size: number | null;
}

const BLOB_PREFETCH_BATCH_SIZE = 16;

/** One non-recursive ls-tree record for a bounded-length path; anything larger is hostile. */
const MANIFEST_LOOKUP_MAX_OUTPUT_BYTES = 16384;

export interface RemoteRefs {
  credential: BackupCredential;
  branchCommit: string | null;
  refs: ReadonlyMap<string, string>;
}

type GitObjectFormat = "sha1" | "sha256";

function objectFormatFromRefs(refs: ReadonlyMap<string, string>): GitObjectFormat | null {
  let format: GitObjectFormat | null = null;
  for (const objectId of refs.values()) {
    const nextFormat = objectId.length === 40 ? "sha1" : objectId.length === 64 ? "sha256" : null;
    if (nextFormat === null) {
      throw new Error(`Remote advertised an unsupported Git object ID length: ${objectId.length}`);
    }
    if (format !== null && format !== nextFormat) {
      throw new Error("Remote advertised mixed Git object formats");
    }
    format = nextFormat;
  }
  return format;
}

/**
 * `--no-cone` sparse patterns are gitignore-style rather than pathspecs, so the same
 * managed directory has to be escaped instead: unescaped, `/mux[1]/*` selects `mux1` and
 * the real backup is never materialized.
 */
function escapeSparsePattern(relativePath: string): string {
  return relativePath.replace(/[\\*?[\]]/g, "\\$&");
}

/**
 * The managed path is user-supplied and is passed to `git clean -fd --` and
 * `git commit --`, so it has to stay a strict subdirectory. `.` would widen those
 * commands to the whole cache clone, which must never happen.
 *
 * Returns the joined segments so every git call uses one normalized form. The settings
 * default is `mux/`, and as a gitignore-style sparse pattern `/mux//*` matches nothing
 * while the payload is still written to `mux`, leaving the backup invisible.
 */
function safeRelativePath(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== "");
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || segment.toLowerCase() === ".git"
    )
  ) {
    throw new Error(`Expected a safe relative path, got '${relativePath}'`);
  }
  return segments.join("/");
}

function isRelativeLocalRepoPath(repoUrl: string): boolean {
  return (
    !path.isAbsolute(repoUrl) && !repoUrl.includes("://") && !/^(?:[^@]+@)?[^:/]+:/.test(repoUrl)
  );
}

/**
 * Relative local URLs resolve from the cache root's stable parent (`MUX_ROOT` in production),
 * not the process cwd, which differs between terminal and desktop launches. Concatenation
 * preserves `..` around symlinks, which lexical path normalization can change.
 */
function repoUrlForGit(repoUrl: string, cacheRoot: string): string {
  if (!isRelativeLocalRepoPath(repoUrl)) return repoUrl;
  const base = path.dirname(path.resolve(cacheRoot));
  return `${base}${base.endsWith(path.sep) ? "" : path.sep}${repoUrl}`;
}

async function matchesConfiguredRepoUrl(
  actual: string,
  configured: string,
  effective: string
): Promise<boolean> {
  if (actual === configured || actual === effective) return true;
  if (!path.isAbsolute(actual) || !isRelativeLocalRepoPath(configured)) return false;
  try {
    return (await fs.realpath(actual)) === (await fs.realpath(effective));
  } catch {
    return false;
  }
}

function usesLocalUploadPack(repoUrl: string): boolean {
  if (path.isAbsolute(repoUrl)) return true;
  try {
    return new URL(repoUrl).protocol === "file:";
  } catch {
    return false;
  }
}

function localUploadPackArgs(repoUrl: string): string[] {
  return usesLocalUploadPack(repoUrl)
    ? ["--upload-pack=git -c uploadpack.allowFilter=true upload-pack"]
    : [];
}

function localCloneArgs(repoUrl: string): string[] {
  const uploadPackArgs = localUploadPackArgs(repoUrl);
  return path.isAbsolute(repoUrl) ? ["--no-local", ...uploadPackArgs] : uploadPackArgs;
}

async function runLocalGit(
  args: string[],
  options: ExecFileAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  using process = execFileAsync("git", args, {
    ...options,
    env: { ...options.env, ...GIT_SCOPE_ENV_UNSET },
    killTreeOnTermination: true,
  });
  return await process.result;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A cache directory holds the local allowlisted payload, which includes files still awaiting the
 * user's approval, so it must be a real directory under the Xum root rather than a link out of
 * it. `mkdir` with `recursive` succeeds on a symlink to an existing directory, and a
 * pre-created per-repository link passes the origin check when its target is a valid clone, so
 * both the root and the path below it are checked.
 */
export async function assertNotSymlink(target: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() === true) {
    throw new BackupCacheSafetyError(`Refusing to use '${target}': it is a symlink`);
  }
}

/**
 * `.git` can redirect every git command elsewhere without being a symlink: a plain-file
 * `.git` (a gitfile, `gitdir: <path>`) and a `commondir` file inside a real `.git` both
 * resolve config, refs, and objects to another repository (gitrepository-layout(5)), so a
 * pre-created cache carrying either would take this cache's config writes with it. The
 * cache must be its own self-contained repository; an absent `.git` is fine, since the
 * caller is about to create one.
 */
async function assertOwnGitDirectory(cachePath: string): Promise<void> {
  const gitDir = path.join(cachePath, ".git");
  const existing = await fs.lstat(gitDir).catch(() => null);
  if (existing === null) return;
  if (existing.isSymbolicLink()) {
    throw new BackupCacheSafetyError(`Refusing to use '${gitDir}': it is a symlink`);
  }
  if (!existing.isDirectory()) {
    throw new BackupCacheSafetyError(`Refusing to use '${gitDir}': it is not a directory`);
  }
  const commonDir = await fs.lstat(path.join(gitDir, "commondir")).catch(() => null);
  if (commonDir !== null) {
    throw new BackupCacheSafetyError(
      `Refusing to use '${gitDir}': it redirects to another repository`
    );
  }
}

/**
 * An interrupted create can leave the cache directory behind with no `.git` yet, and git clones
 * into an empty directory, so one is reused instead of refused. A non-empty directory cannot
 * prove it belongs to this cache, so it is refused rather than deleted.
 */
async function isEmptyOrAbsentDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => null);
  if (stat === null) return true;
  if (!stat.isDirectory()) return false;
  return (await fs.readdir(target)).length === 0;
}

/**
 * Git accepts a directory as a repository only with these three entries present and of these
 * types, so a `.git` missing or mistyping any of them cannot serve a single later command.
 * `normalizeGitMetadataLinks` has already rejected symlinks, so `lstat` sees the real entries.
 */
async function isCompleteGitDirectory(gitDir: string): Promise<boolean> {
  const entries = await Promise.all(
    ["HEAD", "objects", "refs"].map((entry) => fs.lstat(path.join(gitDir, entry)).catch(() => null))
  );
  const [head, objects, refs] = entries;
  return head?.isFile() === true && objects?.isDirectory() === true && refs?.isDirectory() === true;
}

/**
 * Git rewrites an open-ended set of metadata paths. Symlinks are rejected, and
 * multiply-linked regular files are copied to cache-owned inodes before Git runs, so Git
 * cannot update an outside hard-link alias. New local clones also use `--no-hardlinks`.
 *
 * `*.lock` files are deleted rather than kept, because one that survived a kill blocks its
 * metadata update until removed by hand. BackupService serializes each configured repository
 * and awaits every git it spawns, and `GIT_HARDENING_ARGS` disables the auto gc that would
 * otherwise detach, so no git this process started is still holding a lock here.
 */
async function normalizeGitMetadataLinks(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const metadata = await fs.lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      throw new BackupCacheSafetyError(`Refusing to use '${entryPath}': it is a symlink`);
    }
    if (metadata.isDirectory()) {
      await normalizeGitMetadataLinks(entryPath);
    } else if (!metadata.isFile()) {
      throw new BackupCacheSafetyError(`Refusing to use '${entryPath}': it is not a regular file`);
    } else if (entry.endsWith(".lock")) {
      await fs.rm(entryPath, { force: true });
    } else if (metadata.nlink > 1) {
      await severHardLink(entryPath, metadata.dev, metadata.ino);
    }
  }
}

async function severHardLink(
  filePath: string,
  expectedDevice: number,
  expectedInode: number
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.mux-unlink-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    const source = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const sourceMetadata = await source.stat();
      if (
        !sourceMetadata.isFile() ||
        sourceMetadata.dev !== expectedDevice ||
        sourceMetadata.ino !== expectedInode
      ) {
        throw new BackupCacheSafetyError(
          `Refusing to use '${filePath}': it changed while checking hard links`
        );
      }
      if (sourceMetadata.nlink <= 1) return;

      const replacement = await fs.open(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        sourceMetadata.mode & 0o777
      );
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await replacement.write(
              buffer,
              written,
              bytesRead - written,
              position + written
            );
            if (bytesWritten === 0) {
              throw new Error(`Failed to copy hard-linked Git metadata '${filePath}'`);
            }
            written += bytesWritten;
          }
          position += bytesRead;
        }
        await replacement.chmod(sourceMetadata.mode & 0o777);
      } finally {
        await replacement.close();
      }
    } finally {
      await source.close();
    }

    await fs.rename(temporaryPath, filePath);
    const normalized = await fs.lstat(filePath);
    if (!normalized.isFile() || normalized.nlink !== 1) {
      throw new Error(`Failed to sever hard links for Git metadata '${filePath}'`);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

/**
 * The raw stored entries, not effective config: `--file` keeps the global and system scopes
 * out, `--no-includes` keeps an `include.path` from splicing another file's keys into what is
 * checked, and `-z` keeps values with newlines parseable. A record is `key\nvalue`; a boolean
 * shorthand like `[core] bare` has no newline and reads back as true.
 */
async function readRawConfigEntries(
  configPath: string,
  options: ExecFileAsyncOptions
): Promise<Array<readonly [string, string]>> {
  const result = await runLocalGit(
    ["config", "--no-includes", "--file", configPath, "--list", "-z"],
    { ...options, env: { ...options.env, LC_ALL: "C" } }
  );
  const entries: Array<readonly [string, string]> = [];
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    entries.push(
      separator === -1
        ? [record, "true"]
        : [record.slice(0, separator), record.slice(separator + 1)]
    );
  }
  return entries;
}

function isMalformedConfigSyntaxError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const commandError = error as { code?: unknown; signal?: unknown; stderr?: unknown };
  return (
    commandError.code === 128 &&
    commandError.signal === null &&
    typeof commandError.stderr === "string" &&
    /^fatal: bad config(?: file)? line \d+/m.test(commandError.stderr)
  );
}

/**
 * Every component is checked before anything is written, and the file is opened without
 * following a final link, because this writes to fixed paths inside a directory other
 * processes can reach: a link at `.git`, `.git/info`, or the file itself would redirect the
 * write. `.git` is re-checked here rather than trusting the caller, so this is safe on its
 * own terms.
 */
async function writeOwnedGitInfoFile(
  cachePath: string,
  fileName: string,
  content: string
): Promise<void> {
  await assertOwnGitDirectory(cachePath);
  const infoDir = path.join(cachePath, ".git", "info");
  await assertNotSymlink(infoDir);
  await fs.mkdir(infoDir, { recursive: true });
  const filePath = path.join(infoDir, fileName);
  await assertNotSymlink(filePath);
  const handle = await fs.open(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

const BACKUP_CACHE_KEY_HEX_LENGTH = 12;

export function backupCacheName(repoUrl: string, branch: string): string {
  return createHash("sha256")
    .update(`${repoUrl}\n${branch}`)
    .digest("hex")
    .slice(0, BACKUP_CACHE_KEY_HEX_LENGTH);
}

export function backupCachePath(cacheRoot: string, repoUrl: string, branch: string): string {
  return path.join(cacheRoot, backupCacheName(repoUrl, branch));
}

const CACHE_NAME = new RegExp(`^[0-9a-f]{${BACKUP_CACHE_KEY_HEX_LENGTH}}$`);
const CACHE_SUFFIX_DISCARDED = ".discarded-";
const DISCARDED_CACHE_NAME = new RegExp(
  `^[0-9a-f]{${BACKUP_CACHE_KEY_HEX_LENGTH}}\\${CACHE_SUFFIX_DISCARDED}`
);

export function isBackupCacheName(name: string): boolean {
  return CACHE_NAME.test(name);
}

/**
 * A crash after a cache rename can leave a tombstone holding a whole repository. Reaping is best
 * effort, so one that cannot be deleted keeps its disk rather than failing every later backup.
 */
export async function reapDiscardedBackupCaches(cacheRoot: string): Promise<void> {
  const entries = await fs.readdir(cacheRoot).catch(() => []);
  for (const entry of entries) {
    if (!DISCARDED_CACHE_NAME.test(entry)) continue;
    // `fs.rm` unlinks a symlink rather than following it, so a planted tombstone link cannot
    // reach the directory it names.
    await fs
      .rm(path.join(cacheRoot, entry), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
  }
}

/**
 * The last check before deletion requires a real directory holding local `.git` metadata.
 * It proves the shape at this path, not that it is the same clone previously validated.
 */
async function assertDiscardableBackupCache(cachePath: string): Promise<void> {
  await assertNotSymlink(cachePath);
  const stat = await fs.lstat(cachePath).catch(() => null);
  if (stat === null) return;
  if (!stat.isDirectory()) {
    throw new BackupCacheSafetyError(`Refusing to discard '${cachePath}': it is not a directory`);
  }
  await assertOwnGitDirectory(cachePath);
  if (!(await exists(path.join(cachePath, ".git")))) {
    throw new BackupCacheSafetyError(
      `Refusing to discard '${cachePath}': it holds no git repository`
    );
  }
}

async function renameAndDeleteBackupCache(cachePath: string): Promise<void> {
  const tombstone = `${cachePath}${CACHE_SUFFIX_DISCARDED}${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(cachePath, tombstone);
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return;
    throw error;
  }
  await fs.rm(tombstone, { recursive: true, force: true });
}

/**
 * Renaming first keeps an interrupted recursive delete from leaving a cache path populated but
 * without its `.git`, a shape indistinguishable from content this feature must never delete.
 */
export async function discardBackupCache(cachePath: string): Promise<void> {
  await assertDiscardableBackupCache(cachePath);
  await renameAndDeleteBackupCache(cachePath);
}

export class BackupRepoCache {
  readonly cachePath: string;
  private readonly repoUrl: string;
  private readonly materializationLimits: BackupMaterializationLimits;
  private readonly maxCacheObjectKib: number;
  private baseRemoteCommit: string | null | undefined;
  private usedCredential: BackupCredential | undefined;
  private selectedManagedPath: string | undefined;

  constructor(private readonly options: BackupRepoCacheOptions) {
    this.cachePath = backupCachePath(options.cacheRoot, options.repoUrl, options.branch);
    this.repoUrl = repoUrlForGit(options.repoUrl, options.cacheRoot);
    this.materializationLimits = {
      maxFileBytes: resolveBoundedLimit(
        options.materializationLimits?.maxFileBytes,
        MAX_BACKUP_FILE_BYTES,
        "maxFileBytes"
      ),
      maxTotalBytes: resolveBoundedLimit(
        options.materializationLimits?.maxTotalBytes,
        MAX_BACKUP_TOTAL_BYTES,
        "maxTotalBytes"
      ),
      maxFileCount: resolveBoundedLimit(
        options.materializationLimits?.maxFileCount,
        MAX_BACKUP_FILE_COUNT,
        "maxFileCount"
      ),
    };
    this.maxCacheObjectKib = resolveBoundedLimit(
      options.maxCacheObjectKib,
      MAX_BACKUP_CACHE_OBJECT_KIB,
      "maxCacheObjectKib"
    );
  }

  get credential(): BackupCredential | undefined {
    return this.usedCredential;
  }

  /**
   * The managed path this cache actually uses, resolved by materialize(). It is the
   * configured spelling unless that tree has no backup manifest while the legacy `mux`
   * spelling from before the product rename does — then reads and writes both follow the
   * legacy spelling, so a pre-rename backup keeps working and pushes update it in place.
   */
  get effectiveManagedPath(): string {
    return this.selectedManagedPath ?? this.options.managedPath;
  }

  private credentialOptions(): GitCredentialOptions {
    return {
      repoUrl: this.repoUrl,
      timeoutMs: this.options.timeoutMs,
      signal: this.options.signal,
      onStderrData: this.options.onStderrData,
      env: this.options.env,
    };
  }

  private async networkGit(args: string[], options: { maxOutputBytes?: number } = {}) {
    // Hardening args go after the `-C` pair: the credential ladder recognizes the target
    // repository by `args[0]`. Commands without `-C` (clone, ls-remote) run before any cache
    // repository state exists, so there is nothing for the hardening to disable yet.
    const hardened =
      args[0] === "-C" ? [...args.slice(0, 2), ...GIT_HARDENING_ARGS, ...args.slice(2)] : args;
    const result = await runGitWithCredentialLadder(hardened, {
      ...this.credentialOptions(),
      ...options,
      maxOutputBytes: options.maxOutputBytes ?? MAX_NETWORK_GIT_OUTPUT_BYTES,
    });
    this.usedCredential = result.credential;
    return result;
  }

  private async localGit(
    args: string[],
    options: Pick<ExecFileAsyncOptions, "env" | "maxOutputBytes"> = {}
  ) {
    return await runLocalGit(["-C", this.cachePath, ...GIT_HARDENING_ARGS, ...args], {
      ...this.options,
      ...options,
      env: { ...this.options.env, ...options.env },
    });
  }

  private async assertObjectStoreWithinBudget(): Promise<void> {
    const objectKib = parseObjectStoreKib((await this.localGit(["count-objects", "-v"])).stdout);
    if (objectKib > this.maxCacheObjectKib) {
      const error = new BackupInvalidPayloadError(
        new Error(`Backup cache object data exceeds the ${this.maxCacheObjectKib} KiB limit`)
      );
      await this.discardCache();
      throw error;
    }
  }

  async lsRemote(): Promise<RemoteRefs> {
    const result = await this.networkGit(["ls-remote", this.repoUrl], {
      maxOutputBytes: MAX_LS_REMOTE_OUTPUT_BYTES,
    });
    const refs = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40,64})\s+(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) refs.set(match[2], match[1]);
    }
    return {
      credential: result.credential,
      branchCommit: refs.get(`refs/heads/${this.options.branch}`) ?? null,
      refs,
    };
  }

  private async pinVerbatimContent(): Promise<void> {
    await writeOwnedGitInfoFile(this.cachePath, "attributes", VERBATIM_ATTRIBUTES);
  }

  /**
   * Creates an empty repository: the same starting point `resetToUnbornBranch` produces,
   * without any transfer. Only `git init` happens here; the remote and filter configuration
   * comes from `sanitizeCacheConfig`, which every `ensureCache` writes, so an initialization
   * interrupted partway is repaired on the next run rather than leaving a `.git` that fails
   * checks forever.
   */
  private async initEmptyCache(objectFormat: GitObjectFormat): Promise<void> {
    // `init <dir>` creates the directory, so this runs before `localGit` has one to -C into.
    await runLocalGit(
      [
        "init",
        `--object-format=${objectFormat}`,
        "--initial-branch",
        this.options.branch,
        this.cachePath,
      ],
      this.options
    );
  }

  private async cloneCache(branch?: string): Promise<void> {
    // `--no-checkout` defers materialization until `resetHardToRemote` applies sparse checkout.
    // Bound unvalidated history to one commit. Local paths need the upload-pack transport
    // for blob filtering instead of copying the full object database.
    await this.networkGit([
      "clone",
      ...localCloneArgs(this.repoUrl),
      "--no-hardlinks",
      "--no-checkout",
      "--single-branch",
      ...SHALLOW_FILTER_ARGS,
      ...(branch === undefined ? [] : ["--branch", branch]),
      "--origin",
      "origin",
      this.repoUrl,
      this.cachePath,
    ]);
    await this.assertObjectStoreWithinBudget();
  }

  private async createCache(): Promise<void> {
    const remote = await this.lsRemote();
    if (remote.branchCommit !== null) {
      await this.cloneCache(this.options.branch);
      return;
    }

    const objectFormat = objectFormatFromRefs(remote.refs);
    if (objectFormat === null) {
      // Cloning lets Git negotiate the object format when the remote has no refs.
      await this.cloneCache();
      return;
    }

    // Cloning a nonexistent branch fails, so initialize an unborn branch in the format
    // advertised by the remote's other refs.
    await this.initEmptyCache(objectFormat);
  }

  private async discardCache(): Promise<void> {
    await assertDiscardableBackupCache(this.cachePath);
    try {
      await renameAndDeleteBackupCache(this.cachePath);
    } finally {
      this.baseRemoteCommit = undefined;
    }
  }

  async ensureCache(): Promise<void> {
    await assertNotSymlink(this.options.cacheRoot);
    await fs.mkdir(this.options.cacheRoot, { recursive: true, mode: 0o700 });
    // chmod as well: mkdir's mode applies only at creation, and this tree holds exported
    // payload bytes and unredacted restore snapshots, written by git and by Xum with modes
    // that assume nobody else can traverse this far. Owner-only at the top is the boundary
    // that keeps every file below private, including caches made before this rule.
    await fs.chmod(this.options.cacheRoot, 0o700);
    await reapDiscardedBackupCaches(this.options.cacheRoot);
    await assertNotSymlink(this.cachePath);
    const gitDir = path.join(this.cachePath, ".git");
    // Before any branch below, because each one writes: a `.git` that resolves to another
    // repository, whether a symlink, a gitfile, or a commondir indirection, would take this
    // cache's config rewrite with it.
    await assertOwnGitDirectory(this.cachePath);
    await normalizeGitMetadataLinks(gitDir);
    if (!(await isCompleteGitDirectory(gitDir))) {
      if (await exists(gitDir)) {
        // Git rejects this directory outright, so no later command can use it. The cache is
        // disposable, so it is rebuilt rather than left permanently failing.
        await this.discardCache();
      } else if (!(await isEmptyOrAbsentDirectory(this.cachePath))) {
        throw new BackupCacheSafetyError(
          `Backup cache path exists but is not a git repository: ${this.cachePath}`
        );
      }
      // A settings backup often lives in an existing dotfiles repository, and nothing here
      // ever reads a ref other than `origin/<branch>`. Transferring anything else is waste
      // that sparse checkout does not bound, because it limits the working tree and not the
      // transfer.
      await this.createCache();
    }
    // Both run every time rather than only at creation, so a cache made by an earlier version
    // of this code, or altered since, is brought back to the state Xum expects before any
    // other git command trusts what is stored there.
    try {
      await this.sanitizeCacheConfig();
    } catch (error) {
      if (!isMalformedConfigSyntaxError(error)) throw error;
      // Malformed config prevents validating redirect-sensitive settings. Replace the
      // disposable cache rather than trust its Git configuration.
      await this.discardCache();
      await this.createCache();
      await this.sanitizeCacheConfig();
    }
    await this.pinVerbatimContent();
  }

  /**
   * Rebuilds `.git/config` instead of verifying it key by key. Git trusts this file for far
   * more than a destination URL: `core.worktree` moves every worktree command elsewhere,
   * `url.*.pushInsteadOf` rewrites where a push lands after the URL checks pass,
   * `include.path` splices in another file, and keys like `core.sshCommand` or
   * `credential.helper` name commands to execute. That is an open-ended surface, so only
   * validated platform flags and recognized repository extensions survive; every key Xum
   * depends on is rewritten to its known value. User-global and system configuration are untouched:
   * the user's own git setup, honored the same way the user's own `git push` would honor it.
   *
   * Two conditions are rejected rather than healed, the same way a gitfile or commondir
   * redirect is: a stored destination that is not the configured repository, and a
   * `core.worktree` redirect. Nothing that legitimately wrote this cache produces either, so
   * both mean the cache is not this feature's own clone.
   */
  private async sanitizeCacheConfig(): Promise<void> {
    const gitDir = path.join(this.cachePath, ".git");
    await assertOwnGitDirectory(this.cachePath);
    const configPath = path.join(gitDir, "config");
    await assertNotSymlink(configPath);
    const entries = (await exists(configPath))
      ? await readRawConfigEntries(configPath, this.options)
      : [];
    const valuesOf = (key: string) =>
      entries.filter(([entryKey]) => entryKey === key).map(([, value]) => value);
    if (valuesOf("core.worktree").length > 0) {
      throw new BackupCacheSafetyError(
        `Refusing to use '${configPath}': core.worktree redirects the working tree`
      );
    }
    // `remote.origin.pushurl` overrides the url for pushes only and is multi-valued, so every
    // value is held to the same expectation as the url; absent means pushes use the url.
    for (const url of [...valuesOf("remote.origin.url"), ...valuesOf("remote.origin.pushurl")]) {
      if (!(await matchesConfiguredRepoUrl(url, this.options.repoUrl, this.repoUrl))) {
        throw new BackupOriginMismatchError(url, this.options.repoUrl);
      }
    }

    const branch = this.options.branch;
    // A map, not a filtered list: these keys are single-valued to git (the last occurrence
    // wins), so keeping every occurrence would carry any number of stray values forward.
    const kept = new Map(entries.filter(([key, value]) => shouldKeepCacheConfigEntry(key, value)));
    const rebuilt: Array<readonly [string, string]> = [
      // Partial clone state below requires repository format version 1. Forcing it also
      // self-heals malformed values that would make Git reject the cache before any repair.
      ["core.repositoryformatversion", "1"],
      ...kept,
      ["remote.origin.url", this.repoUrl],
      ["remote.origin.fetch", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      // What `clone --filter` writes for itself. Without them a later fetch of this branch
      // would download every blob reachable from it, including files outside the managed
      // directory that sparse checkout never materializes.
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", BLOB_FILTER],
      [`branch.${branch}.remote`, "origin"],
      [`branch.${branch}.merge`, `refs/heads/${branch}`],
      // The payload is bytes, not text: the manifest records a SHA-256 per file and a restore
      // writes what it reads, so any end-of-line conversion in this worktree breaks the
      // checksum and would put rewritten bytes on the user's disk. Pinned on the repository
      // rather than only per command, so a git command run here by hand behaves the same way.
      ["core.autocrlf", "false"],
      ["core.eol", "lf"],
      // Turns on the pattern file `applySparseCheckout` writes. Non-cone because the managed
      // path is a single literal directory, not a cone pattern set.
      ["core.sparsecheckout", "true"],
      ["core.sparsecheckoutcone", "false"],
      // Defense in depth alongside GIT_HARDENING_ARGS, for git commands run here by hand.
      ["core.hookspath", os.devNull],
      // Known, not preserved: a stray `true` fails every worktree command with "this
      // operation must be run in a work tree", permanently, since nothing else rewrites it.
      ["core.bare", "false"],
    ];
    // Built as a separate file and renamed into place: `git config` is the writer, so value
    // escaping is git's own rather than hand-rolled serialization of its config grammar.
    const rewritePath = `${configPath}.mux-rewrite`;
    await fs.rm(rewritePath, { force: true });
    for (const [key, value] of rebuilt) {
      await runLocalGit(["config", "--file", rewritePath, "--add", key, value], this.options);
    }
    await fs.rename(rewritePath, configPath);
    // Worktree-scoped config is trusted by git the same way (it can hold `core.worktree`
    // too), and everything Xum keeps is in the file just written, so it is removed rather
    // than parsed. `extensions.worktreeConfig` is not a kept key, so a leftover file would be
    // inert anyway; earlier versions of this code let `git sparse-checkout set` create it.
    await fs.rm(path.join(gitDir, "config.worktree"), { force: true });
  }

  async fetch(): Promise<string | null> {
    // Only the configured branch, for the same reason the clone is single-branch. An explicit
    // refspec is an error when the remote lacks that branch, unlike the wildcard it replaced,
    // and an empty or not-yet-created backup branch is an ordinary state here: report it as
    // unborn rather than failing the operation.
    const branch = this.options.branch;
    if ((await this.lsRemote()).branchCommit === null) {
      await this.pruneMissingRemoteBranch();
      return null;
    }
    await this.networkGit([
      "-C",
      this.cachePath,
      "fetch",
      ...SHALLOW_FILTER_ARGS,
      ...localUploadPackArgs(this.repoUrl),
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    await this.assertObjectStoreWithinBudget();
    return await this.remoteBranchCommit();
  }

  /**
   * Drops a remote-tracking ref the remote no longer has, which `--prune` did while the fetch
   * used a wildcard. Without it a cache that still holds the branch from before it was deleted
   * remotely would push that history back, recreating files the user deleted deliberately.
   * Deleting an absent ref is a no-op, so this runs whether or not the ref is there.
   */
  private async pruneMissingRemoteBranch(): Promise<void> {
    // Not caught: `update-ref -d` already succeeds when the ref is absent, so a failure here is
    // a real one, such as a competing lock. Swallowing it would report the branch as unborn
    // while `resetHardToRemote` still reads the stale tracking ref and works on the backup the
    // user deleted.
    await this.localGit(["update-ref", "-d", `refs/remotes/origin/${this.options.branch}`]);
  }

  private async remoteBranchCommit(): Promise<string | null> {
    try {
      return (
        await this.localGit([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${this.options.branch}`,
        ])
      ).stdout.trim();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 1) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The one managed path this cache materializes, reads, and writes: the configured
   * spelling, unless it holds no backup manifest at the fetched commit while a legacy
   * spelling (`mux/`, from before the product rename) does. Selecting a single tree keeps
   * every unselected spelling out of validation, the sparse checkout, and staging, so a
   * broken or oversized tree under the other spelling can never block the backup that is
   * actually in use, and pushes update the backup where it lives instead of forking it.
   */
  private async resolveEffectiveManagedPath(remoteCommit: string | null): Promise<string> {
    const [configured, ...legacySpellings] = listBackupManagedPathSpellings(
      this.options.managedPath
    );
    if (remoteCommit === null || legacySpellings.length === 0) return configured;
    if (await this.treeHasReadableBackupManifest(remoteCommit, safeRelativePath(configured))) {
      return configured;
    }
    for (const legacy of legacySpellings) {
      if (await this.treeHasReadableBackupManifest(remoteCommit, safeRelativePath(legacy))) {
        return legacy;
      }
    }
    return configured;
  }

  /**
   * True only when `<readPath>/manifest.json` is a blob at the given commit that parses as
   * a backup manifest. Deliberately non-recursive: a directory spelled like the manifest is
   * then a single `tree` record the type check rejects, rather than an unbounded listing of
   * its descendants. Parsing matters because `manifest.json` is a generic filename: an
   * unrelated or corrupt file under the configured spelling must not win the selection over
   * a valid legacy backup that would then never be consulted.
   */
  private async treeHasReadableBackupManifest(
    remoteCommit: string,
    readPath: string
  ): Promise<boolean> {
    const { stdout } = await this.localGit(
      ["ls-tree", "-z", remoteCommit, "--", `:(top,literal)${readPath}/${BACKUP_MANIFEST_FILE}`],
      { env: { GIT_NO_LAZY_FETCH: "1" }, maxOutputBytes: MANIFEST_LOOKUP_MAX_OUTPUT_BYTES }
    );
    const record = stdout.split("\0")[0] ?? "";
    const separator = record.indexOf("\t");
    if (separator < 0) return false;
    const [, objectType, objectId] = record.slice(0, separator).trim().split(/\s+/);
    if (objectType !== "blob" || objectId === undefined || !/^[0-9a-f]{40,64}$/.test(objectId)) {
      return false;
    }
    const manifest = await this.readProbedBlob(objectId);
    return manifest !== null && isParseableBackupManifest(manifest);
  }

  /**
   * Reads a probed blob's bytes, fetching it once through the credential ladder when the
   * blob-filtered clone has only promised it. Returns null for a blob that still cannot be
   * read afterwards, so the probe treats it as "not a usable manifest" rather than failing
   * the whole preparation. Capped at the per-file payload limit before parsing: a manifest
   * the restore path could never read must not be buffered whole in the main process, and
   * the streaming cap kills the read as soon as it passes the limit.
   */
  private async readProbedBlob(objectId: string): Promise<string | null> {
    const read = () =>
      this.localGit(["cat-file", "blob", objectId], {
        env: { GIT_NO_LAZY_FETCH: "1" },
        maxOutputBytes: MAX_BACKUP_FILE_BYTES,
      });
    const isOverLimit = (error: unknown) =>
      error instanceof Error &&
      error.message === `Command produced more than ${MAX_BACKUP_FILE_BYTES} bytes of output`;
    try {
      return (await read()).stdout;
    } catch (error) {
      // Over-limit is definitive: the blob exists locally and is too large, so fetching
      // it again could only re-buffer the same oversized bytes.
      if (isOverLimit(error)) return null;
      // Otherwise the blob is missing from the partial clone; fetch exactly it, like the
      // pre-checkout size validation does for payload blobs.
      await this.networkGit([
        "-C",
        this.cachePath,
        "fetch",
        "--refetch",
        "--no-tags",
        "--no-write-fetch-head",
        ...localUploadPackArgs(this.repoUrl),
        "origin",
        objectId,
      ]);
      await this.assertObjectStoreWithinBudget();
    }
    try {
      return (await read()).stdout;
    } catch {
      return null;
    }
  }

  private async listManagedBlobs(
    remoteCommit: string,
    managedPath: string
  ): Promise<ManagedBlobEntry[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.localGit(
        ["ls-tree", "-r", "-l", "-z", remoteCommit, "--", `:(top,literal)${managedPath}`],
        {
          env: { GIT_NO_LAZY_FETCH: "1" },
          maxOutputBytes: MAX_BACKUP_TOTAL_BYTES,
        }
      ));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Command produced more than ${MAX_BACKUP_TOTAL_BYTES} bytes of output`
      ) {
        throw new BackupInvalidPayloadError(
          new Error("Backup tree is too large to validate before checkout")
        );
      }
      throw error;
    }

    const entries: ManagedBlobEntry[] = [];
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\t");
      if (separator < 0) {
        throw new Error("Git returned an invalid managed tree entry");
      }
      const fields = record.slice(0, separator).trim().split(/\s+/);
      if (fields.length !== 4) {
        throw new Error("Git returned an invalid managed tree entry");
      }
      const [mode, objectType, objectId, sizeText] = fields;
      const entryPath = record.slice(separator + 1);
      if (objectType === "commit") {
        throw new BackupInvalidPayloadError(
          new Error(`Backup tree contains unsupported gitlink '${entryPath}'`)
        );
      }
      if (objectType !== "blob") {
        throw new Error("Git returned an unsupported managed tree entry");
      }
      if (
        !mode ||
        !objectId ||
        !/^[0-9a-f]{40,64}$/.test(objectId) ||
        (sizeText !== "BAD" && !/^\d+$/.test(sizeText ?? ""))
      ) {
        throw new Error("Git returned an invalid managed blob entry");
      }
      entries.push({
        objectId,
        path: entryPath,
        size: sizeText === "BAD" ? null : Number(sizeText),
      });
    }
    return entries;
  }

  private takeMaterializationBytes(
    entry: ManagedBlobEntry,
    size: number,
    usedBytes: number
  ): number {
    if (size > this.materializationLimits.maxFileBytes) {
      throw new BackupInvalidPayloadError(
        new Error(
          `'${entry.path}' is larger than the per-file limit (${this.materializationLimits.maxFileBytes} bytes)`
        )
      );
    }
    const nextUsedBytes = usedBytes + size;
    if (nextUsedBytes > this.materializationLimits.maxTotalBytes) {
      throw new BackupInvalidPayloadError(
        new Error(
          `Backup is larger than the total limit (${this.materializationLimits.maxTotalBytes} bytes)`
        )
      );
    }
    return nextUsedBytes;
  }

  private async validateManagedTreeBeforeCheckout(
    remoteCommit: string,
    managedPath: string
  ): Promise<void> {
    const entries = await this.listManagedBlobs(remoteCommit, managedPath);
    if (entries.length > this.materializationLimits.maxFileCount) {
      throw new BackupInvalidPayloadError(
        new Error(`Backup has more than ${this.materializationLimits.maxFileCount} files`)
      );
    }

    const managedPrefix = `${managedPath}/`;
    try {
      const payloadPaths = entries.map((entry) => {
        if (!entry.path.startsWith(managedPrefix)) {
          throw new Error(`Backup tree contains invalid path '${entry.path}'`);
        }
        return entry.path.slice(managedPrefix.length);
      });
      assertBackupPathComplexity(payloadPaths);
    } catch (error) {
      throw new BackupInvalidPayloadError(error);
    }

    let usedBytes = 0;
    const missingByObjectId = new Map<string, ManagedBlobEntry[]>();
    for (const entry of entries) {
      if (entry.size !== null) {
        usedBytes = this.takeMaterializationBytes(entry, entry.size, usedBytes);
        continue;
      }
      const matchingEntries = missingByObjectId.get(entry.objectId) ?? [];
      matchingEntries.push(entry);
      missingByObjectId.set(entry.objectId, matchingEntries);
    }

    while (missingByObjectId.size > 0) {
      const objectIds = [...missingByObjectId.keys()].slice(0, BLOB_PREFETCH_BATCH_SIZE);
      await this.networkGit([
        "-C",
        this.cachePath,
        "fetch",
        // `--refetch` retrieves promised blobs from a shallow partial clone without deepening it.
        "--refetch",
        "--no-tags",
        "--no-write-fetch-head",
        ...localUploadPackArgs(this.repoUrl),
        "origin",
        ...objectIds,
      ]);
      await this.assertObjectStoreWithinBudget();

      const fetchedSizes = new Map<string, number>();
      const fetchedObjectIds = new Set(objectIds);
      for (const entry of await this.listManagedBlobs(remoteCommit, managedPath)) {
        if (entry.size !== null && fetchedObjectIds.has(entry.objectId)) {
          fetchedSizes.set(entry.objectId, entry.size);
        }
      }
      for (const objectId of objectIds) {
        const size = fetchedSizes.get(objectId);
        const matchingEntries = missingByObjectId.get(objectId);
        if (size === undefined || matchingEntries === undefined) {
          throw new BackupInvalidPayloadError(
            new Error("Backup file sizes could not be validated before checkout")
          );
        }
        for (const entry of matchingEntries) {
          usedBytes = this.takeMaterializationBytes(entry, size, usedBytes);
        }
        missingByObjectId.delete(objectId);
      }
    }
  }

  /**
   * Only the managed directory is materialized. Xum reads and writes nothing else, and a
   * checkout of the whole branch fails on any path elsewhere in the repository that this
   * platform cannot create, which would block a backup whose own payload is fine.
   *
   * Written by hand rather than with `git sparse-checkout set`: that porcelain enables
   * `extensions.worktreeConfig` and moves its state into `.git/config.worktree`, a second
   * config file git trusts as much as the one `sanitizeCacheConfig` just rebuilt. The pattern
   * file switches nothing on by itself (`core.sparseCheckout` comes from the rebuilt config),
   * and the checkout that follows is what applies it. Pre-checkout size validation fetches any
   * missing managed blobs through the credential ladder.
   */
  private async applySparseCheckout(managedPath: string): Promise<void> {
    await writeOwnedGitInfoFile(
      this.cachePath,
      "sparse-checkout",
      `/${escapeSparsePattern(managedPath)}/*\n`
    );
  }

  async resetHardToRemote(): Promise<string | null> {
    // The managed path selection depends on the fetched commit's tree, so resolve it
    // before the sparse pattern is written and the checkout materializes anything.
    const remoteCommit = await this.remoteBranchCommit();
    this.selectedManagedPath = await this.resolveEffectiveManagedPath(remoteCommit);
    const managedPath = safeRelativePath(this.selectedManagedPath);
    await this.applySparseCheckout(managedPath);
    if (remoteCommit) {
      await this.validateManagedTreeBeforeCheckout(remoteCommit, managedPath);
      // -f because a previous preview leaves modified tracked files in this cache. Without
      // it the checkout keeps them and the next preview reads the local export as if it
      // were the remote's backup.
      await this.networkGit([
        "-C",
        this.cachePath,
        "checkout",
        "-f",
        "-B",
        this.options.branch,
        `refs/remotes/origin/${this.options.branch}`,
      ]);
    } else {
      await this.resetToUnbornBranch();
    }
    this.baseRemoteCommit = remoteCommit;
    return remoteCommit;
  }

  /**
   * The remote branch does not exist, so the next commit must be a root commit. Deleting
   * the local ref matters when this cache still holds the branch from before it was
   * deleted remotely: keeping it would make the push recreate the deleted history,
   * including files the user may have removed deliberately.
   */
  private async resetToUnbornBranch(): Promise<void> {
    const ref = `refs/heads/${this.options.branch}`;
    await this.localGit(["symbolic-ref", "HEAD", ref]);
    // Not caught, for the same reason as the remote-tracking delete: deleting an absent ref
    // already succeeds, so the only failures left are real, and continuing past one would leave
    // the branch attached for the next commit to make the deleted history reachable again.
    await this.localGit(["update-ref", "-d", ref]);
    await this.localGit(["read-tree", "--empty"]);
    await this.localGit(["clean", "-fdx"]);
  }

  /**
   * Corruption is unbounded: an empty `HEAD`, a truncated index, or a `config` that is a
   * directory all pass a structural check and fail a later command. So the first attempt answers
   * an unrecognized failure, including a local one, by rebuilding once rather than enumerating
   * causes; that costs at most a fresh clone, because every prepare resets to the remote anyway.
   */
  async materialize(): Promise<string | null> {
    try {
      await this.ensureCache();
      return await this.materializeFromRemote();
    } catch (error) {
      if (
        error instanceof BackupCacheSafetyError ||
        error instanceof BackupOriginMismatchError ||
        error instanceof BackupInvalidPayloadError ||
        error instanceof BackupRemoteUnreachableError ||
        error instanceof BackupAuthFailedError
      ) {
        throw error;
      }
      await this.discardCache();
      await this.ensureCache();
      return await this.materializeFromRemote();
    }
  }

  private async materializeFromRemote(): Promise<string | null> {
    await this.fetch();
    const remoteCommit = await this.resetHardToRemote();
    await this.cleanWorktree();
    return remoteCommit;
  }

  async cleanWorktree(): Promise<void> {
    // -x so an ignored leftover from a preview or a blocked push cannot survive the
    // reset and be read back as if it were the remote's backup. The whole worktree,
    // not just the current managed path: the cache identity is repository and branch,
    // so exports written under a previously configured subdirectory would otherwise
    // accumulate outside every later sparse checkout. Xum owns this worktree.
    await this.localGit(["clean", "-fdx"]);
  }

  async stageAndCommit(message: string): Promise<string | null> {
    const target = safeRelativePath(this.effectiveManagedPath);
    // -f because the target may be a dotfiles repo whose ignore rules match payload
    // names. Skipping one file would push a manifest that references missing content.
    await this.localGit(["add", "-A", "-f", "--", target]);
    const status = await this.porcelainStatus();
    if (!status) return null;

    await this.localGit([...GIT_IDENTITY_ARGS, "commit", "-m", message, "--", target]);
    return (await this.localGit(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Callers that report on the remote must confirm it still matches the fetched commit. */
  async assertRemoteUnchanged(): Promise<void> {
    if (this.baseRemoteCommit === undefined) {
      throw new Error("Fetch and reset the backup cache before pushing");
    }
    const currentRemote = (await this.lsRemote()).branchCommit;
    if (currentRemote !== this.baseRemoteCommit) {
      throw new BackupNonFastForwardError();
    }
  }

  async push(): Promise<string> {
    await this.assertRemoteUnchanged();

    try {
      await this.networkGit([
        "-C",
        this.cachePath,
        "push",
        // The lease makes the expectation atomic with the update. assertRemoteUnchanged
        // alone leaves a window where another client can delete the branch, which an
        // ordinary push would silently recreate with the history that client discarded.
        // An empty expected value means the ref must not exist yet.
        `--force-with-lease=refs/heads/${this.options.branch}:${this.baseRemoteCommit ?? ""}`,
        "origin",
        `HEAD:refs/heads/${this.options.branch}`,
      ]);
    } catch (error) {
      if (isRemoteMovedRejection(errorText(error))) {
        throw new BackupNonFastForwardError();
      }
      throw error;
    }

    const head = (await this.localGit(["rev-parse", "HEAD"])).stdout.trim();
    this.baseRemoteCommit = head;
    return head;
  }

  /**
   * `-z` because the default porcelain output C-quotes any pathname that is not plain ASCII, so
   * a skill named `café.md` would be reported to the user with escapes in it, and a filename
   * containing a literal ` -> ` would be indistinguishable from a rename. With `-z` pathnames
   * are verbatim and a rename is two NUL-separated fields instead. Not trimmed: a trailing NUL
   * is the record terminator, and a pathname may legitimately end in whitespace.
   */
  async porcelainStatus(): Promise<string> {
    return (
      await this.localGit([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        safeRelativePath(this.effectiveManagedPath),
      ])
    ).stdout;
  }
}
