import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  BackupProjectBundleManifestSchema,
  CREDENTIAL_URL_PARAMETER_NAMES,
  MAX_BACKUP_PROJECT_ENTRIES,
  decodeDelimitersOnce,
  hasCredentialUrlParameters,
  isWindowsUnusableSegment,
  sanitizeBackupGitRemote,
  type BackupProjectBundleEntry,
  type BackupProjectBundleManifest,
} from "@/common/config/schemas/settingsBackup";
import { projectPathHashSuffix } from "@/node/services/memoryService";
import { MEMORY_MAX_FILE_BYTES, MEMORY_MAX_FILES_PER_SCOPE } from "@/common/constants/memory";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isErrnoWithCode } from "@/node/utils/fs";
import type { BackupCommandApproval, BackupProjectImport } from "@/common/orpc/schemas/backup";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "manifest.json";
/**
 * The opt-in project bundle lives beside the core payload, never inside its manifest: an
 * old build's `parseManifest` hard-fails on unknown paths, so listing bundle files there
 * would brick preview and restore on downgrade, while a sidecar directory is silently
 * ignored by the manifest-driven reader.
 */
export const PROJECT_BUNDLE_DIR = "project-bundle";
const PROJECT_MEMORY_PATH_PREFIX = "memory/project/";
/**
 * A payload is read wholly into memory on both sides, and the repository side is written by
 * whoever can push to the branch, so an oversized entry would crash the main process during
 * a plain Preview. Settings are text, so these bounds are far above any real backup.
 */
export const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_COUNT = 4096;
/** The manifest byte cap bounds parsing; these limits bound derived MCP redaction work. */
export const MAX_BACKUP_MCP_REDACTIONS = 256;
export const MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS = 64;
export const MAX_BACKUP_MCP_REDACTION_SEGMENTS = 2048;
/** Bounds traversal work and the directory tree Preview or Restore may inspect or create. */
export const MAX_BACKUP_PATH_DEPTH = 24;
export const MAX_BACKUP_DIRECTORY_COUNT = 4096;
export const REDACTED_BACKUP_VALUE = "__MUX_BACKUP_REDACTED__";

const FORBIDDEN_BASENAMES = new Set(
  [
    "providers.jsonc",
    "secrets.json",
    "mcp-oauth.json",
    "server.lock",
    "serverAuthSessions.json",
    "AGENTS.local.md",
    "memory-meta.json",
  ].map((name) => name.toLowerCase())
);

/** Case-insensitive: a differently-cased name resolves to the same file on Windows and macOS. */
function isForbiddenBasename(name: string): boolean {
  return FORBIDDEN_BASENAMES.has(name.toLowerCase());
}

/**
 * No hidden file is portable settings content, and the recursive collections (`skills/`,
 * `memory/global/`) would otherwise sweep up whatever a directory happens to contain. The
 * names that show up there are credential and tooling files: `.env` and its variants,
 * `.netrc`, `.npmrc`, and the `.git` directory of a skill installed by cloning, which holds
 * an object database and remote URLs with credentials. The secret scanner is not a safety
 * net for these, because a value like `PASSWORD=hunter2` matches none of its patterns.
 *
 * Applied to every path segment, so a hidden directory is not backed up either, and shared
 * with payload validation so a backup cannot deliver one back.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35,}/,
  /\bxoxb-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;

export interface BackupFile {
  path: string;
  content: Buffer;
  executable?: boolean;
}

export interface BackupManifestFile {
  path: string;
  sha256: string;
  executable?: boolean;
}

export type BackupRedactionPath = jsonc.JSONPath;

export interface BackupManifest {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  muxVersion: string;
  sourceLabel: string;
  mcpRedactions?: BackupRedactionPath[];
  files: BackupManifestFile[];
}

export interface BackupPayload {
  manifest: BackupManifest;
  files: BackupFile[];
  redactions: string[];
}

export interface CreateBackupPayloadOptions {
  muxRoot: string;
  preferences?: UserPreferences;
  muxVersion: string;
  sourceLabel: string;
  exportedAt?: string;
  /**
   * Return detected secrets in the payload instead of throwing, so a caller that
   * owns the user-facing override can decide whether to proceed.
   */
  reportSecrets?: boolean;
  /** Keep the local MCP file verbatim for the safety snapshot used to undo a restore. */
  keepLocalSecrets?: boolean;
}

export interface RestoreBackupPayloadOptions {
  muxRoot: string;
  payload: BackupPayload;
  approvedCommandTokens?: readonly string[];
}

export class BackupCommandApprovalRequiredError extends Error {
  readonly code = "COMMAND_APPROVAL_REQUIRED";

  constructor(readonly approvals: readonly BackupCommandApproval[]) {
    super(
      "This backup would replace executable MCP commands. Review and approve them before restoring."
    );
    this.name = "BackupCommandApprovalRequiredError";
  }

  /** The paths the UI lists, matching how `SECRET_DETECTED` reports blocked files. */
  get files(): string[] {
    return this.approvals.map((approval) => `${approval.path}: ${approval.command}`);
  }
}

/**
 * Mirrors BackupCommandApprovalRequiredError for project imports: thrown when a restore
 * names an import token the currently checked-out payload does not produce, carrying the
 * fresh candidate list so the UI can re-present it without another preview.
 */
export class BackupProjectImportApprovalRequiredError extends Error {
  readonly code = "PROJECT_IMPORT_APPROVAL_REQUIRED";

  constructor(readonly projectImports: readonly BackupProjectImport[]) {
    super(
      "The approved project imports no longer match the backup. Review and approve the current list before restoring."
    );
    this.name = "BackupProjectImportApprovalRequiredError";
  }
}

