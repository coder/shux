import type { StreamAbortEvent } from "@/common/types/stream";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fsPromises from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";

import type { MuxMessageMetadata } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import type { CompactionMonitor } from "./compactionMonitor";
import type { TurnCompletion } from "./streamManager";
import {
  CompactionCancellation,
  type CompactionReplacementCapture,
  FileCompactionCancellationStorage,
} from "./compactionCancellation";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const WORKSPACE_TURN_CORRELATION = {
  type: "workspace-turn-task",
  taskHandleId: "wst_preparing",
  ownerWorkspaceId: "owner-workspace",
  turnId: "turn-preparing",
} as const;

function toolCallEndEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "tool-call-end",
    workspaceId,
    messageId: "assistant-1",
    toolCallId: "tool-call-1",
    toolName: "bash",
    result: { success: true },
    timestamp: Date.now(),
  };
}

function streamStartEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "stream-start",
    workspaceId,
    messageId: "assistant-1",
    model: TEST_MODEL,
    startTime: Date.now(),
  };
}

function streamAbortEvent(workspaceId: string, abortReason: "system" | "user"): StreamAbortEvent {
  return {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason,
    metadata: { duration: 1 },
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

describe("AgentSession queued message tool-call dispatch", () => {
  test.each(["before write", "failed flush"] as const)(
    "Stop restores only unpublished queued input when held at %s",
    async (phase) => {
      const workspaceId = `queue-visible-publication-${phase}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
      const chatPath = path.join(path.dirname(storage.path), "chat.jsonl");
      const open = fsPromises.open;
      let appendFd: number | undefined;
      let failed = false;
      const opening = spyOn(fsPromises, "open").mockImplementation(
        async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (args[0] === chatPath && args[1] === "a" && appendFd === undefined) {
            appendFd = handle.fd;
            if (phase === "before write") {
              entered.resolve();
              await release.promise;
            } else {
              const close = handle.close.bind(handle);
              spyOn(handle, "close").mockImplementationOnce(async () => {
                entered.resolve();
                await release.promise;
                await close();
              });
            }
          }
          return handle;
        }
      );
      const sync = nodeFs.fsyncSync;
      const flushing = spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        if (phase === "failed flush" && fd === appendFd && !failed) {
          failed = true;
          throw new Error("queued input flush failed");
        }
        sync(fd);
      });
      const accepted = mock(() => undefined);
      const failedPreparation = mock((error: unknown) => {
        entered.reject(error);
      });
      const stream = spyOn(h.aiService, "streamMessage");
      let stopping: ReturnType<typeof h.session.interruptStream> | undefined;
      try {
        h.session.queueMessage(
          "first input",
          { model: TEST_MODEL, agentId: "exec" },
          {
            onAccepted: accepted,
            onAcceptedPreStreamFailure: failedPreparation,
          }
        );
        h.session.queueMessage("later input", { model: TEST_MODEL, agentId: "exec" });
        h.session.sendQueuedMessages();
        await entered.promise;
        expect(failed).toBe(phase === "failed flush");
        const visible = await fsPromises.readFile(chatPath, "utf8");
        expect(visible.includes("first input")).toBe(phase === "failed flush");
        stopping = h.session.interruptStream();
        release.resolve();
        expect(await stopping).toEqual(Ok(undefined));
        await h.session.waitForIdle();
        h.session.restoreQueueToInput();
        expect(
          h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
        ).toEqual([phase === "failed flush" ? "later input" : "first input\nlater input"]);
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success && history.data.filter((row) => row.role === "user")).toHaveLength(
          phase === "failed flush" ? 1 : 0
        );
        expect(accepted).not.toHaveBeenCalled();
        expect(failedPreparation).toHaveBeenCalledTimes(1);
        expect(stream).not.toHaveBeenCalled();
        expect(await storage.read()).not.toBeNull();
      } finally {
        release.resolve();
        opening.mockRestore();
        flushing.mockRestore();
        await stopping;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["local", "foreign"] as const)(
    "Send Now cannot replace a later %s Stop during workspace cleanup",
    async (kind) => {
      const workspaceId = `send-now-owned-stop-${kind}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const failed = Promise.withResolvers<void>();
      let admission = h.session.captureCompactionAdmission("manual");
      let capture: CompactionReplacementCapture | undefined;
      const stream = spyOn(h.aiService, "streamMessage");
      try {
        h.session.queueMessage(
          "owned draft",
          { model: TEST_MODEL, agentId: "exec" },
          {
            compactionAdmissionStale: () => admission(),
            refreshCompactionAdmission: (isStale) => {
              admission = isStale;
            },
            onAcceptedPreStreamFailure: () => failed.resolve(),
          }
        );
        const first = h.session.interruptStream({
          onCompactionCanceled: (receipt) => {
            capture = receipt;
          },
        });
        const ownAdmission = h.session.captureCompactionAdmission("manual");
        expect(await first).toEqual(Ok(undefined));
        expect(capture).toBeDefined();
        if (kind === "local") expect(await h.session.interruptStream()).toEqual(Ok(undefined));
        else
          await new CompactionCancellation(
            h.historyService.getCompactionCancellationStorage(workspaceId)
          ).cancel();
        const successor = await h.historyService
          .getCompactionCancellationStorage(workspaceId)
          .read();
        h.session.sendNextUserQueuedMessage({ isStale: ownAdmission, readCapture: () => capture });
        expect(
          await waitForCondition(
            () =>
              stream.mock.calls.length > 0 ||
              h.events.some((event) => event.type === "restore-to-input")
          )
        ).toBe(true);
        expect(stream).not.toHaveBeenCalled();
        await failed.promise;
        await h.session.waitForIdle();
        expect(
          h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
        ).toEqual(["owned draft"]);
        expect(await h.historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
        expect(await h.historyService.getCompactionCancellationStorage(workspaceId).read()).toEqual(
          successor
        );
        expect(stream).not.toHaveBeenCalled();
      } finally {
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["Stop retry", "capture"] as const)(
    "Send Now restores unpublished input after a fresh admission fails at %s",
    async (failure) => {
      const workspaceId = `queue-send-now-failure-${failure}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const accepted = mock(() => undefined);
      const failed = Promise.withResolvers<void>();
      const stream = spyOn(h.aiService, "streamMessage");
      let admission = h.session.captureCompactionAdmission("manual");
      let refreshed = false;
      // Record the queue's original frontier before injecting failure into Send Now's
      // explicit fresh acquisition; eager queue capture must not consume the fault.
      const original = await h.historyService.captureCompactionReplacement(workspaceId);
      const injection =
        failure === "Stop retry"
          ? spyOn(FileCompactionCancellationStorage.prototype, "mutate").mockImplementation(() =>
              Promise.reject(new Error("Stop persistence unavailable"))
            )
          : spyOn(h.historyService, "captureCompactionReplacement").mockResolvedValueOnce(
              Err("capture unavailable")
            );
      try {
        expect(original.success).toBe(true);
        h.session.queueMessage(
          "send now draft",
          { model: TEST_MODEL, agentId: "exec" },
          {
            readCompactionAdmission: () => Promise.resolve(original),
            compactionAdmissionStale: () => admission(),
            refreshCompactionAdmission: () => {
              admission = h.session.captureCompactionAdmission("manual");
              refreshed = true;
            },
            onAccepted: accepted,
            onAcceptedPreStreamFailure: () => failed.resolve(),
          }
        );
        expect((await h.session.cancelCompaction()).success).toBe(failure !== "Stop retry");
        expect(h.session.sendNextUserQueuedMessage()).toBe(true);
        await failed.promise;
        await h.session.waitForIdle();
        expect(refreshed).toBe(failure !== "capture");
        expect(admission()).toBe(failure === "capture");
        expect(
          h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
        ).toEqual(["send now draft"]);
        expect(await h.historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
        expect(accepted).not.toHaveBeenCalled();
        expect(stream).not.toHaveBeenCalled();
      } finally {
        injection.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each([false, true])(
    "queued gate rejection restores only an unwritten row (write fails=%s)",
    async (writeFails) => {
      const workspaceId = `queue-rejected-publication-${writeFails}`;
      const h = await createAgentSessionHarness({
        workspaceId,
        captureEvents: true,
        workspaceGoalService: {
          assertPricedModelForBudgetedGoal: () =>
            Promise.resolve(Err({ type: "unknown", raw: "pricing refused" })),
        } as unknown as WorkspaceGoalService,
      });
      const failed = Promise.withResolvers<void>();
      const goalSafety = spyOn(
        h.session as unknown as {
          applyManualUserMessageGoalSafety(): Promise<void>;
        },
        "applyManualUserMessageGoalSafety"
      ).mockResolvedValue(undefined);
      const append = writeFails
        ? spyOn(h.historyService, "acceptCompactionReplacement").mockResolvedValueOnce(
            Err("disk unavailable")
          )
        : undefined;
      try {
        h.session.queueMessage(
          "rejected draft",
          { model: TEST_MODEL, agentId: "exec" },
          {
            onAcceptedPreStreamFailure: () => failed.resolve(),
          }
        );
        h.session.sendQueuedMessages();
        await failed.promise;
        await h.session.waitForIdle();
        expect(
          h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
        ).toEqual(writeFails ? ["rejected draft"] : []);
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success && history.data.filter((row) => row.role === "user")).toHaveLength(
          writeFails ? 0 : 1
        );
      } finally {
        append?.mockRestore();
        goalSafety.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each([false, true])(
    "Send Now refreshes the queued capture and restores only a later Stop (stopped=%s)",
    async (stopped) => {
      const workspaceId = `queue-send-now-stop-${stopped}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
      const held = spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await capture(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
      );
      const stream = spyOn(h.aiService, "streamMessage");
      const accepted = Promise.withResolvers<void>();
      let admission = h.session.captureCompactionAdmission("manual");
      try {
        h.session.queueMessage(
          "send now input",
          { model: TEST_MODEL, agentId: "exec" },
          {
            compactionAdmissionStale: () => admission(),
            refreshCompactionAdmission: () => {
              admission = h.session.captureCompactionAdmission("manual");
            },
            onAccepted: () => accepted.resolve(),
          }
        );
        expect(await h.session.cancelCompaction()).toEqual(Ok(undefined));
        expect(h.session.sendNextUserQueuedMessage()).toBe(true);
        await entered.promise;
        if (stopped) {
          expect(await h.session.interruptStream()).toEqual(Ok(undefined));
          h.session.restoreQueueToInput();
        }
        release.resolve();
        if (stopped) await h.session.waitForIdle();
        else {
          await accepted.promise;
          // Once the row is durable, a later Stop must not offer it as unsent input again.
          expect(await h.session.cancelCompaction()).toEqual(Ok(undefined));
          h.session.restoreQueueToInput();
        }
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success && history.data.filter((row) => row.role === "user")).toHaveLength(
          stopped ? 0 : 1
        );
        expect(
          h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
        ).toEqual(stopped ? ["send now input"] : []);
        if (stopped) expect(stream).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        held.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["automatic-visible", "automatic-hidden", "caller-canceled", "caller-stale"] as const)(
    "Stop does not restore a dequeued %s candidate over later manual input",
    async (kind) => {
      const workspaceId = `queue-stop-control-${kind}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let stale = false;
      const send = h.session.sendMessage.bind(h.session);
      const held = spyOn(h.session, "sendMessage").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return send(...args);
      });
      const stream = spyOn(h.aiService, "streamMessage");
      try {
        h.session.queueMessage(
          "revoked candidate",
          { model: TEST_MODEL, agentId: "exec" },
          {
            acceptanceOrigin: kind.startsWith("automatic") ? "automatic" : "manual",
            synthetic: kind === "automatic-hidden",
            cancelSignal: controller.signal,
            admissionStale: () => stale,
          }
        );
        h.session.queueMessage("later manual", { model: TEST_MODEL, agentId: "exec" });
        h.session.sendQueuedMessages();
        await entered.promise;
        if (kind === "caller-canceled") controller.abort();
        if (kind === "caller-stale") stale = true;
        expect(await h.session.interruptStream()).toEqual(Ok(undefined));
        h.session.restoreQueueToInput();
        release.resolve();
        await h.session.waitForIdle();
        expect(h.events.filter((event) => event.type === "restore-to-input")).toMatchObject([
          { text: "later manual", fileParts: [] },
        ]);
        expect(await h.historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
        expect(stream).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        held.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["held", "refused", "raw command"] as const)(
    "Stop restores dequeued manual input and later queued input together (%s)",
    async (restoreAt) => {
      const workspaceId = `queue-stop-restore-${restoreAt}`;
      const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
      const held = spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await capture(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
      );
      const stream = spyOn(h.aiService, "streamMessage");
      const accepted = mock(() => undefined);
      const fileParts = [{ url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }];
      const laterFileParts = [{ url: "data:text/plain;base64,dGFpbA==", mediaType: "text/plain" }];
      const reviews = [
        { filePath: "src/file.ts", lineRange: "1", selectedCode: "call()", userNote: "check this" },
      ];
      try {
        h.session.queueMessage(
          "first\nsecond",
          {
            model: TEST_MODEL,
            agentId: "exec",
            fileParts,
            muxMetadata:
              restoreAt === "raw command"
                ? {
                    type: "agent-skill",
                    rawCommand: "/init",
                    skillName: "init",
                    scope: "built-in",
                    reviews,
                  }
                : { type: "normal", reviews },
          },
          {
            onAccepted: accepted,
          }
        );
        h.session.queueMessage("later input", {
          model: TEST_MODEL,
          agentId: "exec",
          fileParts: laterFileParts,
        });
        h.session.sendQueuedMessages();
        await entered.promise;
        expect(h.session.queuedMessageEntryCount()).toBe(1);
        expect(await h.session.interruptStream()).toEqual(Ok(undefined));
        if (restoreAt === "held") h.session.restoreQueueToInput();
        release.resolve();
        await h.session.waitForIdle();
        if (restoreAt === "refused") h.session.restoreQueueToInput();
        expect(h.events.filter((event) => event.type === "restore-to-input")).toEqual([
          {
            type: "restore-to-input",
            workspaceId,
            text: `${restoreAt === "raw command" ? "/init" : "first\nsecond"}\nlater input`,
            fileParts: [...fileParts, ...laterFileParts],
            reviews,
          },
        ]);
        expect(await h.historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
        expect(stream).not.toHaveBeenCalled();
        expect(accepted).not.toHaveBeenCalled();
        expect(h.session.hasQueuedMessages()).toBe(false);
      } finally {
        release.resolve();
        held.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test("a queued provider startup failure drains its successor after accepted-turn cleanup", async () => {
    const successor = Promise.withResolvers<void>();
    let calls = 0;
    const streamMessage = mock(() => {
      if (++calls === 1)
        return Promise.resolve(
          Err({ type: "api_key_not_found" as const, provider: "anthropic" as const })
        );
      successor.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-provider-startup-failure",
      aiServiceOverrides: { streamMessage },
    });
    try {
      session.queueMessage(
        "failed startup",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      session.queueMessage("successor", { model: TEST_MODEL, agentId: "exec" });
      session.sendQueuedMessages();
      await successor.promise;
      await session.waitForIdle();
      expect(calls).toBe(2);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test.each(["returned error", "rejection"] as const)(
    "reserves queued startup synchronously and drains after %s cleanup",
    async (failureKind) => {
      const workspaceId = `queue-prestart-${failureKind}`;
      const failureEntered = Promise.withResolvers<void>();
      const releaseFailure = Promise.withResolvers<void>();
      const successorStarted = Promise.withResolvers<void>();
      const streamMessage = mock(() => {
        successorStarted.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
      });
      const { session, historyService, cleanup } = await createAgentSessionHarness({
        workspaceId,
        aiServiceOverrides: { streamMessage },
      });
      const append = spyOn(historyService, "appendToHistory");
      if (failureKind === "returned error") {
        append.mockResolvedValueOnce(Err("disk unavailable"));
      } else {
        append.mockRejectedValueOnce(new Error("disk unavailable"));
      }
      const failures: unknown[] = [];

      try {
        session.queueMessage(
          "failed head",
          { model: TEST_MODEL, agentId: "exec" },
          {
            acceptanceOrigin: "automatic",
            synthetic: true,
            onAcceptedPreStreamFailure: async (error) => {
              failures.push(error);
              failureEntered.resolve();
              await releaseFailure.promise;
            },
          }
        );
        session.queueMessage("surviving successor", { model: TEST_MODEL, agentId: "exec" });
        session.sendQueuedMessages();

        // Admission must cover the first await, or another caller can bypass this FIFO head.
        expect(session.isBusy()).toBe(true);
        expect(session.isPreparingTurn()).toBe(true);
        expect(append).not.toHaveBeenCalled();

        await failureEntered.promise;
        expect(session.isBusy()).toBe(true);
        expect(session.queuedMessageEntryCount()).toBe(1);
        expect(streamMessage).not.toHaveBeenCalled();
        expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));

        // No stream-end will arrive for the failed head. Cleanup must finish before its
        // successor persists, then the queue must make progress without an external nudge.
        releaseFailure.resolve();
        await successorStarted.promise;
        await session.waitForIdle();
        expect(failures).toHaveLength(1);
        expect(streamMessage).toHaveBeenCalledTimes(1);
        expect(session.hasQueuedMessages()).toBe(false);
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success).toBe(true);
        if (!history.success) throw new Error(history.error);
        expect(history.data).toMatchObject([
          { role: "user", parts: [{ type: "text", text: "surviving successor" }] },
        ]);
      } finally {
        releaseFailure.resolve();
        append.mockRestore();
        await session.dispose();
        await cleanup();
      }
    }
  );

  test.each([
    { effectiveModel: undefined, metadataModel: undefined },
    { effectiveModel: "anthropic:claude-opus-4-1", metadataModel: undefined },
    // A Coder runtime ID has no catalog price; the request-pinned identity must price it.
    { effectiveModel: "coder:acme/opus", metadataModel: "anthropic:claude-opus-4-1" },
  ])(
    "accounts aborted usage against the effective model $effectiveModel priced as $metadataModel",
    async ({ effectiveModel, metadataModel }) => {
      const workspaceId = "abort-effective-model";
      const aiEmitter = new EventEmitter();
      const accounting = Promise.withResolvers<number>();
      const completion = Promise.withResolvers<TurnCompletion>();
      const workspaceGoalService = {
        assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
        recordStreamAccounting: mock((input: { costUsd: number }) => {
          accounting.resolve(input.costUsd);
          return Promise.resolve();
        }),
        applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
        requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
        recordStreamStarted: mock(() => Promise.resolve()),
        syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
      } as unknown as WorkspaceGoalService;
      const { session, cleanup } = await createAgentSessionHarness({
        workspaceId,
        aiEmitter,
        workspaceGoalService,
        aiServiceOverrides: {
          streamMessage: mock(() => {
            aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
            return Promise.resolve(
              Ok({ messageId: "assistant-1", completion: completion.promise })
            );
          }),
        },
      });
      try {
        expect(
          (
            await session.sendMessage(
              "start",
              { model: TEST_MODEL, agentId: "exec" },
              { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
            )
          ).success
        ).toBe(true);
        const usage = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
        completion.resolve({
          status: "aborted",
          abortReason: "system",
          streamAbort: {
            type: "stream-abort",
            workspaceId,
            metadata: { duration: 1, usage, model: effectiveModel, metadataModel },
          },
        });
        const expectedCost =
          getTotalCost(
            createDisplayUsage(usage, effectiveModel ?? TEST_MODEL, undefined, metadataModel)
          ) ?? 0;
        expect(expectedCost).toBeGreaterThan(0);
        expect(await accounting.promise).toBe(expectedCost);
        await session.waitForIdle();
      } finally {
        await session.dispose();
        await cleanup();
      }
    }
  );

  test("counts only a different direct preparing send as a superseding predecessor", async () => {
    const sessionHolder: {
      current?: {
        hasQueuedOrDispatchingEntry(
          continuationMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
        hasPendingWorkspaceTurnContinuation(
          continuationMetadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
      };
    } = {};
    let preparingState:
      | {
          sameTurn: boolean;
          differentTurn: boolean;
          uncorrelated: boolean;
          pendingSameTurn: boolean;
          pendingDifferentTurn: boolean;
        }
      | undefined;
    const streamMessage = mock(() => {
      const observedSession = sessionHolder.current;
      preparingState = {
        sameTurn: observedSession?.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION) === true,
        differentTurn:
          observedSession?.hasQueuedOrDispatchingEntry({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
        uncorrelated: observedSession?.hasQueuedOrDispatchingEntry() === true,
        pendingSameTurn:
          observedSession?.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION) === true,
        pendingDifferentTurn:
          observedSession?.hasPendingWorkspaceTurnContinuation({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
      };
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-preparing-predecessor",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    sessionHolder.current = session;

    try {
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
      const result = await session.sendMessage("direct send", {
        model: TEST_MODEL,
        agentId: "exec",
        muxMetadata: WORKSPACE_TURN_CORRELATION,
      });

      expect(result.success).toBe(true);
      expect(preparingState).toEqual({
        sameTurn: false,
        differentTurn: true,
        uncorrelated: true,
        pendingSameTurn: true,
        pendingDifferentTurn: false,
      });
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("preserves correlation for same-turn queued and dequeued predecessors", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-same-turn-predecessor",
    });
    const differentCorrelation = {
      ...WORKSPACE_TURN_CORRELATION,
      turnId: "turn-different",
    };

    try {
      session.queueMessage(
        "queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);

      session.queueMessage(
        "second queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);

      session.queueMessage(
        "unrelated predecessor",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
        }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);

      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);
      sendMessage.mockRestore();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter reports an engaged no-metadata dispatch over a queued follow-up", async () => {
    // Queue-cut attribution must never blame an entry queued BEHIND the input
    // actually taking over the session: a manual message being dispatched wins
    // over a workspace-turn follow-up waiting behind it, even though its
    // metadata is undefined.
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-preparing",
    });

    try {
      expect(session.getQueueCutCutter()).toBeUndefined();

      session.queueMessage(
        "manual message",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { acceptanceOrigin: "automatic", synthetic: true }
      );

      // Queued stage: the manual head entry is the candidate (no metadata).
      const queued = session.getQueueCutCutter();
      expect(queued?.stage).toBe("queued");
      expect(queued?.muxMetadata).toBeUndefined();

      // Dispatch the manual entry: it becomes the engaged PREPARING cutter and
      // keeps winning over the follow-up still queued behind it.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect(engaged?.muxMetadata).toBeUndefined();
      sendMessage.mockRestore();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter reports a no-metadata mid-dispatch entry over a queued follow-up", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-dispatching",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      // Force the dequeue-to-stream-start window with PREPARING already
      // released (a background send can resolve before stream-start): the
      // dispatched entry stays the engaged cutter.
      const internal = session as unknown as {
        dispatchingQueuedEntry: boolean;
        dispatchingQueuedEntryMuxMetadata?: unknown;
      };
      internal.dispatchingQueuedEntry = true;
      internal.dispatchingQueuedEntryMuxMetadata = undefined;

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("dispatching");
      expect(cutter?.muxMetadata).toBeUndefined();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter exposes the queued head's dispatch mode and correlation", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-queued",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: WORKSPACE_TURN_CORRELATION,
          queueDispatchMode: "turn-end",
        },
        { acceptanceOrigin: "automatic", synthetic: true }
      );

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("queued");
      expect(cutter?.stage === "queued" ? cutter.dispatchMode : undefined).toBe("turn-end");
      expect((cutter?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );

      // Once dispatched, the follow-up's correlation rides through PREPARING.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect((engaged?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );
      sendMessage.mockRestore();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("waits for stream-end instead of interrupting between sibling tool results", async () => {
    const workspaceId = "queue-dispatch-full-step";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "tool-call-2",
      });

      expect(stopStream).not.toHaveBeenCalled();
      expect(sendQueuedMessages).not.toHaveBeenCalled();

      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "tool-calls",
        },
      });

      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("soft-stops after a provider-executed tool result and dispatches after abort", async () => {
    const workspaceId = "queue-dispatch-provider-tool";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });

      expect(stopStream).toHaveBeenCalledWith(workspaceId, {
        soft: true,
        abortReason: "system",
      });

      void runSessionTerminalPolicy(session, aiEmitter, streamAbortEvent(workspaceId, "system"));
      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("withdrawn tool-end entry neither soft-stops nor hides a later entry's mode", async () => {
    const workspaceId = "queue-dispatch-withdrawn-head";
    const queuedSignals: boolean[] = [];
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
      backgroundProcessManagerOverrides: {
        setMessageQueued: mock((_workspaceId: string, queued: boolean) => {
          queuedSignals.push(queued);
        }),
      },
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "tool-end" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
        }
      );
      expect(session.hasQueuedMessages("tool-end")).toBe(true);

      controller.abort("monitor withdrawn");
      expect(session.hasQueuedMessages("tool-end")).toBe(false);
      expect(session.hasQueuedMessages()).toBe(false);

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).not.toHaveBeenCalled();

      session.queueMessage("follow up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(session.hasQueuedMessages("tool-end")).toBe(false);
      expect(session.hasQueuedMessages("turn-end")).toBe(true);
      expect(queuedSignals).toEqual([true, false]);
    } finally {
      stopStream.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test.each([
    ["turn-end", "tool-end"],
    ["tool-end", "turn-end"],
  ] as const)(
    "queueMessage reports the live entry's mode behind a withdrawn %s head",
    async (withdrawnMode, liveMode) => {
      const { session, cleanup } = await createAgentSessionHarness({
        workspaceId: "queue-dispatch-withdrawn-" + withdrawnMode + "-head",
      });
      try {
        const controller = new AbortController();
        session.queueMessage(
          "Background monitor wake",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: withdrawnMode },
          {
            acceptanceOrigin: "automatic",
            synthetic: true,
            agentInitiated: true,
            cancelSignal: controller.signal,
          }
        );
        controller.abort("monitor withdrawn");

        expect(
          session.queueMessage("follow up", {
            model: TEST_MODEL,
            agentId: "exec",
            queueDispatchMode: liveMode,
          })
        ).toBe(liveMode);
      } finally {
        await session.dispose();
        await cleanup();
      }
    }
  );

  test("waits for every known sibling before stopping after a provider-executed result", async () => {
    const workspaceId = "queue-dispatch-provider-siblings";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).not.toHaveBeenCalled();

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);
    } finally {
      stopStream.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  // Heartbeat force-queue drain path: a scheduled message queued while the session is IDLE
  // (e.g. a heartbeat deferred behind active descendant tasks) must ride along with the next
  // turn and drain at its stream-end, releasing the dedupe key so the next firing can enqueue.
  test("drains an idle-queued deduped message at the next turn's stream-end", async () => {
    const workspaceId = "queue-dispatch-idle-queued-drain";
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
    });
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));

    try {
      expect(session.isBusy()).toBe(false);
      const dispatchMode = session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { acceptanceOrigin: "automatic", synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(dispatchMode).toBe("turn-end");
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(true);

      // A duplicate firing while pending is dropped (coalescing).
      expect(
        session.queueMessage(
          "[Scheduled heartbeat] check in",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
          { acceptanceOrigin: "automatic", synthetic: true, dedupeKey: "heartbeat-request" }
        )
      ).toBeNull();

      // The next turn (e.g. a descendant-task terminal wake) starts and ends.
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [{ type: "text", text: "wake turn done" }],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "stop",
        },
      });

      const didDrain = await waitForCondition(
        () =>
          sendMessage.mock.calls.some((call) => call[0] === "[Scheduled heartbeat] check in") &&
          !session.hasQueuedMessages()
      );
      expect(didDrain).toBe(true);
      // Queue clear released the dedupe key: the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);
    } finally {
      sendMessage.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("updates visible queued dispatch mode without dequeuing content", async () => {
    const workspaceId = "queue-dispatch-mode-update";
    const setMessageQueued = mock((_workspaceId: string, _queued: boolean) => undefined);
    const { session, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      backgroundProcessManagerOverrides: { setMessageQueued },
    });

    try {
      session.queueMessage(
        "hidden predecessor",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      session.queueMessage("my queued follow-up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "tool-end",
      });

      expect(session.setQueuedMessageDispatchMode("tool-end")).toBe(true);
      const toolEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(toolEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "tool-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, true);
      expect(session.hasQueuedMessages()).toBe(true);

      expect(session.setQueuedMessageDispatchMode("turn-end")).toBe(true);
      const turnEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(turnEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "turn-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, false);
      expect(session.hasQueuedMessages()).toBe(true);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("restoreQueueToInput discards a queued heartbeat instead of restoring it", async () => {
    const workspaceId = "queue-dispatch-restore-discards-heartbeat";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { acceptanceOrigin: "automatic", synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(session.hasQueuedMessages()).toBe(true);

      const restoredTexts: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      // A user interrupt restores queued input to the composer — the backend-initiated
      // heartbeat must be discarded, not surfaced as editable user text.
      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual([]);
      expect(session.hasQueuedMessages()).toBe(false);
      // Dropping released the dedupe key so the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);

      // Plain user input still restores.
      session.queueMessage("my own words", { model: TEST_MODEL, agentId: "exec" });
      const unsubscribeUser = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });
      session.restoreQueueToInput();
      unsubscribeUser();
      expect(restoredTexts).toEqual(["my own words"]);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("synthetic background entries neither surface in queue UI nor restore over user input", async () => {
    const workspaceId = "queue-dispatch-hide-synthetic";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      const queuedSnapshots: string[][] = [];
      const hasQueuedSnapshots: boolean[] = [];
      const restoredTexts: string[] = [];
      const canceledReasons: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "queued-message-changed") {
          queuedSnapshots.push(event.message.queuedMessages);
          hasQueuedSnapshots.push(event.message.hasQueuedMessages ?? false);
        }
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );
      expect(hasQueuedSnapshots.at(-1)).toBe(true);
      expect(queuedSnapshots.at(-1)).toEqual([]);

      session.queueMessage("my own words", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(queuedSnapshots.at(-1)).toEqual(["my own words"]);

      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual(["my own words"]);
      expect(canceledReasons).toHaveLength(1);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("cancel signal retracts a synthetic entry after dequeue while history append is preparing", async () => {
    const workspaceId = "queue-dispatch-cancel-preparing";
    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
    });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );

      session.sendQueuedMessages();
      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();

      expect(await waitForCondition(() => canceledReasons.length === 1)).toBe(true);
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      expect(canceledReasons).toEqual(["monitor canceled"]);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.role === "user" &&
            event.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
        )
      ).toBe(false);
    } finally {
      releaseAppend();
      appendSpy.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("rollback failure preserves the wake and continues acceptance", async () => {
    const workspaceId = "queue-dispatch-cancel-rollback-failure";
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
    });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockResolvedValue(
      Err("injected rollback failure")
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);
      // Accepted but withdrawn: the row stays durable and no turn starts.
      expect(streamMessage).not.toHaveBeenCalled();
      expect(session.isBusy()).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("verifies a committed rollback when batch deletion reports a post-write failure", async () => {
    const workspaceId = "queue-dispatch-cancel-post-write-failure";
    const { session, cleanup, historyService } = await createAgentSessionHarness({ workspaceId });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    const originalDeleteMessages = historyService.deleteMessages.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockImplementation(
      async (...args) => {
        const result = await originalDeleteMessages(...args);
        expect(result.success).toBe(true);
        return Err("injected post-write failure");
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual(["monitor canceled"]);
      expect(cancelState.canceledBeforeAcceptance).toBe(true);
      expect(accepted).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("cancellation during goal sync crosses the acceptance point of no return", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-reconcile";
    let markInitialSyncStarted: () => void = () => undefined;
    const initialSyncStarted = new Promise<void>((resolve) => {
      markInitialSyncStarted = resolve;
    });
    let releaseInitialSync: () => void = () => undefined;
    const initialSyncRelease = new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    });
    let syncCalls = 0;
    const syncGoalModeWithChatTail = mock(async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        markInitialSyncStarted();
        await initialSyncRelease;
      }
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
      aiServiceOverrides: { streamMessage },
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await initialSyncStarted;
      controller.abort("monitor canceled");
      releaseInitialSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(syncGoalModeWithChatTail).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);
      expect(streamMessage).not.toHaveBeenCalled();
      expect(session.isBusy()).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      const wakeRow = history.success
        ? history.data.find((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        : undefined;
      expect(wakeRow).toBeDefined();

      // The accepted row has no assistant follow-up, so startup recovery would otherwise treat
      // it as an interrupted turn and replay the withdrawn wake.
      const preferencePath = (
        session as unknown as { getAutoRetryPreferencePath: () => string }
      ).getAutoRetryPreferencePath();
      const persisted = (await Bun.file(preferencePath).json()) as {
        startupAutoRetryAbandon?: unknown;
      };
      expect(persisted.startupAutoRetryAbandon).toEqual({
        reason: "aborted",
        userMessageId: wakeRow?.id,
      });
    } finally {
      releaseInitialSync();
      await session.dispose();
      await cleanup();
    }
  });

  test("a wake whose admission goes stale during goal sync is finalized, not left owed", async () => {
    const workspaceId = "queue-dispatch-stale-after-goal-sync";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
      aiServiceOverrides: { streamMessage },
    });

    try {
      const controller = new AbortController();
      // Stands in for the requireIdle preflight probe: a manual send enters preflight while the
      // wake's durable row is already past the rollback horizon.
      let manualSendInPreflight = false;
      let accepted = false;
      let preStreamFailures = 0;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          admissionStale: () => manualSendInPreflight,
          onAccepted: () => {
            accepted = true;
          },
          onAcceptedPreStreamFailure: () => {
            preStreamFailures += 1;
          },
        }
      );

      await syncStarted;
      manualSendInPreflight = true;
      releaseSync();
      const result = await sendPromise;

      expect(result.success).toBe(false);
      expect(accepted).toBe(true);
      expect(preStreamFailures).toBe(1);
      expect(streamMessage).not.toHaveBeenCalled();
      expect(session.isBusy()).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseSync();
      await session.dispose();
      await cleanup();
    }
  });

  test("a wake withdrawn under on-send compaction records the persisted compaction row as abandoned", async () => {
    const workspaceId = "queue-dispatch-withdrawn-compaction-row";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail: mock(async () => {
        markSyncStarted();
        await syncRelease;
        return null;
      }),
    } as unknown as WorkspaceGoalService;
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
      aiServiceOverrides: { streamMessage },
    });
    const internals = session as unknown as {
      compactionMonitor: CompactionMonitor;
      getAutoRetryPreferencePath(): string;
    };
    internals.compactionMonitor = {
      checkBeforeSend: () => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      }),
      checkMidStream: () => false,
      resetForNewStream: () => undefined,
      setThreshold: () => undefined,
      getThreshold: () => 0.85,
    } as unknown as CompactionMonitor;

    try {
      const controller = new AbortController();
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
        }
      );
      await syncStarted;
      // A Stop withdraws the wake past the point of no return.
      controller.abort();
      releaseSync();
      expect((await sendPromise).success).toBe(true);
      expect(streamMessage).not.toHaveBeenCalled();

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const trailing = history.data.at(-1);
      expect(trailing?.metadata?.muxMetadata?.type).toBe("compaction-request");
      const persisted = JSON.parse(
        await fsPromises.readFile(internals.getAutoRetryPreferencePath(), "utf-8")
      ) as { startupAutoRetryAbandon?: { userMessageId?: string } };
      expect(persisted.startupAutoRetryAbandon?.userMessageId).toBe(trailing?.id);
    } finally {
      releaseSync();
      await session.dispose();
      await cleanup();
    }
  });

  test("disposed sessions finalize durable wakes after goal sync completes", async () => {
    const workspaceId = "queue-dispatch-disposed-after-goal-sync";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      session.beginDispose();
      releaseSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(accepted).toBe(true);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
    } finally {
      releaseSync();
      await session.dispose();
      await cleanup();
    }
  });

  test("every goal sync failure after the boundary finalizes the durable wake", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-sync-failure";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      throw new Error("injected goal sync failure");
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          withdrawAcceptedOnCancel: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      // Accepted before goal sync began: a crash anywhere past the durable row leaves an accepted
      // row, never one the reconciler's transcript lookup would misread as delivered.
      expect(accepted).toBe(true);
      releaseSync();
      let syncError: unknown;
      try {
        await sendPromise;
      } catch (error) {
        syncError = error;
      }
      expect(syncError).toBeInstanceOf(Error);
      expect((syncError as Error).message).toContain("injected goal sync failure");

      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseSync();
      await session.dispose();
      await cleanup();
    }
  });

  test("hard user interrupt cancels a pending provider-tool dispatch", async () => {
    const workspaceId = "queue-dispatch-hard-user-interrupt";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);

      const interruptResult = await session.interruptStream();
      expect(interruptResult.success).toBe(true);
      // The native soft-stop can still win the event race after the hard user interrupt.
      void runSessionTerminalPolicy(session, aiEmitter, streamAbortEvent(workspaceId, "system"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      await session.dispose();
      await cleanup();
    }
  });

  test("rejected queued dispatch surfaces through onAcceptedPreStreamFailure", async () => {
    const workspaceId = "queue-dispatch-rejected";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });
    const failures: string[] = [];

    try {
      session.queueMessage(
        "queued peer trigger",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          // Peer sends refund their family-message reservation through this hook; a dispatch
          // that REJECTS (throws) instead of returning Err must reach it just like the
          // returned-error branch, or the reservation is stranded until restart.
          onAcceptedPreStreamFailure: (error) => {
            failures.push(error.type === "unknown" ? error.raw : error.type);
          },
        }
      );
      const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
        Promise.reject(new Error("pricing gate exploded"))
      );
      session.sendQueuedMessages();
      expect(await waitForCondition(() => failures.length === 1)).toBe(true);
      expect(failures[0]).toContain("pricing gate exploded");
      sendMessage.mockRestore();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });
});
