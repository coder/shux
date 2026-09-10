import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";

import { describe, expect, it, spyOn } from "bun:test";

import { createTestPluginInstallEntry } from "@/node/services/agentPlugins/testFixtures";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { XumToolScope } from "@/common/types/toolScope";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { createAgentSkillListTool } from "./agent_skill_list";
import { MAX_FILE_SIZE } from "./fileCommon";
import {
  createTestToolConfig,
  createWorkspaceSessionDir,
  mockToolCallOptions,
  RemotePathMappedRuntime,
  TEST_GLOBAL_WORKSPACE_ID as GLOBAL_WORKSPACE_ID,
  TestTempDir,
  TrueRemotePathMappedRuntime,
  withMuxRoot,
  writeGlobalSkill,
  writeSkill,
} from "./testHelpers";

async function withHomeDir(homeDir: string, callback: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const homedirSpy = spyOn(os, "homedir");

  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    await callback();
  } finally {
    homedirSpy.mockRestore();

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

function getSkill(skills: AgentSkillDescriptor[], name: string): AgentSkillDescriptor {
  const skill = skills.find((candidate) => candidate.name === name);
  expect(skill).toBeDefined();
  return skill!;
}

/** Agent Plugins fixture: a container entry with a plugin.json manifest and skills. */
async function writePlugin(
  containerPath: string,
  pluginName: string,
  skills: Array<{ name: string; description: string }>
): Promise<void> {
  const pluginDir = path.join(containerPath, pluginName);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginName,
    }),
    "utf-8"
  );
  for (const skill of skills) {
    await writeSkill(path.join(pluginDir, "skills"), skill.name, {
      description: skill.description,
    });
  }
}

