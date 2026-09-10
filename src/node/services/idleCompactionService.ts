import { Duration, Effect, Exit, Schedule, Scope } from "effect";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { computeRecencyFromMessages } from "@/common/utils/recency";
import { log } from "./log";

export const INITIAL_CHECK_DELAY_MS = 60 * 1000; // 1 minute - let startup initialization settle
export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HOURS_TO_MS = 60 * 60 * 1000;

/**
 * Stop attempting idle compaction for a workspace once it has failed this many
 * times in a row. The hourly loop would otherwise re-queue a persistently
 * failing workspace forever (a failed compaction neither marks the workspace
 * `compacted` nor refreshes recency, so it stays eligible).
 */
const MAX_CONSECUTIVE_IDLE_COMPACTION_FAILURES = 2;

interface QueuedIdleCompaction {
  workspaceId: string;
  thresholdMs: number;
}

/**
 * Terminal outcome of an idle compaction attempt, reported back to the service
 * so it can decide whether to keep attempting compaction for a workspace.
 *
 * `modelNotFound` is treated as non-recoverable: the configured compaction model
 * does not exist / is not available, and retrying will keep failing the same way,
 * so we stop after a single occurrence rather than waiting for two failures.
 */
export type IdleCompactionOutcome = { success: true } | { success: false; modelNotFound: boolean };

/**
 * IdleCompactionService monitors workspaces for idle time and executes
 * compaction directly through a backend callback.
 *
 * Compactions are globally serialized to avoid thundering herd behavior when
 * one check cycle finds many idle workspaces at once.
 */
export class IdleCompactionService {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly executeIdleCompaction: (workspaceId: string) => Promise<void>;
  /**
   * Runs the checker fork and the scope close. Context-bound in the app (the
   * checker reads the runtime's `Clock` — a `TestClock` in tests); the global
   * runtime by default.
   */
  private readonly runner: EffectRunner;
  /**
   * Owns the checker fiber forked by start(): sleep(INITIAL_CHECK_DELAY_MS),
   * then check immediately and every CHECK_INTERVAL_MS. Closing the scope in
   * stop() interrupts the fiber, synchronously clearing its pending timer.
   */
  private lifecycleScope: Scope.Closeable | null = null;
  private readonly queue: QueuedIdleCompaction[] = [];
  private readonly queuedWorkspaceIds = new Set<string>();
  private readonly activeWorkspaceIds = new Set<string>();
  private isProcessingQueue = false;
  private stopped = false;
  // Per-workspace count of consecutive failed idle compactions (reset on success).
  private readonly consecutiveFailures = new Map<string, number>();
  // Workspaces for which the idle compaction loop has been stopped after repeated
  // (or non-recoverable) failures. Sticky for the service lifetime; cleared on restart.
  private readonly suppressedWorkspaceIds = new Set<string>();

  constructor(
    config: Config,
    historyService: HistoryService,
    extensionMetadata: ExtensionMetadataService,
    executeIdleCompaction: (workspaceId: string) => Promise<void>,
    runner: EffectRunner = defaultEffectRunner
  ) {
    this.config = config;
    this.historyService = historyService;
    this.extensionMetadata = extensionMetadata;
    this.executeIdleCompaction = executeIdleCompaction;
    this.runner = runner;
  }

  /**
   * Start the idle compaction checker.
   * First check after 1 minute, then every hour.
   */
  start(): void {
    this.stopped = false;

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    const scope = Scope.makeUnsafe();
    this.lifecycleScope = scope;

    const checker = Effect.gen(function* () {
      // First check after delay to let startup settle.
      yield* Effect.sleep(Duration.millis(INITIAL_CHECK_DELAY_MS));
      // Effect.repeat runs the first check immediately (matching the legacy
      // direct call when the initial timer fired), then Schedule.fixed
      // reproduces setInterval cadence. The check stays fire-and-forget so a
      // slow sweep never delays the next cadence slot (same as setInterval).
      yield* Effect.sync(() => {
        void self.checkAllWorkspaces();
      }).pipe(Effect.repeat(Schedule.fixed(Duration.millis(CHECK_INTERVAL_MS))));
    });
    // Runs synchronously up to the checker's first sleep, so the initial-delay
    // timer is registered before start() returns (same as the previous
    // setTimeout call).
    this.runner.runSync(Effect.forkIn(checker, scope));

    log.info("IdleCompactionService started", {
      initialDelayMs: INITIAL_CHECK_DELAY_MS,
      intervalMs: CHECK_INTERVAL_MS,
    });
  }

