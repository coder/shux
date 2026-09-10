import { describe, expect, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverWorkspaceAgentPlugins, type AgentPluginInfo } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0, type AgentPluginContributes } from "./manifest";
import { collectPluginSlashCommands } from "./slashCommands";

function pluginWithCommands(
  name: string,
  scope: "project" | "global",
  contributes: AgentPluginContributes
): AgentPluginInfo {
  return {
    name,
    scope,
    rootPath: `/plugins/${name}`,
    containerPath: "/plugins",
    dirName: name,
    manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name, contributes },
  };
}

describe("collectPluginSlashCommands", () => {
  test("collects contributed commands with plugin attribution", () => {
    const commands = collectPluginSlashCommands([
      pluginWithCommands("my-plugin", "global", {
        slashCommands: [{ name: "greet", description: "Say hello", expansion: "Hello!" }],
      }),
    ]);

    expect(commands).toEqual([
      {
        name: "greet",
        description: "Say hello",
        expansion: "Hello!",
        pluginName: "my-plugin",
        scope: "global",
      },
    ]);
  });

  test("first plugin in precedence order wins on duplicate command names", () => {
    const commands = collectPluginSlashCommands([
      pluginWithCommands("project-plugin", "project", {
        slashCommands: [{ name: "greet", expansion: "project wins" }],
      }),
      pluginWithCommands("global-plugin", "global", {
        slashCommands: [{ name: "greet", expansion: "global loses" }],
      }),
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.pluginName).toBe("project-plugin");
    expect(commands[0]?.expansion).toBe("project wins");
  });

  test("workspace slash commands retain the global view after rejecting an outward project alias", async () => {
    using tmp = new DisposableTempDir("plugin-slash-global-fallback");
    const project = path.join(tmp.path, "checkout");
    const home = path.join(tmp.path, "managed-home");
    const pluginRoot = path.join(home, "plugins", "fallback-plugin");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "fallback-plugin",
        contributes: {
          slashCommands: [{ name: "fallback-command", expansion: "Run the global workflow" }],
        },
      })
    );
    const alias = path.join(project, ".xum", "plugins");
    await fs.mkdir(path.dirname(alias), { recursive: true });
    await fs.symlink(path.join(home, "plugins"), alias, "dir");
    const discovered = await discoverWorkspaceAgentPlugins({
      workspacePath: project,
      xumHome: home,
      projectTrusted: true,
    });
    expect(
      discovered.plugins
        .filter((plugin) => plugin.name === "fallback-plugin")
        .map((plugin) => plugin.scope)
    ).toEqual(["global"]);
    expect(
      discovered.diagnostics.some(
        (diagnostic) => diagnostic.scope === "project" && diagnostic.severity === "error"
      )
    ).toBe(true);
    expect(
      collectPluginSlashCommands(discovered.plugins).find(
        (command) => command.name === "fallback-command"
      )
    ).toMatchObject({ scope: "global", pluginName: "fallback-plugin" });
    const projectOnly = await discoverWorkspaceAgentPlugins({
      workspacePath: project,
      xumHome: path.join(tmp.path, "unused-home"),
      projectTrusted: true,
    });
    expect(
      collectPluginSlashCommands(projectOnly.plugins).some(
        (command) => command.name === "fallback-command"
      )
    ).toBe(false);
  });

  test("plugins without contributed commands yield nothing", () => {
    expect(collectPluginSlashCommands([pluginWithCommands("empty", "global", {})])).toEqual([]);
  });
});
