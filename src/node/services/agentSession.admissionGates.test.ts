import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { AgentSession, CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

const TEST_MODEL = "anthropic:claude-3-5-sonnet-latest";
const config = {
  rootDir: "/tmp",
  sessionsDir: "/tmp",
  srcDir: "/tmp",
  loadConfigOrDefault: () => ({}),
} as unknown as Config;

// r41/r42: the admissionEpochStale probe is a session-level backstop for
// context-discarding mutations that complete while a send is between its
// entry check and admission. WorkspaceService normally makes that scenario
// impossible (mutations refuse while sends are in preflight, r42), so these
// tests drive the probe directly to pin the backstop contracts: no stream
// over a stale snapshot, and accepted sends are notified so internal callers
// can revert delivered-state bookkeeping.
describe("AgentSession.sendMessage (admission gates)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  async function createSessionHarness(workspaceId: string) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));
    const aiService = Object.assign(new EventEmitter(), {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    }) as unknown as AIService;

    return {
      historyService,
      streamMessage,
      session: new AgentSession({
        workspaceId,
        config,
        historyService,
        aiService,
        initStateManager: new EventEmitter() as unknown as InitStateManager,
        backgroundProcessManager: {
          cleanup: mock((_workspaceId: string) => Promise.resolve()),
          setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
            void _queued;
          }),
        } as unknown as BackgroundProcessManager,
      }),
    };
  }

  afterEach(async () => {
    await historyCleanup?.();
  });

  it("refuses at the pre-persist gate before any row lands when the epoch is stale", async () => {
    const workspaceId = "ws-epoch-prepersist";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const appendMany = spyOn(historyService, "appendManyToHistory");
    let acceptedCalls = 0;

    const result = await session.sendMessage(
      "family trigger",
      { model: TEST_MODEL, agentId: "exec" },
      {
        synthetic: true,
        preTurnMessages: [
          createMuxMessage("family-payload-stale", "assistant", "untrusted payload", {
            timestamp: 1,
            synthetic: true,
          }),
        ],
        onAccepted: () => {
          acceptedCalls += 1;
        },
        admissionEpochStale: () => true,
      }
    );

    expect(result).toEqual({
      success: false,
      error: { type: "unknown", raw: CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE },
    });
    // Pre-acceptance refusal: nothing persisted, nothing accepted, no stream.
    expect(acceptedCalls).toBe(0);
    expect(appendMany).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);
  });

  it("invokes the cancellation hook when the caller probe goes stale before acceptance", async () => {
    const workspaceId = "ws-caller-stale-cancel";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const appendMany = spyOn(historyService, "appendManyToHistory");
    const canceled: string[] = [];

    const result = await session.sendMessage(
      "peer trigger",
      { model: TEST_MODEL, agentId: "exec" },
      {
        synthetic: true,
        preTurnMessages: [
          createMuxMessage("peer-payload-stale", "assistant", "untrusted payload", {
            timestamp: 1,
            synthetic: true,
          }),
        ],
        // Goes stale only once the pre-turn batch persisted: exercises the pre-horizon gate,
        // which must roll the rows back AND surface the refusal through the cancellation hook —
        // a queued peer send's caller already returned success and this hook carries its budget
        // refund; without it the reservation would leak.
        admissionStale: () => appendMany.mock.calls.length > 0,
        onCanceled: (reason: string) => {
          canceled.push(reason);
        },
      }
    );

    expect(result.success).toBe(false);
    expect(canceled).toHaveLength(1);
    expect(streamMessage).not.toHaveBeenCalled();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);
  });

  it("keeps the charge when a stale send's rollback did not commit", async () => {
    const workspaceId = "ws-caller-stale-rollback-failed";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const appendMany = spyOn(historyService, "appendManyToHistory");
    // Rollback deletion fails and the rows verifiably REMAIN: the cancellation hook must not
    // fire — a refunded reservation with durable rows would let the payload enter provider
    // context after a resume while no longer counting against the sender's budget.
    const deleteSpy = spyOn(historyService, "deleteMessages").mockImplementation(() =>
      Promise.resolve({ success: false as const, error: "sequence refresh failed" })
    );
    const canceled: string[] = [];
    let preTurnRowsPersisted = 0;

    const result = await session.sendMessage(
      "peer trigger",
      { model: TEST_MODEL, agentId: "exec" },
      {
        synthetic: true,
        preTurnMessages: [
          createMuxMessage("peer-payload-stuck", "assistant", "untrusted payload", {
            timestamp: 1,
            synthetic: true,
          }),
        ],
        admissionStale: () => appendMany.mock.calls.length > 0,
        onCanceled: (reason: string) => {
          canceled.push(reason);
        },
        onPreTurnRowsPersisted: () => {
          preTurnRowsPersisted += 1;
        },
      }
    );
    deleteSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(canceled).toHaveLength(0);
    // The failed rollback must be PROPAGATED as persistence: the Err still reaches the caller's
    // outer refund paths (direct failure branch / queued onAcceptedPreStreamFailure), and only
    // this marker keeps their payload-guarded refunds from releasing the charge on durable rows.
    expect(preTurnRowsPersisted).toBe(1);
    expect(streamMessage).not.toHaveBeenCalled();
    // The rows stayed durable — consistent with the retained charge.
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success && history.data.length > 0).toBe(true);
  });

  it("notifies accepted sends refused at the PREPARING gate and never streams", async () => {
    const workspaceId = "ws-epoch-preparing";
    const { session, streamMessage } = await createSessionHarness(workspaceId);
    // The epoch goes stale only after acceptance — models a mutation
    // committing between row persistence and PREPARING (reachable only via
    // entry-accounting bypasses; see r42 in WorkspaceService).
    let stale = false;
    let acceptedCalls = 0;
    const failures: SendMessageError[] = [];

    const result = await session.sendMessage(
      "hello",
      { model: TEST_MODEL, agentId: "exec" },
      {
        synthetic: true,
        onAccepted: () => {
          acceptedCalls += 1;
          stale = true;
        },
        onAcceptedPreStreamFailure: (error) => {
          failures.push(error);
        },
        admissionEpochStale: () => stale,
      }
    );

    expect(result).toEqual({
      success: false,
      error: { type: "unknown", raw: CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE },
    });
    // Accepted, then notified so delivered-state bookkeeping can revert
    // (terminal-attention outbox contract, r41) — and the stale snapshot
    // never streams.
    expect(acceptedCalls).toBe(1);
    expect(failures).toEqual([{ type: "unknown", raw: CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE }]);
    expect(streamMessage).not.toHaveBeenCalled();
  });
});
