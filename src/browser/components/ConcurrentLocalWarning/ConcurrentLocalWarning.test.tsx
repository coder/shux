import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { WorkspaceSidebarState, WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WORKSPACE_STREAMING_STATUS_TRANSITION_MS } from "@/constants/streaming";
import { useConcurrentLocalStreamingWorkspaceName } from "./ConcurrentLocalWarning";

const subscribers = new Set<() => void>();
const streamingWorkspaceIds = new Set<string>();

const fakeStore = {
  subscribeKey: (_workspaceId: string, listener: () => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  getWorkspaceSidebarState: (workspaceId: string) => {
    const state: WorkspaceSidebarState = {
      canInterrupt: streamingWorkspaceIds.has(workspaceId),
      isStarting: false,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: null,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      activeWorkflowRunCount: 0,
      activeBashMonitorCount: 0,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
    };
    return state;
  },
} as unknown as WorkspaceStore;

const otherWorkspaceMetadata: FrontendWorkspaceMetadata = {
  id: "other-workspace",
  name: "refactor-db",
  projectName: "mux",
  projectPath: "/repo",
  namedWorkspacePath: "/repo",
  runtimeConfig: { type: "local" },
};
const currentWorkspaceMetadata: FrontendWorkspaceMetadata = {
  ...otherWorkspaceMetadata,
  id: "current-workspace",
  name: "current",
};
const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();

function WarningNameProbe(props: { workspaceId?: string }) {
  const streamingWorkspaceName = useConcurrentLocalStreamingWorkspaceName({
    workspaceId: props.workspaceId ?? currentWorkspaceMetadata.id,
    projectPath: "/repo",
    runtimeConfig: { type: "local" },
  });

  return streamingWorkspaceName === null ? null : <div>{streamingWorkspaceName}</div>;
}

function notifyWorkspaceStateChanged(): void {
  for (const listener of subscribers) {
    listener();
  }
}

describe("ConcurrentLocalWarning", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    subscribers.clear();
    streamingWorkspaceIds.clear();
    streamingWorkspaceIds.add(otherWorkspaceMetadata.id);
    workspaceMetadata.clear();
    workspaceMetadata.set(currentWorkspaceMetadata.id, currentWorkspaceMetadata);
    workspaceMetadata.set(otherWorkspaceMetadata.id, otherWorkspaceMetadata);
    spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockReturnValue(fakeStore);
    spyOn(WorkspaceContextModule, "useWorkspaceContext").mockReturnValue({
      workspaceMetadata,
    } as WorkspaceContext);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    subscribers.clear();
  });

  test.each([
    ["child", undefined, "current-workspace"],
    ["parent", "other-workspace", undefined],
    ["sibling with an absent parent row", "parent", "parent"],
    ["nested child", undefined, "current-child"],
    ["cousin", "current-child", "other-child"],
  ])(
    "does not flash for an active %s in the same task family",
    (_label, currentParent, otherParent) => {
      workspaceMetadata.set(currentWorkspaceMetadata.id, {
        ...currentWorkspaceMetadata,
        parentWorkspaceId: currentParent,
      });
      workspaceMetadata.set(otherWorkspaceMetadata.id, {
        ...otherWorkspaceMetadata,
        parentWorkspaceId: otherParent,
      });
      workspaceMetadata.set("current-child", {
        ...currentWorkspaceMetadata,
        id: "current-child",
        parentWorkspaceId: currentParent ? "root" : currentWorkspaceMetadata.id,
      });
      workspaceMetadata.set("other-child", {
        ...otherWorkspaceMetadata,
        id: "other-child",
        parentWorkspaceId: "root",
      });

      const result = render(<WarningNameProbe />);
      expect(result.queryByText(otherWorkspaceMetadata.name)).toBeNull();
      act(() => {
        streamingWorkspaceIds.clear();
        notifyWorkspaceStateChanged();
        streamingWorkspaceIds.add(otherWorkspaceMetadata.id);
        notifyWorkspaceStateChanged();
      });
      expect(result.queryByText(otherWorkspaceMetadata.name)).toBeNull();
    }
  );

  test("still warns for an unrelated task family's active sub-agent", () => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, {
      ...otherWorkspaceMetadata,
      parentWorkspaceId: "unrelated-root",
    });
    const result = render(<WarningNameProbe />);
    expect(result.getByText(otherWorkspaceMetadata.name)).toBeTruthy();
  });

  test.each([
    { projectPath: "/other-repo" },
    { runtimeConfig: { type: "worktree" as const, srcBaseDir: "/worktrees" } },
    { runtimeConfig: { type: "local" as const, srcBaseDir: "/legacy-worktrees" } },
  ])("does not warn about an isolated or different project: %j", (override) => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, { ...otherWorkspaceMetadata, ...override });
    const result = render(<WarningNameProbe />);
    expect(result.queryByText(otherWorkspaceMetadata.name)).toBeNull();
  });

  test("terminates safely on a malformed parent cycle", () => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, {
      ...otherWorkspaceMetadata,
      parentWorkspaceId: otherWorkspaceMetadata.id,
    });
    const result = render(<WarningNameProbe />);
    expect(result.getByText(otherWorkspaceMetadata.name)).toBeTruthy();
  });

  test("does not carry a warning into the active agent's own sub-agent", () => {
    workspaceMetadata.set("child", {
      ...currentWorkspaceMetadata,
      id: "child",
      parentWorkspaceId: otherWorkspaceMetadata.id,
    });
    const result = render(<WarningNameProbe />);
    expect(result.getByText(otherWorkspaceMetadata.name)).toBeTruthy();

    result.rerender(<WarningNameProbe workspaceId="child" />);
    expect(result.queryByText(otherWorkspaceMetadata.name)).toBeNull();
  });

  test("holds the warning across a brief activity handoff", async () => {
    const result = render(<WarningNameProbe />);
    expect(result.getByText("refactor-db")).toBeTruthy();

    act(() => {
      streamingWorkspaceIds.clear();
      notifyWorkspaceStateChanged();
    });

    expect(result.getByText("refactor-db")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) =>
        window.setTimeout(resolve, WORKSPACE_STREAMING_STATUS_TRANSITION_MS + 50)
      );
    });
    await waitFor(() => expect(result.queryByText("refactor-db")).toBeNull());
  });
});
