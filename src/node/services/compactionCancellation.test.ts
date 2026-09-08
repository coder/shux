import { appendFile, readFile, writeFile } from "node:fs/promises";
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
    expect(await freshHistory.readCompactionCancellation(workspaceId)).toMatchObject(newer!);
    const rows = await freshHistory.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
  } finally {
    release.resolve();
    await pending;
    await state.flush();
    await h.cleanup();
  }
});

test.each(
  [
    "unchanged",
    "summary text",
    "pending payload",
    "summary ID",
    "summary sequence",
    "foreign synthetic tail",
    "preserved tail",
    "own snapshot",
    "unresolved Stop",
    "exact Stop",
    "other exact Stop",
    "malformed cancellation",
    "malformed reset",
  ].flatMap((change) => [false, true].map((batch) => [change, batch] as const))
)("locked follow-up append revalidates %s (batch=%s)", async (change, batch) => {
  const h = await createTestHistoryService();
  const workspaceId = "locked-follow-up";
  const source = createMuxMessage("summary", "assistant", "Earlier work", {
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: { text: "Continue", model: "openai:gpt-4o", agentId: "exec" },
    },
  });
  await h.historyService.appendToHistory(workspaceId, source);
  const captured = structuredClone(source);
  const foreign = new HistoryService(h.config);
  const allowedTailMessageIds: string[] = [];
  if (change === "summary text") {
    await foreign.updateHistory(workspaceId, {
      ...source,
      parts: [{ type: "text", text: "Refined work" }],
    });
  } else if (change === "pending payload") {
    await foreign.updateHistory(workspaceId, {
      ...source,
      metadata: {
        ...source.metadata,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Different request", model: "openai:gpt-4o", agentId: "exec" },
        },
      },
    });
  } else if (change === "summary ID") {
    await foreign.updateHistory(workspaceId, { ...source, id: "replacement" });
  } else if (change === "summary sequence") {
    await foreign.clearHistory(workspaceId);
    await foreign.appendToHistory(workspaceId, createMuxMessage("earlier", "user", "Earlier"));
    await foreign.appendToHistory(workspaceId, {
      ...source,
      metadata: { ...source.metadata, historySequence: undefined },
    });
  } else if (
    change === "foreign synthetic tail" ||
    change === "preserved tail" ||
    change === "own snapshot"
  ) {
    const tail = createMuxMessage("tail", "assistant", "Tail", {
      synthetic: true,
      ...(change === "preserved tail" ? { rlmPreservedTailCopy: true } : {}),
    });
    await foreign.appendToHistory(workspaceId, tail);
    if (change === "own snapshot") allowedTailMessageIds.push(tail.id);
  } else if (
    change === "unresolved Stop" ||
    change === "exact Stop" ||
    change === "other exact Stop"
  ) {
    const cancellation = new CompactionCancellation(foreign, workspaceId);
    await cancellation.cancel();
    const record = await cancellation.read();
    if (!record) throw new Error("Expected cancellation");
    if (change !== "unresolved Stop")
      await cancellation.narrow(
        record.nonce,
        change === "exact Stop" ? source : { ...source, id: "other-summary" }
      );
  } else if (change === "malformed reset") {
    await appendFile(
      `${h.config.sessionsDir}/${workspaceId}/chat.jsonl`,
      '{"metadata":{"contextBoundaryKind":"reset"},broken\n'
    );
  } else if (change === "malformed cancellation") {
    await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
  }
  const skipped = mock(() => undefined);
  const candidate = createMuxMessage("follow-up", "user", "Continue", { synthetic: true });
  const allowed = [
    "unchanged",
    "summary text",
    "preserved tail",
    "own snapshot",
    "other exact Stop",
  ].includes(change);
  try {
    const condition = {
      summary: captured,
      allowedTailMessageIds,
      isCurrent: () => true,
      onSkipped: skipped,
    };
    const prelude = createMuxMessage("prelude", "assistant", "Expanded context", {
      synthetic: true,
    });
    const result = batch
      ? await h.historyService.appendManyToHistory(workspaceId, [prelude, candidate], condition)
      : await h.historyService.appendToHistory(workspaceId, candidate, condition);
    if (!allowed) {
      expect(candidate.metadata?.historySequence).toBeUndefined();
      expect(prelude.metadata?.historySequence).toBeUndefined();
    }
    expect(result.success).toBe(change !== "malformed cancellation");
    expect(skipped).toHaveBeenCalledTimes(allowed || change === "malformed cancellation" ? 0 : 1);
    const rows = await foreign.getHistoryFromLatestBoundary(workspaceId);
    expect(rows.success && rows.data.some((row) => row.id === candidate.id)).toBe(allowed);
    if (change === "summary text")
      expect(rows.success && rows.data[0].parts).toEqual([{ type: "text", text: "Refined work" }]);
  } finally {
    await h.cleanup();
  }
});

