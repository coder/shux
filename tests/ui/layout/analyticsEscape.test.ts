/**
 * UI integration test: Escape closes the analytics dashboard.
 *
 * Mirrors the existing behavior where Escape closes Settings,
 * ensuring route-level overlay pages are consistent.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

describe("Analytics Escape", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("Escape closes the analytics dashboard and returns to workspace", async () => {
    const app = await createAppHarness({ branchPrefix: "analytics-esc" });

    try {
      // Open analytics via the TitleBar button.
      const analyticsButton = app.view.container.querySelector(
        '[data-testid="analytics-button"]'
      ) as HTMLButtonElement;
      expect(analyticsButton).not.toBeNull();
      fireEvent.click(analyticsButton);

      // Verify analytics is visible (heading text) and chat is gone.
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          if (!text.includes("Analytics")) {
            throw new Error("Analytics dashboard not visible");
          }
          const messageWindow = app.view.container.querySelector('[data-testid="message-window"]');
          if (messageWindow) {
            throw new Error("Workspace chat should be replaced by analytics");
          }
        },
        { timeout: 30_000 }
      );

      // Press Escape to close analytics.
      fireEvent.keyDown(window, { key: "Escape" });

      // Verify analytics is closed and workspace chat is back.
      await waitFor(
        () => {
          const messageWindow = app.view.container.querySelector('[data-testid="message-window"]');
          if (!messageWindow) {
            throw new Error("Workspace chat did not reappear after Escape");
          }
        },
        { timeout: 30_000 }
      );
    } finally {
      await app.dispose();
    }
    // 120s total (like focus/undo): CI runners under merge-queue load inflate wall
    // clock enough that the 60s budget covering harness setup + interactions was
    // exceeded at 66s (merge-queue run 32719185534) on a PR that never touched this area.
  }, 120_000);
});
