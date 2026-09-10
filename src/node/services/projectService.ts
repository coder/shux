import { SecretsStore, type Config, type ProjectConfig, type ProjectsConfig } from "@/node/config";
import { formatSshEndpoint } from "@/common/utils/ssh/formatSshEndpoint";
import { SSH_PROTOCOL_SCHEMES } from "@/constants/git";
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  validateProjectPath,
  isGitRepository,
  isInsideGitRepository,
  stripTrailingSlashes,
} from "@/node/utils/pathUtils";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { Secret } from "@/common/types/secrets";
import type { Stats } from "fs";
import * as fsPromises from "fs/promises";
import { execFileAsync, killProcessTree } from "@/node/utils/disposableExec";
import { normalizeRepoUrlForClone } from "@/node/utils/gitUrls";
import { GIT_SCOPE_ENV_UNSET } from "@/node/services/backup/credentials";
import {
  buildFileCompletionsIndex,
  EMPTY_FILE_COMPLETIONS_INDEX,
  searchFileCompletions,
  type FileCompletionsIndex,
} from "@/node/services/fileCompletionsIndex";
import { log } from "@/node/services/log";
import type { SshPromptService } from "@/node/services/sshPromptService";
import { createMediatedAskpassSession } from "@/node/runtime/openSshPromptMediation";
import {
  classifySshCloneFailure,
  summarizeCloneStderr,
  withCloneReadAccessHint,
  type CloneErrorCode,
} from "./sshCloneFailure";
import type { BranchListResult } from "@/common/orpc/types";
import type { ProjectRemoveErrorSchema } from "@/common/orpc/schemas/errors";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import * as path from "path";
import { getXumProjectsDir } from "@/common/constants/paths";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { getErrorMessage } from "@/common/utils/errors";
import { deriveProjectHierarchy, isPathDescendant } from "@/common/utils/subProjects";
import {
  getProjectWorkspaceCounts,
  type ProjectWorkspaceCounts,
} from "@/common/utils/projectRemoval";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { z } from "zod";
import { ORPCError } from "@orpc/server";
import {
  CODE_WORKSPACE_EXTENSION,
  managedRootsByProject,
  syncProjectCodeWorkspace,
} from "@/node/worktree/codeWorkspaceSync";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import {
  type ProjectRegistrationLockHandle,
  withProjectRegistrationFileLock,
  withProjectRegistrationLock,
} from "@/node/config/projectRegistrationLock";
import { isProjectTrusted } from "@/node/utils/projectTrust";

function orderWorkspacesForCascadeRemoval(
  workspaces: ProjectConfig["workspaces"]
): ProjectConfig["workspaces"] {
  const parentById = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspace.id && workspace.parentWorkspaceId) {
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  const getDepth = (workspaceId: string | undefined): number => {
    if (!workspaceId) return 0;

    let depth = 0;
    let currentId: string | undefined = workspaceId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parentId = parentById.get(currentId);
      if (!parentId) break;
      depth += 1;
      currentId = parentId;
    }
    return depth;
  };

  // Parent workspaces are normally persisted before their sub-agents. Remove deepest descendants
  // first so per-workspace lifecycle guards cannot reject the intentional whole-project cascade.
  return workspaces
    .map((workspace, index) => ({ workspace, index, depth: getDepth(workspace.id) }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map(({ workspace }) => workspace);
}

/**
 * List directory contents for the DirectoryPickerModal.
 * Returns a FileTreeNode where:
 * - name and path are the resolved absolute path of the requested directory
 * - children are the immediate subdirectories (not recursive)
 */
async function listDirectory(requestedPath: string): Promise<FileTreeNode> {
  // Expand ~ to home directory (path.resolve doesn't handle tilde)
  const expanded =
    requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
      ? expandTilde(requestedPath)
      : requestedPath;
  const normalizedRoot = path.resolve(expanded || ".");
  const entries = await fsPromises.readdir(normalizedRoot, { withFileTypes: true });

  const children: FileTreeNode[] = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const entryPath = path.join(normalizedRoot, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: true,
        children: [],
      };
    });

  return {
    name: normalizedRoot,
    path: normalizedRoot,
    isDirectory: true,
    children,
  };
}

interface CloneProjectParams {
  repoUrl: string;
  cloneParentDir?: string | null;
}

export type { CloneErrorCode } from "./sshCloneFailure";

export type CloneEvent =
  | { type: "progress"; line: string }
  | { type: "success"; projectConfig: ProjectConfig; normalizedPath: string }
  | {
      type: "error";
      code: CloneErrorCode;
      error: string;
      normalizedPath?: string | null;
    };

type ProjectRemoveError = z.infer<typeof ProjectRemoveErrorSchema>;

interface WorkspaceRemover {
  remove(workspaceId: string, force?: boolean): Promise<Result<void>>;
}

interface WorkspaceMetadataRefresher {
  refreshAndEmitMetadata(workspaceId: string): Promise<void>;
}

function isTildePrefixedPath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function resolvePathWithTilde(inputPath: string): string {
  const expanded = isTildePrefixedPath(inputPath) ? expandTilde(inputPath) : inputPath;
  return path.resolve(expanded);
}

function resolveProjectParentDir(
  parentDir: string | null | undefined,
  defaultProjectDir: string | undefined
): string {
  const rawParentDir = parentDir ?? defaultProjectDir ?? getXumProjectsDir();
  const trimmedParentDir = rawParentDir.trim();

  if (!trimmedParentDir) {
    throw new Error("Project parent directory cannot be empty");
  }

  return resolvePathWithTilde(trimmedParentDir);
}

// Windows device names are invalid as path segments (CON/PRN/AUX/NUL/COM1.../LPT9)
// even when used as a directory name.
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/iu;

// Derive a conservative folder name from user-controlled repo input.
// This path can flow into shell-adjacent commands (for example when opening
// native terminals), so we only keep letters/digits/combining marks plus . _ -.
function sanitizeRepoFolderName(name: string): string {
  const sanitized = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+/u, "")
    .replace(/[.\s-]+$/u, "");

  if (!sanitized) {
    return "";
  }

  const reservedStemMatch = WINDOWS_RESERVED_BASENAME_PATTERN.exec(sanitized);
  if (reservedStemMatch) {
    const stemLength = reservedStemMatch[1]?.length ?? 0;
    return `${sanitized.slice(0, stemLength)}-repo${sanitized.slice(stemLength)}`;
  }

  return sanitized;
}

function deriveFallbackRepoFolderName(repoSeed: string): string {
  const digest = createHash("sha256").update(repoSeed).digest("hex").slice(0, 10);
  return `repo-${digest}`;
}

function deriveRepoFolderName(repoUrl: string): string {
  const trimmedRepoUrl = repoUrl.trim();
  if (!trimmedRepoUrl) {
    throw new Error("Repository URL cannot be empty");
  }

  let candidatePath = trimmedRepoUrl;

  // SSH-style shorthand: git@github.com:owner/repo.git
  const scpLikeMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmedRepoUrl);
  if (scpLikeMatch) {
    candidatePath = scpLikeMatch[1];
  } else if (/^[^/\\\s]+\/[^/\\\s]+$/.test(trimmedRepoUrl)) {
    // Owner/repo shorthand
    candidatePath = trimmedRepoUrl;
  } else {
    try {
      // https://..., ssh://..., file://...
      const parsed = new URL(trimmedRepoUrl);
      candidatePath = decodeURIComponent(parsed.pathname);
    } catch {
      // Not a URL with protocol. Treat as local path-like input.
    }
  }

  const normalizedCandidatePath = candidatePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const repoName = path.posix.basename(normalizedCandidatePath).replace(/\.git$/i, "");
  const safeFolderName = sanitizeRepoFolderName(repoName);

  // Keep clone flow resilient even when the repo basename contains only symbols/emojis.
  // A deterministic fallback avoids user-visible hard failures while staying shell-safe.
  if (!safeFolderName) {
    return deriveFallbackRepoFolderName(trimmedRepoUrl);
  }

  return safeFolderName;
}

function parseScpStyleSshUrl(url: string): { host: string } | undefined {
  const trimmedUrl = url.trim();

  // Keep Windows drive-letter paths (e.g. C:\repo) out of SCP-style SSH matching.
  if (/^[a-zA-Z]:[\\/]/.test(trimmedUrl)) {
    return undefined;
  }

  // Protocol URLs (https://, ssh://, etc.) are handled separately.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedUrl)) {
    return undefined;
  }

  // SCP-style clone URL: [user@]host:path
  const scpLikeMatch = /^(?:[a-zA-Z0-9._-]+@)?(\[[^\]]+\]|[^:/\s][^:/\s]*):(.+)$/.exec(trimmedUrl);
  if (!scpLikeMatch) {
    return undefined;
  }

  return { host: scpLikeMatch[1] };
}

type CloneTransport =
  | { kind: "ssh"; hostname: string; port: number }
  | { kind: "ssh-scp"; hostname: string; port: number }
  | { kind: "non-ssh" };

