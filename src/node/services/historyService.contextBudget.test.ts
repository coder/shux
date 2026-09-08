import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { filterEmptyAssistantMessages } from "@/browser/utils/messages/modelMessageTransform";
import { restoreContextBudgetRejectedMessageForDisplay } from "@/common/utils/messages/contextBudgetRejection";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import { prepareProviderRequestMessages } from "./turnContextAssembler";

const workspaceId = "budget-rejection";

describe("HistoryService context-budget request rejection", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test("rejects all owned prelude kinds but preserves unrelated history and stale references", async () => {
    const prior = createMuxMessage("prior", "user", "Prior request");
    const shared = createMuxMessage("shared", "user", "Previously accepted skill", {
      synthetic: true,
      agentSkillSnapshot: { skillName: "shared", scope: "project", sha256: "shared" },
    });
    const file = createMuxMessage("file", "user", "File expansion", {
      synthetic: true,
      fileAtMentionSnapshot: ["@file.txt"],
    });
    const skill = createMuxMessage("skill", "user", "Skill expansion", {
      synthetic: true,
      agentSkillSnapshot: { skillName: "test", scope: "project", sha256: "test" },
    });
    const mcp = createMuxMessage("mcp", "user", "MCP expansion", {
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "server",
        promptName: "prompt",
        commandKey: "prompt",
        invokingMessageId: "trigger",
      },
    });
    const peer = createMuxMessage("peer", "assistant", "Peer payload", { synthetic: true });
    const future = createMuxMessage("future", "assistant", "Later payload", { synthetic: true });
    const trigger = createMuxMessage("trigger", "user", "Rejected request", {
      requestPreludeMessageIds: [
        file.id,
        skill.id,
        mcp.id,
        peer.id,
        prior.id,
        future.id,
        "missing",
      ],
    });
    const rows = [prior, shared, file, skill, mcp, peer, trigger, future];
    expect((await h.historyService.appendManyToHistory(workspaceId, rows)).success).toBe(true);
    // Use persisted ownership, not a stale caller copy's references.
    const result = await h.historyService.rejectContextBudgetRequest(workspaceId, {
      ...trigger,
      metadata: { ...trigger.metadata, requestPreludeMessageIds: [shared.id] },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.data.map((row) => row.id)).toEqual([
      file.id,
      skill.id,
      mcp.id,
      peer.id,
      trigger.id,
    ]);
    const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!persisted.success) throw new Error(persisted.error);
    expect(persisted.data.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(
      persisted.data.map(
        (row) => MuxMessageSchema.parse(restoreContextBudgetRejectedMessageForDisplay(row)).parts
      )
    ).toEqual(rows.map((row) => MuxMessageSchema.parse(row).parts));
    const legacySchema = MuxMessageSchema.extend({
      metadata: MuxMessageSchema.shape.metadata
        .unwrap()
        .omit({
          contextBudgetRejected: true,
          contextBudgetRejectedMessage: true,
        })
        .optional(),
    });
    // Exercise the old assistant-only filter after discarding every field unknown to that build.
    const legacyRows = persisted.data.map((row) => legacySchema.parse(row));
    expect(filterEmptyAssistantMessages(legacyRows, true).map((row) => row.id)).toEqual([
      prior.id,
      shared.id,
      future.id,
    ]);
    for (const row of result.data) {
      expect(row.role).toBe("assistant");
      expect(row.parts).toEqual([]);
      expect(row.metadata?.partial).toBeUndefined();
      expect(row.metadata?.requestPreludeMessageIds).toBeUndefined();
      expect(row.metadata?.agentSkillSnapshot).toBeUndefined();
      expect(row.metadata?.mcpPromptSnapshot).toBeUndefined();
      expect(row.metadata?.fileAtMentionSnapshot).toBeUndefined();
    }
    const repeated = await h.historyService.rejectContextBudgetRequest(
      workspaceId,
      result.data.at(-1)!
    );
    expect(repeated).toEqual(result);
    expect(
      prepareProviderRequestMessages(persisted.data, "openai", "off").providerRequestMessages.map(
        (row) => row.id
      )
    ).toEqual([prior.id, shared.id, future.id]);
  });

  test.each([42, {}, "p", [null, 7, {}, "", "owned"]].map((ownership) => [ownership] as const))(
    "sanitizes malformed persisted prelude ownership: %j",
    async (ownership) => {
      const unrelated = createMuxMessage("p", "assistant", "Unrelated payload", {
        synthetic: true,
      });
      const owned = createMuxMessage("owned", "assistant", "Owned payload", { synthetic: true });
      const trigger = createMuxMessage("trigger", "user", "Rejected request");
      expect(
        (await h.historyService.appendManyToHistory(workspaceId, [unrelated, owned, trigger]))
          .success
      ).toBe(true);
      // Persist damaged metadata without making the typed caller itself malformed.
      const historyPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
      const raw = await fs.readFile(historyPath, "utf8");
      const lines = raw.trimEnd().split("\n");
      lines[2] = JSON.stringify({
        ...trigger,
        metadata: { ...trigger.metadata, requestPreludeMessageIds: ownership },
      });
      await fs.writeFile(historyPath, lines.join("\n") + "\n");

      const result = await h.historyService.rejectContextBudgetRequest(workspaceId, trigger);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      const expectedRejected = Array.isArray(ownership) ? [owned.id, trigger.id] : [trigger.id];
      expect(result.data.map((row) => row.id)).toEqual(expectedRejected);
      const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!persisted.success) throw new Error(persisted.error);
      expect(
        prepareProviderRequestMessages(persisted.data, "openai", "off").providerRequestMessages.map(
          (row) => row.id
        )
      ).toEqual(Array.isArray(ownership) ? [unrelated.id] : [unrelated.id, owned.id]);
    }
  );

  test("rejects the newest duplicate trigger identity and its own preludes without poisoning later sends", async () => {
    const oldPrelude = createMuxMessage("old-prelude", "assistant", "accepted prelude", {
      synthetic: true,
    });
    const oldTrigger = createMuxMessage("duplicate-trigger", "user", "accepted request", {
      requestPreludeMessageIds: [oldPrelude.id],
    });
    const currentPrelude = createMuxMessage("current-prelude", "assistant", "rejected prelude", {
      synthetic: true,
    });
    const currentTrigger = createMuxMessage(oldTrigger.id, "user", "rejected request", {
      requestPreludeMessageIds: [currentPrelude.id],
    });
    expect(
      (
        await h.historyService.appendManyToHistory(workspaceId, [
          oldPrelude,
          oldTrigger,
          currentPrelude,
          currentTrigger,
        ])
      ).success
    ).toBe(true);
    // Simulate a repaired/replayed row that reused both identifiers, not its payload.
    const historyPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    const rows = [
      oldPrelude,
      {
        ...oldTrigger,
        metadata: {
          ...oldTrigger.metadata,
          historySequence: currentTrigger.metadata!.historySequence,
        },
      },
      currentPrelude,
      currentTrigger,
    ];
    const malformed = Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},broken\n');
    await fs.writeFile(
      historyPath,
      Buffer.concat([
        malformed,
        Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      ])
    );

    const rejected = await h.historyService.rejectContextBudgetRequest(workspaceId, currentTrigger);
    expect(rejected.success).toBe(true);
    if (!rejected.success) throw new Error(rejected.error);
    expect(rejected.data.map((row) => row.id)).toEqual([currentPrelude.id, currentTrigger.id]);
    expect(
      MuxMessageSchema.parse(restoreContextBudgetRejectedMessageForDisplay(rejected.data.at(-1)!))
        .parts
    ).toEqual(MuxMessageSchema.parse(currentTrigger).parts);
    expect((await fs.readFile(historyPath)).subarray(0, malformed.length)).toEqual(malformed);
    expect(
      await h.historyService.rejectContextBudgetRequest(workspaceId, rejected.data.at(-1)!)
    ).toEqual(rejected);
    const later = createMuxMessage("later", "user", "later accepted request");
    expect((await h.historyService.appendToHistory(workspaceId, later)).success).toBe(true);
    const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!persisted.success) throw new Error(persisted.error);
    const newestDuplicate = persisted.data.findLast((row) => row.id === currentTrigger.id);
    expect(newestDuplicate?.metadata?.contextBudgetRejected).toBe(true);
    expect(newestDuplicate?.parts).toEqual([]);
    expect(
      prepareProviderRequestMessages(persisted.data, "openai", "off").providerRequestMessages.map(
        (row) => MuxMessageSchema.parse(row).parts
      )
    ).toEqual([oldPrelude, oldTrigger, later].map((row) => MuxMessageSchema.parse(row).parts));
  });

  test("a stale trigger identity leaves the entire request unchanged", async () => {
    const payload = createMuxMessage("payload", "assistant", "Payload", { synthetic: true });
    const trigger = createMuxMessage("trigger", "user", "Request", {
      requestPreludeMessageIds: [payload.id],
    });
    expect(
      (await h.historyService.appendManyToHistory(workspaceId, [payload, trigger])).success
    ).toBe(true);
    const result = await h.historyService.rejectContextBudgetRequest(workspaceId, {
      ...trigger,
      id: "removed",
    });
    expect(result.success).toBe(false);
    const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!persisted.success) throw new Error(persisted.error);
    expect(persisted.data.every((row) => !row.metadata?.contextBudgetRejected)).toBe(true);
  });
});
