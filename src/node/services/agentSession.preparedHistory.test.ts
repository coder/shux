import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { CompactionMonitor } from "./compactionMonitor";
import type { TurnAcceptanceOrigin } from "./taskWorkspaceSeam";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  type AgentSessionHarness,
} from "./agentSession.testHarness";

const options = { model: "openai:gpt-4o", agentId: "exec" };
const workspaceId = "prepared-history";
const fixtures: AgentSessionHarness[] = [];

interface PreparationInputs {
  materializeFileAtMentionsSnapshot(): Promise<{
    snapshotMessage: MuxMessage;
    materializedTokens: string[];
    fileStates: [];
  }>;
  materializeAgentSkillSnapshots(): Promise<MuxMessage[]>;
  materializeMcpPromptSnapshots(metadata: unknown, invokingId: string): Promise<MuxMessage[]>;
  compactionMonitor: CompactionMonitor;
}

async function fixture() {
  const h = await createAgentSessionHarness({ workspaceId });
  fixtures.push(h);
  const inputs = h.session as unknown as PreparationInputs;
  const file = createMuxMessage("file", "user", "file content", {
    synthetic: true,
    fileAtMentionSnapshot: ["@input.ts"],
  });
  const skill = createMuxMessage("skill", "user", "skill content", {
    synthetic: true,
    agentSkillSnapshot: { skillName: "review", scope: "project", sha256: "skill-hash" },
  });
  spyOn(inputs, "materializeFileAtMentionsSnapshot").mockResolvedValue({
    snapshotMessage: file,
    materializedTokens: ["@input.ts"],
    fileStates: [],
  });
  const skills = spyOn(inputs, "materializeAgentSkillSnapshots").mockResolvedValue([skill]);
  const prompts = spyOn(inputs, "materializeMcpPromptSnapshots").mockImplementation(
    (_metadata, invokingId) =>
      Promise.resolve([
        createMuxMessage("prompt", "user", "prompt content", {
          synthetic: true,
          mcpPromptSnapshot: {
            serverName: "server",
            promptName: "review",
            commandKey: "review",
            invokingMessageId: invokingId,
          },
        }),
      ])
  );
  const rows = async () => {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data;
  };
  return { ...h, inputs, skills, prompts, rows, stream: spyOn(h.aiService, "streamMessage") };
}

afterEach(async () => {
  for (const h of fixtures.splice(0)) {
    await h.session.dispose();
    await h.cleanup();
  }
  mock.restore();
});

