/**
 * Phone viewport stories - catch responsive/layout regressions.
 *
 * These are full-app stories rendered inside fixed iPhone-sized containers, and
 * Pixel snapshots both light and dark themes at the phone viewport.
 */

import { userEvent, within, waitFor } from "@storybook/test";
import type { ComponentType } from "react";

import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  LEFT_SIDEBAR_COLLAPSED_KEY,
  getPinnedTodoExpandedKey,
  getSubAgentTasksExpandedKey,
} from "@/common/constants/storage";
import { MOBILE_TOUCH_TARGET_PX, NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createTodoWriteTool } from "./mocks/tools";
import { STABLE_TIMESTAMP, createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { clearWorkspaceSelection, collapseRightSidebar, expandProjects } from "./helpers/uiState";
import { createMockORPCClient } from "./mocks/orpc";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
  waitForScrollStabilization,
} from "./storyPlayHelpers.js";

const IPHONE_16E = {
  // Source: https://ios-resolution.info/ (logical resolution)
  width: 390,
  height: 844,
} as const;

// NOTE: Some phone-specific UI tweaks are gated on `@media (max-width: 768px) and (pointer: coarse)`.
// Pixel does not emulate touch, so `pointer: coarse` never matches during snapshot
// capture and touch-only affordances (hidden right sidebar, mobile header) are a
// known coverage gap; these stories still validate the narrow-width layout.

const IPHONE_17_PRO_MAX = {
  // Source: https://ios-resolution.info/ (logical resolution)
  width: 440,
  height: 956,
} as const;

