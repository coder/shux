import { createHash } from "crypto";
import assert from "@/common/utils/assert";
import {
  AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS,
  AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS,
  AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS,
  AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS,
  AGENT_STATUS_MAX_CONCURRENT,
  AGENT_STATUS_MAX_MESSAGE_CHARS,
  AGENT_STATUS_MAX_TRAILING_MESSAGES,
  AGENT_STATUS_MAX_TRANSCRIPT_TOKENS,
  AGENT_STATUS_PROVIDER_FAILURE_ACTIVE_COOLDOWN_MS,
  AGENT_STATUS_PROVIDER_FAILURE_IDLE_COOLDOWN_MS,
  AGENT_STATUS_PROVIDER_FAILURE_MAX_COOLDOWN_MS,
  AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS,
  AGENT_STATUS_TICK_INTERVAL_MS,
} from "@/constants/agentStatus";
import type { Config } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { AIService } from "./aiService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";
import type { TokenizerService } from "./tokenizerService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import { generateWorkspaceStatus } from "./workspaceStatusGenerator";
import { log } from "./log";

const FALLBACK_TOKENIZER_MODEL = "anthropic:claude-haiku-4-5";

export interface AgentStatusServiceOptions {
  /** Override for test injection. Defaults to `Date.now`. */
  clock?: () => number;
  /** Override scheduler tick interval. Defaults to AGENT_STATUS_TICK_INTERVAL_MS. */
  tickIntervalMs?: number;
  /**
   * Cost telemetry sink. Status generation bypasses StreamManager, so
   * without this its recurring spend never reaches session-usage.json.
   */
  sessionUsageService?: SessionUsageService;
  /**
   * Request an analytics ingest pass after usage is recorded so the
   * headless-usage sidecar reaches dashboard totals even when the workspace
   * has no further stream activity.
   */
  requestAnalyticsIngest?: (workspaceId: string) => void;
}

interface State {
  /** Last time we ran (or skipped via dedup). 0 if we never ran. */
  lastRanAt: number;
  /**
   * Hash of the input we last "settled" on — i.e. an outcome that depends
   * on the *transcript* and shouldn't be retried until the transcript
   * changes. That covers:
   *   - successful persists (Ok result, status written),
   *   - post-generation placeholder rejection,
   *
   * Pre-provider failures (no API key, OAuth not connected, provider
   * disabled, model not available, policy denied — anything that fails
   * inside createModel before we cross the wire) intentionally do NOT
   * advance this hash. Those are properties of the user's *config*, and
   * caching them by transcript would freeze a workspace out of AI status
   * until a new chat message arrived, even after the user fixed
   * credentials. See the `result.error.reachedProvider` branch in
   * `runForWorkspace`.
   *
   * null if we have never settled on a transcript for this workspace.
   * On the first run after process start it is seeded from the hash
   * persisted next to the sidebar status (see persistedHashChecked).
   */
  lastInputHash: string | null;
  /**
   * Whether we already tried seeding lastInputHash from the hash persisted
   * alongside the sidebar status (ExtensionMetadataService). Done lazily on
   * the first runForWorkspace per process so a server restart doesn't
   * regenerate statuses for chats whose transcript hasn't changed.
   */
  persistedHashChecked: boolean;
  /**
   * Whether lastInputHash settled by persisting a sidebar status (true) or
   * without one, e.g. placeholder rejection (false). Only persisted settles
   * are invalidated when another writer clears the shared status slot;
   * invalidating placeholder settles would retry the same
   * placeholder-producing transcript on every tick.
   */
  lastInputHashPersisted: boolean;
  /**
   * Hash of the transcript the scheduler last examined, even if that input
   * did not settle into a sidebar status (for example, a pre-provider config
   * failure). Used to avoid consuming a recency bump while history is still
   * catching up to the user message that caused it.
   */
  lastSeenInputHash: string | null;
  /**
   * Recency timestamp observed the last time the scheduler considered this
   * workspace. User messages update recency, so an increased value is a
   * strong signal that the old sidebar status may now be stale even if the
   * normal idle/active cadence has not elapsed yet.
   */
  lastObservedRecency: number | null;
  /** Transcript+streaming hash that last hit a retryable provider-side failure. */
  lastProviderFailureHash: string | null;
  /** Number of consecutive provider-side failures for lastProviderFailureHash. */
  providerFailureCount: number;
  /** Earliest wall-clock time to retry lastProviderFailureHash after cooldown. */
  providerFailureRetryAfter: number | null;
  /** Whether a generation is currently in flight. */
  inFlight: boolean;
}

