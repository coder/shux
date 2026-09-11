import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Config } from "@/node/config";
import { InitStateManager } from "./initStateManager";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { WorkspaceInitEvent } from "@/common/orpc/types";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

describe("InitStateManager", () => {
  let tempDir: string;
  let config: Config;
  let manager: InitStateManager;

  beforeEach(async () => {
    // Create temp directory as mux root
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-state-test-"));

    // Create sessions directory
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Config constructor takes rootDir directly
    config = new Config(tempDir);
    manager = new InitStateManager(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("should track init hook lifecycle (start → output → end)", async () => {
      const workspaceId = "test-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      // Subscribe to events
      manager.on("init-start", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-output", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      // Start init
      manager.startInit(workspaceId, "/path/to/hook");
      expect(manager.getInitState(workspaceId)).toBeTruthy();
      expect(manager.getInitState(workspaceId)?.status).toBe("running");

      // Append output
      manager.appendOutput(workspaceId, "Installing deps...", false);
      manager.appendOutput(workspaceId, "Done!", false);
      expect(manager.getInitState(workspaceId)?.lines).toEqual([
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "Installing deps...", isError: false, timestamp: expect.any(Number) },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "Done!", isError: false, timestamp: expect.any(Number) },
      ]);

      // End init (await to ensure event fires)
      await manager.endInit(workspaceId, 0);
      expect(manager.getInitState(workspaceId)?.status).toBe("success");
      expect(manager.getInitState(workspaceId)?.exitCode).toBe(0);

      // Verify events
      expect(events).toHaveLength(4); // start + 2 outputs + end
      expect(events[0].type).toBe("init-start");
      expect(events[1].type).toBe("init-output");
      expect(events[2].type).toBe("init-output");
      expect(events[3].type).toBe("init-end");
    });

    it("should track stderr lines with isError flag", () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      manager.appendOutput(workspaceId, "stdout line", false);
      manager.appendOutput(workspaceId, "stderr line", true);

      const state = manager.getInitState(workspaceId);
      expect(state?.lines).toEqual([
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "stdout line", isError: false, timestamp: expect.any(Number) },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "stderr line", isError: true, timestamp: expect.any(Number) },
      ]);
    });

    it("should set status to error on non-zero exit code", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      await manager.endInit(workspaceId, 1);

      const state = manager.getInitState(workspaceId);
      expect(state?.status).toBe("error");
      expect(state?.exitCode).toBe(1);
    });
  });

  describe("persistence", () => {
    it("should persist state to disk on endInit", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      manager.appendOutput(workspaceId, "Line 1", false);
      manager.appendOutput(workspaceId, "Line 2", true);
      await manager.endInit(workspaceId, 0);

      // Read from disk
      const diskState = await manager.readInitStatus(workspaceId);
      expect(diskState).toBeTruthy();
      expect(diskState?.status).toBe("success");
      expect(diskState?.exitCode).toBe(0);
      expect(diskState?.lines).toEqual([
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "Line 1", isError: false, timestamp: expect.any(Number) },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { line: "Line 2", isError: true, timestamp: expect.any(Number) },
      ]);
    });

    it("should replay from in-memory state when available", async () => {
      const workspaceId = "test-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      manager.on("init-start", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-output", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      // Create state
      manager.startInit(workspaceId, "/path/to/hook");
      manager.appendOutput(workspaceId, "Line 1", false);
      await manager.endInit(workspaceId, 0);

      events.length = 0; // Clear events

      // Replay from in-memory
      await manager.replayInit(workspaceId);

      expect(events).toHaveLength(3); // start + output + end
      expect(events[0].type).toBe("init-start");
      expect(events[1].type).toBe("init-output");
      expect(events[2].type).toBe("init-end");
    });

    it("should replay from disk when not in memory", async () => {
      const workspaceId = "test-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      // Create and persist state
      manager.startInit(workspaceId, "/path/to/hook");
      manager.appendOutput(workspaceId, "Line 1", false);
      manager.appendOutput(workspaceId, "Error line", true);
      await manager.endInit(workspaceId, 1);

      // Clear in-memory state (simulate process restart)
      manager.clearInMemoryState(workspaceId);
      expect(manager.getInitState(workspaceId)).toBeUndefined();

      // Subscribe to events
      manager.on("init-start", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-output", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      // Replay from disk
      await manager.replayInit(workspaceId);

      expect(events).toHaveLength(4); // start + 2 outputs + end
      expect(events[0].type).toBe("init-start");
      expect(events[1].type).toBe("init-output");
      expect((events[1] as { line: string }).line).toBe("Line 1");
      expect(events[2].type).toBe("init-output");
      expect((events[2] as { line: string }).line).toBe("Error line");
      expect((events[2] as { isError?: boolean }).isError).toBe(true);
      expect(events[3].type).toBe("init-end");
      expect((events[3] as { exitCode: number }).exitCode).toBe(1);
    });

    it("should not replay if no state exists", async () => {
      const workspaceId = "nonexistent-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      manager.on("init-start", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-output", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      await manager.replayInit(workspaceId);

      expect(events).toHaveLength(0);
    });
  });

  describe("creation progress", () => {
    it("preserves step markers live, on disk, and on replay without marking raw output", async () => {
      const workspaceId = "test-workspace";
      const outputs: Array<Extract<WorkspaceInitEvent, { type: "init-output" }>> = [];
      manager.on("init-output", (event: Extract<WorkspaceInitEvent, { type: "init-output" }>) =>
        outputs.push(event)
      );

      manager.startInit(workspaceId, "/path/to/hook");
      manager.appendOutput(workspaceId, "Preparing checkout", false, true);
      manager.appendOutput(workspaceId, "raw output", false);
      manager.appendOutput(workspaceId, "raw error", true, false);

      expect(outputs.map((event) => event.step)).toEqual([true, undefined, undefined]);
      expect(outputs.map((event) => event.lineNumber)).toEqual([0, 1, 2]);
      const lines = structuredClone(manager.getInitState(workspaceId)?.lines);
      expect(lines?.map((line) => line.step)).toEqual([true, undefined, undefined]);
      await manager.endInit(workspaceId, 0);
      expect((await manager.readInitStatus(workspaceId))?.lines).toEqual(lines);

      const liveOutputs = [...outputs];
      for (const fromDisk of [false, true]) {
        if (fromDisk) manager.clearInMemoryState(workspaceId);
        outputs.length = 0;
        await manager.replayInit(workspaceId);
        expect(outputs).toEqual(liveOutputs.map((event) => ({ ...event, replay: true })));
      }
    });

    it("emits progress without changing durable output, persistence, or replay", async () => {
      const workspaceId = "test-workspace";
      const progress: WorkspaceInitEvent[] = [];
      manager.on("init-progress", (event: WorkspaceInitEvent) => progress.push(event));
      manager.startInit(workspaceId, "/path/to/hook");
      manager.appendOutput(workspaceId, "Preparing checkout", false, true);
      const initialState = structuredClone(manager.getInitState(workspaceId));

      const before = Date.now();
      manager.reportProgress(workspaceId, "Checking out files", 40);
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        type: "init-progress",
        workspaceId,
        label: "Checking out files",
        percent: 40,
      });
      expect(progress[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(progress[0].timestamp).toBeLessThanOrEqual(Date.now());
      expect(manager.getInitState(workspaceId)).toEqual(initialState);
      expect(await manager.readInitStatus(workspaceId)).toBeNull();
      progress.length = 0;
      await manager.replayInit(workspaceId);
      expect(progress).toEqual([]);

      await manager.endInit(workspaceId, 0);
      expect(await manager.readInitStatus(workspaceId)).toEqual(
        manager.getInitState(workspaceId) ?? null
      );
      expect((await manager.readInitStatus(workspaceId))?.lines).toEqual(initialState?.lines);
      manager.clearInMemoryState(workspaceId);
      await manager.replayInit(workspaceId);
      expect(progress).toEqual([]);
    });

    it("ignores progress for missing, cleared, successful, and failed init runs", async () => {
      const progress: WorkspaceInitEvent[] = [];
      manager.on("init-progress", (event: WorkspaceInitEvent) => progress.push(event));
      manager.reportProgress("missing", "Checking out files", 10);
      manager.startInit("cleared", "/path/to/hook");
      manager.clearInMemoryState("cleared");
      manager.reportProgress("cleared", "Checking out files", 20);
      for (const exitCode of [0, 1]) {
        const workspaceId = "completed-" + exitCode;
        manager.startInit(workspaceId, "/path/to/hook");
        await manager.endInit(workspaceId, exitCode);
        manager.reportProgress(workspaceId, "Checking out files", 30);
      }
      expect(progress).toEqual([]);
    });

    it("forwards live progress only to the matching agent session and unsubscribes on disposal", async () => {
      const workspaceId = "test-workspace";
      const harness = await createAgentSessionHarness({
        workspaceId,
        initStateManager: manager,
        captureEvents: true,
      });
      try {
        manager.startInit(workspaceId, "/path/to/hook");
        manager.startInit("other-workspace", "/path/to/hook");
        manager.reportProgress("other-workspace", "Checking out files", 10);
        manager.reportProgress(workspaceId, "Checking out files", 20);
        const progress = harness.events.filter((event) => event.type === "init-progress");
        expect(progress).toHaveLength(1);
        expect(progress[0]).toMatchObject({ label: "Checking out files", percent: 20 });
        expect(progress[0]).not.toHaveProperty("workspaceId");
        await harness.session.dispose();
        expect(manager.listenerCount("init-progress")).toBe(0);
      } finally {
        await harness.session.dispose();
        await harness.cleanup();
      }
    });

    it("bounds and rounds percentages while ignoring non-finite input", () => {
      const workspaceId = "test-workspace";
      const progress: Array<Extract<WorkspaceInitEvent, { type: "init-progress" }>> = [];
      manager.on("init-progress", (event: Extract<WorkspaceInitEvent, { type: "init-progress" }>) =>
        progress.push(event)
      );
      manager.startInit(workspaceId, "/path/to/hook");
      for (const percent of [-1, 0, 39.8, 100, 101, NaN, Infinity, -Infinity]) {
        manager.reportProgress(workspaceId, "Checking out files", percent);
      }
      expect(progress.map((event) => event.percent)).toEqual([0, 0, 40, 100, 100]);
    });
  });

  describe("cleanup", () => {
    it("should delete persisted state from disk", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      await manager.endInit(workspaceId, 0);

      // Verify state exists
      const stateBeforeDelete = await manager.readInitStatus(workspaceId);
      expect(stateBeforeDelete).toBeTruthy();

      // Delete
      await manager.deleteInitStatus(workspaceId);

      // Verify deleted
      const stateAfterDelete = await manager.readInitStatus(workspaceId);
      expect(stateAfterDelete).toBeNull();
    });

    it("should clear in-memory state", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      expect(manager.getInitState(workspaceId)).toBeTruthy();

      // Get the init promise before clearing
      const initPromise = manager.waitForInit(workspaceId);

      // Clear in-memory state (rejects internal promise, but waitForInit catches it)
      manager.clearInMemoryState(workspaceId);

      // Verify state is cleared
      expect(manager.getInitState(workspaceId)).toBeUndefined();

      // waitForInit never throws - it resolves even when init is canceled
      // This allows tools to proceed and fail naturally with their own errors
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(initPromise).resolves.toBeUndefined();
    });

    it("should not recreate session directory if queued persistence runs after state is cleared", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(sessionDir, { recursive: true });

      let releaseLock: (() => void) | undefined;
      const lockHeld = workspaceFileLocks.withLock(workspaceId, async () => {
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });

      // Let the lock callback run so releaseLock is set.
      await Promise.resolve();
      if (!releaseLock) {
        throw new Error("Expected workspace file lock to be held");
      }

      // Queue endInit persistence behind the workspace file lock.
      const endInitPromise = manager.endInit(workspaceId, 0);

      // Simulate workspace removal: clear in-memory init state and delete the session directory.
      manager.clearInMemoryState(workspaceId);
      await fs.rm(sessionDir, { recursive: true, force: true });

      // Allow queued persistence to proceed.
      releaseLock();
      await lockHeld;
      await endInitPromise;

      expect(await manager.readInitStatus(workspaceId)).toBeNull();

      const sessionDirExists = await fs
        .access(sessionDir)
        .then(() => true)
        .catch(() => false);
      expect(sessionDirExists).toBe(false);
    });
  });

  describe("error handling", () => {
    it("should handle appendOutput with no active state", () => {
      const workspaceId = "nonexistent-workspace";
      // Should not throw
      manager.appendOutput(workspaceId, "Line", false);
    });

    it("should handle endInit with no active state", async () => {
      const workspaceId = "nonexistent-workspace";
      // Should not throw
      await manager.endInit(workspaceId, 0);
    });

    it("should handle deleteInitStatus for nonexistent file", async () => {
      const workspaceId = "nonexistent-workspace";
      // Should not throw
      await manager.deleteInitStatus(workspaceId);
    });
  });

  describe("truncation", () => {
    it("should truncate lines when exceeding INIT_HOOK_MAX_LINES", () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      // Add more lines than the limit
      const totalLines = INIT_HOOK_MAX_LINES + 100;
      for (let i = 0; i < totalLines; i++) {
        manager.appendOutput(workspaceId, `Line ${i}`, false);
      }

      const state = manager.getInitState(workspaceId);
      expect(state?.lines.length).toBe(INIT_HOOK_MAX_LINES);
      expect(state?.truncatedLines).toBe(100);

      // Should have the most recent lines (tail)
      const lastLine = state?.lines[INIT_HOOK_MAX_LINES - 1];
      expect(lastLine?.line).toBe(`Line ${totalLines - 1}`);

      // First line should be from when truncation started
      const firstLine = state?.lines[0];
      expect(firstLine?.line).toBe(`Line 100`);
    });

    it("should include truncatedLines in init-end event", async () => {
      const workspaceId = "test-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      manager.startInit(workspaceId, "/path/to/hook");

      // Add more lines than the limit
      for (let i = 0; i < INIT_HOOK_MAX_LINES + 50; i++) {
        manager.appendOutput(workspaceId, `Line ${i}`, false);
      }

      await manager.endInit(workspaceId, 0);

      expect(events).toHaveLength(1);
      expect((events[0] as { truncatedLines?: number }).truncatedLines).toBe(50);
    });

    it("should persist truncatedLines to disk", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      // Add more lines than the limit
      for (let i = 0; i < INIT_HOOK_MAX_LINES + 25; i++) {
        manager.appendOutput(workspaceId, `Line ${i}`, false);
      }

      await manager.endInit(workspaceId, 0);

      const diskState = await manager.readInitStatus(workspaceId);
      expect(diskState?.truncatedLines).toBe(25);
      expect(diskState?.lines.length).toBe(INIT_HOOK_MAX_LINES);
    });

    it("should not set truncatedLines when under limit", () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      // Add fewer lines than the limit
      for (let i = 0; i < 10; i++) {
        manager.appendOutput(workspaceId, `Line ${i}`, false);
      }

      const state = manager.getInitState(workspaceId);
      expect(state?.lines.length).toBe(10);
      expect(state?.truncatedLines).toBeUndefined();
    });

    it("should truncate old persisted data on replay (backwards compat)", async () => {
      const workspaceId = "test-workspace";
      const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];

      // Manually write a large init-status.json to simulate old data
      const sessionsDir = path.join(tempDir, "sessions", workspaceId);
      await fs.mkdir(sessionsDir, { recursive: true });

      const oldLineCount = INIT_HOOK_MAX_LINES + 200;
      const oldStatus = {
        status: "success",
        hookPath: "/path/to/hook",
        startTime: Date.now() - 1000,
        lines: Array.from({ length: oldLineCount }, (_, i) => ({
          line: `Old line ${i}`,
          isError: false,
          timestamp: Date.now() - 1000 + i,
        })),
        exitCode: 0,
        endTime: Date.now(),
        // No truncatedLines field - old format
      };
      await fs.writeFile(path.join(sessionsDir, "init-status.json"), JSON.stringify(oldStatus));

      // Subscribe to events
      manager.on("init-output", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );
      manager.on("init-end", (event: WorkspaceInitEvent & { workspaceId: string }) =>
        events.push(event)
      );

      // Replay from disk
      await manager.replayInit(workspaceId);

      // Should only emit MAX_LINES output events (truncated)
      const outputEvents = events.filter((e) => e.type === "init-output");
      expect(outputEvents.length).toBe(INIT_HOOK_MAX_LINES);

      // init-end should include truncatedLines count
      const endEvent = events.find((e) => e.type === "init-end");
      expect((endEvent as { truncatedLines?: number }).truncatedLines).toBe(200);

      // First replayed line should be from the tail (old line 200)
      expect((outputEvents[0] as { line: string }).line).toBe("Old line 200");
    });
  });

  describe("waitForInit hook phase", () => {
    it("should not time out during runtime setup (intentional)", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      const waitPromise = manager.waitForInit(workspaceId);
      const result = await Promise.race([
        waitPromise.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 150)),
      ]);

      expect(result).toBe("pending");

      await manager.endInit(workspaceId, 0);
      await waitPromise;
    });

    it("should start timeout once hook phase begins", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      manager.enterHookPhase(workspaceId);

      const state = manager.getInitState(workspaceId);
      if (!state) {
        throw new Error("Expected init state to exist");
      }
      state.hookStartTime = Date.now() - 5 * 60 * 1000 - 1000;

      const waitPromise = manager.waitForInit(workspaceId);
      const result = await Promise.race([
        waitPromise.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 150)),
      ]);

      expect(result).toBe("done");

      await manager.endInit(workspaceId, 0);
      await waitPromise;
    });

    it("should set hookStartTime when entering hook phase", () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");

      manager.enterHookPhase(workspaceId);

      const state = manager.getInitState(workspaceId);
      if (!state) {
        throw new Error("Expected init state to exist");
      }

      expect(state.phase).toBe("init_hook");
      expect(state.hookStartTime).toBeDefined();
      expect(typeof state.hookStartTime).toBe("number");
    });
  });

  describe("waitForInit with abortSignal", () => {
    it("should return immediately if abortSignal is already aborted", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      const controller = new AbortController();
      controller.abort();

      const start = Date.now();
      await manager.waitForInit(workspaceId, controller.signal);
      expect(Date.now() - start).toBeLessThan(200); // Should be instant
    });

    it("should return when abortSignal fires during wait", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      const controller = new AbortController();

      const waitPromise = manager.waitForInit(workspaceId, controller.signal);
      setTimeout(() => controller.abort(), 20);

      const start = Date.now();
      await waitPromise;
      expect(Date.now() - start).toBeLessThan(300); // Should return quickly after abort
    });

    it("should clean up timeout when init completes first", async () => {
      const workspaceId = "test-workspace";
      manager.startInit(workspaceId, "/path/to/hook");
      const waitPromise = manager.waitForInit(workspaceId);

      await manager.endInit(workspaceId, 0);
      await waitPromise;
      // No spurious timeout error should be logged (verify via log spy if needed)
    });
  });
});
