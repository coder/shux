import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import type { ToolExecutionOptions } from "ai";

import type { Config } from "@/node/config";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import { createCompleteGoalTool } from "./complete_goal";
import { createGetGoalTool } from "./get_goal";
import { createSetGoalTool } from "./set_goal";

// Goal tools do not touch runtime; ToolFactory config still requires one.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const inertRuntime = {} as never;

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "goal-tool-call",
  messages: [],
  context: undefined,
};

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

function analyticsMock() {
  return { recordGoalLifecycleEvent: mock(() => undefined) };
}

async function expectToolError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected tool execution to fail");
}

describe("goal tools", () => {
  let config: Config;
  let cleanup: () => Promise<void>;
  let goalService: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-tool-workspace";

  beforeEach(async () => {
    const testServices = await createTestHistoryService();
    ({ config, cleanup } = testServices);
    await config.addWorkspace("/tmp/mux-goal-tool-test-project", {
      id: workspaceId,
      name: "goal-tool-workspace",
      projectName: "mux-goal-tool-test-project",
      projectPath: "/tmp/mux-goal-tool-test-project",
      runtimeConfig: { type: "local" },
    });
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    goalService = new WorkspaceGoalService(
      config,
      testServices.historyService,
      extensionMetadata,
      analytics
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  test("get_goal returns the current goal", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Read the goal" });
    const tool = createGetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ goal: created });
  });

  test("set_goal creates an active goal using effective defaults", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 5,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Implement the goal tool" }, mockToolCallOptions)
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({
      goal: {
        objective: "Implement the goal tool",
        status: "active",
        budgetCents: 300,
        turnCap: 5,
      },
    });
    expect(goal).toMatchObject({
      objective: "Implement the goal tool",
      status: "active",
      budgetCents: 300,
      turnCap: 5,
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_created",
      expect.objectContaining({ hasBudget: true, hasTurnCap: true })
    );
  });

  test("set_goal treats null budget and turn cap as defaults", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 450,
        defaultTurnCap: 3,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { objective: "Use defaults", budgetCents: null, turnCap: null },
        mockToolCallOptions
      )
    );

    expect(result).toMatchObject({ goal: { budgetCents: 450, turnCap: 3 } });
  });

  test("set_goal uses positive default budget even when omitted user budgets are allowed", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 650,
        defaultTurnCap: null,
        alwaysRequireExplicitBudget: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Use global budget default" }, mockToolCallOptions)
    );

    expect(result).toMatchObject({ goal: { budgetCents: 650, turnCap: null } });
  });

  test("set_goal accepts explicit positive budget and turn cap", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 5,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { objective: "Use explicit limits", budgetCents: 125, turnCap: 2 },
        mockToolCallOptions
      )
    );

    expect(result).toMatchObject({ goal: { budgetCents: 125, turnCap: 2 } });
  });

  test("set_goal rejects model-created goals that resolve without budget or turn cap", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 0,
        defaultTurnCap: null,
        alwaysRequireExplicitBudget: false,
      },
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Unbounded" }, mockToolCallOptions))
    );

    expect(error.message).toContain("requires a budget or turn cap");
  });

  test("set_goal blocks replacing an active goal without explicit replacement intent", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Replacement" }, mockToolCallOptions))
    );

    expect(error.message).toContain("would replace the current active goal");
  });

  test("set_goal blocks replacing an active goal without matching expectedGoalId", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const error = await expectToolError(() =>
      Promise.resolve(
        tool.execute!(
          {
            objective: "Replacement",
            replaceExistingGoal: true,
            expectedGoalId: "00000000-0000-4000-8000-000000000000",
          },
          mockToolCallOptions
        )
      )
    );

    expect(error.message).toContain(existing.goalId);
  });

  test("set_goal blocks replacing an active goal without expectedGoalId", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const error = await expectToolError(() =>
      Promise.resolve(
        tool.execute!({ objective: "Replacement", replaceExistingGoal: true }, mockToolCallOptions)
      )
    );

    expect(error.message).toContain("replacement requires expectedGoalId");
  });

  test("set_goal checks replacement intent against the lock-bound current goal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    interface GetGoalOverride {
      getGoal: WorkspaceGoalService["getGoal"];
    }
    const serviceAccess = goalService as GetGoalOverride;
    const originalGetGoal = serviceAccess.getGoal;
    const staleGetGoal = mock(() => Promise.resolve(null));
    serviceAccess.getGoal = staleGetGoal;
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    try {
      const error = await expectToolError(() =>
        Promise.resolve(tool.execute!({ objective: "Replacement" }, mockToolCallOptions))
      );
      expect(error.message).toContain("would replace the current active goal");
    } finally {
      serviceAccess.getGoal = originalGetGoal;
    }

    expect(staleGetGoal).not.toHaveBeenCalled();
    expect((await goalService.getGoal(workspaceId))?.goalId).toBe(existing.goalId);
  });

  test("set_goal replaces an active goal with matching expectedGoalId", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          objective: "Replacement",
          replaceExistingGoal: true,
          expectedGoalId: existing.goalId,
        },
        mockToolCallOptions
      )
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Replacement", status: "active" } });
    expect(goal?.goalId).not.toBe(existing.goalId);
    expect(goal?.objective).toBe("Replacement");
  });

  test("set_goal replaces an active goal when the replacement objective is unchanged", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Repeatable" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          objective: "Repeatable",
          replaceExistingGoal: true,
          expectedGoalId: existing.goalId,
          turnCap: 4,
        },
        mockToolCallOptions
      )
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Repeatable", turnCap: 4 } });
    expect((result as { goal: GoalRecordV1 }).goal.goalId).not.toBe(existing.goalId);
    expect(goal?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
  });

  test("set_goal starts a same-objective follow-on after a completed goal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Repeatable" });
    await setGoalOk(goalService, {
      workspaceId,
      status: "complete",
      completionSummary: "First pass complete.",
      expectedGoalId: existing.goalId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Repeatable", turnCap: 4 }, mockToolCallOptions)
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Repeatable", status: "active" } });
    expect((result as { goal: GoalRecordV1 }).goal.goalId).not.toBe(existing.goalId);
    expect(goal?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
  });

  test("set_goal allows a new goal after a completed goal without replaceExistingGoal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    await setGoalOk(goalService, {
      workspaceId,
      status: "complete",
      completionSummary: "Done.",
      expectedGoalId: existing.goalId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Follow-on" }, mockToolCallOptions)
    );

    expect(result).toMatchObject({ goal: { objective: "Follow-on", status: "active" } });
  });

  test("set_goal surfaces child workspace errors clearly", async () => {
    const childWorkspaceId = "goal-tool-child";
    await config.addWorkspace("/tmp/mux-goal-tool-test-project", {
      id: childWorkspaceId,
      name: "goal-tool-child",
      projectName: "mux-goal-tool-test-project",
      projectPath: "/tmp/mux-goal-tool-test-project",
      runtimeConfig: { type: "local" },
      parentWorkspaceId: workspaceId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId: childWorkspaceId,
      goalService,
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Child goal" }, mockToolCallOptions))
    );

    expect(error.message).toContain("child_workspace");
  });

  test("set_goal queues mid-stream goals with a durable returned goalId", async () => {
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 2,
        alwaysRequireExplicitBudget: true,
      },
    });

    let returnedGoalId = "";
    try {
      const result: unknown = await Promise.resolve(
        tool.execute!({ objective: "Queued while streaming" }, mockToolCallOptions)
      );
      expect(result).toMatchObject({ goal: { objective: "Queued while streaming" } });
      returnedGoalId = (result as { goal: GoalRecordV1 }).goal.goalId;
      expect(await goalService.getGoal(workspaceId)).toBeNull();
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }

    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);
    const durable = await goalService.getGoal(workspaceId);
    const completeTool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });
    const completed: unknown = await Promise.resolve(
      completeTool.execute!(
        { summary: "Completed with the set_goal result id.", goalId: returnedGoalId },
        mockToolCallOptions
      )
    );

    expect(drained?.objective).toBe("Queued while streaming");
    expect(drained?.goalId).toBe(returnedGoalId);
    expect(durable?.goalId).toBe(returnedGoalId);
    expect(completed).toMatchObject({ goal: { goalId: returnedGoalId, status: "complete" } });
  });

  test("set_goal returns a durable new id for same-objective mid-stream replacements", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Same objective" });
    await setGoalOk(goalService, { workspaceId, status: "paused" });
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let returnedGoalId = "";
    try {
      const result: unknown = await Promise.resolve(
        tool.execute!(
          {
            objective: "Same objective",
            turnCap: 3,
            replaceExistingGoal: true,
            expectedGoalId: existing.goalId,
          },
          mockToolCallOptions
        )
      );
      returnedGoalId = (result as { goal: GoalRecordV1 }).goal.goalId;
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }

    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);
    const durable = await goalService.getGoal(workspaceId);

    expect(returnedGoalId).not.toBe(existing.goalId);
    expect(drained?.goalId).toBe(returnedGoalId);
    expect(durable).toMatchObject({ goalId: returnedGoalId, turnCap: 3 });
  });

  test("set_goal persists immediately if streaming ends before queueing under the lock", async () => {
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    let streamingChecks = 0;
    serviceAccess.isWorkspaceStreaming = () => {
      streamingChecks += 1;
      return Promise.resolve(streamingChecks < 3);
    };
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 2,
        alwaysRequireExplicitBudget: true,
      },
    });

    let result: unknown;
    try {
      result = await Promise.resolve(
        tool.execute!({ objective: "Persist after stream settles" }, mockToolCallOptions)
      );
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }
    const durable = await goalService.getGoal(workspaceId);
    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);

    expect(streamingChecks).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ goal: { objective: "Persist after stream settles" } });
    expect(durable?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
    expect(drained).toBeNull();
  });

  test("complete_goal completes the goal, persists the summary, and emits model telemetry", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Finish the goal" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ summary: "Implemented and verified." }, mockToolCallOptions)
    );
    const storedRaw = await fs.readFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      "utf-8"
    );
    const storedGoal = JSON.parse(storedRaw) as GoalRecordV1;
    const currentGoal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({
      goal: {
        goalId: created.goalId,
        status: "complete",
        completionSummary: "Implemented and verified.",
      },
    });
    expect(storedGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(currentGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "model", summaryLengthBucket: "10-49" })
    );
  });

  // ---------------------------------------------------------------------------
  // complete_goal error coverage (Coder-agents-review P3 DEREM-26 + DEREM-44).
  //
  // The happy-path test pinned only the success branch. These tests cover the
  // failure modes the model can hit when goal state changes mid-stream:
  //  - Goal cleared (current=null) → typed `invalid_transition` Result error.
  //    The `setGoal` wrapper (DEREM-36) catches the
  //    `WorkspaceGoalTransitionError` thrown by
  //    `validateStatusTransition(null, "complete", ...)` and surfaces it as a
  //    typed Result error.
  //  - Goal paused → typed `invalid_transition` Result error. Same wrapper
  //    path; `validateStatusTransition("paused", "complete", ...)` throws
  //    "Cannot complete a goal that is not active or budget-limited."
  //  - Forwarded `goalId` mismatch → typed `goal_conflict` Result error.
  // ---------------------------------------------------------------------------
  test("complete_goal returns a typed error when no goal exists", async () => {
    // Coder-agents-review P2 DEREM-34: the previous spelling used a
    // synchronous `() => { ... }` callback with `.toThrow()` against an async
    // `execute`, which never observes the rejection because the lambda
    // returns a Promise. Swapped to an explicit `try`/`catch` around the
    // awaited promise so the rejection is actually observed.
    //
    // The `setGoal` wrapper (DEREM-36) catches `WorkspaceGoalTransitionError`
    // from `validateStatusTransition(null, "complete", ...)` and surfaces it
    // as a typed `invalid_transition` Result error instead of letting the
    // throw escape as the misleading "Goal objective is required." plain
    // Error from below. The complete_goal tool wraps the error.type into the
    // thrown message — assert that wrapping.
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!({ summary: "Done without a goal." }, mockToolCallOptions)
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces a typed error when goal is cleared mid-stream (no goalId forwarded)", async () => {
    // DEREM-35: the omitted-goalId path. When the model does not forward
    // `goalId` AND the user clears the goal mid-stream, the
    // setGoalImmediately code path used to read `current = null`, fall past
    // `conflictForExpectedGoalId(null, null)` (returns null), and throw an
    // unhandled `WorkspaceGoalTransitionError`. Now the outer `setGoal`
    // wrapper (DEREM-36) catches it and returns a typed `invalid_transition`
    // Result error.
    await setGoalOk(goalService, { workspaceId, objective: "Will be cleared" });
    await goalService.clearGoal(workspaceId);

    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(tool.execute!({ summary: "Done after clear." }, mockToolCallOptions));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces invalid_transition for a paused goal", async () => {
    // Coder-agents-review P3 DEREM-44: pin the paused-goal failure mode.
    // `validateStatusTransition("paused", "complete", ...)` throws
    // "Cannot complete a goal that is not active or budget-limited."; the
    // setGoal wrapper turns that into a typed `invalid_transition` Result.
    await setGoalOk(goalService, { workspaceId, objective: "Will be paused" });
    await setGoalOk(goalService, { workspaceId, status: "paused" });

    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(tool.execute!({ summary: "Done from paused." }, mockToolCallOptions));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces goal_conflict when expected goalId is stale", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Compete with a stale goalId" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    // Forwarded `goalId` does not match the actual goal — setGoal returns
    // a typed `goal_conflict` error; the tool surfaces this as a thrown
    // Error rather than the misleading "Goal objective is required."
    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { summary: "Done.", goalId: "00000000-0000-4000-8000-000000000000" },
          mockToolCallOptions
        )
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("goal_conflict");
  });
});
