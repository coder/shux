import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import {
  MAX_CODE_WORKSPACE_FILE_BYTES,
  MAX_CODE_WORKSPACE_FOLDERS,
  computeManagedWorktreePaths,
  managedRootsByProject,
  syncProjectCodeWorkspace,
  updateCodeWorkspaceFile,
} from "./codeWorkspaceSync";

let tempDir: string;
let managedRootDir: string;
let workspaceFilePath: string;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "code-workspace-sync-"));
  managedRootDir = path.join(tempDir, "src", "my-project");
  workspaceFilePath = path.join(tempDir, "my-project.code-workspace");
});

afterEach(async () => {
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});

async function readWorkspaceFile(): Promise<string> {
  return fsPromises.readFile(workspaceFilePath, "utf-8");
}

function parseFolders(text: string): Array<{ path: string }> {
  const parsed = jsonc.parse(text) as { folders: Array<{ path: string }> };
  return parsed.folders;
}

describe("updateCodeWorkspaceFile", () => {
  test("creates a missing file with seed folders", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [path.join(tempDir, "project"), worktree],
    });

    const folders = parseFolders(await readWorkspaceFile());
    expect(folders).toEqual([{ path: path.join(tempDir, "project") }, { path: worktree }]);
  });

  test("adds missing worktree entries to an existing file", async () => {
    const existing = path.join(managedRootDir, "feature-a");
    const added = path.join(managedRootDir, "feature-b");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: existing }] }, null, "\t")
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [existing, added],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: existing }, { path: added }]);
  });

  test("removes managed entries that are no longer desired", async () => {
    const kept = path.join(managedRootDir, "feature-a");
    const removedA = path.join(managedRootDir, "feature-b");
    const removedB = path.join(managedRootDir, "feature-c");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: removedA }, { path: kept }, { path: removedB }] })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [kept],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: kept }]);
  });

  test("never removes user-owned entries outside the managed root", async () => {
    const projectRoot = path.join(tempDir, "project");
    const userFolder = "/home/user/some-other-folder";
    const relativeUserFolder = "./relative-folder";
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({
        folders: [{ path: projectRoot }, { path: userFolder }, { path: relativeUserFolder }],
      })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([
      { path: projectRoot },
      { path: userFolder },
      { path: relativeUserFolder },
    ]);
  });

  test("preserves comments, settings, and folder names through edits", async () => {
    const kept = path.join(managedRootDir, "feature-a");
    const removed = path.join(managedRootDir, "feature-b");
    const added = path.join(managedRootDir, "feature-c");
    const content = [
      "{",
      "\t// user comment survives",
      '\t"folders": [',
      `\t\t{ "path": ${JSON.stringify(kept)}, "name": "Kept" },`,
      `\t\t{ "path": ${JSON.stringify(removed)} }`,
      "\t],",
      '\t"settings": { "editor.tabSize": 2 }',
      "}",
    ].join("\n");
    await fsPromises.writeFile(workspaceFilePath, content);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [kept, added],
      seedFolders: [],
    });

    const text = await readWorkspaceFile();
    expect(text).toContain("// user comment survives");
    const parsed = jsonc.parse(text) as {
      folders: Array<{ path: string; name?: string }>;
      settings: Record<string, unknown>;
    };
    expect(parsed.settings).toEqual({ "editor.tabSize": 2 });
    expect(parsed.folders).toEqual([{ path: kept, name: "Kept" }, { path: added }]);
  });

  test("adds a folders array to a file that lacks one", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    await fsPromises.writeFile(workspaceFilePath, '{\n\t"settings": {}\n}\n');

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: worktree }]);
  });

  test("rejects non-regular targets like device files behind a symlink", async () => {
    // A checkout-supplied symlink can point at e.g. /dev/zero, where stat
    // reports size 0 but reads never reach EOF.
    const linkPath = path.join(tempDir, "device.code-workspace");
    await fsPromises.symlink("/dev/null", linkPath);

    const result = await updateCodeWorkspaceFile({
      codeWorkspacePath: linkPath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });

    expect(result.ok).toBe(false);
    expect((await fsPromises.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  test("skips files exceeding the size cap without rewriting them", async () => {
    // jsonc.parse is synchronous, so oversized (potentially repo-controlled)
    // files must be rejected before parsing.
    const oversized = `{"folders": [], "pad": "${"x".repeat(MAX_CODE_WORKSPACE_FILE_BYTES + 1)}"}`;
    await fsPromises.writeFile(workspaceFilePath, oversized);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });

    expect(await readWorkspaceFile()).toBe(oversized);
  });

  test("leaves a malformed file untouched without throwing", async () => {
    const malformed = '{ "folders": [ { "path": broken ';
    await fsPromises.writeFile(workspaceFilePath, malformed);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });

    expect(await readWorkspaceFile()).toBe(malformed);
  });

  test("is idempotent: a second sync does not rewrite the file", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const update = {
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    };
    await updateCodeWorkspaceFile(update);
    const afterFirst = await fsPromises.stat(workspaceFilePath);

    await updateCodeWorkspaceFile(update);
    const afterSecond = await fsPromises.stat(workspaceFilePath);

    expect(afterSecond.mtimeMs).toBe(afterFirst.mtimeMs);
    expect(afterSecond.ino).toBe(afterFirst.ino);
  });

  test("two projects sharing one file manage disjoint entries", async () => {
    const otherManagedRoot = path.join(tempDir, "src", "other-project");
    const mine = path.join(managedRootDir, "feature-a");
    const theirs = path.join(otherManagedRoot, "feature-x");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: mine }, { path: theirs }] })
    );

    // Sync for "my-project" with an empty desired set: must not touch the
    // other project's entry.
    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: theirs }]);
  });

  test("refuses reconciles whose final folder count exceeds the sync cap", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const filePath = path.join(tempDir, "huge.code-workspace");
    // Exactly at the cap: the single addition would push the FINAL count over.
    const content = JSON.stringify({
      folders: Array.from({ length: MAX_CODE_WORKSPACE_FOLDERS }, () => ({})),
    });
    await fsPromises.writeFile(filePath, content);

    const result = await updateCodeWorkspaceFile({
      codeWorkspacePath: filePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    });

    expect(result.ok).toBe(false);
    expect(await fsPromises.readFile(filePath, "utf-8")).toBe(content);
  });

  test("refuses to create a file with more seed folders than the sync cap", async () => {
    const filePath = path.join(tempDir, "seeded.code-workspace");
    const seedFolders = Array.from({ length: MAX_CODE_WORKSPACE_FOLDERS + 1 }, (_, i) =>
      path.join(managedRootDir, `feature-${i}`)
    );

    const result = await updateCodeWorkspaceFile({
      codeWorkspacePath: filePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: seedFolders,
      seedFolders,
    });

    expect(result.ok).toBe(false);
    const exists = await fsPromises.stat(filePath).then(
      () => true,
      () => false
    );
    expect(exists).toBe(false);
  });

  test("rejects files with duplicate top-level folders properties", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const filePath = path.join(tempDir, "dupe.code-workspace");
    // jsonc.parse reads the last property but jsonc.modify edits the first, so
    // a reconcile would silently no-op while reporting success.
    const content = `{"folders": [], "folders": [{"path": "/user/data"}]}`;
    await fsPromises.writeFile(filePath, content);

    const result = await updateCodeWorkspaceFile({
      codeWorkspacePath: filePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    });

    expect(result.ok).toBe(false);
    expect(await fsPromises.readFile(filePath, "utf-8")).toBe(content);
  });

  test("refuses to write through a symlink whose target is not a .code-workspace file", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const externalJson = path.join(tempDir, "external.json");
    const externalContent = JSON.stringify({ folders: [{ path: "/user/data" }] });
    await fsPromises.writeFile(externalJson, externalContent);
    const linkPath = path.join(tempDir, "proj.code-workspace");
    await fsPromises.symlink(externalJson, linkPath);

    const result = await updateCodeWorkspaceFile({
      codeWorkspacePath: linkPath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    });

    expect(result.ok).toBe(false);
    expect(await fsPromises.readFile(externalJson, "utf-8")).toBe(externalContent);

    // The dangling variant must not create the non-extension target either.
    const danglingLink = path.join(tempDir, "dangling-bad.code-workspace");
    await fsPromises.symlink(path.join(tempDir, "planted.json"), danglingLink);
    const danglingResult = await updateCodeWorkspaceFile({
      codeWorkspacePath: danglingLink,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    });
    expect(danglingResult.ok).toBe(false);
    const plantedExists = await fsPromises.stat(path.join(tempDir, "planted.json")).then(
      () => true,
      () => false
    );
    expect(plantedExists).toBe(false);
  });

  test("creates a dangling symlink's target instead of replacing the link", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const target = path.join(tempDir, "real-target.code-workspace");
    const linkPath = path.join(tempDir, "dangling.code-workspace");
    await fsPromises.symlink(target, linkPath);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: linkPath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [worktree],
    });

    expect((await fsPromises.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(parseFolders(await fsPromises.readFile(target, "utf-8"))).toEqual([{ path: worktree }]);
  });

  test("writes through a symlinked workspace file without replacing the link", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const realFile = path.join(tempDir, "shared-config", "real.code-workspace");
    await fsPromises.mkdir(path.dirname(realFile), { recursive: true });
    await fsPromises.writeFile(realFile, JSON.stringify({ folders: [] }));
    const linkPath = path.join(tempDir, "linked.code-workspace");
    await fsPromises.symlink(realFile, linkPath);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: linkPath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [worktree],
      seedFolders: [],
    });

    expect((await fsPromises.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(parseFolders(await fsPromises.readFile(realFile, "utf-8"))).toEqual([
      { path: worktree },
    ]);
  });

  test("serializes concurrent updates to the same file", async () => {
    await fsPromises.writeFile(workspaceFilePath, JSON.stringify({ folders: [] }));
    const otherRoot = path.join(tempDir, "src", "other-project");
    const mine = path.join(managedRootDir, "feature-a");
    const theirs = path.join(otherRoot, "feature-x");

    // Two projects sharing one file sync concurrently; without per-file
    // serialization one write clobbers the other's addition.
    await Promise.all([
      updateCodeWorkspaceFile({
        codeWorkspacePath: workspaceFilePath,
        managedRootDirs: [managedRootDir],
        desiredPaths: [mine],
        seedFolders: [],
      }),
      updateCodeWorkspaceFile({
        codeWorkspacePath: workspaceFilePath,
        managedRootDirs: [otherRoot],
        desiredPaths: [theirs],
        seedFolders: [],
      }),
    ]);

    const folders = parseFolders(await readWorkspaceFile());
    expect(folders.map((entry) => entry.path).sort()).toEqual([mine, theirs].sort());
  });

  test("resolves relative folder entries against the file's directory", async () => {
    // Entry is relative but points inside the managed root; it must count as
    // present (no duplicate added) and be removable when undesired.
    const relative = "./src/my-project/feature-a";
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: relative }] })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });
    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: relative }]);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDirs: [managedRootDir],
      desiredPaths: [],
      seedFolders: [],
    });
    expect(parseFolders(await readWorkspaceFile())).toEqual([]);
  });
});

