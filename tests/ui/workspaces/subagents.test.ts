/**
 * UI integration tests for sub-agent completed-child expansion behavior.
 *
 * Validates that:
 * - Completed child sub-agents (taskStatus=reported) are hidden by default.
 * - Double-clicking any workspace row enters rename mode.
 * - The overflow menu exposes Show/Hide sub-agent actions.
 * - Keyboard users can still expand/collapse completed children from the row.
 * - Expanded chevron indicators render only when the status dot is hidden.
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

import {
  cleanupTestEnvironment,
  createTestEnvironment,
  preloadTestModules,
  type TestEnvironment,
} from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";

import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

function getWorkspaceRow(container: HTMLElement, workspaceId: string): HTMLElement | null {
  return container.querySelector(
    `[data-workspace-id="${workspaceId}"][role="button"]`
  ) as HTMLElement | null;
}

function getSubagentConnector(container: HTMLElement, workspaceId: string): HTMLElement | null {
  // Find all connector elements and match by shared parent with the target workspace row.
  // This avoids fragile sibling/parent traversal assumptions.
  const connectors = container.querySelectorAll('[data-testid="subagent-connector"]');
  for (const connector of connectors) {
    const wrapper = connector.parentElement;
    if (!wrapper) continue;
    if (wrapper.querySelector(`[data-workspace-id="${workspaceId}"]`)) {
      return connector as HTMLElement;
    }
  }
  return null;
}

async function findWorkspaceActionsButton(params: {
  container: HTMLElement;
  title: string;
}): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const button = params.container.querySelector(
        `button[aria-label="Workspace actions for ${params.title}"]`
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error(`Workspace actions button not found for ${params.title}`);
      }
      return button;
    },
    { timeout: 10_000 }
  );
}

async function findMenuItem(label: string): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
      const menuItem = buttons.find((button) => button.textContent?.includes(label));
      if (!menuItem) {
        throw new Error(`Menu item not found: ${label}`);
      }
      return menuItem;
    },
    { timeout: 10_000 }
  );
}

function getAncestorTrunkSegments(container: HTMLElement, workspaceId: string): HTMLElement[] {
  const connector = getSubagentConnector(container, workspaceId);
  if (!connector) {
    return [];
  }

  const wrapper = connector.parentElement;
  if (!wrapper) {
    return [];
  }

  return Array.from(wrapper.querySelectorAll('[data-testid="ancestor-trunk"]')) as HTMLElement[];
}

interface SubagentSidebarHarness {
  env: TestEnvironment;
  repoPath: string;
  trunkBranch: string;
  createWorkspace(title: string, branchPrefix: string): Promise<FrontendWorkspaceMetadata>;
  render(metadata: FrontendWorkspaceMetadata, beforeRender?: () => void): Promise<RenderedApp>;
  cleanup(): Promise<void>;
}

async function createSubagentSidebarHarness(): Promise<SubagentSidebarHarness> {
  const env = await createTestEnvironment();
  const repoPath = await createTempGitRepo();
  const workspaceIdsToRemove: string[] = [];
  let view: RenderedApp | undefined;
  let cleanupDom: (() => void) | undefined;

  try {
    await trustProject(env, repoPath);
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    return {
      env,
      repoPath,
      trunkBranch,
      async createWorkspace(title, branchPrefix) {
        const result = await env.orpc.workspace.create({
          projectPath: repoPath,
          branchName: generateBranchName(branchPrefix),
          trunkBranch,
          title,
        });

        if (!result.success) {
          throw new Error(`Failed to create workspace (${title}): ${result.error}`);
        }

        workspaceIdsToRemove.push(result.metadata.id);
        return result.metadata;
      },
      async render(metadata, beforeRender) {
        cleanupDom = installDom();
        beforeRender?.();
        view = renderApp({ apiClient: env.orpc, metadata });
        await setupWorkspaceView(view, metadata, metadata.id);
        return view;
      },
      async cleanup() {
        if (view && cleanupDom) {
          await cleanupView(view, cleanupDom);
        } else if (cleanupDom) {
          cleanupDom();
        }

        for (const workspaceId of workspaceIdsToRemove.reverse()) {
          try {
            await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
          } catch {
            // Best effort cleanup.
          }
        }

        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      },
    };
  } catch (error) {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(repoPath);
    throw error;
  }
}

describe("Workspace sidebar completed sub-agent expansion (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("double-click renames parent rows while inactive sub-agents stay out of the sidebar", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const parentWorkspace = await harness.createWorkspace("Parent Agent", "subagent-parent");
      const activeChild = await harness.createWorkspace("Active Child", "subagent-active");
      const interruptedChild = await harness.createWorkspace(
        "Interrupted Child",
        "subagent-interrupted"
      );
      const reportedChild = await harness.createWorkspace("Reported Child", "subagent-reported");

      await env.config.addWorkspace(repoPath, {
        ...activeChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
      });
      await env.config.addWorkspace(repoPath, {
        ...interruptedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "interrupted",
      });
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt: new Date().toISOString(),
      });

      const renderedView = await harness.render(parentWorkspace);
      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeChild.id)) {
            throw new Error("Expected active child to be visible");
          }
        },
        { timeout: 10_000 }
      );
      expect(getWorkspaceRow(renderedView.container, interruptedChild.id)).toBeNull();
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();

      const parentDisplayTitle = parentWorkspace.title ?? parentWorkspace.name;
      const parentRow = await waitFor(
        () => {
          const row = getWorkspaceRow(renderedView.container, parentWorkspace.id);
          if (!row) throw new Error("Parent workspace row not found");
          return row;
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBeNull();
      expect(parentRow.getAttribute("aria-keyshortcuts")).toBeNull();

      fireEvent.doubleClick(parentRow);
      await waitFor(
        () => {
          const editInput = renderedView.container.querySelector(
            `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
          );
          if (!editInput) throw new Error("Expected rename input after double-clicking parent row");
        },
        { timeout: 10_000 }
      );
      const renameInput = renderedView.container.querySelector(
        `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
      ) as HTMLInputElement;
      fireEvent.keyDown(renameInput, { key: "Escape" });

      const parentActionsButton = await findWorkspaceActionsButton({
        container: renderedView.container,
        title: parentDisplayTitle,
      });
      fireEvent.click(parentActionsButton);
      await findMenuItem("Generate new title");
      const menuLabels = Array.from(document.querySelectorAll("button")).map(
        (button) => button.textContent ?? ""
      );
      expect(menuLabels.some((label) => label.includes("Show sub-agents"))).toBe(false);
      expect(menuLabels.some((label) => label.includes("Hide sub-agents"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("double-clicking a workspace without completed children still enters rename mode", async () => {
    const harness = await createSubagentSidebarHarness();

    try {
      const workspace = await harness.createWorkspace(
        "Standalone Agent",
        "subagent-rename-fallback"
      );

      const renderedView = await harness.render(workspace);
      const displayTitle = workspace.title ?? workspace.name;
      const row = await waitFor(
        () => {
          const nextRow = getWorkspaceRow(renderedView.container, workspace.id);
          if (!nextRow) {
            throw new Error("Workspace row not found");
          }
          return nextRow;
        },
        { timeout: 10_000 }
      );
      expect(row.getAttribute("aria-expanded")).toBeNull();

      fireEvent.doubleClick(row);

      await waitFor(
        () => {
          const editInput = renderedView.container.querySelector(
            `input[aria-label="Edit title for workspace ${displayTitle}"]`
          );
          if (!editInput) {
            throw new Error("Expected rename input to appear after double-clicking a leaf row");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("unread parent rows do not expose expansion for inactive children", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const selectedWorkspace = await harness.createWorkspace(
        "Selected Agent",
        "subagent-selected-anchor"
      );
      const parentWorkspace = await harness.createWorkspace(
        "Unread Parent Agent",
        "subagent-unread-parent"
      );
      const reportedChild = await harness.createWorkspace(
        "Completed Child",
        "subagent-unread-reported"
      );
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt: new Date().toISOString(),
      });

      const historyService = new HistoryService(env.config);
      const appendResult = await historyService.appendToHistory(
        parentWorkspace.id,
        createMuxMessage("parent-unread-message", "user", "Mark this workspace unread")
      );
      if (!appendResult.success)
        throw new Error(`Failed to seed unread history: ${appendResult.error}`);

      const renderedView = await harness.render(selectedWorkspace, () => {
        updatePersistedState(getWorkspaceLastReadKey(parentWorkspace.id), 0);
      });
      const parentRow = await waitFor(
        () => {
          const row = getWorkspaceRow(renderedView.container, parentWorkspace.id);
          if (!row) throw new Error("Parent workspace row not found");
          return row;
        },
        { timeout: 10_000 }
      );

      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();
      expect(parentRow.getAttribute("aria-expanded")).toBeNull();
      expect(
        parentRow.querySelector(
          `[data-testid="completed-children-expanded-indicator-${parentWorkspace.id}"]`
        )
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("old reported children stay hidden without creating an age tier", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const parentWorkspace = await harness.createWorkspace("Parent Agent", "subagent-old-parent");
      const activeChild = await harness.createWorkspace("Active Child", "subagent-old-active");
      const reportedChild = await harness.createWorkspace(
        "Old Reported Child",
        "subagent-old-reported"
      );
      const reportedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

      await env.config.addWorkspace(repoPath, {
        ...activeChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
      });
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        createdAt: reportedAt,
        reportedAt,
      });

      const renderedView = await harness.render(parentWorkspace);
      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeChild.id)) {
            throw new Error("Expected active child to be visible");
          }
        },
        { timeout: 10_000 }
      );
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();
      expect(
        renderedView.container.querySelector('button[aria-label^="Expand workspaces older than "]')
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("renders active connector classes for running sub-agents", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const parentWorkspace = await harness.createWorkspace(
        "Connector Parent",
        "subagent-connector-parent"
      );

      const runningChild = await harness.createWorkspace(
        "Running Child",
        "subagent-connector-running"
      );

      await env.config.addWorkspace(repoPath, {
        ...runningChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
      });

      const renderedView = await harness.render(parentWorkspace);

      await waitFor(
        () => {
          const childRow = getWorkspaceRow(renderedView.container, runningChild.id);
          if (!childRow) {
            throw new Error("Expected running child row to be visible");
          }

          const connector = getSubagentConnector(renderedView.container, runningChild.id);
          if (!connector) {
            throw new Error("Expected running child connector to be rendered");
          }

          const activeSegments = connector.querySelectorAll("span.subagent-connector-active");
          if (activeSegments.length === 0) {
            throw new Error("Expected active connector segments for running child");
          }

          const animatedElbow = connector.querySelector("path.subagent-connector-elbow-active");
          if (!animatedElbow) {
            throw new Error("Expected animated connector elbow for running child");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("renders ancestor trunk continuity for nested rows across active and inactive branches", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const activeParent = await harness.createWorkspace(
        "Active Nested Parent",
        "subagent-ancestor-active-parent"
      );

      const activeLowerSibling = await harness.createWorkspace(
        "Active Lower Sibling",
        "subagent-ancestor-active-sibling"
      );

      const activeNestedChild = await harness.createWorkspace(
        "Active Nested Child",
        "subagent-ancestor-active-child"
      );

      const activeGrandchild = await harness.createWorkspace(
        "Active Nested Grandchild",
        "subagent-ancestor-active-grandchild"
      );

      const inactiveParent = await harness.createWorkspace(
        "Inactive Nested Parent",
        "subagent-ancestor-inactive-parent"
      );

      const inactiveLowerSibling = await harness.createWorkspace(
        "Inactive Lower Sibling",
        "subagent-ancestor-inactive-sibling"
      );

      const inactiveNestedChild = await harness.createWorkspace(
        "Inactive Nested Child",
        "subagent-ancestor-inactive-child"
      );

      const inactiveGrandchild = await harness.createWorkspace(
        "Inactive Nested Grandchild",
        "subagent-ancestor-inactive-grandchild"
      );

      await env.config.addWorkspace(repoPath, {
        ...activeNestedChild,
        parentWorkspaceId: activeParent.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...activeGrandchild,
        parentWorkspaceId: activeNestedChild.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...activeLowerSibling,
        parentWorkspaceId: activeParent.id,
        taskStatus: "running",
      });

      await env.config.addWorkspace(repoPath, {
        ...inactiveNestedChild,
        parentWorkspaceId: inactiveParent.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...inactiveGrandchild,
        parentWorkspaceId: inactiveNestedChild.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...inactiveLowerSibling,
        parentWorkspaceId: inactiveParent.id,
        taskStatus: "queued",
      });

      const renderedView = await harness.render(activeParent);

      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeGrandchild.id)) {
            throw new Error("Expected active nested grandchild row to be visible");
          }
          if (!getWorkspaceRow(renderedView.container, inactiveGrandchild.id)) {
            throw new Error("Expected inactive nested grandchild row to be visible");
          }
        },
        { timeout: 10_000 }
      );

      const activeAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        activeGrandchild.id
      );
      expect(activeAncestorTrunks.length).toBeGreaterThan(0);
      expect(activeAncestorTrunks[0]?.getAttribute("data-trunk-active")).toBe("true");

      const inactiveAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        inactiveGrandchild.id
      );
      expect(inactiveAncestorTrunks.length).toBeGreaterThan(0);
      expect(inactiveAncestorTrunks[0]?.getAttribute("data-trunk-active")).toBe("false");

      const peerAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        activeLowerSibling.id
      );
      expect(peerAncestorTrunks).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  }, 90_000);

  test("does not render active connector classes for non-running sub-agents", async () => {
    const harness = await createSubagentSidebarHarness();
    const { env, repoPath } = harness;

    try {
      const parentWorkspace = await harness.createWorkspace(
        "Connector Parent",
        "subagent-connector-parent-queued"
      );

      const queuedChild = await harness.createWorkspace(
        "Queued Child",
        "subagent-connector-queued"
      );

      await env.config.addWorkspace(repoPath, {
        ...queuedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "queued",
      });

      const renderedView = await harness.render(parentWorkspace);

      // Wait for the queued child row to appear in the sidebar.
      await waitFor(
        () => {
          const childRow = getWorkspaceRow(renderedView.container, queuedChild.id);
          if (!childRow) {
            throw new Error("Expected queued child row to be visible");
          }
        },
        { timeout: 10_000 }
      );

      // A queued sub-agent should NOT have active connector segments
      // (only "running" status triggers the active animation).
      const activeSegments = renderedView.container.querySelectorAll(
        "span.subagent-connector-active"
      );
      expect(activeSegments.length).toBe(0);

      const animatedElbows = renderedView.container.querySelectorAll(
        "path.subagent-connector-elbow-active"
      );
      expect(animatedElbows.length).toBe(0);
    } finally {
      await harness.cleanup();
    }
  }, 90_000);
});
