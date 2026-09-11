/**
 * Sandbox Host Service (substrate 3 of the shared agent foundation).
 *
 * One home for QuickJS guest hosting with two mount lifetimes:
 * - `ephemeral`: per-call, behaviorally identical to the pre-service
 *   code_execution flow (create → eval → dispose).
 * - `persistent`: per-workspace-session; the runtime survives across
 *   code_execution calls and turns, is disposed on workspace archive/reset,
 *   and exposes a guest-visible `vars` namespace whose JSON-serializable
 *   contents the host snapshots via the journal kit (contract: data only —
 *   functions/closures are not captured).
 *
 * Persistent mounts also get:
 * - an async capability bridge (runtime.registerPromiseFunction) — used by
 *   Track 2 for `mux.task({background:true})`-style handles;
 * - host→guest event delivery: a queue drained from the guest via the global
 *   `drainHostEvents()` (queue + drain model, no interrupts).
 *
 * WorkflowRunner intentionally keeps constructing runtimes through
 * IJSRuntimeFactory directly: its replay-safety must not regress, and it
 * already consumes the same abstract interface (migration note per handoff).
 */

import assert from "node:assert";
import type { BlobRef, DurableEvent } from "@/common/types/durableEvent";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { resolveCapabilityGrants, type CapabilityGrants } from "@/common/types/capabilityGrants";
import {
  sharedDurableEventJournal,
  type DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import {
  canDeleteEvictedBlob,
  makeSnapshotLatestResolver,
  publishQuotaRetention,
  walkBlobQuota,
  type BlobQuotaEntry,
} from "@/node/utils/journal/blobReclamation";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { log } from "@/node/services/log";
import { TASK_TERMINAL_EVENT_TYPE } from "@/constants/sandboxEvents";
import {
  buildHandlePreview,
  RESULT_HANDLE_BLOB_QUOTA_BYTES,
  RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES,
  RESULT_HANDLE_VARS_CAP_BYTES,
  VARS_SNAPSHOT_MAX_BYTES,
} from "@/constants/resultHandles";

/**
 * Thrown by the vars-persist precondition when a FOREIGN instance changed the
 * scope's durable state — an explicit context reset (r52) or an ordinary
 * newer snapshot (r67) — while this mount was live (r68). Typed so
 * code_execution can surface the call as a retryable conflict instead of a
 * generic snapshot failure: the eval may have read stale vars and its
 * mutations were refused, so reporting success would silently drop them and
 * leave stale computed results model-visible.
 */
export class SandboxSnapshotConflictError extends Error {}

/**
 * Thrown when a vars snapshot exceeds VARS_SNAPSHOT_MAX_BYTES. A distinct
 * class so code_execution can surface a targeted "trim your vars" notice to
 * the model instead of a generic snapshot failure.
 */
export class VarsSnapshotBudgetError extends Error {
  constructor(sizeBytes: number) {
    super(
      `vars snapshot is ${sizeBytes} bytes, exceeding the ${VARS_SNAPSHOT_MAX_BYTES}-byte budget; ` +
        `state was NOT persisted and this call's vars mutations (including any new handles or ` +
        `loads) will NOT survive — remove or shrink large vars entries`
    );
    this.name = "VarsSnapshotBudgetError";
  }
}

/**
 * Per-journal incremental reclamation state (Codex round 6: both passes ran
 * after EVERY kernel call and re-derived their candidates from the full
 * journal, retrying deletions earlier passes already performed — quadratic
 * work over a long session). Keyed by the journal instance, NOT the mount:
 * mounts are rebuilt on grant/bridge changes without a process restart, and
 * the shared journal is the one identity that lives exactly as long as the
 * in-memory index this state depends on. A fresh process starts empty, so
 * the first pass per concern runs a full recovery sweep — that is also what
 * heals leftovers from crashes or failed best-effort deletions.
 */
interface JournalReclamationState {
  /** Latest published snapshot ref per scope, with the journal.blobIndexEpoch
   * it was recorded at. A present key with a CURRENT epoch means this process
   * already swept the scope, so each later persist reclaims exactly the one
   * ref that just ceased being latest. A stale epoch means a foreign process
   * appended since (r43): its snapshots may have been superseded without this
   * process ever caching them, so the scope must re-derive candidates from
   * the mention index before the incremental fast path may resume. */
  latestSnapshotRef: Map<string, { ref: BlobRef; epoch: number }>;
  /** Handle payloads currently retained under the quota, newest first
   * (bounded by quota/offload-threshold); null until the recovery sweep. */
  retainedHandles: BlobQuotaEntry[] | null;
  /** journal.blobIndexEpoch retainedHandles was derived at: foreign appends
   * (debug CLI) move the epoch, and a stale list must be re-derived from the
   * journal before it may authorize releases (round 14). */
  retainedHandlesEpoch: number;
}

const reclamationStates = new WeakMap<DurableEventJournal, JournalReclamationState>();

function reclamationStateFor(journal: DurableEventJournal): JournalReclamationState {
  let state = reclamationStates.get(journal);
  if (!state) {
    state = { latestSnapshotRef: new Map(), retainedHandles: null, retainedHandlesEpoch: -1 };
    reclamationStates.set(journal, state);
  }
  return state;
}

/**
 * Delete blob payloads of superseded vars snapshots for one scope: only the
 * LATEST snapshot per scope is ever restored, so older versions are pure
 * disk growth. Incremental — after the first persist's recovery sweep, each
 * pass considers exactly the previous latest ref (see
 * JournalReclamationState). The whole decide→delete window holds the journal
 * blob lock so a publisher's put→append window can never be observed.
 *
 * Exported for tests (restart/recovery interleavings need direct calls).
 */
export async function reclaimSupersededSnapshotBlobs(
  journal: DurableEventJournal,
  scopeKey: string,
  latestRef: BlobRef
): Promise<void> {
  assert(scopeKey.length > 0, "reclaimSupersededSnapshotBlobs requires a scopeKey");
  await journal.withBlobLock(async () => {
    const state = reclamationStateFor(journal);
    const previous = state.latestSnapshotRef.get(scopeKey);
    const index = await journal.blobMentionIndex();
    // Epoch check AFTER blobMentionIndex(): that call detects foreign
    // appends. The incremental fast path is only sound while no other
    // process appended since our cache was recorded — a foreign backend
    // (XUM_ALLOW_MULTIPLE_INSTANCES=1) may have published and superseded
    // snapshots this process never cached, and alternating kernel calls
    // across two backends would otherwise leak an unbounded run of foreign
    // snapshot blobs until a restart's recovery sweep (r43).
    const epoch = journal.blobIndexEpoch;
    const incremental = previous?.epoch === epoch;
    // Record the new latest BEFORE deleting: a failed best-effort deletion
    // must not be retried on every later persist (the next process's
    // recovery sweep heals it instead).
    state.latestSnapshotRef.set(scopeKey, { ref: latestRef, epoch });
    if (incremental && previous.ref === latestRef) return;

    const candidates = incremental
      ? [previous.ref]
      : // Recovery sweep: first persist for this scope since process start,
        // or a foreign append invalidated the cache. A ref mentioned by a
        // snapshot row of this scope IS some snapshot's blobHash — that is
        // the kind's only ref-valued field. latestRef is deliberately NOT
        // excluded (r44): a foreign backend may have published a NEWER
        // snapshot for this scope between our publishWithBlob() releasing
        // the blob lock and this pass acquiring it, making our just-published
        // ref the superseded one — the journal-truth resolver below retains
        // whichever ref is actually latest and reclaims the rest.
        [...index.entries()]
          .filter(([, mentions]) => mentions.snapshotScopes.has(scopeKey))
          .map(([ref]) => ref);
    // Seed our own scope's latest ONLY on the incremental fast path: epoch
    // equality proves no foreign append exists since our cache was recorded,
    // so the ref we just published IS the journal's latest for this scope and
    // the common single-scope case needs no journal read. Seeding the sweep
    // would misreport a stale ref as latest and authorize deleting the
    // scope's actual latest restore payload (r44) — the sweep resolver must
    // read journal truth under the lock instead.
    const resolveLatestSnapshot = incremental
      ? makeSnapshotLatestResolver(journal, { scopeKey, ref: latestRef })
      : makeSnapshotLatestResolver(journal);
    for (const ref of candidates) {
      const deletable = await canDeleteEvictedBlob({
        journal,
        ref,
        mentions: index.get(ref),
        resolveLatestSnapshot,
      });
      if (!deletable) continue;
      await journal.deleteBlobUnderLock(ref);
    }
  });
}

/**
 * Enforce the per-session quota on retained result-handle blob bytes.
 * Newest-first: recent handles keep their durable payloads (they may still be
 * recoverable from vars or wanted for a follow-up read); once the cumulative
 * size crosses the quota, older payloads are deleted. Incremental — pass the
 * just-published handle and the quota walk runs over the in-memory retained
 * list instead of the journal, so payloads evicted by earlier passes are
 * never revisited. The first pass per process (or a call without
 * `published`) runs a full recovery sweep. Reference safety and locking:
 * see canDeleteEvictedBlob / reclaimSupersededSnapshotBlobs.
 *
 * Exported for tests (quota interleavings need synthetic event sizes).
 */
export async function reclaimExcessResultHandleBlobs(
  journal: DurableEventJournal,
  published?: BlobQuotaEntry
): Promise<void> {
  await journal.withBlobLock(async () => {
    const state = reclamationStateFor(journal);
    const index = await journal.blobMentionIndex();
    // Epoch check AFTER blobMentionIndex(): that call detects foreign
    // appends. A retained list from an older epoch may miss rows a foreign
    // process (debug CLI) appended and must be re-derived from the journal.
    const epoch = journal.blobIndexEpoch;
    let entries: BlobQuotaEntry[];
    if (
      state.retainedHandles !== null &&
      published !== undefined &&
      state.retainedHandlesEpoch === epoch
    ) {
      entries = [published, ...state.retainedHandles];
    } else {
      // Recovery sweep: replay every result-handle row newest-first. Rows
      // whose payloads were already reclaimed re-enter the walk, but their
      // deletions are idempotent no-ops and this runs once per process (or
      // per detected foreign append).
      const events = await journal.read();
      entries = [];
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.kind !== "result-handle") continue;
        entries.push({ ref: event.data.blobHash, size: event.data.size });
      }
    }
    const { retained, evictable } = walkBlobQuota(entries, RESULT_HANDLE_BLOB_QUOTA_BYTES);
    state.retainedHandles = retained;
    state.retainedHandlesEpoch = epoch;
    // Publish BEFORE deleting so joint retention decisions (ours and other
    // quotas') always see this pass's eviction verdicts.
    publishQuotaRetention(journal, "result-handle", new Set(retained.map((entry) => entry.ref)));
    const resolveLatestSnapshot = makeSnapshotLatestResolver(journal);
    for (const ref of evictable) {
      const deletable = await canDeleteEvictedBlob({
        journal,
        ref,
        mentions: index.get(ref),
        resolveLatestSnapshot,
      });
      if (!deletable) continue;
      await journal.deleteBlobUnderLock(ref);
    }
  });
}

