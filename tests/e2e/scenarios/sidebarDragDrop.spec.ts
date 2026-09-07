import { expect } from "@playwright/test";
import { electronTest as test } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("sidebar drag and drop", () => {
  // Drag reorder tests are flaky on Linux/Xvfb - programmatic DragEvent dispatch
  // doesn't trigger dnd-kit's sortable reordering reliably in headless environments.
  // These tests pass consistently on macOS where native DnD events work.
  const skipDragOnLinux = process.platform === "linux";

  test("can drag an active tab to reorder within tabstrip", async ({ page, ui }) => {
    test.skip(skipDragOnLinux, "Drag reorder is flaky on Linux/Xvfb");
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    const tablist = sidebar.getByRole("tablist");
    await expect(tablist).toBeVisible({ timeout: 5000 });

    const costsTab = tablist.getByRole("tab", { name: /Stats/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    await expect(costsTab).toBeVisible({ timeout: 5000 });
    await expect(reviewTab).toBeVisible({ timeout: 5000 });

    // Stats tab should be selected (active) by default
    await expect(costsTab).toHaveAttribute("aria-selected", "true");

    // Verify initial order: Stats comes before Review
    const initialTabs = await tablist.getByRole("tab").all();
    const initialLabels = await Promise.all(initialTabs.map((t) => t.textContent()));
    const costsIndex = initialLabels.findIndex((l) => l?.includes("Stats"));
    const reviewIndex = initialLabels.findIndex((l) => l?.includes("Review"));
    expect(costsIndex).toBeLessThan(reviewIndex);

    // Drag active Stats tab to after Review tab position (reorder)
    // Tabs are directly draggable without needing a handle
    await ui.dragElement(costsTab, reviewTab, { targetPosition: "after" });

    // Verify tabs were reordered: review now comes before costs
    const reorderedTabs = await tablist.getByRole("tab").all();
    const reorderedLabels = await Promise.all(reorderedTabs.map((t) => t.textContent()));
    const newCostsIndex = reorderedLabels.findIndex((l) => l?.includes("Stats"));
    const newReviewIndex = reorderedLabels.findIndex((l) => l?.includes("Review"));
    expect(newReviewIndex).toBeLessThan(newCostsIndex);
  });

  test("can drag an inactive tab to reorder within tabstrip", async ({ page, ui }) => {
    test.skip(skipDragOnLinux, "Drag reorder is flaky on Linux/Xvfb");
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Add a terminal tab first (not present by default)
    await ui.metaSidebar.addTerminal();

    const tablist = sidebar.getByRole("tablist");
    const costsTab = tablist.getByRole("tab", { name: /Stats/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    // Terminal tab name may be "Terminal" initially or a cwd path after shell starts
    // Find it by looking for tab with close button (only terminal tabs have X button)
    const terminalTab = tablist.locator('[role="tab"]').filter({
      has: page.getByRole("button", { name: "Close terminal" }),
    });
    await expect(costsTab).toBeVisible({ timeout: 5000 });
    await expect(reviewTab).toBeVisible({ timeout: 5000 });
    await expect(terminalTab).toBeVisible({ timeout: 5000 });

    // Terminal tab is selected after adding; select Stats to make Terminal inactive
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
    await expect(terminalTab).toHaveAttribute("aria-selected", "false");

    // Verify initial order: costs, review, terminal (terminal is last after adding)
    await tablist.getByRole("tab").all();
    await tablist.getByRole("tab", { name: /Stats/ }).evaluate((el) => {
      return Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!);
    });
    const reviewIndex = await tablist.getByRole("tab", { name: /Review/ }).evaluate((el) => {
      return Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!);
    });
    const terminalIndex = await terminalTab.evaluate((el) => {
      return Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!);
    });
    expect(reviewIndex).toBeLessThan(terminalIndex);

    // Drag INACTIVE terminal tab to before review tab (reorder)
    // This tests that inactive tabs can be dragged just like active tabs
    await ui.dragElement(terminalTab, reviewTab, { targetPosition: "before" });

    // Verify tabs were reordered: terminal now comes before review
    const newTerminalIndex = await terminalTab.evaluate((el) => {
      return Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!);
    });
    const newReviewIndex = await tablist.getByRole("tab", { name: /Review/ }).evaluate((el) => {
      return Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!);
    });
    expect(newTerminalIndex).toBeLessThan(newReviewIndex);

    // The active tab should still be Stats (drag shouldn't change selection)
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
  });

  test("sidebar tabs are interactive and switch content", async ({ page, ui }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible();

    // Add a terminal tab first (not present by default)
    await ui.metaSidebar.addTerminal();

    const tablist = sidebar.getByRole("tablist");
    await expect(tablist).toBeVisible();

    // Get all tabs - terminal has close button (unique to terminal tabs)
    const costsTab = tablist.getByRole("tab", { name: /Stats/ });
    const reviewTab = tablist.getByRole("tab", { name: /Review/ });
    const terminalTab = tablist.locator('[role="tab"]').filter({
      has: page.getByRole("button", { name: "Close terminal" }),
    });

    // Click through each tab and verify it becomes selected
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");

    await reviewTab.click();
    await expect(reviewTab).toHaveAttribute("aria-selected", "true");
    await expect(costsTab).toHaveAttribute("aria-selected", "false");

    await terminalTab.click();
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
    await expect(reviewTab).toHaveAttribute("aria-selected", "false");

    // Return to Stats
    await costsTab.click();
    await expect(costsTab).toHaveAttribute("aria-selected", "true");
  });

  test("split layout can be created and navigated via keyboard/localStorage", async ({
    page,
    ui,
  }) => {
    await ui.projects.openFirstWorkspace();

    const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
    await expect(sidebar).toBeVisible();

    // Get workspaceId from context for per-workspace layout key
    const workspaceId = ui.context.workspaceId;

    // Seed Goal so its asynchronous restoration cannot race the tab-count check.
    // Layout key is per-workspace: "right-sidebar:layout:{workspaceId}"
    await page.evaluate(
      ({ wsId }) => {
        const splitLayout = {
          version: 1,
          nextId: 3,
          focusedTabsetId: "tabset-1",
          root: {
            type: "split",
            id: "split-0",
            direction: "vertical",
            sizes: [50, 50],
            children: [
              {
                type: "tabset",
                id: "tabset-1",
                tabs: ["costs", "review", "goal"],
                activeTab: "costs",
              },
              {
                type: "tabset",
                id: "tabset-2",
                tabs: ["costs"], // Use costs since terminal isn't persisted by default
                activeTab: "costs",
              },
            ],
          },
        };
        localStorage.setItem(`right-sidebar:layout:${wsId}`, JSON.stringify(splitLayout));
      },
      { wsId: workspaceId }
    );

    // Reload to pick up the layout, then re-open the workspace via the sidebar
    // so the persisted split layout is applied in the active workspace view.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await ui.projects.openFirstWorkspace();

    // Wait for sidebar to appear
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Verify we now have two tablists (split layout)
    const tablists = await sidebar.getByRole("tablist").all();
    expect(tablists.length).toBe(2);

    // The migration adds Instructions alongside the persisted Stats, Review, and Goal tabs.
    await expect(tablists[0].getByRole("tab")).toHaveCount(4);
    await expect(tablists[1].getByRole("tab")).toHaveCount(1); // Stats (duplicate costs in split)
  });

  // Note: Full drag-drop tests require real browser mouse events which
  // don't work reliably with Playwright + Xvfb + react-dnd HTML5 backend.
  // Drag behavior is tested via:
  // - Unit tests: src/browser/utils/rightSidebarLayout.test.ts
  // - UI integration: tests/ui/rightSidebar.integration.test.ts
});
