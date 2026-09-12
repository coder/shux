import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  configureTestRetries,
  waitFor,
  modelString,
  resolveOrpcClient,
  createWorkspaceWithInit,
  TEST_TIMEOUT_SSH_MS,
  trustProject,
} from "../helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import { getContainerName } from "../../../src/node/runtime/DockerRuntime";
import { HistoryService } from "../../../src/node/services/historyService";
import { createMuxMessage, type MuxMessage } from "../../../src/common/types/message";
import assert from "node:assert";

/** Collect all messages via iterateFullHistory (replaces removed getFullHistory). */
async function collectFullHistory(service: HistoryService, workspaceId: string) {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys for tests that need them
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// SSH server config (shared across SSH runtime tests)
let sshConfig: SSHServerConfig | undefined;
// Retry flaky tests in CI (API latency / rate limiting)
configureTestRetries(3);

describeIntegration("Workspace fork", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for forkWorkspace tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000); // 60s timeout for Docker operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      const isSSH = type === "ssh";

      const getRuntimeConfig = (): RuntimeConfig | undefined => {
        if (type === "ssh") {
          if (!sshConfig) {
            throw new Error("SSH test server was not initialized");
          }
          return {
            type: "ssh",
            host: "testuser@localhost",
            srcBaseDir: sshConfig.workdir,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined;
      };

      const getTimeout = (baseMs: number) =>
        isSSH ? Math.max(baseMs, TEST_TIMEOUT_SSH_MS) : baseMs;
      const runtimeTest = isSSH ? test : test.concurrent;

      runtimeTest(
        "should fail to fork workspace with invalid name",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const runtimeConfig = getRuntimeConfig();
            const { workspaceId: sourceWorkspaceId } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              "source-workspace",
              runtimeConfig,
              isSSH,
              isSSH
            );
            const client = resolveOrpcClient(env);

            // Test various invalid names
            const invalidNames = [
              { name: "", expectedError: "empty" },
              { name: "Invalid-Name", expectedError: "lowercase" },
              { name: "name with spaces", expectedError: "lowercase" },
              { name: "name@special", expectedError: "lowercase" },
              { name: "a".repeat(65), expectedError: "64 characters" },
            ];

            for (const { name, expectedError } of invalidNames) {
              const forkResult = await client.workspace.fork({
                sourceWorkspaceId,
                newName: name,
              });
              expect(forkResult.success).toBe(false);
              if (forkResult.success) continue;
              expect(forkResult.error.toLowerCase()).toContain(expectedError.toLowerCase());
            }

            // Cleanup
            await client.workspace.remove({ workspaceId: sourceWorkspaceId });
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        getTimeout(15000)
      );

      runtimeTest(
        "should fork workspace and send message successfully",
        async () => {
          const runtimeConfig = getRuntimeConfig();
          const {
            env,
            workspaceId: sourceWorkspaceId,
            cleanup,
          } = await setupWorkspace("anthropic", undefined, {
            runtimeConfig,
            waitForInit: isSSH,
            isSSH,
          });

          try {
            // Fork the workspace
            const client = resolveOrpcClient(env);
            const forkResult = await client.workspace.fork({
              sourceWorkspaceId,
              newName: "forked-workspace",
            });
            // Keep the refusal reason visible when CI cannot map transformed stack lines.
            expect(forkResult).toEqual(expect.objectContaining({ success: true }));
            if (!forkResult.success) return;
            const forkedWorkspaceId = forkResult.metadata.id;

            // User expects: forked workspace is functional - can send messages to it
            const collector = createStreamCollector(env.orpc, forkedWorkspaceId);
            collector.start();
            await collector.waitForSubscription();
            const sendResult = await sendMessageWithModel(
              env,
              forkedWorkspaceId,
              "What is 2+2? Answer with just the number.",
              modelString("anthropic", "claude-sonnet-4-5")
            );
            expect(sendResult).toEqual(expect.objectContaining({ success: true }));

            // Verify stream completes successfully
            await collector.waitForEvent("stream-end", 30000);
            assertStreamSuccess(collector);

            const finalMessage = collector.getFinalMessage();
            expect(finalMessage).toBeDefined();
            collector.stop();
          } finally {
            await cleanup();
          }
        },
        getTimeout(45000)
      );

      runtimeTest(
        "should preserve chat history when forking workspace",
        async () => {
          const runtimeConfig = getRuntimeConfig();
          const {
            env,
            workspaceId: sourceWorkspaceId,
            cleanup,
          } = await setupWorkspace("anthropic", undefined, {
            runtimeConfig,
            waitForInit: isSSH,
            isSSH,
          });

          try {
            // Add history to source workspace
            const historyService = new HistoryService(env.config);
            const uniqueWord = `testword-${Date.now()}`;
            const historyMessages = [
              createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
              createMuxMessage(
                "msg-2",
                "assistant",
                `I will remember the word "${uniqueWord}".`,
                {}
              ),
            ];

            for (const msg of historyMessages) {
              const result = await historyService.appendToHistory(sourceWorkspaceId, msg);
              expect(result.success).toBe(true);
            }

            // Fork the workspace
            const client = resolveOrpcClient(env);
            const forkResult = await client.workspace.fork({
              sourceWorkspaceId,
              newName: "forked-with-history",
            });
            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;
            const forkedWorkspaceId = forkResult.metadata.id;

            // User expects: forked workspace has access to history
            const forkedMessages = await collectFullHistory(historyService, forkedWorkspaceId);

            const assistantContent = forkedMessages
              .filter((msg) => msg.role === "assistant")
              .flatMap((msg) =>
                msg.parts
                  .filter((part) => part.type === "text")
                  .map((part) => (part as { text: string }).text)
              )
              .join(" ");
            expect(assistantContent).toContain(uniqueWord);
          } finally {
            await cleanup();
          }
        },
        getTimeout(45000)
      );

      runtimeTest(
        "should create independent workspaces that can send messages concurrently",
        async () => {
          const runtimeConfig = getRuntimeConfig();
          const {
            env,
            workspaceId: sourceWorkspaceId,
            cleanup,
          } = await setupWorkspace("anthropic", undefined, {
            runtimeConfig,
            waitForInit: isSSH,
            isSSH,
          });

          try {
            // Fork the workspace
            const client = resolveOrpcClient(env);
            const forkResult = await client.workspace.fork({
              sourceWorkspaceId,
              newName: "forked-independent",
            });
            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;
            const forkedWorkspaceId = forkResult.metadata.id;

            // User expects: both workspaces work independently
            // Start collectors before sending messages
            const sourceCollector = createStreamCollector(env.orpc, sourceWorkspaceId);
            const forkedCollector = createStreamCollector(env.orpc, forkedWorkspaceId);
            sourceCollector.start();
            forkedCollector.start();
            await Promise.all([
              sourceCollector.waitForSubscription(),
              forkedCollector.waitForSubscription(),
            ]);

            // Send different messages to both concurrently
            const [sourceResult, forkedResult] = await Promise.all([
              sendMessageWithModel(
                env,
                sourceWorkspaceId,
                "What is 5+5? Answer with just the number.",
                modelString("anthropic", "claude-sonnet-4-5")
              ),
              sendMessageWithModel(
                env,
                forkedWorkspaceId,
                "What is 3+3? Answer with just the number.",
                modelString("anthropic", "claude-sonnet-4-5")
              ),
            ]);

            expect(sourceResult.success).toBe(true);
            expect(forkedResult.success).toBe(true);

            // Verify both streams complete successfully
            await Promise.all([
              sourceCollector.waitForEvent("stream-end", 30000),
              forkedCollector.waitForEvent("stream-end", 30000),
            ]);

            assertStreamSuccess(sourceCollector);
            assertStreamSuccess(forkedCollector);

            expect(sourceCollector.getFinalMessage()).toBeDefined();
            expect(forkedCollector.getFinalMessage()).toBeDefined();
            sourceCollector.stop();
            forkedCollector.stop();
          } finally {
            await cleanup();
          }
        },
        getTimeout(45000)
      );

      runtimeTest(
        "should preserve partial streaming response when forking mid-stream",
        async () => {
          const runtimeConfig = getRuntimeConfig();
          const {
            env,
            workspaceId: sourceWorkspaceId,
            cleanup,
          } = await setupWorkspace("anthropic", undefined, {
            runtimeConfig,
            waitForInit: isSSH,
            isSSH,
          });

          try {
            // Start collector before starting stream
            const sourceCollector = createStreamCollector(env.orpc, sourceWorkspaceId);
            sourceCollector.start();
            await sourceCollector.waitForSubscription();

            const sendResult = await sendMessageWithModel(
              env,
              sourceWorkspaceId,
              'Count from 1 to 25, one number per line, and include the word "alpha" after each number.',
              modelString("anthropic", "claude-sonnet-4-5")
            );
            expect(sendResult.success).toBe(true);

            // Wait for stream to start
            const streamStartEvent = await sourceCollector.waitForEvent(
              "stream-start",
              getTimeout(15000)
            );
            expect(streamStartEvent).not.toBeNull();

            const deltaEvent = await sourceCollector.waitForEvent(
              "stream-delta",
              getTimeout(15000)
            );
            expect(deltaEvent).not.toBeNull();

            // Wait for partial.json to be written so the fork can commit in-flight output.
            const historyService = new HistoryService(env.config);
            let partialText = "";
            const partialReady = await waitFor(async () => {
              const partial = await historyService.readPartial(sourceWorkspaceId);
              if (!partial) return false;
              partialText = (partial.parts ?? [])
                .filter((part: MuxMessage["parts"][number]) => part.type === "text")
                .map((part: MuxMessage["parts"][number]) => (part.type === "text" ? part.text : ""))
                .join(" ")
                .trim();
              return partialText.length > 0;
            }, getTimeout(15000));
            expect(partialReady).toBe(true);
            expect(partialText.length).toBeGreaterThan(0);
            const partialSnippet = partialText.length > 24 ? partialText.slice(0, 24) : partialText;

            // Fork while stream is active (this should commit partial to history)
            const client = resolveOrpcClient(env);
            const forkResult = await client.workspace.fork({
              sourceWorkspaceId,
              newName: "forked-mid-stream",
            });
            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;
            const forkedWorkspaceId = forkResult.metadata.id;

            const forkedMessages = await collectFullHistory(historyService, forkedWorkspaceId);

            const forkedAssistantText = forkedMessages
              .filter((msg) => msg.role === "assistant")
              .flatMap((msg) =>
                msg.parts
                  .filter((part) => part.type === "text")
                  .map((part) => (part as { text: string }).text)
              )
              .join(" ");
            expect(forkedAssistantText).toContain(partialSnippet);

            // Wait for source stream to complete
            await sourceCollector.waitForEvent("stream-end", getTimeout(60000));
            sourceCollector.stop();

            // User expects: forked workspace is functional despite being forked mid-stream
            // Send a message to the forked workspace
            const forkedCollector = createStreamCollector(env.orpc, forkedWorkspaceId);
            forkedCollector.start();
            // Wait for subscription before sending to avoid race condition where stream-end
            // is emitted before collector is ready to receive it
            await forkedCollector.waitForSubscription();
            const forkedSendResult = await sendMessageWithModel(
              env,
              forkedWorkspaceId,
              "What is 7+3? Answer with just the number.",
              modelString("anthropic", "claude-sonnet-4-5")
            );
            expect(forkedSendResult.success).toBe(true);

            // Verify forked workspace stream completes successfully
            await forkedCollector.waitForEvent("stream-end", 30000);
            assertStreamSuccess(forkedCollector);

            expect(forkedCollector.getFinalMessage()).toBeDefined();
            forkedCollector.stop();
          } finally {
            await cleanup();
          }
        },
        getTimeout(60000)
      );

      runtimeTest(
        "should make forked workspace available in workspace list",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const runtimeConfig = getRuntimeConfig();
            const { workspaceId: sourceWorkspaceId } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              "source-workspace",
              runtimeConfig,
              isSSH,
              isSSH
            );
            const client = resolveOrpcClient(env);

            // Fork the workspace
            const forkResult = await client.workspace.fork({
              sourceWorkspaceId,
              newName: "forked-workspace",
            });
            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;

            // Regression coverage: SSH forks must stay on SSH runtime.
            if (isSSH) {
              expect(forkResult.metadata.runtimeConfig.type).toBe("ssh");
              if (forkResult.metadata.runtimeConfig.type === "ssh") {
                expect(forkResult.metadata.runtimeConfig.host).toBe("testuser@localhost");
                expect(forkResult.metadata.runtimeConfig.srcBaseDir).toBe(sshConfig!.workdir);
              }
            }

            // User expects: both workspaces appear in workspace list
            const workspaces = await client.workspace.list();
            const workspaceIds = workspaces.map((w: { id: string }) => w.id);
            expect(workspaceIds).toContain(sourceWorkspaceId);
            expect(workspaceIds).toContain(forkResult.metadata.id);

            const sourceWorkspace = workspaces.find(
              (w: { id: string }) => w.id === sourceWorkspaceId
            );
            const forkedWorkspace = workspaces.find(
              (w: { id: string }) => w.id === forkResult.metadata.id
            );
            expect(sourceWorkspace).toBeDefined();
            expect(forkedWorkspace).toBeDefined();

            if (isSSH) {
              expect(sourceWorkspace?.runtimeConfig.type).toBe("ssh");
              expect(forkedWorkspace?.runtimeConfig.type).toBe("ssh");
            }

            // Cleanup
            await client.workspace.remove({ workspaceId: sourceWorkspaceId });
            await client.workspace.remove({ workspaceId: forkResult.metadata.id });
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        getTimeout(15000)
      );
    }
  );

  test(
    "should fork docker workspace and preserve docker runtime metadata",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();
      const client = resolveOrpcClient(env);
      let sourceWorkspaceId: string | undefined;
      let forkedWorkspaceId: string | undefined;

      try {
        const dockerRuntimeConfig: RuntimeConfig = {
          type: "docker",
          image: "mux-ssh-test",
        };

        const createResult = await createWorkspaceWithInit(
          env,
          tempGitRepo,
          "docker-source",
          dockerRuntimeConfig,
          true,
          true
        );
        sourceWorkspaceId = createResult.workspaceId;

        const sourceWorkspace = (await client.workspace.list()).find(
          (workspace: { id: string }) => workspace.id === sourceWorkspaceId
        );
        expect(sourceWorkspace).toBeDefined();
        expect(sourceWorkspace?.runtimeConfig.type).toBe("docker");
        if (sourceWorkspace?.runtimeConfig.type === "docker") {
          expect(sourceWorkspace.runtimeConfig.image).toBe(dockerRuntimeConfig.image);
        }

        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "docker-forked",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        forkedWorkspaceId = forkResult.metadata.id;

        // Regression: docker forks must use destination identity, not source container.
        expect(forkResult.metadata.runtimeConfig.type).toBe("docker");
        if (forkResult.metadata.runtimeConfig.type === "docker") {
          expect(forkResult.metadata.runtimeConfig.image).toBe(dockerRuntimeConfig.image);
          expect(forkResult.metadata.runtimeConfig.containerName).toBe(
            getContainerName(tempGitRepo, "docker-forked")
          );
          expect(forkResult.metadata.runtimeConfig.containerName).not.toBe(
            getContainerName(tempGitRepo, "docker-source")
          );
        }

        const workspaces = await client.workspace.list();
        const forkedWorkspace = workspaces.find((workspace: { id: string }) => {
          return workspace.id === forkedWorkspaceId;
        });

        expect(forkedWorkspace).toBeDefined();
        expect(forkedWorkspace?.runtimeConfig.type).toBe("docker");
        if (forkedWorkspace?.runtimeConfig.type === "docker") {
          expect(forkedWorkspace.runtimeConfig.image).toBe(dockerRuntimeConfig.image);
          expect(forkedWorkspace.runtimeConfig.containerName).toBe(
            getContainerName(tempGitRepo, "docker-forked")
          );
          expect(forkedWorkspace.runtimeConfig.containerName).not.toBe(
            getContainerName(tempGitRepo, "docker-source")
          );
        }
      } finally {
        if (forkedWorkspaceId) {
          await client.workspace.remove({ workspaceId: forkedWorkspaceId });
        }
        if (sourceWorkspaceId) {
          await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        }
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_SSH_MS
  );

  test.concurrent(
    "should fork local (project-dir) workspace successfully",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        // This means type: "local" without srcBaseDir
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        await trustProject(env, tempGitRepo);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-source",
          trunkBranch: "main", // Not used for local runtime
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Verify source workspace uses local runtime (project-dir mode)
        expect(createResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in createResult.metadata.runtimeConfig).toBe(false);

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-forked",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Forked workspace should also use local runtime (project-dir mode)
        expect(forkResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkResult.metadata.runtimeConfig).toBe(false);

        // Both workspaces should point to the same project path
        expect(forkResult.metadata.namedWorkspacePath).toBe(
          createResult.metadata.namedWorkspacePath
        );
        expect(forkResult.metadata.projectPath).toBe(createResult.metadata.projectPath);

        // User expects: both workspaces appear in workspace list
        const workspaces = await client.workspace.list();
        const workspaceIds = workspaces.map((w: { id: string }) => w.id);
        expect(workspaceIds).toContain(sourceWorkspaceId);
        expect(workspaceIds).toContain(forkedWorkspaceId);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should preserve chat history when forking local (project-dir) workspace",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        await trustProject(env, tempGitRepo);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-source-history",
          trunkBranch: "main",
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Add history to source workspace
        const historyService = new HistoryService(env.config);
        const uniqueWord = `localtest-${Date.now()}`;
        const historyMessages = [
          createMuxMessage("msg-1", "user", `Remember this local word: ${uniqueWord}`, {}),
          createMuxMessage(
            "msg-2",
            "assistant",
            `I will remember the local word "${uniqueWord}".`,
            {}
          ),
        ];

        for (const msg of historyMessages) {
          const result = await historyService.appendToHistory(sourceWorkspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-forked-history",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Verify forked workspace has copied history
        const forkedMessages = await collectFullHistory(historyService, forkedWorkspaceId);

        // Check that history contains our unique word
        const historyContent = forkedMessages
          .map((msg) => {
            if ("parts" in msg && Array.isArray(msg.parts)) {
              return msg.parts
                .filter((p) => p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("");
            }
            return "";
          })
          .join(" ");
        expect(historyContent).toContain(uniqueWord);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should persist local runtimeConfig through config reload after fork",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        await trustProject(env, tempGitRepo);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-persist-test",
          trunkBranch: "main",
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-persist-forked",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Verify forked workspace has local runtimeConfig immediately
        expect(forkResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkResult.metadata.runtimeConfig).toBe(false);

        // BUG REPRO: Reload config and verify runtimeConfig persisted correctly
        // This simulates what happens after app restart or when getAllWorkspaceMetadata is called
        const workspaces = await client.workspace.list();
        const forkedWorkspace = workspaces.find((w: { id: string }) => w.id === forkedWorkspaceId);

        // This is the critical assertion that would fail before the fix:
        // After reload, the workspace should still have type: "local" without srcBaseDir
        expect(forkedWorkspace).toBeDefined();
        expect(forkedWorkspace!.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkedWorkspace!.runtimeConfig).toBe(false);

        // Verify namedWorkspacePath is the project path (not ~/.mux/src/...) for local workspaces
        // This ensures Open-in-Editor and path display work correctly after reload
        expect(forkedWorkspace!.namedWorkspacePath).toBe(tempGitRepo);
        expect(forkResult.metadata.namedWorkspacePath).toBe(tempGitRepo);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
