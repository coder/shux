/** Phone-width visual coverage for sub-agent report presentation. */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  PhoneSubagentReportDecorator,
  setupSubagentReportStory,
  setupSubagentFailureStory,
} from "./helpers/subagentReportStory";

export default {
  ...appMeta,
  title: "App/SubagentReports/Phone",
};

export const Preview: AppStory = {
  // The fixed-width decorator + pinned Pixel phone viewport are the static breakpoint contract.
  // Production rendering behavior is covered by MessageRenderer.test.tsx.
  tags: ["!test"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={setupSubagentReportStory} />,
  decorators: [PhoneSubagentReportDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
};

export const Failures: AppStory = {
  ...Preview,
  render: () => <AppWithMocks setup={setupSubagentFailureStory} />,
};
