import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import {
  computeAgentPluginContainers,
  discoverAgentPlugins,
  journalDerivedDiscoveryGate,
  setAgentPluginDiscoveryGate,
} from "./discovery";
import { bumpContainerMutationEpoch, MUTATION_EPOCH_FILE, STAGING_DIR_NAME } from "./journals";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { createTestPluginInstallEntry } from "./testFixtures";

async function writePlugin(
  containerPath: string,
  dirName: string,
  options?: {
    manifest?: unknown;
    rawManifest?: string;
    skills?: string[];
    mcpJson?: string;
    agents?: string[];
    workflows?: string[];
  }
): Promise<string> {
  const pluginDir = path.join(containerPath, dirName);
  await fs.mkdir(pluginDir, { recursive: true });

  const manifest = options?.manifest ?? {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: dirName,
  };
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    options?.rawManifest ?? JSON.stringify(manifest),
    "utf8"
  );

  for (const skillName of options?.skills ?? []) {
    const skillDir = path.join(pluginDir, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Test skill\n---\nBody\n`,
      "utf8"
    );
  }

  if (options?.mcpJson !== undefined) {
    await fs.writeFile(path.join(pluginDir, "mcp.json"), options.mcpJson, "utf8");
  }

  for (const agentId of options?.agents ?? []) {
    const agentsDir = path.join(pluginDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, `${agentId}.md`),
      `---\nname: ${agentId}\ndescription: Test agent\n---\nBody\n`,
      "utf8"
    );
  }

  for (const workflowFile of options?.workflows ?? []) {
    const workflowsDir = path.join(pluginDir, "workflows");
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(path.join(workflowsDir, workflowFile), "export {};\n", "utf8");
  }

  return pluginDir;
}

describe("discoverAgentPlugins", () => {
  test("discovers a valid plugin with skills and mcp.json component paths", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "hello-plugin", { skills: ["greet"], mcpJson: "{}" });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.name).toBe("hello-plugin");
    expect(plugin.scope).toBe("global");
    expect(plugin.rootPath).toBe(await fs.realpath(path.join(container, "hello-plugin")));
    expect(plugin.skillsDir).toBe(path.join(plugin.rootPath, "skills"));
    expect(plugin.mcpConfigPath).toBe(path.join(plugin.rootPath, "mcp.json"));
    expect(result.diagnostics).toEqual([]);
  });

  test("unidentified registry rows isolate unknown directories without suppressing healthy imports", async () => {
    using tmp = new DisposableTempDir("agent-plugins-row-recovery");
    const container = path.join(tmp.path, "plugins");
    const registryPath = path.join(tmp.path, "plugins.json");
    for (const name of ["selected", "legacy", "unassociated"]) await writePlugin(container, name);
    const selection = { skills: ["greet"], mcpServers: [] };
    const healthy = [
      createTestPluginInstallEntry("selected", selection),
      createTestPluginInstallEntry("legacy"),
    ];
    for (const unidentified of [
      null,
      1,
      "lost",
      {},
      [],
      { name: 1 },
      { name: "" },
      { name: "../demo" },
      { name: "con" },
    ]) {
      for (const rows of [
        [...healthy, unidentified],
        [unidentified, ...healthy],
      ]) {
        await fs.writeFile(registryPath, JSON.stringify({ plugins: rows }));
        const { plugins } = await discoverAgentPlugins([
          { path: container, scope: "global", registryPath },
        ]);
        expect(plugins).toHaveLength(3);
        expect(plugins.find((plugin) => plugin.name === "selected")?.importedComponents).toEqual(
          selection
        );
        expect(
          plugins.find((plugin) => plugin.name === "legacy")?.importedComponents
        ).toBeUndefined();
        expect(
          plugins.find((plugin) => plugin.name === "unassociated")?.importedComponents
        ).toEqual({
          skills: [],
          mcpServers: [],
        });
      }
    }
    await fs.writeFile(registryPath, JSON.stringify({ plugins: healthy }));
    const { plugins } = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath },
    ]);
    expect(
      plugins.find((plugin) => plugin.name === "unassociated")?.importedComponents
    ).toBeUndefined();
  });

  test("truncated named registry rows cannot turn a managed plugin into legacy import-all", async () => {
    using tmp = new DisposableTempDir("agent-plugins-truncated-registry");
    const container = path.join(tmp.path, "plugins");
    const registryPath = path.join(tmp.path, "plugins.json");
    await writePlugin(container, "demo");
    await writePlugin(container, "unassociated");
    await fs.writeFile(registryPath, JSON.stringify({ plugins: [{ name: "demo" }] }));
    const { plugins } = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath },
    ]);
    expect(plugins).toHaveLength(2);
    expect(plugins[0].importedComponents).toEqual({ skills: [], mcpServers: [] });
    expect(plugins[1].importedComponents).toBeUndefined();
  });

  test.each([
    "{",
    JSON.stringify({
      plugins: [createTestPluginInstallEntry("shared", { skills: [], mcpServers: [] })],
    }),
  ])("ignores an unmanaged global container's sibling registry (%s)", async (unmanagedRegistry) => {
    using tmp = new DisposableTempDir("agent-plugins-registry-scope");
    const xumHome = path.join(tmp.path, "xum");
    const managed = path.join(xumHome, "plugins");
    const universal = path.join(tmp.path, ".agents", "plugins");
    for (const container of [managed, universal]) {
      await writePlugin(container, "shared", { skills: ["greet"], mcpJson: "{}" });
    }
    const selection = { skills: ["greet"], mcpServers: [] };
    await fs.writeFile(
      path.join(xumHome, "plugins.json"),
      JSON.stringify({ plugins: [createTestPluginInstallEntry("shared", selection)] })
    );
    await fs.writeFile(path.join(path.dirname(universal), "plugins.json"), unmanagedRegistry);
    const containers = computeAgentPluginContainers({ xumHome, projectTrusted: false }).map(
      (container) => ({ ...container, path: container.path === managed ? managed : universal })
    );
    const { plugins } = await discoverAgentPlugins(containers);
    expect(plugins).toHaveLength(2);
    expect(plugins.find((plugin) => plugin.containerPath === managed)?.importedComponents).toEqual(
      selection
    );
    expect(
      plugins.find((plugin) => plugin.containerPath === universal)?.importedComponents
    ).toBeUndefined();

    await fs.writeFile(path.join(xumHome, "plugins.json"), "{");
    const corrupted = await discoverAgentPlugins(containers);
    expect(corrupted.plugins).toHaveLength(2);
    expect(
      corrupted.plugins.find((plugin) => plugin.containerPath === managed)?.importedComponents
    ).toEqual({
      skills: [],
      mcpServers: [],
    });
    expect(
      corrupted.plugins.find((plugin) => plugin.containerPath === universal)?.importedComponents
    ).toBeUndefined();
  });

  test("discovers agents/ and workflows/ component directories", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "full-plugin", {
      agents: ["reviewer"],
      workflows: ["release.js"],
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.agentsDir).toBe(path.join(plugin.rootPath, "agents"));
    expect(plugin.workflowsDir).toBe(path.join(plugin.rootPath, "workflows"));
    expect(result.diagnostics).toEqual([]);
  });

  test("contributes path overrides relocate component resolution", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "custom-plugin", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "custom-plugin",
        contributes: { skills: "lib/skills", workflows: "scripts" },
      },
    });
    await fs.mkdir(path.join(pluginDir, "lib", "skills"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "scripts"), { recursive: true });
    // The conventional locations exist too, but the override must win.
    await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.skillsDir).toBe(path.join(plugin.rootPath, "lib", "skills"));
    expect(plugin.workflowsDir).toBe(path.join(plugin.rootPath, "scripts"));
    expect(plugin.agentsDir).toBeUndefined();
  });

  test("discovers a manifest-only plugin without components", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "bare-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "project" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  test("silently skips entries without plugin.json (e.g. Codex marketplace dirs)", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(path.join(container, "not-a-plugin"), { recursive: true });
    await fs.writeFile(path.join(container, "not-a-plugin", "marketplace.json"), "{}", "utf8");
    // Loose file directly in the container is also skipped.
    await fs.writeFile(path.join(container, "marketplace.json"), "{}", "utf8");
    await writePlugin(container, "real-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["real-plugin"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a broken sibling plugin never affects a valid one", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "a-broken", { rawManifest: "{ not json" });
    await writePlugin(container, "b-invalid", {
      manifest: { $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "Bad--Name" },
    });
    await writePlugin(container, "c-valid");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["c-valid"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  test("reports unsupported $schema distinctly from invalid manifests", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "future-plugin", {
      manifest: {
        $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
        name: "future-plugin",
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Unsupported Agent Plugins version");
  });

  test("loads plugins with unknown top-level manifest fields and reports a warning", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "extra-plugin", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "extra-plugin",
        commands: ["x"],
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["extra-plugin"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe("warning");
    expect(result.diagnostics[0].message).toContain("commands");
  });

  test("rejects a plugin whose plugin.json symlink escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "escaper" }),
      "utf8"
    );
    const pluginDir = path.join(container, "escaper");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.symlink(outside, path.join(pluginDir, "plugin.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("skills symlink escaping the root invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outsideSkills = path.join(tmp.path, "outside-skills");
    await fs.mkdir(outsideSkills, { recursive: true });
    const pluginDir = await writePlugin(container, "escaping-skills", { mcpJson: "{}" });
    await fs.symlink(outsideSkills, path.join(pluginDir, "skills"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    // MCP component is unaffected (§6.2 narrowest-scope invalidation).
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("skills/");
  });

  test("mcp.json of the wrong filesystem kind invalidates only the MCP component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dir-mcp", { skills: ["greet"] });
    await fs.mkdir(path.join(pluginDir, "mcp.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.plugins[0].skillsDir).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("mcp.json");
  });

  test("skills location that is a file invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "file-skills", { mcpJson: "{}" });
    await fs.writeFile(path.join(pluginDir, "skills"), "not a dir", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
  });

  test("resolves hooks.js as a component path when present", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "hooky");
    await fs.writeFile(path.join(pluginDir, "hooks.js"), "({})", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBe(path.join(pluginDir, "hooks.js"));
    expect(result.diagnostics).toEqual([]);
  });

  test("hooks.js of the wrong filesystem kind invalidates only the hooks component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dir-hooks", { mcpJson: "{}" });
    await fs.mkdir(path.join(pluginDir, "hooks.js"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("hooks.js");
  });

  test("an oversized hooks.js invalidates only the hooks component", async () => {
    // The hook source is read and hashed every send and evaluated in the
    // main process: a repo pouring its checkout quota into hooks.js must not
    // gain a post-install stall primitive. The same discovery cap governs
    // the consent preview, so preview and runtime exclude identically.
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "big-hooks", { mcpJson: "{}" });
    await fs.writeFile(
      path.join(pluginDir, "hooks.js"),
      `// ${"x".repeat(2 * 1024 * 1024)}\n({})`,
      "utf8"
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("too large");
  });

  test("a symlinked plugin directory anchors containment at its realpath", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(container, { recursive: true });
    const actual = path.join(tmp.path, "elsewhere", "linked-plugin");
    await fs.mkdir(actual, { recursive: true });
    await fs.writeFile(
      path.join(actual, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "linked-plugin" }),
      "utf8"
    );
    await fs.symlink(actual, path.join(container, "linked-plugin"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].rootPath).toBe(await fs.realpath(actual));
    expect(result.diagnostics).toEqual([]);
  });

  test("canonical project plugins suppress same-named legacy copies", async () => {
    using tmp = new DisposableTempDir("agent-plugins-precedence");
    const canonical = path.join(tmp.path, ".xum", "plugins");
    const legacy = path.join(tmp.path, ".mux", "plugins");
    await writePlugin(canonical, "shared-plugin", { skills: ["canonical-skill"] });
    await writePlugin(legacy, "shared-plugin", { skills: ["legacy-skill"] });
    await writePlugin(legacy, "legacy-only");

    const result = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
    ]);

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["shared-plugin", "legacy-only"]);
    expect(result.plugins[0]?.containerPath).toBe(canonical);
  });

  test("missing containers yield no plugins and no diagnostics", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const result = await discoverAgentPlugins([
      { path: path.join(tmp.path, "does-not-exist"), scope: "global" },
    ]);
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("throws on relative container paths", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      discoverAgentPlugins([{ path: "relative/plugins", scope: "global" }])
    ).rejects.toThrow("must be absolute");
  });

  test("dedupes repeated container paths and orders plugins alphabetically per container", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "zeta");
    await writePlugin(container, "alpha");

    const result = await discoverAgentPlugins([
      { path: container, scope: "global" },
      { path: container, scope: "global" },
    ]);

    expect(result.plugins.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  test("discards a container's results when the gate's post-scan confirm flags it", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "transient-plugin");

    // A mutation that overlaps the scan is only visible AFTER the scan read
    // the container: pre-scan suppression stays empty and confirm flags it.
    setAgentPluginDiscoveryGate((containerPaths) =>
      Promise.resolve({
        suppressed: [],
        confirm: () => Promise.resolve(containerPaths),
      })
    );
    try {
      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);
      expect(result.plugins).toEqual([]);
      expect(result.diagnostics.some((d) => d.message.includes("overlapped this scan"))).toBe(true);
    } finally {
      setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
    }
  });
});

