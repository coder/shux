import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  createAIServiceMocks,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  makeWorkspaceTurnCreateMock,
  saveLocalParentWorkspace,
  stubStableIds,
  workspaceTurnMuxMetadata,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { createWorkspaceTurnManagerHarness } from "@/node/services/workspaceTurnManager.testHarness";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startTurn() {
  const fixture = await createTestHistoryService();
  cleanups.push(fixture.cleanup);
  const { config, historyService, tempDir } = fixture;
  await mkdir(config.srcDir, { recursive: true });
  const { parentId, projectPath } = await saveLocalParentWorkspace(config, tempDir);
  stubStableIds(config, ["handle", "turn"]);
  let activeStream: { messageId: string; muxMetadata: unknown } | undefined;
  const aiMocks = createAIServiceMocks(config, {
    isStreaming: mock(() => activeStream != null),
    getStreamInfo: mock(() => activeStream),
  });
  const continuation = mock(() => false);
  const workspaceMocks = createWorkspaceServiceMocks({
    create: makeWorkspaceTurnCreateMock(config, projectPath),
    hasPendingWorkspaceTurnContinuation: continuation,
    sendMessage: mock(async (...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      const [workspaceId, prompt, options, internal] = args;
      const muxMetadata = workspaceTurnMuxMetadata(parentId);
      expect(options?.muxMetadata).toEqual(muxMetadata);
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("turn-anchor", "user", prompt, { muxMetadata })
          )
        ).success
      ).toBe(true);
      await internal?.onAccepted?.();
      activeStream = { messageId: "turn-stream", muxMetadata };
      return Ok(undefined);
    }),
  });
  const { taskService: manager, taskHost } = createWorkspaceTurnManagerHarness(config, {
    historyService,
    aiService: aiMocks.aiService,
    workspaceService: workspaceMocks.workspaceService,
  });
  const result = await manager.createWorkspaceTurn({
    ownerWorkspaceId: parentId,
    prompt: "Summarize the repository",
    title: "Settlement regression",
    workspace: { mode: "new", disposable: true },
  });
  assert(result.success, result.success ? undefined : result.error);
  const { taskId, workspaceId } = result.data;
  const store = new TaskHandleStore(config);
  const readRecord = async () => {
    const record = await store.getWorkspaceTurn(parentId, taskId);
    assert(record);
    return record;
  };
  expect(await readRecord()).toMatchObject({ status: "running", disposableWorkspace: true });
  await manager.markWorkspaceTurnBackgroundWorkNotifyOnTerminal(taskId, parentId);
  const attention = new TerminalAttentionStore(config);
  const notify = spyOn(taskHost, "enqueueTerminalAttention");
  const abort = new AbortController();
  let waiterSettled = false;
  const waiter = manager
    .waitForWorkspaceTurn(taskId, { requestingWorkspaceId: parentId, abortSignal: abort.signal })
    .then(
      (value) => {
        waiterSettled = true;
        return value;
      },
      (error: unknown) => {
        waiterSettled = true;
        return error;
      }
    );
  cleanups.push(async () => {
    abort.abort();
    await waiter;
  });
  const append = async (message: MuxMessage) => {
    expect((await historyService.appendToHistory(workspaceId, message)).success).toBe(true);
  };
  const uncorrelatedEnd: StreamEndEvent = {
    type: "stream-end",
    workspaceId,
    messageId: "wake-output",
    metadata: { model: "anthropic:claude-opus-4-6", agentId: "exec", finishReason: "stop" },
    parts: [{ type: "text", text: "Synthetic wake finished" }],
  };
  const final: StreamEndEvent = {
    ...uncorrelatedEnd,
    messageId: "turn-final",
    metadata: {
      ...uncorrelatedEnd.metadata,
      muxMetadata: workspaceTurnMuxMetadata(parentId, taskId),
    },
    parts: [{ type: "text", text: "Delegated work finished" }],
  };
  const finish = async (event: StreamEndEvent) => {
    activeStream = undefined;
    return manager.finalizeWorkspaceTurnFromStreamEnd(
      event,
      manager.captureQueueCutAttributionSnapshot(workspaceId)
    );
  };
  const appendWake = async (synthetic: boolean) => {
    await append(createMuxMessage("wake-input", "user", "Continue", { synthetic }));
    await append(
      createMuxMessage(uncorrelatedEnd.messageId, "assistant", "Synthetic wake finished", {
        ...uncorrelatedEnd.metadata,
      })
    );
  };
  return {
    config,
    historyService,
    manager,
    taskHost,
    aiMocks,
    workspaceMocks,
    continuation,
    parentId,
    taskId,
    workspaceId,
    attention,
    notify,
    waiter,
    readRecord,
    append,
    appendWake,
    uncorrelatedEnd,
    final,
    finish,
    waiterSettled: () => waiterSettled,
  };
}

