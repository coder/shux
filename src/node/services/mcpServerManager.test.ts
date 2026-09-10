import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer } from "http";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  MCP_PROMPT_MAX_ARGUMENTS,
  MCP_PROMPT_MAX_DESCRIPTION_CHARS,
  MCP_PROMPT_MAX_TEXT_BYTES,
  MCP_PROMPT_TRUNCATION_MARKER,
} from "@/common/constants/toolLimits";
import { MUTATION_EPOCH_UNREADABLE_TOKEN } from "@/node/services/agentPlugins/journals";
import * as mcpSdk from "@/node/services/mcpClient";
import {
  MCPServerManager,
  MCPToolCallError,
  flattenMcpPrompt,
  isClosedClientError,
  prepareStdioLaunch,
  runMCPToolWithDeadline,
  wrapMCPTools,
} from "./mcpServerManager";
import { MCPConfigService } from "./mcpConfigService";
import { Config } from "@/node/config";
import type { TelemetryService } from "./telemetryService";
import type { Runtime } from "@/node/runtime/Runtime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { Tool } from "ai";

interface MCPServerManagerTestAccess {
  workspaceServers: Map<string, unknown>;
  lastWorkspaceRequestOptions: Map<string, unknown>;
  cleanupIdleServers: () => void;
  ensureWorkspaceServers: (
    ...args: unknown[]
  ) => Promise<{ tools: Record<string, Tool>; stats: unknown }>;
  startServers: (...args: unknown[]) => Promise<{
    instances: Map<string, unknown>;
    failedServerNames: string[];
    timedOutServerNames?: string[];
  }>;
  startSingleServer: (...args: unknown[]) => Promise<unknown>;
  startSingleServerImpl: (...args: unknown[]) => Promise<unknown>;
}

const PROJECT_PATH = "/tmp/project";
const WORKSPACE_PATH = "/tmp/workspace";
// Tests use only Runtime identity for workspace request plumbing.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const TEST_RUNTIME = {} as Runtime;

function workspaceRequest(workspaceId: string, options: Record<string, unknown> = {}) {
  return {
    workspaceId,
    projectPath: PROJECT_PATH,
    runtime: TEST_RUNTIME,
    workspacePath: WORKSPACE_PATH,
    ...options,
  };
}

function stdioConfig(command: string, disabled = false) {
  return { transport: "stdio" as const, command, disabled };
}

function testTool(result: unknown = { ok: true }): Tool {
  return { execute: mock(() => Promise.resolve(result)) } as unknown as Tool;
}

function testInstance(
  name: string,
  options: {
    tools?: Record<string, Tool>;
    prompts?: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>;
    getPrompt?: ReturnType<typeof mock>;
    refreshTools?: ReturnType<typeof mock>;
    refreshPrompts?: ReturnType<typeof mock>;
    close?: ReturnType<typeof mock>;
    isClosed?: boolean;
  } = {}
) {
  return {
    name,
    resolvedTransport: "stdio" as const,
    autoFallbackUsed: false,
    tools: options.tools ?? {},
    prompts: options.prompts ?? [],
    getPrompt: options.getPrompt ?? mock(() => Promise.resolve({ messages: [] })),
    ...(options.refreshTools !== undefined ? { refreshTools: options.refreshTools } : {}),
    // Prompt fixtures need a refresher because production stores catalogs
    // only through refreshInstancePrompts.
    ...(options.refreshPrompts !== undefined
      ? { refreshPrompts: options.refreshPrompts }
      : options.prompts !== undefined
        ? { refreshPrompts: mock(() => Promise.resolve(options.prompts)) }
        : {}),
    isClosed: options.isClosed ?? false,
    close: options.close ?? mock(() => Promise.resolve(undefined)),
  };
}

function startResult(
  entries: Array<[string, Parameters<typeof testInstance>[1]?]>,
  options: { failedServerNames?: string[]; timedOutServerNames?: string[] } = {}
) {
  return {
    instances: new Map(
      entries.map(([name, instanceOptions]) => [name, testInstance(name, instanceOptions)])
    ),
    failedServerNames: options.failedServerNames ?? [],
    timedOutServerNames: options.timedOutServerNames ?? [],
  };
}

function cachedStats(overrides: Record<string, unknown> = {}) {
  return {
    enabledServerCount: 1,
    startedServerCount: 0,
    failedServerCount: 1,
    autoFallbackCount: 0,
    failedServerNames: ["slow"],
    hasStdio: false,
    hasHttp: false,
    hasSse: false,
    transportMode: "none" as const,
    ...overrides,
  };
}

