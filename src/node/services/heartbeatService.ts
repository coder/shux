import { Duration, Effect, Exit, Schedule, Scope, type Fiber } from "effect";
import assert from "@/common/utils/assert";
import type { MuxMessage } from "@/common/types/message";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { WorkspaceActivitySnapshot, WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  isValidHeartbeatScheduleUpdatedAt,
  resolveHeartbeatSchedulePolicy,
  type HeartbeatTrigger,
} from "@/constants/heartbeat";
import type { Config } from "@/node/config";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { IdleDispatcher, type IdleDispatchPayload } from "./idleDispatcher";
import { log } from "./log";
import type { TaskService } from "./taskService";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "./timelineRecorder";
import type { WorkspaceService } from "./workspaceService";

export const STARTUP_DELAY_MS = 60 * 1000; // 60s - let startup settle
export const CHECK_INTERVAL_MS = 30 * 1000; // 30s tick
const MAX_CONCURRENT_HEARTBEATS = 1;
const HEARTBEAT_IDLE_CONSUMER_NAME = "heartbeat";
const HEARTBEAT_IDLE_CONSUMER_PRIORITY = 50;

interface HeartbeatEligibilityResult {
  eligible: boolean;
  reason?: string;
}

/**
 * Next deadline for a fixed-interval (trigger: "interval") heartbeat after a firing.
 *
 * Anchors at `firedAt` (not dispatch end) so dispatch duration never drifts the cadence:
 * nextDeadline = firedAt + k*intervalMs for the smallest k >= 1 with nextDeadline > now.
 * k > 1 only when the attempt ran longer than an interval — missed slots are never
 * burst-fired; the anchor simply advances so subsequent deadlines stay aligned.
 */
export function advanceAnchoredDeadline(firedAt: number, intervalMs: number, now: number): number {
  assert(
    Number.isFinite(firedAt) && Number.isFinite(now) && now >= firedAt,
    "advanceAnchoredDeadline requires finite timestamps with now >= firedAt"
  );
  assert(
    Number.isFinite(intervalMs) && intervalMs > 0,
    "advanceAnchoredDeadline requires a positive interval"
  );

  const intervalsElapsed = Math.floor((now - firedAt) / intervalMs);
  return firedAt + (intervalsElapsed + 1) * intervalMs;
}

export class HeartbeatService {
  private readonly config: Config;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly workspaceService: WorkspaceService;
  private readonly taskService: TaskService;
  private readonly idleDispatcher: IdleDispatcher;
  /**
   * Runs the lifecycle effects below (scope acquisition, scheduler fork, scope
   * close). Context-bound in the app (so the scheduler fiber reads the
   * runtime's `Clock` — a `TestClock` in tests); the global runtime by default.
   */
  private readonly runner: EffectRunner;

  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;

  // The scheduler runs as a single Effect fiber forked into `lifecycleScope`:
  // sleep(STARTUP_DELAY_MS), then tick immediately and every CHECK_INTERVAL_MS.
  // The legacy two-field shape is preserved because it is the observable
  // lifecycle contract (tests pin the null/non-null progression):
  // `startupTimeout` holds the fiber while the startup delay is pending and
  // `checkInterval` holds it once the periodic ticker is live.
  private startupTimeout: Fiber.Fiber<void> | null = null;
  private checkInterval: Fiber.Fiber<void> | null = null;
  /**
   * Owns every resource start() acquires — idle-consumer registration,
   * workspace event listeners, and the scheduler fiber. Closing it releases
   * them in reverse acquisition order (fiber interrupt, listeners off,
   * consumer dispose — the same order the hand-rolled stop() used) and is
   * guaranteed to run them even when a later startup step throws.
   */
  private lifecycleScope: Scope.Closeable | null = null;
  private stopped = true;

  private readonly nextEligibleAtByWorkspaceId = new Map<string, number>();
  private readonly trackedIntervalMsByWorkspaceId = new Map<string, number>();
  private readonly trackedTriggerByWorkspaceId = new Map<string, HeartbeatTrigger>();
  private readonly activeWorkspaceIds = new Set<string>();
  private readonly queuedWorkspaceIds = new Set<string>();
  private isProcessingQueue = false;
  private tickInFlight = false;
  private lifecycleVersion = 0;
  private heartbeatConsumerDisposer: (() => void) | null = null;

