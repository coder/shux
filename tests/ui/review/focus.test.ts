import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";
import { renderReviewPanel } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("ReviewPanel focus (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("Cmd/Ctrl+2 focuses the review panel so j/k navigation works without clicking", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Ensure focus starts outside the review panel.
        await view.selectTab("costs");
        const costsTab = view.container.querySelector(
          '[role="tab"][aria-controls*="costs"]'
        ) as HTMLElement | null;
        expect(costsTab).not.toBeNull();
        costsTab?.focus();

        // Trigger the tab shortcut for the 2nd right-sidebar tab (default: Review).
        // Use ctrlKey so this works regardless of OS detection (matchesKeybind treats
        // Ctrl/Cmd as equivalent on macOS).
        fireEvent.keyDown(window, { key: "2", ctrlKey: true });

        await waitFor(
          () => {
            const reviewPanel = view.container.querySelector(
              '[data-testid="review-panel"]'
            ) as HTMLElement | null;
            if (!reviewPanel) {
              throw new Error("Review panel not mounted");
            }

            const active = document.activeElement;
            if (!(active instanceof HTMLElement)) {
              throw new Error("No active element");
            }

            if (!reviewPanel.contains(active)) {
              throw new Error("Review panel not focused");
            }
          },
          { timeout: 30_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
    // 120s total (like undo.test.ts): CI runners under merge-queue load inflate wall
    // clock enough that a 30s budget covering workspace setup + render was exceeded
    // while sibling suites passed at 100s+ (merge-queue run 32715740782).
  }, 120_000);
});
