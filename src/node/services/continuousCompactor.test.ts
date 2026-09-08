import type { ContinuousPrefixSwap } from "./continuousCompactionJournal";
import { stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as atomicWrite from "write-file-atomic";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { EAGER_LEAD_PERCENT } from "@/constants/continuousCompaction";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { ContinuousCompactor, type ContinuousCompactionContext } from "./continuousCompactor";
import { CompactionHandler } from "./compactionHandler";
import { createTestHistoryService } from "./testHistoryService";
import { HistoryService } from "./historyService";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath } from "./workspaceRemoval";

type Dependencies = ConstructorParameters<typeof ContinuousCompactor>[0];
type LiveSnapshot = NonNullable<ReturnType<Dependencies["streamManager"]["getStreamInfo"]>> & {
  currentStepStartIndex: number;
};

const releaseLatches: Array<() => void> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  releaseLatches.push(resolve);
  return { promise, resolve };
}

const workspaceId = "continuous-tests";
const context: ContinuousCompactionContext & { phase: "on-send" | "mid-stream" | "stream-end" } = {
  enabled: true,
  model: "anthropic:claude-sonnet-4-5",
  contextWindowTokens: 100_000,
  thresholdPercent: 80,
  systemMessageTokens: 300,
  attachmentTokens: 100,
  phase: "stream-end",
};
const eagerPercent = context.thresholdPercent - EAGER_LEAD_PERCENT;
const forcePercent = context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT;
const summary = {
  text: "The earlier investigation established the fix and its validation plan.",
  model: context.model,
};

// Only the background job is joined through a private seam. All state assertions use durable
// history or callbacks; no timer guesses how long filesystem I/O or usage recording takes.
function eagerJob(compactor: ContinuousCompactor): Promise<void> {
  const job = (compactor as unknown as { job: { done: Promise<void> } | null }).job;
  assert(job, "Expected an eager job to have started");
  return job.done;
}

