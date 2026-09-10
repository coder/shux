import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager } from "./mcpServerManager";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { WorkspaceMetadata } from "@/common/types/workspace";

describe("MCPConfigService", () => {
  let tempDir: string;
  let config: Config;
  let configService: MCPConfigService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    config = new Config(tempDir);
    configService = new MCPConfigService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("resolveWorkspaceAgentPluginsContext preserves the off-host null sentinel", async () => {
    // null suppresses plugin discovery entirely; coercing it to undefined would
    // fall back to project-level discovery and offer repo-controlled plugins for
    // workspaces that execute off-host.
    const cases: Array<{
      runtimeConfig: WorkspaceMetadata["runtimeConfig"];
      namedWorkspacePath?: string;
      expectedNull: boolean;
    }> = [
      {
        runtimeConfig: { type: "ssh", host: "example", srcBaseDir: "/remote/src" },
        namedWorkspacePath: "/remote/src/proj/ws1",
        expectedNull: true,
      },
      {
        runtimeConfig: { type: "worktree", srcBaseDir: tempDir },
        namedWorkspacePath: undefined,
        expectedNull: false,
      },
    ];
    for (const testCase of cases) {
      const projectPath = path.join(tempDir, "proj");
      // namedWorkspacePath is persisted alongside metadata for SSH workspaces (see WorkspaceMetadataForRuntime).
      const metadata: WorkspaceMetadata & { namedWorkspacePath?: string } = {
        id: "ws1234567890",
        name: "ws1",
        projectName: "proj",
        projectPath,
        runtimeConfig: testCase.runtimeConfig,
        namedWorkspacePath: testCase.namedWorkspacePath,
      };
      const service = new MCPConfigService(config, {
        workspaceMetadataProvider: {
          getWorkspaceMetadata: () => Promise.resolve({ success: true as const, data: metadata }),
        },
      });
      const resolved = await service.resolveWorkspaceAgentPluginsContext(
        "ws1234567890",
        projectPath
      );
      if (testCase.expectedNull) {
        expect(resolved).toBeNull();
      } else {
        expect(resolved).toMatchObject({ projectKey: projectPath });
      }
    }
  });

  test("writes global config to <rootDir>/mcp.jsonc", async () => {
    const result = await configService.addServer("test", {
      transport: "stdio",
      command: "echo hi",
    });
    expect(result).toEqual({ success: true, data: undefined });

    const globalPath = path.join(config.rootDir, "mcp.jsonc");
    const raw = await fs.readFile(globalPath, "utf-8");

    // Basic smoke check: file exists and contains our server name.
    expect(raw).toContain('"test"');
  });

  test("listServers merges repo overrides on top of global (override wins by name)", async () => {
    await configService.addServer("shared", {
      transport: "stdio",
      command: "global-shared",
    });

    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      `// repo override\n{\n  "servers": {\n    "shared": "repo-shared",\n    "repo-only": { "command": "repo-only", "disabled": true }\n  }\n}\n`,
      "utf-8"
    );

    const merged = await configService.listServers(projectPath, true);

    expect(merged).toEqual({
      shared: { transport: "stdio", command: "repo-shared", disabled: false },
      "global-only": { transport: "stdio", command: "global-only", disabled: false },
      "repo-only": { transport: "stdio", command: "repo-only", disabled: true },
    });
  });

  test("prefers canonical repo overrides when both project paths exist", async () => {
    const projectPath = path.join(tempDir, "repo-canonical");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      JSON.stringify({ servers: { selected: "legacy", "legacy-only": "legacy-only" } }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { selected: "canonical" } }),
      "utf-8"
    );

    expect(await configService.listServers(projectPath, true)).toEqual({
      selected: { transport: "stdio", command: "canonical", disabled: false },
    });
  });

  test("listServers ignores repo overrides for untrusted projects", async () => {
    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo-untrusted");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      JSON.stringify(
        {
          servers: {
            "repo-only": "repo-only",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    expect(await configService.listServers(projectPath, false)).toEqual({
      "global-only": { transport: "stdio", command: "global-only", disabled: false },
    });
  });

  test("project-automation kill-switch ignores repo overrides even when trusted", async () => {
    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo-automation-disabled");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { "repo-only": "repo-only" } }),
      "utf-8"
    );

    const prev = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      // Trust stays (delegation depends on it) but repo-configured MCP
      // servers must not load: they would run dataset code with provider
      // credentials in the environment.
      expect(await configService.listServers(projectPath, true)).toEqual({
        "global-only": { transport: "stdio", command: "global-only", disabled: false },
      });
    } finally {
      if (prev === undefined) {
        delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      } else {
        process.env[DISABLE_PROJECT_AUTOMATION_ENV] = prev;
      }
    }
  });
  test("API mutations enforce policy and emit telemetry", async () => {
    const capture = mock(() => undefined);
    const apiService = new MCPConfigService(config, {
      policyService: {
        isEnforced: () => true,
        isMcpTransportAllowed: (transport: string) => transport === "stdio",
      },
      telemetryService: { capture },
    });
    expect(
      await apiService.addForApi({ name: "remote", transport: "http", url: "https://x" })
    ).toEqual({ success: false, error: "MCP transport is disabled by policy" });
    await apiService.addForApi({ name: "local", command: "node server.js" });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp_server_config_changed" })
    );
  });
});