  private readonly onActivity: (event: {
    workspaceId: string;
    activity: WorkspaceActivitySnapshot | null;
  }) => void;
  private readonly onMetadata: (event: {
    workspaceId: string;
    metadata: WorkspaceMetadata | null;
  }) => void;

  constructor(
    config: Config,
    extensionMetadata: ExtensionMetadataService,
    workspaceService: WorkspaceService,
    taskService: TaskService,
    idleDispatcher?: IdleDispatcher,
    runner: EffectRunner = defaultEffectRunner
  ) {
    this.config = config;
    this.extensionMetadata = extensionMetadata;
    this.workspaceService = workspaceService;
    this.taskService = taskService;
    this.idleDispatcher = idleDispatcher ?? new IdleDispatcher();
    this.runner = runner;

    this.onActivity = (event) => this.handleActivityEvent(event);
    this.onMetadata = (event) => this.handleMetadataEvent(event);
  }

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  start(): void {
    assert(this.stopped, "HeartbeatService.start() called while already running");
    assert(
      this.heartbeatConsumerDisposer == null,
      "HeartbeatService.start() called with a registered idle consumer"
    );
    this.stopped = false;
    this.lifecycleVersion += 1;

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    const scope = Scope.makeUnsafe();
    this.lifecycleScope = scope;

    const scheduler = Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(STARTUP_DELAY_MS));
      // Defensive parity with the legacy setTimeout callback: interruption via
      // stop() already prevents this resumption, so a stopped service must
      // never transition into the ticking phase even if a wake-up raced it.
      if (self.stopped) {
        return;
      }

