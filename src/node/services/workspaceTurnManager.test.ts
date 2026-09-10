import { StreamManager } from "./streamManager";
import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { execSync } from "node:child_process";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { createWorkspaceTurnManagerHarness } from "@/node/services/workspaceTurnManager.testHarness";
import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { Ok, Err, type Result } from "@/common/types/result";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { SendMessageError } from "@/common/types/errors";
import type { ErrorEvent, StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { QueueCutAttributionSnapshot } from "@/node/services/taskWorkspaceSeam";
import type { InitStateManager } from "@/node/services/initStateManager";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  createWorkspaceTurnMetadata,
  makeWorkspaceTurnCreateMock,
  findWorkspaceInConfig,
  initGitRepo,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnMuxMetadata,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
  writeCustomAgentDefinition,
} from "@/node/services/taskService.testHarness";

/**
 * Git-prove the owner workspace's checked-out branch: owner-side agent prechecks and
 * unreachable-target vouching only apply when the effective base branch is verified
 * against the branch actually checked out in the owner.
 */
function checkoutOwnerBranch(projectPath: string, branch: string): void {
  initGitRepo(projectPath);
  execSync(`git checkout -b ${branch}`, { cwd: projectPath, stdio: "ignore" });
}

/**
 * Commit pending agent-definition files: owner-side vouching additionally requires the
 * agent-definition paths to be clean (uncommitted changes diverge from the committed
 * base a new checkout is created from).
 */
function commitOwnerAgentFiles(projectPath: string): void {
  execSync("git add -A && git commit -q -m agents", { cwd: projectPath, stdio: "ignore" });
}

