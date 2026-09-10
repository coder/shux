import path from "path";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import { profileChatInputTyping } from "../utils/chatInputPerf";
import { seedWorkspaceHistoryProfile } from "../utils/historyFixture";

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";

const TYPING_SAMPLE =
  "Diagnose typing latency in a large chat transcript while keeping input responsive.";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("chat typing performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: type in composer with large chat history", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    const historySummary = await seedWorkspaceHistoryProfile({
      demoProject: workspace.demoProject,
      profile: "large",
    });

    await ui.projects.openFirstWorkspace();
    await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
      timeout: 20_000,
    });

    const input = page.getByRole("textbox", { name: "Message Claude" });
    await input.fill("");

    const { chromeProfile, reactProfile } = await profileChatInputTyping({
      page,
      testInfo,
      runLabel: "chat-typing-large-history",
      sample: TYPING_SAMPLE,
      input,
      historyProfile: historySummary,
    });

    // The composer owns draft text locally; typing must not re-render the large transcript.
    expect(reactProfile.byProfilerId["chat-pane.transcript"]?.sampleCount ?? 0).toBe(0);
    expect(chromeProfile.wallTimeMs).toBeLessThan(2_500);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfile.enabled).toBe(true);
  });

  test("perf: type in the New Workspace composer", async ({ page, workspace }, testInfo) => {
    const projectName = path.basename(workspace.demoProject.projectPath);
    await page.getByRole("button", { name: `Create workspace in ${projectName}` }).click();

    const input = page.getByRole("textbox", { name: "Message Claude" });
    await expect(input).toBeVisible({ timeout: 20_000 });

    // Creation initializes branches, runtime availability, Coder status, and auto-naming
    // independently. Let those legitimate commits settle before resetting profiler samples.
    await expect(page.getByRole("combobox", { name: "Workspace type" })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Select source branch" })).toBeEnabled();
    const autoNamingButton = page.getByRole("button", { name: "Disable auto-naming" });
    await expect(autoNamingButton).toBeVisible();
    await autoNamingButton.click();
    await expect(page.getByRole("button", { name: "Enable auto-naming" })).toBeVisible();

    // Make the draft non-empty before sampling. Subsequent typing should update
    // the input without rerendering static creation controls.
    await input.fill("D");

    const { chromeProfile, reactProfile } = await profileChatInputTyping({
      page,
      testInfo,
      runLabel: "chat-typing-new-workspace",
      sample: TYPING_SAMPLE.slice(1),
      input,
      initialValue: "D",
    });

    // A late initialization commit may land at the profiling boundary, but the
    // control tree must stay independent from the per-character draft updates.
    expect(
      reactProfile.byProfilerId["chat-input.creation-controls"]?.sampleCount ?? 0
    ).toBeLessThanOrEqual(1);
    expect(chromeProfile.wallTimeMs).toBeLessThan(2_500);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfile.enabled).toBe(true);
  });
});