describe("journalDerivedDiscoveryGate", () => {
  test("suppresses a container whose staging root holds a journal at session creation", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, "promotion-demo.json"), "{}", "utf8");

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([container]);
  });

  test("suppresses a container while its mutation epoch is unreadable", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });
    // A directory at the epoch path is a deterministic non-ENOENT read
    // failure without relying on permission behavior of the test user.
    await fs.mkdir(path.join(stagingRoot, MUTATION_EPOCH_FILE));

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([container]);
    expect(await session.confirm()).toEqual([container]);
  });

  test("confirm flags a mutation whose whole journal lifetime fit inside the scan window", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([]);

    // Nothing changed: a quiet container stays accepted (also covers the
    // stable "epoch file never written" state on both reads).
    expect(await session.confirm()).toEqual([]);

    // Full transaction between the session's two reads: journal written,
    // container mutated, epoch bumped (the install service bumps BEFORE
    // deleting any journal), journal consumed. The journal file alone can no
    // longer betray the mutation — only the epoch can.
    const journalPath = path.join(stagingRoot, "promotion-demo.json");
    await fs.writeFile(journalPath, "{}", "utf8");
    await bumpContainerMutationEpoch(stagingRoot);
    await fs.rm(journalPath);
    expect(await session.confirm()).toEqual([container]);

    // A journal still in flight at confirm time is flagged as well.
    const session2 = await journalDerivedDiscoveryGate([container]);
    await fs.writeFile(journalPath, "{}", "utf8");
    expect(await session2.confirm()).toEqual([container]);
  });
});

