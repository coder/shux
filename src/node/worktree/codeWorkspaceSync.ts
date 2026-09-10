import * as fsPromises from "fs/promises";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { isMultiProject } from "@/common/utils/multiProject";
import { isWorktreeRuntime, type RuntimeConfig } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { isPathInsideDir, stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getProjectName } from "@/node/utils/runtime/helpers";

/**
 * Opt-in sync of a VS Code `.code-workspace` file's `folders` list with a
 * project's active worktree workspaces (issue #3722), so users browsing in
 * VS Code / code-server see every xum worktree in one multi-root window.
 *
 * Managed-entry invariant: xum only ever adds or removes folder entries whose
 * resolved path lives under the project's managed worktree root
 * (`<srcDir>/<projectName>/`). Everything else in the file (user-added
 * folders, the project-root entry seeded on creation, `settings`,
 * `extensions`, comments) is never touched, reordered, or rewritten.
 */

export const CODE_WORKSPACE_EXTENSION = ".code-workspace";

// The target file can be repository- or user-controlled, and jsonc.parse is
// synchronous (no timeout can preempt it), so cap the bytes we are willing to
// read and parse. Real .code-workspace files are a few KiB.
export const MAX_CODE_WORKSPACE_FILE_BYTES = 1024 * 1024;
export const MAX_CODE_WORKSPACE_FOLDERS = 2_000;

// Bound each sync: a configured file on an unavailable network mount can hang
// fs calls indefinitely, and workspace lifecycle operations await syncs.
const SYNC_TIMEOUT_MS = 10_000;

// VS Code generates .code-workspace files with tab indentation; match it.
const MODIFY_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: { insertSpaces: false, tabSize: 4, eol: "\n" },
};

// Serialize read-modify-write per canonical file path: two projects may share
// one .code-workspace file, and concurrent lifecycle syncs would otherwise
// lose updates (the later write wins over a stale read).
const fileWriteQueues = new Map<string, Promise<void>>();

async function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileWriteQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail: Promise<void> = run
    .then(
      () => undefined,
      () => undefined
    )
    .then(() => {
      if (fileWriteQueues.get(key) === tail) {
        fileWriteQueues.delete(key);
      }
    });
  fileWriteQueues.set(key, tail);
  return run;
}

// Canonicalization of another project's configured path must never stall the
// current sync (its file may sit on a dead network mount), so realpath calls
// used for grouping are individually bounded.
const REALPATH_TIMEOUT_MS = 1_000;

async function boundedRealPath(filePath: string): Promise<string | null> {
  const outcome = await raceWithAbortAndTimeout(resolveRealPath(filePath), {
    timeoutMs: REALPATH_TIMEOUT_MS,
  });
  return outcome.kind === "ok" ? outcome.value : null;
}

// write-file-atomic renames a temp file over the target, which would replace a
// symlink rather than write through it; resolve the real target first so user
// symlinks to shared editor config survive syncs.
async function resolveRealPath(filePath: string): Promise<string> {
  return resolveRealPathFollowingDanglingLinks(filePath, 10);
}

async function resolveRealPathFollowingDanglingLinks(
  filePath: string,
  hopsLeft: number
): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch {
    // realpath fails on a DANGLING symlink too; follow it manually so the
    // creation path writes the link's intended target instead of atomically
    // renaming over (and destroying) the link itself. Hops are bounded so
    // cyclic links cannot loop forever.
    if (hopsLeft > 0) {
      try {
        const linkTarget = await fsPromises.readlink(filePath);
        return await resolveRealPathFollowingDanglingLinks(
          path.resolve(path.dirname(filePath), linkTarget),
          hopsLeft - 1
        );
      } catch {
        // Not a symlink: a plain missing file, resolved via its parent below.
      }
    }
    // File may not exist yet; resolve the parent so directory symlinks are
    // still honored, keeping the configured basename.
    try {
      const realDir = await fsPromises.realpath(path.dirname(filePath));
      return path.join(realDir, path.basename(filePath));
    } catch {
      return filePath;
    }
  }
}