export interface RestoreBackupPayloadResult {
  /**
   * The backup's preferences document, unmerged and absent when the payload carries none.
   * Merging belongs to the caller so it can read the current config inside the same
   * serialized edit that writes the result.
   */
  backupPreferences?: unknown;
  localOnlyFiles: string[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosixPath(...parts: string[]): string {
  return parts.join("/");
}

/**
 * MCP definitions carry commands, URLs, and headers that can hold credentials, so restore
 * reproduces the owner-only mode `mcpConfigService` writes rather than following the umask.
 */
function isOwnerOnlyPayloadPath(relativePath: string): boolean {
  return relativePath === "mcp.jsonc";
}

function isAllowedPayloadPath(relativePath: string): boolean {
  if (relativePath === "AGENTS.md" || relativePath === "mcp.jsonc") return true;
  if (relativePath === "preferences.json") return true;
  if (/^agents\/[^/]+\.md$/.test(relativePath)) return true;
  if (/^skills\/.+/.test(relativePath)) return true;
  return /^memory\/global\/.+/.test(relativePath);
}

function backupPathSegments(relativePath: string): string[] {
  const segments = relativePath.split("/");
  if (segments.length > MAX_BACKUP_PATH_DEPTH) {
    throw new Error(
      `Backup path '${relativePath}' has more than ${MAX_BACKUP_PATH_DEPTH} path components`
    );
  }
  return segments;
}

/**
 * The shape rules every payload path shares, independent of which allowlist it must also
 * satisfy: the core payload and the project bundle validate different path sets but reject
 * the same traversal, hidden-name, forbidden-basename, and portability hazards.
 */
function hasDisallowedPathShape(relativePath: string, options: { portable: boolean }): boolean {
  const segments = backupPathSegments(relativePath);
  return (
    path.isAbsolute(relativePath) ||
    // Payload paths are always posix. A backslash is an ordinary filename character
    // here but a separator on Windows, so `skills/..\..\evil` would escape the
    // destination once path.join runs there. A local snapshot never travels, and
    // resolveContainedPath still rejects traversal and symlinked ancestors either way.
    (options.portable && relativePath.includes("\\")) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === ".." ||
        isHiddenName(segment) ||
        (options.portable && isWindowsUnusableSegment(segment))
    ) ||
    isForbiddenBasename(path.posix.basename(relativePath))
  );
}

/**
 * Local safety snapshots use `portable: false` so cross-platform filename checks cannot block
 * a restore while protecting a file valid on the current filesystem. Containment and allowlist
 * checks still apply.
 */
function assertAllowedPayloadPath(
  relativePath: string,
  options: { portable: boolean } = { portable: true }
): void {
  if (!isAllowedPayloadPath(relativePath) || hasDisallowedPathShape(relativePath, options)) {
    throw new Error(`Backup contains disallowed path '${relativePath}'`);
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/**
 * `null` only when the path does not exist. Any other failure (`EACCES` on an unreadable
 * parent, `EIO`) propagates: a preflight that read it as "missing" would accept a write the
 * filesystem is about to refuse, after the point where refusing changes nothing.
 */
async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

/** Filesystem identity detects aliases across hard links, case folding, and normalization. */
async function localFilesOverwrittenByPayload(
  muxRoot: string,
  localPaths: Iterable<string>,
  payloadPaths: Iterable<string>
): Promise<{ overwritten: Map<string, string[]>; multiLinkLocals: Set<string> }> {
  const byIdentity = new Map<string, string[]>();
  const multiLinkLocals = new Set<string>();
  for (const localPath of localPaths) {
    const identity = await fileIdentity(muxRoot, localPath);
    if (identity === null) continue;
    if (identity.nlink > 1) multiLinkLocals.add(localPath);
    const key = fileIdentityKey(identity);
    const names = byIdentity.get(key);
    if (names === undefined) byIdentity.set(key, [localPath]);
    else names.push(localPath);
  }
  const overwritten = new Map<string, string[]>();
  for (const payloadPath of payloadPaths) {
    const identity = await fileIdentity(muxRoot, payloadPath);
    const names = identity === null ? undefined : byIdentity.get(fileIdentityKey(identity));
    if (names !== undefined) overwritten.set(payloadPath, names);
  }
  return { overwritten, multiLinkLocals };
}

async function fileIdentity(
  muxRoot: string,
  relativePath: string
): Promise<FileIdentityStat | null> {
  const stat = await lstatOrNull(path.join(muxRoot, ...relativePath.split("/")));
  return stat === null ? null : { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

/**
 * A hard-linked alias is local-only unless restored directly because writes sever the
 * restored name.
 */
export async function localOnlyPayloadFiles(
  muxRoot: string,
  localPaths: Iterable<string>,
  restoredPaths: ReadonlySet<string>
): Promise<{ localOnly: string[]; overwritten: Map<string, string[]> }> {
  const locals = [...localPaths];
  const { overwritten, multiLinkLocals } = await localFilesOverwrittenByPayload(
    muxRoot,
    locals,
    restoredPaths
  );
  const overwrittenLocals = new Set([...overwritten.values()].flat());
  return {
    localOnly: locals
      .filter(
        (file) =>
          !restoredPaths.has(file) && (!overwrittenLocals.has(file) || multiLinkLocals.has(file))
      )
      .sort(),
    overwritten,
  };
}

/**
 * Joins a posix relative path onto a root, rejecting any component that is a symlink.
 * Git stores symlinks (mode 120000), so a backup repository can contain one; reading or
 * writing through it would escape the directory this feature is allowed to touch.
 */
export async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Backup contains disallowed path '${relativePath}'`);
    }
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink '${relativePath}'`);
    }
    // A non-directory in the middle of the path would make mkdir fail mid-write.
    if (index < segments.length - 1 && existing !== null && !existing.isDirectory()) {
      throw new Error(`Cannot use '${relativePath}': a parent path is not a directory`);
    }
  }
  return current;
}

function assertBackupFileCount(count: number): void {
  if (count > MAX_BACKUP_FILE_COUNT) {
    throw new Error(`Backup has more than ${MAX_BACKUP_FILE_COUNT} files`);
  }
}

function createBackupPathComplexityTracker(): {
  recordDirectory: (relativePath: string) => void;
  recordFile: (relativePath: string) => void;
} {
  const directories = new Set<string>();

  function record(relativePath: string, includeLastSegment: boolean): void {
    const segments = backupPathSegments(relativePath);
    let prefix = "";
    for (const segment of includeLastSegment ? segments : segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      directories.add(prefix);
      if (directories.size > MAX_BACKUP_DIRECTORY_COUNT) {
        throw new Error(`Backup has more than ${MAX_BACKUP_DIRECTORY_COUNT} directories`);
      }
    }
  }

  return {
    recordDirectory: (relativePath) => record(relativePath, true),
    recordFile: (relativePath) => record(relativePath, false),
  };
}

export function assertBackupPathComplexity(relativePaths: readonly string[]): void {
  const tracker = createBackupPathComplexityTracker();
  for (const relativePath of relativePaths) tracker.recordFile(relativePath);
}

function assertBackupPathLimits(
  relativePaths: readonly string[],
  options: { portable: boolean } = { portable: true }
): void {
  assertBackupFileCount(relativePaths.length);
  assertBackupPathComplexity(relativePaths);
  for (const relativePath of relativePaths) assertAllowedPayloadPath(relativePath, options);
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

/** Checked before each read, so an oversized entry is never buffered. */
function createByteBudget() {
  let used = 0;
  return function take(relativePath: string, size: number): void {
    if (size > MAX_BACKUP_FILE_BYTES) {
      throw new Error(
        `'${relativePath}' is larger than the ${megabytes(MAX_BACKUP_FILE_BYTES)} limit for one backup file`
      );
    }
    used += size;
    if (used > MAX_BACKUP_TOTAL_BYTES) {
      throw new Error(`Backup is larger than the ${megabytes(MAX_BACKUP_TOTAL_BYTES)} total limit`);
    }
  };
}

type ByteBudget = ReturnType<typeof createByteBudget>;

/**
 * Two paths collide when the filesystem cannot tell them apart, so the comparison has to fold
 * the same things a filesystem does. Case is the obvious one, and macOS also normalizes: NFC
 * `café.md` and its NFD spelling are one file there while they differ byte for byte, so
 * case-folding alone would let the second entry silently overwrite the first.
 */
function collisionKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Confirms the path just opened still holds no symlink between the root and the file, and that
 * the file it named is the file the handle holds.
 *
 * `O_NOFOLLOW` covers only the last component and Node exposes no `openat`, so an ancestor
 * directory swapped for a symlink between the checks and the open cannot be prevented, only
 * detected. Comparing the opened handle's identity with the identity the verified walk arrives
 * at is what does the detecting: a component put back after the open still leaves a different
 * file in hand.
 *
 * What this closes is a backup repository choosing a path that escapes the root, and a symlink
 * planted under the root beforehand. It is not atomic, and it does not claim to be: every check
 * here re-resolves a pathname, so a local process that can rename the root repeatedly while a
 * restore runs can still thread its way between them. Closing that needs directory-relative
 * opens (`openat`/`O_PATH`), which Node does not expose. A process with that access can write
 * these files directly anyway, so the pathname checks are the boundary that pays off.
 */
async function assertOpenedFileContained(
  root: BackupRoot,
  relativePath: string,
  opened: { dev: number; ino: number }
): Promise<void> {
  // The root is checked by identity, not by name: `realpath` returned a pathname, and a
  // pathname can be made to point somewhere else afterwards. Node cannot pin a directory, so
  // the check is that the canonical root is still the same directory this operation started on.
  const rootStat = await fs.lstat(root.path);
  if (rootStat.isSymbolicLink() || rootStat.dev !== root.dev || rootStat.ino !== root.ino) {
    throw new Error(`Refusing to use '${relativePath}': the backup root was replaced`);
  }
  let current = root.path;
  let last: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    last = await fs.lstat(current);
    if (last.isSymbolicLink()) throw new Error(`Refusing to follow symlink '${relativePath}'`);
  }
  if (last === undefined || last.dev !== opened.dev || last.ino !== opened.ino) {
    throw new Error(`Refusing to use '${relativePath}': it was replaced while being opened`);
  }
}

/**
 * Resolved once where an operation begins, so every open and check below it uses that result.
 * The root being a symlink is then neither refused nor traversed again: a user is free to keep
 * `~/.xum` on another volume, and swapping that link partway through cannot move an operation
 * already under way onto a different tree. Only the components below the root are held to the
 * no-symlink rule.
 */
interface BackupRoot {
  path: string;
  dev: number;
  ino: number;
}

async function resolveRoot(root: string): Promise<BackupRoot> {
  const canonical = await fs.realpath(root);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) throw new Error(`'${root}' is not a directory`);
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function nonBlockingFlag(): number {
  return fs.constants.O_NONBLOCK ?? 0;
}

function noFollowFlag(): number {
  // Absent on Windows, where a file cannot be swapped for a junction this way.
  return fs.constants.O_NOFOLLOW ?? 0;
}

function absolutePathOf(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Reads a file through one handle, so the size that was checked is the size that is read.
 * Reopening the path after a `stat` lets a file that grew in between defeat the byte budget,
 * and lets a symlink installed in between be followed after the checks said there was none.
 * The window is ordinary rather than adversarial here: agents write under this root while a
 * Preview or Push is running.
 */
async function readCheckedFile(
  root: BackupRoot,
  relativePath: string,
  charge: (size: number) => void
): Promise<{ content: Buffer; mode: number; identity: FileIdentityStat }> {
  const handle = await fs.open(
    absolutePathOf(root.path, relativePath),
    fs.constants.O_RDONLY | noFollowFlag() | nonBlockingFlag()
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Refusing to read '${relativePath}': not a regular file`);
    await assertOpenedFileContained(root, relativePath, stat);
    charge(stat.size);
    const content = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const { bytesRead } = await handle.read(content, filled, stat.size - filled, filled);
      // A file truncated while being read yields short, which is the bound holding rather
      // than an error: the caller's checksum decides whether the result is usable.
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      content: filled === stat.size ? content : content.subarray(0, filled),
      mode: stat.mode,
      identity: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink },
    };
  } finally {
    await handle.close();
  }
}

interface FileIdentityStat {
  dev: number;
  ino: number;
  nlink: number;
}

/**
 * `nlink` says how many names a file has but not where they are, so a single read cannot
 * tell an alias inside the root from one outside it. The collection as a whole can: when
 * every name a file has was itself collected, all its aliases are inside the backed-up set,
 * and any excess means a name somewhere this walk cannot see. A hard link to a file outside
 * the root carries that file's bytes past the allowlist the same way the symlinks this
 * feature already refuses would, so the unprovable case is refused too. Aliases inside the
 * set stay allowed: they are how a case-folding volume's one-file-many-spellings behaves,
 * and every one of them is content the backup already carries.
 */
function fileIdentityKey(identity: FileIdentityStat): string {
  return `${identity.dev}:${identity.ino}`;
}

function createHardLinkTracker() {
  const identities = new Map<string, { nlink: number; names: string[] }>();
  return {
    record(relativePath: string, identity: FileIdentityStat): void {
      if (identity.nlink <= 1) return;
      const key = fileIdentityKey(identity);
      const entry = identities.get(key);
      if (entry === undefined) {
        identities.set(key, { nlink: identity.nlink, names: [relativePath] });
      } else {
        entry.names.push(relativePath);
      }
    },
    assertContained(): void {
      for (const { nlink, names } of identities.values()) {
        if (nlink > names.length) {
          throw new Error(
            `Refusing to use '${names[0] ?? ""}': it is hard-linked to a file outside the backed-up files`
          );
        }
      }
    },
  };
}

type HardLinkTracker = ReturnType<typeof createHardLinkTracker>;

function restoredPermissions(
  mode: number,
  executable: boolean,
  ownerOnly: boolean
): { base: number; next: number } {
  // Git records only executability, so preserve local read and write permissions. Bun's chmod
  // strips setuid and setgid, so masking privileged bits cannot be fixture-tested under bun test.
  const base = mode & 0o777;
  let next = executable ? base | ((base & 0o444) >> 2) : base & ~0o111;
  if (ownerOnly) next = 0o600;
  return { base, next };
}

/**
 * Writes a file through one handle, opened without following a symlink and verified to be the
 * file inside the root that was planned before anything is written to it. Deliberately not
 * `O_TRUNC`: truncation happens after the verification, so a destination that turned out to be
 * somewhere else is not emptied on the way to finding that out. The mode is set on the handle
 * rather than the path for the same reason.
 */
async function writeCheckedFile(
  root: BackupRoot,
  relativePath: string,
  content: Buffer,
  executable: boolean,
  options: { ownerOnly?: boolean } = {}
): Promise<void> {
  const ownerOnly = options.ownerOnly === true;
  const destination = absolutePathOf(root.path, relativePath);
  await fs.mkdir(path.dirname(destination), {
    recursive: true,
    ...(ownerOnly ? { mode: 0o700 } : {}),
  });
  const { handle, stat } = await openSeveredWriteHandle(root, relativePath, destination, {
    ...(ownerOnly ? { mode: 0o600 } : {}),
  });
  try {
    await handle.truncate(0);
    let written = 0;
    while (written < content.length) {
      // A short write resolves successfully, so the count decides when the file is complete:
      // treating the first call as the whole write would publish a truncated file as a
      // finished one.
      const { bytesWritten } = await handle.write(
        content,
        written,
        content.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw new Error(`Could not finish writing '${relativePath}'`);
      }
      written += bytesWritten;
    }
    const { base, next } = restoredPermissions(stat.mode, executable, ownerOnly);
    // Existing destinations ignore the creation mode, so owner-only restores still need chmod.
    // Compared against the permission bits alone: `stat.mode` also carries the file type, so
    // comparing whole modes never matches and chmods a file whose mode is already correct, which
    // fails with EPERM when the destination is writable but owned by someone else.
    if (next !== base) await handle.chmod(next);
  } finally {
    await handle.close();
  }
}

/**
 * Opens the destination for writing, verified to be the planned file inside the root, and
 * never a name shared with another one. Writing through a multi-link file updates every one
 * of its names, and `nlink` cannot say whether one of them is outside the root, where a
 * write would land backup-controlled bytes in a file the containment walk never approved.
 * Instead of refusing, the name is severed: unlinked and recreated exclusively, so the write
 * lands in a fresh file only this name reads. On the volumes whose behavior in-root aliases
 * simulate, all spellings are one directory entry and severing is indistinguishable from
 * writing in place.
 */
async function openSeveredWriteHandle(
  root: BackupRoot,
  relativePath: string,
  destination: string,
  options: { mode?: number } = {}
): Promise<{ handle: fs.FileHandle; stat: Stats }> {
  const opened = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollowFlag() | nonBlockingFlag(),
    options.mode
  );
  let severedMode: number;
  try {
    const stat = await opened.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    if (stat.nlink <= 1) return { handle: opened, stat };
    severedMode = stat.mode & 0o777;
  } catch (error) {
    await opened.close();
    throw error;
  }
  await opened.close();
  await fs.unlink(destination);
  const fresh = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
    options.mode ?? severedMode
  );
  try {
    // A creation mode is filtered by the umask, which would silently narrow the replacement
    // below the permissions the file being replaced already had. chmod is not filtered, so the
    // mode is reapplied here to land exactly what was asked for.
    await fresh.chmod(options.mode ?? severedMode);
    const stat = await fresh.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    return { handle: fresh, stat };
  } catch (error) {
    await fresh.close();
    throw error;
  }
}

async function readBackupFile(
  root: BackupRoot,
  relativePath: string,
  budget: ByteBudget,
  links: HardLinkTracker
): Promise<BackupFile> {
  const { content, mode, identity } = await readCheckedFile(root, relativePath, (size) =>
    budget(relativePath, size)
  );
  links.record(relativePath, identity);
  return { path: relativePath, content, executable: (mode & 0o111) !== 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * lstat, not stat: a symlinked entry would let the closed allowlist export whatever it
 * points at (`AGENTS.md -> ~/company-secrets.txt`). Symlinks are not backed up.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  return (await lstatOrNull(filePath))?.isFile() === true;
}

/**
 * One collection pass with its own byte budget, hard-link tracker, and path-complexity
 * tracker. The core payload and the project bundle collect through separate instances so a
 * large bundle can never starve the core payload's budget, and vice versa.
 */
function createBackupFileCollector(root: BackupRoot) {
  const files: BackupFile[] = [];
  const budget = createByteBudget();
  const links = createHardLinkTracker();
  const pathComplexity = createBackupPathComplexityTracker();

  /**
   * `maxFileBytes` and `maxFiles` skip what the caller would drop anyway, before the file
   * count or byte budget is charged and before any read, so a directory with oversized or
   * surplus files can never block a collection that means to leave them out.
   */
  async function collectDirectory(
    relativeRoot: string,
    filter: (relativePath: string, entry: Dirent) => boolean,
    collectOptions: { maxFileBytes?: number; maxFiles?: number } = {}
  ): Promise<void> {
    const progress = { collected: 0 };
    await walkDirectory(relativeRoot, filter, collectOptions, progress);
  }

  async function walkDirectory(
    relativeRoot: string,
    filter: (relativePath: string, entry: Dirent) => boolean,
    collectOptions: { maxFileBytes?: number; maxFiles?: number },
    progress: { collected: number }
  ): Promise<void> {
    const absoluteRoot = path.join(root.path, ...relativeRoot.split("/"));
    // A symlinked collection root would let readdir walk outside MUX_ROOT, and restore
    // refuses to write through symlinks anyway, so they are simply not backed up.
    const rootStat = await lstatOrNull(absoluteRoot);
    if (rootStat?.isSymbolicLink() === true) return;
    if (rootStat?.isDirectory() === true) pathComplexity.recordDirectory(relativeRoot);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return;
      throw error;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isHiddenName(entry.name)) continue;
      const relativePath = toPosixPath(relativeRoot, entry.name);
      if (!filter(relativePath, entry)) continue;
      if (entry.isDirectory()) {
        await walkDirectory(relativePath, filter, collectOptions, progress);
      } else if (entry.isFile() && !isForbiddenBasename(entry.name)) {
        if (
          collectOptions.maxFiles !== undefined &&
          progress.collected >= collectOptions.maxFiles
        ) {
          continue;
        }
        if (collectOptions.maxFileBytes !== undefined) {
          const stat = await lstatOrNull(path.join(root.path, ...relativePath.split("/")));
          if (stat !== null && stat.size > collectOptions.maxFileBytes) continue;
        }
        assertBackupFileCount(files.length + 1);
        pathComplexity.recordFile(relativePath);
        files.push(await readBackupFile(root, relativePath, budget, links));
        progress.collected += 1;
      }
    }
  }

  async function collectNamedFile(relativePath: string): Promise<void> {
    if (await isRegularFile(path.join(root.path, ...relativePath.split("/")))) {
      assertBackupFileCount(files.length + 1);
      pathComplexity.recordFile(relativePath);
      files.push(await readBackupFile(root, relativePath, budget, links));
    }
  }

  return {
    files,
    collectDirectory,
    collectNamedFile,
    assertHardLinksContained: () => links.assertContained(),
  };
}

export async function collectAllowlistedFiles(muxRoot: string): Promise<BackupFile[]> {
  const root = await resolveRoot(muxRoot);
  const collector = createBackupFileCollector(root);

  for (const relativePath of ["AGENTS.md", "mcp.jsonc"]) {
    await collector.collectNamedFile(relativePath);
  }

  await collector.collectDirectory(
    "agents",
    (relativePath, entry) => entry.isDirectory() || /^agents\/[^/]+\.md$/.test(relativePath)
  );
  await collector.collectDirectory("skills", () => true);
  await collector.collectDirectory("memory/global", () => true);
  collector.assertHardLinksContained();
  return collector.files.sort((a, b) => a.path.localeCompare(b.path));
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeBackupPreferences(preferences: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(projectBackupPreferences(preferences), null, 2)}\n`,
    "utf-8"
  );
}

type Appearance = NonNullable<UserPreferences["appearance"]>;

/**
 * `editorConfig` is excluded on purpose. `customCommand` is executed as a shell command
 * by `EditorService.openInEditor`, so restoring it from a repository would let whoever
 * can write to that repository run a command here. The editor is machine-local anyway,
 * since its binary has to exist on the machine.
 */
const BACKED_UP_APPEARANCE_FIELDS = [
  "theme",
  "transcriptDensity",
  "bashCollapsedSummaryMode",
  "terminalFontConfig",
  "terminalBadgeConfig",
  "vimEnabled",
] as const satisfies ReadonlyArray<keyof Appearance>;

function projectAppearance(value: Appearance | undefined): Appearance | undefined {
  if (!value) return undefined;
  const projected: Appearance = {};
  for (const field of BACKED_UP_APPEARANCE_FIELDS) {
    if (value[field] !== undefined) {
      Object.assign(projected, { [field]: copyJson(value[field]) });
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

type BackupProviderOptions = NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]>;

/**
 * Of the providers `UserPreferencesSchema` can hold, only `anthropic` has a closed
 * `z.object` schema, so parsing already dropped undeclared keys. `google` is
 * `z.record(z.string(), z.unknown())`, which would carry an `apiKey` straight into the
 * backup, so it is excluded. A provider added later is excluded until it is listed here,
 * which fails closed, and `satisfies` rejects a name the preferences schema cannot hold.
 */
const BACKED_UP_PROVIDER_OPTIONS = ["anthropic"] as const satisfies ReadonlyArray<
  keyof BackupProviderOptions
>;

function projectProviderOptions(value: unknown): BackupProviderOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const provider of BACKED_UP_PROVIDER_OPTIONS) {
    if (source[provider] !== undefined) projected[provider] = copyJson(source[provider]);
  }
  return Object.keys(projected).length > 0 ? (projected as BackupProviderOptions) : undefined;
}

export function projectBackupPreferences(value: unknown): UserPreferences {
  const parsed = UserPreferencesSchema.parse(value ?? {});
  const projected: UserPreferences = {};

  const appearance = projectAppearance(parsed.appearance);
  if (appearance !== undefined) projected.appearance = appearance;
  if (parsed.navigation?.launchBehavior !== undefined) {
    projected.navigation = { launchBehavior: parsed.navigation.launchBehavior };
  }
  if (parsed.ai) {
    const ai: NonNullable<UserPreferences["ai"]> = {};
    if (parsed.ai.globalDefaults !== undefined) {
      ai.globalDefaults = copyJson(parsed.ai.globalDefaults);
    }
    const providerOptions = projectProviderOptions(parsed.ai.providerOptions);
    if (providerOptions !== undefined) ai.providerOptions = providerOptions;
    if (parsed.ai.autoCompactionThresholdByModel !== undefined) {
      ai.autoCompactionThresholdByModel = copyJson(parsed.ai.autoCompactionThresholdByModel);
    }
    if (Object.keys(ai).length > 0) projected.ai = ai;
  }
  if (parsed.review?.includeUncommitted !== undefined) {
    projected.review = { includeUncommitted: parsed.review.includeUncommitted };
  }

  return projected;
}

type AiPreferences = NonNullable<UserPreferences["ai"]>;

/**
 * Provider options merge per provider rather than wholesale, because the record-typed
 * providers are deliberately excluded from a backup. Replacing the object would delete
 * settings the backup never had the chance to carry.
 */
function mergeAiPreferences(current: AiPreferences | undefined, projected: AiPreferences) {
  const merged: AiPreferences = { ...current, ...projected };
  if (projected.providerOptions !== undefined) {
    merged.providerOptions = { ...current?.providerOptions, ...projected.providerOptions };
  }
  return merged;
}

export function mergeBackupPreferences(
  current: UserPreferences | undefined,
  backup: unknown
): UserPreferences {
  const projected = projectBackupPreferences(backup);
  return UserPreferencesSchema.parse({
    ...(current ?? {}),
    ...(projected.appearance
      ? { appearance: { ...current?.appearance, ...projected.appearance } }
      : {}),
    ...(projected.navigation
      ? { navigation: { ...current?.navigation, ...projected.navigation } }
      : {}),
    ...(projected.ai ? { ai: mergeAiPreferences(current?.ai, projected.ai) } : {}),
    ...(projected.review ? { review: { ...current?.review, ...projected.review } } : {}),
  });
}

/**
 * `MCPHeaderValue` is `string | { secret }` (src/common/types/mcp.ts), so Xum sends a plain
 * string verbatim and never interpolates it: only the reference form is portable. Exactly one
 * key, because a sibling property inside the reference would be published verbatim and is a
 * place to hide a credential that `resolveHeaders` would never read.
 */
function isPortableReference(value: unknown): boolean {
  const record = readRecord(value);
  if (!record) return false;
  const keys = Object.keys(record);
  return keys.length === 1 && typeof record.secret === "string" && record.secret.trim() !== "";
}

/**
 * `jsonc.parse` collapses duplicate keys but `jsonc.modify` rewrites only one occurrence,
 * so a duplicated header would leave the second credential in the exported file. Redaction
 * cannot be guaranteed complete for such a file, so refuse it instead.
 */
function assertNoDuplicateKeys(tree: jsonc.Node, fileName: string): void {
  const visit = (node: jsonc.Node): void => {
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name: unknown = property.children?.[0]?.value;
        if (typeof name === "string") {
          if (names.has(name)) throw new Error(`Invalid ${fileName}: duplicate key '${name}'`);
          names.add(name);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function parseJsoncObjectWithTree(
  raw: string,
  fileName: string
): { parsed: Record<string, unknown>; tree: jsonc.Node } {
  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, errors);
  const tree = jsonc.parseTree(raw);
  const record = readRecord(parsed);
  if (errors.length > 0 || !record || tree?.type !== "object") {
    throw new Error(`Invalid ${fileName}`);
  }
  assertNoDuplicateKeys(tree, fileName);
  return { parsed: record, tree };
}

function parseJsoncObject(raw: string, fileName: string): Record<string, unknown> {
  return parseJsoncObjectWithTree(raw, fileName).parsed;
}

const JSONC_FORMATTING_OPTIONS: jsonc.FormattingOptions = { tabSize: 2, insertSpaces: true };
const JSONC_EDIT_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: JSONC_FORMATTING_OPTIONS,
};

/**
 * Rewrites values in place with jsonc edits, leaving the rest of the document as it was.
 * Restore needs that: it writes the file the user just previewed, not a reformatted copy.
 */
function applyJsoncEdits(text: string, edits: Array<{ path: jsonc.JSONPath; value: unknown }>) {
  let result = text;
  for (const edit of edits) {
    result = jsonc.applyEdits(
      result,
      jsonc.modify(result, edit.path, edit.value, JSONC_EDIT_OPTIONS)
    );
  }
  return result;
}

interface JsoncPropertyInsertion {
  leadingText: string;
  propertyText: string;
  trailingCommentText: string;
}

type LocalMcpServerMerge =
  | { kind: "none" }
  | { kind: "replace"; valueText: string }
  | {
      kind: "insert";
      objectPath: jsonc.JSONPath;
      entries: JsoncPropertyInsertion[];
      objectTrailingText: string;
    };

function containsJsoncComma(text: string): boolean {
  const scanner = jsonc.createScanner(text, false);
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if (token === jsonc.SyntaxKind.CommaToken) return true;
  }
  return false;
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : "";
}

function insertJsoncObjectProperties(
  text: string,
  jsonPath: jsonc.JSONPath,
  entries: readonly JsoncPropertyInsertion[],
  objectTrailingText: string
): string {
  if (entries.length === 0) return text;
  const tree = jsonc.parseTree(text);
  const objectNode = tree ? jsonc.findNodeAtLocation(tree, jsonPath) : undefined;
  if (objectNode?.type !== "object") throw new Error("Invalid mcp.jsonc");

  const properties = objectNode.children ?? [];
  const lastProperty = properties.at(-1);
  const objectEnd = objectNode.offset + objectNode.length - 1;
  const trailingComma =
    lastProperty !== undefined &&
    containsJsoncComma(text.slice(lastProperty.offset + lastProperty.length, objectEnd));
  const objectProperty = objectNode.parent?.type === "property" ? objectNode.parent : undefined;
  const closingIndent = lineIndentAt(text, objectProperty?.offset ?? objectNode.offset);
  const propertyIndent = `${closingIndent}${" ".repeat(JSONC_FORMATTING_OPTIONS.tabSize ?? 2)}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entryText = entries
    .map((entry, index) => {
      const leadingText = entry.leadingText || `${eol}${propertyIndent}`;
      const comma = index < entries.length - 1 || trailingComma ? "," : "";
      const trailingComment =
        entry.trailingCommentText === "" ? "" : ` ${entry.trailingCommentText}`;
      return `${leadingText}${entry.propertyText}${comma}${trailingComment}`;
    })
    .join("");
  const closeLineStart = text.lastIndexOf("\n", objectEnd - 1) + 1;
  const closePrefix = text.slice(closeLineStart, objectEnd);
  const insertAtLineStart = /^[\t ]*$/.test(closePrefix);
  const insertionOffset = insertAtLineStart ? closeLineStart : objectEnd;
  const insertedContent = `${entryText}${objectTrailingText}`;
  const insertionText = insertAtLineStart
    ? `${insertedContent.replace(/^\r?\n/, "")}${eol}`
    : `${insertedContent.startsWith(eol) ? "" : eol}${insertedContent}${eol}${closingIndent}`;

  let result = jsonc.applyEdits(text, [
    { offset: insertionOffset, length: 0, content: insertionText },
  ]);
  if (lastProperty !== undefined && !trailingComma) {
    result = jsonc.applyEdits(result, [
      { offset: lastProperty.offset + lastProperty.length, length: 0, content: "," },
    ]);
  }
  return result;
}

function replaceJsoncNodeText(text: string, jsonPath: jsonc.JSONPath, valueText: string): string {
  const tree = jsonc.parseTree(text);
  const node = tree ? jsonc.findNodeAtLocation(tree, jsonPath) : undefined;
  if (!node) throw new Error("Invalid mcp.jsonc");
  return jsonc.applyEdits(text, [{ offset: node.offset, length: node.length, content: valueText }]);
}

/**
 * `McpConfigService.readConfigFile` enumerates `servers` with `Object.entries`, so an array or
 * a string there becomes runnable servers named by index rather than being ignored. A document
 * like that cannot be projected field by field, so both an export and a restore refuse it
 * instead of passing a shape the runtime accepts through unexamined.
 * A falsy value is not this case: the runtime returns no servers at all for it.
 */
function isUnsupportedServerMap(value: unknown): boolean {
  return Boolean(value) && (typeof value !== "object" || Array.isArray(value));
}

/**
 * Fields Xum itself reads (`McpConfigService.normalizeEntry`), with the type it reads them as.
 * Anything else in the document, at any depth, is replaced with the marker: `normalizeEntry`
 * ignores an unrecognised field such as `env` or `args`, so nobody here can say whether its
 * value is a credential, and `{ "API_KEY": "hunter2" }` is not something a scanner can catch.
 * Restore puts the local value back at that exact path, so a field only Xum ignores is not
 * lost from a machine that already has it.
 */
const PORTABLE_SERVER_FIELDS: Record<string, (value: unknown) => boolean> = {
  command: (value) => typeof value === "string",
  url: (value) => typeof value === "string",
  transport: (value) =>
    value === "stdio" || value === "http" || value === "sse" || value === "auto",
  disabled: (value) => typeof value === "boolean",
  toolAllowlist: (value) => Array.isArray(value) && value.every((tool) => typeof tool === "string"),
};

/**
 * A jsonc edit keeps every comment, and a comment is prose the projection cannot inspect, so a
 * local `// token=hunter2` beside a server would be published verbatim and the scanner would
 * not recognise it either. Reserializing publishes only the values this file kept.
 */
function serializeProjectedMcp(text: string): {
  content: Buffer;
  parsed: Record<string, unknown>;
} {
  const parsed = readRecord(jsonc.parse(text));
  if (!parsed) throw new Error("Invalid mcp.jsonc");
  return {
    content: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8"),
    parsed,
  };
}

function valueHasRedactionAtPath(
  root: Record<string, unknown>,
  jsonPath: BackupRedactionPath
): boolean {
  let value: unknown = root;
  for (const segment of jsonPath) {
    if (typeof segment === "number") {
      value = Array.isArray(value) ? value[segment] : undefined;
      continue;
    }
    const record = readRecord(value);
    value = record ? readOwn(record, segment) : undefined;
  }
  return typeof value === "string" && containsRedaction(value);
}

function redactMcpConfig(content: Buffer): {
  content: Buffer;
  redactionPaths: BackupRedactionPath[];
} {
  const text = content.toString("utf-8");
  const { parsed: root, tree } = parseJsoncObjectWithTree(text, "mcp.jsonc");
  const redactionPaths: BackupRedactionPath[] = [];
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];

  function redact(jsonPath: jsonc.JSONPath): void {
    edits.push({ path: jsonPath, value: REDACTED_BACKUP_VALUE });
    redactionPaths.push([...jsonPath]);
  }

  function finish(): { content: Buffer; redactionPaths: BackupRedactionPath[] } {
    const projected = serializeProjectedMcp(applyJsoncEdits(text, edits));
    const retainedRedactionPaths = redactionPaths.filter((jsonPath) =>
      valueHasRedactionAtPath(projected.parsed, jsonPath)
    );
    assertBackupMcpRedactions(retainedRedactionPaths);
    return {
      content: projected.content,
      redactionPaths: retainedRedactionPaths,
    };
  }

  // Names come from the document rather than the parse result throughout, because
  // `jsonc.parse` drops a `__proto__` key while the text keeps it. Enumerating the parsed
  // object would leave such a key, and its value, published verbatim.
  for (const key of objectKeyNames(tree, [])) {
    if (key !== "servers") redact([key]);
  }

  const servers = readOwn(root, "servers");
  // Refused rather than redacted: restore rejects this shape on every machine, including the
  // one that wrote it, so redacting here would report a successful push for a backup that can
  // never be restored.
  if (isUnsupportedServerMap(servers)) {
    throw new BackupInvalidPayloadError(
      new Error(
        "Cannot back up: mcp.jsonc lists servers as something other than an object. Fix the local file, then back up again."
      )
    );
  }
  const serverRecord = readRecord(servers);
  if (!serverRecord) return finish();

  for (const serverName of objectKeyNames(tree, ["servers"])) {
    const rawServer = readOwn(serverRecord, serverName);
    // A bare string entry is the stdio command itself (`McpConfigService.normalizeEntry`).
    if (typeof rawServer === "string") continue;
    const server = readRecord(rawServer);
    if (!server) {
      redact(["servers", serverName]);
      continue;
    }

    for (const field of objectKeyNames(tree, ["servers", serverName])) {
      const fieldPath: jsonc.JSONPath = ["servers", serverName, field];
      const value = readOwn(server, field);
      const isPortableField = Object.hasOwn(PORTABLE_SERVER_FIELDS, field)
        ? PORTABLE_SERVER_FIELDS[field]
        : undefined;
      if (isPortableField) {
        // Read as the wrong type, `normalizeEntry` ignores it, which makes it another place
        // to hide a value nobody reads.
        if (!isPortableField(value)) redact(fieldPath);
        continue;
      }
      if (field === "headers") {
        const headers = readRecord(value);
        if (!headers) {
          redact(fieldPath);
          continue;
        }
        for (const headerName of objectKeyNames(tree, fieldPath)) {
          if (!isPortableReference(readOwn(headers, headerName))) {
            redact([...fieldPath, headerName]);
          }
        }
        continue;
      }
      // Xum ignores every other field, so its value may carry credentials under a shape this
      // projection cannot classify. Restore uses only the local value at that exact path.
      redact(fieldPath);
    }
  }
  return finish();
}

function findMcpRedactionPaths(tree: jsonc.Node): BackupRedactionPath[] {
  const paths: BackupRedactionPath[] = [];
  const jsonPath: BackupRedactionPath = [];

  function walk(node: jsonc.Node): void {
    if (node.type === "string") {
      if (typeof node.value === "string" && containsRedaction(node.value)) {
        paths.push([...jsonPath]);
      }
      return;
    }
    if (node.type === "array") {
      for (const [index, child] of (node.children ?? []).entries()) {
        jsonPath.push(index);
        walk(child);
        jsonPath.pop();
      }
      return;
    }
    if (node.type !== "object") return;
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value;
      const value = property.children?.[1];
      if (typeof key !== "string" || !value) continue;
      jsonPath.push(key);
      walk(value);
      jsonPath.pop();
    }
  }

  walk(tree);
  return paths;
}

function redactionPathKey(jsonPath: ReadonlyArray<string | number>): string {
  return JSON.stringify(jsonPath);
}

function redactionPathLabel(jsonPath: ReadonlyArray<string | number>): string {
  return jsonPath.join(".");
}

function validateMcpRedactionPaths(tree: jsonc.Node, paths: readonly BackupRedactionPath[]): void {
  if (paths.length === 0) return;
  const markerPaths = new Set(findMcpRedactionPaths(tree).map(redactionPathKey));
  for (const jsonPath of paths) {
    if (!markerPaths.has(redactionPathKey(jsonPath))) {
      throw new BackupInvalidPayloadError(
        new Error(`Invalid MCP redaction path '${redactionPathLabel(jsonPath)}'`)
      );
    }
  }
}

/**
 * Documentation is the only thing a recursive collection publishes without asking. `skills/`
 * and `memory/global/` hold whatever the user put there, and no content scanner can decide
 * whether an arbitrary file is a credential: `{"password":"hunter2"}` has no distinguishing
 * shape. So the gate is structural rather than pattern-based, and anything outside the
 * documented set is surfaced for review instead of being published or silently dropped.
 */
const AUTO_PUBLISHED_RECURSIVE_FILE = /\.(?:md|mdx|markdown|txt)$/i;

/** A name promising credentials earns review even when the extension is documentation. */
const CREDENTIAL_PATH_HINT =
  /(?:^|[^a-z])(?:credential|credentials|secret|secrets|password|passwords|token|tokens|(?:api|private)(?:[^a-z/]+)?keys?|netrc|keychain|htpasswd)(?:[^a-z]|$)/i;

function hasCredentialPathHint(filePath: string): boolean {
  const stem = path.posix.parse(filePath).name.toLowerCase();
  return stem === "auth" || stem === "passwd" || CREDENTIAL_PATH_HINT.test(filePath);
}

const MCP_REVIEW_URL_PARAMETER_NAMES = new Set([
  ...CREDENTIAL_URL_PARAMETER_NAMES,
  "code",
  "key",
  "session",
  "sid",
  "sig",
]);

function rawUrlHasUserinfo(rawUrl: string): boolean {
  const schemeEnd = rawUrl.indexOf("://");
  if (schemeEnd < 0 && !rawUrl.startsWith("//")) return false;
  const authorityStart = schemeEnd >= 0 ? schemeEnd + 3 : 2;
  const delimiters = ["/", "?", "#"]
    .map((delimiter) => rawUrl.indexOf(delimiter, authorityStart))
    .filter((offset) => offset >= 0);
  const authorityEnd = delimiters.length > 0 ? Math.min(...delimiters) : rawUrl.length;
  // Decoded first: a client resolves `user:pw%40host` to userinfo `user:pw`, so the encoded
  // spelling publishes the same credential the literal one is held back for.
  return decodeDelimitersOnce(rawUrl.slice(authorityStart, authorityEnd)).includes("@");
}

function normalizedUrlHasUserinfo(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

function malformedSpecialUrlHasUserinfo(rawUrl: string): boolean {
  return /^(?:ftp|https?|wss?):[^/?#]*@/i.test(decodeDelimitersOnce(rawUrl));
}

function urlHasCredentialComponents(rawUrl: string): boolean {
  return (
    rawUrlHasUserinfo(rawUrl) ||
    malformedSpecialUrlHasUserinfo(rawUrl) ||
    normalizedUrlHasUserinfo(rawUrl) ||
    hasCredentialUrlParameters(rawUrl, MCP_REVIEW_URL_PARAMETER_NAMES)
  );
}

function mcpConfigRequiresPublishApproval(content: string): boolean {
  const errors: jsonc.ParseError[] = [];
  const parsed = readRecord(jsonc.parse(content, errors));
  if (errors.length > 0 || !parsed) return false;
  const servers = readRecord(readOwn(parsed, "servers"));
  if (!servers) return false;
  for (const server of Object.values(servers)) {
    const serverRecord = readRecord(server);
    const command =
      typeof server === "string" ? server : serverRecord && readOwn(serverRecord, "command");
    if (typeof command === "string" && command.trim() !== "") return true;
    if (!serverRecord) continue;
    const url = readOwn(serverRecord, "url");
    if (typeof url === "string" && urlHasCredentialComponents(url)) return true;
  }
  return false;
}

function isRecursivelyCollected(filePath: string): boolean {
  return (
    filePath.startsWith("skills/") ||
    filePath.startsWith("memory/global/") ||
    // Project-bundle memory files are scanned alongside the core payload with their
    // bundle-relative paths, and are swept up recursively the same way global memory is.
    filePath.startsWith(PROJECT_MEMORY_PATH_PREFIX)
  );
}

/**
 * Files a push must not publish until the user approves this exact payload. Not all of them
 * hold a secret: the structural cases are suspicion rather than detection.
 */
export function scanBackupFilesForSecrets(files: readonly BackupFile[]): string[] {
  return files
    .filter((file) => {
      const content = file.content.toString("utf-8");
      if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) return true;
      if (file.path === "mcp.jsonc" && mcpConfigRequiresPublishApproval(content)) return true;
      // Every collected file, not just the recursive ones: `agents/` is collected by name and
      // its `.md` filter would otherwise auto-publish `agents/api-key.md`.
      if (hasCredentialPathHint(file.path)) return true;
      if (!isRecursivelyCollected(file.path)) return false;
      return !AUTO_PUBLISHED_RECURSIVE_FILE.test(file.path);
    })
    .map((file) => file.path)
    .sort();
}

/**
 * Binds an override to the exact bytes it was shown for. A bare boolean would let approval of
 * one blocked set authorize a later push whose payload another window changed in between.
 */
export function backupSecretApprovalDigest(
  files: readonly BackupFile[],
  flaggedPaths: readonly string[]
): string {
  const flagged = new Set(flaggedPaths);
  // JSON for the same reason as backupCommandApprovalToken: no delimiter is unambiguous
  // once a component can contain it. Paths are portable-checked today, but the digest must
  // not depend on that staying true.
  const parts = files
    .filter((file) => flagged.has(file.path))
    .map((file) => [file.path, sha256(file.content)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify(parts), "utf-8"));
}

export async function createBackupPayload(
  options: CreateBackupPayloadOptions
): Promise<BackupPayload> {
  const files = await collectAllowlistedFiles(options.muxRoot);
  const mcpRedactionPaths: BackupRedactionPath[] = [];
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  if (mcpFile && options.keepLocalSecrets !== true) {
    const redacted = redactMcpConfig(mcpFile.content);
    mcpFile.content = redacted.content;
    mcpRedactionPaths.push(...redacted.redactionPaths);
  }
  files.push({
    path: "preferences.json",
    content: serializeBackupPreferences(options.preferences),
  });
  // Count and complexity only: this payload may be a local snapshot, whose names keep
  // current-filesystem forms that portable validation would refuse. Collection already
  // validated each name under local rules; publication re-checks with portable rules.
  assertBackupFileCount(files.length);
  assertBackupPathComplexity(files.map((file) => file.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (options.reportSecrets !== true) {
    const secretFiles = scanBackupFilesForSecrets(files);
    if (secretFiles.length > 0) {
      throw new Error(`Backup contains possible secrets in: ${secretFiles.join(", ")}`);
    }
  }

  return {
    manifest: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      muxVersion: normalizeMuxVersion(options.muxVersion),
      sourceLabel: options.sourceLabel,
      ...(mcpFile ? { mcpRedactions: mcpRedactionPaths } : {}),
      files: files.map((file) => ({
        path: file.path,
        sha256: sha256(file.content),
        ...(file.executable === true ? { executable: true } : {}),
      })),
    },
    files,
    redactions: mcpRedactionPaths.map(redactionPathLabel),
  };
}

function sameManifestContent(a: BackupManifest, b: BackupManifest): boolean {
  if (JSON.stringify(a.mcpRedactions) !== JSON.stringify(b.mcpRedactions)) return false;
  if (a.files.length !== b.files.length) return false;
  return a.files.every(
    (file, index) =>
      file.path === b.files[index]?.path &&
      file.sha256 === b.files[index]?.sha256 &&
      (file.executable === true) === (b.files[index]?.executable === true)
  );
}

/** Null when the directory is not there yet, which is the ordinary first push. */
async function resolveRootIfPresent(root: string): Promise<BackupRoot | null> {
  try {
    return await resolveRoot(root);
  } catch {
    return null;
  }
}

async function readManifestIfPresent(
  destinationDir: BackupRoot | null
): Promise<{ manifest: BackupManifest; raw: string } | null> {
  if (destinationDir === null) return null;
  try {
    await resolveContainedPath(destinationDir.path, BACKUP_MANIFEST_FILE);
    // Reading this only avoids a no-op commit, so an oversized one is ignored rather than
    // buffered: the push replaces it either way.
    const raw = (
      await readCheckedFile(destinationDir, BACKUP_MANIFEST_FILE, (size) => {
        if (size > MAX_BACKUP_FILE_BYTES) {
          throw new Error(`'${BACKUP_MANIFEST_FILE}' is larger than the reuse limit`);
        }
      })
    ).content.toString("utf-8");
    // Portable: this manifest is the one already in the repository, which every platform that
    // pulls the backup has to be able to write out.
    return { manifest: parseManifest(raw, true), raw };
  } catch {
    return null;
  }
}

function normalizeMuxVersion(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * Read-time budgets bound what is buffered; this bounds what is published, which is not the
 * same set: `preferences.json` is generated after collection, and redaction rewrites content.
 * Without it a push could commit a payload that every later Preview rejects as oversized.
 */
function assertPayloadWithinLimits(files: readonly BackupFile[], manifestJson: string): void {
  // Manifest first, matching the order the reader charges them, so a payload that writes
  // cannot be one that every later read rejects.
  const budget = createByteBudget();
  budget(BACKUP_MANIFEST_FILE, Buffer.byteLength(manifestJson, "utf-8"));
  for (const file of files) budget(file.path, file.content.length);
}

export async function writeBackupPayload(
  destinationDir: string,
  payload: BackupPayload,
  options: { portable?: boolean; ownerOnly?: boolean } = {}
): Promise<void> {
  const portable = options.portable !== false;
  assertBackupPathLimits(
    payload.files.map((file) => file.path),
    { portable }
  );
  assertBackupPathLimits(
    payload.manifest.files.map((file) => file.path),
    { portable }
  );
  const ownerOnly = options.ownerOnly === true;
  const claimed = new Set<string>();
  for (const file of payload.files) {
    // A published backup is read on filesystems that fold case and normalization, so a
    // collision only a case-sensitive source can produce would make it unreadable elsewhere.
    // A local snapshot goes back to the filesystem the files were just collected from, where
    // two names that coexist are two files by definition, so folding them would refuse to
    // snapshot a perfectly valid `Foo.md` beside `foo.md` and block the restore entirely.
    const claim = portable ? collisionKey(file.path) : file.path;
    if (claimed.has(claim)) throw new Error(`Duplicate backup path '${file.path}'`);
    claimed.add(claim);
  }
  // Reuse the previous manifest when content hashes match. Otherwise changing
  // export metadata would produce a commit with no settings changes.
  const previous = await readManifestIfPresent(await resolveRootIfPresent(destinationDir));
  const reusable = previous && sameManifestContent(previous.manifest, payload.manifest);
  const manifestJson = reusable ? previous.raw : `${JSON.stringify(payload.manifest, null, 2)}\n`;
  assertPayloadWithinLimits(payload.files, manifestJson);

  await fs.rm(destinationDir, { recursive: true, force: true });
  // `ownerOnly` restores what the remove just discarded: a safety snapshot's destination
  // comes from `mkdtemp` as owner-only, and it holds an unredacted payload, so recreating
  // it with the process umask could hand other local users the literal MCP credentials.
  await fs.mkdir(destinationDir, { recursive: true, ...(ownerOnly ? { mode: 0o700 } : {}) });
  const root = await resolveRoot(destinationDir);
  for (const file of payload.files) {
    await resolveContainedPath(root.path, file.path);
    await writeCheckedFile(root, file.path, file.content, file.executable === true, {
      ownerOnly,
    });
  }
  await writeCheckedFile(root, BACKUP_MANIFEST_FILE, Buffer.from(manifestJson, "utf-8"), false, {
    ownerOnly,
  });
}

function assertBackupMcpRedactionCount(redactionCount: number): void {
  if (redactionCount > MAX_BACKUP_MCP_REDACTIONS) {
    throw new Error(`Backup has more than ${MAX_BACKUP_MCP_REDACTIONS} MCP redactions`);
  }
}

function assertBackupMcpRedactionSegments(
  pathSegmentCount: number,
  totalSegmentCount: number
): void {
  if (pathSegmentCount > MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS) {
    throw new Error(
      `Backup MCP redaction path has more than ${MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS} segments`
    );
  }
  if (totalSegmentCount > MAX_BACKUP_MCP_REDACTION_SEGMENTS) {
    throw new Error(
      `Backup MCP redaction paths have more than ${MAX_BACKUP_MCP_REDACTION_SEGMENTS} total segments`
    );
  }
}

function assertBackupMcpRedactions(
  redactions: unknown[]
): asserts redactions is BackupRedactionPath[] {
  assertBackupMcpRedactionCount(redactions.length);
  let segmentCount = 0;
  for (const jsonPath of redactions) {
    if (!Array.isArray(jsonPath) || jsonPath.length === 0) {
      throw new Error("Invalid backup manifest");
    }
    segmentCount += jsonPath.length;
    assertBackupMcpRedactionSegments(jsonPath.length, segmentCount);
    if (
      !jsonPath.every(
        (segment) =>
          typeof segment === "string" ||
          (typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
      )
    ) {
      throw new Error("Invalid backup manifest");
    }
  }
}

function parseManifest(raw: string, portable: boolean): BackupManifest {
  const tree = jsonc.parseTree(raw);
  if (!tree) throw new Error("Invalid backup manifest");
  assertNoDuplicateKeys(tree, "backup manifest");
  const value: unknown = JSON.parse(raw);
  if (!isPlainObject(value)) throw new Error("Invalid backup manifest");
  const manifest: Partial<BackupManifest> = value;
  if (
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    typeof manifest.exportedAt !== "string" ||
    typeof manifest.muxVersion !== "string" ||
    typeof manifest.sourceLabel !== "string"
  ) {
    throw new Error("Invalid backup manifest");
  }
  const mcpRedactions: unknown = manifest.mcpRedactions;
  if (mcpRedactions !== undefined) {
    if (!Array.isArray(mcpRedactions)) throw new Error("Invalid backup manifest");
    assertBackupMcpRedactions(mcpRedactions);
  }
  if (!Array.isArray(manifest.files)) throw new Error("Invalid backup manifest");
  assertBackupFileCount(manifest.files.length);
  if (mcpRedactions !== undefined) {
    const paths = new Set<string>();
    for (const jsonPath of mcpRedactions) {
      const key = redactionPathKey(jsonPath);
      if (paths.has(key)) throw new Error("Invalid backup manifest: duplicate MCP redaction path");
      paths.add(key);
    }
  }
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      (file.executable !== undefined && typeof file.executable !== "boolean")
    ) {
      throw new Error("Invalid backup manifest file entry");
    }
  }
  assertBackupPathLimits(
    manifest.files.map((file) => file.path),
    { portable }
  );
  return manifest as BackupManifest;
}

/**
 * True when the bytes parse as a portable backup manifest. Managed-path selection probes
 * with this rather than mere existence: `manifest.json` is a generic filename, so an
 * unrelated or corrupt file under one spelling must not beat a valid backup under another.
 */
export function isParseableBackupManifest(raw: string): boolean {
  try {
    parseManifest(raw, true);
    return true;
  } catch {
    return false;
  }
}

export async function backupPayloadExists(sourceDir: string): Promise<boolean> {
  return await fileExists(path.join(sourceDir, BACKUP_MANIFEST_FILE));
}

export class BackupInvalidPayloadError extends Error {
  readonly code = "INVALID_BACKUP";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BackupInvalidPayloadError";
  }
}

/** An fs failure carries an errno string; a validation failure does not. */
function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * Wraps validation failures so the service reports repository corruption as
 * `INVALID_BACKUP` rather than the `IO_ERROR` fallback. A genuine filesystem failure keeps
 * its own error, so a local disk problem is not blamed on the repository.
 *
 * `portable: false` for a local safety snapshot, matching the `writeBackupPayload` call that
 * produced it: those keep names only this filesystem has to accept, so the cross-platform
 * rules a repository payload needs would reject the copy a recovery reads.
 */
export async function readBackupPayload(
  sourceDir: string,
  options: { portable?: boolean } = {}
): Promise<BackupPayload> {
  try {
    return await readBackupPayloadUnchecked(sourceDir, options.portable !== false);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    throw new BackupInvalidPayloadError(error);
  }
}

/**
 * An absent file here means the manifest describes content the repository does not have,
 * which is a corrupt backup rather than a local disk problem. Any other errno still belongs
 * to the local filesystem and keeps its own error.
 */
async function readManifestEntry(
  sourceDir: BackupRoot,
  relativePath: string,
  budget: ByteBudget
): Promise<Buffer> {
  try {
    await resolveContainedPath(sourceDir.path, relativePath);
    return (
      await readCheckedFile(sourceDir, relativePath, (size) => {
        budget(relativePath, size);
      })
    ).content;
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      throw new Error(`Backup is missing '${relativePath}'`);
    }
    throw error;
  }
}

async function readBackupPayloadUnchecked(
  sourceDir: string,
  portable: boolean
): Promise<BackupPayload> {
  const budget = createByteBudget();
  const root = await resolveRoot(sourceDir);
  await resolveContainedPath(root.path, BACKUP_MANIFEST_FILE);
  // The manifest is the first thing read from a repository anyone with write access can
  // change, so it is charged to the same budget before it is parsed.
  const manifestRaw = await readCheckedFile(root, BACKUP_MANIFEST_FILE, (size) => {
    budget(BACKUP_MANIFEST_FILE, size);
  });
  const manifest = parseManifest(manifestRaw.content.toString("utf-8"), portable);
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    const key = portable ? collisionKey(manifestFile.path) : manifestFile.path;
    if (seen.has(key)) throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(key);
    const content = await readManifestEntry(root, manifestFile.path, budget);
    if (sha256(content) !== manifestFile.sha256) {
      throw new Error(`Backup checksum mismatch for '${manifestFile.path}'`);
    }
    files.push({
      path: manifestFile.path,
      content,
      ...(manifestFile.executable === true ? { executable: true } : {}),
    });
  }
  // Parse every structured entry here so a malformed backup is rejected before restore
  // writes anything. Otherwise a later parse failure leaves a half-restored install.
  const preferencesFile = files.find((file) => file.path === "preferences.json");
  if (preferencesFile) {
    projectBackupPreferences(JSON.parse(preferencesFile.content.toString("utf-8")));
  }
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  const parsedMcp = mcpFile
    ? parseJsoncObjectWithTree(mcpFile.content.toString("utf-8"), "backup mcp.jsonc")
    : undefined;
  if (manifest.mcpRedactions !== undefined) {
    if (!parsedMcp) throw new Error("Backup manifest lists MCP redactions without mcp.jsonc");
    validateMcpRedactionPaths(parsedMcp.tree, manifest.mcpRedactions);
    return {
      manifest,
      files,
      redactions: manifest.mcpRedactions.map(redactionPathLabel),
    };
  }
  return {
    manifest,
    files,
    redactions: parsedMcp ? findMcpRedactionPaths(parsedMcp.tree).map(redactionPathLabel) : [],
  };
}

