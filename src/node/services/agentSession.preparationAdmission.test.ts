import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { CompactionMonitor } from "./compactionMonitor";
import type { PreparationAdmission, TurnCoordinator } from "./turnCoordinator";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  createFailedTurnHandle,
  type AgentSessionHarness,
} from "./agentSession.testHarness";

const options = { model: "anthropic:claude-sonnet-4-5", agentId: "exec" };
const harnesses: AgentSessionHarness[] = [];
async function harness(workspaceId: string) {
  const h = await createAgentSessionHarness({ workspaceId });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.session.dispose();
    await h.cleanup();
  }
});

// Only lifecycle reservations are inspected directly; persistence and provider starts cross
// the same interfaces as production, with deterministic gates instead of timing windows.
function coordinator(h: AgentSessionHarness): TurnCoordinator {
  return (h.session as unknown as { coordinator: TurnCoordinator }).coordinator;
}

describe("preparation admission", () => {
  test("PREPARING publishes the captured queue correlation and nested drains cannot pop its successor", async () => {
    const h = await harness("queue-publication-owner");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const metadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "task",
      ownerWorkspaceId: "parent",
      turnId: "turn",
    };
    const stream = spyOn(h.aiService, "streamMessage").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return Ok(createStartedTurnHandle());
    });
    h.session.queueMessage("head", { ...options, muxMetadata: metadata }, { synthetic: true });
    h.session.queueMessage("tail", options);
    let observed = false;
    h.session.onChatEvent(({ message }) => {
      if (message.type !== "stream-lifecycle" || message.phase !== "preparing" || observed) return;
      observed = true;
      expect(h.session.getQueueCutCutter()).toMatchObject({
        stage: "preparing",
        muxMetadata: metadata,
      });
      expect(h.session.queuedMessageEntryCount()).toBe(2);
      h.session.sendQueuedMessages();
      expect(h.session.queuedMessageEntryCount()).toBe(2);
    });
    try {
      h.session.sendQueuedMessages();
      await started.promise;
      expect(observed).toBe(true);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(h.session.queuedMessageEntryCount()).toBe(1);
    } finally {
      release.resolve();
      await h.session.waitForIdle();
    }
  });

  test("removing the head during PREPARING neither dispatches it nor double-cancels it", async () => {
    const h = await harness("queue-publication-head-removed");
    const canceled = mock(() => undefined);
    const started = Promise.withResolvers<void>();
    const stream = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      started.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle()));
    });
    h.session.queueMessage("removed", options, { synthetic: true, onCanceled: canceled });
    let removed = false;
    h.session.onChatEvent(({ message }) => {
      if (message.type !== "stream-lifecycle" || message.phase !== "preparing" || removed) return;
      removed = true;
      h.session.clearQueue();
      h.session.queueMessage("replacement", options);
    });
    h.session.sendQueuedMessages();
    await started.promise;
    await h.session.waitForIdle();
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    const history = await h.historyService.getHistoryFromLatestBoundary(
      "queue-publication-head-removed"
    );
    expect(history).toMatchObject(
      Ok([{ role: "user", parts: [{ type: "text", text: "replacement" }] }])
    );
  });

  test.each(["direct", "queued"] as const)(
    "%s claim retired during publication never releases service preflight or starts a provider",
    async (source) => {
      const h = await harness(`publication-shutdown-${source}`);
      const handedOff = mock(() => undefined);
      const failed = Promise.withResolvers<void>();
      const onFailure = mock(() => failed.resolve());
      const stream = spyOn(h.aiService, "streamMessage");
      h.session.onChatEvent(({ message }) => {
        if (message.type === "stream-lifecycle" && message.phase === "preparing")
          coordinator(h).beginShutdown();
      });
      if (source === "direct") {
        const result = await h.session.sendMessage("accepted", options, {
          onTurnAdmissionCommitted: handedOff,
          onAcceptedPreStreamFailure: onFailure,
        });
        expect(result.success).toBe(false);
        await failed.promise;
        expect(onFailure).toHaveBeenCalledTimes(1);
      } else {
        h.session.queueMessage("still queued", options, { onAcceptedPreStreamFailure: onFailure });
        h.session.sendQueuedMessages();
        await h.session.waitForIdle();
        expect(h.session.queuedMessageEntryCount()).toBe(1);
        expect(onFailure).not.toHaveBeenCalled();
      }
      expect(handedOff).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    }
  );

  test.each(["busy", "admission", "shutdown"] as const)(
    "resume rechecks %s after pricing without overwriting the latest retry request",
    async (blocker) => {
      const h = await harness(`resume-recheck-${blocker}`);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      Reflect.set(h.session, "workspaceGoalService", {
        assertPricedModelForBudgetedGoal: async () => {
          entered.resolve();
          await release.promise;
          return Ok(undefined);
        },
      } satisfies Partial<WorkspaceGoalService>);
      const sentinel = { options: { ...options, model: "openai:gpt-4o" } };
      Reflect.set(h.session, "lastAutoRetryResumeRequest", sentinel);
      const stream = spyOn(h.aiService, "streamMessage");
      const resume = h.session.resumeStream(options);
      await entered.promise;
      let reservation: Disposable | undefined;
      if (blocker === "busy") {
        expect(
          coordinator(h).prepare({
            kind: "fresh",
            intent: "direct",
            expectedTurnId: coordinator(h).turnId,
          }).status
        ).toBe("admitted");
      } else if (blocker === "admission") reservation = coordinator(h).reserve("admission");
      else coordinator(h).beginShutdown();
      release.resolve();
      expect(await resume).toEqual(Ok({ started: false }));
      expect(Reflect.get(h.session, "lastAutoRetryResumeRequest")).toBe(sentinel);
      expect(stream).not.toHaveBeenCalled();
      reservation?.[Symbol.dispose]();
    }
  );

  test.each(["return", "throw"] as const)(
    "queued %s failure retries a throwing cleanup before idle and drains the successor",
    async (failure) => {
      const h = await harness(`cleanup-retry-${failure}`);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const append = spyOn(h.historyService, "appendToHistory");
      if (failure === "return") append.mockResolvedValueOnce(Err("disk failure"));
      else append.mockRejectedValueOnce(new Error("disk failure"));
      let cleanups = 0;
      const stream = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        expect(cleanups).toBe(2);
        started.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle()));
      });
      h.session.queueMessage("failed", options, {
        synthetic: true,
        onAcceptedPreStreamFailure: async () => {
          if (++cleanups === 1) throw new Error("cleanup transient");
          entered.resolve();
          await release.promise;
        },
      });
      h.session.queueMessage("survivor", options);
      h.session.sendQueuedMessages();
      await entered.promise;
      expect(h.session.isBusy()).toBe(true);
      expect(stream).not.toHaveBeenCalled();
      release.resolve();
      await started.promise;
      await h.session.waitForIdle();
      expect(stream).toHaveBeenCalledTimes(1);
      expect(
        await h.historyService.getHistoryFromLatestBoundary(`cleanup-retry-${failure}`)
      ).toMatchObject(Ok([{ parts: [{ type: "text", text: "survivor" }] }]));
    }
  );

  test("an invalid non-PDF attachment cannot truncate an edit's existing history", async () => {
    const h = await harness("invalid-edit-attachment");
    const original = createMuxMessage("original", "user", "keep me");
    const reply = createMuxMessage("reply", "assistant", "keep this too");
    await h.historyService.appendToHistory("invalid-edit-attachment", original);
    await h.historyService.appendToHistory("invalid-edit-attachment", reply);
    const before = await h.historyService.getHistoryFromLatestBoundary("invalid-edit-attachment");
    const truncate = spyOn(h.historyService, "truncateAfterMessage");
    const rejected = await h.session
      .sendMessage("edit", {
        ...options,
        editMessageId: "original",
        fileParts: [{ url: "https://invalid.example/file", mediaType: "image/png" }],
      })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    if (!(rejected instanceof Error)) throw new Error("Expected invalid attachment rejection");
    expect(rejected.message).toContain("data URL");
    expect(truncate).not.toHaveBeenCalled();
    expect(await h.historyService.getHistoryFromLatestBoundary("invalid-edit-attachment")).toEqual(
      before
    );
  });
  test.each(["transient", "persistent"] as const)(
    "%s failure cleanup cannot suppress original provider failure policy",
    async (failure) => {
      const h = await harness(`provider-cleanup-${failure}`);
      const providerError = { type: "api_key_not_found" as const, provider: "anthropic" as const };
      const stream = spyOn(h.aiService, "streamMessage").mockResolvedValue(Err(providerError));
      const terminalErrors: unknown[] = [];
      h.session.onChatEvent(({ message }) => {
        if (message.type === "stream-error") terminalErrors.push(message);
      });
      let callbacks = 0;
      const result = await h.session.sendMessage("durable input", options, {
        onAcceptedPreStreamFailure: (error) => {
          expect(error).toEqual(providerError);
          expect(h.session.isBusy()).toBe(true);
          if (++callbacks === 1 || failure === "persistent") throw new Error("cleanup unavailable");
        },
      });
      expect(result).toMatchObject(Err(providerError));
      expect(callbacks).toBe(2);
      expect(terminalErrors).toHaveLength(1);
      expect(terminalErrors[0]).toMatchObject({ errorType: "authentication" });
      expect(stream).toHaveBeenCalledTimes(1);
      expect(h.session.isBusy()).toBe(false);
      expect(
        await h.historyService.getHistoryFromLatestBoundary(`provider-cleanup-${failure}`)
      ).toMatchObject(Ok([{ parts: [{ type: "text", text: "durable input" }] }]));
    }
  );

  test("a superseded direct append rolls back only its own row and preserves replacement thinking and retry state", async () => {
    const h = await harness("superseded-direct-state");
    const appended = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      const result = await append(...args);
      appended.resolve();
      await releaseAppend.promise;
      return result;
    });
    const stream = spyOn(h.aiService, "streamMessage").mockImplementation(async () => {
      provider.resolve();
      await releaseProvider.promise;
      return Ok(createStartedTurnHandle());
    });
    const oldSend = h.session.sendMessage("old", options);
    await appended.promise;
    const replacement = h.session.sendMessage("replacement", {
      ...options,
      model: "openai:gpt-4o",
    });
    await provider.promise;
    const owner = coordinator(h).turnId;
    const holder = coordinator(h).thinkingOverride;
    const retry: unknown = Reflect.get(h.session, "lastAutoRetryResumeRequest");
    try {
      releaseAppend.resolve();
      expect((await oldSend).success).toBe(false);
      expect(coordinator(h).turnId).toBe(owner);
      expect(coordinator(h).thinkingOverride).toBe(holder);
      expect(Reflect.get(h.session, "lastAutoRetryResumeRequest")).toBe(retry);
      expect(h.session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: true });
      expect(holder?.pending).toBe("high");
      expect(stream).toHaveBeenCalledTimes(1);
      expect(
        await h.historyService.getHistoryFromLatestBoundary("superseded-direct-state")
      ).toMatchObject(Ok([{ parts: [{ type: "text", text: "replacement" }] }]));
    } finally {
      releaseAppend.resolve();
      releaseProvider.resolve();
      await replacement;
    }
  });

  test("a stale on-send compaction append is rolled back before its request can be replayed", async () => {
    const h = await harness("stale-compaction-append");
    const monitor = (h.session as unknown as { compactionMonitor: CompactionMonitor })
      .compactionMonitor;
    spyOn(monitor, "getThreshold").mockReturnValue(0.85);
    spyOn(monitor, "checkBeforeSend").mockReturnValue({
      shouldShowWarning: true,
      shouldForceCompact: true,
      usagePercentage: 99,
      thresholdPercentage: 85,
    });
    let stale = false;
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      const result = await append(...args);
      stale = true;
      return result;
    });
    const stream = spyOn(h.aiService, "streamMessage");
    const result = await h.session.sendMessage("deferred question", options, {
      admissionStale: () => stale,
    });
    expect(result.success).toBe(false);
    expect(await h.historyService.getHistoryFromLatestBoundary("stale-compaction-append")).toEqual(
      Ok([])
    );
    expect(stream).not.toHaveBeenCalled();
  });
  test("a superseded marker cleanup cannot cancel or enable the replacement's retry", async () => {
    const h = await harness("superseded-marker-clear");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const session = h.session as unknown as {
      clearStartupAutoRetryAbandon(): Promise<void>;
      retryManager: { cancel(): void; setEnabled(enabled: boolean): void };
    };
    spyOn(session, "clearStartupAutoRetryAbandon").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    spyOn(h.aiService, "streamMessage").mockImplementation(async () => {
      provider.resolve();
      await releaseProvider.promise;
      return Ok(createStartedTurnHandle());
    });
    const cancel = spyOn(session.retryManager, "cancel");
    const enable = spyOn(session.retryManager, "setEnabled");
    const oldSend = h.session.sendMessage("old durable row", options);
    await entered.promise;
    const replacement = h.session.sendMessage("replacement", options);
    await provider.promise;
    await h.session.setAutoRetryEnabled(false);
    const canceled = cancel.mock.calls.length;
    const enabled = enable.mock.calls.length;
    const retry: unknown = Reflect.get(h.session, "lastAutoRetryResumeRequest");
    try {
      release.resolve();
      expect((await oldSend).success).toBe(false);
      expect(cancel.mock.calls).toHaveLength(canceled);
      expect(enable.mock.calls).toHaveLength(enabled);
      expect(Reflect.get(h.session, "lastAutoRetryResumeRequest")).toBe(retry);
      expect(Reflect.get(h.session, "autoRetryEnabledPreference")).toBe(false);
      const history =
        await h.historyService.getHistoryFromLatestBoundary("superseded-marker-clear");
      expect(history).toMatchObject(
        Ok([
          { parts: [{ type: "text", text: "old durable row" }] },
          { parts: [{ type: "text", text: "replacement" }] },
        ])
      );
    } finally {
      release.resolve();
      releaseProvider.resolve();
      await replacement;
    }
  });
  test("a held edit owns history before PREPARING and competing direct sends cannot write or start", async () => {
    const h = await harness("held-edit-admission");
    await h.historyService.appendToHistory(
      "held-edit-admission",
      createMuxMessage("original", "user", "before")
    );
    await h.historyService.appendToHistory(
      "held-edit-admission",
      createMuxMessage("reply", "assistant", "old reply")
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const truncate = h.historyService.truncateAfterMessage.bind(h.historyService);
    spyOn(h.historyService, "truncateAfterMessage").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return truncate(...args);
    });
    const stream = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      started.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle()));
    });
    const edit = h.session.sendMessage("edited", { ...options, editMessageId: "original" });
    await entered.promise;
    try {
      expect(h.session.isPreparingTurn()).toBe(false);
      expect(h.session.isBusy()).toBe(true);
      const before = await h.historyService.getHistoryFromLatestBoundary("held-edit-admission");
      expect((await h.session.sendMessage("competing direct", options)).success).toBe(false);
      expect(await h.historyService.getHistoryFromLatestBoundary("held-edit-admission")).toEqual(
        before
      );
      expect(stream).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect((await edit).success).toBe(true);
    await started.promise;
    await h.session.waitForIdle();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(
      await h.historyService.getHistoryFromLatestBoundary("held-edit-admission")
    ).toMatchObject(Ok([{ parts: [{ type: "text", text: "edited" }] }]));
  });
  test.each(["publication", "handoff"] as const)(
    "retired edit %s settles its failure callback before releasing the queue",
    async (seam) => {
      const h = await harness("edit-failure-callback-order");
      await h.historyService.appendToHistory(
        "edit-failure-callback-order",
        createMuxMessage("original", "user", "before")
      );
      const failure = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const stream = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        started.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle()));
      });
      let retire = true;
      const retireEdit = () => {
        if (!retire) return;
        retire = false;
        expect(coordinator(h).preemptPreparation()).toBe(true);
        h.session.queueMessage("successor", options);
      };
      h.session.onChatEvent(({ message }) => {
        if (
          seam === "publication" &&
          message.type === "stream-lifecycle" &&
          message.phase === "preparing"
        )
          retireEdit();
      });
      const edit = h.session.sendMessage(
        "edited",
        { ...options, editMessageId: "original" },
        {
          onTurnAdmissionCommitted: seam === "handoff" ? retireEdit : undefined,
          onAcceptedPreStreamFailure: async () => {
            failure.resolve();
            await release.promise;
          },
        }
      );
      await failure.promise;
      try {
        expect(h.session.queuedMessageEntryCount()).toBe(1);
        expect(stream).not.toHaveBeenCalled();
        expect(h.session.isBusy()).toBe(true);
      } finally {
        release.resolve();
        expect((await edit).success).toBe(seam === "handoff");
      }
      await started.promise;
      await h.session.waitForIdle();
      expect(stream).toHaveBeenCalledTimes(1);
    }
  );
  test.each(["before-handle", "delivered-handle"] as const)(
    "edit %s failure releases its exclusion before recovery can claim a turn",
    async (stage) => {
      const h = await harness(`edit-policy-handoff-${stage}`);
      await h.historyService.appendToHistory(
        `edit-policy-handoff-${stage}`,
        createMuxMessage("original", "user", "before")
      );
      const handoff = Promise.withResolvers<PreparationAdmission>();
      spyOn(h.aiService, "streamMessage").mockImplementation(() =>
        Promise.resolve(
          stage === "before-handle"
            ? Err({ type: "api_key_not_found" as const, provider: "anthropic" as const })
            : Ok(
                createFailedTurnHandle("edit-failed", {
                  error: "missing credentials",
                  errorType: "authentication",
                })
              )
        )
      );
      h.session.onChatEvent(({ message }) => {
        if (message.type !== "stream-error") return;
        handoff.resolve(
          coordinator(h).prepare({
            kind: "fresh",
            intent: "handoff",
            expectedTurnId: coordinator(h).turnId,
          })
        );
      });
      expect(
        (await h.session.sendMessage("edited", { ...options, editMessageId: "original" })).success
      ).toBe(true);
      const admission = await handoff.promise;
      expect(admission.status).toBe("admitted");
      if (admission.status === "admitted") coordinator(h).finishPreparation(admission.turnId);
      await h.session.waitForIdle();
    }
  );
});
