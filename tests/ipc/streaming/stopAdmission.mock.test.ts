import { createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  createStreamCollector,
  sendMessageWithModel,
  HAIKU_MODEL,
} from "../helpers";
import { HistoryService } from "@/node/services/historyService";
import { resumeAndWaitForSuccess } from "../streamCollector";
import { MockAiRouter } from "@/node/services/mock/mockAiRouter";

async function createMockWorkspace() {
  const env = await createTestEnvironment();
  env.services.aiService.enableMockMode();
  const repo = await createTempGitRepo();
  const workspace = await createWorkspace(env, repo, generateBranchName("stop-admission"));
  if (!workspace.success) throw new Error(String(workspace.error));
  return {
    env,
    workspaceId: workspace.metadata.id,
    async [Symbol.asyncDispose]() {
      await env.orpc.workspace.remove({
        workspaceId: workspace.metadata.id,
        options: { force: true },
      });
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repo);
    },
  };
}

describe("manual admission after mock stream interruption", () => {
  test.each([
    "manual",
    "manual-batch",
    "automatic",
    "caller-canceled",
    "manual-with-automatic",
    "stopped-again",
  ] as const)(
    "send now preserves %s admission",
    async (kind) => {
      await using fixture = await createMockWorkspace();
      const { env, workspaceId } = fixture;
      const collector = createStreamCollector(env.orpc, workspaceId);
      const session = env.services.workspaceService.getOrCreateSession(workspaceId);
      let stopAgain = false;
      let stopping: ReturnType<typeof session.cancelCompaction> | undefined;
      const unsubscribe = session.onChatEvent(({ message }) => {
        if (stopAgain && message.type === "queued-message-changed" && !message.hasQueuedMessages) {
          stopAgain = false;
          stopping = session.cancelCompaction();
        }
      });
      collector.start();
      try {
        await collector.waitForSubscription(5000);
        expect(
          (
            await sendMessageWithModel(
              env,
              workspaceId,
              `source${" keep-streaming".repeat(600)}`,
              HAIKU_MODEL
            )
          ).success
        ).toBe(true);
        expect(await collector.waitForEvent("stream-start", 5000)).not.toBeNull();
        expect(await collector.waitForEvent("stream-delta", 5000)).not.toBeNull();
        let callerCanceled = false;
        if (kind === "manual-with-automatic") {
          expect(
            (
              await env.services.workspaceService.sendMessage(
                workspaceId,
                "hidden automatic",
                { model: HAIKU_MODEL, agentId: "exec" },
                { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
              )
            ).success
          ).toBe(true);
        }
        expect(
          (
            await env.services.workspaceService.sendMessage(
              workspaceId,
              "queued replacement",
              { model: HAIKU_MODEL, agentId: "exec" },
              {
                acceptanceOrigin: kind === "automatic" ? "automatic" : "manual",
                ...(kind === "caller-canceled" ? { admissionStale: () => callerCanceled } : {}),
              }
            )
          ).success
        ).toBe(true);
        if (kind === "manual-batch") {
          expect(
            (
              await env.services.workspaceService.sendMessage(workspaceId, "second addition", {
                model: HAIKU_MODEL,
                agentId: "exec",
              })
            ).success
          ).toBe(true);
        }
        callerCanceled = kind === "caller-canceled";
        expect(await collector.waitForEvent("queued-message-changed", 5000)).not.toBeNull();
        stopAgain = kind === "stopped-again";
        const interrupted = await env.orpc.workspace.interruptStream({
          workspaceId,
          options: { sendQueuedImmediately: true },
        });
        expect(interrupted).toEqual({ success: true, data: undefined });
        await session.waitForIdle();
        await stopping;
        if (kind === "stopped-again") expect(stopping).toBeDefined();
        const history = await new HistoryService(env.config).getLastMessages(workspaceId, 10);
        expect(history.success).toBe(true);
        expect(collector.getEvents().filter((event) => event.type === "stream-error")).toEqual([]);
        expect(
          history.success && history.data.filter((row) => row.role === "user").map((row) => row.id)
        ).toHaveLength(kind.startsWith("manual") ? 2 : 1);
        if (kind === "manual-batch" && history.success) {
          expect(history.data.findLast((row) => row.role === "user")?.parts).toEqual([
            expect.objectContaining({ type: "text", text: "queued replacement\nsecond addition" }),
          ]);
        }
        if (history.success)
          expect(
            history.data.some((row) =>
              row.parts.some((part) => part.type === "text" && part.text === "hidden automatic")
            )
          ).toBe(false);
      } finally {
        unsubscribe();
        collector.stop();
      }
    },
    25000
  );

  test.each([false, true])(
    "resume checks only its own error window (fails=%s)",
    async (fails) => {
      await using fixture = await createMockWorkspace();
      const { env, workspaceId } = fixture;
      const session = env.services.workspaceService.getOrCreateSession(workspaceId);
      await session.setAutoRetryEnabled(false);
      const original = createStreamCollector(env.orpc, workspaceId);
      const reply = jest
        .spyOn(MockAiRouter.prototype, "route")
        .mockReturnValueOnce({
          assistantText: "stable original prefix",
          error: { message: "original interruption", type: "server_error" },
        })
        .mockReturnValueOnce({
          assistantText: "continued response",
          ...(fails
            ? { error: { message: "resumed interruption", type: "server_error" as const } }
            : {}),
        });
      original.start();
      try {
        await original.waitForSubscription(5000);
        expect(
          (
            await sendMessageWithModel(
              env,
              workspaceId,
              `source${" keep-streaming".repeat(600)}`,
              HAIKU_MODEL
            )
          ).success
        ).toBe(true);
        expect(await original.waitForEvent("stream-delta", 5000)).not.toBeNull();
        expect(await original.waitForEvent("stream-error", 5000)).not.toBeNull();
        await session.waitForIdle();
        // Mock error playback clears partials. Seed the delivered prefix as real
        // stream recovery does, so the resumed acceptance also preserves existing text.
        const historyService = new HistoryService(env.config);
        const before = await historyService.getLastMessages(workspaceId, 10);
        if (!before.success) throw new Error(before.error);
        const assistant = before.data.findLast((row) => row.role === "assistant");
        if (!assistant) throw new Error("Expected the interrupted assistant row");
        const prefix = original
          .getDeltas()
          .map((event) => ("delta" in event ? event.delta : ""))
          .join("");
        expect(prefix.length).toBeGreaterThan(0);
        expect(
          (
            await historyService.updateHistory(workspaceId, {
              ...assistant,
              parts: [{ type: "text", text: prefix }],
            })
          ).success
        ).toBe(true);
        original.clear();
        const resuming = resumeAndWaitForSuccess(workspaceId, env.orpc, HAIKU_MODEL, 5000);
        if (fails) {
          await expect(resuming).rejects.toThrow();
          expect(original.getEvents().filter((event) => event.type === "stream-error")).toEqual([
            expect.objectContaining({ error: "resumed interruption" }),
          ]);
        } else {
          await resuming;
          await session.waitForIdle();
          const history = await new HistoryService(env.config).getLastMessages(workspaceId, 10);
          expect(history.success).toBe(true);
          const texts = history.success
            ? history.data
                .flatMap((row) => row.parts)
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [];
          expect(texts).toContain(prefix);
          expect(texts).toContain("continued response");
        }
      } finally {
        reply.mockRestore();
        original.stop();
      }
    },
    25000
  );
});
