import type { ClaudeDesignExperimentSnapshot } from "@/common/orpc/schemas/claudeDesign";
import type {
  FrontendWorkspaceMetadataSchemaType,
  OnChatMode,
  UpdateStatus,
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  WorkspaceStatsSnapshot,
} from "@/common/orpc/types";
import type {
  MemoryChangeEventPayload,
  MemoryConsolidationStatusChangeEventPayload,
} from "@/common/orpc/schemas/memory";
import type { SshPromptEvent, SshPromptRequest } from "@/common/orpc/schemas/ssh";
import type { TimelineSubscriptionEvent } from "@/common/orpc/schemas/timeline";
import type { DevToolsEvent } from "@/common/types/devtools";
import { createCoalescedReader } from "@/common/utils/coalescedReader";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "./context";
import { subscriptionIterable, type SubscriptionStreamOptions } from "./streamBridge";
import { createReplayBufferedStreamMessageRelay } from "@/node/services/replayBufferedStreamMessageRelay";
import { TIMELINE_DEFAULT_PAGE_LIMIT } from "@/node/services/timelineService";
import type { LogEntry } from "@/node/services/logBuffer";
import { subscribeLogFeed } from "@/node/services/logBuffer";
import {
  resolveMemoryProjectIdentity,
  type MemoryChangeEvent,
} from "@/node/services/memoryService";

type LogSubscriptionEvent =
  | { type: "snapshot"; epoch: number; entries: LogEntry[] }
  | { type: "append"; epoch: number; entries: LogEntry[] }
  | { type: "reset"; epoch: number };

interface MetadataEvent {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadataSchemaType | null;
}

interface WorkspaceChatSubscriptionInput {
  workspaceId: string;
  mode?: OnChatMode;
  legacyAutoRetryEnabled?: boolean;
}

type WorkspaceActivityEvent =
  | { type: "activity"; workspaceId: string; activity: WorkspaceActivitySnapshot | null }
  | { type: "heartbeat" };

type TerminalAttachMessage =
  | { type: "screenState"; data: string }
  | { type: "output"; data: string };

type TerminalActivitySnapshot = ReturnType<
  ORPCContext["terminalService"]["getAllWorkspaceActivity"]
>;

type TerminalActivityEvent =
  | {
      type: "update";
      workspaceId: string;
      activity: { activeCount: number; totalSessions: number };
    }
  | { type: "snapshot"; workspaces: TerminalActivitySnapshot }
  | { type: "heartbeat" };

const LOG_LEVEL_PRIORITY: Record<LogEntry["level"], number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function runtimeSubscription<T>(context: ORPCContext, options: SubscriptionStreamOptions<T>) {
  return subscriptionIterable({ ...options, context: context["effect/context"] });
}

function shouldIncludeLogEntry(
  entryLevel: LogEntry["level"],
  minLevel: LogEntry["level"]
): boolean {
  return (
    (LOG_LEVEL_PRIORITY[entryLevel] ?? LOG_LEVEL_PRIORITY.debug) <=
    (LOG_LEVEL_PRIORITY[minLevel] ?? LOG_LEVEL_PRIORITY.info)
  );
}

export function subscribeConfigChanges(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<undefined> {
  return runtimeSubscription<undefined>(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => context.config.onConfigChanged(() => emit.push(undefined)),
  });
}

export function subscribeDevTools(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
): AsyncGenerator<DevToolsEvent> {
  const service = context.devToolsService;
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => {
      const eventName = "update:" + workspaceId;
      service.on(eventName, emit.push);
      return () => service.off(eventName, emit.push);
    },
    initial: async () => ({ type: "snapshot" as const, runs: await service.getRuns(workspaceId) }),
  });
}

export function subscribeProviderConfig(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<undefined> {
  return runtimeSubscription<undefined>(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => context.providerService.onConfigChanged(() => emit.push(undefined)),
  });
}

export function subscribeDesignExperiment(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<ClaudeDesignExperimentSnapshot> {
  const design = context.mcpConfigService.claudeDesign;
  return runtimeSubscription(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => design.onExperimentChange(emit.push),
    initialize: async (emit) => {
      await design.getStatus();
      emit.push(design.experimentSnapshot());
    },
  });
}

export function subscribePolicyChanges(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<undefined> {
  return runtimeSubscription<undefined>(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => context.policyService.onPolicyChanged(() => emit.push(undefined)),
  });
}

