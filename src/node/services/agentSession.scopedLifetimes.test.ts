import { describe, expect, mock, spyOn, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { Err } from "@/common/types/result";
import { defaultEffectRunner as runner } from "./di/effectRunner";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "scoped-turn";
const options = { model: "openai:gpt-4o", agentId: "exec" };

describe("AgentSession scoped turn lifetimes", () => {
  test("queue clear publication cannot outrun its cancellation refund", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
    h.session.queueMessage("clear me", options, {
      onCanceled: () => {
        entered.resolve();
        return release.promise;
      },
    });
    let closing: Promise<void> | undefined;
    let closed = false;
    h.session.onChatEvent(({ message }) => {
      if (message.type === "queued-message-changed") {
        closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
          closed = true;
        });
      }
    });
    try {
      h.session.clearQueue();
      await entered.promise;
      await runner.runPromise(Effect.yieldNow);
      expect(closing).toBeDefined();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
    } finally {
      release.resolve();
      h.session.dispose();
      await h.cleanup();
    }
  });

  test("actual startup recovery remains supervised before any send", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
    const recovery = h.session as unknown as {
      requireGoalAcknowledgmentForCrashRecoveredPartial(): Promise<void>;
    };
    const original = recovery.requireGoalAcknowledgmentForCrashRecoveredPartial.bind(h.session);
    spyOn(recovery, "requireGoalAcknowledgmentForCrashRecoveredPartial").mockImplementation(
      async () => {
        await original();
        entered.resolve();
        await release.promise;
      }
    );
    const recovering = h.session.runStartupRecovery();
    try {
      await entered.promise;
      let closed = false;
      const closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
        closed = true;
      });
      await runner.runPromise(Effect.yieldNow);
      expect(closed).toBe(false);
      release.resolve();
      await Promise.all([recovering, closing]);
      expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await recovering;
      h.session.dispose();
      await h.cleanup();
    }
  });

  test.each([false, true])(
    "queued failure cleanup stays supervised (reentrant close=%s)",
    async (reentrant) => {
      const appFiberScope = Scope.makeUnsafe("parallel");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
      spyOn(h.historyService, "appendToHistory").mockResolvedValueOnce(Err("disk unavailable"));
      let closing: Promise<void> | undefined;
      let closed = false;
      const close = (): void => {
        closing ??= runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
          closed = true;
        });
      };
      h.session.queueMessage("queued", options, {
        synthetic: true,
        onAcceptedPreStreamFailure: () => {
          entered.resolve();
          return release.promise;
        },
      });
      if (reentrant) {
        // Dequeue publication precedes sendMessage. A missing outer lease would let the guardian
        // finish here before the queued producer's own call has even been registered.
        h.session.onChatEvent(({ message }) => {
          if (message.type === "queued-message-changed") {
            close();
          }
        });
      }
      try {
        h.session.sendQueuedMessages();
        if (!reentrant) await entered.promise;
        close();
        if (!reentrant) {
          await runner.runPromise(Effect.yieldNow);
          expect(closed).toBe(false);
        }
        release.resolve();
        await closing;
        expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test("shutdown joins a durable user append admitted before preparation", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementation(async (id, message) => {
      const result = await append(id, message);
      if (message.role === "user") {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const send = h.session.sendMessage("persist before preparing", options);
    let closed = false;
    try {
      await entered.promise;
      expect(h.session.isBusy()).toBe(false);
      const closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
        closed = true;
      });
      await runner.runPromise(Effect.yieldNow);
      expect(closed).toBe(false);
      expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([send, closing]);
      expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.some((message) => message.role === "user")).toBe(true);
    } finally {
      release.resolve();
      await send;
      h.session.dispose();
      await h.cleanup();
    }
  });

  test("background startup and its failure callback outlive the foreground lease", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const started = Promise.withResolvers<void>();
    const releaseStartup = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const releaseFailure = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({
      workspaceId,
      appFiberScope,
      aiServiceOverrides: {
        streamMessage: mock(async () => {
          started.resolve();
          await releaseStartup.promise;
          return Err({ type: "unknown" as const, raw: "held startup failure" });
        }),
      },
    });
    const onAcceptedPreStreamFailure = mock(() => {
      failed.resolve();
      return releaseFailure.promise;
    });
    try {
      await h.session.sendMessage("background", options, {
        startStreamInBackground: true,
        onAcceptedPreStreamFailure,
      });
      await started.promise;
      let closed = false;
      const closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      releaseStartup.resolve();
      await failed.promise;
      expect(closed).toBe(false);
      releaseFailure.resolve();
      await closing;
      expect(onAcceptedPreStreamFailure).toHaveBeenCalledTimes(1);
    } finally {
      releaseStartup.resolve();
      releaseFailure.resolve();
      h.session.dispose();
      await h.cleanup();
    }
  });

  test.each(["throw", "reject", "empty-history"])(
    "registered preparation %s does not orphan shutdown",
    async (failure) => {
      const appFiberScope = Scope.makeUnsafe("parallel");
      const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
      if (failure !== "empty-history") {
        spyOn(h.historyService, "commitPartial").mockImplementationOnce(() => {
          if (failure === "throw") throw new Error("preparation failed");
          return Promise.reject(new Error("preparation failed"));
        });
      }
      try {
        const resumed = h.session.resumeStream(options);
        if (failure === "empty-history") expect((await resumed).success).toBe(false);
        else expect(await resumed.catch((error: unknown) => error)).toBeInstanceOf(Error);
        await runner.runPromise(Scope.close(appFiberScope, Exit.void));
        expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
      } finally {
        h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test("a session constructed after app close refuses admission with initialized collaborators", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    await runner.runPromise(Scope.close(appFiberScope, Exit.void));
    const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
    const append = spyOn(h.historyService, "appendToHistory");
    try {
      expect((await h.session.sendMessage("too late", options)).success).toBe(false);
      expect(await h.session.resumeStream(options)).toEqual({
        success: true,
        data: { started: false },
      });
      expect(append).not.toHaveBeenCalled();
      expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
    } finally {
      h.session.dispose();
      await h.cleanup();
    }
  });

  test("a disposed session remains supervised while its accepted write settles", async () => {
    const appFiberScope = Scope.makeUnsafe("parallel");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
    const send = h.session.sendMessage("accepted", options, {
      onAccepted: () => {
        entered.resolve();
        return release.promise;
      },
    });
    try {
      await entered.promise;
      h.session.dispose();
      let closed = false;
      const closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
        closed = true;
      });
      await runner.runPromise(Effect.yieldNow);
      expect(closed).toBe(false);
      release.resolve();
      await Promise.all([send, closing]);
      expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await send;
      h.session.dispose();
      await h.cleanup();
    }
  });
});
