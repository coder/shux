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
  return { ...h, inputs, skills, prompts, rows };
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

  test.each(
    (["skill", "prompt", "trigger"] as const).flatMap((failure) =>
      (["result", "rejection"] as const).map((outcome) => ({ failure, outcome }))
    )
  )(
    "a failed $failure append ($outcome) rolls back only this attempt's previously published rows",
    async ({ failure, outcome }) => {
      const h = await fixture();
      const foreign = createMuxMessage("foreign", "assistant", "concurrent input");
      const earlier = ["file", "skill", "prompt"].slice(
        0,
        ["skill", "prompt", "trigger"].indexOf(failure) + 1
      );
      const append = h.historyService.appendToHistory.bind(h.historyService);
      const appends = spyOn(h.historyService, "appendToHistory").mockImplementationOnce(
        async (...args) => {
          const result = await append(...args);
          expect(result).toEqual(Ok(undefined));
          // The real prefix released its lock; a foreign writer now lands before the failure.
          expect(await append(workspaceId, foreign)).toEqual(Ok(undefined));
          return result;
        }
      );
      for (const _row of earlier.slice(1)) appends.mockImplementationOnce(append);
      // Disk failures use Result Err; an unexpected service rejection must also retire
      // already-published prefixes without deleting a concurrent writer's row.
      if (outcome === "result") appends.mockResolvedValueOnce(Err("injected write failure"));
      else appends.mockRejectedValueOnce(new Error("injected write failure"));
      const start = spyOn(h.aiService, "streamMessage");
      const result = await h.session
        .sendMessage("inspect input", options)
        .catch((error: unknown) => error);
      expect(appends.mock.calls.slice(0, -1).map(([, row]) => row.id)).toEqual(earlier);
      expect(foreign.metadata?.historySequence).toBe(1);
      expect(appends).toHaveBeenCalledTimes(earlier.length + 1);
      expect((await h.rows()).map((row) => row.id)).toEqual([foreign.id]);
      expect(result).toMatchObject({ success: false, error: { raw: "injected write failure" } });
      expect(start).not.toHaveBeenCalled();
    }
  );

  test.each(["file", "skill", "prompt", "trigger"])(
    "cancellation after %s publication still runs the existing rollback checkpoint",
    async (after) => {
      const h = await fixture();
      const controller = new AbortController();
      const canceled = mock(() => undefined);
      const accepted = mock(() => undefined);
      const append = h.historyService.appendToHistory.bind(h.historyService);
      spyOn(h.historyService, "appendToHistory").mockImplementation(async (id, row) => {
        const result = await append(id, row);
        if (row.id === after || (after === "trigger" && row.metadata?.synthetic !== true))
          controller.abort();
        return result;
      });
      const start = spyOn(h.aiService, "streamMessage");
      expect(
        await h.session.sendMessage("inspect input", options, {
          cancelSignal: controller.signal,
          onCanceled: canceled,
          onAccepted: accepted,
        })
      ).toEqual(Ok(undefined));
      expect(await h.rows()).toEqual([]);
      expect(canceled).toHaveBeenCalledTimes(1);
      expect(accepted).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    }
  );

  test("on-send compaction publishes only the request carrying the deferred user input", async () => {
    const h = await fixture();
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
