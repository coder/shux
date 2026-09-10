/**
 * SSH runtime implementation that executes commands and file operations
 * over SSH using the ssh command-line tool.
 *
 * Features:
 * - Uses system ssh command (respects ~/.ssh/config)
 * - Supports SSH config aliases, ProxyJump, ControlMaster, etc.
 * - No password prompts (assumes key-based auth or ssh-agent)
 * - Atomic file writes via temp + rename
 *
 * IMPORTANT: All SSH operations MUST include a timeout to prevent hangs from network issues.
 * Timeouts should be either set literally for internal operations or forwarded from upstream
 * for user-initiated operations.
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */

import { spawn, type ChildProcess } from "child_process";
import * as crypto from "crypto";
import { promises as fsPromises, type Dirent } from "fs";
import * as path from "path";
import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  ExecOptions,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "./Runtime";
import { WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { log } from "@/node/services/log";
import { findInitHookRelativePath, runInitHookOnRuntime, runWorkspaceInitHook } from "./initHook";
import { expandTildeForSSH, cdCommandForSSH } from "./tildeExpansion";
import { sleepWithAbort } from "@/node/utils/abort";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import {
  type SSHRuntimeConfig,
  getControlPath,
  appendOpenSSHHostKeyPolicyArgs,
  sshConnectionPool,
} from "./sshConnectionPool";
import { getOriginUrlForBundle } from "./gitBundleSync";
import { gitNoHooksPrefix } from "@/node/utils/gitNoHooksEnv";
import { execFileAsync } from "@/node/utils/disposableExec";
import { syncRuntimeGitSubmodules } from "./submoduleSync";
import {
  OpenSSHTransport,
  type PtyHandle,
  type PtySessionParams,
  type SSHTransport,
} from "./transports";
import {
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
  REMOTE_BASE_REPO_DIR,
  type RemoteProjectLayout,
} from "./remoteProjectLayout";
import { streamToString, shescape } from "./streamUtils";

/** Staging namespace for synced branch refs. Branches land here instead of
 *  refs/heads/* so they don't collide with branches checked out in worktrees. */
const BUNDLE_REF_PREFIX = "refs/mux-bundle/";
/**
 * Canonical message thrown when an SSH operation is aborted. Several call sites
 * compare against this exact value (e.g. `errorMsg === OPERATION_ABORTED_ERROR`),
 * so the thrown and compared strings must stay identical — keep them as one const.
 * Mirrors SSH_OPERATION_ABORTED_ERROR / SSH2_OPERATION_ABORTED_ERROR in the
 * sibling connection-pool modules.
 */
const OPERATION_ABORTED_ERROR = "Operation aborted";
/**
 * The shared SSH base repo is a bare common git dir, not a checkout. Keep its
 * HEAD branch-shaped but unborn until a real base commit is available, then
 * detach HEAD at that commit. In both states, `git worktree list --porcelain`
 * does not report a user branch checked out at `.mux-base.git`.
 */
const BASE_REPO_UNBORN_HEAD_REF = "refs/heads/__mux_internal_base_head";
const BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET = ["core.bare", "core.worktree"] as const;
type BaseRepoSharedConfigKey = (typeof BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET)[number];

/** Small backoff for concurrent writers healing the same shared base repo config. */
const BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200];
const BASE_REPO_HEALTH_PROBE_TIMEOUT_SECONDS = 10;
const BASE_REPO_CONNECTIVITY_CHECK_TIMEOUT_SECONDS = 120;
const BASE_REPO_MISSING_OBJECT_REPAIR_TIMEOUT_MS = 300_000;
const BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS = 10;
/**
 * Timeout for *spawning* remote detached gc, not for gc itself. The remote
 * shell returns as soon as it has started `git gc` in the background, so this
 * only needs to cover one SSH round-trip.
 */
const BASE_REPO_MAINTENANCE_SPAWN_TIMEOUT_SECONDS = 10;
/**
 * Retry-time maintenance should still wait for gc so the next sync attempt can
 * benefit from the repair. The gc process itself is detached, so this timeout
 * can stop waiting without SIGKILLing Git mid-pack-finalization.
 */
const BASE_REPO_MAINTENANCE_WAIT_TIMEOUT_SECONDS = 30 * 60;
/** Git config keys that announce a bare repo as a promisor remote to
 *  `repo_has_promisor_remote()`. Unsetting all three is what makes
 *  receive-pack's `check_connected()` skip the buggy partial-clone fast
 *  path on subsequent pushes (see `stripBaseRepoPromisorConfig`). */
const BASE_REPO_PROMISOR_CONFIG_KEYS = [
  "remote.origin.promisor",
  "remote.origin.partialclonefilter",
  "extensions.partialclone",
] as const;
const BASE_REPO_FRAGMENTED_PACK_THRESHOLD = 25;
const PROJECT_SYNC_MAX_ATTEMPTS = 3;
const PROJECT_SYNC_RETRYABLE_ERRORS = [
  "pack-objects died",
  "Connection reset",
  "Connection closed",
  "Broken pipe",
  "EPIPE",
  "Command killed by signal",
  // Receive-pack thin-pack resolution failures. These happen when the bare
  // base repo routes a small push through `unpack-objects` (because object
  // count < `transfer.unpackLimit`, default 100) and the thin pack references
  // delta bases that unpack-objects cannot resolve, or when the on-disk pack
  // store is missing the assumed-present base objects (e.g. a `.pack` with no
  // `.idx`). The retry path runs `repairBaseRepoForSync`, which sets
  // `receive.unpackLimit=1` (forcing index-pack with `--fix-thin`) and runs
  // gc, and the next push is force-promoted to `--no-thin` so the pack is
  // self-contained. See `isUnresolvedDeltaPushFailure`.
  "unresolved deltas",
  "unpacker error",
  "unpack-objects abnormal exit",
  "remote unpack failed",
] as const;

/**
 * Patterns matching the receive-pack failure described above. Detected
 * separately from generic retryable errors so the retry path can opt the next
 * push into `--no-thin` instead of just rerunning the same thin push.
 */
const UNRESOLVED_DELTA_PUSH_PATTERNS = [
  "unresolved deltas",
  "unpacker error",
  "unpack-objects abnormal exit",
  "remote unpack failed",
] as const;

function isUnresolvedDeltaPushFailure(errorMsg: string): boolean {
  return UNRESOLVED_DELTA_PUSH_PATTERNS.some((pattern) => errorMsg.includes(pattern));
}

function isMissingObjectCheckoutFailure(message: string): boolean {
  return /unable to read sha1 file|Could not reset index file|missing (blob|tree|commit)|bad object|unable to read tree|object file .* is empty|loose object .* is corrupt/i.test(
    message
  );
}

const sharedProjectSyncTails = new Map<string, Promise<void>>();

async function enqueueProjectSync(
  projectKey: string,
  abortSignal: AbortSignal | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const previous = sharedProjectSyncTails.get(projectKey) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current
  );
  sharedProjectSyncTails.set(projectKey, tail);
  void tail.finally(() => {
    if (sharedProjectSyncTails.get(projectKey) === tail) {
      sharedProjectSyncTails.delete(projectKey);
    }
  });

  let onAbort: (() => void) | undefined;
  const waitForPrevious = previous.catch(() => undefined);
  const waitForTurn = abortSignal
    ? Promise.race([
        waitForPrevious,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(OPERATION_ABORTED_ERROR));
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }),
      ])
    : waitForPrevious;

  try {
    await waitForTurn;
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }
    await fn();
  } finally {
    if (onAbort) {
      abortSignal?.removeEventListener("abort", onAbort);
    }
    releaseCurrent?.();
  }
}

function isGitConfigLockConflict(message: string): boolean {
  return /could not lock config file/i.test(message);
}

function buildBestEffortDetachBaseRepoHeadCommand(
  baseRepoPathArg: string,
  revisionShell: string
): string {
  return [
    // Resolve only the ref value here, not `<rev>^{commit}`: missing-object
    // repair still belongs to the following worktree checkout, which produces
    // richer errors and already has a retry path.
    `head_oid=$(git -C ${baseRepoPathArg} rev-parse --verify ${revisionShell} 2>/dev/null || true)`,
    `if [ -n "$head_oid" ]; then git --git-dir=${baseRepoPathArg} update-ref --no-deref HEAD "$head_oid" 2>/dev/null || true; fi`,
  ].join("\n");
}

function logSSHBackoffWait(initLogger: InitLogger, waitMs: number): void {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  initLogger.logStep(`SSH unavailable; retrying in ${secs}s...`);
}

async function pipeReadableToWebWritable(
  readable: NodeJS.ReadableStream | null | undefined,
  writable: WritableStream<Uint8Array>,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!readable) {
    throw new Error("Missing git bundle output stream");
  }

  const writer = writable.getWriter();
  try {
    for await (const chunk of readable) {
      if (abortSignal?.aborted) {
        throw new Error("Bundle creation aborted");
      }
      const data =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : Buffer.from(chunk);
      await writer.write(data);
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      writer.releaseLock();
    }
    throw error;
  }
}

function createAbortController(
  timeoutMs: number | undefined,
  abortSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeoutHandle =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}
async function waitForProcessExit(proc: ChildProcess): Promise<number> {
  // Callers often consume stdout before awaiting the process. Tiny git helpers
  // can close in that window, so make the helper safe even when subscribed late.
  if (proc.exitCode !== null) {
    return proc.exitCode;
  }
  if (proc.signalCode !== null) {
    return 1;
  }

  return new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", (err) => reject(err));
  });
}

/** Truncate SSH stderr for error logging (prefer the first transport-related line, max 200 chars). */
function truncateSSHError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "exit code 255";

  const lines = trimmed.split("\n").filter(Boolean);
  const preferredLine =
    lines.find((line) =>
      /(ssh:|Could not resolve hostname|Host key verification failed|Permission denied|Connection (timed out|refused|reset)|No route to host|Network is unreachable|kex_exchange_identification|Could not read from remote repository)/i.test(
        line
      )
    ) ?? lines[0];

  if (preferredLine.length <= 200) return preferredLine;
  return preferredLine.slice(0, 197) + "...";
}

function isUnsupportedAtomicPush(errorMsg: string): boolean {
  return /atomic/i.test(errorMsg) && /(does not support|not support|unsupported)/i.test(errorMsg);
}

function isGitPushTransportFailure(exitCode: number | null, errorMsg: string): boolean {
  if (exitCode === 255) {
    return true;
  }
  if (exitCode !== 128) {
    return false;
  }

  return /(ssh:|Could not resolve hostname|Host key verification failed|Permission denied|Connection (timed out|refused|reset)|No route to host|Network is unreachable|kex_exchange_identification|Could not read from remote repository)/i.test(
    errorMsg
  );
}
// Re-export SSHRuntimeConfig from connection pool (defined there to avoid circular deps)
export type { SSHRuntimeConfig } from "./sshConnectionPool";

/**
 * Compute the path to the shared bare base repo for a project on the remote.
 * Convention: <srcBaseDir>/<projectId>/.mux-base.git
 *
 * Exported for unit testing; runtime code should use the private
 * `SSHRuntime.getBaseRepoPath()` method instead.
 */
export function computeBaseRepoPath(srcBaseDir: string, projectPath: string): string {
  return buildRemoteProjectLayout(srcBaseDir, projectPath).baseRepoPath;
}

/**
 * Run `git show-ref --heads` against a local project and return the raw stdout
 * (newline-separated `<oid> <refname>` lines).
 *
 * Returns `null` when the project has no refs (fresh repo with no commits) or
 * git fails for any reason — callers should treat that as "fall back to the
 * slow path" rather than retrying.
 *
 * STARTUP-PERF: This helper exists so the warm fast-path can read local heads
 * once and derive both the snapshot digest and the sorted ref manifest from a
 * single fork+exec, instead of paying ~70-100ms twice for the same `git`
 * subprocess.
 */
async function readGitHeadsRefs(projectPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const proc = spawn("git", ["-C", projectPath, "show-ref", "--heads"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    proc.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString());
      } else {
        // Exit code 1 with empty output = "no refs to display"; treat as null.
        resolve(null);
      }
    });
    proc.once("error", () => resolve(null));
  });
}

/**
 * Fast-path: read the local repo's heads directly from the filesystem
 * (`<projectPath>/.git/refs/heads/**` + `<projectPath>/.git/packed-refs`)
 * and return them in the same `<oid> <refname>` format as `git show-ref --heads`.
 *
 * Returns null and lets the caller fall back to `git show-ref` when:
 *   - `.git` is a file (worktree gitdir indirection — uncommon for project roots)
 *   - any read fails (e.g. broken refs)
 *
 * STARTUP-PERF: `git show-ref` costs ~70-100ms per invocation on macOS due to
 * git's fork+exec + dynamic loader + libcrypto warmup. The same data sits in
 * a couple of files we can read with a single readdir + a handful of small
 * file reads (~3-5ms total for a typical repo). For the warm fast-path that
 *'s a meaningful chunk of the total wall-time budget, and any ambiguity we
 * fall back gracefully.
 *
 * NOTE: We don't try to be a complete `git show-ref` replacement; we only
 * cover the loose-ref + packed-refs combination that 100% of warm projects
 * fit into. Worktree gitdir files and reftable-based repos fall back.
 */
async function fastReadGitHeadsRefs(projectPath: string): Promise<string | null> {
  try {
    const gitDir = `${projectPath}/.git`;
    const gitStat = await fsPromises.stat(gitDir);
    if (!gitStat.isDirectory()) {
      // `.git` is a file (worktree indirection) — bail to the safe path.
      return null;
    }

    const heads: Array<{ oid: string; refname: string }> = [];

    // 1. Loose refs under .git/refs/heads/**
    const headsDir = `${gitDir}/refs/heads`;
    const walk = async (relDir: string): Promise<void> => {
      const fullDir = relDir.length > 0 ? `${headsDir}/${relDir}` : headsDir;
      let entries: Dirent[];
      try {
        entries = await fsPromises.readdir(fullDir, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (entry) => {
          const childRel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(childRel);
            return;
          }
          if (!entry.isFile()) return;
          let raw: string;
          try {
            raw = await fsPromises.readFile(`${headsDir}/${childRel}`, "utf-8");
          } catch {
            return;
          }
          const oid = raw.trim();
          // Skip symref redirects (rare for branch heads) — git's own format
          // would be "ref: refs/heads/..." in those cases. Treat them as
          // unsupported and let the caller fall back.
          if (!/^[0-9a-f]{40}$/i.test(oid)) {
            throw new Error("symref or invalid loose ref");
          }
          heads.push({ oid, refname: `refs/heads/${childRel}` });
        })
      );
    };

    try {
      await walk("");
    } catch {
      return null;
    }

    // 2. Packed refs under .git/packed-refs (one entry per branch, possibly
    //    interleaved with peeled-tag lines that start with '^' — those are
    //    skipped).
    let packed: string;
    try {
      packed = await fsPromises.readFile(`${gitDir}/packed-refs`, "utf-8");
    } catch {
      packed = "";
    }
    const seen = new Set(heads.map((h) => h.refname));
    for (const line of packed.split("\n")) {
      if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space === -1) continue;
      const oid = line.slice(0, space);
      const refname = line.slice(space + 1).trim();
      if (!refname.startsWith("refs/heads/")) continue;
      if (seen.has(refname)) continue; // loose refs override packed ones
      if (!/^[0-9a-f]{40}$/i.test(oid)) return null;
      heads.push({ oid, refname });
      seen.add(refname);
    }

    if (heads.length === 0) {
      return null;
    }

    // Match `git show-ref` output order: refname-sorted, single trailing newline.
    heads.sort((a, b) => (a.refname < b.refname ? -1 : a.refname > b.refname ? 1 : 0));
    return `${heads.map((h) => `${h.oid} ${h.refname}`).join("\n")}\n`;
  } catch {
    return null;
  }
}

/**
 * SSH runtime implementation that executes commands and file operations
 * over SSH using the ssh command-line tool.
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */
export class SSHRuntime extends RemoteRuntime {
  private readonly config: SSHRuntimeConfig;
  private readonly transport: SSHTransport;
  private readonly ensureReadyProjectPath?: string;
  private readonly ensureReadyWorkspaceName?: string;
  private readonly currentWorkspacePath?: string;
  /** Cached resolved bgOutputDir (tilde expanded to absolute path) */
  private resolvedBgOutputDir: string | null = null;

  constructor(
    config: SSHRuntimeConfig,
    transport: SSHTransport,
    options?: {
      projectPath?: string;
      workspaceName?: string;
      workspacePath?: string;
    }
  ) {
    super();
    // Note: srcBaseDir may contain tildes - they will be resolved via resolvePath() before use
    // The WORKSPACE_CREATE IPC handler resolves paths before storing in config
    this.config = config;
    this.transport = transport;
    this.ensureReadyProjectPath = options?.projectPath;
    this.ensureReadyWorkspaceName = options?.workspaceName;
    this.currentWorkspacePath = options?.workspacePath;
  }

