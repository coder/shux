import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { AgentSkillReadToolResultSchema } from "@/common/utils/tools/toolDefinitions";
const GLOBAL_WORKSPACE_ID = "workspace-global";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createAgentSkillReadTool } from "./agent_skill_read";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

async function writeProjectSkill(
  workspacePath: string,
  name: string,
  options?: {
    description?: string;
    body?: string;
  }
): Promise<void> {
  const skillDir = path.join(workspacePath, ".mux", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? "test"}\n---\n${options?.body ?? "Body"}\n`,
    "utf-8"
  );
}

async function writeGlobalSkill(
  muxRoot: string,
  name: string,
  options?: {
    description?: string;
    body?: string;
  }
): Promise<void> {
  const skillDir = path.join(muxRoot, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? "test"}\n---\n${options?.body ?? "Body"}\n`,
    "utf-8"
  );
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localBase: string;
  private readonly remoteBase: string;

  constructor(localBase: string, remoteBase: string) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");

    if (normalizedRuntimePath === this.remoteBase) {
      return this.localBase;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localBase) {
      return this.remoteBase;
    }

    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }

    return localPath.replaceAll("\\", "/");
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return super.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return super.readFile(this.toLocalPath(filePath), abortSignal);
  }
}

describe("agent_skill_read", () => {
  it("allows reading built-in skills", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global-scope");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "xum-docs" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("built-in");
      expect(result.skill.frontmatter.name).toBe("xum-docs");
    }
  });

  it("allows reading global skills on disk in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "foo" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skill.scope).toBe("global");
        expect(result.skill.frontmatter.name).toBe("foo");
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("prefers global skills over workspace-local shadows in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global-shadowing");

    await writeProjectSkill(tempDir.path, "shadowed-skill", {
      description: "workspace-local shadow",
      body: "Local body",
    });
    await writeGlobalSkill(tempDir.path, "shadowed-skill", {
      description: "global winner",
      body: "Global body",
    });

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });
    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "shadowed-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("global");
      expect(result.skill.frontmatter.description).toBe("global winner");
      expect(result.skill.body.trim()).toBe("Global body");
    }
  });

  it("allows reading project skills on disk outside global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project");
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
    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "project-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("project");
      expect(result.skill.frontmatter.name).toBe("project-skill");
    }
  });

  it("rejects project skill when skill directory symlink escapes project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project-escape");

    const projectRoot = path.join(tempDir.path, "project");
    const skillsDir = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    // Create external skill directory OUTSIDE project root.
    const externalDir = path.join(tempDir.path, "external", "leaky-skill");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: leaky-skill\ndescription: should not be readable\n---\nSecret body\n",
      "utf-8"
    );

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

    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "leaky-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);

    const result = parsed.data;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("reads project skill via xumScope when cwd differs (remote-like split root)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project-split-root");
    const hostProjectRoot = tempDir.path;
    const remoteStyleCwd = "/remote/workspace/path";

    await writeProjectSkill(hostProjectRoot, "my-skill");

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

    const tool = createAgentSkillReadTool(config);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "my-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.directoryName).toBe("my-skill");
      expect(result.skill.scope).toBe("project");
    }
  });

  it("preserves active runtime in split-root project context (SSH/Docker)", async () => {
    const remoteWorkspacePath = "/remote/workspace";
    using tempDir = new TestTempDir("test-agent-skill-read-split-root-runtime-preserved");
    const hostProjectRoot = tempDir.path;

    const remoteSkillDir = path.join(tempDir.path, "remote-skills", "test-skill");
    await fs.mkdir(remoteSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(remoteSkillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: remote skill\n---\nRemote body",
      "utf-8"
    );

    const remoteRuntime = new RemotePathMappedRuntime(
      path.join(tempDir.path, "remote-skills"),
      "/remote/workspace/.mux/skills"
    );

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

    const tool = createAgentSkillReadTool(config);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "test-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.body).toContain("Remote body");
    }
  });

  it("appends whenToUse guidance only for skills that carry it in the description index", () => {
    using tempDir = new TestTempDir("test-agent-skill-read-when-to-use");
    const baseConfig = createTestToolConfig(tempDir.path);

    const tool = createAgentSkillReadTool({
      ...baseConfig,
      availableSkills: [
        {
          name: "with-guidance",
          description: "Skill carrying extra guidance",
          scope: "global",
          whenToUse: "only when triaging incoming issues",
        },
        {
          name: "without-guidance",
          description: "Skill without extra guidance",
          scope: "global",
        },
      ],
    });

    // The ai SDK types `description` as string | dynamic-function; the factory always
    // builds a static string.
    const description = typeof tool.description === "string" ? tool.description : "";
    const lines = description.split("\n");
    const withLine = lines.find((line) => line.startsWith("- with-guidance:"));
    const withoutLine = lines.find((line) => line.startsWith("- without-guidance:"));

    expect(withLine).toContain("only when triaging incoming issues");
    expect(withoutLine).toBeDefined();
    expect(withoutLine).not.toContain("When to use:");
  });
});