/**
 * Canonical clone-URL transport classifier.
 * Every SSH-related decision in the clone flow (askpass enablement, prompt
 * deduplication) should consume this parser so protocol support cannot drift.
 */
function parseCloneTransport(rawUrl: string): CloneTransport {
  const trimmedUrl = rawUrl.trim();

  // SCP-style: [user@]host:path (always SSH, port 22)
  const parsedScpLikeUrl = parseScpStyleSshUrl(trimmedUrl);
  if (parsedScpLikeUrl) {
    return { kind: "ssh-scp", hostname: parsedScpLikeUrl.host, port: 22 };
  }

  // Protocol URLs: ssh://, git+ssh://, ssh+git://
  try {
    const parsed = new URL(trimmedUrl);
    if (SSH_PROTOCOL_SCHEMES.has(parsed.protocol.toLowerCase()) && parsed.hostname) {
      const parsedPort = Number.parseInt(parsed.port, 10);
      const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22;
      return { kind: "ssh", hostname: parsed.hostname, port };
    }
  } catch {
    // Not a valid protocol URL; treat as non-SSH.
  }

  return { kind: "non-ssh" };
}

/** Detect whether a clone URL will use SSH transport. */
function isSshCloneUrl(url: string): boolean {
  return parseCloneTransport(url).kind !== "non-ssh";
}

function deriveSshClonePromptDedupeKey(cloneUrl: string): string | undefined {
  const transport = parseCloneTransport(cloneUrl);
  if (transport.kind === "non-ssh") {
    return undefined;
  }

  return formatSshEndpoint(transport.hostname, transport.port);
}

const FILE_COMPLETIONS_CACHE_TTL_MS = 10_000;

interface FileCompletionsCacheEntry {
  index: FileCompletionsIndex;
  fetchedAt: number;
  refreshing?: Promise<void>;
}

