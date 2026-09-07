import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import { MockAiStreamPlayer } from "./mockAiStreamPlayer";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";
import type { StreamEndEvent, StreamStartEvent } from "@/common/types/stream";
import { createTestHistoryService } from "../testHistoryService";

function readWorkspaceId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (!("workspaceId" in payload)) return undefined;

  const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

function extractText(message: MuxMessage | null | undefined): string {
  if (!message) {
    return "";
  }

  return message.parts
    .filter(
      (part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

describe("MockAiStreamPlayer", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    cleanup = testHistory.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test("appends assistant placeholder even when router turn ends with stream error", async () => {
    const aiServiceStub = new EventEmitter();
    // Bare EventEmitters throw on unobserved "error" emits (production always subscribes).
    aiServiceStub.on("error", () => undefined);

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-1";

    const firstTurnUser = createMuxMessage(
      "user-1",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const firstResult = await player.play([firstTurnUser], workspaceId);
    expect(firstResult.success).toBe(true);
    await player.stop(workspaceId);

    // Read back what was appended during the first turn
    const historyResult = await historyService.getLastMessages(workspaceId, 100);
    const historyBeforeSecondTurn = historyResult.success ? historyResult.data : [];

    const secondTurnUser = createMuxMessage(
      "user-2",
      "user",
      "[mock:error:api] Trigger API error",
      {
        timestamp: Date.now(),
      }
    );

    const secondResult = await player.play(
      [firstTurnUser, ...historyBeforeSecondTurn, secondTurnUser],
      workspaceId
    );
    expect(secondResult.success).toBe(true);
    if (!secondResult.success || !secondResult.data) throw new Error("expected a stream handle");
    expect(await secondResult.data.completion).toMatchObject({ status: "failed" });

    // Read back all messages and check the assistant placeholders
    const allResult = await historyService.getLastMessages(workspaceId, 100);
    const allMessages = allResult.success ? allResult.data : [];
    const assistantMessages = allMessages.filter((m) => m.role === "assistant");

    expect(assistantMessages).toHaveLength(2);
    const [firstAppend, secondAppend] = assistantMessages;

    expect(firstAppend.id).not.toBe(secondAppend.id);

    const firstSeq = firstAppend.metadata?.historySequence ?? -1;
    const secondSeq = secondAppend.metadata?.historySequence ?? -1;
    expect(secondSeq).toBe(firstSeq + 1);

    await player.stop(workspaceId);
  });

  test("removes assistant placeholder when aborted before stream scheduling", async () => {
    type AppendResult = Awaited<ReturnType<HistoryService["appendToHistory"]>>;

    // Control when appendToHistory resolves to test the abort race condition.
    // The real service writes to disk immediately; we gate the returned promise
    // so the player sees a pending append while we trigger abort.
    let appendResolve!: (result: AppendResult) => void;
    const appendGate = new Promise<AppendResult>((resolve) => {
      appendResolve = resolve;
    });

    let appendedMessageResolve!: (msg: MuxMessage) => void;
    const appendedMessage = new Promise<MuxMessage>((resolve) => {
      appendedMessageResolve = resolve;
    });

    const originalAppend = historyService.appendToHistory.bind(historyService);
    spyOn(historyService, "appendToHistory").mockImplementation(
      async (wId: string, message: MuxMessage) => {
        // Write to disk so deleteMessage can find it later
        await originalAppend(wId, message);
        appendedMessageResolve(message);
        // Delay returning to the caller until the gate opens
        return appendGate;
      }
    );

    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-abort-startup";

    const userMessage = createMuxMessage(
      "user-1",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const abortController = new AbortController();
    const playPromise = player.play([userMessage], workspaceId, {
      abortSignal: abortController.signal,
    });

    const assistantMsg = await appendedMessage;

    appendResolve(Ok(undefined));
    abortController.abort();

    const result = await playPromise;
    expect(result.success).toBe(true);

    // Verify the placeholder was deleted from history
    const storedResult = await historyService.getLastMessages(workspaceId, 100);
    const storedMessages = storedResult.success ? storedResult.data : [];
    expect(storedMessages.some((msg) => msg.id === assistantMsg.id)).toBe(false);
  });

  test("does not schedule a replacement stream when abort fires during prior stop cleanup", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const originalDeletePartial = historyService.commitPartial.bind(historyService);
    let deletePartialCallCount = 0;
    let releaseStopCleanup!: () => void;
    const stopCleanupGate = new Promise<void>((resolve) => {
      releaseStopCleanup = () => resolve();
    });
    spyOn(historyService, "commitPartial").mockImplementation(async (workspaceIdToDelete) => {
      deletePartialCallCount += 1;
      if (deletePartialCallCount === 1) {
        await stopCleanupGate;
      }
      return await originalDeletePartial(workspaceIdToDelete);
    });

    const workspaceId = "workspace-abort-during-replacement-stop";
    const streamStartMessageIds: string[] = [];
    aiServiceStub.on("stream-start", (payload: unknown) => {
      if (readWorkspaceId(payload) !== workspaceId) {
        return;
      }
      const messageId = (payload as { messageId?: string }).messageId;
      if (typeof messageId === "string") {
        streamStartMessageIds.push(messageId);
      }
    });

    const firstUserMessage = createMuxMessage(
      "user-abort-replacement-first",
      "user",
      "[force] first stream before aborted replacement",
      {
        timestamp: Date.now(),
      }
    );

    try {
      const firstPlayResult = await player.play([firstUserMessage], workspaceId);
      expect(firstPlayResult.success).toBe(true);
      expect(streamStartMessageIds).toHaveLength(1);

      const abortController = new AbortController();
      const replacementUserMessage = createMuxMessage(
        "user-abort-replacement-second",
        "user",
        "[force] replacement stream should abort before scheduling",
        {
          timestamp: Date.now(),
        }
      );

      const replacementPlayPromise = player.play([replacementUserMessage], workspaceId, {
        abortSignal: abortController.signal,
      });

      await waitForCondition(() => deletePartialCallCount >= 1, 1000);
      abortController.abort();
      releaseStopCleanup();

      const replacementPlayResult = await replacementPlayPromise;
      expect(replacementPlayResult.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(player.isStreaming(workspaceId)).toBe(false);
      expect(streamStartMessageIds).toHaveLength(1);

      const historyResult = await historyService.getLastMessages(workspaceId, 10);
      const historyMessages = historyResult.success ? historyResult.data : [];
      expect(historyMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
    } finally {
      releaseStopCleanup();
      await player.stop(workspaceId);
    }
  });

  test("writes partial assistant state while a mock stream is still in progress", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-partial-progress";
    const firstDelta = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for stream-delta"));
      }, 1000);

      aiServiceStub.on("stream-delta", (payload: unknown) => {
        if (readWorkspaceId(payload) !== workspaceId) {
          return;
        }
        clearTimeout(timeout);
        resolve();
      });
    });

    const userMessage = createMuxMessage("user-partial", "user", "[force] keep streaming", {
      timestamp: Date.now(),
    });

    const playResult = await player.play([userMessage], workspaceId);
    expect(playResult.success).toBe(true);

    await firstDelta;
    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) !== null,
      1000
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial).not.toBeNull();
    expect(partial?.metadata?.partial).toBe(true);
    expect(partial?.id).toMatch(/^msg-mock-/);
    expect(extractText(partial).length).toBeGreaterThan(0);

    await player.stop(workspaceId);
    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) === null,
      1000
    );
  });

  test("cleans up a delayed partial write after stop cancels the stream", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const originalWritePartial = historyService.writePartial.bind(historyService);
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = () => resolve();
    });
    let writePartialCallCount = 0;
    spyOn(historyService, "writePartial").mockImplementation(
      async (workspaceIdToWrite, message) => {
        writePartialCallCount += 1;
        if (writePartialCallCount === 1) {
          await firstWriteGate;
        }
        return await originalWritePartial(workspaceIdToWrite, message);
      }
    );

    const workspaceId = "workspace-stale-partial-after-stop";
    const userMessage = createMuxMessage("user-stale-partial", "user", "[force] keep streaming", {
      timestamp: Date.now(),
    });

    try {
      const playResult = await player.play([userMessage], workspaceId);
      expect(playResult.success).toBe(true);

      await waitForCondition(() => writePartialCallCount >= 1, 1000);

      const stop = player.stop(workspaceId, { abandonPartial: true });
      releaseFirstWrite();
      await stop;
      expect(player.isStreaming(workspaceId)).toBe(false);
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      releaseFirstWrite();
      await waitForCondition(
        async () => (await historyService.readPartial(workspaceId)) === null,
        1000
      );
    } finally {
      releaseFirstWrite();
      await player.stop(workspaceId);
    }
  });

  test("replacement joins the old delayed write and captured partial finalization", async () => {
    const emitter = new EventEmitter();
    const player = new MockAiStreamPlayer({
      historyService,
      aiService: emitter as unknown as AIService,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalWrite = historyService.writePartial.bind(historyService);
    spyOn(historyService, "writePartial").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return originalWrite(...args);
    });
    const workspaceId = "mock-replacement-write-fence";
    const user = createMuxMessage("user", "user", "[force] keep streaming");
    let replacementStarted = false;
    try {
      const first = await player.play([user], workspaceId);
      if (!first.success || !first.data) throw new Error("Expected handle");
      await entered.promise;
      const replacement = player.play([user], workspaceId).then((result) => {
        replacementStarted = true;
        return result;
      });
      expect(replacementStarted).toBe(false);
      release.resolve();
      const next = await replacement;
      if (!next.success || !next.data) throw new Error("Expected replacement");
      expect(await first.data.completion).toMatchObject({
        status: "aborted",
        abortReason: "system",
      });
      const partial = await historyService.readPartial(workspaceId);
      expect(partial?.id).not.toBe(first.data.messageId);
      expect(next.data.messageId).not.toBe(first.data.messageId);
    } finally {
      release.resolve();
      await player.stop(workspaceId);
    }
  });

  test("waits for partial cleanup before a replacement stream starts writing its own partial", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const originalDeletePartial = historyService.deletePartial.bind(historyService);
    spyOn(historyService, "deletePartial").mockImplementation(async (workspaceIdToDelete) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await originalDeletePartial(workspaceIdToDelete);
    });

    const workspaceId = "workspace-partial-replacement";
    const firstUserMessage = createMuxMessage(
      "user-partial-first",
      "user",
      "[force] first-partial-marker keep streaming",
      {
        timestamp: Date.now(),
      }
    );

    const firstPlayResult = await player.play([firstUserMessage], workspaceId);
    expect(firstPlayResult.success).toBe(true);

    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) !== null,
      1500
    );

    const firstPartial = await historyService.readPartial(workspaceId);
    expect(firstPartial).not.toBeNull();

    const secondUserMessage = createMuxMessage(
      "user-partial-second",
      "user",
      "[force] second-partial-marker keep streaming",
      {
        timestamp: Date.now(),
      }
    );

    const secondPlayResult = await player.play([secondUserMessage], workspaceId);
    expect(secondPlayResult.success).toBe(true);

    await waitForCondition(async () => {
      const partial = await historyService.readPartial(workspaceId);
      return partial !== null && partial.id !== firstPartial?.id;
    }, 2000);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const replacementPartial = await historyService.readPartial(workspaceId);
    expect(replacementPartial).not.toBeNull();
    expect(replacementPartial?.id).not.toBe(firstPartial?.id);

    await player.stop(workspaceId);
    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) === null,
      1500
    );
  });

  test("suppresses stale stream errors after a replacement stream cancels the old one", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const originalDeletePartial = historyService.deletePartial.bind(historyService);
    let deletePartialCallCount = 0;
    spyOn(historyService, "deletePartial").mockImplementation(async (workspaceIdToDelete) => {
      deletePartialCallCount += 1;
      if (deletePartialCallCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return await originalDeletePartial(workspaceIdToDelete);
    });

    const workspaceId = "workspace-stale-stream-error";
    const errorEvents: Array<{ messageId?: string }> = [];
    aiServiceStub.on("error", (payload: unknown) => {
      if (readWorkspaceId(payload) !== workspaceId) {
        return;
      }
      errorEvents.push(payload as { messageId?: string });
    });

    const firstUserMessage = createMuxMessage(
      "user-stream-error-first",
      "user",
      "[mock:error:api] Trigger API error",
      {
        timestamp: Date.now(),
      }
    );

    const firstPlayResult = await player.play([firstUserMessage], workspaceId);
    expect(firstPlayResult.success).toBe(true);

    await waitForCondition(() => deletePartialCallCount >= 1, 1000);

    const replacementUserMessage = createMuxMessage(
      "user-stream-error-second",
      "user",
      "[force] replacement stream after cancelled error",
      {
        timestamp: Date.now(),
      }
    );

    const replacementPlayResult = await player.play([replacementUserMessage], workspaceId);
    expect(replacementPlayResult.success).toBe(true);

    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) !== null,
      1500
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    const replacementPartial = await historyService.readPartial(workspaceId);
    expect(replacementPartial).not.toBeNull();
    expect(errorEvents).toHaveLength(0);

    await player.stop(workspaceId);
    await waitForCondition(() => !player.isStreaming(workspaceId), 1000);
  });

  test("does not let stale stream-end cleanup delete a replacement stream partial", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const originalDeletePartial = historyService.deletePartial.bind(historyService);
    let deletePartialCallCount = 0;
    spyOn(historyService, "deletePartial").mockImplementation(async (workspaceIdToDelete) => {
      deletePartialCallCount += 1;
      if (deletePartialCallCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return await originalDeletePartial(workspaceIdToDelete);
    });

    const workspaceId = "workspace-stale-stream-end";
    const firstUserMessage = createMuxMessage(
      "user-stream-end-first",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const firstPlayResult = await player.play([firstUserMessage], workspaceId);
    expect(firstPlayResult.success).toBe(true);

    await waitForCondition(() => deletePartialCallCount >= 1, 1000);

    const replacementUserMessage = createMuxMessage(
      "user-stream-end-second",
      "user",
      "[force] replacement stream after completed turn",
      {
        timestamp: Date.now(),
      }
    );

    const replacementPlayResult = await player.play([replacementUserMessage], workspaceId);
    expect(replacementPlayResult.success).toBe(true);

    await waitForCondition(
      async () => (await historyService.readPartial(workspaceId)) !== null,
      1500
    );
    const replacementPartial = await historyService.readPartial(workspaceId);
    expect(replacementPartial).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 350));

    const partialAfterStaleCleanup = await historyService.readPartial(workspaceId);
    expect(partialAfterStaleCleanup).not.toBeNull();
    expect(partialAfterStaleCleanup?.id).toBe(replacementPartial?.id);

    await player.stop(workspaceId);
    await waitForCondition(() => !player.isStreaming(workspaceId), 1000);
  });

  test("commits the full assistant message and clears partial state on stream end", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-partial-commit";
    const userMessage = createMuxMessage(
      "user-commit",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const playResult = await player.play([userMessage], workspaceId);
    expect(playResult.success).toBe(true);

    await waitForCondition(() => !player.isStreaming(workspaceId), 2000);
    if (!playResult.success || !playResult.data) throw new Error("expected a stream handle");
    expect(await playResult.data.completion).toMatchObject({ status: "completed" });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial).toBeNull();

    const historyResult = await historyService.getLastMessages(workspaceId, 10);
    const historyMessages = historyResult.success ? historyResult.data : [];
    const assistantMessage = historyMessages.find((message) => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(extractText(assistantMessage)).toContain("Here are three programming languages");
  });

  test("preserves agent and workspace-turn metadata through mock stream completion", async () => {
    const aiServiceStub = new EventEmitter();
    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });
    const workspaceId = "workspace-metadata";
    const muxMetadata = {
      type: "workspace-turn-task",
      taskHandleId: "wst_mock_metadata",
      ownerWorkspaceId: "parent-metadata",
      turnId: "turn-metadata",
    } as const;
    let streamStart: StreamStartEvent | undefined;
    let streamEnd: StreamEndEvent | undefined;
    aiServiceStub.on("stream-start", (payload: StreamStartEvent) => {
      if (payload.workspaceId === workspaceId) streamStart = payload;
    });
    aiServiceStub.on("stream-end", (payload: StreamEndEvent) => {
      if (payload.workspaceId === workspaceId) streamEnd = payload;
    });

    const userMessage = createMuxMessage("user-metadata", "user", "Continue delegated work", {
      timestamp: Date.now(),
    });
    const playResult = await player.play([userMessage], workspaceId, {
      model: "anthropic:claude-sonnet-4-6",
      agentId: "explore",
      thinkingLevel: "high",
      muxMetadata,
    });
    expect(playResult.success).toBe(true);
    if (!playResult.success || !playResult.data) throw new Error("Expected mock handle");
    const completion = await playResult.data.completion;
    expect(completion).toMatchObject({ status: "completed", streamEnd });
    expect(player.isStreaming(workspaceId)).toBe(false);

    expect(streamStart).toMatchObject({ agentId: "explore", thinkingLevel: "high" });
    expect(streamEnd?.metadata).toMatchObject({
      agentId: "explore",
      thinkingLevel: "high",
      muxMetadata,
    });
    const historyResult = await historyService.getLastMessages(workspaceId, 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) throw new Error(historyResult.error);
    const assistantMessage = historyResult.data.find((message) => message.role === "assistant");
    expect(assistantMessage?.metadata).toMatchObject({
      agentId: "explore",
      thinkingLevel: "high",
      muxMetadata,
    });
  });

  test("stop prevents queued stream events from emitting", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-2";

    let deltaCount = 0;
    let abortCount = 0;
    let stopped = false;

    aiServiceStub.on("stream-abort", (payload: unknown) => {
      if (readWorkspaceId(payload) === workspaceId) {
        abortCount += 1;
      }
    });

    const firstDelta = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for stream-delta"));
      }, 1000);

      aiServiceStub.on("stream-delta", (payload: unknown) => {
        if (readWorkspaceId(payload) !== workspaceId) return;

        deltaCount += 1;

        if (!stopped) {
          stopped = true;
          clearTimeout(timeout);
          void player.stop(workspaceId);
          resolve();
        }
      });
    });

    const forceTurnUser = createMuxMessage("user-force", "user", "[force] keep streaming", {
      timestamp: Date.now(),
    });

    const playResult = await player.play([forceTurnUser], workspaceId);
    expect(playResult.success).toBe(true);

    await firstDelta;

    const deltasAtStop = deltaCount;

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(deltaCount).toBe(deltasAtStop);
    expect(abortCount).toBe(1);
    if (!playResult.success || !playResult.data) throw new Error("expected a stream handle");
    expect(await playResult.data.completion).toMatchObject({ status: "aborted" });
  });
  test.each(["stream-end", "error"] as const)(
    "a synchronous stop from %s cannot publish a second terminal",
    async (eventName) => {
      const emitter = new EventEmitter();
      const player = new MockAiStreamPlayer({
        historyService,
        aiService: emitter as unknown as AIService,
      });
      const workspaceId = `mock-reentrant-${eventName}`;
      let stop: Promise<void> | undefined;
      let aborts = 0;
      emitter.on("stream-abort", () => {
        aborts++;
      });
      emitter.once(eventName, () => {
        stop = player.stop(workspaceId, { abortReason: "user" });
        throw new Error("terminal listener failed");
      });
      const played = await player.play(
        [
          createMuxMessage(
            "user",
            "user",
            eventName === "error"
              ? "[mock:error:api] Trigger API error"
              : "[mock:list-languages] List 3 programming languages"
          ),
        ],
        workspaceId
      );
      if (!played.success || !played.data) throw new Error("Expected mock handle");
      try {
        const completion = await played.data.completion;
        expect(completion.status).toBe(eventName === "error" ? "failed" : "completed");
        expect(stop).toBeDefined();
        await stop;
        expect(aborts).toBe(0);
      } finally {
        await player.stop(workspaceId);
      }
    }
  );

  test.each([false, true])(
    "abort completion waits for partial deletion (reject=%s)",
    async (rejectDelete) => {
      const emitter = new EventEmitter();
      const player = new MockAiStreamPlayer({
        historyService,
        aiService: emitter as unknown as AIService,
      });
      const workspaceId = "mock-abort-completion-barrier";
      const delta = Promise.withResolvers<void>();
      emitter.once("stream-delta", () => delta.resolve());
      const played = await player.play(
        [createMuxMessage("user", "user", "[force] keep streaming")],
        workspaceId
      );
      if (!played.success || !played.data) throw new Error("Expected mock handle");
      await delta.promise;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const deletePartial = historyService.deletePartialIfMessageIdMatches.bind(historyService);
      const deletion = spyOn(
        historyService,
        "deletePartialIfMessageIdMatches"
      ).mockImplementationOnce(async (id, messageId) => {
        entered.resolve();
        await release.promise;
        if (rejectDelete) throw new Error("partial delete failed");
        return deletePartial(id, messageId);
      });
      let settled = false;
      const observed = played.data.completion.then(() => {
        settled = true;
      });
      let terminal: unknown;
      emitter.once("stream-abort", (payload) => {
        terminal = payload;
      });
      const stop = player
        .stop(workspaceId, { abandonPartial: true, abortReason: "user" })
        .catch((error) => error as unknown);
      try {
        await entered.promise;
        expect(player.isStreaming(workspaceId)).toBe(true);
        expect(settled).toBe(false);
        expect(terminal).toBeUndefined();
        release.resolve();
        await stop;
        expect(await played.data.completion).toMatchObject({
          status: "aborted",
          streamAbort: terminal,
        });
        await observed;
        if (!rejectDelete) expect(await historyService.readPartial(workspaceId)).toBeNull();
      } finally {
        release.resolve();
        await stop;
        deletion.mockRestore();
      }
    }
  );
});
