import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import {
  PROJECT_METADATA_DIR_NAMES,
  getCanonicalProjectMetadataRelativePath,
} from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import { isDevcontainerRuntime, type RuntimeConfig } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config, ProjectsConfig } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import {
  isCanonicalPluginServerKey,
  PLUGIN_SERVER_KEY_PREFIX,
} from "@/node/services/agentPlugins/mcpConfig";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import { resolveCoderSSHHost } from "@/constants/coder";

const MCP_OVERRIDE_FILENAMES = ["mcp.local.jsonc", "mcp.local.json"] as const;
/**
 * Cross-process override-write epoch. Two Xum backends sharing one home each
 * publish only into their own MCPServerManager cache; a sibling's save or
 * prune is otherwise invisible until that cache happens to be evicted, and
 * the stale in-memory overlay would supersede a fresh authoritative request
 * read. Every write here bumps the token (under the write lock); managers
 * compare it on each serve preflight and refresh/evict their caches.
 */
const MCP_OVERRIDES_EPOCH_FILE = "mcp-overrides.epoch";

const MCP_OVERRIDES_EPOCH_UNREADABLE_TOKEN = "mcp-overrides-epoch-unreadable";

export async function readWorkspaceOverridesEpochToken(
  rootDir: string
): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(path.join(rootDir, MCP_OVERRIDES_EPOCH_FILE), "utf-8");
  } catch (error) {
    // Unreadable is indistinguishable from "changed" for a reader; managers
    // treat EVERY observation of this sentinel as a change (see
    // isWorkspaceOverridesEpochUnreadable), never as a stable version.
    return hasFsCode(error, "ENOENT") ? undefined : MCP_OVERRIDES_EPOCH_UNREADABLE_TOKEN;
  }
}

export function isWorkspaceOverridesEpochUnreadable(token: string | undefined): boolean {
  return token === MCP_OVERRIDES_EPOCH_UNREADABLE_TOKEN;
}
const MCP_OVERRIDES_GITIGNORE_PATTERNS = PROJECT_METADATA_DIR_NAMES.flatMap((dirName) =>
  MCP_OVERRIDE_FILENAMES.map((filename) => `${dirName}/${filename}`)
);
/**
 * Receives the effective overrides of a workspace after a write. Called for the
 * written workspace AND for every other workspace the write affected (hence
 * the explicit workspaceId), inside the exclusive write queue. `null` means
 * the effective state could not be established authoritatively (unreachable
 * checkout): the receiver must DROP any cached snapshot for that workspace so
 * its next request reads disk, rather than cache a guess.
 */
export type OverridesPublisher = (
  persisted: WorkspaceMCPOverrides | null,
  /** Target workspace, or ALL_WORKSPACES_TARGET (only ever with `null`: evict every cache). */
  workspaceId: string
) => Promise<void>;

/**
 * Publisher target meaning "every workspace this receiver knows about". Sent
 * with `null` when the workspace graph could not be enumerated after a write:
 * the receiver cannot be told WHICH inheriting descendants are stale, so it
 * must drop all cached snapshots rather than keep serving revoked enablement.
 */
export const ALL_WORKSPACES_TARGET = "*";
/**
 * Revision reported to the settings UI when the current state could not be
 * established (see getWorkspaceMcpOverrides). A save carrying it back is the
 * explicit repair path for an unreadable document (see writeOverridesLocked).
 */
export const MCP_OVERRIDES_REVISION_UNAVAILABLE = "unavailable";

interface ResolvedOverrides {
  overrides: WorkspaceMCPOverrides;
  /**
   * False when any probe along the resolution (own paths or an inherited
   * ancestor's) was indeterminate, or an ancestor read failed: `overrides` is
   * then the safe fallback, not disk truth, and must not be cached as such.
   */
  authoritative: boolean;
  /**
   * Authority was lost in an ANCESTOR (unreachable parent checkout, an
   * indeterminate parent probe), not in this workspace's own document. The
   * own state is intact but the effective one is unknown: a save that
   * "repairs" the empty fallback would detach the child from inheritance and
   * silently drop everything the parent's document holds.
   */
  authorityLostInherited?: true;
  /**
   * The document that supplied the overrides. `ownerWorkspaceId` identifies
   * WHICH chain member's checkout it lives in: paths alone are ambiguous
   * across runtimes (every Docker workspace reports `/src`), so an inheriting
   * child and its parent can share the same file path in different
   * filesystems.
   */
  sourceFile?: {
    runtime: ReturnType<typeof createRuntime>;
    filePath: string;
    ownerWorkspaceId: string;
    /** The owner's checkout root on `runtime` (containment checks before the raw document is copied). */
    workspacePath: string;
    /** `runtime` reads the host filesystem (see ResolvedWorkspace.hostFilesystem). */
    hostFilesystem: boolean;
    /**
     * The document normalizes to nothing for this build and did not decide
     * the effective overrides (see withOwnDocumentFallback): it is copied so
     * its forward-compatible fields survive a fork, but ancestors still
     * take part in precedence (a parent document appearing later wins).
     */
    transparent?: true;
  };
  /**
   * A legacy config.json `workspace.mcp` value whose shape this build cannot
   * read (see isRecognizedOverridesDocument). It stays where it is, but a fork
   * must still carry it: the fork is independent and would otherwise lose that
   * forward-compatible configuration for good.
   */
  opaqueLegacyValue?: unknown;
}

/** local/worktree checkouts live on this host's filesystem; everything else execs remotely. */
function isHostLocalRuntimeConfig(config: RuntimeConfig): boolean {
  return config.type === "local" || config.type === "worktree";
}

/**
 * The override files of this checkout are host files: local/worktree
 * checkouts, and devcontainer checkouts — host worktrees whose runtime maps
 * `stat`/`readFile`/`writeFile` to the host path while `exec` needs a RUNNING
 * container (`devcontainer exec`). Path guards for these must not exec.
 */
function overridesOnHostFilesystem(config: RuntimeConfig | undefined): boolean {
  return (
    config !== undefined && (isHostLocalRuntimeConfig(config) || isDevcontainerRuntime(config))
  );
}

/**
 * Filesystem identity of a runtime config: two workspaces can share a checkout
 * only when this matches AND their paths match. Ignores non-identity fields
 * (e.g. Coder's `existingWorkspace` flag, which forkWorkspace flips on the
 * parent alone). Docker never shares: every container reports `/src`.
 */
export function runtimeFilesystemIdentity(config: RuntimeConfig): string | undefined {
  switch (config.type) {
    case "local":
    case "worktree":
      return "host";
    case "ssh":
      // Host + effective port address one machine (mirrors SSHRuntime's
      // project sync key); the identity file only affects authentication.
      // Coder configs may persist the raw `coder://` placeholder host while
      // runtimeFactory derives the real endpoint from the workspace name —
      // resolve the same way so distinct Coder machines never coincide.
      return `ssh:${resolveCoderSSHHost(config.host, config.coder?.workspaceName).trim()}:${config.port ?? 22}`;
    case "devcontainer":
      // The override files live in the host worktree (DevcontainerRuntime
      // maps them to host paths; see overridesOnHostFilesystem): a
      // devcontainer registration shares its checkout with a local/worktree
      // alias — and with another devcontainer spelling of the same
      // `configPath` — so all of them must contend for one lock.
      return "host";
    case "docker":
      return undefined;
  }
}
/**
 * SECURITY: read a host override document whose bytes leave the checkout (the
 * fork copy; unknown fields carried into another document) without following
 * a symlink swapped in after the point-in-time segment guards. Code running
 * in the checkout (a devcontainer's, whose files are read on the host by
 * design) can replace the document — or a PARENT segment such as `.xum` —
 * with a symlink between a check and a path-based read. Node cannot open
 * relative to a pinned directory descriptor, so the read is verified instead:
 * 1. open once with O_NOFOLLOW (the final component is never followed) and
 *    fstat the handle (a regular file);
 * 2. AFTER the open, re-guard every repo-controlled segment under the
 *    checkout's realpath (`lstat`, not a symlink) and require the file at
 *    that canonical path to be the very inode the handle holds.
 * A parent swapped to a symlink at open time either still is one at step 2
 * (guard fails) or was swapped back (the handle's inode then differs from
 * the checkout's own file); the bytes are read from the verified handle. A
 * hardlink planted inside the checkout is indistinguishable from the
 * checkout's own file — by any check — and is out of scope.
 */
export async function readHostOverrideDocumentNoFollow(
  filePath: string,
  workspacePath: string
): Promise<string> {
  const refuse = (reason: string): never => {
    throw new Error(
      `Workspace MCP overrides path could not be verified (${reason}); refusing to read it: ${filePath}`
    );
  };
  const handle = await fsPromises.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) refuse("not a regular file");
    const relative = path.relative(workspacePath, filePath).replaceAll("\\", "/");
    if (relative.startsWith("..") || path.isAbsolute(relative)) refuse("outside the checkout");
    const root = await fsPromises.realpath(workspacePath);
    let current = root;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      if ((await fsPromises.lstat(current)).isSymbolicLink())
        refuse(`${segment} is a symbolic link`);
    }
    const canonical = await fsPromises.stat(current);
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      refuse("the opened file is not the checkout's own document");
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * SECURITY: refuse to write to or remove through a symlinked override path
 * segment. The checkout root is trusted; the two repo-controlled segments of
 * every candidate (`.xum`, `.xum/mcp.local.jsonc`, and the compatibility
 * spellings) are probed. Host files (`hostFilesystem`: local/worktree
 * checkouts, devcontainer host worktrees — see overridesOnHostFilesystem) are
 * probed with `lstat`, so a stopped devcontainer or an unmapped container cwd
 * cannot fail a write that the runtime performs on the host anyway;
 * exec-backed runtimes (SSH/Docker) with shell `test ! -L` — mirrors
 * isForkCopyTargetWritable. A failed shell probe is refused too: nothing
 * vouches for the path then.
 */
async function assertOverrideSegmentsNotSymlinked(
  runtime: ReturnType<typeof createRuntime>,
  workspacePath: string,
  hostFilesystem: boolean
): Promise<void> {
  const segments = new Set<string>();
  for (const relativeFile of MCP_OVERRIDES_GITIGNORE_PATTERNS) {
    segments.add(relativeFile.split("/")[0]);
    segments.add(relativeFile);
  }
  const refuse = (): never => {
    throw new Error(
      `Workspace MCP overrides path is a symbolic link or could not be verified; refusing to write or remove through it: ${workspacePath}`
    );
  };
  if (hostFilesystem) {
    for (const segment of segments) {
      let isSymbolicLink: boolean;
      try {
        isSymbolicLink = (
          await fsPromises.lstat(path.join(workspacePath, segment))
        ).isSymbolicLink();
      } catch {
        // Same verdict as `test -L`: a segment that cannot be lstat'ed (absent
        // — the write creates it — or inside a directory without search
        // permission) is not a link that a write or `rm` could follow either;
        // the operation itself fails on such a path.
        continue;
      }
      if (isSymbolicLink) return refuse();
    }
    return;
  }
  const probe = await execBuffered(
    runtime,
    [...segments].map((segment) => `test ! -L "${segment}"`).join(" && "),
    { cwd: workspacePath, timeout: 10 }
  );
  if (probe.exitCode !== 0) refuse();
}

/**
 * Canonical form of an override file path for sharer comparison. On the host
 * filesystem, resolve the (existing) parent directory through symlinks so two
 * registrations of one checkout compare equal; the file itself may not exist
 * yet, so canonicalize its directory and re-append the name. Falls back to the
 * spelled path when nothing resolves.
 */
/**
 * Canonical (realpath) spelling of a host override path, or `undefined` when
 * it could not be established (missing checkout, stalled filesystem, realpath
 * timeout). Callers must treat `undefined` as indeterminate — comparing the
 * spelled path instead would prove nothing about two registrations naming the
 * same checkout through different symlinks.
 */
async function canonicalizeHostPath(
  identity: string,
  filePath: string
): Promise<string | undefined> {
  if (identity !== "host") {
    return filePath;
  }
  const dir = path.dirname(filePath);
  const resolvedDir = await boundedRealpath(dir);
  if (resolvedDir !== undefined) {
    return path.join(resolvedDir, path.basename(filePath));
  }
  // The `.xum` dir may not exist yet; canonicalize the checkout root instead.
  const resolvedRoot = await boundedRealpath(path.dirname(dir));
  return resolvedRoot !== undefined
    ? path.join(resolvedRoot, path.basename(dir), path.basename(filePath))
    : undefined;
}

/**
 * realpath against a stalled filesystem (disconnected NFS) can block
 * indefinitely, and the publication scan runs inside the exclusive write
 * queue — one wedged candidate would serialize every later override write
 * behind it. Cap each canonicalization like the registration scan in
 * WorkspaceService does; a timeout behaves like any other realpath failure.
 */
const REALPATH_TIMEOUT_MS = 2_000;
/**
 * Per-descendant budget for the host-side ownership probe + resolution in
 * publishEffectiveOverrides. LocalBaseRuntime.stat/readFile have no timeout
 * and ignore abort signals, so a worktree on a disconnected NFS/FUSE mount
 * would otherwise wedge the publication — and every later writer — under
 * the exclusive lock. On timeout the descendant (and its subtree) is
 * evicted instead: its next serve re-reads on its own.
 */
const HOST_DESCENDANT_TIMEOUT_MS = 5_000;

/**
 * Reject with `message` when `promise` has not settled within `timeoutMs`.
 * The losing promise keeps running: callers whose work has side effects must
 * pass `onTimeout` to flip a cooperative cancellation flag the work checks
 * before every side effect (see ConfigSnapshot.cancel).
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedRealpath(target: string): Promise<string | undefined> {
  try {
    return await withDeadline(
      fsPromises.realpath(target),
      REALPATH_TIMEOUT_MS,
      "realpath timed out"
    );
  } catch {
    return undefined;
  }
}
/**
 * Memoized config reads shared across one resolution/publication — or one
 * batch sweep. Loading config.json is a synchronous full parse (~100 ms on a
 * multi-thousand-workspace config), so re-reading it per inheritance level,
 * per re-published descendant, or per swept workspace made plugin installs
 * appear hung for tens of minutes. Host realpaths are memoized too: sharer
 * detection canonicalizes every host-local workspace's override path.
 */
class ConfigSnapshot {
  private readonly store: {
    legacy?: ProjectsConfig;
    all?: Promise<FrontendWorkspaceMetadata[]>;
    canonical: Map<string, Promise<string | undefined>>;
    /** In-flight writes started by this operation (see trackSideEffect). */
    sideEffects: Set<Promise<unknown>>;
  };
  private _cancelled = false;

  constructor(
    private readonly config: Config,
    /**
     * Read devcontainer workspaces' override files through the host
     * filesystem instead of `devcontainer exec`. Their checkouts are host
     * worktrees; the fork path uses this because the source container need
     * not be running (forkWorkspace only creates the new worktree), and an
     * exec-backed probe against a stopped container would be indeterminate —
     * silently skipping the copy for a file that is readable on the host.
     */
    readonly hostFilesystemView = false,
    store?: ConfigSnapshot["store"],
    /**
     * The operation holds the workspace and global override write locks
     * (setOverridesForWorkspace, the prune sweep, the locked fork path).
     * Depth-0 resolution may then mutate directly (legacy migration, empty
     * legacy clear); every other resolution — the send path's and the
     * call-time gate's per-request reads, the settings read — is an unlocked
     * READER whose mutation must first take those locks and re-verify (see
     * migrateLegacyOverridesFenced), or a read that paused after observing
     * the legacy value could overwrite a disable a save persisted meanwhile.
     */
    readonly writerLocksHeld = false
  ) {
    this.store = store ?? { canonical: new Map(), sideEffects: new Set() };
  }

  /**
   * Register a write this operation started. Cancellation cannot stop a
   * write that is already in flight (LocalBaseRuntime.writeFile ignores its
   * abort signal), so a lock holder that timed out must keep the lock until
   * every tracked write has settled — otherwise the abandoned write could
   * land on top of a newer save made under the released lock.
   */
  trackSideEffect<T>(effect: Promise<T>): Promise<T> {
    this.store.sideEffects.add(effect);
    void effect.finally(() => this.store.sideEffects.delete(effect)).catch(() => undefined);
    return effect;
  }

  /** Resolves once every tracked in-flight write has settled (errors ignored). */
  async settleSideEffects(): Promise<void> {
    while (this.store.sideEffects.size > 0) {
      await Promise.allSettled([...this.store.sideEffects]);
    }
  }

  /**
   * Cooperative cancellation for work that runs under a deadline. A
   * `Promise.race` deadline cannot stop the losing promise, so once the
   * deadline fires the abandoned work must not perform side effects that the
   * caller assumed happened under its lock or before its own eviction: the
   * legacy migration write checks this flag before writing, and publication
   * steps check it before publishing.
   */
  cancel(): void {
    this._cancelled = true;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  /** Same memoized config reads, independent cancellation (one per bounded step). */
  scoped(): ConfigSnapshot {
    return new ConfigSnapshot(
      this.config,
      this.hostFilesystemView,
      this.store,
      this.writerLocksHeld
    );
  }

  /**
   * Authoritative too (throwOnError): the lenient loader degrades a transient
   * read failure to an EMPTY config, which would classify a child whose only
   * own setting is a legacy `workspace.mcp` value as inheriting — and serve a
   * parent-enabled server the child explicitly disabled. Callers turn the
   * throw into a non-authoritative, non-inheriting result.
   */
  loadLegacyConfig(): ProjectsConfig {
    return (this.store.legacy ??= this.config.loadConfigOrDefault({ throwOnError: true }));
  }

  /**
   * Authoritative enumeration (throwOnError): a partial/empty snapshot from
   * a transient config read failure would silently skip inheriting
   * descendants and leave their caches stale. Loaded once; a failure is
   * memoized too so one operation sees one consistent answer.
   */
  loadAllMetadata(): Promise<FrontendWorkspaceMetadata[]> {
    // Registry data only: override resolution needs ids, paths, runtimes and
    // parent links, never the per-checkout existence probe — which is one
    // fs.access per registered workspace, paid on every request and blocked
    // indefinitely by any stalled mount (see Config.getAllWorkspaceMetadata).
    return (this.store.all ??= this.config.getAllWorkspaceMetadata({
      throwOnError: true,
      probeCheckouts: false,
    }));
  }

  canonicalize(identity: string, filePath: string): Promise<string | undefined> {
    if (identity !== "host") {
      return Promise.resolve(filePath);
    }
    let pending = this.store.canonical.get(filePath);
    if (pending === undefined) {
      pending = canonicalizeHostPath(identity, filePath);
      this.store.canonical.set(filePath, pending);
    }
    return pending;
  }
}

/** Unlocked fork-copy preparations attempted before the terminal fallback (see copyOverridesToForkedCheckout). */
const FORK_COPY_ATTEMPTS = 3;
/**
 * Budget for a fork-copy preparation that runs UNDER the override lock
 * (legacy migration, or the terminal host-local fallback); bounds the lock
 * hold time well below its 60 s acquisition timeout so unrelated writers are
 * never starved by a stalled checkout.
 */
const FORK_COPY_LOCKED_TIMEOUT_MS = 15_000;
/**
 * ONE absolute deadline for the whole fork-time override copy: every
 * preparation attempt, lock acquisition, the terminal locked fallback and the
 * target-side write (writability probe, mkdir, write, git exclude) draw on
 * what remains of it. The fork awaits this best-effort copy before
 * init/registration, remote runtimes allow minutes per operation, and
 * sustained settings activity would otherwise reset a per-step budget on
 * every retry: an unreachable source or target, or a busy writer, must make
 * the copy give up — not stall the fork for several budgets in a row.
 */
const FORK_COPY_TIMEOUT_MS = 60_000;
/** Cooperative cancellation state shared between copyOverridesToForkedCheckout's deadline and writeForkCopy. */
interface ForkCopyProgress {
  cancelled: boolean;
  /**
   * The in-flight target mutation once started — the git exclude update, then
   * the document write; joined by a timed-out copy (see
   * copyOverridesToForkedCheckout) so neither can land after the caller moved on.
   */
  mutation?: Promise<void>;
}
/** Parallel realpath budget for the sharer scan (see publishEffectiveOverrides). */
const CANONICALIZE_CONCURRENCY = 16;
/** Budget for acquiring a workspace lock — or a whole batch of them (see withWorkspaceLocks). */
const WORKSPACE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const WORKSPACE_LOCK_RETRY_BACKOFF_MS = 150;
/** Budget for an unlocked reader's legacy migration to take the write locks (see migrateLegacyOverridesFenced). */
const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
/** What a depth-0 resolution migrates (see migrateLegacyOverrides). */
interface LegacyMigrationTarget {
  workspaceId: string;
  /** The config.json value observed by the resolution (compared verbatim under the locks). */
  legacy: WorkspaceMCPOverrides;
  normalizedLegacy: WorkspaceMCPOverrides;
  runtime: ReturnType<typeof createRuntime>;
  workspacePath: string;
  canonicalPath: string;
  filePaths: readonly string[];
  runtimeConfig: RuntimeConfig | undefined;
}
/** Bound for each override resolution a settings save performs while holding the write locks. */
const SAVE_RESOLUTION_TIMEOUT_MS = 30_000;
/** A checkout moved between key derivation and lock acquisition (see withWorkspaceLocks). */
class CheckoutKeysChangedError extends Error {
  constructor() {
    super("workspace checkout keys changed while acquiring their locks");
  }
}
/** Result of one checkout-lock key derivation (see checkoutLockKeys). */
interface CheckoutLockKeys {
  /** Every lock key of each resolvable workspace's checkout. */
  keys: Map<string, string[]>;
  /** Workspaces whose checkout identity could not be established (not locked). */
  unresolvable: Array<{ workspaceId: string; error: Error }>;
  /** The registry view the derivation read (registry-only enumeration). */
  registry: FrontendWorkspaceMetadata[];
}
const WORKSPACE_LOCK_TIMEOUT_MESSAGE =
  "Another Mux operation (a rename or an MCP settings update) is in progress for this workspace. Wait for it to finish and try again.";
/** Parallel descendant probes/resolutions per breadth level (see publishEffectiveOverrides). */
const PUBLICATION_CONCURRENCY = 8;
/**
 * Overall budget for one publication fan-out under the exclusive lock (sharer
 * scan + descendant levels). Well below the lock's 60 s acquisition timeout;
 * exhaustion evicts every cache rather than holding the lock longer.
 */
const PUBLICATION_TIMEOUT_MS = 30_000;
/**
 * Bound for one request-path override read (getOverridesForWorkspace with
 * `timeoutMs`): a send, prompt discovery, or the manager's authority re-read
 * must not wait for a remote parent's 300 s command timeout. Shared by every
 * request-path reader so the manager's re-read is bounded like the caller's.
 */
export const MCP_OVERRIDES_READ_TIMEOUT_MS = 30_000;
/**
 * Wall-clock budget shared by one publication (or one whole batch sweep, so
 * `n` stalled workspaces cannot hold the lock for `n × PUBLICATION_TIMEOUT_MS`).
 */
interface PublicationBudget {
  remaining(): number;
  exhausted(): boolean;
}
function createPublicationBudget(timeoutMs = PUBLICATION_TIMEOUT_MS): PublicationBudget {
  const deadlineAt = Date.now() + timeoutMs;
  return {
    remaining: () => Math.max(1, deadlineAt - Date.now()),
    exhausted: () => Date.now() >= deadlineAt,
  };
}
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  assert(limit > 0, "mapWithConcurrency: limit must be positive");
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
/** Bound for parent-chain override inheritance; task trees are far shallower than this. */
const MAX_OVERRIDES_INHERITANCE_DEPTH = 32;

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

/**
 * Whether a parsed override document has a shape this build fully understands:
 * an object root whose owned fields, when present, carry their known types.
 * Anything else (`null`, an array, `"disabledServers": "shots"`, a string
 * allowlist entry) may have been written by a newer release. Such a document
 * normalizes to nothing here, but it is NOT a decision to inherit from the
 * parent: the child has configuration of its own that this build cannot read,
 * and resolving through the parent could start a server the opaque document
 * disables. Resolution stops at the child (no overrides), exactly as before
 * inheritance existed; the prune path rejects the same shapes. The same
 * applies to any top-level field this build does not know: a newer release
 * may give it authorization semantics (e.g. a deny rule) with every known
 * field empty, and a downgraded build inheriting the parent's enables over
 * it could start a server the document disables. Only a document made
 * exclusively of known, empty-normalizing fields is "empty".
 */
/** The override fields this build owns: what prunePluginOverrideKeys edits by JSON path and what isRecognizedOverridesDocument accepts. */
const PRUNED_OVERRIDE_FIELDS = new Set(["enabledServers", "disabledServers", "toolAllowlist"]);

function isRecognizedOverridesDocument(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !PRUNED_OVERRIDE_FIELDS.has(key))) {
    return false;
  }
  return knownFieldShapesSupported(obj);
}

