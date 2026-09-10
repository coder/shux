import * as fs from "fs/promises";
import * as path from "path";
import {
  shouldRunIntegrationTests,
  cleanupTestEnvironment,
  createTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  resolveOrpcClient,
  trustProject,
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  extractTextFromEvents,
  HAIKU_MODEL,
} from "../helpers";
import type { StreamCollector } from "../streamCollector";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const CHROME_DEVTOOLS_MCP_VERSION = "0.12.1";
const CHROME_DEVTOOLS_MCP_NPX = `npx -y chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`;

const TEST_SCREENSHOT_MCP_SERVER_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "mcp-screenshot-server.js"
);
const TEST_SCREENSHOT_MCP_SERVER_COMMAND = `node "${TEST_SCREENSHOT_MCP_SERVER_PATH}"`;
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Shared types for MCP content parsing
type MediaItem = { type: "media"; data: string; mediaType: string };
type TextItem = { type: "text"; text: string };

function isMediaItem(item: unknown): item is MediaItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    (item as { type: string }).type === "media"
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorkspaceEvent = ReturnType<StreamCollector["getEvents"]>[number];
type ToolCallEndEvent = Extract<WorkspaceEvent, { type: "tool-call-end" }>;

async function waitForToolCallEnd(
  collector: StreamCollector,
  toolName: string,
  timeoutMs: number
): Promise<ToolCallEndEvent | undefined> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const toolCallEnds = collector
      .getEvents()
      .filter((e): e is ToolCallEndEvent => e.type === "tool-call-end");

    const match = toolCallEnds.find((e) => e.toolName === toolName);
    if (match) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return undefined;
}
function isTextItem(item: unknown): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    (item as { type: string }).type === "text"
  );
}

/**
 * Assert that a screenshot result has valid media content.
 * Verifies: proper structure, no omitted images, no base64 in text, valid mediaType.
 */
function assertValidScreenshotResult(
  result: unknown,
  allowedMediaTypes?: RegExp
): { mediaItems: MediaItem[]; textItems: TextItem[] } {
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();
  expect(result).toHaveProperty("type", "content");
  expect(result).toHaveProperty("value");

  const value = (result as { value: unknown[] }).value;
  expect(Array.isArray(value)).toBe(true);

  const mediaItems = value.filter(isMediaItem);
  const textItems = value.filter(isTextItem);

  // No "Image omitted" text
  const hasOmittedImageText = textItems.some((t) => t.text.includes("Image omitted"));
  expect(hasOmittedImageText).toBe(false);

  // Must have at least one media item
  expect(mediaItems.length).toBeGreaterThan(0);

  // Text parts must not contain base64 blobs (would indicate serialization as text)
  const longBase64Pattern = /[A-Za-z0-9+/]{10000,}/;
  for (const t of textItems) {
    expect(t.text.startsWith("data:image")).toBe(false);
    expect(longBase64Pattern.test(t.text)).toBe(false);
  }

  // Validate media items
  const typePattern = allowedMediaTypes ?? /^image\//;
  for (const media of mediaItems) {
    expect(media.mediaType).toBeDefined();
    expect(media.mediaType).toMatch(typePattern);
    expect(media.data).toBeDefined();
    expect(media.data.length).toBeGreaterThan(1000);
  }

  return { mediaItems, textItems };
}

