import type { TurnStreamHandle } from "./streamManager";
import type { StreamEndEvent } from "@/common/types/stream";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
import {
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_KIND,
} from "@/constants/goals";
import { waitForCondition } from "./testDispatchHelpers";
import { IdleDispatcher } from "./idleDispatcher";
import { createFailedTurnHandle, createStartedTurnHandle } from "./agentSession.testHarness";

const PROJECT_PATH = "/tmp/mux-agent-session-goal-test-project";
const SEND_OPTIONS: SendMessageOptions = { model: "openai:gpt-4o", agentId: "exec" };

interface SessionHarness {
  historyService: HistoryService;
  session: AgentSession;
  goalService: WorkspaceGoalService;
  extensionMetadata: ExtensionMetadataService;
  aiService: AIService & EventEmitter;
  analytics: { recordGoalLifecycleEvent: ReturnType<typeof mock> };
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

function createAiService(
  workspaceId: string,
  getClosingSignal: () => AbortSignal
): AIService & EventEmitter {
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
  }) as unknown as AIService & EventEmitter;
}

async function createSessionHarness(workspaceId: string): Promise<SessionHarness> {
  const { historyService, config, cleanup } = await createTestHistoryService();
  await config.addWorkspace(PROJECT_PATH, {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux-agent-session-goal-test-project",
    projectPath: PROJECT_PATH,
    runtimeConfig: { type: "local" },
  });

  const extensionMetadata = new ExtensionMetadataService(
    `${config.rootDir}/agent-session-goal-extension-metadata.json`
  );
  const analytics = { recordGoalLifecycleEvent: mock(() => undefined) };
  const goalService = new WorkspaceGoalService(
    config,
    historyService,
    extensionMetadata,
    analytics
  );
  const initStateManager = Object.assign(new EventEmitter(), {
    replayInit: mock((_workspaceId: string) => Promise.resolve()),
  }) as unknown as InitStateManager;
  const backgroundProcessManager = {
    cleanup: mock((_workspaceId: string) => Promise.resolve()),
    setMessageQueued: mock((_workspaceId: string, _queued: boolean) => undefined),
  } as unknown as BackgroundProcessManager;

  const aiService = createAiService(workspaceId, () => session.closingSignal);
  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
    workspaceGoalService: goalService,
  });

  return { historyService, session, goalService, extensionMetadata, aiService, analytics, cleanup };
}