describe("prepared history publication", () => {
  test.each([false, true])(
    "keeps prefix order before the trigger (pre-turn batch=%s)",
    async (batch) => {
      const h = await fixture();
      const payload = createMuxMessage("payload", "assistant", "delegated input", {
        synthetic: true,
      });
      const started = spyOn(h.aiService, "streamMessage").mockImplementation(async () => {
        const rows = await h.rows();
        expect(rows.slice(0, -1).map((row) => row.id)).toEqual(
          batch ? ["file", "skill", "prompt", "payload"] : ["file", "skill", "prompt"]
        );
        expect(rows.at(-1)?.parts).toMatchObject([{ type: "text", text: "inspect input" }]);
        expect(rows.map((row) => row.metadata?.historySequence)).toEqual(
          rows.map((_row, index) => index)
        );
        return Ok(createStartedTurnHandle(h.session.closingSignal));
      });
      expect(
        await h.session.sendMessage("inspect input", options, {
          ...(batch ? { preTurnMessages: [payload] } : {}),
        })
      ).toEqual(Ok(undefined));
      expect(started).toHaveBeenCalledTimes(1);
    }
  );

  test("a failed automatic batch leaves foreign history and publishes no owned prefixes", async () => {
    const h = await fixture();
    const foreign = createMuxMessage("foreign", "assistant", "concurrent input");
    const publish = spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (_id, _capture, operation) => {
        expect(await h.rows()).toEqual([]);
        assert(operation.kind === "append");
        expect(operation.preserveCancellation).toBe(true);
        expect(operation.messages.slice(0, -1).map((row) => row.id)).toEqual([
          "file",
          "skill",
          "prompt",
        ]);
        expect(await h.historyService.appendToHistory(workspaceId, foreign)).toEqual(Ok(undefined));
        // The batch API reports disk failures as Err; no per-prefix publication exists here.
        return Err("injected batch write failure");
      }
    );
    expect(
      (await h.session.sendMessage("inspect input", options, { acceptanceOrigin: "automatic" }))
        .success
    ).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await h.rows()).map((row) => row.id)).toEqual([foreign.id]);
    expect(h.stream).not.toHaveBeenCalled();
  });

  test("a rejected automatic batch leaves foreign history and publishes no owned prefixes", async () => {
    const h = await fixture();
    const foreign = createMuxMessage("foreign", "assistant", "concurrent input");
    expect(await h.historyService.appendToHistory(workspaceId, foreign)).toEqual(Ok(undefined));
    const publish = spyOn(h.historyService, "acceptCompactionReplacement").mockRejectedValueOnce(
      new Error("injected batch rejection")
    );
    const result = await h.session
      .sendMessage("inspect input", options, {
        acceptanceOrigin: "automatic",
      })
      .catch((error: unknown) => error);
    expect(publish).toHaveBeenCalledTimes(1);
    const operation = publish.mock.calls[0][2];
    assert(operation.kind === "append");
    expect(operation.preserveCancellation).toBe(true);
    expect(operation.messages.slice(0, -1).map((row) => row.id)).toEqual([
      "file",
      "skill",
      "prompt",
    ]);
    expect((await h.rows()).map((row) => row.id)).toEqual([foreign.id]);
    expect(result).toMatchObject({ success: false, error: { raw: "injected batch rejection" } });
    expect(h.stream).not.toHaveBeenCalled();
  });

  test("automatic cancellation after the batch receipt rolls back only its own rows", async () => {
    const h = await fixture();
    const foreign = createMuxMessage("foreign", "assistant", "concurrent input");
    expect(await h.historyService.appendToHistory(workspaceId, foreign)).toEqual(Ok(undefined));
    const controller = new AbortController();
    const canceled = mock(() => undefined);
    const accepted = mock(() => undefined);
    const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    const publication = spyOn(
      h.historyService,
      "acceptCompactionReplacement"
    ).mockImplementationOnce(async (id, capture, operation, observer) => {
      assert(operation.kind === "append");
      expect(operation.preserveCancellation).toBe(true);
      const result = await publish(id, capture, operation, {
        ...observer,
        onCommitted: (receipt) => {
          // Record the actual durable batch before cancellation exercises ordinary rollback.
          observer.onCommitted(receipt);
          controller.abort();
        },
      });
      expect(result).toEqual(Ok({ kind: "accepted", witness: null }));
      const rows = await h.rows();
      expect(rows.map((row) => row.id)).toEqual([
        foreign.id,
        ...operation.messages.map((row) => row.id),
      ]);
      expect(rows.map((row) => row.metadata?.historySequence)).toEqual([0, 1, 2, 3, 4]);
      return result;
    });
    expect(
      await h.session.sendMessage("inspect input", options, {
        acceptanceOrigin: "automatic",
        cancelSignal: controller.signal,
        onCanceled: canceled,
        onAccepted: accepted,
      })
    ).toEqual(Ok(undefined));
    expect(publication).toHaveBeenCalledTimes(1);
    expect((await h.rows()).map((row) => row.id)).toEqual([foreign.id]);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });

  test.each(["skill", "prompt"] as const)(
    "manual %s materialization failure leaves no orphaned prefixes or accepted Stop",
    async (failure) => {
      const h = await fixture();
      await h.session.cancelCompaction(true);
      const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
      const stop = await storage.read();
      h[failure === "skill" ? "skills" : "prompts"].mockRejectedValueOnce(
        new Error("materialization failed")
      );
      expect((await h.session.sendMessage("inspect input", options)).success).toBe(false);
      expect(await h.rows()).toEqual([]);
      expect((await storage.read())?.nonce).toBe(stop?.nonce);
      expect(h.stream).not.toHaveBeenCalled();
    }
  );

  test("manual prefixes commit with the trigger and survive cancellation in the durable receipt", async () => {
    const h = await fixture();
    await h.session.cancelCompaction(true);
    const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
    const stop = await storage.read();
    const controller = new AbortController();
    const canceled = mock(() => undefined);
    const accepted = mock(() => undefined);
    const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(
      async (id, capture, operation, observer) => {
        expect(await h.rows()).toEqual([]);
        assert(operation.kind === "append");
        expect(operation.messages.slice(0, -1).map((row) => row.id)).toEqual([
          "file",
          "skill",
          "prompt",
        ]);
        return publish(id, capture, operation, {
          ...observer,
          onCommitted: (receipt) => {
            observer.onCommitted(receipt);
            controller.abort();
          },
        });
      }
    );
    expect(
      await h.session.sendMessage("inspect input", options, {
        cancelSignal: controller.signal,
        onCanceled: canceled,
        onAccepted: accepted,
      })
    ).toEqual(Ok(undefined));
    const rows = await h.rows();
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)?.metadata?.compactionReplacementNonce).toBe(stop?.nonce);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
    expect(await storage.read()).toBeNull();
  });

  test("Stop before a manual batch commits leaves every prefix and trigger unpublished", async () => {
    const h = await fixture();
    const publish = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        await h.session.cancelCompaction(true);
        return publish(...args);
      }
    );
    expect((await h.session.sendMessage("inspect input", options)).success).toBe(false);
    expect(await h.rows()).toEqual([]);
    expect(
      await h.historyService.getCompactionCancellationStorage(workspaceId).read()
    ).not.toBeNull();
    expect(h.stream).not.toHaveBeenCalled();
  });

  test("on-send compaction accepts only the request carrying the deferred user input", async () => {
    const h = await fixture();
    await h.session.cancelCompaction(true);
    const storage = h.historyService.getCompactionCancellationStorage(workspaceId);
    const stop = await storage.read();
    spyOn(h.inputs.compactionMonitor, "checkBeforeSend").mockReturnValue({
      shouldShowWarning: true,
      shouldForceCompact: true,
      usagePercentage: 99,
      thresholdPercentage: 85,
      contextTokens: 99_000,
      maxTokens: 100_000,
    });
    spyOn(h.inputs.compactionMonitor, "getThreshold").mockReturnValue(0.85);
    expect(await h.session.sendMessage("inspect input", options)).toEqual(Ok(undefined));
    const rows = await h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata?.compactionReplacementNonce).toBe(stop?.nonce);
    expect(await storage.read()).toBeNull();
    const request = rows[0].metadata?.muxMetadata;
    assert(request?.type === "compaction-request");
    expect(request.parsed.followUpContent?.text).toBe("inspect input");
    expect(h.skills).not.toHaveBeenCalled();
    expect(h.prompts).not.toHaveBeenCalled();
  });

  test("a manual add during queue admission updates the dispatched origin without splitting the entry", async () => {
    const h = await fixture();
    const dispatched = Promise.withResolvers<TurnAcceptanceOrigin | undefined>();
    // Observe the public dispatch argument while the real session/history implementation runs.
    const send = h.session.sendMessage.bind(h.session);
    spyOn(h.session, "sendMessage").mockImplementation((message, options, internal) => {
      dispatched.resolve(internal?.acceptanceOrigin);
      return send(message, options, internal);
    });
    let added = false;
    h.session.onChatEvent(({ message }) => {
      if (added || message.type !== "stream-lifecycle" || message.phase !== "preparing") return;
      added = true;
      h.session.queueMessage("manual", options);
    });
    h.session.queueMessage("automatic", options, { acceptanceOrigin: "automatic" });
    h.session.sendQueuedMessages();
    expect(await dispatched.promise).toBe("manual");
    expect(h.session.queuedMessageEntryCount()).toBe(0);
  });
});