test("witnessed deletion debt refreshes a foreign Stop without losing its own retry identity", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "witnessed-debt";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  await state.cancel();
  const original = await state.read();
  if (!original) throw new Error("Expected Stop");
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("replacement", "user", "Replacement", {
      compactionCancellationNonce: original.nonce,
    })
  );
  const failure = spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
    new Error("unlink unavailable")
  );
  await state.retireReplacement(original.nonce).catch(() => undefined);
  try {
    expect(await state.read()).toBeNull();
    await state.flush();
    expect(state.needsPersistence).toBe(true);
    expect(state.blocksRecovery).toBe(false);
    const foreign = new CompactionCancellation(new HistoryService(h.config), workspaceId);
    await foreign.cancel();
    const current = await foreign.read();
    expect(await state.read()).toEqual(current);
    expect(state.needsPersistence).toBe(true);
    failure.mockRestore();
    await state.retry();
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
      current
    );
  } finally {
    await h.cleanup();
  }
});

test("an archived replacement witness authorizes B without masking a newer Stop", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "archived-witness";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  await state.cancel();
  const original = await state.read();
  if (!original) throw new Error("Expected Stop");
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("replacement", "user", "Replacement", {
      compactionCancellationNonce: original.nonce,
    })
  );
  const source = createMuxMessage("summary-b", "assistant", "B", {
    compacted: "user",
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: { text: "Continue B", model: "openai:gpt-4o", agentId: "exec" },
    },
  });
  await h.historyService.appendToHistory(workspaceId, source);
  const foreign = new HistoryService(h.config);
  const skipped = mock(() => undefined);
  const condition = {
    summary: source,
    allowedTailMessageIds: [] as string[],
    isCurrent: () => true,
    onSkipped: skipped,
  };
  try {
    expect(await foreign.hasCompactionReplacementWitness(workspaceId, original.nonce)).toBe(true);
    expect(
      (
        await foreign.appendToHistory(
          workspaceId,
          createMuxMessage("b-user", "user", "Continue B"),
          condition
        )
      ).success
    ).toBe(true);
    expect(skipped).not.toHaveBeenCalled();
    await foreign.deleteMessage(workspaceId, "b-user");
    await new CompactionCancellation(foreign, workspaceId).cancel();
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("stopped", "user", "Continue B"),
          condition
        )
      ).success
    ).toBe(true);
    expect(skipped).toHaveBeenCalledTimes(1);
    const rows = await foreign.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].id).toBe(source.id);
  } finally {
    await h.cleanup();
  }
});

test("a stale replacement receipt cannot make newer witnessed deletion debt blocking", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "stale-receipt";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  await state.cancel();
  const a = await state.read();
  await state.cancel();
  const b = await state.read();
  if (!a || !b) throw new Error("Expected distinct Stops");
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("replacement-b", "user", "B", { compactionCancellationNonce: b.nonce })
  );
  spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
    new Error("unlink unavailable")
  );
  await state.retireReplacement(b.nonce).catch(() => undefined);
  try {
    await state.retireReplacement(a.nonce);
    expect(await state.read()).toBeNull();
    expect(state.blocksRecovery).toBe(false);
    expect(state.needsPersistence).toBe(true);
    await state.flush();
  } finally {
    await h.cleanup();
  }
});

test("cancellation repair preserves raw reset privacy and invalidates an earlier scan cursor", async () => {
  const h = await createTestHistoryService();
  const workspaceId = "repair-raw-floor";
  const source = createMuxMessage("summary", "assistant", "Private summary", {
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: { text: "Continue", model: "openai:gpt-4o", agentId: "exec" },
    },
  });
  const chatPath = `${h.config.sessionsDir}/${workspaceId}/chat.jsonl`;
  const reset = '{"metadata":{"contextBoundaryKind":"reset"},broken\n';
  try {
    await h.historyService.appendToHistory(workspaceId, source);
    await appendFile(chatPath, reset);
    await h.historyService.appendManyToHistory(workspaceId, [
      createMuxMessage("public-one", "user", "Public context"),
      createMuxMessage("public-two", "assistant", "Public answer"),
    ]);
    const scan = await h.historyService.scanHistoryBounded(workspaceId, { visit: () => false });
    expect(scan.cursor).toBeDefined();
    await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
    const cancellation = new CompactionCancellation(h.historyService, workspaceId);
    expect(await cancellation.read()).toBeNull();
    expect((await readFile(chatPath, "utf8")).includes(reset)).toBe(true);
    const provider = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(provider.success && provider.data.map((row) => row.id)).toEqual([
      "public-one",
      "public-two",
    ]);
    const history = await h.historyService.getLastMessages(workspaceId, 10);
    expect(history.success && history.data[0].metadata?.muxMetadata).not.toHaveProperty(
      "pendingFollowUp"
    );
    const resumed = await h.historyService
      .scanHistoryBounded(workspaceId, {
        cursor: scan.cursor,
        visit: () => true,
      })
      .catch((error: unknown) => error);
    expect(resumed).toHaveProperty("message", "stale_cursor");
  } finally {
    await h.cleanup();
  }
});