describeIntegration("MCP global configuration", () => {
  test.concurrent("add, list, and remove MCP servers", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const client = resolveOrpcClient(env);

    const globalConfigPath = path.join(env.config.rootDir, "mcp.jsonc");

    try {
      // Register project (not required for global MCP config, but mirrors real usage)
      const createResult = await client.projects.create({ projectPath: repoPath });
      expect(createResult.success).toBe(true);

      // Initially empty (merged global + repo overrides)
      const initial = await client.mcp.list({ projectPath: repoPath });
      expect(initial).toEqual({});

      // Add server (writes to global <xumHome>/mcp.jsonc)
      const addResult = await client.mcp.add({
        name: "chrome-devtools",
        command: CHROME_DEVTOOLS_MCP_NPX,
      });
      expect(addResult.success).toBe(true);

      // Should list the added server
      const listed = await client.mcp.list({ projectPath: repoPath });
      expect(listed).toMatchObject({
        "chrome-devtools": {
          transport: "stdio",
          command: CHROME_DEVTOOLS_MCP_NPX,
          disabled: false,
        },
      });
      expect(Object.keys(listed)).toEqual(["chrome-devtools"]);

      // Global config file should be written
      const file = await fs.readFile(globalConfigPath, "utf-8");
      expect(JSON.parse(file)).toEqual({
        servers: { "chrome-devtools": CHROME_DEVTOOLS_MCP_NPX },
      });

      // Disable server
      const disableResult = await client.mcp.setEnabled({
        name: "chrome-devtools",
        enabled: false,
      });
      expect(disableResult.success).toBe(true);

      // Should still be listed but disabled
      const disabledList = await client.mcp.list({ projectPath: repoPath });
      expect(disabledList).toMatchObject({
        "chrome-devtools": {
          transport: "stdio",
          command: CHROME_DEVTOOLS_MCP_NPX,
          disabled: true,
        },
      });
      expect(Object.keys(disabledList)).toEqual(["chrome-devtools"]);

      // Config file should have disabled format
      const disabledConfig = await fs.readFile(globalConfigPath, "utf-8");
      expect(JSON.parse(disabledConfig)).toEqual({
        servers: {
          "chrome-devtools": { command: CHROME_DEVTOOLS_MCP_NPX, disabled: true },
        },
      });

      // Re-enable server
      const enableResult = await client.mcp.setEnabled({
        name: "chrome-devtools",
        enabled: true,
      });
      expect(enableResult.success).toBe(true);

      // Should be enabled again, config file back to string format
      const enabledList = await client.mcp.list({ projectPath: repoPath });
      expect(enabledList).toMatchObject({
        "chrome-devtools": {
          transport: "stdio",
          command: CHROME_DEVTOOLS_MCP_NPX,
          disabled: false,
        },
      });
      expect(Object.keys(enabledList)).toEqual(["chrome-devtools"]);

      const enabledConfig = await fs.readFile(globalConfigPath, "utf-8");
      expect(JSON.parse(enabledConfig)).toEqual({
        servers: { "chrome-devtools": CHROME_DEVTOOLS_MCP_NPX },
      });

      // Remove server
      const removeResult = await client.mcp.remove({ name: "chrome-devtools" });
      expect(removeResult.success).toBe(true);

      const finalList = await client.mcp.list({ projectPath: repoPath });
      expect(finalList).toEqual({});
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  });

  test.concurrent(
    "untrusted projects ignore repo .mux/mcp.jsonc but keep global MCP config",
    async () => {
      const env = await createTestEnvironment();
      const repoPath = await createTempGitRepo();
      const client = resolveOrpcClient(env);

      try {
        const globalCommand = "echo global";
        const repoOnlyCommand = "echo repo-only";

        const addResult = await client.mcp.add({ name: "chrome-devtools", command: globalCommand });
        expect(addResult.success).toBe(true);

        const overridePath = path.join(repoPath, ".mux", "mcp.jsonc");
        await fs.mkdir(path.dirname(overridePath), { recursive: true });
        await fs.writeFile(
          overridePath,
          JSON.stringify(
            {
              servers: {
                "repo-only": repoOnlyCommand,
              },
            },
            null,
            2
          ),
          "utf-8"
        );

        expect(await client.mcp.list({ projectPath: repoPath })).toEqual({
          "chrome-devtools": {
            transport: "stdio",
            command: globalCommand,
            disabled: false,
          },
        });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      }
    }
  );

  test.concurrent("repo .mux/mcp.jsonc overrides global servers by name", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const client = resolveOrpcClient(env);

    try {
      const globalCommand = "echo global";
      const overrideCommand = "echo override";
      const repoOnlyCommand = "echo repo-only";

      const addResult = await client.mcp.add({ name: "chrome-devtools", command: globalCommand });
      expect(addResult.success).toBe(true);

      const overridePath = path.join(repoPath, ".mux", "mcp.jsonc");
      await fs.mkdir(path.dirname(overridePath), { recursive: true });
      await fs.writeFile(
        overridePath,
        JSON.stringify(
          {
            servers: {
              "chrome-devtools": overrideCommand,
              "repo-only": repoOnlyCommand,
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      await trustProject(env, repoPath);

      const merged = await client.mcp.list({ projectPath: repoPath });
      expect(merged).toMatchObject({
        "chrome-devtools": {
          transport: "stdio",
          command: overrideCommand,
          disabled: false,
        },
        "repo-only": {
          transport: "stdio",
          command: repoOnlyCommand,
          disabled: false,
        },
      });
      expect(Object.keys(merged).sort()).toEqual(["chrome-devtools", "repo-only"].sort());

      const globalList = await client.mcp.list({});
      expect(globalList).toMatchObject({
        "chrome-devtools": {
          transport: "stdio",
          command: globalCommand,
          disabled: false,
        },
      });
      expect(Object.keys(globalList)).toEqual(["chrome-devtools"]);
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  });
});

describeIntegration("MCP server integration with model", () => {
  // Test matrix for image format handling
  const imageFormatCases = [
    {
      name: "PNG",
      prompt: "Call chrome_take_screenshot to capture a screenshot.",
      mediaTypePattern: /^image\//,
    },
    {
      name: "JPEG",
      prompt: 'Call chrome_take_screenshot with format "jpeg" to capture a screenshot.',
      mediaTypePattern: /^image\/(jpeg|jpg|webp)$/,
    },
  ] as const;

  test.each(imageFormatCases)(
    "MCP $name image content is correctly transformed to AI SDK format",
    async ({ name, prompt, mediaTypePattern }) => {
      const {
        env,
        workspaceId,
        tempGitRepo: _tempGitRepo,
        cleanup,
      } = await setupWorkspace("anthropic", `mcp-chrome-${name.toLowerCase()}`);
      const client = resolveOrpcClient(env);
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();

      try {
        // Add Chrome DevTools MCP server (headless + no-sandbox for CI)
        const addResult = await client.mcp.add({
          name: "chrome",
          command: TEST_SCREENSHOT_MCP_SERVER_COMMAND,
        });
        expect(addResult.success).toBe(true);

        await collector.waitForSubscription();

        const result = await sendMessageWithModel(env, workspaceId, prompt, HAIKU_MODEL, {
          toolPolicy: [{ regex_match: "chrome_take_screenshot", action: "require" }],
          thinkingLevel: "off",
          agentId: "exec",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 120000);
        assertStreamSuccess(collector);

        // Find screenshot tool result.
        //
        // NOTE: tool-call-end can occasionally arrive *after* stream-end, so poll briefly.
        const screenshotResult = await waitForToolCallEnd(
          collector,
          "chrome_take_screenshot",
          60000
        );

        // Debug: log tool calls if screenshot not found
        if (!screenshotResult) {
          collector.logEventDiagnostics(
            `[MCP ${name} Test] Missing chrome_take_screenshot tool-call-end`
          );
          const toolCallEnds = collector
            .getEvents()
            .filter((e): e is ToolCallEndEvent => e.type === "tool-call-end");
          const toolNames = toolCallEnds.map((e) => e.toolName);
          const deltas = collector.getDeltas();
          const responseText = extractTextFromEvents(deltas);
          console.log(`[MCP ${name} Test] Tool calls made:`, toolNames);
          console.log(`[MCP ${name} Test] Model response:`, responseText.slice(0, 500));
        }
        expect(screenshotResult).toBeDefined();

        // Validate result structure and media content
        assertValidScreenshotResult(screenshotResult!.result, mediaTypePattern);
      } finally {
        collector.stop();
        await cleanup();
      }
    },
    180000
  );

  test.concurrent(
    "MCP tools are available to the model",
    async () => {
      console.log("[MCP Test] Setting up workspace...");
      // Setup workspace with Anthropic provider
      const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(
        "anthropic",
        "mcp-memory"
      );
      const client = resolveOrpcClient(env);
      console.log("[MCP Test] Workspace created:", { workspaceId, tempGitRepo });

      try {
        // Add the memory MCP server to the project
        console.log("[MCP Test] Adding MCP server...");
        const addResult = await client.mcp.add({
          name: "memory server",
          command: "npx -y @modelcontextprotocol/server-memory",
        });
        expect(addResult.success).toBe(true);
        console.log("[MCP Test] MCP server added");

        // Create stream collector to capture events
        console.log("[MCP Test] Creating stream collector...");
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription();
        console.log("[MCP Test] Stream collector ready");

        // Send a message that should trigger the memory tool
        // The memory server provides: create_entities, create_relations, read_graph, etc.
        console.log("[MCP Test] Sending message...");
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          'Use the create_entities tool from MCP to create an entity with name "TestEntity" and entityType "test" and observations ["integration test"]. Then confirm you did it.',
          HAIKU_MODEL
        );
        console.log("[MCP Test] Message sent, result:", result.success);

        expect(result.success).toBe(true);

        // Wait for stream to complete
        console.log("[MCP Test] Waiting for stream-end...");
        await collector.waitForEvent("stream-end", 60000);
        console.log("[MCP Test] Stream ended");
        assertStreamSuccess(collector);

        // Verify MCP tool was called
        const events = collector.getEvents();
        const toolCallStarts = events.filter(
          (e): e is Extract<typeof e, { type: "tool-call-start" }> => e.type === "tool-call-start"
        );
        console.log(
          "[MCP Test] Tool calls:",
          toolCallStarts.map((e) => e.toolName)
        );

        // Should have at least one tool call
        expect(toolCallStarts.length).toBeGreaterThan(0);

        // Should have called the MCP memory tool (namespaced as memory_server_create_entities)
        const mcpToolCall = toolCallStarts.find(
          (e) => e.toolName === "memory_server_create_entities"
        );
        expect(mcpToolCall).toBeDefined();

        // Verify response mentions the entity was created
        const deltas = collector.getDeltas();
        const responseText = extractTextFromEvents(deltas).toLowerCase();
        expect(responseText).toMatch(/entity|created|testentity/i);

        collector.stop();
      } finally {
        console.log("[MCP Test] Cleaning up...");
        await cleanup();
        console.log("[MCP Test] Done");
      }
    },
    90000
  ); // MCP server startup + tool call can take time
});