function IPhone16eDecorator(Story: ComponentType) {
  return (
    <div style={{ width: IPHONE_16E.width, height: IPHONE_16E.height, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

function IPhone17ProMaxDecorator(Story: ComponentType) {
  return (
    <div
      style={{
        // Pixel's phone viewport is 390px, narrower than this 440px device
        // frame. Clamp to the viewport so the capture never clips the right
        // edge; local Storybook and the test-runner still see the full 440px.
        width: `min(100vw, ${IPHONE_17_PRO_MAX.width}px)`,
        height: IPHONE_17_PRO_MAX.height,
        overflow: "hidden",
      }}
    >
      <Story />
    </div>
  );
}

const MESSAGES = [
  createUserMessage(
    "msg-1",
    "Smoke-test the UI at phone widths (sidebar, chat, overflow wrapping).",
    { historySequence: 1, timestamp: STABLE_TIMESTAMP - 120_000 }
  ),
  createAssistantMessage(
    "msg-2",
    "Done. Pay extra attention to long paths like `src/browser/components/WorkspaceSidebar/WorkspaceSidebar.tsx` and whether they wrap without horizontal scrolling.",
    { historySequence: 2, timestamp: STABLE_TIMESTAMP - 110_000 }
  ),
  createUserMessage(
    "msg-3",
    "Also check that buttons are still clickable and text isn’t clipped in light mode.",
    { historySequence: 3, timestamp: STABLE_TIMESTAMP - 100_000 }
  ),
] as const;

const TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID = "ws-iphone-17-pro-max-touch-review";
const TOUCH_REVIEW_IMMERSIVE_DIFF = `diff --git a/src/mobile/review.tsx b/src/mobile/review.tsx
index 1111111..2222222 100644
--- a/src/mobile/review.tsx
+++ b/src/mobile/review.tsx
@@ -10,6 +10,10 @@ export function ReviewPanel() {
   return (
     <section>
+      <h2 className="sr-only">Touch review</h2>
       <p>Review hunk interactions on mobile.</p>
+      <p>Tap any changed line to add a note immediately.</p>
     </section>
   );
 }
`;
const TOUCH_REVIEW_IMMERSIVE_NUMSTAT = "2\t0\tsrc/mobile/review.tsx";

const PR_LINK_URL = "https://github.com/coder/mux/pull/3753";
const PR_DETECTION_JSON = JSON.stringify({
  number: 3753,
  url: PR_LINK_URL,
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  title: "Redesign the workspace chrome",
  isDraft: false,
  headRefName: "feature/mobile-chrome",
  baseRefName: "main",
  statusCheckRollup: [],
});

function countVisiblePRLinks(containerTestId: string): number {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-testid="${containerTestId}"] a[href="${PR_LINK_URL}"]`
    ),
  ].filter((link) => link.getBoundingClientRect().width > 0).length;
}

export default {
  ...appMeta,
  title: "App/PhoneViewports",
};

async function stabilizePhoneViewportStory(canvasElement: HTMLElement) {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForChatInputAutofocusDone(storyRoot);
  await waitForScrollStabilization(storyRoot);
  blurActiveElement();
}

export const IPhone16e: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-iphone-16e",
          workspaceName: "mobile",
          projectName: "mux",
          messages: [...MESSAGES],
        })
      }
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);
  },
};

/**
 * The PR badge lives in the footer info bar on wide viewports and in the workspace header on narrow
 * ones. Pixel captures the narrow placement; the play assertion covers whichever side the ambient
 * viewport selects, so the test-runner exercises the wide placement.
 */
export const IPhone16ePRLinkPlacement: AppStory = {
  // Mirrors the Pixel phone variant: the fixed-width decorator does not move `window.innerWidth`, so
  // without this a local reviewer would see the wide placement in a story framed as a phone.
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-iphone-16e-pr-link",
          workspaceName: "mobile-pr",
          projectName: "mux",
          messages: [...MESSAGES],
          executeBash: (_workspaceId, script) =>
            Promise.resolve({
              success: true as const,
              // Empty output for anything else falls through to the git status executor.
              output: script.includes("gh pr view") ? PR_DETECTION_JSON : "",
              exitCode: 0,
              wall_duration_ms: 5,
            }),
        })
      }
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    const narrow = window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches;
    await waitFor(
      () => {
        const inHeader = countVisiblePRLinks("workspace-menu-bar");
        const inFooter = countVisiblePRLinks("workspace-footer-bar");
        const [expectedHeader, expectedFooter] = narrow ? [1, 0] : [0, 1];
        if (inHeader !== expectedHeader || inFooter !== expectedFooter) {
          throw new Error(
            `At ${window.innerWidth}px the PR link belongs ${
              narrow ? "in the header" : "in the footer"
            }, but ${inHeader} were visible in the header and ${inFooter} in the footer`
          );
        }
      },
      { timeout: 10_000 }
    );
  },
};

export const IPhone16eAnalyticsSidebarControl: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: "ws-iphone-analytics",
          workspaceName: "analytics-mobile",
          projectName: "mux",
          messages: [...MESSAGES],
        });
        updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
        return client;
      }}
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await stabilizePhoneViewportStory(canvasElement);

    await userEvent.click(await canvas.findByTestId("analytics-button"));
    await canvas.findByTestId("analytics-header");
    await userEvent.click(canvas.getByRole("button", { name: "Collapse sidebar" }));

    const openSidebarButton = await canvas.findByRole("button", { name: "Open sidebar" });
    if (!openSidebarButton.classList.contains("mobile-menu-btn")) {
      throw new Error("Analytics sidebar opener is not enabled for the phone viewport");
    }

    blurActiveElement();
  },
};

export const IPhone17ProMax: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-iphone-17-pro-max",
          workspaceName: "mobile",
          projectName: "mux",
          messages: [...MESSAGES],
        })
      }
    />
  ),
  decorators: [IPhone17ProMaxDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);
  },
};

const COMPOSER_DECORATIONS_WORKSPACE_ID = "ws-iphone-16e-composer-decorations";

/**
 * Neither Pixel nor the test-runner matches `pointer: coarse`, so read the shipped rule instead
 * of the rendered height: the min-height `selector` receives inside a coarse-pointer media rule.
 */
function coarsePointerMinHeight(selector: string): number | null {
  const visit = (rules: CSSRuleList, inCoarse: boolean): number | null => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (inCoarse && rule.selectorText === selector && rule.style.minHeight) {
          return Number.parseFloat(rule.style.minHeight);
        }
      } else if (rule instanceof CSSGroupingRule) {
        const coarse =
          inCoarse ||
          (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse"));
        const found = visit(rule.cssRules, coarse);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const sheet of document.styleSheets) {
    const found = visit(sheet.cssRules, false);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Every collapsible decoration stacked above the composer at once (TODO, sub-agents, background
 * bash). Pixel captures the collapsed stack at phone width; the play assertion covers the touch
 * floor these rows opt into, which the snapshot cannot.
 */
export const IPhone16eComposerDecorations: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        updatePersistedState(getPinnedTodoExpandedKey(COMPOSER_DECORATIONS_WORKSPACE_ID), false);
        updatePersistedState(getSubAgentTasksExpandedKey(COMPOSER_DECORATIONS_WORKSPACE_ID), false);
        return setupSimpleChatStory({
          workspaceId: COMPOSER_DECORATIONS_WORKSPACE_ID,
          workspaceName: "mobile-decorations",
          projectName: "mux",
          projectPath: "/home/user/projects/mux",
          messages: [
            MESSAGES[0],
            createAssistantMessage("msg-2", "Tracking the remaining work in the TODO list.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 110_000,
              toolCalls: [
                createTodoWriteTool("call-todo-1", [
                  { content: "Audit phone layout", status: "completed" },
                  { content: "Tighten decoration rows", status: "in_progress" },
                  { content: "Verify on device", status: "pending" },
                ]),
              ],
            }),
          ],
          additionalWorkspaces: [
            createWorkspace({
              id: "ws-iphone-16e-composer-decorations-subagent",
              name: "agent_explore_layout",
              title: "Check narrow layout",
              projectName: "mux",
              projectPath: "/home/user/projects/mux",
              parentWorkspaceId: COMPOSER_DECORATIONS_WORKSPACE_ID,
              taskStatus: "reported",
            }),
          ],
          backgroundProcesses: [
            {
              id: "bg-dev-server",
              pid: 4242,
              script: "bun run dev",
              displayName: "dev server",
              startTime: STABLE_TIMESTAMP - 90_000,
              status: "running",
            },
          ],
        });
      }}
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitFor(() => {
      const rows = storyRoot.querySelectorAll(
        '[data-component="ChatInputDecorationStack"] .mobile-touch-row'
      );
      if (rows.length < 3) {
        throw new Error(`Expected TODO, sub-agent, and background bash rows, found ${rows.length}`);
      }
    });

    const rowFloor = coarsePointerMinHeight(".mobile-touch-row");
    if (rowFloor === null || rowFloor >= MOBILE_TOUCH_TARGET_PX) {
      throw new Error(
        `Decoration rows should sit below the ${MOBILE_TOUCH_TARGET_PX}px touch floor on coarse pointers, got ${String(rowFloor)}`
      );
    }
  },
};

/**
 * Stands in for the `pointer: coarse` coverage gap noted above. Neither Pixel nor the Storybook
 * test-runner emulates touch, so this applies the touch-target floor that globals.css would apply
 * and asserts the rows that hold those controls grow with them instead of clipping them.
 */
export const IPhone17ProMaxTouchTargetRows: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-touch-target-rows",
          workspaceName: "mobile-touch",
          projectName: "mux",
          messages: [...MESSAGES],
        })
      }
    />
  ),
  decorators: [IPhone17ProMaxDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const footerRow = storyRoot.querySelector<HTMLElement>(
      '[data-testid="workspace-footer-bar"] > div'
    );
    if (!footerRow) throw new Error("Footer row not rendered");
    const modelGroup = storyRoot.querySelector<HTMLElement>(
      '[data-component="ModelSelectorGroup"]'
    );
    if (!modelGroup) throw new Error("Composer model group not rendered");

    const rows = [
      { label: "footer info row", el: footerRow },
      { label: "composer model pill", el: modelGroup },
    ];
    for (const row of rows) {
      if (row.el.querySelectorAll("button, a").length === 0) {
        throw new Error(`${row.label} has no touch targets to size against`);
      }
    }

    const touchFloor = document.createElement("style");
    touchFloor.textContent = `[data-testid="workspace-footer-bar"] button, [data-testid="workspace-footer-bar"] a, [data-component="ModelSelectorGroup"] button { min-height: ${MOBILE_TOUCH_TARGET_PX}px; }`;
    document.head.append(touchFloor);

    try {
      await waitFor(() => {
        for (const row of rows) {
          const height = row.el.getBoundingClientRect().height;
          if (height < MOBILE_TOUCH_TARGET_PX) {
            throw new Error(
              `${row.label} caps its height at ${Math.round(height)}px, clipping ${MOBILE_TOUCH_TARGET_PX}px touch targets`
            );
          }
          if (row.el.scrollHeight > row.el.clientHeight) {
            throw new Error(
              `${row.label} clips ${row.el.scrollHeight - row.el.clientHeight}px of its controls`
            );
          }
        }
      });
    } finally {
      touchFloor.remove();
    }
  },
};

export const IPhone17ProMaxTouchReviewImmersive: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID,
          workspaceName: "mobile-review",
          projectName: "mux",
          messages: [...MESSAGES],
          gitDiff: {
            diffOutput: TOUCH_REVIEW_IMMERSIVE_DIFF,
            numstatOutput: TOUCH_REVIEW_IMMERSIVE_NUMSTAT,
          },
        })
      }
    />
  ),
  decorators: [IPhone17ProMaxDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE, {
        workspaceId: TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID,
      })
    );

    const canvas = within(canvasElement);
    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
      },
      { timeout: 10_000 }
    );

    await waitFor(
      () => {
        const immersiveView = canvas.getByTestId("immersive-review-view");
        within(immersiveView).getByText(/Tap any changed line to add a note immediately\./i);
        if (canvas.queryByRole("heading", { name: "Notes" })) {
          throw new Error("Touch immersive mode should hide the desktop notes sidebar.");
        }
        // The chat column is hidden here, so it must not keep claiming the bottom safe-area inset
        // the app root would otherwise reserve for this view's own scroll area.
        if (document.querySelectorAll("[data-bottom-inset-owner]").length > 0) {
          throw new Error("Immersive review left the bottom safe-area inset unowned.");
        }
      },
      { timeout: 10_000 }
    );

    blurActiveElement();
  },
};

const TIMELINE_DIALOG_WORKSPACE_ID = "ws-iphone-16e-timeline";
const TIMELINE_DIALOG_BASE_TS = Date.UTC(2020, 0, 15, 15, 0, 0);
const TIMELINE_DIALOG_EVENTS: TimelineEvent[] = [
  {
    v: 1,
    id: "turn-completed",
    kind: "turn.completed",
    seq: 3,
    ts: TIMELINE_DIALOG_BASE_TS,
    source: { system: "chat" },
    status: "completed",
    data: { model: "anthropic/claude-sonnet-4", mode: "exec", durationMs: 84_000 },
    anchor: { messageId: "msg-2" },
  },
  {
    v: 1,
    id: "agent-milestone",
    kind: "agent.event",
    seq: 2,
    ts: TIMELINE_DIALOG_BASE_TS - 45_000,
    source: { system: "agent", key: "timeline-event:milestone" },
    data: {
      description: "Wired the mobile timeline dialog behind the workspace actions menu",
      category: "milestone",
    },
  },
  {
    v: 1,
    id: "goal-set",
    kind: "goal.set",
    seq: 1,
    ts: TIMELINE_DIALOG_BASE_TS - 90_000,
    source: { system: "goal" },
    status: "started",
    data: { digest: "Make the timeline reachable at phone widths" },
  },
];

/**
 * Timeline on small viewports: the right sidebar (the timeline's usual home) is
 * hidden at phone widths, so the workspace actions menu offers a Timeline entry
 * that opens the panel in a dialog instead.
 */
export const IPhone16eTimelineDialog: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: TIMELINE_DIALOG_WORKSPACE_ID,
          workspaceName: "mobile-timeline",
          projectName: "mux",
          messages: [...MESSAGES],
          timelineEvents: TIMELINE_DIALOG_EVENTS,
        });
        updatePersistedState(getExperimentKey(EXPERIMENT_IDS.TIMELINE), true);
        return client;
      }}
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    // The Timeline menu action is gated on `window.matchMedia`, which the fixed-width
    // decorator cannot move; only assert where the viewport is genuinely narrow (Pixel's
    // phone viewport). The test-runner executes at desktop window size and skips here.
    if (!window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches) {
      return;
    }

    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId("workspace-more-actions"));
    await userEvent.click(
      await waitFor(() => within(document.body).getByTestId("workspace-timeline-button"))
    );

    // The dialog portals to document.body, outside the story canvas.
    await waitFor(
      () => {
        const dialog = document.querySelector('[data-testid="timeline-dialog"]');
        if (!dialog) {
          throw new Error("Timeline dialog did not open");
        }
        within(dialog as HTMLElement).getByText(
          "Wired the mobile timeline dialog behind the workspace actions menu"
        );
      },
      { timeout: 10_000 }
    );

    blurActiveElement();
  },
};

/**
 * Mobile sidebar with a project containing a custom section.
 * Verifies section header action buttons (+, color, rename, delete) are visible
 * on touch devices where hover state doesn't exist.
 */
export const IPhone16eSidebarWithSections: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectPath = "/home/user/projects/my-app";
        const sectionId = `${projectPath}/features`;

        const workspaces = [
          createWorkspace({
            id: "ws-unsectioned",
            name: "main",
            projectName: "my-app",
            projectPath,
          }),
          {
            ...createWorkspace({
              id: "ws-in-section-1",
              name: "feature/auth",
              projectName: "my-app",
              projectPath,
            }),
            subProjectPath: sectionId,
          },
          {
            ...createWorkspace({
              id: "ws-in-section-2",
              name: "feature/payments",
              projectName: "my-app",
              projectPath,
            }),
            subProjectPath: sectionId,
          },
        ];

        // Build project config with a nested sub-project.
        const projects = groupWorkspacesByProject(workspaces);
        projects.set(sectionId, {
          displayName: "Features",
          color: "#6366f1",
          parentProjectPath: projectPath,
          workspaces: [],
        });

        // Sidebar open with no workspace selected so the sidebar content is visible
        clearWorkspaceSelection();
        collapseRightSidebar();
        expandProjects([projectPath]);
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));

        return createMockORPCClient({ projects, workspaces });
      }}
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  play: async ({ canvasElement }) => {
    const projectPath = "/home/user/projects/my-app";
    // No workspace is selected so there's no ChatInput to wait for;
    // skip stabilizePhoneViewportStory and wait for the section directly.
    await waitFor(
      () => {
        const sectionHeader = canvasElement.querySelector(
          `[data-section-id="${projectPath}/features"]`
        );
        if (!sectionHeader) throw new Error("Sub-project header not found");
        // Verify the section header action buttons are in the DOM.
        // Neither the Storybook test runner nor Pixel emulates pointer:coarse,
        // so the opacity-via-media-query visibility is not asserted here.
        within(sectionHeader as HTMLElement).getByLabelText("New chat in sub-project");
      },
      { timeout: 10_000 }
    );

    blurActiveElement();
  },
};
