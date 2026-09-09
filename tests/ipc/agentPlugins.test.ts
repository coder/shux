import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Result } from "@/common/types/result";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/manifest";
import { AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/mcpConfig";
import { execFileAsync } from "@/node/utils/disposableExec";
import { shouldRunIntegrationTests } from "../testUtils";
import { cleanupTempGitRepo, createTempGitRepo } from "./helpers";
import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "./setup";

function unwrap<T>(result: Result<T, string>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

// Exercise the public boundary with a real local Git remote, without providers or MCP launches.
(shouldRunIntegrationTests() ? describe : describe.skip)("selective agent plugin imports", () => {
  let env: TestEnvironment;
  let remote: string;

  async function commitComponents(names: string[]): Promise<void> {
    await fs.writeFile(
      path.join(remote, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "selective-ipc" })
    );
    for (const name of names) {
      const directory = path.join(remote, "skills", name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Local integration fixture\n---\nUse the ${name} skill.\n`
      );
    }
    await fs.writeFile(
      path.join(remote, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
        mcpServers: Object.fromEntries(
          names.map((name) => [name, { type: "stdio", command: "node", args: ["server.js"] }])
        ),
      })
    );
    using add = execFileAsync("git", ["-C", remote, "add", "."]);
    await add.result;
    using commit = execFileAsync("git", ["-C", remote, "commit", "-m", "Update fixture inventory"]);
    await commit.result;
  }

  beforeAll(async () => {
    env = await createTestEnvironment();
    remote = await createTempGitRepo();
    await env.orpc.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.AGENT_PLUGINS,
      enabled: true,
    });
    await commitComponents(["selective-first", "selective-second"]);
  });

  afterAll(async () => {
    if (env) await cleanupTestEnvironment(env);
    if (remote) await cleanupTempGitRepo(remote);
  });

  it("imports a subset, adds offline, and requires new consent after an update", async () => {
    const preview = unwrap(
      await env.orpc.agentPlugins.preview({ input: pathToFileURL(remote).href })
    );
    const selection = { skills: ["selective-first"], mcpServers: ["selective-first"] };
    const invalid = await env.orpc.agentPlugins.install({
      source: preview.source,
      expectedSha: preview.lockedSha,
      importedComponents: { ...selection, skills: ["unknown"] },
    });
    expect(invalid.success).toBe(false);
    expect(
      unwrap(await env.orpc.agentPlugins.list()).some((plugin) => plugin.name === "selective-ipc")
    ).toBe(false);

    const installed = unwrap(
      await env.orpc.agentPlugins.install({
        source: preview.source,
        expectedSha: preview.lockedSha,
        importedComponents: selection,
      })
    );
    expect(installed.importedComponents).toEqual(selection);
    const name = installed.name;
    const inventory = unwrap(await env.orpc.agentPlugins.getComponents({ name }));
    expect(inventory.skills.map((skill) => skill.name).sort()).toEqual([
      "selective-first",
      "selective-second",
    ]);
    expect(inventory.importedComponents).toEqual(selection);

    const skills = await env.orpc.agentSkills.list({ projectPath: remote });
    expect(skills.some((skill) => skill.name === "selective-first")).toBe(true);
    expect(skills.some((skill) => skill.name === "selective-second")).toBe(false);
    await expect(
      env.orpc.agentSkills.get({ projectPath: remote, skillName: "selective-second" })
    ).rejects.toThrow();
    const serversBefore = await env.orpc.projects.mcp.list({ projectPath: remote });
    const pluginServers = Object.values(serversBefore).filter((server) => server.plugin);
    expect(pluginServers.map((server) => server.plugin?.serverName)).toEqual(["selective-first"]);
    expect(pluginServers[0].disabled).toBe(true);

    expect(
      (
        await env.orpc.agentPlugins.addComponents({
          name,
          expectedLockedSha: "outdated",
          skills: ["selective-second"],
          mcpServers: ["selective-second"],
        })
      ).success
    ).toBe(false);
    expect(unwrap(await env.orpc.agentPlugins.getComponents({ name })).importedComponents).toEqual(
      selection
    );

    // No remote is available: additions must use the installed tree, not clone or fetch.
    const offlineRemote = `${remote}-offline`;
    await fs.rename(remote, offlineRemote);
    try {
      const addition = {
        name,
        expectedLockedSha: inventory.lockedSha,
        skills: ["selective-second", "selective-second"],
        mcpServers: ["selective-second"],
      };
      const added = unwrap(await env.orpc.agentPlugins.addComponents(addition));
      expect(added.importedComponents?.skills.sort()).toEqual([
        "selective-first",
        "selective-second",
      ]);
      expect(unwrap(await env.orpc.agentPlugins.addComponents(addition))).toEqual(added);
    } finally {
      await fs.rename(offlineRemote, remote);
    }
    const serversAfter = await env.orpc.projects.mcp.list({ projectPath: remote });
    for (const [key, server] of Object.entries(serversBefore)) {
      expect(serversAfter[key]).toEqual(server);
    }
    expect(Object.values(serversAfter).filter((server) => server.plugin)).toHaveLength(2);
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).some(
        (skill) => skill.name === "selective-second"
      )
    ).toBe(true);

    await commitComponents(["selective-first", "selective-second", "selective-third"]);
    const review = unwrap(await env.orpc.agentPlugins.previewUpdate({ name }));
    expect(review.changes.length).toBeGreaterThan(0);
    expect((await env.orpc.agentPlugins.update({ name })).success).toBe(false);
    const updated = unwrap(
      await env.orpc.agentPlugins.update({
        name,
        consent: { fromSha: review.fromSha, toSha: review.toSha },
      })
    );
    expect(updated.importedComponents?.skills).not.toContain("selective-third");
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).some(
        (skill) => skill.name === "selective-third"
      )
    ).toBe(false);
    expect(
      (
        await env.orpc.agentPlugins.addComponents({
          name,
          expectedLockedSha: inventory.lockedSha,
          skills: ["selective-third"],
          mcpServers: [],
        })
      ).success
    ).toBe(false);
    unwrap(
      await env.orpc.agentPlugins.addComponents({
        name,
        expectedLockedSha: updated.lockedSha,
        skills: ["selective-third"],
        mcpServers: [],
      })
    );
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).some(
        (skill) => skill.name === "selective-third"
      )
    ).toBe(true);
    expect(
      Object.values(await env.orpc.projects.mcp.list({ projectPath: remote })).some(
        (server) => server.plugin?.serverName === "selective-third"
      )
    ).toBe(false);
  }, 60_000);
});
