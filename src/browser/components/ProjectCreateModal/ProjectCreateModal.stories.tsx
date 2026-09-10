/**
 * New Project modal stories
 *
 * Captures both tabs of the "Add Project" modal:
 * - "Local folder" (default) — path input + Browse button
 * - "Clone repo" — repo URL + clone location inputs
 */

import type { APIClient } from "@/browser/contexts/API";
import {
  expandLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { within, userEvent, waitFor } from "@storybook/test";

const meta = {
  ...appMeta,
  title: "Components/ProjectCreateModal",
};

export default meta;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function setupProjectCreateStory(): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];
  selectWorkspace(workspaces[0]);
  expandProjects(["/mock/my-app"]);
  // The sidebar defaults to collapsed at phone widths; the play functions need
  // its "Add project" button visible to open the modal.
  expandLeftSidebar();
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
  });
}

/** Click "New Project" in the sidebar to open the Add Project modal. */
async function openNewProjectModal(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  // Wait for the sidebar's "Add project" button to appear
  const addButton = await canvas.findByLabelText("Add project", {}, { timeout: 10000 });
  await userEvent.click(addButton);

  // Wait for the dialog portal to render
  await body.findByRole("dialog");
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Default "Local folder" tab of the Add Project modal. */
export const LocalFolder: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  // Integration: stories navigate via sidebar → "Add project" button to open the modal portal.
  render: () => <AppWithMocks setup={setupProjectCreateStory} />,
  play: async ({ canvasElement }) => {
    await openNewProjectModal(canvasElement);
  },
};

/**
 * Three labeled modes must fit narrow dialogs without overflowing the right edge;
 * the pinned phone viewport guards the wrap layout (dialogs portal to body, so a
 * fixed-width decorator cannot constrain them).
 */
export const PhoneViewport: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () => <AppWithMocks setup={setupProjectCreateStory} />,
  play: async ({ canvasElement }) => {
    await openNewProjectModal(canvasElement);
  },
};

/** "Clone repo" tab of the Add Project modal. */
export const CloneRepo: AppStory = {
  // Integration: stories navigate via sidebar → "Add project" button to open the modal portal.
  render: () => <AppWithMocks setup={setupProjectCreateStory} />,
  play: async ({ canvasElement }) => {
    await openNewProjectModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // Switch to the "Clone repo" tab
    const cloneTab = await body.findByRole("radio", { name: /Clone repo/i });
    await userEvent.click(cloneTab);

    // Verify the clone form is visible
    await waitFor(() => body.getByText("Repo URL"));
  },
};