function containsRedaction(value: string): boolean {
  return (
    value.includes(REDACTED_BACKUP_VALUE) ||
    value.includes(encodeURIComponent(REDACTED_BACKUP_VALUE))
  );
}

function isRedactedBackupValue(
  value: string,
  jsonPath: jsonc.JSONPath,
  redactedPaths: ReadonlySet<string> | undefined
): boolean {
  return redactedPaths === undefined
    ? containsRedaction(value)
    : redactedPaths.has(redactionPathKey(jsonPath));
}

/** Whole-value restoration prevents backup-controlled text from redirecting local credentials. */
function collectRedactionRestoreEdits(
  backup: unknown,
  local: unknown,
  currentPath: jsonc.JSONPath,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  redactedPaths: ReadonlySet<string> | undefined,
  resolvedServers: ReadonlySet<string> = new Set()
): void {
  // Only the paths handled by command or header resolution are skipped, so a mixed entry
  // can still rehydrate its other redacted values. A dropped entry is skipped wholesale,
  // since a nested edit would resurrect what it removed.
  if (resolvedServers.has(currentPath.join("\u0000"))) return;
  if (typeof backup === "string" && isRedactedBackupValue(backup, currentPath, redactedPaths)) {
    if (local !== undefined) edits.push({ path: currentPath, value: local });
    return;
  }
  if (Array.isArray(backup)) {
    const localArray = Array.isArray(local) ? local : [];
    backup.forEach((value, index) =>
      collectRedactionRestoreEdits(
        value,
        localArray[index],
        [...currentPath, index],
        edits,
        redactedPaths,
        resolvedServers
      )
    );
    return;
  }
  const backupRecord = readRecord(backup);
  if (!backupRecord) return;
  const localRecord = readRecord(local) ?? {};
  for (const [key, value] of Object.entries(backupRecord)) {
    collectRedactionRestoreEdits(
      value,
      readOwn(localRecord, key),
      [...currentPath, key],
      edits,
      redactedPaths,
      resolvedServers
    );
  }
}

