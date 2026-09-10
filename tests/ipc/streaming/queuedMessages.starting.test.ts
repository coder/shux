import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  sendMessageWithModel,
  waitFor,
  HAIKU_MODEL,
  createStreamCollector,
} from "../helpers";
import { isMuxMessage } from "@/common/orpc/types";
import { buildMockStreamStartGateMessage } from "@/node/services/mock/mockAiRouter";

describe("Queued messages during stream start", () => {
  let env: TestEnvironment | null = null;
  let repoPath: string | null = null;

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();

    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = null;
    }
    if (env) {
      await cleanupTestEnvironment(env);
      env = null;
    }
  });

  test("queues follow-up message sent before stream-start and auto-sends after first stream", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-starting-queue");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    let reconnectCollector: ReturnType<typeof createStreamCollector> | null = null;

    try {
      await collector.waitForSubscription(5000);

      const gatedMessage = buildMockStreamStartGateMessage("First message");
      const aiService = env.services.aiService;
      const session = env.services.workspaceService.getOrCreateSession(workspaceId);
      const firstSendPromise = sendMessageWithModel(env, workspaceId, gatedMessage, HAIKU_MODEL);
      let firstSendResolved = false;
      void firstSendPromise.then(() => {
        firstSendResolved = true;
      });

      const sawFirstUserMessage = await waitFor(() => {
        return collector
          .getEvents()
          .some(
            (event) =>
              isMuxMessage(event) &&
              event.role === "user" &&
              event.parts.some((part) => "text" in part && part.text === gatedMessage)
          );
      }, 5000);
      if (!sawFirstUserMessage) {
        throw new Error("First user message was not emitted before mock stream start gate");
      }

      const sawStartingWindow = await waitFor(() => {
        return session.isPreparingTurn() && !aiService.isStreaming(workspaceId);
      }, 5000);
      if (!sawStartingWindow) {
        throw new Error("Stream never entered starting window before follow-up could queue");
      }

      reconnectCollector = createStreamCollector(env.orpc, workspaceId);
      reconnectCollector.start();
      await reconnectCollector.waitForSubscription(5000);

      const sawPreparingLifecycleOnReplay = reconnectCollector
        .getEvents()
        .some(
          (event) =>
            "type" in event &&
            event.type === "stream-lifecycle" &&
            event.phase === "preparing" &&
            event.hadAnyOutput === false
        );
      expect(sawPreparingLifecycleOnReplay).toBe(true);

      const sawStreamStartEarly = collector
        .getEvents()
        .some((event) => "type" in event && event.type === "stream-start");
      if (firstSendResolved) {
        throw new Error("First send resolved before follow-up could queue");
      }

      if (sawStreamStartEarly) {
        throw new Error("Stream started before follow-up was queued; mock gate released early");
      }

      const secondSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Second message",
        HAIKU_MODEL
      );

      aiService.releaseMockStreamStartGate(workspaceId);
      expect(secondSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 15000);
      await collector.waitForEvent("stream-end", 15000);

      const sawSecondStreamStart = await waitFor(() => {
        const streamStarts = collector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-start");
        return streamStarts.length >= 2;
      }, 15000);
      if (!sawSecondStreamStart) {
        throw new Error("Second stream never started after queued message release");
      }

      const prompt = aiService.mockAiStreamPlayer?.debugGetLastPrompt(workspaceId);
      if (!prompt) throw new Error("Mock prompt snapshot missing after queued stream start");
      const promptUserMessages = prompt
        .filter((message) => message.role === "user")
        .map((message) =>
          message.parts
            .filter((part) => "text" in part)
            .map((part) => part.text)
            .join("")
        );
      expect(promptUserMessages).toEqual(expect.arrayContaining([gatedMessage, "Second message"]));

      const sawSecondStreamEnd = await waitFor(() => {
        const streamEnds = collector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-end");
        return streamEnds.length >= 2;
      }, 15000);
      const timestampedEvents = collector.getTimestampedEvents();
      const streamStarts = timestampedEvents.filter(
        (entry) => "type" in entry.event && entry.event.type === "stream-start"
      );
      const streamEnds = timestampedEvents.filter(
        (entry) => "type" in entry.event && entry.event.type === "stream-end"
      );
      if (streamStarts.length >= 2 && streamEnds.length >= 1) {
        const secondStartTime = streamStarts[1].arrivedAt;
        const firstEndTime = streamEnds[0].arrivedAt;
        if (secondStartTime < firstEndTime) {
          throw new Error("Second stream started before the first stream ended");
        }
      }

      if (!sawSecondStreamEnd) {
        throw new Error("Second stream never finished after queued message release");
      }

      const userMessages = collector
        .getEvents()
        .filter(isMuxMessage)
        .filter((event) => event.role === "user")
        .map((event) =>
          event.parts
            .filter((part) => "text" in part)
            .map((part) => part.text)
            .join("")
        );
      expect(userMessages).toEqual(expect.arrayContaining([gatedMessage, "Second message"]));

      const firstSendResult = await firstSendPromise;
      expect(firstSendResult.success).toBe(true);
    } finally {
      reconnectCollector?.stop();
      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 35000);
});
