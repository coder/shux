import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import {
  PROJECT_METADATA_DIR_NAMES,
  getCanonicalProjectMetadataRelativePath,
} from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config, ProjectsConfig } from "@/node/config";
import { type createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { isCanonicalPluginServerKey } from "@/node/services/agentPlugins/mcpConfig";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";

const MCP_OVERRIDE_FILENAMES = ["mcp.local.jsonc", "mcp.local.json"] as const;
const MCP_OVERRIDES_GITIGNORE_PATTERNS = PROJECT_METADATA_DIR_NAMES.flatMap((dirName) =>
  MCP_OVERRIDE_FILENAMES.map((filename) => `${dirName}/${filename}`)
);

function joinForRuntime(runtimeConfig: RuntimeConfig | undefined, ...parts: string[]): string {
  assert(parts.length > 0, "joinForRuntime requires at least one path segment");

  // Remote runtimes run inside a POSIX shell (SSH host, Docker container), even if the user is
  // running mux on Windows. Use POSIX joins so we don't accidentally introduce backslashes.
  const usePosix = runtimeConfig?.type === "ssh" || runtimeConfig?.type === "docker";
  return usePosix ? path.posix.join(...parts) : path.join(...parts);
}

function isAbsoluteForRuntime(runtimeConfig: RuntimeConfig | undefined, filePath: string): boolean {
  const usePosix = runtimeConfig?.type === "ssh" || runtimeConfig?.type === "docker";
  return usePosix ? path.posix.isAbsolute(filePath) : path.isAbsolute(filePath);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function normalizeWorkspaceMcpOverrides(raw: unknown): WorkspaceMCPOverrides {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const obj = raw as {
    disabledServers?: unknown;
    enabledServers?: unknown;
    toolAllowlist?: unknown;
  };

  const disabledServers = isStringArray(obj.disabledServers)
    ? [...new Set(obj.disabledServers.map((s) => s.trim()).filter(Boolean))]
    : undefined;

  const enabledServers = isStringArray(obj.enabledServers)
    ? [...new Set(obj.enabledServers.map((s) => s.trim()).filter(Boolean))]
    : undefined;

  let toolAllowlist: Record<string, string[]> | undefined;
  if (
    obj.toolAllowlist &&
    typeof obj.toolAllowlist === "object" &&
    !Array.isArray(obj.toolAllowlist)
  ) {
    const next: Record<string, string[]> = {};
    for (const [serverName, value] of Object.entries(
      obj.toolAllowlist as Record<string, unknown>
    )) {
      if (!serverName || typeof serverName !== "string") continue;
      if (!isStringArray(value)) continue;

      // Empty array is meaningful ("expose no tools"), so keep it.
      next[serverName] = [...new Set(value.map((t) => t.trim()).filter((t) => t.length > 0))];
    }

    if (Object.keys(next).length > 0) {
      toolAllowlist = next;
    }
  }

  const normalized: WorkspaceMCPOverrides = {
    disabledServers: disabledServers && disabledServers.length > 0 ? disabledServers : undefined,
    enabledServers: enabledServers && enabledServers.length > 0 ? enabledServers : undefined,
    toolAllowlist,
  };

  // Drop empty object to keep persistence clean.
  if (!normalized.disabledServers && !normalized.enabledServers && !normalized.toolAllowlist) {
    return {};
  }

  return normalized;
}

/**
 * Opaque revision token for optimistic-concurrency saves. Derived from the
 * normalized overrides content, so any successful write (including the Agent
 * Plugin uninstaller pruning `plugin:` keys) changes the revision and stale
 * snapshots held by an open Workspace MCP dialog are rejected instead of
 * silently restoring removed entries.
 */
function computeOverridesRevision(overrides: WorkspaceMCPOverrides): string {
  return createHash("sha256").update(JSON.stringify(overrides)).digest("hex").slice(0, 16);
}

/** Thrown when a save's expectedRevision no longer matches the stored overrides. */
export class WorkspaceMcpOverridesConflictError extends Error {
  constructor() {
    super(
      "Workspace MCP settings changed while this dialog was open. " +
        "Close and reopen it to load the latest values, then reapply your changes."
    );
    this.name = "WorkspaceMcpOverridesConflictError";
  }
}

function isEmptyOverrides(overrides: WorkspaceMCPOverrides): boolean {
  return (
    (!overrides.disabledServers || overrides.disabledServers.length === 0) &&
    (!overrides.enabledServers || overrides.enabledServers.length === 0) &&
    (!overrides.toolAllowlist || Object.keys(overrides.toolAllowlist).length === 0)
  );
}

/** True when the error (or its RuntimeError-wrapped cause) carries the fs code. */
function hasFsCode(error: unknown, code: string): boolean {
  if (hasErrorCode(error, code)) {
    return true;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  return hasErrorCode(cause, code);
}

/**
 * SECURITY: prune writes must land inside the checkout they intend to edit.
 * Rejects a symlink at the override file itself and any resolved location
 * escaping the (canonicalized) workspace root, which covers symlinked parent
 * segments like a tracked `.mux -> /elsewhere` link. See the call site for
 * the threat model.
 */
async function assertPruneTargetNotSymlinked(
  filePath: string,
  workspacePath: string
): Promise<void> {
  const lstat = await fsPromises.lstat(filePath);
  if (lstat.isSymbolicLink()) {
    throw new Error(
      `Workspace MCP overrides file is a symbolic link, refusing to modify it: ${filePath}`
    );
  }
  const resolvedFile = await fsPromises.realpath(filePath);
  const resolvedRoot = await fsPromises.realpath(workspacePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Workspace MCP overrides file resolves outside the workspace, refusing to modify it: ${filePath}`
    );
  }
}

async function statIsFile(
  runtime: ReturnType<typeof createRuntime>,
  filePath: string,
  mode: "lenient" | "strict"
): Promise<boolean> {
  try {
    const stat = await runtime.stat(filePath);
    return !stat.isDirectory;
  } catch (error) {
    // Strict callers must distinguish "file genuinely absent" (fine: no
    // overrides) from "cannot tell" (EACCES, I/O error): treating the latter
    // as absent would let the plugin uninstaller retire a prune tombstone
    // against a file it never actually read. Strict reads only run against
    // local/worktree runtimes, so node fs error codes are reliable here
    // (RuntimeError wraps them as `cause`).
    if (mode === "strict" && !hasFsCode(error, "ENOENT") && !hasFsCode(error, "ENOTDIR")) {
      throw error;
    }
    return false;
  }
}

/** A workspace's metadata with its runtime and checkout path resolved. */
interface ResolvedWorkspace {
  metadata: FrontendWorkspaceMetadata;
  runtime: ReturnType<typeof createRuntime>;
  workspacePath: string;
}

export class WorkspaceMcpOverridesService {
  constructor(private readonly config: Config) {
    assert(config, "WorkspaceMcpOverridesService requires a Config instance");
  }

  private async getWorkspaceMetadata(workspaceId: string): Promise<FrontendWorkspaceMetadata> {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const all = await this.config.getAllWorkspaceMetadata();
    const metadata = all.find((m) => m.id === trimmed);
    if (!metadata) {
      throw new Error(`Workspace metadata not found for ${trimmed}`);
    }

    return metadata;
  }

  private getLegacyOverridesFromConfig(
    workspaceId: string,
    config: ProjectsConfig = this.config.loadConfigOrDefault()
  ): WorkspaceMCPOverrides | undefined {
    for (const [_projectPath, projectConfig] of config.projects) {
      const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        // NOTE: Legacy storage (PR #1180) wrote overrides into ~/.mux/config.json.
        // We keep reading it here only to migrate into the workspace-local file.
        return workspace.mcp;
      }
    }

    return undefined;
  }

  private async clearLegacyOverridesInConfig(workspaceId: string): Promise<void> {
    await this.config.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          delete workspace.mcp;
          return config;
        }
      }
      return config;
    });
  }

  private async getRuntimeAndWorkspacePath(workspaceId: string): Promise<ResolvedWorkspace> {
    return this.resolveWorkspace(await this.getWorkspaceMetadata(workspaceId));
  }

  private resolveWorkspace(metadata: FrontendWorkspaceMetadata): ResolvedWorkspace {
    const runtime = createRuntimeForWorkspace(metadata);

    // In-place workspaces (CLI/benchmarks) store the workspace path directly by setting
    // metadata.projectPath === metadata.name.
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    assert(
      typeof workspacePath === "string" && workspacePath.length > 0,
      "workspacePath is required"
    );

    return { metadata, runtime, workspacePath };
  }

  private getOverridesFilePaths(
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): string[] {
    assert(typeof workspacePath === "string", "workspacePath must be a string");
    return MCP_OVERRIDES_GITIGNORE_PATTERNS.map((relativePath) =>
      joinForRuntime(runtimeConfig, workspacePath, relativePath)
    );
  }

  private async readOverridesFile(
    runtime: ReturnType<typeof createRuntime>,
    filePath: string,
    mode: "lenient" | "strict"
  ): Promise<unknown> {
    try {
      const raw = await readFileString(runtime, filePath);
      const errors: jsonc.ParseError[] = [];
      const parsed: unknown = jsonc.parse(raw, errors) as unknown;
      if (errors.length > 0) {
        // Strict callers (the plugin uninstaller's override prune) must not
        // see "{}" for a file whose real content is unreadable: retiring a
        // prune tombstone against that empty view would let the stale
        // enabledServers key silently re-enable a reinstalled plugin's
        // server once the file becomes readable again.
        if (mode === "strict") {
          throw new Error(`Workspace MCP overrides file has JSONC parse errors: ${filePath}`);
        }
        log.warn("[MCP] Failed to parse workspace MCP overrides (JSONC parse errors)", {
          filePath,
          errorCount: errors.length,
        });
        return {};
      }
      return parsed;
    } catch (error) {
      if (mode === "strict") {
        throw error;
      }
      // Treat any read failure as "no overrides".
      log.debug("[MCP] Failed to read workspace MCP overrides file", { filePath, error });
      return {};
    }
  }

  private async ensureOverridesDir(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): Promise<void> {
    const overridesDir = getCanonicalProjectMetadataRelativePath("");
    const overridesDirPath = joinForRuntime(runtimeConfig, workspacePath, overridesDir);

    try {
      await runtime.ensureDir(overridesDirPath);
    } catch (err) {
      throw new Error(`Failed to create ${overridesDir} directory: ${getErrorMessage(err)}`);
    }
  }

  private async ensureOverridesGitignored(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): Promise<void> {
    try {
      const isInsideGitResult = await execBuffered(runtime, "git rev-parse --is-inside-work-tree", {
        cwd: workspacePath,
        timeout: 10,
      });
      if (isInsideGitResult.exitCode !== 0 || isInsideGitResult.stdout.trim() !== "true") {
        return;
      }

      const excludePathResult = await execBuffered(
        runtime,
        "git rev-parse --git-path info/exclude",
        {
          cwd: workspacePath,
          timeout: 10,
        }
      );
      if (excludePathResult.exitCode !== 0) {
        return;
      }

      const excludeFilePathRaw = excludePathResult.stdout.trim();
      if (excludeFilePathRaw.length === 0) {
        return;
      }

      const excludeFilePath = isAbsoluteForRuntime(runtimeConfig, excludeFilePathRaw)
        ? excludeFilePathRaw
        : joinForRuntime(runtimeConfig, workspacePath, excludeFilePathRaw);

      let existing = "";
      try {
        existing = await readFileString(runtime, excludeFilePath);
      } catch {
        // Missing exclude file is OK.
      }

      const existingPatterns = new Set(
        existing
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      );
      const missingPatterns = MCP_OVERRIDES_GITIGNORE_PATTERNS.filter(
        (pattern) => !existingPatterns.has(pattern)
      );
      if (missingPatterns.length === 0) {
        return;
      }

      const needsNewline = existing.length > 0 && !existing.endsWith("\n");
      const updated = existing + (needsNewline ? "\n" : "") + missingPatterns.join("\n") + "\n";

      await writeFileString(runtime, excludeFilePath, updated);
    } catch (error) {
      // Best-effort only; never fail a workspace operation because git ignore couldn't be updated.
      log.debug("[MCP] Failed to add workspace MCP overrides file to git exclude", {
        workspacePath,
        error,
      });
    }
  }

  private async removeOverridesFile(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string
  ): Promise<void> {
    // Remove canonical and legacy file names so no conflicting source remains.
    // The exit code MUST be checked: callers (e.g. the Agent Plugin
    // uninstaller retiring override-prune tombstones) rely on
    // setOverridesForWorkspace rejecting when clearing overrides failed —
    // a swallowed `rm` failure would leave a stale enabledServers key that
    // a plugin reinstall could silently reactivate.
    const paths = MCP_OVERRIDES_GITIGNORE_PATTERNS.map((filePath) => `"${filePath}"`).join(" ");
    const result = await execBuffered(runtime, `rm -f ${paths}`, {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to remove workspace MCP overrides file: ${result.stderr.trim() || `rm exited with code ${result.exitCode}`}`
      );
    }
  }

  /**
   * Read workspace MCP overrides from <workspace>/.xum/mcp.local.jsonc.
   *
   * If the file doesn't exist, we fall back to legacy overrides stored in ~/.mux/config.json
   * and migrate them into the workspace-local file.
   *
   * The returned revision is an opaque token for setOverridesForWorkspace's
   * expectedRevision check.
   */
  async getOverridesForWorkspace(
    workspaceId: string,
    options?: { mode?: "lenient" | "strict" }
  ): Promise<{ overrides: WorkspaceMCPOverrides; revision: string }> {
    const overrides = await this.loadOverrides(workspaceId, options?.mode ?? "lenient");
    return { overrides, revision: computeOverridesRevision(overrides) };
  }

  private async loadOverrides(
    workspaceId: string,
    mode: "lenient" | "strict" = "lenient"
  ): Promise<WorkspaceMCPOverrides> {
    return this.loadOverridesForResolved(await this.getRuntimeAndWorkspacePath(workspaceId), mode);
  }

  /**
   * `legacyConfig` lets batch callers reuse one config snapshot: loading
   * config.json is a synchronous full parse, so re-reading it per workspace
   * made a 2000-workspace sweep take tens of minutes.
   */
  private async loadOverridesForResolved(
    resolved: ResolvedWorkspace,
    mode: "lenient" | "strict",
    legacyConfig?: ProjectsConfig
  ): Promise<WorkspaceMCPOverrides> {
    const { metadata, runtime, workspacePath } = resolved;
    const workspaceId = metadata.id;
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);
    const canonicalPath = filePaths[0];

    for (const filePath of filePaths) {
      if (await statIsFile(runtime, filePath, mode)) {
        return normalizeWorkspaceMcpOverrides(
          await this.readOverridesFile(runtime, filePath, mode)
        );
      }
    }

    // No workspace-local file => try migrating legacy config.json storage.
    const legacy = this.getLegacyOverridesFromConfig(workspaceId, legacyConfig);
    if (!legacy || isEmptyOverrides(legacy)) {
      return {};
    }

    const normalizedLegacy = normalizeWorkspaceMcpOverrides(legacy);
    if (isEmptyOverrides(normalizedLegacy)) {
      return {};
    }

    try {
      await this.ensureOverridesDir(runtime, workspacePath, metadata.runtimeConfig);
      await writeFileString(
        runtime,
        canonicalPath,
        JSON.stringify(normalizedLegacy, null, 2) + "\n"
      );
      await this.ensureOverridesGitignored(runtime, workspacePath, metadata.runtimeConfig);
      await this.clearLegacyOverridesInConfig(workspaceId);
      log.info("[MCP] Migrated workspace MCP overrides from config.json", {
        workspaceId,
        filePath: canonicalPath,
      });
    } catch (error) {
      // Migration is best-effort; if it fails, still honor legacy overrides.
      log.warn("[MCP] Failed to migrate workspace MCP overrides; using legacy config.json values", {
        workspaceId,
        error,
      });
    }

    return normalizedLegacy;
  }

  /**
   * All writes flow through this queue AND a cross-process file lock so the
   * expectedRevision check-and-set in setOverridesForWorkspace is atomic
   * across every writer. The in-process queue alone is not enough: two
   * processes sharing one Xum home (ALLOW_MULTIPLE_INSTANCES, a desktop app
   * alongside `xum server`) each have their own queue, so both could pass
   * the CAS on the same revision and the last write would silently discard
   * the other's changes — worse, a save whose plugin-key validation ran
   * before another process's uninstall could land AFTER that uninstall's
   * prune retired its cleanup tombstone, letting a same-name reinstall
   * reactivate the server. Holding the lock across revision read,
   * validation, write, and prune closes both interleavings: a save either
   * commits before the prune (which then removes its keys) or validates
   * after the plugin tree is gone (and is rejected).
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      const release = await acquireCrossProcessLock({
        lockPath: path.join(this.config.rootDir, "mcp-overrides.lock"),
        // Writes are small file edits plus at most one discovery scan; a
        // minute of waiting outlasts any legitimate holder.
        acquireTimeoutMs: 60_000,
        staleMs: 5 * 60_000,
        timeoutMessage:
          "Another Mux process is currently updating workspace MCP settings. Wait for it to finish and try again.",
      });
      try {
        return await fn();
      } finally {
        await release();
      }
    };
    const next = this.writeQueue.then(locked, locked);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Persist workspace MCP overrides to <workspace>/.xum/mcp.local.jsonc.
   *
   * Empty overrides remove the workspace-local file.
   *
   * When options.expectedRevision is provided, the write is rejected with
   * WorkspaceMcpOverridesConflictError if the stored overrides changed since
   * that revision was read — a stale Workspace MCP dialog snapshot must not
   * silently restore entries removed by a concurrent writer (e.g. the Agent
   * Plugin uninstaller pruning `plugin:<instanceId>:` keys).
   */
  async setOverridesForWorkspace(
    workspaceId: string,
    overrides: WorkspaceMCPOverrides,
    options?: {
      expectedRevision?: string;
      /**
       * Extra write-time validation run inside the exclusive queue after the
       * CAS check, with the CURRENT stored overrides and the normalized
       * incoming ones. Throwing rejects the save. Used by the oRPC handler to
       * refuse newly added `plugin:` keys for uninstalled plugins, which the
       * content-derived revision alone cannot catch (see
       * buildAddedPluginKeyValidator).
       */
      validateAgainstCurrent?: (
        current: WorkspaceMCPOverrides,
        incoming: WorkspaceMCPOverrides
      ) => Promise<void>;
      /**
       * Called INSIDE the exclusive write queue after a successful write,
       * with the normalized persisted overrides. Callers that mirror
       * overrides into in-memory caches (MCPServerManager) must publish here:
       * publishing after this method returns can interleave with a concurrent
       * writer's publication and leave the cache holding the older snapshot.
       */
      publish?: (persisted: WorkspaceMCPOverrides) => Promise<void>;
    }
  ): Promise<void> {
    assert(overrides && typeof overrides === "object", "overrides must be an object");

    return this.runExclusive(async () => {
      if (options?.expectedRevision !== undefined || options?.validateAgainstCurrent) {
        const current = await this.loadOverrides(workspaceId);
        if (
          options.expectedRevision !== undefined &&
          computeOverridesRevision(current) !== options.expectedRevision
        ) {
          throw new WorkspaceMcpOverridesConflictError();
        }
        await options.validateAgainstCurrent?.(current, normalizeWorkspaceMcpOverrides(overrides));
      }

      const { metadata, runtime, workspacePath } =
        await this.getRuntimeAndWorkspacePath(workspaceId);
      const canonicalPath = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig)[0];

      const normalized = normalizeWorkspaceMcpOverrides(overrides);

      // Always clear any legacy storage so we converge on the workspace-local file.
      await this.clearLegacyOverridesInConfig(workspaceId);

      if (isEmptyOverrides(normalized)) {
        await this.removeOverridesFile(runtime, workspacePath);
        await options?.publish?.(normalized);
        return;
      }

      await this.ensureOverridesDir(runtime, workspacePath, metadata.runtimeConfig);
      await writeFileString(runtime, canonicalPath, JSON.stringify(normalized, null, 2) + "\n");
      await this.ensureOverridesGitignored(runtime, workspacePath, metadata.runtimeConfig);
      await options?.publish?.(normalized);
    });
  }

  /**
   * Remove every override key starting with `keyPrefix` from this workspace's
   * override files, PRESERVING all fields this build does not recognize.
   *
   * Used by the Agent Plugin uninstaller. It patches the RAW parsed document
   * (only filtering the three known fields) rather than round-tripping
   * through get+set: a newer build's extra top-level fields must survive a
   * downgrade-side prune (AGENTS.md upgrade↔downgrade rule). Runs inside the
   * exclusive write queue, so it cannot interleave with a dialog save's
   * read-modify-write. Reads are strict: an unreadable file throws so the
   * caller keeps its retry tombstone instead of retiring it against content
   * it never saw. A missing file means nothing to prune — plugin keys are
   * only ever written to workspace-local files (legacy config.json storage
   * predates Agent Plugins).
   */
  async prunePluginOverrideKeys(
    workspaceId: string,
    keyPrefix: string,
    options?: {
      /**
       * Called INSIDE the exclusive write queue after the prune, with the
       * pruned normalized overrides re-read from disk. Same ordering contract
       * as setOverridesForWorkspace's publish: in-memory caches must be
       * updated here, not after this method returns, or a concurrent dialog
       * save's publication can be overwritten by the stale pre-save snapshot
       * (in either direction).
       */
      publish?: (persisted: WorkspaceMCPOverrides) => Promise<void>;
    }
  ): Promise<void> {
    const failures = await this.prunePluginOverrideKeysForWorkspaces([workspaceId], keyPrefix, {
      publish: (_workspaceId, persisted) => options?.publish?.(persisted) ?? Promise.resolve(),
    });
    if (failures.length > 0) {
      throw failures[0].error;
    }
  }

  /**
   * prunePluginOverrideKeys across many workspaces under ONE lock acquisition
   * and ONE workspace-metadata/config load. The Agent Plugin installer sweeps
   * every local/worktree workspace (thousands in long-lived setups); resolving
   * each workspace via getAllWorkspaceMetadata() — an uncached synchronous
   * parse of the whole config.json — made that sweep take ~1s per workspace
   * and the install appear hung. Per-workspace failures are collected (the
   * caller persists a retry tombstone for them) instead of aborting the sweep;
   * only wholesale failures (lock timeout, unreadable config) throw.
   */
  async prunePluginOverrideKeysForWorkspaces(
    workspaceIds: readonly string[],
    keyPrefix: string,
    options?: {
      publish?: (workspaceId: string, persisted: WorkspaceMCPOverrides) => Promise<void>;
    }
  ): Promise<Array<{ workspaceId: string; error: unknown }>> {
    assert(keyPrefix.length > 0, "prunePluginOverrideKeys: keyPrefix must be non-empty");

    return this.runExclusive(async () => {
      // Group, don't index: a corrupted config can list one ID under several
      // entries (different checkouts). Every checkout carrying the ID must be
      // pruned, or retiring the tombstone would leave a stale enable behind
      // in the entry a last-write-wins map dropped.
      const groupMetadataById = (
        all: FrontendWorkspaceMetadata[]
      ): Map<string, FrontendWorkspaceMetadata[]> => {
        const grouped = new Map<string, FrontendWorkspaceMetadata[]>();
        for (const metadata of all) {
          const entries = grouped.get(metadata.id);
          if (entries) {
            entries.push(metadata);
          } else {
            grouped.set(metadata.id, [metadata]);
          }
        }
        return grouped;
      };
      const checkoutPaths = (entries: FrontendWorkspaceMetadata[] | undefined): string =>
        (entries ?? [])
          .map((metadata) => this.resolveWorkspace(metadata).workspacePath)
          .sort()
          .join("\0");

      const metadataById = groupMetadataById(await this.config.getAllWorkspaceMetadata());
      const legacyConfig = this.config.loadConfigOrDefault();
      const failures: Array<{ workspaceId: string; error: unknown }> = [];
      const swept: string[] = [];
      for (const workspaceId of workspaceIds) {
        try {
          const entries = metadataById.get(workspaceId.trim());
          if (!entries) {
            throw new Error(`Workspace metadata not found for ${workspaceId.trim()}`);
          }
          for (const metadata of entries) {
            await this.pruneResolvedWorkspace(this.resolveWorkspace(metadata), keyPrefix);
          }
          if (options?.publish) {
            // Strict re-read: the prune above already threw on anything
            // unreadable, so a failure here is a real regression and must keep
            // the caller's retry tombstone rather than publish a guess. Reads
            // the first entry, matching getWorkspaceMetadata's lookup.
            await options.publish(
              workspaceId,
              await this.loadOverridesForResolved(
                this.resolveWorkspace(entries[0]),
                "strict",
                legacyConfig
              )
            );
          }
          swept.push(workspaceId);
        } catch (error) {
          failures.push({ workspaceId, error });
        }
      }

      // Workspace renames move the checkout and rewrite config WITHOUT taking
      // this lock, so a rename racing the sweep leaves the snapshot pointing
      // at the old (now empty) path and the prune above "succeeds" against
      // nothing. Re-resolve once afterwards and fail any swept workspace whose
      // checkout set changed: the caller keeps its tombstone and retries.
      if (swept.length > 0) {
        const afterById = groupMetadataById(await this.config.getAllWorkspaceMetadata());
        for (const workspaceId of swept) {
          const id = workspaceId.trim();
          if (checkoutPaths(metadataById.get(id)) !== checkoutPaths(afterById.get(id))) {
            failures.push({
              workspaceId,
              error: new Error(`Workspace ${id} moved while its MCP overrides were being pruned`),
            });
          }
        }
      }
      return failures;
    });
  }

  /** One workspace's prune; see prunePluginOverrideKeys for the contract. */
  private async pruneResolvedWorkspace(
    resolved: ResolvedWorkspace,
    keyPrefix: string
  ): Promise<void> {
    const { metadata, runtime, workspacePath } = resolved;
    // Prune canonical AND legacy-named files: a stale plugin key in an old
    // .mux/mcp.local.jsonc would otherwise survive uninstall and reactivate
    // on a later canonical migration.
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);

    for (const filePath of filePaths) {
      if (!(await statIsFile(runtime, filePath, "strict"))) {
        continue;
      }
      // SECURITY: refuse to prune through a symlinked override file. A
      // contributor-controlled branch can track `.mux/mcp.local.jsonc` as
      // a symlink (or symlink a parent segment); the write below resolves
      // links (LocalBaseRuntime.writeFile writes the TARGET), so following
      // one would let repo content redirect this rewrite into another
      // predictable file — e.g. silently stripping a sibling workspace's
      // plugin enables. Pruning only ever targets host-local (local/
      // worktree) workspaces, so node fs semantics apply directly. Throwing
      // keeps the caller's retry semantics (creation aborts / tombstone
      // survives) until the link is removed.
      await assertPruneTargetNotSymlinked(filePath, workspacePath);
      // Strict read: unreadable/unparseable content must throw so the
      // caller keeps its retry tombstone (mirrors readOverridesFile).
      const original = await readFileString(runtime, filePath);
      const parseErrors: jsonc.ParseError[] = [];
      const parsed: unknown = jsonc.parse(original, parseErrors) as unknown;
      if (parseErrors.length > 0) {
        throw new Error(`Workspace MCP overrides file has JSONC parse errors: ${filePath}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        // A newer build may store the whole document in a non-object shape
        // this build cannot inspect; "successfully pruning" it would retire
        // the caller's tombstone while plugin keys embedded in that shape
        // survive. Same doctrine as opaque owned-field shapes below.
        throw new Error(
          `Workspace MCP overrides file has an unrecognized root shape (written by a newer version?): ${filePath}`
        );
      }

      // Duplicate properties make jsonc.parse (last value wins) and
      // jsonc.modify (first matching path wins) disagree: the edit loop
      // below could spin forever on an entry it can never remove, or
      // declare success while a stale plugin key survives in the shadowed
      // property. Reject up front — the caller keeps its retry tombstone
      // until the malformed file is repaired.
      const duplicateName = findDuplicateOverrideProperty(jsonc.parseTree(original));
      if (duplicateName !== undefined) {
        throw new Error(
          `Workspace MCP overrides file has duplicate "${duplicateName}" properties: ${filePath}`
        );
      }

      // Targeted jsonc edits, NOT JSON.stringify of the parsed object: the
      // .jsonc file is user-maintained and may carry comments/formatting a
      // wholesale rewrite would erase.
      let text = original;
      const removeAt = (jsonPath: jsonc.JSONPath): void => {
        const next = jsonc.applyEdits(
          text,
          jsonc.modify(text, jsonPath, undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          })
        );
        // A no-op edit means parse and modify disagreed about the path;
        // looping on it would never terminate.
        assert(next !== text, "prunePluginOverrideKeys: targeted edit produced no change");
        text = next;
      };

      // A newer release may represent an owned field with a shape this
      // build cannot inspect. Declaring success would retire the caller's
      // tombstone while plugin keys embedded in that shape survive —
      // reactivating the server on reinstall. Throw instead: the tombstone
      // stays retryable (same doctrine as unreadable files).
      const opaqueShape = (field: string): Error =>
        new Error(
          `Workspace MCP overrides file has an unrecognized "${field}" shape (written by a newer version?): ${filePath}`
        );

      // Match only canonical `plugin:<16-hex>:<server>` keys under the
      // requested prefix: MCP server names are otherwise arbitrary strings
      // and user configuration may legitimately name a server "plugin:…" —
      // pruning must never strip such an ordinary server's overrides.
      // Canonical keys themselves are additionally RESERVED in ordinary
      // config (MCPConfigService ignores them in global/project layers and
      // addServer rejects them), so a key this shape can only belong to an
      // Agent Plugin server — shape-based pruning cannot hit a user server.
      const isPrunableKey = (key: unknown): boolean =>
        typeof key === "string" && key.startsWith(keyPrefix) && isCanonicalPluginServerKey(key);

      for (const field of ["enabledServers", "disabledServers"] as const) {
        // Re-parse after each removal: array indices shift as items go.
        for (;;) {
          const current = jsonc.parse(text) as Record<string, unknown>;
          const value = current[field];
          if (value === undefined) {
            break;
          }
          if (!Array.isArray(value)) {
            throw opaqueShape(field);
          }
          const index = value.findIndex(isPrunableKey);
          if (index === -1) {
            break;
          }
          removeAt([field, index]);
        }
      }

      const allowlist = (jsonc.parse(text) as Record<string, unknown>).toolAllowlist;
      if (allowlist !== undefined) {
        if (allowlist === null || typeof allowlist !== "object" || Array.isArray(allowlist)) {
          throw opaqueShape("toolAllowlist");
        }
        for (const key of Object.keys(allowlist)) {
          if (isPrunableKey(key)) {
            removeAt(["toolAllowlist", key]);
          }
        }
      }

      if (text !== original) {
        await writeFileString(runtime, filePath, text);
      }
    }
  }
}

/** Property names prunePluginOverrideKeys edits by JSON path. */
const PRUNED_OVERRIDE_FIELDS = new Set(["enabledServers", "disabledServers", "toolAllowlist"]);

/**
 * Detect duplicate JSONC properties that would break path-based edits in
 * prunePluginOverrideKeys: a root-level duplicate of an edited field, or any
 * duplicate key inside toolAllowlist. jsonc.parse exposes the LAST value for
 * a duplicated property while jsonc.modify resolves the FIRST matching path,
 * so editing such a file can loop forever or silently miss the effective
 * (shadowing) value. Returns the duplicated property name, if any.
 */
function findDuplicateOverrideProperty(root: jsonc.Node | undefined): string | undefined {
  const duplicateIn = (
    node: jsonc.Node | undefined,
    names?: ReadonlySet<string>
  ): string | undefined => {
    if (node?.type !== "object") {
      return undefined;
    }
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const name: unknown = property.children?.[0]?.value;
      if (typeof name !== "string" || (names !== undefined && !names.has(name))) {
        continue;
      }
      if (seen.has(name)) {
        return name;
      }
      seen.add(name);
    }
    return undefined;
  };

  const rootDuplicate = duplicateIn(root, PRUNED_OVERRIDE_FIELDS);
  if (rootDuplicate !== undefined) {
    return rootDuplicate;
  }
  return duplicateIn(
    root === undefined ? undefined : jsonc.findNodeAtLocation(root, ["toolAllowlist"])
  );
}