/** Shared by preview and restore so the preview cannot promise a different result. */
export async function resolveRestoredContent(
  muxRoot: string,
  file: BackupFile,
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<Buffer> {
  return file.path === "mcp.jsonc"
    ? await restoreMcpFile(muxRoot, file.content, mcpRedactions)
    : file.content;
}

/**
 * Local MCP state is optional. The pre-check avoids opening special files, while the nonblocking
 * checked read makes a replacement race fail instead of hanging restore.
 */
async function readLocalMcpText(muxRoot: string): Promise<string | null> {
  try {
    const root = await resolveRoot(muxRoot);
    if (!(await isRegularFile(absolutePathOf(root.path, "mcp.jsonc")))) return null;
    const budget = createByteBudget();
    const { content } = await readCheckedFile(root, "mcp.jsonc", (size) =>
      budget("mcp.jsonc", size)
    );
    return content.toString("utf-8");
  } catch {
    return null;
  }
}

interface ServerCommand {
  command: string;
  enabled: boolean;
  /** False when `normalizeEntry` gives a non-empty URL precedence over this command. */
  runnable: boolean;
}

/**
 * Mirrors `McpConfigService.normalizeEntry`: a stdio server is either a bare command
 * string or an object carrying `command`. An empty command cannot run anything, so it is
 * not tracked. A disabled entry IS tracked, because `MCPServerManager.applyServerOverrides`
 * lets a workspace `enabledServers` override start a project-disabled server.
 */
function readServerCommand(value: unknown): ServerCommand | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (raw !== undefined) {
    if (raw.trim() === "") return undefined;
    return { command: raw, enabled: true, runnable: true };
  }
  const record = readRecord(value);
  if (!record) return undefined;
  const command = record.command;
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const url = record.url;
  return {
    command,
    enabled: record.disabled !== true,
    runnable: !(typeof url === "string" && url !== ""),
  };
}