// VS Code resolves relative folder paths against the .code-workspace file's
// directory; it does not expand `~` or variables, so neither do we. Such
// entries never match the managed root and stay untouched.
function getEntryPath(entry: unknown, workspaceFileDir: string): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const folderPath = (entry as { path?: unknown }).path;
  if (typeof folderPath !== "string" || folderPath.trim() === "") {
    return null;
  }
  return path.resolve(workspaceFileDir, folderPath);
}

export interface CodeWorkspaceFileUpdate {
  /** Absolute path of the .code-workspace file. */
  codeWorkspacePath: string;
  /** Absolute directories; only folder entries under one of them are managed by xum. */
  managedRootDirs: string[];
  /** Absolute worktree paths that should be present as folder entries. */
  desiredPaths: string[];
  /** Folder paths written when the file does not exist yet. */
  seedFolders: string[];
}

function isUnderAnyRoot(managedRootDirs: string[], candidate: string): boolean {
  return managedRootDirs.some((rootDir) => isPathInsideDir(rootDir, candidate));
}

/**
 * Reconcile the file's `folders` array with `desiredPaths` under the
 * managed-entry invariant. Creates the file (with `seedFolders`) when missing.
 * Uses jsonc-parser edits so user comments and unknown keys survive.
 */
export async function updateCodeWorkspaceFile(
  update: CodeWorkspaceFileUpdate
): Promise<CodeWorkspaceSyncResult> {
  const targetPath = await resolveRealPath(update.codeWorkspacePath);
  return withFileWriteLock(targetPath, () => updateCodeWorkspaceFileLocked(targetPath, update));
}