// Keep the behavioral oracle above and this first test independent of settlement-cause internals:
// it also runs on the pre-fix revision to prove that a synthetic wake cannot finish delegated work.
describe("WorkspaceTurnManager uncorrelated stream-end", () => {
  test("synthetic end after the turn anchor preserves the pending turn until its correlated final", async () => {
    const h = await startTurn();
    await h.appendWake(true);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(await h.readRecord()).toMatchObject({ status: "running" });
    expect(h.waiterSettled()).toBe(false);
    expect(h.manager.getLiveWorkspaceTurnRegistration(h.workspaceId)).toMatchObject({
      handleId: h.taskId,
      accepted: true,
    });
    expect(h.workspaceMocks.remove).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.attention.listPending(h.parentId)).toEqual([]);

    expect(await h.finish(h.final)).toBe(true);
    expect(await h.readRecord()).toMatchObject({
      status: "completed",
      messageId: h.final.messageId,
    });
    expect(await h.waiter).toMatchObject({ reportMarkdown: "Delegated work finished" });
    expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
    expect(h.manager.getLiveWorkspaceTurnRegistration(h.workspaceId)).toBeUndefined();
  });

  test("same-turn tool-calls continuation survives a synthetic end and completes at the correlated final", async () => {
    const h = await startTurn();
    h.continuation.mockReturnValue(true);
    const toolEnd: StreamEndEvent = {
      ...h.final,
      messageId: "tool-boundary",
      metadata: { ...h.final.metadata, finishReason: "tool-calls" },
    };
    expect(await h.finish(toolEnd)).toBe(true);
    expect(await h.readRecord()).toMatchObject({
      status: "running",
      deferredMessageIds: [toolEnd.messageId],
    });
    h.continuation.mockReturnValue(false);
    await h.appendWake(true);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(await h.readRecord()).toMatchObject({ status: "running" });
    expect(h.waiterSettled()).toBe(false);
    expect(h.workspaceMocks.remove).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.finish(h.final)).toBe(true);
    expect(await h.waiter).toMatchObject({ reportMarkdown: "Delegated work finished" });
    const completed = await h.readRecord();
    expect(completed.status).toBe("completed");
    expect(completed.deferredMessageIds).toBeUndefined();
    expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
  });
});

// The production cause stays private and ephemeral. Widen only the test boundary so malformed
// runtime inputs can exercise the assertion without exporting or persisting the internal union.
interface SettlementSeam {
  assertWorkspaceTurnSettlementCause(cause: unknown): void;
  settleWorkspaceTurn(params: {
    record: WorkspaceTurnTaskHandleRecord;
    next: WorkspaceTurnTaskHandleRecord;
    cause?: unknown;
    waiterSettlement: { status: "error"; error: Error };
  }): Promise<void>;
  workspaceTurnSettlementLocks: MutexMap<string>;
  taskHandleStore: TaskHandleStore;
  settleWorkspaceTurnWaiters(...args: unknown[]): unknown;
  cleanupDisposableWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
}

function observeCauseInsideLock(manager: WorkspaceTurnManager) {
  const internal = manager as unknown as SettlementSeam;
  let insideLock = false;
  const withLock = internal.workspaceTurnSettlementLocks.withLock.bind(
    internal.workspaceTurnSettlementLocks
  );
  spyOn(internal.workspaceTurnSettlementLocks, "withLock").mockImplementation(
    <T>(key: string, operation: () => Promise<T>) =>
      withLock(key, async () => {
        insideLock = true;
        try {
          return await operation();
        } finally {
          insideLock = false;
        }
      })
  );
  const validate = internal.assertWorkspaceTurnSettlementCause.bind(internal);
  const causes = spyOn(internal, "assertWorkspaceTurnSettlementCause").mockImplementation(
    (cause) => {
      expect(insideLock).toBe(true);
      validate(cause);
    }
  );
  return { internal, causes };
}