/**
 * Only for the local file, where a malformed config holds no recoverable commands and
 * every incoming one is therefore new. The backup's own copy must never be read this way:
 * treating an unparseable payload as "no commands" would let it skip the approval gate.
 */
function readLocalServerCommands(content: string): Map<string, ServerCommand> {
  try {
    return readServerCommands(content);
  } catch {
    return new Map();
  }
}

function readServerCommands(content: string): Map<string, ServerCommand> {
  const commands = new Map<string, ServerCommand>();
  const servers = parseJsoncObject(content, "mcp.jsonc").servers;
  if (isUnsupportedServerMap(servers)) {
    throw new BackupInvalidPayloadError(
      new Error(
        "Cannot restore: the backup's mcp.jsonc lists servers as something other than an object"
      )
    );
  }
  const serverRecord = readRecord(servers);
  if (!serverRecord) return commands;
  for (const [name, server] of Object.entries(serverRecord)) {
    const entry = readServerCommand(server);
    if (entry !== undefined) commands.set(name, entry);
  }
  return commands;
}

/** Binds an approval to the exact command text the user read. */
export function backupCommandApprovalToken(serverPath: string, command: string): string {
  // JSON, not delimiter-joined: both components come from JSONC strings, whose escapes can
  // produce any character including NUL, so no delimiter makes concatenation unambiguous
  // and a crafted pair could collide with a different command's token.
  return sha256(Buffer.from(JSON.stringify([serverPath, command]), "utf-8"));
}

/**
 * MCP commands a restore would make runnable, or newly runnable. Those strings reach
 * `runtime.exec()` when the server next starts, so a repository the user does not fully
 * control must not be able to change them without the user reading the exact text first.
 * A command is exempt only when the local config already holds identical text and the
 * restore does not enable it, which covers both an unchanged command and one whose whole
 * scalar the redaction rehydration kept locally authoritative.
 */
export async function collectMcpCommandApprovals(
  muxRoot: string,
  files: readonly BackupFile[],
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<BackupCommandApproval[]> {
  const file = files.find((candidate) => candidate.path === "mcp.jsonc");
  if (!file) return [];

  const restored = await resolveRestoredContent(muxRoot, file, mcpRedactions);
  const incoming = readServerCommands(restored.toString("utf-8"));
  const localText = await readLocalMcpText(muxRoot);
  const local =
    localText === null ? new Map<string, ServerCommand>() : readLocalServerCommands(localText);

  const approvals: BackupCommandApproval[] = [];
  for (const [name, entry] of incoming) {
    if (!entry.runnable) continue;
    const current = local.get(name);
    // A workspace can enable a disabled command, so removing its URL shadow still needs approval.
    const makesItRun = current?.runnable === false || (entry.enabled && current?.enabled === false);
    if (current?.command === entry.command && !makesItRun) continue;
    const serverPath = `servers.${name}.command`;
    approvals.push({
      path: serverPath,
      command: entry.command,
      token: backupCommandApprovalToken(serverPath, entry.command),
    });
  }
  return approvals;
}

export function assertBackupCommandsApproved(
  approvals: readonly BackupCommandApproval[],
  approvedTokens: readonly string[] | null | undefined
): void {
  const approved = new Set(approvedTokens ?? []);
  const unapproved = approvals.filter((approval) => !approved.has(approval.token));
  // The full list, not just the unapproved rest: the UI resends tokens only for the
  // commands it displays, so an error carrying a subset would drop the already-approved
  // tokens from the retry and turn them back into the next round's unapproved rest.
  if (unapproved.length > 0) throw new BackupCommandApprovalRequiredError(approvals);
}

async function restoreMcpFile(
  muxRoot: string,
  content: Buffer,
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<Buffer> {
  const redactedPaths =
    mcpRedactions === undefined ? undefined : new Set(mcpRedactions.map(redactionPathKey));
  const backupText = content.toString("utf-8");
  // Deliberately not gated on a marker being present: `resolveRestoredHeaders` has to inspect
  // a marker-free backup too, since a bare `{secret: NAME}` header carries no marker yet
  // still resolves against local data.
  const { parsed: backup, tree: backupTree } = parseJsoncObjectWithTree(
    backupText,
    "backup mcp.jsonc"
  );
  if (mcpRedactions !== undefined) validateMcpRedactionPaths(backupTree, mcpRedactions);
  const localText = await readLocalMcpText(muxRoot);
  let local: Record<string, unknown> = {};
  let localTree: jsonc.Node | undefined;
  if (localText !== null) {
    try {
      const parsedLocal = parseJsoncObjectWithTree(localText, "local mcp.jsonc");
      local = parsedLocal.parsed;
      localTree = parsedLocal.tree;
    } catch {
      // A corrupt local file holds no recoverable values, and it must not block the
      // restore that would replace it.
      local = {};
    }
  }
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  const localServerMerge =
    localTree && localText
      ? preserveLocalOnlyMcpServers(backupTree, localTree, localText)
      : ({ kind: "none" } satisfies LocalMcpServerMerge);
  const resolved = resolveRestoredCommands(backup, local, edits, redactedPaths);
  for (const path of resolveRestoredHeaders(
    backup,
    local,
    backupTree,
    edits,
    resolved,
    redactedPaths
  )) {
    resolved.add(path);
  }
  collectRedactionRestoreEdits(backup, local, [], edits, redactedPaths, resolved);
  let restoredText = applyJsoncEdits(backupText, edits);
  if (localServerMerge.kind === "replace") {
    restoredText = replaceJsoncNodeText(restoredText, ["servers"], localServerMerge.valueText);
  } else if (localServerMerge.kind === "insert") {
    restoredText = insertJsoncObjectProperties(
      restoredText,
      localServerMerge.objectPath,
      localServerMerge.entries,
      localServerMerge.objectTrailingText
    );
  }
  parseJsoncObjectWithTree(restoredText, "restored mcp.jsonc");
  return Buffer.from(restoredText, "utf-8");
}

function leadingJsoncTriviaText(
  text: string,
  objectNode: jsonc.Node,
  property: jsonc.Node,
  previousProperty: jsonc.Node | undefined
): string {
  const start = previousProperty
    ? previousProperty.offset + previousProperty.length
    : objectNode.offset + 1;
  const trivia = text.slice(start, property.offset);
  if (!previousProperty) return trivia;
  const lineBreak = trivia.search(/\r?\n/);
  return lineBreak < 0 ? "" : trivia.slice(lineBreak);
}

function trailingJsoncCommentText(
  text: string,
  objectNode: jsonc.Node,
  property: jsonc.Node,
  nextProperty: jsonc.Node | undefined
): string {
  const end = nextProperty?.offset ?? objectNode.offset + objectNode.length - 1;
  const trivia = text.slice(property.offset + property.length, end);
  const scanner = jsonc.createScanner(trivia, false);
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if (token === jsonc.SyntaxKind.Trivia || token === jsonc.SyntaxKind.CommaToken) continue;
    if (token === jsonc.SyntaxKind.LineBreakTrivia) return "";
    if (
      token === jsonc.SyntaxKind.LineCommentTrivia ||
      token === jsonc.SyntaxKind.BlockCommentTrivia
    ) {
      return trivia.slice(
        scanner.getTokenOffset(),
        scanner.getTokenOffset() + scanner.getTokenLength()
      );
    }
    return "";
  }
  return "";
}

function objectTrailingJsoncText(text: string, objectNode: jsonc.Node): string {
  const properties = objectNode.children ?? [];
  const lastProperty = properties.at(-1);
  if (!lastProperty) return "";
  const start = lastProperty.offset + lastProperty.length;
  const end = objectNode.offset + objectNode.length - 1;
  const trivia = text.slice(start, end);
  const lineBreak = trivia.search(/\r?\n/);
  if (lineBreak < 0) return "";
  return trivia.slice(lineBreak).replace(/\r?\n[\t ]*$/, "");
}

function jsoncPropertyInsertion(
  text: string,
  objectNode: jsonc.Node,
  propertyIndex: number
): JsoncPropertyInsertion {
  const properties = objectNode.children ?? [];
  const property = properties[propertyIndex];
  if (!property) throw new Error("Invalid JSONC property index");
  return {
    leadingText: leadingJsoncTriviaText(text, objectNode, property, properties[propertyIndex - 1]),
    propertyText: text.slice(property.offset, property.offset + property.length),
    trailingCommentText: trailingJsoncCommentText(
      text,
      objectNode,
      property,
      properties[propertyIndex + 1]
    ),
  };
}

/** Restore is not a mirror, so it keeps server definitions present only on this device. */
function preserveLocalOnlyMcpServers(
  backupTree: jsonc.Node,
  localTree: jsonc.Node,
  localText: string
): LocalMcpServerMerge {
  const backupServersNode = jsonc.findNodeAtLocation(backupTree, ["servers"]);
  const localServersNode = jsonc.findNodeAtLocation(localTree, ["servers"]);
  if (localServersNode?.type !== "object") return { kind: "none" };

  const localServersText = localText.slice(
    localServersNode.offset,
    localServersNode.offset + localServersNode.length
  );
  if (backupServersNode === undefined) {
    const property = localServersNode.parent;
    const properties = localTree.children ?? [];
    const index = property ? properties.indexOf(property) : -1;
    if (property?.type !== "property" || index < 0) return { kind: "none" };
    return {
      kind: "insert",
      objectPath: [],
      entries: [jsoncPropertyInsertion(localText, localTree, index)],
      objectTrailingText:
        index === properties.length - 1 ? objectTrailingJsoncText(localText, localTree) : "",
    };
  }
  if (backupServersNode.type !== "object") {
    return jsonc.getNodeValue(backupServersNode)
      ? { kind: "none" }
      : { kind: "replace", valueText: localServersText };
  }

  const backupNames = new Set(objectKeyNames(backupTree, ["servers"]));
  const localProperties = localServersNode.children ?? [];
  const entries = localProperties.flatMap((property, index) => {
    const key: unknown = property.children?.[0]?.value;
    return typeof key === "string" && !backupNames.has(key)
      ? [jsoncPropertyInsertion(localText, localServersNode, index)]
      : [];
  });
  if (entries.length === 0) return { kind: "none" };
  const lastLocalProperty = localProperties.at(-1);
  const lastLocalKey: unknown = lastLocalProperty?.children?.[0]?.value;
  return {
    kind: "insert",
    objectPath: ["servers"],
    entries,
    objectTrailingText:
      typeof lastLocalKey === "string" && !backupNames.has(lastLocalKey)
        ? objectTrailingJsoncText(localText, localServersNode)
        : "",
  };
}

/** Tracks handled paths so the generic pass cannot resurrect removed commands. */
function resolveRestoredCommands(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  redactedPaths: ReadonlySet<string> | undefined
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    const barePath: jsonc.JSONPath = ["servers", name];
    const objectPath: jsonc.JSONPath = ["servers", name, "command"];
    const isBareMarker =
      typeof entry === "string" && isRedactedBackupValue(entry, barePath, redactedPaths);
    const objectCommand = readRecord(entry)?.command;
    const isObjectMarker =
      !isBareMarker &&
      typeof objectCommand === "string" &&
      isRedactedBackupValue(objectCommand, objectPath, redactedPaths);
    if (!isBareMarker && !isObjectMarker) continue;

    const localEntry = readOwn(localServers, name);
    const localCommand = readAnyServerCommand(localEntry);
    if (localCommand === undefined) {
      // `normalizeEntry` gives a non-empty resolved URL precedence over the command. Keep that
      // HTTP entry after removing the marker; otherwise remove the server so it cannot execute.
      const url = isObjectMarker
        ? restoredServerUrl(entry, readRecord(localEntry), name, redactedPaths)
        : undefined;
      const hasUrl = url !== undefined && url !== "" && !containsRedaction(url);
      const removed: jsonc.JSONPath = hasUrl ? ["servers", name, "command"] : ["servers", name];
      edits.push({ path: removed, value: undefined });
      handled.add(removed.join("\u0000"));
      continue;
    }
    const commandPath = isBareMarker ? barePath : objectPath;
    edits.push({ path: commandPath, value: localCommand });
    handled.add(commandPath.join("\u0000"));
  }
  return handled;
}

/**
 * A restored header value is only ever the local value at that exact path, or nothing.
 *
 * `MCPServerManager.resolveHeaders` resolves both a literal header and a `{secret: NAME}`
 * reference against local data, then sends the result to whatever `url` the entry carries.
 * Deciding per value shape which ones are safe to carry over from a backup does not work:
 * a marker, a marker standing in for the whole `headers` object, a bare reference in a
 * marker-free file, and a reference the backup adds next to a url it chose are all the same
 * defect. So nothing the backup writes under `headers` survives unless the local file
 * already holds it at the same path, which makes the shape irrelevant.
 *
 * A local value is only put back when the restored entry still points at the endpoint the
 * local config already sends that header to. Otherwise the header is dropped, leaving an
 * entry that cannot authenticate rather than one that authenticates somewhere the user never
 * approved. Only header names the backup itself lists are considered, so a restore never
 * introduces a local header the backup did not have.
 *
 * Returns the paths handled here so the generic redaction walk leaves them alone.
 */
