import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService, type GoalContinuationRuntimeBridge } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
import {
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_KIND,
} from "@/constants/goals";
import { createMuxMessage } from "@/common/types/message";
// Shared dispatch helpers live in `./testDispatchHelpers` instead of local
// copies so future callers cannot drift.
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";

function captureGoalActivity(service: WorkspaceGoalService) {
  const snapshots: Array<
    NonNullable<Awaited<ReturnType<ExtensionMetadataService["getSnapshot"]>>>
  > = [];
  service.setOnActivityChange((_workspaceId, snapshot) => snapshots.push(snapshot));
  return snapshots;
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

async function appendUserHistoryMessage(
  historyService: HistoryService,
  workspaceId: string,
  text: string,
  metadata: Parameters<typeof createMuxMessage>[3] = { timestamp: Date.now() }
): Promise<void> {
  const result = await historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`goal-test-user-${crypto.randomUUID()}`, "user", text, metadata)
  );
  expect(result.success).toBe(true);
}

async function appendAssistantHistoryMessage(
  historyService: HistoryService,
  workspaceId: string,
  text: string,
  metadata: Parameters<typeof createMuxMessage>[3] = { timestamp: Date.now() }
): Promise<void> {
  const result = await historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`goal-test-assistant-${crypto.randomUUID()}`, "assistant", text, metadata)
  );
  expect(result.success).toBe(true);
}

async function getLastUserHistoryMessage(historyService: HistoryService, workspaceId: string) {
  const history = await historyService.getLastMessages(workspaceId, 20);
  expect(history.success).toBe(true);
  if (!history.success) {
    throw new Error(history.error);
  }
  return [...history.data].reverse().find((message) => message.role === "user");
}

const PROJECT_PATH = "/tmp/mux-goal-service-test-project";

