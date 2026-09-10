import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { ConcurrentLocalWarning } from "./ConcurrentLocalWarning";

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

function WarningProbe(props: { workspaceId?: string }) {
  return <ConcurrentLocalWarning workspaceId={props.workspaceId ?? currentWorkspaceMetadata.id} />;
}

describe("ConcurrentLocalWarning", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    workspaceMetadata.clear();
    workspaceMetadata.set(currentWorkspaceMetadata.id, currentWorkspaceMetadata);
    workspaceMetadata.set(otherWorkspaceMetadata.id, otherWorkspaceMetadata);
    spyOn(WorkspaceContextModule, "useWorkspaceMetadata").mockImplementation(() => ({
      workspaceMetadata: new Map(workspaceMetadata),
      loading: false,
      loaded: true,
      loadError: null,
    }));
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("warns from metadata on first paint without depending on activity hydration or timers", () => {
    // Activity is intentionally unavailable: reconnects and per-request gaps cannot hide
    // a metadata-only warning. A dependency on that store would break this contract.
    const activityHook = spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockImplementation(
      () => {
        throw new Error("Activity has not hydrated");
      }
    );
    const timer = spyOn(window, "setTimeout");
    const result = render(<WarningProbe />);
    expect(result.getByRole("status")).toBeTruthy();
    expect(activityHook).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });

  test.each([undefined, "root"])(
    "excludes same-family sharing with archived ancestry (root=%s)",
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
      const result = render(<WarningProbe />);
      expect(result.queryByRole("status")).toBeNull();
    }
  );

  test("still warns for an unrelated task family's local sub-agent", () => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, {
      ...otherWorkspaceMetadata,
      parentWorkspaceId: "unrelated-root",
      rootWorkspaceId: "unrelated-root",
    });
    const result = render(<WarningProbe />);
    expect(result.getByRole("status")).toBeTruthy();
  });

  const nonSharingOverrides: Array<Partial<FrontendWorkspaceMetadata>> = [
    { projectPath: "/other-repo" },
    { runtimeConfig: { type: "worktree", srcBaseDir: "/worktrees" } },
    { runtimeConfig: { type: "local", srcBaseDir: "/legacy-worktrees" } },
    { runtimeConfig: { type: "ssh", host: "remote", srcBaseDir: "/worktrees" } },
    { transcriptOnly: true },
    { kind: "scratch" },
  ];

  test.each(nonSharingOverrides)("excludes a non-sharing peer: %j", (override) => {
    workspaceMetadata.set(otherWorkspaceMetadata.id, { ...otherWorkspaceMetadata, ...override });
    const result = render(<WarningProbe />);
    expect(result.queryByRole("status")).toBeNull();
  });

  test.each(nonSharingOverrides)(
    "clears immediately when the current workspace stops sharing: %j",
    (override) => {
      const result = render(<WarningProbe />);
      expect(result.getByRole("status")).toBeTruthy();
      workspaceMetadata.set(currentWorkspaceMetadata.id, {
        ...currentWorkspaceMetadata,
        ...override,
      });
      result.rerender(<WarningProbe />);
      expect(result.queryByRole("status")).toBeNull();
    }
  );

  test("does not leak a warning across workspace switches or missing metadata", () => {
    workspaceMetadata.set("child", {
      ...otherWorkspaceMetadata,
      id: "child",
      parentWorkspaceId: otherWorkspaceMetadata.id,
      rootWorkspaceId: otherWorkspaceMetadata.id,
    });
    const result = render(<WarningProbe />);
    expect(result.getByRole("status")).toBeTruthy();

    // Only the other family now owns a local checkout; its child must not inherit our warning.
    workspaceMetadata.set(currentWorkspaceMetadata.id, {
      ...currentWorkspaceMetadata,
      runtimeConfig: { type: "worktree", srcBaseDir: "/worktrees" },
    });
    result.rerender(<WarningProbe workspaceId="child" />);
    expect(result.queryByRole("status")).toBeNull();
    result.rerender(<WarningProbe workspaceId="not-loaded" />);
    expect(result.queryByRole("status")).toBeNull();
  });

  test("keeps the same node and text through task lifecycle, peer additions, and metadata reordering", () => {
    const result = render(<WarningProbe />);
    const status = result.getByRole("status");
    const text = status.textContent;
    const second = { ...otherWorkspaceMetadata, id: "second", name: "second agent" };
    workspaceMetadata.set(second.id, second);

    const taskStatuses: Array<FrontendWorkspaceMetadata["taskStatus"]> = [
      "queued",
      "starting",
      "running",
      "awaiting_report",
      "reported",
      "running",
      "interrupted",
    ];
    for (const taskStatus of taskStatuses) {
      workspaceMetadata.delete(otherWorkspaceMetadata.id);
      workspaceMetadata.set(otherWorkspaceMetadata.id, {
        ...otherWorkspaceMetadata,
        name: "renamed agent",
        taskStatus,
      });
      result.rerender(<WarningProbe />);
      expect(result.getByRole("status")).toBe(status);
      expect(status.textContent).toBe(text);
    }

    workspaceMetadata.delete(otherWorkspaceMetadata.id);
    result.rerender(<WarningProbe />);
    expect(result.getByRole("status")).toBe(status);
    expect(status.textContent).toBe(text);

    // Archive/delete removes metadata. Hide only when the last unrelated checkout user leaves.
    workspaceMetadata.delete(second.id);
    result.rerender(<WarningProbe />);
    expect(result.queryByRole("status")).toBeNull();
  });

  test("does not warn when only the current workspace exists", () => {
    workspaceMetadata.delete(otherWorkspaceMetadata.id);
    const result = render(<WarningProbe />);
    expect(result.queryByRole("status")).toBeNull();
  });
});