function resolveRestoredHeaders(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  backupTree: jsonc.Node,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  resolvedServers: ReadonlySet<string>,
  redactedPaths: ReadonlySet<string> | undefined
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    // An entry command resolution already removed has no headers left to decide about, and
    // `jsonc.modify` cannot address a path whose parent this edit list deletes.
    if (resolvedServers.has(["servers", name].join("\u0000"))) continue;
    const rawHeaders = readRecord(entry)?.headers;
    if (rawHeaders === undefined) continue;
    const localServer = readRecord(readOwn(localServers, name));
    const headersPath: jsonc.JSONPath = ["servers", name, "headers"];
    // The whole subtree is withheld from the generic walk, so no header can be rehydrated
    // by a path this function did not decide on.
    handled.add(headersPath.join("\u0000"));

    const headers = readRecord(rawHeaders);
    const endpointMatches =
      restoredServerUrl(entry, localServer, name, redactedPaths) === readUrl(localServer);
    if (!headers || !endpointMatches) {
      edits.push({ path: headersPath, value: undefined });
      continue;
    }

    const localHeaders = readRecord(localServer?.headers) ?? {};
    // Names come from the document, not the parsed object, because `jsonc.parse` drops a
    // `__proto__` key while the text keeps it. Enumerating the parse result would leave that
    // header, and its marker, untouched in the restored file.
    const names = objectKeyNames(backupTree, ["servers", name, "headers"]);
    const restored: Record<string, unknown> = {};
    for (const headerName of names) {
      if (!Object.hasOwn(localHeaders, headerName)) continue;
      restored[headerName] = localHeaders[headerName];
    }

    if (names.length !== Object.keys(restored).length) {
      // Something has to go: a header with no local counterpart, a duplicate key, or a name
      // the parser hides. Replacing the whole value is the only edit that reliably removes
      // it, since `jsonc.modify` cannot address a key it cannot see.
      edits.push({ path: headersPath, value: restored });
      continue;
    }
    for (const [headerName, value] of Object.entries(restored)) {
      // Skipping an already-identical value keeps `jsonc.modify` from reformatting a header
      // the restore would not have changed.
      if (JSON.stringify(readOwn(headers, headerName)) === JSON.stringify(value)) continue;
      edits.push({ path: [...headersPath, headerName], value });
    }
  }
  return handled;
}

/**
 * Own key names as the document spells them. `jsonc.parse` drops a `__proto__` key while the
 * text keeps it, so a walk over the parse result cannot see, or edit, every key present.
 */
function objectKeyNames(tree: jsonc.Node | undefined, jsonPath: jsonc.JSONPath): string[] {
  if (!tree) return [];
  const node = jsonPath.length === 0 ? tree : jsonc.findNodeAtLocation(tree, jsonPath);
  if (node?.type !== "object") return [];
  return (node.children ?? []).flatMap((property) => {
    const key: unknown = property.children?.[0]?.value;
    return typeof key === "string" ? [key] : [];
  });
}

/**
 * Header and server names come from the backup, so a name like `constructor` would otherwise
 * read an `Object.prototype` member and hand a function to `jsonc.modify`.
 */
function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The url the restored entry ends up with, since a redacted url is itself put back from local. */
function restoredServerUrl(
  backupEntry: unknown,
  localServer: Record<string, unknown> | undefined,
  serverName: string,
  redactedPaths: ReadonlySet<string> | undefined
): string | undefined {
  const backupUrl = readUrl(readRecord(backupEntry));
  const localUrl = readUrl(localServer);
  if (
    backupUrl !== undefined &&
    isRedactedBackupValue(backupUrl, ["servers", serverName, "url"], redactedPaths) &&
    localUrl !== undefined
  ) {
    return localUrl;
  }
  return backupUrl;
}

function readUrl(server: Record<string, unknown> | undefined): string | undefined {
  const url = server?.url;
  return typeof url === "string" ? url : undefined;
}

/**
 * Structural, never `isPlainObject`: `jsonc.parse` assigns a `__proto__` key through the
 * prototype, so a polluted entry has a non-standard prototype but must stay visible here,
 * or its sibling keys (an executable `command`, a redacted header) escape scanning.
 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAnyServerCommand(value: unknown): string | undefined {
  const command = typeof value === "string" ? value : readRecord(value)?.command;
  return typeof command === "string" && command.trim() !== "" ? command : undefined;
}

interface RestorePlan {
  /** Resolved by the plan and reused for the writes, so the two cannot disagree on the tree. */
  root: BackupRoot;
  writes: Array<{ path: string; content: Buffer; executable: boolean }>;
  backupPreferences: unknown;
}

async function assertDirectoryAccepts(directory: string, relativePath: string): Promise<void> {
  try {
    await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`Cannot restore '${relativePath}': the destination is not writable`);
  }
}

/**
 * The write opens an existing destination `O_WRONLY` and otherwise creates it along with any
 * missing parent, so a readable-but-unwritable destination fails there instead of here, once
 * earlier entries of the same restore are already on disk. Probing the permission the write will
 * need keeps that refusal in the preflight, where nothing has changed yet.
 */
async function assertRestoreDestinationWritable(
  destination: string,
  existing: Stats | null,
  relativePath: string
): Promise<void> {
  let probe = destination;
  let mode = fs.constants.W_OK;
  if (existing !== null && existing.nlink > 1) {
    // A multi-link destination is severed by unlinking it, which the directory holding the name
    // has to permit, not the file itself.
    const directory = path.dirname(destination);
    await assertDirectoryAccepts(directory, relativePath);
    const dirStat = await fs.stat(directory);
    const uid = process.getuid?.();
    // Sticky directories let only root, the file owner, or the directory owner unlink an entry.
    if (
      (dirStat.mode & 0o1000) !== 0 &&
      uid !== undefined &&
      uid !== 0 &&
      existing.uid !== uid &&
      dirStat.uid !== uid
    ) {
      throw new Error(`Cannot restore '${relativePath}': the destination cannot be replaced`);
    }
  }
  if (existing === null) {
    // The write's mkdir is recursive, so the directory that has to accept the new entry is the
    // nearest one that already exists, which is not always the immediate parent.
    mode |= fs.constants.X_OK;
    probe = path.dirname(destination);
    while ((await lstatOrNull(probe)) === null) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    await fs.access(probe, mode);
  } catch {
    throw new Error(`Cannot restore '${relativePath}': the destination is not writable`);
  }
}

/**
 * Everything a restore can reject before it writes anything, so a path or a limit that
 * refuses the payload cannot leave a half-restored install behind. `BackupService.restore`
 * runs this ahead of the safety snapshot too: a refused restore changes nothing, so it must
 * not leave an unredacted copy of the local settings behind either.
 */
export async function planRestoreWrites(
  muxRoot: string,
  payload: BackupPayload
): Promise<RestorePlan> {
  assertBackupPathLimits(payload.files.map((file) => file.path));
  const root = await resolveRoot(muxRoot);
  let backupPreferences: unknown;
  const writes: RestorePlan["writes"] = [];
  const claimed = new Set<string>();
  // Restoring rehydrates local values into repository-controlled text, so what gets written is
  // not what was read and bounded. A payload made of markers is small however many large local
  // values it asks for, so the result is charged to the same budget as any other backup byte.
  const budget = createByteBudget();
  for (const file of payload.files) {
    if (file.path === "preferences.json") {
      // Projected here so a document the merge would reject cannot reach the write loop, but
      // kept unmerged: the merge belongs to the config edit, against the config as it is when
      // that edit runs rather than as it was before the restore.
      const parsed: unknown = JSON.parse(file.content.toString("utf-8"));
      projectBackupPreferences(parsed);
      backupPreferences = parsed;
      continue;
    }
    const destination = await resolveContainedPath(root.path, file.path);
    const existing = await lstatOrNull(destination);
    if (existing?.isDirectory() === true) {
      throw new Error(`Cannot restore '${file.path}': a directory already exists there`);
    }
    if (existing !== null && !existing.isFile()) {
      throw new Error(`Cannot restore '${file.path}': a non-regular file already exists there`);
    }
    await assertRestoreDestinationWritable(destination, existing, file.path);
    if (existing !== null && existing.nlink <= 1) {
      const { base, next } = restoredPermissions(
        existing.mode,
        file.executable === true,
        isOwnerOnlyPayloadPath(file.path)
      );
      if (next !== base) {
        const uid = process.getuid?.();
        if (uid !== undefined && uid !== 0 && existing.uid !== uid) {
          throw new Error(
            `Cannot restore '${file.path}': the destination's permissions cannot be changed`
          );
        }
      }
    }
    // Folding the path catches the pair a case-insensitive or normalizing volume would merge,
    // which no filesystem here can be asked about because neither name exists yet: both entries
    // would write the same bytes and the last would decide what both names hold.
    //
    // Destinations that are already one file (hard links) are not refused. Collection publishes
    // every such name deliberately, so refusing here made a push this same install could not
    // then preview or restore. `openSeveredWriteHandle` unlinks a destination whose `nlink`
    // exceeds one and recreates it, so each entry ends up at its own inode holding exactly what
    // the backup recorded, which is the same outcome the refusal was protecting.
    const claim = collisionKey(destination);
    if (claimed.has(claim)) {
      throw new Error(`Cannot restore '${file.path}': another entry resolves to the same file`);
    }
    claimed.add(claim);
    const content = await resolveRestoredContent(root.path, file, payload.manifest.mcpRedactions);
    budget(file.path, content.byteLength);
    writes.push({ path: file.path, content, executable: file.executable === true });
  }
  return { root, writes, backupPreferences };
}

export async function restoreBackupPayload(
  options: RestoreBackupPayloadOptions
): Promise<RestoreBackupPayloadResult> {
  const localPaths = new Set(
    (await collectAllowlistedFiles(options.muxRoot)).map((file) => file.path)
  );
  const restoredPaths = new Set(
    options.payload.files
      .filter((file) => file.path !== "preferences.json")
      .map((file) => file.path)
  );
  // Recomputed here rather than trusted from the preview, so an approval cannot authorize
  // a command the repository changed between the preview and this restore.
  assertBackupCommandsApproved(
    await collectMcpCommandApprovals(
      options.muxRoot,
      options.payload.files,
      options.payload.manifest.mcpRedactions
    ),
    options.approvedCommandTokens
  );

  const plan = await planRestoreWrites(options.muxRoot, options.payload);
  // Classify against the pre-restore filesystem state before writes change file identities.
  const { localOnly } = await localOnlyPayloadFiles(options.muxRoot, localPaths, restoredPaths);

  for (const write of plan.writes) {
    await writeCheckedFile(plan.root, write.path, write.content, write.executable, {
      ownerOnly: isOwnerOnlyPayloadPath(write.path),
    });
  }

  return { backupPreferences: plan.backupPreferences, localOnlyFiles: localOnly };
}

// ---------------------------------------------------------------------------
// Project bundle: the opt-in `project-bundle/` sidecar carrying the project
// list and per-project memories. Kept out of the core manifest for downgrade
// safety (see PROJECT_BUNDLE_DIR); every function here validates with its own
// bundle-scoped allowlist and byte budget so a bundle can neither smuggle a
// path past the core allowlist nor starve a core-only read.
// ---------------------------------------------------------------------------

export interface BackupProjectBundle {
  manifest: BackupProjectBundleManifest;
  files: BackupFile[];
}

/** Bundle files live only under `memory/project/<dir>/...`, so at least four segments. */
function assertAllowedBundleFilePath(
  relativePath: string,
  options: { portable: boolean } = { portable: true }
): void {
  const segments = relativePath.split("/");
  // The memory directory segment is derived from the project's basename, which may itself
  // start with a dot (`~/.dotfiles` → `.dotfiles-<hash>`), so the hidden-name rule does not
  // apply to it; it is held to its own charset and hash rules by assertValidBundleEntryDir
  // and must equal a listed entry's directory exactly. `.`/`..` still fail the shape check.
  const memoryDir = segments[2] ?? "";
  const shapeChecked = [
    ...segments.slice(0, 2),
    /^\.{1,2}$/.test(memoryDir) ? memoryDir : memoryDir.replace(/^\./, "_"),
    ...segments.slice(3),
  ].join("/");
  if (
    !relativePath.startsWith(PROJECT_MEMORY_PATH_PREFIX) ||
    segments.length < 4 ||
    hasDisallowedPathShape(shapeChecked, options)
  ) {
    throw new Error(`Backup project bundle contains disallowed path '${relativePath}'`);
  }
}

/**
 * A recorded memory directory name is repository-controlled, so it is held to the safe
 * charset `projectMemoryDirName` emits and its hash suffix must match the entry's own
 * project path. Deliberately NOT full `projectMemoryDirName(entry.path)` equality: the
 * sanitized basename half is derived from the source machine's path syntax, so a Windows
 * export legitimately disagrees with a POSIX recomputation, while the pure string hash is
 * host-independent. Restore destinations are always recomputed locally either way.
 */
function assertValidBundleEntryDir(entry: BackupProjectBundleEntry): void {
  const { memoryDir } = entry;
  // A leading dot is legitimate here (a `.dotfiles` project); `.` and `..` cannot pass the
  // hash-suffix rule below.
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(memoryDir) ||
    isForbiddenBasename(memoryDir) ||
    isWindowsUnusableSegment(memoryDir) ||
    !memoryDir.endsWith(`-${projectPathHashSuffix(entry.path)}`) ||
    !/[0-9a-f]{12}$/.test(memoryDir)
  ) {
    throw new Error(
      `Backup project bundle entry '${entry.path}' has an invalid memory directory name`
    );
  }
}

/** The memory directory segment of a bundle file path, exactly as spelled. */
function bundleFileDirSegment(relativePath: string): string {
  return relativePath.split("/")[2] ?? "";
}

export function bundleEntryFiles(
  files: readonly BackupFile[],
  entry: BackupProjectBundleEntry
): BackupFile[] {
  // Exact spelling, not the collision-folded key: a matched restore writes these paths
  // verbatim, so a case- or normalization-variant directory would land files where the
  // project's memory store never reads them. Reading rejects such files outright.
  const prefix = `${PROJECT_MEMORY_PATH_PREFIX}${entry.memoryDir}/`;
  return files.filter((file) => file.path.startsWith(prefix));
}

/**
 * Collects the memory directories of the given project entries from the local Xum root.
 * Per entry rather than a blind `memory/project` sweep, so orphaned directories of deleted
 * projects stay local. Entries must already carry their locally computed memory dir names.
 */
