/** Full-app visual coverage for sub-agent progress and terminal report presentation. */

import { appMeta, AppWithMocks, PIXEL_DUAL_THEME, type AppStory } from "./meta.js";
import { setupSubagentFailureStory, setupSubagentReportStory } from "./helpers/subagentReportStory";

export default {
  ...appMeta,
  title: "App/SubagentReports/Desktop",
};

/** Incremental, completed legacy, and structured sub-agent report states. */
export const Preview: AppStory = {
  // Pixel owns this visual-only desktop matrix. The full App cold-start can exceed the
  // Storybook test-runner's 30-second smoke timeout before any assertions begin.
  tags: ["!test"],
  render: () => <AppWithMocks setup={setupSubagentReportStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  // Pixel captures the complete desktop composition. Production behavior is covered by
  // MessageRenderer.test.tsx because the full App can exceed the Storybook smoke-test budget.
};

export const Failures: AppStory = {
  ...Preview,
  render: () => <AppWithMocks setup={setupSubagentFailureStory} />,
};
