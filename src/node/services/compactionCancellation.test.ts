import { describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import {
  CompactionCancellation,
  MalformedCompactionCancellationError,
  matchesCompactionCancellation,
  type CompactionCancellationMutation,
  type CompactionCancellationMutationOutcome,
  type CompactionCancellationPublication,
  type CompactionCancellationRecord,
  type CompactionCancellationStorage,
  type CompactionCancellationSummary,
} from "./compactionCancellation";

const summary: CompactionCancellationSummary = {
  id: "summary-a",
  sequence: 3,
  pendingFollowUp: { text: "Continue", options: { model: "test" } },
};

function cancellation(nonce: string): CompactionCancellationRecord {
  return { version: 1, nonce, scope: { kind: "unresolved" } };
}

function harness() {
  const shared: { record: CompactionCancellationRecord | null } = { record: null };
  // Scripted adapter outcomes exercise the core's response to committed, failed and
  // superseded writes. This is not a simulation/proof of filesystem CAS or history repair.
  const storage = {
    read: mock(() => Promise.resolve(structuredClone(shared.record))),
    mutate: mock(
      (
        mutation: CompactionCancellationMutation,
        isCurrent: () => boolean,
        onCommitted: (record: CompactionCancellationRecord | null) => undefined
      ): Promise<CompactionCancellationMutationOutcome> => {
        if (!isCurrent()) return Promise.resolve("superseded");
        shared.record = mutation.kind === "retire" ? null : structuredClone(mutation.record);
        onCommitted(shared.record);
        return Promise.resolve("applied");
      }
    ),
    repair: mock(
      (
        _isCurrent: () => boolean,
        _onCommitted: () => void
      ): Promise<CompactionCancellationRecord | null> => {
        return Promise.reject(new Error("Unexpected repair"));
      }
    ),
  } satisfies CompactionCancellationStorage;
  return { shared, storage, state: new CompactionCancellation(storage) };
}

describe("inactive cancellation state core", () => {
  it("retains a failed publication's nonce and advanced frontier through an exact retry", async () => {
    const { state, storage, shared } = harness();
    const apply = storage.mutate.getMockImplementation()!;
    const frontier = { nonce: null, generation: "advanced-a" };
    let publication: CompactionCancellationPublication | undefined;
    storage.mutate.mockImplementationOnce((mutation) => {
      assert(mutation.kind === "publish");
      publication = mutation.publication;
      publication.predecessor = frontier;
      return Promise.reject(new Error("sidecar publication failed after advancement"));
    });
    await assert.rejects(state.cancel(), /sidecar publication failed/);
    const first = await state.read();
    expect(state.blocksRecovery).toBe(true);
    expect(storage.read).not.toHaveBeenCalled();
    await assert.rejects(state.narrow(first!.nonce, summary), /sidecar publication failed/);
    storage.mutate.mockImplementationOnce(async (mutation, current, onCommitted) => {
      assert(mutation.kind === "publish");
      expect(mutation.record.nonce).toBe(first!.nonce);
      expect(mutation.publication).toBe(publication!);
      expect(mutation.publication.predecessor).toBe(frontier);
      expect(mutation.publication.attempts).toBe(2);
      return apply(mutation, current, onCommitted);
    });
    expect(await state.retry()).toBe("applied");
    expect(shared.record?.nonce).toBe(first!.nonce);
    expect(state.needsPersistence).toBe(false);
  });

  it("refreshes a foreign successor after an adapter rejects the retry frontier", async () => {
    const { state, storage, shared } = harness();
    storage.mutate.mockRejectedValueOnce(new Error("failed Stop"));
    await assert.rejects(state.cancel(), /failed Stop/);
    shared.record = cancellation("foreign-b");
    storage.mutate.mockResolvedValueOnce("superseded");
    expect(await state.retry()).toBe("superseded");
    expect(state.needsPersistence).toBe(false);
    expect(await state.readForReplacement()).toEqual(shared.record);
    expect(storage.mutate).toHaveBeenCalledTimes(2);
  });

  it("queued local Stops cannot publish or acknowledge an obsolete nonce", async () => {
    const { state, storage } = harness();
    const first = state.cancel();
    const firstRecord = state.read();
    const second = state.cancel();
    const secondRecord = state.read();
    expect((await firstRecord)?.nonce).not.toBe((await secondRecord)?.nonce);
    expect(await first).toBe("superseded");
    expect(await second).toBe("applied");
    expect(await state.read()).toEqual(await secondRecord);
    expect(storage.mutate).toHaveBeenCalledTimes(1);
    expect(storage.mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "publish",
      record: await secondRecord,
    });
  });

  it("a Stop admitted during an old write invalidates that write's final guard", async () => {
    const { state, storage } = harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const apply = storage.mutate.getMockImplementation()!;
    storage.mutate.mockImplementationOnce(async (mutation, current, onCommitted) => {
      entered.resolve();
      await release.promise;
      expect(current()).toBe(false);
      return apply(mutation, current, onCommitted);
    });
    const first = state.cancel();
    await entered.promise;
    const second = state.cancel();
    const expected = await state.read();
    release.resolve();
    expect(await first).toBe("superseded");
    expect(await second).toBe("applied");
    expect(await state.read()).toEqual(expected);
  });

  it("failed retirement retries deletion while maintaining conservative exclusion", async () => {
    const { state, storage } = harness();
    await state.cancel();
    const record = (await state.read())!;
    storage.mutate.mockRejectedValueOnce(new Error("unlink failed"));
    await assert.rejects(state.retire(record.nonce), /unlink failed/);
    expect(state.blocksRecovery).toBe(true);
    expect(await state.read()).toEqual(record);
    await assert.rejects(state.flush(), /unlink failed/);
    expect(await state.retry()).toBe("applied");
    expect(storage.mutate.mock.calls.at(-1)?.[0]).toEqual({ kind: "retire", nonce: record.nonce });
    expect(await state.read()).toBeNull();
  });

  it("late acknowledgment of a committed Stop cannot settle its pending successor", async () => {
    const { state, storage } = harness();
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const successorEntered = Promise.withResolvers<void>();
    const releaseSuccessor = Promise.withResolvers<void>();
    const apply = storage.mutate.getMockImplementation()!;
    storage.mutate.mockImplementationOnce(async (mutation, current, onCommitted) => {
      const outcome = await apply(mutation, current, onCommitted);
      committed.resolve();
      await acknowledge.promise;
      return outcome;
    });
    storage.mutate.mockImplementationOnce(async (mutation, current, onCommitted) => {
      successorEntered.resolve();
      await releaseSuccessor.promise;
      return apply(mutation, current, onCommitted);
    });
    const first = state.cancel();
    await committed.promise;
    const second = state.cancel();
    const expected = await state.read();
    acknowledge.resolve();
    await successorEntered.promise;
    expect(await first).toBe("applied");
    expect(state.blocksRecovery).toBe(true);
    expect(await state.read()).toEqual(expected);
    releaseSuccessor.resolve();
    expect(await second).toBe("applied");
    expect(state.needsPersistence).toBe(false);
  });

  it("failed narrowing retains unresolved exclusion until the exact retry commits", async () => {
    const { state, storage } = harness();
    await state.cancel();
    const record = (await state.read())!;
    storage.mutate.mockRejectedValueOnce(new Error("narrowing failed"));
    await assert.rejects(state.narrow(record.nonce, summary), /narrowing failed/);
    expect(await state.read()).toEqual(record);
    expect(state.blocksRecovery).toBe(true);
    await state.retry();
    expect((await state.read())?.scope).toEqual({ kind: "summary", ...summary });
  });

  it.each([
    { witnessed: false, failed: false },
    { witnessed: true, failed: false },
    { witnessed: false, failed: true },
    { witnessed: true, failed: true },
  ])(
    "narrowing cannot replace a concurrently queued retirement (witnessed=$witnessed, failed=$failed)",
    async ({ witnessed, failed }) => {
      const { state, storage, shared } = harness();
      await state.cancel();
      const record = (await state.read())!;
      if (failed) storage.mutate.mockRejectedValueOnce(new Error("retirement failed"));

      // narrow yields at its publication join. Retirement must keep ownership when
      // that continuation resumes, on both sides of the adapter's deletion result.
      const narrowing = state.narrow(record.nonce, summary);
      const retirement = witnessed
        ? state.retireReplacement({ nonce: record.nonce })
        : state.retire(record.nonce);
      const results = await Promise.allSettled([narrowing, retirement]);
      expect(results[0]).toEqual({ status: "fulfilled", value: undefined });
      expect(results[1].status).toBe(failed ? "rejected" : "fulfilled");
      expect(storage.mutate.mock.calls.map(([mutation]) => mutation.kind)).toEqual([
        "publish",
        "retire",
      ]);
      expect(state.needsPersistence).toBe(failed);
      expect(state.blocksRecovery).toBe(failed && !witnessed);
      expect(shared.record).toEqual(failed ? record : null);

      if (failed) {
        expect(await state.retry()).toBe("applied");
        expect(storage.mutate.mock.calls.at(-1)?.[0]).toMatchObject({
          kind: "retire",
          nonce: record.nonce,
        });
      }
      expect(shared.record).toBeNull();
      expect(state.needsPersistence).toBe(false);
    }
  );

  it("requires a matching replacement witness to retire retained cancellation", async () => {
    const { state, storage } = harness();
    await state.cancel({ retainUntilReplacement: true });
    const record = (await state.read())!;
    await state.narrow(record.nonce, summary);
    await state.retire(record.nonce);
    await state.retireReplacement({ nonce: "unrelated" });
    expect(storage.mutate).toHaveBeenCalledTimes(1);
    expect(await state.read()).toEqual(record);
    expect(await state.retireReplacement({ nonce: record.nonce })).toBe("applied");
    expect(await state.read()).toBeNull();
  });

  it("a subsequent Stop carries a retained full-clear obligation", async () => {
    const { state } = harness();
    await state.cancel({ retainUntilReplacement: true });
    const first = (await state.read())!;
    await state.cancel();
    const second = (await state.read())!;
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.retainUntilReplacement).toBe(true);
    await state.retireReplacement({ nonce: first.nonce });
    expect(await state.read()).toEqual(second);
  });

  it("preserves retention inherited by the adapter without first reading the predecessor", async () => {
    const { state, storage, shared } = harness();
    shared.record = { ...cancellation("retained-predecessor"), retainUntilReplacement: true };
    const apply = storage.mutate.getMockImplementation()!;
    storage.mutate.mockImplementationOnce((mutation, current, onCommitted) => {
      assert(mutation.kind === "publish");
      expect(mutation.record.retainUntilReplacement).toBeUndefined();
      // Inheritance happens under the adapter lock, without mutating the submitted record.
      return apply(
        { ...mutation, record: { ...mutation.record, retainUntilReplacement: true } },
        current,
        onCommitted
      );
    });
    await state.cancel();
    const committed = structuredClone(shared.record);
    assert(committed);
    await state.narrow(committed.nonce, summary);
    await state.retire(committed.nonce);
    expect(shared.record).toEqual(committed);
    expect(storage.mutate).toHaveBeenCalledTimes(1);
    expect(storage.read).not.toHaveBeenCalled();
    await state.cancel();
    expect(shared.record?.retainUntilReplacement).toBe(true);
  });

  it.each(["record", "malformed", "I/O"])(
    "a read spanning committed witnessed retirement cannot restore its retention or error (%s)",
    async (outcome) => {
      const { state, storage, shared } = harness();
      await state.cancel({ retainUntilReplacement: true });
      const record = structuredClone(shared.record);
      assert(record);
      const snapshot = Promise.withResolvers<CompactionCancellationRecord | null>();
      storage.read.mockReturnValueOnce(snapshot.promise);
      const retirement = state.retireReplacement({ nonce: record.nonce });
      const reading = state.read();
      await retirement;
      expect(shared.record).toBeNull();
      if (outcome === "record") snapshot.resolve(record);
      else
        snapshot.reject(
          outcome === "malformed"
            ? new MalformedCompactionCancellationError("old bytes")
            : new Error("old I/O failure")
        );
      expect(await reading).toBeNull();
      expect(storage.repair).not.toHaveBeenCalled();
      await state.cancel();
      expect(shared.record?.retainUntilReplacement).toBeUndefined();
    }
  );

  it.each([
    { outcome: "failed", completion: "before" },
    { outcome: "failed", completion: "after" },
    { outcome: "superseded", completion: "before" },
    { outcome: "superseded", completion: "after" },
  ])(
    "uncommitted retirement preserves a foreign read ($outcome, completion=$completion)",
    async ({ outcome, completion }) => {
      const { state, storage, shared } = harness();
      await state.cancel({ retainUntilReplacement: true });
      const record = shared.record;
      assert(record);
      const snapshot = Promise.withResolvers<CompactionCancellationRecord | null>();
      storage.read.mockReturnValueOnce(snapshot.promise);
      const acknowledge = Promise.withResolvers<CompactionCancellationMutationOutcome>();
      storage.mutate.mockReturnValueOnce(acknowledge.promise);
      const retirement = state.retireReplacement({ nonce: record.nonce });
      const reading = state.read();
      const foreign = { ...cancellation("foreign-b"), retainUntilReplacement: true };
      if (completion === "before") {
        snapshot.resolve(foreign);
        expect(await reading).toEqual(foreign);
      }
      if (outcome === "failed") acknowledge.reject(new Error("unlink failed"));
      else acknowledge.resolve("superseded");
      if (outcome === "failed") await assert.rejects(retirement, /unlink failed/);
      else await retirement;
      if (completion === "after") {
        snapshot.resolve(foreign);
        expect(await reading).toEqual(foreign);
      }
      await state.cancel();
      expect(shared.record?.retainUntilReplacement).toBe(true);
    }
  );

  it.each([
    { completion: "before", failedCleanup: false },
    { completion: "after", failedCleanup: false },
    { completion: "before", failedCleanup: true },
    { completion: "after", failedCleanup: true },
  ])(
    "preserves a post-deletion foreign read (completion=$completion, failed cleanup=$failedCleanup)",
    async ({ completion, failedCleanup }) => {
      const { state, storage, shared } = harness();
      await state.cancel({ retainUntilReplacement: true });
      const record = shared.record;
      assert(record);
      const deleted = Promise.withResolvers<void>();
      const acknowledge = Promise.withResolvers<void>();
      storage.mutate.mockImplementationOnce(async (_mutation, _current, onCommitted) => {
        shared.record = null;
        onCommitted(null);
        deleted.resolve();
        await acknowledge.promise;
        if (failedCleanup) throw new Error("cleanup failed after deletion");
        return "applied";
      });
      const retirement = state.retireReplacement({ nonce: record.nonce });
      await deleted.promise;
      const foreign = { ...cancellation("foreign-b"), retainUntilReplacement: true };
      shared.record = foreign;
      const snapshot = Promise.withResolvers<CompactionCancellationRecord | null>();
      storage.read.mockReturnValueOnce(snapshot.promise);
      const reading = state.read();
      if (completion === "before") {
        snapshot.resolve(foreign);
        expect(await reading).toEqual(foreign);
      }
      acknowledge.resolve();
      if (failedCleanup) await assert.rejects(retirement, /cleanup failed/);
      else await retirement;
      expect(state.needsPersistence).toBe(failedCleanup);
      if (completion === "after") {
        snapshot.resolve(foreign);
        expect(await reading).toEqual(foreign);
      }
      // No refresh is needed for the next Stop to carry B's full-clear obligation.
      await state.cancel();
      expect(shared.record?.retainUntilReplacement).toBe(true);
    }
  );

  it("witnessed deletion debt allows fresh reads without adopting a foreign Stop for retry", async () => {
    const { state, storage, shared } = harness();
    await state.cancel({ retainUntilReplacement: true });
    const record = (await state.read())!;
    storage.mutate.mockRejectedValueOnce(new Error("witnessed unlink failed"));
    await assert.rejects(state.retireReplacement({ nonce: record.nonce }), /unlink failed/);
    expect(state.needsPersistence).toBe(true);
    expect(state.blocksRecovery).toBe(false);
    await state.flush();
    expect(await state.readForReplacement()).toBeNull();
    shared.record = cancellation("foreign-b");
    expect(await state.readForReplacement()).toEqual(shared.record);
    expect(state.needsPersistence).toBe(true);
    storage.mutate.mockResolvedValueOnce("superseded");
    await state.retry();
    expect(storage.mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "retire",
      nonce: record.nonce,
    });
    expect(await state.read()).toEqual(shared.record);
    expect(state.needsPersistence).toBe(false);
  });

  it.each([false, true])(
    "foreign narrowing is independent of witnessed deletion debt (narrow failure=%s)",
    async (failed) => {
      const { state, storage, shared } = harness();
      await state.cancel();
      const first = (await state.read())!;
      storage.mutate.mockRejectedValueOnce(new Error("old unlink failed"));
      await assert.rejects(state.retireReplacement({ nonce: first.nonce }), /old unlink failed/);
      shared.record = cancellation("foreign-b");
      expect(await state.readForReplacement()).toEqual(shared.record);

      if (failed) storage.mutate.mockRejectedValueOnce(new Error("new narrowing failed"));
      const narrowing = state.narrow("foreign-b", summary);
      if (failed) {
        await assert.rejects(narrowing, /new narrowing failed/);
        expect(state.blocksRecovery).toBe(true);
        expect(await state.read()).toEqual(cancellation("foreign-b"));
        expect(await state.retry()).toBe("applied");
      } else expect(await narrowing).toBe("applied");

      expect(shared.record).toEqual({
        ...cancellation("foreign-b"),
        scope: { kind: "summary", ...summary },
      });
      expect(storage.mutate.mock.calls.slice(2).map(([mutation]) => mutation.kind)).toEqual(
        failed ? ["narrow", "narrow"] : ["narrow"]
      );
      expect(state.needsPersistence).toBe(false);
    }
  );

  it("a stale witness cannot make a newer failed Stop non-blocking", async () => {
    const { state, storage } = harness();
    await state.cancel();
    const first = (await state.read())!;
    await state.retireReplacement({ nonce: first.nonce });
    storage.mutate.mockRejectedValueOnce(new Error("new Stop failed"));
    await assert.rejects(state.cancel(), /new Stop failed/);
    const second = await state.read();
    await state.retireReplacement({ nonce: first.nonce });
    expect(state.blocksRecovery).toBe(true);
    expect(await state.read()).toEqual(second);
    await assert.rejects(state.flush(), /new Stop failed/);
  });

  it("ordinary cleanup cannot downgrade witnessed deletion debt", async () => {
    const { state, storage } = harness();
    await state.cancel();
    const record = (await state.read())!;
    storage.mutate.mockRejectedValue(new Error("unlink still failed"));
    await assert.rejects(state.retireReplacement({ nonce: record.nonce }), /unlink/);
    await assert.rejects(state.retire(record.nonce), /unlink/);
    expect(state.needsPersistence).toBe(true);
    expect(state.blocksRecovery).toBe(false);
    await state.flush();
    expect(await state.readForReplacement()).toBeNull();
  });

  it("readers joining an active failed publication report it without retrying", async () => {
    const { state, storage } = harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storage.mutate.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("active publication failed");
    });
    const stopping = state.cancel();
    await entered.promise;
    const readers = [state.readForReplacement(), state.readForReplacement()];
    release.resolve();
    const results = await Promise.allSettled([stopping, ...readers]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(storage.mutate).toHaveBeenCalledTimes(1);
    expect(state.blocksRecovery).toBe(true);
  });

  it.each([false, true])(
    "replacement readers share a retry and its outcome (failure=%s)",
    async (failed) => {
      const { state, storage } = harness();
      storage.mutate.mockRejectedValueOnce(new Error("initial failure"));
      await assert.rejects(state.cancel(), /initial failure/);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const apply = storage.mutate.getMockImplementation()!;
      storage.mutate.mockImplementationOnce(async (mutation, current, onCommitted) => {
        entered.resolve();
        await release.promise;
        if (failed) throw new Error("retry failure");
        return apply(mutation, current, onCommitted);
      });
      const readers = [state.readForReplacement(), state.readForReplacement()];
      await entered.promise;
      const retryA = state.retry();
      expect(state.retry()).toBe(retryA);
      release.resolve();
      const results = await Promise.allSettled(readers);
      expect(results.map((result) => result.status)).toEqual(
        failed ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]
      );
      expect(storage.mutate).toHaveBeenCalledTimes(2);
      expect(state.needsPersistence).toBe(failed);
      if (!failed) expect(await readers[0]).toEqual(await readers[1]);
    }
  );

  it.each(["read", "replacement"] as const)(
    "a pending newer read cannot hide an earlier durable cancellation (%s)",
    async (reader) => {
      const { state, storage } = harness();
      const older = cancellation("older-a");
      const newer = cancellation("newer-b");
      const firstRead = Promise.withResolvers<CompactionCancellationRecord | null>();
      const secondRead = Promise.withResolvers<CompactionCancellationRecord | null>();
      storage.read.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
      const earlier = reader === "read" ? state.read() : state.readForReplacement();
      const later = state.read();
      firstRead.resolve(older);
      try {
        expect(await earlier).toEqual(older);
        expect(storage.mutate).not.toHaveBeenCalled();
      } finally {
        secondRead.resolve(newer);
        expect(await later).toEqual(newer);
      }
    }
  );

  it.each([false, true])(
    "a pending newer read does not suppress repair or its failure (repair failure=%s)",
    async (failed) => {
      const { state, storage } = harness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const secondRead = Promise.withResolvers<CompactionCancellationRecord | null>();
      storage.read
        .mockRejectedValueOnce(new MalformedCompactionCancellationError())
        .mockReturnValueOnce(secondRead.promise);
      storage.repair.mockImplementationOnce(async (current, committed) => {
        entered.resolve();
        await release.promise;
        if (failed) throw new Error("repair failed");
        if (current()) committed();
        return null;
      });
      const earlier = state.read();
      await entered.promise;
      const later = state.read();
      release.resolve();
      try {
        if (failed) await assert.rejects(earlier, /repair failed/);
        else expect(await earlier).toBeNull();
        expect(state.repairRevision).toBe(failed ? 0 : 1);
      } finally {
        secondRead.resolve(null);
        await later;
      }
    }
  );

  it.each(["old record", "absence", "malformed", "I/O"] as const)(
    "a late read cannot replace a newer accepted read (%s)",
    async (result) => {
      const { state, storage, shared } = harness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      storage.read.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (result === "malformed") throw new MalformedCompactionCancellationError();
        if (result === "I/O") throw new Error("obsolete read failure");
        return result === "absence" ? null : cancellation("older-a");
      });
      const earlier = state.read();
      await entered.promise;
      shared.record = cancellation("newer-b");
      expect(await state.read()).toEqual(shared.record);
      release.resolve();
      expect(await earlier).toEqual(shared.record);
      expect(storage.repair).not.toHaveBeenCalled();
      expect(storage.mutate).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "a newer read invalidates an in-flight repair (repair failure=%s)",
    async (failed) => {
      const { state, storage, shared } = harness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      storage.read.mockRejectedValueOnce(new MalformedCompactionCancellationError());
      storage.repair.mockImplementationOnce(async (current, committed) => {
        entered.resolve();
        await release.promise;
        if (failed) throw new Error("obsolete repair failure");
        if (current()) {
          shared.record = null;
          committed();
        }
        return null;
      });
      const earlier = state.read();
      await entered.promise;
      const newer = cancellation("newer-b");
      shared.record = newer;
      expect(await state.read()).toEqual(newer);
      release.resolve();
      expect(await earlier).toEqual(newer);
      expect(shared.record).toEqual(newer);
      expect(state.repairRevision).toBe(0);
    }
  );

  it("out-of-order reads preserve the original witnessed retirement retry", async () => {
    const { state, storage, shared } = harness();
    await state.cancel();
    const first = (await state.read())!;
    storage.mutate.mockRejectedValueOnce(new Error("unlink failed"));
    await assert.rejects(state.retireReplacement({ nonce: first.nonce }), /unlink failed/);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storage.read.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return first;
    });
    const earlier = state.read();
    await entered.promise;
    shared.record = cancellation("newer-b");
    expect(await state.readForReplacement()).toEqual(shared.record);
    release.resolve();
    expect(await earlier).toEqual(shared.record);
    expect(state.needsPersistence).toBe(true);
    expect(state.blocksRecovery).toBe(false);
    storage.mutate.mockResolvedValueOnce("superseded");
    await state.retry();
    expect(storage.mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "retire",
      nonce: first.nonce,
    });
    expect(shared.record).toEqual(cancellation("newer-b"));
    expect(state.needsPersistence).toBe(false);
  });

  it.each(["old record", "malformed", "I/O"] as const)(
    "ignores an obsolete read after Stop (%s)",
    async (result) => {
      const { state, storage } = harness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      storage.read.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (result === "malformed") throw new MalformedCompactionCancellationError();
        if (result === "I/O") throw new Error("read failed");
        return cancellation("obsolete");
      });
      const reading = state.read();
      await entered.promise;
      await state.cancel();
      const expected = await state.read();
      release.resolve();
      expect(await reading).toEqual(expected);
      expect(storage.repair).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "repairs malformed state with guarded commit evidence (superseded=%s)",
    async (superseded) => {
      const { state, storage, shared } = harness();
      storage.read.mockRejectedValueOnce(new MalformedCompactionCancellationError());
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      storage.repair.mockImplementationOnce(async (current, committed) => {
        entered.resolve();
        await release.promise;
        if (!current()) return null;
        committed();
        shared.record = null;
        return null;
      });
      const reading = state.read();
      await entered.promise;
      if (superseded) await state.cancel();
      release.resolve();
      expect(await reading).toEqual(shared.record);
      expect(state.repairRevision).toBe(superseded ? 0 : 1);
    }
  );

  it("accepts a newer valid record returned by repair without claiming a history rewrite", async () => {
    const { state, storage } = harness();
    storage.read.mockRejectedValueOnce(new MalformedCompactionCancellationError());
    storage.repair.mockResolvedValueOnce(cancellation("newer-valid"));
    expect(await state.read()).toEqual(cancellation("newer-valid"));
    expect(state.repairRevision).toBe(0);
  });

  it("ordinary read failure never repairs; explicit replacement publishes a retained fence", async () => {
    const { state, storage } = harness();
    storage.read.mockRejectedValueOnce(new Error("permission denied"));
    await assert.rejects(state.read(), /permission denied/);
    expect(storage.repair).not.toHaveBeenCalled();
    expect(storage.mutate).not.toHaveBeenCalled();
    storage.read.mockRejectedValueOnce(new Error("permission denied"));
    expect(await state.readForReplacement()).toMatchObject({ retainUntilReplacement: true });
    expect(storage.repair).not.toHaveBeenCalled();
    expect(storage.mutate).toHaveBeenCalledTimes(1);
  });

  it("fallback cannot replace a Stop admitted after the read's final error check", async () => {
    const { state, storage } = harness();
    storage.read.mockRejectedValueOnce(new Error("read unavailable"));
    const read = state.read.bind(state);
    let stopping: ReturnType<CompactionCancellation["cancel"]> | undefined;
    let newerRecord: ReturnType<CompactionCancellation["read"]> | undefined;
    // Enter the promise boundary after read() has checked ownership and rejected,
    // before readForReplacement() receives that rejection and considers fallback.
    const checkedRead = spyOn(state, "read").mockImplementationOnce(() =>
      read().catch((error: unknown) => {
        stopping = state.cancel();
        newerRecord = read();
        throw error;
      })
    );
    try {
      const replacement = await state.readForReplacement();
      expect(await stopping).toBe("applied");
      assert(newerRecord);
      expect(replacement).toEqual(await newerRecord);
      expect(storage.mutate).toHaveBeenCalledTimes(1);
    } finally {
      checkedRead.mockRestore();
    }
  });

  it("fallback cannot replace a same-mutation retry started after the checked read fails", async () => {
    const { state, storage, shared } = harness();
    await state.cancel();
    const first = (await state.read())!;
    storage.mutate.mockRejectedValueOnce(new Error("unlink failed"));
    await assert.rejects(state.retireReplacement({ nonce: first.nonce }), /unlink failed/);
    storage.read.mockRejectedValueOnce(new Error("read unavailable"));
    const read = state.read.bind(state);
    let retry: ReturnType<CompactionCancellation["retry"]> | undefined;
    const checkedRead = spyOn(state, "read").mockImplementationOnce(() =>
      read().catch((error: unknown) => {
        retry = state.retry();
        throw error;
      })
    );
    try {
      expect(await state.readForReplacement()).toBeNull();
      expect(await retry).toBe("applied");
      expect(shared.record).toBeNull();
      expect(storage.mutate.mock.calls.map(([mutation]) => mutation.kind)).toEqual([
        "publish",
        "retire",
        "retire",
      ]);
    } finally {
      checkedRead.mockRestore();
    }
  });

  it("fallback cannot replace a newer read accepted after the checked read fails", async () => {
    const { state, storage, shared } = harness();
    storage.read.mockRejectedValueOnce(new Error("read unavailable"));
    const newer = cancellation("newer-b");
    const read = state.read.bind(state);
    const checkedRead = spyOn(state, "read").mockImplementationOnce(() =>
      read().catch(async (error: unknown) => {
        shared.record = newer;
        expect(await read()).toEqual(newer);
        throw error;
      })
    );
    try {
      expect(await state.readForReplacement()).toEqual(newer);
      expect(storage.mutate).not.toHaveBeenCalled();
    } finally {
      checkedRead.mockRestore();
    }
  });

  it("failed explicit fence publication stays blocking and is reported", async () => {
    const { state, storage } = harness();
    storage.read.mockRejectedValueOnce(new Error("read failed"));
    storage.mutate.mockRejectedValueOnce(new Error("write failed"));
    await assert.rejects(state.readForReplacement(), /write failed/);
    expect(state.blocksRecovery).toBe(true);
    expect(await state.read()).toMatchObject({ retainUntilReplacement: true });
  });

  it("narrowing snapshots inputs before awaits and read results cannot mutate state", async () => {
    const { state } = harness();
    await state.cancel();
    const record = (await state.read())!;
    const input = structuredClone(summary);
    const narrowing = state.narrow(record.nonce, input);
    input.pendingFollowUp.text = "changed";
    await narrowing;
    const narrowed = (await state.read())!;
    expect(matchesCompactionCancellation(narrowed, summary)).toBe(true);
    assert(narrowed.scope.kind === "summary");
    narrowed.scope.pendingFollowUp.text = "also changed";
    expect(matchesCompactionCancellation((await state.read())!, summary)).toBe(true);
  });

  it.each(["id", "sequence", "request"] as const)(
    "summary cancellation matches exact identity (%s changes)",
    (field) => {
      const record: CompactionCancellationRecord = {
        ...cancellation("narrowed"),
        scope: { kind: "summary", ...summary },
      };
      const changed = structuredClone(summary);
      if (field === "id") changed.id = "other";
      if (field === "sequence") changed.sequence = 4;
      if (field === "request") changed.pendingFollowUp.options = { model: "other" };
      expect(matchesCompactionCancellation(record, changed)).toBe(false);
      expect(matchesCompactionCancellation(cancellation("unresolved"), changed)).toBe(true);
    }
  );

  it("flush follows the latest Stop through an obsolete publication failure", async () => {
    const { state, storage } = harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storage.mutate.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("obsolete failure");
    });
    const first = state.cancel();
    await entered.promise;
    const flushing = state.flush();
    const second = state.cancel();
    release.resolve();
    await assert.rejects(first, /obsolete failure/);
    await flushing;
    expect(await second).toBe("applied");
    expect(state.needsPersistence).toBe(false);
  });
});
