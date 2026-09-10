import * as fs from "fs";
import * as path from "path";

import { describe, it, expect } from "bun:test";
import { createBashOutputTool } from "./bash_output";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { BashOutputToolResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolExecutionOptions } from "ai";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

// Create test runtime
function createTestRuntime(): Runtime {
  return new LocalRuntime(process.cwd());
}

describe("bash_output tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error when workspaceId not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;
    delete config.workspaceId;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Workspace ID not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return incremental output from process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs incrementally
    const spawnResult = await manager.spawn(
      runtime,
      "test-workspace",
      "echo 'line1'; sleep 0.5; echo 'line2'",
      { cwd: process.cwd(), displayName: "test" }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Wait a bit for first output
    await new Promise((r) => setTimeout(r, 200));

    // First call - should get some output
    const result1 = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.output).toContain("line1");
    }

    // Wait for more output
    await new Promise((r) => setTimeout(r, 600));

    // Second call - should ONLY get new output (incremental)
    const result2 = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result2.success).toBe(true);
    if (result2.success) {
      // Should contain line2 but NOT line1 (already read)
      expect(result2.output).toContain("line2");
      expect(result2.output).not.toContain("line1");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should filter output with regex", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs multiple lines
    const spawnResult = await manager.spawn(
      runtime,
      "test-workspace",
      "echo 'ERROR: something failed'; echo 'INFO: everything ok'; echo 'ERROR: another error'",
      { cwd: process.cwd(), displayName: "test" }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "ERROR", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Should only contain ERROR lines
      expect(result.output).toContain("ERROR");
      expect(result.output).not.toContain("INFO");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return error for invalid regex filter", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const spawnResult = await manager.spawn(runtime, "test-workspace", "echo 'test'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((r) => setTimeout(r, 100));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "[invalid(", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid filter regex");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should not return output from other workspace's processes", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();

    const config = createTestToolConfig(process.cwd(), {
      workspaceId: "workspace-a",
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in different workspace
    const spawnResult = await manager.spawn(runtime, "workspace-b", "echo 'test'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    // Cleanup
    await manager.cleanup("workspace-b");
    tempDir[Symbol.dispose]();
  });

  it("should include process status and exit code", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that exits quickly
    const spawnResult = await manager.spawn(runtime, "test-workspace", "echo 'done'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 200));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(0);
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should block and wait for output when timeout_secs > 0", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Use unique process ID to avoid leftover state from previous runs
    const processId = `delayed-output-${Date.now()}`;
    const signalPath = path.join(tempDir.path, `${processId}.signal`);

    // Spawn a process that blocks until we create a signal file, then outputs.
    // This avoids flakiness from the spawn call itself taking a non-trivial amount of time.
    const spawnResult = await manager.spawn(
      runtime,
      "test-workspace",
      `while [ ! -f "${signalPath}" ]; do sleep 0.1; done; echo 'delayed output'`,
      { cwd: process.cwd(), displayName: processId }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with timeout=3 should wait and return output (waiting for signal file)
    const start = Date.now();
    const resultPromise = tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 3 },
      mockToolCallOptions
    ) as Promise<BashOutputToolResult>;

    // Ensure bash_output is actually waiting before we trigger output.
    await new Promise((r) => setTimeout(r, 300));
    await fs.promises.writeFile(signalPath, "go");

    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("delayed output");
      expect(elapsed).toBeGreaterThan(250);
      expect(elapsed).toBeLessThan(3500);
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return early when process exits during wait", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Use unique process ID to avoid leftover state from previous runs
    const processId = `quick-exit-${Date.now()}`;

    // Spawn a process that exits quickly
    const spawnResult = await manager.spawn(runtime, "test-workspace", "echo 'quick exit'", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 200));

    const tool = createBashOutputTool(config);

    // Call with long timeout - should return quickly since process already exited
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 10 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("quick exit");
      expect(result.status).toBe("exited");
      expect(elapsed).toBeLessThan(500); // Should return quickly, not wait full 10s
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should wait full timeout duration when no output and process running", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `long-sleep-${Date.now()}`;

    // Spawn a process that sleeps for a long time with no output
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 30", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with short timeout - should wait full duration then return empty
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 1 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe(""); // No output
      expect(result.status).toBe("running"); // Process still running
      // Should have waited close to 1 second
      expect(elapsed).toBeGreaterThan(900);
      expect(elapsed).toBeLessThan(1500);
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return immediately with timeout_secs: 0 even when no output", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `no-wait-${Date.now()}`;

    // Spawn a process that sleeps (no immediate output)
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 30", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with timeout=0 - should return immediately
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("");
      expect(result.status).toBe("running");
      expect(elapsed).toBeLessThan(200); // Should return almost immediately
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return early with 'interrupted' status when abortSignal is triggered", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `abort-test-${Date.now()}`;

    // Spawn a long-running process with no output
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 60", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);
    const abortController = new AbortController();

    // Abort after 200ms
    setTimeout(() => abortController.abort(), 200);

    // Call with long timeout - should be interrupted by abort signal
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 30 },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("interrupted");
      expect(result.output).toBe("(waiting interrupted)");
      // Should have returned quickly after abort, not waiting full 30s
      expect(elapsed).toBeLessThan(1000);
      expect(elapsed).toBeGreaterThan(150); // At least waited until abort
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return early with 'interrupted' status when message is queued", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `queued-msg-test-${Date.now()}`;

    // Spawn a long-running process with no output
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 60", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Queue a message after 200ms
    setTimeout(() => manager.setMessageQueued("test-workspace", true), 200);

    // Call with long timeout - should be interrupted by queued message
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 30 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("interrupted");
      expect(result.output).toBe("(waiting interrupted)");
      // Should have returned quickly after queued message, not waiting full 30s
      expect(elapsed).toBeLessThan(1000);
      expect(elapsed).toBeGreaterThan(150); // At least waited until message was queued
    }

    // Cleanup
    manager.setMessageQueued("test-workspace", false);
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });
});
