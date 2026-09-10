import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { MCPServerInfo } from "@/common/types/mcp";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { buildWorkspaceComposition } from "./composition";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

const PLUGIN_NAME = "fixture-comp-plugin";
const PLUGIN_SOURCE = `plugin:${PLUGIN_NAME}`;

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
    "utf-8"
  );
}

/** One plugin contributing one of each artifact type. */
async function writeFixturePlugin(workspacePath: string): Promise<void> {
  const pluginDir = path.join(workspacePath, ".mux", "plugins", PLUGIN_NAME);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: PLUGIN_NAME,
      version: "1.2.3",
      contributes: {
        slashCommands: [
          { name: "fixture-greet", description: "Say hello", expansion: "Hello from plugin" },
        ],
      },
    }),
    "utf-8"
  );

  await writeSkill(
    path.join(pluginDir, "skills", "fixture-skill"),
    "fixture-skill",
    "Plugin skill"
  );
  await writeSkill(
    path.join(pluginDir, "skills", "shared-fixture-skill"),
    "shared-fixture-skill",
    "Plugin skill (shadowed)"
  );

  await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "agents", "fixture-agent.md"),
    "---\nname: Fixture Agent\ndescription: Plugin agent\n---\nBody\n",
    "utf-8"
  );

  await fs.mkdir(path.join(pluginDir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "workflows", "fixture-flow.js"),
    "export const meta = { name: 'fixture-flow', description: 'Fixture plugin workflow' };",
    "utf-8"
  );

  await fs.writeFile(path.join(pluginDir, "hooks.js"), "// no hooks\n", "utf-8");
  await fs.writeFile(path.join(pluginDir, "mcp.json"), "{}", "utf-8");
}

function stubMcpLayers(): Promise<{
  plugin: Record<string, MCPServerInfo>;
  global: Record<string, MCPServerInfo>;
  project: Record<string, MCPServerInfo>;
}> {
  const stdio = (command: string): MCPServerInfo => ({
    transport: "stdio",
    command,
    disabled: false,
  });
  return Promise.resolve({
    plugin: {
      "plugin:abc123:tools": {
        ...stdio("plugin-tool"),
        plugin: {
          pluginName: PLUGIN_NAME,
          serverName: "tools",
          sourceScope: "project",
          sourceLocation: `.mux/plugins/${PLUGIN_NAME}`,
        },
      },
    },
    global: { shared: stdio("global-shared"), "global-only": stdio("global-only") },
    project: { shared: stdio("project-shared") },
  });
}

