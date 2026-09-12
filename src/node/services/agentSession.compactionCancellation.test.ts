import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fileIO from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { historyWriteLockPath } from "./workspaceRemoval";
import assert from "@/common/utils/assert";
import nodeAssert from "node:assert/strict";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import type { FileChangeTracker } from "./utils/fileChangeTracker";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { TurnCompletion } from "./streamManager";
import type { CompactionMonitor } from "./compactionMonitor";
import type { ContinuousCompactor } from "./continuousCompactor";
import type { TurnCoordinator } from "./turnCoordinator";
import { HistoryService } from "./historyService";
import {
  FileCompactionCancellationStorage,
  type CompactionReplacementCapture,
  CompactionCancellation,
  CompactionCancellationReadRefusedError,
} from "./compactionCancellation";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "cancellation-runtime";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const fixtures: AgentSessionHarness[] = [];

interface Internals {
  compactionMonitor: CompactionMonitor;
  coordinator: TurnCoordinator;
  compactionCancellation: CompactionCancellation;
  fileChangeTracker: FileChangeTracker;
  continuousCompactor: ContinuousCompactor;
  recoverCompaction(): Promise<boolean>;
  interruptForCompaction(): Promise<void>;
  compactionRecoveryBlocked(): Promise<boolean>;
  observeCompaction(
    ...args: Parameters<ContinuousCompactor["observe"]>
  ): ReturnType<ContinuousCompactor["observe"]>;
  dispatchPendingFollowUp(): Promise<boolean>;
  scheduleStartupAutoRetryIfNeeded(): Promise<string>;
}

async function fixture(workspaceGoalService?: WorkspaceGoalService) {
  const h = await createAgentSessionHarness({ workspaceId, workspaceGoalService });
  fixtures.push(h);
  const rows = async () => {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data;
  };
  return {
    ...h,
    stream: spyOn(h.aiService, "streamMessage"),
    rows,
    state: h.session as unknown as Internals,
    storage: h.historyService.getCompactionCancellationStorage(workspaceId),
  };
}

