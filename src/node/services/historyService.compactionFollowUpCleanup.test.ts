import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { createTestHistoryService } from "./testHistoryService";

const workspaceId = "follow-up-cleanup";
const actions = ["clear", "rollback-heartbeat"] as const;
const request = { text: "resume", model: "openai:gpt-4o", agentId: "exec" };

function summary() {
  return createMuxMessage("summary", "assistant", "summary", {
    compacted: "heartbeat",
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: { type: "compaction-summary", pendingFollowUp: request },
  });
}

function afterNextAtomicWrite(after: () => Promise<void>) {
  const write = atomicWrite.default;
  spyOn(atomicWrite, "default").mockImplementationOnce(
    Object.assign(
      async (
        filename: string,
        contents: string | Buffer,
        options?: atomicWrite.Options | BufferEncoding | ((error?: Error) => void)
      ) => {
        assert(typeof options !== "function", "Cleanup uses the Promise write interface");
        await write(filename, contents, options);
        await after();
      },
      { sync: write.sync }
    )
  );
}

describe("conditional compaction follow-up cleanup", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    store = await createTestHistoryService();
  });
  afterEach(async () => {
    mock.restore();
    await store.cleanup();
  });

  test("clearing a handoff preserves late summary finalization and unrelated rows", async () => {
    const expected = summary();
    expect(await store.historyService.appendToHistory(workspaceId, expected)).toEqual(
      Ok(undefined)
    );
    const finalized = {
      ...expected,
      parts: [{ type: "text" as const, text: "finalized summary" }],
      metadata: { ...expected.metadata, duration: 42 },
    };
    expect(await store.historyService.updateHistory(workspaceId, finalized)).toEqual(Ok(undefined));
    const later = createMuxMessage("later", "user", "new input");
    await store.historyService.appendToHistory(workspaceId, later);
    expect(
      await store.historyService.cleanupCompactionFollowUp(
        workspaceId,
        expected,
        "clear",
        () => true
      )
    ).toEqual(Ok("applied"));
    const history = await store.historyService.getLastMessages(workspaceId, 2);
    assert(history.success, "Expected history");
    expect(history.data[0]).toMatchObject({
      ...finalized,
      metadata: { ...finalized.metadata, muxMetadata: { type: "compaction-summary" } },
    });
    expect(history.data[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
    expect(history.data[1]).toMatchObject(later);
    expect(
      await store.historyService.cleanupCompactionFollowUp(
        workspaceId,
        expected,
        "clear",
        () => true
      )
    ).toEqual(Ok("skipped"));
  });

  test("staging failure preserves history and removes the incomplete cleanup file", async () => {
    const expected = summary();
    await store.historyService.appendToHistory(workspaceId, expected);
    const sessionDir = path.join(store.config.sessionsDir, workspaceId);
    const historyPath = path.join(sessionDir, "chat.jsonl");
    const original = await fs.readFile(historyPath);
    afterNextAtomicWrite(() => Promise.reject(new Error("staging failed")));
    const result = await store.historyService.cleanupCompactionFollowUp(
      workspaceId,
      expected,
      "clear",
      () => true
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("staging failed");
    expect(await fs.readFile(historyPath)).toEqual(original);
    expect((await fs.readdir(sessionDir)).filter((name) => name.includes(".follow-up-"))).toEqual(
      []
    );
  });

  for (const action of actions) {
    test.each(["id", "sequence", "request"] as const)(
      `${action} skips a replaced %s after waiting for the history lock`,
      async (changed) => {
        const expected = summary();
        await store.historyService.appendToHistory(workspaceId, expected);
        let replacementSummary = expected;
        if (changed === "sequence") {
          await store.historyService.deleteMessage(workspaceId, expected.id);
          replacementSummary = summary();
          await store.historyService.appendToHistory(workspaceId, replacementSummary);
          expect(replacementSummary.metadata?.historySequence).not.toBe(
            expected.metadata?.historySequence
          );
        }
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const held = workspaceFileLocks.withLock(workspaceId, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        // Queue the replacement before cleanup. Both execute through the real history lock.
        const replacement = store.historyService.updateHistory(workspaceId, {
          ...replacementSummary,
          id: changed === "id" ? "replacement" : expected.id,
          metadata: {
            ...replacementSummary.metadata,
            muxMetadata: {
              type: "compaction-summary",
              pendingFollowUp: changed === "request" ? { ...request, text: "new work" } : request,
            },
          },
        });
        const cleanup = store.historyService.cleanupCompactionFollowUp(
          workspaceId,
          expected,
          action,
          () => true
        );
        try {
          release.resolve();
          expect(await replacement).toEqual(Ok(undefined));
          expect(await cleanup).toEqual(Ok("skipped"));
          const history = await store.historyService.getLastMessages(workspaceId, 1);
          assert(history.success, "Expected replacement history");
          expect(history.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
          expect(history.data[0].id).toBe(changed === "id" ? "replacement" : "summary");
        } finally {
          release.resolve();
          await Promise.all([held, replacement, cleanup]);
        }
      }
    );

    test(`${action} rechecks local ownership after staged I/O and removes the unused file`, async () => {
      const expected = summary();
      await store.historyService.appendToHistory(workspaceId, expected);
      const sessionDir = path.join(store.config.sessionsDir, workspaceId);
      const historyPath = path.join(sessionDir, "chat.jsonl");
      const original = await fs.readFile(historyPath);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      afterNextAtomicWrite(async () => {
        entered.resolve();
        await release.promise;
      });
      let current = true;
      const cleanup = store.historyService.cleanupCompactionFollowUp(
        workspaceId,
        expected,
        action,
        () => current
      );
      try {
        await entered.promise;
        current = false;
        release.resolve();
        expect(await cleanup).toEqual(Ok("skipped"));
        expect(await fs.readFile(historyPath)).toEqual(original);
        expect(
          (await fs.readdir(sessionDir)).filter((name) => name.includes(".follow-up-"))
        ).toEqual([]);
      } finally {
        release.resolve();
        await cleanup;
      }
    });
  }

  test("heartbeat deletion preserves the archive and never reuses its removed sequence", async () => {
    await store.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("prior", "user", "context")
    );
    const expected = summary();
    await store.historyService.appendToHistory(workspaceId, expected);
    expect(
      await store.historyService.cleanupCompactionFollowUp(
        workspaceId,
        expected,
        "rollback-heartbeat",
        () => true
      )
    ).toEqual(Ok("applied"));
    const next = createMuxMessage("next", "user", "new input");
    await store.historyService.appendToHistory(workspaceId, next);
    expect(next.metadata!.historySequence!).toBeGreaterThan(expected.metadata!.historySequence!);
    const history = await store.historyService.getLastMessages(workspaceId, 10);
    assert(history.success, "Expected restored history");
    expect(history.data.map((row) => row.id)).toEqual(["prior", "next"]);
  });
});
