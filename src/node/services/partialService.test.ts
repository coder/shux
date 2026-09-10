import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import * as fs from "fs/promises";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath } from "@/node/services/workspaceRemoval";

describe("HistoryService partial persistence - Error Recovery", () => {
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService: partialService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("commitPartial should strip error metadata and commit parts from errored partial", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Hello, I was processing when" },
        { type: "text", text: " the error occurred" },
      ],
    };

    expect((await partialService.writePartial(workspaceId, erroredPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // Committed with cleaned metadata (no error/errorType), then the partial is deleted.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data.map((m) => m.id)).toEqual(["msg-1"]);
    const appendedMessage = committed.success ? committed.data[0] : undefined;
    expect(appendedMessage?.parts).toEqual(erroredPartial.parts);
    expect(appendedMessage?.metadata?.error).toBeUndefined();
    expect(appendedMessage?.metadata?.errorType).toBeUndefined();
    expect(appendedMessage?.metadata?.historySequence).toBe(1);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("updatePartialIfMessageIdMatches waits out a commitPartial transaction and declines", async () => {
    const workspaceId = "test-workspace";
    const partial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: { historySequence: 1, timestamp: Date.now(), model: "test-model" },
      parts: [{ type: "text", text: "Hello" }],
    };
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);

    // Park the commit inside its transaction: call 1 is its lock-free probe, call 2 the snapshot
    // it takes once it holds both locks.
    let releaseCommitRead: (() => void) | undefined;
    const commitReadGate = new Promise<void>((resolve) => {
      releaseCommitRead = resolve;
    });
    let commitReadReached: (() => void) | undefined;
    const commitReadReachedGate = new Promise<void>((resolve) => {
      commitReadReached = resolve;
    });
    const readPartial = partialService.readPartial.bind(partialService);
    let readCalls = 0;
    const readSpy = spyOn(partialService, "readPartial").mockImplementation(
      async (targetWorkspaceId: string) => {
        if (++readCalls === 2) {
          commitReadReached?.();
          await commitReadGate;
        }
        return readPartial(targetWorkspaceId);
      }
    );
    try {
      const commit = partialService.commitPartial(workspaceId);
      await commitReadReachedGate;

      const cas = partialService.updatePartialIfMessageIdMatches(
        workspaceId,
        "msg-1",
        (current) => ({
          ...current,
          parts: [...current.parts, { type: "text", text: " (finalized)" }],
        })
      );
      const sentinel = Symbol("still-pending");
      expect(
        await Promise.race([
          cas,
          new Promise((resolve) => setTimeout(() => resolve(sentinel), 100)),
        ])
      ).toBe(sentinel);

      releaseCommitRead?.();
      expect((await commit).success).toBe(true);
      expect(await cas).toEqual(Ok(false));
    } finally {
      readSpy.mockRestore();
    }

    // The commit landed exactly what it snapshotted, and the CAS did not write anything.
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(partial.parts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial snapshots the partial after an in-flight updatePartialIfMessageIdMatches lands", async () => {
    const workspaceId = "test-workspace";
    const partial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: { historySequence: 1, timestamp: Date.now(), model: "test-model" },
      parts: [{ type: "text", text: "Hello" }],
    };
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);
    const finalizedParts = [...partial.parts, { type: "text" as const, text: " (finalized)" }];

    // Park the CAS inside its critical section (after it took both locks, before it writes).
    let releaseCasRead: (() => void) | undefined;
    const casReadGate = new Promise<void>((resolve) => {
      releaseCasRead = resolve;
    });
    let casReadReached: (() => void) | undefined;
    const casReadReachedGate = new Promise<void>((resolve) => {
      casReadReached = resolve;
    });
    const readPartial = partialService.readPartial.bind(partialService);
    let readCalls = 0;
    const readSpy = spyOn(partialService, "readPartial").mockImplementation(
      async (targetWorkspaceId: string) => {
        if (readCalls++ === 0) {
          casReadReached?.();
          await casReadGate;
        }
        return readPartial(targetWorkspaceId);
      }
    );
    try {
      const cas = partialService.updatePartialIfMessageIdMatches(
        workspaceId,
        "msg-1",
        (current) => ({
          ...current,
          parts: finalizedParts,
        })
      );
      await casReadReachedGate;

      const commit = partialService.commitPartial(workspaceId);
      releaseCasRead?.();

      expect(await cas).toEqual(Ok(true));
      expect((await commit).success).toBe(true);
    } finally {
      readSpy.mockRestore();
    }

    // The commit waited for the CAS and committed the finalized partial, not its pre-update state.
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(finalizedParts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial should update existing placeholder when errored partial has more parts", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Accumulated content before error" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    const existingPlaceholder: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
      },
      parts: [], // Empty placeholder
    };

    // Seed the existing placeholder into history so the commit finds it by historySequence.
    await partialService.appendToHistory(workspaceId, existingPlaceholder);
    expect((await partialService.writePartial(workspaceId, erroredPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // The placeholder row is updated in place (no second row) with cleaned metadata.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data.map((m) => m.id)).toEqual(["msg-1"]);
    const updatedMessage = committed.success ? committed.data[0] : undefined;
    expect(updatedMessage?.parts).toEqual(erroredPartial.parts);
    expect(updatedMessage?.metadata?.error).toBeUndefined();
    expect(updatedMessage?.metadata?.errorType).toBeUndefined();
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial should skip tool-only incomplete partials", async () => {
    const workspaceId = "test-workspace";
    const toolOnlyPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream interrupted",
        errorType: "network",
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    expect((await partialService.writePartial(workspaceId, toolOnlyPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // Nothing committed, partial still cleaned up.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data).toEqual([]);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });
  test("commitPartial should skip empty errored partial", async () => {
    const workspaceId = "test-workspace";
    const emptyErrorPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Network error",
        errorType: "network",
      },
      parts: [], // Empty - no content accumulated before error
    };

    expect((await partialService.writePartial(workspaceId, emptyErrorPartial)).success).toBe(true);

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    // No value to preserve: nothing committed, partial still cleaned up.
    const committed = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(committed.success && committed.data).toEqual([]);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("commitPartial deletes a blank assistant placeholder after an empty errored partial", async () => {
    const workspaceId = "test-workspace";
    const historySequence = 1;

    await partialService.appendToHistory(
      workspaceId,
      createMuxMessage("msg-1", "assistant", "", {
        historySequence,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
      })
    );

    partialService.readPartial = mock(() =>
      Promise.resolve({
        id: "msg-1",
        role: "assistant",
        metadata: {
          historySequence,
          timestamp: Date.now(),
          model: "test-model",
          partial: true,
          error: "Network error",
          errorType: "empty_output",
        },
        parts: [],
      } satisfies MuxMessage)
    );

    const result = await partialService.commitPartial(workspaceId);
    expect(result.success).toBe(true);

    const historyResult = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    expect(historyResult.data).toEqual([]);
  });
  test("commitPartial deletes stale pre-boundary partial instead of appending it", async () => {
    const workspaceId = "test-workspace-stale-partial";
    const rows = [
      createMuxMessage("user-before", "user", "before", { historySequence: 0 }),
      createMuxMessage("assistant-before", "assistant", "before reply", { historySequence: 1 }),
      createMuxMessage("summary", "assistant", "summary", {
        historySequence: 2,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      }),
      createMuxMessage("user-after", "user", "after", { historySequence: 3 }),
    ];

    for (const row of rows) {
      const appendResult = await partialService.appendToHistory(workspaceId, row);
      expect(appendResult.success).toBe(true);
    }

    const stalePartial = createMuxMessage("assistant-before", "assistant", "stale partial", {
      historySequence: 1,
      partial: true,
    });
    const writePartialResult = await partialService.writePartial(workspaceId, stalePartial);
    expect(writePartialResult.success).toBe(true);

    const commitResult = await partialService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);

    const partialAfterCommit = await partialService.readPartial(workspaceId);
    expect(partialAfterCommit).toBeNull();

    const historyResult = await partialService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }

    expect(historyResult.data.map((message) => message.id)).toEqual(["summary", "user-after"]);
    expect(historyResult.data.at(-1)?.metadata?.historySequence).toBe(3);

    const nextMessage = createMuxMessage("next-user", "user", "next");
    const appendNextResult = await partialService.appendToHistory(workspaceId, nextMessage);
    expect(appendNextResult.success).toBe(true);
    expect(nextMessage.metadata?.historySequence).toBe(4);
  });
});

describe("HistoryService partial persistence - Foreign backend", () => {
  let config: Config;
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;
  const workspaceId = "foreign-ws";
  const partial: MuxMessage = {
    id: "msg-1",
    role: "assistant",
    metadata: { historySequence: 1, timestamp: 1, model: "test-model", partial: true },
    parts: [{ type: "text", text: "Hello" }],
  };
  const stillPending = Symbol("still-pending");

  beforeEach(async () => {
    ({ config, historyService: partialService, cleanup } = await createTestHistoryService());
    expect((await partialService.writePartial(workspaceId, partial)).success).toBe(true);
  });

  afterEach(async () => {
    await cleanup();
  });

  // Another backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) holds the session-dir write lock.
  const holdForeignLock = () =>
    acquireProcessFileLock({
      lockPath: historyWriteLockPath(config.rootDir, workspaceId),
      timeoutMs: 5_000,
      label: "test foreign backend",
    });
  const overwritePartialOnDisk = (message: MuxMessage) =>
    fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "partial.json"),
      JSON.stringify(message)
    );
  const raceWithTimeout = <T>(promise: Promise<T>) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(stillPending), 250))]);

  test("commitPartial snapshots the partial only once it holds the cross-process lock", async () => {
    const foreign = await holdForeignLock();
    const commit = partialService.commitPartial(workspaceId);
    expect(await raceWithTimeout(commit)).toBe(stillPending);

    // The foreign holder finalizes the partial before releasing the lock.
    const finalizedParts = [...partial.parts, { type: "text" as const, text: " (finalized)" }];
    await overwritePartialOnDisk({ ...partial, parts: finalizedParts });
    await foreign[Symbol.asyncDispose]();

    expect((await commit).success).toBe(true);
    const committed = await partialService.getLastMessages(workspaceId, 1);
    expect(committed.success && committed.data[0]?.parts).toEqual(finalizedParts);
    expect(await partialService.readPartial(workspaceId)).toBeNull();
  });

  test("updatePartialIfMessageIdMatches reads the partial only once it holds the cross-process lock", async () => {
    const foreign = await holdForeignLock();
    const cas = partialService.updatePartialIfMessageIdMatches(workspaceId, "msg-1", (current) => ({
      ...current,
      parts: [...current.parts, { type: "text", text: " (finalized)" }],
    }));
    expect(await raceWithTimeout(cas)).toBe(stillPending);

    // The foreign holder committed msg-1 and started a new stream under msg-2.
    const foreignPartial: MuxMessage = {
      ...partial,
      id: "msg-2",
      parts: [{ type: "text", text: "Next" }],
    };
    await overwritePartialOnDisk(foreignPartial);
    await foreign[Symbol.asyncDispose]();

    expect(await cas).toEqual(Ok(false));
    const onDisk = await partialService.readPartial(workspaceId);
    expect(onDisk?.id).toBe("msg-2");
    expect(onDisk?.parts).toEqual(foreignPartial.parts);
  });
});

describe("HistoryService partial persistence - Legacy compatibility", () => {
  let config: Config;
  let partialService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ config, historyService: partialService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("readPartial upgrades legacy cmuxMetadata", async () => {
    const workspaceId = "legacy-ws";
    const workspaceDir = path.join(config.sessionsDir, workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const partialMessage = createMuxMessage("partial-1", "assistant", "legacy", {
      historySequence: 0,
    });
    (partialMessage.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };

    const partialPath = path.join(workspaceDir, "partial.json");
    await fs.writeFile(partialPath, JSON.stringify(partialMessage));

    const result = await partialService.readPartial(workspaceId);
    expect(result?.metadata?.muxMetadata?.type).toBe("normal");
  });
});