test.each([false, true])(
  "concurrent replacement readers share the latest Stop publication (initial failure=%s)",
  async (failed) => {
    const h = await createTestHistoryService();
    const workspaceId = "shared-replacement-read";
    const state = new CompactionCancellation(h.historyService, workspaceId);
    const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writes = spyOn(h.historyService, "writeCompactionCancellation");
    if (failed) writes.mockRejectedValueOnce(new Error("initial publication failed"));
    writes.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return write(...args);
    });
    const stopped = state.cancel().catch(() => undefined);
    if (failed) await stopped;
    const a = state.readForReplacement();
    const b = state.readForReplacement();
    try {
      await entered.promise;
      release.resolve();
      const [first, second] = await Promise.all([a, b]);
      expect(first).toEqual(second);
      expect(first).not.toBeNull();
      expect(writes).toHaveBeenCalledTimes(failed ? 2 : 1);
      expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
        first
      );
    } finally {
      release.resolve();
      await Promise.all([stopped, a.catch(() => undefined), b.catch(() => undefined)]);
      await h.cleanup();
    }
  }
);

test.each([
  "before lock",
  "witnessed before lock",
  "before advance",
  "after advance",
  "foreign Stop",
  "foreign repair",
  "witnessed acknowledgement failure",
])("failed Stop retry preserves monotonic publication ownership (%s)", async (failure) => {
  const h = await createTestHistoryService();
  const workspaceId = "failed-publication-generation";
  const state = new CompactionCancellation(h.historyService, workspaceId);
  const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
  const initial = await journal.captureGeneration();
  const invalidate = journal.invalidateUnderHistoryLock.bind(journal);
  if (failure === "before lock" || failure === "witnessed before lock")
    spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
      new Error("publication unavailable before lock")
    );
  else if (failure === "before advance")
    spyOn(journal, "invalidateUnderHistoryLock").mockRejectedValueOnce(
      new Error("generation unavailable")
    );
  else if (failure !== "witnessed acknowledgement failure")
    spyOn(journal, "invalidateUnderHistoryLock").mockImplementationOnce(async (...args) => {
      await invalidate(...args);
      throw new Error("sidecar unavailable after advancement");
    });
  else {
    const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
    spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(
      async (...args) => {
        await write(...args);
        throw new Error("acknowledgement unavailable");
      }
    );
  }
  try {
    expect(
      await state.cancel().then(
        () => false,
        () => true
      )
    ).toBe(true);
    const attempted = await state.read();
    const advanced = await journal.captureGeneration();
    expect(advanced === initial).toBe(
      failure === "before advance" ||
        failure === "before lock" ||
        failure === "witnessed before lock"
    );
    const foreign = new HistoryService(h.config);
    let successor = await foreign.readCompactionCancellation(workspaceId);
    if (
      failure === "foreign Stop" ||
      failure === "before lock" ||
      failure === "witnessed before lock"
    ) {
      await new CompactionCancellation(foreign, workspaceId).cancel();
      successor = await foreign.readCompactionCancellation(workspaceId);
      if (failure === "witnessed before lock") {
        const replacement = new CompactionCancellation(foreign, workspaceId);
        const stopped = await replacement.read();
        if (!stopped) throw new Error("Expected foreign Stop");
        await foreign.appendToHistory(
          workspaceId,
          createMuxMessage("b-accepted", "user", "B accepted replacement", {
            compactionCancellationNonce: stopped.nonce,
          })
        );
        await replacement.retireReplacement(stopped.nonce);
        successor = null;
      }
    } else if (failure === "foreign repair") {
      await writeFile(
        `${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`,
        "{"
      );
      await foreign.repairCompactionCancellation(
        workspaceId,
        () => true,
        () => undefined
      );
      successor = null;
    } else if (failure === "witnessed acknowledgement failure") {
      await foreign.appendToHistory(
        workspaceId,
        createMuxMessage("accepted", "user", "New accepted work", {
          compactionCancellationNonce: attempted?.nonce,
        })
      );
    }
    const epochBeforeRetry = await journal.captureGeneration();
    const preserveForeign =
      failure.startsWith("foreign") ||
      failure === "witnessed acknowledgement failure" ||
      failure === "before lock" ||
      failure === "witnessed before lock";
    if (preserveForeign) await writeFile(journal.path, "newer journal must survive stale cleanup");
    const result = await state.readForReplacement();
    if (preserveForeign) {
      expect(result).toEqual(successor);
      expect(await journal.captureGeneration()).toBe(epochBeforeRetry);
      expect(await readFile(journal.path, "utf8")).toBe("newer journal must survive stale cleanup");
    } else {
      expect(result?.nonce).toBe(attempted?.nonce);
      expect(await journal.captureGeneration()).not.toBe(advanced);
    }
    expect(state.needsPersistence).toBe(false);
  } finally {
    await h.cleanup();
  }
});
