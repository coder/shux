import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import type { TurnCoordinator } from "./turnCoordinator";
import * as branchSummary from "./branchSummary";
import { createAgentSessionHarness } from "./agentSession.testHarness";

afterEach(() => mock.restore());

test.each(["before preparation", "during provider startup"] as const)(
  "an accepted handoff stays continued when replaced %s before send returns an error",
  async (replacementPoint) => {
    const workspaceId = "replaced-accepted-compaction";
    const h = await createAgentSessionHarness({ workspaceId });
    const options = { model: "openai:gpt-4o", agentId: "exec" };
    const internals = h.session as unknown as {
      coordinator: TurnCoordinator;
      dispatchPendingFollowUp(): Promise<boolean>;
    };
    const send = h.session.sendMessage.bind(h.session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = spyOn(h.aiService, "streamMessage");
    if (replacementPoint === "before preparation") {
      spyOn(h.session, "sendMessage").mockImplementationOnce((message, sendOptions, internal) =>
        send(message, sendOptions, {
          ...internal,
          onAccepted: async () => {
            await internal?.onAccepted?.();
            entered.resolve();
            await release.promise;
          },
        })
      );
    } else {
      stream.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return Err({ type: "runtime_start_failed", message: "retired startup failed" });
      });
    }
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "Earlier work", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Continue", ...options },
        },
      })
    );
    const pending = internals.dispatchPendingFollowUp();
    try {
      await entered.promise;
      // A blocked startup can be retired before its engine call returns; its
      // durable continuation still belongs to the predecessor's completed handoff.
      if (replacementPoint === "during provider startup")
        internals.coordinator.preemptPreparation();
      expect((await send("manual replacement", options)).success).toBe(true);
      release.resolve();
      expect(await pending).toBe(true);
      expect(stream).toHaveBeenCalledTimes(replacementPoint === "before preparation" ? 1 : 2);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(
        history.success &&
          history.data.filter((message) => message.role === "user").map((message) => message.parts)
      ).toMatchObject([
        [{ type: "text", text: "Continue" }],
        [{ type: "text", text: "manual replacement" }],
      ]);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([false, true])(
  "an accepted handoff still reports a current provider startup failure (later replacement=%s)",
  async (replaceAfterFailure) => {
    const workspaceId = "failed-accepted-compaction";
    const h = await createAgentSessionHarness({ workspaceId });
    spyOn(h.aiService, "streamMessage").mockResolvedValueOnce(
      Err({ type: "runtime_start_failed", message: "provider startup failed" })
    );
    if (replaceAfterFailure) {
      const send = h.session.sendMessage.bind(h.session);
      spyOn(h.session, "sendMessage").mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        expect(result.success).toBe(false);
        expect(
          (await send("manual replacement", { model: "openai:gpt-4o", agentId: "exec" })).success
        ).toBe(true);
        return result;
      });
    }
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "Earlier work", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Continue", model: "openai:gpt-4o", agentId: "exec" },
        },
      })
    );
    try {
      const dispatch = h.session as unknown as { dispatchPendingFollowUp(): Promise<boolean> };
      const failure = await dispatch.dispatchPendingFollowUp().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty("message", expect.stringContaining("provider startup failed"));
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(
        history.success && history.data.find((message) => message.role === "user")?.parts
      ).toMatchObject([{ type: "text", text: "Continue" }]);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("disposal during real pre-acceptance preparation does not report a continued handoff", async () => {
  const workspaceId = "unaccepted-compaction";
  const h = await createAgentSessionHarness({ workspaceId });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stream = spyOn(h.aiService, "streamMessage");
  spyOn(branchSummary, "awaitPendingBranchSummary").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return null;
  });
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("summary", "assistant", "Earlier work", {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: {
          text: "Continue",
          model: "openai:gpt-4o",
          agentId: "exec",
        },
      },
    })
  );
  const dispatch = h.session as unknown as { dispatchPendingFollowUp(): Promise<boolean> };
  const pending = dispatch.dispatchPendingFollowUp();
  let disposal: Promise<void> | undefined;
  try {
    await entered.promise;
    disposal = h.session.dispose();
    release.resolve();
    expect(await pending).toBe(false);
    await disposal;
    expect(stream).not.toHaveBeenCalled();
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success && history.data.some((message) => message.role === "user")).toBe(false);
  } finally {
    release.resolve();
    await pending;
    await disposal;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("an accepted real handoff stays continued after a subsequent manual replacement", async () => {
  const workspaceId = "accepted-compaction";
  const h = await createAgentSessionHarness({ workspaceId });
  const options = { model: "openai:gpt-4o", agentId: "exec" };
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("summary", "assistant", "Earlier work", {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Continue", ...options },
      },
    })
  );
  const send = h.session.sendMessage.bind(h.session);
  spyOn(h.session, "sendMessage").mockImplementationOnce(async (...args) => {
    const result = await send(...args);
    expect(result.success).toBe(true);
    await h.session.interruptStream();
    expect((await send("manual replacement", options)).success).toBe(true);
    return result;
  });
  try {
    const dispatch = h.session as unknown as { dispatchPendingFollowUp(): Promise<boolean> };
    expect(await dispatch.dispatchPendingFollowUp()).toBe(true);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(
      history.success &&
        history.data.filter((message) => message.role === "user").map((message) => message.parts)
    ).toMatchObject([
      [{ type: "text", text: "Continue" }],
      [{ type: "text", text: "manual replacement" }],
    ]);
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});
