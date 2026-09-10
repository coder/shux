import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import { Ok } from "@/common/types/result";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";
import type { Config } from "@/node/config";
import { EventEmitter } from "events";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";
import { askUserQuestionManager } from "./askUserQuestionManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { advanceAnchoredDeadline, HeartbeatService } from "./heartbeatService";
import type { HistoryService } from "./historyService";
import { IdleDispatcher } from "./idleDispatcher";
import type { InitStateManager } from "./initStateManager";
import type { TaskService } from "./taskService";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { WorkspaceService } from "./workspaceService";

async function waitForCondition(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

interface HeartbeatConfigFixture {
  enabled: boolean;
  intervalMs: number;
  message?: string;
  contextMode?: "normal" | "compact" | "reset";
  trigger?: "idle" | "interval";
  whenBusy?: "skip" | "tool-end" | "turn-end";
}

interface HeartbeatServiceInternals {
  startupTimeout: ReturnType<typeof setTimeout> | null;
  checkInterval: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  nextEligibleAtByWorkspaceId: Map<string, number>;
  trackedIntervalMsByWorkspaceId: Map<string, number>;
  activeWorkspaceIds: Set<string>;
  queuedWorkspaceIds: Set<string>;
  isProcessingQueue: boolean;
  tick(): void;
  resyncFromConfig(now: number): Promise<void>;
  checkAllWorkspaces(now: number): void;
  queueWorkspace(workspaceId: string): void;
}

describe("HeartbeatService", () => {
  let mockConfig: Config;
  let currentProjectsConfig: ProjectsConfig;
  let mockExtensionMetadata: ExtensionMetadataService;
  let mockWorkspaceService: WorkspaceService;
  let mockTaskService: TaskService;
  let service: HeartbeatService;
  let wsEmitter: EventEmitter;

  let loadConfigMock: ReturnType<typeof mock<() => ProjectsConfig>>;
  let getSnapshotMock: ReturnType<
    typeof mock<(workspaceId: string) => Promise<WorkspaceActivitySnapshot | null>>
  >;
  let getAllSnapshotsMock: ReturnType<
    typeof mock<() => Promise<Map<string, WorkspaceActivitySnapshot>>>
  >;
  let getChatHistoryMock: ReturnType<typeof mock<(workspaceId: string) => Promise<MuxMessage[]>>>;
  let executeHeartbeatMock: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
  let isBusyForMessageMock: ReturnType<typeof mock<(workspaceId: string) => boolean>>;
  let hasActiveDescendantTasksMock: ReturnType<typeof mock<(workspaceId: string) => boolean>>;

  const testWorkspaceId = "test-ws";
  const workspace2Id = "workspace-2";
  const testProjectPath = "/test/project";
  const defaultHeartbeatIntervalMs = 300_000;
  const staleTimestamp = Date.now() - 600_000;

  function getInternals(): HeartbeatServiceInternals {
    return service as unknown as HeartbeatServiceInternals;
  }

  function makeWorkspaceEntry(
    overrides: Partial<{
      id: string;
      name: string;
      path: string;
      parentWorkspaceId: string;
      // Nullish members mirror the schema type so setIdleHeartbeatWorkspace's
      // NonNullable<Workspace["heartbeat"]> flows through unchanged.
      heartbeat: {
        enabled: boolean;
        intervalMs?: number;
        message?: string;
        contextMode?: "normal" | "compact" | "reset" | null;
        trigger?: "idle" | "interval" | null;
        whenBusy?: "skip" | "tool-end" | "turn-end" | null;
        scheduleUpdatedAt?: number | null;
      };
      archivedAt: string;
      unarchivedAt: string;
    }> = {}
  ): Workspace {
    return {
      id: testWorkspaceId,
      path: "/test/path",
      name: "test",
      heartbeat: { enabled: true, intervalMs: defaultHeartbeatIntervalMs },
      ...overrides,
    } as unknown as Workspace;
  }

  function makeProjectsConfig(workspaces: Workspace[]): ProjectsConfig {
    return {
      projects: new Map<string, ProjectConfig>([
        [testProjectPath, { workspaces } as unknown as ProjectConfig],
      ]),
    };
  }

  function makeSnapshot(
    overrides: Partial<WorkspaceActivitySnapshot> = {}
  ): WorkspaceActivitySnapshot {
    return {
      recency: staleTimestamp,
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      ...overrides,
    };
  }

  function makeSnapshotMap(
    entries: Array<[string, WorkspaceActivitySnapshot]> = []
  ): Map<string, WorkspaceActivitySnapshot> {
    return new Map(entries);
  }

  function makeCompletedTurnHistory(timestamp = staleTimestamp): MuxMessage[] {
    return [
      createMuxMessage("1", "user", "Hello", { timestamp }),
      createMuxMessage("2", "assistant", "Hi!", { timestamp }),
    ];
  }

  function makeInteractiveAssistantMessage(timestamp = staleTimestamp): MuxMessage {
    const assistantMessage = createMuxMessage("2", "assistant", "asking", { timestamp });
    (assistantMessage as unknown as { parts: unknown[] }).parts = [
      { type: "text", text: "Let me ask...", state: "done" },
      {
        type: "dynamic-tool",
        toolName: "ask_user_question",
        state: "input-available",
        toolCallId: "tc1",
        args: {},
        output: undefined,
      },
    ];
    return assistantMessage;
  }

  function makeIdleSessionMock(): ReturnType<typeof mock<() => AgentSession>> {
    return mock(
      () =>
        ({
          isBusy: () => false,
          hasQueuedMessages: () => false,
        }) as unknown as AgentSession
    );
  }

  function createRealWorkspaceServiceWithOverrides(
    overrides: Partial<{
      getChatHistory: typeof getChatHistoryMock;
      getOrCreateSession: ReturnType<typeof mock<() => AgentSession>>;
      sendMessage: ReturnType<typeof mock<WorkspaceService["sendMessage"]>>;
      executeHeartbeat: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
    }> = {}
  ): WorkspaceService {
    const realWorkspaceService = new WorkspaceService(
      mockConfig,
      {} as HistoryService,
      new EventEmitter() as unknown as AIService,
      new EventEmitter() as unknown as InitStateManager,
      mockExtensionMetadata,
      {} as BackgroundProcessManager
    );
    Object.assign(realWorkspaceService, overrides);
    return realWorkspaceService;
  }

  function setIdleHeartbeatWorkspace(
    params: {
      heartbeat?: NonNullable<Workspace["heartbeat"]>;
      globalDefaultPrompt?: string;
      idleDurationMs?: number;
    } = {}
  ): void {
    const heartbeat = params.heartbeat
      ? {
          ...params.heartbeat,
          contextMode: params.heartbeat.contextMode ?? undefined,
        }
      : {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
        };

    currentProjectsConfig = {
      ...makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat,
        }),
      ]),
      ...(params.globalDefaultPrompt != null
        ? { heartbeatDefaultPrompt: params.globalDefaultPrompt }
        : {}),
    };
    getSnapshotMock.mockImplementation(() =>
      Promise.resolve(
        makeSnapshot({
          recency: Date.now() - (params.idleDurationMs ?? 5 * 60_000),
          streaming: false,
        })
      )
    );
  }

  beforeEach(() => {
    currentProjectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);

    loadConfigMock = mock(() => currentProjectsConfig);
    mockConfig = {
      loadConfigOrDefault: loadConfigMock,
      findWorkspace: mock(() => ({ workspacePath: "/test/path", projectPath: testProjectPath })),
    } as unknown as Config;

    wsEmitter = new EventEmitter();
    getChatHistoryMock = mock(() => Promise.resolve(makeCompletedTurnHistory()));
    executeHeartbeatMock = mock(() => Promise.resolve());
    isBusyForMessageMock = mock(() => false);
    mockWorkspaceService = Object.assign(wsEmitter, {
      getChatHistory: getChatHistoryMock,
      executeHeartbeat: executeHeartbeatMock,
      isBusyForMessage: isBusyForMessageMock,
    }) as unknown as WorkspaceService;

    getSnapshotMock = mock(() => Promise.resolve(makeSnapshot()));
    getAllSnapshotsMock = mock(() => Promise.resolve(makeSnapshotMap()));
    mockExtensionMetadata = {
      getSnapshot: getSnapshotMock,
      getAllSnapshots: getAllSnapshotsMock,
    } as unknown as ExtensionMetadataService;

    hasActiveDescendantTasksMock = mock(() => false);
    mockTaskService = {
      hasActiveDescendantAgentTasksForWorkspace: hasActiveDescendantTasksMock,
    } as unknown as TaskService;

    service = new HeartbeatService(
      mockConfig,
      mockExtensionMetadata,
      mockWorkspaceService,
      mockTaskService
    );
  });

  afterEach(() => {
    service.stop();
  });

  describe("checkEligibility", () => {
    const cases: Array<{
      name: string;
      setup?: () => void;
      eligible: boolean;
      reason?: string;
    }> = [
      { name: "valid heartbeat-enabled workspace", eligible: true },
      {
        name: "workspace not found in config",
        setup: () => (currentProjectsConfig = { projects: new Map() }),
        eligible: false,
        reason: "workspace_not_found",
      },
      {
        name: "heartbeat is disabled",
        setup: () =>
          (currentProjectsConfig = makeProjectsConfig([
            makeWorkspaceEntry({
              heartbeat: { enabled: false, intervalMs: defaultHeartbeatIntervalMs },
            }),
          ])),
        eligible: false,
        reason: "heartbeat_disabled",
      },
      {
        name: "workspace is archived",
        setup: () =>
          (currentProjectsConfig = makeProjectsConfig([
            makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
          ])),
        eligible: false,
        reason: "archived",
      },
      {
        name: "workspace is a child",
        setup: () =>
          (currentProjectsConfig = makeProjectsConfig([
            makeWorkspaceEntry({ parentWorkspaceId: "parent-ws" }),
          ])),
        eligible: false,
        reason: "child_workspace",
      },
      {
        name: "workspace is streaming",
        setup: () => getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ streaming: true })),
        eligible: false,
        reason: "currently_streaming",
      },
      {
        name: "active descendant tasks exist",
        setup: () => hasActiveDescendantTasksMock.mockReturnValueOnce(true),
        eligible: false,
        reason: "active_descendant_tasks",
      },
      {
        name: "no completed turn (empty history)",
        setup: () => getChatHistoryMock.mockResolvedValueOnce([]),
        eligible: false,
        reason: "no_completed_turn",
      },
      {
        name: "no assistant message in history",
        setup: () =>
          getChatHistoryMock.mockResolvedValueOnce([
            createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
            createMuxMessage("2", "user", "Still there?", { timestamp: staleTimestamp }),
          ]),
        eligible: false,
        reason: "no_completed_turn",
      },
      {
        name: "last message is from user (awaiting response)",
        setup: () =>
          getChatHistoryMock.mockResolvedValueOnce([
            createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
            createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
            createMuxMessage("3", "user", "Another question?", { timestamp: staleTimestamp }),
          ]),
        eligible: false,
        reason: "awaiting_response",
      },
      {
        name: "last assistant message has interactive tool input",
        setup: () =>
          getChatHistoryMock.mockResolvedValueOnce([
            createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
            makeInteractiveAssistantMessage(),
          ]),
        eligible: false,
        reason: "awaiting_interactive_input",
      },
    ];

    for (const testCase of cases) {
      test(`returns ${testCase.eligible ? "eligible" : "ineligible"} when ${testCase.name}`, async () => {
        testCase.setup?.();

        const result = await service.checkEligibility(testWorkspaceId, Date.now());

        expect(result.eligible).toBe(testCase.eligible);
        expect(result.reason).toBe(testCase.reason);
      });
    }
  });

  describe("checkEligibility with whenBusy queue modes", () => {
    function setHeartbeatConfig(heartbeat: HeartbeatConfigFixture): void {
      currentProjectsConfig = makeProjectsConfig([makeWorkspaceEntry({ heartbeat })]);
    }

    const queueModeHeartbeat = {
      enabled: true,
      intervalMs: defaultHeartbeatIntervalMs,
      whenBusy: "turn-end",
    } as const;

    test("streaming workspace is eligible under a queue mode", async () => {
      setHeartbeatConfig({ ...queueModeHeartbeat });
      getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ streaming: true }));
      // Streaming carve-out: committed history ends with the user message being answered
      // (partials are excluded from committed history), which must not gate queue modes.
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
        createMuxMessage("3", "user", "Keep going", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: true });
    });

    test("active descendant tasks are eligible under a queue mode", async () => {
      setHeartbeatConfig({ ...queueModeHeartbeat });
      hasActiveDescendantTasksMock.mockReturnValueOnce(true);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: true });
    });

    test("interval trigger with unset whenBusy resolves to turn-end and passes busy gates", async () => {
      setHeartbeatConfig({
        enabled: true,
        intervalMs: defaultHeartbeatIntervalMs,
        trigger: "interval",
      });
      getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ streaming: true }));

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: true });
    });

    test("explicit whenBusy skip keeps the streaming gate even for the interval trigger", async () => {
      setHeartbeatConfig({
        enabled: true,
        intervalMs: defaultHeartbeatIntervalMs,
        trigger: "interval",
        whenBusy: "skip",
      });
      getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ streaming: true }));

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: false, reason: "currently_streaming" });
    });

    // Between user-message acceptance and stream-start (turn preparation), the activity
    // snapshot's streaming flag is still false but the session is busy. The trailing user
    // message is being answered, so queue modes must queue the slot instead of consuming it.
    test("a preparing turn (busy session, not yet streaming) is eligible under a queue mode", async () => {
      setHeartbeatConfig({ ...queueModeHeartbeat });
      isBusyForMessageMock.mockReturnValueOnce(true);
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
        createMuxMessage("3", "user", "Keep going", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: true });
    });

    test("a preparing turn still gates skip mode as awaiting_response", async () => {
      setHeartbeatConfig({ enabled: true, intervalMs: defaultHeartbeatIntervalMs });
      isBusyForMessageMock.mockReturnValueOnce(true);
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
        createMuxMessage("3", "user", "Keep going", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: false, reason: "awaiting_response" });
    });

    test("an idle unanswered user message still gates queue modes", async () => {
      setHeartbeatConfig({ ...queueModeHeartbeat });
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
        createMuxMessage("3", "user", "Another question?", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result).toEqual({ eligible: false, reason: "awaiting_response" });
    });

    test("hard gates still block under queue modes", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: { ...queueModeHeartbeat },
          archivedAt: new Date().toISOString(),
        }),
      ]);

      const archived = await service.checkEligibility(testWorkspaceId, Date.now());
      expect(archived).toEqual({ eligible: false, reason: "archived" });

      setHeartbeatConfig({ ...queueModeHeartbeat });
      getChatHistoryMock.mockResolvedValueOnce([]);
      const noTurn = await service.checkEligibility(testWorkspaceId, Date.now());
      expect(noTurn).toEqual({ eligible: false, reason: "no_completed_turn" });

      setHeartbeatConfig({ ...queueModeHeartbeat });
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        makeInteractiveAssistantMessage(),
      ]);
      const interactive = await service.checkEligibility(testWorkspaceId, Date.now());
      expect(interactive).toEqual({ eligible: false, reason: "awaiting_interactive_input" });
    });
  });

  describe("start/stop lifecycle", () => {
    test("starts with correct timer configuration", () => {
      const internals = getInternals();

      expect(internals.stopped).toBe(true);
      expect(wsEmitter.listenerCount("activity")).toBe(0);
      expect(wsEmitter.listenerCount("metadata")).toBe(0);

      service.start();

      expect(internals.stopped).toBe(false);
      expect(internals.startupTimeout).not.toBeNull();
      expect(internals.checkInterval).toBeNull();
      expect(wsEmitter.listenerCount("activity")).toBe(1);
      expect(wsEmitter.listenerCount("metadata")).toBe(1);

      service.stop();

      expect(internals.stopped).toBe(true);
      expect(internals.startupTimeout).toBeNull();
      expect(internals.checkInterval).toBeNull();
      expect(wsEmitter.listenerCount("activity")).toBe(0);
      expect(wsEmitter.listenerCount("metadata")).toBe(0);
    });

    test("stop clears all tracking state", async () => {
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.activeWorkspaceIds.add("active-ws");
      internals.queuedWorkspaceIds.add("queued-ws");
      internals.isProcessingQueue = true;

      expect(internals.nextEligibleAtByWorkspaceId.size).toBe(1);
      expect(internals.activeWorkspaceIds.size).toBe(1);
      expect(internals.queuedWorkspaceIds.size).toBe(1);
      expect(internals.isProcessingQueue).toBe(true);

      service.stop();

      expect(internals.nextEligibleAtByWorkspaceId.size).toBe(0);
      expect(internals.activeWorkspaceIds.size).toBe(0);
      expect(internals.queuedWorkspaceIds.size).toBe(0);
      expect(internals.isProcessingQueue).toBe(false);
    });

    test("stop prevents new scheduling after stop", async () => {
      service.start();
      const internals = getInternals();

      service.stop();
      internals.nextEligibleAtByWorkspaceId.set(testWorkspaceId, 0);
      internals.tick();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(internals.queuedWorkspaceIds.size).toBe(0);
      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });

    test("start failure releases earlier acquisitions and leaves the service restartable", () => {
      const dispatcher = new IdleDispatcher();
      const emitter = new EventEmitter();
      let failListenerRegistration = true;
      const realOn = emitter.on.bind(emitter);
      // Fail only the SECOND listener registration ("metadata") so the test
      // also covers partial-acquisition rollback: the already-registered
      // "activity" listener must be released, not leaked across retries.
      emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
        if (failListenerRegistration && event === "metadata") {
          throw new Error("listener registration failed");
        }
        return realOn(event, listener);
      }) as typeof emitter.on;
      const failingWorkspaceService = Object.assign(emitter, {
        getChatHistory: getChatHistoryMock,
        executeHeartbeat: executeHeartbeatMock,
        isBusyForMessage: isBusyForMessageMock,
      }) as unknown as WorkspaceService;

      const failingService = new HeartbeatService(
        mockConfig,
        mockExtensionMetadata,
        failingWorkspaceService,
        mockTaskService,
        dispatcher
      );

      expect(() => failingService.start()).toThrow();

      // The "activity" listener registered before the failing "metadata"
      // registration must have been rolled back — a leak here would double up
      // event handling after a successful retry.
      expect(emitter.listenerCount("activity")).toBe(0);

      // The idle-consumer registration acquired before the failing step must
      // have been released: re-registering the same consumer name would
      // otherwise trip the dispatcher's duplicate-registration assert.
      const disposeProbe = dispatcher.registerConsumer({
        name: "heartbeat",
        priority: 50,
        buildPayload: () => Promise.resolve(null),
      });
      disposeProbe();

      // The rollback restores the stopped state, so start() succeeds once the
      // failure cause is fixed.
      failListenerRegistration = false;
      failingService.start();
      expect(emitter.listenerCount("activity")).toBe(1);
      failingService.stop();
      expect(emitter.listenerCount("activity")).toBe(0);
    });
  });

  describe("event handling", () => {
    test("activity event resets countdown for tracked workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: false },
      });

      const resetDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(initialDeadline).toBe(defaultHeartbeatIntervalMs);
      expect(resetDeadline).toBeDefined();
      expect(resetDeadline).toBeGreaterThan(initialDeadline!);
    });

    test("activity event does not reset the countdown for interval-triggered workspaces", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: {
            enabled: true,
            intervalMs: defaultHeartbeatIntervalMs,
            trigger: "interval",
          },
        }),
      ]);
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: false },
      });

      // Fixed cadence: activity must not move the wall-clock deadline.
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialDeadline);
    });

    test("activity event ignores streaming=true events", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: true },
      });

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialDeadline);
    });

    test("activity event ignores null activity", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", { workspaceId: testWorkspaceId, activity: null });

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialDeadline);
    });

    test("activity event ignores untracked workspaces", () => {
      service.start();
      const internals = getInternals();

      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: false },
      });

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("metadata event purges deleted workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", { workspaceId: testWorkspaceId, metadata: null });
      internals.checkAllWorkspaces(Number.MAX_SAFE_INTEGER);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });

    for (const testCase of [
      {
        name: "archived workspace",
        metadata: makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
      },
      { name: "child workspace", metadata: makeWorkspaceEntry({ parentWorkspaceId: "parent-ws" }) },
      {
        name: "tracked workspace with an invalid interval",
        metadata: makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: 60_000 } }),
      },
    ]) {
      test(`metadata event purges ${testCase.name}`, async () => {
        service.start();
        const internals = getInternals();
        await internals.resyncFromConfig(0);

        wsEmitter.emit("metadata", { workspaceId: testWorkspaceId, metadata: testCase.metadata });

        expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
      });
    }

    test("metadata event updates the tracked deadline when the interval changes", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const beforeMetadataUpdate = Date.now();
      const updatedIntervalMs = 45 * 60 * 1000;
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: updatedIntervalMs },
        }),
      });

      const updatedDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(updatedDeadline).toBeDefined();
      expect(updatedDeadline).toBeGreaterThanOrEqual(beforeMetadataUpdate + updatedIntervalMs);
    });

    // A trigger-only edit (same intervalMs) must re-anchor: an idle→interval switch that
    // kept the old idle deadline would fire the "fixed" schedule at the stale
    // time-since-activity deadline instead of a fresh cadence from the edit.
    test("metadata event re-anchors the deadline when only the trigger changes", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);
      const idleDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(idleDeadline).toBeDefined();

      const beforeTriggerSwitch = Date.now();
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            trigger: "interval",
          },
        }),
      });

      const reanchoredDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(reanchoredDeadline).toBeDefined();
      expect(reanchoredDeadline).toBeGreaterThanOrEqual(
        beforeTriggerSwitch + HEARTBEAT_DEFAULT_INTERVAL_MS
      );

      // Same settings again: no further deadline churn (change detection still works).
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            trigger: "interval",
          },
        }),
      });
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(reanchoredDeadline);
    });

    test("metadata event re-adds unarchived workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
      });
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);

      const beforeReadd = Date.now();
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS },
          unarchivedAt: new Date().toISOString(),
        }),
      });

      const readdedDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(readdedDeadline).toBeDefined();
      expect(readdedDeadline).toBeGreaterThanOrEqual(beforeReadd + HEARTBEAT_DEFAULT_INTERVAL_MS);
    });
  });

  describe("scheduling and dispatch", () => {
    test("enabled workspace dispatches heartbeat after interval elapses", async () => {
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(defaultHeartbeatIntervalMs + 1);

      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      expect(executeHeartbeatMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("dispatches an eligible heartbeat end-to-end through executeHeartbeat", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      setIdleHeartbeatWorkspace();

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const getOrCreateSessionMock = makeIdleSessionMock();
      const realWorkspaceService = createRealWorkspaceServiceWithOverrides({
        getChatHistory: getChatHistoryMock,
        getOrCreateSession: getOrCreateSessionMock,
        sendMessage: sendMessageMock,
      });
      const executeHeartbeatImpl = realWorkspaceService.executeHeartbeat.bind(realWorkspaceService);
      const executeHeartbeatSpy = mock((workspaceId: string) => executeHeartbeatImpl(workspaceId));
      Object.assign(realWorkspaceService, { executeHeartbeat: executeHeartbeatSpy });

      service = new HeartbeatService(
        mockConfig,
        mockExtensionMetadata,
        realWorkspaceService,
        mockTaskService
      );
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(heartbeatIntervalMs + 1);

      await waitForCondition(() => sendMessageMock.mock.calls.length === 1);

      expect(executeHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(executeHeartbeatSpy).toHaveBeenCalledWith(testWorkspaceId);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // `mock.calls` is typed as `any[][]`; pin it to the real sendMessage signature so
      // these assertions stay type-safe without changing the test behavior.
      interface HeartbeatDisplayStatus {
        message?: string;
      }
      interface HeartbeatSendOptions {
        allowAgentSetGoal?: boolean;
        muxMetadata?: {
          type?: string;
          source?: string;
          displayStatus?: HeartbeatDisplayStatus;
        };
      }
      type HeartbeatDispatchOptions = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      type HeartbeatSendMessageCall = [
        workspaceId: Parameters<WorkspaceService["sendMessage"]>[0],
        heartbeatPrompt: Parameters<WorkspaceService["sendMessage"]>[1],
        sendOptions: HeartbeatSendOptions,
        dispatchOptions: HeartbeatDispatchOptions,
      ];
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | HeartbeatSendMessageCall
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected heartbeat sendMessage to be called exactly once");
      }
      const [workspaceId, heartbeatPrompt, sendOptions, dispatchOptions] = firstSendMessageCall;
      expect(workspaceId).toBe(testWorkspaceId);
      expect(heartbeatPrompt).toContain("[Heartbeat]");
      expect(heartbeatPrompt).toContain("idle for approximately 5 minutes");
      expect(heartbeatPrompt).toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
      expect(sendOptions.allowAgentSetGoal).toBe(true);
      expect(sendOptions.muxMetadata?.type).toBe("heartbeat-request");
      expect(sendOptions.muxMetadata?.source).toBe("heartbeat");
      expect(sendOptions.muxMetadata?.displayStatus?.message).toBe("Heartbeat check...");
      expect(dispatchOptions?.synthetic).toBe(true);
      expect(dispatchOptions?.requireIdle).toBe(true);
      expect(dispatchOptions?.skipAutoResumeReset).toBe(true);
    });

    test("uses the global default heartbeat message when the workspace does not override it", async () => {
      const globalDefaultPrompt =
        "Review the workspace state and suggest the next concrete action.";
      setIdleHeartbeatWorkspace({ globalDefaultPrompt });

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const realWorkspaceService = createRealWorkspaceServiceWithOverrides({
        getOrCreateSession: makeIdleSessionMock(),
        sendMessage: sendMessageMock,
      });

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected heartbeat sendMessage to be called exactly once");
      }
      const [, heartbeatPrompt] = firstSendMessageCall;
      expect(heartbeatPrompt).toContain(globalDefaultPrompt);
      expect(heartbeatPrompt).not.toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
    });

    test("prefers the workspace heartbeat message over the global default", async () => {
      const globalDefaultPrompt =
        "Review the workspace state and suggest the next concrete action.";
      const customMessage = "Re-check open work, refresh stale context, and summarize next steps.";
      setIdleHeartbeatWorkspace({
        globalDefaultPrompt,
        heartbeat: {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
          message: customMessage,
        },
      });

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const realWorkspaceService = createRealWorkspaceServiceWithOverrides({
        getOrCreateSession: makeIdleSessionMock(),
        sendMessage: sendMessageMock,
      });

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected custom heartbeat sendMessage to be called exactly once");
      }
      const [, heartbeatPrompt] = firstSendMessageCall;
      expect(heartbeatPrompt).toContain(customMessage);
      expect(heartbeatPrompt).not.toContain(globalDefaultPrompt);
      expect(heartbeatPrompt).not.toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
    });
    test("dispatches a real compaction request before heartbeat when context mode is compact", async () => {
      setIdleHeartbeatWorkspace({
        heartbeat: {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
          contextMode: "compact",
        },
      });

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const realWorkspaceService = createRealWorkspaceServiceWithOverrides({
        getOrCreateSession: makeIdleSessionMock(),
        sendMessage: sendMessageMock,
      });

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
            {
              muxMetadata?: {
                type?: string;
                parsed?: {
                  followUpContent?: {
                    text?: string;
                    allowAgentSetGoal?: boolean;
                    dispatchOptions?: { requireIdle?: boolean };
                    muxMetadata?: { type?: string };
                  };
                };
                displayStatus?: { message?: string };
              };
            },
            NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>,
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected compact heartbeat sendMessage to be called exactly once");
      }
      const [workspaceId, compactionPrompt, sendOptions, dispatchOptions] = firstSendMessageCall;
      expect(workspaceId).toBe(testWorkspaceId);
      expect(compactionPrompt).toContain("The user wants to continue with: [Heartbeat]");
      expect(sendOptions.muxMetadata?.type).toBe("compaction-request");
      expect(sendOptions.muxMetadata?.displayStatus?.message).toBe(
        "Compacting before heartbeat..."
      );
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.text).toContain("[Heartbeat]");
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.allowAgentSetGoal).toBe(true);
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.dispatchOptions?.requireIdle).toBe(
        true
      );
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.muxMetadata?.type).toBe(
        "heartbeat-request"
      );
      expect(dispatchOptions.synthetic).toBe(true);
      expect(dispatchOptions.requireIdle).toBe(true);
      expect(dispatchOptions.skipAutoResumeReset).toBe(true);
    });

    test("appends a reset boundary before heartbeat when context mode is reset", async () => {
      setIdleHeartbeatWorkspace({
        heartbeat: {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
          contextMode: "reset",
        },
      });

      const appendHeartbeatContextResetBoundary = mock(
        (_params: {
          boundaryText: string;
          pendingFollowUp: {
            text?: string;
            allowAgentSetGoal?: boolean;
            dispatchOptions?: { requireIdle?: boolean };
            muxMetadata?: { type?: string };
          };
        }) => Promise.resolve(Ok({ summaryMessageId: "heartbeat-reset-boundary" }))
      );
      const dispatchPendingCompactionFollowUpIfNeeded = mock(() => Promise.resolve(true));
      const sessionStub = {
        isBusy: () => false,
        hasQueuedMessages: () => false,
        appendHeartbeatContextResetBoundary,
        dispatchPendingCompactionFollowUpIfNeeded,
      };

      const realWorkspaceService = createRealWorkspaceServiceWithOverrides({
        getOrCreateSession: mock(() => sessionStub as unknown as AgentSession),
      });

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(appendHeartbeatContextResetBoundary).toHaveBeenCalledTimes(1);
      const appendCall = appendHeartbeatContextResetBoundary.mock.calls.at(0)?.[0] as
        | {
            boundaryText: string;
            pendingFollowUp: {
              text?: string;
              allowAgentSetGoal?: boolean;
              dispatchOptions?: { requireIdle?: boolean };
              muxMetadata?: { type?: string };
            };
          }
        | undefined;
      expect(appendCall?.boundaryText).toContain("Heartbeat context reset");
      expect(appendCall?.pendingFollowUp.text).toContain("[Heartbeat]");
      expect(appendCall?.pendingFollowUp.allowAgentSetGoal).toBe(true);
      expect(appendCall?.pendingFollowUp.dispatchOptions?.requireIdle).toBe(true);
      expect(appendCall?.pendingFollowUp.muxMetadata?.type).toBe("heartbeat-request");
      expect(dispatchPendingCompactionFollowUpIfNeeded).toHaveBeenCalledTimes(1);
      expect(dispatchPendingCompactionFollowUpIfNeeded).toHaveBeenCalledWith(
        "heartbeat-reset-boundary"
      );
    });

    test("startup does not fire heartbeats immediately", async () => {
      // Default-runner smoke: the scheduler sleeps STARTUP_DELAY_MS on Effect's
      // default (real) clock, so nothing may fire this early. Cadence itself is
      // covered on virtual time in heartbeatService.testClock.test.ts.
      service.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });

    test("concurrency cap of 1", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry(),
        makeWorkspaceEntry({ id: workspace2Id, name: "test-2", path: "/test/path-2" }),
      ]);

      service.start();
      const internals = getInternals();

      let releaseFirstHeartbeat: (() => void) | undefined;
      const firstHeartbeatGate = new Promise<void>((resolve) => {
        releaseFirstHeartbeat = resolve;
      });

      const executionOrder: string[] = [];
      executeHeartbeatMock.mockImplementation(async (workspaceId: string) => {
        executionOrder.push(`start:${workspaceId}`);
        if (workspaceId === testWorkspaceId) {
          await firstHeartbeatGate;
        }
        executionOrder.push(`end:${workspaceId}`);
      });

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(defaultHeartbeatIntervalMs + 1);

      await waitForCondition(() => executionOrder.includes(`start:${testWorkspaceId}`));
      expect(executionOrder).toEqual([`start:${testWorkspaceId}`]);
      expect(internals.activeWorkspaceIds.size).toBe(1);

      releaseFirstHeartbeat?.();
      await waitForCondition(() => executionOrder.includes(`end:${workspace2Id}`));

      expect(executionOrder).toEqual([
        `start:${testWorkspaceId}`,
        `end:${testWorkspaceId}`,
        `start:${workspace2Id}`,
        `end:${workspace2Id}`,
      ]);
    });

    test("queue deduplication", async () => {
      service.start();
      const internals = getInternals();

      let releaseHeartbeat: (() => void) | undefined;
      const heartbeatGate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });

      executeHeartbeatMock.mockImplementation(async () => {
        await heartbeatGate;
      });

      internals.queueWorkspace(testWorkspaceId);
      internals.queueWorkspace(testWorkspaceId);

      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      releaseHeartbeat?.();
      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);

      expect(internals.queuedWorkspaceIds.size).toBe(0);
    });
  });

  describe("interval trigger scheduling", () => {
    const intervalHeartbeat = {
      enabled: true,
      intervalMs: defaultHeartbeatIntervalMs,
      trigger: "interval",
    } as const;

    test("advanceAnchoredDeadline anchors at the fire time and never bursts missed slots", () => {
      // Dispatch shorter than an interval: next deadline is exactly firedAt + interval.
      expect(advanceAnchoredDeadline(1_000, 100, 1_000)).toBe(1_100);
      expect(advanceAnchoredDeadline(1_000, 100, 1_050)).toBe(1_100);
      // Exact boundary: deadline must be strictly in the future.
      expect(advanceAnchoredDeadline(1_000, 100, 1_100)).toBe(1_200);
      // Attempt ran longer than several intervals: skip missed slots, stay aligned.
      expect(advanceAnchoredDeadline(1_000, 100, 1_350)).toBe(1_400);
    });

    test("post-fire deadline is anchored at the fire time, excluding dispatch duration", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { ...intervalHeartbeat } }),
      ]);
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const dispatchDelayMs = 300;
      executeHeartbeatMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, dispatchDelayMs))
      );

      const beforeQueue = Date.now();
      internals.queueWorkspace(testWorkspaceId);

      await waitForCondition(
        () =>
          executeHeartbeatMock.mock.calls.length === 1 &&
          internals.activeWorkspaceIds.size === 0 &&
          (internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId) ?? 0) > beforeQueue
      );

      const deadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)!;
      // Anchored at firedAt (≈ beforeQueue): the idle path would instead land at
      // dispatchEnd + interval, i.e. at least dispatchDelayMs later.
      expect(deadline).toBeGreaterThanOrEqual(beforeQueue + defaultHeartbeatIntervalMs);
      expect(deadline).toBeLessThan(beforeQueue + defaultHeartbeatIntervalMs + dispatchDelayMs);
    });

    test("multiple missed intervals produce exactly one firing, then an aligned future deadline", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { ...intervalHeartbeat } }),
      ]);
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      // Simulate downtime: the tracked deadline is three intervals in the past.
      const now = Date.now();
      internals.nextEligibleAtByWorkspaceId.set(
        testWorkspaceId,
        now - 3 * defaultHeartbeatIntervalMs
      );

      internals.checkAllWorkspaces(now);
      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      await waitForCondition(
        () => (internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId) ?? 0) > now
      );

      // The overdue backlog collapses into that single firing: re-checking now must not
      // queue the workspace again.
      internals.checkAllWorkspaces(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executeHeartbeatMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("executeHeartbeat whenBusy delivery", () => {
    interface HeartbeatQueueSendOptions {
      queueDispatchMode?: "tool-end" | "turn-end";
      muxMetadata?: { type?: string };
    }
    interface HeartbeatQueueDispatchOptions {
      synthetic?: boolean;
      skipAutoResumeReset?: boolean;
      requireIdle?: boolean;
      queueDedupeKey?: string;
      yieldToQueuedMessages?: boolean;
    }
    type HeartbeatQueueSendMessageCall = [
      workspaceId: string,
      heartbeatPrompt: string,
      sendOptions: HeartbeatQueueSendOptions,
      dispatchOptions: HeartbeatQueueDispatchOptions | undefined,
    ];

    function makeSessionStub(
      overrides: Partial<{
        isBusy: boolean;
        hasQueuedMessages: boolean;
        hasQueuedDedupeKey: boolean;
      }> = {}
    ): AgentSession {
      return {
        isBusy: () => overrides.isBusy ?? false,
        hasQueuedMessages: () => overrides.hasQueuedMessages ?? false,
        hasQueuedDedupeKey: () => overrides.hasQueuedDedupeKey ?? false,
      } as unknown as AgentSession;
    }

    function setupExecuteHeartbeat(params: {
      heartbeat: HeartbeatConfigFixture;
      session: AgentSession;
      hasActiveDescendantTasks?: boolean;
    }) {
      setIdleHeartbeatWorkspace({ heartbeat: params.heartbeat });
      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const workspaceService = createRealWorkspaceServiceWithOverrides({
        getOrCreateSession: mock(() => params.session),
        sendMessage: sendMessageMock,
      });
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          hasActiveDescendantAgentTasksForWorkspace: () => params.hasActiveDescendantTasks ?? false,
        })
      );
      return {
        workspaceService,
        sendMessageMock,
        getSendMessageCall: (index: number) =>
          sendMessageMock.mock.calls.at(index) as HeartbeatQueueSendMessageCall | undefined,
      };
    }

    test("busy session with interval trigger queues with turn-end and the scheduled lead-in", async () => {
      const { workspaceService, sendMessageMock, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, trigger: "interval" },
        session: makeSessionStub({ isBusy: true }),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const call = getSendMessageCall(0);
      expect(call).toBeDefined();
      const [, heartbeatPrompt, sendOptions, dispatchOptions] = call!;
      // Interval trigger takes the scheduled lead-in branch, not the idle-duration one.
      expect(heartbeatPrompt).toContain("[Scheduled heartbeat]");
      expect(heartbeatPrompt).not.toContain("idle for approximately");
      expect(sendOptions.queueDispatchMode).toBe("turn-end");
      expect(sendOptions.muxMetadata?.type).toBe("heartbeat-request");
      expect(dispatchOptions?.requireIdle).toBeUndefined();
      expect(dispatchOptions?.queueDedupeKey).toBe("heartbeat-request");
      // A user send racing sendMessage's internal awaits owns the queue slot.
      expect(dispatchOptions?.yieldToQueuedMessages).toBe(true);
      expect(dispatchOptions?.synthetic).toBe(true);
      expect(dispatchOptions?.skipAutoResumeReset).toBe(true);
    });

    test("busy session with explicit tool-end queues at the tool boundary with the idle lead-in", async () => {
      const { sendMessageMock, workspaceService, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, whenBusy: "tool-end" },
        session: makeSessionStub({ isBusy: true }),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, heartbeatPrompt, sendOptions, dispatchOptions] = getSendMessageCall(0)!;
      // Idle trigger keeps the idle-duration lead-in even when busy-queued.
      expect(heartbeatPrompt).toContain("[Heartbeat]");
      expect(heartbeatPrompt).not.toContain("[Scheduled heartbeat]");
      expect(sendOptions.queueDispatchMode).toBe("tool-end");
      expect(dispatchOptions?.requireIdle).toBeUndefined();
    });

    // Merging a heartbeat into queued user input would clobber the queue's send options
    // (MessageQueue dispatches with the latest options), and a heartbeat parked in an idle
    // session's queue deadlocks descendant-task terminal wake-ups — so a non-empty queue
    // always wins the slot.
    test("queued user input skips the firing whether the session is idle or busy", async () => {
      for (const isBusy of [false, true]) {
        const { sendMessageMock, workspaceService } = setupExecuteHeartbeat({
          heartbeat: {
            enabled: true,
            intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
            whenBusy: "turn-end",
          },
          session: makeSessionStub({ isBusy, hasQueuedMessages: true }),
        });

        await workspaceService.executeHeartbeat(testWorkspaceId);

        expect(sendMessageMock).not.toHaveBeenCalled();
      }
    });

    // Active descendant tasks leave the session itself idle: queueing here would deadlock
    // the child's terminal wake (it defers while the owner has queued messages, and an idle
    // queue never drains). Immediate dispatch is safe — the wake defers during the heartbeat
    // turn and delivers right after it.
    test("active descendant tasks while idle dispatch the heartbeat immediately", async () => {
      const { sendMessageMock, workspaceService, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, whenBusy: "turn-end" },
        session: makeSessionStub(),
        hasActiveDescendantTasks: true,
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, , sendOptions, dispatchOptions] = getSendMessageCall(0)!;
      expect(sendOptions.queueDispatchMode).toBe("turn-end");
      expect(dispatchOptions?.requireIdle).toBeUndefined();
      expect(dispatchOptions?.queueDedupeKey).toBe("heartbeat-request");
    });

    test("a pending queued heartbeat coalesces the next busy firing without throwing", async () => {
      // A queued heartbeat is itself a queued message, so the queue-wins rule coalesces it.
      const { sendMessageMock, workspaceService } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, whenBusy: "turn-end" },
        session: makeSessionStub({
          isBusy: true,
          hasQueuedMessages: true,
          hasQueuedDedupeKey: true,
        }),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    test("a pending interactive question quietly skips the busy firing and survives", async () => {
      const { sendMessageMock, workspaceService } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, whenBusy: "turn-end" },
        session: makeSessionStub({ isBusy: true }),
      });

      // A pending ask_user_question only exists mid-stream (the assistant message is still
      // in partial.json), so the committed-history awaiting_interactive_input gate cannot
      // see it — the delivery path must skip on the live manager instead of enqueueing
      // over (or canceling) the user-facing prompt.
      const questionPromise = askUserQuestionManager.registerPending(testWorkspaceId, "tool-q1", [
        {
          question: "Proceed?",
          header: "Next",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
          multiSelect: false,
        },
      ]);
      // Attach handler before cleanup cancel so Bun does not flag an unhandled rejection.
      const settled = questionPromise.catch((error: unknown) => error);

      try {
        await workspaceService.executeHeartbeat(testWorkspaceId);

        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(askUserQuestionManager.getLatestPending(testWorkspaceId)?.toolCallId).toBe(
          "tool-q1"
        );
      } finally {
        askUserQuestionManager.cancel(testWorkspaceId, "tool-q1", "test cleanup");
        await settled;
      }
    });

    test("busy queue delivery downgrades compact contextMode to a normal queued message", async () => {
      const { sendMessageMock, workspaceService, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
          contextMode: "compact",
          whenBusy: "turn-end",
        },
        session: makeSessionStub({ isBusy: true }),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, , sendOptions] = getSendMessageCall(0)!;
      // No compaction request is issued for this firing — plain queued heartbeat instead.
      expect(sendOptions.muxMetadata?.type).toBe("heartbeat-request");
      expect(sendOptions.queueDispatchMode).toBe("turn-end");
    });

    test("idle firing under a queue mode still honors compact contextMode", async () => {
      const { sendMessageMock, workspaceService, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: {
          enabled: true,
          intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
          contextMode: "compact",
          trigger: "interval",
        },
        session: makeSessionStub(),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, , sendOptions, dispatchOptions] = getSendMessageCall(0)!;
      expect(sendOptions.muxMetadata?.type).toBe("compaction-request");
      expect(dispatchOptions?.requireIdle).toBe(true);
    });

    test("idle firing under a queue mode sends without requireIdle so a busy race queues", async () => {
      const { sendMessageMock, workspaceService, getSendMessageCall } = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS, trigger: "interval" },
        session: makeSessionStub(),
      });

      await workspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, , sendOptions, dispatchOptions] = getSendMessageCall(0)!;
      expect(sendOptions.queueDispatchMode).toBe("turn-end");
      expect(dispatchOptions?.requireIdle).toBeUndefined();
      expect(dispatchOptions?.queueDedupeKey).toBe("heartbeat-request");
      expect(dispatchOptions?.yieldToQueuedMessages).toBe(true);
    });

    test("busy session with the default skip policy still throws", async () => {
      const rejectionOf = (attempt: Promise<void>): Promise<unknown> =>
        attempt.then(
          () => {
            throw new Error("Expected skip-policy heartbeat to throw");
          },
          (error: unknown) => error
        );

      const busy = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS },
        session: makeSessionStub({ isBusy: true }),
      });
      const busyError = await rejectionOf(busy.workspaceService.executeHeartbeat(testWorkspaceId));
      expect(busyError).toBeInstanceOf(Error);
      expect((busyError as Error).message).toContain("Workspace is busy");
      expect(busy.sendMessageMock).not.toHaveBeenCalled();

      const queued = setupExecuteHeartbeat({
        heartbeat: { enabled: true, intervalMs: HEARTBEAT_MIN_INTERVAL_MS },
        session: makeSessionStub({ hasQueuedMessages: true }),
      });
      const queuedError = await rejectionOf(
        queued.workspaceService.executeHeartbeat(testWorkspaceId)
      );
      expect(queuedError).toBeInstanceOf(Error);
      expect((queuedError as Error).message).toContain("queued user input");
      expect(queued.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  describe("config resync", () => {
    test("adds newly enabled workspaces on resync when no persisted snapshot exists", async () => {
      currentProjectsConfig = makeProjectsConfig([]);
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);

      currentProjectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        1 + defaultHeartbeatIntervalMs
      );
    });

    test("keeps the tracked deadline when resync sees the same interval", async () => {
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        defaultHeartbeatIntervalMs
      );

      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        defaultHeartbeatIntervalMs
      );
    });

    test("skips invalid intervals without blocking valid workspaces", async () => {
      const internals = getInternals();
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: 60_000 } }),
        makeWorkspaceEntry({
          id: workspace2Id,
          name: "test-2",
          path: "/test/path-2",
          heartbeat: { enabled: true, intervalMs: defaultHeartbeatIntervalMs },
        }),
      ]);

      await internals.resyncFromConfig(0);

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
      expect(internals.nextEligibleAtByWorkspaceId.get(workspace2Id)).toBe(
        defaultHeartbeatIntervalMs
      );
    });

    test("reloads config after awaiting activity snapshots", async () => {
      const internals = getInternals();
      let resolveSnapshots: ((value: Map<string, WorkspaceActivitySnapshot>) => void) | undefined;
      getAllSnapshotsMock.mockImplementationOnce(
        () =>
          new Promise<Map<string, WorkspaceActivitySnapshot>>((resolve) => {
            resolveSnapshots = resolve;
          })
      );

      const resyncPromise = internals.resyncFromConfig(0);
      currentProjectsConfig = makeProjectsConfig([]);
      resolveSnapshots?.(makeSnapshotMap());
      await resyncPromise;

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("rebuilds a restart deadline from persisted activity recency", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 60 * 60 * 1000;
      const recency = now - 30 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(recency + intervalMs);
    });

    // Fixed schedules are activity-independent: a restart must re-anchor them to the last
    // persisted heartbeat firing (the heartbeat-request user message), not to activity
    // recency — otherwise interacting just before a restart delays the fixed cadence.
    test("rebuilds an interval restart deadline from the last persisted firing, not activity", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      const lastFiredAt = now - 10 * 60 * 1000; // next slot: 20 minutes from now
      const recency = now - 60 * 1000; // fresh user interaction just before restart
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs, trigger: "interval" } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );
      getChatHistoryMock.mockResolvedValueOnce([
        ...makeCompletedTurnHistory(),
        createMuxMessage("hb-1", "user", "[Scheduled heartbeat] check in", {
          timestamp: lastFiredAt,
          muxMetadata: { type: "heartbeat-request" },
        }),
        createMuxMessage("hb-1-reply", "assistant", "All good", { timestamp: lastFiredAt + 1 }),
      ]);

      await internals.resyncFromConfig(now);

      // Anchored at the firing, not at recency + interval (which would be ~29 min later).
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        lastFiredAt + intervalMs
      );
    });

    test("an overdue persisted interval firing becomes eligible immediately, without bursts", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      const lastFiredAt = now - 3 * intervalMs; // downtime spanned three slots
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs, trigger: "interval" } }),
      ]);
      getChatHistoryMock.mockResolvedValueOnce([
        ...makeCompletedTurnHistory(),
        createMuxMessage("hb-1", "user", "[Scheduled heartbeat] check in", {
          timestamp: lastFiredAt,
          muxMetadata: { type: "heartbeat-request" },
        }),
      ]);

      await internals.resyncFromConfig(now);

      // One catch-up firing at now — never a backlog of missed slots.
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now);
    });

    test("a queued busy delivery anchors at the persisted fire time, not the row timestamp", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      const firedAt = now - 20 * 60 * 1000; // the 10:00 slot
      const deliveredAt = firedAt + 15 * 60 * 1000; // row written when the busy turn ended
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs, trigger: "interval" } }),
      ]);
      getChatHistoryMock.mockResolvedValueOnce([
        ...makeCompletedTurnHistory(),
        createMuxMessage("hb-1", "user", "[Scheduled heartbeat] check in", {
          timestamp: deliveredAt,
          muxMetadata: { type: "heartbeat-request", firedAt },
        }),
      ]);

      await internals.resyncFromConfig(now);

      // Anchored at the slot's fire time (matching the live advanceAnchoredDeadline
      // anchor), not delivery — which would drift the cadence by 15 minutes.
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(firedAt + intervalMs);
    });

    test("a firing that predates the last cadence edit loses to the edit anchor", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      // Fired long ago under the previous schedule (e.g. the idle trigger), then the user
      // switched to the fixed interval and restarted before the first new-schedule firing.
      const lastFiredAt = now - 2 * 60 * 60 * 1000;
      const scheduleUpdatedAt = now - 5 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs, trigger: "interval", scheduleUpdatedAt },
        }),
      ]);
      getChatHistoryMock.mockResolvedValueOnce([
        ...makeCompletedTurnHistory(),
        createMuxMessage("hb-1", "user", "[Scheduled heartbeat] check in", {
          timestamp: lastFiredAt,
          muxMetadata: { type: "heartbeat-request" },
        }),
      ]);

      await internals.resyncFromConfig(now);

      // Anchored at the edit (matching the live re-anchor), not the pre-edit firing —
      // which would have made the workspace eligible immediately.
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        scheduleUpdatedAt + intervalMs
      );
    });

    test("a firing newer than the last cadence edit keeps the firing anchor", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      const scheduleUpdatedAt = now - 60 * 60 * 1000;
      const lastFiredAt = now - 10 * 60 * 1000; // fired under the current schedule
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs, trigger: "interval", scheduleUpdatedAt },
        }),
      ]);
      getChatHistoryMock.mockResolvedValueOnce([
        ...makeCompletedTurnHistory(),
        createMuxMessage("hb-1", "user", "[Scheduled heartbeat] check in", {
          timestamp: lastFiredAt,
          muxMetadata: { type: "heartbeat-request" },
        }),
      ]);

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        lastFiredAt + intervalMs
      );
    });

    test("interval restart falls back to activity recency when no firing is on record", async () => {
      const internals = getInternals();
      const intervalMs = 30 * 60 * 1000;
      const now = 4 * 60 * 60 * 1000;
      const recency = now - 5 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs, trigger: "interval" } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );
      // makeCompletedTurnHistory has no heartbeat-request message.

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(recency + intervalMs);
    });

    test("makes overdue workspaces eligible on the first post-start check", async () => {
      service.start();
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const recency = now - intervalMs - 60_000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now);
      internals.checkAllWorkspaces(now);
      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      expect(executeHeartbeatMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("ignores persisted recency while the workspace snapshot is still streaming", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const staleRecency = now - intervalMs - 60_000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([
          [testWorkspaceId, makeSnapshot({ recency: staleRecency, streaming: true })],
        ])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now + intervalMs);
    });

    test("falls back to a fresh interval when persisted recency is in the future", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const futureRecency = now + 5 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([
          [testWorkspaceId, makeSnapshot({ recency: futureRecency, streaming: false })],
        ])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now + intervalMs);
    });

    test("updates the tracked deadline when resync sees a new interval", async () => {
      const internals = getInternals();
      const initialIntervalMs = 15 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: initialIntervalMs } }),
      ]);

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialIntervalMs);

      const updatedIntervalMs = 45 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: updatedIntervalMs } }),
      ]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        1 + updatedIntervalMs
      );
    });

    test("uses the global default heartbeat interval when a workspace does not set one", async () => {
      const internals = getInternals();
      const globalDefaultIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      currentProjectsConfig = {
        ...makeProjectsConfig([
          makeWorkspaceEntry({
            heartbeat: { enabled: true },
          }),
        ]),
        heartbeatDefaultIntervalMs: globalDefaultIntervalMs,
      };

      const beforeResync = Date.now();
      await internals.resyncFromConfig(beforeResync);

      expect(internals.trackedIntervalMsByWorkspaceId.get(testWorkspaceId)).toBe(
        globalDefaultIntervalMs
      );
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBeGreaterThanOrEqual(
        beforeResync + globalDefaultIntervalMs
      );
    });

    test("purges removed workspaces on resync", async () => {
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(true);

      currentProjectsConfig = makeProjectsConfig([]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });
  });
});
