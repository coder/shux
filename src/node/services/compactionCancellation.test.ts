import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CompactionCancellation } from "./compactionCancellation";
import { createTestHistoryService } from "./testHistoryService";
import { HistoryService } from "./historyService";
import { createMuxMessage } from "@/common/types/message";

afterEach(() => mock.restore());

test("retired cancellation writes and clears cannot overwrite the successor nonce", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-order";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  const stoppedA = state.cancel();
  try {
    await entered.promise;
    const a = await state.read();
    if (!a) throw new Error("Expected cancellation A");
    const retired = state.retire(a.nonce);
    const stoppedB = state.cancel();
    const b = await state.read();
    expect(b?.nonce).not.toBe(a.nonce);
    release.resolve();
    await Promise.all([stoppedA, retired, stoppedB]);
    expect(
      (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
    ).toBe(b?.nonce);
  } finally {
    release.resolve();
    await stoppedA;
    await state.flush();
    await h.cleanup();
  }
});

test("late exact narrowing cannot replace another service's newer cancellation", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-foreign";
  const a = new CompactionCancellation(h.historyService, workspaceId);
  await a.cancel();
  const record = await a.read();
  if (!record) throw new Error("Expected cancellation");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  const narrowing = a.narrow(
    record.nonce,
    createMuxMessage("summary-a", "assistant", "summary", {
      historySequence: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "A", model: "openai:gpt-4o", agentId: "exec" },
      },
    })
  );
  try {
    await entered.promise;
    const b = new CompactionCancellation(new HistoryService(h.config), workspaceId);
    await b.cancel();
    const successor = await b.read();
    release.resolve();
    await narrowing;
    await a.retire(record.nonce);
    expect(
      (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
    ).toBe(successor?.nonce);
  } finally {
    release.resolve();
    await narrowing;
    await h.cleanup();
  }
});

test("failed retirement retries deletion while retaining conservative exclusion", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-retire";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  try {
    await state.cancel();
    const record = await state.read();
    if (!record) throw new Error("Expected cancellation");
    spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
      new Error("unlink failed")
    );
    const failure = await state.retire(record.nonce).catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "unlink failed");
    expect(state.needsPersistence).toBe(true);
    expect((await state.read())?.nonce).toBe(record.nonce);
    await state.retry();
    expect(state.needsPersistence).toBe(false);
    expect(await state.read()).toBeNull();
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
  } finally {
    await h.cleanup();
  }
});

test("failed initial publication cannot be acknowledged by exact narrowing", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-first-write";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
    new Error("first write failed")
  );
  try {
    const failure = await state.cancel().catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "first write failed");
    const record = await state.read();
    if (!record) throw new Error("Expected retained cancellation");
    const narrowed = await state
      .narrow(
        record.nonce,
        createMuxMessage("summary", "assistant", "summary", {
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "A", model: "openai:gpt-4o", agentId: "exec" },
          },
        })
      )
      .catch((error: unknown) => error);
    expect(narrowed).toHaveProperty("message", "first write failed");
    expect(state.needsPersistence).toBe(true);
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
    await state.retry();
    expect(
      (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
    ).toBe(record.nonce);
  } finally {
    await h.cleanup();
  }
});

test.each([
  ["cancel", false],
  ["cancel", true],
  ["narrow", false],
  ["narrow", true],
  ["retire", false],
  ["retire", true],
] as const)(
  "a held shared read cannot overwrite local %s (read error=%s)",
  async (action, reject) => {
    const h = await createTestHistoryService();
    const workspaceId = "cancel-refresh-race";
    const state = new CompactionCancellation(h.historyService, workspaceId);
    await state.cancel();
    const initial = await state.read();
    if (!initial) throw new Error("Expected initial cancellation");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = h.historyService.readCompactionCancellation.bind(h.historyService);
    spyOn(h.historyService, "readCompactionCancellation").mockImplementationOnce(
      async (...args) => {
        const result = await read(...args);
        entered.resolve();
        await release.promise;
        if (reject) throw new Error("obsolete shared read failed");
        return result;
      }
    );
    const reading = state.readForReplacement();
    try {
      await entered.promise;
      if (action === "cancel") await state.cancel();
      if (action === "retire") await state.retire(initial.nonce);
      if (action === "narrow")
        await state.narrow(
          initial.nonce,
          createMuxMessage("summary", "assistant", "summary", {
            historySequence: 1,
            muxMetadata: {
              type: "compaction-summary",
              pendingFollowUp: { text: "Continue", model: "openai:gpt-4o", agentId: "exec" },
            },
          })
        );
      const committed = await new HistoryService(h.config).readCompactionCancellation(workspaceId);
      release.resolve();
      expect(await reading).toEqual(committed);
      expect(await state.read()).toEqual(committed);
      expect(state.needsPersistence).toBe(false);
    } finally {
      release.resolve();
      await reading;
      await h.cleanup();
    }
  }
);

test("refreshing a foreign nonce does not reactivate settled mutation debt", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-refresh-debt";
  const a = new CompactionCancellation(h.historyService, workspaceId);
  const b = new CompactionCancellation(new HistoryService(h.config), workspaceId);
  try {
    await a.cancel();
    const old = await a.read();
    if (!old) throw new Error("Expected old cancellation");
    await b.cancel();
    const current = await b.read();
    expect(await a.read()).toEqual(current);
    await a.retry();
    await a.retire(old.nonce);
    await a.narrow(
      old.nonce,
      createMuxMessage("old", "assistant", "old", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "A", model: "openai:gpt-4o", agentId: "exec" },
        },
      })
    );
    expect(a.needsPersistence).toBe(false);
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
      current
    );
  } finally {
    await h.cleanup();
  }
});