export type SandboxMountLifetime = "ephemeral" | "persistent";

/**
 * Reserved guest `vars` key carrying a persistent mount's project-skill taint
 * (see SandboxMount.projectSkillTainted) through the vars snapshot, so the
 * taint survives restarts together with the vars that may hold the content.
 * "1" = tainted, "0" = verified clean at persist time; the host re-asserts it
 * before every snapshot (guest code can delete or rewrite the key). A snapshot
 * WITHOUT the marker predates it or lost it: its retained vars may hold
 * content nobody classified, so restore treats it as tainted unless the
 * namespace is empty.
 */
export const PROJECT_SKILL_TAINT_VAR = "__xumProjectSkillTaint";

/**
 * Cap on undrained host events per mount. Guests that never call
 * mux.events() must not grow the queue unboundedly across a long-lived
 * workspace; oldest events are dropped first (the queue is best-effort —
 * the durable terminal wake still reports every completion).
 */
const HOST_EVENT_QUEUE_CAP = 256;

/** Terminal report of a spawned child task, delivered into the guest queue. */
export interface TaskTerminalEventArgs {
  taskId: string;
  status: "completed";
  reportMarkdown: string;
}

/** Payload for durably persisting an offloaded result handle (blob + event). */
export interface ResultHandlePersistArgs {
  /** Model-visible guest expression for the handle, e.g. "vars.__h3". */
  handle: string;
  /** Bounded excerpt; must be exactly the model-visible preview string. */
  preview: string;
  /** Full serialized value (JSON text) to store in the blob store. */
  serialized: string;
}

export interface AcquireMountOptions {
  lifetime: SandboxMountLifetime;
  /**
   * Factory for creating the guest runtime. Caller-provided (rather than a
   * service default) so this module never statically pulls the QuickJS WASM
   * stack — toolAssembly lazy-loads PTC deliberately, and archive/reset
   * disposal must be importable from startup paths.
   */
  runtimeFactory: IJSRuntimeFactory;
  /** Stable scope identity (workspaceId). Required for persistent mounts. */
  scopeKey?: string;
  /** Session dir for vars snapshots (journal + blobs). Required for persistent mounts. */
  sessionDir?: string;
  /** Capability grants for this mount. Defaults to session-scope grants. */
  grants?: CapabilityGrants;
  /**
   * Identity of the effective bridge configuration (e.g. sorted bridgeable
   * tool names). Persistent guests can save bridge function references in
   * globals (`globalThis.saved = mux.bash`) that survive re-registration, so
   * when the effective bridge NARROWS the mount must be rebuilt — destroying
   * the runtime is the only reliable way to revoke saved closures. Vars
   * survive via snapshot/restore.
   */
  bridgeKey?: string;
}

/**
 * Guest-side EXACT UTF-8 byte measurement (r24). Retention budgets are BYTE
 * caps — persistVars enforces VARS_SNAPSHOT_MAX_BYTES with Buffer.byteLength
 * — but managed-entry sizes were measured as JSON.stringify().length (UTF-16
 * code units), under-counting multibyte payloads by up to 4x: ~3MB of
 * CJK/emoji passed the 4MB retention cap unevicted while the real snapshot
 * blew the 8MB byte budget, so persistVars threw VarsSnapshotBudgetError and
 * the mount reset wiped unsnapshotted working state instead of retention
 * evicting oldest entries.
 *
 * Counted with C-speed regex scans instead of a per-code-unit loop (multi-MB
 * payloads would interpret millions of iterations) and replace("") length
 * deltas instead of match() (which allocates one array element per match):
 * base 1 byte per code unit; U+0080-07FF +1; U+0800-FFFF non-surrogate +2;
 * surrogate PAIRS 4 bytes per 2 units (+1 per unit); LONE surrogates encode
 * as the 3-byte replacement char (+2 per unit), matching Buffer.byteLength
 * host-side.
 */
const GUEST_UTF8_LEN_SOURCE = `
      function utf8Len(s) {
        if (!/[\\u0080-\\uffff]/.test(s)) return s.length;
        let bytes = s.length;
        bytes += s.length - s.replace(/[\\u0080-\\u07ff]/g, "").length;
        bytes += (s.length - s.replace(/[\\u0800-\\ud7ff\\ue000-\\uffff]/g, "").length) * 2;
        const noPairs = s.replace(/[\\ud800-\\udbff][\\udc00-\\udfff]/g, "");
        bytes += s.length - noPairs.length;
        bytes += (noPairs.length - noPairs.replace(/[\\ud800-\\udfff]/g, "").length) * 2;
        return bytes;
      }
      function measureVarBytes(key) {
        // Unmeasurable (guest mutated the entry into a cycle, or deleted it)
        // counts as 0; snapshotVars is where cycles crash-fast.
        try {
          const s = JSON.stringify(vars[key]);
          return typeof s === "string" ? utf8Len(s) : 0;
        } catch (err) {
          return 0;
        }
      }
`;

