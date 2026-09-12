import { createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  createStreamCollector,
  HAIKU_MODEL,
} from "../helpers";
import { createMuxMessage } from "@/common/types/message";
import { CompactionCancellation } from "@/node/services/compactionCancellation";
import { HistoryService } from "@/node/services/historyService";

// Jest supplies native structuredClone from another realm. Exercise the real acceptance
// seam and IPC resume with mock streaming so value equality cannot regress unnoticed.
describe("replacement acceptance before mock IPC resume", () => {
  test.each(["append", "resume"] as const)("accepts an exact %s replacement", async (kind) => {
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    const repo = await createTempGitRepo();
    try {
      const workspace = await createWorkspace(env, repo, generateBranchName("replacement"));
      if (!workspace.success) throw new Error(String(workspace.error));
      const workspaceId = workspace.metadata.id;
      const history = new HistoryService(env.config);
      const original = createMuxMessage("original", "user", "mock input");
      expect((await history.appendToHistory(workspaceId, original)).success).toBe(true);
      const cancellation = new CompactionCancellation(
        history.getCompactionCancellationStorage(workspaceId)
      );
      await cancellation.cancel({ retainUntilReplacement: true });
      const capture = await history.captureCompactionReplacement(workspaceId);
      if (!capture.success) throw new Error(capture.error);
      const loaded = await history.getLastMessages(workspaceId, 1);
      if (!loaded.success) throw new Error(loaded.error);
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        capture.data,
        kind === "append"
          ? { kind, messages: [createMuxMessage("replacement", "user", "mock replacement")] }
          : { kind, message: loaded.data[0] },
        { isCurrent: () => true, onCommitted: () => undefined }
      );
      expect(result).toEqual({
        success: true,
        data: { kind: "accepted", witness: { nonce: capture.data.nonce } },
      });
      if (!result.success || result.data.kind !== "accepted" || !result.data.witness)
        throw new Error("Expected a replacement witness");
      await cancellation.retireReplacement(result.data.witness);
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      try {
        await collector.waitForSubscription(5000);
        expect(
          (
            await env.orpc.workspace.resumeStream({
              workspaceId,
              options: { model: HAIKU_MODEL, agentId: "exec" },
            })
          ).success
        ).toBe(true);
        await collector.waitForEvent("stream-end", 15000);
        expect(
          collector.getEvents().filter((event) => "type" in event && event.type === "stream-error")
        ).toEqual([]);
      } finally {
        collector.stop();
      }
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repo);
    }
  });
});
