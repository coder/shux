import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  SELECTED_WORKSPACE_KEY,
  EXPANDED_PROJECTS_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  getInputKey,
} from "@/common/constants/storage";

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Set localStorage to select a workspace */
export function selectWorkspace(workspace: FrontendWorkspaceMetadata): void {
  localStorage.setItem(
    SELECTED_WORKSPACE_KEY,
    JSON.stringify({
      workspaceId: workspace.id,
      projectPath: workspace.projectPath,
      projectName: workspace.projectName,
      namedWorkspacePath: workspace.namedWorkspacePath,
    })
  );
}

/** Clear workspace selection from localStorage (for sidebar-focused stories) */
export function clearWorkspaceSelection(): void {
  localStorage.removeItem(SELECTED_WORKSPACE_KEY);
}

/** Set input text for a workspace */
export function setWorkspaceInput(workspaceId: string, text: string): void {
  localStorage.setItem(getInputKey(workspaceId), JSON.stringify(text));
}

/** Expand projects in the sidebar */
export function expandProjects(projectPaths: string[]): void {
  localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(projectPaths));
}

/** Collapse the right sidebar (default for most stories) */
export function collapseRightSidebar(): void {
  localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
}

/** Collapse the left sidebar (project tree) — use for stories that don't test the sidebar. */
export function collapseLeftSidebar(): void {
  localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
}

/** Expand the right sidebar (for stories testing it) */
export function expandRightSidebar(): void {
  localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));
}

/**
 * Expand the left sidebar (project tree). The app defaults it to collapsed at
 * mobile widths, so stories whose play functions click sidebar controls must
 * force it open to pass under Pixel's phone viewport.
 */
export function expandLeftSidebar(): void {
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
}
