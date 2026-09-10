import { describe, it, expect } from "@jest/globals";
import { computePinnedDropOrder, computePinnedMoveOrder, locatePinnedBlock } from "./pinnedReorder";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";

const PROJECT = "/test/project";
const SUB_PROJECT = "/test/project/sub";

interface FixtureOptions {
  pinnedAt?: string;
  projectPath?: string;
  subProjectPath?: string;
  projects?: FrontendWorkspaceMetadata["projects"];
  kind?: FrontendWorkspaceMetadata["kind"];
}

const createWorkspace = (id: string, options: FixtureOptions = {}): FrontendWorkspaceMetadata => {
  const projectPath = options.projectPath ?? PROJECT;
  return {
    id,
    name: `workspace-${id}`,
    projectName: "test-project",
    projectPath,
    namedWorkspacePath: `${projectPath}/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    pinnedAt: options.pinnedAt,
    subProjectPath: options.subProjectPath,
    projects: options.projects,
    kind: options.kind,
  };
};

const projectConfig = (overrides: Partial<ProjectConfig> = {}): ProjectConfig => ({
  workspaces: [],
  ...overrides,
});

describe("locatePinnedBlock", () => {
  it("returns the whole project pinned list when there are no sections", () => {
    const rows = [
      createWorkspace("p1", { pinnedAt: "2026-01-01T00:00:00.000Z" }),
      createWorkspace("p2", { pinnedAt: "2026-01-01T00:00:01.000Z" }),
      createWorkspace("recent"),
    ];
    const sorted = new Map([[PROJECT, rows]]);
    const projects = new Map([[PROJECT, projectConfig()]]);

    const block = locatePinnedBlock(rows[0], sorted, projects);
    expect(block).toEqual({ fullOrder: ["p1", "p2"], blockIds: ["p1", "p2"] });
  });

  it("returns null for unpinned workspaces", () => {
    const rows = [createWorkspace("w1")];
    const sorted = new Map([[PROJECT, rows]]);
    expect(locatePinnedBlock(rows[0], sorted, new Map())).toBeNull();
  });

  it("scopes blockIds to the workspace's section while fullOrder spans the bucket", () => {
    const rows = [
      createWorkspace("unsectioned-pin", { pinnedAt: "2026-01-01T00:00:00.000Z" }),
      createWorkspace("sectioned-pin-1", {
        pinnedAt: "2026-01-01T00:00:01.000Z",
        subProjectPath: SUB_PROJECT,
      }),
      createWorkspace("sectioned-pin-2", {
        pinnedAt: "2026-01-01T00:00:02.000Z",
        subProjectPath: SUB_PROJECT,
      }),
    ];
    const sorted = new Map([[PROJECT, rows]]);
    const projects = new Map([
      [PROJECT, projectConfig()],
      [SUB_PROJECT, projectConfig({ parentProjectPath: PROJECT })],
    ]);

    const sectionBlock = locatePinnedBlock(rows[1], sorted, projects);
    expect(sectionBlock).toEqual({
      fullOrder: ["unsectioned-pin", "sectioned-pin-1", "sectioned-pin-2"],
      blockIds: ["sectioned-pin-1", "sectioned-pin-2"],
    });

    const unsectionedBlock = locatePinnedBlock(rows[0], sorted, projects);
    expect(unsectionedBlock).toEqual({
      fullOrder: ["unsectioned-pin", "sectioned-pin-1", "sectioned-pin-2"],
      blockIds: ["unsectioned-pin"],
    });
  });

  it("treats all pinned multi-project rows as one block", () => {
    const multiProjects = [
      { projectPath: "/test/a", projectName: "a" },
      { projectPath: "/test/b", projectName: "b" },
    ];
    const m1 = createWorkspace("m1", {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      projectPath: "/test/a",
      projects: multiProjects,
    });
    const m2 = createWorkspace("m2", {
      pinnedAt: "2026-01-01T00:00:01.000Z",
      projectPath: "/test/b",
      projects: multiProjects,
    });
    const sorted = new Map([[MULTI_PROJECT_CONFIG_KEY, [m1, m2]]]);

    // Primary projectPaths differ, yet both land in the same block.
    const block = locatePinnedBlock(m1, sorted, new Map());
    expect(block).toEqual({ fullOrder: ["m1", "m2"], blockIds: ["m1", "m2"] });
  });

  it("orders the multi-project block by pinnedAt across primary-project buckets", () => {
    // Multi-project rows can land under their primary project's bucket in the
    // sorted map. The block must follow global pinnedAt order (what the
    // Multi-Project section renders), not bucket iteration order, or a
    // cross-primary drop would compute a stale block and snap back.
    const multiProjects = [
      { projectPath: "/test/a", projectName: "a" },
      { projectPath: "/test/b", projectName: "b" },
    ];
    const mA = createWorkspace("mA", {
      pinnedAt: "2026-01-01T00:00:02.000Z",
      projectPath: "/test/a",
      projects: multiProjects,
    });
    const mB = createWorkspace("mB", {
      pinnedAt: "2026-01-01T00:00:01.000Z",
      projectPath: "/test/b",
      projects: multiProjects,
    });
    // Bucket order lists A's rows before B's, but B's pin is older.
    const sorted = new Map([
      ["/test/a", [mA]],
      ["/test/b", [mB]],
    ]);

    const block = locatePinnedBlock(mA, sorted, new Map());
    expect(block).toEqual({ fullOrder: ["mB", "mA"], blockIds: ["mB", "mA"] });
  });

  it("treats pinned roots from every project as one block in flat mode", () => {
    const a = createWorkspace("a", {
      pinnedAt: "2026-01-01T00:00:01.000Z",
      projectPath: "/test/a",
    });
    const b = createWorkspace("b", {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      projectPath: "/test/b",
    });
    const sorted = new Map([
      ["/test/a", [a]],
      ["/test/b", [b]],
    ]);

    expect(locatePinnedBlock(a, sorted, new Map(), { multiProjectEnabled: true })).toEqual({
      fullOrder: ["b", "a"],
      blockIds: ["b", "a"],
    });
  });

  it("excludes feature-gated multi-project pins from the flat block", () => {
    // With the multi-project experiment off the sidebar hides these rows, so
    // a move must swap with the next visible pin instead of an invisible row.
    const a = createWorkspace("a", {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      projectPath: "/test/a",
    });
    const hiddenMulti = createWorkspace("m", {
      pinnedAt: "2026-01-01T00:00:01.000Z",
      projectPath: "/test/a",
      projects: [
        { projectPath: "/test/a", projectName: "a" },
        { projectPath: "/test/b", projectName: "b" },
      ],
    });
    const b = createWorkspace("b", {
      pinnedAt: "2026-01-01T00:00:02.000Z",
      projectPath: "/test/b",
    });
    const sorted = new Map([
      ["/test/a", [a, hiddenMulti]],
      ["/test/b", [b]],
    ]);

    expect(locatePinnedBlock(a, sorted, new Map(), { multiProjectEnabled: false })).toEqual({
      fullOrder: ["a", "b"],
      blockIds: ["a", "b"],
    });
    // With the experiment on, the multi-project pin joins the block again.
    expect(locatePinnedBlock(a, sorted, new Map(), { multiProjectEnabled: true })).toEqual({
      fullOrder: ["a", "m", "b"],
      blockIds: ["a", "m", "b"],
    });
  });

  it("treats all pinned scratch rows as one block despite distinct workdir projectPaths", () => {
    // Each scratch chat's projectPath is its own app-managed workdir, but the
    // sidebar renders them together in the Chats section, so a reorder between
    // two pinned scratch chats must resolve to one shared block.
    const s1 = createWorkspace("s1", {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      projectPath: "/home/user/.mux/scratch/s1",
      kind: "scratch",
    });
    const s2 = createWorkspace("s2", {
      pinnedAt: "2026-01-01T00:00:01.000Z",
      projectPath: "/home/user/.mux/scratch/s2",
      kind: "scratch",
    });
    const sorted = new Map([["_scratch", [s1, s2]]]);

    const block = locatePinnedBlock(s1, sorted, new Map());
    expect(block).toEqual({ fullOrder: ["s1", "s2"], blockIds: ["s1", "s2"] });
  });
});

describe("computePinnedMoveOrder", () => {
  const block = { fullOrder: ["x", "a", "b", "c"], blockIds: ["a", "b", "c"] };

  it("swaps with the neighbor and recomposes the full order", () => {
    expect(computePinnedMoveOrder(block, "b", "up")).toEqual(["x", "b", "a", "c"]);
    expect(computePinnedMoveOrder(block, "b", "down")).toEqual(["x", "a", "c", "b"]);
  });

  it("is a no-op at block edges", () => {
    expect(computePinnedMoveOrder(block, "a", "up")).toBeNull();
    expect(computePinnedMoveOrder(block, "c", "down")).toBeNull();
  });

  it("is a no-op for ids outside the block", () => {
    expect(computePinnedMoveOrder(block, "x", "down")).toBeNull();
  });
});

describe("computePinnedDropOrder", () => {
  const block = { fullOrder: ["a", "b", "c", "d"], blockIds: ["a", "b", "c", "d"] };

  it("inserts before/after the target", () => {
    expect(computePinnedDropOrder(block, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(computePinnedDropOrder(block, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
  });

  it("returns null when the drop would not change anything", () => {
    expect(computePinnedDropOrder(block, "b", "a", "after")).toBeNull();
    expect(computePinnedDropOrder(block, "b", "c", "before")).toBeNull();
    expect(computePinnedDropOrder(block, "b", "b", "before")).toBeNull();
  });

  it("returns null when dragged or target ids left the block (stale drop)", () => {
    expect(computePinnedDropOrder(block, "ghost", "b", "before")).toBeNull();
    expect(computePinnedDropOrder(block, "b", "ghost", "before")).toBeNull();
  });
});