/**
 * Guest-side collision-free handle sequencing (r24). vars is guest-writable,
 * so vars.__handleSeq can be clobbered (null, "garbage", 0, deleted,
 * Infinity, MAX_SAFE_INTEGER). The old fallback `(isFinite ? floor : 0) + 1`
 * restarted numbering at 1 — the next __hN handle OVERWROTE the oldest live
 * handle — and an unsafe-integer counter lost precision on + 1. Recovery
 * instead derives the next sequence from what actually exists: max of all
 * live __hN keys, all __loadMeta seqs, and a sanitized
 * (Number.isSafeInteger) counter, plus one. A clobbered counter therefore
 * never reuses a live key — worst case it skips numbers.
 *
 * r27: max + 1 must not cross the safe-integer ceiling. A guest key at
 * Number.MAX_SAFE_INTEGER (__h9007199254740991) makes the candidate unsafe;
 * the sanitizers above then ignore the stored counter on every later call
 * while the ceiling key keeps winning the scan, so the SAME oversized key
 * would be minted forever — each offload overwriting the previous one.
 * When the candidate is unsafe (or its key somehow already exists), fall
 * back to probing for the smallest free positive integer instead: the probe
 * is bounded by the live key count and only runs in this guest-adversarial
 * case, at the cost of age-order accuracy for the recovered handle.
 */
const GUEST_NEXT_HANDLE_SEQ_SOURCE = `
      function nextHandleSeq() {
        let maxSeq = 0;
        for (const k of Object.keys(vars)) {
          const m = /^__h(\\d+)$/.exec(k);
          if (m === null) continue;
          const n = Number(m[1]);
          if (Number.isSafeInteger(n) && n > maxSeq) maxSeq = n;
        }
        const metaRaw = vars.__loadMeta;
        const meta = typeof metaRaw === "object" && metaRaw !== null ? metaRaw : {};
        for (const k of Object.keys(meta)) {
          const n = meta[k];
          if (typeof n === "number" && Number.isSafeInteger(n) && n > maxSeq) maxSeq = n;
        }
        const seqRaw = vars.__handleSeq;
        const current =
          typeof seqRaw === "number" && Number.isSafeInteger(seqRaw) && seqRaw > 0 ? seqRaw : 0;
        const candidate = Math.max(maxSeq, current) + 1;
        if (
          Number.isSafeInteger(candidate) &&
          !Object.prototype.hasOwnProperty.call(vars, "__h" + candidate)
        ) {
          return candidate;
        }
        // Safe-integer ceiling (or key collision): probe the smallest free
        // key instead of reusing one — see the r27 note above.
        for (let n = 1; ; n++) {
          if (!Object.prototype.hasOwnProperty.call(vars, "__h" + n)) return n;
        }
      }
`;

export class SandboxMount {
  private readonly hostEventQueue: unknown[] = [];
  private disposed = false;
  /**
   * A nested agent_skill_read(_file) on this mount returned PROJECT-scope
   * skill content: vars can hold it for later calls, so every later
   * code_execution result on the mount is stamped as project content (see
   * CodeExecutionResult.carriesProjectSkillContent). Restored from the vars
   * snapshot (PROJECT_SKILL_TAINT_VAR) and re-asserted before each persist.
   */
  projectSkillTainted = false;

  constructor(
    public readonly runtime: IJSRuntime,
    public readonly lifetime: SandboxMountLifetime,
    public readonly grants: CapabilityGrants,
    public readonly scopeKey?: string,
    /** Bound by the host service; persists a vars snapshot via the journal kit. */
    private readonly persistSnapshot?: (varsJson: string) => Promise<void>,
    /** Persistent mounts share the host's per-scope mutex so exclusive() also
     * serializes against scope disposal; ephemeral mounts get their own. */
    private readonly mutex: AsyncMutex = new AsyncMutex(),
    /** Effective bridge configuration identity; see AcquireMountOptions. */
    public readonly bridgeKey?: string,
    /** Bound by the host service; persists an offloaded result handle
     * (full value blob + one result-handle durable event). */
    private readonly persistHandle?: (args: ResultHandlePersistArgs) => Promise<void>
  ) {
    // Late capability settlements (fire-and-forget guest code) must not
    // re-enter the shared runtime while a later eval holds it: route their
    // pending-job execution through the same exclusive lock.
    runtime.setPendingJobGate((run) => {
      this.exclusive(async () => {
        run();
        // The continuation may have mutated vars AFTER the originating call's
        // snapshot: persist so a restart cannot resurrect older state (memory
        // and disk must agree — mirrors code_execution's post-eval path,
        // including dispose-on-failure so an unsnapshottable state cannot
        // linger).
        if (!this.disposed && this.lifetime === "persistent" && this.grants.vars) {
          try {
            await this.persistVars();
          } catch (error) {
            log.warn(
              "SandboxMount: vars snapshot after gated continuation failed; disposing mount",
              { error }
            );
            this.dispose();
          }
        }
      }).catch((error: unknown) => {
        log.warn("SandboxMount: gated pending-job run failed", { error });
      });
    });
  }

  /**
   * Run `fn` with exclusive access to this mount's runtime. Concurrent
   * code_execution calls can share one persistent mount, but eval() mutates
   * runtime-wide state (abort controller, tool-call attribution, handlers),
   * so evaluation + vars persistence must be serialized per runtime.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await using _lock = await this.mutex.acquire();
    return await fn();
  }

  /** Queue a host event for the guest. Guest drains via drainHostEvents(). */
  postHostEvent(event: unknown): void {
    this.assertNotDisposed("postHostEvent");
    assert(this.grants.hostEvents, "postHostEvent requires the hostEvents grant");
    // Drop-oldest beyond the cap: a guest that never drains must not grow
    // the queue unboundedly, and newer terminal events matter more.
    while (this.hostEventQueue.length >= HOST_EVENT_QUEUE_CAP) {
      this.hostEventQueue.shift();
    }
    this.hostEventQueue.push(event);
  }

  /** Drain the queued host events (called from the guest bridge function). */
  drainHostEvents(): unknown[] {
    const events = this.hostEventQueue.splice(0, this.hostEventQueue.length);
    return events;
  }

  /**
   * Snapshot the guest `vars` namespace as JSON text. Crashes fast (eval
   * error) if vars contains non-serializable values like cycles — the
   * contract is data only.
   */
  async snapshotVars(): Promise<string> {
    this.assertNotDisposed("snapshotVars");
    assert(this.grants.vars, "snapshotVars requires the vars grant");
    const result = await this.runtime.eval("return JSON.stringify(globalThis.vars ?? {});");
    assert(result.success, `snapshotVars failed: ${result.error ?? "unknown error"}`);
    assert(typeof result.result === "string", "snapshotVars: expected JSON string result");
    return result.result;
  }

  /** Replace the guest `vars` namespace from JSON text (snapshot restore). */
  async restoreVars(varsJson: string): Promise<void> {
    this.assertNotDisposed("restoreVars");
    assert(this.grants.vars, "restoreVars requires the vars grant");
    // Parse host-side first: crash-fast on corrupted snapshots instead of
    // injecting garbage into the guest.
    const restored: unknown = JSON.parse(varsJson);
    // Markerless snapshots (pre-marker builds, or a guest that deleted the
    // key before a persist that never re-asserted it) are unknown: retained
    // vars may hold project skill content, so they restore TAINTED. An empty
    // namespace retains nothing — reset tombstones and never-used scopes stay
    // clean.
    const vars =
      typeof restored === "object" && restored !== null
        ? (restored as Record<string, unknown>)
        : {};
    const marker = vars[PROJECT_SKILL_TAINT_VAR];
    this.projectSkillTainted = marker === "1" || (marker !== "0" && Object.keys(vars).length > 0);
    const literal = JSON.stringify(varsJson);
    const result = await this.runtime.eval(
      `globalThis.vars = JSON.parse(${literal}); return true;`
    );
    assert(result.success, `restoreVars failed: ${result.error ?? "unknown error"}`);
  }

