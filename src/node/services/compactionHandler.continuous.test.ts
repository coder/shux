import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { CompactionHandler } from "./compactionHandler";
import { prepareMessagesForProvider } from "./messagePipeline";
import { createTestHistoryService } from "./testHistoryService";

describe("continuous compaction provider replay", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  const workspaceId = "continuous-wire-tests";

  beforeEach(async () => {
    store = await createTestHistoryService();
  });
  afterEach(async () => {
    await store.cleanup();
  });

  it("preserves previously pending attachments when a newer fold is abandoned or crashes", async () => {
    const sessionDir = path.join(store.tempDir, "pending");
    await mkdir(sessionDir, { recursive: true });
    const diffs = [{ path: "/tmp/prior.ts", diff: "prior change", truncated: false }];
    await writeFile(
      path.join(sessionDir, "post-compaction.json"),
      JSON.stringify({
        version: 1,
        createdAt: 1,
        diffs,
        loadedSkills: [],
        readFiles: [],
      })
    );
    const makeHandler = () =>
      new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir,
        emitter: new EventEmitter(),
      });
    const handler = makeHandler();
    expect((await handler.peekPendingState())?.diffs).toEqual(diffs);
    const preparation = handler.beginPreparation(() => true);
    expect(
      await handler.persistContinuousCompaction({
        preparation,
        attachmentMessages: [],
        publication: {
          generation: await store.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGeneration(),
        },
        messages: [],
        tail: [],
        text: "Unpublished summary",
        model: "anthropic:test",
        systemMessageTokens: 0,
        attachmentTokens: 0,
        shouldPersist: () => false,
      })
    ).toBe(false);
    expect((await handler.peekPendingState())?.diffs).toEqual(diffs);
    expect((await makeHandler().peekPendingState())?.diffs).toEqual(diffs);
  });

  it("retains committed pending state when a completion observer throws", async () => {
    const sessionDir = path.join(store.tempDir, "pending");
    const source = createMuxMessage("edited", "assistant", "Fixed the bug");
    source.parts.push({
      type: "dynamic-tool",
      toolCallId: "edit",
      toolName: "file_edit_replace_string",
      state: "output-available",
      input: { path: "/tmp/fix.ts" },
      output: { success: true, diff: "@@ -1 +1 @@\n-old\n+new\n" },
    });
    expect((await store.historyService.appendToHistory(workspaceId, source)).success).toBe(true);
    const handler = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir,
      emitter: new EventEmitter(),
      onCompactionComplete: () => {
        throw new Error("observer failed");
      },
    });
    const publication = {
      generation: await store.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration(),
    };
    const preparation = handler.beginPreparation(() => true);
    expect(
      await handler
        .persistContinuousCompaction({
          preparation,
          attachmentMessages: [source],
          publication,
          shouldPersist: () => true,
          messages: [source],
          tail: [],
          text: "Fix completed",
          model: "anthropic:test",
          systemMessageTokens: 0,
          attachmentTokens: 0,
        })
        .catch((error: unknown) => error)
    ).toEqual(new Error("observer failed"));
    const restarted = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir,
      emitter: new EventEmitter(),
    });
    expect((await restarted.peekPendingState())?.diffs).toMatchObject([
      { path: "/tmp/fix.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    ]);
    const rows = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(rows.success, "Expected committed boundary");
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0].metadata?.compactionBoundary).toBe(true);
  });

  for (const provider of ["anthropic", "openai"]) {
    it(`replays the durable summary, prompt, and sliced tool pairs through the ${provider} pipeline`, async () => {
      const old = createMuxMessage(
        "old-user",
        "user",
        "Old investigation no longer needed verbatim"
      );
      const prompt = createMuxMessage("recent-user", "user", "Verify the fix");
      const answer = createMuxMessage("recent-answer", "assistant", "", {
        stepStartPartIndices: [0, 1, 2],
        usage: { inputTokens: 60_000, outputTokens: 500, totalTokens: 60_500 },
      });
      answer.parts = [
        { type: "text", text: "Earlier work replaced by the summary" },
        {
          type: "dynamic-tool",
          toolCallId: "first-check",
          toolName: "bash",
          state: "output-available",
          input: { script: "bun test", timeout_secs: 10 },
          output: { success: true, output: "Tests passed" },
        },
        {
          type: "dynamic-tool",
          toolCallId: "second-check",
          toolName: "bash",
          state: "output-available",
          input: { script: "git diff --check", timeout_secs: 10 },
          output: { success: true, output: "No whitespace errors" },
        },
      ];
      for (const message of [old, prompt, answer]) {
        expect((await store.historyService.appendToHistory(workspaceId, message)).success).toBe(
          true
        );
      }
      const before = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(before.success, "Expected readable seeded history");
      const emitter = new EventEmitter();
      const emitted: MuxMessage[] = [];
      emitter.on("chat-event", (event: { workspaceId: string; message: MuxMessage }) => {
        expect(event.workspaceId).toBe(workspaceId);
        emitted.push(event.message);
      });
      const handler = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir: path.join(store.tempDir, "pending"),
        emitter,
      });
      const preparation = handler.beginPreparation(() => true);
      const publication = {
        generation: await store.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      };
      const tail = [
        prompt,
        {
          ...answer,
          parts: answer.parts.slice(1),
          metadata: { ...answer.metadata, stepStartPartIndices: [0, 1] },
        },
      ];
      expect(
        await handler.persistContinuousCompaction({
          preparation,
          publication,
          attachmentMessages: before.data,
          shouldPersist: () => true,
          messages: before.data,
          text: "The bug is fixed; verification is in progress.",
          model: `${provider}:test-model`,
          tail,
          systemMessageTokens: 200,
          attachmentTokens: 50,
        })
      ).toBe(true);
      const after = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(after.success, "Expected durable boundary and tail");
      expect(after.data).toHaveLength(3);
      expect(emitted.map((row) => row.id)).toEqual(after.data.map((row) => row.id));
      expect(after.data.slice(1).every((row) => row.metadata?.uiVisible === true)).toBe(true);
      expect(after.data[2].metadata?.usage).toBeUndefined();
      expect(after.data[2].metadata?.contextUsage).toBeUndefined();
      const wire = await prepareMessagesForProvider({
        messagesWithSentinel: sliceMessagesForProviderFromLatestContextBoundary(after.data),
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: provider,
        effectiveThinkingLevel: "off",
        modelString: `${provider}:test-model`,
        workspaceId,
      });
      const text = wire.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      );
      expect(text).toContain("The bug is fixed; verification is in progress.");
      expect(text).toContain("Verify the fix");
      expect(text).not.toContain("Old investigation no longer needed verbatim");
      expect(text).not.toContain("Earlier work replaced by the summary");
      const calls = wire.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "tool-call")
          : []
      );
      const results = wire.flatMap((message) =>
        message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : []
      );
      expect(calls.map((part) => part.toolCallId)).toEqual(["first-check", "second-check"]);
      expect(results.map((part) => part.toolCallId)).toEqual(calls.map((part) => part.toolCallId));
      expect(calls.map((part) => part.input)).toEqual(
        answer.parts.slice(1).map((part) => (part.type === "dynamic-tool" ? part.input : undefined))
      );
      expect(results.map((part) => part.output)).toEqual([
        { type: "json", value: { success: true, output: "Tests passed" } },
        { type: "json", value: { success: true, output: "No whitespace errors" } },
      ]);
    });
  }
});
