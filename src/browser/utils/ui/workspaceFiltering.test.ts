import { describe, it, expect } from "@jest/globals";
import {
  partitionWorkspacesByAge,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
  buildSortedWorkspacesByProject,
  buildSortedWorkspacesFlat,
  orderMultiProjectSectionRows,
  computeWorkspaceDepthMap,
  computeAgentRowRenderMeta,
  computeDelegatedActivityByWorkspaceId,
  computeRowMetaForVisibleNodes,
  computeSubAgentsSummaryByWorkspaceId,
  excludeSubAgentRows,
  filterVisibleAgentRows,
  type AgentRowRenderMeta,
  type SidebarVisibleRowNode,
} from "./workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

interface WorkspaceFixtureOptions {
  projectPath?: string;
  projectName?: string;
  isInitializing?: boolean;
  parentWorkspaceId?: string;
  taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
  taskExecutionStatus?: FrontendWorkspaceMetadata["taskExecutionStatus"];
  reportedAt?: string;
  workflowTask?: FrontendWorkspaceMetadata["workflowTask"];
}

const createWorkspace = (
  id: string,
  projectPathOrOptions: string | WorkspaceFixtureOptions = {},
  isInitializing?: boolean,
  parentWorkspaceId?: string
): FrontendWorkspaceMetadata => {
  const options =
    typeof projectPathOrOptions === "string"
      ? { projectPath: projectPathOrOptions, isInitializing, parentWorkspaceId }
      : projectPathOrOptions;
  const projectPath = options.projectPath ?? "/test/project";

  return {
    id,
    name: `workspace-${id}`,
    projectName:
      options.projectName ??
      (projectPath === "/test/project"
        ? "test-project"
        : (projectPath.split("/").pop() ?? "unknown")),
    projectPath,
    namedWorkspacePath: `${projectPath}/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    isInitializing: options.isInitializing,
    parentWorkspaceId: options.parentWorkspaceId,
    taskStatus: options.taskStatus,
    taskExecutionStatus: options.taskExecutionStatus,
    reportedAt: options.reportedAt,
    workflowTask: options.workflowTask,
  };
};

const getAllOld = (buckets: FrontendWorkspaceMetadata[][]) => buckets.flat();

describe("partitionWorkspacesByAge", () => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("should partition workspaces into recent and old based on 24-hour threshold", () => {
    const workspaces = [
      createWorkspace("recent1"),
      createWorkspace("old1"),
      createWorkspace("recent2"),
      createWorkspace("old2"),
    ];

    const workspaceRecency = {
      recent1: now - 1000, // 1 second ago
      old1: now - ONE_DAY_MS - 1000, // 24 hours and 1 second ago
      recent2: now - 12 * 60 * 60 * 1000, // 12 hours ago
      old2: now - 2 * ONE_DAY_MS, // 2 days ago
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(2);
    expect(recent.map((w) => w.id)).toEqual(expect.arrayContaining(["recent1", "recent2"]));

    expect(old).toHaveLength(2);
    expect(old.map((w) => w.id)).toEqual(expect.arrayContaining(["old1", "old2"]));
  });

  it("should treat workspaces with no recency timestamp as old", () => {
    const workspaces = [createWorkspace("no-activity"), createWorkspace("recent")];

    const workspaceRecency = {
      recent: now - 1000,
      // no-activity has no timestamp
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("recent");

    expect(old).toHaveLength(1);
    expect(old[0].id).toBe("no-activity");
  });

  it("should handle empty workspace list", () => {
    const { recent, buckets } = partitionWorkspacesByAge([], {});

    expect(recent).toHaveLength(0);
    expect(buckets).toHaveLength(AGE_THRESHOLDS_DAYS.length);
    expect(buckets.every((b) => b.length === 0)).toBe(true);
  });

  it("should place a workspace at exactly 24 hours in the older-than-1-day tiers", () => {
    const workspaces = [createWorkspace("exactly-24h")];

    const workspaceRecency = {
      "exactly-24h": now - ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(1);
    expect(old[0]?.id).toBe("exactly-24h");
  });

  it("should preserve workspace order within partitions", () => {
    const workspaces = [
      createWorkspace("recent"),
      createWorkspace("old1"),
      createWorkspace("old2"),
      createWorkspace("old3"),
    ];

    const workspaceRecency = {
      recent: now - 1000,
      old1: now - 2 * ONE_DAY_MS,
      old2: now - 3 * ONE_DAY_MS,
      old3: now - 4 * ONE_DAY_MS,
    };

    const { buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(old.map((w) => w.id)).toEqual(["old1", "old2", "old3"]);
  });

  it("should keep all workspaces in old tiers when all are older than 1 day", () => {
    const workspaces = [createWorkspace("old1"), createWorkspace("old2"), createWorkspace("old3")];

    const workspaceRecency = {
      old1: now - 2 * ONE_DAY_MS,
      old2: now - 3 * ONE_DAY_MS,
      old3: now - 4 * ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(3);
    expect(old.map((w) => w.id)).toEqual(["old1", "old2", "old3"]);
  });

  it("should keep a lone workspace older than 1 day out of the recent section", () => {
    const workspaces = [createWorkspace("only-old")];

    const workspaceRecency = {
      "only-old": now - 2 * ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(1);
    expect(old[0]?.id).toBe("only-old");
  });

  it("should partition into correct age buckets", () => {
    const workspaces = [
      createWorkspace("recent"), // < 1 day
      createWorkspace("bucket0"), // 1-7 days
      createWorkspace("bucket1"), // 7-30 days
      createWorkspace("bucket2"), // > 30 days
    ];

    const workspaceRecency = {
      recent: now - 12 * 60 * 60 * 1000, // 12 hours
      bucket0: now - 3 * ONE_DAY_MS, // 3 days (1-7 day bucket)
      bucket1: now - 15 * ONE_DAY_MS, // 15 days (7-30 day bucket)
      bucket2: now - 60 * ONE_DAY_MS, // 60 days (>30 day bucket)
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);

    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("recent");

    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0].id).toBe("bucket0");

    expect(buckets[1]).toHaveLength(1);
    expect(buckets[1][0].id).toBe("bucket1");

    expect(buckets[2]).toHaveLength(1);
    expect(buckets[2][0].id).toBe("bucket2");
  });
});

describe("partitionWorkspacesByAge hierarchy grouping", () => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("keeps sub-agents in old tiers when their parent is older than one day", () => {
    const workspaces = [
      createWorkspace("old-parent"),
      createWorkspace("recent-active-child", {
        parentWorkspaceId: "old-parent",
        taskStatus: "running",
      }),
      createWorkspace("recent-completed-child", {
        parentWorkspaceId: "old-parent",
        taskStatus: "reported",
      }),
    ];

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, {
      "old-parent": now - 2 * ONE_DAY_MS,
      "recent-active-child": now - 60 * 60 * 1000,
      "recent-completed-child": now - 30 * 60 * 1000,
    });

    expect(recent).toHaveLength(0);
    expect(buckets[0].map((workspace) => workspace.id)).toEqual([
      "old-parent",
      "recent-active-child",
      "recent-completed-child",
    ]);
  });

  it("keeps sub-agents in the recent tier when their parent is recent", () => {
    const workspaces = [
      createWorkspace("recent-parent"),
      createWorkspace("old-active-child", {
        parentWorkspaceId: "recent-parent",
        taskStatus: "running",
      }),
      createWorkspace("old-completed-child", {
        parentWorkspaceId: "recent-parent",
        taskStatus: "reported",
      }),
    ];

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, {
      "recent-parent": now - 60 * 60 * 1000,
      "old-active-child": now - 8 * ONE_DAY_MS,
      "old-completed-child": now - 15 * ONE_DAY_MS,
    });

    expect(recent.map((workspace) => workspace.id)).toEqual([
      "recent-parent",
      "old-active-child",
      "old-completed-child",
    ]);
    expect(buckets.flat()).toHaveLength(0);
  });
});

describe("formatDaysThreshold", () => {
  it("should format singular day correctly", () => {
    expect(formatDaysThreshold(1)).toBe("1 day");
  });

  it("should format plural days correctly", () => {
    expect(formatDaysThreshold(7)).toBe("7 days");
    expect(formatDaysThreshold(30)).toBe("30 days");
  });
});

describe("buildSortedWorkspacesByProject", () => {
  it("should include workspaces from persisted config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should include pending workspaces not yet in config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
      ["pending1", createWorkspace("pending1", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(2);
    expect(result.get("/project/a")?.map((w) => w.id)).toContain("ws1");
    expect(result.get("/project/a")?.map((w) => w.id)).toContain("pending1");
  });

  it("should handle multiple concurrent pending workspaces", () => {
    const projects = new Map<string, ProjectConfig>([["/project/a", { workspaces: [] }]]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["pending1", createWorkspace("pending1", "/project/a", true)],
      ["pending2", createWorkspace("pending2", "/project/a", true)],
      ["pending3", createWorkspace("pending3", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(3);
  });

  it("should add pending workspaces for projects not yet in config", () => {
    const projects = new Map<string, ProjectConfig>();
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["pending1", createWorkspace("pending1", "/new/project", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/new/project")).toHaveLength(1);
    expect(result.get("/new/project")?.[0].id).toBe("pending1");
  });

  it("should use stable tie-breakers when recency is equal", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/ws1", id: "ws1" },
            { path: "/a/ws2", id: "ws2" },
            { path: "/a/ws3", id: "ws3" },
          ],
        },
      ],
    ]);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          ...createWorkspace("ws1", "/project/a"),
          name: "beta",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      [
        "ws2",
        {
          ...createWorkspace("ws2", "/project/a"),
          name: "alpha",
          createdAt: "2021-01-01T00:00:00.000Z",
        },
      ],
      [
        "ws3",
        {
          ...createWorkspace("ws3", "/project/a"),
          name: "aardvark",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    ]);

    // No recency timestamps → all ties
    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    // Tie-break order: createdAt desc, then name asc, then id asc
    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["ws2", "ws3", "ws1"]);
  });

  it("should sort workspaces by recency (most recent first)", () => {
    const now = Date.now();
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/ws1", id: "ws1" },
            { path: "/a/ws2", id: "ws2" },
            { path: "/a/ws3", id: "ws3" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
      ["ws2", createWorkspace("ws2", "/project/a")],
      ["ws3", createWorkspace("ws3", "/project/a")],
    ]);
    const recency = {
      ws1: now - 3000, // oldest
      ws2: now - 1000, // newest
      ws3: now - 2000, // middle
    };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["ws2", "ws3", "ws1"]);
  });

  it("should flatten child workspaces directly under their parent", () => {
    const now = Date.now();
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child1", id: "child1" },
            { path: "/a/child2", id: "child2" },
            { path: "/a/grand", id: "grand" },
          ],
        },
      ],
    ]);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["root", createWorkspace("root", "/project/a")],
      ["child1", createWorkspace("child1", "/project/a", undefined, "root")],
      ["child2", createWorkspace("child2", "/project/a", undefined, "root")],
      ["grand", createWorkspace("grand", "/project/a", undefined, "child1")],
    ]);

    // Child workspaces are more recent than the parent, but should still render below it.
    const recency = {
      child1: now - 1000,
      child2: now - 2000,
      grand: now - 3000,
      root: now - 4000,
    };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);
    expect(result.get("/project/a")?.map((w) => w.id)).toEqual([
      "root",
      "child1",
      "grand",
      "child2",
    ]);
  });

  it("keeps reachable descendants visible even for deep parent chains", () => {
    const depth = 40;
    const workspaces = Array.from({ length: depth + 1 }, (_, index) => ({
      path: `/a/ws-${index}`,
      id: `ws-${index}`,
    }));
    const projects = new Map<string, ProjectConfig>([["/project/a", { workspaces }]]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>(
      Array.from({ length: depth + 1 }, (_, index) => {
        const parentWorkspaceId = index === 0 ? undefined : `ws-${index - 1}`;
        return [
          `ws-${index}`,
          createWorkspace(`ws-${index}`, "/project/a", undefined, parentWorkspaceId),
        ] as const;
      })
    );

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")?.map((workspace) => workspace.id)).toEqual(
      Array.from({ length: depth + 1 }, (_, index) => `ws-${index}`)
    );
  });

  it("hides orphaned children whose parent is missing from active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["child", createWorkspace("child", "/project/a", undefined, "root")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toEqual([]);
  });

  it("hides transitive descendants when an ancestor is missing from active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
            { path: "/a/grand", id: "grand" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["child", createWorkspace("child", "/project/a", undefined, "root")],
      ["grand", createWorkspace("grand", "/project/a", undefined, "child")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toEqual([]);
  });

  it("keeps unrelated roots visible while hiding orphaned descendants", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/orphan", id: "orphan" },
            { path: "/a/standalone", id: "standalone" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["orphan", createWorkspace("orphan", "/project/a", undefined, "root")],
      ["standalone", createWorkspace("standalone", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["standalone"]);
  });

  it("reattaches hidden descendants when their parent returns to active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
          ],
        },
      ],
    ]);
    const child = createWorkspace("child", "/project/a", undefined, "root");

    const withoutParent = buildSortedWorkspacesByProject(
      projects,
      new Map<string, FrontendWorkspaceMetadata>([["child", child]]),
      {}
    );
    expect(withoutParent.get("/project/a")).toEqual([]);

    const withParent = buildSortedWorkspacesByProject(
      projects,
      new Map<string, FrontendWorkspaceMetadata>([
        ["root", createWorkspace("root", "/project/a")],
        ["child", child],
      ]),
      {}
    );

    expect(withParent.get("/project/a")?.map((w) => w.id)).toEqual(["root", "child"]);
  });

  it("should not duplicate workspaces that exist in both config and have creating status", () => {
    // Edge case: workspace was saved to config but still reports isInitializing
    // (this shouldn't happen in practice but tests defensive coding)
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should skip workspaces with no id in config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/legacy" }, { path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should skip config workspaces with no matching metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>(); // empty

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(0);
  });
});

describe("buildSortedWorkspacesFlat", () => {
  it("sorts all workspace kinds globally and keeps children under their parent", () => {
    const parent = {
      ...createWorkspace("parent", "/project/a"),
      projects: [
        { projectPath: "/project/a", projectName: "a" },
        { projectPath: "/project/b", projectName: "b" },
      ],
    };
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "pinned-late",
        {
          ...createWorkspace("pinned-late", "/project/a"),
          pinnedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        "pinned-early",
        {
          ...createWorkspace("pinned-early", "/project/b"),
          pinnedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      ["parent", parent],
      [
        "child",
        createWorkspace("child", { projectPath: "/project/a", parentWorkspaceId: "parent" }),
      ],
      ["scratch", { ...createWorkspace("scratch", "/scratch/path"), kind: "scratch" }],
      ["recent", createWorkspace("recent", "/project/b")],
    ]);

    const result = buildSortedWorkspacesFlat([...metadata.values()], {
      parent: 300,
      child: 1,
      scratch: 200,
      recent: 100,
    });

    expect(result.map((workspace) => workspace.id)).toEqual([
      "pinned-early",
      "pinned-late",
      "parent",
      "child",
      "scratch",
      "recent",
    ]);
  });
});
describe("buildSortedWorkspacesByProject pinning", () => {
  const now = Date.now();
  const projectsWithIds = (ids: string[]): Map<string, ProjectConfig> =>
    new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: ids.map((id) => ({ path: `/a/${id}`, id })) }],
    ]);

  it("sorts pinned chats above unpinned ones in pinnedAt order regardless of recency", () => {
    const projects = projectsWithIds(["ws1", "ws2", "ws3", "ws4"]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      // ws2 pinned second, ws4 pinned first: pin order must be ws4, ws2.
      ["ws1", createWorkspace("ws1", "/project/a")],
      ["ws2", { ...createWorkspace("ws2", "/project/a"), pinnedAt: "2026-01-02T00:00:00.000Z" }],
      ["ws3", createWorkspace("ws3", "/project/a")],
      ["ws4", { ...createWorkspace("ws4", "/project/a"), pinnedAt: "2026-01-01T00:00:00.000Z" }],
    ]);
    // Pinned rows have the *lowest* recency; unpinned ws1 is most recent.
    const recency = { ws1: now, ws2: now - 500_000, ws3: now - 1_000, ws4: now - 900_000 };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["ws4", "ws2", "ws1", "ws3"]);
  });

  it("keeps pin order stable when an unpinned chat's recency is bumped", () => {
    const projects = projectsWithIds(["pinnedA", "pinnedB", "free"]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "pinnedA",
        { ...createWorkspace("pinnedA", "/project/a"), pinnedAt: "2026-01-01T00:00:00.000Z" },
      ],
      [
        "pinnedB",
        { ...createWorkspace("pinnedB", "/project/a"), pinnedAt: "2026-01-02T00:00:00.000Z" },
      ],
      ["free", createWorkspace("free", "/project/a")],
    ]);

    const before = buildSortedWorkspacesByProject(projects, metadata, { free: now - 10_000 });
    // Simulate activity on the unpinned chat: it must stay below the pinned block.
    const after = buildSortedWorkspacesByProject(projects, metadata, { free: now });

    expect(before.get("/project/a")?.map((w) => w.id)).toEqual(["pinnedA", "pinnedB", "free"]);
    expect(after.get("/project/a")?.map((w) => w.id)).toEqual(["pinnedA", "pinnedB", "free"]);
  });

  it("keeps child rows attached under a pinned parent and ignores stale child pins", () => {
    const projects = projectsWithIds(["root", "child", "other"]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["root", { ...createWorkspace("root", "/project/a"), pinnedAt: "2026-01-01T00:00:00.000Z" }],
      [
        "child",
        {
          ...createWorkspace("child", { projectPath: "/project/a", parentWorkspaceId: "root" }),
          // Stale/malformed pin on a sub-agent must not detach it from its parent.
          pinnedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      ["other", createWorkspace("other", "/project/a")],
    ]);
    // The unpinned root is the most recent chat.
    const recency = { root: now - 500_000, child: now - 400_000, other: now };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["root", "child", "other"]);
  });

  it("ignores pinnedAt on archived workspaces", () => {
    const projects = projectsWithIds(["stale", "fresh"]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "stale",
        {
          ...createWorkspace("stale", "/project/a"),
          pinnedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      ["fresh", createWorkspace("fresh", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, { fresh: now });

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["fresh", "stale"]);
  });
});

describe("orderMultiProjectSectionRows", () => {
  it("floats pinned rows to the top in pinnedAt order and keeps unpinned relative order", () => {
    const rows = [
      createWorkspace("free-1", "/project/a"),
      { ...createWorkspace("pin-late", "/project/b"), pinnedAt: "2026-01-02T00:00:00.000Z" },
      createWorkspace("free-2", "/project/c"),
      { ...createWorkspace("pin-early", "/project/a"), pinnedAt: "2026-01-01T00:00:00.000Z" },
    ];

    expect(orderMultiProjectSectionRows(rows).map((w) => w.id)).toEqual([
      "pin-early",
      "pin-late",
      "free-1",
      "free-2",
    ]);
  });

  it("keeps sub-agent children attached under their pinned parent", () => {
    const parent = {
      ...createWorkspace("parent", "/project/b"),
      pinnedAt: "2026-01-01T00:00:00.000Z",
    };
    const child = createWorkspace("child", {
      projectPath: "/project/b",
      parentWorkspaceId: "parent",
    });
    const other = createWorkspace("other", "/project/a");

    expect(orderMultiProjectSectionRows([other, child, parent]).map((w) => w.id)).toEqual([
      "parent",
      "child",
      "other",
    ]);
  });
});

describe("partitionWorkspacesByAge pinning", () => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("classifies an old pinned root and its children as recent", () => {
    const pinnedRoot = {
      ...createWorkspace("pinned-root"),
      pinnedAt: "2026-01-01T00:00:00.000Z",
    };
    const child = createWorkspace("child", { parentWorkspaceId: "pinned-root" });
    const oldFree = createWorkspace("old-free");

    const { recent, buckets } = partitionWorkspacesByAge([pinnedRoot, child, oldFree], {
      "pinned-root": now - 40 * ONE_DAY_MS,
      child: now - 40 * ONE_DAY_MS,
      "old-free": now - 40 * ONE_DAY_MS,
    });

    expect(recent.map((w) => w.id)).toEqual(["pinned-root", "child"]);
    expect(getAllOld(buckets).map((w) => w.id)).toEqual(["old-free"]);
  });
});

describe("delegated workspace activity roll-up", () => {
  it("rolls active workflow-owned descendants up to every ancestor", () => {
    const workflowTask = { runId: "run-1", stepId: "step-1" };
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("workflow-child", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask,
      }),
      createWorkspace("grandchild", {
        parentWorkspaceId: "workflow-child",
        taskStatus: "awaiting_report",
      }),
      createWorkspace("queued-grandchild", {
        parentWorkspaceId: "workflow-child",
        taskStatus: "queued",
      }),
      createWorkspace("reported-grandchild", {
        parentWorkspaceId: "workflow-child",
        taskStatus: "reported",
      }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces);

    expect(activityByWorkspaceId.get("parent")).toEqual({
      activeCount: 2,
      queuedCount: 1,
      workflowActiveCount: 2,
      workflowQueuedCount: 1,
    });
    expect(activityByWorkspaceId.get("workflow-child")).toEqual({
      activeCount: 1,
      queuedCount: 1,
      workflowActiveCount: 1,
      workflowQueuedCount: 1,
    });
    expect(activityByWorkspaceId.has("reported-grandchild")).toBe(false);
  });

  it("deduplicates duplicate workspace metadata and ignores cycles", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("cycle-a", { parentWorkspaceId: "cycle-b", taskStatus: "running" }),
      createWorkspace("cycle-b", { parentWorkspaceId: "cycle-a", taskStatus: "running" }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces);

    expect(activityByWorkspaceId.get("parent")?.activeCount).toBe(1);
    expect(activityByWorkspaceId.has("cycle-a")).toBe(false);
    expect(activityByWorkspaceId.has("cycle-b")).toBe(false);
  });

  it("keeps resumed descendants active even when reportedAt is stale", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("resumed-child", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        reportedAt: new Date(0).toISOString(),
      }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces);

    expect(activityByWorkspaceId.get("parent")?.activeCount).toBe(1);
  });

  it("rolls reawakened continuation activity up despite the retained report", () => {
    const reportedAt = new Date(0).toISOString();
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("running-continuation", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        reportedAt,
        taskExecutionStatus: "running",
      }),
      createWorkspace("queued-continuation", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        reportedAt,
        taskExecutionStatus: "queued",
      }),
    ];

    expect(computeDelegatedActivityByWorkspaceId(workspaces).get("parent")).toEqual({
      activeCount: 1,
      queuedCount: 1,
      workflowActiveCount: 0,
      workflowQueuedCount: 0,
    });
  });

  it("keeps live interrupted descendants active until report finalization", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("interrupted-live-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
      }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces, {
      isWorkspaceLiveActive: (workspaceId) => workspaceId === "interrupted-live-child",
    });

    expect(activityByWorkspaceId.get("parent")?.activeCount).toBe(1);
  });

  it("does not resurrect terminal descendants from stale live sidebar activity", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("reported-child", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
      }),
      createWorkspace("interrupted-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
        reportedAt: new Date(0).toISOString(),
      }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces, {
      isWorkspaceLiveActive: (workspaceId) =>
        workspaceId === "reported-child" || workspaceId === "interrupted-child",
    });

    expect(activityByWorkspaceId.has("parent")).toBe(false);
  });

  it("uses live sidebar activity when task metadata lags", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("child", { parentWorkspaceId: "parent" }),
    ];

    const activityByWorkspaceId = computeDelegatedActivityByWorkspaceId(workspaces, {
      isWorkspaceLiveActive: (workspaceId) => workspaceId === "child",
    });

    expect(activityByWorkspaceId.get("parent")?.activeCount).toBe(1);
  });
});

describe("excludeSubAgentRows", () => {
  it("drops rows whose parent chain is present but keeps promoted orphans", () => {
    const workspaces = [
      createWorkspace("root"),
      createWorkspace("child", { parentWorkspaceId: "root", taskStatus: "running" }),
      createWorkspace("grandchild", { parentWorkspaceId: "child", taskStatus: "running" }),
      createWorkspace("orphan", { parentWorkspaceId: "missing-parent", taskStatus: "running" }),
    ];

    expect(excludeSubAgentRows(workspaces).map((workspace) => workspace.id)).toEqual([
      "root",
      "orphan",
    ]);
  });

  it("keeps members of malformed parent cycles visible", () => {
    const workspaces = [
      createWorkspace("root"),
      createWorkspace("hidden-child", { parentWorkspaceId: "root", taskStatus: "running" }),
      createWorkspace("cycle-a", { parentWorkspaceId: "cycle-b" }),
      createWorkspace("cycle-b", { parentWorkspaceId: "cycle-a" }),
      createWorkspace("cycle-descendant", { parentWorkspaceId: "cycle-a" }),
    ];

    expect(excludeSubAgentRows(workspaces).map((workspace) => workspace.id)).toEqual([
      "root",
      "cycle-a",
      "cycle-b",
      "cycle-descendant",
    ]);
  });
});

describe("hidden sub-agents summary roll-up", () => {
  it("counts user-owned descendants at every level with active/queued split", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("running-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("queued-child", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("reported-child", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("grandchild", {
        parentWorkspaceId: "running-child",
        taskStatus: "reported",
      }),
    ];

    expect(computeSubAgentsSummaryByWorkspaceId(workspaces).get("parent")).toEqual({
      subAgentCount: 4,
      runningSubAgentCount: 1,
      queuedSubAgentCount: 1,
      runningWorkflowRunCount: 0,
      queuedWorkflowRunCount: 0,
      runningWorkflowAgentCount: 0,
      queuedWorkflowAgentCount: 0,
      workflowRunIds: new Set(),
      workflowName: undefined,
    });
  });

  it("counts workflow workers separately with distinct runs and the run name", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("worker-a", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "run-1", stepId: "step-1", workflowName: "Deep Research" },
      }),
      createWorkspace("worker-b", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "run-1", stepId: "step-2", workflowName: "Deep Research" },
      }),
      createWorkspace("worker-other-run", {
        parentWorkspaceId: "parent",
        taskStatus: "queued",
        workflowTask: { runId: "run-2", stepId: "step-1" },
      }),
      createWorkspace("finished-worker", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        workflowTask: { runId: "run-3", stepId: "step-1" },
      }),
      createWorkspace("user-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    expect(computeSubAgentsSummaryByWorkspaceId(workspaces).get("parent")).toEqual({
      subAgentCount: 1,
      runningSubAgentCount: 1,
      queuedSubAgentCount: 0,
      runningWorkflowRunCount: 1,
      queuedWorkflowRunCount: 1,
      runningWorkflowAgentCount: 2,
      queuedWorkflowAgentCount: 1,
      workflowRunIds: new Set(["run-1", "run-2"]),
      workflowName: "Deep Research",
      runningWorkflowStepTitle: "workspace-worker-a",
    });
  });

  it("treats descendants of workflow workers as workflow-owned", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("worker", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "run-1", stepId: "step-1" },
      }),
      createWorkspace("worker-child", { parentWorkspaceId: "worker", taskStatus: "running" }),
    ];

    expect(computeSubAgentsSummaryByWorkspaceId(workspaces).get("parent")).toEqual({
      subAgentCount: 0,
      runningSubAgentCount: 0,
      queuedSubAgentCount: 0,
      runningWorkflowRunCount: 1,
      queuedWorkflowRunCount: 0,
      runningWorkflowAgentCount: 2,
      queuedWorkflowAgentCount: 0,
      workflowRunIds: new Set(["run-1"]),
      workflowName: undefined,
      runningWorkflowStepTitle: "workspace-worker",
    });
  });

  it("omits workspaces without descendants and uses the live-active fallback", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("leaf"),
      createWorkspace("lagging-child", { parentWorkspaceId: "parent" }),
    ];

    const summaryByWorkspaceId = computeSubAgentsSummaryByWorkspaceId(workspaces, {
      isWorkspaceLiveActive: (workspaceId) => workspaceId === "lagging-child",
    });

    expect(summaryByWorkspaceId.has("leaf")).toBe(false);
    expect(summaryByWorkspaceId.get("parent")).toEqual({
      subAgentCount: 1,
      runningSubAgentCount: 1,
      queuedSubAgentCount: 0,
      runningWorkflowRunCount: 0,
      queuedWorkflowRunCount: 0,
      runningWorkflowAgentCount: 0,
      queuedWorkflowAgentCount: 0,
      workflowRunIds: new Set(),
      workflowName: undefined,
    });
  });

  it("labels a workerless active run through the retained-name lookup", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("owner-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const summary = computeSubAgentsSummaryByWorkspaceId(workspaces, {
      getActiveWorkflowRunIds: (workspaceId) => (workspaceId === "owner-child" ? ["run-gap"] : []),
      getWorkflowRunName: (runId) => (runId === "run-gap" ? "Deep Research" : undefined),
    }).get("parent");

    expect(summary?.runningWorkflowRunCount).toBe(1);
    expect(summary?.workflowName).toBe("Deep Research");
  });

  it("counts a hidden owner's workerless active run as running", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("owner-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const summary = computeSubAgentsSummaryByWorkspaceId(workspaces, {
      getActiveWorkflowRunIds: (workspaceId) => (workspaceId === "owner-child" ? ["run-gap"] : []),
    }).get("parent");

    expect(summary?.runningWorkflowRunCount).toBe(1);
    expect(summary?.runningWorkflowAgentCount).toBe(0);
    expect(summary?.workflowRunIds).toEqual(new Set(["run-gap"]));
  });

  it("keeps a queued-worker run queued even when its owner lists it as active", () => {
    const workspaces = [
      createWorkspace("parent"),
      createWorkspace("owner-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("queued-worker", {
        parentWorkspaceId: "owner-child",
        taskStatus: "queued",
        workflowTask: { runId: "run-1", stepId: "step-1" },
      }),
    ];

    const summary = computeSubAgentsSummaryByWorkspaceId(workspaces, {
      getActiveWorkflowRunIds: (workspaceId) => (workspaceId === "owner-child" ? ["run-1"] : []),
    }).get("parent");

    expect(summary?.runningWorkflowRunCount).toBe(0);
    expect(summary?.queuedWorkflowRunCount).toBe(1);
    expect(summary?.queuedWorkflowAgentCount).toBe(1);
  });
});

describe("sub-agent row render metadata", () => {
  it("assigns middle/last connector positions for a parent with three active children", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-3", { parentWorkspaceId: "parent", taskStatus: "awaiting_report" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-2")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-3")?.connectorPosition).toBe("last");

    expect(metadataByWorkspaceId.get("child-1")?.depth).toBe(1);
    expect(metadataByWorkspaceId.get("child-1")?.rowKind).toBe("subagent");
    expect(metadataByWorkspaceId.get("parent")?.rowKind).toBe("primary");
  });

  it("animates the shared trunk through the lowest running child", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-3", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-4", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.connectorStartsAtParent).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.connectorStartsAtParent).toBe(false);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-3")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-4")?.sharedTrunkActiveThroughRow).toBe(false);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-3")?.sharedTrunkActiveBelowRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-4")?.sharedTrunkActiveBelowRow).toBe(false);
  });

  it("does not animate shared trunk segments when no children are running", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "awaiting_report" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveThroughRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveThroughRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveBelowRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveBelowRow).toBe(false);
  });

  it("assigns single connector position for an only child", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("only-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("only-child")?.connectorPosition).toBe("single");
  });

  it("keeps inactive children out of the sidebar even when legacy expansion state is present", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-child", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("interrupted-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
      }),
    ];

    const legacyExpandedParentIds = new Set<string>(["parent"]);
    expect(
      filterVisibleAgentRows(flattened, legacyExpandedParentIds).map((workspace) => workspace.id)
    ).toEqual(["parent", "active-child"]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      legacyExpandedParentIds
    );
    expect(metadataByWorkspaceId.has("reported-child")).toBe(false);
    expect(metadataByWorkspaceId.has("interrupted-child")).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
  });

  it("promotes active descendants through inactive persistent parents", () => {
    const flattened = [
      createWorkspace("root"),
      createWorkspace("inactive-parent", {
        parentWorkspaceId: "root",
        taskStatus: "reported",
      }),
      createWorkspace("active-grandchild", {
        parentWorkspaceId: "inactive-parent",
        taskStatus: "running",
      }),
    ];

    expect(filterVisibleAgentRows(flattened).map((workspace) => workspace.id)).toEqual([
      "root",
      "active-grandchild",
    ]);
    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(metadataByWorkspaceId.get("active-grandchild")).toMatchObject({
      depth: 1,
      rowKind: "subagent",
      connectorStartsAtParent: true,
    });
  });

  it("keeps running children with stale reportedAt visible and out of completed counts", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("resumed-child", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        reportedAt: "2026-03-09T11:05:58.780Z",
      }),
    ];

    const visible = filterVisibleAgentRows(flattened);
    expect(visible.map((workspace) => workspace.id)).toEqual(["parent", "resumed-child"]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
    expect(metadataByWorkspaceId.has("resumed-child")).toBe(true);
  });

  it("keeps reawakened reported children visible while completed rows are collapsed", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("reawakened-child", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        reportedAt: "2026-08-09T00:00:00.000Z",
        taskExecutionStatus: "running",
      }),
    ];

    expect(filterVisibleAgentRows(flattened).map((workspace) => workspace.id)).toEqual([
      "parent",
      "reawakened-child",
    ]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
    expect(metadataByWorkspaceId.has("reawakened-child")).toBe(true);
  });

  it("hides interrupted children from the sidebar", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("unfinished-interrupted-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
      }),
    ];

    expect(filterVisibleAgentRows(flattened).map((workspace) => workspace.id)).toEqual(["parent"]);
    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    expect(
      computeAgentRowRenderMeta(flattened, depthByWorkspaceId).has("unfinished-interrupted-child")
    ).toBe(false);
  });

  it("does not resurrect reported children from stale live workspace state", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("reported-child", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        taskExecutionStatus: "completed",
      }),
    ];
    const options = {
      isWorkspaceLiveActive: (workspaceId: string) => workspaceId === "reported-child",
    };

    expect(
      filterVisibleAgentRows(flattened, new Set(), options).map((workspace) => workspace.id)
    ).toEqual(["parent"]);
    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    expect(
      computeAgentRowRenderMeta(flattened, depthByWorkspaceId, new Set(), options).has(
        "reported-child"
      )
    ).toBe(false);
  });

  it("propagates ancestor trunk continuation metadata for nested rows", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("gc-2", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-a")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-b")?.connectorPosition).toBe("last");
    expect(metadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
    expect(metadataByWorkspaceId.get("gc-2")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
  });

  it("does not propagate ancestor trunk metadata when parent branch does not continue", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("gc-2", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-a")?.connectorPosition).toBe("single");
    expect(metadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([]);
    expect(metadataByWorkspaceId.get("gc-2")?.ancestorTrunks).toEqual([]);
  });

  it("marks ancestor trunk continuation as active through nested rows when lower siblings run", () => {
    const flattenedWithRunningSibling = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const runningDepthByWorkspaceId = computeWorkspaceDepthMap(flattenedWithRunningSibling);
    const runningMetadataByWorkspaceId = computeAgentRowRenderMeta(
      flattenedWithRunningSibling,
      runningDepthByWorkspaceId
    );
    expect(runningMetadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: true },
    ]);

    const flattenedWithoutRunningSibling = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];
    const inactiveDepthByWorkspaceId = computeWorkspaceDepthMap(flattenedWithoutRunningSibling);
    const inactiveMetadataByWorkspaceId = computeAgentRowRenderMeta(
      flattenedWithoutRunningSibling,
      inactiveDepthByWorkspaceId
    );
    expect(inactiveMetadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
  });

  it("preserves active child ordering while ignoring legacy expansion state", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-1", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("active-2", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-2", { parentWorkspaceId: "parent", taskStatus: "reported" }),
    ];

    const collapsedVisible = filterVisibleAgentRows(flattened);
    expect(collapsedVisible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "active-1",
      "active-2",
    ]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const collapsedMeta = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(collapsedMeta.get("active-1")?.connectorPosition).toBe("middle");
    expect(collapsedMeta.get("active-2")?.connectorPosition).toBe("last");

    const legacyExpandedParentIds = new Set<string>(["parent"]);
    expect(
      filterVisibleAgentRows(flattened, legacyExpandedParentIds).map((workspace) => workspace.id)
    ).toEqual(["parent", "active-1", "active-2"]);

    const legacyExpandedMeta = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      legacyExpandedParentIds
    );
    expect(legacyExpandedMeta.get("active-1")?.connectorPosition).toBe("middle");
    expect(legacyExpandedMeta.get("active-2")?.connectorPosition).toBe("last");
    expect(legacyExpandedMeta.has("reported-1")).toBe(false);
    expect(legacyExpandedMeta.has("reported-2")).toBe(false);
  });
});

describe("computeRowMetaForVisibleNodes", () => {
  const baseMeta = (depth: number): AgentRowRenderMeta => ({
    depth,
    rowKind: "subagent",
    connectorPosition: "single",
    connectorStartsAtParent: false,
    sharedTrunkActiveThroughRow: false,
    sharedTrunkActiveBelowRow: false,
    ancestorTrunks: [],
    hasHiddenCompletedChildren: false,
    visibleCompletedChildrenCount: 0,
  });

  const node = (
    id: string,
    parentId: string | undefined,
    depth: number,
    isRunning = false
  ): SidebarVisibleRowNode => ({ id, parentId, depth, isRunning, baseMeta: baseMeta(depth) });

  it("treats synthetic group-header nodes as ordinary siblings for connector geometry", () => {
    const meta = computeRowMetaForVisibleNodes([
      node("root", undefined, 0),
      node("child-a", "root", 1, true),
      // Synthetic header node sits between two workspace siblings.
      node("workflow:root:wfr_x", "root", 1, true),
      node("child-b", "root", 1),
      node("grandchild", "child-b", 2),
    ]);

    const header = meta.get("workflow:root:wfr_x");
    expect(header?.connectorPosition).toBe("middle");
    expect(header?.connectorStartsAtParent).toBe(false);
    // The shared trunk animates down to the lowest running sibling (the header).
    expect(header?.sharedTrunkActiveThroughRow).toBe(true);
    expect(header?.sharedTrunkActiveBelowRow).toBe(false);
    expect(meta.get("child-a")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(meta.get("child-b")?.connectorPosition).toBe("last");

    // Descendants of a middle sibling receive its continuing trunk.
    const grandchild = meta.get("grandchild");
    expect(grandchild?.connectorPosition).toBe("single");
    expect(grandchild?.ancestorTrunks).toEqual([]);
  });

  it("gives descendants of middle siblings an ancestor trunk at the sibling depth", () => {
    const meta = computeRowMetaForVisibleNodes([
      node("root", undefined, 0),
      node("child-a", "root", 1),
      node("nested", "child-a", 2),
      node("child-b", "root", 1, true),
    ]);

    expect(meta.get("child-a")?.connectorPosition).toBe("middle");
    expect(meta.get("nested")?.ancestorTrunks).toEqual([{ depth: 1, active: true }]);
  });
});
