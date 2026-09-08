import { z } from "zod";
import { assemblePromptPayload } from "./turnContextAssembler";
import type { ActiveTurnThinkingOverride } from "./thinkingOverride";
import { prepareMessagesForProvider } from "./messagePipeline";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ai from "ai";
import * as atomicWrite from "write-file-atomic";
import { promises as journalFs } from "node:fs";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import * as path from "node:path";
import { HistoryService } from "./historyService";
import { historyWriteLockPath, removeSessionDirUnderMemoryLocks } from "./workspaceRemoval";
import { createAnthropic } from "@ai-sdk/anthropic";
import { readFile, writeFile } from "node:fs/promises";
import assert from "@/common/utils/assert";
import { createMuxMessage } from "@/common/types/message";
import {
  ContinuousCompactionJournalSchema,
  type ContinuousCompactionJournal,
} from "@/common/orpc/schemas/continuousCompaction";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import {
  exactJson,
  stripMessageCacheControl,
  rebuildContinuousPrefix,
  type ContinuousPrefixSwap,
} from "./continuousCompactionJournal";

const workspaceId = "swap-tests";
const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };
const originalMessages: ai.ModelMessage[] = [
  { role: "system", content: "system", providerOptions: cache },
  { role: "user", content: "old prompt" },
  { role: "assistant", content: [{ type: "text", text: "old output" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "keep",
        toolName: "bash",
        input: {},
        providerOptions: cache,
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "keep",
        toolName: "bash",
        output: { type: "text", value: "kept output" },
        providerOptions: cache,
      },
    ],
  },
];

function journalFixture(): ContinuousCompactionJournal {
  const boundary = createMuxMessage("summary", "assistant", "summary", {
    compactionBoundary: true,
    compactionEpoch: 1,
    compacted: "user",
    muxMetadata: { type: "compaction-summary", strategy: "continuous" },
  });
  return {
    version: 1,
    boundary,
    staticCopies: [],
    liveTailCopySpec: {
      sourceMessageId: "live",
      sourceHistorySequence: 1,
      copyId: "copy",
      partIndex: 1,
      metadataTemplate: { synthetic: true, rlmPreservedTailCopy: true },
    },
    postCompactionAttachments: [],
    prefixSourceRows: [boundary, createMuxMessage("user-copy", "user", "current prompt")],
    systemPrefix: [{ role: "system", content: "system", providerOptions: cache }],
    cacheEnabled: true,
    preparation: {
      modelString: "anthropic:claude-sonnet-4-5",
      providerForMessages: "anthropic",
      effectiveThinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
    },
    providerFamily: "anthropic",
    parentModel: "anthropic:claude-sonnet-4-5",
    summaryModel: "anthropic:claude-sonnet-4-5",
    headFingerprint: "head",
    sourceFingerprint: "source",
    headEnd: { id: "head", sequence: 0 },
    epoch: 0,
    streamMessageId: "live",
    streamHistorySequence: 1,
    stepNumber: 0,
    firstTailToolCallId: "keep",
  };
}

interface Tracker {
  workspaceId: string;
  pendingPrefixSwap?: ContinuousPrefixSwap;
  consumedPrefixSwap?: ContinuousPrefixSwap;
  prefixSwapInvalidated?: boolean;
  latestMessages?: ai.ModelMessage[];
}
type Prepare = NonNullable<Parameters<typeof ai.streamText>[0]["prepareStep"]>;

function prepareHarness(
  manager: StreamManager,
  tracker: Tracker,
  requestOptions: Record<string, unknown> = {}
) {
  const spy = spyOn(ai, "streamText").mockReturnValue({} as ReturnType<typeof ai.streamText>);
  const create = Reflect.get(manager, "createStreamResult") as (
    request: { model: ai.LanguageModel; messages: ai.ModelMessage[] },
    controller: AbortController,
    tracker: Tracker
  ) => unknown;
  const controller = new AbortController();
  create.call(
    manager,
    { model, messages: originalMessages, ...requestOptions },
    controller,
    tracker
  );
  const prepare: Prepare | undefined = spy.mock.calls.at(-1)?.[0].prepareStep;
  assert(prepare, "Expected prepareStep callback");
  return {
    controller,
    run: (messages = originalMessages, stepNumber = 1) =>
      Promise.resolve(
        prepare({
          messages,
          stepNumber,
          model,
          steps: [],
          initialMessages: originalMessages,
          responseMessages: [],
          instructions: undefined,
          initialInstructions: undefined,
          toolsContext: {},
          runtimeContext: {},
        })
      ),
  };
}