// Keep raw Node errno details out of project-add errors.
function friendlyFsError(error: unknown, action: string, targetPath: string): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Cannot ${action} "${targetPath}": permission denied`;
    case "EROFS":
      return `Cannot ${action} "${targetPath}": the file system is read-only`;
    case "ENOTDIR":
      return `Cannot ${action} "${targetPath}": part of the path is not a folder`;
    default:
      return null;
  }
}

async function resolveRealProjectPath(projectPath: string): Promise<string> {
  return stripTrailingSlashes(await fsPromises.realpath(projectPath));
}

async function readGitTopLevel(projectPath: string): Promise<string | null> {
  try {
    using proc = execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
    const { stdout } = await proc.result;
    return stripTrailingSlashes(stdout.trim());
  } catch {
    return null;
  }
}

function findDeepestTopLevelParentProject(
  candidatePath: string,
  projects: Map<string, ProjectConfig>
): string | null {
  let parentPath: string | null = null;
  for (const [projectPath, projectConfig] of projects) {
    if (projectConfig.parentProjectPath || projectPath === candidatePath) {
      continue;
    }
    if (!isPathDescendant(projectPath, candidatePath)) {
      continue;
    }
    if (!parentPath || projectPath.length > parentPath.length) {
      parentPath = projectPath;
    }
  }
  return parentPath;
}

function hasRegisteredSubProjectAncestor(
  candidatePath: string,
  projects: Map<string, ProjectConfig>
): boolean {
  for (const [projectPath, projectConfig] of projects) {
    if (!projectConfig.parentProjectPath) {
      continue;
    }
    if (isPathDescendant(projectPath, candidatePath)) {
      return true;
    }
  }
  return false;
}

export class ProjectService {
  private readonly fileCompletionsCache = new Map<string, FileCompletionsCacheEntry>();
  /** Canonical paths with git initialization in flight; see create() claim below. */
  private readonly activeGitInits = new Set<string>();
  private activeClones = 0;
  private shuttingDown = false;
  private directoryPicker?: (initialPath?: string | null) => Promise<string | null>;
  private readonly sshPromptService: SshPromptService | undefined;
  private workspaceService?: WorkspaceRemover;
  private workspaceMetadataRefresher?: WorkspaceMetadataRefresher;
  private mcpServerManager?: Pick<MCPServerManager, "applyProjectTrust" | "forgetProjectTrust">;

  constructor(
    private readonly config: Config,
    sshPromptService?: SshPromptService,
    private readonly secretsStore: SecretsStore = new SecretsStore(config.rootDir)
  ) {
    this.sshPromptService = sshPromptService;
  }

  setWorkspaceService(workspaceService: WorkspaceRemover): void {
    this.workspaceService = workspaceService;
  }

  setWorkspaceMetadataRefresher(workspaceService: WorkspaceMetadataRefresher): void {
    this.workspaceMetadataRefresher = workspaceService;
  }

  setMcpServerManager(
    mcpServerManager: Pick<MCPServerManager, "applyProjectTrust" | "forgetProjectTrust">
  ): void {
    this.mcpServerManager = mcpServerManager;
  }

  setDirectoryPicker(picker: (initialPath?: string | null) => Promise<string | null>) {
    this.directoryPicker = picker;
  }

  async pickDirectory(initialPath?: string | null): Promise<string | null> {
    if (!this.directoryPicker) return null;
    return this.directoryPicker(initialPath ?? null);
  }

  async create(
    projectPath: string,
    options?: { initGit?: boolean; displayName?: string }
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    // No registration lock around the validation: it stats, resolves, and reads git roots
    // along the new path, which on a slow or unavailable filesystem can take as long as the
    // lock's wait bound — and every config save in every process waits for that lock, so
    // holding it here would stall unrelated workspace, task, and settings saves behind one
    // stuck create. createUnlocked takes the lock itself around what mutates state (a git
    // init, the registering write) and re-validates under it; withRegistrationLock callers
    // pass the window they already hold.
    return this.createUnlocked(projectPath, options, null);
  }

  /**
   * Registration held stable — no project can be registered or removed underneath `fn` —
   * with a `create` that registers inside that window and the lock's own ownership check.
   * A backup import resolves its target's identity, registers it when needed, and writes its
   * memory within one such window, so the project it wrote into is the project registered
   * when it reports success.
   */
  withRegistrationLock<T>(
    fn: (registrar: {
      create: ProjectService["create"];
      assertStillOwned: ProjectRegistrationLockHandle["assertStillOwned"];
    }) => Promise<T>
  ): Promise<T> {
    return withProjectRegistrationLock(this.config.rootDir, (lock) =>
      fn({
        create: (projectPath, options) => this.createUnlocked(projectPath, options, lock),
        assertStillOwned: () => lock.assertStillOwned(),
      })
    );
  }

  /** `lock`: the caller's registration window, or null to open one for the mutating steps. */
  private async createUnlocked(
    projectPath: string,
    options: { initGit?: boolean; displayName?: string } | undefined,
    lock: ProjectRegistrationLockHandle | null
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    let gitInitClaimKey: string | null = null;
    try {
      // Validate input
      if (!projectPath || projectPath.trim().length === 0) {
        return Err("Project path cannot be empty");
      }

      // Resolve the path:
      // - Bare names like "my-project" → ~/.xum/projects/my-project
      // - Paths with ~ → expand to home directory
      // - Absolute/relative paths → resolve normally
      const isBareProjectName =
        projectPath.length > 0 &&
        !projectPath.includes("/") &&
        !projectPath.includes("\\") &&
        !projectPath.startsWith("~");

      const config = this.config.loadConfigOrDefault();
      let normalizedPath: string;
      if (isBareProjectName) {
        // Bare project name - put in default projects directory
        const parentDir = resolveProjectParentDir(undefined, config.defaultProjectDir);
        normalizedPath = path.join(parentDir, projectPath);
      } else if (
        projectPath === "~" ||
        projectPath.startsWith("~/") ||
        projectPath.startsWith("~\\")
      ) {
        // Tilde expansion - uses expandTilde to respect MUX_ROOT for ~/.xum paths
        normalizedPath = path.resolve(expandTilde(projectPath));
      } else {
        normalizedPath = path.resolve(projectPath);
      }

      let existingStat: Stats | null = null;
      try {
        existingStat = await fsPromises.stat(normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          const friendly = friendlyFsError(error, "access", normalizedPath);
          if (friendly) {
            return Err(friendly);
          }
          throw error;
        }
      }

      if (existingStat && !existingStat.isDirectory()) {
        return Err("Project path is not a directory");
      }

      if (options?.initGit && existingStat) {
        const entries = await fsPromises.readdir(normalizedPath);
        if (entries.length > 0) {
          return Err("Directory already exists and is not empty");
        }
      }

      if (config.projects.has(normalizedPath)) {
        return Err("Project already exists");
      }

      // Create the directory if it doesn't exist. The non-recursive mkdir on the leaf is
      // an exclusive ownership claim: only the call that actually created the directory
      // may remove it later, so concurrent creates of the same absent path cannot delete
      // each other's work. Keep the user-facing path stable in config; Windows realpath
      // may expand 8.3 short names and surprise callers.
      let createdDirectory = false;
      if (existingStat == null) {
        try {
          await fsPromises.mkdir(path.dirname(normalizedPath), { recursive: true });
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          // Recursive mkdir never rejects an existing directory, so EEXIST here means a
          // path component exists as a file: report it like ENOTDIR ("not a folder").
          const friendly = friendlyFsError(
            err.code === "EEXIST" ? { ...err, code: "ENOTDIR" } : error,
            "create folder",
            normalizedPath
          );
          if (friendly) {
            return Err(friendly);
          }
          throw error;
        }
        try {
          await fsPromises.mkdir(normalizedPath);
          createdDirectory = true;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== "EEXIST") {
            const friendly = friendlyFsError(error, "create folder", normalizedPath);
            if (friendly) {
              return Err(friendly);
            }
            throw error;
          }
          // Lost a creation race: the path now belongs to the concurrent winner, so
          // re-validate it as a pre-existing entry instead of claiming ownership.
          const raceStat = await fsPromises.stat(normalizedPath).catch(() => null);
          if (!raceStat?.isDirectory()) {
            return Err("Project path is not a directory");
          }
          // Never git-init a directory that appeared mid-call: the winner may still be
          // initializing it, and interleaved git operations could corrupt or delete its
          // work. A retry sees the directory as pre-existing and validates it normally.
          if (options?.initGit) {
            return Err("Directory already exists");
          }
        }
      }

      let initializedGitDir = false;
      const cleanupCreatedDirectory = async () => {
        try {
          if (createdDirectory) {
            await fsPromises.rm(normalizedPath, { recursive: true, force: true });
          } else if (initializedGitDir) {
            // We only initialized git inside a pre-existing directory: remove the .git
            // we created so a retry does not hit the non-empty-directory rejection.
            await fsPromises.rm(path.join(normalizedPath, ".git"), {
              recursive: true,
              force: true,
            });
          }
        } catch (error) {
          log.error(`Failed to clean up rejected project directory ${normalizedPath}:`, error);
        }
      };
      const canonicalPath = await resolveRealProjectPath(normalizedPath);

      if (config.projects.has(canonicalPath)) {
        await cleanupCreatedDirectory();
        return Err("Project already exists");
      }

      config.projects = deriveProjectHierarchy(config.projects);
      if (hasRegisteredSubProjectAncestor(normalizedPath, config.projects)) {
        await cleanupCreatedDirectory();
        return Err("Sub-projects can only be one level deep");
      }

      const parentProjectPath = findDeepestTopLevelParentProject(normalizedPath, config.projects);
      // Initializing a nested repository would flip the new directory's git root after
      // the same-repository validation below, persisting a sub-project from a different
      // repository (mirrors the clone-into-project-tree rejection). Check the canonical
      // path too so a symlinked alias into a registered checkout cannot bypass this.
      if (
        options?.initGit &&
        (parentProjectPath ?? findDeepestTopLevelParentProject(canonicalPath, config.projects))
      ) {
        await cleanupCreatedDirectory();
        return Err("Cannot create a new git repository inside an existing project");
      }
      if (parentProjectPath) {
        const [parentGitRoot, subProjectGitRoot] = await Promise.all([
          readGitTopLevel(parentProjectPath),
          readGitTopLevel(normalizedPath),
        ]);
        if (parentGitRoot !== subProjectGitRoot) {
          await cleanupCreatedDirectory();
          return Err("Sub-project must be in the same git repository as its parent project");
        }
      }

      const descendantProjectPaths = Array.from(config.projects.keys()).filter((candidatePath) =>
        isPathDescendant(normalizedPath, candidatePath)
      );
      if (descendantProjectPaths.length > 0) {
        const parentGitRoot = await readGitTopLevel(normalizedPath);
        for (const descendantProjectPath of descendantProjectPaths) {
          const descendantGitRoot = await readGitTopLevel(descendantProjectPath);
          if (parentGitRoot !== descendantGitRoot) {
            await cleanupCreatedDirectory();
            return Err(
              "Cannot register a parent project above an existing project from a different git repository"
            );
          }
        }
      }

      // From here on the request mutates state — a git init into the directory, the
      // registering write — so it runs under the registration lock: the window a
      // withRegistrationLock caller holds, or one opened here. The read-only validation above
      // stayed outside it (see create).
      const register = async (
        lock: ProjectRegistrationLockHandle
      ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> => {
        if (options?.initGit) {
          // The project set as it is under the lock, before anything is written into the
          // directory: registered meanwhile — a settings-backup import into this same empty
          // directory, say — it is the winner's now, and this request fails as the duplicate
          // it is without having initialized a repository inside the winner's checkout only
          // to roll it back again.
          const current = this.config.loadConfigOrDefault();
          if (current.projects.has(normalizedPath) || current.projects.has(canonicalPath)) {
            return Err("Project already exists");
          }
          // Exclusive per-canonical-path claim: two initGit creates targeting the same
          // pre-existing empty directory would otherwise interleave git init and failure
          // rollback, letting one call delete the .git the other just initialized.
          if (this.activeGitInits.has(canonicalPath)) {
            return Err("Another project creation is already initializing this directory");
          }
          this.activeGitInits.add(canonicalPath);
          gitInitClaimKey = canonicalPath;

          const gitInitResult = await this.initializeGitRepository(normalizedPath);
          if (!gitInitResult.success) {
            await cleanupCreatedDirectory();
            return gitInitResult;
          }
          initializedGitDir = gitInitResult.data.initializedGitDir;
        }

        // Register the project inside the serialized editConfig transform, re-checking for
        // duplicates and re-deriving the hierarchy from FRESH config: persisting the pre-read
        // snapshot would clobber concurrent config edits (lost-update race). The async
        // validations above (git roots, sub-project depth) ran against the snapshot; the
        // transform only re-resolves state that a concurrent edit could have changed.
        let createResult: Result<{ projectConfig: ProjectConfig; normalizedPath: string }> =
          Err("Project already exists");
        // Distinguishes in-transform failures for directory cleanup: when a concurrent
        // call registered this same path ("duplicate"), the directory belongs to that
        // winner and must not be deleted; other rejections leave the directory ours.
        let transformFailure:
          | "duplicate"
          | "depth"
          | "hierarchy-changed"
          | "hierarchy-changed-descendant"
          | null = null;
        // The .git this request initialized is never the winner's to keep (see below).
        const removeInitializedGitDir = () =>
          fsPromises
            .rm(path.join(normalizedPath, ".git"), { recursive: true, force: true })
            .catch((cleanupError: unknown) => {
              log.error(`Failed to roll back git init in ${normalizedPath}:`, cleanupError);
            });
        const registerEdit = (freshConfig: ProjectsConfig): ProjectsConfig => {
          if (freshConfig.projects.has(normalizedPath) || freshConfig.projects.has(canonicalPath)) {
            transformFailure = "duplicate";
            createResult = Err("Project already exists");
            return freshConfig;
          }
          freshConfig.projects = deriveProjectHierarchy(freshConfig.projects);
          // Re-run the sub-project depth check against FRESH hierarchy: a concurrent
          // registration (e.g. /repo/pkg landing while /repo/pkg/api is validating)
          // can introduce a sub-project ancestor that the snapshot-time check missed,
          // which would persist a second-level sub-project.
          if (hasRegisteredSubProjectAncestor(normalizedPath, freshConfig.projects)) {
            transformFailure = "depth";
            createResult = Err("Sub-projects can only be one level deep");
            return freshConfig;
          }
          const freshParentProjectPath = findDeepestTopLevelParentProject(
            normalizedPath,
            freshConfig.projects
          );
          // The same-git-repository validations above ran against the snapshot hierarchy
          // only, and this transform is synchronous so it cannot re-run readGitTopLevel.
          // If a concurrent edit introduced a different parent or new descendants, those
          // were never git-validated — reject instead of persisting an unvalidated
          // hierarchy (e.g. a sub-project from a different git repository).
          const freshDescendantProjectPaths = Array.from(freshConfig.projects.keys()).filter(
            (candidatePath) => isPathDescendant(normalizedPath, candidatePath)
          );
          const hasNewDescendantProject = freshDescendantProjectPaths.some(
            (candidatePath) => !descendantProjectPaths.includes(candidatePath)
          );
          // Re-check the canonical parent for initGit: the snapshot-time rejection above
          // can miss a parent registered concurrently, and the lexical freshParent check
          // below cannot see it when this path reaches the checkout through a symlink.
          if (
            options?.initGit &&
            findDeepestTopLevelParentProject(canonicalPath, freshConfig.projects)
          ) {
            transformFailure = "hierarchy-changed";
            createResult = Err("Project hierarchy changed concurrently; please retry");
            return freshConfig;
          }
          if (freshParentProjectPath !== parentProjectPath || hasNewDescendantProject) {
            // A new descendant registered under this path claims the directory tree we
            // created: recursive cleanup would delete that project's checkout, so treat
            // it like the duplicate case and leave the directory alone.
            transformFailure = hasNewDescendantProject
              ? "hierarchy-changed-descendant"
              : "hierarchy-changed";
            createResult = Err("Project hierarchy changed concurrently; please retry");
            return freshConfig;
          }
          const projectConfig: ProjectConfig = {
            workspaces: [],
            parentProjectPath: freshParentProjectPath ?? undefined,
            // Set in the same config write as the registration (a backup restore names
            // imported projects) rather than as a second write and notification.
            ...(options?.displayName !== undefined ? { displayName: options.displayName } : {}),
          };
          freshConfig.projects.set(normalizedPath, projectConfig);
          freshConfig.projects = deriveProjectHierarchy(freshConfig.projects);
          createResult = Ok({ projectConfig, normalizedPath });
          return freshConfig;
        };
        try {
          await this.config.editConfig(registerEdit, { withinRegistrationLock: lock });
        } catch (error) {
          // The write itself was refused — most likely this process's hold was judged stale
          // and reclaimed while git init ran (assertStillOwned). Whatever the request wrote
          // into the directory must not stay behind unregistered: a leftover .git would fail
          // every retry on the non-empty-directory check. A request that wrote nothing has
          // nothing to roll back and no lock to wait for.
          if (createdDirectory || initializedGitDir) {
            await this.rollBackRefusedCreate(lock, normalizedPath, {
              initializedGitDir,
              cleanupCreatedDirectory,
              removeInitializedGitDir,
            });
          }
          throw error;
        }

        // Do NOT clean up the created directory when a concurrent registration claims
        // it: a duplicate owns this exact path, and a new descendant project lives
        // inside the tree we created — recursive removal would destroy the winner's
        // checkout either way (including files created after its call returned). Only
        // depth and parent-only hierarchy rejections leave the directory ours to remove.
        if (transformFailure === "depth" || transformFailure === "hierarchy-changed") {
          await cleanupCreatedDirectory();
        } else if (
          (transformFailure === "hierarchy-changed-descendant" ||
            transformFailure === "duplicate") &&
          initializedGitDir
        ) {
          // The winning registration owns the files (a duplicate winner registered this
          // exact pre-existing directory; a descendant winner lives inside it), but the
          // .git this losing request created would silently turn the winner's project
          // into a repository it never asked for, or wrap its checkout in an
          // unregistered outer repository that changes git discovery.
          await removeInitializedGitDir();
        }
        if (
          createResult.success &&
          !this.config.loadConfigOrDefault().projects.has(normalizedPath)
        ) {
          // Config persistence (editConfig → private saveConfig) logs-and-continues on
          // write failures. Without this check a git-initialized project would report
          // success, vanish after restart, and block retries on the leftover .git.
          await cleanupCreatedDirectory();
          return Err("Failed to save project configuration");
        }
        return createResult;
      };
      // A lock failure (a wait on another process timing out, an unwritable locks
      // directory) is caught below like every other failure, so the Result contract holds.
      return lock === null
        ? await withProjectRegistrationLock(this.config.rootDir, register)
        : await register(lock);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to create project: ${message}`);
    } finally {
      if (gitInitClaimKey) {
        this.activeGitInits.delete(gitInitClaimKey);
      }
    }
  }

  /**
   * Rollback for a create whose registering write threw after the request had mutated the
   * directory. With the caller's hold still ours, nothing else can have registered anything
   * (every registration takes the lock), so everything the request created goes. With the
   * hold reclaimed, whoever reclaimed it may have registered this very directory meanwhile —
   * under any spelling, so the registry's keys cannot prove it did not, and resolving every
   * key's real path here would wait on the same unavailable mounts a restore is bounded
   * against. The directory therefore stays (an empty one this request created is a harmless
   * leftover a retry finds empty and uses); only the .git this request initialized goes,
   * which is never a winner's to keep (see the duplicate case), under a fresh hold of the
   * file lock so it cannot interleave with a winner's own git init. Best effort: a failure
   * here is logged, and the create's own error is what the caller sees.
   */
  private async rollBackRefusedCreate(
    lock: ProjectRegistrationLockHandle,
    normalizedPath: string,
    created: {
      initializedGitDir: boolean;
      cleanupCreatedDirectory: () => Promise<void>;
      removeInitializedGitDir: () => Promise<void>;
    }
  ): Promise<void> {
    try {
      const stillOwned = await lock.assertStillOwned().then(
        () => true,
        () => false
      );
      if (stillOwned) {
        await created.cleanupCreatedDirectory();
      } else if (created.initializedGitDir) {
        await withProjectRegistrationFileLock(this.config.rootDir, created.removeInitializedGitDir);
      }
    } catch (error) {
      log.error(`Failed to roll back rejected project creation ${normalizedPath}:`, error);
    }
  }

  getDefaultProjectDir(): string {
    const config = this.config.loadConfigOrDefault();
    return resolveProjectParentDir(undefined, config.defaultProjectDir);
  }

  async setDefaultProjectDir(dirPath: string): Promise<void> {
    const trimmed = dirPath.trim();
    await this.config.editConfig((config) => ({
      ...config,
      defaultProjectDir: trimmed || undefined,
    }));
  }

  private validateAndPrepareClone(input: CloneProjectParams): Result<{
    cloneUrl: string;
    fallbackCloneUrl?: string;
    normalizedPath: string;
    cloneParentDir: string;
  }> {
    try {
      const repoUrl = input.repoUrl.trim();
      if (!repoUrl) {
        return Err("Repository URL cannot be empty");
      }

      const config = this.config.loadConfigOrDefault();
      const cloneParentDir = resolveProjectParentDir(
        input.cloneParentDir,
        config.defaultProjectDir
      );
      const repoFolderName = deriveRepoFolderName(repoUrl);
      const normalizedPath = path.join(cloneParentDir, repoFolderName);

      const normalizedProjects = deriveProjectHierarchy(config.projects);
      if (findDeepestTopLevelParentProject(normalizedPath, normalizedProjects)) {
        return Err("Cannot clone a new git repository inside an existing project tree");
      }

      if (config.projects.has(normalizedPath)) {
        return Err(`Project already exists at ${normalizedPath}`);
      }

      return Ok({
        ...normalizeRepoUrlForClone(repoUrl),
        normalizedPath,
        cloneParentDir,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  /** Clones and git inits in flight; a restart between them would leave a partial project. */
  getMutationCount(): number {
    return this.activeClones + this.activeGitInits.size;
  }

  /** A mutation admitted during teardown would be killed half-done by the exit that follows. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async *cloneWithProgress(
    input: CloneProjectParams,
    signal?: AbortSignal
  ): AsyncGenerator<CloneEvent> {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    this.activeClones++;
    try {
      yield* this.cloneWithProgressTracked(input, signal);
    } finally {
      this.activeClones--;
    }
  }

  private async *cloneWithProgressTracked(
    input: CloneProjectParams,
    signal?: AbortSignal
  ): AsyncGenerator<CloneEvent> {
    const prepared = this.validateAndPrepareClone(input);
    if (!prepared.success) {
      yield { type: "error", code: "clone_failed", error: prepared.error };
      return;
    }

    const { cloneUrl, fallbackCloneUrl, normalizedPath, cloneParentDir } = prepared.data;
    const cloneWorkPath = `${normalizedPath}.mux-clone-${randomBytes(6).toString("hex")}`;
    let cloneSucceeded = false;

    const cleanupPartialClone = async () => {
      if (cloneSucceeded) {
        return;
      }

      try {
        // Only clean up the temp clone path we created so we never delete
        // a destination directory that another process created concurrently.
        await fsPromises.rm(cloneWorkPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors — the original error is more important.
      }
    };

    try {
      if (signal?.aborted) {
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      let cloneParentStat: Stats | null = null;
      try {
        cloneParentStat = await fsPromises.stat(cloneParentDir);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (cloneParentStat && !cloneParentStat.isDirectory()) {
        yield {
          type: "error",
          code: "clone_failed",
          error: "Clone destination parent directory is not a directory",
        };
        return;
      }

      let destinationStat: Stats | null = null;
      try {
        destinationStat = await fsPromises.stat(normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (destinationStat) {
        if (destinationStat.isDirectory()) {
          yield {
            type: "error",
            code: "destination_exists",
            error: `Destination already exists: ${normalizedPath}`,
            normalizedPath,
          };
        } else {
          yield {
            type: "error",
            code: "clone_failed",
            error: `Destination already exists: ${normalizedPath}`,
          };
        }
        return;
      }

      await fsPromises.mkdir(cloneParentDir, { recursive: true });

      const attemptUrls = fallbackCloneUrl != null ? [cloneUrl, fallbackCloneUrl] : [cloneUrl];

      for (const [attemptIndex, attemptUrl] of attemptUrls.entries()) {
        const outcome = yield* this.runGitCloneAttempt(attemptUrl, cloneWorkPath, signal);
        if (outcome.kind === "success") {
          break;
        }

        await cleanupPartialClone();

        if (outcome.kind === "cancelled") {
          yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
          return;
        }

        // Do not bypass a rejected host key or cancelled credential by retrying over HTTPS.
        const nextUrl = attemptUrls[attemptIndex + 1];
        if (nextUrl != null && outcome.code === "clone_failed") {
          yield {
            type: "progress",
            line: `\nClone from ${attemptUrl} failed; retrying with ${nextUrl}...\n`,
          };
          continue;
        }

        yield { type: "error", code: outcome.code, error: outcome.error };
        return;
      }

      if (signal?.aborted) {
        await cleanupPartialClone();
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      try {
        await fsPromises.rename(cloneWorkPath, normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EEXIST" || err.code === "ENOTEMPTY") {
          await cleanupPartialClone();

          let existingDestinationStat: Stats | null = null;
          try {
            existingDestinationStat = await fsPromises.stat(normalizedPath);
          } catch (statError) {
            const statErr = statError as NodeJS.ErrnoException;
            if (statErr.code !== "ENOENT") {
              throw statError;
            }
          }

          if (existingDestinationStat?.isDirectory()) {
            yield {
              type: "error",
              code: "destination_exists",
              error: `Destination already exists: ${normalizedPath}`,
              normalizedPath,
            };
          } else {
            yield {
              type: "error",
              code: "clone_failed",
              error: `Destination already exists: ${normalizedPath}`,
            };
          }
          return;
        }
        throw error;
      }

      if (signal?.aborted) {
        // Abort won the race after rename but before config mutation.
        // Remove the newly materialized destination so cancellation remains authoritative.
        try {
          await fsPromises.rm(normalizedPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      const projectConfig: ProjectConfig = { workspaces: [] };
      await this.config.editConfig((freshConfig) => {
        if (freshConfig.projects.has(normalizedPath)) {
          return freshConfig;
        }
        const updatedProjects = new Map(freshConfig.projects);
        updatedProjects.set(normalizedPath, projectConfig);
        return { ...freshConfig, projects: updatedProjects };
      });

      if (!this.config.loadConfigOrDefault().projects.has(normalizedPath)) {
        // Config persistence (editConfig → private saveConfig) logs-and-continues on write
        // failures, so verify persistence explicitly before reporting success.
        try {
          await fsPromises.rm(normalizedPath, { recursive: true, force: true });
        } catch {
          // Best-effort rollback only.
        }
        yield {
          type: "error",
          code: "clone_failed",
          error: "Failed to persist cloned project configuration",
        };
        return;
      }

      cloneSucceeded = true;
      yield { type: "success", projectConfig, normalizedPath };
    } catch (error) {
      const message = getErrorMessage(error);
      yield {
        type: "error",
        code: "clone_failed",
        error: `Failed to clone repository: ${message}`,
      };
    } finally {
      await cleanupPartialClone();
    }
  }

  private async *runGitCloneAttempt(
    cloneUrl: string,
    cloneWorkPath: string,
    signal?: AbortSignal
  ): AsyncGenerator<
    Extract<CloneEvent, { type: "progress" }>,
    | { kind: "success" }
    | { kind: "cancelled" }
    | { kind: "failure"; code: CloneErrorCode; error: string }
  > {
    // An abort delivered between attempts (e.g. while the caller yielded the retry
    // notice) must not spawn another clone.
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }

    // Preserve full stderr so failed clones can surface git's fatal message instead of only exit code 128.
    let collectedStderr = "";

    // Set up SSH askpass mediation for SSH clone URLs.
    // This allows clone to surface host-key and credential prompts through the
    // same in-app dialog used by SSH runtime probes.
    const askpass =
      isSshCloneUrl(cloneUrl) && this.sshPromptService
        ? await createMediatedAskpassSession({
            sshPromptService: this.sshPromptService,
            promptPolicy: { allowHostKey: true, allowCredential: true },
            // Deduplicate host-key prompts by SSH endpoint identity (host:port),
            // not by full repo path, so concurrent clones to the same host coalesce.
            dedupeKey: deriveSshClonePromptDedupeKey(cloneUrl),
            getStderrContext: () => collectedStderr,
          })
        : undefined;

    try {
      const child = spawn("git", ["clone", "--progress", "--", cloneUrl, cloneWorkPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(askpass?.env ?? {}) },
        // Detached children become process-group leaders on Unix so we can
        // reliably terminate clone helpers (ssh, shells) as a full tree.
        detached: process.platform !== "win32",
      });

      const stderrChunks: string[] = [];
      let resolveChunk: (() => void) | null = null;
      let processEnded = false;
      let resolveProcessExit: (() => void) | null = null;
      const processExitPromise = new Promise<void>((resolve) => {
        resolveProcessExit = resolve;
      });
      let spawnErrorMessage: string | null = null;

      const summarizeStderr = (): string | null => summarizeCloneStderr(collectedStderr);

      const notifyChunk = () => {
        if (!resolveChunk) {
          return;
        }

        if (!processEnded && stderrChunks.length === 0) {
          return;
        }

        const resolve = resolveChunk;
        resolveChunk = null;
        resolve();
      };

      const markProcessEnded = () => {
        if (processEnded) {
          return;
        }

        processEnded = true;
        notifyChunk();

        if (resolveProcessExit) {
          const resolve = resolveProcessExit;
          resolveProcessExit = null;
          resolve();
        }
      };

      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderrChunks.push(chunk);
        collectedStderr += chunk;
        notifyChunk();
      });

      child.on("error", (error: Error) => {
        spawnErrorMessage = error.message;
        markProcessEnded();
      });

      child.on("close", () => {
        markProcessEnded();
      });

      if (child.exitCode !== null || child.signalCode !== null) {
        markProcessEnded();
      }

      const terminateCloneProcess = () => {
        if (child.killed || child.exitCode !== null || child.signalCode !== null) {
          return;
        }

        if (typeof child.pid === "number" && child.pid > 0) {
          killProcessTree(child.pid);
          return;
        }

        try {
          child.kill();
        } catch {
          // Ignore ESRCH races if process exits between checks.
        }
      };

      const onAbort = () => {
        terminateCloneProcess();
        notifyChunk();
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      try {
        while (!processEnded) {
          if (stderrChunks.length > 0) {
            yield { type: "progress", line: stderrChunks.shift()! };
            continue;
          }

          await new Promise<void>((resolve) => {
            resolveChunk = resolve;
            notifyChunk();
          });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        terminateCloneProcess();
        await processExitPromise;
      }

      while (stderrChunks.length > 0) {
        yield { type: "progress", line: stderrChunks.shift()! };
      }

      if (spawnErrorMessage != null) {
        return {
          kind: "failure",
          code: "clone_failed",
          error: summarizeStderr() ?? spawnErrorMessage,
        };
      }

      if (signal?.aborted) {
        return { kind: "cancelled" };
      }

      const exitCode = child.exitCode;
      const exitSignal = child.signalCode;

      if (exitCode !== 0 || exitSignal != null) {
        const errorMessage =
          summarizeStderr() ??
          (exitSignal != null
            ? `Clone failed: process terminated by signal ${String(exitSignal)}`
            : `Clone failed with exit code ${exitCode ?? "unknown"}`);
        return {
          kind: "failure",
          code: classifySshCloneFailure({
            stderr: collectedStderr,
            promptOutcome: askpass?.getLastPromptOutcome() ?? null,
          }),
          error: withCloneReadAccessHint(errorMessage, collectedStderr),
        };
      }

      return { kind: "success" };
    } finally {
      askpass?.cleanup();
    }
  }

  async clone(
    input: CloneProjectParams
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    for await (const event of this.cloneWithProgress(input)) {
      if (event.type === "success") {
        return Ok({ projectConfig: event.projectConfig, normalizedPath: event.normalizedPath });
      }

      if (event.type === "error") {
        return Err(event.error);
      }
    }

    return Err("Clone did not return a completion event");
  }

  async remove(projectPath: string, force = false): Promise<Result<void, ProjectRemoveError>> {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    try {
      const normalizedPath = stripTrailingSlashes(projectPath);
      let config = this.config.loadConfigOrDefault();
      let projectConfig = config.projects.get(normalizedPath);

      if (!projectConfig) {
        return Err({ type: "project_not_found" as const });
      }

      if (projectConfig.parentProjectPath) {
        try {
          await this.secretsStore.updateProjectSecrets(normalizedPath, []);
        } catch (error) {
          log.error(`Failed to clean up secrets for sub-project ${normalizedPath}:`, error);
        }
        // Mutate inside the serialized editConfig transform, re-resolving the sub-project
        // and its parent from FRESH config: persisting the pre-read snapshot would clobber
        // concurrent config edits (e.g. resurrect concurrently removed workspaces).
        await this.config.editConfig((freshConfig) => {
          const freshSubProject = freshConfig.projects.get(normalizedPath);
          const parentPath = freshSubProject?.parentProjectPath;
          const parentProject = parentPath ? freshConfig.projects.get(parentPath) : undefined;
          if (parentProject) {
            for (const workspace of parentProject.workspaces) {
              if (workspace.subProjectPath === normalizedPath) {
                workspace.subProjectPath = undefined;
              }
            }
          }
          freshConfig.projects.delete(normalizedPath);
          return freshConfig;
        });
        this.mcpServerManager?.forgetProjectTrust(normalizedPath);
        return Ok(undefined);
      }

      // Self-healing: purge workspace entries whose backing directories no longer exist.
      // This handles the case where a user manually deleted workspace dirs from ~/.xum/src/.
      // Only check local/worktree runtimes — remote runtimes (SSH, Docker, devcontainer)
      // have paths on the remote host that won't exist locally.
      const localRuntimeTypes = new Set(["local", "worktree"]);
      const survivingWorkspaces: ProjectConfig["workspaces"] = [];
      for (const ws of projectConfig.workspaces) {
        const runtimeType = ws.runtimeConfig?.type;
        const isLocal = runtimeType == null || localRuntimeTypes.has(runtimeType);
        if (!isLocal) {
          survivingWorkspaces.push(ws);
          continue;
        }
        try {
          await fsPromises.access(ws.path);
          survivingWorkspaces.push(ws);
        } catch (err: unknown) {
          // Only prune when the directory is truly gone (ENOENT/ENOTDIR).
          // Other errors (EACCES, transient I/O) mean the path may still exist.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            log.info(`Pruning stale workspace entry (directory missing): ${ws.path}`);
          } else {
            log.warn(
              `Keeping workspace entry despite access error (${code ?? "unknown"}): ${ws.path}`
            );
            survivingWorkspaces.push(ws);
          }
        }
      }
      if (survivingWorkspaces.length !== projectConfig.workspaces.length) {
        // Prune inside the serialized editConfig transform, filtering the FRESH workspace
        // list by the paths verified missing above: replacing the list from the pre-read
        // snapshot would drop workspaces added concurrently (lost-update race).
        const prunedWorkspacePaths = new Set(
          projectConfig.workspaces
            .filter((ws) => !survivingWorkspaces.includes(ws))
            .map((ws) => ws.path)
        );
        await this.config.editConfig((freshConfig) => {
          const freshProject = freshConfig.projects.get(normalizedPath);
          if (freshProject) {
            freshProject.workspaces = freshProject.workspaces.filter(
              (ws) => !prunedWorkspacePaths.has(ws.path)
            );
          }
          return freshConfig;
        });
        // Re-read so the counting below reflects the persisted state.
        config = this.config.loadConfigOrDefault();
        projectConfig = config.projects.get(normalizedPath);
        if (!projectConfig) {
          return Err({ type: "project_not_found" as const });
        }
      }

      let counts = getProjectWorkspaceCounts(projectConfig.workspaces);

      const totalWorkspaces = counts.activeCount + counts.archivedCount;
      if (force && totalWorkspaces > 0) {
        // Fail fast on cross-project references BEFORE the cascade: the force
        // loop below only deletes this project's own bucket, so proceeding
        // would permanently delete owned workspaces and then still fail on the
        // external references, leaving a partially-deleted project behind.
        const crossCounts = this.countCrossProjectReferences(config, normalizedPath);
        if (crossCounts.activeCount + crossCounts.archivedCount > 0) {
          return Err({
            type: "workspace_blockers" as const,
            activeCount: counts.activeCount + crossCounts.activeCount,
            archivedCount: counts.archivedCount + crossCounts.archivedCount,
          });
        }

        if (!this.workspaceService) {
          return Err({
            type: "unknown" as const,
            message: "Failed to remove project: workspace service unavailable for cascade cleanup",
          });
        }

        const workspaceIdsByPath = new Map<string, string>();

        if (projectConfig.workspaces.some((workspace) => !workspace.id)) {
          const allWorkspaceMetadata = await this.config.getAllWorkspaceMetadata();
          for (const metadata of allWorkspaceMetadata) {
            if (metadata.projectPath !== normalizedPath) {
              continue;
            }
            workspaceIdsByPath.set(metadata.namedWorkspacePath, metadata.id);
          }
        }

        for (const workspace of orderWorkspacesForCascadeRemoval(projectConfig.workspaces)) {
          // Legacy workspace entries can be missing `id`. Resolve through metadata so
          // WorkspaceService.remove() receives the canonical workspace ID (it cannot remove by path).
          const workspaceId = workspace.id ?? workspaceIdsByPath.get(workspace.path);
          if (!workspaceId) {
            return Err({
              type: "unknown" as const,
              message: `Failed to remove project: Failed to resolve workspace ID for ${workspace.path}`,
            });
          }

          const removeResult = await this.workspaceService.remove(workspaceId, true);
          if (!removeResult.success) {
            return Err({
              type: "unknown" as const,
              message: `Failed to remove project: Failed to delete workspace ${workspaceId}: ${removeResult.error}`,
            });
          }
        }

        config = this.config.loadConfigOrDefault();
        projectConfig = config.projects.get(normalizedPath);
        if (!projectConfig) {
          return Err({ type: "project_not_found" as const });
        }
        counts = getProjectWorkspaceCounts(projectConfig.workspaces);
      }

      // Also count multi-project workspace references to this project from OTHER
      // project buckets (recomputed from the post-cascade config snapshot).
      const crossProjectCounts = this.countCrossProjectReferences(config, normalizedPath);
      counts = {
        activeCount: counts.activeCount + crossProjectCounts.activeCount,
        archivedCount: counts.archivedCount + crossProjectCounts.archivedCount,
      };

      if (counts.activeCount + counts.archivedCount > 0) {
        return Err({ type: "workspace_blockers" as const, ...counts });
      }

      // Delete inside the serialized editConfig transform, re-collecting sub-projects from
      // FRESH config: persisting the pre-read snapshot would clobber concurrent config
      // edits (e.g. resurrect concurrently removed workspaces in other projects).
      const removedSubProjectPaths: string[] = [];
      await this.config.editConfig((freshConfig) => {
        removedSubProjectPaths.length = 0;
        for (const [candidatePath, candidateConfig] of Array.from(freshConfig.projects.entries())) {
          if (candidateConfig.parentProjectPath === normalizedPath) {
            removedSubProjectPaths.push(candidatePath);
            freshConfig.projects.delete(candidatePath);
          }
        }
        freshConfig.projects.delete(normalizedPath);
        return freshConfig;
      });

      for (const subProjectPath of removedSubProjectPaths) {
        try {
          await this.secretsStore.updateProjectSecrets(subProjectPath, []);
        } catch (error) {
          log.error(`Failed to clean up secrets for sub-project ${subProjectPath}:`, error);
        }
      }

      try {
        await this.secretsStore.updateProjectSecrets(normalizedPath, []);
      } catch (error) {
        log.error(`Failed to clean up secrets for project ${normalizedPath}:`, error);
      }

      for (const removedPath of [normalizedPath, ...removedSubProjectPaths]) {
        this.mcpServerManager?.forgetProjectTrust(removedPath);
      }
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err({ type: "unknown" as const, message: `Failed to remove project: ${message}` });
    }
  }

  /**
   * Count multi-project workspace references to this project stored in OTHER
   * project buckets. Multi-project workspaces can live under _multi
   * (interactive creation) or any project bucket (task/fork creation).
   */
  private countCrossProjectReferences(
    config: { projects: Map<string, ProjectConfig> },
    normalizedPath: string
  ): ProjectWorkspaceCounts {
    let activeCount = 0;
    let archivedCount = 0;
    for (const [configKey, otherConfig] of config.projects) {
      if (configKey === normalizedPath) {
        // Project workspaces in this bucket are counted by the caller.
        continue;
      }

      const referencingWorkspaces = otherConfig.workspaces.filter((workspace) =>
        workspace.projects?.some(
          (project) => stripTrailingSlashes(project.projectPath) === normalizedPath
        )
      );

      if (referencingWorkspaces.length === 0) {
        continue;
      }

      const referencingWorkspaceCounts = getProjectWorkspaceCounts(referencingWorkspaces);
      activeCount += referencingWorkspaceCounts.activeCount;
      archivedCount += referencingWorkspaceCounts.archivedCount;
    }
    return { activeCount, archivedCount };
  }

  /**
   * Read-only removal preflight: reports the same blocker counts remove()
   * enforces (own bucket + cross-project references) WITHOUT remove()'s side
   * effects (stale-entry pruning, deletion of empty projects). The delete
   * confirmation dialog needs this because projects.list no longer carries
   * archived workspaces to count client-side.
   */
  getRemovalBlockers(projectPath: string): ProjectWorkspaceCounts {
    const normalizedPath = stripTrailingSlashes(projectPath);
    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(normalizedPath);
    if (!projectConfig) {
      return { activeCount: 0, archivedCount: 0 };
    }
    const ownCounts = getProjectWorkspaceCounts(projectConfig.workspaces);
    const crossCounts = this.countCrossProjectReferences(config, normalizedPath);
    return {
      activeCount: ownCounts.activeCount + crossCounts.activeCount,
      archivedCount: ownCounts.archivedCount + crossCounts.archivedCount,
    };
  }

  list(): Array<[string, ProjectConfig]> {
    try {
      const config = this.config.loadConfigOrDefault();
      // Read-side projection: exclude archived workspaces from the listing. On
      // archive-heavy configs they dominate the payload (measured 84% of a
      // 1.1 MB projects.list response re-fetched on every config change), and
      // the UI loads archived workspaces on demand via
      // workspace.list({ archived: true }). Build new arrays instead of
      // mutating the loaded config: persisted config.json must keep archived
      // entries (upgrade/downgrade safety).
      return Array.from(deriveProjectHierarchy(config.projects).entries()).map(
        ([projectPath, project]): [string, ProjectConfig] => [
          projectPath,
          {
            ...project,
            workspaces: project.workspaces.filter(
              (workspace) => !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
            ),
          },
        ]
      );
    } catch (error) {
      log.error("Failed to list projects:", error);
      return [];
    }
  }

  async listBranches(projectPath: string): Promise<BranchListResult> {
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      throw new Error("Project path is required to list branches");
    }
    try {
      const validation = await validateProjectPath(projectPath);
      if (!validation.valid) {
        throw new Error(validation.error ?? "Invalid project path");
      }
      const normalizedPath = validation.expandedPath!;

      // Non-git repos return empty branches - they're restricted to local runtime only.
      // Use `git rev-parse --is-inside-work-tree` so sub-projects (whose .git lives
      // in a parent directory) still surface the surrounding repo's branches and
      // don't trigger the "git init" banner.
      if (!(await isInsideGitRepository(normalizedPath))) {
        return { branches: [], recommendedTrunk: null };
      }

      const branches = await listLocalBranches(normalizedPath);

      // Empty branches means the repo is unborn (git init but no commits yet)
      // Return empty branches - frontend will show the git init banner since no branches exist
      // After user creates a commit, branches will populate
      if (branches.length === 0) {
        return { branches: [], recommendedTrunk: null };
      }

      const recommendedTrunk = await detectDefaultTrunkBranch(normalizedPath, branches);
      return { branches, recommendedTrunk };
    } catch (error) {
      log.error("Failed to list branches:", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Reports whether it created the `.git` directory so callers can roll that back. */
  private async initializeGitRepository(
    normalizedPath: string
  ): Promise<Result<{ initializedGitDir: boolean }>> {
    // Set before running `git init`: even a failing init can leave a partial .git
    // behind (e.g. a broken init template), which must be rolled back too.
    let initializedGitDir = false;
    try {
      const isGitRepo = await isGitRepository(normalizedPath);

      if (isGitRepo) {
        const branches = await listLocalBranches(normalizedPath);
        if (branches.length > 0) {
          return Err("Directory is already a git repository with commits");
        }
      } else {
        initializedGitDir = true;
        using initProc = execFileAsync("git", ["-C", normalizedPath, "init", "-b", "main"], {
          // Inherited repository selectors (GIT_DIR/GIT_WORK_TREE) win over -C and
          // would redirect init/commit into an unrelated external repository.
          env: GIT_SCOPE_ENV_UNSET,
        });
        await initProc.result;
      }

      // A born branch is required by worktree and SSH runtimes. Keep the fallback
      // identity scoped to this initial commit instead of changing repository config.
      using commitProc = execFileAsync(
        "git",
        [
          "-C",
          normalizedPath,
          "-c",
          "user.name=mux",
          "-c",
          "user.email=mux@localhost",
          "commit",
          "--allow-empty",
          "-m",
          "Initial commit",
        ],
        { env: GIT_SCOPE_ENV_UNSET }
      );
      await commitProc.result;

      this.fileCompletionsCache.delete(normalizedPath);
      return Ok({ initializedGitDir });
    } catch (error) {
      // Roll back a .git we created (or that a failed init left partially behind) so
      // the directory returns to its prior state and a retry is not rejected as
      // non-empty (e.g. when the initial commit fails).
      if (initializedGitDir) {
        await fsPromises
          .rm(path.join(normalizedPath, ".git"), { recursive: true, force: true })
          .catch((cleanupError: unknown) => {
            log.error(`Failed to roll back git init in ${normalizedPath}:`, cleanupError);
          });
      }
      const message = getErrorMessage(error);
      log.error("Failed to initialize git repository:", error);
      return Err(`Failed to initialize git repository: ${message}`);
    }
  }

  /**
   * Initialize a git repository in the project directory.
   * Runs `git init` and creates an initial commit so branches exist.
   * Also handles "unborn" repos (git init already run but no commits yet).
   */
  async gitInit(projectPath: string): Promise<Result<void>> {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      return Err("Project path is required");
    }
    let claimKey: string | null = null;
    try {
      const validation = await validateProjectPath(projectPath);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid project path");
      }
      const normalizedPath = validation.expandedPath!;
      // Same exclusive claim as create(): concurrent initializations of one directory
      // could double-commit or let one call's failure rollback delete the other's .git.
      const canonicalPath = await resolveRealProjectPath(normalizedPath).catch(
        () => normalizedPath
      );
      if (this.activeGitInits.has(canonicalPath)) {
        return Err("Another project creation is already initializing this directory");
      }
      this.activeGitInits.add(canonicalPath);
      claimKey = canonicalPath;
      const result = await this.initializeGitRepository(normalizedPath);
      return result.success ? Ok(undefined) : result;
    } catch (error) {
      const message = getErrorMessage(error);
      log.error("Failed to initialize git repository:", error);
      return Err(`Failed to initialize git repository: ${message}`);
    } finally {
      if (claimKey) {
        this.activeGitInits.delete(claimKey);
      }
    }
  }

  async getFileCompletions(
    projectPath: string,
    query: string,
    limit?: number
  ): Promise<{ paths: string[] }> {
    const resolvedLimit = limit ?? 20;

    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      return { paths: [] };
    }

    const validation = await validateProjectPath(projectPath);
    if (!validation.valid) {
      return { paths: [] };
    }

    const normalizedPath = validation.expandedPath!;

    let cacheEntry = this.fileCompletionsCache.get(normalizedPath);
    if (!cacheEntry) {
      cacheEntry = { index: EMPTY_FILE_COMPLETIONS_INDEX, fetchedAt: 0 };
      this.fileCompletionsCache.set(normalizedPath, cacheEntry);
    }

    const now = Date.now();
    const isStale =
      cacheEntry.fetchedAt === 0 || now - cacheEntry.fetchedAt > FILE_COMPLETIONS_CACHE_TTL_MS;

    if (isStale && !cacheEntry.refreshing) {
      cacheEntry.refreshing = (async () => {
        try {
          // Sub-projects share a parent git repository; match branch listing by
          // accepting any path inside a work tree rather than requiring `.git`
          // directly under the project directory.
          if (!(await isInsideGitRepository(normalizedPath))) {
            cacheEntry.index = EMPTY_FILE_COMPLETIONS_INDEX;
            return;
          }

          using proc = execFileAsync("git", [
            "-C",
            normalizedPath,
            "ls-files",
            "-co",
            "--exclude-standard",
          ]);
          const { stdout } = await proc.result;

          const files = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            // File @mentions are whitespace-delimited (extractAtMentions uses /@(\\S+)/), so
            // suggestions containing spaces would be inserted incorrectly (e.g. "@foo bar.ts").
            .filter((filePath) => !/\s/.test(filePath));

          cacheEntry.index = buildFileCompletionsIndex(files);
        } catch (error) {
          log.debug("getFileCompletions: failed to list files", {
            projectPath: normalizedPath,
            error: getErrorMessage(error),
          });
        } finally {
          cacheEntry.fetchedAt = Date.now();
          cacheEntry.refreshing = undefined;
        }
      })();
    }

    if (cacheEntry.fetchedAt === 0 && cacheEntry.refreshing) {
      await cacheEntry.refreshing;
    }

    return { paths: searchFileCompletions(cacheEntry.index, query, resolvedLimit) };
  }

  getSecrets(projectPath: string): Secret[] {
    try {
      return this.secretsStore.getProjectSecrets(projectPath);
    } catch (error) {
      log.error("Failed to get project secrets:", error);
      return [];
    }
  }

  async listDirectory(path: string) {
    try {
      const tree = await listDirectory(path);
      return { success: true as const, data: tree };
    } catch (error) {
      return {
        success: false as const,
        error: getErrorMessage(error),
      };
    }
  }

  async createDirectory(
    requestedPath: string
  ): Promise<Result<{ normalizedPath: string }, string>> {
    try {
      // Expand ~ to home directory
      const expanded =
        requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
          ? expandTilde(requestedPath)
          : requestedPath;
      const normalizedPath = path.resolve(expanded);

      await fsPromises.mkdir(normalizedPath, { recursive: true });
      return Ok({ normalizedPath });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to create directory: ${message}`);
    }
  }

  async updateSecrets(projectPath: string, secrets: Secret[]): Promise<Result<void>> {
    try {
      await this.secretsStore.updateProjectSecrets(projectPath, secrets);
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update project secrets: ${message}`);
    }
  }

  /**
   * Get idle compaction hours setting for a project.
   * Returns null if disabled or project not found.
   */
  getIdleCompactionHours(projectPath: string): number | null {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);
      return project?.idleCompactionHours ?? null;
    } catch (error) {
      log.error("Failed to get idle compaction hours:", error);
      return null;
    }
  }

  /**
   * Set idle compaction hours for a project.
   * Pass null to disable idle compaction.
   */
  async setIdleCompactionHours(projectPath: string, hours: number | null): Promise<Result<void>> {
    try {
      // Mutate inside the serialized editConfig transform, re-finding the project from
      // FRESH config: persisting a pre-read snapshot loses concurrent config edits.
      let result: Result<void> = Err(`Project not found: ${projectPath}`);
      await this.config.editConfig((freshConfig) => {
        const project = freshConfig.projects.get(projectPath);
        if (project) {
          project.idleCompactionHours = hours;
          result = Ok(undefined);
        }
        return freshConfig;
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set idle compaction hours: ${message}`);
    }
  }

  async setTrust(projectPath: string, trusted: boolean): Promise<void> {
    const normalizedPath = stripTrailingSlashes(projectPath);
    await this.config.editConfig((config) => {
      let project = config.projects.get(normalizedPath);
      if (!project) {
        project = { workspaces: [] };
        config.projects.set(normalizedPath, project);
      }
      project.trusted = trusted;
      return config;
    });

    const affectedPaths = [normalizedPath];
    for (const [candidatePath, project] of this.config.loadConfigOrDefault().projects) {
      if (
        project.parentProjectPath !== undefined &&
        stripTrailingSlashes(project.parentProjectPath) === normalizedPath
      ) {
        affectedPaths.push(candidatePath);
      }
    }
    this.mcpServerManager?.applyProjectTrust(
      affectedPaths.map((candidatePath) => ({
        projectPath: candidatePath,
        trusted: isProjectTrusted(this.config, candidatePath),
      }))
    );
  }

  async setDisplayName(projectPath: string, displayName: string | null | undefined): Promise<void> {
    const normalizedPath = stripTrailingSlashes(projectPath);
    await this.config.editConfig((config) => {
      const project = config.projects.get(normalizedPath);
      if (!project) {
        throw new Error(`Project not found: ${normalizedPath}`);
      }
      project.displayName = displayName ?? undefined;
      return config;
    });
  }

  async setColor(projectPath: string, color: string | null | undefined): Promise<void> {
    const normalizedPath = stripTrailingSlashes(projectPath);
    await this.config.editConfig((config) => {
      const project = config.projects.get(normalizedPath);
      if (!project) {
        throw new Error(`Project not found: ${normalizedPath}`);
      }
      project.color = color ?? undefined;
      return config;
    });
  }

  async setCustomInstructions(
    projectPath: string,
    customInstructions: string | null | undefined
  ): Promise<void> {
    const normalizedPath = stripTrailingSlashes(projectPath);
    await this.config.editConfig((config) => {
      const project = config.projects.get(normalizedPath);
      if (!project) {
        throw new Error(`Project not found: ${normalizedPath}`);
      }
      project.customInstructions = customInstructions?.trim() ? customInstructions : undefined;
      return config;
    });
  }

  async setCodeWorkspaceSyncPath(
    projectPath: string,
    codeWorkspaceSyncPath: string | null | undefined
  ): Promise<void> {
    const normalizedPath = stripTrailingSlashes(projectPath);
    const trimmed = codeWorkspaceSyncPath?.trim() ?? "";
    if (trimmed && !trimmed.endsWith(CODE_WORKSPACE_EXTENSION)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Path must end with ${CODE_WORKSPACE_EXTENSION}`,
      });
    }

    let previousValue: string | undefined;
    await this.config.editConfig((config) => {
      const project = config.projects.get(normalizedPath);
      if (!project) {
        throw new Error(`Project not found: ${normalizedPath}`);
      }
      previousValue = project.codeWorkspaceSyncPath;
      project.codeWorkspaceSyncPath = trimmed || undefined;
      return config;
    });

    if (!trimmed) {
      return;
    }
    const result = await syncProjectCodeWorkspace(this.config, normalizedPath);
    if (result.ok) {
      return;
    }
    await this.config.editConfig((config) => {
      const project = config.projects.get(normalizedPath);
      if (project?.codeWorkspaceSyncPath === trimmed) {
        project.codeWorkspaceSyncPath = previousValue;
      }
      return config;
    });
    throw new ORPCError("BAD_REQUEST", { message: result.error });
  }
  // ─────────────────────────────────────────────────────────────────────────────
  // Section Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Re-home a workspace into a sub-project (or back to the parent with null).
   * This intentionally changes only the cwd/prompt context pointer; the parent
   * project keeps owning the checkout and branch because sub-projects share one git repo.
   */
  async assignWorkspaceToSubProject(
    projectPath: string,
    workspaceId: string,
    subProjectPath: string | null
  ): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const requestedProject = config.projects.get(projectPath);

      if (!requestedProject) {
        return Err(`Project not found: ${projectPath}`);
      }

      // Match workspace creation: callers may identify the current sub-project,
      // but the workspace row itself is stored in the parent project's bucket.
      const owningProjectPath = requestedProject.parentProjectPath ?? projectPath;
      const owningProject = config.projects.get(owningProjectPath);
      if (!owningProject) {
        return Err(`Project not found: ${owningProjectPath}`);
      }

      if (subProjectPath !== null) {
        const subProject = config.projects.get(subProjectPath);
        if (subProject?.parentProjectPath !== owningProjectPath) {
          return Err(`Sub-project not found under parent: ${subProjectPath}`);
        }
      }

      if (!owningProject.workspaces.some((w) => w.id === workspaceId)) {
        return Err(`Workspace not found: ${workspaceId}`);
      }

      // Mutate inside the serialized editConfig transform, re-finding the workspace from
      // FRESH config: persisting a pre-read snapshot loses concurrent config edits (e.g.
      // resurrects concurrently removed workspaces). Entry gone meanwhile → Err.
      let result: Result<void> = Err(`Workspace not found: ${workspaceId}`);
      await this.config.editConfig((freshConfig) => {
        // Re-validate the target sub-project against FRESH config: it can be removed or
        // re-parented while this edit is queued, and send/runtime paths consume
        // metadata.subProjectPath as the execution root — never persist a stale pointer.
        if (subProjectPath !== null) {
          const freshSubProject = freshConfig.projects.get(subProjectPath);
          if (freshSubProject?.parentProjectPath !== owningProjectPath) {
            result = Err(`Sub-project not found under parent: ${subProjectPath}`);
            return freshConfig;
          }
        }
        const freshWorkspace = freshConfig.projects
          .get(owningProjectPath)
          ?.workspaces.find((w) => w.id === workspaceId);
        if (freshWorkspace) {
          freshWorkspace.subProjectPath = subProjectPath ?? undefined;
          result = Ok(undefined);
        }
        return freshConfig;
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to assign workspace to sub-project: ${message}`);
    }
  }

  async assignWorkspaceToSubProjectAndSync(
    projectPath: string,
    workspaceId: string,
    subProjectPath: string | null
  ): Promise<Result<void>> {
    const previousMetadata = (await this.config.getAllWorkspaceMetadata()).find(
      (metadata) => metadata.id === workspaceId
    );
    const result = await this.assignWorkspaceToSubProject(projectPath, workspaceId, subProjectPath);
    if (!result.success) {
      return result;
    }

    await this.workspaceMetadataRefresher?.refreshAndEmitMetadata(workspaceId);
    if (subProjectPath !== null) {
      await syncProjectCodeWorkspace(this.config, subProjectPath);
    }
    const previousSubProjectPath =
      previousMetadata?.subProjectPath != null
        ? stripTrailingSlashes(previousMetadata.subProjectPath)
        : null;
    const newSubProjectPath = subProjectPath !== null ? stripTrailingSlashes(subProjectPath) : null;
    if (
      previousMetadata &&
      previousSubProjectPath !== null &&
      previousSubProjectPath !== newSubProjectPath
    ) {
      await syncProjectCodeWorkspace(this.config, previousSubProjectPath, {
        extraManagedRootDirs: managedRootsByProject(previousMetadata).get(previousSubProjectPath),
      });
    }
    return result;
  }
}
