import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { classifyMachineTurnPromptKind } from "@/common/utils/machineTurnPrompts";
import type {
  BashMonitorRegistryRecord,
  BashMonitorTerminalSummary,
} from "@/node/services/bashMonitorRegistryStore";
import {
  BashMonitorWakeReconciler,
  type BashMonitorProcessSnapshot,
  type BashMonitorWakeDeliveryState,
  type BashMonitorWakeDispatch,
} from "@/node/services/bashMonitorWakeReconciler";

const OWNER = "owner";
const CREATED_AT = "2026-08-31T12:00:00.000Z";

function liveSnapshot(
  overrides: Partial<BashMonitorProcessSnapshot> = {}
): BashMonitorProcessSnapshot {
  return {
    processId: "proc",
    taskId: "bash:proc",
    ownerWorkspaceId: OWNER,
    displayName: "CI watcher",
    filter: "READY",
    filterExclude: false,
    script: "run-ci",
    createdAt: CREATED_AT,
    match: { throughOffset: 12, lines: ["READY"], totalMatches: 1 },
    retired: false,
    ...overrides,
  };
}

function registryRecord(terminal?: BashMonitorTerminalSummary): BashMonitorRegistryRecord {
  return {
    processId: "dead",
    taskId: "bash:dead",
    ownerWorkspaceId: OWNER,
    filter: "DONE",
    filterExclude: false,
    script: "run-job",
    createdAt: CREATED_AT,
    ...(terminal != null ? { terminal } : {}),
  };
}

