import { expect, within } from "@storybook/test";

import { createMuxMessage } from "@/common/types/message";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { waitForScrollStabilization } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/ContinuousCompaction",
};

const RECENT_REQUEST = "Keep the migration reversible and preserve the existing tests.";
const RECENT_REPLY = "The latest changes and verification results remain in context.";
const HIDDEN_CONTEXT = "Model-only continuation context.";

function setupContinuousCompactionStory() {
  collapseLeftSidebar();
  const messages = [
    createMuxMessage("summary", "assistant", "Earlier work: the migration is implemented.", {
      historySequence: 10,
      timestamp: STABLE_TIMESTAMP - 30_000,
      model: "google:gemini-3.1-flash-lite",
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 3,
      muxMetadata: { type: "compaction-summary", strategy: "continuous" },
    }),
    // These are durable tail copies, not a new user send or an active assistant stream.
    createMuxMessage("tail-user", "user", RECENT_REQUEST, {
      historySequence: 11,
      timestamp: STABLE_TIMESTAMP - 20_000,
      synthetic: true,
      uiVisible: true,
    }),
    createMuxMessage("tail-assistant", "assistant", RECENT_REPLY, {
      historySequence: 12,
      timestamp: STABLE_TIMESTAMP - 10_000,
      synthetic: true,
      uiVisible: true,
      stepStartPartIndices: [0],
    }),
    createMuxMessage("hidden-context", "user", HIDDEN_CONTEXT, {
      historySequence: 13,
      timestamp: STABLE_TIMESTAMP,
      synthetic: true,
    }),
  ];
  return setupSimpleChatStory({
    workspaceId: "ws-continuous-compaction",
    workspaceName: "continuous-compaction",
    messages: messages.map((message) => ({ ...message, type: "message" as const })),
  });
}

export const PreservedTail: AppStory = {
  render: () => <AppWithMocks setup={setupContinuousCompactionStory} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const boundary = await canvas.findByRole("separator", { name: "Continuous compaction #3" });
    const request = await canvas.findByText(RECENT_REQUEST);
    const reply = await canvas.findByText(RECENT_REPLY);
    await expect(canvas.queryByText(HIDDEN_CONTEXT)).not.toBeInTheDocument();
    await expect(
      boundary.compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
    await expect(
      request.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
    await waitForScrollStabilization(canvasElement);

    // Fixed-width decorators keep this contract active in the desktop-sized test-runner too.
    const frame = canvasElement.querySelector("[data-compaction-phone-width]");
    if (frame) {
      const width = Number(frame.getAttribute("data-compaction-phone-width"));
      await expect(frame.getBoundingClientRect().width).toBe(width);
      // The desktop-sized test-runner retains the app's desktop minimum width;
      // only the manager/Pixel phone viewport activates its narrow media rules.
      if (window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX) {
        await expect(boundary.getBoundingClientRect().right).toBeLessThanOrEqual(
          frame.getBoundingClientRect().right
        );
      }
      // The label must fit the transcript even under the test-runner's desktop media rules.
      const badge = await canvas.findByText("compacted", { exact: true });
      await expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(
        boundary.getBoundingClientRect().right
      );
    }
  },
};

export const Phone375: AppStory = {
  ...PreservedTail,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [
    (Story) => (
      <div data-compaction-phone-width="375" style={{ width: 375, height: 667 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};

export const Phone390: AppStory = {
  ...PreservedTail,
  globals: { viewport: { value: "continuousPhone", isRotated: false } },
  decorators: [
    (Story) => (
      <div data-compaction-phone-width="390" style={{ width: 390, height: 844 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        continuousPhone: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};
