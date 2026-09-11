import * as path from "path";
import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  validateApiKeys,
  getApiKey,
  setupProviders,
} from "../setup";
import {
  generateBranchName,
  createWorkspace,
  waitForInitComplete,
  waitForInitEnd,
  collectInitEvents,
  resolveOrpcClient,
  HAIKU_MODEL,
} from "../helpers";
import { createStreamCollector } from "../streamCollector";
import type { WorkspaceInitEvent } from "@/common/orpc/types";
import { isInitOutput, isInitEnd, isInitProgress, isInitStart } from "@/common/orpc/types";
import * as os from "os";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import { sshConnectionPool } from "../../../src/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys for AI tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

/**
 * Create a temp git repo with a .mux/init hook that writes to stdout/stderr and exits with a given code
 */
async function createTempGitRepoWithInitHook(options: {
  exitCode: number;
  stdoutLines?: string[];
  stderrLines?: string[];
  sleepBetweenLines?: number; // milliseconds
  customScript?: string; // Optional custom script content (overrides stdout/stderr)
}): Promise<string> {
  const execAsync = promisify(exec);

  // Use mkdtemp to avoid race conditions
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-init-hook-"));

  // Initialize git repo
  await execAsync(`git init`, { cwd: tempDir });
  await execAsync(`git config user.email "test@example.com" && git config user.name "Test User"`, {
    cwd: tempDir,
  });
  await execAsync(`echo "test" > README.md && git add . && git commit -m "Initial commit"`, {
    cwd: tempDir,
  });

  // Create .mux directory
  const muxDir = path.join(tempDir, ".mux");
  await fs.mkdir(muxDir, { recursive: true });

  // Create init hook script
  const hookPath = path.join(muxDir, "init");

  let scriptContent: string;
  if (options.customScript) {
    scriptContent = `#!/bin/bash\n${options.customScript}\nexit ${options.exitCode}\n`;
  } else {
    const sleepCmd = options.sleepBetweenLines ? `sleep ${options.sleepBetweenLines / 1000}` : "";

    const stdoutCmds = (options.stdoutLines ?? [])
      .map((line, idx) => {
        const needsSleep = sleepCmd && idx < (options.stdoutLines?.length ?? 0) - 1;
        return `echo "${line}"${needsSleep ? `\n${sleepCmd}` : ""}`;
      })
      .join("\n");

    const stderrCmds = (options.stderrLines ?? []).map((line) => `echo "${line}" >&2`).join("\n");

    scriptContent = `#!/bin/bash\n${stdoutCmds}\n${stderrCmds}\nexit ${options.exitCode}\n`;
  }

  await fs.writeFile(hookPath, scriptContent, { mode: 0o755 });

  // Commit the init hook (required for SSH runtime - git worktree syncs committed files)
  await execAsync(`git add -A && git commit -m "Add init hook"`, { cwd: tempDir });

  return tempDir;
}

/**
 * Cleanup temporary git repository
 */
async function cleanupTempGitRepo(repoPath: string): Promise<void> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  console.warn(`Failed to cleanup temp git repo after ${maxRetries} attempts:`, lastError);
}