/**
 * Deliberately NOT on the Effect Stream bridge: this is a pure timed
 * generator with no event source to attach and no resource to release, so the
 * bridge's acquireRelease lifecycle would add machinery without value.
 */
export function createTickIterable(
  count: number,
  intervalMs: number
): AsyncGenerator<{ tick: number; timestamp: number }> {
  return (async function* () {
    for (let tick = 1; tick <= count; tick++) {
      yield { tick, timestamp: Date.now() };
      if (tick < count) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
}

export function subscribeLogs(
  context: ORPCContext,
  minLevel: LogEntry["level"],
  signal?: AbortSignal
): AsyncGenerator<LogSubscriptionEvent> {
  let snapshot: ReturnType<typeof subscribeLogFeed>["snapshot"];
  return runtimeSubscription<LogSubscriptionEvent>(context, {
    signal,
    subscribe: (emit) => {
      const subscription = subscribeLogFeed((event) => {
        if (event.type === "append") {
          if (shouldIncludeLogEntry(event.entry.level, minLevel)) {
            emit.push({ type: "append", epoch: event.epoch, entries: [event.entry] });
          }
          return;
        }
        emit.push({ type: "reset", epoch: event.epoch });
      }, minLevel);
      snapshot = subscription.snapshot;
      return subscription.unsubscribe;
    },
    initial: () => ({
      type: "snapshot" as const,
      epoch: snapshot.epoch,
      entries: snapshot.entries.filter((entry) => shouldIncludeLogEntry(entry.level, minLevel)),
    }),
  });
}

export function subscribeMemoryChanges(
  context: ORPCContext,
  workspaceId: string | null,
  signal?: AbortSignal,
  validate?: () => void
): AsyncGenerator<MemoryChangeEventPayload> {
  return (async function* () {
    validate?.();
    const metadata = workspaceId ? await context.workspaceService.getInfo(workspaceId) : null;
    const projectPath = metadata ? resolveMemoryProjectIdentity(metadata) : null;
    yield* runtimeSubscription(context, {
      signal,
      subscribe: (emit) => {
        const onChange = (event: MemoryChangeEvent) => {
          if (event.scope === "workspace" && event.workspaceId !== workspaceId) return;
          if (event.scope === "project" && event.projectPath !== projectPath) return;
          emit.push(event);
        };
        const onStatusChange = (event: MemoryConsolidationStatusChangeEventPayload) =>
          emit.push(event);
        context.memoryService.on("change", onChange);
        context.memoryConsolidationService.on("statusChange", onStatusChange);
        return () => {
          context.memoryService.off("change", onChange);
          context.memoryConsolidationService.off("statusChange", onStatusChange);
        };
      },
    });
  })();
}

export function subscribeTimeline(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
): AsyncGenerator<TimelineSubscriptionEvent> {
  const pendingEvents: TimelineSubscriptionEvent["events"] = [];
  let snapshotSequence: number | undefined;
  let pushEvent: ((event: TimelineSubscriptionEvent) => void) | undefined;
  return runtimeSubscription<TimelineSubscriptionEvent>(context, {
    signal,
    subscribe: (emit) => {
      pushEvent = emit.push;
      const onAppended = (event: {
        workspaceId: string;
        events: TimelineSubscriptionEvent["events"];
      }) => {
        if (event.workspaceId !== workspaceId) return;
        const sequence = snapshotSequence;
        if (sequence == null) {
          // Buffer until the snapshot boundary is known so reconnect cannot duplicate events.
          pendingEvents.push(...event.events);
          return;
        }
        const events = event.events.filter((item) => item.seq > sequence);
        if (events.length > 0) emit.push({ type: "appended", events });
      };
      context.timelineService.on("appended", onAppended);
      return () => context.timelineService.off("appended", onAppended);
    },
    initial: async () => {
      const maxSequence = await context.timelineService.getLastSequence(workspaceId);
      snapshotSequence = maxSequence;
      const snapshot = await context.timelineService.list(workspaceId, {
        cursor: maxSequence + 1,
        limit: TIMELINE_DEFAULT_PAGE_LIMIT,
      });
      const appended = pendingEvents.filter((event) => event.seq > maxSequence);
      if (appended.length > 0) pushEvent?.({ type: "appended", events: appended });
      pendingEvents.length = 0;
      return {
        type: "snapshot" as const,
        events: snapshot.events,
        nextCursor: snapshot.nextCursor,
        hasOlder: snapshot.hasOlder,
      };
    },
  });
}

export function subscribeWorkspaceChat(
  context: ORPCContext,
  input: WorkspaceChatSubscriptionInput,
  signal?: AbortSignal
): AsyncGenerator<WorkspaceChatMessage> {
  const session = context.workspaceService.getOrCreateSession(input.workspaceId);
  if (typeof input.legacyAutoRetryEnabled === "boolean") {
    session.setLegacyAutoRetryEnabledHint(input.legacyAutoRetryEnabled);
  }
  let replayRelay: ReturnType<typeof createReplayBufferedStreamMessageRelay>;
  // Subscribe before replay so the relay can buffer overlapping live deltas.
  return runtimeSubscription<WorkspaceChatMessage>(context, {
    signal,
    heartbeat: { value: { type: "heartbeat" as const } },
    subscribe: (emit) => {
      replayRelay = createReplayBufferedStreamMessageRelay(emit.push);
      return session.onChatEvent(({ message }) => replayRelay.handleSessionMessage(message));
    },
    initialize: async () => {
      await session.replayHistory(
        ({ message }) => replayRelay.handleReplayMessage(message),
        input.mode,
        replayRelay.finishReplay
      );
      replayRelay.finishReplay();
      session.scheduleStartupRecovery();
    },
  });
}

export function subscribeMetadata(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<MetadataEvent> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => {
      context.workspaceService.on("metadata", emit.push);
      return () => context.workspaceService.off("metadata", emit.push);
    },
  });
}

export function subscribeWorkspaceActivity(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<WorkspaceActivityEvent> {
  return runtimeSubscription<WorkspaceActivityEvent>(context, {
    signal,
    heartbeat: { value: { type: "heartbeat" } },
    subscribe: (emit) => {
      const onActivity = (event: {
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }) => emit.push({ type: "activity", ...event });
      context.workspaceService.on("activity", onActivity);
      return () => context.workspaceService.off("activity", onActivity);
    },
  });
}

export function subscribeBackgroundBashes(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  const service = context.workspaceService;
  const getState = async () => ({
    processes: await service.listBackgroundProcesses(workspaceId),
    foregroundToolCallIds: service.getForegroundToolCallIds(workspaceId),
  });
  const bootstrap = { delivered: false, error: null as Error | null };
  let reader: ReturnType<typeof createCoalescedReader> | undefined;
  // Full snapshots coalesce ("latest") because replaying stale intermediate
  // state only grows memory.
  return runtimeSubscription<Awaited<ReturnType<typeof getState>>>(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => {
      reader = createCoalescedReader({
        read: async () => {
          try {
            emit.push(await getState());
            bootstrap.delivered = true;
          } catch (error) {
            if (!bootstrap.delivered) {
              bootstrap.error = error instanceof Error ? error : new Error(getErrorMessage(error));
              emit.end();
              return;
            }
            throw error;
          }
        },
        retryDelayMs: 1_000,
      });
      const onChange = (changedWorkspaceId: string) => {
        if (changedWorkspaceId === workspaceId) reader?.trigger();
      };
      service.onBackgroundBashChange(onChange);
      return () => {
        reader?.stop();
        service.offBackgroundBashChange(onChange);
      };
    },
    // subscribe runs before initialize, so the reader is always set here.
    initialize: () => reader?.trigger(),
    onEnd: () => {
      if (bootstrap.error != null) throw bootstrap.error;
    },
  });
}

export function subscribeWorkspaceStats(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
): AsyncGenerator<WorkspaceStatsSnapshot> {
  const throttleMs = 100;
  let lastPushedAtMs = 0;
  let inFlight = true;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSnapshot = false;
  let closed = false;
  // Assigned in subscribe, which runs before any onChange event or initialize.
  let push: (snapshot: WorkspaceStatsSnapshot) => void = () => undefined;
  // Snapshot reads are serialized and throttled so token deltas cannot build a backlog.
  const pushSnapshot = async () => {
    if (closed || inFlight || !pendingSnapshot) return;
    pendingSnapshot = false;
    inFlight = true;
    try {
      const snapshot = await context.sessionTimingService.getSnapshot(workspaceId);
      if (closed) return;
      lastPushedAtMs = snapshot.generatedAt;
      push(snapshot);
    } finally {
      inFlight = false;
      if (!closed && pendingSnapshot) scheduleSnapshot();
    }
  };
  const runPushSnapshot = () => {
    void pushSnapshot().catch(() => undefined);
  };
  const scheduleSnapshot = () => {
    pendingSnapshot = true;
    if (closed || inFlight || pendingTimer) return;
    const remaining = throttleMs - (Date.now() - lastPushedAtMs);
    if (remaining <= 0) {
      runPushSnapshot();
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      runPushSnapshot();
    }, remaining);
    pendingTimer.unref?.();
  };
  return runtimeSubscription<WorkspaceStatsSnapshot>(context, {
    signal,
    buffer: "latest",
    subscribe: (emit) => {
      push = emit.push;
      const onChange = (changedWorkspaceId: string) => {
        if (changedWorkspaceId === workspaceId) scheduleSnapshot();
      };
      context.sessionTimingService.addSubscriber(workspaceId);
      context.sessionTimingService.onStatsChange(onChange);
      return () => {
        closed = true;
        if (pendingTimer) clearTimeout(pendingTimer);
        context.sessionTimingService.offStatsChange(onChange);
        context.sessionTimingService.removeSubscriber(workspaceId);
      };
    },
    initialize: async (emit) => {
      try {
        const initial = await context.sessionTimingService.getSnapshot(workspaceId);
        lastPushedAtMs = initial.generatedAt;
        emit.push(initial);
      } finally {
        inFlight = false;
        if (!closed && pendingSnapshot) scheduleSnapshot();
      }
    },
  });
}

