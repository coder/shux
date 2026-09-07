import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import type {
  Runtime,
  BackgroundHandle,
  BackgroundMonitorProbeResult,
} from "@/node/runtime/Runtime";
import {
  spawnProcess,
  localBgWorkspaceDir,
  spawnRecordsAreHostLocal,
  quotePathForShell,
  BG_META_FILENAME,
  BG_EXIT_CODE_FILENAME,
  BG_OUTPUT_SUBDIR,
} from "./backgroundProcessExecutor";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { Ok, Err, type Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "./log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { BASH_MAX_LINE_BYTES } from "@/common/constants/toolLimits";
import { stripAnsiControlChars } from "@/node/utils/ansi";
import { truncateUtf8Prefix } from "@/node/utils/utf8";
import type { BashMonitorFailedOperation } from "@/common/types/message";
import {
  boundBashMonitorRegistryScript,
  type BashMonitorTerminalSummary,
} from "./bashMonitorRegistryStore";
import type { BashMonitorProcessSnapshot, BashMonitorTailLine } from "./bashMonitorWakeReconciler";
import { isErrnoWithCode } from "@/node/utils/fs";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";

const DEFAULT_BACKGROUND_BASH_TAIL_BYTES = 64_000;
const MAX_BACKGROUND_BASH_TAIL_BYTES = 1_000_000;
const MONITOR_POLL_INTERVAL_MS_LOCAL = 100;
const MONITOR_POLL_INTERVAL_MS_REMOTE = 1_000;
const MONITOR_MAX_PENDING_LINES = 50;
const MONITOR_MAX_LAST_LINES = 20;
const MONITOR_MAX_PROMPT_LINE_BYTES = Math.min(BASH_MAX_LINE_BYTES, 8_192);
const MONITOR_MAX_INCOMPLETE_MATCH_BYTES = 1_000_000;
const MONITOR_TRUNCATION_MARKER = "… [truncated] …";
// Bounded recent-output tail included in a settlement wake so the agent sees the process's
// final lines (e.g. the actual failure message) without a follow-up task_await round-trip.
const MONITOR_SETTLEMENT_TAIL_BYTES = 4_096;
const MONITOR_SETTLEMENT_TAIL_MAX_LINES = 10;

export function computeTailStartOffset(fileSizeBytes: number, tailBytes: number): number {
  assert(
    Number.isFinite(fileSizeBytes) && fileSizeBytes >= 0,
    `computeTailStartOffset expected fileSizeBytes >= 0 (got ${fileSizeBytes})`
  );
  assert(
    Number.isFinite(tailBytes) && tailBytes > 0,
    `computeTailStartOffset expected tailBytes > 0 (got ${tailBytes})`
  );

  return Math.max(0, fileSizeBytes - tailBytes);
}

/**
 * Enforce a byte bound on already-read tail content. Runtime-backed handles degrade a transient
 * size-query failure to 0, which turns an offset-based tail read into a full-file read; the
 * transfer has happened by then, but this cut keeps downstream line processing and the persisted
 * wake bounded. `startedMidContent` reports whether the result begins inside the original content
 * (callers drop the leading partial line, matching a mid-file read offset). A cut can split a
 * multi-byte character; the resulting replacement char lands in that dropped partial line.
 */
export function boundTailContent(
  content: string,
  tailBytes: number
): { content: string; startedMidContent: boolean } {
  assert(
    Number.isFinite(tailBytes) && tailBytes > 0,
    `boundTailContent expected tailBytes > 0 (got ${tailBytes})`
  );
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= tailBytes) {
    return { content, startedMidContent: false };
  }
  return {
    content: buf.subarray(buf.length - tailBytes).toString(),
    startedMidContent: true,
  };
}

/**
 * Narrow a persisted meta.json spawn record to the fields the crash-orphan probe needs.
 * Records are written by this app but can be truncated by a crash mid-write; anything
 * malformed is treated as absent rather than trusted.
 */
export function parseSpawnRecordMeta(raw: string): { pid: number; status: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("pid" in parsed) || !("status" in parsed)) return null;
  const { pid, status } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof status !== "string") return null;
  return { pid, status };
}

import { EventEmitter } from "events";

/**
 * Metadata written to meta.json for bookkeeping
 */
export interface BackgroundProcessMeta {
  id: string;
  pid: number;
  script: string;
  startTime: number;
  status: "running" | "exited" | "killed" | "failed";
  exitCode?: number;
  exitTime?: number;
  displayName?: string;
}

export interface BackgroundProcessMonitorConfig {
  filter: string;
  pattern: RegExp;
  exclude: boolean;
  maxEvents?: number;
  cooldownMs: number;
  /**
   * Also wake when the monitored process settles (exit, kill, timeout), not only on matching
   * lines. An armed monitor means "wake me on this condition — and always at settlement,
   * because after that the condition can never occur". Defaults to true when omitted.
   */
  wakeOnExit?: boolean;
}

export interface BackgroundProcessMonitorSnapshot {
  filter: string;
  filter_exclude: boolean;
  max_events?: number;
  cooldown_ms: number;
  totalMatches: number;
  droppedLines: number;
  lastLines: string[];
  stopped: boolean;
}

/** Terminal disposition attached to a settlement wake payload. */
export interface MonitorTerminalStatus {
  status: "exited" | "killed" | "failed";
  exitCode?: number;
}

/**
 * Payload for a "monitor:match" event. Despite the name this is a monitor *update*: it carries
 * matched output lines, a process-settlement notice, or both coalesced into one payload (pending
 * matched lines still unflushed when the process settles ride along with the terminal metadata so
 * a single wake turn reports "matched output, then exited").
 */
export interface MonitorMatchPayload {
  processId: string;
  taskId: string;
  workspaceId: string;
  displayName?: string;
  filter: string;
  filterExclude: boolean;
  lines: string[];
  totalMatches: number;
  droppedLines?: number;
  timestamp: number;
  /**
   * Contextual output tail carried by settlement payloads, kept separate from `lines` so the
   * wake store can dedupe it against already-persisted pending matches (a match flushed to disk
   * while the owner was busy is absent from the in-memory pending lines but can still sit inside
   * the final tail window).
   */
  tailLines?: string[];
  /**
   * File byte offset at the end of the last matched line, carried so the drain can re-check it
   * against the settled shown-frontier at delivery time. The emit-time suppression in
   * emitMonitorMatch is only a point-in-time fast path; drainBashMonitorWakes is authoritative.
   *
   * Present iff the payload carries undelivered matched lines. Settlement payloads whose matched
   * lines were already shown (or that never matched) omit it — `lines` then holds only the
   * synthetic settle line plus the output tail, which must never be offset-suppressed.
   */
  matchedThroughOffset?: number;
  /** Present on settlement payloads: the process reached a terminal status. */
  terminal?: MonitorTerminalStatus;
}

/** Emitted when a spawn arms a monitor; drives the persisted armed-monitor registry. */
export type MonitorWakeDeliveryState =
  | { status: "blocked"; readSettled: Promise<void> }
  | { status: "settled"; shownThroughOffset: number; terminalStatusShown: boolean };

interface MonitorRetainedMatchBatch {
  lines: string[];
  totalMatches: number;
  droppedLines: number;
  matchedThroughOffset: number;
}

interface MonitorSettlementDisposition extends BashMonitorTerminalSummary {
  tailLines: readonly BashMonitorTailLine[];
}

export interface OutputShownPayload {
  processId: string;
  processStartTime: number;
  shownThroughOffset: number;
  /**
   * True once a model-visible read (task_await / bash_output) has reported the process's
   * terminal status. Filtered reads count too: status/exitCode are never filtered out of tool
   * results, and a zero-output or filtered post-exit read does not advance the shown offset, so
   * queued settlement wakes need this explicit signal to be retracted.
   */
  terminalStatusShown: boolean;
}

export interface MonitorArmedPayload {
  processId: string;
  taskId: string;
  workspaceId: string;
  displayName?: string;
  filter: string;
  filterExclude: boolean;
  script: string;
  createdAt: string;
}

/** Matched output that must survive failed monitor retirement. */
export interface MonitorFailedMatchPayload {
  lines: string[];
  totalMatches: number;
  droppedLines: number;
  matchedThroughOffset?: number;
}

export interface MonitorStoppedPayload {
  processId: string;
  /** Explicit cancellation discards pending matches; failed retirement needs a durable lost wake. */
  reason?: "completed" | "canceled" | "failed";
  failureMessage?: string;
  failedOperations?: BashMonitorFailedOperation[];
  armMetadata?: MonitorArmedPayload;
  failedMatch?: MonitorFailedMatchPayload;
  terminal?: BashMonitorTerminalSummary;
}

// One or two misses can be transient; three means that capability cannot serve the monitor.
const MAX_CONSECUTIVE_MONITOR_PROBE_FAILURES = 3;

interface MonitorProbeFailureState {
  consecutiveFailures: number;
  message: string;
}

class MonitorPollingFailure extends Error {
  constructor(
    message: string,
    readonly failedOperations: readonly BashMonitorFailedOperation[]
  ) {
    super(message);
    this.name = "MonitorPollingFailure";
  }
}

export interface BackgroundProcessMonitorState extends BackgroundProcessMonitorConfig {
  armMetadata: MonitorArmedPayload;
  /** Resolved settlement-wake policy (config default: true). */
  wakeOnExit: boolean;
  matchesCount: number;
  pendingLines: string[];
  droppedLines: number;
  totalDroppedLines: number;
  lastLines: string[];
  flushTimer?: ReturnType<typeof setTimeout>;
  lastReadOffset: number;
  /**
   * File byte offset at the end of the last complete line that produced a match. Unlike
   * lastReadOffset (the raw scan cursor, which can sit past the match on later/unmatched output),
   * this marks where the matched output actually ends. emitMonitorMatch compares it against the
   * agent's shown-read offset to suppress wakes for output already delivered inline.
   */
  matchedThroughOffset: number;
  retainedMatches: MonitorRetainedMatchBatch[];
  settlementDisposition?: MonitorSettlementDisposition;
  pollIntervalMs: number;
  incompleteLineBuffer: string;
  stopped: boolean;
  probeFailures: Partial<Record<BashMonitorFailedOperation, MonitorProbeFailureState>>;
  /**
   * Settlement claim latch. Set synchronously (single-threaded event loop makes the plain flag
   * race-safe) by claimMonitorSettlement; once held, normal flush/stop triggers are suspended
   * (accumulation-only mode) and the reservation owner performs the ONLY final combined emit and
   * "completed" retirement. Explicit cancellation still wins: stopMonitor(canceled) sets
   * `stopped`, which the settlement helper re-checks after every await.
   */
  settled: boolean;
}

/** Exclusive right to emit the single combined settlement wake for one monitor. */
interface MonitorSettlementReservation {
  proc: BackgroundProcess;
  monitor: BackgroundProcessMonitorState;
}

/**
 * Represents a background process with file-based output.
 * All per-process state is consolidated here so cleanup is automatic when
 * the process is removed from the processes map.
 */
export interface BackgroundProcess {
  id: string; // Process ID (display_name from the bash tool call)
  pid: number; // OS process ID
  workspaceId: string; // Owning workspace
  outputDir: string; // Directory containing stdout.log, stderr.log, meta.json
  script: string; // Original command
  startTime: number; // Timestamp when started
  exitCode?: number; // Undefined if still running
  exitTime?: number; // Timestamp when exited (undefined if running)
  status: "running" | "exited" | "killed" | "failed";
  handle: BackgroundHandle; // For process interaction
  displayName?: string; // Human-readable name (e.g., "Dev Server")
  /** True if this process is being waited on (foreground mode) */
  isForeground: boolean;
  /** Tracks read position for incremental output retrieval */
  outputBytesRead: number;
  /**
   * File byte offset through the end of the last complete line an *unfiltered* getOutput call
   * (task_await / bash_output) has delivered to the agent. Unlike outputBytesRead, this never
   * advances for filtered reads (which may drop matched lines) or for buffered trailing fragments,
   * so it is the faithful "agent has been shown this" signal the monitor consults. Both this and
   * the monitor's matchedThroughOffset are absolute file offsets, so suppression is race-free.
   */
  shownThroughOffset: number;
  /**
   * True once a model-visible getOutput caller (task_await / bash_output) has been returned a
   * terminal status for this process. shownThroughOffset alone cannot express this: a zero-output
   * process has EOF = 0 = shownThroughOffset, and filtered reads never advance the offset, yet
   * both still report status/exitCode. Consulted when suppressing settlement wakes.
   */
  terminalStatusShownToAgent: boolean;
  /**
   * Resolves when the current read that must block same-process monitor delivery settles. This
   * includes unfiltered reads, which may advance shownThroughOffset, and filtered task_await reads,
   * which a monitor wake must not interrupt. Filtered reads from other callers remain untracked so
   * they cannot delay wake delivery for output they will never mark as shown.
   */
  monitorWakeBlockingReadSettled?: Promise<void>;
  /** Mutex to serialize getOutput() calls (prevents race condition when
   * parallel tool calls read from same offset before position is updated) */
  outputLock: AsyncMutex;
  /** Tracks how many times getOutput() has been called (for polling detection) */
  getOutputCallCount: number;
  /** Buffer for incomplete lines (no trailing newline) from previous read */
  incompleteLineBuffer: string;
  /** Optional write-time monitor that wakes the agent on matching output lines. */
  monitor?: BackgroundProcessMonitorState;
}

/**
 * Represents a foreground process that can be sent to background.
 * These are processes started via runtime.exec() (not nohup) that we track
 * so users can click "Background" to stop waiting for them.
 */
export interface ForegroundProcess {
  /** Workspace ID */
  workspaceId: string;
  /** Tool call ID that started this process (for UI to match) */
  toolCallId: string;
  /** Script being executed */
  script: string;
  /** Display name for the process (used as ID if sent to background) */
  displayName: string;
  /** Callback to invoke when user requests backgrounding */
  onBackground: () => void;
  /** Current accumulated output (for saving to files on background) */
  output: string[];
}

