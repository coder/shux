import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { XumToolScope } from "@/common/types/toolScope";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import type { AgentSkillReadToolResult, AgentSkillWriteToolResult } from "@/common/types/tools";
import {
  REFINEMENT_CAPTURE_MAX_FILE_BYTES,
  RefinementEvidenceSchema,
  RefinementInverseSchema,
  SkillRefinementActionSchema,
} from "@/common/types/refinement";
import {
  applyRefinementInverse,
  readRefinementEvents,
  seedForeignTargetLock,
} from "@/node/services/refinement/refinementTestHelpers";
import { createAgentSkillReadTool } from "./agent_skill_read";
import {
  createAgentSkillWriteTool,
  createStagedAgentSkillWriteTool,
  hashSkillWriteTargetContent,
} from "./agent_skill_write";
import { SKILL_FILENAME } from "./skillFileUtils";
import {
  createTestToolConfig,
  createWorkspaceSessionDir,
  mockToolCallOptions,
  RemotePathMappedRuntime,
  restoreXumRoot,
  skillMarkdown,
  TEST_GLOBAL_WORKSPACE_ID as GLOBAL_WORKSPACE_ID,
  TestTempDir,
  writeGlobalSkill,
  writeProjectSkill,
  writeSkill,
} from "./testHelpers";

async function createWriteTool(
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

  return createAgentSkillWriteTool(config);
}