describeIntegration("Workspace init hook", () => {
  test.concurrent(
    "should stream init hook output and allow workspace usage on hook success",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["Installing dependencies...", "Build complete!"],
        stderrLines: ["Warning: deprecated package"],
      });

      try {
        const branchName = generateBranchName("init-hook-success");

        // Create workspace (which will trigger the hook)
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete and collect init events for verification
        const initEvents = await collectInitEvents(env, workspaceId, 10000);

        // Verify event sequence
        expect(initEvents.length).toBeGreaterThan(0);

        // First event should be start
        const startEvent = initEvents.find((e) => isInitStart(e));
        expect(startEvent).toBeDefined();
        if (startEvent && isInitStart(startEvent)) {
          // Hook path should be the project path (where .mux/init exists)
          expect(startEvent.hookPath).toBeTruthy();
        }

        // Should have output and error lines
        const outputEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && !e.isError
        );
        const errorEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && e.isError === true
        );

        // Should have workspace creation logs + hook output
        expect(outputEvents.length).toBeGreaterThanOrEqual(2);

        // Verify hook output is present (may have workspace creation logs before it)
        const outputLines = outputEvents.map((e) => e.line);
        expect(outputLines).toContain("Installing dependencies...");
        expect(outputLines).toContain("Build complete!");

        // The hook's stderr line should be in the error events
        // Note: There may be other stderr messages (e.g., git fetch failures for repos without remotes)
        const hookErrorEvent = errorEvents.find((e) => e.line === "Warning: deprecated package");
        expect(hookErrorEvent).toBeDefined();

        // Last event should be end with exitCode 0
        const finalEvent = initEvents[initEvents.length - 1];
        expect(isInitEnd(finalEvent)).toBe(true);
        if (isInitEnd(finalEvent)) {
          expect(finalEvent.exitCode).toBe(0);
        }

        // Workspace should be usable - verify getInfo succeeds
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId });
        expect(info).not.toBeNull();
        if (info) expect(info.id).toBe(workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should stream init hook output and allow workspace usage on hook failure",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 1,
        stdoutLines: ["Starting setup..."],
        stderrLines: ["ERROR: Failed to install dependencies"],
      });

      try {
        const branchName = generateBranchName("init-hook-failure");

        // Create workspace
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete (without throwing on failure) and collect events
        const initEvents = await waitForInitEnd(env, workspaceId, 10000);

        // Verify we got events
        expect(initEvents.length).toBeGreaterThan(0);

        // Should have start event
        const failureStartEvent = initEvents.find((e) => isInitStart(e));
        expect(failureStartEvent).toBeDefined();

        // Should have output and error
        const failureOutputEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && !e.isError
        );
        const failureErrorEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && e.isError === true
        );
        expect(failureOutputEvents.length).toBeGreaterThanOrEqual(1);
        expect(failureErrorEvents.length).toBeGreaterThanOrEqual(1);

        // Last event should be end with exitCode 1
        const failureFinalEvent = initEvents[initEvents.length - 1];
        expect(isInitEnd(failureFinalEvent)).toBe(true);
        if (isInitEnd(failureFinalEvent)) {
          expect(failureFinalEvent.exitCode).toBe(1);
        }

        // CRITICAL: Workspace should remain usable even after hook failure
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId });
        expect(info).not.toBeNull();
        if (info) expect(info.id).toBe(workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should not emit meta events when no init hook exists",
    async () => {
      const env = await createTestEnvironment();
      // Create repo without .mux/init hook
      const execAsync = promisify(exec);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-no-hook-"));

      try {
        // Initialize git repo without hook
        await execAsync(`git init`, { cwd: tempDir });
        await execAsync(
          `git config user.email "test@example.com" && git config user.name "Test User"`,
          { cwd: tempDir }
        );
        await execAsync(`echo "test" > README.md && git add . && git commit -m "Initial commit"`, {
          cwd: tempDir,
        });

        const branchName = generateBranchName("no-hook");

        // Create workspace
        const createResult = await createWorkspace(env, tempDir, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for init to complete and collect events
        const initEvents = await collectInitEvents(env, workspaceId, 5000);

        // Should have init-start event (always emitted, even without hook)
        const startEvent = initEvents.find((e) => isInitStart(e));
        expect(startEvent).toBeDefined();

        // Should have workspace creation logs (e.g., "Creating git worktree...")
        const outputEvents = initEvents.filter((e) => isInitOutput(e));
        expect(outputEvents.length).toBeGreaterThan(0);

        // Should have completion event with exit code 0 (success, no hook)
        const endEvent = initEvents.find((e) => isInitEnd(e));
        expect(endEvent).toBeDefined();
        if (endEvent && isInitEnd(endEvent)) {
          expect(endEvent.exitCode).toBe(0);
        }

        // Workspace should still be usable
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId: createResult.metadata.id });
        expect(info).not.toBeNull();
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempDir);
      }
    },
    15000
  );

  test.concurrent(
    "streams checkout progress to a subscriber that attaches after create() resolves",
    async () => {
      // The renderer only subscribes once create() has announced the workspace, so
      // checkout progress emitted before that point can never reach the creation card.
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["hook ran"],
      });

      try {
        const branchName = generateBranchName("checkout-progress");
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const initEvents = await collectInitEvents(env, createResult.metadata.id, 10000);

        const progressEvents = initEvents.filter(isInitProgress);
        expect(progressEvents.at(-1)).toMatchObject({ label: "Updating files", percent: 100 });

        // The checkout must be complete before the hook runs against it.
        const lines = initEvents.filter(isInitOutput).map((e) => e.line);
        const materializedAt = lines.indexOf("Worktree created successfully");
        const hookAt = lines.findIndex((line) => /Running init hook:/.test(line));
        expect(materializedAt).toBeGreaterThanOrEqual(0);
        expect(hookAt).toBeGreaterThan(materializedAt);
        expect(lines).toContain("hook ran");
        await fs.access(path.join(createResult.metadata.namedWorkspacePath, "README.md"));
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "prunes committed plugin overrides after the deferred checkout and before the hook",
    async () => {
      // A repository that tracks .xum/mcp.local.jsonc materializes committed plugin enables
      // into every fresh worktree; the sanitization that used to run at registration must
      // now run once the files exist, and still ahead of the repo-controlled hook.
      const env = await createTestEnvironment();
      const execAsync = promisify(exec);
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 0,
        customScript: "cat .xum/mcp.local.jsonc > hook-saw-overrides",
      });
      await fs.mkdir(path.join(tempGitRepo, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(tempGitRepo, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo", "shots"] })
      );
      await execAsync("git add -A && git commit -m 'track plugin overrides'", {
        cwd: tempGitRepo,
      });

      try {
        const branchName = generateBranchName("deferred-sanitize");
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        await collectInitEvents(env, createResult.metadata.id, 10000);

        const workspacePath = createResult.metadata.namedWorkspacePath;
        const pruned = JSON.parse(
          await fs.readFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "utf8")
        ) as { enabledServers: string[] };
        expect(pruned.enabledServers).toEqual(["shots"]);
        expect(
          JSON.parse(await fs.readFile(path.join(workspacePath, "hook-saw-overrides"), "utf8"))
        ).toEqual(pruned);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "reports a failed deferred checkout on the card and keeps the workspace",
    async () => {
      const env = await createTestEnvironment();
      const execAsync = promisify(exec);
      const tempGitRepo = await createTempGitRepoWithInitHook({ exitCode: 0 });
      await fs.writeFile(path.join(tempGitRepo, ".gitattributes"), "README.md filter=fail\n");
      await execAsync(
        "git add -A && git commit -m 'require checkout filter' && git config filter.fail.smudge 'exit 1' && git config filter.fail.required true",
        { cwd: tempGitRepo }
      );

      try {
        const branchName = generateBranchName("deferred-checkout-failure");
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const initEvents = await waitForInitEnd(env, createResult.metadata.id, 10000);
        const endEvent = initEvents.find(isInitEnd);
        expect(endEvent?.exitCode).toBe(-1);
        const errorLines = initEvents
          .filter((e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> => isInitOutput(e))
          .filter((e) => e.isError === true)
          .map((e) => e.line);
        expect(
          errorLines.filter((line) => line.includes("smudge filter fail failed"))
        ).toHaveLength(1);
        expect(initEvents.filter(isInitOutput).some((e) => /Running init hook/.test(e.line))).toBe(
          false
        );
        // Like a remote sync failure, the workspace stays so the user can inspect and remove it.
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId: createResult.metadata.id });
        expect(info?.id).toBe(createResult.metadata.id);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "prunes committed plugin overrides even when materialization fails after the checkout",
    async () => {
      // A broken submodule fails materialization after the tracked override file is on
      // disk, and the workspace stays usable after a failed init, so the prune must not
      // depend on materialization succeeding.
      const env = await createTestEnvironment();
      const execAsync = promisify(exec);
      const tempGitRepo = await createTempGitRepoWithInitHook({ exitCode: 0 });
      await fs.mkdir(path.join(tempGitRepo, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(tempGitRepo, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo", "shots"] })
      );
      await fs.writeFile(
        path.join(tempGitRepo, ".gitmodules"),
        '[submodule "dep"]\n\tpath = dep\n\turl = /nonexistent/dep.git\n'
      );
      await execAsync(
        "git add -A && git update-index --add --cacheinfo 160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,dep && git commit -m 'broken submodule'",
        { cwd: tempGitRepo }
      );

      try {
        const branchName = generateBranchName("deferred-sanitize-after-failure");
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const initEvents = await waitForInitEnd(env, createResult.metadata.id, 10000);
        expect(initEvents.find(isInitEnd)?.exitCode).toBe(-1);

        const workspacePath = createResult.metadata.namedWorkspacePath;
        const pruned = JSON.parse(
          await fs.readFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "utf8")
        ) as { enabledServers: string[] };
        expect(pruned.enabledServers).toEqual(["shots"]);
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId: createResult.metadata.id });
        expect(info?.id).toBe(createResult.metadata.id);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "archiving during a deferred checkout parks a complete, sanitized checkout",
    async () => {
      // Archive aborts a running init but keeps the checkout registered (default behaviour),
      // and unarchiving does not rerun init, so the checkout must finish and prune committed
      // plugin enables before the workspace is parked.
      const env = await createTestEnvironment();
      const execAsync = promisify(exec);
      const tempGitRepo = await createTempGitRepoWithInitHook({ exitCode: 0 });
      await fs.mkdir(path.join(tempGitRepo, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(tempGitRepo, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo", "shots"] })
      );
      // README.md sorts after .xum/, so the override is on disk while its smudge filter stalls.
      await fs.writeFile(path.join(tempGitRepo, ".gitattributes"), "README.md filter=slow\n");
      await execAsync(
        "git add -A && git commit -m 'slow checkout' && git config filter.slow.smudge 'sleep 5; cat'",
        { cwd: tempGitRepo }
      );

      try {
        const branchName = generateBranchName("deferred-archive");
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const workspaceId = createResult.metadata.id;
        const workspacePath = createResult.metadata.namedWorkspacePath;

        // Archive once the checkout has written the override but is still stalled on README.md.
        const overridePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            await fs.access(overridePath);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        const client = resolveOrpcClient(env);
        const archiveResult = await client.workspace.archive({ workspaceId });
        expect(archiveResult.success).toBe(true);

        const pruned = JSON.parse(await fs.readFile(overridePath, "utf8")) as {
          enabledServers: string[];
        };
        expect(pruned.enabledServers).toEqual(["shots"]);
        expect(await fs.readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("test\n");
        const { stdout } = await execAsync("git symbolic-ref HEAD", { cwd: workspacePath });
        expect(stdout.trim()).toBe(`refs/heads/${branchName}`);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "should persist init state to disk for replay across page reloads",
    async () => {
      const env = await createTestEnvironment();

      const repoPath = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["Installing dependencies", "Done!"],
        stderrLines: [],
      });

      try {
        const branchName = generateBranchName("replay-test");
        const createResult = await createWorkspace(env, repoPath, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for init hook to complete
        await waitForInitComplete(env, workspaceId, 5000);

        // Verify init-status.json exists on disk
        const initStatusPath = path.join(
          path.join(env.config.sessionsDir, workspaceId),
          "init-status.json"
        );
        const statusExists = await fs
          .access(initStatusPath)
          .then(() => true)
          .catch(() => false);
        expect(statusExists).toBe(true);

        // Read and verify persisted state
        const statusContent = await fs.readFile(initStatusPath, "utf-8");
        const status = JSON.parse(statusContent);
        expect(status.status).toBe("success");
        expect(status.exitCode).toBe(0);

        // Should include workspace creation logs + hook output
        expect(status.lines).toEqual(
          expect.arrayContaining([
            {
              line: "Creating git worktree...",
              isError: false,
              step: true,
              timestamp: expect.any(Number),
            },
            {
              line: "Worktree created successfully",
              isError: false,
              step: true,
              timestamp: expect.any(Number),
            },
            expect.objectContaining({
              line: expect.stringMatching(/Running init hook:/),
              isError: false,
              step: true,
            }),
            { line: "Installing dependencies", isError: false, timestamp: expect.any(Number) },
            { line: "Done!", isError: false, timestamp: expect.any(Number) },
          ])
        );
        expect(status.hookPath).toBeTruthy(); // Project path where hook exists
        expect(status.startTime).toBeGreaterThan(0);
        expect(status.endTime).toBeGreaterThan(status.startTime);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      }
    },
    15000
  );
});

// TODO: This test relies on timestamp-based event capture (sentEvents with timestamps)
// which isn't available in the ORPC subscription model. The test verified real-time
// streaming timing behavior. Consider reimplementing with StreamCollector timestamp tracking.
describeIntegration("Init timing behavior", () => {
  test("should receive init events with natural timing (not batched)", async () => {
    const env = await createTestEnvironment();
    // Create a repo with an init hook that outputs lines with delays
    const repoPath = await createTempGitRepoWithInitHook({
      exitCode: 0,
      // Output 5 lines with 100ms delay between each
      stdoutLines: ["line1", "line2", "line3", "line4", "line5"],
      sleepBetweenLines: 100,
    });

    try {
      await setupProviders(env, { anthropic: { apiKey: getApiKey("ANTHROPIC_API_KEY") } });
      const branchName = generateBranchName();
      const client = resolveOrpcClient(env);

      // Create workspace to trigger init hook
      const result = await createWorkspace(env, repoPath, branchName);
      expect(result.success).toBe(true);
      const workspaceId = result.success ? result.metadata.id : null;
      expect(workspaceId).toBeTruthy();

      // Create a collector to capture events with timestamps
      const collector = createStreamCollector(client, workspaceId!);
      collector.start();
      await collector.waitForSubscription(5000);

      // Wait for init to complete
      await collector.waitForEvent("init-end", 15000);
      collector.stop();

      // Get all init-output events with timestamps
      const timestampedEvents = collector.getTimestampedEvents();
      const initOutputEvents = timestampedEvents.filter((te) => te.event.type === "init-output");

      // We should have at least 3 init-output events
      // (some may be combined due to buffering, but not all)
      expect(initOutputEvents.length).toBeGreaterThanOrEqual(3);

      // Check that events arrived with natural timing (not all at once)
      // Calculate time deltas between consecutive events
      const deltas: number[] = [];
      for (let i = 1; i < initOutputEvents.length; i++) {
        const delta = initOutputEvents[i].arrivedAt - initOutputEvents[i - 1].arrivedAt;
        deltas.push(delta);
      }

      // At least some events should have non-zero time intervals
      // (if all batched, all deltas would be ~0)
      const nonZeroDeltas = deltas.filter((d) => d > 10); // 10ms threshold
      expect(nonZeroDeltas.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 30000);
});

// SSH server config for runtime matrix tests
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Runtime Matrix Tests - Init Queue Behavior
// ============================================================================

describeIntegration("Init Queue - Runtime Matrix", () => {
  beforeAll(async () => {
    // Only start SSH server if Docker is available
    if (await isDockerAvailable()) {
      console.log("Starting SSH server container for init queue tests...");
      sshConfig = await startSSHServer();
      console.log(`SSH server ready on port ${sshConfig.port}`);
    } else {
      console.log("Docker not available - SSH tests will be skipped");
    }
  }, 60000);

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests. This allows tests to run concurrently.
  beforeEach(() => {
    sshConnectionPool.clearAllHealth();
    ssh2ConnectionPool.clearAllHealth();
  });

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: `${sshConfig.workdir}/${branchName}`,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      // Timeouts vary by runtime type
      const testTimeout = type === "ssh" ? 90000 : 30000;
      const streamTimeout = type === "ssh" ? 30000 : 15000;

      // Skip SSH tests if Docker is not available
      const shouldRunSSH = () => type === "local" || sshConfig !== undefined;

      test(
        "file_read should wait for init hook before executing (even when init fails)",
        async () => {
          if (!shouldRunSSH()) {
            console.log("Skipping SSH test - Docker not available");
            return;
          }

          const env = await createTestEnvironment();
          // Create repo with a slow init hook that fails (non-zero exit code)
          // Init takes ~2 seconds to simulate real init work
          const repoPath = await createTempGitRepoWithInitHook({
            exitCode: 1, // Fail the init
            customScript: `
echo "Starting init hook..."
sleep 2
echo "Init hook failed!"
exit 1
`,
          });

          try {
            await setupProviders(env, { anthropic: { apiKey: getApiKey("ANTHROPIC_API_KEY") } });
            const branchName = generateBranchName();
            const runtimeConfig = getRuntimeConfig(branchName);
            const client = resolveOrpcClient(env);

            // Create workspace to trigger init hook
            const result = await createWorkspace(
              env,
              repoPath,
              branchName,
              undefined,
              runtimeConfig
            );
            expect(result.success).toBe(true);
            const workspaceId = result.success ? result.metadata.id : null;
            expect(workspaceId).toBeTruthy();

            // Set up collector to track events
            const collector = createStreamCollector(client, workspaceId!);
            collector.start();
            await collector.waitForSubscription(5000);

            // FIRST MESSAGE: Send message that requires file read
            // This should wait for init to complete before file operations can happen
            // Use Haiku for faster responses - this test is about init queue, not model capability
            const firstMessageStart = Date.now();
            await client.workspace.sendMessage({
              workspaceId: workspaceId!,
              message: "Read the README.md file and tell me what it says.",
              options: {
                model: HAIKU_MODEL,
                agentId: "exec",
              },
            });

            // Wait for stream to complete
            await collector.waitForEvent("stream-end", streamTimeout);
            const firstMessageEnd = Date.now();
            const firstMessageDuration = firstMessageEnd - firstMessageStart;

            // First message should include init wait time (~2 seconds + message time)
            // We expect it to be at least 1.5 seconds (accounting for timing variance)
            expect(firstMessageDuration).toBeGreaterThan(1500);

            // Verify init events were received before clearing
            // This proves the init hook ran and completed before file operations
            const initEndEvents = collector.getEvents().filter(isInitEnd);
            expect(initEndEvents.length).toBeGreaterThan(0);
            // The init hook was configured to fail with exit code 1
            const failedInitEvent = initEndEvents.find((e) => e.exitCode === 1);
            expect(failedInitEvent).toBeDefined();

            // Clear collector for second message
            collector.clear();

            // SECOND MESSAGE: Send another message
            // Init is already complete (even though it failed), so no init wait
            await client.workspace.sendMessage({
              workspaceId: workspaceId!,
              message: "What is 2 + 2?",
              options: {
                model: HAIKU_MODEL,
                agentId: "exec",
              },
            });

            // Wait for stream to complete - proves second message also works
            await collector.waitForEvent("stream-end", streamTimeout);

            collector.stop();
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(repoPath);
          }
        },
        testTimeout
      );
    }
  );
});