/**
 * Periodic backend job that produces the sidebar's AI-generated agent status
 * using the same "small model" path as workspace title generation.
 *
 * Cadence: streaming workspaces refresh fast so the user can follow along;
 * idle workspaces back off. Both back off further when the desktop window
 * is blurred. See ACTIVE_/IDLE_ intervals in @/constants/agentStatus.
 *
 * Dedup: each generation hashes its trailing-transcript window. Identical
 * hash to the last settled run skips regeneration (idle/frozen chats).
 *
 * Concurrency: bounded by AGENT_STATUS_MAX_CONCURRENT so a multi-workspace
 * sweep never spikes provider load.
 */
export class AgentStatusService {
  private readonly tracked = new Map<string, State>();
  private readonly inFlightPromises = new Set<Promise<void>>();
  private readonly clock: () => number;
  private readonly tickIntervalMs: number;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly requestAnalyticsIngest?: (workspaceId: string) => void;

  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickInFlight = false;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly tokenizerService: TokenizerService,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly workspaceService: WorkspaceService,
    private readonly windowService: WindowService,
    private readonly aiService: AIService,
    options: AgentStatusServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? AGENT_STATUS_TICK_INTERVAL_MS;
    this.sessionUsageService = options.sessionUsageService;
    this.requestAnalyticsIngest = options.requestAnalyticsIngest;
  }

  start(): void {
    assert(this.checkInterval === null, "AgentStatusService.start() called while already running");
    this.stopped = false;
    // No startup delay: AGENT_STATUS_MAX_CONCURRENT=1 already serializes
    // generation across workspaces, so an immediate first tick won't create a
    // thundering herd at launch.
    this.checkInterval = setInterval(() => void this.runTick(), this.tickIntervalMs);
    void this.runTick();
    log.info("AgentStatusService started", { tickIntervalMs: this.tickIntervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.tracked.clear();
    this.inFlightPromises.clear();
    this.tickInFlight = false;
    log.info("AgentStatusService stopped");
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      // Anchor lastRanAt below to tick start time. With tick=10s and
      // active-focused interval=10s, that makes the eligibility math exact:
      // tick[k+1] - tick[k] === interval, so the workspace runs every tick.
      // Otherwise sub-ms timer drift can degrade actual cadence to 2× the
      // configured interval.
      const tickStartedAt = this.clock();
      await this.dispatch(tickStartedAt);
      // Awaited so production callers and tests observe completion.
      await Promise.allSettled([...this.inFlightPromises]);
    } catch (error) {
      log.error("AgentStatusService tick failed", { error });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async dispatch(tickStartedAt: number): Promise<void> {
    const focused = this.windowService.isFocused();
    // One disk read per tick for streaming state across all workspaces.
    // Cheap, and avoids N reads inside the inner loop.
    const snapshots = await this.extensionMetadata.getAllSnapshots();

    // Sort eligible workspaces by lastRanAt ascending. With MAX_CONCURRENT=1,
    // a fixed iteration order would let the first workspace starve the rest;
    // least-recently-run gives fair round-robin without an explicit queue.
    const eligible: Array<{
      id: string;
      lastRanAt: number;
      recency: number | null;
      recencyAdvanced: boolean;
    }> = [];
    for (const [, projectConfig] of this.config.loadConfigOrDefault().projects) {
      for (const ws of projectConfig.workspaces) {
        const id = ws.id ?? ws.name;
        if (typeof id !== "string" || id.length === 0) continue;
        if (isWorkspaceArchived(ws.archivedAt, ws.unarchivedAt)) continue;
        const state = this.tracked.get(id);
        if (state?.inFlight) continue;
        const snapshot = snapshots.get(id);
        const recency = typeof snapshot?.recency === "number" ? snapshot.recency : null;
        const recencyAdvanced = hasRecencyAdvanced(state, recency);
        const interval = pickInterval(snapshot?.streaming === true, focused);
        if (state && !recencyAdvanced && tickStartedAt - state.lastRanAt < interval) continue;
        eligible.push({ id, lastRanAt: state?.lastRanAt ?? 0, recency, recencyAdvanced });
      }
    }
    eligible.sort((a, b) => {
      if (a.recencyAdvanced !== b.recencyAdvanced) {
        // A user message is usually a task pivot. Put those workspaces ahead
        // of ordinary cadence refreshes so stale pre-pivot statuses don't
        // linger behind background idle work.
        return a.recencyAdvanced ? -1 : 1;
      }
      return a.lastRanAt - b.lastRanAt;
    });

    for (const { id, recency } of eligible) {
      if (this.stopped || this.inFlightPromises.size >= AGENT_STATUS_MAX_CONCURRENT) return;
      const state = this.ensureState(id);
      state.inFlight = true;
      // Set lastRanAt at dispatch time (not after the async transcript
      // build) so cadence is anchored to tick boundaries — see runTick.
      state.lastRanAt = tickStartedAt;
      // Forward the live streaming bit so the prompt can lock in
      // present-progressive tense when the assistant is mid-response.
      // Snapshots were already read once per tick above.
      const streaming = snapshots.get(id)?.streaming === true;
      const promise = this.runForWorkspace(id, recency, streaming).finally(() => {
        state.inFlight = false;
        this.inFlightPromises.delete(promise);
      });
      this.inFlightPromises.add(promise);
    }
  }

  private async runForWorkspace(
    workspaceId: string,
    observedRecency: number | null = null,
    streaming = false
  ): Promise<void> {
    try {
      const transcript = await this.buildTrailingTranscript(workspaceId);
      // Two hashes, two purposes:
      //
      //   transcriptHash — keyed only on transcript bytes. Used by the
      //     history-catch-up guard (`isRecentRecencyAheadOfHistory` +
      //     `lastSeenInputHash`) to detect "transcript unchanged since the
      //     last look." Folding `streaming` into this comparison would make
      //     the common idle→streaming transition look like a transcript
      //     change and bypass the wait-for-history guard, letting the
      //     service persist a stale pre-pivot status and consume the
      //     recency signal.
      //
      //   dedupHash — keyed on transcript + streaming. Used by the
      //     "settled, skip regeneration" branch (`state.lastInputHash`)
      //     because `streaming` now changes the prompt's tense guidance
      //     and therefore the generated status; identical transcript bytes
      //     with different streaming values must dedup independently.
      const transcriptHash = computeTranscriptHash(transcript);
      const dedupHash = computeDedupHash(transcriptHash, streaming);
      // dispatch() set lastRanAt to the tick start time before kicking us
      // off, so the scheduler won't reconsider this workspace until the next
      // interval boundary unless a newer user-recency timestamp indicates the
      // chat pivoted again.
      const state = this.ensureState(workspaceId);

      // First look at this workspace since process start: seed the dedup
      // hash persisted alongside the sidebar status so a restart doesn't
      // regenerate every idle chat. A stale or missing persisted hash simply
      // misses the dedup branch below and regenerates as before.
      if (!state.persistedHashChecked) {
        state.persistedHashChecked = true;
        if (state.lastInputHash === null) {
          const persisted = await this.extensionMetadata.getSidebarStatusInputHash(workspaceId);
          if (persisted !== null) {
            // The reader only returns hashes backed by a live status, so a
            // seeded hash is by definition a persisted settle.
            state.lastInputHash = persisted;
            state.lastInputHashPersisted = true;
          }
        }
      }
      const markRecencyObserved = () => {
        if (observedRecency !== null) {
          state.lastObservedRecency = observedRecency;
        }
      };
      // Settle this transcript: consume observed recency AND advance the dedup
      // hash so the next tick won't regenerate against the same input. Used by
      // the three branches that produce a definitive outcome for this transcript
      // (post-provider failure, placeholder rejection, successful persist).
      // Pre-provider failures and the empty/dedup-hit branches use bare
      // `markRecencyObserved()` because they should still retry on the same
      // transcript when conditions change.
      const settleOnTranscript = (persistedStatus: boolean) => {
        markRecencyObserved();
        state.lastInputHash = dedupHash;
        state.lastInputHashPersisted = persistedStatus;
        resetProviderFailureTracking(state);
      };

      if (
        isRecentRecencyAheadOfHistory(
          state,
          transcriptHash,
          observedRecency,
          this.clock(),
          AGENT_STATUS_TICK_INTERVAL_MS
        )
      ) {
        state.lastSeenInputHash = transcriptHash;
        // We may be seeing WorkspaceService's recency update before the
        // corresponding user message is appended to history. If the transcript
        // is unchanged from the last one we examined (or we have no baseline
        // immediately after startup), generating now could persist a stale
        // pre-pivot status and consume the only recency signal. Wait one
        // scheduler interval so the history write can catch up.
        log.debug("AgentStatusService: waiting for recent recency bump to reach history", {
          workspaceId,
          observedRecency,
        });
        return;
      }
      state.lastSeenInputHash = transcriptHash;

      // Empty workspace: nothing to summarize. Don't blank an existing
      // todoStatus — that would clobber a status produced before compaction.
      // Still consume non-racy recency so an empty workspace doesn't sort as
      // "recency advanced" forever and starve other workspaces under the
      // single-concurrency scheduler.
      if (transcript.trim().length === 0) {
        markRecencyObserved();
        return;
      }
      // Idle/frozen: identical trailing window since last settled run. The
      // recent race path above already handles recency that may be ahead of
      // history, so any recency reaching this dedup branch is stale/non-racy:
      // consume it to avoid permanent recency-advanced priority.
      // dedupHash (transcript + streaming) is the right key here: flipping
      // the streaming bit must force a re-generation so the new liveness
      // hint actually applies.
      if (state.lastInputHash === dedupHash) {
        // Codex review: another writer (the todo path) can clear the shared
        // status slot at any time, including between scheduler reads, so a
        // dispatch-time snapshot would be stale here. Confirm at the skip
        // decision itself: the authoritative reader returns null once the
        // slot is cleared. Placeholder settles skip the recheck — they never
        // persisted a status, so an empty slot is their steady state, and
        // rechecking would retry the same placeholder transcript every tick.
        const stillBacked =
          !state.lastInputHashPersisted ||
          (await this.extensionMetadata.getSidebarStatusInputHash(workspaceId)) === dedupHash;
        if (stillBacked) {
          markRecencyObserved();
          return;
        }
        // Slot cleared (or rewritten) since we settled: drop the stale
        // settle and regenerate now instead of leaving the sidebar blank.
        state.lastInputHash = null;
        state.lastInputHashPersisted = false;
      }
      if (isWaitingForProviderFailureCooldown(state, dedupHash, this.clock())) {
        // Provider-side failures are not permanently settled: after the
        // immediate retry budget, retry on a cost-aware cooldown so transient
        // outages can still recover without a new chat turn.
        markRecencyObserved();
        return;
      }

      const candidates = await this.workspaceService.getWorkspaceTitleModelCandidates(workspaceId);
      if (candidates.length === 0) {
        // No configured small-model path is a config state, not a transcript result.
        // Consume recency priority so one workspace cannot starve the scheduler, but
        // keep the dedup hash open so a later config/provider change can recover.
        resetProviderFailureTracking(state);
        markRecencyObserved();
        return;
      }

      // Skip the expensive provider call if stop() fired during any of the
      // earlier awaits (transcript build, candidates fetch). The generator
      // can take seconds to a minute, so kicking it off after shutdown
      // would leak background LLM work past our lifecycle.
      if (this.stopped) return;
      const result = await generateWorkspaceStatus(transcript, candidates, this.aiService, {
        streaming,
        recordUsage: async (modelString, usage, usageOptions) => {
          const recorded = await this.sessionUsageService?.recordHeadlessUsage(
            workspaceId,
            modelString,
            usage,
            usageOptions.providerMetadata,
            {
              analyticsSource: "workspace_status",
              // Creation-time identity from the generator's pinned snapshot.
              metadataModel: usageOptions.metadataModel,
            }
          );
          if (recorded) {
            this.requestAnalyticsIngest?.(workspaceId);
          }
        },
      });
      // Re-check after the generator returns: the same hazard at a later
      // await boundary.
      if (this.stopped) return;
      if (!result.success) {
        // Do not let provider-side misses freeze the sidebar until the next
        // chat turn. Models occasionally ignore propose_status or hit transient
        // provider failures for an otherwise valid transcript. Retry a small
        // number of times immediately, then switch to a cost-aware cooldown so
        // the same transcript still eventually recovers.
        if (result.error.reachedProvider) {
          const failureAttempt = recordProviderFailureAttempt(state, dedupHash);
          if (hasProviderFailureRetryBudget(failureAttempt)) {
            log.debug(
              "AgentStatusService: status generation failed at provider; will retry on cadence",
              {
                workspaceId,
                error: result.error.error,
                failureAttempt,
                retryBudget: AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS,
              }
            );
            markRecencyObserved();
          } else {
            const retryDelayMs = computeProviderFailureRetryDelayMs(failureAttempt, streaming);
            state.providerFailureRetryAfter = this.clock() + retryDelayMs;
            log.debug(
              "AgentStatusService: status generation failed at provider; cooling down before retry",
              { workspaceId, error: result.error.error, failureAttempt, retryDelayMs }
            );
            markRecencyObserved();
          }
        } else {
          log.debug(
            "AgentStatusService: status generation failed before reaching provider; will retry on cadence",
            { workspaceId, error: result.error.error }
          );
          // Consume recency without advancing lastInputHash: credential/config
          // fixes should still retry the same transcript, but a misconfigured
          // workspace must not retain permanent recency-advanced priority and
          // starve other workspaces under max concurrency 1.
          resetProviderFailureTracking(state);
          markRecencyObserved();
        }
        return;
      }

      // Defense in depth: even with a tuned prompt, small models can
      // occasionally produce a generic placeholder ("Awaiting next task",
      // "Doing work", etc.) that conveys no information. Reject those
      // outputs before they reach the sidebar. Advance lastInputHash so we
      // don't burn provider budget retrying the same transcript on every
      // tick — the next genuine transcript change will trigger a fresh
      // attempt.
      if (isPlaceholderStatus(result.data.status.message)) {
        log.debug("AgentStatusService: model produced placeholder status; skipping persist", {
          workspaceId,
          message: result.data.status.message,
        });
        settleOnTranscript(false);
        return;
      }

      // Persist BEFORE updating the in-memory dedup hash. If the disk write
      // fails we want the next tick to retry against the same transcript
      // instead of dedup'ing against a hash we never committed.
      try {
        const snapshot = await this.extensionMetadata.setSidebarStatus(
          workspaceId,
          result.data.status,
          // inputHash persists atomically with the status so a restarted
          // process can skip regenerating this exact input.
          { inputHash: dedupHash, skipIfRecencyAdvancedSince: observedRecency }
        );
        if (this.stopped) return;
        if (!snapshot) {
          // The recency check happens inside ExtensionMetadataService's
          // serialized mutation queue, immediately before the status write.
          // That makes it atomic with fire-and-forget user-recency writes:
          // a slow provider response cannot resurrect a pre-pivot status
          // after a newer user turn has queued or committed its recency bump.
          log.debug("AgentStatusService: dropping generated status after newer recency", {
            workspaceId,
            observedRecency,
          });
          return;
        }
        settleOnTranscript(true);
        this.workspaceService.emitWorkspaceActivity(workspaceId, snapshot);
      } catch (error) {
        log.error("AgentStatusService: failed to persist generated status", {
          workspaceId,
          error,
        });
      }
    } catch (error) {
      log.error("AgentStatusService: unexpected error during status generation", {
        workspaceId,
        error,
      });
    }
  }

  private ensureState(id: string): State {
    let state = this.tracked.get(id);
    if (!state) {
      state = {
        lastRanAt: 0,
        lastInputHash: null,
        persistedHashChecked: false,
        lastInputHashPersisted: false,
        lastSeenInputHash: null,
        lastObservedRecency: null,
        lastProviderFailureHash: null,
        providerFailureCount: 0,
        providerFailureRetryAfter: null,
        inFlight: false,
      };
      this.tracked.set(id, state);
    }
    return state;
  }

  /**
   * Build the trailing chat transcript, capped by message count and
   * AGENT_STATUS_MAX_TRANSCRIPT_TOKENS. Includes the in-flight partial
   * assistant message (HistoryService.readPartial) so the hash refreshes
   * mid-stream — exactly when "what is the agent doing now" matters most.
   */
  private async buildTrailingTranscript(workspaceId: string): Promise<string> {
    const result = await this.historyService.getLastMessages(
      workspaceId,
      AGENT_STATUS_MAX_TRAILING_MESSAGES
    );
    if (!result.success) return "";

    const committedMessages: MuxMessage[] = [...result.data];
    const partial = await this.historyService.readPartial(workspaceId);

    // Partial messages get an "(in progress)" role suffix so the model sees
    // they aren't finalized; committed messages render with their normal
    // role label. Doing this here keeps formatMessageForTranscript pure.
    const formattedParts = [
      ...committedMessages.map((m) => formatMessageForTranscript(m, { partial: false })),
      ...(partial ? [formatMessageForTranscript(partial, { partial: true })] : []),
    ];
    const formatted = formattedParts.filter((s) => s.length > 0);
    if (formatted.length === 0) return "";

    // Trim from the front (oldest) until we fit the token budget. Trailing
    // messages carry the most signal for "what is the agent doing right now",
    // so we never drop them. The tokenizer service falls back to a known
    // family for unknown models, so the fallback constant is safe regardless
    // of which model actually generates this workspace's status.
    const tokenCounts = await this.tokenizerService.countTokensBatch(
      FALLBACK_TOKENIZER_MODEL,
      formatted
    );

    let totalTokens = tokenCounts.reduce((sum, n) => sum + n, 0);
    let drop = 0;
    while (totalTokens > AGENT_STATUS_MAX_TRANSCRIPT_TOKENS && drop < formatted.length - 1) {
      totalTokens -= tokenCounts[drop];
      drop += 1;
    }
    return formatted.slice(drop).join("\n\n");
  }
}

function extractMessageText(message: MuxMessage): string {
  return (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function summarizeToolPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as { type?: unknown; toolName?: unknown; state?: unknown };
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return null;
  // Tool calls have type "tool-<name>" or "dynamic-tool" with a toolName.
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice(5)
        : null;
  if (!toolName) return null;
  // The lifecycle phase is the single highest-signal datum the status model
  // needs to distinguish "Deploying service" (in flight) from "Deployed
  // service" (finished). AI SDK v5 tool parts carry a `state` field:
  //   - "input-available"  → call sent, no result yet (running)
  //   - "output-available" → result returned (done)
  //   - "output-redacted"  → result returned but body stripped (still done)
  // Without this marker the prompt was forced to guess from prose alone.
  const state = typeof record.state === "string" ? record.state : null;
  const phase =
    state === "output-available" || state === "output-redacted"
      ? "done"
      : state === "input-available"
        ? "running"
        : null;
  return phase ? `[tool ${toolName} ${phase}]` : `[tool ${toolName}]`;
}

function formatMessageForTranscript(
  message: MuxMessage,
  opts: { partial: boolean } = { partial: false }
): string {
  const baseRole =
    message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : null;
  if (!baseRole) return "";

  // Mark the in-flight partial assistant message so the model treats it as
  // not-yet-finalized prose. Without this marker an assistant turn that has
  // streamed "Deploying service" but isn't done looked identical to a
  // committed turn that wrapped up with the same words — historically the
  // root cause of stale past-tense statuses during long streams.
  const role = opts.partial && baseRole === "Assistant" ? "Assistant (in progress)" : baseRole;

  const segments: string[] = [];
  const text = extractMessageText(message).slice(0, AGENT_STATUS_MAX_MESSAGE_CHARS);
  if (text) segments.push(text);

  // Tool-call summaries let the model see what the agent is doing even when
  // the assistant has not emitted natural-language text yet. Args/output are
  // intentionally omitted to keep cost predictable; the state-derived phase
  // marker (running/done) carries the in-progress-vs-completed signal.
  const tools = (message.parts ?? []).map(summarizeToolPart).filter((s): s is string => s !== null);
  if (tools.length > 0) segments.push(tools.join(" "));

  return segments.length === 0 ? "" : `${role}: ${segments.join("\n")}`;
}

/**
 * Stable hash of the transcript bytes alone. This is the input the
 * history-catch-up guard uses to detect "transcript unchanged since the
 * last look" so a freshly-bumped `observedRecency` can wait one tick for
 * the corresponding history write to land. Folding `streaming` in here
 * would make the common idle→streaming transition look like a transcript
 * change and bypass the guard.
 */
function computeTranscriptHash(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

/**
 * Codex review: the dedup hash is persisted across restarts, so unlike the
 * old process-local cache it is no longer naturally invalidated by upgrades.
 * Bump this when status-generation semantics change without changing
 * transcript bytes (prompt guidance, placeholder rules, tool-summary
 * interpretation) so persisted hashes from older builds miss once and
 * stale statuses regenerate predictably.
 */
const STATUS_GENERATION_VERSION = "G1";

/**
 * Dedup key for generation: combines the transcript hash with the
 * streaming bit, because `streaming` changes the prompt's tense guidance
 * (and therefore the generated status). Same transcript + different
 * streaming → must regenerate. Cheap: hashes a short prefix + the
 * already-computed transcript hash.
 */
function computeDedupHash(transcriptHash: string, streaming: boolean): string {
  return createHash("sha256")
    .update(STATUS_GENERATION_VERSION + "\n")
    .update(streaming ? "S1\n" : "S0\n")
    .update(transcriptHash)
    .digest("hex");
}

/**
 * Generic non-informative status messages. Even with the prompt steering
 * the model away from these, providers occasionally emit them (especially
 * when the transcript is short or paused). We reject them post-generation
 * rather than letting them reach the sidebar.
 *
 * Match is exact + case-insensitive on the trimmed message; we don't
 * substring-match because legitimate phrases like "Awaiting user reply"
 * contain "Awaiting" and shouldn't be filtered.
 */
const PLACEHOLDER_STATUS_MESSAGES: ReadonlySet<string> = new Set([
  "awaiting next task",
  "awaiting input",
  "doing work",
  "idle",
  "working",
  "no recent activity",
]);

function isPlaceholderStatus(message: string): boolean {
  return PLACEHOLDER_STATUS_MESSAGES.has(message.trim().toLowerCase());
}

function isRecentRecencyAheadOfHistory(
  state: State,
  inputHash: string,
  observedRecency: number | null,
  now: number,
  historyCatchupWindowMs: number
): boolean {
  return (
    hasRecencyAdvanced(state, observedRecency) &&
    (state.lastSeenInputHash === null || state.lastSeenInputHash === inputHash) &&
    observedRecency !== null &&
    now - observedRecency < historyCatchupWindowMs
  );
}

function resetProviderFailureTracking(state: State): void {
  state.lastProviderFailureHash = null;
  state.providerFailureCount = 0;
  state.providerFailureRetryAfter = null;
}

function recordProviderFailureAttempt(state: State, inputHash: string): number {
  if (state.lastProviderFailureHash !== inputHash) {
    state.lastProviderFailureHash = inputHash;
    state.providerFailureCount = 0;
    state.providerFailureRetryAfter = null;
  }
  state.providerFailureCount += 1;
  state.providerFailureRetryAfter = null;
  return state.providerFailureCount;
}

function hasProviderFailureRetryBudget(attempt: number): boolean {
  return attempt <= AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS;
}

function isWaitingForProviderFailureCooldown(
  state: State,
  inputHash: string,
  now: number
): boolean {
  return (
    state.lastProviderFailureHash === inputHash &&
    state.providerFailureRetryAfter !== null &&
    now < state.providerFailureRetryAfter
  );
}

function computeProviderFailureRetryDelayMs(attempt: number, streaming: boolean): number {
  const baseDelay = streaming
    ? AGENT_STATUS_PROVIDER_FAILURE_ACTIVE_COOLDOWN_MS
    : AGENT_STATUS_PROVIDER_FAILURE_IDLE_COOLDOWN_MS;
  const exhaustedAttempts = Math.max(0, attempt - AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS - 1);
  return Math.min(
    baseDelay * 2 ** exhaustedAttempts,
    AGENT_STATUS_PROVIDER_FAILURE_MAX_COOLDOWN_MS
  );
}

function hasRecencyAdvanced(state: State | undefined, recency: number | null): boolean {
  return (
    state !== undefined &&
    recency !== null &&
    (state.lastObservedRecency === null || recency > state.lastObservedRecency)
  );
}

function pickInterval(streaming: boolean, focused: boolean): number {
  if (streaming) {
    return focused
      ? AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS
      : AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS;
  }
  return focused ? AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS : AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS;
}
