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
import {
  acquirePluginMutationLock,
  MUTATION_EPOCH_UNREADABLE_TOKEN,
} from "@/node/services/agentPlugins/journals";
import { readPluginMcpPolicy } from "./agentPlugins/registry";
import { createTestPluginInstallEntry } from "./agentPlugins/testFixtures";
import type { MCPServerInfo } from "@/common/types/mcp";
import * as mcpSdk from "@/node/services/mcpClient";
import {
  MCPServerManager,
  flattenMcpPrompt,
  isClosedClientError,
  prepareStdioLaunch,
  runMCPToolWithDeadline,
  wrapMCPTools,
  type MCPWorkspaceRequestOptions,
  type MCPServerManagerOptions,
} from "./mcpServerManager";
import { MCPConfigService } from "./mcpConfigService";
import { Config } from "@/node/config";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TelemetryService } from "./telemetryService";
import type { Runtime } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { jsonSchema, type Tool } from "ai";

interface MCPServerManagerTestAccess {
  workspaceServers: Map<string, unknown>;
  lastWorkspaceRequestOptions: Map<string, unknown>;
  cleanupIdleServers: () => void;
  ensureWorkspaceServers: (
    ...args: unknown[]
  ) => Promise<{ tools: Record<string, Tool>; stats: unknown; enablementDerivedFrom?: unknown }>;
  startServers: (...args: unknown[]) => Promise<{
    instances: Map<string, unknown>;
    failedServerNames: string[];
    timedOutServerNames?: string[];
  }>;
  startSingleServer: (...args: unknown[]) => Promise<unknown>;
  runWithStablePluginEpoch: (operation: () => Promise<unknown>) => Promise<unknown>;
  startSingleServerImpl: (...args: unknown[]) => Promise<unknown>;
}

const PROJECT_PATH = "/tmp/project";
const WORKSPACE_PATH = "/tmp/workspace";