  /** Snapshot vars and persist through the journal kit (persistent mounts). */
  async persistVars(): Promise<void> {
    this.assertNotDisposed("persistVars");
    assert(
      this.persistSnapshot,
      "persistVars is only available on persistent mounts with a session dir"
    );
    // Always explicit: "0" marks a snapshot verified clean at persist time,
    // so restore can tell it from a legacy markerless one (which is unknown).
    this.runtime.setVarsProperty(PROJECT_SKILL_TAINT_VAR, this.projectSkillTainted ? "1" : "0");
    const varsJson = await this.snapshotVars();
    // Hard per-snapshot budget over ALL vars: retention only manages handle
    // and load keys, but every key is guest-writable — without this bound a
    // guest storing large changing values would grow the blob store without
    // limit. Callers dispose the mount on failure, so the next acquire
    // restores the last durable (in-budget) snapshot.
    const sizeBytes = Buffer.byteLength(varsJson, "utf8");
    if (sizeBytes > VARS_SNAPSHOT_MAX_BYTES) {
      throw new VarsSnapshotBudgetError(sizeBytes);
    }
    await this.persistSnapshot(varsJson);
  }

  /**
   * Store an offloaded value in the guest `vars` namespace under the next
   * monotonic handle key (__h1, __h2, ...). The sequence counter lives in
   * vars.__handleSeq so it snapshots/restores with vars — handles stay
   * monotonic per scope across restarts, and a guest-clobbered counter
   * recovers without reusing live keys (GUEST_NEXT_HANDLE_SEQ_SOURCE).
   * Returns the handle key.
   *
   * Also enforces `capBytes` on the total bytes retained by handle vars,
   * evicting oldest-first (sizes measured as exact UTF-8 bytes of the JSON
   * serialization — the unit persistVars enforces, so multibyte payloads
   * cannot pass the cap while blowing the snapshot budget; see
   * GUEST_UTF8_LEN_SOURCE). The just-stored handle is never evicted even
   * when it alone exceeds the cap: the model is about to be told the handle
   * exists and a follow-up call must find it, so the cap is soft by one
   * entry. Eviction only drops the guest-local copy — the blob store keeps
   * the durable one.
   */
  async storeResultHandle(serializedValue: string, capBytes: number): Promise<string> {
    this.assertNotDisposed("storeResultHandle");
    assert(this.lifetime === "persistent", "storeResultHandle requires a persistent mount");
    assert(this.grants.vars, "storeResultHandle requires the vars grant");
    assert(
      Number.isSafeInteger(capBytes) && capBytes > 0,
      "storeResultHandle: capBytes must be a positive integer"
    );
    const literal = JSON.stringify(serializedValue);
    // The new handle's own size is known host-side: measure it in UTF-8
    // bytes (the budget unit), not string length.
    const serializedByteLength = Buffer.byteLength(serializedValue, "utf8");
    const result = await this.runtime.eval(
      `
      ${GUEST_UTF8_LEN_SOURCE}
      ${GUEST_NEXT_HANDLE_SEQ_SOURCE}
      const value = JSON.parse(${literal});
      // r28: a guest-primitive vars (vars = 1) silently swallows property
      // writes in non-strict code — the handle assignment no-oped while the
      // key was still returned, pointing the model at a handle that never
      // existed (vars = null at least threw and failed cleanly). A
      // primitive/null namespace is already unusable state (every read
      // yields undefined or throws), so resetting it to a plain object is
      // strictly an improvement — the same recovery setVarsProperty applies
      // for loads. Arrays too (r49): named properties DO store on an array
      // (the read-back check passes) but JSON.stringify(vars) ignores them,
      // so the snapshot would durably commit [] while the handle event was
      // published — after a restart the advertised handle is gone.
      if (typeof vars !== "object" || vars === null || Array.isArray(vars)) vars = {};
      const seq = nextHandleSeq();
      vars.__handleSeq = seq;
      const key = "__h" + seq;
      vars[key] = value;
      // Verify the write actually stored (a guest Proxy/setter can still
      // swallow it): fail the eval so the caller degrades to a bounded
      // truncated record instead of advertising a missing handle.
      if (vars[key] !== value) throw new Error("vars handle assignment did not store");
      // r54: the identity check above goes through the same [[Get]] a lying
      // Proxy controls — a get trap can echo the assigned value while
      // [[OwnPropertyKeys]] omits the key, and JSON.stringify(vars) (what
      // the durable snapshot persists) would drop the handle: after a
      // restart the advertised handle is gone. Verify through the
      // serialization itself.
      {
        const round = JSON.parse(JSON.stringify(vars));
        if (
          round === null ||
          typeof round !== "object" ||
          JSON.stringify(round[key]) !== JSON.stringify(value)
        ) {
          throw new Error("vars handle assignment did not survive serialization");
        }
      }
      const others = [];
      for (const k of Object.keys(vars)) {
        if (k === key) continue;
        const m = /^__h(\\d+)$/.exec(k);
        if (m === null) continue;
        others.push({ key: k, n: Number(m[1]), bytes: measureVarBytes(k) });
      }
      others.sort((a, b) => a.n - b.n);
      let total = ${serializedByteLength};
      for (const h of others) total += h.bytes;
      for (const h of others) {
        if (total <= ${capBytes}) break;
        delete vars[h.key];
        total -= h.bytes;
      }
      return key;
      `
    );
    assert(result.success, `storeResultHandle failed: ${result.error ?? "unknown error"}`);
    const key = result.result;
    assert(
      typeof key === "string" && /^__h\d+$/.test(key),
      "storeResultHandle: expected a handle key result"
    );
    return key;
  }