describe("BashMonitorWakeReconciler", () => {
  let root: string;
  let live: BashMonitorProcessSnapshot[];
  let rows: BashMonitorRegistryRecord[];
  let deliveryState: BashMonitorWakeDeliveryState | undefined;
  let dispatches: BashMonitorWakeDispatch[];
  let dispatchOutcome: "in-flight" | "deferred";
  let acknowledged: Array<{ processId: string; matchedThroughOffset?: number }>;
  let removed: string[];
  let removedOwners: string[];
  let dropped: string[];
  let droppedGenerations: Array<string | undefined>;
  let acknowledgeGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let reconciler: BashMonitorWakeReconciler;

  beforeEach(async () => {
    root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bash-wake-reconciler-"));
    live = [];
    rows = [];
    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    dispatches = [];
    dispatchOutcome = "in-flight";
    acknowledged = [];
    removed = [];
    removedOwners = [];
    dropped = [];
    droppedGenerations = [];
    acknowledgeGate = undefined;
    reconciler = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: (processId, _generation, matchedThroughOffset) => {
          acknowledged.push({
            processId,
            ...(matchedThroughOffset != null ? { matchedThroughOffset } : {}),
          });
          return acknowledgeGate?.promise;
        },
        dropRetiredMonitor: (processId, createdAt) => {
          droppedGenerations.push(createdAt);
          const current = live.find((snapshot) => snapshot.processId === processId);
          if (current?.createdAt === createdAt && current.retired) {
            dropped.push(processId);
            live = live.filter((snapshot) => snapshot !== current);
          }
        },
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (ownerWorkspaceId, processId, createdAt) => {
          removedOwners.push(ownerWorkspaceId);
          removed.push(processId);
          rows = rows.filter((row) =>
            createdAt == null
              ? row.processId !== processId
              : row.processId !== processId || row.createdAt !== createdAt
          );
        },
        recordTerminal: () => undefined,
      },
      onWake: (dispatch) => {
        dispatches.push(dispatch);
        return dispatchOutcome;
      },
    });
  });

  afterEach(async () => {
    // Accepted wakes schedule another pass; stop it before the next test reuses the fixtures.
    await reconciler.dispose(OWNER);
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  test("re-dispatches unchanged signals after a busy delivery defers", async () => {
    live = [liveSnapshot()];
    dispatchOutcome = "deferred";

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    dispatchOutcome = "in-flight";
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("re-dispatches unchanged signals after a queued delivery is canceled", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    await queued.onDeferred();
    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
  });

  test("a newer match withdraws the in-flight wake and dispatches again", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    live = [
      liveSnapshot({ match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 } }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0].cancelSignal.aborted).toBe(true);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent withdraws an in-flight wake without waiting behind acceptance I/O", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    // Acceptance holds the owner lock while acknowledging the process; a Stop must still
    // withdraw the wake immediately so the admission can bail before claiming a turn.
    acknowledgeGate = Promise.withResolvers<void>();
    const accepted = wake.onAccepted();
    while (acknowledged.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const consumed = reconciler.consumeCurrent(OWNER);
    try {
      expect(wake.cancelSignal.aborted).toBe(true);
    } finally {
      acknowledgeGate.resolve();
    }
    await accepted;
    await consumed;
    expect(acknowledged).toHaveLength(1);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("consumeCurrent withdraws the wake but keeps signals owed when the commit is refused", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    await reconciler.consumeCurrent(OWNER, () => Promise.resolve(false));

    expect(wake.cancelSignal.aborted).toBe(true);
    expect(acknowledged).toEqual([]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent retires only the attention owed when the stop was requested", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    live = [
      liveSnapshot({ match: { throughOffset: 30, lines: ["READY", "READY"], totalMatches: 2 } }),
    ];
    stop.resolve(true);
    await consuming;

    expect(acknowledged).toEqual([{ processId: "proc", matchedThroughOffset: 12 }]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent leaves a settlement recorded after the stop request owed", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    const terminal: BashMonitorTerminalSummary = {
      status: "exited",
      exitCode: 0,
      settledAt: "2026-08-31T12:00:05.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    };
    live = [liveSnapshot({ terminal })];
    rows = [{ ...registryRecord(terminal), processId: "proc", taskId: "bash:proc" }];
    stop.resolve(true);
    await consuming;

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      wakeUpdatedAt: terminal.settledAt,
      terminal: { status: "exited", exitCode: 0 },
    });
  });

  test("consumeCurrent leaves a monitor failure recorded after the stop request owed", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    live = [liveSnapshot({ retired: true })];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        lost: { reason: "runtime-failure", failedAt: "2026-08-31T12:00:05.000Z" },
      },
    ];
    stop.resolve(true);
    await consuming;

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      kind: "monitor-lost",
    });
  });

  test("consumeCurrent keeps the registry row of a monitor armed after the stop request", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    const later = liveSnapshot({
      processId: "later",
      taskId: "bash:later",
      createdAt: "2026-08-31T12:00:05.000Z",
    });
    live = [liveSnapshot(), later];
    rows = [
      { ...registryRecord(), processId: "later", taskId: "bash:later", createdAt: later.createdAt },
    ];
    stop.resolve(true);
    await consuming;

    expect(removed).toEqual([]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records).toEqual([
      expect.objectContaining({ processId: "later", kind: "match" }),
    ]);
  });

  test("keeps dead registry evidence until the queued wake is accepted", async () => {
    rows = [registryRecord()];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(classifyMachineTurnPromptKind(dispatches[0].prompt)).toBe("turn.monitor_wake");
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "dead",
      kind: "monitor-lost",
    });

    await dispatches[0].onAccepted();
    await dispatches[0].onAccepted();

    expect(removed).toEqual(["dead"]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("cancels a queued wake when the level no longer has an outstanding signal", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    deliveryState = { status: "settled", shownThroughOffset: 12, terminalStatusShown: false };
    await reconciler.reconcile(OWNER);

    expect(queued.cancelSignal.aborted).toBe(true);
    await queued.onAccepted();
    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [
      liveSnapshot({ match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 } }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("advances the watermark only on acceptance and later delivers a newer match", async () => {
    live = [liveSnapshot({ retired: true })];
    await reconciler.reconcile(OWNER);
    expect(dropped).toEqual([]);

    await dispatches[0].onAccepted();
    expect(dropped).toEqual(["proc"]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [
      liveSnapshot({
        match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("failed acceptance I/O is retried ahead of dispatch instead of redelivering the wake", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    acknowledgeGate = Promise.withResolvers<void>();
    acknowledgeGate.promise.catch(() => undefined);
    acknowledgeGate.reject(new Error("transient acknowledgement failure"));
    // The accepted row is durable, so acceptance resolves and only the consumption stays owed.
    await wake.onAccepted();
    await expect(reconciler.reconcile(OWNER)).rejects.toThrow("transient acknowledgement failure");
    expect(dispatches).toHaveLength(1);

    acknowledgeGate = undefined;
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [
      liveSnapshot({ match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 } }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("full history clear consumes signals present both before and during the clear", async () => {
    live = [liveSnapshot()];
    const token = await reconciler.beginFullHistoryClear(OWNER);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 },
      }),
    ];
    await reconciler.finishFullHistoryClear(token);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 36, lines: ["READY third"], totalMatches: 3 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("delivers wake-on-exit settlements and terminal summaries recovered after restart", async () => {
    live = [
      liveSnapshot({
        match: undefined,
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:01:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
          tailLines: [{ line: "complete", endOffset: 8 }],
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain("Process output before settlement");
    expect(dispatches[0].prompt).toContain("[monitor] process settled: exited (code 0)");
    expect(dispatches[0].prompt).toContain("> complete");
    await dispatches[0].onAccepted();
    expect(removed).toEqual(["proc"]);
    expect(dropped).toEqual(["proc"]);

    live = [];
    rows = [
      registryRecord({
        status: "timed_out",
        settledAt: "2026-08-31T12:02:00.000Z",
        wakeOnExit: true,
        terminalStatusShown: false,
      }),
    ];
    const restartedDispatches: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(undefined),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (_ownerWorkspaceId, processId) => {
          rows = rows.filter((row) => row.processId !== processId);
        },
        recordTerminal: () => undefined,
      },
      onWake: (dispatch) => {
        restartedDispatches.push(dispatch);
        return "in-flight";
      },
    });

    await restarted.reconcile(OWNER);

    expect(restartedDispatches).toHaveLength(1);
    expect(restartedDispatches[0].prompt).toContain("killed (timeout or terminate)");
    expect(restartedDispatches[0].prompt).toContain("no longer awaitable");
    await restartedDispatches[0].onAccepted();
    await restarted.reconcile(OWNER);
    expect(restartedDispatches).toHaveLength(1);
  });

  test("explicit cancellation retracts a queued wake without consuming a later generation", async () => {
    live = [liveSnapshot()];
    rows = [registryRecord()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    live = [];
    rows = [];
    await reconciler.reconcile(OWNER);

    expect(queued.cancelSignal.aborted).toBe(true);
    await queued.onAccepted();
    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:03:00.000Z",
        match: { throughOffset: 4, lines: ["new generation"], totalMatches: 1 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].prompt).toContain("new generation");
  });

  test("max-events retirement keeps matched lines but never invents a settlement or lost wake", async () => {
    live = [liveSnapshot({ retired: true })];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
        script: "run-ci",
      },
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
    await dispatches[0].onAccepted();
    live = [];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
    expect(removed).toEqual(["proc"]);
    expect(dropped).toEqual(["proc"]);
  });

  test("watermarks suppress delivered signals across reconstruction and reset for re-arm", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    const afterRestart: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      onWake: (dispatch) => {
        afterRestart.push(dispatch);
        return "in-flight";
      },
    });
    await restarted.reconcile(OWNER);
    expect(afterRestart).toEqual([]);

    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:04:00.000Z",
        match: { throughOffset: 3, lines: ["fresh"], totalMatches: 1 },
      }),
    ];
    await restarted.reconcile(OWNER);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].prompt).toContain("fresh");
  });

  test("a blocking output read defers without consuming the wake", async () => {
    let settleRead: (() => void) | undefined;
    const readSettled = new Promise<void>((resolve) => {
      settleRead = resolve;
    });
    live = [liveSnapshot()];
    deliveryState = { status: "blocked", readSettled };

    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    settleRead?.();
    await readSettled;
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain("READY");
  });

  test("partially shown retained batches omit only the covered batch", async () => {
    live = [
      liveSnapshot({
        match: {
          batches: [
            { throughOffset: 10, lines: ["BATCH_A"], totalMatches: 1, droppedLines: 0 },
            { throughOffset: 20, lines: ["BATCH_B"], totalMatches: 2, droppedLines: 0 },
          ],
          throughOffset: 20,
          lines: ["BATCH_A", "BATCH_B"],
          totalMatches: 2,
        },
      }),
    ];
    deliveryState = { status: "settled", shownThroughOffset: 10, terminalStatusShown: false };

    await reconciler.reconcile(OWNER);

    expect(dispatches[0].prompt).not.toContain("BATCH_A");
    expect(dispatches[0].prompt).toContain("BATCH_B");
  });

  test("matched user output resembling a settlement marker is preserved", async () => {
    live = [
      liveSnapshot({
        match: {
          throughOffset: 30,
          lines: ["[monitor] process settled: user supplied detail"],
          totalMatches: 1,
        },
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches[0].prompt).toContain("> [monitor] process settled: user supplied detail");
  });

  test("settlement excludes tail lines already covered by the delivered match watermark", async () => {
    live = [
      liveSnapshot({
        filter: "SET_",
        match: {
          throughOffset: 18,
          lines: ["SET_1", "SET_2", "SET_3"],
          totalMatches: 3,
        },
      }),
    ];
    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    live = [
      liveSnapshot({
        filter: "SET_",
        match: undefined,
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:07:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
          tailLines: [
            { line: "SET_1", endOffset: 6 },
            { line: "SET_2", endOffset: 12 },
            { line: "SET_3", endOffset: 18 },
          ],
        },
        retired: true,
      }),
    ];
    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
    const prompt = dispatches[1].prompt;
    expect(prompt.match(/\[monitor\] process settled:/g)).toHaveLength(1);
    expect(prompt).not.toContain("SET_1");
    expect(prompt).not.toContain("SET_2");
    expect(prompt).not.toContain("SET_3");
  });

  test("settlement keeps only the undelivered match before one composed marker", async () => {
    live = [
      liveSnapshot({
        filter: "TICK_",
        match: { throughOffset: 7, lines: ["TICK_1"], totalMatches: 1 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    live = [
      liveSnapshot({
        filter: "TICK_",
        match: {
          throughOffset: 14,
          lines: ["TICK_2"],
          totalMatches: 2,
        },
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:08:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
          tailLines: [
            { line: "TICK_1", endOffset: 7 },
            { line: "TICK_2", endOffset: 14 },
          ],
        },
        retired: true,
      }),
    ];
    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
    const prompt = dispatches[1].prompt;
    expect(prompt.match(/\[monitor\] process settled:/g)).toHaveLength(1);
    expect(prompt.match(/TICK_2/g)).toHaveLength(1);
    expect(prompt).not.toContain("TICK_1");
    expect(prompt.indexOf("TICK_2")).toBeLessThan(prompt.indexOf("[monitor] process settled:"));
  });

  test("wake-on-exit opt-out keeps an undelivered exit flush match-only", async () => {
    live = [
      liveSnapshot({
        match: { throughOffset: 12, lines: ["READY"], totalMatches: 1 },
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:13:00.000Z",
          wakeOnExit: false,
          terminalStatusShown: false,
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain("Matched process output");
    expect(dispatches[0].prompt).not.toContain("Status: exited");
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
  });

  test("shown matched output is suppressed while a new settlement still wakes with context", async () => {
    live = [
      liveSnapshot({
        terminal: {
          status: "killed",
          settledAt: "2026-08-31T12:05:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
        },
        retired: true,
      }),
    ];
    deliveryState = { status: "settled", shownThroughOffset: 12, terminalStatusShown: false };

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain("were already returned to you by an earlier read");
    expect(dispatches[0].prompt).toContain("[monitor] process settled: killed");
  });

  test("runtime monitor failure remains actionable and deduplicates after reconstruction", async () => {
    const runtimeFailure: BashMonitorRegistryRecord = {
      processId: "proc",
      taskId: "bash:proc",
      ownerWorkspaceId: OWNER,
      displayName: "CI watcher",
      filter: "READY",
      filterExclude: false,
      script: "run-ci",
      createdAt: CREATED_AT,
      lost: {
        reason: "runtime-failure",
        failureMessage: "transport failed",
        failedOperations: ["getExitCode"],
        failedMatch: {
          lines: ["READY before failure"],
          totalMatches: 1,
          droppedLines: 0,
          matchedThroughOffset: 12,
        },
        failedAt: "2026-08-31T12:06:00.000Z",
      },
    };
    live = [liveSnapshot({ match: undefined, retired: true })];
    rows = [runtimeFailure];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      kind: "monitor-lost",
      lostReason: "runtime-failure",
    });
    expect(dispatches[0].prompt).toContain("monitor failed at runtime");
    expect(dispatches[0].prompt).toContain("process may still be running");
    expect(dispatches[0].prompt).toContain("transport failed");
    expect(dispatches[0].prompt).toContain("Failed operations: getExitCode");
    expect(dispatches[0].prompt).toContain("Matched output before failure");
    expect(dispatches[0].prompt).toContain("READY before failure");
    expect(dispatches[0].prompt).not.toContain("process was terminated");
    await dispatches[0].onAccepted();

    live = [];
    rows = [runtimeFailure];
    const afterRestart: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(undefined),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (_ownerWorkspaceId, processId) => {
          rows = rows.filter((row) => row.processId !== processId);
        },
        recordTerminal: () => undefined,
      },
      onWake: (dispatch) => {
        afterRestart.push(dispatch);
        return "in-flight";
      },
    });

    await restarted.reconcile(OWNER);
    expect(afterRestart).toEqual([]);
  });

  test("stale accepted wake does not drop a newer retired monitor generation", async () => {
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
      },
    ];
    await reconciler.reconcile(OWNER);
    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:20:00.000Z",
        match: { throughOffset: 10, lines: ["NEW MATCH"], totalMatches: 1 },
        retired: true,
      }),
    ];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
        createdAt: "2026-08-31T12:20:00.000Z",
      },
    ];

    await dispatches[0].onAccepted();

    expect(droppedGenerations).toEqual([CREATED_AT]);
    expect(live).toHaveLength(1);
    expect(live[0].match?.lines).toEqual(["NEW MATCH"]);
  });

  test("dead registry cleanup uses the scanned workspace instead of embedded owner", async () => {
    rows = [{ ...registryRecord(), ownerWorkspaceId: "other-owner" }];

    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    expect(removedOwners).toEqual([OWNER]);
  });

  test("accepted stale generation does not remove a re-armed registry row", async () => {
    rows = [registryRecord()];
    await reconciler.reconcile(OWNER);
    rows = [
      {
        ...registryRecord(),
        createdAt: "2026-08-31T12:10:00.000Z",
        filter: "NEW",
      },
    ];

    await dispatches[0].onAccepted();

    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe("2026-08-31T12:10:00.000Z");
  });

  test("runtime failure counts a duplicated final batch drop only once", async () => {
    const lines = Array.from({ length: 50 }, (_, index) => `MATCH_${index}`);
    live = [
      liveSnapshot({
        match: { throughOffset: 100, lines, totalMatches: 60, droppedLines: 10 },
        lost: {
          reason: "runtime-failure",
          failedMatch: {
            lines,
            totalMatches: 60,
            droppedLines: 10,
            matchedThroughOffset: 100,
          },
          failedAt: "2026-08-31T12:16:00.000Z",
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches[0].prompt).toContain("Dropped matched lines: 10");
    expect(dispatches[0].prompt).not.toContain("Dropped matched lines: 20");
  });

  test("runtime failure combines retained and final matched output once", async () => {
    live = [
      liveSnapshot({
        match: { throughOffset: 10, lines: ["EARLIER"], totalMatches: 1 },
        lost: {
          reason: "runtime-failure",
          failedMatch: {
            lines: ["FINAL"],
            totalMatches: 2,
            droppedLines: 0,
            matchedThroughOffset: 20,
          },
          failedAt: "2026-08-31T12:11:00.000Z",
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches[0].prompt.match(/EARLIER/g)).toHaveLength(1);
    expect(dispatches[0].prompt.match(/FINAL/g)).toHaveLength(1);
  });

  test("retries a failed reconcile pass without another process event", async () => {
    let pulls = 0;
    const retryDispatches: BashMonitorWakeDispatch[] = [];
    const retrying = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => {
          pulls++;
          if (pulls === 1) throw new Error("transient read failure");
          return [liveSnapshot()];
        },
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve([]),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      onWake: (dispatch) => {
        retryDispatches.push(dispatch);
        return "in-flight";
      },
    });

    retrying.scheduleReconcile(OWNER);
    for (let attempt = 0; attempt < 30 && retryDispatches.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(pulls).toBe(2);
    expect(retryDispatches).toHaveLength(1);
  });

  test("keeps unmatched settlement context before a delivered match", async () => {
    live = [
      liveSnapshot({
        filter: "DONE",
        match: { throughOffset: 20, lines: ["DONE"], totalMatches: 1 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    live = [
      liveSnapshot({
        filter: "DONE",
        match: undefined,
        terminal: {
          status: "exited",
          exitCode: 1,
          settledAt: "2026-08-31T12:12:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
          tailLines: [
            { line: "ERROR details", endOffset: 10 },
            { line: "DONE", endOffset: 20 },
          ],
        },
        retired: true,
      }),
    ];
    await reconciler.reconcile(OWNER);

    expect(dispatches[1].prompt).toContain("ERROR details");
    expect(dispatches[1].prompt).not.toContain("> DONE");
  });

  test("disposed workspaces ignore late pokes without recreating session state", async () => {
    const sessionDir = path.join(root, OWNER);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await reconciler.dispose(OWNER);
    await fsPromises.rm(sessionDir, { recursive: true, force: true });
    live = [liveSnapshot()];

    reconciler.scheduleReconcile(OWNER);
    await reconciler.reconcile(OWNER);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(dispatches).toEqual([]);
    const statError = await fsPromises.stat(sessionDir).catch((error: unknown) => error);
    expect(statError).toMatchObject({ code: "ENOENT" });
  });

  test("revived workspace resumes wake delivery after a failed removal", async () => {
    await reconciler.dispose(OWNER);
    reconciler.revive(OWNER);
    live = [liveSnapshot()];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
  });

  test("restart converts an opted-out undelivered match into a content-free lost wake", async () => {
    rows = [
      registryRecord({
        status: "exited",
        exitCode: 0,
        settledAt: "2026-09-01T00:02:00.000Z",
        wakeOnExit: false,
        terminalStatusShown: false,
        matchedThroughOffset: 12,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "dead",
      kind: "monitor-lost",
      lostReason: "restart",
    });
    expect(dispatches[0].prompt).not.toContain("READY");
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
  });

  test("snapshot supplies pending kinds without dispatching and removes the legacy wake directory", async () => {
    rows = [
      registryRecord({
        status: "exited",
        exitCode: 0,
        settledAt: "2026-08-31T12:01:00.000Z",
        wakeOnExit: true,
        terminalStatusShown: false,
      }),
    ];
    const legacy = path.join(root, OWNER, "bash-monitor-wakes");
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.writeFile(path.join(legacy, "old.json"), "{}", "utf8");

    const snapshot = await reconciler.snapshot(OWNER);

    expect(reconciler.pendingWakeKind(snapshot, "dead")).toBe("settled");
    expect(dispatches).toEqual([]);
    const statError = await fsPromises.stat(legacy).catch((error: unknown) => error);
    expect(statError).toMatchObject({ code: "ENOENT" });

    await fsPromises.mkdir(legacy, { recursive: true });
    await reconciler.snapshot(OWNER);
    expect((await fsPromises.stat(legacy)).isDirectory()).toBe(true);
  });
});