  /**
   * Get resolved background output directory (tilde expanded), caching the result.
   * This ensures all background process paths are absolute from the start.
   * Public for use by BackgroundProcessExecutor.
   */
  async getBgOutputDir(): Promise<string> {
    if (this.resolvedBgOutputDir !== null) {
      return this.resolvedBgOutputDir;
    }

    let dir = this.config.bgOutputDir ?? "/tmp/mux-bashes";

    if (dir === "~" || dir.startsWith("~/")) {
      const result = await execBuffered(this, 'echo "$HOME"', { cwd: "/", timeout: 10 });
      let home: string;
      if (result.exitCode === 0 && result.stdout.trim()) {
        home = result.stdout.trim();
      } else {
        log.warn(
          `SSHRuntime: Failed to resolve $HOME (exitCode=${result.exitCode}). Falling back to /tmp.`
        );
        home = "/tmp";
      }
      dir = dir === "~" ? home : `${home}/${dir.slice(2)}`;
    }

    this.resolvedBgOutputDir = dir;
    return this.resolvedBgOutputDir;
  }

  /** Create a PTY session using the underlying transport. */
  public createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    return this.transport.createPtySession(params);
  }

  /** Get SSH configuration (for PTY terminal spawning). */
  public getConfig(): SSHRuntimeConfig {
    return this.config;
  }

  private getProjectLayout(projectPath: string): RemoteProjectLayout {
    return buildRemoteProjectLayout(this.config.srcBaseDir, projectPath);
  }

  private getProjectSyncKey(projectId: string): string {
    return [
      this.config.host,
      this.config.port?.toString() ?? "22",
      this.config.identityFile ?? "default",
      this.config.srcBaseDir,
      projectId,
    ].join(":");
  }

  private isRetryableProjectSyncError(errorMsg: string): boolean {
    return PROJECT_SYNC_RETRYABLE_ERRORS.some((pattern) => errorMsg.includes(pattern));
  }

  private async probeBaseRepoHealth(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<{ packCount: number | null }> {
    const result = await execBuffered(this, `git -C ${baseRepoPathArg} count-objects -v`, {
      cwd: "/tmp",
      timeout: BASE_REPO_HEALTH_PROBE_TIMEOUT_SECONDS,
      abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to inspect shared base repository health: ${result.stderr || result.stdout}`
      );
    }

    const packCountMatch = /^packs:\s*(\d+)\s*$/m.exec(result.stdout);
    return {
      packCount: packCountMatch ? Number.parseInt(packCountMatch[1], 10) : null,
    };
  }

  /**
   * Remove stale partial-clone / promisor configuration from a shared bare
   * base repo. Idempotent — absent keys are silently treated as success.
   *
   * Why this matters (real, current upstream Git bug):
   *
   *   Git's `check_connected()` (`connected.c`) has a fast path that
   *   activates whenever the receiving repo is a promisor remote, i.e.
   *   `repo_has_promisor_remote()` returns true. That path was added in
   *   50033772d ("connected: verify promisor-ness of partial clone",
   *   2020-01) and is byte-identical on every release from v2.27.0 through
   *   current `master`. It violates `check_connected_options::err_fd`'s
   *   documented contract — "The descriptor is closed before
   *   check_connected returns" (header comment in `connected.h`) — by
   *   returning 0 directly when all pushed ref tips are already present in
   *   a promisor pack, without ever calling `close(opt->err_fd)`.
   *
   *   On the receive-pack side, `execute_commands()` runs the connectivity
   *   check with `err_fd = muxer.in`, where `muxer` is an async pthread
   *   spawned by `start_async()` to relay child stderr over the sideband.
   *   When the buggy fast path returns, the muxer pipe's write end is
   *   still held open by receive-pack itself, so the keepalive worker
   *   thread keeps polling its read end (timing out every 5s and emitting
   *   `0005\1` sideband keepalives) and never sees EOF. The subsequent
   *   `finish_async(&muxer)` is `pthread_join`, which then blocks forever.
   *   The local push hangs in OpenSSH mux-channel I/O even though TCP
   *   keepalives still flow on the underlying connection.
   *
   *   Jeff King already fixed an architecturally identical deadlock years
   *   ago — 6cdad1f13 ("receive-pack: fix deadlock when we cannot create
   *   tmpdir", 2017-03) — by adding the missing `close(err_fd)` to an
   *   early-return path in `unpack()`. The same lesson was never applied
   *   to the promisor path added three years later.
   *
   *   Xum never deliberately turns the shared base repo into a partial
   *   clone, but legacy bare repos populated by earlier Xum versions, or
   *   by user-initiated `git fetch --filter` runs on the remote, can
   *   carry these keys. Stripping them makes `repo_has_promisor_remote()`
   *   return false, routing `check_connected()` through the slow rev-list
   *   path that closes its sideband fd correctly. The companion `.promisor`
   *   marker file cleanup in `repairBaseRepoForSync` handles the on-disk
   *   side of the same legacy state.
   */
  protected async stripBaseRepoPromisorConfig(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    // `git config --unset-all` exits 0 (removed) or 5 (key/section absent);
    // both are idempotent successes. Anything else is a real failure we
    // want surfaced but not fatal — workspace init must not depend on
    // remote config writes that may race with concurrent worktrees.
    //
    // Three keys cover every way a bare repo can advertise itself as a
    // partial clone to `repo_has_promisor_remote()`:
    //   - remote.origin.promisor       (flag set by `clone/fetch --filter`)
    //   - remote.origin.partialclonefilter  (the filter spec itself)
    //   - extensions.partialclone      (the repository-format extension)
    //
    // Collapsed into one remote shell call to keep workspace init to a
    // single SSH round trip; `; true` ensures the pipeline as a whole
    // returns 0 even when every key was already absent.
    const cmd =
      BASE_REPO_PROMISOR_CONFIG_KEYS.map(
        (key) => `git -C ${baseRepoPathArg} config --unset-all ${key}`
      ).join("; ") + "; true";

    const result = await execBuffered(this, cmd, {
      cwd: "/tmp",
      timeout: BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS,
      abortSignal,
    });

    const stderr = result.stderr.trim();
    if (stderr) {
      log.warn(`Partial-clone config cleanup reported diagnostics: ${stderr}`);
    }
  }

  protected async repairBaseRepoForSync(
    baseRepoPathArg: string,
    repairContext: string,
    abortSignal?: AbortSignal,
    options: { waitForGc?: boolean } = {}
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    log.info(repairContext);

    // Strip partial-clone config before the on-disk cleanup so that even
    // if `git gc` fails, subsequent pushes no longer route through the
    // buggy `check_connected()` promisor fast path. See the doc comment
    // on stripBaseRepoPromisorConfig for the full upstream-bug story.
    await this.stripBaseRepoPromisorConfig(baseRepoPathArg, abortSignal);

    const promisorPackDirArg = `${baseRepoPathArg}/objects/pack`;
    const promisorCleanupResult = await execBuffered(
      this,
      `find ${promisorPackDirArg} -name '*.promisor' -print -delete 2>/dev/null || true`,
      {
        cwd: "/tmp",
        timeout: BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS,
        abortSignal,
      }
    );
    const removedPromisorCount = promisorCleanupResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
    if (removedPromisorCount > 0) {
      log.info(
        `Removed ${removedPromisorCount} stale promisor marker(s) during base repo maintenance`
      );
    }

    // Rebuild any orphaned pack indexes (`pack-<sha>.pack` with no matching
    // `pack-<sha>.idx`). A previous gc that was SIGKILLed mid-finalization
    // can leave a pack on disk whose `.idx` was never written, hiding every
    // object inside that pack from negotiation. Subsequent thin pushes then
    // assume those objects are missing → the remote pulls in delta bases
    // that aren't actually reachable → `unresolved deltas left after
    // unpacking`. `git index-pack` rebuilds the missing `.idx` from the
    // `.pack` so the objects rejoin the negotiation surface before the next
    // push. Best-effort: a corrupt `.pack` or environment without `git
    // index-pack` will fall through to `gc` and ultimately the `--no-thin`
    // retry push.
    const reindexCommand = [
      `pack_dir=${promisorPackDirArg}`,
      'if [ ! -d "$pack_dir" ]; then exit 0; fi',
      // Use `find` to enumerate orphan packs; for each, run `git index-pack`
      // and log a line so the count is visible in the maintenance log.
      `for pack in "$pack_dir"/pack-*.pack; do`,
      '  [ -e "$pack" ] || continue',
      '  idx="${pack%.pack}.idx"',
      '  if [ -f "$idx" ]; then continue; fi',
      `  if git index-pack "$pack" >/dev/null 2>&1; then`,
      '    echo "reindexed $pack"',
      "  else",
      '    echo "reindex-failed $pack" >&2',
      "  fi",
      "done",
    ].join("\n");
    const reindexResult = await execBuffered(this, reindexCommand, {
      cwd: "/tmp",
      timeout: BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS,
      abortSignal,
    });
    const reindexedCount = reindexResult.stdout
      .split("\n")
      .filter((line) => line.startsWith("reindexed ")).length;
    if (reindexedCount > 0) {
      log.info(
        `Rebuilt ${reindexedCount} orphaned pack index file(s) during base repo maintenance`
      );
    }
    const reindexFailures = reindexResult.stderr
      .split("\n")
      .filter((line) => line.startsWith("reindex-failed ")).length;
    if (reindexFailures > 0) {
      log.warn(
        `Failed to rebuild ${reindexFailures} pack index file(s) during base repo maintenance`
      );
    }

    // Always detach `git gc` from mux's SSH command timeout. A SIGKILL between
    // `tmp_pack_X → pack-<sha>.pack` and `tmp_idx_X → pack-<sha>.idx` leaves a
    // .pack with no .idx, hiding every object inside that pack and making thin
    // pushes fail with `unresolved deltas left after unpacking`.
    //
    // `setsid -f` forks gc into its own session/process group before execing
    // Git, so gc survives SSH channel shutdown and the `timeout -s KILL` group
    // kill that `RemoteRuntime.exec` wraps every remote command in. `nohup` is
    // not enough because SIGKILL ignores SIGHUP-disposition tricks. Git's own
    // `gc.pid` lock prevents concurrent gcs from racing on the same repo.
    //
    // Proactive preflight is advisory and only waits for the detached spawn.
    // Retry cleanup uses `setsid -w` to wait for the detached child, so the
    // retry can benefit from completed maintenance without ever putting gc
    // itself under a client-side kill timeout. Logs land in
    // /tmp/.mux-base-repo-gc.log.
    const setsidArgs = options.waitForGc ? "-f -w" : "-f";
    const gcCommand = [
      `base_repo=${baseRepoPathArg}`,
      "command -v setsid >/dev/null 2>&1 || { echo 'setsid command not found; cannot detach git gc' >&2; exit 127; }",
      `setsid ${setsidArgs} sh -c 'exec git -C "$1" gc --prune=now >>/tmp/.mux-base-repo-gc.log 2>&1' sh "$base_repo" </dev/null`,
    ].join("\n");
    const gcResult = await execBuffered(this, gcCommand, {
      cwd: "/tmp",
      timeout: options.waitForGc
        ? BASE_REPO_MAINTENANCE_WAIT_TIMEOUT_SECONDS
        : BASE_REPO_MAINTENANCE_SPAWN_TIMEOUT_SECONDS,
      abortSignal,
    });
    if (gcResult.exitCode !== 0) {
      const detail = (gcResult.stderr || gcResult.stdout).trim() || `exit ${gcResult.exitCode}`;
      log.warn(`Remote git gc maintenance failed: ${detail}`);
    }
  }

  protected async ensureHealthyBaseRepoForSync(
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    try {
      const { packCount } = await this.probeBaseRepoHealth(baseRepoPathArg, abortSignal);
      if (packCount == null || packCount < BASE_REPO_FRAGMENTED_PACK_THRESHOLD) {
        return;
      }

      const packFileLabel = packCount === 1 ? "pack file" : "pack files";
      initLogger.logStep(
        `Shared base repository is fragmented (${packCount} ${packFileLabel}); running maintenance before sync...`
      );
      await this.repairBaseRepoForSync(
        baseRepoPathArg,
        `Running shared base repository maintenance before sync (${packCount} ${packFileLabel})`,
        abortSignal
      );
    } catch (healthError) {
      const healthErrorMsg = getErrorMessage(healthError);
      if (abortSignal?.aborted || healthErrorMsg === OPERATION_ABORTED_ERROR) {
        throw healthError instanceof Error ? healthError : new Error(healthErrorMsg);
      }
      log.warn(`Shared base repository maintenance preflight failed: ${healthErrorMsg}`);
    }
  }

  private async checkBaseRepoBundleConnectivity(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<{ healthy: true } | { healthy: false; detail: string }> {
    const result = await execBuffered(
      this,
      [
        `set -- $(git -C ${baseRepoPathArg} for-each-ref --format='%(refname)' ${shescape.quote(BUNDLE_REF_PREFIX)})`,
        'if [ "$#" -eq 0 ]; then echo "no synced bundle refs found" >&2; exit 1; fi',
        `git -C ${baseRepoPathArg} fsck --connectivity-only --no-dangling "$@"`,
      ].join("\n"),
      {
        cwd: "/tmp",
        timeout: BASE_REPO_CONNECTIVITY_CHECK_TIMEOUT_SECONDS,
        abortSignal,
      }
    );

    if (result.exitCode === 0) {
      return { healthy: true };
    }

    const detail = [result.stderr, result.stdout].join("\n").trim() || `exit ${result.exitCode}`;
    return {
      healthy: false,
      detail,
    };
  }

  private async checkBaseRepoRevisionConnectivity(
    baseRepoPathArg: string,
    revision: string,
    abortSignal?: AbortSignal
  ): Promise<{ healthy: true } | { healthy: false; detail: string }> {
    const result = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} fsck --connectivity-only --no-dangling ${shescape.quote(revision)}`,
      {
        cwd: "/tmp",
        timeout: BASE_REPO_CONNECTIVITY_CHECK_TIMEOUT_SECONDS,
        abortSignal,
      }
    );

    if (result.exitCode === 0) {
      return { healthy: true };
    }

    const detail = [result.stderr, result.stdout].join("\n").trim() || `exit ${result.exitCode}`;
    return {
      healthy: false,
      detail,
    };
  }

  private async repairBaseRepoMissingObjectsFromLocal(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    await this.transport.acquireConnection({
      abortSignal,
      onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
    });

    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    initLogger.logStep("Repairing shared base repository object cache...");
    const remoteAbortController = createAbortController(
      BASE_REPO_MISSING_OBJECT_REPAIR_TIMEOUT_MS,
      abortSignal
    );

    try {
      const remoteStream = await this.exec(`git -C ${baseRepoPathArg} unpack-objects -r`, {
        cwd: "/tmp",
        abortSignal: remoteAbortController.signal,
      });
      const remoteStdoutPromise = streamToString(remoteStream.stdout);
      const remoteStderrPromise = streamToString(remoteStream.stderr);

      // A normal fetch/push can be a no-op when the remote already has the
      // commit object but is missing blobs from the same tree. Stream a complete
      // non-thin local pack and let `unpack-objects -r` add only the missing
      // objects without deleting or recreating the shared gitdir used by siblings.
      const gitProc = spawn("git", ["-C", projectPath, "pack-objects", "--all", "--stdout"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let packStderr = "";
      gitProc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        packStderr += chunk;
        for (const line of chunk.split("\n").filter(Boolean)) {
          initLogger.logStderr(line);
        }
      });
      const gitExitCodePromise = waitForProcessExit(gitProc);

      try {
        await pipeReadableToWebWritable(gitProc.stdout, remoteStream.stdin, abortSignal);
      } catch (error) {
        gitProc.kill();
        throw error;
      }

      const [gitExitCode, remoteExitCode, remoteStdout, remoteStderr] = await Promise.all([
        gitExitCodePromise,
        remoteStream.exitCode,
        remoteStdoutPromise,
        remoteStderrPromise,
      ]);

      if (remoteAbortController.didTimeout()) {
        throw new Error(
          `SSH command timed out after ${BASE_REPO_MISSING_OBJECT_REPAIR_TIMEOUT_MS}ms: git -C ${baseRepoPathArg} unpack-objects -r`
        );
      }

      if (abortSignal?.aborted) {
        throw new Error(OPERATION_ABORTED_ERROR);
      }

      if (gitExitCode !== 0) {
        throw new Error(
          `Failed to create repair pack: ${packStderr.trim() || `exit ${gitExitCode}`}`
        );
      }

      if (remoteExitCode !== 0) {
        const detail = (remoteStderr || remoteStdout).trim() || `exit ${remoteExitCode}`;
        throw new Error(`Failed to unpack repair pack into shared base repository: ${detail}`);
      }
    } finally {
      remoteAbortController.dispose();
    }

    initLogger.logStep("Shared base repository object cache repaired");
  }

  private async ensureBaseRepoSnapshotConnectivity(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const initialCheck = await this.checkBaseRepoBundleConnectivity(baseRepoPathArg, abortSignal);
    if (initialCheck.healthy) {
      return;
    }

    initLogger.logStep("Remote snapshot is missing objects; repairing shared base repository...");
    log.warn("Remote snapshot failed connectivity check before reuse", {
      detail: initialCheck.detail,
    });

    await this.repairBaseRepoMissingObjectsFromLocal(
      projectPath,
      baseRepoPathArg,
      initLogger,
      abortSignal
    );

    const repairedCheck = await this.checkBaseRepoBundleConnectivity(baseRepoPathArg, abortSignal);
    if (!repairedCheck.healthy) {
      throw new Error(
        `Shared base repository is still missing objects after repair: ${repairedCheck.detail}`
      );
    }
  }

  private async cleanupFailedNewWorktreeCheckout(
    baseRepoPathArg: string,
    workspacePathArg: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const result = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} worktree remove --force ${workspacePathArg} >/dev/null 2>&1 || rm -rf ${workspacePathArg}`,
      {
        cwd: "/tmp",
        timeout: 30,
        abortSignal,
      }
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
      log.warn(`Failed to clean up partial SSH worktree checkout: ${detail}`);
    }
  }

  protected async cleanupRetryableProjectSyncFailure(
    baseRepoPathArg: string,
    attempt: number,
    maxAttempts: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    try {
      await this.repairBaseRepoForSync(
        baseRepoPathArg,
        `Running remote promisor cleanup and git gc before retrying sync push (attempt ${attempt + 1}/${maxAttempts})`,
        abortSignal,
        { waitForGc: true }
      );
    } catch (cleanupError) {
      const cleanupErrorMsg = getErrorMessage(cleanupError);
      if (abortSignal?.aborted || cleanupErrorMsg === OPERATION_ABORTED_ERROR) {
        throw cleanupError instanceof Error ? cleanupError : new Error(cleanupErrorMsg);
      }
      log.warn(`Remote sync retry cleanup failed: ${cleanupErrorMsg}`);
    }
  }

  protected async waitForProjectSyncRetryDelay(
    ms: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await sleepWithAbort(ms, abortSignal);
  }

  private async computeSnapshotDigest(projectPath: string): Promise<string> {
    // Workspace materialization only depends on branch tips. Tags are shared repo
    // metadata that can legitimately drift, so they must not participate in the
    // authoritative snapshot identity or force a resync on their own.
    const refsOutput = (await readGitHeadsRefs(projectPath)) ?? "";
    return crypto.createHash("sha256").update(refsOutput).digest("hex");
  }

  // ===== RemoteRuntime abstract method implementations =====

  protected readonly commandPrefix: string = "SSH";

  protected getBasePath(): string {
    return this.config.srcBaseDir;
  }

  protected quoteForRemote(filePath: string): string {
    return expandTildeForSSH(filePath);
  }

  protected cdCommand(cwd: string): string {
    return cdCommandForSSH(cwd);
  }

  protected async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    return this.transport.spawnRemoteProcess(fullCommand, {
      forcePTY: options.forcePTY,
      timeout: options.timeout,
      abortSignal: options.abortSignal,
      deadlineMs: options.deadlineMs,
    });
  }

  /**
   * Override buildWriteCommand for SSH to handle symlinks and preserve permissions.
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    // Resolve symlinks to get the actual target path, preserving the symlink itself
    // If target exists, save its permissions to restore after write
    // If path doesn't exist, use 600 as default
    // Then write atomically using mv (all-or-nothing for readers)
    return `RESOLVED=$(readlink -f ${quotedPath} 2>/dev/null || echo ${quotedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 600) && mkdir -p $(dirname "$RESOLVED") && cat > ${quotedTempPath} && chmod "$PERMS" ${quotedTempPath} && mv ${quotedTempPath} "$RESOLVED"`;
  }

  // ===== Runtime interface implementations =====

  async resolvePath(filePath: string): Promise<string> {
    // Expand ~ on the remote host.
    // Note: `p='~/x'; echo "$p"` does NOT expand ~ (tilde expansion happens before assignment).
    // We do explicit expansion using parameter substitution (no reliance on `realpath`, `readlink -f`, etc.).
    const script = [
      `p=${shescape.quote(filePath)}`,
      'if [ "$p" = "~" ]; then',
      '  echo "$HOME"',
      'elif [ "${p#\\~/}" != "$p" ]; then',
      '  echo "$HOME/${p#\\~/}"',
      'elif [ "${p#/}" != "$p" ]; then',
      '  echo "$p"',
      "else",
      '  echo "$PWD/$p"',
      "fi",
    ].join("\n");

    const command = `bash -lc ${shescape.quote(script)}`;

    // Wait for connection establishment (including host-key confirmation) before
    // starting the 10s command timeout. Otherwise users who take >10s to accept
    // the host key prompt will hit a false timeout immediately after acceptance.
    const resolvePathTimeoutMs = 10_000;

    await this.transport.acquireConnection({
      timeoutMs: resolvePathTimeoutMs,
      maxWaitMs: resolvePathTimeoutMs,
    });

    const abortController = createAbortController(resolvePathTimeoutMs);
    try {
      const result = await execBuffered(this, command, {
        cwd: "/tmp",
        abortSignal: abortController.signal,
      });

      if (abortController.didTimeout()) {
        throw new Error(`SSH command timed out after 10000ms: ${command}`);
      }

      if (result.exitCode !== 0) {
        const message = result.stderr || result.stdout || "Unknown error";
        throw new Error(`Failed to resolve SSH path: ${message}`);
      }

      return result.stdout.trim();
    } finally {
      abortController.dispose();
    }
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    if (
      this.currentWorkspacePath &&
      this.ensureReadyProjectPath === projectPath &&
      this.ensureReadyWorkspaceName === workspaceName
    ) {
      return this.currentWorkspacePath;
    }

    return getRemoteWorkspacePath(this.getProjectLayout(projectPath), workspaceName);
  }

  /**
   * Path to the shared bare repo for a project on the remote.
   * All worktree-based workspaces share this object store.
   */
  private getBaseRepoPath(projectPath: string): string {
    return this.getProjectLayout(projectPath).baseRepoPath;
  }

  /**
   * Ensure the shared bare repo exists on the remote for a project.
   * Creates it lazily on first use. Returns the shell-expanded path arg
   * for use in subsequent commands.
   */
  private async ensureBaseRepo(
    projectPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<{ baseRepoPathArg: string; freshlyCreated: boolean }> {
    const layout = this.getProjectLayout(projectPath);
    const baseRepoPath = layout.baseRepoPath;
    const baseRepoPathArg = expandTildeForSSH(baseRepoPath);
    const parentDirArg = expandTildeForSSH(path.posix.dirname(baseRepoPath));

    // STARTUP-PERF: This used to be 3-5 sequential SSH round-trips
    // (test -d, mkdir, git init, normalize base config, unset 3× promisor keys).
    // Each round-trip costs ~80-100ms even over a multiplexed control channel,
    // so on a cold SSH workspace this single batched command shaves ~500ms off
    // the critical path of `mux run --runtime ssh <host>`.
    //
    // The script emits status sentinels that the caller parses for repo
    // creation, shared config-key normalization, and base HEAD normalization.
    //
    // Promisor keys are idempotently neutered as a best-effort epilogue (no
    // sentinel needed; failures fall through harmlessly because subsequent
    // pushes can re-run the cleanup if a deadlock recurs).
    const baseRepoUnbornHeadArg = shescape.quote(BASE_REPO_UNBORN_HEAD_REF);
    const configUnsetCmds = BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET.map((key) => {
      const statusName = key.replace(".", "_").toUpperCase();
      const errorPath = `/tmp/.mux-${key.replace(".", "-")}-$$.err`;
      return [
        `git --git-dir=${baseRepoPathArg} config --local --unset-all ${shescape.quote(key)} 2>${errorPath}`,
        "rc=$?",
        'if [ "$rc" -eq 0 ]; then',
        `  echo STATUS_${statusName}=unset`,
        'elif [ "$rc" -eq 5 ]; then',
        `  echo STATUS_${statusName}=absent`,
        "else",
        `  echo STATUS_${statusName}=error`,
        `  cat ${errorPath} >&2 2>/dev/null || true`,
        "fi",
        `rm -f ${errorPath} 2>/dev/null || true`,
      ].join("\n");
    }).join("\n");
    const promisorUnsetCmds = BASE_REPO_PROMISOR_CONFIG_KEYS.map(
      (key) => `git -C ${baseRepoPathArg} config --unset-all ${key} 2>/dev/null || true`
    ).join("\n");

    const cmd = [
      "set -u",
      // 1. Ensure repo directory exists (mkdir parent + git init --bare).
      `if test -d ${baseRepoPathArg}; then`,
      "  echo STATUS_CREATED=existed",
      "else",
      `  if ! mkdir -p ${parentDirArg}; then`,
      `    echo "ERROR: mkdir parent failed" >&2`,
      "    exit 1",
      "  fi",
      `  if ! git init --bare ${baseRepoPathArg} >/dev/null 2>&1; then`,
      `    echo "ERROR: git init --bare failed" >&2`,
      "    exit 1",
      "  fi",
      "  echo STATUS_CREATED=created",
      "fi",
      // 2. Normalize shared config keys in the *local* config — see
      //    normalizeBaseRepoSharedConfigKeys() for full context. Exit codes:
      //    0 = removed, 5 = key absent. Anything else needs the retry/inspect
      //    dance, which the caller handles by re-running the slow-path helper.
      configUnsetCmds,
      // 3. Keep the base repo's own HEAD off user branches so checkout-aware
      //    tooling doesn't mistake `.mux-base.git` for a real worktree. This
      //    symbolic ref is intentionally unborn; materialization detaches HEAD
      //    at the chosen base commit once one is known.
      `current_head=$(git --git-dir=${baseRepoPathArg} symbolic-ref HEAD 2>/dev/null || true)`,
      `if [ "$current_head" = ${baseRepoUnbornHeadArg} ]; then`,
      "  echo STATUS_BASE_HEAD=already",
      `elif git --git-dir=${baseRepoPathArg} symbolic-ref HEAD ${baseRepoUnbornHeadArg} 2>/tmp/.mux-base-head-$$.err; then`,
      "  echo STATUS_BASE_HEAD=set",
      "else",
      "  echo STATUS_BASE_HEAD=error",
      "  cat /tmp/.mux-base-head-$$.err >&2 2>/dev/null || true",
      "fi",
      "rm -f /tmp/.mux-base-head-$$.err 2>/dev/null || true",
      // 4. Idempotently strip partial-clone / promisor keys (always best-effort).
      //    See stripBaseRepoPromisorConfig() docstring for the upstream Git
      //    sideband-deadlock bug this guards against.
      promisorUnsetCmds,
      // 5. Force receive-pack to use index-pack (with `--fix-thin`) instead of
      //    `unpack-objects` for incoming pushes, regardless of object count.
      //    This avoids the "unresolved deltas left after unpacking" /
      //    "unpacker error" failure mode where small thin pushes (below the
      //    default `transfer.unpackLimit=100`) reach `unpack-objects`, which
      //    cannot resolve thin-pack delta bases. Best-effort: an older Git
      //    that does not honor this key still works under the retry path.
      //    Trade-off: more small packs, but the existing fragmented-base-repo
      //    maintenance (`ensureHealthyBaseRepoForSync`) collapses them on a
      //    schedule, so this is a net robustness win.
      `git -C ${baseRepoPathArg} config --local receive.unpackLimit 1 2>/dev/null || true`,
    ].join("\n");

    const result = await execBuffered(this, cmd, {
      cwd: "/tmp",
      timeout: 30,
      abortSignal,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to ensure base repo: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`
      );
    }

    const created = result.stdout.includes("STATUS_CREATED=created");
    const configStatuses = new Map(
      BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET.map((key) => [
        key,
        new RegExp(`STATUS_${key.replace(".", "_").toUpperCase()}=(\\w+)`).exec(result.stdout)?.[1],
      ])
    );
    const baseHeadStatus = /STATUS_BASE_HEAD=(\w+)/.exec(result.stdout)?.[1];

    if (created) {
      initLogger.logStep("Created shared base repository");
    }

    let loggedConfigNormalization = false;
    if ([...configStatuses.values()].some((status) => status === "unset")) {
      initLogger.logStep("Normalized shared base repository config for worktrees");
      loggedConfigNormalization = true;
    }

    const configErrorKeys = BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET.filter(
      (key) => configStatuses.get(key) === "error"
    );
    if (configErrorKeys.length > 0) {
      // Fall back to the slow-path retry helper, which handles lock conflicts
      // by re-trying with backoff and inspecting whether each key is still set.
      const normalized = await this.normalizeBaseRepoSharedConfigKeys(
        baseRepoPathArg,
        configErrorKeys,
        abortSignal
      );
      if (normalized && !loggedConfigNormalization) {
        initLogger.logStep("Normalized shared base repository config for worktrees");
      }
    }

    if (baseHeadStatus === "set") {
      initLogger.logStep("Neutralized shared base repository HEAD for worktrees");
    } else if (baseHeadStatus === "error") {
      throw new Error(
        `Failed to normalize base repo HEAD: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }

    return { baseRepoPathArg, freshlyCreated: created };
  }

  /**
   * Keep the shared SSH base repo bare by layout instead of by sharing checkout
   * config through the repo's common config. Linked worktrees consult that local
   * config too, so leaving keys like `core.bare` or `core.worktree` there leaks
   * base-repo metadata into normal workspace checkouts.
   */
  private async normalizeBaseRepoSharedConfigKeys(
    baseRepoPathArg: string,
    keys: readonly BaseRepoSharedConfigKey[],
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    let normalized = false;
    for (const key of keys) {
      normalized =
        (await this.normalizeBaseRepoSharedConfigKey(baseRepoPathArg, key, abortSignal)) ||
        normalized;
    }
    return normalized;
  }

  private async normalizeBaseRepoSharedConfigKey(
    baseRepoPathArg: string,
    key: BaseRepoSharedConfigKey,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const keyArg = shescape.quote(key);

    for (let attempt = 0; attempt <= BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const unsetResult = await execBuffered(
        this,
        `git --git-dir=${baseRepoPathArg} config --local --unset-all ${keyArg}`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );

      if (unsetResult.exitCode === 0) {
        return true;
      }

      if (unsetResult.exitCode === 5) {
        return false;
      }

      const errorDetail = unsetResult.stderr || unsetResult.stdout;
      if (!isGitConfigLockConflict(errorDetail)) {
        throw new Error(`Failed to normalize base repo config ${key}: ${errorDetail}`);
      }

      const inspectResult = await execBuffered(
        this,
        `git --git-dir=${baseRepoPathArg} config --local --get ${keyArg}`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );

      if (inspectResult.exitCode === 1) {
        return false;
      }

      if (inspectResult.exitCode !== 0) {
        throw new Error(
          `Failed to inspect base repo config ${key} after lock conflict: ${inspectResult.stderr || inspectResult.stdout}`
        );
      }

      if (attempt === BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS.length) {
        throw new Error(`Failed to normalize base repo config ${key}: ${errorDetail}`);
      }

      // Another initWorkspace may be healing the same shared base repo; if the
      // local key still exists, wait briefly and retry the idempotent unset.
      await new Promise((resolve) =>
        setTimeout(resolve, BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS[attempt])
      );
    }

    return false;
  }

  private async resolveWorktreeBaseRepoPath(
    projectPath: string,
    workspacePath: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const fallbackBaseRepoPath = this.getBaseRepoPath(projectPath);

    try {
      const result = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} rev-parse --path-format=absolute --git-common-dir`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );
      const resolvedBaseRepoPath = result.stdout.trim();
      if (result.exitCode === 0 && resolvedBaseRepoPath.length > 0) {
        return resolvedBaseRepoPath;
      }
    } catch {
      // Fall back to the canonical hashed layout when the existing workspace cannot report its
      // common git dir (for example, if the directory is already partially missing/corrupted).
    }

    return fallbackBaseRepoPath;
  }

  /**
   * Detect whether a remote workspace is a git worktree (`.git` is a file)
   * vs a legacy full clone (`.git` is a directory).
   */
  private async isWorktreeWorkspace(
    workspacePath: string,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const gitPath = path.posix.join(workspacePath, ".git");
    const result = await execBuffered(this, `test -f ${this.quoteForRemote(gitPath)}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal,
    });
    return result.exitCode === 0;
  }

  private async resolveCheckedOutBranch(
    workspacePath: string,
    abortSignal?: AbortSignal,
    timeout = 10
  ): Promise<string | null> {
    try {
      const branchResult = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} branch --show-current`,
        {
          cwd: "/tmp",
          timeout,
          abortSignal,
        }
      );
      const branchName = branchResult.stdout.trim();
      return branchResult.exitCode === 0 && branchName.length > 0 ? branchName : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the bundle staging ref for the trunk branch.
   * Returns refs/mux-bundle/<trunkBranch> if it exists, otherwise falls back
   * to the first available ref under refs/mux-bundle/ (handles main vs master
   * mismatches). Returns null if no bundle refs exist.
   */
  private async resolveBundleTrunkRef(
    baseRepoPathArg: string,
    trunkBranch: string,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    // Preferred: exact match for the expected trunk branch.
    const preferredRef = `${BUNDLE_REF_PREFIX}${trunkBranch}`;
    const check = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} rev-parse --verify ${shescape.quote(preferredRef)}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (check.exitCode === 0) {
      return preferredRef;
    }

    // Fallback: pick the first ref under refs/mux-bundle/ (handles main↔master mismatch).
    const listResult = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} for-each-ref --format='%(refname)' ${BUNDLE_REF_PREFIX} --count=1`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    const fallbackRef = listResult.stdout.trim();
    if (listResult.exitCode === 0 && fallbackRef.length > 0) {
      log.info(`Bundle trunk ref mismatch: expected ${preferredRef}, using ${fallbackRef}`);
      return fallbackRef;
    }

    return null;
  }

  private async remoteTrackingBranchExists(
    baseRepoPathArg: string,
    trunkBranch: string,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const originRef = `refs/remotes/origin/${trunkBranch}`;
    const check = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} rev-parse --verify --quiet ${shescape.quote(originRef)}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    return check.exitCode === 0;
  }

  private async resolveFreshWorkspaceSourceBase(
    baseRepoPathArg: string,
    trunkBranch: string,
    fetchedOrigin: boolean,
    fallbackRef: string | null,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<string> {
    if (
      fetchedOrigin &&
      (await this.remoteTrackingBranchExists(baseRepoPathArg, trunkBranch, abortSignal))
    ) {
      return `origin/${trunkBranch}`;
    }

    const fallbackBase = fallbackRef ?? "HEAD";
    initLogger.logStderr(
      `Note: origin/${trunkBranch} was not available on the remote host; using local snapshot ${fallbackBase}`
    );
    return fallbackBase;
  }

  private async resolveLocalSyncRefManifest(projectPath: string): Promise<string | null> {
    try {
      using proc = execFileAsync("git", ["-C", projectPath, "show-ref", "--heads"]);
      const { stdout } = await proc.result;
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort()
        .join("\n");
    } catch {
      return null;
    }
  }

  private async resolveRemoteSyncRefManifest(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const result = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} for-each-ref --format='%(objectname) %(refname)' ${BUNDLE_REF_PREFIX}`,
      { cwd: "/tmp", timeout: 20, abortSignal }
    );
    if (result.exitCode !== 0) {
      return null;
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf(" ");
        if (separator === -1) {
          return line;
        }

        const oid = line.slice(0, separator);
        const refName = line.slice(separator + 1);
        const normalizedRefName = refName.startsWith(BUNDLE_REF_PREFIX)
          ? refName.replace(BUNDLE_REF_PREFIX, "refs/heads/")
          : refName;
        return `${oid} ${normalizedRefName}`;
      })
      .sort()
      .join("\n");
  }

  private async refreshBaseRepoOrigin(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const { originUrl } = await this.getOriginUrlForSync(projectPath, initLogger);
    if (!originUrl) {
      return;
    }

    initLogger.logStep(`Setting origin remote to ${originUrl}...`);
    await execBuffered(
      this,
      `git -C ${baseRepoPathArg} remote set-url origin ${shescape.quote(originUrl)} 2>/dev/null || git -C ${baseRepoPathArg} remote add origin ${shescape.quote(originUrl)}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
  }

  /**
   * Pre-fetch from origin on the remote host to reduce local→remote push size.
   *
   * When the remote bare repo has an origin configured, runs `git fetch origin`
   * on the SSH host. The host's datacenter connection to the upstream is
   * typically much faster than the local machine's (e.g., hotel wifi vs
   * datacenter). After this, the subsequent local→remote `git push` only needs
   * to transfer objects that don't exist on origin — usually just unpushed
   * local commits.
   *
   * Best-effort: failures are swallowed because the push still works without
   * the pre-populated cache (it just transfers more data).
   */
  private async prefetchOriginOnRemote(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<{ refreshedOrigin: boolean }> {
    // Skip the entire prefetch dance when the local project has no `origin`
    // remote. The fetch is *guaranteed* to fail in that case (no origin URL
    // gets propagated to the remote base repo by `refreshBaseRepoOrigin`), and
    // each SSH round-trip costs ~80–100ms on a fresh connection. On a cold SSH
    // workspace startup against a project without `origin` (e.g. `mux run` on
    // a scratch repo, local-only project, or fresh clone with no remote), this
    // single guard removes ~500ms of pure overhead from the critical path.
    const { originUrl } = await this.getOriginUrlForSync(projectPath, initLogger);
    if (!originUrl) {
      return { refreshedOrigin: false };
    }

    // Local has an origin; propagate it to the remote base repo so the fetch
    // below has somewhere to pull from.
    await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);

    try {
      initLogger.logStep("Pre-fetching from origin on remote host...");
      const result = await execBuffered(
        this,
        // Fetch all branches from origin into the base repo's object store.
        // This runs entirely on the remote — only the SSH control channel
        // traverses the local link, so it's fast even on slow connections.
        `git -C ${baseRepoPathArg} fetch --prune origin`,
        { cwd: "/tmp", timeout: 120, abortSignal }
      );
      if (result.exitCode === 0) {
        initLogger.logStep("Pre-fetched from origin on remote host");
      } else {
        initLogger.logStep("Pre-fetch from origin skipped (fetch failed)");
        // Preserve the stderr in debug logs so we can diagnose recurrent
        // prefetch misses (auth, unreachable URL, mismatched origin) without
        // surfacing noisy detail on the happy path.
        const detail = (result.stderr || result.stdout).trim();
        if (detail) {
          log.debug("Pre-fetch from origin failed", { detail });
        }
      }
    } catch (error) {
      // Best-effort — if origin is unreachable or not configured, the local
      // push will still transfer all required objects.
      initLogger.logStep("Pre-fetch from origin skipped (not reachable)");
      log.debug("Pre-fetch from origin errored", { error: getErrorMessage(error) });
    }
    return { refreshedOrigin: true };
  }

  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const repoCheck = await this.checkWorkspaceRepo(options);
    if (repoCheck) {
      if (!repoCheck.ready) {
        options?.statusSink?.({
          phase: "error",
          runtimeType: "ssh",
          detail: repoCheck.error,
        });
        return repoCheck;
      }

      options?.statusSink?.({ phase: "ready", runtimeType: "ssh" });
      return { ready: true };
    }

    return { ready: true };
  }

  protected async checkWorkspaceRepo(
    options?: EnsureReadyOptions
  ): Promise<EnsureReadyResult | null> {
    if (!this.ensureReadyProjectPath || !this.ensureReadyWorkspaceName) {
      return null;
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "ssh",
      detail: "Checking repository...",
    });

    if (options?.signal?.aborted) {
      return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
    }

    const workspacePath = this.getWorkspacePath(
      this.ensureReadyProjectPath,
      this.ensureReadyWorkspaceName
    );
    const gitDir = path.posix.join(workspacePath, ".git");
    const gitDirProbe = this.quoteForRemote(gitDir);
    const workspacePathArg = this.quoteForRemote(workspacePath);
    const verifyWorkspaceCommand = [
      // .git is a file for worktrees; accept either file or directory so existing SSH/Coder
      // worktree checkouts don't get flagged as setup failures. Keep this as one remote shell
      // invocation because stream startup runs it before every first SSH use for a workspace.
      `if ! (test -d ${gitDirProbe} || test -f ${gitDirProbe}); then`,
      `  echo ${shescape.quote(`missing .git at ${gitDir}`)} >&2`,
      "  exit 10",
      "fi",
      `git_dir_output=$(git -C ${workspacePathArg} rev-parse --git-dir 2>&1)`,
      "git_dir_status=$?",
      'if [ "$git_dir_status" -ne 0 ]; then',
      '  printf "%s\\n" "$git_dir_output" >&2',
      '  exit "$git_dir_status"',
      "fi",
      `inside_output=$(git -C ${workspacePathArg} rev-parse --is-inside-work-tree 2>&1)`,
      "inside_status=$?",
      'if [ "$inside_status" -ne 0 ]; then',
      '  printf "%s\\n" "$inside_output" >&2',
      '  exit "$inside_status"',
      "fi",
      'if [ "$inside_output" != "true" ]; then',
      '  printf "not inside worktree: %s\\n" "$inside_output" >&2',
      "  exit 11",
      "fi",
    ].join("\n");

    let verifyResult: { exitCode: number; stderr: string; stdout: string };
    try {
      verifyResult = await execBuffered(this, verifyWorkspaceCommand, {
        cwd: "~",
        timeout: 10,
        abortSignal: options?.signal,
      });
    } catch (error) {
      return {
        ready: false,
        error: `Failed to reach SSH host: ${getErrorMessage(error)}`,
        errorType: "runtime_start_failed",
      };
    }

    if (verifyResult.exitCode !== 0) {
      const stderr = verifyResult.stderr.trim();
      const stdout = verifyResult.stdout.trim();
      const errorDetail = stderr || stdout || "git unavailable";
      const isCommandMissing =
        verifyResult.exitCode === 127 || /command not found/i.test(stderr || stdout);

      if (this.transport.isConnectionFailure(verifyResult.exitCode, verifyResult.stderr)) {
        return {
          ready: false,
          error: `Failed to reach SSH host: ${errorDetail || "connection failure"}`,
          errorType: "runtime_start_failed",
        };
      }

      if (isCommandMissing) {
        return {
          ready: false,
          error: `Failed to verify repository: ${errorDetail}`,
          errorType: "runtime_start_failed",
        };
      }

      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    return { ready: true };
  }

  /**
   * Transfer a git bundle to the remote and return its path.
   * Callers are responsible for cleanup of the remote bundle file.
   */
  private async transferBundleToRemote(
    projectPath: string,
    remoteBundlePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<string> {
    await this.transport.acquireConnection({
      abortSignal,
      onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
    });

    if (abortSignal?.aborted) {
      throw new Error("Bundle creation aborted");
    }

    initLogger.logStep("Creating git bundle...");
    // Use --branches --tags instead of --all to exclude refs/remotes/origin/*
    // from the bundle. Those tracking refs are from the local machine's last
    // fetch and can be arbitrarily stale — importing them into the shared bare
    // base repo would give worktrees a wrong "commits behind" count.
    const gitProc = spawn(
      "git",
      ["-C", projectPath, "bundle", "create", "-", "--branches", "--tags"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    // Handle stderr manually - do NOT use streamProcessToLogger here.
    // It attaches a stdout listener that drains data before pipeReadableToWebWritable
    // can consume it, corrupting the bundle.
    let stderr = "";
    gitProc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) {
        initLogger.logStderr(line);
      }
    });

    const remoteAbortController = createAbortController(300_000, abortSignal);
    const remoteStream = await this.exec(`cat > ${this.quoteForRemote(remoteBundlePath)}`, {
      cwd: "~",
      abortSignal: remoteAbortController.signal,
    });

    try {
      try {
        await pipeReadableToWebWritable(gitProc.stdout, remoteStream.stdin, abortSignal);
      } catch (error) {
        gitProc.kill();
        throw error;
      }

      const [gitExitCode, remoteExitCode] = await Promise.all([
        waitForProcessExit(gitProc),
        remoteStream.exitCode,
      ]);

      if (remoteAbortController.didTimeout()) {
        throw new Error(
          `SSH command timed out after 300000ms: cat > ${this.quoteForRemote(remoteBundlePath)}`
        );
      }

      if (abortSignal?.aborted) {
        throw new Error("Bundle creation aborted");
      }

      if (gitExitCode !== 0) {
        throw new Error(`Failed to create bundle: ${stderr}`);
      }

      if (remoteExitCode !== 0) {
        const remoteStderr = await streamToString(remoteStream.stderr);
        throw new Error(`Failed to upload bundle: ${remoteStderr}`);
      }
    } finally {
      remoteAbortController.dispose();
    }

    return remoteBundlePath;
  }

  private async syncProjectSnapshotViaBundle(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    snapshotDigest: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Snapshot markers stay deterministic, but the uploaded bundle itself must use
    // a per-attempt temp path so concurrent Xum processes do not stream into the same file.
    const remoteBundlePath = path.posix.join(
      "~/.mux-bundles",
      layout.projectId,
      `${snapshotDigest}.${crypto.randomUUID()}.bundle`
    );
    const remoteBundlePathArg = this.quoteForRemote(remoteBundlePath);
    const remoteBundleParentDir = path.posix.dirname(remoteBundlePath);
    const prepareRemoteDirs = await execBuffered(
      this,
      `mkdir -p ${this.quoteForRemote(remoteBundleParentDir)} ${this.quoteForRemote(path.posix.dirname(currentSnapshotPath))}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (prepareRemoteDirs.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote snapshot directories: ${prepareRemoteDirs.stderr || prepareRemoteDirs.stdout}`
      );
    }

    await this.transferBundleToRemote(projectPath, remoteBundlePath, initLogger, abortSignal);

    try {
      // Import authoritative branches and shared tags from the bundle into the
      // shared bare repo. Branches land in refs/mux-bundle/* (staging namespace)
      // instead of refs/heads/* to avoid colliding with branches checked out in
      // existing worktrees, and they stay pruneable because branch deletion should
      // invalidate snapshot reuse. Tags go directly to refs/tags/*, but they are
      // fetched separately without --prune so remote-only metadata tags survive.
      initLogger.logStep("Importing bundle into shared base repository...");
      const branchFetchResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} fetch --prune ${remoteBundlePathArg} '+refs/heads/*:${BUNDLE_REF_PREFIX}*'`,
        { cwd: "/tmp", timeout: 300, abortSignal }
      );
      if (branchFetchResult.exitCode !== 0) {
        throw new Error(
          `Failed to import bundle branches into base repo: ${branchFetchResult.stderr || branchFetchResult.stdout}`
        );
      }

      const tagFetchResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} fetch ${remoteBundlePathArg} '+refs/tags/*:refs/tags/*'`,
        { cwd: "/tmp", timeout: 300, abortSignal }
      );
      if (tagFetchResult.exitCode !== 0) {
        throw new Error(
          `Failed to import bundle tags into base repo: ${tagFetchResult.stderr || tagFetchResult.stdout}`
        );
      }
    } finally {
      // Best-effort cleanup of the remote bundle file.
      try {
        await execBuffered(this, `rm -f ${remoteBundlePathArg}`, {
          cwd: "/tmp",
          timeout: 10,
        });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  private async hasLocalTags(projectPath: string): Promise<boolean> {
    using proc = execFileAsync("git", [
      "-C",
      projectPath,
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "refs/tags",
    ]);
    const { stdout } = await proc.result;
    return stdout.trim().length > 0;
  }

  /**
   * Build a GIT_SSH_COMMAND that mirrors the runtime's SSH config so `git push`
   * reuses the same multiplexed connection and auth settings.
   */
  private buildGitSshCommand(): string {
    const config = this.transport.getConfig();
    // GIT_SSH_COMMAND is interpreted as a shell command string, so values
    // containing spaces or special characters must be quoted to prevent
    // incorrect word-splitting (e.g., identity file paths with spaces,
    // ControlPath under /tmp with user-generated segments).
    const singleQuote = "'";
    const escapedSingleQuote = `${singleQuote}\\${singleQuote}${singleQuote}`;
    const q = (s: string) => `${singleQuote}${s.replace(/'/g, escapedSingleQuote)}${singleQuote}`;

    const args: string[] = ["ssh"];

    if (config.port) {
      args.push("-p", config.port.toString());
    }
    if (config.identityFile) {
      args.push("-i", q(config.identityFile));
    }

    // Reuse the runtime's ControlPath so git push piggybacks on the existing
    // multiplexed connection instead of opening a new one.
    const controlPath = getControlPath(config);
    args.push("-o", "LogLevel=FATAL");
    args.push("-o", "ControlMaster=auto");
    args.push("-o", q(`ControlPath=${controlPath}`));
    args.push("-o", "ControlPersist=60");
    args.push("-o", "BatchMode=yes");
    args.push("-o", "ConnectTimeout=15");
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");

    // Match the runtime's host key policy (permissive in headless mode).
    appendOpenSSHHostKeyPolicyArgs(args);

    return args.join(" ");
  }

  private async syncProjectSnapshotViaGitPush(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    options: { forceNoThin?: boolean } = {}
  ): Promise<void> {
    // `forceNoThin` opts the push out of thin-pack delta-base optimization.
    // This is set by the retry path after an "unresolved deltas" / "unpacker
    // error" failure: the remote couldn't resolve the thin pack's delta
    // bases, so we resend a self-contained pack on the next attempt instead
    // of rerunning the same thin push and failing the same way.
    const forceNoThin = options.forceNoThin === true;
    const prepareSnapshotDir = await execBuffered(
      this,
      `mkdir -p ${this.quoteForRemote(path.posix.dirname(currentSnapshotPath))}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (prepareSnapshotDir.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote snapshot directory: ${prepareSnapshotDir.stderr || prepareSnapshotDir.stdout}`
      );
    }

    await this.transport.acquireConnection({
      abortSignal,
      onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
    });

    if (abortSignal?.aborted) {
      throw new Error("Sync aborted");
    }

    initLogger.logStep("Pushing to remote...");

    // Build the SSH remote URL pointing to the shared bare base repo.
    // Use ssh:// URL format (not SCP-style host:path) because:
    //  - SCP-style breaks on IPv6 literals (first : is ambiguous)
    //  - ssh:// handles ~/ paths natively via /~/ syntax
    //  - ssh:// respects the port from GIT_SSH_COMMAND without -p duplication
    const baseRepoPath = layout.baseRepoPath;
    // ssh:// URLs: /~/ means home-relative, / means absolute, and relative
    // paths need /~/ prefix (resolved relative to home on the remote).
    let urlPath: string;
    if (baseRepoPath.startsWith("~/")) {
      urlPath = `/~/${baseRepoPath.slice(2)}`;
    } else if (baseRepoPath.startsWith("/")) {
      urlPath = baseRepoPath;
    } else {
      // Relative path (e.g., "src/project/.mux-base.git") — treat as
      // home-relative to match the old bundle flow's shell resolution.
      urlPath = `/~/${baseRepoPath}`;
    }
    // Bracket bare IPv6 addresses for URL syntax. The host field can be:
    //   hostname        → no change
    //   user@hostname   → no change
    //   2001:db8::1     → [2001:db8::1]       (bare IPv6)
    //   user@[::1]      → no change            (already bracketed)
    //   [::1]           → no change            (already bracketed)
    const host = this.config.host;
    const atIdx = host.lastIndexOf("@");
    const hostPart = atIdx >= 0 ? host.slice(atIdx + 1) : host;
    const userPrefix = atIdx >= 0 ? host.slice(0, atIdx + 1) : "";
    const needsBrackets = hostPart.includes(":") && !hostPart.startsWith("[");
    const urlHost = needsBrackets ? `${userPrefix}[${hostPart}]` : host;
    const remoteUrl = `ssh://${urlHost}${urlPath}`;
    const gitSshCommand = this.buildGitSshCommand();

    // Push authoritative branches and shared tags separately. Branches land in
    // refs/mux-bundle/* (staging namespace) and stay pruneable because branch
    // deletion should invalidate snapshot reuse. Tags go to refs/tags/* as
    // shared metadata, but they must not be pruned based on this local clone's
    // view of the repo.
    //
    // NOTE: This runs `git push` locally (not through the runtime's SSHTransport),
    // so it depends on the local `ssh` CLI being available. On OpenSSH runtimes,
    // the transport already depends on that binary and shares the same ControlPath.
    const runPush = async (pushArgs: string[]): Promise<void> => {
      if (abortSignal?.aborted) {
        throw new Error("Git push aborted");
      }

      using pushProc = execFileAsync("git", pushArgs, {
        env: { GIT_SSH_COMMAND: gitSshCommand },
        onStderrData: (chunk) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            initLogger.logStderr(line);
          }
        },
      });

      // Bound the push with a 300s timeout (matching the old bundle path) and
      // wire up abort signal — disposing kills the child process.
      const pushTimeout = setTimeout(() => pushProc[Symbol.dispose](), 300_000);
      const onAbort = () => pushProc[Symbol.dispose]();
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
      }
      try {
        await pushProc.result;
      } finally {
        clearTimeout(pushTimeout);
        abortSignal?.removeEventListener("abort", onAbort);
      }
    };
    const throwPushFailure = (error: unknown): never => {
      const errorMsg = getErrorMessage(error);
      const exitCode = (error as { code?: number | null }).code ?? null;
      const isConnectionFailure =
        (exitCode != null && this.transport.isConnectionFailure(exitCode, errorMsg)) ||
        isGitPushTransportFailure(exitCode, errorMsg);
      if (isConnectionFailure) {
        sshConnectionPool.reportFailure(this.transport.getConfig(), truncateSSHError(errorMsg));
      }
      throw new Error(`Failed to push to remote: ${errorMsg}`);
    };
    // `--no-thin` flag is positioned before the URL so it applies to the
    // pack-objects step git invokes for this push (and to nothing else).
    const noThinFlag = forceNoThin ? ["--no-thin"] : [];
    const branchPushArgsBase = [
      "-C",
      projectPath,
      "push",
      "--force",
      "--prune",
      "--no-verify",
      ...noThinFlag,
      remoteUrl,
      `+refs/heads/*:${BUNDLE_REF_PREFIX}*`,
    ];

    try {
      await runPush([
        ...branchPushArgsBase.slice(0, 4),
        "--atomic",
        ...branchPushArgsBase.slice(4),
      ]);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (!isUnsupportedAtomicPush(errorMsg)) {
        throwPushFailure(error);
      }

      initLogger.logStep("Remote git does not support atomic push; retrying without --atomic...");
      try {
        await runPush(branchPushArgsBase);
      } catch (retryError) {
        throwPushFailure(retryError);
      }
    }

    // Metadata propagation is a true no-op when the local repo has no tags.
    // Guarding the tag push keeps branch sync authoritative instead of failing on
    // Git's "no refs in common" error for an empty tag refspec.
    if (!(await this.hasLocalTags(projectPath))) {
      return;
    }

    try {
      await runPush([
        "-C",
        projectPath,
        "push",
        "--force",
        "--no-verify",
        ...noThinFlag,
        remoteUrl,
        "+refs/tags/*:refs/tags/*",
      ]);
    } catch (error) {
      throwPushFailure(error);
    }
  }

  /**
   * Sync local project to the shared bare base repo on the remote.
   *
   * OpenSSH runtimes use native `git push` so Git negotiates incremental object
   * transfer automatically. SSH2 runtimes keep the bundle path so sync does not
   * depend on a local OpenSSH CLI or local known_hosts state.
   *
   * Branches are the authoritative workspace-materialization state: they land in
   * refs/mux-bundle/* so they do not collide with worktree checkouts, and they
   * remain pruneable so branch deletions invalidate snapshot reuse. Tags still
   * sync into refs/tags/* when a branch resync happens, but they are treated as
   * shared metadata instead of authoritative snapshot state.
   */
  protected async syncProjectToRemote(
    projectPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    const layout = this.getProjectLayout(projectPath);
    const projectKey = this.getProjectSyncKey(layout.projectId);
    const retryCleanupBaseRepoPathArg = expandTildeForSSH(layout.baseRepoPath);

    // Keep retries, cancellation handling, and retry cleanup inside the project-scoped
    // sync lock so a follow-up init cannot race the shared base repo while we are healing it.
    await enqueueProjectSync(projectKey, abortSignal, async () => {
      // Latches once a thin-pack delta-base failure is observed so every
      // subsequent attempt in this sync push a self-contained pack (`--no-thin`).
      // Stays `false` for connection-reset / killed-by-signal retries since
      // those don't benefit from forcing a larger pack.
      let forceNoThinNextAttempt = false;
      for (let attempt = 1; attempt <= PROJECT_SYNC_MAX_ATTEMPTS; attempt++) {
        if (abortSignal?.aborted) {
          throw new Error(OPERATION_ABORTED_ERROR);
        }

        try {
          await this.syncProjectToRemoteOnce(projectPath, layout, initLogger, abortSignal, {
            forceNoThin: forceNoThinNextAttempt,
          });
          return;
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          if (abortSignal?.aborted || errorMsg === OPERATION_ABORTED_ERROR) {
            throw error instanceof Error ? error : new Error(errorMsg);
          }
          if (
            !this.isRetryableProjectSyncError(errorMsg) ||
            attempt === PROJECT_SYNC_MAX_ATTEMPTS
          ) {
            throw new Error(`Failed to sync project: ${errorMsg}`);
          }

          if (isUnresolvedDeltaPushFailure(errorMsg)) {
            forceNoThinNextAttempt = true;
          }

          log.info(
            `Sync failed (attempt ${attempt}/${PROJECT_SYNC_MAX_ATTEMPTS}), will retry: ${errorMsg}`
          );
          await this.cleanupRetryableProjectSyncFailure(
            retryCleanupBaseRepoPathArg,
            attempt,
            PROJECT_SYNC_MAX_ATTEMPTS,
            abortSignal
          );
          if (abortSignal?.aborted) {
            throw new Error(OPERATION_ABORTED_ERROR);
          }
          initLogger.logStep(
            `Sync failed, retrying (attempt ${attempt + 1}/${PROJECT_SYNC_MAX_ATTEMPTS})...`
          );
          await this.waitForProjectSyncRetryDelay(attempt * 1000, abortSignal);
        }
      }
    });
  }

  protected async syncProjectToRemoteOnce(
    projectPath: string,
    layout: RemoteProjectLayout,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    options: { forceNoThin?: boolean } = {}
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(OPERATION_ABORTED_ERROR);
    }

    const currentSnapshotPath = layout.currentSnapshotPath;
    const useNativeGitPush = this.transport instanceof OpenSSHTransport;
    const snapshotDigest = await this.computeSnapshotDigest(projectPath);
    const { baseRepoPathArg, freshlyCreated } = await this.ensureBaseRepo(
      projectPath,
      initLogger,
      abortSignal
    );

    // Treat the shared bare repo as a managed cache: verify its health before
    // we ask Git to negotiate another sync against a fragmented object store.
    //
    // STARTUP-PERF: When ensureBaseRepo just created the bare repo, we know
    // it has zero packs — there is nothing to be fragmented yet. Skip the
    // remote `count-objects -v` probe (~80-100ms SSH round-trip) on the cold
    // path; the next sync against a populated repo will run it normally.
    if (!freshlyCreated) {
      await this.ensureHealthyBaseRepoForSync(baseRepoPathArg, initLogger, abortSignal);
    }

    const snapshotStatusCheck = await execBuffered(
      this,
      [
        'current_snapshot=""',
        `if test -f ${this.quoteForRemote(currentSnapshotPath)}; then`,
        `  current_snapshot=$(tr -d '\n' < ${this.quoteForRemote(currentSnapshotPath)})`,
        "fi",
        `if test "$current_snapshot" = ${shescape.quote(snapshotDigest)}; then`,
        `  staged_ref=$(git -C ${baseRepoPathArg} for-each-ref --count=1 --format='%(refname)' ${shescape.quote(BUNDLE_REF_PREFIX)})`,
        '  if test -n "$staged_ref"; then',
        "    echo reusable",
        "  else",
        "    echo stale-current",
        "  fi",
        "else",
        "  echo missing",
        "fi",
      ].join("\n"),
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    const snapshotStatus = snapshotStatusCheck.stdout.trim();
    if (snapshotStatus === "reusable") {
      const localRefManifest = await this.resolveLocalSyncRefManifest(projectPath);
      const remoteRefManifest =
        localRefManifest == null
          ? null
          : await this.resolveRemoteSyncRefManifest(baseRepoPathArg, abortSignal);
      if (localRefManifest != null && remoteRefManifest === localRefManifest) {
        await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);
        await this.ensureBaseRepoSnapshotConnectivity(
          projectPath,
          baseRepoPathArg,
          initLogger,
          abortSignal
        );
        initLogger.logStep("Reusing existing remote project snapshot");
        return;
      }
      initLogger.logStep(
        "Remote snapshot marker drifted from synced refs; resyncing project snapshot..."
      );
    }
    if (snapshotStatus === "stale-current") {
      initLogger.logStep(
        "Remote snapshot marker found without matching synced refs; resyncing project snapshot..."
      );
    }

    let originAlreadyRefreshed = false;
    if (useNativeGitPush) {
      // Pre-populate the remote base repo with objects from origin before the
      // local→remote push. The SSH host's datacenter connection is typically
      // orders of magnitude faster than the local machine's (e.g., hotel wifi),
      // so fetching origin on the remote first turns the subsequent push into a
      // small incremental transfer instead of a full repo upload.
      // Only useful for git-push sync — bundle sync uploads a fresh local bundle
      // that can't reuse remote objects, so the prefetch would be wasted I/O.
      const prefetchResult = await this.prefetchOriginOnRemote(
        projectPath,
        baseRepoPathArg,
        initLogger,
        abortSignal
      );
      originAlreadyRefreshed = prefetchResult.refreshedOrigin;

      await this.syncProjectSnapshotViaGitPush(
        projectPath,
        layout,
        currentSnapshotPath,
        initLogger,
        abortSignal,
        { forceNoThin: options.forceNoThin === true }
      );
    } else {
      await this.syncProjectSnapshotViaBundle(
        projectPath,
        layout,
        currentSnapshotPath,
        snapshotDigest,
        baseRepoPathArg,
        initLogger,
        abortSignal
      );
    }

    // Keep the bare base repo's origin aligned with the local project so later
    // fetchOriginTrunk() calls base new worktrees on the intended remote.
    // Skip when prefetchOriginOnRemote already pushed the same origin URL this
    // pass — saves one SSH round-trip on every cold sync.
    if (!originAlreadyRefreshed) {
      await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);
    }

    const currentSnapshotWriter = this.writeFile(currentSnapshotPath).getWriter();
    try {
      await currentSnapshotWriter.write(new TextEncoder().encode(`${snapshotDigest}\n`));
    } finally {
      await currentSnapshotWriter.close();
    }

    initLogger.logStep("Repository synced to base successfully");
  }

  /** Get origin URL from local project for setting on the remote base repo. */
  private async getOriginUrlForSync(
    projectPath: string,
    initLogger: InitLogger
  ): Promise<{ originUrl: string | null }> {
    return getOriginUrlForBundle(projectPath, initLogger, /* logErrors */ false);
  }

  /**
   * Implements the async `Runtime.createWorkspace` contract. After the
   * STARTUP-PERF mkdir removal this method no longer performs any awaited
   * work, but it must remain async to satisfy the interface (other runtimes
   * still do real I/O here) and so future runtime-specific provisioning can
   * be reintroduced without churning every call site.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    try {
      const { projectPath, directoryName } = params;
      const layout = this.getProjectLayout(projectPath);
      // Workspace directories follow the persisted workspace name; branch checkout happens later.
      const workspacePath = getRemoteWorkspacePath(layout, directoryName);

      // STARTUP-PERF: The previous implementation issued an SSH `mkdir -p` here
      // to ensure the workspace's parent directory exists before `initWorkspace`.
      // That round-trip is unnecessary because both materialization paths in
      // `prepareWorkspaceCheckout()` (warm fast-path + slow path) create their
      // own parents:
      //   - The slow path's `ensureBaseRepo()` runs `mkdir -p <baseRepoPath>`,
      //     which creates the shared project root dir as a side effect.
      //   - The warm fast-path's single fused command runs `mkdir -p` for the
      //     workspace parent inline before `git worktree add`.
      // Folding the mkdir into materialization shaves one full SSH RTT off
      // every workspace startup, which is the dominant constant cost on the
      // warm path.
      return {
        success: true,
        workspacePath,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    // Disable git hooks for untrusted projects (prevents post-checkout execution)
    const nhp = gitNoHooksPrefix(params.trusted);

    return runWorkspaceInitHook({
      params,
      runtimeType: "ssh",
      findHookRelativePath: () => findInitHookRelativePath(this, params.workspacePath),
      beforeHook: async () => {
        await this.prepareWorkspaceCheckout(params, nhp);
      },
      runHook: async ({ hookRelativePath, xumEnv, initLogger, abortSignal }) => {
        // Expand tilde in hook path (quoted paths don't auto-expand on remote).
        const hookPath = expandTildeForSSH(`${params.workspacePath}/${hookRelativePath}`);
        await runInitHookOnRuntime(
          this,
          hookPath,
          params.workspacePath,
          xumEnv,
          initLogger,
          abortSignal
        );
      },
    });
  }

  /**
   * Try to create the workspace via a single fused SSH command (warm fast-path).
   *
   * Contract: when the remote already has a healthy shared base repo for this
   * project AND the staged `refs/mux-bundle/*` tips already match the local
   * project's `refs/heads/*` tips, we can skip the entire sync pipeline and
   * jump straight to `git worktree add`. That's the **common case** for
   * subsequent `mux run` invocations against the same SSH host + project.
   *
   * Why this matters: the slow path takes ~9 sequential SSH round-trips. Each
   * SSH command is ~80ms even on a multiplexed control channel, so just the
   * call overhead totals ~720ms before any real work. By fusing the probe +
   * (optional origin fetch) + materialize into a single shell pipeline, we
   * collapse that to a single client→host round-trip, keeping warm workspace
   * creates well under the slow path's wall-clock budget.
   *
   * Origin freshness: when the local project has an `origin` remote, the
   * fused script *also* runs `git fetch origin <trunkBranch>` on the host
   * before `git worktree add`. The new worktree then bases on
   * `refs/remotes/origin/<trunkBranch>` (matching the slow path's
   * `resolveFreshWorkspaceSourceBase` semantics) and falls back to the
   * bundle ref when the fetch fails. The fetch traverses the host's
   * upstream link, not the client's SSH link, so it does not add a
   * client-side round-trip.
   *
   * Returns true on a successful warm materialization. Returns false on miss
   * (and the caller falls through to the slow path). Throws only on
   * unrecoverable errors that are guaranteed to also fail on the slow path —
   * everything else is treated as a miss so the slow path can self-heal.
   *
   * Miss reasons (printed to stdout as `WARM_MISS:<reason>` for log clarity):
   *   - no-base-repo          : shared base repo doesn't exist yet (cold start)
   *   - snapshot-marker-missing: snapshot identity file isn't present
   *   - snapshot-digest-drift : local refs have moved since last sync
   *   - workspace-exists      : target workspace path already populated
   *   - no-bundle-ref         : no bundle ref *and* no origin tracking ref available
   *   - worktree-add-failed   : git worktree add returned non-zero
   */
  /**
   * Result returned by `tryWarmWorktreeAdd()` on a warm-path hit.
   * `gitmodulesPresent` is reported by the fused SSH command so the caller
   * can skip the post-worktree submodule-sync probe (another SSH RT) when
   * the workspace has no `.gitmodules`.
   */
  private async tryWarmWorktreeAdd(
    params: WorkspaceInitParams,
    nhp: string
  ): Promise<{ gitmodulesPresent: boolean } | null> {
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal } = params;

    // Local prerequisites — all computed without any SSH calls.
    //
    // STARTUP-PERF: We deliberately use only the snapshot **digest** to gate
    // the warm path (no separate ref-manifest check). The digest is the
    // sha256 of `git show-ref --heads` output: if it matches the digest
    // persisted on the remote at sync time, the local heads MUST be the same
    // (modulo a sha256 collision). Skipping the manifest verification saves
    // both an SSH round-trip and a `git show-ref` parse pass — both are pure
    // overhead on the warm path because they always agree when the digests
    // match. If a digest mismatch happens, we fall through to the slow path,
    // which independently re-verifies via the full manifest before pushing.
    const layout = this.getProjectLayout(projectPath);
    // Try the fs-direct fast reader first; fall back to `git show-ref` only
    // when the cheap path can't handle the project layout. The fallback keeps
    // the warm path correct against worktree gitdir indirection, reftables,
    // and symref'd branch heads, which `fastReadGitHeadsRefs` deliberately
    // refuses to interpret.
    const headsOutput =
      (await fastReadGitHeadsRefs(projectPath)) ?? (await readGitHeadsRefs(projectPath));
    if (headsOutput == null || headsOutput.length === 0) {
      // No local refs means a freshly-init'd local repo (no commits) or a
      // non-git directory. Either way the slow path needs to run.
      return null;
    }
    const snapshotDigest = crypto.createHash("sha256").update(headsOutput).digest("hex");
    const baseRepoPathArg = expandTildeForSSH(layout.baseRepoPath);
    const baseRepoUnbornHeadArg = shescape.quote(BASE_REPO_UNBORN_HEAD_REF);
    const currentSnapshotPathArg = expandTildeForSSH(layout.currentSnapshotPath);
    const workspacePathArg = expandTildeForSSH(workspacePath);
    const workspaceParentArg = expandTildeForSSH(
      workspacePath.includes("/") ? workspacePath.substring(0, workspacePath.lastIndexOf("/")) : "~"
    );

    // CORRECTNESS (origin-freshness): When the local project has an `origin`
    // remote, the slow path always prefers `origin/<trunkBranch>` over the
    // bundle ref so new workspaces base on the freshest upstream tip — see
    // `resolveFreshWorkspaceSourceBase()`. The warm path must match this or
    // it would silently check out a stale local snapshot when upstream has
    // advanced. We fold the same `git fetch origin <trunk>` into the fused
    // SSH script (single round-trip on the wire; the network hop to the
    // upstream stays on the datacenter side, so adding it preserves the
    // single-SSH-RTT envelope on the *client* side).
    const { originUrl } = await this.getOriginUrlForSync(projectPath, initLogger);

    // The remote bundle ref to base the worktree on. Prefer an exact match for
    // the requested branch (most projects use `main` or the trunk branch name
    // as the bundle ref), and we can let the remote script pick the first
    // available bundle ref as a fallback.
    const bundleRefArg = shescape.quote(`${BUNDLE_REF_PREFIX}${trunkBranch}`);
    const bundleRefFallbackPrefix = shescape.quote(BUNDLE_REF_PREFIX);

    const branchArg = shescape.quote(branchName);
    const digestArg = shescape.quote(snapshotDigest);
    const trunkRefspecArg = shescape.quote(
      `+refs/heads/${trunkBranch}:refs/remotes/origin/${trunkBranch}`
    );
    const trunkTrackingRefArg = shescape.quote(`refs/remotes/origin/${trunkBranch}`);
    const originUrlArg = originUrl ? shescape.quote(originUrl) : null;

    // Origin-freshness preamble (only when local has an `origin` URL):
    //   1. Realign the remote base repo's `origin` URL with local — handles
    //      the rare case where the user changed origin between syncs. Both
    //      `remote set-url` and the fallback `remote add` are idempotent and
    //      cost no network I/O.
    //   2. Best-effort `git fetch origin +refs/heads/<trunk>:refs/remotes/origin/<trunk>`.
    //      This mirrors `fetchOriginTrunk()` in the slow path: failure is
    //      tolerated (logged via `fo=0`) and the worktree falls back to the
    //      bundle ref, exactly like `resolveFreshWorkspaceSourceBase()` does
    //      when `fetchedOrigin` is false. The fetch runs on the SSH host, so
    //      its latency is upstream→datacenter (typically fast, and the same
    //      cost the slow path pays separately).
    const warmBaseRepoNormalizationPreamble = [
      ...BASE_REPO_SHARED_CONFIG_KEYS_TO_UNSET.map((key) =>
        [
          `git --git-dir=${baseRepoPathArg} config --local --unset-all ${shescape.quote(key)} 2>/dev/null`,
          "cleanup_status=$?",
          'if [ "$cleanup_status" -ne 0 ] && [ "$cleanup_status" -ne 5 ]; then echo WARM_MISS:base-config-normalization-failed; exit 0; fi',
        ].join("\n")
      ),
      // If the lightweight warm-path hygiene cannot run, fall back to the slow
      // path where ensureBaseRepo() has retry/error handling instead of risking
      // materializing a worktree from still-poisoned shared config.
      `git --git-dir=${baseRepoPathArg} symbolic-ref HEAD ${baseRepoUnbornHeadArg} 2>/dev/null || { echo WARM_MISS:base-head-normalization-failed; exit 0; }`,
    ];

    const originPreamble = originUrlArg
      ? [
          `git -C ${baseRepoPathArg} remote set-url origin ${originUrlArg} 2>/dev/null || git -C ${baseRepoPathArg} remote add origin ${originUrlArg} >/dev/null 2>&1 || true`,
          `if ${nhp}git -C ${baseRepoPathArg} fetch --quiet origin ${trunkRefspecArg} 2>/dev/null; then fo=1; else fo=0; fi`,
        ]
      : ["fo=0"];

    // Tight script: every byte matters because the script body is shipped
    // over the SSH wire on every warm probe. We avoid temp files, capture
    // shell builtins where possible, and use `&&` chaining so a single
    // explicit branch decides WARM_OK vs WARM_MISS:<reason> with no extra
    // process spawns.
    const script = [
      // Guards (cheap shell builtins, single fork for the snapshot read):
      `test -d ${baseRepoPathArg} || { echo WARM_MISS:no-base-repo; exit 0; }`,
      `test -f ${currentSnapshotPathArg} || { echo WARM_MISS:snapshot-marker-missing; exit 0; }`,
      `read -r s < ${currentSnapshotPathArg} || true`,
      `[ "$s" = ${digestArg} ] || { echo WARM_MISS:snapshot-digest-drift; exit 0; }`,
      `test -e ${workspacePathArg} && { echo WARM_MISS:workspace-exists; exit 0; }`,
      // Best-effort base-repo hygiene before the warm path reuses the shared gitdir.
      ...warmBaseRepoNormalizationPreamble,
      // Optional origin fetch (preserves slow-path origin-freshness).
      ...originPreamble,
      // Choose the worktree base ref. Prefer freshly-fetched
      // `refs/remotes/origin/<trunk>` whenever the fetch succeeded; otherwise
      // fall back to the local-snapshot bundle ref, matching
      // resolveFreshWorkspaceSourceBase()'s fallback semantics.
      `if [ "$fo" = "1" ] && git -C ${baseRepoPathArg} rev-parse --verify ${trunkTrackingRefArg} >/dev/null 2>&1; then`,
      `  r=${trunkTrackingRefArg}`,
      "else",
      `  r=${bundleRefArg}`,
      `  git -C ${baseRepoPathArg} rev-parse --verify "$r" >/dev/null 2>&1 || r=$(git -C ${baseRepoPathArg} for-each-ref --count=1 --format='%(refname)' ${bundleRefFallbackPrefix})`,
      `  [ -n "$r" ] || { echo WARM_MISS:no-bundle-ref; exit 0; }`,
      "fi",
      // Materialize. Capture checkout failures so a missing-object cache can
      // fall through to the repairing slow path instead of becoming an opaque
      // `worktree-add-failed` miss. The path was proven absent above, so removing
      // a partial checkout here cannot wipe a pre-existing workspace.
      // Detach the base repo's own HEAD from user branches when the chosen ref
      // has an object; if the cache is missing that object, worktree add below
      // surfaces the existing repairable checkout error.
      buildBestEffortDetachBaseRepoHeadCommand(baseRepoPathArg, '"$r"'),
      `mkdir -p ${workspaceParentArg}`,
      `wt_output=$(${nhp}git -C ${baseRepoPathArg} worktree add ${workspacePathArg} -B ${branchArg} "$r" 2>&1 >/dev/null)`,
      "wt_status=$?",
      'if [ "$wt_status" -ne 0 ]; then',
      '  case "$wt_output" in',
      '    *"unable to read sha1 file"*|*"Could not reset index file"*|*"missing blob"*|*"missing tree"*|*"missing commit"*|*"bad object"*|*"unable to read tree"*) wt_reason=missing-objects ;;',
      "    *) wt_reason=worktree-add-failed ;;",
      "  esac",
      `  git -C ${baseRepoPathArg} worktree remove --force ${workspacePathArg} >/dev/null 2>&1 || rm -rf ${workspacePathArg}`,
      '  [ -z "$wt_output" ] || printf "%s\\n" "$wt_output" >&2',
      '  echo "WARM_MISS:$wt_reason"',
      "  exit 0",
      "fi",
      // .gitmodules probe folded inline to skip a post-warm SSH RTT.
      `test -f ${workspacePathArg}/.gitmodules && echo GITMODULES=present || echo GITMODULES=missing`,
      "echo WARM_OK",
    ].join("\n");

    initLogger.logStep("Probing for warm-cached remote workspace...");
    const result = await execBuffered(this, script, {
      cwd: "/tmp",
      timeout: 120,
      abortSignal,
    });

    if (result.exitCode !== 0) {
      // Treat unexpected failures as a miss — slow path will retry deterministically.
      return null;
    }

    const stdout = result.stdout;
    if (!stdout.includes("WARM_OK")) {
      const missMatch = /WARM_MISS:(\S+)/.exec(stdout);
      const reason = missMatch ? missMatch[1] : "unknown";
      initLogger.logStep(`Warm fast-path miss (${reason}); using slow path`);
      return null;
    }

    const gitmodulesPresent = stdout.includes("GITMODULES=present");
    // Mirror the slow path's snapshot-reuse log line — semantically the warm
    // path *is* reusing the remote project snapshot (digest match → bundle/
    // origin-trunk tip already on the host), just with the materialization
    // fused into the same round-trip. Keeping the same step text means
    // downstream tooling (and tests like
    // "initWorkspace reuses snapshots and preserves remote-only tags...")
    // continue to observe a consistent lifecycle event.
    initLogger.logStep("Reusing existing remote project snapshot");
    initLogger.logStep(`Materialized workspace via warm fast-path (branch: ${branchName})`);
    return { gitmodulesPresent };
  }

  private async prepareWorkspaceCheckout(params: WorkspaceInitParams, nhp: string): Promise<void> {
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal, env } =
      params;

    // STARTUP-PERF (warm fast-path): try to materialize the workspace in a
    // single fused SSH command. See `tryWarmWorktreeAdd()` for the contract
    // and miss reasons. When this succeeds, we skip the entire multi-call
    // slow path (test-d → git-check → ensureBaseRepo → snapshot check →
    // manifest check → refreshOrigin → fetchOrigin → resolveBundleTrunkRef →
    // resolveFreshWorkspaceSourceBase → worktree-add), collapsing ~9 sequential
    // SSH round-trips into one.
    const warmHit = await this.tryWarmWorktreeAdd(params, nhp);
    if (warmHit) {
      // STARTUP-PERF: The warm SSH command already reported whether
      // `.gitmodules` exists in the freshly-materialized worktree, so we can
      // skip the (otherwise unavoidable) probe-RTT inside
      // `hasRuntimeGitmodules()` when the answer is "missing". On a typical
      // single-package project this saves one full SSH round-trip on every
      // warm workspace create.
      if (warmHit.gitmodulesPresent) {
        await syncRuntimeGitSubmodules({
          runtime: this,
          workspacePath,
          initLogger,
          abortSignal,
          env,
          trusted: params.trusted,
        });
      }
      return;
    }

    // If the workspace directory already exists and contains a git repo (e.g. forked from
    // another SSH workspace via worktree add or legacy cp), skip the expensive sync step.
    const workspacePathArg = expandTildeForSSH(workspacePath);
    let needsWorktreeCheckout = true;
    let workspacePathExistedBeforeCheckout = false;

    try {
      const dirCheck = await execBuffered(this, `test -d ${workspacePathArg}`, {
        cwd: "/tmp",
        timeout: 10,
        abortSignal,
      });
      if (dirCheck.exitCode === 0) {
        workspacePathExistedBeforeCheckout = true;
        const gitCheck = await execBuffered(
          this,
          `git -C ${workspacePathArg} rev-parse --is-inside-work-tree`,
          {
            cwd: "/tmp",
            timeout: 20,
            abortSignal,
          }
        );
        needsWorktreeCheckout = gitCheck.exitCode !== 0;
      }
    } catch {
      // Default to materializing the workspace on unexpected errors, but do not
      // later delete the path because we failed to prove it was absent first.
      needsWorktreeCheckout = true;
      workspacePathExistedBeforeCheckout = true;
    }

    if (needsWorktreeCheckout) {
      // SSH workspace initialization owns repo materialization: it syncs the project into
      // the shared base repo, checks out the worktree, and then materializes submodules
      // before repo-controlled init hooks run.
      initLogger.logStep("Syncing project files to remote...");
      await this.syncProjectToRemote(projectPath, initLogger, abortSignal);
      initLogger.logStep("Files synced successfully");

      // A brand-new workspace still needs git worktree add so the checkout exists before init hooks
      // or submodule sync run. Re-enter ensureBaseRepo() here so older shared repos still get their
      // local core.bare config normalized before we reuse them for a fresh worktree checkout.
      const baseRepoPath = this.getBaseRepoPath(projectPath);
      const { baseRepoPathArg } = await this.ensureBaseRepo(projectPath, initLogger, abortSignal);

      // Fetch latest from origin in the base repo so an explicit Source branch
      // means the upstream branch, not the local snapshot staged in refs/mux-bundle/*.
      const fetchedOrigin = await this.fetchOriginTrunk(
        baseRepoPath,
        trunkBranch,
        initLogger,
        abortSignal,
        nhp
      );

      // Resolve the bundle's staging ref to use only as a local fallback start point.
      // refs/mux-bundle/* is a transport cache for the user's laptop state; it must
      // not override origin/<source> when the remote source branch is available.
      const bundleTrunkRef = await this.resolveBundleTrunkRef(
        baseRepoPathArg,
        trunkBranch,
        abortSignal
      );
      const newBranchBase = await this.resolveFreshWorkspaceSourceBase(
        baseRepoPathArg,
        trunkBranch,
        fetchedOrigin,
        bundleTrunkRef,
        initLogger,
        abortSignal
      );

      // `ensureBaseRepo()` keeps the bare repo HEAD on an unborn internal
      // branch so Git porcelain stays happy even when there is no commit yet.
      // Once we know the start point, detach HEAD at that commit when possible
      // and let `worktree add -B` own branch creation/reset. Git still prevents
      // resetting a branch that's active in another worktree.
      initLogger.logStep(`Creating worktree for branch: ${branchName}`);
      const runWorktreeAdd = (baseRef: string) =>
        execBuffered(
          this,
          [
            buildBestEffortDetachBaseRepoHeadCommand(baseRepoPathArg, shescape.quote(baseRef)),
            `${nhp}git -C ${baseRepoPathArg} worktree add ${workspacePathArg} -B ${shescape.quote(branchName)} ${shescape.quote(baseRef)}`,
          ].join("\n"),
          {
            cwd: "/tmp",
            timeout: 300,
            abortSignal,
          }
        );

      let worktreeBase = newBranchBase;
      let worktreeResult = await runWorktreeAdd(worktreeBase);

      if (
        worktreeResult.exitCode !== 0 &&
        isMissingObjectCheckoutFailure(worktreeResult.stderr || worktreeResult.stdout)
      ) {
        initLogger.logStep("Shared base repository is missing checkout objects; repairing...");
        if (!workspacePathExistedBeforeCheckout) {
          await this.cleanupFailedNewWorktreeCheckout(
            baseRepoPathArg,
            workspacePathArg,
            abortSignal
          );
        }

        await this.repairBaseRepoMissingObjectsFromLocal(
          projectPath,
          baseRepoPathArg,
          initLogger,
          abortSignal
        );

        const repairedBaseCheck = await this.checkBaseRepoRevisionConnectivity(
          baseRepoPathArg,
          worktreeBase,
          abortSignal
        );
        if (!repairedBaseCheck.healthy) {
          if (worktreeBase === `origin/${trunkBranch}` && bundleTrunkRef != null) {
            initLogger.logStderr(
              `Note: origin/${trunkBranch} is still missing objects after repair; using local snapshot ${bundleTrunkRef}`
            );
            worktreeBase = bundleTrunkRef;
            const fallbackCheck = await this.checkBaseRepoRevisionConnectivity(
              baseRepoPathArg,
              worktreeBase,
              abortSignal
            );
            if (!fallbackCheck.healthy) {
              throw new Error(
                `Shared base repository is still missing objects after repair: ${fallbackCheck.detail}`
              );
            }
          } else {
            throw new Error(
              `Shared base repository is still missing objects after repair: ${repairedBaseCheck.detail}`
            );
          }
        }

        worktreeResult = await runWorktreeAdd(worktreeBase);
      }

      if (worktreeResult.exitCode !== 0) {
        throw new Error(
          `Failed to create worktree: ${worktreeResult.stderr || worktreeResult.stdout}`
        );
      }
      initLogger.logStep("Worktree created successfully");
    } else {
      initLogger.logStep("Remote workspace already contains a git repo; skipping sync");

      // Existing workspace (e.g. forked): fetch origin and checkout as before.
      const fetchedOrigin = await this.fetchOriginTrunk(
        workspacePath,
        trunkBranch,
        initLogger,
        abortSignal,
        nhp
      );
      const shouldUseOrigin =
        fetchedOrigin &&
        (await this.canFastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal));

      if (shouldUseOrigin) {
        await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal, nhp);
      }
    }

    await syncRuntimeGitSubmodules({
      runtime: this,
      workspacePath,
      initLogger,
      abortSignal,
      env,
      trusted: params.trusted,
    });
  }

  /**
   * Fetch trunk branch from origin into its remote-tracking ref before checkout.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    nhp = ""
  ): Promise<boolean> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      const remoteTrackingRefSpec = `+refs/heads/${trunkBranch}:refs/remotes/origin/${trunkBranch}`;
      const fetchCmd = `${nhp}git fetch origin ${shescape.quote(remoteTrackingRefSpec)}`;
      const fetchStream = await this.exec(fetchCmd, {
        cwd: workspacePath,
        timeout: 120, // 2 minutes for network operation
        abortSignal,
      });

      const fetchExitCode = await fetchStream.exitCode;
      if (fetchExitCode !== 0) {
        const fetchStderr = await streamToString(fetchStream.stderr);
        // Branch doesn't exist on origin (common for subagent local-only branches)
        if (fetchStderr.includes("couldn't find remote ref")) {
          initLogger.logStep(`Branch "${trunkBranch}" not found on origin; using local state.`);
        } else {
          initLogger.logStderr(
            `Note: Could not fetch from origin (${fetchStderr}), using local branch state`
          );
        }
        return false;
      }

      initLogger.logStep("Fetched latest from origin");
      return true;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(
        `Note: Could not fetch from origin (${errorMsg}), using local branch state`
      );
      return false;
    }
  }

  /**
   * Check if the local <branch> can fast-forward to origin/<branch>.
   * Returns true if local is behind or equal to origin (safe to use origin).
   * Returns false if local is ahead or diverged (preserve local state).
   *
   * @param branch - The branch name to compare locally and on origin (e.g. "main")
   */
  private async canFastForwardToOrigin(
    workspacePath: string,
    branch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      // Check if local <branch> is an ancestor of origin/<branch>
      // Exit code 0 = local is ancestor (can fast-forward), non-zero = cannot
      const checkCmd = `git merge-base --is-ancestor ${shescape.quote(branch)} origin/${shescape.quote(branch)}`;
      const checkStream = await this.exec(checkCmd, {
        cwd: workspacePath,
        timeout: 30,
        abortSignal,
      });

      const exitCode = await checkStream.exitCode;
      if (exitCode === 0) {
        return true; // Local is behind or equal to origin
      }

      // Local is ahead or diverged - preserve local state
      initLogger.logStderr(
        `Note: Local ${branch} is ahead of or diverged from origin/${branch}, using local state`
      );
      return false;
    } catch {
      // Error checking - assume we should preserve local state
      return false;
    }
  }

  /**
   * Fast-forward merge to latest origin/<trunkBranch> after checkout.
   * Best-effort operation for existing branches that may be behind origin.
   */
  private async fastForwardToOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    nhp = ""
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

      const mergeCmd = `${nhp}git merge --ff-only origin/${shescape.quote(trunkBranch)}`;
      const mergeStream = await this.exec(mergeCmd, {
        cwd: workspacePath,
        timeout: 60, // 1 minute for fast-forward merge
        abortSignal,
      });

      const [mergeStderr, mergeExitCode] = await Promise.all([
        streamToString(mergeStream.stderr),
        mergeStream.exitCode,
      ]);

      if (mergeExitCode !== 0) {
        // Fast-forward not possible (diverged branches) - just warn
        initLogger.logStderr(
          `Note: Fast-forward skipped (${mergeStderr || "branches diverged"}), using local branch state`
        );
      } else {
        initLogger.logStep("Fast-forwarded to latest origin successfully");
      }
    } catch (error) {
      // Non-fatal: log and continue
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(`Note: Fast-forward failed (${errorMsg}), using local branch state`);
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Check if already aborted
    if (abortSignal?.aborted) {
      return { success: false, error: "Rename operation aborted" };
    }
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = path.posix.join(path.posix.dirname(oldPath), newName);

    try {
      const expandedOldPath = expandTildeForSSH(oldPath);
      const expandedNewPath = expandTildeForSSH(newPath);

      // Detect if workspace is a worktree vs legacy full clone.
      const isWorktree = await this.isWorktreeWorkspace(oldPath, abortSignal);

      let moveCommand: string;
      if (isWorktree) {
        // Worktree: use `git worktree move` to keep the workspace registered in whichever
        // shared base repo originally created it, including upgraded legacy SSH layouts.
        const baseRepoPathArg = expandTildeForSSH(
          await this.resolveWorktreeBaseRepoPath(projectPath, oldPath, abortSignal)
        );
        moveCommand = `git -C ${baseRepoPathArg} worktree move ${expandedOldPath} ${expandedNewPath}`;
      } else {
        // Legacy full clone: plain mv.
        moveCommand = `mv ${expandedOldPath} ${expandedNewPath}`;
      }

      const stream = await this.exec(moveCommand, {
        cwd: this.config.srcBaseDir,
        timeout: 30,
        abortSignal,
      });

      await stream.stdin.abort();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
        const stderrReader = stream.stderr.getReader();
        const decoder = new TextDecoder();
        let stderr = "";
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            stderr += decoder.decode(value, { stream: true });
          }
        } finally {
          stderrReader.releaseLock();
        }

        return {
          success: false,
          error: `Failed to rename directory: ${stderr.trim() || "Unknown error"}`,
        };
      }

      return { success: true, oldPath, newPath };
    } catch (error) {
      return {
        success: false,
        error: `Failed to rename directory: ${getErrorMessage(error)}`,
      };
    }
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Check if already aborted
    if (abortSignal?.aborted) {
      return { success: false, error: "Delete operation aborted" };
    }

    // Disable git hooks for untrusted projects
    const nhp = gitNoHooksPrefix(trusted);

    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);

    try {
      // Combine all pre-deletion checks into a single bash script to minimize round trips
      // Exit codes: 0=ok to delete, 1=uncommitted changes, 2=unpushed commits, 3=doesn't exist
      const checkScript = force
        ? // When force=true, only check existence
          `test -d ${shescape.quote(deletedPath)} || exit 3`
        : // When force=false, perform all safety checks
          `
            test -d ${shescape.quote(deletedPath)} || exit 3
            cd ${shescape.quote(deletedPath)} || exit 1
            git diff --quiet --exit-code && git diff --quiet --cached --exit-code || exit 1
            if git remote | grep -q .; then
              # First, check the original condition: any commits not in any remote
              unpushed=$(git log --branches --not --remotes --oneline)
              if [ -n "$unpushed" ]; then
                # Get current branch for better error messaging
                BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

                # Get default branch (prefer main/master over origin/HEAD since origin/HEAD
                # might point to a feature branch in some setups)
                if git rev-parse --verify origin/main >/dev/null 2>&1; then
                  DEFAULT="main"
                elif git rev-parse --verify origin/master >/dev/null 2>&1; then
                  DEFAULT="master"
                else
                  # Fallback to origin/HEAD if main/master don't exist
                  DEFAULT=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
                fi

                # Check for squash-merge: if all changed files match origin/$DEFAULT, content is merged
                if [ -n "$DEFAULT" ]; then
                  # Fetch latest to ensure we have current remote state
                  # nhp disables git hooks for untrusted projects (reference-transaction, etc.)
                  ${nhp}git fetch origin "$DEFAULT" --quiet 2>/dev/null || true

                  # Get merge-base between current branch and default
                  MERGE_BASE=$(git merge-base "origin/$DEFAULT" HEAD 2>/dev/null)
                  if [ -n "$MERGE_BASE" ]; then
                    # Get files changed on this branch since fork point
                    CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null)

                    if [ -n "$CHANGED_FILES" ]; then
                      # Check if all changed files match what's in origin/$DEFAULT
                      ALL_MERGED=true
                      while IFS= read -r f; do
                        # Compare file content between HEAD and origin/$DEFAULT
                        # If file doesn't exist in one but exists in other, they differ
                        if ! git diff --quiet "HEAD:$f" "origin/$DEFAULT:$f" 2>/dev/null; then
                          ALL_MERGED=false
                          break
                        fi
                      done <<< "$CHANGED_FILES"

                      if $ALL_MERGED; then
                        # All changes are in default branch - safe to delete (squash-merge case)
                        exit 0
                      fi
                    else
                      # No changed files means nothing to merge - safe to delete
                      exit 0
                    fi
                  fi
                fi

                # If we get here, there are real unpushed changes
                # Show helpful output for debugging
                if [ -n "$BRANCH" ] && [ -n "$DEFAULT" ] && git show-branch "$BRANCH" "origin/$DEFAULT" >/dev/null 2>&1; then
                  echo "Branch status compared to origin/$DEFAULT:" >&2
                  echo "" >&2
                  git show-branch "$BRANCH" "origin/$DEFAULT" 2>&1 | head -20 >&2
                  echo "" >&2
                  echo "Note: Branch has changes not yet in origin/$DEFAULT." >&2
                else
                  # Fallback to just showing the commit list
                  echo "$unpushed" | head -10 >&2
                fi
                exit 2
              fi
            fi
            exit 0
          `;

      const checkStream = await this.exec(checkScript, {
        cwd: this.config.srcBaseDir,
        // Non-force path includes `git fetch origin` (network op) that can
        // easily exceed 10s on slow SSH connections. Force path only checks
        // existence, so a short timeout is fine.
        timeout: force ? 10 : 30,
        abortSignal,
      });

      // Command doesn't use stdin - abort to close immediately without waiting
      await checkStream.stdin.abort();
      const checkExitCode = await checkStream.exitCode;

      // Handle check results
      if (checkExitCode === 3) {
        // Directory doesn't exist - deletion is idempotent (success).
        return { success: true, deletedPath };
      }

      if (checkExitCode === 1) {
        return {
          success: false,
          error: "Workspace contains uncommitted changes. Use force flag to delete anyway.",
        };
      }

      if (checkExitCode === 2) {
        // Read stderr which contains the unpushed commits output
        const stderr = await streamToString(checkStream.stderr);
        const commitList = stderr.trim();
        const errorMsg = commitList
          ? `Workspace contains unpushed commits:\n\n${commitList}`
          : "Workspace contains unpushed commits. Use force flag to delete anyway.";

        return {
          success: false,
          error: errorMsg,
        };
      }

      if (checkExitCode !== 0) {
        // Unexpected error
        const stderr = await streamToString(checkStream.stderr);
        return {
          success: false,
          error: `Failed to check workspace state: ${stderr.trim() || `exit code ${checkExitCode}`}`,
        };
      }

      const branchToDelete = await this.resolveCheckedOutBranch(deletedPath, abortSignal, 10);

      // Detect if workspace is a worktree (.git is a file) vs a legacy full clone (.git is a directory).
      const isWorktree = await this.isWorktreeWorkspace(deletedPath, abortSignal);

      if (isWorktree) {
        // Worktree: use `git worktree remove` against the actual common git dir for this
        // workspace so upgraded legacy SSH worktrees keep their original base repo metadata.
        const baseRepoPath = await this.resolveWorktreeBaseRepoPath(
          projectPath,
          deletedPath,
          abortSignal
        );
        const baseRepoPathArg = expandTildeForSSH(baseRepoPath);
        const removeCmd = force
          ? `${nhp}git -C ${baseRepoPathArg} worktree remove --force ${this.quoteForRemote(deletedPath)}`
          : `${nhp}git -C ${baseRepoPathArg} worktree remove ${this.quoteForRemote(deletedPath)}`;
        const stream = await this.exec(removeCmd, {
          cwd: this.config.srcBaseDir,
          timeout: 30,
          abortSignal,
        });
        await stream.stdin.abort();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          // Fallback: if worktree remove fails (e.g., locked), rm -rf + prune.
          const fallbackStream = await this.exec(
            // Use quoteForRemote (expandTildeForSSH) to match the quoting in the
            // worktree remove command above — shescape.quote doesn't expand tilde.
            // `worktree prune` is best-effort: if the base repo was externally
            // deleted/corrupted the prune fails, but the workspace IS gone after
            // rm -rf — don't report failure for a cosmetic prune error.
            `rm -rf ${this.quoteForRemote(deletedPath)} && (${nhp}git -C ${baseRepoPathArg} worktree prune 2>/dev/null || true)`,
            { cwd: this.config.srcBaseDir, timeout: 30, abortSignal }
          );
          await fallbackStream.stdin.abort();
          const fallbackExitCode = await fallbackStream.exitCode;
          if (fallbackExitCode !== 0) {
            const fallbackStderr = await streamToString(fallbackStream.stderr);
            return {
              success: false,
              error: `Failed to delete worktree: ${stderr.trim() || fallbackStderr.trim() || "Unknown error"}`,
            };
          }
        }
        // Best-effort: delete the orphaned branch ref from the base repo so
        // that re-forking with the same workspace name can use the fast worktree
        // path (git worktree add -b fails if the branch already exists).
        // Skip protected trunk branch names to avoid accidental deletion.
        const PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "default"];
        if (branchToDelete && !PROTECTED_BRANCHES.includes(branchToDelete)) {
          // HEAD neutralization migrates legacy *Xum-owned* base repos whose
          // HEAD still points at a user branch (the Graphite-poisoning state)
          // so `branch -D` keeps Git's native checked-out-branch guard instead
          // of refusing because the bare repo "has the branch checked out".
          // The resolved common git dir is workspace-derived, though: a
          // hand-crafted or legacy worktree can resolve to a real checkout's
          // `.git`, and rewriting that repo's HEAD would strand the user's
          // checkout on the unborn internal branch. Managed base repos
          // (canonical and legacy hashed layouts alike) are always named
          // `.mux-base.git`, so scope the HEAD rewrite to them.
          const isManagedBaseRepo = path.posix.basename(baseRepoPath) === REMOTE_BASE_REPO_DIR;
          await execBuffered(
            this,
            [
              ...(isManagedBaseRepo
                ? [
                    `git --git-dir=${baseRepoPathArg} symbolic-ref HEAD ${shescape.quote(BASE_REPO_UNBORN_HEAD_REF)} 2>/dev/null || true`,
                  ]
                : []),
              `${nhp}git -C ${baseRepoPathArg} branch -D ${shescape.quote(branchToDelete)} 2>/dev/null || true`,
            ].join("\n"),
            { cwd: "/tmp", timeout: 10 }
          ).catch(() => undefined);
        }
      } else {
        // Legacy full clone: rm -rf to remove the directory on the remote host.
        const removeCommand = `rm -rf ${shescape.quote(deletedPath)}`;
        const stream = await this.exec(removeCommand, {
          cwd: this.config.srcBaseDir,
          timeout: 30,
          abortSignal,
        });
        await stream.stdin.abort();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          return {
            success: false,
            error: `Failed to delete directory: ${stderr.trim() || "Unknown error"}`,
          };
        }
      }

      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete directory: ${getErrorMessage(error)}` };
    }
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger, abortSignal } = params;

    // SAFETY (workspace-deletion regression): the new workspace path is
    // computed from the *canonical* project layout, never from the source
    // workspace's persisted parent directory.
    //
    // Why this matters:
    //   - Legacy SSH workspaces created before #3125 are still persisted at
    //     `<srcBaseDir>/<basename>/<name>`, while the shared base repo lives
    //     at `<srcBaseDir>/<basename>-<12hex>/.mux-base.git`. If we kept
    //     `dirname(sourceWorkspacePath)`, forks off legacy workspaces would
    //     land in the legacy parent dir, then `git worktree add` (rooted at
    //     the canonical base repo) would fail with `fatal: invalid reference`,
    //     and the failure-cleanup `rm -rf <newWorkspacePath>` would run
    //     against a path that could collide with a *different* canonical
    //     workspace sharing `newWorkspaceName`. That was the wiping mechanism
    //     observed in production (see investigation report dated 2026-05-17).
    //   - The source workspace's persisted path is intentionally *not* moved
    //     by this PR — leaving legacy records in place is safe now that forks
    //     no longer destructively touch their parent dir. They migrate
    //     naturally as users archive + re-fork them.
    const layout = this.getProjectLayout(projectPath);
    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);
    const newWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

    // For SSH commands, tilde must be expanded using $HOME - plain quoting won't expand it.
    const sourceWorkspacePathArg = expandTildeForSSH(sourceWorkspacePath);
    const newWorkspacePathArg = expandTildeForSSH(newWorkspacePath);

    // SAFETY (rm-rf cannot wipe a sibling): every byte of work this fork
    // produces lands in a per-attempt staging directory whose name carries
    // 96 bits of crypto-random entropy. The final canonical path is only
    // created via an atomic `mv` (worktree path) or `git worktree move`
    // (worktree-add path), guarded by a final `test -e` collision check.
    // If anything between branch detection and finalize fails, `rm -rf`
    // operates exclusively on the staging path and *cannot* touch any
    // real workspace — even if a concurrent fork raced on the same
    // `newWorkspaceName`.
    const stagingId = crypto.randomBytes(6).toString("hex");
    const stagingName = `.mux-fork-staging-${stagingId}`;
    const stagingPath = path.posix.join(layout.projectRoot, stagingName);
    const stagingPathArg = expandTildeForSSH(stagingPath);

    const removeStaging = async (reason: string): Promise<void> => {
      // SAFE rm -rf: `stagingName` carries 96 bits of crypto entropy and the
      // `.mux-fork-staging-` prefix is not used anywhere else, so this command
      // can only ever target our own staging dir. Logged so future
      // workspace-loss investigations can correlate cleanups with the fork
      // attempt that produced them.
      log.info(
        `forkWorkspace: rm -rf staging path ${stagingPath} (project=${projectPath}, source=${sourceWorkspaceName}, target=${newWorkspaceName}, reason=${reason})`
      );
      await execBuffered(this, `rm -rf ${stagingPathArg}`, {
        cwd: "/tmp",
        timeout: 30,
      }).catch(() => undefined);
    };

    const removeStagingWorktree = async (
      baseRepoPathArg: string,
      nhp: string,
      reason: string
    ): Promise<void> => {
      // The staging worktree is registered in the base repo under
      // `<bare>/worktrees/<stagingName>/`. `worktree remove --force` unwinds
      // both the registration and the on-disk dir; the rm-rf afterwards is
      // belt-and-suspenders for the case where the registration was created
      // but the dir wasn't (or vice versa).
      log.info(
        `forkWorkspace: removing staging worktree ${stagingPath} (project=${projectPath}, source=${sourceWorkspaceName}, target=${newWorkspaceName}, reason=${reason})`
      );
      await execBuffered(
        this,
        `${nhp}git -C ${baseRepoPathArg} worktree remove --force ${stagingPathArg} 2>/dev/null || true`,
        { cwd: "/tmp", timeout: 30 }
      ).catch(() => undefined);
      await removeStaging(reason);
    };

    // Hoisted outside the try block so the catch handler can reach them when
    // cleaning up after a thrown/aborted fork — both for `removeStagingWorktree`
    // (needs the base repo arg + no-hooks prefix) and for the registration flag
    // that distinguishes "rm-rf is enough" from "must also unregister".
    const baseRepoPath = this.getBaseRepoPath(projectPath);
    const baseRepoPathArg = expandTildeForSSH(baseRepoPath);
    const nhp = gitNoHooksPrefix(params.trusted);
    let stagingHasWorktreeRegistration = false;

    try {
      // Guard: avoid clobbering an existing destination directory. Surface a
      // crisp error to the caller — the staging machinery below catches
      // TOCTOU collisions a second time at the finalize step.
      {
        const exists = await execBuffered(this, `test -e ${newWorkspacePathArg}`, {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        });
        if (exists.exitCode === 0) {
          return { success: false, error: `Workspace already exists at ${newWorkspacePath}` };
        }
      }

      // Detect current branch from the source workspace.
      initLogger.logStep("Detecting source workspace branch...");
      const sourceBranch = await this.resolveCheckedOutBranch(sourceWorkspacePath, abortSignal, 30);
      if (!sourceBranch) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Try fast worktree path first when the shared base repo exists.
      // Falls back to full directory copy when the base repo is missing OR when
      // worktree creation fails (e.g. forking a legacy workspace whose branch
      // only exists locally and not in the base repo).
      //
      // Note: worktree-based fork creates a clean checkout from sourceBranch's
      // committed HEAD. Uncommitted working-tree changes from the source are NOT
      // carried over (inherent git worktree limitation). The cp -R -P fallback
      // preserves full working-tree state including uncommitted changes.
      let usedWorktree = false;

      const hasBaseRepo = await execBuffered(this, `test -d ${baseRepoPathArg}`, {
        cwd: "/tmp",
        timeout: 10,
        abortSignal,
      });

      if (hasBaseRepo.exitCode === 0) {
        initLogger.logStep("Creating worktree for forked workspace...");
        // Stage the worktree under `stagingPath`; `git worktree move` will
        // rename it (and update the bare repo's gitdir back-reference) into
        // `newWorkspacePath` once everything else has succeeded. The base repo
        // HEAD is neutralized first so `worktree add -b` keeps Git's normal
        // active-branch and existing-branch guards.
        const worktreeCmd = [
          `git --git-dir=${baseRepoPathArg} symbolic-ref HEAD ${shescape.quote(BASE_REPO_UNBORN_HEAD_REF)} 2>/dev/null || true`,
          buildBestEffortDetachBaseRepoHeadCommand(baseRepoPathArg, shescape.quote(sourceBranch)),
          `${nhp}git -C ${baseRepoPathArg} worktree add -b ${shescape.quote(newWorkspaceName)} ${stagingPathArg} ${shescape.quote(sourceBranch)}`,
        ].join("\n");
        const worktreeResult = await execBuffered(this, worktreeCmd, {
          cwd: "/tmp",
          timeout: 60,
          abortSignal,
        });

        if (worktreeResult.exitCode === 0) {
          usedWorktree = true;
          stagingHasWorktreeRegistration = true;
        } else {
          // Source branch likely doesn't exist in the base repo (legacy
          // workspace) — fall through to the cp -R -P path. Cleanup operates
          // exclusively on the unique staging path so it cannot touch a
          // sibling workspace, even if `git worktree add` left a partial dir
          // before failing on the bad reference.
          await removeStaging(
            `worktree add failed: ${(worktreeResult.stderr || worktreeResult.stdout).trim()}`
          );
          log.info(
            `Worktree fork failed (${(worktreeResult.stderr || worktreeResult.stdout).trim()}); falling back to full copy`
          );
          initLogger.logStep("Worktree creation failed; falling back to full copy...");
        }
      }

      if (!usedWorktree) {
        // Full directory copy into the staging path. `parentDir` is the
        // canonical project root; `mkdir -p` is idempotent and only ever
        // creates `<srcBaseDir>/<projectId>/`, never a legacy `<basename>/`.
        initLogger.logStep("Preparing remote workspace...");
        const mkdirResult = await execBuffered(
          this,
          `mkdir -p ${expandTildeForSSH(layout.projectRoot)}`,
          { cwd: "/tmp", timeout: 10, abortSignal }
        );
        if (mkdirResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to prepare remote workspace: ${mkdirResult.stderr || mkdirResult.stdout}`,
          };
        }

        // Copy the source workspace on the remote host so we preserve working tree state.
        // Avoid preserving ownership to prevent fork failures when files are owned by another user.
        initLogger.logStep("Copying workspace on remote...");
        const copyResult = await execBuffered(
          this,
          `cp -R -P ${sourceWorkspacePathArg} ${stagingPathArg}`,
          { cwd: "/tmp", timeout: 300, abortSignal }
        );
        if (copyResult.exitCode !== 0) {
          await removeStaging(
            `cp -R -P failed: ${(copyResult.stderr || copyResult.stdout).trim()}`
          );
          return {
            success: false,
            error: `Failed to copy workspace: ${copyResult.stderr || copyResult.stdout}`,
          };
        }

        // Best-effort: create local tracking branches for all remote branches.
        initLogger.logStep("Creating local tracking branches...");
        try {
          await execBuffered(
            this,
            `cd ${stagingPathArg} && for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=\${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done`,
            { cwd: "/tmp", timeout: 30 }
          );
        } catch {
          // Ignore - best-effort.
        }

        // Best-effort: preserve the origin URL from the source workspace, if one exists.
        try {
          const originResult = await execBuffered(
            this,
            `git -C ${sourceWorkspacePathArg} remote get-url origin 2>/dev/null || true`,
            { cwd: "/tmp", timeout: 10 }
          );
          const originUrl = originResult.stdout.trim();
          if (originUrl.length > 0) {
            await execBuffered(
              this,
              `git -C ${stagingPathArg} remote set-url origin ${shescape.quote(originUrl)}`,
              { cwd: "/tmp", timeout: 10 }
            );
          } else {
            await execBuffered(
              this,
              `git -C ${stagingPathArg} remote remove origin 2>/dev/null || true`,
              { cwd: "/tmp", timeout: 10 }
            );
          }
        } catch {
          // Ignore - best-effort.
        }

        // Checkout the destination branch in the staging dir, creating it
        // from sourceBranch if needed.
        initLogger.logStep(`Checking out branch: ${newWorkspaceName}`);
        const checkoutCmd =
          `${nhp}git -C ${stagingPathArg} checkout ${shescape.quote(newWorkspaceName)} 2>/dev/null || ` +
          `${nhp}git -C ${stagingPathArg} checkout -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
        const checkoutResult = await execBuffered(this, checkoutCmd, {
          cwd: "/tmp",
          timeout: 120,
        });
        if (checkoutResult.exitCode !== 0) {
          await removeStaging(
            `checkout failed: ${(checkoutResult.stderr || checkoutResult.stdout).trim()}`
          );
          return {
            success: false,
            error: `Failed to checkout forked branch: ${checkoutResult.stderr || checkoutResult.stdout}`,
          };
        }
      }

      // Finalize: move the staging dir into the canonical destination. There
      // are two cases:
      //   - Worktree-add path: use `git worktree move` so the bare repo's
      //     `worktrees/<name>/gitdir` back-reference is updated atomically
      //     with the on-disk rename.
      //   - Copy fallback path: plain `mv` (no gitdir indirection to track).
      // Both cases guard against a TOCTOU collision at the destination — if
      // another fork landed there since the initial `test -e`, we refuse to
      // proceed and clean up our staging dir instead of overwriting.
      initLogger.logStep("Finalizing workspace path...");
      if (usedWorktree) {
        const moveResult = await execBuffered(
          this,
          [
            `if [ -e ${newWorkspacePathArg} ]; then echo MUX_FORK_COLLISION; exit 7; fi`,
            `${nhp}git -C ${baseRepoPathArg} worktree move ${stagingPathArg} ${newWorkspacePathArg}`,
          ].join(" && "),
          { cwd: "/tmp", timeout: 30 }
        );
        if (moveResult.exitCode !== 0) {
          const collision = moveResult.stdout.includes("MUX_FORK_COLLISION");
          await removeStagingWorktree(
            baseRepoPathArg,
            nhp,
            collision
              ? "finalize collision (destination created by another process)"
              : `worktree move failed: ${(moveResult.stderr || moveResult.stdout).trim()}`
          );
          stagingHasWorktreeRegistration = false;
          return {
            success: false,
            error: collision
              ? `Workspace at ${newWorkspacePath} was created by another process during fork; pick a different name`
              : `Failed to finalize forked worktree: ${moveResult.stderr || moveResult.stdout}`,
          };
        }
        stagingHasWorktreeRegistration = false;
      } else {
        // Shell `mv <src-dir> <dest-dir>` has a nasty surprise: if `<dest-dir>`
        // exists as a directory at the moment the rename(2) syscall runs, BOTH
        // GNU coreutils mv and BSD mv fall back to "move source INTO dest" —
        // i.e. they produce `<dest>/<src-basename>/…` instead of failing. The
        // pre-check `test -e <dest>` mitigates the common case, but it cannot
        // close the TOCTOU window between the check and the rename: two
        // concurrent forks racing the cp-fallback path on the same
        // `newWorkspaceName` would both observe an empty destination, both
        // call `mv`, and the second `mv` would nest its staging dir under
        // the first fork's freshly-created destination. Without a post-hoc
        // detector, the second fork would then return success with
        // `workspacePath = <dest>` while the actual content sits at
        // `<dest>/.mux-fork-staging-<hex>/`.
        //
        // The shell snippet below does the pre-check, the mv, and a post-hoc
        // nesting check in a single SSH round-trip. If the post-check finds
        // our staging dir nested inside the destination, we know another
        // fork raced ahead — we report it as `MUX_FORK_COLLISION` and clean
        // up only our nested staging dir, leaving the winning fork's
        // destination contents intact.
        const stagingBaseArg = shescape.quote(stagingName);
        // Multi-statement script (not `&&`-joined) because `&&` is invalid
        // syntax inside `if/then/fi`. Each top-level statement either
        // succeeds (and execution continues) or `exit`s on a known sentinel
        // code: 0=ok, 7=collision (with cleanup already done), 8=mv failed.
        const finalizeScript = [
          `if [ -e ${newWorkspacePathArg} ]; then echo MUX_FORK_COLLISION; exit 7; fi`,
          `mv ${stagingPathArg} ${newWorkspacePathArg} || { echo MUX_FORK_MV_FAILED; exit 8; }`,
          // Post-hoc nesting detector: only triggers when another fork won
          // the race after our pre-check passed. Removing only the nested
          // path is safe because the staging name is unique to this attempt
          // (96-bit suffix) and can never collide with a real workspace name.
          `if [ -d ${newWorkspacePathArg}/${stagingBaseArg} ]; then rm -rf ${newWorkspacePathArg}/${stagingBaseArg}; echo MUX_FORK_COLLISION; exit 7; fi`,
        ].join("; ");
        const moveResult = await execBuffered(this, finalizeScript, {
          cwd: "/tmp",
          timeout: 30,
        });
        if (moveResult.exitCode !== 0) {
          const collision = moveResult.stdout.includes("MUX_FORK_COLLISION");
          // On `MUX_FORK_COLLISION` the inline script has already removed the
          // nested staging dir (if any) and left the winning fork's dest
          // untouched, so `removeStaging` here is a no-op safety net.
          await removeStaging(
            collision
              ? "finalize collision (destination created by another process)"
              : `mv failed: ${(moveResult.stderr || moveResult.stdout).trim()}`
          );
          return {
            success: false,
            error: collision
              ? `Workspace at ${newWorkspacePath} was created by another process during fork; pick a different name`
              : `Failed to finalize forked workspace: ${moveResult.stderr || moveResult.stdout}`,
          };
        }
      }

      return { success: true, workspacePath: newWorkspacePath, sourceBranch };
    } catch (error) {
      // Catch-all cleanup so an aborted/thrown fork can never leave the
      // staging worktree registered in the bare repo with a dangling gitdir.
      if (stagingHasWorktreeRegistration) {
        await removeStagingWorktree(
          baseRepoPathArg,
          nhp,
          `unexpected error: ${getErrorMessage(error)}`
        );
      } else {
        await removeStaging(`unexpected error: ${getErrorMessage(error)}`);
      }
      return { success: false, error: getErrorMessage(error) };
    }
  }
}
