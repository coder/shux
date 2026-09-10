import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";
import { backupCachePath } from "./gitRepo";
import { BackupService } from "./backupService";
import { REDACTED_BACKUP_VALUE } from "./payload";
import { ProjectService } from "@/node/services/projectService";
import { projectMemoryDirName } from "@/node/services/memoryService";
import { runGit, writeFixtureFile } from "./testHelpers";

const SECRET_FILES = [
  "providers.jsonc",
  "secrets.json",
  "mcp-oauth.json",
  "server.lock",
  "serverAuthSessions.json",
];
const DECOY = "DECOY_SECRET_MUST_NOT_LEAK";

/**
 * Exercises the service against a real bare repository and a real MUX_ROOT, so the
 * secret-exclusion invariant is asserted on bytes that actually reached a remote.
 */
describe("BackupService against a real repository", () => {
  let tempDir: string;
  let muxRoot: string;
  let originPath: string;
  let config: Config;
  let service: BackupService;
  let settings: SettingsBackupInput;

  function createService(): BackupService {
    return new BackupService(config, {
      gitRepo: createBackupGitRepo({ cacheRoot: path.join(muxRoot, "backup-cache") }),
      payload: createBackupPayloadStore({ config }),
    });
  }

  async function pushOrThrow(target: BackupService = service) {
    const pushed = await target.push(settings);
    if (!pushed.success) throw new Error(pushed.error.message);
    return pushed;
  }

  async function cloneOrigin(name: string): Promise<string> {
    const target = path.join(tempDir, name);
    await runGit(["clone", "--quiet", originPath, target]);
    return target;
  }

  async function listFiles(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter((file) => !file.startsWith(".git/"))
      .sort();
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-e2e-"));
    muxRoot = path.join(tempDir, "mux-root");
    originPath = path.join(tempDir, "origin.git");
    await fs.mkdir(muxRoot, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "mux" };
    config = new Config(muxRoot);
    service = createService();

    await writeFixtureFile(muxRoot, "AGENTS.md", "global instructions\n");
    await writeFixtureFile(muxRoot, "agents/reviewer.md", "reviewer agent\n");
    await writeFixtureFile(muxRoot, "skills/demo/SKILL.md", "demo skill\n");
    await writeFixtureFile(muxRoot, "memory/global/note.md", "remembered fact\n");
    await writeFixtureFile(
      muxRoot,
      "mcp.jsonc",
      `{
  // Deploy token: comment-secret-abc123
  "servers": {
    "literal": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer abc123" }
    },
    "referenced": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": { "secret": "MCP_TOKEN" } }
    }
  }
}
`
    );
    for (const secretFile of SECRET_FILES) {
      await writeFixtureFile(muxRoot, secretFile, `${DECOY}\n`);
    }
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("pushes the portable payload and leaks no secret file", async () => {
    const pushed = await pushOrThrow();
    expect(pushed.success).toBe(true);

    const clone = await cloneOrigin("verify");
    const files = await listFiles(clone);
    expect(files).toEqual([
      "mux/AGENTS.md",
      "mux/agents/reviewer.md",
      "mux/manifest.json",
      "mux/mcp.jsonc",
      "mux/memory/global/note.md",
      "mux/preferences.json",
      "mux/skills/demo/SKILL.md",
    ]);

    const contents = await Promise.all(
      files.map((file) => fs.readFile(path.join(clone, file), "utf-8"))
    );
    expect(contents.join("\n")).not.toContain(DECOY);
    for (const secretFile of SECRET_FILES) {
      expect(files.some((file) => path.posix.basename(file) === secretFile)).toBe(false);
    }
  });

  it("keeps MCP URLs while redacting a literal header value", async () => {
    const pushed = await pushOrThrow();
    expect(pushed.data.redactions.length).toBeGreaterThan(0);

    const clone = await cloneOrigin("verify");
    const mcp = await fs.readFile(path.join(clone, "mux/mcp.jsonc"), "utf-8");
    expect(mcp).not.toContain("Bearer abc123");
    expect(mcp).toContain(REDACTED_BACKUP_VALUE);
    expect(mcp).toContain('"url": "https://example.com/mcp"');
    expect(mcp).toContain('"secret": "MCP_TOKEN"');
    // A comment is prose no projection can inspect, so it is not published at all.
    expect(mcp).not.toContain("comment-secret-abc123");
  });

  it("does not create a second commit when nothing changed", async () => {
    await pushOrThrow();
    const commitsAfterFirst = await runGit([
      "--git-dir",
      originPath,
      "rev-list",
      "--count",
      "main",
    ]);

    const second = await pushOrThrow();
    expect(second.data.changed).toBe(false);
    expect(await runGit(["--git-dir", originPath, "rev-list", "--count", "main"])).toBe(
      commitsAfterFirst
    );
  });

  it("blocks a push when a backed-up file contains a token, and proceeds once allowed", async () => {
    await writeFixtureFile(
      muxRoot,
      "AGENTS.md",
      "token ghp_123456789012345678901234567890123456\n"
    );

    const blocked = await service.push(settings);
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("Expected the secret scan to block the push");
    expect(blocked.error.code).toBe("SECRET_DETECTED");
    expect(blocked.error.files).toContain("AGENTS.md");
    expect(await runGit(["--git-dir", originPath, "rev-list", "--count", "--all"])).toBe("0");

    const allowed = await service.push(settings, {
      approvedSecretDigest: blocked.error.secretApproval ?? undefined,
    });
    expect(allowed.success).toBe(true);
  });

  it("gates a low-entropy MCP URL credential until the exact payload is approved", async () => {
    const url = "https://user:hunter2@example.com/mcp?api_key=abc123";
    await writeFixtureFile(muxRoot, "mcp.jsonc", JSON.stringify({ servers: { private: { url } } }));

    const blocked = await service.push(settings);
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("Expected the URL credential gate to block the push");
    expect(blocked.error.code).toBe("SECRET_DETECTED");
    expect(blocked.error.files).toEqual(["mcp.jsonc"]);
    expect(await runGit(["--git-dir", originPath, "rev-list", "--count", "--all"])).toBe("0");

    const allowed = await service.push(settings, {
      approvedSecretDigest: blocked.error.secretApproval ?? undefined,
    });
    expect(allowed.success).toBe(true);
    const clone = await cloneOrigin("url-credential-verify");
    expect(await fs.readFile(path.join(clone, "mux/mcp.jsonc"), "utf-8")).toContain(url);
  });

  it("requires exact-payload approval before publishing an MCP command", async () => {
    const command = "npx private-mcp";
    await writeFixtureFile(
      muxRoot,
      "mcp.jsonc",
      JSON.stringify({ servers: { private: { command } } })
    );

    const blocked = await service.push(settings);
    expect(blocked.success).toBe(false);
    if (blocked.success)
      throw new Error("Expected the MCP command approval gate to block the push");
    expect(blocked.error.code).toBe("SECRET_DETECTED");
    expect(blocked.error.files).toEqual(["mcp.jsonc"]);
    expect(await runGit(["--git-dir", originPath, "rev-list", "--count", "--all"])).toBe("0");

    const allowed = await service.push(settings, {
      approvedSecretDigest: blocked.error.secretApproval ?? undefined,
    });
    expect(allowed.success).toBe(true);
    const clone = await cloneOrigin("command-credential-verify");
    expect(await fs.readFile(path.join(clone, "mux/mcp.jsonc"), "utf-8")).toContain(command);
  });

  it("removes a safety snapshot that could not be written", async () => {
    await pushOrThrow();

    const payloadStore = createBackupPayloadStore({ config });
    const failing = new BackupService(config, {
      gitRepo: createBackupGitRepo({ cacheRoot: path.join(muxRoot, "backup-cache") }),
      payload: {
        ...payloadStore,
        writeSafetySnapshot: async (snapshotRoot) => {
          // Half-written, which is the state that matters: an unredacted partial copy.
          await fs.mkdir(snapshotRoot, { recursive: true });
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "partial\n", "utf-8");
          throw new Error("disk full");
        },
      },
    });

    const failed = await failing.restore(settings);

    expect(failed.success).toBe(false);
    const cacheRoot = path.join(muxRoot, "backup-cache");
    const snapshots = (await fs.readdir(cacheRoot).catch(() => [])).filter((entry) =>
      entry.startsWith("restore-")
    );
    expect(snapshots).toEqual([]);
  });

  it("refuses to clone the git cache through a symlinked cache directory", async () => {
    // The cache holds the local payload, including files still awaiting the user's approval.
    const outside = path.join(tempDir, "outside-git-cache");
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(muxRoot, "backup-cache"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(muxRoot, "backup-cache"));

    const refused = await service.push(settings);

    expect(refused.success).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses a pre-created per-repository cache symlink even when its target is a real clone", async () => {
    // The clone the link points at has the right origin, so the origin check accepts it and only
    // the link itself gives it away.
    await pushOrThrow();
    const cacheRoot = path.join(muxRoot, "backup-cache");
    const cachePath = backupCachePath(cacheRoot, settings.repoUrl, settings.branch);
    const outside = path.join(tempDir, "outside-clone");
    await fs.rename(cachePath, outside);
    await fs.symlink(outside, cachePath);
    await writeFixtureFile(muxRoot, "AGENTS.md", "changed after the link went in\n");

    const refused = await service.push(settings);

    expect(refused.success).toBe(false);
    expect(await fs.readFile(path.join(outside, "mux/AGENTS.md"), "utf-8")).not.toContain(
      "changed after the link went in"
    );
  });

  it("refuses to write a safety snapshot through a symlinked cache directory", async () => {
    await pushOrThrow();

    // The git cache lives elsewhere so the symlink below only affects the snapshot.
    const outside = path.join(tempDir, "outside-cache");
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(muxRoot, "backup-cache"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(muxRoot, "backup-cache"));
    const linked = new BackupService(config, {
      gitRepo: createBackupGitRepo({ cacheRoot: path.join(tempDir, "git-cache") }),
      payload: createBackupPayloadStore({ config }),
    });

    const refused = await linked.restore(settings);

    expect(refused.success).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("restores a push whose source had two names for one file", async () => {
    await pushOrThrow();

    // Collection publishes both names, so this push is one the same source must be able to
    // restore. The write path severs the link, giving each name its own recorded content.
    await fs.rm(path.join(muxRoot, "agents/reviewer.md"));
    await fs.link(path.join(muxRoot, "AGENTS.md"), path.join(muxRoot, "agents/reviewer.md"));

    const restored = await service.restore(settings);

    expect(restored.success).toBe(true);
    expect(await fs.readFile(path.join(muxRoot, "AGENTS.md"), "utf-8")).toBe(
      "global instructions\n"
    );
    expect(await fs.readFile(path.join(muxRoot, "agents/reviewer.md"), "utf-8")).toBe(
      "reviewer agent\n"
    );
  });

  it("restores files, keeps local-only files, and records the restored commit", async () => {
    const pushed = await pushOrThrow();

    await writeFixtureFile(muxRoot, "AGENTS.md", "locally edited\n");
    await writeFixtureFile(muxRoot, "agents/local-only.md", "local only\n");

    const restored = await service.restore(settings);
    if (!restored.success) throw new Error(restored.error.message);
    // mcp.jsonc is reported too: the local file's comment is not in the payload, so restoring
    // it really does change the file even though every value round-trips.
    expect(restored.data.changedFiles).toEqual(["AGENTS.md", "mcp.jsonc"]);
    expect(restored.data.localOnlyFiles).toEqual(["agents/local-only.md"]);
    expect(await fs.readFile(path.join(muxRoot, "AGENTS.md"), "utf-8")).toBe(
      "global instructions\n"
    );
    expect(await fs.readFile(path.join(muxRoot, "agents/local-only.md"), "utf-8")).toBe(
      "local only\n"
    );

    expect(await fs.readFile(path.join(restored.data.snapshotPath, "AGENTS.md"), "utf-8")).toBe(
      "locally edited\n"
    );
    expect(service.getSettings()?.lastRestoredCommit).toBe(pushed.data.commit);
  });

  it("restores and re-pushes a pre-rename mux/ backup through xum/ settings", async () => {
    // The backup was pushed while the default managed path was still `mux/`.
    const pushed = await pushOrThrow();

    // A post-rename client points the default `xum/` path at the same repository.
    await writeFixtureFile(muxRoot, "AGENTS.md", "locally diverged\n");
    settings = { ...settings, path: "xum/" };
    const restored = await service.restore(settings);
    if (!restored.success) throw new Error(restored.error.message);
    expect(restored.data.commit).toBe(pushed.data.commit);
    expect(await fs.readFile(path.join(muxRoot, "AGENTS.md"), "utf-8")).toBe(
      "global instructions\n"
    );

    // Pushing through the renamed settings updates mux/ in place instead of forking xum/.
    await writeFixtureFile(muxRoot, "AGENTS.md", "updated after rename\n");
    await pushOrThrow();
    const clone = await cloneOrigin("after-rename");
    const files = await listFiles(clone);
    expect(files).toContain("mux/AGENTS.md");
    expect(files.some((file) => file.startsWith("xum/"))).toBe(false);
    expect(await fs.readFile(path.join(clone, "mux/AGENTS.md"), "utf-8")).toBe(
      "updated after rename\n"
    );
  });

  it("reports an empty repository as reachable and bootstraps its first commit", async () => {
    const validated = await service.validate(settings);
    if (!validated.success) throw new Error(validated.error.message);
    expect(validated.data.empty).toBe(true);

    const pushed = await pushOrThrow();
    expect(pushed.success).toBe(true);
    expect(await runGit(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toMatch(
      /^[0-9a-f]{40}$/
    );
  });

  it("previews an empty repository without erroring and refuses to restore from it", async () => {
    const preview = await service.preview(settings);
    if (!preview.success) throw new Error(preview.error.message);
    expect(preview.data.restoreChanges).toEqual([]);
    expect(preview.data.pushChanges.length).toBeGreaterThan(0);

    const restored = await service.restore(settings);
    expect(restored.success).toBe(false);
    if (restored.success) throw new Error("Expected an empty repository to block restore");
    expect(restored.error.code).toBe("INVALID_BACKUP");
    expect(restored.error.message).not.toContain("ENOENT");
  });

  it("refuses to restore when the branch has commits but no backup payload", async () => {
    const clone = path.join(tempDir, "seed");
    await runGit(["clone", "--quiet", originPath, clone]);
    await fs.writeFile(path.join(clone, "README.md"), "unrelated repository\n", "utf-8");
    await runGit(["-C", clone, "add", "README.md"]);
    await runGit([
      "-C",
      clone,
      "-c",
      "user.email=uat@example.com",
      "-c",
      "user.name=UAT",
      "commit",
      "--quiet",
      "-m",
      "unrelated",
    ]);
    await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const restored = await service.restore(settings);
    expect(restored.success).toBe(false);
    if (restored.success) throw new Error("Expected a missing payload to block restore");
    expect(restored.error.code).toBe("INVALID_BACKUP");
    expect(restored.error.message).not.toContain("ENOENT");
  });

  it("rejects a managed path that targets the git directory", async () => {
    const saved = await service.saveSettings({ ...settings, path: ".git" });
    expect(saved.success).toBe(false);
  });

  it("surfaces an unreachable remote as an expected error", async () => {
    const missing = { ...settings, repoUrl: path.join(tempDir, "does-not-exist.git") };
    const validated = await service.validate(missing);
    expect(validated.success).toBe(false);
  });

  it("round-trips the project bundle and reimports a project at a different path", async () => {
    // Source machine: one registered project with memory.
    const projectPath = path.join(tempDir, "projects", "rocket");
    await fs.mkdir(projectPath, { recursive: true });
    const projectService = new ProjectService(config);
    const created = await projectService.create(projectPath);
    if (!created.success) throw new Error(created.error);
    const sourceDir = projectMemoryDirName(created.data.normalizedPath);
    await writeFixtureFile(muxRoot, `memory/project/${sourceDir}/notes.md`, "rocket memory\n");

    const withProjects = { ...settings, includeProjects: true };
    const pushed = await service.push(withProjects);
    expect(pushed.success).toBe(true);

    const clone = await cloneOrigin("bundle-verify");
    const files = await listFiles(clone);
    expect(files).toContain("mux/project-bundle/manifest.json");
    expect(files).toContain(`mux/project-bundle/memory/project/${sourceDir}/notes.md`);
    // The core manifest stays bundle-free so an old build's reader ignores the sidecar.
    const coreManifest = await fs.readFile(path.join(clone, "mux", "manifest.json"), "utf-8");
    expect(coreManifest).not.toContain("project-bundle");

    // Target machine: a fresh Xum root restoring from the same repository.
    const otherRoot = path.join(tempDir, "other-root");
    await fs.mkdir(otherRoot, { recursive: true });
    const otherConfig = new Config(otherRoot);
    const otherService = new BackupService(otherConfig, {
      gitRepo: createBackupGitRepo({ cacheRoot: path.join(otherRoot, "backup-cache") }),
      payload: createBackupPayloadStore({ config: otherConfig }),
    });
    otherService.setProjectService(new ProjectService(otherConfig));

    const preview = await otherService.preview(withProjects);
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.error.message);
    expect(preview.data.projectImports).toHaveLength(1);
    const candidate = preview.data.projectImports[0];
    expect(candidate.sourcePath).toBe(created.data.normalizedPath);

    const movedPath = path.join(tempDir, "projects", "rocket-moved");
    await fs.mkdir(movedPath, { recursive: true });
    const restored = await otherService.restore(withProjects, {
      projectImports: [{ token: candidate.token, targetPath: movedPath }],
    });
    expect(restored.success).toBe(true);
    if (!restored.success) throw new Error(restored.error.message);
    expect(restored.data.projectImportResults[0]?.status).toBe("imported");

    const rekeyedDir = projectMemoryDirName(path.resolve(movedPath));
    expect(rekeyedDir).not.toBe(sourceDir);
    expect(
      await fs.readFile(path.join(otherRoot, "memory", "project", rekeyedDir, "notes.md"), "utf-8")
    ).toBe("rocket memory\n");
    expect(otherConfig.loadConfigOrDefault().projects.has(path.resolve(movedPath))).toBe(true);
  });
});
