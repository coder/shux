import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect, spyOn } from "bun:test";
import type { XumToolScope } from "@/common/types/toolScope";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import {
  REFINEMENT_CAPTURE_MAX_FILE_BYTES,
  REFINEMENT_CAPTURE_MAX_FILES,
  RefinementEvidenceSchema,
  RefinementInverseSchema,
  SkillRefinementActionSchema,
} from "@/common/types/refinement";
import {
  applyRefinementInverse,
  readRefinementEvents,
  seedForeignTargetLock,
} from "@/node/services/refinement/refinementTestHelpers";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { SKILL_FILENAME } from "./skillFileUtils";
import { createAgentSkillDeleteTool } from "./agent_skill_delete";
import {
  createTestToolConfig,
  createWorkspaceSessionDir,
  mockToolCallOptions,
  RemotePathMappedRuntime,
  restoreXumRoot,
  TEST_GLOBAL_WORKSPACE_ID as GLOBAL_WORKSPACE_ID,
  TestTempDir,
  writeGlobalSkill,
  writeProjectSkill,
  writeSkill,
  writeSkillWithReference,
} from "./testHelpers";

const TILDE_WORKSPACE_ROOT = "~/xum/project/main";

async function createDeleteTool(
  xumHome: string,
  workspaceId: string = GLOBAL_WORKSPACE_ID,
  xumScope?: XumToolScope
) {
  const workspaceSessionDir = await createWorkspaceSessionDir(xumHome, workspaceId);
  const config = createTestToolConfig(xumHome, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
    xumScope,
  });

  return createAgentSkillDeleteTool(config);
}