describe("MCP server disable filtering", () => {
  let tempDir: string;
  let config: Config;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("disabled servers are filtered from manager.listServers", async () => {
    // Add two servers
    await configService.addServer("enabled-server", {
      transport: "stdio",
      command: "cmd1",
    });
    await configService.addServer("disabled-server", {
      transport: "stdio",
      command: "cmd2",
    });

    // Disable one
    await configService.setServerEnabled("disabled-server", false);

    // Config service returns both (with disabled flag)
    const allServers = await configService.listServers(tempDir);
    expect(allServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
      "disabled-server": { transport: "stdio", command: "cmd2", disabled: true },
    });

    // Server manager filters to enabled only
    const enabledServers = await serverManager.listServers(tempDir);
    expect(enabledServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
    });
  });

  // --- Agent Plugins provider (agent-plugins experiment) ---

  const PLUGIN_SERVER = {
    transport: "stdio" as const,
    command: "bunx",
    args: ["-y", "some-server"],
    disabled: true,
    plugin: {
      pluginName: "demo",
      serverName: "srv",
      sourceScope: "global" as const,
      sourceLocation: ".mux/plugins/demo",
    },
  };

  test("listServers merges Agent Plugins servers at the lowest precedence", async () => {
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () =>
        Promise.resolve({
          "plugin:abc:srv": PLUGIN_SERVER,
          // A hostile plugin key colliding with a user server must lose.
          collides: { ...PLUGIN_SERVER, command: "plugin-command" },
        }),
    });
    await withProvider.addServer("collides", { transport: "stdio", command: "user-command" });

    const servers = await withProvider.listServers();

    expect(servers["plugin:abc:srv"]).toEqual(PLUGIN_SERVER);
    expect(servers.collides).toEqual({
      transport: "stdio",
      command: "user-command",
      disabled: false,
      toolAllowlist: undefined,
    });
  });

  test("canonical plugin keys are reserved: ignored in user config layers, rejected by addServer", async () => {
    // A user server occupying a canonical `plugin:<16-hex>:<name>` key would
    // shadow the plugin server (user layers win on collision) yet lose its
    // workspace overrides to that plugin's uninstall, which prunes such keys
    // by shape. Hand-edited config entries are ignored (not started, not
    // shadowing); the add flow rejects the name outright.
    const reservedKey = "plugin:0123456789abcdef:srv";
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.resolve({ [reservedKey]: PLUGIN_SERVER }),
    });

    const added = await withProvider.addServer(reservedKey, { transport: "stdio", command: "x" });
    expect(added.success).toBe(false);
    if (!added.success) {
      expect(added.error).toContain("reserved");
    }

    // Hand-edited global + project entries on the reserved key.
    await fs.writeFile(
      path.join(config.rootDir, "mcp.jsonc"),
      JSON.stringify({ servers: { [reservedKey]: "user-global", ordinary: "user-ordinary" } }),
      "utf-8"
    );
    const projectPath = path.join(tempDir, "repo-reserved");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { [reservedKey]: "user-project" } }),
      "utf-8"
    );

    const servers = await withProvider.listServers(projectPath, true);
    // The plugin server keeps its reserved key; the user entries neither
    // shadow it nor appear under their own name. Ordinary names still load.
    expect(servers[reservedKey]).toEqual(PLUGIN_SERVER);
    expect(servers.ordinary).toMatchObject({ command: "user-ordinary" });
  });

  test("listServers resolves the Agent Plugins context: default, explicit, and null", async () => {
    const seenArgs: Array<{ projectRoot?: string; projectKey?: string; trusted: boolean }> = [];
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: (args) => {
        seenArgs.push(args);
        return Promise.resolve({});
      },
    });

    // Default: scan under projectPath, keyed by projectPath (project-level flows).
    await withProvider.listServers();
    await withProvider.listServers("/proj", false);
    await withProvider.listServers("/proj", true);
    // Explicit context: workspace flows scan the active worktree, keyed by the project.
    await withProvider.listServers("/proj", true, {
      agentPlugins: { projectRoot: "/worktrees/ws-1", projectKey: "/proj" },
    });
    // Null: off-host workspace — provider must not be consulted at all.
    await withProvider.listServers("/proj", true, { agentPlugins: null });

    expect(seenArgs).toEqual([
      { projectRoot: undefined, projectKey: undefined, trusted: false },
      { projectRoot: "/proj", projectKey: "/proj", trusted: false },
      { projectRoot: "/proj", projectKey: "/proj", trusted: true },
      { projectRoot: "/worktrees/ws-1", projectKey: "/proj", trusted: true },
    ]);
  });

  test("a throwing Agent Plugins provider never breaks listServers", async () => {
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.reject(new Error("boom")),
    });
    await withProvider.addServer("still-there", { transport: "stdio", command: "cmd" });

    const servers = await withProvider.listServers();

    expect(Object.keys(servers)).toEqual(["still-there"]);
  });

  test("plugin servers are never persisted: mutations reject plugin keys", async () => {
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.resolve({ "plugin:abc:srv": PLUGIN_SERVER }),
    });

    expect((await withProvider.setServerEnabled("plugin:abc:srv", true)).success).toBe(false);
    expect((await withProvider.removeServer("plugin:abc:srv")).success).toBe(false);
    expect((await withProvider.setToolAllowlist("plugin:abc:srv", [])).success).toBe(false);

    // The on-disk global config never gained a plugin entry.
    const globalRaw = await fs
      .readFile(path.join(config.rootDir, "mcp.jsonc"), "utf-8")
      .catch(() => "");
    expect(globalRaw).not.toContain("plugin:abc:srv");
  });
});

