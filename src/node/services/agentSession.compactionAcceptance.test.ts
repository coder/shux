import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import * as branchSummary from "./branchSummary";
import { createAgentSessionHarness } from "./agentSession.testHarness";

afterEach(() => mock.restore());

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
