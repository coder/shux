import {
  setupWorkspace,
  shouldRunIntegrationTests,
  validateApiKeys,
  type TestEnvironment,
} from "./setup";
import { sendMessageWithModel, createEventCollector, assertStreamSuccess } from "./helpers";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY"]);
}

describeIntegration("OpenAI web_search integration tests", () => {
  // Enable retries in CI for flaky API tests
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(3, { logErrorsBeforeRetry: true });
  }

  test.concurrent(
    "should handle reasoning + web_search without itemId errors",
    async () => {
      // Setup test environment with OpenAI
      const { env, workspaceId, cleanup } = await setupWorkspace("openai");
      try {
        // This prompt reliably triggers the reasoning + web_search bug:
        // 1. Gold price search always triggers web_search (pricing data)
        // 2. Mathematical computation requires reasoning
        // 3. High reasoning effort ensures reasoning is present
        // This combination exposed the itemId bug on main branch
        const result = await sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Find the current gold price per ounce via web search. " +
            "Then compute round(price^2) and determine how many Collatz steps it takes to reach 1.",
          "openai",
          "gpt-5-codex",
          {
            thinkingLevel: "high", // Ensure reasoning is used
          }
        );

        // Verify the IPC call succeeded
        expect(result.success).toBe(true);

        // Collect and verify stream events
        const collector = createEventCollector(env.sentEvents, workspaceId);

        // Wait for stream to complete
        const streamEnd = await collector.waitForEvent("stream-end", 120000);
        expect(streamEnd).toBeDefined();

        // Verify no errors occurred - this is the KEY test
        // Before the fix, this would fail with:
        // "Item 'ws_...' of type 'web_search_call' was provided without its required 'reasoning' item"
        assertStreamSuccess(collector);

        // Collect all events and verify both reasoning and web_search occurred
        collector.collect();
        const events = collector.getEvents();

        // Verify we got reasoning (this is what triggers the bug)
        const hasReasoning = events.some((e) => "type" in e && e.type === "reasoning-delta");

        // Verify web_search was called
        const hasWebSearchCall = events.some(
          (e) =>
            "type" in e &&
            e.type === "tool-call-start" &&
            "toolName" in e &&
            e.toolName === "web_search"
        );

        // Both should be present for this test to be valid
        expect(hasReasoning).toBe(true);
        expect(hasWebSearchCall).toBe(true);

        // Verify we received text deltas (the assistant's final answer)
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    },
    150000 // 150 second timeout - reasoning + web_search + computation takes time
  );
});