  /**
   * Stop the idle compaction checker.
   */
  stop(): void {
    this.stopped = true;

    if (this.lifecycleScope) {
      const scope = this.lifecycleScope;
      this.lifecycleScope = null;
      // Interrupts the checker fiber, synchronously clearing its pending
      // timer — the fiber only ever suspends on its clock timer.
      this.runner.runSync(Scope.close(scope, Exit.void));
    }

    // Best-effort queue reset: do not start new compactions after stop().
    this.queue.length = 0;
    this.queuedWorkspaceIds.clear();

    log.info("IdleCompactionService stopped");
  }

  /**
   * Check all workspaces across all projects for idle compaction eligibility.
   */
  async checkAllWorkspaces(): Promise<void> {
    const projectsConfig = this.config.loadConfigOrDefault();
    const now = Date.now();

    for (const [projectPath, projectConfig] of projectsConfig.projects) {
      const idleHours = projectConfig.idleCompactionHours;
      if (idleHours == null || idleHours < 1) continue;

      const thresholdMs = idleHours * HOURS_TO_MS;

      for (const workspace of projectConfig.workspaces) {
        const workspaceId = workspace.id ?? workspace.name;
        if (!workspaceId) continue;

        try {
          await this.checkWorkspace(workspaceId, projectPath, thresholdMs, now);
        } catch (error) {
          log.error("Idle compaction check failed", { workspaceId, error });
        }
      }
    }
  }

  private async checkWorkspace(
    workspaceId: string,
    _projectPath: string,
    thresholdMs: number,
    now: number
  ): Promise<void> {
    // Check eligibility.
    const eligibility = await this.checkEligibility(workspaceId, thresholdMs, now);
    if (!eligibility.eligible) {
      log.debug("Workspace not eligible for idle compaction", {
        workspaceId,
        reason: eligibility.reason,
      });
      return;
    }

    this.enqueueCompaction(workspaceId, thresholdMs);
  }

