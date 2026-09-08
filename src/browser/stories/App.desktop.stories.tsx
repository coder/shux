import { expect, fn, userEvent, waitFor, within } from "@storybook/test";
import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  getRightSidebarLayoutKey,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
} from "@/common/constants/storage";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandProjects, expandRightSidebar } from "./helpers/uiState";
import { createWorkspace } from "./mocks/workspaces";
import { watchDesktopViewerFixture } from "@/browser/features/desktop/desktopRfb.test-fixture";
import DesktopRfb from "./mocks/desktopRfb";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers";

const CALLER_ID = "desktop-shared-agent";
const OWNER_ID = "desktop-owner";
const OWNER_NAME = "release-validation-with-an-intentionally-long-workspace-name";
const isolatedWorkspace = createWorkspace({
  id: "desktop-isolated-agent",
  name: "isolated-agent",
  projectName: "desktop-demo",
});
const capability = { available: true as const, width: 1280, height: 720, sessionId: "session" };

const getBootstrap = fn<APIClient["desktop"]["getBootstrap"]>(({ workspaceId }) =>
  Promise.resolve({
    capability: {
      ...capability,
      ...(workspaceId === CALLER_ID
        ? { sharedDesktop: { ownerWorkspaceId: OWNER_ID, ownerName: OWNER_NAME } }
        : {}),
    },
    bridgePath: `/desktop/ws/${workspaceId}`,
    token: `token-for-${workspaceId}`,
  })
);

function setupDesktopStory(phone = false): APIClient {
  getBootstrap.mockClear();
  DesktopRfb.instances = [];
  const client = setupSimpleChatStory({
    workspaceId: CALLER_ID,
    workspaceName: "shared-agent",
    projectName: "desktop-demo",
    messages: [],
    additionalWorkspaces: [isolatedWorkspace],
  });
  // Only bootstrap carries the binding; a capability probe must not determine the viewer's label.
  client.desktop = {
    watchViewer: watchDesktopViewerFixture,
    acknowledgeViewerRelease: () => Promise.resolve(),
    detachViewer: () => Promise.resolve(),
    openWindow: ({ instanceId }) => Promise.resolve({ instanceId }),
    closeWindow: () => Promise.resolve(),
    getWindow: () => Promise.resolve(null),
    getPrereqStatus: () => Promise.resolve({ available: true }),
    getCapability: () => Promise.resolve(capability),
    getBootstrap,
  };
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP), true);
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, phone);
  updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "desktop");
  updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, 320);
  for (const workspaceId of [CALLER_ID, isolatedWorkspace.id]) {
    updatePersistedState(getRightSidebarLayoutKey(workspaceId), undefined);
  }
  expandProjects([isolatedWorkspace.projectPath]);
  expandRightSidebar();
  return client;
}

async function expectCallerConnection(
  canvasElement: HTMLElement,
  workspaceId: string,
  visible = true
) {
  const canvas = within(canvasElement);
  await waitFor(async () => {
    const preview = canvas.getByLabelText("Desktop session preview");
    if (visible) await expect(preview).toBeVisible();
    else await expect(preview).not.toBeVisible();
    await expect(getBootstrap).toHaveBeenLastCalledWith({ workspaceId });
    const viewer = DesktopRfb.instances.at(-1);
    if (!viewer) throw new Error("Desktop viewer did not connect");
    const url = new URL(viewer.url);
    await expect(url.pathname).toBe(`/desktop/ws/${workspaceId}`);
    await expect(url.searchParams.get("token")).toBe(`token-for-${workspaceId}`);
    await expect(viewer.viewOnly).toBe(true);
  });
  await expect(getBootstrap).not.toHaveBeenCalledWith({ workspaceId: OWNER_ID });
}

export default {
  ...appMeta,
  title: "App/Desktop",
  beforeEach: () => () => {
    for (const viewer of DesktopRfb.instances) viewer.disconnect();
    DesktopRfb.instances = [];
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP), undefined);
  },
};

export const SharedBinding: AppStory = {
  globals: { viewport: { value: "desktopBindingWide", isRotated: false } },
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        desktopBindingWide: {
          name: "Desktop (1900px)",
          styles: { width: "1900px", height: "1000px" },
          type: "desktop",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } },
  },
  render: () => <AppWithMocks setup={() => setupDesktopStory()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectCallerConnection(canvasElement, CALLER_ID);
    await expect(canvas.getByText(`Shared desktop · ${OWNER_NAME}`)).toBeVisible();
    const sharedViewer = DesktopRfb.instances.at(-1)!;

    await userEvent.click(canvas.getByText(isolatedWorkspace.name, { exact: true }));
    await expectCallerConnection(canvasElement, isolatedWorkspace.id);
    await expect(canvas.queryByText(`Shared desktop · ${OWNER_NAME}`)).not.toBeInTheDocument();
    await expect(sharedViewer.disconnected).toBe(true);

    await userEvent.click(canvas.getByText("shared-agent", { exact: true }));
    await expectCallerConnection(canvasElement, CALLER_ID);
    const label = canvas.getByText(`Shared desktop · ${OWNER_NAME}`);
    await expect(label).toBeVisible();
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    await expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(320);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

export const SharedBindingPhone: AppStory = {
  globals: { viewport: { value: "desktopBindingPhone", isRotated: false } },
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        desktopBindingPhone: {
          name: "Phone (390px)",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  // The test-runner ignores viewport globals; the wrapper exercises the same narrow container.
  render: () => (
    <div data-testid="desktop-phone-frame" style={{ width: 390, height: 844, overflow: "hidden" }}>
      <AppWithMocks setup={() => setupDesktopStory(true)} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // The app intentionally hides Workspace insights below its minimum usable width, even
    // for fine pointers. Keep that mobile behavior rather than forcing a visible test-only panel.
    await expectCallerConnection(canvasElement, CALLER_ID, false);
    await waitFor(async () => {
      await expect(
        within(canvasElement).getByText(`Shared desktop · ${OWNER_NAME}`)
      ).not.toBeVisible();
      const sidebar = canvasElement.querySelector('[aria-label="Workspace insights"]');
      if (!sidebar) throw new Error("Missing workspace insights sidebar");
      await expect(getComputedStyle(sidebar).display).toBe("none");
    });
    const frame = within(canvasElement).getByTestId("desktop-phone-frame");
    await expect(frame.getBoundingClientRect().width).toBe(390);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(390);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};
