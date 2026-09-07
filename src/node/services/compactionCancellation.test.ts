import { writeFile } from "node:fs/promises";
import { COMPACTION_CANCELLATION_FILE } from "@/common/constants/compactionCancellation";
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

test("corrupt-read repair preserves a newer valid foreign cancellation", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-corrupt-race";
  await h.historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "work"));
  await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
  const state = new CompactionCancellation(h.historyService, workspaceId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const repair = h.historyService.repairCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "repairCompactionCancellation").mockImplementationOnce(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return repair(...args);
    }
  );
  const pending = state.read();
  try {
    await entered.promise;
    const foreign = new CompactionCancellation(new HistoryService(h.config), workspaceId);
    await foreign.cancel();
    const newer = await foreign.read();
    release.resolve();
    expect(await pending).toEqual(newer);
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
      newer
    );
  } finally {
    release.resolve();
    await pending;
    await h.cleanup();
  }
});

test.each(["publication", "retirement"] as const)(
  "corrupt shared bytes cannot discard local cancellation %s debt",
  async (mutation) => {
    const h = await createTestHistoryService();
    const workspaceId = "cancel-corrupt-debt";
    await h.historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "work"));
    const state = new CompactionCancellation(h.historyService, workspaceId);
    await state.cancel();
    const original = await state.read();
    if (!original) throw new Error("Expected cancellation");
    spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
      new Error("write unavailable")
    );
    await (mutation === "publication" ? state.cancel() : state.retire(original.nonce)).catch(
      () => undefined
    );
    const owned = await state.read();
    await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
    const repair = spyOn(h.historyService, "repairCompactionCancellation");
    try {
      expect(await state.read()).toEqual(owned);
      expect(state.needsPersistence).toBe(true);
      expect(repair).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  }
);

test("a local Stop during corrupt repair prevents its obsolete history commit", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "cancel-corrupt-local";
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("summary", "assistant", "work", {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Continue", model: "openai:gpt-4o", agentId: "exec" },
      },
    })
  );
  await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
  const state = new CompactionCancellation(h.historyService, workspaceId);
  const writes = h.historyService as unknown as {
    writeGuardedHistory(path: string, contents: string, guard: () => boolean): Promise<boolean>;
  };
  const write = writes.writeGuardedHistory.bind(writes);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(writes, "writeGuardedHistory").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  const pending = state.read();
  try {
    await entered.promise;
    const stop = state.cancel();
    const newer = await state.read();
    release.resolve();
    expect(await pending).toEqual(newer);
    await stop;
    const freshHistory = new HistoryService(h.config);
    expect(await freshHistory.readCompactionCancellation(workspaceId)).toEqual(newer);
    const rows = await freshHistory.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
  } finally {
    release.resolve();
    await pending;
    await state.flush();
    await h.cleanup();
  }
});
