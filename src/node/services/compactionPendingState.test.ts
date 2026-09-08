import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CHAT_ARCHIVE_FILE_NAME, CHAT_FILE_NAME } from "@/common/constants/paths";
import { createMuxMessage } from "@/common/types/message";
import { isDurableContextBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import {
  CompactionPendingState,
  type CompactionPendingAttachments,
  type CompactionPendingBoundary,
  type CompactionPendingHistory,
  type CompactionPendingReceipt,
} from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { readProviderHistoryFromLatestBoundary } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath, isWorkspaceRemovalTombstoned } from "./workspaceRemoval";

describe("unactivated compaction pending-file protocol", () => {
  const workspaceId = "pending-protocol";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let filePath: string;
  let store: CompactionPendingState;
  let boundaryOverride: CompactionPendingBoundary | undefined;

  // This test adapter uses the existing locks and real history/journal readers. Production
  // activation must expose the equivalent transaction on HistoryService; it must not nest locks.
  // Unsafe-floor cases supply scanner provenance explicitly; the real adapter tests the scan.
  function historyAdapter(history = h.historyService): CompactionPendingHistory {
    return {
      withLock: (operation) =>
        workspaceFileLocks.withLock(workspaceId, async () => {
          await using _lock = await acquireProcessFileLock({
            lockPath: historyWriteLockPath(h.config.rootDir, workspaceId),
            timeoutMs: 5000,
            label: "pending protocol test",
          });
          if (await isWorkspaceRemovalTombstoned(h.config.rootDir, workspaceId))
            throw new Error("Removed workspace");
          const journal = history.getContinuousCompactionJournal(workspaceId);
          const rows = await readProviderHistoryFromLatestBoundary(
            {
              chat: path.join(h.config.sessionsDir, workspaceId, CHAT_FILE_NAME),
              archive: path.join(h.config.sessionsDir, workspaceId, CHAT_ARCHIVE_FILE_NAME),
            },
            0
          );
          const boundaryId = rows.findLast(isDurableContextBoundaryMarker)?.id;
          return await operation({
            generation: await journal.captureGenerationUnderHistoryLock(),
            boundary:
              boundaryOverride ??
              (boundaryId ? { kind: "identified", messageId: boundaryId } : { kind: "none" }),
            isPublicationCurrent: (publication) =>
              journal.isPublicationCurrentUnderHistoryLock(publication),
          });
        }),
    };
  }

  function attachments(name: string): CompactionPendingAttachments {
    return {
      diffs: [{ path: `/${name}.ts`, diff: `+${name}`, truncated: false }],
      loadedSkills: [],
      readFiles: [`/${name}.ts`],
    };
  }

  async function prepare(name: string, target = store): Promise<CompactionPendingReceipt> {
    const receipt = await target.prepare({
      attachments: attachments(name),
      boundaryMessageId: name,
      publication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
      isCurrent: () => true,
    });
    assert(receipt);
    return receipt;
  }

  async function boundary(id: string) {
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage(id, "assistant", id, {
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: 1,
          })
        )
      ).success
    ).toBe(true);
  }

  async function bytes() {
    return fs.readFile(filePath, "utf8");
  }
  function restart() {
    return new CompactionPendingState(filePath, historyAdapter(new HistoryService(h.config)));
  }

  beforeEach(async () => {
    boundaryOverride = undefined;
    h = await createTestHistoryService();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("seed", "user", "Context")
    );
    filePath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
    store = new CompactionPendingState(filePath, historyAdapter());
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it("loads old V1 files, sanitizes individual attachments, and consumes across reload", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        diffs: [null, { path: " /valid.ts ", diff: "+valid", truncated: false }, { path: 3 }],
        loadedSkills: [null, { name: " guide ", scope: "project", body: "Keep context" }],
      })
    );
    const loaded = await store.load(() => true);
    assert(loaded);
    expect(loaded.attachments.diffs).toEqual([
      { path: "/valid.ts", diff: "+valid", truncated: false },
    ]);
    expect(loaded.attachments.loadedSkills.map((skill) => skill.name)).toEqual(["guide"]);
    expect(loaded.attachments.readFiles).toEqual([]);
    expect(await store.consume(loaded)).toBe(true);
    expect(await restart().load(() => true)).toBeUndefined();
  });

  it.each(["{", JSON.stringify({ version: 1, createdAt: 1, publicationGeneration: false })])(
    "heals unusable persisted state (%s)",
    async (raw) => {
      await fs.writeFile(filePath, raw);
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
      await prepare("fresh");
      await boundary("fresh");
      expect((await store.load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
    }
  );

  it.each(
    ["null", "[]", JSON.stringify("invalid pending state")].flatMap((raw) =>
      [false, true].map((loadFirst) => ({ raw, loadFirst }))
    )
  )("recovers non-object JSON roots before fresh publication (%j)", async ({ raw, loadFirst }) => {
    await fs.writeFile(filePath, raw);
    if (loadFirst) {
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    }
    const receipt = await prepare("fresh");
    await boundary("fresh");
    expect((await restart().load(() => true))?.attachments).toEqual(receipt.attachments);
  });

  it.each([
    { version: 2, publicationGeneration: "future-generation", ...attachments("future") },
    { schema: "future", data: { attachments: ["keep"] } },
  ])("preserves unknown schema bytes across loads and restart (%j)", async (future) => {
    const raw = JSON.stringify(future, null, 2);
    await fs.writeFile(filePath, raw);
    expect(await store.load(() => true)).toBeUndefined();
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await bytes()).toBe(raw);
    const publication = {
      generation: await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration(),
    };
    expect(
      await store.prepare({
        attachments: attachments("fresh"),
        boundaryMessageId: "fresh",
        publication,
        isCurrent: () => true,
      })
    ).toBeUndefined();
    expect(await bytes()).toBe(raw);
    spyOn(h.historyService, "appendToHistory").mockRejectedValueOnce(
      new Error("boundary write failed")
    );
    expect(await boundary("fresh").catch((error: unknown) => error)).toMatchObject({
      message: "boundary write failed",
    });
    expect(await bytes()).toBe(raw);
    await boundary("fresh");
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await bytes()).toBe(raw);
  });

  it("repairs an empty directory sidecar across repeated recovery loads", async () => {
    await fs.mkdir(filePath);
    expect(await store.load(() => true)).toBeUndefined();
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await fs.stat(filePath).catch((error: unknown) => error)).toMatchObject({
      code: "ENOENT",
    });
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("continued", "user", "Continue")
        )
      ).success
    ).toBe(true);
    await prepare("fresh");
    await boundary("fresh");
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
  });

  it.each(["prepare", "discard"] as const)(
    "repairs an empty directory sidecar without an earlier load (%s)",
    async (operation) => {
      await fs.mkdir(filePath);
      if (operation === "discard") {
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
        await store.discardAfterBoundary();
        await store.discardAfterBoundary();
        expect(await fs.stat(filePath).catch((error: unknown) => error)).toMatchObject({
          code: "ENOENT",
        });
      }
      const receipt = await prepare("fresh");
      await boundary("fresh");
      expect((await restart().load(() => true))?.attachments).toEqual(receipt.attachments);
      expect(await store.consume(receipt)).toBe(true);
      await prepare("next");
      await boundary("next");
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/next.ts"]);
    }
  );

  it("preserves unrelated contents in a nonempty directory sidecar", async () => {
    await fs.mkdir(filePath);
    const unrelated = path.join(filePath, "keep.txt");
    await fs.writeFile(unrelated, "unrelated content");
    expect(await store.load(() => true)).toBeUndefined();
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await prepare("refused").catch((error: unknown) => error)).toBeInstanceOf(Error);
    await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    expect(await store.discardAfterBoundary().catch((error: unknown) => error)).toBeInstanceOf(
      Error
    );
    expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated content");
    expect((await fs.stat(filePath)).isDirectory()).toBe(true);
  });

  it.each(["corrupt JSON", "invalid V1", "stale generation"] as const)(
    "load cleanup failure suppresses unusable attachments and remains retryable (%s)",
    async (scenario) => {
      if (scenario === "stale generation") {
        await prepare("old");
        await boundary("old");
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      } else {
        await fs.writeFile(
          filePath,
          scenario === "corrupt JSON" ? "{" : JSON.stringify({ version: 1 })
        );
      }
      const original = await bytes();
      const unlink = fs.unlink;
      let failed = false;
      spyOn(fs, "unlink").mockImplementation((file) => {
        if (file === filePath && !failed) {
          failed = true;
          return Promise.reject(Object.assign(new Error("read-only sidecar"), { code: "EACCES" }));
        }
        return unlink(file);
      });
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes()).toBe(original);
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
      await prepare("fresh");
      await boundary("fresh");
      expect((await store.load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
    }
  );

  it.each(["consume", "rollback"] as const)(
    "exact cleanup failures remain visible and retryable (%s)",
    async (operation) => {
      const receipt = await prepare("pending");
      const original = await bytes();
      const unlink = fs.unlink;
      let failed = false;
      spyOn(fs, "unlink").mockImplementation((file) => {
        if (file === filePath && !failed) {
          failed = true;
          return Promise.reject(new Error("disk unavailable"));
        }
        return unlink(file);
      });
      const cleanup = () =>
        operation === "consume" ? store.consume(receipt) : store.rollback(receipt, () => true);
      expect(await cleanup().catch((error: unknown) => error)).toMatchObject({
        message: "disk unavailable",
      });
      expect(await bytes()).toBe(original);
      expect(await cleanup()).toBe(true);
      expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    }
  );

  it("does not use provisional attachments before their exact boundary commits", async () => {
    const receipt = await prepare("pending");
    const raw = await bytes();
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await bytes()).toBe(raw);
    await boundary("pending");
    expect((await restart().load(() => true))?.attachments).toEqual(receipt.attachments);
    expect(await store.rollback(receipt, () => true)).toBe(false);
  });

  it.each([false, true])(
    "equal payloads and timestamps have distinct ownership (foreign=%s)",
    async (foreign) => {
      spyOn(Date, "now").mockReturnValue(1000);
      const first = await prepare("same");
      const secondStore = foreign ? restart() : store;
      const second = await prepare("same", secondStore);
      const latest = await bytes();
      expect(await store.consume(first)).toBe(false);
      expect(await store.rollback(first, () => true)).toBe(false);
      expect(await bytes()).toBe(latest);
      expect(await secondStore.consume(second)).toBe(true);
      expect(await store.consume(first)).toBe(false);
    }
  );

  it.each([false, true])(
    "consuming A removes only B's crash fallback (foreign=%s)",
    async (foreign) => {
      const a = await prepare("a");
      await boundary("a");
      const bStore = foreign ? restart() : store;
      const b = await prepare("b", bStore);
      expect((await restart().load(() => true))?.attachments).toEqual(a.attachments);
      expect(await store.consume(a)).toBe(true);
      // B remains intact and its receipt still owns rollback, but A cannot be resurrected.
      expect(JSON.parse(await bytes())).toMatchObject({
        boundaryMessageId: "b",
        readFiles: ["/b.ts"],
      });
      expect(await bStore.rollback(b, () => true)).toBe(true);
      expect(await restart().load(() => true)).toBeUndefined();
    }
  );

  it("consuming a loaded fallback preserves a provisional successor that later commits", async () => {
    await prepare("a");
    await boundary("a");
    await prepare("b");
    const other = restart();
    const fallback = await other.load(() => true);
    assert(fallback);
    expect(await other.consume(fallback)).toBe(true);
    await boundary("b");
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/b.ts"]);
  });

  it.each(["current", "generation changed", "local owner consumed"] as const)(
    "qualifies rollback of legacy predecessor (%s)",
    async (scenario) => {
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, createdAt: 1, ...attachments("legacy") })
      );
      const b = await prepare("b");
      if (scenario === "generation changed")
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      expect(await store.rollback(b, () => scenario !== "local owner consumed")).toBe(true);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        scenario === "current" ? ["/legacy.ts"] : undefined
      );
    }
  );

  it.each([false, true])(
    "crash fallback requires its captured generation (changed=%s)",
    async (changed) => {
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, createdAt: 1, ...attachments("legacy") })
      );
      await prepare("b");
      if (changed)
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        changed ? undefined : ["/legacy.ts"]
      );
    }
  );

  it.each(
    [false, true].flatMap((startingBoundary) =>
      ["none", "identified", "unreadable-reset"].map((replacement) => ({
        startingBoundary,
        replacement,
      }))
    )
  )(
    "heartbeat rollback and restart qualify fallback by the starting boundary ($startingBoundary, replacement=$replacement)",
    async ({ startingBoundary, replacement }) => {
      if (startingBoundary) await boundary("start");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          createdAt: 1,
          ...attachments("legacy"),
          boundaryMessageId: startingBoundary ? "start" : undefined,
        })
      );
      const generation = await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration();
      const b = await prepare("b");
      expect(
        (
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("b", "assistant", "Heartbeat", {
              compacted: "heartbeat",
              compactionBoundary: true,
              compactionEpoch: 2,
            })
          )
        ).success
      ).toBe(true);
      // The ordered fixture supplies an already-completed deletion; the real adapter's
      // exact-delete proof is tested separately. A later boundary cannot revoke that fact.
      const deleted = await h.historyService.deleteMessage(workspaceId, "b");
      expect(deleted.success).toBe(true);
      const foreign = new HistoryService(h.config);
      if (replacement === "unreadable-reset") boundaryOverride = { kind: "unreadable-reset" };
      if (replacement === "identified") {
        expect(
          (
            await foreign.appendToHistory(
              workspaceId,
              createMuxMessage("c", "assistant", "Replacement", {
                compacted: "user",
                compactionBoundary: true,
                compactionEpoch: 3,
              })
            )
          ).success
        ).toBe(true);
      }
      expect(await foreign.getContinuousCompactionJournal(workspaceId).captureGeneration()).toBe(
        generation
      );
      const expected = replacement === "none" ? ["/legacy.ts"] : undefined;
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(expected);
      expect(await store.rollback(b, () => deleted.success)).toBe(true);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(expected);
    }
  );

  it("rejects a stale publication but accepts a newly captured one", async () => {
    const generation = await h.historyService
      .getContinuousCompactionJournal(workspaceId)
      .captureGeneration();
    await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    expect(
      await store.prepare({
        attachments: attachments("stale"),
        boundaryMessageId: "stale",
        publication: { generation },
        isCurrent: () => true,
      })
    ).toBeUndefined();
    expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    await prepare("fresh");
    await boundary("fresh");
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
  });

  it("checks ownership again after staging, before the pending file changes", async () => {
    await prepare("a");
    await boundary("a");
    const original = await bytes();
    const existingFiles = new Set(readdirSync(path.dirname(filePath)));
    // Revoke as soon as preparatory file I/O occurs. A guard checked only before staging
    // would publish B; the current file must still contain A when preparation settles.
    const isCurrent = () =>
      readdirSync(path.dirname(filePath)).every((name) => existingFiles.has(name));
    expect(
      await store.prepare({
        attachments: attachments("b"),
        boundaryMessageId: "b",
        publication: {
          generation: await h.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGeneration(),
        },
        isCurrent,
      })
    ).toBeUndefined();
    expect(await bytes()).toBe(original);
    expect(new Set(readdirSync(path.dirname(filePath)))).toEqual(existingFiles);
    await prepare("successor");
    await boundary("successor");
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/successor.ts"]);
  });

  it("restoration retains the predecessor's consumption authority", async () => {
    const a = await prepare("a");
    await boundary("a");
    const b = await prepare("b");
    expect(await store.rollback(b, () => true)).toBe(true);
    expect((await restart().load(() => true))?.attachments).toEqual(a.attachments);
    expect(await store.consume(a)).toBe(true);
    expect(await restart().load(() => true)).toBeUndefined();
  });

  it.each([
    { generation: undefined, proof: { kind: "identified", messageId: "a" } },
    { generation: null, proof: undefined },
    { generation: null, proof: { kind: "identified", messageId: 3 } },
    { generation: null, proof: { kind: "unreadable-reset" } },
  ])(
    "incomplete legacy fallback proof suppresses inheritance but preserves the head (%j)",
    async ({ generation, proof }) => {
      await boundary("a");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          createdAt: 2,
          ...attachments("uncommitted"),
          boundaryMessageId: "b",
          publicationGeneration: null,
          previousStateGeneration: generation,
          previousStateBoundary: proof,
          previousState: {
            version: 1,
            createdAt: 1,
            ...attachments("a"),
            boundaryMessageId: "a",
          },
        })
      );
      const original = await bytes();
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes()).toBe(original);
      await boundary("b");
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual([
        "/uncommitted.ts",
      ]);
    }
  );

  it.each(["prepare", "load"] as const)(
    "rechecks local ownership after a held file read (%s)",
    async (operation) => {
      await prepare("a");
      await boundary("a");
      const original = await bytes();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      let held = false;
      // Preserve every readFile overload: the wrapper only delays the delegated result.
      spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        const result = await readFile(...args);
        if (args[0] === filePath && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      }) as typeof fs.readFile);
      let current = true;
      const publication = {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      };
      const pending =
        operation === "load"
          ? store.load(() => current)
          : store.prepare({
              attachments: attachments("retired"),
              boundaryMessageId: "retired",
              publication,
              isCurrent: () => current,
            });
      try {
        await entered.promise;
        current = false;
        release.resolve();
        expect(await pending).toBeUndefined();
        expect(await bytes()).toBe(original);
      } finally {
        release.resolve();
        await pending;
      }
      await prepare("successor");
      await boundary("successor");
      expect((await store.load(() => true))?.attachments.readFiles).toEqual(["/successor.ts"]);
    }
  );

  it("serializes a held unlink before a successor publication", async () => {
    const a = await prepare("a");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const unlink = fs.unlink;
    spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === filePath) {
        entered.resolve();
        await release.promise;
      }
      return unlink(file);
    });
    const consuming = store.consume(a);
    let successor: Promise<CompactionPendingReceipt> | undefined;
    try {
      await entered.promise;
      successor = prepare("b", restart());
      release.resolve();
      expect(await consuming).toBe(true);
      await successor;
      await boundary("b");
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/b.ts"]);
    } finally {
      release.resolve();
      await consuming;
      await successor;
    }
  });

  it("durable reset cleanup preserves later publications and retries real unlink failures", async () => {
    await prepare("old");
    await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    const unlink = fs.unlink;
    let failed = false;
    spyOn(fs, "unlink").mockImplementation((file) => {
      if (file === filePath && !failed) {
        failed = true;
        return Promise.reject(new Error("disk unavailable"));
      }
      return unlink(file);
    });
    expect(await store.discardAfterBoundary().catch((error: unknown) => error)).toMatchObject({
      message: "disk unavailable",
    });
    await store.discardAfterBoundary();
    expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    await prepare("new");
    const current = await bytes();
    await store.discardAfterBoundary();
    expect(await bytes()).toBe(current);
    await boundary("new");
    await store.discardAfterBoundary();
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/new.ts"]);
  });

  it.each(["load", "rollback", "discard"] as const)(
    "a matching boundary cannot qualify a stale generation (%s)",
    async (operation) => {
      const receipt = await prepare("a");
      await boundary("a");
      await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      if (operation === "load") expect(await restart().load(() => true)).toBeUndefined();
      else if (operation === "rollback")
        expect(await store.rollback(receipt, () => true)).toBe(true);
      else await store.discardAfterBoundary();
      expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(
    (["load", "discard"] as const).flatMap((operation) =>
      [false, true].map((changed) => ({ operation, changed }))
    )
  )(
    "tagged legacy without generation proof only qualifies initial history (%j)",
    async ({ operation, changed }) => {
      await boundary("a");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          createdAt: 1,
          boundaryMessageId: "a",
          ...attachments("legacy"),
        })
      );
      if (changed)
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      if (operation === "discard") await store.discardAfterBoundary();
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        changed ? undefined : ["/legacy.ts"]
      );
      if (operation === "discard" && changed)
        expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["tagged after generation", "untagged before summary"] as const)(
    "preserves ambiguous legacy bytes until fresh compaction (%s)",
    async (scenario) => {
      const tagged = scenario === "tagged after generation";
      if (tagged) {
        await boundary("summary");
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      }
      const raw = JSON.stringify(
        {
          version: 1,
          createdAt: 1,
          ...attachments("legacy"),
          boundaryMessageId: tagged ? "summary" : undefined,
        },
        null,
        2
      );
      await fs.writeFile(filePath, raw);
      if (!tagged) await boundary("summary");
      expect(await store.load(() => true)).toBeUndefined();
      expect(await bytes()).toBe(raw);
      expect(await restart().load(() => true)).toBeUndefined();
      expect(await bytes()).toBe(raw);
      await prepare("fresh");
      expect(await restart().load(() => true)).toBeUndefined();
      await boundary("fresh");
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
    }
  );

  it.each(
    (
      [
        { kind: "none" },
        { kind: "identified", messageId: "a" },
        { kind: "unreadable-reset" },
      ] as const
    ).flatMap((startingBoundary) => [false, true].map((changed) => ({ startingBoundary, changed })))
  )(
    "untagged legacy requires proven initial history (%j)",
    async ({ startingBoundary, changed }) => {
      boundaryOverride = startingBoundary;
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, createdAt: 1, ...attachments("legacy") })
      );
      if (changed)
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        startingBoundary.kind === "none" && !changed ? ["/legacy.ts"] : undefined
      );
    }
  );

  it.each([false, true])(
    "an unreadable floor permits fresh preparation without inheritance (commit=%s)",
    async (commit) => {
      boundaryOverride = { kind: "unreadable-reset" };
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, createdAt: 1, ...attachments("legacy") })
      );
      const receipt = await prepare("fresh");
      const provisional = await bytes();
      expect(await restart().load(() => true)).toBeUndefined();
      await store.discardAfterBoundary();
      expect(await bytes()).toBe(provisional);
      if (commit) {
        await boundary("fresh");
        boundaryOverride = undefined;
        expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
      } else {
        expect(await store.rollback(receipt, () => true)).toBe(true);
        expect(await bytes().catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
      }
    }
  );
});