async function updateCodeWorkspaceFileLocked(
  targetPath: string,
  update: CodeWorkspaceFileUpdate
): Promise<CodeWorkspaceSyncResult> {
  const { codeWorkspacePath, managedRootDirs, desiredPaths } = update;
  // SECURITY: the configured path was extension-validated, but a symlink at
  // that path can live inside the checkout (repo-controlled) and point
  // anywhere. Re-validate the RESOLVED target so a planted link cannot
  // redirect the write into an arbitrary JSON file (or create one).
  if (!targetPath.endsWith(CODE_WORKSPACE_EXTENSION)) {
    log.warn("Skipping .code-workspace sync: resolved target is not a .code-workspace file", {
      codeWorkspacePath,
    });
    return { ok: false, error: "Workspace file symlink does not target a .code-workspace file" };
  }
  // Relative folder entries resolve against the configured file location,
  // matching how VS Code resolves them for the file the user opens.
  const fileDir = path.dirname(codeWorkspacePath);

  let original: string | null;
  try {
    // Reject non-regular targets before opening: a symlink can point at e.g.
    // /dev/zero, where the reported size is 0 but reads never reach EOF.
    const stats = await fsPromises.stat(targetPath);
    if (!stats.isFile()) {
      log.warn("Skipping .code-workspace sync: target is not a regular file", {
        codeWorkspacePath,
      });
      return { ok: false, error: "Workspace file is not a regular file" };
    }
    if (stats.size > MAX_CODE_WORKSPACE_FILE_BYTES) {
      log.warn("Skipping .code-workspace sync: file exceeds size limit", {
        codeWorkspacePath,
        sizeBytes: stats.size,
      });
      return { ok: false, error: "Workspace file exceeds the 1 MiB sync limit" };
    }
    // Byte-limited read through one descriptor: never trust the stat size.
    const handle = await fsPromises.open(targetPath, "r");
    try {
      const handleStats = await handle.stat();
      if (!handleStats.isFile()) {
        log.warn("Skipping .code-workspace sync: target is not a regular file", {
          codeWorkspacePath,
        });
        return { ok: false, error: "Workspace file is not a regular file" };
      }
      const buffer = Buffer.alloc(MAX_CODE_WORKSPACE_FILE_BYTES + 1);
      // read() may legally return short counts before EOF (notably on network
      // filesystems), so loop until EOF or the cap is exceeded; a single read
      // could silently truncate a valid file and rewrite it without its tail.
      let totalRead = 0;
      while (totalRead < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          totalRead,
          buffer.length - totalRead,
          totalRead
        );
        if (bytesRead === 0) {
          break;
        }
        totalRead += bytesRead;
      }
      if (totalRead > MAX_CODE_WORKSPACE_FILE_BYTES) {
        log.warn("Skipping .code-workspace sync: file exceeds size limit", {
          codeWorkspacePath,
        });
        return { ok: false, error: "Workspace file exceeds the 1 MiB sync limit" };
      }
      original = buffer.subarray(0, totalRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    original = null;
  }

  if (original === null) {
    if (update.seedFolders.length > MAX_CODE_WORKSPACE_FOLDERS) {
      log.warn("Skipping .code-workspace sync: too many folder entries", {
        codeWorkspacePath,
        folderCount: update.seedFolders.length,
      });
      return { ok: false, error: "Workspace file has too many folder entries to sync" };
    }
    const fresh = { folders: update.seedFolders.map((folderPath) => ({ path: folderPath })) };
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await writeFileAtomic(targetPath, JSON.stringify(fresh, null, "\t") + "\n");
    return { ok: true };
  }

  // Never clobber a file we cannot faithfully edit (self-healing over failing).
  const parseErrors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(original, parseErrors, { allowTrailingComma: true }) as unknown;
  if (
    parseErrors.length > 0 ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    log.warn("Skipping .code-workspace sync: file is not valid JSONC", { codeWorkspacePath });
    return { ok: false, error: "Workspace file is not valid JSONC" };
  }

  const existingFolders = (parsed as { folders?: unknown }).folders;
  if (existingFolders !== undefined && !Array.isArray(existingFolders)) {
    log.warn("Skipping .code-workspace sync: 'folders' is not an array", { codeWorkspacePath });
    return { ok: false, error: "Workspace file 'folders' is not an array" };
  }
  // jsonc.parse reads the LAST duplicate property while jsonc.modify edits the
  // FIRST, so a hand-edited file with duplicate `folders` keys would silently
  // stop syncing while reporting success; reject it instead.
  const rootNode = jsonc.parseTree(original, undefined, { allowTrailingComma: true });
  const foldersPropCount =
    rootNode?.children?.filter(
      (prop) => prop.type === "property" && prop.children?.[0]?.value === "folders"
    ).length ?? 0;
  if (foldersPropCount > 1) {
    log.warn("Skipping .code-workspace sync: duplicate 'folders' properties", {
      codeWorkspacePath,
    });
    return { ok: false, error: "Workspace file has duplicate 'folders' properties" };
  }

  const desired = new Set(desiredPaths.map((desiredPath) => path.resolve(desiredPath)));

  // One-pass reconcile: a repository-controlled file can hold thousands of
  // entries and per-entry jsonc edits reparse the whole document each time
  // (quadratic, synchronous, and untouchable by timeouts). Build the new
  // folders value once and apply a single edit. Comments inside the folders
  // array are not preserved when a change is needed; everything outside it is.
  const currentFolders: unknown[] = existingFolders ?? [];
  const presentPaths = new Set<string>();
  const kept = currentFolders.filter((entry) => {
    const entryPath = getEntryPath(entry, fileDir);
    if (entryPath === null) {
      return true;
    }
    if (isUnderAnyRoot(managedRootDirs, entryPath) && !desired.has(entryPath)) {
      return false;
    }
    presentPaths.add(entryPath);
    return true;
  });
  // Append missing desired entries after the existing ones (user order is preserved).
  const additions = [...desired].filter((desiredPath) => !presentPaths.has(desiredPath)).sort();

  if (kept.length === currentFolders.length && additions.length === 0) {
    return { ok: true };
  }
  const newFolders = [...kept, ...additions.map((folderPath) => ({ path: folderPath }))];
  // SECURITY: jsonc.modify serialization is synchronous and superlinear in
  // entry count, so a file within the byte cap can still hold tens of
  // thousands of entries and freeze the main thread for >10s. Checked on the
  // FINAL count (not the input) so a write can never push a file over the cap
  // and brick later syncs. Real multi-root workspaces stay far below it.
  if (newFolders.length > MAX_CODE_WORKSPACE_FOLDERS) {
    log.warn("Skipping .code-workspace sync: too many folder entries", {
      codeWorkspacePath,
      folderCount: newFolders.length,
    });
    return { ok: false, error: "Workspace file has too many folder entries to sync" };
  }
  const text = jsonc.applyEdits(
    original,
    jsonc.modify(original, ["folders"], newFolders, MODIFY_OPTIONS)
  );
  await writeFileAtomic(targetPath, text);
  return { ok: true };
}

// DevcontainerRuntime also creates a normal host git worktree via
// WorktreeManager under the default srcDir, so its workspaces belong in the
// file too (rooted at the default managed root).
function hasManagedHostWorktree(runtimeConfig: RuntimeConfig | undefined): boolean {
  return isWorktreeRuntime(runtimeConfig) || runtimeConfig?.type === "devcontainer";
}

function belongsToProject(metadata: FrontendWorkspaceMetadata, projectPath: string): boolean {
  return (
    stripTrailingSlashes(metadata.projectPath) === projectPath ||
    // Workspaces assigned to a registered sub-project live in the parent's
    // bucket; the sub-project's own file must still list them.
    (metadata.subProjectPath != null &&
      stripTrailingSlashes(metadata.subProjectPath) === projectPath) ||
    (metadata.projects?.some((ref) => stripTrailingSlashes(ref.projectPath) === projectPath) ??
      false)
  );
}

// The directory that holds this workspace's checkout for the given
// participant project. Sub-project workspaces share the parent repo's
// worktree directory; multi-project participants each have a directory named
// after themselves.
function participantCheckoutDirName(
  metadata: FrontendWorkspaceMetadata,
  participantPath: string
): string {
  const isPrimary = stripTrailingSlashes(metadata.projectPath) === participantPath;
  const isRef =
    metadata.projects?.some((ref) => stripTrailingSlashes(ref.projectPath) === participantPath) ??
    false;
  if (isPrimary || isRef) {
    return getProjectName(participantPath);
  }
  return getProjectName(stripTrailingSlashes(metadata.projectPath));
}

/**
 * Compute the worktree paths that belong in a project's .code-workspace file
 * (active, top-level worktree workspaces) plus the managed root directories
 * that scope which existing entries xum may remove.
 */
export function computeManagedWorktreePaths(params: {
  allMetadata: FrontendWorkspaceMetadata[];
  /** Normalized (no trailing slash) project path. */
  projectPath: string;
  defaultManagedRootDir: string;
}): { desiredPaths: string[]; managedRootDirs: string[] } {
  const { allMetadata, projectPath, defaultManagedRootDir } = params;

  // Managed roots come from every persisted worktree workspace of the project
  // (any lifecycle state), not just the current global srcDir: worktrees
  // created under a custom or legacy srcBaseDir (e.g. pre-rename ~/.mux/src)
  // must stay managed after upgrades. Callers cleaning up after a deletion
  // pass the removed workspace's roots explicitly (managedRootsByProject).
  const roots = new Set<string>([path.resolve(defaultManagedRootDir)]);
  for (const metadata of allMetadata) {
    if (
      !belongsToProject(metadata, projectPath) ||
      !hasManagedHostWorktree(metadata.runtimeConfig)
    ) {
      continue;
    }
    if (isWorktreeRuntime(metadata.runtimeConfig)) {
      roots.add(
        path.resolve(
          path.join(
            expandTilde(metadata.runtimeConfig.srcBaseDir),
            participantCheckoutDirName(metadata, projectPath)
          )
        )
      );
    } else {
      // Devcontainer host worktrees live under <srcDir>/<parent-project-name>;
      // for a sub-project participant that differs from defaultManagedRootDir,
      // so derive the root from the checkout itself.
      roots.add(path.dirname(path.resolve(metadata.namedWorkspacePath)));
    }
  }
  const managedRootDirs = [...roots].sort();

  const desired = new Set<string>();
  for (const metadata of allMetadata) {
    const runtimeConfig = metadata.runtimeConfig;
    if (!hasManagedHostWorktree(runtimeConfig)) {
      continue;
    }
    // Sub-agent child workspaces are transient implementation detail; listing
    // them would churn the user's editor window on every spawned task.
    if (metadata.parentWorkspaceId) {
      continue;
    }
    // isolation:"none" tasks share an ancestor checkout, not an own worktree.
    if (metadata.taskIsolation === "none") {
      continue;
    }
    // Transcript-only workspaces (checkout deleted, e.g. archive ->
    // delete-worktree -> unarchive) have no directory to open in the editor.
    if (metadata.transcriptOnly) {
      continue;
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      continue;
    }
    if (!belongsToProject(metadata, projectPath)) {
      continue;
    }

    let worktreePath: string;
    if (isMultiProject(metadata) && isWorktreeRuntime(runtimeConfig)) {
      // Multi-project workspaces persist the _workspaces/<name> symlink
      // container as namedWorkspacePath; the real per-project checkout lives
      // at <srcBaseDir>/<checkoutDirName>/<workspaceName> for the primary and
      // secondary projects alike (createMultiProject passes
      // directoryName: workspaceName).
      worktreePath = path.join(
        expandTilde(runtimeConfig.srcBaseDir),
        participantCheckoutDirName(metadata, projectPath),
        metadata.name
      );
    } else {
      worktreePath = metadata.namedWorkspacePath;
    }
    const resolved = path.resolve(worktreePath);
    // Only paths under a managed root are synced; anything else is user-owned.
    if (!isUnderAnyRoot(managedRootDirs, resolved)) {
      continue;
    }
    desired.add(resolved);
  }
  return { desiredPaths: [...desired].sort(), managedRootDirs };
}

/**
 * Managed roots contributed by one workspace, keyed by each involved project
 * path (normalized). Callers capture this BEFORE deleting a workspace: once
 * its config entry is gone, a custom/legacy srcBaseDir root can no longer be
 * reconstructed and the deleted checkout's folder entry would linger forever.
 * Roots are per-project so one project's file is never granted removal rights
 * under another project's root.
 */
export function managedRootsByProject(metadata: FrontendWorkspaceMetadata): Map<string, string[]> {
  const rootsByProject = new Map<string, string[]>();
  const runtimeConfig = metadata.runtimeConfig;
  if (!hasManagedHostWorktree(runtimeConfig)) {
    return rootsByProject;
  }
  const involved = new Set<string>([
    metadata.projectPath,
    ...(metadata.subProjectPath != null ? [metadata.subProjectPath] : []),
    ...(metadata.projects ?? []).map((ref) => ref.projectPath),
  ]);
  for (const involvedPath of involved) {
    const normalized = stripTrailingSlashes(involvedPath);
    const root = isWorktreeRuntime(runtimeConfig)
      ? path.resolve(
          path.join(
            expandTilde(runtimeConfig.srcBaseDir),
            participantCheckoutDirName(metadata, normalized)
          )
        )
      : // Devcontainer host worktrees live under the parent project's
        // directory, mirroring computeManagedWorktreePaths.
        path.dirname(path.resolve(metadata.namedWorkspacePath));
    rootsByProject.set(normalized, [root]);
  }
  return rootsByProject;
}

// Resolve a project's configured setting to an absolute target path, or null
// when unset or invalid. Relative settings resolve against the project root;
// `~` is expanded.
function resolveConfiguredCodeWorkspacePath(
  projectPath: string,
  setting: string | undefined
): string | null {
  const raw = setting?.trim();
  if (!raw) {
    return null;
  }
  const codeWorkspacePath = path.resolve(projectPath, expandTilde(raw));
  if (!codeWorkspacePath.endsWith(CODE_WORKSPACE_EXTENSION)) {
    // We read-modify-write this file, so never target arbitrary files.
    log.warn("Skipping .code-workspace sync: path must end with .code-workspace", {
      codeWorkspacePath,
    });
    return null;
  }
  return codeWorkspacePath;
}

export type CodeWorkspaceSyncResult = { ok: true } | { ok: false; error: string };

/**
 * Best-effort sync entry point used by workspace lifecycle operations and
 * startup reconciliation. Fast no-op when the project has no
 * `codeWorkspaceSyncPath` configured. Never throws and is bounded by
 * SYNC_TIMEOUT_MS: sync failures or stalled filesystems must never fail or
 * block a workspace operation. Background callers ignore the returned result;
 * the explicit settings save path surfaces it to the user.
 */
export async function syncProjectCodeWorkspace(
  config: Config,
  projectPath: string,
  options?: { extraManagedRootDirs?: string[] }
): Promise<CodeWorkspaceSyncResult> {
  try {
    const normalizedProjectPath = stripTrailingSlashes(projectPath);
    const projects = config.loadConfigOrDefault().projects;
    const targetFile = resolveConfiguredCodeWorkspacePath(
      normalizedProjectPath,
      projects.get(normalizedProjectPath)?.codeWorkspaceSyncPath
    );
    if (!targetFile) {
      return { ok: true };
    }

    // Group by canonical (symlink-resolved) target so aliases of one file
    // reconcile together. The realpath is bounded so a dead mount holding this
    // project's file fails fast instead of hanging until the outer timeout.
    const canonicalTarget = await boundedRealPath(targetFile);
    if (canonicalTarget === null) {
      log.warn("Timed out canonicalizing .code-workspace path", { projectPath });
      return { ok: false, error: "Timed out accessing the workspace file" };
    }

    // The work never rejects (errors become results), so a timeout that
    // orphans it cannot leave an unhandled rejection behind.
    const work: Promise<CodeWorkspaceSyncResult> = withFileWriteLock(
      canonicalTarget,
      async (): Promise<CodeWorkspaceSyncResult> => {
        try {
          // Desired state is derived INSIDE the per-file critical section:
          // with derivation outside it, an older lifecycle snapshot could be
          // written after a newer one and resurrect stale entries.
          //
          // Reconcile every project targeting this file together. Projects can
          // share a file, and same-basename projects even share a managed
          // root; independent per-project removals would erase each other's
          // entries.
          const currentProjects = config.loadConfigOrDefault().projects;
          const allMetadata = await config.getAllWorkspaceMetadata();
          const desired = new Set<string>();
          const roots = new Set<string>(
            (options?.extraManagedRootDirs ?? []).map((rootDir) => path.resolve(rootDir))
          );
          const candidates: Array<{ participantPath: string; participantFile: string }> = [];
          for (const [participantPath, participantConfig] of currentProjects) {
            const participantFile = resolveConfiguredCodeWorkspacePath(
              participantPath,
              participantConfig.codeWorkspaceSyncPath
            );
            if (participantFile !== null) {
              candidates.push({ participantPath, participantFile });
            }
          }
          // Canonicalize candidates concurrently: several stalled mounts under
          // unrelated projects' paths cost one shared REALPATH_TIMEOUT_MS in
          // total instead of one each, and a stalled path only drops that
          // project from this round; it cannot block the sync.
          const matchedPaths = await Promise.all(
            candidates.map(async ({ participantPath, participantFile }) => {
              if (participantFile === targetFile) {
                return participantPath;
              }
              const participantCanonical = await boundedRealPath(participantFile);
              return participantCanonical === canonicalTarget ? participantPath : null;
            })
          );
          const participantPaths: string[] = [];
          for (const participantPath of matchedPaths) {
            if (participantPath === null) {
              continue;
            }
            const computed = computeManagedWorktreePaths({
              allMetadata,
              projectPath: participantPath,
              defaultManagedRootDir: path.join(
                expandTilde(config.srcDir),
                getProjectName(participantPath)
              ),
            });
            participantPaths.push(participantPath);
            computed.desiredPaths.forEach((desiredPath) => desired.add(desiredPath));
            computed.managedRootDirs.forEach((rootDir) => roots.add(rootDir));
          }
          const desiredPaths = [...desired].sort();
          return await updateCodeWorkspaceFileLocked(canonicalTarget, {
            codeWorkspacePath: targetFile,
            managedRootDirs: [...roots].sort(),
            desiredPaths,
            seedFolders: [...participantPaths, ...desiredPaths],
          });
        } catch (error) {
          log.warn("Failed to sync .code-workspace file", { projectPath, error });
          return { ok: false, error: getErrorMessage(error) };
        }
      }
    );

    const outcome = await raceWithAbortAndTimeout(work, { timeoutMs: SYNC_TIMEOUT_MS });
    if (outcome.kind !== "ok") {
      log.warn("Timed out syncing .code-workspace file; continuing in background", {
        projectPath,
      });
      return { ok: false, error: "Timed out accessing the workspace file" };
    }
    return outcome.value;
  } catch (error) {
    log.warn("Failed to sync .code-workspace file", { projectPath, error });
    return { ok: false, error: getErrorMessage(error) };
  }
}
