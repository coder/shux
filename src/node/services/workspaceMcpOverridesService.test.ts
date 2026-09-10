import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as fsPromisesModule from "node:fs/promises";
import { parse as jsoncParse, type ParseError as JsoncParseError } from "jsonc-parser";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  isPositivelyAbsent,
  MCP_OVERRIDES_REVISION_UNAVAILABLE,
  readHostOverrideDocumentNoFollow,
  readWorkspaceOverridesEpochToken,
  runtimeFilesystemIdentity,
  WorkspaceMcpOverridesConflictError,
  WorkspaceMcpOverridesService,
} from "./workspaceMcpOverridesService";

function getWorkspacePath(args: {
  srcDir: string;
  projectName: string;
  workspaceName: string;
}): string {
  return path.join(args.srcDir, args.projectName, args.workspaceName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("WorkspaceMcpOverridesService", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-overrides-test-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function registerWorkspace(workspaceName: string): Promise<{
    workspaceId: string;
    workspacePath: string;
  }> {
    const projectPath = `/fake/${workspaceName}`;
    const workspaceId = `ws-${workspaceName}`;
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: workspaceName,
      workspaceName: "branch",
    });
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    return { workspaceId, workspacePath };
  }

  /** Project-dir (`local` runtime) workspace: its checkout IS the project path. */
  async function registerLocalWorkspace(
    projectPath: string,
    workspaceId: string,
    parentWorkspaceId?: string
  ): Promise<void> {
    await fs.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath) ?? { workspaces: [] };
      project.workspaces.push({
        path: projectPath,
        id: workspaceId,
        name: workspaceId,
        runtimeConfig: { type: "local" },
        ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      });
      cfg.projects.set(projectPath, project);
      return cfg;
    });
  }

  it("returns empty overrides when no file and no legacy config", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    const { overrides } = await service.getOverridesForWorkspace(workspaceId);

    expect(overrides).toEqual({});
    expect(await pathExists(path.join(workspacePath, ".xum", "mcp.local.jsonc"))).toBe(false);
  });

  it("reads legacy JSONC and JSON override files", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    for (const [index, filename] of ["mcp.local.jsonc", "mcp.local.json"].entries()) {
      const { workspaceId, workspacePath } = await registerWorkspace(`legacy-${index}`);
      await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(workspacePath, ".mux", filename),
        JSON.stringify({ disabledServers: [`legacy-${index}`] }),
        "utf-8"
      );

      expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
        disabledServers: [`legacy-${index}`],
      });
    }
  });

  describe("sub-agent inheritance", () => {
    async function registerChild(
      parentWorkspaceId: string,
      workspaceName: string
    ): Promise<{ workspaceId: string; workspacePath: string }> {
      const { workspaceId, workspacePath } = await registerWorkspace(workspaceName);
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((w) => w.id === workspaceId);
          if (workspace) workspace.parentWorkspaceId = parentWorkspaceId;
        }
        return cfg;
      });
      return { workspaceId, workspacePath };
    }

    it("child without its own file inherits the parent chain's overrides", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("inherit-parent");
      const child = await registerChild(parent.workspaceId, "inherit-child");
      const grandchild = await registerChild(child.workspaceId, "inherit-grandchild");

      // No overrides anywhere yet: nothing to inherit.
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({});

      await service.setOverridesForWorkspace(parent.workspaceId, {
        enabledServers: ["globally-disabled"],
      });

      const inherited = await service.getOverridesForWorkspace(grandchild.workspaceId);
      expect(inherited.overrides).toEqual({ enabledServers: ["globally-disabled"] });
      // Read-through, not a copy: the child checkout stays untouched.
      expect(await pathExists(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );

      // Parent edits reach children on the next read.
      await service.setOverridesForWorkspace(parent.workspaceId, {
        disabledServers: ["noisy"],
      });
      expect((await service.getOverridesForWorkspace(grandchild.workspaceId)).overrides).toEqual({
        disabledServers: ["noisy"],
      });
    });

    it("child's own overrides win over the parent's, and saving them uses the inherited revision", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("own-parent");
      const child = await registerChild(parent.workspaceId, "own-child");
      await service.setOverridesForWorkspace(parent.workspaceId, {
        enabledServers: ["from-parent"],
      });

      // The dialog snapshot a child user sees is the inherited state; a CAS
      // save against that revision must succeed.
      const { revision } = await service.getOverridesForWorkspace(child.workspaceId);
      await service.setOverridesForWorkspace(
        child.workspaceId,
        { disabledServers: ["from-parent"] },
        { expectedRevision: revision }
      );
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        disabledServers: ["from-parent"],
      });
      expect((await service.getOverridesForWorkspace(parent.workspaceId)).overrides).toEqual({
        enabledServers: ["from-parent"],
      });

      // Clearing the child's overrides removes its file and resumes inheriting.
      await service.setOverridesForWorkspace(child.workspaceId, {});
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        enabledServers: ["from-parent"],
      });
    });

    it("legacy config data that normalizes to nothing does not detach a child from its parent", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-empty-parent");
      const child = await registerChild(parent.workspaceId, "legacy-empty-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.mcp = { enabledServers: [" "] };
        }
        return cfg;
      });

      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        enabledServers: ["shots"],
      });
      // The noise is cleared instead of shadowing the parent forever.
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === child.workspaceId);
      expect(stored?.mcp).toBeUndefined();
    });

    it("inherited resolution never clears an intermediate workspace's empty legacy value", async () => {
      // Clearing legacy noise is a config MUTATION: only the workspace's own
      // (depth 0) resolution may perform it. A grandchild reading through the
      // child must resolve as if the noise were absent yet leave it in place.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-empty-grandparent");
      const child = await registerChild(parent.workspaceId, "legacy-empty-middle");
      const grandchild = await registerChild(child.workspaceId, "legacy-empty-grandchild");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.mcp = { enabledServers: [" "] };
        }
        return cfg;
      });

      expect((await service.getOverridesForWorkspace(grandchild.workspaceId)).overrides).toEqual({
        enabledServers: ["shots"],
      });
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === child.workspaceId);
      expect(stored?.mcp).toEqual({ enabledServers: [" "] });
    });

    it("read-path legacy clears are compare-and-delete: a value saved meanwhile survives", async () => {
      // An older/downgraded Xum process can save a new `workspace.mcp` value
      // between a read observing empty legacy noise and its clear; the clear
      // must only remove the value it observed.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-cas-parent");
      const child = await registerChild(parent.workspaceId, "legacy-cas-child");
      const setLegacy = (value: unknown) =>
        config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const entry = project.workspaces.find((w) => w.id === child.workspaceId);
            if (entry) entry.mcp = value as never;
          }
          return cfg;
        });
      const storedLegacy = () =>
        [...config.loadConfigOrDefault().projects.values()]
          .flatMap((project) => project.workspaces)
          .find((w) => w.id === child.workspaceId)?.mcp;
      const internals = service as unknown as {
        clearLegacyOverridesInConfig: (
          workspaceId: string,
          options?: { onlyIfEquals?: unknown }
        ) => Promise<void>;
      };
      const newer = { disabledServers: ["shots"] };
      await setLegacy(newer);
      // Observed noise, but the stored value changed since: left alone.
      await internals.clearLegacyOverridesInConfig(child.workspaceId, {
        onlyIfEquals: { enabledServers: [" "] },
      });
      expect(storedLegacy()).toEqual(newer);
      // Matching observation: cleared.
      await internals.clearLegacyOverridesInConfig(child.workspaceId, { onlyIfEquals: newer });
      expect(storedLegacy()).toBeUndefined();
    });

    it("a read-path legacy migration takes the write locks and never overwrites a save made meanwhile", async () => {
      // A per-request read (send path, call-time gate) observes an unmigrated
      // legacy enable and pauses; a settings save persists a disable under
      // the locks; the read must not then write the stale enable over it —
      // the epoch retry would trust the restored file and a revoked server
      // would serve again.
      const service = new WorkspaceMcpOverridesService(config);
      const { workspaceId, workspacePath } = await registerWorkspace("legacy-fenced");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) entry.mcp = { enabledServers: ["shots"] };
        }
        return cfg;
      });
      const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");

      // A writer holds the lock while the read runs: the read observes the
      // legacy value and queues behind the lock for its migration.
      const release = await service.acquireExclusiveLock();
      const read = service.getOverridesForWorkspace(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await pathExists(filePath)).toBe(false);
      // The writer persists a disable exactly like setOverridesForWorkspace:
      // document written, legacy value cleared, epoch bumped.
      const saved = JSON.stringify({ disabledServers: ["shots"] });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, saved);
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) delete entry.mcp;
        }
        return cfg;
      });
      await fs.writeFile(path.join(config.rootDir, "mcp-overrides.epoch"), "sibling-save");
      await release();

      // The paused read honors what it observed read-only, but writes nothing.
      expect((await read).overrides).toEqual({ enabledServers: ["shots"] });
      expect(await fs.readFile(filePath, "utf-8")).toBe(saved);
      expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
        disabledServers: ["shots"],
      });
    });

    it("a read-path legacy migration skips a workspace renamed while it waited for the locks", async () => {
      // The locks are derived from the current registry, the migration target
      // from the pre-lock resolution: a rename in between must not recreate
      // the OLD checkout path and clear the only legacy copy.
      const service = new WorkspaceMcpOverridesService(config);
      const { workspaceId, workspacePath } = await registerWorkspace("legacy-renamed");
      const legacyValue = { enabledServers: ["shots"] };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) entry.mcp = legacyValue;
        }
        return cfg;
      });
      const movedPath = path.join(path.dirname(workspacePath), "renamed");

      const release = await service.acquireExclusiveLock();
      const read = service.getOverridesForWorkspace(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Rename lands while the read waits: checkout moved, registry updated.
      await fs.rename(workspacePath, movedPath);
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) {
            entry.path = movedPath;
            entry.name = "renamed";
          }
        }
        return cfg;
      });
      await release();

      expect((await read).overrides).toEqual(legacyValue);
      expect(await pathExists(workspacePath)).toBe(false);
      const storedLegacy = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === workspaceId)?.mcp;
      expect(storedLegacy).toEqual(legacyValue);
      // The next read (from the new path) migrates normally.
      expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual(legacyValue);
      expect(await pathExists(path.join(movedPath, ".xum", "mcp.local.jsonc"))).toBe(true);
    });

    it("an opaque legacy config value keeps the child detached and is preserved", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-opaque-parent");
      const child = await registerChild(parent.workspaceId, "legacy-opaque-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      const opaque = { disabledServers: "shots" };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.mcp = opaque as never;
        }
        return cfg;
      });

      const resolved = await service.getOverridesForWorkspace(child.workspaceId);
      expect(resolved.overrides).toEqual({});
      expect(resolved.authoritative).toBe(true);
      // Neither cleared nor migrated: a newer build may understand it.
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === child.workspaceId);
      expect(stored?.mcp as unknown).toEqual(opaque);
      expect(await pathExists(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );
      // Parent saves treat it as an owner.
      const published: string[] = [];
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { enabledServers: ["shots", "more"] },
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      expect(published).toEqual([parent.workspaceId]);
    });

    it("an unreadable legacy config never lets a child inherit", async () => {
      // The lenient loader degrades a read failure to an empty config, which
      // would look like "no legacy value" and inherit the parent's enable over
      // the child's (unreadable) explicit disable.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-unreadable-parent");
      const child = await registerChild(parent.workspaceId, "legacy-unreadable-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.mcp = { disabledServers: ["shots"] };
        }
        return cfg;
      });
      // Fail only the legacy-config read. Each resolution loads config twice
      // through the snapshot — the workspace enumeration first, then the
      // legacy lookup that decides between "own" and "inherit" — so failing
      // every second authoritative load isolates the failure to the latter.
      const realLoad = config.loadConfigOrDefault.bind(config);
      let authoritativeLoads = 0;
      spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
        if (options?.throwOnError && ++authoritativeLoads % 2 === 0) {
          throw new Error("EIO: config.json unreadable");
        }
        return realLoad(options);
      });

      const resolved = await service.getOverridesForWorkspace(child.workspaceId);
      expect(resolved.overrides).toEqual({});
      expect(resolved.authoritative).toBe(false);
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.getOverridesForWorkspace(child.workspaceId, { mode: "strict" })
      ).rejects.toThrow(/unreadable/);
    });

    it("the unavailable-revision repair never detaches a child whose PARENT is unreadable", async () => {
      // The child's own state is intact; the `{}` its dialog showed stands in
      // for a parent document that may hold enables, disables and allowlists.
      // A repair save from it would write a child-owned document and drop
      // them all once the parent recovers.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("unavailable-parent");
      const child = await registerChild(parent.workspaceId, "unavailable-parent-child");
      await service.setOverridesForWorkspace(parent.workspaceId, {
        enabledServers: ["shots"],
        toolAllowlist: { shots: ["capture"] },
      });
      const parentDocument = path.join(parent.workspacePath, ".xum", "mcp.local.jsonc");
      const intact = await fs.readFile(parentDocument, "utf-8");
      await fs.writeFile(parentDocument, "{ not json");
      const shown = await service.getOverridesForWorkspace(child.workspaceId);
      expect(shown.authoritative).toBe(false);
      expect(shown.overrides).toEqual({});

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(
          child.workspaceId,
          { disabledServers: ["other"] },
          { expectedRevision: MCP_OVERRIDES_REVISION_UNAVAILABLE }
        )
      ).rejects.toThrow(/inherited parent/);
      expect(await pathExists(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );

      // Parent recovers: the child still inherits everything.
      await fs.writeFile(parentDocument, intact);
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        enabledServers: ["shots"],
        toolAllowlist: { shots: ["capture"] },
      });
    });

    it("a child detaching from its parent carries the inherited document's unknown fields", async () => {
      // The parent's document (written by a newer Xum) applied to the child
      // through inheritance; the child's own document must keep those fields
      // or the detach silently drops them for this child on the next upgrade.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("detach-opaque-parent");
      const child = await registerChild(parent.workspaceId, "detach-opaque-child");
      const parentDocument = path.join(parent.workspacePath, ".xum", "mcp.local.jsonc");
      await fs.mkdir(path.dirname(parentDocument), { recursive: true });
      await fs.writeFile(
        parentDocument,
        JSON.stringify({ enabledServers: ["shots"], futureField: { granted: true } })
      );
      await service.setOverridesForWorkspace(child.workspaceId, { disabledServers: ["shots"] });
      const childDocument = path.join(child.workspacePath, ".xum", "mcp.local.jsonc");
      expect(JSON.parse(await fs.readFile(childDocument, "utf-8"))).toEqual({
        futureField: { granted: true },
        disabledServers: ["shots"],
      });
      // The parent's document is untouched.
      expect(JSON.parse(await fs.readFile(parentDocument, "utf-8"))).toEqual({
        enabledServers: ["shots"],
        futureField: { granted: true },
      });

      // A parent document this build cannot merge refuses the detach.
      const other = await registerChild(parent.workspaceId, "detach-unmergeable-child");
      await fs.writeFile(
        parentDocument,
        JSON.stringify({ enabledServers: { shots: "newer-shape" }, futureField: 1 })
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(other.workspaceId, { disabledServers: ["shots"] })
      ).rejects.toThrow(/newer version of Xum/);
      expect(await pathExists(path.join(other.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );
    });

    it("a save refuses to retire a legacy value mixing known settings with unknown fields", async () => {
      // Resolution treats the whole value as opaque (the unknown field may
      // carry authorization semantics), so the UI showed `{}`: retiring the
      // value on save would drop `enabledServers` the user never saw.
      const service = new WorkspaceMcpOverridesService(config);
      const { workspaceId, workspacePath } = await registerWorkspace("legacy-mixed");
      const mixed: unknown = { enabledServers: ["shots"], futureRule: {} };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) entry.mcp = mixed as never;
        }
        return cfg;
      });
      expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({});
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(workspaceId, { disabledServers: ["other"] })
      ).rejects.toThrow(/newer version of Xum/);
      expect(await pathExists(path.join(workspacePath, ".xum", "mcp.local.jsonc"))).toBe(false);
      const kept = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === workspaceId)?.mcp;
      expect(kept).toEqual(mixed as never);
    });

    it("a directory at the child's override path never lets it inherit", async () => {
      // A corrupt or repository-tracked `mcp.local.jsonc/` directory is not
      // absence: nothing can be read from it, and falling through to the
      // parent would expose parent-enabled servers on that evidence.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("dir-candidate-parent");
      const child = await registerChild(parent.workspaceId, "dir-candidate-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      await fs.mkdir(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"), {
        recursive: true,
      });
      const resolved = await service.getOverridesForWorkspace(child.workspaceId);
      expect(resolved.overrides).toEqual({});
      expect(resolved.authoritative).toBe(false);
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.getOverridesForWorkspace(child.workspaceId, { mode: "strict" })
      ).rejects.toThrow(/is a directory/);
    });

    it("a null legacy value is an opaque value, not absence", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("legacy-null-parent");
      const child = await registerChild(parent.workspaceId, "legacy-null-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.mcp = null as never;
        }
        return cfg;
      });
      const resolved = await service.getOverridesForWorkspace(child.workspaceId);
      expect(resolved.overrides).toEqual({});
      expect(resolved.authoritative).toBe(true);
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === child.workspaceId);
      expect(stored?.mcp as unknown).toBeNull();
    });

    it("evicts the cache when resolution fails after the own file was deleted", async () => {
      // removeOverridesFile already ran; if the post-delete resolution throws
      // (e.g. depth assertion), memory must not stay pinned to the deleted
      // document — publish an eviction, then surface the failure.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("evict-on-failure-parent");
      const child = await registerChild(parent.workspaceId, "evict-on-failure-child");
      await service.setOverridesForWorkspace(child.workspaceId, { enabledServers: ["shots"] });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let deleted = false;
      spyOn(internals, "resolveOverridesFor").mockImplementation((...args: unknown[]) => {
        if (deleted) return Promise.reject(new Error("inheritance exceeded 32 levels"));
        return realResolve(...args);
      });
      const published: Array<[unknown, string]> = [];
      const removal = service as unknown as {
        removeOverridesFile: (...args: unknown[]) => Promise<void>;
      };
      const realRemove = removal.removeOverridesFile.bind(service);
      spyOn(removal, "removeOverridesFile").mockImplementation((...args: unknown[]) => {
        deleted = true;
        return realRemove(...args);
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(
          child.workspaceId,
          {},
          {
            publish: (persisted, workspaceId) => {
              published.push([persisted, workspaceId]);
              return Promise.resolve();
            },
          }
        )
      ).rejects.toThrow(/32 levels/);
      expect(published).toEqual([[null, child.workspaceId]]);
      expect(await pathExists(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );
    });

    it("evicts off-host descendants without probing them under the write lock", async () => {
      // A remote inheriting child would need `stat`s with a 10 s timeout per
      // level while the lock is held; it is evicted (re-reads on its own
      // runtime at its next serve) instead — and so is its subtree.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("remote-fanout-parent");
      const remoteChild = "ws-remote-fanout-child";
      const grandchild = "ws-remote-fanout-grandchild";
      await config.editConfig((cfg) => {
        cfg.projects.set("/fake/remote-fanout", {
          workspaces: [
            {
              path: "/remote/child",
              id: remoteChild,
              name: "child",
              parentWorkspaceId: parent.workspaceId,
              runtimeConfig: { type: "ssh", host: "unreachable.invalid", srcBaseDir: "/remote" },
            },
            {
              path: "/remote/grandchild",
              id: grandchild,
              name: "grandchild",
              parentWorkspaceId: remoteChild,
              runtimeConfig: { type: "ssh", host: "unreachable.invalid", srcBaseDir: "/remote" },
            },
          ],
        });
        return cfg;
      });
      const published: Array<[unknown, string]> = [];
      const startedAt = Date.now();
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { enabledServers: ["shots"] },
        {
          publish: (persisted, workspaceId) => {
            published.push([persisted, workspaceId]);
            return Promise.resolve();
          },
        }
      );
      expect(published).toEqual([
        [{ enabledServers: ["shots"] }, parent.workspaceId],
        [null, remoteChild],
        [null, grandchild],
      ]);
      // No remote I/O was attempted (an unreachable host would take seconds).
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    it("a child file that normalizes to nothing (e.g. after a plugin prune) resumes inheritance", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("pruned-parent");
      const child = await registerChild(parent.workspaceId, "pruned-child");
      await service.setOverridesForWorkspace(parent.workspaceId, { disabledServers: ["shots"] });
      await service.setOverridesForWorkspace(child.workspaceId, {
        enabledServers: ["plugin:0123456789abcdef:echo"],
      });
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        enabledServers: ["plugin:0123456789abcdef:echo"],
      });

      // Uninstall prunes the child's only key; the (now semantically empty) file stays.
      await service.prunePluginOverrideKeys(child.workspaceId, "plugin:0123456789abcdef:");
      expect(await pathExists(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        true
      );
      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({
        disabledServers: ["shots"],
      });

      // …and parent saves reach it again (not classified as an owner).
      const published: string[] = [];
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { disabledServers: ["shots", "more"] },
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      expect(published).toEqual([parent.workspaceId, child.workspaceId]);
    });

    it("a child document with a shape this build cannot read stops resolution at the child", async () => {
      // Valid JSONC that normalizes to nothing here but is NOT known-empty:
      // a newer release may have written it. The child keeps "no overrides"
      // (pre-inheritance behaviour) instead of inheriting a parent enable,
      // and parent saves treat it as an owner.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("opaque-parent");
      await service.setOverridesForWorkspace(parent.workspaceId, { enabledServers: ["shots"] });
      for (const [index, document] of [
        '{ "disabledServers": "shots" }',
        "[]",
        "null",
        '{ "toolAllowlist": { "shots": "take" } }',
      ].entries()) {
        const child = await registerChild(parent.workspaceId, `opaque-child-${index}`);
        await fs.mkdir(path.join(child.workspacePath, ".xum"), { recursive: true });
        await fs.writeFile(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"), document);
        const resolved = await service.getOverridesForWorkspace(child.workspaceId);
        expect(resolved.overrides).toEqual({});
        expect(resolved.authoritative).toBe(true);
      }
      const published: string[] = [];
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { enabledServers: ["shots", "more"] },
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      expect(published).toEqual([parent.workspaceId]);
    });

    it("a removed parent leaves nothing to inherit, even for strict prune re-reads", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const child = await registerChild("ws-removed-parent", "orphan-child");

      expect((await service.getOverridesForWorkspace(child.workspaceId)).overrides).toEqual({});
      // A strict re-read must not throw here: the plugin uninstaller would
      // otherwise retry the orphan's prune tombstone forever.
      expect(
        (await service.getOverridesForWorkspace(child.workspaceId, { mode: "strict" })).overrides
      ).toEqual({});
    });

    it("a stalled publisher callback is bounded and the target evicted instead of holding the lock", async () => {
      // applyWorkspaceOverrides reads the project's MCP config through
      // listServers; a disconnected project filesystem must not keep
      // mcp-overrides.lock held indefinitely — the publication is bounded and
      // the target's cache evicted (its next serve re-reads).
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("pub-stalled-parent");
      const child = await registerChild(parent.workspaceId, "pub-stalled-child");
      const published: Array<[string, unknown]> = [];
      const publish = (persisted: unknown, workspaceId: string) => {
        published.push([workspaceId, persisted]);
        return workspaceId === child.workspaceId && persisted !== null
          ? new Promise<void>(() => undefined)
          : Promise.resolve();
      };
      const startedAt = Date.now();
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { enabledServers: ["shared"] },
        { publish }
      );
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(published).toEqual([
        [parent.workspaceId, { enabledServers: ["shared"] }],
        [child.workspaceId, { enabledServers: ["shared"] }],
        [child.workspaceId, null],
      ]);
      // The lock is free again.
      const release = await service.acquireExclusiveLock();
      await release();
    }, 30_000);

    it("saves and prunes re-publish inheriting descendants with their effective state", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("pub-parent");
      const inheriting = await registerChild(parent.workspaceId, "pub-inheriting");
      const grandchild = await registerChild(inheriting.workspaceId, "pub-grandchild");
      const owned = await registerChild(parent.workspaceId, "pub-owned");
      const ownedChild = await registerChild(owned.workspaceId, "pub-owned-child");
      await service.setOverridesForWorkspace(owned.workspaceId, { disabledServers: ["mine"] });

      const published: Array<[string, unknown]> = [];
      const publish = (persisted: unknown, workspaceId: string) => {
        published.push([workspaceId, persisted]);
        return Promise.resolve();
      };
      await service.setOverridesForWorkspace(
        parent.workspaceId,
        { enabledServers: ["plugin:0123456789abcdef:echo", "shared"] },
        { publish }
      );
      // The written workspace first, then inheriting descendants (transitively).
      // `owned` has its own file, so it and its subtree are left alone.
      expect(published).toEqual([
        [parent.workspaceId, { enabledServers: ["plugin:0123456789abcdef:echo", "shared"] }],
        [inheriting.workspaceId, { enabledServers: ["plugin:0123456789abcdef:echo", "shared"] }],
        [grandchild.workspaceId, { enabledServers: ["plugin:0123456789abcdef:echo", "shared"] }],
      ]);
      expect(published.map(([id]) => id)).not.toContain(owned.workspaceId);
      expect(published.map(([id]) => id)).not.toContain(ownedChild.workspaceId);

      published.length = 0;
      await service.prunePluginOverrideKeys(parent.workspaceId, "plugin:0123456789abcdef:", {
        publish,
      });
      expect(published).toEqual([
        [parent.workspaceId, { enabledServers: ["shared"] }],
        [inheriting.workspaceId, { enabledServers: ["shared"] }],
        [grandchild.workspaceId, { enabledServers: ["shared"] }],
      ]);

      // Clearing a child's own overrides publishes the INHERITED state for it,
      // not `{}`, so a cache mirroring publications resumes inheritance.
      published.length = 0;
      await service.setOverridesForWorkspace(owned.workspaceId, {}, { publish });
      expect(published).toEqual([
        [owned.workspaceId, { enabledServers: ["shared"] }],
        [ownedChild.workspaceId, { enabledServers: ["shared"] }],
      ]);
    });

    it("a child saving the shared file re-publishes the parent (isolation: none, upward)", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const projectPath = path.join(tempDir, "shared-upward");
      await registerLocalWorkspace(projectPath, "up-parent");
      await registerLocalWorkspace(projectPath, "up-child", "up-parent");
      await registerLocalWorkspace(path.join(tempDir, "elsewhere"), "unrelated");

      const published: string[] = [];
      await service.setOverridesForWorkspace(
        "up-child",
        { disabledServers: ["shots"] },
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      // The parent's cache would otherwise keep serving what the child just
      // disabled; workspaces on other checkouts are untouched.
      expect(published.sort()).toEqual(["up-child", "up-parent"]);
    });

    it("recognizes one host checkout registered under a symlinked spelling as a sharer", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const realDir = path.join(tempDir, "real-checkout");
      const linkDir = path.join(tempDir, "linked-checkout");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);
      await registerLocalWorkspace(realDir, "via-real");
      await registerLocalWorkspace(linkDir, "via-link");

      const published: string[] = [];
      await service.setOverridesForWorkspace(
        "via-link",
        { disabledServers: ["shots"] },
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      // Same directory, different project-path spelling: both caches refresh.
      expect(published.sort()).toEqual(["via-link", "via-real"]);
    });

    it("a shared save retires every sharer's legacy config value so a cold alias cannot restore a revoked enable", async () => {
      // Two ids on one checkout (isolation:none task). The alias still carries
      // a legacy config.json enable; clearing the shared document must not let
      // the alias's next own resolution migrate that enable back into the
      // file the user just emptied.
      const service = new WorkspaceMcpOverridesService(config);
      const dir = path.join(tempDir, "shared-legacy-checkout");
      await registerLocalWorkspace(dir, "shared-owner");
      await registerLocalWorkspace(dir, "shared-alias");
      await service.setOverridesForWorkspace("shared-owner", { enabledServers: ["shots"] });
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === "shared-alias");
          if (entry) entry.mcp = { enabledServers: ["shots"] };
        }
        return cfg;
      });

      const published: string[] = [];
      await service.setOverridesForWorkspace(
        "shared-owner",
        {},
        {
          publish: (_persisted, workspaceId) => {
            published.push(workspaceId);
            return Promise.resolve();
          },
        }
      );
      expect(published).toContain("shared-alias");
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === "shared-alias");
      expect(stored?.mcp).toBeUndefined();
      // The alias's own (cold, depth 0) resolution finds nothing to migrate.
      expect((await service.getOverridesForWorkspace("shared-alias")).overrides).toEqual({});
      expect(await pathExists(path.join(dir, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("a failed shared save leaves every sharer's legacy config value intact", async () => {
      // The sharer retirement runs only after the replacement state is
      // persisted: a write that fails must not have discarded an alias's
      // settings while reporting that nothing was saved.
      const service = new WorkspaceMcpOverridesService(config);
      const dir = path.join(tempDir, "shared-legacy-failing-checkout");
      await registerLocalWorkspace(dir, "failing-owner");
      await registerLocalWorkspace(dir, "failing-alias");
      const legacy = { enabledServers: ["shots"] };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === "failing-alias");
          if (entry) entry.mcp = legacy;
        }
        return cfg;
      });
      // `.xum` is a regular file: the overrides directory cannot be created.
      await fs.writeFile(path.join(dir, ".xum"), "not a directory");

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace("failing-owner", { disabledServers: ["shots"] })
      ).rejects.toThrow("Failed to create");
      const stored = [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === "failing-alias");
      expect(stored?.mcp).toEqual(legacy);
    });

    it("evicts a candidate sharer whose checkout cannot be canonicalized instead of assuming it differs", async () => {
      // realpath failing (stalled mount, timeout) for one registration must
      // not let its spelled path pass as proof that it is a different checkout:
      // a tool already served there would otherwise keep running a server the
      // shared file just disabled. Indeterminate → evict that candidate.
      const service = new WorkspaceMcpOverridesService(config);
      const realDir = path.join(tempDir, "real-checkout-indeterminate");
      const linkDir = path.join(tempDir, "linked-checkout-indeterminate");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);
      await registerLocalWorkspace(realDir, "via-real-indeterminate");
      await registerLocalWorkspace(linkDir, "via-link-indeterminate");
      const realRealpath = fsPromisesModule.realpath;
      const realpathSpy = spyOn(fsPromisesModule, "realpath").mockImplementation(((
        target: string
      ) =>
        target.startsWith(realDir)
          ? Promise.reject(new Error("EIO: stalled mount"))
          : realRealpath(target)) as typeof fsPromisesModule.realpath);
      try {
        const published: Array<[string, unknown]> = [];
        await service.setOverridesForWorkspace(
          "via-link-indeterminate",
          { disabledServers: ["shots"] },
          {
            publish: (persisted, workspaceId) => {
              published.push([workspaceId, persisted]);
              return Promise.resolve();
            },
          }
        );
        expect(published).toEqual([
          ["via-link-indeterminate", { disabledServers: ["shots"] }],
          ["via-real-indeterminate", null],
        ]);
      } finally {
        realpathSpy.mockRestore();
      }
    });

    it("re-publishes a child that shares the parent's override file (isolation: none)", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const projectPath = path.join(tempDir, "shared-checkout");
      await registerLocalWorkspace(projectPath, "shared-parent");
      await registerLocalWorkspace(projectPath, "shared-child", "shared-parent");

      const published: Array<[string, unknown]> = [];
      await service.setOverridesForWorkspace(
        "shared-parent",
        { enabledServers: ["shots"] },
        {
          publish: (persisted, workspaceId) => {
            published.push([workspaceId, persisted]);
            return Promise.resolve();
          },
        }
      );
      // The child "owns" that very file, so it must be treated as affected by
      // the write rather than skipped as an independent owner.
      expect(published).toEqual([
        ["shared-parent", { enabledServers: ["shots"] }],
        ["shared-child", { enabledServers: ["shots"] }],
      ]);
    });
  });

  describe("fork copy", () => {
    it("copies the raw source document verbatim into the fork checkout", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-source");
      const raw = `{\n  // keep me\n  "enabledServers": ["shots"],\n  "futureField": { "from": "newer build" }\n}\n`;
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");

      const targetPath = path.join(config.srcDir, "fork-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("carries an opaque legacy value into the fork instead of dropping it", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-opaque-legacy-source");
      const opaque = { disabledServers: "shots", futureField: 1 };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === source.workspaceId);
          if (entry) entry.mcp = opaque as never;
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-opaque-legacy-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(
        jsoncParse(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8"))
      ).toEqual(opaque);
    });

    it("reads a devcontainer source's overrides from the host when forking", async () => {
      // The source container need not be running (forkWorkspace only creates
      // the new worktree); an exec-backed probe would be indeterminate and the
      // copy silently skipped although the file sits on the host worktree.
      const service = new WorkspaceMcpOverridesService(config);
      // In-place registration (projectPath === name) keeps the checkout under
      // the test root regardless of the devcontainer runtime's srcBaseDir.
      const sourcePath = path.join(config.srcDir, "devcontainer-fork-source");
      await fs.mkdir(path.join(sourcePath, ".xum"), { recursive: true });
      const raw = '{ "enabledServers": ["shots"] }\n';
      await fs.writeFile(path.join(sourcePath, ".xum", "mcp.local.jsonc"), raw);
      const workspaceId = "ws-devcontainer-fork-source";
      await config.editConfig((cfg) => {
        cfg.projects.set(sourcePath, {
          workspaces: [
            {
              path: sourcePath,
              id: workspaceId,
              name: sourcePath,
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          ],
        });
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "devcontainer-fork-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("uses a devcontainer source's persisted checkout path in the host view", async () => {
      // Migrated/non-canonical entries persist a path that differs from the
      // name-derived one; the host view must read where the checkout really is.
      const service = new WorkspaceMcpOverridesService(config);
      const persistedPath = path.join(config.srcDir, "elsewhere", "devcontainer-persisted");
      await fs.mkdir(path.join(persistedPath, ".xum"), { recursive: true });
      const raw = '{ "enabledServers": ["shots"] }\n';
      await fs.writeFile(path.join(persistedPath, ".xum", "mcp.local.jsonc"), raw);
      const workspaceId = "ws-devcontainer-persisted";
      await config.editConfig((cfg) => {
        cfg.projects.set("/fake/devcontainer-project", {
          workspaces: [
            {
              path: persistedPath,
              id: workspaceId,
              name: "branch",
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          ],
        });
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "devcontainer-persisted-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("releases the override lock before writing the fork target", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-slow-target-source");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-slow-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      // A target runtime whose writes stall (remote transfer) must not hold
      // the global override lock for unrelated settings writers.
      const realRuntime = createRuntime({ type: "local" }, { projectPath: targetPath });
      let releaseWrite: () => void = () => undefined;
      const writeStarted = new Promise<void>((resolve) => {
        const slowRuntime = Object.create(realRuntime) as typeof realRuntime;
        slowRuntime.writeFile = (...args: Parameters<typeof realRuntime.writeFile>) => {
          resolve();
          const stream = realRuntime.writeFile(...args);
          const realWrite = stream.getWriter.bind(stream);
          stream.getWriter = () => {
            const writer = realWrite();
            const realClose = writer.close.bind(writer);
            writer.close = () => new Promise<void>((r) => (releaseWrite = r)).then(realClose);
            return writer;
          };
          return stream;
        };
        void service
          .copyOverridesToForkedCheckout(source.workspaceId, {
            runtime: slowRuntime,
            workspacePath: targetPath,
            runtimeConfig: undefined,
          })
          .then(() => (copyDone = true));
      });
      let copyDone = false;
      await writeStarted;
      // The lock is free while the target write is still pending.
      const release = await Promise.race([
        service.acquireExclusiveLock(),
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new Error("lock still held during target write")), 2_000)
        ),
      ]);
      expect(copyDone).toBe(false);
      await release();
      releaseWrite();
      while (!copyDone) await new Promise((r) => setTimeout(r, 1));
    });

    it("skips the fork copy rather than normalizing when the source document cannot be reread", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-reread-fails");
      const sourceFile = path.join(source.workspacePath, ".xum", "mcp.local.jsonc");
      await fs.mkdir(path.dirname(sourceFile), { recursive: true });
      await fs.writeFile(
        sourceFile,
        '{\n  // keep\n  "enabledServers": ["shots"], "futureField": 1\n}\n'
      );
      const targetPath = path.join(config.srcDir, "fork-reread-fails-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      // Resolution reads the document (statIsFile + parse) through the
      // runtime; the raw no-follow reread for the copy (an `open` on the host
      // file) then fails — the fork must not receive a lossy rewrite. A failed
      // raw read is first treated as a possibly-vacated path (retry with a
      // fresh resolution), so every raw read fails here; only the terminal
      // locked attempt gives up.
      const realOpen = fsPromisesModule.open;
      let rawReads = 0;
      const openSpy = spyOn(fsPromisesModule, "open").mockImplementation((...args) => {
        if (args[0] === sourceFile) {
          rawReads += 1;
          return Promise.reject(new Error("EIO: persistent"));
        }
        return realOpen(...args);
      });
      try {
        await service.copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        });
      } finally {
        openSpy.mockRestore();
      }
      // 3 unlocked attempts + the locked fallback, one raw read each.
      expect(rawReads).toBe(4);
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("the fork copy waits for the exclusive override lock", async () => {
      // The raw source document read must serialize with concurrent settings
      // saves (a torn read must not become the fork's configuration).
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-locked-source");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-locked-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });

      const release = await service.acquireExclusiveLock();
      let copyDone = false;
      const copy = service
        .copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        })
        .then(() => {
          copyDone = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(copyDone).toBe(false);
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);

      await release();
      await copy;
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(true);
    });

    it("resolves an inheriting source's ancestors outside the lock and only reads the document under it", async () => {
      // An inheriting SSH source probes remote paths per ancestor level; that
      // traversal must not hold the global override lock (unrelated saves would
      // time out). Only the raw document read serializes with writers.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-unlocked-ancestor");
      const raw = `{\n  "enabledServers": ["shots"]\n}\n`;
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");
      const child = await registerWorkspace("fork-unlocked-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-unlocked-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });

      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      let copyDone = false;
      const copy = service
        .copyOverridesToForkedCheckout(child.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        })
        .then(() => {
          copyDone = true;
        });
      // Resolution (including the ancestor walk) completes while the lock is
      // held by someone else; the copy then blocks on the raw read.
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(copyDone).toBe(false);
      await release();
      await copy;
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("re-resolves the fork source when a write completed between resolution and the locked read", async () => {
      // The unlocked resolution picked the ancestor's document; a save (here a
      // sibling process: child file + epoch bump) then made the child's own
      // file authoritative. The stale preparation must not be copied.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-stale-ancestor");
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["parent-only"] })
      );
      const child = await registerWorkspace("fork-stale-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-stale-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });

      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      // Sibling save lands while our lock is held: child-owned file + epoch.
      const childRaw = JSON.stringify({ disabledServers: ["parent-only"] });
      await fs.mkdir(path.join(child.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"), childRaw);
      await fs.writeFile(path.join(config.rootDir, "mcp-overrides.epoch"), "sibling-write");
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        childRaw
      );
    });

    it("re-resolves the fork source when a direct edit gives the child its own document", async () => {
      // A direct edit of `.xum/mcp.local.jsonc` bumps no epoch and rewrites no
      // config; the commit point must still notice that the child now owns a
      // document that takes precedence over the ancestor's the resolution chose.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-direct-ancestor");
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["parent-only"] })
      );
      const child = await registerWorkspace("fork-direct-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-direct-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const childRaw = JSON.stringify({ disabledServers: ["parent-only"] });
      await fs.mkdir(path.join(child.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"), childRaw);
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        childRaw
      );
    });

    it("re-resolves the fork source when the child's document appears after the precedence probe", async () => {
      // The commit point probes precedence, then re-reads the selected
      // ancestor document. A child-owned document created between those two
      // steps leaves the ancestor document unchanged, so only a second probe
      // AFTER the content check can see it.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-late-ancestor");
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["parent-only"] })
      );
      const child = await registerWorkspace("fork-late-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-late-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        forkSourcePrecedenceUnchanged: (...args: unknown[]) => Promise<boolean>;
      };
      const realProbe = internals.forkSourcePrecedenceUnchanged.bind(service);
      const childRaw = JSON.stringify({ disabledServers: ["parent-only"] });
      let probes = 0;
      spyOn(internals, "forkSourcePrecedenceUnchanged").mockImplementation(
        async (...args: unknown[]) => {
          const unchanged = await realProbe(...args);
          probes += 1;
          if (probes === 1) {
            // Direct edit landing right after the first (absent) probe round.
            await fs.mkdir(path.join(child.workspacePath, ".xum"), { recursive: true });
            await fs.writeFile(path.join(child.workspacePath, ".xum", "mcp.local.jsonc"), childRaw);
          }
          return unchanged;
        }
      );

      await service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(probes).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        childRaw
      );
    });

    it("re-resolves the fork source when an ancestor document appears over a child's empty fallback document", async () => {
      // The child's own document normalizes to nothing (recognized-empty) and
      // no ancestor supplies overrides, so the resolution keeps the child file
      // only as the copy source. A parent document created directly before the
      // commit point (no epoch, no config change) now supplies the effective
      // overrides; the transparent child file must not stop the precedence
      // probes from seeing it.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-transparent-ancestor");
      const child = await registerWorkspace("fork-transparent-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });
      await fs.mkdir(path.join(child.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(child.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: [] })
      );
      const targetPath = path.join(config.srcDir, "fork-transparent-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        if ((args[3] ?? 0) === 0) resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const parentRaw = JSON.stringify({ enabledServers: ["parent-only"] });
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"), parentRaw);
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        parentRaw
      );
    });

    it("re-resolves the fork source when a higher-priority candidate appears at the owner", async () => {
      // The resolution selected the legacy-named `.mux/mcp.local.jsonc`; a
      // direct edit then creates the canonical `.xum/` document, which takes
      // precedence at the same level.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-owner-precedence");
      await fs.mkdir(path.join(source.workspacePath, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".mux", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["legacy-enable"] })
      );
      const targetPath = path.join(config.srcDir, "fork-owner-precedence-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const canonicalRaw = JSON.stringify({ disabledServers: ["legacy-enable"] });
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), canonicalRaw);
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        canonicalRaw
      );
    });

    it("re-resolves the fork source when it was renamed between resolution and the locked read", async () => {
      // A rename rewrites config under the override lock without bumping the
      // epoch; the unlocked resolution read the document at the old path.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-renamed-source");
      const raw = JSON.stringify({ enabledServers: ["shots"] });
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), raw);
      const targetPath = path.join(config.srcDir, "fork-renamed-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      // Rename lands under the lock: checkout moves, config rewritten, no epoch.
      const renamedPath = getWorkspacePath({
        srcDir: config.srcDir,
        projectName: "fork-renamed-source",
        workspaceName: "renamed",
      });
      await fs.rename(source.workspacePath, renamedPath);
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === source.workspaceId);
          if (entry) {
            entry.name = "renamed";
            entry.path = renamedPath;
          }
        }
        return cfg;
      });
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("does not migrate a legacy value that a save cleared before the fork acquired the lock", async () => {
      // The pre-lock config snapshot saw a legacy `workspace.mcp` enable; a
      // clearing save then removed it (and the file). Resolving under the lock
      // from the stale snapshot would migrate the revoked enable back into the
      // source and copy it into the fork.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-legacy-cleared");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === source.workspaceId);
          if (entry) entry.mcp = { enabledServers: ["revoked"] };
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-legacy-cleared-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The clearing save completes while the fork waits for the lock (a
      // sibling process here: config edit + epoch bump).
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === source.workspaceId);
          if (entry) delete entry.mcp;
        }
        return cfg;
      });
      await fs.writeFile(path.join(config.rootDir, "mcp-overrides.epoch"), "cleared");
      await release();
      await copy;
      expect(await pathExists(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
        false
      );
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("re-resolves the fork source when an ancestor's legacy value was revoked between resolution and the locked commit", async () => {
      // The source inherits from a parent whose only configuration is an
      // unmigrated legacy `workspace.mcp` enable (inheritance reads it
      // read-only, so no document exists to re-read at the commit point). A
      // direct config edit / older Xum process then revokes it without an
      // epoch bump; the fork must not persist the revoked enable.
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-legacy-ancestor");
      const child = await registerWorkspace("fork-legacy-ancestor-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          for (const entry of project.workspaces) {
            if (entry.id === parent.workspaceId) entry.mcp = { enabledServers: ["revoked"] };
            if (entry.id === child.workspaceId) entry.parentWorkspaceId = parent.workspaceId;
          }
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-legacy-ancestor-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const realResolve = internals.resolveOverridesFor.bind(service);
      // Top-level (depth 0) resolutions only; the inherited parent step recurses.
      let resolutions = 0;
      spyOn(internals, "resolveOverridesFor").mockImplementation(async (...args: unknown[]) => {
        const result = await realResolve(...args);
        if ((args[3] ?? 0) === 0) resolutions += 1;
        return result;
      });

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      while (resolutions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      // Legacy revoked with no epoch bump and no config identity change.
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === parent.workspaceId);
          if (entry) delete entry.mcp;
        }
        return cfg;
      });
      await release();
      await copy;
      expect(resolutions).toBeGreaterThan(1);
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("keeps a source with a legacy config.json value fully under the lock (it may migrate)", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-legacy-locked");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === source.workspaceId);
          if (entry) entry.mcp = { enabledServers: ["legacy-only"] };
        }
        return cfg;
      });
      const targetPath = path.join(config.srcDir, "fork-legacy-locked-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      const resolveSpy = spyOn(internals, "resolveOverridesFor");

      const release = await service.acquireExclusiveLock();
      const copy = service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // No resolution (hence no migration write) until the lock is ours.
      expect(resolveSpy).not.toHaveBeenCalled();
      await release();
      await copy;
      expect(
        jsoncParse(
          await fs.readFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), "utf-8")
        )
      ).toEqual({ enabledServers: ["legacy-only"] });
      expect(
        jsoncParse(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8"))
      ).toEqual({ enabledServers: ["legacy-only"] });
    });

    it("writes a devcontainer fork's copy on the host even when the runtime is a multi-project wrapper", async () => {
      // A multi-project devcontainer fork's runtime is a MultiProjectRuntime
      // wrapping the (not yet started) devcontainers: any exec/stat through it
      // fails, so the host filesystem view must be chosen from the runtime
      // CONFIG, not the runtime class.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-wrapped-devcontainer");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-wrapped-target");
      await fs.mkdir(targetPath, { recursive: true });
      const unstartedContainer = createRuntime({ type: "local" }, { projectPath: targetPath });
      const wrapper = Object.create(unstartedContainer) as typeof unstartedContainer;
      const refuse = (): never => {
        throw new Error("container not started");
      };
      wrapper.exec = refuse;
      wrapper.stat = refuse;
      wrapper.writeFile = refuse;
      wrapper.readFile = refuse;
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: wrapper,
        workspacePath: targetPath,
        runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
      });
      expect(
        jsoncParse(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8"))
      ).toEqual({ enabledServers: ["shots"] });
    });

    it("forking an inheriting sub-agent copies the ancestor's raw document", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const parent = await registerWorkspace("fork-ancestor");
      const raw = `{\n  // ancestor comment\n  "enabledServers": ["shots"],\n  "futureField": 1\n}\n`;
      await fs.mkdir(path.join(parent.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(parent.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");
      const child = await registerWorkspace("fork-inheriting-source");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === child.workspaceId);
          if (entry) entry.parentWorkspaceId = parent.workspaceId;
        }
        return cfg;
      });

      const targetPath = path.join(config.srcDir, "fork-ancestor-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(child.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("strips Agent Plugin keys from the copy while keeping comments and unknown fields", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-plugins");
      const raw = `{\n  // keep me\n  "enabledServers": ["plugin:0123456789abcdef:echo", "shots"],\n  "toolAllowlist": { "plugin:0123456789abcdef:echo": ["x"], "shots": ["take_screenshot"] },\n  "futureField": true\n}\n`;
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");

      const targetPath = path.join(config.srcDir, "fork-plugins-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      const copied = await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8");
      // A fresh checkout has no consent context for plugin servers: the copy
      // must not carry an enable the fork's first request would act on.
      expect(copied).toContain("// keep me");
      expect(jsoncParse(copied)).toEqual({
        enabledServers: ["shots"],
        toolAllowlist: { shots: ["take_screenshot"] },
        futureField: true,
      });
    });

    it("refuses the copy when a field this build does not own still carries a plugin key", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-future-plugin");
      // Pruning succeeds (owned fields are clean) but a future field smuggles a key.
      const raw = `{ "enabledServers": ["shots"], "futureEnables": ["plugin:0123456789abcdef:echo"] }\n`;
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");

      const targetPath = path.join(config.srcDir, "fork-future-plugin-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("refuses to write through a symlinked or tracked target path", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-symlink-source");
      await service.setOverridesForWorkspace(source.workspaceId, { enabledServers: ["shots"] });
      const outside = path.join(tempDir, "outside-the-checkout");
      await fs.mkdir(outside, { recursive: true });

      // Repo-controlled `.xum -> ../outside` link: the write must not escape.
      const linkedDir = path.join(config.srcDir, "fork-linked-dir", "branch");
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.symlink(outside, path.join(linkedDir, ".xum"));
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: linkedDir }),
        workspacePath: linkedDir,
        runtimeConfig: undefined,
      });
      expect(await fs.readdir(outside)).toEqual([]);

      // Tracked regular file at the path: repo content is left untouched.
      const tracked = path.join(config.srcDir, "fork-tracked", "branch");
      await fs.mkdir(path.join(tracked, ".xum"), { recursive: true });
      await fs.writeFile(path.join(tracked, ".xum", "mcp.local.jsonc"), "{}\n", "utf-8");
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: tracked }),
        workspacePath: tracked,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(tracked, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        "{}\n"
      );
    });

    it("keeps an uninspectable document unless it could hide a plugin key", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const write = async (name: string, raw: string) => {
        const source = await registerWorkspace(name);
        await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
        await fs.writeFile(
          path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
          raw,
          "utf-8"
        );
        const targetPath = path.join(config.srcDir, `${name}-target`, "branch");
        await fs.mkdir(targetPath, { recursive: true });
        await service.copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        });
        return path.join(targetPath, ".xum", "mcp.local.jsonc");
      };
      // Newer-build shape for an owned field: pruning cannot inspect it, but
      // the text provably contains no canonical plugin key => copied verbatim.
      const opaqueSafe = `{ "enabledServers": { "v2": ["shots"] } }\n`;
      expect(await fs.readFile(await write("fork-opaque-safe", opaqueSafe), "utf-8")).toBe(
        opaqueSafe
      );
      // Same opaque shape carrying a plugin key => consent wins, nothing copied.
      const opaquePlugin = `{ "enabledServers": { "v2": ["plugin:0123456789abcdef:echo"] } }\n`;
      expect(await pathExists(await write("fork-opaque-plugin", opaquePlugin))).toBe(false);
      // JSON escapes must not smuggle a key past the screen (decoded strings are inspected).
      const escaped = `{ "enabledServers": { "v2": ["plugin\\u003a0123456789abcdef\\u003aecho"] } }\n`;
      expect(await pathExists(await write("fork-opaque-escaped", escaped))).toBe(false);
    });

    it("copies a document this build cannot interpret rather than dropping it", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-future");
      const raw = `{ "futureField": ["from a newer build"] }\n`;
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(path.join(source.workspacePath, ".xum", "mcp.local.jsonc"), raw, "utf-8");
      // Normalizes to {} here, yet the fork must keep the file for a later upgrade.
      expect((await service.getOverridesForWorkspace(source.workspaceId)).overrides).toEqual({});

      const targetPath = path.join(config.srcDir, "fork-future-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await fs.readFile(path.join(targetPath, ".xum", "mcp.local.jsonc"), "utf-8")).toBe(
        raw
      );
    });

    it("migrates legacy config.json overrides before deciding a shared-checkout fork needs no copy", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const projectPath = path.join(tempDir, "fork-legacy-project");
      await registerLocalWorkspace(projectPath, "fork-legacy");
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === "fork-legacy");
          if (entry) entry.mcp = { enabledServers: ["legacy-only"] };
        }
        return cfg;
      });

      // Same path as the source (project-dir fork): nothing to copy, but the
      // legacy entry must land in the shared file or the fork sees nothing.
      await service.copyOverridesToForkedCheckout("fork-legacy", {
        runtime: createRuntime({ type: "local" }, { projectPath }),
        workspacePath: projectPath,
        runtimeConfig: { type: "local" },
      });
      expect(
        jsoncParse(await fs.readFile(path.join(projectPath, ".xum", "mcp.local.jsonc"), "utf-8"))
      ).toEqual({ enabledServers: ["legacy-only"] });
    });

    it("materializes an opaque legacy value into the shared file for a same-checkout fork", async () => {
      // The opaque value lives only in the source's ID-scoped config entry;
      // a project-dir fork shares the checkout but gets a new id, so without
      // the file it would lose the forward-compatible configuration for good.
      const service = new WorkspaceMcpOverridesService(config);
      const projectPath = path.join(tempDir, "fork-opaque-shared-project");
      await registerLocalWorkspace(projectPath, "fork-opaque-shared");
      const opaque = { disabledServers: "shots", futureField: 1 };
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === "fork-opaque-shared");
          if (entry) entry.mcp = opaque as never;
        }
        return cfg;
      });
      await service.copyOverridesToForkedCheckout("fork-opaque-shared", {
        runtime: createRuntime({ type: "local" }, { projectPath }),
        workspacePath: projectPath,
        runtimeConfig: { type: "local" },
      });
      expect(
        jsoncParse(await fs.readFile(path.join(projectPath, ".xum", "mcp.local.jsonc"), "utf-8"))
      ).toEqual(opaque);
      // The source resolves exactly as before: child-owned, nothing this
      // build can read.
      expect(await service.getOverridesForWorkspace("fork-opaque-shared")).toMatchObject({
        overrides: {},
        authoritative: true,
      });
    });

    it("skips the fork copy when git exclude coverage cannot be established", async () => {
      // A fresh checkout has no override document; creating one Git can see
      // would let workspace-local authorization settings be committed by
      // accident. Coverage is installed strictly BEFORE the write.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-exclude-source");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-exclude-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await execBuffered(
        createRuntime({ type: "local" }, { projectPath: targetPath }),
        "git init -q",
        {
          cwd: targetPath,
          timeout: 10,
        }
      );
      // The exclude file's directory is unwritable: installing the pattern fails.
      const infoDir = path.join(targetPath, ".git", "info");
      await fs.mkdir(infoDir, { recursive: true });
      await fs.writeFile(path.join(infoDir, "exclude"), "");
      await fs.chmod(infoDir, 0o500);
      await fs.chmod(path.join(infoDir, "exclude"), 0o400);
      try {
        // chmod cannot block root; the classification is exercised on ordinary CI users.
        if (process.getuid?.() === 0) return;
        await service.copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        });
        expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
      } finally {
        await fs.chmod(infoDir, 0o700);
        await fs.chmod(path.join(infoDir, "exclude"), 0o600);
      }
    });

    it("skips the fork copy when the strict git probe fails without a definitive answer", async () => {
      // A nonzero `git rev-parse --git-path` (transient Git failure) is not
      // "nothing to ignore": strict mode must treat it as unverified coverage
      // and write nothing, instead of returning normally like the lenient path.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-probe-source");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-probe-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const real = createRuntime({ type: "local" }, { projectPath: targetPath });
      await execBuffered(real, "git init -q", { cwd: targetPath, timeout: 10 });
      const flaky = Object.create(real) as typeof real;
      flaky.exec = (command, options) =>
        real.exec(
          command.includes("--git-path") ? "echo 'fatal: transient' >&2; exit 1" : command,
          options
        );
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: flaky,
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
      // Git's definitive "not a git repository" remains a non-failure: a
      // checkout Git cannot see has nothing to commit.
      const plainPath = path.join(config.srcDir, "fork-probe-plain");
      await fs.mkdir(plainPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: plainPath }),
        workspacePath: plainPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(plainPath, ".xum", "mcp.local.jsonc"))).toBe(true);
    });

    it("never replaces an unreadable git exclude file with only the Xum patterns", async () => {
      // The exclude update rewrites the whole file: an unreadable existing
      // file (EACCES, transient I/O) must abort the update — and, strictly,
      // the fork copy — instead of being treated as empty and erased.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-exclude-unreadable-source");
      await fs.mkdir(path.join(source.workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(source.workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      const targetPath = path.join(config.srcDir, "fork-exclude-unreadable-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await execBuffered(
        createRuntime({ type: "local" }, { projectPath: targetPath }),
        "git init -q",
        {
          cwd: targetPath,
          timeout: 10,
        }
      );
      const excludePath = path.join(targetPath, ".git", "info", "exclude");
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      const personal = "# personal\nscratch/\n";
      await fs.writeFile(excludePath, personal);
      await fs.chmod(excludePath, 0o000);
      try {
        // chmod cannot block root; the classification is exercised on ordinary CI users.
        if (process.getuid?.() === 0) return;
        await service.copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        });
        expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
      } finally {
        await fs.chmod(excludePath, 0o600);
      }
      expect(await fs.readFile(excludePath, "utf-8")).toBe(personal);
    });

    it("the send-path read is bounded and yields a non-authoritative result on timeout", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("bounded-read");
      const internals = service as unknown as {
        resolveOverridesFor: (...args: unknown[]) => Promise<unknown>;
      };
      spyOn(internals, "resolveOverridesFor").mockImplementation(
        () => new Promise(() => undefined)
      );
      const read = await service.getOverridesForWorkspace(source.workspaceId, { timeoutMs: 20 });
      expect(read).toMatchObject({ overrides: {}, authoritative: false });
      // Strict callers get the failure instead of a guess.
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.getOverridesForWorkspace(source.workspaceId, { mode: "strict", timeoutMs: 20 })
      ).rejects.toThrow("timed out");
      // …and an already-aborted signal short-circuits the same way.
      const aborted = await service.getOverridesForWorkspace(source.workspaceId, {
        signal: AbortSignal.abort(),
      });
      expect(aborted.authoritative).toBe(false);
    });

    it("gives up at one absolute deadline instead of a fresh budget per retry", async () => {
      // Sustained settings activity keeps invalidating unlocked preparations;
      // WorkspaceService.fork awaits this best-effort copy before init, so
      // retries, the locked fallback and the target write must all draw on
      // the same budget rather than each resetting it.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-deadline");
      await service.setOverridesForWorkspace(source.workspaceId, { enabledServers: ["shots"] });
      const targetPath = path.join(config.srcDir, "fork-deadline-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      const internals = service as unknown as {
        prepareForkCopySource: (...args: unknown[]) => Promise<unknown>;
      };
      const realNow = Date.now;
      let skewMs = 0;
      const nowSpy = spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
      const prepare = spyOn(internals, "prepareForkCopySource").mockImplementation(() => {
        // The attempt consumed the whole operation budget before going stale.
        skewMs += 61_000;
        return Promise.resolve("stale");
      });
      let attempts: number;
      try {
        await service.copyOverridesToForkedCheckout(source.workspaceId, {
          runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
          workspacePath: targetPath,
          runtimeConfig: undefined,
        });
        attempts = prepare.mock.calls.length;
      } finally {
        nowSpy.mockRestore();
        prepare.mockRestore();
      }
      // No second attempt and no locked fallback once the budget is spent.
      expect(attempts).toBe(1);
      expect(await pathExists(path.join(targetPath, ".xum"))).toBe(false);
    });

    it("refuses to copy a source document reached through a symlink", async () => {
      // SECURITY: the source document is copied RAW into the fork's checkout;
      // a repo-tracked symlink at the source path would exfiltrate a host
      // file (here a stand-in for providers.jsonc) into the target, where the
      // repo's init hook can read it.
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-symlink-source");
      const secret = path.join(config.rootDir, "providers.jsonc");
      await fs.writeFile(secret, JSON.stringify({ apiKey: "sk-secret" }));
      await fs.mkdir(path.join(source.workspacePath, ".mux"), { recursive: true });
      await fs.symlink(secret, path.join(source.workspacePath, ".mux", "mcp.local.jsonc"));
      const targetPath = path.join(config.srcDir, "fork-symlink-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);

      // A symlinked DIRECTORY segment is refused the same way.
      await fs.rm(path.join(source.workspacePath, ".mux"), { recursive: true, force: true });
      const elsewhere = path.join(config.rootDir, "elsewhere");
      await fs.mkdir(elsewhere, { recursive: true });
      await fs.writeFile(
        path.join(elsewhere, "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["shots"] })
      );
      await fs.symlink(elsewhere, path.join(source.workspacePath, ".xum"));
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(targetPath, ".xum", "mcp.local.jsonc"))).toBe(false);
    });

    it("does nothing when the source has no effective overrides", async () => {
      const service = new WorkspaceMcpOverridesService(config);
      const source = await registerWorkspace("fork-empty");
      const targetPath = path.join(config.srcDir, "fork-empty-target", "branch");
      await fs.mkdir(targetPath, { recursive: true });
      await service.copyOverridesToForkedCheckout(source.workspaceId, {
        runtime: createRuntime({ type: "local" }, { projectPath: targetPath }),
        workspacePath: targetPath,
        runtimeConfig: undefined,
      });
      expect(await pathExists(path.join(targetPath, ".xum"))).toBe(false);
    });
  });

  it("serves no overrides when a higher-priority candidate cannot be probed", async () => {
    // `.xum/` unreadable (EACCES → indeterminate) while the legacy-named
    // `.mux/mcp.local.jsonc` is readable and enables a server: the hidden
    // canonical document takes precedence and may disable it, so with
    // precedence unestablished nothing is served, and nothing is trusted.
    // chmod cannot block root; the classification is exercised on ordinary CI users.
    if (process.getuid?.() === 0) return;
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("hidden-canonical");
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".mux", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["shots"] })
    );
    const blockedDir = path.join(workspacePath, ".xum");
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.chmod(blockedDir, 0o000);
    try {
      const resolved = await service.getOverridesForWorkspace(workspaceId);
      expect(resolved.overrides).toEqual({});
      expect(resolved.authoritative).toBe(false);
    } finally {
      await fs.chmod(blockedDir, 0o755);
    }
  });

  it("refuses a non-empty save while the canonical document cannot be probed", async () => {
    // The write replaces exactly the file that could not be read: once I/O
    // recovers it would have truncated a newer version's fields it never saw.
    if (process.getuid?.() === 0) return;
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("unprobed-canonical");
    const blockedDir = path.join(workspacePath, ".xum");
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(
      path.join(blockedDir, "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["shots"], futureField: true })
    );
    await fs.chmod(blockedDir, 0o000);
    try {
      for (const options of [undefined, { expectedRevision: MCP_OVERRIDES_REVISION_UNAVAILABLE }]) {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
        await expect(
          service.setOverridesForWorkspace(workspaceId, { disabledServers: ["other"] }, options)
        ).rejects.toThrow(/Could not read the workspace's current MCP settings document/);
      }
    } finally {
      await fs.chmod(blockedDir, 0o755);
    }
    expect(
      JSON.parse(await fs.readFile(path.join(blockedDir, "mcp.local.jsonc"), "utf-8"))
    ).toEqual({
      enabledServers: ["shots"],
      futureField: true,
    });
  });

  it("serves the canonical document strictly when only a lower-priority path cannot be probed", async () => {
    // The canonical `.xum/mcp.local.jsonc` is valid while the legacy-named
    // `.mux/` directory is unreadable (EACCES): whatever `.mux/` holds is
    // shadowed by the canonical document, so precedence IS established and
    // the strict settings read must not report the state as unavailable —
    // saving that sentinel would then conflict forever against the valid
    // document, leaving MCP settings impossible to view or edit.
    if (process.getuid?.() === 0) return;
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("shadowed-blocked");
    await fs.mkdir(path.join(workspacePath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["shots"] })
    );
    const blockedDir = path.join(workspacePath, ".mux");
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.chmod(blockedDir, 0o000);
    try {
      const resolved = await service.getOverridesForWorkspace(workspaceId, { mode: "strict" });
      expect(resolved.overrides).toEqual({ enabledServers: ["shots"] });
      expect(resolved.authoritative).toBe(true);
      // And the save path (CAS against that revision) accepts the revision.
      await service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["shots", "other"] },
        { expectedRevision: resolved.revision }
      );
      expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
        enabledServers: ["shots", "other"],
      });
    } finally {
      await fs.chmod(blockedDir, 0o755);
    }
  });

  it("keeps fields it does not own when saving over a newer version's document", async () => {
    // A newer Xum wrote a document with a field this build does not know
    // (upgrade↔downgrade must be friction-free): saving from this build
    // patches the known fields into that document instead of round-tripping
    // the normalized object, and clearing the known fields keeps the document.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("opaque-fields");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ futureField: { deny: ["shots"] }, enabledServers: ["shots"] })
    );

    const first = await service.getOverridesForWorkspace(workspaceId);
    expect(first.overrides).toEqual({ enabledServers: ["shots"] });
    await service.setOverridesForWorkspace(
      workspaceId,
      { enabledServers: ["shots", "other"] },
      { expectedRevision: first.revision }
    );
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      futureField: { deny: ["shots"] },
      enabledServers: ["shots", "other"],
    });

    const second = await service.getOverridesForWorkspace(workspaceId);
    await service.setOverridesForWorkspace(workspaceId, {}, { expectedRevision: second.revision });
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      futureField: { deny: ["shots"] },
    });
    // The remaining document is the workspace's own configuration: it does
    // not resume inheritance, and a retry of the clear is idempotent.
    const cleared = await service.getOverridesForWorkspace(workspaceId);
    expect(cleared.overrides).toEqual({});
    await service.setOverridesForWorkspace(workspaceId, {}, { expectedRevision: second.revision });
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      futureField: { deny: ["shots"] },
    });
  });

  it("carries an opaque legacy value's unknown fields into the saved document instead of clearing them", async () => {
    // A newer Xum wrote a `workspace.mcp` value this build does not recognize;
    // the dialog shows `{}` and its save retires the legacy value — the
    // newer version's fields must move into the document, not vanish.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("opaque-legacy-save");
    const setLegacy = (value: unknown) =>
      config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const entry = project.workspaces.find((w) => w.id === workspaceId);
          if (entry) entry.mcp = value as never;
        }
        return cfg;
      });
    // Unknown fields only: a value that also carries known settings the
    // dialog could not show refuses the save instead (see the mixed-value test).
    await setLegacy({ futureField: { deny: ["shots"] } });
    const read = await service.getOverridesForWorkspace(workspaceId);
    expect(read.overrides).toEqual({});
    await service.setOverridesForWorkspace(
      workspaceId,
      { enabledServers: ["other"] },
      { expectedRevision: read.revision }
    );
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      futureField: { deny: ["shots"] },
      enabledServers: ["other"],
    });
    const storedLegacy = () =>
      [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === workspaceId)?.mcp;
    expect(storedLegacy()).toBeUndefined();

    // A legacy shape that cannot live in a document at all refuses the save
    // and stays in place: only a build that understands it may replace it.
    await fs.rm(filePath);
    await setLegacy(null);
    const opaque = await service.getOverridesForWorkspace(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other"] },
        { expectedRevision: opaque.revision }
      )
    ).rejects.toThrow("newer version");
    expect(storedLegacy()).toBeNull();
    expect(await pathExists(filePath)).toBe(false);
  });

  it("a clearing save is failure-atomic: legacy values retire before the document goes", async () => {
    // Removing the document first would expose a shadowed legacy enable as
    // authoritative if a later step failed — re-enabling a globally disabled
    // server after the save reported failure.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("atomic-clear");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ disabledServers: ["shots"] }));
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === workspaceId);
        if (entry) entry.mcp = { enabledServers: ["shots"] };
      }
      return cfg;
    });
    const internals = service as unknown as {
      clearLegacyOverridesInConfig: (...args: unknown[]) => Promise<void>;
    };
    spyOn(internals, "clearLegacyOverridesInConfig").mockImplementationOnce(() =>
      Promise.reject(new Error("config.json unwritable"))
    );
    const before = await readWorkspaceOverridesEpochToken(config.rootDir);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.setOverridesForWorkspace(workspaceId, {})).rejects.toThrow(
      "config.json unwritable"
    );
    // The document still shadows the legacy enable; nothing changed.
    expect(await pathExists(filePath)).toBe(true);
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
      disabledServers: ["shots"],
    });
    expect(await readWorkspaceOverridesEpochToken(config.rootDir)).toBe(before);

    await service.setOverridesForWorkspace(workspaceId, {});
    expect(await pathExists(filePath)).toBe(false);
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({});
    expect(await readWorkspaceOverridesEpochToken(config.rootDir)).not.toBe(before);
  });

  it("SSH registrations under different projects share a checkout by identity and path", async () => {
    // Two SSH registrations of one host + remote path under different project
    // entries mutate the same remote file: a save through one must retire the
    // other's legacy value, or it migrates back on the alias's next read.
    const service = new WorkspaceMcpOverridesService(config);
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/ssh-proj-a", {
        workspaces: [
          {
            path: "/remote/shared",
            id: "ws-ssh-proj-a",
            name: "shared",
            runtimeConfig: { type: "ssh", host: "remote.invalid", srcBaseDir: "/remote" },
          },
        ],
      });
      cfg.projects.set("/fake/ssh-proj-b", {
        workspaces: [
          {
            path: "/remote/shared",
            id: "ws-ssh-proj-b",
            name: "shared",
            mcp: { enabledServers: ["shots"] },
            runtimeConfig: { type: "ssh", host: "remote.invalid", srcBaseDir: "/remote" },
          },
        ],
      });
      return cfg;
    });
    const internals = service as unknown as {
      getRuntimeAndWorkspacePath: (
        id: string
      ) => Promise<{ metadata: unknown; workspacePath: string }>;
      planSharersLegacyRetirement: (
        workspaceId: string,
        written: unknown,
        writtenPath: string,
        snapshot: unknown
      ) => Promise<{ sharerIds: string[] }>;
    };
    // The snapshot surface the planner and sharer scan read (no remote I/O:
    // off-host paths canonicalize to themselves).
    const snapshot = {
      loadLegacyConfig: () => config.loadConfigOrDefault({ throwOnError: true }),
      loadAllMetadata: () =>
        config.getAllWorkspaceMetadata({ throwOnError: true, probeCheckouts: false }),
      canonicalize: (_identity: string, filePath: string) => Promise.resolve(filePath),
    };
    const written = await internals.getRuntimeAndWorkspacePath("ws-ssh-proj-a");
    const plan = await internals.planSharersLegacyRetirement(
      "ws-ssh-proj-a",
      written.metadata,
      path.posix.join(written.workspacePath, ".xum", "mcp.local.jsonc"),
      snapshot
    );
    expect(plan.sharerIds).toEqual(["ws-ssh-proj-b"]);

    // A registration on ANOTHER SSH identity with the same remote path may be
    // an ssh_config alias of the same machine: unverifiable, so a save while
    // it carries a legacy value is refused rather than leaving that value to
    // migrate back over the write.
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/ssh-proj-c", {
        workspaces: [
          {
            path: "/remote/shared",
            id: "ws-ssh-alias-c",
            name: "shared",
            mcp: { enabledServers: ["shots"] },
            runtimeConfig: { type: "ssh", host: "alias-of-remote", srcBaseDir: "/remote" },
          },
        ],
      });
      return cfg;
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      internals.planSharersLegacyRetirement(
        "ws-ssh-proj-a",
        written.metadata,
        path.posix.join(written.workspacePath, ".xum", "mcp.local.jsonc"),
        snapshot
      )
    ).rejects.toThrow("may share this checkout");
  });

  it("refuses a save when checkout sharers carry conflicting opaque legacy fields", async () => {
    // Two registrations of one checkout each hold a newer version's data with
    // the same unknown field but different values: a last-write-wins merge
    // would keep one and the save would clear the other for good.
    const service = new WorkspaceMcpOverridesService(config);
    const shared = path.join(config.srcDir, "conflict-shared");
    await registerLocalWorkspace(shared, "ws-conflict-a");
    await registerLocalWorkspace(shared, "ws-conflict-b");
    // A newer version's shape this build does not recognize.
    const opaque = (value: number): unknown => ({ futureField: value });
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const entry of project.workspaces) {
          if (entry.id === "ws-conflict-a") entry.mcp = opaque(1) as never;
          if (entry.id === "ws-conflict-b") entry.mcp = opaque(2) as never;
        }
      }
      return cfg;
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace("ws-conflict-a", { enabledServers: ["shots"] })
    ).rejects.toThrow("conflicting");
    expect(await pathExists(path.join(shared, ".xum", "mcp.local.jsonc"))).toBe(false);
    // Agreeing values merge fine and both legacy values are retired.
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const entry of project.workspaces) {
          if (entry.id === "ws-conflict-b") entry.mcp = opaque(1) as never;
        }
      }
      return cfg;
    });
    await service.setOverridesForWorkspace("ws-conflict-a", { enabledServers: ["shots"] });
    expect(
      JSON.parse(await fs.readFile(path.join(shared, ".xum", "mcp.local.jsonc"), "utf8"))
    ).toEqual({ futureField: 1, enabledServers: ["shots"] });
  });

  it("rolls back a legacy migration whose epoch signal failed so a later read retries it", async () => {
    // A document left behind without the durable signal would stop every later
    // read (never retrying the bump), leaving another backend's pre-migration
    // cache trusted for good.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("migration-rollback");
    const legacyValue = { enabledServers: ["shots"] };
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === workspaceId);
        if (entry) entry.mcp = legacyValue;
      }
      return cfg;
    });
    const internals = service as unknown as { bumpOverridesEpoch: () => Promise<void> };
    const realBump = internals.bumpOverridesEpoch.bind(service);
    // An older process persists a compatibility-path document while the
    // signal fails: the rollback must delete exactly the migrated document.
    const olderProcessDoc = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    const replacement = JSON.stringify({ disabledServers: ["replaced"] });
    let failures = 0;
    const bump = spyOn(internals, "bumpOverridesEpoch").mockImplementation(async () => {
      failures += 1;
      if (failures === 1) {
        await fs.mkdir(path.dirname(olderProcessDoc), { recursive: true });
        await fs.writeFile(olderProcessDoc, JSON.stringify({ disabledServers: ["other"] }));
      } else {
        // Second attempt: a direct edit REPLACED the canonical document
        // between the migration write and the failed signal; the rollback
        // must leave the replacement alone.
        await fs.writeFile(filePath, replacement);
      }
      throw new Error("epoch file unwritable");
    });
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual(legacyValue);
    expect(await pathExists(filePath)).toBe(false);
    expect(await pathExists(olderProcessDoc)).toBe(true);
    await fs.rm(olderProcessDoc);
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual(legacyValue);
    expect(await fs.readFile(filePath, "utf8")).toBe(replacement);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["mcp.local.jsonc"]);
    await fs.rm(filePath);
    const storedLegacy = () =>
      [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((w) => w.id === workspaceId)?.mcp;
    expect(storedLegacy()).toEqual(legacyValue);

    bump.mockImplementation(realBump);
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual(legacyValue);
    expect(await pathExists(filePath)).toBe(true);
    expect(storedLegacy()).toBeUndefined();
  });

  it("a non-empty save moves the epoch before retiring legacy values", async () => {
    // The document is the durable state (it shadows every legacy value), so
    // a sibling about to launch a server this save revokes must observe the
    // epoch without waiting for the per-sharer config edits.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId } = await registerWorkspace("epoch-before-legacy");
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === workspaceId);
        if (entry) entry.mcp = { enabledServers: ["shots"] };
      }
      return cfg;
    });
    const before = await readWorkspaceOverridesEpochToken(config.rootDir);
    const internals = service as unknown as {
      clearLegacyOverridesInConfig: (...args: unknown[]) => Promise<void>;
    };
    const realClear = internals.clearLegacyOverridesInConfig.bind(service);
    let epochAtClear: string | undefined;
    spyOn(internals, "clearLegacyOverridesInConfig").mockImplementation(
      async (...args: unknown[]) => {
        epochAtClear = await readWorkspaceOverridesEpochToken(config.rootDir);
        return realClear(...args);
      }
    );
    await service.setOverridesForWorkspace(workspaceId, { disabledServers: ["shots"] });
    expect(epochAtClear).toBeDefined();
    expect(epochAtClear).not.toBe(before);
  });

  it("clearing settings refuses to remove through a symlinked override directory", async () => {
    // SECURITY: `rm -f .xum/mcp.local.jsonc` follows a repo-tracked `.xum`
    // symlink and would delete a sibling checkout's document.
    const service = new WorkspaceMcpOverridesService(config);
    const victim = await registerWorkspace("rm-symlink-victim");
    const source = await registerWorkspace("rm-symlink-source");
    await service.setOverridesForWorkspace(victim.workspaceId, { enabledServers: ["shots"] });
    await fs.symlink(
      path.join(victim.workspacePath, ".xum"),
      path.join(source.workspacePath, ".xum")
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.setOverridesForWorkspace(source.workspaceId, {})).rejects.toThrow(
      "symbolic link"
    );
    expect((await service.getOverridesForWorkspace(victim.workspaceId)).overrides).toEqual({
      enabledServers: ["shots"],
    });
  });

  it("refuses to save over a valid document whose root is not an object", async () => {
    // A newer Xum wrote `null`/an array as the document: nothing of it can
    // live next to this build's fields, so the save must not replace it.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("non-object-doc");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    for (const content of ["null", '["shots"]']) {
      await fs.writeFile(filePath, content);
      const read = await service.getOverridesForWorkspace(workspaceId);
      expect(read.overrides).toEqual({});
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(
          workspaceId,
          { enabledServers: ["other"] },
          { expectedRevision: read.revision }
        )
      ).rejects.toThrow("newer version");
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.setOverridesForWorkspace(workspaceId, {}, { expectedRevision: read.revision })
      ).rejects.toThrow("newer version");
      expect(await fs.readFile(filePath, "utf8")).toBe(content);
    }
  });

  it("refuses to save over known fields stored in a shape this build cannot read", async () => {
    // A newer version stores `toolAllowlist.server` as an object: a save
    // rebuilt from normalized data would silently delete it — in the
    // document and in a legacy value alike.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("newer-known-shape");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const newer = JSON.stringify({ toolAllowlist: { server: { allow: ["ping"] } } });
    await fs.writeFile(filePath, newer);
    const read = await service.getOverridesForWorkspace(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other"] },
        { expectedRevision: read.revision }
      )
    ).rejects.toThrow("newer version");
    expect(await fs.readFile(filePath, "utf8")).toBe(newer);

    await fs.rm(filePath);
    const legacy: unknown = { toolAllowlist: { server: { allow: ["ping"] } } };
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === workspaceId);
        if (entry) entry.mcp = legacy as never;
      }
      return cfg;
    });
    const legacyRead = await service.getOverridesForWorkspace(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other"] },
        { expectedRevision: legacyRead.revision }
      )
    ).rejects.toThrow("newer version");
    expect(await pathExists(filePath)).toBe(false);
  });

  it("a bounded read returns at its deadline even while its migration write is still in flight", async () => {
    // The started write settles under its own locks; the request-path read
    // must not wait for a remote runtime's command timeout on top of the
    // advertised deadline.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId } = await registerWorkspace("bounded-read-migration");
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === workspaceId);
        if (entry) entry.mcp = { enabledServers: ["shots"] };
      }
      return cfg;
    });
    const internals = service as unknown as {
      migrateLegacyOverridesFenced: (
        target: unknown,
        snapshot: { trackSideEffect: (effect: Promise<unknown>) => Promise<unknown> }
      ) => Promise<boolean>;
    };
    spyOn(internals, "migrateLegacyOverridesFenced").mockImplementation((_target, snapshot) => {
      // A write that never settles (stalled remote checkout).
      snapshot.trackSideEffect(new Promise(() => undefined)).catch(() => undefined);
      return new Promise(() => undefined);
    });
    const startedAt = Date.now();
    const read = await service.getOverridesForWorkspace(workspaceId, { timeoutMs: 50 });
    expect(read.authoritative).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("a legacy migration refuses to write through a symlinked override directory", async () => {
    // SECURITY: a repo-tracked `.xum` symlink pointing at another checkout's
    // `.xum` would make the (link-following) migration write plant the
    // source's enabled-server override in that sibling workspace.
    const service = new WorkspaceMcpOverridesService(config);
    const victim = await registerWorkspace("symlink-victim");
    const source = await registerWorkspace("symlink-source");
    await fs.mkdir(path.join(victim.workspacePath, ".xum"), { recursive: true });
    await fs.symlink(
      path.join(victim.workspacePath, ".xum"),
      path.join(source.workspacePath, ".xum")
    );
    const legacyValue = { enabledServers: ["shots"] };
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((w) => w.id === source.workspaceId);
        if (entry) entry.mcp = legacyValue;
      }
      return cfg;
    });

    // Honored read-only; nothing is written anywhere.
    expect((await service.getOverridesForWorkspace(source.workspaceId)).overrides).toEqual(
      legacyValue
    );
    expect(await pathExists(path.join(victim.workspacePath, ".xum", "mcp.local.jsonc"))).toBe(
      false
    );
    expect((await service.getOverridesForWorkspace(victim.workspaceId)).overrides).toEqual({});
    const storedLegacy = [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((w) => w.id === source.workspaceId)?.mcp;
    expect(storedLegacy).toEqual(legacyValue);
  });

  it("every override write bumps the cross-process epoch token", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId } = await registerWorkspace("epoch");
    expect(await readWorkspaceOverridesEpochToken(config.rootDir)).toBeUndefined();

    await service.setOverridesForWorkspace(workspaceId, {
      enabledServers: ["plugin:0123456789abcdef:echo", "other"],
    });
    const afterSave = await readWorkspaceOverridesEpochToken(config.rootDir);
    expect(afterSave).toBeDefined();

    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    const afterPrune = await readWorkspaceOverridesEpochToken(config.rootDir);
    expect(afterPrune).not.toBe(afterSave);

    await service.setOverridesForWorkspace(workspaceId, {});
    const afterClear = await readWorkspaceOverridesEpochToken(config.rootDir);
    expect(afterClear).not.toBe(afterPrune);

    // Reads never bump it.
    await service.getOverridesForWorkspace(workspaceId);
    expect(await readWorkspaceOverridesEpochToken(config.rootDir)).toBe(afterClear);
  });

  it("prefers canonical override files when both metadata trees exist", async () => {
    const { workspaceId, workspacePath } = await registerWorkspace("canonical-precedence");
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".mux", "mcp.local.jsonc"),
      JSON.stringify({ disabledServers: ["legacy"] }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ disabledServers: ["canonical"] }),
      "utf-8"
    );

    const service = new WorkspaceMcpOverridesService(config);
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
      disabledServers: ["canonical"],
    });
  });

  it("adds .xum/mcp.local.jsonc to git exclude when writing overrides", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    const runtime = createRuntime({ type: "local" }, { projectPath: workspacePath });
    const gitInitResult = await execBuffered(runtime, "git init", {
      cwd: workspacePath,
      timeout: 10,
    });
    expect(gitInitResult.exitCode).toBe(0);

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    const excludePathResult = await execBuffered(runtime, "git rev-parse --git-path info/exclude", {
      cwd: workspacePath,
      timeout: 10,
    });
    expect(excludePathResult.exitCode).toBe(0);

    const excludePathRaw = excludePathResult.stdout.trim();
    expect(excludePathRaw.length).toBeGreaterThan(0);

    const excludePath = path.isAbsolute(excludePathRaw)
      ? excludePathRaw
      : path.join(workspacePath, excludePathRaw);

    const before = (await pathExists(excludePath)) ? await fs.readFile(excludePath, "utf-8") : "";
    expect(before).not.toContain(".xum/mcp.local.jsonc");

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a"],
    });

    const after = await fs.readFile(excludePath, "utf-8");
    expect(after).toContain(".xum/mcp.local.jsonc");
    expect(after).toContain(".mux/mcp.local.jsonc");
  });
  it("persists overrides to .xum/mcp.local.jsonc and reads them back", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a", "server-a"],
      toolAllowlist: { "server-b": ["tool1", "tool1", ""] },
    });

    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    const roundTrip = await service.getOverridesForWorkspace(workspaceId);
    expect(roundTrip.overrides).toEqual({
      disabledServers: ["server-a"],
      toolAllowlist: { "server-b": ["tool1"] },
    });
  });

  it("rejects saves with a stale revision instead of clobbering newer overrides", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    await service.setOverridesForWorkspace(workspaceId, {
      enabledServers: ["plugin:0123456789abcdef:server"],
    });

    // Dialog snapshot taken here...
    const snapshot = await service.getOverridesForWorkspace(workspaceId);

    // ...then a concurrent writer (e.g. plugin uninstall prune) removes the key.
    await service.setOverridesForWorkspace(
      workspaceId,
      {},
      { expectedRevision: snapshot.revision }
    );

    // Replaying the stale snapshot must fail, not restore the pruned key.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(workspaceId, snapshot.overrides, {
        expectedRevision: snapshot.revision,
      })
    ).rejects.toThrow(WorkspaceMcpOverridesConflictError);

    const current = await service.getOverridesForWorkspace(workspaceId);
    expect(current.overrides).toEqual({});

    // A save with the CURRENT revision goes through.
    await service.setOverridesForWorkspace(
      workspaceId,
      { disabledServers: ["other"] },
      { expectedRevision: current.revision }
    );
    const after = await service.getOverridesForWorkspace(workspaceId);
    expect(after.overrides).toEqual({ disabledServers: ["other"] });
  });

  it("a save whose epoch bump failed can be retried from the same dialog snapshot", async () => {
    // The file write lands (changing the stored revision) but the cross-process
    // change signal does not. The dialog still holds the pre-save revision, so
    // its retry must be admitted as idempotent — otherwise the missing
    // invalidation could never be published from that dialog.
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);
    await service.setOverridesForWorkspace(workspaceId, { disabledServers: ["a"] });
    const epochPath = path.join(config.rootDir, "mcp-overrides.epoch");
    const epochBefore = await fs.readFile(epochPath, "utf-8");
    const snapshot = await service.getOverridesForWorkspace(workspaceId);

    const internals = service as unknown as { bumpOverridesEpoch: () => Promise<void> };
    // mockImplementationOnce, not mockRejectedValueOnce: Bun creates the
    // rejected promise eagerly, which the runner reports as an unhandled
    // rejection before the save ever consumes it.
    const bump = spyOn(internals, "bumpOverridesEpoch");
    const failBumpOnce = () =>
      bump.mockImplementationOnce(() => Promise.reject(new Error("epoch rename failed")));
    failBumpOnce();
    const incoming = { disabledServers: ["a", "b"] };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(workspaceId, incoming, {
        expectedRevision: snapshot.revision,
      })
    ).rejects.toThrow(/epoch rename failed/);
    // Disk moved on without a signal.
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual(incoming);
    expect(await fs.readFile(epochPath, "utf-8")).toBe(epochBefore);

    // Retrying the SAME content with the stale revision publishes the epoch.
    await service.setOverridesForWorkspace(workspaceId, incoming, {
      expectedRevision: snapshot.revision,
    });
    expect(bump).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(epochPath, "utf-8")).not.toBe(epochBefore);

    // Different content behind the same stale revision is still a conflict.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(
        workspaceId,
        { disabledServers: ["c"] },
        { expectedRevision: snapshot.revision }
      )
    ).rejects.toThrow(WorkspaceMcpOverridesConflictError);

    // Clearing: the removal landed, the bump did not, and the retry of `{}`
    // with the stale revision goes through as well.
    const beforeClear = await service.getOverridesForWorkspace(workspaceId);
    failBumpOnce();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(workspaceId, {}, { expectedRevision: beforeClear.revision })
    ).rejects.toThrow(/epoch rename failed/);
    await service.setOverridesForWorkspace(
      workspaceId,
      {},
      { expectedRevision: beforeClear.revision }
    );
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({});
  });

  it("strict reads throw on unreadable content instead of reporting empty overrides", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    // Content exists but is not parseable: the plugin uninstaller's prune
    // must NOT see "{}" here — it would retire its tombstone against keys it
    // never read, resurrecting stale enabledServers on reinstall.
    await fs.writeFile(
      path.join(workspacePath, ".mux", "mcp.local.jsonc"),
      '{ "enabledServers": ["plugin:0123456789abcdef:echo"'
    );

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    // Lenient (UI/list paths): degrade to empty.
    const lenient = await service.getOverridesForWorkspace(workspaceId);
    expect(lenient.overrides).toEqual({});
    // Strict (prune path): fail loudly so the caller keeps its retry state.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.getOverridesForWorkspace(workspaceId, { mode: "strict" })).rejects.toThrow(
      /parse errors/
    );
    // Strict on a genuinely absent file is still fine (no overrides).
    await fs.rm(path.join(workspacePath, ".mux", "mcp.local.jsonc"));
    const absent = await service.getOverridesForWorkspace(workspaceId, { mode: "strict" });
    expect(absent.overrides).toEqual({});
  });

  it("coordinates the override epoch and writer locks under the configured coordination root", async () => {
    // `xum run` registers under a disposable root while its MCP configuration
    // is the persistent home: its fences must observe and contend with a
    // desktop/server backend's saves there, not under the disposable root.
    const coordinationRootDir = path.join(tempDir, "persistent-home");
    await fs.mkdir(coordinationRootDir, { recursive: true });
    const service = new WorkspaceMcpOverridesService(config, { coordinationRootDir });
    const { workspaceId } = await registerWorkspace("coordination-root");
    const before = await readWorkspaceOverridesEpochToken(coordinationRootDir);
    await service.setOverridesForWorkspace(workspaceId, { enabledServers: ["shots"] });
    expect(await readWorkspaceOverridesEpochToken(coordinationRootDir)).not.toBe(before);
    expect(await pathExists(path.join(config.rootDir, "mcp-overrides.epoch"))).toBe(false);
    // The writer lock lives there too: a sibling on the same root contends.
    const sibling = new WorkspaceMcpOverridesService(config, { coordinationRootDir });
    const release = await service.acquireExclusiveLock();
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(sibling.acquireExclusiveLock({ timeoutMs: 300 })).rejects.toThrow();
    } finally {
      await release();
    }
  });

  it("prunePluginOverrideKeys validates every override document before rewriting any", async () => {
    // Canonical file prunable, compatibility file uneditable: a first-file
    // rewrite followed by a throw would leave a durable revocation that the
    // caller never learns about (no epoch bump). Nothing may be written.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("prune-validate-first");
    const canonical = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    const compat = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.mkdir(path.dirname(compat), { recursive: true });
    const canonicalRaw = JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo"] });
    await fs.writeFile(canonical, canonicalRaw);
    // Unreadable shape that MAY carry a plugin key: throws in phase one.
    await fs.writeFile(compat, '{ "enabledServers": ["plugin:0123456789abcdef:echo"], ');
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow();
    expect(await fs.readFile(canonical, "utf-8")).toBe(canonicalRaw);
  });

  it("prunePluginOverrideKeys owes the cross-process epoch only when an override document exists", async () => {
    // Registration sanitizes every fresh checkout through this path; a clean
    // checkout (no override file) must not fail — and roll the creation back —
    // because the epoch file is transiently unwritable. Any existing document
    // owes the signal even when this pass rewrites nothing: an earlier pass
    // may have pruned it and failed its bump, and the tombstone retry must
    // still publish the invalidation.
    const service = new WorkspaceMcpOverridesService(config);
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "branch",
    });
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const internals = service as unknown as { bumpOverridesEpoch: () => Promise<void> };
    const bump = spyOn(internals, "bumpOverridesEpoch").mockImplementation(() =>
      Promise.reject(new Error("epoch unwritable"))
    );
    // No file, nothing pruned: no epoch owed.
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    expect(bump).not.toHaveBeenCalled();
    // A real prune publishes the signal — and surfaces its failure (the
    // uninstaller keeps its tombstone).
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ enabledServers: ["shots", "plugin:0123456789abcdef:echo"] })
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/epoch unwritable/);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(jsoncParse(await fs.readFile(filePath, "utf-8"))).toEqual({ enabledServers: ["shots"] });
    // The tombstone retry finds nothing left to prune but still owes (and
    // retries) the bump; once it succeeds the retry completes.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/epoch unwritable/);
    expect(bump).toHaveBeenCalledTimes(2);
    bump.mockRestore();
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    expect(await pathExists(path.join(config.rootDir, "mcp-overrides.epoch"))).toBe(true);

    // Registration-time sanitization of a NEW identity (epochOnlyWhenRewritten):
    // a key-free document — e.g. one a fork copy just created — owes nothing,
    // so an unwritable epoch file must not roll the creation back; a document
    // this pass actually rewrites still publishes (and surfaces) the bump.
    const failing = spyOn(internals, "bumpOverridesEpoch").mockImplementation(() =>
      Promise.reject(new Error("epoch unwritable"))
    );
    await service.prunePluginOverrideKeys(workspaceId, "plugin:", { epochOnlyWhenRewritten: true });
    expect(failing).not.toHaveBeenCalled();
    await fs.writeFile(
      filePath,
      JSON.stringify({ enabledServers: ["shots", "plugin:0123456789abcdef:echo"] })
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:", { epochOnlyWhenRewritten: true })
    ).rejects.toThrow(/epoch unwritable/);
    expect(failing).toHaveBeenCalledTimes(1);
    failing.mockRestore();
  });

  it("prunePluginOverrideKeys keeps compact single-line arrays parseable", async () => {
    // jsonc.modify corrupts a compact array when its last element is removed
    // (`["a","b"]` → `["a""]`); the prune must never leave an unparseable file.
    const service = new WorkspaceMcpOverridesService(config);
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "branch",
    });
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const key = "plugin:0123456789abcdef:echo";
    const cases: Array<[string, unknown]> = [
      [JSON.stringify({ enabledServers: ["shots", key] }), { enabledServers: ["shots"] }],
      [JSON.stringify({ enabledServers: [key, "shots"] }), { enabledServers: ["shots"] }],
      [JSON.stringify({ enabledServers: ["a", key, "b"] }), { enabledServers: ["a", "b"] }],
      [JSON.stringify({ enabledServers: [key] }), { enabledServers: [] }],
      [
        `{"disabledServers":["shots",${JSON.stringify(key)}],"x":1}`,
        { disabledServers: ["shots"], x: 1 },
      ],
      [
        `{ /* c */ "enabledServers": [ "shots" , ${JSON.stringify(key)} ] }`,
        { enabledServers: ["shots"] },
      ],
      // Comments attached to a RETAINED neighbor survive on either side.
      [
        `{"enabledServers":[${JSON.stringify(key)}, /* why shots */ "shots"], "keep": /* k */ 1}`,
        { enabledServers: ["shots"], keep: 1 },
      ],
      [
        `{"enabledServers":["shots", // trailing on shots\n ${JSON.stringify(key)}]}`,
        { enabledServers: ["shots"] },
      ],
      [
        `{"enabledServers":["a", /* mid */ ${JSON.stringify(key)}, /* b's */ "b"]}`,
        { enabledServers: ["a", "b"] },
      ],
    ];
    for (const [original, expected] of cases) {
      await fs.writeFile(filePath, original);
      await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
      const text = await fs.readFile(filePath, "utf-8");
      const errors: JsoncParseError[] = [];
      expect(jsoncParse(text, errors)).toEqual(expected);
      expect(errors).toEqual([]);
    }
    // Every comment that was not inside the removed element survives.
    expect(await fs.readFile(filePath, "utf-8")).toContain("/* b's */");
    await fs.writeFile(
      filePath,
      `{"enabledServers":[${JSON.stringify(key)}, /* why shots */ "shots"], "keep": /* k */ 1}`
    );
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    const text = await fs.readFile(filePath, "utf-8");
    expect(text).toContain("/* why shots */");
    expect(text).toContain("/* k */");
    await fs.writeFile(
      filePath,
      `{"enabledServers":["shots", // trailing on shots\n ${JSON.stringify(key)}]}`
    );
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    expect(await fs.readFile(filePath, "utf-8")).toContain("// trailing on shots");
  });

  it("prunePluginOverrideKeys removes only prefix keys and preserves unknown fields", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // A newer build's file: extra top-level field + mixed keys. The prune
    // must drop ONLY the plugin's keys and keep everything else byte-safe
    // for downgrade round-trips (AGENTS.md upgrade↔downgrade rule).
    await fs.writeFile(
      filePath,
      JSON.stringify({
        futureField: { keep: "me" },
        enabledServers: ["plugin:0123456789abcdef:echo", "other-server"],
        disabledServers: ["plugin:0123456789abcdef:beta"],
        toolAllowlist: { "plugin:0123456789abcdef:echo": ["t1"], "other-server": ["t2"] },
      })
    );

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");

    const after = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
    expect(after).toEqual({
      futureField: { keep: "me" },
      enabledServers: ["other-server"],
      disabledServers: [],
      toolAllowlist: { "other-server": ["t2"] },
    });

    // Unreadable content must throw (callers keep their retry tombstones).
    await fs.writeFile(filePath, "{ not json");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/parse errors/);

    // A missing file is nothing to prune (plugin keys only ever live in
    // workspace-local files).
    await fs.rm(filePath);
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
  });

  it("prunePluginOverrideKeysForWorkspaces sweeps many workspaces with one metadata load", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const pruned = await registerWorkspace("pruned");
    const untouched = await registerWorkspace("untouched");
    const broken = await registerWorkspace("broken");
    const write = (workspacePath: string, content: string) =>
      fs
        .mkdir(path.join(workspacePath, ".xum"), { recursive: true })
        .then(() => fs.writeFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), content));
    await write(
      pruned.workspacePath,
      JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo", "other"] })
    );
    await write(broken.workspacePath, "{ not json");

    // Warm-up: getAllWorkspaceMetadata persists read-time migrations
    // (createdAt backfill) on first load, which would skew the call counts.
    await config.getAllWorkspaceMetadata();
    const metadataSpy = spyOn(config, "getAllWorkspaceMetadata");
    const configSpy = spyOn(config, "loadConfigOrDefault");

    const published: Array<[string, unknown]> = [];
    const failures = await service.prunePluginOverrideKeysForWorkspaces(
      [pruned.workspaceId, untouched.workspaceId, broken.workspaceId, "ws-missing"],
      "plugin:0123456789abcdef:",
      {
        publish: (persisted, workspaceId) => {
          published.push([workspaceId, persisted]);
          return Promise.resolve();
        },
      }
    );

    // One failure per broken workspace; the healthy ones still completed.
    expect(failures.map((failure) => failure.workspaceId).sort()).toEqual([
      broken.workspaceId,
      "ws-missing",
    ]);
    expect(String(failures.find((f) => f.workspaceId === broken.workspaceId)?.error)).toMatch(
      /parse errors/
    );
    expect(published).toEqual([
      [pruned.workspaceId, { enabledServers: ["other"] }],
      [untouched.workspaceId, {}],
    ]);
    // The sweep cost must not scale with a full config parse per workspace:
    // two registry loads to derive and verify the checkout lock keys, one
    // fresh load under the global lock for the sweep itself and one
    // post-sweep re-resolution (each loading config once), plus the batch's
    // single legacy-config snapshot.
    expect(metadataSpy).toHaveBeenCalledTimes(4);
    expect(configSpy).toHaveBeenCalledTimes(5);
  });

  it("prunePluginOverrideKeysForWorkspaces prunes every checkout sharing a duplicated ID", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const first = await registerWorkspace("dup-a");
    const second = await registerWorkspace("dup-b");
    // Corrupted config: both entries carry the same workspace ID.
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const workspace of project.workspaces) {
          if (workspace.id === second.workspaceId) {
            workspace.id = first.workspaceId;
          }
        }
      }
      return cfg;
    });
    for (const workspacePath of [first.workspacePath, second.workspacePath]) {
      await fs.mkdir(path.join(workspacePath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(workspacePath, ".xum", "mcp.local.jsonc"),
        JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo"] })
      );
    }

    const failures = await service.prunePluginOverrideKeysForWorkspaces(
      [first.workspaceId, first.workspaceId],
      "plugin:0123456789abcdef:"
    );

    expect(failures).toEqual([]);
    for (const workspacePath of [first.workspacePath, second.workspacePath]) {
      const after = jsoncParse(
        await fs.readFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "utf-8")
      ) as Record<string, unknown>;
      expect(after.enabledServers).toEqual([]);
    }
  });

  it("prunePluginOverrideKeysForWorkspaces skips off-host entries sharing a duplicated ID", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const local = await registerWorkspace("dup-local");
    // Corrupted config: an SSH entry reuses the local workspace's ID. Plugin
    // servers never run off-host, and reaching for it would attempt remote
    // I/O against an unreachable host.
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/remote", {
        workspaces: [
          {
            path: "/remote/checkout",
            id: local.workspaceId,
            name: "remote-branch",
            runtimeConfig: { type: "ssh", host: "unreachable.invalid", srcBaseDir: "/remote" },
          },
        ],
      });
      return cfg;
    });
    await fs.mkdir(path.join(local.workspacePath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(local.workspacePath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo"] })
    );

    const failures = await service.prunePluginOverrideKeysForWorkspaces(
      [local.workspaceId],
      "plugin:0123456789abcdef:"
    );

    expect(failures).toEqual([]);
    const after = jsoncParse(
      await fs.readFile(path.join(local.workspacePath, ".xum", "mcp.local.jsonc"), "utf-8")
    ) as Record<string, unknown>;
    expect(after.enabledServers).toEqual([]);
  });

  it("a workspace lock (held by a rename) blocks only that workspace's override writers", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const renaming = await registerWorkspace("ws-lock-renaming");
    const unrelated = await registerWorkspace("ws-lock-unrelated");
    const release = await service.acquireWorkspaceLock(renaming.workspaceId);
    try {
      // An unrelated workspace's save is not serialized behind the rename.
      await service.setOverridesForWorkspace(unrelated.workspaceId, {
        enabledServers: ["shots"],
      });
      // The renamed workspace's save (and its plugin-key prune) wait for the
      // move to finish instead of writing into the vacated path.
      let saveSettled = false;
      const save = service
        .setOverridesForWorkspace(renaming.workspaceId, { enabledServers: ["shots"] })
        .then(() => {
          saveSettled = true;
        });
      let pruneSettled = false;
      const prune = service
        .prunePluginOverrideKeysForWorkspaces([renaming.workspaceId], "plugin:")
        .then(() => {
          pruneSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saveSettled).toBe(false);
      expect(pruneSettled).toBe(false);
      await release();
      await Promise.all([save, prune]);
    } finally {
      await release().catch(() => undefined);
    }
    expect((await service.getOverridesForWorkspace(renaming.workspaceId)).overrides).toEqual({
      enabledServers: ["shots"],
    });
  });

  it("a batch of workspace locks never retains an unrelated lock while waiting for a busy one", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const free = await registerWorkspace("ws-batch-free");
    const busy = await registerWorkspace("ws-batch-busy");
    const releaseBusy = await service.acquireWorkspaceLock(busy.workspaceId);
    try {
      let pruneSettled = false;
      const prune = service
        .prunePluginOverrideKeysForWorkspaces([free.workspaceId, busy.workspaceId], "plugin:")
        .then(() => {
          pruneSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pruneSettled).toBe(false);
      // The free workspace's own writer is not blocked by the waiting batch.
      const startedAt = Date.now();
      await service.setOverridesForWorkspace(free.workspaceId, { enabledServers: ["shots"] });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await releaseBusy();
      await prune;
    } finally {
      await releaseBusy().catch(() => undefined);
    }
  });

  it("the workspace lock is still derived when an unrelated legacy entry's metadata is malformed", async () => {
    // Rename and removal take this lock: an unreadable metadata.json of some
    // OTHER id-less legacy entry must not brick every healthy workspace.
    const service = new WorkspaceMcpOverridesService(config);
    const healthy = await registerWorkspace("lock-despite-corrupt-sibling");
    const legacyPath = path.join(config.srcDir, "legacy-project", "old-branch");
    await fs.mkdir(legacyPath, { recursive: true });
    // Id-less legacy entry: its stable id comes from metadata.json.
    const legacyEntry: unknown = { path: legacyPath };
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/legacy-project", { workspaces: [legacyEntry as never] });
      return cfg;
    });
    const sessionDir = path.join(config.sessionsDir, "old-branch");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "metadata.json"), "{ not json");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      config.getAllWorkspaceMetadata({ probeCheckouts: false, throwOnError: true })
    ).rejects.toThrow();

    // The lock still fences by checkout identity (a second acquirer waits).
    const release = await service.acquireWorkspaceLock(healthy.workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.acquireWorkspaceLock(healthy.workspaceId, { acquireTimeoutMs: 300 })
    ).rejects.toThrow("in progress for this workspace");
    await release();

    // A workspace the lenient walk cannot see keeps failing closed.
    await fs.writeFile(path.join(tempDir, "config.json"), "{ not json");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.acquireWorkspaceLock(healthy.workspaceId)).rejects.toThrow();
  });

  it("aliases sharing one checkout contend for one lock", async () => {
    // An isolation:none child and its parent hold distinct ids for one
    // override document: a rename through one id must fence a save through
    // the other, so the lock is keyed by checkout identity, not by id.
    const service = new WorkspaceMcpOverridesService(config);
    const dir = path.join(tempDir, "alias-lock-checkout");
    await registerLocalWorkspace(dir, "alias-lock-parent");
    await registerLocalWorkspace(dir, "alias-lock-child");
    const release = await service.acquireWorkspaceLock("alias-lock-parent");
    try {
      let saveSettled = false;
      const save = service
        .setOverridesForWorkspace("alias-lock-child", { enabledServers: ["shots"] })
        .then(() => {
          saveSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saveSettled).toBe(false);
      await release();
      await save;
    } finally {
      await release().catch(() => undefined);
    }
    expect((await service.getOverridesForWorkspace("alias-lock-child")).overrides).toEqual({
      enabledServers: ["shots"],
    });
  });

  it("a save through a symlinked spelling of a checkout contends with the real spelling's lock", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const realDir = path.join(tempDir, "lock-real-checkout");
    const linkDir = path.join(tempDir, "lock-linked-checkout");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir);
    await registerLocalWorkspace(realDir, "lock-via-real");
    await registerLocalWorkspace(linkDir, "lock-via-link");
    const release = await service.acquireWorkspaceLock("lock-via-real");
    try {
      let saveSettled = false;
      const save = service
        .setOverridesForWorkspace("lock-via-link", { enabledServers: ["shots"] })
        .then(() => {
          saveSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saveSettled).toBe(false);
      await release();
      await save;
    } finally {
      await release().catch(() => undefined);
    }
  });

  it("a save never recreates a checkout that disappeared after the registry read", async () => {
    // Workspace removal takes no override lock: the checkout can be gone by
    // the time the save writes. Refuse instead of materializing a stray `.xum`.
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("removed-checkout");
    await fs.rm(workspacePath, { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(workspaceId, { enabledServers: ["shots"] })
    ).rejects.toThrow("checkout is not available");
    expect(await pathExists(workspacePath)).toBe(false);
  });

  it("a dialog opened on an unreadable document can repair it with the unavailable revision", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId, workspacePath } = await registerWorkspace("repair-unavailable");
    await fs.mkdir(path.join(workspacePath, ".xum"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "{ not json");
    // The state is not authoritative: the sentinel repairs it.
    await service.setOverridesForWorkspace(
      workspaceId,
      { disabledServers: ["shots"] },
      { expectedRevision: MCP_OVERRIDES_REVISION_UNAVAILABLE }
    );
    expect((await service.getOverridesForWorkspace(workspaceId)).overrides).toEqual({
      disabledServers: ["shots"],
    });
    // Readable again: the sentinel is a stale snapshot like any other.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other"] },
        { expectedRevision: MCP_OVERRIDES_REVISION_UNAVAILABLE }
      )
    ).rejects.toThrow("changed while this dialog was open");
  });

  it("workspace locks are keyed by the normalized id", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const release = await service.acquireWorkspaceLock("ws-trim");
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        service.acquireWorkspaceLock(" ws-trim ", { acquireTimeoutMs: 500 })
      ).rejects.toThrow("in progress for this workspace");
    } finally {
      await release();
    }
  });

  it("an exclusive-lock acquisition past its deadline gives up without ever holding the lock", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const release = await service.acquireExclusiveLock();
    // Queued behind the holder with a budget that expires while waiting.
    const expired = service.acquireExclusiveLock({ timeoutMs: 50 });
    const aborted = service.acquireExclusiveLock({ signal: AbortSignal.abort() });
    // Both settle while other assertions run; mark them handled up front.
    expired.catch(() => undefined);
    aborted.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let laterAcquired = false;
    const later = service.acquireExclusiveLock().then((releaseLater) => {
      laterAcquired = true;
      return releaseLater;
    });
    await release();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(expired).rejects.toThrow("updating workspace MCP settings");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(aborted).rejects.toThrow("aborted");
    // The abandoned entries did not hold the lock: the next writer proceeds.
    const releaseLater = await later;
    expect(laterAcquired).toBe(true);
    await releaseLater();
  });

  it("an aborted exclusive-lock acquisition stops polling a sibling process's hold immediately", async () => {
    // Two service instances = two processes sharing one home: the second's
    // queue is empty, so it polls the cross-process lock file directly.
    const holder = new WorkspaceMcpOverridesService(config);
    const waiter = new WorkspaceMcpOverridesService(config);
    const release = await holder.acquireExclusiveLock();
    try {
      const controller = new AbortController();
      const startedAt = Date.now();
      const acquisition = waiter.acquireExclusiveLock({ signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(acquisition).rejects.toThrow("aborted");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await release();
    }
  });

  it("SSH registrations of one remote path share a lock key across host aliases", async () => {
    // Two ssh_config aliases can name the same machine; nothing can resolve
    // them to a stable identity here, so a rename through one alias and a
    // save through the other must still contend on the checkout.
    const service = new WorkspaceMcpOverridesService(config);
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/ssh-aliases", {
        workspaces: [
          {
            path: "/remote/shared",
            id: "ws-ssh-alias-a",
            name: "alias-a",
            runtimeConfig: { type: "ssh", host: "alias-a", srcBaseDir: "/remote" },
          },
          {
            path: "/remote/shared",
            id: "ws-ssh-alias-b",
            name: "alias-b",
            runtimeConfig: { type: "ssh", host: "alias-b", srcBaseDir: "/remote" },
          },
          {
            path: "/remote/other",
            id: "ws-ssh-alias-c",
            name: "alias-c",
            runtimeConfig: { type: "ssh", host: "alias-a", srcBaseDir: "/remote" },
          },
        ],
      });
      return cfg;
    });
    const internals = service as unknown as {
      checkoutLockKeys: (ids: string[]) => Promise<{ keys: Map<string, string[]> }>;
    };
    const { keys } = await internals.checkoutLockKeys([
      "ws-ssh-alias-a",
      "ws-ssh-alias-b",
      "ws-ssh-alias-c",
    ]);
    const shared = (a: string, b: string) =>
      (keys.get(a) ?? []).filter((key) => (keys.get(b) ?? []).includes(key));
    expect(shared("ws-ssh-alias-a", "ws-ssh-alias-b")).toHaveLength(1);
    // Different remote paths never contend, alias or not.
    expect(shared("ws-ssh-alias-a", "ws-ssh-alias-c")).toHaveLength(0);
  });

  it("an id registered on several checkouts locks every one of them", async () => {
    // Corrupted config can list one stable id under several entries; the
    // plugin sweep prunes every host-local checkout carrying it, so the
    // batch must hold each checkout's key, not the one a last-write-wins
    // map happened to keep.
    const service = new WorkspaceMcpOverridesService(config);
    const pathA = path.join(config.srcDir, "dup-a");
    const pathB = path.join(config.srcDir, "dup-b");
    await registerLocalWorkspace(pathA, "ws-dup-a");
    await registerLocalWorkspace(pathB, "ws-dup-b");
    const internals = service as unknown as {
      checkoutLockKeys: (ids: string[]) => Promise<{ keys: Map<string, string[]> }>;
    };
    const separate = await internals.checkoutLockKeys(["ws-dup-a", "ws-dup-b"]);
    const expected = [
      ...(separate.keys.get("ws-dup-a") ?? []),
      ...(separate.keys.get("ws-dup-b") ?? []),
    ];
    expect(expected.length).toBeGreaterThanOrEqual(2);

    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const entry of project.workspaces) {
          if (entry.id === "ws-dup-a" || entry.id === "ws-dup-b") entry.id = "ws-duplicated";
        }
      }
      return cfg;
    });
    const { keys } = await internals.checkoutLockKeys(["ws-duplicated"]);
    const duplicated = keys.get("ws-duplicated") ?? [];
    for (const key of expected) {
      expect(duplicated).toContain(key);
    }
  });

  it("acquireExclusiveLock holds the prune sweep until released", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const { workspaceId } = await registerWorkspace("locked");

    const release = await service.acquireExclusiveLock();
    let sweepDone = false;
    const sweep = service
      .prunePluginOverrideKeysForWorkspaces([workspaceId], "plugin:0123456789abcdef:")
      .then((failures) => {
        sweepDone = true;
        return failures;
      });
    // Give the sweep every chance to run if the lock were not honored.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sweepDone).toBe(false);

    await release();
    expect(await sweep).toEqual([]);
    expect(sweepDone).toBe(true);
  });

  it("prunePluginOverrideKeysForWorkspaces walks each inheriting subtree once", async () => {
    // A swept chain must not be re-traversed from every ancestor (O(N²)
    // probes under the exclusive lock): the grandchild is published by the
    // root's fan-out and once more by its own strict verification — never a
    // third time via the child's fan-out.
    const service = new WorkspaceMcpOverridesService(config);
    const root = await registerWorkspace("chain-root");
    const child = await registerWorkspace("chain-child");
    const grandchild = await registerWorkspace("chain-grandchild");
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const entry of project.workspaces) {
          if (entry.id === child.workspaceId) entry.parentWorkspaceId = root.workspaceId;
          if (entry.id === grandchild.workspaceId) entry.parentWorkspaceId = child.workspaceId;
        }
      }
      return cfg;
    });
    await service.setOverridesForWorkspace(root.workspaceId, {
      enabledServers: ["plugin:0123456789abcdef:echo", "other"],
    });

    const published = new Map<string, number>();
    const failures = await service.prunePluginOverrideKeysForWorkspaces(
      [root.workspaceId, child.workspaceId, grandchild.workspaceId],
      "plugin:0123456789abcdef:",
      {
        publish: (_persisted, workspaceId) => {
          published.set(workspaceId, (published.get(workspaceId) ?? 0) + 1);
          return Promise.resolve();
        },
      }
    );
    expect(failures).toEqual([]);
    expect(published.get(root.workspaceId)).toBe(1);
    expect(published.get(child.workspaceId)).toBe(2);
    expect(published.get(grandchild.workspaceId)).toBe(2);
  });

  it("prunePluginOverrideKeysForWorkspaces fails a workspace renamed during the sweep", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const stable = await registerWorkspace("stable");
    const moved = await registerWorkspace("moved");
    await config.getAllWorkspaceMetadata();
    const realGetAll = config.getAllWorkspaceMetadata.bind(config);
    // Fourth load (the post-sweep re-resolution; the first two derive and
    // verify the checkout lock keys, the third is the sweep's own view) sees
    // the workspace under a new name — exactly what a concurrent rename
    // leaves behind.
    spyOn(config, "getAllWorkspaceMetadata")
      .mockImplementationOnce(realGetAll)
      .mockImplementationOnce(realGetAll)
      .mockImplementationOnce(realGetAll)
      .mockImplementationOnce(async () =>
        (await realGetAll()).map((metadata) =>
          metadata.id === moved.workspaceId
            ? {
                ...metadata,
                name: "renamed",
                namedWorkspacePath: path.join(path.dirname(moved.workspacePath), "renamed"),
              }
            : metadata
        )
      );

    const failures = await service.prunePluginOverrideKeysForWorkspaces(
      [stable.workspaceId, moved.workspaceId],
      "plugin:0123456789abcdef:"
    );

    expect(failures.map((failure) => failure.workspaceId)).toEqual([moved.workspaceId]);
    expect(String(failures[0].error)).toMatch(/moved while/);
  });

  it("prunePluginOverrideKeys refuses symlinked override files", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    // A contributor branch can TRACK .mux/mcp.local.jsonc as a symlink; the
    // prune write resolves links, so following one would redirect the rewrite
    // into an attacker-chosen file (e.g. a sibling workspace's overrides).
    const victimPath = path.join(workspacePath, "..", "victim.jsonc");
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    await fs.writeFile(
      victimPath,
      JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo"] })
    );
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.symlink(victimPath, filePath);

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/symbolic link/);
    // The link target is untouched.
    expect(JSON.parse(await fs.readFile(victimPath, "utf-8"))).toEqual({
      enabledServers: ["plugin:0123456789abcdef:echo"],
    });

    // A symlinked PARENT segment (.mux -> elsewhere) is rejected by the
    // containment check even though the file itself is a regular file.
    await fs.rm(filePath);
    await fs.rm(path.join(workspacePath, ".mux"), { recursive: true, force: true });
    const outsideDir = path.join(workspacePath, "..", "outside-mux");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideDir, "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: [] })
    );
    await fs.symlink(outsideDir, path.join(workspacePath, ".mux"));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/resolves outside the workspace/);
  });

  it("the verified document read never follows a symlink swapped in after the path guards", async () => {
    // The segment guards are point-in-time; the read that copies bytes out of
    // the checkout (fork copy, carried unknown fields) must fail on a symlink
    // — at the final component OR a parent segment — rather than read the
    // file it points at.
    const checkout = path.join(config.srcDir, "nofollow-read");
    await fs.mkdir(path.join(checkout, ".xum"), { recursive: true });
    const own = path.join(checkout, ".xum", "mcp.local.jsonc");
    await fs.writeFile(own, '{ "enabledServers": ["shots"] }');
    expect(await readHostOverrideDocumentNoFollow(own, checkout)).toBe(
      '{ "enabledServers": ["shots"] }'
    );

    // Final component swapped for a symlink to a host file.
    const secret = path.join(config.srcDir, "secret.json");
    await fs.writeFile(secret, '{ "token": "hunter2" }');
    await fs.rm(own);
    await fs.symlink(secret, own);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(readHostOverrideDocumentNoFollow(own, checkout)).rejects.toThrow();
    await fs.rm(own);

    // Parent segment swapped for a symlink to a SIBLING checkout's `.xum`:
    // O_NOFOLLOW alone follows it (regular file at the end), the post-open
    // verification does not.
    const sibling = path.join(config.srcDir, "sibling-checkout");
    await fs.mkdir(path.join(sibling, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(sibling, ".xum", "mcp.local.jsonc"),
      '{ "enabledServers": ["sibling-secret-server"] }'
    );
    await fs.rm(path.join(checkout, ".xum"), { recursive: true, force: true });
    await fs.symlink(path.join(sibling, ".xum"), path.join(checkout, ".xum"));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(readHostOverrideDocumentNoFollow(own, checkout)).rejects.toThrow(/symbolic link/);
    // A directory and a path outside the checkout are refused too.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(readHostOverrideDocumentNoFollow(sibling, checkout)).rejects.toThrow();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(readHostOverrideDocumentNoFollow(secret, checkout)).rejects.toThrow(
      /outside the checkout/
    );
  });

  it("saves a devcontainer workspace's settings on the host without a running container", async () => {
    // The override files live in the host worktree and DevcontainerRuntime
    // reads/writes them there; only `exec` needs `devcontainer exec` (a
    // running container). The symlink guard must therefore probe the host —
    // and still refuse a symlinked segment.
    const service = new WorkspaceMcpOverridesService(config);
    // In-place registration (projectPath === name) keeps the checkout under
    // the test root regardless of the devcontainer runtime's srcBaseDir.
    const checkout = path.join(config.srcDir, "devcontainer-save");
    await fs.mkdir(checkout, { recursive: true });
    const workspaceId = "ws-devcontainer-save";
    await config.editConfig((cfg) => {
      cfg.projects.set(checkout, {
        workspaces: [
          {
            path: checkout,
            id: workspaceId,
            name: checkout,
            runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
          },
        ],
      });
      return cfg;
    });

    await service.setOverridesForWorkspace(workspaceId, { disabledServers: ["shots"] });
    expect(
      jsoncParse(await fs.readFile(path.join(checkout, ".xum", "mcp.local.jsonc"), "utf-8"))
    ).toEqual({ disabledServers: ["shots"] });

    await fs.rm(path.join(checkout, ".xum"), { recursive: true, force: true });
    const outsideDir = path.join(config.srcDir, "outside-devcontainer");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(checkout, ".xum"));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace(workspaceId, { disabledServers: ["other"] })
    ).rejects.toThrow(/symbolic link/);
    expect(await pathExists(path.join(outsideDir, "mcp.local.jsonc"))).toBe(false);
  });

  it("CAS saves from two service instances are serialized by the cross-process lock", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ enabledServers: ["base"] }));
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    // Two INSTANCES sharing one home (desktop + `xum server`): each has its
    // own in-process write queue, so only the cross-process lock makes the
    // expectedRevision check-and-set atomic between them. Without it both
    // saves pass the CAS against the same snapshot and the loser's write is
    // silently discarded despite reporting success.
    const serviceA = new WorkspaceMcpOverridesService(config);
    const serviceB = new WorkspaceMcpOverridesService(config);
    const { revision } = await serviceA.getOverridesForWorkspace(workspaceId);

    const outcomes = await Promise.allSettled([
      serviceA.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["base", "from-a"] },
        { expectedRevision: revision }
      ),
      serviceB.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["base", "from-b"] },
        { expectedRevision: revision }
      ),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(WorkspaceMcpOverridesConflictError);
    // The surviving CANONICAL file matches the single successful save (the
    // seeded legacy .mux file is shadowed on reads, not rewritten).
    const after = JSON.parse(
      await fs.readFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "utf-8")
    ) as {
      enabledServers: string[];
    };
    expect(after.enabledServers).toHaveLength(2);
  });

  it("prunePluginOverrideKeys matches only canonical plugin keys", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // MCP server names are arbitrary user strings: a user-defined server may
    // legitimately be named "plugin:custom". Only canonical
    // plugin:<16-hex instanceId>:<server> keys are plugin-owned; a broad
    // "plugin:" prune (registration-time sanitization) must leave the
    // ordinary server's enables and allowlists intact.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabledServers: ["plugin:0123456789abcdef:echo", "plugin:custom", "other"],
        toolAllowlist: { "plugin:0123456789abcdef:echo": ["t1"], "plugin:custom": ["t2"] },
      })
    );
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    await service.prunePluginOverrideKeys(workspaceId, "plugin:");

    const after = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
    expect(after).toEqual({
      enabledServers: ["plugin:custom", "other"],
      toolAllowlist: { "plugin:custom": ["t2"] },
    });
  });

  it("publish hooks run in write order with the persisted overrides", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:echo", "other-server"] })
    );
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);

    // In-memory caches (MCPServerManager) mirror these publications: they
    // must observe the same order as the disk writes, or a plugin-uninstall
    // prune racing a dialog save can leave the cache holding the older
    // snapshot (in either direction). Both writers publish INSIDE the
    // exclusive write queue, so concurrent launches publish in write order.
    const published: Array<{ via: string; enabled: unknown }> = [];
    await Promise.all([
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:", {
        publish: (persisted) => {
          published.push({ via: "prune", enabled: persisted?.enabledServers });
          return Promise.resolve();
        },
      }),
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other-server", "third-server"] },
        {
          publish: (persisted) => {
            published.push({ via: "set", enabled: persisted?.enabledServers });
            return Promise.resolve();
          },
        }
      ),
    ]);

    // Queue order: prune first (pruned snapshot), then the save (its own
    // normalized payload). Each publication carries the state its write
    // persisted, and the LAST publication matches the final disk state.
    expect(published).toEqual([
      { via: "prune", enabled: ["other-server"] },
      { via: "set", enabled: ["other-server", "third-server"] },
    ]);
    // The save writes the CANONICAL file (.xum); the seeded legacy .mux file
    // was edited in place by the prune and is now shadowed on reads.
    const finalState = JSON.parse(
      await fs.readFile(path.join(workspacePath, ".xum", "mcp.local.jsonc"), "utf-8")
    ) as Record<string, unknown>;
    expect(finalState.enabledServers).toEqual(["other-server", "third-server"]);
  });

  it("prunePluginOverrideKeys preserves JSONC comments and formatting", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // User-maintained .jsonc: comments must survive the prune (only the
    // plugin's keys may be edited out — no wholesale JSON.stringify rewrite).
    await fs.writeFile(
      filePath,
      `{
  // Keep me: explains why other-server is enabled.
  "enabledServers": [
    "plugin:0123456789abcdef:echo",
    "other-server" // trailing comment survives too
  ],
  /* block comment */
  "toolAllowlist": {
    "plugin:0123456789abcdef:echo": ["t1"],
    "other-server": ["t2"]
  }
}
`
    );

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");

    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toContain("// Keep me: explains why other-server is enabled.");
    expect(after).toContain("// trailing comment survives too");
    expect(after).toContain("/* block comment */");
    expect(after).not.toContain("plugin:0123456789abcdef:echo");
    const parsed = jsoncParse(after) as Record<string, unknown>;
    expect(parsed).toEqual({
      enabledServers: ["other-server"],
      toolAllowlist: { "other-server": ["t2"] },
    });
  });

  it("prunePluginOverrideKeys rejects opaque field shapes instead of declaring success", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);

    // A newer release may represent an owned field with a shape this build
    // cannot inspect; "successfully pruning" it would retire the caller's
    // tombstone while plugin keys embedded in that shape survive.
    await fs.writeFile(
      filePath,
      JSON.stringify({ enabledServers: { v2: ["plugin:0123456789abcdef:echo"] } })
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/unrecognized "enabledServers" shape/);

    await fs.writeFile(
      filePath,
      JSON.stringify({ toolAllowlist: ["plugin:0123456789abcdef:echo"] })
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/unrecognized "toolAllowlist" shape/);

    // Absent fields stay fine (nothing to prune).
    await fs.writeFile(filePath, JSON.stringify({ somethingElse: true }));
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");

    // A non-object ROOT is equally opaque: a newer build may store the whole
    // document in a different shape with plugin keys embedded inside it.
    await fs.writeFile(
      filePath,
      JSON.stringify([{ enabledServers: ["plugin:0123456789abcdef:echo"] }])
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/unrecognized root shape/);

    // An opaque shape that PROVABLY carries no canonical plugin key anywhere
    // has nothing to prune: it is left verbatim (a fork copy preserves the
    // same document on the same evidence; registration must not reject it).
    const opaqueClean = '{\n  // newer build\n  "enabledServers": { "v2": ["shots"] }\n}\n';
    await fs.writeFile(filePath, opaqueClean);
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    expect(await fs.readFile(filePath, "utf-8")).toBe(opaqueClean);
    // …but a key hidden in a SHADOWED duplicate property is still seen.
    await fs.writeFile(
      filePath,
      '{ "enabledServers": ["plugin:0123456789abcdef:echo"], "enabledServers": { "v2": [] } }'
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/duplicate|unrecognized/);

    // The owned fields prune cleanly, but a newer build's UNKNOWN top-level
    // field still carries the same instance key: success would retire the
    // tombstone while the key survives, so the prune is rejected (and the
    // owned-field edit is not written either — the document stays verbatim).
    const retained = JSON.stringify({
      enabledServers: ["plugin:0123456789abcdef:echo"],
      authorizations: { "plugin:0123456789abcdef:echo": "granted" },
    });
    await fs.writeFile(filePath, retained);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/fields this version does not edit/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(retained);
    // A DIFFERENT instance's key in that unknown field is not this prune's
    // concern; an ordinary server name that is not in canonical key shape is
    // not a hit either (a "plugin:" registration-wide prune passes too).
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabledServers: ["plugin:0123456789abcdef:echo", "myplugin:x"],
        authorizations: { "plugin:fedcba9876543210:echo": "granted" },
      })
    );
    await service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:");
    expect(jsoncParse(await fs.readFile(filePath, "utf-8"))).toEqual({
      enabledServers: ["myplugin:x"],
      authorizations: { "plugin:fedcba9876543210:echo": "granted" },
    });
    await fs.writeFile(filePath, JSON.stringify({ enabledServers: ["myplugin:x"] }));
    await service.prunePluginOverrideKeys(workspaceId, "plugin:");
  });

  it("prunePluginOverrideKeys rejects duplicate properties instead of mis-editing", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".mux", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);

    // Duplicate toolAllowlist properties: jsonc.parse exposes the LAST
    // object (holding the plugin key) while jsonc.modify edits the FIRST,
    // so a "successful" prune would leave the stale key in the effective
    // value. The prune must throw (caller keeps its retry tombstone).
    const duplicateAllowlist = `{
  "toolAllowlist": { "other": ["t2"] },
  "toolAllowlist": { "plugin:0123456789abcdef:echo": ["t1"] }
}
`;
    await fs.writeFile(filePath, duplicateAllowlist);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/duplicate "toolAllowlist"/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(duplicateAllowlist);

    // Duplicate enabledServers: the same parse/modify disagreement makes the
    // index-based removal loop spin on the unchanged effective array.
    await fs.writeFile(
      filePath,
      `{
  "enabledServers": ["other"],
  "enabledServers": ["plugin:0123456789abcdef:echo"]
}
`
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/duplicate "enabledServers"/);

    // Duplicate keys INSIDE toolAllowlist: removal by name hits the first,
    // parse exposes the last — the stale key would survive.
    await fs.writeFile(
      filePath,
      `{
  "toolAllowlist": { "plugin:0123456789abcdef:echo": ["t1"], "plugin:0123456789abcdef:echo": ["t2"] }
}
`
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.prunePluginOverrideKeys(workspaceId, "plugin:0123456789abcdef:")
    ).rejects.toThrow(/duplicate "plugin:0123456789abcdef:echo"/);
  });

  it("removes workspace-local file when overrides are set to empty", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a"],
    });

    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    await service.setOverridesForWorkspace(workspaceId, {});
    expect(await pathExists(filePath)).toBe(false);
  });

  it("runtime filesystem identity ignores non-identity fields and never matches Docker", () => {
    // Coder metadata: the workspace name selects the machine (see below), the
    // remaining flags do not.
    expect(
      runtimeFilesystemIdentity({
        type: "ssh",
        host: "box",
        srcBaseDir: "/srv",
        coder: { workspaceName: "w", existingWorkspace: true },
      } as never)
    ).toBe(
      runtimeFilesystemIdentity({
        type: "ssh",
        host: "box",
        srcBaseDir: "/other",
        coder: { workspaceName: "w" },
      } as never)
    );
    expect(
      runtimeFilesystemIdentity({ type: "ssh", host: "box", srcBaseDir: "/srv" } as never)
    ).not.toBe(
      runtimeFilesystemIdentity({ type: "ssh", host: "elsewhere", srcBaseDir: "/srv" } as never)
    );
    // Same alias, different port: a different machine. Default port is 22.
    expect(
      runtimeFilesystemIdentity({
        type: "ssh",
        host: "box",
        port: 2222,
        srcBaseDir: "/srv",
      } as never)
    ).not.toBe(
      runtimeFilesystemIdentity({ type: "ssh", host: "box", srcBaseDir: "/srv" } as never)
    );
    expect(
      runtimeFilesystemIdentity({ type: "ssh", host: "box", port: 22, srcBaseDir: "/srv" } as never)
    ).toBe(runtimeFilesystemIdentity({ type: "ssh", host: "box", srcBaseDir: "/srv" } as never));
    // Coder configs keep the raw placeholder host; the real endpoint comes from the workspace name.
    expect(
      runtimeFilesystemIdentity({
        type: "ssh",
        host: "coder://",
        srcBaseDir: "/srv",
        coder: { workspaceName: "alpha" },
      } as never)
    ).not.toBe(
      runtimeFilesystemIdentity({
        type: "ssh",
        host: "coder://",
        srcBaseDir: "/srv",
        coder: { workspaceName: "beta" },
      } as never)
    );
    // Project-dir and worktree workspaces live on the same host filesystem.
    expect(runtimeFilesystemIdentity({ type: "local" } as never)).toBe(
      runtimeFilesystemIdentity({ type: "worktree", srcBaseDir: "/x" } as never)
    );
    expect(
      runtimeFilesystemIdentity({ type: "docker", image: "node:20" } as never)
    ).toBeUndefined();
  });

  it("treats only stat's own no-such-file diagnostic as positive absence", () => {
    // Local runtimes: errno codes, possibly wrapped as `cause`.
    expect(isPositivelyAbsent(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
    expect(
      isPositivelyAbsent(
        new Error("wrapped", { cause: Object.assign(new Error(), { code: "ENOTDIR" }) })
      )
    ).toBe(true);
    expect(isPositivelyAbsent(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    // Exec-backed runtimes relay stat(1)'s stderr (GNU, busybox, BSD spellings).
    for (const stderr of [
      "stat: cannot statx '/w/.xum/mcp.local.jsonc': No such file or directory",
      "stat: can't stat '/w/.xum/mcp.local.jsonc': No such file or directory",
      "stat: /w/.xum/mcp.local.jsonc: stat: No such file or directory",
      "stat: cannot statx '/w/.xum/mcp.local.jsonc': Not a directory",
    ]) {
      expect(
        isPositivelyAbsent(new Error(`Failed to stat /w/.xum/mcp.local.jsonc: ${stderr}`))
      ).toBe(true);
    }
    // Transport/setup noise mentioning a missing file must stay indeterminate.
    expect(
      isPositivelyAbsent(
        new Error(
          "Failed to stat /w/.xum/mcp.local.jsonc: Warning: Identity file /home/u/.ssh/id not accessible: No such file or directory.\nssh: connect to host box port 22: Connection refused"
        )
      )
    ).toBe(false);
    expect(
      isPositivelyAbsent(
        new Error(
          "Failed to stat /w/.xum/mcp.local.jsonc: stat: cannot statx '/w/.xum/mcp.local.jsonc': Permission denied"
        )
      )
    ).toBe(false);
  });

  it("migrates legacy config.json overrides into workspace-local file", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            mcp: {
              disabledServers: ["server-a"],
              toolAllowlist: { "server-b": ["tool1"] },
            },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    const { overrides } = await service.getOverridesForWorkspace(workspaceId);

    expect(overrides).toEqual({
      disabledServers: ["server-a"],
      toolAllowlist: { "server-b": ["tool1"] },
    });

    // File written
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    // Legacy config cleared
    const loaded = config.loadConfigOrDefault();
    const projectConfig = loaded.projects.get(projectPath);
    expect(projectConfig).toBeDefined();
    expect(projectConfig!.workspaces[0].mcp).toBeUndefined();
  });

  it("a document with unknown top-level fields is child-owned and does not inherit", async () => {
    // A newer release may give a new field authorization semantics while every
    // known field is empty; a downgraded build must not inherit the parent's
    // enables over it (fail closed), only a document made of known empty
    // fields resolves as absent.
    const parentPath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "parent",
    });
    const childPath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "child",
    });
    await fs.mkdir(path.join(parentPath, ".xum"), { recursive: true });
    await fs.mkdir(path.join(childPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["shots"] })
    );
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/project", {
        workspaces: [
          {
            path: parentPath,
            id: "ws-parent",
            name: "parent",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
          {
            path: childPath,
            id: "ws-child",
            name: "child",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            parentWorkspaceId: "ws-parent",
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);
    const childFile = path.join(childPath, ".xum", "mcp.local.jsonc");
    // Known, empty fields: not a decision → inherits.
    await fs.writeFile(childFile, JSON.stringify({ enabledServers: [] }));
    expect((await service.getOverridesForWorkspace("ws-child")).overrides).toEqual({
      enabledServers: ["shots"],
    });
    // An unknown field with every known field empty: the child's own document.
    await fs.writeFile(childFile, JSON.stringify({ enabledServers: [], denyAll: true }));
    expect((await service.getOverridesForWorkspace("ws-child")).overrides).toEqual({});
  });

  it("keeps the legacy value when the replacement document cannot be written", async () => {
    // A repo can track `.xum` as a regular file, so the override directory
    // cannot be created. The save must fail without having cleared the legacy
    // value first — otherwise the child would inherit the parent's enables
    // instead of the settings the legacy value carried.
    const parentPath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "parent",
    });
    const childPath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName: "child",
    });
    await fs.mkdir(path.join(parentPath, ".xum"), { recursive: true });
    await fs.mkdir(childPath, { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["parent-enable"] })
    );
    await fs.writeFile(path.join(childPath, ".xum"), "tracked regular file\n");
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/project", {
        workspaces: [
          {
            path: parentPath,
            id: "ws-parent",
            name: "parent",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
          {
            path: childPath,
            id: "ws-child",
            name: "child",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            parentWorkspaceId: "ws-parent",
            mcp: { disabledServers: ["parent-enable"] },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      service.setOverridesForWorkspace("ws-child", { disabledServers: ["parent-enable", "x"] })
    ).rejects.toThrow();
    expect(config.loadConfigOrDefault().projects.get("/fake/project")!.workspaces[1].mcp).toEqual({
      disabledServers: ["parent-enable"],
    });
    expect((await service.getOverridesForWorkspace("ws-child")).overrides).toEqual({
      disabledServers: ["parent-enable"],
    });
  });

  it("never migrates legacy overrides over an existing document that normalizes to empty", async () => {
    // Downgrade↔upgrade: an older build wrote legacy config.json overrides
    // while a newer build's file holds only fields this build does not
    // understand. Migration must not clobber those fields.
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const newerBuildDocument = '{ "futureField": { "keep": true } }\n';
    await fs.writeFile(filePath, newerBuildDocument);

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            mcp: { disabledServers: ["server-a"] },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    const { overrides } = await service.getOverridesForWorkspace(workspaceId);
    // The newer build's document is the workspace's own configuration: it
    // decides (nothing this build can read → no overrides), the legacy value
    // does not shadow it…
    expect(overrides).toEqual({});
    // …and neither the file nor the legacy entry is rewritten.
    expect(await fs.readFile(filePath, "utf8")).toBe(newerBuildDocument);
    expect(config.loadConfigOrDefault().projects.get(projectPath)!.workspaces[0].mcp).toEqual({
      disabledServers: ["server-a"],
    });
  });
});
