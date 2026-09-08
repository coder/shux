import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  AgentPluginInstallEntrySchema,
  type AgentPluginGitSource,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import { isValidAgentPluginName } from "@/common/utils/agentPluginName";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
  AgentPluginManifestSummary,
  AgentPluginPreviewHook,
  AgentPluginPreviewMcpServer,
  AgentPluginPreviewSkill,
  AgentPluginUpdateCheck,
  AgentPluginCapabilityChange,
  AgentPluginUpdateConsent,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { resolvePluginHookGrants } from "@/node/services/agentPlugins/hookSandbox";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import type { Config } from "@/node/config";
import { AgentIdSchema } from "@/common/schemas/ids";
import { parseAgentDefinitionMarkdown } from "@/node/services/agentDefinitions/parseAgentDefinitionMarkdown";
import {
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas/agentSkill";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { log } from "@/node/services/log";
import type { MCPServerInfo } from "@/common/types/mcp";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { shellQuote } from "@/common/utils/shell";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  discoverAgentPluginAt,
  discoverAgentPlugins,
  journalDerivedDiscoveryGate,
  setAgentPluginDiscoveryGate,
  type AgentPluginContainer,
  type AgentPluginInfo,
} from "./discovery";
import {
  bumpContainerMutationEpoch,
  isJournalName,
  JOURNAL_PREFIXES,
  MUTATION_EPOCH_FILE,
  PROMOTION_JOURNAL_PREFIX,
  STAGING_DIR_NAME,
  UNINSTALL_JOURNAL_PREFIX,
  UPDATE_JOURNAL_PREFIX,
} from "./journals";
import type { AgentPluginManifest } from "./manifest";
import {
  buildPluginServerKey,
  computePluginInstanceId,
  getPluginDataPath,
  isCanonicalPluginServerKeyPrefix,
  loadPluginMcpServers,
} from "./mcpConfig";
import {
  assertNoAgentPluginUrlCredentials,
  isFullCommitSha,
  parseAgentPluginSourceInput,
} from "./sourceInput";

/**
 * Managed Agent Plugin installer (agent-plugins experiment; global scope only).
 *
 * Flow: parse input → shallow clone to a staging dir under ~/.mux →
 * validate the STAGED clone with the same manifest/component discovery used
 * at runtime → return a consent preview → on confirm, re-clone the exact SHA,
 * promote into ~/.mux/plugins/<name>, and record a registry entry
 * ({source, ref, lockedSha}) in ~/.mux/plugins.json.
 *
 * The registry is a standalone file (NOT a config.json section): older builds
 * rebuild config.json from known fields on save, so a downgrade would drop an
 * embedded registry — and owning the file lets writes THROW on failure so
 * install/update/uninstall can roll back instead of silently succeeding with
 * an unpersisted registry.
 *
 * Invariants:
 * - The installer NEVER writes into a project checkout (v1 is global-only).
 * - `lockedSha` is what runs; branches are only a tracking channel for the
 *   update badge. Nothing auto-applies.
 * - Update = temp clone + wholesale directory swap (rename-old → promote-new
 *   → delete-old), never in-place `git pull` — local edits to a managed
 *   plugin dir are discarded on update.
 * - Applying an update or uninstalling recycles that plugin's running MCP
 *   servers: content can change behind an unchanged stdio command line, so
 *   the config-signature check cannot notice (correctness, not polish).
 * - Failure paths must leave no partial state: staging dirs are cleaned up,
 *   and promote + registry-write failures roll back.
 */

/** Registry file name under the mux home dir. */
const REGISTRY_FILE_NAME = "plugins.json";

/*
 * Journal semantics (prefixes and helpers live in ./journals so discovery can
 * derive suppression without an import cycle):
 * - PROMOTION: an install renamed the staged tree into the container but has
 *   not yet written its registry entry. A crash in that window would strand
 *   an orphaned tree that discovery lists as unmanaged, assertNoCollision
 *   blocks, and uninstall refuses — recoverable only by manual deletion.
 * - UPDATE: the OLD live tree moved into staging but the staged replacement
 *   is not yet promoted. The registry then records an install whose path is
 *   missing, and retrying Update cannot self-heal because
 *   assertNoCapabilityIncrease treats the missing tree as an empty surface.
 * - UNINSTALL: the plugin tree (and optionally its data dir) is staged into
 *   trash but the registry write has not committed; the assets would hide
 *   under plugin-staging while the registry still owns the plugin.
 * reconcileJournals resolves all three on startup and on section open.
 */

/**
 * Marker file written into a staged tree just before a promote/swap rename,
 * holding the random nonce also recorded in the promotion or update journal.
 * Recovery touches a tree at the target path only when the nonces match: this
 * proves the tree is the one WE moved there. Filesystem identities (dev/ino)
 * are NOT sufficient — deleting the orphan and recreating a directory at the
 * same path can reuse the inode immediately. The marker is removed once the
 * mutation commits, and validateStagedClone rejects repositories shipping the
 * reserved name so the write can never clobber plugin-owned content.
 */
const PROMOTION_MARKER_FILE = ".mux-promotion-marker";

/** Staging dirs left behind by crashes are reclaimed after this age. */
const STALE_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Cross-process mutation lock file in the staging root. The in-process
 * mutationQueue serializes one service instance, but two processes sharing
 * the same rootDir (ALLOW_MULTIPLE_INSTANCES, a desktop app alongside `mux
 * server`) each have their own queue: two concurrent mutations could both
 * read the same plugins.json snapshot and the later atomic write would
 * silently drop the earlier one's entry. Every mutation transaction
 * (registry read → directory moves → registry write) holds this lock.
 */
const MUTATION_LOCK_FILE = "mutation.lock";
/** How long an acquire waits on a live holder before failing (covers a full clone). */
const MUTATION_LOCK_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;
/** Pid-reuse guard: no plugin mutation legitimately runs this long. */
const MUTATION_LOCK_STALE_MS = 30 * 60 * 1000;

/** Bound discovery/settings waits on startup crash-recovery I/O. */
const JOURNAL_RECONCILIATION_TIMEOUT_MS = 30_000;

const LS_REMOTE_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;

/** Deterministic JSON with recursively sorted object keys (fingerprinting). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }
    return val;
  });
}

/** Preview skill row plus the extra model-visible fields (see collectSkills). */
type CollectedPluginSkill = AgentPluginPreviewSkill & {
  whenToUse?: string;
  advertise?: boolean;
};

/** Result of resolving a user-supplied ref against the remote. */
interface ResolvedRemoteRef {
  ref: string;
  refType: "branch" | "tag" | "commit";
  /** Peeled commit SHA for branch/tag; the ref itself for commit. */
  sha: string;
}

function gitEnv(): Record<string, string> {
  // Fail fast instead of hanging on credential prompts: installs run from the
  // UI with no terminal attached (acceptance: "private repo without auth" must
  // fail cleanly).
  //
  // SECURITY: disable Git hooks for every staging clone/fetch/checkout. A
  // user with a RELATIVE global core.hooksPath (e.g. ".githooks") would
  // otherwise execute an attacker-controlled repository's post-checkout hook
  // during Preview — before any consent UI appears. GIT_CONFIG_* env config
  // takes precedence over all config files, so this neutralizes hooks
  // regardless of global/system configuration.
  //
  // SECURITY: whitelist transports. Git remote helpers execute arbitrary
  // commands (`ext::touch /pwn` runs before any consent UI when the user's
  // config sets protocol.ext.allow=always), and disabling hooks does not
  // restrict helpers. GIT_ALLOW_PROTOCOL is an env-level whitelist that
  // overrides protocol.*.allow configuration for every staging invocation.
  //
  // SECURITY: ignore system/global Git configuration during ALL staging Git
  // operations. An attacker-controlled repository can assign a user-defined
  // filter through .gitattributes; if the user's global config defines that
  // filter's smudge/process command, Git executes it during clone/checkout —
  // before consent. The staging flow deliberately accepts only the explicit
  // URL/ref plus the numbered safe config below; authentication must come
  // from transport-level mechanisms (SSH agent, URL credentials rejected
  // separately), never executable credential/filter/helper configuration.
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    ...GIT_NO_HOOKS_ENV,
  };
  if (process.env.GIT_SSH_COMMAND === undefined) {
    env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
  }
  return env;
}

/**
 * True when the aggregate file bytes OR the entry count under `dir` exceed
 * the quota. Counts EVERY entry — files, symlinks, and directories — like
 * assertStagedTreeWithinQuota: each one consumes an inode and filesystem
 * metadata without necessarily moving the byte total (a tiny pack of repeated
 * git tree objects can materialize thousands of directories). Walks with
 * early exit; entries vanishing mid-walk (git renames temp files) are
 * skipped.
 */
async function directoryQuotaExceeded(
  dir: string,
  quota: { maxBytes: number; maxFiles: number }
): Promise<boolean> {
  let bytes = 0;
  let entryCount = 0;
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined, "directoryQuotaExceeded: queue underflow");
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      entryCount += 1;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        try {
          bytes += (await fsPromises.lstat(entryPath)).size;
        } catch {
          // Entry vanished mid-walk.
        }
      }
      if (bytes > quota.maxBytes || entryCount > quota.maxFiles) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Run `fn` with an AbortSignal that fires when `dir` grows past `maxBytes`
 * or `maxFiles` while fn is pending. Bounds git DURING clone/fetch/checkout:
 * the post-clone quota can only reject a tree git already materialized, so a
 * huge remote would otherwise fill the disk — or exhaust inodes via many
 * empty files — before that check runs. Exported for tests.
 */
export async function withDiskQuotaWatchdog<T>(
  quota: { dir: string; maxBytes: number; maxFiles: number; pollMs?: number },
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let exceeded = false;
  let checking = false;
  const interval = setInterval(() => {
    if (checking || exceeded) {
      return;
    }
    checking = true;
    directoryQuotaExceeded(quota.dir, quota).then(
      (over) => {
        checking = false;
        if (over) {
          exceeded = true;
          controller.abort();
        }
      },
      () => {
        checking = false;
      }
    );
  }, quota.pollMs ?? 500);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (exceeded) {
      throw new Error(
        `The repository is too large to install as a plugin (exceeded ${Math.floor(quota.maxBytes / (1024 * 1024))} MiB or ${quota.maxFiles} files during clone).`
      );
    }
    throw error;
  } finally {
    clearInterval(interval);
  }
}

async function runGit(
  args: string[],
  opts?: {
    timeoutMs?: number;
    diskQuota?: { dir: string; maxBytes: number; maxFiles: number; pollMs?: number };
  }
): Promise<string> {
  const run = async (signal?: AbortSignal): Promise<string> => {
    using proc = execFileAsync("git", args, {
      env: gitEnv(),
      timeoutMs: opts?.timeoutMs ?? CLONE_TIMEOUT_MS,
      // Git spawns SSH/credential-helper children that inherit its pipes; a
      // stalled helper would otherwise keep the promise pending past the
      // timeout because only the direct child gets killed.
      killTreeOnTermination: true,
      // These remotes are untrusted: a malicious or noisy repository can emit
      // unbounded progress/sideband output, and unbounded buffering would
      // exhaust the main process before the timeout fires. 10 MiB is far above
      // anything the plugin-sized clones/ls-remotes here legitimately produce.
      maxOutputBytes: 10 * 1024 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    });
    const { stdout } = await proc.result;
    return stdout;
  };
  if (opts?.diskQuota !== undefined) {
    const diskQuota = opts.diskQuota;
    return withDiskQuotaWatchdog(diskQuota, (signal) => run(signal));
  }
  return run();
}

/** Max simultaneous `git ls-remote` processes during an update check. */
const UPDATE_CHECK_CONCURRENCY = 4;

/**
 * Aggregate quota for a staged clone's checkout (excluding .git). Remotes are
 * untrusted: --depth 1 and the subprocess output cap do not bound CHECKOUT
 * bytes, so a malicious repository could otherwise exhaust disk (and the
 * full-file manifest reads that follow) before consent ever appears. Far
 * above any legitimate plugin (skills/agents/workflows are text).
 */
const STAGED_TREE_MAX_BYTES = 100 * 1024 * 1024;
const STAGED_TREE_MAX_FILES = 10_000;