/**
 * Whether every field this build owns that is present in `obj` has the shape
 * this build can read and rewrite. A newer version may store a known field
 * in a newer shape (e.g. `toolAllowlist.server` as an object); such a field
 * cannot be preserved through a save built from normalized data, so callers
 * refuse to edit the document rather than silently drop it.
 */
function knownFieldShapesSupported(obj: Record<string, unknown>): boolean {
  for (const field of ["disabledServers", "enabledServers"] as const) {
    if (obj[field] !== undefined && !isStringArray(obj[field])) return false;
  }
  const allowlist = obj.toolAllowlist;
  if (allowlist === undefined) return true;
  if (allowlist === null || typeof allowlist !== "object" || Array.isArray(allowlist)) {
    return false;
  }
  return Object.values(allowlist as Record<string, unknown>).every(isStringArray);
}

/**
 * The fields of a legacy config.json value that this build does not own, for
 * carrying into the workspace document when a save retires the value: `{}`
 * when the value is absent or recognized (nothing to preserve), `undefined`
 * when it is opaque but not an object — nothing of it can live in a document.
 */
function opaqueLegacyFieldsOf(legacy: unknown): Record<string, unknown> | undefined {
  if (legacy === undefined || isRecognizedOverridesDocument(legacy)) {
    return {};
  }
  if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) {
    return undefined;
  }
  const obj = legacy as Record<string, unknown>;
  // A known field in a shape this build cannot read is newer-version data
  // just as much as an unknown field — and it cannot be carried as-is.
  if (!knownFieldShapesSupported(obj)) {
    return undefined;
  }
  // Mixed value: known fields with data next to an unknown field. Resolution
  // treats the whole value as opaque (the unknown field may carry
  // authorization semantics), so the settings UI showed `{}` — a save built
  // from it would retire the legacy value and drop known settings the user
  // never saw. Only a build that reads the whole value may edit it.
  if (!isEmptyOverrides(normalizeWorkspaceMcpOverrides(obj))) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !PRUNED_OVERRIDE_FIELDS.has(key))
  );
}

/**
 * Merge unknown fields carried by legacy values that one save retires. Two
 * registrations sharing a checkout may each hold a newer version's data; a
 * last-write-wins merge would silently keep one and the save would clear the
 * other for good, so a field present in both with different values refuses
 * the save instead of choosing arbitrarily.
 */
function mergeOpaqueFields(
  into: Record<string, unknown>,
  fields: Record<string, unknown>,
  ownerWorkspaceId: string
): Record<string, unknown> {
  for (const [key, value] of Object.entries(fields)) {
    if (key in into && JSON.stringify(into[key]) !== JSON.stringify(value)) {
      throw new Error(
        `Workspaces sharing this checkout carry conflicting MCP settings written by a newer version of Xum (field "${key}", workspace ${ownerWorkspaceId}); the settings were not saved. Upgrade Xum to edit them.`
      );
    }
    into[key] = value;
  }
  return into;
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

/**
 * SECURITY: host-local override writes that may CREATE the document (a save,
 * the fork's shared-checkout materialization) must land inside the checkout
 * they intend to edit. Like assertPruneTargetNotSymlinked, but the file may
 * not exist yet: the (existing) `.xum` directory must not be a symlink and
 * must resolve inside the canonicalized workspace root — a tracked
 * `.xum -> /elsewhere` link would otherwise redirect the write — and an
 * existing file must not be a symlink either.
 */
async function assertHostOverrideWriteContained(
  filePath: string,
  workspacePath: string
): Promise<void> {
  const dir = path.dirname(filePath);
  if ((await fsPromises.lstat(dir)).isSymbolicLink()) {
    throw new Error(
      `Workspace MCP overrides directory is a symbolic link, refusing to write into it: ${dir}`
    );
  }
  const resolvedDir = await fsPromises.realpath(dir);
  const resolvedRoot = await fsPromises.realpath(workspacePath);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Workspace MCP overrides directory resolves outside the workspace, refusing to write into it: ${dir}`
    );
  }
  try {
    if ((await fsPromises.lstat(filePath)).isSymbolicLink()) {
      throw new Error(
        `Workspace MCP overrides file is a symbolic link, refusing to modify it: ${filePath}`
      );
    }
  } catch (error) {
    if (!hasFsCode(error, "ENOENT")) {
      throw error;
    }
  }
}

/**
 * Whether a stat failure positively proves the path is absent. Local runtimes
 * surface node errno codes (RuntimeError wraps them as `cause`); exec-backed
 * remote runtimes (SSH/Docker) only relay stat(1)'s stderr inside
 * `Failed to stat <path>: <stderr>`, so match stat's OWN diagnostic line
 * (`stat: cannot statx '…': No such file or directory`, busybox `can't stat`,
 * BSD `stat: …: stat: No such file…`). Requiring the `stat:` program prefix
 * keeps transport/setup noise from counting — OpenSSH prints
 * `Warning: Identity file … not accessible: No such file or directory` and
 * exits 255 when the connection itself fails, which must stay indeterminate.
 */
export function isPositivelyAbsent(error: unknown): boolean {
  if (hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR")) {
    return true;
  }
  return /(?:^|: )stat: [^\n]*(?:No such file or directory|Not a directory)/im.test(
    getErrorMessage(error)
  );
}

type OverridesFileProbe =
  | { kind: "file" }
  | { kind: "absent" }
  /** EACCES, I/O error, transport hiccup: the file may or may not exist. */
  | { kind: "indeterminate"; error: unknown };

/**
 * Never throws: strict callers decide per PRECEDENCE whether an indeterminate
 * probe matters (see selectProbedCandidate) — a failing lower-priority
 * compatibility path must not make a valid canonical document unreadable.
 */
async function probeOverridesFile(
  runtime: ReturnType<typeof createRuntime>,
  filePath: string
): Promise<OverridesFileProbe> {
  try {
    const stat = await runtime.stat(filePath);
    // A DIRECTORY at a candidate path is not absence: treating it as such
    // would let an inheriting child fall through to its parent's enables on
    // the strength of a corrupt (or repository-tracked) `mcp.local.jsonc/`.
    // Nothing can be read from it either, so precedence stays unestablished.
    return stat.isDirectory
      ? {
          kind: "indeterminate",
          error: new Error(`Workspace MCP overrides path is a directory: ${filePath}`),
        }
      : { kind: "file" };
  } catch (error) {
    return isPositivelyAbsent(error) ? { kind: "absent" } : { kind: "indeterminate", error };
  }
}

/**
 * Honors path-order precedence over probes taken in parallel: the first
 * candidate that is a file wins and every lower-priority probe is irrelevant
 * (whatever it holds is shadowed). An indeterminate probe at or above the
 * first file leaves precedence unestablished — the hidden higher-priority
 * document may disable what the visible one enables — so the result is
 * indeterminate (strict callers throw that probe's error: "cannot tell" must
 * stay distinct from "positively absent", or the plugin uninstaller could
 * retire a prune tombstone against a file it never actually read).
 */
function selectProbedCandidate(
  probes: readonly OverridesFileProbe[]
):
  | { kind: "file"; index: number }
  | { kind: "absent" }
  | { kind: "indeterminate"; error: unknown } {
  for (const [index, probe] of probes.entries()) {
    if (probe.kind === "file") return { kind: "file", index };
    if (probe.kind === "indeterminate") return probe;
  }
  return { kind: "absent" };
}

async function statIsFile(
  runtime: ReturnType<typeof createRuntime>,
  filePath: string,
  mode: "lenient" | "strict"
): Promise<boolean> {
  const probe = await probeOverridesFile(runtime, filePath);
  if (probe.kind === "indeterminate" && mode === "strict") {
    throw probe.error;
  }
  return probe.kind === "file";
}

/** A workspace's metadata with its runtime and checkout path resolved. */
/** A fork copy ready to write: the source document text and where it goes. */
interface ForkCopySource {
  content: string;
  targetPath: string;
}

interface ResolvedWorkspace {
  metadata: FrontendWorkspaceMetadata;
  runtime: ReturnType<typeof createRuntime>;
  workspacePath: string;
  /** `runtime` reads the host filesystem (local/worktree, or a devcontainer through the host view). */
  hostFilesystem: boolean;
}

/**
 * Registry entries grouped by stable id (corrupted config may register one id
 * several times). `hostLocalOnly` keeps just local/worktree entries — the
 * plugin sweep's view (plugin servers never run off-host, and its symlink
 * guard uses host fs semantics); lock derivation needs every entry.
 */
function groupMetadataById(
  all: FrontendWorkspaceMetadata[],
  hostLocalOnly: boolean
): Map<string, FrontendWorkspaceMetadata[]> {
  const grouped = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const metadata of all) {
    if (hostLocalOnly && !isHostLocalRuntimeConfig(metadata.runtimeConfig)) {
      continue;
    }
    const entries = grouped.get(metadata.id);
    if (entries) {
      entries.push(metadata);
    } else {
      grouped.set(metadata.id, [metadata]);
    }
  }
  return grouped;
}

export class WorkspaceMcpOverridesService {
  /**
   * Root holding the cross-process coordination state (override epoch file,
   * writer locks). Defaults to the config root; a process whose registry
   * root is disposable (`xum run`) but whose MCP configuration lives in the
   * persistent Xum home passes that home, so its fences observe and contend
   * with a desktop/server backend's saves on the same checkouts.
   */
  private readonly coordinationRootDir: string;

  constructor(
    private readonly config: Config,
    options?: { coordinationRootDir?: string }
  ) {
    assert(config, "WorkspaceMcpOverridesService requires a Config instance");
    this.coordinationRootDir = options?.coordinationRootDir ?? config.rootDir;
  }

  /**
   * With a snapshot, the (authoritative) enumeration is shared with the
   * resolution that follows — a child's parent lookup otherwise re-parses and
   * re-enriches the whole registry on every sub-agent turn.
   */
  private async getWorkspaceMetadata(
    workspaceId: string,
    snapshot?: ConfigSnapshot
  ): Promise<FrontendWorkspaceMetadata> {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const all = snapshot
      ? await snapshot.loadAllMetadata()
      : await this.config.getAllWorkspaceMetadata({ probeCheckouts: false });
    const metadata = all.find((m) => m.id === trimmed);
    if (!metadata) {
      throw new Error(`Workspace metadata not found for ${trimmed}`);
    }

    return metadata;
  }

