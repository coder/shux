import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

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

  test.skipIf(process.platform !== "win32")(
    "coalesces Windows case aliases with managed imports",
    async () => {
      using tmp = new DisposableTempDir("plugin-discovery-windows-case");
      const xumHome = path.join(tmp.path, "MixedCase");
      const owner = path.join(xumHome, "plugins");
      await writePlugin(owner, "managed");
      const selection = { skills: ["allowed"], mcpServers: [] };
      const registryPath = path.join(xumHome, "plugins.json");
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const result = await discoverAgentPlugins([
        { path: owner.toUpperCase(), scope: "project" },
        { path: owner, scope: "global", registryPath },
      ]);
      expect(result.diagnostics).toEqual([]);
      expect(result.plugins.map((plugin) => plugin.scope)).toEqual(["project", "global"]);
      for (const plugin of result.plugins) {
        expect(plugin.importedComponents).toEqual(selection);
      }
    }
  );

  test.each([".xum", ".mux"])(
    "overlapping %s containers keep the first scope but read the later registry association once",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-discovery-overlap");
      const xumHome = path.join(home.path, metadataDir);
      const managed = path.join(xumHome, "plugins");
      const registryPath = path.join(xumHome, "plugins.json");
      await writePlugin(managed, "managed");
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const reads = spyOn(fs, "readFile");
      try {
        const { plugins } = await discoverAgentPlugins(
          computeAgentPluginContainers({ xumHome, projectRoot: home.path, projectTrusted: true })
        );
        const matches = plugins.filter((plugin) => plugin.containerPath === managed);
        expect(matches).toHaveLength(1);
        expect(matches[0].scope).toBe("project");
        expect(matches[0].importedComponents).toEqual(selection);
        expect(reads.mock.calls.filter(([file]) => file === registryPath)).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
    }
  );

  test.each([".xum", ".mux"])(
    "canonical %s container aliases retain selection and the first lexical identity",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-discovery-alias");
      const xumHome = path.join(home.path, "managed");
      const owner = path.join(xumHome, "plugins");
      const alias = path.join(home.path, metadataDir, "plugins");
      const registryPath = path.join(xumHome, "plugins.json");
      await writePlugin(owner, "managed");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const containers = [
        { path: alias, scope: "project" as const },
        { path: owner, scope: "global" as const, registryPath },
      ];
      const manifestPath = await fs.realpath(path.join(owner, "managed", "plugin.json"));
      const reads = spyOn(fs, "readFile");
      try {
        const { plugins } = await discoverAgentPlugins(containers);
        expect(plugins).toHaveLength(2);
        expect(plugins[0]).toMatchObject({
          scope: "project",
          containerPath: alias,
          rootPath: await fs.realpath(path.join(owner, "managed")),
          importedComponents: selection,
        });
        expect(plugins[1]).toMatchObject({
          scope: "global",
          containerPath: owner,
          importedComponents: selection,
        });
        expect(plugins[0].rootPath).toBe(plugins[1].rootPath);
        expect(reads.mock.calls.filter(([file]) => file === registryPath)).toHaveLength(1);
        expect(reads.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
      await fs.writeFile(registryPath, "{");
      const corrupt = await discoverAgentPlugins(containers);
      expect(corrupt.plugins).toHaveLength(2);
      expect(corrupt.plugins.map((plugin) => plugin.importedComponents)).toEqual([
        { skills: [], mcpServers: [] },
        { skills: [], mcpServers: [] },
      ]);

      const globalFirst = await discoverAgentPlugins([...containers].reverse());
      expect(globalFirst.plugins).toHaveLength(2);
      expect(globalFirst.plugins[0]).toMatchObject({ scope: "global", containerPath: owner });
    }
  );

  test.each(["initial", "post-scan"])(
    "canonical aliases share %s gate suppression",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-alias-gate");
      const owner = path.join(tmp.path, "managed", "plugins");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(owner, "transient-plugin");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      setAgentPluginDiscoveryGate(() =>
        Promise.resolve({
          suppressed: phase === "initial" ? [owner] : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? [owner] : []),
        })
      );
      try {
        const result = await discoverAgentPlugins([
          { path: alias, scope: "project" },
          {
            path: owner,
            scope: "global",
            registryPath: path.join(tmp.path, "managed", "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({ path: alias, scope: "project" });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "project-only alias consults its absent lexical registry owner for %s suppression",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-project-owner-gate");
      const physicalHome = path.join(tmp.path, "physical");
      const configuredHome = path.join(tmp.path, "configured");
      const owner = path.join(configuredHome, "plugins");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(path.join(physicalHome, "plugins"), "transient-plugin");
      await fs.symlink(physicalHome, configuredHome, "dir");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      setAgentPluginDiscoveryGate((paths) => {
        // Mirrors installService's lexical owner lookup: neither the project
        // alias nor the canonical path is sufficient to wait for recovery.
        const flagged = paths.filter((candidate) => candidate === owner);
        return Promise.resolve({
          suppressed: phase === "initial" ? flagged : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? flagged : []),
        });
      });
      try {
        const result = await discoverAgentPlugins([
          {
            path: alias,
            scope: "project",
            registryPath: path.join(configuredHome, "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({ path: alias, scope: "project" });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "pinned registry-owner journals suppress %s reads when both home and container are symlinks",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-owner-journal");
      const ownerHome = path.join(tmp.path, "owner");
      const configuredHome = path.join(tmp.path, "configured");
      const otherHome = path.join(tmp.path, "other");
      const physicalContainer = path.join(tmp.path, "storage", "plugins");
      await writePlugin(physicalContainer, "managed");
      await fs.mkdir(ownerHome);
      await fs.mkdir(otherHome);
      await fs.symlink(physicalContainer, path.join(ownerHome, "plugins"), "dir");
      await fs.symlink(ownerHome, configuredHome, "dir");
      const staging = path.join(ownerHome, STAGING_DIR_NAME);
      await fs.mkdir(staging);
      const journal = path.join(staging, "promotion-demo.json");
      if (phase === "initial") await fs.writeFile(journal, "{}");
      setAgentPluginDiscoveryGate(async (paths) => {
        // Neither the now-retargeted configured home nor the container's
        // physical parent owns the journal. The pinned owner path still does.
        await fs.unlink(configuredHome);
        await fs.symlink(otherHome, configuredHome, "dir");
        const session = await journalDerivedDiscoveryGate(paths);
        if (phase === "post-scan") await fs.writeFile(journal, "{}");
        return session;
      });
      try {
        const result = await discoverAgentPlugins([
          {
            path: path.join(configuredHome, "plugins"),
            scope: "global",
            registryPath: path.join(configuredHome, "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "%s suppression retains baseline legacy shadowing",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-gated-shadowing");
      const canonical = path.join(tmp.path, ".xum", "plugins");
      const legacy = path.join(tmp.path, ".mux", "plugins");
      await writePlugin(canonical, "shared");
      await writePlugin(legacy, "shared");
      setAgentPluginDiscoveryGate(() =>
        Promise.resolve({
          suppressed: phase === "initial" ? [canonical] : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? [canonical] : []),
        })
      );
      try {
        const result = await discoverAgentPlugins([
          { path: canonical, scope: "project" },
          { path: legacy, scope: "project" },
        ]);
        expect(result.plugins.map((plugin) => plugin.containerPath)).toEqual(
          phase === "initial" ? [legacy] : []
        );
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("a canonical target parent's unrelated journal cannot suppress the lexical owner", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-unrelated-journal");
    const ownerHome = path.join(tmp.path, "configured");
    const physicalContainer = path.join(tmp.path, "storage", "version-A");
    await writePlugin(physicalContainer, "managed");
    await fs.mkdir(ownerHome);
    await fs.symlink(physicalContainer, path.join(ownerHome, "plugins"), "dir");
    const unrelatedStaging = path.join(tmp.path, "storage", STAGING_DIR_NAME);
    await fs.mkdir(unrelatedStaging);
    await fs.writeFile(path.join(unrelatedStaging, "promotion-other.json"), "{}");
    const result = await discoverAgentPlugins([
      {
        path: path.join(ownerHome, "plugins"),
        scope: "global",
        registryPath: path.join(ownerHome, "plugins.json"),
      },
    ]);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["managed"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("ownership-only descriptors restrict scanned aliases without adding logical views", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-ownership-only");
    const home = path.join(tmp.path, "managed-home");
    const owner = path.join(home, "plugins");
    const alias = path.join(tmp.path, "project-alias");
    await writePlugin(owner, "managed");
    await fs.symlink(owner, alias, "dir");
    const selection = { skills: [], mcpServers: [] };
    const registryPath = path.join(home, "plugins.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
    );
    const options = { managedHome: home };
    const reads = spyOn(fs, "readdir");
    try {
      const empty = await discoverAgentPlugins([], options);
      expect(empty.plugins).toEqual([]);
      expect(reads.mock.calls.some(([input]) => input === owner)).toBe(false);
      const scanned = await discoverAgentPlugins([{ path: alias, scope: "project" }], options);
      expect(scanned.plugins).toHaveLength(1);
      expect(scanned.plugins.map((plugin) => [plugin.containerPath, plugin.scope])).toEqual([
        [alias, "project"],
      ]);
      expect(scanned.plugins[0].importedComponents).toEqual(selection);
    } finally {
      reads.mockRestore();
    }
  });

  test.each(["gate", "post-scan", "home-only"])(
    "fresh owner validation after %s retarget keeps pinned policies and rejects unowned aliases",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-fresh-owner");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      const homeC = path.join(tmp.path, "C");
      const configured = path.join(tmp.path, "configured");
      const aliasB = path.join(tmp.path, "new-alias");
      const denied = { skills: [], mcpServers: [] };
      const healthy = { skills: ["allowed"], mcpServers: [] };
      for (const [home, name, selection] of [
        [homeA, "managed", denied],
        [homeB, "unselected", denied],
        [homeC, "healthy", healthy],
      ] as const) {
        await writePlugin(path.join(home, "plugins"), name);
        await fs.writeFile(
          path.join(home, "plugins.json"),
          JSON.stringify({ plugins: [createTestPluginInstallEntry(name, selection)] })
        );
      }
      await fs.symlink(homeA, configured, "dir");
      await fs.symlink(path.join(homeB, "plugins"), aliasB, "dir");
      const owner = path.join(configured, "plugins");
      const retarget = async () => {
        if (phase === "home-only") {
          const sharedHome = path.join(tmp.path, "shared-home");
          await fs.mkdir(sharedHome);
          await fs.symlink(path.join(homeA, "plugins"), path.join(sharedHome, "plugins"), "dir");
          await fs.unlink(configured);
          await fs.symlink(sharedHome, configured, "dir");
        } else {
          await fs.unlink(configured);
          await fs.symlink(homeB, configured, "dir");
        }
      };
      setAgentPluginDiscoveryGate(async () => {
        if (phase !== "post-scan") await retarget();
        return {
          suppressed: [],
          confirm: async () => {
            if (phase === "post-scan") await retarget();
            return [];
          },
        };
      });
      try {
        const result = await discoverAgentPlugins(
          [
            { path: owner, scope: "project" },
            { path: aliasB, scope: "project" },
            {
              path: path.join(homeC, "plugins"),
              scope: "global",
              registryPath: path.join(homeC, "plugins.json"),
            },
          ],
          {
            managedHome: configured,
          }
        );
        expect(result.plugins.map((plugin) => plugin.name)).toEqual(["managed", "healthy"]);
        expect(result.plugins.map((plugin) => [plugin.name, plugin.scope])).toEqual([
          ["managed", "project"],
          ["healthy", "global"],
        ]);
        expect(result.plugins.map((plugin) => plugin.importedComponents)).toEqual([
          denied,
          healthy,
        ]);
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("losing the pinned registry home cannot turn its surviving target into import-all", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-lost-pinned-owner");
    const physical = path.join(tmp.path, "storage", "version-A");
    const home = path.join(tmp.path, "owner-home");
    const owner = path.join(home, "plugins");
    await writePlugin(physical, "managed");
    await fs.mkdir(home);
    await fs.symlink(physical, owner, "dir");
    const registryPath = path.join(home, "plugins.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        plugins: [createTestPluginInstallEntry("managed", { skills: [], mcpServers: [] })],
      })
    );
    setAgentPluginDiscoveryGate(async () => {
      await fs.rm(home, { recursive: true });
      return { suppressed: [], confirm: () => Promise.resolve([]) };
    });
    try {
      const result = await discoverAgentPlugins([{ path: physical, scope: "project" }], {
        managedHome: home,
      });
      expect(result.plugins).toEqual([]);
    } finally {
      setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
    }
  });

  test.each(["appeared", "removed", "unreadable"])(
    "an owner that %s during setup cannot release an unmarked candidate",
    async (change) => {
      using tmp = new DisposableTempDir("plugin-discovery-owner-availability");
      const configured = path.join(tmp.path, "configured");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      await fs.mkdir(homeA);
      await writePlugin(path.join(homeB, "plugins"), "managed");
      await fs.writeFile(
        path.join(homeB, "plugins.json"),
        JSON.stringify({
          plugins: [createTestPluginInstallEntry("managed", { skills: [], mcpServers: [] })],
        })
      );
      await fs.symlink(change === "appeared" ? homeA : homeB, configured, "dir");
      const unrelated = path.join(tmp.path, "unmarked", "plugins");
      await writePlugin(unrelated, "unmarked");
      const resolution = spyOn(fs, "realpath");
      setAgentPluginDiscoveryGate(async () => {
        if (change === "unreadable")
          resolution.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
        else {
          await fs.unlink(configured);
          if (change === "appeared") await fs.symlink(homeB, configured, "dir");
        }
        return { suppressed: [], confirm: () => Promise.resolve([]) };
      });
      try {
        const result = await discoverAgentPlugins(
          [
            { path: path.join(homeB, "plugins"), scope: "project" },
            { path: unrelated, scope: "project" },
          ],
          {
            managedHome: configured,
          }
        );
        if (change === "appeared") {
          expect(result.plugins).toEqual([]);
        } else {
          // The coherent pre-existing owner retains its pinned restrictive policy.
          expect(result.plugins.map((plugin) => plugin.importedComponents)).toEqual([
            { skills: [], mcpServers: [] },
          ]);
        }
      } finally {
        resolution.mockRestore();
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("an owner retarget cannot expose an unmarked target or suppress another known owner", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-duplicate-retarget");
    const homeA = path.join(tmp.path, "A");
    const homeB = path.join(tmp.path, "B");
    const homeC = path.join(tmp.path, "C");
    const configuredHome = path.join(tmp.path, "configured");
    await writePlugin(path.join(homeA, "plugins"), "managed");
    await writePlugin(path.join(homeB, "plugins"), "managed");
    await writePlugin(path.join(homeC, "plugins"), "healthy");
    const denied = { skills: [], mcpServers: [] };
    const healthy = { skills: ["allowed"], mcpServers: [] };
    for (const [home, entry] of [
      [homeB, createTestPluginInstallEntry("managed", denied)],
      [homeC, createTestPluginInstallEntry("healthy", healthy)],
    ] as const) {
      await fs.writeFile(path.join(home, "plugins.json"), JSON.stringify({ plugins: [entry] }));
    }
    await fs.symlink(homeA, configuredHome, "dir");
    const owner = path.join(configuredHome, "plugins");
    const discover = () =>
      discoverAgentPlugins([
        { path: owner, scope: "project" },
        { path: owner, scope: "global", registryPath: path.join(configuredHome, "plugins.json") },
        { path: path.join(homeB, "plugins"), scope: "project" },
        {
          path: path.join(homeC, "plugins"),
          scope: "global",
          registryPath: path.join(homeC, "plugins.json"),
        },
      ]);
    const resolve = fs.realpath;
    const resolution = spyOn(fs, "realpath").mockReturnValueOnce(
      (async () => {
        const canonical = await resolve(owner);
        await fs.unlink(configuredHome);
        await fs.symlink(homeB, configuredHome, "dir");
        return canonical;
      })()
    );
    try {
      const result = await discover();
      expect(result.plugins.map((plugin) => plugin.name)).toEqual(["healthy"]);
      expect(result.plugins[0].importedComponents).toEqual(healthy);
    } finally {
      resolution.mockRestore();
    }
    const stable = await discover();
    expect(stable.plugins.map((plugin) => plugin.name)).toEqual(["managed", "managed", "healthy"]);
    expect(stable.plugins[0].importedComponents).toEqual(denied);
    expect(stable.plugins.filter((plugin) => plugin.name === "managed")).toHaveLength(2);
    for (const plugin of stable.plugins) {
      expect(plugin.importedComponents).toEqual(plugin.name === "managed" ? denied : healthy);
    }
  });

  test("logical views retain original interleaved order while physical containers coalesce", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-registration-order");
    const projectA = path.join(tmp.path, "project-A");
    const projectB = path.join(tmp.path, "project-B");
    const globalA = path.join(tmp.path, "global-A");
    const globalB = path.join(tmp.path, "global-B");
    await writePlugin(projectA, "first");
    await writePlugin(projectB, "second");
    await fs.symlink(projectA, globalA, "dir");
    await fs.symlink(projectB, globalB, "dir");
    const result = await discoverAgentPlugins([
      { path: projectA, scope: "project" },
      { path: projectB, scope: "project" },
      { path: globalA, scope: "global" },
      { path: globalB, scope: "global" },
      { path: projectA, scope: "global" },
    ]);
    expect(result.plugins).toHaveLength(4);
    expect(result.plugins.map((plugin) => [plugin.containerPath, plugin.scope])).toEqual([
      [projectA, "project"],
      [projectB, "project"],
      [globalA, "global"],
      [globalB, "global"],
    ]);
  });

  test("shadowed legacy views do not hide their distinct global registration or leak diagnostics", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-shadowed-view");
    const canonical = path.join(tmp.path, ".xum", "plugins");
    const legacy = path.join(tmp.path, ".mux", "plugins");
    const global = path.join(tmp.path, "configured", "plugins");
    await writePlugin(canonical, "shared");
    await writePlugin(canonical, "invalid", { rawManifest: "{" });
    await writePlugin(legacy, "shared");
    await writePlugin(legacy, "invalid");
    await fs.mkdir(path.dirname(global));
    await fs.symlink(legacy, global, "dir");
    const result = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
      { path: global, scope: "global" },
    ]);
    expect(
      result.plugins.map((plugin) => [plugin.name, plugin.scope, plugin.containerPath])
    ).toEqual([
      ["shared", "project", canonical],
      ["invalid", "global", global],
      ["shared", "global", global],
    ]);
    expect(result.diagnostics).toHaveLength(1);
    await fs.writeFile(path.join(legacy, "shared", "plugin.json"), "{");
    const shadowed = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
    ]);
    expect(shadowed.diagnostics).toHaveLength(1);
  });

  test("unresolvable container identity fails closed without hiding other containers", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-identity-error");
    const inaccessible = path.join(tmp.path, "inaccessible");
    const healthy = path.join(tmp.path, "healthy");
    await writePlugin(inaccessible, "unsafe-fallback");
    await writePlugin(healthy, "healthy");
    const resolution = spyOn(fs, "realpath").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );
    try {
      const result = await discoverAgentPlugins([
        { path: inaccessible, scope: "project" },
        { path: healthy, scope: "project" },
      ]);
      expect(result.plugins.map((plugin) => plugin.name)).toEqual(["healthy"]);
      expect(
        result.diagnostics.some(
          (diagnostic) => diagnostic.path === inaccessible && diagnostic.severity === "error"
        )
      ).toBe(true);
    } finally {
      resolution.mockRestore();
    }
  });

  test.each(["project alias", "configured home"])(
    "container and registry reads stay pinned when the %s retargets after resolution",
    async (retarget) => {
      using tmp = new DisposableTempDir("plugin-discovery-pinned-alias");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      const configuredHome = path.join(tmp.path, "configured");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(path.join(homeA, "plugins"), "managed", { skills: ["allowed"] });
      await writePlugin(path.join(homeB, "plugins"), "managed", { skills: ["blocked"] });
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        path.join(homeA, "plugins.json"),
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      await fs.writeFile(
        path.join(homeB, "plugins.json"),
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed")] })
      );
      await fs.symlink(homeA, configuredHome, "dir");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(path.join(homeA, "plugins"), alias, "dir");
      const owner = {
        path: path.join(configuredHome, "plugins"),
        scope: "global" as const,
        registryPath: path.join(configuredHome, "plugins.json"),
      };
      setAgentPluginDiscoveryGate(async () => {
        const link = retarget === "project alias" ? alias : configuredHome;
        await fs.unlink(link);
        await fs.symlink(
          retarget === "project alias" ? path.join(homeB, "plugins") : homeB,
          link,
          "dir"
        );
        return { suppressed: [], confirm: () => Promise.resolve([]) };
      });
      try {
        const result = await discoverAgentPlugins(
          retarget === "project alias" ? [{ path: alias, scope: "project" }, owner] : [owner]
        );
        expect(result.plugins).toHaveLength(retarget === "project alias" ? 2 : 1);
        expect(result.plugins[0]).toMatchObject({
          rootPath: await fs.realpath(path.join(homeA, "plugins", "managed")),
          importedComponents: selection,
          containerPath: retarget === "project alias" ? alias : owner.path,
        });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("a failed marked owner cannot leave an earlier readable alias unmanaged", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-owner-error");
    const owner = path.join(tmp.path, "managed", "plugins");
    const alias = path.join(tmp.path, "alias");
    await writePlugin(owner, "managed");
    await fs.symlink(owner, alias, "dir");
    const identity = await fs.realpath(alias);
    const resolution = spyOn(fs, "realpath")
      .mockResolvedValueOnce(identity)
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      const result = await discoverAgentPlugins([
        { path: alias, scope: "project" },
        {
          path: owner,
          scope: "global",
          registryPath: path.join(tmp.path, "managed", "plugins.json"),
        },
      ]);
      expect(result.plugins).toEqual([]);
      expect(result.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
    } finally {
      resolution.mockRestore();
    }
  });

  test("a registry parent resolving to a different container cannot grant imports", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-owner-binding");
    const container = path.join(tmp.path, "A", "plugins");
    await writePlugin(container, "managed");
    await writePlugin(path.join(tmp.path, "B", "plugins"), "managed");
    const result = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath: path.join(tmp.path, "B", "plugins.json") },
    ]);
    expect(result.plugins).toEqual([]);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.path === container && diagnostic.severity === "error"
      )
    ).toBe(true);
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
