import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { ComponentType } from "react";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { DesktopCapability } from "@/common/types/desktop";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { watchDesktopViewerFixture } from "@/browser/features/desktop/desktopRfb.test-fixture";
import { setupSimpleChatStory } from "./helpers/chatSetup";

const WORKSPACE_ID = "ws-desktop-viewer";
const CAPABILITY = {
  available: true,
  width: 1280,
  height: 720,
  sessionId: "desktop-story",
} satisfies DesktopCapability;

type DesktopStoryState = "connected" | "checking" | "unavailable" | "error";

function setupDesktopStory(state: DesktopStoryState, sidebarWidth = 640) {
  const client = setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "desktop-viewer",
    messages: [],
  });
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP), true);
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, true);
  updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
  updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, sidebarWidth);
  updatePersistedState(getRightSidebarLayoutKey(WORKSPACE_ID), {
    version: 1,
    nextId: 2,
    focusedTabsetId: "desktop-tabset",
    root: { type: "tabset", id: "desktop-tabset", tabs: ["desktop"], activeTab: "desktop" },
  } satisfies RightSidebarLayoutState);
  client.desktop = {
    watchViewer: watchDesktopViewerFixture,
    acknowledgeViewerRelease: () => Promise.resolve(),
    detachViewer: () => Promise.resolve(),
    openWindow: ({ instanceId }) => Promise.resolve({ instanceId }),
    closeWindow: () => Promise.resolve(),
    getWindow: () => Promise.resolve(null),
    getPrereqStatus: () => Promise.resolve({ available: true }),
    getCapability: () => Promise.resolve(CAPABILITY),
    getBootstrap: () => {
      if (state === "checking") return new Promise(() => undefined);
      if (state === "error")
        return Promise.reject(new Error("The desktop bridge could not be reached."));
      if (state === "unavailable") {
        return Promise.resolve({ capability: { available: false, reason: "unsupported_runtime" } });
      }
      return Promise.resolve({
        capability: CAPABILITY,
        bridgePath: "/desktop/ws",
        token: "desktop-story",
      });
    },
  };
  return client;
}

export default {
  ...appMeta,
  title: "App/DesktopViewer",
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } },
    viewport: {
      options: {
        desktop: {
          name: "Desktop",
          styles: { width: "1900px", height: "1000px" },
          type: "desktop",
        },
        phone: { name: "Phone", styles: { width: "390px", height: "844px" }, type: "mobile" },
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

async function expectDisabledControls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const toolbar = await canvas.findByRole("toolbar", { name: "Desktop controls" });
  await expect(within(toolbar).getByRole("button", { name: "Take control" })).toBeDisabled();
  await expect(within(toolbar).getByRole("button", { name: "Zoom to 100%" })).toBeDisabled();
}

async function waitForDesktopScreen(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const control = await canvas.findByRole("button", { name: "Take control" });
  await waitFor(() => expect(control).toBeEnabled());
  const screen = canvasElement.querySelector<HTMLCanvasElement>("[data-desktop-viewport] canvas");
  if (!screen) throw new Error("Connected desktop did not mount its screen");
  const context = screen.getContext("2d");
  if (!context) throw new Error("Desktop fixture has no canvas context");
  // The transport is a deterministic Storybook fixture, not a live user's desktop.
  const colors = getComputedStyle(screen);
  context.fillStyle = colors.getPropertyValue("--color-sidebar");
  context.fillRect(0, 0, screen.width, screen.height);
  context.fillStyle = colors.getPropertyValue("--color-foreground");
  context.font = "28px sans-serif";
  context.fillText("Desktop preview", 48, 72);
  context.font = "18px sans-serif";
  context.fillText("Deterministic screen fixture — no remote session", 48, 112);
  return { canvas, control, screen };
}

export const ViewOnly: AppStory = {
  render: () => <AppWithMocks setup={() => setupDesktopStory("connected")} />,
  play: async ({ canvasElement }) => {
    const { canvas, control, screen } = await waitForDesktopScreen(canvasElement);
    // The sidebar's capture-phase close-tab shortcut must leave guest Ctrl+W untouched.
    const closeTab = new KeyboardEvent("keydown", {
      key: "w",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.dispatchEvent(closeTab);
    await expect(closeTab.defaultPrevented).toBe(false);
    await expect(control).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.getByRole("button", { name: "Zoom to 100%" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  },
};

export const Controlling: AppStory = {
  ...ViewOnly,
  play: async ({ canvasElement }) => {
    const { canvas, control, screen } = await waitForDesktopScreen(canvasElement);
    await userEvent.click(control);
    await userEvent.click(screen);
    await expect(canvas.getByRole("button", { name: "Release control" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  },
};

export const NativeZoom: AppStory = {
  ...ViewOnly,
  play: async ({ canvasElement }) => {
    const { canvas } = await waitForDesktopScreen(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Zoom to 100%" }));
    await expect(canvas.getByRole("button", { name: "Zoom to fit" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(canvas.getByRole("button", { name: "Take control" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  },
};

export const Checking: AppStory = {
  render: () => <AppWithMocks setup={() => setupDesktopStory("checking")} />,
  play: async ({ canvasElement }) => {
    await expectDisabledControls(canvasElement);
    await within(canvasElement).findByText("Checking desktop availability");
  },
};

export const Unavailable: AppStory = {
  render: () => <AppWithMocks setup={() => setupDesktopStory("unavailable")} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Desktop unavailable");
    await expectDisabledControls(canvasElement);
  },
};

export const ConnectionError: AppStory = {
  render: () => <AppWithMocks setup={() => setupDesktopStory("error")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Desktop connection failed");
    await expectDisabledControls(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await canvas.findByText("Desktop connection failed");
  },
};

export const NarrowSidebar: AppStory = {
  render: () => <AppWithMocks setup={() => setupDesktopStory("connected", 300)} />,
  decorators: [
    (Story) => (
      <div style={{ width: 1000, height: 800 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await waitForDesktopScreen(canvasElement);
    const toolbar = within(canvasElement).getByRole("toolbar", { name: "Desktop controls" });
    await waitFor(async () => {
      await expect(toolbar.getBoundingClientRect().width).toBeGreaterThan(0);
      await expect(toolbar.getBoundingClientRect().width).toBeLessThanOrEqual(390);
      await expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    });
  },
};

function PhoneDecorator(Story: ComponentType) {
  // The Storybook test-runner ignores globals.viewport, so constrain this play as well as Pixel.
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const PhoneUnavailable: AppStory = {
  ...Unavailable,
  decorators: [PhoneDecorator],
  globals: { viewport: { value: "phone", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("textbox", { name: "Message Claude" });
    // The full app intentionally hides workspace insights at phone widths.
    await waitFor(() => expect(canvas.queryByRole("complementary")).not.toBeInTheDocument());
    await expect(
      canvas.queryByRole("toolbar", { name: "Desktop controls" })
    ).not.toBeInTheDocument();
  },
};
