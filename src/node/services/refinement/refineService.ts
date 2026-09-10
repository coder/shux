import * as path from "path";
/**
 * /refine orchestration (RLM track, phase r11): user-invokable trajectory
 * distillation with a paper trail.
 *
 * Owns everything around the runner (refineRunner.ts): RLM experiment gating
 * (backend refuses when off), one-run-at-a-time-per-workspace locking
 * (concurrent invocations are REJECTED, not queued — an explicit /refine has
 * nothing to gain from running twice over the same trajectory), trajectory
 * assembly (recent chat.jsonl + timeline events when the Timeline experiment
 * is on), model resolution, journal-row correlation, and the completion chat
 * message.
 *
 * v1 tradeoff (intentional, no proposal/approval UI): edits are auto-applied
 * and the summary row points at the r6 rollback paths ("bun run debug
 * refinements" / the refinement_rollback tool). Approval UX would double the
 * surface of an experimental feature whose every edit is already journaled
 * with a byte-exact inverse — cheap rollback is the safety mechanism.
 *
 * Failure posture: best-effort everywhere below the run result. Summary-row
 * append or emission failures log and continue (self-healing doctrine); a
 * stream failure returns an error so the user knows the pass did not finish.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import type { LanguageModel, Tool } from "ai";

import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { RefineAppliedEditPayload, RefineRecordPayload } from "@/common/orpc/schemas/api";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  MemoryRefinementActionSchema,
  RefinementEvidenceSchema,
  SkillRefinementActionSchema,
} from "@/common/types/refinement";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
  REFINE_MAX_MESSAGES,
  REFINE_OP_BUDGET,
  REFINE_SUMMARY_LABEL,
  REFINE_TIMELINE_EVENT_LIMIT,
  REFINE_TIMEOUT_MS,
} from "@/constants/refine";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  buildAbandonedBranchTranscript,
  isRlmModeEnabled,
  type RlmExperimentFlags,
} from "@/node/services/branchSummary";
import {
  findLatestContextBoundaryIndex,
  isDurableContextResetBoundaryMarker,
  sliceMessagesForProviderFromLatestContextBoundary,
} from "@/common/utils/messages/compactionBoundary";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import {
  isWorkspaceRemovalTombstoned,
  refineApplyLockPath,
} from "@/node/services/workspaceRemoval";
import type { HistoryService } from "@/node/services/historyService";
import { runLanguageModelCleanup } from "@/node/services/languageModelCleanup";
import { trackPendingUsageWrite } from "@/node/services/branchSummary";
import { log } from "@/node/services/log";
import {
  createConsolidationMemoryTool,
  createMutationBudget,
} from "@/node/services/memoryConsolidation";
import {
  resolveConsolidationProjectPath,
  resolveDreamModelString,
} from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import {
  listRefinements,
  type RefinementEvent,
} from "@/node/services/refinement/refinementRollback";
import {
  clearStagedRefineSet,
  hashStagedRefineSet,
  loadStagedRefineSet,
  saveStagedRefineSet,
  type StagedRefineEdit,
} from "@/node/services/refinement/refineStaging";
import { runRefinePass } from "@/node/services/refinement/refineRunner";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { TimelineService } from "@/node/services/timelineService";
import * as fsPromises from "node:fs/promises";
import {
  createAgentSkillWriteTool,
  createStagedAgentSkillWriteTool,
  hashSkillWriteTargetContent,
  resolveProjectSkillWriteTargetPath,
} from "@/node/services/tools/agent_skill_write";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { createRefineSummaryMessageId } from "@/node/services/utils/messageIds";

// Types derive from the oRPC schemas (z.infer single source) so node-side
// fields can never silently be stripped by output validation.
export type RefineAppliedEdit = RefineAppliedEditPayload;
export type RefineRecord = RefineRecordPayload;

interface ExperimentsCheck {
  isExperimentEnabled(experimentId: ExperimentId): boolean;
}

/**
 * Structural AIService subset (model creation + runtime metadata), mirroring
 * the dream service's ModelFactoryLike so tests can pass lightweight fakes.
 */
