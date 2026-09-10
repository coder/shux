import { Buffer } from "node:buffer";
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { Ok } from "@/common/types/result";
import {
  BackgroundProcessManager,
  boundTailContent,
  computeTailStartOffset,
  parseSpawnRecordMeta,
  type BackgroundProcess,
  type BackgroundProcessMeta,
  type MonitorArmedPayload,
  type MonitorMatchPayload,
  type MonitorStoppedPayload,
  type OutputShownPayload,
} from "./backgroundProcessManager";
import { localBgWorkspaceDir, spawnProcess } from "./backgroundProcessExecutor";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { BackgroundHandle, Runtime } from "@/node/runtime/Runtime";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createBashTool } from "@/node/services/tools/bash";
import { createBashOutputTool } from "@/node/services/tools/bash_output";
import { TestTempDir, createTestToolConfig } from "@/node/services/tools/testHelpers";
import type { BashToolResult, BashOutputToolResult } from "@/common/types/tools";

interface ProbeFailureControl {
  value: boolean;
  calls: number;
  exitCode?: number;
}

interface RemoteLikeRuntimeOptions {
  throwOnSpawn?: { value: boolean };
  outputProbeFailure?: ProbeFailureControl;
  exitProbeFailure?: ProbeFailureControl;
}

/**
 * Delegates to a real LocalRuntime but is NOT an instanceof LocalBaseRuntime, so the
 * manager treats it like a remote runtime (exec-based record-directory probing, name
 * reservation retention on failure). Optionally throws on the spawn command itself to
 * simulate a transport-level (SSH/Coder channel) error after dispatch.
 */
function createRemoteLikeRuntime(base: LocalRuntime, options?: RemoteLikeRuntimeOptions): Runtime {
  return new Proxy({} as Runtime, {
    get(_target, prop) {
      if (prop === "exec") {
        return (command: string, opts: never) => {
          if (options?.throwOnSpawn?.value === true && command.includes("output.log")) {
            throw new Error("SSH channel error after dispatch");
          }
          if (
            options?.outputProbeFailure?.value === true &&
            (command.includes("wc -c <") || command.includes("tail -c +"))
          ) {
            options.outputProbeFailure.calls += 1;
            if (options.outputProbeFailure.exitCode != null) {
              return base.exec(`exit ${options.outputProbeFailure.exitCode}`, opts);
            }
            throw new Error("SSH output probe failed");
          }
          if (
            options?.exitProbeFailure?.value === true &&
            command.includes("cat ") &&
            command.includes("exit_code")
          ) {
            options.exitProbeFailure.calls += 1;
            if (options.exitProbeFailure.exitCode != null) {
              return base.exec(`exit ${options.exitProbeFailure.exitCode}`, opts);
            }
            throw new Error("SSH exit probe failed");
          }
          return base.exec(command, opts);
        };
      }
      const value = (base as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(base)
        : value;
    },
  });
}

async function captureProbeError(action: () => Promise<unknown>): Promise<Error | null> {
  try {
    await action();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function expectProbeCallNotToThrow(action: () => Promise<unknown>): Promise<void> {
  expect(await captureProbeError(action)).toBeNull();
}

function waitForMonitorMatch(
  manager: BackgroundProcessManager,
  timeoutMs = 2_000
): Promise<{ workspaceId: string; payload: MonitorMatchPayload }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("monitor:match", handler);
      reject(new Error("Timed out waiting for monitor match"));
    }, timeoutMs);

    const handler = (workspaceId: string, payload: MonitorMatchPayload) => {
      clearTimeout(timeout);
      manager.off("monitor:match", handler);
      resolve({ workspaceId, payload });
    };

    manager.on("monitor:match", handler);
  });
}