  /**
   * r12: loads count toward the r4 vars retention cap. Registers this call's
   * mux.load keys in `vars.__loadMeta` (key → seq from the shared
   * `__handleSeq` counter, so handles and loads share one age order), then
   * measures the live bytes of ALL managed entries (__hN handles + load
   * keys) and evicts oldest-first until the total fits `capBytes`.
   *
   * `protectedKeys` (this call's new loads + the return handle the model was
   * just told about) are never evicted — same "soft by current entries"
   * rationale as storeResultHandle: the model must be able to find what it
   * was just promised in a follow-up call. Evicting an OLD load drops only
   * the guest-local copy the model deliberately named; unlike handles there
   * is no blob backup, so the model must re-load the file if it still needs
   * it (the eviction is bounded-state over convenience, mirroring r4).
   */
  async enforceVarsRetention(args: {
    newLoadKeys: string[];
    protectedKeys: string[];
    capBytes: number;
  }): Promise<void> {
    this.assertNotDisposed("enforceVarsRetention");
    assert(this.lifetime === "persistent", "enforceVarsRetention requires a persistent mount");
    assert(this.grants.vars, "enforceVarsRetention requires the vars grant");
    assert(
      Number.isSafeInteger(args.capBytes) && args.capBytes > 0,
      "enforceVarsRetention: capBytes must be a positive integer"
    );
    const result = await this.runtime.eval(
      `
      ${GUEST_UTF8_LEN_SOURCE}
      ${GUEST_NEXT_HANDLE_SEQ_SOURCE}
      const newLoads = ${JSON.stringify(args.newLoadKeys)};
      const protectedKeys = ${JSON.stringify(args.protectedKeys)};
      const cap = ${args.capBytes};
      // Same guest-primitive recovery as storeResultHandle (r28): the
      // registry writes below would silently no-op on a primitive vars.
      if (typeof vars !== "object" || vars === null) vars = {};
      const metaRaw = vars.__loadMeta;
      // Rebuild the registry as a FRESH plain object every pass (r32): the
      // guest can clobber vars.__loadMeta with a frozen object or a
      // write-swallowing Proxy, and the registration writes below would then
      // silently no-op in non-strict eval — new loads would never count
      // toward the retention cap until the snapshot ceiling reset the
      // kernel. Copy over only sane surviving entries; a hostile registry
      // that throws on enumeration fails this eval (the host asserts
      // success), an honest failure instead of a cap bypass.
      const meta = {};
      if (typeof metaRaw === "object" && metaRaw !== null) {
        for (const k of Object.keys(metaRaw)) {
          const v = metaRaw[k];
          if (typeof v === "number" && isFinite(v)) meta[k] = v;
        }
      }
      vars.__loadMeta = meta;
      if (vars.__loadMeta !== meta) {
        throw new Error("vars.__loadMeta write rejected by guest vars object");
      }
      for (const key of newLoads) {
        const seq = nextHandleSeq();
        vars.__handleSeq = seq;
        meta[key] = seq;
      }
      // Drop registry entries whose key the guest already deleted.
      for (const key of Object.keys(meta)) {
        if (!Object.prototype.hasOwnProperty.call(vars, key)) delete meta[key];
      }
      const entries = [];
      for (const k of Object.keys(vars)) {
        const m = /^__h(\\d+)$/.exec(k);
        if (m !== null) {
          entries.push({ key: k, n: Number(m[1]), load: false, bytes: 0 });
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(meta, k)) {
          const n = meta[k];
          entries.push({
            key: k,
            n: typeof n === "number" && isFinite(n) ? n : 0,
            load: true,
            bytes: 0,
          });
        }
      }
      let total = 0;
      for (const e of entries) {
        e.bytes = measureVarBytes(e.key);
        total += e.bytes;
      }
      entries.sort((a, b) => a.n - b.n);
      const isProtected = {};
      for (const k of protectedKeys) isProtected[k] = true;
      for (const e of entries) {
        if (total <= cap) break;
        if (isProtected[e.key] === true) continue;
        delete vars[e.key];
        if (e.load) delete meta[e.key];
        total -= e.bytes;
      }
      return true;
      `
    );
    assert(result.success, `enforceVarsRetention failed: ${result.error ?? "unknown error"}`);
  }

  /** Durably persist an offloaded result: full-value blob + result-handle event. */
  async persistResultHandle(args: ResultHandlePersistArgs): Promise<void> {
    this.assertNotDisposed("persistResultHandle");
    assert(
      this.persistHandle,
      "persistResultHandle is only available on persistent mounts with a session dir"
    );
    await this.persistHandle(args);
  }

