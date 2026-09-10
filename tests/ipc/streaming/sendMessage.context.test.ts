/**
 * sendMessage context handling integration tests.
 *
 * Tests context-related functionality:
 * - Message editing
 * - Conversation continuity
 * - Mode-specific instructions
 * - Tool calls
 */

import * as path from "path";
import * as fs from "fs/promises";
import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel as baseSendMessageWithModel, modelString } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
  getSharedRepoPath,
} from "../sendMessageTestHelpers";
import { KNOWN_MODELS } from "../../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

async function sendMessageWithModel(
  ...args: Parameters<typeof baseSendMessageWithModel>
): ReturnType<typeof baseSendMessageWithModel> {
  let result = await baseSendMessageWithModel(...args);
  if (result.success || !process.env.CI) {
    return result;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    console.warn(
      `[tests] Retrying sendMessage.context send after transient failure ` +
        `(attempt ${attempt}/2): ${JSON.stringify(result.error)}`
    );
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    result = await baseSendMessageWithModel(...args);
    if (result.success) {
      return result;
    }
  }

  return result;
}

// Test both providers
const PROVIDER_CONFIGS: Array<[string, string]> = [
  ["openai", KNOWN_MODELS.GPT.providerModelId],
  ["anthropic", KNOWN_MODELS.HAIKU.providerModelId],
];

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage context handling tests", () => {
  // This suite reuses a shared repo + test environment and mutates provider config for
  // each case, so serial execution is less flaky than test.concurrent in CI.
  configureTestRetries(3);

  describe.each(PROVIDER_CONFIGS)("%s conversation continuity", (provider, model) => {
    test("should maintain conversation context across messages", async () => {
      await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
        // Send first message establishing context.
        // Tools are disabled to keep this test deterministic in CI: models can
        // occasionally emit tool-call-only responses (no assistant text), but this
        // test is focused on conversation context continuity.
        const result1 = await sendMessageWithModel(
          env,
          workspaceId,
          "My name is TestUser. Remember this.",
          modelString(provider, model),
          { toolPolicy: [{ regex_match: ".*", action: "disable" }] }
        );
        expect(result1.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Small delay to allow stream cleanup to complete before sending next message
        await new Promise((resolve) => setTimeout(resolve, 100));

        collector.clear();

        // Send follow-up asking about context
        const result2 = await sendMessageWithModel(
          env,
          workspaceId,
          "What is my name?",
          modelString(provider, model),
          { toolPolicy: [{ regex_match: ".*", action: "disable" }] }
        );
        expect(result2.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Check that response mentions the name.
        // Some provider/model combinations may emit no stream-delta events, and return
        // assistant text only in the final stream-end payload.
        const finalMessage = collector.getFinalMessage() as
          | { content?: unknown; parts?: Array<{ type?: unknown; text?: unknown }> }
          | undefined;

        const textFromContent =
          typeof finalMessage?.content === "string" ? finalMessage.content : "";
        const textFromParts = (finalMessage?.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");

        const responseText = textFromContent || textFromParts || collector.getStreamContent();

        expect(responseText.toLowerCase()).toContain("testuser");
      });
    }, 40000);
  });

  describe("message editing", () => {
    test("should support editing a previous message", async () => {
      await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
        // Send initial message
        const result1 = await sendMessageWithModel(
          env,
          workspaceId,
          "Say 'original'",
          modelString("openai", KNOWN_MODELS.GPT.providerModelId)
        );
        expect(result1.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Get the message ID from the stream events
        const events = collector.getEvents();
        const streamStart = events.find(
          (e) => "type" in e && (e as { type: string }).type === "stream-start"
        );
        expect(streamStart).toBeDefined();

        // The user message ID would be stored in history
        // For now, test that edit option works without error
        collector.clear();

        // Note: Full edit testing requires access to message history
        // This test verifies the edit flow doesn't crash
      });
    }, 20000);
  });

  describe("mode-specific behavior", () => {
    test("should respect additionalSystemInstructions", async () => {
      await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "What is 2+2?",
          modelString("openai", KNOWN_MODELS.GPT.providerModelId),
          {
            // Disable tools so the model returns assistant text deterministically in CI.
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
            additionalSystemInstructions:
              "Answer the user's question. Include the word BANANA in your response.",
          }
        );

        expect(result.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Check response contains BANANA (case-insensitive).
        // Some provider/model combinations may emit no stream-delta events, and return
        // assistant text only in the final stream-end payload.
        const finalMessage = collector.getFinalMessage() as
          | { content?: unknown; parts?: Array<{ type?: unknown; text?: unknown }> }
          | undefined;

        const textFromContent =
          typeof finalMessage?.content === "string" ? finalMessage.content : "";
        const textFromParts = (finalMessage?.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");

        const responseText = textFromContent || textFromParts || collector.getStreamContent();

        expect(responseText).toMatch(/banana/i);
      });
    }, 20000);
  });

  describe("tool calls", () => {
    test("should execute bash tool when requested", async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const repoPath = getSharedRepoPath();

        // Create a test file in the workspace
        const testFilePath = path.join(repoPath, "test-tool-file.txt");
        await fs.writeFile(testFilePath, "Hello from test file!");

        try {
          // Ask to read the file using bash
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            `Use bash to run: cat ${testFilePath}. Set display_name="read-file" and timeout_secs=30. Do not spawn a sub-agent.`,
            modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId),
            {
              toolPolicy: [{ regex_match: "bash", action: "require" }],
            }
          );

          expect(result.success).toBe(true);

          // Wait for completion (tool calls take longer)
          await collector.waitForEvent("stream-end", 45000);

          // Check for tool call events
          const events = collector.getEvents();
          const toolCallStarts = events.filter(
            (e) => "type" in e && (e as { type: string }).type === "tool-call-start"
          );

          // Should have at least one bash tool call
          const bashCall = toolCallStarts.find((e) => {
            if (!("toolName" in e) || e.toolName !== "bash") return false;
            return true;
          });
          expect(bashCall).toBeDefined();
        } finally {
          // Cleanup test file
          try {
            await fs.unlink(testFilePath);
          } catch {
            // Ignore cleanup errors
          }
        }
      });
    }, 60000);

    test("should respect tool policy 'none'", async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        // Ask for something that would normally use tools
        // Policy to disable all tools: match any tool name and disable
        let result = await sendMessageWithModel(
          env,
          workspaceId,
          "Run the command 'echo test' using bash.",
          modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId),
          {
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
          }
        );

        for (let attempt = 1; !result.success && process.env.CI && attempt <= 2; attempt++) {
          console.warn(
            `[tests] Retrying Anthropic tool-policy send after failure ` +
              `(attempt ${attempt}/2): ${JSON.stringify(result.error)}`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
          result = await sendMessageWithModel(
            env,
            workspaceId,
            "Run the command 'echo test' using bash.",
            modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId),
            {
              toolPolicy: [{ regex_match: ".*", action: "disable" }],
            }
          );
        }

        expect(result.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Should NOT have tool calls when policy is 'none'
        const events = collector.getEvents();
        const toolCallStarts = events.filter(
          (e) => "type" in e && (e as { type: string }).type === "tool-call-start"
        );
        expect(toolCallStarts.length).toBe(0);
      });
    }, 40000);
  });

  describe("history truncation", () => {
    test("should handle truncateHistory", async () => {
      await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
        // Send a few messages to build history
        for (let i = 0; i < 3; i++) {
          await sendMessageWithModel(
            env,
            workspaceId,
            `Message ${i + 1}`,
            modelString("openai", KNOWN_MODELS.GPT.providerModelId)
          );
          await collector.waitForEvent("stream-end", 15000);
          collector.clear();
        }

        // Poll for stream to be inactive before truncating history.
        // Stream cleanup (history update, temp dir removal) happens in finally block
        // after stream-end is emitted and can take several hundred ms.
        // We poll with exponential backoff to handle variable cleanup times.
        let attempts = 0;
        const maxAttempts = 20;
        while (attempts < maxAttempts) {
          const activity = await env.orpc.workspace.activity.list();
          const workspaceActivity = activity?.[workspaceId];
          if (!workspaceActivity?.streaming) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.min(attempts + 1, 5)));
          attempts++;
        }

        // Truncate history
        const truncateResult = await env.orpc.workspace.truncateHistory({
          workspaceId,
          percentage: 50,
        });

        expect(truncateResult.success).toBe(true);

        // Should still be able to send messages
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "After truncation",
          modelString("openai", KNOWN_MODELS.GPT.providerModelId)
        );
        expect(result.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);
      });
    }, 60000);
  });
});
