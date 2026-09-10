/**
 * Integration tests for the /<model> one-shot model override feature.
 *
 * Users can type "/<model> <message>" (e.g., "/haiku check the pr") to send
 * a single message with a different model without changing their preferences.
 */

import "../dom";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

describe("Model one-shot (/<model> message)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // Parametric test covering multiple model aliases - avoids duplication
  test.each([
    { alias: "haiku", expectedModelId: KNOWN_MODELS.HAIKU.id },
    { alias: "sonnet", expectedModelId: KNOWN_MODELS.SONNET.id },
  ])(
    "/$alias sends message with one-time model override",
    async ({ alias, expectedModelId }) => {
      const app = await createAppHarness({ branchPrefix: `model-oneshot-${alias}` });

      try {
        // Capture the model selector text before sending
        const modelSelectorBefore = await app.chat.getModelSelectorText();

        const testMessage = "check the pr status";
        await app.chat.send(`/${alias} ${testMessage}`);

        // Verify the message was sent and mock AI responded
        await app.chat.expectTranscriptContains(`Mock response: ${testMessage}`);
        await app.chat.expectInputValue("");

        // Verify the mock AI router received the correct model
        expect(
          app.env.services.aiService.mockAiStreamPlayer?.debugGetLastModel(app.workspaceId)
        ).toBe(expectedModelId);

        // Verify the ModelSelector UI didn't change (preference not persisted)
        const modelSelectorAfter = await app.chat.getModelSelectorText();
        expect(modelSelectorAfter).toBe(modelSelectorBefore);
      } finally {
        await app.dispose();
      }
    },
    60_000
  );

  test("just /<model> without message shows model-help", async () => {
    const app = await createAppHarness({ branchPrefix: "model-oneshot-noarg" });

    try {
      // Sending just "/haiku" without a message should behave like /model help
      await app.chat.send("/haiku");

      // Should show model command help (the toast shows "Model Command" and usage info)
      await app.chat.expectTranscriptContains("Model Command");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("preserves multiline message with /<model>", async () => {
    const app = await createAppHarness({ branchPrefix: "model-oneshot-multiline" });

    try {
      const line1 = "first line";
      const line2 = "second line";
      await app.chat.send(`/haiku ${line1}\n${line2}`);

      // Should include both lines in the response
      await app.chat.expectTranscriptContains(`Mock response: ${line1}`);
      await app.chat.expectTranscriptContains(line2);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("unknown model alias falls back to unknown-command error", async () => {
    const app = await createAppHarness({ branchPrefix: "model-oneshot-unknown" });

    try {
      // "/xyz" is not a known model or command
      await app.chat.send("/xyz do something");

      // Should show unknown command error
      await app.chat.expectTranscriptContains("Unknown command: /xyz");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
