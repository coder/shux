import { describe, expect, test } from "bun:test";

import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  collectActiveWorkflowGroupKeys,
  computeSidebarTaskGroups,
  computeTaskGroupMemberRowMeta,
  shortenWorkflowRunId,
} from "./sidebarTaskGroups";

function createWorkspace(
  id: string,
  opts?: {
    parentWorkspaceId?: string;
    taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
    taskExecutionStatus?: FrontendWorkspaceMetadata["taskExecutionStatus"];
    title?: string;
    createdAt?: string;
    bestOf?: FrontendWorkspaceMetadata["bestOf"];
    workflowTask?: FrontendWorkspaceMetadata["workflowTask"];
  }
): FrontendWorkspaceMetadata {
  return {
    id,
    name: `${id}-name`,
    title: opts?.title ?? id,
    projectName: "demo",
    projectPath: "/projects/demo",
    namedWorkspacePath: `/projects/demo/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    createdAt: opts?.createdAt,
    parentWorkspaceId: opts?.parentWorkspaceId,
    taskExecutionStatus: opts?.taskExecutionStatus,
    taskStatus: opts?.taskStatus,
    bestOf: opts?.bestOf,
    workflowTask: opts?.workflowTask,
  };
}

const parent = createWorkspace("parent");

function workflowChild(
  id: string,
  runId: string,
  opts?: {
    taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
    taskExecutionStatus?: FrontendWorkspaceMetadata["taskExecutionStatus"];
    createdAt?: string;
    workflowName?: string;
    title?: string;
  }
): FrontendWorkspaceMetadata {
  return createWorkspace(id, {
    parentWorkspaceId: "parent",
    taskStatus: opts?.taskStatus ?? "running",
    taskExecutionStatus: opts?.taskExecutionStatus,
    createdAt: opts?.createdAt,
    title: opts?.title,
    workflowTask: {
      runId,
      stepId: `${id}-step`,
      workflowName: opts?.workflowName,
    },
  });
}

describe("computeSidebarTaskGroups", () => {
  test("groups workflow tasks per runId from the first member, separating concurrent runs", () => {
    const a1 = workflowChild("a1", "wfr_alpha", { workflowName: "review-pipeline" });
    const b1 = workflowChild("b1", "wfr_beta");
    const a2 = workflowChild("a2", "wfr_alpha");
    const single = workflowChild("solo", "wfr_solo");
    const rows = [parent, a1, b1, a2, single];

    const result = computeSidebarTaskGroups({ rows, allRows: rows });

    const alpha = result.groupsByStorageKey.get("workflow:parent:wfr_alpha");
    const beta = result.groupsByStorageKey.get("workflow:parent:wfr_beta");
    const solo = result.groupsByStorageKey.get("workflow:parent:wfr_solo");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // Single-member workflow groups form immediately (no min-2 rule).
    expect(solo).toBeDefined();
    // Non-contiguous members (b1 interleaves) still gather under one header.
    expect(alpha?.displayMembers.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(alpha?.anchorId).toBe("a1");
    expect(alpha?.title).toBe("review-pipeline");
    // Run without a stamped name falls back to the shortened run id.
    expect(beta?.title).toBe(shortenWorkflowRunId("wfr_beta"));
    expect(result.memberGroupStorageKeyByWorkspaceId.get("a2")).toBe("workflow:parent:wfr_alpha");
    expect(result.memberGroupStorageKeyByWorkspaceId.get("b1")).toBe("workflow:parent:wfr_beta");
  });

  test("bestOf grouping wins over workflow metadata and keeps the contiguity rule", () => {
    const both = createWorkspace("both", {
      parentWorkspaceId: "parent",
      taskStatus: "running",
      bestOf: { groupId: "bg", index: 0, total: 2 },
      workflowTask: { runId: "wfr_alpha", stepId: "s" },
    });
    const sibling = createWorkspace("sibling", {
      parentWorkspaceId: "parent",
      taskStatus: "running",
      bestOf: { groupId: "bg", index: 1, total: 2 },
    });
    // A non-member row between the two best-of members breaks contiguity.
    const interloper = createWorkspace("interloper", { parentWorkspaceId: "parent" });
    const contiguous = [parent, both, sibling, interloper];
    const interleaved = [parent, both, interloper, sibling];

    const grouped = computeSidebarTaskGroups({ rows: contiguous, allRows: contiguous });
    expect(grouped.memberGroupStorageKeyByWorkspaceId.get("both")).toBe("task:parent:bg");
    expect(grouped.groupsByStorageKey.get("workflow:parent:wfr_alpha")).toBeUndefined();

    const broken = computeSidebarTaskGroups({ rows: interleaved, allRows: interleaved });
    expect(broken.groupsByStorageKey.size).toBe(0);
  });

  test("excludes members that spawned their own sub-agents (leaf-only rule)", () => {
    const member = workflowChild("member", "wfr_alpha");
    const grandchild = createWorkspace("grandchild", { parentWorkspaceId: "member" });
    const rows = [parent, member, grandchild];

    const result = computeSidebarTaskGroups({ rows, allRows: rows });

    expect(result.groupsByStorageKey.size).toBe(0);
  });

  test("workflow groups display only active members from the visible sidebar rows", () => {
    const done = workflowChild("done", "wfr_alpha", {
      taskStatus: "reported",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const running = workflowChild("running", "wfr_alpha", {
      taskStatus: "running",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const allRows = [parent, done, running];
    const visibleRows = [parent, running];

    const active = computeSidebarTaskGroups({ rows: visibleRows, allRows });
    const activeGroup = active.groupsByStorageKey.get("workflow:parent:wfr_alpha");
    expect(activeGroup?.hasActiveMember).toBe(true);
    expect(activeGroup?.displayMembers.map((member) => member.id)).toEqual(["running"]);

    const selectedInactive = computeSidebarTaskGroups({
      rows: visibleRows,
      allRows,
      selectedWorkspaceId: "done",
    });
    expect(
      selectedInactive.groupsByStorageKey
        .get("workflow:parent:wfr_alpha")
        ?.displayMembers.map((member) => member.id)
    ).toEqual(["running"]);
  });

  test("counts reawakened grouped children by continuation state before retained reports", () => {
    const running = workflowChild("reawakened-running", "wfr_reawakened", {
      taskStatus: "reported",
      taskExecutionStatus: "running",
    });
    const queued = workflowChild("reawakened-queued", "wfr_reawakened", {
      taskStatus: "reported",
      taskExecutionStatus: "queued",
    });
    const rows = [parent, running, queued];

    const result = computeSidebarTaskGroups({ rows, allRows: rows });
    const group = result.groupsByStorageKey.get("workflow:parent:wfr_reawakened");

    expect(group).toMatchObject({
      runningCount: 1,
      queuedCount: 1,
      completedCount: 0,
      hasActiveMember: true,
    });
  });

  test("counts queued members as active so new runs default to expanded", () => {
    const queued = workflowChild("queued", "wfr_alpha", { taskStatus: "queued" });
    const rows = [parent, queued];

    const result = computeSidebarTaskGroups({ rows, allRows: rows });
    const group = result.groupsByStorageKey.get("workflow:parent:wfr_alpha");

    expect(group?.queuedCount).toBe(1);
    expect(group?.hasActiveMember).toBe(true);
  });
});

describe("workflow group session stickiness", () => {
  test("collectActiveWorkflowGroupKeys reports runs with non-terminal members only", () => {
    const running = workflowChild("running", "wfr_alpha", { taskStatus: "running" });
    const done = workflowChild("done", "wfr_beta", { taskStatus: "reported" });
    const queued = workflowChild("queued", "wfr_gamma", { taskStatus: "queued" });

    const keys = collectActiveWorkflowGroupKeys([parent, running, done, queued]);

    expect(keys.has("workflow:parent:wfr_alpha")).toBe(true);
    expect(keys.has("workflow:parent:wfr_beta")).toBe(false);
    expect(keys.has("workflow:parent:wfr_gamma")).toBe(true);
  });

  test("retains workflow groups for reawakened children before consulting retained reports", () => {
    const running = workflowChild("reawakened-running", "wfr_running", {
      taskStatus: "reported",
      taskExecutionStatus: "running",
    });
    const queued = workflowChild("reawakened-queued", "wfr_queued", {
      taskStatus: "reported",
      taskExecutionStatus: "queued",
    });

    const keys = collectActiveWorkflowGroupKeys([parent, running, queued]);

    expect(keys.has("workflow:parent:wfr_running")).toBe(true);
    expect(keys.has("workflow:parent:wfr_queued")).toBe(true);
  });
});

describe("computeTaskGroupMemberRowMeta", () => {
  const headerMetaBase: AgentRowRenderMeta = {
    depth: 1,
    rowKind: "subagent",
    connectorPosition: "middle",
    connectorStartsAtParent: true,
    sharedTrunkActiveThroughRow: true,
    sharedTrunkActiveBelowRow: true,
    ancestorTrunks: [{ depth: 1, active: false }],
    hasHiddenCompletedChildren: false,
    visibleCompletedChildrenCount: 0,
  };

  test("members form a sibling run under the header and inherit its trunks", () => {
    const first = workflowChild("first", "wfr_alpha", { taskStatus: "queued" });
    const second = workflowChild("second", "wfr_alpha", { taskStatus: "running" });
    const rows = [parent, first, second];
    const group = computeSidebarTaskGroups({ rows, allRows: rows }).groupsByStorageKey.get(
      "workflow:parent:wfr_alpha"
    );
    expect(group).toBeDefined();

    const meta = computeTaskGroupMemberRowMeta({
      group: group!,
      headerMeta: headerMetaBase,
      headerDepth: 1,
    });

    const firstMeta = meta.get("first");
    const secondMeta = meta.get("second");
    expect(firstMeta?.connectorPosition).toBe("middle");
    expect(firstMeta?.connectorStartsAtParent).toBe(true);
    // Trunk animates down to the lowest running member.
    expect(firstMeta?.sharedTrunkActiveThroughRow).toBe(true);
    expect(firstMeta?.sharedTrunkActiveBelowRow).toBe(true);
    expect(secondMeta?.connectorPosition).toBe("last");
    expect(secondMeta?.sharedTrunkActiveBelowRow).toBe(false);
    // Header is a middle sibling, so its trunk continues through member rows.
    expect(firstMeta?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
      { depth: 1, active: true },
    ]);
  });

  test("uses live activity for interrupted grouped-member connector state", () => {
    const first = workflowChild("first", "wfr_live", { taskStatus: "queued" });
    const interrupted = workflowChild("interrupted", "wfr_live", {
      taskStatus: "interrupted",
    });
    const rows = [parent, first, interrupted];
    const group = computeSidebarTaskGroups({
      rows,
      allRows: rows,
      isWorkspaceLiveActive: (workspaceId) => workspaceId === interrupted.id,
    }).groupsByStorageKey.get("workflow:parent:wfr_live");
    expect(group).toBeDefined();

    const meta = computeTaskGroupMemberRowMeta({
      group: group!,
      headerMeta: headerMetaBase,
      headerDepth: 1,
      isWorkspaceLiveActive: (workspaceId) => workspaceId === interrupted.id,
    });

    expect(meta.get("first")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(meta.get("first")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(meta.get("interrupted")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(meta.get("interrupted")?.sharedTrunkActiveBelowRow).toBe(false);
  });

  test("does not add a pass-through trunk when the header is the last sibling", () => {
    const only = workflowChild("only", "wfr_alpha");
    const rows = [parent, only];
    const group = computeSidebarTaskGroups({ rows, allRows: rows }).groupsByStorageKey.get(
      "workflow:parent:wfr_alpha"
    );

    const meta = computeTaskGroupMemberRowMeta({
      group: group!,
      headerMeta: { ...headerMetaBase, connectorPosition: "last", ancestorTrunks: [] },
      headerDepth: 1,
    });

    expect(meta.get("only")?.connectorPosition).toBe("single");
    expect(meta.get("only")?.ancestorTrunks).toEqual([]);
  });
});