describe("MCPServerManager", () => {
  let configService: {
    listServers: ReturnType<typeof mock>;
    configGeneration: number;
  };

  let manager: MCPServerManager;
  let access: MCPServerManagerTestAccess;

  beforeEach(() => {
    configService = {
      listServers: mock(() => Promise.resolve({})),
      configGeneration: 0,
    };

    manager = new MCPServerManager(configService as unknown as MCPConfigService);
    access = manager as unknown as MCPServerManagerTestAccess;
  });

  afterEach(() => {
    manager.dispose();
  });
  test("testForApi resolves global defaults and emits categorized telemetry", async () => {
    using tmp = new DisposableTempDir("mcp-api-test");
    const config = new Config(tmp.path);
    const captured: Array<Parameters<TelemetryService["capture"]>[0]> = [];
    const capture = mock((payload: Parameters<TelemetryService["capture"]>[0]) => {
      captured.push(payload);
    });
    const apiManager = new MCPServerManager(new MCPConfigService(config), {
      config,
      telemetryService: { capture },
    });
    const testServer = spyOn(apiManager, "test").mockResolvedValue({
      success: false,
      error: "ECONNREFUSED",
    });
    try {
      await apiManager.testForApi({ command: "node server.js" });
      expect(testServer).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: tmp.path, trusted: false, projectSecrets: {} })
      );
      expect(captured[0]).toMatchObject({
        event: "mcp_server_tested",
        properties: { error_category: "connect", transport: "stdio" },
      });
    } finally {
      apiManager.dispose();
    }
  });

  test("testForApi resolves project trust from config before delegating", async () => {
    for (const trusted of [true, false]) {
      using tmp = new DisposableTempDir(`mcp-api-trust-${trusted}`);
      const config = new Config(tmp.path);
      const projectPath = path.join(tmp.path, "project");
      await fs.mkdir(projectPath, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, { trusted, workspaces: [] });
        return cfg;
      });
      const apiConfigService = new MCPConfigService(config);
      const listServers = spyOn(apiConfigService, "listServers").mockResolvedValue({
        "repo-local": { transport: "stdio", command: "echo repo-local", disabled: false },
      });
      const apiManager = new MCPServerManager(apiConfigService, { config });
      const testServer = spyOn(apiManager, "test").mockResolvedValue({
        success: true,
        tools: ["repo_tool"],
      });
      try {
        const result = await apiManager.testForApi(
          { projectPath, name: "repo-local" },
          { includeAgentPlugins: false }
        );
        expect(result).toMatchObject({ success: true, tools: ["repo_tool"] });
        expect(listServers).toHaveBeenCalledWith(projectPath, trusted, expect.anything());
        expect(testServer).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath, trusted, name: "repo-local" })
        );
      } finally {
        apiManager.dispose();
      }
    }
  });

  test("cross-process plugin mutation token retires cached plugin instances before serving", async () => {
    // A sibling process's update/uninstall recycles only its OWN manager;
    // this manager must notice the bumped on-disk mutation token and retire
    // matching cached instances instead of serving stale-tree servers forever.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-cross-process";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    const close = mock(() => Promise.resolve(undefined));
    access.startServers = () =>
      Promise.resolve(startResult([[pluginKey, { tools: { echo: testTool() }, close }]]));

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(1);

    // Unchanged token: the cached instance is served untouched.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(close).toHaveBeenCalledTimes(0);

    // The sibling's mutation bumps the token: retire and restart.
    token = "epoch-2";
    const close2 = mock(() => Promise.resolve(undefined));
    access.startServers = () =>
      Promise.resolve(startResult([[pluginKey, { tools: { echo: testTool() }, close: close2 }]]));
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(third.tools)).toHaveLength(1);
    expect(close2).toHaveBeenCalledTimes(0);
  });

  test("a mutation landing during startup is caught by the post-publication token recheck", async () => {
    // A sibling mutation beginning AFTER the preflight token read is
    // invisible to the in-process epoch and to the installer's discovery
    // bracket; the serve must re-read the token after publication, retire the
    // just-published stale instance, and rebuild from the new tree. The
    // sweep also clears the cross-process-stale override cache.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-startup-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // Seed the token on a DIFFERENT workspace (first serve only records it),
    // so the raced serve below takes the full startup path.
    access.startServers = () => Promise.resolve(startResult([]));
    await manager.getToolsForWorkspace(workspaceRequest("ws-token-seed"));

    // Seed a stale cached override entry a sibling's prune cannot reach.
    await manager.applyWorkspaceOverrides(workspaceId, { enabledServers: [pluginKey] });

    // Serve the raced workspace: the mutation lands DURING startup —
    // startServers flips the token as a side effect, after the preflight
    // already read the old value.
    const close = mock(() => Promise.resolve(undefined));
    const close2 = mock(() => Promise.resolve(undefined));
    let starts = 0;
    access.startServers = () => {
      starts += 1;
      if (starts === 1) {
        token = "epoch-2"; // Sibling mutation mid-startup.
        return Promise.resolve(startResult([[pluginKey, { tools: { echo: testTool() }, close }]]));
      }
      return Promise.resolve(
        startResult([[pluginKey, { tools: { echo: testTool() }, close: close2 }]])
      );
    };
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // The stale-tree instance was retired post-publication; the rebuild's
    // instance (new tree) is served.
    expect(close).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(0);
    expect(starts).toBe(2);
    expect(Object.keys(result.tools)).toHaveLength(1);
    // With no disk reader wired, the sweep scrubs plugin keys from the
    // cross-process-stale cache while preserving unrelated override state.
    expect(
      (
        access as unknown as { latestWorkspaceOverrides: Map<string, unknown> }
      ).latestWorkspaceOverrides.get(workspaceId)
    ).toEqual({ enabledServers: [] });
  });

  test("concurrent serves await an in-flight cross-process sweep before returning", async () => {
    // The observed token must publish only AFTER the sweep completes: a
    // concurrent serve that merely compared the token could otherwise return
    // an instance the sweep has not yet retired.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-sweep-order";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // First serve: cache an instance whose close is GATED, so the sweep
    // triggered by the token bump blocks mid-retire.
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = mock(() => closeGate);
    access.startServers = () =>
      Promise.resolve(startResult([[pluginKey, { tools: { echo: testTool() }, close }]]));
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    token = "epoch-2";
    const restarted = mock(() => Promise.resolve(undefined));
    access.startServers = () =>
      Promise.resolve(
        startResult([[pluginKey, { tools: { echo: testTool() }, close: restarted }]])
      );
    let firstDone = false;
    let secondDone = false;
    const first = manager.getToolsForWorkspace(workspaceRequest(workspaceId)).then((result) => {
      firstDone = true;
      return result;
    });
    const second = manager.getToolsForWorkspace(workspaceRequest(workspaceId)).then((result) => {
      secondDone = true;
      return result;
    });
    // Both serves are queued behind the gated sweep: neither may resolve.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(close).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    releaseClose();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // Neither serve returned the stale instance; both see the restarted tree.
    expect(Object.keys(firstResult.tools)).toHaveLength(1);
    expect(Object.keys(secondResult.tools)).toHaveLength(1);
    expect(restarted).toHaveBeenCalledTimes(0);
  });

  test("serves loop until a startup is bracketed by an unchanged mutation token", async () => {
    // A single post-publication rebuild is not enough: a second sibling
    // mutation starting after the rebuild's preflight would let the rebuild
    // publish an instance from ITS replaced tree and serve it indefinitely.
    // The serve must repeat until one startup sees the same token on both
    // sides.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-token-loop";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // Seed the token on a different workspace (first serve only records it).
    access.startServers = () => Promise.resolve(startResult([]));
    await manager.getToolsForWorkspace(workspaceRequest("ws-token-seed"));

    // Two consecutive startups each race a fresh sibling mutation; the third
    // runs clean.
    const closes = [
      mock(() => Promise.resolve(undefined)),
      mock(() => Promise.resolve(undefined)),
      mock(() => Promise.resolve(undefined)),
    ];
    let starts = 0;
    access.startServers = () => {
      starts += 1;
      if (starts <= 2) {
        token = `epoch-${starts + 1}`; // Sibling mutation mid-startup.
      }
      return Promise.resolve(
        startResult([[pluginKey, { tools: { echo: testTool() }, close: closes[starts - 1] }]])
      );
    };
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Both raced instances were retired; only the bracketed third serve's
    // instance survives.
    expect(starts).toBe(3);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(closes[2]).toHaveBeenCalledTimes(0);
    expect(Object.keys(result.tools)).toHaveLength(1);
  });

  test("prompt listing retries when a plugin mutation lands during startup", async () => {
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-prompt-list-token-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    access.startServers = () => Promise.resolve(startResult([]));
    await manager.getToolsForWorkspace(workspaceRequest("ws-prompt-token-seed"));

    const staleClose = mock(() => Promise.resolve(undefined));
    const freshClose = mock(() => Promise.resolve(undefined));
    let starts = 0;
    access.startServers = () => {
      starts += 1;
      if (starts === 1) {
        token = "epoch-2";
      }
      return Promise.resolve(
        startResult([
          [
            pluginKey,
            {
              prompts: [{ name: "review", description: starts === 1 ? "stale" : "fresh" }],
              close: starts === 1 ? staleClose : freshClose,
            },
          ],
        ])
      );
    };

    const prompts = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(starts).toBe(2);
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(freshClose).toHaveBeenCalledTimes(0);
    const review = prompts.find((prompt) => prompt.promptName === "review");
    expect(review?.description).toBe("fresh");
  });

  test("prompt invocation retries when a plugin mutation lands during prompts/get", async () => {
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-prompt-get-token-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    const staleClose = mock(() => Promise.resolve(undefined));
    const freshClose = mock(() => Promise.resolve(undefined));
    const staleGetPrompt = mock(() => {
      token = "epoch-2";
      return Promise.resolve({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "stale" } }],
      });
    });
    const freshGetPrompt = mock(() =>
      Promise.resolve({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "fresh" } }],
      })
    );
    let starts = 0;
    access.startServers = () => {
      starts += 1;
      return Promise.resolve(
        startResult([
          [
            pluginKey,
            {
              getPrompt: starts === 1 ? staleGetPrompt : freshGetPrompt,
              close: starts === 1 ? staleClose : freshClose,
            },
          ],
        ])
      );
    };

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const prompt = await manager.getPrompt(workspaceId, pluginKey, "review", {});
    expect(prompt.text).toBe("fresh");
    expect(staleGetPrompt).toHaveBeenCalledTimes(1);
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(freshGetPrompt).toHaveBeenCalledTimes(1);
    expect(freshClose).toHaveBeenCalledTimes(0);
  });

  test("an unreadable mutation epoch fails closed only for plugin servers", async () => {
    // Unreadability is a STABLE state: transition into it sweeps once and
    // suppresses plugin configs, while unrelated MCP servers remain usable.
    // Repeated serves cannot exhaust the mutation bracket, and transition
    // back to a readable epoch enables plugins again.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-unreadable-epoch";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: {
          ...stdioConfig("node plugin.js"),
          plugin: {
            pluginName: "demo",
            serverName: "echo",
            sourceScope: "global" as const,
            sourceLocation: ".xum/plugins/demo",
          },
        },
        regular: stdioConfig("node regular.js"),
      })
    );
    const pluginClose = mock(() => Promise.resolve(undefined));
    access.startServers = (...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(
          Object.keys(servers).map((name) => [
            name,
            {
              tools: { echo: testTool() },
              close: name === pluginKey ? pluginClose : mock(() => Promise.resolve(undefined)),
            },
          ])
        )
      );
    };

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(2);

    token = MUTATION_EPOCH_UNREADABLE_TOKEN;
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(pluginClose).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.tools)).toHaveLength(1);

    // Stable unreadability: no repeated sweep or retry exhaustion.
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(pluginClose).toHaveBeenCalledTimes(1);
    expect(Object.keys(third.tools)).toHaveLength(1);

    token = "epoch-2";
    const recovered = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(recovered.tools)).toHaveLength(2);
  });

  test("cross-process sweep refreshes cached override snapshots from disk", async () => {
    // A sibling's uninstall prunes plugin keys from workspace override FILES.
    // Cached copies — the per-call overlay cache AND recorded request options
    // (which getPrompt()'s refresh reuses) — must converge to disk, or a
    // pre-prune enable would restart a same-name reinstall's server without
    // new consent.
    manager.dispose();
    let token = "epoch-1";
    let diskOverrides: Record<string, unknown> = { enabledServers: ["plugin:abc123:echo"] };
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-disk-refresh";
    const pluginKey = "plugin:abc123:echo";
    // Project-level disabled: only the workspace override enables the server.
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    const close = mock(() => Promise.resolve(undefined));
    // Start only what enablement actually requested: the pruned second serve
    // must derive an EMPTY start set, not merely discard a started instance.
    access.startServers = (...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        pluginKey in servers
          ? startResult([[pluginKey, { tools: { echo: testTool() }, close }]])
          : startResult([])
      );
    };

    // First serve: the caller's snapshot enables the plugin server.
    const staleCallerOptions = workspaceRequest(workspaceId, {
      overrides: { enabledServers: [pluginKey] },
    });
    const first = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(Object.keys(first.tools)).toHaveLength(1);

    // Sibling uninstall: the override file is pruned on disk, then the epoch
    // bumps.
    diskOverrides = {};
    token = "epoch-2";

    // Same STALE caller snapshot: the preflight sweep must reload disk state
    // before the overlay captures this call's overrides, so the pruned
    // (empty) overrides win and no replacement server starts.
    const second = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.tools)).toHaveLength(0);

    // Both caches converged to disk: getPrompt()'s refresh (recorded
    // options) can no longer resurrect the pre-prune enable.
    const internals = access as unknown as {
      latestWorkspaceOverrides: Map<string, unknown>;
      lastWorkspaceRequestOptions: Map<string, { overrides?: unknown }>;
    };
    expect(internals.latestWorkspaceOverrides.get(workspaceId)).toEqual({});
    expect(internals.lastWorkspaceRequestOptions.get(workspaceId)?.overrides).toEqual({});
  });

  test("a cold workspace's first serve loads disk overrides instead of trusting the caller snapshot", async () => {
    // Two processes, one home: the caller read its snapshot BEFORE a sibling
    // uninstall + same-name reinstall pruned the enable from the override
    // file. This manager never served the workspace (no cached snapshot for
    // the sweep to refresh) and its first token observation records the
    // already-advanced epoch, so the bracket sees nothing to retire — disk
    // must win on the first serve, or the stale enable overrides the
    // replacement server's default-disabled state.
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-post-mutation"),
        readWorkspaceOverrides: () => Promise.resolve({}), // pruned on disk
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    let startedPluginServer = false;
    access.startServers = (...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      if (pluginKey in servers) {
        startedPluginServer = true;
      }
      return Promise.resolve(startResult([]));
    };

    const staleCallerOptions = workspaceRequest("ws-cold-first-serve", {
      overrides: { enabledServers: [pluginKey] },
    });
    const result = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(startedPluginServer).toBe(false);
    expect(Object.keys(result.tools)).toHaveLength(0);
  });

  test("a settings save landing during the first-serve disk read wins over the read result", async () => {
    // The first serve's disk read races a successful MCP settings save: the
    // save persists to disk, then publishes into the override cache — but a
    // read started BEFORE the save can resolve with the older state
    // afterwards. The continuation must recheck the cache: recording the
    // stale read would expose a just-disabled server for this send, and the
    // save's repair path only patches recorded options, which do not exist
    // yet on a first serve.
    manager.dispose();
    let readStarted: () => void = () => undefined;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let resolveRead: (value: Record<string, unknown>) => void = () => undefined;
    const pendingRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveRead = resolve;
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => {
          readStarted();
          return pendingRead;
        },
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;

    const workspaceId = "ws-first-serve-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    let startedPluginServer = false;
    access.startServers = (...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      if (pluginKey in servers) {
        startedPluginServer = true;
      }
      return Promise.resolve(startResult([]));
    };

    const serve = manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { enabledServers: [pluginKey] } })
    );
    // Deterministic interleaving: the serve is parked on the disk read when
    // the save publishes, then the read resolves with the pre-save state.
    await readStartedPromise;
    await manager.applyWorkspaceOverrides(workspaceId, {});
    resolveRead({ enabledServers: [pluginKey] });

    const result = await serve;
    expect(startedPluginServer).toBe(false);
    expect(Object.keys(result.tools)).toHaveLength(0);
    const internals = access as unknown as {
      lastWorkspaceRequestOptions: Map<string, { overrides?: unknown }>;
    };
    expect(internals.lastWorkspaceRequestOptions.get(workspaceId)?.overrides).toEqual({});
  });

  test("stopServersWithKeyPrefix invalidates instances published by an in-flight startup, then retries them", async () => {
    const workspaceId = "ws-swap-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // Block startServers mid-flight so a plugin swap can land while the
    // instance exists but is not yet published in workspaceServers.
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const close = mock(() => Promise.resolve(undefined));
    access.startServers = async () => {
      await startupGate;
      return startResult([[pluginKey, { close }]]);
    };

    const toolsPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Give getToolsForWorkspace time to enter the (gated) startServers call.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The updater's recycle runs while startup is in flight: the scan sees
    // nothing (not yet published), so the epoch record must catch it.
    await manager.stopServersWithKeyPrefix("plugin:abc123:");

    releaseStartup();
    const result = await toolsPromise;

    // The stale instance was closed instead of published.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    const entry = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, unknown>;
      timedOutServerNames: string[];
    };
    expect(entry.instances.size).toBe(0);

    // The entry was published under the UNCHANGED config signature, so the
    // next call hits the cached path — the removed server must carry a retry
    // marker there, or the updated plugin's tools stay unavailable forever.
    expect(entry.timedOutServerNames).toContain(pluginKey);
    const echoTool = testTool();
    const close2 = mock(() => Promise.resolve(undefined));
    access.startServers = () =>
      Promise.resolve(startResult([[pluginKey, { tools: { echo: echoTool }, close: close2 }]]));

    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Restarted from the (new) tree via the retry path — not served from the
    // reduced cached map, and not torn down again.
    expect(close2).toHaveBeenCalledTimes(0);
    expect(Object.keys(second.tools)).toHaveLength(1);
    const secondEntry = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, unknown>;
      timedOutServerNames: string[];
    };
    expect(secondEntry.instances.size).toBe(1);
    expect(secondEntry.timedOutServerNames).toEqual([]);
  });

  test("invalidation landing between the final epoch scan and cache publication never publishes the stale instance", async () => {
    const workspaceId = "ws-publish-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // The invalidation scan iterates the instances map ([...instances]), so a
    // one-shot iterator hook that QUEUES a microtask runs stopServersWithKeyPrefix
    // strictly after that scan's checks but before the awaiting continuation
    // publishes: the stop's epoch record lands after the scan read it, and its
    // own published-map scan runs before workspaceServers.set — the exact
    // window where both mechanisms used to miss.
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    const instances = new Map<string, unknown>([[pluginKey, testInstance(pluginKey, { close })]]);
    let armed = true;
    const originalIterator = instances[Symbol.iterator].bind(instances);
    instances[Symbol.iterator] = () => {
      if (armed) {
        armed = false;
        queueMicrotask(() => {
          stopPromise = manager.stopServersWithKeyPrefix("plugin:abc123:");
        });
      }
      return originalIterator();
    };

    access.startServers = () =>
      Promise.resolve({ instances, failedServerNames: [], timedOutServerNames: [] });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // The stale-tree instance was closed, never published, and carries a
    // retry marker so the next call restarts it from the new tree.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    const entry = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, unknown>;
      timedOutServerNames: string[];
    };
    expect(entry.instances.size).toBe(0);
    expect(entry.timedOutServerNames).toContain(pluginKey);

    const echoTool = testTool();
    access.startServers = () =>
      Promise.resolve(startResult([[pluginKey, { tools: { echo: echoTool } }]]));
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(second.tools)).toHaveLength(1);
  });

  test("workspace removal landing during the invalidation scan never publishes the started servers", async () => {
    const workspaceId = "ws-removal-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // Same one-shot iterator hook as the invalidation race above, but the
    // queued call is a removal-style stopServers(workspaceId): it bumps the
    // stop epoch AFTER the pre-publication epoch check ran and finds no cache
    // entry to close (publication hasn't happened) — publishing anyway would
    // resurrect MCP processes for a removed workspace until idle cleanup.
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    const instances = new Map<string, unknown>([[pluginKey, testInstance(pluginKey, { close })]]);
    let armed = true;
    const originalIterator = instances[Symbol.iterator].bind(instances);
    instances[Symbol.iterator] = () => {
      if (armed) {
        armed = false;
        queueMicrotask(() => {
          stopPromise = manager.stopServers(workspaceId);
        });
      }
      return originalIterator();
    };

    access.startServers = () =>
      Promise.resolve({ instances, failedServerNames: [], timedOutServerNames: [] });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // Publication was skipped and the late clients were closed.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    expect(access.workspaceServers.has(workspaceId)).toBe(false);
  });

  test("workspace removal landing during a timed-out retry never merges into the detached entry", async () => {
    const workspaceId = "ws-retry-removal-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // First call: the server times out, so the cached entry carries a retry
    // marker and no live instance.
    access.startServers = () =>
      Promise.resolve({
        instances: new Map(),
        failedServerNames: [],
        timedOutServerNames: [pluginKey],
      });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(access.workspaceServers.has(workspaceId)).toBe(true);

    // Second call retries the timed-out server. The one-shot iterator hook
    // queues a removal-style stopServers(workspaceId) during the retry's
    // invalidation scan: it deletes the cache entry, so the merge callback
    // must NOT attach these clients to the detached entry (they would have
    // no owner to ever clean them up).
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    const retried = new Map<string, unknown>([[pluginKey, testInstance(pluginKey, { close })]]);
    let armed = true;
    const originalIterator = retried[Symbol.iterator].bind(retried);
    retried[Symbol.iterator] = () => {
      if (armed) {
        armed = false;
        queueMicrotask(() => {
          stopPromise = manager.stopServers(workspaceId);
        });
      }
      return originalIterator();
    };
    access.startServers = () =>
      Promise.resolve({ instances: retried, failedServerNames: [], timedOutServerNames: [] });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // The retried client was closed, nothing was merged into the detached
    // entry, and the removed workspace stays uncached.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    expect(access.workspaceServers.has(workspaceId)).toBe(false);
  });

  test("stopServersWithKeyPrefix closes only matching instances and retries them on next use", async () => {
    const workspaceId = "ws-selective-stop";
    const pluginKey = "plugin:abc123:echo";
    const userServer = "user-server";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: stdioConfig("node server.js"),
        [userServer]: stdioConfig("npx user-server"),
      })
    );

    const pluginClose = mock(() => Promise.resolve(undefined));
    const userClose = mock(() => Promise.resolve(undefined));
    const userTool = testTool();
    access.startServers = () =>
      Promise.resolve(
        startResult([
          [pluginKey, { close: pluginClose }],
          [userServer, { tools: { toolu: userTool }, close: userClose }],
        ])
      );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Simulate a live agent stream holding the workspace's servers.
    manager.acquireLease(workspaceId);
    try {
      await manager.stopServersWithKeyPrefix("plugin:abc123:");

      // Only the plugin instance was closed; the unrelated healthy client
      // survives underneath the live lease.
      expect(pluginClose).toHaveBeenCalledTimes(1);
      expect(userClose).toHaveBeenCalledTimes(0);
      const entry = access.workspaceServers.get(workspaceId) as {
        instances: Map<string, unknown>;
        timedOutServerNames: string[];
      };
      expect(entry.instances.has(userServer)).toBe(true);
      expect(entry.instances.has(pluginKey)).toBe(false);
      // The stopped plugin server is queued for restart on next use.
      expect(entry.timedOutServerNames).toContain(pluginKey);
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  test("cleanupIdleServers stops idle servers when workspace is not leased", () => {
    const workspaceId = "ws-idle";

    const close = mock(() => Promise.resolve(undefined));

    const entry = {
      configSignature: "sig",
      instances: new Map([["server", testInstance("server", { close })]]),
      stats: cachedStats({
        startedServerCount: 1,
        failedServerCount: 0,
        failedServerNames: [],
        hasStdio: true,
        transportMode: "stdio_only",
      }),
      lastActivity: Date.now() - 11 * 60_000,
    };

    access.workspaceServers.set(workspaceId, entry);

    access.cleanupIdleServers();

    expect(access.workspaceServers.has(workspaceId)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("cleanupIdleServers does not stop idle servers when workspace is leased", () => {
    const workspaceId = "ws-leased";

    const close = mock(() => Promise.resolve(undefined));

    const entry = {
      configSignature: "sig",
      instances: new Map([["server", testInstance("server", { close })]]),
      stats: cachedStats({
        startedServerCount: 1,
        failedServerCount: 0,
        failedServerNames: [],
        hasStdio: true,
        transportMode: "stdio_only",
      }),
      lastActivity: Date.now() - 11 * 60_000,
    };

    access.workspaceServers.set(workspaceId, entry);
    manager.acquireLease(workspaceId);

    // Ensure the workspace still looks idle even after acquireLease() updates activity.
    (entry as { lastActivity: number }).lastActivity = Date.now() - 11 * 60_000;

    access.cleanupIdleServers();

    expect(access.workspaceServers.has(workspaceId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(0);
  });

  test("startSingleServer times out when startup never finishes", async () => {
    const never = Promise.withResolvers<unknown>();
    const startSingleServerImplMock = mock(() => never.promise);
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      let caught: unknown;
      try {
        await access.startSingleServer(
          "stuck-server",
          stdioConfig("never"),
          TEST_RUNTIME,
          PROJECT_PATH,
          WORKSPACE_PATH,
          undefined,
          () => undefined
        );
      } catch (error) {
        caught = error;
      }

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("stuck-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServer waits for abort cleanup before surfacing timeout", async () => {
    const cleanup = Promise.withResolvers<void>();
    const startSingleServerImplMock = mock((...args: unknown[]) => {
      const signal = args[7] as AbortSignal;
      const registerAbortCleanup = args[8] as ((cleanupPromise: Promise<void>) => void) | undefined;

      return new Promise<null>((resolve) => {
        const onAbort = () => {
          const cleanupPromise = cleanup.promise;
          registerAbortCleanup?.(cleanupPromise);
          cleanupPromise.then(
            () => resolve(null),
            () => resolve(null)
          );
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      let settled = false;
      let caught: unknown;

      const startPromise = access
        .startSingleServer(
          "cleanup-server",
          stdioConfig("never"),
          TEST_RUNTIME,
          PROJECT_PATH,
          WORKSPACE_PATH,
          undefined,
          () => undefined
        )
        .then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            caught = error;
          }
        );

      await new Promise<void>((resolve) => originalSetTimeout(resolve, 5));
      expect(settled).toBe(false);

      cleanup.resolve();
      await startPromise;

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("cleanup-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServer still times out when abort cleanup hangs", async () => {
    const startSingleServerImplMock = mock((...args: unknown[]) => {
      const signal = args[7] as AbortSignal;
      const registerAbortCleanup = args[8] as ((cleanupPromise: Promise<void>) => void) | undefined;
      const cleanupNever = new Promise<void>(() => undefined);

      return new Promise<null>(() => {
        const onAbort = () => {
          registerAbortCleanup?.(cleanupNever);
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      _delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, 1, ...args)) as typeof setTimeout);

    try {
      let caught: unknown;
      try {
        await access.startSingleServer(
          "cleanup-hang-server",
          stdioConfig("never"),
          TEST_RUNTIME,
          PROJECT_PATH,
          WORKSPACE_PATH,
          undefined,
          () => undefined
        );
      } catch (error) {
        caught = error;
      }

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("cleanup-hang-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startServers overlaps slow startups instead of stacking them serially", async () => {
    let active = 0;
    let maxActive = 0;
    access.startSingleServer = mock(async (name: unknown) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return testInstance(String(name));
    });

    const result = await access.startServers(
      {
        a: stdioConfig("cmd-a"),
        b: stdioConfig("cmd-b"),
        c: stdioConfig("cmd-c"),
      },
      TEST_RUNTIME,
      PROJECT_PATH,
      WORKSPACE_PATH,
      undefined,
      () => undefined
    );

    expect(maxActive).toBeGreaterThan(1);
    // Concurrent completion order must not perturb the deterministic Map order.
    expect([...result.instances.keys()]).toEqual(["a", "b", "c"]);
  });

  test("startServers only marks startup timeouts as retryable", async () => {
    const never = Promise.withResolvers<unknown>();
    access.startSingleServerImpl = mock((name: unknown) => {
      if (name === "slow-server") {
        return never.promise;
      }

      if (name === "broken-server") {
        return Promise.reject(new Error("invalid MCP server config"));
      }

      return Promise.resolve(testInstance(String(name)));
    });

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      const result = await access.startServers(
        {
          "slow-server": stdioConfig("slow"),
          "broken-server": stdioConfig("broken"),
        },
        TEST_RUNTIME,
        PROJECT_PATH,
        WORKSPACE_PATH,
        undefined,
        () => undefined
      );

      expect(result.failedServerNames.sort()).toEqual(["broken-server", "slow-server"]);
      expect(result.timedOutServerNames).toEqual(["slow-server"]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServerImpl closes spawned stdio stream when aborted after exec", async () => {
    const controller = new AbortController();
    const stdinClose = mock(() => Promise.resolve(undefined));
    const stdoutCancel = mock(() => Promise.resolve(undefined));
    const stderrCancel = mock(() => Promise.resolve(undefined));

    const exec = mock((_command: string) => {
      controller.abort();

      return Promise.resolve({
        stdin: new WritableStream<Uint8Array>({
          close: stdinClose,
        }),
        stdout: new ReadableStream<Uint8Array>({
          cancel: stdoutCancel,
        }),
        stderr: new ReadableStream<Uint8Array>({
          cancel: stderrCancel,
        }),
        exitCode: Promise.resolve(0),
        duration: Promise.resolve(0),
      });
    });

    const result = await access.startSingleServerImpl(
      "stdio-aborted-after-exec",
      stdioConfig("never"),
      { exec } as unknown as Runtime,
      PROJECT_PATH,
      WORKSPACE_PATH,
      undefined,
      () => undefined,
      controller.signal
    );

    expect(result).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stdinClose).toHaveBeenCalledTimes(1);
    expect(stdoutCancel).toHaveBeenCalledTimes(1);
    expect(stderrCancel).toHaveBeenCalledTimes(1);
  });

  test("startSingleServerImpl cleans up client that resolves after abort", async () => {
    const controller = new AbortController();
    const stdinClose = mock(() => Promise.resolve(undefined));
    const stdoutCancel = mock(() => Promise.resolve(undefined));
    const lateClientClose = mock(() => Promise.resolve(undefined));
    const createClient =
      Promise.withResolvers<Awaited<ReturnType<typeof mcpSdk.createMCPClient>>>();

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(() => {
      controller.abort();
      return createClient.promise;
    });

    try {
      const exec = mock((_command: string) =>
        Promise.resolve({
          stdin: new WritableStream<Uint8Array>({
            close: stdinClose,
          }),
          stdout: new ReadableStream<Uint8Array>({
            cancel: stdoutCancel,
          }),
          stderr: new ReadableStream<Uint8Array>(),
          exitCode: Promise.resolve(0),
          duration: Promise.resolve(0),
        })
      );

      const startup = access.startSingleServerImpl(
        "stdio-late-client-cleanup",
        stdioConfig("never"),
        { exec } as unknown as Runtime,
        "/tmp/project",
        "/tmp/workspace",
        undefined,
        () => undefined,
        controller.signal
      );

      createClient.resolve({
        close: lateClientClose,
        tools: mock(() => Promise.resolve({})),
      } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>);

      const result = await startup;

      expect(result).toBeNull();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(stdinClose).toHaveBeenCalledTimes(1);
      expect(stdoutCancel).toHaveBeenCalledTimes(1);
      expect(lateClientClose).toHaveBeenCalledTimes(1);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("startSingleServerImpl cleans up HTTP client that resolves after abort", async () => {
    const controller = new AbortController();
    const lateClientClose = mock(() => Promise.resolve(undefined));
    const createClient =
      Promise.withResolvers<Awaited<ReturnType<typeof mcpSdk.createMCPClient>>>();

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(() => {
      controller.abort();
      return createClient.promise;
    });

    try {
      const startup = access.startSingleServerImpl(
        "http-late-client-cleanup",
        { transport: "http", url: "https://example.com/mcp" },
        TEST_RUNTIME,
        PROJECT_PATH,
        WORKSPACE_PATH,
        undefined,
        () => undefined,
        controller.signal
      );

      createClient.resolve({
        close: lateClientClose,
        tools: mock(() => Promise.resolve({})),
      } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>);

      const result = await startup;

      expect(result).toBeNull();
      expect(lateClientClose).toHaveBeenCalledTimes(1);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("startSingleServerImpl respawns stdio server as legacy after probe crash", async () => {
    // Fragile legacy stdio servers can exit on the server/discover probe.
    // The manager must respawn the process once and reconnect with a legacy
    // era verdict so the server still comes up.
    const controller = new AbortController();
    const priors: unknown[] = [];
    const tool = testTool();

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(
      (config: mcpSdk.MCPClientConfig) => {
        priors.push(config.prior);
        if (priors.length === 1) {
          // First attempt: probe kills the server -> connect fails.
          return Promise.reject(new Error("Connection closed"));
        }
        return Promise.resolve({
          tools: mock(() => Promise.resolve({ crashy_tool: tool })),
          negotiatedProtocolVersion: () => "2025-11-25",
          priorDiscovery: () => ({ kind: "legacy" as const }),
          close: mock(() => Promise.resolve(undefined)),
        } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>);
      }
    );

    const exec = mock(() =>
      Promise.resolve({
        stdin: new WritableStream<Uint8Array>({ close: () => undefined }),
        stdout: new ReadableStream<Uint8Array>({ cancel: () => undefined }),
        stderr: new ReadableStream<Uint8Array>({ cancel: () => undefined }),
        exitCode: new Promise<number>(() => undefined),
        duration: Promise.resolve(0),
      })
    );

    try {
      const result = (await access.startSingleServerImpl(
        "crashy",
        stdioConfig("node crash-on-probe.js"),
        { exec } as unknown as Runtime,
        PROJECT_PATH,
        WORKSPACE_PATH,
        undefined,
        () => undefined,
        controller.signal
      )) as { name: string; tools: Record<string, Tool> } | null;

      expect(exec).toHaveBeenCalledTimes(2);
      expect(priors).toEqual([undefined, { kind: "legacy" }]);
      expect(result?.name).toBe("crashy");
      expect(Object.keys(result?.tools ?? {})).toEqual(["crashy_tool"]);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("startSingleServerImpl re-probes when a cached legacy verdict is rejected", async () => {
    // A server cached as legacy can be upgraded in place to a 2026-only
    // implementation that rejects the initialize handshake. The manager must
    // drop the cached verdict and re-probe instead of failing every startup
    // until the verdict TTL expires.
    const controller = new AbortController();
    const priors: unknown[] = [];
    const tool = testTool();

    const makeHandle = (era: "legacy" | "modern") =>
      ({
        tools: mock(() => Promise.resolve({ upgraded_tool: tool })),
        negotiatedProtocolVersion: () => (era === "modern" ? "2026-07-28" : "2025-11-25"),
        priorDiscovery: () =>
          era === "modern"
            ? { kind: "modern" as const, discover: {} }
            : { kind: "legacy" as const },
        close: mock(() => Promise.resolve(undefined)),
      }) as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>;

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(
      (config: mcpSdk.MCPClientConfig) => {
        priors.push(config.prior);
        // Call 1: fresh probe -> legacy verdict cached.
        if (priors.length === 1) {
          return Promise.resolve(makeHandle("legacy"));
        }
        // Call 2: cached legacy verdict -> server was upgraded and now
        // rejects the initialize handshake.
        if (priors.length === 2) {
          return Promise.reject(new Error("initialize rejected: unsupported protocol version"));
        }
        // Call 3: fresh re-probe -> modern.
        return Promise.resolve(makeHandle("modern"));
      }
    );

    const exec = mock(() =>
      Promise.resolve({
        stdin: new WritableStream<Uint8Array>({ close: () => undefined }),
        stdout: new ReadableStream<Uint8Array>({ cancel: () => undefined }),
        stderr: new ReadableStream<Uint8Array>({ cancel: () => undefined }),
        exitCode: new Promise<number>(() => undefined),
        duration: Promise.resolve(0),
      })
    );

    try {
      const startOnce = () =>
        access.startSingleServerImpl(
          "upgraded",
          stdioConfig("node upgraded-server.js"),
          { exec } as unknown as Runtime,
          PROJECT_PATH,
          WORKSPACE_PATH,
          undefined,
          () => undefined,
          controller.signal
        ) as Promise<{ name: string; tools: Record<string, Tool> } | null>;

      const first = await startOnce();
      expect(Object.keys(first?.tools ?? {})).toEqual(["upgraded_tool"]);

      const second = await startOnce();
      expect(priors).toEqual([undefined, { kind: "legacy" }, undefined]);
      expect(Object.keys(second?.tools ?? {})).toEqual(["upgraded_tool"]);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("getToolsForWorkspace tracks failed server names in stats", async () => {
    const workspaceId = "ws-failed-names";
    configService.listServers = mock(() =>
      Promise.resolve({
        "healthy-server": stdioConfig("ok"),
        "broken-server": stdioConfig("bad"),
      })
    );

    const close = mock(() => Promise.resolve(undefined));
    access.startSingleServerImpl = mock((name: unknown) => {
      if (name === "broken-server") {
        return Promise.reject(new Error("invalid MCP server config"));
      }

      return Promise.resolve(testInstance(String(name), { close }));
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.stats.failedServerCount).toBe(1);
    expect(result.stats.failedServerNames).toContain("broken-server");
  });

  test("getToolsForWorkspace suffixes MCP tools that collide with built-in tool names", async () => {
    const workspaceId = "ws-builtin-collision";
    configService.listServers = mock(() => Promise.resolve({ mcp: stdioConfig("cmd") }));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([["mcp", { tools: { prompt_get: testTool(), other_tool: testTool() } }]])
      )
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    const names = Object.keys(result.tools);
    // "mcp" + "prompt_get" normalizes to the built-in mcp_prompt_get name.
    expect(names).not.toContain("mcp_prompt_get");
    expect(names.some((name) => name.startsWith("mcp_prompt_get_"))).toBe(true);
    expect(names).toContain("mcp_other_tool");
  });

  test("getToolsForWorkspace drops prompts whose argument names cannot round-trip", async () => {
    const workspaceId = "ws-oversized-arg-name";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          [
            "coder",
            {
              prompts: [
                { name: "usable", arguments: [{ name: "pr", required: true }] },
                { name: "stuck", arguments: [{ name: "a".repeat(5_000), required: true }] },
                {
                  name: "partial",
                  arguments: [
                    { name: "ok", required: true },
                    { name: "b".repeat(5_000), required: false },
                  ],
                },
              ],
            },
          ],
        ])
      )
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Both oversized-name prompts are dropped, not rewritten: composer slash
    // invocation maps tokens positionally, so a stripped argument would
    // silently misassign the remaining tokens.
    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["usable"]);
  });

  test("getToolsForWorkspace drops oversized prompt names and clamps descriptions at refresh", async () => {
    const workspaceId = "ws-oversized-prompt-fields";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          [
            "coder",
            {
              prompts: [
                { name: "n".repeat(1024 * 1024) },
                {
                  name: "wordy",
                  description: "d".repeat(1024 * 1024),
                  arguments: [{ name: "pr", description: "a".repeat(1024 * 1024), required: true }],
                },
              ],
            },
          ],
        ])
      )
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["wordy"]);
    const wordy = result.promptDescriptors[0];
    expect(wordy?.description?.length).toBe(MCP_PROMPT_MAX_DESCRIPTION_CHARS);
    expect(wordy?.arguments?.[0]?.description?.length).toBe(MCP_PROMPT_MAX_DESCRIPTION_CHARS);
  });

  test("getToolsForWorkspace advertises no prompts for a server whose name cannot round-trip", async () => {
    const workspaceId = "ws-oversized-server-name";
    const hugeName = "s".repeat(1024 * 1024);
    configService.listServers = mock(() =>
      Promise.resolve({ [hugeName]: stdioConfig("cmd-huge"), coder: stdioConfig("cmd") })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          [hugeName, { prompts: [{ name: "hidden" }] }],
          ["coder", { prompts: [{ name: "visible" }] }],
        ])
      )
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // The oversized server name would otherwise prefix every prompt key and
    // rerun Unicode/regex normalization over it per prompt.
    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual([
      "visible",
    ]);
  });

  test("prompt catalogs are normalized once at refresh, off the per-send rebuild path", async () => {
    const workspaceId = "ws-hostile-arg-count";
    let rawElementReads = 0;
    const hostileArguments = new Proxy(
      Array.from({ length: 100_000 }, (_, index) => ({
        name: `arg_${index}`,
        required: index === 90_000,
      })),
      {
        get(target, property, receiver): unknown {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rawElementReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    let refreshCalls = 0;
    const oneShotRefresh = mock(() => {
      refreshCalls += 1;
      return refreshCalls === 1
        ? Promise.resolve([
            { name: "hostile", arguments: hostileArguments },
            {
              name: "usable",
              arguments: Array.from({ length: MCP_PROMPT_MAX_ARGUMENTS }, (_, index) => ({
                name: `arg_${index}`,
                required: index === 0,
              })),
            },
          ])
        : new Promise<never>(() => undefined);
    });
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() =>
      Promise.resolve(startResult([["coder", { refreshPrompts: oneShotRefresh }]]))
    );

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The over-cap prompt is dropped by the length gate without reading a
    // single element, and no per-send path revisits the raw array.
    expect(rawElementReads).toBe(0);
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(rawElementReads).toBe(0);
    expect(second.promptDescriptors).toBe(first.promptDescriptors);
    for (const result of [first, second]) {
      expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual([
        "usable",
      ]);
      expect(result.promptDescriptors[0]?.arguments).toHaveLength(MCP_PROMPT_MAX_ARGUMENTS);
    }
  });

  test("getToolsForWorkspace returns prompt descriptors alongside tools", async () => {
    const workspaceId = "ws-tool-prompts";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          [
            "coder",
            {
              prompts: [
                {
                  name: "review",
                  description: "Review a PR",
                  arguments: [{ name: "pr", required: true }],
                },
              ],
            },
          ],
        ])
      )
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.promptDescriptors).toHaveLength(1);
    expect(result.promptDescriptors[0]).toMatchObject({
      serverName: "coder",
      promptName: "review",
      description: "Review a PR",
      arguments: [{ name: "pr", required: true }],
    });
  });

  test("a client closed during catalog refresh is excluded from the returned tools", async () => {
    const workspaceId = "closed-during-refresh";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd") }));
    const instance = testInstance("server", { tools: { work: testTool() } });
    access.startServers = mock(() =>
      Promise.resolve({
        instances: new Map([["server", instance]]),
        failedServerNames: [],
      })
    );
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toEqual(["server_work"]);
    const refreshTools = mock(() => {
      instance.isClosed = true;
      return Promise.resolve();
    });
    (instance as { refreshTools?: typeof refreshTools }).refreshTools = refreshTools;
    const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(next.tools).toEqual({});
    expect(next.toolServerNames).toEqual({});
  });

  test("getToolsForWorkspace re-polls legacy and modern prompt catalogs each stream", async () => {
    const workspaceId = "ws-prompt-freshness";
    configService.listServers = mock(() =>
      Promise.resolve({ legacy: stdioConfig("cmd-legacy"), modern: stdioConfig("cmd-modern") })
    );
    const legacy = testInstance("legacy");
    let legacyFetches = 0;
    const legacyRefresh = mock(() => {
      legacyFetches += 1;
      return Promise.resolve([{ name: `legacy-v${legacyFetches}` }]);
    });
    (legacy as { refreshPrompts?: typeof legacyRefresh }).refreshPrompts = legacyRefresh;
    const modern = testInstance("modern", { refreshTools: mock(() => Promise.resolve()) });
    let modernFetches = 0;
    const modernRefresh = mock(() => {
      modernFetches += 1;
      return Promise.resolve([{ name: `modern-v${modernFetches}` }]);
    });
    (modern as { refreshPrompts?: typeof modernRefresh }).refreshPrompts = modernRefresh;
    access.startServers = mock(() =>
      Promise.resolve({
        instances: new Map([
          ["legacy", legacy],
          ["modern", modern],
        ]),
        failedServerNames: [],
        timedOutServerNames: [],
      })
    );

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Let the second send's background refresh land before the third send.
    await Bun.sleep(0);
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(legacyRefresh).toHaveBeenCalledTimes(3);
    expect(modernRefresh).toHaveBeenCalledTimes(3);
    expect(first.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v1",
      "modern-v1",
    ]);
    expect(second.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v1",
      "modern-v1",
    ]);
    expect(third.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v2",
      "modern-v2",
    ]);
  });

  test("an older prompt refresh completing late never overwrites a newer catalog", async () => {
    const workspaceId = "ws-refresh-race";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    let calls = 0;
    let resolveStale!: (prompts: Array<{ name: string }>) => void;
    const refreshPrompts = mock(() => {
      calls += 1;
      // Call 1 seeds the cache, call 2 is held stale, and call 3 wins through
      // direct discovery. Later calls hang.
      if (calls === 1) return Promise.resolve([{ name: "initial" }]);
      if (calls === 2)
        return new Promise<Array<{ name: string }>>((resolve) => {
          resolveStale = resolve;
        });
      if (calls === 3) return Promise.resolve([{ name: "newer" }]);
      return new Promise<Array<{ name: string }>>(() => undefined);
    });
    access.startServers = mock(() => Promise.resolve(startResult([["coder", { refreshPrompts }]])));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const discovered = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(discovered.map((descriptor) => descriptor.promptName)).toEqual(["newer"]);

    resolveStale([{ name: "stale" }]);
    await Bun.sleep(0);

    const final = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(final.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["newer"]);
  });

  test("getToolsForWorkspace does not block sends on a hung prompt refresh", async () => {
    const workspaceId = "ws-hung-prompt-refresh";
    configService.listServers = mock(() => Promise.resolve({ hung: stdioConfig("cmd") }));
    const hung = testInstance("hung", { prompts: [{ name: "cached" }] });
    let refreshCalls = 0;
    const neverSettles = mock(() => {
      refreshCalls += 1;
      return refreshCalls === 1
        ? Promise.resolve([{ name: "cached" }])
        : new Promise<Array<{ name: string }>>(() => undefined);
    });
    (hung as { refreshPrompts?: typeof neverSettles }).refreshPrompts = neverSettles;
    access.startServers = mock(() =>
      Promise.resolve({
        instances: new Map([["hung", hung]]),
        failedServerNames: [],
        timedOutServerNames: [],
      })
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(second.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["cached"]);
    expect(third.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["cached"]);
    expect(refreshCalls).toBe(2);
  });

  test("getToolsForWorkspace retries timed-out servers from cached workspace state", async () => {
    const workspaceId = "ws-timeout-retry";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    const toolA = testTool();
    const toolB = testTool();

    const startServersMock = mock((servers: unknown) => {
      const serverMap = servers as Record<string, unknown>;
      if (startServersMock.mock.calls.length === 1) {
        expect(Object.keys(serverMap)).toEqual(["serverA", "serverB"]);
        return Promise.resolve(
          startResult([["serverA", { tools: { toolA } }]], {
            failedServerNames: ["serverB"],
            timedOutServerNames: ["serverB"],
          })
        );
      }

      expect(Object.keys(serverMap)).toEqual(["serverB"]);
      return Promise.resolve(startResult([["serverB", { tools: { toolB } }]]));
    });

    access.startServers = startServersMock;

    const initial = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(initial.stats.failedServerCount).toBe(1);
    expect(initial.stats.failedServerNames).toEqual(["serverB"]);
    expect(initial.stats.startedServerCount).toBe(1);
    expect(Object.keys(initial.tools)).toEqual(["servera_toola"]);

    const retried = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(retried.stats.failedServerCount).toBe(0);
    expect(retried.stats.failedServerNames).toEqual([]);
    expect(retried.stats.startedServerCount).toBe(2);
    const retriedToolNames = Object.keys(retried.tools);
    expect(retriedToolNames).toContain("servera_toola");
    expect(retriedToolNames).toContain("serverb_toolb");

    const cached = access.workspaceServers.get(workspaceId) as {
      timedOutServerNames?: string[];
    };
    expect(cached.timedOutServerNames).toEqual([]);
  });

  test("getToolsForWorkspace does not overlap timed-out retries for concurrent cached requests", async () => {
    const workspaceId = "ws-timeout-retry-concurrent";
    configService.listServers = mock(() =>
      Promise.resolve({
        slow: stdioConfig("cmd-slow"),
      })
    );

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<{
      instances: Map<string, unknown>;
      failedServerNames: string[];
      timedOutServerNames: string[];
    }>();
    let hasSignaledRetryStart = false;

    const slowTool = testTool();
    const startServersMock = mock(() => {
      if (!hasSignaledRetryStart) {
        hasSignaledRetryStart = true;
        retryStarted.resolve();
      }

      return retryFinished.promise;
    });
    access.startServers = startServersMock;

    access.workspaceServers.set(workspaceId, {
      configSignature: JSON.stringify({
        slow: { transport: "stdio", command: "cmd-slow", args: null, env: null, cwd: null },
      }),
      instances: new Map(),
      enabledServerNames: new Set(["slow"]),
      stats: cachedStats(),
      timedOutServerNames: ["slow"],
      lastActivity: Date.now(),
    });

    const firstPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await retryStarted.promise;

    const secondPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(startServersMock).toHaveBeenCalledTimes(1);

    retryFinished.resolve(startResult([["slow", { tools: { tool: slowTool } }]]));

    const [first] = await Promise.all([firstPromise, secondPromise]);

    expect(startServersMock).toHaveBeenCalledTimes(1);
    expect(first.stats.failedServerCount).toBe(0);
    expect(Object.keys(first.tools)).toEqual(["slow_tool"]);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, unknown>;
      timedOutServerNames?: string[];
      retryingTimedOutServerNames?: Set<string>;
    };
    expect(cached.instances.has("slow")).toBe(true);
    expect(cached.timedOutServerNames).toEqual([]);
    expect(cached.retryingTimedOutServerNames?.size).toBe(0);
  });

  test("getToolsForWorkspace closes timed-out retry results when cache entry is replaced mid-retry", async () => {
    const workspaceId = "ws-timeout-retry-replaced";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        slow: { transport: "stdio", command, disabled: false },
      })
    );

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<{
      instances: Map<string, unknown>;
      failedServerNames: string[];
      timedOutServerNames: string[];
    }>();
    let startServersCallCount = 0;

    const retriedClose = mock(() => Promise.resolve(undefined));
    const replacementClose = mock(() => Promise.resolve(undefined));
    const retriedInstance = testInstance("slow", {
      tools: { retry: testTool() },
      close: retriedClose,
    });
    const replacementInstance = testInstance("slow", {
      tools: { active: testTool() },
      close: replacementClose,
    });

    const startServersMock = mock((servers: unknown) => {
      startServersCallCount += 1;
      const serverMap = servers as Record<string, { command?: string }>;

      if (startServersCallCount === 1) {
        expect(Object.keys(serverMap)).toEqual(["slow"]);
        expect(serverMap.slow?.command).toBe("cmd-1");
        retryStarted.resolve();
        return retryFinished.promise;
      }

      expect(Object.keys(serverMap)).toEqual(["slow"]);
      expect(serverMap.slow?.command).toBe("cmd-2");
      return Promise.resolve({
        instances: new Map([["slow", replacementInstance]]),
        failedServerNames: [],
        timedOutServerNames: [],
      });
    });
    access.startServers = startServersMock;

    const staleEntry = {
      configSignature: JSON.stringify({
        slow: { transport: "stdio", command: "cmd-1", args: null, env: null, cwd: null },
      }),
      instances: new Map(),
      stats: cachedStats(),
      timedOutServerNames: ["slow"],
      retryingTimedOutServerNames: new Set<string>(),
      lastActivity: Date.now(),
    };
    access.workspaceServers.set(workspaceId, staleEntry);

    const retryPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await retryStarted.promise;

    expect(staleEntry.retryingTimedOutServerNames.has("slow")).toBe(true);

    command = "cmd-2";
    const replacementResult = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(Object.keys(replacementResult.tools)).toEqual(["slow_active"]);

    retryFinished.resolve(
      startResult([["slow", { tools: retriedInstance.tools, close: retriedClose }]])
    );

    const retriedResult = await retryPromise;

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(retriedClose).toHaveBeenCalledTimes(1);
    expect(replacementClose).toHaveBeenCalledTimes(0);
    expect(Object.keys(retriedResult.tools)).toEqual(["slow_active"]);

    const activeEntry = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, typeof replacementInstance>;
      retryingTimedOutServerNames?: Set<string>;
    };
    expect(activeEntry).not.toBe(staleEntry);
    expect(activeEntry.instances.get("slow")).toBe(replacementInstance);
    expect(activeEntry.retryingTimedOutServerNames?.size).toBe(0);
    expect(staleEntry.instances.size).toBe(0);
    expect(staleEntry.retryingTimedOutServerNames.size).toBe(0);
  });

  test.each([false, true])(
    "additive config preserves existing clients (leased: %s)",
    async (leased) => {
      const workspaceId = "ws-additive";
      const pluginKey = "plugin_example_selected";
      const configs = {
        ordinary: stdioConfig("ordinary"),
        plugin_existing: stdioConfig("existing"),
      };
      configService.listServers = mock(() => Promise.resolve({ ...configs }));
      const started: Array<ReturnType<typeof testInstance>> = [];
      // Keep the real startServers path; only the process boundary is injected.
      access.startSingleServer = mock((name: unknown) => {
        const instance = testInstance(String(name), {
          tools: { echo: testTool() },
          prompts: [{ name: "review" }],
          refreshTools: mock(() => Promise.resolve()),
        });
        started.push(instance);
        return Promise.resolve(instance);
      });
      const request = workspaceRequest(workspaceId, {
        overrides: { enabledServers: [pluginKey] },
      });
      const first = await manager.getToolsForWorkspace(request);
      expect(started.map((instance) => instance.name)).toEqual(["ordinary", "plugin_existing"]);
      if (leased) manager.acquireLease(workspaceId);
      try {
        // An old enable override only takes effect once the selected server exists.
        Object.assign(configs, { [pluginKey]: stdioConfig("selected", true) });
        const result = await manager.getToolsForWorkspace(request);
        expect(started.map((instance) => instance.name)).toEqual([
          "ordinary",
          "plugin_existing",
          pluginKey,
        ]);
        expect(started[0].close).not.toHaveBeenCalled();
        expect(started[1].close).not.toHaveBeenCalled();
        expect(result.tools.plugin_existing_echo).toBe(first.tools.plugin_existing_echo);
        expect(result.tools.ordinary_echo).toBe(first.tools.ordinary_echo);
        expect(result.tools[`${pluginKey}_echo`]).toBeDefined();
        expect(result.stats.startedServerCount).toBe(3);
        expect(result.promptDescriptors.map((prompt) => prompt.serverName).sort()).toEqual(
          ["ordinary", "plugin_existing", pluginKey].sort()
        );
        expect(started[0].refreshTools).toHaveBeenCalledTimes(1);
        await manager.getToolsForWorkspace(request);
        expect(started).toHaveLength(3);
      } finally {
        if (leased) manager.releaseLease(workspaceId);
      }
    }
  );

  test("additive startup preserves a concurrent timeout retry's state", async () => {
    const request = workspaceRequest("ws-additive-retry");
    const configs = { stable: stdioConfig("stable"), slow: stdioConfig("slow") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stable = testInstance("stable", { tools: { echo: testTool() } });
    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<ReturnType<typeof startResult>>();
    const startup = mock()
      .mockResolvedValueOnce({
        instances: new Map([["stable", stable]]),
        failedServerNames: ["slow"],
        timedOutServerNames: ["slow"],
      })
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return retryFinished.promise;
      })
      .mockResolvedValueOnce(
        startResult([], {
          failedServerNames: ["addedSlow", "addedBroken"],
          timedOutServerNames: ["addedSlow"],
        })
      );
    access.startServers = startup;
    await manager.getToolsForWorkspace(request);
    const retry = manager.getToolsForWorkspace(request);
    await retryStarted.promise;
    Object.assign(configs, {
      addedSlow: stdioConfig("addedSlow"),
      addedBroken: stdioConfig("addedBroken"),
    });
    await manager.getToolsForWorkspace(request);
    retryFinished.resolve(startResult([["slow", { tools: { echo: testTool() } }]]));
    const result = await retry;
    expect(result.stats.enabledServerCount).toBe(4);
    expect(result.stats.failedServerNames.sort()).toEqual(["addedBroken", "addedSlow"]);
    expect(stable.close).not.toHaveBeenCalled();
    expect(startup.mock.calls.map((args) => Object.keys(args[0] as object))).toEqual([
      ["stable", "slow"],
      ["slow"],
      ["addedBroken", "addedSlow"],
    ]);
    startup.mockResolvedValueOnce(startResult([["addedSlow"]]));
    await manager.getToolsForWorkspace(request);
    expect(Object.keys(startup.mock.calls.at(-1)![0] as object)).toEqual(["addedSlow"]);
  });

  test("additive startup preserves a leased closed-client recovery", async () => {
    const request = workspaceRequest("ws-additive-recovery");
    const configs = { stable: stdioConfig("stable"), dead: stdioConfig("dead") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stable = testInstance("stable");
    const dead = testInstance("dead");
    const recoveryStarted = Promise.withResolvers<void>();
    const recoveryFinished = Promise.withResolvers<ReturnType<typeof startResult>>();
    access.startServers = mock()
      .mockResolvedValueOnce({
        instances: new Map([
          ["stable", stable],
          ["dead", dead],
        ]),
        failedServerNames: [],
      })
      .mockImplementationOnce(() => {
        recoveryStarted.resolve();
        return recoveryFinished.promise;
      })
      .mockResolvedValueOnce(startResult([["added", { tools: { echo: testTool() } }]]));
    await manager.getToolsForWorkspace(request);
    manager.acquireLease(request.workspaceId);
    try {
      dead.isClosed = true;
      const recovery = manager.getToolsForWorkspace(request);
      await recoveryStarted.promise;
      Object.assign(configs, { added: stdioConfig("added") });
      await manager.getToolsForWorkspace(request);
      recoveryFinished.resolve(startResult([["dead", { tools: { echo: testTool() } }]]));
      const result = await recovery;
      expect(Object.keys(result.tools).sort()).toEqual(["added_echo", "dead_echo"]);
      expect(result.stats.startedServerCount).toBe(3);
      expect(result.stats.enabledServerCount).toBe(3);
      expect(stable.close).not.toHaveBeenCalled();
      expect(dead.close).toHaveBeenCalledTimes(1);
    } finally {
      manager.releaseLease(request.workspaceId);
    }
  });

  test("additive requests serialize and do not roll back a newer config snapshot", async () => {
    const request = workspaceRequest("ws-additive-concurrent");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stable = testInstance("stable");
    const startupEntered = Promise.withResolvers<void>();
    const startupFinished = Promise.withResolvers<void>();
    const startup = mock((servers: unknown) =>
      Promise.resolve(startResult(Object.keys(servers as object).map((name) => [name])))
    );
    startup.mockResolvedValueOnce({
      instances: new Map([["stable", stable]]),
      failedServerNames: [],
      timedOutServerNames: [],
    });
    access.startServers = startup;
    await manager.getToolsForWorkspace(request);
    startup.mockImplementationOnce(async (servers) => {
      startupEntered.resolve();
      await startupFinished.promise;
      return startResult(Object.keys(servers as object).map((name) => [name]));
    });
    Object.assign(configs, { added: stdioConfig("added"), newest: stdioConfig("newest") });
    const newer = manager.getToolsForWorkspace(request);
    await startupEntered.promise;
    // Park an older config read until the larger selection has published.
    const oldReadEntered = Promise.withResolvers<void>();
    const oldReadFinished = Promise.withResolvers<{
      stable: ReturnType<typeof stdioConfig>;
      added: ReturnType<typeof stdioConfig>;
    }>();
    configService.listServers.mockImplementationOnce(() => {
      oldReadEntered.resolve();
      return oldReadFinished.promise;
    });
    const older = manager.getToolsForWorkspace(request);
    await oldReadEntered.promise;
    startupFinished.resolve();
    await newer;
    oldReadFinished.resolve({ stable: configs.stable, added: stdioConfig("added") });
    await older;
    expect(startup).toHaveBeenCalledTimes(2);
    expect(stable.close).not.toHaveBeenCalled();
    expect((await manager.getToolsForWorkspace(request)).stats.startedServerCount).toBe(3);
  });

  test.each(["startup", "publication"])(
    "additive startup discards clients removed during %s",
    async (phase) => {
      const request = workspaceRequest("ws-additive-removed");
      const configs = { stable: stdioConfig("stable") };
      configService.listServers = mock(() => Promise.resolve({ ...configs }));
      const stable = testInstance("stable");
      const added = testInstance("added");
      access.startServers = mock().mockResolvedValueOnce({
        instances: new Map([["stable", stable]]),
        failedServerNames: [],
      });
      await manager.getToolsForWorkspace(request);
      Object.assign(configs, { added: stdioConfig("added") });
      let stopped: Promise<void> | undefined;
      access.startServers = async () => {
        const instances = new Map([["added", added]]);
        if (phase === "startup") await manager.stopServers(request.workspaceId);
        else {
          const iterator = instances[Symbol.iterator].bind(instances);
          instances[Symbol.iterator] = () => {
            instances[Symbol.iterator] = iterator;
            queueMicrotask(() => {
              stopped = manager.stopServers(request.workspaceId);
            });
            return iterator();
          };
        }
        return { instances, failedServerNames: [] };
      };
      const result = await manager.getToolsForWorkspace(request);
      await stopped;
      expect(Object.keys(result.tools)).toEqual([]);
      expect(access.workspaceServers.has(request.workspaceId)).toBe(false);
      expect(stable.close).toHaveBeenCalledTimes(1);
      expect(added.close).toHaveBeenCalledTimes(1);
    }
  );

  test("additive startup retries invalidated additions without closing unrelated clients", async () => {
    const request = workspaceRequest("ws-additive-invalidated");
    const pluginKey = "plugin:added:echo";
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stable = testInstance("stable");
    const added = testInstance(pluginKey);
    access.startServers = mock().mockResolvedValueOnce({
      instances: new Map([["stable", stable]]),
      failedServerNames: [],
    });
    await manager.getToolsForWorkspace(request);
    Object.assign(configs, { [pluginKey]: stdioConfig("added") });
    access.startServers = async () => {
      await manager.stopServersWithKeyPrefix("plugin:added:");
      return { instances: new Map([[pluginKey, added]]), failedServerNames: [] };
    };
    const result = await manager.getToolsForWorkspace(request);
    expect(result.stats.startedServerCount).toBe(1);
    expect(stable.close).not.toHaveBeenCalled();
    expect(added.close).toHaveBeenCalledTimes(1);
    const retry = mock((_servers: unknown) => Promise.resolve(startResult([[pluginKey]])));
    access.startServers = retry;
    expect((await manager.getToolsForWorkspace(request)).stats.startedServerCount).toBe(2);
    expect(Object.keys(retry.mock.calls[0][0] as object)).toEqual([pluginKey]);
  });

  test("additive startup repairs prompt enablement after a concurrent disable", async () => {
    const request = workspaceRequest("ws-additive-disable");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    access.startServers = mock(() =>
      Promise.resolve(startResult([["stable", { prompts: [{ name: "status" }] }]]))
    );
    await manager.getToolsForWorkspace(request);
    Object.assign(configs, { added: stdioConfig("added") });
    const refreshPrompts = mock(() => Promise.resolve([{ name: "review" }]));
    access.startServers = async () => {
      await manager.applyWorkspaceOverrides(request.workspaceId, { disabledServers: ["added"] });
      return startResult([["added", { refreshPrompts }]]);
    };
    const result = await manager.getToolsForWorkspace(request);
    expect(result.promptDescriptors.map((prompt) => prompt.serverName)).toEqual(["stable"]);
    expect(refreshPrompts).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(request.workspaceId, "added", "review", {})).rejects.toThrow(
      "is disabled"
    );
  });

  test("additive publication cannot bypass allowlists in a pending cached request", async () => {
    const request = workspaceRequest("ws-additive-allowlist");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const refreshStarted = Promise.withResolvers<void>();
    const refreshFinished = Promise.withResolvers<void>();
    const refreshTools = mock(() => Promise.resolve());
    access.startServers = mock(() => Promise.resolve(startResult([["stable", { refreshTools }]])));
    await manager.getToolsForWorkspace(request);
    refreshTools.mockImplementationOnce(() => {
      refreshStarted.resolve();
      return refreshFinished.promise;
    });
    const pending = manager.getToolsForWorkspace(request);
    await refreshStarted.promise;
    try {
      Object.assign(configs, { added: { ...stdioConfig("added"), toolAllowlist: ["visible"] } });
      access.startServers = mock(() =>
        Promise.resolve(
          startResult([
            [
              "added",
              {
                tools: { visible: testTool(), hidden: testTool() },
              },
            ],
          ])
        )
      );
      const result = await manager.getToolsForWorkspace(request);
      expect(Object.keys(result.tools)).toEqual(["added_visible"]);
    } finally {
      refreshFinished.resolve();
    }
    const older = await pending;
    expect(older.tools.added_hidden).toBeUndefined();
    expect((await manager.getToolsForWorkspace(request)).tools.added_visible).toBeDefined();
  });

  test.each(["reconfigured", "removed"])(
    "additive detection rejects a %s existing server",
    async (change) => {
      const request = workspaceRequest("ws-not-additive");
      let configs: Record<string, ReturnType<typeof stdioConfig>> = {
        stable: stdioConfig("stable"),
        changed: stdioConfig("before"),
      };
      configService.listServers = mock(() => Promise.resolve(configs));
      const started: Array<ReturnType<typeof testInstance>> = [];
      access.startSingleServer = mock((name: unknown) => {
        const instance = testInstance(String(name));
        started.push(instance);
        return Promise.resolve(instance);
      });
      await manager.getToolsForWorkspace(request);
      const original = [...started];
      configs = {
        stable: stdioConfig("stable"),
        added: stdioConfig("added"),
        ...(change === "reconfigured" ? { changed: stdioConfig("after") } : {}),
      };
      await manager.getToolsForWorkspace(request);
      for (const instance of original) expect(instance.close).toHaveBeenCalledTimes(1);
      expect(started.filter((instance) => instance.name === "stable")).toHaveLength(2);
    }
  );

  test("additive startup does not duplicate or wait for a retained background prompt refresh", async () => {
    const request = workspaceRequest("ws-additive-prompt-refresh");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const refreshStarted = Promise.withResolvers<void>();
    const refreshFinished = Promise.withResolvers<Array<{ name: string }>>();
    const refreshPrompts = mock(() => Promise.resolve([{ name: "status" }]));
    access.startServers = mock(() =>
      Promise.resolve(startResult([["stable", { refreshPrompts }]]))
    );
    await manager.getToolsForWorkspace(request);
    refreshPrompts.mockImplementationOnce(() => {
      refreshStarted.resolve();
      return refreshFinished.promise;
    });
    await manager.getToolsForWorkspace(request);
    await refreshStarted.promise;
    try {
      Object.assign(configs, { added: stdioConfig("added") });
      access.startServers = mock(() =>
        Promise.resolve(startResult([["added", { prompts: [{ name: "review" }] }]]))
      );
      const result = await manager.getToolsForWorkspace(request);
      expect(result.promptDescriptors.map((prompt) => prompt.serverName).sort()).toEqual([
        "added",
        "stable",
      ]);
      expect(refreshPrompts).toHaveBeenCalledTimes(2);
    } finally {
      refreshFinished.resolve([{ name: "updated" }]);
    }
  });

  test("getToolsForWorkspace defers restarts while leased and applies them on next request", async () => {
    const workspaceId = "ws-defer";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
      })
    );

    const close = mock(() => Promise.resolve(undefined));

    const startServersMock = mock(() =>
      Promise.resolve(startResult([["server", { tools: { tool: testTool() }, close }]]))
    );

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    manager.acquireLease(workspaceId);

    // Change signature while leased.
    command = "cmd-2";

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(startServersMock).toHaveBeenCalledTimes(1);

    manager.releaseLease(workspaceId);

    // No automatic restart on lease release (avoids closing clients out from under a
    // subsequent stream that already captured the tool objects).
    expect(access.workspaceServers.has(workspaceId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(0);

    // Next request (no lease) applies the pending restart.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("blocks prompt invocation on servers reconfigured while leased", async () => {
    const workspaceId = "ws-stale-prompt";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
        stable: stdioConfig("cmd-stable"),
      })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);
    command = "cmd-2";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
        "was reconfigured"
      );
      expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({
        text: "hi",
      });
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  test("prompt paths skip cached tool catalog refreshes", async () => {
    const workspaceId = "ws-skip-tool-refresh";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    const refreshTools = mock(() => Promise.resolve(undefined));
    access.startServers = mock(() =>
      Promise.resolve(startResult([["server", { getPrompt, refreshTools }]]))
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const toolPathRefreshCount = refreshTools.mock.calls.length;
    expect(toolPathRefreshCount).toBeGreaterThan(0);

    // A hung tools/list on any server must not stall prompt listing or invocation.
    await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(refreshTools).toHaveBeenCalledTimes(toolPathRefreshCount);
  });

  test("blocks prompt invocation when trust is revoked during secret resolution", async () => {
    const workspaceId = "ws-secrets-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    manager.setSecretsResolver(() => {
      manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      return Promise.resolve({});
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when trust is revoked during a same-signature refresh", async () => {
    const workspaceId = "ws-cached-trust";
    // Arm after cold start so revocation lands inside the prompt refresh's
    // config derivation, where the same-signature fast path returns cached servers.
    let revokeOnNextTrustedList = false;
    configService.listServers = mock((_projectPath: string, trusted: boolean) => {
      if (revokeOnNextTrustedList && trusted) {
        revokeOnNextTrustedList = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      );
    });

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    revokeOnNextTrustedList = true;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("background prompt refresh never targets servers revoked by a concurrent mutation", async () => {
    const workspaceId = "ws-refresh-after-repair";
    // Revocation lands inside the cached send's config derivation, after the
    // trust overlay was read but before enablement repair runs.
    let revokeOnNextTrustedList = false;
    configService.listServers = mock((_projectPath: string, trusted: boolean) => {
      if (revokeOnNextTrustedList && trusted) {
        revokeOnNextTrustedList = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      );
    });
    const revokedRefresh = mock(() => Promise.resolve([]));
    const stableRefresh = mock(() => Promise.resolve([]));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { refreshPrompts: revokedRefresh }],
          ["stable", { refreshPrompts: stableRefresh }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    expect(revokedRefresh).toHaveBeenCalledTimes(1);

    revokeOnNextTrustedList = true;
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    await Bun.sleep(0);

    expect(revokedRefresh).toHaveBeenCalledTimes(1);
    expect(stableRefresh).toHaveBeenCalledTimes(2);
  });

  test("cold-start prompt refresh never targets servers revoked while startup was in flight", async () => {
    const workspaceId = "ws-cold-refresh-after-repair";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    const revokedRefresh = mock(() => Promise.resolve([]));
    const stableRefresh = mock(() => Promise.resolve([]));
    access.startServers = mock(() => {
      // Revocation lands while startServers is still in flight, before the
      // cold path caches the entry and refreshes prompts.
      manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      return Promise.resolve(
        startResult([
          ["server", { refreshPrompts: revokedRefresh }],
          ["stable", { refreshPrompts: stableRefresh }],
        ])
      );
    });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    expect(revokedRefresh).not.toHaveBeenCalled();
    expect(stableRefresh).toHaveBeenCalledTimes(1);
  });

  test("applies overrides recorded before the first workspace request (cold mutation)", async () => {
    const workspaceId = "ws-cold-overrides";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [name, { getPrompt }])
        )
      )
    );

    // workspace.mcp.set lands while the manager is cold (no recorded options,
    // no cache entry), then a caller that read pre-mutation persisted
    // overrides starts the workspace with a stale snapshot.
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.stats.enabledServerCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("excludes a server from prompt discovery when trust is revoked right after the refresh", async () => {
    const workspaceId = "ws-post-refresh-discovery-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { prompts: [{ name: "review" }] }],
          ["stable", { prompts: [{ name: "status" }] }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    // Revoke in the gap after the discovery refresh resolves but before the
    // enablement copy runs.
    const originalEnsure = access.ensureWorkspaceServers.bind(manager);
    let revokeAfterRefresh = true;
    access.ensureWorkspaceServers = async (...args: unknown[]) => {
      const result = await originalEnsure(...args);
      if (revokeAfterRefresh) {
        revokeAfterRefresh = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return result;
    };

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("overlays a trust revocation recorded before a cold workspace's first request", async () => {
    const workspaceId = "ws-cold-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { prompts: [{ name: "review" }] }],
          ["stable", { prompts: [{ name: "status" }] }],
        ])
      )
    );

    // Revocation lands while the workspace is cold (no recorded options), so
    // only the retained per-project trust can correct the stale snapshot the
    // stream captured before the revocation.
    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("closes late-started servers instead of caching them for a removed workspace", async () => {
    const workspaceId = "ws-removed-mid-startup";
    const close = mock(() => Promise.resolve());
    access.startServers = mock(async () => {
      // Workspace removal lands while startup is in flight: abort-abandoned
      // discovery keeps the startup running, and removal's stopServers finds
      // no cache entry to close.
      await manager.stopServers(workspaceId);
      return startResult([["server", { close }]]);
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(Object.keys(result.tools)).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(access.workspaceServers.has(workspaceId)).toBe(false);
  });

  test("prompt discovery refreshes with resolver-provided secrets and retries on mid-flight rotation", async () => {
    const request = workspaceRequest("workspace", { projectSecrets: { TOKEN: "recorded" } });
    access.lastWorkspaceRequestOptions.set("workspace", request);
    // First resolution returns the pre-rotation token; every later one returns
    // the rotated token, so the post-refresh recheck must force one retry.
    let resolveCount = 0;
    manager.setSecretsResolver(() => {
      resolveCount += 1;
      return Promise.resolve({ TOKEN: resolveCount === 1 ? "old" : "new" });
    });
    const ensureSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation((options) => {
      access.workspaceServers.set((options as { workspaceId: string }).workspaceId, {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([["coder", testInstance("coder", { prompts: [{ name: "status" }] })]]),
      });
      return Promise.resolve({ tools: {}, stats: cachedStats() });
    });

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));

    expect(descriptors.map((descriptor) => descriptor.promptName)).toEqual(["status"]);
    expect(ensureSpy).toHaveBeenCalledTimes(2);
    expect(ensureSpy.mock.calls[0]?.[0]).toEqual({ ...request, projectSecrets: { TOKEN: "old" } });
    expect(ensureSpy.mock.calls[1]?.[0]).toEqual({ ...request, projectSecrets: { TOKEN: "new" } });
    ensureSpy.mockRestore();
  });

  test("forgotten project trust no longer overrides a re-registered project's snapshot", async () => {
    const workspaceId = "ws-forgotten-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { prompts: [{ name: "review" }] }],
          ["stable", { prompts: [{ name: "status" }] }],
        ])
      )
    );

    // A trust grant retained past project removal must not resurrect on the
    // same path's next registration, which starts untrusted.
    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: true }]);
    manager.forgetProjectTrust(PROJECT_PATH);

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: false })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("excludes servers reconfigured while leased from prompt discovery", async () => {
    const workspaceId = "ws-stale-prompt-discovery";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
        stable: stdioConfig("cmd-stable"),
      })
    );

    const staleRefresh = mock(() => Promise.resolve([{ name: "review" }]));
    const stableRefresh = mock(() => Promise.resolve([{ name: "status" }]));
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { prompts: [{ name: "review" }], refreshPrompts: staleRefresh }],
          ["stable", { prompts: [{ name: "status" }], refreshPrompts: stableRefresh }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);
    command = "cmd-2";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    try {
      staleRefresh.mockClear();
      stableRefresh.mockClear();
      const descriptors = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
      expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
      // The stale instance still points at the old endpoint; discovery must
      // not send prompts/list there with potentially obsolete credentials.
      expect(staleRefresh).not.toHaveBeenCalled();
      expect(stableRefresh).toHaveBeenCalledTimes(1);
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  test("excludes a server when trust is revoked while its prompt catalog refresh is pending", async () => {
    const workspaceId = "ws-refresh-window-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    // Revoke inside prompts/list: the pre-mutation enabled-instance copy was
    // already taken when the mutation lands, so only a post-refresh counter
    // recheck can drop the now-disabled server's descriptors.
    let revokeOnFirstRefresh = true;
    const revokingRefresh = (list: Array<{ name: string }>) =>
      mock(() => {
        if (revokeOnFirstRefresh) {
          revokeOnFirstRefresh = false;
          manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
        }
        return Promise.resolve(list);
      });
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          [
            "server",
            {
              prompts: [{ name: "review" }],
              refreshPrompts: revokingRefresh([{ name: "review" }]),
            },
          ],
          [
            "stable",
            {
              prompts: [{ name: "status" }],
              refreshPrompts: revokingRefresh([{ name: "status" }]),
            },
          ],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("prompt discovery forwards the abort signal to prompt refreshes", async () => {
    const workspaceId = "ws-discovery-signal";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const refreshPrompts = mock((_options?: { signal?: AbortSignal }) => Promise.resolve([]));
    access.startServers = mock(() =>
      Promise.resolve(startResult([["server", { refreshPrompts }]]))
    );

    const controller = new AbortController();
    await manager.getPromptsForWorkspace(workspaceRequest(workspaceId), {
      signal: controller.signal,
    });
    expect(refreshPrompts).toHaveBeenCalledWith({ signal: controller.signal });

    controller.abort();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getPromptsForWorkspace(workspaceRequest(workspaceId), { signal: controller.signal })
    ).rejects.toThrow("aborted");
  });

  test("blocks prompt invocation when trust is revoked right after the prompt refresh", async () => {
    const workspaceId = "ws-post-refresh-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      )
    );

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    // Revoke in the gap after the prompt refresh resolves but before the
    // enablement check runs.
    const originalEnsure = access.ensureWorkspaceServers.bind(manager);
    let revokeAfterRefresh = true;
    access.ensureWorkspaceServers = async (...args: unknown[]) => {
      const result = await originalEnsure(...args);
      if (revokeAfterRefresh) {
        revokeAfterRefresh = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return result;
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation on a server disabled during cold startup", async () => {
    const workspaceId = "ws-mid-startup-disable";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: stdioConfig("cmd-1"),
        stable: stdioConfig("cmd-stable"),
      })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    let startCount = 0;
    access.startServers = mock(async () => {
      startCount += 1;
      if (startCount === 2) {
        // Settings mutation lands while the revival startup is in flight.
        await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
      }
      return startResult([
        ["server", { getPrompt }],
        ["stable", { getPrompt }],
      ]);
    });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Simulate an idle reap that retains recorded request options.
    access.workspaceServers.delete(workspaceId);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when a global disable lands during cold startup", async () => {
    const workspaceId = "ws-mid-startup-global-disable";
    let globallyDisabled = false;
    configService.listServers = mock(() =>
      Promise.resolve(
        globallyDisabled
          ? { stable: stdioConfig("cmd-stable") }
          : { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    let startCount = 0;
    access.startServers = mock(() => {
      startCount += 1;
      if (startCount === 2) {
        // Global mcp.setEnabled(false) completes while the revival startup is
        // in flight: it bumps the config generation but never replaces the
        // recorded per-workspace request options.
        globallyDisabled = true;
        configService.configGeneration += 1;
      }
      return Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      );
    });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Simulate an idle reap that retains recorded request options.
    access.workspaceServers.delete(workspaceId);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when a server's config is edited during cold startup", async () => {
    const workspaceId = "ws-mid-startup-config-edit";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig(command), stable: stdioConfig("cmd-stable") })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    let startCount = 0;
    access.startServers = mock(() => {
      startCount += 1;
      if (startCount === 2) {
        // Settings edits the server command while the revival startup is in
        // flight: the enabled set is unchanged, so only the start-config
        // signature reveals that the just-started instance is stale.
        command = "cmd-2";
        configService.configGeneration += 1;
      }
      return Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      );
    });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Simulate an idle reap that retains recorded request options.
    access.workspaceServers.delete(workspaceId);

    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    const entry = access.workspaceServers.get(workspaceId) as { configSignature: string };
    expect(entry.configSignature).toContain("cmd-2");
  });

  test("blocks prompt invocation when project trust is revoked during cold startup", async () => {
    const workspaceId = "ws-mid-startup-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    let startCount = 0;
    access.startServers = mock(() => {
      startCount += 1;
      if (startCount === 2) {
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve(
        startResult([
          ["server", { getPrompt }],
          ["stable", { getPrompt }],
        ])
      );
    });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    access.workspaceServers.delete(workspaceId);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("getToolsForWorkspace restarts when cached instances are marked closed", async () => {
    const workspaceId = "ws-closed";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: stdioConfig("cmd"),
      })
    );

    const close1 = mock(() => Promise.resolve(undefined));
    const close2 = mock(() => Promise.resolve(undefined));

    let startCount = 0;
    const startServersMock = mock(() => {
      startCount += 1;
      return Promise.resolve(
        startResult([["server", { close: startCount === 1 ? close1 : close2 }]])
      );
    });

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, { isClosed: boolean }>;
    };

    const instance = cached.instances.get("server");
    expect(instance).toBeTruthy();
    if (instance) {
      instance.isClosed = true;
    }

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(close1).toHaveBeenCalledTimes(1);
  });

  test("getToolsForWorkspace does not close healthy instances when restarting closed ones while leased", async () => {
    const workspaceId = "ws-closed-partial";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    const closeA1 = mock(() => Promise.resolve(undefined));
    const closeA2 = mock(() => Promise.resolve(undefined));
    const closeB1 = mock(() => Promise.resolve(undefined));

    let startCount = 0;
    const startServersMock = mock(() => {
      startCount += 1;

      if (startCount === 1) {
        return Promise.resolve(
          startResult([
            ["serverA", { close: closeA1 }],
            ["serverB", { close: closeB1 }],
          ])
        );
      }

      return Promise.resolve(startResult([["serverA", { close: closeA2 }]]));
    });

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, { isClosed: boolean }>;
    };

    const instanceA = cached.instances.get("serverA");
    expect(instanceA).toBeTruthy();
    if (instanceA) {
      instanceA.isClosed = true;
    }

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Restart should only close the dead instance.
    expect(closeA1).toHaveBeenCalledTimes(1);
    expect(closeB1).toHaveBeenCalledTimes(0);
  });

  test("getToolsForWorkspace does not return tools from newly-disabled servers while leased", async () => {
    const workspaceId = "ws-disable-while-leased";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    const startServersMock = mock(() =>
      Promise.resolve(
        startResult([
          ["serverA", { tools: { tool: testTool() } }],
          ["serverB", { tools: { tool: testTool() } }],
        ])
      )
    );

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    manager.acquireLease(workspaceId);

    const toolsResult = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverB"] } })
    );

    // Tool names are normalized to provider-safe keys (lowercase + underscore-delimited).
    expect(Object.keys(toolsResult.tools)).toContain("servera_tool");
    expect(Object.keys(toolsResult.tools)).not.toContain("serverb_tool");
  });

  test("getToolsForWorkspace filters disabled-server failures from leased stats", async () => {
    const workspaceId = "ws-disable-failed-while-leased";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    const startServersMock = mock(() =>
      Promise.resolve(
        startResult([["serverA", { tools: { tool: testTool() } }]], {
          failedServerNames: ["serverB"],
        })
      )
    );

    access.startServers = startServersMock;

    const initial = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(initial.stats.failedServerCount).toBe(1);

    manager.acquireLease(workspaceId);

    const leased = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverB"] } })
    );

    expect(startServersMock).toHaveBeenCalledTimes(1);
    expect(leased.stats.failedServerCount).toBe(0);
    expect(Object.keys(leased.tools)).toEqual(["servera_tool"]);
  });

  test("getToolsForWorkspace only exposes repo-defined servers for trusted projects", async () => {
    configService.listServers = mock((_projectPath: string, trusted?: boolean) =>
      Promise.resolve(
        trusted
          ? {
              global: stdioConfig("global-cmd"),
              repo: stdioConfig("repo-cmd"),
            }
          : {
              global: stdioConfig("global-cmd"),
            }
      )
    );

    const startServersMock = mock((servers: Record<string, unknown>) =>
      Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { tool: testTool() } }]))
      )
    );

    access.startServers = startServersMock as unknown as typeof access.startServers;

    const untrustedResult = await manager.getToolsForWorkspace(
      workspaceRequest("ws-untrusted-mcp", { trusted: false })
    );

    const trustedResult = await manager.getToolsForWorkspace(
      workspaceRequest("ws-trusted-mcp", { trusted: true })
    );

    expect(configService.listServers).toHaveBeenNthCalledWith(1, PROJECT_PATH, false, {
      agentPlugins: undefined,
    });
    expect(configService.listServers).toHaveBeenNthCalledWith(2, PROJECT_PATH, true, {
      agentPlugins: undefined,
    });
    expect(Object.keys(untrustedResult.tools)).toEqual(["global_tool"]);
    expect(Object.keys(trustedResult.tools).sort()).toEqual(["global_tool", "repo_tool"]);

    const firstStartedServers = startServersMock.mock.calls[0]?.[0];
    const secondStartedServers = startServersMock.mock.calls[1]?.[0];
    expect(Object.keys(firstStartedServers ?? {})).toEqual(["global"]);
    expect(Object.keys(secondStartedServers ?? {}).sort()).toEqual(["global", "repo"]);
  });
  test("lists namespaced prompt descriptors from connected instances", async () => {
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
    });
    access.workspaceServers.set("workspace", {
      enabledServerNames: new Set(["Coder Server"]),
      instances: new Map([
        [
          "Coder Server",
          testInstance("Coder Server", {
            prompts: [
              {
                name: "Code Review",
                description: "Review code",
                arguments: [{ name: "path", required: true }],
              },
            ],
          }),
        ],
      ]),
    });

    const listed = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stableKey).toMatch(/^mcp__coder_server__code_review_[0-9a-f]{8}$/);
    expect(listed[0]).toEqual({
      commandKey: "mcp__coder_server__code_review",
      stableKey: listed[0]?.stableKey ?? "",
      serverName: "Coder Server",
      promptName: "Code Review",
      description: "Review code",
      arguments: [{ name: "path", required: true }],
    });
    getToolsSpy.mockRestore();
  });

  test("forwards prompt arguments and flattens supported content", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        description: "Expanded review",
        messages: [
          { role: "user", content: { type: "text", text: "Review src" } },
          {
            role: "assistant",
            content: {
              type: "resource",
              resource: { uri: "file:///guide", text: "Use the guide" },
            },
          },
          {
            role: "assistant",
            content: { type: "image", data: "abc", mimeType: "image/png" },
          },
        ],
      })
    );
    access.workspaceServers.set("workspace", {
      enabledServerNames: new Set(["coder"]),
      instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
    });

    expect(await manager.getPrompt("workspace", "coder", "review", { path: "src" })).toEqual({
      description: "Expanded review",
      text: "Review src\n\n[assistant]\nUse the guide\n\n[assistant]\n[Image content omitted]",
    });
    expect(getPrompt).toHaveBeenCalledWith("review", { path: "src" }, undefined);
  });

  test("rejects empty and whitespace-only prompt expansions", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [{ role: "user", content: { type: "text", text: "   \n\n  " } }],
      })
    );
    access.workspaceServers.set("workspace", {
      enabledServerNames: new Set(["coder"]),
      instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "review", {})).rejects.toThrow(
      "MCP prompt 'coder/review' returned no text content"
    );
  });

  test("suffixes every member of a colliding prompt key group, independent of order", async () => {
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
    });
    const collectKeys = async (promptNames: string[]) => {
      access.workspaceServers.set("workspace", {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([
          ["coder", testInstance("coder", { prompts: promptNames.map((name) => ({ name })) })],
        ]),
      });
      const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
      return new Map(descriptors.map((d) => [d.promptName, d.commandKey]));
    };

    const keys = await collectKeys(["Code-Review", "code_review", "status"]);
    const reversedKeys = await collectKeys(["code_review", "Code-Review", "status"]);

    expect(keys.get("Code-Review")).toMatch(/^mcp__coder__code_review_[0-9a-f]{8}$/);
    expect(keys.get("code_review")).toMatch(/^mcp__coder__code_review_[0-9a-f]{8}$/);
    expect(keys.get("Code-Review")).not.toBe(keys.get("code_review"));
    expect(reversedKeys).toEqual(keys);
    expect(keys.get("status")).toBe("mcp__coder__status");

    const soloDescriptors = await (async () => {
      access.workspaceServers.set("workspace", {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([
          ["coder", testInstance("coder", { prompts: [{ name: "code_review" }] })],
        ]),
      });
      return manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    })();
    expect(soloDescriptors[0]?.commandKey).toBe("mcp__coder__code_review");
    expect(soloDescriptors[0]?.stableKey).toBe(keys.get("code_review") ?? "");
    getToolsSpy.mockRestore();
  });

  test("excludes disabled servers from prompt discovery and getPrompt", async () => {
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
    });
    access.workspaceServers.set("workspace", {
      enabledServerNames: new Set(["enabled"]),
      instances: new Map([
        ["enabled", testInstance("enabled", { prompts: [{ name: "status" }] })],
        ["disabled", testInstance("disabled", { prompts: [{ name: "review" }] })],
      ]),
    });

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    expect(descriptors.map((d) => d.commandKey)).toEqual(["mcp__enabled__status"]);
    expect(manager.getPrompt("workspace", "disabled", "review", {})).rejects.toThrow("disabled");
    getToolsSpy.mockRestore();
  });

  test("getPrompt revives reaped servers from the last workspace request options", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    const request = workspaceRequest("workspace");
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation(() => {
      access.workspaceServers.set("workspace", {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      return Promise.resolve({ tools: {}, stats: cachedStats() });
    });
    access.lastWorkspaceRequestOptions.set("workspace", request);

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({
      text: "Status",
    });
    expect(getToolsSpy).toHaveBeenCalledWith(request, false);
    getToolsSpy.mockRestore();
  });

  test("getPrompt fails when the server is gone and no restart options are cached", () => {
    expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow("not connected");
  });

  test("serializes config-change restarts across concurrent workspace requests", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd-a") }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startServersMock = mock(async () => {
      if (startServersMock.mock.calls.length > 1) await startGate;
      return startResult([["coder"]]);
    });
    access.startServers = startServersMock;

    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    expect(startServersMock).toHaveBeenCalledTimes(1);

    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd-b") }));
    const first = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const second = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    releaseStart();
    await Promise.all([first, second]);

    expect(startServersMock).toHaveBeenCalledTimes(2);
  });

  test("serializes cold-start server startup across concurrent workspace requests", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startServersMock = mock(async () => {
      await startGate;
      return startResult([["coder"]]);
    });
    access.startServers = startServersMock;

    const first = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const second = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    releaseStart();
    await Promise.all([first, second]);

    expect(startServersMock).toHaveBeenCalledTimes(1);
  });

  test("getPrompt re-evaluates current config before invoking a cached prompt", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock((servers: unknown) => {
      const names = Object.keys(servers as Record<string, unknown>);
      return Promise.resolve(
        startResult(
          names.map((name) => [name, { getPrompt }] as [string, { getPrompt: typeof getPrompt }])
        )
      );
    });

    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });

    configService.listServers = mock(() => Promise.resolve({}));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow("disabled");
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("getPrompt caps expansion bytes for non-ASCII content shared with the composer path", async () => {
    // 64k "€" chars encode to ~192KB UTF-8, triple the nominal cap.
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "€".repeat(64 * 1024) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() => Promise.resolve(startResult([["coder", { getPrompt }]])));
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    const result = await manager.getPrompt("workspace", "coder", "status", {});

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      MCP_PROMPT_MAX_TEXT_BYTES + MCP_PROMPT_TRUNCATION_MARKER.length
    );
    expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
    expect(result.text).not.toContain("\uFFFD");
  });

  test("getPrompt rejects an oversized whitespace-only expansion instead of passing the marker off as content", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: " ".repeat(2 * MCP_PROMPT_MAX_TEXT_BYTES) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() => Promise.resolve(startResult([["coder", { getPrompt }]])));
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow(
      "returned no text content"
    );
  });

  test("getPrompt never encodes more than the byte budget for a huge expansion", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "a".repeat(10 * 1024 * 1024) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() => Promise.resolve(startResult([["coder", { getPrompt }]])));
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const fromSpy = spyOn(Buffer, "from");

    try {
      const result = await manager.getPrompt("workspace", "coder", "status", {});

      expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
      // The transient encoding copy is bounded by the budget, not input size.
      for (const call of fromSpy.mock.calls) {
        const input = call[0];
        if (typeof input === "string") {
          expect(input.length).toBeLessThanOrEqual(MCP_PROMPT_MAX_TEXT_BYTES);
        }
      }
    } finally {
      fromSpy.mockRestore();
    }
  });

  test("getPrompt emits a single truncation marker when flattening also truncated", async () => {
    const block = "a".repeat(40 * 1024);
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          { role: "user" as const, content: { type: "text" as const, text: block } },
          { role: "user" as const, content: { type: "text" as const, text: block } },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    access.startServers = mock(() => Promise.resolve(startResult([["coder", { getPrompt }]])));
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    const result = await manager.getPrompt("workspace", "coder", "status", {});

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      MCP_PROMPT_MAX_TEXT_BYTES + MCP_PROMPT_TRUNCATION_MARKER.length
    );
    expect(result.text.split("[Prompt text truncated]")).toHaveLength(2);
    expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
  });

  test("applyProjectTrust flips recorded trust so getPrompt refreshes untrusted", async () => {
    const request = workspaceRequest("workspace", { trusted: true });
    const otherRequest = workspaceRequest("other-workspace", {
      projectPath: "/tmp/other-project",
      trusted: true,
    });
    access.lastWorkspaceRequestOptions.set("workspace", request);
    access.lastWorkspaceRequestOptions.set("other-workspace", otherRequest);

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation((options) => {
      access.workspaceServers.set((options as { workspaceId: string }).workspaceId, {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      return Promise.resolve({ tools: {}, stats: cachedStats() });
    });

    manager.applyProjectTrust([
      { projectPath: `${PROJECT_PATH}/`, trusted: false },
      { projectPath: "/tmp/other-project", trusted: true },
    ]);
    await manager.getPrompt("workspace", "coder", "status", {});

    expect(getToolsSpy).toHaveBeenCalledWith({ ...request, trusted: false }, false);
    expect(access.lastWorkspaceRequestOptions.get("other-workspace")).toBe(otherRequest);
    getToolsSpy.mockRestore();
  });

  test("getPrompt refreshes with resolver-provided secrets instead of the recorded snapshot", async () => {
    const request = workspaceRequest("workspace", { projectSecrets: { TOKEN: "old" } });
    access.lastWorkspaceRequestOptions.set("workspace", request);
    manager.setSecretsResolver(() => Promise.resolve({ TOKEN: "new" }));

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation((options) => {
      access.workspaceServers.set((options as { workspaceId: string }).workspaceId, {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      return Promise.resolve({ tools: {}, stats: cachedStats() });
    });

    await manager.getPrompt("workspace", "coder", "status", {});

    expect(getToolsSpy).toHaveBeenCalledWith(
      { ...request, projectSecrets: { TOKEN: "new" } },
      false
    );
    getToolsSpy.mockRestore();
  });

  test("getPrompt falls back to the recorded secrets snapshot when the resolver fails", async () => {
    const request = workspaceRequest("workspace", { projectSecrets: { TOKEN: "old" } });
    access.lastWorkspaceRequestOptions.set("workspace", request);
    manager.setSecretsResolver(() => Promise.reject(new Error("config unavailable")));

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation((options) => {
      access.workspaceServers.set((options as { workspaceId: string }).workspaceId, {
        enabledServerNames: new Set(["coder"]),
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      return Promise.resolve({ tools: {}, stats: cachedStats() });
    });

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });
    expect(getToolsSpy).toHaveBeenCalledWith(request, false);
    getToolsSpy.mockRestore();
  });

  test("getPrompt rejects promptly when aborted during refresh startup", async () => {
    access.lastWorkspaceRequestOptions.set("workspace", workspaceRequest("workspace"));
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockImplementation(
      () => new Promise<never>(() => undefined)
    );
    const controller = new AbortController();
    const promptPromise = manager.getPrompt(
      "workspace",
      "coder",
      "status",
      {},
      { signal: controller.signal }
    );
    controller.abort();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(promptPromise).rejects.toThrow("was aborted");
    getToolsSpy.mockRestore();
  });

  test("flattens audio and binary resources as omission markers", () => {
    expect(
      flattenMcpPrompt({
        messages: [
          {
            role: "user",
            content: { type: "audio", data: "abc", mimeType: "audio/wav" },
          },
          {
            role: "user",
            content: { type: "resource", resource: { uri: "file:///blob", blob: "abc" } },
          },
        ],
      })
    ).toBe("[Audio content omitted]\n\n[Resource content omitted]");
  });

  test("flattenMcpPrompt accumulates only a bounded prefix of oversized expansions", () => {
    const block = "a".repeat(40 * 1024);
    const flattened = flattenMcpPrompt({
      messages: [
        { role: "user", content: { type: "text", text: block } },
        { role: "assistant", content: { type: "text", text: block } },
        { role: "user", content: { type: "text", text: block } },
      ],
    });

    expect(flattened.endsWith(MCP_PROMPT_TRUNCATION_MARKER)).toBe(true);
    // Pre-marker text must exceed the byte cap so the tool-level truncation
    // always fires and replaces the marker at a clean boundary.
    const preMarker = flattened.length - MCP_PROMPT_TRUNCATION_MARKER.length;
    expect(preMarker).toBeGreaterThan(MCP_PROMPT_MAX_TEXT_BYTES);
    expect(preMarker).toBeLessThanOrEqual(MCP_PROMPT_MAX_TEXT_BYTES + 2);
    expect(flattened.startsWith(block)).toBe(true);
    expect(flattened).toContain("[assistant]\n");
  });

  test("test() includes oauthChallenge when server responds 401 + WWW-Authenticate Bearer", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth challenge test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const result = await manager.test({
        projectPath: PROJECT_PATH,
        transport: "http",
        url: baseUrl,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected test() to fail");
      }

      expect(result.oauthChallenge).toEqual({
        scope: "mcp.read",
        resourceMetadataUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("test() includes oauthChallenge when auth is only advertised on POST", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((req, res) => {
      if (req.method === "POST") {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "invalid_token",
            error_description: "Authentication failed.",
          })
        );
        return;
      }

      res.statusCode = 405;
      res.setHeader("Allow", "POST, DELETE");
      res.end("Method Not Allowed");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind POST-only OAuth challenge test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const result = await manager.test({
        projectPath: PROJECT_PATH,
        transport: "auto",
        url: baseUrl,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected test() to fail");
      }

      expect(result.oauthChallenge).toEqual({
        scope: "mcp.read",
        resourceMetadataUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("tool execution failure with closed-client error marks instance isClosed for restart", async () => {
    const workspaceId = "ws-tool-closed";
    configService.listServers = mock(() =>
      Promise.resolve({
        "test-server": stdioConfig("cmd"),
      })
    );

    const closedError = new Error("Attempted to send a request from a closed client");
    const dummyTool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const startServersMock = mock(() => {
      const tools: Record<string, Tool> = {};
      const instance = {
        name: "test-server",
        resolvedTransport: "stdio" as const,
        autoFallbackUsed: false,
        tools,
        prompts: [],
        isClosed: false,
        close: mock(() => Promise.resolve(undefined)),
      };

      instance.tools = wrapMCPTools(
        { failTool: dummyTool },
        {
          onClosed: () => {
            instance.isClosed = true;
          },
        }
      );

      return Promise.resolve({
        instances: new Map([["test-server", instance]]),
        failedServerNames: [],
      });
    });

    access.startServers = startServersMock;

    const result1 = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(startServersMock).toHaveBeenCalledTimes(1);

    const firstTool = Object.values(result1.tools)[0];
    expect(firstTool).toBeDefined();
    if (!firstTool?.execute) {
      throw new Error("Expected wrapped MCP tool to include execute");
    }

    let firstToolError: unknown;
    try {
      await firstTool.execute({}, {} as never);
    } catch (error) {
      firstToolError = error;
    }
    expect(firstToolError).toBe(closedError);

    const cached = access.workspaceServers.get(workspaceId) as
      | { instances: Map<string, { isClosed: boolean }> }
      | undefined;

    expect(cached).toBeDefined();

    const instances = cached?.instances;
    expect(instances).toBeDefined();
    for (const [, inst] of instances ?? []) {
      expect(inst.isClosed).toBe(true);
    }

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(startServersMock).toHaveBeenCalledTimes(2);
  });

  // --- Agent Plugins (agent-plugins experiment) ---

  const PLUGIN_KEY = "plugin:abcdef0123456789:everything";

  function pluginStdioConfig(overrides: Record<string, unknown> = {}) {
    return {
      [PLUGIN_KEY]: {
        transport: "stdio" as const,
        command: "bunx",
        args: ["-y", "some-server"],
        env: { PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: "/tmp/mux-test-plugin-data" },
        cwd: "/plugins/demo",
        disabled: true,
        plugin: {
          pluginName: "demo",
          serverName: "everything",
          sourceScope: "global" as const,
          sourceLocation: ".mux/plugins/demo",
        },
        ...overrides,
      },
    };
  }

  test("default-disabled plugin servers start only with a workspace enabledServers override", async () => {
    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));
    const startServersMock = spyOn(access, "startServers").mockImplementation(
      (...args: unknown[]) => {
        const servers = args[0] as Record<string, unknown>;
        return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
      }
    );

    const withoutOverride = await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-off"));
    expect(withoutOverride.stats.enabledServerCount).toBe(0);

    const withOverride = await manager.getToolsForWorkspace(
      workspaceRequest("ws-plugin-on", { overrides: { enabledServers: [PLUGIN_KEY] } })
    );
    expect(withOverride.stats.enabledServerCount).toBe(1);
    const startedServers = startServersMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(startedServers)).toEqual([PLUGIN_KEY]);
  });

  test("plugin servers are excluded on off-host runtimes (remote and devcontainer)", async () => {
    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));
    spyOn(access, "startServers").mockImplementation(() => Promise.resolve(startResult([])));

    // Runtime identity is all the gate needs; both classes exec off-host.
    // DevcontainerRuntime extends LocalBaseRuntime but execs inside the container.
    const offHostRuntimes: Array<[string, Runtime]> = [
      ["ws-plugin-remote", Object.create(RemoteRuntime.prototype) as Runtime],
      ["ws-plugin-devcontainer", Object.create(DevcontainerRuntime.prototype) as Runtime],
    ];
    for (const [workspaceId, runtime] of offHostRuntimes) {
      const result = await manager.getToolsForWorkspace(
        workspaceRequest(workspaceId, {
          runtime,
          overrides: { enabledServers: [PLUGIN_KEY] },
        })
      );

      expect(result.stats.enabledServerCount).toBe(0);
    }
  });

  test("threads the agentPlugins context through to config listing", async () => {
    configService.listServers = mock(() => Promise.resolve({}));
    spyOn(access, "startServers").mockImplementation(() => Promise.resolve(startResult([])));

    const context = { projectRoot: "/worktrees/ws-1", projectKey: PROJECT_PATH };
    await manager.getToolsForWorkspace(
      workspaceRequest("ws-plugin-ctx", { agentPlugins: context })
    );
    expect(configService.listServers).toHaveBeenLastCalledWith(PROJECT_PATH, false, {
      agentPlugins: context,
    });

    await manager.listServers(PROJECT_PATH, undefined, true, null);
    expect(configService.listServers).toHaveBeenLastCalledWith(PROJECT_PATH, true, {
      agentPlugins: null,
    });
  });

  test("stdio config signature includes args/env/cwd so plugin mcp.json edits recycle servers", async () => {
    const startServersMock = spyOn(access, "startServers").mockImplementation(() =>
      Promise.resolve(startResult([[PLUGIN_KEY, undefined]]))
    );
    const overrides = { enabledServers: [PLUGIN_KEY] };

    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(startServersMock).toHaveBeenCalledTimes(1);

    // Same command, changed args: signature must change and servers restart.
    configService.listServers = mock(() =>
      Promise.resolve(pluginStdioConfig({ args: ["-y", "some-server", "--changed"] }))
    );
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(startServersMock).toHaveBeenCalledTimes(2);

    // Unchanged config: cached instances are reused.
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(startServersMock).toHaveBeenCalledTimes(2);
  });
});

describe("prepareStdioLaunch", () => {
  test("keeps legacy raw shell-string behavior when args is unset", async () => {
    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx -y some-server",
      disabled: false,
    });
    expect(launch).toEqual({ command: "bunx -y some-server" });
  });

  test("argv mode quotes command and each arg against shell injection", async () => {
    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "/plugins/my plugin/bin/tool",
      args: ["a b", "$(rm -rf /)", "`tick`", "it's", ""],
      disabled: false,
    });
    expect(launch.command).toBe(
      "'/plugins/my plugin/bin/tool' 'a b' '$(rm -rf /)' '`tick`' 'it'\"'\"'s' ''"
    );
  });

  test("creates the PLUGIN_DATA directory for plugin servers before launch", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      cwd: tmp.path,
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
    expect(launch.cwd).toBe(tmp.path);
    expect(launch.env?.PLUGIN_DATA).toBe(dataPath);
    // Plugin-root cwd is shipped plugin content: never created by launch.
    expect(await fs.readdir(tmp.path)).toEqual(["plugin-data"]);
  });

  test("creates a nested PLUGIN_DATA cwd recursively before launch", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-nested");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");
    const nestedCwd = path.join(dataPath, "nested", "deep");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      cwd: nestedCwd,
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    // exec() requires an existing cwd; data-dir cwds are client-managed state.
    expect((await fs.stat(nestedCwd)).isDirectory()).toBe(true);
    expect(launch.cwd).toBe(nestedCwd);
  });

  test("quarantines a stray file occupying the PLUGIN_DATA path and still launches", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-corrupt");
    // Corrupt state: plugin-data (the PARENT of every instance dir) is a file.
    const dataRoot = path.join(tmp.path, "plugin-data");
    await fs.writeFile(dataRoot, "not a directory", "utf8");
    const dataPath = path.join(dataRoot, "abc123");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
    expect(launch.env?.PLUGIN_DATA).toBe(dataPath);
    // The stray file is quarantined (renamed), not deleted.
    const quarantined = (await fs.readdir(tmp.path)).find((name) =>
      name.startsWith("plugin-data.corrupt-")
    );
    expect(quarantined).toBeDefined();
    expect(await fs.readFile(path.join(tmp.path, quarantined!), "utf8")).toBe("not a directory");
  });

  test("quarantines a file occupying the instance data dir itself", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-corrupt-leaf");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");
    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    await fs.writeFile(dataPath, "stale blob", "utf8");

    await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
  });

  test("rejects plugin servers without an absolute PLUGIN_DATA env (defensive)", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      prepareStdioLaunch({
        transport: "stdio",
        command: "bunx",
        args: [],
        disabled: false,
        plugin: {
          pluginName: "demo",
          serverName: "srv",
          sourceScope: "global",
          sourceLocation: ".mux/plugins/demo",
        },
      })
    ).rejects.toThrow("PLUGIN_DATA");
  });
});