      // Startup delay elapsed: the same fiber now becomes the periodic ticker.
      self.checkInterval = self.startupTimeout;
      self.startupTimeout = null;
      // Effect.repeat runs the first tick immediately (matching the legacy
      // direct tick() call when the startup timer fired), then Schedule.fixed
      // reproduces setInterval cadence: wall-clock anchored, no burst catch-up.
      // tick() is synchronous fire-and-forget, so the body never delays a slot.
      yield* Effect.sync(() => self.tick()).pipe(
        Effect.repeat(Schedule.fixed(Duration.millis(CHECK_INTERVAL_MS)))
      );
    });

    const acquireResources = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          self.heartbeatConsumerDisposer = self.idleDispatcher.registerConsumer({
            name: HEARTBEAT_IDLE_CONSUMER_NAME,
            priority: HEARTBEAT_IDLE_CONSUMER_PRIORITY,
            buildPayload: (workspaceId) => self.buildHeartbeatDispatchPayload(workspaceId),
          });
        }),
        () =>
          Effect.sync(() => {
            self.heartbeatConsumerDisposer?.();
            self.heartbeatConsumerDisposer = null;
          })
      );
      // One acquireRelease per listener: a combined acquisition would install
      // its finalizer only after BOTH .on() calls succeed, so a throw from the
      // second registration (e.g. a `newListener` hook) would leak the first
      // listener across start() retries (Codex P2 on #4031).
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          self.workspaceService.on("activity", self.onActivity);
        }),
        () =>
          Effect.sync(() => {
            self.workspaceService.off("activity", self.onActivity);
          })
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          self.workspaceService.on("metadata", self.onMetadata);
        }),
        () =>
          Effect.sync(() => {
            self.workspaceService.off("metadata", self.onMetadata);
          })
      );
      self.startupTimeout = yield* Effect.forkIn(scheduler, scope);
    });

    try {
      // Runs synchronously: acquisitions are Effect.sync and forkIn executes
      // the scheduler up to its first sleep before returning, so the startup
      // timer is registered before start() returns (same observable ordering
      // as the previous setTimeout call).
      this.runner.runSync(Scope.provide(scope)(acquireResources));
    } catch (error) {
      // Guaranteed cleanup on partial startup failure: close the scope so the
      // finalizers registered before the failing step run (the hand-rolled
      // version leaked earlier acquisitions here), restore the stopped state
      // so a later start() retry is possible, then surface the error.
      this.lifecycleScope = null;
      this.startupTimeout = null;
      this.checkInterval = null;
      this.stopped = true;
      this.runner.runSync(Scope.close(scope, Exit.void));
      throw error;
    }

    log.info("HeartbeatService started", {
      startupDelayMs: STARTUP_DELAY_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
    });
  }

  stop(): void {
    this.stopped = true;
    this.lifecycleVersion += 1;

    // Captured before teardown for the shutdown log below.
    const schedulerPhase =
      this.checkInterval != null
        ? "ticking"
        : this.startupTimeout != null
          ? "startup_delay"
          : "not_started";

    if (this.lifecycleScope) {
      const scope = this.lifecycleScope;
      this.lifecycleScope = null;
      // Releases everything start() acquired, in reverse acquisition order:
      // scheduler fiber interrupt (synchronously clearing its pending timer),
      // listeners off, consumer disposer — completing synchronously because
      // the fiber only ever suspends on its clock timer.
      this.runner.runSync(Scope.close(scope, Exit.void));
    }
    this.startupTimeout = null;
    this.checkInterval = null;

    this.nextEligibleAtByWorkspaceId.clear();
    this.trackedIntervalMsByWorkspaceId.clear();
    this.trackedTriggerByWorkspaceId.clear();
    this.activeWorkspaceIds.clear();
    this.queuedWorkspaceIds.clear();
    this.isProcessingQueue = false;
    this.tickInFlight = false;

    log.info("HeartbeatService stopped", { schedulerPhase });
  }

  private tick(): void {
    if (this.stopped || this.tickInFlight) {
      return;
    }

    const now = Date.now();
    const lifecycleVersion = this.lifecycleVersion;
    this.tickInFlight = true;
    void this.runTick(now, lifecycleVersion);
  }

  private async runTick(now: number, lifecycleVersion: number): Promise<void> {
    assert(Number.isFinite(now), "HeartbeatService.runTick requires a finite timestamp");

    try {
      await this.resyncFromConfig(now, lifecycleVersion);
      if (this.stopped || this.lifecycleVersion !== lifecycleVersion) {
        return;
      }

      this.checkAllWorkspaces(now);
    } catch (error) {
      log.error("HeartbeatService tick failed", { error });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async resyncFromConfig(
    now: number,
    lifecycleVersion: number = this.lifecycleVersion
  ): Promise<void> {
    assert(Number.isFinite(now), "HeartbeatService.resyncFromConfig requires a finite timestamp");

    const activitySnapshots = await this.extensionMetadata.getAllSnapshots();
    if (this.lifecycleVersion !== lifecycleVersion) {
      return;
    }

    const config = this.config.loadConfigOrDefault();
    const configuredWorkspaceIds = new Set<string>();

    for (const [, projectConfig] of config.projects) {
      if (this.lifecycleVersion !== lifecycleVersion) {
        return;
      }

      for (const workspace of projectConfig.workspaces) {
        if (this.lifecycleVersion !== lifecycleVersion) {
          return;
        }

        const workspaceId = this.getWorkspaceId(workspace);
        if (!workspaceId) {
          continue;
        }

        configuredWorkspaceIds.add(workspaceId);
        const trackingIntervalMs = this.getTrackingIntervalMsForWorkspace(workspace, config);
        if (trackingIntervalMs != null) {
          const trigger = resolveHeartbeatSchedulePolicy(workspace.heartbeat).trigger;
          const nextEligibleAt = this.nextEligibleAtByWorkspaceId.has(workspaceId)
            ? now + trackingIntervalMs
            : trigger === "interval"
              ? await this.deriveInitialIntervalNextEligibleAt(
                  now,
                  workspaceId,
                  trackingIntervalMs,
                  activitySnapshots.get(workspaceId),
                  workspace.heartbeat?.scheduleUpdatedAt
                )
              : this.deriveInitialNextEligibleAt(
                  now,
                  workspaceId,
                  trackingIntervalMs,
                  activitySnapshots.get(workspaceId)
                );
          // Re-check after the potential await above: a stop()/restart mid-derivation
          // must not re-track a stale entry.
          if (this.lifecycleVersion !== lifecycleVersion) {
            return;
          }
          this.ensureTrackedWorkspace(workspaceId, nextEligibleAt, trackingIntervalMs, trigger);
          continue;
        }

        this.purgeWorkspace(workspaceId, "config_resync_ineligible");
      }
    }

    for (const workspaceId of this.getTrackedWorkspaceIds()) {
      if (this.lifecycleVersion !== lifecycleVersion) {
        return;
      }
      if (!configuredWorkspaceIds.has(workspaceId)) {
        this.purgeWorkspace(workspaceId, "config_resync_missing");
      }
    }
  }

  /**
   * Initial deadline for fixed-interval schedules after a restart/resync-add.
   *
   * Fixed schedules are activity-independent, so re-anchoring them to activity recency
   * would let a user interaction just before a restart push the next firing out (an edit
   * at 10:25 must not move a 10:30 firing to 10:55). The last firing is already persisted
   * as the heartbeat-request user message in chat history — anchor there: in-window
   * schedules keep their cadence and overdue ones fire once immediately (max with now,
   * never a burst). A firing that predates the last cadence-affecting settings edit
   * (scheduleUpdatedAt) loses to the edit: the live path re-anchored the fixed cadence at
   * the edit, so an idle-era or old-interval firing must not pull the restart deadline
   * earlier. Workspaces with no recorded firing (never fired, or the record was compacted
   * away) fall back to the activity-recency approximation used by idle triggers, which is
   * never earlier than the edit anchor because setHeartbeatSettings persists that recency.
   */
  private async deriveInitialIntervalNextEligibleAt(
    now: number,
    workspaceId: string,
    trackingIntervalMs: number,
    activity: WorkspaceActivitySnapshot | undefined,
    scheduleUpdatedAt: number | null | undefined
  ): Promise<number> {
    assert(
      Number.isFinite(now),
      "HeartbeatService.deriveInitialIntervalNextEligibleAt requires a finite timestamp"
    );

    // Future timestamps (clock skew) are ignored the same way skewed firing records are.
    const editAnchor =
      isValidHeartbeatScheduleUpdatedAt(scheduleUpdatedAt) && scheduleUpdatedAt <= now
        ? scheduleUpdatedAt
        : undefined;

    try {
      const history = await this.workspaceService.getChatHistory(workspaceId);
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const message = history[i];
        if (message?.role !== "user") {
          continue;
        }
        const metadata = message.metadata;
        const muxMetadata = metadata?.muxMetadata;
        if (metadata == null || muxMetadata?.type !== "heartbeat-request") {
          continue;
        }

        // Queue-mode busy deliveries write the history row only after the running turn
        // finishes, so the row timestamp can be minutes after the slot fired — anchoring
        // there would drift the fixed cadence across restarts. Prefer the persisted fire
        // time (matching the live advanceAnchoredDeadline anchor); rows without it
        // (pre-firedAt records) fall back to the row timestamp.
        const persistedFiredAt = muxMetadata.firedAt;
        const firedAt =
          typeof persistedFiredAt === "number" &&
          Number.isFinite(persistedFiredAt) &&
          persistedFiredAt <= now
            ? persistedFiredAt
            : metadata.timestamp;
        // Newest firing record wins; an unusable timestamp (missing/overflowed/future
        // clock skew) falls through to the recency fallback rather than scanning older,
        // even staler records.
        if (typeof firedAt !== "number" || !Number.isFinite(firedAt) || firedAt > now) {
          break;
        }
        const anchor = editAnchor != null ? Math.max(firedAt, editAnchor) : firedAt;
        return Math.max(anchor + trackingIntervalMs, now);
      }
    } catch (error) {
      log.warn("HeartbeatService: failed to derive interval anchor from history", {
        workspaceId,
        error,
      });
    }

    return this.deriveInitialNextEligibleAt(now, workspaceId, trackingIntervalMs, activity);
  }

  private deriveInitialNextEligibleAt(
    now: number,
    workspaceId: string,
    trackingIntervalMs: number,
    activity: WorkspaceActivitySnapshot | undefined
  ): number {
    assert(
      Number.isFinite(now),
      "HeartbeatService.deriveInitialNextEligibleAt requires a finite timestamp"
    );
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.deriveInitialNextEligibleAt requires a workspaceId"
    );
    assert(
      this.isValidTrackingIntervalMs(trackingIntervalMs),
      "HeartbeatService.deriveInitialNextEligibleAt requires an interval within supported bounds"
    );

    const fallbackDeadline = now + trackingIntervalMs;
    if (!activity || activity.streaming) {
      return fallbackDeadline;
    }

    const { recency } = activity;
    if (!Number.isFinite(recency) || recency < 0 || recency > now) {
      log.warn("HeartbeatService: ignoring invalid persisted activity recency", {
        workspaceId,
        recency,
        trackingIntervalMs,
        now,
      });
      return fallbackDeadline;
    }

    const derivedNextEligibleAt = recency + trackingIntervalMs;
    if (!Number.isFinite(derivedNextEligibleAt)) {
      log.warn("HeartbeatService: ignoring overflowed persisted activity deadline", {
        workspaceId,
        recency,
        trackingIntervalMs,
      });
      return fallbackDeadline;
    }

    return Math.max(derivedNextEligibleAt, now);
  }

  private ensureTrackedWorkspace(
    workspaceId: string,
    nextEligibleAt: number,
    trackingIntervalMs: number,
    trigger: HeartbeatTrigger
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.ensureTrackedWorkspace requires a workspaceId"
    );
    assert(
      Number.isFinite(nextEligibleAt),
      "HeartbeatService.ensureTrackedWorkspace requires a finite deadline"
    );
    assert(
      this.isValidTrackingIntervalMs(trackingIntervalMs),
      "HeartbeatService.ensureTrackedWorkspace requires an interval within supported bounds"
    );

    const previousNextEligibleAt = this.nextEligibleAtByWorkspaceId.get(workspaceId);
    const previousIntervalMs = this.trackedIntervalMsByWorkspaceId.get(workspaceId);
    const previousTrigger = this.trackedTriggerByWorkspaceId.get(workspaceId);
    // A trigger change must refresh the deadline even when intervalMs is unchanged:
    // an idle→interval edit re-anchors the fixed cadence at the edit (instead of
    // inheriting the stale idle countdown), and interval→idle starts a fresh
    // time-since-activity countdown.
    if (
      previousNextEligibleAt != null &&
      previousIntervalMs === trackingIntervalMs &&
      previousTrigger === trigger
    ) {
      return;
    }

    this.nextEligibleAtByWorkspaceId.set(workspaceId, nextEligibleAt);
    this.trackedIntervalMsByWorkspaceId.set(workspaceId, trackingIntervalMs);
    this.trackedTriggerByWorkspaceId.set(workspaceId, trigger);
    log.debug(
      previousNextEligibleAt == null
        ? "HeartbeatService: tracking workspace"
        : "HeartbeatService: updated tracked workspace deadline",
      {
        workspaceId,
        previousNextEligibleAt,
        previousIntervalMs,
        previousTrigger,
        nextEligibleAt,
        trackingIntervalMs,
        trigger,
      }
    );
  }

  private purgeWorkspace(workspaceId: string, reason: string): void {
    assert(workspaceId.trim().length > 0, "HeartbeatService.purgeWorkspace requires a workspaceId");
    assert(reason.trim().length > 0, "HeartbeatService.purgeWorkspace requires a reason");

    const removedDeadline = this.nextEligibleAtByWorkspaceId.delete(workspaceId);
    const removedInterval = this.trackedIntervalMsByWorkspaceId.delete(workspaceId);
    this.trackedTriggerByWorkspaceId.delete(workspaceId);
    const removedActive = this.activeWorkspaceIds.delete(workspaceId);
    const removedQueued = this.queuedWorkspaceIds.delete(workspaceId);
    if (!removedDeadline && !removedInterval && !removedActive && !removedQueued) {
      return;
    }

    log.debug("HeartbeatService: purged workspace", {
      workspaceId,
      reason,
      removedDeadline,
      removedInterval,
      removedActive,
      removedQueued,
    });
  }

  private handleActivityEvent(event: {
    workspaceId: string;
    activity: WorkspaceActivitySnapshot | null;
  }): void {
    if (this.stopped) {
      return;
    }

    const { workspaceId, activity } = event;
    if (!activity || activity.streaming) {
      return;
    }
    if (!this.nextEligibleAtByWorkspaceId.has(workspaceId)) {
      return;
    }

    const config = this.config.loadConfigOrDefault();
    const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
    const intervalMs =
      workspace?.heartbeat?.enabled === true
        ? this.getSanitizedTrackingIntervalMs(
            workspaceId,
            workspace.heartbeat.intervalMs,
            config,
            "heartbeat_lookup"
          )
        : null;
    if (intervalMs == null) {
      this.purgeWorkspace(workspaceId, "activity_event_ineligible");
      return;
    }

    // Fixed-interval heartbeats measure wall-clock cadence, not time-since-activity:
    // activity must not push back the deadline.
    const trigger = resolveHeartbeatSchedulePolicy(workspace?.heartbeat).trigger;
    if (trigger === "interval") {
      return;
    }

    this.nextEligibleAtByWorkspaceId.set(workspaceId, Date.now() + intervalMs);
    this.trackedIntervalMsByWorkspaceId.set(workspaceId, intervalMs);
    this.trackedTriggerByWorkspaceId.set(workspaceId, trigger);
    log.debug("HeartbeatService: activity event reset countdown", { workspaceId, intervalMs });
  }

  private handleMetadataEvent(event: {
    workspaceId: string;
    metadata: WorkspaceMetadata | null;
  }): void {
    if (this.stopped) {
      return;
    }

    const { workspaceId, metadata } = event;
    if (!metadata) {
      this.purgeWorkspace(workspaceId, "workspace_deleted");
      return;
    }
    if (metadata.parentWorkspaceId != null) {
      this.purgeWorkspace(workspaceId, "child_workspace");
      return;
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      this.purgeWorkspace(workspaceId, "archived");
      return;
    }

    if (metadata.heartbeat?.enabled) {
      const config = this.config.loadConfigOrDefault();
      const intervalMs = this.getSanitizedTrackingIntervalMs(
        workspaceId,
        metadata.heartbeat.intervalMs,
        config,
        "metadata_event"
      );
      if (intervalMs == null) {
        this.purgeWorkspace(workspaceId, "heartbeat_invalid_interval");
        return;
      }

      this.ensureTrackedWorkspace(
        workspaceId,
        Date.now() + intervalMs,
        intervalMs,
        resolveHeartbeatSchedulePolicy(metadata.heartbeat).trigger
      );
      return;
    }

    this.purgeWorkspace(workspaceId, "heartbeat_disabled");
  }

  private checkAllWorkspaces(now: number): void {
    assert(Number.isFinite(now), "HeartbeatService.checkAllWorkspaces requires a finite timestamp");

    for (const [workspaceId, nextEligibleAt] of this.nextEligibleAtByWorkspaceId) {
      if (now < nextEligibleAt) {
        continue;
      }
      if (this.activeWorkspaceIds.has(workspaceId) || this.queuedWorkspaceIds.has(workspaceId)) {
        continue;
      }

      this.queueWorkspace(workspaceId);
    }
  }

  private queueWorkspace(workspaceId: string): void {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService: queueWorkspace requires a workspaceId"
    );

    if (this.queuedWorkspaceIds.has(workspaceId) || this.activeWorkspaceIds.has(workspaceId)) {
      log.debug("HeartbeatService: skipping duplicate queue entry", { workspaceId });
      return;
    }

    this.queuedWorkspaceIds.add(workspaceId);
    log.info("HeartbeatService: queued heartbeat", {
      workspaceId,
      queueSize: this.queuedWorkspaceIds.size,
    });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.stopped) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.queuedWorkspaceIds.size > 0) {
        if (this.stopped) {
          return;
        }

        assert(
          this.activeWorkspaceIds.size <= MAX_CONCURRENT_HEARTBEATS,
          "HeartbeatService: active heartbeat count exceeded concurrency cap"
        );
        if (this.activeWorkspaceIds.size >= MAX_CONCURRENT_HEARTBEATS) {
          return;
        }

        const workspaceId = this.queuedWorkspaceIds.values().next().value;
        if (typeof workspaceId !== "string") {
          break;
        }

        this.queuedWorkspaceIds.delete(workspaceId);
        this.activeWorkspaceIds.add(workspaceId);

        // Capture the fire time before dispatching so fixed-interval cadences exclude
        // dispatch duration (see advanceAnchoredDeadline).
        const firedAt = Date.now();
        try {
          await this.idleDispatcher.requestDispatch(workspaceId, HEARTBEAT_IDLE_CONSUMER_NAME);
        } catch (error) {
          log.error("HeartbeatService: heartbeat dispatch request failed", { workspaceId, error });
        } finally {
          this.activeWorkspaceIds.delete(workspaceId);
          if (!this.stopped) {
            const config = this.config.loadConfigOrDefault();
            const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
            const trackingIntervalMs = workspace
              ? this.getTrackingIntervalMsForWorkspace(workspace, config)
              : null;
            if (trackingIntervalMs != null) {
              // Every attempt (success, eligibility skip, or error) consumes its slot.
              // Fixed-interval triggers stay anchored to the fire time; idle triggers
              // keep today's fresh countdown from dispatch end.
              const trigger = resolveHeartbeatSchedulePolicy(workspace?.heartbeat).trigger;
              const nextEligibleAt =
                trigger === "interval"
                  ? advanceAnchoredDeadline(firedAt, trackingIntervalMs, Date.now())
                  : Date.now() + trackingIntervalMs;
              this.nextEligibleAtByWorkspaceId.set(workspaceId, nextEligibleAt);
              this.trackedIntervalMsByWorkspaceId.set(workspaceId, trackingIntervalMs);
              this.trackedTriggerByWorkspaceId.set(workspaceId, trigger);
            } else {
              this.purgeWorkspace(workspaceId, "post_dispatch_ineligible");
            }
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
      if (!this.stopped && this.queuedWorkspaceIds.size > 0) {
        void this.processQueue();
      }
    }
  }

  private async buildHeartbeatDispatchPayload(
    workspaceId: string
  ): Promise<IdleDispatchPayload | null> {
    const eligibility = await this.checkEligibility(workspaceId, Date.now());
    if (!eligibility.eligible) {
      log.info("HeartbeatService: skipped queued heartbeat (ineligible)", {
        workspaceId,
        reason: eligibility.reason,
      });
      this.timelineRecorder.record(workspaceId, {
        kind: "heartbeat.skipped",
        source: { system: "heartbeat" },
        status: "skipped",
        data: { reason: eligibility.reason },
      });
      return null;
    }

    return {
      dispatch: async () => {
        log.info("HeartbeatService: executing heartbeat", { workspaceId });
        this.timelineRecorder.record(workspaceId, {
          kind: "heartbeat.dispatched",
          source: { system: "heartbeat" },
          status: "started",
        });
        await this.workspaceService.executeHeartbeat(workspaceId);
      },
    };
  }

  async checkEligibility(workspaceId: string, now: number): Promise<HeartbeatEligibilityResult> {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.checkEligibility requires a workspaceId"
    );
    assert(Number.isFinite(now), "HeartbeatService.checkEligibility requires a finite timestamp");

    const config = this.config.loadConfigOrDefault();
    const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
    if (!workspace) {
      return { eligible: false, reason: "workspace_not_found" };
    }
    if (workspace.heartbeat?.enabled !== true) {
      return { eligible: false, reason: "heartbeat_disabled" };
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      return { eligible: false, reason: "archived" };
    }
    if (workspace.parentWorkspaceId != null) {
      return { eligible: false, reason: "child_workspace" };
    }

    // Busy-related gates depend on the whenBusy policy: "skip" (the idle-trigger default)
    // misses the slot exactly as before, while queue modes pass through so executeHeartbeat
    // can deliver — enqueued at the requested boundary while streaming, or dispatched
    // immediately when only descendant tasks are active (the session itself is idle then).
    const deliverWhenBusy = resolveHeartbeatSchedulePolicy(workspace.heartbeat).whenBusy !== "skip";

    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    const isStreaming = activity?.streaming === true;
    if (isStreaming && !deliverWhenBusy) {
      return { eligible: false, reason: "currently_streaming" };
    }
    if (
      this.taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId) &&
      !deliverWhenBusy
    ) {
      return { eligible: false, reason: "active_descendant_tasks" };
    }

    const history = await this.workspaceService.getChatHistory(workspaceId);
    // Defensive even under queue modes: a fresh workspace that never completed a turn
    // should not receive scheduled maintenance messages.
    if (history.length === 0 || !history.some((message) => message.role === "assistant")) {
      return { eligible: false, reason: "no_completed_turn" };
    }

    const lastMessage = history[history.length - 1];
    // An idle unanswered user message stays a hard gate for every whenBusy policy: injecting a
    // scheduled message into that abnormal state risks clobbering a failed/interrupted user
    // turn. During an active stream, however, the in-progress assistant output lives only in
    // partial.json (committed history still ends with the user message being answered), so
    // queue modes must carve out the streaming case or they could never deliver while busy.
    // The live session busy state counts too: between user-message acceptance and
    // stream-start (turn preparation) the activity snapshot's streaming flag is still false,
    // yet the trailing user message is actively being answered — queue modes must queue that
    // slot, not consume it as awaiting_response. Skip mode keeps the pre-existing gate.
    const activelyAnswering =
      isStreaming || (deliverWhenBusy && this.workspaceService.isBusyForMessage(workspaceId));
    if (lastMessage?.role === "user" && !activelyAnswering) {
      return { eligible: false, reason: "awaiting_response" };
    }
    // Inert while streaming (committed history cannot end with an assistant message then), so
    // this only guards the idle waiting-for-input state — keep it hard for every policy.
    if (lastMessage?.role === "assistant" && this.hasInteractiveToolInput(lastMessage)) {
      return { eligible: false, reason: "awaiting_interactive_input" };
    }

    return { eligible: true };
  }

  private getTrackedWorkspaceIds(): string[] {
    return Array.from(
      new Set([
        ...this.nextEligibleAtByWorkspaceId.keys(),
        ...this.activeWorkspaceIds,
        ...this.queuedWorkspaceIds,
      ])
    );
  }

  private getTrackingIntervalMsForWorkspace(
    workspace: Workspace,
    config: ProjectsConfig
  ): number | null {
    if (workspace.heartbeat?.enabled !== true) {
      return null;
    }
    if (workspace.parentWorkspaceId != null) {
      return null;
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      return null;
    }

    const workspaceId = this.getWorkspaceId(workspace);
    if (!workspaceId) {
      return null;
    }

    return this.getSanitizedTrackingIntervalMs(
      workspaceId,
      workspace.heartbeat.intervalMs,
      config,
      "config_resync"
    );
  }

  private getSanitizedTrackingIntervalMs(
    workspaceId: string,
    rawIntervalMs: number | undefined,
    config: ProjectsConfig,
    source: "config_resync" | "heartbeat_lookup" | "metadata_event"
  ): number | null {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.getSanitizedTrackingIntervalMs requires a workspaceId"
    );

    const intervalMs =
      rawIntervalMs ?? config.heartbeatDefaultIntervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS;
    if (this.isValidTrackingIntervalMs(intervalMs)) {
      return intervalMs;
    }

    log.warn("HeartbeatService: ignoring invalid persisted heartbeat interval", {
      workspaceId,
      rawIntervalMs,
      intervalMs,
      source,
      minIntervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      maxIntervalMs: HEARTBEAT_MAX_INTERVAL_MS,
    });
    return null;
  }

  private isValidTrackingIntervalMs(intervalMs: number): boolean {
    return (
      Number.isFinite(intervalMs) &&
      intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
      intervalMs <= HEARTBEAT_MAX_INTERVAL_MS
    );
  }

  private findWorkspaceConfigEntry(workspaceId: string, config: ProjectsConfig): Workspace | null {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.findWorkspaceConfigEntry requires a workspaceId"
    );

    for (const [, projectConfig] of config.projects) {
      for (const workspace of projectConfig.workspaces) {
        if (this.getWorkspaceId(workspace) === workspaceId) {
          return workspace;
        }
      }
    }

    return null;
  }

  private getWorkspaceId(workspace: Pick<Workspace, "id" | "name">): string | null {
    const rawWorkspaceId = workspace.id ?? workspace.name;
    if (typeof rawWorkspaceId !== "string") {
      return null;
    }

    const workspaceId = rawWorkspaceId.trim();
    return workspaceId.length > 0 ? workspaceId : null;
  }

  private hasInteractiveToolInput(message: MuxMessage): boolean {
    if (!Array.isArray(message.parts)) {
      return false;
    }

    return message.parts.some((part: unknown) => {
      if (typeof part !== "object" || part === null || !("type" in part) || !("state" in part)) {
        return false;
      }

      const partType = (part as { type: unknown }).type;
      const partState = (part as { state: unknown }).state;
      return (
        (partType === "dynamic-tool" || partType === "tool-invocation") &&
        partState === "input-available"
      );
    });
  }
}
