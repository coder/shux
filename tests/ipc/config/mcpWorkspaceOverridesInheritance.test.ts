import * as path from "node:path";
import { shouldRunIntegrationTests, setupWorkspaceWithoutProvider } from "../setup";
import {
  createWorkspace,
  generateBranchName,
  HAIKU_MODEL,
  resolveOrpcClient,
  sendMessageWithModel,
} from "../helpers";
import type { TestEnvironment } from "../setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const MCP_SERVER_COMMAND = `node "${path.join(__dirname, "..", "fixtures", "mcp-screenshot-server.js")}"`;
const SERVER_NAME = "shots";

/**
 * Names of the MCP-derived tools the model would be offered, captured from the
 * assembled request. Mock mode bypasses TurnRequestBuilder, so instead the test
 * intercepts StreamManager.startStream (the request is fully built by then) and
 * aborts before any provider call happens.
 */
async function captureMcpToolSurface(
  env: TestEnvironment,
  workspaceId: string
): Promise<{ tools: string[]; deferred: string[] }> {
  const streamManager = env.services.streamManager as unknown as {
    startStream: (...args: unknown[]) => unknown;
  };
  const original = streamManager.startStream;
  let captured: unknown[] | undefined;
  streamManager.startStream = (...args: unknown[]) => {
    captured = args;
    throw new Error("request captured; no provider call");
  };
  try {
    await sendMessageWithModel(env, workspaceId, "hello", HAIKU_MODEL, {
      agentId: "exec",
      experiments: { toolSearch: true },
    });
  } finally {
    streamManager.startStream = original;
  }
  const request = captured?.find(
    (
      arg
    ): arg is {
      tools: Record<string, unknown>;
      toolSearchState?: { deferredToolNames: Set<string> };
    } => typeof arg === "object" && arg !== null && "tools" in arg
  );
  if (!request) throw new Error("startStream was not reached");
  return {
    tools: Object.keys(request.tools)
      .filter((name) => name.startsWith(`${SERVER_NAME}_`) || name === "tool_catalog_search")
      .sort(),
    deferred: [...(request.toolSearchState?.deferredToolNames ?? [])].sort(),
  };
}

describeIntegration("workspace MCP overrides in derived workspaces", () => {
  test("a globally disabled server enabled per-workspace reaches sub-agent children and forks", async () => {
    const { env, workspaceId, tempGitRepo, cleanup } =
      await setupWorkspaceWithoutProvider("mcp-inherit");
    // Any provider config lets the request build; startStream is intercepted before I/O.
    env.services.providersConfigStore.saveProvidersConfig({ anthropic: { apiKey: "dummy" } });
    const client = resolveOrpcClient(env);
    try {
      expect(
        (await client.mcp.add({ name: SERVER_NAME, command: MCP_SERVER_COMMAND })).success
      ).toBe(true);
      expect((await client.mcp.setEnabled({ name: SERVER_NAME, enabled: false })).success).toBe(
        true
      );
      expect(await captureMcpToolSurface(env, workspaceId)).toEqual({ tools: [], deferred: [] });

      const { revision } = await client.workspace.mcp.get({ workspaceId });
      expect(
        (
          await client.workspace.mcp.set({
            workspaceId,
            overrides: { enabledServers: [SERVER_NAME] },
            expectedRevision: revision,
          })
        ).success
      ).toBe(true);
      const expectedSurface = {
        tools: [`${SERVER_NAME}_take_screenshot`, "tool_catalog_search"],
        deferred: [`${SERVER_NAME}_take_screenshot`],
      };
      expect(await captureMcpToolSurface(env, workspaceId)).toEqual(expectedSurface);

      // Sub-agent child: a fresh checkout linked to the parent via parentWorkspaceId.
      const child = await createWorkspace(env, tempGitRepo, generateBranchName("mcp-child"));
      if (!child.success) throw new Error(child.error);
      await env.config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.metadata.id);
          if (entry) entry.parentWorkspaceId = workspaceId;
        }
        return cfg;
      });
      expect(
        (await client.workspace.mcp.get({ workspaceId: child.metadata.id })).overrides
      ).toEqual({
        enabledServers: [SERVER_NAME],
      });
      expect(await captureMcpToolSurface(env, child.metadata.id)).toEqual(expectedSurface);

      // Fork: independent workspace that snapshots the source's overrides.
      const fork = await client.workspace.fork({ sourceWorkspaceId: workspaceId });
      if (!fork.success) throw new Error(fork.error);
      expect((await client.workspace.mcp.get({ workspaceId: fork.metadata.id })).overrides).toEqual(
        {
          enabledServers: [SERVER_NAME],
        }
      );
      expect(await captureMcpToolSurface(env, fork.metadata.id)).toEqual(expectedSurface);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