  /** Per-call release: disposes ephemeral mounts, keeps persistent ones alive. */
  release(): void {
    if (this.lifetime === "ephemeral") {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runtime.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertNotDisposed(method: string): void {
    assert(!this.disposed, `SandboxMount.${method} called after dispose`);
  }
}

/** Stable identity for a grant set, used to detect grant changes on reuse. */
function grantsKey(grants: CapabilityGrants): string {
  const allow = grants.bridgeTools.allow;
  const tools = allow === "all" ? "all" : [...allow].sort().join(",");
  return `${grants.version}|${tools}|${grants.vars}|${grants.hostEvents}`;
}

export class SandboxHostService {
  private readonly persistentMounts = new Map<string, SandboxMount>();

  /**
   * Journal reset generation each persistent mount was created against
   * (r52): the count of reset-marked snapshot rows for its scope at mount
   * time. Process-local scope locks cannot invalidate a mount alive in
   * ANOTHER backend (XUM_ALLOW_MULTIPLE_INSTANCES=1), so every lease and
   * every persist re-verifies this against the shared journal; a mismatch
   * means a foreign context reset landed and the mount's vars are discarded
   * state that must be neither exposed to guest code nor re-persisted.
   */
  private readonly mountResetGenerations = new WeakMap<SandboxMount, number>();
  /**
   * Snapshot lineage per live mount (r67): the journal seq of the newest
   * vars-snapshot row this mount restored from or published. The reset
   * generation above only notices explicit context resets; a foreign backend
   * (XUM_ALLOW_MULTIPLE_INSTANCES=1) publishing an ORDINARY snapshot would
   * otherwise go unseen — this mount would keep serving its stale namespace
   * and later persist it as the newest snapshot, silently discarding the
   * foreign write. Held as a shared mutable holder so the persist callback
   * (created before the mount) and the lease check can observe one value.
   */
  private readonly mountSnapshotLineages = new WeakMap<SandboxMount, { seq: number | null }>();
  /** Per-scope mutex serializing acquisition, exclusive runs, and disposal.
   * Kept for the process lifetime (bounded by workspace count). */
  private readonly scopeLocks = new Map<string, AsyncMutex>();
  /**
   * Scopes whose context reset has NOT been made durable yet: the mount was
   * disposed but the empty-snapshot tombstone failed to publish. While a
   * scope is pending, acquisition retries the tombstone and REFUSES to mount
   * until it lands — restoring the latest snapshot would resurrect values
   * the user explicitly cleared (potentially sensitive). In-memory only: a
   * crash before the retry lands loses the flag, so the next process can
   * still restore pre-reset state (unavoidable when durable storage is the
   * failing component; the reset caller is told loudly).
   */
  private readonly pendingDiscards = new Set<string>();

  private lockFor(scopeKey: string): AsyncMutex {
    let lock = this.scopeLocks.get(scopeKey);
    if (!lock) {
      lock = new AsyncMutex();
      this.scopeLocks.set(scopeKey, lock);
    }
    return lock;
  }

  /**
   * Acquire a mount. Ephemeral mounts are always fresh; persistent mounts are
   * reused per scopeKey and restored from the latest vars snapshot when
   * (re)created — this is the crash/restart recovery path.
   */
  async acquireMount(options: AcquireMountOptions): Promise<SandboxMount> {
    const grants = options.grants ?? resolveCapabilityGrants({ scope: "session" });

    if (options.lifetime === "ephemeral") {
      const runtime = await options.runtimeFactory.create();
      return new SandboxMount(runtime, "ephemeral", grants);
    }

    const scopeKey = options.scopeKey;
    assert(scopeKey, "persistent mounts require a scopeKey");

    // Serialize per scope: concurrent first acquisitions must not both create
    // runtimes (the map is only populated after several awaits), and
    // acquisition must not interleave with disposal or an exclusive run.
    const lock = this.lockFor(scopeKey);
    await using _guard = await lock.acquire();
    return await this.acquirePersistentMountLocked(options, grants);
  }

  /**
   * Run `fn` with a persistent mount while HOLDING the scope lock from
   * acquisition through execution. acquireMount + a later mount.exclusive()
   * leaves an unprotected gap where a concurrent grants/bridge change or
   * scope disposal can dispose the returned mount; this API closes that gap —
   * code_execution's register→eval→persist sequence runs entirely under one
   * lease. `fn` must NOT call mount.exclusive() (same non-reentrant lock).
   */
  async withPersistentMount<T>(
    options: AcquireMountOptions,
    fn: (mount: SandboxMount) => Promise<T>
  ): Promise<T> {
    assert(options.lifetime === "persistent", "withPersistentMount requires lifetime=persistent");
    const scopeKey = options.scopeKey;
    assert(scopeKey, "persistent mounts require a scopeKey");
    const grants = options.grants ?? resolveCapabilityGrants({ scope: "session" });

    const lock = this.lockFor(scopeKey);
    await using _guard = await lock.acquire();
    const mount = await this.acquirePersistentMountLocked(options, grants);
    return await fn(mount);
  }

  /** Get-or-create the persistent mount for a scope. Caller must hold the scope lock. */
  private async acquirePersistentMountLocked(
    options: AcquireMountOptions,
    grants: CapabilityGrants
  ): Promise<SandboxMount> {
    const scopeKey = options.scopeKey;
    const sessionDir = options.sessionDir;
    assert(scopeKey, "persistent mounts require a scopeKey");
    assert(sessionDir, "persistent mounts require a sessionDir");
    const journal = this.journalFor(sessionDir);

    const existing = this.persistentMounts.get(scopeKey);
    if (existing && !existing.isDisposed) {
      // Cross-process staleness check before every lease (r52): a foreign
      // backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) may have reset this scope
      // after our mount was created — the process-local scope lock and mount
      // map cannot invalidate a mount alive in another instance. A stale
      // mount would expose pre-reset vars to guest code, so it is disposed
      // WITHOUT persisting (disposeScopeLocked's snapshot would resurrect
      // exactly the vars the reset discarded) and rebuilt fresh below.
      // Snapshot lineage extends the same check to ORDINARY foreign
      // snapshots (r67): a foreign backend persisting vars advances the
      // scope's newest snapshot row; reusing this mount would expose the
      // superseded namespace and later persist it over the foreign write.
      // Dispose without persisting for the same reason as the reset case —
      // the rebuild below restores the newest (foreign) snapshot.
      const leaseEvents = await journal.read();
      const currentGeneration = countScopeResets(leaseEvents, scopeKey);
      const lineage = this.mountSnapshotLineages.get(existing);
      if (
        this.mountResetGenerations.get(existing) !== currentGeneration ||
        lineage?.seq !== latestScopeSnapshotSeq(leaseEvents, scopeKey)
      ) {
        this.persistentMounts.delete(scopeKey);
        existing.dispose();
      } else if (
        grantsKey(existing.grants) === grantsKey(grants) &&
        existing.bridgeKey === options.bridgeKey
      ) {
        return existing;
      } else {
        // Effective grants OR bridge configuration changed between requests
        // (e.g. policy narrowed): a mount must never outlive its capability
        // boundary, and rebuilding the runtime is the only way to revoke bridge
        // function references the guest saved in globals. Snapshot under the
        // OLD grants, dispose, and rebuild below.
        await this.disposeScopeLocked(scopeKey);
      }
    }
    if (this.pendingDiscards.has(scopeKey)) {
      // A context reset disposed this scope but its durable invalidation
      // never landed: retry it now and refuse the mount while it keeps
      // failing (initializeVars below would otherwise restore — resurrect —
      // the snapshot the user explicitly cleared).
      try {
        await this.publishDiscardTombstone(journal, scopeKey);
      } catch (error) {
        throw new Error(
          `sandbox scope '${scopeKey}' is reset-pending: the context reset's durable ` +
            `invalidation failed and retrying it failed again (mounting would resurrect ` +
            `cleared vars): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const runtime = await options.runtimeFactory.create();
    // Setup guard (r54): until ownership transfers to persistentMounts, any
    // failure below (journal read, vars restoration, bridge registration)
    // must dispose the freshly created runtime — retries would otherwise
    // leak one live sandbox runtime per attempt.
    let setupMount: SandboxMount | undefined;
    try {
      return await this.finishPersistentMountSetupLocked(options, grants, runtime, (mount) => {
        setupMount = mount;
      });
    } catch (error) {
      if (setupMount !== undefined) {
        setupMount.dispose();
      } else {
        runtime.dispose();
      }
      throw error;
    }
  }

  /** Setup steps after runtime creation; caller disposes on throw (r54). */
  private async finishPersistentMountSetupLocked(
    options: AcquireMountOptions,
    grants: CapabilityGrants,
    runtime: IJSRuntime,
    onMountConstructed: (mount: SandboxMount) => void
  ): Promise<SandboxMount> {
    const scopeKey = options.scopeKey;
    const sessionDir = options.sessionDir;
    assert(scopeKey, "persistent mounts require a scopeKey");
    assert(sessionDir, "persistent mounts require a sessionDir");
    const lock = this.lockFor(scopeKey);
    const journal = this.journalFor(sessionDir);
    // One journal read feeds both the reset generation this mount is created
    // against (r52) and the latest-snapshot restore below. Read AFTER the
    // pending-discard retry so a just-published tombstone is counted, and
    // AFTER the (slow, asynchronous) runtime creation (r53) so a foreign
    // reset landing during that window is already visible here. Mutable: the
    // post-restore stabilization loop below re-reads, and the persist
    // precondition compares against the binding's CURRENT value.
    let creationEvents = await journal.read();
    let mountResetGeneration = countScopeResets(creationEvents, scopeKey);
    // Shared mutable snapshot lineage (r67): see mountSnapshotLineages. The
    // persist callback below both verifies against and advances it, so it
    // must be one holder object rather than a rebinding local.
    const snapshotLineage = { seq: latestScopeSnapshotSeq(creationEvents, scopeKey) };
    const mount = new SandboxMount(
      runtime,
      "persistent",
      grants,
      scopeKey,
      async (varsJson) => {
        // Blob + event publish as one unit under the journal blob lock, so a
        // concurrent reclamation pass can never observe the put→append window.
        const { event, ref } = await journal.publishWithBlob(
          varsJson,
          (blobHash, size) => ({
            workspaceId: scopeKey,
            kind: "sandbox-vars-snapshot",
            data: { scopeKey, blobHash, size },
          }),
          {
            // Reset-generation verification INSIDE the blob lock (r52): the
            // tombstone publisher serializes on the same cross-process lock,
            // so this recount cannot miss a concurrent foreign reset — there
            // is no check→append window. Without it, a mount still alive in
            // another backend could publish its pre-reset vars as the newest
            // snapshot, superseding the tombstone and resurrecting context
            // the user discarded.
            precondition: async () => {
              const currentEvents = await journal.read();
              const current = countScopeResets(currentEvents, scopeKey);
              if (current !== mountResetGeneration) {
                throw new SandboxSnapshotConflictError(
                  `sandbox scope '${scopeKey}' was reset by another instance; ` +
                    `refusing to persist this mount's stale vars`
                );
              }
              // Snapshot-lineage verification (r67), same lock, same shape:
              // every snapshot publisher serializes on the blob lock, so a
              // foreign backend's ORDINARY persist landing after this
              // mount's restore/last persist is always visible here.
              // Refusing (rather than last-writer-wins) keeps the loss loud:
              // the caller disposes the mount and the next lease rebuilds
              // from the newest snapshot.
              if (latestScopeSnapshotSeq(currentEvents, scopeKey) !== snapshotLineage.seq) {
                throw new SandboxSnapshotConflictError(
                  `sandbox scope '${scopeKey}' vars were persisted by another instance; ` +
                    `refusing to overwrite the newer snapshot with this mount's stale vars`
                );
              }
            },
          }
        );
        // Our own publish is now the scope's newest snapshot row: advance the
        // lineage so subsequent persists from THIS mount verify cleanly.
        snapshotLineage.seq = event.seq;
        // Reclaim superseded snapshot blobs: only the LATEST snapshot per
        // scope is ever restored, so older versions are pure disk growth
        // (per-call persistence would otherwise retain every unique vars
        // version for the life of the session). Failure must never fail the
        // persist — reclamation is best-effort bookkeeping.
        try {
          await reclaimSupersededSnapshotBlobs(journal, scopeKey, ref);
        } catch (error) {
          log.debug("SandboxHostService: snapshot blob reclamation failed; continuing", { error });
        }
      },
      lock,
      options.bridgeKey,
      async ({ handle, preview, serialized }) => {
        // The blob is the durable copy of the full offloaded value; the event
        // row carries exactly the model-visible {handle, preview, size}. Both
        // publish as one unit under the journal blob lock (see publishWithBlob).
        const { ref, size } = await journal.publishWithBlob(serialized, (blobHash, blobSize) => ({
          workspaceId: scopeKey,
          kind: "result-handle",
          data: { handle, preview, blobHash, size: blobSize },
        }));
        // Bound retained handle payloads per session (best-effort — failure
        // must never fail the persist, mirroring snapshot reclamation).
        try {
          await reclaimExcessResultHandleBlobs(journal, { ref, size });
        } catch (error) {
          log.debug("SandboxHostService: result-handle blob reclamation failed; continuing", {
            error,
          });
        }
      }
    );

    // From here on, failure cleanup must dispose the MOUNT (which owns the
    // runtime), not the bare runtime (r54).
    onMountConstructed(mount);

    if (grants.vars) {
      // Post-restore stabilization (r53): vars restoration is itself
      // asynchronous, so a foreign reset can land between the events read
      // above and the restore completing — the mount would then expose
      // pre-reset vars to guest code even though the persist precondition
      // blocks saving them. Restore, then re-read: only a pass whose
      // post-restore read observes the same generation the restore used can
      // return the mount. Also stabilizes on snapshot lineage (r67): a
      // foreign ORDINARY snapshot landing inside the restore window would
      // otherwise birth the mount already stale (its first persist refused).
      // Terminates because each extra iteration requires ANOTHER foreign
      // publication landing inside the restore window; initializeVars is
      // idempotent (vars = {} then restore-latest).
      for (;;) {
        snapshotLineage.seq = latestScopeSnapshotSeq(creationEvents, scopeKey);
        await this.initializeVars(mount, journal, scopeKey, creationEvents);
        const recheckEvents = await journal.read();
        const recheckGeneration = countScopeResets(recheckEvents, scopeKey);
        if (
          recheckGeneration === mountResetGeneration &&
          latestScopeSnapshotSeq(recheckEvents, scopeKey) === snapshotLineage.seq
        ) {
          break;
        }
        creationEvents = recheckEvents;
        mountResetGeneration = recheckGeneration;
      }
    }
    this.mountResetGenerations.set(mount, mountResetGeneration);
    this.mountSnapshotLineages.set(mount, snapshotLineage);
    if (grants.hostEvents) {
      // Queue + drain: the guest polls for host events (task completions,
      // lifecycle notifications). Must be a SYNC bridge function: guests call
      // it from continuations after awaiting capability promises, where
      // asyncified functions cannot suspend.
      runtime.registerSyncFunction("drainHostEvents", () => mount.drainHostEvents());
    }

    this.persistentMounts.set(scopeKey, mount);
    return mount;
  }

  /**
   * Best-effort task-terminal delivery into a live persistent mount's
   * host→guest queue (fire-and-forget sub-agents, Track 2 r5). No live mount
   * / missing hostEvents grant => silently dropped: the queue is in-kernel
   * ACCELERATION only — the durable top-level terminal wake still reports
   * every completion, and an app restart dropping queued events is harmless
   * for the same reason.
   *
   * Sub-threshold reports post synchronously (plain array push, no lock:
   * single-threaded and drained only from inside guest evals). Oversized
   * reports are offloaded to an r4 result handle, which requires guest evals
   * under the scope lock — callers must NOT await behind that (a long-running
   * eval may hold the lock), so the returned promise is intended to be
   * consumed fire-and-forget with `.catch`.
   */
  async postTaskTerminalEvent(scopeKey: string, event: TaskTerminalEventArgs): Promise<void> {
    assert(scopeKey.length > 0, "postTaskTerminalEvent requires a scopeKey");
    assert(event.taskId.length > 0, "postTaskTerminalEvent requires a taskId");
    const mount = this.persistentMounts.get(scopeKey);
    if (!mount || mount.isDisposed || !mount.grants.hostEvents) return;

    const size = Buffer.byteLength(event.reportMarkdown, "utf8");
    if (size <= RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES) {
      mount.postHostEvent({
        type: TASK_TERMINAL_EVENT_TYPE,
        taskId: event.taskId,
        status: event.status,
        reportMarkdown: event.reportMarkdown,
      });
      return;
    }
    await this.offloadTaskTerminalEvent(scopeKey, event, size);
  }

  /** Oversized-report path: store the full report at an r4 vars handle and
   * post a {handle, preview, size} event instead of the full text. */
  private async offloadTaskTerminalEvent(
    scopeKey: string,
    event: TaskTerminalEventArgs,
    size: number
  ): Promise<void> {
    const preview = buildHandlePreview(event.reportMarkdown, size);
    const base = { type: TASK_TERMINAL_EVENT_TYPE, taskId: event.taskId, status: event.status };
    // Event VISIBILITY must never queue behind the scope lease (r70): a
    // guest eval polling xum.events() holds the scope lock for its entire
    // run, so awaiting the lock here would make this completion
    // unobservable until that eval ends — the guest could poll to its
    // sandbox timeout for a child that already finished. If the scope is
    // leased, deliver the bounded preview immediately (postHostEvent is a
    // plain queue push, safe without the lock, exactly like the
    // sub-threshold path) and skip the handle upgrade; the preview marks
    // itself truncated and the full report still arrives via the durable
    // top-level task wake. The handle path below runs only when the lock is
    // free at this instant (tryAcquire is synchronous), preserving the
    // single-event-per-task contract.
    const guard = this.lockFor(scopeKey).tryAcquire();
    if (guard === null) {
      const mount = this.persistentMounts.get(scopeKey);
      if (!mount || mount.isDisposed || !mount.grants.hostEvents) return;
      mount.postHostEvent({ ...base, reportMarkdown: preview });
      return;
    }
    await using _guard = guard;
    // Re-resolve under the lock: the mount may have been rebuilt or disposed
    // since the caller's check (grant change, archive). Vars survive rebuilds
    // via snapshot/restore, so posting to the CURRENT mount stays correct.
    const mount = this.persistentMounts.get(scopeKey);
    if (!mount || mount.isDisposed || !mount.grants.hostEvents) return;
    if (!mount.grants.vars) {
      // No vars grant => nowhere to store the full report; deliver the
      // bounded preview only (the preview text marks itself as truncated).
      mount.postHostEvent({ ...base, reportMarkdown: preview });
      return;
    }
    try {
      const serialized = JSON.stringify(event.reportMarkdown);
      const key = await mount.storeResultHandle(serialized, RESULT_HANDLE_VARS_CAP_BYTES);
      const handle = `vars.${key}`;
      try {
        // The handle mutated vars outside an eval: persist so vars.__handleSeq
        // stays monotonic on disk (a stale snapshot could reuse a handle
        // number an earlier result-handle event already references).
        await mount.persistVars();
      } catch (error) {
        // Same contract as the post-eval path: memory and disk must agree, so
        // dispose and let the next acquire restore the last durable snapshot.
        // The event is dropped with the runtime (best-effort queue), so the
        // handle row/blob must NOT have been published yet (r28): a durable
        // event claiming a handle the guest never learned about would corrupt
        // provenance — publication happens below, after this commit.
        log.warn(
          "SandboxHostService: vars snapshot after task-terminal offload failed; disposing mount",
          { scopeKey, error }
        );
        mount.dispose();
        return;
      }
      try {
        await mount.persistResultHandle({ handle, preview, serialized });
      } catch (error) {
        // Journaling failure only degrades durability of the FULL report; the
        // guest handle and event still work (self-healing doctrine).
        log.warn("SandboxHostService: task-terminal handle journaling failed; continuing", {
          scopeKey,
          error,
        });
      }
      mount.postHostEvent({ ...base, reportHandle: { handle, preview, size } });
    } catch (error) {
      // Handle storage failed (e.g. guest memory limit): fall back to the
      // bounded preview so the guest still learns of the completion.
      log.warn("SandboxHostService: task-terminal offload failed; posting bounded preview", {
        scopeKey,
        error,
      });
      if (!mount.isDisposed) {
        mount.postHostEvent({ ...base, reportMarkdown: preview });
      }
    }
  }

  /**
   * Dispose a scope's persistent mount (workspace archive/reset). Snapshots
   * best-effort first so state survives un-archive and restarts.
   */
  async disposeScope(scopeKey: string): Promise<void> {
    // The scope lock also backs mount.exclusive(), so disposal waits for any
    // in-flight evaluation instead of pulling the runtime out from under it.
    await using _guard = await this.lockFor(scopeKey).acquire();
    await this.disposeScopeLocked(scopeKey);
  }

  /** Dispose logic without taking the scope lock: caller must hold it. */
  private async disposeScopeLocked(scopeKey: string): Promise<void> {
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    if (!mount || mount.isDisposed) return;
    if (mount.grants.vars) {
      try {
        await mount.persistVars();
      } catch (error) {
        // Never let a snapshot failure block archive/reset.
        log.warn(`SandboxHostService: vars snapshot failed for scope ${scopeKey}`, { error });
      }
    }
    mount.dispose();
  }

  /**
   * Drop a scope entirely (workspace removal): dispose the runtime and forget
   * journals WITHOUT any disk writes. The caller is deleting the session
   * directory — a snapshot here would recreate it, and an in-flight exclusive
   * run must finish first (the lock serializes) so it cannot persist into the
   * deleted directory afterwards.
   */
  async dropScope(scopeKey: string): Promise<void> {
    await using _guard = await this.lockFor(scopeKey).acquire();
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    // The caller is deleting the session dir: there is no snapshot left to
    // invalidate, so a pending reset tombstone becomes moot.
    this.pendingDiscards.delete(scopeKey);
    // The scope lock stays in the map (see scopeLocks doc): deleting it while
    // waiters hold references could let two locks govern the same scope.
    if (mount && !mount.isDisposed) {
      mount.dispose();
    }
  }

  /**
   * Discard a scope's sandbox state (context reset): dispose the mount
   * WITHOUT snapshotting current vars, and supersede any earlier snapshot
   * with an empty one so the next mount starts fresh instead of restoring
   * pre-reset state. Rotation-by-append keeps the journal append-only.
   *
   * Throws when the tombstone cannot be made durable — the reset is only
   * durably invalidated once the empty snapshot lands (a swallowed failure
   * would let the next acquisition resurrect cleared, potentially sensitive
   * values). The scope stays reset-pending (see pendingDiscards) and refuses
   * to mount until an acquisition-time retry succeeds.
   */
  async discardScope(scopeKey: string, sessionDir: string): Promise<void> {
    await using _guard = await this.lockFor(scopeKey).acquire();
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    const journal = this.journalFor(sessionDir);
    if (mount && !mount.isDisposed) {
      mount.dispose();
    }
    // Pending until the tombstone provably lands; cleared inside the helper.
    this.pendingDiscards.add(scopeKey);
    await this.publishDiscardTombstone(journal, scopeKey);
  }

  /**
   * Publish the reset tombstone: an EMPTY vars snapshot superseding any
   * earlier one, so restoration and replay reconstruction agree the scope
   * was cleared. Clears the scope's reset-pending flag only after the row is
   * durable. Caller must hold the scope lock.
   */
  private async publishDiscardTombstone(
    journal: DurableEventJournal,
    scopeKey: string
  ): Promise<void> {
    // Published UNCONDITIONALLY — even on an empty journal (r57, widened
    // twice: r52 dropped the has-snapshot guard, r57 dropped the empty-
    // journal skip). A foreign backend's live mount can hold unpersisted
    // pre-reset vars while this scope's journal is still empty (the scope's
    // very first kernel call racing a reset in another instance); skipping
    // here recorded no generation bump, so that mount's persist precondition
    // still saw generation zero and could publish the discarded vars after
    // the reset. The cost — creating a small journal for a workspace that
    // never used the sandbox — is bounded and one-time per reset.
    //
    // `reset: true` marks this row as a generation bump (r52): foreign
    // mounts recount reset rows before every lease and persist.
    const { ref } = await journal.publishWithBlob("{}", (blobHash, size) => ({
      workspaceId: scopeKey,
      kind: "sandbox-vars-snapshot",
      data: { scopeKey, blobHash, size, reset: true },
    }));
    this.pendingDiscards.delete(scopeKey);
    try {
      // The pre-reset snapshot is superseded like any other: reclaim it now
      // so the per-journal latest-ref state stays true to the journal.
      // Best-effort — a reclamation failure only delays disk cleanup and
      // must not fail a reset whose invalidation IS durable.
      await reclaimSupersededSnapshotBlobs(journal, scopeKey, ref);
    } catch (error) {
      log.debug(`SandboxHostService: post-reset snapshot reclamation failed for ${scopeKey}`, {
        error,
      });
    }
  }

  /** True when a live persistent mount exists for the scope. */
  hasScope(scopeKey: string): boolean {
    const mount = this.persistentMounts.get(scopeKey);
    return mount !== undefined && !mount.isDisposed;
  }

  disposeAll(): void {
    for (const mount of this.persistentMounts.values()) {
      mount.dispose();
    }
    this.persistentMounts.clear();
  }

  private journalFor(sessionDir: string): DurableEventJournal {
    // Process-shared per session dir: aiService's turn-envelope writer appends
    // to the same file, and independent seq caches would corrupt ordering.
    return sharedDurableEventJournal(sessionDir);
  }

  /** Set up `vars` and restore the latest snapshot if one exists (self-heal:
   * a missing/corrupt snapshot starts empty instead of failing the mount).
   * `events` is the caller's journal read (shared with the reset-generation
   * capture so both observe the same journal state). */
  private async initializeVars(
    mount: SandboxMount,
    journal: DurableEventJournal,
    scopeKey: string,
    events: DurableEvent[]
  ): Promise<void> {
    const init = await mount.runtime.eval("globalThis.vars = {}; return true;");
    assert(init.success, `vars init failed: ${init.error ?? "unknown error"}`);

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.kind !== "sandbox-vars-snapshot" || event.data.scopeKey !== scopeKey) {
        continue;
      }
      const varsJson = await journal.blobs.getText(event.data.blobHash);
      if (varsJson === null) {
        log.warn(
          `SandboxHostService: latest vars snapshot blob missing/corrupt for ${scopeKey}; starting empty`
        );
        return;
      }
      try {
        await mount.restoreVars(varsJson);
      } catch (error) {
        log.warn(`SandboxHostService: vars restore failed for ${scopeKey}; starting empty`, {
          error,
        });
      }
      return;
    }
  }
}