describe("Workspace MCP overrides filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    const config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);

    // Set up multiple servers for testing
    await configService.addServer("server-a", { transport: "stdio", command: "cmd-a" });
    await configService.addServer("server-b", { transport: "stdio", command: "cmd-b" });
    await configService.addServer("server-c", { transport: "stdio", command: "cmd-c" });
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("listServers with no overrides returns all enabled servers", async () => {
    const servers = await serverManager.listServers(tempDir);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with empty overrides returns all enabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {};
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with disabledServers filters out disabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-a", "server-c"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
    });
  });

  test("listServers with disabledServers removes servers not in config (no error)", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["non-existent-server"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("enabledServers overrides project-level disabled", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Without override, server-a should be disabled
    const serversWithoutOverride = await serverManager.listServers(tempDir);
    expect(serversWithoutOverride).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });

    // With enabledServers override, server-a should be re-enabled
    const overrides: WorkspaceMCPOverrides = {
      enabledServers: ["server-a"],
    };
    const serversWithOverride = await serverManager.listServers(tempDir, overrides);
    expect(serversWithOverride).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("project-disabled and workspace-disabled work together", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Disable server-b at workspace level
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-b"],
    };

    const servers = await serverManager.listServers(tempDir, overrides);
    // Only server-c should remain
    expect(servers).toEqual({
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });
});
