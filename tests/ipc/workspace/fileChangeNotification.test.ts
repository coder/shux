/**
 * Integration test for file change notification injection.
 *
 * Tests that when a tracked file (like a plan file) is modified externally,
 * the change is detected and injected as a synthetic user message with
 * <system-file-update> tags into the message stream sent to the LLM.
 *
 * This tests the cache-preserving approach where file changes are communicated
 * via user messages rather than system message modifications.
 */
import { writeFile, mkdir, stat, utimes, readFile, readdir } from "fs/promises";
import { join } from "path";
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  setupProviders,
  preloadTestModules,
  type TestEnvironment,
  shouldRunIntegrationTests,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createStreamCollector,
  HAIKU_MODEL,
  STREAM_TIMEOUT_LOCAL_MS,
  trustProject,
} from "../helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import { getApiKey, validateApiKeys } from "../../testUtils";
import { getPlanFilePath } from "../../../src/common/utils/planStorage";
import { log } from "../../../src/node/services/log";
import { getXumHome } from "../../../src/common/constants/paths";

// Skip tests if integration tests are disabled or API keys are missing
const runTests = shouldRunIntegrationTests();

// Validate API keys are available
if (runTests) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

const describeIntegration = runTests ? describe : describe.skip;

describeIntegration("File Change Notification Integration", () => {
  let env: TestEnvironment;
  let repoPath: string;
  let originalLogLevel: ReturnType<typeof log.getLevel>;

  beforeAll(async () => {
    await preloadTestModules();
    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);

    // Setup Anthropic provider
    const apiKey = getApiKey("ANTHROPIC_API_KEY");
    await setupProviders(env, {
      anthropic: { apiKey },
    });
  }, 30000);

  afterAll(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
    }
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  beforeEach(() => {
    // Enable debug mode to ensure debug_obj files are written
    originalLogLevel = log.getLevel();
    log.setLevel("debug");
  });

  afterEach(() => {
    // Restore original log level
    log.setLevel(originalLogLevel);
  });

  it("should inject file change notification when tracked plan file is modified externally", async () => {
    // 1. Create a workspace
    const branchName = generateBranchName("file-change-test");
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    expect(createResult.success).toBe(true);
    if (!createResult.success) throw new Error("Failed to create workspace");

    const workspaceId = createResult.metadata.id;
    const workspaceName = createResult.metadata.name;
    const projectName = createResult.metadata.projectName;

    try {
      // 2. Get the AgentSession and plan file path
      const session = env.services.workspaceService.getOrCreateSession(workspaceId);
      const planPath = getPlanFilePath(workspaceName, projectName);

      // 3. Create the plan directory and file
      const planDir = join(planPath, "..");
      await mkdir(planDir, { recursive: true });

      const originalContent = "# Plan\n\n## Step 1\n\nOriginal plan content";
      await writeFile(planPath, originalContent);

      // 4. Record the file state (simulates what propose_plan does)
      const { mtimeMs: originalMtime } = await stat(planPath);
      session.recordFileState(planPath, {
        content: originalContent,
        timestamp: originalMtime,
      });

      // 5. Modify the file externally (simulate user edit)
      await new Promise((resolve) => setTimeout(resolve, 50)); // Ensure mtime changes
      const modifiedContent =
        "# Plan\n\n## Step 1\n\nModified plan content\n\n## Step 2\n\nNew step added";
      await writeFile(planPath, modifiedContent);

      // Update mtime to be clearly in the future
      const newMtime = Date.now() + 1000;
      await utimes(planPath, newMtime / 1000, newMtime / 1000);

      // 6. Set up stream collector and send a message
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      await collector.waitForSubscription();

      // Send a simple message to trigger LLM call
      const sendResult = await env.orpc.workspace.sendMessage({
        workspaceId,
        message: "Continue with the plan",
        options: {
          model: HAIKU_MODEL,
          agentId: "exec",
          thinkingLevel: "off",
        },
      });

      expect(sendResult.success).toBe(true);

      // Wait for stream to complete
      await collector.waitForEvent("stream-end", STREAM_TIMEOUT_LOCAL_MS);
      collector.stop();

      // 7. Check the debug log file for the injected message
      // The messages with file changes are logged to ~/.mux/debug_obj/${workspaceId}/2a_redacted_messages.json
      const debugObjDir = join(getXumHome(), "debug_obj", workspaceId);
      const debugFiles = await readdir(debugObjDir).catch(() => [] as string[]);

      // Find the redacted messages file
      const redactedFile = debugFiles.find((f) => f.includes("2a_redacted_messages"));
      expect(redactedFile).toBeDefined();

      if (redactedFile) {
        const redactedPath = join(debugObjDir, redactedFile);
        const content = await readFile(redactedPath, "utf-8");
        const messages = JSON.parse(content) as Array<{
          role: string;
          parts?: Array<{ type: string; text?: string }>;
          metadata?: { synthetic?: boolean };
        }>;

        // Find the synthetic file change message
        const fileChangeMessage = messages.find(
          (m) =>
            m.role === "user" &&
            m.metadata?.synthetic === true &&
            m.parts?.some((p) => p.type === "text" && p.text?.includes("<system-file-update>"))
        );

        expect(fileChangeMessage).toBeDefined();

        if (fileChangeMessage) {
          const textPart = fileChangeMessage.parts?.find((p) => p.type === "text");
          expect(textPart?.text).toContain("<system-file-update>");
          expect(textPart?.text).toContain("</system-file-update>");
          expect(textPart?.text).toContain("was modified");
          // Should contain the diff showing the changes
          expect(textPart?.text).toContain("Modified plan content");
          expect(textPart?.text).toContain("Step 2");
          expect(textPart?.text).toContain("New step added");
        }
      }
    } finally {
      // Cleanup workspace
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 60000);

  it("should not inject notification when tracked file is unchanged", async () => {
    // 1. Create a workspace
    const branchName = generateBranchName("file-unchanged-test");
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    expect(createResult.success).toBe(true);
    if (!createResult.success) throw new Error("Failed to create workspace");

    const workspaceId = createResult.metadata.id;
    const workspaceName = createResult.metadata.name;
    const projectName = createResult.metadata.projectName;

    try {
      // 2. Get the AgentSession and plan file path
      const session = env.services.workspaceService.getOrCreateSession(workspaceId);
      const planPath = getPlanFilePath(workspaceName, projectName);

      // 3. Create the plan directory and file
      const planDir = join(planPath, "..");
      await mkdir(planDir, { recursive: true });

      const originalContent = "# Plan\n\nUnchanged content";
      await writeFile(planPath, originalContent);

      // 4. Record the file state
      const { mtimeMs: originalMtime } = await stat(planPath);
      session.recordFileState(planPath, {
        content: originalContent,
        timestamp: originalMtime,
      });

      // 5. DO NOT modify the file - leave it unchanged

      // 6. Set up stream collector and send a message
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      await collector.waitForSubscription();

      // Send a simple message to trigger LLM call
      const sendResult = await env.orpc.workspace.sendMessage({
        workspaceId,
        message: "Hello",
        options: {
          model: HAIKU_MODEL,
          agentId: "exec",
          thinkingLevel: "off",
        },
      });

      expect(sendResult.success).toBe(true);

      // Wait for stream to complete
      await collector.waitForEvent("stream-end", STREAM_TIMEOUT_LOCAL_MS);
      collector.stop();

      // 7. Check the debug log file - should NOT have file change notification
      const debugObjDir = join(getXumHome(), "debug_obj", workspaceId);
      const debugFiles = await readdir(debugObjDir).catch(() => [] as string[]);

      const redactedFile = debugFiles.find((f) => f.includes("2a_redacted_messages"));
      expect(redactedFile).toBeDefined();

      if (redactedFile) {
        const redactedPath = join(debugObjDir, redactedFile);
        const content = await readFile(redactedPath, "utf-8");
        const messages = JSON.parse(content) as Array<{
          role: string;
          parts?: Array<{ type: string; text?: string }>;
          metadata?: { synthetic?: boolean };
        }>;

        // Should NOT find a file change message
        const fileChangeMessage = messages.find(
          (m) =>
            m.role === "user" &&
            m.metadata?.synthetic === true &&
            m.parts?.some((p) => p.type === "text" && p.text?.includes("<system-file-update>"))
        );

        expect(fileChangeMessage).toBeUndefined();
      }
    } finally {
      // Cleanup workspace
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 60000);
});