afterEach(async () => {
  mock.restore();
  for (const h of fixtures.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

describe("compaction cancellation runtime", () => {
  test("an unsupported scoped V2 cannot authorize legacy compaction", async () => {
    const h = await fixture();
    await h.session.cancelCompaction();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("canceled-summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
        },
      })
    );
    expect(await h.session.isAutomaticSendBlocked()).toBe(false);
    const stopped = await h.storage.read();
    expect(stopped?.scope.kind).toBe("summary");
    const captured = await h.historyService.captureCompactionReplacement(workspaceId);
    assert(captured.success);
    const unsupported = JSON.stringify({
      ...stopped,
      version: 2,
      settledGeneration: captured.data.generation,
    });
    await fileIO.writeFile(h.storage.path, unsupported);
    const before = await h.rows();
    spyOn(h.state.compactionMonitor, "getThreshold").mockReturnValue(0.7);
    spyOn(h.state.compactionMonitor, "checkBeforeSend").mockReturnValue({
      shouldShowWarning: true,
      shouldForceCompact: true,
      usagePercentage: 95,
      contextTokens: 95_000,
      maxTokens: 100_000,
      thresholdPercentage: 70,
    });
    expect(
      (
        await h.session.sendMessage("fresh automatic input", options, {
          acceptanceOrigin: "automatic",
        })
      ).success
    ).toBe(false);
    expect(await h.rows()).toEqual(before);
    expect(await fileIO.readFile(h.storage.path, "utf8")).toBe(unsupported);
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each([95, 10])(
    "automatic input preserves scoped Stop cleanup debt at %s percent usage",
    async (usagePercentage) => {
      const h = await fixture();
      await h.session.cancelCompaction();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("canceled-summary", "assistant", "summary", {
          compactionBoundary: true,
          compacted: "user",
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
          },
        })
      );
      expect(await h.session.isAutomaticSendBlocked()).toBe(false);
      const stopped = await h.storage.read();
      expect(stopped?.scope.kind).toBe("summary");
      const before = await h.rows();
      const cleanup = spyOn(h.historyService, "cleanupCompactionFollowUp").mockResolvedValue(
        Err("injected cleanup failure")
      );
      const failedCleanup = await h.session
        .dispatchPendingCompactionFollowUpIfNeeded()
        .catch((error: unknown) => String(error));
      expect(failedCleanup).toContain("injected cleanup failure");
      spyOn(h.state.compactionMonitor, "getThreshold").mockReturnValue(0.7);
      spyOn(h.state.compactionMonitor, "checkBeforeSend").mockReturnValue({
        shouldShowWarning: usagePercentage > 70,
        shouldForceCompact: usagePercentage > 70,
        usagePercentage,
        contextTokens: usagePercentage * 1_000,
        maxTokens: 100_000,
        thresholdPercentage: 70,
      });
      expect(
        await h.session.sendMessage("fresh automatic input", options, {
          acceptanceOrigin: "automatic",
        })
      ).toEqual(Ok(undefined));
      const after = await h.rows();
      expect(after[0]).toEqual(before[0]);
      expect(after.filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
      expect(after.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
        false
      );
      expect(
        after.at(-1)?.parts.map((part) => (part.type === "text" ? part.text : part.type))
      ).toEqual(["fresh automatic input"]);
      expect(h.stream).toHaveBeenCalledTimes(1);
      expect(await h.storage.read()).toEqual(stopped);

      cleanup.mockRestore();
      await h.session.dispose();
      const restarted = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      fixtures.push(restarted);
      expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
      expect(await h.storage.read()).toBeNull();
      expect((await h.rows())[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
    }
  );

  test("automatic input still starts legacy compaction without cancellation debt", async () => {
    const h = await fixture();
    spyOn(h.state.compactionMonitor, "getThreshold").mockReturnValue(0.7);
    spyOn(h.state.compactionMonitor, "checkBeforeSend").mockReturnValue({
      shouldShowWarning: true,
      shouldForceCompact: true,
      usagePercentage: 95,
      contextTokens: 95_000,
      maxTokens: 100_000,
      thresholdPercentage: 70,
    });
    expect(
      await h.session.sendMessage("fresh automatic input", options, {
        acceptanceOrigin: "automatic",
      })
    ).toEqual(Ok(undefined));
    expect(
      (await h.rows()).some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(true);
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  test.each(["send", "resume"] as const)(
    "manual %s retains published input but refuses foreign Stop during attachment preparation",
    async (intent) => {
      const h = await fixture();
      if (intent === "resume") {
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("retry-input", "user", "already published input")
        );
      }
      const foreign = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      const detect = h.state.fileChangeTracker.getChangedAttachments.bind(
        h.state.fileChangeTracker
      );
      spyOn(h.state.fileChangeTracker, "getChangedAttachments").mockImplementationOnce(async () => {
        const detected = await detect();
        // This await is after acceptance, inside streamWithHistory. The local session
        // receives no interrupt notification from the second backend.
        await foreign.cancel();
        return detected;
      });
      const result =
        intent === "send"
          ? await h.session.sendMessage("already published input", options)
          : await h.session.resumeStream(options);
      expect(result.success).toBe(false);
      expect(
        (await h.rows())
          .filter((row) => row.role === "user")
          .map((row) => row.parts.map((part) => (part.type === "text" ? part.text : part.type)))
      ).toEqual([["already published input"]]);
      expect(h.stream).not.toHaveBeenCalled();
      expect(await foreign.read()).not.toBeNull();
    }
  );

  test.each([false, true])(
    "late compaction completion keeps its original frontier after foreign Stop (retired=%s)",
    async (retired) => {
      const h = await fixture();
      const completed = Promise.withResolvers<TurnCompletion>();
      h.stream.mockResolvedValueOnce(
        Ok({ messageId: "late-summary", completion: completed.promise })
      );
      const observed = spyOn(h.state.coordinator, "consumeCompletion");
      const followUpContent = {
        text: "authored continuation",
        model: options.model,
        agentId: "exec",
        fileParts: [
          {
            type: "file" as const,
            url: "data:text/plain;base64,YXV0aG9yZWQ=",
            mediaType: "text/plain",
          },
        ],
      };
      expect(
        await h.session.sendMessage("summarize", {
          ...options,
          agentId: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent },
          },
        })
      ).toEqual(Ok(undefined));
      const request = (await h.rows()).find(
        (row) => row.metadata?.muxMetadata?.type === "compaction-request"
      );
      assert(request);
      const original = structuredClone(request);
      const policy = observed.mock.results.at(-1);
      assert(policy?.type === "return");
      const foreign = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      await foreign.cancel();
      const stopped = await foreign.read();
      assert(stopped);
      if (retired) await foreign.retire(stopped.nonce);
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("late-summary", "assistant", "late summary")
      );
      completed.resolve({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model: options.model },
          parts: [{ type: "text", text: "late summary" }],
        },
      });
      await policy.value;
      const persisted = await h.historyService.getLastMessages(workspaceId, 10);
      assert(persisted.success);
      expect(persisted.data.find((row) => row.id === request.id)).toEqual(original);
      expect(
        persisted.data.some(
          (row) =>
            row.metadata?.muxMetadata?.type === "compaction-summary" &&
            row.metadata.muxMetadata.pendingFollowUp !== undefined
        )
      ).toBe(false);
      expect(h.stream).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["unresolved", "retained", "late foreign"] as const)(
    "reset heartbeat preserves history behind %s Stop",
    async (kind) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("before-reset", "user", "keep context")
      );
      if (kind === "late foreign") {
        const gate = h.session.isAutomaticSendBlocked.bind(h.session);
        spyOn(h.session, "isAutomaticSendBlocked").mockImplementationOnce(async () => {
          const blocked = await gate();
          await new CompactionCancellation(h.storage).cancel();
          return blocked;
        });
      } else expect(await h.session.cancelCompaction(kind === "retained")).toEqual(Ok(undefined));
      const result = await h.session.appendHeartbeatContextResetBoundary({
        boundaryText: "reset context",
        pendingFollowUp: { text: "heartbeat", model: options.model, agentId: "exec" },
      });
      expect(result.success).toBe(false);
      expect((await h.rows()).map((row) => row.id)).toEqual(["before-reset"]);
      expect(h.stream).not.toHaveBeenCalled();
      expect(await h.storage.read()).not.toBeNull();
    }
  );

  test.each(["absent", "V1"] as const)(
    "heartbeat reset keeps its original admission across foreign settlement (%s)",
    async (origin) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("before-reset", "user", "keep context")
      );
      const peer = new CompactionCancellation(
        new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
      );
      const published = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<boolean>();
      const stopping =
        origin === "V1"
          ? peer.cancel({ settled: finish.promise, onCaptured: () => published.resolve() })
          : undefined;
      if (stopping) await published.promise;
      const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await capture(...args);
          assert(result.success);
          expect(result.data.cancellationVersion).toBe(origin === "V1" ? 1 : undefined);
          if (stopping) {
            finish.resolve(true);
            await stopping;
          } else await peer.cancel({ settled: Promise.resolve(true) });
          const current = await new HistoryService(h.config).captureCompactionReplacement(
            workspaceId
          );
          assert(current.success);
          expect(current.data.cancellationVersion).toBe(2);
          expect(current.data.generation === result.data.generation).toBe(origin === "V1");
          return result;
        }
      );
      const result = await h.session.appendHeartbeatContextResetBoundary({
        boundaryText: "stale reset",
        pendingFollowUp: { text: "stale heartbeat", ...options },
      });
      expect(result.success).toBe(false);
      expect((await h.rows()).map((row) => row.id)).toEqual(["before-reset"]);
      expect((await h.storage.read())?.version).toBe(2);
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "reset preserves scoped cancellation debt until recovery (restart=%s)",
    async (restart) => {
      const h = await fixture();
      await h.session.cancelCompaction();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("canceled-summary", "assistant", "summary", {
          compactionBoundary: true,
          compacted: "user",
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
          },
        })
      );
      // Ordinary automatic input can be admitted; a reset must keep this debt in the active epoch.
      expect(await h.session.isAutomaticSendBlocked()).toBe(false);
      const stopped = await h.storage.read();
      expect(stopped?.scope.kind).toBe("summary");
      let session = h.session;
      if (restart) {
        await session.dispose();
        const fresh = await createAgentSessionHarness({
          workspaceId,
          config: h.config,
          historyService: new HistoryService(h.config),
        });
        fixtures.push(fresh);
        session = fresh.session;
      }
      const reset = {
        boundaryText: "reset context",
        pendingFollowUp: { text: "fresh heartbeat", model: options.model, agentId: "exec" },
      };
      expect((await session.appendHeartbeatContextResetBoundary(reset)).success).toBe(false);
      expect((await h.rows()).map((row) => row.id)).toEqual(["canceled-summary"]);
      expect(await h.storage.read()).toEqual(stopped);
      expect(await session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
      expect(await h.storage.read()).toBeNull();
      expect((await session.appendHeartbeatContextResetBoundary(reset)).success).toBe(true);
    }
  );

  test.each(
    [false, true].flatMap((restart) =>
      (["present", "missing", "write failure"] as const).map((sidecar) => ({ restart, sidecar }))
    )
  )(
    "fresh reset after settled Stop preserves its follow-up ($restart, $sidecar)",
    async ({ restart, sidecar }) => {
      const h = await fixture();
      expect(await h.session.interruptStream()).toEqual(Ok(undefined));
      const pendingPath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
      if (sidecar === "write failure") {
        await fileIO.mkdir(pendingPath);
        await fileIO.writeFile(path.join(pendingPath, "unrelated"), "preserve");
      }
      const reset = await h.session.appendHeartbeatContextResetBoundary({
        boundaryText: "fresh reset",
        pendingFollowUp: { text: "fresh heartbeat", model: options.model, agentId: "exec" },
      });
      expect(reset.success).toBe(true);
      assert(reset.success);
      if (sidecar === "missing") await fileIO.rm(pendingPath, { force: true });
      let session = h.session;
      if (restart) {
        await session.dispose();
        const fresh = await createAgentSessionHarness({
          workspaceId,
          config: h.config,
          historyService: new HistoryService(h.config),
        });
        fixtures.push(fresh);
        session = fresh.session;
      }
      expect(
        await session.dispatchPendingCompactionFollowUpIfNeeded(reset.data.summaryMessageId)
      ).toBe(true);
      expect(
        (await h.rows()).some(
          (row) =>
            row.role === "user" &&
            row.parts.some((part) => part.type === "text" && part.text === "fresh heartbeat")
        )
      ).toBe(true);
    }
  );

  test("fresh heartbeat recovery preserves durable work when frontier capture fails transiently", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const reset = await h.session.appendHeartbeatContextResetBoundary({
      boundaryText: "fresh reset",
      pendingFollowUp: { text: "retry this heartbeat", model: options.model, agentId: "exec" },
    });
    assert(reset.success);
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
    const durablePaths = [
      path.join(sessionDir, "chat.jsonl"),
      path.join(sessionDir, "post-compaction.json"),
      h.storage.path,
      generationPath,
    ];
    const before = await Promise.all(durablePaths.map((file) => fileIO.readFile(file)));
    const stopped = await h.storage.read();
    expect(stopped?.version).toBe(2);
    let failed = false;
    const readFile = fs.promises.readFile;
    const read = spyOn(fs.promises, "readFile").mockImplementation(
      new Proxy(readFile, {
        apply(target, receiver, args) {
          if (!failed && args[0] === generationPath) {
            failed = true;
            return Promise.reject(
              Object.assign(new Error("transient capture read"), { code: "EACCES" })
            );
          }
          return Reflect.apply(target, receiver, args) as ReturnType<typeof readFile>;
        },
      })
    );
    try {
      const failure = await h.session
        .dispatchPendingCompactionFollowUpIfNeeded(reset.data.summaryMessageId)
        .catch((error: unknown) => error);
      nodeAssert(failure instanceof Error);
      expect(failure.message).toContain("transient capture read");
      expect(failed).toBe(true);
      expect(await h.storage.read()).toEqual(stopped);
      expect(await Promise.all(durablePaths.map((file) => fileIO.readFile(file)))).toEqual(before);
      expect(h.stream).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    expect(
      await h.session.dispatchPendingCompactionFollowUpIfNeeded(reset.data.summaryMessageId)
    ).toBe(true);
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(
      (await h.rows()).filter(
        (row) =>
          row.role === "user" &&
          row.parts.some((part) => part.type === "text" && part.text === "retry this heartbeat")
      )
    ).toHaveLength(1);
  });

  test.each([
    "missing generation",
    "old generation",
    "local Stop",
    "foreign Stop",
    "late foreign Stop",
    "publication failure",
  ] as const)("fresh reset recovery refuses stale authority (%s)", async (change) => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const reset = await h.session.appendHeartbeatContextResetBoundary({
      boundaryText: "fresh reset",
      pendingFollowUp: { text: "fresh heartbeat", model: options.model, agentId: "exec" },
    });
    assert(reset.success);
    const summary = (await h.rows())[0];
    const publicationId = summary.metadata?.compactionPublicationId;
    assert(summary.metadata);
    if (change === "missing generation" || change === "old generation") {
      delete summary.metadata.compactionPublicationId;
      summary.metadata.compactionPublicationGeneration =
        change === "old generation" ? "old" : undefined;
      expect(await h.historyService.updateHistory(workspaceId, summary)).toEqual(Ok(undefined));
      expect((await h.rows())[0].metadata?.compactionPublicationId).toBe(publicationId);
      await h.session.dispose();
    } else if (change === "local Stop") await h.session.cancelCompaction();
    else if (change === "foreign Stop") await new CompactionCancellation(h.storage).cancel();
    let session = h.session;
    if (change === "missing generation" || change === "old generation") {
      const fresh = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      fixtures.push(fresh);
      session = fresh.session;
    }
    if (change === "late foreign Stop") {
      const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          await new CompactionCancellation(h.storage).cancel();
          return accept(...args);
        }
      );
    } else if (change === "publication failure") {
      spyOn(h.historyService, "acceptCompactionReplacement").mockResolvedValueOnce(
        Err("disk unavailable")
      );
    }
    const dispatch = session.dispatchPendingCompactionFollowUpIfNeeded(reset.data.summaryMessageId);
    if (change === "late foreign Stop" || change === "publication failure")
      await nodeAssert.rejects(dispatch);
    else expect(await dispatch).toBe(false);
    expect((await h.rows()).some((row) => row.role === "user")).toBe(false);
    expect(h.stream).not.toHaveBeenCalled();
  });

  test("abandoned outer Stop completion remains V1 and disposal does not join itself", async () => {
    const h = await fixture();
    let finalize: ((success: boolean | Promise<boolean>) => Promise<unknown>) | undefined;
    expect(
      await h.session.interruptStream({
        deferCompactionSettlement: (complete) => {
          finalize = complete;
        },
      })
    ).toEqual(Ok(undefined));
    expect(await h.storage.read()).toMatchObject({ version: 1 });
    await h.session.dispose();
    expect(await finalize?.(true)).toEqual(Ok(undefined));
    expect(await h.storage.read()).toMatchObject({ version: 1 });
  });

  test.each(
    (["complete", "supersede", "dispose"] as const).flatMap((finish) =>
      [false, true].map((physicalSuccess) => ({ finish, physicalSuccess }))
    )
  )(
    "Stop supervises captured startup until $finish (physicalSuccess=$physicalSuccess)",
    async ({ finish, physicalSuccess }) => {
      const h = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const qualified = Promise.withResolvers<void>();
      const notify = mock(() => qualified.resolve());
      h.stream.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return Err({ type: "unknown", raw: "startup failed" });
      });
      const sending = h.session.sendMessage("held startup", options);
      try {
        await entered.promise;
        spyOn(h.aiService, "stopStream").mockResolvedValueOnce(
          physicalSuccess ? Ok(undefined) : Err("stop failed")
        );
        expect(await h.session.interruptStream({ onCompactionSettled: notify })).toEqual(
          physicalSuccess ? Ok(undefined) : Err("stop failed")
        );
        expect(await h.storage.read()).toMatchObject({ version: 1 });
        expect(await h.session.isAutomaticSendBlocked()).toBe(true);
        let disposing: Promise<void> | undefined;
        if (finish === "supersede")
          expect(await h.session.cancelCompaction(true)).toEqual(Ok(undefined));
        if (finish === "dispose") disposing = h.session.dispose();
        release.resolve();
        await sending;
        if (finish === "complete") {
          await qualified.promise;
          expect(await h.storage.read()).toMatchObject({ version: 2 });
          expect(await h.session.isAutomaticSendBlocked()).toBe(false);
        } else {
          await disposing;
          expect(notify).not.toHaveBeenCalled();
          expect(await h.storage.read()).toMatchObject({ version: 1 });
        }
      } finally {
        release.resolve();
        await sending;
      }
    }
  );

  test.each(["foreign Stop", "generation"] as const)(
    "a superseded deferred Stop cannot notify (%s)",
    async (superseded) => {
      const h = await fixture();
      const notify = mock(() => undefined);
      let finalize: ((complete: boolean | Promise<boolean>) => Promise<unknown>) | undefined;
      expect(
        await h.session.interruptStream({
          onCompactionSettled: notify,
          deferCompactionSettlement: (complete) => {
            finalize = complete;
          },
        })
      ).toEqual(Ok(undefined));
      if (superseded === "foreign Stop") await new CompactionCancellation(h.storage).cancel();
      else await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      const successor = await h.storage.read();
      const finished = Promise.withResolvers<void>();
      const enter = h.state.coordinator.enterExecution.bind(h.state.coordinator);
      spyOn(h.state.coordinator, "enterExecution").mockImplementationOnce(() => {
        const lease = enter();
        return {
          [Symbol.dispose]: () => {
            lease[Symbol.dispose]();
            finished.resolve();
          },
        };
      });
      await finalize?.(Promise.resolve(true));
      await finished.promise;
      expect(notify).not.toHaveBeenCalled();
      expect(await h.storage.read()).toEqual(successor);
    }
  );

  test.each(["foreign Stop", "generation"] as const)(
    "a committed Stop cannot notify after persisted ownership changes (%s)",
    async (superseded) => {
      const h = await fixture();
      const notify = mock(() => undefined);
      const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          expect(await h.storage.read()).toMatchObject({ version: 2 });
          if (superseded === "foreign Stop") await new CompactionCancellation(h.storage).cancel();
          else
            await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
          return capture(...args);
        }
      );
      expect(await h.session.interruptStream({ onCompactionSettled: notify })).toEqual(
        Ok(undefined)
      );
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "failed V2 durability cannot notify (after receipt=%s)",
    async (afterReceipt) => {
      const h = await fixture();
      const notify = mock(() => undefined);
      const lock = h.historyService.withCompactionStorageLock.bind(h.historyService);
      let calls = 0;
      spyOn(h.historyService, "withCompactionStorageLock").mockImplementation(async (...args) => {
        if (++calls !== 2) return lock(...args);
        if (afterReceipt) await lock(...args);
        throw new Error("settlement durability unavailable");
      });
      expect(await h.session.interruptStream({ onCompactionSettled: notify })).toMatchObject({
        success: false,
        streamStopped: true,
      });
      expect(await h.storage.read()).toMatchObject({ version: afterReceipt ? 2 : 1 });
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "throwing settlement observer preserves Stop and releases ownership (deferred=%s)",
    async (deferred) => {
      const h = await fixture();
      const notify = mock(() => {
        throw new Error("observer unavailable");
      });
      let finalize: ((complete: boolean | Promise<boolean>) => Promise<unknown>) | undefined;
      expect(
        await h.session.interruptStream({
          onCompactionSettled: notify,
          deferCompactionSettlement: deferred
            ? (complete) => {
                finalize = complete;
              }
            : undefined,
        })
      ).toEqual(Ok(undefined));
      if (deferred) {
        const finished = Promise.withResolvers<void>();
        const enter = h.state.coordinator.enterExecution.bind(h.state.coordinator);
        spyOn(h.state.coordinator, "enterExecution").mockImplementationOnce(() => {
          const lease = enter();
          return {
            [Symbol.dispose]: () => {
              lease[Symbol.dispose]();
              finished.resolve();
            },
          };
        });
        expect(await finalize?.(Promise.resolve(true))).toEqual(Ok(undefined));
        await finished.promise;
      }
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await h.storage.read()).toMatchObject({ version: 2 });
      await h.session.dispose();
    }
  );

  test("automatic input captured during V1 cleanup cannot adopt its later V2 settlement", async () => {
    const h = await fixture();
    const foreignHistory = new HistoryService(h.config);
    const foreign = new CompactionCancellation(
      foreignHistory.getCompactionCancellationStorage(workspaceId)
    );
    const published = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<boolean>();
    const capturedReceipts: CompactionReplacementCapture[] = [];
    const settledReceipts: CompactionReplacementCapture[] = [];
    const stopping = foreign.cancel({
      settled: settlement.promise,
      onCaptured: (capture) => {
        capturedReceipts.push(capture);
        published.resolve();
      },
      onSettled: (capture) => settledReceipts.push(capture),
    });
    await published.promise;
    const initial = await h.storage.read();
    assert(initial?.version === 1);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let capturedGeneration: string | undefined;
    const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        const result = await capture(...args);
        assert(result.success);
        expect(result.data.nonce).toBe(initial.nonce);
        capturedGeneration = result.data.generation;
        entered.resolve();
        await resume.promise;
        return result;
      }
    );
    const accepted = mock(() => undefined);
    const send = h.session.sendMessage("input admitted during cleanup", options, {
      acceptanceOrigin: "automatic",
      onAccepted: accepted,
    });
    try {
      await entered.promise;
      settlement.resolve(true);
      expect(await stopping).toBe("applied");
      const settled = await h.storage.read();
      assert(settled?.version === 2);
      expect(settled.nonce).toBe(initial.nonce);
      expect(settled.settledGeneration).toBe(capturedGeneration);
      expect(capturedReceipts).toEqual([
        { nonce: initial.nonce, generation: capturedGeneration, cancellationVersion: 1 },
        { nonce: initial.nonce, generation: capturedGeneration, cancellationVersion: 2 },
      ]);
      expect(settledReceipts).toEqual([
        { nonce: initial.nonce, generation: capturedGeneration, cancellationVersion: 2 },
      ]);
      resume.resolve();
      expect((await send).success).toBe(false);
      expect(await h.storage.read()).toEqual(settled);
      expect(await h.rows()).toEqual([]);
      expect(accepted).not.toHaveBeenCalled();
      expect(h.stream).not.toHaveBeenCalled();
      expect(
        await h.session.sendMessage("fresh input after settlement", options, {
          acceptanceOrigin: "automatic",
        })
      ).toEqual(Ok(undefined));
      expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(settled.nonce);
      expect(await h.storage.read()).toBeNull();
    } finally {
      settlement.resolve(false);
      resume.resolve();
      await Promise.allSettled([send, stopping]);
    }
  });

  test("settled Stop qualifies only durable fresh automatic input across restart", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const stopped = await h.storage.read();
    assert(stopped?.version === 2);
    await h.session.dispose();
    const fresh = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    fixtures.push(fresh);
    expect(
      await fresh.session.sendMessage("fresh automatic input", options, {
        acceptanceOrigin: "automatic",
      })
    ).toEqual(Ok(undefined));
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
    expect(await h.storage.read()).toBeNull();
  });

  test.each(["invalid", "write failure", "canceled", "generation"] as const)(
    "refused fresh automatic input preserves settled Stop (%s)",
    async (failure) => {
      const h = await fixture();
      expect(await h.session.interruptStream()).toEqual(Ok(undefined));
      const stopped = await h.storage.read();
      assert(stopped?.version === 2);
      const cancel = new AbortController();
      if (failure === "canceled") cancel.abort();
      if (failure === "write failure")
        spyOn(h.historyService, "acceptCompactionReplacement").mockResolvedValueOnce(
          Err("write unavailable")
        );
      if (failure === "generation")
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      const result = await h.session.sendMessage(
        "refused automatic input",
        failure === "invalid" ? { ...options, model: "invalid" } : options,
        {
          acceptanceOrigin: "automatic",
          cancelSignal: cancel.signal,
        }
      );
      if (failure !== "canceled") expect(result.success).toBe(false);
      expect(await h.storage.read()).toEqual(stopped);
      expect(await h.rows()).toEqual([]);
      expect(await h.session.resumeStream(options, { acceptanceOrigin: "automatic" })).toEqual(
        Ok({ started: false })
      );
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "automatic admission cannot replace a foreign Stop first observed after its gate (prior=%s)",
    async (prior) => {
      const h = await fixture();
      if (prior) expect(await h.session.interruptStream()).toEqual(Ok(undefined));
      const foreignHistory = new HistoryService(h.config);
      const foreign = new CompactionCancellation(
        foreignHistory.getCompactionCancellationStorage(workspaceId)
      );
      const gate = h.session.isAutomaticSendBlocked.bind(h.session);
      spyOn(h.session, "isAutomaticSendBlocked").mockImplementationOnce(async () => {
        const blocked = await gate();
        expect(blocked).toBe(false);
        await foreign.cancel({ settled: Promise.resolve(true) });
        return blocked;
      });
      const accepted = mock(() => undefined);
      const result = await h.session.sendMessage("already admitted automatic input", options, {
        acceptanceOrigin: "automatic",
        onAccepted: accepted,
      });
      expect(result.success).toBe(false);
      expect(await h.storage.read()).toMatchObject({ version: 2 });
      expect(await h.rows()).toEqual([]);
      expect(accepted).not.toHaveBeenCalled();
      expect(h.stream).not.toHaveBeenCalled();
      // The same persisted frontier is legitimate for a genuinely later admission.
      expect(
        await h.session.sendMessage("fresh automatic input", options, {
          acceptanceOrigin: "automatic",
        })
      ).toEqual(Ok(undefined));
      expect(await h.storage.read()).toBeNull();
    }
  );

  test.each([
    ["absent", "after early read"],
    ["scoped V1", "after early read"],
    ["absent", "before publication lock"],
    ["scoped V1", "before publication lock"],
  ] as const)(
    "ordinary automatic publication fences a late foreign Stop from %s (%s)",
    async (frontier, timing) => {
      const h = await fixture();
      if (frontier === "scoped V1") {
        await h.session.cancelCompaction();
        const stop = await h.storage.read();
        assert(stop);
        await h.state.compactionCancellation.narrow(stop.nonce, {
          id: "old-summary",
          pendingFollowUp: { text: "canceled continuation" },
        });
      }
      const foreignHistory = new HistoryService(h.config);
      const foreign = new CompactionCancellation(
        foreignHistory.getCompactionCancellationStorage(workspaceId)
      );
      if (timing === "before publication lock") {
        const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
        spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
          async (...args) => {
            // All request preparation completed against the old frontier; the CAS must recheck it.
            await foreign.cancel({ settled: Promise.resolve(true) });
            return publish(...args);
          }
        );
      } else {
        const state = h.session as unknown as {
          readCompactionCancellation(): ReturnType<FileCompactionCancellationStorage["read"]>;
        };
        const read = state.readCompactionCancellation.bind(state);
        let reads = 0;
        spyOn(state, "readCompactionCancellation").mockImplementation(async () => {
          const record = await read();
          if (++reads === 2) await foreign.cancel({ settled: Promise.resolve(true) });
          return record;
        });
      }
      const accepted = mock(() => undefined);
      expect(
        (
          await h.session.sendMessage("older automatic input", options, {
            acceptanceOrigin: "automatic",
            onAccepted: accepted,
          })
        ).success
      ).toBe(false);
      expect(await h.rows()).toEqual([]);
      expect(await h.storage.read()).toMatchObject({ version: 2 });
      expect(accepted).not.toHaveBeenCalled();
      expect(h.stream).not.toHaveBeenCalled();
      expect(
        await h.session.sendMessage("fresh automatic input", options, {
          acceptanceOrigin: "automatic",
        })
      ).toEqual(Ok(undefined));
      expect(await h.storage.read()).toBeNull();
    }
  );

  test.each([false, true])(
    "ordinary automatic receipt keeps rollback ownership (rollback fails=%s)",
    async (rollbackFails) => {
      const h = await fixture();
      const cancel = new AbortController();
      let rowsPersisted = false;
      let budgetReserved = true;
      const accepted = mock(() => undefined);
      const canceled = mock(() => {
        if (!rowsPersisted) budgetReserved = false;
      });
      const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await publish(...args);
          assert(result.success && result.data.kind === "accepted");
          expect(result.data.witness).toBeNull();
          expect(rowsPersisted).toBe(false);
          cancel.abort();
          return result;
        }
      );
      if (rollbackFails)
        spyOn(h.historyService, "deleteMessages").mockResolvedValueOnce(
          Err("rollback unavailable")
        );
      expect(
        await h.session.sendMessage("ordinary trigger", options, {
          acceptanceOrigin: "automatic",
          cancelSignal: cancel.signal,
          onAccepted: accepted,
          onCanceled: canceled,
          preTurnMessages: [
            createMuxMessage("ordinary-payload", "assistant", "reserved payload", {
              synthetic: true,
            }),
          ],
          onPreTurnRowsPersisted: () => {
            rowsPersisted = true;
          },
          onAcceptedPreStreamFailure: () => {
            if (!rowsPersisted) budgetReserved = false;
          },
        })
      ).toEqual(Ok(undefined));
      expect(await h.rows()).toHaveLength(rollbackFails ? 2 : 0);
      expect(rowsPersisted).toBe(rollbackFails);
      expect(budgetReserved).toBe(rollbackFails);
      expect(accepted).toHaveBeenCalledTimes(rollbackFails ? 1 : 0);
      expect(canceled).toHaveBeenCalledTimes(rollbackFails ? 0 : 1);
    }
  );

  test("generation-mismatched settled Stop blocks idle automatic reconciliation", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    expect(await h.session.isAutomaticSendBlocked()).toBe(false);
    await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    expect(await h.session.isAutomaticSendBlocked()).toBe(true);
    expect(
      (
        await h.session.sendMessage("deferred input", options, {
          acceptanceOrigin: "automatic",
        })
      ).success
    ).toBe(false);
    expect(await h.session.isAutomaticSendBlocked()).toBe(true);
    expect(await h.rows()).toEqual([]);
    expect(h.stream).not.toHaveBeenCalled();
  });

  test("a throwing acceptance observer cannot skip settled Stop retirement", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const stopped = await h.storage.read();
    assert(stopped?.version === 2);
    let budgetReserved = true;
    let rowsPersisted = false;
    const accepted = mock(() => {
      expect(rowsPersisted).toBe(true);
      throw new Error("acceptance observer failed");
    });
    const canceled = mock(() => undefined);
    const failed = mock(() => {
      if (!rowsPersisted) budgetReserved = false;
    });
    await nodeAssert.rejects(
      h.session.sendMessage("accepted automatic input", options, {
        acceptanceOrigin: "automatic",
        onAccepted: accepted,
        onCanceled: canceled,
        onAcceptedPreStreamFailure: failed,
        preTurnMessages: [
          createMuxMessage("peer-payload", "assistant", "reserved peer payload", {
            synthetic: true,
          }),
        ],
        onPreTurnRowsPersisted: () => {
          rowsPersisted = true;
        },
      }),
      /acceptance observer failed/
    );
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(budgetReserved).toBe(true);
    expect((await h.rows()).map((row) => row.id)).toContain("peer-payload");
    expect(canceled).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(h.stream).not.toHaveBeenCalled();
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
    expect(await h.storage.read()).toBeNull();
  });

  test.each(["none", "unsettled", "settled"] as const)(
    "automatic replacement preserves committed input but refuses superseding Stop before retirement (%s)",
    async (foreignStop) => {
      const h = await fixture();
      expect(await h.session.interruptStream()).toEqual(Ok(undefined));
      const stopped = await h.storage.read();
      assert(stopped?.version === 2);
      const foreignHistory = new HistoryService(h.config);
      const foreignStorage = foreignHistory.getCompactionCancellationStorage(workspaceId);
      const foreign = new CompactionCancellation(foreignStorage);
      let successor: Awaited<ReturnType<typeof foreignStorage.read>> = null;
      let rowsPersisted = false;
      let budgetReserved = true;
      const accepted = mock(() => undefined);
      const canceled = mock(() => undefined);
      const failed = mock(() => {
        if (!rowsPersisted) budgetReserved = false;
      });
      const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await publish(...args);
          assert(result.success && result.data.kind === "accepted");
          if (foreignStop !== "none") {
            await foreign.cancel(
              foreignStop === "settled"
                ? { settled: Promise.resolve(true) }
                : { retainUntilReplacement: true }
            );
            successor = await foreignStorage.read();
          }
          return result;
        }
      );
      const result = await h.session.sendMessage("accepted before foreign Stop", options, {
        acceptanceOrigin: "automatic",
        onAccepted: accepted,
        onCanceled: canceled,
        onAcceptedPreStreamFailure: failed,
        preTurnMessages: [
          createMuxMessage("retirement-peer-payload", "assistant", "reserved payload", {
            synthetic: true,
          }),
        ],
        onPreTurnRowsPersisted: () => {
          rowsPersisted = true;
        },
      });
      expect(result.success).toBe(foreignStop === "none");
      expect(accepted).toHaveBeenCalledTimes(foreignStop === "none" ? 1 : 0);
      expect(failed).toHaveBeenCalledTimes(foreignStop === "none" ? 0 : 1);
      expect(canceled).not.toHaveBeenCalled();
      expect(rowsPersisted).toBe(true);
      expect(budgetReserved).toBe(true);
      const rows = await h.rows();
      expect(rows.map((row) => row.id)).toContain("retirement-peer-payload");
      expect(rows.at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
      expect(rows.at(-1)?.parts).toMatchObject([
        { type: "text", text: "accepted before foreign Stop" },
      ]);
      expect(h.stream).toHaveBeenCalledTimes(foreignStop === "none" ? 1 : 0);
      expect(await foreignStorage.read()).toEqual(foreignStop === "none" ? null : successor);
    }
  );

  test("failed Stop retirement still delivers acceptance and retries its exact witness", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const stopped = await h.storage.read();
    assert(stopped?.version === 2);
    const remove = fs.rmSync;
    const failure = spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (file === h.storage.path) throw new Error("retirement unavailable");
      return remove(file, options);
    });
    const cancel = new AbortController();
    const accepted = mock(() => cancel.abort());
    const canceled = mock(() => undefined);
    const failed = mock(() => undefined);
    expect(
      await h.session.sendMessage("accepted automatic input", options, {
        acceptanceOrigin: "automatic",
        cancelSignal: cancel.signal,
        withdrawAcceptedOnCancel: true,
        onAccepted: accepted,
        onCanceled: canceled,
        onAcceptedPreStreamFailure: failed,
      })
    ).toEqual(Ok(undefined));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(h.stream).not.toHaveBeenCalled();
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
    expect(await h.storage.read()).toEqual(stopped);
    expect(h.state.compactionCancellation.needsPersistence).toBe(true);
    failure.mockRestore();
    expect(await h.session.isAutomaticSendBlocked()).toBe(false);
    expect(await h.storage.read()).toBeNull();
  });

  test("post-receipt automatic cancellation keeps accepted row and callback ownership", async () => {
    const h = await fixture();
    expect(await h.session.interruptStream()).toEqual(Ok(undefined));
    const stopped = await h.storage.read();
    assert(stopped?.version === 2);
    const cancel = new AbortController();
    const accepted = mock(() => undefined);
    const canceled = mock(() => undefined);
    const failed = mock(() => undefined);
    const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        const result = await publish(...args);
        assert(result.success && result.data.kind === "accepted");
        cancel.abort();
        return result;
      }
    );
    expect(
      await h.session.sendMessage("accepted automatic input", options, {
        acceptanceOrigin: "automatic",
        cancelSignal: cancel.signal,
        withdrawAcceptedOnCancel: true,
        onAccepted: accepted,
        onCanceled: canceled,
        onAcceptedPreStreamFailure: failed,
      })
    ).toEqual(Ok(undefined));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(h.stream).not.toHaveBeenCalled();
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stopped.nonce);
    expect(await h.storage.read()).toBeNull();
  });

  test.each([
    ["JSON", "before Stop"],
    ["schema", "before Stop"],
    ["UTF-8", "before Stop"],
    ["JSON", "during settlement"],
    ["JSON", "failed cleanup"],
  ] as const)(
    "Stop preserving a malformed %s partial permits a later manual replacement (%s)",
    async (damage, timing) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "prior")
      );
      const partialPath = path.join(path.dirname(h.storage.path), "partial.json");
      const partial = createMuxMessage("broken-partial", "assistant", "unfinished", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "stopped continuation", model: options.model, agentId: "exec" },
        },
      });
      const contents =
        damage === "JSON"
          ? Buffer.from("{unfinished partial")
          : damage === "schema"
            ? Buffer.from(JSON.stringify({ ...partial, parts: null }))
            : Buffer.from(JSON.stringify(partial).replace("unfinished", "\ufffd"));
      if (damage === "UTF-8") contents[contents.indexOf(Buffer.from("\ufffd"))] = 0xff;
      if (timing === "during settlement") {
        const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
          h.historyService
        );
        const firstCleanup = Promise.withResolvers<void>();
        spyOn(
          h.historyService,
          "neutralizeCompactionRecoveryUnderHistoryLock"
        ).mockImplementationOnce(async (...args) => {
          const result = await neutralize(...args);
          firstCleanup.resolve();
          return result;
        });
        spyOn(h.aiService, "stopStream").mockImplementationOnce(async () => {
          await firstCleanup.promise;
          await fileIO.writeFile(partialPath, contents);
          return Ok(undefined);
        });
      } else await fileIO.writeFile(partialPath, contents);
      if (timing === "failed cleanup") {
        const remove = fs.rmSync;
        let failed = false;
        spyOn(fs, "rmSync").mockImplementation((file, removeOptions) => {
          if (file === partialPath && !failed) {
            failed = true;
            throw new Error("partial cleanup unavailable");
          }
          return remove(file, removeOptions);
        });
      }

      // ACP/budget Stop preserves partials; corrupt bytes must not become permanent cleanup debt.
      expect(await h.session.interruptStream()).toEqual(
        timing === "failed cleanup"
          ? { success: false, error: "partial cleanup unavailable", streamStopped: true }
          : Ok(undefined)
      );
      expect(h.state.compactionCancellation.blocksRecovery).toBe(timing === "failed cleanup");
      const cancellation = await h.storage.read();
      if (timing === "failed cleanup") expect(cancellation).toBeNull();
      else assert(cancellation);
      expect(h.stream).not.toHaveBeenCalled();
      expect(
        (await h.session.sendMessage("invalid replacement", { ...options, model: "invalid" }))
          .success
      ).toBe(false);
      expect(await new HistoryService(h.config).readPartial(workspaceId)).toBeNull();
      await nodeAssert.rejects(fileIO.access(partialPath), { code: "ENOENT" });
      expect(h.state.compactionCancellation.blocksRecovery).toBe(false);
      const repaired = await h.storage.read();
      assert(repaired);
      const settledGeneration = await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration();
      expect(repaired).toMatchObject({ version: 2, settledGeneration });
      if (cancellation)
        expect(repaired).toEqual({ ...cancellation, version: 2, settledGeneration });
      expect(await h.session.sendMessage("accepted replacement", options)).toEqual(Ok(undefined));
      expect(h.stream).toHaveBeenCalledTimes(1);
      expect((await h.rows()).map((row) => row.id)).toContain("prior");
      expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(repaired.nonce);
      expect(await h.storage.read()).toBeNull();
    }
  );

  test("Stop clears durable continuation before an older version reads history", async () => {
    const h = await fixture();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "stopped continuation", model: options.model, agentId: "exec" },
        },
      })
    );
    expect(await h.session.cancelCompaction()).toEqual(Ok(undefined));
    const durable = await new HistoryService(h.config).getLastMessages(workspaceId, 1);
    assert(durable.success);
    const metadata = durable.data[0].metadata?.muxMetadata;
    assert(metadata?.type === "compaction-summary");
    // Older recovery reads this field directly and does not know the cancellation sidecar.
    expect(metadata.pendingFollowUp).toBeUndefined();
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each(["engine", "policy"] as const)(
    "Stop neutralizes a partial published while its %s settles",
    async (producer) => {
      const h = await fixture();
      const cleared = Promise.withResolvers<void>();
      const producing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      spyOn(h.historyService, "neutralizeCompactionRecoveryUnderHistoryLock").mockImplementation(
        async (...args) => {
          const result = await neutralize(...args);
          cleared.resolve();
          return result;
        }
      );
      const produce = async () => {
        await cleared.promise;
        producing.resolve();
        await release.promise;
        // A final writer can land after initial Stop publication and neutralization.
        return h.historyService.writePartial(
          workspaceId,
          createMuxMessage("late-partial", "assistant", "summary", {
            muxMetadata: {
              type: "compaction-summary",
              pendingFollowUp: { text: "late continuation", model: options.model, agentId: "exec" },
            },
          })
        );
      };
      if (producer === "engine") spyOn(h.aiService, "stopStream").mockImplementation(produce);
      else
        spyOn(h.state.coordinator, "captureInterruptSettlement").mockReturnValue(
          produce().then(() => undefined)
        );
      let finished = false;
      const stopping = h.session.interruptStream().then((result) => {
        finished = true;
        return result;
      });
      try {
        await producing.promise;
        expect(finished).toBe(false);
        expect(h.state.compactionCancellation.blocksRecovery).toBe(true);
        // Terminal policy must not join the Stop cleanup that is waiting for that policy.
        expect(await h.state.dispatchPendingFollowUp()).toBe(false);
      } finally {
        release.resolve();
      }
      expect(await stopping).toEqual(Ok(undefined));
      const partial = await new HistoryService(h.config).readPartial(workspaceId);
      const metadata = partial?.metadata?.muxMetadata;
      assert(metadata?.type === "compaction-summary");
      expect(metadata.pendingFollowUp).toBeUndefined();
    }
  );

  test.each([1, 2])(
    "Stop reports cleanup %s failure after successfully stopping its engine",
    async (failAt) => {
      const h = await fixture();
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      let calls = 0;
      const cleanup = spyOn(
        h.historyService,
        "neutralizeCompactionRecoveryUnderHistoryLock"
      ).mockImplementation(async (...args) => {
        if (++calls === failAt) throw new Error("legacy cleanup failed");
        return neutralize(...args);
      });
      const stop = spyOn(h.aiService, "stopStream");
      expect(await h.session.interruptStream()).toEqual({
        success: false,
        error: "legacy cleanup failed",
        streamStopped: true,
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(h.state.compactionCancellation.blocksRecovery).toBe(true);
      const record = await h.storage.read();
      if (failAt === 1) expect(record).toBeNull();
      else assert(record);
      cleanup.mockRestore();
      expect(await h.state.compactionCancellation.retry()).toBe("applied");
      const retried = await h.storage.read();
      assert(retried);
      const settledGeneration = await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration();
      expect(retried).toMatchObject({ version: 2, settledGeneration });
      if (record) expect(retried).toEqual({ ...record, version: 2, settledGeneration });
    }
  );

  test("an engine Stop failure keeps its original result even when legacy cleanup also fails", async () => {
    const h = await fixture();
    spyOn(h.aiService, "stopStream").mockResolvedValueOnce(Err("engine did not stop"));
    spyOn(h.historyService, "neutralizeCompactionRecoveryUnderHistoryLock").mockRejectedValueOnce(
      new Error("legacy cleanup failed")
    );
    expect(await h.session.interruptStream()).toEqual(Err("engine did not stop"));
    expect(h.state.compactionCancellation.needsPersistence).toBe(true);
  });

  test.each(["follow-up", "automatic send"] as const)(
    "%s cannot join a newer Stop waiting for its captured policy",
    async (ingress) => {
      const h = await fixture();
      await h.session.cancelCompaction();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "summary", {
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: {
              text: "old continuation",
              model: options.model,
              agentId: "exec",
            },
          },
        })
      );
      const reading = Promise.withResolvers<void>();
      const releaseHistory = Promise.withResolvers<void>();
      const policySettled = Promise.withResolvers<void>();
      const firstCleanup = Promise.withResolvers<void>();
      const narrowed = Promise.withResolvers<void>();
      const pause = async <T>(result: T) => {
        reading.resolve();
        await releaseHistory.promise;
        return result;
      };
      if (ingress === "follow-up") {
        const read = h.historyService.getLastMessages.bind(h.historyService);
        spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) =>
          pause(await read(...args))
        );
      } else {
        const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
        spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
          async (...args) => pause(await read(...args))
        );
      }
      const narrow = h.state.compactionCancellation.narrow.bind(h.state.compactionCancellation);
      spyOn(h.state.compactionCancellation, "narrow").mockImplementation((...args) => {
        narrowed.resolve();
        return narrow(...args);
      });
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      spyOn(h.historyService, "neutralizeCompactionRecoveryUnderHistoryLock").mockImplementation(
        async (...args) => {
          const result = await neutralize(...args);
          firstCleanup.resolve();
          return result;
        }
      );
      const dispatch = (
        ingress === "follow-up"
          ? h.state.dispatchPendingFollowUp()
          : h.session.isAutomaticSendBlocked()
      ).finally(() => policySettled.resolve());
      await reading.promise;
      spyOn(h.state.coordinator, "captureInterruptSettlement").mockReturnValue(
        policySettled.promise
      );
      const stopping = h.session.interruptStream();
      try {
        await firstCleanup.promise;
        releaseHistory.resolve();
        // Detect the cyclic join directly, so the red test can release its fixture without a timeout.
        expect(
          await Promise.race([
            dispatch.then(() => "settled"),
            narrowed.promise.then(() => "joined pending Stop"),
          ])
        ).toBe("settled");
        expect(await dispatch).toBe(ingress === "automatic send");
        expect(await stopping).toEqual(Ok(undefined));
        expect(h.stream).not.toHaveBeenCalled();
      } finally {
        releaseHistory.resolve();
        policySettled.resolve();
        await Promise.all([dispatch, stopping]);
      }
    }
  );

  for (const peerAction of ["Stop", "Clear", "unchanged"] as const) {
    test.each(["single", "batch"] as const)(
      `peer ${peerAction} before automatic %s publication fences the persisted frontier`,
      async (kind) => {
        const h = await fixture();
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("prior", "user", "original context")
        );
        const peer = await createAgentSessionHarness({
          workspaceId,
          historyService: new HistoryService(h.config),
          config: h.config,
        });
        fixtures.push(peer);
        // Hold immediately before the real write lock, after automatic admission preflight.
        // Both backends retain their own cancellation state but share the persisted transcript.
        const writer = h.historyService as unknown as {
          withRecoveredHistoryWriteResultLock<T>(
            id: string,
            error: string,
            operation: (assertOwned: () => Promise<void>) => Promise<Result<T>>
          ): Promise<Result<T>>;
        };
        const lock = writer.withRecoveredHistoryWriteResultLock.bind(writer);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let held = false;
        spyOn(writer, "withRecoveredHistoryWriteResultLock").mockImplementation(async (...args) => {
          if (
            !held &&
            ["Failed to append history", "Failed to accept compaction replacement"].includes(
              args[1]
            )
          ) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return lock(...args);
        });
        const sending = h.session.sendMessage("automatic input", options, {
          acceptanceOrigin: "automatic",
          ...(kind === "batch"
            ? {
                preTurnMessages: [
                  createMuxMessage("payload", "assistant", "automatic payload", {
                    synthetic: true,
                  }),
                ],
              }
            : {}),
        });
        try {
          await entered.promise;
          if (peerAction !== "unchanged") {
            expect(
              await peer.session.cancelCompaction(
                true,
                undefined,
                peerAction === "Clear" ? { fullHistoryDeletion: { percentage: 1 } } : undefined
              )
            ).toEqual(Ok(undefined));
          }
          release.resolve();
          const result = await sending;
          const rows = await h.rows();
          if (peerAction === "unchanged") {
            expect(h.stream).toHaveBeenCalledTimes(1);
            expect(rows.at(-1)?.role).toBe("user");
            expect(rows).toHaveLength(kind === "batch" ? 3 : 2);
          } else {
            expect(rows.map((row) => row.id)).toEqual(peerAction === "Clear" ? [] : ["prior"]);
            expect(h.stream).not.toHaveBeenCalled();
          }
          expect(result.success).toBe(peerAction === "unchanged");
        } finally {
          release.resolve();
          await sending;
        }
      }
    );
  }

  for (const stale of ["Stop", "caller epoch"] as const) {
    test.each(["single", "batch"] as const)(
      `${stale} during automatic %s append removes only stale rows`,
      async (kind) => {
        const h = await fixture();
        let stopping: ReturnType<typeof h.session.cancelCompaction> | undefined;
        let foreign: ReturnType<typeof h.historyService.appendToHistory> | undefined;
        let epochStale = false;
        const supersede = () => {
          if (foreign) return;
          if (stale === "Stop") stopping = h.session.cancelCompaction();
          else epochStale = true;
          foreign = h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("foreign", "assistant", "new unrelated row")
          );
        };
        const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
        spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
          (id, capture, operation, observer) =>
            publish(id, capture, operation, {
              ...observer,
              onCommitted: (receipt) => {
                observer.onCommitted(receipt);
                // The actual journaled append committed; Stop/epoch loss still owns ordinary rollback.
                supersede();
                return undefined;
              },
            })
        );
        const result = await h.session.sendMessage("stale automatic input", options, {
          acceptanceOrigin: "automatic",
          admissionEpochStale: () => epochStale,
          ...(kind === "batch"
            ? {
                preTurnMessages: [
                  createMuxMessage("payload", "assistant", "stale payload", { synthetic: true }),
                ],
              }
            : {}),
        });
        expect(foreign).toBeDefined();
        await stopping;
        await foreign;
        expect(result.success).toBe(false);
        expect(h.stream).not.toHaveBeenCalled();
        expect((await h.rows()).map((row) => row.id)).toEqual(["foreign"]);
      }
    );
  }

  for (const stale of ["Stop", "lease"] as const) {
    test.each([false, true])(
      `${stale} during edit staging preserves active and archived history (archive=%s)`,
      async (archived) => {
        const h = await fixture();
        for (const [id, role] of [
          ["prior", "user"],
          ["edit", "user"],
          ["tail", "assistant"],
        ] as const)
          await h.historyService.appendToHistory(workspaceId, createMuxMessage(id, role, id));
        if (archived)
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("boundary", "assistant", "summary", {
              compactionBoundary: true,
              compactionEpoch: 1,
              compacted: "user",
            })
          );
        const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
        const archivePath = path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl");
        const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
        let expectedChat = await fileIO.readFile(chatPath);
        let expectedArchive = archived ? await fileIO.readFile(archivePath) : undefined;
        const atomic = atomicWrite.default;
        let intervened = false;
        let stopping: ReturnType<typeof h.session.cancelCompaction> | undefined;
        spyOn(atomicWrite, "default").mockImplementation(
          new Proxy(atomic, {
            async apply(target, receiver, args: Parameters<typeof atomic>) {
              const result = await Reflect.apply(target, receiver, args);
              if (String(args[0]).startsWith(`${chatPath}.publication-`) && !intervened) {
                intervened = true;
                if (stale === "Stop") stopping = h.session.cancelCompaction();
                else {
                  await fileIO.writeFile(lockPath, "foreign-owner");
                  expectedChat = Buffer.from("foreign active history\n");
                  await fileIO.writeFile(chatPath, expectedChat);
                  if (archived) {
                    expectedArchive = Buffer.from("foreign archive history\n");
                    await fileIO.writeFile(archivePath, expectedArchive);
                  }
                }
              }
              return result;
            },
          })
        );
        try {
          const result = await h.session.sendMessage("edited input", {
            ...options,
            editMessageId: "edit",
          });
          expect(intervened).toBe(true);
          await stopping;
          expect(result.success).toBe(false);
          expect(h.stream).not.toHaveBeenCalled();
          expect(await fileIO.readFile(chatPath)).toEqual(expectedChat);
          if (archived) expect(await fileIO.readFile(archivePath)).toEqual(expectedArchive!);
        } finally {
          if (stale === "lease" && intervened) await fileIO.rm(lockPath, { force: true });
        }
      }
    );
  }

  test("manual input recovers an oversized follow-up narrowing debt without releasing Stop early", async () => {
    const h = await fixture();
    const pendingFollowUp = {
      text: "large continuation ".repeat(SESSION_HISTORY_MAX_LINE_BYTES / 10),
      model: options.model,
      agentId: "exec",
    };
    const summary = createMuxMessage("large-summary", "assistant", "summary", {
      compactionBoundary: true,
      compacted: "user",
      muxMetadata: { type: "compaction-summary", pendingFollowUp },
    });
    expect((await h.historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
    await h.session.cancelCompaction();
    const original = await h.storage.read();
    assert(original);
    await nodeAssert.rejects(
      h.state.compactionCancellation.narrow(original.nonce, {
        id: summary.id,
        sequence: summary.metadata?.historySequence,
        pendingFollowUp,
      }),
      CompactionCancellationReadRefusedError
    );
    expect(await h.session.isAutomaticSendBlocked()).toBe(true);
    expect(await h.state.compactionRecoveryBlocked()).toBe(true);
    expect(h.stream).not.toHaveBeenCalled();
    expect(
      (await h.session.sendMessage("invalid replacement", { ...options, model: "invalid" })).success
    ).toBe(false);
    const retained = await h.storage.read();
    expect(retained).toMatchObject({ retainUntilReplacement: true, scope: { kind: "unresolved" } });
    expect(retained?.nonce).not.toBe(original.nonce);
    expect(await h.session.isAutomaticSendBlocked()).toBe(true);
    expect(await h.session.sendMessage("valid replacement", options)).toEqual(Ok(undefined));
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(retained?.nonce);
    expect(await h.storage.read()).toBeNull();
  });

  test.each(["future", "oversized"] as const)(
    "explicit replacement recovers a %s cancellation record without dropping its retention floor",
    async (kind) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "prior")
      );
      const unsupported =
        kind === "future"
          ? JSON.stringify({ version: 2, nonce: "future", scope: { kind: "unresolved" } })
          : " ".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1);
      await fileIO.writeFile(h.storage.path, unsupported);
      expect(
        (await h.session.sendMessage("invalid replacement", { ...options, model: "invalid" }))
          .success
      ).toBe(false);
      expect(await h.storage.read()).toMatchObject({ version: 1, retainUntilReplacement: true });
      expect((await h.rows()).map((row) => row.id)).toEqual(["prior"]);
      const stop = await h.storage.read();
      expect(await h.session.sendMessage("accepted replacement", options)).toEqual(Ok(undefined));
      expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stop?.nonce);
      expect(await h.storage.read()).toBeNull();
    }
  );

  test.each(["ordinary", "retained", "foreign Stop"] as const)(
    "restart reconciles already-cleared scoped follow-up debt (%s)",
    async (kind) => {
      const h = await fixture();
      // Seed the pre-repair crash shape: a legacy writer persisted after the Stop fence.
      await h.session.cancelCompaction();
      const summary = createMuxMessage("summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
        },
      });
      await h.historyService.appendToHistory(workspaceId, summary);

      const stop = await h.storage.read();
      assert(stop);
      const metadata = summary.metadata?.muxMetadata;
      assert(metadata?.type === "compaction-summary" && metadata.pendingFollowUp);
      await h.state.compactionCancellation.narrow(stop.nonce, {
        id: summary.id,
        sequence: summary.metadata?.historySequence,
        pendingFollowUp: { ...metadata.pendingFollowUp },
      });
      expect(
        await h.historyService.cleanupCompactionFollowUp(workspaceId, summary, "clear", () => true)
      ).toEqual(Ok("applied"));
      // Crash window: cleanup is durable; the ordinary cancellation sidecar has not retired.
      // A retained floor must survive the same disk shape, including a later automatic row.
      if (kind === "retained")
        await fileIO.writeFile(
          h.storage.path,
          JSON.stringify({ ...(await h.storage.read()), retainUntilReplacement: true })
        );
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("later", "assistant", "later output")
      );
      await h.session.dispose();
      const fresh = await createAgentSessionHarness({
        workspaceId,
        historyService: new HistoryService(h.config),
        config: h.config,
      });
      fixtures.push(fresh);
      const freshStream = spyOn(fresh.aiService, "streamMessage");
      const state = fresh.session as unknown as Internals;
      let successorNonce: string | undefined;
      if (kind === "foreign Stop") {
        const cleanup = fresh.historyService.cleanupCompactionFollowUp.bind(fresh.historyService);
        spyOn(fresh.historyService, "cleanupCompactionFollowUp").mockImplementationOnce(
          async (...args) => {
            const result = await cleanup(...args);
            const foreign = new CompactionCancellation(
              new FileCompactionCancellationStorage(new HistoryService(h.config), workspaceId)
            );
            await foreign.cancel();
            successorNonce = (await foreign.read())?.nonce;
            return result;
          }
        );
      }
      expect(await state.dispatchPendingFollowUp()).toBe(false);
      expect(freshStream).not.toHaveBeenCalled();
      expect((await h.storage.read()) !== null).toBe(kind !== "ordinary");
      if (kind === "foreign Stop") {
        expect(successorNonce).toBeDefined();
        expect((await h.storage.read())?.nonce).toBe(successorNonce);
        expect(successorNonce).not.toBe(stop.nonce);
      }
      expect(await state.compactionRecoveryBlocked()).toBe(kind !== "ordinary");
    }
  );

  test("manual repair clears stale usage before replacement admission", async () => {
    const h = await fixture();
    await h.historyService.appendToHistory(workspaceId, createMuxMessage("prior", "user", "prior"));
    await fileIO.writeFile(h.storage.path, "{malformed cancellation");
    const clear = spyOn(h.session, "clearUsageState");
    expect(await h.session.sendMessage("replacement", options)).toEqual(Ok(undefined));
    expect(clear).toHaveBeenCalled();
    expect(await h.storage.read()).toBeNull();
  });

  test.each([false, true])(
    "Stop blocks automatic admission synchronously and disposal joins its pending publication (retained=%s)",
    async (retained) => {
      const h = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const flushing = Promise.withResolvers<void>();
      const mutate = FileCompactionCancellationStorage.prototype.mutate; // eslint-disable-line @typescript-eslint/unbound-method -- invoked with the original receiver below
      spyOn(FileCompactionCancellationStorage.prototype, "mutate").mockImplementationOnce(
        async function (this: FileCompactionCancellationStorage, ...args) {
          entered.resolve();
          await release.promise;
          return mutate.call(this, ...args);
        }
      );
      const cancel = h.session.cancelCompaction(retained);
      await entered.promise;
      expect(
        (await h.session.sendMessage("automatic", options, { acceptanceOrigin: "automatic" }))
          .success
      ).toBe(false);
      const flush = h.state.compactionCancellation.flush.bind(h.state.compactionCancellation);
      spyOn(h.state.compactionCancellation, "flush").mockImplementationOnce(() => {
        flushing.resolve();
        return flush();
      });
      let disposed = false;
      const closing = h.session.dispose().then(() => {
        disposed = true;
      });
      try {
        await flushing.promise;
        expect(disposed).toBe(false);
      } finally {
        release.resolve();
        expect(await cancel).toEqual(Ok(undefined));
        await closing;
      }
      expect((await h.storage.read())?.retainUntilReplacement === true).toBe(retained);
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test.each(["recover", "observe"] as const)(
    "Stop after the %s gate read cannot start a producer under the new generation",
    async (kind) => {
      const h = await fixture();
      const gate = h.state.compactionRecoveryBlocked.bind(h.state);
      spyOn(h.state, "compactionRecoveryBlocked").mockImplementationOnce(async () => {
        const blocked = await gate();
        expect(blocked).toBe(false);
        await h.session.cancelCompaction();
        return blocked;
      });
      const recover = spyOn(h.state.continuousCompactor, "recover").mockResolvedValue(true);
      const observe = spyOn(h.state.continuousCompactor, "observe").mockResolvedValue("applied");
      expect(
        kind === "recover"
          ? await h.state.recoverCompaction()
          : await h.state.observeCompaction(95, {
              enabled: true,
              model: options.model,
              contextWindowTokens: 100_000,
              thresholdPercent: 85,
              phase: "on-send",
            })
      ).toBe(kind === "recover" ? false : "none");
      expect(recover).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(await h.storage.read()).not.toBeNull();
    }
  );

  test.each([false, true])(
    "only manual acceptance retires Stop (synthetic=%s)",
    async (synthetic) => {
      const h = await fixture();
      expect(await h.session.cancelCompaction(true)).toEqual(Ok(undefined));
      const stop = await h.storage.read();
      assert(stop);
      expect(
        (
          await h.session.sendMessage("automatic", options, {
            acceptanceOrigin: "automatic",
            synthetic,
          })
        ).success
      ).toBe(false);
      expect(await h.rows()).toEqual([]);
      expect((await h.storage.read())?.nonce).toBe(stop.nonce);
      expect(await h.session.sendMessage("manual", options, { synthetic })).toEqual(Ok(undefined));
      expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stop.nonce);
      expect(await h.storage.read()).toBeNull();
    }
  );

  test("Stop while legacy compaction waits for the stream cannot launch its old compaction request", async () => {
    const h = await fixture();
    const completion = Promise.withResolvers<TurnCompletion>();
    h.stream.mockResolvedValueOnce(Ok({ messageId: "original", completion: completion.promise }));
    expect(await h.session.sendMessage("original input", options)).toEqual(Ok(undefined));
    const before = await h.rows();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(h.aiService, "stopStream").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      completion.resolve({ status: "aborted", abortReason: "system" });
      return Ok(undefined);
    });
    const compact = h.state.interruptForCompaction();
    try {
      await entered.promise;
      await h.session.cancelCompaction();
      release.resolve();
      await compact;
      expect(h.stream).toHaveBeenCalledTimes(1);
      expect(await h.rows()).toEqual(before);
      expect(await h.storage.read()).not.toBeNull();
    } finally {
      completion.resolve({ status: "aborted", abortReason: "system" });
      release.resolve();
      await compact;
    }
  });

  test("Stop during follow-up history inspection cannot relabel the old continuation as fresh input", async () => {
    const h = await fixture();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
        },
      })
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = h.historyService.getLastMessages.bind(h.historyService);
    spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const dispatch = h.state.dispatchPendingFollowUp();
    try {
      await entered.promise;
      await h.session.cancelCompaction();
      release.resolve();
      expect(await dispatch).toBe(false);
      expect((await h.rows()).map((row) => row.id)).toEqual(["summary"]);
      expect(h.stream).not.toHaveBeenCalled();
      expect(await h.storage.read()).not.toBeNull();
    } finally {
      release.resolve();
      await dispatch;
    }
  });

  test("fresh automatic input preserves Stop and its hidden canceled summary across restart", async () => {
    const h = await fixture();
    // Seed the pre-repair crash shape: a legacy writer persisted after the Stop fence.
    await h.session.cancelCompaction();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("canceled-summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "old continuation", model: options.model, agentId: "exec" },
        },
      })
    );

    const stop = await h.storage.read();
    assert(stop);
    expect(
      await h.session.sendMessage("fresh attention", options, {
        acceptanceOrigin: "automatic",
        synthetic: true,
      })
    ).toEqual(Ok(undefined));
    expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBeUndefined();
    expect(await h.storage.read()).toMatchObject({
      nonce: stop.nonce,
      scope: { kind: "summary", id: "canceled-summary", sequence: 0 },
    });
    await h.session.dispose();
    const fresh = await createAgentSessionHarness({
      workspaceId,
      historyService: new HistoryService(h.config),
      config: h.config,
    });
    fixtures.push(fresh);
    const freshStream = spyOn(fresh.aiService, "streamMessage");
    const state = fresh.session as unknown as Internals;
    expect(await fresh.session.resumeStream(options, { acceptanceOrigin: "automatic" })).toEqual(
      Ok({ started: false })
    );
    expect(await state.scheduleStartupAutoRetryIfNeeded()).toBe("completed");
    expect(await state.dispatchPendingFollowUp()).toBe(false);
    expect(freshStream).not.toHaveBeenCalled();
    const summary = (await h.rows())[0].metadata?.muxMetadata;
    assert(summary?.type === "compaction-summary");
    expect(summary.pendingFollowUp).toBeUndefined();
    expect(await h.storage.read()).toBeNull();
  });

  test("queued manual input invalidates explicit resume while pricing is suspended", async () => {
    const entered = Promise.withResolvers<void>();
    const pricing = Promise.withResolvers<ReturnType<typeof Ok<void>>>();
    const h = await fixture({
      assertPricedModelForBudgetedGoal: mock(() => {
        entered.resolve();
        return pricing.promise;
      }),
    } as unknown as WorkspaceGoalService);
    await h.historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "prior"));
    await h.session.cancelCompaction(true);
    const stop = await h.storage.read();
    const resuming = h.session.resumeStream(options);
    await entered.promise;
    h.session.queueMessage("new manual", options);
    pricing.resolve(Ok(undefined));
    expect(await resuming).toEqual(Ok({ started: false }));
    expect((await h.storage.read())?.nonce).toBe(stop?.nonce);
    expect((await h.rows())[0].metadata?.compactionReplacementNonce).toBeUndefined();
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each(["send", "resume"] as const)(
    "Stop during %s capture refuses the old request",
    async (kind) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "prior")
      );
      const capture = h.historyService.captureCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await capture(...args);
          await h.session.cancelCompaction(true);
          return result;
        }
      );
      const result =
        kind === "send"
          ? await h.session.sendMessage("replacement", options)
          : await h.session.resumeStream(options);
      if (kind === "send") expect(result.success).toBe(false);
      else expect(result).toEqual(Ok({ started: false }));
      expect(await h.storage.read()).not.toBeNull();
      expect((await h.rows()).map((row) => row.id)).toEqual(["user"]);
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test("Stop from a queued PREPARING observer cannot be adopted as replacement authority", async () => {
    const h = await fixture();
    let cancellation: ReturnType<typeof h.session.cancelCompaction> | undefined;
    h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-lifecycle" && message.phase === "preparing")
        cancellation ??= h.session.cancelCompaction(true);
    });
    const settled = Promise.withResolvers<void>();
    const send = h.session.sendMessage.bind(h.session);
    spyOn(h.session, "sendMessage").mockImplementation(async (...args) => {
      try {
        return await send(...args);
      } finally {
        settled.resolve();
      }
    });
    h.session.queueMessage("manual", options);
    h.session.sendQueuedMessages();
    await settled.promise;
    await cancellation;
    expect(await h.rows()).toEqual([]);
    expect(await h.storage.read()).not.toBeNull();
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "an edit refreshes its own truncate fence but refuses a newer Stop (%s)",
    async (newerStop) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "prior")
      );
      await h.session.cancelCompaction(true);
      const stop = await h.storage.read();
      if (newerStop) {
        const truncate = h.historyService.truncateAfterMessage.bind(h.historyService);
        spyOn(h.historyService, "truncateAfterMessage").mockImplementationOnce(async (...args) => {
          const result = await truncate(...args);
          await h.session.cancelCompaction(true);
          return result;
        });
      }
      const result = await h.session.sendMessage("edited", { ...options, editMessageId: "user" });
      if (newerStop) {
        expect(result.success).toBe(false);
        expect((await h.storage.read())?.nonce).not.toBe(stop?.nonce);
        expect(h.stream).not.toHaveBeenCalled();
        return;
      }
      expect(result).toEqual(Ok(undefined));
      expect((await h.rows()).at(-1)?.metadata?.compactionReplacementNonce).toBe(stop?.nonce);
      expect(await h.storage.read()).toBeNull();
    }
  );

  test.each(["user", "assistant", "partial"] as const)(
    "explicit resume stamps the actual %s tail before notices",
    async (kind) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "prior")
      );
      if (kind === "assistant")
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("assistant", "assistant", "answer")
        );
      if (kind === "partial")
        await h.historyService.writePartial(
          workspaceId,
          createMuxMessage("partial", "assistant", "interrupted answer", { historySequence: 1 })
        );
      await h.session.cancelCompaction(true);
      const stop = await h.storage.read();
      const detect = h.state.fileChangeTracker.getChangedAttachments.bind(
        h.state.fileChangeTracker
      );
      const notice = spyOn(h.state.fileChangeTracker, "getChangedAttachments").mockImplementation(
        async () => {
          expect((await h.rows()).at(-1)).toMatchObject({
            id: kind,
            metadata: { compactionReplacementNonce: stop?.nonce },
          });
          expect(await h.storage.read()).toBeNull();
          return detect();
        }
      );
      expect(await h.session.resumeStream(options)).toEqual(Ok({ started: true }));
      expect(notice).toHaveBeenCalledTimes(1);
      expect(h.stream).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["before truncate", "after truncate"] as const)(
    "an edit cannot adopt a foreign reset %s",
    async (phase) => {
      const h = await fixture();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "prior")
      );
      const foreign = new HistoryService(h.config);
      const reset = async () => {
        await foreign.clearHistory(workspaceId);
        await foreign.appendToHistory(
          workspaceId,
          createMuxMessage("foreign-reset", "assistant", "", { contextBoundaryKind: "reset" })
        );
        await foreign.appendToHistory(
          workspaceId,
          createMuxMessage("foreign", "user", "new context")
        );
      };
      const truncate = h.historyService.truncateAfterMessage.bind(h.historyService);
      spyOn(h.historyService, "truncateAfterMessage").mockImplementationOnce(async (...args) => {
        if (phase === "before truncate") await reset();
        const result = await truncate(...args);
        if (phase === "after truncate") await reset();
        return result;
      });
      expect(
        (await h.session.sendMessage("stale edit", { ...options, editMessageId: "user" })).success
      ).toBe(false);
      expect((await h.rows()).map((row) => row.id)).toEqual(["foreign-reset", "foreign"]);
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test("an assistant notice cannot make an earlier rejected request resumable or retire Stop", async () => {
    const h = await fixture();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("rejected", "user", "rejected request", { contextBudgetRejected: true })
    );
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("notice", "assistant", "later notice", { synthetic: true })
    );
    await h.session.cancelCompaction(true);
    const stop = await h.storage.read();
    const stamp = spyOn(h.historyService, "acceptCompactionReplacement");
    expect(await h.session.resumeStream(options)).toMatchObject({
      success: false,
      error: { type: "context_budget_blocked" },
    });
    expect(stamp).not.toHaveBeenCalled();
    expect((await h.storage.read())?.nonce).toBe(stop?.nonce);
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "skipped canceled follow-up cleanup retains Stop until a replacement accepts (fails=%s)",
    async (fails) => {
      const h = await fixture();
      // Seed the pre-repair crash shape: a legacy writer persisted after the Stop fence.
      await h.session.cancelCompaction();
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "summary", {
          compactionBoundary: true,
          compacted: "user",
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "old follow-up", model: options.model, agentId: "exec" },
          },
        })
      );

      const stop = await h.storage.read();
      const send = h.session.sendMessage.bind(h.session);
      let sending: ReturnType<typeof send> | undefined;
      spyOn(h.session, "sendMessage").mockImplementation((...args) => (sending = send(...args)));
      const cleanup = h.historyService.cleanupCompactionFollowUp.bind(h.historyService);
      const cleanupSpy = spyOn(
        h.historyService,
        "cleanupCompactionFollowUp"
      ).mockImplementationOnce(async (...args) => {
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holding = h.historyService.withCompactionStorageLock(workspaceId, async () => {
          held.resolve();
          await release.promise;
        });
        await held.promise;
        const cleaning = cleanup(...args);
        try {
          h.session.queueMessage("new manual", fails ? { ...options, model: "invalid" } : options);
          h.session.sendQueuedMessages();
        } finally {
          release.resolve();
          await holding;
        }
        const result = await cleaning;
        expect(result).toEqual(Ok("skipped"));
        return result;
      });
      expect(await h.state.dispatchPendingFollowUp()).toBe(false);
      assert(sending);
      expect((await sending).success).toBe(!fails);
      cleanupSpy.mockRestore();
      if (fails) expect((await h.storage.read())?.nonce).toBe(stop?.nonce);
      else expect(await h.storage.read()).toBeNull();
      await h.session.dispose();
      const fresh = await createAgentSessionHarness({
        workspaceId,
        historyService: new HistoryService(h.config),
        config: h.config,
      });
      fixtures.push(fresh);
      const freshStream = spyOn(fresh.aiService, "streamMessage");
      expect(await (fresh.session as unknown as Internals).dispatchPendingFollowUp()).toBe(false);
      expect(freshStream).not.toHaveBeenCalled();
    }
  );

  test.each(["empty", "snapshot", "rejected", "system"] as const)(
    "explicit resume refuses %s tail without inventing a trigger",
    async (kind) => {
      const h = await fixture();
      if (kind !== "empty") {
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user", "user", "prior")
        );
        const tail: MuxMessage =
          kind === "system"
            ? { id: "tail", role: "system", parts: [{ type: "text", text: "system" }] }
            : createMuxMessage(
                "tail",
                "user",
                "ineligible",
                kind === "snapshot"
                  ? { synthetic: true, fileAtMentionSnapshot: ["@input.ts"] }
                  : { contextBudgetRejected: true }
              );
        await h.historyService.appendToHistory(workspaceId, tail);
      }
      await h.session.cancelCompaction(true);
      const stop = await h.storage.read();
      const before = await h.rows();
      const notices = spyOn(h.state.fileChangeTracker, "getChangedAttachments");
      const result = await h.session.resumeStream(options);
      if (kind === "empty" || kind === "rejected") expect(result.success).toBe(false);
      else expect(result).toEqual(Ok({ started: false }));
      expect(await h.rows()).toEqual(before);
      expect((await h.storage.read())?.nonce).toBe(stop?.nonce);
      expect(notices).not.toHaveBeenCalled();
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "a peer retiring the accepted Stop does not refuse its durable manual request (cache read: %s)",
    async (readPeerRetirement) => {
      const h = await fixture();
      await h.session.cancelCompaction(true);
      const stopped = await h.storage.read();
      assert(stopped);
      const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
      spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const result = await publish(...args);
          assert(result.success && result.data.kind === "accepted" && result.data.witness);
          const peer = new CompactionCancellation(
            new HistoryService(h.config).getCompactionCancellationStorage(workspaceId)
          );
          await peer.read();
          expect(await peer.retireReplacement(result.data.witness)).toBe("applied");
          if (readPeerRetirement) expect(await h.state.compactionCancellation.read()).toBeNull();
          return result;
        }
      );
      expect(await h.session.sendMessage("accepted input", options)).toEqual(Ok(undefined));
      expect(h.stream).toHaveBeenCalledTimes(1);
      const rows = await h.rows();
      expect(
        rows.filter((row) => row.metadata?.compactionReplacementNonce === stopped.nonce)
      ).toHaveLength(1);
      expect(await h.storage.read()).toBeNull();
    }
  );

  test("a failed unlink preserves one replacement until cleanup permits an explicit retry", async () => {
    const h = await fixture();
    await h.session.cancelCompaction(true);
    const stop = await h.storage.read();
    assert(stop);
    const unlink = fs.rmSync;
    const failedUnlink = spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (file === h.storage.path) throw new Error("injected unlink failure");
      return unlink(file, options);
    });
    expect(await h.session.sendMessage("first", options)).toEqual(Ok(undefined));
    await h.session.interruptStream({ preserveCompactionIntent: true });
    const accepted = await h.rows();
    expect(h.stream).toHaveBeenCalledTimes(1);
    // Failed ancillary cleanup keeps the first acceptance; it cannot authorize a
    // second row stamped with the same Stop nonce.
    expect((await h.session.sendMessage("second", options)).success).toBe(false);
    expect(await h.rows()).toEqual(accepted);
    expect(h.stream).toHaveBeenCalledTimes(1);
    const fresh = new HistoryService(h.config);
    expect(await fresh.findCompactionReplacementWitness(workspaceId, stop.nonce)).toEqual(
      Ok({ nonce: stop.nonce })
    );
    const restartedHistory = await fresh.getHistoryFromLatestBoundary(workspaceId);
    expect(restartedHistory).toEqual(Ok(accepted));
    expect(
      accepted.filter((row) => row.metadata?.compactionReplacementNonce === stop.nonce)
    ).toHaveLength(1);
    expect((await h.storage.read())?.nonce).toBe(stop.nonce);

    failedUnlink.mockRestore();
    expect(await h.state.compactionCancellation.retry()).toBe("applied");
    expect(await h.storage.read()).toBeNull();
    expect(await h.state.compactionRecoveryBlocked()).toBe(false);
    expect(await h.session.sendMessage("second", options)).toEqual(Ok(undefined));
    expect(h.stream).toHaveBeenCalledTimes(2);
    const retried = await h.rows();
    expect(
      retried
        .filter((row) => row.role === "user")
        .map((row) => row.parts.map((part) => (part.type === "text" ? part.text : part.type)))
    ).toEqual([["first"], ["second"]]);
    expect(
      retried.filter((row) => row.metadata?.compactionReplacementNonce === stop.nonce)
    ).toHaveLength(1);
    expect(retried.find((row) => row.id === accepted[0].id)).toEqual(accepted[0]);
  });

  test.each([false, true])(
    "restart blocks recovery and consumes canceled follow-up (retained=%s)",
    async (retained) => {
      const h = await fixture();
      // Seed the pre-repair crash shape: a legacy writer persisted after the Stop fence.
      await h.session.cancelCompaction(retained);
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "summary", {
          compactionBoundary: true,
          compacted: "user",
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "continue", model: options.model, agentId: "exec" },
          },
        })
      );

      await h.session.dispose();
      const fresh = await createAgentSessionHarness({
        workspaceId,
        historyService: new HistoryService(h.config),
        config: h.config,
      });
      fixtures.push(fresh);
      const freshStream = spyOn(fresh.aiService, "streamMessage");
      const state = fresh.session as unknown as Internals;
      const recovery = spyOn(state.continuousCompactor, "recover");
      expect(await state.recoverCompaction()).toBe(false);
      expect(await state.scheduleStartupAutoRetryIfNeeded()).toBe("completed");
      expect(await state.dispatchPendingFollowUp()).toBe(false);
      expect(recovery).not.toHaveBeenCalled();
      expect(freshStream).not.toHaveBeenCalled();
      const summary = (await h.rows())[0].metadata?.muxMetadata;
      assert(summary?.type === "compaction-summary");
      expect(summary.pendingFollowUp).toBeUndefined();
      expect((await h.storage.read()) !== null).toBe(retained);
    }
  );
});
