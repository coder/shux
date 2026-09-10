import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { discoverWorkflowScripts } from "./workflowScriptDiscovery";

async function writePluginWithWorkflow(workspacePath: string, pluginName: string): Promise<void> {
  const pluginDir = path.join(workspacePath, ".mux", "plugins", pluginName);
  await fs.mkdir(path.join(pluginDir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginName,
    }),
    "utf-8"
  );
  await fs.writeFile(
    path.join(pluginDir, "workflows", "release.js"),
    "export const meta = { name: 'plugin-release', description: 'Release helper workflow' };",
    "utf-8"
  );
}

describe("discoverWorkflowScripts (agent plugins)", () => {
  // Generous timeout: discovery probes every built-in/global skill for a
  // workflow.js entry, which is slow on machines with many installed skills.
  test("enumerates plugin workflows/ contributions only when the experiment is enabled", async () => {
    using tempDir = new TestTempDir("workflow-discovery-plugin");
    await writePluginWithWorkflow(tempDir.path, "my-unique-fixture-plugin");

    const input = {
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    };

    const withPlugins = await discoverWorkflowScripts({ ...input, includeAgentPlugins: true });
    const pluginEntry = withPlugins.find(
      (workflow) => workflow.scriptPath === "plugin://my-unique-fixture-plugin/release.js"
    );
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry?.descriptor.sourceKind).toBe("plugin");
    expect(pluginEntry?.descriptor.scope).toBe("project");

    const withoutPlugins = await discoverWorkflowScripts(input);
    expect(withoutPlugins.some((workflow) => workflow.scriptPath.startsWith("plugin://"))).toBe(
      false
    );
  }, 60_000);
});
