import { type Locator, type Page } from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import { REVIEW_SORT_ORDER_KEY } from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";
import { disableReviewTutorial, seedLargeReviewSingleFileDiff } from "../utils/reviewPerfFixture";

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";
const HUNK_ITERATION_COUNT = 60;

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

interface DurationSummary {
  sampleCount: number;
  totalMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

interface SyntaxHighlightSummary {
  lineCount: number;
  syntaxHighlightedLineCount: number;
  fullContextReadyAfterInitialRevealMs?: number;
  fullContextReadyMs?: number;
  initialRevealReadyMs?: number;
}

function summarizeDurations(samples: number[]): DurationSummary {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      totalMs: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
      maxMs: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (percent: number) => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
  };
  const totalMs = samples.reduce((total, sample) => total + sample, 0);

  return {
    sampleCount: samples.length,
    totalMs,
    meanMs: totalMs / samples.length,
    medianMs: percentile(50),
    p95Ms: percentile(95),
    maxMs: sorted[sorted.length - 1],
  };
}

async function readSyntaxHighlightSummary(
  lineContainers: Locator
): Promise<SyntaxHighlightSummary> {
  return lineContainers.evaluateAll((lineElements) => {
    const getCodeCell = (lineElement: Element): Element | null => {
      const spanCells = Array.from(lineElement.children).filter(
        (child) => child.tagName === "SPAN"
      );
      return spanCells[spanCells.length - 1] ?? null;
    };

    return {
      lineCount: lineElements.length,
      syntaxHighlightedLineCount: lineElements.filter((lineElement) => {
        const codeCell = getCodeCell(lineElement);
        return codeCell?.querySelector('span[style*="color"]') != null;
      }).length,
    };
  });
}

async function waitForAllSyntaxHighlighted(
  lineContainers: Locator,
  expectedLineCount: number
): Promise<SyntaxHighlightSummary> {
  await expect(lineContainers).toHaveCount(expectedLineCount, { timeout: 20_000 });
  await expect
    .poll(() => readSyntaxHighlightSummary(lineContainers), { timeout: 20_000 })
    .toEqual({
      lineCount: expectedLineCount,
      syntaxHighlightedLineCount: expectedLineCount,
    });

  return readSyntaxHighlightSummary(lineContainers);
}

async function primeReviewForHeadDiff(page: Page, workspaceId: string): Promise<void> {
  const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspaceId);

  await page.evaluate(
    ({ diffBaseKey, sortOrderKey }) => {
      window.localStorage.setItem(diffBaseKey, JSON.stringify("HEAD"));
      window.localStorage.setItem("review-show-read", JSON.stringify(true));
      window.localStorage.setItem(sortOrderKey, JSON.stringify("file-order"));
    },
    {
      diffBaseKey: reviewDiffBaseKey,
      sortOrderKey: REVIEW_SORT_ORDER_KEY,
    }
  );
}

test.describe("immersive review hunk iteration performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: iterate hunks in immersive review for a large file", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    await disableReviewTutorial(page);

    const diffSummary = seedLargeReviewSingleFileDiff(workspace.demoProject.workspacePath);
    const expectedOverlayLineCount = diffSummary.lineCount + diffSummary.deletedLines;
    expect(diffSummary.hunkCount).toBeGreaterThan(HUNK_ITERATION_COUNT);

    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId);

    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel).toBeVisible();
    await expect(reviewPanel.getByText(`0/${diffSummary.hunkCount}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const immersiveButton = reviewPanel.getByRole("button", { name: "Enter immersive review" });
    await expect(immersiveButton).toBeVisible();
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
      timeout: 20_000,
    });

    const syntaxHighlightStartedAt = Date.now();
    // Wait for the full-file overlay, not just compact diff hunks, so this profile
    // reproduces the sluggish path users hit when reviewing many hunks in one large file.
    const diffLineContainers = immersiveReview.locator(
      '[data-testid="immersive-diff-reveal-stage"] div[data-line-index]'
    );
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });
    const initialRevealReadyMs = Date.now() - syntaxHighlightStartedAt;
    const fullContextReadyStartedAt = Date.now();
    // Plain fallback lines render as text-only cells. Shiki-highlighted lines add
    // nested colorized token spans; wait for every generated line before profiling.
    const syntaxHighlightSummary = {
      ...(await waitForAllSyntaxHighlighted(diffLineContainers, expectedOverlayLineCount)),
      fullContextReadyAfterInitialRevealMs: Date.now() - fullContextReadyStartedAt,
      fullContextReadyMs: Date.now() - syntaxHighlightStartedAt,
      initialRevealReadyMs,
    };
    await immersiveReview.focus();

    await resetReactProfileSamples(page);

    let iterationDurationsMs: number[] = [];
    const runLabel = `review-immersive-hunk-iteration-${diffSummary.lineCount}-lines-${diffSummary.hunkCount}-hunks`;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      iterationDurationsMs = await page.evaluate(async (iterationCount) => {
        const immersiveView = document.querySelector<HTMLElement>(
          '[data-testid="immersive-review-view"]'
        );
        if (!immersiveView) {
          throw new Error("Immersive review view was not found");
        }

        const waitForFrame = () =>
          new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        const durations: number[] = [];
        immersiveView.focus();

        for (let stepIndex = 0; stepIndex < iterationCount; stepIndex += 1) {
          const expectedPosition = String(stepIndex + 2);
          const startedAt = window.performance.now();
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "j",
              bubbles: true,
              cancelable: true,
            })
          );

          while (immersiveView.getAttribute("data-selected-hunk-position") !== expectedPosition) {
            await waitForFrame();
          }
          durations.push(window.performance.now() - startedAt);
        }

        return durations;
      }, HUNK_ITERATION_COUNT);
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) {
      throw new Error("React profile snapshot was not captured");
    }

    const iterationSummary = summarizeDurations(iterationDurationsMs);
    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: {
        kind: "immersive-review-hunk-iteration",
        ...diffSummary,
        syntaxHighlighting: syntaxHighlightSummary,
        iterationCount: HUNK_ITERATION_COUNT,
        iterationDurationsMs,
        iterationSummary,
      },
    });

    expect(iterationSummary.sampleCount).toBe(HUNK_ITERATION_COUNT);
    expect(chromeProfile.wallTimeMs).toBeGreaterThan(0);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