/**
 * Manages bash processes for workspaces.
 *
 * ALL bash commands are spawned through this manager with background-style
 * infrastructure (nohup, file output, exit code trap). This enables:
 * - Uniform code path for all bash commands
 * - Crash resilience (output always persisted to files)
 * - Seamless fg→bg transition via sendToBackground()
 *
 * Supports incremental output retrieval via getOutput().
 */
/**
 * Event types emitted by BackgroundProcessManager.
 * The 'change' event is emitted whenever the state changes for a workspace.
 */
export interface BackgroundProcessManagerEvents {
  change: [workspaceId: string];
  "output:shown": [workspaceId: string, payload: OutputShownPayload];
  "monitor:match": [workspaceId: string, payload: MonitorMatchPayload];
  "monitor:armed": [workspaceId: string, payload: MonitorArmedPayload];
  "monitor:stopped": [workspaceId: string, payload: MonitorStoppedPayload];
}

export class BackgroundProcessManager extends EventEmitter<BackgroundProcessManagerEvents> {
  // NOTE: This map is in-memory only. Background processes use nohup/setsid so they
  // could survive app restarts, but we kill all tracked processes on shutdown via
  // dispose(). Rehydrating from meta.json on startup is out of scope for now.
  // All per-process state (read position, output lock) is stored in BackgroundProcess
  // so cleanup is automatic when the process is removed from this map.
  private processes = new Map<string, BackgroundProcess>();

  // Process IDs claimed by in-flight spawns that have not yet registered in `processes`.
  // Allocation must be race-free across the awaits between choosing an ID and registering
  // the process: two concurrent same-name spawns sharing one directory would also share
  // meta.json/exit_code, and the first exit would settle the record while the other process
  // still writes — blinding the crash-orphan archive gates. Reserved synchronously when a
  // candidate is chosen; released when the spawn registers or fails.
  private readonly reservedProcessIds = new Set<string>();

  // Base directory for process output files
  private readonly bgOutputDir: string;
  // Tracks foreground processes (started via runtime.exec) that can be backgrounded
  // Key is toolCallId to support multiple parallel foreground processes per workspace
  private foregroundProcesses = new Map<string, ForegroundProcess>();
  // Tracks workspaces with queued messages (for bash_output to return early)
  private queuedMessageWorkspaces = new Set<string>();

  // Once set, stopMonitor() suppresses "monitor:stopped" so the persisted armed-monitor
  // registry survives shutdown and the next startup can notify owners their monitors
  // were lost. Never reset: the manager does not outlive a shutdown.
  private shuttingDown = false;

  constructor(bgOutputDir: string) {
    super();
    // Background bash status can have many concurrent subscribers (e.g. multiple workspaces).
    // Raise the default listener cap to avoid noisy MaxListenersExceededWarning.
    this.setMaxListeners(50);
    this.bgOutputDir = bgOutputDir;
  }

