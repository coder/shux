import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const STORY_DIR = "src/browser/stories";
const PLAN_TOC_STORY_PATH =
  "src/browser/features/Tools/ProposePlan/ProposePlanToolCall.stories.tsx";
const PLAN_TOC_MIN_WIDTH = 1600;

/** App-level integration allowlist — files that must exist with smoke coverage. */
const REQUIRED_APP_STORIES = [
  "App.commandPalette.stories.tsx",
  "App.phoneViewports.stories.tsx",
] as const;

const REQUIRED_COLOCATED_STORIES = [
  "src/browser/components/ProjectCreateModal/ProjectCreateModal.stories.tsx",
  "src/browser/components/TitleBar/TitleBar.stories.tsx",
  "src/browser/components/WorkspaceMenuBar/WorkspaceMenuBar.stories.tsx",
  "src/browser/components/ProjectPage/ProjectPage.stories.tsx",
  "src/browser/features/Messages/ChatBarrier/InterruptedBarrier.stories.tsx",
  "src/browser/components/DebugLlmRequestModal/DebugLlmRequestModal.stories.tsx",
  "src/browser/components/AIView/AIView.stories.tsx",
  "src/browser/components/ProjectSidebar/ProjectSidebar.stories.tsx",
  "src/browser/features/Messages/MessageRenderer.stories.tsx",
] as const;

const MIGRATED_APP_STORIES = [
  "App.sidebar.stories.tsx",
  "App.welcome.stories.tsx",
  "App.errors.stories.tsx",
  "App.titlebar.stories.tsx",
  "App.projectCreate.stories.tsx",
] as const;

const hasExplicitPixelPolicy = (content: string): boolean => {
  return content.includes("PIXEL_DUAL_THEME") || content.includes("PIXEL_DISABLED");
};

const hasSmokeStoryWithDualThemeCoverage = (content: string): boolean => {
  return (
    /matrix:\s*PIXEL_DUAL_THEME/.test(content) ||
    /matrix:\s*\{[^}]*themes:\s*\["dark",\s*"light"\]/.test(content)
  );
};

function getPlanTocViewports(content: string): string | null {
  const matrixMatch = content.match(
    /PLAN_TOC_PIXEL_MATRIX\s*=\s*\{\s*viewports:\s*\[([^\]]*)\]\s*\}/
  );
  return matrixMatch?.[1] ?? null;
}

describe("Storybook coverage contract", () => {
  describe("App stories", () => {
    for (const filename of REQUIRED_APP_STORIES) {
      const filepath = `${STORY_DIR}/${filename}`;

      test(`${filename} exists`, () => {
        expect(existsSync(filepath)).toBe(true);
      });

      test(`${filename} has at least one smoke story with dual-theme coverage`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasSmokeStoryWithDualThemeCoverage(content)).toBe(true);
      });
    }
  });

  describe("Colocated stories", () => {
    for (const filepath of REQUIRED_COLOCATED_STORIES) {
      test(`${filepath} exists`, () => {
        expect(existsSync(filepath)).toBe(true);
      });

      test(`${filepath} has explicit pixel snapshot policy`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasExplicitPixelPolicy(content)).toBe(true);
      });

      test(`${filepath} has at least one smoke story with dual-theme coverage`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasSmokeStoryWithDualThemeCoverage(content)).toBe(true);
      });
    }
  });

  describe("Story-specific visual contracts", () => {
    test("plan ToC story pins a wide Pixel viewport", () => {
      const content = readFileSync(PLAN_TOC_STORY_PATH, "utf-8");

      // This story validates gutter-only UI: the full ToC is hidden at Pixel's
      // default 1200px laptop width, so it must pin the 1900px desktop variant.
      expect(getPlanTocViewports(content)).toContain("desktop");
      expect(/matrix:\s*PLAN_TOC_PIXEL_MATRIX/.test(content)).toBe(true);

      // The play() width guard must stay in sync with the pinned viewport.
      const widthMatch = content.match(/PLAN_TOC_MIN_WIDTH\s*=\s*(\d+)/);
      expect(Number(widthMatch?.[1])).toBeGreaterThanOrEqual(PLAN_TOC_MIN_WIDTH);
    });
  });

  describe("Migrated files removed", () => {
    for (const filename of MIGRATED_APP_STORIES) {
      test(`${filename} does not exist in src/browser/stories`, () => {
        expect(existsSync(`${STORY_DIR}/${filename}`)).toBe(false);
      });
    }
  });
});