async function goalFileExists(config: Config, workspaceId: string): Promise<boolean> {
  try {
    await fs.access(path.join(config.sessionsDir, workspaceId, "goal.json"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function analyticsMock() {
  return { recordGoalLifecycleEvent: mock(() => undefined) };
}

function continuationBridge(
  executeGoalContinuation: GoalContinuationRuntimeBridge["executeGoalContinuation"] = () =>
    Promise.resolve(true)
): GoalContinuationRuntimeBridge {
  return {
    hasActiveDescendantTasks: () => false,
    getRuntimeState: () => ({ isRuntimeCompatible: true }),
    executeGoalContinuation,
  };
}

describe("WorkspaceGoalService", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let extensionMetadata: ExtensionMetadataService;
  let service: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-parent";

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await config.addWorkspace(PROJECT_PATH, {
      id: workspaceId,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics);
  });

  afterEach(async () => {
    await cleanup();
  });

  test("does not write null activity snapshots for ordinary no-goal reads", async () => {
    // Goals are GA, so tool availability asks for the current goal on every
    // turn. No-goal reads must stay read-only; lifecycle paths that actually
    // clear/corrupt-repair a goal still publish explicit null snapshots.
    const setGoalSpy = spyOn(extensionMetadata, "setGoal");

    const goal = await service.getGoal(workspaceId);

    expect(goal).toBeNull();
    expect(setGoalSpy).not.toHaveBeenCalled();
    setGoalSpy.mockRestore();
  });

  test("creates, reads, and clears a goal while updating snapshots", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "  Ship goal primitive  " });

    expect(created.objective).toBe("Ship goal primitive");
    expect(created.status).toBe("active");
    expect(created.costCents).toBe(0);
    expect(await service.getGoal(workspaceId)).toEqual(created);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Ship goal primitive", status: "active" },
    });

    const cleared = await service.clearGoal(workspaceId);

    expect(cleared?.goalId).toBe(created.goalId);
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
    const history = await historyService.getLastMessages(workspaceId, 1);
    expect(history.success).toBe(true);
    if (!history.success) {
      throw new Error(history.error);
    }
    expect(history.data[0]?.metadata?.synthetic).toBe(true);
    // Hidden from the chat UI (the right-sidebar Goal Board already
    // shows cleared/completed goals). Still in the AI request payload
    // because synthetic + uiVisible:false stays in the model context.
    expect(history.data[0]?.metadata?.uiVisible).toBeUndefined();
    expect(history.data[0]?.parts[0]).toMatchObject({
      type: "text",
      text: 'Goal cleared: "Ship goal primitive" — spent $0.00 over 0 turns (status: active)',
    });

    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_created",
      expect.objectContaining({ objectiveLengthBucket: "10-49" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_cleared",
      expect.objectContaining({ finalStatus: "active" })
    );
  });

  test("clearing a completed goal surfaces it on the completed board", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Finishable goal" });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Wrapped up.",
    });
    await service.clearGoal(workspaceId);

    const board = await service.getGoalBoard(workspaceId);
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]).toMatchObject({
      section: "complete",
      goal: {
        goalId: created.goalId,
        status: "complete",
        completionSummary: "Wrapped up.",
      },
    });
  });

  test("getGoalBoard returns completed goals newest-first when endedAtMs ties", async () => {
    const ts = Date.now();
    const nowSpy = ts;
    const dateNow = spyOn(Date, "now").mockImplementation(() => nowSpy);
    try {
      const first = await setGoalOk(service, { workspaceId, objective: "First" });
      await setGoalOk(service, {
        workspaceId,
        objective: first.objective,
        status: "complete",
        completionSummary: "First done.",
      });
      await service.clearGoal(workspaceId);
      const second = await setGoalOk(service, { workspaceId, objective: "Second" });
      await setGoalOk(service, {
        workspaceId,
        objective: second.objective,
        status: "complete",
        completionSummary: "Second done.",
      });
      await service.clearGoal(workspaceId);

      const completed = (await service.getGoalBoard(workspaceId)).entries.filter(
        (entry) => entry.section === "complete"
      );
      expect(completed).toHaveLength(2);
      // Same-ms timestamps force the append-index tie-breaker; the second append wins.
      expect(completed[0].goal.goalId).toBe(second.goalId);
      expect(completed[1].goal.goalId).toBe(first.goalId);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("getGoalBoard tolerates corrupt JSONL lines without bricking completed goals", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Good entry" });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });
    await service.clearGoal(workspaceId);

    // Simulate a partially-written line from a prior crash. The board reader
    // must skip it instead of throwing.
    const historyPath = path.join(config.sessionsDir, workspaceId, "goal-history.jsonl");
    await fs.appendFile(historyPath, "{not-json}\n", "utf-8");

    const completed = (await service.getGoalBoard(workspaceId)).entries.filter(
      (entry) => entry.section === "complete"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ goal: { goalId: created.goalId } });
  });

  test("setGoal with editInPlace renames the current goal without resetting accounting", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Initial objective" });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    const renamed = await setGoalOk(service, {
      workspaceId,
      objective: "Refined objective",
      editInPlace: true,
    });

    // Same `goalId`, preserved accounting — this is the contract that makes
    // the inline editor behave like budget/turn-cap edits.
    expect(renamed.goalId).toBe(created.goalId);
    expect(renamed.objective).toBe("Refined objective");
    expect(renamed.costCents).toBeGreaterThan(0);
    expect(renamed.costCents).toBe(25);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: created.goalId },
    });
  });

  test("setGoal without editInPlace continues to archive + replace on objective change", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Initial objective" });
    const replaced = await setGoalOk(service, { workspaceId, objective: "Different objective" });

    // Replace flow: new goalId, with only the new active goal on the board.
    expect(replaced.goalId).not.toBe(created.goalId);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: replaced.goalId },
    });
  });

  test("editInPlace without a current goal still falls through to create", async () => {
    // Without a current goal, `editInPlace` has nothing to mutate. Falling
    // through to the normal create path keeps the right-sidebar resilient if
    // the renderer race-loses to a backend clear between fetch and submit.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Fresh goal",
      editInPlace: true,
    });
    expect(created.objective).toBe("Fresh goal");
    expect((await service.getGoalBoard(workspaceId)).entries).toHaveLength(1);
  });

  test("arms a kickoff continuation when a brand-new goal is set on an idle workspace", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{
      message: string;
      kind: string | undefined;
      goalId: string | undefined;
    }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message, kind: input.kind, goalId: input.goalId });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Kick off without a prior stream",
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.message).toContain("<untrusted_objective>");
    expect(executed[0]?.kind).toBe("goal_continuation");
    // The dispatch carries the goal identity so the persisted row is goal-scoped.
    expect(executed[0]?.goalId).toBe(created.goalId);
  });

  test("arms a kickoff continuation when resuming a paused goal on an idle workspace", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await setGoalOk(service, { workspaceId, objective: "Resume after pause", status: "paused" });
    expect(executed).toHaveLength(0);

    await setGoalOk(service, { workspaceId, status: "active" });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.message).toContain("<untrusted_objective>");
  });

  // Drive one real continuation so the goal leaves its kickoff window
  // (lastContinuationFiredAtMs set + goal_continuation row in history).
  async function driveOneContinuation(): Promise<void> {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge(async (input) => {
        await appendUserHistoryMessage(historyService, input.workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      })
    );
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await waitForCondition(
      async () => (await service.getGoal(workspaceId))?.lastContinuationFiredAtMs != null,
      { timeoutMs: 1_000 }
    );
  }

  test("getGoal reconciles driven active goals to paused when the latest user turn is not a continuation", async () => {
    await setGoalOk(service, { workspaceId, objective: "Follow chat tail" });
    await driveOneContinuation();
    await appendUserHistoryMessage(historyService, workspaceId, "Manual interruption");

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal keeps a never-driven active goal active across candidate loss (durable kickoff window)", async () => {
    // A goal that has never fired a continuation only has pre-goal manual user
    // rows in its chat tail (e.g. the request that made the model set it).
    // Reconciliation must not pause it — the in-memory kickoff candidate can be
    // lost (restart, eviction), and the next getGoal (heartbeat/wake tool
    // assembly) would otherwise silently pause the goal before it ever ran.
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal", {
      timestamp: 10_000,
    });
    await setGoalOk(service, { workspaceId, objective: "Follow chat tail" });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("getGoal keeps a never-driven goal active for queued rows authored before the goal", async () => {
    // Queue race: the row is persisted at dispatch (after the goal-creating
    // turn's stream end) so its timestamp postdates the goal, but the durable
    // enqueuedAtMs proves the user typed before the goal existed.
    const created = await setGoalOk(service, { workspaceId, objective: "Queue race" });
    await appendUserHistoryMessage(historyService, workspaceId, "Typed mid-stream", {
      timestamp: created.createdAtMs + 500,
      enqueuedAtMs: created.createdAtMs - 500,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("a paused write invalidates captured redispatch admissions before publication completes", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSREI): the explicit-pause generation must
    // bump at the durable write commit, not after snapshot/preview
    // publication — a captured continuation's admission probe re-checked
    // during the publication awaits (before setGoal returns and arms the
    // finalization hold) must already read stale, or an autonomous turn could
    // be admitted against the committed Pause.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    // Block publication so the paused record is durable while setGoal is
    // still awaiting inside its locked persistence.
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const pushSnapshotSpy = spyOn(
      service as unknown as { pushSnapshot: (workspaceId: string, goal: unknown) => Promise<void> },
      "pushSnapshot"
    ).mockImplementation(async () => {
      await publicationGate;
    });
    try {
      const pausePromise = service.setGoal({
        workspaceId,
        status: "paused",
        initiator: "user",
      });
      const goalPath = path.join(config.sessionsDir, workspaceId, "goal.json");
      await waitForCondition(async () => {
        try {
          const raw = JSON.parse(await fs.readFile(goalPath, "utf-8")) as { status?: string };
          return raw.status === "paused";
        } catch {
          return false;
        }
      });
      // The durable pause has committed but publication (and the finalization
      // hold arming) has not — the captured probe must already be stale.
      expect(admission.admissionStale()).toBe(true);
      releasePublication();
      const paused = await pausePromise;
      expect(paused.success).toBe(true);
    } finally {
      releasePublication();
      pushSnapshotSpy.mockRestore();
    }
  });

  test("a Stop in flight refuses redispatch admissions before its acknowledgment commits", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cS7qG): recordUserStoppedStream bumps
    // the stop generation BEFORE awaiting the goal lock, so an admission built
    // in that window captures the post-Stop generation as its fresh baseline
    // while readGoalFile still returns the pre-Stop active record (no
    // acknowledgment gate yet). The later active→active acknowledgment write
    // moves no generation — the in-flight Stop itself must refuse admission.
    const created = await setGoalOk(service, { workspaceId, objective: "Stop latch" });
    const svc = service as unknown as {
      writeGoal: (workspaceId: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWriteGoal = svc.writeGoal.bind(service);
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const writeSpy = spyOn(svc, "writeGoal").mockImplementationOnce(
      async (wsId: string, goal: GoalRecordV1) => {
        await ackGate;
        return realWriteGoal(wsId, goal);
      }
    );
    try {
      const stopPromise = service.recordUserStoppedStream(workspaceId);
      const admission = await service.buildGoalRedispatchAdmission(
        workspaceId,
        created.goalId,
        GOAL_CONTINUATION_KIND
      );
      expect(admission.admissible).toBe(false);
      releaseAck();
      await stopPromise;
    } finally {
      releaseAck();
      writeSpy.mockRestore();
    }
  });

  test("a synthetic assistant follower does not mark a manual row processed", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cS8Bx): synthetic assistant artifacts
    // (e.g. the goal-cleared summary appended by clearGoal auto-promotion) are
    // not the manual turn's settled response. Treating one as proof that the
    // intervention was processed would keep an auto-promoted goal active with
    // its autonomous kickoff recoverable over an unprocessed intervention.
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this");
    await appendAssistantHistoryMessage(historyService, workspaceId, "Goal cleared: summary", {
      timestamp: Date.now(),
      synthetic: true,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: "Auto-promoted goal",
      initiator: "model",
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("a user Stop invalidates captured redispatch admissions", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cSx0M): recordUserStoppedStream
    // leaves an active goal's status and identity unchanged (it only bumps the
    // stop generation; the acknowledgment gate lands later), so the pause/
    // terminal/identity generation probes stay fresh across a Stop — a
    // recovered goal-scoped follow-up whose admission was captured before the
    // Stop could otherwise start an exec turn after it.
    const created = await setGoalOk(service, { workspaceId, objective: "Stop admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    await service.recordUserStoppedStream(workspaceId);

    expect(admission.admissionStale()).toBe(true);
  });

  test("getGoal pauses a never-driven model-created goal on an unprocessed pre-goal row", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cSGrq): only explicit user activation
    // is consent. A model-published goal whose chat tail ends at a queue-raced
    // manual row (no completed assistant row after it) fails closed to paused —
    // timestamp order alone must not let the model outrun a queued correction.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Model queue race",
      initiator: "model",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Typed mid-stream", {
      timestamp: created.createdAtMs + 500,
      enqueuedAtMs: created.createdAtMs - 500,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal keeps a never-driven model-created goal active when the pre-goal prompt was processed", async () => {
    // The initiating prompt's turn settled (completed assistant row follows
    // it) — that turn PRODUCED the goal, so the prompt is not an unprocessed
    // intervention. Candidate loss (restart/eviction) must not pause the
    // fresh goal before it ever runs.
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal");
    await appendAssistantHistoryMessage(historyService, workspaceId, "Goal created");
    await setGoalOk(service, {
      workspaceId,
      objective: "Processed prompt",
      initiator: "model",
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("getGoal pauses a never-driven goal when a manual row was authored after the goal", async () => {
    // Crash-recovery self-healing: if the dispatch-time auto-pause was lost
    // (process exit between the user row persist and the pause write), the
    // durable row authored after the goal must still pause it on restart.
    const created = await setGoalOk(service, { workspaceId, objective: "Post-goal intervention" });
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this goal", {
      timestamp: created.createdAtMs + 1_000,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal ignores malformed persisted enqueuedAtMs and pauses on the row timestamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b_1_J): chat.jsonl is unchecked JSON — a
    // malformed enqueuedAtMs (negative here) must not beat a valid row
    // timestamp, or a genuine post-goal intervention would be misread as
    // pre-goal after a restart and the goal would keep running.
    const created = await setGoalOk(service, { workspaceId, objective: "Malformed metadata" });
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this goal", {
      timestamp: created.createdAtMs + 1_000,
      enqueuedAtMs: -1,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("chat-tail reconciliation ignores synthetic maintenance user rows", async () => {
    await setGoalOk(service, { workspaceId, objective: "Ignore maintenance rows" });
    // Drive a real continuation first so the goal is past its kickoff window
    // and the synthetic-row skip below is what keeps it active.
    await driveOneContinuation();
    await appendUserHistoryMessage(historyService, workspaceId, "Synthetic heartbeat", {
      timestamp: Date.now(),
      synthetic: true,
      muxMetadata: { type: "heartbeat-request", source: "heartbeat" },
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("pause appends a hidden user boundary so the chat tail no longer marks the goal active", async () => {
    await setGoalOk(service, { workspaceId, objective: "Pause from continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue goal", {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      kind: GOAL_CONTINUATION_KIND,
    });

    const paused = await setGoalOk(service, { workspaceId, status: "paused" });
    const lastUserMessage = await getLastUserHistoryMessage(historyService, workspaceId);

    expect(paused).toMatchObject({ status: "paused" });
    expect(lastUserMessage?.metadata?.synthetic).toBe(true);
    expect(lastUserMessage?.metadata?.muxMetadata).toMatchObject({ type: "goal-pause-boundary" });
    expect(lastUserMessage?.metadata?.kind).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });
  });

  test("resume appends a goal continuation before reporting the goal active", async () => {
    await setGoalOk(service, { workspaceId, objective: "Resume via chat tail", status: "paused" });
    await appendUserHistoryMessage(historyService, workspaceId, "Manual pause reason");
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: async (input) => {
        await appendUserHistoryMessage(historyService, input.workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const resumed = await setGoalOk(service, { workspaceId, status: "active" });
    const lastUserMessage = await getLastUserHistoryMessage(historyService, workspaceId);

    expect(resumed).toMatchObject({ status: "active" });
    expect(lastUserMessage?.metadata?.kind).toBe(GOAL_CONTINUATION_KIND);
  });

  test("pause clears a deferred kickoff continuation candidate", async () => {
    await setGoalOk(service, { workspaceId, objective: "Deferred resume", status: "paused" });
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await setGoalOk(service, { workspaceId, status: "active" });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    await setGoalOk(service, { workspaceId, status: "paused" });
    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
  });

  test("skips the kickoff arm when no kickoff send options are available", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve(null),
    });

    // Negative assertion: the kickoff arm short-circuits synchronously when
    // getKickoffSendOptions returns null, so no microtask hop is needed.
    await setGoalOk(service, { workspaceId, objective: "No kickoff defaults" });

    expect(executed).toHaveLength(0);
  });

  test("falls back to priced kickoff options when stream options are unpriced for budgeted goals", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Use priced fallback",
      budgetCents: 500,
    });
    const dispatcher = new IdleDispatcher();
    const seenModels: string[] = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge((input) => {
        seenModels.push(input.options.model);
        return Promise.resolve(true);
      }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "custom:unpriced-model", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await waitForCondition(() => seenModels.length > 0, { timeoutMs: 1_000 });

    expect(seenModels).toEqual(["openai:gpt-4o"]);
  });

  test("dispatches an eligible active-goal continuation and records cooldown telemetry", async () => {
    await setGoalOk(service, { workspaceId, objective: "Keep going until tests pass" });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string; workspaceId: string }> = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push({ message: input.message, workspaceId: input.workspaceId });
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]?.workspaceId).toBe(workspaceId);
    expect(executed[0]?.message).toContain("<untrusted_objective>");
    const updated = await service.getGoal(workspaceId);
    expect(typeof updated?.lastContinuationFiredAtMs).toBe("number");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_continuation_fired",
      expect.objectContaining({ source: "stream_end_idle_dispatch" })
    );
  });

  test("does not carry workspace-turn metadata into goal continuations", async () => {
    await setGoalOk(service, { workspaceId, objective: "Start a new goal continuation" });
    const dispatcher = new IdleDispatcher();
    const seenOptions: SendMessageOptions[] = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        seenOptions.push(input.options);
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: {
        model: "openai:gpt-4o",
        agentId: "exec",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "delegated-task",
          ownerWorkspaceId: "owner-workspace",
          turnId: "delegated-turn",
        },
      },
      streamEndedAtMs: 10_000,
    });

    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.muxMetadata).toBeUndefined();
  });

  test("can suppress setGoal kickoff continuation for CLI-controlled kickoff", async () => {
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics, {
      suppressKickoffContinuation: true,
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await setGoalOk(service, { workspaceId, objective: "Wait for the CLI kickoff message" });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
  });

  test("allows zero cooldown for immediate CLI-style continuations", async () => {
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics, {
      continuationCooldownMs: 0,
    });
    await setGoalOk(service, { workspaceId, objective: "Keep going without idle delay" });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_001,
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("dispatches one budget-limit wrap-up after a continuation-origin stream exhausts the budget", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stop cleanly after budget",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined; message: string }> = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push({ kind: input.kind, message: input.message });
        return Promise.resolve(true);
      })
    );

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ kind: GOAL_BUDGET_LIMIT_KIND });
    expect(executed[0]?.message).toContain("The budget for this goal has been exhausted.");
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_wrapup_fired",
      expect.objectContaining({ source: "stream_end_idle_dispatch", "cost-overshoot": "1-99" })
    );
  });

  test("model-created goals stay active and arm kickoff after a normal user turn", async () => {
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-set-goal-request", "user", "Set yourself a goal and continue", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        const continuationAppend = await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("model-created-goal-continuation", "user", input.message, {
            timestamp: Date.now(),
            kind: GOAL_CONTINUATION_KIND,
          })
        );
        expect(continuationAppend.success).toBe(true);
        return true;
      }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Model-created auto goal",
      status: "active",
      initiator: "model",
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(goal.status).toBe("active");
    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("preserves model-created kickoff candidate when stream-end continuation is requested", async () => {
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-set-goal-stream", "user", "Set yourself a goal and continue", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        const continuationAppend = await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("preserved-kickoff-continuation", "user", input.message, {
            timestamp: Date.now(),
            kind: GOAL_CONTINUATION_KIND,
          })
        );
        expect(continuationAppend.success).toBe(true);
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued model-created auto goal",
      status: "active",
      initiator: "model",
    });
    expect(queued.success).toBe(true);
    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toMatchObject({ status: "active" });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });
    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.startStreamInBackground).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: drained?.goalId,
      status: "active",
    });
  });

  // Regression: bash-monitor wake turns used to disable freshly set goals.
  // The wake turn's synthetic user row lands before the kickoff continuation
  // row, so chat-tail reconciliation saw the pre-goal manual user row and
  // flipped the goal active→paused mid-window.
  test("getGoal keeps a kickoff-window goal active while a synthetic wake turn runs", async () => {
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal and continue");
    const busy = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a wake turn",
      status: "active",
      initiator: "model",
    });
    // Simulate a bash-monitor wake turn starting before the kickoff fires: its
    // synthetic user row is appended and the wake turn's tool build reads the
    // goal while the kickoff candidate is still armed.
    await appendUserHistoryMessage(
      historyService,
      workspaceId,
      "A background bash monitor matched output.",
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("a wake turn ending during the kickoff window does not drop the kickoff candidate", async () => {
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal and continue");
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        await appendUserHistoryMessage(historyService, workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a wake turn end",
      status: "active",
      initiator: "model",
    });
    await appendUserHistoryMessage(
      historyService,
      workspaceId,
      "A background bash monitor matched output.",
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    // getGoal during the wake turn must not flip the goal, and the wake turn's
    // stream-end hook must keep the armed kickoff instead of downgrading or
    // deleting it.
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });

    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.startStreamInBackground).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("wake turn stream end preserves a paused kickoff candidate armed by resume", async () => {
    await setGoalOk(service, { workspaceId, objective: "Resume through a wake turn" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue goal", {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      kind: GOAL_CONTINUATION_KIND,
    });
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        await appendUserHistoryMessage(historyService, workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    // Explicit pause appends a goal-pause-boundary row and clears candidates;
    // resume then arms a kickoff whose continuation is deferred while busy. The
    // chat tail still ends at the boundary, so the persisted status flaps back
    // to paused — the armed kickoff is the durable carrier of resume intent.
    await setGoalOk(service, { workspaceId, status: "paused" });
    const resumed = await setGoalOk(service, { workspaceId, status: "active" });

    // A wake turn's stream end must not delete that paused kickoff candidate.
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });

    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: resumed.goalId,
      status: "active",
    });
  });

  test("strips set_goal capability from synthetic goal continuations", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Continue safely" });
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push(input);
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec", allowAgentSetGoal: true },
      streamEndedAtMs: created.createdAtMs + 1,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.options.allowAgentSetGoal).toBeUndefined();
  });

  test("replacing a goal while a stale continuation candidate exists arms the new goal", async () => {
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: string[] = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge((input) => {
        executed.push(input.message);
        return Promise.resolve(true);
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const first = await setGoalOk(service, { workspaceId, objective: "First goal" });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: first.createdAtMs + 1,
    });
    await drainPendingDispatches();
    expect(executed).toEqual([]);

    busy = false;
    await setGoalOk(service, { workspaceId, objective: "Second goal" });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("Second goal");
  });

  test("rejects resuming budgeted goals when kickoff model has no pricing", async () => {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Paused budgeted goal",
      status: "paused",
      budgetCents: 500,
    });

    const result = await service.setGoal({
      workspaceId,
      objective: created.objective,
      status: "active",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "invalid_transition" });
    }
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });
  });

  test("explicit user resume clears the user-stop gate", async () => {
    // Regression: lastUserStopAtMsByWorkspace was never cleared on resume, so
    // once a user interrupted a stream after goal creation, all future
    // continuation candidates for that goal were rejected forever as
    // `user_stop` (the gate compares against the goal's createdAtMs, which
    // never changes when the goal is paused/resumed).
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a user interruption",
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    // User stops mid-stream after goal creation, then pauses.
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
      initiator: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });

    // User resumes. The next continuation must fire — without the gate clear,
    // the dispatcher would silently reject all candidates with `user_stop`.
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "active",
      initiator: "user",
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 10_000,
    });

    // No kickoff path here (no getKickoffSendOptions); only the stream-end
    // dispatch should fire — and it must, because the gate is cleared.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("explicit resume re-requests a gated same-goal continuation candidate", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Resume gated candidate",
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 6_000,
    });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    await setGoalOk(service, { workspaceId, objective: created.objective, status: "paused" });
    await setGoalOk(service, { workspaceId, objective: created.objective, status: "active" });
    await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("startup recovery does not rearm an active goal after a persisted user stop", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stay stopped after restart",
    });
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);

    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await drainPendingDispatches();

    expect(execute).not.toHaveBeenCalled();
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: created.createdAtMs + 5_000,
    });
  });

  test("rejected wrap-up send leaves the candidate retryable on the next dispatch", async () => {
    // Regression: tryMarkBudgetLimitInjected used to flip permanently before the
    // send. A transient sendMessage rejection (e.g. requireIdle race) then locked
    // the goal into budget_limited with no wrap-up. Now we mark only after a
    // successful send so a retry works.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Retry wrap-up after rejection",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    // First call rejects (transient), second call accepts.
    let callCount = 0;
    const execute = mock(() => {
      callCount += 1;
      return Promise.resolve(callCount > 1);
    });
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    // requestContinuationAfterStreamEnd internally triggers one dispatch (the
    // rejected one). The explicit second requestDispatch here simulates the
    // next stream-end and exercises the retry path.
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("recoverPendingDispatchAfterRestart re-arms a stranded budget_limited wrap-up", async () => {
    // Regression: Simulates a process
    // restart by:
    //  1. Setting up a budgeted goal + recording a continuation-origin stream
    //     that exhausts the budget. This puts the goal in `budget_limited`
    //     with `budgetLimitInjectedForGoalId === null` AND an in-memory
    //     stamp/candidate.
    //  2. Throwing away the in-memory state by re-instantiating the service.
    //  3. Calling `recoverPendingDispatchAfterRestart` and checking that the
    //     wrap-up fires on the next idle dispatch.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a restart with the wrap-up still owed",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });

    // Simulate restart: throw away the in-memory state.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined; message: string }> = [];
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind, message: input.message });
        return Promise.resolve(true);
      },
      // Recovery synthesizes a candidate from scratch, which requires a
      // kickoff send-options provider to know how to dispatch the wrap-up.
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ kind: GOAL_BUDGET_LIMIT_KIND });
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("getGoal normalizes legacy zero-budget goals on read", async () => {
    const legacy = await setGoalOk(service, {
      workspaceId,
      objective: "Legacy read normalization",
      budgetCents: 100,
    });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...legacy, status: "budget_limited", budgetCents: 0 })
    );

    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "active",
      budgetCents: null,
    });
  });

  test("recordUserStoppedStream drops queued goal mutations alongside continuation candidates", async () => {
    // Regression for pendingGoalMutations
    // were not cleared on user stop, so a setGoal racing with a stop would
    // leak into the NEXT stream's stream-end via applyPendingAfterStreamEnd
    // and bypass the lastUserStopAtMsByWorkspace gate. Auto-continuation
    // would then fire in a context the user did not intend.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
    });

    const activityUpdates = captureGoalActivity(service);
    // Simulate a setGoal arriving mid-stream (this queues a pending
    // mutation in `pendingGoalMutations` because the workspace is streaming).
    // Override the private streaming check so setGoal hits the queueing path.
    const serviceAccess = service as unknown as {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    };
    const isStreamingOriginal = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    try {
      const queued = await service.setGoal({
        workspaceId,
        objective: "Should be dropped after user stop",
        expectedGoalId: created.goalId,
      });
      expect(queued.success).toBe(true);
      expect(activityUpdates.at(-1)).toMatchObject({
        goal: { objective: "Should be dropped after user stop", pendingPersistence: true },
      });
      expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
        goal: { goalId: created.goalId, objective: "Original objective" },
      });
    } finally {
      serviceAccess.isWorkspaceStreaming = isStreamingOriginal;
    }

    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Original objective" },
    });

    // applyPendingAfterStreamEnd should now be a no-op — the queued mutation
    // was discarded along with the continuation candidate.
    const applied = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(applied).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Original objective",
    });
  });

  test("serializes four active workspaces that all request goal continuations at once", async () => {
    const workspaceIds = [workspaceId, "goal-parent-2", "goal-parent-3", "goal-parent-4"];
    for (const id of workspaceIds.slice(1)) {
      await config.addWorkspace(PROJECT_PATH, {
        id,
        name: id,
        projectName: "mux-goal-service-test-project",
        projectPath: PROJECT_PATH,
        runtimeConfig: { type: "local" },
      });
    }
    for (const id of workspaceIds) {
      await setGoalOk(service, { workspaceId: id, objective: `Keep ${id} moving` });
    }

    const dispatcher = new IdleDispatcher();
    const events: string[] = [];
    const releaseByWorkspaceId = new Map<string, () => void>();
    const gateByWorkspaceId = new Map<string, Promise<void>>();
    let activeContinuations = 0;
    let maxActiveContinuations = 0;

    for (const id of workspaceIds) {
      gateByWorkspaceId.set(
        id,
        new Promise<void>((resolve) => {
          releaseByWorkspaceId.set(id, resolve);
        })
      );
    }

    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge(async (input) => {
        activeContinuations += 1;
        maxActiveContinuations = Math.max(maxActiveContinuations, activeContinuations);
        events.push(`start:${input.workspaceId}`);
        const gate = gateByWorkspaceId.get(input.workspaceId);
        if (!gate) {
          throw new Error(`Missing continuation gate for ${input.workspaceId}`);
        }
        await gate;
        events.push(`end:${input.workspaceId}`);
        activeContinuations -= 1;
        return true;
      })
    );

    const requests = workspaceIds.map((id) =>
      service.requestContinuationAfterStreamEnd({
        workspaceId: id,
        sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
        streamEndedAtMs: 10_000,
      })
    );
    await waitForCondition(() => events.some((event) => event.startsWith("start:")));
    // Drain so any spurious extra dispatches would surface before we assert
    // the global concurrency cap holds. There is no clean deterministic
    // signal here — we are asserting absence of events.
    await drainPendingDispatches();
    expect(events).toHaveLength(1);
    expect(maxActiveContinuations).toBe(1);

    let currentWorkspaceId = events[0]?.replace("start:", "");
    if (!currentWorkspaceId) {
      throw new Error("Expected a started continuation workspace");
    }
    for (let index = 0; index < workspaceIds.length; index += 1) {
      const releaseCurrent = releaseByWorkspaceId.get(currentWorkspaceId);
      if (!releaseCurrent) {
        throw new Error(`Missing continuation release for ${currentWorkspaceId}`);
      }
      releaseCurrent();
      await waitForCondition(() => events.includes(`end:${currentWorkspaceId}`));
      const expectedStartCount = index + 2;
      if (expectedStartCount <= workspaceIds.length) {
        await waitForCondition(
          () => events.filter((event) => event.startsWith("start:")).length === expectedStartCount
        );
        const nextWorkspaceId = events
          .filter((event) => event.startsWith("start:"))
          .at(-1)
          ?.replace("start:", "");
        if (!nextWorkspaceId) {
          throw new Error("Expected the next started continuation workspace");
        }
        currentWorkspaceId = nextWorkspaceId;
        expect(maxActiveContinuations).toBe(1);
      }
    }

    await Promise.all(requests);
    expect(events).toHaveLength(workspaceIds.length * 2);
    expect(
      events
        .filter((event) => event.startsWith("start:"))
        .map((event) => event.slice(6))
        .sort()
    ).toEqual([...workspaceIds].sort());
    expect(
      events
        .filter((event) => event.startsWith("end:"))
        .map((event) => event.slice(4))
        .sort()
    ).toEqual([...workspaceIds].sort());
    expect(maxActiveContinuations).toBe(1);
  });

  test("does not build stale continuation payloads after the goal changes", async () => {
    await setGoalOk(service, { workspaceId, objective: "Original" });
    const dispatcher = new IdleDispatcher();
    const requestDispatch = spyOn(dispatcher, "requestDispatch").mockResolvedValue();
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge());

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    expect(requestDispatch).toHaveBeenCalled();
    expect(await service.buildGoalContinuationPayload(workspaceId)).not.toBeNull();
    await setGoalOk(service, { workspaceId, objective: "Replacement" });

    expect(await service.buildGoalContinuationPayload(workspaceId)).toBeNull();
  });

  test("preserves goal id and accounting for same-objective set", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Same objective" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...created, costCents: 123, turnsUsed: 4 })
    );

    const same = await setGoalOk(service, { workspaceId, objective: "  Same objective  " });

    expect(same.goalId).toBe(created.goalId);
    expect(same.costCents).toBe(123);
    expect(same.turnsUsed).toBe(4);
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_replaced",
      expect.objectContaining({ sameObjective: true })
    );
  });

  test("replaces different objective with a new goal id and reset accounting", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "First objective" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...created, costCents: 123, turnsUsed: 4 })
    );

    const replaced = await setGoalOk(service, { workspaceId, objective: "Second objective" });

    expect(replaced.goalId).not.toBe(created.goalId);
    expect(replaced.costCents).toBe(0);
    expect(replaced.turnsUsed).toBe(0);
    expect(replaced.objective).toBe("Second objective");
  });

  test("allows writes when expectedGoalId matches the current goal", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Concurrent goal" });

    const result = await service.setGoal({
      workspaceId,
      status: "paused",
      expectedGoalId: created.goalId,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected matching goalId write to succeed: ${JSON.stringify(result.error)}`);
    }
    expect(result.data).toMatchObject({ goalId: created.goalId, status: "paused" });
  });

  test("returns a typed conflict when expectedGoalId explicitly expects no goal", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "existing" });

    const result = await service.setGoal({
      workspaceId,
      objective: "new",
      expectedGoalId: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({
        type: "goal_conflict",
        expectedGoalId: null,
        actualGoalId: created.goalId,
      });
    }
  });

  test("returns a typed conflict when expectedGoalId does not match", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original goal" });
    const replaced = await setGoalOk(service, { workspaceId, objective: "Replacement goal" });

    const result = await service.setGoal({
      workspaceId,
      status: "paused",
      expectedGoalId: created.goalId,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: "goal_conflict",
        expectedGoalId: created.goalId,
        actualGoalId: replaced.goalId,
      },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: replaced.goalId,
      status: "active",
    });
  });

  test("uses last-writer-wins when expectedGoalId is omitted", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "First goal" });

    const result = await service.setGoal({ workspaceId, objective: "Last writer goal" });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected omitted goalId write to succeed: ${JSON.stringify(result.error)}`);
    }
    expect(result.data.goalId).not.toBe(created.goalId);
    expect(result.data.objective).toBe("Last writer goal");
  });

  test("resolves concurrent expectedGoalId writes with one success and one conflict", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Race origin" });

    const results = await Promise.all([
      service.setGoal({
        workspaceId,
        objective: "Race winner A",
        expectedGoalId: created.goalId,
      }),
      service.setGoal({
        workspaceId,
        objective: "Race winner B",
        expectedGoalId: created.goalId,
      }),
    ]);

    const successes = results.filter((result) => result.success);
    const conflicts = results.filter((result) => !result.success);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      success: false,
      error: {
        type: "goal_conflict",
        expectedGoalId: created.goalId,
        actualGoalId: successes[0]?.success ? successes[0].data.goalId : null,
      },
    });
  });

  test("rejects child workspaces", async () => {
    const childWorkspaceId = "goal-child";
    await config.addWorkspace(PROJECT_PATH, {
      id: childWorkspaceId,
      name: "child",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
      parentWorkspaceId: workspaceId,
    });

    // setGoal now catches WorkspaceGoalChildWorkspaceError and
    // returns it as a typed Result error so the oRPC handler doesn't leak
    // it as an unhandled 500.
    const result = await service.setGoal({
      workspaceId: childWorkspaceId,
      objective: "child goal",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("child_workspace");
    }
  });

  for (const sourceStatus of [
    "active",
    "paused",
    "budget_limited",
    "complete",
  ] satisfies GoalStatus[]) {
    test(`inherits ${sourceStatus} goal into a paused fork with fresh accounting`, async () => {
      const forkWorkspaceId = `goal-fork-${sourceStatus}`;
      await config.addWorkspace(PROJECT_PATH, {
        id: forkWorkspaceId,
        name: `fork-${sourceStatus}`,
        projectName: "mux-goal-service-test-project",
        projectPath: PROJECT_PATH,
        runtimeConfig: { type: "local" },
      });

      let parent = await setGoalOk(service, {
        workspaceId,
        objective: "Ship inherited goal",
        budgetCents: 500,
        turnCap: 7,
      });
      if (sourceStatus === "paused") {
        parent = await setGoalOk(service, { workspaceId, status: "paused" });
      } else if (sourceStatus === "budget_limited") {
        parent = await setGoalOk(service, { workspaceId, status: "budget_limited" });
      } else if (sourceStatus === "complete") {
        parent = await setGoalOk(service, {
          workspaceId,
          status: "complete",
          completionSummary: "Done in the parent.",
        });
      }
      const parentWithAccounting: GoalRecordV1 = {
        ...parent,
        costCents: 123,
        turnsUsed: 4,
        attributedChildren: ["child-a"],
        budgetLimitInjectedForGoalId: parent.goalId,
        requireUserAcknowledgmentSinceMs: parent.createdAtMs + 1,
      };
      await fs.writeFile(
        path.join(config.sessionsDir, workspaceId, "goal.json"),
        `${JSON.stringify(parentWithAccounting, null, 2)}\n`
      );

      const beforeInheritMs = Date.now();
      const inherited = await service.inheritFromFork(workspaceId, forkWorkspaceId);
      const afterInheritMs = Date.now();

      expect(inherited).toMatchObject({
        objective: "Ship inherited goal",
        budgetCents: 500,
        turnCap: 7,
        status: "paused",
        costCents: 0,
        turnsUsed: 0,
        attributedChildren: [],
        budgetLimitInjectedForGoalId: null,
        requireUserAcknowledgmentSinceMs: null,
      });
      expect(inherited?.goalId).not.toBe(parent.goalId);
      expect(inherited?.completionSummary).toBeUndefined();
      expect(inherited?.createdAtMs).toBeGreaterThanOrEqual(beforeInheritMs);
      expect(inherited?.updatedAtMs).toBe(inherited?.createdAtMs);
      expect(inherited?.updatedAtMs).toBeLessThanOrEqual(afterInheritMs);
      expect(await service.getGoal(forkWorkspaceId)).toEqual(inherited);
      expect(await service.getGoal(workspaceId)).toEqual(parentWithAccounting);
      expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
        "goal_created",
        expect.objectContaining({ viaFork: true, hasBudget: true, hasTurnCap: true })
      );
    });
  }

  test("leaves a fork goal-less when the parent has no goal", async () => {
    const forkWorkspaceId = "goal-fork-empty";
    await config.addWorkspace(PROJECT_PATH, {
      id: forkWorkspaceId,
      name: "fork-empty",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });

    const inherited = await service.inheritFromFork(workspaceId, forkWorkspaceId);

    expect(inherited).toBeNull();
    expect(await goalFileExists(config, forkWorkspaceId)).toBe(false);
  });

  test("renames corrupt goal file and treats workspace as having no goal", async () => {
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "goal.json"), "{ not json");

    expect(await service.getGoal(workspaceId)).toBeNull();

    const files = await fs.readdir(sessionDir);
    expect(files.some((file) => /^goal\.json\.corrupt-\d+$/.test(file))).toBe(true);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
  });

  test("applyPendingAfterStreamEnd swallows invalid-transition rejections instead of crashing the process", async () => {
    // the stream-abort / stream-end /
    // error listeners in WorkspaceService invoke this method via `void`. If
    // a queued mutation triggered a transition error inside
    // setGoalImmediately, it would surface as an unhandled-rejection
    // process crash under `--unhandled-rejections=throw`. The fix wraps the
    // call in try/catch and logs+returns null so the pipeline stays alive.
    const original = await setGoalOk(service, { workspaceId, objective: "Original" });
    await setGoalOk(service, { workspaceId, status: "paused" });

    // Seed a queued no-op pause against an already-paused goal. Draining this
    // throws `WorkspaceGoalTransitionError` inside
    // `validateStatusTransition("paused", "paused", null)`, which is the
    // stream-end failure mode this regression test cares about. Seeding the
    // queue directly keeps this test focused on drain behavior instead of the
    // streaming projection rules that now reject this invalid transition sooner.
    const serviceAccess = service as unknown as {
      pendingGoalMutations: Map<
        string,
        { objective: string; status: GoalStatus; projectedGoalId?: string | null }
      >;
    };
    serviceAccess.pendingGoalMutations.set(workspaceId, {
      objective: "Original",
      status: "paused",
      projectedGoalId: original.goalId,
    });

    // Without the fix, this rejection would propagate out of the async
    // function and crash. With the fix, it returns null and the goal
    // record is unchanged.
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Original",
      status: "paused",
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: original.goalId, objective: "Original", status: "paused" },
    });
  });

  test("queues mid-stream objective changes and drains them after stream end", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);

    const projected = await setGoalOk(service, { workspaceId, objective: "Queued goal" });

    expect(projected.objective).toBe("Queued goal");
    // Mid-stream goals are not durable until stream accounting drains, but the
    // activity snapshot feeds the Goal panel and should update immediately.
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { goalId: projected.goalId, objective: "Queued goal", pendingPersistence: true },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { goalId: projected.goalId, objective: "Queued goal", pendingPersistence: true },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.objective).toBe("Queued goal");
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued goal" });
    const drainedSnapshot = await extensionMetadata.getSnapshot(workspaceId);
    expect(drainedSnapshot).toMatchObject({
      goal: { goalId: drained?.goalId, objective: "Queued goal" },
    });
    expect(drainedSnapshot?.goal?.pendingPersistence).toBeUndefined();
  });

  test("rejects follow-up mutations while a mid-stream goal snapshot is pending", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);
    const activityUpdates = captureGoalActivity(service);

    const queued = await service.setGoal({ workspaceId, objective: "Queued goal" });
    expect(queued.success).toBe(true);
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { objective: "Queued goal", pendingPersistence: true },
    });

    const budgetResult = await service.setGoal({ workspaceId, budgetCents: 500 });
    expect(budgetResult.success).toBe(false);
    if (!budgetResult.success) {
      expect(budgetResult.error).toMatchObject({ type: "invalid_transition" });
    }
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await service.previewStreamAccounting({ workspaceId, costUsd: 1 })).toMatchObject({
      objective: "Queued goal",
      pendingPersistence: true,
    });
  });

  test("previewStreamAccounting skips the durable fallback when the strict baseline read is unavailable", async () => {
    // "unavailable" (failed sidecar reconcile) must stay distinct from the
    // authoritative "no baseline": the durable pushSnapshot fallback writes
    // through the lenient load — accepting the suspect partial main the
    // strict read refused — and emits it, clearing renderer goal/status
    // state. The preview must resolve without delivering or writing.
    await setGoalOk(service, { workspaceId, objective: "Preview goal" });
    const metadataFilePath = path.join(config.rootDir, "extensionMetadata.json");
    const before = await fs.readFile(metadataFilePath, "utf-8");
    // A directory at the sidecar path yields a deterministic errno (EISDIR)
    // standing in for EACCES/EIO-class reconcile failures.
    await fs.mkdir(`${metadataFilePath}.corrupt`);
    try {
      const activityUpdates = captureGoalActivity(service);

      const preview = await service.previewStreamAccounting({ workspaceId, costUsd: 1 });

      expect(preview).toMatchObject({ objective: "Preview goal" });
      // No emit (renderer keeps last-known state) and no durable write.
      expect(activityUpdates).toHaveLength(0);
      expect(await fs.readFile(metadataFilePath, "utf-8")).toBe(before);
    } finally {
      await fs.rm(`${metadataFilePath}.corrupt`, { recursive: true });
    }
  });

  test("successful no-op queued drains clear the pending snapshot", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Existing goal" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);
    const queued = await service.setGoal({ workspaceId, objective: "Existing goal" });
    expect(queued.success).toBe(true);
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { objective: "Existing goal", pendingPersistence: true },
    });

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.goalId).toBe(created.goalId);
    const snapshot = await extensionMetadata.getSnapshot(workspaceId);
    expect(snapshot).toMatchObject({
      goal: { goalId: created.goalId, objective: "Existing goal" },
    });
    expect(snapshot?.goal?.pendingPersistence).toBeUndefined();
  });

  test("user stop clears queued mid-stream goal snapshot with no persisted goal", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);
    const projected = await setGoalOk(service, { workspaceId, objective: "Dropped kickoff goal" });
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: {
        goalId: projected.goalId,
        objective: "Dropped kickoff goal",
        pendingPersistence: true,
      },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });

    await service.recordUserStoppedStream(workspaceId, projected.createdAtMs + 5_000);

    expect(await service.applyPendingAfterStreamEnd(workspaceId)).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
  });

  test("rejects queued mid-stream budgeted goals when kickoff model has no pricing", async () => {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });
    await extensionMetadata.setStreaming(workspaceId, true);

    const result = await service.setGoal({
      workspaceId,
      objective: "Queued budgeted goal",
      budgetCents: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "invalid_transition" });
    }
    await extensionMetadata.setStreaming(workspaceId, false);
    expect(await service.applyPendingAfterStreamEnd(workspaceId)).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("mid-stream editInPlace rename returns an optimistic snapshot that preserves goalId + accounting", async () => {
    // When an editInPlace rename arrives mid-stream, the
    // projected snapshot returned to the UI is what the Goal tab reads
    // until stream end drains the queued mutation. Building it via
    // `createGoal` (the pre-fix behavior) would flash a brand-new id +
    // zero cost/turns + cleared budget for the duration of the stream,
    // even though the persisted mutation will rename in place. Mirror
    // the drain semantics here: overlay the rename onto the current
    // record.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
      budgetCents: 500,
      turnCap: 7,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed objective",
      editInPlace: true,
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data.goalId).toBe(created.goalId);
      expect(queued.data.objective).toBe("Renamed objective");
      expect(queued.data.costCents).toBe(25);
      expect(queued.data.budgetCents).toBe(500);
      expect(queued.data.turnCap).toBe(7);
    }
  });

  test("mid-stream editInPlace optimistic snapshot reflects budget_limited when new budget is below accrued cost", async () => {
    // A rename that lowers `budgetCents` below the already-accrued cost
    // must publish the same budget-driven status the stream-end drain will
    // persist.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
      budgetCents: 500,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.5, // 150¢, well above the tightening 50¢ target below
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed + tighter budget",
      editInPlace: true,
      expectedGoalId: created.goalId,
      budgetCents: 50, // strictly below the 150¢ already spent
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data.goalId).toBe(created.goalId);
      expect(queued.data.budgetCents).toBe(50);
      expect(queued.data.status).toBe("budget_limited");
    }
  });

  test("queued mid-stream editInPlace rename preserves goalId + accounting at drain time", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original objective" });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed objective",
      editInPlace: true,
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    // The drained mutation must preserve goalId continuity and accounting;
    // otherwise a deferred rename would behave like archive+replace.
    expect(drained?.goalId).toBe(created.goalId);
    expect(drained?.objective).toBe("Renamed objective");
    expect(drained?.costCents).toBe(25);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: created.goalId },
    });
  });

  test("queued mid-stream goal creation preserves the projected creation time at drain time", async () => {
    // The projected goal is visible in the Goal panel the moment set_goal runs
    // mid-stream. The durable record must date from that moment — a stream-end
    // createdAtMs would misclassify a user intervention queued against the
    // visible goal as pre-goal input in the goal-safety guards.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Projected mid-stream" });
    expect(queued.success).toBe(true);
    const projected = queued.success ? queued.data : null;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.goalId).toBe(projected?.goalId ?? "missing");
    expect(drained?.createdAtMs).toBe(projected?.createdAtMs ?? -1);
  });

  test("queued mid-stream goal creation stamps creation at publication time", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b-CH5, PRRT_kwDOPxxmWM6b-Uli): awaits between
    // goal construction and completed publication (kickoff-model pricing
    // validation, streaming re-check, and the async activity-snapshot read
    // inside publication itself) leave a window where a user can queue a
    // message after createdAtMs was stamped but before the goal is visible
    // anywhere. Creation must date from completed publication so the pre-goal
    // guard (enqueuedAtMs <= createdAtMs) covers messages typed during any of
    // those awaits.
    const dispatcher = new IdleDispatcher();
    let midValidationMs = 0;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        // Hold the validation await so wall-clock time observably advances
        // between construction and publication.
        await new Promise((resolve) => setTimeout(resolve, 10));
        midValidationMs = Date.now();
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });
    await extensionMetadata.setStreaming(workspaceId, true);
    // Hold every activity-snapshot read (streaming re-check + the read inside
    // publication) so the last read observably postdates any pre-publication
    // creation stamp.
    let lastActivityReadMs = 0;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      lastActivityReadMs = Date.now();
      return snapshot;
    });

    const queued = await service.setGoal({
      workspaceId,
      objective: "Publication stamp",
      budgetCents: 500,
    });

    expect(queued.success).toBe(true);
    expect(midValidationMs).toBeGreaterThan(0);
    expect(lastActivityReadMs).toBeGreaterThan(0);
    const projected = queued.success ? queued.data : null;
    expect(projected?.createdAtMs ?? -1).toBeGreaterThanOrEqual(midValidationMs);
    // The publication path's own async read is the last pre-visibility await:
    // the creation stamp must postdate it.
    expect(projected?.createdAtMs ?? -1).toBeGreaterThanOrEqual(lastActivityReadMs);
  });

  test("user abort during pending-goal publication discards the queued mutation", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6b-orH): recordUserStoppedStream deletes queued
    // goal mutations synchronously before taking the goal file lock. If the
    // mutation were installed only after the publication await, an abort
    // landing during publication would find nothing to delete, block on the
    // lock, and the setter would then install the mutation anyway — silently
    // applying the discarded goal at the end of the NEXT stream (AgentSession
    // deliberately skips the stream-end drain for user aborts).
    await extensionMetadata.setStreaming(workspaceId, true);
    const mutationAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    const stopPromises: Array<Promise<void>> = [];
    let fireStops = false;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      if (fireStops && mutationAccess.pendingGoalMutations.get(workspaceId) != null) {
        // Fire the abort's synchronous mutation delete during the activity
        // read inside publishPendingGoalSnapshot — the only await with the
        // mutation already installed (a stop during the pre-install awaits is
        // rejected outright; see the span-a-user-stop test). The abort then
        // queues on the goal file lock behind the setter.
        stopPromises.push(service.recordUserStoppedStream(workspaceId));
      }
      return snapshot;
    });

    fireStops = true;
    const queued = await service.setGoal({ workspaceId, objective: "Aborted goal" });
    fireStops = false;
    expect(queued.success).toBe(true);
    expect(stopPromises.length).toBeGreaterThan(0);
    await Promise.all(stopPromises);

    await extensionMetadata.setStreaming(workspaceId, false);
    // Simulate the NEXT stream's end: the drain must find nothing to apply.
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("skipped maintenance streams preserve the budget wrap-up stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBACb): once a goal-driven stream flips the
    // goal to budget_limited, its stamp keeps the pending budget wrap-up
    // eligible. A scheduled heartbeat ending before the wrap-up dispatches
    // must not replace that stamp with a user-origin one, or the wrap-up is
    // classified budget_wrapup_suppressed and the goal strands without its
    // final turn.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget-limited goal",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });

    // Scheduled heartbeat stream ends while the wrap-up is still pending.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "user",
    });

    const stamps = (
      service as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string; goalId: string | null }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("goal_continuation");
  });

  test("background wakes preserve user-origin budget wrap-up suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9I): when a manual user stream exhausts the
    // budget, its user-origin stamp deliberately suppresses the autonomous
    // wrap-up. A later background wake ("other" origin) must not replace that
    // stamp, or the wrap-up the user's own stream blocked would dispatch.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User-exhausted budget",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });

    // Background bash-monitor wake ends while the goal sits budget_limited.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    const stamps = (
      service as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string; goalId: string | null }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("user");
  });

  test("direct idle goal creation stamps creation at publication time", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9B): the direct (non-streaming) creation
    // path stamped createdAtMs at construction, before kickoff-model
    // validation and the write/push awaits. A message the user authored while
    // the create request was in flight postdated that stamp and was misread
    // as an intervention against a goal not yet visible. Creation must date
    // from publication here too.
    const dispatcher = new IdleDispatcher();
    let midValidationMs = 0;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (midValidationMs === 0) {
          // Only the FIRST call is the pre-persist kickoff-model validation;
          // kickoff arming calls this again after persistence completes.
          midValidationMs = Date.now();
        }
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Direct publication stamp",
      budgetCents: 500,
    });

    expect(midValidationMs).toBeGreaterThan(0);
    expect(created.createdAtMs).toBeGreaterThanOrEqual(midValidationMs);
    expect(await service.getGoal(workspaceId)).toMatchObject({ createdAtMs: created.createdAtMs });
  });

  test("direct idle creation persists the publication stamp in a single durable write", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cDhNO): the previous re-stamp scheme wrote the
    // construction stamp first and re-wrote the publication stamp after the
    // snapshot push — a crash between the two writes durably stranded the
    // earlier stamp, so restart reconciliation misread a manual row authored
    // during validation as a post-goal intervention and paused the
    // never-driven goal. The record and its visibility stamp must commit in
    // one atomic write.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });
    const serviceAccess = service as unknown as {
      writeGoal: (workspaceId: string, goal: GoalRecordV1) => Promise<void>;
    };
    const originalWriteGoal = serviceAccess.writeGoal.bind(service);
    const writtenStamps: number[] = [];
    spyOn(serviceAccess, "writeGoal").mockImplementation(async (id: string, goal: GoalRecordV1) => {
      writtenStamps.push(goal.createdAtMs);
      return originalWriteGoal(id, goal);
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Atomic publication stamp",
      budgetCents: 500,
    });

    // Every durable write of this goal already carries the final publication
    // stamp — no window exists where a crash leaves an earlier construction
    // stamp on disk.
    expect(writtenStamps.length).toBeGreaterThan(0);
    expect(writtenStamps).toEqual(writtenStamps.map(() => created.createdAtMs));
  });

  test("maintenance streams after a restart preserve durable user-origin wrap-up suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cDhNX): a user-origin budget_limited goal
    // recovers from restart without a wrap-up candidate, but the suppressing
    // in-memory stamp is gone too. The first background wake's stream-end
    // accounting must not record a wrap-up-eligible maintenance stamp — that
    // would let the next stream-end request dispatch the autonomous wrap-up
    // the persisted budgetLimitOriginKind: "user" was meant to suppress.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User exhausts budget then restarts",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitOriginKind: "user",
    });

    // Simulate restart: fresh service, empty in-memory stream stamps.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    // A background wake turn ends on the restarted service.
    await restartedService.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: Date.now(),
      streamOriginKind: "other",
    });

    const stamps = (
      restartedService as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("user");

    // Behavioral proof: a stream-end continuation request must not dispatch
    // the wrap-up that user-origin suppression blocked.
    await restartedService.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });
    await drainPendingDispatches();

    expect(execute).not.toHaveBeenCalled();
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });
  });

  test("setters that span a stream-end drain persist directly instead of queueing", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): a setGoal admitted while the (stale)
    // streaming flag still reads live can reach its in-lock recheck after the
    // stream-end drain already gave up watching the mutation map. It must
    // detect the drain via the generation counter and persist directly —
    // installing a queued mutation at that point would leave its projected
    // success non-durable with no remaining stream-end hook.
    await extensionMetadata.setStreaming(workspaceId, true);

    // Fire the setter first (captures the pre-drain generation), then run the
    // drain before the setter's pre-lock await resolves.
    const setterPromise = service.setGoal({ workspaceId, objective: "Late goal" });
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);

    const [setter, drained] = await Promise.all([setterPromise, drainPromise]);
    expect(setter.success).toBe(true);
    expect(drained).toBeNull();

    // The setter must have persisted durably; nothing may sit in the mutation
    // map waiting for a stream-end drain that will not come.
    const serviceAccess = service as unknown as {
      pendingGoalMutations: Map<string, unknown>;
    };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Late goal" });
  });

  test("goal setters that span a user stop are rejected", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cCH_H): if the user aborts while a setGoal is
    // still in its pre-install awaits, recordUserStoppedStream finds no
    // mutation to delete — the setter must detect the stop and reject instead
    // of installing (stale streaming flag) or persisting directly, either of
    // which would create and arm a goal from a turn the user just aborted.
    await extensionMetadata.setStreaming(workspaceId, true);

    // The setter captures the pre-stop state at entry; the stop's synchronous
    // prefix runs while the setter is inside its pre-lock streaming check.
    const setterPromise = service.setGoal({ workspaceId, objective: "Aborted turn goal" });
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    const [setter] = await Promise.all([setterPromise, stopPromise]);

    expect(setter.success).toBe(false);
    if (!setter.success) {
      expect(setter.error.type).toBe("invalid_transition");
    }
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("setters admitted after the drain settles persist directly", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cCH_L): a setter admitted after the drain's
    // final empty-map check captures the already-bumped generation, and the
    // streaming flag can still read stale-live — it must observe the settled
    // state and persist directly instead of installing a mutation that stays
    // non-durable until some unrelated later stream ends.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();

    // Admitted strictly after the drain returned; streaming flag still true.
    const setter = await service.setGoal({ workspaceId, objective: "Post-drain goal" });

    expect(setter.success).toBe(true);
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Post-drain goal" });
  });

  test("recordStreamStarted clears the settled marker so the next stream defers mid-stream setGoal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKS): every drain exit (and user stop) marks
    // the workspace settled, but production only cleared the marker on
    // terminal-error restoration. Without an explicit stream-start
    // notification, a model set_goal in the NEXT successful stream bypassed
    // deferral and wrote goal.json mid-stream.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();

    // AgentSession's stream-start handler notifies synchronously.
    service.recordStreamStarted(workspaceId);

    const setter = await service.setGoal({ workspaceId, objective: "Mid-stream goal" });
    expect(setter.success).toBe(true);
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    // Deferred again: the mutation queues for THIS stream's stream-end drain
    // instead of persisting mid-stream.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeDefined();
    expect(await goalFileExists(config, workspaceId)).toBe(false);
  });

  test("a user stop landing while direct persistence awaits the goal lock discards the setter", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKV): the pre-persistence stop check is not
    // the last word — setGoalImmediately still awaits the goal file lock and
    // the durable writes. A stop landing during those awaits must discard the
    // change instead of durably creating a goal from the aborted turn.
    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    };
    // Codex P2 (PRRT_kwDOPxxmWM6cKkGV): count lock admissions instead of
    // sleeping — on a loaded worker a fixed delay cannot guarantee the setter
    // captured the pre-stop generation and queued behind the gate before the
    // stop runs; the stop would then come first and the setter would
    // legitimately persist, failing the test despite correct behavior.
    let lockCalls = 0;
    const originalWithLock = serviceAccess.fileLocks.withLock.bind(serviceAccess.fileLocks);
    serviceAccess.fileLocks.withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return originalWithLock(key, fn);
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Direct path (no live stream): the setter passes its pre-lock stop check
    // and queues behind the gate.
    const setterPromise = service.setGoal({ workspaceId, objective: "Aborted direct goal" });
    // Deterministic admission signal: gate (1), setter's persistence tenure (2).
    await waitForCondition(() => lockCalls >= 2, { timeoutMs: 5_000 });
    // The stop bumps the stop generation synchronously; its own locked section
    // queues behind the setter's tenure.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseGate();
    await gateTenure;
    const [setter] = await Promise.all([setterPromise, stopPromise]);

    expect(setter.success).toBe(false);
    if (!setter.success) {
      expect(setter.error.type).toBe("invalid_transition");
    }
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await goalFileExists(config, workspaceId)).toBe(false);
  });

  test("a stream starting during the stream-end drain leaves the workspace unsettled", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cEl37): the provider-error path launches the
    // drain un-awaited, so an automatic retry's stream-start can land while
    // the drain is persisting. The drain's exit must not re-add the settled
    // marker the retry's recordStreamStarted just cleared — a set_goal in the
    // retry stream would then persist mid-stream, bypassing abort-time
    // discard and stream-end accounting.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, unknown>;
      drainSettledWorkspaces: Set<string>;
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // The drain's locked claim queues behind the gate; the retry stream
    // starts while it waits.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);
    releaseGate();
    await gateTenure;
    await drainPromise;

    expect(serviceAccess.drainSettledWorkspaces.has(workspaceId)).toBe(false);
    // Behavioral proof: a set_goal in the retry stream still defers to that
    // stream's own stream-end drain instead of persisting mid-stream.
    const setter = await service.setGoal({ workspaceId, objective: "Retry-stream goal" });
    expect(setter.success).toBe(true);
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeDefined();
  });

  test("an old stream's drain leaves a retry stream's mutation for that stream's own drain", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cJ6M-): an un-awaited provider-error drain can
    // still be looping when an automatic retry starts and installs its own
    // set_goal. Claims are stream-scoped by stream-start generation: the old
    // drain must not claim the retry's mutation — persisting it early would
    // archive/replace the goal before the retry's accounting and strip a
    // later user abort of its discard window.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, { objective: string }>;
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Old drain (stream 1) blocks at its locked claim; the retry stream then
    // starts and queues a replacement set_goal behind the same lock. Lock
    // ordering guarantees the retry's install lands before the old drain's
    // second claim pass (its finalization's chat-tail sync queues behind the
    // setter's tenure).
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);
    const retrySetterPromise = service.setGoal({ workspaceId, objective: "Retry-stream goal" });
    releaseGate();
    await gateTenure;
    await drainPromise;
    const retrySetter = await retrySetterPromise;
    expect(retrySetter.success).toBe(true);

    // The old drain claimed only its own stream's mutation; the retry's
    // mutation is still queued for the retry's own stream-end drain.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)?.objective).toBe(
      "Retry-stream goal"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // The retry stream's own drain (entry generation matches) claims it.
    const retryDrained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(retryDrained).toMatchObject({ objective: "Retry-stream goal" });
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("an old drain's exit does not force a retry stream's setter onto direct persistence", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cLA0R): the drain-generation staleness check
    // was workspace-global. A setter in retry stream B that captured the
    // generation, awaited its streaming read, and then observed the OLD
    // stream-A drain's exit bump fell through to direct persistence while B
    // was live — the replacement predated B's accounting and escaped a later
    // Stop's discard window. Drain bumps are now stream-scoped: an older
    // stream's bump leaves the setter on the deferral path, and its queued
    // mutation is claimed by B's own drain.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      isWorkspaceStreaming: (id: string) => Promise<boolean>;
      pendingGoalMutations: Map<string, { objective: string }>;
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Old drain D_A (settling stream A) blocks at its locked claim; the retry
    // stream B then starts.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);

    // Hold the setter at its pre-lock streaming read (one-shot gate) so D_A's
    // exit bump lands while the setter is in flight — Codex's interleaving.
    const realIsStreaming = serviceAccess.isWorkspaceStreaming.bind(service);
    let releaseSetterRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseSetterRead = resolve;
    });
    let pendingReadGate: Promise<void> | null = readGate;
    serviceAccess.isWorkspaceStreaming = async (id: string): Promise<boolean> => {
      const hold = pendingReadGate;
      pendingReadGate = null;
      if (hold) {
        await hold;
      }
      return realIsStreaming(id);
    };
    // Captures the pre-exit drain generation synchronously, then parks at the
    // gated streaming read.
    const setterPromise = service.setGoal({ workspaceId, objective: "Retry-stream replacement" });

    // D_A completes: claims its own stream's mutation, then exits (bumping the
    // drain generation FOR STREAM A) while the setter is still parked.
    releaseGate();
    await gateTenure;
    await drainPromise;
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // The setter resumes, sees the bump — but it came from stream A, not B:
    // it must defer, not persist directly.
    releaseSetterRead();
    const setter = await setterPromise;
    expect(setter.success).toBe(true);
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)?.objective).toBe(
      "Retry-stream replacement"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // B's own drain claims the deferred replacement.
    const drainedByB = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drainedByB).toMatchObject({ objective: "Retry-stream replacement" });
  });

  test("pause boundaries for a replaced goal do not reconcile the newer goal to paused", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cEl4F): a stale pause finalizer's boundary
    // append awaits history I/O after its identity check, so the row can land
    // AFTER a replacement persisted. Boundaries are goal-scoped: chat-tail
    // reconciliation must ignore one stamped for a different goal instead of
    // silently pausing the replacement.
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });

    const staleBoundary = createMuxMessage(
      `goal-paused-stale-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    const appendResult = await historyService.appendToHistory(workspaceId, staleBoundary);
    expect(appendResult.success).toBe(true);

    // Reconciliation ignores the mismatched boundary — B stays active.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cGSPK): a mismatched boundary is skipped, not
    // treated as the tail's final signal — a genuine post-goal manual row
    // beneath it must still reconcile the replacement to paused (covers a
    // crash that lost the dispatch-time auto-pause).
    await appendUserHistoryMessage(historyService, workspaceId, "Post-goal intervention", {
      timestamp: goalB.createdAtMs + 5_000,
    });
    const buriedBoundary = createMuxMessage(
      `goal-paused-buried-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, buriedBoundary)).success).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
    // Reset for the legacy assertion below: resume B.
    await setGoalOk(service, { workspaceId, status: "active" });

    // Legacy boundaries without a goalId keep the old any-goal semantics.
    const legacyBoundary = createMuxMessage(
      `goal-paused-legacy-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary" },
      }
    );
    const legacyAppend = await historyService.appendToHistory(workspaceId, legacyBoundary);
    expect(legacyAppend.success).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
  });

  test("a malformed boundary goalId does not unpause the goal it belongs to", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cNxUY): chat.jsonl metadata is unchecked
    // JSON — a corrupt non-string goalId on a pause boundary must not satisfy
    // the mismatch test (it is not another goal's boundary). Skipping it
    // would let the scan reach the goal's own older continuation row and
    // reactivate a durably paused goal. Invalid IDs degrade to legacy
    // unscoped semantics: conservative paused, not scoped.
    const created = await setGoalOk(service, { workspaceId, objective: "Corrupt boundary" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });
    const corruptBoundary = createMuxMessage(
      `goal-paused-corrupt-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: 42 as unknown as string },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, corruptBoundary)).success).toBe(true);
    // Durable pause written directly (no boundary append, no in-memory pause
    // bookkeeping) — models the post-restart state where only the persisted
    // artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    // Reconciliation must not treat the corrupt boundary as another goal's
    // row and reactivate off the continuation row beneath it.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a non-UUID boundary goalId degrades to a conservative unscoped pause", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cRJEC): durable goal IDs are UUIDs, so a
    // corrupt non-UUID STRING on a pause boundary is not another goal's
    // boundary either. Treating it as scoped-different would skip it, reach
    // the goal's own older continuation row, and reactivate a durably paused
    // goal after restart.
    const created = await setGoalOk(service, { workspaceId, objective: "Non-UUID boundary" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });
    const corruptBoundary = createMuxMessage(
      `goal-paused-nonuuid-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: "broken" },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, corruptBoundary)).success).toBe(true);
    // Durable pause written directly (no boundary append, no in-memory pause
    // bookkeeping) — models the post-restart state where only the persisted
    // artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a malformed continuation goalId is not legacy activity evidence", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cOHpI): legacy any-goal semantics apply only
    // when the scoping ID is genuinely absent. A present-but-malformed ID on
    // a continuation row must be skipped, not accepted as legacy-active — at
    // the tail it would otherwise reactivate a durably paused goal.
    const created = await setGoalOk(service, { workspaceId, objective: "Corrupt continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: 42 as unknown as string,
    });
    // Durable pause written directly (no boundary, no in-memory bookkeeping)
    // — models the post-restart state where only persisted artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a stop landing during post-write publication restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOHpB): the post-write recheck samples the
    // stop generation, but pushSnapshot/pushLiveGoalPreviewOverlay still
    // await inside the same lock tenure. A Stop landing there left the
    // aborted turn's complete_goal durable — the veto must stay active
    // through the final awaited publication step.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-publication" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
    };
    const realPush = serviceAccess.pushSnapshot.bind(service);
    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    let pushStarted = false;
    const pushSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1 | null) => {
        pushStarted = true;
        await pushGate;
        return realPush(id, goal);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => pushStarted, { timeoutMs: 5_000 });
    // Stop lands during the publication await, after the post-write sample.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releasePush();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    pushSpy.mockRestore();

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
  });

  test("the continuation dispatch admission probe goes stale when an explicit pause commits", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXR): an explicit Pause completing while
    // the dispatched continuation's send runs its unlocked preflight must
    // refuse the captured send — otherwise its synthetic row lands after the
    // pause boundary as fresh active evidence and reactivates the goal. The
    // dispatch passes an admissionStale probe that flips when the candidate
    // is deleted or the explicit-pause generation moves.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        // Model a send parked in preflight: never accept.
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Pause races dispatch" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });

    // Mid-preflight, before any pause: not stale.
    expect(capturedProbe!()).toBe(false);
    // Explicit pause commits during the preflight: deletes the candidate and
    // bumps the explicit-pause generation — the probe must flip stale.
    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(capturedProbe!()).toBe(true);
  });

  test("pre-goal queue races restore suspended budget wrap-up candidates", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cPbjX): a queued manual message that predates
    // a budget_limited goal (e.g. an auto-promoted revival whose retained
    // spend exceeds its budget) suspends the armed budget_wrapup candidate;
    // the active-only restore rule would reject it and strand the owed
    // wrap-up for the rest of the process. A matching budget-limited goal
    // that still owes its wrap-up must accept the restore.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap-up survives pre-goal queue race",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime: the armed candidate stays pending instead of firing.
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    const candidates = (
      service as unknown as {
        pendingContinuationCandidates: Map<string, { source: string }>;
      }
    ).pendingContinuationCandidates;
    // Stream-end arming on a budget_limited goal produces the wrap-up's
    // candidate (eligibility dispatches the wrap-up from any source).
    expect(candidates.get(workspaceId)?.source).toBe("stream_end");

    const suspended = service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspended).not.toBeNull();
    expect(candidates.has(workspaceId)).toBe(false);
    await service.restorePendingContinuationCandidate(workspaceId, suspended!);
    expect(candidates.get(workspaceId)?.source).toBe("stream_end");

    // A suppressed wrap-up is no longer owed — the restore must refuse it.
    const suspendedAgain =
      service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspendedAgain).not.toBeNull();
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    await service.restorePendingContinuationCandidate(workspaceId, suspendedAgain!);
    expect(candidates.has(workspaceId)).toBe(false);
  });

  test("the wrap-up dispatch admission probe goes stale when a manual message suppresses it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPBWX): a manual send during the wrap-up
    // send's preflight can suppress the wrap-up without making the session
    // busy; tryMarkBudgetLimitInjected refusing after acceptance is too late.
    // The wrap-up dispatch must carry an admission probe that flips on
    // candidate deletion, live-stamp ineligibility, or the suppression's
    // durable terminal-status write.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap-up races manual suppression",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    let capturedKind: string | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedKind = input.kind;
        capturedProbe = input.admissionStale;
        // Model a send parked in preflight: never accept.
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });
    expect(capturedKind).toBe(GOAL_BUDGET_LIMIT_KIND);

    // Mid-preflight, before the intervention: not stale.
    expect(capturedProbe!()).toBe(false);
    // Manual suppression commits during the preflight: durable user-origin
    // write (terminal-status bump) + live stamp re-mark — probe flips stale.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(capturedProbe!()).toBe(true);
  });

  test("the continuation admission probe goes stale when the goal completes mid-preflight", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPBWd): a same-goal completion (or an
    // accounting flip to budget_limited) during the send preflight neither
    // deletes the candidate nor bumps the explicit-pause generation — the
    // captured continuation would be admitted against a completed goal. The
    // terminal-status generation must flip the probe.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Completion races dispatch" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });

    expect(capturedProbe!()).toBe(false);
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Completed during the preflight",
    });
    expect(capturedProbe!()).toBe(true);
  });

  test("the continuation admission probe goes stale when the goal is replaced", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPuM6): an active→active replacement bumps
    // neither the pause nor the terminal generation, and the replaced goal's
    // candidate can stay installed until the replacement's kickoff finalizer
    // arms — the captured continuation for goal A would be admitted after
    // goal B is durable and its accounting would charge B for A's work. The
    // identity generation must flip the probe.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    let kickoffOptionsAvailable = true;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () =>
        Promise.resolve(
          kickoffOptionsAvailable ? { model: "openai:gpt-4o", agentId: "exec" } : null
        ),
    });
    await setGoalOk(service, { workspaceId, objective: "Goal A" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });
    expect(capturedProbe!()).toBe(false);

    // Models B's kickoff finalizer not having armed yet (no send options →
    // arming skipped): the candidate reference cannot flip the probe, only
    // the identity change can.
    kickoffOptionsAvailable = false;
    const candidates = (
      service as unknown as { pendingContinuationCandidates: Map<string, { goalId: string }> }
    ).pendingContinuationCandidates;
    const candidateBefore = candidates.get(workspaceId);
    await setGoalOk(service, { workspaceId, objective: "Goal B replaces A" });
    // Precondition for the clause under test: the candidate did not change.
    expect(candidates.get(workspaceId)).toBe(candidateBefore);
    expect(capturedProbe!()).toBe(true);
  });

  test("goal redispatch admission revalidates durable state and observes later transitions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): a redispatched goal turn (compaction
    // follow-up) lost its original admission guards. buildGoalRedispatchAdmission
    // re-derives them: durable revalidation plus a staleness probe.
    const created = await setGoalOk(service, { workspaceId, objective: "Redispatch admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible");
    }
    expect(admission.admissionStale()).toBe(false);

    // An explicit pause after the build flips the probe; a rebuild refuses.
    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(admission.admissionStale()).toBe(true);
    expect(
      (
        await service.buildGoalRedispatchAdmission(
          workspaceId,
          created.goalId,
          GOAL_CONTINUATION_KIND
        )
      ).admissible
    ).toBe(false);

    // Identity mismatch refuses outright.
    expect(
      (
        await service.buildGoalRedispatchAdmission(
          workspaceId,
          "other-goal",
          GOAL_CONTINUATION_KIND
        )
      ).admissible
    ).toBe(false);
  });

  test("goal redispatch admission rejects a goal transition that commits during its state read", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Pause races redispatch read",
    });
    const serviceAccess = service as unknown as {
      readGoalFile: (id: string) => Promise<GoalRecordV1 | null>;
    };
    const realReadGoalFile = serviceAccess.readGoalFile.bind(service);
    let releaseStaleRead!: () => void;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    let staleReadCaptured = false;
    const readSpy = spyOn(serviceAccess, "readGoalFile").mockImplementationOnce(
      async (id: string) => {
        const staleGoal = await realReadGoalFile(id);
        staleReadCaptured = true;
        await staleReadGate;
        return staleGoal;
      }
    );

    const admissionPromise = service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    await waitForCondition(() => staleReadCaptured, { timeoutMs: 5_000 });
    await setGoalOk(service, { workspaceId, status: "paused" });
    releaseStaleRead();

    expect((await admissionPromise).admissible).toBe(false);
    readSpy.mockRestore();
  });

  test("goal redispatch admission goes stale when the goal is cleared", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Clear invalidates redispatch",
    });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible");
    }

    await service.clearGoal(workspaceId);

    expect(admission.admissionStale()).toBe(true);
  });

  test("goal redispatch admission accepts a compacted wrap-up that owns its reservation", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Compacted wrap-up keeps reservation",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge());
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 2,
    });
    await drainPendingDispatches();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });

    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_BUDGET_LIMIT_KIND
    );

    expect(admission.admissible).toBe(true);
  });

  test("a stop landing during auto-promotion reads restores the completed goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): maybeAutoPromoteOnComplete awaits
    // board/streaming/pricing reads after the caller's publication sample. A
    // Stop landing there must neither leave the aborted completion durable
    // nor promote the next upcoming goal from the aborted turn.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-promotion" });
    const queued = await service.addUpcomingGoal({ workspaceId, objective: "Next in queue" });

    const serviceAccess = service as unknown as {
      readBoard: (id: string) => Promise<unknown>;
    };
    const realReadBoard = serviceAccess.readBoard.bind(service);
    let releaseBoard!: () => void;
    const boardGate = new Promise<void>((resolve) => {
      releaseBoard = resolve;
    });
    let boardReadStarted = false;
    const boardSpy = spyOn(serviceAccess, "readBoard").mockImplementationOnce(
      async (id: string) => {
        boardReadStarted = true;
        await boardGate;
        return realReadBoard(id);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => boardReadStarted, { timeoutMs: 5_000 });
    // Stop lands during the auto-promotion's board read.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseBoard();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    boardSpy.mockRestore();

    // The prior goal is restored (not completed, not promoted) and gated.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
    // The upcoming goal was not consumed by the aborted promotion.
    const board = await service.getGoalBoard(workspaceId);
    const upcomingEntry = board.entries.find((e) => e.section === "upcoming");
    expect(upcomingEntry?.goal.goalId).toBe(queued.goalId);
  });

  test("a stop landing during the promotion writes rolls the promotion back", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B4): the pre-write veto above cannot see a
    // Stop landing INSIDE the promotion's board/goal/snapshot writes. The
    // promotion would complete durably, and the caller deliberately skips
    // restoring once goal.json no longer holds its completion — leaving the
    // aborted completion archived and the board advanced despite the Stop.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-write" });
    const queued = await service.addUpcomingGoal({ workspaceId, objective: "Next in queue" });

    const serviceAccess = service as unknown as {
      writeBoard: (id: string, board: unknown) => Promise<void>;
    };
    const realWriteBoard = serviceAccess.writeBoard.bind(service);
    const boardSpy = spyOn(serviceAccess, "writeBoard").mockImplementationOnce(
      async (id: string, board: unknown) => {
        // Stop lands during the first promotion write: the generation bump is
        // synchronous even though the locked acknowledgment waits behind the
        // in-flight setter's lock tenure.
        void service.recordUserStoppedStream(id);
        return realWriteBoard(id, board);
      }
    );

    const completed = await service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    boardSpy.mockRestore();
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }

    // The promotion transaction rolled back and the caller restored the
    // pre-completion record.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    // The upcoming goal was not consumed by the aborted promotion.
    const board = await service.getGoalBoard(workspaceId);
    const upcomingEntry = board.entries.find((e) => e.section === "upcoming");
    expect(upcomingEntry?.goal.goalId).toBe(queued.goalId);
  });

  test("raising the budget out of budget_limited invalidates captured wrap-up admissions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cTN_o): re-arming budget_limited→active by
    // raising the exhausted limit changes neither identity, objective, nor
    // pause state — a budget wrap-up admission captured before the raise
    // would stay fresh and charge a stale stopping turn after reactivation.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Re-armed budget",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_BUDGET_LIMIT_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    // User raises the limit: applyBudgetDrivenStatus re-arms the goal active.
    await setGoalOk(service, { workspaceId, budgetCents: 1_000 });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "active" });

    expect(admission.admissionStale()).toBe(true);
  });

  test("getGoal preserves Resume consent for previously driven goals", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cTN_r): the consent arm must apply
    // independently of the never-driven kickoff guard. A user who explicitly
    // resumes with a queued message pending has opted in — the row's
    // dispatch-time tail sync runs before manual-message goal safety, and
    // writing the resumed goal back to paused would discard the Resume with
    // no repair path (candidate restoration requires an active goal).
    await setGoalOk(service, { workspaceId, objective: "Driven then resumed" });
    await driveOneContinuation();
    // Keep the resume from arming a kickoff candidate so this exercises the
    // durable path (candidates are lost on restart/eviction anyway).
    (service as unknown as { suppressKickoffContinuation: boolean }).suppressKickoffContinuation =
      true;
    try {
      await setGoalOk(service, { workspaceId, status: "paused" });
      const authoredAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      await setGoalOk(service, { workspaceId, status: "active" });
      // The queued row dispatches after the Resume; its authoring predates it.
      await appendUserHistoryMessage(historyService, workspaceId, "Queued before resume", {
        timestamp: Date.now(),
        enqueuedAtMs: authoredAtMs,
      });

      const reconciled = await service.getGoal(workspaceId);

      expect(reconciled).toMatchObject({ status: "active" });
    } finally {
      (service as unknown as { suppressKickoffContinuation: boolean }).suppressKickoffContinuation =
        false;
    }
  });

  test("a same-ID objective edit invalidates captured redispatch admissions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B1): an editInPlace rename keeps the
    // goalId, so the identity generation previously stayed put — a captured
    // continuation embedding the OLD objective could be admitted after the
    // user redirected the goal.
    const created = await setGoalOk(service, { workspaceId, objective: "Original objective" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    await setGoalOk(service, {
      workspaceId,
      objective: "Redirected objective",
      editInPlace: true,
    });

    expect(admission.admissionStale()).toBe(true);
  });

  test("a failed preview reset publication is retried on the next usage delta", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cOgXY): the reset deleted the cached live
    // preview BEFORE publishing the durable snapshot. A failed publication
    // then left no cached preview for later deltas to observe, so the reset
    // never retried and the Goal UI kept the stale cost. Publish first;
    // clear only after success.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview reset retry",
      budgetCents: 500,
    });
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    const previews = (service as unknown as { liveGoalPreviewSnapshots: Map<string, unknown> })
      .liveGoalPreviewSnapshots;
    expect(previews.has(workspaceId)).toBe(true);
    // Mid-stream pause makes the next delta ineligible.
    await setGoalOk(service, { workspaceId, status: "paused" });

    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
    };
    const pushSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: snapshot publish lost"))
    );
    let threw = false;
    try {
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 0.6,
        streamStartedAtMs: created.createdAtMs + 1,
        streamOriginKind: "other",
      });
    } catch {
      threw = true;
    }
    pushSpy.mockRestore();
    expect(threw).toBe(true);
    // The cache survives the failed publication so a later delta retries.
    expect(previews.has(workspaceId)).toBe(true);

    // The next delta completes the reset.
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.7,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    expect(previews.has(workspaceId)).toBe(false);
  });

  test("continuation rows for a replaced goal do not reconcile the newer goal to active", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cH3kV): goal A fired a continuation and was
    // paused, then replaced with goal B which the user pauses. When B's pause
    // finalizer cannot land its own boundary (crash / append failure), any
    // later reconciliation skips A's goal-scoped boundary and would otherwise
    // reach A's older continuation row and silently reactivate B.
    // Continuation evidence is goal-scoped.
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: goalA.goalId,
    });
    const pausedBoundary = createMuxMessage(
      `goal-paused-a-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, pausedBoundary)).success).toBe(true);

    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });
    // Simulate B's pause boundary append being lost (crash-equivalent): the
    // finalizer skips its post-pause chat-tail sync, leaving the tail ending
    // at goal A's rows while goal.json durably says B is paused.
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "injected: boundary append lost" })
    );
    await setGoalOk(service, { workspaceId, status: "paused" });
    appendSpy.mockRestore();

    // Reconciliation skips A's boundary AND A's continuation row — B stays paused.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });

    // Legacy continuation rows without a goalId keep the old any-goal semantics.
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });
  });

  test("legacy unscoped continuation rows behind another goal's rows do not reactivate the current goal", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NC): mixed-version history. A pre-upgrade
    // continuation row has no goalId; once the scan crosses a row scoped to a
    // DIFFERENT goal (goal A's boundary), it is inside A's history — the
    // unscoped legacy row beneath belongs to A and must not reactivate the
    // explicitly paused replacement B.
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      // no goalId: written before goal scoping existed
    });
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A legacy era" });
    const scopedBoundary = createMuxMessage(
      `goal-paused-a-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, scopedBoundary)).success).toBe(true);

    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B replacement" });
    // Simulate B's pause boundary append being lost (crash-equivalent), as in
    // the scoped-row regression above.
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "injected: boundary append lost" })
    );
    await setGoalOk(service, { workspaceId, status: "paused" });
    appendSpy.mockRestore();

    // The legacy row sits behind A's mismatched boundary — not evidence for B.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
  });

  test("a manual message during budget_limited durably suppresses the wrap-up across restarts", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NM): deleting the in-memory wrap-up
    // candidate is not enough — after a restart the durable record still
    // looks wrap-up-eligible (goal-attributable origin, not yet injected) and
    // recovery re-synthesizes the autonomous wrap-up over the user's
    // intervening message.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget hit, then user intervened",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cLpID): suppression is scoped to the goal the
    // manual message acknowledged — a different goal's identity is a no-op.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, "goal-someone-else");
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).not.toBe("user");

    // The manual-message hook persists the suppression.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitOriginKind: "user",
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cKkGL): the suppression must also neutralize
    // the LIVE eligibility state — without touching the in-memory stream
    // stamp, the manual turn's accounting preserves the goal-attributable
    // stamp and its stream-end arms a candidate that dispatches the wrap-up
    // immediately, no restart required.
    const liveDispatcher = new IdleDispatcher();
    const liveExecuted: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(liveDispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        liveExecuted.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    // The manual turn's own accounting preserves the existing budget_limited
    // stamp rather than overwriting it; its stream-end then requests a
    // continuation.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "user",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 3,
    });
    await drainPendingDispatches();
    expect(liveExecuted).toHaveLength(0);

    // Simulate restart: recovery must honor the durable suppression.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await drainPendingDispatches();

    expect(executed).toHaveLength(0);
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
      budgetLimitOriginKind: "user",
    });
  });

  test("a failed suppression write publishes no in-memory suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cLA0M): the durable origin must persist
    // BEFORE the live stamp updates. If the write fails (disk full, transient
    // fs error), no in-memory suppression may exist — otherwise this process
    // suppresses the wrap-up while goal.json stays goal-attributable, and a
    // restart re-arms the autonomous wrap-up despite the manual intervention.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Suppression write fails",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
    };
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );

    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: suppression write lost"))
    );
    let threw = false;
    try {
      await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    } catch {
      threw = true;
    }
    writeSpy.mockRestore();
    expect(threw).toBe(true);

    // Fail closed: memory never got ahead of disk.
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).not.toBe("user");

    // A retry (next manual message) succeeds and completes both halves.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
    expect(await service.getGoal(workspaceId)).toMatchObject({ budgetLimitOriginKind: "user" });
  });

  test("a failed snapshot publish after the suppression write still updates the live stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cMpob): once writeGoal committed, the durable
    // record says the wrap-up is suppressed. If the follow-up snapshot publish
    // fails, the method throws — but the live stamp must ALREADY be
    // user-origin, or this process's stream-end arms and dispatches the
    // wrap-up off the stale goal-attributable stamp while goal.json says
    // "user".
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Snapshot publish fails",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
    };
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );

    const snapshotSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: snapshot publish lost"))
    );
    let threw = false;
    try {
      await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    } catch {
      threw = true;
    }
    snapshotSpy.mockRestore();
    expect(threw).toBe(true);

    // Durable and live state agree: suppression is in effect.
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).toBe("user");
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
  });

  test("the wrap-up armer honors a durable suppression that completed under a stale record", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cMpoe): armBudgetWrapupForBudgetLimitedGoal
    // awaits kickoff options and the durable read unlocked, so a manual
    // suppression can complete in that window (modeled here by passing the
    // pre-suppression record). Without the durable origin recheck it would
    // overwrite the live user-origin stamp with goal_continuation and arm a
    // fresh candidate — resurrecting the wrap-up the suppression disarmed.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Armer vs suppression",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const stale = await service.getGoal(workspaceId);
    expect(stale).toMatchObject({ status: "budget_limited" });

    // Registered after setup so no kickoff candidate exists — the armer must
    // fall through to its durable recheck rather than an earlier guard.
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);

    const serviceAccess = service as unknown as {
      armBudgetWrapupForBudgetLimitedGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
      pendingContinuationCandidates: Map<string, unknown>;
    };
    await serviceAccess.armBudgetWrapupForBudgetLimitedGoal(workspaceId, stale!);
    await drainPendingDispatches();

    // The live suppression survives, no candidate was armed, nothing fired.
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
    expect(serviceAccess.pendingContinuationCandidates.has(workspaceId)).toBe(false);
    expect(executed).toHaveLength(0);
  });

  test("a stop landing inside the goal write restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cLpIP): a model complete_goal takes the
    // direct mutable branch during the live stream. The final pre-write stop
    // check can pass, then the Stop lands while writeGoal is replacing
    // goal.json; the stop's locked section queues behind the setter's tenure
    // and, seeing an already-complete goal, neither discards nor gates it.
    // The setter must recheck after the write and restore the prior record
    // before releasing the lock.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-write" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    // Stop lands mid-write: generation bumps synchronously, locked section queues.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    writeSpy.mockRestore();

    // Prior record restored; the stop's queued section then gated it normally.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
  });

  test("a stop landing during the drain's persistence discards the claimed mutation", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMGn8): recordUserStoppedStream invalidates a
    // queued mutation by deleting the pending-map entry, but the stream-end
    // drain claims (removes) it before persisting. A Stop landing while the
    // drain's locked persistence awaits I/O then has nothing left to delete —
    // the drain would durably archive/write the stopped turn's goal change and
    // the Stop merely acknowledgment-gates it. The claim must carry the stop
    // generation through persistence so the write is discarded and the prior
    // record survives.
    const original = await setGoalOk(service, { workspaceId, objective: "Original goal" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Replacement mid-stream" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      pendingGoalMutations: Map<string, { objective: string }>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    // The drain claims the mutation and parks inside the replacement write.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    // Stop lands mid-persistence: the pending-map entry is already claimed, so
    // only the generation recheck inside the drain's tenure can discard it.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const drained = await drainPromise;
    expect(drained).toBeNull();
    await stopPromise;
    writeSpy.mockRestore();

    // The aborted turn's replacement never became durable; the stop's queued
    // section gated the restored original instead.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: original.goalId,
      objective: "Original goal",
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("a stop landing during a drained rename's write restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMpoV): the editInPlace branch persists via
    // its own writeGoal and, unlike the same-objective and creation branches,
    // had no post-write stop recheck. A queued rename claimed by the
    // stream-end drain would keep the renamed record durable when the Stop
    // landed inside that write.
    const original = await setGoalOk(service, { workspaceId, objective: "Original name" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed mid-stream",
      editInPlace: true,
    });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const drained = await drainPromise;
    expect(drained).toBeNull();
    await stopPromise;
    writeSpy.mockRestore();

    // The rename never survived; the stop gated the restored original.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: original.goalId,
      objective: "Original name",
      status: "active",
    });
  });

  test("an explicit Resume during pause finalization survives the stale boundary", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cLpIT): a same-goal Resume can durably set the
    // goal active while the old pause finalizer is appending its boundary.
    // The boundary matches the goalId, so the finalizer's post-append
    // chat-tail sync (and any later reconciliation) would write the goal back
    // to paused — undoing the Resume. Durable-active + own scoped boundary
    // proves the Resume postdated the pause; it must win.
    const created = await setGoalOk(service, { workspaceId, objective: "Resume during pause" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append; Resume lands inside the window.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        appendStarted = true;
        await appendGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => appendStarted, { timeoutMs: 5_000 });
    const resumed = await service.setGoal({ workspaceId, status: "active" });
    expect(resumed.success).toBe(true);
    releaseAppend();
    await pausePromise;
    appendSpy.mockRestore();

    // The stale boundary sits at the tail, but the Resume wins — both in the
    // finalizer's own post-append sync and in later reconciliations.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
  });

  test("getGoal during pause finalization does not reactivate the goal being paused", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cIyKW): between the durable pause write and
    // the finalizer appending the goal-pause-boundary, the tail still ends at
    // the goal's own continuation row. A concurrent getGoal reconciliation
    // must not flip the goal back to active — that would make the finalizer's
    // identity guard bail (status drifted) and skip the candidate delete +
    // boundary append while the Pause call reports a stale paused result.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause under load" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append so the test can observe the window
    // while the pause hold is armed.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseBoundaryAppend!: () => void;
    const boundaryGate = new Promise<void>((resolve) => (releaseBoundaryAppend = resolve));
    let boundaryAppendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        boundaryAppendStarted = true;
        await boundaryGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => boundaryAppendStarted, { timeoutMs: 5_000 });

    // Mid-window: durable record is paused, boundary not yet in the tail.
    // Reconciliation must hold the pause instead of trusting the stale tail.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });

    releaseBoundaryAppend();
    const pauseResult = await pausePromise;
    expect(pauseResult.success).toBe(true);
    appendSpy.mockRestore();

    // Post-finalization: the boundary landed, so the pause is durable against
    // reconciliation without the in-memory hold.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("an admitted continuation firing mid-pause-finalization does not undo the pause", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): a goal continuation already admitted
    // (dispatch accepted) calls recordContinuationFired while an explicit
    // Pause is finalizing. The tail still ends at the goal's own continuation
    // row (boundary append in flight), so the paused→active acceptance would
    // flip the goal back — and once the scoped boundary lands, the
    // Resume-wins rule preserves that automatic flip as if the user resumed.
    // The firing must honor the pause-finalization hold.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause vs continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append so the firing runs mid-window.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        appendStarted = true;
        await appendGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => appendStarted, { timeoutMs: 5_000 });

    // Mid-window: the admitted continuation fires. Without the hold check it
    // would flip the paused goal back to active on "tail says active" evidence.
    const serviceAccess = service as unknown as {
      recordContinuationFired: (id: string, goalId: string, firedAtMs: number) => Promise<void>;
    };
    await serviceAccess.recordContinuationFired(workspaceId, created.goalId, Date.now());

    releaseAppend();
    const pauseResult = await pausePromise;
    expect(pauseResult.success).toBe(true);
    appendSpy.mockRestore();

    // The Pause wins — durably and against later reconciliation.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a continuation fired against pre-pause tail evidence does not reactivate the goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): recordContinuationFired reads the
    // chat tail outside the goal lock. An explicit Pause can fully commit
    // (durable write, scoped boundary append, hold release) between that read
    // and the locked apply — the stale "tail says active" evidence must not
    // flip the paused goal back to active, because the scoped boundary at the
    // tail would then make the Resume-wins rule preserve the flip durably.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stale-read continuation",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // One-shot: the real tail read completes first (pre-pause evidence), then
    // the full explicit Pause commits before the caller's locked section.
    const serviceAccess = service as unknown as {
      readChatTailGoalMode: (id: string, goalId?: string | null) => Promise<unknown>;
      recordContinuationFired: (id: string, goalId: string, firedAtMs: number) => Promise<void>;
    };
    const realRead = serviceAccess.readChatTailGoalMode.bind(service);
    serviceAccess.readChatTailGoalMode = async (id: string, goalId?: string | null) => {
      const evidence = await realRead(id, goalId);
      // Restore before pausing: the pause's own finalization reads the tail.
      serviceAccess.readChatTailGoalMode = realRead;
      const paused = await service.setGoal({ workspaceId, status: "paused" });
      expect(paused.success).toBe(true);
      return evidence;
    };

    await serviceAccess.recordContinuationFired(workspaceId, created.goalId, Date.now());

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("reconciliation with pre-pause tail evidence does not reactivate an explicitly paused goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): syncGoalStatusToChatTail shares the
    // unlocked-tail-read shape, and its in-flight hold check cannot see a
    // Pause that fully committed between the read and the locked apply. The
    // generation stamp must refuse the stale continuation-row evidence.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stale-read reconciliation",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    const serviceAccess = service as unknown as {
      readChatTailGoalMode: (id: string, goalId?: string | null) => Promise<unknown>;
    };
    const realRead = serviceAccess.readChatTailGoalMode.bind(service);
    serviceAccess.readChatTailGoalMode = async (id: string, goalId?: string | null) => {
      const evidence = await realRead(id, goalId);
      serviceAccess.readChatTailGoalMode = realRead;
      const paused = await service.setGoal({ workspaceId, status: "paused" });
      expect(paused.success).toBe(true);
      return evidence;
    };

    // A routine read (heartbeat / tool assembly) reconciles with the stale
    // evidence — the explicit Pause must win, now and on the next clean read.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("cost previews reset when the goal becomes ineligible for accounting mid-stream", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cEl4P): a status transition during the stream
    // (pause, complete, or a budget edit flipping the goal budget_limited)
    // makes further previews ineligible. The cached live preview must be
    // cleared and the durable snapshot published — otherwise
    // pushLiveGoalPreviewOverlay keeps re-emitting cost that final accounting
    // discards, and the Goal UI snaps backward only at stream end.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview reset",
      budgetCents: 500,
    });
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    const previews = (service as unknown as { liveGoalPreviewSnapshots: Map<string, unknown> })
      .liveGoalPreviewSnapshots;
    expect(previews.has(workspaceId)).toBe(true);

    // Mid-stream pause makes the next delta ineligible.
    await setGoalOk(service, { workspaceId, status: "paused" });
    const snapshots = captureGoalActivity(service);
    const returned = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.6,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });

    expect(previews.has(workspaceId)).toBe(false);
    // The durable record (no accounted cost) is what gets published and
    // returned — not the discarded preview cost.
    expect(returned?.costCents).toBe(0);
    expect(snapshots.at(-1)?.goal?.costCents).toBe(0);
  });

  test("restoring a suspended kickoff candidate is dropped when the goal was paused meanwhile", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cErQ7): kickoff eligibility deliberately
    // accepts paused goals (the durable kickoff window), so restoring a
    // suspended candidate after a concurrent Pause persisted would reactivate
    // the autonomous loop despite the pause. The restore must verify the goal
    // is still active under the goal file lock.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Fresh goal" });
    const candidates = (
      service as unknown as { pendingContinuationCandidates: Map<string, unknown> }
    ).pendingContinuationCandidates;
    expect(candidates.has(workspaceId)).toBe(true);

    const suspended = service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspended).not.toBeNull();
    if (!suspended) {
      throw new Error("expected a suspended candidate");
    }
    // The user pauses while the manual send is being classified.
    await setGoalOk(service, { workspaceId, status: "paused" });

    await service.restorePendingContinuationCandidate(workspaceId, suspended);
    expect(candidates.has(workspaceId)).toBe(false);
  });

  test("stale pause finalization does not pause a newer replacement goal", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cECpZ): pause finalization runs outside the
    // goal file lock — a replacement queued behind the pause's persist can
    // land before the pause's finalization resumes. The stale pause must not
    // delete the newer goal's kickoff candidate or append a pause boundary
    // that chat-tail sync applies to the newer goal.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime keeps armed candidates inspectable (not consumed).
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });

    // Replay goal A's pause finalization as if its setter resumed only after
    // B replaced A (MutexMap admitted B between A's persist and finalize).
    const internals = service as unknown as {
      finalizeGoalPersistence: (
        input: { workspaceId: string; status: GoalStatus },
        result: { success: true; data: GoalRecordV1 }
      ) => Promise<unknown>;
      pendingContinuationCandidates: Map<string, { goalId: string }>;
    };
    await internals.finalizeGoalPersistence(
      { workspaceId, status: "paused" },
      { success: true, data: { ...goalA, status: "paused" } }
    );

    expect(internals.pendingContinuationCandidates.get(workspaceId)?.goalId).toBe(goalB.goalId);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });
    const history = await historyService.getLastMessages(workspaceId, 20);
    expect(history.success).toBe(true);
    if (history.success) {
      const boundaryRows = history.data.filter(
        (message) => message.metadata?.muxMetadata?.type === "goal-pause-boundary"
      );
      expect(boundaryRows).toHaveLength(0);
    }
  });

  test("acknowledgeUser ignores messages authored before the acknowledgment gate", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cECpj): a send authored before a user stop
    // set the acknowledgment gate cannot acknowledge that stop — clearing the
    // durable gate would let restart recovery re-arm the goal despite the
    // newer Stop action.
    const created = await setGoalOk(service, { workspaceId, objective: "Gated goal" });
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    const gated = await service.getGoal(workspaceId);
    expect(gated?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Authored before the stop: the gate must survive.
    const afterStale = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 1_000,
    });
    expect(afterStale?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Codex P1 (PRRT_kwDOPxxmWM6cHJVn): same-millisecond authoring cannot
    // prove the send was admitted after the Stop — equality keeps the gate.
    const afterEqual = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 5_000,
    });
    expect(afterEqual?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Authored after the stop: an informed user action clears the gate.
    const afterFresh = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 6_000,
    });
    expect(afterFresh?.requireUserAcknowledgmentSinceMs).toBeNull();
  });

  test("a stale kickoff finalizer does not overwrite a newer goal's candidate", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cClKY): kickoff finalization runs outside the
    // goal file lock. While finalizer A awaits kickoff options, a newer setter
    // B can persist directly and arm B's kickoff; A resuming afterwards must
    // not replace B's candidate with a stale one that eligibility would drop
    // for goal-ID mismatch — that would strand durable goal B with no kickoff.
    const dispatcher = new IdleDispatcher();
    let kickoffCalls = 0;
    let releaseFirstKickoff!: () => void;
    const firstKickoffGate = new Promise<void>((resolve) => {
      releaseFirstKickoff = resolve;
    });
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime keeps eligibility deferring so armed candidates stay
      // inspectable instead of being consumed by a live dispatch.
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: async () => {
        kickoffCalls += 1;
        if (kickoffCalls === 1) {
          await firstKickoffGate;
        }
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });

    const setterAPromise = service.setGoal({ workspaceId, objective: "Stale finalizer goal A" });
    await waitForCondition(() => kickoffCalls === 1, { timeoutMs: 1_000 });
    // B persists and arms its kickoff while A's finalizer is still suspended.
    const goalB = await setGoalOk(service, { workspaceId, objective: "Newer goal B" });
    releaseFirstKickoff();
    const setterA = await setterAPromise;
    expect(setterA.success).toBe(true);

    const candidates = (
      service as unknown as {
        pendingContinuationCandidates: Map<string, { goalId: string }>;
      }
    ).pendingContinuationCandidates;
    expect(candidates.get(workspaceId)?.goalId).toBe(goalB.goalId);
  });

  test("stream-end drain racing publication persists the publication stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b_KgE): the stream can end while the queued
    // setter is still inside its publication await. The drain used to take the
    // mutation synchronously — outside the goal file lock — and persist the
    // pre-publication construction stamp, so a message authored during the
    // publication await was misclassified as a post-goal intervention. The
    // locked handoff must flush the setter first and drain the finalized
    // publication stamp.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drainPromises: Array<Promise<GoalRecordV1 | null>> = [];
    let fireDrains = false;
    let lastActivityReadMs = 0;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      if (fireDrains && drainPromises.length < 8) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        lastActivityReadMs = Date.now();
        // Simulate the stream ending during this await: the stream-end drain
        // races the setter that still holds the goal file lock. The drain
        // fired during the publication read is the regression case; earlier
        // fires see an empty mutation map and no-op.
        drainPromises.push(service.applyPendingAfterStreamEnd(workspaceId));
      }
      return snapshot;
    });

    fireDrains = true;
    const queued = await service.setGoal({
      workspaceId,
      objective: "Publication stamp handoff",
    });
    fireDrains = false;
    expect(queued.success).toBe(true);
    expect(drainPromises.length).toBeGreaterThan(0);
    await Promise.all(drainPromises);

    const persisted = await service.getGoal(workspaceId);
    expect(persisted).not.toBeNull();
    // The drain must persist the post-publication stamp, not the construction
    // stamp taken before the publication activity read.
    expect(persisted?.createdAtMs ?? -1).toBeGreaterThanOrEqual(lastActivityReadMs);
  });

  test("drain loops to persist a replacement mutation installed between claim and persistence", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cAl6e): the drain's claim and its persistence
    // run in separate lock tenures, and a setter interleaving between them can
    // still see the ended stream as live (async streaming=false update) and
    // install a NEWER mutation expecting a stream-end drain that would never
    // come. The drain must loop so the replacement is persisted too — a
    // single-pass drain persists the older mutation and strands the newer one.
    await extensionMetadata.setStreaming(workspaceId, true);
    const first = await setGoalOk(service, { workspaceId, objective: "First goal" });

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, unknown>;
    };
    // Hold the goal file lock with a gate so lock-queue order is
    // deterministic: [gate] -> drain claim -> replacement setter -> drain
    // persistence. The replacement setter therefore provably lands between
    // the drain's claim and its persistence tenure.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cGSPX): count lock admissions instead of
    // sleeping — the replacement setter's asynchronous pre-lock streaming
    // check has no time bound on a loaded worker, and releasing the gate
    // before it enqueues would let the drain settle first and fail the
    // `drained` assertion spuriously.
    let lockCalls = 0;
    const originalWithLock = serviceAccess.fileLocks.withLock.bind(serviceAccess.fileLocks);
    serviceAccess.fileLocks.withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return originalWithLock(key, fn);
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Queues the claim tenure behind the gate synchronously (the unlocked
    // fast-path check and withLock call run before the first await).
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    const replacementPromise = service.setGoal({
      workspaceId,
      objective: "Replacement goal",
      forceNewGoal: true,
      // Codex P2 (PRRT_kwDOPxxmWM6cBACj): the replacement targets the goal
      // the user sees — the first mutation's projected id. Because each drain
      // pass claims AND persists in one lock tenure, that id is already
      // durable when this setter validates, and the accepted guard stays
      // coherent when the drain replays this mutation on the next pass.
      expectedGoalId: first.goalId,
    });
    // Deterministic admission signal: gate (1), drain claim (2), replacement
    // setter (3). Only then may the gate open.
    await waitForCondition(() => lockCalls >= 3, { timeoutMs: 5_000 });
    releaseGate();
    await gateTenure;

    const [drained, replacement] = await Promise.all([drainPromise, replacementPromise]);

    expect(replacement.success).toBe(true);
    expect(drained).toMatchObject({ objective: "Replacement goal" });
    // Nothing may be left stranded for a stream-end hook that will not come.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("queued mid-stream goal replacement preserves expectedGoalId at drain time", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued replacement",
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    await extensionMetadata.setStreaming(workspaceId, false);
    await setGoalOk(service, { workspaceId, objective: "Concurrent replacement" });

    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Concurrent replacement",
    });
  });

  test("increments accounting for non-compaction stream completions", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Account for stream" });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.235,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 124, turnsUsed: 1 });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 124, turnsUsed: 1 });
  });

  test("accumulates sub-cent stream costs across goal turns", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Accumulate tiny costs",
      budgetCents: 1,
    });

    const first = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.004,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const second = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.004,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "goal_continuation",
    });
    const third = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.002,
      streamStartedAtMs: created.createdAtMs + 3,
      streamOriginKind: "goal_continuation",
    });

    expect(first).toMatchObject({ costCents: 0, costMicroCents: 400_000, status: "active" });
    expect(second).toMatchObject({ costCents: 1, costMicroCents: 800_000, status: "active" });
    expect(third).toMatchObject({
      costCents: 1,
      costMicroCents: 1_000_000,
      status: "budget_limited",
    });
  });

  test("paused goals ignore later stream accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User clarification mid-goal",
      turnCap: 3,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "paused" });
  });

  test("paused goals ignore maintenance stream accounting (heartbeats / wake turns)", async () => {
    // Regression: paused goals were charged turns/cost (and updatedAtMs bumped)
    // by every background wake turn ("other") and scheduled heartbeat, making
    // maintenance turns look like they had just touched the paused goal.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Paused during maintenance",
      turnCap: 3,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "paused" });
  });

  test("budget-limited goals ignore maintenance stream accounting", async () => {
    // Background wakes/heartbeats running while the budget wrap-up is pending
    // must not inflate the recorded overshoot; only goal-driven streams
    // (continuation / wrap-up) may still charge a budget_limited goal.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget exhausted",
      budgetCents: 100,
    });
    const limited = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(limited).toMatchObject({ status: "budget_limited", costCents: 125, turnsUsed: 1 });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    expect(updated).toMatchObject({ status: "budget_limited", costCents: 125, turnsUsed: 1 });
  });

  test("budget-limited goals ignore maintenance stream cost previews", async () => {
    // Live previews must agree with final accounting: a heartbeat/wake stream
    // on a budget_limited goal is discarded at stream end, so previewing its
    // cost would show a climbing number that snaps back when the turn ends.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget exhausted preview",
      budgetCents: 100,
    });
    const limited = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(limited).toMatchObject({ status: "budget_limited", costCents: 125 });

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    expect(preview).toMatchObject({ status: "budget_limited", costCents: 125 });
  });

  test("completed goals ignore later stream accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Already complete",
      budgetCents: 100,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "complete" });
  });

  test("completed goals count the completing goal-attributable stream", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Complete during continuation",
      budgetCents: 200,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 125, turnsUsed: 1, status: "complete" });
  });

  test("attributes child report cost once and persists the per-goal ledger", async () => {
    await setGoalOk(service, { workspaceId, objective: "Account for child reports" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "session-usage.json"),
      JSON.stringify({ version: 1, byModel: {}, rolledUpFrom: { "child-a": true } }, null, 2)
    );

    const first = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 37,
    });
    const second = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 37,
    });

    expect(first?.attributed).toBe(true);
    expect(first?.goalAfter).toMatchObject({
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: ["child-a"],
    });
    expect(second?.attributed).toBe(false);
    expect(second?.goalAfter).toMatchObject({
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: ["child-a"],
    });

    const goalOnDisk = JSON.parse(
      await fs.readFile(path.join(config.sessionsDir, workspaceId, "goal.json"), "utf-8")
    ) as GoalRecordV1;
    expect(goalOnDisk.attributedChildren).toEqual(["child-a"]);

    const sessionUsageOnDisk = JSON.parse(
      await fs.readFile(path.join(config.sessionsDir, workspaceId, "session-usage.json"), "utf-8")
    ) as { rolledUpFrom?: Record<string, unknown> };
    expect(sessionUsageOnDisk.rolledUpFrom).toEqual({ "child-a": true });
  });

  test("child attribution under budget re-requests a deferred parent continuation", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Continue after child completes",
      budgetCents: 500,
    });
    let hasActiveDescendantTasks = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => hasActiveDescendantTasks,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: execute,
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 1,
    });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    hasActiveDescendantTasks = false;
    await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-under-budget",
      childCostCents: 25,
    });
    await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("child attribution that flips to budget_limited arms a wrap-up dispatch", async () => {
    // when child attribution drives the
    // goal into budget_limited, the wrap-up must fire. Previously the goal
    // would sit stuck because attribution never produced a stream-end
    // candidate/stamp that `checkGoalContinuationEligibility` could reserve.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Drive into budget_limited via child attribution",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      // Recovery / attribution paths synthesize a candidate from scratch and
      // need a kickoff send-options provider to know how to dispatch.
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const result = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-wrapper",
      childCostCents: 200,
    });

    expect(result?.causedBudgetLimit).toBe(true);
    expect(result?.goalAfter).toMatchObject({
      goalId: created.goalId,
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });
    expect(executed[0]?.kind).toBe(GOAL_BUDGET_LIMIT_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("child report attribution flips active goals to budget-limited once", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Child blows budget",
      budgetCents: 100,
    });

    const first = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 125,
    });
    const second = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 125,
    });
    const third = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-b",
      childCostCents: 10,
    });

    expect(first).toMatchObject({ attributed: true, causedBudgetLimit: true });
    expect(first?.goalBefore).toMatchObject({ status: "active", costCents: 0 });
    expect(first?.goalAfter).toMatchObject({ status: "budget_limited", costCents: 125 });
    expect(second).toMatchObject({ attributed: false, causedBudgetLimit: false });
    expect(third).toMatchObject({ attributed: true, causedBudgetLimit: false });
    expect(third?.goalAfter).toMatchObject({
      status: "budget_limited",
      costCents: 135,
      turnsUsed: 2,
      attributedChildren: ["child-a", "child-b"],
    });
    const lifecycleCalls = analytics.recordGoalLifecycleEvent.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    const budgetLimitedCalls = lifecycleCalls.filter(([event]) => event === "goal_budget_limited");
    expect(budgetLimitedCalls).toHaveLength(1);
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_limited",
      expect.objectContaining({ "caused-by-child": true, "cost-overshoot": "1-99" })
    );
  });

  test("skips accounting for compaction stream completions", async () => {
    await setGoalOk(service, { workspaceId, objective: "Ignore compaction" });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      isCompaction: true,
    });

    expect(updated).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, turnsUsed: 0 });
  });

  test("counts aborted streams and one turn per counted stream", async () => {
    await setGoalOk(service, { workspaceId, objective: "Count aborts" });

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.1,
      streamOriginKind: "goal_continuation",
    });
    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.2,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 30, turnsUsed: 2 });
  });

  test("ignores streams that started before the goal existed", async () => {
    // Pin the stream timestamp explicitly to avoid racing the wall clock for
    // ordering (the goal's createdAtMs uses Date.now() at write time).
    await setGoalOk(service, { workspaceId, objective: "Ignore pre-goal stream" });
    const goalAtCreation = await service.getGoal(workspaceId);
    const streamStartedAtMs = (goalAtCreation?.createdAtMs ?? Date.now()) - 100;

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 5,
      streamStartedAtMs,
    });

    expect(updated).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, turnsUsed: 0 });
  });

  test("previews live stream cost without double-counting final accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview live cost",
      budgetCents: 1_000,
    });
    // Capture activity events so we can assert that previews reach
    // subscribers (the renderer's WorkspaceStore) via the transient
    // activity emit. When a baseline activity snapshot exists,
    // `previewStreamAccounting` does NOT write to extensionMetadata.json
    // or goal.json. The durable record is updated only by
    // `recordStreamAccounting` at stream end.
    const activityUpdates = captureGoalActivity(service);

    const firstPreview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    const secondPreview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(firstPreview).toMatchObject({ costCents: 50, budgetCents: 1_000 });
    expect(secondPreview).toMatchObject({ costCents: 125, budgetCents: 1_000 });
    // Transient activity snapshots reflect the latest preview so the UI
    // updates without waiting on a disk write round-trip.
    expect(activityUpdates.at(-1)).toMatchObject({
      transientGoalOnly: true,
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    // Neither extensionMetadata.json nor goal.json should carry the
    // preview cost — both stay at the durable pre-stream value.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 1_000 },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, budgetCents: 1_000 });

    const editedDuringStream = await setGoalOk(service, { workspaceId, budgetCents: 2_000 });
    const previewAfterEdit = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.5,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    expect(editedDuringStream).toMatchObject({ budgetCents: 2_000 });
    expect(previewAfterEdit).toMatchObject({ costCents: 150, budgetCents: 2_000 });

    const final = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(final).toMatchObject({ costCents: 125, turnsUsed: 1, status: "active" });

    const previewAfterFinal = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    expect(previewAfterFinal).toBeNull();
    // Final accounting persists to both goal.json and extensionMetadata.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 125, budgetCents: 2_000 },
    });
  });

  test("previewStreamAccounting falls back when no activity snapshot exists", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview without metadata",
      budgetCents: 1_000,
    });
    // Clear the snapshot by rewriting the file directly: deleteWorkspace now
    // write-tombstones removed workspaces for the rest of the process, which
    // would (correctly) block the preview persistence below. This test
    // simulates a LIVE workspace that merely has no activity snapshot yet.
    await fs.writeFile(
      path.join(config.rootDir, "extensionMetadata.json"),
      JSON.stringify({ version: 1, workspaces: {} })
    );
    const activityUpdates = captureGoalActivity(service);

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(preview).toMatchObject({ costCents: 125, budgetCents: 1_000 });
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    expect(activityUpdates.at(-1)?.transientGoalOnly).toBeUndefined();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, budgetCents: 1_000 });
  });

  test("budget edits preserve live preview activity while durable accounting stays pre-stream", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget edit keeps live used amount",
      budgetCents: 1_000,
    });
    const activityUpdates = captureGoalActivity(service);

    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    const updated = await setGoalOk(service, { workspaceId, budgetCents: 2_000 });

    expect(updated).toMatchObject({ costCents: 0, budgetCents: 2_000 });
    // Updating only the limit writes the durable pre-stream accounting to
    // goal.json, then emits a transient overlay so the Goals UI does not
    // reset "used" from the live Stats cost back to $0.00 mid-stream.
    expect(activityUpdates.at(-1)).toMatchObject({
      transientGoalOnly: true,
      goal: { costCents: 125, budgetCents: 2_000 },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 2_000 },
    });

    const final = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(final).toMatchObject({ costCents: 125, budgetCents: 2_000 });
  });

  test("previewStreamAccounting preserves queued replacement snapshots", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Old goal" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued replacement goal",
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(preview).toMatchObject({
      objective: "Queued replacement goal",
      pendingPersistence: true,
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Old goal" },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Old goal" });
  });

  test("previewStreamAccounting skips paused goals, compactions, and stale streams", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview guard coverage",
      budgetCents: 1_000,
    });

    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        isCompaction: true,
        streamStartedAtMs: created.createdAtMs + 1,
      })
    ).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0 },
    });

    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        streamStartedAtMs: created.createdAtMs - 1,
      })
    ).toBeNull();

    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        streamStartedAtMs: created.createdAtMs + 1,
      })
    ).toMatchObject({ costCents: 0, status: "paused" });
  });

  test("flips active goals to budget-limited when stream cost reaches the budget", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Hit cost budget",
      budgetCents: 124,
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.24,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 124, turnsUsed: 1, status: "budget_limited" });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_limited",
      expect.objectContaining({ "cost-overshoot": "0" })
    );
  });

  test("emits budget telemetry when setGoal touches budget or turn caps", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Telemetry goal",
      budgetCents: 500,
      turnCap: 25,
    });

    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_changed",
      expect.objectContaining({
        "budget-delta-sign": "positive",
        "budget-raised-vs-lowered": "raised",
        "turn-cap-delta-sign": "positive",
        "turn-cap-raised-vs-lowered": "raised",
      })
    );
  });

  test("allows user lifecycle transitions and persists completion summaries", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Lifecycle goal" });

    const paused = await setGoalOk(service, { workspaceId, status: "paused" });
    expect(paused).toMatchObject({ goalId: created.goalId, status: "paused" });

    const resumed = await setGoalOk(service, { workspaceId, status: "active" });
    expect(resumed).toMatchObject({ goalId: created.goalId, status: "active" });

    const completed = await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(completed).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { status: "complete", completionSummary: "Verified the goal manually." },
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "user" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_resumed",
      expect.objectContaining({ initiator: "user" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "user", summaryLengthBucket: "10-49" })
    );
  });

  test("allows budget-limited goals to be completed manually", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap up over-budget goal",
      status: "budget_limited",
    });

    const completed = await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Stopped after hitting the budget.",
    });

    expect(completed).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Stopped after hitting the budget.",
    });
  });

  test("auto initiator pause emits telemetry", async () => {
    await setGoalOk(service, { workspaceId, objective: "Pause automatically" });

    const paused = await setGoalOk(service, {
      workspaceId,
      status: "paused",
      initiator: "auto",
    });

    expect(paused.status).toBe("paused");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "auto" })
    );
  });

  test("clears a pending user acknowledgment without changing status", async () => {
    await setGoalOk(service, { workspaceId, objective: "Await user acknowledgment" });
    await service.requireUserAcknowledgment(workspaceId, 12_345);

    const acknowledged = await service.acknowledgeUser(workspaceId);

    expect(acknowledged).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });
  });

  test("crash-recovery acknowledgment gate only touches goal-bearing workspaces", async () => {
    await setGoalOk(service, { workspaceId, objective: "Review crash recovery" });

    const gated = await service.requireUserAcknowledgmentForCrashRecovery(workspaceId, 44_000);
    const missing = await service.requireUserAcknowledgmentForCrashRecovery("missing-goal", 45_000);

    expect(gated).toMatchObject({ requireUserAcknowledgmentSinceMs: 44_000 });
    expect(missing).toBeNull();
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.objectContaining({ workspaceIdLengthBucket: "10-49" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledTimes(2);
  });

  test("rejects illegal user lifecycle transitions with typed errors", async () => {
    // setGoal now catches WorkspaceGoalTransitionError and returns
    // it as a typed `invalid_transition` Result error so the oRPC handler
    // doesn't leak it as an unhandled 500.
    async function expectSetGoalError(
      input: Parameters<WorkspaceGoalService["setGoal"]>[0],
      message: string
    ) {
      const result = await service.setGoal(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("invalid_transition");
        if (result.error.type === "invalid_transition") {
          expect(result.error.message).toBe(message);
        }
      }
    }

    await expectSetGoalError(
      { workspaceId, status: "paused" },
      "Cannot pause a goal because no goal is set."
    );

    await setGoalOk(service, { workspaceId, objective: "Illegal transitions" });
    await expectSetGoalError(
      { workspaceId, status: "active" },
      "Cannot resume a goal that is not paused."
    );
    await expectSetGoalError(
      { workspaceId, status: "complete" },
      "Completion summary is required."
    );

    await setGoalOk(service, { workspaceId, status: "paused" });
    await expectSetGoalError(
      {
        workspaceId,
        status: "complete",
        completionSummary: "Cannot complete from pause.",
      },
      "Cannot complete a goal that is not active or budget-limited."
    );

    await setGoalOk(service, { workspaceId, status: "active" });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Done for good.",
    });
    // User-initiated resume / pause out of `complete` is intentionally
    // allowed: the user can revive a goal the agent marked complete too
    // eagerly. Model/auto initiators are still blocked below.
    await expectSetGoalError(
      { workspaceId, status: "paused", initiator: "model" },
      "Cannot pause a completed goal. Clear it before starting another."
    );
    await expectSetGoalError(
      { workspaceId, status: "active", initiator: "model" },
      "Cannot resume a completed goal. Clear it before starting another."
    );
  });

  test("user can resume a completed goal (revive after agent marked complete)", async () => {
    // The agent marks the goal complete via the `complete_goal` tool
    // (initiator: "model"), then a human in the GoalTab clicks "Resume"
    // because the goal was not actually done. The backend must allow the
    // transition out of `complete` for user-initiated callers, and emit
    // `goal_resumed` so the lifecycle funnel sees the revive symmetrically
    // with a paused→active resume.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Revive completed goal",
    });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Agent thought it was done.",
      initiator: "model",
    });

    const revived = await setGoalOk(service, {
      workspaceId,
      status: "active",
      initiator: "user",
    });
    expect(revived).toMatchObject({ goalId: created.goalId, status: "active" });
    // Completion summary is cleared by `completionSummaryPatch` whenever
    // status moves out of `complete` — keeps the visible "Completion
    // summary" panel from lingering on a resumed goal.
    expect(revived.completionSummary).toBeUndefined();
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_resumed",
      expect.objectContaining({ initiator: "user" })
    );
  });

  test("user can pause a completed goal without resuming first", async () => {
    // Symmetry with resume-from-complete: a user who wants to revive a
    // completed goal but not immediately re-arm continuations can land it
    // in `paused` directly.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Pause completed goal",
    });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Wrap-up first pass.",
    });

    const paused = await setGoalOk(service, {
      workspaceId,
      status: "paused",
      initiator: "user",
    });
    expect(paused).toMatchObject({ goalId: created.goalId, status: "paused" });
    expect(paused.completionSummary).toBeUndefined();
  });

  test("budget-only mutation against a missing goal returns invalid_transition (no plain Error 500)", async () => {
    // simulates the race where the user
    // clicks "Update budget" in the RightSidebar / GoalTab, another window
    // clears the goal concurrently, and `setGoalWithConflictRetry` then
    // calls `setGoal({ workspaceId, budgetCents: N })` against a now-empty
    // goal slot. With no objective, no status, and no current goal, this
    // path used to throw a plain `Error("Goal objective is required.")`
    // that escaped the wrapper as an unhandled 500. Now it throws
    // `WorkspaceGoalTransitionError` so the wrapper turns it into a typed
    // `invalid_transition` Result.
    const result = await service.setGoal({ workspaceId, budgetCents: 500 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("invalid_transition");
    }
  });

  // -------------------------------------------------------------------------
  // assertPricedModelForBudgetedGoal — canonical gate that every dispatch
  // path delegates to. Lives on WorkspaceGoalService so WorkspaceService AND
  // AgentSession share one implementation; that's required because queued
  // messages dispatched via AgentSession.sendQueuedMessages() never re-enter
  // WorkspaceService, and a budgeted goal that becomes resumable while a
  // queued unpriced-model message waits would otherwise bypass enforcement.
  // -------------------------------------------------------------------------
  describe("assertPricedModelForBudgetedGoal", () => {
    const UNPRICED = "openai:not-priced-model";
    const PRICED = "openai:gpt-4o-mini";

    test("rejects unpriced model on a resumable budgeted goal", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("unknown");
        if (result.error.type === "unknown") {
          expect(result.error.raw).toContain("Target model has no pricing data");
        }
      }
    });

    test("rejects on paused budgeted goals (would resume on un-pause)", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });
      await setGoalOk(service, { workspaceId, status: "paused" });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(false);
    });

    test("priced models short-circuit before reading goal.json", async () => {
      // Internal compaction / heartbeat callers always pick a priced model, so
      // they hit the early-exit and never touch goal.json. We can't observe
      // the absence of disk I/O directly, but we can prove the goal record is
      // never consulted: no goal exists, yet the call returns Ok and is fast.
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, PRICED);
      expect(result.success).toBe(true);
    });

    test("undefined model is treated as not-yet-resolved and passes through", async () => {
      // The model-resolution cascade in WorkspaceService can return null when
      // a workspace has no AI settings and no global default, in which case
      // the gate must not block — the actual stream layer will pick a fallback.
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, undefined);
      expect(result.success).toBe(true);
    });

    test("allows when no goal exists", async () => {
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });

    test("allows when goal has no budget", async () => {
      await setGoalOk(service, { workspaceId, objective: "ship" });
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });

    test("allows when goal is complete (terminal)", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "done",
      });
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });
  });

  describe("goal board (multi-goal queue)", () => {
    test("getGoalBoard returns an empty snapshot when nothing exists", async () => {
      const board = await service.getGoalBoard(workspaceId);
      expect(board).toEqual({ entries: [] });
    });

    test("addUpcomingGoal appends to the upcoming list and getGoalBoard reflects it", async () => {
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Refactor auth flow",
        budgetCents: 1000,
        turnCap: 20,
      });
      expect(queued.objective).toBe("Refactor auth flow");
      // Upcoming goals are stored with a placeholder `paused` status —
      // promote/auto-promote is what flips them to `active`.
      expect(queued.status).toBe("paused");

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries).toHaveLength(1);
      expect(board.entries[0]).toMatchObject({
        section: "upcoming",
        goal: { goalId: queued.goalId, objective: "Refactor auth flow" },
      });
    });

    test("board surfaces active + upcoming together with active first", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Active work" });
      const upcoming = await service.addUpcomingGoal({ workspaceId, objective: "Next up" });
      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.map((e) => [e.section, e.goal.goalId])).toEqual([
        ["active", active.goalId],
        ["upcoming", upcoming.goalId],
      ]);
    });

    test("auto-promotes the next upcoming goal when the active goal completes", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "First" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second" });
      const dispatcher = new IdleDispatcher();
      const executed: string[] = [];
      service.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: () => ({ isRuntimeCompatible: true }),
        executeGoalContinuation: (input) => {
          executed.push(input.message);
          return Promise.resolve(true);
        },
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      // Mark the active goal complete. The board's invariant is: the
      // completed goal moves to history + the next upcoming becomes
      // active in the same write, then the promoted goal starts without a
      // manual pause/unpause nudge.
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "Wrapped up first goal.",
      });

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);
      expect(activeEntry?.goal.status).toBe("active");

      await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });
      expect(executed[0]).toContain("Second");

      const completed = board.entries.find(
        (e) => e.section === "complete" && e.goal.goalId === active.goalId
      );
      expect(completed).toBeDefined();
    });

    test("completeGoalFromSilentContinuation promotes the next upcoming goal", async () => {
      // #3326 Codex P2 (PRRT_kwDOPxxmWM6DMh9j): silent-continuation
      // completion must run the deferred auto-promote pass, otherwise
      // the queued upcoming goal would stay stuck until some later
      // manual mutation (because `maybeAutoPromoteOnComplete`'s inline
      // pass races with the async `setStreaming(false)` listener).
      const active = await setGoalOk(service, { workspaceId, objective: "First" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second" });

      const result = await service.completeGoalFromSilentContinuation({
        workspaceId,
        completionSummary: "Looks done.",
      });
      expect(result?.goalId).toBe(active.goalId);
      expect(result?.status).toBe("complete");

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);
      expect(activeEntry?.goal.status).toBe("active");

      const completedEntry = board.entries.find(
        (e) => e.section === "complete" && e.goal.goalId === active.goalId
      );
      expect(completedEntry).toBeDefined();
    });

    test("does NOT auto-promote when the upcoming list is empty (preserves single-goal UX)", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Solo" });
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "All done.",
      });

      // Without queued upcoming goals, the active goal stays in
      // `goal.json` with its completion summary so the existing
      // single-goal UX is preserved.
      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(active.goalId);
      expect(activeEntry?.goal.status).toBe("complete");
      expect(activeEntry?.goal.completionSummary).toBe("All done.");
    });

    test("archiveGoal moves an upcoming goal to archived", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "To archive" });
      await service.archiveGoal(workspaceId, queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "upcoming")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "archived")?.goal.goalId).toBe(queued.goalId);
    });

    test("archiveGoal handles the active goal by clearing it and snapshotting into archived", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Active to archive" });
      await service.archiveGoal(workspaceId, active.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "active")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "archived")?.goal.goalId).toBe(active.goalId);
    });

    test("reviveArchivedGoal returns an archived goal to upcoming", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Revivable" });
      await service.archiveGoal(workspaceId, queued.goalId);
      await service.reviveArchivedGoal(workspaceId, queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "archived")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "upcoming")?.goal.goalId).toBe(queued.goalId);
    });

    test("reorderUpcomingGoals applies the given id order, defensively dropping unknown ids", async () => {
      const a = await service.addUpcomingGoal({ workspaceId, objective: "A" });
      const b = await service.addUpcomingGoal({ workspaceId, objective: "B" });
      const c = await service.addUpcomingGoal({ workspaceId, objective: "C" });

      // Reorder to C, A, B with an unknown id mixed in.
      await service.reorderUpcomingGoals(workspaceId, [
        c.goalId,
        "00000000-0000-4000-8000-000000000000",
        a.goalId,
        b.goalId,
      ]);

      const board = await service.getGoalBoard(workspaceId);
      const upcomingIds = board.entries
        .filter((e) => e.section === "upcoming")
        .map((e) => e.goal.goalId);
      expect(upcomingIds).toEqual([c.goalId, a.goalId, b.goalId]);
    });

    test("promoteUpcomingGoal swaps active with the chosen upcoming goal", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted).not.toBeNull();
      expect(promoted?.goalId).toBe(queued.goalId);
      expect(promoted?.status).toBe("active");

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);

      // The previously-active goal is demoted to the head of upcoming so
      // the user's roadmap stays intact ("swap on drag-to-activate").
      const upcomingIds = board.entries
        .filter((e) => e.section === "upcoming")
        .map((e) => e.goal.goalId);
      expect(upcomingIds[0]).toBe(active.goalId);
    });

    test("records a timeline row for both the manual and automatic promotion paths", async () => {
      const recorded: Array<{ kind: string; digest: string | undefined }> = [];
      service.setTimelineRecorder({
        record: (_workspaceId, draft) =>
          recorded.push({ kind: draft.kind, digest: draft.data?.digest }),
        closeWorkspace: () => Promise.resolve(),
        reopenWorkspace: () => undefined,
      });

      await setGoalOk(service, { workspaceId, objective: "First objective" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second objective" });
      await service.promoteUpcomingGoal(workspaceId, queued.goalId);

      // Promoting demoted the first objective to the head of upcoming, so completing the second
      // auto-promotes it back and that re-activation must be recorded too.
      await setGoalOk(service, { workspaceId, status: "complete", completionSummary: "done" });

      const goalsSet = recorded.filter((row) => row.kind === "goal.set").map((row) => row.digest);
      expect(goalsSet).toEqual(["First objective", "Second objective", "First objective"]);
    });

    test("promoteUpcomingGoal starts the promoted goal and clears stale stop gates", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Stopped active" });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Promote after stop",
      });
      // The user stopped the previous active turn, then explicitly promoted a
      // queued goal. That old stop/ack gate must not suppress the promoted
      // goal's kickoff and force a pause/unpause workaround.
      await service.recordUserStoppedStream(workspaceId, Date.now());

      const dispatcher = new IdleDispatcher();
      const executed: string[] = [];
      service.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: () => ({ isRuntimeCompatible: true }),
        executeGoalContinuation: (input) => {
          executed.push(input.message);
          return Promise.resolve(true);
        },
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);
      await waitForCondition(() => executed.length >= 1, { timeoutMs: 1_000 });
      expect(executed[0]).toContain("Promote after stop");

      const rePromoted = await service.promoteUpcomingGoal(workspaceId, active.goalId);
      expect(rePromoted?.goalId).toBe(active.goalId);
      await waitForCondition(() => executed.length >= 2, { timeoutMs: 1_000 });
      expect(executed[1]).toContain("Stopped active");
      expect(await service.getGoal(workspaceId)).toMatchObject({
        goalId: active.goalId,
        requireUserAcknowledgmentSinceMs: null,
      });
    });

    test("promoteUpcomingGoal archives a completed active goal instead of demoting to upcoming", async () => {
      // Complete the active goal but leave it sitting in goal.json
      // (single-goal UX path — no auto-promote because upcoming is
      // empty at completion time). Then queue an upcoming goal and
      // promote it: the previously-active complete goal must NOT
      // re-enter the queue.
      await setGoalOk(service, { workspaceId, objective: "Finish first" });
      const completed = await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "Marked complete by user.",
      });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Next goal",
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      // The completed goal is in the Completed section, not Upcoming.
      const upcoming = board.entries.filter((e) => e.section === "upcoming");
      expect(upcoming.find((e) => e.goal.goalId === completed.goalId)).toBeUndefined();
      const complete = board.entries.filter((e) => e.section === "complete");
      expect(complete.find((e) => e.goal.goalId === completed.goalId)).toBeDefined();
    });

    test("promoteUpcomingGoal interrupts the active stream and proceeds with the promotion", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      // Mark the workspace as streaming. The wired interrupter flips
      // the flag back to false as part of its work — mirrors what
      // `WorkspaceService.interruptStream` does in production.
      await extensionMetadata.setStreaming(workspaceId, true);

      let interruptCalls = 0;
      service.setStreamInterrupter(async (id) => {
        interruptCalls += 1;
        expect(id).toBe(workspaceId);
        await extensionMetadata.setStreaming(id, false);
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(interruptCalls).toBe(1);
      expect(promoted?.goalId).toBe(queued.goalId);

      // Idempotent: with no live stream, the second call must succeed
      // without invoking the interrupter (promotion already happened
      // above, so a second call on the same id returns null — but the
      // important check is that the guard does not block).
      const repeat = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(repeat).toBeNull();
      expect(interruptCalls).toBe(1);
    });

    test("promoteUpcomingGoal proceeds even when no interrupter is wired", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      // No `setStreamInterrupter` call. We mimic the brief stream
      // tail-end where streaming flips to false while waitForStream
      // Settled is polling — set false up front so the bounded poll
      // returns immediately and promotion proceeds.
      await extensionMetadata.setStreaming(workspaceId, false);

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);
    });

    test("updateUpcomingGoal patches an upcoming goal in place", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Original objective",
        budgetCents: 500,
      });

      const patched = await service.updateUpcomingGoal({
        workspaceId,
        goalId: queued.goalId,
        objective: "Updated objective",
        budgetCents: 1000,
      });
      expect(patched?.objective).toBe("Updated objective");
      expect(patched?.budgetCents).toBe(1000);

      // Reload from disk to confirm the write landed.
      const board = await service.getGoalBoard(workspaceId);
      const upcoming = board.entries.find((e) => e.goal.goalId === queued.goalId);
      expect(upcoming?.goal.objective).toBe("Updated objective");
      expect(upcoming?.goal.budgetCents).toBe(1000);
    });

    test("updateUpcomingGoal returns null for unknown ids", async () => {
      const result = await service.updateUpcomingGoal({
        workspaceId,
        goalId: "00000000-0000-4000-8000-000000000000",
        objective: "noop",
      });
      expect(result).toBeNull();
    });

    test("updateUpcomingGoal rejects an empty objective", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Original" });
      let caught: unknown = null;
      try {
        await service.updateUpcomingGoal({
          workspaceId,
          goalId: queued.goalId,
          objective: "   ",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("objective");
    });

    test("updateUpcomingGoal can clear the budget by passing null", async () => {
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Has budget",
        budgetCents: 500,
      });
      const patched = await service.updateUpcomingGoal({
        workspaceId,
        goalId: queued.goalId,
        budgetCents: null,
      });
      expect(patched?.budgetCents).toBeNull();
    });
  });
});
