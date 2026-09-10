import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { WorkspaceSidebarState, WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WORKSPACE_STREAMING_STATUS_TRANSITION_MS } from "@/constants/streaming";
import {
  ConcurrentLocalWarningDecoration,
  useConcurrentLocalAgentCount,
} from "./ConcurrentLocalWarning";

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

function WarningCountProbe(props: { workspaceId?: string }) {
  const agentCount = useConcurrentLocalAgentCount({
    workspaceId: props.workspaceId ?? currentWorkspaceMetadata.id,
    projectPath: "/repo",
    runtimeConfig: { type: "local" },
  });

  return agentCount === 0 ? null : (
    <div data-count={agentCount}>
      <ConcurrentLocalWarningDecoration agentCount={agentCount} />
    </div>
  );
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

  test.each([undefined, "root"])(
    "does not flash for a same-family stream with archived ancestry (root=%s)",
    (rootWorkspaceId) => {
      workspaceMetadata.set(currentWorkspaceMetadata.id, {
        ...currentWorkspaceMetadata,
        rootWorkspaceId,
      });
      workspaceMetadata.set(otherWorkspaceMetadata.id, {
        ...otherWorkspaceMetadata,
        parentWorkspaceId: "archived-parent",
        rootWorkspaceId: rootWorkspaceId ?? currentWorkspaceMetadata.id,
      });
      const result = render(<WarningCountProbe />);
      expect(result.queryByRole("status")).toBeNull();
      act(() => {
        streamingWorkspaceIds.clear();
        notifyWorkspaceStateChanged();
      });
      act(() => {
        streamingWorkspaceIds.add(otherWorkspaceMetadata.id);
        notifyWorkspaceStateChanged();
      });
      expect(result.queryByRole("status")).toBeNull();
    }
  );

  test("still warns for an unrelated task family's active sub-agent", () => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, {
      ...otherWorkspaceMetadata,
      parentWorkspaceId: "unrelated-root",
      rootWorkspaceId: "unrelated-root",
    });
    const result = render(<WarningCountProbe />);
    expect(result.getByRole("status")).toBeTruthy();
  });

  test.each([
    { projectPath: "/other-repo" },
    { runtimeConfig: { type: "worktree" as const, srcBaseDir: "/worktrees" } },
    { runtimeConfig: { type: "local" as const, srcBaseDir: "/legacy-worktrees" } },
  ])("does not warn about an isolated or different project: %j", (override) => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, { ...otherWorkspaceMetadata, ...override });
    const result = render(<WarningCountProbe />);
    expect(result.queryByRole("status")).toBeNull();
  });

  test("does not carry a warning into the active agent's own sub-agent", () => {
    workspaceMetadata.set("child", {
      ...currentWorkspaceMetadata,
      id: "child",
      parentWorkspaceId: otherWorkspaceMetadata.id,
      rootWorkspaceId: otherWorkspaceMetadata.id,
    });
    const result = render(<WarningCountProbe />);
    expect(result.getByRole("status")).toBeTruthy();

    result.rerender(<WarningCountProbe workspaceId="child" />);
    expect(result.queryByRole("status")).toBeNull();
  });

  test("counts multiple agents without cycling identities on handoff or metadata reordering", () => {
    const second = { ...otherWorkspaceMetadata, id: "second", name: "second agent" };
    const third = { ...otherWorkspaceMetadata, id: "third", name: "third agent" };
    workspaceMetadata.set(second.id, second);
    workspaceMetadata.set(third.id, third);
    streamingWorkspaceIds.add(second.id);
    const result = render(<WarningCountProbe />);
    const status = result.getByRole("status");
    const text = status.textContent;
    expect(result.container.firstElementChild?.getAttribute("data-count")).toBe("2");
    expect(text).not.toContain(otherWorkspaceMetadata.name);
    expect(text).not.toContain(second.name);

    act(() => {
      streamingWorkspaceIds.delete(otherWorkspaceMetadata.id);
      streamingWorkspaceIds.add(third.id);
      notifyWorkspaceStateChanged();
    });
    // Same cardinality, different active identities: no visible text or node replacement.
    expect(result.getByRole("status")).toBe(status);
    expect(status.textContent).toBe(text);

    act(() => {
      streamingWorkspaceIds.clear();
      notifyWorkspaceStateChanged();
    });
    workspaceMetadata.delete(second.id);
    workspaceMetadata.set(second.id, { ...second, name: "renamed agent" });
    result.rerender(<WarningCountProbe />);
    expect(status.textContent).toBe(text);
    expect(result.container.firstElementChild?.getAttribute("data-count")).toBe("2");

    act(() => {
      streamingWorkspaceIds.add(otherWorkspaceMetadata.id);
      notifyWorkspaceStateChanged();
    });
    expect(result.getByRole("status")).toBe(status);
    expect(result.container.firstElementChild?.getAttribute("data-count")).toBe("1");
    expect(status.textContent).not.toBe(text);
  });

  test("clears held activity immediately when the former conflict leaves eligibility", () => {
    workspaceMetadata.set("idle", { ...otherWorkspaceMetadata, id: "idle" });
    const result = render(<WarningCountProbe />);
    expect(result.getByRole("status")).toBeTruthy();
    act(() => {
      streamingWorkspaceIds.clear();
      notifyWorkspaceStateChanged();
    });
    workspaceMetadata.delete(otherWorkspaceMetadata.id);
    result.rerender(<WarningCountProbe />);
    // An unrelated idle candidate must not keep stale activity alive.
    expect(result.queryByRole("status")).toBeNull();
  });

  test("holds the warning across a brief activity handoff", async () => {
    const result = render(<WarningCountProbe />);
    expect(result.getByRole("status")).toBeTruthy();

    act(() => {
      streamingWorkspaceIds.clear();
      notifyWorkspaceStateChanged();
    });

    expect(result.getByRole("status")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) =>
        window.setTimeout(resolve, WORKSPACE_STREAMING_STATUS_TRANSITION_MS + 50)
      );
    });
    await waitFor(() => expect(result.queryByRole("status")).toBeNull());
  });
});