describe("WorkspaceTurnManager settlement authorization", () => {
  test("manual input interrupts with the concrete superseding message as internal evidence", async () => {
    const h = await startTurn();
    const { causes } = observeCauseInsideLock(h.manager);
    await h.appendWake(false);
    const reads = spyOn(h.historyService, "getControlEvidenceFromLatestBoundary");
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).toHaveBeenCalledWith({ kind: "manual-supersession", messageId: "wake-input" });
    expect(reads).toHaveBeenCalledTimes(1);
    const record = await h.readRecord();
    expect(record).toMatchObject({ status: "interrupted", messageId: h.uncorrelatedEnd.messageId });
    expect(record).not.toHaveProperty("cause");
    expect(await h.waiter).toBeInstanceOf(Error);
    expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, null, 42, "", " \t"])(
    "malformed persisted manual input id %j conservatively interrupts instead of stranding waiters",
    async (id) => {
      const h = await startTurn();
      // Corruption can be valid JSON but not a valid MuxMessage; exercise the real disk parser.
      await appendFile(
        join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
        JSON.stringify({
          ...createMuxMessage("manual-input", "user", "Redirect the child", {
            historySequence: 1,
          }),
          id,
        }) + "\n"
      );
      await h.append(
        createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "Manual response", {
          ...h.uncorrelatedEnd.metadata,
        })
      );
      const { causes } = observeCauseInsideLock(h.manager);
      const reads = spyOn(h.historyService, "getControlEvidenceFromLatestBoundary");
      expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
      expect(causes).toHaveBeenCalledWith({
        kind: "uncorrelated-conservative-fallback",
        reason: "invalid-manual-input-id",
      });
      expect(reads).toHaveBeenCalledTimes(1);
      expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
      expect(await h.waiter).toBeInstanceOf(Error);
      expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
    }
  );

  test("malformed message parts still provide ordered manual intervention evidence", async () => {
    const h = await startTurn();
    const messageId = " manual-with-damaged-parts ";
    await appendFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      JSON.stringify({ id: messageId, role: "user", parts: [null] }) + "\n"
    );
    await h.append(createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "Manual response"));
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).toHaveBeenCalledWith({ kind: "manual-supersession", messageId });
    expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
  });

  test.each([null, 42, [], [{ synthetic: true }]].map((metadata) => [metadata] as const))(
    "malformed outer metadata cannot hide manual intervention with malformed parts: %j",
    async (metadata) => {
      const h = await startTurn();
      const id = "damaged-metadata-input";
      await appendFile(
        join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
        JSON.stringify({ id, role: "user", parts: [null], metadata }) + "\n"
      );
      await h.append(createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "Manual response"));
      const { causes } = observeCauseInsideLock(h.manager);
      expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
      expect(causes).toHaveBeenCalledWith({ kind: "manual-supersession", messageId: id });
      expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
    }
  );

  test("invalid IDs still conservatively interrupt when metadata is also damaged", async () => {
    const h = await startTurn();
    await appendFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      JSON.stringify({ id: 42, role: "user", metadata: null }) + "\n"
    );
    await h.append(createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "Manual response"));
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).toHaveBeenCalledWith({
      kind: "uncorrelated-conservative-fallback",
      reason: "invalid-manual-input-id",
    });
    expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
  });

  test.each(["before", "after"])(
    "control evidence never crosses an unreadable floor %s the turn anchor",
    async (position) => {
      const h = await startTurn();
      const reset = '{"metadata":{"contextBoundaryKind" : "reset"},broken\n';
      const anchor = createMuxMessage("turn-anchor", "user", "delegated", {
        muxMetadata: workspaceTurnMuxMetadata(h.parentId),
      });
      const invalidManual = JSON.stringify({ id: 42, role: "user", parts: [] }) + "\n";
      await writeFile(
        join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
        position === "before"
          ? invalidManual + reset + JSON.stringify(anchor) + "\n"
          : JSON.stringify(anchor) + "\n" + invalidManual + reset
      );
      await h.appendWake(true);
      const { causes } = observeCauseInsideLock(h.manager);
      expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
      if (position === "before") {
        expect(causes).not.toHaveBeenCalled();
        expect(await h.readRecord()).toMatchObject({ status: "running" });
        expect(h.waiterSettled()).toBe(false);
      } else {
        expect(causes).toHaveBeenCalledWith({
          kind: "uncorrelated-conservative-fallback",
          reason: "missing-turn-anchor",
        });
        expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
      }
    }
  );

  test("manual evidence after a stale stream end is not applied out of order", async () => {
    const h = await startTurn();
    await writeFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      [
        createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "earlier end"),
        createMuxMessage("turn-anchor", "user", "delegated", {
          muxMetadata: workspaceTurnMuxMetadata(h.parentId),
        }),
        { id: 42, role: "user" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).not.toHaveBeenCalled();
    expect(await h.readRecord()).toMatchObject({ status: "running" });
  });

  test.each(
    [
      undefined,
      null,
      [],
      { type: "normal" },
      {
        type: "compaction-request",
        source: "auto-compaction",
        parsed: { followUpContent: { dispatchOptions: { source: "internal-resume" } } },
      },
      {
        type: "compaction-request",
        source: "auto-compaction",
        parsed: { continueMessage: { dispatchOptions: { source: "internal-resume" } } },
      },
    ].map((metadata) => [metadata] as const)
  )("synthetic control evidence does not become manual input: %j", async (muxMetadata) => {
    const h = await startTurn();
    await appendFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      JSON.stringify({ id: 42, role: "user", metadata: { synthetic: true, muxMetadata } }) + "\n"
    );
    await h.appendWake(true);
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).not.toHaveBeenCalled();
    expect(await h.readRecord()).toMatchObject({ status: "running" });
  });

  for (const internalResume of [false, true]) {
    test.each([
      { id: undefined, parts: [{ type: "text", text: "legacy continuation" }] },
      { id: null, parts: [null] },
      { id: 42, parts: undefined },
      { id: "legacy-manual", parts: [null] },
    ])(
      `legacy compaction control evidence survives malformed IDs/parts (internal resume: ${internalResume}): %j`,
      async (damaged) => {
        const h = await startTurn();
        await appendFile(
          join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
          JSON.stringify({
            ...damaged,
            role: "user",
            metadata: {
              synthetic: true,
              cmuxMetadata: {
                type: "compaction-request",
                source: "auto-compaction",
                parsed: {
                  continueMessage: {
                    text: "User follow-up",
                    ...(internalResume ? { dispatchOptions: { source: "internal-resume" } } : {}),
                  },
                },
              },
            },
          }) + "\n"
        );
        const provider = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(provider.success).toBe(true);
        if (!provider.success) throw new Error(provider.error);
        expect(provider.data.map((row) => row.id)).toEqual(["turn-anchor"]);
        const control = await h.historyService.getControlEvidenceFromLatestBoundary(h.workspaceId);
        expect(control.success).toBe(true);
        if (!control.success) throw new Error(control.error);
        expect(control.data.at(-1)?.id).toBe(damaged.id);
        await h.appendWake(true);
        const { causes } = observeCauseInsideLock(h.manager);
        expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
        if (internalResume) {
          expect(causes).not.toHaveBeenCalled();
          expect(await h.readRecord()).toMatchObject({ status: "running" });
          expect(h.waiterSettled()).toBe(false);
        } else {
          expect(causes).toHaveBeenCalledWith(
            typeof damaged.id === "string"
              ? { kind: "manual-supersession", messageId: damaged.id }
              : { kind: "uncorrelated-conservative-fallback", reason: "invalid-manual-input-id" }
          );
          expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
          expect(await h.waiter).toBeInstanceOf(Error);
        }
        expect(control.data.at(-1)?.metadata).toHaveProperty("muxMetadata");
        expect(control.data.at(-1)?.metadata).not.toHaveProperty("cmuxMetadata");
      }
    );
  }

  test("compaction-summary control anchors retain manual ordering after the original anchor is archived", async () => {
    const h = await startTurn();
    await h.append(
      createMuxMessage("summary-anchor", "assistant", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            workspaceTurnMetadata: workspaceTurnMuxMetadata(h.parentId),
          },
        },
      })
    );
    await appendFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      JSON.stringify({ id: "after-summary", role: "user" }) + "\n"
    );
    await h.append(createMuxMessage(h.uncorrelatedEnd.messageId, "assistant", "Manual response"));
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).toHaveBeenCalledWith({
      kind: "manual-supersession",
      messageId: "after-summary",
    });
  });

  test.each(
    [null, [], { followUpContent: 42 }, { followUpContent: { dispatchOptions: null } }].map(
      (parsed) => [parsed] as const
    )
  )("damaged auto-compaction follow-up metadata conservatively interrupts: %j", async (parsed) => {
    const h = await startTurn();
    await appendFile(
      join(h.config.sessionsDir, h.workspaceId, CHAT_FILE_NAME),
      JSON.stringify({
        id: 42,
        role: "user",
        metadata: {
          synthetic: true,
          muxMetadata: { type: "compaction-request", source: "auto-compaction", parsed },
        },
      }) + "\n"
    );
    await h.appendWake(true);
    const { causes } = observeCauseInsideLock(h.manager);
    expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
    expect(causes).toHaveBeenCalledWith({
      kind: "uncorrelated-conservative-fallback",
      reason: "invalid-manual-input-id",
    });
  });

  test.each(["history-read-failed", "missing-stream-end", "missing-turn-anchor"] as const)(
    "conservative %s fallback interrupts with one history read and its exact internal reason",
    async (reason) => {
      const h = await startTurn();
      await h.appendWake(true);
      if (reason !== "history-read-failed") {
        const messageId =
          reason === "missing-stream-end" ? h.uncorrelatedEnd.messageId : "turn-anchor";
        expect((await h.historyService.deleteMessage(h.workspaceId, messageId)).success).toBe(true);
      }
      const { causes } = observeCauseInsideLock(h.manager);
      const reads = spyOn(h.historyService, "getControlEvidenceFromLatestBoundary");
      if (reason === "history-read-failed") reads.mockResolvedValueOnce(Err("unreadable history"));
      expect(await h.finish(h.uncorrelatedEnd)).toBe(true);
      expect(causes).toHaveBeenCalledWith({ kind: "uncorrelated-conservative-fallback", reason });
      expect(reads).toHaveBeenCalledTimes(1);
      const record = await h.readRecord();
      expect(record).toMatchObject({
        status: "interrupted",
        messageId: h.uncorrelatedEnd.messageId,
      });
      expect(record).not.toHaveProperty("cause");
      expect(await h.waiter).toBeInstanceOf(Error);
      expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    undefined,
    { kind: "unknown" },
    { kind: "manual-supersession" },
    { kind: "manual-supersession", messageId: "" },
    { kind: "uncorrelated-conservative-fallback" },
    { kind: "uncorrelated-conservative-fallback", reason: "unknown" },
  ])("rejects malformed settlement cause %j before any terminal effects", async (cause) => {
    const h = await startTurn();
    const { internal, causes } = observeCauseInsideLock(h.manager);
    const record = await h.readRecord();
    const failure = await internal
      .settleWorkspaceTurn({
        record,
        next: { ...record, status: "interrupted" },
        ...(cause === undefined ? {} : { cause }),
        waiterSettlement: { status: "error", error: new Error("Unauthorized settlement") },
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(Error);
    expect(causes).toHaveBeenCalledTimes(1);
    expect(await h.readRecord()).toEqual(record);
    expect(h.waiterSettled()).toBe(false);
    expect(h.manager.getLiveWorkspaceTurnRegistration(h.workspaceId)).toMatchObject({
      handleId: h.taskId,
    });
    expect(h.workspaceMocks.remove).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("explicit interrupt cannot write or stop when settlement authorization fails", async () => {
    const h = await startTurn();
    const { causes } = observeCauseInsideLock(h.manager);
    const validate = causes.getMockImplementation()!;
    const denied = new Error("Settlement authorization denied");
    causes.mockImplementation((cause) => {
      validate(cause);
      throw denied;
    });
    const bump = spyOn(h.taskHost, "bumpWorkspaceStopEpoch");
    const latch = spyOn(h.taskHost, "latchWorkspaceStopsInProgress");
    const record = await h.readRecord();
    const failure = await h.manager.interruptWorkspaceTurn(h.parentId, h.taskId).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBe(denied);
    expect(causes).toHaveBeenCalledWith({ kind: "explicit-interrupt" });
    expect(await h.readRecord()).toEqual(record);
    expect(h.waiterSettled()).toBe(false);
    expect(bump).not.toHaveBeenCalled();
    expect(latch).not.toHaveBeenCalled();
    expect(h.workspaceMocks.remove).not.toHaveBeenCalled();
    expect(h.aiMocks.stopStream).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  test("explicit interrupt authorizes inside the lock before preserving stop and cleanup ordering", async () => {
    const h = await startTurn();
    // A matching mirror must become terminal before waiter delivery and stopStream.
    await h.manager.updateAgentTaskExecutionState(h.workspaceId, h.taskId, "running");
    expect(findWorkspaceInConfig(h.config, h.workspaceId)?.taskExecutionStatus).toBe("running");
    const { internal, causes } = observeCauseInsideLock(h.manager);
    const order: string[] = [];
    const validate = causes.getMockImplementation()!;
    causes.mockImplementation((cause) => {
      validate(cause);
      order.push("cause");
    });
    const upsert = internal.taskHandleStore.upsertWorkspaceTurn.bind(internal.taskHandleStore);
    spyOn(internal.taskHandleStore, "upsertWorkspaceTurn").mockImplementation(async (record) => {
      await upsert(record);
      order.push("persist");
    });
    spyOn(h.taskHost, "bumpWorkspaceStopEpoch").mockImplementation(() => {
      order.push("epoch");
    });
    let stopLatched = false;
    spyOn(h.taskHost, "latchWorkspaceStopsInProgress").mockImplementation(() => {
      order.push("latch");
      stopLatched = true;
      return () => {
        order.push("release");
        stopLatched = false;
      };
    });
    const mirror = h.manager.updateAgentTaskExecutionState.bind(h.manager);
    spyOn(h.manager, "updateAgentTaskExecutionState").mockImplementation(async (...args) => {
      await mirror(...args);
      order.push("mirror");
    });
    const settleWaiters = internal.settleWorkspaceTurnWaiters.bind(internal);
    spyOn(internal, "settleWorkspaceTurnWaiters").mockImplementation((...args) => {
      expect(findWorkspaceInConfig(h.config, h.workspaceId)?.taskExecutionStatus).toBe(
        "interrupted"
      );
      order.push("waiters");
      return settleWaiters(...args);
    });
    const stopStarted = Promise.withResolvers<void>();
    const stopFinished = Promise.withResolvers<void>();
    h.aiMocks.stopStream.mockImplementation(async () => {
      order.push("stop");
      stopStarted.resolve();
      await stopFinished.promise;
      expect(stopLatched).toBe(true);
      return Ok(undefined);
    });
    const cleanup = internal.cleanupDisposableWorkspaceTurn.bind(internal);
    spyOn(internal, "cleanupDisposableWorkspaceTurn").mockImplementation(async (record) => {
      expect(stopLatched).toBe(true);
      order.push("cleanup");
      await cleanup(record);
    });
    const interrupted = h.manager.interruptWorkspaceTurn(h.parentId, h.taskId);
    try {
      await Promise.race([
        stopStarted.promise,
        interrupted.then(() => {
          throw new Error("Interrupt returned without stopping the stream");
        }),
      ]);
      expect(order).toEqual(["cause", "persist", "epoch", "latch", "mirror", "waiters", "stop"]);
      expect(causes).toHaveBeenCalledWith({ kind: "explicit-interrupt" });
      expect(await h.readRecord()).toMatchObject({ status: "interrupted" });
      expect(await h.waiter).toBeInstanceOf(Error);
      expect(stopLatched).toBe(true);
      expect(h.manager.getLiveWorkspaceTurnRegistration(h.workspaceId)).toBeUndefined();
      expect(h.workspaceMocks.remove).not.toHaveBeenCalled();
    } finally {
      stopFinished.resolve();
      await interrupted;
    }
    expect(await interrupted).toEqual(Ok({ workspaceId: h.workspaceId }));
    expect(order.slice(-2)).toEqual(["cleanup", "release"]);
    expect(stopLatched).toBe(false);
    expect(h.aiMocks.stopStream).toHaveBeenCalledWith(h.workspaceId, { abandonPartial: false });
    expect(h.workspaceMocks.remove).toHaveBeenCalledTimes(1);
  });
});
