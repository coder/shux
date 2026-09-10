import { electronTest as test } from "../electronTest";
import { MOCK_REVIEW_PROMPTS } from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("review scenario", async ({ ui, page }) => {
  await ui.projects.openFirstWorkspace();
  await ui.chat.setMode("Plan");
  await ui.chat.setThinkingLevel(2);
  await ui.chat.sendMessage(MOCK_REVIEW_PROMPTS.SUMMARIZE_BRANCHES);
  await ui.chat.expectTranscriptContains("Here’s the current branch roster");

  await ui.chat.setMode("Exec");
  await ui.chat.setThinkingLevel(1);
  await ui.chat.sendMessage(MOCK_REVIEW_PROMPTS.OPEN_ONBOARDING_DOC);
  await ui.chat.expectActionButtonVisible("Edit");
  await ui.chat.expectTranscriptContains("ENOENT: docs/onboarding.md not found");

  await ui.chat.clickActionButton("Edit");
  await ui.chat.sendMessage(MOCK_REVIEW_PROMPTS.SHOW_ONBOARDING_DOC);
  await ui.chat.expectTranscriptContains("Found it. Here’s the quick-start summary:");
  await ui.chat.expectTurnSettled();

  await ui.chat.sendMessage("/clear");
  // Confirm the destructive action in the modal
  await page.getByRole("button", { name: "Clear" }).click();
  await ui.chat.expectStatusMessageContains("Chat history cleared");

  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.selectTab("Review");
  await ui.metaSidebar.selectTab("Stats");
});