  private enqueueCompaction(workspaceId: string, thresholdMs: number): void {
    assert(workspaceId.trim().length > 0, "Idle compaction queue requires a workspaceId");
    assert(thresholdMs > 0, "Idle compaction queue requires a positive threshold");

    if (this.queuedWorkspaceIds.has(workspaceId) || this.activeWorkspaceIds.has(workspaceId)) {
      log.debug("Skipping duplicate idle compaction queue entry", {
        workspaceId,
      });
      return;
    }

    this.queue.push({ workspaceId, thresholdMs });
    this.queuedWorkspaceIds.add(workspaceId);

    log.info("Queued idle compaction", {
      workspaceId,
      queueLength: this.queue.length,
      idleHours: thresholdMs / HOURS_TO_MS,
    });

    // Fire and forget: processing is serialized internally.
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.stopped) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.queue.length > 0) {
        if (this.stopped) {
          return;
        }

        const next = this.queue.shift();
        if (!next) {
          continue;
        }

        const { workspaceId, thresholdMs } = next;
        this.queuedWorkspaceIds.delete(workspaceId);
        this.activeWorkspaceIds.add(workspaceId);

        try {
          // Re-check eligibility right before execution to avoid stale queue decisions.
          const eligibility = await this.checkEligibility(workspaceId, thresholdMs, Date.now());
          if (!eligibility.eligible) {
            log.info("Skipped queued idle compaction because workspace became ineligible", {
              workspaceId,
              reason: eligibility.reason,
            });
            continue;
          }

          log.info("Executing idle compaction", {
            workspaceId,
            idleHours: thresholdMs / HOURS_TO_MS,
            remainingQueued: this.queue.length,
          });

          await this.executeIdleCompaction(workspaceId);
        } catch (error) {
          log.error("Idle compaction execution failed", { workspaceId, error });
        } finally {
          this.activeWorkspaceIds.delete(workspaceId);
        }
      }
    } finally {
      this.isProcessingQueue = false;

      // If work arrived after we exited the loop and service is still running,
      // kick processing again.
      if (!this.stopped && this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }

  /**
   * Check if a workspace is eligible for idle compaction.
   */
  async checkEligibility(
    workspaceId: string,
    thresholdMs: number,
    now: number
  ): Promise<{ eligible: boolean; reason?: string }> {
    // 0. Has the loop been stopped for this workspace after repeated/non-recoverable
    // failures? Skip before touching history so a failing workspace stops re-queuing.
    if (this.suppressedWorkspaceIds.has(workspaceId)) {
      return { eligible: false, reason: "suppressed_after_failures" };
    }

    // 1. Has messages? Only need tail messages — recency + last-message checks don't need full history.
    const historyResult = await this.historyService.getLastMessages(workspaceId, 50);
    if (!historyResult.success || historyResult.data.length === 0) {
      return { eligible: false, reason: "no_messages" };
    }
    const messages = historyResult.data;

    // 2. Check recency from messages (single source of truth).
    const recency = computeRecencyFromMessages(messages);
    if (recency === null) {
      return { eligible: false, reason: "no_recency_data" };
    }
    const idleMs = now - recency;
    if (idleMs < thresholdMs) {
      return { eligible: false, reason: "not_idle_enough" };
    }

    // 3. Currently streaming?
    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    if (activity?.streaming) {
      return { eligible: false, reason: "currently_streaming" };
    }

    // 4. Already compacted? (last message is compacted summary)
    const lastMessage = messages[messages.length - 1];
    // Support both new enum ("user"|"idle") and legacy boolean (true)
    if (lastMessage?.metadata?.compacted) {
      return { eligible: false, reason: "already_compacted" };
    }

    // 5. Last message is user message with no response? (incomplete conversation)
    if (lastMessage?.role === "user") {
      return { eligible: false, reason: "awaiting_response" };
    }

    return { eligible: true };
  }

  /**
   * Record the terminal outcome of an idle compaction attempt so the loop can
   * stop re-attempting a persistently failing workspace.
   *
   * - Success resets the failure count AND lifts any suppression — a compaction that
   *   actually persisted means the workspace is healthy again (self-healing). This also
   *   covers an in-flight retry that succeeds after suppression was set.
   * - A `model_not_found` failure is non-recoverable, so the loop stops immediately.
   * - Any other failure stops the loop once it happens twice in a row.
   *
   * Suppression is in-memory (also cleared on restart, e.g. after fixing the model config).
   */
  recordOutcome(workspaceId: string, outcome: IdleCompactionOutcome): void {
    if (outcome.success) {
      this.consecutiveFailures.delete(workspaceId);
      this.suppressedWorkspaceIds.delete(workspaceId);
      return;
    }

    const failures = (this.consecutiveFailures.get(workspaceId) ?? 0) + 1;
    this.consecutiveFailures.set(workspaceId, failures);

    if (outcome.modelNotFound || failures >= MAX_CONSECUTIVE_IDLE_COMPACTION_FAILURES) {
      this.suppressedWorkspaceIds.add(workspaceId);
      this.consecutiveFailures.delete(workspaceId);
      log.warn("Stopping idle compaction for workspace after failure", {
        workspaceId,
        reason: outcome.modelNotFound ? "model_not_found" : "consecutive_failures",
        failures,
      });
    }
  }
}