  /**
   * Mark whether a workspace has a queued user message.
   * Used by bash_output to return early when user has sent a new message.
   */
  setMessageQueued(workspaceId: string, queued: boolean): void {
    if (queued) {
      this.queuedMessageWorkspaces.add(workspaceId);
    } else {
      this.queuedMessageWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Check if a workspace has a queued user message.
   */
  hasQueuedMessage(workspaceId: string): boolean {
    return this.queuedMessageWorkspaces.has(workspaceId);
  }

  /** Emit a change event for a workspace */
  private emitChange(workspaceId: string): void {
    this.emit("change", workspaceId);
  }

  /**
   * Nudge background-bash subscribers after a monitor wake-state transition (pending,
   * delivered, or consumed). Wake state lives in WorkspaceService's reconciler, but
   * subscribers observe it through this manager's "change" stream, so the owner needs
   * a way to request an emit when only wake state — not process state — changed.
   */
  notifyMonitorWakeStateChanged(workspaceId: string): void {
    assert(workspaceId.length > 0, "notifyMonitorWakeStateChanged requires a workspaceId");
    this.emitChange(workspaceId);
  }

  private createMonitorState(
    config: BackgroundProcessMonitorConfig,
    options: { pollIntervalMs: number; armMetadata: MonitorArmedPayload }
  ): BackgroundProcessMonitorState {
    assert(config.filter.length > 0, "BackgroundProcessMonitorConfig requires a filter");
    assert(config.cooldownMs >= 0, "BackgroundProcessMonitorConfig cooldown must be non-negative");
    assert(options.pollIntervalMs > 0, "monitor poll interval must be positive");
    return {
      ...config,
      armMetadata: options.armMetadata,
      wakeOnExit: config.wakeOnExit ?? true,
      matchesCount: 0,
      pendingLines: [],
      droppedLines: 0,
      totalDroppedLines: 0,
      lastLines: [],
      lastReadOffset: 0,
      matchedThroughOffset: 0,
      retainedMatches: [],
      incompleteLineBuffer: "",
      stopped: false,
      probeFailures: {},
      settled: false,
      pollIntervalMs: options.pollIntervalMs,
    };
  }

  getMonitorSnapshot(proc: BackgroundProcess): BackgroundProcessMonitorSnapshot | undefined {
    const monitor = proc.monitor;
    if (!monitor) return undefined;

    return {
      filter: monitor.filter,
      filter_exclude: monitor.exclude,
      ...(monitor.maxEvents !== undefined ? { max_events: monitor.maxEvents } : {}),
      cooldown_ms: monitor.cooldownMs,
      totalMatches: monitor.matchesCount,
      droppedLines: monitor.totalDroppedLines,
      lastLines: [...monitor.lastLines],
      stopped: monitor.stopped,
    };
  }

  /**
   * Count running background processes whose wake-on-match monitor is still armed.
   * Surfaced through workspace activity so the sidebar can show that a workspace is
   * still waiting on a monitor even though no stream is active.
   */
  getActiveMonitorCount(workspaceId: string): number {
    assert(workspaceId.length > 0, "getActiveMonitorCount requires a workspaceId");
    let count = 0;
    for (const proc of this.processes.values()) {
      if (
        proc.workspaceId === workspaceId &&
        proc.status === "running" &&
        proc.monitor !== undefined &&
        !proc.monitor.stopped
      ) {
        count++;
      }
    }
    return count;
  }

  private emitMonitorMatch(proc: BackgroundProcess, monitor: BackgroundProcessMonitorState): void {
    if (monitor.pendingLines.length === 0) return;
    // A claimed settlement suspends normal flushes: pending lines accumulate until the
    // reservation owner emits the single combined settlement payload.
    if (monitor.settled) return;

    if (monitor.flushTimer) {
      clearTimeout(monitor.flushTimer);
      monitor.flushTimer = undefined;
    }

    // Fast-path drop: don't even emit a wake for output the agent has already been shown.
    // shownThroughOffset is the file position an unfiltered task_await / bash_output read has
    // delivered complete lines through; matchedThroughOffset is where the matched line ends. Both
    // are absolute file offsets, so this is order-independent. This check is only a point-in-time
    // optimization -- it suppresses the common cooldown-deferred case with zero store I/O. It can
    // still race a concurrent task_await that advances shownThroughOffset just after this flush
    // (e.g. a process that prints its final line then exits, triggering an immediate exit flush).
    // drainBashMonitorWakes re-checks matchedThroughOffset against the settled frontier at delivery
    // time and is the authoritative suppression point; this is the cheap early-out ahead of it.
    if (proc.shownThroughOffset >= monitor.matchedThroughOffset) {
      monitor.pendingLines = [];
      monitor.droppedLines = 0;
      return;
    }

    const lines = monitor.pendingLines;
    const droppedLines = monitor.droppedLines;
    monitor.pendingLines = [];
    monitor.droppedLines = 0;

    this.emitMonitorUpdate(proc, monitor, {
      lines,
      droppedLines,
      matchedThroughOffset: monitor.matchedThroughOffset,
    });
  }

  private retainMonitorMatch(
    monitor: BackgroundProcessMonitorState,
    update: { lines: readonly string[]; droppedLines: number; matchedThroughOffset: number }
  ): void {
    monitor.retainedMatches.push({
      lines: [...update.lines],
      totalMatches: monitor.matchesCount,
      droppedLines: update.droppedLines,
      matchedThroughOffset: update.matchedThroughOffset,
    });
    let retainedLineCount = monitor.retainedMatches.reduce(
      (total, batch) => total + batch.lines.length,
      0
    );
    while (retainedLineCount > MONITOR_MAX_PENDING_LINES) {
      const first = monitor.retainedMatches[0];
      const removeCount = Math.min(
        retainedLineCount - MONITOR_MAX_PENDING_LINES,
        first.lines.length
      );
      first.lines.splice(0, removeCount);
      first.droppedLines += removeCount;
      retainedLineCount -= removeCount;
      if (first.lines.length === 0 && monitor.retainedMatches.length > 1) {
        const removed = monitor.retainedMatches.shift();
        if (removed != null) monitor.retainedMatches[0].droppedLines += removed.droppedLines;
      }
    }
  }

  /** Low-level "monitor:match" emitter shared by normal flushes and settlement payloads. */
  private emitMonitorUpdate(
    proc: BackgroundProcess,
    monitor: BackgroundProcessMonitorState,
    update: {
      lines: string[];
      tailLines?: string[];
      droppedLines: number;
      matchedThroughOffset?: number;
      terminal?: MonitorTerminalStatus;
    }
  ): void {
    if (update.matchedThroughOffset !== undefined && update.lines.length > 0) {
      this.retainMonitorMatch(monitor, {
        lines: update.lines,
        droppedLines: update.droppedLines,
        matchedThroughOffset: update.matchedThroughOffset,
      });
    }
    this.emit("monitor:match", proc.workspaceId, {
      processId: proc.id,
      taskId: `bash:${proc.id}`,
      workspaceId: proc.workspaceId,
      ...(proc.displayName !== undefined ? { displayName: proc.displayName } : {}),
      filter: monitor.filter,
      filterExclude: monitor.exclude,
      lines: update.lines,
      ...(update.tailLines !== undefined ? { tailLines: update.tailLines } : {}),
      totalMatches: monitor.matchesCount,
      ...(update.droppedLines > 0 ? { droppedLines: update.droppedLines } : {}),
      timestamp: Date.now(),
      ...(update.matchedThroughOffset !== undefined
        ? { matchedThroughOffset: update.matchedThroughOffset }
        : {}),
      ...(update.terminal !== undefined ? { terminal: update.terminal } : {}),
    });
    this.emitChange(proc.workspaceId);
  }

  /**
   * Mark the manager as shutting down. Must be called before any session teardown that
   * triggers cleanup()/terminateAll() (e.g. first line of ServiceContainer.dispose()),
   * otherwise per-workspace cleanup would emit "monitor:stopped" and erase the registry
   * records the post-restart "monitor lost" notification depends on.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  private stopMonitor(
    proc: BackgroundProcess,
    flushPending: boolean,
    reason: NonNullable<MonitorStoppedPayload["reason"]> = "completed",
    failure?: { message: string; failedOperations?: BashMonitorFailedOperation[] }
  ): void {
    const monitor = proc.monitor;
    if (!monitor || monitor.stopped) return;

    // Same shown-frontier gate as the normal flush: matches an unfiltered read already delivered
    // must not resurface as fresh output through the failure wake.
    const failedMatchHasUnshownLines =
      monitor.pendingLines.length > 0 && proc.shownThroughOffset < monitor.matchedThroughOffset;
    const failedMatch: MonitorFailedMatchPayload | undefined =
      failure != null
        ? {
            lines: failedMatchHasUnshownLines ? [...monitor.pendingLines] : [],
            totalMatches: monitor.matchesCount,
            droppedLines: failedMatchHasUnshownLines ? monitor.droppedLines : 0,
            ...(failedMatchHasUnshownLines
              ? { matchedThroughOffset: monitor.matchedThroughOffset }
              : {}),
          }
        : undefined;
    monitor.stopped = true;
    if (monitor.flushTimer) {
      clearTimeout(monitor.flushTimer);
      monitor.flushTimer = undefined;
    }
    if (reason === "failed") {
      if (failedMatch?.matchedThroughOffset != null && failedMatch.lines.length > 0) {
        this.retainMonitorMatch(monitor, {
          lines: failedMatch.lines,
          droppedLines: failedMatch.droppedLines,
          matchedThroughOffset: failedMatch.matchedThroughOffset,
        });
      }
      monitor.pendingLines = [];
      monitor.droppedLines = 0;
    } else if (flushPending) {
      this.emitMonitorMatch(proc, monitor);
    } else {
      // Explicit cancellation means the caller no longer wants this condition to produce a wake.
      // Drop coalesced matches rather than letting monitor teardown create the late wake itself.
      monitor.pendingLines = [];
      monitor.droppedLines = 0;
      monitor.retainedMatches = [];
      monitor.settlementDisposition = undefined;
    }
    // A monitor retiring while the app is alive means the agent no longer wants wakes for
    // this process, so its armed-registry record must go. During shutdown the record must
    // survive so the next startup can deliver the "monitor lost" notice.
    if (!this.shuttingDown) {
      this.emit("monitor:stopped", proc.workspaceId, {
        processId: proc.id,
        reason,
        armMetadata: monitor.armMetadata,
        ...(monitor.settlementDisposition != null
          ? {
              terminal: {
                status: monitor.settlementDisposition.status,
                ...(monitor.settlementDisposition.exitCode !== undefined
                  ? { exitCode: monitor.settlementDisposition.exitCode }
                  : {}),
                settledAt: monitor.settlementDisposition.settledAt,
                wakeOnExit: monitor.settlementDisposition.wakeOnExit,
                terminalStatusShown: monitor.settlementDisposition.terminalStatusShown,
                ...(monitor.settlementDisposition.matchedThroughOffset != null
                  ? { matchedThroughOffset: monitor.settlementDisposition.matchedThroughOffset }
                  : {}),
              },
            }
          : {}),
        ...(failure != null
          ? {
              failureMessage: failure.message,
              ...(failure.failedOperations != null
                ? { failedOperations: failure.failedOperations }
                : {}),
              ...(failedMatch != null ? { failedMatch } : {}),
            }
          : {}),
      });
    }
    // Armed -> stopped is workspace-visible state (sidebar "watching" indicator), and not
    // every stop path also changes process status or flushes a match (e.g. maxEvents
    // reached with the wake suppressed), so always notify subscribers.
    this.emitChange(proc.workspaceId);
  }

  private cancelMonitor(proc: BackgroundProcess): void {
    const monitor = proc.monitor;
    if (!monitor) return;
    if (!monitor.stopped) {
      this.stopMonitor(proc, false, "canceled");
      return;
    }

    // A match may already have retired the monitor and queued a synthetic wake. Explicit process
    // cancellation must still retract that undelivered wake, so emit a cancellation notification
    // even though the in-memory monitor has no remaining timer or pending lines to clear.
    monitor.retainedMatches = [];
    monitor.settlementDisposition = undefined;
    if (!this.shuttingDown) {
      this.emit("monitor:stopped", proc.workspaceId, {
        processId: proc.id,
        reason: "canceled",
        armMetadata: monitor.armMetadata,
      });
    }
  }

  /**
   * Synchronously claim exclusive settlement ownership for a monitor. Returns null when the
   * monitor is missing, already stopped (canceled / maxEvents-retired), already claimed, or the
   * manager is shutting down (the persisted registry record must survive shutdown so the next
   * startup can deliver the "monitor lost" notice; callers fall back to the legacy flush).
   *
   * Claiming (a) ends tail-loop ownership — its post-await guards return on the latch — and
   * (b) switches the monitor to accumulation-only mode: cooldown flushes, cooldown_ms=0 immediate
   * emits, and maxEvents retirement are all suppressed so the matched-lines emit can never split
   * from the terminal emit. The reservation owner performs the ONLY final combined emit and the
   * ONLY "completed" retirement, via emitClaimedMonitorSettlement.
   */
  private claimMonitorSettlement(proc: BackgroundProcess): MonitorSettlementReservation | null {
    const monitor = proc.monitor;
    if (!monitor || monitor.stopped || monitor.settled || this.shuttingDown) return null;
    monitor.settled = true;
    // A stale cooldown timer must not fire while the settlement helper awaits its final reads.
    if (monitor.flushTimer) {
      clearTimeout(monitor.flushTimer);
      monitor.flushTimer = undefined;
    }
    return { proc, monitor };
  }

  /**
   * Emit the single combined settlement wake for a claimed monitor, then retire it.
   *
   * The payload coalesces (in order): pending matched lines still undelivered at settlement, a
   * synthetic settle line (the downgrade fallback: older builds strip the `terminal` field but
   * still deliver an actionable match-shaped wake), and a bounded recent-output tail. It is
   * emitted BEFORE "monitor:stopped" so the retained wake state is observable before the
   * armed-monitor registry record gains its terminal summary (both WorkspaceService listeners
   * enqueue their work onto the same per-workspace mutex synchronously and in FIFO emit order).
   *
   * Cancellation wins during the claimed window: explicit cancel (task_stop, workspace cleanup)
   * sets monitor.stopped and emits "monitor:stopped"(canceled); this helper re-checks that state
   * after every await and no-ops, so no terminal wake and no duplicate "monitor:stopped" fire.
   */
  private async emitClaimedMonitorSettlement(
    reservation: MonitorSettlementReservation,
    terminal: MonitorTerminalStatus
  ): Promise<void> {
    const { proc, monitor } = reservation;
    assert(monitor.settled, "emitClaimedMonitorSettlement requires a claimed settlement");

    // stdout/stderr redirection can lag exit-code observation by a tick (same redirect-lag sleep
    // the tail loop used before settlement centralized the final scan here).
    //
    // Every post-await guard below also rechecks shuttingDown: beginShutdown() can land while
    // this helper sleeps or reads, after claimMonitorSettlement's own guard already passed.
    // Emitting then would let WorkspaceService persist or queue a synthetic turn during
    // ServiceContainer.dispose; returning instead leaves the armed registry record for the
    // restart monitor-lost recovery (in-memory pending matches are lost, crash-equivalent).
    await new Promise((resolve) => setTimeout(resolve, monitor.pollIntervalMs));
    if (monitor.stopped || this.shuttingDown) return;

    // Final monitor scan: matches printed after the last poll (or sitting in the chunk the tail
    // loop read but deliberately did not process before claiming) accumulate under settlement
    // mode. Scan failure must not drop the wake.
    try {
      const finalChunkStartOffset = monitor.lastReadOffset;
      const finalRead = await proc.handle.readOutput(finalChunkStartOffset);
      if (monitor.stopped || this.shuttingDown) return;
      if (finalRead.newOffset >= finalChunkStartOffset) {
        monitor.lastReadOffset = finalRead.newOffset;
        this.processMonitorContent(proc, finalRead.content, {
          chunkStartOffset: finalChunkStartOffset,
          includeIncompleteLine: true,
        });
      }
    } catch (error) {
      log.debug(
        `BackgroundProcessManager: settlement scan for ${proc.id} failed: ${getErrorMessage(error)}`
      );
    }
    // A rejected scan read skips the success-path guard above, and the wake_on_exit=false branch
    // below has no later guard of its own — recheck here so cancellation or a mid-scan
    // beginShutdown can never leak a pending-match emit past this point.
    if (monitor.stopped || this.shuttingDown) return;

    let tailLines: BashMonitorTailLine[] = [];
    if (monitor.wakeOnExit) {
      try {
        tailLines = await this.readSettlementTailLines(proc);
      } catch (error) {
        // Tail-read failure must not drop the wake; the synthetic settle line still delivers.
        log.debug(
          `BackgroundProcessManager: settlement tail read for ${proc.id} failed: ${getErrorMessage(error)}`
        );
      }
      if (monitor.stopped || this.shuttingDown) return;
    }

    const pendingLines = monitor.pendingLines;
    const droppedLines = monitor.droppedLines;
    monitor.pendingLines = [];
    monitor.droppedLines = 0;
    // The shown fast-path applies ONLY to whether pending matched lines are included; it must
    // never skip the settle emit while an unshown terminal notice exists. matchedThroughOffset is
    // carried iff undelivered matched lines are actually included, so a terminal-only payload can
    // never be offset-suppressed downstream (a zero-output process has EOF = 0 = shown offset).
    const includeMatched =
      pendingLines.length > 0 && proc.shownThroughOffset < monitor.matchedThroughOffset;

    const retainedMatch = monitor.retainedMatches[monitor.retainedMatches.length - 1];
    const retainedMatchedThroughOffset = includeMatched
      ? monitor.matchedThroughOffset
      : retainedMatch?.matchedThroughOffset;
    monitor.settlementDisposition = {
      status: terminal.status,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      settledAt: new Date().toISOString(),
      wakeOnExit: monitor.wakeOnExit,
      terminalStatusShown: proc.terminalStatusShownToAgent,
      ...(retainedMatchedThroughOffset != null
        ? { matchedThroughOffset: retainedMatchedThroughOffset }
        : {}),
      tailLines,
    };

    if (!monitor.wakeOnExit) {
      // wake_on_exit=false degrades to the legacy exit flush: matched lines only, no terminal
      // metadata, no synthetic/tail lines.
      if (includeMatched) {
        this.emitMonitorUpdate(proc, monitor, {
          lines: pendingLines,
          droppedLines,
          matchedThroughOffset: monitor.matchedThroughOffset,
        });
      }
    } else {
      this.emitMonitorUpdate(proc, monitor, {
        lines: includeMatched ? pendingLines : [],
        ...(tailLines.length > 0 ? { tailLines: tailLines.map((entry) => entry.line) } : {}),
        droppedLines: includeMatched ? droppedLines : 0,
        ...(includeMatched ? { matchedThroughOffset: monitor.matchedThroughOffset } : {}),
        terminal,
      });
    }

    // Retire AFTER the settlement emit so the wake persists before the registry record is
    // deleted. emitMonitorMatch no-ops under the settled latch, so flushPending=true cannot
    // produce a second, split emit here.
    this.stopMonitor(proc, true);
  }

  /**
   * Bounded tail of output.log for the settlement wake: last complete lines within the final
   * ~4 KB, sanitized and middle-truncated like matched lines. Read failure propagates to the
   * caller, which treats it as an empty tail.
   */
  private async readSettlementTailLines(proc: BackgroundProcess): Promise<BashMonitorTailLine[]> {
    const fileSizeBytes = await proc.handle.getOutputFileSize();
    const windowStart = computeTailStartOffset(fileSizeBytes, MONITOR_SETTLEMENT_TAIL_BYTES);
    const offset = Math.max(windowStart, proc.shownThroughOffset);
    const startedAtLineBoundary = offset === proc.shownThroughOffset;
    const result = await proc.handle.readOutput(offset);
    const bounded = boundTailContent(result.content, MONITOR_SETTLEMENT_TAIL_BYTES);
    const startedMidLine = (offset > 0 && !startedAtLineBoundary) || bounded.startedMidContent;
    const segments = bounded.content.split("\n");
    let cursor = result.newOffset - Buffer.byteLength(bounded.content, "utf8");
    const positioned = segments.map((line, index) => {
      cursor += Buffer.byteLength(line, "utf8");
      if (index < segments.length - 1) cursor += 1;
      return { line, endOffset: cursor };
    });
    const rawLines = startedMidLine ? positioned.slice(1) : positioned;
    const lines = rawLines
      .map((entry) => ({ ...entry, line: this.sanitizeMonitorLine(entry.line) }))
      .filter((entry) => entry.line.length > 0)
      .slice(-MONITOR_SETTLEMENT_TAIL_MAX_LINES)
      .map((entry) => ({ ...entry, line: this.truncateMonitorLine(entry.line) }));
    if (lines.length > 0 || !startedMidLine) return lines;
    const fragment = this.sanitizeMonitorLine(segments[0] ?? "");
    if (fragment.length === 0) return [];
    return [
      {
        line: this.truncateMonitorLine(`${MONITOR_TRUNCATION_MARKER}${fragment}`),
        endOffset: result.newOffset,
      },
    ];
  }

  private scheduleMonitorFlush(
    proc: BackgroundProcess,
    monitor: BackgroundProcessMonitorState
  ): void {
    if (monitor.cooldownMs === 0) {
      this.emitMonitorMatch(proc, monitor);
      return;
    }

    monitor.flushTimer ??= setTimeout(() => {
      monitor.flushTimer = undefined;
      if (!monitor.stopped && !monitor.settled) {
        this.emitMonitorMatch(proc, monitor);
      }
    }, monitor.cooldownMs);
  }

  private truncateUtf8Suffix(value: string, maxBytes: number): string {
    assert(maxBytes > 0, "truncateUtf8Suffix requires a positive byte limit");
    let bytes = 0;
    let startIndex = value.length;
    const chars = [...value];
    for (let index = chars.length - 1; index >= 0; index--) {
      const char = chars[index];
      const charBytes = Buffer.byteLength(char, "utf8");
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      startIndex -= char.length;
    }

    return value.slice(startIndex);
  }

  private truncateUtf8Middle(value: string, maxBytes: number): string {
    assert(maxBytes > 0, "truncateUtf8Middle requires a positive byte limit");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

    const markerBytes = Buffer.byteLength(MONITOR_TRUNCATION_MARKER, "utf8");
    const remainingBytes = Math.max(1, maxBytes - markerBytes);
    const prefixBytes = Math.floor(remainingBytes / 2);
    const suffixBytes = remainingBytes - prefixBytes;
    return `${truncateUtf8Prefix(value, prefixBytes)}${MONITOR_TRUNCATION_MARKER}${this.truncateUtf8Suffix(value, suffixBytes)}`;
  }

  private sanitizeMonitorLine(line: string): string {
    return stripAnsiControlChars(line);
  }

  private truncateMonitorLine(line: string): string {
    return this.truncateUtf8Middle(line, MONITOR_MAX_PROMPT_LINE_BYTES);
  }

  private boundMonitorIncompleteLineBuffer(line: string): string {
    if (Buffer.byteLength(line, "utf8") <= MONITOR_MAX_INCOMPLETE_MATCH_BYTES) return line;

    // Keep the newest suffix for still-growing long lines so a token near the eventual end of a
    // JSON/log line can still match when the newline or exit flush arrives. Prompt truncation happens
    // separately after matching.
    const markerBytes = Buffer.byteLength(MONITOR_TRUNCATION_MARKER, "utf8");
    return `${MONITOR_TRUNCATION_MARKER}${this.truncateUtf8Suffix(
      line,
      MONITOR_MAX_INCOMPLETE_MATCH_BYTES - markerBytes
    )}`;
  }

  private recordMonitorMatch(
    proc: BackgroundProcess,
    line: string,
    completeRegionEndOffset: number
  ): void {
    const monitor = proc.monitor;
    if (!monitor || monitor.stopped) return;

    // Settlement accumulation still honors max_events: the cap silences wakes after N matches,
    // so final-chunk matches beyond it must not swell the combined settlement payload or report
    // totalMatches above the configured limit (the non-settled path can never exceed the cap
    // because retirement below fires exactly at it).
    if (
      monitor.settled &&
      monitor.maxEvents !== undefined &&
      monitor.matchesCount >= monitor.maxEvents
    ) {
      return;
    }

    const boundedLine = this.truncateMonitorLine(line);
    monitor.matchesCount++;
    monitor.pendingLines.push(boundedLine);
    monitor.lastLines.push(boundedLine);
    // Offsets only grow, so this advances to the end of the latest matched line. Set before any
    // flush (including the maxEvents-triggered stopMonitor below) so emitMonitorMatch sees it.
    monitor.matchedThroughOffset = completeRegionEndOffset;

    if (monitor.lastLines.length > MONITOR_MAX_LAST_LINES) {
      monitor.lastLines.splice(0, monitor.lastLines.length - MONITOR_MAX_LAST_LINES);
    }

    while (monitor.pendingLines.length > MONITOR_MAX_PENDING_LINES) {
      monitor.pendingLines.shift();
      monitor.droppedLines++;
      monitor.totalDroppedLines++;
    }

    // Settlement accumulation mode: once a settlement claim is held, matches in the final
    // chunk(s) only accumulate. No cooldown flush (a cooldown_ms=0 match must not emit ahead of
    // the combined settlement payload) and no maxEvents retirement (stopMonitor would delete the
    // registry record before the settlement wake persists).
    if (monitor.settled) return;

    this.scheduleMonitorFlush(proc, monitor);

    if (monitor.maxEvents !== undefined && monitor.matchesCount >= monitor.maxEvents) {
      // The monitor is intentionally a wake-up mechanism, not process lifecycle control.
      // max_events silences future wakes while leaving the underlying background command alive.
      this.stopMonitor(proc, true);
    }
  }

  private monitorMatchesLine(monitor: BackgroundProcessMonitorState, line: string): boolean {
    monitor.pattern.lastIndex = 0;
    const matched = monitor.pattern.test(line);
    return monitor.exclude ? !matched : matched;
  }

  private processMonitorContent(
    proc: BackgroundProcess,
    content: string,
    options: { chunkStartOffset: number; includeIncompleteLine?: boolean }
  ): void {
    const monitor = proc.monitor;
    if (!monitor || monitor.stopped) return;
    if (content.length === 0 && options.includeIncompleteLine !== true) return;

    const rawWithBuffer = monitor.incompleteLineBuffer + content;
    const allLines = rawWithBuffer.split("\n");
    const hasTrailingNewline = rawWithBuffer.endsWith("\n");
    const completeLines = allLines.slice(0, -1);

    // Absolute file byte offset where each complete line ends. A complete line always terminates at
    // a newline within `content` (the prepended incompleteLineBuffer never contains one), so we can
    // map each line's end to a file offset by walking content's newlines from this chunk's start.
    // Tracking ends per-line (not per-chunk) means a matched line followed by later complete output
    // in the same poll is suppressed as soon as the agent has read through that line specifically.
    const lineEndOffsets: number[] = [];
    const contentSegments = content.split("\n");
    let cursor = options.chunkStartOffset;
    for (let i = 0; i < contentSegments.length - 1; i++) {
      cursor += Buffer.byteLength(contentSegments[i], "utf8") + 1; // +1 for the "\n"
      lineEndOffsets.push(cursor);
    }

    const includeIncompleteLine = options.includeIncompleteLine === true;
    if (includeIncompleteLine && !hasTrailingNewline) {
      const last = allLines[allLines.length - 1];
      if (last.length > 0) {
        completeLines.push(last);
        // The promoted fragment ends at the end of this chunk's content.
        lineEndOffsets.push(options.chunkStartOffset + Buffer.byteLength(content, "utf8"));
      }
      monitor.incompleteLineBuffer = "";
    } else {
      const rawTrailingIncomplete = hasTrailingNewline ? "" : (allLines[allLines.length - 1] ?? "");
      monitor.incompleteLineBuffer = this.boundMonitorIncompleteLineBuffer(
        this.sanitizeMonitorLine(rawTrailingIncomplete)
      );
    }

    for (let i = 0; i < completeLines.length; i++) {
      if (monitor.stopped) break;
      const line = this.sanitizeMonitorLine(completeLines[i]);
      if (this.monitorMatchesLine(monitor, line)) {
        this.recordMonitorMatch(proc, line, lineEndOffsets[i]);
      }
    }
  }

  private recordMonitorProbeSuccess(
    monitor: BackgroundProcessMonitorState,
    operation: BashMonitorFailedOperation
  ): void {
    delete monitor.probeFailures[operation];
  }

  private recordMonitorProbeFailure(
    monitor: BackgroundProcessMonitorState,
    operation: BashMonitorFailedOperation,
    message: string
  ): MonitorPollingFailure | null {
    const previous = monitor.probeFailures[operation];
    const current: MonitorProbeFailureState = {
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      message,
    };
    monitor.probeFailures[operation] = current;

    const otherOperation: BashMonitorFailedOperation =
      operation === "readOutput" ? "getExitCode" : "readOutput";
    const otherFailure = monitor.probeFailures[otherOperation];
    if (otherFailure != null) {
      return new MonitorPollingFailure(
        `Background process monitor probes failed (${operation}: ${message}; ${otherOperation}: ${otherFailure.message})`,
        [operation, otherOperation]
      );
    }
    if (current.consecutiveFailures >= MAX_CONSECUTIVE_MONITOR_PROBE_FAILURES) {
      return new MonitorPollingFailure(
        `Background process monitor probe failed ${current.consecutiveFailures} consecutive times (${operation}: ${message})`,
        [operation]
      );
    }
    return null;
  }

  private async runMonitorProbe<T>(
    monitor: BackgroundProcessMonitorState,
    operation: BashMonitorFailedOperation,
    probe: () => Promise<BackgroundMonitorProbeResult<T>>,
    fallback: T
  ): Promise<T> {
    let result: BackgroundMonitorProbeResult<T>;
    try {
      result = await probe();
    } catch (error) {
      result = { success: false, error: getErrorMessage(error) };
    }
    if (result.success) {
      this.recordMonitorProbeSuccess(monitor, operation);
      return result.value;
    }
    const failure = this.recordMonitorProbeFailure(monitor, operation, result.error);
    if (failure != null) throw failure;
    return fallback;
  }

  private readOutputForMonitor(
    proc: BackgroundProcess,
    monitor: BackgroundProcessMonitorState,
    offset: number
  ): Promise<{ content: string; newOffset: number }> {
    const probe = proc.handle.readOutputForMonitor?.bind(proc.handle);
    return this.runMonitorProbe(
      monitor,
      "readOutput",
      probe != null
        ? () => probe(offset)
        : async () => {
            try {
              return { success: true, value: await proc.handle.readOutput(offset) };
            } catch (error) {
              return { success: false, error: getErrorMessage(error) };
            }
          },
      { content: "", newOffset: offset }
    );
  }

  private getExitCodeForMonitor(
    proc: BackgroundProcess,
    monitor: BackgroundProcessMonitorState
  ): Promise<number | null> {
    const probe = proc.handle.getExitCodeForMonitor?.bind(proc.handle);
    return this.runMonitorProbe(
      monitor,
      "getExitCode",
      probe != null
        ? () => probe()
        : async () => {
            try {
              return { success: true, value: await proc.handle.getExitCode() };
            } catch (error) {
              return { success: false, error: getErrorMessage(error) };
            }
          },
      null
    );
  }

  private startMonitorTail(proc: BackgroundProcess): void {
    void this.monitorTailLoop(proc.id).catch((error: unknown) => {
      const current = this.processes.get(proc.id);
      // Identity check: a stale tail from a removed generation must not retire the monitor of a
      // newer process that reused this display-name-derived ID. A claimed settlement also wins:
      // its owner emits the deterministic terminal wake, so a late probe rejection must not
      // convert a settling monitor into a runtime failure.
      if (
        current === proc &&
        current.monitor &&
        !current.monitor.stopped &&
        !current.monitor.settled
      ) {
        // No observer remains after this loop rejects. Stopping also makes later settlement claims
        // no-op, so this failure wake is the only lifecycle notice even if the process exits later.
        this.stopMonitor(current, true, "failed", {
          message: getErrorMessage(error),
          ...(error instanceof MonitorPollingFailure
            ? { failedOperations: [...error.failedOperations] }
            : {}),
        });
      }
      log.warn(
        `BackgroundProcessManager: monitor tail for ${proc.id} failed: ${getErrorMessage(error)}`
      );
    });
  }

  private async monitorTailLoop(processId: string): Promise<void> {
    while (true) {
      const proc = this.processes.get(processId);
      const monitor = proc?.monitor;
      if (!proc || !monitor || monitor.stopped || monitor.settled) return;

      const chunkStartOffset = monitor.lastReadOffset;
      const read = await this.readOutputForMonitor(proc, monitor, chunkStartOffset);
      // A settlement claim (e.g. a timeout terminate) during the await owns every remaining
      // byte; leave lastReadOffset untouched so its final scan re-reads this chunk.
      if (monitor.stopped || monitor.settled) return;
      if (read.newOffset < chunkStartOffset) {
        log.debug(`BackgroundProcessManager: monitor read offset moved backwards for ${processId}`);
        this.stopMonitor(proc, true);
        return;
      }

      // Check for exit BEFORE processing the just-read chunk: a matching line in the very chunk
      // that accompanies the exit must coalesce into the single settlement payload instead of
      // triggering a cooldown_ms=0 emit or maxEvents retirement ahead of it.
      let exitCode: number | null;
      try {
        exitCode = await this.getExitCodeForMonitor(proc, monitor);
      } catch (error) {
        // The exit-probe escalation retires the monitor through the tail catch, but the read
        // above already succeeded: fold its chunk into monitor state first, or the matched
        // lines would vanish from the failure payload (unrecoverable if the process
        // generation dies before the suggested task_await).
        if (!monitor.stopped && !monitor.settled) {
          monitor.lastReadOffset = read.newOffset;
          this.processMonitorContent(proc, read.content, { chunkStartOffset });
        }
        throw error;
      }
      if (monitor.stopped || monitor.settled) return;

      if (exitCode !== null) {
        // Claim synchronously before any further await so a pending cooldown timer cannot fire
        // during the redirect-lag sleep and a concurrent terminate cannot double-settle. The
        // claimed helper re-reads from lastReadOffset, so the unprocessed chunk above is scanned
        // exactly once, under settlement accumulation mode.
        const reservation = this.claimMonitorSettlement(proc);
        if (proc.status === "running") {
          proc.status = "exited";
          proc.exitCode = exitCode;
          proc.exitTime = Date.now();
          await this.updateMetaFile(proc).catch((err: unknown) => {
            log.debug(
              `BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`
            );
          });
          this.emitChange(proc.workspaceId);
        }

        if (!reservation) {
          // Shutdown suppressed the claim: keep the legacy exit flush so pending matched lines
          // still persist (mergeable with the restart monitor-lost notice); no terminal payload.
          monitor.lastReadOffset = read.newOffset;
          this.processMonitorContent(proc, read.content, { chunkStartOffset });
          // stdout/stderr redirection can lag exit-code observation by a tick.
          await new Promise((resolve) => setTimeout(resolve, monitor.pollIntervalMs));
          const finalChunkStartOffset = monitor.lastReadOffset;
          const finalRead = await proc.handle.readOutput(finalChunkStartOffset);
          monitor.lastReadOffset = finalRead.newOffset;
          this.processMonitorContent(proc, finalRead.content, {
            chunkStartOffset: finalChunkStartOffset,
            includeIncompleteLine: true,
          });
          this.stopMonitor(proc, true);
          return;
        }

        await this.emitClaimedMonitorSettlement(reservation, {
          // The status-update branch above narrowed "running" to "exited"; a concurrent
          // terminate may have set "killed"/"failed" instead — report whichever settled.
          status: proc.status,
          ...(proc.exitCode !== undefined ? { exitCode: proc.exitCode } : {}),
        });
        return;
      }

      monitor.lastReadOffset = read.newOffset;
      this.processMonitorContent(proc, read.content, { chunkStartOffset });

      await new Promise((resolve) => setTimeout(resolve, monitor.pollIntervalMs));
    }
  }

  /**
   * Get the base directory for background process output files.
   */
  getBgOutputDir(): string {
    return this.bgOutputDir;
  }

  /**
   * Generate a unique background process ID.
   *
   * Background process IDs are used as tool-visible identifiers (e.g. task_await with bash: IDs),
   * so they must be globally unique across all running processes.
   *
   * If the base ID is already in use, we append " (1)", " (2)", etc.
   */
  generateUniqueProcessId(baseId: string): string {
    assert(
      typeof baseId === "string" && baseId.length > 0,
      "BackgroundProcessManager.generateUniqueProcessId requires a non-empty baseId"
    );

    let processId = baseId;
    let suffix = 1;
    while (this.processes.has(processId) || this.reservedProcessIds.has(processId)) {
      processId = `${baseId} (${suffix})`;
      suffix++;
    }

    return processId;
  }

  /**
   * Allocate a unique process ID and reserve it in the same synchronous step.
   *
   * Foreground-to-background migration awaits between choosing its ID and registering the
   * migrated process; without a reservation, two concurrent same-name migrations would both
   * be handed the same ID and share one output directory and manager entry — the first exit
   * would then write the shared exit marker and settle the survivor's records, blinding
   * archive gating after an unclean restart. Callers release on success only after the
   * process is registered (the processes map then holds the name) and on failure only once
   * the process's exit settles, so an unverifiable survivor keeps its name reserved for the
   * session.
   */
  reserveUniqueProcessId(baseId: string): { processId: string; release: () => void } {
    const processId = this.generateUniqueProcessId(baseId);
    this.reservedProcessIds.add(processId);
    let released = false;
    return {
      processId,
      release: () => {
        if (released) return;
        released = true;
        this.reservedProcessIds.delete(processId);
      },
    };
  }

  /**
   * Spawn a new process with background-style infrastructure.
   *
   * All processes are spawned with nohup/setsid and file-based output,
   * enabling seamless fg→bg transition via sendToBackground().
   *
   * @param runtime Runtime to spawn the process on
   * @param workspaceId Workspace ID for tracking/filtering
   * @param script Bash script to execute
   * @param config Execution configuration
   */
  async spawn(
    runtime: Runtime,
    workspaceId: string,
    script: string,
    config: {
      cwd: string;
      env?: Record<string, string>;
      pathEnv?: Record<string, string>;
      /** Human-readable name for the process - used to generate the process ID */
      displayName: string;
      /** If true, process is foreground (being waited on). Default: false (background) */
      isForeground?: boolean;
      /** Optional write-time monitor for background output. */
      monitor?: BackgroundProcessMonitorConfig;
      /** Auto-terminate after this many seconds (background processes only) */
      timeoutSecs?: number;
    }
  ): Promise<
    | { success: true; processId: string; outputDir: string; pid: number }
    | { success: false; error: string }
  > {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    let processId = this.generateUniqueProcessId(config.displayName);
    // Reserved synchronously in the same tick each candidate is chosen (see
    // reservedProcessIds): the awaits below would otherwise let a concurrent same-name spawn
    // allocate the same directory. Released when this spawn registers or returns — the
    // disposer reads the current processId, which the disk loop keeps in sync. Failed
    // non-host-record spawns keep their reservation for the app session (see below).
    this.reservedProcessIds.add(processId);
    let retainReservationAfterFailure = false;
    using _reservation = {
      [Symbol.dispose]: () => {
        if (!retainReservationAfterFailure) {
          this.reservedProcessIds.delete(processId);
        }
      },
    };
    // Restart-unique directories: skip names whose durable directory may still belong to a
    // surviving process from a previous session — see localSpawnDirMayHoldLiveProcess for
    // why reuse would blind archive gating. Host-local records are probed on the local
    // filesystem with host PID checks; all other layouts (SSH/Coder, Docker, devcontainer)
    // live in the runtime's exec namespace and are probed through the runtime instead.
    if (spawnRecordsAreHostLocal(runtime)) {
      let suffix = 2;
      while (await this.localSpawnDirMayHoldLiveProcess(workspaceId, processId)) {
        this.reservedProcessIds.delete(processId);
        do {
          processId = `${config.displayName} (${suffix})`;
          suffix++;
        } while (this.processes.has(processId) || this.reservedProcessIds.has(processId));
        this.reservedProcessIds.add(processId);
      }
    } else {
      let suffix = 2;
      for (;;) {
        const probe = await this.runtimeSpawnDirMayHoldLiveProcess(runtime, workspaceId, processId);
        if (probe === "free") break;
        if (probe !== "held") {
          // Unreachable/garbled probe: abort rather than loop forever against a dead host.
          // Nothing was written under this name, so the reservation is safe to release.
          return { success: false, error: probe.error };
        }
        this.reservedProcessIds.delete(processId);
        do {
          processId = `${config.displayName} (${suffix})`;
          suffix++;
        } while (this.processes.has(processId) || this.reservedProcessIds.has(processId));
        this.reservedProcessIds.add(processId);
      }
    }

    // Spawn via executor with background infrastructure
    // spawnProcess uses runtime.tempDir() internally for output directory
    const result = await spawnProcess(runtime, script, {
      cwd: config.cwd,
      workspaceId,
      processId,
      env: config.env,
      pathEnv: config.pathEnv,
    });

    if (!result.success) {
      log.debug(`BackgroundProcessManager: Failed to spawn: ${result.error}`);
      // Non-host record layouts: a failed spawn may leave the record directory holding a
      // live detached process (preserved ambiguous PID echo, post-dispatch transport throw,
      // or a failed best-effort cleanup), and the local disk probe above cannot see those
      // layouts for a same-session retry. Retain the name reservation for this app session
      // so a retry of the same display name allocates a fresh directory instead of
      // truncating the survivor's output and sharing its exit marker (fail closed — the
      // only cost is a suffixed name).
      retainReservationAfterFailure = !spawnRecordsAreHostLocal(runtime);
      return { success: false, error: result.error };
    }

    const { handle, pid, outputDir } = result;
    const startTime = Date.now();

    // Write meta.json with process info
    const meta: BackgroundProcessMeta = {
      id: processId,
      pid,
      script,
      startTime,
      status: "running",
      displayName: config.displayName,
    };
    try {
      await handle.writeMeta(JSON.stringify(meta, null, 2));
    } catch (error) {
      // The durable spawn record is what lets crash-orphan archive gating see this process
      // after an unclean restart — a process that cannot be recorded must not run (fail
      // closed). terminate() also writes the exit_code marker, so even this directory reads
      // as exited to the unreadable-record probe; if termination fails too, the markerless
      // directory keeps failing that probe closed.
      await handle.terminate();
      await handle.dispose();
      // Same retention rationale as the spawn-failure path above: if the termination also
      // failed (e.g. the same transport fault that broke writeMeta), a non-host record
      // directory may still hold the live process.
      retainReservationAfterFailure = !spawnRecordsAreHostLocal(runtime);
      return {
        success: false,
        error: `Failed to persist the spawn record (meta.json): ${getErrorMessage(error)}`,
      };
    }

    const proc: BackgroundProcess = {
      id: processId,
      pid,
      workspaceId,
      outputDir,
      script,
      startTime,
      status: "running",
      handle,
      displayName: config.displayName,
      isForeground: config.isForeground ?? false,
      outputBytesRead: 0,
      shownThroughOffset: 0,
      terminalStatusShownToAgent: false,
      outputLock: new AsyncMutex(),
      getOutputCallCount: 0,
      incompleteLineBuffer: "",
    };

    // Store process in map
    this.processes.set(processId, proc);

    if (config.monitor && !proc.isForeground) {
      const pollIntervalMs =
        runtime instanceof LocalBaseRuntime
          ? MONITOR_POLL_INTERVAL_MS_LOCAL
          : MONITOR_POLL_INTERVAL_MS_REMOTE;
      const armMetadata: MonitorArmedPayload = {
        processId,
        taskId: `bash:${processId}`,
        workspaceId,
        displayName: config.displayName,
        filter: config.monitor.filter,
        filterExclude: config.monitor.exclude,
        script,
        createdAt: new Date().toISOString(),
      };
      proc.monitor = this.createMonitorState(config.monitor, { pollIntervalMs, armMetadata });
      this.startMonitorTail(proc);
      // spawn() is the only place monitors are ever armed (registerMigratedProcess never
      // sets one), so this single emit keeps the persisted armed-monitor registry complete.
      this.emit("monitor:armed", workspaceId, armMetadata);
    }

    log.debug(
      `Process ${processId} spawned successfully with PID ${pid} (foreground: ${proc.isForeground})`
    );

    // Schedule auto-termination for background processes with timeout
    const timeoutSecs = config.timeoutSecs;
    if (!config.isForeground && timeoutSecs !== undefined && timeoutSecs > 0) {
      setTimeout(() => {
        void this.terminate(processId, { monitorDisposition: "flush" }).then((result) => {
          if (result.success) {
            log.debug(`Process ${processId} auto-terminated after ${timeoutSecs}s timeout`);
          }
        });
      }, timeoutSecs * 1000);
    }

    // Emit change event (only if background - foreground processes don't show in list)
    if (!proc.isForeground) {
      this.emitChange(workspaceId);
    }

    return { success: true, processId, outputDir, pid };
  }

  /**
   * Register a foreground process that can be sent to background.
   * Called by bash tool when starting foreground execution.
   *
   * @param workspaceId Workspace the process belongs to
   * @param toolCallId Tool call ID (for UI to identify which bash row)
   * @param script Script being executed
   * @param onBackground Callback invoked when user requests backgrounding
   * @returns Cleanup function to call when process completes
   */
  registerForegroundProcess(
    workspaceId: string,
    toolCallId: string,
    script: string,
    displayName: string,
    onBackground: () => void
  ): { unregister: () => void; addOutput: (line: string) => void } {
    const proc: ForegroundProcess = {
      workspaceId,
      toolCallId,
      script,
      displayName,
      onBackground,
      output: [],
    };
    this.foregroundProcesses.set(toolCallId, proc);
    log.debug(
      `Registered foreground process for workspace ${workspaceId}, toolCallId ${toolCallId}`
    );
    this.emitChange(workspaceId);

    return {
      unregister: () => {
        this.foregroundProcesses.delete(toolCallId);
        log.debug(`Unregistered foreground process toolCallId ${toolCallId}`);
        this.emitChange(workspaceId);
      },
      addOutput: (line: string) => {
        proc.output.push(line);
      },
    };
  }

  /**
   * Register a migrated foreground process as a tracked background process.
   *
   * Called by bash tool when migration completes, after migrateToBackground()
   * has created the output directory and started file writing.
   *
   * @param handle The BackgroundHandle from migrateToBackground()
   * @param processId The generated process ID
   * @param workspaceId Workspace the process belongs to
   * @param script Original script being executed
   * @param outputDir Directory containing output files
   * @param displayName Optional human-readable name
   */
  registerMigratedProcess(
    handle: BackgroundHandle,
    processId: string,
    workspaceId: string,
    script: string,
    outputDir: string,
    displayName?: string
  ): void {
    const startTime = Date.now();

    const proc: BackgroundProcess = {
      id: processId,
      pid: 0, // Unknown for migrated processes (could be remote)
      workspaceId,
      outputDir,
      script,
      startTime,
      status: "running",
      handle,
      displayName,
      isForeground: false, // Now in background
      outputBytesRead: 0,
      shownThroughOffset: 0,
      terminalStatusShownToAgent: false,
      outputLock: new AsyncMutex(),
      getOutputCallCount: 0,
      incompleteLineBuffer: "",
    };

    // Store process in map
    this.processes.set(processId, proc);

    // Write meta.json
    const meta: BackgroundProcessMeta = {
      id: processId,
      pid: 0,
      script,
      startTime,
      status: "running",
      displayName,
    };
    void handle.writeMeta(JSON.stringify(meta, null, 2));

    log.debug(`Migrated process ${processId} registered for workspace ${workspaceId}`);
    this.emitChange(workspaceId);
  }

  /**
   * Send a foreground process to background.
   *
   * For processes started with background infrastructure (isForeground=true in spawn):
   * - Marks as background and emits 'backgrounded' event
   *
   * For processes started via runtime.exec (tracked via registerForegroundProcess):
   * - Invokes the onBackground callback to trigger early return
   *
   * @param toolCallId The tool call ID of the bash to background
   * @returns Success status
   */
  sendToBackground(toolCallId: string): { success: true } | { success: false; error: string } {
    log.debug(`BackgroundProcessManager.sendToBackground(${toolCallId}) called`);

    const fgProc = this.foregroundProcesses.get(toolCallId);
    if (fgProc) {
      fgProc.onBackground();
      log.debug(`Foreground process toolCallId ${toolCallId} sent to background`);
      return { success: true };
    }

    return { success: false, error: "No foreground process found with that tool call ID" };
  }

  /**
   * Get all foreground tool call IDs for a workspace.
   * Returns empty array if no foreground processes are running.
   */
  getForegroundToolCallIds(workspaceId: string): string[] {
    const ids: string[] = [];
    // Check exec-based foreground processes
    for (const [toolCallId, proc] of this.foregroundProcesses) {
      if (proc.workspaceId === workspaceId) {
        ids.push(toolCallId);
      }
    }
    return ids;
  }

  /**
   * Write/update meta.json for a process
   */
  private async updateMetaFile(proc: BackgroundProcess): Promise<void> {
    const meta: BackgroundProcessMeta = {
      id: proc.id,
      pid: proc.pid,
      script: proc.script,
      startTime: proc.startTime,
      status: proc.status,
      exitCode: proc.exitCode,
      exitTime: proc.exitTime,
    };
    const metaJson = JSON.stringify(meta, null, 2);

    await proc.handle.writeMeta(metaJson);
  }

  /** Return the in-memory process without probing its runtime handle. */
  peekProcess(processId: string): BackgroundProcess | null {
    return this.processes.get(processId) ?? null;
  }

  /**
   * Get a background process by ID.
   * Refreshes status if the process is still marked as running.
   */
  async getProcess(processId: string): Promise<BackgroundProcess | null> {
    log.debug(`BackgroundProcessManager.getProcess(${processId}) called`);
    const proc = this.processes.get(processId);
    if (!proc) return null;

    // Refresh status if still running (exit code null = still running)
    if (proc.status === "running") {
      const exitCode = await proc.handle.getExitCode();
      if (exitCode !== null) {
        log.debug(`Background process ${proc.id} has exited`);
        proc.status = "exited";
        proc.exitCode = exitCode;
        proc.exitTime = Date.now();
        await this.updateMetaFile(proc).catch((err: unknown) => {
          log.debug(
            `BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`
          );
        });
        this.emitChange(proc.workspaceId);
      }
    }

    return proc;
  }

  /**
   * Register a read that same-process monitor delivery must wait for. Unfiltered reads participate
   * because they can advance the shown frontier. Filtered task_await reads also participate so the
   * wake cannot interrupt the await that is already watching this process; after the await settles,
   * the unchanged frontier still allows filtered-out matched output to wake the agent.
   */
  private trackMonitorWakeBlockingRead(
    proc: BackgroundProcess,
    filter: string | undefined,
    noteToolName: string | undefined
  ): Disposable {
    if (filter && noteToolName !== "task_await") {
      return { [Symbol.dispose]: () => undefined };
    }
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    proc.monitorWakeBlockingReadSettled = settled;
    return {
      [Symbol.dispose]: () => {
        // A later read only starts after this one releases outputLock, so the field is still ours.
        if (proc.monitorWakeBlockingReadSettled === settled) {
          proc.monitorWakeBlockingReadSettled = undefined;
        }
        resolve();
      },
    };
  }

  /**
   * Snapshot whether same-process monitor delivery is currently blocked by an output read. Returning
   * the blocking promise lets the workspace defer only this process's wake while continuing to
   * deliver unrelated monitor matches from the same workspace.
   *
   * `originNotAfterMs` binds the answer to the process instance that produced the wake. Process IDs
   * are reclaimed across restarts, so a newer instance must not suppress an older instance's wake.
   */
  pullMonitorWakeSignals(ownerWorkspaceId: string): readonly BashMonitorProcessSnapshot[] {
    const snapshots: BashMonitorProcessSnapshot[] = [];
    for (const proc of this.processes.values()) {
      const monitor = proc.monitor;
      if (proc.workspaceId !== ownerWorkspaceId || monitor == null) continue;
      const match =
        monitor.retainedMatches.length === 0
          ? undefined
          : {
              batches: monitor.retainedMatches.map((batch) => ({
                throughOffset: batch.matchedThroughOffset,
                lines: [...batch.lines],
                totalMatches: batch.totalMatches,
                droppedLines: batch.droppedLines,
              })),
              throughOffset:
                monitor.retainedMatches[monitor.retainedMatches.length - 1].matchedThroughOffset,
              lines: monitor.retainedMatches.flatMap((batch) => batch.lines),
              totalMatches:
                monitor.retainedMatches[monitor.retainedMatches.length - 1].totalMatches,
              droppedLines: monitor.retainedMatches.reduce(
                (total, batch) => total + batch.droppedLines,
                0
              ),
            };
      snapshots.push({
        processId: proc.id,
        taskId: monitor.armMetadata.taskId,
        ownerWorkspaceId: proc.workspaceId,
        ...(proc.displayName !== undefined ? { displayName: proc.displayName } : {}),
        filter: monitor.filter,
        filterExclude: monitor.exclude,
        script: boundBashMonitorRegistryScript(proc.script),
        createdAt: monitor.armMetadata.createdAt,
        ...(match != null
          ? {
              match: {
                batches: match.batches,
                throughOffset: match.throughOffset,
                lines: [...match.lines],
                totalMatches: match.totalMatches,
                ...(match.droppedLines > 0 ? { droppedLines: match.droppedLines } : {}),
              },
            }
          : {}),
        ...(monitor.settlementDisposition != null
          ? {
              terminal: {
                status: monitor.settlementDisposition.status,
                ...(monitor.settlementDisposition.exitCode !== undefined
                  ? { exitCode: monitor.settlementDisposition.exitCode }
                  : {}),
                settledAt: monitor.settlementDisposition.settledAt,
                wakeOnExit: monitor.settlementDisposition.wakeOnExit,
                terminalStatusShown: monitor.settlementDisposition.terminalStatusShown,
                ...(monitor.settlementDisposition.matchedThroughOffset != null
                  ? { matchedThroughOffset: monitor.settlementDisposition.matchedThroughOffset }
                  : {}),
                tailLines: monitor.settlementDisposition.tailLines.map((entry) => ({ ...entry })),
              },
            }
          : {}),
        retired: monitor.stopped,
      });
    }
    return snapshots;
  }

  acknowledgeMonitorWake(
    processId: string,
    originNotAfterMs: number,
    matchedThroughOffset?: number,
    terminalSettledAt?: string
  ): void {
    if (matchedThroughOffset != null) {
      this.dropMonitorMatchedLineBatchesThrough(processId, originNotAfterMs, matchedThroughOffset);
    }
    if (terminalSettledAt != null) {
      const proc = this.processes.get(processId);
      if (
        proc != null &&
        proc.startTime <= originNotAfterMs &&
        proc.monitor?.settlementDisposition?.settledAt === terminalSettledAt
      ) {
        proc.monitor.settlementDisposition = undefined;
      }
    }
  }

  dropRetiredMonitor(processId: string, createdAt: string): void {
    const proc = this.processes.get(processId);
    if (proc?.monitor?.stopped && proc.monitor.armMetadata.createdAt === createdAt) {
      proc.monitor = undefined;
    }
  }

  dropMonitorMatchedLineBatchesThrough(
    processId: string,
    originNotAfterMs: number,
    matchedThroughOffset: number
  ): void {
    const proc = this.processes.get(processId);
    if (proc == null || !(proc.startTime <= originNotAfterMs)) return;
    const monitor = proc.monitor;
    if (monitor == null) return;
    monitor.retainedMatches = monitor.retainedMatches.filter(
      (batch) => batch.matchedThroughOffset > matchedThroughOffset
    );
  }

  getMonitorWakeDeliveryState(
    processId: string,
    originNotAfterMs?: number
  ): Promise<MonitorWakeDeliveryState | undefined> {
    const proc = this.processes.get(processId);
    if (proc == null || (originNotAfterMs != null && !(proc.startTime <= originNotAfterMs))) {
      return Promise.resolve(undefined);
    }
    if (proc.monitorWakeBlockingReadSettled) {
      return Promise.resolve({
        status: "blocked",
        readSettled: proc.monitorWakeBlockingReadSettled,
      });
    }
    return Promise.resolve({
      status: "settled",
      shownThroughOffset: proc.shownThroughOffset,
      terminalStatusShown: proc.terminalStatusShownToAgent,
    });
  }

  /**
   * The shown-frontier after all same-process blocking reads settle. Kept as a convenience for
   * callers that need the final value rather than a non-blocking delivery decision.
   */
  async getSettledShownThroughOffset(
    processId: string,
    originNotAfterMs?: number
  ): Promise<number | undefined> {
    while (true) {
      const state = await this.getMonitorWakeDeliveryState(processId, originNotAfterMs);
      if (state == null) return undefined;
      if (state.status === "settled") return state.shownThroughOffset;
      await state.readSettled;
    }
  }

  /**
   * Get incremental output from a background process.
   * Returns only NEW output since the last call (tracked per process).
   * @param processId Process ID to get output from
   * @param filter Optional regex pattern to filter output lines (non-matching lines are discarded permanently)
   * @param filterExclude When true, invert filter to exclude matching lines instead of keeping them
   * @param timeout Seconds to wait for output if none available (default 0 = non-blocking)
   * @param abortSignal Optional signal to abort waiting early (e.g., when stream is cancelled)
   * @param workspaceId Optional workspace ID to check for queued messages (return early to process them)
   * @param noteToolName Optional tool name to use in polling guidance notes
   */
  async getOutput(
    processId: string,
    filter?: string,
    filterExclude?: boolean,
    timeout?: number,
    abortSignal?: AbortSignal,
    workspaceId?: string,
    noteToolName?: string
  ): Promise<
    | {
        success: true;
        status: "running" | "exited" | "killed" | "failed" | "interrupted";
        output: string;
        exitCode?: number;
        elapsed_ms: number;
        note?: string;
      }
    | { success: false; error: string }
  > {
    const timeoutSecs = Math.max(timeout ?? 0, 0);
    log.debug(
      `BackgroundProcessManager.getOutput(${processId}, filter=${filter ?? "none"}, exclude=${filterExclude ?? false}, timeout=${timeoutSecs}s) called`
    );

    // Validate: filter_exclude requires filter
    if (filterExclude && !filter) {
      return { success: false, error: "filter_exclude requires filter to be set" };
    }

    const proc = await this.getProcess(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    // Acquire per-process mutex to serialize concurrent getOutput() calls.
    // This prevents race conditions where parallel tool calls both read from
    // the same offset before either updates the read position.
    await using _lock = await proc.outputLock.acquire();

    // Register reads that same-process monitor delivery must not race. This includes filtered
    // task_await calls even though they do not advance shownThroughOffset: the wake waits for the
    // await to settle, then remains deliverable if its matched output was filtered out.
    using _readTracker = this.trackMonitorWakeBlockingRead(proc, filter, noteToolName);

    // Track call count for polling detection
    proc.getOutputCallCount++;
    const callCount = proc.getOutputCallCount;

    log.debug(
      `BackgroundProcessManager.getOutput: proc.outputDir=${proc.outputDir}, offset=${proc.outputBytesRead}, callCount=${callCount}`
    );

    // Pre-compile regex if filter is provided
    let filterRegex: RegExp | undefined;
    if (filter) {
      try {
        filterRegex = new RegExp(filter);
      } catch (e) {
        return { success: false, error: `Invalid filter regex: ${getErrorMessage(e)}` };
      }
    }

    // Apply filtering to complete lines only
    // Incomplete line fragments (no trailing newline) are kept in buffer for next read
    const applyFilter = (lines: string[]): string => {
      if (!filterRegex) return lines.join("\n");
      const filtered = filterExclude
        ? lines.filter((line) => !filterRegex.test(line))
        : lines.filter((line) => filterRegex.test(line));
      return filtered.join("\n");
    };

    // Blocking wait loop: poll for output up to timeout seconds
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;
    const pollIntervalMs = 100;
    let accumulatedRaw = "";
    let currentStatus = proc.status;

    // Track the previous buffer to prepend to accumulated output
    const previousBuffer = proc.incompleteLineBuffer;
    // File offset where this read's processable content begins (start cursor minus the buffered
    // fragment that cursor already advanced past). Used below to detect a gap left by a prior
    // filtered read so the shown-frontier never jumps over lines this read never showed.
    const readStartOffset = proc.outputBytesRead;

    while (true) {
      // Read new content via the handle (works for both local and SSH runtimes)
      // Output is already unified in output.log (stdout + stderr via 2>&1)
      const result = await proc.handle.readOutput(proc.outputBytesRead);
      accumulatedRaw += result.content;

      // Update read position
      proc.outputBytesRead = result.newOffset;

      // Refresh process status
      const refreshedProc = await this.getProcess(processId);
      currentStatus = refreshedProc?.status ?? proc.status;

      // Line-buffered filtering: prepend incomplete line from previous call
      const rawWithBuffer = previousBuffer + accumulatedRaw;
      const allLines = rawWithBuffer.split("\n");

      // Drop the last element: it's either empty (content ended with "\n") or the incomplete
      // trailing fragment, which is buffered for the next read -- so it's never a complete line.
      const completeLines = allLines.slice(0, -1);

      // When using filter_exclude, check if we have meaningful (non-excluded) output.
      // We only consider complete lines as "meaningful" here; fragments are buffered for the next read.
      const filteredOutput = applyFilter(completeLines);
      const hasMeaningfulOutput = filterExclude
        ? filteredOutput.trim().length > 0
        : completeLines.length > 0;

      // Return immediately if:
      // 1. We have meaningful output (after filtering if filter_exclude is set)
      // 2. Timeout elapsed
      // 3. Abort signal received (user sent a new message)
      if (hasMeaningfulOutput) {
        break;
      }

      // If the process is no longer running (exited/killed/failed), do one last read
      // to avoid dropping output that arrives between our readOutput() call and
      // the status refresh.
      if (currentStatus !== "running") {
        while (true) {
          const finalRead = await proc.handle.readOutput(proc.outputBytesRead);
          if (finalRead.content.length === 0) {
            break;
          }

          // Defensive: avoid infinite loops if a handle returns inconsistent offsets.
          if (finalRead.newOffset <= proc.outputBytesRead) {
            break;
          }

          accumulatedRaw += finalRead.content;
          proc.outputBytesRead = finalRead.newOffset;
        }

        break;
      }

      if (abortSignal?.aborted || (workspaceId && this.hasQueuedMessage(workspaceId))) {
        // We already advanced outputBytesRead while reading this iteration, so any bytes consumed
        // so far live only in accumulatedRaw. The interrupted path returns without flushing them,
        // so preserve them in the line buffer; otherwise the next getOutput() would resume past
        // this content and silently drop it. This matters now that task_await aborts a still-
        // pending bash read once min_completed is satisfied (not just on user interrupt).
        proc.incompleteLineBuffer = previousBuffer + accumulatedRaw;
        const elapsed_ms = Date.now() - startTime;
        return {
          success: true,
          status: "interrupted",
          output: "(waiting interrupted)",
          elapsed_ms,
        };
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        break;
      }

      // Sleep before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Final line processing with buffer from previous call

    // If the process exited, do a final drain of output.
    //
    // Rationale: stdout/stderr writes can land just after we observe that the process
    // has exited. Without a final drain, we can return "exited" with empty output
    // even though output becomes available moments later.
    if (currentStatus !== "running") {
      const offsetBeforeDrain = proc.outputBytesRead;

      while (true) {
        const extra = await proc.handle.readOutput(proc.outputBytesRead);
        if (extra.content.length === 0) {
          break;
        }
        accumulatedRaw += extra.content;
        proc.outputBytesRead = extra.newOffset;
      }

      // If we didn't observe any new output, wait one poll interval and try once more.
      if (proc.outputBytesRead === offsetBeforeDrain) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        while (true) {
          const extra = await proc.handle.readOutput(proc.outputBytesRead);
          if (extra.content.length === 0) {
            break;
          }
          accumulatedRaw += extra.content;
          proc.outputBytesRead = extra.newOffset;
        }
      }
    }
    const rawWithBuffer = previousBuffer + accumulatedRaw;
    const allLines = rawWithBuffer.split("\n");
    const hasTrailingNewline = rawWithBuffer.endsWith("\n");

    // On process exit, include incomplete line; otherwise keep it buffered
    const linesToReturn =
      currentStatus !== "running"
        ? allLines.filter((l) => l.length > 0) // Include all non-empty lines on exit
        : allLines.slice(0, -1); // While running, drop the trailing fragment (buffered for next read)

    // Update buffer for next call (clear on exit, keep incomplete line otherwise)
    proc.incompleteLineBuffer =
      currentStatus === "running" && !hasTrailingNewline ? allLines[allLines.length - 1] : "";

    const shownThroughOffsetBeforeRead = proc.shownThroughOffset;
    const terminalStatusShownBeforeRead = proc.terminalStatusShownToAgent;

    // Wake suppression must track what the OWNER workspace's agent saw: task_await lets an
    // ancestor workspace read a descendant agent's bash task, and marking the frontier or
    // terminal status shown on such a cross-workspace read would suppress the owner's wake even
    // though the owning agent never saw the report (it would stay idle instead of resuming).
    // A missing workspaceId (internal/test callers; both model-visible tools pass one) counts as
    // the owner: over-marking there can only suppress, so default to the historical behavior.
    const consumerIsOwner = workspaceId == null || workspaceId === proc.workspaceId;

    // A read that reports a terminal status has shown the settlement to the agent — filtered or
    // not (status/exitCode are never filtered out of tool results, and the exit drain above
    // returned all remaining output). getOutput's only callers are model-visible (task_await and
    // bash_output); UI previews go through peekOutput/list, which never mark.
    if (currentStatus !== "running" && consumerIsOwner) {
      proc.terminalStatusShownToAgent = true;
    }

    // Advance the monitor's "shown through" mark only on unfiltered reads. A filtered read may have
    // dropped matched lines, so it must not count as having shown them. End-of-last-complete-line =
    // read cursor minus the trailing fragment we just buffered (cleared, hence 0, on exit). Offsets
    // only grow; Math.max guards against any out-of-order/partial call regressing the mark.
    //
    // Contiguity guard: outputBytesRead is a shared cursor that *filtered* reads also advance while
    // dropping non-matching complete lines. If a prior filtered read consumed lines past our last
    // shown frontier, this read starts beyond that frontier (shownRegionStart > shownThroughOffset)
    // and those skipped lines were never shown to the agent. Advancing across that gap would let a
    // wake for filtered-out output be wrongly suppressed, so only advance when this read's content
    // is contiguous with the frontier. A gap pins the frontier low (safe: it can only over-wake).
    if (!filter && consumerIsOwner) {
      const shownRegionStart = readStartOffset - Buffer.byteLength(previousBuffer, "utf8");
      if (shownRegionStart <= proc.shownThroughOffset) {
        const shownThrough =
          proc.outputBytesRead - Buffer.byteLength(proc.incompleteLineBuffer, "utf8");
        proc.shownThroughOffset = Math.max(proc.shownThroughOffset, shownThrough);
      }
    }

    log.debug(
      `BackgroundProcessManager.getOutput: read rawLen=${accumulatedRaw.length}, completeLines=${linesToReturn.length}`
    );

    const filteredOutput = applyFilter(linesToReturn);

    if (
      proc.shownThroughOffset > shownThroughOffsetBeforeRead ||
      (proc.terminalStatusShownToAgent && !terminalStatusShownBeforeRead)
    ) {
      // A wake can queue between sequential task_await reads. Notify the workspace after each
      // frontier advance so it can retract that queued wake before the next turn accepts it.
      // The terminal-shown transition emits too: a filtered post-exit read or a zero-output exit
      // never advances the offset, yet must still retract a queued settlement wake.
      this.emit("output:shown", proc.workspaceId, {
        processId: proc.id,
        processStartTime: proc.startTime,
        shownThroughOffset: proc.shownThroughOffset,
        terminalStatusShown: proc.terminalStatusShownToAgent,
      });
    }

    // Suggest filter_exclude if polling too frequently on a running process
    const shouldSuggestFilterExclude =
      callCount >= 3 && !filterExclude && currentStatus === "running";

    // Suggest better pattern if using filter_exclude but still polling frequently
    const shouldSuggestBetterPattern =
      callCount >= 3 && filterExclude && currentStatus === "running";

    const pollingToolName = noteToolName ?? "bash_output";

    let note: string | undefined;
    if (shouldSuggestFilterExclude) {
      note =
        `STOP POLLING. You've called ${pollingToolName} 3+ times on this process. ` +
        "This wastes tokens and clutters the conversation. " +
        "Instead, make ONE call with: filter='⏳|progress|waiting|\\\\\\.\\\\\\.\\\\\\.', " +
        "filter_exclude=true, timeout_secs=120. This blocks until meaningful output arrives.";
    } else if (shouldSuggestBetterPattern) {
      note =
        "You're using filter_exclude but still polling frequently. " +
        "Your filter pattern may not be matching the actual output. " +
        "Try a broader pattern like: filter='\\\\.|\\\\d+%|running|progress|pending|⏳|waiting'. " +
        "Wait for the FULL timeout before checking again.";
    }

    return {
      success: true,
      status: currentStatus,
      output: filteredOutput,
      exitCode:
        currentStatus !== "running"
          ? ((await this.getProcess(processId))?.exitCode ?? undefined)
          : undefined,
      elapsed_ms: Date.now() - startTime,
      note,
    };
  }

  /**
   * Peek output from a background process without advancing its incremental cursor.
   *
   * Used by the UI to display buffered output for background bashes. Unlike getOutput(),
   * this must NOT mutate proc.outputBytesRead/proc.incompleteLineBuffer (which are used by
   * bash_output + task_await).
   */
  async peekOutput(
    processId: string,
    options?: { fromOffset?: number; tailBytes?: number }
  ): Promise<
    | {
        success: true;
        status: "running" | "exited" | "killed" | "failed";
        output: string;
        nextOffset: number;
        truncatedStart: boolean;
      }
    | { success: false; error: string }
  > {
    const fromOffset = options?.fromOffset;
    const tailBytesRaw = options?.tailBytes;

    log.debug(
      `BackgroundProcessManager.peekOutput(${processId}, fromOffset=${fromOffset ?? "tail"}, tailBytes=${tailBytesRaw ?? DEFAULT_BACKGROUND_BASH_TAIL_BYTES}) called`
    );

    if (fromOffset !== undefined && (!Number.isFinite(fromOffset) || fromOffset < 0)) {
      return { success: false, error: `Invalid fromOffset: ${fromOffset}` };
    }

    const tailBytes = tailBytesRaw ?? DEFAULT_BACKGROUND_BASH_TAIL_BYTES;
    if (!Number.isFinite(tailBytes) || tailBytes <= 0) {
      return { success: false, error: `Invalid tailBytes: ${String(tailBytesRaw)}` };
    }
    const clampedTailBytes = Math.min(tailBytes, MAX_BACKGROUND_BASH_TAIL_BYTES);

    const proc = await this.getProcess(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    let offset = fromOffset;
    let truncatedStart = false;

    if (offset === undefined) {
      const fileSizeBytes = await proc.handle.getOutputFileSize();
      offset = computeTailStartOffset(fileSizeBytes, clampedTailBytes);
      truncatedStart = offset > 0;
    }

    const result = await proc.handle.readOutput(offset);
    assert(
      result.newOffset >= offset,
      `BackgroundHandle.readOutput returned newOffset < offset (offset=${offset}, newOffset=${result.newOffset})`
    );

    return {
      success: true,
      status: proc.status,
      output: result.content,
      nextOffset: result.newOffset,
      truncatedStart,
    };
  }

  getRunningProcessCount(): number {
    let count = 0;
    for (const process of this.processes.values()) {
      if (process.status === "running") count++;
    }
    return count;
  }

  /**
   * Synchronous snapshot: whether any tracked background (non-foreground) process for the
   * workspace is still marked running. Statuses refresh lazily (see list()), so a just-exited
   * process may briefly read as running; archive admission gates treat that as fail-safe
   * over-refusal — callers wanting fresh statuses should await list() first.
   */
  hasRunningBackgroundProcesses(workspaceId: string): boolean {
    assert(workspaceId.length > 0, "hasRunningBackgroundProcesses requires workspaceId");
    return Array.from(this.processes.values()).some(
      (p) => !p.isForeground && p.workspaceId === workspaceId && p.status === "running"
    );
  }

  /**
   * Crash-orphan probe: whether a durable spawn record shows a still-running process for this
   * workspace that this manager does not track. Processes run under nohup/setsid, so they
   * survive an unclean app shutdown while the in-memory map resets; without this probe the
   * archive gates would report "no background processes" after a restart and a model-driven
   * snapshot archive could remove the checkout while the surviving process still writes to it.
   * The spawn layout persists per-process meta.json plus an exit_code file written by the
   * wrapper's exit trap even when the app is gone, so orphans stay detectable: a record still
   * marked running with no exit_code file and a live PID fails the gate closed.
   *
   * Host filesystem only: remote (SSH/Docker) spawn records live on the remote host, and the
   * checkout-deletion hazard this guards is limited to local managed worktrees. Devcontainer
   * records live inside the container under `<workspace>/.xum/tmp` — host-visible through the
   * workspace bind mount — so callers pass that root via extraRecordDirs; its PIDs are
   * container-namespace and cannot be probed from the host, so any running record there is
   * treated as live. A recycled PID can cause a false positive, which errs on the safe side —
   * the model-facing caller routes to user-mediated archive.
   */
  async hasOrphanedRunningBackgroundProcesses(
    workspaceId: string,
    options?: { extraRecordDirs?: string[] }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "hasOrphanedRunningBackgroundProcesses requires workspaceId");
    const roots: Array<{ dir: string; pidsAreHostNamespace: boolean }> = [
      { dir: localBgWorkspaceDir(workspaceId), pidsAreHostNamespace: true },
      ...(options?.extraRecordDirs ?? []).map((dir) => ({ dir, pidsAreHostNamespace: false })),
    ];
    for (const root of roots) {
      if (await this.recordRootHoldsOrphan(workspaceId, root.dir, root.pidsAreHostNamespace)) {
        return true;
      }
    }
    return false;
  }

  /** One record root's scan for hasOrphanedRunningBackgroundProcesses. */
  private async recordRootHoldsOrphan(
    workspaceId: string,
    workspaceDir: string,
    pidsAreHostNamespace: boolean
  ): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(workspaceDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
        // No spawn records under this root (never spawned there, or cleaned up).
        return false;
      }
      // EACCES/EIO/...: the records exist but cannot be read, so absence of a surviving
      // process is unprovable — fail closed (the model-facing caller routes to
      // user-mediated archive).
      return true;
    }
    const trackedPids = new Set<number>();
    const trackedProcessIds = new Set<string>();
    for (const proc of this.processes.values()) {
      if (proc.workspaceId === workspaceId) {
        trackedPids.add(proc.pid);
        trackedProcessIds.add(proc.id);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Tracked processes (directory name = process ID) are covered by the in-memory
      // live-activity gates, whose statuses refresh via list(); this probe only reports
      // processes nobody tracks. ID-based so migrated records (pid 0) are matched too.
      if (trackedProcessIds.has(entry.name)) continue;
      const processDir = nodePath.join(workspaceDir, entry.name);
      let meta: { pid: number; status: string } | null = null;
      try {
        meta = parseSpawnRecordMeta(
          await fsPromises.readFile(nodePath.join(processDir, BG_META_FILENAME), "utf-8")
        );
      } catch {
        // Missing/unreadable record: handled with the parse-failure case below.
      }
      if (meta == null) {
        // A record we cannot read or parse cannot prove its process exited: spawn aborts
        // (and terminates the process, writing the exit marker) when the initial record
        // fails to persist, and cleanly failed spawns remove their directory — ambiguous
        // launches (spawn succeeded but the PID echo was garbled) intentionally keep
        // theirs — so a markerless meta-less record is a crash artifact or untracked
        // launch whose process may still be alive. Trust only the exit marker; otherwise
        // fail closed (the model-facing caller routes to user-mediated archive).
        try {
          await fsPromises.access(nodePath.join(processDir, BG_EXIT_CODE_FILENAME));
          continue;
        } catch {
          return true;
        }
      }
      if (meta.status !== "running") continue;
      try {
        await fsPromises.access(nodePath.join(processDir, BG_EXIT_CODE_FILENAME));
        continue; // The exit marker settles the record (wrapper trap or migrated handle).
      } catch {
        // No exit marker yet — fall through to the PID checks.
      }
      if (!pidsAreHostNamespace) {
        // Container-namespace PID (devcontainer record): nothing on the host can probe it,
        // and a host kill(pid, 0) would answer for an unrelated host process — treat the
        // running record as a live orphan (fail closed; over-refusal routes to
        // user-mediated archive).
        return true;
      }
      if (meta.pid <= 1) {
        // Migrated processes record pid 0 (exec streams expose no PID) and their exit
        // marker is written by the in-process handle, not a detached trap. The child can
        // outlive an unclean shutdown on Unix, and nothing can probe it afterwards — fail
        // closed rather than skip. Clean shutdowns and natural exits rewrite the record
        // (status via updateMetaFile, or the exit marker above), so only genuine
        // unclean-exit survivors reach this branch.
        return true;
      }
      if (trackedPids.has(meta.pid)) continue;
      try {
        process.kill(meta.pid, 0);
        return true; // Alive and untracked: a crash orphan.
      } catch (error) {
        if (!isErrnoWithCode(error, "ESRCH")) {
          // EPERM etc.: the PID exists but is not ours to signal — treat as alive (recycled
          // PIDs over-refuse, never under-refuse).
          return true;
        }
        // ESRCH: the process is gone (e.g. SIGKILL skipped the exit trap, or a reboot).
      }
    }
    return false;
  }

  /**
   * Whether the local durable spawn directory for this process name may still belong to a
   * live process from a previous app session. Used to keep process directories unique across
   * restarts: the in-memory ID allocator resets with the app, and reusing a surviving crash
   * orphan's directory would hand two live processes one meta.json/exit_code — the newer
   * process's exit marker would then settle the survivor's record and blind the crash-orphan
   * archive gate. Settled records (exit marker present, non-running status, or dead PID) are
   * safe to reuse; anything unprovable is treated as live so the allocator picks a new name.
   */
  private async localSpawnDirMayHoldLiveProcess(
    workspaceId: string,
    processId: string
  ): Promise<boolean> {
    const processDir = nodePath.join(localBgWorkspaceDir(workspaceId), processId);
    try {
      await fsPromises.access(nodePath.join(processDir, BG_EXIT_CODE_FILENAME));
      return false; // The exit trap ran: settled — spawn clears the stale marker on reuse.
    } catch {
      // No exit marker — consult the meta record.
    }
    let raw: string;
    try {
      raw = await fsPromises.readFile(nodePath.join(processDir, BG_META_FILENAME), "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
        try {
          await fsPromises.access(processDir);
          // Metaless, markerless directory: a crash artifact the orphan probe fails closed
          // on — leave it undisturbed rather than overwrite whatever evidence remains.
          return true;
        } catch {
          return false; // Directory absent: the name is free.
        }
      }
      return true; // Unreadable record: may belong to a live process.
    }
    const meta = parseSpawnRecordMeta(raw);
    if (meta == null) return true; // Torn record without an exit marker: may be live.
    if (meta.status !== "running") return false; // Settled.
    if (meta.pid <= 1) return true; // Unprobeable pid recorded as running: do not reuse.
    try {
      process.kill(meta.pid, 0);
      return true; // Alive.
    } catch (error) {
      // ESRCH: gone. Anything else (EPERM, ...): not provably dead — treat as live.
      return !isErrnoWithCode(error, "ESRCH");
    }
  }

  /**
   * Counterpart of localSpawnDirMayHoldLiveProcess for runtimes whose spawn records are NOT
   * host-local (SSH/Coder, Docker, devcontainer — see spawnRecordsAreHostLocal): the record
   * layout lives in the runtime's exec namespace, so probe it through the runtime. Only the
   * exit marker (or directory absence) proves the name safe to reuse — a markerless
   * directory may belong to a live detached process from a previous session or a preserved
   * ambiguous spawn, and reusing it would truncate its output and let either process's exit
   * marker settle the other. No PID probe: recorded PIDs are only meaningful in the exec
   * namespace and a stale-but-settled record merely costs a suffixed name (fail closed).
   * Marker matching is substring-based because SSH login banners can prefix stdout (the same
   * garbling that produces ambiguous PID echoes); a reply with neither marker or a failed
   * exec is an error so callers abort instead of looping forever against a dead host.
   */
  private async runtimeSpawnDirMayHoldLiveProcess(
    runtime: Runtime,
    workspaceId: string,
    processId: string
  ): Promise<"free" | "held" | { error: string }> {
    try {
      const tempDir = await runtime.tempDir();
      const processDir = `${tempDir}/${BG_OUTPUT_SUBDIR}/${workspaceId}/${processId}`;
      const exitMarkerPath = `${processDir}/${BG_EXIT_CODE_FILENAME}`;
      const script = `if [ ! -e ${quotePathForShell(processDir)} ] || [ -e ${quotePathForShell(
        exitMarkerPath
      )} ]; then echo __MUX_SPAWN_NAME_FREE__; else echo __MUX_SPAWN_NAME_HELD__; fi`;
      const result = await execBuffered(runtime, script, { cwd: "/tmp", timeout: 10 });
      if (result.exitCode === 0) {
        if (result.stdout.includes("__MUX_SPAWN_NAME_FREE__")) return "free";
        if (result.stdout.includes("__MUX_SPAWN_NAME_HELD__")) return "held";
      }
      return {
        error: `Could not verify that background process name ${JSON.stringify(
          processId
        )} is free on the runtime (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      };
    } catch (error) {
      return {
        error: `Could not verify that background process name ${JSON.stringify(
          processId
        )} is free on the runtime: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Remote counterpart of the crash-orphan probe for SSH/Coder targets, executed through the
   * runtime because those spawn records live on the remote host. Called before a
   * model-driven archive stops a running Coder workspace: stopping the VM would kill any
   * detached job that survived an unclean Xum exit. Trusts only exit markers and
   * remote-namespace liveness — a markerless meta-less record (a preserved ambiguous or
   * transport-failure spawn) or a running-status record whose PID is alive (or unprobeable,
   * including recycled-PID EPERM via /proc) reports Ok(true); a garbled or failed probe
   * reports Err so the caller fails closed. Marker matching is substring-based because SSH
   * login banners can prefix stdout.
   */
  async hasUnsettledRemoteSpawnRecords(
    runtime: Runtime,
    workspaceId: string
  ): Promise<Result<boolean>> {
    assert(workspaceId.length > 0, "hasUnsettledRemoteSpawnRecords requires workspaceId");
    try {
      const tempDir = await runtime.tempDir();
      const root = `${tempDir}/${BG_OUTPUT_SUBDIR}/${workspaceId}`;
      // One POSIX-shell pass over the per-process record dirs (see localSpawnDirMayHoldLiveProcess
      // for the host-local equivalent of these rules):
      // - exit marker present → settled; missing meta.json (or one without a "status" field,
      //   i.e. torn/unreadable) → unsettled; non-"running" status → settled.
      // - running status: dead PID means SIGKILL/reboot skipped the trap → settled; a live or
      //   recycled PID (kill -0 success, or /proc entry on EPERM) → unsettled.
      // Process IDs derive from display names, which may legally start with "." (only "." and
      // ".." themselves are rejected), so also enumerate hidden record dirs — a bare "*/" glob
      // would silently skip them and report CLEAR under a live dot-named job.
      // Only a genuinely absent root proves no records: an existing root that is not a
      // readable+searchable directory (ownership/permission change, or replaced by a file)
      // would leave the glob unmatched and read as CLEAR while records may sit beneath it,
      // so those cases emit UNREADABLE and fail the probe closed. `test -e` also returns
      // false when an ancestor is unsearchable, so absence is only trusted when the parent
      // directory itself is traversable.
      const script = [
        `root=${quotePathForShell(root)}`,
        `if [ -d "$root" ]; then`,
        `  if [ ! -r "$root" ] || [ ! -x "$root" ]; then echo __MUX_BG_REMOTE_UNREADABLE__; exit 0; fi`,
        `elif [ -e "$root" ] || [ -L "$root" ]; then`,
        `  echo __MUX_BG_REMOTE_UNREADABLE__; exit 0`,
        `else`,
        `  parent=$(dirname "$root")`,
        `  if [ -d "$parent" ] && { [ ! -r "$parent" ] || [ ! -x "$parent" ]; }; then echo __MUX_BG_REMOTE_UNREADABLE__; exit 0; fi`,
        `  echo __MUX_BG_REMOTE_CLEAR__; exit 0`,
        `fi`,
        `unsettled=0`,
        `for p in "$root"/*/ "$root"/.*/; do`,
        `  case "$p" in */./|*/../) continue ;; esac`,
        `  [ -d "$p" ] || continue`,
        `  [ -e "$p/${BG_EXIT_CODE_FILENAME}" ] && continue`,
        `  if ! grep -q '"status"' "$p/${BG_META_FILENAME}" 2>/dev/null; then unsettled=1; break; fi`,
        `  grep -q '"status"[[:space:]]*:[[:space:]]*"running"' "$p/${BG_META_FILENAME}" 2>/dev/null || continue`,
        `  pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$p/${BG_META_FILENAME}" 2>/dev/null | head -n 1)`,
        `  if [ -z "$pid" ] || [ "$pid" -le 1 ]; then unsettled=1; break; fi`,
        `  if kill -0 "$pid" 2>/dev/null || [ -e "/proc/$pid" ]; then unsettled=1; break; fi`,
        `done`,
        `if [ "$unsettled" = 1 ]; then echo __MUX_BG_REMOTE_UNSETTLED__; else echo __MUX_BG_REMOTE_CLEAR__; fi`,
      ].join("\n");
      const result = await execBuffered(runtime, script, { cwd: "/tmp", timeout: 15 });
      if (result.exitCode === 0) {
        if (result.stdout.includes("__MUX_BG_REMOTE_UNREADABLE__")) {
          return Err(
            `remote spawn-record root ${root} exists but is not a readable directory; cannot verify background jobs are settled`
          );
        }
        if (result.stdout.includes("__MUX_BG_REMOTE_UNSETTLED__")) return Ok(true);
        if (result.stdout.includes("__MUX_BG_REMOTE_CLEAR__")) return Ok(false);
      }
      return Err(
        `remote spawn-record probe failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
      );
    } catch (error) {
      return Err(`remote spawn-record probe failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * List background processes (not including foreground ones being waited on).
   * Optionally filtered by workspace.
   * Refreshes status of running processes before returning.
   */
  async list(workspaceId?: string): Promise<BackgroundProcess[]> {
    log.debug(`BackgroundProcessManager.list(${workspaceId ?? "all"}) called`);
    await this.refreshRunningStatuses();
    // Only return background processes (not foreground ones being waited on)
    const backgroundProcesses = Array.from(this.processes.values()).filter((p) => !p.isForeground);
    return workspaceId
      ? backgroundProcesses.filter((p) => p.workspaceId === workspaceId)
      : backgroundProcesses;
  }

  /**
   * Check all "running" processes and update status if they've exited.
   * Called lazily from list() to avoid polling overhead.
   */
  private async refreshRunningStatuses(): Promise<void> {
    const runningProcesses = Array.from(this.processes.values()).filter(
      (p) => p.status === "running"
    );

    for (const proc of runningProcesses) {
      const exitCode = await proc.handle.getExitCode();
      if (exitCode !== null) {
        log.debug(`Background process ${proc.id} has exited`);
        proc.status = "exited";
        proc.exitCode = exitCode;
        proc.exitTime = Date.now();
        await this.updateMetaFile(proc).catch((err: unknown) => {
          log.debug(
            `BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`
          );
        });
        this.emitChange(proc.workspaceId);
      }
    }
  }

  /**
   * Terminate a background process
   */
  async terminate(
    processId: string,
    options: { monitorDisposition: "discard" | "flush" }
  ): Promise<{ success: true } | { success: false; error: string }> {
    log.debug(`BackgroundProcessManager.terminate(${processId}) called`);
    const shouldFlushMonitor = options.monitorDisposition === "flush";

    // Get process from Map
    const proc = this.processes.get(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    // If already terminated, return success (idempotent) after resolving any pending monitor flush.
    if (proc.status === "exited" || proc.status === "killed" || proc.status === "failed") {
      if (shouldFlushMonitor) {
        const reservation = this.claimMonitorSettlement(proc);
        if (reservation) {
          await this.emitClaimedMonitorSettlement(reservation, {
            status: proc.status,
            ...(proc.exitCode !== undefined ? { exitCode: proc.exitCode } : {}),
          });
        } else if (!proc.monitor?.settled) {
          // Shutdown or already-stopped monitor: legacy flush (no-op when stopped). A held claim
          // instead means the tail loop (or a concurrent terminate) owns the settlement emit.
          this.stopMonitor(proc, true);
        }
      } else {
        this.cancelMonitor(proc);
      }
      log.debug(`Process ${processId} already terminated with status: ${proc.status}`);
      return { success: true };
    }

    // Claim settlement synchronously BEFORE the kill so the tail loop cannot settle concurrently
    // and the kill's terminal payload is deterministic. Discard-mode termination (task_stop,
    // workspace cleanup) is an explicit cancellation: it must never produce a settlement wake.
    const reservation = shouldFlushMonitor ? this.claimMonitorSettlement(proc) : null;
    if (!shouldFlushMonitor) {
      this.cancelMonitor(proc);
    } else if (!reservation && !proc.monitor?.settled) {
      // Shutdown suppressed the claim: keep the legacy pre-kill flush (registry survives for the
      // restart monitor-lost notice).
      this.stopMonitor(proc, true);
    }

    try {
      await proc.handle.terminate();

      // Update process status and exit code
      proc.status = "killed";
      proc.exitCode = (await proc.handle.getExitCode()) ?? undefined;
      proc.exitTime ??= Date.now();

      // Update meta.json
      await this.updateMetaFile(proc).catch((err: unknown) => {
        log.debug(`BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`);
      });

      // Settle before dispose: the settlement helper still reads output.log through the handle.
      // The "killed" disposition mirrors proc.status, which terminate() force-sets on the same
      // best-effort semantics task_await/bash_output have always reported (runtime handles
      // swallow transport/kill failures). The wake's own claims stay accurate either way: the
      // monitor IS stopped (no further wakes) and Xum's bookkeeping considers the task killed.
      // Verifying that a remote kill actually landed belongs to the RuntimeBackgroundHandle
      // layer, where any improvement flows into every status surface at once.
      if (reservation) {
        await this.emitClaimedMonitorSettlement(reservation, {
          status: "killed",
          ...(proc.exitCode !== undefined ? { exitCode: proc.exitCode } : {}),
        });
      }

      // Dispose of the handle
      await proc.handle.dispose();

      log.debug(`Process ${processId} terminated successfully`);
      this.emitChange(proc.workspaceId);
      return { success: true };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.debug(`Error terminating process ${processId}: ${errorMessage}`);
      // Mark as killed even if there was an error (process likely already dead)
      proc.status = "killed";
      proc.exitTime ??= Date.now();
      // Update meta.json
      await this.updateMetaFile(proc).catch((err: unknown) => {
        log.debug(`BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`);
      });
      // The force-marked kill still settles: the claimed reservation owns the only wake emit.
      if (reservation) {
        await this.emitClaimedMonitorSettlement(reservation, {
          status: "killed",
          ...(proc.exitCode !== undefined ? { exitCode: proc.exitCode } : {}),
        });
      }
      // Ensure handle is cleaned up even on error
      await proc.handle.dispose();
      this.emitChange(proc.workspaceId);
      return { success: true };
    }
  }

  /**
   * Terminate all background processes across all workspaces.
   * Called during app shutdown to prevent orphaned processes.
   */
  async terminateAll(): Promise<void> {
    log.debug(`BackgroundProcessManager.terminateAll() called`);
    // terminateAll only runs at shutdown; set the flag defensively in case a caller
    // skipped beginShutdown(), so retiring monitors keep their registry records.
    this.shuttingDown = true;
    const allProcesses = Array.from(this.processes.values());
    await Promise.all(
      allProcesses.map((p) => this.terminate(p.id, { monitorDisposition: "flush" }))
    );
    this.processes.clear();
    log.debug(`Terminated ${allProcesses.length} background process(es)`);
  }

  /**
   * Clean up all processes for a workspace.
   * Terminates running processes and removes from memory.
   * Output directories are left on disk (cleaned by OS for /tmp, or on workspace deletion for local).
   */
  async cleanup(workspaceId: string): Promise<void> {
    log.debug(`BackgroundProcessManager.cleanup(${workspaceId}) called`);
    const matching = Array.from(this.processes.values()).filter(
      (p) => p.workspaceId === workspaceId
    );

    // Terminate all running processes
    await Promise.all(matching.map((p) => this.terminate(p.id, { monitorDisposition: "discard" })));

    // Remove from memory (output dirs left on disk for OS/workspace cleanup)
    // All per-process state (outputBytesRead, outputLock) is stored in the
    // BackgroundProcess object, so cleanup is automatic when we delete here.
    for (const p of matching) {
      this.processes.delete(p.id);
    }

    log.debug(`Cleaned up ${matching.length} process(es) for workspace ${workspaceId}`);
  }
}