describe("syncProjectCodeWorkspace", () => {
  test("creates the file from project config, resolving relative setting paths", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    const worktreePath = path.join(config.srcDir, "repo", "feat-1");
    // Checkout must exist on disk or metadata is marked transcript-only.
    await fsPromises.mkdir(worktreePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: worktreePath,
            id: "aaaaaaaaaa",
            name: "feat-1",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
        codeWorkspaceSyncPath: "repo.code-workspace",
      });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    const text = await fsPromises.readFile(path.join(projectPath, "repo.code-workspace"), "utf-8");
    expect(parseFolders(text)).toEqual([{ path: projectPath }, { path: worktreePath }]);
  });

  test("does nothing when the setting is unset", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [] });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    expect((await fsPromises.readdir(projectPath)).length).toBe(0);
  });

  test("groups symlink aliases of the same file into one reconcile", async () => {
    // One project configures the symlink path, another the real path; lexical
    // comparison would treat them as different files and let their overlapping
    // managed root erase each other's entries.
    const config = new Config(tempDir);
    const projectA = path.join(tempDir, "a", "repo");
    const projectB = path.join(tempDir, "b", "repo");
    await fsPromises.mkdir(projectA, { recursive: true });
    await fsPromises.mkdir(projectB, { recursive: true });
    const realFile = path.join(tempDir, "real.code-workspace");
    await fsPromises.writeFile(realFile, JSON.stringify({ folders: [] }));
    const linkFile = path.join(tempDir, "alias.code-workspace");
    await fsPromises.symlink(realFile, linkFile);
    const worktreeA = path.join(config.srcDir, "repo", "feat-a");
    const worktreeB = path.join(config.srcDir, "repo", "feat-b");
    await fsPromises.mkdir(worktreeA, { recursive: true });
    await fsPromises.mkdir(worktreeB, { recursive: true });
    const workspaceEntry = (worktree: string, id: string) => ({
      path: worktree,
      id,
      name: path.basename(worktree),
      runtimeConfig: { type: "worktree" as const, srcBaseDir: config.srcDir },
    });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectA, {
        workspaces: [workspaceEntry(worktreeA, "aaaaaaaaaa")],
        codeWorkspaceSyncPath: linkFile,
      });
      cfg.projects.set(projectB, {
        workspaces: [workspaceEntry(worktreeB, "bbbbbbbbbb")],
        codeWorkspaceSyncPath: realFile,
      });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectA);
    await syncProjectCodeWorkspace(config, projectB);

    const folderPaths = parseFolders(await fsPromises.readFile(realFile, "utf-8")).map(
      (entry) => entry.path
    );
    expect(folderPaths).toContain(worktreeA);
    expect(folderPaths).toContain(worktreeB);
  });

  test("unions projects that target the same file so they cannot erase each other", async () => {
    // Same-basename projects share one managed root (<srcDir>/repo); a sync
    // scoped to only one project would remove the other's entries.
    const config = new Config(tempDir);
    const projectA = path.join(tempDir, "a", "repo");
    const projectB = path.join(tempDir, "b", "repo");
    await fsPromises.mkdir(projectA, { recursive: true });
    await fsPromises.mkdir(projectB, { recursive: true });
    const sharedFile = path.join(tempDir, "shared.code-workspace");
    const worktreeA = path.join(config.srcDir, "repo", "feat-a");
    const worktreeB = path.join(config.srcDir, "repo", "feat-b");
    await fsPromises.mkdir(worktreeA, { recursive: true });
    await fsPromises.mkdir(worktreeB, { recursive: true });
    const workspaceEntry = (worktree: string, id: string) => ({
      path: worktree,
      id,
      name: path.basename(worktree),
      runtimeConfig: { type: "worktree" as const, srcBaseDir: config.srcDir },
    });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectA, {
        workspaces: [workspaceEntry(worktreeA, "aaaaaaaaaa")],
        codeWorkspaceSyncPath: sharedFile,
      });
      cfg.projects.set(projectB, {
        workspaces: [workspaceEntry(worktreeB, "bbbbbbbbbb")],
        codeWorkspaceSyncPath: sharedFile,
      });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectA);
    await syncProjectCodeWorkspace(config, projectB);

    const folders = parseFolders(await fsPromises.readFile(sharedFile, "utf-8"));
    const folderPaths = folders.map((entry) => entry.path);
    expect(folderPaths).toContain(worktreeA);
    expect(folderPaths).toContain(worktreeB);
  });

  test("removes stale entries under extra managed roots after their workspace is gone", async () => {
    // Deleting the last workspace under a custom/legacy srcBaseDir removes the
    // metadata that reconstructed its root; callers pass the captured root so
    // the deleted checkout's entry still gets cleaned up.
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    const legacyRoot = path.join(tempDir, "legacy-src", "repo");
    const staleEntry = path.join(legacyRoot, "deleted-feature");
    const file = path.join(projectPath, "repo.code-workspace");
    await fsPromises.writeFile(
      file,
      JSON.stringify({ folders: [{ path: projectPath }, { path: staleEntry }] })
    );
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [],
        codeWorkspaceSyncPath: "repo.code-workspace",
      });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath, { extraManagedRootDirs: [legacyRoot] });

    expect(parseFolders(await fsPromises.readFile(file, "utf-8"))).toEqual([{ path: projectPath }]);
  });

  test("refuses paths without the .code-workspace extension", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], codeWorkspaceSyncPath: "notes.json" });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    expect((await fsPromises.readdir(projectPath)).length).toBe(0);
  });
});

