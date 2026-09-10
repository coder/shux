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
import {
  isMuxMessage,
  isQueuedMessageChanged,
  isRestoreToInput,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import type { HistoryService } from "@/node/services/historyService";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

type QueuedMessageChangedEvent = Extract<WorkspaceChatMessage, { type: "queued-message-changed" }>;

function findQueuedMessageEvent(
  collector: ReturnType<typeof createStreamCollector>,
  queuedText: string
): QueuedMessageChangedEvent | undefined {
  return collector
    .getEvents()
    .find(
      (event): event is QueuedMessageChangedEvent =>
        isQueuedMessageChanged(event) && event.queuedMessages.includes(queuedText)
    );
}

describe("Queued messages during stream completion", () => {
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

  test("isBusy returns true during COMPLETING phase", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-busy");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);
    const aiService = env.services.aiService;

    // Create a deterministic COMPLETING window by gating the async stream-end handler
    // (AgentSession awaits CompactionHandler.handleCompletion before it can go idle).
    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);

      // Wait until the session is inside the stream-end cleanup window.
      await enteredCompletion.promise;

      // Regression: session should still be busy (COMPLETING) even though the AI service
      // is no longer streaming.
      expect(aiService.isStreaming(workspaceId)).toBe(false);
      expect(session.isBusy()).toBe(true);
      expect(session.isPreparingTurn()).toBe(false);

      releaseCompletion.resolve();
      await session.waitForIdle();
      expect(session.isBusy()).toBe(false);
    } finally {
      // Ensure we never leave the completion handler blocked (otherwise workspace.remove can hang).
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);

  test("waitForIdle blocks while in COMPLETING phase", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-idle");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);

    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);

      await enteredCompletion.promise;

      expect(session.isBusy()).toBe(true);

      const waitForIdlePromise = session.waitForIdle();

      const winner = await Promise.race([
        waitForIdlePromise.then(() => "idle" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]);

      expect(winner).toBe("timeout");

      releaseCompletion.resolve();
      await waitForIdlePromise;
      expect(session.isBusy()).toBe(false);
    } finally {
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);
  test("queues message sent during COMPLETING and auto-sends after completion finishes", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-queue");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);
    const aiService = env.services.aiService;

    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);

      // Hold the session in COMPLETING.
      await enteredCompletion.promise;
      expect(aiService.isStreaming(workspaceId)).toBe(false);
      expect(session.isBusy()).toBe(true);

      // Send a follow-up message through the *real* IPC path.
      const secondSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Second message",
        HAIKU_MODEL
      );
      expect(secondSendResult.success).toBe(true);

      let queuedEvent = findQueuedMessageEvent(collector, "Second message");
      const sawQueuedSecondMessage =
        queuedEvent !== undefined
          ? true
          : await waitFor(() => {
              queuedEvent = findQueuedMessageEvent(collector, "Second message");
              return queuedEvent !== undefined;
            }, 5000);
      if (!sawQueuedSecondMessage || !queuedEvent) {
        throw new Error("Queued message event missing after follow-up send during completion");
      }
      expect(queuedEvent.queuedMessages).toEqual(["Second message"]);
      expect(queuedEvent.displayText).toBe("Second message");

      // Regression: the queued message must NOT start a new stream until completion finishes.
      const startedSecondEarly = await waitFor(() => {
        const streamStarts = collector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-start");
        return streamStarts.length >= 2;
      }, 250);
      expect(startedSecondEarly).toBe(false);

      releaseCompletion.resolve();

      const firstStreamEnd = await collector.waitForEvent("stream-end", 15000);
      if (!firstStreamEnd) {
        throw new Error("First stream never ended after releasing completion");
      }

      const sawSecondStreamStart = await waitFor(() => {
        const streamStarts = collector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-start");
        return streamStarts.length >= 2;
      }, 15000);
      if (!sawSecondStreamStart) {
        throw new Error("Second stream never started after completion finished");
      }

      const sawSecondStreamEnd = await waitFor(() => {
        const streamEnds = collector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-end");
        return streamEnds.length >= 2;
      }, 15000);
      if (!sawSecondStreamEnd) {
        throw new Error("Second stream never finished after completion finished");
      }

      // Verify the queued message made it into the second stream prompt.
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
      expect(promptUserMessages).toEqual(expect.arrayContaining(["Second message"]));
    } finally {
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);

  test("edit waits for completion cleanup before truncating history", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-edit");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);

    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    type WorkspaceServiceInternals = {
      historyService: HistoryService;
    };
    const historyService = (env.services.workspaceService as unknown as WorkspaceServiceInternals)
      .historyService;
    const truncateSpy = jest.spyOn(historyService, "truncateAfterMessage");

    try {
      await collector.waitForSubscription(5000);

      const firstMessageText = "First message";
      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        firstMessageText,
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      let firstUserMessageId: string | undefined;
      const sawFirstUserMessage = await waitFor(() => {
        const firstUserMessage = collector
          .getEvents()
          .filter(isMuxMessage)
          .find(
            (event) =>
              event.role === "user" &&
              event.parts.some((part) => "text" in part && part.text === firstMessageText)
          );
        if (firstUserMessage) {
          firstUserMessageId = firstUserMessage.id;
          return true;
        }
        return false;
      }, 5000);
      if (!sawFirstUserMessage || !firstUserMessageId) {
        throw new Error("First user message was not emitted before edit");
      }

      await collector.waitForEvent("stream-start", 5000);

      // Hold the session in COMPLETING.
      await enteredCompletion.promise;

      const editSendPromise = sendMessageWithModel(
        env,
        workspaceId,
        "Edited message",
        HAIKU_MODEL,
        {
          editMessageId: firstUserMessageId,
        }
      );

      // Regression: truncateAfterMessage must not run until completion cleanup is finished.
      const truncateCalledEarly = await waitFor(() => truncateSpy.mock.calls.length > 0, 250);
      expect(truncateCalledEarly).toBe(false);

      releaseCompletion.resolve();

      const editSendResult = await editSendPromise;
      expect(editSendResult.success).toBe(true);
      expect(truncateSpy).toHaveBeenCalled();
    } finally {
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();
      truncateSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);

  test("should recover to IDLE when completion cleanup throws", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-throw");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);

    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementation(originalHandleCompletion);

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);
      const firstStreamEnd = await collector.waitForEvent("stream-end", 15000);
      if (!firstStreamEnd) {
        throw new Error("First stream never ended after completion cleanup threw");
      }

      const recovered = await waitFor(() => !session.isBusy(), 5000);
      expect(recovered).toBe(true);
      expect(session.isBusy()).toBe(false);

      // Prove the session is usable again.
      const secondSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Second message",
        HAIKU_MODEL
      );
      expect(secondSendResult.success).toBe(true);

      const secondStreamStart = await collector.waitForEventN("stream-start", 2, 5000);
      if (!secondStreamStart) {
        throw new Error("Second stream never started after recovery");
      }

      const secondStreamEnd = await collector.waitForEventN("stream-end", 2, 15000);
      if (!secondStreamEnd) {
        throw new Error("Second stream never ended after recovery");
      }
    } finally {
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);

  test("should let edit truncate before queued message runs", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-edit-precedence");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);
    const aiService = env.services.aiService;

    // Create a deterministic COMPLETING window by gating the async stream-end handler
    // (AgentSession awaits CompactionHandler.handleCompletion before it can go idle).
    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    type WorkspaceServiceInternals = {
      historyService: HistoryService;
    };
    const historyService = (env.services.workspaceService as unknown as WorkspaceServiceInternals)
      .historyService;

    try {
      await collector.waitForSubscription(5000);

      const firstMessageText = "First message";
      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        firstMessageText,
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      let firstUserMessageId: string | undefined;
      const sawFirstUserMessage = await waitFor(() => {
        const firstUserMessage = collector
          .getEvents()
          .filter(isMuxMessage)
          .find(
            (event) =>
              event.role === "user" &&
              event.parts.some((part) => "text" in part && part.text === firstMessageText)
          );
        if (firstUserMessage) {
          firstUserMessageId = firstUserMessage.id;
          return true;
        }
        return false;
      }, 5000);
      if (!sawFirstUserMessage || !firstUserMessageId) {
        throw new Error("First user message was not emitted before edit");
      }

      await collector.waitForEvent("stream-start", 5000);

      // Hold the session in COMPLETING.
      await enteredCompletion.promise;
      expect(aiService.isStreaming(workspaceId)).toBe(false);
      expect(session.isBusy()).toBe(true);

      const queuedText = "Second message";
      const queuedSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        queuedText,
        HAIKU_MODEL
      );
      expect(queuedSendResult.success).toBe(true);

      let queuedEvent = findQueuedMessageEvent(collector, queuedText);
      const sawQueuedMessage =
        queuedEvent !== undefined
          ? true
          : await waitFor(() => {
              queuedEvent = findQueuedMessageEvent(collector, queuedText);
              return queuedEvent !== undefined;
            }, 5000);
      if (!sawQueuedMessage || !queuedEvent) {
        throw new Error("Queued message event missing after follow-up send during completion");
      }
      expect(queuedEvent.queuedMessages).toEqual([queuedText]);

      const editWaiting = createDeferred<void>();
      const waitForIdle = session.waitForIdle.bind(session);
      const waitForIdleSpy = jest.spyOn(session, "waitForIdle").mockImplementationOnce((signal) => {
        editWaiting.resolve();
        return waitForIdle(signal);
      });

      const editedText = "Edited message";
      const editSendPromise = sendMessageWithModel(env, workspaceId, editedText, HAIKU_MODEL, {
        editMessageId: firstUserMessageId,
      });

      // Join the actual edit wait before releasing completion, rather than polling
      // a private latch that duplicates the reservation owning this operation.
      try {
        await editWaiting.promise;
      } finally {
        waitForIdleSpy.mockRestore();
      }

      releaseCompletion.resolve();

      const sawEditedUserMessage = await waitFor(() => {
        return collector
          .getEvents()
          .filter(isMuxMessage)
          .some(
            (event) =>
              event.role === "user" &&
              event.parts.some((part) => "text" in part && part.text === editedText)
          );
      }, 15000);
      if (!sawEditedUserMessage) {
        throw new Error("Edited user message was not emitted after releasing completion");
      }

      const editSendResult = await editSendPromise;
      expect(editSendResult.success).toBe(true);

      // Wait for edit stream to complete (original + edit = 2 stream-ends).
      const finalStreamEnd = await collector.waitForEventN("stream-end", 2, 15000);
      if (!finalStreamEnd) {
        throw new Error("Edit stream never finished after releasing completion");
      }

      // The queued message should have been restored to input (not auto-sent) because
      // the edit rewrites history — the user should re-evaluate the queued content in
      // the new context.
      const restoreEvent = collector.getEvents().find(isRestoreToInput);
      expect(restoreEvent).toBeDefined();
      expect(restoreEvent!.text).toBe(queuedText);

      const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!historyResult.success) {
        throw new Error(`Failed to read history: ${historyResult.error}`);
      }

      const userTexts = historyResult.data
        .filter((msg) => msg.role === "user" && msg.metadata?.synthetic !== true)
        .map((msg) =>
          msg.parts
            .filter((part) => "text" in part)
            .map((part) => part.text)
            .join("")
        );

      // The edit should have truncated the original message.
      expect(userTexts).toContain(editedText);
      expect(userTexts).not.toContain(firstMessageText);
      // The queued message was restored to input, not auto-sent.
      expect(userTexts).not.toContain(queuedText);
    } finally {
      // Ensure we never leave the completion handler blocked (otherwise workspace.remove can hang).
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);
});