describe("AgentSession goal safety hooks", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test.each([false, true])(
    "token-budget rejection applies goal safety only to actionable manual intervention (synthetic=%s)",
    async (synthetic) => {
      const workspaceId = `budget-rejection-goal-${synthetic}`;
      const { session, goalService, aiService, cleanup } = await createSessionHarness(workspaceId);
      cleanups.push(cleanup);
      const stream = spyOn(aiService, "streamMessage");
      const candidates = registerBusyKickoffConsumer(goalService);
      await setGoalOk(goalService, { workspaceId, objective: "Keep working until interrupted" });
      await goalService.requireUserAcknowledgment(workspaceId, 55_000);
      expect(candidates.has(workspaceId)).toBe(true);
      const result = await session.sendMessage(
        "Oversized intervention ".repeat(40_000),
        {
          ...SEND_OPTIONS,
          experiments: { tokenBudget: true },
        },
        synthetic ? { synthetic: true, agentInitiated: true } : undefined
      );
      expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        status: synthetic ? "active" : "paused",
        requireUserAcknowledgmentSinceMs: synthetic ? 55_000 : null,
      });
      expect(candidates.has(workspaceId)).toBe(synthetic);
      expect(stream).not.toHaveBeenCalled();
      await session.dispose();
    }
  );

  test("blank token-budget sends do not acknowledge or pause an active goal", async () => {
    const workspaceId = "blank-budget-rejection-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Continue working" });
    await goalService.requireUserAcknowledgment(workspaceId, 55_000);
    expect(
      (await session.sendMessage(" ", { ...SEND_OPTIONS, experiments: { tokenBudget: true } }))
        .success
    ).toBe(false);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: 55_000,
    });
    await session.dispose();
  });

  test("manual user messages pause active goals by default", async () => {
    const workspaceId = "manual-pauses-active-goal-by-default";
    const { session, goalService, analytics, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    const result = await session.sendMessage("I need to pause this goal with a note", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "auto" })
    );
    await session.dispose();
  });

  test("manual user messages can explicitly pause active goals", async () => {
    const workspaceId = "manual-pauses-active-goal";
    const { session, goalService, analytics, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    const result = await session.sendMessage("I need to pause this goal", {
      ...SEND_OPTIONS,
      goalInterventionPolicy: "pause",
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "auto" })
    );
    await session.dispose();
  });

  for (const status of [
    "paused",
    "budget_limited",
    "complete",
  ] as const satisfies readonly GoalStatus[]) {
    test(`manual user messages leave ${status} goals unchanged`, async () => {
      const workspaceId = `manual-leaves-${status.replace("_", "-")}`;
      const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
      cleanups.push(cleanup);
      const seeded = await setGoalOk(goalService, {
        workspaceId,
        objective: `Goal already ${status}`,
        status,
        ...(status === "budget_limited" ? { budgetCents: 100 } : {}),
        ...(status === "complete" ? { completionSummary: "Finished already." } : {}),
      });
      if (status === "budget_limited") {
        await goalService.recordStreamAccounting({
          workspaceId,
          costUsd: 1,
          streamStartedAtMs: seeded.createdAtMs + 1,
          streamOriginKind: "goal_continuation",
        });
      }

      const result = await session.sendMessage("Manual follow-up", SEND_OPTIONS);

      expect(result.success).toBe(true);
      expect(await goalService.getGoal(workspaceId)).toMatchObject({ status });
      await session.dispose();
    });
  }

  test("a same-goal budget-limit transition during acknowledgment still suppresses the wrap-up", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cNQvL): acknowledgeUser can return goal A as
    // active while a queued child-attribution or budget edit then moves A to
    // budget_limited. The stale status skips the suppression branch, and the
    // auto-pause is rejected (budget-limited goals cannot pause) — without a
    // recheck the manual stream-end re-arms the autonomous wrap-up despite
    // the user's intervention. The pause-failure path must suppress against
    // the same goal identity.
    const workspaceId = "budget-limit-races-acknowledgment";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Races into budget_limited",
      budgetCents: 100,
    });

    const realAcknowledge = goalService.acknowledgeUser.bind(goalService);
    const ackSpy = spyOn(goalService, "acknowledgeUser").mockImplementationOnce(
      async (...args: Parameters<WorkspaceGoalService["acknowledgeUser"]>) => {
        const snapshot = await realAcknowledge(...args);
        expect(snapshot).toMatchObject({ status: "active" });
        // Same-goal transition landing after the stale-active snapshot.
        await goalService.recordStreamAccounting({
          workspaceId,
          costUsd: 2,
          streamStartedAtMs: created.createdAtMs + 1,
          streamOriginKind: "goal_continuation",
        });
        return snapshot;
      }
    );

    // Invoke the hook directly: in the sendMessage flow the manual row would
    // already reconcile the goal to paused before acknowledgment, hiding the
    // stale-active window this race needs.
    const sessionAccess = session as unknown as {
      applyManualUserMessageGoalSafety: (input: {
        policy: "pause" | "steer";
        enqueuedAtMs?: number;
      }) => Promise<void>;
    };
    await sessionAccess.applyManualUserMessageGoalSafety({ policy: "pause" });
    ackSpy.mockRestore();

    // The wrap-up is durably suppressed despite the stale-active snapshot.
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "budget_limited",
      budgetLimitOriginKind: "user",
    });
    await session.dispose();
  });

  test("a paused goal vetoes a redispatched compaction follow-up continuation", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): the compaction handoff preserves the
    // continuation's goal identity but not its original requireIdle /
    // admissionStale guards. An explicit Pause persisted while the compaction
    // stream ran must veto the redispatch instead of letting the synthetic
    // row land after the pause boundary as fresh active evidence.
    const workspaceId = "compaction-followup-paused-veto";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Paused during compaction",
    });
    // Pause persists first (its boundary row lands), then the compaction
    // summary carrying the goal-scoped follow-up commits.
    await setGoalOk(goalService, { workspaceId, status: "paused" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        timestamp: Date.now(),
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            agentInitiated: true,
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: created.goalId,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);

    const sendSpy = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );
    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();
    sendSpy.mockRestore();

    // Vetoed: nothing dispatched, and the stale follow-up was cleared so it
    // cannot re-fire on a later recovery pass.
    expect(dispatched).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    const tail = await historyService.getLastMessages(workspaceId, 1);
    expect(tail.success).toBe(true);
    if (tail.success) {
      const meta = tail.data[0]?.metadata?.muxMetadata;
      expect(meta && "pendingFollowUp" in meta ? meta.pendingFollowUp : undefined).toBeUndefined();
    }
    await session.dispose();
  });

  test("a manual message queued during redispatch preflight vetoes the follow-up", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cQt3j): the idle sample taken at entry ages
    // across the awaited goal read; a manual message queued in that window
    // must win instead of waiting behind the synthetic follow-up's stream.
    const workspaceId = "compaction-followup-queued-mid-preflight";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Idle race" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: created.goalId,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);

    // The entry idle check passes (queue empty); the manual message lands
    // during the awaited admission read, after that sample.
    const realBuild = goalService.buildGoalRedispatchAdmission.bind(goalService);
    const buildSpy = spyOn(goalService, "buildGoalRedispatchAdmission").mockImplementationOnce(
      async (...args: Parameters<typeof realBuild>) => {
        const admission = await realBuild(...args);
        session.queueMessage("user returned mid-preflight", SEND_OPTIONS, { synthetic: false });
        return admission;
      }
    );

    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();
    buildSpy.mockRestore();

    expect(dispatched).toBe(false);
    const history = await historyService.getLastMessages(workspaceId, 10);
    expect(history.success).toBe(true);
    if (history.success) {
      // The synthetic follow-up row was refused (and rolled back), and the
      // summary dropped its pending follow-up so it cannot re-fire later.
      expect(
        history.data.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "Continue working on the goal."
          )
        )
      ).toBe(false);
      const meta = history.data.find((message) => message.id === summary.id)?.metadata?.muxMetadata;
      expect(meta && "pendingFollowUp" in meta ? meta.pendingFollowUp : undefined).toBeUndefined();
    }
    await session.dispose();
  });

  test("a service-level send preflight defers redispatched follow-ups", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cRJD-): a manual WorkspaceService send can be
    // counted in preflight without queueing or holding the turn phase. The
    // entry idle check must consult the injected probe.
    const workspaceId = "compaction-followup-service-preflight";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Preflight race" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: created.goalId,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
    (session as unknown as { hasExternalSendPreflight?: () => boolean }).hasExternalSendPreflight =
      () => true;
    const sendSpy = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    const tail = await historyService.getLastMessages(workspaceId, 1);
    expect(tail.success).toBe(true);
    if (tail.success) {
      const meta = tail.data[0]?.metadata?.muxMetadata;
      expect(meta && "pendingFollowUp" in meta ? meta.pendingFollowUp : undefined).toBeUndefined();
    }
    sendSpy.mockRestore();
    await session.dispose();
  });

  test("a service preflight starting mid-redispatch flips the live admission probe", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cRJD-): the preflight can also begin AFTER
    // the entry sample, during the awaited goal read — the live probe carried
    // through the send-admission gates must observe it.
    const workspaceId = "compaction-followup-preflight-mid-read";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Late preflight" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: created.goalId,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);

    let preflightActive = false;
    (session as unknown as { hasExternalSendPreflight?: () => boolean }).hasExternalSendPreflight =
      () => preflightActive;
    const realBuild = goalService.buildGoalRedispatchAdmission.bind(goalService);
    const buildSpy = spyOn(goalService, "buildGoalRedispatchAdmission").mockImplementationOnce(
      async (...args: Parameters<typeof realBuild>) => {
        const admission = await realBuild(...args);
        preflightActive = true;
        return admission;
      }
    );

    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();
    buildSpy.mockRestore();

    expect(dispatched).toBe(false);
    const history = await historyService.getLastMessages(workspaceId, 10);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(
        history.data.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "Continue working on the goal."
          )
        )
      ).toBe(false);
    }
    await session.dispose();
  });

  test("a recovered budget wrap-up follow-up installs its missing reservation", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cRJEE): a crash between wrap-up send
    // acceptance and tryMarkBudgetLimitInjected leaves the goal unmarked.
    // The redispatched follow-up must install the reservation or the
    // recovered stream's end arms a second wrap-up.
    const workspaceId = "compaction-followup-wrapup-reservation";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Recover the owed wrap-up",
      budgetCents: 100,
    });
    await goalService.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Wrap up the budget-limited goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            goalKind: GOAL_BUDGET_LIMIT_KIND,
            goalId: created.goalId,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
    const sendSpy = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();

    expect(dispatched).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
    sendSpy.mockRestore();
    await session.dispose();
  });

  test("malformed persisted follow-up goal IDs are discarded during recovery", async () => {
    const workspaceId = "compaction-followup-malformed-goal-id";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Recover safely" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: { malformed: true } as unknown as string,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
    const sendSpy = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    const tail = await historyService.getLastMessages(workspaceId, 1);
    expect(tail.success).toBe(true);
    if (tail.success) {
      const meta = tail.data[0]?.metadata?.muxMetadata;
      expect(meta && "pendingFollowUp" in meta ? meta.pendingFollowUp : undefined).toBeUndefined();
    }
    sendSpy.mockRestore();
    await session.dispose();
  });

  test("synthetic messages do not auto-pause active goals", async () => {
    const workspaceId = "synthetic-does-not-pause";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep looping" });

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("queued manual messages that predate the goal do not pause it", async () => {
    // Queue race: the user types while the goal-creating turn is still
    // streaming; the model's set_goal applies at stream end, and only then
    // does the queued message dispatch. It must not pause a goal the user had
    // not seen (observed as goals "paused by heartbeats" half a second after
    // creation).
    const workspaceId = "queued-predates-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    // Strictly earlier than the activation stamp: equality fails closed
    // (Codex P2 PRRT_kwDOPxxmWM6cS8Bu).
    const enqueuedAtMs = Date.now() - 10;
    const created = await setGoalOk(goalService, { workspaceId, objective: "Fresh goal" });
    expect(created.createdAtMs).toBeGreaterThan(enqueuedAtMs);

    const result = await session.sendMessage("Queued before the goal existed", SEND_OPTIONS, {
      enqueuedAtMs,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("same-millisecond activation and message authoring fail closed to pause", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cS8Bu): millisecond timestamps cannot order an
    // activation against a message authored in the same millisecond, so
    // equality cannot prove the message was already pending when the user
    // activated — fail closed into the pause.
    const workspaceId = "consent-equal-millisecond";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Equal ms" });
    if (created.lastUserActivationAtMs == null) {
      throw new Error("expected a user-created goal to carry an activation stamp");
    }

    const result = await session.sendMessage("Same instant", SEND_OPTIONS, {
      enqueuedAtMs: created.lastUserActivationAtMs,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    await session.dispose();
  });

  test("a legacy goal follow-up without goal identity is discarded", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cS8Bq): pre-upgrade compaction summaries
    // persisted goalKind without any goalId field, so the durable admission
    // revalidation cannot scope them — goal A could be replaced while the
    // summary sat at the tail and its captured objective would redispatch as
    // an unscoped synthetic turn charged to the current goal. Fail closed.
    const workspaceId = "compaction-followup-legacy-unscoped";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Current goal" });
    const summary = createMuxMessage(
      `summary-${crypto.randomUUID()}`,
      "assistant",
      "Compacted conversation.",
      {
        timestamp: Date.now(),
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue working on the goal.",
            agentId: "exec",
            model: "openai:gpt-4o",
            agentInitiated: true,
            goalKind: GOAL_CONTINUATION_KIND,
          },
        },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);

    const sendSpy = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );
    const dispatched = await (
      session as unknown as { dispatchPendingFollowUp: (id?: string) => Promise<boolean> }
    ).dispatchPendingFollowUp();
    sendSpy.mockRestore();

    expect(dispatched).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    const tail = await historyService.getLastMessages(workspaceId, 1);
    expect(tail.success).toBe(true);
    if (tail.success) {
      const meta = tail.data[0]?.metadata?.muxMetadata;
      expect(meta && "pendingFollowUp" in meta ? meta.pendingFollowUp : undefined).toBeUndefined();
    }
    await session.dispose();
  });

  test("queued messages predating a model-created goal still pause it", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cSGrq): a model can publish a goal
    // AFTER the user queued a stop/correction, so timestamp order alone must
    // not shield the fresh goal's autonomy from the any-manual-turn-pauses
    // boundary. Only an explicit user activation is consent; model-created
    // goals carry no consent stamp and fail closed into the pause.
    const workspaceId = "queued-predates-model-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const enqueuedAtMs = Date.now();
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Model-published goal",
      initiator: "model",
    });
    expect(created.createdAtMs).toBeGreaterThanOrEqual(enqueuedAtMs);

    const result = await session.sendMessage("Stop what you are doing", SEND_OPTIONS, {
      enqueuedAtMs,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    await session.dispose();
  });

  test("a user Resume is consent for messages authored before it", async () => {
    // The consent anchor is the explicit user activation, not goal creation:
    // clicking Resume with a message already pending is a genuine opt-in, so
    // the queued message must not instantly re-pause the resumed goal.
    const workspaceId = "resume-consent-queue-race";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Resumable goal" });
    await setGoalOk(goalService, { workspaceId, status: "paused", initiator: "user" });
    const enqueuedAtMs = Date.now();
    // Strictly-later activation: equality fails closed (Codex P2
    // PRRT_kwDOPxxmWM6cS8Bu), so step past the sampled millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const resumed = await setGoalOk(goalService, {
      workspaceId,
      status: "active",
      initiator: "user",
    });
    expect(resumed.lastUserActivationAtMs).toBeGreaterThan(enqueuedAtMs);

    const result = await session.sendMessage("Queued before the resume", SEND_OPTIONS, {
      enqueuedAtMs,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("queued manual messages enqueued after goal creation still pause it", async () => {
    const workspaceId = "queued-postdates-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Existing goal" });

    const result = await session.sendMessage("Typed with the goal in view", SEND_OPTIONS, {
      enqueuedAtMs: created.createdAtMs + 1,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    await session.dispose();
  });

  // Shared harness for the candidate-suspension tests: a busy runtime keeps
  // eligibility deferring so armed kickoff candidates stay inspectable instead
  // of being consumed by a live dispatch.
  function registerBusyKickoffConsumer(goalService: WorkspaceGoalService): Map<string, unknown> {
    goalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve(SEND_OPTIONS),
    });
    return (goalService as unknown as { pendingContinuationCandidates: Map<string, unknown> })
      .pendingContinuationCandidates;
  }

  test("acknowledgment failure still clears the kickoff candidate", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b-Uln): the manual row is durably appended
    // before goal safety runs. If acknowledgeUser() throws (goal /
    // extension-metadata write failure), the pre-goal queue-race guard can
    // never prove the message predates the goal, so the kickoff candidate must
    // stay cleared conservatively — a stale candidate could otherwise dispatch
    // a continuation against the user's persisted intervention once the failed
    // send returns the workspace to idle. The candidate is taken synchronously
    // before the acknowledgment await (Codex P1 PRRT_kwDOPxxmWM6cClKd), so a
    // throw leaves it cleared without a separate clear call.
    const workspaceId = "ack-failure-clears-candidate";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const candidates = registerBusyKickoffConsumer(goalService);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Fresh goal" });
    expect(candidates.has(workspaceId)).toBe(true);

    spyOn(goalService, "acknowledgeUser").mockImplementation(() =>
      Promise.reject(new Error("goal write failed"))
    );

    let thrown: unknown = null;
    try {
      await session.sendMessage("Manual intervention", SEND_OPTIONS, {
        enqueuedAtMs: created.createdAtMs + 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(candidates.has(workspaceId)).toBe(false);
    await session.dispose();
  });

  test("kickoff candidate is not consumable while a manual send is classified", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKd): a direct send appends its durable row
    // before the session reports busy, so an eligibility check running during
    // the acknowledgment await must not find (and consume) the kickoff
    // candidate — it would dispatch a continuation against the user's
    // intervention.
    const workspaceId = "manual-classification-suspends-candidate";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const candidates = registerBusyKickoffConsumer(goalService);
    const created = await setGoalOk(goalService, { workspaceId, objective: "Fresh goal" });
    expect(candidates.has(workspaceId)).toBe(true);

    const originalAcknowledge = goalService.acknowledgeUser.bind(goalService);
    let eligibilityDuringAck: string | undefined;
    spyOn(goalService, "acknowledgeUser").mockImplementation(async (id: string) => {
      // Runs mid-classification: the candidate must already be suspended.
      const eligibility = await goalService.checkGoalContinuationEligibility(id, Date.now());
      eligibilityDuringAck = eligibility.eligible ? "eligible" : eligibility.reason;
      return originalAcknowledge(id);
    });

    const result = await session.sendMessage("Typed with the goal in view", SEND_OPTIONS, {
      enqueuedAtMs: created.createdAtMs + 1,
    });

    expect(result.success).toBe(true);
    expect(eligibilityDuringAck).toBe("no_pending_candidate");
    expect(candidates.has(workspaceId)).toBe(false);
    await session.dispose();
  });

  test("delayed pre-stop sends do not clear a newer stop's acknowledgment gate", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cECpj): a pre-goal send stuck in preflight
    // until after a user stop must not acknowledge that stop. Clearing the
    // durable requireUserAcknowledgmentSinceMs gate here would let restart
    // recovery re-arm the active goal despite the newer Stop action (the
    // in-memory stop timestamp does not survive restarts).
    const workspaceId = "pre-stop-send-keeps-gate";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    // Strictly earlier than the activation stamp: equality fails closed
    // (Codex P2 PRRT_kwDOPxxmWM6cS8Bu).
    const enqueuedAtMs = Date.now() - 10;
    const created = await setGoalOk(goalService, { workspaceId, objective: "Fresh goal" });
    await goalService.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);

    const result = await session.sendMessage("Queued before the goal existed", SEND_OPTIONS, {
      enqueuedAtMs,
    });

    expect(result.success).toBe(true);
    // Pre-goal classification keeps the goal active, but the stop's gate must
    // survive so continuations stay blocked until the user acknowledges.
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    const goal = await goalService.getGoal(workspaceId);
    expect(goal?.requireUserAcknowledgmentSinceMs).not.toBeNull();
    await session.dispose();
  });

  test("pre-goal queued sends restore the suspended kickoff candidate", async () => {
    // Complement to the suspension test above: a queued send authored before
    // the goal existed is not an intervention, so the taken candidate must be
    // restored and the fresh goal must keep its kickoff continuation.
    const workspaceId = "pre-goal-restores-candidate";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const candidates = registerBusyKickoffConsumer(goalService);
    // Strictly earlier than the activation stamp: equality fails closed
    // (Codex P2 PRRT_kwDOPxxmWM6cS8Bu).
    const enqueuedAtMs = Date.now() - 10;
    const created = await setGoalOk(goalService, { workspaceId, objective: "Fresh goal" });
    expect(created.createdAtMs).toBeGreaterThan(enqueuedAtMs);
    expect(candidates.has(workspaceId)).toBe(true);

    const result = await session.sendMessage("Queued before the goal existed", SEND_OPTIONS, {
      enqueuedAtMs,
    });

    expect(result.success).toBe(true);
    expect(candidates.has(workspaceId)).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("manual user messages are no-ops when no goal exists", async () => {
    const workspaceId = "manual-no-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    const result = await session.sendMessage("No goal yet", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toBeNull();
    await session.dispose();
  });

  test("manual user messages clear acknowledgment flags while pausing by default", async () => {
    const workspaceId = "manual-clears-ack";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Wait for acknowledgment" });
    await goalService.requireUserAcknowledgment(workspaceId, 55_000);

    const result = await session.sendMessage("Acknowledged", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "paused",
      requireUserAcknowledgmentSinceMs: null,
    });
    await session.dispose();
  });

  test("synthetic messages do not clear acknowledgment flags", async () => {
    const workspaceId = "synthetic-does-not-clear-ack";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Still needs acknowledgment" });
    await goalService.requireUserAcknowledgment(workspaceId, 66_000);

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: 66_000,
    });
    await session.dispose();
  });

  test("stream errors restore durable goal snapshot after live cost preview", async () => {
    const workspaceId = "stream-error-restores-goal-preview";
    const { session, goalService, extensionMetadata, aiService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    goalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: () => Promise.resolve(true),
    });
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Restore preview on error",
      budgetCents: 1_000,
    });
    // Capture goal-related activity snapshots. `previewStreamAccounting`
    // is transient and intentionally does NOT touch
    // extensionMetadata.json or goal.json — the UI receives the preview
    // through the activity stream instead, which we observe here.
    const activitySnapshots: Array<{
      goal?: { costCents?: number } | null;
      transientGoalOnly?: boolean;
    }> = [];
    goalService.setOnActivityChange((_workspaceId, snapshot) => {
      activitySnapshots.push(snapshot);
    });
    const failedStreamStartedAtMs = created.createdAtMs + 1;
    await goalService.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: failedStreamStartedAtMs,
    });
    expect(activitySnapshots.at(-1)).toMatchObject({
      transientGoalOnly: true,
      goal: { costCents: 125 },
    });
    // The durable record stays untouched by the preview.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 1_000 },
    });

    aiService.streamMessage = mock(() => {
      aiService.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-stream-error",
        model: SEND_OPTIONS.model,
        startTime: failedStreamStartedAtMs,
      });
      aiService.emit("error", {
        workspaceId,
        messageId: "assistant-stream-error",
        error: "boom",
        errorType: "unknown",
      });
      return Promise.resolve(
        Ok(
          createFailedTurnHandle("assistant-stream-error", { error: "boom", errorType: "unknown" })
        )
      );
    }) as unknown as AIService["streamMessage"];
    const eventTypes: string[] = [];
    session.onChatEvent((event) => {
      eventTypes.push(event.message.type);
    });

    await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    await waitForCondition(() => eventTypes.includes("stream-error"), { timeoutMs: 1_000 });

    // After the error, restoreGoalAccountingSnapshot re-emits the durable
    // goal so any UI that displayed the preview reverts to canonical
    // costs. We assert via both the persisted snapshot and the activity
    // stream because the preview never persisted in the first place.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 1_000 },
    });
    expect(activitySnapshots.at(-1)?.goal).toMatchObject({ costCents: 0 });

    expect(
      await goalService.previewStreamAccounting({
        workspaceId,
        costUsd: 1.25,
        streamStartedAtMs: failedStreamStartedAtMs,
      })
    ).toBeNull();

    const budgetEditAfterFailure = await setGoalOk(goalService, {
      workspaceId,
      budgetCents: 2_000,
    });
    expect(budgetEditAfterFailure).toMatchObject({ costCents: 0, budgetCents: 2_000 });
    expect(activitySnapshots.at(-1)).toMatchObject({
      goal: { costCents: 0, budgetCents: 2_000 },
    });
    expect(activitySnapshots.at(-1)?.transientGoalOnly).toBeUndefined();
    await session.dispose();
  });

  test("startup recovery gates goal continuations when an assistant partial is restored", async () => {
    const workspaceId = "crash-gates-goal";
    const { session, goalService, historyService, analytics, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Recover safely" });
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-crash", "user", "Start risky work", {
        timestamp: 1,
        retrySendOptions: SEND_OPTIONS,
      })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 1 })
    );

    await session.runStartupRecovery();

    const recoveredGoal = await goalService.getGoal(workspaceId);
    expect(typeof recoveredGoal?.requireUserAcknowledgmentSinceMs).toBe("number");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.objectContaining({ workspaceIdLengthBucket: "10-49" })
    );
    await session.dispose();
  });

  test("startup recovery ignores restored assistant partials when no goal exists", async () => {
    const workspaceId = "crash-no-goal";
    const { session, goalService, historyService, analytics, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 0 })
    );

    await session.runStartupRecovery();

    expect(await goalService.getGoal(workspaceId)).toBeNull();
    expect(analytics.recordGoalLifecycleEvent).not.toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.any(Object)
    );
    await session.dispose();
  });

  test("manual acknowledgment clears stale gated continuations after restart", async () => {
    const workspaceId = "restart-gated-continuation";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Continue after restart" });
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-crash", "user", "Start work", {
        timestamp: 1,
        retrySendOptions: SEND_OPTIONS,
      })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 1 })
    );
    await session.runStartupRecovery();

    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    goalService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: execute,
    });

    await goalService.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: SEND_OPTIONS,
      streamEndedAtMs: 100_000,
    });
    expect(execute).not.toHaveBeenCalled();

    const manualResult = await session.sendMessage("I saw the recovered response", SEND_OPTIONS);
    expect(manualResult.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "paused",
      requireUserAcknowledgmentSinceMs: null,
    });

    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
    await session.dispose();
  });

  // Auto-completion fallback for the "agent ended a goal-continuation turn
  // with a text-only response (no tool calls)" bug. The continuation prompt
  // asks the agent to call `complete_goal`, but real models sometimes finish
  // with a plain "looks done" reply instead — without this fallback the
  // continuation loop would re-fire on the same idle output until budget
  // or cooldown gates intervene.

  function emitStreamEnd(
    aiService: AIService & EventEmitter,
    workspaceId: string,
    messageId: string,
    parts: StreamEndEvent["parts"],
    options?: { finishReason?: string }
  ): TurnStreamHandle {
    const payload: StreamEndEvent = {
      type: "stream-end",
      workspaceId,
      messageId,
      parts,
      metadata: {
        model: "openai:gpt-4o",
        contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        providerMetadata: {},
        // Default to a clean natural stop so the silent-continuation
        // auto-complete gate matches; individual tests override to
        // exercise truncated / non-stop paths.
        finishReason: options?.finishReason ?? "stop",
      },
    };
    aiService.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId,
      model: "openai:gpt-4o",
      startTime: Date.now(),
    });
    aiService.emit("stream-end", payload);
    return { messageId, completion: Promise.resolve({ status: "completed", streamEnd: payload }) };
  }

  test("text-only stream-end during a goal_continuation turn auto-completes the goal", async () => {
    const workspaceId = "silent-continuation-completes";
    const { session, goalService, aiService, analytics, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Wrap things up" });

    aiService.streamMessage = mock(() => {
      const handle = emitStreamEnd(aiService, workspaceId, "assistant-silent", [
        { type: "text", text: "I believe everything is done already." },
      ]);
      return Promise.resolve(Ok(handle));
    }) as unknown as AIService["streamMessage"];

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(true);

    // Wait for the async stream-end handler to dispatch the synthesized
    // `complete_goal` mutation. The analytics emission is synchronous
    // relative to `setGoal` succeeding, so it's the cleanest sync flag
    // for `waitForCondition`.
    await waitForCondition(
      () =>
        analytics.recordGoalLifecycleEvent.mock.calls.some((call) => call[0] === "goal_completed"),
      { timeoutMs: 1_000 }
    );
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "complete",
      completionSummary: "I believe everything is done already.",
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "model" })
    );
    await session.dispose();
  });

  test("stream-end with a dynamic-tool part leaves an active goal active", async () => {
    const workspaceId = "tool-call-keeps-goal-active";
    const { session, goalService, aiService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    aiService.streamMessage = mock(() => {
      const handle = emitStreamEnd(aiService, workspaceId, "assistant-acted", [
        { type: "text", text: "Let me check the file first." },
        {
          type: "dynamic-tool",
          state: "output-available",
          toolCallId: "tool-read",
          toolName: "read_file",
          input: { path: "src/index.ts" },
          output: { ok: true },
        },
      ]);
      return Promise.resolve(Ok(handle));
    }) as unknown as AIService["streamMessage"];

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(true);

    // Give the stream-end handler a tick to settle before asserting "no change".
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("text-only stream-end on a manual user message does not auto-complete the goal", async () => {
    const workspaceId = "manual-text-only-no-autocomplete";
    const { session, goalService, aiService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep going" });

    aiService.streamMessage = mock(() => {
      const handle = emitStreamEnd(aiService, workspaceId, "assistant-text-only", [
        { type: "text", text: "Just thinking out loud." },
      ]);
      return Promise.resolve(Ok(handle));
    }) as unknown as AIService["streamMessage"];

    // Manual user messages now pause active goals because the goal mode is
    // locked to the latest user message kind. The point of this test is that
    // silent-continuation auto-completion still does NOT fire on manual turns:
    // `activeStreamContext.goalKind` is undefined on a manual send, so the
    // silent-completion gate (`goalKind === GOAL_CONTINUATION_KIND`)
    // short-circuits and status stays `paused`, not `complete`.
    const result = await session.sendMessage("Manual question", SEND_OPTIONS);
    expect(result.success).toBe(true);

    // Give the async stream-end handler a tick to run so any stray
    // auto-completion would have a chance to corrupt the paused state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    await session.dispose();
  });

  test("length-truncated text-only stream-end does not auto-complete the goal", async () => {
    // Codex review feedback (#3326 PRRT_kwDOPxxmWM6DAGFi): when the provider
    // hits the output-token limit, the turn has text + no tools but was
    // truncated, not finished. Marking it complete would lose work. The
    // helper requires `finishReason === "stop"` so length-truncated turns
    // keep the goal active and can resume on the next continuation.
    const workspaceId = "length-truncated-stays-active";
    const { session, goalService, aiService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    aiService.streamMessage = mock(() => {
      const handle = emitStreamEnd(
        aiService,
        workspaceId,
        "assistant-truncated",
        [{ type: "text", text: "Mid-sentence, then cut off by the token limit" }],
        { finishReason: "length" }
      );
      return Promise.resolve(Ok(handle));
    }) as unknown as AIService["streamMessage"];

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await session.dispose();
  });

  test("text-only goal_continuation turn can complete a resumed paused goal", async () => {
    const workspaceId = "silent-continuation-paused";
    const { session, goalService, aiService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    const seeded = await setGoalOk(goalService, {
      workspaceId,
      objective: "Already paused",
    });
    await setGoalOk(goalService, {
      workspaceId,
      status: "paused",
      expectedGoalId: seeded.goalId,
    });

    aiService.streamMessage = mock(() => {
      const handle = emitStreamEnd(aiService, workspaceId, "assistant-paused-silent", [
        { type: "text", text: "All wrapped up." },
      ]);
      return Promise.resolve(Ok(handle));
    }) as unknown as AIService["streamMessage"];

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    expect(result.success).toBe(true);

    await waitForCondition(
      async () => (await goalService.getGoal(workspaceId))?.status === "complete",
      { timeoutMs: 5_000 }
    );
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "complete",
      completionSummary: "All wrapped up.",
    });
    await session.dispose();
  });
});