/** Poll a synchronous predicate until it holds (bounded), yielding real time between checks. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
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
    getPrompt: options.getPrompt ?? mock(() => Promise.resolve({ messages: [], context: {} })),
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

  async function componentFixture(home: string) {
    await fs.mkdir(path.join(home, "plugins"), { recursive: true });
    const registryPath = path.join(home, "plugins.json");
    const write = async (names: string[]) => {
      const release = await acquirePluginMutationLock(home, { timeoutMs: 5000 });
      try {
        await fs.writeFile(
          `${registryPath}.tmp`,
          JSON.stringify({
            plugins: [createTestPluginInstallEntry("demo", { skills: [], mcpServers: names })],
          })
        );
        await fs.rename(`${registryPath}.tmp`, registryPath);
      } finally {
        await release();
      }
    };
    await write(["remove", "keep"]);
    const configs: Record<string, MCPServerInfo> = { ordinary: stdioConfig("ordinary") };
    for (const name of ["remove", "keep", "added"]) {
      configs[`plugin:instance:${name}`] = {
        ...stdioConfig(name),
        env: { PLUGIN_DATA: path.join(home, "data", name) },
        plugin: {
          pluginName: "demo",
          serverName: name,
          sourceScope: "global",
          sourceLocation: "plugins/demo",
          componentPolicy: { registryPath, name: "demo" },
        },
      };
    }
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const read = mock(() => readPluginMcpPolicy(registryPath));
    const makeManager = () => {
      const invalidation: NonNullable<MCPServerManagerOptions["pluginInvalidation"]> = {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(undefined),
        readComponentPolicy: read,
        tryAcquireComponentPolicyLock: (options) =>
          acquirePluginMutationLock(home, { timeoutMs: 0, ...options }),
      };
      const instance = new MCPServerManager(configService as unknown as MCPConfigService, {
        pluginInvalidation: invalidation,
      });
      const internals = instance as unknown as MCPServerManagerTestAccess;
      const started: Array<ReturnType<typeof testInstance>> = [];
      internals.startSingleServer = mock((name: unknown) => {
        const client = testInstance(String(name), {
          tools: { echo: testTool() },
          prompts: [{ name: "review" }],
          getPrompt: mock(() =>
            Promise.resolve({
              messages: [{ role: "user", content: { type: "text", text: "review" } }],
            })
          ),
        });
        started.push(client);
        return Promise.resolve(client);
      });
      return { instance, internals, started, invalidation };
    };
    manager.dispose();
    const local = makeManager();
    manager = local.instance;
    access = local.internals;
    return { ...local, registryPath, write, configs, read, makeManager };
  }

  test.each([false, true])(
    "component removal preserves sibling identity (leased: %s)",
    async (leased) => {
      using tmp = new DisposableTempDir("mcp-components");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("components");
      const before = await manager.getToolsForWorkspace(request);
      const removed = f.started.find((i) => i.name.endsWith(":remove"))!;
      const retained = f.started.filter((i) => i !== removed);
      if (leased) manager.acquireLease(request.workspaceId);
      await f.write(["keep"]);
      await manager.reconcilePluginComponents();
      const after = await manager.getToolsForWorkspace(request);
      expect(Object.values(after.toolServerNames).sort()).toEqual([
        "ordinary",
        "plugin:instance:keep",
      ]);
      expect(after.stats.enabledServerCount).toBe(2);
      const entry = access.workspaceServers.get(request.workspaceId) as {
        instances: Map<string, unknown>;
        timedOutServerNames: string[];
        enabledServerNames: Set<string>;
      };
      for (const client of retained) {
        expect(entry.instances.get(client.name)).toBe(client);
        expect(client.close).not.toHaveBeenCalled();
      }
      expect(entry.timedOutServerNames).not.toContain(removed.name);
      expect(entry.enabledServerNames.has(removed.name)).toBe(false);
      const toolName = Object.keys(before.toolServerNames).find(
        (key) => before.toolServerNames[key] === removed.name
      )!;
      expect(
        before.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
      ).rejects.toThrow(/disabled|unavailable/);
      expect(manager.getPrompt(request.workspaceId, removed.name, "review", {})).rejects.toThrow();
      expect(removed.tools.echo.execute).not.toHaveBeenCalled();
      if (leased) {
        expect(removed.close).not.toHaveBeenCalled();
        manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
      expect(removed.close).toHaveBeenCalledTimes(1);
      expect(f.started).toHaveLength(3);
    }
  );

  test.each([false, true])(
    "component cleanup failures remain retryable without blocking retained clients (readd: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-component-cleanup-retry");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("cleanup-retry");
      const served = await manager.getToolsForWorkspace(request);
      const removed = f.started.find((instance) => instance.name.endsWith(":remove"))!;
      const retained = f.started.filter((instance) => instance !== removed);
      let failClose = true;
      const close = spyOn(removed as { close: () => Promise<void> }, "close").mockImplementation(
        () =>
          failClose ? Promise.reject(new Error("removed client close failed")) : Promise.resolve()
      );
      try {
        await f.write(["keep"]);
        const error: unknown = await manager
          .reconcilePluginComponents()
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("removed client close failed");
        const entry = access.workspaceServers.get(request.workspaceId) as {
          instances: Map<string, unknown>;
          retiredPluginInstances?: Set<unknown>;
        };
        expect(entry.retiredPluginInstances?.has(removed)).toBe(true);
        const after = await manager.getToolsForWorkspace(request);
        expect(Object.values(after.toolServerNames).sort()).toEqual([
          "ordinary",
          "plugin:instance:keep",
        ]);
        expect(close.mock.calls.length).toBeGreaterThan(1);
        const toolName = Object.keys(served.toolServerNames).find(
          (key) => served.toolServerNames[key] === removed.name
        )!;
        const heldError: unknown = await Promise.resolve(
          served.tools[toolName].execute!({}, { toolCallId: "removed", messages: [], context: {} })
        ).catch((error: unknown) => error);
        expect(heldError).toBeInstanceOf(Error);
        expect(removed.tools.echo.execute).not.toHaveBeenCalled();
        if (readd) {
          await f.write(["keep", "remove"]);
          const readded = await manager.getToolsForWorkspace(request);
          expect(Object.values(readded.toolServerNames)).toContain(removed.name);
          expect(entry.instances.get(removed.name)).not.toBe(removed);
        }
        failClose = false;
        const attempts = close.mock.calls.length;
        await manager.getToolsForWorkspace(request);
        expect(close).toHaveBeenCalledTimes(attempts + 1);
        expect(entry.retiredPluginInstances?.size ?? 0).toBe(0);
        await manager.reconcilePluginComponents();
        expect(close).toHaveBeenCalledTimes(attempts + 1);
        for (const instance of retained) {
          expect(entry.instances.get(instance.name)).toBe(instance);
          expect(instance.close).not.toHaveBeenCalled();
        }
      } finally {
        close.mockRestore();
      }
    }
  );

  test.each([false, true])(
    "prefix stops include retired leased clients without reviving removals (readd: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-retired-prefix");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("retired-prefix");
      const first = await manager.getToolsForWorkspace(request);
      const removed = f.started.find((instance) => instance.name.endsWith(":remove"))!;
      const retained = f.started.filter((instance) => instance !== removed);
      manager.acquireLease(request.workspaceId);
      try {
        await f.write(["keep"]);
        await manager.getToolsForWorkspace(request);
        if (readd) {
          await f.write(["keep", "remove"]);
          await manager.getToolsForWorkspace(request);
        }
        const entry = access.workspaceServers.get(request.workspaceId) as {
          instances: Map<string, unknown>;
          retiredPluginInstances?: Set<unknown>;
          timedOutServerNames: string[];
        };
        expect(entry.retiredPluginInstances?.has(removed)).toBe(true);
        await manager.stopServersWithKeyPrefix(removed.name);
        expect(removed.close).toHaveBeenCalledTimes(1);
        expect(entry.retiredPluginInstances?.has(removed) ?? false).toBe(false);
        expect(entry.timedOutServerNames.includes(removed.name)).toBe(readd);
        for (const instance of retained) {
          expect(entry.instances.get(instance.name)).toBe(instance);
          expect(instance.close).not.toHaveBeenCalled();
        }
        if (!readd) {
          const toolName = Object.keys(first.toolServerNames).find(
            (key) => first.toolServerNames[key] === removed.name
          )!;
          const error: unknown = await Promise.resolve(
            first.tools[toolName].execute!({}, { toolCallId: "stopped", messages: [], context: {} })
          ).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(removed.tools.echo.execute).not.toHaveBeenCalled();
        }
      } finally {
        manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
      expect(removed.close).toHaveBeenCalledTimes(1);
    }
  );

  test("idle cleanup retries retired-only failures without another MCP request", async () => {
    using tmp = new DisposableTempDir("mcp-retired-idle");
    const f = await componentFixture(tmp.path);
    delete f.configs.ordinary;
    const request = workspaceRequest("retired-idle");
    await manager.getToolsForWorkspace(request);
    const removed = f.started.find((instance) => instance.name.endsWith(":remove"))!;
    let fail = true;
    const close = spyOn(removed as { close: () => Promise<void> }, "close").mockImplementation(
      () => (fail ? Promise.reject(new Error("close failed")) : Promise.resolve())
    );
    const sweep = spyOn(
      manager as unknown as { retireCrossProcessPluginInstances: () => Promise<void> },
      "retireCrossProcessPluginInstances"
    );
    try {
      await f.write([]);
      await manager.reconcilePluginComponents().catch(() => undefined);
      const entry = access.workspaceServers.get(request.workspaceId) as {
        instances: Map<string, unknown>;
        retiredPluginInstances?: Set<unknown>;
        lastActivity: number;
      };
      expect(entry.instances.size).toBe(0);
      entry.lastActivity = Date.now() - 11 * 60_000;
      for (const shouldFail of [true, false]) {
        fail = shouldFail;
        sweep.mockClear();
        const attempts = close.mock.calls.length;
        access.cleanupIdleServers();
        expect(sweep).toHaveBeenCalledTimes(1);
        await sweep.mock.results[0].value;
        expect(close).toHaveBeenCalledTimes(attempts + 1);
        expect(entry.retiredPluginInstances?.has(removed) ?? false).toBe(shouldFail);
        if (shouldFail) expect(access.workspaceServers.get(request.workspaceId)).toBe(entry);
      }
    } finally {
      close.mockRestore();
      sweep.mockRestore();
    }
  });

  test.each(["stdio", "http", "sse", "auto"] as const)(
    "named Test connection rechecks current policy before %s launch",
    async (transport) => {
      using tmp = new DisposableTempDir("mcp-named-test-policy");
      const f = await componentFixture(tmp.path);
      const key = "plugin:instance:remove";
      const plugin = f.configs[key].plugin;
      f.configs[key] =
        transport === "stdio"
          ? {
              ...stdioConfig("removed"),
              plugin,
              env: { PLUGIN_DATA: path.join(tmp.path, "data") },
            }
          : { transport, url: "https://mcp.example.test/removed", disabled: false, plugin };
      configService.listServers.mockImplementation(async () => {
        const snapshot = { ...f.configs };
        await f.write(["keep"]);
        return snapshot;
      });
      const exec = mock(() => Promise.reject(new Error("launch reached")));
      const runtime = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
        exec,
      } as unknown as Runtime);
      const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
        Promise.reject(new Error("connection reached"))
      );
      try {
        const named = await manager.test({ projectPath: tmp.path, name: key });
        expect(named.success).toBe(false);
        if (named.success) throw new Error("Expected revoked named test to fail");
        expect(named.error).toMatch(/disabled|unavailable/);
        expect(exec).not.toHaveBeenCalled();
        expect(client).not.toHaveBeenCalled();
        f.read.mockClear();
        // Explicit user drafts are not managed descriptors, even when their name matches.
        await manager.test({
          projectPath: tmp.path,
          name: key,
          ...(transport === "stdio"
            ? { command: "draft" }
            : { transport, url: "https://mcp.example.test/draft" }),
        });
        expect(transport === "stdio" ? exec : client).toHaveBeenCalledTimes(1);
        expect(f.read).not.toHaveBeenCalled();
        exec.mockClear();
        client.mockClear();
        delete f.configs[key].plugin!.componentPolicy;
        await manager.test({ projectPath: tmp.path, name: key });
        expect(transport === "stdio" ? exec : client).toHaveBeenCalledTimes(1);
        expect(f.read).not.toHaveBeenCalled();
      } finally {
        runtime.mockRestore();
        client.mockRestore();
      }
    }
  );

  test.each(["stdio", "http", "sse", "auto"] as const)(
    "normal %s startup rechecks components after waiting for the override fence",
    async (transport) => {
      using tmp = new DisposableTempDir("mcp-start-component-fence");
      const f = await componentFixture(tmp.path);
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      let removeAtFence = false;
      let overrideHeld = false;
      f.invalidation.acquireOverridesLock = async () => {
        if (removeAtFence) await f.write(["keep"]);
        overrideHeld = true;
        return () => {
          overrideHeld = false;
          return Promise.resolve();
        };
      };
      await manager.getToolsForWorkspace(workspaceRequest("startup-baseline"));
      removeAtFence = true;
      const key = "plugin:instance:remove";
      const info: MCPServerInfo =
        transport === "stdio"
          ? f.configs[key]
          : {
              transport,
              url: "https://mcp.example.test",
              disabled: false,
              plugin: f.configs[key].plugin,
            };
      const exec = mock(() => Promise.reject(new Error("spawn reached")));
      const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
        Promise.reject(new Error("connection reached"))
      );
      try {
        const error: unknown = await access
          .startSingleServerImpl(
            key,
            info,
            { exec } as unknown as Runtime,
            PROJECT_PATH,
            WORKSPACE_PATH,
            undefined,
            () => undefined,
            new AbortController().signal
          )
          .catch((error: unknown) => error);
        expect(exec).not.toHaveBeenCalled();
        expect(client).not.toHaveBeenCalled();
        expect(String(error)).toMatch(/disabled|unavailable/);
        expect(overrideHeld).toBe(false);
      } finally {
        client.mockRestore();
      }
    }
  );

  test.each([false, true])(
    "normal startup fails closed on component writer contention (overrides tracked: %s)",
    async (trackOverrides) => {
      using tmp = new DisposableTempDir("mcp-start-component-contention");
      const f = await componentFixture(tmp.path);
      let overrideHeld = false;
      if (trackOverrides) {
        f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
        f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
        f.invalidation.acquireOverridesLock = () => {
          overrideHeld = true;
          return Promise.resolve(() => {
            overrideHeld = false;
            return Promise.resolve();
          });
        };
      }
      await manager.getToolsForWorkspace(workspaceRequest("contention-baseline"));
      const exec = mock(() => Promise.reject(new Error("spawn reached")));
      const start = () =>
        access
          .startSingleServerImpl(
            "plugin:instance:remove",
            f.configs["plugin:instance:remove"],
            { exec } as unknown as Runtime,
            PROJECT_PATH,
            WORKSPACE_PATH,
            undefined,
            () => undefined,
            new AbortController().signal
          )
          .catch((error: unknown) => error);
      const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
      try {
        expect(String(await start())).toContain("unavailable");
        expect(exec).not.toHaveBeenCalled();
        // Uninstall can now prune overrides without waiting on this startup.
        expect(overrideHeld).toBe(false);
      } finally {
        await release();
      }
      await f.write(["keep"]);
      expect(String(await start())).toContain("disabled");
      expect(exec).not.toHaveBeenCalled();
    }
  );

  test("normal auto startup rechecks components before its SSE fallback", async () => {
    using tmp = new DisposableTempDir("mcp-fallback-component-fence");
    const f = await componentFixture(tmp.path);
    f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
    f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
      Promise.reject(Object.assign(new Error("HTTP not supported"), { status: 404 }))
    );
    f.invalidation.acquireOverridesLock = async () => {
      if (client.mock.calls.length > 0) await f.write(["keep"]);
      return () => Promise.resolve();
    };
    try {
      await manager.getToolsForWorkspace(workspaceRequest("fallback-baseline"));
      const key = "plugin:instance:remove";
      const error: unknown = await access
        .startSingleServerImpl(
          key,
          {
            transport: "auto",
            url: "https://mcp.example.test",
            disabled: false,
            plugin: f.configs[key].plugin,
          },
          TEST_RUNTIME,
          PROJECT_PATH,
          WORKSPACE_PATH,
          undefined,
          () => undefined,
          new AbortController().signal
        )
        .catch((error: unknown) => error);
      expect(client).toHaveBeenCalledTimes(1);
      expect(String(error)).toMatch(/disabled|unavailable/);
    } finally {
      client.mockRestore();
    }
  });

  test("component policy rejects a held tool in a second manager without local notification", async () => {
    using tmp = new DisposableTempDir("mcp-components-sibling");
    const f = await componentFixture(tmp.path);
    const sibling = f.makeManager();
    try {
      const request = workspaceRequest("sibling");
      const served = await sibling.instance.getToolsForWorkspace(request);
      const removed = sibling.started.find((i) => i.name.endsWith(":remove"))!;
      const toolName = Object.keys(served.toolServerNames).find(
        (key) => served.toolServerNames[key] === removed.name
      )!;
      await f.write(["keep"]);
      await manager.reconcilePluginComponents();
      expect(removed.close).not.toHaveBeenCalled();
      expect(
        served.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
      ).rejects.toThrow(/disabled|unavailable/);
      expect(removed.tools.echo.execute).not.toHaveBeenCalled();
      expect(removed.close).toHaveBeenCalledTimes(1);
      for (const client of sibling.started.filter((i) => i !== removed))
        expect(client.close).not.toHaveBeenCalled();
    } finally {
      sibling.instance.dispose();
    }
  });

  test("component mixed equal-count selection and rapid readd do not restart retained clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-mixed");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("mixed");
    await manager.getToolsForWorkspace(request);
    const retained = f.started.filter((i) => !i.name.endsWith(":remove"));
    await f.write(["keep", "added"]);
    const after = await manager.getToolsForWorkspace(request);
    expect(Object.values(after.toolServerNames).sort()).toEqual([
      "ordinary",
      "plugin:instance:added",
      "plugin:instance:keep",
    ]);
    expect(f.started).toHaveLength(4);
    await f.write([]);
    await f.write(["keep", "added"]);
    await manager.reconcilePluginComponents();
    await manager.getToolsForWorkspace(request);
    expect(f.started).toHaveLength(4);
    for (const client of retained) expect(client.close).not.toHaveBeenCalled();
  });

  test("component readd under an active lease closes only the retired client on release", async () => {
    using tmp = new DisposableTempDir("mcp-components-leased-readd");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("leased-readd");
    await manager.getToolsForWorkspace(request);
    manager.acquireLease(request.workspaceId);
    const old = f.started.find((i) => i.name.endsWith(":remove"))!;
    await f.write(["keep"]);
    await manager.getToolsForWorkspace(request);
    await f.write(["keep", "remove"]);
    const result = await manager.getToolsForWorkspace(request);
    expect(Object.values(result.toolServerNames)).toContain(old.name);
    const entry = access.workspaceServers.get(request.workspaceId) as {
      instances: Map<string, unknown>;
    };
    const replacement = entry.instances.get(old.name);
    expect(replacement).not.toBe(old);
    expect(old.close).not.toHaveBeenCalled();
    manager.releaseLease(request.workspaceId);
    await manager.reconcilePluginComponents();
    expect(old.close).toHaveBeenCalledTimes(1);
    for (const client of f.started.filter((i) => i !== old))
      expect(client.close).not.toHaveBeenCalled();
    expect(entry.instances.get(old.name)).toBe(replacement);
  });

  test("component cleanup permits an already admitted leased invocation to finish", async () => {
    using tmp = new DisposableTempDir("mcp-components-admitted");
    const f = await componentFixture(tmp.path);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const original = access.startSingleServer;
    access.startSingleServer = async (...args) => {
      const client = (await original(...args)) as ReturnType<typeof testInstance>;
      if (args[0] === "plugin:instance:remove")
        client.tools.echo = {
          ...testTool(),
          execute: mock(() => {
            entered.resolve();
            return finish.promise;
          }),
        };
      return client;
    };
    const request = workspaceRequest("admitted");
    const first = await manager.getToolsForWorkspace(request);
    const toolName = Object.keys(first.toolServerNames).find((key) =>
      first.toolServerNames[key].endsWith(":remove")
    )!;
    manager.acquireLease(request.workspaceId);
    const pending: unknown = first.tools[toolName].execute!(
      {},
      { toolCallId: "admitted", messages: [], context: {} }
    );
    await entered.promise;
    await f.write(["keep"]);
    await manager.reconcilePluginComponents();
    finish.resolve("finished");
    expect(await pending).toBe("finished");
    manager.releaseLease(request.workspaceId);
    await manager.reconcilePluginComponents();
    expect(f.started.find((i) => i.name.endsWith(":remove"))!.close).toHaveBeenCalledTimes(1);
  });

  test("component authorization reads current policy after a slow override fence", async () => {
    using tmp = new DisposableTempDir("mcp-components-final-gate");
    const f = await componentFixture(tmp.path);
    let removeAtFence = false;
    const invalidation = (
      manager as unknown as {
        pluginInvalidation: {
          readOverridesEpoch: () => Promise<string>;
          readWorkspaceOverrides: () => Promise<Record<string, never>>;
          acquireOverridesLock: () => Promise<() => Promise<void>>;
        };
      }
    ).pluginInvalidation;
    invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    invalidation.readOverridesEpoch = () => Promise.resolve("stable");
    invalidation.acquireOverridesLock = async () => {
      if (removeAtFence) await f.write(["keep"]);
      return () => Promise.resolve();
    };
    const request = workspaceRequest("final-gate");
    const first = await manager.getToolsForWorkspace(request);
    removeAtFence = true;
    const toolName = Object.keys(first.toolServerNames).find((key) =>
      first.toolServerNames[key].endsWith(":remove")
    )!;
    expect(
      first.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
    ).rejects.toThrow(/disabled|unavailable/);
    expect(
      f.started.find((i) => i.name.endsWith(":remove"))!.tools.echo.execute
    ).not.toHaveBeenCalled();
  });

  test.each(["tool", "prompt", "test"] as const)(
    "managed %s admission fails closed without its writer fence",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-missing-fence");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("missing-fence");
      const served = await manager.getToolsForWorkspace(request);
      delete f.invalidation.tryAcquireComponentPolicyLock;
      const key = "plugin:instance:remove";
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === key
      )!;
      const exec = mock(() => Promise.reject(new Error("launch reached")));
      const runtime = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
        exec,
      } as unknown as Runtime);
      try {
        if (operation === "test") {
          const result = await manager.test({ projectPath: tmp.path, name: key });
          expect(result.success).toBe(false);
          if (result.success) throw new Error("Expected missing fence to deny the test");
          expect(result.error).toMatch(/unavailable/);
          expect(exec).not.toHaveBeenCalled();
        } else {
          const pending: unknown =
            operation === "tool"
              ? served.tools[toolName].execute!(
                  {},
                  { toolCallId: "missing-fence", messages: [], context: {} }
                )
              : manager.getPrompt(request.workspaceId, key, "review", {});
          expect(Promise.resolve(pending)).rejects.toThrow(/unavailable/);
          const client = f.started.find((instance) => instance.name === key)!;
          expect(client.tools.echo.execute).not.toHaveBeenCalled();
          expect(client.getPrompt).not.toHaveBeenCalled();
        }
        const ordinary = Object.keys(served.toolServerNames).find(
          (name) => served.toolServerNames[name] === "ordinary"
        )!;
        await served.tools[ordinary].execute!(
          {},
          { toolCallId: "ordinary", messages: [], context: {} }
        );
        expect(
          f.started.find((instance) => instance.name === "ordinary")!.tools.echo.execute
        ).toHaveBeenCalledTimes(1);
      } finally {
        runtime.mockRestore();
      }
    }
  );

  test.each(["tool", "prompt"] as const)(
    "%s admission holds the writer lock before opening the final policy inode",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-inode");
      const f = await componentFixture(tmp.path);
      const overrides = new WorkspaceMcpOverridesService(new Config(tmp.path));
      let overrideHeld = false;
      let pluginHeld = false;
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      f.invalidation.acquireOverridesLock = async (options) => {
        const release = await overrides.acquireExclusiveLock(options);
        overrideHeld = true;
        return async () => {
          await release();
          overrideHeld = false;
        };
      };
      f.invalidation.tryAcquireComponentPolicyLock = async (options) => {
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0, ...options });
        pluginHeld = true;
        return async () => {
          await release();
          pluginHeld = false;
        };
      };
      const dispatched = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const original = access.startSingleServer;
      access.startSingleServer = async (...args) => {
        const instance = (await original(...args)) as ReturnType<typeof testInstance>;
        if (args[0] === "plugin:instance:remove") {
          const dispatch = () => {
            expect(pluginHeld).toBe(true);
            expect(overrideHeld).toBe(true);
            dispatched.resolve();
            return finish.promise;
          };
          instance.tools.echo = { ...testTool(), execute: () => dispatch().then(() => "ok") };
          instance.getPrompt = mock(() =>
            dispatch().then(() => ({
              messages: [{ role: "user", content: { type: "text", text: "ok" } }],
            }))
          );
        }
        return instance;
      };
      const request = workspaceRequest("inode");
      const served = await manager.getToolsForWorkspace(request);
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === "plugin:instance:remove"
      )!;
      const opened = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      let intercept = true;
      const readSpy = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        if (intercept && overrideHeld && args[0] === f.registryPath) {
          intercept = false;
          const handle = await fs.open(f.registryPath, "r");
          try {
            opened.resolve();
            await resume.promise;
            return await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
        }
        return readFile(...args);
      }) as typeof fs.readFile);
      const pending = Promise.resolve(
        operation === "tool"
          ? served.tools[toolName].execute!({}, { toolCallId: "inode", messages: [], context: {} })
          : manager.getPrompt(request.workspaceId, "plugin:instance:remove", "review", {})
      );
      const settled = pending.catch((error: unknown) => error);
      let writer: Promise<void> | undefined;
      try {
        await opened.promise;
        expect(pluginHeld).toBe(true);
        expect(acquirePluginMutationLock(tmp.path, { timeoutMs: 0 })).rejects.toThrow();
        writer = f.write(["keep"]);
        resume.resolve();
        await dispatched.promise;
        await writer;
        const releaseOverride = await overrides.acquireExclusiveLock({ timeoutMs: 1000 });
        await releaseOverride();
        expect(pluginHeld).toBe(false);
        expect(overrideHeld).toBe(false);
        finish.resolve();
        if (operation === "tool") expect(await settled).toBe("ok");
        else expect(await settled).toBeInstanceOf(Error);
      } finally {
        resume.resolve();
        finish.resolve();
        await settled;
        await writer;
        readSpy.mockRestore();
      }
    }
  );

  test.each(["tool", "prompt"] as const)(
    "%s contention releases overrides so a plugin writer can prune",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-writer-wins");
      const f = await componentFixture(tmp.path);
      const key = "plugin:0123456789abcdef:remove";
      f.configs[key] = f.configs["plugin:instance:remove"];
      delete f.configs["plugin:instance:remove"];
      const config = new Config(tmp.path);
      const workspacePath = path.join(tmp.path, "checkout");
      const workspaceId = "writer-wins";
      await fs.mkdir(workspacePath);
      await config.editConfig((current) => {
        current.projects.set(workspacePath, {
          workspaces: [
            {
              path: workspacePath,
              id: workspaceId,
              name: workspaceId,
              runtimeConfig: { type: "local" },
            },
          ],
        });
        return current;
      });
      const overrides = new WorkspaceMcpOverridesService(config);
      await overrides.setOverridesForWorkspace(workspaceId, {
        enabledServers: [key, "ordinary"],
      });
      let releaseWriter: (() => Promise<void>) | undefined;
      let prune: ReturnType<typeof overrides.prunePluginOverrideKeysForWorkspaces> | undefined;
      let overrideReleases = 0;
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      f.invalidation.acquireOverridesLock = async (options) => {
        const release = await overrides.acquireExclusiveLock(options);
        // The installer wins the plugin lock after preflight; pruning then waits
        // for the invocation's override fence, the former O -> P -> O cycle.
        releaseWriter = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        prune = overrides.prunePluginOverrideKeysForWorkspaces(
          [workspaceId],
          "plugin:0123456789abcdef:"
        );
        return async () => {
          overrideReleases++;
          await release();
        };
      };
      const request = workspaceRequest(workspaceId);
      const served = await manager.getToolsForWorkspace(request);
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === key
      )!;
      try {
        const pending: unknown =
          operation === "tool"
            ? served.tools[toolName].execute!(
                {},
                { toolCallId: "writer", messages: [], context: {} }
              )
            : manager.getPrompt(workspaceId, key, "review", {});
        expect(Promise.resolve(pending)).rejects.toThrow(/unavailable.*retry/);
        expect(overrideReleases).toBe(1);
        expect(await prune).toEqual([]);
        expect(
          (await overrides.getOverridesForWorkspace(workspaceId)).overrides.enabledServers
        ).toEqual(["ordinary"]);
        const client = f.started.find((instance) => instance.name === key)!;
        expect(client.tools.echo.execute).not.toHaveBeenCalled();
        expect(client.getPrompt).not.toHaveBeenCalled();
      } finally {
        await releaseWriter?.();
        await prune;
      }
    }
  );

  test.each(
    (["tool", "prompt"] as const).flatMap((operation) =>
      (["read-error", "read-abort", "read-timeout", "late-acquisition"] as const).map(
        (failure) => ({ operation, failure })
      )
    )
  )(
    "$operation component fence releases exactly once on $failure without late dispatch",
    async ({ operation, failure }) => {
      using tmp = new DisposableTempDir("mcp-components-release");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("release");
      const served = await manager.getToolsForWorkspace(request);
      const key = "plugin:instance:remove";
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === key
      )!;
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const resumeAcquisition = Promise.withResolvers<void>();
      const resumeRead = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let inFence = false;
      let releaseCount = 0;
      const now = spyOn(Date, "now");
      f.invalidation.tryAcquireComponentPolicyLock = async () => {
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        inFence = true;
        if (failure === "late-acquisition") {
          entered.resolve();
          await resumeAcquisition.promise;
        }
        return async () => {
          releaseCount++;
          await release();
          released.resolve();
        };
      };
      f.read.mockImplementation(async () => {
        if (inFence) {
          entered.resolve();
          if (failure === "read-error") throw new Error("final policy read failed");
          if (failure === "read-timeout") now.mockReturnValue(Date.now() + 60_000);
          if (failure === "read-abort" || failure === "read-timeout") await resumeRead.promise;
        }
        return readPluginMcpPolicy(f.registryPath);
      });
      const pending = Promise.resolve(
        operation === "tool"
          ? served.tools[toolName].execute!(
              {},
              { toolCallId: "release", messages: [], context: {}, abortSignal: controller.signal }
            )
          : manager.getPrompt(request.workspaceId, key, "review", {}, { signal: controller.signal })
      );
      const rejected = pending.catch((error: unknown) => error);
      try {
        await entered.promise;
        if (failure === "read-abort" || failure === "late-acquisition") controller.abort();
        expect(await rejected).toBeInstanceOf(Error);
        resumeAcquisition.resolve();
        await released.promise;
        resumeRead.resolve();
        expect(releaseCount).toBe(1);
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        await release();
        const client = f.started.find((instance) => instance.name === key)!;
        expect(client.tools.echo.execute).not.toHaveBeenCalled();
        expect(client.getPrompt).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
        resumeAcquisition.resolve();
        resumeRead.resolve();
        await rejected;
      }
    }
  );

  test("unavailable component reader fails closed only for managed clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-reader");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("reader");
    await manager.getToolsForWorkspace(request);
    f.read.mockImplementation(() => Promise.reject(new Error("home unavailable")));
    const result = await manager.getToolsForWorkspace(request);
    expect(Object.values(result.toolServerNames)).toEqual(["ordinary"]);
    expect(f.started.find((i) => i.name === "ordinary")!.close).not.toHaveBeenCalled();
  });

  test("component removal drops failed startup retry candidates", async () => {
    using tmp = new DisposableTempDir("mcp-components-retries");
    const f = await componentFixture(tmp.path);
    const removed = "plugin:instance:remove";
    const startup = mock(async (servers: unknown) => ({
      instances: new Map(
        await Promise.all(
          Object.keys(servers as Record<string, unknown>)
            .filter((name) => name !== removed)
            .map(async (name) => [name, await access.startSingleServer(name)] as const)
        )
      ),
      failedServerNames: Object.hasOwn(servers as object, removed) ? [removed] : [],
      timedOutServerNames: Object.hasOwn(servers as object, removed) ? [removed] : [],
    }));
    access.startServers = startup;
    const request = workspaceRequest("retries");
    await manager.getToolsForWorkspace(request);
    await f.write(["keep"]);
    await manager.reconcilePluginComponents();
    const entry = access.workspaceServers.get(request.workspaceId) as {
      timedOutServerNames: string[];
      retryingTimedOutServerNames: Set<string>;
    };
    expect(entry.timedOutServerNames).toEqual([]);
    expect(entry.retryingTimedOutServerNames.has(removed)).toBe(false);
    const result = await manager.getToolsForWorkspace(request);
    expect(result.stats.failedServerNames).not.toContain(removed);
    for (const [servers] of startup.mock.calls.slice(1))
      expect(servers).not.toHaveProperty(removed);
  });

  test("component owner retarget denies old tools without affecting unrelated clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-owner");
    const f = await componentFixture(path.join(tmp.path, "old"));
    const next = path.join(tmp.path, "new");
    await fs.mkdir(path.join(next, "plugins"), { recursive: true });
    await fs.writeFile(path.join(next, "plugins.json"), await fs.readFile(f.registryPath));
    const request = workspaceRequest("owner");
    const first = await manager.getToolsForWorkspace(request);
    f.read.mockImplementation(() => readPluginMcpPolicy(path.join(next, "plugins.json")));
    const toolName = Object.keys(first.toolServerNames).find((key) =>
      first.toolServerNames[key].endsWith(":remove")
    )!;
    expect(
      first.tools[toolName].execute!({}, { toolCallId: "owner", messages: [], context: {} })
    ).rejects.toThrow(/disabled|unavailable/);
    expect(f.started.find((i) => i.name === "ordinary")!.close).not.toHaveBeenCalled();
  });

  test("component policy read count is bounded independently of server count", async () => {
    using tmp = new DisposableTempDir("mcp-components-read-budget");
    const f = await componentFixture(tmp.path);
    const names = Array.from({ length: 32 }, (_, index) => `server${index}`);
    for (const name of names)
      f.configs[`plugin:many:${name}`] = {
        ...stdioConfig(name),
        plugin: { ...f.configs["plugin:instance:keep"].plugin!, serverName: name },
      };
    await f.write(["keep", ...names]);
    const request = workspaceRequest("read-budget");
    await manager.getToolsForWorkspace(request);
    f.read.mockClear();
    const served = await manager.getToolsForWorkspace(request);
    expect(Object.keys(served.tools)).toHaveLength(34);
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(4);
    f.read.mockClear();
    await served.tools.ordinary_echo.execute!(
      {},
      { toolCallId: "budget", messages: [], context: {} }
    );
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test("component policy churn exhausts the bounded stable scan", async () => {
    using tmp = new DisposableTempDir("mcp-components-churn");
    const f = await componentFixture(tmp.path);
    let reads = 0;
    f.read.mockImplementation(() =>
      Promise.resolve({
        registryPath: f.registryPath,
        imports: { demo: [String(reads++)] },
      })
    );
    expect(access.runWithStablePluginEpoch(() => Promise.resolve(undefined))).rejects.toThrow(
      /kept racing/
    );
    expect(reads).toBeLessThanOrEqual(18);
  });

  test.each(["missing", "unreadable"])(
    "%s component policy never downgrades managed servers",
    async (failure) => {
      using tmp = new DisposableTempDir("mcp-components-policy");
      const f = await componentFixture(tmp.path);
      f.configs.unmanaged = {
        ...stdioConfig("unmanaged"),
        plugin: {
          pluginName: "demo",
          serverName: "remove",
          sourceScope: "global",
          sourceLocation: ".agents/plugins/demo",
        },
      };
      const request = workspaceRequest("policy");
      await manager.getToolsForWorkspace(request);
      if (failure === "missing") await fs.unlink(f.registryPath);
      else {
        await fs.unlink(f.registryPath);
        await fs.mkdir(f.registryPath);
      }
      // Discovery can now report the orphan as unmanaged; remembered provenance must win.
      delete f.configs["plugin:instance:remove"].plugin!.componentPolicy;
      const after = await manager.getToolsForWorkspace(request);
      expect(Object.values(after.toolServerNames).sort()).toEqual(["ordinary", "unmanaged"]);
      for (const client of f.started.filter((i) => !i.name.startsWith("plugin:")))
        expect(client.close).not.toHaveBeenCalled();
    }
  );

  test.each(["initial", "additional", "retry", "restart", "retired-only", "readd"] as const)(
    "failed component startup retirement stays owned after %s publication",
    async (mode) => {
      using tmp = new DisposableTempDir("mcp-startup-retirement");
      const f = await componentFixture(tmp.path);
      const key = "plugin:instance:remove";
      const request = workspaceRequest("startup-retirement");
      const startServers = access.startServers;
      if (mode === "retired-only") {
        delete f.configs.ordinary;
        await f.write(["remove"]);
      } else if (mode === "additional") {
        await f.write(["keep"]);
        await manager.getToolsForWorkspace(request);
        await f.write(["keep", "remove"]);
      } else if (mode === "retry") {
        access.startServers = async (servers, ...args) => {
          const remaining = { ...(servers as Record<string, MCPServerInfo>) };
          delete remaining[key];
          const result = await startServers.call(manager, remaining, ...args);
          return { ...result, failedServerNames: [key], timedOutServerNames: [key] };
        };
        await manager.getToolsForWorkspace(request);
        access.startServers = startServers;
      } else if (mode === "restart") {
        await manager.getToolsForWorkspace(request);
        f.started.find((client) => client.name === key)!.isClosed = true;
        manager.acquireLease(request.workspaceId);
      }
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = access.startSingleServer;
      let failClose = true;
      let failedClient: ReturnType<typeof testInstance> | undefined;
      access.startSingleServer = async (...args) => {
        const client = (await original(...args)) as ReturnType<typeof testInstance>;
        if (args[0] === key && failedClient === undefined) {
          failedClient = client;
          client.close = mock(() =>
            failClose ? Promise.reject(new Error("startup close failed")) : Promise.resolve()
          );
          entered.resolve();
          await resume.promise;
        }
        return client;
      };
      const pending = manager.getToolsForWorkspace(request);
      pending.catch(() => undefined);
      try {
        await entered.promise;
        await f.write(mode === "retired-only" ? [] : ["keep"]);
        resume.resolve();
        const served = await pending;
        const retained = f.started.filter((client) => client.name !== key);
        const entry = access.workspaceServers.get(request.workspaceId) as {
          instances: Map<string, unknown>;
          retiredPluginInstances?: Set<unknown>;
          enabledServerNames: Set<string>;
          timedOutServerNames: string[];
          lastActivity: number;
        };
        expect(failedClient).toBeDefined();
        expect(failedClient!.close.mock.calls.length).toBeGreaterThan(0);
        expect(entry.retiredPluginInstances?.has(failedClient)).toBe(true);
        expect(entry.instances.has(key)).toBe(false);
        expect(entry.enabledServerNames.has(key)).toBe(false);
        expect(entry.timedOutServerNames).not.toContain(key);
        expect(Object.values(served.toolServerNames)).not.toContain(key);
        expect(served.stats.startedServerCount).toBe(mode === "retired-only" ? 0 : 2);
        expect(served.stats.enabledServerCount).toBe(mode === "retired-only" ? 0 : 2);
        expect(served.stats.failedServerNames).not.toContain(key);
        for (const client of retained) {
          expect(entry.instances.get(client.name)).toBe(client);
          expect(client.close).not.toHaveBeenCalled();
        }
        if (mode === "readd") {
          await f.write(["keep", "remove"]);
          const readded = await manager.getToolsForWorkspace(request);
          expect(Object.values(readded.toolServerNames)).toContain(key);
          expect(entry.instances.get(key)).not.toBe(failedClient);
          expect(entry.retiredPluginInstances?.has(failedClient)).toBe(true);
        }
        failClose = false;
        const attempts = failedClient!.close.mock.calls.length;
        if (mode === "retired-only") {
          const sweep = spyOn(
            manager as unknown as { retireCrossProcessPluginInstances: () => Promise<void> },
            "retireCrossProcessPluginInstances"
          );
          try {
            entry.lastActivity = Date.now() - 11 * 60_000;
            access.cleanupIdleServers();
            expect(sweep).toHaveBeenCalledTimes(1);
            await sweep.mock.results[0].value;
          } finally {
            sweep.mockRestore();
          }
        } else if (mode === "additional" || mode === "restart") {
          await manager.stopServersWithKeyPrefix(key);
        } else {
          await manager.reconcilePluginComponents();
        }
        expect(failedClient!.close).toHaveBeenCalledTimes(attempts + 1);
        expect(entry.retiredPluginInstances?.has(failedClient) ?? false).toBe(false);
        for (const client of retained) {
          expect(entry.instances.get(client.name)).toBe(client);
          expect(client.close).not.toHaveBeenCalled();
        }
      } finally {
        failClose = false;
        resume.resolve();
        await pending.catch(() => undefined);
        if (mode === "restart") manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
    }
  );

  test.each([false, true])(
    "component removal fences pending startup (readd during cleanup: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-components-start");
      const f = await componentFixture(tmp.path);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const original = access.startSingleServer;
      access.startSingleServer = async (...args) => {
        const client = await original(...args);
        if (args[0] === "plugin:instance:remove") {
          entered.resolve();
          await finish.promise;
          if (readd)
            (client as ReturnType<typeof testInstance>).close = mock(async () => {
              await f.write(["keep", "remove"]);
            });
        }
        return client;
      };
      const request = workspaceRequest("startup");
      const pending = manager.getToolsForWorkspace(request);
      await entered.promise;
      await f.write(["keep"]);
      finish.resolve();
      const after = await pending;
      expect(f.started[1].close).toHaveBeenCalledTimes(1);
      expect(Object.values(after.toolServerNames).includes("plugin:instance:remove")).toBe(readd);
      const entry = access.workspaceServers.get(request.workspaceId) as {
        instances: Map<string, unknown>;
        timedOutServerNames: string[];
      };
      expect(entry.timedOutServerNames).not.toContain("plugin:instance:remove");
      if (readd) expect(entry.instances.get("plugin:instance:remove")).not.toBe(f.started[1]);
      const starts = f.started.length;
      await manager.getToolsForWorkspace(request);
      expect(f.started).toHaveLength(starts);
    }
  );

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

  test("stdio spawn holds the override writer's lock and refuses a launch once the epoch moved", async () => {
    // The read-only pre-start check leaves a gap between its read and the
    // spawn; the exec that runs the repository-configured command is fenced
    // like a tool dispatch: a sibling's revocation either commits before the
    // fenced read (launch refused) or waits until the process exists.
    manager.dispose();
    let epoch = "epoch-1";
    let lockHeld = false;
    let gateLock: Promise<void> = Promise.resolve();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve({}),
        acquireOverridesLock: async () => {
          await gateLock;
          lockHeld = true;
          return () => {
            lockHeld = false;
            return Promise.resolve();
          };
        },
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    // Establish the epoch baseline (first preflight).
    configService.listServers = mock(() => Promise.resolve({}));
    await manager.getToolsForWorkspace(workspaceRequest("ws-spawn-fence-baseline"));

    const controller = new AbortController();
    let heldAtExec: boolean | undefined;
    const exec = mock((_command: string) => {
      heldAtExec = lockHeld;
      // Abort right after the spawn so the startup stops there.
      controller.abort();
      return Promise.resolve({
        stdin: new WritableStream<Uint8Array>({ close: () => Promise.resolve(undefined) }),
        stdout: new ReadableStream<Uint8Array>({ cancel: () => Promise.resolve(undefined) }),
        stderr: new ReadableStream<Uint8Array>({ cancel: () => Promise.resolve(undefined) }),
        exitCode: Promise.resolve(0),
        duration: Promise.resolve(0),
      });
    });
    const start = () =>
      access.startSingleServerImpl(
        "fenced",
        stdioConfig("never"),
        { exec } as unknown as Runtime,
        PROJECT_PATH,
        WORKSPACE_PATH,
        undefined,
        () => undefined,
        controller.signal
      );
    expect(await start()).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(heldAtExec).toBe(true);
    expect(lockHeld).toBe(false);

    // A sibling revocation holding the writer's lock commits its epoch before
    // releasing: the fenced read sees it and nothing is spawned.
    let releaseSibling!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const controller2 = new AbortController();
    const racing = access.startSingleServerImpl(
      "fenced",
      stdioConfig("never"),
      { exec } as unknown as Runtime,
      PROJECT_PATH,
      WORKSPACE_PATH,
      undefined,
      () => undefined,
      controller2.signal
    );
    racing.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    epoch = "epoch-2";
    gateLock = Promise.resolve();
    releaseSibling();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow("about to start");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);
  });

  test("a remote launch fence releases the writer's lock at its initiation deadline while the handshake is pending", async () => {
    // Every settings save and prune would otherwise queue behind an
    // endpoint-controlled handshake for the whole startup deadline.
    using tmp = new DisposableTempDir("mcp-component-launch-lifetime");
    const f = await componentFixture(tmp.path);
    let lockHeld = false;
    let componentLockHeld = false;
    const acquireComponentLock = f.invalidation.tryAcquireComponentPolicyLock!;
    f.invalidation.tryAcquireComponentPolicyLock = async (options) => {
      const release = await acquireComponentLock(options);
      componentLockHeld = true;
      return async () => {
        await release();
        componentLockHeld = false;
      };
    };
    f.invalidation.readOverridesEpoch = () => Promise.resolve("epoch-1");
    f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    f.invalidation.acquireOverridesLock = () => {
      lockHeld = true;
      return Promise.resolve(() => {
        lockHeld = false;
        return Promise.resolve();
      });
    };
    await manager.getToolsForWorkspace(workspaceRequest("ws-remote-fence-baseline"));
    const fence = access as unknown as {
      launchUnderOverrideFence: <T>(
        name: string,
        info: MCPServerInfo,
        launch: () => Promise<T>,
        signal: AbortSignal,
        options?: { releaseAfterMs?: number }
      ) => Promise<T>;
    };
    const handshake = Promise.withResolvers<string>();
    let heldAtLaunch: boolean | undefined;
    const launched = fence.launchUnderOverrideFence(
      "plugin:instance:remove",
      f.configs["plugin:instance:remove"],
      () => {
        heldAtLaunch = lockHeld && componentLockHeld;
        return handshake.promise;
      },
      new AbortController().signal,
      { releaseAfterMs: 10 }
    );
    expect(heldAtLaunch).toBeUndefined();
    await waitFor(() => !lockHeld && heldAtLaunch === true);
    // A real component writer can commit while the admitted handshake is pending.
    await f.write(["keep"]);
    expect(componentLockHeld).toBe(false);
    handshake.resolve("connected");
    expect(await launched).toBe("connected");
  });

  test("a stdio launch still awaiting its exec at the fence deadline is aborted, not released", async () => {
    // Releasing would let an SSH exec still acquiring its connection send the
    // repository-configured command after a sibling's revocation committed.
    using tmp = new DisposableTempDir("mcp-component-launch-lifetime");
    const f = await componentFixture(tmp.path);
    let lockHeld = false;
    let componentLockHeld = false;
    const acquireComponentLock = f.invalidation.tryAcquireComponentPolicyLock!;
    f.invalidation.tryAcquireComponentPolicyLock = async (options) => {
      const release = await acquireComponentLock(options);
      componentLockHeld = true;
      return async () => {
        await release();
        componentLockHeld = false;
      };
    };
    f.invalidation.readOverridesEpoch = () => Promise.resolve("epoch-1");
    f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    f.invalidation.acquireOverridesLock = () => {
      lockHeld = true;
      return Promise.resolve(() => {
        lockHeld = false;
        return Promise.resolve();
      });
    };
    await manager.getToolsForWorkspace(workspaceRequest("ws-stdio-fence-baseline"));
    const fence = access as unknown as {
      launchUnderOverrideFence: <T>(
        name: string,
        info: MCPServerInfo,
        launch: (launchSignal: AbortSignal) => Promise<T>,
        signal: AbortSignal,
        options?: { abortAfterMs?: { ms: number; serverName: string } }
      ) => Promise<T>;
    };
    let launchSignal: AbortSignal | undefined;
    let heldWhilePending: boolean | undefined;
    const launched = fence.launchUnderOverrideFence(
      "plugin:instance:remove",
      f.configs["plugin:instance:remove"],
      (signal) => {
        launchSignal = signal;
        heldWhilePending = lockHeld && componentLockHeld;
        // Mirrors RemoteRuntime.exec: settles only through the abort.
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Operation aborted")), {
            once: true,
          });
        });
      },
      new AbortController().signal,
      { abortAfterMs: { ms: 10, serverName: "slow-ssh" } }
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(launched).rejects.toThrow("MCP server 'slow-ssh' timed out after 10ms");
    expect(heldWhilePending).toBe(true);
    expect(launchSignal?.aborted).toBe(true);
    expect(lockHeld).toBe(false);
    expect(componentLockHeld).toBe(false);

    // A launch that hands back its stream in time is unaffected and released.
    const quick = await fence.launchUnderOverrideFence(
      "plugin:instance:remove",
      f.configs["plugin:instance:remove"],
      (signal) => Promise.resolve(signal.aborted ? "aborted" : "spawned"),
      new AbortController().signal,
      { abortAfterMs: { ms: 1_000, serverName: "quick" } }
    );
    expect(quick).toBe("spawned");
    expect(lockHeld).toBe(false);
    expect(componentLockHeld).toBe(false);
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
        // Served tools are per-serve gate wrappers (see gateServedToolOnEnablement),
        // so the retained clients show through the instance map, not tool identity.
        expect(Object.keys(first.tools).sort()).toEqual(["ordinary_echo", "plugin_existing_echo"]);
        const retained = access.workspaceServers.get(workspaceId) as {
          instances: Map<string, unknown>;
        };
        expect(retained.instances.get("plugin_existing")).toBe(started[1]);
        expect(retained.instances.get("ordinary")).toBe(started[0]);
        expect(result.tools.plugin_existing_echo).toBeDefined();
        expect(result.tools.ordinary_echo).toBeDefined();
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
    // The older request's re-read (taken because a newer publication landed
    // during its config read) must keep the caller's abort signal: an
    // interrupted turn cancels the disk re-read on every recursion level.
    const originalEnsure = access.ensureWorkspaceServers.bind(manager);
    const readSignals: unknown[] = [];
    access.ensureWorkspaceServers = (...args: unknown[]) => {
      readSignals.push(args[2]);
      return originalEnsure(...args);
    };
    const olderSignal = new AbortController().signal;
    const older = manager.getToolsForWorkspace(request, { signal: olderSignal });
    await oldReadEntered.promise;
    startupFinished.resolve();
    await newer;
    oldReadFinished.resolve({ stable: configs.stable, added: stdioConfig("added") });
    await older;
    access.ensureWorkspaceServers = originalEnsure;
    expect(readSignals.length).toBeGreaterThanOrEqual(2);
    expect(readSignals.every((signal) => signal === olderSignal)).toBe(true);
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
      // Mirrors serveResult: a serve that vouches for its enablement.
      return Promise.resolve({
        tools: {},
        stats: cachedStats(),
        enablementDerivedFrom: options as MCPWorkspaceRequestOptions,
      });
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

  test("a serve reports the validated server inventory it derived enablement from", async () => {
    // Trust (like global config) can change independently of the override
    // snapshot: a caller comparing only `overridesUsed` with its own snapshot
    // would keep advertising the withdrawn repo-local server in the prompt.
    const workspaceId = "ws-servers-used";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    access.startServers = mock(() => {
      manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      return Promise.resolve(startResult([["server"], ["stable"]]));
    });

    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true, overrides: {}, overridesAuthoritative: true })
    );
    expect(result.overridesUsed).toEqual({});
    expect(Object.keys(result.serversUsed ?? {})).toEqual(["stable"]);
    expect(Object.keys(result.tools).every((name) => name.startsWith("stable_"))).toBe(true);
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

  test("a publication landing during the leased tool refresh is honored before the serve returns", async () => {
    // Leased (deferred-restart) path: an authoritative parent publication
    // replaces the recorded overrides while `refreshModernInstanceTools` is
    // awaiting, but its own listServers is still pending — so
    // `enabledServerNames` is stale unless the repair runs AFTER the refresh.
    const workspaceId = "ws-publish-during-leased-refresh";
    const servers = {
      serverA: stdioConfig("cmd-a"),
      serverB: stdioConfig("cmd-b"),
      serverC: stdioConfig("cmd-c"),
    };
    let gateListServers = false;
    const gatedListServers: Array<() => void> = [];
    configService.listServers = mock(() => {
      if (!gateListServers) return Promise.resolve(servers);
      return new Promise<typeof servers>((resolve) => {
        gatedListServers.push(() => resolve(servers));
      });
    });
    let releaseRefresh: () => void = () => undefined;
    const refreshB = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        })
    );
    access.startServers = mock(() =>
      Promise.resolve(
        startResult([
          ["serverA", { tools: { tool: testTool() }, refreshTools: mock(() => Promise.resolve()) }],
          ["serverB", { tools: { tool: testTool() }, refreshTools: refreshB }],
          ["serverC", { tools: { tool: testTool() } }],
        ])
      )
    );
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);

    // Signature change while leased → deferred restart path, which awaits the
    // modern tool refresh (B blocks).
    const inFlight = manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverC"] } })
    );
    while (refreshB.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Parent publication revokes B; its listServers stays pending.
    gateListServers = true;
    const publication = manager.applyWorkspaceOverrides(workspaceId, {
      disabledServers: ["serverC", "serverB"],
    });
    releaseRefresh();
    // Keep the publication's listServers pending until the serve's repair
    // re-derives too (a second gated call) — or the serve returns without one.
    let settled = false;
    const servedPromise = inFlight.finally(() => {
      settled = true;
    });
    while (!settled) {
      if (gatedListServers.length >= 2) {
        for (const release of gatedListServers.splice(0)) release();
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (const release of gatedListServers.splice(0)) release();
    await publication;

    const served = await servedPromise;
    expect(Object.keys(served.tools)).toContain("servera_tool");
    expect(Object.keys(served.tools)).not.toContain("serverb_tool");
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
  test("prompt discovery retries when an ordinary serve replaces the entry during prompts/list", async () => {
    // A direct edit of the override document is picked up by a concurrent
    // send's serve, which replaces the published entry without moving either
    // mutation counter. Descriptors must come from the current entry.
    const request = workspaceRequest("workspace");
    access.lastWorkspaceRequestOptions.set("workspace", request);
    const replaced = { enabledServerNames: new Set<string>(), instances: new Map() };
    const stale = testInstance("coder", {
      prompts: [{ name: "stale" }],
      refreshPrompts: mock(() => {
        access.workspaceServers.set("workspace", replaced);
        return Promise.resolve([{ name: "stale" }]);
      }),
    });
    let serves = 0;
    spyOn(access, "ensureWorkspaceServers").mockImplementation(() => {
      serves += 1;
      if (serves === 1) {
        access.workspaceServers.set("workspace", {
          enabledServerNames: new Set(["coder"]),
          instances: new Map([["coder", stale]]),
        });
      }
      return Promise.resolve({ tools: {}, stats: cachedStats(), enablementDerivedFrom: request });
    });

    const descriptors = await manager.getPromptsForWorkspace(request);
    expect(descriptors).toEqual([]);
    expect(serves).toBe(2);
  });

  test("lists namespaced prompt descriptors from connected instances", async () => {
    // Mirrors a real serve: the options it derived enablement from are recorded.
    access.lastWorkspaceRequestOptions.set("workspace", workspaceRequest("workspace"));
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
      // Mirrors serveResult: a serve that vouches for its enablement.
      enablementDerivedFrom: workspaceRequest("workspace"),
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
    // Mirrors a real serve: the options it derived enablement from are recorded.
    access.lastWorkspaceRequestOptions.set("workspace", workspaceRequest("workspace"));
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
      // Mirrors serveResult: a serve that vouches for its enablement.
      enablementDerivedFrom: workspaceRequest("workspace"),
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
    // Mirrors a real serve: the options it derived enablement from are recorded.
    access.lastWorkspaceRequestOptions.set("workspace", workspaceRequest("workspace"));
    const getToolsSpy = spyOn(access, "ensureWorkspaceServers").mockResolvedValue({
      tools: {},
      stats: cachedStats(),
      // Mirrors serveResult: a serve that vouches for its enablement.
      enablementDerivedFrom: workspaceRequest("workspace"),
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
        // Mirrors a real serve: the inventory is as new as the current config.
        enabledServersGeneration: configService.configGeneration,
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      return Promise.resolve({
        tools: {},
        stats: cachedStats(),
        enablementDerivedFrom: access.lastWorkspaceRequestOptions.get("workspace"),
      });
    });
    access.lastWorkspaceRequestOptions.set("workspace", request);

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({
      text: "Status",
    });
    expect(getToolsSpy).toHaveBeenCalledWith(request, false, undefined);
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
      const workspaceId = (options as { workspaceId: string }).workspaceId;
      access.workspaceServers.set(workspaceId, {
        enabledServerNames: new Set(["coder"]),
        // Mirrors a real serve: the inventory is as new as the current config.
        enabledServersGeneration: configService.configGeneration,
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      // Mirrors serveResult: enablement derived from the options recorded now.
      return Promise.resolve({
        tools: {},
        stats: cachedStats(),
        enablementDerivedFrom: access.lastWorkspaceRequestOptions.get(workspaceId),
      });
    });

    manager.applyProjectTrust([
      { projectPath: `${PROJECT_PATH}/`, trusted: false },
      { projectPath: "/tmp/other-project", trusted: true },
    ]);
    await manager.getPrompt("workspace", "coder", "status", {});

    expect(getToolsSpy).toHaveBeenCalledWith({ ...request, trusted: false }, false, undefined);
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
      const workspaceId = (options as { workspaceId: string }).workspaceId;
      access.workspaceServers.set(workspaceId, {
        enabledServerNames: new Set(["coder"]),
        // Mirrors a real serve: the inventory is as new as the current config.
        enabledServersGeneration: configService.configGeneration,
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      // Mirrors serveResult: enablement derived from the options recorded now.
      return Promise.resolve({
        tools: {},
        stats: cachedStats(),
        enablementDerivedFrom: access.lastWorkspaceRequestOptions.get(workspaceId),
      });
    });

    await manager.getPrompt("workspace", "coder", "status", {});

    expect(getToolsSpy).toHaveBeenCalledWith(
      { ...request, projectSecrets: { TOKEN: "new" } },
      false,
      undefined
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
      const workspaceId = (options as { workspaceId: string }).workspaceId;
      access.workspaceServers.set(workspaceId, {
        enabledServerNames: new Set(["coder"]),
        // Mirrors a real serve: the inventory is as new as the current config.
        enabledServersGeneration: configService.configGeneration,
        instances: new Map([["coder", testInstance("coder", { getPrompt })]]),
      });
      // Mirrors serveResult: enablement derived from the options recorded now.
      return Promise.resolve({
        tools: {},
        stats: cachedStats(),
        enablementDerivedFrom: access.lastWorkspaceRequestOptions.get(workspaceId),
      });
    });

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });
    expect(getToolsSpy).toHaveBeenCalledWith(request, false, undefined);
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

  test("forgetWorkspaceOverrides drops the cached snapshot so the caller's fresh read wins again", async () => {
    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));
    const startServersMock = spyOn(access, "startServers").mockImplementation(
      (...args: unknown[]) => {
        const servers = args[0] as Record<string, unknown>;
        return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
      }
    );
    const workspaceId = "ws-forget";
    // A published snapshot overlays whatever the caller read from disk.
    await manager.applyWorkspaceOverrides(workspaceId, { enabledServers: [PLUGIN_KEY] });
    const overlaid = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(overlaid.stats.enabledServerCount).toBe(1);

    // After eviction the caller's (disk-authoritative) read is used as-is.
    manager.forgetWorkspaceOverrides(workspaceId);
    const fresh = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(fresh.stats.enabledServerCount).toBe(0);
    expect(startServersMock).toHaveBeenCalled();
  });

  test("forgetWorkspaceOverrides also distrusts recorded options: the next serve re-reads disk", async () => {
    manager.dispose();
    let diskOverrides: Record<string, unknown> = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-forget-recorded";

    // First serve records options (with the disk-read enable) — one disk read.
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(first.stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // A prompt-path style serve (recorded options, no fresh caller read) reuses
    // the recorded snapshot without touching disk.
    diskOverrides = {};
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;
    const second = await manager.getToolsForWorkspace(recordedOptions());
    expect(second.stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // After eviction the same recorded-options serve must re-read disk and
    // observe the disable — no chat send required.
    manager.forgetWorkspaceOverrides(workspaceId);
    const third = await manager.getToolsForWorkspace(recordedOptions());
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);
    expect(third.stats.enabledServerCount).toBe(0);
  });

  test("getPrompt re-reads disk so a direct document edit disabling the server is honored", async () => {
    // A direct edit of `.xum/mcp.local.jsonc` (own or inherited parent
    // document) bumps no epoch and publishes nothing; the recorded options
    // still say "enabled". Prompt dispatch must not trust them blindly.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { getPrompt }]))
      );
    });
    const workspaceId = "ws-prompt-direct-edit";
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });

    // Direct edit: disk now disables the server; nothing else moved.
    diskOverrides = { disabledServers: ["server"] };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("a direct disk revocation is honored even when an equivalent serve replaces the recorded options mid-gate", async () => {
    // While the gate awaits its disk read, an overlapping serve whose snapshot
    // predates the edit records a fresh but EQUIVALENT options object. The
    // invalidation must still be taken (equivalence, not identity) or the
    // revoked tool would dispatch.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    let onDiskRead: (() => void) | undefined;
    const readWorkspaceOverrides = mock(() => {
      onDiskRead?.();
      return Promise.resolve(diskOverrides);
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-equivalent-replacement-revocation";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const request = workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true });
    const result = await manager.getToolsForWorkspace(request);
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) throw new Error("Expected served tool to include execute");
    manager.acquireLease(workspaceId);

    // Direct edit revokes the server on disk; the gate's read observes it,
    // but an equivalent pre-edit snapshot is recorded at that very moment.
    diskOverrides = { disabledServers: ["server"] };
    onDiskRead = () => {
      onDiskRead = undefined;
      access.lastWorkspaceRequestOptions.set(workspaceId, { ...request });
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
    manager.releaseLease(workspaceId);
  });

  test("served tool objects fail at call time once their server is disabled", async () => {
    // Tools leave the manager before the stream starts; a publication landing
    // in that window (or mid-stream) cannot retract the objects, so every
    // invocation re-checks the CURRENT enablement — including while the
    // publication's asynchronous enablement repair is still in flight.
    const workspaceId = "ws-call-time-gate";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [
            name,
            { tools: { ping: dummyTool } },
          ])
        )
      )
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    const stableTool = result.tools.stable_ping;
    if (!serverTool?.execute || !stableTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Publication whose listServers is slow: an invocation racing it must
    // not pass on the old set — the latest recorded overrides already revoke
    // the server, so the call is rejected without waiting for the repair.
    let releaseListServers!: () => void;
    configService.listServers = mock(
      () =>
        new Promise((resolve) => {
          releaseListServers = () =>
            resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") });
        })
    );
    const publication = manager.applyWorkspaceOverrides(workspaceId, {
      disabledServers: ["server"],
    });
    const racing: Promise<unknown> = Promise.resolve(serverTool.execute({}, {} as never));
    racing.catch(() => undefined); // asserted below; keep the rejection handled meanwhile
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executeTool).toHaveBeenCalledTimes(1);
    releaseListServers();
    await publication;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow(
      "was disabled for this workspace after the request was prepared"
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow(
      "was disabled for this workspace after the request was prepared"
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Servers that stay enabled are unaffected.
    await stableTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);

    // A narrowed workspace tool allowlist revokes individual tools of a server
    // that stays enabled.
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    await manager.applyWorkspaceOverrides(workspaceId, { toolAllowlist: { stable: ["other"] } });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(stableTool.execute({}, {} as never)).rejects.toThrow("tool 'stable/ping'");
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  test("overlapping serves of one workspace with the same authorization both succeed", async () => {
    // Prompt discovery while a send assembles: each records its own options
    // object; the first to finish must not be failed closed as if a
    // publication had revoked it.
    const workspaceId = "ws-overlapping-serves";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    access.startServers = mock(async () => {
      await started;
      return startResult([["server", { tools: { ping: testTool() } }]]);
    });
    const first = manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseStart();
    const [a, b] = await Promise.all([first, second]);
    expect(Object.keys(a.tools)).toEqual(["server_ping"]);
    expect(Object.keys(b.tools)).toEqual(["server_ping"]);

    // A real authorization change is still detected: different overrides.
    const third = manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["server"] } })
    );
    expect(Object.keys((await third).tools)).toEqual([]);
  });

  test("tools handed to the model are filtered with the inventory repaired mid-startup", async () => {
    // A project tool allowlist narrowed while startup awaits must filter the
    // served tools, not only be enforced by the call-time gate after the
    // model already selected a removed tool.
    const workspaceId = "ws-repaired-inventory";
    let allowlist: string[] | undefined;
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { ...stdioConfig("cmd-1"), ...(allowlist ? { toolAllowlist: allowlist } : {}) },
      })
    );
    access.startServers = mock(() => {
      // Settings narrows the allowlist while the server starts.
      allowlist = ["other"];
      configService.configGeneration += 1;
      return Promise.resolve(
        startResult([["server", { tools: { ping: testTool(), other: testTool() } }]])
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(Object.keys(result.tools)).toEqual(["server_other"]);
  });

  test("served tool objects honor a global tool allowlist narrowed after the serve", async () => {
    // Settings narrowing a server's global/project toolAllowlist replaces no
    // recorded options and changes nothing on the workspace's override disk —
    // it only bumps the config generation. The gate must not decide on the
    // allowlist captured with the tool object: it re-derives the inventory
    // when the generation moved and applies the CURRENT allowlist.
    const workspaceId = "ws-call-time-global-allowlist";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock(() =>
      Promise.resolve(startResult([["server", { tools: { ping: dummyTool, other: dummyTool } }]]))
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const pingTool = result.tools.server_ping;
    const otherTool = result.tools.server_other;
    if (!pingTool?.execute || !otherTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    await pingTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Global allowlist narrowed to `other` without any serve in between.
    configService.listServers = mock(() =>
      Promise.resolve({ server: { ...stdioConfig("cmd-1"), toolAllowlist: ["other"] } })
    );
    configService.configGeneration += 1;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(pingTool.execute({}, {} as never)).rejects.toThrow("tool 'server/ping'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    await otherTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);

    // Globally disabling the server is caught the same way.
    configService.listServers = mock(() => Promise.resolve({}));
    configService.configGeneration += 1;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(otherTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  test("served tool objects re-derive enablement from disk when the workspace was invalidated", async () => {
    // Descendant/off-host publications and cross-process epoch changes only
    // set the invalidation marker (no overrides to repair the entry with), so
    // the gate must not trust the leased entry's enablement: it re-serves from
    // disk and rejects when disk revokes the server (or cannot answer).
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-call-time-invalidated";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    // The stream holds its lease while tools are invoked.
    manager.acquireLease(workspaceId);

    // Invalidation while disk still enables the server: re-derived, allowed.
    // (The re-serve recorded a fresh options object with the SAME
    // authorization state; the gate compares by equivalence, so it dispatches
    // without another round: one read beyond the serve's.)
    manager.forgetWorkspaceOverrides(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Invalidation after a parent save that disables the server on disk.
    diskOverrides = { disabledServers: ["server"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Invalidation that disk cannot resolve: fail closed at call time too.
    diskOverrides = undefined;
    manager.forgetWorkspaceOverrides(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    manager.releaseLease(workspaceId);
  });

  test("served tool objects observe a sibling process's override write before executing", async () => {
    // Backend B saves overrides that revoke the server: only the on-disk epoch
    // moves. Without a new serve in this process no marker would ever exist,
    // so the call-time gate runs the same cross-process preflight as a serve.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-call-time-sibling";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Sibling process: disk now disables the server and the epoch moved.
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);

    // …and re-enables it.
    diskOverrides = {};
    epoch = "epoch-3";
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    manager.releaseLease(workspaceId);
  });

  test("served tool calls hold the override writer's lock from the final epoch read through dispatch", async () => {
    // A sibling process's revocation that commits between the bracket's
    // postflight epoch read and the invocation leaves no process-local marker.
    // Under the writer's lock the write either committed before the fenced
    // epoch read (observed → re-derived → revoked) or waits until the call has
    // been dispatched; the tool's own execution never runs under the lock.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let lockHeld = false;
    let acquisitions = 0;
    let releases = 0;
    let gateLock: Promise<void> = Promise.resolve();
    const acquireOverridesLock = mock(async () => {
      acquisitions += 1;
      await gateLock;
      lockHeld = true;
      return () => {
        lockHeld = false;
        releases += 1;
        return Promise.resolve();
      };
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
        acquireOverridesLock,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-call-time-lock";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let heldAtDispatch: boolean | undefined;
    let finishTool!: () => void;
    const executeTool = mock(() => {
      heldAtDispatch = lockHeld;
      return new Promise((resolve) => {
        finishTool = () => resolve({ content: [{ type: "text", text: "ok" }] });
      });
    });
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);

    // Dispatch happens under the lock; the lock is released once the call has
    // started, not when the tool finishes.
    const call = serverTool.execute({}, {} as never) as Promise<unknown>;
    await waitFor(() => executeTool.mock.calls.length === 1);
    expect(heldAtDispatch).toBe(true);
    await waitFor(() => releases === 1);
    expect(acquisitions).toBe(1);
    finishTool();
    await call;

    // Sibling revocation racing the handoff: it holds the writer's lock while
    // the gate (already past its bracket) waits for it, commits disk + epoch,
    // then releases. The fenced epoch read observes the change and the call
    // is re-derived from disk instead of dispatched on stale authorization.
    let releaseSibling!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const racing = serverTool.execute({}, {} as never) as Promise<unknown>;
    await waitFor(() => acquisitions === 2);
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    releaseSibling();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);

    // A lock that cannot be acquired before the tool call's deadline/abort
    // fails the call closed and never leaves a late acquisition held.
    gateLock = new Promise<void>(() => undefined);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).toHaveBeenCalledTimes(1);
    manager.releaseLease(workspaceId);
  });

  test("an aborted prompt request releases the writer's lock while its fenced epoch read stalls", async () => {
    // The outer abort race returns to the caller, but the losing callback
    // still holds the override writer's lock: a stalled home filesystem must
    // not keep every settings save and prune blocked behind an epoch read
    // nobody waits for.
    manager.dispose();
    let lockHeld = false;
    let epochReads = 0;
    const controller = new AbortController();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => {
          epochReads += 1;
          // Only the fenced read (taken under the lock) stalls.
          if (lockHeld) {
            controller.abort();
            return new Promise<string>(() => undefined);
          }
          return Promise.resolve("epoch-1");
        },
        readWorkspaceOverrides: () => Promise.resolve({}),
        acquireOverridesLock: () => {
          lockHeld = true;
          return Promise.resolve(() => {
            lockHeld = false;
            return Promise.resolve();
          });
        },
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-prompt-fence-abort";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { getPrompt }]))
      );
    });
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getPrompt(workspaceId, "server", "review", {}, { signal: controller.signal })
    ).rejects.toThrow("aborted");
    await waitFor(() => !lockHeld);
    expect(getPrompt).not.toHaveBeenCalled();
    expect(epochReads).toBeGreaterThan(0);
  });

  test("a sibling override write landing before server startup fails the serve closed instead of launching", async () => {
    // The writer bumps the epoch right after persisting the document (before
    // its publication budget). A serve that derived its enabled set before
    // that write must not launch a server whose revocation is already
    // durable — the postflight would only close it after its command ran.
    manager.dispose();
    let epoch = "epoch-1";
    const readWorkspaceOverrides = mock(() => {
      // The sibling's write commits while this serve's disk read is in flight.
      epoch = "epoch-2";
      return Promise.resolve({} as Record<string, unknown>);
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const startServers = spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-startup-fence";
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }))
    ).rejects.toThrow("changed in another process");
    expect(startServers).not.toHaveBeenCalled();

    // The next serve's preflight adopts the new epoch and re-derives from disk.
    readWorkspaceOverrides.mockImplementation(() => Promise.resolve({}));
    const served = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(served.stats.enabledServerCount).toBe(1);
    expect(startServers).toHaveBeenCalledTimes(1);
  });

  test("prompt dispatch holds the override writer's lock from the final epoch read through invocation start", async () => {
    // Same fence as served tool calls: a sibling process persists a disabling
    // save, spends its publication budget updating caches, and only then
    // bumps the epoch — a postflight alone can observe the old token and hand
    // out content from the now-disabled server.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let lockHeld = false;
    let acquisitions = 0;
    let gateLock: Promise<void> = Promise.resolve();
    const acquireOverridesLock = mock(async () => {
      acquisitions += 1;
      await gateLock;
      lockHeld = true;
      return () => {
        lockHeld = false;
        return Promise.resolve();
      };
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
        acquireOverridesLock,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-prompt-lock";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let heldAtDispatch: boolean | undefined;
    const getPrompt = mock(() => {
      heldAtDispatch = lockHeld;
      return Promise.resolve({
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      });
    });
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { getPrompt }]))
      );
    });
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );

    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(heldAtDispatch).toBe(true);
    expect(lockHeld).toBe(false);
    const acquisitionsAfterFirst = acquisitions;

    // Sibling revocation racing the handoff: it holds the writer's lock while
    // this request (already past its authoritative re-read) waits for it,
    // commits disk + epoch, then releases. The fenced epoch read sees the
    // change and no content is handed out from the disabled server.
    let releaseSibling!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const racing = manager.getPrompt(workspaceId, "server", "review", {});
    racing.catch(() => undefined);
    await waitFor(() => acquisitions === acquisitionsAfterFirst + 1);
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    gateLock = Promise.resolve();
    releaseSibling();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow("server 'server'");
    expect(getPrompt).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);

    // A same-process global disable landing while the request waits for the
    // lock advances only the config generation (no provenance change, no
    // epoch bump): the dispatch must re-derive from the current config
    // instead of trusting the pre-wait enabled set.
    diskOverrides = {};
    epoch = "epoch-3";
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(getPrompt).toHaveBeenCalledTimes(2);
    let releaseSettings!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const acquisitionsBefore = acquisitions;
    const racingGlobal = manager.getPrompt(workspaceId, "server", "review", {});
    racingGlobal.catch(() => undefined);
    await waitFor(() => acquisitions === acquisitionsBefore + 1);
    configService.listServers = mock(() => Promise.resolve({}));
    configService.configGeneration += 1;
    gateLock = Promise.resolve();
    releaseSettings();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racingGlobal).rejects.toThrow("server 'server'");
    expect(getPrompt).toHaveBeenCalledTimes(2);
    expect(lockHeld).toBe(false);
  });

  test("served tools of a project-local server are rejected once project trust is revoked", async () => {
    // applyProjectTrust repairs the live entry's enabled set like an override
    // publication: the gate must not keep dispatching a server the user just
    // distrusted from an already-prepared stream.
    const workspaceId = "ws-call-time-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true, overrides: {}, overridesAuthoritative: true })
    );
    const projectTool = result.tools.server_ping;
    const globalTool = result.tools.stable_ping;
    if (!projectTool?.execute || !globalTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    manager.acquireLease(workspaceId);
    await projectTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
    // The racing call waits for the repair registered by the trust change.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(projectTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Servers that do not depend on trust keep working.
    await globalTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    manager.releaseLease(workspaceId);
  });

  test("a serve's disk re-read is cancelled with the caller's signal", async () => {
    manager.dispose();
    const readWorkspaceOverrides = mock(
      (_workspaceId: string, options?: { signal?: AbortSignal }) =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        })
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    spyOn(access, "startServers").mockResolvedValue(startResult([["server"]]));
    const controller = new AbortController();
    // A cold serve re-reads disk through the reader; without the signal the
    // remote read would run to its own (minutes-long) timeout.
    const pending = manager.getToolsForWorkspace(
      workspaceRequest("ws-read-signal", { overrides: {}, overridesAuthoritative: true }),
      { signal: controller.signal }
    );
    await waitFor(() => readWorkspaceOverrides.mock.calls.length === 1);
    expect(readWorkspaceOverrides.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    // The aborted read is not a verdict: the serve fails closed.
    const result = await pending;
    expect(result.tools).toEqual({});
    expect(result.overridesUsed).toBeUndefined();
  });

  test("served tool objects re-read the effective overrides on every call (direct document edit)", async () => {
    // A direct edit of the workspace's own or an inherited parent document
    // moves neither the epoch nor any process-local state; the gate compares
    // disk with the recorded overrides before each call.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const workspaceId = "ws-call-time-direct-edit";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { ping: dummyTool } }]))
      );
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Direct edit: disk disables the server; no epoch bump, no publication.
    diskOverrides = { disabledServers: ["server"] };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Unreadable document: fail closed too.
    diskOverrides = undefined;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    // Edited back: allowed again.
    diskOverrides = {};
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    // A read that THROWS (unreachable parent checkout, config error) is not a
    // verdict either: fail closed rather than fall through to the cached set.
    readWorkspaceOverrides.mockImplementationOnce(() =>
      Promise.reject(new Error("parent checkout unreachable"))
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("could not be re-read");
    expect(executeTool).toHaveBeenCalledTimes(2);
    // Disk answers again: re-derived and allowed.
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(3);
    // The re-read honors the tool call's abort signal (Escape) instead of
    // running to completion first.
    readWorkspaceOverrides.mockImplementationOnce(() => new Promise(() => undefined));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).toHaveBeenCalledTimes(3);
    manager.releaseLease(workspaceId);
  });

  test("served tool calls do not hang on a publication repair the publisher gave up on", async () => {
    // The publisher bounds applyWorkspaceOverrides and evicts on timeout; the
    // stalled repair must neither block nor authorize calls after that.
    const workspaceId = "ws-stalled-repair-gate";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [
            name,
            { tools: { ping: dummyTool } },
          ])
        )
      )
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    // Only the publication's config read stalls (later reads answer again).
    let listServersCalls = 0;
    configService.listServers = mock(() =>
      ++listServersCalls === 1
        ? new Promise(() => undefined)
        : Promise.resolve({ server: stdioConfig("cmd-1") })
    );
    const stalled = manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    // The bounded publisher gives up and evicts.
    manager.forgetWorkspaceOverrides(workspaceId);
    const startedAt = Date.now();
    // No disk reader in this fixture: the invalidation cannot be resolved, so
    // the call fails closed — promptly, without waiting on the stalled repair.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(executeTool).not.toHaveBeenCalled();
    void stalled;
    // A stalled repair still pending (no eviction yet) must not hold a call
    // past Escape: the wait is abort-aware.
    const stalled2 = manager.applyWorkspaceOverrides(workspaceId, { disabledServers: [] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).not.toHaveBeenCalled();
    void stalled2;
  });

  test("a publication whose repair fails invalidates the workspace instead of leaving stale enablement", async () => {
    // Recorded overrides say "disabled" while the entry keeps the old enabled
    // set; a per-call disk comparison finds disk equal to the recorded value,
    // so nothing else would ever repair the entry. Fail closed until re-derived.
    const workspaceId = "ws-repair-failure";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [
            name,
            { tools: { ping: dummyTool } },
          ])
        )
      )
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    configService.listServers = mock(() => Promise.reject(new Error("config unreadable")));
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("a publication starting during a call's revalidation is honored before dispatch", async () => {
    // The disabling save lands after the gate's first pending-repair lookup:
    // its recorded options are installed but its repair is still pending.
    // The gate must not dispatch on the pre-publication enabled set.
    const workspaceId = "ws-gate-late-publication";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [
            name,
            { tools: { ping: dummyTool } },
          ])
        )
      )
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    // Hook the revalidation bracket: the publication starts inside it, with a
    // repair that never completes (stalled config read).
    const realRun = access.runWithStablePluginEpoch.bind(manager);
    let publication: Promise<void> | undefined;
    spyOn(access, "runWithStablePluginEpoch").mockImplementation(
      async (operation: () => Promise<unknown>) => {
        const value = await realRun(operation);
        configService.listServers = mock(() => new Promise(() => undefined));
        publication ??= manager.applyWorkspaceOverrides(workspaceId, {
          disabledServers: ["server"],
        });
        return value;
      }
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("a superseded publication repair cannot restore an older enabled set", async () => {
    // Publication #1 (enables) stalls in listServers past the publisher's
    // bound; publication #2 (disables) completes. #1's late completion must
    // not overwrite the live entry's enablement.
    const workspaceId = "ws-stale-repair";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    access.startServers = mock((servers) =>
      Promise.resolve(
        startResult(
          Object.keys(servers as Record<string, unknown>).map((name) => [
            name,
            { tools: { ping: dummyTool } },
          ])
        )
      )
    );
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }

    let releaseFirst!: () => void;
    configService.listServers = mock(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") });
        })
    );
    const first = manager.applyWorkspaceOverrides(workspaceId, { enabledServers: ["server"] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    configService.listServers = mock(() => Promise.resolve({ stable: stdioConfig("cmd-stable") }));
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    releaseFirst();
    await first;

    const entry = access.workspaceServers.get(workspaceId) as
      | { enabledServerNames: Set<string> }
      | undefined;
    expect(entry?.enabledServerNames.has("server")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("an invalidated workspace whose overrides stay unreadable fails closed until disk answers", async () => {
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    // A globally ENABLED ordinary server plus a default-disabled plugin server.
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js"), ...pluginStdioConfig() })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-fail-closed";
    // Recorded snapshot: the parent had enabled the plugin server; ordinary runs by default.
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect((await manager.getToolsForWorkspace(recordedOptions())).stats.enabledServerCount).toBe(
      2
    );

    // Parent save (revoking the plugin enable) evicted us; disk is unreadable
    // during the re-read.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    const during = await manager.getToolsForWorkspace(recordedOptions());
    // Fail closed: neither the recorded plugin enable nor the globally enabled
    // ordinary server is served from a snapshot disk cannot vouch for.
    expect(during.stats.enabledServerCount).toBe(0);

    // Disk recovers: the invalidation survived, the revocation is observed,
    // and ordinary enablement resumes from the authoritative read.
    diskOverrides = {};
    const after = await manager.getToolsForWorkspace(recordedOptions());
    expect(after.stats.enabledServerCount).toBe(1);
  });

  test("a plugin-epoch refresh that cannot read disk keeps an invalidated workspace failing closed", async () => {
    manager.dispose();
    let token = "epoch-1";
    let diskOverrides: Record<string, unknown> | undefined = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js"), ...pluginStdioConfig() })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-refresh-invalidated";
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect((await manager.getToolsForWorkspace(recordedOptions())).stats.enabledServerCount).toBe(
      2
    );

    // Parent save evicted us while disk is unreadable; then a sibling
    // process's plugin mutation bumps the epoch. The refresh sweep's fallback
    // (scrubbed recorded snapshot) must not repopulate the overlay cache for
    // the invalidated workspace — that snapshot is what is being distrusted.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    token = "epoch-2";
    const during = await manager.getToolsForWorkspace(recordedOptions());
    expect(during.stats.enabledServerCount).toBe(0);
    expect(
      (
        access as unknown as { latestWorkspaceOverrides: Map<string, unknown> }
      ).latestWorkspaceOverrides.has(workspaceId)
    ).toBe(false);

    // Disk recovers: the invalidation survived the sweep and the revocation
    // is observed from the authoritative read.
    diskOverrides = {};
    const after = await manager.getToolsForWorkspace(recordedOptions());
    expect(after.stats.enabledServerCount).toBe(1);
  });

  test("an authoritative publication retires the invalidation and the fail-closed state", async () => {
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-publication-wins";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;

    // Evicted, then disk unreadable: fails closed.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    expect((await manager.getToolsForWorkspace(recordedOptions())).stats.enabledServerCount).toBe(
      0
    );
    // A later parent save resolves the child authoritatively and publishes it:
    // MCP must come back without waiting for another disk read.
    await manager.applyWorkspaceOverrides(workspaceId, {});
    const reads = readWorkspaceOverrides.mock.calls.length;
    expect((await manager.getToolsForWorkspace(recordedOptions())).stats.enabledServerCount).toBe(
      1
    );
    expect(readWorkspaceOverrides.mock.calls.length).toBe(reads);
  });

  test("a server revoked mid-startup is not served by the completing serve", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({
        ordinary: stdioConfig("node ordinary.js"),
        other: stdioConfig("node other.js"),
      })
    );
    const workspaceId = "ws-revoked-mid-startup";
    spyOn(access, "startServers").mockImplementation(async (...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      // A parent save publishes a disable while these servers are starting.
      await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["ordinary"] });
      return startResult(
        Object.keys(servers).map((name) => [name, { tools: { echo: testTool() } }])
      );
    });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(result.tools)).toEqual(["other_echo"]);
  });

  test("a global eviction landing during a cold serve's first read fails that serve closed", async () => {
    manager.dispose();
    let release: (value: Record<string, unknown>) => void = () => undefined;
    const readWorkspaceOverrides = mock(
      () => new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const inFlight = manager.getToolsForWorkspace(workspaceRequest("ws-cold-global"));
    while (readWorkspaceOverrides.mock.calls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The cold workspace is in neither map, so a global eviction cannot name it…
    manager.forgetAllWorkspaceOverrides();
    release({});
    // …yet its pre-eviction read must not be served…
    expect((await inFlight).stats.enabledServerCount).toBe(0);
    // …and the recorded (stale) options must not satisfy the next serve either:
    // it re-reads disk.
    const recorded = access.lastWorkspaceRequestOptions.get(
      "ws-cold-global"
    ) as MCPWorkspaceRequestOptions;
    const next = manager.getToolsForWorkspace(recorded);
    while (readWorkspaceOverrides.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    release({});
    expect((await next).stats.enabledServerCount).toBe(1);
  });

  test("a forget landing during an in-flight disk read is not retired by that read", async () => {
    manager.dispose();
    let release: (value: Record<string, unknown>) => void = () => undefined;
    let reads = 0;
    const readWorkspaceOverrides = mock(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve({});
      if (reads === 2)
        return new Promise<Record<string, unknown>>((resolve) => (release = resolve));
      return Promise.resolve({ disabledServers: ["ordinary"] });
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-forget-race";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;

    manager.forgetWorkspaceOverrides(workspaceId);
    const inFlight = manager.getToolsForWorkspace(recordedOptions());
    while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    // A newer parent save invalidates again while the (older) read is pending…
    manager.forgetWorkspaceOverrides(workspaceId);
    release({}); // …and the older read completes with pre-save state.
    // The superseded read is not served: this serve fails closed.
    expect((await inFlight).stats.enabledServerCount).toBe(0);

    // The newer invalidation must still force a disk read, which now sees the disable.
    const next = await manager.getToolsForWorkspace(recordedOptions());
    expect(reads).toBe(3);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("a forget landing after a serve selected its options fails that serve closed", async () => {
    // The serve already recorded its options and is awaiting server startup
    // when a parent save evicts the workspace. The recorded options are the
    // same object, and the config generation is unchanged, so the enablement
    // repair sees nothing to redo — the invalidation marker alone must gate
    // the return, or the revoked server's tools reach this stream.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    let releaseStartup: () => void = () => undefined;
    let startupGated = false;
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      const result = startResult(
        Object.keys(servers).map((name) => [name, { tools: { echo: testTool() } }])
      );
      if (!startupGated) return Promise.resolve(result);
      return new Promise((resolve) => {
        releaseStartup = () => resolve(result);
      });
    });
    const workspaceId = "ws-forget-mid-startup";
    startupGated = true;
    const inFlight = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    while (access.lastWorkspaceRequestOptions.get(workspaceId) === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Parent save revokes the server on disk and evicts us mid-startup.
    diskOverrides = { disabledServers: ["ordinary"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    releaseStartup();
    const served = await inFlight;
    expect(Object.keys(served.tools)).toHaveLength(0);
    expect(served.promptDescriptors).toHaveLength(0);

    // The marker survived: the next serve re-reads disk and observes the disable.
    startupGated = false;
    const recorded = access.lastWorkspaceRequestOptions.get(
      workspaceId
    ) as MCPWorkspaceRequestOptions;
    const next = await manager.getToolsForWorkspace(recorded);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("getPrompt does not dispatch through a stale entry when the workspace is invalidated mid-serve", async () => {
    // getPrompt's dispatch-time ensureWorkspaceServers fails closed via
    // serveResult, but does not rewrite the cached entry — the prompt path
    // must consume that verdict rather than consult the stale entry.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    const servers = { ordinary: stdioConfig("node ordinary.js") };
    configService.listServers = mock(() => Promise.resolve(servers));
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { prompts: [{ name: "status" }], getPrompt }]))
      );
    });
    const workspaceId = "ws-prompt-forget-mid-serve";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Sanity: the prompt dispatches normally.
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    // getPrompt reads config once in its stabilization loop, then again in the
    // dispatch-time serve: gate that second read.
    let listServersCalls = 0;
    let gatedListServersCalls = 0;
    let releaseListServers: () => void = () => undefined;
    configService.listServers = mock(() => {
      listServersCalls += 1;
      if (listServersCalls < 2) return Promise.resolve(servers);
      gatedListServersCalls += 1;
      return new Promise<typeof servers>((resolve) => {
        releaseListServers = () => resolve(servers);
      });
    });
    const prompt = manager.getPrompt(workspaceId, "ordinary", "status", {});
    while (gatedListServersCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Parent save revokes the server on disk and evicts this workspace while
    // the dispatch-time serve is mid-flight.
    diskOverrides = { disabledServers: ["ordinary"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    releaseListServers();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(prompt).rejects.toThrow(/unavailable|disabled/);
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("a plugin-epoch refresh never restores a snapshot over a publication that landed mid-read", async () => {
    manager.dispose();
    let token = "epoch-1";
    let release: (value: Record<string, unknown>) => void = () => undefined;
    let gateRead = false;
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => {
      if (!gateRead) return Promise.resolve(diskOverrides);
      gateRead = false; // gate exactly one read (the sweep's)
      return new Promise<Record<string, unknown>>((resolve) => (release = resolve));
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-refresh-vs-publication";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;

    // Sibling plugin mutation: the epoch sweep re-reads this workspace's
    // overrides; the read is in flight…
    gateRead = true;
    token = "epoch-2";
    const sweep = manager.getToolsForWorkspace(recordedOptions());
    while (readWorkspaceOverrides.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // …when a parent save publishes a disable authoritatively (disk first).
    diskOverrides = { disabledServers: ["ordinary"] };
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["ordinary"] });
    // The read completes with pre-save state; it must not win. (The serve's
    // stale `{}` snapshot then disagrees with the cache and is revalidated
    // against disk, which agrees with the publication.)
    release({});
    await sweep;
    expect(recordedOptions().overrides).toEqual({ disabledServers: ["ordinary"] });
    const next = await manager.getToolsForWorkspace(recordedOptions());
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("a publication landing between the final repair and the return fails that serve closed", async () => {
    // The repair derives enablement and resolves; the caller resumes one
    // microtask later. A publication squeezed into that gap replaced the
    // recorded options (its own listServers still pending) — the entry's
    // enabled set is stale for this serve and must not be filtered through.
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { tools: { echo: testTool() } }]))
      );
    });
    const workspaceId = "ws-publish-after-repair";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    const repairAccess = access as unknown as {
      repairEnablementAfterConcurrentMutation: (...args: unknown[]) => Promise<unknown>;
    };
    const realRepair = repairAccess.repairEnablementAfterConcurrentMutation.bind(manager);
    let publication: Promise<void> | undefined;
    spyOn(repairAccess, "repairEnablementAfterConcurrentMutation").mockImplementation(
      async (...args: unknown[]) => {
        const derivedFrom = await realRepair(...args);
        // Emulate the gap: the publication's synchronous part (recorded
        // options replaced, marker retired) runs before the caller resumes.
        publication ??= manager.applyWorkspaceOverrides(workspaceId, {
          disabledServers: ["ordinary"],
        });
        return derivedFrom;
      }
    );
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(served.tools)).toHaveLength(0);
    await publication;

    // The publication's own completion repaired the entry for later serves.
    spyOn(repairAccess, "repairEnablementAfterConcurrentMutation").mockImplementation(realRepair);
    const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(next.tools)).toHaveLength(0);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("getPrompt does not dispatch when a publication lands between the final serve and dispatch", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { prompts: [{ name: "status" }], getPrompt }]))
      );
    });
    const workspaceId = "ws-prompt-publish-gap";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    // Emulate the gap: the dispatch-time serve passed its gate, and a parent
    // publication's synchronous part (recorded options replaced, marker
    // retired; its own listServers still pending) runs before getPrompt resumes.
    const realEnsure = access.ensureWorkspaceServers.bind(manager);
    let publication: Promise<void> | undefined;
    let ensureCalls = 0;
    spyOn(access, "ensureWorkspaceServers").mockImplementation(async (...args: unknown[]) => {
      const served = await realEnsure(...args);
      // getPrompt calls ensure twice: stabilization, then dispatch-time.
      if (++ensureCalls === 2) {
        publication = manager.applyWorkspaceOverrides(workspaceId, {
          disabledServers: ["ordinary"],
        });
      }
      return served;
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "ordinary", "status", {})).rejects.toThrow(
      /unavailable|disabled/
    );
    expect(getPrompt).toHaveBeenCalledTimes(1);
    await publication;
  });

  test("a serve whose enablement repair fails after a publication fails closed", async () => {
    const servers = { ordinary: stdioConfig("node ordinary.js") };
    configService.listServers = mock(() => Promise.resolve(servers));
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { tools: { echo: testTool() } }]))
      );
    });
    const workspaceId = "ws-repair-fails";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    const repairAccess = access as unknown as {
      repairEnablementAfterConcurrentMutation: (...args: unknown[]) => Promise<unknown>;
    };
    const realRepair = repairAccess.repairEnablementAfterConcurrentMutation.bind(manager);
    let publication: Promise<void> | undefined;
    let releasePublication: () => void = () => undefined;
    spyOn(repairAccess, "repairEnablementAfterConcurrentMutation").mockImplementation(
      async (...args: unknown[]) => {
        if (publication === undefined) {
          // A publication replaces the recorded options; its own listServers
          // stays pending until after the serve returns…
          configService.listServers = mock(
            () =>
              new Promise<typeof servers>((resolve) => {
                releasePublication = () => resolve(servers);
              })
          );
          publication = manager.applyWorkspaceOverrides(workspaceId, {
            disabledServers: ["ordinary"],
          });
        }
        // …and the repair's own re-derivation fails.
        configService.listServers = mock(() => Promise.reject(new Error("config unreadable")));
        try {
          return await realRepair(...args);
        } finally {
          configService.listServers = mock(() => Promise.resolve(servers));
        }
      }
    );
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The stale enabled set must not be filtered through as if re-derived.
    expect(Object.keys(served.tools)).toHaveLength(0);
    releasePublication();
    await publication;
  });

  test("a publication landing during the epoch postflight fails that serve closed", async () => {
    manager.dispose();
    let tokenReads = 0;
    let publication: Promise<void> | undefined;
    const workspaceId = "ws-publish-during-postflight";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => {
          // Per serve: preflight (odd) then postflight (even). The second
          // serve's postflight is call 4 — publish while it is awaited.
          if (++tokenReads === 4) {
            publication = manager.applyWorkspaceOverrides(workspaceId, {
              disabledServers: ["ordinary"],
            });
          }
          return Promise.resolve("epoch-1");
        },
        readWorkspaceOverrides: () => Promise.resolve({}),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { tools: { echo: testTool() } }]))
      );
    });
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(1);

    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(publication).toBeDefined();
    expect(Object.keys(second.tools)).toHaveLength(0);
    await publication;
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(third.stats.enabledServerCount).toBe(0);
  });

  test("getToolsForWorkspace fails closed for a non-empty serve without enablement provenance", async () => {
    // A recursive serve that lost its provenance (or any path that cannot
    // vouch for what enablement was derived from) must not hand out tools.
    spyOn(access, "ensureWorkspaceServers").mockImplementation(() =>
      Promise.resolve({
        tools: { ordinary_echo: testTool() },
        toolServerNames: { ordinary_echo: "ordinary" },
        stats: cachedStats(),
        promptDescriptors: [],
      })
    );
    const served = await manager.getToolsForWorkspace(workspaceRequest("ws-no-provenance"));
    expect(Object.keys(served.tools)).toHaveLength(0);
  });

  test("getPrompt does not dispatch when a forget lands between the final serve and dispatch", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { prompts: [{ name: "status" }], getPrompt }]))
      );
    });
    const workspaceId = "ws-prompt-forget-gap";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    // A forget leaves the recorded options in place and only sets the marker.
    const realEnsure = access.ensureWorkspaceServers.bind(manager);
    let ensureCalls = 0;
    spyOn(access, "ensureWorkspaceServers").mockImplementation(async (...args: unknown[]) => {
      const served = await realEnsure(...args);
      if (++ensureCalls === 2) manager.forgetWorkspaceOverrides(workspaceId);
      return served;
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "ordinary", "status", {})).rejects.toThrow(
      /unavailable|disabled/
    );
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("an invalidation is retired only once the fresh options are the recorded ones", async () => {
    // Retiring the marker inside the disk read would leave a window in which
    // an overlapping serve sees no marker while the stale pre-read options are
    // still recorded — and installs them as current.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-retire-after-install";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const recordedOptions = () =>
      access.lastWorkspaceRequestOptions.get(workspaceId) as MCPWorkspaceRequestOptions;

    const generations = (
      access as unknown as { overridesInvalidationGenerations: Map<string, number> }
    ).overridesInvalidationGenerations;
    const recordedAtRetirement: unknown[] = [];
    const realDelete = generations.delete.bind(generations);
    generations.delete = (key: string) => {
      recordedAtRetirement.push(recordedOptions().overrides);
      return realDelete(key);
    };

    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = { disabledServers: ["ordinary"] };
    const served = await manager.getToolsForWorkspace(recordedOptions());
    expect(served.stats.enabledServerCount).toBe(0);
    // Whenever the marker went away, the recorded options already held the
    // fresh disk state — never the stale pre-read snapshot.
    expect(recordedAtRetirement.length).toBeGreaterThan(0);
    for (const overrides of recordedAtRetirement) {
      expect(overrides).toEqual({ disabledServers: ["ordinary"] });
    }
  });

  test("a stale caller snapshot cannot replace overrides recovered after an invalidation", async () => {
    // After the recovery serve records fresh disk state and retires the
    // marker, a request still carrying the pre-save caller snapshot takes the
    // fast path — the recovered overrides must be cached so they overlay it.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-stale-snapshot-after-recovery";
    const staleSnapshot = workspaceRequest(workspaceId); // pre-save: nothing disabled
    expect((await manager.getToolsForWorkspace(staleSnapshot)).stats.enabledServerCount).toBe(1);

    // Parent save disables the server on disk and evicts us; recovery re-reads.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = { disabledServers: ["ordinary"] };
    const recorded = access.lastWorkspaceRequestOptions.get(
      workspaceId
    ) as MCPWorkspaceRequestOptions;
    expect((await manager.getToolsForWorkspace(recorded)).stats.enabledServerCount).toBe(0);

    // A request that still holds the pre-save snapshot must not win.
    const late = await manager.getToolsForWorkspace(staleSnapshot);
    expect(late.stats.enabledServerCount).toBe(0);
  });

  test("a non-authoritative caller snapshot fails the serve closed unless disk vouches for it", async () => {
    // "No overrides" is not "no servers": a globally enabled server disabled
    // only by a document the caller could not read would otherwise start.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = undefined; // disk not authoritative either
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-untrusted-snapshot";
    // Establish recorded options first (an authoritative serve).
    diskOverrides = {};
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);

    // A request whose snapshot could not be established: even with recorded
    // options present, disk is re-read; when it cannot vouch either → closed.
    diskOverrides = undefined;
    const untrusted = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(untrusted.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Disk recovers and disables the server: the authoritative read wins over
    // the caller's (empty) snapshot.
    diskOverrides = { disabledServers: ["ordinary"] };
    const recovered = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(recovered.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(3);
  });

  test("prompt discovery honors a fail-closed serve instead of querying the published entry", async () => {
    // An invalidation landing while startup is in flight makes the serve fail
    // closed, yet the started instances are published (the next verifiable
    // serve reuses them). Discovery must neither run prompts/list against them
    // nor advertise their prompts on the strength of that entry alone.
    manager.dispose();
    const diskOverrides: Record<string, unknown> | undefined = undefined; // disk cannot vouch
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const workspaceId = "ws-prompts-fail-closed";
    const refreshPrompts = mock(() => Promise.resolve([{ name: "review" }]));
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      // A parent save's eviction lands mid-startup.
      manager.forgetWorkspaceOverrides(workspaceId);
      return Promise.resolve(
        startResult(
          Object.keys(servers).map((name) => [
            name,
            { prompts: [{ name: "review" }], refreshPrompts },
          ])
        )
      );
    });

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(descriptors).toEqual([]);
    expect(refreshPrompts).not.toHaveBeenCalled();
  });

  test("a distrusted re-read draws on the caller's remaining read budget, never a fresh one", async () => {
    // The caller's own read timed out on an unreachable ancestor: a second
    // full-length attempt here would double the request's wait and leave
    // another uncancellable remote probe behind. The re-read gets only what
    // remains of the caller's deadline (nothing → fail closed without a
    // read), and the deadline is request-scoped: recorded options must not
    // carry it into later prompt dispatch re-reads.
    manager.dispose();
    const readWorkspaceOverrides = mock(
      (_workspaceId: string, _options?: { timeoutMs?: number; signal?: AbortSignal }) =>
        Promise.resolve({} as Record<string, unknown> | undefined)
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(
        startResult(Object.keys(servers).map((name) => [name, { getPrompt }]))
      );
    });
    const workspaceId = "ws-shared-read-budget";

    // Budget exhausted by the caller's read: no second attempt, fail closed.
    const exhausted = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, {
        overrides: {},
        overridesAuthoritative: false,
        overridesReadDeadlineAt: Date.now() - 1,
      })
    );
    expect(exhausted.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Budget partly left: the re-read is bounded by the remainder.
    const partial = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, {
        overrides: {},
        overridesAuthoritative: false,
        overridesReadDeadlineAt: Date.now() + 5_000,
      })
    );
    expect(partial.stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);
    const remainder = readWorkspaceOverrides.mock.calls[0][1]?.timeoutMs;
    expect(remainder).toBeDefined();
    expect(remainder!).toBeLessThanOrEqual(5_000);
    expect(remainder!).toBeGreaterThan(0);

    // Prompt dispatch re-reads from the RECORDED options: the send's deadline
    // (long expired by then) must not be what bounds them.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await manager.getPrompt(workspaceId, "ordinary", "review", {})).toEqual({ text: "hi" });
    const promptRead = readWorkspaceOverrides.mock.calls.at(-1);
    expect(promptRead).toBeDefined();
    expect(promptRead![1]?.timeoutMs).toBeUndefined();
  });

  test("a cached publication that disagrees with an authoritative caller read is revalidated against disk", async () => {
    // A direct edit of the JSONC file bumps no epoch and publishes nothing;
    // the caller's later authoritative read sees it, the cache does not. Disk
    // decides — and the cache still repairs a caller snapshot that PREDATES a
    // save, because disk agrees with the cache in that case.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-cache-vs-fresh-caller";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // in-process publication: enabled
    // Caller agrees with the cache: served from it, no disk read.
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }))).stats
        .enabledServerCount
    ).toBe(1);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Direct file edit revokes the server; the caller's fresh read reflects it.
    diskOverrides = { disabledServers: ["ordinary"] };
    const afterEdit = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["ordinary"] } })
    );
    expect(afterEdit.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);
    expect(
      (
        access as unknown as { latestWorkspaceOverrides: Map<string, unknown> }
      ).latestWorkspaceOverrides.get(workspaceId)
    ).toEqual(diskOverrides);

    // A stale caller snapshot from before the edit still loses to disk.
    const stale = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(stale.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Disagreement with an unreadable disk fails closed.
    diskOverrides = undefined;
    const unreadable = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(unreadable.stats.enabledServerCount).toBe(0);
  });

  test("prompt discovery honors a caller's distrust and disagreement over recorded options", async () => {
    // A warmed workspace has recorded options (server enabled). Its document
    // then becomes unreadable: the caller forwards overridesAuthoritative
    // false, and the prompt list must revalidate against disk rather than
    // keep advertising the stale enabled server's prompts.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { prompts: [{ name: "status" }] }]))
      );
    });
    const workspaceId = "ws-prompts-distrusted-caller";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(await manager.getPromptsForWorkspace(workspaceRequest(workspaceId))).toHaveLength(1);

    // Document unreadable for both the caller and the manager: closed.
    diskOverrides = undefined;
    expect(
      await manager.getPromptsForWorkspace(
        workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
      )
    ).toHaveLength(0);

    // Disk readable again and revoking; a fresh authoritative caller read that
    // disagrees with the recorded (enabled) options is revalidated too.
    diskOverrides = { disabledServers: ["ordinary"] };
    expect(
      await manager.getPromptsForWorkspace(
        workspaceRequest(workspaceId, { overrides: { disabledServers: ["ordinary"] } })
      )
    ).toHaveLength(0);
  });

  test("a cached publication does not serve a caller whose own read could not establish the document", async () => {
    // The cache holds an in-process publication (server enabled); the document
    // has since become unreadable. Neither the caller nor the cache can vouch
    // for the current authorization: re-read disk, fail closed if it cannot.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = undefined;
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-cached-distrusted-caller";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // cached: nothing disabled
    // An authoritative caller is served from the cache without a disk read.
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Distrusted caller, disk unreadable: closed, cache left untouched.
    const closed = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(closed.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // Distrusted caller, disk readable and revoking: disk wins over the cache,
    // and the cache is revalidated with it.
    diskOverrides = { disabledServers: ["ordinary"] };
    const revoked = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(revoked.stats.enabledServerCount).toBe(0);
    expect(
      (
        access as unknown as { latestWorkspaceOverrides: Map<string, unknown> }
      ).latestWorkspaceOverrides.get(workspaceId)
    ).toEqual(diskOverrides);
    // The successful reread is recorded as authoritative: prompt paths that
    // replay the recorded options must not re-enter the disk read forever.
    const recorded = access.lastWorkspaceRequestOptions.get(
      workspaceId
    ) as MCPWorkspaceRequestOptions;
    expect(recorded.overridesAuthoritative).toBe(true);
    const readsBefore = readWorkspaceOverrides.mock.calls.length;
    expect((await manager.getToolsForWorkspace(recorded)).stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides.mock.calls.length).toBe(readsBefore);
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(0);
  });

  test("a sibling process's override write refreshes cached snapshots before the next serve", async () => {
    // Two backends share one home: backend A's save publishes only into A's
    // cache. B learns about it through the override epoch and must not let its
    // stale overlay supersede the fresh disk state.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const served = "ws-sibling-served";
    const coldCached = "ws-sibling-cold-cached";
    await manager.getToolsForWorkspace(workspaceRequest(served));
    // An earlier publication in THIS process cached an inheriting child that
    // was never served here.
    await manager.applyWorkspaceOverrides(coldCached, {});
    // Both caches say "nothing disabled"; recorded options exist for `served`.
    const recorded = access.lastWorkspaceRequestOptions.get(served) as MCPWorkspaceRequestOptions;
    expect((await manager.getToolsForWorkspace(recorded)).stats.enabledServerCount).toBe(1);
    const readsBefore = readWorkspaceOverrides.mock.calls.length;

    // Sibling backend disables the server on disk (for both workspaces) and
    // bumps the epoch.
    diskOverrides = { disabledServers: ["ordinary"] };
    epoch = "epoch-2";

    // Served workspace: the preflight sweep re-read its overrides from disk.
    const afterServed = await manager.getToolsForWorkspace(recorded);
    expect(afterServed.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides.mock.calls.length).toBeGreaterThan(readsBefore);
    // Cold cached workspace: its overlay was evicted, so the serve re-reads disk
    // instead of trusting the stale (empty) overlay or the caller snapshot.
    const afterCold = await manager.getToolsForWorkspace(workspaceRequest(coldCached));
    expect(afterCold.stats.enabledServerCount).toBe(0);
  });

  test("cache state predating the first epoch observation is evicted, not trusted", async () => {
    // Backend B received an in-process publication for a never-served child;
    // backend A then revoked the server before B's first serve. The baseline
    // token cannot vouch for that cache entry.
    manager.dispose();
    const readWorkspaceOverrides = mock(() =>
      Promise.resolve<Record<string, unknown>>({ disabledServers: ["ordinary"] })
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("epoch-already-advanced"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-cache-before-first-observation";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // pre-revocation publication
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(readWorkspaceOverrides).toHaveBeenCalled();
    expect(served.stats.enabledServerCount).toBe(0);
  });

  test("a sibling override write landing mid-serve is caught by the postflight bracket", async () => {
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let epochReads = 0;
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => {
          epochReads += 1;
          // Second serve: preflight is read 3, postflight is read 4 — the
          // sibling's write lands between them.
          if (epochReads === 4) {
            diskOverrides = { disabledServers: ["ordinary"] };
            epoch = "epoch-2";
          }
          return Promise.resolve(epoch);
        },
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-mid-serve-sibling-write";
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);
    // The serve whose postflight observes the new epoch must not return the
    // pre-revocation result; it retries against disk.
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(second.stats.enabledServerCount).toBe(0);
  });

  test("the postflight compares against the operation's own baseline, not a baseline advanced by a concurrent serve", async () => {
    // getPrompt has passed its process-local gates and awaits prompts/get when
    // a sibling revokes the server; a concurrent serve's preflight observes the
    // new epoch, evicts, and advances the live baseline. The prompt operation's
    // postflight then reads an epoch equal to the live baseline — but not to
    // the one it ran under — and must not accept its pre-revocation result.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    let releasePrompt: () => void = () => undefined;
    let promptGated = false;
    const getPrompt = mock(
      () =>
        new Promise<{ messages: unknown[] }>((resolve) => {
          promptGated = true;
          releasePrompt = () =>
            resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] });
        })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const names = Object.keys(args[0] as Record<string, unknown>);
      return Promise.resolve(
        startResult(names.map((name) => [name, { prompts: [{ name: "status" }], getPrompt }]))
      );
    });
    const workspaceId = "ws-prompt-baseline";
    const other = "ws-other-serve";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getToolsForWorkspace(workspaceRequest(other));

    const prompt = manager.getPrompt(workspaceId, "ordinary", "status", {});
    while (!promptGated) await new Promise((resolve) => setTimeout(resolve, 1));
    diskOverrides = { disabledServers: ["ordinary"] };
    epoch = "epoch-2";
    await manager.getToolsForWorkspace(workspaceRequest(other)); // advances the live baseline
    releasePrompt();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(prompt).rejects.toThrow(/disabled|unavailable/);
  });

  test("an unreadable override epoch fails serves closed instead of acting as a stable version", async () => {
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("mcp-overrides-epoch-unreadable"),
        readWorkspaceOverrides: () => Promise.resolve({}),
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const startServers = spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const workspaceId = "ws-epoch-unreadable";
    // Every serve — including the first — sees "unreadable" as a change it
    // cannot bound, and gives up rather than trusting anything (the request
    // builder then continues without MCP tools) — before any server process
    // is launched.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getToolsForWorkspace(workspaceRequest(workspaceId))).rejects.toThrow(
      /about to start/
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getToolsForWorkspace(workspaceRequest(workspaceId))).rejects.toThrow(
      /about to start/
    );
    expect(startServers).not.toHaveBeenCalled();
  });

  test("a cold off-host serve re-reads disk instead of trusting a snapshot older than the epoch baseline", async () => {
    // Backend B read an SSH workspace's overrides (request snapshot), backend A
    // then revoked the server and bumped the epoch, and only now does B reach
    // its first manager serve: the baseline it records is already A's token,
    // so neither eviction nor the postflight can catch the stale snapshot.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = { disabledServers: ["ordinary"] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("epoch-after-sibling-revocation"),
        readWorkspaceOverrides,
      },
    });
    access = manager as unknown as MCPServerManagerTestAccess;
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    spyOn(access, "startServers").mockImplementation((...args: unknown[]) => {
      const servers = args[0] as Record<string, unknown>;
      return Promise.resolve(startResult(Object.keys(servers).map((name) => [name, undefined])));
    });
    const remote = Object.create(RemoteRuntime.prototype) as Runtime;
    const served = await manager.getToolsForWorkspace(
      workspaceRequest("ws-cold-remote", { runtime: remote, overrides: {} })
    );
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);
    expect(served.stats.enabledServerCount).toBe(0);

    // When disk cannot vouch either, the cold serve fails closed rather than
    // falling back to the unbounded snapshot.
    diskOverrides = undefined;
    const unvouched = await manager.getToolsForWorkspace(
      workspaceRequest("ws-cold-remote-unreadable", { runtime: remote, overrides: {} })
    );
    expect(unvouched.stats.enabledServerCount).toBe(0);
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

  describe("argument sanitization", () => {
    const makeExecuteMock = () => mock((_args: unknown) => Promise.resolve({ content: [] }));

    // Mirrors how mcpClient builds MCP tools: jsonSchema() wrapping the
    // server-declared input schema.
    const makeTool = (executeMock: ReturnType<typeof makeExecuteMock>, required: string[] = []) =>
      ({
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            project_id: { type: "string" },
            assignee_id: { type: "string" },
            search: { type: "string" },
            labels: { type: "array" },
            milestone: { type: ["string", "null"] },
          },
          required,
          additionalProperties: false,
        }),
        execute: executeMock,
      }) as unknown as Tool;

    test("strips top-level empty strings for optional params before invoking the server", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock, ["project_id"]) });

      await wrapped.myTool.execute!(
        { project_id: "42332", assignee_id: "", search: "", labels: [], milestone: null },
        {} as never
      );

      expect(executeMock).toHaveBeenCalledTimes(1);
      // A server-declared nullable null and [] pass through; optional "" is dropped.
      expect(executeMock.mock.calls[0][0]).toEqual({
        project_id: "42332",
        labels: [],
        milestone: null,
      });
    });

    test("preserves empty string for schema-required params", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock, ["project_id"]) });

      await wrapped.myTool.execute!({ project_id: "", assignee_id: "" }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ project_id: "" });
    });

    test("passes args through unchanged when nothing needs stripping", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock) });

      const args = { project_id: "42332", search: "bug" };
      await wrapped.myTool.execute!(args, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual(args);
    });

    test("drops null for optional params whose schema does not accept null", async () => {
      // schemaSanitizer widens optional MCP properties to nullable for OpenAI
      // strict mode; the model then sends null for parameters it would have
      // omitted. That null is xum's artifact, so it never reaches the server.
      const executeMock = makeExecuteMock();
      const tool = {
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            title: { type: "string" },
            statusUpdateType: { type: "string", enum: ["onTrack", "atRisk"] },
            assigneeId: { type: ["string", "null"] },
            dueDate: { anyOf: [{ type: "string" }, { type: "null" }] },
            priority: { type: "integer" },
          },
          required: ["title", "priority"],
          additionalProperties: false,
        }),
        execute: executeMock,
      } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!(
        { title: "Fix", statusUpdateType: null, assigneeId: null, dueDate: null, priority: null },
        {} as never
      );

      expect(executeMock.mock.calls[0][0]).toEqual({
        title: "Fix",
        // Server-declared nullable: null passes through ("clear this field").
        assigneeId: null,
        dueDate: null,
        // Required: never dropped, even when null.
        priority: null,
      });
    });

    test("keeps null when the tool has no readable schema or the key is undeclared", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({
        noSchema: { execute: executeMock } as unknown as Tool,
        withSchema: makeTool(executeMock),
      });

      await wrapped.noSchema.execute!({ search: null }, {} as never);
      await wrapped.withSchema.execute!({ undeclared: null }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ search: null });
      expect(executeMock.mock.calls[1][0]).toEqual({ undeclared: null });
    });

    test("strips nested optional nulls and empty strings alongside the schema", async () => {
      const executeMock = makeExecuteMock();
      const tool = {
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            project: {
              type: "object",
              properties: { id: { type: "string" }, slug: { type: "string" } },
              required: ["id"],
            },
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, color: { type: "string" } },
                required: ["name"],
              },
            },
            meta: { type: "object" },
          },
          required: ["project"],
          additionalProperties: false,
        }),
        execute: executeMock,
      } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!(
        {
          project: { id: "", slug: null },
          labels: [
            { name: "bug", color: null },
            { name: "", color: "" },
          ],
          // Declared without properties: values below it are not touched.
          meta: { note: null, tag: "" },
        },
        {} as never
      );

      expect(executeMock.mock.calls[0][0]).toEqual({
        project: { id: "" },
        labels: [{ name: "bug" }, { name: "" }],
        meta: { note: null, tag: "" },
      });
    });

    test("strips empty strings when the tool has no readable schema", async () => {
      const executeMock = makeExecuteMock();
      const tool = { execute: executeMock } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!({ project_id: "42332", search: "" }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ project_id: "42332" });
    });

    test("leaves non-record args untouched", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock) });

      await wrapped.myTool.execute!(undefined, {} as never);

      expect(executeMock.mock.calls[0][0]).toBeUndefined();
    });
  });
});