describe("computeManagedWorktreePaths", () => {
  const projectPath = "/home/user/projects/my-project";

  function makeMetadata(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
    const base: FrontendWorkspaceMetadata = {
      id: "abc123def0",
      name: "feature-a",
      projectName: "my-project",
      projectPath,
      namedWorkspacePath: path.join("/base/src/my-project", "feature-a"),
      runtimeConfig: { type: "worktree", srcBaseDir: "/base/src" },
    };
    return { ...base, ...overrides };
  }

  const managedRoot = "/base/src/my-project";
  const computeParams = {
    projectPath,
    defaultManagedRootDir: managedRoot,
  };

  test("includes active worktree workspaces and sorts deduped paths", () => {
    const { desiredPaths } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({ name: "b", namedWorkspacePath: `${managedRoot}/b` }),
        makeMetadata({ name: "a", namedWorkspacePath: `${managedRoot}/a` }),
        makeMetadata({ name: "a-dup", namedWorkspacePath: `${managedRoot}/a` }),
      ],
      ...computeParams,
    });
    expect(desiredPaths).toEqual([`${managedRoot}/a`, `${managedRoot}/b`]);
  });

  test("excludes archived, sub-agent, isolation-none, other-project, and out-of-root workspaces", () => {
    const { desiredPaths } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({ archivedAt: "2026-01-02T00:00:00Z" }),
        makeMetadata({ parentWorkspaceId: "parent1234" }),
        makeMetadata({ taskIsolation: "none" }),
        makeMetadata({ projectPath: "/home/user/projects/other" }),
        makeMetadata({ namedWorkspacePath: "/elsewhere/feature-a" }),
        makeMetadata({ runtimeConfig: { type: "local" } }),
      ],
      ...computeParams,
    });
    expect(desiredPaths).toEqual([]);
  });

  test("re-includes unarchived workspaces", () => {
    const { desiredPaths } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          archivedAt: "2026-01-01T00:00:00Z",
          unarchivedAt: "2026-01-02T00:00:00Z",
        }),
      ],
      ...computeParams,
    });
    expect(desiredPaths).toEqual([`${managedRoot}/feature-a`]);
  });

  test("includes devcontainer workspaces (host worktrees under the default root)", () => {
    const { desiredPaths } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
        }),
      ],
      ...computeParams,
    });
    expect(desiredPaths).toEqual([`${managedRoot}/feature-a`]);
  });

  test("excludes transcript-only workspaces whose checkout was deleted", () => {
    const { desiredPaths } = computeManagedWorktreePaths({
      allMetadata: [makeMetadata({ transcriptOnly: true })],
      ...computeParams,
    });
    expect(desiredPaths).toEqual([]);
  });

  test("managedRootsByProject derives devcontainer cleanup roots from the checkout", () => {
    const subProjectPath = `${projectPath}/packages/api`;
    const metadata = makeMetadata({
      subProjectPath,
      runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    });
    const roots = managedRootsByProject(metadata);
    // Cleanup after removal/reassignment must retain the parent checkout root,
    // matching what computeManagedWorktreePaths derives while the metadata exists.
    expect(roots.get(subProjectPath)).toEqual([managedRoot]);
    expect(roots.get(projectPath)).toEqual([managedRoot]);
  });

  test("keeps a devcontainer workspace assigned to a sub-project under the parent root", () => {
    const subProjectPath = `${projectPath}/packages/api`;
    // Devcontainer host worktrees live under the PARENT project's directory;
    // the sub-project's default root (/base/src/api) does not contain them.
    const { desiredPaths, managedRootDirs } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          subProjectPath,
          runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
        }),
      ],
      projectPath: subProjectPath,
      defaultManagedRootDir: "/base/src/api",
    });
    expect(desiredPaths).toEqual([`${managedRoot}/feature-a`]);
    expect(managedRootDirs).toContain(managedRoot);
  });

  test("includes workspaces assigned to a registered sub-project", () => {
    const subProjectPath = `${projectPath}/packages/api`;
    // The workspace lives in the parent's bucket and shares the parent repo's
    // worktree directory; the sub-project's own file must still list it.
    const { desiredPaths, managedRootDirs } = computeManagedWorktreePaths({
      allMetadata: [makeMetadata({ subProjectPath })],
      projectPath: subProjectPath,
      defaultManagedRootDir: "/base/src/api",
    });
    expect(desiredPaths).toEqual([`${managedRoot}/feature-a`]);
    expect(managedRootDirs).toContain(managedRoot);
  });

  test("keeps worktrees under a custom or legacy srcBaseDir managed", () => {
    // Legacy "local"-with-srcBaseDir runtime rooted somewhere other than the
    // current global srcDir (e.g. a pre-rename ~/.mux/src) must still sync.
    const { desiredPaths, managedRootDirs } = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          namedWorkspacePath: "/legacy/src/my-project/feature-a",
          runtimeConfig: { type: "local", srcBaseDir: "/legacy/src" },
        }),
      ],
      ...computeParams,
    });
    expect(desiredPaths).toEqual(["/legacy/src/my-project/feature-a"]);
    expect(managedRootDirs).toEqual(["/base/src/my-project", "/legacy/src/my-project"]);
  });

  test("derives per-project checkout paths for multi-project workspaces", () => {
    const multiProjects = [
      { projectPath: "/home/user/projects/primary", projectName: "primary" },
      { projectPath, projectName: "my-project" },
    ];
    // namedWorkspacePath for multi-project workspaces is the _workspaces/<name>
    // symlink container, never a real checkout, for primary and secondary alike.
    const asSecondary = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          projectPath: "/home/user/projects/primary",
          namedWorkspacePath: "/base/src/_workspaces/feature-a",
          projects: multiProjects,
        }),
      ],
      ...computeParams,
    });
    expect(asSecondary.desiredPaths).toEqual([`${managedRoot}/feature-a`]);

    const asPrimary = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          namedWorkspacePath: "/base/src/_workspaces/feature-a",
          projects: multiProjects,
        }),
      ],
      ...computeParams,
    });
    expect(asPrimary.desiredPaths).toEqual([`${managedRoot}/feature-a`]);
  });
});