describe("ContinuousCompactor", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  let handler: CompactionHandler;
  let emitter: EventEmitter;
  let compactor: ContinuousCompactor;
  let live: LiveSnapshot | undefined;
  let streaming: boolean;
  let prepare: ReturnType<typeof mock<Dependencies["prepare"]>>;
  let summarize: ReturnType<typeof mock<Dependencies["summarize"]>>;
  let estimateAttachments: ReturnType<typeof mock<(head: MuxMessage[]) => Promise<number>>>;
  let fastApply: ReturnType<typeof mock<Dependencies["fastApply"]>>;
  let completed: ReturnType<typeof mock>;
  const jobs: Array<Promise<void>> = [];

  beforeEach(async () => {
    store = await createTestHistoryService();
    emitter = new EventEmitter();
    live = undefined;
    streaming = false;
    completed = mock();
    handler = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir: path.join(store.tempDir, "pending"),
      emitter,
      onCompactionComplete: completed,
    });
    prepare = mock(() => {
      emitter.emit("compaction.prepare");
      return Promise.resolve();
    });
    summarize = mock(() => Promise.resolve(summary));
    estimateAttachments = mock(() => Promise.resolve(context.attachmentTokens ?? 0));
    fastApply = mock(async (apply) => {
      streaming = false;
      live = undefined;
      return apply();
    });
    compactor = new ContinuousCompactor({
      workspaceId,
      historyService: store.historyService,
      compactionHandler: handler,
      streamManager: { getStreamInfo: () => live, isStreaming: () => streaming },
      prepare,
      summarize,
      estimateAttachmentTokens: estimateAttachments,
      fastApply,
    });
  });

  afterEach(async () => {
    compactor.reset("test cleanup");
    // An assertion failure must not leave a background summary waiting forever.
    for (const release of releaseLatches.splice(0)) release();
    await Promise.all(jobs.splice(0));
    await compactor.waitForIdle();
    mock.restore();
    await store.cleanup();
  });

  async function seed(...messages: MuxMessage[]) {
    for (const message of messages) {
      expect((await store.historyService.appendToHistory(workspaceId, message)).success).toBe(true);
    }
  }

  async function rows() {
    const result = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success, "History should be readable");
    return result.data;
  }

  async function seedConversation() {
    await seed(
      createMuxMessage("old-user", "user", "Investigate the regression"),
      createMuxMessage("old-answer", "assistant", "earlier investigation ".repeat(4_000)),
      createMuxMessage("recent-user", "user", "Implement the fix"),
      createMuxMessage("recent-answer", "assistant", "The fix is ready for review.")
    );
  }

  async function start(usage = eagerPercent, options = context) {
    const verdict = await compactor.observe(usage, options);
    const job = eagerJob(compactor);
    jobs.push(job);
    return { verdict, job };
  }

  async function stage() {
    await (
      await start()
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
  }

  it("starts once at the eager threshold, stages without a boundary, and applies without another summary", async () => {
    await seedConversation();
    const release = deferred();
    const entered = deferred();
    summarize.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return summary;
    });
    expect(await compactor.observe(eagerPercent - 1, context)).toBe("none");
    expect(prepare).not.toHaveBeenCalled();
    const { job } = await start();
    await entered.promise;
    expect(await compactor.observe(eagerPercent, context)).toBe("none");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect((await rows()).map((row) => row.id)).toContain("old-answer");
    release.resolve();
    await job;
    expect(await compactor.observe(eagerPercent, context)).toBe("none");
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect((await rows())[0].parts).toMatchObject([{ type: "text", text: summary.text }]);
  });

  for (const disabled of [{ enabled: false }, { thresholdPercent: 100 }]) {
    it(`does no prepare, summary, apply, or forced fallback when ${JSON.stringify(disabled)}`, async () => {
      await seedConversation();
      expect(await compactor.observe(200, { ...context, ...disabled })).toBe("none");
      expect(prepare).not.toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(fastApply).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((await rows()).map((row) => row.id)).toEqual([
        "old-user",
        "old-answer",
        "recent-user",
        "recent-answer",
      ]);
    });
  }

  for (const disabled of [{ enabled: false }, { thresholdPercent: 100 }]) {
    it(`discards an already staged summary when ${JSON.stringify(disabled)}`, async () => {
      await seedConversation();
      await stage();
      expect(await compactor.observe(200, { ...context, ...disabled, phase: "mid-stream" })).toBe(
        "none"
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(fastApply).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      summarize.mockResolvedValue(null);
      const next = await start(context.thresholdPercent);
      await next.job;
      expect(next.verdict).toBe("none");
      expect(completed).not.toHaveBeenCalled();
      expect((await rows())[0].id).toBe("old-user");
    });
  }

  it("awaits compaction.prepare listener persistence before taking the head snapshot", async () => {
    await seedConversation();
    const listenerEntered = deferred();
    const release = deferred();
    let mutation = Promise.resolve();
    emitter.on("compaction.prepare", () => {
      mutation = (async () => {
        listenerEntered.resolve();
        await release.promise;
        const head = (await rows())[1];
        head.parts.push({ type: "text", text: "Prepared listener state" });
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      })();
    });
    prepare.mockImplementation(async () => {
      emitter.emit("compaction.prepare");
      await mutation;
    });
    const { job } = await start();
    await listenerEntered.promise;
    expect(summarize).not.toHaveBeenCalled();
    release.resolve();
    await job;
    expect(summarize.mock.calls[0][0].find((row) => row.id === "old-answer")?.parts).toContainEqual(
      { type: "text", text: "Prepared listener state" }
    );
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
  });

  it("aborts reset and cannot stage a stale summary after its last usage-recording await", async () => {
    await seedConversation();
    const usageEntered = deferred();
    const usageRecorded = deferred();
    summarize.mockImplementation(async () => {
      usageEntered.resolve();
      await usageRecorded.promise;
      return summary;
    });
    const { job } = await start();
    await usageEntered.promise;
    const signal = summarize.mock.calls[0][1];
    compactor.reset("edited while recording usage");
    expect(signal.aborted).toBe(true);
    usageRecorded.resolve();
    await job;
    summarize.mockResolvedValue(null);
    const replacement = await start(context.thresholdPercent);
    expect(replacement.verdict).toBe("none");
    await replacement.job;
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  for (const change of ["parts", "request metadata", "epoch", "truncate", "delete"] as const) {
    it(`rejects a staged summary after ${change} changes`, async () => {
      await seedConversation();
      await stage();
      const head = (await rows())[1];
      if (change === "parts") {
        head.parts.push({ type: "text", text: "An edit changes provider input" });
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      } else if (change === "request metadata") {
        head.metadata = { ...head.metadata, fileAtMentionSnapshot: ["/tmp/new-context.ts"] };
        expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
      } else if (change === "epoch") {
        await seed(
          createMuxMessage("other-boundary", "assistant", "Another compaction", {
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: 1,
            muxMetadata: { type: "compaction-summary" },
          })
        );
      } else if (change === "truncate") {
        expect(
          (await store.historyService.truncateAfterMessage(workspaceId, head.id)).success
        ).toBe(true);
      } else {
        expect((await store.historyService.deleteMessage(workspaceId, head.id)).success).toBe(true);
      }
      summarize.mockResolvedValue(null);
      const next = await start(forcePercent);
      expect(next.verdict).toBe("fallback");
      await next.job;
      expect(completed).not.toHaveBeenCalled();
      expect(fastApply).not.toHaveBeenCalled();
    });
  }

  it("allows partial finalization, timestamps, and usage-only changes to the summarized head", async () => {
    await seedConversation();
    await stage();
    const head = (await rows())[1];
    head.metadata = {
      ...head.metadata,
      partial: false,
      timestamp: 9000,
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      contextUsage: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
    };
    expect((await store.historyService.updateHistory(workspaceId, head)).success).toBe(true);
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent observes and awaits the single durable apply", async () => {
    await seedConversation();
    await stage();
    const entered = deferred();
    const release = deferred();
    fastApply.mockImplementation(async (apply) => {
      entered.resolve();
      await release.promise;
      return apply();
    });
    const first = compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" });
    await entered.promise;
    expect(compactor.isApplying()).toBe(true);
    const second = compactor.observe(forcePercent, { ...context, phase: "mid-stream" });
    const idle = compactor.waitForIdle();
    release.resolve();
    expect(await Promise.all([first, second])).toEqual(["applied", "applied"]);
    await idle;
    expect(compactor.isApplying()).toBe(false);
    expect(fastApply).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect((await rows()).filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
  });

  it("refuses to append a boundary while a stream remains active", async () => {
    await seedConversation();
    await stage();
    streaming = true;
    const result = await compactor
      .observe(context.thresholdPercent, context)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("stream is active");
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  it("requires partial.json to be committed before applying the staged summary", async () => {
    await seedConversation();
    await stage();
    const partial = (await rows()).at(-1)!;
    partial.metadata = { ...partial.metadata, partial: true };
    expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    const result = await compactor
      .observe(context.thresholdPercent, context)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("partial to be committed");
    expect(completed).not.toHaveBeenCalled();
    expect(await store.historyService.readPartial(workspaceId)).not.toBeNull();
    expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
  });

  it("prepares durable file diffs before the boundary and reloads them after restart", async () => {
    await seedConversation();
    const edit = (await rows())[1];
    edit.parts.push({
      type: "dynamic-tool",
      toolCallId: "edit-1",
      toolName: "file_edit_replace_string",
      state: "output-available",
      input: { path: "/tmp/fix.ts" },
      output: { success: true, diff: "@@ -1 +1 @@\n-broken\n+fixed\n" },
    });
    expect((await store.historyService.updateHistory(workspaceId, edit)).success).toBe(true);
    await stage();
    const original = store.historyService.persistBoundaryWithTailCopies.bind(store.historyService);
    const persist = spyOn(store.historyService, "persistBoundaryWithTailCopies").mockImplementation(
      async (...args) => {
        const state: unknown = JSON.parse(
          await readFile(path.join(store.tempDir, "pending", "post-compaction.json"), "utf8")
        );
        expect(state).toMatchObject({
          diffs: [{ path: "/tmp/fix.ts", diff: "@@ -1 +1 @@\n-broken\n+fixed\n" }],
        });
        return original(...args);
      }
    );
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    expect(persist).toHaveBeenCalledTimes(1);
    const restarted = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir: path.join(store.tempDir, "pending"),
      emitter: new EventEmitter(),
    });
    expect((await restarted.peekPendingState())?.diffs).toMatchObject([
      { path: "/tmp/fix.ts", diff: "@@ -1 +1 @@\n-broken\n+fixed\n" },
    ]);
  });

  it("invalidates an apply reset during pending-state persistence", async () => {
    await seedConversation();
    await stage();
    const entered = deferred();
    const release = deferred();
    const original = handler.preparePendingStateFromMessages.bind(handler);
    spyOn(handler, "preparePendingStateFromMessages").mockImplementation(async (...args) => {
      await original(...args);
      entered.resolve();
      await release.promise;
    });
    const applying = compactor.observe(context.thresholdPercent, context);
    await entered.promise;
    compactor.reset("new turn while persisting pending state");
    summarize.mockResolvedValue(null);
    release.resolve();
    expect(await applying).toBe("none");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
  });

  it("does not publish after reset during the staged history file write", async () => {
    await seedConversation();
    await stage();
    const entered = deferred();
    const release = deferred();
    const original = atomicWrite.default;
    spyOn(atomicWrite, "default").mockImplementation(
      Object.assign(
        async (
          filename: string,
          data: string | Buffer,
          options?: atomicWrite.Options | BufferEncoding | ((error?: Error) => void),
          callback?: (error?: Error) => void
        ) => {
          await original(filename, data, typeof options === "function" ? undefined : options);
          if (filename.includes(".continuous-")) {
            entered.resolve();
            await release.promise;
          }
          if (typeof options === "function") options();
          else callback?.();
        },
        { sync: original.sync }
      )
    );
    const applying = compactor.observe(context.thresholdPercent, context);
    await entered.promise;
    compactor.reset("abandon");
    release.resolve();
    expect(await applying).toBe("none");
    expect((await rows())[0].id).toBe("old-user");
    expect(completed).not.toHaveBeenCalled();
    expect(await handler.peekPendingState()).toBeNull();
    const restarted = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir: path.join(store.tempDir, "pending"),
      emitter: new EventEmitter(),
    });
    expect(await restarted.peekPendingState()).toBeNull();
  });

  it("ignores provisional pending state on restart until its boundary is durable", async () => {
    await seedConversation();
    await stage();
    const original = store.historyService.persistBoundaryWithTailCopies.bind(store.historyService);
    spyOn(store.historyService, "persistBoundaryWithTailCopies").mockImplementationOnce(
      async (...args) => {
        const restarted = new CompactionHandler({
          workspaceId,
          historyService: store.historyService,
          sessionDir: path.join(store.tempDir, "pending"),
          emitter: new EventEmitter(),
        });
        expect(await restarted.peekPendingState()).toBeNull();
        // Simulate the crash by rejecting the publication after testing its orphan snapshot.
        compactor.reset("crash before boundary");
        return original(...args);
      }
    );
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("none");
    expect((await rows())[0].id).toBe("old-user");
  });

  it.each(["reset", "append"] as const)(
    "rejects %s while waiting for the actual history write",
    async (mutation) => {
      await seedConversation();
      await stage();
      const entered = deferred();
      const release = deferred();
      const original = store.historyService.persistBoundaryWithTailCopies.bind(
        store.historyService
      );
      spyOn(store.historyService, "persistBoundaryWithTailCopies").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return original(...args);
        }
      );
      const applying = compactor.observe(context.thresholdPercent, context);
      await entered.promise;
      if (mutation === "reset") compactor.reset("archive");
      else await seed(createMuxMessage("new-user", "user", "New information must survive"));
      summarize.mockResolvedValue(null);
      release.resolve();
      expect(await applying).toBe("none");
      if (mutation === "append") {
        const job = eagerJob(compactor);
        jobs.push(job);
        await job;
      }
      expect((await rows())[0].id).toBe("old-user");
      expect(completed).not.toHaveBeenCalled();
      if (mutation === "append") expect((await rows()).at(-1)?.id).toBe("new-user");
    }
  );

  it("does not stage a summary that itself exhausts the force budget", async () => {
    await seedConversation();
    summarize.mockResolvedValue({ ...summary, text: "x".repeat(context.contextWindowTokens * 4) });
    await stage();
    summarize.mockResolvedValue(null);
    expect(await compactor.observe(forcePercent, context)).toBe("fallback");
    const job = eagerJob(compactor);
    jobs.push(job);
    await job;
    expect((await rows())[0].id).toBe("old-user");
    expect(fastApply).not.toHaveBeenCalled();
  });

  async function seedLiveTurn(committedTail = false, splitCommitted = false) {
    const earlier = createMuxMessage("committed-tail", "assistant", "", {
      stepStartPartIndices: [0],
      partial: true,
    });
    earlier.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "committed-tool",
        toolName: "bash",
        state: "output-available",
        input: { script: "pwd" },
        output: { success: true },
      },
    ];
    if (splitCommitted) {
      earlier.parts = [
        { type: "text", text: "committed investigation ".repeat(8_000) },
        {
          type: "dynamic-tool",
          toolCallId: "old-committed-tool",
          toolName: "bash",
          state: "output-available",
          input: {},
          output: { success: true },
        },
        ...earlier.parts,
      ];
      earlier.metadata = { ...earlier.metadata, stepStartPartIndices: [0, 2] };
    }
    await seed(
      createMuxMessage("old-user", "user", "Investigate the regression"),
      createMuxMessage("old-answer", "assistant", "earlier investigation ".repeat(4_000)),
      ...(committedTail
        ? [createMuxMessage("committed-user", "user", "Preserve this earlier task"), earlier]
        : []),
      createMuxMessage("live-user", "user", "Implement and verify the fix")
    );
    const answer = createMuxMessage("live-answer", "assistant", "", {
      partial: true,
      stepStartPartIndices: [0, 1, 2],
      usage: { inputTokens: 70_000, outputTokens: 1_000, totalTokens: 71_000 },
      contextUsage: { inputTokens: 70_000, outputTokens: 1_000, totalTokens: 71_000 },
    });
    answer.parts = [
      {
        type: "text",
        text: committedTail ? "completed small step" : "completed investigation ".repeat(4_000),
      },
      { type: "text", text: "latest completed step" },
      { type: "text", text: "currently streaming step" },
    ];
    await seed(answer);
    live = {
      messageId: answer.id,
      parts: structuredClone(answer.parts),
      stepStartIndices: [0, 1, 2],
      currentStepStartIndex: 2,
    };
    streaming = true;
    return answer;
  }

  async function activateJournaledSwap(
    committedTail = false,
    consumed = true,
    splitCommitted = false
  ) {
    const answer = await seedLiveTurn(committedTail, splitCommitted);
    assert(live, "Live fixture missing");
    const toolPart: MuxMessage["parts"][number] = {
      type: "dynamic-tool",
      toolCallId: "tail-tool",
      toolName: "bash",
      state: "output-available",
      input: { script: "pwd" },
      output: { success: true },
    };
    const liveToolIndex = committedTail ? 0 : 1;
    live.parts[liveToolIndex] = toolPart;
    answer.parts[liveToolIndex] = toolPart;
    let swap: ContinuousPrefixSwap | undefined;
    let state: "none" | "pending" | "consumed" = "none";
    const dependencies: Dependencies = {
      workspaceId,
      historyService: store.historyService,
      compactionHandler: handler,
      streamManager: {
        getStreamInfo: () => live,
        isStreaming: () => streaming,
        setPrefixSwap: (_id, value) => {
          swap = value;
          state = "pending";
          return true;
        },
        clearPrefixSwap: () => {
          state = "none";
        },
        getPrefixSwapState: () => (streaming ? state : "none"),
      },
      prepare,
      summarize,
      fastApply,
      prepareSwap: () =>
        Promise.resolve({
          preparation: {
            modelString: context.model,
            providerForMessages: "anthropic",
            effectiveAgentId: "exec",
            toolNamesForSentinel: ["bash"],
            effectiveThinkingLevel: "off",
          },
          attachments: [{ type: "read_files_reference", paths: ["kept.txt"] }],
          systemPrefix: [],
          cacheEnabled: true,
        }),
    };
    compactor = new ContinuousCompactor(dependencies);
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(
      await compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" })
    ).toBe("none");
    assert(swap, "Expected seamless prefix activation");
    expect(fastApply).not.toHaveBeenCalled();
    expect((await rows())[0].id).toBe("old-user");
    const journalStore = store.historyService.getContinuousCompactionJournal(workspaceId);
    const publishedSwap = swap;
    const journal = await journalStore.write(
      swap.journal,
      swap.prefix,
      () => true,
      (committed) => {
        publishedSwap.journal = committed;
      }
    );
    assert(journal, "Expected reproducible journal");
    state = consumed ? "consumed" : "pending";
    swap.consumed = consumed;
    return { answer, journal, journalStore, dependencies, swap };
  }

  for (const reason of ["disabled", "threshold-changed", "context-changed"]) {
    it(`preserves consumed journal through ${reason} and finalizes once even after tracker retirement`, async () => {
      const { answer, journal, journalStore } = await activateJournaledSwap();
      compactor.reset(reason);
      expect(await journalStore.read()).not.toBeNull();
      assert(live, "Live fixture missing");
      answer.parts = [...live.parts, { type: "text", text: "after settings change" }];
      await store.historyService.writePartial(workspaceId, answer);
      streaming = false;
      live = undefined;
      compactor.reset(reason);
      const disabled = { ...context, enabled: false, thresholdPercent: 100 };
      expect(await compactor.observe(0, disabled)).toBe("applied");
      expect(await compactor.observe(0, disabled)).toBe("none");
      expect((await rows())[0].id).toBe(journal.boundary.id);
      expect((await rows()).at(-1)?.parts).toEqual(
        answer.parts.slice(journal.liveTailCopySpec.partIndex)
      );
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(await journalStore.read()).toBeNull();
    });

    it(`cancels an unconsumed journal on ${reason}`, async () => {
      const { journalStore } = await activateJournaledSwap(false, false);
      compactor.reset(reason);
      expect(await journalStore.read()).toBeNull();
      expect(await compactor.observe(100, { ...context, enabled: false })).toBe("none");
      expect((await rows())[0].id).toBe("old-user");
      expect(completed).not.toHaveBeenCalled();
    });
  }

  it.each(["user-interrupt", "edit", "context-mutation"])(
    "%s does not recover an interrupted startup journal on the next attempt",
    async (reason) => {
      const { dependencies, journalStore } = await activateJournaledSwap();
      compactor.reset("shutdown");
      streaming = false;
      live = undefined;
      compactor = new ContinuousCompactor(dependencies);
      const entered = deferred();
      const release = deferred();
      const read = journalStore.read.bind(journalStore);
      spyOn(journalStore, "read").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return read(...args);
      });
      const recovering = compactor.recover();
      try {
        await entered.promise;
        compactor.reset(reason);
        release.resolve();
        expect(await recovering).toBe(false);
        compactor = new ContinuousCompactor(dependencies);
        expect(await compactor.recover()).toBe(false);
        expect((await rows())[0].id).toBe("old-user");
      } finally {
        release.resolve();
        await recovering;
      }
    }
  );

  it("preserves a successor published after exact postcommit cleanup releases its lock", async () => {
    const { journalStore, journal, swap } = await activateJournaledSwap();
    streaming = false;
    live = undefined;
    const foreign = new HistoryService(store.config).getContinuousCompactionJournal(workspaceId);
    const successor = {
      ...journal,
      boundary: { ...journal.boundary, id: "successor-boundary" },
    };
    const clear = journalStore.clear.bind(journalStore);
    spyOn(journalStore, "clear").mockImplementationOnce(async (expected) => {
      await clear(expected);
      expect(await foreign.write(successor, swap.prefix, () => true)).not.toBeNull();
    });
    expect(await compactor.observe(0, context)).toBe("applied");
    expect((await foreign.read())?.boundary.id).toBe(successor.boundary.id);
    expect((await rows())[0].id).toBe(journal.boundary.id);
  });

  for (const phase of ["new-fold", "already-folded", "mismatched-source"] as const) {
    it.each(["same-generation", "reset-during-cleanup"] as const)(
      `${phase} preserves its recovery result after cleanup times out (%s)`,
      async (race) => {
        const resetDuringCleanup = race === "reset-during-cleanup";
        const applied = phase !== "mismatched-source";
        const { journalStore, journal, dependencies } = await activateJournaledSwap();
        streaming = false;
        live = undefined;
        if (phase === "already-folded") {
          expect(await compactor.recover()).toBe(true);
          // Recreate the crash window between durable history publication and journal unlink.
          await writeFile(journalStore.path, JSON.stringify(journal));
        }
        if (phase === "mismatched-source")
          await seed(createMuxMessage("new-user", "user", "New work after the journal"));
        const before = await rows();
        const clearPrefix = spyOn(dependencies.streamManager, "clearPrefixSwap");
        const clear = journalStore.clear.bind(journalStore);
        const failure = spyOn(journalStore, "clear").mockImplementation(async (expected) => {
          await using held = await fileLock.acquireProcessFileLock({
            lockPath: historyWriteLockPath(store.config.rootDir, workspaceId),
            timeoutMs: 1000,
            label: "foreign history writer during journal cleanup",
          });
          if (resetDuringCleanup) compactor.reset("shutdown");
          const acquire = fileLock.acquireProcessFileLock;
          const timeout = spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) =>
            acquire({ ...options, timeoutMs: 1 })
          );
          try {
            await clear(expected);
          } finally {
            timeout.mockRestore();
            await held.assertStillOwned();
          }
        });
        expect(await compactor.recover().catch((error: unknown) => error)).toBe(applied);
        expect(compactor.hasConsumedSwap()).toBe(false);
        // A reset during cleanup owns stream retirement; the old apply must not clear it again.
        expect(clearPrefix).toHaveBeenCalledTimes(
          resetDuringCleanup || phase === "new-fold" ? 1 : 0
        );
        expect(await journalStore.read()).toEqual(journal);
        const once = await rows();
        if (applied) {
          expect(once[0].id).toBe(journal.boundary.id);
          expect(once.at(-1)?.id).toBe(journal.liveTailCopySpec.copyId);
        } else expect(once).toEqual(before);
        expect(completed).toHaveBeenCalledTimes(applied ? 1 : 0);
        expect(await compactor.recover()).toBe(applied);
        expect(await journalStore.read()).toEqual(journal);
        expect(await rows()).toEqual(once);
        failure.mockRestore();
        expect(await compactor.recover()).toBe(applied);
        expect(await rows()).toEqual(once);
        expect(completed).toHaveBeenCalledTimes(applied ? 1 : 0);
        expect(await journalStore.read()).toBeNull();
        expect(await compactor.recover()).toBe(false);
      }
    );
  }

  it("clears explicit reset intent despite contention on the history lock", async () => {
    const { dependencies, journalStore } = await activateJournaledSwap();
    streaming = false;
    live = undefined;
    const held = await fileLock.acquireProcessFileLock({
      lockPath: historyWriteLockPath(store.config.rootDir, workspaceId),
      timeoutMs: 1000,
      label: "foreign history writer",
    });
    // Exercise the actual lock timeout branch without waiting ten seconds.
    const acquire = fileLock.acquireProcessFileLock;
    const timeout = spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) =>
      acquire({ ...options, timeoutMs: 0 })
    );
    let clearing = Promise.resolve();
    const clear = journalStore.clearForReset.bind(journalStore);
    const observed = spyOn(journalStore, "clearForReset").mockImplementation(() => {
      clearing = clear();
      return clearing;
    });
    try {
      compactor.reset("user-interrupt");
      await clearing.catch(() => undefined);
      expect(await stat(journalStore.path).catch((error: unknown) => error)).toHaveProperty(
        "code",
        "ENOENT"
      );
    } finally {
      await held[Symbol.asyncDispose]();
      timeout.mockRestore();
      observed.mockRestore();
    }
    compactor = new ContinuousCompactor({
      ...dependencies,
      historyService: new HistoryService(store.config),
    });
    expect(await compactor.recover()).toBe(false);
    expect((await rows())[0].id).toBe("old-user");
  });

  it.each(["failed-fast-apply", "legacy-fallback", "delete-message", "dispose"])(
    "%s only cleans its captured journal",
    async (reason) => {
      const { journalStore, journal, swap } = await activateJournaledSwap();
      const foreign = new HistoryService(store.config).getContinuousCompactionJournal(workspaceId);
      await foreign.clear(journal);
      const successor = {
        ...journal,
        boundary: { ...journal.boundary, id: "foreign-successor" },
      };
      expect(await foreign.write(successor, swap.prefix, () => true)).not.toBeNull();
      compactor.reset(reason);
      expect((await journalStore.read())?.boundary.id).toBe(successor.boundary.id);
    }
  );

  it("uses P1 durable fallback when the first retained live step has no tool anchor", async () => {
    await seedLiveTurn(true, true);
    const deps = Reflect.get(compactor, "deps") as Dependencies;
    const setSwap = mock(() => true);
    deps.streamManager.setPrefixSwap = setSwap;
    deps.prepareSwap = () =>
      Promise.resolve({
        preparation: {
          modelString: context.model,
          providerForMessages: "anthropic",
          effectiveAgentId: "exec",
          effectiveThinkingLevel: "off",
          toolNamesForSentinel: ["bash"],
        },
        attachments: [],
        systemPrefix: [],
        cacheEnabled: true,
      });
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(
      await compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" })
    ).toBe("applied");
    expect(fastApply).toHaveBeenCalledTimes(1);
    expect(setSwap).not.toHaveBeenCalled();
    const current = await rows();
    expect(JSON.stringify(current.slice(1))).not.toContain("committed investigation");
    expect(JSON.stringify(current.slice(1))).toContain("committed-tool");
    expect(current[0].metadata?.compactionBoundary).toBe(true);
  });

  it("seamlessly rebuilds an internal committed cut as static prefix context and anchors the live step", async () => {
    const { answer, journal, journalStore } = await activateJournaledSwap(true, true, true);
    expect(journal.headEnd.id).toBe("committed-tail");
    expect(journal.headPartIndex).toBe(2);
    expect(journal.liveTailCopySpec.partIndex).toBe(0);
    expect(journal.firstTailToolCallId).toBe("tail-tool");
    expect(journal.prefixSourceRows).toEqual([journal.boundary, ...journal.staticCopies]);
    const retainedAssistant = journal.staticCopies.find((row) => row.role === "assistant");
    expect(retainedAssistant?.metadata?.partial).toBe(true);
    expect(journal.liveTailCopySpec.metadataTemplate?.partial).toBeUndefined();
    expect(JSON.stringify(journal.prefix)).not.toContain("old-committed-tool");
    expect(JSON.stringify(journal.prefix)).toContain("committed-tool");
    expect(fastApply).not.toHaveBeenCalled();
    assert(live, "Live fixture missing");
    answer.parts = [...live.parts, { type: "text", text: "work after static prefix swap" }];
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    expect(await compactor.observe(0, context)).toBe("applied");
    const current = await rows();
    expect(current[0].id).toBe(journal.boundary.id);
    expect(current.slice(1, -1).map((row) => row.parts)).toEqual(
      journal.staticCopies.map((row) => row.parts)
    );
    expect(current.at(-1)?.parts).toEqual(answer.parts);
    expect(await journalStore.read()).toBeNull();
  });

  it("retains a consumed journal after failed disabled finalization so the next attempt can fold it", async () => {
    const { answer, journal, journalStore } = await activateJournaledSwap();
    assert(live, "Live fixture missing");
    answer.parts = live.parts;
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    spyOn(store.historyService, "persistBoundaryWithTailCopies").mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "transient write failure" })
    );
    const disabled = { ...context, enabled: false, thresholdPercent: 100 };
    expect(await compactor.observe(0, disabled)).toBe("none");
    compactor.reset("disabled");
    expect(await journalStore.read()).not.toBeNull();
    expect(await compactor.observe(0, disabled)).toBe("applied");
    expect((await rows())[0].id).toBe(journal.boundary.id);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("settings changes during finalization cannot invalidate a consumed journal's durable fold", async () => {
    const { answer, journal } = await activateJournaledSwap();
    assert(live, "Live fixture missing");
    answer.parts = live.parts;
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    const entered = deferred();
    const release = deferred();
    const original = handler.withContinuousPendingState.bind(handler);
    spyOn(handler, "withContinuousPendingState").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const finalizing = compactor.observe(0, { ...context, enabled: false });
    await entered.promise;
    compactor.reset("disabled");
    compactor.reset("threshold-changed");
    release.resolve();
    expect(await finalizing).toBe("applied");
    expect((await rows())[0].id).toBe(journal.boundary.id);
  });

  it("stays seamless and finalizes a consumed swap despite lowered usage, preserving new parts", async () => {
    const { answer, journal, journalStore } = await activateJournaledSwap();
    expect(await compactor.observe(1, { ...context, phase: "mid-stream" })).toBe("none");
    expect(summarize).toHaveBeenCalledTimes(1);
    assert(live, "Live fixture missing");
    answer.parts = [...live.parts, { type: "text", text: "generated after swapping" }];
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    expect(await compactor.observe(forcePercent, { ...context, phase: "mid-stream" })).toBe("none");
    expect(fastApply).not.toHaveBeenCalled();
    expect(await compactor.observe(1, context)).toBe("applied");
    const history = await rows();
    expect(history[0].id).toBe(journal.boundary.id);
    expect(history.at(-1)?.id).toBe(journal.liveTailCopySpec.copyId);
    expect(history.at(-1)?.parts).toEqual(answer.parts.slice(journal.liveTailCopySpec.partIndex));
    expect(history.at(-1)?.metadata?.usage).toBeUndefined();
    expect(await journalStore.read()).toBeNull();
    expect(fastApply).not.toHaveBeenCalled();
  });

  it("recovers growing crash partials verbatim and retries recovery idempotently after boundary persistence", async () => {
    const { answer, journal, journalStore, dependencies } = await activateJournaledSwap();
    assert(live, "Live fixture missing");
    answer.parts = [...live.parts, { type: "text", text: "crash-time growth" }];
    await store.historyService.writePartial(workspaceId, answer);
    compactor.reset("disabled");
    streaming = false;
    live = undefined;
    compactor = new ContinuousCompactor(dependencies);
    // Settings hydrate before startup recovery, including an experiment disabled since the crash.
    compactor.reset("threshold-changed");
    compactor.reset("disabled");
    expect(await compactor.recover()).toBe(true);
    const once = await rows();
    expect(once.at(-1)?.parts).toEqual(answer.parts.slice(journal.liveTailCopySpec.partIndex));
    expect(once.at(-1)?.metadata?.partial).toBe(true);
    expect(
      once[0].metadata?.muxMetadata?.type === "compaction-summary" &&
        once[0].metadata.muxMetadata.pendingFollowUp
    ).toBeUndefined();
    // Simulate the crash window after atomic history persistence but before journal unlink.
    await writeFile(journalStore.path, JSON.stringify(journal));
    expect(await compactor.recover()).toBe(true);
    expect(await rows()).toEqual(once);
    expect(await journalStore.read()).toBeNull();
  });

  for (const corruption of [
    "invalid-json",
    "wrong-sequence",
    "edited-head",
    "missing-row",
    "abandoned",
  ] as const) {
    it(`discards ${corruption} journals without losing source history`, async () => {
      const { journal, journalStore, dependencies } = await activateJournaledSwap();
      streaming = false;
      live = undefined;
      if (corruption === "invalid-json") await writeFile(journalStore.path, "{");
      if (corruption === "wrong-sequence")
        await writeFile(
          journalStore.path,
          JSON.stringify({ ...journal, streamHistorySequence: 900 })
        );
      if (corruption === "edited-head")
        await writeFile(
          journalStore.path,
          JSON.stringify({ ...journal, headFingerprint: "different" })
        );
      if (corruption === "missing-row")
        await writeFile(
          journalStore.path,
          JSON.stringify({
            ...journal,
            liveTailCopySpec: { ...journal.liveTailCopySpec, sourceMessageId: "missing" },
          })
        );
      if (corruption === "abandoned") compactor.reset("user-interrupt");
      compactor = new ContinuousCompactor(dependencies);
      expect(await compactor.recover()).toBe(false);
      expect((await rows())[0].id).toBe("old-user");
      expect(await journalStore.read()).toBeNull();
    });
  }

  it("a cut before a committed row preserves every later static row and the entire growing live answer", async () => {
    const { answer, journal, dependencies } = await activateJournaledSwap(true);
    expect(journal.liveTailCopySpec.partIndex).toBe(0);
    expect(journal.firstTailToolCallId).toBe("tail-tool");
    expect(
      journal.staticCopies.some((row) =>
        row.parts.some(
          (part) => part.type === "dynamic-tool" && part.toolCallId === "committed-tool"
        )
      )
    ).toBe(true);
    assert(live, "Live fixture missing");
    answer.parts = [...live.parts, { type: "text", text: "latest work" }];
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    compactor = new ContinuousCompactor(dependencies);
    const results = await Promise.all([compactor.recover(), compactor.recover()]);
    expect(results).toEqual([true, true]);
    const history = await rows();
    expect(history.slice(1, -1).map((row) => row.parts)).toEqual(
      journal.staticCopies.map((row) => row.parts)
    );
    expect(history.at(-1)?.parts).toEqual(answer.parts);
    expect(history.filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
  });

  it("reset during journal apply cannot append a boundary", async () => {
    const { answer, dependencies } = await activateJournaledSwap();
    assert(live, "Live fixture missing");
    answer.parts = live.parts;
    await store.historyService.writePartial(workspaceId, answer);
    streaming = false;
    live = undefined;
    compactor = new ContinuousCompactor(dependencies);
    const entered = deferred();
    const release = deferred();
    const original = handler.withContinuousPendingState.bind(handler);
    spyOn(handler, "withContinuousPendingState").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const recovered = compactor.recover();
    await entered.promise;
    compactor.reset("edit");
    release.resolve();
    expect(await recovered).toBe(false);
    expect((await rows())[0].id).toBe("old-user");
  });

  it("copies a sliced live tail including post-snapshot fast-stop growth and the pending follow-up", async () => {
    const answer = await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    const summarizedAnswer = summarize.mock.calls[0][0].find((row) => row.id === answer.id);
    assert(summarizedAnswer, "The earlier completed step should be in the summarized head");
    expect(summarizedAnswer.parts).toEqual(answer.parts.slice(0, 1));
    const followUp: CompactionFollowUpRequest = {
      text: "Continue verification",
      model: context.model,
      agentId: "exec",
      thinkingLevel: "high",
    };
    const afterSnapshot = { type: "text" as const, text: "Finished while stopping the stream" };
    fastApply.mockImplementation(async (apply) => {
      const partial = { ...answer, parts: [...answer.parts, afterSnapshot] };
      expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
      expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
      streaming = false;
      live = undefined;
      return apply(followUp);
    });
    expect(
      await compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" })
    ).toBe("applied");
    expect(await store.historyService.readPartial(workspaceId)).toBeNull();
    const persisted = await rows();
    const boundary = persisted[0];
    expect(boundary.metadata?.muxMetadata).toMatchObject({
      strategy: "continuous",
      pendingFollowUp: followUp,
    });
    expect(persisted[1].role).toBe("user");
    expect(persisted[1].parts).toMatchObject([
      { type: "text", text: "Implement and verify the fix" },
    ]);
    const copy = persisted.find((row) => row.role === "assistant" && row.id !== boundary.id);
    assert(copy, "Expected the sliced assistant tail");
    expect(copy.id).not.toBe(answer.id);
    expect(copy.parts).toEqual([...answer.parts.slice(1), afterSnapshot]);
    expect(copy.metadata).toMatchObject({
      synthetic: true,
      uiVisible: true,
      rlmPreservedTailCopy: true,
      stepStartPartIndices: [0, 1],
    });
    expect(copy.metadata?.partial).toBeUndefined();
    expect(copy.metadata?.usage).toBeUndefined();
    expect(copy.metadata?.contextUsage).toBeUndefined();
    expect(copy.metadata?.compactionBoundary).toBeUndefined();
    const expectedInput =
      context.systemMessageTokens! +
      context.attachmentTokens! +
      persisted.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
    expect(boundary.metadata?.contextUsage?.inputTokens).toBe(expectedInput);
    expect(boundary.metadata?.contextUsage?.inputTokens).toBeGreaterThan(
      estimateMuxMessageTokens(boundary) + context.systemMessageTokens! + context.attachmentTokens!
    );
    expect(boundary.metadata?.usage).toBeUndefined();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("preserves the interrupted marker when a user-stopped committed partial folds without Continue", async () => {
    const answer = await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect((await store.historyService.writePartial(workspaceId, answer)).success).toBe(true);
    expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
    live = undefined;
    streaming = false;
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    const persisted = await rows();
    expect(persisted.at(-1)?.metadata?.partial).toBe(true);
    expect(persisted[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
  });

  it("uses finish-step's completed end even before the next start-step arrives", async () => {
    const answer = await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.parts = live.parts.slice(0, 2);
    live.stepStartIndices = [0, 1];
    live.currentStepStartIndex = 2;
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    const head = summarize.mock.calls[0][0];
    const summarizedAnswer = head.find((row) => row.id === answer.id);
    assert(summarizedAnswer, "The earlier completed step should be in the summarized head");
    expect(summarizedAnswer.parts).toEqual(answer.parts.slice(0, 1));
    expect(head.flatMap((row) => row.parts)).not.toContainEqual(answer.parts[1]);
  });

  it("counts actual post-compaction attachments before starting a live summary", async () => {
    await seedLiveTurn();
    estimateAttachments.mockResolvedValue(context.contextWindowTokens);
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(estimateAttachments).toHaveBeenCalledTimes(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(await compactor.observe(forcePercent, { ...context, phase: "mid-stream" })).toBe(
      "fallback"
    );
    const job = eagerJob(compactor);
    jobs.push(job);
    await job;
    expect(fastApply).not.toHaveBeenCalled();
  });

  it("retains the complete live assistant when its first exact step is the cut", async () => {
    const answer = await seedLiveTurn();
    const seeded = await rows();
    const old = seeded.find((row) => row.id === "old-answer")!;
    old.parts = [{ type: "text", text: "x".repeat(28_000) }];
    expect((await store.historyService.updateHistory(workspaceId, old)).success).toBe(true);
    const prompt = seeded.find((row) => row.id === "live-user")!;
    prompt.parts = [{ type: "text", text: "y".repeat(8_000) }];
    expect((await store.historyService.updateHistory(workspaceId, prompt)).success).toBe(true);
    assert(live, "Expected an active stream");
    live.parts = [{ type: "text", text: "one completed step" }];
    live.stepStartIndices = [0];
    live.currentStepStartIndex = 1;
    const updated = {
      ...answer,
      parts: live.parts,
      metadata: { ...answer.metadata, stepStartPartIndices: [0] },
    };
    expect((await store.historyService.updateHistory(workspaceId, updated)).success).toBe(true);
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(
      await compactor.observe(context.thresholdPercent, { ...context, phase: "mid-stream" })
    ).toBe("applied");
    expect((await rows()).at(-1)?.parts).toEqual(updated.parts);
  });

  it("does not stop a live stream when the staged tail has already outgrown the force budget", async () => {
    await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    assert(live, "Expected an active stream");
    live.parts.push({ type: "text", text: "x".repeat(context.contextWindowTokens * 4) });
    summarize.mockResolvedValue(null);
    expect(await compactor.observe(forcePercent, { ...context, phase: "mid-stream" })).toBe(
      "fallback"
    );
    const job = eagerJob(compactor);
    jobs.push(job);
    await job;
    expect(fastApply).not.toHaveBeenCalled();
    expect(streaming).toBe(true);
  });

  it("waits for the first completed live step instead of summarizing an unfinished turn", async () => {
    await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.stepStartIndices = [0];
    live.currentStepStartIndex = 0;
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it("does not summarize when even the mandatory live tail is too large", async () => {
    const answer = await seedLiveTurn();
    assert(live, "Expected an active stream snapshot");
    live.parts[1] = { type: "text", text: "mandatory completed step ".repeat(25_000) };
    answer.parts = structuredClone(live.parts);
    expect((await store.historyService.updateHistory(workspaceId, answer)).success).toBe(true);
    const { verdict, job } = await start(forcePercent, { ...context, phase: "mid-stream" });
    await job;
    expect(verdict).toBe("fallback");
    expect(summarize).not.toHaveBeenCalled();
    expect(fastApply).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it("skips applying when fast-stop growth makes the retained tail exceed the force budget", async () => {
    const answer = await seedLiveTurn();
    await (
      await start(eagerPercent, { ...context, phase: "mid-stream" })
    ).job;
    expect(summarize).toHaveBeenCalledTimes(1);
    fastApply.mockImplementation(async (apply) => {
      const partial = {
        ...answer,
        parts: [
          ...answer.parts,
          { type: "text" as const, text: "unbounded late tool result ".repeat(25_000) },
        ],
      };
      expect((await store.historyService.writePartial(workspaceId, partial)).success).toBe(true);
      expect((await store.historyService.commitPartial(workspaceId)).success).toBe(true);
      streaming = false;
      live = undefined;
      return apply();
    });
    summarize.mockResolvedValue(null);
    const { verdict, job } = await start(forcePercent, { ...context, phase: "mid-stream" });
    expect(verdict).toBe("fallback");
    await job;
    expect(completed).not.toHaveBeenCalled();
    expect((await rows()).some((row) => row.metadata?.compactionBoundary)).toBe(false);
  });

  it("applies a no-tail summary when there is no safe recent suffix", async () => {
    await seed(
      createMuxMessage("only-answer", "assistant", "earlier investigation ".repeat(4_000))
    );
    await stage();
    expect(await compactor.observe(context.thresholdPercent, context)).toBe("applied");
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metadata?.compactionBoundary).toBe(true);
    expect(persisted[0].parts).toMatchObject([{ type: "text", text: summary.text }]);
    expect(completed.mock.calls[0][0]).toMatchObject({ preservedTailMessageCount: 0 });
  });

  it("requests full-compaction fallback at the force threshold when no summary is ready", async () => {
    await seedConversation();
    const release = deferred();
    summarize.mockImplementation(async () => {
      await release.promise;
      return summary;
    });
    const { verdict, job } = await start(forcePercent);
    expect(verdict).toBe("fallback");
    expect(completed).not.toHaveBeenCalled();
    release.resolve();
    await job;
  });
});
