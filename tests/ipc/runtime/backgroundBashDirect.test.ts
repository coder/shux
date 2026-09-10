/**
 * Direct integration tests for background bash process manager.
 *
 * These tests bypass the LLM and call tools directly to verify the service
 * wiring is correct. This catches bugs that unit tests miss because unit
 * tests create fresh manager instances, while production shares a single
 * instance through ServiceContainer.
 *
 * Key difference from unit tests:
 * - Unit tests: Create fresh BackgroundProcessManager per test
 * - These tests: Use ServiceContainer's shared BackgroundProcessManager
 *
 * Key difference from backgroundBash.test.ts:
 * - backgroundBash.test.ts: Goes through LLM (slow, flaky, indirect)
 * - These tests: Direct tool execution (fast, deterministic, precise)
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  trustProject,
} from "../helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import { LocalRuntime } from "../../../src/node/runtime/LocalRuntime";
import { BackgroundProcessManager } from "../../../src/node/services/backgroundProcessManager";
import { createBashTool } from "../../../src/node/services/tools/bash";
import { createBashOutputTool } from "../../../src/node/services/tools/bash_output";

// Access private fields from ServiceContainer for direct testing
interface ServiceContainerPrivates {
  backgroundProcessManager: BackgroundProcessManager;
}

function getBackgroundProcessManager(env: TestEnvironment): BackgroundProcessManager {
  return (env.services as unknown as ServiceContainerPrivates).backgroundProcessManager;
}

// Foreground bash startup can be slower on Windows CI (Git Bash init + IO flush).
const FOREGROUND_OUTPUT_READY_TIMEOUT_MS = process.platform === "win32" ? 10_000 : 5_000;

interface BashOutputCollector {
  readonly chunks: string[];
  emitChatEvent: (event: { type: string; toolCallId?: string; text?: string }) => void;
}

function createBashOutputCollector(toolCallId: string): BashOutputCollector {
  const chunks: string[] = [];
  return {
    chunks,
    emitChatEvent: (event) => {
      if (event.type === "bash-output" && event.toolCallId === toolCallId && event.text) {
        // Foreground migration tests must wait for real stdout readiness rather than
        // assuming Git Bash has flushed within a fixed CI-dependent delay.
        chunks.push(event.text);
      }
    },
  };
}

async function waitForBashOutput(
  chunks: readonly string[],
  expectedText: string,
  timeoutMs: number
): Promise<void> {
  if (expectedText.length === 0) {
    throw new Error("waitForBashOutput requires non-empty expected text");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chunks.some((chunk) => chunk.includes(expectedText))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for bash output: ${expectedText}`);
}

interface ToolExecuteResult {
  success: boolean;
  backgroundProcessId?: string;
  status?: string;
  error?: string;
  exitCode?: number;
  output?: string;
}

describe("Background Bash Direct Integration", () => {
  let env: TestEnvironment;
  let tempGitRepo: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    tempGitRepo = await createTempGitRepo();

    const branchName = generateBranchName("bg-direct-test");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    await trustProject(env, tempGitRepo);
    const result = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName,
      trunkBranch,
    });

    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }
    workspaceId = result.metadata.id;
    workspacePath = result.metadata.namedWorkspacePath ?? tempGitRepo;
  });

  afterAll(async () => {
    if (workspaceId) {
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
    }
    await cleanupTempGitRepo(tempGitRepo);
    await cleanupTestEnvironment(env);
  });

  it("should retrieve output after tools are recreated (multi-message flow)", async () => {
    // Simulates production flow where tool instances are recreated between messages
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `MULTI_MSG_${Date.now()}`;

    const toolConfig = {
      cwd: workspacePath,
      runtime,
      secrets: {},
      xumEnv: {},
      runtimeTempDir: os.tmpdir(),
      backgroundProcessManager: manager,
      workspaceId,
    };

    // Message 1: Spawn background process
    const bash1 = createBashTool(toolConfig);
    const spawnResult = (await bash1.execute!(
      {
        script: `echo "${marker}"`,
        run_in_background: true,
        display_name: `spawn_${Date.now()}`,
        timeout_secs: 30,
      },
      { toolCallId: "spawn", messages: [], context: undefined }
    )) as ToolExecuteResult;

    expect(spawnResult.success).toBe(true);
    const processId = spawnResult.backgroundProcessId!;

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Message 2: Read with NEW tool instances (same manager)
    const bashOutput2 = createBashOutputTool(toolConfig);
    const outputResult = (await bashOutput2.execute!(
      { process_id: processId, timeout_secs: 0 },
      { toolCallId: "read", messages: [], context: undefined }
    )) as ToolExecuteResult;

    expect(outputResult.success).toBe(true);
    expect(outputResult.output).toContain(marker);
  });

  it("should read output files via handle (works for SSH runtime)", async () => {
    // Verifies that getOutput uses handle.readOutput() which works for both
    // local and SSH runtimes, not direct local fs access
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const testId = `handleread_${Date.now()}`;
    const marker = `HANDLE_READ_${testId}`;

    const spawnResult = await manager.spawn(runtime, workspaceId, `echo "${marker}"`, {
      cwd: workspacePath,
      displayName: testId,
    });
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 200));

    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      expect(output.output).toContain(marker);
    }
  });

  it("should support incremental reads", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const testId = `incrread_${Date.now()}`;
    const marker1 = `INCR_1_${testId}`;
    const marker2 = `INCR_2_${testId}`;
    const triggerFileName = `trigger-${testId}`;
    const triggerFilePath = path.join(workspacePath, triggerFileName);

    const spawnResult = await manager.spawn(
      runtime,
      workspaceId,
      `echo "${marker1}"; while [ ! -f "${triggerFileName}" ]; do sleep 0.05; done; echo "${marker2}"`,
      { cwd: workspacePath, displayName: testId }
    );
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    try {
      // First read: block until we see output (marker1)
      const output1 = await manager.getOutput(spawnResult.processId, undefined, undefined, 5);
      expect(output1.success).toBe(true);
      if (output1.success) {
        expect(output1.output).toContain(marker1);
        expect(output1.output).not.toContain(marker2);
      }

      // Second read: should be empty because marker2 is still blocked on the trigger file.
      const output2 = await manager.getOutput(spawnResult.processId);
      expect(output2.success).toBe(true);
      if (output2.success) {
        expect(output2.output).toBe("");
      }

      // Unblock the process so it can emit marker2.
      await fs.writeFile(triggerFilePath, "go", "utf-8");

      // Third read: block until marker2 arrives.
      const output3 = await manager.getOutput(spawnResult.processId, undefined, undefined, 10);
      expect(output3.success).toBe(true);
      if (output3.success) {
        expect(output3.output).toContain(marker2);
        expect(output3.output).not.toContain(marker1);
      }
    } finally {
      await fs.rm(triggerFilePath, { force: true }).catch(() => {});
    }
  });

  it("should isolate processes by workspace", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    // Create second workspace
    const branchName2 = generateBranchName("bg-direct-test-2");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    const result2 = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName: branchName2,
      trunkBranch,
    });
    expect(result2.success).toBe(true);
    if (!result2.success) return;
    const workspaceId2 = result2.metadata.id;

    try {
      // Spawn in each workspace
      const spawn1 = await manager.spawn(runtime, workspaceId, "echo ws1", {
        cwd: workspacePath,
        displayName: "test-1",
      });
      const spawn2 = await manager.spawn(runtime, workspaceId2, "echo ws2", {
        cwd: workspacePath,
        displayName: "test-2",
      });

      expect(spawn1.success).toBe(true);
      expect(spawn2.success).toBe(true);
      if (!spawn1.success || !spawn2.success) return;

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Cleanup workspace 2
      await manager.cleanup(workspaceId2);

      // Process 1 still accessible
      const output1 = await manager.getOutput(spawn1.processId);
      expect(output1.success).toBe(true);

      // Process 2 cleaned up
      const output2 = await manager.getOutput(spawn2.processId);
      expect(output2.success).toBe(false);
    } finally {
      await env.orpc.workspace.remove({ workspaceId: workspaceId2 }).catch(() => {});
    }
  });
});

describe("Background Bash Output Capture", () => {
  let env: TestEnvironment;
  let tempGitRepo: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    tempGitRepo = await createTempGitRepo();

    const branchName = generateBranchName("bg-output-test");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    await trustProject(env, tempGitRepo);
    const result = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName,
      trunkBranch,
    });

    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }
    workspaceId = result.metadata.id;
    workspacePath = result.metadata.namedWorkspacePath ?? tempGitRepo;
  });

  afterAll(async () => {
    if (workspaceId) {
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
    }
    await cleanupTempGitRepo(tempGitRepo);
    await cleanupTestEnvironment(env);
  });

  it("should capture stderr output when process exits with error", async () => {
    // Verifies that stderr is included in unified output
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    // Script that writes to stderr and exits with error
    const testId = `stderrerr_${Date.now()}`;
    const marker = `ERROR_${testId}`;
    const spawnResult = await manager.spawn(runtime, workspaceId, `echo "${marker}" >&2; exit 1`, {
      cwd: workspacePath,
      displayName: testId,
    });
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 300));

    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      expect(output.exitCode).toBe(1);
      expect(output.output).toContain(marker);
    }
  });

  it("should capture output when script fails mid-execution", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    const testId = `failmid_${Date.now()}`;
    const marker1 = `BEFORE_${testId}`;
    const marker2 = `ERROR_${testId}`;
    // Script that outputs to stdout, then stderr, then continues
    const spawnResult = await manager.spawn(
      runtime,
      workspaceId,
      `echo "${marker1}"; echo "${marker2}" >&2; false; echo "NEVER_SEEN"`,
      { cwd: workspacePath, displayName: testId }
    );
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 300));

    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      // Both stdout and stderr should be in unified output
      expect(output.output).toContain(marker1);
      expect(output.output).toContain(marker2);
    }
  });

  it("should handle long-running script that outputs to both streams", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    const testId = `longrun_${Date.now()}`;
    const outMarker = `OUT_${testId}`;
    const errMarker = `ERR_${testId}`;
    const spawnResult = await manager.spawn(
      runtime,
      workspaceId,
      `for i in 1 2 3; do echo "${outMarker}_$i"; echo "${errMarker}_$i" >&2; done`,
      { cwd: workspacePath, displayName: testId }
    );
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 500));

    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      // Unified output should contain both stdout and stderr
      expect(output.output).toContain(`${outMarker}_1`);
      expect(output.output).toContain(`${outMarker}_3`);
      expect(output.output).toContain(`${errMarker}_1`);
      expect(output.output).toContain(`${errMarker}_3`);
    }
  });
});

describe("Foreground to Background Migration", () => {
  let env: TestEnvironment;
  let tempGitRepo: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    tempGitRepo = await createTempGitRepo();

    const branchName = generateBranchName("fg-to-bg-test");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    await trustProject(env, tempGitRepo);
    const result = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName,
      trunkBranch,
    });

    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }
    workspaceId = result.metadata.id;
    workspacePath = result.metadata.namedWorkspacePath ?? tempGitRepo;
  });

  afterAll(async () => {
    if (workspaceId) {
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
    }
    await cleanupTempGitRepo(tempGitRepo);
    await cleanupTestEnvironment(env);
  });

  it("should migrate foreground bash to background and continue running", async () => {
    // This test verifies the complete foreground→background migration flow:
    // 1. Start a foreground bash (run_in_background=false)
    // 2. While it's running, call sendToBackground
    // 3. The bash tool returns with backgroundProcessId
    // 4. Process continues running and output is accessible via bash_output

    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const testId = `fg_to_bg_${Date.now()}`;
    const marker1 = `BEFORE_BG_${testId}`;
    const marker2 = `AFTER_BG_${testId}`;
    const toolCallId = `tool_${testId}`;
    const outputCollector = createBashOutputCollector(toolCallId);

    const toolConfig = {
      cwd: workspacePath,
      runtime,
      secrets: {},
      xumEnv: {},
      runtimeTempDir: os.tmpdir(),
      backgroundProcessManager: manager,
      workspaceId,
      emitChatEvent: outputCollector.emitChatEvent,
    };

    // Create tools for "message 1"
    const bash1 = createBashTool(toolConfig);

    // Start foreground bash that runs for ~3 seconds
    // Script: output marker1, sleep, output marker2
    const bashPromise = bash1.execute!(
      {
        script: `echo "${marker1}"; sleep 2; echo "${marker2}"`,
        run_in_background: false,
        display_name: testId,
        timeout_secs: 30,
      },
      { toolCallId, messages: [], context: undefined }
    ) as Promise<ToolExecuteResult>;

    // Wait for foreground process to register and output first marker
    await waitForBashOutput(outputCollector.chunks, marker1, FOREGROUND_OUTPUT_READY_TIMEOUT_MS);

    // Verify foreground process is registered
    const fgToolCallIds = manager.getForegroundToolCallIds(workspaceId);
    expect(fgToolCallIds.includes(toolCallId)).toBe(true);

    // Send to background while running
    const bgResult = manager.sendToBackground(toolCallId);
    expect(bgResult.success).toBe(true);

    // Wait for bash tool to return (should return immediately after backgrounding)
    const result = await bashPromise;

    // Verify result indicates backgrounding (not completion)
    expect(result.success).toBe(true);
    expect(result.backgroundProcessId).toBe(testId);
    // Output so far should contain marker1
    expect(result.output).toContain(marker1);
    // Should NOT yet contain marker2 (still running)
    expect(result.output).not.toContain(marker2);

    // Foreground registration should be removed
    const fgToolCallIds2 = manager.getForegroundToolCallIds(workspaceId);
    expect(fgToolCallIds2.includes(toolCallId)).toBe(false);

    // Process should now be in background list
    const bgProcs = await manager.list(workspaceId);
    const migratedProc = bgProcs.find((p) => p.id === testId);
    expect(migratedProc).toBeDefined();
    expect(migratedProc?.status).toBe("running");

    // === Simulate new message (stream ends, new stream begins) ===
    // Create NEW tool instances (same manager reference, fresh tools)
    const bashOutput2 = createBashOutputTool(toolConfig);

    // Wait for process to complete (marker2 should appear)
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Get output via bash_output tool (new tool instance)
    const outputResult = (await bashOutput2.execute!(
      { process_id: testId, timeout_secs: 0 },
      { toolCallId: "output_read", messages: [], context: undefined }
    )) as ToolExecuteResult;

    expect(outputResult.success).toBe(true);
    // Should now contain marker2 (process continued after migration)
    expect(outputResult.output).toContain(marker2);
    // Status should be exited (process completed)
    expect(outputResult.status).toBe("exited");
    expect(outputResult.exitCode).toBe(0);
  });

  it("should preserve output across stream boundaries", async () => {
    // Verifies that output written during foreground phase is preserved
    // after migration and accessible in subsequent messages

    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const testId = `preserve_output_${Date.now()}`;
    const marker1 = `EARLY_${testId}`;
    const marker2 = `LATE_${testId}`;
    const toolCallId = `tool_${testId}`;
    const outputCollector = createBashOutputCollector(toolCallId);

    const toolConfig = {
      cwd: workspacePath,
      runtime,
      secrets: {},
      xumEnv: {},
      runtimeTempDir: os.tmpdir(),
      backgroundProcessManager: manager,
      workspaceId,
      emitChatEvent: outputCollector.emitChatEvent,
    };

    const bash1 = createBashTool(toolConfig);

    // Script outputs marker1, sleeps, then outputs marker2
    const script = `echo "${marker1}"; sleep 2; echo "${marker2}"`;

    const bashPromise = bash1.execute!(
      {
        script,
        run_in_background: false,
        display_name: testId,
        timeout_secs: 30,
      },
      { toolCallId, messages: [], context: undefined }
    ) as Promise<ToolExecuteResult>;

    // Wait for marker1 to output
    await waitForBashOutput(outputCollector.chunks, marker1, FOREGROUND_OUTPUT_READY_TIMEOUT_MS);

    // Send to background mid-execution
    manager.sendToBackground(toolCallId);

    const result = await bashPromise;
    expect(result.success).toBe(true);
    expect(result.backgroundProcessId).toBe(testId);
    // marker1 should be in the output already
    expect(result.output).toContain(marker1);

    // Wait for process to complete
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Get the full output by reading from the file directly
    const proc = await manager.getProcess(testId);
    expect(proc).toBeDefined();

    const outputPath = path.join(proc!.outputDir, "output.log");
    const fullOutput = await fs.readFile(outputPath, "utf-8");

    // Both markers should be present in the full file
    expect(fullOutput).toContain(marker1);
    expect(fullOutput).toContain(marker2);
  });

  it("should handle migration when process exits during send", async () => {
    // Edge case: process exits right as we try to background it
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    const toolConfig = {
      cwd: workspacePath,
      runtime,
      secrets: {},
      xumEnv: {},
      runtimeTempDir: os.tmpdir(),
      backgroundProcessManager: manager,
      workspaceId,
    };

    const testId = `fast_exit_${Date.now()}`;
    const marker = `QUICK_${testId}`;

    const bash = createBashTool(toolConfig);

    const toolCallId = `tool_${testId}`;

    // Very fast script
    const bashPromise = bash.execute!(
      {
        script: `echo "${marker}"`,
        run_in_background: false,
        display_name: testId,
        timeout_secs: 30,
      },
      { toolCallId, messages: [], context: undefined }
    ) as Promise<ToolExecuteResult>;

    // Small delay then try to background (might already be done)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // This might fail if process already completed - that's fine
    manager.sendToBackground(toolCallId);

    const result = await bashPromise;

    // Either it completed normally in the foreground, or it backgrounded before
    // the foreground result captured any output. In that fast-exit race, fall
    // back to the persisted output.log via manager.getOutput(), which is the
    // authoritative source of process output across runtimes.
    expect(result.success).toBe(true);

    if (result.output?.includes(marker)) {
      expect(result.output).toContain(marker);
      if (!result.backgroundProcessId) {
        expect(result.exitCode).toBe(0);
      }
      return;
    }

    expect(result.backgroundProcessId).toBe(testId);

    // Windows can briefly report the backgrounded process as still running even
    // after the initial output is readable. Poll for terminal state instead of
    // assuming the first status snapshot is already exited.
    let processStatus = (await manager.getProcess(testId))?.status;
    const exitDeadline = Date.now() + 5000;
    while (processStatus === "running" && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      processStatus = (await manager.getProcess(testId))?.status;
    }

    expect(processStatus).toBe("exited");

    const persistedOutput = await manager.getOutput(testId, undefined, undefined, 1);
    expect(persistedOutput.success).toBe(true);
    if (persistedOutput.success) {
      expect(persistedOutput.status).toBe("exited");
      expect(persistedOutput.exitCode).toBe(0);
      expect(persistedOutput.output).toContain(marker);
    }
  });

  it("should not kill backgrounded process when abort signal fires", async () => {
    // Regression test: Previously, when a foreground process was migrated to
    // background and then the original stream was aborted (e.g., user sends
    // new message), the abort signal would kill the process with exit code -997.

    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const testId = `abort_after_bg_${Date.now()}`;
    const marker1 = `BEFORE_${testId}`;
    const marker2 = `AFTER_${testId}`;
    const toolCallId = `tool_${testId}`;
    const outputCollector = createBashOutputCollector(toolCallId);

    const toolConfig = {
      cwd: workspacePath,
      runtime,
      secrets: {},
      xumEnv: {},
      runtimeTempDir: os.tmpdir(),
      backgroundProcessManager: manager,
      workspaceId,
      emitChatEvent: outputCollector.emitChatEvent,
    };

    // Create an AbortController to simulate stream abort
    const abortController = new AbortController();

    const bash = createBashTool(toolConfig);

    // Start a foreground bash with the abort signal
    const bashPromise = bash.execute!(
      {
        script: `echo "${marker1}"; sleep 2; echo "${marker2}"`,
        run_in_background: false,
        display_name: testId,
        timeout_secs: 30,
      },
      { toolCallId, messages: [], context: undefined, abortSignal: abortController.signal }
    ) as Promise<ToolExecuteResult>;

    // Wait for first marker
    await waitForBashOutput(outputCollector.chunks, marker1, FOREGROUND_OUTPUT_READY_TIMEOUT_MS);

    // Send to background
    manager.sendToBackground(toolCallId);
    const result = await bashPromise;

    expect(result.success).toBe(true);
    expect(result.backgroundProcessId).toBe(testId);

    // NOW simulate what happens when user sends a new message:
    // The stream manager aborts the previous stream
    abortController.abort();

    // Wait for process to complete (it should NOT be killed by abort)
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Check process status - should be "exited" with code 0, NOT "killed" with -997
    const proc = await manager.getProcess(testId);
    expect(proc).toBeDefined();
    expect(proc?.status).toBe("exited");
    expect(proc?.exitCode).toBe(0);

    // Verify marker2 is in output (process continued to completion)
    const output = await manager.getOutput(testId);
    expect(output.success).toBe(true);
    if (output.success) {
      expect(output.output).toContain(marker2);
    }
  });
});