describe("buildWorkspaceComposition", () => {
  test("reports a fixture plugin contributing one of each artifact type with layering + shadowing", async () => {
    using workspace = new DisposableTempDir("composition-workspace");
    await writeFixturePlugin(workspace.path);
    // Project skill shadowing the plugin skill of the same name.
    await writeSkill(
      path.join(workspace.path, ".mux", "skills", "shared-fixture-skill"),
      "shared-fixture-skill",
      "Project skill"
    );
    // Project shell tool hook (hooks.ts precedence: project shadows user-level).
    await fs.writeFile(path.join(workspace.path, ".mux", "tool_pre"), "#!/bin/sh\n", "utf-8");

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: workspace.path,
      hostCheckoutRoot: workspace.path,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      agentPluginsEnabled: true,
      listMcpServerLayers: stubMcpLayers,
    });

    expect(composition.agentPluginsEnabled).toBe(true);

    // Plugin summary lists every contributed component kind.
    const plugin = composition.plugins.find((p) => p.name === PLUGIN_NAME);
    expect(plugin).toBeDefined();
    expect(plugin?.version).toBe("1.2.3");
    expect(plugin?.components.sort()).toEqual(
      ["agents", "hooks", "mcp", "skills", "slashCommands", "workflows"].sort()
    );

    // Skills: plugin skill effective; project skill shadows the plugin skill.
    const pluginSkill = composition.skills.find((s) => s.name === "fixture-skill");
    expect(pluginSkill?.source).toBe(PLUGIN_SOURCE);
    expect(pluginSkill?.shadowedBy).toBeUndefined();

    const shared = composition.skills.filter((s) => s.name === "shared-fixture-skill");
    expect(shared).toHaveLength(2);
    const projectSkill = shared.find((s) => s.source === "project");
    const shadowedPluginSkill = shared.find((s) => s.source === PLUGIN_SOURCE);
    expect(projectSkill?.shadowedBy).toBeUndefined();
    expect(shadowedPluginSkill?.shadowedBy).toBe("project");

    // Agents.
    const agent = composition.agents.find((a) => a.name === "fixture-agent");
    expect(agent?.source).toBe(PLUGIN_SOURCE);

    // Workflows.
    const workflow = composition.workflows.find((w) => w.name === "fixture-flow");
    expect(workflow?.source).toBe(PLUGIN_SOURCE);

    // MCP: plugin provenance labels the entry; project config shadows global.
    const mcpPlugin = composition.mcpServers.find((s) => s.name === "plugin:abc123:tools");
    expect(mcpPlugin?.source).toBe(PLUGIN_SOURCE);
    const mcpShared = composition.mcpServers.filter((s) => s.name === "shared");
    expect(mcpShared.find((s) => s.source === "project")?.shadowedBy).toBeUndefined();
    expect(mcpShared.find((s) => s.source === "global")?.shadowedBy).toBe("project");

    // Slash commands + hooks.
    const command = composition.slashCommands.find((c) => c.name === "fixture-greet");
    expect(command?.source).toBe(PLUGIN_SOURCE);
    const hook = composition.hooks.find((h) => h.source === PLUGIN_SOURCE);
    expect(hook?.name).toBe("hooks.js");
    const shellHook = composition.hooks.find(
      (h) => h.name === "tool_pre" && h.source === "project"
    );
    expect(shellHook).toBeDefined();
  }, 120_000);

  test("plugins are inspected but not loaded when the experiment is disabled", async () => {
    using workspace = new DisposableTempDir("composition-workspace-gated");
    await writeFixturePlugin(workspace.path);

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: workspace.path,
      hostCheckoutRoot: workspace.path,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      agentPluginsEnabled: false,
      listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
    });

    expect(composition.agentPluginsEnabled).toBe(false);
    // Inspection is unconditional: the plugin and its components are reported.
    expect(composition.plugins.map((p) => p.name)).toContain(PLUGIN_NAME);
    // Loading is gated: no plugin-sourced artifacts in the effective layers.
    const allEntries = [
      ...composition.skills,
      ...composition.agents,
      ...composition.workflows,
      ...composition.slashCommands,
      ...composition.hooks,
    ];
    expect(allEntries.some((entry) => entry.source === PLUGIN_SOURCE)).toBe(false);
  }, 120_000);

  test("subProjectPath workspaces report checkout-level plugin skills", async () => {
    using workspace = new DisposableTempDir("composition-workspace-subproject");
    // Plugin at the CHECKOUT root; the workspace executes in a subdirectory
    // (subProjectPath). Production anchors plugin skill containers at the
    // checkout root, so the inspector must report this plugin's skills even
    // though execution-path defaults would scan <subdir>/.mux/plugins.
    await writeFixturePlugin(workspace.path);
    const executionPath = path.join(workspace.path, "packages", "app");
    await fs.mkdir(executionPath, { recursive: true });

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: executionPath,
      hostCheckoutRoot: workspace.path,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      agentPluginsEnabled: true,
      listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
    });

    expect(composition.plugins.map((p) => p.name)).toContain(PLUGIN_NAME);
    const pluginSkill = composition.skills.find((s) => s.name === "fixture-skill");
    expect(pluginSkill?.source).toBe(PLUGIN_SOURCE);
  }, 120_000);

  test("off-host workspaces (null host root) discover no plugin containers", async () => {
    using workspace = new DisposableTempDir("composition-workspace-offhost");
    // A plugin exists at the workspace path on the HOST filesystem — the
    // off-host bug was scanning the remote workspacePath as a host project
    // root and reporting plugins production never loads.
    await writeFixturePlugin(workspace.path);

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: workspace.path,
      hostCheckoutRoot: null,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      agentPluginsEnabled: true,
      listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
    });

    expect(composition.plugins).toHaveLength(0);
    expect(composition.diagnostics).toHaveLength(0);
    const allEntries = [
      ...composition.skills,
      ...composition.agents,
      ...composition.workflows,
      ...composition.slashCommands,
      ...composition.hooks,
    ];
    expect(allEntries.some((entry) => entry.source === PLUGIN_SOURCE)).toBe(false);
  }, 120_000);
});