export function subscribeTerminalOutput(
  context: ORPCContext,
  sessionId: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => context.terminalService.onOutput(sessionId, emit.push),
  });
}

export function attachTerminal(
  context: ORPCContext,
  sessionId: string,
  signal?: AbortSignal
): AsyncGenerator<TerminalAttachMessage> {
  // Output subscribes before screen capture so attach cannot lose bytes in the handshake.
  return runtimeSubscription<TerminalAttachMessage>(context, {
    signal,
    subscribe: (emit) =>
      context.terminalService.onOutput(sessionId, (data) => emit.push({ type: "output", data })),
    initial: () => ({
      type: "screenState" as const,
      data: context.terminalService.getScreenState(sessionId),
    }),
  });
}

export function subscribeTerminalExit(
  context: ORPCContext,
  sessionId: string,
  signal?: AbortSignal
): AsyncGenerator<number> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => context.terminalService.onExit(sessionId, emit.push),
    take: 1,
  });
}

export function subscribeTerminalActivity(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<TerminalActivityEvent> {
  return runtimeSubscription<TerminalActivityEvent>(context, {
    signal,
    heartbeat: { value: { type: "heartbeat" } },
    subscribe: (emit) =>
      context.terminalService.onActivityChange((workspaceId) =>
        emit.push({
          type: "update",
          workspaceId,
          activity: context.terminalService.getWorkspaceActivity(workspaceId),
        })
      ),
    initial: () => ({
      type: "snapshot",
      workspaces: context.terminalService.getAllWorkspaceActivity(),
    }),
  });
}

export function subscribeUpdateStatus(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<UpdateStatus> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => context.updateService.onStatus(emit.push),
  });
}

export function subscribeOpenSettings(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<undefined> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => context.menuEventService.onOpenSettings(() => emit.push(undefined)),
  });
}

export function subscribeSshPrompts(
  context: ORPCContext,
  signal?: AbortSignal
): AsyncGenerator<SshPromptEvent> {
  return runtimeSubscription(context, {
    signal,
    subscribe: (emit) => {
      const releaseResponder = context.sshPromptService.registerInteractiveResponder();
      // The service returns snapshot plus listeners atomically, preventing a request gap.
      const { snapshot, unsubscribe } = context.sshPromptService.subscribeRequests(
        (request: SshPromptRequest) => emit.push({ type: "request", ...request }),
        (requestId: string) => emit.push({ type: "removed", requestId })
      );
      for (const request of snapshot) emit.push({ type: "request", ...request });
      return () => {
        releaseResponder();
        unsubscribe();
      };
    },
  });
}