describe("agent_skill_write", () => {
  it("creates SKILL.md for a new global skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-create");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill");

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(content);
  });

  it("recreates deleted global xum home before validating skill writes", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-recreate-xum-home");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill", { body: "Recovered body" });

    await fs.rm(tempDir.path, { recursive: true, force: true });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME),
      "utf-8"
    );
    expect(stored).toBe(content);
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-project-scope");

    const projectRoot = path.join(tempDir.path, "my-project");
    await fs.mkdir(path.join(projectRoot, ".xum", "skills"), { recursive: true });

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
    const content = skillMarkdown("demo-skill", { body: "Project scoped" });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const projectSkillPath = path.join(projectRoot, ".xum", "skills", "demo-skill", "SKILL.md");
    const stored = await fs.readFile(projectSkillPath, "utf-8");
    expect(stored).toBe(content);
  });
  it("migrates a legacy project package before writing an auxiliary file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-migration");
    const projectRoot = path.join(tempDir.path, "project");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    const containedStore = path.join(projectRoot, ".skill-store");
    await writeSkill(containedStore, "demo-skill", {
      files: { "references/existing.txt": "existing" },
    });
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.symlink(
      path.join(containedStore, "demo-skill"),
      path.join(legacyRoot, "demo-skill"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    expect(await fs.readFile(path.join(canonicalDir, "references/existing.txt"), "utf-8")).toBe(
      "existing"
    );
    expect(await fs.readFile(path.join(canonicalDir, "references/new.txt"), "utf-8")).toBe("new");
    expect((await fs.lstat(path.join(legacyRoot, "demo-skill"))).isSymbolicLink()).toBe(true);
  });

  it("merges a legacy package into an incomplete canonical package before writing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-partial-canonical");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(path.join(canonicalRoot, "demo-skill", "references"), { recursive: true });
    await fs.writeFile(
      path.join(canonicalRoot, "demo-skill", SKILL_FILENAME),
      "---\nname: wrong-name\ndescription: Invalid canonical manifest\n---\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(canonicalRoot, "demo-skill", "references", "canonical.txt"),
      "canonical",
      "utf-8"
    );
    await writeSkill(legacyRoot, "demo-skill", {
      files: { "references/legacy.txt": "legacy" },
    });

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    const canonicalDir = path.join(canonicalRoot, "demo-skill");
    expect(await fs.readFile(path.join(canonicalDir, SKILL_FILENAME), "utf-8")).toContain(
      "name: demo-skill"
    );
    expect(await fs.readFile(path.join(canonicalDir, "references/canonical.txt"), "utf-8")).toBe(
      "canonical"
    );
    expect(await fs.readFile(path.join(canonicalDir, "references/legacy.txt"), "utf-8")).toBe(
      "legacy"
    );
    expect(await fs.readFile(path.join(canonicalDir, "references/new.txt"), "utf-8")).toBe("new");
  });

  it("does not migrate a legacy package while another process holds the target lock", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-migration-locked");
    const projectRoot = path.join(tempDir.path, "project");
    await writeSkill(path.join(projectRoot, ".mux", "skills"), "demo-skill");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");

    // Deterministic cross-process interleaving: occupy the canonical skills
    // root target lock, as another process's in-flight rollback would.
    // Migration REWRITES the canonical dir, so run outside the lock it could
    // land between the rollback's in-lock verify and its inverse apply.
    const lockPath = await seedForeignTargetLock(
      tempDir.path,
      path.join(projectRoot, ".xum", "skills")
    );

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const blocked = (await tool.execute!(
      { name: "demo-skill", filePath: "references/new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("unreachable");
    expect(blocked.error).toContain("Another process is mutating");
    // Nothing — including the legacy migration — touched the canonical dir.
    const statErr = await fs.stat(canonicalDir).catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });

    // Lock released → the same write migrates and lands.
    await fs.unlink(lockPath);
    const retried = (await tool.execute!(
      { name: "demo-skill", filePath: "references/new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(retried.success).toBe(true);
    expect(await fs.readFile(path.join(canonicalDir, SKILL_FILENAME), "utf-8")).toContain(
      "name: demo-skill"
    );
    expect(await fs.readFile(path.join(canonicalDir, "references/new.txt"), "utf-8")).toBe("new");
  });

  it("lets canonical files replace conflicting legacy node types", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-type-conflicts");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(legacyRoot, "demo-skill", {
      files: { "canonical-file/legacy.txt": "legacy", "canonical-directory": "legacy" },
    });
    await fs.mkdir(path.join(canonicalDir, "canonical-directory"), { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "canonical-file"), "canonical", "utf-8");
    await fs.writeFile(
      path.join(canonicalDir, "canonical-directory", "canonical.txt"),
      "canonical",
      "utf-8"
    );

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(canonicalDir, "canonical-file"), "utf-8")).toBe("canonical");
    expect(
      await fs.readFile(path.join(canonicalDir, "canonical-directory", "canonical.txt"), "utf-8")
    ).toBe("canonical");
  });

  it("does not follow legacy symlinks while overlaying canonical files", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-overlay-symlink");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyDir = path.join(projectRoot, ".mux", "skills", "demo-skill");
    const externalFile = path.join(tempDir.path, "external.txt");
    await writeSkill(path.dirname(legacyDir), "demo-skill");
    await fs.writeFile(externalFile, "external", "utf-8");
    await fs.symlink(externalFile, path.join(legacyDir, "shared.txt"), "file");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "shared.txt"), "canonical", "utf-8");

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(externalFile, "utf-8")).toBe("external");
    expect((await fs.lstat(path.join(canonicalDir, "shared.txt"))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(canonicalDir, "shared.txt"), "utf-8")).toBe("canonical");
  });

  it("repairs a dangling canonical package symlink from the legacy fallback", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-dangling-canonical");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const canonicalDir = path.join(canonicalRoot, "demo-skill");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(canonicalRoot, { recursive: true });
    await fs.symlink(path.join(projectRoot, "missing-skill"), canonicalDir, "dir");
    await writeSkill(legacyRoot, "demo-skill");

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect((await fs.lstat(canonicalDir)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(canonicalDir, SKILL_FILENAME), "utf-8")).toContain(
      "name: demo-skill"
    );
  });

  it("drops invalid canonical manifest casing aliases during migration", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-manifest-casing-alias");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "skill.md"), "invalid", "utf-8");
    await writeSkill(legacyRoot, "demo-skill");

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(canonicalDir, SKILL_FILENAME), "utf-8")).toContain(
      "name: demo-skill"
    );
  });

  it("preserves canonical metadata when the legacy manifest is invalid", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-invalid-legacy-manifest");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyDir = path.join(projectRoot, ".mux", "skills", "demo-skill");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, SKILL_FILENAME), "canonical-invalid", "utf-8");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, SKILL_FILENAME), "legacy-invalid", "utf-8");

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(canonicalDir, SKILL_FILENAME), "utf-8")).toBe(
      "canonical-invalid"
    );
    expect(await fs.readFile(path.join(legacyDir, SKILL_FILENAME), "utf-8")).toBe("legacy-invalid");
  });

  it("rebases relative links from a symlinked legacy package", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-relative-link-migration");
    const projectRoot = path.join(tempDir.path, "project");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    const sourceRoot = path.join(projectRoot, ".skill-store");
    const sourceDir = path.join(sourceRoot, "demo-skill");
    await writeSkill(sourceRoot, "demo-skill");
    await fs.rename(path.join(sourceDir, SKILL_FILENAME), path.join(sourceDir, "manifest.md"));
    await fs.symlink("manifest.md", path.join(sourceDir, SKILL_FILENAME), "file");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.symlink(sourceDir, path.join(legacyRoot, "demo-skill"), "dir");

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "new.txt", content: "new" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    const canonicalManifest = path.join(
      projectRoot,
      ".xum",
      "skills",
      "demo-skill",
      SKILL_FILENAME
    );
    expect((await fs.lstat(canonicalManifest)).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(await fs.readlink(canonicalManifest))).toBe(true);
    expect(await fs.readFile(canonicalManifest, "utf-8")).toContain("name: demo-skill");
  });

  it("removes partial canonical copies when legacy migration fails", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-atomic");
    const projectRoot = path.join(tempDir.path, "project");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(legacyRoot, "demo-skill");

    const fakeBin = path.join(tempDir.path, "bin");
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, "cp"),
      '#!/bin/sh\nmkdir -p "$3"\nprintf partial > "$3/partial"\nexit 1\n',
      { mode: 0o755 }
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    try {
      const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      });
      const result = (await tool.execute!(
        { name: "demo-skill", filePath: "references/new.txt", content: "new" },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;
      expect(result.success).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }

    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    expect(await fs.readdir(canonicalRoot)).toEqual([]);
    expect(
      await fs.readFile(path.join(legacyRoot, "demo-skill", SKILL_FILENAME), "utf-8")
    ).toContain("name: demo-skill");
  });

  it("rejects a symlink returned as the migration temp directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-temp-symlink");
    const projectRoot = path.join(tempDir.path, "project");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(legacyRoot, "demo-skill");
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(externalDir);

    const fakeBin = path.join(tempDir.path, "bin");
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, "mktemp"),
      `#!/bin/sh\ntmp="\${2%XXXXXX}AAAAAA"\nln -s '${externalDir}' "$tmp"\nprintf '%s\\n' "$tmp"\n`,
      { mode: 0o755 }
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    try {
      const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      });
      const result = (await tool.execute!(
        { name: "demo-skill", filePath: "references/new.txt", content: "new" },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;
      expect(result.success).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(await fs.readdir(externalDir)).toEqual([]);
    expect(
      await fs.readFile(path.join(legacyRoot, "demo-skill", SKILL_FILENAME), "utf-8")
    ).toContain("name: demo-skill");
  });

  it("rejects a symlink returned as the migration backup directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-legacy-backup-symlink");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "canonical.txt"), "canonical", "utf-8");
    await writeSkill(legacyRoot, "demo-skill");
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(externalDir);

    const fakeBin = path.join(tempDir.path, "bin");
    const counterPath = path.join(tempDir.path, "mktemp-count");
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, "mktemp"),
      `#!/bin/sh
count=0
[ ! -f '${counterPath}' ] || count=$(cat '${counterPath}')
count=$((count + 1))
printf '%s' "$count" > '${counterPath}'
tmp="\${2%XXXXXX}$count$count$count$count$count$count"
if [ "$count" -eq 1 ]; then mkdir "$tmp"; else ln -s '${externalDir}' "$tmp"; fi
printf '%s\\n' "$tmp"
`,
      { mode: 0o755 }
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    try {
      const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      });
      const result = (await tool.execute!(
        { name: "demo-skill", filePath: "references/new.txt", content: "new" },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;
      expect(result.success).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(await fs.readFile(path.join(canonicalDir, "canonical.txt"), "utf-8")).toBe("canonical");
    expect(fs.stat(path.join(canonicalDir, SKILL_FILENAME))).rejects.toThrow();
    expect(await fs.readdir(externalDir)).toEqual([]);
  });

  describe("split-root (project-runtime)", () => {
    it("writes project skill via runtime APIs in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-split-root-project-runtime");
      const skillName = "split-root-runtime-write-skill";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Body from split-root runtime" });

      const writeResult = (await writeTool.execute!(
        { name: skillName, content },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;
      expect(writeResult.success).toBe(true);

      const localSkillFile = path.join(tempDir.path, ".xum", "skills", skillName, "SKILL.md");
      const stored = await fs.readFile(localSkillFile, "utf-8");
      expect(stored).toBe(content);

      const readTool = createAgentSkillReadTool(config);
      const readResult = (await readTool.execute!(
        { name: skillName },
        mockToolCallOptions
      )) as AgentSkillReadToolResult;

      expect(readResult.success).toBe(true);
      if (readResult.success) {
        expect(readResult.skill.body).toContain("Body from split-root runtime");
      }
    });

    it("rejects write when .xum is symlinked outside workspace in split-root runtime context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-split-root-runtime-symlink-escape");
      using externalDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-symlink-target"
      );
      const skillName = "split-root-runtime-write-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const externalXumDir = externalDir.path;
      await fs.mkdir(path.join(externalXumDir, "skills"), { recursive: true });
      await fs.symlink(
        externalXumDir,
        path.join(tempDir.path, ".xum"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Body from split-root runtime" });

      const writeResult = (await writeTool.execute!(
        { name: skillName, content },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(false);
      if (!writeResult.success) {
        expect(writeResult.error).toMatch(/outside workspace root|escape|symlink/i);
      }

      const externalSkillFile = path.join(externalXumDir, "skills", skillName, "SKILL.md");
      const externalSkillExists = await fs
        .stat(externalSkillFile)
        .then(() => true)
        .catch(() => false);
      expect(externalSkillExists).toBe(false);

      const externalSkillEntries = await fs.readdir(path.join(externalXumDir, "skills"));
      expect(externalSkillEntries).toEqual([]);
    });

    it("rejects write via casing-variant filePath when canonical SKILL.md is a symlink", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-case-variant-symlink"
      );
      const skillName = "split-root-runtime-case-variant-symlink";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const localSkillDir = path.join(tempDir.path, ".xum", "skills", skillName);
      await fs.mkdir(localSkillDir, { recursive: true });

      const symlinkTargetPath = path.join(tempDir.path, "outside-skill-target.md");
      const symlinkTargetContent = "outside target should remain unchanged\n";
      await fs.writeFile(symlinkTargetPath, symlinkTargetContent, "utf-8");
      await fs.symlink(
        symlinkTargetPath,
        path.join(localSkillDir, SKILL_FILENAME),
        process.platform === "win32" ? "file" : undefined
      );

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Attempted overwrite" });

      const writeResult = (await writeTool.execute!(
        {
          name: skillName,
          filePath: "skill.md",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(false);
      if (!writeResult.success) {
        expect(writeResult.error).toMatch(/symbolic link|symlink/i);
      }

      const storedTarget = await fs.readFile(symlinkTargetPath, "utf-8");
      expect(storedTarget).toBe(symlinkTargetContent);
    });

    it("writes correctly via casing-variant filePath when SKILL.md does not exist", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-case-variant-create"
      );
      const skillName = "split-root-runtime-case-variant-create";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: XumToolScope = {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Created through lowercase path" });

      const writeResult = (await writeTool.execute!(
        {
          name: skillName,
          filePath: "skill.md",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(true);

      const canonicalSkillPath = path.join(
        tempDir.path,
        ".xum",
        "skills",
        skillName,
        SKILL_FILENAME
      );
      const stored = await fs.readFile(canonicalSkillPath, "utf-8");
      expect(stored).toBe(content);
    });
  });

  it("updates SKILL.md and returns ui_only diff payload", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-update");

    const tool = await createWriteTool(tempDir.path);

    const initialContent = skillMarkdown("demo-skill", { body: "Body" });
    const initialResult = (await tool.execute!(
      { name: "demo-skill", content: initialContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(initialResult.success).toBe(true);

    const updatedContent = skillMarkdown("demo-skill", { body: "Updated body" });
    const updateResult = (await tool.execute!(
      { name: "demo-skill", content: updatedContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(updateResult.ui_only?.file_edit?.diff).toContain("SKILL.md");
      expect(updateResult.ui_only?.file_edit?.diff).toContain("Updated body");
    }

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(updatedContent);
  });

  it("rejects invalid SKILL.md frontmatter", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-invalid-frontmatter");

    const tool = await createWriteTool(tempDir.path);

    const result = (await tool.execute!(
      { name: "demo-skill", content: "not-frontmatter" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/frontmatter/i);
    }
  });

  describe("SKILL.md casing canonicalization", () => {
    it("validates SKILL.md content even with lowercase filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-lowercase-skillmd");

      const tool = await createWriteTool(tempDir.path);

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "skill.md",
          content: "not-frontmatter",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/frontmatter/i);
      }
    });

    it("injects frontmatter name for case-variant filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-case-variant-name-injection");

      const tool = await createWriteTool(tempDir.path);
      const contentWithMismatchedName = skillMarkdown("wrong-name", {
        description: "description for demo-skill",
      });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "Skill.md",
          content: contentWithMismatchedName,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const stored = await fs.readFile(
        path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME),
        "utf-8"
      );
      expect(stored).toContain("name: demo-skill");
      expect(stored).not.toContain("name: wrong-name");
    });

    it("writes to canonical SKILL.md path regardless of input casing", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-canonical-skillmd-path");

      const tool = await createWriteTool(tempDir.path);
      const content = skillMarkdown("demo-skill", { body: "Canonical body" });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "SKILL.MD",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const canonicalPath = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
      const stored = await fs.readFile(canonicalPath, "utf-8");
      expect(stored).toBe(content);
    });
  });

  it("name-mismatch injection preserves all other formatting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-mismatch");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      'name  : "Holistic Design"',
      "description: >-",
      "  Keep this wording exactly as authored.",
      "  Preserve wrapping and punctuation: colon: yes.",
      'compatibility: "xum >= 1.0"',
      "metadata:",
      '  owner: "docs-team"',
      "advertise: false",
      "---",
      "Body line 1",
      "",
      "Body line 3",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "holistic-design",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "holistic-design", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = originalContent.replace(
      'name  : "Holistic Design"',
      "name: holistic-design"
    );
    expect(stored).toBe(expectedContent);

    const originalLines = originalContent.split("\n");
    const storedLines = stored.split("\n");
    const changedLineIndexes = originalLines.flatMap((line, index) =>
      line === storedLines[index] ? [] : [index]
    );

    expect(changedLineIndexes).toEqual([1]);
  });

  it("missing-name insertion preserves existing content", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-missing");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      "description: >-",
      "  Keep this exact text.",
      "  Preserve order and spacing.",
      'compatibility: "xum >= 1.0"',
      "metadata:",
      "  owner: docs-team",
      "---",
      "Body",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = [
      "---",
      "name: demo-skill",
      ...originalContent.split("\n").slice(1),
    ].join("\n");
    expect(stored).toBe(expectedContent);

    const storedLines = stored.split("\n");
    expect(storedLines[1]).toBe("name: demo-skill");
    expect([storedLines[0], ...storedLines.slice(2)]).toEqual(originalContent.split("\n"));
  });

  it("writes reference files within the skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-reference");

    const tool = await createWriteTool(tempDir.path);

    const createResult = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(createResult.success).toBe(true);

    const refResult = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        content: "reference content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(refResult.success).toBe(true);

    const referencePath = path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt");
    const stored = await fs.readFile(referencePath, "utf-8");
    expect(stored).toBe("reference content");
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-write-invalid-path");

      const tool = await createWriteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          content: "text",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("rejects writes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-root");
    const previousXumRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });

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

      const tool = createAgentSkillWriteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          content: "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link|outside containment root/i);
      }

      const externalEntries = await fs.readdir(externalDir);
      expect(externalEntries).toEqual(["evil-skill"]);
    } finally {
      restoreXumRoot(previousXumRoot);
    }
  });

  it("rejects writes when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-dir");

    const tool = await createWriteTool(tempDir.path);

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const result = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes when intermediate subdir is a symlinked escape", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-intermediate-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown("demo-skill"), "utf-8");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/secret.txt",
        content: "should not land here",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes to symlink targets", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const symlinkTarget = path.join(tempDir.path, "external-target.md");
    await fs.writeFile(symlinkTarget, "external", "utf-8");
    await fs.symlink(symlinkTarget, path.join(skillDir, "SKILL.md"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: skillMarkdown("demo-skill"),
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-internal-alias-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = skillMarkdown("demo-skill", { body: "Original body" });
    await fs.writeFile(skillPath, originalContent, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "link.txt",
        content: "new alias content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });

  it("rejects project writes when .xum is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-project-xum-symlink");

    const projectRoot = path.join(tempDir.path, "project");
    await fs.mkdir(projectRoot, { recursive: true });

    const legacySkill = path.join(projectRoot, ".mux", "skills", "demo-skill");
    await writeSkill(path.join(projectRoot, ".mux", "skills"), "demo-skill");

    // Create external directory and symlink .xum to it
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.symlink(externalDir, path.join(projectRoot, ".xum"));

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createWriteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
    const content = skillMarkdown("demo-skill", { body: "Should not land outside project" });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outside (?:containment|workspace) root|symbolic link/i);
    }

    expect(await fs.readFile(path.join(legacySkill, SKILL_FILENAME), "utf-8")).toContain(
      "name: demo-skill"
    );

    // Verify no directories were created in external target
    const externalEntries = await fs.readdir(externalDir);
    expect(externalEntries).toEqual([]);
  });
});

