import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as contextLimits from "@/common/utils/compaction/contextLimit";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { createTestHistoryService } from "./testHistoryService";
import { createMuxMessage } from "@/common/types/message";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { Err, Ok } from "@/common/types/result";
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

  test.each(
    (["initial", "materialized"] as const).flatMap((branch) =>
      (["history", "goal"] as const).map((heldWrite) => ({ branch, heldWrite }))
    )
  )(
    "$branch send rejection retains its scope through the $heldWrite write",
    async ({ branch, heldWrite }) => {
      const appFiberScope = Scope.makeUnsafe("parallel");
      const history = await createTestHistoryService();
      await history.config.addWorkspace(history.config.rootDir, {
        id: workspaceId,
        name: workspaceId,
        projectName: "rejection",
        projectPath: history.config.rootDir,
        runtimeConfig: { type: "local" },
      });
      const goalService = new WorkspaceGoalService(
        history.config,
        history.historyService,
        new ExtensionMetadataService(path.join(history.config.rootDir, "extension.json"))
      );
      const h = await createAgentSessionHarness({
        workspaceId,
        appFiberScope,
        config: history.config,
        historyService: history.historyService,
        workspaceGoalService: goalService,
        aiServiceOverrides: {
          getWorkspaceMetadata: mock(() =>
            Promise.resolve(
              Ok({
                id: workspaceId,
                name: workspaceId,
                projectName: "rejection",
                projectPath: history.config.rootDir,
                namedWorkspacePath: history.config.rootDir,
                runtimeConfig: { type: "local" },
              } as FrontendWorkspaceMetadata)
            )
          ),
        },
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const limit = spyOn(contextLimits, "getEffectiveContextLimit").mockReturnValue(10000);
      let closed = false;
      let closing: Promise<void> | undefined;
      let send: ReturnType<typeof h.session.sendMessage> | undefined;
      const writes: string[] = [];
      const writesAfterDrain: string[] = [];
      try {
        expect(
          (await goalService.setGoal({ workspaceId, objective: "Continue until interrupted" }))
            .success
        ).toBe(true);
        const append = h.historyService.appendToHistory.bind(h.historyService);
        spyOn(h.historyService, "appendToHistory").mockImplementation(async (id, message) => {
          if (message.metadata?.contextBudgetRejected && heldWrite === "history") {
            entered.resolve();
            await release.promise;
          }
          const result = await append(id, message);
          if (message.metadata?.contextBudgetRejected) {
            writes.push("history");
            if (closed) writesAfterDrain.push("history");
          }
          return result;
        });
        const setGoal = goalService.setGoal.bind(goalService);
        spyOn(goalService, "setGoal").mockImplementation(async (input) => {
          if (input.status === "paused" && heldWrite === "goal") {
            entered.resolve();
            await release.promise;
          }
          const result = await setGoal(input);
          if (input.status === "paused") {
            writes.push("goal");
            if (closed) writesAfterDrain.push("goal");
          }
          return result;
        });
        const large = ("漢".repeat(100) + "\n").repeat(40);
        if (branch === "materialized")
          await fs.writeFile(path.join(history.config.rootDir, "oversized.txt"), large);
        send = h.session.sendMessage(branch === "initial" ? large : "Read @oversized.txt", {
          ...options,
          experiments: { tokenBudget: true },
        });
        await entered.promise;
        expect(h.session.isBusy()).toBe(false);
        closing = runner.runPromise(Scope.close(appFiberScope, Exit.void)).then(() => {
          closed = true;
        });
        await runner.runPromise(Effect.yieldNow);
        expect(closed).toBe(false);
        release.resolve();
        const [result] = await Promise.all([send, closing]);
        expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
        expect(closed).toBe(true);
        expect(writes).toEqual(["history", "goal"]);
        expect(writesAfterDrain).toEqual([]);
        expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
        const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(rows.success && rows.data.some((row) => row.metadata?.contextBudgetRejected)).toBe(
          true
        );
        expect(spyOn(h.aiService, "streamMessage")).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await send;
        await (closing ?? runner.runPromise(Scope.close(appFiberScope, Exit.void)));
        limit.mockRestore();
        h.session.dispose();
        await history.cleanup();
      }
    }
  );

  test.each(["throw", "reject", "empty-history", "budget-rejected"])(
    "registered preparation %s does not orphan shutdown",
    async (failure) => {
      const appFiberScope = Scope.makeUnsafe("parallel");
      const h = await createAgentSessionHarness({ workspaceId, appFiberScope });
      if (failure === "throw" || failure === "reject") {
        spyOn(h.historyService, "commitPartial").mockImplementationOnce(() => {
          if (failure === "throw") throw new Error("preparation failed");
          return Promise.reject(new Error("preparation failed"));
        });
      }
      if (failure === "budget-rejected") {
        const rejected = createContextBudgetRejectedMessage(
          createMuxMessage("rejected-request", "user", "Cannot fit this request")
        );
        expect((await h.historyService.appendToHistory(workspaceId, rejected)).success).toBe(true);
      }
      try {
        const resumed = h.session.resumeStream(options);
        if (failure === "budget-rejected")
          expect(await resumed).toMatchObject({
            success: false,
            error: { type: "context_budget_blocked" },
          });
        else if (failure === "empty-history") expect((await resumed).success).toBe(false);
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