describe("agent_skill_delete", () => {
  it("requires confirm: true before deleting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-confirm");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: false },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/confirm/i);
    }

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillStat.isDirectory()).toBe(true);
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-project-scope");

    const projectRoot = path.join(tempDir.path, "my-project");
    await fs.mkdir(path.join(projectRoot, ".xum", "skills"), { recursive: true });
    await writeSkillWithReference(path.join(projectRoot, ".xum"), "demo-skill");

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const statErr = await fs
      .stat(path.join(projectRoot, ".xum", "skills", "demo-skill"))
      .catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });
  it("deletes legacy-only and shadowed project packages without reappearing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-legacy");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(legacyRoot, "legacy-only");
    await writeSkill(canonicalRoot, "shadowed");
    await writeSkill(legacyRoot, "shadowed");

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    for (const name of ["legacy-only", "shadowed"]) {
      const result = (await tool.execute!(
        { name, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;
      expect(result).toMatchObject({ success: true, deleted: "skill" });
      expect(fs.stat(path.join(canonicalRoot, name))).rejects.toThrow();
      expect(fs.stat(path.join(legacyRoot, name))).rejects.toThrow();
    }
  });

  it("deletes canonical and legacy manifests so fallback skills stay hidden", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-manifest-shadow");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(canonicalRoot, "demo-skill");
    await writeSkill(legacyRoot, "demo-skill");
    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });

    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/../SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(path.join(canonicalRoot, "demo-skill", SKILL_FILENAME))).rejects.toThrow();
    expect(fs.stat(path.join(legacyRoot, "demo-skill", SKILL_FILENAME))).rejects.toThrow();
  });

  it("migrates an incomplete canonical package before deleting its fallback manifest", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-partial-canonical-manifest");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyDir = path.join(projectRoot, ".mux", "skills", "demo-skill");
    await fs.mkdir(path.join(canonicalDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "references", "canonical.txt"),
      "canonical",
      "utf-8"
    );
    await writeSkill(path.dirname(legacyDir), "demo-skill");

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(path.join(canonicalDir, SKILL_FILENAME))).rejects.toThrow();
    expect(fs.stat(path.join(legacyDir, SKILL_FILENAME))).rejects.toThrow();
    expect(await fs.readFile(path.join(canonicalDir, "references", "canonical.txt"), "utf-8")).toBe(
      "canonical"
    );
  });

  it("keeps the canonical manifest when legacy manifest deletion fails", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-manifest-failure");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalManifest = path.join(
      projectRoot,
      ".xum",
      "skills",
      "demo-skill",
      SKILL_FILENAME
    );
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo-skill", SKILL_FILENAME);
    await writeSkill(path.dirname(path.dirname(canonicalManifest)), "demo-skill");
    await writeSkill(path.dirname(path.dirname(legacyManifest)), "demo-skill");
    const rmSpy = spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      });
      const result = (await tool.execute!(
        { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;
      expect(result.success).toBe(false);
      expect(await fs.readFile(canonicalManifest, "utf-8")).toContain("name: demo-skill");
      expect(await fs.readFile(legacyManifest, "utf-8")).toContain("name: demo-skill");
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("does not migrate a legacy package while another process holds the target lock", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-legacy-migration-locked");
    const projectRoot = path.join(tempDir.path, "project");
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo-skill", SKILL_FILENAME);
    await writeSkill(path.dirname(path.dirname(legacyManifest)), "demo-skill");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");

    // Deterministic cross-process interleaving: occupy the canonical skills
    // root target lock, as another process's in-flight rollback would.
    // Migration REWRITES the canonical dir, so run outside the lock it could
    // land between the rollback's in-lock verify and its inverse apply.
    const lockPath = await seedForeignTargetLock(
      tempDir.path,
      path.join(projectRoot, ".xum", "skills")
    );

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const blocked = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("unreachable");
    expect(blocked.error).toContain("Another process is mutating");
    // Nothing mutated: no canonical dir appeared, the legacy manifest survived.
    const statErr = await fs.stat(canonicalDir).catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(legacyManifest, "utf-8")).toContain("name: demo-skill");

    // Lock released → the same delete migrates, then removes both manifests.
    await fs.unlink(lockPath);
    const retried = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(retried).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(path.join(canonicalDir, SKILL_FILENAME))).rejects.toThrow();
    expect(fs.stat(legacyManifest)).rejects.toThrow();
  });

  it("deletes host-local project skills through the host runtime for Devcontainers", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-devcontainer-host");
    const projectRoot = path.join(tempDir.path, "project");
    await writeSkill(path.join(projectRoot, ".xum", "skills"), "demo-skill");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src"),
      configPath: path.join(projectRoot, ".devcontainer", "devcontainer.json"),
    });
    const config = createTestToolConfig(tempDir.path, {
      runtime,
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    const result = (await createAgentSkillDeleteTool(config).execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(fs.stat(path.join(projectRoot, ".xum", "skills", "demo-skill"))).rejects.toThrow();
  });

  describe("split-root (project-runtime)", () => {
    it("deletes project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime");
      const skillName = "my-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeSkillWithReference(path.join(tempDir.path, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: skillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "skill" });

      const skillDir = path.join(tempDir.path, ".xum", "skills", skillName);
      const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    });

    it("deletes project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-skill"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "xum", "project", "main");

      await writeSkillWithReference(path.join(runtimeWorkspaceRoot, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: TILDE_WORKSPACE_ROOT,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: skillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "skill" });

      const skillDir = path.join(runtimeWorkspaceRoot, ".xum", "skills", skillName);
      const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    });

    it("returns explicit not-found when deleting a missing project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime-missing");
      const missingSkillName = "missing-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: missingSkillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(`Skill not found: ${missingSkillName}`);
      }
    });

    it("deletes single file from project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime-file");
      const skillName = "my-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeSkillWithReference(path.join(tempDir.path, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          filePath: "references/foo.txt",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "file" });

      const deletedFilePath = path.join(
        tempDir.path,
        ".xum",
        "skills",
        skillName,
        "references",
        "foo.txt"
      );
      const deletedFileStatErr = await fs
        .stat(deletedFilePath)
        .catch((error: NodeJS.ErrnoException) => error);
      expect(deletedFileStatErr).toMatchObject({ code: "ENOENT" });

      const skillStat = await fs.stat(
        path.join(tempDir.path, ".xum", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("deletes single file from project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-file"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "xum", "project", "main");

      await writeSkillWithReference(path.join(runtimeWorkspaceRoot, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: TILDE_WORKSPACE_ROOT,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          filePath: "references/foo.txt",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "file" });

      const deletedFilePath = path.join(
        runtimeWorkspaceRoot,
        ".xum",
        "skills",
        skillName,
        "references",
        "foo.txt"
      );
      const deletedFileStatErr = await fs
        .stat(deletedFilePath)
        .catch((error: NodeJS.ErrnoException) => error);
      expect(deletedFileStatErr).toMatchObject({ code: "ENOENT" });

      const skillStat = await fs.stat(
        path.join(runtimeWorkspaceRoot, ".xum", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("rejects delete when .xum is symlinked outside workspace in split-root runtime context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-runtime-symlink-escape");
      using externalDir = new TestTempDir(
        "test-agent-skill-delete-split-root-runtime-symlink-target"
      );
      const skillName = "demo-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const externalXumDir = externalDir.path;
      const externalSkillDir = path.join(externalXumDir, "skills", skillName);
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: fixture\n---\nBody\n`,
        "utf-8"
      );

      await fs.symlink(
        externalXumDir,
        path.join(tempDir.path, ".xum"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          target: "skill",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/outside workspace root|escape|symlink/i);
      }

      const externalSkillStillExists = await fs
        .stat(path.join(externalSkillDir, "SKILL.md"))
        .then((stat) => stat.isFile())
        .catch(() => false);
      expect(externalSkillStillExists).toBe(true);
    });
  });

  it("deletes a specific file within a skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-file");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"));
    expect(skillStat.isFile()).toBe(true);
  });

  it("deletes an entire skill directory when target is 'skill'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-skill-dir");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });

  it("requires filePath when target is 'file'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-filepath-required");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({
      success: false,
      error: "filePath is required when target is 'file'",
    });
  });

  it("rejects deletes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-root");
    const previousXumRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        "utf-8"
      );

      const xumDir = path.join(tempDir.path, ".xum");
      await fs.mkdir(xumDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(xumDir, "skills"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: path.join(xumDir, "sessions", GLOBAL_WORKSPACE_ID),
        xumScope: {
          type: "global",
          xumHome: xumDir,
        },
      });

      const tool = createAgentSkillDeleteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          target: "skill",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link|outside containment root/i);
      }

      const externalStillExists = await fs
        .stat(externalSkillDir)
        .then(() => true)
        .catch(() => false);
      expect(externalStillExists).toBe(true);
    } finally {
      restoreXumRoot(previousXumRoot);
    }
  });

  it("refuses to delete a symlinked skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlink-skill");

    const realSkillDir = path.join(tempDir.path, "real-skill-dir");
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(realSkillDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const skillLinkStat = await fs.lstat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillLinkStat.isSymbolicLink()).toBe(true);
  });

  it("refuses to delete a file when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-dir-file");

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: fixture\n---\nBody\n",
      "utf-8"
    );

    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });

  it("refuses to delete a file via symlinked intermediate path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-intermediate-symlink");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, "secret.txt"), "important", "utf-8");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.rm(path.join(skillDir, "references"), { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/secret.txt", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "secret.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-internal-alias-symlink");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = await fs.readFile(skillPath, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        filePath: "link.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-delete-invalid-path");

      await writeSkillWithReference(tempDir.path, "demo-skill");

      const tool = await createDeleteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("returns a clear error when the skill does not exist", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "missing-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Skill not found: missing-skill");
    }
  });

  it("returns a clear not-found error when global xum home is missing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-global-xum-home");

    const missingXumHome = path.join(tempDir.path, "missing-xum-home");
    const tool = createAgentSkillDeleteTool(
      createTestToolConfig(tempDir.path, {
        xumScope: {
          type: "global",
          xumHome: missingXumHome,
        },
      })
    );

    const result = (await tool.execute!(
      { name: "missing-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toEqual({
      success: false,
      error: "Skill not found: missing-skill",
    });
  });

  it("returns explicit not-found when deleting a file that does not exist within an existing skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-file");

    await writeSkillWithReference(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "nonexistent.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("File not found in skill 'demo-skill': nonexistent.txt");
    }
  });

  it("rejects project deletes when .xum is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-project-xum-symlink");

    const projectRoot = path.join(tempDir.path, "project");
    await fs.mkdir(projectRoot, { recursive: true });

    // Create external directory with skill content
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(path.join(externalDir, "skills", "demo-skill"), { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: external\n---\nBody\n",
      "utf-8"
    );

    // Symlink .xum to external
    await fs.symlink(externalDir, path.join(projectRoot, ".xum"));

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outside (?:containment|workspace) root|symbolic link/i);
    }

    // Verify external content is still intact
    const stat = await fs.stat(path.join(externalDir, "skills", "demo-skill", "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("refinement journal", () => {
  function sessionDirOf(muxHome: string): string {
    return path.join(muxHome, "sessions", GLOBAL_WORKSPACE_ID);
  }

  /** Bytes that cannot round-trip through UTF-8 (0xff/0xfe are never valid). */
  const BINARY_BYTES = Buffer.from([0xff, 0xfe, 0x00, 0x01]);

  it("journals a file delete with a restore inverse that round-trips", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-file");

    await writeSkillWithReference(tempDir.path, "demo-skill");
    const referencePath = path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt");
    const original = await fs.readFile(referencePath, "utf-8");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/foo.txt", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result).toMatchObject({ success: true, deleted: "file" });

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(1);
    expect(events[0].data.kind).toBe("skill");
    expect(SkillRefinementActionSchema.parse(events[0].data.action)).toEqual({
      op: "delete-file",
      skillName: "demo-skill",
      filePath: "references/foo.txt",
    });
    const evidence = RefinementEvidenceSchema.parse(events[0].data.evidence);
    expect(evidence.toolName).toBe("agent_skill_delete");
    expect(evidence.toolCallId).toBe("test-call-id");

    await applyRefinementInverse(sessionDirOf(tempDir.path), events[0].data.inverse);
    expect(await fs.readFile(referencePath, "utf-8")).toBe(original);
  });

  it("restores BOTH manifests when rolling back a canonical SKILL.md delete", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-legacy-manifest");

    // Deleting the canonical SKILL.md also rm's the legacy .mux manifest, so
    // the inverse must capture BOTH: restoring only the canonical file would
    // leave the legacy manifest missing after rollback (upgrade↔downgrade).
    const projectRoot = path.join(tempDir.path, "project");
    await writeSkill(path.join(projectRoot, ".xum", "skills"), "demo-skill", {
      body: "Canonical body",
    });
    await writeSkill(path.join(projectRoot, ".mux", "skills"), "demo-skill", {
      body: "Legacy body",
    });
    const canonicalManifest = path.join(
      projectRoot,
      ".xum",
      "skills",
      "demo-skill",
      SKILL_FILENAME
    );
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo-skill", SKILL_FILENAME);
    const originalCanonical = await fs.readFile(canonicalManifest, "utf-8");
    const originalLegacy = await fs.readFile(legacyManifest, "utf-8");

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(canonicalManifest)).rejects.toThrow();
    expect(fs.stat(legacyManifest)).rejects.toThrow();

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(1);
    await applyRefinementInverse(sessionDirOf(tempDir.path), events[0].data.inverse);
    expect(await fs.readFile(canonicalManifest, "utf-8")).toBe(originalCanonical);
    expect(await fs.readFile(legacyManifest, "utf-8")).toBe(originalLegacy);
  });

  it("skips journaling a SKILL.md delete when the legacy manifest cannot be captured", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-legacy-binary");

    // A binary legacy manifest cannot enter a lossless text inverse; a
    // canonical-only inverse would be PARTIAL (rollback would resurrect the
    // canonical file but not the legacy manifest), so journaling is skipped
    // entirely while the delete still removes both files.
    const projectRoot = path.join(tempDir.path, "project");
    await writeSkill(path.join(projectRoot, ".xum", "skills"), "demo-skill");
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo-skill", SKILL_FILENAME);
    await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
    await fs.writeFile(legacyManifest, BINARY_BYTES);

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(legacyManifest)).rejects.toThrow();
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("journals a whole-skill delete with an inverse restoring every file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-skill");

    // Include a nested file and an over-inline-cap file (blob-backed inverse).
    const bigContent = "x".repeat(5000);
    await writeGlobalSkill(tempDir.path, "demo-skill", {
      description: "fixture",
      files: { "references/foo.txt": "fixture", "references/big.txt": bigContent },
    });
    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    const originalSkillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(1);
    expect(SkillRefinementActionSchema.parse(events[0].data.action)).toEqual({
      op: "delete-skill",
      skillName: "demo-skill",
    });
    const inverse = RefinementInverseSchema.parse(events[0].data.inverse);
    expect(inverse.op).toBe("restore-files");
    if (inverse.op === "restore-files") {
      expect(inverse.files).toHaveLength(3);
    }

    const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });

    await applyRefinementInverse(sessionDirOf(tempDir.path), events[0].data.inverse);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe(originalSkillMd);
    expect(await fs.readFile(path.join(skillDir, "references", "foo.txt"), "utf-8")).toBe(
      "fixture"
    );
    expect(await fs.readFile(path.join(skillDir, "references", "big.txt"), "utf-8")).toBe(
      bigContent
    );
  });

  it("skips journaling when a skill file exceeds the per-file capture budget", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-budget-file");

    // Repo-controlled skill content: an attacker-sized file must not be
    // buffered into memory or duplicated into journal blobs.
    await writeGlobalSkill(tempDir.path, "demo-skill", {
      description: "fixture",
      files: { "references/huge.txt": "x".repeat(REFINEMENT_CAPTURE_MAX_FILE_BYTES + 1) },
    });
    const skillDir = path.join(tempDir.path, "skills", "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    // The delete itself must still succeed; only journaling is skipped.
    expect(result).toMatchObject({ success: true, deleted: "skill" });
    const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling when the skill exceeds the capture file-count budget", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-budget-count");

    // SKILL.md + REFINEMENT_CAPTURE_MAX_FILES references = one over budget.
    await writeGlobalSkill(tempDir.path, "demo-skill", {
      description: "fixture",
      files: Object.fromEntries(
        Array.from({ length: REFINEMENT_CAPTURE_MAX_FILES }, (_, i) => [
          `references/f${i}.txt`,
          "x",
        ])
      ),
    });

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  /** Both project skill dirs for one over-combined-budget delete (Finding: per-dir budgets). */
  async function writeCombinedBudgetProjectSkill(
    projectRoot: string,
    perDirFiles: Record<string, string>
  ): Promise<void> {
    await writeSkill(path.join(projectRoot, ".xum", "skills"), "demo-skill", {
      files: perDirFiles,
    });
    await writeSkill(path.join(projectRoot, ".mux", "skills"), "demo-skill", {
      files: perDirFiles,
    });
  }

  /** Delete + assert: both dirs removed, journaling skipped (combined budget). */
  async function expectCombinedBudgetSkip(xumHome: string, projectRoot: string): Promise<void> {
    const tool = await createDeleteTool(xumHome, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    // The delete still removes both dirs; only journaling is skipped.
    expect(result).toMatchObject({ success: true, deleted: "skill" });
    for (const root of [".xum", ".mux"]) {
      const statErr = await fs
        .stat(path.join(projectRoot, root, "skills", "demo-skill"))
        .catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    }
    expect(await readRefinementEvents(sessionDirOf(xumHome))).toHaveLength(0);
  }

  it("shares the capture file-count budget across canonical and legacy dirs", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-combined-count");

    // Each dir is individually under the cap (SKILL.md + MAX/2 references),
    // but one delete captures BOTH dirs into a single journaled inverse:
    // per-dir counters would journal ~2x REFINEMENT_CAPTURE_MAX_FILES.
    const projectRoot = path.join(tempDir.path, "my-project");
    await writeCombinedBudgetProjectSkill(
      projectRoot,
      Object.fromEntries(
        Array.from({ length: Math.ceil(REFINEMENT_CAPTURE_MAX_FILES / 2) }, (_, i) => [
          `references/f${i}.txt`,
          "x",
        ])
      )
    );
    await expectCombinedBudgetSkip(tempDir.path, projectRoot);
  });

  it("shares the capture byte budget across canonical and legacy dirs", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-combined-bytes");

    // Each dir stays under REFINEMENT_CAPTURE_MAX_TOTAL_BYTES on its own but
    // the combined capture would buffer/journal well past the total-byte cap.
    const projectRoot = path.join(tempDir.path, "my-project");
    const chunk = "x".repeat(REFINEMENT_CAPTURE_MAX_FILE_BYTES);
    await writeCombinedBudgetProjectSkill(projectRoot, {
      "references/a.txt": chunk,
      "references/b.txt": chunk,
      "references/c.txt": chunk,
    });
    await expectCombinedBudgetSkip(tempDir.path, projectRoot);
  });

  /** Runtime-backed delete tool over a project skill (shared by budget/lossless tests). */
  async function createRuntimeDeleteContext(tempDirPath: string, skillName: string) {
    const remoteWorkspaceRoot = "/remote/workspace";
    const remoteRuntime = new RemotePathMappedRuntime(tempDirPath, remoteWorkspaceRoot);
    const sessionsDir = path.join(tempDirPath, "session-dir");
    await fs.mkdir(sessionsDir, { recursive: true });
    const baseConfig = createTestToolConfig(tempDirPath, {
      workspaceId: "regular-workspace",
      sessionsDir,
      runtime: remoteRuntime,
      xumScope: {
        type: "project",
        xumHome: tempDirPath,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      },
    });
    const tool = createAgentSkillDeleteTool({ ...baseConfig, cwd: remoteWorkspaceRoot });
    const deleteSkill = async () =>
      (await tool.execute!(
        { name: skillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;
    return { sessionsDir, deleteSkill };
  }

  it("skips journaling when a skill file is not valid UTF-8 (binary)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-binary");

    await writeSkillWithReference(tempDir.path, "demo-skill");
    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    // Invalid UTF-8: a text capture would replace bytes with U+FFFD and a
    // rollback would restore the corrupted content.
    await fs.writeFile(path.join(skillDir, "references", "asset.bin"), BINARY_BYTES);

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling a single-file delete of a binary file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-binary-file");

    await writeSkillWithReference(tempDir.path, "demo-skill");
    const binPath = path.join(tempDir.path, "skills", "demo-skill", "references", "asset.bin");
    await fs.writeFile(binPath, BINARY_BYTES);

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/asset.bin", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling when the skill contains a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-symlink");

    await writeSkillWithReference(tempDir.path, "demo-skill");
    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    // A files-only inverse cannot restore the link entry; restoring its
    // target's content as a regular file would silently change the skill.
    await fs.symlink("SKILL.md", path.join(skillDir, "alias.md"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling when the skill contains an empty directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-emptydir");

    await writeSkillWithReference(tempDir.path, "demo-skill");
    await fs.mkdir(path.join(tempDir.path, "skills", "demo-skill", "empty"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling binary skill files on the runtime-backed path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-binary-runtime");
    await writeProjectSkill(tempDir.path, "my-skill", { description: "fixture" });
    await fs.writeFile(
      path.join(tempDir.path, ".xum", "skills", "my-skill", "asset.bin"),
      BINARY_BYTES
    );

    const ctx = await createRuntimeDeleteContext(tempDir.path, "my-skill");
    expect(await ctx.deleteSkill()).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(ctx.sessionsDir)).toHaveLength(0);
  });

  it("skips journaling symlinked entries on the runtime-backed path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-symlink-runtime");
    await writeProjectSkill(tempDir.path, "my-skill", { description: "fixture" });
    const skillDir = path.join(tempDir.path, ".xum", "skills", "my-skill");
    await fs.symlink("SKILL.md", path.join(skillDir, "alias.md"));

    const ctx = await createRuntimeDeleteContext(tempDir.path, "my-skill");
    expect(await ctx.deleteSkill()).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(ctx.sessionsDir)).toHaveLength(0);
  });

  it("skips journaling when the runtime listing exceeds the file cap", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-count-runtime");
    // SKILL.md + REFINEMENT_CAPTURE_MAX_FILES references = one over the cap;
    // the bounded find listing must bail before any file is read.
    await writeProjectSkill(tempDir.path, "my-skill", {
      description: "fixture",
      files: Object.fromEntries(
        Array.from({ length: REFINEMENT_CAPTURE_MAX_FILES }, (_, i) => [
          `references/f${i}.txt`,
          "x",
        ])
      ),
    });

    const ctx = await createRuntimeDeleteContext(tempDir.path, "my-skill");
    expect(await ctx.deleteSkill()).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(ctx.sessionsDir)).toHaveLength(0);
  });

  it("skips journaling oversized skills on the runtime-backed path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-budget-runtime");
    const skillName = "my-skill";
    const remoteWorkspaceRoot = "/remote/workspace";

    await writeProjectSkill(tempDir.path, skillName, {
      description: "fixture",
      files: { "references/huge.txt": "x".repeat(REFINEMENT_CAPTURE_MAX_FILE_BYTES + 1) },
    });

    const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
    const sessionsDir = path.join(tempDir.path, "session-dir");
    await fs.mkdir(sessionsDir, { recursive: true });
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      sessionsDir,
      runtime: remoteRuntime,
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      },
    });
    const config = { ...baseConfig, cwd: remoteWorkspaceRoot };

    const tool = createAgentSkillDeleteTool(config);
    const result = (await tool.execute!(
      { name: skillName, target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(await readRefinementEvents(sessionsDir)).toHaveLength(0);
  });

  it("writes no row when the delete fails", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-missing");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "missing-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result.success).toBe(false);

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(0);
  });

  it("captures runtime-path skill deletes in the journal", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-refinement-runtime");
    const skillName = "my-skill";
    const remoteWorkspaceRoot = "/remote/workspace";

    await writeSkillWithReference(path.join(tempDir.path, ".mux"), skillName);
    const originalSkillMd = await fs.readFile(
      path.join(tempDir.path, ".mux", "skills", skillName, "SKILL.md"),
      "utf-8"
    );

    const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
    const sessionsDir = path.join(tempDir.path, "session-dir");
    await fs.mkdir(sessionsDir, { recursive: true });
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      sessionsDir,
      runtime: remoteRuntime,
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      },
    });
    const config = { ...baseConfig, cwd: remoteWorkspaceRoot };

    const tool = createAgentSkillDeleteTool(config);
    const result = (await tool.execute!(
      { name: skillName, target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;
    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const events = await readRefinementEvents(sessionsDir);
    expect(events).toHaveLength(1);
    // Runtime-namespace paths are not host-addressable: the row must be
    // stamped remote so rollback refuses it instead of touching local paths.
    expect(events[0].data.runtime).toBe("remote");
    const inverse = RefinementInverseSchema.parse(events[0].data.inverse);
    expect(inverse.op).toBe("restore-files");
    if (inverse.op === "restore-files") {
      // Paths are runtime-namespace; contents were captured through the
      // runtime. Captures are always blob-offloaded (no inline immunity), so
      // resolve contents through the session blob store — runtime paths are
      // not host-addressable, ruling out the applyRefinementInverse helper.
      const blobs = sharedDurableEventJournal(sessionsDir).blobs;
      const resolveText = async (file: { text?: string; blobRef?: string }) =>
        file.text ?? (file.blobRef ? await blobs.getText(file.blobRef) : undefined);
      const skillMd = inverse.files.find((file) => file.path.endsWith("SKILL.md"));
      expect(skillMd?.path).toBe(`${remoteWorkspaceRoot}/.mux/skills/${skillName}/SKILL.md`);
      expect(skillMd && (await resolveText(skillMd))).toBe(originalSkillMd);
      const reference = inverse.files.find((file) => file.path.endsWith("foo.txt"));
      expect(reference && (await resolveText(reference))).toBe("fixture");
    }
  });
});