export interface RefineAiService {
  createModelWithPinnedMetadata(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, { type: string }>>;
  getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>>;
}

interface RefineServiceOptions {
  timelineService?: Pick<TimelineService, "list">;
  /** Narrowed to the one member used so tests can pass lightweight fakes. */
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  /** Live-session emission hook so the appended summary row renders immediately. */
  emitChatMessage?: (workspaceId: string, message: MuxMessage) => void;
  /**
   * Serialize refine row publication (and apply mutations) with the
   * workspace's turn lifecycle (r40): returns a disposable holding the
   * session's turn-admission block, or Err when a turn is already
   * active/preparing. Without it, a fire-and-forget /refine settling during
   * a concurrent turn could append its synthetic assistant row inside that
   * turn's PREPARING window (entering the in-flight request snapshot) or
   * between the turn's user row and its response. Absent in lightweight
   * test fakes — appends then run unserialized, as before.
   */
  acquireTurnExclusion?: (workspaceId: string) => Result<Disposable, string>;
  /** Test seam: overrides REFINE_TIMEOUT_MS as the pass deadline. */
  timeoutMs?: number;
  /** Test seam: overrides the cross-process apply-lock acquisition timeout. */
  applyLockTimeoutMs?: number;
  /**
   * Test seam: invoked after each staged edit's apply-progress journal write
   * settles. Crash-recovery tests throw from here to simulate process death
   * between edits (the mutation + its journal entry are durable; nothing
   * after runs).
   */
  onStagedEditAttempted?: (toolCallId: string) => void;
}

/**
 * Content fingerprint of one history row for the pre-publication prefix
 * recheck (r47). Serialized-bytes hash: both the snapshot and the recheck
 * parse rows from the same JSONL, so unchanged on-disk rows stringify
 * identically, while ANY in-place rewrite (StreamManager finalizing a
 * mid-flight row via updateHistory, edit-resends) changes the hash even
 * though the row ID and historySequence are preserved. A semantically-equal
 * rewrite with different key order fails closed (re-run /refine).
 */
function fingerprintHistoryRow(row: MuxMessage | undefined): string {
  if (row === undefined) return "<missing>";
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

/**
 * Virtual path of a staged memory edit that needs a target fingerprint —
 * deletes (r55: no command-level conflict semantics) and inserts (r58: a
 * numeric line position silently lands in the wrong place on contents edited
 * after staging) — or undefined for any other (or malformed) memory command.
 * Staged inputs are untrusted on-disk state, so fields are read defensively
 * rather than schema-cast (r55).
 */
function stagedMemoryGuardedTargetPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { command, path: virtualPath } = input as { command?: unknown; path?: unknown };
  if ((command !== "delete" && command !== "insert") || typeof virtualPath !== "string") {
    return undefined;
  }
  return virtualPath;
}

/** Human-readable action line for a refinement journal row. */
export function describeRefinementRow(row: RefinementEvent): string {
  if (row.data.kind === "memory") {
    const action = MemoryRefinementActionSchema.safeParse(row.data.action);
    if (action.success) {
      const rename = action.data.newPath !== undefined ? ` -> ${action.data.newPath}` : "";
      return `memory ${action.data.op} ${action.data.path}${rename}`;
    }
  }
  if (row.data.kind === "skill") {
    const action = SkillRefinementActionSchema.safeParse(row.data.action);
    if (action.success) {
      const file = action.data.filePath !== undefined ? `/${action.data.filePath}` : "";
      return `skill ${action.data.op} ${action.data.skillName}${file}`;
    }
  }
  return `${row.data.kind} edit`;
}

/**
 * Build the durable, clearly-labeled summary row for a refine pass. "staged"
 * mode announces the proposal — rendering the EXACT staged payloads so
 * approval is informed — and how to approve it; "applied" mode reports the
 * executed edits with their rollback addresses.
 */
export function createRefineSummaryMessage(
  record: RefineRecord,
  mode:
    | { mode: "applied" }
    | {
        mode: "staged";
        /** The exact staged edits; their full inputs are rendered below. */
        edits: StagedRefineEdit[];
        /** Canonical hash binding /refine apply to the rendered bytes. */
        stagedSetHash: string;
      }
): MuxMessage {
  const lines = [REFINE_SUMMARY_LABEL, ""];
  if (mode.mode === "staged") {
    // SECURITY: render the exact staged inputs (full file_text / skill
    // content), never just the model's one-line descriptions — a
    // prompt-injected refine model could otherwise present a benign
    // rationale while apply persists different content. Sizes are bounded
    // by the per-run mutation budget and the tools' own input caps, so full
    // rendering stays feasible; approval is bound to these bytes via
    // stagedSetHash.
    for (const [index, edit] of mode.edits.entries()) {
      const payload = JSON.stringify(edit.input, null, 2);
      // SECURITY: a backtick run in the payload could close a fixed ```
      // fence early (lenient renderers accept closers JSON quoting would not
      // stop), letting a prompt-influenced payload render part of itself as
      // Markdown — counterfeit headings or "nothing applied" prose — outside
      // the code block that the explicit-review boundary depends on. Use a
      // fence strictly longer than the longest backtick run anywhere in the
      // payload so it can never terminate early.
      const longestBacktickRun = (payload.match(/`+/gu) ?? []).reduce(
        (max, run) => Math.max(max, run.length),
        0
      );
      const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
      lines.push(
        `- [staged ${index + 1}/${mode.edits.length}] ${edit.description}`,
        "",
        `${fence}json`,
        payload,
        fence,
        ""
      );
    }
  } else {
    lines.push(
      ...record.applied.map((edit) => `- ${edit.description} (refinement ${edit.refinementId})`)
    );
    if (record.untrackedApplied !== undefined && record.untrackedApplied > 0) {
      // Real edits with no journal row: the user must learn about them even
      // though the r6 rollback path cannot address them.
      lines.push(
        `- ${record.untrackedApplied} applied edit(s) could not be journaled; rollback is unavailable for them.`
      );
    }
    if (record.failed !== undefined && record.failed.length > 0) {
      // Approved edits that failed to apply: the audit row must say so — a
      // no-op-shaped summary would silently drop approved work.
      lines.push(...record.failed.map((edit) => `- FAILED: ${edit.description} — ${edit.reason}`));
    }
  }
  if (record.summary.length > 0) {
    lines.push("", record.summary);
  }
  if (mode.mode === "staged") {
    // SECURITY: nothing has been written yet — the approval affordance is
    // this instruction (see refineStaging.ts for the rationale).
    lines.push(
      "",
      "Nothing has been applied yet. Apply with /refine apply, or run /refine again to replace the proposal."
    );
  } else if (record.applied.length > 0) {
    // The rollback pointer only applies to journaled rows.
    lines.push(
      "",
      // Only real affordances: the debug CLI and the refinement_rollback
      // tool ("/debug refinements" is not a registered slash command).
      "Rollback with: bun run debug refinements <workspace-id> --rollback <id>, or the refinement_rollback tool."
    );
  }
  // SECURITY: assistant role, never user. The summary embeds the refine
  // model's verbatim closing output over an attacker-influenceable
  // trajectory; a user row would grant prompt-injected text user-priority
  // trust in every later tool-capable request (and startup auto-retry can
  // resume it after a restart). As an assistant row the provider reads it as
  // prior generated context — same posture as branch summaries and
  // compaction summary rows; transformModelMessages merges consecutive
  // text-only assistant rows for Anthropic's alternation constraint.
  return createMuxMessage(createRefineSummaryMessageId(), "assistant", lines.join("\n"), {
    timestamp: Date.now(),
    // Synthetic system-style row: provider-visible durable history (never
    // request-time injection), uiVisible so users see what was self-applied.
    synthetic: true,
    uiVisible: true,
    muxMetadata: {
      type: "refine-summary",
      ...(mode.mode === "staged" ? { stagedSetHash: mode.stagedSetHash } : {}),
    },
  });
}

interface InFlightRefinePass {
  promise: Promise<Result<RefineRecord, string>>;
  /** Invalidates the running pass (see cancelInFlightRefinePass). */
  controller: AbortController;
}

export class RefineService {
  /**
   * Per-workspace run lock. Reserved SYNCHRONOUSLY in run() before any await
   * so two near-simultaneous invocations can never both start; the loser is
   * rejected outright (see module doc). Entries carry a cancellation handle
   * so workspace removal can abort and drain a running pass before deleting
   * the session directory (same posture as pendingBranchSummaries).
   */
  private readonly inFlight = new Map<string, InFlightRefinePass>();

  constructor(
    private readonly config: Config,
    private readonly memoryService: MemoryService,
    private readonly metaService: MemoryMetaService,
    private readonly historyService: HistoryService,
    private readonly aiService: RefineAiService,
    private readonly experiments: ExperimentsCheck,
    private readonly options: RefineServiceOptions = {}
  ) {}

  private enabled(experiments?: RlmExperimentFlags): boolean {
    // RLM is a sub-experiment of Programmatic Tool Calling; both machine
    // overrides must be on. Explicit renderer flags ride the request with the
    // same authority as send options.experiments (r32): persisting overrides
    // to the backend is asynchronous/best-effort, so a backend-only predicate
    // could refuse /refine while the same workspace is already running with
    // the RLM kernel the renderer sees.
    return isRlmModeEnabled(experiments, (id) => this.experiments.isExperimentEnabled(id));
  }

  async run(
    workspaceId: string,
    experiments?: RlmExperimentFlags
  ): Promise<Result<RefineRecord, string>> {
    if (!this.enabled(experiments)) {
      return Err("rlm-mode experiment is disabled (enable Programmatic Tool Calling + RLM Mode)");
    }
    if (this.inFlight.has(workspaceId)) {
      return Err("a refine pass is already running for this workspace");
    }
    // runLocked executes synchronously up to its first await, so the map is
    // populated before any other caller can observe it.
    const controller = new AbortController();
    const run = this.runLocked(workspaceId, controller.signal);
    const entry: InFlightRefinePass = { promise: run, controller };
    this.inFlight.set(workspaceId, entry);
    try {
      return await run;
    } finally {
      // Identity-guarded: a cancel + immediate re-run must not sweep the
      // newer registration.
      if (this.inFlight.get(workspaceId) === entry) {
        this.inFlight.delete(workspaceId);
      }
    }
  }

  /**
   * Abort and drain any running /refine pass for a removed workspace. Removal
   * MUST await this before deleting the session directory: the abort stops
   * the pass's stream (ending tool-driven memory/skill writes) and gates the
   * summary-row append, and awaiting the settle serializes removal behind
   * writes already in flight — otherwise a late write could recreate session
   * state for a workspace that no longer exists. Never rejects.
   */
  async cancelInFlightRefinePass(workspaceId: string): Promise<void> {
    const entry = this.inFlight.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.controller.abort();
    // runLocked can throw on unexpected failures; removal must proceed anyway.
    await entry.promise.catch(() => undefined);
  }

  /**
   * Apply the staged edits from the last /refine run. This is the explicit
   * approval step of the staging contract (see refineStaging.ts): the staged
   * inputs replay through the SAME journaled tool paths a live agent uses —
   * the consolidation memory tool (scope guard + pin protection re-checked)
   * and the standard agent_skill_write tool (containment re-checked) — so
   * every applied edit lands as an invertible r2 refinement row and r6
   * rollback keeps working. Shares the per-workspace lock with run().
   */
  async apply(
    workspaceId: string,
    /**
     * Hash of the newest staged proposal the CALLER'S renderer displayed
     * (r64). Required: the shared transcript alone cannot prove what this
     * user saw — with XUM_ALLOW_MULTIPLE_INSTANCES=1 a foreign backend's
     * /refine can replace refine-staged.json and append a newer proposal row
     * that only its own renderer displayed, so binding approval to the
     * newest transcript row would apply edits this user never audited.
     */
    approvedProposalHash: string,
    experiments?: RlmExperimentFlags
  ): Promise<Result<RefineRecord, string>> {
    if (!this.enabled(experiments)) {
      return Err("rlm-mode experiment is disabled (enable Programmatic Tool Calling + RLM Mode)");
    }
    if (this.inFlight.has(workspaceId)) {
      return Err("a refine pass is already running for this workspace");
    }
    const controller = new AbortController();
    const run = this.applyLocked(workspaceId, controller.signal, approvedProposalHash);
    const entry: InFlightRefinePass = { promise: run, controller };
    this.inFlight.set(workspaceId, entry);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(workspaceId) === entry) {
        this.inFlight.delete(workspaceId);
      }
    }
  }

  private async applyLocked(
    workspaceId: string,
    cancellationSignal: AbortSignal,
    approvedProposalHash: string
  ): Promise<Result<RefineRecord, string>> {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);
    const sessionDir = path.join(this.config.sessionsDir, workspaceId);
    // r32: the in-process inFlight map cannot see a second backend over the
    // same root (XUM_ALLOW_MULTIPLE_INSTANCES=1). Hold a cross-process lock
    // across staged-state load, recovery, execution, and progress persistence
    // — per-target mutation locks only serialize the individual writes, so
    // two processes could both capture an empty attempted set and double-
    // apply a non-idempotent edit. Short acquisition timeout: a held lock
    // means another apply is running, mirror the in-process rejection.
    let applyLock: Awaited<ReturnType<typeof acquireProcessFileLock>>;
    try {
      applyLock = await acquireProcessFileLock({
        // r66: session-dir-external (see refineApplyLockPath) — removal holds
        // this same lock across its tombstone+delete critical section, so an
        // in-flight apply completes before the deletion and a late one
        // refuses on the tombstone gate below instead of recreating the
        // directory through its progress writes.
        lockPath: refineApplyLockPath(this.config.rootDir, workspaceId),
        timeoutMs: this.options.applyLockTimeoutMs ?? REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
        label: "refine apply lock",
      });
    } catch (error) {
      return Err(
        `a refine apply appears to be running in another process: ${getErrorMessage(error)}`
      );
    }
    await using _applyLock = applyLock;
    // Removal gate (r66), checked IN-LOCK: a removal that completed while we
    // waited (or before we started) left a durable tombstone; applying now
    // would journal edits and rewrite staged progress into a recreated
    // session directory.
    if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
      return Err(`workspace ${workspaceId} was removed; refusing to apply staged refine edits`);
    }
    const staged = await loadStagedRefineSet(sessionDir);
    if (staged === null) {
      return Err("no staged refine edits (run /refine first)");
    }

    // SECURITY: bind approval to the rendered bytes. The staged proposal row
    // displayed the exact edit payloads and recorded their canonical hash;
    // apply refuses unless refine-staged.json still hashes to the NEWEST
    // proposal the user could have audited in chat. This catches a tampered
    // staged file and a file/row desync — approving unseen content is never
    // possible. Fail closed when no hashed proposal row is found (e.g.
    // pre-hash proposals from an older binary): rerun /refine to restage.
    const approvedHash = await this.findNewestStagedProposalHash(workspaceId);
    if (approvedHash === null) {
      return Err(
        "no staged refine proposal found in chat to verify against; run /refine again to restage"
      );
    }
    const actualHash = hashStagedRefineSet(staged.edits);
    if (actualHash !== approvedHash) {
      return Err(
        "staged refine edits no longer match the proposal shown in chat (the staged file changed after it was displayed); run /refine again and re-approve"
      );
    }
    // r64: additionally bind approval to the proposal THIS caller rendered.
    // The transcript check above binds to the NEWEST row in the SHARED
    // chat.jsonl — but with XUM_ALLOW_MULTIPLE_INSTANCES=1 a foreign
    // backend's /refine (serialized before this apply, or after this
    // renderer last refreshed) can replace refine-staged.json and append a
    // newer proposal row emitted only to ITS OWN renderer; both checks above
    // then pass against bytes this approving user never saw. The renderer
    // sends the hash of the newest proposal it actually displayed, and apply
    // refuses on mismatch.
    if (approvedProposalHash !== actualHash) {
      return Err(
        "the staged refine proposal is not the one displayed in this window (another window restaged after this chat was rendered); review the newest /refine proposal or run /refine again, then re-approve"
      );
    }

    // Baseline BEFORE applying: rows appended by this apply have seq >
    // baseline. Correlation additionally requires the row's
    // evidence.toolCallId to be one of the staged tool calls, so concurrent
    // main-agent self-edits in the same journal can never be misattributed.
    // A crash-resumed apply reuses the ORIGINAL run's persisted baseline so
    // the audit row also covers edits applied before the crash.
    const baselineSeq = staged.applyBaselineSeq ?? (await this.readMaxJournalSeq(sessionDir));

    const projectPath = resolveConsolidationProjectPath(workspace);
    const ctx: MemoryScopeContext = {
      runtime: null,
      checkoutCwd: "",
      workspaceId,
      projectPath,
    };
    // Staging-time fingerprints of memory delete/insert targets (r55/r58),
    // re-verified by MemoryService INSIDE its target mutation lock
    // immediately before the write — a target edited between staging and
    // apply must refuse instead of destroying or misplacing content (same
    // posture as the skill-write hashes below).
    const stagedMemoryTargetFingerprints = new Map<string, string>();
    for (const edit of staged.edits) {
      if (
        edit.tool === "memory" &&
        edit.targetContentHash !== undefined &&
        stagedMemoryGuardedTargetPath(edit.input) !== undefined
      ) {
        stagedMemoryTargetFingerprints.set(edit.toolCallId, edit.targetContentHash);
      }
    }
    const { tool: memoryTool } = createConsolidationMemoryTool({
      memoryService: this.memoryService,
      metaService: this.metaService,
      ctx,
      dryRun: false,
      journal: [],
      budget: createMutationBudget(REFINE_OP_BUDGET),
      expectedTargetFingerprints: stagedMemoryTargetFingerprints,
    });
    // r50: hand the staged target fingerprints to the writer so it re-verifies
    // them INSIDE its per-root mutation lock immediately before writing — the
    // apply loop's pre-check below is unlocked and cannot exclude a writer
    // landing between the check and the tool's lock acquisition.
    const stagedSkillTargetHashes = new Map<string, string>();
    for (const edit of staged.edits) {
      if (edit.tool === "agent_skill_write" && edit.targetContentHash !== undefined) {
        stagedSkillTargetHashes.set(edit.toolCallId, edit.targetContentHash);
      }
    }
    const skillWriteTool = await this.buildSkillWriteTool(
      workspaceId,
      sessionDir,
      stagedSkillTargetHashes
    );

    // Cancellation is honored ONLY before the first mutation. Once admitted,
    // the apply runs to completion: aborting between edits left a partially
    // applied global/project mutation while removal deleted the session
    // journal holding its rollback IDs — surviving with no audit or rollback
    // path. Applies are local journaled file mutations with no model calls,
    // so removal (which awaits this promise via cancelInFlightRefinePass
    // before deleting the session directory) waits out the full run instead;
    // the audit row below is persisted before session teardown.
    if (cancellationSignal.aborted) {
      return Err("refine apply cancelled (workspace removed)");
    }

    // r40: block turn admission for the rest of the apply — mutations plus
    // the audit-row append — failing closed BEFORE the first mutation when a
    // turn is already active. Without this, a concurrent turn's PREPARING
    // snapshot could ingest the audit row (or the row could split the turn's
    // user/assistant pair), and prompt/memory/skill mutations would land
    // mid-request.
    const turnExclusionResult = this.acquireTurnExclusionIfWired(workspaceId);
    if (!turnExclusionResult.success) {
      return Err(
        `a turn is active in this workspace (${turnExclusionResult.error}); refinements cannot ` +
          `be applied into a running conversation — run /refine apply again once the workspace ` +
          `is idle (nothing was applied)`
      );
    }
    using _turnExclusion = turnExclusionResult.data;

    // CRASH SAFETY (consume-before-mutate): transition the staged file into
    // its applying state — persisted baseline + attempted list — BEFORE the
    // first mutation, and mark each edit attempted (atomic rewrite) right
    // after its execution settles. A crash mid-apply then cannot replay
    // non-idempotent edits on the next /refine apply: recovery skips
    // attempted IDs and resumes the remainder, and a fully-attempted set
    // applies nothing new while still producing the correct audit row (via
    // the persisted baseline) instead of replaying everything.
    const attempted = new Set(staged.attemptedToolCallIds ?? []);
    if (staged.applyBaselineSeq === undefined) {
      await saveStagedRefineSet(sessionDir, {
        ...staged,
        applyBaselineSeq: baselineSeq,
        attemptedToolCallIds: [...attempted],
      });
    } else {
      // CRASH RECOVERY (journal-first): the attempted-progress rewrite lands
      // only AFTER a tool execution settles, so a crash in that window leaves
      // a completed edit missing from attemptedToolCallIds while its
      // refinement journal row (appended by the tool itself) survives. Union
      // journaled IDs past the persisted baseline into the attempted set
      // before invoking any tool again — replaying a non-idempotent memory
      // insert would duplicate it. The residual window (mutation done,
      // journal append failed) is accepted: journal appends are best-effort
      // by design, so such an edit can still replay once.
      const journaled = await this.listStagedRefinementRows(
        sessionDir,
        workspaceId,
        baselineSeq,
        staged.edits.map((edit) => edit.toolCallId)
      );
      for (const { toolCallId } of journaled) attempted.add(toolCallId);
    }

    // Success outcomes are PERSISTED per edit (succeededToolCallIds), not
    // just counted: a crash-resumed apply skips attempted edits, so a prior
    // unjournaled success would otherwise be unreconstructable and the
    // resume would misreport a real mutation as a no-op (see the schema doc).
    const succeededIds = new Set(staged.succeededToolCallIds ?? []);
    // Failed EXECUTED outcomes are PERSISTED per edit (failedToolCalls), like
    // successes: a crash-resumed apply skips the attempted edit, so without
    // the persisted reason the failure of an approved edit would vanish from
    // the rebuilt record and the resume would misreport a no-op, clearing the
    // staged set with no audit row (see the schema doc).
    const failedOutcomes = new Map<string, string>(
      (staged.failedToolCalls ?? []).map((outcome) => [outcome.toolCallId, outcome.reason])
    );
    // Never-executed skips (tool unavailable / schema-rejected input) have no
    // side effects, so they stay OUT of the attempted set and the staged set
    // is retained below: a later /refine apply may retry them safely once the
    // cause is fixed. Executed edits are marked attempted and never replay.
    // Re-examined fresh each pass, hence in-pass only (never persisted).
    const skipFailures = new Map<string, string>();
    // r49: staged skill-write target verification needs the same confined
    // project root the tool writes under. Resolved once; per-edit hashes are
    // recomputed inside the loop right before execution.
    const skillTargetProjectRoot = staged.edits.some(
      (edit) => edit.tool === "agent_skill_write" && edit.targetContentHash !== undefined
    )
      ? await this.resolveSkillWriteProjectRoot(workspaceId)
      : undefined;
    for (const edit of staged.edits) {
      // Applied (or at least attempted) before a crash: never replay.
      if (attempted.has(edit.toolCallId)) continue;
      const tool = edit.tool === "memory" ? memoryTool : skillWriteTool;
      if (tool === undefined || typeof tool.execute !== "function") {
        log.warn("[Refine] staged edit skipped: tool unavailable at apply time", {
          workspaceId,
          tool: edit.tool,
        });
        skipFailures.set(edit.toolCallId, "tool unavailable at apply time");
        continue;
      }
      // The staged file is on-disk state: validate the input against the
      // tool's own schema before executing (defense against tampering and
      // schema drift across upgrades).
      const schema =
        edit.tool === "memory"
          ? TOOL_DEFINITIONS.memory.schema
          : TOOL_DEFINITIONS.agent_skill_write.schema;
      const parsedInput = schema.safeParse(edit.input);
      if (!parsedInput.success) {
        log.warn("[Refine] staged edit skipped: input failed schema validation", {
          workspaceId,
          tool: edit.tool,
          error: parsedInput.error.message,
        });
        skipFailures.set(
          edit.toolCallId,
          // Zod messages can run long; the audit row needs the gist only.
          `input failed schema validation: ${parsedInput.error.message.slice(0, 200)}`
        );
        continue;
      }
      // r49: agent_skill_write is a full-file overwrite — refuse when the
      // target changed after staging (manual edit or another agent): the
      // proposal was generated against the OLD contents, so applying now
      // would silently clobber the newer file. Never-executed skip: no side
      // effects, and a retry of this same staged set can never succeed —
      // the reason tells the user to restage. Advisory fast path only (r50):
      // this check is unlocked, so the AUTHORITATIVE comparison runs again
      // inside the tool's per-root mutation lock immediately before the
      // write (createStagedAgentSkillWriteTool) — a writer landing between
      // here and that lock is refused there as an executed failure.
      if (edit.tool === "agent_skill_write" && edit.targetContentHash !== undefined) {
        const currentHash =
          skillTargetProjectRoot === undefined
            ? undefined
            : await this.fingerprintSkillWriteTarget(skillTargetProjectRoot, edit.input);
        if (currentHash !== edit.targetContentHash) {
          log.warn("[Refine] staged edit skipped: target changed since staging", {
            workspaceId,
            tool: edit.tool,
          });
          skipFailures.set(
            edit.toolCallId,
            "target file changed since this proposal was staged; run /refine again to restage"
          );
          continue;
        }
      }
      try {
        const result: unknown = await tool.execute(parsedInput.data, {
          toolCallId: edit.toolCallId,
          messages: [],
          // Neither tool declares a context schema; undefined matches the
          // unknown-context Tool shape.
          context: undefined,
        });
        if (
          typeof result === "object" &&
          result !== null &&
          (result as { success?: unknown }).success === true
        ) {
          succeededIds.add(edit.toolCallId);
        } else {
          const toolError =
            typeof result === "object" && result !== null
              ? (result as { error?: unknown }).error
              : undefined;
          failedOutcomes.set(
            edit.toolCallId,
            typeof toolError === "string" && toolError.length > 0
              ? toolError.slice(0, 200)
              : "tool reported failure"
          );
        }
      } catch (error) {
        log.warn("[Refine] staged edit failed to apply", {
          workspaceId,
          tool: edit.tool,
          error: getErrorMessage(error),
        });
        failedOutcomes.set(edit.toolCallId, getErrorMessage(error).slice(0, 200));
      } finally {
        // Durable per-edit journal entry AFTER the execution settled
        // (success or clean failure — a failed edit must not replay either,
        // since its handler may have partially observable effects). Best
        // effort: a journal-write failure must not fail the admitted apply,
        // it only weakens crash recovery for this edit.
        attempted.add(edit.toolCallId);
        try {
          await saveStagedRefineSet(sessionDir, {
            ...staged,
            applyBaselineSeq: baselineSeq,
            attemptedToolCallIds: [...attempted],
            succeededToolCallIds: [...succeededIds],
            failedToolCalls: [...failedOutcomes].map(([toolCallId, reason]) => ({
              toolCallId,
              reason,
            })),
          });
        } catch (error) {
          log.warn("[Refine] failed to persist apply progress", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
        this.options.onStagedEditAttempted?.(edit.toolCallId);
      }
    }
    const journaledRows = await this.listStagedRefinementRows(
      sessionDir,
      workspaceId,
      baselineSeq,
      staged.edits.map((edit) => edit.toolCallId)
    );
    const applied: RefineAppliedEdit[] = journaledRows.map(({ row }) => ({
      refinementId: row.id,
      description: describeRefinementRow(row),
    }));
    // Journal acknowledgement can fail while the mutation itself succeeded
    // (appendRefinementEvent swallows journal/blob failures by design so
    // user-facing writes stay self-healing). Those edits are real — files
    // changed with no rollback id — so they must be reported, never
    // classified as a no-op. The tools' own PERSISTED success outcomes are
    // the ground truth: successes without a journaled row are untracked.
    // Set difference (not a counter minus applied.length) so a crash-resumed
    // apply — whose in-pass counter would be zero — still reconstructs
    // untracked successes recorded by the pre-crash pass.
    const journaledIds = new Set(journaledRows.map(({ toolCallId }) => toolCallId));
    const untrackedApplied = [...succeededIds].filter((id) => !journaledIds.has(id)).length;
    // Failed approved edits are REPORTED, never folded into a successful
    // no-op: "nothing was applied" must not stand in for "everything failed".
    // Rebuilt from this pass's never-executed skips plus the PERSISTED
    // executed failures, so a crash-resumed apply still reports failures
    // recorded by the pre-crash pass. Journaled/succeeded IDs are excluded
    // defensively (an ID cannot be both, but the record must stay coherent).
    const failed: Array<{ description: string; reason: string }> = [];
    for (const edit of staged.edits) {
      const skipReason = skipFailures.get(edit.toolCallId);
      if (skipReason !== undefined) {
        failed.push({ description: edit.description, reason: skipReason });
        continue;
      }
      const failureReason = failedOutcomes.get(edit.toolCallId);
      if (
        failureReason !== undefined &&
        !succeededIds.has(edit.toolCallId) &&
        !journaledIds.has(edit.toolCallId)
      ) {
        failed.push({ description: edit.description, reason: failureReason });
      }
    }
    const record: RefineRecord = {
      applied,
      summary: staged.summary,
      // Failures keep the apply out of no-op classification: approved edits
      // that failed must reach the audit row and the invoking UI.
      noOp: applied.length === 0 && untrackedApplied === 0 && failed.length === 0,
      ...(untrackedApplied > 0 ? { untrackedApplied } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    };

    log.debug("[Refine] apply complete", {
      workspaceId,
      staged: staged.edits.length,
      applied: applied.length,
      untrackedApplied,
      failed: failed.length,
    });

    // No cancellation gate here (unlike runLocked): an admitted apply's
    // audit row — the only durable record of the rollback IDs — must persist
    // even when removal is racing. Removal awaits this promise before
    // deleting the session directory, so the append still precedes teardown.
    if (!record.noOp) {
      const auditDurable = await this.appendSummaryMessage(workspaceId, record, {
        mode: "applied",
      });
      // The staged set is the only state that can regenerate the audit row
      // (persisted baseline + attempted IDs reproduce it with zero
      // re-mutation). A swallowed append failure here would consume that
      // state below and report success with the rollback IDs lost — same loss
      // as the crash window, so it must fail the apply, not just log.
      if (!auditDurable) {
        return Err(
          "refine apply finished, but the audit summary row (the durable record of the " +
            "rollback IDs) could not be appended to chat; the staged set is retained — run " +
            "/refine apply again to retry the audit record (attempted edits are never re-applied)"
        );
      }
    }
    // Consume the staged set only AFTER the audit summary append succeeded:
    // clearing first opened a crash window where every mutation + journal row
    // was durable but the resumable staged state was gone — the next apply
    // refused ("no staged refine edits") and the audit row holding the
    // rollback IDs could never be reconstructed. A crash after the append
    // but before this clear instead resumes as a fully-attempted set: zero
    // re-mutation (attempted IDs + journal-first recovery above), at worst a
    // duplicate audit row — a far better failure than lost rollback
    // addresses. Re-runs still can never double-apply (per-edit attempted
    // progress is persisted before this point).
    if (skipFailures.size > 0) {
      // Some edits never executed (no side effects, not in the attempted
      // set): keep the staged set so /refine apply can retry them once the
      // cause is fixed. The proposal row stays the newest hashed refine-
      // summary row (the audit row above carries no stagedSetHash), so the
      // retry still verifies approval against the same rendered bytes.
      return Ok(record);
    }
    await clearStagedRefineSet(sessionDir);
    return Ok(record);
  }

  /**
   * Newest staged-proposal hash from the chat transcript (see applyLocked).
   * Searches recent history for the latest refine-summary row carrying a
   * stagedSetHash; returns null when none exists in the window.
   */
  private async findNewestStagedProposalHash(workspaceId: string): Promise<string | null> {
    const messagesResult = await this.historyService.getLastMessages(
      workspaceId,
      REFINE_MAX_MESSAGES
    );
    if (!messagesResult.success) {
      return null;
    }
    for (let i = messagesResult.data.length - 1; i >= 0; i--) {
      const message = messagesResult.data[i];
      // SECURITY: never scan backwards across a context reset. A proposal
      // staged from pre-reset context must not stay approvable after the
      // user discarded that context — apply fails closed and /refine
      // restages from the active segment. (Compaction is different: the
      // scan may cross it, so a proposal staged just before an
      // auto-compaction remains approvable.)
      if (isDurableContextResetBoundaryMarker(message)) {
        return null;
      }
      const muxMetadata = message.metadata?.muxMetadata;
      if (
        muxMetadata?.type === "refine-summary" &&
        typeof muxMetadata.stagedSetHash === "string" &&
        muxMetadata.stagedSetHash.length > 0
      ) {
        return muxMetadata.stagedSetHash;
      }
    }
    return null;
  }

  private async runLocked(
    workspaceId: string,
    cancellationSignal: AbortSignal
  ): Promise<Result<RefineRecord, string>> {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);

    // SECURITY: confine the distillation input to the ACTIVE context
    // segment. getLastMessages crosses reset boundaries (and pages into the
    // sealed archive), so after /clear --soft a pre-reset prompt injection
    // could steer the staged proposal — which is durably appended AFTER the
    // boundary, re-entering model-visible context, and on approval persists
    // to memory/skills. Durable sandbox/carryover invalidation does not
    // filter chat history, so the read itself must stop at the boundary.
    // Compaction epochs stay represented inside the active segment (summary
    // row + preserved tail copies), so nothing legitimate is lost.
    const messagesResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!messagesResult.success) {
      return Err(`could not read workspace history: ${messagesResult.error}`);
    }
    const activeSegment = sliceMessagesForProviderFromLatestContextBoundary(messagesResult.data);
    // r47: fingerprint the snapshot rows for the pre-publication recheck.
    // Row IDs alone cannot detect same-ID rewrites: StreamManager finalizes
    // a streaming assistant row through updateHistory() PRESERVING its ID
    // and historySequence, so a pass distilled from the in-flight
    // placeholder would pass an ID-only prefix test after the stream
    // settles. Hash the serialized row instead — any in-place rewrite
    // changes the bytes. Captured before any consumer touches the rows so
    // the fingerprints reflect the disk state the transcript was built from.
    const snapshotRowFingerprints = activeSegment.map(fingerprintHistoryRow);
    // Reuse the branch-summary transcript builder: role-labeled,
    // thinking-stripped, char-bounded — exactly the evidence shape a
    // distillation pass needs. The tail cap preserves the prior bound on
    // transcript size.
    const transcript = buildAbandonedBranchTranscript(activeSegment.slice(-REFINE_MAX_MESSAGES));
    if (transcript.length === 0) {
      // Empty trajectory: a clean first-class no-op without spending a model call.
      return Ok({ applied: [], summary: "Nothing worth distilling.", noOp: true });
    }

    // Timeline events narrate the same trajectory, so they get the same
    // cutoff: events recorded before the segment's boundary row belong to
    // discarded (reset) or already-summarized (compaction) context. FAIL
    // CLOSED when the boundary cannot be correlated: a boundary row without
    // a usable timestamp must omit the timeline entirely rather than let
    // pre-reset user-controlled digests through unbounded.
    const boundaryIndex = findLatestContextBoundaryIndex(messagesResult.data);
    const boundaryRow = boundaryIndex >= 0 ? messagesResult.data[boundaryIndex] : undefined;
    const timelineSinceTs = boundaryRow?.metadata?.timestamp;
    // Persisted rows are JSON-cast without metadata validation, so a
    // corrupted boundary timestamp can be any number: -1 would admit every
    // nonnegative event. Only a finite, nonnegative timestamp is a usable
    // cutoff; anything else omits the timeline (fail closed).
    const boundaryTsUsable =
      typeof timelineSinceTs === "number" &&
      Number.isFinite(timelineSinceTs) &&
      timelineSinceTs >= 0;
    const timelineText =
      boundaryRow !== undefined && !boundaryTsUsable
        ? undefined
        : await this.buildTimelineText(workspaceId, timelineSinceTs);

    // Model: reuse the dream-agent inherit cascade — refine is the same class
    // of background self-maintenance agent, so a per-workspace dream override
    // intentionally covers both.
    const modelString = resolveDreamModelString(this.config, workspaceId);
    // Hard timeout + removal cancellation, created BEFORE model construction
    // (r55): a provider whose construction wedges (lazy module load, slow
    // token refresh) would otherwise block OUTSIDE every deadline race — the
    // per-workspace refine entry stays in flight indefinitely and workspace
    // removal hangs in cancelInFlightRefinePass, which aborts its controller
    // but awaits this promise while construction never observes the signal.
    // Same treatment as branch summary's model-creation race (r50).
    const abortSignal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? REFINE_TIMEOUT_MS),
      cancellationSignal,
    ]);
    const abortPromise = new Promise<null>((resolve) => {
      if (abortSignal.aborted) {
        resolve(null);
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const modelPromise = this.aiService.createModelWithPinnedMetadata(modelString, {
      agentInitiated: true,
      workspaceId,
    });
    const modelResult = await Promise.race([modelPromise, abortPromise]);
    if (modelResult === null) {
      // The deadline/removal won while the provider was still constructing.
      // The late model may still resolve holding real resources; clean it up
      // when it does so it cannot outlive workspace removal.
      void modelPromise.then(
        (late) => {
          if (late.success) runLanguageModelCleanup(late.data.model);
        },
        () => undefined
      );
      return Err(`refine cancelled while creating model ${modelString}`);
    }
    if (!modelResult.success) {
      return Err(`could not create model ${modelString}: ${modelResult.error.type}`);
    }
    // From here on the model is live: every exit (success, stream failure,
    // throw) must release it in the finally below.
    try {
      const projectPath = resolveConsolidationProjectPath(workspace);
      const ctx: MemoryScopeContext = {
        runtime: null,
        checkoutCwd: "",
        workspaceId,
        projectPath,
      };

      const sessionDir = path.join(this.config.sessionsDir, workspaceId);
      // The pass only STAGES edits (see refineStaging.ts) — journal-baseline
      // bookkeeping happens at apply time. Skill-tool availability is still
      // resolved here so the model only sees agent_skill_write when a later
      // apply could actually execute it.
      const skillWriteAvailable =
        (await this.buildSkillWriteTool(workspaceId, sessionDir)) !== undefined;

      const result = await runRefinePass({
        model: modelResult.data.model,
        memoryService: this.memoryService,
        metaService: this.metaService,
        ctx,
        transcript,
        timelineText,
        skillWriteAvailable,
        // Hard timeout: a wedged provider stream must not hold the run lock
        // forever. Workspace-removal cancellation is folded into the same
        // signal so it stops the stream (and its tool-driven writes) promptly.
        // The shared signal's timeout spans model creation + the pass (r55),
        // so construction time counts against the same deadline.
        abortSignal,
        recordUsage: async (usage, providerMetadata) => {
          const sessionUsageService = this.options.sessionUsageService;
          if (sessionUsageService === undefined) return;
          const write = sessionUsageService.recordHeadlessUsage(
            workspaceId,
            modelString,
            usage,
            providerMetadata,
            {
              analyticsSource: "refine",
              metadataModel: modelResult.data.metadataModel,
            }
          );
          // r57: the runner races this write against the pass deadline and
          // may detach it — register it in the shared usage-write registry
          // so removal's bounded clearPendingBranchSummary drain gives a
          // detached write one more chance to land before the session
          // directory is deleted.
          void trackPendingUsageWrite(
            workspaceId,
            write.then(() => undefined)
          );
          await write;
        },
      });
      if (result.streamError !== undefined) {
        // Nothing was applied (the pass only stages); a previous staged set,
        // if any, stays intact for a later apply.
        return Err(`refine stream failed: ${result.streamError}`);
      }

      const summary = result.summary.length > 0 ? result.summary : "Nothing worth distilling.";

      log.debug("[Refine] staging pass complete", {
        workspaceId,
        staged: result.stagedEdits.length,
        budgetExhausted: result.budgetExhausted,
        usage: result.usage,
      });

      // Cancellation gate before the disk/chat writes: removal aborts and
      // drains in-flight passes before deleting the session directory, and a
      // write past this point would recreate it. (A stream that drained
      // cleanly just before the abort still reaches here, so the mid-stream
      // abort alone is not enough.)
      if (cancellationSignal.aborted) {
        return Err("refine pass cancelled (workspace removed)");
      }

      // Staged-set replacement and proposal publication must be serialized
      // with a concurrent /refine apply in ANOTHER process
      // (XUM_ALLOW_MULTIPLE_INSTANCES=1), using the same lockfile apply
      // holds: apply's per-edit progress rewrites spread the staged snapshot
      // it loaded, so an unserialized save (or clear) here would be
      // overwritten by that stale spread — the new proposal row would remain
      // in chat with a hash that no longer matches the file, losing the new
      // edits and failing later applies closed.
      let stagingLock: Awaited<ReturnType<typeof acquireProcessFileLock>>;
      try {
        stagingLock = await acquireProcessFileLock({
          // r66: session-dir-external (see refineApplyLockPath).
          lockPath: refineApplyLockPath(this.config.rootDir, workspaceId),
          timeoutMs: this.options.applyLockTimeoutMs ?? REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
          label: "refine staging lock",
        });
      } catch (error) {
        return Err(
          `a refine apply appears to be running in another process; retry once it finishes: ` +
            getErrorMessage(error)
        );
      }
      await using _stagingLock = stagingLock;
      // Removal gate (r66), checked IN-LOCK: publication writes
      // refine-staged.json (mkdir sessionDir) before the proposal row's own
      // gated append could refuse — a removal that landed during generation
      // must refuse the whole publication, not resurrect the directory.
      if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
        return Err(`workspace ${workspaceId} was removed; refusing to publish the refine proposal`);
      }

      // r40: block turn admission across the recheck + staged-set
      // replacement + proposal append, failing closed when a turn is already
      // active. The boundary/anchor recheck below deliberately tolerates
      // ordinary tail appends, so without this gate the proposal row could
      // land inside a concurrent turn's PREPARING snapshot window or between
      // its user row and its response.
      const turnExclusionResult = this.acquireTurnExclusionIfWired(workspaceId);
      if (!turnExclusionResult.success) {
        return Err(
          `a turn is active in this workspace (${turnExclusionResult.error}); the distilled ` +
            `proposal cannot be published into a running conversation — run /refine again once ` +
            `the workspace is idle`
        );
      }
      using _turnExclusion = turnExclusionResult.data;

      // TOCTOU guard: the history snapshot above was taken before the model
      // streamed. A context reset, full clear, compaction, or tail rewrite
      // during generation discards/replaces distilled rows; publishing now
      // would land a proposal derived from that discarded context where the
      // approval-hash scan accepts it. Verify under the staging lock — which
      // the reset/clear paths also hold across their mutation — that the
      // latest context-boundary identity is unchanged AND that the distilled
      // snapshot is still an unchanged PREFIX of the active segment (r43),
      // compared by per-row content fingerprint, not row ID (r47): a stream
      // that was mid-flight at snapshot time settles by finalizing its
      // placeholder row IN PLACE (same ID, new parts), which an ID-only
      // prefix test cannot see. Ordinary mid-pass appends extend the tail
      // and keep the prefix; a boundary-less full /clear empties it; an
      // edit-resend or partial truncation that keeps the first row but
      // rewrites the tail breaks the prefix; and a same-ID finalization
      // changes the row's fingerprint.
      const recheckResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!recheckResult.success) {
        return Err(`could not re-verify workspace history before staging: ${recheckResult.error}`);
      }
      const recheckBoundaryIndex = findLatestContextBoundaryIndex(recheckResult.data);
      const recheckBoundaryId =
        recheckBoundaryIndex >= 0 ? recheckResult.data[recheckBoundaryIndex].id : null;
      const recheckSegment = sliceMessagesForProviderFromLatestContextBoundary(recheckResult.data);
      const snapshotIsUnchangedPrefix =
        activeSegment.length <= recheckSegment.length &&
        snapshotRowFingerprints.every(
          (fingerprint, index) => fingerprintHistoryRow(recheckSegment[index]) === fingerprint
        );
      if (recheckBoundaryId !== (boundaryRow?.id ?? null) || !snapshotIsUnchangedPrefix) {
        return Err(
          "the workspace context was reset, cleared, compacted, or rewritten while the refine " +
            "pass was running; the distilled proposal no longer describes the active context — " +
            "run /refine again"
        );
      }

      // r49: fingerprint each staged skill write's CURRENT target before the
      // set is saved and hash-bound to the proposal row, so apply can refuse
      // full-file writes whose target changed after staging. Enriched BEFORE
      // both the save and hashStagedRefineSet below — the approval hash must
      // cover the exact persisted set.
      const stagedEdits = await this.fingerprintMemoryTargets(
        ctx,
        await this.fingerprintSkillWriteTargets(workspaceId, result.stagedEdits)
      );
      // Built from the COLLAPSED set (r53): same-target skill writes were
      // deduplicated above, and the record's staged descriptions must match
      // the persisted set the user approves.
      const record: RefineRecord = {
        applied: [],
        summary,
        noOp: stagedEdits.length === 0,
        ...(stagedEdits.length > 0
          ? { staged: stagedEdits.map((edit) => ({ description: edit.description })) }
          : {}),
        usage: result.usage,
      };

      // Every completed pass REPLACES the staged set (one per workspace):
      // stale proposals from an older trajectory must not linger behind a
      // newer no-op result.
      if (stagedEdits.length > 0) {
        await saveStagedRefineSet(sessionDir, {
          version: 1,
          workspaceId,
          createdAt: Date.now(),
          summary,
          edits: stagedEdits,
        });
      } else {
        await clearStagedRefineSet(sessionDir);
      }

      // Completion UX: post the labeled proposal row ONLY when edits were
      // staged — a no-op stays out of chat (the invoking toast reports it).
      // The row renders the exact staged payloads and carries their hash so
      // apply can bind approval to these bytes.
      if (!record.noOp) {
        const proposalDurable = await this.appendSummaryMessage(workspaceId, record, {
          mode: "staged",
          edits: stagedEdits,
          stagedSetHash: hashStagedRefineSet(stagedEdits),
        });
        // Approval is hash-bound to this rendered row; without it apply fails
        // closed ("no staged refine proposal found"). Reporting staged
        // success here would leave the user a dead end.
        if (!proposalDurable) {
          return Err(
            "edits were staged, but the proposal row could not be recorded in chat for " +
              "approval; run /refine again to restage"
          );
        }
      }
      return Ok(record);
    } finally {
      // Providers can attach cleanup hooks (e.g. an OpenAI Responses
      // WebSocket transport); without this, repeated /refine runs accumulate
      // live transports. Same posture as the other headless model consumers
      // (branchSummary, workspaceTitleGenerator).
      runLanguageModelCleanup(modelResult.data.model);
    }
  }

  /** Newest journal seq, or -1 for a fresh/absent journal. */
  private async readMaxJournalSeq(sessionDir: string): Promise<number> {
    const events = await sharedDurableEventJournal(sessionDir).read();
    return events.reduce((max, event) => Math.max(max, event.seq), -1);
  }

  /**
   * Journal refinement rows appended after baselineSeq whose evidence
   * correlates to one of the given staged tool calls (see applyLocked's
   * baseline comment for why both filters are required).
   */
  private async listStagedRefinementRows(
    sessionDir: string,
    workspaceId: string,
    baselineSeq: number,
    toolCallIds: string[]
  ): Promise<Array<{ row: RefinementEvent; toolCallId: string }>> {
    if (toolCallIds.length === 0) return [];
    const callIds = new Set(toolCallIds);
    const rows = await listRefinements(sessionDir);
    const matched: Array<{ row: RefinementEvent; toolCallId: string }> = [];
    for (const row of rows) {
      if (row.seq <= baselineSeq || row.workspaceId !== workspaceId) continue;
      const evidence = RefinementEvidenceSchema.safeParse(row.data.evidence);
      if (!evidence.success) continue;
      if (evidence.data.toolCallId === undefined || !callIds.has(evidence.data.toolCallId)) {
        continue;
      }
      matched.push({ row, toolCallId: evidence.data.toolCallId });
    }
    return matched;
  }

  /** Resolved target path for a staged skill write, or undefined when the
   * input cannot be parsed/resolved (such edits also get no fingerprint). */
  private resolveStagedSkillWriteTarget(projectRoot: string, input: unknown): string | undefined {
    const parsed = TOOL_DEFINITIONS.agent_skill_write.schema.safeParse(input);
    if (!parsed.success) return undefined;
    const resolved = resolveProjectSkillWriteTargetPath({
      projectRoot,
      name: parsed.data.name,
      filePath: parsed.data.filePath,
    });
    return resolved.ok ? resolved.path : undefined;
  }

  /**
   * sha256 fingerprint of a staged agent_skill_write edit's CURRENT target
   * file, "absent" when it does not exist, or undefined when the target
   * cannot be resolved or read (invalid input is rejected by apply's schema
   * check regardless).
   */
  private async fingerprintSkillWriteTarget(
    projectRoot: string,
    input: unknown
  ): Promise<string | undefined> {
    const targetPath = this.resolveStagedSkillWriteTarget(projectRoot, input);
    if (targetPath === undefined) return undefined;
    try {
      // Shared hash helper (r50): the tool recomputes this fingerprint under
      // its mutation lock at apply, so encoding and sentinel must match.
      const content = await fsPromises.readFile(targetPath, "utf-8");
      return hashSkillWriteTargetContent(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return hashSkillWriteTargetContent(null);
      }
      return undefined;
    }
  }

  /**
   * Enrich staged skill writes with target fingerprints (r49):
   * agent_skill_write is a full-file overwrite, so apply must be able to
   * detect a target edited after staging and refuse to clobber it. Memory
   * WRITE edits are excluded — their command semantics carry their own
   * conflict behavior (create fails on existing files, str_replace verifies
   * its anchor text) — but destructive memory deletes are fingerprinted by
   * fingerprintMemoryTargets (r55 deletes, r58 inserts).
   */
  private async fingerprintSkillWriteTargets(
    workspaceId: string,
    edits: StagedRefineEdit[]
  ): Promise<StagedRefineEdit[]> {
    if (!edits.some((edit) => edit.tool === "agent_skill_write")) return edits;
    const projectRoot = await this.resolveSkillWriteProjectRoot(workspaceId);
    // FAIL CLOSED (r65, mirrors the r57 memory path): staged skill writes
    // are full-file overwrites whose only apply-time conflict guard is the
    // fingerprint captured here. Retaining an edit UNHASHED (project root
    // transiently unresolvable, EACCES/read error below) disables that guard
    // — if access recovers and the target changes before /refine apply, the
    // staged writer would silently overwrite the newer contents. Drop such
    // edits instead; the user reruns /refine once the cause clears.
    if (projectRoot === undefined) {
      log.warn("[Refine] dropping staged skill writes: project root unresolvable", {
        workspaceId,
      });
      return edits.filter((edit) => edit.tool !== "agent_skill_write");
    }
    // r53: collapse multiple staged writes to the SAME resolved target down
    // to the LAST one (in apply order). Staged skill writes are full-file
    // overwrites, so the final write alone yields the identical end state —
    // whereas fingerprinting every duplicate against the same pre-apply file
    // would make the in-lock guard reject each later duplicate as an
    // external change the moment the first one applied, leaving an approved
    // proposal that can never fully apply. Collapsed BEFORE fingerprinting,
    // saving, and hashStagedRefineSet so the user approves exactly the set
    // apply executes.
    const lastWriteIndexByTarget = new Map<string, number>();
    edits.forEach((edit, index) => {
      if (edit.tool !== "agent_skill_write") return;
      const targetPath = this.resolveStagedSkillWriteTarget(projectRoot, edit.input);
      if (targetPath !== undefined) lastWriteIndexByTarget.set(targetPath, index);
    });
    const collapsed = edits.filter((edit, index) => {
      if (edit.tool !== "agent_skill_write") return true;
      const targetPath = this.resolveStagedSkillWriteTarget(projectRoot, edit.input);
      return targetPath === undefined || lastWriteIndexByTarget.get(targetPath) === index;
    });
    return Promise.all(
      collapsed.map(async (edit) => {
        if (edit.tool !== "agent_skill_write") return edit;
        const targetContentHash = await this.fingerprintSkillWriteTarget(projectRoot, edit.input);
        if (targetContentHash === undefined) {
          // See the fail-closed note above: an unhashed skill write must not
          // be proposed (ENOENT is not a failure — it hashes to the absent
          // sentinel — so this branch is unresolvable targets and read errors).
          log.warn("[Refine] dropping staged skill write: target fingerprinting failed", {
            workspaceId,
          });
          return undefined;
        }
        return { ...edit, targetContentHash };
      })
    ).then((results) => results.filter((edit): edit is StagedRefineEdit => edit !== undefined));
  }

  /**
   * Enrich staged memory DELETE (r55) and INSERT (r58) edits with target
   * fingerprints: unlike create/str_replace, neither carries usable
   * command-level conflict semantics — a delete would remove the target's
   * CURRENT contents, and an insert's numeric line position would silently
   * land in the wrong place when the file was edited after staging.
   * MemoryService re-verifies the fingerprint INSIDE its target mutation
   * lock at apply. FAIL CLOSED (r57): a fingerprinting failure drops the
   * edit from the staged set — an unguarded mutation must not be proposed.
   */
  private async fingerprintMemoryTargets(
    ctx: MemoryScopeContext,
    edits: StagedRefineEdit[]
  ): Promise<StagedRefineEdit[]> {
    return Promise.all(
      edits.map(async (edit) => {
        if (edit.tool !== "memory") return edit;
        const guardedTargetPath = stagedMemoryGuardedTargetPath(edit.input);
        if (guardedTargetPath === undefined) return edit;
        try {
          const targetContentHash = await this.memoryService.fingerprintMutationTarget(
            ctx,
            guardedTargetPath
          );
          return { ...edit, targetContentHash };
        } catch (error) {
          log.warn("[Refine] dropping staged memory edit: target fingerprinting failed", {
            path: guardedTargetPath,
            error: getErrorMessage(error),
          });
          return undefined;
        }
      })
    ).then((results) => results.filter((edit): edit is StagedRefineEdit => edit !== undefined));
  }

  /**
   * The checkout root skill writes are confined to, under the same guards
   * buildSkillWriteTool applies (host-local, single project) — shared by the
   * r49 target fingerprinting so its path resolution cannot drift from the
   * tool the apply executes. Undefined disables both.
   */
  private async resolveSkillWriteProjectRoot(workspaceId: string): Promise<string | undefined> {
    try {
      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) return undefined;
      const metadata = metadataResult.data;
      const runtimeType = metadata.runtimeConfig.type;
      if (runtimeType === "ssh" || runtimeType === "docker") return undefined;
      if ((metadata.projects?.length ?? 0) > 1) return undefined;
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) return undefined;
      return workspace.workspacePath;
    } catch (error) {
      log.debug("[Refine] skill project root unresolved", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * Standard agent_skill_write tool confined to the workspace checkout's
   * .xum/skills (project scope). Only for host-local single-project
   * workspaces: remote runtimes would need a live runtime connection and
   * multi-project workspaces have no single skills root. Memory scopes remain
   * available either way. Returns undefined (memory-only pass) on any
   * resolution failure — never fails the run.
   */
  private async buildSkillWriteTool(
    workspaceId: string,
    sessionDir: string,
    // r50 (apply only): staged target fingerprints, verified by the tool
    // INSIDE its per-root mutation lock immediately before writing.
    expectedTargetHashes?: ReadonlyMap<string, string>
  ): Promise<Tool | undefined> {
    try {
      const projectRoot = await this.resolveSkillWriteProjectRoot(workspaceId);
      if (projectRoot === undefined) return undefined;

      // Minimal host-local ToolConfiguration: the project-local skill path
      // only touches fs/promises under xumScope roots; workspaceSessionDir +
      // workspaceId make the tool's r2 refinement journaling land in this
      // session's durable journal.
      const toolConfig: ToolConfiguration = {
        cwd: projectRoot,
        runtime: new LocalRuntime(projectRoot),
        runtimeTempDir: os.tmpdir(),
        workspaceSessionDir: sessionDir,
        workspaceId,
        xumScope: {
          type: "project",
          xumHome: this.config.rootDir,
          projectRoot,
          projectStorageAuthority: "host-local",
        },
      };
      return expectedTargetHashes !== undefined
        ? createStagedAgentSkillWriteTool(toolConfig, expectedTargetHashes)
        : createAgentSkillWriteTool(toolConfig);
    } catch (error) {
      log.debug("[Refine] skill tool unavailable; running memory-only", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /** Timeline digest when the Timeline experiment is on; undefined otherwise. */
  private async buildTimelineText(
    workspaceId: string,
    sinceTs?: number
  ): Promise<string | undefined> {
    if (!this.experiments.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE)) return undefined;
    if (this.options.timelineService === undefined) return undefined;
    try {
      const page = await this.options.timelineService.list(workspaceId, {
        limit: REFINE_TIMELINE_EVENT_LIMIT,
      });
      // Same confinement as the transcript (see runLocked): events from
      // before the active segment's boundary row are excluded. STRICTLY
      // after: timestamps are millisecond-resolution, so a pre-reset event
      // sharing the boundary's millisecond must be dropped (excluding a
      // legitimate same-millisecond post-reset event is the safe direction).
      const events =
        sinceTs === undefined ? page.events : page.events.filter((event) => event.ts > sinceTs);
      if (events.length === 0) return undefined;
      // list() returns newest-first; present oldest-first for the model.
      return [...events]
        .reverse()
        .map((event) => {
          const description = event.data?.description ?? event.data?.digest ?? "";
          return `${new Date(event.ts).toISOString()} ${event.kind}${
            description.length > 0 ? `: ${description}` : ""
          }`;
        })
        .join("\n");
    } catch (error) {
      log.debug("[Refine] timeline read failed; continuing without it", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * r40: acquire the workspace's turn-admission block when the hook is
   * wired; Ok(null) otherwise (lightweight test fakes). `using` accepts the
   * null, so call sites stay uniform.
   */
  private acquireTurnExclusionIfWired(workspaceId: string): Result<Disposable | null, string> {
    if (!this.options.acquireTurnExclusion) {
      return Ok(null);
    }
    return this.options.acquireTurnExclusion(workspaceId);
  }

  /**
   * Append + emit the summary row. Returns true only when the row is durably
   * appended (renderer emission stays best-effort): both callers depend on
   * the row's existence — the applied-mode audit row is the sole durable
   * record of the rollback IDs, and the staged-mode proposal row is the
   * hash-bound approval affordance apply verifies against — so a swallowed
   * append failure must be distinguishable from success.
   */
  private async appendSummaryMessage(
    workspaceId: string,
    record: RefineRecord,
    mode: Parameters<typeof createRefineSummaryMessage>[1]
  ): Promise<boolean> {
    try {
      const message = createRefineSummaryMessage(record, mode);
      const appendResult = await this.historyService.appendToHistory(workspaceId, message);
      if (!appendResult.success) {
        log.warn("[Refine] failed to append summary row", {
          workspaceId,
          error: appendResult.error,
        });
        return false;
      }
      try {
        this.options.emitChatMessage?.(workspaceId, message);
      } catch (error) {
        // The row is durable; a renderer-emission failure only delays its
        // visibility until reload and must not fail the operation.
        log.warn("[Refine] summary emission failed", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }
      return true;
    } catch (error) {
      log.warn("[Refine] summary emission failed", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }
}