describe("BackgroundProcessManager", () => {
  let manager: BackgroundProcessManager;
  let runtime: Runtime;
  let bgOutputDir: string;
  const probeHandles: BackgroundHandle[] = [];
  // Use unique workspace IDs per test run to avoid collisions
  const testRunId = Date.now().toString(36);
  const testWorkspaceId = `test-ws1-${testRunId}`;
  const testWorkspaceId2 = `test-ws2-${testRunId}`;

  beforeEach(async () => {
    // Create isolated temp directory for each test to avoid cross-test pollution
    bgOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-proc-test-"));
    manager = new BackgroundProcessManager(bgOutputDir);
    runtime = new LocalRuntime(process.cwd());
  });

  afterEach(async () => {
    await Promise.all(probeHandles.splice(0).map((handle) => handle.terminate()));
    // Cleanup: terminate all processes
    await manager.cleanup(testWorkspaceId);
    await manager.cleanup(testWorkspaceId2);
    // Remove temp sessions directory (legacy)
    await fs.rm(bgOutputDir, { recursive: true, force: true }).catch(() => undefined);
    // Remove actual output directories from /tmp/mux-bashes (where executor writes)
    await fs
      .rm(`/tmp/mux-bashes/${testWorkspaceId}`, { recursive: true, force: true })
      .catch(() => undefined);
    await fs
      .rm(`/tmp/mux-bashes/${testWorkspaceId2}`, { recursive: true, force: true })
      .catch(() => undefined);
  });

  describe("computeTailStartOffset", () => {
    it("should return 0 when tailBytes exceeds file size", () => {
      expect(computeTailStartOffset(10, 64_000)).toBe(0);
    });

    it("should return fileSize - tailBytes when fileSize is larger", () => {
      expect(computeTailStartOffset(100, 10)).toBe(90);
    });

    it("should throw on invalid inputs", () => {
      expect(() => computeTailStartOffset(-1, 10)).toThrow();
      expect(() => computeTailStartOffset(10, 0)).toThrow();
    });
  });

  describe("spawn", () => {
    it("should spawn a background process and return process ID and outputDir", async () => {
      const displayName = `test-${Date.now()}`;
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
        displayName,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Process ID is now the display name directly
        expect(result.processId).toBe(displayName);
        // outputDir is now under runtime.tempDir()/mux-bashes/<workspaceId>/<processId>
        expect(result.outputDir).toContain("mux-bashes");
        expect(result.outputDir).toContain(testWorkspaceId);
        expect(result.outputDir).toContain(result.processId);
      }
    });

    it("should return error on spawn failure", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: "/nonexistent/path/that/does/not/exist",
        displayName: "test",
      });

      expect(result.success).toBe(false);
    });

    it("should write stdout and stderr to unified output file", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello; echo world >&2", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Wait a moment for output to be written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const outputPath = path.join(result.outputDir, "output.log");
        const output = await fs.readFile(outputPath, "utf-8");

        // Both stdout and stderr go to the same file
        expect(output).toContain("hello");
        expect(output).toContain("world");
      }
    });

    it("should write meta.json with process info", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const metaPath = path.join(result.outputDir, "meta.json");
        const metaContent = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent) as BackgroundProcessMeta;

        expect(meta.id).toBe(result.processId);
        expect(meta.pid).toBeGreaterThan(0);
        expect(meta.script).toBe("echo test");
        expect(meta.status).toBe("running");
        expect(meta.startTime).toBeGreaterThan(0);
      }
    });

    it("does not reuse a preserved record directory when retrying a failed remote spawn", async () => {
      // A transport-level throw after dispatch preserves the remote record directory as
      // fail-closed orphan evidence. A same-session retry of the same display name must not
      // reuse that directory: truncating its output.log and sharing its exit_code would let
      // either detached process settle the other and blind the Coder-stop archive gate.
      const throwOnSpawn = { value: true };
      const remote = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), { throwOnSpawn });

      const first = await manager.spawn(remote, testWorkspaceId, "echo hi", {
        cwd: process.cwd(),
        displayName: "retry-job",
      });
      expect(first.success).toBe(false);
      await fs.access(`/tmp/mux-bashes/${testWorkspaceId}/retry-job/output.log`);

      throwOnSpawn.value = false;
      const second = await manager.spawn(remote, testWorkspaceId, "echo hi", {
        cwd: process.cwd(),
        displayName: "retry-job",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.processId).toBe("retry-job (1)");
      // The preserved evidence stays untouched for crash-orphan gating.
      await fs.access(`/tmp/mux-bashes/${testWorkspaceId}/retry-job/output.log`);
    });

    it("probes runtime record directories for non-host runtimes before reusing a name", async () => {
      // A markerless record directory on the runtime (previous-session survivor or preserved
      // ambiguous spawn) holds the name; an exit-marker-settled one frees it.
      const heldDir = `/tmp/mux-bashes/${testWorkspaceId}/held-job`;
      await fs.mkdir(heldDir, { recursive: true });
      await fs.writeFile(path.join(heldDir, "output.log"), "previous session output");
      const settledDir = `/tmp/mux-bashes/${testWorkspaceId}/settled-job`;
      await fs.mkdir(settledDir, { recursive: true });
      await fs.writeFile(path.join(settledDir, "exit_code"), "0");

      const remote = createRemoteLikeRuntime(new LocalRuntime(process.cwd()));
      const held = await manager.spawn(remote, testWorkspaceId, "echo hi", {
        cwd: process.cwd(),
        displayName: "held-job",
      });
      expect(held.success).toBe(true);
      if (!held.success) return;
      expect(held.processId).toBe("held-job (2)");
      expect(await fs.readFile(path.join(heldDir, "output.log"), "utf-8")).toBe(
        "previous session output"
      );

      const settled = await manager.spawn(remote, testWorkspaceId, "echo hi", {
        cwd: process.cwd(),
        displayName: "settled-job",
      });
      expect(settled.success).toBe(true);
      if (!settled.success) return;
      expect(settled.processId).toBe("settled-job");
    });
  });

  describe("monitor", () => {
    async function spawnRuntimeProbeHandle(
      options: RemoteLikeRuntimeOptions
    ): Promise<BackgroundHandle> {
      const result = await spawnProcess(
        createRemoteLikeRuntime(new LocalRuntime(process.cwd()), options),
        "sleep 10",
        {
          cwd: process.cwd(),
          workspaceId: testWorkspaceId,
          processId: "monitor-probe-matrix",
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      probeHandles.push(result.handle);
      return result.handle;
    }

    it("keeps repeated readOutput transport failures fail-open outside monitor polling", async () => {
      const outputProbeFailure = { value: true, calls: 0, exitCode: 255 };
      const handle = await spawnRuntimeProbeHandle({ outputProbeFailure });

      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          await expectProbeCallNotToThrow(() => handle.readOutput(0));
        }
      } finally {
        outputProbeFailure.value = false;
      }
    });

    it("keeps repeated getExitCode transport failures fail-open outside monitor polling", async () => {
      const exitProbeFailure = { value: true, calls: 0, exitCode: 255 };
      const handle = await spawnRuntimeProbeHandle({ exitProbeFailure });

      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          expect(await handle.getExitCode()).toBeNull();
        }
      } finally {
        exitProbeFailure.value = false;
      }
    });

    it("keeps simultaneous transport failures fail-open outside monitor polling", async () => {
      const outputProbeFailure = { value: true, calls: 0 };
      const exitProbeFailure = { value: true, calls: 0 };
      const handle = await spawnRuntimeProbeHandle({ outputProbeFailure, exitProbeFailure });

      try {
        await expectProbeCallNotToThrow(() => handle.readOutput(0));
        expect(await handle.getExitCode()).toBeNull();
      } finally {
        outputProbeFailure.value = false;
        exitProbeFailure.value = false;
      }
    });

    it("emits a match for a final unterminated line", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'READY'", {
        cwd: process.cwd(),
        displayName: "monitor-unterminated-line",
        monitor: {
          filter: "READY",
          pattern: /READY/,
          exclude: false,
          cooldownMs: 0,
        },
      });

      expect(result.success).toBe(true);
      const event = await eventPromise;
      expect(event.workspaceId).toBe(testWorkspaceId);
      // The unterminated line only matches at settlement, so the payload is the combined
      // settlement wake: matched line first, then the synthetic settle line and output tail.
      expect(event.payload.lines[0]).toBe("READY");
      expect(event.payload.totalMatches).toBe(1);
      expect(event.payload.filter).toBe("READY");
      expect(event.payload.filterExclude).toBe(false);
      expect(event.payload.terminal).toEqual({ status: "exited", exitCode: 0 });
    });

    it("coalesces burst matches within the cooldown window", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR one\\nERR two\\n'",
        {
          cwd: process.cwd(),
          displayName: "monitor-coalesce",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 50,
          },
        }
      );

      expect(result.success).toBe(true);
      const event = await eventPromise;
      // Depending on whether the exit is observed in the same poll, the burst arrives as a plain
      // cooldown flush or coalesced into the settlement payload; the matched lines lead either way.
      expect(event.payload.lines.slice(0, 2)).toEqual(["ERR one", "ERR two"]);
      expect(event.payload.totalMatches).toBe(2);
    });

    it("supports inverted filtering", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'progress\\ndone\\n'", {
        cwd: process.cwd(),
        displayName: "monitor-inverted",
        monitor: {
          filter: "progress",
          pattern: /progress/,
          exclude: true,
          cooldownMs: 0,
        },
      });

      expect(result.success).toBe(true);
      const event = await eventPromise;
      expect(event.payload.lines[0]).toBe("done");
    });

    it("stops monitoring after maxEvents without killing the process", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "for i in 1 2 3; do echo ERR$i; sleep 0.05; done; sleep 2",
        {
          cwd: process.cwd(),
          displayName: "monitor-max-events",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            maxEvents: 1,
            cooldownMs: 0,
          },
        }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Armed monitor on a running process counts as active workspace monitoring.
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(1);
      expect(manager.getActiveMonitorCount(testWorkspaceId2)).toBe(0);

      const event = await eventPromise;
      expect(event.payload.lines).toEqual(["ERR1"]);
      expect(event.payload.totalMatches).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const proc = await manager.getProcess(result.processId);
      expect(proc?.status).toBe("running");
      expect(proc ? manager.getMonitorSnapshot(proc)?.totalMatches : undefined).toBe(1);
      expect(proc ? manager.getMonitorSnapshot(proc)?.stopped : undefined).toBe(true);
      // The monitor stopped (maxEvents) while the process kept running: no longer active.
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
    });

    it("emits a change event when the monitor tail fails", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 5", {
        cwd: process.cwd(),
        displayName: "monitor-tail-failure",
        monitor: {
          filter: "NEVER_MATCHES",
          pattern: /NEVER_MATCHES/,
          exclude: false,
          cooldownMs: 0,
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const proc = await manager.getProcess(result.processId);
      expect(proc).not.toBeNull();
      if (!proc) return;
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(1);

      const changedWorkspaceIds: string[] = [];
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("change", (wsId) => changedWorkspaceIds.push(wsId));
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));
      // Simulate a runtime read failure inside the monitor-only probe path.
      spyOn(proc.handle, "readOutputForMonitor").mockImplementation(() =>
        Promise.resolve({ success: false, error: "read failure" })
      );

      for (let attempt = 0; attempt < 40; attempt++) {
        if (manager.getActiveMonitorCount(testWorkspaceId) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The failed tail must disarm the monitor AND broadcast the change so
      // activity consumers (sidebar watching indicator) can clear.
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
      expect(changedWorkspaceIds).toContain(testWorkspaceId);
      const stoppedEvent = stoppedEvents.find(
        (event) => event.processId === result.processId && event.reason === "failed"
      );
      expect(stoppedEvent?.failureMessage).toContain("3 consecutive times");
      expect(stoppedEvent?.failureMessage).toContain("read failure");
      expect(stoppedEvent?.armMetadata).toMatchObject({
        processId: result.processId,
        taskId: `bash:${result.processId}`,
        filter: "NEVER_MATCHES",
      });
    });

    it("folds a same-poll read chunk into the failure payload when the exit probe escalates", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));
      const matchEvents: MonitorMatchPayload[] = [];
      manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));

      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 5", {
        cwd: process.cwd(),
        displayName: "monitor-exit-probe-chunk",
        monitor: {
          filter: "READY",
          pattern: /READY/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const proc = await manager.getProcess(result.processId);
      expect(proc).not.toBeNull();
      if (!proc) return;

      // The matched chunk must arrive on the poll whose exit probe records the third (fatal)
      // consecutive failure, so the escalation throw is the only step between the read chunk
      // and the failure payload. Keying the chunk to two already-recorded exit failures makes
      // the setup phase-independent: the spies may land mid-iteration (between a read and its
      // exit probe), shifting which read precedes the fatal probe.
      let exitProbes = 0;
      spyOn(proc.handle, "readOutputForMonitor").mockImplementation(() =>
        Promise.resolve(
          exitProbes >= 2
            ? { success: true as const, value: { content: "READY\n", newOffset: 6 } }
            : { success: true as const, value: { content: "", newOffset: 0 } }
        )
      );
      spyOn(proc.handle, "getExitCodeForMonitor").mockImplementation(() => {
        exitProbes += 1;
        return Promise.resolve({ success: false as const, error: "exit probe down" });
      });

      for (let attempt = 0; attempt < 60 && stoppedEvents.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const stoppedEvent = stoppedEvents.find(
        (event) => event.processId === result.processId && event.reason === "failed"
      );
      expect(stoppedEvent?.failedOperations).toEqual(["getExitCode"]);
      expect(stoppedEvent?.failedMatch).toMatchObject({ lines: ["READY"], totalMatches: 1 });
      expect(matchEvents).toEqual([]);
      expect(
        manager
          .pullMonitorWakeSignals(testWorkspaceId)
          .find((snapshot) => snapshot.processId === result.processId)?.match?.lines
      ).toEqual(["READY"]);
    });

    it("retires a monitor after repeated output failures while exit probes stay healthy", async () => {
      const outputProbeFailure = { value: false, calls: 0 };
      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), {
        outputProbeFailure,
      });
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "echo READY; sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-persistent-output-failure",
        monitor: {
          filter: "READY",
          pattern: /READY/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          const proc = manager.peekProcess(result.processId);
          if (proc != null && manager.getMonitorSnapshot(proc)?.totalMatches === 1) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        outputProbeFailure.value = true;
        for (let attempt = 0; attempt < 60 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(outputProbeFailure.calls).toBeGreaterThanOrEqual(3);
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failureMessage).toContain("3 consecutive times");
        expect(stoppedEvent?.failedOperations).toEqual(["readOutput"]);
        expect(stoppedEvent?.armMetadata?.processId).toBe(result.processId);
        expect(stoppedEvent?.failedMatch).toMatchObject({
          lines: ["READY"],
          totalMatches: 1,
        });
      } finally {
        outputProbeFailure.value = false;
      }
    });

    it("suppresses already-shown matches from the failed stop payload", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const outputProbeFailure = { value: false, calls: 0 };
      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), {
        outputProbeFailure,
      });
      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "echo READY; sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-shown-failed-match",
        monitor: {
          filter: "READY",
          pattern: /READY/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          const proc = manager.peekProcess(result.processId);
          if (proc != null && manager.getMonitorSnapshot(proc)?.totalMatches === 1) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // An unfiltered read advances the shown frontier past the matched line before the failure.
        const output = await manager.getOutput(result.processId, undefined, false, 1);
        expect(output.success).toBe(true);
        outputProbeFailure.value = true;
        for (let attempt = 0; attempt < 60 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failedMatch).toMatchObject({ lines: [], totalMatches: 1 });
        expect(stoppedEvent?.failedMatch?.matchedThroughOffset).toBeUndefined();
      } finally {
        outputProbeFailure.value = false;
      }
    });

    it("retires the monitor when the output file disappears mid-run", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()));
      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-output-file-gone",
        monitor: {
          filter: "NEVER",
          pattern: /NEVER/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        await fs.rm(path.join(result.outputDir, "output.log"), { force: true });
        for (let attempt = 0; attempt < 120 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failedOperations).toEqual(["readOutput"]);
      } finally {
        await manager.terminate(result.processId, { monitorDisposition: "discard" });
      }
    });

    it("retires the monitor when the exit marker is corrupted", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()));
      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-exit-marker-corrupt",
        monitor: {
          filter: "NEVER",
          pattern: /NEVER/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        await fs.writeFile(path.join(result.outputDir, "exit_code"), "garbage\n", "utf-8");
        for (let attempt = 0; attempt < 120 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failedOperations).toEqual(["getExitCode"]);
      } finally {
        await manager.terminate(result.processId, { monitorDisposition: "discard" });
      }
    });

    it("retires the monitor when the exit marker becomes unreadable", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()));
      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-exit-marker-unreadable",
        monitor: {
          filter: "NEVER",
          pattern: /NEVER/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        // A directory where the marker file should be makes cat fail without the marker
        // reading as absent (running).
        await fs.mkdir(path.join(result.outputDir, "exit_code"), { recursive: true });
        for (let attempt = 0; attempt < 120 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failedOperations).toEqual(["getExitCode"]);
      } finally {
        await manager.terminate(result.processId, { monitorDisposition: "discard" });
      }
    });

    it("resets consecutive output failures after an output probe succeeds", async () => {
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-output-probe-recovery",
        monitor: {
          filter: "NEVER_MATCHES",
          pattern: /NEVER_MATCHES/,
          exclude: false,
          cooldownMs: 0,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const proc = manager.peekProcess(result.processId);
      expect(proc).not.toBeNull();
      if (proc == null) return;

      let probeCalls = 0;
      let persistentlyFail = false;
      spyOn(proc.handle, "readOutputForMonitor").mockImplementation((offset) => {
        probeCalls++;
        if (persistentlyFail || probeCalls <= 2 || (probeCalls >= 4 && probeCalls <= 5)) {
          return Promise.resolve({ success: false, error: "read failure" });
        }
        return Promise.resolve({ success: true, value: { content: "", newOffset: offset } });
      });

      for (let attempt = 0; attempt < 40 && probeCalls < 6; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(probeCalls).toBeGreaterThanOrEqual(6);
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(1);

      const callsBeforePersistentFailure = probeCalls;
      persistentlyFail = true;
      for (let attempt = 0; attempt < 40 && stoppedEvents.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(probeCalls - callsBeforePersistentFailure).toBeGreaterThanOrEqual(3);
      expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
      expect(stoppedEvents[0]?.failedOperations).toEqual(["readOutput"]);
    });

    it("keeps task output readable after exit-probe failure retires the monitor", async () => {
      const exitProbeFailure = { value: false, calls: 0 };
      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), {
        exitProbeFailure,
      });
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const result = await manager.spawn(
        remoteRuntime,
        testWorkspaceId,
        "echo readable-output; sleep 10",
        {
          cwd: process.cwd(),
          displayName: "monitor-exit-probe-failure",
          monitor: {
            filter: "NEVER_MATCHES",
            pattern: /NEVER_MATCHES/,
            exclude: false,
            cooldownMs: 0,
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        exitProbeFailure.value = true;
        for (let attempt = 0; attempt < 60 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent?.failedOperations).toEqual(["getExitCode"]);
        expect((await manager.getProcess(result.processId))?.id).toBe(result.processId);
        expect((await manager.list(testWorkspaceId)).map((proc) => proc.id)).toContain(
          result.processId
        );
        expect(await manager.list(testWorkspaceId2)).toEqual([]);

        const output = await manager.getOutput(result.processId, undefined, undefined, 0);
        expect(output.success).toBe(true);
        if (output.success) expect(output.output).toContain("readable-output");
      } finally {
        exitProbeFailure.value = false;
      }
    });

    it("retires a real runtime monitor only after both transport probes fail", async () => {
      const outputProbeFailure = { value: false, calls: 0 };
      const exitProbeFailure = { value: false, calls: 0 };
      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), {
        outputProbeFailure,
        exitProbeFailure,
      });
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-transport-failure",
        monitor: {
          filter: "NEVER_MATCHES",
          pattern: /NEVER_MATCHES/,
          exclude: false,
          cooldownMs: 0,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        outputProbeFailure.value = true;
        for (let attempt = 0; attempt < 40 && outputProbeFailure.calls === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(outputProbeFailure.calls).toBeGreaterThan(0);
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(1);

        exitProbeFailure.value = true;
        for (let attempt = 0; attempt < 40 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(exitProbeFailure.calls).toBeGreaterThan(0);
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failureMessage).toContain("Background process monitor probes failed");
        expect([...(stoppedEvent?.failedOperations ?? [])].sort()).toEqual([
          "getExitCode",
          "readOutput",
        ]);
      } finally {
        outputProbeFailure.value = false;
        exitProbeFailure.value = false;
      }
    });

    it("retires a real runtime monitor after both probes resolve nonzero", async () => {
      const outputProbeFailure = { value: false, calls: 0, exitCode: 255 };
      const exitProbeFailure = { value: false, calls: 0, exitCode: 255 };
      const remoteRuntime = createRemoteLikeRuntime(new LocalRuntime(process.cwd()), {
        outputProbeFailure,
        exitProbeFailure,
      });
      const stoppedEvents: MonitorStoppedPayload[] = [];
      manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

      const result = await manager.spawn(remoteRuntime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "monitor-nonzero-transport-failure",
        monitor: {
          filter: "NEVER_MATCHES",
          pattern: /NEVER_MATCHES/,
          exclude: false,
          cooldownMs: 0,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      try {
        outputProbeFailure.value = true;
        for (let attempt = 0; attempt < 40 && outputProbeFailure.calls === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(outputProbeFailure.calls).toBeGreaterThan(0);
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(1);

        exitProbeFailure.value = true;
        for (let attempt = 0; attempt < 40 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(exitProbeFailure.calls).toBeGreaterThan(0);
        expect(manager.getActiveMonitorCount(testWorkspaceId)).toBe(0);
        const stoppedEvent = stoppedEvents.find(
          (event) => event.processId === result.processId && event.reason === "failed"
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent?.failureMessage).toContain("exited with code 255");
        expect([...(stoppedEvent?.failedOperations ?? [])].sort()).toEqual([
          "getExitCode",
          "readOutput",
        ]);
      } finally {
        outputProbeFailure.value = false;
        exitProbeFailure.value = false;
      }
    });

    describe("armed/stopped registry events", () => {
      function recordEvents(target: BackgroundProcessManager): {
        armed: Array<{ workspaceId: string; payload: MonitorArmedPayload }>;
        stopped: Array<{ workspaceId: string; payload: MonitorStoppedPayload }>;
      } {
        const events: {
          armed: Array<{ workspaceId: string; payload: MonitorArmedPayload }>;
          stopped: Array<{ workspaceId: string; payload: MonitorStoppedPayload }>;
        } = { armed: [], stopped: [] };
        target.on("monitor:armed", (workspaceId, payload) => {
          events.armed.push({ workspaceId, payload });
        });
        target.on("monitor:stopped", (workspaceId, payload) => {
          events.stopped.push({ workspaceId, payload });
        });
        return events;
      }

      it("emits monitor:armed on monitored spawn but not on unmonitored spawn", async () => {
        const events = recordEvents(manager);

        const unmonitored = await manager.spawn(runtime, testWorkspaceId, "sleep 5", {
          cwd: process.cwd(),
          displayName: "no-monitor",
        });
        expect(unmonitored.success).toBe(true);
        expect(events.armed).toHaveLength(0);

        const monitored = await manager.spawn(runtime, testWorkspaceId, "sleep 5", {
          cwd: process.cwd(),
          displayName: "with-monitor",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(monitored.success).toBe(true);
        if (!monitored.success) return;
        expect(events.armed).toHaveLength(1);
        expect(events.armed[0].workspaceId).toBe(testWorkspaceId);
        expect(events.armed[0].payload).toMatchObject({
          processId: monitored.processId,
          taskId: `bash:${monitored.processId}`,
          workspaceId: testWorkspaceId,
          filter: "NEVER",
          filterExclude: false,
          script: "sleep 5",
        });
      });

      it("emits monitor:stopped on natural exit, maxEvents, and terminate", async () => {
        const events = recordEvents(manager);

        // Natural exit
        const exiting = await manager.spawn(runtime, testWorkspaceId, "echo done", {
          cwd: process.cwd(),
          displayName: "stopped-on-exit",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(exiting.success).toBe(true);
        if (!exiting.success) return;
        for (let attempt = 0; attempt < 60 && events.stopped.length < 1; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(events.stopped.map((e) => e.payload.processId)).toEqual([exiting.processId]);

        // maxEvents (process keeps running)
        const maxed = await manager.spawn(runtime, testWorkspaceId, "echo ERR; sleep 5", {
          cwd: process.cwd(),
          displayName: "stopped-on-max-events",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            maxEvents: 1,
            cooldownMs: 0,
          },
        });
        expect(maxed.success).toBe(true);
        if (!maxed.success) return;
        for (let attempt = 0; attempt < 60 && events.stopped.length < 2; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(events.stopped.map((e) => e.payload.processId)).toContain(maxed.processId);

        // terminate()
        const terminated = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
          cwd: process.cwd(),
          displayName: "stopped-on-terminate",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(terminated.success).toBe(true);
        if (!terminated.success) return;
        await manager.terminate(terminated.processId, { monitorDisposition: "discard" });
        const canceled = events.stopped.find(
          (event) => event.payload.processId === terminated.processId
        );
        expect(canceled?.workspaceId).toBe(testWorkspaceId);
        expect(canceled?.payload).toMatchObject({
          processId: terminated.processId,
          reason: "canceled",
        });
      });

      it("suppresses monitor:stopped after beginShutdown so registry records survive restarts", async () => {
        const events = recordEvents(manager);

        const result = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
          cwd: process.cwd(),
          displayName: "shutdown-monitor",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        expect(events.armed).toHaveLength(1);

        manager.beginShutdown();
        // Both the per-workspace cleanup path (AgentSession.dispose) and terminateAll
        // run during shutdown; neither may retire registry records.
        await manager.cleanup(testWorkspaceId);
        await manager.terminateAll();
        expect(events.stopped).toHaveLength(0);
      });
    });

    it("resolves a pending cooldown flush into one settlement wake on exit", async () => {
      // Previously a 10s cooldown timer could outlive the exited process until terminate()
      // cleared it. Settlement now claims the monitor at exit: the timer is cancelled, the
      // pending match coalesces into ONE combined settlement payload, and a later terminate on
      // the already-exited process stays idempotent (no second wake).
      const matches: MonitorMatchPayload[] = [];
      manager.on("monitor:match", (_workspaceId, payload) => matches.push(payload));

      const result = await manager.spawn(runtime, testWorkspaceId, "echo ERR", {
        cwd: process.cwd(),
        displayName: "monitor-exited-terminate",
        monitor: {
          filter: "ERR",
          pattern: /ERR/,
          exclude: false,
          cooldownMs: 10_000,
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if (proc?.monitor?.stopped) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(proc?.status).toBe("exited");
      expect(proc?.monitor?.stopped).toBe(true);
      expect(proc?.monitor?.flushTimer).toBeUndefined();
      expect(matches).toHaveLength(1);
      expect(matches[0].lines[0]).toBe("ERR");
      expect(matches[0].terminal).toEqual({ status: "exited", exitCode: 0 });

      const terminateResult = await manager.terminate(result.processId, {
        monitorDisposition: "flush",
      });
      expect(terminateResult.success).toBe(true);
      expect(matches).toHaveLength(1);
    });

    it("discards deferred monitor matches on explicit termination", async () => {
      const matches: MonitorMatchPayload[] = [];
      manager.on("monitor:match", (_workspaceId, payload) => matches.push(payload));

      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'FAILED pending\\n'; sleep 5",
        {
          cwd: process.cwd(),
          displayName: "monitor-canceled-match",
          monitor: {
            filter: "FAILED",
            pattern: /FAILED/,
            exclude: false,
            cooldownMs: 10_000,
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if ((proc?.monitor?.pendingLines.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc?.monitor?.pendingLines).toEqual(["FAILED pending"]);

      await manager.terminate(result.processId, { monitorDisposition: "discard" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(matches).toHaveLength(0);
      expect(proc?.monitor?.pendingLines).toEqual([]);
    });

    it("does not consume the task_await output cursor", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR one\\nkeep me\\n'",
        {
          cwd: process.cwd(),
          displayName: "monitor-cursor",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 0,
          },
        }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      await eventPromise;

      const output = await manager.getOutput(result.processId, undefined, false, 1);
      expect(output.success).toBe(true);
      if (output.success) {
        expect(output.output).toContain("ERR one");
        expect(output.output).toContain("keep me");
      }
    });

    it("drops a deferred monitor wake once the agent reads past the matched output", async () => {
      // Regression: a monitor must not wake the agent about output the agent has already read
      // inline (e.g. via a concurrent task_await / bash_output on the same bash task). Without
      // the cursor guard in emitMonitorMatch the deferred flush double-reports the matched line.
      let matchCount = 0;
      const handler = () => {
        matchCount++;
      };
      manager.on("monitor:match", handler);

      // Print a matching line, then stay alive so the only flush we trigger is the explicit
      // terminate() below -- never the cooldown timer (kept large) nor process exit.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR boom\\n'; sleep 5",
        {
          cwd: process.cwd(),
          displayName: "monitor-already-read",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 10_000,
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait until the monitor has scanned and queued the match (flush deferred by the cooldown).
      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if ((proc?.monitor?.pendingLines.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc?.monitor?.pendingLines.length ?? 0).toBeGreaterThan(0);

      // Agent reads the output inline, advancing its cursor to the monitor's scan position.
      const output = await manager.getOutput(result.processId, undefined, false, 1);
      expect(output.success).toBe(true);
      if (output.success) expect(output.output).toContain("ERR boom");

      // Precondition for the drop: the read cursor has caught up to the monitor's scan offset.
      proc = await manager.getProcess(result.processId);
      expect(proc?.outputBytesRead ?? 0).toBeGreaterThanOrEqual(proc?.monitor?.lastReadOffset ?? 0);

      // Force the deferred flush. The cursor has caught up, so it must drop instead of waking.
      await manager.terminate(result.processId, { monitorDisposition: "discard" });
      expect(matchCount).toBe(0);

      manager.off("monitor:match", handler);
    });

    it("still wakes when the matched line was only buffered (unterminated), not shown", async () => {
      // getOutput advances outputBytesRead past an unterminated trailing line but keeps it in
      // incompleteLineBuffer (not returned). The monitor only matches that line on exit, when the
      // agent still hasn't seen it -- so the wake must NOT be suppressed by the read cursor.
      const eventPromise = waitForMonitorMatch(manager, 6_000);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'ERR boom'; sleep 3", {
        cwd: process.cwd(),
        displayName: "monitor-buffered-unterminated",
        monitor: {
          filter: "ERR",
          pattern: /ERR/,
          exclude: false,
          cooldownMs: 0,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Read while running: "ERR boom" has no trailing newline, so it is buffered (cursor advances)
      // rather than returned to the agent.
      const reading = await manager.getOutput(result.processId, undefined, false, 1);
      expect(reading.success).toBe(true);
      const proc = await manager.getProcess(result.processId);
      expect(proc?.incompleteLineBuffer).toContain("ERR boom");

      // On exit the monitor finalizes the buffered line; the agent never saw it, so it still wakes
      // as part of the combined settlement payload (matched line first).
      const event = await eventPromise;
      expect(event.payload.lines[0]).toBe("ERR boom");
      expect(event.payload.matchedThroughOffset).toBeDefined();
      expect(event.payload.terminal?.status).toBe("exited");
    });

    it("drops the wake for a matched line even when a trailing fragment follows it", async () => {
      // A complete matched line followed by an unterminated fragment: getOutput returns the line
      // and buffers only the fragment, so the agent HAS seen the match. The monitor's raw scan
      // cursor (lastReadOffset) includes the fragment, so comparing against it would wrongly wake;
      // matchedThroughOffset (end of the matched line) must drive the suppression instead.
      let matchCount = 0;
      const handler = () => {
        matchCount++;
      };
      manager.on("monitor:match", handler);

      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR foo\\npartial'; sleep 5",
        {
          cwd: process.cwd(),
          displayName: "monitor-line-plus-fragment",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 10_000,
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait until the monitor has recorded the match and parked the trailing fragment.
      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if ((proc?.monitor?.pendingLines.length ?? 0) > 0 && proc?.monitor?.incompleteLineBuffer)
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc?.monitor?.pendingLines ?? []).toEqual(["ERR foo"]);
      expect(proc?.monitor?.incompleteLineBuffer).toContain("partial");
      // matchedThroughOffset ends at the matched line; the raw scan cursor sits past it.
      expect(proc?.monitor?.matchedThroughOffset ?? 0).toBeLessThan(
        proc?.monitor?.lastReadOffset ?? 0
      );

      // Agent reads inline: gets "ERR foo", buffers "partial".
      const output = await manager.getOutput(result.processId, undefined, false, 1);
      expect(output.success).toBe(true);
      if (output.success) expect(output.output).toContain("ERR foo");

      // The agent has been shown through the matched line, so the deferred flush must drop.
      await manager.terminate(result.processId, { monitorDisposition: "discard" });
      expect(matchCount).toBe(0);

      manager.off("monitor:match", handler);
    });

    it("anchors matchedThroughOffset to the matched line, not later output in the same chunk", async () => {
      // A matched line followed by a non-matching complete line in one poll: matchedThroughOffset
      // must point at the end of the matched line (byte 8 of "ERR foo\n"), not the end of the whole
      // complete region (byte 16 of "...nomatch\n"). Otherwise an agent that read only the matched
      // line stays below the inflated offset and gets a redundant wake.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR foo\\nnomatch\\n'; sleep 5",
        {
          cwd: process.cwd(),
          displayName: "monitor-matched-line-anchor",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 10_000,
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait until both lines have been scanned (cursor at 16, no fragment buffered).
      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if (
          (proc?.monitor?.lastReadOffset ?? 0) >= 16 &&
          (proc?.monitor?.pendingLines.length ?? 0) > 0
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc?.monitor?.pendingLines ?? []).toEqual(["ERR foo"]);
      expect(proc?.monitor?.matchedThroughOffset).toBe(8);
      expect(proc?.monitor?.lastReadOffset).toBe(16);
    });

    it("still wakes on natural exit when a filtered read did not show the matched line", async () => {
      // A filtered task_await / bash_output read advances outputBytesRead past every complete line
      // but returns only lines matching its own filter. A pending monitor match for "ERR" must still
      // wake on natural exit: the error line was never shown to the agent.
      const eventPromise = waitForMonitorMatch(manager);

      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR boom\\nDONE\\n'; sleep 0.5",
        {
          cwd: process.cwd(),
          displayName: "monitor-filtered-read",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            cooldownMs: 10_000, // defer the flush so the filtered read happens first
          },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait until the monitor has matched "ERR boom" (flush deferred by the cooldown).
      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 60; attempt++) {
        proc = await manager.getProcess(result.processId);
        if ((proc?.monitor?.pendingLines.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc?.monitor?.pendingLines ?? []).toEqual(["ERR boom"]);

      // Agent reads with a filter that excludes the error line: it sees only "DONE".
      const filtered = await manager.getOutput(result.processId, "DONE", false, 1);
      expect(filtered.success).toBe(true);
      if (filtered.success) {
        expect(filtered.output).toContain("DONE");
        expect(filtered.output).not.toContain("ERR boom");
      }
      // The filtered read must not have advanced the shown mark.
      proc = await manager.getProcess(result.processId);
      expect(proc?.shownThroughOffset ?? -1).toBe(0);

      // Natural exit flushes the deferred match because the error was never shown; it leads the
      // combined settlement payload and keeps its matched-output offset.
      const event = await eventPromise;
      expect(event.payload.lines[0]).toBe("ERR boom");
      expect(event.payload.matchedThroughOffset).toBeDefined();
      expect(event.payload.terminal?.status).toBe("exited");
    });

    it("does not advance the shown frontier across lines a prior filtered read consumed", async () => {
      // Regression for the drain-time suppression edge case Codex flagged: outputBytesRead is a
      // shared cursor, so a filtered read that consumes a matched complete line (without ever
      // showing it) advances the cursor past that line while leaving shownThroughOffset behind. A
      // later unfiltered read with no new output must not let the frontier jump that gap -- else
      // getSettledShownThroughOffset would report the filtered-out line as shown and the drain gate
      // would supersede the only wake for output the agent never saw.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'ERR boom\\nDONE\\n'; sleep 5",
        { cwd: process.cwd(), displayName: "frontier-gap-filtered" }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Filtered read consumes both complete lines (cursor advances to 14) but shows only "DONE".
      const filtered = await manager.getOutput(result.processId, "DONE", false, 2);
      expect(filtered.success).toBe(true);
      if (filtered.success) {
        expect(filtered.output).toContain("DONE");
        expect(filtered.output).not.toContain("ERR boom");
      }
      let proc = await manager.getProcess(result.processId);
      expect(proc?.outputBytesRead ?? 0).toBeGreaterThanOrEqual(14);
      expect(proc?.shownThroughOffset ?? -1).toBe(0);

      // Unfiltered read finds no new output; the contiguity guard must keep the frontier pinned.
      const unfiltered = await manager.getOutput(result.processId, undefined, false, 1);
      expect(unfiltered.success).toBe(true);
      proc = await manager.getProcess(result.processId);
      expect(proc?.shownThroughOffset ?? -1).toBe(0);
      // The delivery gate therefore still treats the filtered-out ERR line as unshown.
      expect(await manager.getSettledShownThroughOffset(result.processId)).toBe(0);

      await manager.terminate(result.processId, { monitorDisposition: "discard" });
    });

    it("strips ANSI before matching and emitting matched lines", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf '\\033[31mFAILED\\033[0m\\n'",
        {
          cwd: process.cwd(),
          displayName: "monitor-ansi",
          monitor: {
            filter: "^FAILED$",
            pattern: /^FAILED$/,
            exclude: false,
            cooldownMs: 0,
          },
        }
      );

      expect(result.success).toBe(true);
      const event = await eventPromise;
      expect(event.payload.lines[0]).toBe("FAILED");
    });

    it("matches long complete lines when the token appears after the prompt cap", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        `bun -e "process.stdout.write('A'.repeat(16384) + ' FAILED tail\\n')"`,
        {
          cwd: process.cwd(),
          displayName: "monitor-long-line-suffix",
          monitor: {
            filter: "FAILED tail",
            pattern: /FAILED tail/,
            exclude: false,
            cooldownMs: 0,
          },
        }
      );

      expect(result.success).toBe(true);
      const event = await eventPromise;
      expect(event.payload.lines[0]).toContain("FAILED tail");
      expect(event.payload.lines[0]).toContain("truncated");
    });

    it("bounds incomplete monitor lines while a process keeps running", async () => {
      const longByteCount = 1_100_000;
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        `bun -e "process.stdout.write('A'.repeat(${longByteCount})); setTimeout(() => {}, 2000)"`,
        {
          cwd: process.cwd(),
          displayName: "monitor-incomplete-bound",
          monitor: {
            filter: "NEVER_MATCHES",
            pattern: /NEVER_MATCHES/,
            exclude: false,
            cooldownMs: 0,
          },
        }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      let incompleteLineBytes = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        const proc = await manager.getProcess(result.processId);
        incompleteLineBytes = Buffer.byteLength(proc?.monitor?.incompleteLineBuffer ?? "", "utf8");
        if (incompleteLineBytes > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(incompleteLineBytes).toBeGreaterThan(0);
      expect(incompleteLineBytes).toBeLessThanOrEqual(1_000_000);
    });

    it("retains matched lines until the reconciler acknowledges their offset", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'READY\n'; sleep 30", {
        cwd: process.cwd(),
        displayName: "retained-monitor-match",
        monitor: { filter: "READY", pattern: /READY/, exclude: false, cooldownMs: 0 },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      await eventPromise;

      const before = manager.pullMonitorWakeSignals(testWorkspaceId);
      const snapshot = before.find((candidate) => candidate.processId === result.processId);
      expect(snapshot?.match?.lines).toEqual(["READY"]);
      expect(snapshot?.match?.throughOffset).toBeGreaterThan(0);

      manager.acknowledgeMonitorWake(
        result.processId,
        Date.parse(snapshot?.createdAt ?? ""),
        snapshot?.match?.throughOffset
      );
      const after = manager.pullMonitorWakeSignals(testWorkspaceId);
      expect(
        after.find((candidate) => candidate.processId === result.processId)?.match
      ).toBeUndefined();
      await manager.terminate(result.processId, { monitorDisposition: "discard" });
    });

    it("cancellation after max-events retirement clears retained wake state", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'READY\n'; sleep 30", {
        cwd: process.cwd(),
        displayName: "retired-then-canceled",
        monitor: {
          filter: "READY",
          pattern: /READY/,
          exclude: false,
          cooldownMs: 0,
          maxEvents: 1,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      await eventPromise;
      expect(
        manager
          .pullMonitorWakeSignals(testWorkspaceId)
          .find((snapshot) => snapshot.processId === result.processId)?.match?.lines
      ).toEqual(["READY"]);

      await manager.terminate(result.processId, { monitorDisposition: "discard" });

      expect(
        manager
          .pullMonitorWakeSignals(testWorkspaceId)
          .find((snapshot) => snapshot.processId === result.processId)?.match
      ).toBeUndefined();
    });

    it("acknowledging one flush preserves only later retained batches", async () => {
      const events: MonitorMatchPayload[] = [];
      manager.on("monitor:match", (_workspaceId, payload) => events.push(payload));
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "printf 'BATCH_A\n'; sleep 0.5; printf 'BATCH_B\n'; sleep 30",
        {
          cwd: process.cwd(),
          displayName: "retained-monitor-batches",
          monitor: { filter: "BATCH_", pattern: /BATCH_/, exclude: false, cooldownMs: 0 },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      for (let attempt = 0; attempt < 80 && events.length < 1; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const first = manager
        .pullMonitorWakeSignals(testWorkspaceId)
        .find((snapshot) => snapshot.processId === result.processId);
      expect(first?.match?.lines).toEqual(["BATCH_A"]);
      for (let attempt = 0; attempt < 80 && events.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      manager.acknowledgeMonitorWake(
        result.processId,
        Date.parse(first?.createdAt ?? ""),
        first?.match?.throughOffset
      );

      const remaining = manager
        .pullMonitorWakeSignals(testWorkspaceId)
        .find((snapshot) => snapshot.processId === result.processId);
      expect(remaining?.match?.lines).toEqual(["BATCH_B"]);
      await manager.terminate(result.processId, { monitorDisposition: "discard" });
    });

    describe("settlement wakes", () => {
      it("wakes with a terminal payload when the process exits without any match, before monitor:stopped", async () => {
        // Incident regression (workspace 31d3dfd254): a watcher script exits printing a failure
        // line that never matches the filter -> previously the monitor retired silently and the
        // idle owner was never woken.
        const order: string[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        const matchEvents: MonitorMatchPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => {
          order.push("match");
          matchEvents.push(payload);
        });
        manager.on("monitor:stopped", (_workspaceId, payload) => {
          order.push("stopped");
          stoppedEvents.push(payload);
        });

        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'Unresolved review comments found\\n'; exit 1",
          {
            cwd: process.cwd(),
            displayName: "settle-no-match",
            monitor: {
              filter: "All checks passed",
              pattern: /All checks passed/,
              exclude: false,
              cooldownMs: 0,
            },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(matchEvents).toHaveLength(1);
        const payload = matchEvents[0];
        expect(payload.terminal).toEqual({ status: "exited", exitCode: 1 });
        // Terminal-only settlement: no undelivered matched output, so no offset signal that
        // could ever falsely suppress the wake (EOF == shown offset for unread output is fine).
        expect(payload.matchedThroughOffset).toBeUndefined();
        expect(payload.lines).toEqual([]);
        expect(
          (payload.tailLines ?? []).some((line) =>
            line.includes("Unresolved review comments found")
          )
        ).toBe(true);
        const wakeSignal = manager
          .pullMonitorWakeSignals(testWorkspaceId)
          .find((snapshot) => snapshot.processId === result.processId);
        expect(wakeSignal?.match).toBeUndefined();
        expect(
          wakeSignal?.terminal?.tailLines?.some(
            (entry) =>
              entry.line.includes("Unresolved review comments found") && entry.endOffset > 0
          )
        ).toBe(true);
        // Durability ordering: the wake emit precedes registry deletion.
        expect(order).toEqual(["match", "stopped"]);
        expect(stoppedEvents[0]).toMatchObject({
          processId: result.processId,
          reason: "completed",
          terminal: { status: "exited", exitCode: 1, wakeOnExit: true },
        });
      });

      it("wakes for a zero-output process (never suppressed by the offset gate)", async () => {
        const eventPromise = waitForMonitorMatch(manager, 6_000);
        const result = await manager.spawn(runtime, testWorkspaceId, "exit 3", {
          cwd: process.cwd(),
          displayName: "settle-zero-output",
          monitor: { filter: "READY", pattern: /READY/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const event = await eventPromise;
        expect(event.payload.terminal).toEqual({ status: "exited", exitCode: 3 });
        expect(event.payload.matchedThroughOffset).toBeUndefined();
        expect(event.payload.lines).toEqual([]);
      });

      it("timeout auto-termination settles with a deterministic killed payload", async () => {
        const eventPromise = waitForMonitorMatch(manager, 10_000);
        const result = await manager.spawn(runtime, testWorkspaceId, "sleep 30", {
          cwd: process.cwd(),
          displayName: "settle-timeout-kill",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
          timeoutSecs: 1,
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const event = await eventPromise;
        expect(event.payload.terminal?.status).toBe("killed");
        expect(event.payload.lines).toEqual([]);
      });

      it("emits ONE coalesced payload for pending matched lines plus exit", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));

        // The 10s cooldown guarantees the match is still pending when the exit is observed.
        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'ERR boom\\n'; sleep 0.5; exit 2",
          {
            cwd: process.cwd(),
            displayName: "settle-coalesced",
            monitor: { filter: "ERR", pattern: /ERR/, exclude: false, cooldownMs: 10_000 },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && matchEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Give a possible (buggy) second emit time to surface before asserting exactly one.
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(matchEvents).toHaveLength(1);
        const payload = matchEvents[0];
        expect(payload.lines[0]).toBe("ERR boom");
        expect(payload.matchedThroughOffset).toBeDefined();
        expect(payload.terminal).toEqual({ status: "exited", exitCode: 2 });
        expect(payload.lines).toEqual(["ERR boom"]);
        const wakeSignal = manager
          .pullMonitorWakeSignals(testWorkspaceId)
          .find((snapshot) => snapshot.processId === result.processId);
        expect(wakeSignal?.match?.lines).toEqual(["ERR boom"]);
        expect(wakeSignal?.match?.lines.some((line) => line.includes("process settled:"))).toBe(
          false
        );
      });

      it("emits no settlement wake on discard-mode termination (task_stop)", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "sleep 30", {
          cwd: process.cwd(),
          displayName: "settle-canceled",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        await manager.terminate(result.processId, { monitorDisposition: "discard" });
        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(matchEvents).toHaveLength(0);
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toMatchObject({ processId: result.processId, reason: "canceled" });
      });

      it("wake_on_exit=false suppresses the terminal wake entirely on a no-match exit", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'nope\\n'; exit 1", {
          cwd: process.cwd(),
          displayName: "settle-opt-out",
          monitor: {
            filter: "NEVER",
            pattern: /NEVER/,
            exclude: false,
            cooldownMs: 0,
            wakeOnExit: false,
          },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toMatchObject({
          processId: result.processId,
          reason: "completed",
          terminal: { status: "exited", exitCode: 1, wakeOnExit: false },
        });
        expect(matchEvents).toHaveLength(0);
      });

      it("wake_on_exit=false still flushes pending matched lines without terminal metadata", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'ERR boom\\n'; sleep 0.5",
          {
            cwd: process.cwd(),
            displayName: "settle-opt-out-flush",
            monitor: {
              filter: "ERR",
              pattern: /ERR/,
              exclude: false,
              cooldownMs: 10_000,
              wakeOnExit: false,
            },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && matchEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(matchEvents).toHaveLength(1);
        expect(matchEvents[0].lines).toEqual(["ERR boom"]);
        expect(matchEvents[0].terminal).toBeUndefined();
        expect(matchEvents[0].matchedThroughOffset).toBeDefined();
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0].terminal?.matchedThroughOffset).toBe(
          matchEvents[0].matchedThroughOffset
        );
      });

      it("does not settle after maxEvents retirement", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        // Match + retire while the process is still running, then let it exit.
        const result = await manager.spawn(runtime, testWorkspaceId, "echo ERR1; sleep 1; exit 7", {
          cwd: process.cwd(),
          displayName: "settle-max-events",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            maxEvents: 1,
            cooldownMs: 0,
          },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        // Wait until the process has exited (well past the maxEvents retirement).
        let proc = await manager.getProcess(result.processId);
        for (let attempt = 0; attempt < 80; attempt++) {
          proc = await manager.getProcess(result.processId);
          if (proc?.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(matchEvents).toHaveLength(1);
        expect(matchEvents[0].terminal).toBeUndefined();
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toMatchObject({
          processId: result.processId,
          reason: "completed",
        });
      });

      it("maxEvents reached inside the settlement scan still yields one combined payload", async () => {
        // The matching line is unterminated, so it can only match during the settlement scan
        // (includeIncompleteLine) — maxEvents retirement must not fire there and split the wake.
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'ERR final'", {
          cwd: process.cwd(),
          displayName: "settle-max-events-scan",
          monitor: {
            filter: "ERR",
            pattern: /ERR/,
            exclude: false,
            maxEvents: 1,
            cooldownMs: 0,
          },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && stoppedEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(matchEvents).toHaveLength(1);
        expect(matchEvents[0].lines[0]).toBe("ERR final");
        // The matched line appears once in lines; its tail-window duplicate travels separately
        // and is deduped by BashMonitorWakeReconciler.composeLines before delivery.
        expect(matchEvents[0].lines.filter((line) => line === "ERR final")).toHaveLength(1);
        expect(matchEvents[0].terminal).toEqual({ status: "exited", exitCode: 0 });
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toMatchObject({
          processId: result.processId,
          reason: "completed",
          terminal: { status: "exited", exitCode: 0, wakeOnExit: true },
        });
      });

      it("honors max_events while accumulating settlement matches", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));

        // Three matching lines then immediate exit. Whether they process in the settlement scan
        // (exit observed before the poll) or a pre-exit poll wins the race, the max_events cap
        // must hold: at most one matched line ever persists and totalMatches never exceeds 1.
        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'ERR one\\nERR two\\nERR three'",
          {
            cwd: process.cwd(),
            displayName: "settle-max-events-cap",
            monitor: {
              filter: "ERR",
              pattern: /ERR/,
              exclude: false,
              maxEvents: 1,
              cooldownMs: 5_000,
            },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        for (let attempt = 0; attempt < 80 && matchEvents.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));

        const matchedLines = matchEvents.flatMap((event) =>
          event.lines.filter((line) => line.startsWith("ERR"))
        );
        expect(matchedLines).toEqual(["ERR one"]);
        expect(Math.max(...matchEvents.map((event) => event.totalMatches))).toBe(1);
      });

      it("abandons a claimed settlement when shutdown begins mid-flight", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'bye\\n'", {
          cwd: process.cwd(),
          displayName: "settle-shutdown-midflight",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        if (proc == null) return;

        // Hold the settlement helper inside its tail read so beginShutdown deterministically
        // lands after the claim (claimMonitorSettlement's own shutdown guard is already past).
        let releaseTail!: () => void;
        const tailGate = new Promise<void>((resolve) => {
          releaseTail = resolve;
        });
        let tailReadStarted!: () => void;
        const tailReadStartedPromise = new Promise<void>((resolve) => {
          tailReadStarted = resolve;
        });
        const realGetOutputFileSize = proc.handle.getOutputFileSize.bind(proc.handle);
        spyOn(proc.handle, "getOutputFileSize").mockImplementation(async () => {
          tailReadStarted();
          await tailGate;
          return realGetOutputFileSize();
        });

        await tailReadStartedPromise;
        manager.beginShutdown();
        releaseTail();
        await new Promise((resolve) => setTimeout(resolve, 300));

        // No settlement wake may be persisted or queued during ServiceContainer.dispose, and no
        // monitor:stopped may erase the registry record the restart monitor-lost notice needs.
        expect(matchEvents).toHaveLength(0);
        expect(stoppedEvents).toHaveLength(0);
      });

      it("abandons pending matches when shutdown lands during a failed settlement scan (wake_on_exit=false)", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'ERR pending\\n'; sleep 0.5",
          {
            cwd: process.cwd(),
            displayName: "settle-shutdown-scan-failure",
            monitor: {
              filter: "ERR",
              pattern: /ERR/,
              exclude: false,
              cooldownMs: 60_000,
              wakeOnExit: false,
            },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        if (proc == null) return;

        // Wait until the match is pending (unflushed under the long cooldown).
        for (let attempt = 0; attempt < 80; attempt++) {
          if ((proc.monitor?.pendingLines.length ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(proc.monitor?.pendingLines).toEqual(["ERR pending"]);

        // Fail the settlement scan read (only reads under the settled latch) while holding it
        // open so beginShutdown deterministically lands mid-scan. The wake_on_exit=false branch
        // has no tail read, so this is the only guard between the failed scan and the legacy
        // pending-match emit.
        let releaseScan!: () => void;
        const scanGate = new Promise<void>((resolve) => {
          releaseScan = resolve;
        });
        let scanStarted!: () => void;
        const scanStartedPromise = new Promise<void>((resolve) => {
          scanStarted = resolve;
        });
        const realReadOutput = proc.handle.readOutput.bind(proc.handle);
        spyOn(proc.handle, "readOutput").mockImplementation(async (offset: number) => {
          if (proc.monitor?.settled) {
            scanStarted();
            await scanGate;
            throw new Error("scan read failed");
          }
          return realReadOutput(offset);
        });

        await scanStartedPromise;
        manager.beginShutdown();
        releaseScan();
        await new Promise((resolve) => setTimeout(resolve, 300));

        // The pending match must not be emitted during dispose; the armed registry record
        // survives for the restart monitor-lost notice instead.
        expect(matchEvents).toHaveLength(0);
        expect(stoppedEvents).toHaveLength(0);
      });

      it("excludes already-shown final lines from the settlement tail", async () => {
        const eventPromise = waitForMonitorMatch(manager, 8_000);
        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "printf 'alpha shown\\n'; sleep 0.5; printf 'omega new\\n'",
          {
            cwd: process.cwd(),
            displayName: "settle-tail-shown-frontier",
            monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        // Owner unfiltered read consumes the first line while the process still runs, advancing
        // the shown frontier past it.
        const read = await manager.getOutput(
          result.processId,
          undefined,
          false,
          1,
          undefined,
          testWorkspaceId
        );
        expect(read.success).toBe(true);
        if (!read.success) return;
        expect(read.output).toContain("alpha shown");

        const event = await eventPromise;
        const tail = event.payload.tailLines ?? [];
        // Already-shown bytes must not be re-presented as new post-settlement output.
        expect(tail).not.toContain("alpha shown");
        // The genuinely unseen final line survives (unless the read raced past it too).
        if (!read.output.includes("omega new")) {
          expect(tail).toContain("omega new");
        }
      });

      it("keeps a bounded suffix when the final output is one oversized line", async () => {
        // No line boundary inside the final ~4 KB window: dropping the lone mid-line fragment
        // would deliver an empty tail exactly when the oversized line (long JSON diagnostics,
        // a single-line compiler failure) IS the decisive output.
        const eventPromise = waitForMonitorMatch(manager, 8_000);
        const result = await manager.spawn(
          runtime,
          testWorkspaceId,
          "head -c 6000 /dev/zero | tr '\\0' X; printf 'TAIL_END\\n'",
          {
            cwd: process.cwd(),
            displayName: "settle-tail-oversized-line",
            monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
          }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;

        const event = await eventPromise;
        const tail = event.payload.tailLines ?? [];
        // The bounded suffix survives with an explicit truncation marker instead of vanishing.
        expect(tail).toHaveLength(1);
        expect(tail[0]).toContain("[truncated]");
        expect(tail[0]).toContain("TAIL_END");
      });

      it("bounds oversized tail content and marks it mid-content (degraded size query)", () => {
        // A runtime handle's transient size-query failure degrades to 0, turning the tail read
        // into a full-file read; the post-read bound must re-cut to the final byte window and
        // report the mid-content start so the caller drops the leading partial line.
        const oversized = `${"A".repeat(8192)}\nEND\n`;
        const bounded = boundTailContent(oversized, 4096);
        expect(Buffer.byteLength(bounded.content, "utf8")).toBe(4096);
        expect(bounded.startedMidContent).toBe(true);
        // The final complete lines survive at the end of the window.
        expect(bounded.content.endsWith("\nEND\n")).toBe(true);

        // Content already within the bound passes through untouched.
        const small = "short\nEND\n";
        expect(boundTailContent(small, 4096)).toEqual({
          content: small,
          startedMidContent: false,
        });
      });

      it("still wakes when the settlement tail read fails", async () => {
        const eventPromise = waitForMonitorMatch(manager, 6_000);
        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'boom\\n'; exit 1", {
          cwd: process.cwd(),
          displayName: "settle-tail-failure",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        if (proc == null) return;
        spyOn(proc.handle, "getOutputFileSize").mockImplementation(() =>
          Promise.reject(new Error("tail read failed"))
        );

        const event = await eventPromise;
        expect(event.payload.terminal).toEqual({ status: "exited", exitCode: 1 });
        expect(event.payload.lines).toEqual([]);
      });

      it("cancellation during the claimed settlement window wins (no terminal wake, one canceled stop)", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'out\\n'", {
          cwd: process.cwd(),
          displayName: "settle-cancel-race",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        if (proc == null) return;

        // Hold the settlement helper inside its tail read so the cancel deterministically lands
        // in the claimed window.
        let releaseTail!: () => void;
        const tailGate = new Promise<void>((resolve) => {
          releaseTail = resolve;
        });
        let tailReadStarted!: () => void;
        const tailReadStartedPromise = new Promise<void>((resolve) => {
          tailReadStarted = resolve;
        });
        const realGetOutputFileSize = proc.handle.getOutputFileSize.bind(proc.handle);
        spyOn(proc.handle, "getOutputFileSize").mockImplementation(async () => {
          tailReadStarted();
          await tailGate;
          return realGetOutputFileSize();
        });

        await tailReadStartedPromise;
        // Explicit cancel (task_stop path) while the settlement helper awaits the tail read.
        await manager.terminate(result.processId, { monitorDisposition: "discard" });
        releaseTail();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(matchEvents).toHaveLength(0);
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toMatchObject({ processId: result.processId, reason: "canceled" });
      });

      it("emits no settlement wakes during shutdown", async () => {
        const matchEvents: MonitorMatchPayload[] = [];
        const stoppedEvents: MonitorStoppedPayload[] = [];
        manager.on("monitor:match", (_workspaceId, payload) => matchEvents.push(payload));
        manager.on("monitor:stopped", (_workspaceId, payload) => stoppedEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'bye\\n'; exit 1", {
          cwd: process.cwd(),
          displayName: "settle-shutdown",
          monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 },
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        manager.beginShutdown();

        let proc = await manager.getProcess(result.processId);
        for (let attempt = 0; attempt < 80; attempt++) {
          proc = await manager.getProcess(result.processId);
          if (proc?.status !== "running" && proc?.monitor?.stopped) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));

        // No terminal wake and no monitor:stopped: the registry record must survive shutdown so
        // the next startup delivers the monitor-lost notice instead.
        expect(matchEvents).toHaveLength(0);
        expect(stoppedEvents).toHaveLength(0);
      });

      it("marks terminalStatusShown on a filtered post-exit read without advancing the offset", async () => {
        const shownEvents: OutputShownPayload[] = [];
        manager.on("output:shown", (_workspaceId, payload) => shownEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'data\\n'", {
          cwd: process.cwd(),
          displayName: "terminal-shown-filtered",
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        // Wait for exit, then read with a filter that matches nothing.
        let proc = await manager.getProcess(result.processId);
        for (let attempt = 0; attempt < 80; attempt++) {
          proc = await manager.getProcess(result.processId);
          if (proc?.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const output = await manager.getOutput(result.processId, "NOMATCH", false, 1);
        expect(output.success).toBe(true);
        if (output.success) {
          expect(output.status).toBe("exited");
          expect(output.output).toBe("");
        }

        expect(shownEvents).toHaveLength(1);
        // Filtered reads never advance the shown offset, yet the terminal status was reported.
        expect(shownEvents[0].shownThroughOffset).toBe(0);
        expect(shownEvents[0].terminalStatusShown).toBe(true);
      });

      it("a cross-workspace consumer read leaves the owner's wake suppression state untouched", async () => {
        const shownEvents: OutputShownPayload[] = [];
        manager.on("output:shown", (_workspaceId, payload) => shownEvents.push(payload));

        const result = await manager.spawn(runtime, testWorkspaceId, "printf 'data\\n'", {
          cwd: process.cwd(),
          displayName: "terminal-shown-ancestor",
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        let proc = await manager.getProcess(result.processId);
        for (let attempt = 0; attempt < 80; attempt++) {
          proc = await manager.getProcess(result.processId);
          if (proc?.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // task_await lets an ancestor workspace await a descendant agent's bash task. That report
        // goes to the ancestor, not the owning agent, so it must not mark the terminal status or
        // shown frontier (either would suppress the owner's wake while its agent stays idle).
        const ancestorRead = await manager.getOutput(
          result.processId,
          undefined,
          false,
          1,
          undefined,
          "ancestor-workspace",
          "task_await"
        );
        expect(ancestorRead.success).toBe(true);
        if (ancestorRead.success) expect(ancestorRead.status).toBe("exited");
        expect(proc?.terminalStatusShownToAgent).toBe(false);
        expect(proc?.shownThroughOffset).toBe(0);
        expect(shownEvents).toHaveLength(0);

        // The owner's own read still marks the terminal status shown and emits the retraction.
        const ownerRead = await manager.getOutput(
          result.processId,
          undefined,
          false,
          1,
          undefined,
          testWorkspaceId,
          "task_await"
        );
        expect(ownerRead.success).toBe(true);
        expect(proc?.terminalStatusShownToAgent).toBe(true);
        expect(shownEvents).toHaveLength(1);
        expect(shownEvents[0].terminalStatusShown).toBe(true);
      });
    });
  });

  it("emits output:shown when an unfiltered read advances the shown frontier", async () => {
    const shownEvents: Array<{ workspaceId: string; payload: OutputShownPayload }> = [];
    manager.on("output:shown", (workspaceId, payload) => {
      shownEvents.push({ workspaceId, payload });
    });

    const result = await manager.spawn(runtime, testWorkspaceId, "printf 'line\\n'", {
      cwd: process.cwd(),
      displayName: "shown-event",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const proc = await manager.getProcess(result.processId);
    expect(proc).not.toBeNull();
    if (proc == null) return;

    const output = await manager.getOutput(result.processId, undefined, false, 1);
    expect(output.success).toBe(true);
    expect(shownEvents).toEqual([
      {
        workspaceId: testWorkspaceId,
        payload: {
          processId: result.processId,
          processStartTime: proc.startTime,
          shownThroughOffset: 5,
          // Whether the same read already reported the exit is timing-dependent (the exit
          // marker can land after the first content poll), so only the offset is exact here.
          terminalStatusShown: expect.any(Boolean) as unknown as boolean,
        },
      },
    ]);
  });

  describe("wake signal snapshots", () => {
    it("reads the delivery frontier without probing process transport", async () => {
      const processId = "non-probing-wake-frontier";
      const startTime = Date.now();
      const getExitCode = mock(() => Promise.reject(new Error("persistent transport failure")));
      const processRecord = {
        id: processId,
        workspaceId: testWorkspaceId,
        startTime,
        status: "running",
        shownThroughOffset: 0,
        terminalStatusShownToAgent: false,
        handle: { getExitCode } as unknown as BackgroundHandle,
      } as unknown as BackgroundProcess;
      const internal = manager as unknown as {
        processes: Map<string, BackgroundProcess>;
      };
      internal.processes.set(processId, processRecord);

      const state = await manager.getMonitorWakeDeliveryState(processId, startTime);

      expect(state).toMatchObject({ status: "settled", shownThroughOffset: 0 });
      expect(getExitCode).not.toHaveBeenCalled();
      internal.processes.delete(processId);
    });

    it("bounds scripts exposed through live wake snapshots", async () => {
      const script = "sleep 30\n#" + "x".repeat(10_000);
      const result = await manager.spawn(runtime, testWorkspaceId, script, {
        cwd: process.cwd(),
        displayName: "bounded-live-wake-script",
        monitor: { filter: "READY", pattern: /READY/, exclude: false, cooldownMs: 0 },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const snapshot = manager
        .pullMonitorWakeSignals(testWorkspaceId)
        .find((candidate) => candidate.processId === result.processId);

      expect(Buffer.byteLength(snapshot?.script ?? "", "utf8")).toBeLessThan(2_200);
      expect(snapshot?.script.endsWith("… [truncated]")).toBe(true);
      await manager.terminate(result.processId, { monitorDisposition: "discard" });
    });
  });

  describe("getSettledShownThroughOffset", () => {
    it("resolves to the advanced frontier only after an in-flight unfiltered read settles", async () => {
      // Delay output so the unfiltered read is observably in flight (long-polling) when we query the
      // frontier. getSettledShownThroughOffset must await that read and return the post-read offset,
      // never the stale pre-read 0 -- this is what lets the drain gate see a settled frontier.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "sleep 0.5; printf 'line\\n'; sleep 3",
        { cwd: process.cwd(), displayName: "settled-unfiltered" }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      const readPromise = manager.getOutput(result.processId, undefined, false, 2);

      // Wait until the read is in flight (tracker set); the frontier has not advanced yet.
      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 200; attempt++) {
        proc = await manager.getProcess(result.processId);
        if (proc?.monitorWakeBlockingReadSettled) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(proc?.monitorWakeBlockingReadSettled).toBeDefined();
      expect(proc?.shownThroughOffset ?? -1).toBe(0);

      const settled = await manager.getSettledShownThroughOffset(result.processId);
      const read = await readPromise;
      expect(read.success).toBe(true);
      // "line\n" is 5 bytes; the settled frontier reflects the completed read, not the stale 0.
      expect(settled).toBe(5);
    });

    it("waits for an in-flight filtered task_await before reporting the frontier", async () => {
      // A monitor wake should not interrupt task_await on the same bash process. Even though a
      // filtered await cannot advance shownThroughOffset, the delivery gate must wait for that await
      // to settle; afterward it can deliver any matched lines that the filter did not show.
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 3", {
        cwd: process.cwd(),
        displayName: "settled-filtered-task-await",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const controller = new AbortController();
      const filteredRead = manager.getOutput(
        result.processId,
        "NOMATCH",
        false,
        10,
        controller.signal,
        testWorkspaceId,
        "task_await"
      );

      let proc = await manager.getProcess(result.processId);
      for (let attempt = 0; attempt < 200; attempt++) {
        proc = await manager.getProcess(result.processId);
        if ((proc?.getOutputCallCount ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(proc?.getOutputCallCount).toBe(1);

      const settledPromise = manager.getSettledShownThroughOffset(result.processId);
      const settledBeforeAwait = await Promise.race([
        settledPromise.then(() => true),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ]);
      expect(settledBeforeAwait).toBe(false);

      controller.abort();
      expect(await filteredRead).toMatchObject({ success: true, status: "interrupted" });
      expect(await settledPromise).toBe(0);
    });

    it("does not block on an in-flight filtered read", async () => {
      // A filtered read with no matching output long-polls, holding outputLock. Filtered reads never
      // advance shownThroughOffset, so the frontier query must return immediately rather than wait
      // out the read's timeout.
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 3", {
        cwd: process.cwd(),
        displayName: "settled-filtered",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const filteredRead = manager.getOutput(result.processId, "NOMATCH", false, 2);
      const start = Date.now();
      const settled = await manager.getSettledShownThroughOffset(result.processId);
      expect(Date.now() - start).toBeLessThan(500);
      expect(settled).toBe(0);

      await manager.terminate(result.processId, { monitorDisposition: "discard" });
      await filteredRead;
    });

    it("emits matchedThroughOffset on the monitor:match payload", async () => {
      const eventPromise = waitForMonitorMatch(manager);
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'FAILED\\n'", {
        cwd: process.cwd(),
        displayName: "monitor-payload-offset",
        monitor: { filter: "FAILED", pattern: /FAILED/, exclude: false, cooldownMs: 0 },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const event = await eventPromise;
      expect(event.payload.lines[0]).toBe("FAILED");
      // End of "FAILED\n" (6 chars + newline).
      expect(event.payload.matchedThroughOffset).toBe(7);
    });

    it("returns undefined when the live process started after the wake's origin (reused ID)", async () => {
      // Process IDs are display-name-derived and reclaimed after a restart, so a pending wake for a
      // dead instance could otherwise be answered with an unrelated newer process's frontier. The
      // caller passes the wake record's createdAt: the originating instance necessarily started
      // before its first match created the record, so a live process whose startTime is *after*
      // createdAt reused the ID and the query returns undefined -- the drain then fails open.
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'x\\n'; sleep 3", {
        cwd: process.cwd(),
        displayName: "reused-id",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const proc = await manager.getProcess(result.processId);
      const liveStartTime = proc?.startTime ?? 0;
      expect(liveStartTime).toBeGreaterThan(0);

      // Origin created at/after this instance started -> the real frontier (0 here, nothing read).
      expect(await manager.getSettledShownThroughOffset(result.processId, liveStartTime)).toBe(0);
      expect(
        await manager.getSettledShownThroughOffset(result.processId, liveStartTime + 1000)
      ).toBe(0);
      // Origin predates this instance -> a reused ID from a newer process, so undefined and the
      // prior instance's wake is never wrongly superseded.
      expect(
        await manager.getSettledShownThroughOffset(result.processId, liveStartTime - 1)
      ).toBeUndefined();
      // A malformed persisted marker parses to NaN: it must degrade to the same fail-open
      // undefined rather than silently disable the generation check (startTime > NaN is false,
      // which would let an unrelated instance's frontier answer for the dead generation).
      expect(
        await manager.getSettledShownThroughOffset(result.processId, Number.NaN)
      ).toBeUndefined();
      // No origin bound -> unconditional frontier, preserving the legacy-record fail path.
      expect(await manager.getSettledShownThroughOffset(result.processId)).toBe(0);

      await manager.terminate(result.processId, { monitorDisposition: "discard" });
    });
  });

  describe("getProcess", () => {
    it("should return process by ID", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (spawnResult.success) {
        const proc = await manager.getProcess(spawnResult.processId);
        expect(proc).not.toBeNull();
        expect(proc?.id).toBe(spawnResult.processId);
        expect(proc?.status).toBe("running");
      }
    });

    it("should return null for non-existent process", async () => {
      const proc = await manager.getProcess("bg-nonexistent");
      expect(proc).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all processes", async () => {
      // Use unique display names since they're now used as process IDs
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-list-1",
      });
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-list-2",
      });

      const processes = await manager.list();
      expect(processes.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by workspace ID", async () => {
      // Use unique display names since they're now used as process IDs
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-filter-ws1",
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-filter-ws2",
      });

      const ws1Processes = await manager.list(testWorkspaceId);
      const ws2Processes = await manager.list(testWorkspaceId2);

      expect(ws1Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws1Processes.every((p) => p.workspaceId === testWorkspaceId)).toBe(true);
      expect(ws2Processes.every((p) => p.workspaceId === testWorkspaceId2)).toBe(true);
    });
  });

  describe("terminate", () => {
    it("should terminate a running process", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (spawnResult.success) {
        const terminateResult = await manager.terminate(spawnResult.processId, {
          monitorDisposition: "discard",
        });
        expect(terminateResult.success).toBe(true);

        const proc = await manager.getProcess(spawnResult.processId);
        expect(proc?.status).toMatch(/killed|exited/);
      }
    });

    it("should return error for non-existent process", async () => {
      const result = await manager.terminate("bg-nonexistent", { monitorDisposition: "discard" });
      expect(result.success).toBe(false);
    });

    it("should be idempotent (double-terminate succeeds)", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (spawnResult.success) {
        const result1 = await manager.terminate(spawnResult.processId, {
          monitorDisposition: "discard",
        });
        expect(result1.success).toBe(true);

        const result2 = await manager.terminate(spawnResult.processId, {
          monitorDisposition: "discard",
        });
        expect(result2.success).toBe(true);
      }
    });

    it("should deliver SIGTERM to the bash process (TERM trap executes)", async () => {
      const sentinelPath = path.join(bgOutputDir, `term-sentinel-${Date.now()}`);
      const displayName = `test-term-trap-${Date.now()}`;

      const spawnResult = await manager.spawn(
        runtime,
        testWorkspaceId,
        `trap "echo term > '${sentinelPath}'; exit 0" TERM; sleep 60`,
        {
          cwd: process.cwd(),
          displayName,
        }
      );

      expect(spawnResult.success).toBe(true);
      if (!spawnResult.success) return;

      const terminateResult = await manager.terminate(spawnResult.processId, {
        monitorDisposition: "discard",
      });
      expect(terminateResult.success).toBe(true);

      // Wait briefly for the trap to write the sentinel file.
      let sentinel: string | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          sentinel = await fs.readFile(sentinelPath, "utf-8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      expect(sentinel).not.toBeNull();
      expect(sentinel!).toContain("term");
    });
  });

  describe("cleanup", () => {
    it("should kill all processes for a workspace and remove from memory", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });

      await manager.cleanup(testWorkspaceId);

      const ws1Processes = await manager.list(testWorkspaceId);
      const ws2Processes = await manager.list(testWorkspaceId2);
      // All testWorkspaceId processes should be removed from memory
      expect(ws1Processes.length).toBe(0);
      // workspace-2 processes should still exist and be running
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.some((p) => p.status === "running")).toBe(true);
    });
  });

  describe("terminateAll", () => {
    it(
      "should kill all processes across all workspaces",
      async () => {
        // Spawn processes in multiple workspaces (unique display names since they're process IDs)
        await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
          cwd: process.cwd(),
          displayName: "test-termall-ws1",
        });
        await manager.spawn(runtime, testWorkspaceId2, "sleep 10", {
          cwd: process.cwd(),
          displayName: "test-termall-ws2",
        });

        // Verify both workspaces have running processes
        const beforeWs1 = await manager.list(testWorkspaceId);
        const beforeWs2 = await manager.list(testWorkspaceId2);
        expect(beforeWs1.length).toBe(1);
        expect(beforeWs2.length).toBe(1);

        // Terminate all
        await manager.terminateAll();

        // Both workspaces should have no processes
        const afterWs1 = await manager.list(testWorkspaceId);
        const afterWs2 = await manager.list(testWorkspaceId2);
        expect(afterWs1.length).toBe(0);
        expect(afterWs2.length).toBe(0);

        // Total list should also be empty
        const allProcesses = await manager.list();
        expect(allProcesses.length).toBe(0);
      },
      { timeout: 20_000 }
    );

    it("should handle empty process list gracefully", async () => {
      // No processes spawned - terminateAll should not throw
      await manager.terminateAll();
      const allProcesses = await manager.list();
      expect(allProcesses.length).toBe(0);
    });
  });

  describe("process state tracking", () => {
    it("should track process exit and update meta.json", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (result.success) {
        // Wait for process to exit
        await new Promise((resolve) => setTimeout(resolve, 200));

        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("exited");
        expect(proc?.exitCode).toBe(42);
        expect(proc?.exitTime).not.toBeNull();

        // Verify meta.json was updated
        const metaPath = path.join(result.outputDir, "meta.json");
        const metaContent = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent) as BackgroundProcessMeta;
        expect(meta.status).toBe("exited");
        expect(meta.exitCode).toBe(42);
      }
    });

    it("should keep output files after process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test; exit 0", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (result.success) {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("exited");

        // Verify output file still contains output
        const outputPath = path.join(result.outputDir, "output.log");
        const output = await fs.readFile(outputPath, "utf-8");
        expect(output).toContain("test");
      }
    });

    it("should preserve killed status after terminate", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (result.success) {
        // Terminate it
        await manager.terminate(result.processId, { monitorDisposition: "discard" });

        // Status should be "killed", not "exited"
        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("killed");
      }
    });

    it("should report non-zero exit code for signal-terminated processes", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
        displayName: "test",
      });

      if (result.success) {
        // Terminate it (sends SIGTERM, then SIGKILL after 2s)
        await manager.terminate(result.processId, { monitorDisposition: "discard" });

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        // Exit code should be 128 + signal number (SIGTERM=15 → 143, SIGKILL=9 → 137)
        // Either is acceptable depending on timing
        expect(proc!.exitCode).toBeGreaterThanOrEqual(128);
      }
    });
  });

  describe("process group termination", () => {
    it("should terminate child processes when parent is killed", async () => {
      // This test validates that set -m creates a process group where PID === PGID,
      // allowing kill -PID to terminate the entire process tree.

      // Spawn a parent that creates a child process
      // The parent runs: (sleep 60 &); wait
      // This creates: parent bash -> child sleep
      const result = await manager.spawn(runtime, testWorkspaceId, "bash -c 'sleep 60 & wait'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Give the child process time to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify process is running
      const procBefore = await manager.getProcess(result.processId);
      expect(procBefore?.status).toBe("running");

      // Terminate - this should kill both parent and child via process group
      await manager.terminate(result.processId, { monitorDisposition: "discard" });

      // Verify parent is killed
      const procAfter = await manager.getProcess(result.processId);
      expect(procAfter?.status).toBe("killed");

      // Wait a moment for any orphaned processes to show up
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify no orphaned sleep processes from our test
      // (checking via ps would be flaky, so we rely on the exit code being set,
      // which only happens after the entire process group is dead)
      const exitCode = procAfter?.exitCode;
      expect(exitCode).not.toBeNull();
      expect(exitCode).toBeGreaterThanOrEqual(128); // Signal exit code
    });
  });

  describe("getOutput", () => {
    it("should return stdout from a running process", async () => {
      // Spawn a process that writes output in two phases.
      // Use a file-gated barrier rather than timing sleeps to avoid CI flakiness.
      const triggerFile = path.join(bgOutputDir, `trigger-${Date.now()}`);

      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        `echo 'line 1'; while [ ! -f ${triggerFile} ]; do sleep 0.05; done; echo 'line 2'`,
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Get output - wait up to 1s for the first line
      const output1 = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(output1.success).toBe(true);
      if (!output1.success) return;

      expect(output1.output).toContain("line 1");
      expect(output1.output).not.toContain("line 2");

      // Unblock the process so it can emit the second line
      await fs.writeFile(triggerFile, "go", "utf-8");

      // Get output again - wait up to 1s for incremental output (line 2)
      const output2 = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(output2.success).toBe(true);
      if (!output2.success) return;

      // Second call should only return new content (line 2)
      expect(output2.output).toContain("line 2");
      // And should NOT contain line 1 again (incremental reads)
      expect(output2.output).not.toContain("line 1");
    });

    it("preserves buffered output when a read is interrupted before a newline arrives", async () => {
      // Regression: aborting a pending getOutput (e.g. task_await returning early once
      // min_completed is satisfied) must not drop bytes already consumed from the log. We append
      // to the log directly so the scenario is deterministic and not dependent on stdio flushing.
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
        displayName: "test",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const outputPath = path.join(result.outputDir, "output.log");
      // A line fragment with no trailing newline yields no "meaningful" (complete) line, so the
      // read falls through to the interrupt check after consuming (and advancing past) the bytes.
      await fs.appendFile(outputPath, "partial", "utf-8");

      const controller = new AbortController();
      controller.abort();
      const interrupted = await manager.getOutput(
        result.processId,
        undefined,
        undefined,
        2,
        controller.signal
      );
      expect(interrupted.success).toBe(true);
      if (!interrupted.success) return;
      expect(interrupted.status).toBe("interrupted");

      // Complete the line; the next read must include the previously-consumed fragment.
      await fs.appendFile(outputPath, "done\n", "utf-8");
      const resumed = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(resumed.success).toBe(true);
      if (!resumed.success) return;
      expect(resumed.output).toContain("partialdone");
    });

    it("should return stderr from a running process", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'error message' >&2", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("error message");
    });

    it("should include elapsed_ms in response", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 0.2; echo done", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait with timeout to ensure blocking
      const output = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // elapsed_ms should be present and reflect the wait time
      expect(typeof output.elapsed_ms).toBe("number");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("should return error for non-existent process", async () => {
      const output = await manager.getOutput("bash_nonexistent");
      expect(output.success).toBe(false);
      if (output.success) return;
      expect(output.error).toContain("not found");
    });

    it("should return correct status for running vs exited process", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo done; exit 0", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Immediately should be running
      const output1 = await manager.getOutput(result.processId);
      expect(output1.success).toBe(true);
      if (!output1.success) return;
      // Status could be running or already exited depending on timing

      // Wait for exit
      await new Promise((resolve) => setTimeout(resolve, 200));

      const output2 = await manager.getOutput(result.processId);
      expect(output2.success).toBe(true);
      if (!output2.success) return;
      expect(output2.status).toBe("exited");
      expect(output2.exitCode).toBe(0);
    });

    it("should filter output with regex when provided", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'INFO: message'; echo 'DEBUG: noise'; echo 'INFO: another'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Filter for INFO lines only
      const output = await manager.getOutput(result.processId, "INFO");
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("INFO: message");
      expect(output.output).toContain("INFO: another");
      expect(output.output).not.toContain("DEBUG");
    });

    it("should exclude matching lines when filter_exclude is true", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'INFO: message'; echo 'DEBUG: noise'; echo 'INFO: another'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Exclude DEBUG lines (invert filter)
      const output = await manager.getOutput(result.processId, "DEBUG", true);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("INFO: message");
      expect(output.output).toContain("INFO: another");
      expect(output.output).not.toContain("DEBUG");
    });

    it("should return error when filter_exclude is true but no filter provided", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // filter_exclude without filter should error
      const output = await manager.getOutput(result.processId, undefined, true);
      expect(output.success).toBe(false);
      if (output.success) return;
      expect(output.error).toContain("filter_exclude requires filter");
    });

    it("should keep waiting when only excluded lines arrive", async () => {
      const signalPath = path.join(bgOutputDir, `signal-${Date.now()}`);

      // Spawn a process that spams excluded output until we create a signal file.
      // This avoids flakiness from the spawn itself taking long enough that "DONE"
      // is already present by the time we call getOutput.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        `while [ ! -f "${signalPath}" ]; do echo 'PROGRESS'; sleep 0.1; done; echo 'DONE'`,
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 5 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const outputPromise = manager.getOutput(result.processId, "PROGRESS", true, 2);

      // Ensure getOutput is waiting before we allow the process to produce
      // meaningful output.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(signalPath, "go");

      const output = await outputPromise;
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should only see DONE, not PROGRESS lines
      expect(output.output).toContain("DONE");
      expect(output.output).not.toContain("PROGRESS");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(250);
    });

    it("should return when process exits even if only excluded lines", async () => {
      // Script outputs ONLY excluded lines then exits
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'PROGRESS'; echo 'PROGRESS'; exit 0",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should return (not hang) even though all output is excluded
      const output = await manager.getOutput(result.processId, "PROGRESS", true, 2);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Output should be empty (all lines excluded), but we should have status
      expect(output.output.trim()).toBe("");
      expect(output.status).toBe("exited");
    });

    it("should timeout and return even if only excluded lines arrived", async () => {
      // Script outputs progress indefinitely
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'PROGRESS'; sleep 0.1; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 10 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Short timeout - should return with empty output, not hang
      const output = await manager.getOutput(result.processId, "PROGRESS", true, 0.3);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should have returned due to timeout, output empty (all excluded)
      expect(output.output.trim()).toBe("");
      expect(output.status).toBe("running");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(250);
      expect(output.elapsed_ms).toBeLessThan(1000); // Didn't hang
    });

    it("should serialize concurrent getOutput calls to prevent duplicate output", async () => {
      // This test verifies the fix for the race condition where parallel bash_output
      // calls could both read from the same offset before either updates the position.
      // Without serialization, both calls would return the same output.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'line1'; echo 'line2'; echo 'line3'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for all output to be written
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Call getOutput twice in parallel - without serialization, both would
      // read from offset 0 and return duplicate "line1\nline2\nline3"
      const [output1, output2] = await Promise.all([
        manager.getOutput(result.processId),
        manager.getOutput(result.processId),
      ]);

      expect(output1.success).toBe(true);
      expect(output2.success).toBe(true);
      if (!output1.success || !output2.success) return;

      // Combine outputs - should contain all lines exactly once
      const combinedOutput = output1.output + output2.output;
      const line1Count = (combinedOutput.match(/line1/g) ?? []).length;
      const line2Count = (combinedOutput.match(/line2/g) ?? []).length;
      const line3Count = (combinedOutput.match(/line3/g) ?? []).length;

      // Each line should appear exactly once across both outputs (no duplicates)
      expect(line1Count).toBe(1);
      expect(line2Count).toBe(1);
      expect(line3Count).toBe(1);

      // One call should get the content, the other should get empty (already read)
      const hasContent = output1.output.trim().length > 0 || output2.output.trim().length > 0;
      expect(hasContent).toBe(true);
    });
  });

  describe("peekOutput", () => {
    it("should not advance the output cursor used by getOutput", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello; sleep 0.2", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for output to be written
      await new Promise((resolve) => setTimeout(resolve, 100));

      const peek = await manager.peekOutput(result.processId, { fromOffset: 0 });
      expect(peek.success).toBe(true);
      if (!peek.success) return;
      expect(peek.output).toContain("hello");

      // peekOutput should not affect getOutput's cursor
      const output = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("hello");
    });
  });

  describe("integration: spawn and getOutput", () => {
    it("should retrieve output after spawn using same manager instance", async () => {
      // This test verifies the core workflow: spawn -> getOutput
      // Both must use the SAME manager instance

      // Spawn process that produces output
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'hello from bg'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for output using the SAME manager (avoid sleep-based flakiness)
      const output = await manager.getOutput(result.processId, undefined, undefined, 2);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("hello from bg");
    });

    it("should read from offset 0 on first call even if file already has content", async () => {
      // Spawn a process that writes output immediately
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'initial output'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait longer to ensure output is definitely written
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the file has content
      const outputPath = path.join(result.outputDir, "output.log");
      const fileContent = await fs.readFile(outputPath, "utf-8");
      expect(fileContent).toContain("initial output");

      // Now call getOutput - first call should read from offset 0
      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should have the output even though some time has passed
      expect(output.output).toContain("initial output");
    });

    it("DEBUG: verifies outputDir from spawn matches getProcess", async () => {
      // Verify that outputDir returned from spawn is the same as what getProcess returns
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'verify test'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const proc = await manager.getProcess(result.processId);
      expect(proc).not.toBeNull();

      // CRITICAL: outputDir from spawn MUST match outputDir from getProcess
      expect(proc!.outputDir).toBe(result.outputDir);

      // Wait for output to be written
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify file exists at the expected path
      const outputPath = path.join(result.outputDir, "output.log");
      const content = await fs.readFile(outputPath, "utf-8");
      expect(content).toContain("verify test");

      // Now getOutput should return the content
      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (output.success) {
        expect(output.output).toContain("verify test");
      }
    });

    it("should work when spawned via bash tool and read via bash_output tool", async () => {
      // This simulates the exact flow in the real system:
      // 1. bash tool with run_in_background=true spawns process
      // 2. bash_output tool reads output

      const tempDir = new TestTempDir("test-bg-integration");

      // Create shared config with the SAME manager instance
      const config = createTestToolConfig(tempDir.path, {
        workspaceId: testWorkspaceId,
        sessionsDir: tempDir.path,
      });
      config.backgroundProcessManager = manager;
      config.runtime = runtime;

      // Create bash tool and spawn background process
      const bashTool = createBashTool(config);
      const spawnResult = (await bashTool.execute!(
        { script: "echo 'hello from integration test'", run_in_background: true },
        { toolCallId: "test", messages: [], context: undefined }
      )) as BashToolResult;

      expect(spawnResult).toBeDefined();
      expect(spawnResult.success).toBe(true);
      expect("backgroundProcessId" in spawnResult).toBe(true);

      // Type narrowing for background process result
      if (!("backgroundProcessId" in spawnResult)) {
        throw new Error("Expected background process result");
      }
      const processId: string = spawnResult.backgroundProcessId;

      // Wait for output
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create bash_output tool and read output
      const outputTool = createBashOutputTool(config);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const rawOutputResult = await outputTool.execute!(
        { process_id: processId },
        { toolCallId: "test2", messages: [], context: undefined }
      );

      const outputResult = rawOutputResult as BashOutputToolResult;

      expect(outputResult).toBeDefined();

      // This is the key assertion - should succeed AND have content
      expect(outputResult.success).toBe(true);
      if (outputResult.success) {
        expect(outputResult.output).toContain("hello from integration test");
      } else {
        throw new Error(`bash_output failed: ${outputResult.error}`);
      }

      tempDir[Symbol.dispose]();
    });

    it("should fail to get output if using different manager instance", async () => {
      // This test documents what happens if manager instances differ
      // (which would be a bug in the real system)

      // Spawn with first manager
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'test'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Create a DIFFERENT manager instance
      const otherManager = new BackgroundProcessManager(bgOutputDir);

      // Trying to get output from different manager should fail
      // because the process isn't in its internal map
      const output = await otherManager.getOutput(result.processId);
      expect(output.success).toBe(false);
      if (!output.success) {
        expect(output.error).toContain("Process not found");
      }
    });
  });

  describe("exit_code file", () => {
    it("should write exit_code file when process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit and exit_code to be written
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check exit_code file exists and contains correct value
      const exitCodePath = path.join(result.outputDir, "exit_code");
      const exitCodeContent = await fs.readFile(exitCodePath, "utf-8");
      expect(exitCodeContent.trim()).toBe("42");
    });
  });

  describe("hasOrphanedRunningBackgroundProcesses", () => {
    // Unique per run: the probe scans the real durable spawn layout (/tmp/mux-bashes/<ws>),
    // which is shared machine-wide, so collisions with other runs must be impossible.
    const orphanWorkspaceId = `orphan-ws-${testRunId}-${process.pid}`;
    const workspaceDir = localBgWorkspaceDir(orphanWorkspaceId);

    afterEach(async () => {
      await manager.cleanup(orphanWorkspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    async function writeSpawnRecord(
      processName: string,
      meta: { pid: number; status: string } | string,
      options?: { exitCode?: string }
    ): Promise<void> {
      const processDir = path.join(workspaceDir, processName);
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(
        path.join(processDir, "meta.json"),
        typeof meta === "string" ? meta : JSON.stringify(meta)
      );
      if (options?.exitCode != null) {
        await fs.writeFile(path.join(processDir, "exit_code"), options.exitCode);
      }
    }

    it("returns false when the workspace has no spawn records", async () => {
      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("detects an untracked running record with a live PID", async () => {
      // This test process itself is the "surviving child": alive and unknown to the manager,
      // exactly what an unclean app restart leaves behind.
      await writeSpawnRecord("survivor", { pid: process.pid, status: "running" });

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(true);
    });

    it("trusts the exit trap over the stale running status", async () => {
      // A crash freezes meta.json at "running", but the wrapper's exit trap still writes
      // exit_code when the process later exits — that must clear the gate even if the PID
      // was recycled by another live process.
      await writeSpawnRecord(
        "exited-after-crash",
        { pid: process.pid, status: "running" },
        {
          exitCode: "0",
        }
      );

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("ignores running records whose PID is dead", async () => {
      // SIGKILL (or a reboot) skips the exit trap: no exit_code file, but the PID is gone.
      const dead = spawnSync("true");
      expect(dead.pid).toBeGreaterThan(1);
      await writeSpawnRecord("killed-by-crash", { pid: dead.pid, status: "running" });

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("ignores non-running and marker-settled records", async () => {
      await writeSpawnRecord("clean-exit", { pid: process.pid, status: "exited" });
      // A migrated process (pid 0) whose in-process handle wrote the exit marker is settled.
      await writeSpawnRecord("migrated-exited", { pid: 0, status: "running" }, { exitCode: "0" });

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("probes remote spawn records through the runtime before a Coder stop", async () => {
      // The remote-like runtime executes the probe locally against the same /tmp layout the
      // records were written to, so PID semantics match the probe's namespace.
      const remote = createRemoteLikeRuntime(new LocalRuntime(process.cwd()));

      // No records at all: clear.
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(false)
      );

      // A markerless, meta-less directory (preserved ambiguous/transport-failure spawn)
      // cannot prove its process exited: unsettled.
      await fs.mkdir(path.join(workspaceDir, "ambiguous"), { recursive: true });
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(true)
      );
      await fs.rm(path.join(workspaceDir, "ambiguous"), { recursive: true, force: true });

      // Running record with a live PID (this test process): unsettled.
      await writeSpawnRecord("remote-survivor", { pid: process.pid, status: "running" });
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(true)
      );

      // The exit trap settles it even though the stale status still says running.
      await fs.writeFile(path.join(workspaceDir, "remote-survivor", "exit_code"), "0");
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(false)
      );
      await fs.rm(path.join(workspaceDir, "remote-survivor"), { recursive: true, force: true });

      // Running record whose PID is dead (SIGKILL/reboot skipped the trap): settled.
      const dead = spawnSync("true");
      expect(dead.pid).toBeGreaterThan(1);
      await writeSpawnRecord("remote-killed", { pid: dead.pid, status: "running" });
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(false)
      );

      // Display names may legally start with "." (only "." and ".." are rejected), hiding the
      // record dir from a bare "*/" glob — a live dot-named job must still report unsettled.
      await writeSpawnRecord(".hidden-survivor", { pid: process.pid, status: "running" });
      expect(await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId)).toEqual(
        Ok(true)
      );
      await fs.rm(path.join(workspaceDir, ".hidden-survivor"), { recursive: true, force: true });

      // A root that exists but is not a directory (torn/replaced state) proves nothing about
      // records beneath the expected layout: probe error, never CLEAR.
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.writeFile(workspaceDir, "not a directory");
      const nonDirProbe = await manager.hasUnsettledRemoteSpawnRecords(remote, orphanWorkspaceId);
      expect(nonDirProbe.success).toBe(false);
      await fs.rm(workspaceDir, { force: true });
      await fs.mkdir(workspaceDir, { recursive: true });

      // An unreadable/unsearchable root would leave the shell glob unmatched and read as
      // CLEAR while records may sit beneath it — must fail the probe closed instead.
      // kill/access semantics differ for uid 0 (root reads anything), so skip there.
      if (process.getuid?.() !== 0) {
        await writeSpawnRecord("hidden-by-perms", { pid: process.pid, status: "running" });
        await fs.chmod(workspaceDir, 0o000);
        try {
          const unreadableProbe = await manager.hasUnsettledRemoteSpawnRecords(
            remote,
            orphanWorkspaceId
          );
          expect(unreadableProbe.success).toBe(false);
        } finally {
          await fs.chmod(workspaceDir, 0o755);
        }
      }
    });

    it("treats running records under extra record dirs as live without host PID probes", async () => {
      // Devcontainer records (passed via extraRecordDirs) carry container-namespace PIDs: a
      // host ESRCH proves nothing about the container process, so a running record without
      // an exit marker must fail closed instead of trusting the host PID probe.
      const extraRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bg-extra-root-"));
      try {
        const dead = spawnSync("true");
        expect(dead.pid).toBeGreaterThan(1);
        const processDir = path.join(extraRoot, "container-survivor");
        await fs.mkdir(processDir, { recursive: true });
        await fs.writeFile(
          path.join(processDir, "meta.json"),
          JSON.stringify({ pid: dead.pid, status: "running" })
        );

        // Host layout is empty, and the same record under the HOST root would read as dead.
        expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
        expect(
          await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId, {
            extraRecordDirs: [extraRoot],
          })
        ).toBe(true);

        // The exit trap still settles extra-root records.
        await fs.writeFile(path.join(processDir, "exit_code"), "0");
        expect(
          await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId, {
            extraRecordDirs: [extraRoot],
          })
        ).toBe(false);
      } finally {
        await fs.rm(extraRoot, { recursive: true, force: true });
      }
    });

    it("fails closed on untracked migrated records without an exit marker", async () => {
      // Migrated processes record pid 0 (unprobeable) and their exit marker is written by
      // the in-process handle: after an unclean shutdown the child may survive with nothing
      // left to prove it exited, so the gate must refuse rather than skip.
      await writeSpawnRecord("migrated-survivor", { pid: 0, status: "running" });

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(true);
    });

    it("skips migrated records the manager still tracks", async () => {
      await writeSpawnRecord("migrated-live", { pid: 0, status: "running" });
      // While Xum runs, the migrated process is tracked in-memory under the same ID (the
      // record's directory name); the in-memory live-activity gates own it, so the probe
      // must not double-report it as a crash orphan.
      const stubHandle: BackgroundHandle = {
        outputDir: path.join(workspaceDir, "migrated-live"),
        getExitCode: () => Promise.resolve(null),
        terminate: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
        writeMeta: () => Promise.resolve(),
        getOutputFileSize: () => Promise.resolve(0),
        readOutput: () => Promise.resolve({ content: "", newOffset: 0 }),
      };
      manager.registerMigratedProcess(
        stubHandle,
        "migrated-live",
        orphanWorkspaceId,
        "echo hi",
        path.join(workspaceDir, "migrated-live"),
        "migrated-live"
      );

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("fails closed on unreadable records without an exit marker", async () => {
      // A crash mid-write can truncate meta.json while the detached process survives; an
      // unreadable record cannot prove the process exited, so only the exit marker clears it.
      await writeSpawnRecord("torn-write", '{"pid": 12');

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(true);

      await fs.writeFile(path.join(workspaceDir, "torn-write", "exit_code"), "137");
      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("aborts the spawn (and self-heals the record) when meta.json cannot be persisted", async () => {
      // Fail exactly the meta.json heredoc write; every other exec (spawn, terminate)
      // proceeds normally. Proxy keeps original-receiver calls so runtime internals work.
      const proxyHandler: ProxyHandler<Runtime> = {
        get(target, prop, receiver) {
          if (prop === "exec") {
            const failingExec: Runtime["exec"] = (command, options) => {
              if (command.includes("METAEOF")) {
                throw new Error("injected meta write failure");
              }
              return target.exec(command, options);
            };
            return failingExec;
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return (value as (...args: unknown[]) => unknown).bind(target);
          }
          return value;
        },
      };
      const failingRuntime = new Proxy(runtime, proxyHandler);

      const result = await manager.spawn(failingRuntime, orphanWorkspaceId, "sleep 5", {
        cwd: process.cwd(),
        displayName: "unrecordable",
      });

      // Without a durable spawn record the crash-orphan gate could never see this process
      // after a restart, so the spawn must fail closed instead of running unrecorded.
      expect(result.success).toBe(false);
      expect(await manager.getProcess("unrecordable")).toBeNull();
      // The abort terminated the process, which wrote the exit marker — so the markerless
      // unreadable-record probe reads the leftover directory as exited, not as an orphan.
      const exitMarker = await fs.readFile(
        path.join(workspaceDir, "unrecordable", "exit_code"),
        "utf-8"
      );
      expect(exitMarker.length).toBeGreaterThan(0);
      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("fails closed when the spawn-record directory is unreadable", async () => {
      // chmod-based EACCES cannot be provoked when running as root (e.g. some CI containers).
      if (process.getuid?.() === 0) return;
      await writeSpawnRecord("settled", { pid: process.pid, status: "exited" });
      await fs.chmod(workspaceDir, 0o000);
      try {
        // Records exist but cannot be read: absence of a surviving process is unprovable, so
        // the gate must refuse rather than let a snapshot archive proceed blind.
        expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(true);
      } finally {
        await fs.chmod(workspaceDir, 0o755);
      }
      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });

    it("allocates distinct directories for concurrent same-name spawns", async () => {
      // Both spawns pass the in-memory allocator before either registers; the synchronous
      // reservation must still keep their directories (and meta.json/exit_code) disjoint,
      // or the first exit would settle the shared record under the other process.
      const [a, b] = await Promise.all([
        manager.spawn(runtime, orphanWorkspaceId, "sleep 2", {
          cwd: process.cwd(),
          displayName: "dup",
        }),
        manager.spawn(runtime, orphanWorkspaceId, "sleep 2", {
          cwd: process.cwd(),
          displayName: "dup",
        }),
      ]);
      expect(a.success).toBe(true);
      expect(b.success).toBe(true);
      if (!a.success || !b.success) return;
      expect(a.processId).not.toBe(b.processId);
      expect(a.outputDir).not.toBe(b.outputDir);
    });

    it("does not reuse a surviving orphan's directory for a same-name spawn", async () => {
      await writeSpawnRecord("survivor", { pid: process.pid, status: "running" });

      const result = await manager.spawn(runtime, orphanWorkspaceId, "sleep 5", {
        cwd: process.cwd(),
        displayName: "survivor",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // The in-memory allocator resets across restarts, so the disk pass must skip the
      // survivor's directory: sharing it would hand both processes one exit_code/meta.json
      // and settle the survivor's record once the new process exits.
      expect(result.processId).toBe("survivor (2)");
      const survivorMeta = parseSpawnRecordMeta(
        await fs.readFile(path.join(workspaceDir, "survivor", "meta.json"), "utf-8")
      );
      expect(survivorMeta?.pid).toBe(process.pid);
      // The survivor still trips the crash-orphan gate even while the new process runs.
      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(true);
    });

    it("clears a stale exit_code file when a restart reuses the process directory", async () => {
      // Process IDs are display-name based and deduplicated only in memory, so after a
      // restart a new spawn can land in a prior session's directory whose exit trap already
      // wrote exit_code. That stale marker must not survive the new spawn: it would flip the
      // live process to "exited" and let crash-orphan gating treat it as exited too.
      const displayName = "reused-name";
      const processDir = path.join(workspaceDir, displayName);
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(path.join(processDir, "exit_code"), "0");

      const result = await manager.spawn(runtime, orphanWorkspaceId, "sleep 2", {
        cwd: process.cwd(),
        displayName,
      });
      expect(result.success).toBe(true);

      let staleMarkerExists = true;
      try {
        await fs.access(path.join(processDir, "exit_code"));
      } catch {
        staleMarkerExists = false;
      }
      expect(staleMarkerExists).toBe(false);
      const processes = await manager.list(orphanWorkspaceId);
      expect(processes.find((p) => p.id === displayName)?.status).toBe("running");
    });

    it("skips processes the manager still tracks", async () => {
      // A live tracked process writes the same durable "running" record an orphan would,
      // but in-memory gates already cover it — the probe must not double-report it.
      const result = await manager.spawn(runtime, orphanWorkspaceId, "sleep 5", {
        cwd: process.cwd(),
        displayName: "tracked",
      });
      expect(result.success).toBe(true);

      expect(await manager.hasOrphanedRunningBackgroundProcesses(orphanWorkspaceId)).toBe(false);
    });
  });

  describe("line-buffered filtering", () => {
    it("should only filter complete lines, not fragments", async () => {
      // Process that outputs lines that should be filtered and one that shouldn't
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        // Output lines: some with 'progress', one without
        "echo 'progress 1'; echo 'progress 2'; echo 'FINAL RESULT'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Filter out lines containing 'progress', should only get 'FINAL RESULT'
      const output = await manager.getOutput(result.processId, "progress", true, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("FINAL RESULT");
      expect(output.output).not.toContain("progress");
    });

    it("should buffer incomplete lines across calls", async () => {
      // Process that outputs progress lines
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'progress: 50%'; sleep 0.1; echo 'progress: 100%'; echo 'DONE'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Filter out progress lines, should only get 'DONE'
      const output = await manager.getOutput(result.processId, "progress", true, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("DONE");
      expect(output.output).not.toContain("progress");
    });

    it("should include incomplete line on process exit", async () => {
      // Process that exits without final newline
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'no newline at end'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = await manager.getOutput(result.processId, undefined, undefined, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("no newline at end");
      expect(output.status).not.toBe("running");
    });
  });

  describe("polling detection", () => {
    it("should return note after 3+ calls without filter_exclude on running process", async () => {
      // Long-running process
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'tick'; sleep 0.5; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 30 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // First two calls should not have a note
      const output1 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output1.success).toBe(true);
      if (!output1.success) return;
      expect(output1.note).toBeUndefined();

      const output2 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output2.success).toBe(true);
      if (!output2.success) return;
      expect(output2.note).toBeUndefined();

      // Third call should have the suggestion note
      const output3 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output3.success).toBe(true);
      if (!output3.success) return;
      expect(output3.note).toContain("filter_exclude");
      expect(output3.note).toContain("3+ times");
    });

    it("should return better pattern note when filter_exclude is used but still polling", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'tick'; sleep 0.5; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 30 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Make 3+ calls with filter_exclude - should get "better pattern" note
      let lastNote: string | undefined;
      for (let i = 0; i < 4; i++) {
        const output = await manager.getOutput(result.processId, "nomatch", true, 0.1);
        expect(output.success).toBe(true);
        if (!output.success) return;
        lastNote = output.note;
      }
      // Should get the "better pattern" note since we're using filter_exclude but still polling
      expect(lastNote).toContain("filter_exclude but still polling");
      expect(lastNote).toContain("broader pattern");
    });

    it("should NOT return note when process has exited", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo done; exit 0", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Make 3+ calls on exited process
      for (let i = 0; i < 4; i++) {
        const output = await manager.getOutput(result.processId, undefined, undefined, 0.1);
        expect(output.success).toBe(true);
        if (!output.success) return;
        // Should not get note since process is not running
        expect(output.note).toBeUndefined();
      }
    });
  });
});