export async function collectProjectBundle(
  muxRoot: string,
  entries: readonly BackupProjectBundleEntry[],
  options: { portableMemoryOnly?: boolean } = {}
): Promise<BackupProjectBundle> {
  if (entries.length > MAX_BACKUP_PROJECT_ENTRIES) {
    throw new Error(`Backup has more than ${MAX_BACKUP_PROJECT_ENTRIES} projects`);
  }
  const seenPaths = new Set<string>();
  const seenDirs = new Set<string>();
  for (const entry of entries) {
    // Local entries come from projectMemoryDirName, so these are impossible-condition
    // checks on the export side; the same validation guards the read side for real.
    assertValidBundleEntryDir(entry);
    if (seenPaths.has(entry.path)) {
      throw new Error(`Backup project bundle lists '${entry.path}' twice`);
    }
    seenPaths.add(entry.path);
    const dirKey = collisionKey(entry.memoryDir);
    if (seenDirs.has(dirKey)) {
      throw new Error(`Backup project bundle reuses memory directory '${entry.memoryDir}'`);
    }
    seenDirs.add(dirKey);
  }

  const root = await resolveRoot(muxRoot);
  const collector = createBackupFileCollector(root);
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    await collector.collectDirectory(
      `${PROJECT_MEMORY_PATH_PREFIX}${entry.memoryDir}`,
      () => true,
      // Exports skip what the memory subsystem itself could not have produced or cannot
      // read — files past its size limit and files beyond its per-scope count: bundling
      // them would produce a backup this build's own restore rejects. Snapshots keep
      // full fidelity so an overwritten oversized local file stays recoverable.
      options.portableMemoryOnly === true
        ? { maxFileBytes: MEMORY_MAX_FILE_BYTES, maxFiles: MEMORY_MAX_FILES_PER_SCOPE }
        : {}
    );
  }
  collector.assertHardLinksContained();
  // The executable bit is dropped on purpose: memory files are notes, and the bundle
  // manifest does not record modes, so restores always land them non-executable.
  const files = collector.files
    .map((file) => ({ path: file.path, content: file.content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest: {
      schemaVersion: 1,
      projects: sorted.map((entry) => ({
        path: entry.path,
        name: entry.name,
        ...(entry.gitRemote !== undefined ? { gitRemote: entry.gitRemote } : {}),
        memoryDir: entry.memoryDir,
      })),
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
    },
    files,
  };
}

/**
 * Writes the bundle into its sidecar directory. No manifest-reuse dance like the core
 * writer needs: the bundle manifest has no volatile metadata, and its arrays are sorted,
 * so identical content serializes to identical bytes and never forces a no-op commit.
 */
export async function writeProjectBundle(
  destinationDir: string,
  bundle: BackupProjectBundle,
  options: { portable?: boolean; ownerOnly?: boolean } = {}
): Promise<void> {
  const portable = options.portable !== false;
  const ownerOnly = options.ownerOnly === true;
  // The same schema the reader enforces, so an entry this install generated but no build
  // can read back (a registered path past the manifest's cap) fails the export here, not
  // the next restore.
  const manifestCheck = BackupProjectBundleManifestSchema.safeParse(bundle.manifest);
  if (!manifestCheck.success) {
    throw new Error(
      `Cannot back up the project list: ${manifestCheck.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  assertBackupFileCount(bundle.files.length);
  assertBackupPathComplexity(bundle.files.map((file) => file.path));
  for (const file of bundle.files) assertAllowedBundleFilePath(file.path, { portable });
  for (const file of bundle.manifest.files) assertAllowedBundleFilePath(file.path, { portable });
  const claimed = new Set<string>();
  for (const file of bundle.files) {
    const claim = portable ? collisionKey(file.path) : file.path;
    if (claimed.has(claim)) throw new Error(`Duplicate backup path '${file.path}'`);
    claimed.add(claim);
  }
  const manifestJson = serializeProjectBundleManifest(bundle.manifest).toString("utf-8");
  // Bound what is published so a bundle that writes is never one every later read rejects.
  const budget = createByteBudget();
  budget(BACKUP_MANIFEST_FILE, Buffer.byteLength(manifestJson, "utf-8"));
  for (const file of bundle.files) budget(file.path, file.content.length);

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true, ...(ownerOnly ? { mode: 0o700 } : {}) });
  const root = await resolveRoot(destinationDir);
  for (const file of bundle.files) {
    await resolveContainedPath(root.path, file.path);
    await writeCheckedFile(root, file.path, file.content, false, { ownerOnly });
  }
  await writeCheckedFile(root, BACKUP_MANIFEST_FILE, Buffer.from(manifestJson, "utf-8"), false, {
    ownerOnly,
  });
}

/** The bytes `writeProjectBundle` publishes for the manifest; exported so the secret scan sees them too. */
export function serializeProjectBundleManifest(manifest: BackupProjectBundleManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** Where the bundle manifest lands relative to the managed path. */
export const PROJECT_BUNDLE_MANIFEST_PATH = `${PROJECT_BUNDLE_DIR}/${BACKUP_MANIFEST_FILE}`;

/**
 * The checkout side bounds the whole managed tree — core payload, bundle, both manifests —
 * with one file-count, byte, and path-complexity limit set, while export budgets the two
 * halves independently. An export both halves accept individually can still exceed the
 * combined limits, so it is measured here exactly as the next checkout will measure it.
 */
export async function assertManagedTreeWithinLimits(destinationDir: string): Promise<void> {
  const entries = await fs.readdir(destinationDir, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile());
  assertBackupFileCount(files.length);
  const relativePaths = files.map((entry) =>
    path.relative(destinationDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
  );
  assertBackupPathComplexity(relativePaths);
  const budget = createByteBudget();
  for (const [index, entry] of files.entries()) {
    const stat = await fs.lstat(path.join(entry.parentPath, entry.name));
    budget(relativePaths[index] ?? entry.name, stat.size);
  }
}

/**
 * Existence is checked without parsing, so a malformed sidecar can be reported as present
 * while `includeProjects` is off without ever blocking a core-only restore on its contents.
 * "Present" is anything at the sidecar path: a symlink or a stray file there is a bundle
 * the full read refuses, and the toggle-off report should say so rather than "none".
 */
export async function projectBundleExists(sourceDir: string): Promise<boolean> {
  // lstat, never stat: on hosts where git materializes symlinks, a crafted sidecar pointing
  // at a UNC path would otherwise be followed here — reached even with project backup off —
  // and Windows would start SMB authentication.
  return (await lstatIfExists(path.join(sourceDir, PROJECT_BUNDLE_DIR))) !== null;
}

function parseProjectBundleManifest(raw: string): BackupProjectBundleManifest {
  const tree = jsonc.parseTree(raw);
  if (!tree) throw new Error("Invalid backup project bundle manifest");
  assertNoDuplicateKeys(tree, "backup project bundle manifest");
  const value: unknown = JSON.parse(raw);
  // Array lengths are bounded before the per-entry schema runs, as the core manifest parser
  // does: a manifest-sized array of tiny valid entries would otherwise be fully validated
  // and copied before the file-count check ever ran.
  if (!isPlainObject(value) || !Array.isArray(value.files) || !Array.isArray(value.projects)) {
    throw new Error("Invalid backup project bundle manifest");
  }
  assertBackupFileCount(value.files.length);
  if (value.projects.length > MAX_BACKUP_PROJECT_ENTRIES) {
    throw new Error(`Backup has more than ${MAX_BACKUP_PROJECT_ENTRIES} projects`);
  }
  const parsed = BackupProjectBundleManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid backup project bundle manifest");
  return {
    ...parsed.data,
    // Remotes are display-only hints; a shape the sanitizer refuses is dropped rather
    // than failing the whole bundle, and the import token binds the normalized entry.
    projects: parsed.data.projects.map((entry) => {
      const gitRemote =
        entry.gitRemote === undefined ? undefined : sanitizeBackupGitRemote(entry.gitRemote);
      return {
        path: entry.path,
        name: entry.name,
        ...(gitRemote !== undefined ? { gitRemote } : {}),
        memoryDir: entry.memoryDir,
      };
    }),
  };
}

/**
 * Reads and fully validates the sidecar, or returns null when the backup carries none.
 * Callers gate this on `includeProjects`: with the toggle off the sidecar is never parsed,
 * so a malformed bundle cannot block a core-only restore.
 *
 * "None" means nothing at the sidecar path. Anything else there — a symlink, a file, a
 * directory without its manifest — is a bundle the read below refuses: reading it as absent
 * would apply the core restore while silently omitting every backed-up project.
 */
export async function readProjectBundle(
  sourceDir: string,
  options: { portable?: boolean } = {}
): Promise<BackupProjectBundle | null> {
  if (!(await projectBundleExists(sourceDir))) return null;
  try {
    return await readProjectBundleUnchecked(sourceDir, options.portable !== false);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    throw new BackupInvalidPayloadError(error);
  }
}

async function readProjectBundleUnchecked(
  sourceDir: string,
  portable: boolean
): Promise<BackupProjectBundle> {
  // Contained resolution first: a symlinked `project-bundle` in a crafted repository must
  // be refused before resolveRoot would canonicalize straight through it.
  const bundleDir = await resolveContainedPath(sourceDir, PROJECT_BUNDLE_DIR);
  const budget = createByteBudget();
  const root = await resolveRoot(bundleDir);
  await resolveContainedPath(root.path, BACKUP_MANIFEST_FILE);
  // Explicit, so a sidecar directory without its manifest is an invalid bundle rather than
  // an ENOENT surfacing as an I/O failure.
  if ((await lstatIfExists(path.join(root.path, BACKUP_MANIFEST_FILE)))?.isFile() !== true) {
    throw new Error("Backup project bundle has no manifest");
  }
  const manifestRaw = await readCheckedFile(root, BACKUP_MANIFEST_FILE, (size) => {
    budget(BACKUP_MANIFEST_FILE, size);
  });
  const manifest = parseProjectBundleManifest(manifestRaw.content.toString("utf-8"));

  const entryDirKeys = new Set<string>();
  const entryDirs = new Set<string>();
  const entryPaths = new Set<string>();
  for (const entry of manifest.projects) {
    assertValidBundleEntryDir(entry);
    if (entryPaths.has(entry.path)) {
      throw new Error(`Backup project bundle lists '${entry.path}' twice`);
    }
    entryPaths.add(entry.path);
    const dirKey = collisionKey(entry.memoryDir);
    if (entryDirKeys.has(dirKey)) {
      throw new Error(`Backup project bundle reuses memory directory '${entry.memoryDir}'`);
    }
    entryDirKeys.add(dirKey);
    entryDirs.add(entry.memoryDir);
  }

  assertBackupFileCount(manifest.files.length);
  assertBackupPathComplexity(manifest.files.map((file) => file.path));
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    assertAllowedBundleFilePath(manifestFile.path, { portable });
    // Exact directory spelling: `bundleEntryFiles` associates by exact prefix, so a
    // case- or normalization-variant of a listed directory would otherwise be a file no
    // entry owns — accepted, never restored, and invisible to the import token.
    if (!entryDirs.has(bundleFileDirSegment(manifestFile.path))) {
      throw new Error(
        `Backup project bundle file '${manifestFile.path}' does not belong to a listed project`
      );
    }
    const key = portable ? collisionKey(manifestFile.path) : manifestFile.path;
    if (seen.has(key)) throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(key);
    const content = await readManifestEntry(root, manifestFile.path, budget);
    if (sha256(content) !== manifestFile.sha256) {
      throw new Error(`Backup checksum mismatch for '${manifestFile.path}'`);
    }
    files.push({ path: manifestFile.path, content });
  }
  return { manifest, files };
}

/**
 * Binds an import approval to the exact entry and content it was shown for. JSON with a
 * fixed key order, so no delimiter ambiguity; any change to the entry's metadata or to one
 * of its memory files between preview and restore produces a different token and forces
 * re-approval.
 */
export function projectImportToken(
  entry: BackupProjectBundleEntry,
  files: readonly BackupFile[]
): string {
  const contentHashes = bundleEntryFiles(files, entry)
    .map((file) => [file.path, sha256(file.content)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(
    Buffer.from(
      JSON.stringify([
        1,
        {
          path: entry.path,
          name: entry.name,
          gitRemote: entry.gitRemote ?? null,
          memoryDir: entry.memoryDir,
        },
        contentHashes,
      ]),
      "utf-8"
    )
  );
}

/**
 * A bundle entry the restore writes without approval, and the local project it writes to.
 * `projectPath`/`localMemoryDir` equal the entry's own path/dir for a project registered at
 * its recorded path, and the import target's for a project brought in by an earlier import.
 */
export interface MatchedProjectEntry {
  entry: BackupProjectBundleEntry;
  files: BackupFile[];
  projectPath: string;
  localMemoryDir: string;
}

export interface ProjectBundleRestorePlan {
  /** Entries with a local project identity: restored verbatim into that project's memory. */
  matched: MatchedProjectEntry[];
  /** Everything else: never written without an explicit per-entry import approval. */
  imports: Array<{ entry: BackupProjectBundleEntry; files: BackupFile[]; token: string }>;
}

/** The local project an earlier import created for a recorded source path. */
export interface ProjectMemoryOrigin {
  projectPath: string;
  memoryDir: string;
}

/**
 * Partitions bundle entries against the projects registered on this machine. The caller
 * supplies `registeredDirByPath` as project path → locally computed memory dir name, so a
 * match asserts both "registered at exactly this path" and "the recorded dir name is the
 * one this host computes" — a foreign-OS source path with a correct hash suffix falls
 * through to an import candidate rather than being rejected or silently written.
 * `origins` (recorded source path → local project) lets a project imported under another
 * path keep receiving updates on later restores; without it every restore after an import
 * would re-offer the project as an add-only candidate that can never update a file.
 */
export function planProjectBundleRestore(
  bundle: BackupProjectBundle,
  registeredDirByPath: ReadonlyMap<string, string>,
  origins: ReadonlyMap<string, ProjectMemoryOrigin> = new Map()
): ProjectBundleRestorePlan {
  const plan: ProjectBundleRestorePlan = { matched: [], imports: [] };
  // One local project receives at most one entry: a project recorded directly at a path
  // that an earlier import also targets would otherwise merge two entries' notes into one
  // memory scope. The exact-path match wins; the colliding entry is re-offered as an import.
  const claimed = new Set<string>();
  const localIdentity = (entry: BackupProjectBundleEntry): ProjectMemoryOrigin | null => {
    if (registeredDirByPath.get(entry.path) === entry.memoryDir) {
      return { projectPath: entry.path, memoryDir: entry.memoryDir };
    }
    const origin = origins.get(entry.path);
    // The origin's project must still be registered with the dir name this host computes;
    // a stale marker under an unregistered or renamed directory falls back to an import.
    return origin !== undefined && registeredDirByPath.get(origin.projectPath) === origin.memoryDir
      ? origin
      : null;
  };
  const entries = bundle.manifest.projects.map((entry) => ({ entry, local: localIdentity(entry) }));
  for (const { entry, local } of entries) {
    if (local !== null && local.projectPath === entry.path) claimed.add(local.projectPath);
  }
  for (const { entry, local } of entries) {
    const files = bundleEntryFiles(bundle.files, entry);
    const viaOrigin = local !== null && local.projectPath !== entry.path;
    if (local !== null && (!viaOrigin || !claimed.has(local.projectPath))) {
      claimed.add(local.projectPath);
      plan.matched.push({
        entry,
        files,
        projectPath: local.projectPath,
        localMemoryDir: local.memoryDir,
      });
      continue;
    }
    plan.imports.push({ entry, files, token: projectImportToken(entry, bundle.files) });
  }
  return plan;
}

/** A matched entry's files addressed to the local project's memory directory. */
export function matchedProjectWrites(
  match: MatchedProjectEntry
): Array<{ path: string; content: Buffer }> {
  return match.files.map((file) => ({
    path: rekeyProjectMemoryPath(file.path, match.localMemoryDir),
    content: file.content,
  }));
}

/**
 * Markers recording which local project an imported source lives in, as a pair of records
 * that must agree: one keyed by the recorded source path (hashed) and one keyed by the local
 * memory directory (hashed), each naming the other. A source has one record and a project has
 * one record, so importing a source elsewhere or importing another source into the same
 * project each replace exactly one record and thereby invalidate the association it
 * superseded — the newest explicit association is the only one both sides confirm — and a
 * restore locates a source's association in two reads, never by scanning the directory.
 * Kept in `memory/.backup-origins/` — beside, not inside, the project scopes — so no memory
 * path a user or agent can address through MemoryService collides with it, and the core
 * allowlist (which collects only `memory/global`) never exports it. Needs no config schema.
 */
const PROJECT_MEMORY_ORIGINS_DIR = "memory/.backup-origins";
/**
 * Bound on a marker's bytes, aligned with what the writer can produce: a schema-capped
 * 1024-character source path fully `\uXXXX`-escaped (6144 bytes), a 64-character memory
 * directory name, and the JSON framing.
 */
const MAX_PROJECT_MEMORY_ORIGIN_BYTES = 8192;

function projectMemoryOriginPath(sourcePath: string): string {
  return `${PROJECT_MEMORY_ORIGINS_DIR}/${sha256(Buffer.from(sourcePath, "utf-8")).slice(0, 32)}.json`;
}

function projectMemoryOriginTargetPath(localMemoryDir: string): string {
  return `${PROJECT_MEMORY_ORIGINS_DIR}/target-${sha256(Buffer.from(localMemoryDir, "utf-8")).slice(0, 32)}.json`;
}

export async function writeProjectMemoryOrigin(
  muxRoot: string,
  localMemoryDir: string,
  sourcePath: string
): Promise<void> {
  const root = await resolveRoot(muxRoot);
  const content = Buffer.from(
    `${JSON.stringify({ sourcePath, memoryDir: localMemoryDir })}\n`,
    "utf-8"
  );
  // The reader's cap, checked before writing: an import must not report success with a
  // marker no later restore will read.
  if (content.length > MAX_PROJECT_MEMORY_ORIGIN_BYTES) {
    throw new Error("Cannot record the imported project's origin: the marker is too large");
  }
  // Two files cannot change atomically, so the order decides what a crash between the two
  // writes leaves behind. The project's record goes first and the source's record is the
  // commit point: until it is replaced, the source's previous association (if any) still has
  // both of its halves untouched and stays confirmed, and the project's new record names a
  // source that does not point back — a claim nothing confirms, exactly like a project whose
  // source was imported elsewhere. The other order would void the previous association
  // first, and no crash-recovery rule on the source's record can tell an incomplete write
  // from a completed association that another import into the same project superseded.
  // The project's record was the half the import's memory write had already committed to.
  //
  // What such a crash does cost is the project's own previous association, if it had one:
  // its record now names the new source, so its previous source is re-offered as an import
  // on the next restore, its files intact in the project (an add-only re-import restores the
  // association). That is deliberate. Recording the previous source for recovery would need
  // a reader to tell "the new pair never committed" from "it committed and the source later
  // moved on", and the two files cannot say which — a crash after the commit but before any
  // cleanup of that recovery state looks identical — so the recovered association could be
  // one a completed import had superseded, and a matched restore would then overwrite the
  // project's memory without approval. The records fail toward an explicit re-import, never
  // toward a match nobody approved.
  const targetRecord = projectMemoryOriginTargetPath(localMemoryDir);
  const previousTarget = await readProjectMemoryOriginRecordBytes(root, targetRecord);
  await writeProjectMemoryOriginRecord(root, targetRecord, content);
  try {
    await writeProjectMemoryOriginRecord(root, projectMemoryOriginPath(sourcePath), content);
  } catch (error) {
    // Put the project's record back so a failed import does not void the association the
    // project had before it. Best effort under the same I/O conditions that failed the write;
    // if it fails too, the reader confirms neither half rather than a wrong one.
    if (previousTarget === "absent") {
      await fs.rm(absolutePathOf(root.path, targetRecord), { force: true }).catch(() => undefined);
    } else if (previousTarget !== "unreadable") {
      await writeProjectMemoryOriginRecord(root, targetRecord, previousTarget).catch(
        () => undefined
      );
    }
    throw error;
  }
}

/**
 * A record's current bytes for putting it back, `"absent"` when there is none, and
 * `"unreadable"` when it exists but cannot be read — in which case nothing can be restored,
 * and the caller leaves the new record in place for the reader to refuse.
 */
async function readProjectMemoryOriginRecordBytes(
  root: BackupRoot,
  relativePath: string
): Promise<Buffer | "absent" | "unreadable"> {
  if ((await lstatIfExists(absolutePathOf(root.path, relativePath))) === null) return "absent";
  try {
    return (
      await readCheckedFile(root, relativePath, (size) => {
        if (size > MAX_PROJECT_MEMORY_ORIGIN_BYTES) throw new Error("origin marker too large");
      })
    ).content;
  } catch {
    return "unreadable";
  }
}

async function writeProjectMemoryOriginRecord(
  root: BackupRoot,
  relativePath: string,
  content: Buffer
): Promise<void> {
  const staging = `${relativePath}.tmp`;
  // Contained and then written through the checked writer, like every other file a restore
  // lands: `.backup-origins` or the marker itself left behind as a symlink (a copied or
  // corrupted Xum home) would otherwise be followed, and an approved import would replace a
  // file outside the memory tree with backup-controlled JSON.
  await resolveContainedPath(root.path, relativePath);
  await resolveContainedPath(root.path, staging);
  // Staged beside the record and renamed over it, so a record is replaced only by a complete
  // replacement: a write that fails midway (disk full) leaves the old record as it was.
  try {
    await writeCheckedFile(root, staging, content, false);
    await fs.rename(absolutePathOf(root.path, staging), absolutePathOf(root.path, relativePath));
  } catch (error) {
    await fs.rm(absolutePathOf(root.path, staging), { force: true }).catch(() => undefined);
    throw error;
  }
}

interface ProjectMemoryOriginRecord {
  sourcePath: string;
  memoryDir: string;
}

function parseProjectMemoryOriginRecord(content: Buffer): ProjectMemoryOriginRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { sourcePath, memoryDir } = parsed;
  if (
    typeof sourcePath !== "string" ||
    sourcePath === "" ||
    typeof memoryDir !== "string" ||
    memoryDir === ""
  ) {
    return null;
  }
  return { sourcePath, memoryDir };
}

/** A record's fields, or null for a missing, unreadable, refused, or malformed one. */
async function readProjectMemoryOriginRecord(
  root: BackupRoot,
  relativePath: string
): Promise<ProjectMemoryOriginRecord | null> {
  try {
    // The checked reader refuses a symlinked directory or record the same way the writer
    // does, so a planted link cannot re-point a project at another source.
    const { content } = await readCheckedFile(root, relativePath, (size) => {
      if (size > MAX_PROJECT_MEMORY_ORIGIN_BYTES) throw new Error("origin marker too large");
    });
    return parseProjectMemoryOriginRecord(content);
  } catch {
    return null;
  }
}

/**
 * Recorded source path → local project, for the given sources (a bundle's entries) whose
 * association a currently registered project confirms from its side. Bounded by the sources
 * asked about, never by how many records have accumulated.
 */
export async function readProjectMemoryOrigins(
  muxRoot: string,
  registeredDirByPath: ReadonlyMap<string, string>,
  sourcePaths: Iterable<string>
): Promise<Map<string, ProjectMemoryOrigin>> {
  const root = await resolveRoot(muxRoot);
  // Memory dir → registered project. Two registered projects computing one dir name is all
  // but impossible (the name carries a hash of the path); should it happen, the dir names
  // neither, since the record could not say which project it meant.
  const projectByDir = new Map<string, string | null>();
  for (const [projectPath, memoryDir] of registeredDirByPath) {
    projectByDir.set(memoryDir, projectByDir.has(memoryDir) ? null : projectPath);
  }
  const origins = new Map<string, ProjectMemoryOrigin>();
  for (const sourcePath of new Set(sourcePaths)) {
    const claim = await readProjectMemoryOriginRecord(root, projectMemoryOriginPath(sourcePath));
    // Each file is named by a hash of one field; the recorded fields have to agree with the
    // name and with each other, or the record is not this association's (a hand-placed or
    // corrupted file, or a superseded half).
    if (claim?.sourcePath !== sourcePath) continue;
    // The project's own record must name this source back: a project imported into again
    // from another source names that source now, and the older claim on it is void even
    // though the older source's record still exists. There is no fallback from an
    // unconfirmed claim to an earlier association: the writer's order (see
    // writeProjectMemoryOrigin) keeps an earlier association's own two halves intact until
    // the new pair is complete, so it is found here directly or not at all.
    const target = await readProjectMemoryOriginRecord(
      root,
      projectMemoryOriginTargetPath(claim.memoryDir)
    );
    if (target?.sourcePath !== sourcePath || target.memoryDir !== claim.memoryDir) continue;
    const projectPath = projectByDir.get(claim.memoryDir);
    if (projectPath == null) continue;
    origins.set(sourcePath, { projectPath, memoryDir: claim.memoryDir });
  }
  return origins;
}

/** `memory/project/<recorded>/rest` re-keyed to the locally computed target directory. */
export function rekeyProjectMemoryPath(bundlePath: string, targetDirName: string): string {
  const segments = bundlePath.split("/");
  return [segments[0], segments[1], targetDirName, ...segments.slice(3)].join("/");
}

/**
 * Carries the files a failed project-memory write had already created: the writes are
 * sequential without rollback, so the caller's failure report must include the partial
 * progress as the user's cleanup list instead of claiming nothing was written.
 */
export class ProjectMemoryWriteError extends Error {
  readonly written: string[];
  readonly skipped: string[];

  constructor(
    message: string,
    progress: { written: string[]; skipped: string[] },
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ProjectMemoryWriteError";
    this.written = progress.written;
    this.skipped = progress.skipped;
  }
}

/**
 * A matched-memory restore that failed after some entries were written. The service's
 * change notification runs on the success path, so the failure must carry the projects
 * whose memory already changed or an open memory browser keeps showing stale contents.
 */
export class ProjectMemoryRestoreError extends Error {
  readonly restoredProjectMemory: Array<{ projectPath: string; files: string[] }>;

  constructor(
    message: string,
    restoredProjectMemory: Array<{ projectPath: string; files: string[] }>,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ProjectMemoryRestoreError";
    this.restoredProjectMemory = restoredProjectMemory;
  }
}

/**
 * Regular files under a directory as MemoryService counts them for its per-scope cap:
 * dot-prefixed entries (and anything beneath one) are invisible to the memory store, so
 * counting them here would refuse a note the store itself would still create. The walk
 * stops as soon as the count exceeds `limit`, so an externally bloated scope cannot make the
 * preflight materialize its whole tree just to learn it is over the limit.
 */
async function countFilesUnder(dirAbs: string, limit: number): Promise<number> {
  let count = 0;
  const pending = [dirAbs];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    // A missing scope directory counts as empty rather than failing the restore. Nothing
    // else does: a directory that exists but cannot be read (permissions changed) would
    // otherwise pass the preflight and fail the write after the core settings changed.
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) return [];
      throw error;
    });
    for (const entry of entries) {
      if (isHiddenName(entry.name)) continue;
      // Dirent reports a symlink as neither file nor directory, so links are not followed.
      if (entry.isDirectory()) {
        pending.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count += 1;
        if (count > limit) return count;
      }
    }
  }
  return count;
}

/**
 * Writes project memory files into the local Xum root. `addOnly: true` is the import mode:
 * an identical existing file is fine, a differing one is skipped and reported as a conflict
 * rather than overwritten unpreviewed. `addOnly: false` is the matched-restore mode, where
 * overwriting is exactly what the previewed plan promised. Identical files are never
 * rewritten in either mode, so `written` doubles as the changed-files report.
 *
 * Callers own the memory mutation lock: this function must run inside
 * `withTargetMutationLock` on the memory root so backup never becomes an uncoordinated
 * memory writer, and the conflict checks here are the required re-check under that lock.
 */
export async function writeProjectMemoryFiles(
  muxRoot: string,
  writes: ReadonlyArray<{ path: string; content: Buffer }>,
  options: { addOnly: boolean }
): Promise<{ written: string[]; skipped: string[] }> {
  const root = await resolveRoot(muxRoot);
  // Re-run under the lock even when the caller already ran it as a preflight: the
  // destinations may have changed since, and these checks are what make the write safe.
  const planned = await planProjectMemoryWrites(root, writes, options);
  const written: string[] = [];
  const skipped: string[] = [];
  try {
    for (const write of planned) {
      if (write.action === "identical") continue;
      if (write.action === "conflict") {
        skipped.push(write.path);
        continue;
      }
      // Recorded before the mutating call: a write that fails midway (ENOSPC after the
      // destination was created or truncated) must still appear in the cleanup list.
      written.push(write.path);
      await writeCheckedFile(root, write.path, write.content, false);
    }
  } catch (error) {
    // Sequential writes without rollback: report what already landed, including the
    // attempted file, so the caller's failure result can double as the cleanup list.
    throw new ProjectMemoryWriteError(
      error instanceof Error ? error.message : String(error),
      { written, skipped },
      { cause: error }
    );
  }
  return { written, skipped };
}

/**
 * Everything about a set of project-memory writes that can be refused without touching the
 * disk: path shape, the memory subsystem's per-file size and per-scope count limits,
 * destinations that are not plain files, and destinations the write could not open.
 * Exposed so the restore preflight can refuse a bundle that would fail here before the
 * core restore has overwritten anything. `addOnly` must match the write it stands in for:
 * it decides which existing destinations are skipped and therefore need no permission.
 */
export async function assertProjectMemoryWritesAllowed(
  muxRoot: string,
  writes: ReadonlyArray<{ path: string; content: Buffer }>,
  options: { addOnly: boolean }
): Promise<void> {
  await planProjectMemoryWrites(await resolveRoot(muxRoot), writes, options);
}

interface PlannedProjectMemoryWrite {
  path: string;
  content: Buffer;
  /**
   * `write`: lands (new file, or an existing one this mode overwrites). `identical`: the
   * destination already holds these bytes. `conflict`: differs and add-only mode skips it.
   */
  action: "write" | "identical" | "conflict";
  isNew: boolean;
}

async function planProjectMemoryWrites(
  root: BackupRoot,
  writes: ReadonlyArray<{ path: string; content: Buffer }>,
  options: { addOnly: boolean }
): Promise<PlannedProjectMemoryWrite[]> {
  // Charged so a marker-thin bundle cannot expand past the same bound reads enforce.
  const budget = createByteBudget();
  // Everything refusable is refused before the first write, so a rejected bundle
  // changes nothing on disk.
  const planned: PlannedProjectMemoryWrite[] = [];
  for (const write of writes) {
    assertAllowedBundleFilePath(write.path);
    // The memory subsystem's own read limit: a restored file larger than this would be
    // persisted but permanently unreadable through memory commands, so it is refused
    // here rather than written as unusable state.
    if (write.content.length > MEMORY_MAX_FILE_BYTES) {
      throw new Error(
        `Cannot restore '${write.path}': larger than the ${MEMORY_MAX_FILE_BYTES}-byte memory file limit`
      );
    }
    budget(write.path, write.content.length);
    const destination = await resolveContainedPath(root.path, write.path);
    const existing = await lstatIfExists(destination);
    if (existing !== null && !existing.isFile()) {
      throw new Error(`Cannot restore '${write.path}': a non-file already exists there`);
    }
    let action: PlannedProjectMemoryWrite["action"] = "write";
    if (existing !== null) {
      // Sizes first, from the lstat: an existing file of a different size can never be
      // identical, so it is never read — an externally bloated destination would otherwise
      // be buffered whole just to detect a conflict. Equal sizes are bounded by the incoming
      // file's own memory limit. Decided here, once, so the writability probe below covers
      // exactly the destinations the write will open.
      if (
        existing.size === write.content.length &&
        (await readCheckedFile(root, write.path, () => undefined)).content.equals(write.content)
      ) {
        action = "identical";
      } else if (options.addOnly) {
        action = "conflict";
      }
    }
    // The same probe as the core restore's planner: a read-only destination or an
    // unwritable parent fails `writeCheckedFile` with the core settings already changed,
    // so the permission the write will need is checked while nothing has changed yet.
    if (action === "write")
      await assertRestoreDestinationWritable(destination, existing, write.path);
    planned.push({ path: write.path, content: write.content, action, isNew: existing === null });
  }
  // Per-scope file-count cap, mirrored from MemoryService. Only growth past the limit is
  // refused: a store that already exceeds it (hand-placed files) can still be restored
  // in place as long as this restore does not add to the overflow.
  const addsByDir = new Map<string, number>();
  for (const write of planned) {
    if (!write.isNew) continue;
    const scopeDir = write.path.split("/").slice(0, 3).join("/");
    addsByDir.set(scopeDir, (addsByDir.get(scopeDir) ?? 0) + 1);
  }
  for (const [scopeDir, adds] of addsByDir) {
    const existingCount = await countFilesUnder(
      path.join(root.path, scopeDir),
      MEMORY_MAX_FILES_PER_SCOPE
    );
    if (existingCount + adds > MEMORY_MAX_FILES_PER_SCOPE && adds > 0) {
      throw new Error(
        `Cannot restore '${scopeDir}': it would exceed the ${MEMORY_MAX_FILES_PER_SCOPE}-file memory limit`
      );
    }
  }
  return planned;
}

/**
 * A recovery copy of exactly the local files a matched restore may overwrite: the current
 * contents at the incoming bundle paths, and nothing else in the project's memory
 * directory. Collecting whole directories would let an unrelated local-only note — say,
 * one past the backup size budget — fail a restore that never touches it.
 */
export async function collectOverwritableProjectMemory(
  muxRoot: string,
  matched: readonly MatchedProjectEntry[]
): Promise<BackupProjectBundle> {
  const root = await resolveRoot(muxRoot);
  const budget = createByteBudget();
  const files: BackupFile[] = [];
  for (const match of matched) {
    for (const write of matchedProjectWrites(match)) {
      assertAllowedBundleFilePath(write.path);
      const destination = await resolveContainedPath(root.path, write.path);
      if ((await lstatOrNull(destination))?.isFile() !== true) continue;
      const current = await readCheckedFile(root, write.path, (size) => {
        budget(write.path, size);
      });
      files.push({ path: write.path, content: current.content });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Entries describe the LOCAL projects the copy came from, so the recovery copy's manifest
  // is consistent with its own file paths even for import-matched entries.
  const entries = [...matched].sort((a, b) => a.projectPath.localeCompare(b.projectPath));
  const manifest: BackupProjectBundleManifest = {
    schemaVersion: 1,
    projects: entries.map((match) => ({
      path: match.projectPath,
      name: match.entry.name,
      ...(match.entry.gitRemote !== undefined ? { gitRemote: match.entry.gitRemote } : {}),
      memoryDir: match.localMemoryDir,
    })),
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
  };
  // The writer charges the manifest against the same budget, so a preflight that skipped
  // it could pass a recovery copy the write would then refuse.
  budget(BACKUP_MANIFEST_FILE, serializeProjectBundleManifest(manifest).length);
  // And validates it against the same schema: a local project path or name the manifest
  // cannot record would otherwise refuse the restore only at the recovery write, after the
  // core snapshot. Imports cap their targets to keep this from arising; this is the check
  // that makes the preflight, not the write, the place it surfaces if it ever does.
  const manifestCheck = BackupProjectBundleManifestSchema.safeParse(manifest);
  if (!manifestCheck.success) {
    throw new Error(
      `Cannot snapshot project memory: ${manifestCheck.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return { manifest, files };
}