/**
 * Map with a bounded worker pool, preserving input order. Rejections
 * propagate; callers needing per-item error isolation catch inside `fn`
 * (checkUpdates does).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  assert(limit > 0, "mapWithConcurrency: limit must be positive");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsPromises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function shortenHome(absPath: string): string {
  const home = os.homedir();
  if (absPath === home) {
    return "~";
  }
  return absPath.startsWith(home + path.sep) ? `~${absPath.slice(home.length)}` : absPath;
}

function manifestSummary(manifest: AgentPluginManifest): AgentPluginManifestSummary {
  return {
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.author?.name !== undefined ? { authorName: manifest.author.name } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    ...(manifest.repository !== undefined ? { repository: manifest.repository } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
  };
}

export class AgentPluginInstallService {
  private readonly containerDir: string;
  private readonly stagingRoot: string;
  private readonly registryFile: string;
  /** Serializes mutations (install/update/uninstall) so directory swaps and registry writes cannot interleave. */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  /**
   * Staging paths owned by in-process operations. Stale reclamation must
   * never reap these: a just-renamed trash dir inherits the tree's OLD
   * mtime, so age alone can misclassify an active rollback copy as stale.
   */
  private readonly activeStagingPaths = new Set<string>();

  /** The single underlying recovery pass; timeout callers never start a competing pass. */
  private reconciliationWork: Promise<boolean> | undefined;
  /**
   * Latest bounded journal-reconciliation attempt, resolving to whether it
   * SUCCEEDED. Kicked off at construction because a session can serve agent
   * requests (whose global plugin discovery, MCP config, and hook loading scan
   * the container) without ever opening the Plugins section — an orphaned
   * promotion would load as an unmanaged plugin, hooks included, before
   * list()'s reconciliation ever ran. The discovery gate consumes the status:
   * `false` (timeout, unreadable registry, failed restore/quarantine)
   * suppresses the managed container from scans until a later attempt
   * succeeds. Never rejects (startup must not crash the app).
   */
  private reconciliationState: Promise<boolean>;

  constructor(
    private readonly config: Config,
    private readonly deps: {
      isEnabled: () => boolean;
      /** Recycles running MCP servers whose config key starts with the given prefix. */
      mcpServerManager?: MCPServerManager;
      /** Used to prune plugin server keys from per-workspace overrides on uninstall. */
      workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
      /** Test override for the staged-clone checkout quota. */
      stagingQuota?: { maxBytes: number; maxFiles: number };
      /** Test override for the recovery wait bound. */
      reconciliationTimeoutMs?: number;
    }
  ) {
    assert(path.isAbsolute(config.rootDir), "AgentPluginInstallService: rootDir must be absolute");
    this.containerDir = path.join(config.rootDir, "plugins");
    this.stagingRoot = path.join(config.rootDir, STAGING_DIR_NAME);
    this.registryFile = path.join(config.rootDir, REGISTRY_FILE_NAME);
    // Not gated on isEnabled(): journals only exist if the feature staged
    // something, and cleaning up our own crash leftovers is correct even if
    // the experiment was disabled afterwards (a missing staging root makes
    // this a single readdir). Failures retry on the next section open.
    this.reconciliationState = this.attemptReconcileJournals("startup");
    // Every global discovery consumer (MCP config, hooks, skills, workflows,
    // agents) funnels through discoverAgentPlugins; gate those scans on the
    // LATEST reconciliation attempt so an agent request cannot load an
    // orphaned tree while recovery is running — and cannot scan the managed
    // container at all while the latest attempt has FAILED (the journaled
    // tree may still be sitting in it). Health alone is not enough: a live
    // mutation (in this process or a sibling desktop/server process sharing
    // the same mux home) can overlap a scan, so keep the journal+epoch
    // bracket of the default gate and UNION health suppression onto it.
    setAgentPluginDiscoveryGate(async (containerPaths) => {
      // Serialize behind the latest recovery attempt BEFORE snapshotting the
      // journal bracket: recovery consumes journals, and reading them first
      // would suppress the very scan whose recovery just succeeded.
      const unhealthySuppression = (await this.reconciliationState) ? [] : [this.containerDir];
      const bracket = await journalDerivedDiscoveryGate(containerPaths);
      return {
        suppressed: [...new Set([...bracket.suppressed, ...unhealthySuppression])],
        confirm: async () => {
          const stillUnhealthy = (await this.reconciliationState) ? [] : [this.containerDir];
          return [...new Set([...(await bracket.confirm()), ...stillUnhealthy])];
        },
      };
    });
  }

  /**
   * Immediately mark reconciliation unhealthy for the discovery gate. Called
   * when an INLINE mutation path retains a journal for an unremovable tree in
   * the managed container: the next reconcileJournals run would report the
   * retained journal anyway, but the current process's health snapshot is
   * stale until then, and discovery must not load the orphan in the interim.
   */
  private markUnreconciled(): void {
    this.reconciliationState = Promise.resolve(false);
  }

  /**
   * Run reconcileJournals, mapping the outcome to a never-rejecting health
   * flag: false when it threw (unreadable registry) OR when any journal was
   * left unconsumed (failed restore/quarantine, unidentified target tree) —
   * both mean the managed container may hold unreconciled state.
   */
  private async attemptReconcileJournals(context: string): Promise<boolean> {
    let work = this.reconciliationWork;
    if (work === undefined) {
      const started = this.reconcileJournals().then(
        (allConsumed) => {
          if (!allConsumed) {
            log.warn(`Plugin journal reconciliation left unresolved journals (${context})`);
          }
          return allConsumed;
        },
        (error: unknown) => {
          log.warn(`Plugin journal reconciliation failed (${context})`, {
            error: getErrorMessage(error),
          });
          return false;
        }
      );
      work = started.then((result) => {
        // Clear only this pass: a later attempt may already have installed a
        // successor promise by the time an old, delayed pass settles.
        if (this.reconciliationWork === work) {
          this.reconciliationWork = undefined;
        }
        return result;
      });
      this.reconciliationWork = work;
    }

    const timeoutMs = this.deps.reconciliationTimeoutMs ?? JOURNAL_RECONCILIATION_TIMEOUT_MS;
    const settled = await raceWithAbortAndTimeout(work, { timeoutMs });
    if (settled.kind === "ok") {
      return settled.value;
    }
    // The underlying pass remains the sole reconciliationWork. Discovery and
    // settings callers stop waiting and fail closed (managed container
    // suppressed); a later retry races the SAME pass instead of starting a
    // competing filesystem mutation while stalled storage may still recover.
    log.warn(`Plugin journal reconciliation timed out (${context})`, { timeoutMs });
    return false;
  }

  /**
   * Display path of the ACTIVE managed plugin container for UI copy. The
   * root is config-derived (canonically ~/.shux, possibly a custom or
   * legacy-compat root), so the UI must never hardcode it.
   */
  containerLocation(): string {
    return shortenHome(this.containerDir);
  }

  // ---------------------------------------------------------------------
  // Registry persistence (~/.mux/plugins.json)
  // ---------------------------------------------------------------------

  /**
   * The registry document as stored on disk: the top-level ENVELOPE (an
   * object that must hold a `plugins` array, and may hold future top-level
   * fields like a registry version) plus the raw entry list. Mutations
   * operate on the raw entries (matching by their `name` property) and write
   * the envelope back with only `plugins` replaced, so both unknown entry
   * fields and unknown top-level fields written by newer builds survive an
   * install/update/uninstall on this build (upgrade↔downgrade stays
   * lossless).
   *
   * A missing file is an empty registry; corrupted content — unparseable
   * JSON or a structurally invalid envelope like `{}` / `{"plugins": null}`
   * — is not. Reads ("lenient") degrade corruption to an empty list so the
   * section still renders (dirs show as unmanaged), but mutations ("strict")
   * must refuse: treating a corrupted file as empty would let the next
   * install rewrite it with a single entry, permanently orphaning every
   * previously managed install.
   */
  private async readRegistryDocument(mode: "lenient" | "strict"): Promise<{
    envelope: Record<string, unknown>;
    rawEntries: unknown[];
  }> {
    const corrupted = (detail: string): never => {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) is corrupted: ${detail}. Repair or remove the file, then retry.`
      );
    };

    let raw: string;
    try {
      raw = await fsPromises.readFile(this.registryFile, "utf8");
    } catch (error) {
      // Only a MISSING file is an empty registry. Any other read failure
      // (e.g. an unreadable mode-000 file in a writable ~/.mux) must block
      // mutations: the atomic write replaces the file wholesale, so treating
      // "unreadable" as "empty" would erase every existing entry.
      if (hasErrorCode(error, "ENOENT")) {
        return { envelope: {}, rawEntries: [] };
      }
      if (mode === "strict") {
        corrupted(`it cannot be read (${getErrorMessage(error)})`);
      }
      log.warn("Ignoring unreadable plugin registry file", {
        file: this.registryFile,
        error: getErrorMessage(error),
      });
      return { envelope: {}, rawEntries: [] };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      if (mode === "strict") {
        corrupted(`it cannot be parsed (${getErrorMessage(error)})`);
      }
      log.warn("Ignoring unparseable plugin registry file", {
        file: this.registryFile,
        error: getErrorMessage(error),
      });
      return { envelope: {}, rawEntries: [] };
    }

    if (
      typeof parsedJson !== "object" ||
      parsedJson === null ||
      Array.isArray(parsedJson) ||
      !Array.isArray((parsedJson as { plugins?: unknown }).plugins)
    ) {
      if (mode === "strict") {
        corrupted("expected an object with a 'plugins' array");
      }
      log.warn("Ignoring structurally invalid plugin registry file", {
        file: this.registryFile,
      });
      return { envelope: {}, rawEntries: [] };
    }

    return {
      envelope: parsedJson as Record<string, unknown>,
      rawEntries: (parsedJson as { plugins: unknown[] }).plugins,
    };
  }

  /**
   * Lenient-on-read: entries this build does not recognize degrade to
   * "unmanaged dirs" rather than errors (discovery stays the source of truth
   * for what loads; the registry only annotates) — but they stay in the raw
   * file. Name validation in the schema doubles as a filesystem-safety gate:
   * a traversal name like `..` must never reach targetPathFor.
   */
  private parseRegistryEntries(
    rawEntries: unknown[],
    mode: "lenient" | "strict" = "lenient"
  ): AgentPluginInstallEntry[] {
    // Strict (mutation) mode must detect duplicate names across RAW entries,
    // BEFORE schema filtering: a valid entry can collide with a same-name
    // entry this build cannot parse (written by a newer version). Raw
    // rewrites match by name — update() would patch and uninstall() would
    // delete BOTH rows, silently destroying the newer version's metadata
    // (upgrade↔downgrade rule).
    if (mode === "strict") {
      const seenRawNames = new Set<string>();
      for (const rawEntry of rawEntries) {
        const rawName = this.rawEntryName(rawEntry);
        if (rawName === undefined) {
          continue;
        }
        if (seenRawNames.has(rawName)) {
          throw new Error(
            `The plugin registry (${shortenHome(this.registryFile)}) contains duplicate entries for '${rawName}'. Repair the file, then retry.`
          );
        }
        seenRawNames.add(rawName);
      }
    }
    const entries: AgentPluginInstallEntry[] = [];
    const seenNames = new Set<string>();
    for (const rawEntry of rawEntries) {
      const parsed = AgentPluginInstallEntrySchema.safeParse(rawEntry);
      if (!parsed.success) {
        log.debug("Skipping unrecognized managed plugin registry entry (preserved on disk)", {
          entry: rawEntry,
          error: parsed.error.message,
        });
        continue;
      }
      // Duplicate names are corrupt identity: entry names map 1:1 to
      // container directories and instance IDs, and raw rewrites match by
      // name — a mutation would patch EVERY duplicate from the first entry's
      // source, silently rewriting the others. Mutations (strict) refuse;
      // views (lenient) keep the first (matching find()-based lookups).
      if (seenNames.has(parsed.data.name)) {
        if (mode === "strict") {
          throw new Error(
            `The plugin registry (${shortenHome(this.registryFile)}) contains duplicate entries for '${parsed.data.name}'. Repair the file, then retry.`
          );
        }
        log.warn("Ignoring duplicate managed plugin registry entry", { name: parsed.data.name });
        continue;
      }
      seenNames.add(parsed.data.name);
      entries.push(parsed.data);
    }
    return entries;
  }

  /**
   * In strict mode, an entry this build cannot parse (a newer version's
   * source kind, or corruption) is an error: callers like checkUpdates would
   * otherwise silently skip that managed install and report a false
   * "everything is up to date".
   */
  private async readRegistry(mode: "lenient" | "strict"): Promise<AgentPluginInstallEntry[]> {
    const { rawEntries } = await this.readRegistryDocument(mode);
    const entries = this.parseRegistryEntries(rawEntries, mode);
    if (mode === "strict" && entries.length !== rawEntries.length) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains ${rawEntries.length - entries.length} entr${rawEntries.length - entries.length === 1 ? "y" : "ies"} this version cannot read (written by a newer version of Mux, or corrupted).`
      );
    }
    return entries;
  }

  /** `name` of a raw registry entry, for identity matching during raw rewrites. */
  private rawEntryName(rawEntry: unknown): string | undefined {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      return undefined;
    }
    const name = (rawEntry as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }

  /**
   * Atomic write that THROWS on failure (unlike Config.saveConfig's
   * log-and-swallow) so callers can roll back filesystem changes instead of
   * reporting success with an unpersisted registry. Takes the RAW envelope
   * and entry list so unrecognized top-level fields and entries are written
   * back verbatim (only `plugins` is replaced).
   */
  private async writeRegistry(
    envelope: Record<string, unknown>,
    rawEntries: unknown[]
  ): Promise<void> {
    await writeFileAtomic(
      this.registryFile,
      JSON.stringify({ ...envelope, plugins: rawEntries }, null, 2),
      "utf-8"
    );
  }

  private assertEnabled(): void {
    if (!this.deps.isEnabled()) {
      throw new Error("Agent Plugins experiment is not enabled.");
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // In-process queue first (cheap), then the cross-process lock: a second
    // process sharing rootDir must not interleave its read-modify-write of
    // plugins.json (or its directory moves) with ours.
    const locked = async (): Promise<T> => {
      const release = await acquireCrossProcessLock({
        lockPath: path.join(this.stagingRoot, MUTATION_LOCK_FILE),
        acquireTimeoutMs: MUTATION_LOCK_ACQUIRE_TIMEOUT_MS,
        staleMs: MUTATION_LOCK_STALE_MS,
        timeoutMessage:
          "Another Mux process is currently modifying plugins. Wait for it to finish and try again.",
      });
      try {
        return await fn();
      } finally {
        await release();
      }
    };
    const run = this.mutationQueue.then(locked, locked);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Lexical install location — the identity `computePluginInstanceId` hashes
   * for global plugins. The name grammar excludes `.`/`..`/separators, so a
   * malformed registry entry can never resolve outside the container (this
   * path is deleted recursively on uninstall).
   */
  private targetPathFor(name: string): string {
    assert(isValidAgentPluginName(name), `invalid plugin name: ${JSON.stringify(name)}`);
    const target = path.join(this.containerDir, name);
    assert(
      path.dirname(target) === this.containerDir,
      "targetPathFor: resolved path must be an immediate child of the container"
    );
    return target;
  }

  private instanceIdFor(name: string): string {
    return computePluginInstanceId(this.targetPathFor(name));
  }

  // ---------------------------------------------------------------------
  // Staging helpers
  // ---------------------------------------------------------------------

  /**
   * Staging lives under ~/.mux (same filesystem as the container) so promote
   * is a plain rename, and outside ~/.mux/plugins so a staged clone can never
   * be discovered as an installed plugin.
   */
  private async createStagingDir(): Promise<string> {
    await fsPromises.mkdir(this.stagingRoot, { recursive: true });
    await this.purgeStaleStaging();
    const dir = await fsPromises.mkdtemp(path.join(this.stagingRoot, "stage-"));
    this.activeStagingPaths.add(dir);
    return dir;
  }

  /**
   * Rename `sourcePath` into the staging root under in-process ownership so
   * stale reclamation cannot reap it mid-operation. Trash names embed a
   * Date.now() stamp because the rename preserves the tree's OLD mtime — an
   * installed tree older than the stale threshold would otherwise be reaped
   * as "stale" the moment it lands in staging, deleting an active rollback
   * copy out from under uninstall/update.
   */
  private async renameIntoStaging(sourcePath: string, trashDir: string): Promise<void> {
    this.activeStagingPaths.add(trashDir);
    try {
      await fsPromises.rename(sourcePath, trashDir);
    } catch (error) {
      this.activeStagingPaths.delete(trashDir);
      throw error;
    }
  }

  /** Best-effort reclaim of staging dirs orphaned by crashes. */
  private async purgeStaleStaging(): Promise<void> {
    try {
      const now = Date.now();
      const entries = await fsPromises.readdir(this.stagingRoot);
      // Journals pin the staged trash dirs they reference: reclaiming a
      // journaled rollback copy by age before reconcileJournals runs would
      // turn a restorable interrupted uninstall/update into data loss. An
      // UNREADABLE journal pins everything it could reference: its staged
      // paths are unknown, so all trash entries stay until it is repaired.
      const journalProtected = new Set<string>();
      let allJournalsReadable = true;
      for (const entry of entries) {
        if (!isJournalName(entry)) {
          continue;
        }
        try {
          const doc = await this.readJournalDocument(path.join(this.stagingRoot, entry));
          for (const field of ["trashDir", "dataTrashDir"]) {
            const staged = this.journalStagedPath(doc, field);
            if (staged !== undefined) {
              journalProtected.add(staged);
            }
          }
        } catch {
          allJournalsReadable = false;
        }
      }
      for (const entry of entries) {
        const entryPath = path.join(this.stagingRoot, entry);
        // Never touch paths an in-process operation still owns, journals
        // (their lifecycle belongs to reconcileJournals), trash dirs a
        // journal still references (or MIGHT reference, when a journal is
        // unreadable), or the durable staging-root state files: the
        // mutation-epoch token must survive (a scan bracket comparing tokens
        // across a deletion would misread every managed plugin as mutated)
        // and the cross-process lock belongs to its holder.
        if (
          this.activeStagingPaths.has(entryPath) ||
          isJournalName(entry) ||
          journalProtected.has(entryPath) ||
          entry === MUTATION_EPOCH_FILE ||
          entry === MUTATION_LOCK_FILE ||
          (!allJournalsReadable && entry.startsWith("trash"))
        ) {
          continue;
        }
        try {
          // Trash names embed their staging time; renames preserve the
          // tree's old mtime, which says nothing about staging age.
          const stampMatch = /^trash(?:-data)?-(\d+)-/.exec(entry);
          const stagedAt =
            stampMatch !== null
              ? Number(stampMatch[1])
              : (await fsPromises.stat(entryPath)).mtimeMs;
          if (now - stagedAt > STALE_STAGING_MAX_AGE_MS) {
            await fsPromises.rm(entryPath, { recursive: true, force: true });
          }
        } catch {
          // Entry vanished or is unreadable — skip.
        }
      }
    } catch {
      // Missing staging root is fine.
    }
  }

  private async removeDir(dirPath: string): Promise<void> {
    await fsPromises.rm(dirPath, { recursive: true, force: true });
    this.activeStagingPaths.delete(dirPath);
  }

  // ---------------------------------------------------------------------
  // Git plumbing
  // ---------------------------------------------------------------------

  /**
   * Resolve what a preview/install/update should check out, via `git
   * ls-remote` (no fetch). When a branch and a tag share the ref name,
   * `preferredRefType` (a tracked entry's stored kind) wins — a remote
   * ADDING a same-name branch must not make a still-valid tracked tag look
   * like it changed kind. New previews without a stored kind stay
   * branch-first.
   */
  private async resolveRemoteRef(
    url: string,
    ref: string | undefined,
    preferredRefType?: "branch" | "tag"
  ): Promise<ResolvedRemoteRef> {
    if (ref !== undefined && isFullCommitSha(ref)) {
      return { ref: ref.toLowerCase(), refType: "commit", sha: ref.toLowerCase() };
    }
    if (ref === undefined) {
      // Remote default branch: `ls-remote --symref <url> HEAD` prints
      //   ref: refs/heads/<default>\tHEAD
      //   <sha>\tHEAD
      const output = await this.lsRemote(url, ["--symref", url, "HEAD"]);
      const symrefMatch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
      const shaMatch = /^([0-9a-f]{40})\s+HEAD$/m.exec(output);
      if (!symrefMatch || !shaMatch) {
        throw new Error(`Could not determine the default branch of ${url}.`);
      }
      return { ref: symrefMatch[1], refType: "branch", sha: shaMatch[1] };
    }

    if (/^[0-9a-f]{7,39}$/i.test(ref)) {
      // A short SHA can't be fetched shallowly and can't be resolved by ls-remote.
      throw new Error(
        `'${ref}' looks like an abbreviated commit SHA. Use the full 40-character SHA, a branch, or a tag.`
      );
    }

    const output = await this.lsRemote(url, [
      url,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ]);
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let branchSha: string | undefined;
    let tagSha: string | undefined;
    let peeledTagSha: string | undefined;
    for (const line of lines) {
      const [sha, refName] = line.split(/\s+/);
      if (!sha || !refName) continue;
      if (refName === `refs/heads/${ref}`) branchSha = sha;
      else if (refName === `refs/tags/${ref}^{}`) peeledTagSha = sha;
      else if (refName === `refs/tags/${ref}`) tagSha = sha;
    }

    // Annotated tags list both the tag object and the peeled commit (^{});
    // lockedSha must be the commit so it can be compared against `rev-parse HEAD`.
    const resolvedTagSha = peeledTagSha ?? tagSha;
    if (preferredRefType === "tag" && resolvedTagSha !== undefined) {
      return { ref, refType: "tag", sha: resolvedTagSha };
    }
    if (branchSha !== undefined) {
      return { ref, refType: "branch", sha: branchSha };
    }
    if (resolvedTagSha !== undefined) {
      return { ref, refType: "tag", sha: resolvedTagSha };
    }
    throw new Error(`Ref '${ref}' was not found on the remote (no matching branch or tag).`);
  }

  private async lsRemote(url: string, args: string[]): Promise<string> {
    try {
      return await runGit(["ls-remote", ...args], { timeoutMs: LS_REMOTE_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`Could not reach ${url}: ${getErrorMessage(error)}`);
    }
  }

  private stagingQuota(): { maxBytes: number; maxFiles: number } {
    return (
      this.deps.stagingQuota ?? { maxBytes: STAGED_TREE_MAX_BYTES, maxFiles: STAGED_TREE_MAX_FILES }
    );
  }

  /**
   * During-clone disk bound for a staging dir: checkout + pack live in it, so
   * allow twice the checkout quota (bytes AND file count — loose objects can
   * mirror the checkout's file count). The watchdog aborts git mid-transfer —
   * the post-clone assertStagedTreeWithinQuota can only reject a tree git
   * already fully materialized on disk.
   */
  private cloneDiskQuota(dir: string): { dir: string; maxBytes: number; maxFiles: number } {
    const quota = this.stagingQuota();
    return { dir, maxBytes: quota.maxBytes * 2, maxFiles: quota.maxFiles * 2 };
  }

  /**
   * Enforce the staged-checkout quota (bytes + entry count, .git excluded,
   * symlinks not followed). Directories count too: each consumes an inode
   * and filesystem metadata, and repeated git tree objects can amplify a
   * tiny pack into thousands of them. Runs immediately after every staged
   * clone so an oversized tree is deleted by the caller's error path before
   * any validation reads it.
   *
   * The same walk validates SYMLINK final-path semantics: component checks
   * (consent preview, update capability comparison) resolve links against
   * the STAGED location, but the tree executes from the promoted location —
   * a relative link that escapes the staged root, or a link whose target
   * does not exist yet, can resolve to something entirely different after
   * promotion (e.g. `hooks.js -> ../../plugins/<name>/payload.js` resolves
   * to nothing in staging but to an executable hook inside the live root
   * post-install, skipping consent). Links that RESOLVE INSIDE the staged
   * root keep their meaning across the promote rename. Absolute links keep
   * their target STRING, but their CONTAINMENT can still flip: a target
   * under the managed plugins container — this plugin's own final install
   * path — resolves into the CURRENTLY INSTALLED tree during an update's
   * staging (outside the staged root, so component discovery excludes it
   * from the consent preview and the capability comparison) yet inside the
   * promoted root after the swap, auto-loading undisclosed content. Links
   * into the container are therefore rejected, by raw target and by
   * resolution; other absolute links keep their meaning and stay subject to
   * runtime escape containment. Everything else is rejected before any
   * commit.
   */
  private async assertStagedTreeWithinQuota(dir: string): Promise<void> {
    const quota = this.stagingQuota();
    const rootReal = await fsPromises.realpath(dir);
    // Both forms of the container path: the raw-target check must catch the
    // guessable lexical path even when nothing exists there yet, and the
    // resolved check must catch realpath-equivalent routes to it.
    const containerReal = await fsPromises
      .realpath(this.containerDir)
      .catch(() => this.containerDir);
    const withinContainer = (candidate: string): boolean =>
      [this.containerDir, containerReal].some(
        (container) => candidate === container || candidate.startsWith(container + path.sep)
      );
    let bytes = 0;
    let entryCount = 0;
    const pending: string[] = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      assert(current !== undefined, "assertStagedTreeWithinQuota: queue underflow");
      for (const entry of await fsPromises.readdir(current, { withFileTypes: true })) {
        if (entry.name === ".git" && current === dir) {
          continue;
        }
        const entryPath = path.join(current, entry.name);
        entryCount += 1;
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile()) {
          const stat = await fsPromises.lstat(entryPath);
          bytes += stat.size;
        } else if (entry.isSymbolicLink()) {
          const relative = path.relative(dir, entryPath);
          const resolvedTarget = await fsPromises.realpath(entryPath).catch(() => undefined);
          if (resolvedTarget === undefined) {
            throw new Error(
              `The repository ships a symbolic link that does not resolve (${relative}). Its target could appear at the install location AFTER the consent preview validated the tree, so unresolvable links are rejected.`
            );
          }
          const rawTarget = await fsPromises.readlink(entryPath);
          const withinStagedRoot =
            resolvedTarget === rootReal || resolvedTarget.startsWith(rootReal + path.sep);
          if (!path.isAbsolute(rawTarget) && !withinStagedRoot) {
            throw new Error(
              `The repository ships a relative symbolic link that escapes the repository root (${relative}). Such links resolve differently after install than during the consent preview, so they are rejected.`
            );
          }
          if (
            path.isAbsolute(rawTarget) &&
            !withinStagedRoot &&
            (withinContainer(path.resolve(rawTarget)) || withinContainer(resolvedTarget))
          ) {
            throw new Error(
              `The repository ships an absolute symbolic link into the managed plugins directory (${relative}). Such links resolve differently after install than during the consent preview, so they are rejected.`
            );
          }
        }
        if (entryCount > quota.maxFiles || bytes > quota.maxBytes) {
          throw new Error(
            `The repository is too large to install as a plugin (limit: ${quota.maxFiles} files, ${Math.floor(quota.maxBytes / (1024 * 1024))} MiB).`
          );
        }
      }
    }
  }

  /** Shallow-clone `resolved` into a fresh staging dir; returns { dir, sha } with sha = HEAD. */
  private async cloneResolved(
    url: string,
    resolved: ResolvedRemoteRef
  ): Promise<{ dir: string; sha: string }> {
    const dir = await this.createStagingDir();
    try {
      if (resolved.refType === "commit") {
        await this.fetchExactSha(url, resolved.sha, dir);
      } else {
        await runGit(
          [
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            resolved.ref,
            "-c",
            "advice.detachedHead=false",
            url,
            dir,
          ],
          { diskQuota: this.cloneDiskQuota(dir) }
        );
      }
      const sha = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      assert(isFullCommitSha(sha), "cloneResolved: rev-parse HEAD must be a full SHA");
      await this.assertStagedTreeWithinQuota(dir);
      return { dir, sha };
    } catch (error) {
      await this.removeDir(dir);
      throw new Error(`Failed to clone ${url}: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Clone exactly `sha` (what the user consented to). Prefers a direct SHA
   * fetch (GitHub allows it); falls back to cloning the tracking ref and
   * verifying HEAD still matches, so a remote that moved between preview and
   * install fails loudly instead of installing unreviewed content.
   */
  private async cloneExactSha(source: AgentPluginGitSource, sha: string): Promise<string> {
    const dir = await this.createStagingDir();
    try {
      try {
        await this.fetchExactSha(source.url, sha, dir);
      } catch {
        if (source.refType === "commit") {
          throw new Error(`Could not fetch commit ${sha} from ${source.url}.`);
        }
        // fetchExactSha left an initialized repo behind; git clone refuses a
        // non-empty destination, so reset the staging dir before falling back.
        await this.removeDir(dir);
        await fsPromises.mkdir(dir, { recursive: true });
        this.activeStagingPaths.add(dir);
        await runGit(
          [
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            source.ref,
            "-c",
            "advice.detachedHead=false",
            source.url,
            dir,
          ],
          { diskQuota: this.cloneDiskQuota(dir) }
        );
      }
      const head = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      if (head !== sha) {
        throw new Error(
          `The remote moved since the preview (expected ${sha.slice(0, 12)}, got ${head.slice(0, 12)}). Run the preview again.`
        );
      }
      await this.assertStagedTreeWithinQuota(dir);
      return dir;
    } catch (error) {
      await this.removeDir(dir);
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  private async fetchExactSha(url: string, sha: string, dir: string): Promise<void> {
    const diskQuota = this.cloneDiskQuota(dir);
    await runGit(["init", "--quiet", dir]);
    await runGit(["-C", dir, "remote", "add", "origin", url]);
    await runGit(["-C", dir, "fetch", "--depth", "1", "origin", sha], { diskQuota });
    await runGit(
      ["-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"],
      { diskQuota }
    );
  }

  // ---------------------------------------------------------------------
  // Staged-clone validation + preview assembly
  // ---------------------------------------------------------------------

  /**
   * Run the exact runtime validation (manifest + component discovery) against
   * a staged clone. Throws user-facing errors for non-plugins, including a
   * clear message for Claude Code plugin/marketplace repos (explicit non-goal).
   */
  private async validateStagedClone(stagedDir: string): Promise<{
    plugin: AgentPluginInfo;
    warnings: string[];
  }> {
    const hasManifest = await pathExists(path.join(stagedDir, "plugin.json"));
    if (!hasManifest) {
      if (
        (await pathExists(path.join(stagedDir, ".claude-plugin", "plugin.json"))) ||
        (await pathExists(path.join(stagedDir, ".claude-plugin", "marketplace.json")))
      ) {
        throw new Error(
          "This repository is a Claude Code plugin or marketplace (found .claude-plugin/). Mux implements the vendor-neutral Agent Plugins 1.0.0 format and cannot install Claude Code collections."
        );
      }
      throw new Error(
        "No plugin.json found at the repository root. The repo is not an Agent Plugin — if the plugin lives in a subdirectory, monorepo subpath installs land in v2."
      );
    }

    // The crash-recovery marker name is RESERVED: install/update write a
    // nonce file at this path just before their promote rename, which would
    // silently replace repository-shipped content (and the commit path then
    // deletes it), leaving the installed tree different from the consented
    // commit. Reject up front instead of corrupting the plugin. lstat, not
    // access: a DANGLING symlink at this path reads as "absent" to
    // access-style checks, and the later nonce writeFile would then follow
    // the attacker-controlled target OUTSIDE the staged tree (e.g. creating
    // ../../plugins.json with nonce content).
    const markerEntry = await fsPromises
      .lstat(path.join(stagedDir, PROMOTION_MARKER_FILE))
      .catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
    if (markerEntry !== undefined) {
      throw new Error(
        `The repository contains a reserved file name (${PROMOTION_MARKER_FILE}) used by the installer's crash recovery. Remove or rename it upstream to install this plugin.`
      );
    }

    const { plugin, diagnostics } = await discoverAgentPluginAt({
      pluginDir: stagedDir,
      scope: "global",
    });
    if (!plugin) {
      const reasons = diagnostics.map((d) => d.message);
      throw new Error(
        reasons.length > 0 ? `Invalid plugin: ${reasons.join("; ")}` : "Invalid plugin manifest."
      );
    }
    return { plugin, warnings: diagnostics.map((d) => d.message) };
  }

  /**
   * Executable hooks.js disclosure for the consent preview: hooks load
   * automatically before request assembly and can observe/rewrite/block tool
   * calls, so installing one without disclosure would consent to less than
   * what activates. toolGrants mirrors resolvePluginHookGrants — the exact
   * grants the runtime will honor.
   */
  private collectHook(
    plugin: Pick<AgentPluginInfo, "rootPath" | "hooksPath" | "manifest">
  ): AgentPluginPreviewHook | undefined {
    if (plugin.hooksPath === undefined) {
      return undefined;
    }
    const grants = resolvePluginHookGrants(plugin.manifest);
    assert(grants.bridgeTools.allow !== "all", "plugin hook grants must enumerate tools");
    return {
      path: path.relative(plugin.rootPath, plugin.hooksPath),
      toolGrants: [...grants.bridgeTools.allow],
    };
  }

  /**
   * Security-relevant capability surface of a plugin tree, mirroring what the
   * install consent preview disclosed:
   * - the auto-loading hook (entry path + tool grants) and MCP servers
   *   (transport + exact argv/env/url, root-path-normalized so staged and
   *   installed trees compare equal) — any change is gated, because both
   *   auto-execute behind stable identities;
   * - skill advertisements (name + description): these are NOT inert — every
   *   request interpolates them into the model-visible skill index
   *   (agent_skill_read's tool description), so a new or reworded skill can
   *   steer the agent without any user action;
   * - agent, workflow, and slash-command NAMES: the preview consented to a
   *   specific component set, so additions are gated. Their bodies were never
   *   part of the preview (they load on explicit invocation), so content
   *   changes ride the normal tree replacement.
   */
  private async capabilitySurface(
    plugin: AgentPluginInfo,
    instanceId: string,
    finalTargetPath: string
  ): Promise<{
    hook: AgentPluginPreviewHook | undefined;
    /** serverName → { fingerprint (compared), display (shown in the update review) }. */
    servers: Map<string, { fingerprint: string; display: string }>;
    /** skillName → { fingerprint (compared), display (the advertisement as the model sees it) }. */
    skills: Map<string, { fingerprint: string; display: string }>;
    agents: Map<string, string>;
    components: Set<string>;
  }> {
    const hook = this.collectHook(plugin);
    const skills = new Map<string, { fingerprint: string; display: string }>();
    for (const skill of await this.collectSkills(plugin, [])) {
      // EVERY model-visible advertisement field: description, whenToUse
      // (both interpolate into the agent_skill_read tool description on each
      // request), and advertise (a flip from hidden to visible surfaces a
      // previously invisible skill). Changing any of them is re-consent
      // territory, same as adding a skill. The fingerprint stays JSON (field
      // boundaries are unambiguous); the display rendering is NOT used for
      // comparison because a multi-line description could imitate it.
      skills.set(skill.name, {
        fingerprint: JSON.stringify({
          description: skill.description ?? null,
          whenToUse: skill.whenToUse ?? null,
          advertise: skill.advertise ?? null,
        }),
        display: [
          skill.description ?? "(no description)",
          ...(skill.whenToUse !== undefined ? [`When to use: ${skill.whenToUse}`] : []),
          ...(skill.advertise === false ? ["(not advertised to the model)"] : []),
        ].join("\n"),
      });
    }
    const agents = new Map<string, string>();
    for (const agent of await this.collectAgentFiles(plugin.agentsDir)) {
      agents.set(agent.name, agent.fingerprint);
    }
    const components = new Set<string>([
      ...(await this.collectComponentFiles(plugin.workflowsDir, ".js")).map((f) => `workflow ${f}`),
      ...(plugin.manifest.contributes?.slashCommands ?? []).map(
        (command) => `slash command /${command.name}`
      ),
    ]);
    const servers = new Map<string, { fingerprint: string; display: string }>();
    if (plugin.mcpConfigPath !== undefined) {
      const { servers: infos } = await loadPluginMcpServers(plugin, {
        xumHome: this.config.rootDir,
        instanceId,
      });
      const normalize = (value: string): string => value.split(plugin.rootPath).join("<plugin>");
      const rewrite = (value: string): string => value.split(plugin.rootPath).join(finalTargetPath);
      for (const info of Object.values(infos)) {
        assert(info.plugin !== undefined, "plugin server info must carry provenance");
        const fingerprint =
          info.transport === "stdio"
            ? JSON.stringify({
                transport: "stdio",
                argv: [info.command, ...(info.args ?? [])].map(normalize),
                // Sorted: env is an unordered map, so a mere property
                // reordering upstream must not read as a capability change.
                env: Object.fromEntries(
                  Object.entries(info.env ?? {})
                    .map(([key, value]): [string, string] => [key, normalize(value)])
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                ),
                // cwd changes relative module/config resolution (e.g. plugin
                // root → writable PLUGIN_DATA), so it is consent-relevant.
                ...(info.cwd !== undefined ? { cwd: normalize(info.cwd) } : {}),
              })
            : JSON.stringify({ transport: info.transport, url: info.url });
        servers.set(info.plugin.serverName, {
          fingerprint,
          display: this.describeMcpServer(info, rewrite, finalTargetPath).summary,
        });
      }
    }
    return { hook, servers, skills, agents, components };
  }

  /**
   * Update gate input: every capability increase/change between the installed
   * tree and the staged new tree, with the consented and staged values so
   * the user can review them in place. A missing or invalid installed tree
   * yields an empty surface, so everything staged counts as an addition
   * (conservative: nothing inspectable was consented to at this path).
   * Capability REMOVALS and grant reductions are not changes here: they
   * apply without re-consent.
   */
  private async collectCapabilityChanges(
    name: string,
    installedPath: string,
    stagedPlugin: AgentPluginInfo
  ): Promise<AgentPluginCapabilityChange[]> {
    const instanceId = this.instanceIdFor(name);
    const { plugin: currentPlugin } = await discoverAgentPluginAt({
      pluginDir: installedPath,
      scope: "global",
    });
    const staged = await this.capabilitySurface(stagedPlugin, instanceId, installedPath);
    const current =
      currentPlugin === null
        ? undefined
        : await this.capabilitySurface(currentPlugin, instanceId, installedPath);

    const changes: AgentPluginCapabilityChange[] = [];
    const describeGrants = (grants: string[]): string =>
      grants.length > 0 ? grants.join(", ") : "(no tool visibility granted)";
    if (staged.hook !== undefined) {
      const currentHook = current?.hook;
      if (currentHook === undefined) {
        const grantSuffix =
          staged.hook.toolGrants.length > 0
            ? ` with tool grants: ${staged.hook.toolGrants.join(", ")}`
            : "";
        changes.push({
          summary: `adds executable hooks (${staged.hook.path}${grantSuffix})`,
          after: `${staged.hook.path} — tool grants: ${describeGrants(staged.hook.toolGrants)}`,
        });
      } else {
        if (staged.hook.path !== currentHook.path) {
          changes.push({
            summary: `moves its hook entry (${currentHook.path} → ${staged.hook.path})`,
            before: currentHook.path,
            after: staged.hook.path,
          });
        }
        const newGrants = staged.hook.toolGrants.filter(
          (grant) => !currentHook.toolGrants.includes(grant)
        );
        if (newGrants.length > 0) {
          changes.push({
            summary: `expands hook tool grants: ${newGrants.join(", ")}`,
            before: describeGrants(currentHook.toolGrants),
            after: describeGrants(staged.hook.toolGrants),
          });
        }
      }
    }
    for (const [serverName, server] of staged.servers) {
      const currentServer = current?.servers.get(serverName);
      if (currentServer === undefined) {
        changes.push({ summary: `adds MCP server '${serverName}'`, after: server.display });
      } else if (currentServer.fingerprint !== server.fingerprint) {
        changes.push({
          summary: `changes MCP server '${serverName}'`,
          before: currentServer.display,
          after: server.display,
        });
      }
    }
    // Skill advertisements interpolate into the model-visible skill index on
    // every request, so a new skill — or a reworded description — can inject
    // instructions without the user ever invoking it. Gate both.
    for (const [skillName, skill] of staged.skills) {
      const currentSkill = current?.skills.get(skillName);
      if (currentSkill === undefined) {
        changes.push({ summary: `adds skill '${skillName}'`, after: skill.display });
      } else if (currentSkill.fingerprint !== skill.fingerprint) {
        changes.push({
          summary: `changes the model-visible advertisement of skill '${skillName}'`,
          before: currentSkill.display,
          after: skill.display,
        });
      }
    }
    // Agent definitions: the description injects into the task tool's
    // model-visible prompt and runnable/base/policy change execution
    // privileges, so a changed definition behind an unchanged filename is
    // gated exactly like an addition. The fingerprint is the key-sorted
    // frontmatter JSON, which is also the most faithful thing to show.
    for (const [agentName, fingerprint] of staged.agents) {
      const currentFingerprint = current?.agents.get(agentName);
      if (currentFingerprint === undefined) {
        changes.push({ summary: `adds agent ${agentName}`, after: fingerprint });
      } else if (currentFingerprint !== fingerprint) {
        changes.push({
          summary: `changes the definition of agent ${agentName}`,
          before: currentFingerprint,
          after: fingerprint,
        });
      }
    }
    // Consent covered a specific component set; additions need a new preview.
    for (const component of staged.components) {
      if (!(current?.components.has(component) ?? false)) {
        changes.push({ summary: `adds ${component}` });
      }
    }
    return changes;
  }

  /**
   * Executable workflow scripts (workflows/*.js) for the consent preview,
   * mirroring the runtime lister (workflowScriptDiscovery: top-level files
   * AND symlinks with the matching extension, sorted). These activate after
   * install, so consent must name them.
   */
  private async collectComponentFiles(
    dir: string | undefined,
    extension: string
  ): Promise<string[]> {
    if (dir === undefined) {
      return [];
    }
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            (entry.isFile() || entry.isSymbolicLink()) &&
            entry.name.toLowerCase().endsWith(extension)
        )
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * Agent definition files (agents/*.md) for the consent preview, mirroring
   * runtime discovery exactly (agentDefinitionsService): only REGULAR files
   * (symlinks never load) whose basename parses as a valid agent ID AND
   * whose CONTENT parses as a runtime-valid definition (size cap included).
   * Filename-only fingerprinting would let an update repair a malformed
   * agents/foo.md in place — identical component sets on both sides — and
   * introduce a runnable agent without re-consent; the preview could
   * likewise advertise an agent that never loads.
   */
  private async collectAgentFiles(
    dir: string | undefined
  ): Promise<Array<{ name: string; fingerprint: string }>> {
    if (dir === undefined) {
      return [];
    }
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const agents: Array<{ name: string; fingerprint: string }> = [];
    // Runtime discovery dedupes by normalized agent ID with the first
    // successfully parsed file winning (discoverAgentDefinitions sets byId
    // once per ID, in the same readdir enumeration order used here). Mirror
    // that: on a case-sensitive filesystem agents/foo.md and agents/FOO.md
    // are ONE loadable agent, so the preview must promise one row and the
    // capability surface must not fingerprint a definition that never loads.
    const seenAgentIds = new Set<string>();
    for (const entry of entries) {
      const agentIdParse = AgentIdSchema.safeParse(
        path.parse(entry.name).name.trim().toLowerCase()
      );
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || !agentIdParse.success) {
        continue;
      }
      if (seenAgentIds.has(agentIdParse.data)) {
        continue;
      }
      let frontmatter: unknown;
      try {
        const filePath = path.join(dir, entry.name);
        const stat = await fsPromises.stat(filePath);
        // Size-check BEFORE reading (mirroring runtime discovery): the parse
        // below applies the same cap, but only after the whole file has been
        // read and UTF-8-decoded — an untrusted repo pouring its checkout
        // quota into one agents/*.md could stall the main process first.
        if (stat.size > MAX_FILE_SIZE) {
          continue;
        }
        const content = await fsPromises.readFile(filePath, "utf8");
        // Throws on malformed frontmatter or oversized content — exactly the
        // definitions runtime discovery would skip.
        frontmatter = parseAgentDefinitionMarkdown({ content, byteSize: stat.size }).frontmatter;
      } catch {
        continue;
      }
      // Seen only AFTER a successful parse, mirroring runtime dedupe: when
      // the enumeration-order winner is malformed (skipped above), the next
      // same-ID file is the one that actually loads.
      seenAgentIds.add(agentIdParse.data);
      // Fingerprint the WHOLE parsed frontmatter (key-sorted so YAML
      // reordering is not a change): description injects into the task
      // tool's model-visible prompt, subagent.runnable/ui gate invocability,
      // and base/tool policy change execution privileges. Any frontmatter
      // change on an unchanged filename is re-consent territory; the BODY
      // (system prompt) loads only on explicit invocation and rides the
      // normal tree replacement like skill bodies.
      agents.push({ name: entry.name, fingerprint: stableStringify(frontmatter) });
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Preview skill rows enriched with the remaining MODEL-VISIBLE frontmatter:
   * whenToUse interpolates into the agent_skill_read tool description and
   * advertise gates that visibility entirely, so the update capability
   * fingerprint must cover them (the oRPC preview schema strips the extras).
   */
  private async collectSkills(
    plugin: Pick<AgentPluginInfo, "rootPath" | "skillsDir">,
    warnings: string[]
  ): Promise<CollectedPluginSkill[]> {
    const skillsDir = plugin.skillsDir;
    if (skillsDir === undefined) {
      return [];
    }
    const skills: CollectedPluginSkill[] = [];
    let entries: string[] = [];
    try {
      // Include symlinked skill dirs, matching runtime discovery
      // (listSkillDirectoriesFromLocalFs): a symlinked skill activates after
      // install, so it MUST appear in the consent preview.
      entries = (await fsPromises.readdir(skillsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
    for (const dirName of entries) {
      const skillPath = path.join(skillsDir, dirName, "SKILL.md");
      // Spec §4.1 containment anchored at the plugin root, mirroring runtime
      // component checks: a symlink escaping the plugin is surfaced as a
      // warning instead of silently ignored.
      let containedSkillPath: string;
      try {
        // allowMissing (matching runtime assertSkillDirValid): resolve through
        // the symlinked dir even when SKILL.md is absent, so an escaping
        // symlink fails containment instead of hiding behind ENOENT.
        containedSkillPath = await ensurePathContained(plugin.rootPath, skillPath, {
          allowMissing: true,
        });
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          warnings.push(`skills/${dirName}: resolves outside the plugin root; it will not load`);
        }
        // ENOENT (unresolvable path) → not a skill dir; skip silently.
        continue;
      }
      let stat;
      try {
        stat = await fsPromises.stat(containedSkillPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // Mirror runtime discovery's directory-name validation: an invalid dir
      // name never loads, and a frontmatter name that mismatches the dir name
      // is rejected at load time. Without both checks here the consent
      // preview (and the update capability surface built from it) would
      // promise a skill that disappears after installation — or classify a
      // never-loading skill as a capability addition.
      const dirNameParsed = SkillNameSchema.safeParse(dirName);
      if (!dirNameParsed.success) {
        warnings.push(`skills/${dirName}: invalid skill directory name; it will not load`);
        continue;
      }
      // Size-check BEFORE reading (mirroring runtime discovery): the parse
      // enforces the same cap, but only after the full read+decode — see the
      // identical guard in collectAgentFiles.
      if (stat.size > MAX_FILE_SIZE) {
        warnings.push(
          `skills/${dirName}: SKILL.md is too large (${stat.size} bytes; max ${MAX_FILE_SIZE}); it will not load`
        );
        continue;
      }
      try {
        const content = await fsPromises.readFile(containedSkillPath, "utf8");
        const parsed = parseSkillMarkdown({
          content,
          byteSize: stat.size,
          directoryName: dirNameParsed.data,
        });
        skills.push({
          name: parsed.frontmatter.name,
          ...(parsed.frontmatter.description !== undefined
            ? { description: parsed.frontmatter.description }
            : {}),
          // Model-visible beyond name/description: whenToUse interpolates
          // into the agent_skill_read tool description, and advertise
          // controls whether the skill appears there at all. Both feed the
          // update capability fingerprint (capabilitySurface), resolved with
          // the same helpers the runtime uses.
          whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
          advertise: resolveSkillAdvertise(parsed.frontmatter),
        });
      } catch (error) {
        warnings.push(`skills/${dirName}: ${getErrorMessage(error)}`);
      }
    }
    return skills;
  }

  /**
   * Normalize the staged plugin's mcp.json into the preview list. Uses the
   * FINAL instance identity so `PLUGIN_DATA` paths shown to the user match
   * what will run; staged-root path fragments are rewritten to the final
   * install path for readability.
   */
  private async collectMcpServers(
    plugin: AgentPluginInfo,
    finalTargetPath: string,
    instanceId: string,
    warnings: string[]
  ): Promise<AgentPluginPreviewMcpServer[]> {
    if (plugin.mcpConfigPath === undefined) {
      return [];
    }
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, {
      xumHome: this.config.rootDir,
      instanceId,
    });
    warnings.push(...diagnostics.map((d) => d.message));

    const rewrite = (value: string): string => value.split(plugin.rootPath).join(finalTargetPath);

    const result: AgentPluginPreviewMcpServer[] = Object.values(servers).map((info) =>
      this.describeMcpServer(info, rewrite, finalTargetPath)
    );
    return result.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  /**
   * Human-readable disclosure of one plugin MCP server, shared by the install
   * consent preview and the update review (so "before"/"after" render exactly
   * like the line the user originally consented to).
   */
  private describeMcpServer(
    info: MCPServerInfo,
    rewrite: (value: string) => string,
    finalTargetPath: string
  ): AgentPluginPreviewMcpServer {
    assert(info.plugin !== undefined, "plugin server info must carry provenance");
    if (info.transport !== "stdio") {
      return {
        serverName: info.plugin.serverName,
        transport: info.transport === "http" ? "http" : "sse",
        summary: info.url,
      };
    }
    // Mirror the runtime's rendering (MCPServerManager shell-quotes every
    // token): the consent preview must show the exact argument boundaries
    // that will run — an arg containing whitespace/quotes could otherwise
    // masquerade as several args or hide a boundary.
    const commandLine =
      info.args !== undefined
        ? [info.command, ...info.args].map(rewrite).map(shellQuote).join(" ")
        : rewrite(info.command);
    // Env VALUES are execution-relevant (e.g. NODE_OPTIONS=--require=…
    // auto-loads code the argv never shows), so consent must disclose the
    // full assignment, quoted like the argv so boundaries are unambiguous.
    const envAssignments = Object.entries(info.env ?? {})
      .filter(([key]) => key !== "PLUGIN_ROOT" && key !== "PLUGIN_DATA")
      .map(([key, value]) => `${key}=${shellQuote(rewrite(value))}`);
    const details: string[] = [];
    // cwd is execution-relevant too: prepareStdioLaunch passes it to the
    // runtime, so `node server.js` resolves scripts/configs relative to
    // it — including from WRITABLE persistent plugin data — and the argv
    // alone would imply a different resolution (capabilitySurface treats
    // cwd as consent-relevant for the same reason). The loader defaults
    // cwd to the plugin root; only a DEVIATION from the reviewed tree
    // root needs calling out.
    if (info.cwd !== undefined && rewrite(info.cwd) !== finalTargetPath) {
      details.push(`cwd: ${shellQuote(rewrite(info.cwd))}`);
    }
    if (envAssignments.length > 0) {
      details.push(`env: ${envAssignments.join(" ")}`);
    }
    return {
      serverName: info.plugin.serverName,
      transport: "stdio",
      summary: details.length > 0 ? `${commandLine} (${details.join("; ")})` : commandLine,
    };
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Stage + validate an install without writing anything permanent. The
   * staged clone is deleted before returning (stateless preview): install
   * re-fetches the exact consented SHA, so cancelling leaves no state.
   */
  private async captureResult<T>(operation: () => Promise<T>) {
    try {
      return { success: true as const, data: await operation() };
    } catch (error) {
      return { success: false as const, error: getErrorMessage(error) };
    }
  }

  previewResult(args: Parameters<AgentPluginInstallService["preview"]>[0]) {
    return this.captureResult(() => this.preview(args));
  }

  installResult(args: Parameters<AgentPluginInstallService["install"]>[0]) {
    return this.captureResult(() => this.install(args));
  }

  listResult() {
    return this.captureResult(() => this.list());
  }

  uninstallResult(args: Parameters<AgentPluginInstallService["uninstall"]>[0]) {
    return this.captureResult(() => this.uninstall(args));
  }

  checkUpdatesResult() {
    return this.captureResult(() => this.checkUpdates());
  }

  updateResult(args: Parameters<AgentPluginInstallService["update"]>[0]) {
    return this.captureResult(() => this.update(args));
  }

  previewUpdateResult(args: Parameters<AgentPluginInstallService["previewUpdate"]>[0]) {
    return this.captureResult(() => this.previewUpdate(args));
  }

  async preview(args: {
    input: string;
    ref?: string | undefined;
    subpath?: string | undefined;
  }): Promise<AgentPluginInstallPreview> {
    this.assertEnabled();

    const parsed = parseAgentPluginSourceInput(args.input);
    const explicitRef = args.ref?.trim() ?? "";
    if (explicitRef.length > 0 && parsed.ref !== undefined && parsed.ref !== explicitRef) {
      throw new Error(
        `Conflicting refs: '@${parsed.ref}' in the source and '${explicitRef}' in the ref field.`
      );
    }
    const ref = parsed.ref ?? (explicitRef.length > 0 ? explicitRef : undefined);
    const subpath = parsed.subpath ?? (args.subpath?.trim() ? args.subpath.trim() : undefined);
    if (subpath !== undefined) {
      // Approved v1 scope: the descriptor grammar knows subpaths, installs don't.
      throw new Error(
        "Monorepo subpath installs land in v2. Point at a repo whose root is the plugin."
      );
    }

    const resolved = await this.resolveRemoteRef(parsed.url, ref);
    const { dir: stagedDir, sha } = await this.cloneResolved(parsed.url, resolved);
    try {
      const { plugin, warnings } = await this.validateStagedClone(stagedDir);
      const targetPath = this.targetPathFor(plugin.name);
      await this.assertNoCollision(plugin.name);

      const skills = await this.collectSkills(plugin, warnings);
      const mcpServers = await this.collectMcpServers(
        plugin,
        targetPath,
        this.instanceIdFor(plugin.name),
        warnings
      );
      const hook = this.collectHook(plugin);
      const agents = (await this.collectAgentFiles(plugin.agentsDir)).map((agent) => agent.name);
      const workflows = await this.collectComponentFiles(plugin.workflowsDir, ".js");
      const slashCommands = (plugin.manifest.contributes?.slashCommands ?? []).map((command) => ({
        name: command.name,
        ...(command.description !== undefined ? { description: command.description } : {}),
      }));

      if (resolved.refType === "tag" && sha !== resolved.sha) {
        warnings.push(
          `Tag '${resolved.ref}' moved between resolution and clone — installing ${sha.slice(0, 12)}.`
        );
      }

      const source: AgentPluginGitSource = {
        type: "git",
        url: parsed.url,
        ref: resolved.ref,
        refType: resolved.refType,
      };
      return {
        source,
        lockedSha: sha,
        manifest: manifestSummary(plugin.manifest),
        skills,
        mcpServers,
        ...(hook !== undefined ? { hook } : {}),
        agents,
        workflows,
        slashCommands,
        warnings,
        targetPath: shortenHome(targetPath),
      };
    } finally {
      await this.removeDir(stagedDir);
    }
  }

  private async assertNoCollision(name: string): Promise<void> {
    // Strict: a corrupted registry must fail installs up front (with the
    // repair message) instead of letting a later strict read fail mid-flow.
    // Collide on RAW entry names, not just parsed ones: an entry this build
    // cannot parse (written by a newer build) still owns its name — the
    // install rewrite would otherwise filter it out and replace it.
    const { rawEntries } = await this.readRegistryDocument("strict");
    if (rawEntries.some((rawEntry) => this.rawEntryName(rawEntry) === name)) {
      throw new Error(`A managed plugin named '${name}' is already installed. Uninstall it first.`);
    }
    if (await pathExists(this.targetPathFor(name))) {
      // Never overwrite: an unmanaged dir may hold local work.
      throw new Error(
        `${shortenHome(this.targetPathFor(name))} already exists. Remove the directory first — the installer never overwrites.`
      );
    }
  }

  /** Fetch the consented SHA, validate again, promote into the container, and record the registry entry. */
  async install(args: {
    source: AgentPluginGitSource;
    expectedSha: string;
  }): Promise<AgentPluginInstallEntry> {
    this.assertEnabled();
    assert(isFullCommitSha(args.expectedSha), "install: expectedSha must be a full commit SHA");
    // Re-checked here (not just in source-input parsing): a direct API
    // request can hand install() a source that never went through the
    // parser, and this URL is persisted to plugins.json and rendered in
    // Settings.
    assertNoAgentPluginUrlCredentials(args.source.url);
    if (args.source.subpath !== undefined) {
      throw new Error("Monorepo subpath installs land in v2.");
    }

    return this.runExclusive(async () => {
      const stagedDir = await this.cloneExactSha(args.source, args.expectedSha);
      try {
        const { plugin } = await this.validateStagedClone(stagedDir);
        const name = plugin.name;
        await this.assertNoCollision(name);
        await this.assertNoPendingOverridePrune(name);
        await this.assertNoResidualInstanceState(name);
        // A retained uninstall journal means a previous uninstall of this
        // name still has unfinished recovery (staged assets to restore or
        // delete). Block the reinstall until it resolves: with a fresh
        // registry entry present, recoverInterruptedUninstall could no longer
        // tell that old journal from an uncommitted uninstall of THIS install
        // and would restore the old data over it. Recovery runs at startup
        // and on section open, so this self-heals.
        if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, name))) {
          throw new Error(
            `A previous uninstall of '${name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
          );
        }
        const targetPath = this.targetPathFor(name);

        // The installed tree is a plain content snapshot: the registry holds
        // all provenance, and updates replace the directory wholesale, so a
        // .git dir would only invite in-place edits that updates discard.
        await this.removeDir(path.join(stagedDir, ".git"));

        // Journal the promotion BEFORE the rename: a process crash between
        // the rename and the registry write would otherwise strand a tree
        // that discovery lists as unmanaged, assertNoCollision blocks, and
        // uninstall refuses — reconcileJournals uses this record to clean it
        // up on startup or the next section open. The marker nonce (riding
        // inside the tree through the rename) proves the tree recovery finds
        // at the target is the one WE promoted: a user could delete the
        // orphan while the app is stopped and place their own unmanaged
        // plugin at the same path, which cleanup must never delete.
        const promotionNonce = randomBytes(16).toString("hex");
        await fsPromises.writeFile(path.join(stagedDir, PROMOTION_MARKER_FILE), promotionNonce);
        const journalPath = this.journalPath(PROMOTION_JOURNAL_PREFIX, name);
        await this.writeJournalFile(journalPath, {
          name,
          stagedAt: Date.now(),
          nonce: promotionNonce,
        });

        await fsPromises.mkdir(this.containerDir, { recursive: true });
        await fsPromises.rename(stagedDir, targetPath);

        const entry: AgentPluginInstallEntry = {
          name,
          scope: "global",
          source: args.source,
          lockedSha: args.expectedSha,
          installedAt: new Date().toISOString(),
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        try {
          const { envelope, rawEntries } = await this.readRegistryDocument("strict");
          await this.writeRegistry(envelope, [
            ...rawEntries.filter((rawEntry) => this.rawEntryName(rawEntry) !== name),
            entry,
          ]);
        } catch (error) {
          // No partial state: a promote without a registry entry would look
          // like an unmanaged dir and block reinstall. Each cleanup step is
          // isolated so a failure (e.g. a locked file on Windows) cannot
          // skip the others or mask the registry error.
          const cleanupNotes: string[] = [];
          let promotedTreeHandled = true;
          let treeRemoved = false;
          try {
            await this.removeDir(targetPath);
            treeRemoved = true;
          } catch {
            // Retried below after the plugin's processes are stopped — a
            // running server can be exactly what holds the lock.
          }
          // A getToolsForWorkspace running during the promote↔rollback window
          // can have discovered the briefly-visible tree and be starting a
          // server from it; invalidate the prefix (same as update/uninstall)
          // so it is closed instead of surviving the failed install. Must run
          // even when the rollback deletion above failed.
          try {
            await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
              `plugin:${this.instanceIdFor(name)}:`
            );
          } catch (cleanupError) {
            cleanupNotes.push(
              `the plugin's MCP servers could not be stopped (${getErrorMessage(cleanupError)})`
            );
          }
          if (!treeRemoved) {
            // Retry now that the lock-holding processes are gone; if the tree
            // still cannot be deleted, QUARANTINE it into the staging root so
            // the globally scanned plugins container cannot rediscover and
            // load it as an unmanaged plugin (stale-dir reclamation cleans
            // staging leftovers).
            try {
              await this.removeDir(targetPath);
            } catch {
              const quarantineDir = path.join(this.stagingRoot, `trash-${Date.now()}-${name}`);
              try {
                await this.renameIntoStaging(targetPath, quarantineDir);
                await this.removeDir(quarantineDir).catch(() => undefined);
              } catch (cleanupError) {
                // The tree is stuck in the container (marker still inside):
                // the journal must SURVIVE as the recovery record — the next
                // reconciliation identifies the orphan by nonce and retries
                // the quarantine once the lock clears; without it the failed
                // install permanently blocks reinstalls via assertNoCollision.
                promotedTreeHandled = false;
                cleanupNotes.push(
                  `the promoted plugin tree could not be removed — it will be cleaned up automatically, or delete ${shortenHome(targetPath)} manually (${getErrorMessage(cleanupError)})`
                );
              }
            }
            // Re-invalidate AFTER the retry/quarantine: a workspace startup
            // that began after the stop above snapshots the newer epoch, can
            // still have discovered the then-visible tree, and would publish
            // after it disappears with no later invalidation covering it
            // (update/uninstall do the same second post-removal stop).
            try {
              await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
                `plugin:${this.instanceIdFor(name)}:`
              );
            } catch (cleanupError) {
              cleanupNotes.push(
                `the plugin's MCP servers could not be re-stopped after removal (${getErrorMessage(cleanupError)})`
              );
            }
          }
          if (!promotedTreeHandled) {
            // Keep the discovery gate closed NOW: the orphan is discoverable
            // in the container until reconciliation quarantines it, and the
            // current process's health snapshot predates this failure.
            this.markUnreconciled();
          } else {
            // Rollback handled the tree: the journal's crash-recovery job is
            // done.
            await this.consumeJournalFile(journalPath).catch(() => undefined);
          }
          const notes = cleanupNotes.length > 0 ? ` Additionally, ${cleanupNotes.join("; ")}.` : "";
          throw new Error(
            `Failed to persist the plugin registry: ${getErrorMessage(error)}${notes}`
          );
        }
        // Registry write committed (entry recorded): the journal's
        // crash-recovery job is done.
        await this.consumeJournalFile(journalPath).catch(() => undefined);
        // Committed: the marker did its crash-recovery job (a failed removal
        // leaves a stray dotfile the next update swap discards — harmless).
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
        log.info(`Installed agent plugin '${name}' at ${args.expectedSha.slice(0, 12)}`);
        return entry;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }

  private journalPath(prefix: string, name: string): string {
    // Names are grammar-validated (no separators/traversal), so this join is safe.
    return path.join(this.stagingRoot, `${prefix}${name}.json`);
  }

  /**
   * Publish a journal atomically (temp + rename, like the epoch file):
   * readJournalForRecovery deliberately retains any unparseable journal and
   * the discovery gate then suppresses the whole managed container, so a
   * crash mid-writeFile must never leave truncated JSON at the journal path.
   * The temp name keeps the `.json` suffix off, so journal enumeration
   * (isJournalName + `.json`) can never pick up a half-written file.
   */
  private async writeJournalFile(
    journalPath: string,
    document: Record<string, unknown>
  ): Promise<void> {
    const tempPath = `${journalPath}.${randomBytes(8).toString("hex")}.tmp`;
    await fsPromises.writeFile(tempPath, JSON.stringify(document));
    try {
      await fsPromises.rename(tempPath, journalPath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Consume a journal whose transaction/recovery job finished: bump the
   * container mutation epoch FIRST, then delete the file. The epoch bump is
   * what lets a discovery-gate bracket (pre/post scan reads, in this or any
   * sibling process) detect a mutation whose whole journal lifetime fit
   * inside its scan window. A bump failure keeps the journal — callers treat
   * that as a failed consumption — rather than deleting the last visible
   * trace of the mutation.
   */
  private async consumeJournalFile(journalPath: string): Promise<void> {
    await bumpContainerMutationEpoch(this.stagingRoot);
    await fsPromises.rm(journalPath, { force: true });
  }

  /**
   * Parse a journal file into its raw object. Returns null when the file is
   * MISSING (ENOENT). THROWS on any other read/parse failure (truncated
   * write, transient I/O, permissions): an unreadable journal's recovery
   * instructions are unknown, so callers must treat it as UNRESOLVED — keep
   * the journal and its discovery suppression for a later repair attempt —
   * rather than consume it. Degrading the failure to "field absent" would
   * let recovery leave an orphaned promotion live as an unmanaged plugin
   * (unreadable nonce) or abandon an interrupted update's staged original
   * while the registry points at a missing tree (unreadable trashDir).
   */
  private async readJournalDocument(journalPath: string): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(journalPath, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown; // Malformed JSON throws (fail closed).
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Plugin journal has a non-object root: ${journalPath}`);
    }
    return parsed as Record<string, unknown>;
  }

  /** A string field from a parsed journal document, or undefined when absent. */
  private journalStringField(
    doc: Record<string, unknown> | null,
    field: string
  ): string | undefined {
    const value = doc?.[field];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * A staged path recorded in a journal, or undefined when absent/invalid.
   * Defensive: recovery renames/deletes these paths, so a corrupted journal
   * must never aim them anywhere but a direct trash child of the staging root.
   */
  private journalStagedPath(
    doc: Record<string, unknown> | null,
    field: string
  ): string | undefined {
    const value = this.journalStringField(doc, field);
    if (value === undefined) {
      return undefined;
    }
    if (path.dirname(value) !== this.stagingRoot || !path.basename(value).startsWith("trash-")) {
      return undefined;
    }
    return value;
  }

  /**
   * Read a recovery journal's document for a recover* helper. Returns
   * `{ unreadable: true }` when the journal cannot be read/parsed — the
   * caller must return false (journal retained, discovery stays suppressed).
   */
  private async readJournalForRecovery(
    journalPath: string,
    name: string
  ): Promise<{ doc: Record<string, unknown> | null; unreadable: false } | { unreadable: true }> {
    try {
      return { doc: await this.readJournalDocument(journalPath), unreadable: false };
    } catch (error) {
      log.warn("Plugin recovery journal is unreadable; keeping it for a later repair attempt", {
        name,
        journalPath,
        error: getErrorMessage(error),
      });
      return { unreadable: true };
    }
  }

  /**
   * Crash recovery for mutations that died between their directory moves and
   * the registry write. Each journal proves WE created the referenced state
   * from a registry-owned tree or a staged clone (it is not user-authored
   * work), so it is safe to restore or clear. Runs at service startup (a
   * session can serve agent requests — global discovery, MCP config, hooks —
   * without ever opening the Plugins section) and again on section open,
   * under the mutation queue so it cannot interleave with a live mutation.
   */
  private async reconcileJournals(): Promise<boolean> {
    let journalNames: string[];
    try {
      journalNames = (await fsPromises.readdir(this.stagingRoot)).filter(
        (entry) => isJournalName(entry) && entry.endsWith(".json")
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return true; // No staging root: nothing was ever staged.
      }
      // A staging root we cannot ENUMERATE (transient I/O, permissions) may
      // hold journals for unreconciled trees; reporting healthy here would
      // open the discovery gate over them. Fail closed and retry later.
      log.warn("Failed to enumerate the plugin staging root for journal recovery", {
        stagingRoot: this.stagingRoot,
        error: getErrorMessage(error),
      });
      return false;
    }
    if (journalNames.length === 0) {
      return true;
    }
    return this.runExclusive(async () => {
      // STRICT read: a temporarily unreadable or corrupted registry must not
      // degrade to an empty entry list here — reconciliation would then treat
      // committed installs as orphans and delete their trees, turning a
      // recoverable read problem into data loss. Throwing retains every
      // journal for a later retry; callers log and continue.
      const registryNames = new Set(
        (await this.readRegistryDocument("strict")).rawEntries
          .map((rawEntry) => this.rawEntryName(rawEntry))
          .filter((name): name is string => name !== undefined)
      );
      // Health result: every journal must end CONSUMED (its recovery job
      // done and the file gone). A retained journal — failed restore or
      // quarantine, unidentified tree at the target, or even a failed
      // journal deletion — means unreconciled state may still sit in the
      // managed container, so the discovery gate must keep suppressing it;
      // resolving successfully here would open the gate over that state.
      let allConsumed = true;
      for (const journalName of journalNames) {
        const journalPath = path.join(this.stagingRoot, journalName);
        const prefix = JOURNAL_PREFIXES.find((candidate) => journalName.startsWith(candidate));
        assert(prefix !== undefined, "reconcileJournals: filtered journal lost its prefix");
        const name = journalName.slice(prefix.length, -".json".length);
        if (!isValidAgentPluginName(name)) {
          await this.consumeJournalFile(journalPath).catch(() => undefined);
          continue;
        }
        const consumed =
          prefix === PROMOTION_JOURNAL_PREFIX
            ? await this.recoverOrphanedPromotion(name, journalPath, registryNames)
            : prefix === UPDATE_JOURNAL_PREFIX
              ? await this.recoverInterruptedUpdateSwap(name, journalPath, registryNames)
              : await this.recoverInterruptedUninstall(name, journalPath, registryNames);
        if (!consumed) {
          allConsumed = false;
          continue;
        }
        try {
          await this.consumeJournalFile(journalPath);
        } catch (error) {
          allConsumed = false;
          log.warn("Failed to delete a consumed plugin journal; will retry", {
            journalPath,
            error: getErrorMessage(error),
          });
        }
      }
      return allConsumed;
    });
  }

  /**
   * Install crashed between the promote rename and the registry write: the
   * orphan would be listed as unmanaged, block reinstalling the same name,
   * and refuse uninstall (not managed). Returns true when the journal's
   * recovery job is done.
   */
  private async recoverOrphanedPromotion(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const targetPath = this.targetPathFor(name);
    if (registryNames.has(name)) {
      // The install committed and only the journal deletion was lost; sweep
      // the marker the commit path would have removed — but only when the
      // marker is OURS (nonce match). A LATER mutation may own the live tree
      // by now: if an update crashed after promoting its replacement, the
      // marker at the target carries the UPDATE journal's nonce, and blindly
      // deleting it would make update recovery misread the live tree as an
      // unrecognized user replacement (staged old tree + markerless target)
      // and suppress the container forever.
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      if (journalNonce !== undefined && treeNonce === journalNonce) {
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
      }
      return true;
    }
    // Only an ORPHAN (tree without registry entry) needs cleanup.
    if (await pathExists(targetPath)) {
      // Verify the tree is the one WE promoted before deleting anything: the
      // user can delete the orphan while the app is stopped and place their
      // own unmanaged plugin at the same path (a supported use of the
      // globally scanned container). The marker nonce is non-reusable —
      // unlike dev/ino, which the filesystem can hand right back to a
      // recreated directory. A mismatch or missing marker means our orphan
      // is already gone, so consume the journal WITHOUT touching the
      // replacement.
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      const isPromotedTree =
        journalNonce !== undefined && treeNonce !== undefined && treeNonce === journalNonce;
      if (!isPromotedTree) {
        log.warn(
          "Skipping orphaned-promotion cleanup: the tree at the plugin path is not the promoted one",
          { name }
        );
        return true;
      }
      log.warn("Cleaning up plugin promotion orphaned by a crash", { name });
      const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
      const quarantineDir = path.join(this.stagingRoot, `trash-${Date.now()}-${name}`);
      try {
        await this.renameIntoStaging(targetPath, quarantineDir);
        await this.removeDir(quarantineDir).catch(() => undefined);
      } catch (error) {
        // Keep the journal so the next reconciliation retries.
        log.warn("Failed to clean up orphaned plugin promotion", {
          name,
          error: getErrorMessage(error),
        });
        return false;
      }
      // Re-invalidate AFTER the tree left the container: a workspace startup
      // that began after the stop above can have discovered the then-visible
      // tree and would otherwise publish a server from the removed tree.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
    }
    return true;
  }

  /**
   * Update crashed between renaming the OLD live tree into staging and
   * promoting the staged replacement: the registry records an install whose
   * path is missing, and retrying Update self-rejects (the missing tree reads
   * as an empty capability surface). Restore the old tree from staging.
   */
  private async recoverInterruptedUpdateSwap(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const targetPath = this.targetPathFor(name);
    const trashDir = this.journalStagedPath(journal.doc, "trashDir");
    if (await pathExists(targetPath)) {
      const journalNonce = this.journalStringField(journal.doc, "nonce");
      const treeNonce = await fsPromises
        .readFile(path.join(targetPath, PROMOTION_MARKER_FILE), "utf-8")
        .catch(() => undefined);
      if (journalNonce !== undefined && treeNonce === journalNonce) {
        // OUR promoted replacement landed. Two states reach here: the live
        // update failed only its journal DELETION (registry already updated)
        // — or the process died between the promote and the registry write,
        // leaving the registry claiming the OLD commit while the (already
        // capability-reviewed) replacement runs. The recorded newSha
        // distinguishes them: reconcile provenance FIRST, before the journal
        // is consumed, so lockedSha/manifest can never silently keep
        // describing a tree that no longer exists (a forced branch move back
        // to the stale SHA would even hide the update badge).
        const newSha = this.journalStringField(journal.doc, "newSha");
        if (newSha !== undefined && isFullCommitSha(newSha)) {
          try {
            const reconciled = await this.reconcilePromotedUpdateProvenance(
              name,
              targetPath,
              newSha
            );
            if (!reconciled) {
              return false; // Keep the journal; retried next reconciliation.
            }
          } catch (error) {
            log.warn("Failed to reconcile registry provenance for a promoted update", {
              name,
              error: getErrorMessage(error),
            });
            return false;
          }
        }
        // Finish the lost cleanup. Journal FIRST, and ENFORCED (mirrors the
        // update path): removing the marker while the journal survives would
        // strand a markerless target that the next recovery misclassifies as
        // a user replacement, deadlocking updates — so a failed journal
        // deletion must abort cleanup and keep the marker as the tree's
        // identity.
        try {
          await this.consumeJournalFile(journalPath);
        } catch (error) {
          log.warn("Failed to delete the update journal; keeping the tree marker for retry", {
            name,
            error: getErrorMessage(error),
          });
          return false;
        }
        // Journal gone: a stray marker or trash dir is harmless if these
        // best-effort removals fail (nothing references them anymore).
        await fsPromises
          .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
          .catch(() => undefined);
        if (trashDir !== undefined) {
          await this.removeDir(trashDir).catch(() => undefined);
        }
        return true;
      }
      if (trashDir === undefined || !(await pathExists(trashDir))) {
        // Nothing recoverable is staged: the swap never moved the old tree
        // (or it was already restored), so the live tree is the install.
        return true;
      }
      // The target holds a tree WITHOUT our nonce while the old tree is
      // still staged: a user created an unmanaged plugin at the then-empty
      // target while the app was stopped. The registry would wrongly claim
      // it (a later Update/Uninstall could overwrite or delete it) — keep
      // the journal, which also pins the staged original against
      // reclamation and blocks further updates until resolved.
      log.warn(
        "Update recovery found an unrecognized tree at the plugin path; keeping the staged original",
        { name }
      );
      return false;
    }
    if (trashDir === undefined || !(await pathExists(trashDir))) {
      log.warn("Update swap journal has no recoverable tree", { name });
      return true;
    }
    if (!registryNames.has(name)) {
      // The entry was since removed (e.g. a registry-only uninstall while
      // recovery kept failing): restoring would recreate an unmanaged orphan.
      await this.removeDir(trashDir).catch(() => undefined);
      return true;
    }
    log.warn("Restoring plugin tree after an update swap interrupted by a crash", { name });
    try {
      await fsPromises.mkdir(this.containerDir, { recursive: true });
      await fsPromises.rename(trashDir, targetPath);
    } catch (error) {
      log.warn("Failed to restore plugin tree from an interrupted update swap", {
        name,
        error: getErrorMessage(error),
      });
      return false;
    }
    return true;
  }

  /**
   * Commit a promoted-but-unrecorded update's provenance into the registry:
   * lockedSha from the journal, version/description re-read from the promoted
   * tree's own plugin.json (the tree IS the source of truth for its manifest;
   * its .git was stripped, so the SHA must ride in the journal). No-ops when
   * the entry is gone (registry-only uninstall raced recovery) or already
   * records the new SHA (the live update only lost its journal deletion).
   * Returns false when the promoted tree's manifest cannot be read — the
   * journal must survive so a transient read failure is retried rather than
   * committing a SHA whose manifest summary silently stays stale.
   */
  private async reconcilePromotedUpdateProvenance(
    name: string,
    targetPath: string,
    newSha: string
  ): Promise<boolean> {
    const { envelope, rawEntries } = await this.readRegistryDocument("strict");
    const rawEntry = rawEntries.find((entry) => this.rawEntryName(entry) === name);
    if (rawEntry === undefined) {
      return true;
    }
    const currentSha = (rawEntry as Record<string, unknown>).lockedSha;
    if (currentSha === newSha) {
      return true;
    }
    const { plugin } = await discoverAgentPluginAt({ pluginDir: targetPath, scope: "global" });
    if (!plugin) {
      log.warn("Promoted update tree has an unreadable manifest; keeping the journal", { name });
      return false;
    }
    await this.writeRegistry(
      envelope,
      rawEntries.map((entry) => {
        if (this.rawEntryName(entry) !== name) {
          return entry;
        }
        const rawRecord = entry as Record<string, unknown>;
        const rawManifest =
          typeof rawRecord.manifest === "object" &&
          rawRecord.manifest !== null &&
          !Array.isArray(rawRecord.manifest)
            ? (rawRecord.manifest as Record<string, unknown>)
            : {};
        // Same raw-patch rules as the update path: only the fields this
        // reconciliation owns are replaced; unknown keys pass through.
        const {
          version: _staleVersion,
          description: _staleDescription,
          ...preservedManifest
        } = rawManifest;
        return {
          ...rawRecord,
          lockedSha: newSha,
          updatedAt: new Date().toISOString(),
          manifest: {
            ...preservedManifest,
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
      })
    );
    log.info(
      `Reconciled registry provenance for '${name}' after an interrupted update (→ ${newSha.slice(0, 12)})`
    );
    return true;
  }

  /**
   * Uninstall crashed between staging the plugin's assets into trash and the
   * registry commit (registry still owns the plugin → restore everything), or
   * between the commit and the trash cleanup (entry gone → finish deleting).
   */
  private async recoverInterruptedUninstall(
    name: string,
    journalPath: string,
    registryNames: Set<string>
  ): Promise<boolean> {
    const journal = await this.readJournalForRecovery(journalPath, name);
    if (journal.unreadable) {
      return false;
    }
    const trashDir = this.journalStagedPath(journal.doc, "trashDir");
    const dataTrashDir = this.journalStagedPath(journal.doc, "dataTrashDir");
    if (!registryNames.has(name)) {
      // Committed: the staged assets are trash. Delete them now — the user
      // may have explicitly requested the data deletion, and stale-staging
      // reclamation only runs during a later staging operation. A failed
      // deletion (e.g. a Windows file lock) RETAINS the journal as the
      // durable retry record; that also keeps same-name reinstalls blocked
      // (install()'s journal gate), so this branch stays the only reachable
      // one for this journal.
      let cleaned = true;
      for (const staged of [trashDir, dataTrashDir]) {
        if (staged === undefined) {
          continue;
        }
        await this.removeDir(staged).catch((error: unknown) => {
          cleaned = false;
          log.warn("Failed to delete staged assets of a committed uninstall; will retry", {
            staged,
            error: getErrorMessage(error),
          });
        });
      }
      return cleaned;
    }
    log.warn("Restoring plugin assets after an uninstall interrupted by a crash", { name });
    let restored = true;
    const targetPath = this.targetPathFor(name);
    if (trashDir !== undefined && (await pathExists(trashDir))) {
      if (await pathExists(targetPath)) {
        // The container path is occupied (e.g. the user manually recreated
        // it): renaming over it would clobber that tree. Leave the staged
        // copy and the journal for manual/later resolution.
        log.warn("Uninstall recovery found the plugin path occupied; keeping the staged tree", {
          name,
        });
        restored = false;
      } else {
        try {
          await fsPromises.mkdir(this.containerDir, { recursive: true });
          await fsPromises.rename(trashDir, targetPath);
        } catch (error) {
          log.warn("Failed to restore plugin tree from an interrupted uninstall", {
            name,
            error: getErrorMessage(error),
          });
          restored = false;
        }
      }
    }
    if (dataTrashDir !== undefined && (await pathExists(dataTrashDir))) {
      const dataPath = getPluginDataPath(this.config.rootDir, this.instanceIdFor(name));
      // A server launch since restart can have recreated a fresh dataPath
      // (prepareStdioLaunch mkdirs it): stop the plugin's servers and clear
      // it so the ORIGINAL data slides back (mirrors the inline rollback).
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
        buildPluginServerKey(this.instanceIdFor(name), "")
      );
      if (await pathExists(dataPath)) {
        await this.removeDir(dataPath).catch(() => undefined);
      }
      try {
        await fsPromises.mkdir(path.dirname(dataPath), { recursive: true });
        await fsPromises.rename(dataTrashDir, dataPath);
      } catch (error) {
        log.warn("Failed to restore plugin data from an interrupted uninstall", {
          name,
          error: getErrorMessage(error),
        });
        restored = false;
      }
    }
    return restored;
  }

  /** Managed registry entries merged with unmanaged plugins found by global discovery. */
  async list(): Promise<AgentPluginListItem[]> {
    this.assertEnabled();

    // Section open re-runs crash recovery (the startup pass may have failed
    // or predates recent journals) BEFORE discovery scans the container, so
    // an orphaned promotion never renders as an unmanaged row and interrupted
    // update/uninstall swaps are restored before their rows would look wrong.
    // Reassigning the state BEFORE awaiting lets a concurrent discovery gate
    // wait on this fresh attempt (reconcileJournals serializes internally via
    // runExclusive); a success here re-opens a previously suppressed
    // container.
    await this.reconciliationState;
    this.reconciliationState = this.attemptReconcileJournals("section open");
    await this.reconciliationState;

    // Section open is the natural retry moment for override-prune tombstones
    // left by uninstalls whose workspaces were temporarily unreachable.
    await this.retryPendingOverridePrunes().catch((error: unknown) => {
      log.warn("Failed to retry pending override prunes", { error: getErrorMessage(error) });
    });

    const registry = await this.readRegistry("lenient");
    const containers: AgentPluginContainer[] = [
      { path: this.containerDir, scope: "global" },
      { path: path.join(os.homedir(), ".agents", "plugins"), scope: "global" },
    ];
    const { plugins } = await discoverAgentPlugins(containers);

    const items: AgentPluginListItem[] = [];
    const managedByName = new Map(registry.map((entry) => [entry.name, entry]));

    for (const plugin of plugins) {
      const isManagedLocation =
        plugin.containerPath === this.containerDir && managedByName.has(plugin.dirName);
      const entry = isManagedLocation ? managedByName.get(plugin.dirName) : undefined;
      if (entry) {
        managedByName.delete(plugin.dirName);
      }

      const warnings: string[] = [];
      const skillCount = (await this.collectSkills(plugin, warnings)).length;
      let mcpServerCount = 0;
      if (plugin.mcpConfigPath !== undefined) {
        try {
          const { servers } = await loadPluginMcpServers(plugin, {
            xumHome: this.config.rootDir,
            instanceId: computePluginInstanceId(path.join(plugin.containerPath, plugin.dirName)),
          });
          mcpServerCount = Object.keys(servers).length;
        } catch (error) {
          log.warn(`Agent plugin ${plugin.rootPath}: failed to count MCP servers`, { error });
        }
      }

      // Managed rows keep their REGISTRY identity: update/uninstall look
      // entries up by this name, so a locally edited/corrupted manifest name
      // must not make the row unrepairable from Settings. The drift is still
      // surfaced in the description.
      const manifestNameDrift =
        entry !== undefined && plugin.name !== entry.name
          ? `plugin.json names itself '${plugin.name}' — the installed name '${entry.name}' stays authoritative.`
          : undefined;
      const description = manifestNameDrift ?? plugin.manifest.description;
      items.push({
        name: entry?.name ?? plugin.name,
        managed: entry !== undefined,
        present: true,
        location: shortenHome(path.join(plugin.containerPath, plugin.dirName)),
        ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(entry !== undefined
          ? {
              source: entry.source,
              lockedSha: entry.lockedSha,
              installedAt: entry.installedAt,
              ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
            }
          : {}),
        skillCount,
        mcpServerCount,
      });
    }

    // Registry entries whose directory vanished (self-heal display; uninstall still works).
    for (const entry of managedByName.values()) {
      items.push({
        name: entry.name,
        managed: true,
        present: false,
        location: shortenHome(this.targetPathFor(entry.name)),
        ...(entry.manifest?.version !== undefined ? { version: entry.manifest.version } : {}),
        ...(entry.manifest?.description !== undefined
          ? { description: entry.manifest.description }
          : {}),
        source: entry.source,
        lockedSha: entry.lockedSha,
        installedAt: entry.installedAt,
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        skillCount: 0,
        mcpServerCount: 0,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Uninstall: delete dir + registry entry + prune that plugin's per-workspace
   * MCP overrides (reinstall re-attaches the same instanceId, so stale
   * overrides would silently re-enable servers — violating default-disabled).
   * PLUGIN_DATA is preserved unless `deletePluginData` is set.
   */
  async uninstall(args: { name: string; deletePluginData: boolean }): Promise<void> {
    this.assertEnabled();

    return this.runExclusive(async () => {
      const { envelope, rawEntries: rawRegistry } = await this.readRegistryDocument("strict");
      const registry = this.parseRegistryEntries(rawRegistry, "strict");
      const entry = registry.find((e) => e.name === args.name);
      if (!entry) {
        throw new Error(`'${args.name}' is not a managed plugin install.`);
      }

      // An unresolved update journal means the tree at the target may be a
      // USER-PLACED replacement (recovery refused to identify it), not the
      // managed install: uninstalling would stage and delete the user's tree,
      // and the next reconciliation would discard the recoverable original
      // because its registry entry is gone. Refuse until recovery resolves.
      if (await pathExists(this.journalPath(UPDATE_JOURNAL_PREFIX, args.name))) {
        throw new Error(
          `A previous update of '${args.name}' has unfinished recovery. Open Settings → Plugins to let recovery complete, then try again.`
        );
      }
      // Same for an unresolved UNINSTALL journal (a previous uninstall's
      // restore failed while the registry still owns the plugin): the
      // unconditional journal write below would replace the only references
      // to the original trashDir/dataTrashDir, orphaning the recoverable
      // assets for stale reclamation while this retry commits against a
      // missing or replaced target.
      if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, args.name))) {
        throw new Error(
          `A previous uninstall of '${args.name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
        );
      }

      const targetPath = this.targetPathFor(entry.name);
      const instanceId = this.instanceIdFor(entry.name);
      const serverKeyPrefix = buildPluginServerKey(instanceId, "");

      // Enumerate pruning targets BEFORE committing anything: if this fails,
      // the uninstall aborts with the install fully intact (retryable from
      // Settings) instead of leaving stale overrides behind post-commit.
      const workspaceIdsToPrune = await this.listWorkspaceIdsForOverridePruning();

      // A newer build's pendingOverridePrunes shape is opaque to this build,
      // so the pessimistic tombstone below could only clobber it. Refuse
      // up-front (install fully intact) rather than destroy that build's
      // cleanup metadata — or silently skip recording our own.
      if (workspaceIdsToPrune.length > 0 && this.hasOpaquePendingPrunes(envelope)) {
        throw new Error(
          `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup state written by a newer version of Mux. Run the uninstall with that version, or let it finish its cleanup first.`
        );
      }

      // Stop running servers before deleting the tree out from under them.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

      // Stage the tree — and, when requested, the plugin-data dir — out
      // BEFORE touching the registry so every step can fail without partial
      // state: a failed rename (e.g. a locked file on Windows) leaves the
      // install fully intact, and a failed registry write renames everything
      // back. Deleting the staged dirs afterwards is best-effort — they sit
      // under the staging root, where stale-dir reclamation cleans up
      // leftovers, so a locked dir cannot strand the user in a state where
      // the Settings row is gone but their requested cleanup never happens.
      await fsPromises.mkdir(this.stagingRoot, { recursive: true });
      const trashDir = path.join(this.stagingRoot, `trash-${Date.now()}-${entry.name}`);
      const dataTrashDir = path.join(this.stagingRoot, `trash-data-${Date.now()}-${entry.name}`);

      // Journal the transaction BEFORE anything moves: a crash between the
      // renames below and the registry commit would otherwise leave the
      // registry owning a plugin whose tree (and optionally its data) is
      // hidden under plugin-staging with nothing to restore it — the next
      // list shows a missing install and a retried uninstall commits on
      // ENOENT while the staged assets linger. reconcileJournals restores
      // them while the registry entry still exists, and finishes the trash
      // cleanup once the commit landed.
      const uninstallJournalPath = this.journalPath(UNINSTALL_JOURNAL_PREFIX, entry.name);
      await this.writeJournalFile(uninstallJournalPath, {
        name: entry.name,
        trashDir,
        dataTrashDir,
        stagedAt: Date.now(),
      });
      const consumeJournal = async (): Promise<void> => {
        await this.consumeJournalFile(uninstallJournalPath).catch(() => undefined);
      };

      let stagedTree = false;
      try {
        await this.renameIntoStaging(targetPath, trashDir);
        stagedTree = true;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          await consumeJournal(); // Nothing moved: no recovery needed.
          throw new Error(`Failed to remove the plugin directory: ${getErrorMessage(error)}`);
        }
        // Missing tree (present:false row): registry-only uninstall.
      }

      /** Returns true when nothing remained staged (safe to consume the journal). */
      const restoreTree = async (context: string): Promise<boolean> => {
        if (!stagedTree) {
          return true;
        }
        return fsPromises.rename(trashDir, targetPath).then(
          () => {
            this.activeStagingPaths.delete(trashDir);
            return true;
          },
          (rollbackError: unknown) => {
            // Keep the journal: reconcileJournals restores the staged tree
            // on the next startup/section open.
            log.error(`Failed to restore plugin dir after ${context}`, {
              targetPath,
              rollbackError,
            });
            return false;
          }
        );
      };

      const dataPath = getPluginDataPath(this.config.rootDir, instanceId);
      let stagedData = false;
      if (args.deletePluginData) {
        try {
          await this.renameIntoStaging(dataPath, dataTrashDir);
          stagedData = true;
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) {
            // Fail BEFORE the registry commit so the row stays and the user
            // can retry the requested cleanup.
            if (await restoreTree("failed plugin-data staging")) {
              await consumeJournal();
            }
            throw new Error(`Failed to remove the plugin data: ${getErrorMessage(error)}`);
          }
          // No data dir: nothing to delete.
        }
      }

      // The commit write carries a PESSIMISTIC tombstone for every workspace
      // that needs pruning: if a prune later fails — or the best-effort
      // shrink write below fails — the durable record already exists.
      // Over-blocking a reinstall until cleanup is confirmed is safe;
      // silently losing the record (stale enabledServers reactivating a
      // reinstalled server) is not.
      const commitEnvelope = { ...envelope };
      const pendingForCommit = this.updateRawPendingPrunes(
        this.rawPendingPrunes(envelope),
        serverKeyPrefix,
        workspaceIdsToPrune
      );
      if (this.hasOpaquePendingPrunes(envelope)) {
        // Opaque newer-build shape rides through verbatim (kept by the
        // spread above; the up-front guard ensured nothing needs recording).
      } else if (pendingForCommit.length > 0) {
        commitEnvelope.pendingOverridePrunes = pendingForCommit;
      } else {
        delete commitEnvelope.pendingOverridePrunes;
      }
      try {
        await this.writeRegistry(
          commitEnvelope,
          rawRegistry.filter((rawEntry) => this.rawEntryName(rawEntry) !== entry.name)
        );
      } catch (error) {
        const treeRestored = await restoreTree("failed registry write");
        let dataRestored = true;
        if (stagedData) {
          // A getToolsForWorkspace startup that began after the pre-stage
          // invalidation can have recreated dataPath (prepareStdioLaunch
          // mkdirs it) while the registry write failed. Invalidate again so
          // no late server publishes against the restored install, then
          // remove the recreated (fresh, empty) directory — otherwise the
          // rename below EEXIST-fails and strands the ORIGINAL data in
          // staging while the still-installed plugin sees an empty data dir.
          try {
            await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
          } catch (stopError) {
            log.warn("Failed to re-invalidate plugin servers during data rollback", {
              serverKeyPrefix,
              error: getErrorMessage(stopError),
            });
          }
          if (await pathExists(dataPath)) {
            await this.removeDir(dataPath).catch(() => undefined);
          }
          dataRestored = await fsPromises.rename(dataTrashDir, dataPath).then(
            () => {
              this.activeStagingPaths.delete(dataTrashDir);
              return true;
            },
            (rollbackError: unknown) => {
              // Keep the journal: reconcileJournals restores the staged data
              // on the next startup/section open.
              log.error("Failed to restore plugin data after failed registry write", {
                dataPath,
                rollbackError,
              });
              return false;
            }
          );
        }
        if (treeRestored && dataRestored) {
          await consumeJournal();
        }
        throw new Error(`Failed to persist the plugin registry: ${getErrorMessage(error)}`);
      }

      // The uninstall is committed; everything below is best-effort cleanup
      // that must not abort the remaining steps.
      let trashCleaned = true;
      if (stagedTree) {
        await this.removeDir(trashDir).catch((error: unknown) => {
          trashCleaned = false;
          log.warn("Failed to delete uninstalled plugin tree; recovery will retry", {
            trashDir,
            error: getErrorMessage(error),
          });
        });
      }
      let dataDeletionFailure: string | undefined;
      if (stagedData) {
        // The user EXPLICITLY requested this deletion, so a failure (e.g. a
        // locked file on Windows) must surface rather than report success:
        // stale-staging reclamation only runs during a later staging
        // operation, which may never happen.
        await this.removeDir(dataTrashDir).catch((error: unknown) => {
          trashCleaned = false;
          dataDeletionFailure = `The plugin was uninstalled, but deleting its stored data failed (${getErrorMessage(error)}). The data was moved to ${shortenHome(dataTrashDir)} — delete it manually.`;
          log.warn("Failed to delete plugin data; recovery will retry", {
            dataTrashDir,
            error: getErrorMessage(error),
          });
        });
      }
      // Consume the journal only once every staged asset is gone: a retained
      // committed journal is the durable retry record for the failed cleanup
      // (recoverInterruptedUninstall's committed branch finishes it), and it
      // blocks same-name reinstalls until then — with the entry gone,
      // recovery can never misread this journal as an uncommitted uninstall
      // and restore the assets.
      if (trashCleaned) {
        await consumeJournal();
      }

      // Re-invalidate AFTER the tree is gone: a getToolsForWorkspace call
      // that started right after the pre-rename stop snapshots the new epoch,
      // and can still have discovered the plugin before the rename — its
      // freshly started server would otherwise publish validly and keep
      // running from the removed tree. This runs BEFORE override pruning so
      // pruning problems cannot skip the correctness-critical invalidation.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

      // Workspaces registered AFTER the pre-commit enumeration escaped both
      // the pessimistic tombstone and the prune list, yet until the tree
      // removal + re-invalidation above their MCP dialogs could still save a
      // valid enable for this plugin's servers (save-time validation saw the
      // then-present tree). Re-enumerate now that no new valid enable can be
      // saved and fold the delta in. A failed re-enumeration skips the
      // tombstone shrink below, keeping the pessimistic record.
      let pruneIds = workspaceIdsToPrune;
      let postCommitEnumerated = true;
      let deltaRecordFailure: string | undefined;
      try {
        const postCommitIds = await this.listWorkspaceIdsForOverridePruning();
        pruneIds = [...new Set([...workspaceIdsToPrune, ...postCommitIds])];
      } catch (error) {
        postCommitEnumerated = false;
        log.warn(
          "Failed to re-enumerate workspaces after uninstall commit; keeping the pessimistic tombstone",
          { error: getErrorMessage(error) }
        );
        if (workspaceIdsToPrune.length === 0) {
          // Zero workspaces at commit time means the commit wrote NO
          // tombstone for this prefix, yet a workspace registered during the
          // uninstall could have saved an enable while the tree was still
          // present — and this failed re-enumeration was the only chance to
          // find it. The tombstone's PRESENCE is what drives retry-side live
          // re-enumeration, so persist an empty SENTINEL record; retries
          // clear it only after a full live sweep succeeds. If even that
          // write fails, surface the gap to the user (after the remaining
          // cleanup below).
          try {
            const { envelope: envelopeSentinel, rawEntries: entriesSentinel } =
              await this.readRegistryDocument("strict");
            if (this.hasOpaquePendingPrunes(envelopeSentinel)) {
              // Recording into a newer build's opaque shape would clobber it
              // (same reasoning as the pre-commit guard, which only runs when
              // commit-time workspaces existed).
              throw new Error(
                "the registry's pending cleanup state was written by a newer version of Mux"
              );
            }
            const pendingSentinel = this.updateRawPendingPrunes(
              this.rawPendingPrunes(envelopeSentinel),
              serverKeyPrefix,
              [],
              { keepEmpty: true }
            );
            await this.writePendingOverridePrunes(
              envelopeSentinel,
              entriesSentinel,
              pendingSentinel
            );
          } catch (sentinelError) {
            deltaRecordFailure = `The plugin was uninstalled, but workspaces registered during the uninstall could not be checked for stale MCP overrides and recording a cleanup reminder failed (${getErrorMessage(sentinelError)}). If reinstalling this plugin, first check workspace MCP settings for stale entries.`;
          }
        }
      }
      // Delta workspaces are NOT in the commit-time tombstone. Persist the
      // union BEFORE pruning so a crash between here and their prune keeps a
      // precise durable record. A failed persist is still covered as long as
      // ANY tombstone for this prefix exists: retryPrune re-enumerates live
      // workspaces on every retry, so the pessimistic commit-time record
      // reaches the delta too. Only when no tombstone exists at all (zero
      // workspaces at commit time) is the delta unrecorded — surfaced to the
      // user at the end, after all remaining cleanup ran.
      if (postCommitEnumerated && pruneIds.length > workspaceIdsToPrune.length) {
        try {
          const { envelope: envelopeDelta, rawEntries: entriesDelta } =
            await this.readRegistryDocument("strict");
          const pendingDelta = this.updateRawPendingPrunes(
            this.rawPendingPrunes(envelopeDelta),
            serverKeyPrefix,
            pruneIds
          );
          await this.writePendingOverridePrunes(envelopeDelta, entriesDelta, pendingDelta);
        } catch (error) {
          if (workspaceIdsToPrune.length === 0) {
            deltaRecordFailure = `The plugin was uninstalled, but recording override cleanup for workspaces registered during the uninstall failed (${getErrorMessage(error)}). If reinstalling this plugin, first check the MCP settings of workspaces ${pruneIds.join(", ")} for stale entries.`;
          }
          log.warn(
            "Failed to persist post-commit workspace delta into the prune tombstone; keeping the pessimistic record",
            { error: getErrorMessage(error) }
          );
        }
      }

      // Per-workspace failures are caught inside; the failure-prone
      // enumeration already happened pre-commit and the pessimistic
      // tombstone is already durable (commit write above). Shrink it to what
      // actually failed — best-effort: a failed shrink leaves the over-broad
      // tombstone, which self-heals on the next retry (section open or the
      // reinstall gate). The shrink is gated on the re-enumeration only, not
      // on the delta persist above: failedPruneIds covers the full union, so
      // a successful shrink IS the durable record for failed delta prunes.
      const failedPruneIds = await this.pruneWorkspaceOverrides(serverKeyPrefix, pruneIds);
      if (pruneIds.length > 0 && postCommitEnumerated) {
        // STRICT re-read for the shrink: a lenient read degrading a transient
        // I/O error or corruption to an empty document would make this write
        // rewrite plugins.json with an empty plugin list, orphaning every
        // other managed install. On any failure the pessimistic tombstone
        // from the commit write simply stays (safe, self-heals on retry).
        try {
          const { envelope: envelopeAfter, rawEntries: entriesAfter } =
            await this.readRegistryDocument("strict");
          const pendingAfter = this.updateRawPendingPrunes(
            this.rawPendingPrunes(envelopeAfter),
            serverKeyPrefix,
            failedPruneIds
          );
          await this.writePendingOverridePrunes(envelopeAfter, entriesAfter, pendingAfter);
          // This write durably recorded every still-failing prune (the
          // failed list covers the delta), so the earlier delta persist
          // failure no longer needs surfacing.
          deltaRecordFailure = undefined;
        } catch (error) {
          log.warn("Failed to shrink pending override prune tombstone (kept pessimistic)", {
            serverKeyPrefix,
            failedPruneIds,
            error: getErrorMessage(error),
          });
        }
      }

      log.info(`Uninstalled agent plugin '${entry.name}'`);
      // Thrown LAST so the remaining cleanup above (invalidation, override
      // pruning) still ran; the uninstall itself is committed and the message
      // says so.
      const commitFailures = [dataDeletionFailure, deltaRecordFailure].filter(
        (message): message is string => message !== undefined
      );
      if (commitFailures.length > 0) {
        throw new Error(commitFailures.join(" "));
      }
    });
  }

  /**
   * Enumerate the local/worktree workspace IDs whose MCP overrides an
   * uninstall must prune. Called BEFORE the uninstall commits anything:
   * enumeration is the only pruning step that can fail wholesale (outside
   * the per-workspace catch), and a post-commit failure would leave stale
   * overrides with no Settings row left to retry from — a reinstall reuses
   * the same instance ID and would silently re-enable those servers.
   * Remote runtimes are skipped — they never see plugin servers
   * (resolveAgentPluginsMcpContext returns null off-host).
   */
  private async listWorkspaceIdsForOverridePruning(): Promise<string[]> {
    if (!this.deps.workspaceMcpOverridesService) {
      return [];
    }
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    return allMetadata
      .filter((metadata) => {
        const runtimeType = metadata.runtimeConfig.type;
        return runtimeType === "local" || runtimeType === "worktree";
      })
      .map((metadata) => metadata.id);
  }

  /**
   * Remove `plugin:<instanceId>:*` keys from the given workspaces' MCP
   * overrides. Best-effort per workspace: a missing checkout must not block
   * uninstall. Returns the workspace IDs whose prune FAILED so callers can
   * persist a retryable tombstone — silently discarding a failure would let
   * a reinstall (same instance ID) pick up the stale override and re-enable
   * the server without consent.
   */
  private async pruneWorkspaceOverrides(
    serverKeyPrefix: string,
    workspaceIds: string[]
  ): Promise<string[]> {
    const overridesService = this.deps.workspaceMcpOverridesService;
    if (!overridesService) {
      return [];
    }
    if (workspaceIds.length === 0) {
      return [];
    }
    // Raw in-queue patch: preserves unknown fields written by newer
    // builds, throws on unreadable files (tombstone retry), and cannot
    // interleave with a dialog save (shared exclusive write queue).
    //
    // The publish hook repairs MCPServerManager's in-memory override
    // cache INSIDE that same write queue: latestWorkspaceOverrides wins
    // over freshly read overrides, so a workspace that once enabled this
    // plugin's server would otherwise keep serving the stale enable — and
    // a same-name reinstall's default-disabled server could start without
    // a fresh user action. In-queue publication also keeps the ordering
    // consistent with concurrent dialog saves (whichever writes disk last
    // publishes last). A failure keeps the tombstone so cache repair is
    // retried too.
    //
    // One batched call, not one prune per workspace: every workspace in
    // config is swept here, and the per-workspace variant re-resolves
    // metadata from a full config.json parse each time — with thousands of
    // workspaces that made installs sit on "Installing…" for half an hour.
    const mcpServerManager = this.deps.mcpServerManager;
    let failures: Array<{ workspaceId: string; error: unknown }>;
    try {
      failures = await overridesService.prunePluginOverrideKeysForWorkspaces(
        workspaceIds,
        serverKeyPrefix,
        mcpServerManager
          ? {
              publish: (workspaceId, persisted) =>
                mcpServerManager.applyWorkspaceOverrides(workspaceId, persisted),
            }
          : undefined
      );
    } catch (error) {
      // Wholesale failure (lock timeout, unreadable config): no workspace was
      // verified, so every one keeps its tombstone.
      log.warn("Failed to prune plugin MCP overrides", { error: getErrorMessage(error) });
      return [...workspaceIds];
    }
    for (const failure of failures) {
      log.warn("Failed to prune plugin MCP overrides for workspace", {
        workspaceId: failure.workspaceId,
        error: getErrorMessage(failure.error),
      });
    }
    return failures.map((failure) => failure.workspaceId);
  }

  /**
   * Pending override prunes ("tombstones") persisted in the registry
   * envelope under `pendingOverridePrunes`: uninstalls whose per-workspace
   * override cleanup failed (checkout temporarily unavailable, unwritable
   * override file). They are retried on section open (list) and gate a
   * reinstall of the same instance ID, so a stale `enabledServers` key can
   * never silently re-enable a reinstalled plugin's server.
   *
   * Rewrites operate on the RAW item list, mirroring the registry-entry
   * rules: items this build cannot parse (a newer release's tombstone
   * variant) pass through untouched, and recognized items keep their unknown
   * fields when their `workspaceIds` shrink.
   */
  private isRecognizedPrune(
    item: unknown
  ): item is { prefix: string; workspaceIds: string[] } & Record<string, unknown> {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const prefix = (item as { prefix?: unknown }).prefix;
    const workspaceIds = (item as { workspaceIds?: unknown }).workspaceIds;
    return (
      typeof prefix === "string" &&
      // Only canonical `plugin:<instanceId>:` prefixes are executable: a
      // corrupted prefix (e.g. "g") must never reach prunePluginOverrideKeys,
      // where it would destructively strip arbitrary workspace override keys.
      // Invalid tombstones pass through verbatim like unknown variants.
      isCanonicalPluginServerKeyPrefix(prefix) &&
      Array.isArray(workspaceIds) &&
      workspaceIds.every((id): id is string => typeof id === "string")
    );
  }

  /** The raw `pendingOverridePrunes` array as stored (unknown variants included). */
  private rawPendingPrunes(envelope: Record<string, unknown>): unknown[] {
    const raw = envelope.pendingOverridePrunes;
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * True when `pendingOverridePrunes` exists with a shape this build does
   * not understand (a newer release's representation). It is opaque: every
   * rewrite must preserve it verbatim — deleting or replacing it would
   * destroy that build's cleanup metadata on downgrade.
   */
  private hasOpaquePendingPrunes(envelope: Record<string, unknown>): boolean {
    return (
      envelope.pendingOverridePrunes !== undefined && !Array.isArray(envelope.pendingOverridePrunes)
    );
  }

  /**
   * Recognized tombstones only (for matching/retrying). Corrupted persisted
   * state can carry several recognized tombstones for one prefix; they are
   * merged (workspace-ID union) so per-prefix rewrites, which replace every
   * matching item, can never silently drop a duplicate's cleanup record.
   */
  private parsePendingOverridePrunes(
    envelope: Record<string, unknown>
  ): Array<{ prefix: string; workspaceIds: string[] }> {
    const merged = new Map<string, string[]>();
    for (const item of this.rawPendingPrunes(envelope)) {
      if (!this.isRecognizedPrune(item)) {
        continue;
      }
      const existing = merged.get(item.prefix);
      if (existing) {
        for (const workspaceId of item.workspaceIds) {
          if (!existing.includes(workspaceId)) {
            existing.push(workspaceId);
          }
        }
      } else {
        merged.set(item.prefix, [...item.workspaceIds]);
      }
    }
    return [...merged.entries()].map(([prefix, workspaceIds]) => ({ prefix, workspaceIds }));
  }

  /**
   * Set this build's tombstone for `prefix` within the raw item list:
   * removes every recognized item for that prefix (merging their unknown
   * fields into the replacement) and appends the new one when
   * `workspaceIds` is non-empty. Unrecognized items are preserved verbatim.
   * `keepEmpty` appends an empty-list SENTINEL tombstone instead of removing
   * the entry: its presence still drives retry-side live re-enumeration,
   * covering uninstalls where the workspaces needing pruning were never
   * enumerable (see the uninstall post-commit re-enumeration catch).
   */
  private updateRawPendingPrunes(
    rawPending: unknown[],
    prefix: string,
    workspaceIds: string[],
    options?: { keepEmpty?: boolean }
  ): unknown[] {
    const matches: Array<Record<string, unknown>> = [];
    const next: unknown[] = [];
    for (const item of rawPending) {
      if (this.isRecognizedPrune(item) && item.prefix === prefix) {
        matches.push(item);
      } else {
        next.push(item);
      }
    }
    if (workspaceIds.length > 0 || options?.keepEmpty === true) {
      const replacement: Record<string, unknown> = {};
      for (const match of matches) {
        Object.assign(replacement, match);
      }
      replacement.prefix = prefix;
      replacement.workspaceIds = workspaceIds;
      next.push(replacement);
    }
    return next;
  }

  /** Persist the raw tombstone list into the envelope (removing the key when empty). */
  private async writePendingOverridePrunes(
    envelope: Record<string, unknown>,
    rawEntries: unknown[],
    rawPending: unknown[]
  ): Promise<void> {
    const nextEnvelope = { ...envelope };
    if (this.hasOpaquePendingPrunes(envelope)) {
      // A newer build's opaque shape rides through verbatim (kept by the
      // spread above). Nothing can need recording here: recognized
      // tombstones only ever come from an array shape, and uninstall
      // refuses up-front when it would have to record one.
      assert(
        rawPending.length === 0,
        "writePendingOverridePrunes: cannot merge tombstones into an opaque pendingOverridePrunes shape"
      );
    } else if (rawPending.length > 0) {
      nextEnvelope.pendingOverridePrunes = rawPending;
    } else {
      delete nextEnvelope.pendingOverridePrunes;
    }
    await this.writeRegistry(nextEnvelope, rawEntries);
  }

  /**
   * Retry one tombstone's pruning. The tombstone's PRESENCE — not its exact
   * workspace-ID list — is the durable retry record: workspaces registered
   * between an uninstall's pre-commit enumeration and its post-commit
   * re-enumeration may exist only in memory when the union write fails, and
   * a crash mid-prune loses them entirely. Every retry therefore
   * re-enumerates the CURRENT local/worktree workspaces and prunes that
   * full set, so a tombstone can only clear after a complete live sweep
   * succeeded. Recorded workspaces that no longer exist drop out implicitly
   * — a deleted workspace's overrides can never reactivate anything, so
   * keeping its ID would block reinstall forever. Returns the IDs that
   * still need pruning; when enumeration itself fails (`enumerated: false`),
   * the recorded list is returned unshrunk even if its prunes succeeded,
   * because unenumerated delta workspaces cannot be ruled out — callers must
   * then keep the tombstone even when `failed` is empty (an empty SENTINEL
   * tombstone records exactly this "delta workspaces unknown" state, and a
   * failed re-enumeration cannot rule them out either).
   */
  private async retryPrune(prune: {
    prefix: string;
    workspaceIds: string[];
  }): Promise<{ enumerated: boolean; failed: string[] }> {
    let liveWorkspaceIds: string[];
    try {
      liveWorkspaceIds = await this.listWorkspaceIdsForOverridePruning();
    } catch (error) {
      log.warn("Failed to enumerate workspaces for pending override prune retry", {
        error: getErrorMessage(error),
      });
      await this.pruneWorkspaceOverrides(prune.prefix, prune.workspaceIds);
      return { enumerated: false, failed: prune.workspaceIds };
    }
    return {
      enumerated: true,
      failed: await this.pruneWorkspaceOverrides(prune.prefix, liveWorkspaceIds),
    };
  }

  /**
   * Reinstall gate: a plugin name maps to the same instance ID, so a pending
   * prune for its prefix means stale workspace overrides could re-enable the
   * reinstalled plugin's servers without consent. Retry the prune now; only
   * a fully successful cleanup unblocks the install. Runs under the caller's
   * exclusive mutation lock (install's runExclusive).
   */
  private async assertNoPendingOverridePrune(name: string): Promise<void> {
    const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
    const { envelope, rawEntries } = await this.readRegistryDocument("strict");
    // An opaque newer-build shape is unreadable here, so it may contain a
    // pending cleanup for this very instance ID — reinstalling would reuse
    // that ID and stale workspace overrides could silently re-enable its
    // servers. Over-blocking until the newer build resolves it is safe.
    if (this.hasOpaquePendingPrunes(envelope)) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup state written by a newer version of Mux. Install with that version, or let it finish its cleanup first.`
      );
    }
    // Same reasoning per ITEM: an unrecognized array entry (a newer build's
    // per-entry variant, or corrupted data) may reference this very instance
    // ID — this build cannot rule that out, so it blocks installs too.
    // (Uninstalls stay possible: appending this build's tombstone preserves
    // unrecognized entries verbatim.)
    if (this.rawPendingPrunes(envelope).some((item) => !this.isRecognizedPrune(item))) {
      throw new Error(
        `The plugin registry (${shortenHome(this.registryFile)}) contains pending cleanup records this version cannot read (written by a newer version of Mux, or corrupted). Install with that version, or repair the file's pendingOverridePrunes entries first.`
      );
    }
    const pending = this.parsePendingOverridePrunes(envelope);
    const match = pending.find((prune) => prune.prefix === serverKeyPrefix);
    if (!match) {
      return;
    }

    const { enumerated, failed } = await this.retryPrune(match);
    if (!enumerated) {
      // Delta workspaces cannot be ruled out without a live enumeration:
      // keep the tombstone verbatim (even an empty sentinel) and stay
      // blocked — clearing it here would let the reinstall proceed over
      // workspaces the sweep never saw.
      throw new Error(
        `A previous uninstall of '${name}' could not verify its workspace MCP override cleanup yet (workspace enumeration failed). Retry in a moment.`
      );
    }
    const remaining = this.updateRawPendingPrunes(
      this.rawPendingPrunes(envelope),
      serverKeyPrefix,
      failed
    );
    await this.writePendingOverridePrunes(envelope, rawEntries, remaining);
    if (failed.length > 0) {
      throw new Error(
        `A previous uninstall of '${name}' could not clean up its workspace MCP overrides yet (workspaces: ${failed.join(", ")}). Retry once those workspaces are accessible.`
      );
    }
  }

  /**
   * Fresh-install hygiene for consent state left by a PREVIOUS occupant of
   * this plugin's path. The instance ID derives from the lexical target
   * path, so an UNMANAGED plugin the user enabled and then deleted by hand
   * (never uninstalled — no tombstone exists) leaves workspace overrides,
   * and possibly cached server instances, that a same-name managed install
   * would silently inherit: its default-disabled servers would start
   * without fresh enablement. Sweep the prefix across live workspaces and
   * retire cached instances BEFORE anything is promoted; failures block the
   * install (over-blocking is safe, silent activation is not). Runs under
   * install's exclusive mutation lock.
   */
  private async assertNoResidualInstanceState(name: string): Promise<void> {
    const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(name), "");
    await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
    const { enumerated, failed } = await this.retryPrune({
      prefix: serverKeyPrefix,
      workspaceIds: [],
    });
    if (!enumerated) {
      throw new Error(
        `Could not verify that no workspace holds stale MCP overrides for '${name}' (workspace enumeration failed). Retry in a moment.`
      );
    }
    if (failed.length > 0) {
      throw new Error(
        `Stale workspace MCP overrides for '${name}' could not be cleaned up (workspaces: ${failed.join(", ")}). Retry once those workspaces are accessible.`
      );
    }
  }

  /**
   * Retry all pending override prunes; persists progress. Best-effort: runs
   * on section open (list), so transient failures self-heal the next time
   * the affected checkout is reachable. The read-modify-write runs under the
   * exclusive mutation queue — an install/update/uninstall committing while
   * the workspace I/O is in flight would otherwise be clobbered by this
   * write's stale registry snapshot.
   */
  private async retryPendingOverridePrunes(): Promise<void> {
    return this.runExclusive(async () => {
      const { envelope, rawEntries } = await this.readRegistryDocument("lenient");
      const pending = this.parsePendingOverridePrunes(envelope);
      if (pending.length === 0) {
        return;
      }

      let rawPending = this.rawPendingPrunes(envelope);
      let progressed = false;
      for (const prune of pending) {
        const { enumerated, failed } = await this.retryPrune(prune);
        if (!enumerated) {
          // Keep the record verbatim: without a live enumeration, delta
          // workspaces cannot be ruled out — in particular an empty SENTINEL
          // tombstone (recorded when an uninstall's re-enumeration failed
          // with zero commit-time workspaces) must not be cleared here.
          continue;
        }
        // Set comparison, not length: retryPrune re-enumerates live
        // workspaces, so `failed` can contain IDs the record never held
        // (delta workspaces) — those must be folded in durably too. A fully
        // successful sweep (`failed` empty) always counts as progress so an
        // empty sentinel tombstone clears instead of lingering forever.
        const recorded = new Set(prune.workspaceIds);
        const changed =
          failed.length === 0 ||
          failed.length !== recorded.size ||
          failed.some((id) => !recorded.has(id));
        if (changed) {
          progressed = true;
          rawPending = this.updateRawPendingPrunes(rawPending, prune.prefix, failed);
        }
      }

      if (progressed) {
        await this.writePendingOverridePrunes(envelope, rawEntries, rawPending).catch(
          (error: unknown) => {
            log.warn("Failed to persist pending override prune progress", {
              error: getErrorMessage(error),
            });
          }
        );
      }
    });
  }

  /**
   * Compare each managed entry's tracking ref against `lockedSha` via
   * `git ls-remote` (no fetch). Runs on Settings-section open and on the
   * explicit "Check for updates" action only — no background timers.
   */
  async checkUpdates(): Promise<AgentPluginUpdateCheck[]> {
    this.assertEnabled();

    // STRICT: a lenient read would degrade an unreadable/corrupted registry
    // to an empty list and report a false "everything is up to date". The
    // thrown error surfaces nonfatally in the UI as the update-check error
    // state instead.
    const registry = await this.readRegistry("strict");
    // Bounded concurrency: one ls-remote process per entry at once would let
    // a large registry exhaust sockets/file descriptors on section open.
    return mapWithConcurrency(
      registry,
      UPDATE_CHECK_CONCURRENCY,
      async (entry): Promise<AgentPluginUpdateCheck> => {
        if (entry.source.refType === "commit") {
          return { name: entry.name, status: "pinned" };
        }
        try {
          // Pass the stored kind: a remote ADDING a same-name branch must
          // not make a still-tracked tag read as "now a branch".
          const resolved = await this.resolveRemoteRef(
            entry.source.url,
            entry.source.ref,
            entry.source.refType
          );
          if (resolved.refType !== entry.source.refType) {
            // e.g. a tracked branch was deleted and a tag with the same name exists now.
            return {
              name: entry.name,
              status: "error",
              message: `Tracked ${entry.source.refType} '${entry.source.ref}' is now a ${resolved.refType} on the remote.`,
            };
          }
          if (resolved.sha === entry.lockedSha) {
            return { name: entry.name, status: "up-to-date" };
          }
          return {
            name: entry.name,
            // A moved tag is suspicious (tags are supposed to be immutable) — warn, don't just offer.
            status: entry.source.refType === "tag" ? "tag-moved" : "update-available",
            remoteSha: resolved.sha,
          };
        } catch (error) {
          return { name: entry.name, status: "error", message: getErrorMessage(error) };
        }
      }
    );
  }

  /**
   * Pre-flight shared by previewUpdate and update: registry lookup, the
   * refusals that make an update impossible, and the remote ref resolution.
   * Must run under runExclusive (reads the registry document for a later
   * write).
   */
  private async resolveUpdateTarget(name: string): Promise<{
    envelope: Record<string, unknown>;
    rawRegistry: unknown[];
    entry: AgentPluginInstallEntry;
    resolved: ResolvedRemoteRef;
    updateJournalPath: string;
  }> {
    const { envelope, rawEntries: rawRegistry } = await this.readRegistryDocument("strict");
    const registry = this.parseRegistryEntries(rawRegistry, "strict");
    const entry = registry.find((e) => e.name === name);
    if (!entry) {
      throw new Error(`'${name}' is not a managed plugin install.`);
    }
    if (entry.source.refType === "commit") {
      throw new Error(
        `'${entry.name}' is pinned to commit ${entry.lockedSha.slice(0, 12)}; uninstall and reinstall to change it.`
      );
    }
    if (entry.source.subpath !== undefined) {
      // The registry schema deliberately preserves subpath entries written
      // by newer builds (upgrade↔downgrade), but this build clones and
      // validates only the repository ROOT: updating would swap the
      // installed subpath snapshot for an unrelated root tree while the
      // registry keeps claiming the subpath source.
      throw new Error(
        `'${entry.name}' was installed from a repository subpath by a newer version of Mux; update it with that version.`
      );
    }
    // A retained journal means a previous swap's recovery is unfinished
    // (e.g. the target was occupied by an unidentifiable tree). Refuse
    // BEFORE cloning and comparing capabilities: a new journal would
    // clobber the trashDir reference protecting the recoverable original,
    // and the capability comparison would run against the wrong tree.
    const updateJournalPath = this.journalPath(UPDATE_JOURNAL_PREFIX, entry.name);
    if (await pathExists(updateJournalPath)) {
      throw new Error(
        `A previous update of '${entry.name}' has unfinished recovery. Open Settings → Plugins to let recovery complete, then try again.`
      );
    }
    // Same for an unresolved UNINSTALL journal (the registry still owns the
    // plugin while its tree sits in staging): a skills-only plugin has an
    // empty capability surface, so the missing target would NOT stop this
    // update — it would promote a replacement, after which uninstall
    // recovery sees the occupied target, keeps its journal forever, and the
    // whole managed container stays suppressed.
    if (await pathExists(this.journalPath(UNINSTALL_JOURNAL_PREFIX, entry.name))) {
      throw new Error(
        `A previous uninstall of '${entry.name}' has unfinished cleanup. Open Settings → Plugins to let recovery complete, then try again.`
      );
    }

    const resolved = await this.resolveRemoteRef(
      entry.source.url,
      entry.source.ref,
      entry.source.refType
    );
    if (resolved.refType !== entry.source.refType) {
      // The ref name now resolves to a different kind on the remote (e.g. a
      // tracked branch was deleted and a tag of the same name exists). The
      // update check flags this as an error; a stale Update click must not
      // silently install content from a different ref kind while the
      // registry keeps claiming the old one.
      throw new Error(
        `Tracked ${entry.source.refType} '${entry.source.ref}' is now a ${resolved.refType} on the remote. Uninstall and reinstall to track it.`
      );
    }
    return { envelope, rawRegistry, entry, resolved, updateJournalPath };
  }

  /** Stage `sha`, validate it, and refuse an upstream rename (names are identity). */
  private async stageUpdate(
    entry: AgentPluginInstallEntry,
    sha: string
  ): Promise<{ stagedDir: string; plugin: AgentPluginInfo; warnings: string[] }> {
    const stagedDir = await this.cloneExactSha(entry.source, sha);
    try {
      const { plugin, warnings } = await this.validateStagedClone(stagedDir);
      if (plugin.name !== entry.name) {
        // Container-entry names are identity (instanceId, PLUGIN_DATA,
        // workspace overrides hash the path) — never rename on update.
        throw new Error(
          `The plugin renamed itself upstream ('${entry.name}' → '${plugin.name}'). Uninstall and reinstall to adopt the new name.`
        );
      }
      return { stagedDir, plugin, warnings };
    } catch (error) {
      await this.removeDir(stagedDir);
      throw error;
    }
  }

  /**
   * Stateless update review: stage the pending commit and report every
   * capability change relative to the installed tree (see
   * collectCapabilityChanges). Writes nothing; the UI shows the result and,
   * on confirmation, calls update() with a consent naming these exact SHAs.
   */
  async previewUpdate(args: { name: string }): Promise<AgentPluginUpdateReview> {
    this.assertEnabled();

    return this.runExclusive(async () => {
      const { entry, resolved } = await this.resolveUpdateTarget(args.name);
      if (resolved.sha === entry.lockedSha) {
        return {
          name: entry.name,
          fromSha: entry.lockedSha,
          toSha: entry.lockedSha,
          changes: [],
          warnings: [],
        };
      }
      const { stagedDir, plugin, warnings } = await this.stageUpdate(entry, resolved.sha);
      try {
        const changes = await this.collectCapabilityChanges(
          entry.name,
          this.targetPathFor(entry.name),
          plugin
        );
        return {
          name: entry.name,
          fromSha: entry.lockedSha,
          toSha: resolved.sha,
          ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
          changes,
          warnings,
        };
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }

  /**
   * Apply an update: temp clone at the new SHA → re-validate → wholesale
   * directory swap (rename-old → promote-new → delete-old) → bump lockedSha →
   * recycle that plugin's MCP servers. Never an in-place `git pull`; local
   * edits to the managed dir are discarded.
   */
  async update(args: {
    name: string;
    consent?: AgentPluginUpdateConsent | undefined;
  }): Promise<AgentPluginInstallEntry> {
    this.assertEnabled();
    if (args.consent !== undefined) {
      assert(
        isFullCommitSha(args.consent.toSha),
        "update: consent.toSha must be a full commit SHA"
      );
    }

    return this.runExclusive(async () => {
      const { envelope, rawRegistry, entry, resolved, updateJournalPath } =
        await this.resolveUpdateTarget(args.name);
      if (args.consent !== undefined && args.consent.fromSha !== entry.lockedSha) {
        // The review compared the staged tree against THIS install; if
        // another update landed in between, the shown diff is stale.
        throw new Error(
          `'${entry.name}' changed since you reviewed the update (installed ${entry.lockedSha.slice(0, 12)}, reviewed against ${args.consent.fromSha.slice(0, 12)}). Check for updates again.`
        );
      }
      // Consent installs exactly the reviewed commit (mirroring install's
      // expectedSha): if the branch moved on since the review, the newer
      // commit was never shown to the user and surfaces on the next check.
      const targetSha = args.consent?.toSha ?? resolved.sha;
      if (targetSha === entry.lockedSha) {
        return entry; // Already current.
      }

      const { stagedDir, plugin } = await this.stageUpdate(entry, targetSha);
      try {
        const targetPath = this.targetPathFor(entry.name);
        // Security: an update must not silently expand what the plugin can
        // do — a compromised upstream could add hooks.js plus a bash grant
        // and auto-load it on the next request. Compare the staged tree's
        // capability surface against the installed tree; changes need a
        // consent from previewUpdate naming this exact (from, to) pair,
        // which the user gave after seeing every change.
        const changes = await this.collectCapabilityChanges(entry.name, targetPath, plugin);
        if (changes.length > 0 && args.consent === undefined) {
          throw new Error(
            `The update to '${entry.name}' ${changes.map((change) => change.summary).join("; ")}. Updates cannot expand a plugin's capabilities without review — open Settings → Plugins and review the update to confirm it.`
          );
        }

        await this.removeDir(path.join(stagedDir, ".git"));

        const serverKeyPrefix = buildPluginServerKey(this.instanceIdFor(entry.name), "");
        const trashDir = path.join(this.stagingRoot, `trash-${Date.now()}-${entry.name}`);
        const hadOldTree = await pathExists(targetPath);

        // Stop this plugin's running MCP servers BEFORE the old tree moves:
        // a live server can lose its files mid-swap on POSIX, and open
        // handles can make the rename itself fail on Windows.
        await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

        // The nonce marker rides inside the staged tree through the promote
        // rename, letting crash recovery tell OUR promoted tree from an
        // unmanaged one a user placed at the then-empty target.
        const updateNonce = randomBytes(16).toString("hex");
        await fsPromises.writeFile(path.join(stagedDir, PROMOTION_MARKER_FILE), updateNonce);
        if (hadOldTree) {
          // Journal the swap BEFORE the live tree moves: a crash between the
          // rename below and the promote would leave the registry recording
          // an install whose path is missing — and retrying Update cannot
          // self-heal because assertNoCapabilityIncrease treats the missing
          // tree as an empty surface and rejects the staged capabilities as
          // additions. reconcileJournals restores the old tree on recovery.
          // newSha lets crash recovery reconcile registry provenance: a crash
          // between the promote below and the registry write leaves the
          // (consented) replacement live while the registry still claims the
          // old commit — recovery must be able to commit the recorded SHA.
          await this.writeJournalFile(updateJournalPath, {
            name: entry.name,
            trashDir,
            nonce: updateNonce,
            stagedAt: Date.now(),
            newSha: targetSha,
          });
          try {
            await this.renameIntoStaging(targetPath, trashDir);
          } catch (error) {
            // Nothing moved: no recovery needed.
            await this.consumeJournalFile(updateJournalPath).catch(() => undefined);
            throw error;
          }
        }
        try {
          await fsPromises.mkdir(this.containerDir, { recursive: true });
          await fsPromises.rename(stagedDir, targetPath);
        } catch (error) {
          if (hadOldTree) {
            // Roll the old tree back so a failed swap never leaves the plugin missing.
            try {
              await fsPromises.rename(trashDir, targetPath);
              this.activeStagingPaths.delete(trashDir);
              await this.consumeJournalFile(updateJournalPath).catch(() => undefined);
            } catch (rollbackError) {
              // Keep the journal: reconcileJournals restores the tree on the
              // next startup/section open.
              log.error("Failed to roll back plugin dir after failed update swap", {
                targetPath,
                rollbackError,
              });
            }
          }
          throw error;
        }
        // The new tree is live. Consume the JOURNAL before the marker, and
        // ENFORCE that ordering: a markerless target with the journal still
        // present is exactly the state recovery must treat as an unidentified
        // user replacement — deadlocking future updates. If the journal
        // cannot be deleted, keep the marker (it is the tree's identity for
        // the matching-nonce recovery branch, which retries this cleanup) and
        // leave the staged old tree pinned by the journal. Journal-first, a
        // crash merely leaves a stray marker in the live tree (harmless; the
        // next update swap discards it).
        let journalConsumed = true;
        if (hadOldTree) {
          try {
            await this.consumeJournalFile(updateJournalPath);
          } catch (error) {
            journalConsumed = false;
            log.warn(
              "Failed to delete the update journal; keeping the tree marker so recovery can finish",
              { name: entry.name, error: getErrorMessage(error) }
            );
          }
        }
        if (journalConsumed) {
          await fsPromises
            .rm(path.join(targetPath, PROMOTION_MARKER_FILE), { force: true })
            .catch(() => undefined);
          if (hadOldTree) {
            // Best-effort: the trash dir sits under the staging root, where
            // stale-dir reclamation cleans up leftovers.
            await this.removeDir(trashDir).catch((error: unknown) => {
              // The update transaction no longer owns this dir (journal
              // consumed above) — release it from the active set or every
              // later purgeStaleStaging in this process skips the very dir
              // this catch defers to reclamation, accumulating a full
              // checkout per failed deletion until restart.
              this.activeStagingPaths.delete(trashDir);
              log.warn(
                "Failed to delete replaced plugin tree; leaving it for staging reclamation",
                { trashDir, error: getErrorMessage(error) }
              );
            });
          }
        }
        if (!hadOldTree) {
          // No journal was written (no old tree to restore), so nothing
          // above bumped the mutation epoch. Bump it explicitly: sibling
          // processes' MCPServerManagers key their cross-process plugin
          // invalidation off this token, and a server launched before the
          // old tree went missing may still be running there. This bump is
          // the ONLY cross-process publication on this path (no journal, no
          // consume), so a failure must FAIL the update rather than commit
          // success — a sibling would otherwise observe neither a journal
          // nor a token change and keep serving the removed tree's server
          // indefinitely. The registry still holds the old lockedSha, the
          // update badge stays visible, and the retry runs the journaled
          // swap path (the promoted tree now exists), whose journal
          // lifecycle republishes the epoch or retains a durable record.
          try {
            await bumpContainerMutationEpoch(this.stagingRoot);
          } catch (error) {
            throw new Error(
              `The new plugin tree is in place, but publishing the change to other Mux processes failed (${getErrorMessage(error)}). Retry the update.`
            );
          }
        }

        const updated: AgentPluginInstallEntry = {
          ...entry,
          lockedSha: targetSha,
          updatedAt: new Date().toISOString(),
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        // The new tree is already promoted; a failed write surfaces as an
        // error and the stale lockedSha keeps the update badge visible, so
        // retrying the update self-heals the mismatch.
        //
        // Patch ONLY the fields this update owns (lockedSha, updatedAt, and
        // the manifest's version/description) into the RAW entry: spreading
        // the Zod-parsed entry would replace `source`/`manifest` wholesale
        // with their stripped counterparts, deleting nested metadata a newer
        // build may have stored there (breaking downgrade round-trips).
        try {
          await this.writeRegistry(
            envelope,
            rawRegistry.map((rawEntry) => {
              if (this.rawEntryName(rawEntry) !== entry.name) {
                return rawEntry;
              }
              const rawRecord = rawEntry as Record<string, unknown>;
              const rawManifest =
                typeof rawRecord.manifest === "object" &&
                rawRecord.manifest !== null &&
                !Array.isArray(rawRecord.manifest)
                  ? (rawRecord.manifest as Record<string, unknown>)
                  : {};
              // version/description are owned by the update (they mirror the
              // newly installed plugin.json), so stale values are dropped and
              // fresh ones written; unknown manifest keys pass through.
              const {
                version: _staleVersion,
                description: _staleDescription,
                ...preservedManifest
              } = rawManifest;
              return {
                ...rawRecord,
                lockedSha: updated.lockedSha,
                updatedAt: updated.updatedAt,
                manifest: { ...preservedManifest, ...updated.manifest },
              };
            })
          );
        } finally {
          // Recycle post-promote even when the registry write fails: the tree
          // already swapped, so (1) content changed behind a stable path —
          // possibly an unchanged stdio command line — which the config
          // signature cannot see, and (2) a concurrent getToolsForWorkspace
          // that began after the pre-swap invalidation but discovered the
          // plugin before the rename may have published a server from the
          // replaced tree. Servers restart on next use; default-disabled
          // state and workspace overrides are untouched (identity is the
          // lexical path).
          await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);
        }

        log.info(
          `Updated agent plugin '${entry.name}' ${entry.lockedSha.slice(0, 12)} → ${targetSha.slice(0, 12)}`
        );
        return updated;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }
}
