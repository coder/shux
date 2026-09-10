import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import { createStartedTurnHandle } from "./agentSession.testHarness";
import { WorkspaceGoalService } from "./workspaceGoalService";
// Registers a no-op goal-continuation consumer so the in-AS pricing gate
// path runs end-to-end (DEREM-52). Bridge registration alone is now
// sufficient — goals graduated to GA, so there is no longer an experiment
// flag to flip.
import { registerNoopContinuationBridgeForTest } from "./testDispatchHelpers";
import { Ok } from "@/common/types/result";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { GoalRecordV1 } from "@/common/types/goal";

const PROJECT_PATH = "/tmp/mux-agent-session-budget-gate-test-project";
const PRICED_OPTIONS: SendMessageOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
const UNPRICED_OPTIONS: SendMessageOptions = {
  model: "openai:not-priced-model",
  agentId: "exec",
};

interface SessionHarness {
  historyService: HistoryService;
  session: AgentSession;
  goalService: WorkspaceGoalService;
  cleanup: () => Promise<void>;
}

async function setGoalOk(
  service: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await service.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function createAiService(workspaceId: string, getClosingSignal: () => AbortSignal): AIService {
  const aiEmitter = new EventEmitter();
  return Object.assign(aiEmitter, {
    isStreaming: mock((_workspaceId: string) => false),
    stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    streamMessage: mock((_request: unknown) =>
      Promise.resolve(Ok(createStartedTurnHandle(getClosingSignal())))
    ),
    getStreamInfo: mock((_workspaceId: string) => null),
    getProvidersConfig: mock(() => null),
    getWorkspaceMetadata: mock((_workspaceId: string) =>
      Promise.resolve(
        Ok({
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath: PROJECT_PATH,
          runtimeConfig: { type: "local" },
        })
      )
    ),
    replayStream: mock((_workspaceId: string) => Promise.resolve()),
  }) as unknown as AIService;
}

async function createSessionHarness(workspaceId: string): Promise<SessionHarness> {
  const { historyService, config, cleanup } = await createTestHistoryService();
  await config.addWorkspace(PROJECT_PATH, {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux-agent-session-budget-gate-test-project",
    projectPath: PROJECT_PATH,
    runtimeConfig: { type: "local" },
  });

  const extensionMetadata = new ExtensionMetadataService(
    `${config.rootDir}/agent-session-budget-gate-extension-metadata.json`
  );
  const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
  // Register a no-op continuation bridge so any continuation-bridge-dependent
  // codepath has a registered consumer to talk to (DEREM-52).
  registerNoopContinuationBridgeForTest(goalService);
  const initStateManager = Object.assign(new EventEmitter(), {
    replayInit: mock((_workspaceId: string) => Promise.resolve()),
  }) as unknown as InitStateManager;
  const backgroundProcessManager = {
    cleanup: mock((_workspaceId: string) => Promise.resolve()),
    setMessageQueued: mock((_workspaceId: string, _queued: boolean) => undefined),
  } as unknown as BackgroundProcessManager;

  const session: AgentSession = new AgentSession({
    workspaceId,
    config,
    historyService,
    aiService: createAiService(workspaceId, () => session.closingSignal),
    initStateManager,
    backgroundProcessManager,
    workspaceGoalService: goalService,
  });

  return { historyService, session, goalService, cleanup };
}

// ---------------------------------------------------------------------------
// AgentSession.sendMessage budget-gate regression — Codex P1
// (PRRT_kwDOPxxmWM5_stnS): the WorkspaceService-level gate is only checked on
// the initial sendMessage/resumeStream entry. Queued messages dispatched
// later via AgentSession.sendQueuedMessages() (and every other internal
// re-entry: dispatchPendingFollowUp, post-compaction
// retries) skip that path, so a budgeted goal that became resumable while a
// queued unpriced-model message waited would otherwise bypass enforcement
// and stream with 0-cost accounting.
//
// These tests pin the AS-level gate that closes the bypass.
// ---------------------------------------------------------------------------
describe("AgentSession.sendMessage budget gate", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("rejects an unpriced model when a budgeted resumable goal exists", async () => {
    const workspaceId = "as-budget-gate-rejects";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const result = await session.sendMessage("Unpriced", UNPRICED_OPTIONS);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("Target model has no pricing data");
      }
    }
    await session.dispose();
  });

  test("resumeStream rejects an unpriced model when a budgeted resumable goal exists", async () => {
    const workspaceId = "as-budget-gate-resume-rejects";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const result = await session.resumeStream(UNPRICED_OPTIONS);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("Target model has no pricing data");
      }
    }
    await session.dispose();
  });

  test("allows an unpriced model when no budgeted goal exists", async () => {
    // Pinning the absence of false positives: the gate must not block sends
    // on workspaces without a budgeted goal, which is the common case for
    // users running local Ollama models without goals at all.
    const workspaceId = "as-budget-gate-allows-no-goal";
    const { session, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    const result = await session.sendMessage("Unpriced", UNPRICED_OPTIONS);
    expect(result.success).toBe(true);
    await session.dispose();
  });

  test("allows an unpriced model when goal has no budget", async () => {
    const workspaceId = "as-budget-gate-allows-unbudgeted";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "No budget",
    });

    const result = await session.sendMessage("Unpriced", UNPRICED_OPTIONS);
    expect(result.success).toBe(true);
    await session.dispose();
  });

  test("manual rejected send preserves the user message + emits a stream-error event", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM5_s-jo): sendQueuedMessages() removes the
    // message from the queue before invoking sendMessage, so a silent Err
    // here would drop the user's typed input. Verify both halves of the fix:
    //  1. The user's message gets persisted to history with their text.
    //  2. A chat event is emitted for the user message + a stream-error
    //     event is emitted with the rejection reason, so the UI shows it.
    const workspaceId = "as-budget-gate-preserves-user-message";
    const { historyService, session, goalService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const events: Array<{ type: string; role?: string; error?: string }> = [];
    session.onChatEvent((wrapped) => {
      // AgentSessionChatEvent wraps the actual message under `.message`.
      const candidate = (wrapped as { message: { type: string; role?: string; error?: string } })
        .message;
      events.push({ type: candidate.type, role: candidate.role, error: candidate.error });
    });

    const userTypedText = "Switch to my local model and keep going";
    const result = await session.sendMessage(userTypedText, UNPRICED_OPTIONS);
    expect(result.success).toBe(false);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      const userMessages = history.data.filter((m) => m.role === "user");
      expect(userMessages.length).toBe(1);
      const persistedText = userMessages[0].parts
        .filter((p): p is { type: "text"; text: string; state: "done" } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(persistedText).toBe(userTypedText);
    }

    const userEvent = events.find((e) => e.type === "message" && e.role === "user");
    expect(userEvent).toBeDefined();
    const errorEvent = events.find((e) => e.type === "stream-error");
    expect(errorEvent).toBeDefined();
    if (errorEvent) {
      expect(errorEvent.error ?? "").toContain("Target model has no pricing data");
    }

    // Goal-safety contract still applies even on the rejection path: an
    // explicit manual user message auto-pauses an active goal so a pending
    // post-stream-end continuation cannot fire as if the user had not
    // intervened (Codex P1 PRRT_kwDOPxxmWM5_tOFt).
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });

    await session.dispose();
  });

  test("rejected queued sends persist authoring metadata and pre-goal rows do not pause the goal", async () => {
    // Queue race on the rejection path: a message the user typed before the
    // goal existed can be rejected by the pricing gate when it dispatches
    // after the goal-creating turn. The persisted row must carry authoring
    // metadata (timestamp + enqueuedAtMs) so goal-safety reconciliation still
    // classifies it as pre-goal after a restart, and the dispatch-time hook
    // must leave the fresh goal active.
    const workspaceId = "as-budget-gate-queued-pre-goal";
    const { historyService, session, goalService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    const enqueuedAtMs = Date.now() - 1;
    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const result = await session.sendMessage("Typed before the goal existed", UNPRICED_OPTIONS, {
      enqueuedAtMs,
    });
    expect(result.success).toBe(false);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      const userMessage = history.data.find((m) => m.role === "user");
      expect(typeof userMessage?.metadata?.timestamp).toBe("number");
      expect(userMessage?.metadata?.enqueuedAtMs).toBe(enqueuedAtMs);
    }

    // Dispatch-time guard: no pause. getGoal also re-runs chat-tail
    // reconciliation against the persisted row, exercising the durable
    // enqueuedAtMs path.
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });

    await session.dispose();
  });

  test("empty manual rejected send does NOT pause an active goal", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM5_tUsx): an accidental blank submit must not
    // silently disable goal continuation. The pre-stream gate runs before the
    // empty-message validation later in sendMessage, so the goal-safety hook
    // would otherwise fire for payloads that are not actionable user turns.
    const workspaceId = "as-budget-gate-empty-no-pause";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    // Empty text + no fileParts = nothing to preserve, no intervention.
    const result = await session.sendMessage("   ", UNPRICED_OPTIONS);
    expect(result.success).toBe(false);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });

    await session.dispose();
  });

  test("synthetic rejected send does NOT pause an active goal", async () => {
    // Inverse of the goal-safety check: synthetic sends (compaction, goal
    // continuation) are not user intervention, so the goal-safety hook must
    // stay scoped to manual messages.
    const workspaceId = "as-budget-gate-synthetic-no-pause";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const result = await session.sendMessage("[synthetic continuation]", UNPRICED_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(false);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });

    await session.dispose();
  });

  test("synthetic rejected send does NOT persist a user message", async () => {
    // Synthetic sends (compaction, goal continuation) are not user-typed, so
    // a gate rejection should not write a fake user message into history. The
    // synthetic caller is responsible for handling the Err result itself.
    const workspaceId = "as-budget-gate-synthetic-no-persist";
    const { historyService, session, goalService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    const result = await session.sendMessage("[synthetic continuation]", UNPRICED_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(false);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      const userMessages = history.data.filter((m) => m.role === "user");
      expect(userMessages.length).toBe(0);
    }

    await session.dispose();
  });

  test("queue-dispatch race: setGoal between enqueue and drain still rejects", async () => {
    // Simulates the exact bypass Codex flagged:
    //   1. No goal set, send is enqueued with an unpriced model (initial WS
    //      gate would have passed because no budgeted goal existed).
    //   2. While the dispatch is pending, a budgeted goal is set.
    //   3. The queued send drains via AgentSession.sendMessage and must hit
    //      the AS-level gate, which sees the now-budgeted goal and rejects.
    //
    // We exercise the AS-level gate directly by invoking sendMessage after
    // the goal mutation, which is the same code path sendQueuedMessages()
    // takes when it drains the queue.
    const workspaceId = "as-budget-gate-queue-race";
    const { historyService, session, goalService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    // Step 1: no goal yet — a priced send works fine.
    const baselineResult = await session.sendMessage("Baseline", PRICED_OPTIONS);
    expect(baselineResult.success).toBe(true);

    // Step 2: budgeted goal appears mid-flight (between enqueue and drain).
    await setGoalOk(goalService, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 500,
    });

    // Step 3: the previously-queued unpriced send now drains. The AS gate
    // re-evaluates with the freshly-budgeted goal and rejects.
    const queuedText = "Queued unpriced";
    const racedResult = await session.sendMessage(queuedText, UNPRICED_OPTIONS);
    expect(racedResult.success).toBe(false);
    if (!racedResult.success) {
      expect(racedResult.error.type).toBe("unknown");
      if (racedResult.error.type === "unknown") {
        expect(racedResult.error.raw).toContain("Target model has no pricing data");
      }
    }

    // The user's typed input must NOT be silently lost: even though the
    // queue-dispatch caller has already cleared the queue by the time we get
    // here, AS.sendMessage persists the message + emits a stream-error so
    // there's a chat-history record of what happened.
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      const queuedUserMessage = history.data.find(
        (m) =>
          m.role === "user" &&
          m.parts.some((p) => p.type === "text" && (p as { text: string }).text === queuedText)
      );
      expect(queuedUserMessage).toBeDefined();
    }
    await session.dispose();
  });
});