describe("isClosedClientError", () => {
  for (const message of [
    "Attempted to send a request from a closed client",
    "Connection closed",
    "MCP SSE Transport Error: Connection closed unexpectedly",
    "MCP SSE Transport Error: Not connected",
  ]) {
    test(`returns true for '${message}'`, () => {
      expect(isClosedClientError(new Error(message))).toBe(true);
    });
  }

  test("returns true for chained error with closed-client cause", () => {
    const cause = new Error("Connection closed");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(true);
  });

  test("returns false for chained error without closed-client cause", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(false);
  });

  test("returns false for unrelated errors and non-Error values", () => {
    for (const value of [
      new Error("timeout"),
      new Error("ECONNREFUSED"),
      null,
      undefined,
      "string error",
    ]) {
      expect(isClosedClientError(value)).toBe(false);
    }
  });
});

describe("wrapMCPTools", () => {
  test("converts MCP application failures into tool errors without recycling the client", async () => {
    const onActivity = mock(() => undefined);
    const onClosed = mock(() => undefined);
    const tool = {
      execute: mock(() =>
        Promise.resolve({
          isError: true,
          content: [
            { type: "text", text: "statusUpdateType requires statusUpdateId" },
            {
              type: "resource",
              resource: { uri: "linear://issue/CODAGT-709", text: "Linear rejected the call" },
            },
          ],
        })
      ),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onActivity, onClosed });

    let caught: unknown;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MCPToolCallError);
    expect((caught as Error).message).toContain("statusUpdateType requires statusUpdateId");
    expect((caught as Error).message).toContain("Linear rejected the call");
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  test("does not recycle the client when application error text resembles a closed client", async () => {
    const onClosed = mock(() => undefined);
    const tool = {
      execute: mock(() =>
        Promise.resolve({
          isError: true,
          content: [{ type: "text", text: "Not connected to the external account" }],
        })
      ),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    let caught: unknown;
    try {
      await Promise.resolve(wrapped.myTool.execute!({}, {} as never));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MCPToolCallError);
    expect(onClosed).not.toHaveBeenCalled();
  });

  for (const [message, expectedOnClosedCalls] of [
    ["Attempted to send a request from a closed client", 1],
    ["some other failure", 0],
  ] as const) {
    test(`calls onClosed ${expectedOnClosedCalls} times for '${message}'`, async () => {
      const onClosed = mock(() => undefined);
      const expectedError = new Error(message);
      const tool = {
        execute: mock(() => Promise.reject(expectedError)),
        parameters: {},
      } as unknown as Tool;

      const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

      let executeError: unknown;
      try {
        await wrapped.myTool.execute!({}, {} as never);
      } catch (error) {
        executeError = error;
      }

      expect(executeError).toBe(expectedError);
      expect(onClosed).toHaveBeenCalledTimes(expectedOnClosedCalls);
    });
  }

  test("wraps multiple tools and failure in one does not affect others", async () => {
    const onClosed = mock(() => undefined);
    const failTool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;
    const okTool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ failTool, okTool }, { onClosed });

    // failTool should throw and trigger onClosed
    try {
      await wrapped.failTool.execute!({}, {} as never);
      throw new Error("Expected failTool to throw");
    } catch (e) {
      expect((e as Error).message).toBe("Attempted to send a request from a closed client");
    }
    expect(onClosed).toHaveBeenCalledTimes(1);

    // okTool should still work fine
    const result: unknown = await wrapped.okTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("onClosed throwing does not mask original error", async () => {
    const onClosed = mock(() => {
      throw new Error("onClosed exploded");
    });
    const closedError = new Error("Attempted to send a request from a closed client");
    const tool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });
    try {
      await wrapped.myTool.execute!({}, {} as never);
      throw new Error("Expected to throw");
    } catch (e) {
      // Original error should be preserved, NOT the onClosed error
      expect(e).toBe(closedError);
    }
    // onClosed was still called (even though it threw)
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("calls onActivity before execute and still calls it on failure", async () => {
    const onActivity = mock(() => undefined);
    const onClosed = mock(() => undefined);
    const tool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onActivity, onClosed });

    let didThrow = false;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  test("rejects with Interrupted when aborted during execution", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<unknown>();
    const tool = {
      execute: mock(() => pending.promise),
      parameters: {},
    } as unknown as Tool;

    const onClosed = mock(() => undefined);
    const wrapped = wrapMCPTools({ hangTool: tool }, { onClosed });

    const promise = wrapped.hangTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    controller.abort();

    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect((caught as Error).name).toBe("MCPDeadlineError");
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const executeMock = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const tool = {
      execute: executeMock,
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const promise = wrapped.myTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("does NOT call onClosed for upstream error containing 'timed out'", async () => {
    const onClosed = mock(() => undefined);
    const timeoutError = new Error("upstream request timed out");
    const tool = {
      execute: mock(() => Promise.reject(timeoutError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    const promise = wrapped.myTool.execute!({}, {} as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream request timed out");
    expect(onClosed).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline rejects with MCPDeadlineError after timeout", async () => {
    const { promise } = Promise.withResolvers<unknown>();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(() => promise, {
        toolName: "slowTool",
        timeoutMs: 50,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("timed out");
    expect((caught as Error).message).toContain("slowTool");
    expect((caught as Error).name).toBe("MCPDeadlineError");
  });

  test("runMCPToolWithDeadline skips start when pre-aborted", async () => {
    const startFn = mock(() => Promise.resolve("should not run"));
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(startFn, {
        toolName: "test",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(startFn).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline clears timeout when abort wins", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const { promise } = Promise.withResolvers<unknown>();
      const controller = new AbortController();

      // Start the deadline race with a hung promise, then abort.
      const resultPromise = runMCPToolWithDeadline(() => promise, {
        toolName: "hangingTool",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
      controller.abort();

      let caught: unknown;
      try {
        await resultPromise;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Interrupted");
      // The timeout timer must be cleared eagerly when abort wins —
      // not left dangling for 5 minutes.
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("passes through successful execution results", async () => {
    const tool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const result: unknown = await wrapped.myTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("skips wrapping tools without execute", () => {
    const tool = {
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ noExec: tool });
    expect(wrapped.noExec).toBe(tool);
  });
});
