import { type Page } from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import {
  REVIEW_SORT_ORDER_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
} from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import { seedWorkspaceHistoryProfile } from "../utils/historyFixture";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";
import { disableReviewTutorial, seedLargeReviewDiff } from "../utils/reviewPerfFixture";

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";
const REVIEW_CHANGED_LINES_PER_FILE = 50;
const MIN_REVIEW_FILE_COUNT = 1_000;
const MIN_REVIEW_CHANGED_LINES = 50_000;

async function primeReviewSidebarForWorkspace(page: Page, workspaceId: string): Promise<void> {
  const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspaceId);

  await page.evaluate(
    ({ collapsedKey, diffBaseKey, sidebarTabKey, sortOrderKey }) => {
      // The cold-open scenario should mount the Review tab next to the transcript immediately.
      window.localStorage.setItem(sidebarTabKey, JSON.stringify("review"));
      window.localStorage.setItem(collapsedKey, JSON.stringify(false));
      window.localStorage.setItem(diffBaseKey, JSON.stringify("HEAD"));
      window.localStorage.setItem("review-show-read", JSON.stringify(true));
      window.localStorage.setItem(sortOrderKey, JSON.stringify("file-order"));
    },
    {
      collapsedKey: RIGHT_SIDEBAR_COLLAPSED_KEY,
      diffBaseKey: reviewDiffBaseKey,
      sidebarTabKey: RIGHT_SIDEBAR_TAB_KEY,
      sortOrderKey: REVIEW_SORT_ORDER_KEY,
    }
  );
}

async function waitForChatAndReviewReady(page: Page): Promise<void> {
  await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });

  const reviewPanel = page.getByTestId("review-panel");
  await expect(reviewPanel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("review-file-tree")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-hunk-id]").first()).toBeVisible({ timeout: 30_000 });
}

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("chat open with review sidebar performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: open large chat with a huge review already selected", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    await disableReviewTutorial(page);

    const historySummary = await seedWorkspaceHistoryProfile({
      demoProject: workspace.demoProject,
      profile: "large",
    });
    const diffSummary = seedLargeReviewDiff(workspace.demoProject.workspacePath, {
      changedLinesPerFile: REVIEW_CHANGED_LINES_PER_FILE,
    });

    expect(diffSummary.fileCount).toBeGreaterThanOrEqual(MIN_REVIEW_FILE_COUNT);
    expect(diffSummary.addedLines).toBeGreaterThanOrEqual(MIN_REVIEW_CHANGED_LINES);
    expect(diffSummary.deletedLines).toBeGreaterThanOrEqual(MIN_REVIEW_CHANGED_LINES);

    await primeReviewSidebarForWorkspace(page, workspace.demoProject.workspaceId);
    await resetReactProfileSamples(page);

    const runLabel = `chat-open-review-${diffSummary.fileCount}-files-${diffSummary.addedLines}-added-lines`;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await ui.projects.openFirstWorkspace();
      await waitForChatAndReviewReady(page);
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) {
      throw new Error("React profile snapshot was not captured");
    }

    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: {
        kind: "chat-open-with-review-sidebar",
        history: historySummary,
        review: diffSummary,
      },
    });

    expect(chromeProfile.wallTimeMs).toBeLessThan(8_000);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