function makeCreateMockReturning(result: Result<{ metadata: WorkspaceMetadata }>) {
  return mock((): Promise<Result<{ metadata: WorkspaceMetadata }>> => Promise.resolve(result));
}

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("shared desktop execution mirror rejects stale active and terminal callbacks", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: parentId,
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
          taskDesktopOwnerWorkspaceId: parentId,
          taskExecutionId: "new",
          taskExecutionStatus: "running",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const internals = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string; accepted: boolean }
      >;
    };
    internals.activeWorkspaceTurnHandleByWorkspaceId.set("child", {
      handleId: "new",
      ownerWorkspaceId: parentId,
      accepted: true,
    });
    for (const status of ["queued", "starting", "running", "completed", null] as const) {
      await taskService.updateAgentTaskExecutionState("child", "old", status);
      expect(findWorkspaceInConfig(config, "child")?.taskExecutionId).toBe("new");
      expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBe("running");
    }
    await taskService.updateAgentTaskExecutionState("child", "new", "completed");
    await taskService.updateAgentTaskExecutionState("child", "old", "running");
    await taskService.updateAgentTaskExecutionState("child", "new", "running");
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBe("completed");
  });

  test("an active mirror commit rejects a competing controller written while admission was suspended", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        ...["child", "competitor"].map((id) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: parentId,
            agentId: "explore",
            taskStatus: "reported",
            runtimeConfig: { type: "local" },
            taskDesktopOwnerWorkspaceId: parentId,
          })
        )
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    // A reservation registered by createWorkspaceTurn: the acceptance below claims this handle.
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string; accepted: boolean }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("child", {
      handleId: "wst_child",
      ownerWorkspaceId: parentId,
      accepted: false,
    });
    // The gate admitted the child against a config where nothing else was active. Publish an
    // independent (gate-bypassing) competing controller after the mirror edit was scheduled but
    // before its transform runs, as a concurrent process or unrelated writer could.
    const editConfig = config.editConfig.bind(config);
    let intercepted = false;
    const editSpy = spyOn(config, "editConfig").mockImplementation(async (transform) => {
      if (intercepted) return editConfig(transform);
      intercepted = true;
      await editConfig((cfg) => {
        const competitor = findWorkspaceEntry(cfg, "competitor")?.workspace;
        assert(competitor, "competitor fixture must exist");
        competitor.taskStatus = "running";
        return cfg;
      });
      return editConfig(transform);
    });
    try {
      const failure = await taskService
        .updateAgentTaskExecutionState("child", "wst_child", "running")
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
      expect(failure).not.toBeNull();
    } finally {
      editSpy.mockRestore();
    }
    // Nothing from the rejected transaction reached disk; the competitor keeps control.
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionId).toBeUndefined();
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBeUndefined();
    expect(findWorkspaceInConfig(config, "competitor")?.taskStatus).toBe("running");
  });

  test("startup clears an orphan execution mirror that has no handle ID and no handle record", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        // Codex P2: a bound child whose persisted mirror lost its ID (and whose handle record is
        // gone) reads as live desktop control forever — the ID-guarded clear never matches it.
        projectWorkspace(projectPath, "shared-orphan", "shared-orphan", {
          parentWorkspaceId: parentId,
          agentId: "explore",
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
          taskDesktopOwnerWorkspaceId: parentId,
          taskExecutionStatus: "running",
        }),
        // The stable task status is a separate activity source and must survive the repair.
        projectWorkspace(projectPath, "running-orphan", "running-orphan", {
          parentWorkspaceId: parentId,
          agentId: "explore",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskExecutionStatus: "starting",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const desktop = new DesktopInputCoordinator(config);
    const ownerInput = () =>
      desktop
        .withInput(parentId, () => Promise.resolve("clicked"))
        .then(
          (value) => value,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
    expect(await ownerInput()).toContain("active borrower shared-orphan");

    await taskService.reconcileAgentTaskExecutionIds();

    for (const id of ["shared-orphan", "running-orphan"]) {
      expect(findWorkspaceInConfig(config, id)?.taskExecutionStatus).toBeUndefined();
      expect(findWorkspaceInConfig(config, id)?.taskExecutionId).toBeUndefined();
      expect(taskService.getLiveWorkspaceTurnRegistration(id)).toBeUndefined();
    }
    expect(findWorkspaceInConfig(config, "shared-orphan")?.taskStatus).toBe("reported");
    expect(findWorkspaceInConfig(config, "running-orphan")?.taskStatus).toBe("running");
    expect(await ownerInput()).toBe("clicked");
  });

  test("shared desktop active mirror refuses a missing target or competing child", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        ...["missing", "child", "competitor"].map((id) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: parentId,
            agentId: "explore",
            taskStatus: id === "competitor" ? "running" : "reported",
            runtimeConfig: { type: "local" },
            taskDesktopOwnerWorkspaceId: id === "missing" ? "deleted" : parentId,
            taskExecutionId: id,
            taskExecutionStatus: "completed",
          })
        )
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    // Exercise admission itself deterministically; startup normalization may settle dead streams.
    for (const id of ["missing", "child"]) {
      const failure = await taskService.updateAgentTaskExecutionState(id, id, "running").then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(findWorkspaceInConfig(config, id)?.taskExecutionStatus).toBe("completed");
    }
    expect(taskService.getLiveWorkspaceTurnRegistration("child")).toBeUndefined();
  });

  async function startWorkspaceTurnForTest(
    options: {
      stableIds?: string[];
      disposable?: boolean;
      sendMessage?: ReturnType<typeof mock>;
      remove?: ReturnType<typeof mock>;
      isStreaming?: ReturnType<typeof mock>;
      hasQueuedMessages?: ReturnType<typeof mock>;
      hasPendingQueuedOrPreparingTurn?: ReturnType<typeof mock>;
      hasPendingBashMonitorWakeContinuation?: ReturnType<typeof mock>;
      hasPendingWorkspaceTurnContinuation?: ReturnType<typeof mock>;
      getQueueCutCutter?: ReturnType<typeof mock>;
      hasPendingAutoRetry?: ReturnType<typeof mock>;
      waitForPendingStreamErrorRecoveryDecision?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, options.stableIds ?? ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, ...options });
    const aiMocks = createAIServiceMocks(config, {
      ...(options.isStreaming != null ? { isStreaming: options.isStreaming } : {}),
    });
    const { historyService, taskService, taskHost } = createWorkspaceTurnManagerHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new", ...(options.disposable === true ? { disposable: true } : {}) },
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error(created.error);
    }

    return {
      config,
      parentId,
      projectPath,
      taskService,
      taskHost,
      workspaceMocks,
      aiMocks,
      historyService,
      created: created.data,
    };
  }

  async function finalizeWorkspaceTurnStreamEndForTest(
    taskService: WorkspaceTurnManager,
    event: StreamEndEvent
  ): Promise<boolean> {
    const internal = taskService as unknown as {
      captureQueueCutAttributionSnapshot: (workspaceId: string) => QueueCutAttributionSnapshot;
      finalizeWorkspaceTurnFromStreamEnd: (
        event: StreamEndEvent,
        queueCutSnapshot: QueueCutAttributionSnapshot
      ) => Promise<boolean>;
    };
    return await internal.finalizeWorkspaceTurnFromStreamEnd(
      event,
      internal.captureQueueCutAttributionSnapshot(event.workspaceId)
    );
  }

  async function appendUncorrelatedWakeHistory(params: {
    historyService: HistoryService;
    parentId: string;
    taskId: string;
    workspaceId: string;
    inputSynthetic: boolean;
  }): Promise<StreamEndEvent> {
    const prompt = createMuxMessage("turn-prompt", "user", "Summarize the repo", {
      muxMetadata: workspaceTurnMuxMetadata(params.parentId, params.taskId),
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, prompt)).success).toBe(
      true
    );
    const input = createMuxMessage("wake-input", "user", "Continue after a wake", {
      synthetic: params.inputSynthetic,
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, input)).success).toBe(
      true
    );
    const output = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, output)).success).toBe(
      true
    );
    return {
      type: "stream-end",
      workspaceId: params.workspaceId,
      messageId: output.id,
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Wake result" }],
    };
  }

  async function createWorkspaceLifecycleHarness(
    options: {
      archived?: boolean;
      archive?: ReturnType<typeof mock>;
      unarchive?: ReturnType<typeof mock>;
      preflightArchive?: ReturnType<typeof mock>;
      listLiveWorkspaceActivity?: ReturnType<typeof mock>;
      getStoppablePreparingWorkspaceTurn?: ReturnType<typeof mock>;
      acquirePreInterruptionArchiveHold?: ReturnType<typeof mock>;
      waitForIdle?: ReturnType<typeof mock>;
      hasRunningBackgroundBashProcesses?: ReturnType<typeof mock>;
      isSnapshotArchiveEligibilityMutationSensitive?: ReturnType<typeof mock>;
      hasUntrackableExternalAppOpen?: ReturnType<typeof mock>;
      create?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "child"),
        id: "childworkspace",
        name: "child",
        title: "Child workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        ...(options.archived ? { archivedAt: new Date().toISOString() } : {}),
      });
      project.workspaces.push({
        path: path.join(projectPath, "unowned"),
        id: "unownedworkspace",
        name: "unowned",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const workspaceMocks = createWorkspaceServiceMocks(options);
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_created", "completed", {
        turnId: "turn-created",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        title: "Created child",
      })
    );
    return {
      config,
      parentId,
      projectPath,
      taskService,
      taskHost,
      taskHandleStore,
      ...workspaceMocks,
    };
  }

  function markWorkspaceTurnActive(
    taskService: WorkspaceTurnManager,
    workspaceId: string,
    handleId: string,
    ownerWorkspaceId: string
  ): void {
    // normalizeWorkspaceTurnRecord self-heals "running" records that have no live
    // in-process execution, so active-turn tests must register the handle as live.
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceId, { handleId, ownerWorkspaceId });
  }

  test("workspace lifecycle archives only parent-owned created workspace turns", async () => {
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness();

    const archived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const unowned = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "unownedworkspace" },
      {}
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "archive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle treats existing follow-up handles as owned when the workspace was created by the parent", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_existing", "completed", {
        turnId: "turn-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Existing child",
      })
    );

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_existing" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        taskId: "wst_existing",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes concurrent handles that resolve to the same workspace", async () => {
    let archiveCallCount = 0;
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      archiveCallCount += 1;
      await Promise.resolve();
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_existing", "completed", {
        turnId: "turn-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Existing child",
      })
    );

    const results = await Promise.all([
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_created" },
        {}
      ),
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_existing" },
        {}
      ),
    ]);

    expect(results.map((result) => (result.success ? result.data.status : "error")).sort()).toEqual(
      ["already_archived", "archived"]
    );
    expect(archiveCallCount).toBe(1);
  });

  test("workspace lifecycle rejects existing follow-up handles for workspaces this parent did not create", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "unownedworkspace", "wst_foreignexisting", "completed", {
        turnId: "turn-foreign-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Unowned existing child",
      })
    );

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_foreignexisting" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "invalid_scope",
        action: "archive",
        taskId: "wst_foreignexisting",
        workspaceId: "unownedworkspace",
      })
    );
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle returns archive confirmation and treats already archived as idempotent", async () => {
    const confirmationArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const { config, parentId, projectPath, taskService, taskHandleStore } =
      await createWorkspaceLifecycleHarness({ archive: confirmationArchive });

    const confirmation = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(confirmation).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const confirmationByTaskId = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_created" },
      { acknowledgedUntrackedPathsByWorkspaceId: { childworkspace: ["task-scratch.txt"] } }
    );

    expect(confirmationByTaskId).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["task-scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.archivedAt = new Date().toISOString();
      return cfg;
    });
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );

    const alreadyArchived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(alreadyArchived).toEqual(
      Ok({
        status: "already_archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(confirmationArchive).toHaveBeenCalledTimes(2);
  });

  test("workspace lifecycle requires explicit interruption for active workspace turns before archive", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const active = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    const interrupted = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(interrupted).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("interrupted");
  });

  test("workspace lifecycle unarchives archived owned workspaces and treats unarchived as idempotent", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const unarchive = mock(async (): Promise<Result<void>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before unarchive runs");
      assert(projectPath, "harness project path must be assigned before unarchive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.unarchivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archived: true, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const unarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { taskId: "wst_created" }
    );

    expect(unarchived).toEqual(
      Ok({
        status: "unarchived",
        action: "unarchive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledWith("childworkspace");

    const alreadyUnarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" }
    );

    expect(alreadyUnarchived).toEqual(
      Ok({
        status: "already_unarchived",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledTimes(1);

    const unowned = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "unownedworkspace" }
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "unarchive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle unarchive reports active turns without interrupting", async () => {
    const { parentId, taskService, taskHandleStore, unarchive } =
      await createWorkspaceLifecycleHarness({ archived: true });
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const result = await taskService.unarchiveOwnedWorkspaceTurnWorkspace(parentId, {
      workspaceId: "childworkspace",
    });

    expect(result).toEqual(
      Ok({
        status: "active",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(unarchive).not.toHaveBeenCalled();
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("running");
  });

  test("workspace lifecycle archive blocks existing-mode follow-ups until unarchive restores them", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const editChildWorkspace = async (
      edit: (child: WorkspaceConfigEntry) => void
    ): Promise<void> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned");
      assert(projectPath, "harness project path must be assigned");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        edit(child);
        return cfg;
      });
    };
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await editChildWorkspace((child) => {
        child.archivedAt = new Date().toISOString();
      });
      return Ok({ kind: "archived" });
    });
    const unarchive = mock(async (): Promise<Result<void>> => {
      await editChildWorkspace((child) => {
        child.unarchivedAt = new Date().toISOString();
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archived = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    expect(archived.success && archived.data.status === "archived").toBe(true);

    const refused = await harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(refused).toEqual(Err("Task.createWorkspaceTurn: existing workspace is archived"));

    const unarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" }
    );
    expect(unarchived.success && unarchived.data.status === "unarchived").toBe(true);

    const followUp = await harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
  });

  test("workspace lifecycle serializes archive with follow-up handle persistence", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    // Wait until the archive operation holds the lifecycle lock (it is inside
    // workspaceService.archive, gated on archiveGate).
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Launch a follow-up while the archive is mid-flight: it must serialize on the shared
    // lifecycle lock and be refused after the archive lands, instead of persisting a handle
    // the already-committed archive would silently truncate.
    const followUpPromise = harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, followUp] = await Promise.all([archivePromise, followUpPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(followUp.success).toBe(false);
    expect(followUp.success ? "" : followUp.error).toMatch(/archived/);
    const activeHandles = await harness.taskService.listWorkspaceTurnTasks(harness.parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(activeHandles).toEqual([]);
  });

  test("workspace lifecycle archive blocks on active turns owned by the target", async () => {
    const { config, parentId, projectPath, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "grandchild"),
        id: "grandchildworkspace",
        name: "grandchild",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    // Nested delegation: the peer (childworkspace) owns an active turn targeting a grandchild.
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord("childworkspace", "grandchildworkspace", "wst_nested", "running", {
        turnId: "turn-nested",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        title: "Nested turn",
      })
    );
    markWorkspaceTurnActive(taskService, "grandchildworkspace", "wst_nested", "childworkspace");

    const active = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_nested"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    // interrupt_active does not cascade into turns running in OTHER workspaces: the nested
    // workspace never gets the activity checks and admission holds the target does, so
    // interruption (and any disposable cleanup) there could destroy user work unseen.
    const refusedNested = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(refusedNested.success).toBe(true);
    if (refusedNested.success) {
      expect(refusedNested.data.status).toBe("active");
      expect(refusedNested.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(archive).not.toHaveBeenCalled();
    const nested = await taskHandleStore.getWorkspaceTurn("childworkspace", "wst_nested");
    expect(nested?.status).toBe("running");
  });

  test("workspace lifecycle preflights lossy confirmation before interrupting active turns", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // Unacknowledged lossy confirmation must surface BEFORE any interruption so a refused
    // confirmation leaves the in-flight work running.
    const confirmation = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(confirmation).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");

    // With acknowledged paths the preflight is skipped (archive re-validates at capture time)
    // and interruption proceeds.
    const archived = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    // Preflight runs before interruption on BOTH calls; the acknowledged set covering the
    // reported paths is what lets the second call proceed.
    expect(preflightArchive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledWith("childworkspace", ["scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when worktree archive behavior deletes checkouts", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // The refusal is scoped to targets the worktree archive hook would actually delete, so
      // this test's child must be a managed worktree runtime.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = { type: "local", srcBaseDir: "/tmp/src" };
        }
      }
      return cfg;
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Delete checkout");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses snapshot archive after a native terminal was opened", async () => {
    // Native emulator lifetime is untrackable, so a snapshot archive (which removes the
    // checkout) must fail closed instead of deleting the directory under the user's shell.
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive: mock(() => true),
      hasUntrackableExternalAppOpen: mock(() => true),
    });

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("native terminal");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle archives non-worktree targets despite the delete worktree policy", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // SSH runtime: the worktree archive hook skips non-worktree runtimes, so the unrelated
      // global delete policy must not make reversible archive unavailable for this peer.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "peer.example",
            srcBaseDir: "/home/user/src",
          };
        }
      }
      return cfg;
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "delete",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes nested turn creation with archiving its owner", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const create = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before create runs");
      assert(projectPath, "harness project path must be assigned before create runs");
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "grandchild"),
          id: "grandchildworkspace",
          name: "grandchild",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          id: "grandchildworkspace",
          name: "grandchild",
          projectName: "repo",
          projectPath,
          runtimeConfig: { type: "local" },
          createdAt: new Date().toISOString(),
        },
      });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, create });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The peer starts a nested workspace turn while its own archive is mid-flight. The
    // persist section locks on the OWNER too, so it must serialize behind the archive and be
    // refused instead of leaving an active nested handle owned by an archived workspace.
    const nestedPromise = harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: "childworkspace",
      prompt: "Nested work",
      title: "Nested work",
      workspace: { mode: "new" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, nested] = await Promise.all([archivePromise, nestedPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(nested.success).toBe(false);
    expect(nested.success ? "" : nested.error).toMatch(/owner workspace was archived/);
    // The refused nested creation had already materialized its workspace; without an ownership
    // handle the archived owner could never manage it, so it must be removed, not leaked.
    expect(harness.remove).toHaveBeenCalledWith("grandchildworkspace", true);
    const nestedHandles = await harness.taskService.listWorkspaceTurnTasks("childworkspace", {
      statuses: ["queued", "starting", "running"],
    });
    expect(nestedHandles).toEqual([]);
  });

  test("workspace lifecycle refuses archive while the target has live non-turn activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: true,
      terminalSessions: true,
      desktopViewers: false,
    }));
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness({
      listLiveWorkspaceActivity,
    });

    // No delegated turns explain the stream, and terminals are never turn-driven; even
    // interrupt_active must not let the tool kill user activity.
    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.note : "").toContain("an active stream");
    expect(data?.status === "active" ? data.note : "").toContain("open terminal sessions");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle re-confirms when acknowledged paths no longer cover the preflight", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(
          Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt", "new-file.txt"] })
        )
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // The acknowledged set predates a new untracked file: surface a fresh confirmation
    // BEFORE interrupting instead of destroying the turn and then failing the archive.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(result).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt", "new-file.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle re-confirms when acknowledged paths include entries the preflight no longer reports", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // The acknowledged set is a stale SUPERSET (one acknowledged file was removed). The archive
    // sink requires exact list equality, so a subset check here would interrupt the turn and
    // then still bounce with requires_confirmation — the acknowledgement must be re-confirmed
    // BEFORE anything is interrupted.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt", "stale.txt"] }
    );

    expect(result).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle refuses interrupt_active when snapshot eligibility is mutation-sensitive", async () => {
    const isSnapshotArchiveEligibilityMutationSensitive = mock(() => true);
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive,
    });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // Snapshot archives require an exact untracked-file acknowledgement that running turns can
    // invalidate mid-interruption, so honoring interrupt_active could destroy in-flight work and
    // still bounce with requires_confirmation. Refuse instead and leave the turn running.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toEqual(["wst_running"]);
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "interrupt_active was not honored"
    );
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle archive interruption never removes a disposable target workspace", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_disposable", "running", {
        turnId: "turn-disposable",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        disposableWorkspace: true,
      })
    );
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_disposable",
      harness.parentId
    );

    // Interrupting a disposable workspace-turn normally auto-removes its workspace; when the
    // interruption serves an archive (retain), that cleanup would delete the checkout out from
    // under the subsequent archive call, which would then fail with "Workspace not found".
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(harness.remove).not.toHaveBeenCalled();
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_disposable"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when the workflow activity scan fails", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    // A corrupt run record makes the strict activity scan throw: the absence of active
    // workflow runs is no longer provable, so archive must refuse instead of proceeding
    // while a crash-recovered run might still resume into the archived workspace.
    await fsPromises.mkdir(
      path.join(
        path.join(harness.config.sessionsDir, "childworkspace"),
        "workflows",
        "wfr_corrupt"
      ),
      { recursive: true }
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Could not verify");
    expect(harness.archive).not.toHaveBeenCalled();
    // The sink-side recheck fails closed on the same unreadable store.
    let scanError: unknown;
    try {
      await harness.taskHost.listActiveWorkflowRunIdsForWorkspaceStrict("childworkspace");
    } catch (error: unknown) {
      scanError = error;
    }
    expect(scanError).toBeInstanceOf(Error);
  });

  test("workspace lifecycle refuses archive while the target owns an active workflow run", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(harness.config.sessionsDir, "childworkspace"),
    });
    await runStore.createRun({
      id: "wfr_child_active",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-active",
        description: "Active child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: new Date().toISOString(),
    });

    // Workflows idle between steps own no descendant agent or turn at that instant, but
    // archiving would break the next step; interrupt_active must not apply to workflow runs.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toContain("wfr_child_active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("workflow runs");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle treats queued user messages as live activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: false,
      queuedMessages: true,
      terminalSessions: false,
      desktopViewers: false,
    }));
    const harness = await createWorkspaceLifecycleHarness({ listLiveWorkspaceActivity });

    // No delegated queued turn explains the queue entry, so it is user work: a queued message
    // would dispatch through AgentSession's internal send path after archive and stream hidden.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("queued messages");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle interrupts a delegated turn whose send is still PREPARING", async () => {
    // A fresh delegated turn's handle already reads "running" while the target session is
    // PREPARING, which listLiveWorkspaceActivity reports as queued messages. The exemption
    // must bind to the exact correlation of the collected turn, not to PREPARING alone.
    const preparingTurn = {
      taskHandleId: "wst_running",
      ownerWorkspaceId: "",
      turnId: "turn-running",
    };
    const getStoppablePreparingWorkspaceTurn = mock(() => preparingTurn);
    const acquirePreInterruptionArchiveHold = mock(() => Ok({ [Symbol.dispose]: () => undefined }));
    const harness = await createWorkspaceLifecycleHarness({
      listLiveWorkspaceActivity: mock(() => ({
        streaming: false,
        queuedMessages: true,
        backgroundBashProcesses: false,
        terminalSessions: false,
        desktopSession: false,
      })),
      getStoppablePreparingWorkspaceTurn,
      acquirePreInterruptionArchiveHold,
    });
    preparingTurn.ownerWorkspaceId = harness.parentId;
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // A PREPARING send correlated to some other turn (the collected turn ended and a
    // different delegated turn, or none, took the session) is not explained by the
    // collected handle: still user-shaped work, still refused.
    getStoppablePreparingWorkspaceTurn.mockReturnValueOnce({
      ...preparingTurn,
      turnId: "turn-other",
    });
    const mismatched = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );
    expect(mismatched.success).toBe(true);
    const mismatchedData = mismatched.success ? mismatched.data : undefined;
    expect(mismatchedData?.status).toBe("active");
    expect(mismatchedData?.status === "active" ? (mismatchedData.note ?? "") : "").toContain(
      "queued messages"
    );
    expect(harness.archive).not.toHaveBeenCalled();

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    // The hold binds the interruptible turn by correlation so a stream that starts for it
    // between the gate and interruption is still recognized as the delegated turn.
    expect(acquirePreInterruptionArchiveHold).toHaveBeenLastCalledWith("childworkspace", {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [preparingTurn],
    });
    expect(harness.archive).toHaveBeenCalledTimes(1);
    const record = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_running");
    expect(record?.status).toBe("interrupted");
  });

  test("workspace lifecycle waits for interrupted turns to settle before the archive sink", async () => {
    // stopStream resolves before the target session leaves PREPARING/COMPLETING; entering
    // the sink on that residue would refuse with the turns already destroyed.
    const settled = Promise.withResolvers<void>();
    const waitForIdle = mock(() => settled.promise);
    const harness = await createWorkspaceLifecycleHarness({ waitForIdle });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );
    await waitForCondition(() => waitForIdle.mock.calls.length === 1);
    expect(waitForIdle).toHaveBeenCalledWith("childworkspace");
    const record = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_running");
    expect(record?.status).toBe("interrupted");
    expect(harness.archive).not.toHaveBeenCalled();

    settled.resolve();
    const result = await archivePromise;
    expect(result.success ? result.data.status : result.error).toBe("archived");
    expect(harness.archive).toHaveBeenCalledTimes(1);
  });

  test("workspace lifecycle refuses archive of a dedicated Coder workspace under the delete policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "delete";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    // The before-archive hook would permanently delete the dedicated remote Coder workspace
    // and unarchive cannot recreate it — the reversible model-facing verb must fail closed.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "Coder workspace archive behavior"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses stopping a dedicated Coder workspace under an untrackable app", async () => {
    // Snapshot capture never runs for SSH runtimes, but a "stop" Coder policy still pulls the
    // remote environment out from under a native terminal/editor the user may be connected
    // through — the untrackable-app refusal must cover that hazard too.
    const harness = await createWorkspaceLifecycleHarness({
      hasUntrackableExternalAppOpen: mock(() => true),
    });
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "stop";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "stop the dedicated remote Coder workspace"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for nested disposable turn workspaces", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      for (const [, project] of cfg.projects) {
        if (project.workspaces.some((w) => w.id === "childworkspace")) {
          project.workspaces.push({
            path: `${project.workspaces[0].path}-grandchild`,
            id: "grandchildworkspace",
            name: "grandchild",
            title: "Grandchild workspace",
            createdAt: new Date().toISOString(),
            runtimeConfig: { type: "local" },
          });
        }
      }
      return cfg;
    });
    // Nested turn OWNED BY the archive target, running in its own disposable workspace:
    // interrupting it would trigger that workspace's disposable force-removal without any of
    // the activity checks or admission holds the target gets — user terminals/editors/queued
    // work there would be destroyed unseen. interrupt_active must refuse instead of
    // cascading; the caller stops the turn explicitly (task_stop), which runs the same
    // user-visible cleanup as normal settlement.
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord("childworkspace", "grandchildworkspace", "wst_nested", "running", {
        turnId: "turn-nested",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        disposableWorkspace: true,
      })
    );
    markWorkspaceTurnActive(
      harness.taskService,
      "grandchildworkspace",
      "wst_nested",
      "childworkspace"
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
      expect(result.data.activeTaskIds).toEqual(["wst_nested"]);
      expect(result.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(harness.archive).not.toHaveBeenCalled();
    // Nothing was interrupted or removed: the nested turn and its workspace are untouched.
    expect(harness.remove).not.toHaveBeenCalled();
    const nestedRecord = await harness.taskHandleStore.getWorkspaceTurn(
      "childworkspace",
      "wst_nested"
    );
    expect(nestedRecord?.status).toBe("running");
  });

  test("workspace lifecycle refuses archive while background bash processes are running", async () => {
    const hasRunningBackgroundBashProcesses = mock((): Promise<boolean> => Promise.resolve(true));
    const harness = await createWorkspaceLifecycleHarness({ hasRunningBackgroundBashProcesses });

    // Detached background bash outlives its spawning turn: interruption cannot stop it, and a
    // snapshot archive could remove the worktree under a process still writing.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "running background bash processes"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for a dedicated Coder workspace under the stop policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      // Default Coder policy is "stop": the sink's before-archive hook stops the remote
      // workspace and can fail AFTER interruption destroyed the turns.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("fallible remote stop");
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle interruption tolerates turns that settled after collection", async () => {
    // The preflight runs between collection and interruption; settle one of the two active
    // turns there to prove a now-terminal handle is skipped instead of aborting the archive.
    const harnessRefs: {
      taskHandleStore?: TaskHandleStore;
      taskService?: WorkspaceTurnManager;
      parentId?: string;
    } = {};
    const preflightArchive = mock(async (): Promise<Result<{ kind: "ready" }>> => {
      const { taskHandleStore, taskService, parentId } = harnessRefs;
      assert(taskHandleStore && taskService && parentId, "harness refs must be assigned");
      const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_settling");
      assert(settled, "settling turn must exist");
      await taskHandleStore.upsertWorkspaceTurn({
        ...settled,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
      (
        taskService as unknown as {
          activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown>;
        }
      ).activeWorkspaceTurnHandleByWorkspaceId.delete("childworkspace");
      return Ok({ kind: "ready" });
    });
    const harness = await createWorkspaceLifecycleHarness({ preflightArchive });
    harnessRefs.taskHandleStore = harness.taskHandleStore;
    harnessRefs.taskService = harness.taskService;
    harnessRefs.parentId = harness.parentId;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    };
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_settling",
      turnId: "turn-settling",
      status: "running",
    });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_queued",
      turnId: "turn-queued",
      status: "queued",
    });
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_settling",
      harness.parentId
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    const settled = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_settling"
    );
    expect(settled?.status).toBe("completed");
    const queued = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_queued");
    expect(queued?.status).toBe("interrupted");
  });

  test("createWorkspaceTurn creates a normal workspace and starts a correlated turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      taskId: "wst_childworkspace",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
    expect(childConfig?.tags).toMatchObject({
      "mux.taskHandleId": "wst_childworkspace",
      "mux.taskOwnerWorkspaceId": parentId,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    expect(sendMessageCall[1]).toBe("Summarize the repo");
    expect(sendMessageCall[2]).toMatchObject({ agentId: "exec" });
    expect(sendMessageCall[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: true,
      agentInitiated: true,
    });
  });

  test("createWorkspaceTurn launches a new workspace with an explicit agent id", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan a small change",
      title: "Plan dogfood",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    // Explicit overrides also arm stream-time strict resolution, pinning the validated
    // definition's provenance (scope + exact source): pre-dispatch validation races
    // init hooks/user edits, so the stream must fail loudly instead of silently
    // swapping in exec (or running a different definition for the same id) post-init.
    expect(sendMessageCall[2]).toMatchObject({
      agentId: "plan",
      strictAgentResolution: {
        expectedScope: "built-in",
        expectedSource: "built-in",
        // The full base chain is pinned too: stream-time inheritance resolution
        // reloads every base independently.
        expectedChain: [{ id: "plan", scope: "built-in", source: "built-in" }],
      },
    });
  });

  test("createWorkspaceTurn keeps prechecks advisory when the owner has uncommitted agent changes", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // A GITIGNORED hidden shadow of the built-in plan exists only in the owner's
    // working tree (plain `git status` would not even list it): the new checkout is
    // created from committed branch state and validly resolves the built-in, so the
    // owner-side miss must stay advisory (branch equality is not checkout equality).
    await fsPromises.writeFile(path.join(projectPath, ".gitignore"), ".mux/agents/\n");
    commitOwnerAgentFiles(projectPath);
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      ["---", "name: Plan", "base: plan", "ui:", "  hidden: true", "---", "Shadow."].join("\n")
    );

    const cleanCheckout = path.join(rootDir, "clean-target-checkout");
    await fsPromises.mkdir(cleanCheckout, { recursive: true });
    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: cleanCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the committed base",
      title: "Dirty owner shadow",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn owner-side misses are always advisory (target decides)", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // No owner-side equivalence proof is sound (fetched origin commits, existing
    // branchName targets, submodules, init hooks): the created checkout is the only
    // authoritative source, so a miss defers instead of rejecting pre-create.
    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "doesnotexist",
      prompt: "Should defer to the target",
      title: "Advisory miss",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unknown agentId");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects bad agent ids without ever dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const attempt = (agentId: string) =>
      taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: "Should not run",
        title: "Bad agent",
        workspace: { mode: "new" },
      });

    // Syntactically invalid ids are checkout-independent and fail before any
    // workspace exists.
    const invalidSyntax = await attempt("Not A Valid Id!");
    expect(invalidSyntax.success).toBe(false);
    if (!invalidSyntax.success) expect(invalidSyntax.error).toContain("invalid agentId");
    expect(createWorkspace).not.toHaveBeenCalled();

    // Definition-dependent verdicts are decided by the created target checkout
    // (owner-side prechecks are advisory): unknown and internal (ui.hidden) ids
    // fail there, with the workspace retained as owned evidence and no dispatch.
    const unknown = await attempt("doesnotexist");
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error).toContain("unknown agentId");
      expect(unknown.error).toContain("no turn was dispatched");
    }

    const internal = await attempt("compact");
    expect(internal.success).toBe(false);
    if (!internal.success) {
      expect(internal.error).toContain("not selectable");
      expect(internal.error).toContain("no turn was dispatched");
    }

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects disabled agents without dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { custom: { enabled: false } },
    });
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not run",
      title: "Disabled agent",
      workspace: { mode: "new" },
    });

    // Enablement is decided at the created target checkout (owner prechecks are
    // advisory); the disabled verdict settles post-create with no dispatch.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disabled");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn does not dispatch when the agent is unavailable in the created workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Project-local agent exists in the OWNER's checkout, but the created workspace's checkout
    // diverges (no agent definition there) — post-create re-validation must fail instead of
    // silently streaming exec. Worktree runtime: the only local runtime whose created
    // workspaces get a checkout separate from the project root.
    await writeCustomAgentDefinition(projectPath);
    const divergedCheckout = path.join(rootDir, "diverged-checkout");
    await fsPromises.mkdir(divergedCheckout, { recursive: true });

    const divergedMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: divergedCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: divergedMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Diverged agent",
      workspace: { mode: "new" },
      // Background launch: on this synchronous failure the policy must NOT be persisted —
      // settleWorkspaceTurn derives the terminal wake from the persisted record, which
      // would duplicate the Err returned directly to the caller.
      attentionPolicy: "notify_on_terminal",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    // The failure settles through the handle machinery, so the created workspace stays
    // owner-owned: a mode="existing" retry must pass the ownership check (not invalid_scope).
    const turns = await (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: () => Promise<Array<{ status: string; attentionPolicy?: string }>>;
        };
      }
    ).taskHandleStore.listAllWorkspaceTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "error", createdWorkspace: true });
    expect(turns[0]?.attentionPolicy).toBeUndefined();

    const retry = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Retry without the diverged agent",
      title: "Diverged agent retry",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(retry.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn respects a project shadow of a built-in id at the target", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // Shadow the built-in plan agent with a hidden project-local override: target-side
    // eligibility must consult the shadow, not just the embedded definition.
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      [
        "---",
        "name: Plan",
        "description: Hidden shadowed plan",
        "base: plan",
        "ui:",
        "  hidden: true",
        "---",
        "",
        "Shadow body.",
        "",
      ].join("\n"),
      "utf-8"
    );
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not run",
      title: "Shadowed plan",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not selectable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn divergent trunkBranch defers validation to the target checkout", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Agent exists ONLY on the target branch checkout, not in the owner's checkout: an
    // owner-side miss must not fail-fast when a different base branch was requested.
    const targetBranchCheckout = path.join(rootDir, "target-branch-checkout");
    const targetAgentsDir = path.join(targetBranchCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      [
        "---",
        "name: Custom",
        "description: Target-branch-only agent",
        "base: exec",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf-8"
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetBranchCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-branch agent",
      title: "Target branch agent",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn divergent trunkBranch fails closed for unreachable targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // A different base branch can shadow ANY id (even built-ins), so an unreachable
    // target created from it cannot be verified at all.
    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-branch"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Divergent unreachable",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable created checkout: built-ins launch, custom agents fail with a reachability error", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);
    // Deferred-provisioning runtimes return from create before the checkout is reachable.
    const unreachableCheckout = path.join(rootDir, "not-provisioned-yet");

    const deferredMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: unreachableCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: deferredMetadata }))
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Custom agents cannot be verified in an unreachable checkout; dispatching anyway
    // would risk a silent exec fallback at stream time, so the launch must fail loudly.
    const custom = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Launch despite pending provisioning",
      title: "Deferred runtime",
      workspace: { mode: "new" },
    });
    expect(custom.success).toBe(false);
    if (!custom.success) {
      expect(custom.error).toContain("not reachable");
      expect(custom.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // Built-in agents are embedded in every checkout, so the launch is provably safe.
    const builtIn = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan despite pending provisioning",
      title: "Deferred runtime plan",
      workspace: { mode: "new" },
    });
    expect(builtIn.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0];
    expect(sendMessageCall?.[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn treats sanitized branch-name collisions as unproven bases", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is checked out on feature/foo, whose workspace name sanitizes to feature-foo.
    // A request for the DISTINCT branch feature-foo collides with that name, so the owner
    // must not vouch for the unreachable target: even a built-in id fails closed (the
    // colliding branch could shadow it).
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-collision"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Colliding branch",
      workspace: { mode: "new", trunkBranch: "feature-foo" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // The owner's real branch, by contrast, is a proven base: the same launch succeeds.
    const sameBranch = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the owner's own branch",
      title: "Same branch",
      workspace: { mode: "new", trunkBranch: "feature/foo" },
    });
    expect(sameBranch.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn defers owner-side misses to the target when the base is unproven", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is on feature/foo but its workspace name is feature-foo: with trunkBranch
    // omitted, the child is created from the DISTINCT feature-foo branch, which may carry
    // agents absent from the owner's branch. An owner-side miss must not fail-fast here —
    // the created target checkout is authoritative.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const targetOnlyCheckout = path.join(rootDir, "target-only-agent");
    const targetAgentsDir = path.join(targetOnlyCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      ["---", "name: Custom", "base: exec", "---", "Target-only agent."].join("\n")
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetOnlyCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-only agent",
      title: "Target-only agent",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn unreachable cross-host target fails closed even for built-ins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    // The created target lives on a remote host (per-workspace containers, Coder-style
    // per-workspace hosts). The owner's global agent roots say nothing about that host —
    // even a built-in could be shadowed by a target-host global definition — so
    // owner-side resolution must not vouch while the checkout is unreachable.
    const remoteMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "docker", image: "node:20" },
      namedWorkspacePath: "/workspace/repo",
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: remoteMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Cross-host unreachable",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("different host");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    // The unreachable probe drives real docker CLI calls whose internal
    // timeouts (10-30s) can exceed the 5s default on loaded CI runners.
  }, 20_000);

  test("createWorkspaceTurn does not verify agents while the created workspace is still initializing", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Reachable checkout whose init hook is still running: the hook may still be
    // installing/rewriting agent definitions, so a strict-validation miss is not a
    // trustworthy "unknown agentId" verdict — the launch must fail with a transient
    // error instead of a definitive one (and never dispatch an unverified id).
    const initializingCheckout = path.join(rootDir, "initializing-checkout");
    await fsPromises.mkdir(initializingCheckout, { recursive: true });

    const initializingMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: initializingCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: initializingMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const initStateManager = {
      startInit: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
      appendOutput: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      getInitState: mock((workspaceId: string) =>
        workspaceId === "childworkspace" ? { status: "running" } : undefined
      ),
      readInitStatus: mock(() => Promise.resolve(null)),
    } as unknown as InitStateManager;
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
      initStateManager,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Initializing target",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("still initializing");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable existing target: explicit overrides fail closed, default identity works", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "childworkspace",
      "firstturn",
      "planhandle",
      "planturn",
      "customhandle",
    ]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Simulates a stopped-container/deferred target: entry exists, checkout unreachable.
    const unreachableCheckout = path.join(rootDir, "stopped-target");

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: unreachableCheckout,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          ...createWorkspaceTurnMetadata(projectPath),
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        },
      });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Existing targets have unknown checkout provenance (any branch, uncommitted shadows),
    // so ALL explicit overrides fail closed while the checkout is unreachable — even
    // built-ins, whose id could be shadowed by a project definition on the target.
    for (const agentId of ["plan", "custom"]) {
      const overridden = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: `${agentId} follow-up`,
        title: `${agentId} follow-up`,
        workspace: { mode: "existing", workspaceId: "childworkspace" },
      });
      expect(overridden.success).toBe(false);
      if (!overridden.success) {
        expect(overridden.error).toContain("not reachable");
        expect(overridden.error).not.toContain("unknown agentId");
      }
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Omitting agentId keeps working: the default identity needs no verification.
    const withoutOverride = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Default follow-up",
      title: "Default follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(withoutOverride.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("createWorkspaceTurn rejects explicit agentId for descendant agent workspace targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["overridehandle", "overrideturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-override";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "reported-child"),
        id: childWorkspaceId,
        name: "agent_explore_reported_child",
        createdAt: "2026-06-19T00:00:00.000Z",
        parentWorkspaceId: parentId,
        agentType: "explore",
        taskStatus: "reported",
        reportedAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

    // Persistent children are pinned to their persisted identity at stream time
    // (resolveAgentForStream ignores per-send agentId when parentWorkspaceId is set),
    // so an override must be rejected instead of silently running the old agent.
    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Re-plan the follow-up",
      title: "Override turn",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("descendant agent workspaces");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    const childEntry = findWorkspaceInConfig(config, childWorkspaceId);
    expect(childEntry?.agentType).toBe("explore");
    expect(childEntry?.agentId).toBeUndefined();
  });

  test("createWorkspaceTurn existing-target agent override dispatches without persisting AI settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "firstturn", "followuphandle", "followupturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          // Project-dir local workspaces execute in the project root itself.
          path: projectPath,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Per-turn plan follow-up",
      title: "Override follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const followUpCall = sendMessage.mock.calls[1];
    expect(followUpCall[0]).toBe("childworkspace");
    // Override reaches the stream (normal workspaces honor the per-send agentId) but must
    // not overwrite the target's saved agent/settings.
    expect(followUpCall[2]).toMatchObject({ agentId: "plan", skipAiSettingsPersistence: true });
    // The default path keeps persisting (first send carries no override).
    expect(sendMessage.mock.calls[0]?.[2]).not.toMatchObject({ skipAiSettingsPersistence: true });
  });

  test("createWorkspaceTurn inherits pro mode from the parent's active non-exec agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while a custom agent was active — no exec bucket
          // exists, so inheritance must read the active-agent bucket.
          agentId: "researcher",
          aiSettingsByAgent: {
            researcher: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ reasoningMode: "pro" });
  });

  test("createWorkspaceTurn resolves AI settings: agent defaults on create, target settings on follow-up, explicit override wins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "firsthandle",
      "firstturn",
      "secondhandle",
      "secondturn",
      "thirdhandle",
      "thirdturn",
    ]);
    // Owner persisted at opus/high (helper default); configured exec agent
    // defaults differ from both the owner's persisted and live settings.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" } },
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation: configured agent defaults outrank the owner's live runtime
    // settings (owner turned down to medium must not produce medium children).
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({
      agentId: "exec",
      model: "openai:gpt-5.2",
      thinkingLevel: "xhigh",
    });

    // Simulate the child's own last-used settings (persist-on-send or a manual
    // flip inside the child workspace).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "anthropic:claude-opus-4-6", thinkingLevel: "low" },
      };
      return cfg;
    });

    // Follow-up: the target continues its own settings; the owner's bump to
    // high must not drag the child along, and agent defaults no longer apply.
    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[2]).toMatchObject({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });

    // Explicit per-launch overrides still outrank the target's own settings.
    const third = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Third prompt",
      title: "Override",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(third.success).toBe(true);
    const thirdSend = sendMessage.mock.calls[2];
    expect(thirdSend[2]).toMatchObject({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
    });
  });

  test("createWorkspaceTurn follow-ups do not re-inject the owner's pro mode over the target's own settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation still inherits the owner's pro mode.
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({ reasoningMode: "pro" });

    // The child was switched back to standard (absent = standard per
    // WorkspaceAISettingsSchema); follow-ups must respect that.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
      };
      return cfg;
    });

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    // The bucket's absent reasoning resolves to explicit standard; the owner's
    // pro must not leak through.
    expect((secondSend[2] as { reasoningMode?: string }).reasoningMode).not.toBe("pro");
  });

  test("createWorkspaceTurn rejects multi-project owners instead of dropping secondary repos", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary", {
      initGit: false,
    });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: secondaryProjectPath, projectName: "repo-secondary" },
          ],
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        extraProjects: [[secondaryProjectPath, { trusted: true, workspaces: [] }]],
      }
    );
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize all projects",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("multi-project workspace turns are not supported");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects fork mode until workspace turns support forking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize fork",
      title: "Workspace turn",
      workspace: { mode: "fork" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('workspace.mode="fork" is not supported');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "continuation failure transfers disposable cleanup after lock and notification (throws=%s)",
    async (throwNotification) => {
      const remove = mock(() => Promise.resolve(Ok(undefined)));
      const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
        disposable: true,
        remove,
      });
      const jobs: Array<() => Promise<void>> = [];
      workspaceMocks.workspaceService.deferWorkspaceCleanup = (run) => {
        jobs.push(run);
      };
      if (throwNotification)
        spyOn(
          taskService as unknown as {
            deliverPersistentChildWorkspaceTurnResult(
              record: WorkspaceTurnTaskHandleRecord
            ): Promise<void>;
          },
          "deliverPersistentChildWorkspaceTurnResult"
        ).mockRejectedValueOnce(new Error("notification unavailable"));
      const outcome = await taskService
        .settleWorkspaceTurnContinuationFailure(
          "childworkspace",
          workspaceTurnMuxMetadata(parentId),
          "error",
          "preparation failed"
        )
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(outcome instanceof Error).toBe(throwNotification);
      const snapshot = await workspaceTurnSnapshot(taskService, parentId);
      expect(snapshot?.status).toBe("error");
      expect(remove).not.toHaveBeenCalled();
      expect(jobs).toHaveLength(1);
      await jobs[0]();
      expect(remove).toHaveBeenCalledWith("childworkspace", true);
    }
  );

  test("createWorkspaceTurn marks accepted pre-stream failures as handle errors", async () => {
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = args[3] as
          | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
          | undefined;
        await internal?.onAcceptedPreStreamFailure?.({
          type: "unknown",
          raw: "Runtime startup failed",
        });
        return Ok(undefined);
      }
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({ sendMessage });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Runtime startup failed",
      workspaceId: "childworkspace",
    });
  });

  test("createWorkspaceTurn reprompts only owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const taskHandleStore = (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: (options?: { statuses?: readonly string[] }) => Promise<unknown[]>;
        };
      }
    ).taskHandleStore;
    const listAllWorkspaceTurns = spyOn(taskHandleStore, "listAllWorkspaceTurns");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Second prompt");
    expect(secondSend[3]).toMatchObject({ requireIdle: true });
    const secondSnapshot = await workspaceTurnSnapshot(taskService, parentId, "wst_secondhandle");
    expect(secondSnapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "running",
    });
    expect(listAllWorkspaceTurns).toHaveBeenCalledTimes(1);
    listAllWorkspaceTurns.mockRestore();

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "other-parent"),
        id: "other-parent",
        name: "other-parent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const foreign = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: "other-parent",
      prompt: "Should not run",
      title: "Foreign",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(foreign.success).toBe(false);
    if (foreign.success) return;
    expect(foreign.error).toContain("invalid_scope");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test.each(["isolated", "shared", "busy"] as const)(
    "internal workspace-turn reported child continuation (%s desktop)",
    async (desktop) => {
      const config = await createTestConfig(rootDir);
      stubStableIds(config, ["followuphandle", "followupturn"]);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const childWorkspaceId = "reported-child-workspace";
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "reported-child"),
          id: childWorkspaceId,
          name: "agent_explore_reported_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          taskDesktopOwnerWorkspaceId: desktop === "isolated" ? undefined : parentId,
          reportedAt: "2026-06-19T00:00:00.000Z",
          aiSettingsByAgent: {
            explore: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "medium" },
          },
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "high",
          runtimeConfig: { type: "local" },
        });
        if (desktop === "busy") {
          project.workspaces.push(
            projectWorkspace(projectPath, "competitor", "competitor", {
              parentWorkspaceId: parentId,
              agentId: "explore",
              taskStatus: "running",
              taskDesktopOwnerWorkspaceId: parentId,
              runtimeConfig: { type: "local" },
            })
          );
        }
        return cfg;
      });

      const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
        const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
        await internal?.onAccepted?.();
        return Ok(undefined);
      });
      const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
      const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        prompt: "Investigate the follow-up root cause",
        title: "Continue reported child",
        allowAgentWorkspace: true,
        workspace: { mode: "existing", workspaceId: childWorkspaceId },
      });

      if (desktop === "busy") {
        expect(result.success).toBe(false);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskExecutionId).toBeUndefined();
        expect(await new TaskHandleStore(config).listAllWorkspaceTurns()).toHaveLength(0);
        return;
      }
      expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskDesktopOwnerWorkspaceId).toBe(
        desktop === "isolated" ? undefined : parentId
      );
      expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskExecutionStatus).toBe("running");
      expect(result).toEqual(
        Ok({
          taskId: "wst_followuphandle",
          kind: "workspace_turn",
          status: "running",
          workspaceId: childWorkspaceId,
        })
      );
      expect(sendMessage).toHaveBeenCalledWith(
        childWorkspaceId,
        "Investigate the follow-up root cause",
        expect.objectContaining({
          model: "anthropic:claude-sonnet-4-6",
          agentId: "explore",
          thinkingLevel: "medium",
        }),
        expect.objectContaining({ requireIdle: true })
      );
    }
  );

  test("late direct-parent snapshot consumption suppresses duplicate continuation delivery", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-late-direct-parent-await";
    const handleId = "wst_late_direct_parent_await";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Late Await Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const terminalRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "late-direct-parent-await",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Already returned by task_await.",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminalRecord);

    const consumed = await taskService.getWorkspaceTurnSnapshot(parentId, handleId, {
      consumingWorkspaceId: parentId,
    });
    expect(consumed?.directParentResultDeliveredAt).toBeDefined();

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(terminalRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Already returned by task_await.");
  });

  test("queue-cut supersede settlement is delivered to the persistent child's direct parent", async () => {
    // The old error settlement appended a terminal failure to the direct
    // parent; the interrupted supersede settlement must not silently vanish.
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-superseded-delivery";
    const handleId = "wst_superseded_delivery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Superseded Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const supersededRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "superseded-delivery",
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(supersededRecord);

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(supersededRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    const serialized = JSON.stringify(parentHistory);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("superseded by new input in the target workspace");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, handleId))?.directParentResultDeliveredAt
    ).toBeDefined();

    // Explicit cancellations (no supersede reason) must stay silent.
    const { error: _supersedeReason, ...canceledBase } = supersededRecord;
    const canceledRecord: WorkspaceTurnTaskHandleRecord = {
      ...canceledBase,
      handleId: "wst_canceled_delivery",
      turnId: "canceled-delivery",
    };
    await taskHandleStore.upsertWorkspaceTurn(canceledRecord);
    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(canceledRecord, new Set());
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_canceled_delivery"))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();
  });

  test("terminal recovery dedupes a matching ordinary legacy workspace-turn notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_legacy_ordinary_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "legacy-ordinary-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Already delivered ordinary result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "completed",
      createdAt: "2026-08-11T00:00:01.500Z",
    });
    assert(legacy, "legacy ordinary attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    expect(
      await (
        taskService as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("terminal recovery versions corrected workspace-turn attention past a legacy tombstone", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_corrected_attention_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "corrected-attention-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Corrected recovered result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "error",
    });
    assert(legacy, "legacy workspace-turn attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    const recovered = await (
      taskService as unknown as {
        recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
      }
    ).recoverTerminalWorkspaceTurnAttentionNotifications();
    expect(recovered).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("createWorkspaceTurn queues busy owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const busyWorkspaceIds = new Set<string>();
    const isStreaming = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const isBusyForMessage = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const hasQueuedMessages = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      sendMessage,
      hasQueuedWorkspaceTurn: mock(
        (workspaceId: string, handleId: string) =>
          workspaceId === "childworkspace" && handleId === "wst_secondhandle"
      ),
      isBusyForMessage,
      hasQueuedMessages,
    });
    const aiMocks = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    busyWorkspaceIds.add("childworkspace");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "queued",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Queued prompt");
    expect(secondSend[2]).toMatchObject({
      queueDispatchMode: "turn-end",
      muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_secondhandle", "secondturn"),
    });
    expect(secondSend[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: false,
      agentInitiated: true,
    });
    expect(secondSend[3]).toHaveProperty("onAccepted");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId, "wst_secondhandle");
    expect(snapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "queued",
    });

    const internal = taskService as unknown as { countActiveWorkspaceTurns: () => Promise<number> };
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);

    const interrupted = await taskService.interruptWorkspaceTurn(parentId, "wst_secondhandle");
    expect(interrupted.success).toBe(true);
    expect(workspaceMocks.removeQueuedWorkspaceTurn).toHaveBeenCalledWith(
      "childworkspace",
      "wst_secondhandle",
      { cancelReason: "Workspace turn interrupted" }
    );
    const sendInternal = secondSend[3] as { onAccepted: () => Promise<void> };
    let acceptedAfterInterruptError: unknown;
    try {
      await sendInternal.onAccepted();
    } catch (error) {
      acceptedAfterInterruptError = error;
    }
    if (!(acceptedAfterInterruptError instanceof Error)) {
      throw new Error("Expected onAccepted to reject after interrupt");
    }
    expect(acceptedAfterInterruptError.message).toMatch(/canceled before stream start/);
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn reserves a slot before queueing a manually busy existing workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedhandle", "queuedturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        {
          path: path.join(projectPath, "childworkspace"),
          id: "childworkspace",
          name: "childworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        },
        {
          path: path.join(projectPath, "otherworkspace"),
          id: "otherworkspace",
          name: "otherworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        }
      );
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      isBusyForMessage: mock((workspaceId: string) => workspaceId === "childworkspace"),
    });
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === "otherworkspace"),
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_owned", "completed", {
        turnId: "ownedturn",
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
      })
    );
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "otherworkspace", "wst_other", "running", {
        turnId: "otherturn",
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
      })
    );

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("maxParallelAgentTasks exceeded");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn counts active workspace turns across all owners", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const otherParentId = "other-parent";
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, otherParentId),
        id: otherParentId,
        name: otherParentId,
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: otherParentId,
      prompt: "Second prompt",
      title: "Other workspace turn",
      workspace: { mode: "new" },
    });
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain("maxParallelAgentTasks exceeded");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("active workspace turn count excludes foreground-waiting workspace turns", async () => {
    const { taskService, taskHost } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    const stopForegroundAwait = taskHost.startForegroundAwait("childworkspace");
    try {
      expect(await internal.countActiveWorkspaceTurns()).toBe(0);
    } finally {
      stopForegroundAwait();
    }
  });

  test("parallel quota counts a reawakened child only through its continuation handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const reawakenedTaskId = "reawakened-quota-child";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "ordinary-child", "ordinary-quota-child", {
          parentWorkspaceId: parentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "reawakened-child", reawakenedTaskId, {
          parentWorkspaceId: parentId,
          taskStatus: "reported",
          taskExecutionId: "wst_reawakened_quota",
          taskExecutionStatus: "running",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === reawakenedTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, reawakenedTaskId, "wst_reawakened_quota", "running", {
        turnId: "turn-reawakened-quota",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    const activeAgentCount = taskHost.countActiveAgentTasks(config.loadConfigOrDefault());
    const activeWorkspaceTurnCount = await internal.countActiveWorkspaceTurns();

    expect(activeAgentCount).toBe(1);
    expect(activeWorkspaceTurnCount).toBe(1);
    expect(activeAgentCount + activeWorkspaceTurnCount).toBe(2);
  });

  test("active workspace turn count settles stale persisted handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(0);

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("active workspace turn count keeps startup-retrying handles live", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith("childworkspace");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("getWorkspaceTurnSnapshot settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("uncorrelated stream-end before queued workspace turn prompt does not interrupt it", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const oldAssistant = createMuxMessage("old-assistant", "assistant", "Previous turn", {
      model: "anthropic:claude-opus-4-6",
      finishReason: "stop",
    });
    const queuedPrompt = createMuxMessage("queued-prompt", "user", "Queued follow-up", {
      muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
    });
    expect((await historyService.appendToHistory(created.workspaceId, oldAssistant)).success).toBe(
      true
    );
    expect((await historyService.appendToHistory(created.workspaceId, queuedPrompt)).success).toBe(
      true
    );

    const internal = taskService as unknown as {
      interruptWorkspaceTurnFromUncorrelatedStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };
    const handled = await internal.interruptWorkspaceTurnFromUncorrelatedStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "old-assistant",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "stop",
      },
      parts: [],
    });

    expect(handled).toBe(true);
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
  });

  test("uncorrelated synthetic wake end leaves the active handle running", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const event = await appendUncorrelatedWakeHistory({
      historyService,
      parentId,
      taskId: created.taskId,
      workspaceId: created.workspaceId,
      inputSynthetic: true,
    });

    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "running",
    });

    const correlatedFinal: StreamEndEvent = {
      ...event,
      messageId: "real-final",
      metadata: {
        ...event.metadata,
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      },
      parts: [{ type: "text", text: "Real final result" }],
    };
    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, correlatedFinal)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "completed",
      messageId: "real-final",
      reportMarkdown: "Real final result",
    });
  });

  test("compaction-preserved turn anchor ignores an uncorrelated synthetic wake end", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const compactionSummary = createMuxMessage("compaction-summary", "user", "Compacted context", {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          text: "Continue the delegated work",
          workspaceTurnMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
        },
      },
    });
    expect(
      (await historyService.appendToHistory(created.workspaceId, compactionSummary)).success
    ).toBe(true);
    const wakeInput = createMuxMessage("wake-input", "user", "Continue after a wake", {
      synthetic: true,
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeInput)).success).toBe(
      true
    );
    const wakeOutput = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeOutput)).success).toBe(
      true
    );

    expect(
      await finalizeWorkspaceTurnStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: created.workspaceId,
        messageId: wakeOutput.id,
        metadata: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          finishReason: "stop",
        },
        parts: [{ type: "text", text: "Wake result" }],
      })
    ).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "running",
    });
  });

  test("manual user input still supersedes an active workspace turn on uncorrelated end", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const event = await appendUncorrelatedWakeHistory({
      historyService,
      parentId,
      taskId: created.taskId,
      workspaceId: created.workspaceId,
      inputSynthetic: false,
    });

    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "interrupted",
      messageId: "wake-output",
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
  });

  test("malformed user-triggered auto-compaction still supersedes an active workspace turn", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const prompt = createMuxMessage("turn-prompt", "user", "Summarize the repo", {
      muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
    });
    expect((await historyService.appendToHistory(created.workspaceId, prompt)).success).toBe(true);
    const compactionRequest = createMuxMessage(
      "auto-compaction",
      "user",
      "Compacting before a new user prompt",
      {
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: null,
          source: "auto-compaction",
        } as unknown as MuxMessageMetadata,
      }
    );
    expect(
      (await historyService.appendToHistory(created.workspaceId, compactionRequest)).success
    ).toBe(true);
    const wakeOutput = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeOutput)).success).toBe(
      true
    );

    expect(
      await finalizeWorkspaceTurnStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: created.workspaceId,
        messageId: wakeOutput.id,
        metadata: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          finishReason: "stop",
        },
        parts: [{ type: "text", text: "Wake result" }],
      })
    ).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "interrupted",
      messageId: wakeOutput.id,
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
  });

  test("getWorkspaceTurnSnapshot recovers stale completed handles from matching history", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_completed", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: created.workspaceId,
      messageId: "msg_completed",
      reportMarkdown: "Recovered final text",
      finalMessageRef: { messageId: "msg_completed", finishReason: "stop", textCharCount: 20 },
    });
  });

  test("getWorkspaceTurnSnapshot recovers stale truncated handles from matching history as errors", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_truncated_history", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: created.workspaceId,
      messageId: "msg_truncated_history",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("listWorkspaceTurnTasks settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(
      await taskService.listWorkspaceTurnTasks(parentId, {
        statuses: ["running"],
      })
    ).toEqual([]);

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "interrupted", workspaceId: "childworkspace" });
  });

  test("terminal notify policy updates preserve the terminal outcome version", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const terminal: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      reportMarkdown: "Terminal result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(terminal);

    await taskService.markWorkspaceTurnBackgroundWorkNotifyOnTerminal(terminal.handleId, parentId);

    const updated = await taskHandleStore.getWorkspaceTurn(parentId, terminal.handleId);
    expect(updated).toMatchObject({
      status: "completed",
      updatedAt: terminal.updatedAt,
      attentionPolicy: "notify_on_terminal",
    });
    const attentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      terminal.handleId,
      `${terminal.handleId}:${terminal.status}:${terminal.updatedAt}`
    );
    expect(await new TerminalAttentionStore(config).get(parentId, attentionId)).not.toBeNull();
  });

  const OWNER_FOLLOW_UP_SUPERSEDE_PREFIX = "Workspace turn superseded by follow-up turn ";

  test("startup recovery does not resurrect a quiet owner-follow-up supersede wake", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    const base = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      status: "interrupted" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal" as const,
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_quiet_recovery",
      turnId: "quiet-recovery",
      error: `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_generic_recovery",
      turnId: "generic-recovery",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });

    expect(
      await (
        taskService as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_quiet_recovery",
          "wst_quiet_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_generic_recovery",
          "wst_generic_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_quiet_recovery"))
        ?.terminalAttentionNotifiedAt
    ).toBeUndefined();
  });

  test("owner-follow-up supersede skips the direct-parent envelope only when the parent initiated it", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-quiet-supersede";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Quiet Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const quietError = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const ownerInitiated: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_quiet_owner_parent",
      // The direct parent IS the owner that initiated the successor.
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "quiet-owner-parent",
      status: "interrupted",
      error: quietError,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(ownerInitiated);
    const internal = taskService as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      workspaceTurnRequiresDirectParentDelivery: (record: WorkspaceTurnTaskHandleRecord) => boolean;
    };

    await internal.deliverPersistentChildWorkspaceTurnResult(ownerInitiated, new Set());
    const ownerHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(ownerHistory.success).toBe(true);
    expect(JSON.stringify(ownerHistory)).not.toContain("workspace_turn_superseded");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, ownerInitiated.handleId))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();

    // A different owner's follow-up cut is NOT the direct parent's doing: the
    // envelope still gets delivered with the supersede error type.
    const ancestorInitiated: WorkspaceTurnTaskHandleRecord = {
      ...ownerInitiated,
      handleId: "wst_quiet_ancestor",
      ownerWorkspaceId: "ancestorownerws",
      turnId: "quiet-ancestor",
    };
    await taskHandleStore.upsertWorkspaceTurn(ancestorInitiated);
    await internal.deliverPersistentChildWorkspaceTurnResult(ancestorInitiated, new Set());
    const delivered = await historyService.getHistoryFromLatestBoundary(parentId);
    const serialized = JSON.stringify(delivered);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("wst_successor");

    // Settle-path predicate agrees, so no delivery-required marker is ever set
    // for the owner-initiated flavor.
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ownerInitiated)).toBe(false);
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ancestorInitiated)).toBe(true);
  });

  test("snapshot history repair preserves the owner-follow-up supersede flavor", async () => {
    // Same race as the generic supersede repair test: a snapshot read from the
    // SAME correlated final must keep the quiet flavor instead of downgrading
    // it to the generic reason or a truncation error.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const quietReason = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_owner_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        error: quietReason,
        createdWorkspace: true,
        messageId: "msg_owner_cut",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: quietReason,
      messageId: "msg_owner_cut",
    });
  });

  test("mode=existing tool-end follow-up reports the same-owner turn it may supersede", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("queued");
    expect(followUp.data.maySupersedeTaskId).toBe("wst_handle");

    // turn-end dispatch never cuts the active turn, so no announcement.
    const turnEnd = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up later",
      title: "Follow up later",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });
    expect(turnEnd.success).toBe(true);
    if (!turnEnd.success) throw new Error(turnEnd.error);
    expect(turnEnd.data.maySupersedeTaskId).toBeUndefined();
  });

  test("mode=existing follow-up to an idle target reports no supersession", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2"],
    });

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("running");
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });

  test("mode=existing announcement names the immediate queued predecessor", async () => {
    // Codex P2: with A active and same-owner tool-end follow-ups B and C
    // queued, C supersedes B (not A) at B's first boundary — and B's own
    // settlement wake is suppressed, so C's announcement is the only place
    // B's interruption can surface.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUpB = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up B",
      title: "Follow up B",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpB.success).toBe(true);
    if (!followUpB.success) throw new Error(followUpB.error);
    expect(followUpB.data.maySupersedeTaskId).toBe("wst_handle");

    // createdAt is per-process monotonic (nextWorkspaceTurnCreatedAt), so the
    // newest-first predecessor scan is deterministic even when the original
    // turn and follow-up B are created within the same millisecond.
    const followUpC = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up C",
      title: "Follow up C",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpC.success).toBe(true);
    if (!followUpC.success) throw new Error(followUpC.error);
    expect(followUpC.data.maySupersedeTaskId).toBe(followUpB.data.taskId);
  });

  test("settlement preserves a disposable ownership transfer that raced its snapshot", async () => {
    // Codex P2: a settlement built from a record read BEFORE
    // transferDisposableWorkspaceToSuccessor flipped disposableWorkspace on
    // disk must not persist the stale false bit — the record reloaded inside
    // the settlement lock is authoritative, so the successor still cleans up
    // the transferred checkout instead of leaking it.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({ remove });
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    const staleSnapshot = { ...running };
    expect(staleSnapshot.disposableWorkspace).toBe(false);
    // Transfer lands after the snapshot was taken.
    await taskHandleStore.upsertWorkspaceTurn({ ...running, disposableWorkspace: true });
    const internal = taskService as unknown as {
      settleWorkspaceTurn: (params: {
        record: WorkspaceTurnTaskHandleRecord;
        next: WorkspaceTurnTaskHandleRecord;
        cause: { kind: "user-stream-abort" };
        waiterSettlement: { status: "error"; error: Error };
      }) => Promise<void>;
    };

    await internal.settleWorkspaceTurn({
      cause: { kind: "user-stream-abort" },
      record: staleSnapshot,
      next: {
        ...staleSnapshot,
        status: "interrupted",
        updatedAt: new Date().toISOString(),
        error: "Workspace turn interrupted",
      },
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });

    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      disposableWorkspace: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("mode=existing follow-up over a different owner's active turn reports no supersession", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2"],
      hasPendingQueuedOrPreparingTurn,
    });
    const interrupted = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(interrupted.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord("ancestorownerws", "childworkspace", "wst_other_owner_turn", "running", {
        turnId: "other-owner-turn",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      })
    );
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });

  function intermediateStopEvent(parentId: string): StreamEndEvent {
    const muxMetadata = workspaceTurnMuxMetadata(parentId);
    return {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "intermediate-stop",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "tool-calls",
        muxMetadata,
        stopCause: { kind: "queued-input", entryId: "continuation-entry", muxMetadata },
      },
      parts: [{ type: "text", text: "Work in progress" }],
    };
  }

  async function persistStopEvent(history: HistoryService, event: StreamEndEvent): Promise<void> {
    const result = await history.appendToHistory(event.workspaceId, {
      id: event.messageId,
      role: "assistant",
      metadata: event.metadata,
      parts: event.parts,
    });
    expect(result.success).toBe(true);
  }

  test("queue stop attribution survives queue removal before finalization and recovery", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    event.metadata.stopCause = { kind: "queued-input", entryId: "manual-entry" };
    await persistStopEvent(historyService, event);
    const store = new TaskHandleStore(config);
    const record = await store.getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const internal = taskService as unknown as {
      recoverTerminalWorkspaceTurnFromHistory(
        record: WorkspaceTurnTaskHandleRecord
      ): Promise<WorkspaceTurnTaskHandleRecord | null>;
    };
    const recovered = await internal.recoverTerminalWorkspaceTurnFromHistory(record);
    expect(recovered?.status).toBe("interrupted");
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      error: recovered?.error,
    });
  });

  test.each([false, true])(
    "continuation starts and finishes during finalization await (legacy=%s)",
    async (legacy) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return readHistory(...args);
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const successor: StreamEndEvent = {
        ...event,
        messageId: "finished-continuation",
        metadata: { ...event.metadata, finishReason: "stop", stopCause: undefined },
        parts: [{ type: "text", text: "Completed result" }],
      };
      await persistStopEvent(historyService, successor);
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "completed",
        messageId: successor.messageId,
        reportMarkdown: "Completed result",
      });
      const store = new TaskHandleStore(config);
      const completed = await store.getWorkspaceTurn(parentId, "wst_handle");
      await finalizeWorkspaceTurnStreamEndForTest(taskService, successor);
      expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toEqual(completed);
    }
  );

  test.each([false, true])(
    "continuation arriving during history read keeps execution active (legacy=%s)",
    async (legacy) => {
      const pending = mock(() => false);
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
        hasPendingWorkspaceTurnContinuation: pending,
      });
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          const snapshot = await readHistory(...args);
          entered.resolve();
          await release.promise;
          return snapshot;
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      pending.mockReturnValue(true);
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "running",
        deferredMessageIds: [event.messageId],
      });
    }
  );

  test.each([false, true])(
    "settled repair honors explicit replacement cause (sameOwner=%s)",
    async (sameOwner) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = {
        kind: "queued-input",
        entryId: "replacement-entry",
        ...(sameOwner ? { muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_successor") } : {}),
      };
      await persistStopEvent(historyService, event);
      await new TaskHandleStore(config).upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
          messageId: "earlier-error",
          error: "Earlier provider failure",
        })
      );
      const repaired = await workspaceTurnSnapshot(taskService, parentId);
      expect(repaired).toMatchObject({ status: "interrupted", messageId: event.messageId });
      if (sameOwner) expect(repaired?.error).toContain("wst_successor");
    }
  );

  test.each([false, true])(
    "recovery preserves pending same-execution continuation (legacy=%s)",
    async (legacy) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
        hasPendingWorkspaceTurnContinuation: mock(() => true),
      });
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const store = new TaskHandleStore(config);
      const record = await store.getWorkspaceTurn(parentId, "wst_handle");
      assert(record);
      const internal = taskService as unknown as {
        recoverTerminalWorkspaceTurnFromHistory(
          record: WorkspaceTurnTaskHandleRecord
        ): Promise<WorkspaceTurnTaskHandleRecord | null>;
      };
      expect(await internal.recoverTerminalWorkspaceTurnFromHistory(record)).toBeNull();
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
        status: "running",
        deferredMessageIds: [event.messageId],
      });
    }
  );

  test.each(["interrupted", "error"] as const)(
    "continuation %s survives a late intermediate finalization",
    async (status) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
      const event = intermediateStopEvent(parentId);
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return readHistory(...args);
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const error =
        status === "interrupted"
          ? "Continuation canceled by user"
          : "Continuation dispatch failed: runtime unavailable";
      await taskService.settleWorkspaceTurnContinuationFailure(
        event.workspaceId,
        workspaceTurnMuxMetadata(parentId),
        status,
        error
      );
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({ status, error });
    }
  );

  test.each(["error", "interrupted"] as const)(
    "old replacement queue stop preserves newer %s during handle lookup",
    async (status) => {
      const { config, parentId, taskService } = await startWorkspaceTurnForTest();
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = { kind: "queued-input", entryId: "replacement" };
      const store = (taskService as unknown as { taskHandleStore: TaskHandleStore })
        .taskHandleStore;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHandle = store.getWorkspaceTurn.bind(store);
      spyOn(store, "getWorkspaceTurn").mockImplementationOnce(async (...args) => {
        const snapshot = await readHandle(...args);
        entered.resolve();
        await release.promise;
        return snapshot;
      });
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const error = status === "error" ? "Continuation dispatch failed" : "Continuation canceled";
      await taskService.settleWorkspaceTurnContinuationFailure(
        event.workspaceId,
        workspaceTurnMuxMetadata(parentId),
        status,
        error
      );
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({ status, error });
    }
  );

  test("old queue stop cannot replace a newer terminal message", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const old = intermediateStopEvent(parentId);
    old.metadata.stopCause = { kind: "queued-input", entryId: "old-replacement" };
    old.metadata.historySequence = 10;
    const newer: StreamEndEvent = {
      ...old,
      messageId: "newer-failure",
      metadata: {
        ...old.metadata,
        stopCause: undefined,
        finishReason: "length",
        historySequence: 20,
      },
    };
    await finalizeWorkspaceTurnStreamEndForTest(taskService, newer);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, old);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      messageId: newer.messageId,
    });
  });

  test.each([false, true])(
    "required-tool completion repairs a transient failure (duringLookup=%s)",
    async (duringLookup) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = { kind: "required-tool" };
      await persistStopEvent(historyService, event);
      const store = (taskService as unknown as { taskHandleStore: TaskHandleStore })
        .taskHandleStore;
      const fail = () =>
        taskService.settleWorkspaceTurnContinuationFailure(
          event.workspaceId,
          workspaceTurnMuxMetadata(parentId),
          "error",
          "Transient provider failure"
        );
      if (duringLookup) {
        const readHandle = store.getWorkspaceTurn.bind(store);
        spyOn(store, "getWorkspaceTurn").mockImplementationOnce(async (...args) => {
          const snapshot = await readHandle(...args);
          await fail();
          return snapshot;
        });
      } else {
        await fail();
      }
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "completed",
        messageId: event.messageId,
      });
    }
  );

  test("stale recovery defers while a send is in pre-admission", async () => {
    const { config, parentId, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    workspaceMocks.acquireIdleTurnExclusion.mockReturnValueOnce(Err("a send is being admitted"));
    const readHistory = spyOn(historyService, "getHistoryFromLatestBoundary");
    await (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    expect(readHistory).not.toHaveBeenCalled();
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
    });
  });

  test("stale recovery waits for an in-flight stream start before reading history", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const streams = new StreamManager(historyService);
    Reflect.set(taskService, "streamManager", streams);
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const starting = await streams.acquireStreamStartLock(event.workspaceId);
    const entered = Promise.withResolvers<void>();
    const acquire = streams.acquireStreamStartLock.bind(streams);
    spyOn(streams, "acquireStreamStartLock").mockImplementationOnce((id) => {
      entered.resolve();
      return acquire(id);
    });
    const recovering = (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    await entered.promise;
    const completed: StreamEndEvent = {
      ...event,
      messageId: "continuation-committed",
      metadata: { ...event.metadata, finishReason: "stop", stopCause: undefined },
    };
    await persistStopEvent(historyService, completed);
    await starting[Symbol.asyncDispose]();
    await recovering;
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: completed.messageId,
    });
  });

  test("stale recovery blocks new starts through terminal persistence without blocking other workspaces", async () => {
    const { config, parentId, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    let admissionHeld = false;
    workspaceMocks.acquireIdleTurnExclusion.mockImplementation(() => {
      admissionHeld = true;
      return Ok({
        [Symbol.dispose]: () => {
          admissionHeld = false;
        },
      });
    });
    const streams = new StreamManager(historyService);
    Reflect.set(taskService, "streamManager", streams);
    const event = intermediateStopEvent(parentId);
    event.metadata.finishReason = "stop";
    delete event.metadata.stopCause;
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    await persistStopEvent(historyService, event);
    const store = (taskService as unknown as { taskHandleStore: TaskHandleStore }).taskHandleStore;
    const record = await store.getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = spyOn(
      taskService as unknown as {
        cleanupDisposableWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      },
      "cleanupDisposableWorkspaceTurn"
    ).mockImplementation(async () => {
      expect(admissionHeld).toBe(false);
      await using _cleanupStart = await streams.acquireStreamStartLock(event.workspaceId);
    });
    const persist = store.upsertWorkspaceTurn.bind(store);
    spyOn(store, "upsertWorkspaceTurn").mockImplementationOnce(async (next) => {
      entered.resolve();
      await release.promise;
      return persist(next);
    });
    const recovering = (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    await entered.promise;
    let started = false;
    const starting = streams.acquireStreamStartLock(event.workspaceId).then(async (lock) => {
      started = true;
      await lock[Symbol.asyncDispose]();
    });
    await using _otherWorkspace = await streams.acquireStreamStartLock("other-workspace");
    expect(started).toBe(false);
    expect(admissionHeld).toBe(true);
    release.resolve();
    await recovering;
    await starting;
    expect(cleanup).toHaveBeenCalled();
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: event.messageId,
    });
  });

  test("unreadable history does not keep a deferred continuation active forever", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    spyOn(historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(
      Err("History unavailable")
    );
    await (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    expect(
      (await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle"))?.status
    ).toBe("interrupted");
  });

  test("finalizing continuation remains active until its history commit", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    const getStreamInfo = mock((_workspaceId: string, includeFinalizing?: boolean) =>
      includeFinalizing
        ? { messageId: "continuation-finalizing", muxMetadata: event.metadata.muxMetadata }
        : undefined
    );
    expect(Reflect.set(taskService, "streamManager", { getStreamInfo })).toBe(true);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    expect(getStreamInfo).toHaveBeenCalledWith(event.workspaceId, true);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: [event.messageId],
    });
  });

  test.each([
    { cause: { kind: "required-tool" } as const, status: "completed" },
    { cause: { kind: "context-budget", decision: "rollover" } as const, status: "error" },
    { cause: { kind: "step-limit" } as const, status: "error" },
  ])(
    "explicit $cause.kind stop does not borrow unrelated queue attribution",
    async ({ cause, status }) => {
      const { config, parentId, taskService } = await startWorkspaceTurnForTest({
        getQueueCutCutter: mock(() => ({ stage: "queued", dispatchMode: "tool-end" })),
      });
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = cause;
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(
        (await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle"))?.status
      ).toBe(status);
    }
  );

  test("legacy tool stop without continuation records an unknown cause", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    delete event.metadata.stopCause;
    await persistStopEvent(historyService, event);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("unknown stop cause");
  });

  test("lost continuation settles instead of remaining active after recovery", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const event = intermediateStopEvent(parentId);
    await persistStopEvent(historyService, event);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("continuation unavailable");
    expect(record?.error).toContain("continuation-entry");
  });

  test("workspace-turn deferred stream-end does not finalize the handle", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    };
    const internal = taskService as unknown as {
      markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      finalizeWorkspaceTurnFromStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };

    await internal.markWorkspaceTurnStreamEndDeferred(event);
    expect(await internal.finalizeWorkspaceTurnFromStreamEnd(event)).toBe(true);

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_deferred"],
    });
  });

  test("a final-flush stream-end is deferred even without a queued continuation", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_flush",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          ...workspaceTurnMuxMetadata(parentId),
          contextBudgetContinuation: true,
          contextBudgetFlush: true,
        },
      },
      parts: [],
    };
    // Nothing is queued (e.g. the user cleared the queue mid-flush): the housekeeping finish still
    // must not settle the delegated task.
    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_flush"],
    });
  });

  test("workspace-turn deferred marker does not rewrite terminal handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const interruptResult = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(interruptResult.success).toBe(true);
    await (
      taskService as unknown as {
        markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      }
    ).markWorkspaceTurnStreamEndDeferred({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred_after_interrupt",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "interrupted" });
    expect(snapshot?.deferredMessageIds).toBeUndefined();
  });

  test("repeat interrupt of an already-interrupted workspace turn is a no-op", async () => {
    // A queue-cut supersede settles the handle interrupted while the target
    // workspace keeps streaming under the new input. A stale task_stop for the
    // settled handle must not stop that unrelated stream.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest();
    const first = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(first.success).toBe(true);
    aiMocks.stopStream.mockClear();

    const repeat = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(repeat).toEqual(Ok({ workspaceId: "childworkspace" }));
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("listWorkspaceTurnTasks repairs restart-interrupted deferred handles before filtering", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_recovered_list", "assistant", "Recovered list text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        deferredMessageIds: ["msg_recovered_list"],
        error: "Workspace turn interrupted after restart",
      })
    );

    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted", "completed"],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      handleId: "wst_handle",
      status: "completed",
      messageId: "msg_recovered_list",
      reportMarkdown: "Recovered list text",
    });
    expect(listed[0]?.error).toBeUndefined();

    const interruptedOnly = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted"],
    });
    expect(interruptedOnly.map((record) => record.handleId)).not.toContain("wst_handle");
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred error handles", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        archivedAt: "2026-06-19T00:01:00.000Z",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_truncated", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        deferredMessageIds: ["msg_truncated"],
        error: "Workspace turn interrupted after restart",
      })
    );

    const repaired = await workspaceTurnSnapshot(taskService, parentId);
    expect(repaired).toMatchObject({
      status: "error",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
  });

  test("explicitly interrupted workspace turns are not revived by same-turn retry evidence", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("snapshot history repair does not downgrade a supersede settlement before the successor lands", async () => {
    // Queue-cut supersede race: the handle settles interrupted from the
    // tool-calls stream-end, but the superseding queued input has not appended
    // its user message to child history yet. A task_await snapshot read in that
    // window repairs from the SAME correlated final and must preserve the
    // supersede classification instead of downgrading it to a truncation error.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const supersedeReason =
      "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report";
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_queue_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        error: supersedeReason,
        createdWorkspace: true,
        messageId: "msg_queue_cut",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: supersedeReason,
      messageId: "msg_queue_cut",
    });
  });

  test("snapshot history repair does not upgrade an error settlement to a supersede", async () => {
    // A tool-calls turn correctly settled as error (no live queue-cut evidence,
    // e.g. a required-tool stop) must stay an error even after unrelated user
    // messages land in child history: order is not causal queue-cut evidence.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_required_tool_stop", "assistant", "Stopped on required tool", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_unrelated_later_input", "user", "Unrelated later question")
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        error: "Workspace turn ended before completion (finishReason: tool-calls)",
        createdWorkspace: true,
        messageId: "msg_required_tool_stop",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
      messageId: "msg_required_tool_stop",
    });
  });

  test("getWorkspaceTurnSnapshot repairs a stale error handle from self-healed history", async () => {
    const { config, parentId, taskService, taskHost, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "exec";
      child.agentType = "exec";
      child.taskStatus = "reported";
      return cfg;
    });
    const patchGeneration = spyOn(
      taskHost,
      "maybeStartPatchGenerationForReportedTask"
    ).mockResolvedValue(undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_selfhealed", "assistant", "Self-healed final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Stream error: provider overloaded",
      })
    );

    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "stale-direct-parent-failure",
            "user",
            [
              "<mux_subagent_failure>",
              "<task_id>childworkspace</task_id>",
              "<execution_version>wst_handle:error:2026-06-19T00:00:01.000Z</execution_version>",
              "<execution_id>wst_handle</execution_id>",
              "<agent_type>explore</agent_type>",
              "<error_type>workspace_turn_error</error_type>",
              "<error_message>",
              "Stream error: provider overloaded",
              "</error_message>",
              "</mux_subagent_failure>",
            ].join("\n"),
            { timestamp: Date.now(), synthetic: true, uiVisible: true }
          )
        )
      ).success
    ).toBe(true);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const staleAttention = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "childworkspace",
      generationId: "wst_handle:error:2026-06-19T00:00:01.000Z",
      createdAt: "2026-06-19T00:00:01.750Z",
    });
    assert(staleAttention, "stale direct-parent attention must exist");
    await terminalAttentionStore.markDelivered(parentId, staleAttention.id);

    // List paths skip history repair for settled handles (no runtime activity), so the
    // stale record stays visible there until a snapshot read reconciles it.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["error"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed",
      reportMarkdown: "Self-healed final text",
    });
    expect(patchGeneration).toHaveBeenCalledWith("childworkspace", {
      refreshForContinuation: true,
    });
    const deliveredSnapshot = await new TaskHandleStore(config).getWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(deliveredSnapshot?.directParentResultDeliveryRequiredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(parentHistory)).toContain("Stream error: provider overloaded");
    expect(JSON.stringify(parentHistory)).toContain("wst_handle:completed:");
    expect(JSON.stringify(parentHistory)).toContain("Self-healed final text");
    assert(deliveredSnapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${deliveredSnapshot.handleId}:${deliveredSnapshot.status}:${deliveredSnapshot.updatedAt}`;
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).not.toBeNull();
    expect(await terminalAttentionStore.get(parentId, staleAttention.id)).toBeNull();
    expect(snapshot?.error).toBeUndefined();
  });

  test("direct-parent snapshot consumption suppresses replay of a history-repaired outcome", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_consumed_repair", "assistant", "Consumed repaired result", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Stream error: provider overloaded",
      })
    );

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle", {
      consumingWorkspaceId: parentId,
    });
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_consumed_repair",
      reportMarkdown: "Consumed repaired result",
    });
    expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Consumed repaired result");
    assert(snapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${snapshot.handleId}:${snapshot.status}:${snapshot.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).toBeNull();
  });

  test("direct-parent repair consumption marks a concurrent terminal winner before replay", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const staleRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
    };
    const concurrentWinner: WorkspaceTurnTaskHandleRecord = {
      ...staleRecord,
      status: "completed",
      updatedAt: "2026-06-19T00:00:02.000Z",
      reportMarkdown: "Concurrent corrected result",
      messageId: "msg_concurrent_corrected",
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:02.000Z",
    };
    delete concurrentWinner.directParentResultDeliveredAt;
    delete concurrentWinner.error;
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(concurrentWinner);

    const internal = taskService as unknown as {
      persistRepairedSettledWorkspaceTurn: (
        record: WorkspaceTurnTaskHandleRecord,
        recovered: WorkspaceTurnTaskHandleRecord,
        options: { consumingWorkspaceId?: string }
      ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
    };
    const observed = await internal.persistRepairedSettledWorkspaceTurn(
      staleRecord,
      {
        ...staleRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:03.000Z",
        reportMarkdown: "Losing history repair",
      },
      { consumingWorkspaceId: parentId }
    );
    expect(observed).toMatchObject({
      status: "completed",
      messageId: "msg_concurrent_corrected",
      reportMarkdown: "Concurrent corrected result",
    });
    expect(observed?.directParentResultDeliveredAt).toBeDefined();

    await internal.deliverPersistentChildWorkspaceTurnResult(concurrentWinner, new Set());
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Concurrent corrected result");
    const generationId = `${concurrentWinner.handleId}:${concurrentWinner.status}:${concurrentWinner.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", generationId)
      )
    ).toBeNull();
  });

  test("direct-parent consumption preserves a higher continuation owner's terminal wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["ownerpreservehandle", "ownerpreserveturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-preserve-owner-wake";
    const childTaskId = "child-preserve-owner-wake";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "direct-parent", directParentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: directParentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Owner Wake Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: rootWorkspaceId,
      prompt: "Continue work owned by the root ancestor.",
      title: "Owner Wake Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const taskHandleStore = new TaskHandleStore(config);
    const active = await taskHandleStore.getWorkspaceTurn(rootWorkspaceId, created.data.taskId);
    assert(active, "continuation record must exist");
    const terminal: WorkspaceTurnTaskHandleRecord = {
      ...active,
      status: "completed",
      updatedAt: "2026-08-11T00:00:02.000Z",
      reportMarkdown: "Higher owner result",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:02.000Z",
      directParentResultDeliveredAt: "2026-08-11T00:00:02.500Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminal);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: rootWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: terminal.handleId,
      terminalOutcome: "completed",
    });

    const consumed = await taskService.getWorkspaceTurnSnapshot(
      rootWorkspaceId,
      terminal.handleId,
      {
        consumingWorkspaceId: directParentTaskId,
      }
    );
    expect(consumed?.directParentResultDeliveredAt).toBe("2026-08-11T00:00:02.500Z");
    expect(consumed?.terminalAttentionNotifiedAt).toBeUndefined();
    await taskService.markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: rootWorkspaceId,
      consumingWorkspaceId: directParentTaskId,
      handleId: terminal.handleId,
      updatedAt: terminal.updatedAt,
      status: terminal.status,
    });
    expect(
      await terminalAttentionStore.get(
        rootWorkspaceId,
        TerminalAttentionStore.notificationId("workspace_turn", terminal.handleId)
      )
    ).toMatchObject({ status: "pending" });
  });

  test("getWorkspaceTurnSnapshot revives an interrupted handle while the child retries the same turn", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Workspace turn interrupted after restart",
        terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
      })
    );
    // Delivered tombstone from the stale settlement; revive must clear it so the revived
    // turn's eventual real settlement can enqueue a fresh wake-up.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string; accepted: boolean }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.directParentResultDeliveryRequiredAt).toBeUndefined();
    expect(snapshot?.directParentResultDeliveredAt).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toBeNull();
    // Revival registers as accepted: the revived turn was already admitted once, so peer
    // admission and delegated correlation may treat it as live immediately.
    expect(internal.activeWorkspaceTurnHandleByWorkspaceId.get("childworkspace")).toEqual({
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      accepted: true,
    });
  });

  test("history repair of a stale error handle waits for active child background work", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // The retried turn emitted its correlated final while a descendant task was still
    // running; reporting completed before it finishes would hand the parent an
    // incomplete result that active handles avoid via deferred stream-ends. Instead the
    // handle is revived with the final recorded as deferred, then settles once the
    // blocker is gone.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_blocked_final", "assistant", "Blocked final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );

    const blocked = await workspaceTurnSnapshot(taskService, parentId);
    expect(blocked).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_blocked_final"],
    });
    expect(blocked?.error).toBeUndefined();
    expect(blocked?.reportMarkdown).toBeUndefined();

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "completed",
      messageId: "msg_blocked_final",
      reportMarkdown: "Blocked final text",
    });
  });

  test("turn-end blocker scan keeps a stale handle live between retry streams via child blockers", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // Codex handoff gap: the retried child's stream ended, no auto-retry is pending, but
    // its descendant work is still running. The blocker scan must still treat the turn as
    // live so the parent cannot end its turn during that window.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("turn-end blocker scan revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // The parent turn-end path must treat the stale-but-retrying handle as live work so
    // the parent cannot end its turn while the child is still running.
    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("active-only listWorkspaceTurnTasks revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // task_list defaults to active statuses; the status filter applies AFTER
    // normalization, so the stale-but-retrying handle is revived and reported as
    // running instead of silently disappearing from the active view.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");
    expect(listed.find((record) => record.handleId === "wst_handle")?.status).toBe("running");
  });

  test("queued manual input does not revive a settled workspace turn", async () => {
    // Ordinary queued input is not yet in history, so the newest-correlated-prompt guard
    // cannot see it; the liveness gate must not treat it as a same-turn continuation.
    const hasQueuedMessages = mock((workspaceId: string) => workspaceId === "childworkspace");
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasQueuedMessages,
      hasPendingQueuedOrPreparingTurn,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).not.toContain(
      "wst_handle"
    );
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("a newer unrelated child prompt does not revive a settled workspace turn", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("revive does not clobber a newer same-status settlement written after the stale read", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    // The record currently on disk: a FRESH error settled by the live retry itself.
    const freshError = {
      kind: "workspace_turn" as const,
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error" as const,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:05:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: retry also failed",
    };
    await taskHandleStore.upsertWorkspaceTurn(freshError);
    const internal = taskService as unknown as {
      reviveRetryingWorkspaceTurn: (record: typeof freshError) => Promise<typeof freshError | null>;
    };

    // Reconcile observed an OLDER error record (same status, earlier updatedAt) before the
    // retry failed; the revive must notice the newer settlement and leave it untouched.
    const revived = await internal.reviveRetryingWorkspaceTurn({
      ...freshError,
      updatedAt: "2026-06-19T00:00:01.000Z",
      error: "Stream error: provider overloaded",
    });

    expect(revived).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
  });

  test("history repair scans past newer unrelated prompts to a correlated final message", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    // The turn self-healed and finished, THEN the child received an unrelated manual
    // prompt before the parent ever called task_await.
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_selfhealed_final", "assistant", "Self-healed final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual_later", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed_final",
      reportMarkdown: "Self-healed final text",
    });
    expect(snapshot?.error).toBeUndefined();
  });

  test("waitForWorkspaceTurn foreground waits can be sent to background", async () => {
    const { parentId, taskService, taskHost } = await startWorkspaceTurnForTest();

    const waitResult = taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(1);
    expect(await waitResult).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("waitForWorkspaceTurn backgrounds when tool-end message was already queued", async () => {
    const hasQueuedMessages = mock(() => true);
    const { parentId, taskService, taskHost } = await startWorkspaceTurnForTest({
      hasQueuedMessages,
    });

    const waitError = await taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });
  for (const scenario of [
    {
      name: "workspace-turn stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_1",
        error: "Provider failed",
        errorType: "authentication",
      } satisfies ErrorEvent,
    },
    {
      name: "workspace-turn terminal stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_unknown_error",
        error: "Provider returned no usable result",
        errorType: "unknown",
      } satisfies ErrorEvent,
      clearRegistration: true,
    },
    {
      name: "workspace-turn auto-retryable stream errors without a pending retry mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated_exhausted",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
    },
    // Codex review: unrelated queued manual messages must not keep the handle
    // running for auto-retryable errors — they start a different turn, so the
    // failed turn would never resume. Only an actual pending auto-retry counts.
    {
      name: "workspace-turn auto-retryable stream errors with only queued messages mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated_queued_only",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
      queuedOnly: true,
    },
    {
      name: "workspace-turn exhausted recoverable stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_exhausted_context",
        error: "Context still too large after retry",
        errorType: "context_exceeded",
      } satisfies ErrorEvent,
    },
  ]) {
    test(scenario.name, async () => {
      const hasPendingQueuedOrPreparingTurn = scenario.queuedOnly ? mock(() => true) : undefined;
      const hasPendingAutoRetry = scenario.queuedOnly ? mock(() => false) : undefined;
      const { parentId, taskService } = await startWorkspaceTurnForTest({
        ...(hasPendingQueuedOrPreparingTurn != null ? { hasPendingQueuedOrPreparingTurn } : {}),
        ...(hasPendingAutoRetry != null ? { hasPendingAutoRetry } : {}),
      });
      if (scenario.clearRegistration === true) {
        (
          taskService as unknown as {
            activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown>;
          }
        ).activeWorkspaceTurnHandleByWorkspaceId.clear();
      }

      await taskService.finalizeWorkspaceTurnFromStreamError(scenario.event);

      expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
        status: "error",
        workspaceId: "childworkspace",
        error: scenario.event.error,
      });
    });
  }

  for (const scenario of [
    {
      name: "workspace-turn recoverable stream errors stay running while retry is pending",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_1",
        error: "Context too large",
        errorType: "context_exceeded",
      } satisfies ErrorEvent,
      pending: "queued" as const,
    },
    // Regression: stream_truncated (a transient provider drop) previously fell
    // outside the recoverable allowlist and terminally settled the handle even
    // though the child session had already scheduled an in-session auto-retry,
    // falsely reporting the turn as failed to the parent.
    {
      name: "workspace-turn auto-retryable stream errors stay running while retry is pending",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
      pending: "auto" as const,
    },
  ]) {
    test(scenario.name, async () => {
      let retryDecisionAwaited = false;
      const pending = mock(
        (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
      );
      const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
        retryDecisionAwaited = true;
        return Promise.resolve();
      });
      const { parentId, taskService } = await startWorkspaceTurnForTest({
        ...(scenario.pending === "queued"
          ? { hasPendingQueuedOrPreparingTurn: pending }
          : { hasPendingAutoRetry: pending }),
        waitForPendingStreamErrorRecoveryDecision,
      });

      await taskService.finalizeWorkspaceTurnFromStreamError(scenario.event);

      expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith(
        "childworkspace",
        scenario.event.messageId
      );
      expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
        status: "running",
        workspaceId: "childworkspace",
      });
    });
  }

  test("terminal recovery skips legacy delivery records and contains per-record replay failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-terminal-delivery-recovery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      status: "completed" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Recovered result",
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_legacy_delivery",
      turnId: "legacy-delivery",
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_required_delivery",
      turnId: "required-delivery",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    });
    const internal = taskService as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    // Reject only when recovery invokes the fault, after its asynchronous disk scan.
    const replay = spyOn(
      internal,
      "deliverPersistentChildWorkspaceTurnResult"
    ).mockImplementationOnce(() => Promise.reject(new Error("read-only session")));

    try {
      await internal.recoverTerminalWorkspaceTurnAttentionNotifications();
      expect(replay).toHaveBeenCalledTimes(1);
      expect(replay.mock.calls[0]?.[0].handleId).toBe("wst_required_delivery");
    } finally {
      replay.mockRestore();
    }
  });

  test("terminal recovery contains per-record attention persistence failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    for (const [index, handleId] of ["wst_attention_failure", "wst_attention_success"].entries()) {
      await taskHandleStore.upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, parentId, handleId, "completed", {
          turnId: `attention-recovery-${index}`,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: `2026-08-11T00:00:0${index + 1}.000Z`,
          attentionPolicy: "notify_on_terminal",
          reportMarkdown: `Recovered result ${index}`,
        })
      );
    }
    const internal = taskService as unknown as {
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    const enqueueTerminalAttention = taskHost.enqueueTerminalAttention.bind(taskHost);
    const enqueue = spyOn(taskHost, "enqueueTerminalAttention")
      .mockImplementation(enqueueTerminalAttention)
      .mockImplementationOnce(() => Promise.reject(new Error("read-only attention store")));

    try {
      expect(await internal.recoverTerminalWorkspaceTurnAttentionNotifications()).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      enqueue.mockRestore();
    }
    const records = await taskHandleStore.listWorkspaceTurns(parentId);
    expect(records.filter((record) => record.terminalAttentionNotifiedAt != null)).toHaveLength(1);
  });
});