describe("computeAgentPluginContainers", () => {
  test("includes project containers only for trusted projects with absolute roots", () => {
    const trusted = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "/repo",
      projectTrusted: true,
    });
    expect(trusted.filter((c) => c.scope === "project").map((c) => c.path)).toEqual([
      path.join("/repo", ".xum", "plugins"),
      path.join("/repo", ".mux", "plugins"),
      path.join("/repo", ".agents", "plugins"),
    ]);

    const untrusted = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "/repo",
      projectTrusted: false,
    });
    expect(untrusted.every((c) => c.scope === "global")).toBe(true);

    const relative = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "repo",
      projectTrusted: true,
    });
    expect(relative.every((c) => c.scope === "global")).toBe(true);
  });

  test("excludes project containers when project automation is disabled", () => {
    const previous = process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    process.env.MUX_DISABLE_PROJECT_AUTOMATION = "1";
    try {
      const containers = computeAgentPluginContainers({
        xumHome: "/home/u/.mux",
        projectRoot: "/repo",
        projectTrusted: true,
      });
      // Dataset-controlled plugin containers must be inert under the
      // benchmark kill-switch even when the project is trusted; global
      // containers stay active.
      expect(containers.length).toBeGreaterThan(0);
      expect(containers.every((c) => c.scope === "global")).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
      } else {
        process.env.MUX_DISABLE_PROJECT_AUTOMATION = previous;
      }
    }
  });

  test("always includes the xumHome global container", () => {
    const containers = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectTrusted: false,
    });
    expect(containers.some((c) => c.path === path.join("/home/u/.mux", "plugins"))).toBe(true);
  });
});