describe("refinement journal", () => {
  function sessionDirOf(muxHome: string): string {
    return path.join(muxHome, "sessions", GLOBAL_WORKSPACE_ID);
  }

  it("refuses a staged write whose target changed after staging, in-lock (r50)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-staged-guard");

    // The refine apply loop's own pre-check is UNLOCKED: a concurrent writer
    // can land between that check and this tool's mutation lock. The tool
    // itself must therefore re-verify the staged fingerprint under the lock,
    // immediately before the full-file overwrite.
    const workspaceSessionDir = await createWorkspaceSessionDir(tempDir.path, GLOBAL_WORKSPACE_ID);
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    });
    const skillFile = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
    const original = skillMarkdown("demo-skill", { body: "Original body" });
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, original, "utf-8");

    // Proposal staged against `original`; target then edited by someone else.
    const staleTool = createStagedAgentSkillWriteTool(
      config,
      new Map([[mockToolCallOptions.toolCallId, hashSkillWriteTargetContent(original)]])
    );
    const newer = skillMarkdown("demo-skill", { body: "Newer manual edit that must survive" });
    await fs.writeFile(skillFile, newer, "utf-8");

    const refused = (await staleTool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill", { body: "Stale proposal" }) },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain("restage");
    }
    // The newer content survives and no refinement row was journaled.
    expect(await fs.readFile(skillFile, "utf-8")).toBe(newer);
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);

    // A fingerprint matching the current content writes normally.
    const freshTool = createStagedAgentSkillWriteTool(
      config,
      new Map([[mockToolCallOptions.toolCallId, hashSkillWriteTargetContent(newer)]])
    );
    const applied = (await freshTool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill", { body: "Applied" }) },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(applied.success).toBe(true);
    expect(await fs.readFile(skillFile, "utf-8")).toContain("Applied");
  });

  it("journals a new-file write with a delete inverse that round-trips", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-create");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill");
    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(result.success).toBe(true);

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(1);
    expect(events[0].data.kind).toBe("skill");
    expect(SkillRefinementActionSchema.parse(events[0].data.action)).toEqual({
      op: "write",
      skillName: "demo-skill",
      filePath: SKILL_FILENAME,
    });
    const evidence = RefinementEvidenceSchema.parse(events[0].data.evidence);
    expect(evidence.toolName).toBe("agent_skill_write");
    expect(evidence.toolCallId).toBe("test-call-id");

    const skillPath = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
    expect(await fs.readFile(skillPath, "utf-8")).toBe(content);
    await applyRefinementInverse(sessionDirOf(tempDir.path), events[0].data.inverse);
    const statErr = await fs.stat(skillPath).catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });

  it("journals an overwrite with a blob-backed restore inverse that round-trips", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-overwrite");

    const tool = await createWriteTool(tempDir.path);
    // Over the inline cap so the inverse must round-trip through the blob store.
    const original = skillMarkdown("demo-skill", { body: "x".repeat(5000) });
    const updated = skillMarkdown("demo-skill", { body: "Updated body" });

    const first = (await tool.execute!(
      { name: "demo-skill", content: original },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(first.success).toBe(true);
    const second = (await tool.execute!(
      { name: "demo-skill", content: updated },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(second.success).toBe(true);

    const events = await readRefinementEvents(sessionDirOf(tempDir.path));
    expect(events).toHaveLength(2);
    const inverse = RefinementInverseSchema.parse(events[1].data.inverse);
    expect(inverse.op).toBe("restore-files");
    if (inverse.op === "restore-files") {
      expect(inverse.files).toHaveLength(1);
      expect(inverse.files[0].text).toBeUndefined();
      expect(inverse.files[0].blobRef).toBeDefined();
    }

    const skillPath = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
    expect(await fs.readFile(skillPath, "utf-8")).toBe(updated);
    await applyRefinementInverse(sessionDirOf(tempDir.path), events[1].data.inverse);
    expect(await fs.readFile(skillPath, "utf-8")).toBe(original);
  });

  it("skips journaling when the prior file exceeds the capture budget", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-budget");

    // Prior file created out-of-band (repo-controlled skill content): its
    // capture would duplicate over-budget bytes into the journal/blob store
    // on every overwrite.
    await writeGlobalSkill(tempDir.path, "demo-skill", {
      description: "fixture",
      files: { "references/big.txt": "x".repeat(REFINEMENT_CAPTURE_MAX_FILE_BYTES + 1) },
    });

    const tool = await createWriteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/big.txt", content: "trimmed\n" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    // The write itself must still succeed; only journaling is skipped.
    expect(result.success).toBe(true);
    const written = path.join(tempDir.path, "skills", "demo-skill", "references", "big.txt");
    expect(await fs.readFile(written, "utf-8")).toBe("trimmed\n");
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling when the prior file is not valid UTF-8 (binary)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-binary");

    await writeGlobalSkill(tempDir.path, "demo-skill", { description: "fixture" });
    const binPath = path.join(tempDir.path, "skills", "demo-skill", "references", "asset.bin");
    await fs.mkdir(path.dirname(binPath), { recursive: true });
    // 0xff/0xfe can never round-trip through utf-8; a captured inverse would
    // restore U+FFFD-corrupted bytes on rollback.
    await fs.writeFile(binPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    const tool = await createWriteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/asset.bin", content: "now text\n" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await readRefinementEvents(sessionDirOf(tempDir.path))).toHaveLength(0);
  });

  it("skips journaling when an existing runtime prior file cannot be read", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-unreadable-runtime");
    const skillName = "my-skill";
    const remoteWorkspaceRoot = "/remote/workspace";

    await writeProjectSkill(tempDir.path, skillName, {
      description: "fixture",
      files: { "references/locked.txt": "precious prior content\n" },
    });

    // The prior file EXISTS (stat succeeds) but reading it fails — e.g. a
    // permission error or transient remote failure. Treating that as "did
    // not exist" would journal a delete-files inverse whose rollback deletes
    // the pre-existing file instead of restoring it.
    class UnreadableFileRuntime extends RemotePathMappedRuntime {
      override readFile(
        filePath: string,
        abortSignal?: AbortSignal
      ): ReturnType<RemotePathMappedRuntime["readFile"]> {
        if (filePath.endsWith("locked.txt")) {
          throw new Error("EACCES: permission denied");
        }
        return super.readFile(filePath, abortSignal);
      }
    }

    const remoteRuntime = new UnreadableFileRuntime(tempDir.path, remoteWorkspaceRoot);
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

    const tool = createAgentSkillWriteTool(config);
    const result = (await tool.execute!(
      { name: skillName, filePath: "references/locked.txt", content: "overwritten\n" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    // The write proceeds; only journaling is skipped (no delete-files row
    // that would destroy the prior file on rollback).
    expect(result.success).toBe(true);
    const written = path.join(
      tempDir.path,
      ".xum",
      "skills",
      skillName,
      "references",
      "locked.txt"
    );
    expect(await fs.readFile(written, "utf-8")).toBe("overwritten\n");
    expect(await readRefinementEvents(sessionsDir)).toHaveLength(0);
  });

  it("skips journaling oversized prior files on the runtime-backed path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-budget-runtime");
    const skillName = "my-skill";
    const remoteWorkspaceRoot = "/remote/workspace";

    await writeProjectSkill(tempDir.path, skillName, {
      description: "fixture",
      files: { "references/big.txt": "x".repeat(REFINEMENT_CAPTURE_MAX_FILE_BYTES + 1) },
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

    const tool = createAgentSkillWriteTool(config);
    const result = (await tool.execute!(
      { name: skillName, filePath: "references/big.txt", content: "trimmed\n" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);
    expect(await readRefinementEvents(sessionsDir)).toHaveLength(0);
  });

  it("does not fail the write when the journal is unavailable", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-refinement-broken-journal");

    // Occupy the session dir path with a FILE so journal appends cannot mkdir.
    const brokenSessionDir = path.join(tempDir.path, "broken-session");
    await fs.writeFile(brokenSessionDir, "not a directory", "utf-8");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "ws-broken",
      sessionsDir: brokenSessionDir,
    });
    const tool = createAgentSkillWriteTool(config);

    const content = skillMarkdown("demo-skill");
    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(result.success).toBe(true);
    expect(
      await fs.readFile(path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME), "utf-8")
    ).toBe(content);
  });
});
