import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { CompactionHandler } from "./compactionHandler";
import { prepareMessagesForProvider } from "./messagePipeline";
import { createTestHistoryService } from "./testHistoryService";
import { TurnCoordinator } from "./turnCoordinator";
import { CHAT_FILE_NAME, CHAT_ARCHIVE_FILE_NAME } from "@/common/constants/paths";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

describe("continuous compaction provider replay", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  const workspaceId = "continuous-wire-tests";

  beforeEach(async () => {
    store = await createTestHistoryService();
  });
  afterEach(async () => {
    mock.restore();
    await store.cleanup();
  });

  it.each(["none", "cleanup", "observer"] as const)(
    "publishes committed heartbeat rollback before replacement admission (failure=%s)",
    async (failurePoint) => {
      const sessionDir = path.join(store.tempDir, "pending");
      await mkdir(sessionDir, { recursive: true });
      const priorDiff = { path: "/tmp/prior.ts", diff: "prior change", truncated: false };
      await writeFile(
        path.join(sessionDir, "post-compaction.json"),
        JSON.stringify({
          version: 1,
          createdAt: 1,
          diffs: [priorDiff],
          loadedSkills: [],
          readFiles: [],
        })
      );
      const recent = createMuxMessage("recent", "assistant", "");
      recent.parts = [
        {
          type: "dynamic-tool",
          toolCallId: "edit",
          toolName: "file_edit_replace_string",
          state: "output-available",
          input: { path: "/tmp/recent.ts" },
          output: { success: true, diff: "recent change" },
        },
      ];
      await store.historyService.appendToHistory(workspaceId, recent);
      const emitter = new EventEmitter();
      const emitted: WorkspaceChatMessage[] = [];
      emitter.on("chat-event", (event: { message: WorkspaceChatMessage }) => {
        emitted.push(event.message);
        if (failurePoint === "observer" && event.message.type === "delete")
          throw new Error("observer failed after commit");
      });
      const handler = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir,
        emitter,
      });
      expect(
        (
          await handler.appendHeartbeatContextResetBoundary({
            boundaryText: "Heartbeat",
            pendingFollowUp: { text: "wake", model: "openai:gpt-4o", agentId: "exec" },
          })
        ).success
      ).toBe(true);
      const boundary = await store.historyService.getLastMessages(workspaceId, 1);
      assert(boundary.success, "Expected heartbeat boundary");
      const boundarySequence = boundary.data[0].metadata?.historySequence;
      assert(boundarySequence != null, "Expected persisted boundary sequence");
      // The external send has already persisted its row; PREPARING can race
      // rollback without needing another history write or its lock.
      await store.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual", "user", "manual replacement")
      );
      const coordinator = new TurnCoordinator({
        phaseChanged: () => undefined,
        drainQueue: () => undefined,
        policy: () => Promise.resolve(),
        policyError: () => undefined,
      });
      const token = coordinator.claimCompactionFollowUp();
      assert(token, "Expected cleanup owner");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const rm = fsPromises.rm;
      const historyPath = path.join(store.config.sessionsDir, workspaceId, CHAT_FILE_NAME);
      spyOn(fsPromises, "rm").mockImplementation(async (file, options) => {
        if (String(file).startsWith(`${historyPath}.continuous-`)) {
          entered.resolve();
          await release.promise;
          if (failurePoint === "cleanup") throw new Error("post-commit cleanup failed");
        }
        return rm(file, options);
      });
      const published = mock(() => undefined);
      const pending = handler.rollbackHeartbeatContextResetBoundary(
        boundary.data[0],
        () => coordinator.canClearCompactionFollowUp(token),
        published
      );
      try {
        await entered.promise;
        const committedRows = (await fsPromises.readFile(historyPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as MuxMessage);
        expect(committedRows.map((message) => message.id)).toEqual(["manual"]);
        expect(
          coordinator.prepare({
            kind: "fresh",
            intent: "direct",
            expectedTurnId: coordinator.turnId,
          }).status
        ).toBe("admitted");
        expect(handler.peekCachedFilePaths()).toEqual([priorDiff.path]);
        expect(emitted.filter((message) => message.type === "delete")).toEqual([
          {
            type: "delete",
            historySequences: [boundarySequence],
          },
        ]);
        expect(published).toHaveBeenCalledTimes(1);
        release.resolve();
        const result = await pending;
        expect(result.success).toBe(failurePoint !== "cleanup");
        if (!result.success) expect(result.error).toContain("was deleted");
        expect((await handler.peekPendingState())?.diffs).toEqual([priorDiff]);
        const reloaded = new CompactionHandler({
          workspaceId,
          historyService: store.historyService,
          sessionDir,
          emitter: new EventEmitter(),
        });
        expect((await reloaded.peekPendingState())?.diffs).toEqual([priorDiff]);
      } finally {
        release.resolve();
        await pending;
      }
    }
  );

  it.each(["missing", "replacement sequence"] as const)(
    "settles local heartbeat rollback after a shared-history change (%s)",
    async (state) => {
      const sessionDir = path.join(store.tempDir, "pending");
      await mkdir(sessionDir, { recursive: true });
      const priorDiff = { path: "/tmp/prior.ts", diff: "prior change", truncated: false };
      await writeFile(
        path.join(sessionDir, "post-compaction.json"),
        JSON.stringify({
          version: 1,
          createdAt: 1,
          diffs: [priorDiff],
          loadedSkills: [],
          readFiles: [],
        })
      );
      const recent = createMuxMessage("recent-edit", "assistant", "");
      recent.parts = [
        {
          type: "dynamic-tool",
          toolCallId: "edit",
          toolName: "file_edit_replace_string",
          state: "output-available",
          input: { path: "/tmp/recent.ts" },
          output: { success: true, diff: "recent change" },
        },
      ];
      await store.historyService.appendToHistory(workspaceId, recent);
      const emitter = new EventEmitter();
      const handler = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir,
        emitter,
      });
      await handler.appendHeartbeatContextResetBoundary({
        boundaryText: "Heartbeat",
        pendingFollowUp: { text: "wake", model: "openai:gpt-4o", agentId: "exec" },
      });
      const rows = await store.historyService.getLastMessages(workspaceId, 1);
      assert(rows.success && rows.data[0], "Expected boundary");
      const boundary = rows.data[0];
      // A second backend can commit the shared history deletion without touching
      // this handler's captured rollback or its post-reset memory.
      expect((await store.historyService.deleteMessage(workspaceId, boundary.id)).success).toBe(
        true
      );
      if (state === "replacement sequence") {
        await store.historyService.appendToHistory(workspaceId, {
          ...boundary,
          metadata: { ...boundary.metadata, historySequence: undefined },
        });
      }
      const before = await handler.peekPendingState();
      expect(before?.diffs.map((diff) => diff.path)).toContain("/tmp/recent.ts");
      const emit = spyOn(emitter, "emit");
      const published = mock(() => {
        expect(handler.peekCachedFilePaths()).toEqual([priorDiff.path]);
      });
      expect(
        (await handler.rollbackHeartbeatContextResetBoundary(boundary, () => true, published))
          .success
      ).toBe(true);
      expect(emit).not.toHaveBeenCalled();
      if (state === "missing") {
        expect(published).toHaveBeenCalledTimes(1);
        expect((await handler.peekPendingState())?.diffs).toEqual([priorDiff]);
      } else {
        expect(published).not.toHaveBeenCalled();
        expect(await handler.peekPendingState()).toEqual(before);
      }
    }
  );

  it.each(["veto", "archived"] as const)(
    "does not restore or publish a skipped heartbeat rollback (%s)",
    async (skipReason) => {
      const sessionDir = path.join(store.tempDir, "pending");
      const emitter = new EventEmitter();
      const handler = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir,
        emitter,
      });
      expect(
        (
          await handler.appendHeartbeatContextResetBoundary({
            boundaryText: "Heartbeat",
            pendingFollowUp: { text: "wake", model: "openai:gpt-4o", agentId: "exec" },
          })
        ).success
      ).toBe(true);
      const boundary = await store.historyService.getLastMessages(workspaceId, 1);
      assert(boundary.success, "Expected heartbeat boundary");
      if (skipReason === "archived") {
        await store.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("replacement", "assistant", "New boundary", {
            compacted: true,
            compactionBoundary: true,
            compactionEpoch: 2,
          })
        );
      }
      const emit = spyOn(emitter, "emit");
      const published = mock(() => undefined);
      const state = await handler.peekPendingState();
      expect(state).not.toBeNull();
      expect(
        (
          await handler.rollbackHeartbeatContextResetBoundary(
            boundary.data[0],
            () => skipReason !== "veto",
            published
          )
        ).success
      ).toBe(true);
      expect(await handler.peekPendingState()).toEqual(state);
      expect(emit).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      if (skipReason === "archived") {
        const archive = await fsPromises.readFile(
          path.join(store.config.sessionsDir, workspaceId, CHAT_ARCHIVE_FILE_NAME),
          "utf8"
        );
        expect(
          archive
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as MuxMessage).id)
        ).toContain(boundary.data[0].id);
      }
    }
  );

  it("a held heartbeat rollback unlink cannot consume the replacement rollback snapshot", async () => {
    const sessionDir = path.join(store.tempDir, "pending");
    const handler = new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir,
      emitter: new EventEmitter(),
    });
    const followUp = { text: "wake", model: "openai:gpt-4o", agentId: "exec" };
    expect(
      (
        await handler.appendHeartbeatContextResetBoundary({
          boundaryText: "A",
          pendingFollowUp: followUp,
        })
      ).success
    ).toBe(true);
    const first = await store.historyService.getLastMessages(workspaceId, 1);
    assert(first.success, "Expected first boundary");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    const unlink = fsPromises.unlink;
    let held = false;
    spyOn(fsPromises, "unlink").mockImplementation(async (file) => {
      if (!held && file === path.join(sessionDir, "post-compaction.json")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return unlink(file);
    });
    const internals = handler as unknown as { captureHeartbeatResetRollbackState(): void };
    const capture = internals.captureHeartbeatResetRollbackState.bind(handler);
    spyOn(internals, "captureHeartbeatResetRollbackState").mockImplementation(() => {
      capture();
      captured.resolve();
    });
    const rollingBack = handler.rollbackHeartbeatContextResetBoundary(first.data[0]);
    let replacement:
      | ReturnType<CompactionHandler["appendHeartbeatContextResetBoundary"]>
      | undefined;
    try {
      await entered.promise;
      replacement = handler.appendHeartbeatContextResetBoundary({
        boundaryText: "B",
        pendingFollowUp: followUp,
      });
      await captured.promise;
      release.resolve();
      expect((await rollingBack).success).toBe(true);
      expect((await replacement).success).toBe(true);
      const reloaded = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir,
        emitter: new EventEmitter(),
      });
      // A's delayed unlink must finish before B's pending snapshot publishes.
      expect(await reloaded.peekPendingState()).not.toBeNull();
      const second = await store.historyService.getLastMessages(workspaceId, 1);
      assert(second.success, "Expected replacement boundary");
      expect((await handler.rollbackHeartbeatContextResetBoundary(second.data[0])).success).toBe(
        true
      );
      expect(await handler.peekPendingState()).toBeNull();
    } finally {
      release.resolve();
      await rollingBack;
      await replacement;
    }
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
    expect(
      await handler.withContinuousPendingState([], async () => {
        // New preparation has no boundary: a restart must load the preceding
        // pending snapshot, not treat the uncommitted one as a completed fold.
        expect((await makeHandler().peekPendingState())?.diffs).toEqual(diffs);
        return false;
      })
    ).toBe(false);
    expect((await handler.peekPendingState())?.diffs).toEqual(diffs);
    expect((await makeHandler().peekPendingState())?.diffs).toEqual(diffs);
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
      await handler.preparePendingStateFromMessages(before.data);
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