  private getLegacyOverridesFromConfig(
    workspaceId: string,
    config: ProjectsConfig
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

  private async clearLegacyOverridesInConfig(
    workspaceId: string,
    options?: {
      /**
       * Compare-and-delete: clear only while the stored value still equals
       * the one this operation observed. Read-path clears (empty-legacy
       * noise, migration) run without the write locks, so an older or
       * downgraded Xum process may have saved a NEW `workspace.mcp` value in
       * between; deleting it blindly would lose that decision and re-attach
       * the child to its parent's configuration. Lock-holding writers (a
       * save) omit this: the user's write wins.
       */
      onlyIfEquals?: WorkspaceMCPOverrides;
    }
  ): Promise<void> {
    const expected =
      options?.onlyIfEquals === undefined ? undefined : JSON.stringify(options.onlyIfEquals);
    await this.config.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          if (expected !== undefined && JSON.stringify(workspace.mcp) !== expected) {
            log.debug(
              "[MCP] Legacy workspace MCP overrides changed since they were read; not clearing",
              {
                workspaceId,
              }
            );
            return config;
          }
          delete workspace.mcp;
          return config;
        }
      }
      return config;
    });
  }

  private async getRuntimeAndWorkspacePath(
    workspaceId: string,
    snapshot?: ConfigSnapshot
  ): Promise<ResolvedWorkspace> {
    return this.resolveWorkspace(await this.getWorkspaceMetadata(workspaceId, snapshot));
  }

  /** Same as getRuntimeAndWorkspacePath for callers that already hold the metadata (no config re-scan). */
  private resolveWorkspace(
    metadata: FrontendWorkspaceMetadata,
    snapshot?: ConfigSnapshot
  ): ResolvedWorkspace {
    const workspaceRuntime = createRuntimeForWorkspace(metadata);

    // In-place workspaces (CLI/benchmarks) store the workspace path directly by setting
    // metadata.projectPath === metadata.name.
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : workspaceRuntime.getWorkspacePath(metadata.projectPath, metadata.name);

    assert(
      typeof workspacePath === "string" && workspacePath.length > 0,
      "workspacePath is required"
    );

    // See ConfigSnapshot.hostFilesystemView. Same treatment the fork target
    // receives: devcontainer checkouts are host worktrees, so the host path is
    // the file's real location — at the PERSISTED checkout path (Docker labels
    // devcontainers by the exact host path from startup, so a migrated/
    // non-canonical entry can differ from the name-derived path). Decided from
    // the runtime CONFIG, not the runtime class: a multi-project workspace
    // wraps its devcontainers in a MultiProjectRuntime.
    if (snapshot?.hostFilesystemView && isDevcontainerRuntime(metadata.runtimeConfig)) {
      const hostPath = isInPlace ? workspacePath : (metadata.namedWorkspacePath ?? workspacePath);
      return {
        metadata,
        runtime: createRuntime({ type: "local" }, { projectPath: hostPath }),
        workspacePath: hostPath,
        hostFilesystem: true,
      };
    }
    return {
      metadata,
      runtime: workspaceRuntime,
      workspacePath,
      // Devcontainer override files are host files too (the runtime maps
      // stat/read/write to the host worktree): path guards on such a source
      // — e.g. an inherited document read while the parent's container is
      // stopped — must probe the host, not `devcontainer exec`.
      hostFilesystem: overridesOnHostFilesystem(metadata.runtimeConfig),
    };
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

  /**
   * Lenient reads report whether the parsed value is the file's real content:
   * a transient read failure OR a parse error yields `{}` with
   * `authoritative: false`, so callers publishing caches never pin an empty
   * snapshot over a file that later becomes readable/repaired — the request
   * itself still proceeds with "no overrides".
   */
  private async readOverridesFile(
    runtime: ReturnType<typeof createRuntime>,
    filePath: string,
    mode: "lenient" | "strict"
  ): Promise<{ parsed: unknown; authoritative: boolean }> {
    let raw: string;
    try {
      raw = await readFileString(runtime, filePath);
    } catch (error) {
      if (mode === "strict") {
        throw error;
      }
      // Treat a read failure as "no overrides" for this request only.
      log.debug("[MCP] Failed to read workspace MCP overrides file", { filePath, error });
      return { parsed: {}, authoritative: false };
    }
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
      return { parsed: {}, authoritative: false };
    }
    return { parsed, authoritative: true };
  }

  /**
   * Forward compatibility (see isRecognizedOverridesDocument): the fields of
   * the workspace's own document that this build does not own. A newer Xum
   * may have written them; a save from this (downgraded) build patches its
   * known fields into that document and keeps the rest, instead of
   * round-tripping the normalized object — which would silently discard the
   * newer version's data (upgrade↔downgrade must stay friction-free).
   * - `indeterminate` when it cannot be told whether such fields exist
   *   (EACCES, I/O error). The caller refuses a clearing save (removal would
   *   destroy them). A write is refused too when the CANONICAL path itself
   *   could not be probed (`canonicalUnprobed`): the write replaces exactly
   *   that file and would truncate fields it never read once I/O recovers. A
   *   write may proceed when only a lower-priority compatibility path is
   *   unprobed: the canonical document it creates shadows that file without
   *   touching it, and the UNAVAILABLE repair path stays usable.
   * - `unmergeable` for a VALID document whose root is not an object (`null`,
   *   an array, a scalar): nothing of it can live next to this build's
   *   fields, so only a build that understands it may replace it.
   * - A document with parse errors has no recoverable fields — that is
   *   exactly what the repair path replaces wholesale.
   */
  private async readOpaqueOverrideFields(
    runtime: ReturnType<typeof createRuntime>,
    filePaths: readonly string[],
    /** The paths are host files under `workspacePath`: read verified (see readHostOverrideDocumentNoFollow). */
    hostFilesystem: boolean,
    workspacePath: string
  ): Promise<
    | { kind: "fields"; fields: Record<string, unknown> }
    | { kind: "indeterminate"; canonicalUnprobed: boolean }
    | { kind: "unmergeable" }
  > {
    // The effective own document by precedence (a compatibility-path
    // document is what a clearing save removes and what a write shadows).
    const probes = await Promise.all(
      filePaths.map((filePath) => probeOverridesFile(runtime, filePath))
    );
    const selected = selectProbedCandidate(probes);
    if (selected.kind === "indeterminate") {
      return { kind: "indeterminate", canonicalUnprobed: probes[0].kind === "indeterminate" };
    }
    if (selected.kind === "absent") {
      return { kind: "fields", fields: {} };
    }
    const raw = hostFilesystem
      ? await readHostOverrideDocumentNoFollow(filePaths[selected.index], workspacePath)
      : await readFileString(runtime, filePaths[selected.index]);
    const errors: jsonc.ParseError[] = [];
    const parsed: unknown = jsonc.parse(raw, errors) as unknown;
    if (errors.length > 0) {
      return { kind: "fields", fields: {} };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unmergeable" };
    }
    const obj = parsed as Record<string, unknown>;
    // A known field stored in a newer shape would be dropped by a save built
    // from normalized data: refuse to edit rather than silently delete it.
    if (!knownFieldShapesSupported(obj)) {
      return { kind: "unmergeable" };
    }
    return {
      kind: "fields",
      fields: Object.fromEntries(
        Object.entries(obj).filter(([key]) => !PRUNED_OVERRIDE_FIELDS.has(key))
      ),
    };
  }

  /** Throws unless `workspacePath` is an existing directory on `runtime` (see writeOverridesLocked). */
  private async assertCheckoutExists(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string
  ): Promise<void> {
    let isDirectory: boolean;
    try {
      isDirectory = (await runtime.stat(workspacePath)).isDirectory;
    } catch (error) {
      throw new Error(
        `Workspace checkout is not available (${getErrorMessage(error)}); the MCP settings were not saved.`
      );
    }
    if (!isDirectory) {
      throw new Error(`Workspace checkout is not a directory: ${workspacePath}`);
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
    runtimeConfig: RuntimeConfig | undefined,
    /**
     * "lenient" (default): best effort, never fails a workspace operation.
     * "strict": throws when ignore coverage could not be established — used
     * before creating a document in a checkout that has none yet (fork copy),
     * where a visible file could be committed by accident.
     */
    failure: "lenient" | "strict" = "lenient"
  ): Promise<void> {
    // Every "nothing to do" exit below is indistinguishable from a transient
    // Git failure (a nonzero probe, an empty path). Lenient callers accept
    // that; a strict caller is about to create the document and must not:
    // returning normally would count unverified coverage as established.
    const unverified = (reason: string): void => {
      if (failure === "strict") {
        throw new Error(`git exclude coverage could not be verified: ${reason}`);
      }
      log.debug("[MCP] Skipping git exclude update for workspace MCP overrides", {
        workspacePath,
        reason,
      });
    };
    try {
      const isInsideGitResult = await execBuffered(runtime, "git rev-parse --is-inside-work-tree", {
        cwd: workspacePath,
        timeout: 10,
      });
      if (isInsideGitResult.exitCode !== 0) {
        // Git's own definitive answer ("fatal: not a git repository ...")
        // means nothing can be committed from here; any other nonzero
        // result (missing git, I/O error, timeout) proves nothing.
        if (/not a git repository/i.test(isInsideGitResult.stderr)) {
          return;
        }
        return unverified(
          `git rev-parse --is-inside-work-tree exited ${isInsideGitResult.exitCode}: ${isInsideGitResult.stderr.trim()}`
        );
      }
      if (isInsideGitResult.stdout.trim() !== "true") {
        // Inside a bare repository or .git directory: not a work tree.
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
        return unverified(
          `git rev-parse --git-path exited ${excludePathResult.exitCode}: ${excludePathResult.stderr.trim()}`
        );
      }

      const excludeFilePathRaw = excludePathResult.stdout.trim();
      if (excludeFilePathRaw.length === 0) {
        return unverified("git rev-parse --git-path returned no path");
      }

      const excludeFilePath = isAbsoluteForRuntime(runtimeConfig, excludeFilePathRaw)
        ? excludeFilePathRaw
        : joinForRuntime(runtimeConfig, workspacePath, excludeFilePathRaw);

      // Only a POSITIVELY absent exclude file is an empty one. Any other stat
      // or read failure (EACCES, transient remote I/O) must abort: the update
      // below replaces the whole file, and treating an unreadable file as
      // empty would erase the user's own exclusions. Lenient callers skip the
      // update; strict callers (about to create the document) fail.
      let existing = "";
      let excludeFileExists: boolean;
      try {
        excludeFileExists = !(await runtime.stat(excludeFilePath)).isDirectory;
      } catch (error) {
        if (!isPositivelyAbsent(error)) {
          return unverified(`could not stat ${excludeFilePath}: ${getErrorMessage(error)}`);
        }
        excludeFileExists = false;
      }
      if (excludeFileExists) {
        try {
          existing = await readFileString(runtime, excludeFilePath);
        } catch (error) {
          return unverified(`could not read ${excludeFilePath}: ${getErrorMessage(error)}`);
        }
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
      if (failure === "strict") {
        throw error;
      }
      // Best-effort only; never fail a workspace operation because git ignore couldn't be updated.
      log.debug("[MCP] Failed to add workspace MCP overrides file to git exclude", {
        workspacePath,
        error,
      });
    }
  }

  private async removeOverridesFile(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): Promise<void> {
    // Remove canonical and legacy file names so no conflicting source remains.
    // The exit code MUST be checked: callers (e.g. the Agent Plugin
    // uninstaller retiring override-prune tombstones) rely on
    // setOverridesForWorkspace rejecting when clearing overrides failed —
    // a swallowed `rm` failure would leave a stale enabledServers key that
    // a plugin reinstall could silently reactivate.
    // SECURITY: `rm -f` follows a symlinked parent directory; a repo-tracked
    // `.xum`/`.mux` symlink would make clearing this workspace delete a
    // sibling checkout's document.
    await assertOverrideSegmentsNotSymlinked(
      runtime,
      workspacePath,
      overridesOnHostFilesystem(runtimeConfig)
    );
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
   * Remove `filePath` only if it still holds exactly `expectedContent`
   * (rollback of a write this operation made). Ownership-safe: the document
   * is first RENAMED aside (atomic on one filesystem — a concurrent
   * replacement lands as a new file that is never touched), then inspected;
   * ours is deleted, anyone else's is moved back without clobbering a newer
   * one. The symlink guard ran before the write; paths are relative to the
   * checkout for the shell like removeOverridesFile.
   */
  private async removeExactDocument(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    filePath: string,
    expectedContent: string
  ): Promise<void> {
    // Host paths are joined with the platform separator (backslashes on
    // Windows) while the candidates are spelled with `/`.
    const normalizedFilePath = filePath.replaceAll("\\", "/");
    const relative = MCP_OVERRIDES_GITIGNORE_PATTERNS.find((candidate) =>
      normalizedFilePath.endsWith(candidate)
    );
    assert(relative !== undefined, "migrated document must be a known override path");
    const suffix = `${process.pid}-${Date.now()}`;
    const aside = `${relative}.rollback-${suffix}`;
    const run = async (command: string): Promise<void> => {
      const result = await execBuffered(runtime, command, { cwd: workspacePath, timeout: 10 });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to roll back the migrated override document: ${result.stderr.trim() || `${command.split(" ")[0]} exited with code ${result.exitCode}`}`
        );
      }
    };
    await run(`mv "${relative}" "${aside}"`);
    const current = await readFileString(runtime, `${filePath}.rollback-${suffix}`);
    if (current === expectedContent) {
      await run(`rm -f "${aside}"`);
      return;
    }
    // Not ours: put it back unless a newer document appeared meanwhile
    // (then the older one we hold is obsolete and dropped).
    log.warn("[MCP] Not rolling back a migrated override document that changed meanwhile", {
      filePath,
    });
    await run(`mv -n "${aside}" "${relative}" && rm -f "${aside}"`);
  }

  /**
   * Read workspace MCP overrides from <workspace>/.xum/mcp.local.jsonc.
   *
   * If the file doesn't exist, we fall back to legacy overrides stored in ~/.mux/config.json
   * and migrate them into the workspace-local file. Sub-agent (task child)
   * workspaces without overrides of their own inherit their parent's.
   *
   * The returned revision is an opaque token for setOverridesForWorkspace's
   * expectedRevision check.
   */
  async getOverridesForWorkspace(
    workspaceId: string,
    options?: {
      mode?: "lenient" | "strict";
      /**
       * Bound the complete resolution (own probes, legacy migration, every
       * inherited ancestor level — remote probes and document reads on an
       * SSH/Docker parent chain allow minutes per operation). On timeout or
       * abort the result is NOT authoritative (the manager then re-reads and
       * fails closed if it cannot vouch either); strict mode throws instead.
       * The snapshot is cancelled so abandoned resolution starts no write.
       */
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ overrides: WorkspaceMCPOverrides; revision: string; authoritative: boolean }> {
    const snapshot = new ConfigSnapshot(this.config);
    const mode = options?.mode ?? "lenient";
    const resolution = (async () =>
      this.resolveOverridesFor(
        await this.getWorkspaceMetadata(workspaceId, snapshot),
        mode,
        snapshot
      ))();
    let resolved: ResolvedOverrides;
    if (options?.timeoutMs === undefined && options?.signal === undefined) {
      resolved = await resolution;
    } else {
      const raced = await raceWithAbortAndTimeout(resolution, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (raced.kind !== "ok") {
        snapshot.cancel();
        // Not awaited: the losing resolution may be stuck on a remote probe,
        // and cancellation blocks any migration write it has not started. A
        // write it HAS started runs under its own write locks (see
        // migrateLegacyOverridesFenced) and settles there — waiting for it
        // here would hold this bounded read for the remote runtime's command
        // timeout instead of the advertised deadline.
        resolution.catch(() => undefined);
        snapshot.settleSideEffects().catch(() => undefined);
        const reason =
          raced.kind === "aborted"
            ? "workspace MCP override resolution was aborted"
            : "workspace MCP override resolution timed out";
        if (mode === "strict") {
          throw new Error(reason);
        }
        log.warn(`[MCP] ${reason}; serving no overrides (non-authoritative)`, { workspaceId });
        return { overrides: {}, revision: computeOverridesRevision({}), authoritative: false };
      }
      resolved = raced.value;
    }
    return {
      overrides: resolved.overrides,
      revision: computeOverridesRevision(resolved.overrides),
      authoritative: resolved.authoritative,
    };
  }

  /**
   * True when the workspace's OWN persisted state already is exactly what
   * saving `normalized` would leave behind: the workspace-local file holds
   * that content (or, for empty overrides, no own document exists) and no
   * legacy config.json value remains. Lets setOverridesForWorkspace accept a
   * stale expectedRevision for an idempotent retry — a save whose file write
   * landed but whose epoch bump failed changed the stored revision, so the
   * dialog's retry would otherwise be rejected as a conflict and the missing
   * cross-process invalidation could never be published from that dialog.
   * Anything indeterminate (non-authoritative resolution, unreadable legacy
   * config where it matters) is not a match: the CAS then fails closed.
   */
  private isPersistedAsOwn(
    workspaceId: string,
    current: ResolvedOverrides,
    normalized: WorkspaceMCPOverrides,
    ownFilePaths: readonly string[],
    snapshot: ConfigSnapshot
  ): boolean {
    if (!current.authoritative || current.opaqueLegacyValue !== undefined) {
      return false;
    }
    const ownSource =
      current.sourceFile?.ownerWorkspaceId === workspaceId &&
      ownFilePaths.includes(current.sourceFile.filePath);
    if (isEmptyOverrides(normalized)) {
      // "Cleared" means no own document AND no legacy value (a leftover legacy
      // value would be honored on the next read).
      try {
        if (
          this.getLegacyOverridesFromConfig(workspaceId, snapshot.loadLegacyConfig()) !== undefined
        ) {
          return false;
        }
      } catch {
        return false;
      }
      // An own document holding only fields this build does not own is kept
      // by a clearing save (see readOpaqueOverrideFields), so it IS what that
      // save leaves behind; a recognized-empty (transparent) document is not
      // — the save removes it.
      return (
        !ownSource ||
        (current.sourceFile?.transparent !== true && isEmptyOverrides(current.overrides))
      );
    }
    // An own document shadows any legacy value on every read, so a legacy
    // value the previous attempt failed to clear does not make the state
    // different from what this save would leave behind (the retry clears it).
    return (
      ownSource &&
      computeOverridesRevision(current.overrides) === computeOverridesRevision(normalized)
    );
  }

  private async resolveOverridesFor(
    metadata: FrontendWorkspaceMetadata,
    mode: "lenient" | "strict",
    snapshot: ConfigSnapshot = new ConfigSnapshot(this.config),
    inheritanceDepth = 0
  ): Promise<ResolvedOverrides> {
    const workspaceId = metadata.id;
    const { runtime, workspacePath, hostFilesystem } = this.resolveWorkspace(metadata, snapshot);
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);
    const canonicalPath = filePaths[0];

    // Probe every candidate in parallel (one round trip on exec-backed remote
    // runtimes instead of four), then honor precedence in path order: probes
    // below the first confirmed file are irrelevant (a failing compatibility
    // path must not make a valid canonical document unreadable).
    // Inheritance requires every candidate path to be POSITIVELY absent: an
    // indeterminate probe (EACCES, transport hiccup) may hide a child file that
    // explicitly disables a server the parent enables, so it must keep the
    // pre-inheritance behavior (no overrides) rather than apply the parent's.
    const selected = selectProbedCandidate(
      await Promise.all(filePaths.map((filePath) => probeOverridesFile(runtime, filePath)))
    );
    if (selected.kind === "indeterminate" && mode === "strict") {
      throw selected.error;
    }
    // A blocked HIGHER-priority candidate may hide the real document, which
    // takes precedence over any visible one and may disable what it enables:
    // with precedence unestablished, serve NO overrides (fail closed) rather
    // than a lower-priority file's (selectProbedCandidate stops at the blocked
    // probe, so no file is read here).
    const allAbsent = selected.kind !== "indeterminate";
    // Own document that normalizes to nothing for this build (see below): it
    // still deserves to be the fork-copy source when no ancestor supplies one,
    // so its forward-compatible fields survive a fork made while downgraded.
    let emptyOwnDocument: ResolvedOverrides["sourceFile"];
    if (selected.kind === "file") {
      const filePath = filePaths[selected.index];
      // A document this build could not read authoritatively (lenient parse
      // errors) yields no overrides.
      const read = await this.readOverridesFile(runtime, filePath, mode);
      if (!read.authoritative) {
        return { overrides: {}, authoritative: false };
      }
      const overrides = normalizeWorkspaceMcpOverrides(read.parsed);
      // Non-empty, or a shape this build cannot vouch for as empty (see
      // isRecognizedOverridesDocument): the child's own document decides.
      if (!isEmptyOverrides(overrides) || !isRecognizedOverridesDocument(read.parsed)) {
        return {
          overrides,
          authoritative: true,
          sourceFile: {
            runtime,
            filePath,
            ownerWorkspaceId: workspaceId,
            workspacePath,
            hostFilesystem,
          },
        };
      }
      // A document that normalizes to NOTHING for this build (e.g. the plugin
      // uninstaller pruned its last key, leaving `{ "enabledServers": [] }`,
      // or only forward-compatible fields remain) is not a decision to detach
      // from the parent: resolve as if it were absent. The file itself stays,
      // so unknown fields survive for a later upgrade.
      emptyOwnDocument = {
        runtime,
        filePath,
        ownerWorkspaceId: workspaceId,
        workspacePath,
        hostFilesystem,
      };
    }
    // Only when the inherited result is empty too: pairing non-empty inherited
    // overrides (e.g. a parent's legacy value whose migration failed) with the
    // child's unrelated empty document would make a fork copy that document
    // and lose every inherited setting.
    const withOwnDocumentFallback = (resolved: ResolvedOverrides): ResolvedOverrides =>
      resolved.sourceFile === undefined &&
      emptyOwnDocument !== undefined &&
      isEmptyOverrides(resolved.overrides)
        ? { ...resolved, sourceFile: { ...emptyOwnDocument, transparent: true } }
        : resolved;

    // No workspace-local file => try migrating legacy config.json storage.
    let legacy: WorkspaceMCPOverrides | undefined;
    try {
      legacy = this.getLegacyOverridesFromConfig(workspaceId, snapshot.loadLegacyConfig());
    } catch (error) {
      if (mode === "strict") throw error;
      // Unknown whether this workspace owns a legacy value: neither inherit
      // nor let caches trust the (empty) result.
      log.warn("[MCP] Could not read legacy workspace MCP overrides; not inheriting", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return { overrides: {}, authoritative: false };
    }
    // Explicit presence check: `null` is an opaque VALUE (the config loader
    // preserves raw workspace fields), not absence.
    if (legacy !== undefined && !isRecognizedOverridesDocument(legacy)) {
      // A legacy value whose shape this build cannot read is the child's own
      // configuration, not noise — keep it in place and stop here; a hidden
      // file behind an indeterminate probe still makes the result a guess.
      return { overrides: {}, authoritative: allAbsent, opaqueLegacyValue: legacy };
    }
    if (legacy === undefined || isEmptyOverrides(legacy)) {
      if (!allAbsent) {
        log.debug("[MCP] Workspace override probe was indeterminate; not inheriting", {
          workspaceId,
        });
        return { overrides: {}, authoritative: false };
      }
      return withOwnDocumentFallback(
        await this.loadInheritedOverrides(metadata, mode, snapshot, inheritanceDepth)
      );
    }

    const normalizedLegacy = normalizeWorkspaceMcpOverrides(legacy);
    if (!allAbsent) {
      // A candidate file may exist behind the indeterminate probe: never
      // migrate over it, and never let caches trust the legacy value.
      return { overrides: normalizedLegacy, authoritative: false };
    }
    if (isEmptyOverrides(normalizedLegacy)) {
      // Structurally present but effectively empty legacy data (e.g. blank
      // names) is noise, not a decision: clear it so it stops shadowing the
      // parent chain, and resolve exactly as if it were absent. The clear is
      // a config MUTATION and follows the same rules as the migration write
      // below: only the workspace's own (depth 0) resolution may perform it,
      // never one whose owning operation already timed out (a late edit could
      // delete a `workspace.mcp` value another or older Xum process wrote
      // meanwhile), and it is tracked so settleSideEffects waits for it.
      if (inheritanceDepth === 0 && !snapshot.cancelled) {
        await snapshot
          .trackSideEffect(this.clearLegacyOverridesInConfig(workspaceId, { onlyIfEquals: legacy }))
          .catch((error: unknown) =>
            log.debug("[MCP] Failed to clear empty legacy workspace MCP overrides", {
              workspaceId,
              error: getErrorMessage(error),
            })
          );
      }
      return withOwnDocumentFallback(
        await this.loadInheritedOverrides(metadata, mode, snapshot, inheritanceDepth)
      );
    }

    // Inherited resolution (depth > 0) is READ-ONLY: a child's request must not
    // rewrite its parent's file outside the parent's own save path, where a
    // concurrent parent save could be clobbered by the stale legacy value.
    // Likewise never migrate OVER an existing document: one that normalizes to
    // nothing here may hold a newer build's fields (downgrade↔upgrade), and
    // the migration write would destroy them.
    if (inheritanceDepth > 0 || emptyOwnDocument !== undefined) {
      return { overrides: normalizedLegacy, authoritative: true };
    }
    if (snapshot.cancelled) {
      // The operation that owned this resolution timed out and released its
      // lock (or evicted): writing now could overwrite a newer settings save.
      // Honor the legacy value read-only; a later read migrates.
      log.debug("[MCP] Skipping legacy override migration: owning operation timed out", {
        workspaceId,
      });
      return { overrides: normalizedLegacy, authoritative: true };
    }
    const target = {
      workspaceId,
      legacy,
      normalizedLegacy,
      runtime,
      workspacePath,
      canonicalPath,
      filePaths,
      runtimeConfig: metadata.runtimeConfig,
    };
    const migrated = snapshot.writerLocksHeld
      ? await this.migrateLegacyOverrides(target, snapshot)
      : await this.migrateLegacyOverridesFenced(target, snapshot);

    return {
      overrides: normalizedLegacy,
      authoritative: true,
      // Only a file that was actually written can be copied raw.
      ...(migrated
        ? {
            sourceFile: {
              runtime,
              filePath: canonicalPath,
              ownerWorkspaceId: workspaceId,
              workspacePath,
              hostFilesystem,
            },
          }
        : {}),
    };
  }

  /**
   * An unlocked reader's migration (see ConfigSnapshot.writerLocksHeld):
   * takes the workspace and global write locks like every other writer of
   * the document — bounded, so a request never waits long behind a busy
   * writer (the value stays honored read-only; a later read migrates) — and
   * re-verifies under them that the legacy value is still the one observed
   * (a save meanwhile cleared or replaced it) and that no document exists at
   * any candidate path (a save meanwhile wrote one). Without this a read that
   * paused after observing the legacy enable could overwrite a disable a
   * save persisted meanwhile, and the epoch retry would then trust the
   * restored file.
   */
  private async migrateLegacyOverridesFenced(
    target: LegacyMigrationTarget,
    snapshot: ConfigSnapshot
  ): Promise<boolean> {
    try {
      return await this.withWorkspaceLocks(
        [target.workspaceId],
        (locked) =>
          this.runExclusive(
            async () => {
              if (locked.unresolvable.length > 0 || snapshot.cancelled) {
                return false;
              }
              // The target was captured before the locks. A rename that moved
              // the checkout meanwhile would otherwise be migrated into the OLD
              // path (recreating it) while the only legacy copy is cleared —
              // the renamed workspace silently loses its overrides. Migrate
              // only when a registry read taken under BOTH locks still names
              // the captured checkout (the lock derivation's view predates the
              // global lock wait).
              const registry = await this.config.getAllWorkspaceMetadata({
                throwOnError: true,
                probeCheckouts: false,
              });
              const current = registry.find((m) => m.id === target.workspaceId);
              if (
                current === undefined ||
                JSON.stringify(current.runtimeConfig) !== JSON.stringify(target.runtimeConfig) ||
                this.resolveWorkspace(current, snapshot).workspacePath !== target.workspacePath
              ) {
                return false;
              }
              const fresh = this.getLegacyOverridesFromConfig(
                target.workspaceId,
                this.config.loadConfigOrDefault({ throwOnError: true })
              );
              if (JSON.stringify(fresh) !== JSON.stringify(target.legacy)) {
                return false;
              }
              const selected = selectProbedCandidate(
                await Promise.all(
                  target.filePaths.map((filePath) => probeOverridesFile(target.runtime, filePath))
                )
              );
              if (selected.kind !== "absent") {
                return false;
              }
              return this.migrateLegacyOverrides(target, snapshot);
            },
            { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS }
          ),
        MIGRATION_LOCK_TIMEOUT_MS
      );
    } catch (error) {
      log.debug("[MCP] Skipping legacy override migration: write locks not acquired", {
        workspaceId: target.workspaceId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /** Migrate a legacy config.json value into the workspace file; the caller holds the write locks. Returns whether the document was written. */
  private async migrateLegacyOverrides(
    target: LegacyMigrationTarget,
    snapshot: ConfigSnapshot
  ): Promise<boolean> {
    const { workspaceId, legacy, normalizedLegacy, runtime, workspacePath, canonicalPath } = target;
    let migrated = false;
    try {
      // SECURITY: same containment as a dialog save (writeOverridesLocked). A
      // repo-tracked `.xum` symlink pointing at another checkout's `.xum`
      // would otherwise make this write — which follows links on EVERY
      // runtime, SSH included — plant the source's enabled-server override in
      // a sibling workspace. The shell probe covers exec-backed runtimes; the
      // host check adds realpath containment.
      const hostFilesystem = overridesOnHostFilesystem(target.runtimeConfig);
      await assertOverrideSegmentsNotSymlinked(runtime, workspacePath, hostFilesystem);
      // Tracked like the write below: a `mkdir -p` that outlives a bounded
      // owner's deadline is joined before its locks are released, or a
      // removal landing in between deletes the checkout and the late mkdir
      // recreates the `.xum` path as an orphan (same hazard as the fork copy's
      // directory step, see writeForkCopy).
      await snapshot.trackSideEffect(
        this.ensureOverridesDir(runtime, workspacePath, target.runtimeConfig)
      );
      if (hostFilesystem) {
        await assertHostOverrideWriteContained(canonicalPath, workspacePath);
      }
      if (snapshot.cancelled) {
        // Timed out during the directory step: the lock may be released
        // already, so the write below must not start (see trackSideEffect
        // for a write that had already started).
        log.debug("[MCP] Skipping legacy override migration: owning operation timed out", {
          workspaceId,
        });
        return false;
      }
      // The WHOLE mutation tail is one tracked side effect: a bounded owner
      // that times out joins it (settleSideEffects) before releasing its
      // locks, and a cancellation observed after the write still stops the
      // config clear — the one step that deletes state — so a late tail can
      // never remove a legacy value written under a later operation's lock.
      await snapshot.trackSideEffect(
        (async () => {
          const content = JSON.stringify(normalizedLegacy, null, 2) + "\n";
          await writeFileString(runtime, canonicalPath, content);
          // The document exists now: siblings must learn about it even if the
          // owner gave up meanwhile. Should the durable signal fail, the
          // document is rolled back — every later read would otherwise stop
          // at it and never retry the migration, leaving another backend's
          // pre-migration cache trusted for good. The legacy value is still
          // in place (cleared only below), so the next read migrates again.
          try {
            await this.bumpOverridesEpoch();
          } catch (error) {
            // Compare-and-delete of exactly the document this migration wrote:
            // never the compatibility paths, and never a canonical document an
            // older process or a direct edit replaced meanwhile.
            await this.removeExactDocument(runtime, workspacePath, canonicalPath, content).catch(
              (rollbackError: unknown) =>
                log.warn("[MCP] Could not roll back a legacy migration whose epoch signal failed", {
                  workspaceId,
                  error: getErrorMessage(rollbackError),
                })
            );
            throw error;
          }
          migrated = true;
          if (snapshot.cancelled) {
            log.debug(
              "[MCP] Legacy override migration wrote its document but skips the config clear: owning operation timed out",
              { workspaceId }
            );
            return;
          }
          await this.ensureOverridesGitignored(runtime, workspacePath, target.runtimeConfig);
          if (snapshot.cancelled) {
            return;
          }
          // Only the value that was migrated: a newer legacy value saved
          // meanwhile by an older process is left for a later read to migrate.
          await this.clearLegacyOverridesInConfig(workspaceId, { onlyIfEquals: legacy });
          log.info("[MCP] Migrated workspace MCP overrides from config.json", {
            workspaceId,
            filePath: canonicalPath,
          });
        })()
      );
    } catch (error) {
      // Migration is best-effort; if it fails, still honor legacy overrides.
      log.warn("[MCP] Failed to migrate workspace MCP overrides; using legacy config.json values", {
        workspaceId,
        error,
      });
    }
    return migrated;
  }

  /**
   * Sub-agent (task child) workspaces are fresh checkouts created from
   * committed state, so the parent's gitignored `.xum/mcp.local.jsonc` never
   * reaches them. Without inheritance, a server that is disabled in global
   * config and enabled only for the parent workspace is silently absent for
   * every sub-agent — and with it `tool_catalog_search`, which only exists
   * when MCP tools are present. Resolve through the parent chain (read-through,
   * no copy) so parent edits and plugin-uninstall prunes apply to children on
   * their next request. A child that saves its own overrides opts out; saving
   * empty overrides removes the file and resumes inheriting. Parent saves and
   * prunes re-publish inheriting descendants (see publishEffectiveOverrides).
   */
  private async loadInheritedOverrides(
    metadata: FrontendWorkspaceMetadata,
    mode: "lenient" | "strict",
    snapshot: ConfigSnapshot,
    inheritanceDepth: number
  ): Promise<ResolvedOverrides> {
    const parentWorkspaceId = metadata.parentWorkspaceId;
    if (parentWorkspaceId == null) {
      return { overrides: {}, authoritative: true };
    }
    // Parent links form a tree; a cycle would mean corrupted config.
    assert(
      inheritanceDepth < MAX_OVERRIDES_INHERITANCE_DEPTH,
      `Workspace MCP override inheritance exceeded ${MAX_OVERRIDES_INHERITANCE_DEPTH} levels for ${metadata.id}`
    );
    try {
      // A removed parent leaves nothing to inherit. Checked explicitly (in both
      // modes) so a strict prune re-read of an orphaned child does not fail —
      // and retry — forever on a parent that will never come back. The config
      // read must be authoritative (see ConfigSnapshot.loadAllMetadata): its
      // default empty fallback on a transient read failure is
      // indistinguishable from removal and would publish `{}` over the
      // parent's real settings.
      const all = await snapshot.loadAllMetadata();
      const parent = all.find((m) => m.id === parentWorkspaceId);
      if (parent === undefined) {
        return { overrides: {}, authoritative: true };
      }
      const inherited = await this.resolveOverridesFor(
        parent,
        mode,
        snapshot,
        inheritanceDepth + 1
      );
      return inherited.authoritative ? inherited : { ...inherited, authorityLostInherited: true };
    } catch (error) {
      if (mode === "strict") {
        throw error;
      }
      // An unreachable parent runtime must not fail the child's send.
      log.warn("[MCP] Failed to inherit parent workspace MCP overrides", {
        workspaceId: metadata.id,
        parentWorkspaceId,
        error: getErrorMessage(error),
      });
      return { overrides: {}, authoritative: false, authorityLostInherited: true };
    }
  }

  /**
   * Publish the written workspace's effective overrides, then re-publish every
   * other workspace the write affected so cached enablement in
   * MCPServerManager tracks it instead of going stale until a cold request:
   * - workspaces on the SAME runtime identity whose canonical override path IS
   *   the written file (an `isolation: "none"` task shares its parent's
   *   physical checkout, in either direction: a child save changes the
   *   parent's file too), and
   * - descendants that inherit (no file of their own) from any affected
   *   workspace, transitively. A descendant owning its own file cuts off its
   *   subtree: those grandchildren inherit from it, not from us.
   * A workspace whose state cannot be established authoritatively (checkout
   * unreachable) gets `null`: its cached snapshot is dropped, never replaced
   * with a guess, so recovery reads disk. Failures on other workspaces are
   * logged, never propagated — they must not fail the writer's save or keep a
   * prune tombstone alive.
   */
  private async publishEffectiveOverrides(
    workspaceId: string,
    own: WorkspaceMCPOverrides | null,
    publish: OverridesPublisher,
    /** Canonical override path the write landed on. */
    writtenPath: string,
    snapshot: ConfigSnapshot = new ConfigSnapshot(this.config),
    /**
     * Workspaces already published by this operation. A batch sweep shares
     * one set across every swept workspace so a subtree is traversed once
     * (from its topmost swept ancestor) rather than once per ancestor.
     */
    published = new Set<string>(),
    /** Shared by a batch sweep; a single save gets its own (see PublicationBudget). */
    budget: PublicationBudget = createPublicationBudget()
  ): Promise<void> {
    try {
      await this.publishEffectiveOverridesInner(
        workspaceId,
        own,
        publish,
        writtenPath,
        snapshot,
        published,
        budget
      );
    } finally {
      // Steps that timed out may still have a migration write in flight; the
      // caller releases the lock right after this returns, so wait for them
      // (they are the only writes this operation started). The lock's lease
      // renewal keeps the holder non-reclaimable meanwhile.
      await snapshot.settleSideEffects();
    }
  }

  /**
   * Workspaces registered on the SAME checkout as `written` (aliases: e.g. an
   * isolation:none task sharing its parent's directory). Sharing means the
   * same runtime identity (host/container: Docker reports `/src` for every
   * container and two SSH hosts can hold the same path) AND the same override
   * path on it — never the same project registration: two SSH registrations
   * under different projects but one host and checkout path mutate one remote
   * file, and omitting one would let its legacy `workspace.mcp` value migrate
   * back over the other's save. Host-local checkouts may be registered under
   * different spellings of one directory (symlinked project paths), so
   * realpaths are compared there. Candidates whose canonical path cannot be established are
   * reported separately (`indeterminate`): they may or may not share.
   * "unverifiable": the written checkout itself cannot be canonicalized.
   * "timeout": the bounded parallel scan exceeded `timeoutMs` (this runs
   * under the exclusive lock; stalled mounts must not hold every writer).
   */
  private async findCheckoutSharers(
    written: FrontendWorkspaceMetadata,
    writtenPath: string,
    all: readonly FrontendWorkspaceMetadata[],
    snapshot: ConfigSnapshot,
    timeoutMs: number,
    exclude: ReadonlySet<string>
  ): Promise<
    | { sharers: FrontendWorkspaceMetadata[]; indeterminate: FrontendWorkspaceMetadata[] }
    | "unverifiable"
    | "timeout"
  > {
    const writtenIdentity = runtimeFilesystemIdentity(written.runtimeConfig);
    if (writtenIdentity === undefined) {
      return { sharers: [], indeterminate: [] };
    }
    const canonicalWritten = await snapshot.canonicalize(writtenIdentity, writtenPath);
    if (canonicalWritten === undefined) {
      return "unverifiable";
    }
    const candidates: Array<{ metadata: FrontendWorkspaceMetadata; path: string }> = [];
    // SSH `host` may be an ssh_config alias: two aliases can name one machine,
    // and nothing here resolves them. A registration on another SSH identity
    // with the SAME remote path may therefore share the checkout — it is
    // reported indeterminate (never a sharer, never excluded), so a save
    // while it carries a legacy value is refused rather than leaving a stale
    // value to migrate back over the user's write. Self-healing: reading
    // that workspace once migrates its value away.
    const possibleAliases: FrontendWorkspaceMetadata[] = [];
    for (const m of all) {
      if (m.id === written.id || exclude.has(m.id)) continue;
      const identity = runtimeFilesystemIdentity(m.runtimeConfig);
      if (identity !== writtenIdentity) {
        if (
          written.runtimeConfig.type === "ssh" &&
          m.runtimeConfig.type === "ssh" &&
          this.canonicalOverridesPathFor(m) === writtenPath
        ) {
          possibleAliases.push(m);
        }
        continue;
      }
      const candidate = this.canonicalOverridesPathFor(m);
      if (candidate !== undefined) candidates.push({ metadata: m, path: candidate });
    }
    // Canonicalize in bounded parallel, not serially: every stalled-filesystem
    // candidate can burn two realpath timeouts, so hundreds of dead NFS
    // checkouts would otherwise hold every later writer for minutes.
    let canonical: Array<string | undefined>;
    try {
      canonical = await withDeadline(
        mapWithConcurrency(candidates, CANONICALIZE_CONCURRENCY, (candidate) =>
          snapshot.canonicalize(writtenIdentity, candidate.path)
        ),
        timeoutMs,
        "sharer scan exceeded its budget"
      );
    } catch {
      return "timeout";
    }
    const sharers: FrontendWorkspaceMetadata[] = [];
    const indeterminate: FrontendWorkspaceMetadata[] = [...possibleAliases];
    for (const [index, candidate] of candidates.entries()) {
      const canonicalCandidate = canonical[index];
      if (canonicalCandidate === undefined) indeterminate.push(candidate.metadata);
      else if (canonicalCandidate === canonicalWritten) sharers.push(candidate.metadata);
    }
    return { sharers, indeterminate };
  }

  private async publishEffectiveOverridesInner(
    workspaceId: string,
    own: WorkspaceMCPOverrides | null,
    publish: OverridesPublisher,
    writtenPath: string,
    snapshot: ConfigSnapshot,
    published: Set<string>,
    // One budget for the WHOLE fan-out (own publication, sharer scan, every
    // level): each probe is bounded, but thousands of candidates on stalled
    // mounts would still add up under the exclusive lock past its acquisition
    // timeout (and the stale lease). When the budget runs out nothing below
    // can be published authoritatively: evict every cache instead, and let
    // the abandoned work's cancellation flags keep it from publishing later.
    budget: PublicationBudget
  ): Promise<void> {
    // The publisher callback itself (MCPServerManager.applyWorkspaceOverrides)
    // repairs cached enablement through listServers, which reads the
    // project's MCP config — a disconnected project filesystem would hold the
    // override lock indefinitely. Bound every publication too; on timeout (or
    // failure) evict the target instead: eviction is a synchronous marker,
    // the target's next serve re-reads, and the abandoned repair completes
    // harmlessly with the same overrides later.
    const publishBounded = async (
      persisted: WorkspaceMCPOverrides,
      target: string,
      timeoutMs: number
    ): Promise<void> => {
      try {
        await withDeadline(
          publish(persisted, target),
          timeoutMs,
          `override publication to workspace ${target} timed out`
        );
      } catch (error) {
        log.warn("[MCP] Override publication did not complete; evicting the target's cache", {
          workspaceId,
          target,
          error: getErrorMessage(error),
        });
        await publish(null, target);
      }
    };
    if (own === null) {
      await publish(null, workspaceId);
    } else {
      await publishBounded(own, workspaceId, budget.remaining());
    }
    // When the authoritative enumeration fails there is no descendant to
    // evict individually: drop every cache instead.
    let all: FrontendWorkspaceMetadata[];
    try {
      // Under the budget like every other step held under the lock: the
      // enumeration is registry-only (no per-checkout probes), but its
      // read-time migration replay goes through the config queue.
      all = await withDeadline(
        snapshot.loadAllMetadata(),
        budget.remaining(),
        "workspace enumeration exceeded the publication budget"
      );
    } catch (error) {
      // The lenient fallback can be EMPTY after the same failure, leaving no
      // descendant to evict individually: drop every cache instead.
      log.warn("[MCP] Workspace enumeration failed during override publication; evicting all", {
        workspaceId,
        error: getErrorMessage(error),
      });
      snapshot.cancel();
      await publish(null, ALL_WORKSPACES_TARGET);
      return;
    }
    const written = all.find((m) => m.id === workspaceId);
    published.add(workspaceId);
    const evictAll = async (reason: string): Promise<void> => {
      log.warn(`[MCP] Override publication ${reason}; evicting all cached overrides`, {
        workspaceId,
      });
      snapshot.cancel();
      await publish(null, ALL_WORKSPACES_TARGET);
    };
    // Index once: scanning `all` per visited node made publication
    // O(total × affected) under the exclusive lock.
    const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
    for (const m of all) {
      if (m.parentWorkspaceId == null) continue;
      const siblings = childrenByParent.get(m.parentWorkspaceId);
      if (siblings) siblings.push(m);
      else childrenByParent.set(m.parentWorkspaceId, [m]);
    }
    const childrenOf = (id: string) =>
      (childrenByParent.get(id) ?? []).filter((m) => !published.has(m.id));
    let sharers: FrontendWorkspaceMetadata[] = [];
    // Candidates whose canonical path could not be established: they may or
    // may not share the written checkout, so their caches (and subtrees) are
    // evicted rather than left possibly stale.
    let indeterminateSharers: FrontendWorkspaceMetadata[] = [];
    if (written) {
      const scan = await this.findCheckoutSharers(
        written,
        writtenPath,
        all,
        snapshot,
        budget.remaining(),
        published
      );
      if (scan === "unverifiable") {
        // Nothing can be compared against: no sharer can be told apart from a
        // non-sharer, so no cache below can be trusted.
        await evictAll("could not canonicalize the written checkout");
        return;
      }
      if (scan === "timeout") {
        await evictAll("could not finish its sharer scan in time");
        return;
      }
      sharers = scan.sharers;
      indeterminateSharers = scan.indeterminate;
    }
    // "refresh": re-resolve and publish (or evict when not authoritative).
    // "evict": an ancestor between this node and the write was indeterminate,
    // so nothing below it can be resolved authoritatively — drop caches all the
    // way down instead of leaving a stale inherited snapshot on a reachable
    // grandchild.
    interface Step {
      metadata: FrontendWorkspaceMetadata;
      shares: boolean;
      action: "refresh" | "evict";
    }
    let level: Step[] = [
      ...sharers.map((metadata): Step => ({ metadata, shares: true, action: "refresh" })),
      ...indeterminateSharers.map(
        (metadata): Step => ({ metadata, shares: true, action: "evict" })
      ),
      ...childrenOf(workspaceId).map(
        (metadata): Step => ({ metadata, shares: false, action: "refresh" })
      ),
    ];
    // Each descendant's ownership probe and resolution can exec remote `stat`s
    // with a 10 s timeout, and this runs under the exclusive override lock: a
    // large or slow task tree processed serially would hold every later writer
    // past its lock-acquisition timeout. Publish one breadth level at a time
    // (parents before children, so a child's inherited state is final) with
    // bounded parallelism inside the level.
    while (level.length > 0) {
      if (budget.exhausted()) {
        await evictAll("exceeded its budget before finishing the descendant fan-out");
        return;
      }
      // Dedupe within a level: the same child can be reached as a sharer's
      // child and as ours. `published` is only extended after the level runs,
      // so the check below cannot race a sibling worker.
      const seen = new Set<string>();
      const steps = level.filter((step) => {
        if (published.has(step.metadata.id) || seen.has(step.metadata.id)) return false;
        seen.add(step.metadata.id);
        return true;
      });
      const nextLevel = await mapWithConcurrency(
        steps,
        PUBLICATION_CONCURRENCY,
        async (next): Promise<Step[]> => {
          const child = next.metadata;
          try {
            let action = next.action;
            // Off-host workspaces would need remote `stat`s (10 s timeout each
            // level) while the write lock is held; a slow chain could exceed
            // the lock's acquisition and stale bounds. Evict them (and their
            // subtree) without I/O — their next serve re-reads on their own
            // runtime.
            if (!isHostLocalRuntimeConfig(child.runtimeConfig)) {
              action = "evict";
            } else {
              // Host filesystem I/O can stall too (see HOST_DESCENDANT_TIMEOUT_MS);
              // a timeout is handled like an indeterminate probe: evict. The
              // step's own snapshot scope is cancelled on timeout so the
              // abandoned work performs no migration write or publication.
              const step = snapshot.scoped();
              const deadline = <T>(work: Promise<T>) =>
                withDeadline(
                  work,
                  Math.min(HOST_DESCENDANT_TIMEOUT_MS, budget.remaining()),
                  `workspace ${child.id} checkout did not respond`,
                  () => step.cancel()
                );
              try {
                if (!next.shares) {
                  const ownership = await deadline(this.probeOwnOverrides(child, step));
                  // Owns a file: unaffected, and so is its subtree (it inherits from the owner).
                  if (ownership === "own") return [];
                  if (ownership === "indeterminate") action = "evict";
                }
                if (action === "refresh") {
                  const resolved = await deadline(this.resolveOverridesFor(child, "lenient", step));
                  if (!resolved.authoritative || step.cancelled) action = "evict";
                  else {
                    await publishBounded(
                      resolved.overrides,
                      child.id,
                      Math.min(HOST_DESCENDANT_TIMEOUT_MS, budget.remaining())
                    );
                  }
                }
              } catch (error) {
                log.warn("[MCP] Evicting an affected workspace whose checkout did not respond", {
                  workspaceId,
                  affectedWorkspaceId: child.id,
                  error: getErrorMessage(error),
                });
                action = "evict";
              }
            }
            if (action === "evict") {
              await publish(null, child.id);
            }
            return childrenOf(child.id).map(
              (metadata): Step => ({ metadata, shares: false, action })
            );
          } catch (error) {
            log.warn("[MCP] Failed to re-publish overrides to an affected workspace", {
              workspaceId,
              affectedWorkspaceId: child.id,
              error: getErrorMessage(error),
            });
            return [];
          }
        }
      );
      for (const step of steps) published.add(step.metadata.id);
      level = nextLevel.flat();
    }
  }

  private canonicalOverridesPathFor(metadata: FrontendWorkspaceMetadata): string | undefined {
    try {
      const { workspacePath } = this.resolveWorkspace(metadata);
      return this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig)[0];
    } catch {
      return undefined;
    }
  }

  /** Whether a workspace resolves overrides from its own storage rather than a parent. */
  private async probeOwnOverrides(
    metadata: FrontendWorkspaceMetadata,
    snapshot: ConfigSnapshot
  ): Promise<"own" | "inherits" | "indeterminate"> {
    // Same normalization as resolveOverridesFor: legacy noise that normalizes
    // to nothing does not make the workspace an owner.
    let legacy: WorkspaceMCPOverrides | undefined;
    try {
      legacy = this.getLegacyOverridesFromConfig(metadata.id, snapshot.loadLegacyConfig());
    } catch {
      return "indeterminate";
    }
    if (
      legacy !== undefined &&
      (!isRecognizedOverridesDocument(legacy) ||
        !isEmptyOverrides(normalizeWorkspaceMcpOverrides(legacy)))
    ) {
      return "own";
    }
    const { runtime, workspacePath } = this.resolveWorkspace(metadata);
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);
    const selected = selectProbedCandidate(
      await Promise.all(filePaths.map((filePath) => probeOverridesFile(runtime, filePath)))
    );
    if (selected.kind === "indeterminate") return "indeterminate";
    if (selected.kind === "absent") return "inherits";
    // Same rule as resolveOverridesFor: a document that normalizes to nothing
    // does not detach the workspace from its parent.
    const read = await this.readOverridesFile(runtime, filePaths[selected.index], "lenient");
    if (!read.authoritative) return "indeterminate";
    return isEmptyOverrides(normalizeWorkspaceMcpOverrides(read.parsed)) &&
      isRecognizedOverridesDocument(read.parsed)
      ? "inherits"
      : "own";
  }

  /**
   * SECURITY: the fork target is a fresh checkout of repository-controlled
   * content. A tracked symlink at `.xum` or `.xum/mcp.local.jsonc` would make
   * the write below (which follows links on every runtime) land OUTSIDE the
   * checkout, and a tracked regular file at that path is repo content this
   * automatic copy must not clobber (the registration-time sanitizer handles
   * it). Both are refused; the fork simply proceeds without the copy. The
   * checkout root itself is trusted, so the two repo-controlled segments are
   * the whole surface. Shell `test` keeps this uniform across host-local and
   * exec-backed remote runtimes (mirrors removeOverridesFile).
   */
  private async isForkCopyTargetWritable(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string
  ): Promise<boolean> {
    const relativeFile = MCP_OVERRIDES_GITIGNORE_PATTERNS[0];
    const relativeDir = relativeFile.split("/")[0];
    assert(relativeDir.length > 0 && relativeDir !== relativeFile, "canonical override path shape");
    const guard = await execBuffered(
      runtime,
      `test ! -L "${relativeDir}" && test ! -L "${relativeFile}" && test ! -e "${relativeFile}"`,
      { cwd: workspacePath, timeout: 10 }
    );
    if (guard.exitCode === 0) {
      return true;
    }
    log.warn(
      "[MCP] Not copying workspace MCP overrides into fork: target path is a symlink or already tracked",
      { workspacePath, relativeFile }
    );
    return false;
  }

  /**
   * Fork-time copy of the source workspace's overrides into the new checkout.
   *
   * Forks are independent workspaces (the source may later be archived or
   * removed), so unlike sub-agents they get a snapshot rather than a
   * read-through link. The target is not registered in config yet when
   * WorkspaceService.fork calls this, hence the explicit runtime/path. Runs
   * BEFORE the fork's plugin-override sanitization so stale `plugin:` enables
   * are pruned exactly like a tracked file would be. Best-effort: a failed
   * copy must never fail the fork.
   *
   * Lock scope: resolving the source at depth 0 may MIGRATE its legacy
   * config.json value into the source file — outside the lock, a concurrent
   * settings save could land between the legacy read and the migration write
   * and be overwritten by the stale legacy value — and the raw document read
   * must see a complete write. Only those two steps take the exclusive lock.
   * Migration is possible only when the source still has a recognized,
   * non-empty legacy value (nothing creates legacy values at runtime), and a
   * source with one never traverses its inheritance chain; otherwise the
   * resolution is read-only and runs OUTSIDE the lock, because an inheriting
   * SSH source probes one round of remote paths per ancestor level and holding
   * the global lock through that would stall every unrelated save/prune past
   * the acquisition timeout (or the stale lease).
   */
  async copyOverridesToForkedCheckout(
    sourceWorkspaceId: string,
    target: {
      runtime: ReturnType<typeof createRuntime>;
      workspacePath: string;
      runtimeConfig: RuntimeConfig | undefined;
    }
  ): Promise<void> {
    assert(target.workspacePath.length > 0, "fork target workspacePath is required");
    const deadlineAt = Date.now() + FORK_COPY_TIMEOUT_MS;
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    try {
      // The target side never takes the lock: it is not registered yet, so no
      // settings writer contends with it, and its I/O may run against a slow
      // remote runtime.
      // Under the lock everything is re-derived from a FRESH config snapshot:
      // the pre-lock legacy value / metadata may have been cleared, renamed
      // or reparented by a save or rename that completed before we acquired
      // the lock, and resolving from the stale snapshot would migrate a
      // revoked legacy enable back into the source (and the fork).
      // The hold deadline applies INSIDE the locked callback, so it bounds
      // the lock HOLD time (a stalled NFS/FUSE checkout releases the lock
      // after the budget and the copy is abandoned); the acquisition itself
      // gives up at the operation's deadline, so a queued preparation the
      // fork stopped waiting for never acquires and holds the lock later.
      const underLock = async () => {
        // The held path may WRITE into the source checkout (legacy migration /
        // opaque-value materialization), so it takes the source's workspace
        // lock first like every other writer of that document.
        const outcome = await this.withWorkspaceLocks(
          [sourceWorkspaceId],
          (lockedKeys) =>
            this.runExclusive(
              async () => {
                const unresolvable = lockedKeys.unresolvable[0];
                if (unresolvable !== undefined) {
                  throw unresolvable.error;
                }
                const locked = new ConfigSnapshot(
                  this.config,
                  /* hostFilesystemView */ true,
                  undefined,
                  /* writerLocksHeld */ true
                );
                try {
                  return await withDeadline(
                    (async () => {
                      const lockedSource = await this.getRuntimeAndWorkspacePath(
                        sourceWorkspaceId,
                        locked
                      );
                      return this.prepareForkCopySource(
                        sourceWorkspaceId,
                        lockedSource,
                        target,
                        locked,
                        "held"
                      );
                    })(),
                    Math.min(FORK_COPY_LOCKED_TIMEOUT_MS, remainingMs()),
                    "locked fork-copy preparation timed out",
                    // The abandoned resolution must not START a migration write
                    // after the lock is released (it could overwrite a newer save).
                    () => locked.cancel()
                  );
                } finally {
                  // …and a write that had already started keeps the lock until it
                  // settles: it cannot be cancelled, and landing it under the
                  // released lock could clobber a newer save. Holding is safe for
                  // as long as it takes: the cross-process lock re-stamps its lease
                  // while held (acquireCrossProcessLock's renewal), so a live
                  // holder waiting on a stalled write never becomes reclaimable —
                  // only a crashed process (which cannot complete the write) does.
                  await locked.settleSideEffects();
                }
              },
              { timeoutMs: remainingMs() }
            ),
          remainingMs()
        );
        assert(outcome !== "stale", "a locked fork-copy preparation cannot go stale");
        return outcome;
      };
      // A save that lands between the unlocked resolution and the locked
      // document read can change WHICH document is effective (a child-owned
      // file appearing over the ancestor's, a removal, a cleared legacy value
      // along the chain): the override epoch moves with every completed
      // write, so a preparation is committed only if the epoch under the lock
      // still matches the one read before resolving. Every attempt starts
      // from its own epoch read and a config snapshot built AFTER it (nothing
      // memoized survives a retry, or a cleared ancestor legacy enable would
      // be serialized into the fork on the next attempt). Retry a few times
      // against a busy writer, then fall back to resolving under the lock
      // rather than copying a stale snapshot.
      let prepared: ForkCopySource | undefined;
      for (let attempt = 0; attempt < FORK_COPY_ATTEMPTS && remainingMs() > 0; attempt++) {
        // Every step draws on the operation's deadline, this home-filesystem
        // read included: a stalled home must not hold the fork here forever.
        const epochBefore = await withDeadline(
          readWorkspaceOverridesEpochToken(this.coordinationRootDir),
          Math.max(1, remainingMs()),
          "fork-copy epoch read timed out"
        );
        const snapshot = new ConfigSnapshot(this.config, /* hostFilesystemView */ true);
        // The whole attempt — source metadata lookup included — draws on the
        // operation's single deadline (see the free-path bound below); the
        // lookup enumerates the registry, so it belongs inside it.
        const attemptBudget = () => Math.max(1, remainingMs());
        let source: ResolvedWorkspace;
        try {
          source = await withDeadline(
            this.getRuntimeAndWorkspacePath(sourceWorkspaceId, snapshot),
            attemptBudget(),
            "fork source metadata did not resolve in time",
            () => snapshot.cancel()
          );
        } catch (error) {
          log.warn("[MCP] Not copying workspace MCP overrides into fork: preparation timed out", {
            sourceWorkspaceId,
            error: getErrorMessage(error),
          });
          break;
        }
        const legacy = this.getLegacyOverridesFromConfig(
          sourceWorkspaceId,
          snapshot.loadLegacyConfig()
        );
        // A recognized non-empty legacy value migrates into the source file;
        // an opaque one is materialized there when the fork shares the
        // checkout (see prepareForkCopySource). Both write the source's own
        // document, so both need the lock.
        const mayMigrate =
          legacy !== undefined &&
          (!isRecognizedOverridesDocument(legacy) ||
            !isEmptyOverrides(normalizeWorkspaceMcpOverrides(legacy)));
        if (mayMigrate) {
          prepared = await underLock();
          break;
        }
        // The unlocked resolution has no deadline of its own: host stats on
        // a stalled filesystem can wait indefinitely and a deep SSH chain pays
        // one remote probe round per ancestor. The fork awaits this before
        // init/registration, so bound the whole attempt; the snapshot is
        // cancelled so abandoned work starts no side effect later.
        let outcome: ForkCopySource | undefined | "stale";
        try {
          outcome = await withDeadline(
            this.prepareForkCopySource(
              sourceWorkspaceId,
              source,
              target,
              snapshot,
              "free",
              epochBefore,
              remainingMs
            ),
            attemptBudget(),
            "fork source did not respond in time",
            () => snapshot.cancel()
          );
        } catch (error) {
          log.warn("[MCP] Not copying workspace MCP overrides into fork: preparation timed out", {
            sourceWorkspaceId,
            error: getErrorMessage(error),
          });
          break;
        }
        if (outcome !== "stale") {
          prepared = outcome;
          break;
        }
        if (attempt === FORK_COPY_ATTEMPTS - 1) {
          // Every attempt was invalidated by concurrent writes/renames (or the
          // epoch is persistently unreadable). Resolving under the lock is the
          // only way to pin the state — affordable for a host-local chain
          // (fast filesystem probes), but an inheriting SSH chain would hold
          // the global lock through one remote probe round per ancestor
          // level; there, give up on the best-effort copy instead.
          if (await this.forkSourceChainIsHostLocal(source.metadata, snapshot)) {
            // Host filesystem I/O has no timeout of its own (a disconnected
            // NFS/FUSE checkout would hold the lock indefinitely): the locked
            // preparation is bounded (see underLock) and the best-effort copy
            // abandoned on timeout.
            try {
              prepared = await underLock();
            } catch (error) {
              log.warn(
                "[MCP] Not copying workspace MCP overrides into fork: preparation timed out",
                {
                  sourceWorkspaceId,
                  error: getErrorMessage(error),
                }
              );
            }
          } else {
            log.warn(
              "[MCP] Not copying workspace MCP overrides into fork: source kept changing during preparation",
              { sourceWorkspaceId, attempts: FORK_COPY_ATTEMPTS }
            );
          }
        }
      }
      if (prepared !== undefined) {
        // Cooperative cancellation: on timeout no further target step starts
        // (the fork goes on to init and registration, after which a late write
        // could overwrite settings the init hook or the user created). A write
        // already in flight cannot be cancelled and would land at an unknown
        // later time, so it is joined instead (together with its git exclude)
        // — the only case in which the bound is exceeded, and only for as long
        // as that unit takes.
        const progress: ForkCopyProgress = { cancelled: false };
        try {
          await withDeadline(
            this.writeForkCopy(sourceWorkspaceId, target, prepared, progress),
            Math.max(1, remainingMs()),
            "fork target did not respond in time; skipping the workspace MCP overrides copy",
            () => {
              progress.cancelled = true;
            }
          );
        } catch (error) {
          if (progress.mutation !== undefined) {
            await progress.mutation.catch(() => undefined);
          }
          throw error;
        }
      }
    } catch (error) {
      log.warn("[MCP] Failed to copy workspace MCP overrides into forked workspace", {
        sourceWorkspaceId,
        targetWorkspacePath: target.workspacePath,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Resolve the source and capture the document to copy. `lock` says whether
   * the caller already holds the override lock ("held": migration possible,
   * everything runs inside it) or not ("free": read-only resolution; only the
   * raw document read below takes the lock — so it cannot observe a torn
   * concurrent save — and returns "stale" when the override epoch no longer
   * matches `epochBefore`, i.e. a write completed since the resolution).
   */
  private async prepareForkCopySource(
    sourceWorkspaceId: string,
    source: ResolvedWorkspace,
    target: {
      runtime: ReturnType<typeof createRuntime>;
      workspacePath: string;
      runtimeConfig: RuntimeConfig | undefined;
    },
    snapshot: ConfigSnapshot,
    lock: "held" | "free",
    epochBefore?: string,
    /** Remaining budget of the whole copy operation ("free" only): bounds the commit section's lock wait and hold. */
    remainingMs?: () => number
  ): Promise<ForkCopySource | undefined | "stale"> {
    // Resolve the source's EFFECTIVE overrides first: this migrates legacy
    // config.json storage into the source file (so a shared-checkout fork
    // finds it there) and resolves a sub-agent source's inherited state.
    const resolved = await this.resolveOverridesFor(source.metadata, "lenient", snapshot);
    if (!resolved.authoritative) {
      // A hidden higher-priority document (indeterminate probe) may disable
      // what the readable one enables; a snapshot of a guess must not
      // become the fork's persistent configuration.
      log.warn(
        "[MCP] Not copying workspace MCP overrides into fork: source state is not authoritative",
        { sourceWorkspaceId }
      );
      return;
    }
    const effective = resolved.overrides;
    const sourcePaths = this.getOverridesFilePaths(
      source.workspacePath,
      source.metadata.runtimeConfig
    );
    const targetPath = this.getOverridesFilePaths(target.workspacePath, target.runtimeConfig)[0];
    // Project-dir (`local` runtime) forks share the source checkout, so the
    // file is already in place. Only that runtime shares storage: Docker
    // reports `/src` for every container, so equal paths there still need
    // the copy.
    if (
      targetPath === sourcePaths[0] &&
      source.metadata.runtimeConfig.type === "local" &&
      target.runtimeConfig?.type === "local"
    ) {
      if (resolved.opaqueLegacyValue !== undefined) {
        // The source's only configuration is a legacy value this build cannot
        // read, kept in its ID-scoped config entry (resolveOverridesFor never
        // migrates it). The fork gets a NEW id, so the shared checkout is the
        // only place it can reach the value from: materialize it into the
        // shared file (the source keeps resolving identically — the document
        // is child-owned and normalizes to nothing for this build, exactly
        // like the legacy value did). Writing the source's own document needs
        // the lock; the unlocked path defers to the locked fallback.
        if (lock === "free") {
          return "stale";
        }
        if (snapshot.cancelled) {
          return;
        }
        await this.ensureOverridesDir(
          source.runtime,
          source.workspacePath,
          source.metadata.runtimeConfig
        );
        // SECURITY: this automatic write lands in the SOURCE checkout, whose
        // repository content can track `.xum` (or the file) as a symlink;
        // refuse to write through one (same hardening as the other override
        // mutations). Both runtimes are `local` here (checked above).
        await assertHostOverrideWriteContained(targetPath, source.workspacePath);
        if (snapshot.cancelled) {
          return;
        }
        await snapshot.trackSideEffect(
          writeFileString(
            source.runtime,
            targetPath,
            JSON.stringify(resolved.opaqueLegacyValue, null, 2) + "\n"
          )
        );
        await this.bumpOverridesEpoch();
        await this.ensureOverridesGitignored(
          source.runtime,
          source.workspacePath,
          source.metadata.runtimeConfig
        );
        log.info(
          "[MCP] Materialized an opaque legacy workspace MCP override value for a shared-checkout fork",
          {
            sourceWorkspaceId,
            filePath: targetPath,
          }
        );
      }
      return;
    }
    // Copy the raw document that actually supplied the overrides — the
    // source's own file, or the ancestor's when the source is an inheriting
    // sub-agent — even when it normalizes to nothing for THIS build: a
    // wholesale rewrite of the normalized shape would drop comments and
    // forward-compatible fields written by a newer release (upgrade↔downgrade
    // rule). Fall back to the normalized effective value only when no
    // document exists anywhere along the chain (legacy migration failed).
    let content: string | undefined;
    const sourceFile = resolved.sourceFile;
    // SECURITY: the source document is copied RAW into the fork's checkout,
    // where the repo's own init hook can read it. A repo-tracked symlink at
    // the source path (`.mux/mcp.local.jsonc -> ../../../../providers.jsonc`)
    // would make this read exfiltrate a host file — the devcontainer host
    // view reads host files by design — into the target. Refuse symlinked
    // segments on every runtime, and require host paths to resolve inside
    // the source checkout, before reading.
    const readDocument = () =>
      sourceFile === undefined
        ? undefined
        : (async () => {
            await assertOverrideSegmentsNotSymlinked(
              sourceFile.runtime,
              sourceFile.workspacePath,
              sourceFile.hostFilesystem
            );
            if (sourceFile.hostFilesystem) {
              await assertHostOverrideWriteContained(sourceFile.filePath, sourceFile.workspacePath);
              // The guards above are point-in-time; the read itself must not
              // follow a symlink swapped in meanwhile.
              return readHostOverrideDocumentNoFollow(
                sourceFile.filePath,
                sourceFile.workspacePath
              );
            }
            return readFileString(sourceFile.runtime, sourceFile.filePath);
          })();
    if (lock === "free") {
      // Commit point: under the lock, no write is in flight; an epoch that
      // moved (or cannot be read) means the resolution above may name the
      // wrong document.
      // The whole locked commit section is bounded: a slow or unreachable
      // SSH source document (RemoteRuntime.readFile allows minutes) must not
      // hold the lock past other writers' acquisition timeout. This section
      // only READS, so releasing on timeout is safe; the attempt is stale.
      assert(remainingMs !== undefined, "a free fork-copy preparation carries the copy budget");
      // The lock wait is bounded too: an attempt the caller already abandoned
      // must not acquire the lock later and hold it for a read nobody uses.
      const outcome = await this.runExclusive(
        () =>
          withDeadline(
            this.commitForkCopySource(source, resolved, snapshot, epochBefore, readDocument),
            Math.min(FORK_COPY_LOCKED_TIMEOUT_MS, Math.max(1, remainingMs())),
            "fork-copy commit section timed out"
          ).catch(() => "stale" as const),
        { timeoutMs: remainingMs() }
      ).catch(() => "stale" as const);
      if (outcome === "stale") {
        return "stale";
      }
      content = outcome.content;
    } else if (sourceFile !== undefined) {
      try {
        content = await readDocument();
      } catch (error) {
        return this.skipUnreadableSourceDocument(sourceWorkspaceId, error);
      }
    }
    if (content === undefined && resolved.opaqueLegacyValue !== undefined) {
      // The source's only configuration is a legacy value this build cannot
      // read: still carry it, or the independent fork loses it for good.
      content = JSON.stringify(resolved.opaqueLegacyValue, null, 2) + "\n";
    }
    if (content === undefined) {
      if (isEmptyOverrides(effective)) {
        return;
      }
      content = JSON.stringify(effective, null, 2) + "\n";
    }
    return this.finishForkCopySource(sourceWorkspaceId, content, targetPath);
  }

  /**
   * Locked commit point of the unlocked fork-copy path (see
   * prepareForkCopySource): verifies that nothing the resolution depended on
   * changed, and reads the selected document verbatim. Read-only.
   */
  private async commitForkCopySource(
    source: ResolvedWorkspace,
    resolved: ResolvedOverrides,
    snapshot: ConfigSnapshot,
    epochBefore: string | undefined,
    readDocument: () => Promise<string> | undefined
  ): Promise<{ content: string | undefined } | "stale"> {
    const epochNow = await readWorkspaceOverridesEpochToken(this.coordinationRootDir);
    if (epochNow !== epochBefore || isWorkspaceOverridesEpochUnreadable(epochNow)) {
      return "stale" as const;
    }
    // Renames/reparents rewrite config under this same lock but bump no
    // epoch: the resolution above may have read documents at now-vacated
    // paths (its own or an ancestor's). Compare the config the resolution
    // used with the one visible now; any difference along the chain is a
    // stale resolution.
    if (!(await this.forkSourceChainUnchanged(source.metadata, snapshot))) {
      return "stale" as const;
    }
    let read: string | undefined;
    try {
      read = await readDocument();
    } catch {
      // The document the unlocked resolution just read is now unreadable: a
      // rename that completed before this lock was acquired vacated the path
      // (its config rewrite is compared above, but the resolution may have
      // read the old path), or the file was removed by a direct edit. Treat
      // it as stale and re-resolve against the current config rather than
      // silently dropping the fork's snapshot.
      return "stale" as const;
    }
    // …and the same rename may have landed after the read: re-check.
    if (!(await this.forkSourceChainUnchanged(source.metadata, snapshot))) {
      return "stale" as const;
    }
    // Direct edits leave no trace in epoch or config: verify that no
    // lower level acquired its own document since the resolution…
    if (!(await this.forkSourcePrecedenceUnchanged(source.metadata, resolved, snapshot))) {
      return "stale" as const;
    }
    // …and that the selected document itself did not change while those
    // probes ran (a direct edit of the owner's file)…
    let reread: string | undefined;
    try {
      reread = await readDocument();
    } catch {
      return "stale" as const;
    }
    if (reread !== read) {
      return "stale" as const;
    }
    // …and, AFTER the content was confirmed, that precedence still holds. A
    // child-owned document created between the first probe round and the
    // re-read above is invisible to the re-read (the ancestor document it
    // shadows is unchanged), so a probe on only one side of the content
    // check would let the fork copy an ancestor enable the source itself
    // now overrides. Bracketing the content check with probes on both
    // sides makes the copy a consistent snapshot: precedence and content
    // observed in one window with nothing changing in between.
    if (!(await this.forkSourcePrecedenceUnchanged(source.metadata, resolved, snapshot))) {
      return "stale" as const;
    }
    return { content: read };
  }

  /** Plugin-key stripping and the final consent scan shared by both fork paths. */
  private finishForkCopySource(
    sourceWorkspaceId: string,
    content: string,
    targetPath: string
  ): ForkCopySource | undefined {
    // Strip Agent Plugin enables NOW rather than relying on the fork's later
    // registration-time sanitization: the init hook starts right after this
    // copy and could rewrite the file behind the sanitizer, letting a copied
    // default-disabled plugin enable start on the fork's first request
    // without fresh consent. A fresh checkout has no live consent context,
    // so the sanitizer would prune these keys anyway (same text transform).
    try {
      content = prunePluginKeysFromDocument(content, PLUGIN_SERVER_KEY_PREFIX, targetPath);
    } catch (error) {
      // A newer build's document shape this build cannot inspect. Unlike the
      // uninstaller there is no retry tombstone here, so dropping the copy
      // would lose that configuration for good (upgrade↔downgrade rule):
      // keep it verbatim when the scan below proves it carries no key.
      log.debug("[MCP] Fork copy could not prune plugin keys; relying on the document scan", {
        sourceWorkspaceId,
        error: getErrorMessage(error),
      });
    }
    // Whatever survived pruning — including fields this build does not
    // recognize — must not carry a canonical plugin key anywhere in its
    // decoded strings: a later upgrade that understands such a field could
    // otherwise reactivate a default-disabled plugin server without fresh
    // consent. Consent wins; the copy is skipped.
    if (documentMayContainPluginKey(content)) {
      log.warn(
        "[MCP] Not copying workspace MCP overrides into fork: document still carries plugin keys",
        { sourceWorkspaceId }
      );
      return;
    }
    return { content, targetPath };
  }

  /**
   * Whether the fork source and every ancestor it may inherit from are read
   * from this host's filesystem. Devcontainers count: fork resolution uses
   * the host filesystem view (ConfigSnapshot.hostFilesystemView), so their
   * checkouts are probed through a local runtime, never by exec.
   */
  private async forkSourceChainIsHostLocal(
    source: FrontendWorkspaceMetadata,
    snapshot: ConfigSnapshot
  ): Promise<boolean> {
    assert(
      snapshot.hostFilesystemView,
      "fork chains are classified under the host filesystem view"
    );
    const byId = new Map((await snapshot.loadAllMetadata()).map((m) => [m.id, m]));
    const seen = new Set<string>();
    let current: FrontendWorkspaceMetadata | undefined = source;
    while (current !== undefined && !seen.has(current.id)) {
      if (
        !isHostLocalRuntimeConfig(current.runtimeConfig) &&
        !isDevcontainerRuntime(current.runtimeConfig)
      ) {
        return false;
      }
      seen.add(current.id);
      current =
        current.parentWorkspaceId === undefined ? undefined : byId.get(current.parentWorkspaceId);
    }
    return true;
  }

  /**
   * Whether the document the unlocked resolution selected still takes
   * precedence: no workspace between the source and that document's owner
   * has acquired an own override file meanwhile, and no higher-priority
   * candidate appeared at the owner itself. Direct edits of
   * `.xum/mcp.local.jsonc` bump no epoch and rewrite no config, so neither
   * of the other commit-point checks can see a child file appearing over the
   * ancestor's. One PARALLEL probe round across those levels (bounded by one
   * probe timeout, not one per level) under the lock; anything but positive
   * absence is treated as a precedence change.
   */
  private async forkSourcePrecedenceUnchanged(
    source: FrontendWorkspaceMetadata,
    resolved: ResolvedOverrides,
    snapshot: ConfigSnapshot
  ): Promise<boolean> {
    const byId = new Map((await snapshot.loadAllMetadata()).map((m) => [m.id, m]));
    const probes: Array<Promise<OverridesFileProbe>> = [];
    const seen = new Set<string>();
    let current: FrontendWorkspaceMetadata | undefined = source;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const { runtime, workspacePath } = this.resolveWorkspace(current, snapshot);
      const filePaths = this.getOverridesFilePaths(workspacePath, current.runtimeConfig);
      // Owner match by workspace identity, not path alone: an inheriting
      // Docker child and its parent both report `/src/.xum/mcp.local.jsonc`
      // in different containers, and mistaking the child for the owner would
      // stop probing before a child document created meanwhile is seen.
      const ownerIndex =
        resolved.sourceFile === undefined || resolved.sourceFile.ownerWorkspaceId !== current.id
          ? -1
          : filePaths.indexOf(resolved.sourceFile.filePath);
      // At the owner level only the candidates that PRECEDE the selected path
      // matter (a canonical `.xum/` file appearing over a legacy `.mux/` one);
      // the selected document itself is re-read verbatim under the lock.
      const candidates = ownerIndex === -1 ? filePaths : filePaths.slice(0, ownerIndex);
      for (const filePath of candidates) {
        probes.push(probeOverridesFile(runtime, filePath));
      }
      // A transparent owner (recognized-empty document kept only as the copy
      // source) did not decide anything: an ancestor document created since
      // the resolution would now supply the effective overrides, so keep
      // probing the chain past it.
      if (ownerIndex !== -1 && resolved.sourceFile?.transparent !== true) {
        break;
      }
      current =
        current.parentWorkspaceId === undefined ? undefined : byId.get(current.parentWorkspaceId);
    }
    if (probes.length === 0) {
      return true;
    }
    try {
      const results = await withDeadline(
        Promise.all(probes),
        HOST_DESCENDANT_TIMEOUT_MS,
        "fork source precedence probe timed out"
      );
      return results.every((probe) => probe.kind === "absent");
    } catch {
      return false;
    }
  }

  /**
   * Whether the fork source and every ancestor it may inherit from are
   * registered exactly as `snapshot` saw them (identity, checkout path,
   * runtime, parent link) and still carry the same legacy `workspace.mcp`
   * config.json value. A lifecycle mutation between the unlocked resolution
   * and the locked commit point invalidates that resolution. So does a legacy
   * edit: an ancestor's unmigrated legacy enable is honored read-only during
   * inheritance (no document, so the commit point's re-read cannot see it),
   * and a direct config edit or an older Xum process revoking it bumps no
   * epoch — without this comparison the fork would persist the revoked
   * enable. Throws (→ stale) when the fresh legacy config is unreadable.
   */
  private async forkSourceChainUnchanged(
    source: FrontendWorkspaceMetadata,
    snapshot: ConfigSnapshot
  ): Promise<boolean> {
    const fresh = new ConfigSnapshot(this.config, /* hostFilesystemView */ true);
    const [before, after] = await Promise.all([
      snapshot.loadAllMetadata(),
      fresh.loadAllMetadata(),
    ]);
    const legacyBefore = snapshot.loadLegacyConfig();
    const legacyAfter = fresh.loadLegacyConfig();
    const byId = (list: FrontendWorkspaceMetadata[]) => new Map(list.map((m) => [m.id, m]));
    const beforeById = byId(before);
    const afterById = byId(after);
    const identity = (m: FrontendWorkspaceMetadata | undefined, legacy: ProjectsConfig) => {
      if (m === undefined) return undefined;
      const legacyValue = this.getLegacyOverridesFromConfig(m.id, legacy);
      return JSON.stringify([
        m.projectPath,
        m.name,
        m.namedWorkspacePath,
        m.runtimeConfig,
        m.parentWorkspaceId,
        // Absent and `null` (an opaque legacy VALUE) both serialize as null
        // inside an array; tag absence so a `null` appearing counts as a change.
        legacyValue === undefined ? "no-legacy" : ["legacy", legacyValue],
      ]);
    };
    let current: FrontendWorkspaceMetadata | undefined = source;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      if (
        identity(beforeById.get(current.id), legacyBefore) !==
        identity(afterById.get(current.id), legacyAfter)
      ) {
        return false;
      }
      current =
        current.parentWorkspaceId === undefined
          ? undefined
          : beforeById.get(current.parentWorkspaceId);
    }
    return true;
  }

  /**
   * The document exists (resolution just read it) but cannot be reread right
   * now. Falling back to the normalized value would silently drop comments
   * and newer-version fields from the fork (upgrade↔downgrade rule) — skip
   * the copy instead; the source keeps its document.
   */
  private skipUnreadableSourceDocument(sourceWorkspaceId: string, error: unknown): undefined {
    log.warn(
      "[MCP] Not copying workspace MCP overrides into fork: source document could not be reread",
      { sourceWorkspaceId, error: getErrorMessage(error) }
    );
    return undefined;
  }

  /** Outside the override lock: target-only I/O (see copyOverridesToForkedCheckout). */
  private async writeForkCopy(
    sourceWorkspaceId: string,
    target: {
      runtime: ReturnType<typeof createRuntime>;
      workspacePath: string;
      runtimeConfig: RuntimeConfig | undefined;
    },
    prepared: ForkCopySource,
    progress: ForkCopyProgress
  ): Promise<void> {
    // Devcontainer checkouts are host worktrees whose container is only
    // built by the fork's init (ensureReady): exec into it would fail here,
    // so operate on the host filesystem directly. Decided from the runtime
    // CONFIG: a multi-project fork's runtime is a MultiProjectRuntime wrapping
    // the devcontainers, and its container path is a host directory too.
    const hostFilesystem = isDevcontainerRuntime(target.runtimeConfig);
    const fsRuntime = hostFilesystem
      ? createRuntime({ type: "local" }, { projectPath: target.workspacePath })
      : target.runtime;
    const fsRuntimeConfig: RuntimeConfig | undefined = hostFilesystem
      ? { type: "local" }
      : target.runtimeConfig;
    if (!(await this.isForkCopyTargetWritable(fsRuntime, target.workspacePath))) {
      return;
    }
    if (progress.cancelled) return;
    // Tracked like the writes below: a `mkdir -p` that outlives the copy's
    // deadline must be joined, or it can recreate the checkout path after a
    // failed registration sanitization deleted the fresh checkout, and the
    // retry collides with an orphan directory.
    progress.mutation = this.ensureOverridesDir(fsRuntime, target.workspacePath, fsRuntimeConfig);
    await progress.mutation;
    if (progress.cancelled) return;
    // Ignore coverage FIRST, strictly: the fresh checkout has no override
    // document yet, and one that Git can see could be committed by accident
    // (workspace-local authorization settings). If coverage cannot be
    // established the best-effort copy is skipped — nothing is written.
    try {
      // Tracked like the document write: a timed-out copy joins whatever
      // mutation is in flight, so a slow exclude update on a remote target
      // cannot replace `.git/info/exclude` after the fork's init moved on.
      progress.mutation = this.ensureOverridesGitignored(
        fsRuntime,
        target.workspacePath,
        fsRuntimeConfig,
        "strict"
      );
      await progress.mutation;
    } catch (error) {
      log.warn(
        "[MCP] Not copying workspace MCP overrides into fork: git exclude could not be installed",
        { sourceWorkspaceId, error: getErrorMessage(error) }
      );
      return;
    }
    if (progress.cancelled) return;
    // A timed-out copy joins the write (see copyOverridesToForkedCheckout).
    progress.mutation = writeFileString(fsRuntime, prepared.targetPath, prepared.content);
    await progress.mutation;
    log.debug("[MCP] Copied workspace MCP overrides into forked workspace", {
      sourceWorkspaceId,
      targetPath: prepared.targetPath,
    });
  }

  /**
   * Bump the cross-process override-write epoch (see MCP_OVERRIDES_EPOCH_FILE).
   * Called AFTER the disk write and AFTER in-process publication (so the
   * writer's own process is consistent either way), and it THROWS on failure:
   * a mutation without a durable cross-process signal must not be
   * acknowledged as complete — a sibling would keep overlaying its stale
   * snapshot indefinitely. Callers surface the error (the dialog save fails
   * and can be retried; a prune keeps its retry tombstone). The retry must be
   * able to reach this bump: the write already changed the stored revision,
   * so setOverridesForWorkspace's CAS admits a stale expectedRevision when the
   * incoming content is exactly what is on disk (isPersistedAsOwn).
   */
  private async bumpOverridesEpoch(): Promise<void> {
    const token = randomUUID();
    const target = path.join(this.coordinationRootDir, MCP_OVERRIDES_EPOCH_FILE);
    const tempPath = `${target}.${token}.tmp`;
    try {
      await fsPromises.writeFile(tempPath, token, "utf-8");
      await fsPromises.rename(tempPath, target);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Workspace MCP overrides were written, but the cross-process change signal could not be persisted (${getErrorMessage(error)}). Other running Xum processes may serve stale MCP settings until this is retried.`
      );
    }
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

  private runExclusive<T>(
    fn: () => Promise<T>,
    /**
     * Give up WITHOUT acquiring when the caller's deadline passed or its
     * signal aborted while this entry waited in the queue: an abandoned
     * caller must not hold the lock later just to release it, delaying
     * every queued writer behind it.
     */
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    const deadlineAt =
      options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const locked = async (): Promise<T> => {
      if (options?.signal?.aborted) {
        throw new Error("Workspace MCP override lock acquisition was aborted");
      }
      const remainingMs = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0) {
        throw new Error(
          "Another Mux process is currently updating workspace MCP settings. Wait for it to finish and try again."
        );
      }
      const release = await acquireCrossProcessLock({
        lockPath: path.join(this.coordinationRootDir, "mcp-overrides.lock"),
        // Writes are small file edits plus at most one discovery scan; a
        // minute of waiting outlasts any legitimate holder.
        acquireTimeoutMs: remainingMs === undefined ? 60_000 : Math.min(60_000, remainingMs),
        staleMs: 5 * 60_000,
        timeoutMessage:
          "Another Mux process is currently updating workspace MCP settings. Wait for it to finish and try again.",
        // Escape during a sibling's hold: stop polling now rather than
        // occupying the head of the queue for the rest of the budget.
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
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
   * Hold the exclusive (global) override lock imperatively — same in-process
   * queue and cross-process lock as every write here. Used by served tool
   * calls to fence their dispatch against sibling-process writes. Resolves
   * once the lock is held with a release function; the returned promise
   * rejects if acquisition times out.
   */
  acquireExclusiveLock(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<() => Promise<void>> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Promise((resolveAcquired, rejectAcquired) => {
      const done = this.runExclusive(() => {
        resolveAcquired(() => {
          release();
          return done;
        });
        return held;
      }, options);
      // Only acquisition can fail here: once the callback above runs, `done`
      // settles solely through the release function.
      done.catch(rejectAcquired);
    });
  }

  /**
   * Per-workspace cross-process lock, scoped to ONE workspace's checkout and
   * override document. Held by a workspace rename across its checkout move
   * and config rewrite, and taken by every writer of that workspace's
   * document before the global write lock: a settings save that passed its
   * revision check on the old path could otherwise write into a recreated
   * old path after the move, and the plugin-key prune could stat the vacated
   * path, find nothing, and retire its cleanup tombstone while the moved file
   * still holds the key. Scoping the fence to the workspace keeps unrelated
   * saves responsive during a slow remote rename (the global lock is never
   * held across a checkout move).
   *
   * LOCK ORDER: workspace locks are acquired in sorted order and ALWAYS
   * before the global lock (runExclusive), never while holding it.
   * Staleness (crashed holder) is handled by the lock's lease renewal and
   * reclamation, like the global lock.
   */
  acquireWorkspaceLock(
    workspaceId: string,
    options?: { acquireTimeoutMs?: number }
  ): Promise<() => Promise<void>> {
    // Normalized like every workspace lookup (getWorkspaceMetadata trims): a
    // save for " id " and a rename for "id" address one checkout and must
    // contend for one lock.
    const id = workspaceId.trim();
    assert(id.length > 0, "acquireWorkspaceLock: workspaceId must be non-empty");
    // Imperative handle over withWorkspaceLocks (same key derivation,
    // verification and budget): resolves once every key of this checkout is
    // held, with a release that ends the hold.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Promise((resolveAcquired, rejectAcquired) => {
      const done = this.withWorkspaceLocks(
        [id],
        (locked) => {
          const unresolvable = locked.unresolvable[0];
          if (unresolvable !== undefined) {
            throw unresolvable.error;
          }
          resolveAcquired(() => {
            release();
            return done;
          });
          return held;
        },
        options?.acquireTimeoutMs
      );
      done.catch(rejectAcquired);
    });
  }

  private acquireCheckoutLock(
    key: string,
    acquireTimeoutMs = WORKSPACE_LOCK_ACQUIRE_TIMEOUT_MS
  ): Promise<() => Promise<void>> {
    return acquireCrossProcessLock({
      lockPath: path.join(this.coordinationRootDir, "mcp-overrides-locks", `${key}.lock`),
      acquireTimeoutMs,
      staleMs: 5 * 60_000,
      timeoutMessage: WORKSPACE_LOCK_TIMEOUT_MESSAGE,
    });
  }

  /**
   * The lock KEYS of each workspace's checkout. Keyed by checkout identity,
   * not workspace id: aliases sharing one checkout (an isolation:none child
   * and its parent, in-place registrations) hold distinct ids for one
   * override document, and a rename through one id racing a save through the
   * other must contend for the same lock.
   *
   * Every acquirer takes ALL keys of its checkout, so two acquirers contend
   * whenever any key coincides — a stable fence regardless of filesystem
   * state:
   * - host checkouts: the SPELLED registry path (identical for every
   *   registration of that path, present or not — a rename's old path and a
   *   save resolving that old path after the move share it) plus, when it
   *   resolves, the realpath (so symlinked spellings coincide);
   * - shared remote filesystems (SSH host, devcontainer): identity + path;
   * - per-workspace filesystems (Docker: every container reports `/src`, but
   *   nothing is shared between containers): runtime + workspace id;
   * - an id absent from the registry: the id (nothing shares an unregistered
   *   checkout that this service can see).
   * A host checkout whose realpath is INDETERMINATE (stalled mount, timeout —
   * not a positively absent path) is reported as unresolvable: its symlink
   * aliases could not be fenced, so the caller fails that workspace instead
   * of proceeding under a weaker lock.
   */
  private async checkoutLockKeys(workspaceIds: readonly string[]): Promise<CheckoutLockKeys> {
    // Authoritative (throwOnError): a transiently unreadable config.json
    // must abort the acquisition, not degrade a registered workspace to its
    // fallback id key — a writer deriving the real checkout key meanwhile
    // would not contend with it.
    let all: FrontendWorkspaceMetadata[];
    try {
      all = await this.config.getAllWorkspaceMetadata({
        probeCheckouts: false,
        throwOnError: true,
      });
    } catch (error) {
      // The strict walk also fails on an UNRELATED id-less legacy entry whose
      // metadata.json is unreadable or malformed. Rename and removal take
      // this lock, so that must not brick every healthy workspace until the
      // user repairs persisted state by hand (self-healing rule). The lenient
      // walk skips such entries; it is trusted only when it still registers
      // every requested id — a config.json failure degrades it to EMPTY, and
      // "absent" would then wrongly fall through to the id-only key.
      const lenient = await this.config.getAllWorkspaceMetadata({ probeCheckouts: false });
      const registered = new Set(lenient.map((metadata) => metadata.id));
      if (!workspaceIds.every((id) => registered.has(id))) {
        throw error;
      }
      log.warn(
        "[MCP] Deriving checkout lock keys from a lenient registry walk: another entry's metadata is unreadable",
        { workspaceIds, error: getErrorMessage(error) }
      );
      all = lenient;
    }
    // Corrupted config can register one stable id on several entries; the
    // sweep prunes EVERY such checkout, so the id's key set is the union over
    // all of them (any indeterminate entry makes the id unresolvable).
    const byId = groupMetadataById(all, /* hostLocalOnly */ false);
    const digest = (parts: string[]): string =>
      createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    const keysFor = async (
      id: string,
      metadata: FrontendWorkspaceMetadata
    ): Promise<string[] | Error> => {
      const identity = runtimeFilesystemIdentity(metadata.runtimeConfig);
      if (identity === undefined) {
        return [digest(["workspace", metadata.runtimeConfig.type, id])];
      }
      const { workspacePath } = this.resolveWorkspace(metadata);
      if (identity !== "host") {
        const keys = [digest([identity, workspacePath])];
        if (metadata.runtimeConfig.type === "ssh") {
          // SSH `host` may be an ssh_config alias: two aliases can name one
          // machine, and nothing here can resolve them to a stable remote
          // identity. A rename through one alias and a save through the
          // other must still contend, so every SSH registration of a
          // remote path also takes a path-only fence shared across SSH
          // identities (conservative: same path on different hosts
          // serializes needlessly, which only costs a short wait).
          keys.push(digest(["ssh-path", workspacePath]));
        }
        return keys;
      }
      const spelled = path.resolve(workspacePath);
      const keys = [digest([identity, spelled])];
      try {
        const real = await withDeadline(
          fsPromises.realpath(spelled),
          REALPATH_TIMEOUT_MS,
          "realpath timed out"
        );
        if (real !== spelled) keys.push(digest([identity, real]));
      } catch (error) {
        if (!isPositivelyAbsent(error)) {
          return new Error(
            `Could not establish the checkout identity of workspace ${id} (${getErrorMessage(error)}); retry once its filesystem responds.`
          );
        }
      }
      return keys;
    };
    const derived = await mapWithConcurrency(
      workspaceIds,
      CANONICALIZE_CONCURRENCY,
      async (id): Promise<string[] | Error> => {
        const entries = byId.get(id);
        if (entries === undefined) {
          return [digest(["id", id])];
        }
        const union = new Set<string>();
        for (const metadata of entries) {
          const result = await keysFor(id, metadata);
          if (result instanceof Error) return result;
          for (const key of result) union.add(key);
        }
        return [...union];
      }
    );
    const keys = new Map<string, string[]>();
    const unresolvable: Array<{ workspaceId: string; error: Error }> = [];
    for (const [index, id] of workspaceIds.entries()) {
      const result = derived[index];
      if (result instanceof Error) unresolvable.push({ workspaceId: id, error: result });
      else keys.set(id, result);
    }
    return { keys, unresolvable, registry: all };
  }

  /**
   * Run `fn` holding the checkout locks of `workspaceIds`. ONE acquisition
   * budget for the whole batch, and no unrelated lock is retained while
   * waiting: the first lock is awaited (nothing else is held), every further
   * lock is only TRIED; when one is busy, everything acquired so far is
   * released and the batch retries after a short backoff until the budget
   * runs out. A sweep over A and B therefore never keeps A's writers waiting
   * behind a slow rename of B. The ids' checkout keys are re-derived under
   * the locks: a rename that moved a checkout in between changes its key, and
   * the batch then releases and retries with the current keys. `fn` receives
   * the registry view that verification read under the locks.
   */
  private async withWorkspaceLocks<T>(
    workspaceIds: readonly string[],
    fn: (locked: CheckoutLockKeys) => Promise<T>,
    budgetMs = WORKSPACE_LOCK_ACQUIRE_TIMEOUT_MS
  ): Promise<T> {
    const ids = [...new Set(workspaceIds.map((id) => id.trim()))];
    const deadlineAt = Date.now() + budgetMs;
    const remaining = () => Math.max(0, deadlineAt - Date.now());
    // Key derivation probes checkouts (bounded realpaths, but hundreds of
    // stalled ones add up): it draws from the same budget as the acquisition
    // — and the verification run below happens while every lock is held.
    const derive = () =>
      withDeadline(this.checkoutLockKeys(ids), remaining(), WORKSPACE_LOCK_TIMEOUT_MESSAGE);
    const fingerprint = (derived: CheckoutLockKeys) =>
      JSON.stringify([
        [...new Set([...derived.keys.values()].flat())].sort(),
        derived.unresolvable.map((entry) => entry.workspaceId).sort(),
      ]);
    for (;;) {
      const releases: Array<() => Promise<void>> = [];
      let acquiredAll = false;
      try {
        const derived = await derive();
        const keys = [...new Set([...derived.keys.values()].flat())].sort();
        for (const [index, key] of keys.entries()) {
          if (remaining() === 0) {
            throw new Error(WORKSPACE_LOCK_TIMEOUT_MESSAGE);
          }
          releases.push(await this.acquireCheckoutLock(key, index === 0 ? remaining() : 0));
        }
        const verification = await derive();
        if (fingerprint(verification) !== fingerprint(derived)) {
          if (remaining() === 0) {
            throw new Error(WORKSPACE_LOCK_TIMEOUT_MESSAGE);
          }
          throw new CheckoutKeysChangedError();
        }
        if (remaining() === 0) {
          throw new Error(WORKSPACE_LOCK_TIMEOUT_MESSAGE);
        }
        acquiredAll = true;
        return await fn(verification);
      } catch (error) {
        const retry =
          !acquiredAll &&
          error instanceof Error &&
          (error instanceof CheckoutKeysChangedError ||
            error.message === WORKSPACE_LOCK_TIMEOUT_MESSAGE) &&
          Date.now() < deadlineAt;
        if (!retry) {
          throw error;
        }
      } finally {
        for (const release of releases.reverse()) {
          await release();
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, WORKSPACE_LOCK_RETRY_BACKOFF_MS + Math.random() * 100)
      );
    }
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
      publish?: OverridesPublisher;
    }
  ): Promise<void> {
    assert(overrides && typeof overrides === "object", "overrides must be an object");

    // Workspace lock first (see acquireWorkspaceLock): a rename of THIS
    // workspace holds it across its checkout move, so the path resolved
    // below is the one the document is written to.
    return this.withWorkspaceLocks([workspaceId], (locked) =>
      this.runExclusive(async () => {
        const unresolvable = locked.unresolvable[0];
        if (unresolvable !== undefined) {
          throw unresolvable.error;
        }
        // A FRESH registry read under the global lock, not the view captured
        // before waiting for it: a workspace removal (which takes neither
        // lock) may have deleted the checkout and its config entry meanwhile.
        const snapshot = new ConfigSnapshot(
          this.config,
          false,
          undefined,
          /* writerLocksHeld */ true
        );
        try {
          await this.writeOverridesLocked(workspaceId, overrides, options, snapshot);
        } finally {
          // A bounded resolution that timed out may have started a migration
          // write; it must land before the locks are released.
          await snapshot.settleSideEffects();
        }
      })
    );
  }

  /** Body of setOverridesForWorkspace, run under the workspace and global locks. */
  private async writeOverridesLocked(
    workspaceId: string,
    overrides: WorkspaceMCPOverrides,
    options: Parameters<WorkspaceMcpOverridesService["setOverridesForWorkspace"]>[2],
    snapshot: ConfigSnapshot
  ): Promise<void> {
    const { metadata, runtime, workspacePath } = await this.getRuntimeAndWorkspacePath(
      workspaceId,
      snapshot
    );
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);
    const canonicalPath = filePaths[0];
    const hostFilesystemSave = overridesOnHostFilesystem(metadata.runtimeConfig);
    const normalized = normalizeWorkspaceMcpOverrides(overrides);
    // Every resolution performed under the locks is bounded: an inheriting
    // SSH/Docker child's current state is read through its parent chain,
    // where one unreachable parent can consume RemoteRuntime's 300 s per
    // level — and every other MCP settings operation waits behind these
    // locks meanwhile. On timeout the save is refused (retryable) and the
    // abandoned resolution is cancelled so it starts no migration write.
    const bounded = <T>(work: Promise<T>): Promise<T> =>
      withDeadline(
        work,
        SAVE_RESOLUTION_TIMEOUT_MS,
        "Reading the workspace's current MCP settings timed out (an inherited parent checkout did not respond); the settings were not saved. Retry.",
        () => snapshot.cancel()
      );

    // Resolved for every save (not only CAS ones): an inheriting child that
    // detaches below must carry its effective source's opaque fields.
    const current = await bounded(this.resolveOverridesFor(metadata, "lenient", snapshot));
    if (options?.expectedRevision !== undefined || options?.validateAgainstCurrent) {
      // Repair path: a dialog opened while the state could not be established
      // (malformed document, unreadable checkout) carries the UNAVAILABLE
      // sentinel. Its save replaces the document only while the state is
      // STILL not authoritative — the user is fixing exactly what they were
      // shown as broken; had the state become readable meanwhile, they must
      // reopen and see it (conflict), like any other stale snapshot.
      // Only the workspace's OWN state can be repaired this way: when
      // authority was lost in an ancestor, the own document is intact and
      // the `{}` shown to the user is a fallback for a parent document that
      // may hold enables, disables and allowlists — writing a child-owned
      // document from it would detach the child and drop all of them.
      if (
        options.expectedRevision === MCP_OVERRIDES_REVISION_UNAVAILABLE &&
        !current.authoritative &&
        current.authorityLostInherited
      ) {
        throw new Error(
          "The inherited parent workspace's MCP settings could not be read; the settings were not saved. " +
            "Retry once the parent checkout is reachable."
        );
      }
      const repairingUnavailable =
        options.expectedRevision === MCP_OVERRIDES_REVISION_UNAVAILABLE && !current.authoritative;
      if (
        options.expectedRevision !== undefined &&
        !repairingUnavailable &&
        computeOverridesRevision(current.overrides) !== options.expectedRevision &&
        !this.isPersistedAsOwn(workspaceId, current, normalized, filePaths, snapshot)
      ) {
        throw new WorkspaceMcpOverridesConflictError();
      }
      await options.validateAgainstCurrent?.(current.overrides, normalized);
    }

    // Aliases registered on this same checkout (an isolation:none task,
    // an in-place registration) read the document written below — and
    // any legacy config.json value THEY still carry would be migrated
    // back into it by their next own (depth 0) resolution, which is
    // exactly what a cleared document invites: the user revokes a server
    // and a cold alias's stale legacy enable resurrects it, trusted by
    // every read after. The user's write wins: every sharer's legacy
    // value is retired under the same lock. The sharer set is verified
    // BEFORE anything is persisted (an unverifiable sharer carrying a
    // legacy value refuses the save), and the values are cleared only
    // AFTER the replacement state landed — like the writer's own legacy
    // value below — so a failed write discards nobody's settings.
    const sharersRetirement = await this.planSharersLegacyRetirement(
      workspaceId,
      metadata,
      canonicalPath,
      snapshot
    );
    const retireSharersLegacy = async (): Promise<void> => {
      for (const sharerId of sharersRetirement.sharerIds) {
        log.info("[MCP] Retiring a checkout sharer's legacy MCP overrides after a shared save", {
          workspaceId,
          sharerWorkspaceId: sharerId,
        });
        await this.clearLegacyOverridesInConfig(sharerId);
      }
    };

    // Fields of the own document this build does not own survive the save
    // (see readOpaqueOverrideFields). They also keep the document in place
    // when the known fields are cleared: an unrecognized shape is the
    // workspace's own configuration and never resumes inheritance.
    // Bounded like the resolutions above: this probe/read runs while both
    // locks are held, and a remote document that turned slow since the CAS
    // resolution must not block unrelated saves for the runtime's command
    // timeout (the save is refused, retryable).
    const opaqueDocument = await bounded(
      this.readOpaqueOverrideFields(runtime, filePaths, hostFilesystemSave, workspacePath)
    );
    if (
      opaqueDocument.kind === "indeterminate" &&
      (isEmptyOverrides(normalized) || opaqueDocument.canonicalUnprobed)
    ) {
      // A clear removes every candidate; a write replaces the canonical file.
      // Either would destroy fields of a document that could not be read.
      throw new Error(
        "Could not read the workspace's current MCP settings document before replacing it; the settings were not saved. Retry."
      );
    }
    if (opaqueDocument.kind === "unmergeable") {
      throw new Error(
        "This workspace's MCP settings document was written by a newer version of Xum in a form this version cannot preserve; the settings were not saved. Upgrade Xum to edit them."
      );
    }
    const opaqueDocumentFields = opaqueDocument.kind === "fields" ? opaqueDocument.fields : {};
    // A child WITHOUT an own document resolves from an ancestor's; the
    // non-empty save below creates its own document, which shadows that
    // ancestor from then on. Fields of the inherited document this build does
    // not own (a newer version's) applied to the child through inheritance
    // and must move into the new document like the document's own would —
    // otherwise the detach silently drops them for this child on the next
    // upgrade. (A transparent ancestor document — one that normalizes to
    // nothing here — holds ONLY such fields.) A source this build cannot
    // preserve refuses the detach.
    // SECURITY: read like the fork copy (symlink guard, host containment).
    let inheritedOpaqueFields: Record<string, unknown> = {};
    const inheritedSource = current.sourceFile;
    if (
      !isEmptyOverrides(normalized) &&
      opaqueDocument.kind === "fields" &&
      inheritedSource !== undefined &&
      inheritedSource.ownerWorkspaceId !== workspaceId
    ) {
      const inherited = await bounded(
        (async () => {
          await assertOverrideSegmentsNotSymlinked(
            inheritedSource.runtime,
            inheritedSource.workspacePath,
            inheritedSource.hostFilesystem
          );
          if (inheritedSource.hostFilesystem) {
            await assertHostOverrideWriteContained(
              inheritedSource.filePath,
              inheritedSource.workspacePath
            );
          }
          return this.readOpaqueOverrideFields(
            inheritedSource.runtime,
            [inheritedSource.filePath],
            inheritedSource.hostFilesystem,
            inheritedSource.workspacePath
          );
        })()
      );
      if (inherited.kind !== "fields") {
        throw new Error(
          inherited.kind === "indeterminate"
            ? "Could not read the inherited MCP settings document this workspace would detach from; the settings were not saved. Retry."
            : "The inherited MCP settings document was written by a newer version of Xum in a form this version cannot preserve; the settings were not saved. Upgrade Xum to edit them."
        );
      }
      inheritedOpaqueFields = inherited.fields;
    }
    // The legacy config.json value is cleared below; a value this build does
    // not recognize (written by a newer Xum) is carried into the document
    // first — its unknown fields exactly like the document's own — instead
    // of being discarded with the clear. A shape that cannot be merged into
    // a document at all refuses the save: only a build that understands it
    // may replace it.
    const opaqueLegacyFields = opaqueLegacyFieldsOf(
      this.getLegacyOverridesFromConfig(workspaceId, snapshot.loadLegacyConfig())
    );
    if (opaqueLegacyFields === undefined) {
      throw new Error(
        "This workspace's MCP settings were written by a newer version of Xum in a form this version cannot preserve; the settings were not saved. Upgrade Xum to edit them."
      );
    }
    // Retired legacy values must agree with each other on every unknown field
    // (see mergeOpaqueFields); the document's own fields — the state every
    // sharer already reads — take precedence over all of them.
    const retiredOpaqueFields = mergeOpaqueFields(
      { ...sharersRetirement.opaqueFields },
      opaqueLegacyFields,
      workspaceId
    );
    // Precedence: the own document's fields, then the inherited document's
    // (the state the child effectively had), then retired legacy values.
    const opaqueFields = {
      ...retiredOpaqueFields,
      ...inheritedOpaqueFields,
      ...opaqueDocumentFields,
    };
    const document: Record<string, unknown> = { ...opaqueFields, ...normalized };

    // Legacy config.json storage is cleared only AFTER the replacement
    // state is persisted (file written, or file removed for empty
    // overrides). Clearing first would let a failed write — e.g. a repo
    // that tracks `.xum` as a regular file so the directory cannot be
    // created — leave a child with neither document nor legacy value, and
    // its next read would inherit the parent's enables instead of the
    // settings the legacy value carried. With the write first, a failure
    // leaves the previous state fully intact.
    if (isEmptyOverrides(normalized) && Object.keys(opaqueFields).length === 0) {
      // Failure-atomic clear: the legacy values are retired FIRST, while the
      // document (if any) still shadows them — a failed config edit leaves
      // the effective state untouched. Removing the document first would
      // expose a shadowed legacy enable as authoritative should a later step
      // fail, re-enabling a globally disabled server after the save reported
      // failure. (The non-empty branch orders the opposite way for the same
      // reason: there the WRITE is the step that may fail.)
      await this.clearLegacyOverridesInConfig(workspaceId);
      await retireSharersLegacy();
      await this.removeOverridesFile(runtime, workspacePath, metadata.runtimeConfig);
      // The epoch moves as soon as the durable state has changed — never
      // after the (bounded, possibly slow) publication: a sibling process
      // about to launch a server this clear revoked must observe it (see
      // MCPServerManager.assertOverridesEpochUnmovedBeforeStart), and a
      // publication failure must not leave siblings unaware of the write.
      await this.bumpOverridesEpoch();
      if (options?.publish) {
        // Clearing a sub-agent's own overrides resumes inheritance: publish
        // the effective (inherited) state, not `{}`, or the manager cache
        // would pin the child to "no overrides" until restart.
        // A FRESH snapshot (not a scope of the outer one): the legacy
        // value just cleared is memoized in the outer snapshot's config
        // read and would otherwise be resolved — and migrated back.
        const afterRemoval = new ConfigSnapshot(
          this.config,
          false,
          undefined,
          /* writerLocksHeld */ true
        );
        try {
          let resolved: ResolvedOverrides;
          try {
            resolved = await withDeadline(
              this.resolveOverridesFor(metadata, "lenient", afterRemoval),
              SAVE_RESOLUTION_TIMEOUT_MS,
              "Re-reading the workspace's inherited MCP settings timed out after clearing its own; caches were evicted.",
              () => afterRemoval.cancel()
            );
          } catch (error) {
            // The file is already gone; memory must not stay pinned to it.
            // Evict, then surface the failure.
            await options.publish(null, workspaceId);
            throw error;
          }
          await this.publishEffectiveOverrides(
            workspaceId,
            resolved.authoritative ? resolved.overrides : null,
            options.publish,
            canonicalPath,
            afterRemoval
          );
        } finally {
          await afterRemoval.settleSideEffects();
        }
      }
      return;
    }

    // Never (re)create a checkout: the registry was read under the locks, but
    // a workspace removal takes neither lock, so the checkout may be gone by
    // now — and `ensureDir` would materialize a stray `.xum` at that path.
    await this.assertCheckoutExists(runtime, workspacePath);
    // SECURITY: writes follow symlinks on every runtime (see
    // assertOverrideSegmentsNotSymlinked); the host check adds realpath
    // containment once the directory exists.
    await assertOverrideSegmentsNotSymlinked(runtime, workspacePath, hostFilesystemSave);
    await this.ensureOverridesDir(runtime, workspacePath, metadata.runtimeConfig);
    if (hostFilesystemSave) {
      await assertHostOverrideWriteContained(canonicalPath, workspacePath);
    }
    await writeFileString(runtime, canonicalPath, JSON.stringify(document, null, 2) + "\n");
    // The document IS the durable state: it shadows the writer's and every
    // sharer's legacy value on every read, so the epoch moves right here —
    // before the config edits below (one per legacy-carrying sharer) and the
    // publication — and a sibling about to launch a server this write revoked
    // observes it without waiting on either (see the removal branch above).
    await this.bumpOverridesEpoch();
    // Clearing the shadowed legacy values afterwards converges storage on
    // the workspace-local file.
    await this.clearLegacyOverridesInConfig(workspaceId);
    await retireSharersLegacy();
    await this.ensureOverridesGitignored(runtime, workspacePath, metadata.runtimeConfig);
    if (options?.publish) {
      await this.publishEffectiveOverrides(workspaceId, normalized, options.publish, canonicalPath);
    }
  }

  /**
   * See setOverridesForWorkspace: the ids of every workspace sharing the
   * written checkout that still carries a legacy `workspace.mcp` value (to be
   * cleared once the replacement state is persisted). Throws (rejecting the
   * save before anything is written) when the sharer set cannot be
   * established while some candidate still carries a legacy value — the
   * value would otherwise be able to overwrite the user's decision later.
   */
  private async planSharersLegacyRetirement(
    workspaceId: string,
    written: FrontendWorkspaceMetadata,
    writtenPath: string,
    snapshot: ConfigSnapshot
  ): Promise<{
    sharerIds: string[];
    /** Fields this build does not own from the sharers' legacy values (see opaqueLegacyFieldsOf); carried into the written document. */
    opaqueFields: Record<string, unknown>;
  }> {
    const legacyConfig = snapshot.loadLegacyConfig();
    const all = await snapshot.loadAllMetadata();
    const carriesLegacy = (m: FrontendWorkspaceMetadata): boolean =>
      this.getLegacyOverridesFromConfig(m.id, legacyConfig) !== undefined;
    const none = { sharerIds: [], opaqueFields: {} };
    // Legacy values are pre-migration leftovers: skip the (realpath-heavy)
    // sharer scan entirely when no other workspace carries one.
    if (!all.some((m) => m.id !== written.id && carriesLegacy(m))) {
      return none;
    }
    const scan = await this.findCheckoutSharers(
      written,
      writtenPath,
      all,
      snapshot,
      PUBLICATION_TIMEOUT_MS,
      new Set([workspaceId])
    );
    if (scan === "unverifiable" || scan === "timeout") {
      throw new Error(
        "Could not verify which workspaces share this checkout while other workspaces still carry legacy MCP settings; the settings were not saved. Retry."
      );
    }
    const unverified = scan.indeterminate.filter(carriesLegacy);
    if (unverified.length > 0) {
      throw new Error(
        `Workspace(s) ${unverified.map((m) => m.id).join(", ")} may share this checkout and still carry legacy MCP settings that could not be verified; the settings were not saved. Retry.`
      );
    }
    const sharers = scan.sharers.filter(carriesLegacy);
    const opaqueFields: Record<string, unknown> = {};
    for (const sharer of sharers) {
      const fields = opaqueLegacyFieldsOf(
        this.getLegacyOverridesFromConfig(sharer.id, legacyConfig)
      );
      if (fields === undefined) {
        throw new Error(
          `Workspace ${sharer.id} shares this checkout and carries MCP settings written by a newer version of Xum in a form this version cannot preserve; the settings were not saved. Upgrade Xum to edit them.`
        );
      }
      mergeOpaqueFields(opaqueFields, fields, sharer.id);
    }
    return { sharerIds: sharers.map((m) => m.id), opaqueFields };
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
      publish?: OverridesPublisher;
      /**
       * Registration-time sanitization of a NEW workspace identity: no earlier
       * prune pass can owe this workspace an epoch bump (nothing has cached
       * its overrides yet), so the cross-process signal is required only when
       * THIS pass actually rewrote a document. Otherwise a fork copy that
       * created a valid, key-free document (see copyOverridesToForkedCheckout)
       * would be rolled back by a transiently unwritable epoch file.
       */
      epochOnlyWhenRewritten?: boolean;
    }
  ): Promise<void> {
    assert(keyPrefix.length > 0, "prunePluginOverrideKeys: keyPrefix must be non-empty");
    // Deliberately NOT routed through the batch: workspace creation calls
    // this on a hot path, and the batch's post-sweep re-resolution (a second
    // full config parse) only guards multi-workspace sweeps against
    // concurrent renames — a workspace still being created cannot be renamed.
    // The workspace lock still applies (see acquireWorkspaceLock): it is the
    // fence every writer of this document shares with a rename.
    return this.withWorkspaceLocks([workspaceId], (locked) =>
      this.runExclusive(async () => {
        const unresolvable = locked.unresolvable[0];
        if (unresolvable !== undefined) {
          throw unresolvable.error;
        }
        // Same bound and write-join as the batch sweep (see
        // prunePluginOverrideKeysForWorkspaces): locks are held throughout.
        const budget = createPublicationBudget();
        const snapshot = new ConfigSnapshot(
          this.config,
          false,
          undefined,
          /* writerLocksHeld */ true
        );
        try {
          await this.pruneSingleWorkspace(workspaceId, keyPrefix, options, budget, snapshot);
        } finally {
          await snapshot.settleSideEffects();
        }
      })
    );
  }

  private async pruneSingleWorkspace(
    workspaceId: string,
    keyPrefix: string,
    options: { publish?: OverridesPublisher; epochOnlyWhenRewritten?: boolean } | undefined,
    budget: PublicationBudget,
    snapshot: ConfigSnapshot
  ): Promise<void> {
    const resolved = await withDeadline(
      this.getRuntimeAndWorkspacePath(workspaceId, snapshot),
      budget.remaining(),
      "workspace enumeration exceeded the plugin-prune budget"
    );
    // Own cancellable scope (see sweepPluginOverrideKeys).
    const step = snapshot.scoped();
    const { filePaths, owesEpoch, rewrote } = await withDeadline(
      this.pruneResolvedWorkspace(resolved, keyPrefix, step),
      budget.remaining(),
      `pruning workspace ${workspaceId} exceeded the plugin-prune budget`,
      () => step.cancel()
    );
    if (options?.publish) {
      // Strict re-read: the prune above already threw on anything
      // unreadable, so a failure here is a real regression and must keep
      // the caller's retry tombstone rather than publish a guess.
      await this.publishEffectiveOverrides(
        workspaceId,
        (
          await withDeadline(
            this.resolveOverridesFor(resolved.metadata, "strict", snapshot),
            budget.remaining(),
            "override resolution exceeded the plugin-prune budget",
            () => snapshot.cancel()
          )
        ).overrides,
        options.publish,
        filePaths[0],
        snapshot,
        undefined,
        budget
      );
    }
    // The durable cross-process signal is owed only when an override
    // document exists (possibly rewritten by an earlier pass whose bump
    // failed). Registration sanitizes every fresh checkout through this
    // path — most have no override file at all — and a transiently
    // unwritable epoch file must not turn that no-op into a failed
    // (rolled-back) creation.
    if (options?.epochOnlyWhenRewritten ? rewrote : owesEpoch) {
      await this.bumpOverridesEpoch();
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
      /** Same contract as prunePluginOverrideKeys's publish. */
      publish?: OverridesPublisher;
    }
  ): Promise<Array<{ workspaceId: string; error: unknown }>> {
    assert(keyPrefix.length > 0, "prunePluginOverrideKeys: keyPrefix must be non-empty");

    // Every swept workspace's lock first (sorted), then the global lock: a
    // rename holding a workspace lock across its checkout move cannot be
    // interleaved with this sweep's stat of that checkout.
    return this.withWorkspaceLocks(workspaceIds, (locked) =>
      this.runExclusive(async () => {
        // ONE budget for the whole sweep — the registry scan, every target's
        // prune and the cache fan-out afterwards: this runs under every
        // selected workspace lock AND the global lock, and a single checkout
        // on a stalled NFS/FUSE mount must not hold unrelated settings writes
        // past their acquisition timeout. Timed-out targets become
        // per-workspace failures (the caller keeps their tombstones); a
        // rewrite already in flight is joined before the locks are released.
        const budget = createPublicationBudget();
        const snapshot = new ConfigSnapshot(
          this.config,
          false,
          undefined,
          /* writerLocksHeld */ true
        );
        try {
          // Workspaces whose checkout identity could not be established were
          // not locked: they fail (tombstone kept) instead of being pruned
          // under a fence their symlink aliases could bypass.
          const failures = await this.sweepPluginOverrideKeys(
            workspaceIds.filter(
              (id) => !locked.unresolvable.some((entry) => entry.workspaceId === id.trim())
            ),
            keyPrefix,
            options,
            budget,
            snapshot
          );
          return [
            ...locked.unresolvable.map(({ workspaceId, error }) => ({ workspaceId, error })),
            ...failures,
          ];
        } finally {
          await snapshot.settleSideEffects();
        }
      })
    );
  }

  /** Body of prunePluginOverrideKeysForWorkspaces, run under its locks. */
  private async sweepPluginOverrideKeys(
    workspaceIds: readonly string[],
    keyPrefix: string,
    options: { publish?: OverridesPublisher } | undefined,
    budget: PublicationBudget,
    snapshot: ConfigSnapshot
  ): Promise<Array<{ workspaceId: string; error: unknown }>> {
    // Group, don't index: a corrupted config can list one ID under several
    // entries (different checkouts). Every host-local checkout carrying the
    // ID must be pruned, or retiring the tombstone would leave a stale
    // enable behind in the entry a last-write-wins map dropped. Off-host
    // entries (SSH/Docker) sharing the ID are skipped: plugin servers never
    // run there, and the symlink guard below uses host fs semantics.
    const checkoutPaths = (entries: FrontendWorkspaceMetadata[] | undefined): string =>
      (entries ?? [])
        .map((metadata) => this.resolveWorkspace(metadata).workspacePath)
        .sort()
        .join("\0");

    // Registry-only and bounded like every other enumeration held under
    // the locks: the default enumeration probes each checkout with
    // fs.access, which blocks indefinitely on a stalled mount.
    const metadataById = groupMetadataById(
      await withDeadline(
        snapshot.loadAllMetadata(),
        budget.remaining(),
        "workspace enumeration exceeded the plugin-prune budget"
      ),
      /* hostLocalOnly */ true
    );
    const failures: Array<{ workspaceId: string; error: unknown }> = [];
    const swept = new Map<
      string,
      { metadata: FrontendWorkspaceMetadata; filePaths: readonly string[] }
    >();
    let anyOwesEpoch = false;
    for (const workspaceId of workspaceIds) {
      try {
        const entries = metadataById.get(workspaceId.trim());
        if (!entries) {
          throw new Error(`Host-local workspace metadata not found for ${workspaceId.trim()}`);
        }
        const pruned: Array<readonly string[]> = [];
        for (const metadata of entries) {
          // Bounded by the remaining sweep budget: local stat/read/write
          // on a disconnected mount can block indefinitely. A timeout is
          // this workspace's failure (tombstone kept); its write, if one
          // started, is joined before the locks are released.
          // Own cancellable scope: a losing prune that resumes after the
          // deadline (a stat/read finally answering) must not start its
          // rewrite once the caller moved on — settleSideEffects can only
          // join a write that has been registered by then.
          const step = snapshot.scoped();
          const result = await withDeadline(
            this.pruneResolvedWorkspace(this.resolveWorkspace(metadata), keyPrefix, step),
            budget.remaining(),
            `pruning workspace ${metadata.id} exceeded the plugin-prune budget`,
            () => step.cancel()
          );
          pruned.push(result.filePaths);
          anyOwesEpoch ||= result.owesEpoch;
        }
        // Publication reads the first entry, matching getWorkspaceMetadata's lookup.
        swept.set(workspaceId, { metadata: entries[0], filePaths: pruned[0] });
      } catch (error) {
        failures.push({ workspaceId, error });
      }
    }
    if (swept.size === 0) {
      return failures;
    }
    // Files changed: siblings must learn about it BEFORE the bounded (and
    // possibly slow) publication below, like a settings save (see
    // writeOverridesLocked). Without the durable signal every swept workspace
    // keeps its tombstone (retry re-bumps). No document anywhere → nothing to
    // signal (see prunePluginOverrideKeys).
    if (anyOwesEpoch) {
      try {
        await this.bumpOverridesEpoch();
      } catch (error) {
        for (const workspaceId of swept.keys()) {
          failures.push({ workspaceId, error });
        }
      }
    }

    // A fresh post-sweep enumeration serves both checks below: the rename
    // guard and every publication's inheritance/sharer resolution. (The
    // pre-sweep snapshot memoized the registry read above; the config
    // may have changed meanwhile, so a second snapshot re-reads it.)
    const after = new ConfigSnapshot(this.config, false, undefined, /* writerLocksHeld */ true);
    let afterById: Map<string, FrontendWorkspaceMetadata[]>;
    try {
      afterById = groupMetadataById(
        await withDeadline(
          after.loadAllMetadata(),
          budget.remaining(),
          "workspace enumeration exceeded the plugin-prune budget"
        ),
        /* hostLocalOnly */ true
      );
    } catch (error) {
      // Nothing can be verified or published authoritatively: every swept
      // workspace keeps its tombstone, and every cache is dropped so no
      // pre-prune snapshot survives (recovery reads disk).
      log.warn("[MCP] Workspace enumeration failed after a plugin override sweep; evicting all", {
        error: getErrorMessage(error),
      });
      if (options?.publish) {
        await options.publish(null, ALL_WORKSPACES_TARGET);
      }
      for (const workspaceId of swept.keys()) {
        failures.push({ workspaceId, error });
      }
      return failures;
    }

    // A rename of a swept workspace is excluded by its workspace lock (held
    // above across the whole sweep). Defense in depth against any other
    // config mutation that changes a swept workspace's checkout set while
    // the sweep runs: re-resolve once afterwards and fail such a workspace
    // — the caller keeps its tombstone and retries.
    for (const workspaceId of [...swept.keys()]) {
      const id = workspaceId.trim();
      if (checkoutPaths(metadataById.get(id)) !== checkoutPaths(afterById.get(id))) {
        swept.delete(workspaceId);
        failures.push({
          workspaceId,
          error: new Error(`Workspace ${id} moved while its MCP overrides were being pruned`),
        });
      }
    }

    if (options?.publish) {
      // Publish AFTER every prune landed: an inheriting descendant swept
      // before its parent would otherwise publish the parent's pre-prune
      // state. Strict re-read: the prune above already threw on anything
      // unreadable, so a failure here is a real regression and must keep the
      // caller's retry tombstone rather than publish a guess. One `published`
      // set for the whole batch: a swept descendant already re-published by
      // its ancestor's fan-out still gets its own strict verification and
      // authoritative publication here, but its subtree is not walked again.
      const published = new Set<string>();
      // The sweep's single budget continues here: each fan-out would
      // otherwise reset its own 30 s while the locks stay held.
      for (const [workspaceId, { metadata, filePaths }] of swept) {
        try {
          await this.publishEffectiveOverrides(
            workspaceId,
            (
              await withDeadline(
                this.resolveOverridesFor(metadata, "strict", after),
                budget.remaining(),
                "override resolution exceeded the plugin-prune budget",
                () => after.cancel()
              )
            ).overrides,
            options.publish,
            filePaths[0],
            after,
            published,
            budget
          );
        } catch (error) {
          failures.push({ workspaceId, error });
        }
      }
    }
    return failures;
  }

  /**
   * One workspace's prune; see prunePluginOverrideKeys for the contract.
   * Returns the candidate override paths (canonical first) for publication,
   * whether the cross-process epoch is owed (see the inline note) and whether
   * this pass rewrote a document.
   */
  private async pruneResolvedWorkspace(
    resolved: ResolvedWorkspace,
    keyPrefix: string,
    /**
     * Cancellable scope of this prune: a rewrite is registered here so a
     * caller whose deadline fired can join it before releasing its locks, and
     * it is never STARTED once the scope was cancelled (the caller has moved
     * on; a late write could overwrite a later save).
     */
    snapshot: ConfigSnapshot
  ): Promise<{ filePaths: readonly string[]; owesEpoch: boolean; rewrote: boolean }> {
    const { metadata, runtime, workspacePath } = resolved;
    let owesEpoch = false;
    let rewrote = false;
    // Prune canonical AND legacy-named files: a stale plugin key in an old
    // .mux/mcp.local.jsonc would otherwise survive uninstall and reactivate
    // on a later canonical migration.
    const filePaths = this.getOverridesFilePaths(workspacePath, metadata.runtimeConfig);

    // Two phases: every candidate is read and validated BEFORE any is
    // rewritten. A rewrite of the first file followed by a throw on a later
    // one would return nothing to the caller, which then never bumps the
    // cross-process epoch for a revocation that is already durable — and
    // every tombstone retry would fail on the same later file.
    const rewrites: Array<{ filePath: string; text: string }> = [];
    for (const filePath of filePaths) {
      if (!(await statIsFile(runtime, filePath, "strict"))) {
        continue;
      }
      // A document exists: the cross-process signal is owed whether or not
      // THIS pass rewrites it — a previous pass may have rewritten it and
      // failed its epoch bump (the caller then retried on its tombstone), so
      // an idempotent retry must still publish the invalidation. Only a
      // checkout with no override document at all owes nothing.
      owesEpoch = true;
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
      let text: string;
      try {
        text = prunePluginKeysFromDocument(original, keyPrefix, filePath);
      } catch (error) {
        // A shape this build cannot edit (newer-version fields, non-object
        // root, duplicate properties). When the full parse-tree scan proves
        // no canonical plugin key is present anywhere in the document, there
        // is nothing to prune: leave it verbatim (upgrade↔downgrade rule) —
        // exactly the document a fork copy preserved on the same evidence,
        // which registration would otherwise reject and roll the fork back
        // for. Anything that MAY carry a key keeps throwing so the caller
        // retains its retry tombstone.
        if (documentMayContainPluginKey(original)) {
          throw error;
        }
        log.debug("[MCP] Leaving an uneditable override document that carries no plugin key", {
          filePath,
          error: getErrorMessage(error),
        });
        continue;
      }
      if (text !== original) {
        rewrites.push({ filePath, text });
      }
    }
    for (const { filePath, text } of rewrites) {
      if (snapshot.cancelled) {
        throw new Error(`pruning ${filePath} was cancelled before its rewrite started`);
      }
      try {
        await snapshot.trackSideEffect(writeFileString(runtime, filePath, text));
      } catch (error) {
        if (rewrote) {
          // An earlier candidate's revocation is already durable: publish it
          // to sibling processes even though this pass fails (the caller's
          // tombstone retry republishes anyway once the write succeeds).
          await this.bumpOverridesEpoch().catch((epochError: unknown) =>
            log.warn("[MCP] Could not publish the epoch after a partial override prune", {
              filePath,
              error: getErrorMessage(epochError),
            })
          );
        }
        throw error;
      }
      rewrote = true;
    }
    return { filePaths, owesEpoch, rewrote };
  }
}

