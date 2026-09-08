import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import { parse as jsoncParse } from "jsonc-parser";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
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
        publish: (workspaceId, persisted) => {
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
    // one metadata load up front and one post-sweep re-resolution (each
    // loading config once), plus the batch's single legacy-config snapshot.
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    expect(configSpy).toHaveBeenCalledTimes(3);
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

  it("prunePluginOverrideKeysForWorkspaces fails a workspace renamed during the sweep", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const stable = await registerWorkspace("stable");
    const moved = await registerWorkspace("moved");
    await config.getAllWorkspaceMetadata();
    const realGetAll = config.getAllWorkspaceMetadata.bind(config);
    // Second load (the post-sweep re-resolution) sees the workspace under a
    // new name — exactly what a concurrent rename leaves behind.
    spyOn(config, "getAllWorkspaceMetadata")
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
          published.push({ via: "prune", enabled: persisted.enabledServers });
          return Promise.resolve();
        },
      }),
      service.setOverridesForWorkspace(
        workspaceId,
        { enabledServers: ["other-server", "third-server"] },
        {
          publish: (persisted) => {
            published.push({ via: "set", enabled: persisted.enabledServers });
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
});