/**
 * A scope's journal reset generation (r52): the count of reset-marked
 * snapshot rows. Pre-r52 tombstones carry no marker and count as zero —
 * safe, because a generation only needs to CHANGE when a reset lands while
 * a mount is alive, and every reset since the marker shipped bumps it.
 */
function countScopeResets(events: DurableEvent[], scopeKey: string): number {
  let count = 0;
  for (const event of events) {
    if (
      event.kind === "sandbox-vars-snapshot" &&
      event.data.scopeKey === scopeKey &&
      event.data.reset === true
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Journal seq of the newest vars-snapshot row for a scope (reset tombstones
 * included — they are snapshot rows too), or null for a never-persisted
 * scope (r67). Together with the reset generation this identifies exactly
 * which durable state a live mount's namespace descends from, so a foreign
 * backend's ordinary persist is as visible as its resets.
 */
function latestScopeSnapshotSeq(events: DurableEvent[], scopeKey: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "sandbox-vars-snapshot" && event.data.scopeKey === scopeKey) {
      return event.seq;
    }
  }
  return null;
}

/**
 * Process-wide host singleton (mirrors eventSpine). Production consumers:
 * code_execution persistent mounts (opt-in) and workspace archive/reset
 * disposal. Tests construct their own instances.
 */
export const sandboxHostService = new SandboxHostService();
