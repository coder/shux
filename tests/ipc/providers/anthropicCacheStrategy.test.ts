import { setupWorkspace, shouldRunIntegrationTests } from "../setup";
import { sendMessageWithModel, createStreamCollector, HAIKU_MODEL } from "../helpers";

// Skip tests unless TEST_INTEGRATION=1 AND required API keys are present
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const shouldRunSuite = shouldRunIntegrationTests() && hasAnthropicKey;
const describeIntegration = shouldRunSuite ? describe : describe.skip;
// 120s total for setup + 2 live messages: 45s was calibrated for an idle machine, but
// CI runners under merge-queue load inflate wall clock enough that it was exceeded
// while sibling suites passed at 100s+ (merge-queue run 32665306160). Peer provider
// tests already budget 45-150s per live call.
const TEST_TIMEOUT_MS = 120000;

if (shouldRunIntegrationTests() && !shouldRunSuite) {
  // eslint-disable-next-line no-console
  console.warn("Skipping Anthropic cache strategy integration tests: missing ANTHROPIC_API_KEY");
}

describeIntegration("Anthropic cache strategy integration", () => {
  test(
    "should apply cache control to messages, system prompt, and tools for Anthropic models",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        const model = HAIKU_MODEL;

        // Send an initial message to establish conversation history
        const firstMessage = "Hello, can you help me with a coding task?";

        const firstCollector = createStreamCollector(env.orpc, workspaceId);
        firstCollector.start();
        await firstCollector.waitForSubscription();

        await sendMessageWithModel(env, workspaceId, firstMessage, model, {
          additionalSystemInstructions: "Be concise and clear in your responses.",
          thinkingLevel: "off",
        });

        // Pass the suite budget: waitForEvent resolves null on timeout instead of
        // throwing, so a shorter inner wait would silently null the end event and
        // fail the toBeDefined assertions below with no useful diagnostics.
        await firstCollector.waitForEvent("stream-end", TEST_TIMEOUT_MS);
        firstCollector.stop();

        // Send a second message to test cache reuse
        const secondMessage = "What's the best way to handle errors in TypeScript?";

        const secondCollector = createStreamCollector(env.orpc, workspaceId);
        secondCollector.start();
        await secondCollector.waitForSubscription();

        await sendMessageWithModel(env, workspaceId, secondMessage, model, {
          additionalSystemInstructions: "Be concise and clear in your responses.",
          thinkingLevel: "off",
        });

        await secondCollector.waitForEvent("stream-end", TEST_TIMEOUT_MS);
        secondCollector.stop();

        // Check that both streams completed successfully
        const firstEndEvent = firstCollector
          .getEvents()
          .find((e: { type?: string }) => e.type === "stream-end");
        const secondEndEvent = secondCollector
          .getEvents()
          .find((e: { type?: string }) => e.type === "stream-end");
        expect(firstEndEvent).toBeDefined();
        expect(secondEndEvent).toBeDefined();

        // Verify cache control is being applied by checking the messages sent to the model
        // Cache control adds cache_control markers to messages, system, and tools
        // If usage data is available from the API, verify it; otherwise just ensure requests succeeded
        const firstUsage = (firstEndEvent as { metadata?: { usage?: unknown } })?.metadata?.usage;
        const firstProviderMetadata = (
          firstEndEvent as {
            metadata?: { providerMetadata?: { anthropic?: { cacheCreationInputTokens?: number } } };
          }
        )?.metadata?.providerMetadata?.anthropic;

        // Verify cache creation - this proves our cache strategy is working
        // We only check cache creation, not usage, because:
        // 1. Cache has a warmup period (~5 min) before it can be read
        // 2. What matters is that we're sending cache control headers correctly
        // 3. If cache creation is happening, the strategy is working
        const hasCacheCreation =
          firstProviderMetadata?.cacheCreationInputTokens !== undefined &&
          firstProviderMetadata.cacheCreationInputTokens > 0;

        if (hasCacheCreation) {
          // Success: Cache control headers are working
          expect(firstProviderMetadata.cacheCreationInputTokens).toBeGreaterThan(0);
          console.log(
            `✓ Cache creation working: ${firstProviderMetadata.cacheCreationInputTokens} tokens cached`
          );
        } else if (firstUsage && Object.keys(firstUsage as object).length > 0) {
          // API returned usage data but no cache creation
          // This shouldn't happen if cache control is working properly
          throw new Error(
            "Expected cache creation but got 0 tokens. Cache control may not be working."
          );
        } else {
          // No usage data from API (e.g., custom bridge that doesn't report metrics)
          // Just ensure both requests completed successfully
          console.log("Note: API did not return usage data. Skipping cache metrics verification.");
          console.log("Test passes - both messages completed successfully.");
        }
      } finally {
        await cleanup();
      }
    },
    TEST_TIMEOUT_MS
  );
});