describe("agent_skill_list", () => {
  it("lists effective available skills across project and global scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-project");
    using xumHome = new TestTempDir("test-agent-skill-list-mux-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "project-only", {
        description: "from project",
      });
      await writeSkill(path.join(xumHome.path, "skills"), "global-only", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-only")).toMatchObject({
        name: "project-only",
        description: "from project",
        scope: "project",
      });
      expect(getSkill(result.skills, "global-only")).toMatchObject({
        name: "global-only",
        description: "from global",
        scope: "global",
      });
      // Built-in skills are not included in the listing (only project + global)
    });
  });

  it("lists skills from all four local roots in project workspaces", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-local-roots-home");
    using project = new TestTempDir("test-agent-skill-list-local-roots-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-local-roots-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writeSkill(path.join(project.path, ".mux", "skills"), "project-only", {
          description: "from project mux root",
        });
        await writeSkill(path.join(project.path, ".agents", "skills"), "project-universal", {
          description: "from project universal root",
        });
        await writeGlobalSkill(xumHomeDir.path, "global-only", {
          description: "from global mux root",
        });
        await writeSkill(path.join(homeDir.path, ".agents", "skills"), "global-universal", {
          description: "from global universal root",
        });

        const tool = createAgentSkillListTool(
          createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          })
        );
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "project-only")).toMatchObject({
          name: "project-only",
          description: "from project mux root",
          scope: "project",
        });
        expect(getSkill(result.skills, "project-universal")).toMatchObject({
          name: "project-universal",
          description: "from project universal root",
          scope: "project",
        });
        expect(getSkill(result.skills, "global-only")).toMatchObject({
          name: "global-only",
          description: "from global mux root",
          scope: "global",
        });
        expect(getSkill(result.skills, "global-universal")).toMatchObject({
          name: "global-universal",
          description: "from global universal root",
          scope: "global",
        });
      });
    });
  });

  it("lists skills inherited from parent directories of a subproject", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-subproject-home");
    using checkout = new TestTempDir("test-agent-skill-list-subproject-checkout");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-subproject-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        const packagesRoot = path.join(checkout.path, "packages");
        const subprojectRoot = path.join(packagesRoot, "app");
        await fs.mkdir(subprojectRoot, { recursive: true });
        await writeSkill(path.join(checkout.path, ".mux", "skills"), "parent-only", {
          description: "from checkout",
        });
        await writeSkill(path.join(checkout.path, ".mux", "skills"), "shared", {
          description: "from checkout",
        });
        await writeSkill(path.join(packagesRoot, ".agents", "skills"), "shared", {
          description: "from packages",
        });

        const tool = createAgentSkillListTool(
          createTestToolConfig(subprojectRoot, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: subprojectRoot,
              projectStorageAuthority: "host-local",
              checkoutRoot: checkout.path,
            },
          })
        );
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "parent-only")).toMatchObject({
          description: "from checkout",
          scope: "project",
        });
        const sharedSkills = result.skills.filter((skill) => skill.name === "shared");
        expect(sharedSkills).toHaveLength(1);
        expect(sharedSkills[0]).toMatchObject({
          description: "from packages",
          scope: "project",
        });
      });
    });
  });

  it("hides .claude/skills roots when the claude-skills-compat experiment is off", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-claude-off-home");
    using project = new TestTempDir("test-agent-skill-list-claude-off-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-claude-off-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writeSkill(path.join(project.path, ".claude", "skills"), "claude-project", {
          description: "from project claude root",
        });
        await writeSkill(path.join(homeDir.path, ".claude", "skills"), "claude-global", {
          description: "from global claude root",
        });

        // Default tool config: no experiments => compat roots must stay invisible.
        const tool = createAgentSkillListTool(
          createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          })
        );
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(result.skills.find((skill) => skill.name === "claude-project")).toBeUndefined();
        expect(result.skills.find((skill) => skill.name === "claude-global")).toBeUndefined();
      });
    });
  });

  it("lists .claude/skills roots when the claude-skills-compat experiment is on", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-claude-on-home");
    using project = new TestTempDir("test-agent-skill-list-claude-on-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-claude-on-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writeSkill(path.join(project.path, ".claude", "skills"), "claude-project", {
          description: "from project claude root",
        });
        await writeSkill(path.join(homeDir.path, ".claude", "skills"), "claude-global", {
          description: "from global claude root",
        });

        const tool = createAgentSkillListTool({
          ...createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          }),
          experiments: { claudeSkillsCompat: true },
        });
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "claude-project")).toMatchObject({
          name: "claude-project",
          description: "from project claude root",
          scope: "project",
        });
        expect(getSkill(result.skills, "claude-global")).toMatchObject({
          name: "claude-global",
          description: "from global claude root",
          scope: "global",
        });
      });
    });
  });

  it("hides Agent Plugins skills when the agent-plugins experiment is off", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-plugins-off-home");
    using project = new TestTempDir("test-agent-skill-list-plugins-off-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-plugins-off-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writePlugin(path.join(project.path, ".mux", "plugins"), "project-plugin", [
          { name: "plugin-project", description: "from project plugin" },
        ]);
        await writePlugin(path.join(xumHomeDir.path, "plugins"), "global-plugin", [
          { name: "plugin-global", description: "from global plugin" },
        ]);

        // Default tool config: no experiments => plugin roots must stay invisible.
        const tool = createAgentSkillListTool(
          createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          })
        );
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(result.skills.find((skill) => skill.name === "plugin-project")).toBeUndefined();
        expect(result.skills.find((skill) => skill.name === "plugin-global")).toBeUndefined();
      });
    });
  });

  it("lists Agent Plugins skills when the agent-plugins experiment is on", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-plugins-on-home");
    using project = new TestTempDir("test-agent-skill-list-plugins-on-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-plugins-on-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writePlugin(path.join(project.path, ".mux", "plugins"), "project-plugin", [
          { name: "plugin-project", description: "from project plugin" },
        ]);
        await writePlugin(path.join(xumHomeDir.path, "plugins"), "global-plugin", [
          { name: "plugin-global", description: "from global plugin" },
        ]);
        // Sibling non-plugin entry (e.g. Codex marketplace metadata) must not break listing.
        await fs.mkdir(path.join(homeDir.path, ".agents", "plugins"), { recursive: true });
        await fs.writeFile(
          path.join(homeDir.path, ".agents", "plugins", "marketplace.json"),
          "{}",
          "utf-8"
        );

        const tool = createAgentSkillListTool({
          ...createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          }),
          experiments: { agentPlugins: true },
        });
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "plugin-project")).toMatchObject({
          name: "plugin-project",
          description: "from project plugin",
          scope: "project",
        });
        expect(getSkill(result.skills, "plugin-global")).toMatchObject({
          name: "plugin-global",
          description: "from global plugin",
          scope: "global",
        });
      });
    });
  });

  it("lists only imported plugin skills and refreshes additions without hiding fallback sources", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-imports-home");
    using project = new TestTempDir("test-agent-skill-list-imports-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-imports-xum-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        const container = path.join(xumHomeDir.path, "plugins");
        await writePlugin(container, "a-managed", [
          { name: "selected", description: "selected plugin skill" },
          { name: "skipped", description: "managed skill" },
          { name: "hidden", description: "not imported" },
        ]);
        await writePlugin(container, "z-unmanaged", [
          { name: "skipped", description: "fallback skill" },
        ]);
        const saveSelection = (skills: string[] | null) =>
          fs.writeFile(
            path.join(xumHomeDir.path, "plugins.json"),
            JSON.stringify({
              plugins: [
                {
                  ...createTestPluginInstallEntry("a-managed"),
                  importedComponents: { skills, mcpServers: [] },
                },
              ],
            })
          );
        await saveSelection(["selected"]);
        const tool = createAgentSkillListTool({
          ...createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          }),
          experiments: { agentPlugins: true },
        });
        const list = async () => {
          const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;
          if (!result.success) throw new Error(result.error);
          return result.skills;
        };
        const initial = await list();
        expect(initial.some((skill) => skill.name === "selected")).toBe(true);
        expect(initial.some((skill) => skill.name === "hidden")).toBe(false);
        expect(getSkill(initial, "skipped").description).toBe("fallback skill");

        await saveSelection(["selected", "skipped"]);
        expect(getSkill(await list(), "skipped").description).toBe("managed skill");
        // Malformed selection is not a legacy import-all entry.
        await saveSelection(null);
        const invalid = await list();
        expect(invalid.some((skill) => skill.name === "selected")).toBe(false);
        expect(getSkill(invalid, "skipped").description).toBe("fallback skill");
      });
    });
  });

  it.each([
    [".xum", false],
    [".mux", false],
    [".xum", true],
    [".mux", true],
  ] as const)(
    "combined tool-list containers retain managed imports when the project overlaps %s (aliased home: %s)",
    async (metadataDir, aliasHome) => {
      using home = new TestTempDir("plugin-tool-list-overlap");
      const physicalHome = path.join(home.path, metadataDir);
      const xumHome = aliasHome ? path.join(home.path, "configured-home") : physicalHome;
      await fs.mkdir(physicalHome, { recursive: true });
      if (aliasHome) await fs.symlink(physicalHome, xumHome, "dir");
      await withHomeDir(home.path, async () => {
        await withMuxRoot(xumHome, async () => {
          await writePlugin(path.join(xumHome, "plugins"), "managed", [
            { name: "allowed", description: "imported" },
            { name: "blocked", description: "not imported" },
          ]);
          await writePlugin(path.join(home.path, ".agents", "plugins"), "project-only", [
            { name: "unmanaged", description: "unmanaged project" },
          ]);
          const registryPath = path.join(xumHome, "plugins.json");
          await fs.writeFile(
            registryPath,
            JSON.stringify({
              plugins: [
                createTestPluginInstallEntry("managed", { skills: ["allowed"], mcpServers: [] }),
              ],
            })
          );
          const tool = createAgentSkillListTool({
            ...createTestToolConfig(home.path, {
              xumScope: {
                type: "project",
                xumHome,
                projectRoot: home.path,
                projectStorageAuthority: "host-local",
              },
            }),
            experiments: { agentPlugins: true },
          });
          const list = async () => {
            const result = (await tool.execute!(
              {},
              mockToolCallOptions
            )) as AgentSkillListToolResult;
            if (!result.success) throw new Error(result.error);
            return result.skills;
          };
          const initial = await list();
          expect(getSkill(initial, "allowed").scope).toBe("project");
          expect(initial.some((skill) => skill.name === "blocked")).toBe(false);
          expect(initial.some((skill) => skill.name === "unmanaged")).toBe(true);
          await fs.writeFile(registryPath, "{");
          const corrupted = await list();
          expect(corrupted.some((skill) => ["allowed", "blocked"].includes(skill.name))).toBe(
            false
          );
          expect(corrupted.some((skill) => skill.name === "unmanaged")).toBe(true);
        });
      });
    }
  );

  it("lists checkout-level plugin skills when the workspace executes in a subproject", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-plugins-subproject-home");
    using checkout = new TestTempDir("test-agent-skill-list-plugins-subproject-checkout");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-plugins-subproject-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        // subProjectPath workspaces execute in a subdirectory of the checkout;
        // plugin containers live at the checkout level.
        const subprojectRoot = path.join(checkout.path, "packages", "app");
        await fs.mkdir(subprojectRoot, { recursive: true });
        await writePlugin(path.join(checkout.path, ".mux", "plugins"), "checkout-plugin", [
          { name: "plugin-checkout", description: "from checkout plugin" },
        ]);

        const tool = createAgentSkillListTool({
          ...createTestToolConfig(subprojectRoot, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: subprojectRoot,
              projectStorageAuthority: "host-local",
              checkoutRoot: checkout.path,
            },
          }),
          experiments: { agentPlugins: true },
        });
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "plugin-checkout")).toMatchObject({
          name: "plugin-checkout",
          description: "from checkout plugin",
          scope: "project",
        });
      });
    });
  });

  it("lists plugin skills behind symlinks contained in the plugin root, rejects escaping ones", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-plugins-symlink-home");
    using project = new TestTempDir("test-agent-skill-list-plugins-symlink-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-plugins-symlink-mux-home");

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writePlugin(path.join(project.path, ".mux", "plugins"), "sym-plugin", []);
        const pluginDir = path.join(project.path, ".mux", "plugins", "sym-plugin");
        await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });

        // Contained symlink: skills/<name> -> ../real-skill (inside the plugin root).
        await writeSkill(path.join(pluginDir, "real-skills"), "linked-skill", {
          description: "behind a contained symlink",
        });
        await fs.symlink(
          path.join(pluginDir, "real-skills", "linked-skill"),
          path.join(pluginDir, "skills", "linked-skill")
        );

        // Escaping symlink: resolves outside the plugin root; must stay hidden.
        await writeSkill(path.join(project.path, "outside-skills"), "escaping-skill", {
          description: "outside the plugin root",
        });
        await fs.symlink(
          path.join(project.path, "outside-skills", "escaping-skill"),
          path.join(pluginDir, "skills", "escaping-skill")
        );

        const tool = createAgentSkillListTool({
          ...createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          }),
          experiments: { agentPlugins: true },
        });
        const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(getSkill(result.skills, "linked-skill")).toMatchObject({
          name: "linked-skill",
          description: "behind a contained symlink",
          scope: "project",
        });
        expect(result.skills.find((skill) => skill.name === "escaping-skill")).toBeUndefined();
      });
    });
  });

  it("returns only the winning descriptor when project skills shadow global skills", async () => {
    using project = new TestTempDir("test-agent-skill-list-shadow-project");
    using xumHome = new TestTempDir("test-agent-skill-list-shadow-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-skill", {
        description: "from project",
      });
      await writeSkill(path.join(xumHome.path, "skills"), "shared-skill", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      const sharedSkills = result.skills.filter((skill) => skill.name === "shared-skill");
      // Local listing preserves both scoped entries — project and global both appear
      expect(sharedSkills.length).toBe(2);
      expect(sharedSkills.find((s) => s.scope === "project")).toMatchObject({
        name: "shared-skill",
        description: "from project",
        scope: "project",
      });
      expect(sharedSkills.find((s) => s.scope === "global")).toMatchObject({
        name: "shared-skill",
        description: "from global",
        scope: "global",
      });
    });
  });

  it("filters unadvertised skills by default across scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-hidden-project");
    using xumHome = new TestTempDir("test-agent-skill-list-hidden-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "visible-project");
      await writeSkill(path.join(project.path, ".agents", "skills"), "hidden-project", {
        advertise: false,
      });
      await writeSkill(path.join(xumHome.path, "skills"), "hidden-global", {
        advertise: false,
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.skills.some((skill) => skill.name === "visible-project")).toBe(true);
      expect(result.skills.some((skill) => skill.name === "hidden-project")).toBe(false);
      expect(result.skills.some((skill) => skill.name === "hidden-global")).toBe(false);
    });
  });

  it("treats disable-model-invocation: true like advertise: false (either opt-out hides)", async () => {
    using project = new TestTempDir("test-agent-skill-list-dmi-project");
    using xumHome = new TestTempDir("test-agent-skill-list-dmi-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "user-only", {
        disableModelInvocation: true,
      });
      // Precedence: the more restrictive opt-out wins over advertise: true.
      await writeSkill(path.join(project.path, ".mux", "skills"), "conflicting-flags", {
        advertise: true,
        disableModelInvocation: true,
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "model-visible", {
        disableModelInvocation: false,
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );

      const defaultResult = (await tool.execute!(
        {},
        mockToolCallOptions
      )) as AgentSkillListToolResult;
      expect(defaultResult.success).toBe(true);
      if (!defaultResult.success) {
        return;
      }
      expect(defaultResult.skills.some((skill) => skill.name === "user-only")).toBe(false);
      expect(defaultResult.skills.some((skill) => skill.name === "conflicting-flags")).toBe(false);
      expect(defaultResult.skills.some((skill) => skill.name === "model-visible")).toBe(true);

      const unfilteredResult = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;
      expect(unfilteredResult.success).toBe(true);
      if (!unfilteredResult.success) {
        return;
      }
      // Normalized descriptors report advertise: false so downstream consumers
      // (skill index, ACP slash advertisement) need no knowledge of the alias.
      expect(getSkill(unfilteredResult.skills, "user-only").advertise).toBe(false);
      expect(getSkill(unfilteredResult.skills, "conflicting-flags").advertise).toBe(false);
    });
  });

  it("normalizes user-invocable, argument-hint, and when_to_use into descriptors", async () => {
    using project = new TestTempDir("test-agent-skill-list-normalized-project");
    using xumHome = new TestTempDir("test-agent-skill-list-normalized-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "model-only", {
        userInvocable: false,
        argumentHint: "[issue-number]",
        whenToUse: "Use when triaging issues",
      });
      // Both spellings present: underscore spelling wins.
      await writeSkill(path.join(project.path, ".mux", "skills"), "both-spellings", {
        whenToUse: "underscore guidance",
        whenToUseKebab: "kebab guidance",
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "kebab-only", {
        whenToUseKebab: "kebab guidance",
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "plain");

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      // user-invocable does not affect model-facing listing.
      const modelOnly = getSkill(result.skills, "model-only");
      expect(modelOnly.userInvocable).toBe(false);
      expect(modelOnly.argumentHint).toBe("[issue-number]");
      expect(modelOnly.whenToUse).toBe("Use when triaging issues");

      expect(getSkill(result.skills, "both-spellings").whenToUse).toBe("underscore guidance");
      expect(getSkill(result.skills, "kebab-only").whenToUse).toBe("kebab guidance");

      const plain = getSkill(result.skills, "plain");
      expect(plain.userInvocable).toBeUndefined();
      expect(plain.argumentHint).toBeUndefined();
      expect(plain.whenToUse).toBeUndefined();
    });
  });

  it("filters hidden skills from local legacy .agents/skills roots unless includeUnadvertised is true", async () => {
    using homeDir = new TestTempDir("test-agent-skill-list-local-hidden-legacy-home");
    using project = new TestTempDir("test-agent-skill-list-local-hidden-legacy-project");
    using xumHomeDir = new TestTempDir("test-agent-skill-list-local-hidden-legacy-mux-home");
    const hiddenProjectSkill = "hidden-project-universal";
    const hiddenGlobalSkill = "hidden-global-universal";

    await withHomeDir(homeDir.path, async () => {
      await withMuxRoot(xumHomeDir.path, async () => {
        await writeSkill(path.join(project.path, ".agents", "skills"), hiddenProjectSkill, {
          advertise: false,
        });
        await writeSkill(path.join(homeDir.path, ".agents", "skills"), hiddenGlobalSkill, {
          advertise: false,
        });

        const tool = createAgentSkillListTool(
          createTestToolConfig(project.path, {
            xumScope: {
              type: "project",
              xumHome: xumHomeDir.path,
              projectRoot: project.path,
              projectStorageAuthority: "host-local",
            },
          })
        );

        const defaultResult = (await tool.execute!(
          {},
          mockToolCallOptions
        )) as AgentSkillListToolResult;
        expect(defaultResult.success).toBe(true);
        if (defaultResult.success) {
          expect(defaultResult.skills.some((skill) => skill.name === hiddenProjectSkill)).toBe(
            false
          );
          expect(defaultResult.skills.some((skill) => skill.name === hiddenGlobalSkill)).toBe(
            false
          );
        }

        const includeAllResult = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;
        expect(includeAllResult.success).toBe(true);
        if (!includeAllResult.success) {
          return;
        }

        expect(getSkill(includeAllResult.skills, hiddenProjectSkill)).toMatchObject({
          name: hiddenProjectSkill,
          scope: "project",
          advertise: false,
        });
        expect(getSkill(includeAllResult.skills, hiddenGlobalSkill)).toMatchObject({
          name: hiddenGlobalSkill,
          scope: "global",
          advertise: false,
        });
      });
    });
  });

  it("includes unadvertised winning descriptors when includeUnadvertised is true", async () => {
    using project = new TestTempDir("test-agent-skill-list-include-hidden-project");
    using xumHome = new TestTempDir("test-agent-skill-list-include-hidden-home");

    await withMuxRoot(xumHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "project-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(xumHome.path, "skills"), "global-hidden", {
        description: "hidden global winner",
        advertise: false,
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(xumHome.path, "skills"), "shared-hidden", {
        description: "hidden global loser",
        advertise: false,
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-hidden")).toMatchObject({
        name: "project-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
      expect(getSkill(result.skills, "global-hidden")).toMatchObject({
        name: "global-hidden",
        description: "hidden global winner",
        scope: "global",
        advertise: false,
      });
      // Local listing preserves both scoped entries for same-name skills
      const sharedHidden = result.skills.filter((s) => s.name === "shared-hidden");
      expect(sharedHidden.length).toBe(2);
      expect(sharedHidden.find((s) => s.scope === "project")).toMatchObject({
        name: "shared-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
    });
  });

  it("returns a clear error when cwd is missing", async () => {
    using project = new TestTempDir("test-agent-skill-list-misconfigured");

    const config = {
      ...createTestToolConfig(project.path),
      cwd: "",
    };

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result).toEqual({
      success: false,
      error: "Tool misconfigured: cwd is required.",
    });
  });

  it("operates on global skills root when scope is global", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-global");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      await writeGlobalSkill(tempDir.path, "alpha-skill");
      await writeGlobalSkill(tempDir.path, "zeta-skill");

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: {
          type: "global",
          xumHome: tempDir.path,
        },
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills.map((skill) => skill.name)).toEqual(["alpha-skill", "zeta-skill"]);
        expect(result.skills.every((skill) => skill.scope === "global")).toBe(true);
      }
    });
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "my-project");
      await fs.mkdir(path.join(projectRoot, ".mux", "skills"), { recursive: true });

      await writeGlobalSkill(tempDir.path, "global-skill");
      await writeGlobalSkill(path.join(projectRoot, ".mux"), "project-skill");

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        // Project scope lists both project and global skills, each tagged with scope
        expect(result.skills.map((skill) => skill.name)).toEqual(["global-skill", "project-skill"]);
        expect(result.skills.find((s) => s.name === "project-skill")?.scope).toBe("project");
        expect(result.skills.find((s) => s.name === "global-skill")?.scope).toBe("global");
      }
    });
  });
  describe("split-root (project-runtime)", () => {
    it("routes through project-runtime when runtime is non-local", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-project-runtime");
      const skillName = "split-root-routing-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeGlobalSkill(path.join(tempDir.path, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const config = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: tempDir.path,
          projectStorageAuthority: "runtime",
        },
      });

      const tool = createAgentSkillListTool({
        ...config,
        cwd: remoteWorkspaceRoot,
      });

      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      expect(remoteRuntime.resolvePathCallCount).toBeGreaterThan(0);

      if (result.success) {
        expect(Array.isArray(result.skills)).toBe(true);
      }
    });

    it("dedupes inherited project skills to the nearest runtime definition", async () => {
      using checkout = new TestTempDir("test-agent-skill-list-runtime-subproject-checkout");
      using xumHome = new TestTempDir("test-agent-skill-list-runtime-subproject-mux-home");
      const packagesRoot = path.join(checkout.path, "packages");
      const subprojectRoot = path.join(packagesRoot, "app");
      const remoteCheckoutRoot = "/remote/workspace";
      const remoteSubprojectRoot = "/remote/workspace/packages/app";
      await fs.mkdir(subprojectRoot, { recursive: true });
      await writeSkill(path.join(checkout.path, ".mux", "skills"), "shared", {
        description: "from checkout",
      });
      await writeSkill(path.join(packagesRoot, ".agents", "skills"), "shared", {
        description: "from packages",
      });

      const runtime = new TrueRemotePathMappedRuntime(checkout.path, remoteCheckoutRoot);
      const tool = createAgentSkillListTool({
        ...createTestToolConfig(subprojectRoot, {
          workspaceId: "regular-workspace",
          runtime,
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: subprojectRoot,
            projectStorageAuthority: "runtime",
            checkoutRoot: remoteCheckoutRoot,
          },
        }),
        cwd: remoteSubprojectRoot,
      });

      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      const sharedSkills = result.skills.filter((skill) => skill.name === "shared");
      expect(sharedSkills).toHaveLength(1);
      expect(sharedSkills[0]).toMatchObject({
        description: "from packages",
        scope: "project",
      });
    });

    it("lists host-global skills in SSH project-runtime mode", async () => {
      using project = new TestTempDir("test-agent-skill-list-ssh-host-global");
      using xumHome = new TestTempDir("test-agent-skill-list-ssh-mux-home");

      const remoteWorkspaceRoot = "/remote/workspace";

      await withHomeDir(xumHome.path, async () => {
        await withMuxRoot(xumHome.path, async () => {
          await writeSkill(path.join(project.path, ".mux", "skills"), "project-remote", {
            description: "from remote workspace",
          });
          await writeGlobalSkill(xumHome.path, "host-global", {
            description: "from host mux home",
          });

          // Must use a RemoteRuntime subclass (not LocalRuntime) so the global-root
          // fallback to host-local kicks in via instanceof RemoteRuntime.
          const remoteRuntime = new TrueRemotePathMappedRuntime(project.path, remoteWorkspaceRoot);
          const config = createTestToolConfig(project.path, {
            workspaceId: "regular-workspace",
            runtime: remoteRuntime,
            xumScope: {
              type: "project",
              xumHome: xumHome.path,
              projectRoot: project.path,
              projectStorageAuthority: "runtime",
            },
          });

          const tool = createAgentSkillListTool({
            ...config,
            cwd: remoteWorkspaceRoot,
          });

          const result = (await tool.execute!(
            { includeUnadvertised: true },
            mockToolCallOptions
          )) as AgentSkillListToolResult;

          expect(result.success).toBe(true);
          if (!result.success) {
            return;
          }

          expect(result.skills.map((skill) => skill.name)).toEqual([
            "host-global",
            "project-remote",
          ]);
          expect(result.skills.find((skill) => skill.name === "host-global")?.scope).toBe("global");
          expect(result.skills.find((skill) => skill.name === "project-remote")?.scope).toBe(
            "project"
          );
        });
      });
    });

    it("uses runtime mux home and lists ~/.agents/skills in project-runtime mode", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-runtime-mux-home");
      using legacyHome = new TestTempDir("test-agent-skill-list-split-root-legacy-home");

      const runtimeGlobalSkill = "runtime-mux-home-global-skill";
      const legacyGlobalSkill = "legacy-tilde-global-skill";
      const remoteWorkspaceRoot = "/var/workspace";

      await withHomeDir(legacyHome.path, async () => {
        await withMuxRoot(legacyHome.path, async () => {
          await writeGlobalSkill(path.join(tempDir.path, "mux"), runtimeGlobalSkill, {
            description: "from runtime mux home",
          });
          await writeSkill(path.join(legacyHome.path, ".agents", "skills"), legacyGlobalSkill, {
            description: "from legacy tilde root",
          });

          const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, "/var", {
            xumHome: "/var/mux",
            resolveToRemotePath: false,
          });

          const config = createTestToolConfig(tempDir.path, {
            workspaceId: "regular-workspace",
            runtime: remoteRuntime,
            xumScope: {
              type: "project",
              xumHome: legacyHome.path,
              projectRoot: tempDir.path,
              projectStorageAuthority: "runtime",
            },
          });

          const tool = createAgentSkillListTool({
            ...config,
            cwd: remoteWorkspaceRoot,
          });

          const result = (await tool.execute!(
            { includeUnadvertised: true },
            mockToolCallOptions
          )) as AgentSkillListToolResult;

          expect(result.success).toBe(true);
          if (result.success) {
            expect(
              result.skills.some(
                (skill) => skill.name === runtimeGlobalSkill && skill.scope === "global"
              )
            ).toBe(true);
            expect(getSkill(result.skills, legacyGlobalSkill)).toMatchObject({
              name: legacyGlobalSkill,
              description: "from legacy tilde root",
              scope: "global",
            });
          }
        });
      });
    });

    it("lists project and global skills with the same name in project-runtime mode", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-duplicate-names");
      const sharedSkillName = "runtime-shared-skill";
      const previousMuxRoot = process.env.MUX_ROOT;

      process.env.MUX_ROOT = tempDir.path;

      try {
        await writeGlobalSkill(path.join(tempDir.path, ".mux"), sharedSkillName, {
          description: "project version",
        });
        await writeGlobalSkill(tempDir.path, sharedSkillName, {
          description: "global version",
        });

        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          xumScope: {
            type: "project",
            xumHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool(config);

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (result.success) {
          const sharedSkills = result.skills.filter((skill) => skill.name === sharedSkillName);
          expect(sharedSkills).toHaveLength(2);
          expect(sharedSkills.find((skill) => skill.scope === "project")?.description).toBe(
            "project version"
          );
          expect(sharedSkills.find((skill) => skill.scope === "global")?.description).toBe(
            "global version"
          );
        }
      } finally {
        if (previousMuxRoot === undefined) {
          delete process.env.MUX_ROOT;
        } else {
          process.env.MUX_ROOT = previousMuxRoot;
        }
      }
    });

    it("lists skills from legacy .agents/skills roots in project-runtime mode", async () => {
      using projectDir = new TestTempDir("test-agent-skill-list-split-root-legacy-root-inclusion");
      using homeDir = new TestTempDir("test-agent-skill-list-split-root-legacy-root-home");
      const writableSkillName = "runtime-writable-project-skill";
      const legacySkillName = "runtime-legacy-project-universal-skill";

      await withHomeDir(homeDir.path, async () => {
        await withMuxRoot(homeDir.path, async () => {
          await writeGlobalSkill(path.join(projectDir.path, ".mux"), writableSkillName);
          await writeSkill(path.join(projectDir.path, ".agents", "skills"), legacySkillName);

          const config = createTestToolConfig(projectDir.path, {
            workspaceId: "regular-workspace",
            xumScope: {
              type: "project",
              xumHome: homeDir.path,
              projectRoot: projectDir.path,
              projectStorageAuthority: "runtime",
            },
          });

          const tool = createAgentSkillListTool(config);

          const result = (await tool.execute!(
            { includeUnadvertised: true },
            mockToolCallOptions
          )) as AgentSkillListToolResult;

          expect(result.success).toBe(true);
          if (result.success) {
            expect(
              result.skills.some(
                (skill) => skill.name === writableSkillName && skill.scope === "project"
              )
            ).toBe(true);
            expect(getSkill(result.skills, legacySkillName)).toMatchObject({
              name: legacySkillName,
              scope: "project",
            });
          }
        });
      });
    });

    it("filters hidden project .agents/skills entries unless includeUnadvertised is true in project-runtime mode", async () => {
      using projectDir = new TestTempDir(
        "test-agent-skill-list-split-root-hidden-project-universal"
      );
      using homeDir = new TestTempDir("test-agent-skill-list-split-root-hidden-project-home");
      const hiddenSkillName = "runtime-hidden-project-universal-skill";

      await withHomeDir(homeDir.path, async () => {
        await withMuxRoot(homeDir.path, async () => {
          await writeSkill(path.join(projectDir.path, ".agents", "skills"), hiddenSkillName, {
            advertise: false,
          });

          const config = createTestToolConfig(projectDir.path, {
            workspaceId: "regular-workspace",
            xumScope: {
              type: "project",
              xumHome: homeDir.path,
              projectRoot: projectDir.path,
              projectStorageAuthority: "runtime",
            },
          });

          const tool = createAgentSkillListTool(config);

          const defaultResult = (await tool.execute!(
            {},
            mockToolCallOptions
          )) as AgentSkillListToolResult;
          expect(defaultResult.success).toBe(true);
          if (defaultResult.success) {
            expect(defaultResult.skills.some((skill) => skill.name === hiddenSkillName)).toBe(
              false
            );
          }

          const includeAllResult = (await tool.execute!(
            { includeUnadvertised: true },
            mockToolCallOptions
          )) as AgentSkillListToolResult;
          expect(includeAllResult.success).toBe(true);
          if (includeAllResult.success) {
            expect(getSkill(includeAllResult.skills, hiddenSkillName)).toMatchObject({
              name: hiddenSkillName,
              scope: "project",
              advertise: false,
            });
          }
        });
      });
    });

    it("filters hidden ~/.agents/skills entries unless includeUnadvertised is true in project-runtime mode", async () => {
      using projectDir = new TestTempDir("test-agent-skill-list-split-root-hidden-global-project");
      using homeDir = new TestTempDir("test-agent-skill-list-split-root-hidden-global-home");
      const hiddenSkillName = "runtime-hidden-global-universal-skill";

      await withHomeDir(homeDir.path, async () => {
        await withMuxRoot(homeDir.path, async () => {
          await writeSkill(path.join(homeDir.path, ".agents", "skills"), hiddenSkillName, {
            advertise: false,
          });

          const config = createTestToolConfig(projectDir.path, {
            workspaceId: "regular-workspace",
            xumScope: {
              type: "project",
              xumHome: homeDir.path,
              projectRoot: projectDir.path,
              projectStorageAuthority: "runtime",
            },
          });

          const tool = createAgentSkillListTool(config);

          const defaultResult = (await tool.execute!(
            {},
            mockToolCallOptions
          )) as AgentSkillListToolResult;
          expect(defaultResult.success).toBe(true);
          if (defaultResult.success) {
            expect(defaultResult.skills.some((skill) => skill.name === hiddenSkillName)).toBe(
              false
            );
          }

          const includeAllResult = (await tool.execute!(
            { includeUnadvertised: true },
            mockToolCallOptions
          )) as AgentSkillListToolResult;
          expect(includeAllResult.success).toBe(true);
          if (includeAllResult.success) {
            expect(getSkill(includeAllResult.skills, hiddenSkillName)).toMatchObject({
              name: hiddenSkillName,
              scope: "global",
              advertise: false,
            });
          }
        });
      });
    });

    it("skips escaped project skills while keeping in-bound project/global skills", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-containment");
      using escapedSkillsDir = new TestTempDir(
        "test-agent-skill-list-split-root-containment-escape"
      );
      using xumHomeDir = new TestTempDir("test-agent-skill-list-split-root-containment-mux-home");

      const remoteWorkspaceRoot = "/remote/workspace";
      const escapedSkillName = "escaped-runtime-skill";
      const safeGlobalSkillName = "runtime-safe-global-skill";
      const previousMuxRoot = process.env.MUX_ROOT;

      process.env.MUX_ROOT = xumHomeDir.path;

      try {
        await writeGlobalSkill(escapedSkillsDir.path, escapedSkillName);
        await fs.symlink(
          escapedSkillsDir.path,
          path.join(tempDir.path, ".mux"),
          process.platform === "win32" ? "junction" : "dir"
        );

        await writeGlobalSkill(xumHomeDir.path, safeGlobalSkillName);

        const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          runtime: remoteRuntime,
          xumScope: {
            type: "project",
            xumHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool({
          ...config,
          cwd: remoteWorkspaceRoot,
        });

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        expect(remoteRuntime.resolvePathCallCount).toBeGreaterThan(0);

        if (result.success) {
          expect(
            result.skills.some(
              (skill) => skill.name === safeGlobalSkillName && skill.scope === "global"
            )
          ).toBe(true);
          expect(result.skills.find((skill) => skill.name === escapedSkillName)).toBeUndefined();
        }
      } finally {
        if (previousMuxRoot === undefined) {
          delete process.env.MUX_ROOT;
        } else {
          process.env.MUX_ROOT = previousMuxRoot;
        }
      }
    });
  });

  it("filters unadvertised skills unless includeUnadvertised is true", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-advertise");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      await writeGlobalSkill(tempDir.path, "advertised-skill");
      await writeGlobalSkill(tempDir.path, "hidden-skill", { advertise: false });

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: {
          type: "global",
          xumHome: tempDir.path,
        },
      });

      const tool = createAgentSkillListTool(config);

      const defaultResult = (await tool.execute!(
        {},
        mockToolCallOptions
      )) as AgentSkillListToolResult;
      expect(defaultResult.success).toBe(true);
      if (defaultResult.success) {
        expect(defaultResult.skills.map((skill) => skill.name)).toEqual(["advertised-skill"]);
      }

      const includeAllResult = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;
      expect(includeAllResult.success).toBe(true);
      if (includeAllResult.success) {
        expect(includeAllResult.skills.map((skill) => skill.name)).toEqual([
          "advertised-skill",
          "hidden-skill",
        ]);
      }
    });
  });

  it("skips symlinked project skill directories that resolve outside the project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project-entry-symlink");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "project");
      const skillsDir = path.join(projectRoot, ".mux", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      // Legitimate project skill directory.
      await writeGlobalSkill(path.join(projectRoot, ".mux"), "real-skill");

      // External skill directory linked into project skills root.
      const externalSkillDir = path.join(tempDir.path, "external", "sneaky-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        "---\nname: sneaky-skill\ndescription: should not appear\n---\nBody\n",
        "utf-8"
      );
      await fs.symlink(externalSkillDir, path.join(skillsDir, "sneaky-skill"));

      // Also create a real global skill.
      await writeGlobalSkill(tempDir.path, "global-skill");

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        // Symlinked entry should be skipped.
        expect(result.skills.map((s) => s.name)).toEqual(["global-skill", "real-skill"]);
        expect(result.skills.find((s) => s.name === "real-skill")?.scope).toBe("project");
        expect(result.skills.find((s) => s.name === "sneaky-skill")).toBeUndefined();
      }
    });
  });

  it("lists symlinked project skill directories whose target stays inside the project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project-entry-symlink-contained");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "project");
      const skillsDir = path.join(projectRoot, ".mux", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      // Real skill stored elsewhere inside the project (not itself a skills root),
      // symlinked into .mux/skills: the layout skill package managers install.
      const storeSkillDir = path.join(projectRoot, "skill-store", "linked-skill");
      await fs.mkdir(storeSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(storeSkillDir, "SKILL.md"),
        "---\nname: linked-skill\ndescription: contained symlinked skill\n---\nBody\n",
        "utf-8"
      );
      await fs.symlink(storeSkillDir, path.join(skillsDir, "linked-skill"));

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        const linked = result.skills.find((s) => s.name === "linked-skill");
        expect(linked).toBeDefined();
        expect(linked?.scope).toBe("project");
        expect(linked?.description).toBe("contained symlinked skill");
      }
    });
  });

  it("skips escaped symlinked skill dir even when its SKILL.md symlinks back inside the project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-two-level-symlink-escape");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "project");
      const skillsDir = path.join(projectRoot, ".mux", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      // In-project decoy SKILL.md the attacker points back at to pass a file-only check.
      const decoyDir = path.join(projectRoot, "decoy");
      await fs.mkdir(decoyDir, { recursive: true });
      const decoyFile = path.join(decoyDir, "SKILL.md");
      await fs.writeFile(
        decoyFile,
        "---\nname: evil-skill\ndescription: dir escapes containment\n---\nBody\n",
        "utf-8"
      );

      // Skill dir resolves OUTSIDE the project; its SKILL.md symlinks back inside.
      const externalSkillDir = path.join(tempDir.path, "external", "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.symlink(decoyFile, path.join(externalSkillDir, "SKILL.md"));
      await fs.symlink(externalSkillDir, path.join(skillsDir, "evil-skill"));

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills.find((s) => s.name === "evil-skill")).toBeUndefined();
      }
    });
  });

  it("skips project skill when SKILL.md symlink target escapes project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-skillmd-symlink-escape");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "project");
      const skillsDir = path.join(projectRoot, ".mux", "skills");

      // Create a legitimate project skill.
      await writeGlobalSkill(path.join(projectRoot, ".mux"), "legit-skill");

      // Create a skill directory with SKILL.md symlinked to an external file.
      const leakySkillDir = path.join(skillsDir, "leaky-skill");
      await fs.mkdir(leakySkillDir, { recursive: true });

      const externalDir = path.join(tempDir.path, "external");
      const externalFile = path.join(externalDir, "secret.md");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        externalFile,
        "---\nname: leaky-skill\ndescription: should not be read\n---\nSecret body\n",
        "utf-8"
      );
      await fs.symlink(externalFile, path.join(leakySkillDir, "SKILL.md"));

      // Also create a global skill.
      await writeGlobalSkill(tempDir.path, "global-skill");

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills.map((s) => s.name)).toEqual(["global-skill", "legit-skill"]);
        expect(result.skills.find((s) => s.name === "leaky-skill")).toBeUndefined();
      }
    });
  });

  it("skips skill with oversized SKILL.md", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-oversized-skillmd");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      await writeGlobalSkill(tempDir.path, "normal-skill");

      const oversizedSkillDir = path.join(tempDir.path, "skills", "big-skill");
      await fs.mkdir(oversizedSkillDir, { recursive: true });
      const oversizedContent =
        "---\nname: big-skill\ndescription: too large\n---\n" + "x".repeat(MAX_FILE_SIZE + 1);
      await fs.writeFile(path.join(oversizedSkillDir, "SKILL.md"), oversizedContent, "utf-8");

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: {
          type: "global",
          xumHome: tempDir.path,
        },
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills.map((s) => s.name)).toEqual(["normal-skill"]);
        expect(result.skills.find((s) => s.name === "big-skill")).toBeUndefined();
      }
    });
  });

  it("continues listing global skills when project skills root is not a directory", async () => {
    using project = new TestTempDir("test-agent-skill-list-project-root-not-directory");
    using xumHome = new TestTempDir("test-agent-skill-list-global-root-valid");

    await withHomeDir(xumHome.path, async () => {
      await fs.mkdir(path.join(project.path, ".mux"), { recursive: true });
      await fs.writeFile(path.join(project.path, ".mux", "skills"), "not a directory", "utf-8");
      await writeGlobalSkill(xumHome.path, "global-skill", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills.map((s) => s.name)).toEqual(["global-skill"]);
      }
    });
  });

  it("returns no skills when both project and global roots are not directories", async () => {
    using project = new TestTempDir("test-agent-skill-list-both-roots-not-directories-project");
    using xumHome = new TestTempDir("test-agent-skill-list-both-roots-not-directories-home");

    await withHomeDir(xumHome.path, async () => {
      await fs.mkdir(path.join(project.path, ".mux"), { recursive: true });
      await fs.writeFile(path.join(project.path, ".mux", "skills"), "not a directory", "utf-8");
      await fs.writeFile(path.join(xumHome.path, "skills"), "not a directory", "utf-8");

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          xumScope: {
            type: "project",
            xumHome: xumHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skills).toEqual([]);
      }
    });
  });

  it("skips project skills when .mux is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project-mux-symlink");

    await withHomeDir(tempDir.path, async () => {
      const workspaceSessionDir = await createWorkspaceSessionDir(
        tempDir.path,
        GLOBAL_WORKSPACE_ID
      );

      const projectRoot = path.join(tempDir.path, "project");
      await fs.mkdir(projectRoot, { recursive: true });

      // Create external directory with skill content
      const externalDir = path.join(tempDir.path, "external");
      await fs.mkdir(path.join(externalDir, "skills", "external-skill"), { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "skills", "external-skill", "SKILL.md"),
        "---\nname: external-skill\ndescription: should not appear\n---\nBody\n",
        "utf-8"
      );

      // Symlink .mux to external
      await fs.symlink(externalDir, path.join(projectRoot, ".mux"));

      // Also create a real global skill
      await writeGlobalSkill(tempDir.path, "global-skill");

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      };

      const config = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: workspaceSessionDir,
        xumScope: projectScope,
      });

      const tool = createAgentSkillListTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        // External skill should NOT appear; only real global skill should be listed
        expect(result.skills.map((s) => s.name)).toEqual(["global-skill"]);
        expect(result.skills.every((s) => s.scope === "global")).toBe(true);
      }
    });
  });
});
