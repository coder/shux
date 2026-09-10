import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import { createTestPluginInstallEntry } from "@/node/services/agentPlugins/testFixtures";
import { AgentSkillReadFileToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { createAgentSkillReadFileTool } from "./agent_skill_read_file";
import {
  createTestToolConfig,
  mockToolCallOptions,
  RemotePathMappedRuntime,
  restoreMuxRoot,
  TEST_GLOBAL_WORKSPACE_ID as GLOBAL_WORKSPACE_ID,
  TestTempDir,
  TrueRemotePathMappedRuntime,
  writeGlobalSkill,
  writeProjectSkill,
} from "./testHelpers";

type ReadFileTool = ReturnType<typeof createAgentSkillReadFileTool>;
type ReadFileArgs = Parameters<NonNullable<ReadFileTool["execute"]>>[0];

async function executeReadFile(tool: ReadFileTool, args: ReadFileArgs) {
  const raw: unknown = await Promise.resolve(tool.execute!(args, mockToolCallOptions));
  const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
}

const REMOTE_WORKSPACE_ROOT = "/remote/workspace";

function createRemoteRuntimeConfig(tempDirPath: string) {
  const runtime = new RemotePathMappedRuntime(tempDirPath, REMOTE_WORKSPACE_ROOT);
  const baseConfig = createTestToolConfig(tempDirPath, {
    workspaceId: "regular-workspace",
    runtime,
    xumScope: {
      type: "project",
      xumHome: tempDirPath,
      projectRoot: tempDirPath,
      projectStorageAuthority: "runtime",
    },
  });

  return {
    ...baseConfig,
    cwd: REMOTE_WORKSPACE_ROOT,
    workspaceSessionDir: REMOTE_WORKSPACE_ROOT,
  };
}

describe("agent_skill_read_file", () => {
  it("enforces managed skill imports on referenced-file reads and preserves same-name source fallback", async () => {
    using tmp = new TestTempDir("plugin-read-file-imports");
    const container = path.join(tmp.path, "plugins");
    for (const [plugin, names] of [
      ["a-managed", ["allowed", "blocked", "shared"]],
      ["b-unmanaged", ["shared"]],
    ] as const) {
      const root = path.join(container, plugin);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: plugin,
        })
      );
      for (const name of names) {
        const dir = path.join(root, "skills", name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: fixture\n---\nBody\n`
        );
        await fs.writeFile(path.join(dir, "data.txt"), plugin);
      }
    }
    await fs.writeFile(
      path.join(tmp.path, "plugins.json"),
      JSON.stringify({
        plugins: [
          createTestPluginInstallEntry("a-managed", { skills: ["allowed"], mcpServers: [] }),
        ],
      })
    );
    const tool = createAgentSkillReadFileTool({
      ...createTestToolConfig(tmp.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        xumScope: { type: "global", xumHome: tmp.path },
      }),
      experiments: { agentPlugins: true },
    });
    expect(await executeReadFile(tool, { name: "blocked", filePath: "data.txt" })).toMatchObject({
      success: false,
    });
    expect(
      await executeReadFile(tool, { name: "allowed", filePath: "../blocked/data.txt" })
    ).toMatchObject({ success: false });
    expect(await executeReadFile(tool, { name: "allowed", filePath: "data.txt" })).toMatchObject({
      success: true,
      content: "1\ta-managed",
    });
    expect(await executeReadFile(tool, { name: "shared", filePath: "data.txt" })).toMatchObject({
      success: true,
      content: "1\tb-unmanaged",
    });
  });

  it.each([
    [".xum", false],
    [".mux", false],
    [".xum", true],
    [".mux", true],
  ] as const)(
    "overlapping %s project roots enforce managed sibling-file read imports (aliased home: %s)",
    async (metadataDir, aliasHome) => {
      using home = new TestTempDir("plugin-read-file-overlap");
      const physicalHome = path.join(home.path, metadataDir);
      const xumHome = aliasHome ? path.join(home.path, "configured-home") : physicalHome;
      await fs.mkdir(physicalHome, { recursive: true });
      if (aliasHome) await fs.symlink(physicalHome, xumHome, "dir");
      const pluginRoot = path.join(xumHome, "plugins", "managed");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "managed",
        })
      );
      for (const name of ["allowed", "blocked"]) {
        const skillDir = path.join(pluginRoot, "skills", name);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: fixture\n---\nBody\n`
        );
        await fs.writeFile(path.join(skillDir, "data.txt"), name);
      }
      const registryPath = path.join(xumHome, "plugins.json");
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          plugins: [
            createTestPluginInstallEntry("managed", { skills: ["allowed"], mcpServers: [] }),
          ],
        })
      );
      const tool = createAgentSkillReadFileTool({
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
      expect(await executeReadFile(tool, { name: "blocked", filePath: "data.txt" })).toMatchObject({
        success: false,
      });
      expect(
        await executeReadFile(tool, { name: "allowed", filePath: "../blocked/data.txt" })
      ).toMatchObject({ success: false });
      expect(await executeReadFile(tool, { name: "allowed", filePath: "data.txt" })).toMatchObject({
        success: true,
        content: "1\tallowed",
      });
      await fs.writeFile(registryPath, "{");
      expect(await executeReadFile(tool, { name: "allowed", filePath: "data.txt" })).toMatchObject({
        success: false,
      });
    }
  );

  it("allows reading built-in skill files", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-global-scope");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadFileTool(baseConfig);

    const result = await executeReadFile(tool, {
      name: "xum-docs",
      filePath: "SKILL.md",
      offset: 1,
      limit: 25,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*xum-docs/i);
    }
  });

  it("allows reading global skill files on disk in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const result = await executeReadFile(tool, {
        name: "foo",
        filePath: "SKILL.md",
        offset: 1,
        limit: 5,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/name:\s*foo/i);
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("reads files from the global skill when a workspace-local shadow exists in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-global-shadowing");

    await writeProjectSkill(tempDir.path, "shadowed-skill", {
      files: {
        "references/data.txt": "from workspace-local shadow",
      },
    });
    await writeGlobalSkill(tempDir.path, "shadowed-skill", {
      files: {
        "references/data.txt": "from global skill",
      },
    });

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });
    const tool = createAgentSkillReadFileTool(baseConfig);

    const result = await executeReadFile(tool, {
      name: "shadowed-skill",
      filePath: "references/data.txt",
      offset: 1,
      limit: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("1\tfrom global skill");
    }
  });

  it("allows reading project skill files on disk outside global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-project");
    await writeProjectSkill(tempDir.path, "project-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: tempDir.path,
        projectStorageAuthority: "host-local",
      },
    });
    const tool = createAgentSkillReadFileTool(baseConfig);

    const result = await executeReadFile(tool, {
      name: "project-skill",
      filePath: "SKILL.md",
      offset: 1,
      limit: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*project-skill/i);
    }
  });

  it("rejects project skill file read when skill directory symlink escapes project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-project-escape");

    const projectRoot = path.join(tempDir.path, "project");
    const skillsDir = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    // External skill outside project root.
    const externalDir = path.join(tempDir.path, "external", "leaky-skill");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: leaky-skill\ndescription: escaped\n---\nBody\n",
      "utf-8"
    );
    await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret data", "utf-8");

    await fs.symlink(
      externalDir,
      path.join(skillsDir, "leaky-skill"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    const tool = createAgentSkillReadFileTool(baseConfig);

    const result = await executeReadFile(tool, { name: "leaky-skill", filePath: "secret.txt" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("top secret");
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("reads project skill file via xumScope when cwd differs (remote-like split root)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-project-split-root");
    const hostProjectRoot = tempDir.path;
    const remoteStyleCwd = "/remote/workspace/path";

    await writeProjectSkill(hostProjectRoot, "my-skill");
    const skillDir = path.join(hostProjectRoot, ".xum", "skills", "my-skill");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "data.txt"), "hello from host", "utf-8");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: hostProjectRoot,
        projectStorageAuthority: "host-local",
      },
    });
    const config = { ...baseConfig, cwd: remoteStyleCwd };

    const tool = createAgentSkillReadFileTool(config);

    const result = await executeReadFile(tool, {
      name: "my-skill",
      filePath: "references/data.txt",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("hello from host");
    }
  });

  it("preserves active runtime in split-root project context (SSH/Docker)", async () => {
    const remoteWorkspacePath = "/remote/workspace";
    using tempDir = new TestTempDir("test-agent-skill-read-file-split-root-runtime-preserved");
    const hostProjectRoot = tempDir.path;

    const remoteSkillDir = path.join(tempDir.path, ".xum", "skills", "test-skill");
    await fs.mkdir(remoteSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(remoteSkillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: remote skill\n---\nRemote body",
      "utf-8"
    );
    await fs.writeFile(path.join(remoteSkillDir, "data.txt"), "remote file content", "utf-8");

    const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspacePath);

    const baseConfig = createTestToolConfig(tempDir.path, {
      runtime: remoteRuntime,
      xumScope: {
        type: "project",
        xumHome: path.join(tempDir.path, "mux-home"),
        projectRoot: hostProjectRoot,
        projectStorageAuthority: "runtime",
      },
    });
    const config = { ...baseConfig, cwd: remoteWorkspacePath };

    const tool = createAgentSkillReadFileTool(config);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "test-skill", filePath: "data.txt" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("remote file content");
    }
  });

  it("reads host-global skill files in SSH workspaces without syncing them to the remote", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-ssh-host-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "host-global", {
        files: {
          "references/data.txt": "hello from host-global skill",
        },
      });

      // Must use a true RemoteRuntime subclass so instanceof RemoteRuntime triggers
      // the host-global fallback in the skills service.
      const remoteRuntime = new TrueRemotePathMappedRuntime(tempDir.path, REMOTE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: tempDir.path,
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: REMOTE_WORKSPACE_ROOT,
        workspaceSessionDir: REMOTE_WORKSPACE_ROOT,
      };

      const tool = createAgentSkillReadFileTool(config);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "host-global", filePath: "references/data.txt", offset: 1, limit: 5 },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toContain("hello from host-global skill");
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  describe("runtime-aware containment with remote runtime paths", () => {
    it("reads project skill files through the injected runtime", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-read");
      await writeProjectSkill(tempDir.path, "remote-skill");

      const skillDir = path.join(tempDir.path, ".xum", "skills", "remote-skill");
      await fs.writeFile(path.join(skillDir, "extra.txt"), "extra content", "utf-8");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "remote-skill", filePath: "extra.txt", offset: 1, limit: 5 },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/extra content/i);
      }
    });

    it("allows symlinked skill directories when containment still passes (runtime probe)", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-symlinked-dir");

      const skillsRoot = path.join(tempDir.path, ".mux", "skills");
      const externalDir = path.join(tempDir.path, "external-skill-source");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "SKILL.md"),
        "---\nname: evil\ndescription: test\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret", "utf-8");

      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillsRoot, "evil"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "evil", filePath: "secret.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/top secret/i);
      }
    });

    it("rejects escaped symlink files through the runtime probe", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-symlinked-file");
      await writeProjectSkill(tempDir.path, "real-skill");

      const skillDir = path.join(tempDir.path, ".xum", "skills", "real-skill");
      const externalFile = path.join(tempDir.path, "external-secret.txt");
      await fs.writeFile(externalFile, "outside skill", "utf-8");
      await fs.symlink(externalFile, path.join(skillDir, "link.txt"), "file");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "real-skill", filePath: "link.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escape|outside|symbolic link|symlink/i);
      }
    });
    it("treats missing nested parent dirs as not-found, not path escape (runtime)", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-read-file-remote-runtime-missing-parent-dir"
      );
      await writeProjectSkill(tempDir.path, "missing-parent");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "missing-parent", filePath: "references/foo.txt" },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).not.toMatch(/outside the skill directory|escape/i);
        expect(result.error).toMatch(/failed to stat|enoent|no such file/i);
      }
    });

    it("rejects symlinked ancestors above missing segments as path escape (runtime)", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-read-file-remote-runtime-missing-parent-symlink-ancestor"
      );
      await writeProjectSkill(tempDir.path, "symlink-ancestor");

      const skillDir = path.join(tempDir.path, ".xum", "skills", "symlink-ancestor");
      const externalDir = path.join(tempDir.path, "external-linked-root");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillDir, "link-outside"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "symlink-ancestor", filePath: "link-outside/missing-subdir/file.txt" },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/outside the skill directory|escape/i);
      }
    });
  });

  describe("symlink safety", () => {
    it("allows reads from a symlinked skill directory when containment still passes", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-dir");

      const skillsRoot = path.join(tempDir.path, ".mux", "skills");
      const externalDir = path.join(tempDir.path, "external-skill-source");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "SKILL.md"),
        "---\nname: evil\ndescription: test\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret", "utf-8");

      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillsRoot, "evil"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: tempDir.path,
          projectStorageAuthority: "host-local",
        },
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "evil", filePath: "secret.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/top secret/i);
      }
    });

    it("rejects reads from a symlinked file that escapes containment", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-file");
      await writeProjectSkill(tempDir.path, "real-skill");

      const skillDir = path.join(tempDir.path, ".xum", "skills", "real-skill");
      const externalFile = path.join(tempDir.path, "external-secret.txt");
      await fs.writeFile(externalFile, "outside skill", "utf-8");
      await fs.symlink(externalFile, path.join(skillDir, "link.txt"), "file");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: tempDir.path,
          projectStorageAuthority: "host-local",
        },
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "real-skill", filePath: "link.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escape|outside|symbolic link|symlink/i);
      }
    });
  });
});