describe("continuous prefix prepareStep and journal", () => {
  let history: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    history = await createTestHistoryService();
    await history.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("live", "assistant", "placeholder")
    );
  });
  afterEach(async () => {
    mock.restore();
    await history.cleanup();
  });

  async function setup() {
    const journal = journalFixture();
    const prefix = await rebuildContinuousPrefix(journal, workspaceId);
    const swap: ContinuousPrefixSwap = { journal, prefix, firstTailToolCallId: "keep" };
    const tracker: Tracker = { workspaceId, pendingPrefixSwap: swap };
    const manager = new StreamManager(history.historyService);
    const harness = prepareHarness(manager, tracker);
    const store = history.historyService.getContinuousCompactionJournal(workspaceId);
    return { ...harness, store, tracker, swap, manager };
  }

  it("cannot overwrite or clear a foreign journal revision in the same generation", async () => {
    const { store, swap } = await setup();
    const original = await store.write(swap.journal, swap.prefix, () => true);
    assert(original, "Expected original journal");
    const foreign = new HistoryService(history.config).getContinuousCompactionJournal(workspaceId);
    expect(await foreign.write(swap.journal, swap.prefix, () => true)).toBeNull();
    const successor = await foreign.recordFallbackPrefix(
      original,
      { modelString: "anthropic:fallback", prefix: swap.prefix },
      () => true
    );
    assert(successor, "Expected fallback revision");
    await store.clear(original);
    await store.clear(undefined);
    expect(
      await store.recordFallbackPrefix(
        original,
        { modelString: "anthropic:stale", prefix: swap.prefix },
        () => true
      )
    ).toBeNull();
    const receipt = mock();
    const folded = await history.historyService.persistBoundaryWithTailCopies(
      workspaceId,
      structuredClone(original.boundary),
      [],
      false,
      () => true,
      {
        publication: { generation: original.publicationGeneration, journal: original },
        onCommitted: receipt,
      }
    );
    expect(folded.success).toBe(false);
    expect(receipt).not.toHaveBeenCalled();
    expect(await foreign.read()).toEqual(successor);
    const rows = await history.historyService.getLastMessages(workspaceId, 10);
    assert(rows.success, "Expected history");
    expect(rows.data.map((row) => row.id)).toEqual(["live"]);
    await foreign.clear(successor);
    expect(await store.read()).toBeNull();
  });

  it("captures durable generations across instances without activating destructive resets", async () => {
    const { store, swap } = await setup();
    const foreign = new HistoryService(history.config).getContinuousCompactionJournal(workspaceId);
    const original = await store.write(swap.journal, swap.prefix, () => true);
    assert(original, "Expected legacy journal");
    await foreign.advanceGeneration();
    expect(await store.write(swap.journal, swap.prefix, () => true)).toBeNull();
    expect(
      await store.recordFallbackPrefix(
        original,
        { modelString: "anthropic:stale", prefix: swap.prefix },
        () => true
      )
    ).toBeNull();
    expect(await store.read()).toBeNull();
    const generation = await store.captureGeneration();
    expect(generation).toBeDefined();
    const candidate = { ...swap.journal, publicationGeneration: generation };
    const fresh = await store.write(candidate, swap.prefix, () => true);
    expect(await foreign.read()).toEqual(fresh);
    const failure = spyOn(foreign, "advanceGenerationUnderHistoryLock").mockRejectedValueOnce(
      new Error("generation unavailable")
    );
    expect(await foreign.advanceGeneration().catch((error: unknown) => error)).toEqual(
      new Error("generation unavailable")
    );
    failure.mockRestore();
    expect(await store.captureGeneration()).toBe(generation);
    expect(await store.read()).toEqual(fresh);
  });

  it.each(["initial", "fallback"] as const)(
    "reset fences a queued %s publication even when its caller predicate stays true",
    async (kind) => {
      const { store, swap } = await setup();
      const original =
        kind === "fallback" ? await store.write(swap.journal, swap.prefix, () => true) : null;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const capture = store.captureGenerationUnderHistoryLock.bind(store);
      spyOn(store, "captureGenerationUnderHistoryLock").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return capture();
      });
      const blocking = store.captureGeneration();
      const receipt = mock();
      const writing = original
        ? store.recordFallbackPrefix(
            original,
            { modelString: "anthropic:next", prefix: swap.prefix },
            () => true,
            receipt
          )
        : store.write(swap.journal, swap.prefix, () => true, receipt);
      let resetting: Promise<void> | undefined;
      try {
        await entered.promise;
        resetting = store.clearForReset();
        release.resolve();
        await blocking;
        expect(await writing).toBeNull();
        await resetting;
        expect(receipt).not.toHaveBeenCalled();
        expect(await store.read()).toBeNull();
      } finally {
        release.resolve();
        await Promise.all([blocking, writing, resetting]);
      }
    }
  );

  it.each(["initial", "fallback"] as const)(
    "reset fences an in-flight %s publication through its final rename",
    async (kind) => {
      const { store, swap } = await setup();
      const original =
        kind === "fallback" ? await store.write(swap.journal, swap.prefix, () => true) : null;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atomic = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementationOnce(
        Object.assign(
          async (filename: string, data: string | Buffer) => {
            await atomic(filename, data);
            entered.resolve();
            await release.promise;
          },
          { sync: atomic.sync }
        )
      );
      const receipt = mock();
      const writing = original
        ? store.recordFallbackPrefix(
            original,
            { modelString: "anthropic:next", prefix: swap.prefix },
            () => true,
            receipt
          )
        : store.write(swap.journal, swap.prefix, () => true, receipt);
      let resetting: Promise<void> | undefined;
      try {
        await entered.promise;
        resetting = store.clearForReset();
        release.resolve();
        expect(await writing).toBeNull();
        await resetting;
        expect(receipt).not.toHaveBeenCalled();
        expect(await store.read()).toBeNull();
      } finally {
        release.resolve();
        await Promise.all([writing, resetting]);
      }
    }
  );

  it("publishes a receipt before cleanup and preserves success when cleanup or its observer fails", async () => {
    const { store, swap } = await setup();
    const receipt = mock<(journal: ContinuousCompactionJournal) => void>(() => {
      throw new Error("observer failed");
    });
    let cleanupObserved = false;
    const remove = journalFs.rm;
    spyOn(journalFs, "rm").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${store.path}.continuous-`)) {
        cleanupObserved = true;
        expect(receipt).toHaveBeenCalledTimes(1);
        const persisted = JSON.parse(await readFile(store.path, "utf8")) as unknown;
        expect(persisted).toEqual(receipt.mock.calls[0]?.[0]);
        throw new Error("cleanup unavailable");
      }
      return remove(...args);
    });
    const published = await store.write(swap.journal, swap.prefix, () => true, receipt);
    expect(cleanupObserved).toBe(true);
    expect(published).not.toBeNull();
    expect(await store.read()).toEqual(published);
  });

  it("cleans only the committed initial prefix when ownership changes during staged cleanup", async () => {
    const { store, swap } = await setup();
    let current = true;
    const remove = journalFs.rm;
    spyOn(journalFs, "rm").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${store.path}.continuous-`)) current = false;
      return remove(...args);
    });
    const receipt = mock();
    expect(await store.write(swap.journal, swap.prefix, () => current, receipt)).toBeNull();
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(await store.read()).toBeNull();
  });

  it("cannot recreate a removed workspace through journal capture, publication or cleanup", async () => {
    const { store, swap } = await setup();
    const original = await store.write(swap.journal, swap.prefix, () => true);
    assert(original, "Expected journal");
    const sessionDir = path.dirname(store.path);
    await removeSessionDirUnderMemoryLocks({
      rootDir: history.config.rootDir,
      sessionDir,
      workspaceId,
      attemptId: "journal-removal-test",
    });
    for (const operation of [
      () => store.captureGeneration(),
      () => store.write(original, swap.prefix, () => true),
      () => store.clear(original),
    ])
      expect(await operation().catch((error: unknown) => error)).toHaveProperty(
        "message",
        expect.stringContaining("was removed")
      );
    await store.clear(undefined);
    expect(await journalFs.stat(sessionDir).catch((error: unknown) => error)).toHaveProperty(
      "code",
      "ENOENT"
    );
  });

  it("publishes the history receipt before asynchronous cleanup without reporting a failed commit", async () => {
    const { swap } = await setup();
    const receipt = mock();
    let cleanupObserved = false;
    const remove = journalFs.rm;
    spyOn(journalFs, "rm").mockImplementation(async (...args) => {
      if (String(args[0]).includes("chat.jsonl.continuous-")) {
        cleanupObserved = true;
        expect(receipt).toHaveBeenCalledTimes(1);
        throw new Error("history staging cleanup failed");
      }
      return remove(...args);
    });
    const result = await history.historyService.persistBoundaryWithTailCopies(
      workspaceId,
      structuredClone(swap.journal.boundary),
      [],
      false,
      () => true,
      { publication: { generation: undefined }, onCommitted: receipt }
    );
    expect(cleanupObserved).toBe(true);
    expect(result.success).toBe(true);
    const rows = await history.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(rows.success, "Expected history");
    expect(rows.data.map((row) => row.id)).toEqual([swap.journal.boundary.id]);
  });

  it("waits for a foreign process holding the history lock before admitting a journal write", async () => {
    const { store, swap } = await setup();
    const foreign = {
      ...swap.journal,
      boundary: { ...swap.journal.boundary, id: "foreign-boundary" },
    };
    const script = `
      import { acquireProcessFileLock } from "./src/node/utils/concurrency/fileLock.ts";
      import { writeFile } from "node:fs/promises";
      const [lockPath, journalPath, journal] = process.argv.slice(-3);
      await using lock = await acquireProcessFileLock({ lockPath, timeoutMs: 5000, label: "journal test" });
      process.stdout.write("locked\\n");
      await Bun.stdin.text();
      await writeFile(journalPath, journal);
    `;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        script,
        historyWriteLockPath(history.config.rootDir, workspaceId),
        store.path,
        JSON.stringify(foreign),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    let writing: ReturnType<typeof store.write> | undefined;
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
      reader.releaseLock();
      const entered = Promise.withResolvers<void>();
      const acquire = fileLock.acquireProcessFileLock;
      spyOn(fileLock, "acquireProcessFileLock").mockImplementationOnce((options) => {
        entered.resolve();
        return acquire(options);
      });
      writing = store.write(swap.journal, swap.prefix, () => true);
      await entered.promise;
      await child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await writing).toBeNull();
      expect(await store.read()).toEqual(foreign);
    } finally {
      child.kill();
      await child.exited;
      await writing;
    }
  });

  it("journals before returning, swaps once by content identity, and strips retained cache markers", async () => {
    const { run, tracker, store, swap } = await setup();
    const result = await run();
    assert(result?.messages, "Expected swapped messages");
    const persisted = ContinuousCompactionJournalSchema.parse(
      JSON.parse(await readFile(store.path, "utf8"))
    );
    expect(persisted.stepNumber).toBe(1);
    expect(persisted.prefix).toEqual(swap.prefix.map(exactJson));
    expect(result.messages.slice(0, swap.prefix.length)).toEqual(swap.prefix);
    expect(JSON.stringify(result.messages)).not.toContain("old output");
    expect(JSON.stringify(result.messages)).toContain("kept output");
    // System + prefix are the two message breakpoints; tools supply the third.
    expect(JSON.stringify(result.messages).match(/cacheControl/g)?.length).toBe(2);
    expect(tracker.latestMessages).toBe(result.messages);
    expect(tracker.pendingPrefixSwap).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBe(swap);
    expect(swap.consumed).toBe(true);
    const write = spyOn(store, "write");
    expect(await run(result.messages, 2)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(tracker.latestMessages).toEqual(result.messages);
  });

  for (const tail of [[], originalMessages.slice(4)]) {
    it("drops a missing/non-assistant locator without slicing or writing", async () => {
      const { run, tracker, store } = await setup();
      expect(await run(tail)).toBeUndefined();
      expect(tracker.latestMessages).toBe(tail);
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(tracker.consumedPrefixSwap).toBeUndefined();
      expect(await store.read()).toBeNull();
    });
  }

  it("drops a pending swap when thinking options change before the first prepared step", async () => {
    const { manager, tracker, store } = await setup();
    const { run } = prepareHarness(manager, tracker, { thinkingOverrideState: { pending: "off" } });
    expect(await run(originalMessages, 0)).toBeUndefined();
    expect(tracker.pendingPrefixSwap).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(tracker.latestMessages).toBe(originalMessages);
    expect(await store.read()).toBeNull();
  });

  it.each(["historical", "live-steps", "same-message"] as const)(
    "declines ambiguous %s anchors before journaling",
    async (mode) => {
      const { run, store, tracker } = await setup();
      const duplicate: ai.AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "keep", toolName: "bash", input: { step: "duplicate" } },
        ],
      };
      assert(Array.isArray(duplicate.content), "Duplicate fixture requires content parts");
      const messages: ai.ModelMessage[] =
        mode === "same-message"
          ? [{ role: "assistant", content: [...duplicate.content, ...duplicate.content] }]
          : [
              ...originalMessages,
              ...(mode === "historical" ? [{ role: "user" as const, content: "Next turn" }] : []),
              duplicate,
              originalMessages[4],
            ];
      const write = spyOn(store, "write");
      expect(await run(messages)).toBeUndefined();
      expect(tracker.latestMessages).toEqual(messages);
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(tracker.consumedPrefixSwap).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      expect(await store.read()).toBeNull();
    }
  );

  it("rebuilds a flattened committed step cut in the prefix and swaps at the live anchor", async () => {
    const { run, tracker, store, swap } = await setup();
    const committed = createMuxMessage("committed", "assistant", "", {
      stepStartPartIndices: [0, 2],
    });
    committed.parts = [
      { type: "text", text: "summarized head must not return" },
      {
        type: "dynamic-tool",
        toolCallId: "old-call",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { success: true },
      },
      {
        type: "dynamic-tool",
        toolCallId: "static-keep",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { success: true },
      },
    ];
    swap.journal.headEnd = { id: committed.id, sequence: 0 };
    swap.journal.headPartIndex = 2;
    swap.journal.liveTailCopySpec.partIndex = 0;
    const liveUser = createMuxMessage("live-user", "user", "continue");
    const live = createMuxMessage("live", "assistant", "", { stepStartPartIndices: [0] });
    live.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "keep",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { success: true },
      },
    ];
    swap.journal.staticCopies = [
      {
        ...committed,
        id: "static-copy",
        parts: committed.parts.slice(2),
        metadata: { synthetic: true, rlmPreservedTailCopy: true, stepStartPartIndices: [0] },
      },
      { ...liveUser, id: "live-user-copy" },
    ];
    swap.journal.prefixSourceRows = [swap.journal.boundary, ...swap.journal.staticCopies];
    swap.prefix = await rebuildContinuousPrefix(swap.journal, workspaceId);
    const messages = await prepareMessagesForProvider({
      ...swap.journal.preparation,
      workspaceId,
      messagesWithSentinel: [
        createMuxMessage("user", "user", "request"),
        committed,
        liveUser,
        live,
      ],
    });
    const assistant = messages.find(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes('"toolCallId":"static-keep"')
    );
    expect(JSON.stringify(assistant)).toContain("summarized head must not return");
    const result = await run(messages);
    assert(result?.messages, "Expected a seamless swap at the live anchor");
    expect(JSON.stringify(result.messages)).not.toContain("summarized head must not return");
    const calls = result.messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))
        : []
    );
    expect(calls).toEqual(["static-keep", "keep"]);
    expect(tracker.consumedPrefixSwap).toBe(swap);
    expect((await store.read())?.prefixSourceRows).toEqual(swap.journal.prefixSourceRows);
  });

  it.each(["during-write", "after-write"] as const)(
    "thinking change %s rejects the old prefix and still rebuilds step zero",
    async (phase) => {
      const { manager, tracker, store, swap } = await setup();
      swap.journal.preparation.effectiveThinkingLevel = "high";
      swap.prefix = await rebuildContinuousPrefix(swap.journal, workspaceId);
      const state: ActiveTurnThinkingOverride = { applied: "high" };
      const providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } };
      const rebuilt = mock(() => Promise.resolve(originalMessages));
      const { run } = prepareHarness(manager, tracker, {
        thinkingOverrideState: state,
        providerOptions,
        rebuildProviderOptionsForThinkingLevel: () => ({
          effectiveLevel: "off",
          providerOptions: { anthropic: { thinking: { type: "disabled" } } },
        }),
        rebuildFirstStepForThinkingLevel: rebuilt,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const enteredWrite = new Promise<void>((resolve) => {
        entered = resolve;
      });
      if (phase === "during-write") {
        const atomic = atomicWrite.default;
        spyOn(atomicWrite, "default").mockImplementationOnce(
          Object.assign(
            async (filename: string, data: string | Buffer) => {
              await atomic(filename, data);
              entered();
              await gate;
            },
            { sync: atomic.sync }
          )
        );
      } else {
        const write = store.write.bind(store);
        spyOn(store, "write").mockImplementationOnce(async (...args) => {
          const journal = await write(...args);
          state.pending = "off";
          return journal;
        });
      }
      const preparing = run(originalMessages, 0);
      if (phase === "during-write") {
        await enteredWrite;
        state.pending = "off";
        release();
      }
      const result = await preparing;
      expect(tracker.consumedPrefixSwap).toBeUndefined();
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(await store.read()).toBeNull();
      expect(rebuilt).toHaveBeenCalledTimes(1);
      expect(result?.messages).toEqual(originalMessages);
      expect(result?.providerOptions).toEqual({ anthropic: { thinking: { type: "disabled" } } });
    }
  );

  it("rejects a prefix whose prepared thinking level is stale at activation or consumption", async () => {
    const { manager, tracker, store, swap } = await setup();
    swap.journal.preparation.effectiveThinkingLevel = "high";
    const streams = Reflect.get(manager, "workspaceStreams") as Map<string, unknown>;
    streams.set(workspaceId, {
      messageId: swap.journal.streamMessageId,
      model: swap.journal.parentModel,
      thinkingLevel: "off",
      stepTracker: {},
    });
    expect(manager.setPrefixSwap(workspaceId, swap)).toBe(false);
    const { run } = prepareHarness(manager, tracker, { thinkingOverrideState: { applied: "off" } });
    expect(await run()).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it.each(["off", "high"] as const)(
    "prefix replay uses normal provider filtering and interrupted context under %s thinking",
    async (thinking) => {
      const journal = journalFixture();
      journal.preparation.effectiveThinkingLevel = thinking;
      const interrupted = createMuxMessage("interrupted", "assistant", "Interrupted answer", {
        partial: true,
      });
      const display = createMuxMessage("workflow-display", "user", "UI-only workflow content", {
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/flow",
          commandPrefix: "/flow",
          runId: "wfr_test",
        },
      });
      const reasoning = createMuxMessage("reasoning-only", "assistant", "", { partial: true });
      reasoning.parts = [{ type: "reasoning", text: "old reasoning" }];
      journal.prefixSourceRows = [
        journal.boundary,
        interrupted,
        display,
        reasoning,
        createMuxMessage("next-assistant", "assistant", "Later answer"),
      ];
      const expected = await assemblePromptPayload({
        ...journal.preparation,
        workspaceId,
        history: journal.prefixSourceRows,
        systemMessage: "",
        postCompactionAttachments: journal.postCompactionAttachments,
      });
      const actual = (await rebuildContinuousPrefix(journal, workspaceId)).filter(
        (message) => message.role !== "system"
      );
      expect(actual).toEqual(expected.messages.filter((message) => message.role !== "system"));
      expect(JSON.stringify(actual)).not.toContain("UI-only workflow content");
    }
  );

  it("does not return a swap when atomic journal persistence fails", async () => {
    const { run, tracker, store } = await setup();
    spyOn(atomicWrite, "default").mockImplementationOnce(
      Object.assign(() => Promise.reject(new Error("disk full")), {
        sync: atomicWrite.default.sync,
      })
    );
    expect(await run()).toBeUndefined();
    expect(tracker.latestMessages).toBe(originalMessages);
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it.each(["reset-before-write", "abort-after-write"] as const)(
    "%s fences the swap return and deletes the stale journal",
    async (mode) => {
      const { run, tracker, store, controller } = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementationOnce(
        Object.assign(
          async (filename: string, data: string | Buffer) => {
            if (mode === "abort-after-write") await original(filename, data);
            entered();
            await gate;
            if (mode === "reset-before-write") await original(filename, data);
          },
          { sync: original.sync }
        )
      );
      const preparing = run();
      await started;
      let cleared = Promise.resolve();
      if (mode === "reset-before-write") {
        tracker.pendingPrefixSwap = undefined;
        cleared = store.clearForReset();
      } else {
        controller.abort();
      }
      release();
      expect(await preparing).toBeUndefined();
      await cleared;
      expect(await store.read()).toBeNull();
      expect(tracker.consumedPrefixSwap).toBeUndefined();
    }
  );

  it("rejects lossy options rather than silently JSON-dropping them", async () => {
    const { run, tracker, swap, store } = await setup();
    // A request-affecting function is intentionally outside the SDK's JSON option contract.
    Reflect.set(swap.prefix[0], "unknownRequestField", () => "must not disappear");
    expect(await run()).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it("rebuilds unrepresentable wire from pinned source rows and actual attachments", async () => {
    const journal = journalFixture();
    journal.prefixSourceRows.push({
      id: "file",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: "https://example.com/image.png" }],
    });
    const prefix = await rebuildContinuousPrefix(journal, workspaceId);
    const store = history.historyService.getContinuousCompactionJournal(workspaceId);
    const persisted = await store.write(journal, prefix, () => true);
    assert(persisted, "Source pipeline must reproduce its own prefix");
    expect(persisted.prefix).toBeUndefined();
    expect(await rebuildContinuousPrefix(persisted, workspaceId)).toEqual(prefix);
    expect(await store.read()).toEqual(persisted);
  });

  for (const consumed of [false, true]) {
    it(`step-boundary retry ${consumed ? "retains the consumed view" : "discards a pending swap"}`, async () => {
      const { tracker, manager, swap, run, store } = await setup();
      if (consumed) await run();
      const before = tracker.latestMessages;
      const stream = {
        stepTracker: tracker,
        parts: [{ type: "text", text: "completed" }],
        stepStartIndices: [0],
        currentStepStartIndex: 1,
        partialWritePromise: undefined,
      };
      const reset = Reflect.get(manager, "resetStreamStateForRetry") as (
        id: string,
        info: unknown,
        options: { preserveParts: boolean }
      ) => Promise<void>;
      await reset.call(manager, workspaceId, stream, { preserveParts: true });
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(tracker.consumedPrefixSwap).toBe(consumed ? swap : undefined);
      expect(tracker.latestMessages).toBe(before);
      expect((await store.read()) !== null).toBe(consumed);
    });
  }

  for (const family of ["anthropic", "openai"]) {
    for (const mode of [
      "pending",
      "whole-row",
      "static-cut",
      "sliced-row",
      "journal-failure",
      "ambiguous-anchor",
    ] as const) {
      const consumed = mode !== "pending";
      const sliced = mode === "sliced-row";
      it(`${family} fallback ${mode} preserves the correct view and emits only after reset`, async () => {
        const { tracker, manager, run, swap, store } = await setup();
        if (sliced) {
          swap.journal.headEnd = { id: "live", sequence: 1 };
          swap.journal.headPartIndex = 2;
          swap.journal.liveTailCopySpec.partIndex = 2;
        } else {
          swap.journal.liveTailCopySpec.partIndex = 0;
        }
        const committed =
          mode === "static-cut"
            ? createMuxMessage("committed", "assistant", "", { stepStartPartIndices: [0, 1] })
            : undefined;
        if (committed) {
          committed.parts = [
            {
              type: "dynamic-tool",
              toolCallId: "discard-static",
              toolName: "bash",
              state: "output-available",
              input: {},
              output: { success: true },
            },
            {
              type: "dynamic-tool",
              toolCallId: "keep-static",
              toolName: "bash",
              state: "output-available",
              input: {},
              output: { success: true },
            },
          ];
          swap.journal.headEnd = { id: committed.id, sequence: 0 };
          swap.journal.headPartIndex = 1;
          const userCopy = swap.journal.prefixSourceRows[1];
          swap.journal.staticCopies = [
            {
              ...committed,
              id: "static-copy",
              parts: committed.parts.slice(1),
              metadata: { synthetic: true, rlmPreservedTailCopy: true, stepStartPartIndices: [0] },
            },
            userCopy,
          ];
          swap.journal.prefixSourceRows = [swap.journal.boundary, ...swap.journal.staticCopies];
          swap.prefix = await rebuildContinuousPrefix(swap.journal, workspaceId);
        }
        if (consumed) await run();
        const controller = new AbortController();
        const nextModel = `${family}:fallback-model`;
        let resetFinished = false;
        const events: string[] = [];
        manager.setEventSink((event) => {
          expect(resetFinished).toBe(true);
          events.push(event.type);
          controller.abort();
        });
        const rebuilt = createMuxMessage("live", "assistant", "", {
          stepStartPartIndices: sliced ? [0, 2] : [0],
        });
        rebuilt.parts = [
          ...(sliced
            ? [
                { type: "text" as const, text: "summarized live head" },
                {
                  type: "dynamic-tool" as const,
                  toolCallId: "head-call",
                  toolName: "bash",
                  state: "output-available" as const,
                  input: {},
                  output: { success: true },
                },
              ]
            : []),
          ...(!sliced ? [{ type: "text" as const, text: "retained step" }] : []),
          {
            type: "dynamic-tool",
            toolCallId: "keep",
            toolName: "bash",
            state: "output-available",
            input: {},
            output: { success: true },
          },
          { type: "text", text: "refused response after swap" },
        ];
        const obsolete = createMuxMessage("obsolete-assistant", "assistant", "");
        obsolete.parts = [
          {
            type: "dynamic-tool",
            toolCallId: "keep",
            toolName: "bash",
            state: "output-available",
            input: { obsolete: true },
            output: { result: "obsolete result" },
          },
        ];
        const payload = await assemblePromptPayload({
          ...swap.journal.preparation,
          modelString: nextModel,
          providerForMessages: family,
          systemMessage: `Fresh fallback system for ${nextModel} with nextTool`,
          tools: {
            nextTool: ai.tool({ description: "Fallback-only tool", inputSchema: z.object({}) }),
          },
          anthropicCacheTtl: "1h",
          workspaceId,
          history: [
            ...(mode === "ambiguous-anchor"
              ? [createMuxMessage("obsolete-user", "user", "Obsolete turn"), obsolete]
              : []),
            ...(committed
              ? [createMuxMessage("earlier-prompt", "user", "earlier request"), committed]
              : []),
            createMuxMessage("prompt", "user", "original request"),
            rebuilt,
          ],
        });
        const preparedMessages = payload.messages;
        const fallbackOptions =
          family === "anthropic"
            ? { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } }
            : undefined;
        if (sliced) {
          const containing = preparedMessages.findLast(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message.content).includes('"toolCallId":"keep"')
          );
          expect(JSON.stringify(containing)).toContain("summarized live head");
        }
        const stream = {
          model: swap.journal.parentModel,
          metadataModel: swap.journal.parentModel,
          streamResult: {
            usage: Promise.resolve(undefined),
            steps: Promise.resolve([]),
            providerMetadata: Promise.resolve(undefined),
          },
          startTime: Date.now(),
          messageId: "live",
          historySequence: 1,
          parts: rebuilt.parts,
          stepStartIndices: [0],
          currentStepStartIndex: 1,
          stepTracker: tracker,
          softInterrupt: { pending: false },
          abortController: controller,
          request: { model, messages: originalMessages },
          toolModelUsages: [],
          cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          modelFallback: {
            requestedModel: swap.journal.parentModel,
            refusedModels: [],
            original: {},
            options: {
              chain: [nextModel],
              prepare: () => {
                expect(tracker.pendingPrefixSwap).toBeUndefined();
                return Promise.resolve({
                  success: true,
                  data: {
                    model,
                    modelString: nextModel,
                    messages: preparedMessages,
                    system: payload.system,
                    tools: payload.tools,
                    providerOptions: fallbackOptions,
                    thinkingLevel: "off",
                  },
                });
              },
            },
          },
        };
        const reset = Reflect.get(manager, "resetStreamStateForRetry") as (
          id: string,
          info: unknown,
          options: unknown
        ) => Promise<void>;
        Reflect.set(
          manager,
          "resetStreamStateForRetry",
          async (...args: Parameters<typeof reset>) => {
            await reset.call(manager, ...args);
            expect(events).toEqual([]);
            resetFinished = true;
          }
        );
        const fallback = Reflect.get(manager, "tryModelFallbackAfterRefusal") as (
          id: string,
          stream: unknown,
          reason: string,
          options: { preserveParts: boolean }
        ) => Promise<{ kind: string }>;
        if (mode === "journal-failure" && family === "anthropic") {
          spyOn(atomicWrite, "default").mockImplementationOnce(
            Object.assign(() => Promise.reject(new Error("fallback journal disk full")), {
              sync: atomicWrite.default.sync,
            })
          );
        }
        expect(
          await fallback.call(manager, workspaceId, stream, "content-filter", {
            preserveParts: true,
          })
        ).toEqual({ kind: "swapped" });
        expect(events).toEqual(
          consumed &&
            (family === "openai" ||
              sliced ||
              mode === "journal-failure" ||
              mode === "ambiguous-anchor")
            ? ["prefix-swap-invalidated"]
            : []
        );
        if (
          consumed &&
          family === "anthropic" &&
          !sliced &&
          mode !== "journal-failure" &&
          mode !== "ambiguous-anchor"
        ) {
          expect(JSON.stringify(stream.request.messages)).not.toContain("original request");
          expect(JSON.stringify(stream.request.messages)).not.toContain("obsolete result");
          const systems = preparedMessages.filter((message) => message.role === "system");
          expect(stream.request.messages.filter((message) => message.role === "system")).toEqual(
            systems
          );
          const sentPrefix = stream.request.messages.slice(
            0,
            systems.length + swap.prefix.filter((message) => message.role !== "system").length
          );
          expect(
            stripMessageCacheControl(sentPrefix.filter((message) => message.role !== "system"))
          ).toEqual(
            stripMessageCacheControl(swap.prefix.filter((message) => message.role !== "system"))
          );
          const persisted = await store.read();
          expect(persisted?.prefix).toEqual(swap.prefix.map(exactJson));
          expect(persisted?.fallbackPrefixes?.at(-1)?.prefix).toEqual(sentPrefix.map(exactJson));
          expect(persisted?.fallbackPrefixes?.at(-1)?.modelString).toBe(nextModel);
          if (committed) {
            const calls = stream.request.messages.flatMap((message) =>
              message.role === "assistant" && Array.isArray(message.content)
                ? message.content.flatMap((part) =>
                    part.type === "tool-call" ? [part.toolCallId] : []
                  )
                : []
            );
            expect(calls).toEqual(["keep-static", "keep"]);
          }
        } else {
          expect(stream.request.messages).toEqual(preparedMessages);
        }
        if (mode === "journal-failure") {
          const preserved = await store.read();
          expect(preserved?.prefix).toEqual(swap.prefix.map(exactJson));
          expect(preserved?.fallbackPrefixes).toBeUndefined();
        }
        expect(Reflect.get(stream.request, "system")).toEqual(payload.system);
        expect(Reflect.get(stream.request, "tools")).toHaveProperty("nextTool");
        if (
          consumed &&
          (family === "openai" ||
            sliced ||
            mode === "journal-failure" ||
            mode === "ambiguous-anchor")
        ) {
          const blocked = prepareHarness(manager, tracker);
          const result = blocked.run().catch((error: unknown) => error);
          blocked.controller.abort(new Error("stop for durable fold"));
          expect(await result).toBeInstanceOf(Error);
        }
      });
    }
  }

  it("retains original and successive fallback prefixes and refuses stale or lossy updates", async () => {
    const { run, store, swap } = await setup();
    await run();
    const initial = swap.journal;
    const prefix: ai.ModelMessage[] = [
      { role: "system", content: "First fallback system" },
      ...swap.prefix.filter((message) => message.role !== "system"),
    ];
    const first = await store.recordFallbackPrefix(
      initial,
      { modelString: "anthropic:first", prefix },
      () => true
    );
    assert(first, "Expected first fallback record");
    const nextPrefix: ai.ModelMessage[] = [
      { role: "system", content: "Second fallback system" },
      ...prefix.filter((message) => message.role !== "system"),
    ];
    const second = await store.recordFallbackPrefix(
      first,
      { modelString: "anthropic:second", prefix: nextPrefix },
      () => true
    );
    assert(second, "Expected second fallback record");
    expect(second.prefix).toEqual(initial.prefix);
    expect(second.fallbackPrefixes?.map((entry) => entry.prefix)).toEqual([
      prefix.map(exactJson),
      nextPrefix.map(exactJson),
    ]);
    const bytes = await readFile(store.path, "utf8");
    expect(
      await store.recordFallbackPrefix(
        initial,
        { modelString: "anthropic:stale", prefix },
        () => true
      )
    ).toBeNull();
    expect(
      await store.recordFallbackPrefix(
        second,
        {
          modelString: "anthropic:lossy",
          prefix,
          providerOptions: { invalid: () => "must not disappear" },
        },
        () => true
      )
    ).toBeNull();
    expect(await readFile(store.path, "utf8")).toBe(bytes);
    expect(await store.read()).toEqual(second);
  });

  it("schema validates and self-heals corrupt journal files", async () => {
    const { store, swap } = await setup();
    expect(await store.write(swap.journal, swap.prefix, () => true)).not.toBeNull();
    await writeFile(store.path, JSON.stringify({ version: 9 }));
    expect(await store.read()).toBeNull();
    expect(await store.read()).toBeNull();
  });

  it("keeps corrupt-journal cleanup failure from blocking recovery", async () => {
    const { store } = await setup();
    await writeFile(store.path, "{");
    const remove = journalFs.rm;
    const failure = spyOn(journalFs, "rm").mockImplementation((...args) =>
      args[0] === store.path ? Promise.reject(new Error("cleanup unavailable")) : remove(...args)
    );
    expect(await store.read().catch((error: unknown) => error)).toBeNull();
    const rows = await history.historyService.getLastMessages(workspaceId, 10);
    assert(rows.success, "Expected source history");
    expect(rows.data.map((row) => row.id)).toEqual(["live"]);
    failure.mockRestore();
    expect(await store.read()).toBeNull();
    expect(await store.exists()).toBe(false);
  });
});
