import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shouldRunIntegrationTests, setupWorkspaceWithoutProvider } from "../setup";
import { HAIKU_MODEL, readChatHistory, resolveOrpcClient, sendMessageWithModel } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const MCP_SERVER_COMMAND = `node "${path.join(__dirname, "..", "fixtures", "mcp-screenshot-server.js")}"`;

describeIntegration("MCP prompts", () => {
  test("lists and materializes prompts through workspace IPC", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("mcp-prompts");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      const addResult = await client.mcp.add({
        name: "prompt server",
        command: MCP_SERVER_COMMAND,
      });
      expect(addResult.success).toBe(true);

      const prompts = await client.workspace.mcp.prompts.list({ workspaceId });
      expect(prompts).toContainEqual({
        commandKey: "mcp__prompt_server__review",
        stableKey: expect.stringMatching(/^mcp__prompt_server__review_[0-9a-f]{8}$/),
        serverName: "prompt server",
        promptName: "review",
        description: "Build a deterministic review prompt for tests.",
        arguments: [
          { name: "path", description: "Path to review", required: true },
          { name: "focus", description: "Optional review focus", required: false },
        ],
      });
      // The fixture serves prompts/list one prompt per page; status lives on
      // page two, so its presence pins whole-catalog pagination.
      expect(prompts).toContainEqual({
        commandKey: "mcp__prompt_server__status",
        stableKey: expect.stringMatching(/^mcp__prompt_server__status_[0-9a-f]{8}$/),
        serverName: "prompt server",
        promptName: "status",
        description: "Build a no-argument status prompt for tests.",
      });

      const sendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Using MCP prompt prompt server/review: src security",
        HAIKU_MODEL,
        {
          agentId: "exec",
          muxMetadata: {
            type: "normal",
            rawCommand: "/mcp__prompt_server__review src security",
            commandPrefix: "/mcp__prompt_server__review",
            mcpPromptRefs: [
              {
                serverName: "prompt server",
                promptName: "review",
                commandKey: "mcp__prompt_server__review",
                source: "slash",
                arguments: { path: "src", focus: "security" },
              },
            ],
          },
        }
      );
      expect(sendResult.success).toBe(true);

      const history = await readChatHistory(env.tempDir, workspaceId);
      const snapshot = history.find((message) => {
        const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
        return metadata?.mcpPromptSnapshot !== undefined;
      });
      expect(snapshot?.parts.find((part) => part.type === "text")?.text).toBe(
        "Review src with focus on security"
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("aborting a send cancels an in-flight prompts/get", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("mcp-prompts-abort");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      const addResult = await client.mcp.add({
        name: "prompt server",
        command: MCP_SERVER_COMMAND,
      });
      expect(addResult.success).toBe(true);

      await client.workspace.mcp.prompts.list({ workspaceId });

      const controller = new AbortController();
      const promptPromise = env.services.mcpServerManager.getPrompt(
        workspaceId,
        "prompt server",
        "hang",
        {},
        { signal: controller.signal }
      );
      setTimeout(() => controller.abort(), 250);

      const startedAt = Date.now();
      let rejected = false;
      try {
        await promptPromise;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      // The bound distinguishes cancellation from the prompt timeout.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("rotated project secrets reach the prompt-invocation refresh", async () => {
    const { env, workspaceId, tempGitRepo, cleanup } =
      await setupWorkspaceWithoutProvider("mcp-prompts-secrets");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      const addResult = await client.mcp.add({
        name: "prompt server",
        command: MCP_SERVER_COMMAND,
      });
      expect(addResult.success).toBe(true);
      await client.secrets.update({
        projectPath: tempGitRepo,
        secrets: [{ key: "MCP_TOKEN", value: "old" }],
      });

      // Record workspace request options with the pre-rotation snapshot.
      await client.workspace.mcp.prompts.list({ workspaceId });

      await client.secrets.update({
        projectPath: tempGitRepo,
        secrets: [{ key: "MCP_TOKEN", value: "new" }],
      });

      const manager = env.services.mcpServerManager;
      const seenSecrets: Array<Record<string, string> | undefined> = [];
      // getPrompt refreshes through the private ensureWorkspaceServers seam
      // (it skips tool catalog refreshes), so observe secrets there.
      const access = manager as unknown as {
        ensureWorkspaceServers: (
          options: { projectSecrets?: Record<string, string> },
          refreshToolCatalogs: boolean
        ) => Promise<unknown>;
      };
      const realEnsure = access.ensureWorkspaceServers.bind(manager);
      const ensureSpy = jest
        .spyOn(access, "ensureWorkspaceServers")
        .mockImplementation((options, refreshToolCatalogs) => {
          seenSecrets.push(options.projectSecrets);
          return realEnsure(options, refreshToolCatalogs);
        });

      const prompt = await manager.getPrompt(workspaceId, "prompt server", "status", {});
      expect(prompt.text).toBe("Report workspace status");
      expect(seenSecrets[0]?.MCP_TOKEN).toBe("new");
      ensureSpy.mockRestore();
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("revoking project trust blocks cached repo-local prompt invocation", async () => {
    const { env, workspaceId, tempGitRepo, cleanup } =
      await setupWorkspaceWithoutProvider("mcp-prompts-trust");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      await fs.mkdir(path.join(tempGitRepo, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(tempGitRepo, ".mux", "mcp.jsonc"),
        JSON.stringify({ servers: { "repo server": { command: MCP_SERVER_COMMAND } } })
      );
      await client.projects.setTrust({ projectPath: tempGitRepo, trusted: true });

      const prompts = await client.workspace.mcp.prompts.list({ workspaceId });
      expect(prompts.some((prompt) => prompt.serverName === "repo server")).toBe(true);

      await client.projects.setTrust({ projectPath: tempGitRepo, trusted: false });

      let rejection: unknown;
      try {
        await env.services.mcpServerManager.getPrompt(workspaceId, "repo server", "status", {});
      } catch (error) {
        rejection = error;
      }
      expect(String(rejection)).toMatch(/disabled|not connected/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("lists prompts from a server without the tools capability", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("mcp-prompts-only");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      const addResult = await client.mcp.add({
        name: "prompt only",
        command: `${MCP_SERVER_COMMAND} --prompts-only`,
      });
      expect(addResult.success).toBe(true);

      const prompts = await client.workspace.mcp.prompts.list({ workspaceId });
      expect(prompts.map((prompt) => prompt.commandKey)).toEqual([
        "mcp__prompt_only__review",
        "mcp__prompt_only__status",
      ]);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