/**
 * Remove every canonical `plugin:` key starting with `keyPrefix` from a raw
 * override document, PRESERVING all fields this build does not recognize.
 * Pure text transform shared by prunePluginOverrideKeys (uninstall) and the
 * fork copy; throws on shapes it cannot inspect (see the doctrine inline).
 */
function prunePluginKeysFromDocument(
  original: string,
  keyPrefix: string,
  filePath: string
): string {
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
  // Every edit must leave a parseable document behind: an editor defect
  // here would corrupt a user-maintained file that the manager then treats
  // as unreadable (fail closed) and the uninstaller retries forever.
  const commit = (next: string, what: string): void => {
    // A no-op edit means parse and the editor disagreed about the target;
    // looping on it would never terminate.
    assert(next !== text, `prunePluginOverrideKeys: ${what} produced no change`);
    const errors: jsonc.ParseError[] = [];
    jsonc.parse(next, errors);
    assert(errors.length === 0, `prunePluginOverrideKeys: ${what} produced unparseable JSONC`);
    text = next;
  };
  const removeAt = (jsonPath: jsonc.JSONPath): void => {
    commit(
      jsonc.applyEdits(
        text,
        jsonc.modify(text, jsonPath, undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
      ),
      `removing ${jsonPath.join(".")}`
    );
  };
  // jsonc.modify (jsonc-parser 3.3.1) corrupts a COMPACT array when its LAST
  // element is removed (`["a","b"]` → `["a""]`), so array elements are cut
  // out of the text directly from the parse tree instead. Exactly two spans
  // go: the element itself and ONE adjacent comma token — the comma before it
  // (or, for the first element, the comma after it). Nothing else is touched,
  // so every comment and all whitespace survive, including trivia attached
  // to the neighbors (`["plugin", /* why */ "shots"]` → `[ /* why */ "shots"]`).
  const removeArrayElement = (field: string, index: number): void => {
    const root = jsonc.parseTree(text);
    assert(root !== undefined, "prunePluginOverrideKeys: document has no parse tree");
    const arrayNode = jsonc.findNodeAtLocation(root, [field]);
    assert(
      arrayNode?.type === "array" && arrayNode.children !== undefined,
      `prunePluginOverrideKeys: "${field}" is not an array node`
    );
    const items = arrayNode.children;
    const item = items[index];
    assert(item !== undefined, `prunePluginOverrideKeys: "${field}"[${index}] is missing`);
    const previous = items[index - 1];
    const following = items[index + 1];
    // Locate the comma token in a gap using the JSONC scanner (skips
    // whitespace and comments, so a comment containing "," is never mistaken).
    const commaSpan = (from: number, to: number): [number, number] => {
      const scanner = jsonc.createScanner(text, /* ignoreTrivia */ true);
      scanner.setPosition(from);
      for (;;) {
        const token = scanner.scan();
        const offset = scanner.getTokenOffset();
        assert(
          token !== jsonc.SyntaxKind.EOF && offset < to,
          `prunePluginOverrideKeys: no separator found in "${field}"`
        );
        if (token === jsonc.SyntaxKind.CommaToken) {
          return [offset, offset + scanner.getTokenLength()];
        }
      }
    };
    const spans: Array<[number, number]> = [[item.offset, item.offset + item.length]];
    if (previous !== undefined) {
      spans.push(commaSpan(previous.offset + previous.length, item.offset));
    } else if (following !== undefined) {
      spans.push(commaSpan(item.offset + item.length, following.offset));
    }
    // Apply from the highest offset down so earlier spans stay valid.
    let next = text;
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
      next = next.slice(0, start) + next.slice(end);
    }
    commit(next, `removing ${field}[${index}]`);
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
      removeArrayElement(field, index);
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
  // The edits above only reach the fields this build owns. A newer build may
  // store the same key in a top-level field this build does not recognize
  // (or nested inside a shape it kept verbatim): reporting success would
  // retire the uninstaller's tombstone while that key survives, and a later
  // upgrade or same-name reinstall could reactivate the plugin server without
  // fresh consent. Reject when any retained decoded string still carries the
  // pruned prefix in canonical key shape (an ordinary server named
  // `myplugin:x` is not a hit) — the caller keeps its tombstone (uninstall)
  // or skips the copy (fork) until a build that owns the field repairs it.
  if (
    documentStringsContain(
      text,
      (value) => value.includes(keyPrefix) && CANONICAL_PLUGIN_KEY_PATTERN.test(value)
    )
  ) {
    throw new Error(
      `Workspace MCP overrides file still carries "${keyPrefix}" keys in fields this version does not edit (written by a newer version?): ${filePath}`
    );
  }
  return text;
}

/**
 * Conservative "could any canonical plugin key hide in this document?" screen
 * for text prunePluginKeysFromDocument refused to edit. Walks every DECODED
 * string node (keys and values) of the JSONC parse TREE — not the parsed
 * value, whose last-wins duplicate properties would hide a shadowed key — so
 * JSON escapes such as `plugin\u003a…` cannot slip past a raw-text search.
 * Unparseable text is treated as possibly containing one.
 */
function documentMayContainPluginKey(text: string): boolean {
  return documentStringsContain(text, (value) => CANONICAL_PLUGIN_KEY_PATTERN.test(value));
}

/** Whether any decoded string node (key or value) of the JSONC parse tree satisfies `predicate`; unparseable text counts as a match. */
function documentStringsContain(text: string, predicate: (value: string) => boolean): boolean {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors);
  if (errors.length > 0 || root === undefined) {
    return true;
  }
  const visit = (node: jsonc.Node): boolean =>
    (node.type === "string" && typeof node.value === "string" && predicate(node.value)) ||
    (node.children?.some(visit) ?? false);
  return visit(root);
}
/** Canonical `plugin:<16 hex>:<server>` key shape (mirrors isCanonicalPluginServerKey), searched inside strings. */
const CANONICAL_PLUGIN_KEY_PATTERN = /plugin:[0-9a-f]{16}:/;

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
