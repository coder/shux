import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";
import {
  sendMessageWithModel,
  sendMessage,
  createStreamCollector,
  waitFor,
  TEST_IMAGES,
  modelString,
  resolveOrpcClient,
  StreamCollector,
  configureTestRetries,
  HAIKU_MODEL,
} from "../helpers";
import { isQueuedMessageChanged, isRestoreToInput } from "@/common/orpc/types";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

// Type aliases for queued message events (extracted from schema union)
type QueuedMessageChangedEvent = Extract<WorkspaceChatMessage, { type: "queued-message-changed" }>;
type RestoreToInputEvent = Extract<WorkspaceChatMessage, { type: "restore-to-input" }>;

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Helper: Latest queued-message-changed state observed by the collector.
function getQueuedMessages(collector: StreamCollector): string[] {
  const queuedEvents = collector.getEvents().filter(isQueuedMessageChanged);
  const latest = queuedEvents[queuedEvents.length - 1];
  return latest ? latest.queuedMessages : [];
}

// Helper: Wait until a queued-message-changed event matching `predicate` exists
// anywhere in the collector history. Scanning history (instead of waiting for
// "the next new event" past a count snapshot) is required for determinism:
// oRPC >=1.14 can deliver the queued event before the sendMessage promise
// resolves, so a count snapshot taken after the send already includes it and a
// new-event wait then observes the later queue-drain event instead (#4023).
async function waitForQueuedMessageEvent(
  collector: StreamCollector,
  predicate: (event: QueuedMessageChangedEvent) => boolean,
  timeoutMs = 5000
): Promise<QueuedMessageChangedEvent | null> {
  const startTime = Date.now();
  for (;;) {
    const match = collector.getEvents().filter(isQueuedMessageChanged).find(predicate);
    if (match) return match;
    if (Date.now() - startTime >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Helper: Wait until the LATEST queued-message-changed event shows an empty,
// part-free queue (the post-drain state). Latest-state convergence is safe for
// drain waits because these tests never re-queue after draining; requiring
// empty fileParts distinguishes the drain event from an image-only queued
// event (which also has empty queuedMessages).
async function waitForQueueDrained(
  collector: StreamCollector,
  timeoutMs = 5000
): Promise<QueuedMessageChangedEvent | null> {
  const startTime = Date.now();
  for (;;) {
    const queuedEvents = collector.getEvents().filter(isQueuedMessageChanged);
    const latest = queuedEvents[queuedEvents.length - 1];
    if (latest && latest.queuedMessages.length === 0 && (latest.fileParts ?? []).length === 0) {
      return latest;
    }
    if (Date.now() - startTime >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Helper: Wait for restore-to-input event
async function waitForRestoreToInputEvent(
  collector: StreamCollector,
  timeoutMs = 5000
): Promise<RestoreToInputEvent | null> {
  const event = await collector.waitForEvent("restore-to-input", timeoutMs);
  if (!event || !isRestoreToInput(event)) {
    return null;
  }
  return event;
}

describeIntegration("Queued messages", () => {
  // Enable retries in CI for flaky API tests
  configureTestRetries(3);

  test.concurrent(
    "should queue message during streaming and auto-send on stream end",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start initial stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a message while streaming
        const queueResult = await sendMessageWithModel(
          env,
          workspaceId,
          "Say 'SECOND' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(queueResult.success).toBe(true);

        // Verify message was queued (not sent directly)
        const queuedEvent = await waitForQueuedMessageEvent(collector1, (e) =>
          e.queuedMessages.includes("Say 'SECOND' and nothing else")
        );
        expect(queuedEvent).not.toBeNull();
        expect(queuedEvent?.queuedMessages).toEqual(["Say 'SECOND' and nothing else"]);
        expect(queuedEvent?.displayText).toBe("Say 'SECOND' and nothing else");

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared (happens before auto-send starts new stream)
        // The sendQueuedMessages() clears queue and emits event before sending
        const clearEvent = await waitForQueueDrained(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send to emit second user message (happens async after stream-end)
        // The second stream starts after auto-send - wait for the second stream-start
        await collector1.waitForEvent("stream-start", 5000);

        // Wait for second stream to complete
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty (check current state)
        expect(getQueuedMessages(collector1)).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should restore queued message to input on stream abort",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Count to 10 slowly",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForEvent("stream-start", 5000);

        // Queue a message
        await sendMessageWithModel(
          env,
          workspaceId,
          "This message should be restored",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Verify message was queued
        const queuedEvent = await waitForQueuedMessageEvent(collector, (e) =>
          e.queuedMessages.includes("This message should be restored")
        );
        expect(queuedEvent?.queuedMessages).toEqual(["This message should be restored"]);

        // Interrupt the stream
        const client = resolveOrpcClient(env);
        const interruptResult = await client.workspace.interruptStream({ workspaceId });
        expect(interruptResult.success).toBe(true);

        // Wait for stream abort
        await collector.waitForEvent("stream-abort", 5000);

        // Wait for queue to be cleared (may arrive before or with stream-abort)
        const clearEvent = await waitForQueueDrained(collector, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for restore-to-input event
        const restoreEvent = await waitForRestoreToInputEvent(collector);
        expect(restoreEvent).toBeDefined();
        expect(restoreEvent?.text).toBe("This message should be restored");
        expect(restoreEvent?.workspaceId).toBe(workspaceId);

        // Verify queue is still empty
        expect(getQueuedMessages(collector)).toEqual([]);
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000 // Increased timeout for abort handling
  );

  test.concurrent(
    "should send queued message immediately when sendQueuedImmediately is true",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start collector first and wait for subscription to avoid replay/live
        // event duplication of the user message (same race as resumeStream fix).
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription(5000);

        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Count to 10 slowly",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        await collector.waitForEvent("stream-start", 5000);

        // Queue a message
        await sendMessageWithModel(
          env,
          workspaceId,
          "This message should be sent immediately",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Verify message was queued
        const queuedEvent = await waitForQueuedMessageEvent(collector, (e) =>
          e.queuedMessages.includes("This message should be sent immediately")
        );
        expect(queuedEvent?.queuedMessages).toEqual(["This message should be sent immediately"]);

        // Interrupt the stream with sendQueuedImmediately flag
        const client = resolveOrpcClient(env);
        const interruptResult = await client.workspace.interruptStream({
          workspaceId,
          options: { sendQueuedImmediately: true },
        });
        expect(interruptResult.success).toBe(true);

        // Wait for stream abort
        await collector.waitForEvent("stream-abort", 5000);

        // Should NOT get restore-to-input event (message is sent, not restored)
        // Instead, we should see the queued message being sent as a new user message
        const autoSendHappened = await waitFor(() => {
          const userMessages = collector
            .getEvents()
            .filter((e) => "role" in e && e.role === "user");
          return userMessages.length === 2; // First + immediately sent
        }, 5000);
        expect(autoSendHappened).toBe(true);

        // Verify queue was cleared
        expect(getQueuedMessages(collector)).toEqual([]);

        // Wait for the immediately-sent message's stream to start and complete
        await collector.waitForEvent("stream-start", 5000);
        await collector.waitForEvent("stream-end", 15000);
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should combine multiple queued messages with newline separator",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start collector first and wait for subscription to avoid replay/live
        // event duplication of the user message (same race as resumeStream fix).
        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForSubscription(5000);

        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        await collector1.waitForEvent("stream-start", 5000);

        // Queue multiple messages, waiting for each queued-message-changed event
        await sendMessage(env, workspaceId, "Message 1");
        await waitForQueuedMessageEvent(collector1, (e) => e.queuedMessages.includes("Message 1"));

        await sendMessage(env, workspaceId, "Message 2");
        await waitForQueuedMessageEvent(collector1, (e) => e.queuedMessages.includes("Message 2"));

        await sendMessage(env, workspaceId, "Message 3");

        // Verify all messages queued
        const allQueued = await waitForQueuedMessageEvent(
          collector1,
          (e) => e.queuedMessages.length === 3
        );
        expect(allQueued?.queuedMessages).toEqual(["Message 1", "Message 2", "Message 3"]);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for the SECOND stream-start (auto-send creates a new stream)
        await collector1.waitForEventN("stream-start", 2, 10000);

        const userMessages = collector1
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "role" in e && e.role === "user");
        expect(userMessages.length).toBe(2); // First message + auto-sent combined message
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    45000 // Increased timeout for multiple messages
  );

  test.concurrent(
    "should auto-send queued message with images",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue message with image
        await sendMessage(env, workspaceId, "Describe this image", {
          model: "anthropic:claude-sonnet-4-5",
          fileParts: [TEST_IMAGES.RED_PIXEL],
        });

        // Verify queued with image
        const queuedEvent = await waitForQueuedMessageEvent(collector1, (e) =>
          e.queuedMessages.includes("Describe this image")
        );
        expect(queuedEvent?.queuedMessages).toEqual(["Describe this image"]);
        expect(queuedEvent?.fileParts).toHaveLength(1);
        expect(queuedEvent?.fileParts?.[0]).toMatchObject(TEST_IMAGES.RED_PIXEL);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared
        const clearEvent = await waitForQueueDrained(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty
        expect(getQueuedMessages(collector1)).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should handle image-only queued message",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue image-only message (empty text)
        await sendMessage(env, workspaceId, "", {
          model: "anthropic:claude-sonnet-4-5",
          fileParts: [TEST_IMAGES.RED_PIXEL],
        });

        // Verify queued (no text messages, but has image)
        const queuedEvent = await waitForQueuedMessageEvent(
          collector1,
          (e) => (e.fileParts ?? []).length > 0
        );
        expect(queuedEvent?.queuedMessages).toEqual([]);
        expect(queuedEvent?.displayText).toBe("");
        expect(queuedEvent?.fileParts).toHaveLength(1);

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue was cleared after auto-send
        expect(getQueuedMessages(collector1)).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should preserve latest options when queueing",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue messages with different options
        await sendMessage(env, workspaceId, "Message 1", {
          model: HAIKU_MODEL,
          thinkingLevel: "off",
        });
        await sendMessage(env, workspaceId, "Message 2", {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        });

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for auto-send stream to start (verifies the second stream began)
        const streamStart = await collector1.waitForEvent("stream-start", 5000);
        if (streamStart && "model" in streamStart) {
          expect(streamStart.model).toContain("claude-sonnet-4-5");
        }

        await collector1.waitForEvent("stream-end", 15000);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should preserve compaction metadata when queueing",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Say 'FIRST' and nothing else",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        const collector1 = createStreamCollector(env.orpc, workspaceId);
        collector1.start();
        await collector1.waitForEvent("stream-start", 5000);

        // Queue a compaction request
        const compactionMetadata = {
          type: "compaction-request" as const,
          rawCommand: "/compact -t 3000",
          parsed: { maxOutputTokens: 3000 },
        };

        await sendMessage(env, workspaceId, "Summarize this conversation into a compact form...", {
          model: "anthropic:claude-sonnet-4-5",
          muxMetadata: compactionMetadata,
        });

        // Wait for queued-message-changed event
        const queuedEvent = await waitForQueuedMessageEvent(
          collector1,
          (e) => e.displayText === "/compact -t 3000"
        );
        expect(queuedEvent).not.toBeNull();

        // Wait for first stream to complete (this triggers auto-send)
        await collector1.waitForEvent("stream-end", 15000);

        // Wait for queue to be cleared
        const clearEvent = await waitForQueueDrained(collector1, 5000);
        expect(clearEvent?.queuedMessages).toEqual([]);

        // Wait for auto-send stream to start and complete
        await collector1.waitForEvent("stream-start", 5000);
        await collector1.waitForEvent("stream-end", 15000);

        // Verify queue is still empty
        expect(getQueuedMessages(collector1)).toEqual([]);
        collector1.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );
});
