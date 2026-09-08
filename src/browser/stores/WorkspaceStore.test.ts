import { EventEmitter } from "node:events";
// This integration regression drives the real server replay into the real renderer store.
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only server fixture, never bundled into the renderer
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
// eslint-disable-next-line local/no-cross-boundary-imports -- exercise the actual IPC replay boundary in this store fixture
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import type { ORPCContext } from "@/node/orpc/context";
import type { TurnCoordinator, OperationId } from "@/node/services/turnCoordinator";
import { Ok } from "@/common/types/result";
import { GlobalWindow } from "happy-dom";
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  spyOn,
  type Mock,
} from "bun:test";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type DisplayedMessage,
} from "@/common/types/message";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { StreamStartEvent, ToolCallStartEvent } from "@/common/types/stream";
import type { WorkspaceActivitySnapshot, WorkspaceChatMessage } from "@/common/orpc/types";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";
import {
  getAutoCompactionThresholdKey,
  getAutoRetryKey,
  getPinnedTodoExpandedKey,
  getStatusStateKey,
} from "@/common/constants/storage";
import type { TodoItem } from "@/common/types/tools";
import { buildStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  findRenderedRefineProposalHash,
  mergeTimelineEvents,
  WorkspaceStore,
} from "./WorkspaceStore";
import { createControllableAsyncIterable } from "@/browser/testUtils";
import type { ResponseCompleteEvent } from "@/browser/utils/messages/responseCompletionMetadata";

interface LoadMoreResponse {
  messages: WorkspaceChatMessage[];
  nextCursor: { beforeHistorySequence: number; beforeMessageId?: string | null } | null;
  hasOlder: boolean;
}

// Mock client
// eslint-disable-next-line require-yield
const mockOnChat = mock(async function* (
  _input?: { workspaceId: string; mode?: unknown },
  options?: { signal?: AbortSignal }
): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
  // Keep the iterator open until the store aborts it (prevents retry-loop noise in tests).
  await waitForAbortSignal(options?.signal);
});

const mockGetSessionUsage = mock((_input: { workspaceId: string }) =>
  Promise.resolve<unknown>(undefined)
);
const mockHistoryLoadMore = mock(
  (): Promise<LoadMoreResponse> =>
    Promise.resolve({
      messages: [],
      nextCursor: null,
      hasOlder: false,
    })
);
const mockActivityList = mock(() =>
  Promise.resolve<Record<string, WorkspaceActivitySnapshot> | null>({})
);

type WorkspaceActivityEvent =
  | {
      type: "activity";
      workspaceId: string;
      activity: WorkspaceActivitySnapshot | null;
    }
  | {
      type: "heartbeat";
    };

// eslint-disable-next-line require-yield
const mockActivitySubscribe = mock(async function* (
  _input?: void,
  options?: { signal?: AbortSignal }
): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
  await waitForAbortSignal(options?.signal);
});

type TerminalActivityEvent =
  | {
      type: "snapshot";
      workspaces: Record<string, { activeCount: number; totalSessions: number }>;
    }
  | {
      type: "update";
      workspaceId: string;
      activity: { activeCount: number; totalSessions: number };
    }
  | {
      type: "heartbeat";
    };

// eslint-disable-next-line require-yield
const mockTerminalActivitySubscribe = mock(async function* (
  _input?: void,
  options?: { signal?: AbortSignal }
): AsyncGenerator<TerminalActivityEvent, void, unknown> {
  await waitForAbortSignal(options?.signal);
});

let providerConfigChanges = createControllableAsyncIterable<void>();
const mockGetProvidersConfig = mock(() => Promise.resolve({}));
const mockResumeStream = mock(() => Promise.resolve({ success: true, data: { started: true } }));
const mockSendMessage = mock(() => Promise.resolve({ success: true, data: undefined }));
const mockOnProvidersConfigChanged = mock((_input?: void, options?: { signal?: AbortSignal }) => {
  const subscription = providerConfigChanges;
  options?.signal?.addEventListener("abort", () => subscription.close(), { once: true });
  return Promise.resolve(subscription.iterable);
});

const mockSetAutoCompactionThreshold = mock(() =>
  Promise.resolve({ success: true, data: undefined })
);
const mockGetStartupAutoRetryModel = mock(() => Promise.resolve({ success: true, data: null }));

const mockClient = {
  workspace: {
    onChat: mockOnChat,
    getSessionUsage: mockGetSessionUsage,
    history: {
      loadMore: mockHistoryLoadMore,
    },
    activity: {
      list: mockActivityList,
      subscribe: mockActivitySubscribe,
    },
    setAutoCompactionThreshold: mockSetAutoCompactionThreshold,
    getStartupAutoRetryModel: mockGetStartupAutoRetryModel,
    resumeStream: mockResumeStream,
    sendMessage: mockSendMessage,
  },
  terminal: {
    activity: {
      subscribe: mockTerminalActivitySubscribe,
    },
  },
  providers: {
    getConfig: mockGetProvidersConfig,
    onConfigChanged: mockOnProvidersConfigChanged,
  },
};

const localStorageBacking = new Map<string, string>();
const mockLocalStorage: Storage = {
  get length() {
    return localStorageBacking.size;
  },
  clear() {
    localStorageBacking.clear();
  },
  getItem(key: string) {
    return localStorageBacking.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(localStorageBacking.keys())[index] ?? null;
  },
  removeItem(key: string) {
    localStorageBacking.delete(key);
  },
  setItem(key: string, value: string) {
    localStorageBacking.set(key, value);
  },
};

type WorkspaceStoreTestWindow = Omit<Window & typeof globalThis, "api"> & {
  api: {
    workspace: {
      onChat: (_workspaceId: unknown, _callback: unknown) => () => void;
    };
  };
};

const originalWindow = global.window;

const mockWindow = new GlobalWindow() as unknown as WorkspaceStoreTestWindow;
Object.defineProperty(mockWindow, "localStorage", {
  configurable: true,
  value: mockLocalStorage,
});
mockWindow.api = {
  workspace: {
    onChat: mock((_workspaceId, _callback) => {
      return () => {
        // cleanup
      };
    }),
  },
};
mockWindow.dispatchEvent = mock();

global.window = mockWindow as Window & typeof globalThis;

afterAll(() => {
  global.window = originalWindow;
});

// Mock queueMicrotask
global.queueMicrotask = (fn) => fn();

/** Build a FrontendWorkspaceMetadata fixture with sensible test defaults. */
function makeWorkspaceMetadata(
  workspaceId: string,
  options: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: options.name ?? `test-branch-${workspaceId}`,
    projectName: options.projectName ?? "test-project",
    projectPath: options.projectPath ?? "/path/to/project",
    namedWorkspacePath: options.namedWorkspacePath ?? "/path/to/workspace",
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeConfig: options.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
  };
}

const TEST_WORKSPACE_OPTIONS: Partial<FrontendWorkspaceMetadata> = {
  name: "test-workspace",
  projectPath: "/test/project",
  namedWorkspacePath: "/test/project/test-workspace",
};

// Helper to create and add a workspace
function createAndAddWorkspace(
  store: WorkspaceStore,
  workspaceId: string,
  options: Partial<FrontendWorkspaceMetadata> = {},
  activate = true
): FrontendWorkspaceMetadata {
  const metadata = makeWorkspaceMetadata(workspaceId, options);
  if (activate) {
    store.setActiveWorkspaceId(workspaceId);
  }
  store.addWorkspace(metadata);
  return metadata;
}

function createHistoryMessageEvent(id: string, historySequence: number): WorkspaceChatMessage {
  return {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: `message-${historySequence}` }],
    metadata: { historySequence, timestamp: historySequence },
  };
}

function createUserMessageEvent(
  id: string,
  text: string,
  historySequence: number,
  timestamp: number,
  requestedModel?: string
): WorkspaceChatMessage {
  return {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: {
      historySequence,
      timestamp,
      ...(requestedModel
        ? {
            muxMetadata: {
              type: "normal",
              requestedModel,
            },
          }
        : {}),
    },
  };
}

async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!signal) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await tick(10);
  }
  return false;
}

/**
 * Sleep helper used to flush microtasks/timers between synchronous test steps.
 * Equivalent to `await new Promise(r => setTimeout(r, ms))` but easier to grep.
 */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sentinel describing how to terminate a generated stream. */
type StreamTerminator =
  | { kind: "stream-end"; messageId: string; model: string }
  | { kind: "stream-abort"; messageId: string };

/**
 * Build the canonical 4-event "todo-write inside a stream" sequence used by
 * pinned-todo tests. Pass a terminator to choose between stream-end / stream-abort.
 */
function pinnedTodoStreamEvents(
  workspaceId: string,
  todos: TodoItem[],
  terminator: StreamTerminator
): WorkspaceChatMessage[] {
  const messageId = terminator.messageId;
  const toolCallId = `${messageId}-todo-write`;
  const events: WorkspaceChatMessage[] = [
    {
      type: "stream-start",
      workspaceId,
      messageId,
      historySequence: 1,
      model: "claude-sonnet-4",
      startTime: 1_000,
    },
    {
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "todo_write",
      args: { todos },
      tokens: 10,
      timestamp: 1_001,
    },
    {
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "todo_write",
      result: { success: true },
      timestamp: 1_002,
    },
  ];

  if (terminator.kind === "stream-end") {
    events.push({
      type: "stream-end",
      workspaceId,
      messageId,
      metadata: {
        model: terminator.model,
        historySequence: 1,
        timestamp: 1_003,
      },
      parts: [],
    });
  } else {
    events.push({
      type: "stream-abort",
      workspaceId,
      messageId,
      abortReason: "user",
      metadata: {},
    });
  }

  return events;
}

/**
 * Wrap {@link mockOnChat} with the recurring "ignore other workspaces" guard:
 * the mock yields the provided events for `targetWorkspaceId` only and stays
 * open until the abort signal fires. The body may be a sync or async generator —
 * sync generators are forwarded via `yield*` from the outer async generator.
 */
function mockChatStreamFor(
  targetWorkspaceId: string,
  body: (
    signal: AbortSignal | undefined
  ) => AsyncIterable<WorkspaceChatMessage> | Iterable<WorkspaceChatMessage>
): void {
  mockOnChat.mockImplementation(async function* (
    input?: { workspaceId: string; mode?: unknown },
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
    if (input?.workspaceId !== targetWorkspaceId) {
      await waitForAbortSignal(options?.signal);
      return;
    }

    yield* body(options?.signal);
    await waitForAbortSignal(options?.signal);
  });
}

type ChatStep = WorkspaceChatMessage | Promise<void> | (() => void | Promise<void>);

type ChatEvent<T extends WorkspaceChatMessage["type"]> = Extract<WorkspaceChatMessage, { type: T }>;

async function runChatStep(step: ChatStep): Promise<WorkspaceChatMessage | undefined> {
  if (typeof step === "function") {
    await step();
    return undefined;
  }
  if (step instanceof Promise) {
    await step;
    return undefined;
  }
  return step;
}

function mockChatScript(steps: ChatStep[], options: { keepOpen?: boolean } = {}): void {
  mockOnChat.mockImplementation(async function* (
    _input?: { workspaceId: string; mode?: unknown },
    signalOptions?: { signal?: AbortSignal }
  ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
    for (const step of steps) {
      const event = await runChatStep(step);
      if (event) {
        yield event;
      }
    }
    if (options.keepOpen ?? false) {
      await waitForAbortSignal(signalOptions?.signal);
    }
  });
}

function mockChatReconnectScript(
  getSteps: (subscriptionCount: number, signal: AbortSignal | undefined) => ChatStep[]
): () => number {
  let subscriptionCount = 0;
  mockOnChat.mockImplementation(async function* (
    _input?: { workspaceId: string; mode?: unknown },
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
    subscriptionCount += 1;
    for (const step of getSteps(subscriptionCount, options?.signal)) {
      const event = await runChatStep(step);
      if (event) {
        yield event;
      }
    }
  });
  return () => subscriptionCount;
}

const caughtUpEvent = (overrides: Partial<ChatEvent<"caught-up">> = {}): WorkspaceChatMessage => ({
  type: "caught-up",
  ...overrides,
});

const sinceCaughtUpEvent = (
  historySequence = 1,
  messageId = `history-${historySequence}`,
  stream?: { messageId: string; lastTimestamp: number }
): WorkspaceChatMessage =>
  caughtUpEvent({
    replay: "since",
    cursor: { history: { messageId, historySequence }, ...(stream ? { stream } : {}) },
  });

// Full replay caught-up carrying a server cursor, as the real server issues on every
// non-empty replay. The client reuses this cursor verbatim, making the next
// subscription a legitimate since request.
const fullCaughtUpEvent = (
  historySequence = 1,
  messageId = `history-${historySequence}`,
  stream?: { messageId: string; lastTimestamp: number }
): WorkspaceChatMessage =>
  caughtUpEvent({
    replay: "full",
    cursor: { history: { messageId, historySequence }, ...(stream ? { stream } : {}) },
  });

const streamEndEvent = (
  workspaceId: string,
  messageId: string,
  overrides: Partial<ChatEvent<"stream-end">> = {}
): WorkspaceChatMessage => ({
  type: "stream-end",
  workspaceId,
  messageId,
  metadata: { model: TEST_MODEL, historySequence: 1, timestamp: 1_001 },
  parts: [],
  ...overrides,
});

const bashOutputEvent = (
  workspaceId: string,
  toolCallId: string,
  text: string,
  overrides: Partial<ChatEvent<"bash-output">> = {}
): WorkspaceChatMessage => ({
  type: "bash-output",
  workspaceId,
  toolCallId,
  text,
  isError: false,
  timestamp: 1,
  ...overrides,
});

const toolCallEndEvent = (
  workspaceId: string,
  toolCallId: string,
  toolName: string,
  result: unknown,
  overrides: Partial<ChatEvent<"tool-call-end">> = {}
): WorkspaceChatMessage => ({
  type: "tool-call-end",
  workspaceId,
  messageId: `m-${toolCallId}`,
  toolCallId,
  toolName,
  result,
  timestamp: 1,
  ...overrides,
});

const advisorPhaseEvent = (
  workspaceId: string,
  toolCallId: string,
  phase: ChatEvent<"advisor-phase">["phase"],
  timestamp: number
): WorkspaceChatMessage => ({ type: "advisor-phase", workspaceId, toolCallId, phase, timestamp });

const advisorOutputEvent = (
  workspaceId: string,
  toolCallId: string,
  text: string,
  timestamp: number
): WorkspaceChatMessage => ({ type: "advisor-output", workspaceId, toolCallId, text, timestamp });

const advisorReasoningOutputEvent = (
  workspaceId: string,
  toolCallId: string,
  text: string,
  timestamp: number
): WorkspaceChatMessage => ({
  type: "advisor-reasoning-output",
  workspaceId,
  toolCallId,
  text,
  timestamp,
});

function createWorkflowRunRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "wfr_live",
    workspaceId: "workspace-1",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: "running",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [
      {
        sequence: 1,
        type: "status",
        at: "2026-05-29T00:00:01.000Z",
        status: "running",
      },
    ],
    steps: [],
    ...overrides,
  };
}

const taskCreatedEvent = (
  workspaceId: string,
  toolCallId: string,
  taskId: string,
  timestamp: number
): WorkspaceChatMessage => ({ type: "task-created", workspaceId, toolCallId, taskId, timestamp });

const workflowRunAttachedEvent = (
  workspaceId: string,
  toolCallId: string,
  runId: string,
  timestamp: number,
  run?: WorkflowRunRecord
): WorkspaceChatMessage => ({
  type: "workflow-run-attached",
  workspaceId,
  toolCallId,
  runId,
  timestamp,
  ...(run != null ? { run } : {}),
});

const TEST_MODEL = "claude-sonnet-4";

function createReleaseGate(): { release: () => void; wait: Promise<void> } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

function createActivitySnapshot(
  recency: number,
  overrides: Partial<WorkspaceActivitySnapshot> = {}
): WorkspaceActivitySnapshot {
  return {
    recency,
    streaming: true,
    lastModel: TEST_MODEL,
    lastThinkingLevel: null,
    ...overrides,
  };
}

function mockBackgroundActivityTransition(
  workspaceId: string,
  initialSnapshot: WorkspaceActivitySnapshot,
  nextSnapshots: WorkspaceActivitySnapshot[]
): () => void {
  const gate = createReleaseGate();
  mockActivityList.mockResolvedValue({ [workspaceId]: initialSnapshot });
  mockActivitySubscribe.mockImplementation(async function* (
    _input?: void,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
    await gate.wait;
    if (options?.signal?.aborted) {
      return;
    }

    for (const activity of nextSnapshots) {
      yield { type: "activity", workspaceId, activity };
    }

    await waitForAbortSignal(options?.signal);
  });
  return gate.release;
}

function streamStartEvent(
  workspaceId: string,
  messageId: string,
  overrides: Partial<StreamStartEvent> = {}
): WorkspaceChatMessage {
  return {
    type: "stream-start",
    workspaceId,
    messageId,
    historySequence: 1,
    model: TEST_MODEL,
    startTime: Date.now(),
    ...overrides,
  };
}

function queuedFollowUpEvent(workspaceId: string, text: string): WorkspaceChatMessage {
  return {
    type: "queued-message-changed",
    workspaceId,
    queuedMessages: [text],
    displayText: text,
  };
}

function compactionRequestEvent(
  id: string,
  followUpContent?: CompactionFollowUpRequest,
  timestamp = Date.now()
): WorkspaceChatMessage {
  return {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: "/compact" }],
    metadata: {
      historySequence: 1,
      timestamp,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {
          model: TEST_MODEL,
          ...(followUpContent ? { followUpContent } : {}),
        },
      },
    },
  };
}

function compactionFollowUp(
  overrides: Partial<CompactionFollowUpRequest> = {}
): CompactionFollowUpRequest {
  return {
    text: "continue after compaction",
    model: TEST_MODEL,
    agentId: "exec",
    ...overrides,
  };
}

/**
 * Cast `store` to expose internal fields a test needs to inspect/mutate.
 * Centralizes the verbose `as unknown as { ... }` pattern.
 */
function getInternal<T>(store: WorkspaceStore): T {
  return store as unknown as T;
}

function seedPinnedTodos(store: WorkspaceStore, workspaceId: string, todos: TodoItem[]): void {
  const aggregator = store.getAggregator(workspaceId);
  if (!aggregator) {
    throw new Error(`Missing aggregator for ${workspaceId}`);
  }

  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId,
    messageId: `${workspaceId}-stream`,
    historySequence: 1,
    model: "claude-sonnet-4",
    startTime: 1_000,
  });
  aggregator.handleToolCallStart({
    type: "tool-call-start",
    workspaceId,
    messageId: `${workspaceId}-stream`,
    toolCallId: `${workspaceId}-todo-write`,
    toolName: "todo_write",
    args: { todos },
    tokens: 10,
    timestamp: 1_001,
  });
  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId,
    messageId: `${workspaceId}-stream`,
    toolCallId: `${workspaceId}-todo-write`,
    toolName: "todo_write",
    result: { success: true },
    timestamp: 1_002,
  });
}

describe("WorkspaceStore", () => {
  let store: WorkspaceStore;
  let mockOnModelUsed: Mock<(model: string) => void>;

  beforeEach(() => {
    mockOnChat.mockClear();
    mockGetSessionUsage.mockClear();
    mockHistoryLoadMore.mockClear();
    mockActivityList.mockClear();
    mockActivitySubscribe.mockClear();
    mockTerminalActivitySubscribe.mockClear();
    mockSetAutoCompactionThreshold.mockClear();
    mockGetStartupAutoRetryModel.mockClear();
    mockGetProvidersConfig.mockClear();
    mockOnProvidersConfigChanged.mockClear();
    mockResumeStream.mockClear();
    mockSendMessage.mockClear();
    providerConfigChanges = createControllableAsyncIterable<void>();
    global.window.localStorage?.clear?.();
    mockHistoryLoadMore.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasOlder: false,
    });
    mockActivityList.mockResolvedValue({});
    mockOnModelUsed = mock(() => undefined);
    store = new WorkspaceStore(mockOnModelUsed);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    store.setClient(mockClient as any);
  });

  const createResponseCompleteSpy = () => mock((_event: ResponseCompleteEvent) => undefined);

  /** Dispose the current store and replace it with a fresh instance (no client attached). */
  const resetStore = () => {
    store.dispose();
    store = new WorkspaceStore(mockOnModelUsed);
  };

  const recreateStore = (onResponseComplete?: ReturnType<typeof createResponseCompleteSpy>) => {
    resetStore();
    if (onResponseComplete) {
      store.setOnResponseComplete(onResponseComplete);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    store.setClient(mockClient as any);
  };

  const expectResponseComplete = (
    onResponseComplete: ReturnType<typeof createResponseCompleteSpy>,
    event: Record<string, unknown>
  ) => {
    expect(onResponseComplete).toHaveBeenCalledTimes(1);
    expect(onResponseComplete).toHaveBeenCalledWith(event);
  };

  afterEach(() => {
    store.dispose();
  });

  it.each([
    ["stream-abort", "full"],
    ["error", "full"],
    ["stream-abort", "since"],
    ["error", "since"],
    ["stream-abort", "live"],
    ["error", "live"],
  ])("keeps the successor streaming after %s during %s replay", async (terminal, mode) => {
    const workspaceId = `replay-successor-${terminal}`;
    const emitter = new EventEmitter();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let messageId = "engine-A";
    const info = () => ({
      messageId,
      model: "anthropic:claude-test",
      historySequence: 1,
      startTime: 1,
      parts: [],
      currentStepStartIndex: 0,
      stepStartIndices: [0],
      toolCompletionTimestamps: new Map<string, number>(),
    });
    const publish = (replay = false) => {
      emitter.emit("stream-start", { ...info(), type: "stream-start", workspaceId, replay });
      emitter.emit("stream-delta", {
        type: "stream-delta",
        workspaceId,
        messageId,
        delta: "successor text",
        timestamp: 30,
        replay,
      });
      emitter.emit("reasoning-delta", {
        type: "reasoning-delta",
        workspaceId,
        messageId,
        delta: "successor reasoning",
        timestamp: 30,
        replay,
      });
      emitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: "tool-B",
        toolName: "bash",
        args: { script: "pwd" },
        tokens: 1,
        timestamp: 31,
        replay,
      });
      emitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: "tool-B",
        toolName: "bash",
        result: "result-B",
        timestamp: 32,
        replay,
      });
    };
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      aiServiceOverrides: {
        isStreaming: () => true,
        getStreamInfo: info,
        replayStream: async () => {
          if (mode === "live") {
            entered.resolve();
            await release.promise;
          }
          publish(true);
        },
      },
      initStateManagerOverrides: { replayInit: () => Promise.resolve() },
    });
    await h.historyService.appendToHistory(workspaceId, createMuxMessage("seed", "user", "seed"));
    const read = h.historyService.readPartial.bind(h.historyService);
    spyOn(h.historyService, "readPartial").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    });
    const coordinator = (h.session as unknown as { coordinator: TurnCoordinator }).coordinator;
    let operation: OperationId | undefined;
    const send = spyOn(h.session, "sendMessage").mockImplementation(() => {
      operation = coordinator.registerOperation(coordinator.turnId);
      messageId = "engine-B";
      publish();
      return Promise.resolve(Ok(undefined));
    });
    const context = {
      workspaceService: { getOrCreateSession: () => h.session },
    } as unknown as ORPCContext;
    const trace: WorkspaceChatMessage[] = [];
    const consumed = Promise.withResolvers<void>();
    mockOnChat.mockImplementation(async function* (_input, options) {
      for await (const event of subscribeWorkspaceChat(
        context,
        {
          workspaceId,
          mode:
            mode === "live"
              ? { type: "live" }
              : mode === "since"
                ? {
                    type: "since",
                    cursor: {
                      history: { messageId: "seed", historySequence: 0 },
                      stream: { messageId: "engine-A", lastTimestamp: 10 },
                    },
                  }
                : undefined,
        },
        options?.signal
      )) {
        trace.push(event);
        yield event;
        if (event.type === "caught-up") consumed.resolve();
      }
    });
    try {
      createAndAddWorkspace(store, workspaceId);
      await entered.promise;
      h.session.queueMessage("queued successor");
      emitter.emit(terminal, {
        type: terminal,
        workspaceId,
        messageId: "engine-A",
        error: "failed A",
        errorType: "unknown",
        abortReason: "user",
        metadata: {},
        parts: [],
      });
      expect(send).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await waitUntil(() => trace.some((event) => event.type === "caught-up"))).toBe(true);
      await consumed.promise;
      const aggregator = store.getAggregator(workspaceId)!;
      expect(store.getWorkspaceState(workspaceId).canInterrupt).toBe(true);
      expect(aggregator.getActiveStreamMessageId()).toBe("engine-B");
      expect(aggregator.getStreamLifecycle()?.phase).toBe("streaming");
      const successor = aggregator.getAllMessages().find((message) => message.id === "engine-B")!;
      expect(
        successor.parts.filter((part) => part.type === "text").map((part) => part.text)
      ).toEqual(["successor text"]);
      expect(
        successor.parts.filter((part) => part.type === "reasoning").map((part) => part.text)
      ).toEqual(["successor reasoning"]);
      expect(successor.parts.filter((part) => part.type === "dynamic-tool")).toHaveLength(1);
      expect(successor.parts.find((part) => part.type === "dynamic-tool")).toMatchObject({
        state: "output-available",
        output: "result-B",
      });
      emitter.emit("stream-delta", {
        type: "stream-delta",
        workspaceId,
        messageId: "engine-B",
        delta: " still live",
        timestamp: 40,
      });
      expect(
        await waitUntil(() =>
          JSON.stringify(aggregator.getDisplayedMessages()).includes("still live")
        )
      ).toBe(true);
    } finally {
      release.resolve();
      store.dispose();
      if (operation) coordinator.finishStartup(operation);
      h.session.clearQueue();
      await h.session.dispose();
      await h.cleanup();
    }
  });

  describe("provider config changes", () => {
    it("clears provider-fixable abandoned retry state without resuming the stream", async () => {
      const workspaceId = "provider-config-clears-authentication";
      mockChatScript(
        [caughtUpEvent(), { type: "auto-retry-abandoned", reason: "authentication" }],
        { keepOpen: true }
      );
      createAndAddWorkspace(store, workspaceId);

      expect(
        await waitUntil(
          () =>
            store.getWorkspaceState(workspaceId).autoRetryStatus?.type === "auto-retry-abandoned"
        )
      ).toBe(true);

      providerConfigChanges.push(undefined);

      expect(
        await waitUntil(() => store.getWorkspaceState(workspaceId).autoRetryStatus === null)
      ).toBe(true);
      expect(mockResumeStream).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("preserves abandoned retry state that provider settings cannot fix", async () => {
      const workspaceId = "provider-config-keeps-context-error";
      mockChatScript(
        [caughtUpEvent(), { type: "auto-retry-abandoned", reason: "context_exceeded" }],
        { keepOpen: true }
      );
      createAndAddWorkspace(store, workspaceId);

      expect(
        await waitUntil(
          () =>
            store.getWorkspaceState(workspaceId).autoRetryStatus?.type === "auto-retry-abandoned"
        )
      ).toBe(true);

      providerConfigChanges.push(undefined);
      await tick();

      expect(store.getWorkspaceState(workspaceId).autoRetryStatus).toEqual({
        type: "auto-retry-abandoned",
        reason: "context_exceeded",
      });
      expect(mockResumeStream).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("pinned todo auto-collapse", () => {
    const pinnedTodos: TodoItem[] = [{ content: "Add tests", status: "in_progress" }];

    it("persists a collapsed panel when an active workspace stream ends with todos", async () => {
      const workspaceId = "pinned-todo-stream-end";
      const pinnedTodoKey = getPinnedTodoExpandedKey(workspaceId);

      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          ...pinnedTodoStreamEvents(workspaceId, pinnedTodos, {
            kind: "stream-end",
            messageId: "stream-end-msg",
            model: TEST_MODEL,
          }),
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId);

      const collapsed = await waitUntil(
        () => localStorageBacking.get(pinnedTodoKey) === JSON.stringify(false)
      );
      expect(collapsed).toBe(true);
    });

    it("persists a collapsed panel when an active workspace stream aborts with todos", async () => {
      const workspaceId = "pinned-todo-stream-abort";
      const pinnedTodoKey = getPinnedTodoExpandedKey(workspaceId);

      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          ...pinnedTodoStreamEvents(workspaceId, pinnedTodos, {
            kind: "stream-abort",
            messageId: "stream-abort-msg",
          }),
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId);

      const collapsed = await waitUntil(
        () => localStorageBacking.get(pinnedTodoKey) === JSON.stringify(false)
      );
      expect(collapsed).toBe(true);
    });

    it("active workspace activity snapshot does not re-collapse after user re-expands", async () => {
      const workspaceId = "active-workspace-pinned-todo-snapshot-race";
      const pinnedTodoKey = getPinnedTodoExpandedKey(workspaceId);
      const initialRecency = new Date("2099-01-10T00:00:00.000Z").getTime();

      let releaseStopSnapshot!: () => void;
      const stopSnapshotReady = new Promise<void>((resolve) => {
        releaseStopSnapshot = resolve;
      });

      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
        await stopSnapshotReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          type: "activity" as const,
          workspaceId,
          activity: {
            recency: initialRecency,
            streaming: true,
            hasTodos: true,
            lastModel: "claude-sonnet-4",
            lastThinkingLevel: null,
          },
        };
        yield {
          type: "activity" as const,
          workspaceId,
          activity: {
            recency: initialRecency + 1,
            streaming: false,
            hasTodos: true,
            lastModel: "claude-sonnet-4",
            lastThinkingLevel: null,
          },
        };

        await waitForAbortSignal(options?.signal);
      });
      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          ...pinnedTodoStreamEvents(workspaceId, pinnedTodos, {
            kind: "stream-end",
            messageId: "stream-end-msg",
            model: TEST_MODEL,
          }),
        ],
        { keepOpen: true }
      );

      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId);

      const collapsed = await waitUntil(
        () => localStorageBacking.get(pinnedTodoKey) === JSON.stringify(false)
      );
      expect(collapsed).toBe(true);

      localStorageBacking.set(pinnedTodoKey, JSON.stringify(true));

      releaseStopSnapshot();

      const processedSnapshot = await waitUntil(
        () => store.getWorkspaceState(workspaceId).recencyTimestamp === initialRecency + 1
      );
      expect(processedSnapshot).toBe(true);
      expect(localStorageBacking.get(pinnedTodoKey)).toBe(JSON.stringify(true));
    });

    it("background stream-stop with hasTodos: true collapses panel even with empty aggregator", async () => {
      const activeWorkspaceId = "active-workspace-pinned-todo";
      const backgroundWorkspaceId = "background-workspace-pinned-todo";
      const pinnedTodoKey = getPinnedTodoExpandedKey(backgroundWorkspaceId);
      const initialRecency = new Date("2024-01-10T00:00:00.000Z").getTime();
      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseBackgroundCompletion!: () => void;
      const backgroundCompletionReady = new Promise<void>((resolve) => {
        releaseBackgroundCompletion = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });
      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
        await backgroundCompletionReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          type: "activity" as const,
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            recency: initialRecency + 1,
            streaming: false,
            hasTodos: true,
          },
        };

        await waitForAbortSignal(options?.signal);
      });

      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);

      releaseBackgroundCompletion();

      const collapsed = await waitUntil(
        () => localStorageBacking.get(pinnedTodoKey) === JSON.stringify(false)
      );
      expect(collapsed).toBe(true);
    });

    it("background stream-stop with hasTodos: false does not collapse panel even with stale aggregator todos", async () => {
      const activeWorkspaceId = "active-workspace-pinned-todo-stale";
      const backgroundWorkspaceId = "background-workspace-pinned-todo-stale";
      const pinnedTodoKey = getPinnedTodoExpandedKey(backgroundWorkspaceId);
      const initialRecency = new Date("2024-01-10T00:00:00.000Z").getTime();
      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseBackgroundCompletion!: () => void;
      const backgroundCompletionReady = new Promise<void>((resolve) => {
        releaseBackgroundCompletion = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });
      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
        await backgroundCompletionReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          type: "activity" as const,
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            recency: initialRecency + 1,
            streaming: false,
            hasTodos: false,
          },
        };

        await waitForAbortSignal(options?.signal);
      });

      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);
      seedPinnedTodos(store, backgroundWorkspaceId, pinnedTodos);

      const appliedInitialSnapshot = await waitUntil(
        () => store.getWorkspaceState(backgroundWorkspaceId).canInterrupt
      );
      expect(appliedInitialSnapshot).toBe(true);

      releaseBackgroundCompletion();

      const processedSnapshot = await waitUntil(
        () => !store.getWorkspaceState(backgroundWorkspaceId).canInterrupt
      );
      expect(processedSnapshot).toBe(true);
      expect(localStorageBacking.has(pinnedTodoKey)).toBe(false);
    });

    it("does not persist a collapsed panel when a stream ends without todos", async () => {
      const workspaceId = "pinned-todo-no-todos";
      const pinnedTodoKey = getPinnedTodoExpandedKey(workspaceId);
      let emittedStreamEnd = false;

      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          streamStartEvent(workspaceId, "stream-no-todos-msg", { startTime: 1_000 }),
          streamEndEvent(workspaceId, "stream-no-todos-msg"),
          () => {
            emittedStreamEnd = true;
          },
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId);

      const processedStreamEnd = await waitUntil(() => emittedStreamEnd);
      expect(processedStreamEnd).toBe(true);
      expect(localStorageBacking.has(pinnedTodoKey)).toBe(false);
    });
  });

  describe("recency calculation for new workspaces", () => {
    it("should calculate recency from createdAt when workspace is added", () => {
      const workspaceId = "test-workspace";
      const createdAt = new Date().toISOString();

      createAndAddWorkspace(store, workspaceId, { name: "test-branch", createdAt }, false);

      // Get state - should have recency based on createdAt
      const state = store.getWorkspaceState(workspaceId);

      // Recency should be based on createdAt, not null or 0
      expect(state.recencyTimestamp).not.toBeNull();
      expect(state.recencyTimestamp).toBe(new Date(createdAt).getTime());

      // Check that workspace appears in recency map with correct timestamp
      const recency = store.getWorkspaceRecency();
      expect(recency[workspaceId]).toBe(new Date(createdAt).getTime());
    });

    it("should maintain createdAt-based recency after CAUGHT_UP with no messages", async () => {
      const workspaceId = "test-workspace-2";
      const createdAt = new Date().toISOString();

      // Setup mock stream
      mockChatScript([{ type: "caught-up" }, tick(10)], { keepOpen: true });

      createAndAddWorkspace(store, workspaceId, { name: "test-branch-2", createdAt });

      // Check initial recency
      const initialState = store.getWorkspaceState(workspaceId);
      expect(initialState.recencyTimestamp).toBe(new Date(createdAt).getTime());

      // Wait for async processing
      await tick(10);

      // Recency should still be based on createdAt
      const stateAfterCaughtUp = store.getWorkspaceState(workspaceId);
      expect(stateAfterCaughtUp.recencyTimestamp).toBe(new Date(createdAt).getTime());
      expect(stateAfterCaughtUp.isHydratingTranscript).toBe(false);

      // Verify recency map
      const recency = store.getWorkspaceRecency();
      expect(recency[workspaceId]).toBe(new Date(createdAt).getTime());
    });
  });

  describe("subscription", () => {
    it("should call listener when workspace state changes", async () => {
      const listener = mock(() => undefined);
      const unsubscribe = store.subscribe(listener);

      // Setup mock stream
      mockChatScript([Promise.resolve(), { type: "caught-up" }]);

      // Add workspace (should trigger IPC subscription)
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS);

      // Wait for async processing
      await tick(10);

      expect(listener).toHaveBeenCalled();

      unsubscribe();
    });

    it("should allow unsubscribe", async () => {
      const listener = mock(() => undefined);
      const unsubscribe = store.subscribe(listener);

      // Setup mock stream
      mockChatScript([Promise.resolve(), { type: "caught-up" }]);

      // Unsubscribe before adding workspace (which triggers updates)
      unsubscribe();
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS);

      // Wait for async processing
      await tick(10);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("active workspace subscriptions", () => {
    it("does not start onChat until workspace becomes active", async () => {
      const workspaceId = "inactive-workspace";
      createAndAddWorkspace(store, workspaceId, {}, false);

      await tick(0);
      expect(mockOnChat).not.toHaveBeenCalled();

      store.setActiveWorkspaceId(workspaceId);
      await tick(0);

      expect(mockOnChat).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId }),
        expect.anything()
      );
    });
    it("keeps transcript hydration active across full replay resets", async () => {
      const workspaceId = "workspace-full-replay-hydration";

      mockChatScript(
        [
          // Full replay path emits history rows before the caught-up marker.
          createHistoryMessageEvent("history-before-caught-up", 11),
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId, {}, false);
      store.setActiveWorkspaceId(workspaceId);

      await tick(10);

      // Hydration should stay active until an authoritative caught-up marker arrives,
      // even if replay reset rebuilt transient state.
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(true);
    });

    it.each([
      ["end", false],
      ["end", true],
      ["error", false],
      ["error", true],
      ["client reconnect", false],
      ["client reconnect", true],
    ] as const)(
      "keeps hydration active through %s backoff with cached history %s",
      async (termination, cached) => {
        const workspaceId = "workspace-retry-hydration";
        const client = getInternal<{ client: Parameters<WorkspaceStore["setClient"]>[0] }>(
          store
        ).client;
        const attempts = Array.from({ length: 3 }, () =>
          createControllableAsyncIterable<WorkspaceChatMessage>()
        );
        let subscriptions = 0;
        mockOnChat.mockImplementation(async function* (_input, options) {
          const events = attempts[subscriptions++];
          options?.signal?.addEventListener("abort", () => events.close(), { once: true });
          yield* events.iterable;
          if (termination === "error" && !options?.signal?.aborted) {
            throw new Error("onChat transport failed");
          }
        });
        createAndAddWorkspace(store, workspaceId);
        expect(await waitUntil(() => subscriptions === 1)).toBe(true);
        if (cached) {
          attempts[0].push(createHistoryMessageEvent("history-1", 1));
          attempts[0].push(fullCaughtUpEvent());
          expect(
            await waitUntil(() => store.getWorkspaceState(workspaceId).isTranscriptCaughtUp)
          ).toBe(true);
        }
        const cachedMessages = store.getWorkspaceState(workspaceId).messages;
        expect(cachedMessages).toHaveLength(cached ? 1 : 0);
        const observed: Array<{ isHydratingTranscript: boolean; canInterrupt: boolean }> = [];
        const unsubscribe = store.subscribeKey(workspaceId, () => {
          const { isHydratingTranscript, canInterrupt } = store.getWorkspaceState(workspaceId);
          observed.push({ isHydratingTranscript, canInterrupt });
        });

        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            attempts[attempt].push({
              type: "stream-start",
              workspaceId,
              messageId: "buffered-stream",
              model: "openai:gpt-4o-mini",
              historySequence: 2,
              startTime: 1_000,
            });
            expect(await waitUntil(() => store.getWorkspaceState(workspaceId).canInterrupt)).toBe(
              true
            );
          }
          const previousUpdates = observed.length;
          if (termination === "client reconnect") store.setClient(null);
          else attempts[attempt].close();
          expect(await waitUntil(() => observed.length > previousUpdates)).toBe(true);
          expect(subscriptions).toBe(attempt + 1);
          expect(observed.every((state) => state.isHydratingTranscript)).toBe(true);
          expect(observed.at(-1)?.canInterrupt).toBe(false);
          if (termination === "client reconnect") store.setClient(client);
          expect(await waitUntil(() => subscriptions === attempt + 2)).toBe(true);
          const replayState = store.getWorkspaceState(workspaceId);
          expect(replayState.isHydratingTranscript).toBe(true);
          expect(replayState.isTranscriptCaughtUp).toBe(false);
          expect(replayState.messages).toEqual(cachedMessages);
        }
        unsubscribe();

        if (cached) attempts[2].push(createHistoryMessageEvent("history-1", 1));
        attempts[2].push(cached ? sinceCaughtUpEvent() : fullCaughtUpEvent());
        expect(
          await waitUntil(() => store.getWorkspaceState(workspaceId).isTranscriptCaughtUp)
        ).toBe(true);
        expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
        expect(store.getWorkspaceState(workspaceId).messages).toEqual(cachedMessages);
        mockChatScript([], { keepOpen: true });
      }
    );

    it("waits for a client before hydration and clears it on deactivation during backoff", async () => {
      const client = getInternal<{ client: Parameters<WorkspaceStore["setClient"]>[0] }>(
        store
      ).client;
      store.setClient(null);
      const workspaceId = "workspace-pending-client";
      createAndAddWorkspace(store, workspaceId);
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
      const events = createControllableAsyncIterable<WorkspaceChatMessage>();
      mockOnChat.mockImplementation(async function* () {
        yield* events.iterable;
      });
      store.setClient(client);
      expect(await waitUntil(() => mockOnChat.mock.calls.length > 0)).toBe(true);
      const updates: boolean[] = [];
      const unsubscribe = store.subscribeKey(workspaceId, () => {
        updates.push(store.getWorkspaceState(workspaceId).isHydratingTranscript);
      });
      events.close();
      expect(await waitUntil(() => updates.length > 0)).toBe(true);
      expect(updates.every(Boolean)).toBe(true);
      store.setActiveWorkspaceId(null);
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
      unsubscribe();
      mockChatScript([], { keepOpen: true });
    });

    it("preserves optimistic startup across full replay resets", () => {
      const workspaceId = "workspace-full-replay-pending-start";
      const requestedModel = "openai:gpt-4o-mini";
      const internalStore = getInternal<{
        resetChatStateForReplay: (workspaceId: string) => void;
      }>(store);

      createAndAddWorkspace(store, workspaceId);
      store.markPendingInitialSend(workspaceId, requestedModel);

      internalStore.resetChatStateForReplay(workspaceId);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.isStreamStarting).toBe(true);
      expect(state.pendingStreamModel).toBe(requestedModel);
    });
  });

  it("tracks which workspace currently has the active onChat subscription", async () => {
    createAndAddWorkspace(store, "workspace-1", {}, false);
    createAndAddWorkspace(store, "workspace-2", {}, false);

    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);

    store.setActiveWorkspaceId("workspace-1");
    await tick(0);
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(true);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);

    store.setActiveWorkspaceId("workspace-2");
    await tick(0);
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(true);

    store.setActiveWorkspaceId(null);
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);
  });

  describe("live usage identity pinning", () => {
    it("prices live Coder usage via the stream's pinned metadataModel", async () => {
      const workspaceId = "live-coder-usage-pinned";
      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const aggregator = store.getAggregator(workspaceId);
      if (!aggregator) {
        throw new Error(`Missing aggregator for ${workspaceId}`);
      }
      // The store's providers config knows nothing about this Coder instance
      // (removed/retagged mid-stream): live re-resolution would leave the raw
      // coder ID unpriced, so pricing and identity must come from the
      // backend-stamped metadataModel on stream-start.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: "msg-live-coder",
        historySequence: 1,
        model: "coder:prod-anthropic/claude-sonnet-4-20250514",
        metadataModel: "anthropic:claude-sonnet-4-20250514",
        startTime: 1_000,
      });
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId,
        messageId: "msg-live-coder",
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      });

      // Direct aggregator seeding bypasses the chat-event path, so invalidate
      // the cached usage snapshot before reading.
      getInternal<{ usageStore: { bump: (id: string) => void } }>(store).usageStore.bump(
        workspaceId
      );

      const usage = store.getWorkspaceUsage(workspaceId);
      expect(usage.liveMetadataModel).toBe("anthropic:claude-sonnet-4-20250514");
      expect(usage.liveCostUsage?.input.cost_usd).toBeGreaterThan(0);
    });
  });

  describe("session usage refresh on activation", () => {
    it("re-fetches persisted session usage when switching to an inactive workspace", async () => {
      const sessionUsageData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 1000, cost_usd: 0.003 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 100, cost_usd: 0.0015 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      mockGetSessionUsage.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "workspace-2") {
          return Promise.resolve(sessionUsageData);
        }
        return Promise.resolve(undefined);
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      createAndAddWorkspace(store, "workspace-2", {}, false);

      store.setActiveWorkspaceId("workspace-1");
      await tick(10);

      // Clear call history to isolate the activation fetch.
      mockGetSessionUsage.mockClear();

      store.setActiveWorkspaceId("workspace-2");
      await tick(10);

      // Activation should trigger a fresh fetch for workspace-2.
      expect(mockGetSessionUsage).toHaveBeenCalledWith({ workspaceId: "workspace-2" });

      const usage = store.getWorkspaceUsage("workspace-2");
      expect(usage.sessionTotal).toBeDefined();
      expect(usage.sessionTotal!.input.tokens).toBe(1000);
    });

    it("ignores stale session-usage fetch when a newer refresh supersedes it", async () => {
      let resolveFirst!: (value: unknown) => void;
      const firstFetch = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const freshData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 9999, cost_usd: 0.03 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 500, cost_usd: 0.0075 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      const staleData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 1, cost_usd: 0.000003 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 1, cost_usd: 0.0000015 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      let callCount = 0;
      mockGetSessionUsage.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First two calls (addWorkspace + first activation) are slow responses.
          return firstFetch;
        }
        // Third call (second activation) resolves immediately with fresh data.
        return Promise.resolve(freshData);
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      store.setActiveWorkspaceId("workspace-1");
      await tick(10);

      // Trigger a second activation (rapid switch away and back).
      store.setActiveWorkspaceId(null);
      store.setActiveWorkspaceId("workspace-1");
      await tick(10);

      // Now resolve the stale first fetch.
      resolveFirst(staleData);
      await tick(10);

      // The stale response should be ignored; fresh data should win.
      const usage = store.getWorkspaceUsage("workspace-1");
      expect(usage.sessionTotal).toBeDefined();
      expect(usage.sessionTotal!.input.tokens).toBe(9999);
    });
  });

  describe("syncWorkspaces", () => {
    it("should add new workspaces", async () => {
      const metadata1 = makeWorkspaceMetadata("workspace-1", {
        name: "workspace-1",
        projectName: "project-1",
        projectPath: "/project-1",
        namedWorkspacePath: "/path/1",
      });

      const workspaceMap = new Map([[metadata1.id, metadata1]]);
      store.setActiveWorkspaceId(metadata1.id);
      store.syncWorkspaces(workspaceMap);

      // addWorkspace triggers async onChat subscription setup; wait until the
      // subscription attempt runs so startup threshold sync RPCs do not race this assertion.
      const deadline = Date.now() + 1_000;
      while (mockOnChat.mock.calls.length === 0 && Date.now() < deadline) {
        await tick(10);
      }

      expect(mockOnChat).toHaveBeenCalledWith({ workspaceId: "workspace-1" }, expect.anything());
    });

    it("sanitizes malformed startup threshold values before backend sync", async () => {
      const workspaceId = "workspace-threshold-sanitize";
      const thresholdKey = getAutoCompactionThresholdKey("default");
      global.window.localStorage.setItem(thresholdKey, JSON.stringify("not-a-number"));

      createAndAddWorkspace(store, workspaceId);

      const deadline = Date.now() + 1_000;
      while (mockSetAutoCompactionThreshold.mock.calls.length === 0 && Date.now() < deadline) {
        await tick(10);
      }

      expect(mockSetAutoCompactionThreshold).toHaveBeenCalledWith({
        workspaceId,
        threshold: DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT / 100,
      });

      expect(global.window.localStorage.getItem(thresholdKey)).toBe(
        JSON.stringify(DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT)
      );
    });

    it("sanitizes malformed legacy auto-retry values before subscribing", async () => {
      const workspaceId = "workspace-auto-retry-sanitize";
      const autoRetryKey = getAutoRetryKey(workspaceId);
      global.window.localStorage.setItem(autoRetryKey, JSON.stringify("invalid-legacy-value"));

      createAndAddWorkspace(store, workspaceId);

      const deadline = Date.now() + 1_000;
      while (mockOnChat.mock.calls.length === 0 && Date.now() < deadline) {
        await tick(10);
      }

      expect(mockOnChat.mock.calls.length).toBeGreaterThan(0);
      const onChatInput = mockOnChat.mock.calls[0]?.[0] as {
        workspaceId?: string;
        legacyAutoRetryEnabled?: unknown;
      };

      expect(onChatInput.workspaceId).toBe(workspaceId);
      expect("legacyAutoRetryEnabled" in onChatInput).toBe(false);
      expect(global.window.localStorage.getItem(autoRetryKey)).toBeNull();
    });

    it("refreshes metadata for existing workspaces", () => {
      const metadata = makeWorkspaceMetadata("workspace-1");
      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      expect(store.getWorkspaceMetadata("workspace-1")?.pinnedAt).toBeUndefined();

      // Same workspace id, updated field (e.g. pinned after initial load).
      // Imperative readers like the pin keybind must see the fresh value.
      const pinned = { ...metadata, pinnedAt: "2026-01-01T00:00:00.000Z" };
      store.syncWorkspaces(new Map([[pinned.id, pinned]]));

      expect(store.getWorkspaceMetadata("workspace-1")?.pinnedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should remove deleted workspaces", () => {
      createAndAddWorkspace(
        store,
        "workspace-1",
        {
          name: "workspace-1",
          projectName: "project-1",
          projectPath: "/project-1",
          namedWorkspacePath: "/path/1",
        },
        false
      );

      // Sync with empty map (removes all workspaces)
      store.syncWorkspaces(new Map());

      // Should verify that the controller was aborted, but since we mock the implementation
      // we just check that the workspace was removed from internal state
      expect(store.getAggregator("workspace-1")).toBeUndefined();
    });
  });

  describe("getWorkspaceState", () => {
    it("should return initial state for newly added workspace", () => {
      createAndAddWorkspace(store, "new-workspace");
      const state = store.getWorkspaceState("new-workspace");

      expect(state).toMatchObject({
        messages: [],
        canInterrupt: false,
        isCompacting: false,
        loading: true, // loading because not caught up
        isHydratingTranscript: true,
        muxMessages: [],
        currentModel: null,
      });
      // Should have recency based on createdAt
      expect(state.recencyTimestamp).not.toBeNull();
    });

    it("should return cached state when values unchanged", () => {
      createAndAddWorkspace(store, "test-workspace");
      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");

      // Note: Currently the cache doesn't work because aggregator.getDisplayedMessages()
      // creates new arrays. This is acceptable for Phase 1 - React will still do
      // Object.is() comparison and skip re-renders for primitive values.
      // TODO: Optimize aggregator caching in Phase 2
      expect(state1).toEqual(state2);
      expect(state1.canInterrupt).toBe(state2.canInterrupt);
      expect(state1.loading).toBe(state2.loading);
    });
  });

  describe("stream starting state", () => {
    it("clears stale starting state when background workspace stops streaming", async () => {
      const activeWorkspaceId = "active-workspace-starting-state";
      const backgroundWorkspaceId = "background-workspace-starting-state";
      const streamingRecency = new Date("2024-01-11T00:00:00.000Z").getTime();
      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: streamingRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseStopSnapshot!: () => void;
      const stopSnapshotReady = new Promise<void>((resolve) => {
        releaseStopSnapshot = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });
      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
        await stopSnapshotReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          type: "activity" as const,
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            recency: streamingRecency + 1,
            streaming: false,
          },
        };

        await waitForAbortSignal(options?.signal);
      });
      mockChatStreamFor(backgroundWorkspaceId, async function* () {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield createUserMessageEvent("pending-start-message", "hello", 1, streamingRecency);
      });

      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, backgroundWorkspaceId);

      const sawStarting = await waitUntil(
        () => store.getWorkspaceState(backgroundWorkspaceId).isStreamStarting
      );
      expect(sawStarting).toBe(true);
      expect(store.getWorkspaceSidebarState(backgroundWorkspaceId).isStarting).toBe(true);

      createAndAddWorkspace(store, activeWorkspaceId);
      releaseStopSnapshot();

      const clearedStarting = await waitUntil(() => {
        const state = store.getWorkspaceState(backgroundWorkspaceId);
        const sidebarState = store.getWorkspaceSidebarState(backgroundWorkspaceId);
        return (
          state.pendingStreamStartTime === null &&
          state.isStreamStarting === false &&
          sidebarState.isStarting === false
        );
      });
      expect(clearedStarting).toBe(true);
    });

    it("clears stale starting state on reconnect when server has no active stream", async () => {
      const workspaceId = "stream-starting-reconnect-workspace";
      const otherWorkspaceId = "stream-starting-other-workspace";
      let subscriptionCount = 0;

      mockChatStreamFor(workspaceId, async function* () {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          // Server issues a reconnect cursor on every caught-up; the client reuses
          // it verbatim, so the second subscription legitimately requests since.
          yield {
            type: "caught-up",
            cursor: {
              history: {
                messageId: "reconnect-pending-start",
                historySequence: 1,
              },
            },
          };
          await Promise.resolve();
          yield createUserMessageEvent("reconnect-pending-start", "hello", 1, 1_000);
          return;
        }

        // Since replay re-sends the cursor-boundary row before caught-up.
        yield createUserMessageEvent("reconnect-pending-start", "hello", 1, 1_000);
        yield {
          type: "caught-up",
          replay: "since",
          cursor: {
            history: {
              messageId: "reconnect-pending-start",
              historySequence: 1,
            },
          },
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const sawStarting = await waitUntil(
        () => store.getWorkspaceState(workspaceId).isStreamStarting
      );
      expect(sawStarting).toBe(true);

      createAndAddWorkspace(store, otherWorkspaceId);
      store.setActiveWorkspaceId(workspaceId);

      const clearedStarting = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return subscriptionCount >= 2 && state.pendingStreamStartTime === null;
      });
      expect(clearedStarting).toBe(true);
      expect(store.getWorkspaceState(workspaceId).isStreamStarting).toBe(false);
    });

    it("stays in starting state when a streaming lifecycle event lands before the stream is interruptible", async () => {
      const workspaceId = "stream-starting-lifecycle-gap";

      mockChatStreamFor(workspaceId, async function* () {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield createUserMessageEvent("lifecycle-gap-user", "hello", 1, 1_000);
        await Promise.resolve();
        yield {
          type: "stream-lifecycle",
          workspaceId,
          phase: "streaming",
          hadAnyOutput: false,
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const reachedGap = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.pendingStreamStartTime !== null &&
          !state.canInterrupt &&
          store.getAggregator(workspaceId)?.getStreamLifecycle()?.phase === "streaming"
        );
      });
      expect(reachedGap).toBe(true);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.canInterrupt).toBe(false);
      expect(state.isStreamStarting).toBe(true);
    });

    it("clears optimistic starting state on pre-stream abort", async () => {
      const workspaceId = "optimistic-pending-start-stream-abort";
      const requestedModel = "openai:gpt-4o-mini";
      let releaseAbort!: () => void;
      const abortReady = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });

      mockChatStreamFor(workspaceId, async function* () {
        yield { type: "caught-up", replay: "full" };
        await abortReady;
        yield {
          type: "stream-abort",
          workspaceId,
          messageId: "optimistic-pending-start-stream-abort-msg",
          abortReason: "user",
          metadata: {},
        };
      });

      createAndAddWorkspace(store, workspaceId);
      store.markPendingInitialSend(workspaceId, requestedModel);

      const sawStarting = await waitUntil(
        () => store.getWorkspaceState(workspaceId).isStreamStarting
      );
      expect(sawStarting).toBe(true);

      releaseAbort();

      const clearedStarting = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return state.isStreamStarting === false;
      });
      expect(clearedStarting).toBe(true);
    });

    it("clears optimistic starting state after a second authoritative idle catch-up", async () => {
      const workspaceId = "optimistic-pending-start-idle-catch-up";
      const otherWorkspaceId = "optimistic-pending-start-idle-catch-up-other";
      const requestedModel = "openai:gpt-4o-mini";
      let subscriptionCount = 0;

      // Empty-history caught-ups carry no cursor, so every resubscribe legitimately
      // requests (and receives) a full replay; the server never reports since for a
      // full request.
      mockChatStreamFor(workspaceId, function* () {
        subscriptionCount += 1;
        yield {
          type: "caught-up",
          replay: "full",
        };
      });

      createAndAddWorkspace(store, workspaceId);
      store.markPendingInitialSend(workspaceId, requestedModel);

      const keptStartingThroughFirstIdleCatchUp = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return subscriptionCount >= 1 && state.isStreamStarting === true;
      });
      expect(keptStartingThroughFirstIdleCatchUp).toBe(true);

      createAndAddWorkspace(store, otherWorkspaceId);
      store.setActiveWorkspaceId(workspaceId);

      const clearedStartingAfterSecondIdleCatchUp = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return subscriptionCount >= 2 && state.pendingStreamStartTime === null;
      });
      expect(clearedStartingAfterSecondIdleCatchUp).toBe(true);
      expect(store.getWorkspaceState(workspaceId).isStreamStarting).toBe(false);
    });

    it("ignores non-streaming activity snapshots while optimistic start awaits replay", async () => {
      const workspaceId = "optimistic-pending-start-activity-list";
      const requestedModel = "openai:gpt-4o-mini";
      let releaseCaughtUp!: () => void;
      const caughtUpReady = new Promise<void>((resolve) => {
        releaseCaughtUp = resolve;
      });

      mockActivityList.mockResolvedValue({
        [workspaceId]: {
          recency: 3_000,
          streaming: false,
          lastModel: requestedModel,
          lastThinkingLevel: null,
        },
      });
      recreateStore();
      mockChatStreamFor(workspaceId, async function* () {
        await caughtUpReady;
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);
      store.markPendingInitialSend(workspaceId, requestedModel);

      const keptStartingBeforeReplay = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return state.loading === true && state.isStreamStarting === true;
      });
      expect(keptStartingBeforeReplay).toBe(true);

      releaseCaughtUp();
    });

    it("surfaces buffered stream-start state before caught-up during hydration", async () => {
      const workspaceId = "buffered-stream-start-before-caught-up";
      const streamModel = "anthropic:claude-opus-4-6";
      const thinkingLevel = "high";
      let releaseCaughtUp!: () => void;
      const caughtUpReady = new Promise<void>((resolve) => {
        releaseCaughtUp = resolve;
      });

      mockChatStreamFor(workspaceId, async function* () {
        yield {
          type: "stream-start",
          workspaceId,
          messageId: "buffered-stream-start-message",
          model: streamModel,
          thinkingLevel,
          historySequence: 1,
          startTime: 1_000,
        };
        await caughtUpReady;
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);

      const showedStreamingStateDuringHydration = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.loading === true &&
          state.isHydratingTranscript === true &&
          state.canInterrupt === true &&
          state.currentModel === streamModel &&
          state.currentThinkingLevel === thinkingLevel
        );
      });
      expect(showedStreamingStateDuringHydration).toBe(true);
      expect(store.getWorkspaceState(workspaceId).messages).toHaveLength(0);

      releaseCaughtUp();
    });

    it("refreshes cached state when buffered stream-start arrives during hydration", async () => {
      const workspaceId = "buffered-stream-start-cache-bump";
      const streamModel = "anthropic:claude-opus-4-6";
      let releaseStreamStart!: () => void;
      const streamStartReady = new Promise<void>((resolve) => {
        releaseStreamStart = resolve;
      });
      let releaseCaughtUp!: () => void;
      const caughtUpReady = new Promise<void>((resolve) => {
        releaseCaughtUp = resolve;
      });

      mockChatStreamFor(workspaceId, async function* () {
        await streamStartReady;
        yield {
          type: "stream-start",
          workspaceId,
          messageId: "buffered-stream-start-cache-bump-message",
          model: streamModel,
          historySequence: 1,
          startTime: 1_000,
        };
        await caughtUpReady;
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);

      const initialState = store.getWorkspaceState(workspaceId);
      expect(initialState.loading).toBe(true);
      expect(initialState.canInterrupt).toBe(false);
      expect(initialState.currentModel).toBeNull();

      releaseStreamStart();

      const updatedStreamingState = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.loading === true &&
          state.isHydratingTranscript === true &&
          state.canInterrupt === true &&
          state.currentModel === streamModel
        );
      });
      expect(updatedStreamingState).toBe(true);

      releaseCaughtUp();
    });

    it("refreshes cached state when replayed stream-error clears buffered stream-start during hydration", async () => {
      const workspaceId = "buffered-stream-error-clears-stream-start";
      const streamModel = "anthropic:claude-opus-4-6";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        if (options?.signal?.aborted) {
          yield { type: "caught-up" };
        }
        await waitForAbortSignal(options?.signal);
      });

      recreateStore();
      await tick(0);
      createAndAddWorkspace(store, workspaceId);

      const rawStore = getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store);

      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId: "buffered-stream-error-message",
        model: streamModel,
        historySequence: 1,
        startTime: 1_000,
      });

      const initialState = store.getWorkspaceState(workspaceId);
      expect(initialState.canInterrupt).toBe(true);
      expect(initialState.currentModel).toBe(streamModel);

      rawStore.handleChatMessage(workspaceId, {
        type: "stream-error",
        messageId: "buffered-stream-error-message",
        error: "Mock replayed failure",
        errorType: "unknown",
        replay: true,
      });

      const clearedState = store.getWorkspaceState(workspaceId);
      expect(clearedState.canInterrupt).toBe(false);
    });

    it("routes live deltas through the keyed channel without bumping workspace state", async () => {
      const workspaceId = "fine-grained-deltas";
      const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));
      const messageId = "stream-message";
      const subscribed = Promise.withResolvers<void>();
      mockChatScript([() => subscribed.resolve()], { keepOpen: true });
      createAndAddWorkspace(store, workspaceId);
      await subscribed.promise;
      const rawStore = getInternal<{
        states: { bump: (key: string) => void };
        streamingStatsStore: { bump: (key: string) => void };
        streamingMessageStore: { has: (key: string) => boolean };
        handleChatMessage: (id: string, event: WorkspaceChatMessage) => void;
        processStreamEvent: (
          id: string,
          aggregator: ReturnType<WorkspaceStore["getAggregator"]>,
          event: WorkspaceChatMessage
        ) => void;
      }>(store);
      const dispatch = (event: WorkspaceChatMessage) =>
        rawStore.processStreamEvent(workspaceId, store.getAggregator(workspaceId), event);

      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId,
        historySequence: 1,
        model: TEST_MODEL,
        startTime: 1,
      });
      rawStore.handleChatMessage(workspaceId, caughtUpEvent());
      rawStore.handleChatMessage(workspaceId, {
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: "tool-1",
        toolName: "bash",
        args: {},
        tokens: 0,
        timestamp: 1,
      });

      const bump = spyOn(rawStore.states, "bump");
      const listener = mock(() => undefined);
      // A delta that adds a part creates a new display row, which only a
      // workspace bump can mount; within-part deltas stay row-local.
      const deltas: Array<{ event: WorkspaceChatMessage; createsRow: boolean }> = [
        {
          event: {
            type: "stream-delta",
            workspaceId,
            messageId,
            delta: "hello",
            tokens: 1,
            timestamp: 2,
          },
          createsRow: true,
        },
        {
          event: {
            type: "stream-delta",
            workspaceId,
            messageId,
            delta: " world",
            tokens: 1,
            timestamp: 3,
          },
          createsRow: false,
        },
        {
          event: {
            type: "reasoning-delta",
            workspaceId,
            messageId,
            delta: "thinking",
            tokens: 1,
            timestamp: 4,
          },
          createsRow: true,
        },
        {
          event: {
            type: "reasoning-delta",
            workspaceId,
            messageId,
            delta: " harder",
            tokens: 1,
            timestamp: 5,
          },
          createsRow: false,
        },
        {
          event: {
            type: "tool-call-delta",
            workspaceId,
            messageId,
            toolCallId: "tool-1",
            toolName: "bash",
            delta: { command: "echo hi" },
            tokens: 1,
            timestamp: 6,
          },
          createsRow: false,
        },
      ];

      const statsBump = spyOn(rawStore.streamingStatsStore, "bump");
      const trailingRowId = () => {
        const rows = store.getAggregator(workspaceId)!.getDisplayedMessages();
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          if ("historyId" in row && row.historyId === messageId) return row.id;
        }
        throw new Error("no displayed row for streaming message");
      };
      bump.mockClear();
      for (const { event, createsRow } of deltas) {
        listener.mockClear();
        bump.mockClear();
        statsBump.mockClear();
        if (createsRow) {
          dispatch(event);
          expect(bump).toHaveBeenCalledWith(workspaceId);
          expect(statsBump).toHaveBeenCalledWith(workspaceId);
        } else {
          const unsubscribeRow = store.subscribeStreamingMessage(
            workspaceId,
            trailingRowId(),
            listener
          );
          dispatch(event);
          await flushMicrotasks();
          expect(bump).not.toHaveBeenCalled();
          expect(listener).toHaveBeenCalledTimes(1);
          unsubscribeRow();
        }
      }

      dispatch({
        type: "reasoning-end",
        workspaceId,
        messageId,
      });
      expect(bump).toHaveBeenCalledWith(workspaceId);

      const streamingRow = store
        .getAggregator(workspaceId)!
        .getDisplayedMessages()
        .find((message) => message.type === "assistant" && message.historyId === messageId)!;
      expect(store.getStreamingMessage(workspaceId, streamingRow.id, messageId)).not.toBeNull();
      const liveRowKey = `${workspaceId}\u0000${trailingRowId()}`;
      expect(rawStore.streamingMessageStore.has(liveRowKey)).toBe(true);

      dispatch(
        streamEndEvent(workspaceId, messageId, {
          parts: [{ type: "text", text: "hello world" }],
        })
      );
      // Terminal events release the keyed channel and stop overriding prop rows,
      // so transcript-level transforms (e.g. merged stream errors) survive.
      expect(rawStore.streamingMessageStore.has(liveRowKey)).toBe(false);
      expect(store.getStreamingMessage(workspaceId, streamingRow.id, messageId)).toBeNull();
    });

    it("mounts rows created by a second concurrent stream's deltas", () => {
      const workspaceId = "concurrent-stream-deltas";
      const firstMessageId = "stream-message-1";
      const secondMessageId = "stream-message-2";
      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        states: { bump: (key: string) => void };
        handleChatMessage: (id: string, event: WorkspaceChatMessage) => void;
        processStreamEvent: (
          id: string,
          aggregator: ReturnType<WorkspaceStore["getAggregator"]>,
          event: WorkspaceChatMessage
        ) => void;
      }>(store);
      const dispatch = (event: WorkspaceChatMessage) =>
        rawStore.processStreamEvent(workspaceId, store.getAggregator(workspaceId), event);

      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId: firstMessageId,
        historySequence: 1,
        model: TEST_MODEL,
        startTime: 1,
      });
      rawStore.handleChatMessage(workspaceId, caughtUpEvent());
      // Second stream starts while the first stream's context is still active
      // (its terminal event has not been processed yet).
      dispatch({
        type: "stream-start",
        workspaceId,
        messageId: secondMessageId,
        historySequence: 2,
        model: TEST_MODEL,
        startTime: 2,
      });

      const bump = spyOn(rawStore.states, "bump");
      bump.mockClear();
      // The row-creating delta belongs to the newer stream; deriving the part
      // count from the older active-stream entry would skip the mount bump and
      // leave the new row hidden until the next structural event.
      dispatch({
        type: "stream-delta",
        workspaceId,
        messageId: secondMessageId,
        delta: "hello",
        tokens: 1,
        timestamp: 3,
      });
      expect(bump).toHaveBeenCalledWith(workspaceId);

      // The live row lookup must accept any active message: keying it to the
      // first active-stream entry would return null for the newer stream's row
      // and leave it rendering a stale prop row between workspace bumps.
      const secondRow = store
        .getAggregator(workspaceId)!
        .getDisplayedMessages()
        .find((message) => "historyId" in message && message.historyId === secondMessageId)!;
      expect(store.getStreamingMessage(workspaceId, secondRow.id, secondMessageId)).not.toBeNull();
    });

    it("releases the keyed channel when a background activity stop clears the stream", async () => {
      const workspaceId = "keyed-channel-background-stop";
      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        streamingMessageStore: { has: (key: string) => boolean };
        handleChatMessage: (id: string, event: WorkspaceChatMessage) => void;
        applyWorkspaceActivitySnapshot: (
          id: string,
          snapshot: WorkspaceActivitySnapshot | null
        ) => void;
      }>(store);
      const send = (event: WorkspaceChatMessage) => rawStore.handleChatMessage(workspaceId, event);
      const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

      send({
        type: "stream-start",
        workspaceId,
        messageId: "msg-a",
        historySequence: 1,
        model: TEST_MODEL,
        startTime: 1,
      });
      send(caughtUpEvent());
      send({
        type: "stream-delta",
        workspaceId,
        messageId: "msg-a",
        delta: "a",
        tokens: 1,
        timestamp: 2,
      });
      send({
        type: "stream-delta",
        workspaceId,
        messageId: "msg-a",
        delta: "b",
        tokens: 1,
        timestamp: 3,
      });
      await flush();
      const rows = store.getAggregator(workspaceId)!.getDisplayedMessages();
      const liveRow = rows.find((row) => row.type === "assistant" && row.historyId === "msg-a")!;
      const liveRowKey = `${workspaceId}\u0000${liveRow.id}`;
      expect(rawStore.streamingMessageStore.has(liveRowKey)).toBe(true);

      // Background the workspace, then let activity report the stream stopped:
      // no terminal chat event ever arrives, so the activity path must release
      // the keyed channel.
      createAndAddWorkspace(store, "keyed-channel-foreground");
      rawStore.applyWorkspaceActivitySnapshot(
        workspaceId,
        createActivitySnapshot(10, { streaming: true })
      );
      rawStore.applyWorkspaceActivitySnapshot(
        workspaceId,
        createActivitySnapshot(11, { streaming: false })
      );
      expect(rawStore.streamingMessageStore.has(liveRowKey)).toBe(false);
    });

    it("publishes the same accumulated text shown by the live channel", () => {
      const workspaceId = "live-final-content";
      const messageId = "stream-message";
      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        handleChatMessage: (id: string, event: WorkspaceChatMessage) => void;
      }>(store);
      const send = (event: WorkspaceChatMessage) => rawStore.handleChatMessage(workspaceId, event);

      send({
        type: "stream-start",
        workspaceId,
        messageId,
        historySequence: 1,
        model: TEST_MODEL,
        startTime: 1,
      });
      send(caughtUpEvent());
      for (const [delta, timestamp] of [
        ["hello", 2],
        [" world", 3],
      ] as const) {
        send({ type: "stream-delta", workspaceId, messageId, delta, tokens: 1, timestamp });
      }

      const aggregator = store.getAggregator(workspaceId)!;
      const displayed = aggregator
        .getDisplayedMessages()
        .find((message) => message.type === "assistant" && message.historyId === messageId)!;
      const live = store.getStreamingMessage(workspaceId, displayed.id, messageId);
      expect(live?.type === "assistant" ? live.content : null).toBe("hello world");

      send(
        streamEndEvent(workspaceId, messageId, {
          parts: [{ type: "text", text: "hello world" }],
        })
      );
      const published = aggregator
        .getDisplayedMessages()
        .find((message) => message.type === "assistant" && message.historyId === messageId);
      expect(published?.type === "assistant" ? published.content : null).toBe(
        live?.type === "assistant" ? live.content : null
      );
    });

    it("keeps split tool and text rows distinct on fine-grained updates", () => {
      const workspaceId = "split-streaming-rows";
      const messageId = "stream-message";
      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        handleChatMessage: (id: string, event: WorkspaceChatMessage) => void;
      }>(store);
      const send = (event: WorkspaceChatMessage) => rawStore.handleChatMessage(workspaceId, event);

      send({
        type: "stream-start",
        workspaceId,
        messageId,
        historySequence: 1,
        model: TEST_MODEL,
        startTime: 1,
      });
      send(caughtUpEvent());
      send({
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "ls" },
        tokens: 1,
        timestamp: 2,
      });
      send({
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: "tool-1",
        toolName: "bash",
        result: { output: "file.txt" },
        timestamp: 3,
      });
      send({
        type: "stream-delta",
        workspaceId,
        messageId,
        delta: "summary",
        tokens: 1,
        timestamp: 4,
      });

      const displayed = store
        .getAggregator(workspaceId)!
        .getDisplayedMessages()
        .filter((message) => "historyId" in message && message.historyId === messageId);
      const tool = displayed.find((message) => message.type === "tool")!;
      const text = displayed.find((message) => message.type === "assistant")!;

      expect(store.getStreamingMessage(workspaceId, tool.id, messageId)?.type).toBe("tool");
      const liveText = store.getStreamingMessage(workspaceId, text.id, messageId);
      expect(liveText?.type === "assistant" ? liveText.content : null).toBe("summary");
    });

    it("invalidates streaming-stats cache on stream-error so subscribers don't see stale TPS", async () => {
      const workspaceId = "stream-error-invalidates-stats";
      const streamModel = "anthropic:claude-opus-4-6";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        if (options?.signal?.aborted) {
          yield { type: "caught-up" };
        }
        await waitForAbortSignal(options?.signal);
      });

      recreateStore();
      await tick(0);
      createAndAddWorkspace(store, workspaceId);

      const rawStore = getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store);

      // Open a stream and feed a delta so streaming stats become non-null.
      // stream events are buffered until a caught-up event flushes them onto
      // the aggregator, so we send caught-up before reading the live stats.
      const messageId = "stream-error-message";
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId,
        model: streamModel,
        historySequence: 1,
        startTime: 1_000,
      });
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-delta",
        workspaceId,
        messageId,
        delta: "hello world ",
        tokens: 3,
        timestamp: 1_500,
      });
      rawStore.handleChatMessage(workspaceId, { type: "caught-up" });

      // Subscribe so stale-cache regression would surface as a missed bump.
      let notifications = 0;
      const unsubscribe = store.subscribeStreamingStats(workspaceId, () => {
        notifications += 1;
      });

      const before = store.getWorkspaceStreamingStats(workspaceId);
      expect(before).not.toBeNull();

      rawStore.handleChatMessage(workspaceId, {
        type: "stream-error",
        messageId,
        error: "Mock provider failure",
        errorType: "network",
      });

      // The terminal stream-error must bump streamingStatsStore so listeners
      // re-read; once recomputed, getActiveStreamMessageId returns undefined
      // and the snapshot collapses to null. Without the bump, the cache would
      // keep returning `before` (stale TPS leaking into the next stream).
      expect(notifications).toBeGreaterThanOrEqual(1);
      const after = store.getWorkspaceStreamingStats(workspaceId);
      expect(after).toBeNull();

      unsubscribe();
    });

    it("invalidates streaming-stats cache on stream-start so the new turn never displays the prior turn's TPS", async () => {
      // Repro for "Streaming TPS starts with stale value": reconnect / hydration
      // paths drop aggregator.activeStreams via clearActiveStreams() WITHOUT
      // bumping streamingStatsStore. If the next stream-start also doesn't bump,
      // useWorkspaceStreamingStats keeps returning the previous turn's cached
      // stats until the first delta of the new turn. The fix is to bump on
      // stream-start so every new turn forces a fresh recompute.
      const workspaceId = "stream-start-invalidates-stats";
      const streamModel = "anthropic:claude-opus-4-6";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        if (options?.signal?.aborted) {
          yield { type: "caught-up" };
        }
        await waitForAbortSignal(options?.signal);
      });

      recreateStore();
      await new Promise((resolve) => setTimeout(resolve, 0));
      createAndAddWorkspace(store, workspaceId);

      const rawStore = store as unknown as {
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      };

      // Stream A: start + delta + caught-up so the streaming-stats cache is
      // populated with non-null stats reflecting A's TPS / token count.
      const messageIdA = "stream-a";
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId: messageIdA,
        model: streamModel,
        historySequence: 1,
        startTime: 1_000,
      });
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-delta",
        workspaceId,
        messageId: messageIdA,
        delta: "hello world ",
        tokens: 3,
        timestamp: 1_500,
      });
      rawStore.handleChatMessage(workspaceId, { type: "caught-up" });

      const beforeA = store.getWorkspaceStreamingStats(workspaceId);
      expect(beforeA).not.toBeNull();
      expect(beforeA?.tokenCount).toBe(3);

      // Simulate a reconnect / hydration path: aggregator.clearActiveStreams()
      // drops the active stream WITHOUT bumping streamingStatsStore (the four
      // call sites in WorkspaceStore that do this on caught-up / background
      // streaming-stop / activity-driven generation advance / addWorkspace).
      const aggregator = store.getAggregator(workspaceId);
      if (!aggregator) {
        throw new Error(`Missing aggregator for ${workspaceId}`);
      }
      aggregator.clearActiveStreams();

      // Pre-fix: no bump has happened, so the cached A-stats remain visible to
      // any subscriber that reads at this point — that's the literal "stale TPS"
      // the user sees during the new turn's first frames.
      expect(store.getWorkspaceStreamingStats(workspaceId)).toEqual(beforeA);

      // Subscribe so the missing stream-start bump would surface as a missed
      // notification on regression.
      let notifications = 0;
      const unsubscribe = store.subscribeStreamingStats(workspaceId, () => {
        notifications += 1;
      });

      // Stream B starts via the buffered handler. With the fix, this bumps
      // streamingStatsStore and the cache is invalidated.
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId: "stream-b",
        model: streamModel,
        historySequence: 2,
        startTime: 2_000,
      });

      expect(notifications).toBeGreaterThanOrEqual(1);

      // After stream-start, the cache must no longer reflect stream A. B has
      // received no deltas yet, so the recomputed stats are a fresh zeroed
      // snapshot — the important property is that A's stats are gone.
      expect(store.getWorkspaceStreamingStats(workspaceId)).toEqual({
        tokenCount: 0,
        tps: 0,
        charsPerSec: 0,
      });

      unsubscribe();
    });

    it("prefers buffered stream-start state over stale non-streaming activity during hydration", async () => {
      const workspaceId = "buffered-stream-start-over-activity";
      const staleActivityModel = "openai:gpt-4o-mini";
      const streamModel = "anthropic:claude-opus-4-6";
      const thinkingLevel = "high";
      let releaseCaughtUp!: () => void;
      const caughtUpReady = new Promise<void>((resolve) => {
        releaseCaughtUp = resolve;
      });

      mockActivityList.mockResolvedValue({
        [workspaceId]: {
          recency: 3_000,
          streaming: false,
          lastModel: staleActivityModel,
          lastThinkingLevel: null,
        },
      });
      recreateStore();
      await tick(0);

      mockChatStreamFor(workspaceId, async function* () {
        yield {
          type: "stream-start",
          workspaceId,
          messageId: "buffered-stream-start-over-activity-message",
          model: streamModel,
          thinkingLevel,
          historySequence: 1,
          startTime: 1_000,
        };
        await caughtUpReady;
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);

      const preferredBufferedStreamState = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.loading === true &&
          state.canInterrupt === true &&
          state.currentModel === streamModel &&
          state.currentThinkingLevel === thinkingLevel
        );
      });
      expect(preferredBufferedStreamState).toBe(true);

      releaseCaughtUp();
    });

    it("replays runtime-status before caught-up when switching back to a preparing workspace", async () => {
      const workspaceId = "stream-starting-runtime-status-replay";
      const otherWorkspaceId = "stream-starting-runtime-status-other";
      const startupDetail = "Checking workspace runtime...";
      let subscriptionCount = 0;
      let releaseSecondCaughtUp: (() => void) | undefined;

      mockChatStreamFor(workspaceId, async function* () {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "stream-lifecycle",
            workspaceId,
            phase: "preparing",
            hadAnyOutput: false,
          };
          await Promise.resolve();
          yield {
            type: "runtime-status",
            workspaceId,
            phase: "starting",
            runtimeType: "ssh",
            detail: startupDetail,
          };
          return;
        }

        yield {
          type: "stream-lifecycle",
          workspaceId,
          phase: "preparing",
          hadAnyOutput: false,
        };
        await Promise.resolve();
        yield {
          type: "runtime-status",
          workspaceId,
          phase: "starting",
          runtimeType: "ssh",
          detail: startupDetail,
        };
        await new Promise<void>((resolve) => {
          releaseSecondCaughtUp = resolve;
        });
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);

      const sawInitialStartup = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return state.isStreamStarting && state.runtimeStatus?.detail === startupDetail;
      });
      expect(sawInitialStartup).toBe(true);

      createAndAddWorkspace(store, otherWorkspaceId);
      store.setActiveWorkspaceId(workspaceId);

      const replayedStartupBeforeCaughtUp = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          subscriptionCount >= 2 &&
          state.isStreamStarting &&
          state.runtimeStatus?.detail === startupDetail
        );
      });
      expect(replayedStartupBeforeCaughtUp).toBe(true);

      releaseSecondCaughtUp?.();

      const stayedVisibleAfterCaughtUp = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          !state.loading && state.isStreamStarting && state.runtimeStatus?.detail === startupDetail
        );
      });
      expect(stayedVisibleAfterCaughtUp).toBe(true);
    });

    it("keeps existing init logs visible while reconnect replay catches up", async () => {
      const workspaceId = "workspace-init-replay";
      const otherWorkspaceId = "workspace-init-other";
      const firstLine = "Preparing workspace...";
      const replayedLine = "Syncing repository over SSH...";
      let subscriptionCount = 0;
      let releaseSecondInitOutput: (() => void) | undefined;
      let releaseSecondCaughtUp: (() => void) | undefined;

      const getInitMessage = (): {
        state: ReturnType<WorkspaceStore["getWorkspaceState"]>;
        initMessage: Extract<DisplayedMessage, { type: "workspace-init" }> | undefined;
      } => {
        const state = store.getWorkspaceState(workspaceId);
        const initMessage = state.messages.find(
          (message): message is Extract<DisplayedMessage, { type: "workspace-init" }> =>
            message.type === "workspace-init"
        );
        return { state, initMessage };
      };

      mockChatStreamFor(workspaceId, async function* () {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "init-start",
            hookPath: "/tmp/project/.mux/init",
            timestamp: 1_000,
          };
          await Promise.resolve();
          yield {
            type: "init-output",
            line: firstLine,
            isError: false,
            timestamp: 1_001,
          };
          return;
        }

        yield {
          type: "init-start",
          hookPath: "/tmp/project/.mux/init",
          timestamp: 1_000,
          replay: true,
        };
        yield {
          type: "init-output",
          line: firstLine,
          isError: false,
          timestamp: 1_001,
          replay: true,
        };
        await new Promise<void>((resolve) => {
          releaseSecondInitOutput = resolve;
        });
        yield {
          type: "init-output",
          line: replayedLine,
          isError: false,
          timestamp: 2_001,
          replay: true,
        };
        await new Promise<void>((resolve) => {
          releaseSecondCaughtUp = resolve;
        });
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);

      const sawInitialInit = await waitUntil(() => {
        const { state, initMessage } = getInitMessage();
        return (
          state.loading === false &&
          initMessage?.status === "running" &&
          initMessage.lines[0]?.line === firstLine
        );
      });
      expect(sawInitialInit).toBe(true);

      createAndAddWorkspace(store, otherWorkspaceId);
      store.setActiveWorkspaceId(workspaceId);

      const preservedReconnectInit = await waitUntil(() => {
        const { state, initMessage } = getInitMessage();
        return (
          subscriptionCount >= 2 &&
          state.loading === false &&
          state.isHydratingTranscript === false &&
          initMessage?.status === "running" &&
          initMessage.lines.length === 1 &&
          initMessage.lines[0]?.line === firstLine
        );
      });
      expect(preservedReconnectInit).toBe(true);

      releaseSecondInitOutput?.();

      const replayedTailVisibleBeforeCaughtUp = await waitUntil(() => {
        const { state, initMessage } = getInitMessage();
        return (
          subscriptionCount >= 2 &&
          releaseSecondCaughtUp !== undefined &&
          state.loading === false &&
          state.isHydratingTranscript === false &&
          initMessage?.status === "running" &&
          initMessage.lines.length === 2 &&
          initMessage.lines[0]?.line === firstLine &&
          initMessage.lines[1]?.line === replayedLine
        );
      });
      expect(replayedTailVisibleBeforeCaughtUp).toBe(true);

      releaseSecondCaughtUp?.();

      const stayedVisibleAfterCaughtUp = await waitUntil(() => {
        const { state, initMessage } = getInitMessage();
        return (
          !state.loading &&
          initMessage?.status === "running" &&
          initMessage.lines.length === 2 &&
          initMessage.lines[0]?.line === firstLine &&
          initMessage.lines[1]?.line === replayedLine
        );
      });
      expect(stayedVisibleAfterCaughtUp).toBe(true);
    });

    it("active workspace still shows starting during legitimate startup gap", async () => {
      const workspaceId = "stream-starting-active-workspace";

      mockChatStreamFor(workspaceId, async function* () {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield createUserMessageEvent("active-pending-start", "hello", 1, 2_000);
      });

      createAndAddWorkspace(store, workspaceId);

      const sawStarting = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        const sidebarState = store.getWorkspaceSidebarState(workspaceId);
        return state.isStreamStarting === true && sidebarState.isStarting === true;
      });
      expect(sawStarting).toBe(true);
    });

    it("keeps optimistic starting state until buffered first-turn history finishes catching up", async () => {
      const workspaceId = "optimistic-pending-start-replay";
      const requestedModel = "openai:gpt-4o-mini";
      let releaseBufferedUser!: () => void;
      let releaseCaughtUp!: () => void;
      const bufferedUserReady = new Promise<void>((resolve) => {
        releaseBufferedUser = resolve;
      });
      const caughtUpReady = new Promise<void>((resolve) => {
        releaseCaughtUp = resolve;
      });

      mockChatStreamFor(workspaceId, async function* () {
        await bufferedUserReady;
        yield createUserMessageEvent("buffered-first-turn", "hello", 1, 2_750, requestedModel);
        await caughtUpReady;
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);
      store.markPendingInitialSend(workspaceId, requestedModel);
      releaseBufferedUser();

      const keptStartingWhileBuffered = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.loading === true &&
          state.isStreamStarting === true &&
          state.pendingStreamModel === requestedModel
        );
      });
      expect(keptStartingWhileBuffered).toBe(true);

      releaseCaughtUp();

      const renderedBufferedHistoryAfterCaughtUp = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return (
          state.loading === false &&
          state.isStreamStarting === false &&
          state.messages.some((message) => message.type === "user")
        );
      });
      expect(renderedBufferedHistoryAfterCaughtUp).toBe(true);
    });

    it("exposes the pending requested model in sidebar state during startup", async () => {
      const workspaceId = "stream-starting-pending-model-workspace";
      const requestedModel = "openai:gpt-4o-mini";

      mockChatStreamFor(workspaceId, async function* () {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield createUserMessageEvent("pending-model-message", "hello", 1, 2_500, requestedModel);
      });

      createAndAddWorkspace(store, workspaceId);

      const sawPendingModel = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        const sidebarState = store.getWorkspaceSidebarState(workspaceId);
        return (
          state.isStreamStarting === true &&
          state.pendingStreamModel === requestedModel &&
          sidebarState.isStarting === true &&
          sidebarState.pendingStreamModel === requestedModel
        );
      });
      expect(sawPendingModel).toBe(true);
    });
  });

  describe("history pagination", () => {
    it("initializes pagination from the oldest loaded history sequence on caught-up", async () => {
      const workspaceId = "history-pagination-workspace-1";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(true);
      expect(state.loadingOlderHistory).toBe(false);
    });

    it("does not infer older history from non-boundary sequences without server metadata", async () => {
      const workspaceId = "history-pagination-no-boundary";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-non-boundary", 5);
        await Promise.resolve();
        yield { type: "caught-up" };
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
    });

    it("loads older history and prepends it to the transcript", async () => {
      const workspaceId = "history-pagination-workspace-2";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      mockHistoryLoadMore.mockResolvedValueOnce({
        messages: [createHistoryMessageEvent("msg-older", 3)],
        nextCursor: null,
        hasOlder: false,
      });

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkspaceState(workspaceId).hasOlderHistory).toBe(true);

      await store.loadOlderHistory(workspaceId);

      expect(mockHistoryLoadMore).toHaveBeenCalledWith({
        workspaceId,
        cursor: {
          beforeHistorySequence: 5,
          beforeMessageId: "msg-newer",
        },
      });

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
      expect(state.muxMessages.map((message) => message.id)).toEqual(["msg-older", "msg-newer"]);
    });

    it("exposes loadingOlderHistory while requests are in flight and ignores concurrent loads", async () => {
      const workspaceId = "history-pagination-workspace-3";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      let resolveLoadMore: ((value: LoadMoreResponse) => void) | undefined;

      const loadMorePromise = new Promise<LoadMoreResponse>((resolve) => {
        resolveLoadMore = resolve;
      });
      mockHistoryLoadMore.mockReturnValueOnce(loadMorePromise);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const firstLoad = store.loadOlderHistory(workspaceId);
      expect(store.getWorkspaceState(workspaceId).loadingOlderHistory).toBe(true);

      const secondLoad = store.loadOlderHistory(workspaceId);
      expect(mockHistoryLoadMore).toHaveBeenCalledTimes(1);

      resolveLoadMore?.({
        messages: [],
        nextCursor: null,
        hasOlder: false,
      });

      await firstLoad;
      await secondLoad;

      const state = store.getWorkspaceState(workspaceId);
      expect(state.loadingOlderHistory).toBe(false);
      expect(state.hasOlderHistory).toBe(false);
    });

    it("ignores stale load-more responses after pagination state changes", async () => {
      const workspaceId = "history-pagination-stale-response";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      let resolveLoadMore: ((value: LoadMoreResponse) => void) | undefined;
      const loadMorePromise = new Promise<LoadMoreResponse>((resolve) => {
        resolveLoadMore = resolve;
      });
      mockHistoryLoadMore.mockReturnValueOnce(loadMorePromise);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const loadOlderPromise = store.loadOlderHistory(workspaceId);
      expect(store.getWorkspaceState(workspaceId).loadingOlderHistory).toBe(true);

      const internalHistoryPagination = getInternal<{
        historyPagination: Map<
          string,
          {
            nextCursor: { beforeHistorySequence: number; beforeMessageId?: string | null } | null;
            hasOlder: boolean;
            loading: boolean;
          }
        >;
      }>(store).historyPagination;
      // Simulate a concurrent pagination reset (e.g., live compaction boundary arriving).
      internalHistoryPagination.set(workspaceId, {
        nextCursor: null,
        hasOlder: false,
        loading: false,
      });

      resolveLoadMore?.({
        messages: [createHistoryMessageEvent("msg-stale-older", 3)],
        nextCursor: {
          beforeHistorySequence: 3,
          beforeMessageId: "msg-stale-older",
        },
        hasOlder: true,
      });

      await loadOlderPromise;

      const state = store.getWorkspaceState(workspaceId);
      expect(state.muxMessages.map((message) => message.id)).toEqual(["msg-newer"]);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
    });
  });

  describe("activity fallbacks", () => {
    it("tracks active goals across workspace activity snapshots", async () => {
      const makeSnapshot = (
        workspaceId: string,
        status: "active" | "paused",
        options: { pendingPersistence?: boolean } = {}
      ): WorkspaceActivitySnapshot => ({
        recency: 1_000,
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        goal: {
          goalId: `00000000-0000-4000-8000-${workspaceId.padStart(12, "0")}`,
          status,
          objective: `Goal ${workspaceId}`,
          budgetCents: null,
          costCents: 0,
          turnsUsed: 0,
          turnCap: null,
          startedAtMs: 1_000,
          ...(options.pendingPersistence === true ? { pendingPersistence: true } : {}),
        },
      });
      mockActivityList.mockResolvedValue({
        "1": makeSnapshot("1", "active"),
        "2": makeSnapshot("2", "active"),
        "3": makeSnapshot("3", "active"),
        "4": makeSnapshot("4", "active"),
        pending: makeSnapshot("6", "active", { pendingPersistence: true }),
        paused: makeSnapshot("5", "paused"),
      });
      recreateStore();

      await tick(0);

      expect(store.getActiveGoalCount()).toBe(4);
    });

    it("merges transient goal patches without replaying stale activity fields", () => {
      const workspaceId = "transient-goal-patch";
      createAndAddWorkspace(store, workspaceId, { createdAt: new Date(0).toISOString() }, false);
      const storeAccess = store as unknown as {
        applyWorkspaceActivitySnapshot: (
          workspaceId: string,
          snapshot: WorkspaceActivitySnapshot | null
        ) => void;
      };
      const persistedSnapshot: WorkspaceActivitySnapshot = {
        recency: 2_000,
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        goal: {
          goalId: "00000000-0000-4000-8000-000000000101",
          status: "active",
          objective: "Persisted goal",
          budgetCents: null,
          costCents: 0,
          turnsUsed: 0,
          turnCap: null,
          startedAtMs: 1_000,
        },
      };

      storeAccess.applyWorkspaceActivitySnapshot(workspaceId, persistedSnapshot);
      storeAccess.applyWorkspaceActivitySnapshot(workspaceId, {
        ...persistedSnapshot,
        streaming: true,
        recency: 1_000,
        transientGoalOnly: true,
        goal: {
          ...persistedSnapshot.goal!,
          goalId: "00000000-0000-4000-8000-000000000102",
          objective: "Queued replacement",
          pendingPersistence: true,
        },
      });

      const state = store.getWorkspaceState(workspaceId);
      expect(state.canInterrupt).toBe(false);
      expect(state.recencyTimestamp).toBe(2_000);
      expect(state.goal).toMatchObject({
        objective: "Queued replacement",
        pendingPersistence: true,
      });
    });

    it("uses activity snapshots for non-active workspace sidebar fields", async () => {
      const workspaceId = "activity-fallback-workspace";
      const activityRecency = new Date("2024-01-03T12:00:00.000Z").getTime();
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: activityRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: "high",
        activeWorkflowRunIds: ["wfr_activity"],
        activeWorkflowRunCount: 1,
        todoStatus: { emoji: "🔄", message: "Run checks" },
        hasTodos: true,
      };

      // Recreate the store so the first activity.list call uses this test snapshot.
      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();

      // Let the initial activity.list call resolve and queue its state updates.
      await tick(0);

      createAndAddWorkspace(
        store,
        workspaceId,
        {
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        false
      );

      const state = store.getWorkspaceState(workspaceId);
      expect(state.canInterrupt).toBe(true);
      expect(state.currentModel).toBe(activitySnapshot.lastModel);
      expect(state.currentThinkingLevel).toBe(activitySnapshot.lastThinkingLevel);
      expect(state.activeWorkflowRunIds).toEqual(["wfr_activity"]);
      expect(store.getWorkspaceSidebarState(workspaceId).activeWorkflowRunIds).toEqual([
        "wfr_activity",
      ]);
      expect(state.activeWorkflowRunCount).toBe(1);
      expect(store.getWorkspaceSidebarState(workspaceId).activeWorkflowRunCount).toBe(1);
      expect(state.agentStatus).toEqual(activitySnapshot.todoStatus ?? undefined);
      expect(state.recencyTimestamp).toBe(activitySnapshot.recency);
    });

    it("publishes workflow run ID changes when the aggregate count stays constant", () => {
      const workspaceId = "workflow-id-change";
      createAndAddWorkspace(store, workspaceId, { createdAt: new Date(0).toISOString() }, false);
      const storeAccess = store as unknown as {
        applyWorkspaceActivitySnapshot: (
          workspaceId: string,
          snapshot: WorkspaceActivitySnapshot | null
        ) => void;
      };
      const baseSnapshot: WorkspaceActivitySnapshot = {
        recency: 1,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        activeWorkflowRunCount: 1,
      };
      storeAccess.applyWorkspaceActivitySnapshot(workspaceId, {
        ...baseSnapshot,
        activeWorkflowRunIds: ["wfr_alpha"],
      });

      let updateCount = 0;
      const unsubscribe = store.subscribeKey(workspaceId, () => {
        updateCount += 1;
      });
      try {
        storeAccess.applyWorkspaceActivitySnapshot(workspaceId, {
          ...baseSnapshot,
          activeWorkflowRunIds: ["wfr_beta"],
        });

        expect(updateCount).toBe(1);
        expect(store.getWorkspaceSidebarState(workspaceId).activeWorkflowRunIds).toEqual([
          "wfr_beta",
        ]);
      } finally {
        unsubscribe();
      }
    });

    it("keeps activity snapshots authoritative for non-active stream state", async () => {
      const workspaceId = "activity-false-over-stale-aggregator";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T08:00:00.000Z").getTime(),
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      recreateStore();
      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const aggregator = store.getAggregator(workspaceId);
      expect(aggregator).toBeDefined();
      aggregator?.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: "stale-active-stream",
        model: "claude-sonnet-4",
        historySequence: 1,
        startTime: 1_000,
      });

      const state = store.getWorkspaceState(workspaceId);
      expect(state.canInterrupt).toBe(false);
    });

    it("falls back to persisted activity todoStatus for active workspaces when replayed todos are absent", async () => {
      const workspaceId = "active-activity-todo-fallback";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T09:00:00.000Z").getTime(),
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        todoStatus: { emoji: "🔄", message: "Persisted todo snapshot" },
        hasTodos: true,
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId);
      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.todoStatus ?? undefined);
    });

    it("derives active workspace status from the current todo list", () => {
      const workspaceId = "active-todo-status-workspace";
      createAndAddWorkspace(store, workspaceId);
      seedPinnedTodos(store, workspaceId, [
        { content: "Run typecheck", status: "in_progress" },
        { content: "Add regression test", status: "pending" },
      ]);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual({ emoji: "🔄", message: "Run typecheck" });
    });

    it("live todo derivation wins over aggregator getAgentStatus (status_set/heartbeat) for active workspaces", () => {
      // Codex round 6: aggregator.getAgentStatus() conflates status_set and
      // muxMeta.displayStatus into one field. A status_set value persisted
      // from a previous turn could mask a fresh todo_write in the current
      // turn. Live todo must win.
      const workspaceId = "active-live-todo-beats-aggregator-status";
      createAndAddWorkspace(store, workspaceId);
      seedPinnedTodos(store, workspaceId, [{ content: "Run typecheck", status: "in_progress" }]);

      // Simulate an aggregator that has a non-empty getAgentStatus()
      // (e.g. an old status_set from a previous turn). The new precedence
      // must ignore it because the live todo derivation is fresher.
      const aggregator = store.getAggregator(workspaceId);
      if (!aggregator) throw new Error("expected aggregator");
      spyOn(aggregator, "getAgentStatus").mockReturnValue({
        emoji: "🔍",
        message: "Investigating crash",
      });

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual({ emoji: "🔄", message: "Run typecheck" });
    });

    it("falls back to persisted AI status for active workspaces with no live todos", async () => {
      // Live aggregator todos are the freshest signal for "what is the
      // agent doing right now" because `todo_write` is processed
      // synchronously, before the async setTodoStatus + activity-emit round
      // trip. So when the workspace has live todos we prefer those (see
      // the existing "derives active workspace status from the current todo
      // list" test). When there are NO live todos, the AI-generated
      // todoStatus from AgentStatusService still has to surface — that's
      // the common "free-form chat without a todo list" case.
      const workspaceId = "active-ai-no-live-todos";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T13:00:00.000Z").getTime(),
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        todoStatus: { emoji: "🛠️", message: "AI-generated summary" },
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId);
      // Intentionally no seedPinnedTodos — the aggregator has no todos, so
      // the live derivation returns undefined and the persisted AI status
      // must surface through the fallback chain.

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.todoStatus ?? undefined);
    });

    it("prefers todo-derived activity status for inactive workspaces", async () => {
      const workspaceId = "activity-fallback-todo-status-workspace";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T12:00:00.000Z").getTime(),
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: "high",
        todoStatus: { emoji: "🔄", message: "Run typecheck" },
        hasTodos: true,
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.todoStatus ?? undefined);
    });

    it("prefers transient displayStatus over todo-derived status for inactive workspaces", async () => {
      const workspaceId = "activity-fallback-display-status-workspace";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T15:00:00.000Z").getTime(),
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        displayStatus: { emoji: "🤔", message: "Deciding execution strategy" },
        todoStatus: { emoji: "🔄", message: "Run typecheck" },
        hasTodos: true,
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.displayStatus ?? undefined);
    });

    it("uses todoStatus from the activity snapshot for inactive workspaces", async () => {
      // todoStatus is the persistent sidebar slot — written by both the
      // small-model AgentStatusService and the todo-derivation path. Inactive
      // workspaces don't run the aggregator, so the snapshot's todoStatus is
      // what the sidebar must show.
      const workspaceId = "activity-fallback-todo-status-workspace";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T16:00:00.000Z").getTime(),
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        todoStatus: { emoji: "🛠️", message: "Wiring sidebar precedence" },
        hasTodos: true,
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.todoStatus ?? undefined);
    });

    it("keeps displayStatus precedence over todoStatus so explicit system status still wins", async () => {
      // displayStatus is a deliberate, system-driven signal (e.g. "Compacting
      // idle workspace…"). It must outrank todoStatus — otherwise a periodic
      // small-model rewrite of todoStatus would mask the explicit progress
      // message the backend is trying to communicate.
      const workspaceId = "activity-fallback-display-over-todo";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T17:00:00.000Z").getTime(),
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        displayStatus: { emoji: "💤", message: "Compacting idle workspace" },
        todoStatus: { emoji: "🛠️", message: "Wiring sidebar precedence" },
        hasTodos: false,
      };

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toEqual(activitySnapshot.displayStatus ?? undefined);
    });

    it("suppresses stale legacy status fallback when activity says the todo list is empty", async () => {
      const workspaceId = "activity-fallback-empty-todo-status";
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-04T18:00:00.000Z").getTime(),
        streaming: false,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
        hasTodos: false,
      };

      localStorageBacking.set(
        getStatusStateKey(workspaceId),
        JSON.stringify({ emoji: "🔍", message: "Old persisted status" })
      );

      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      recreateStore();
      await tick(0);

      createAndAddWorkspace(store, workspaceId, { createdAt: "2020-01-01T00:00:00.000Z" }, false);

      const state = store.getWorkspaceState(workspaceId);
      expect(state.agentStatus).toBeUndefined();
    });

    it("fires response-complete callback when a background workspace stops streaming", async () => {
      const activeWorkspaceId = "active-workspace";
      const backgroundWorkspaceId = "background-workspace";
      const initialRecency = new Date("2024-01-05T00:00:00.000Z").getTime();
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [{ ...initialSnapshot, recency: initialRecency + 1, streaming: false }]
      );
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completedAt: initialRecency + 1,
      });
    });

    it("marks background compaction stops from activity snapshots as non-notifying completions", async () => {
      const activeWorkspaceId = "active-workspace-compaction-snapshot";
      const backgroundWorkspaceId = "background-workspace-compaction-snapshot";
      const initialRecency = new Date("2024-01-05T12:00:00.000Z").getTime();
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [
          {
            ...initialSnapshot,
            recency: initialRecency + 1,
            streaming: false,
            isCompaction: true,
          },
        ]
      );
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completion: { kind: "compaction" },
        completedAt: initialRecency + 1,
      });
    });

    it("preserves internal resume metadata across background handoffs", async () => {
      const activeWorkspaceId = "active-workspace-internal-resume-background";
      const backgroundWorkspaceId = "background-workspace-internal-resume-background";
      const initialRecency = new Date("2024-01-06T00:00:00.000Z").getTime();
      const initialSnapshot = createActivitySnapshot(initialRecency, { streamingGeneration: 1 });
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [
          { ...initialSnapshot, streamingGeneration: 2 },
          {
            ...initialSnapshot,
            recency: initialRecency + 1,
            streaming: false,
            streamingGeneration: 2,
          },
        ]
      );
      mockChatStreamFor(backgroundWorkspaceId, function* () {
        yield compactionRequestEvent(
          "internal-resume-compaction-request",
          compactionFollowUp({ text: "Continue", dispatchOptions: { source: "internal-resume" } })
        );
        yield streamStartEvent(backgroundWorkspaceId, "compaction-stream", {
          historySequence: 2,
          mode: "exec",
        });
        yield { type: "caught-up", hasOlderHistory: false };
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, backgroundWorkspaceId);
      expect(
        await waitUntil(() => store.getWorkspaceState(backgroundWorkspaceId).isCompacting)
      ).toBe(true);
      createAndAddWorkspace(store, activeWorkspaceId);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completion: { kind: "compaction", suppressNotification: true },
        completedAt: initialRecency + 1,
      });
    });

    it("preserves queued auto-follow-up metadata for background completion callbacks", async () => {
      const activeWorkspaceId = "active-workspace-queued-follow-up-background";
      const backgroundWorkspaceId = "background-workspace-queued-follow-up-background";
      const initialRecency = new Date("2024-01-07T00:00:00.000Z").getTime();
      const followUpText = "follow-up after response";
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [{ ...initialSnapshot, recency: initialRecency + 1, streaming: false }]
      );
      mockChatStreamFor(backgroundWorkspaceId, function* () {
        yield { type: "caught-up", hasOlderHistory: false };
        yield streamStartEvent(backgroundWorkspaceId, "response-stream");
        yield queuedFollowUpEvent(backgroundWorkspaceId, followUpText);
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, backgroundWorkspaceId);
      expect(
        await waitUntil(() => {
          const state = store.getWorkspaceState(backgroundWorkspaceId);
          return state.canInterrupt && state.queuedMessage?.content === followUpText;
        })
      ).toBe(true);
      createAndAddWorkspace(store, activeWorkspaceId);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completion: { kind: "response", hasAutoFollowUp: true },
        completedAt: initialRecency + 1,
      });
    });

    it("does not let stale queued auto-follow-up state suppress the final background completion", async () => {
      const activeWorkspaceId = "active-workspace-after-handoff";
      const backgroundWorkspaceId = "background-workspace-after-handoff";
      const initialRecency = new Date("2024-01-07T12:00:00.000Z").getTime();
      const followUpText = "follow-up after response";
      const initialSnapshot = createActivitySnapshot(initialRecency, { streamingGeneration: 1 });
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [
          { ...initialSnapshot, streamingGeneration: 2 },
          {
            ...initialSnapshot,
            recency: initialRecency + 1,
            streaming: false,
            streamingGeneration: 2,
          },
        ]
      );
      mockChatStreamFor(backgroundWorkspaceId, function* () {
        yield { type: "caught-up", hasOlderHistory: false };
        yield streamStartEvent(backgroundWorkspaceId, "response-stream-a");
        yield queuedFollowUpEvent(backgroundWorkspaceId, followUpText);
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, backgroundWorkspaceId);
      expect(
        await waitUntil(() => {
          const state = store.getWorkspaceState(backgroundWorkspaceId);
          return state.canInterrupt && state.queuedMessage?.content === followUpText;
        })
      ).toBe(true);
      createAndAddWorkspace(store, activeWorkspaceId);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completedAt: initialRecency + 1,
      });
    });

    it("preserves compaction auto-follow-up metadata for background completion callbacks", async () => {
      const activeWorkspaceId = "active-workspace-continue";
      const backgroundWorkspaceId = "background-workspace-continue";
      const initialRecency = new Date("2024-01-08T00:00:00.000Z").getTime();
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [{ ...initialSnapshot, recency: initialRecency + 1, streaming: false }]
      );
      mockChatStreamFor(backgroundWorkspaceId, function* () {
        yield compactionRequestEvent("compaction-request-msg", compactionFollowUp());
        yield streamStartEvent(backgroundWorkspaceId, "compaction-stream", {
          historySequence: 2,
          mode: "exec",
        });
        yield { type: "caught-up", hasOlderHistory: false };
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, backgroundWorkspaceId);
      expect(
        await waitUntil(() => store.getWorkspaceState(backgroundWorkspaceId).isCompacting)
      ).toBe(true);
      createAndAddWorkspace(store, activeWorkspaceId);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completion: { kind: "compaction" },
        completedAt: initialRecency + 1,
      });
    });

    it("marks normal completions with queued follow-up for active callbacks", async () => {
      const workspaceId = "active-workspace-normal-queued-follow-up";
      const followUpText = "follow-up after response";
      mockChatStreamFor(workspaceId, function* () {
        yield { type: "caught-up", hasOlderHistory: false };
        yield streamStartEvent(workspaceId, "response-stream");
        yield queuedFollowUpEvent(workspaceId, followUpText);
        yield {
          type: "stream-end",
          workspaceId,
          messageId: "response-stream",
          metadata: { model: TEST_MODEL },
          parts: [],
        };
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, workspaceId);
      expect(await waitUntil(() => onResponseComplete.mock.calls.length > 0)).toBe(true);

      expectResponseComplete(onResponseComplete, {
        workspaceId,
        messageId: "response-stream",
        isFinal: true,
        finalText: "",
        completion: { kind: "response", hasAutoFollowUp: true },
        completedAt: expect.any(Number),
      });
    });

    it("marks compaction completions with queued follow-up as auto-follow-up for active callbacks", async () => {
      const workspaceId = "active-workspace-queued-follow-up";
      const timestamp = Date.now();
      mockChatStreamFor(workspaceId, function* () {
        yield { type: "caught-up", hasOlderHistory: false };
        yield compactionRequestEvent("compaction-request-msg", undefined, timestamp);
        yield streamStartEvent(workspaceId, "compaction-stream", {
          historySequence: 2,
          startTime: timestamp + 1,
          mode: "compact",
        });
        yield queuedFollowUpEvent(workspaceId, "follow-up after compaction");
        yield {
          type: "stream-end",
          workspaceId,
          messageId: "compaction-stream",
          metadata: { model: TEST_MODEL },
          parts: [],
        };
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, workspaceId);
      expect(await waitUntil(() => onResponseComplete.mock.calls.length > 0)).toBe(true);

      expectResponseComplete(onResponseComplete, {
        workspaceId,
        messageId: "compaction-stream",
        isFinal: true,
        finalText: "",
        completion: { kind: "compaction" },
        completedAt: expect.any(Number),
      });
    });

    it("preserves queued auto-follow-up metadata for background compaction completions", async () => {
      const activeWorkspaceId = "active-workspace-background-queued-follow-up";
      const backgroundWorkspaceId = "background-workspace-background-queued-follow-up";
      const initialRecency = new Date("2024-01-09T00:00:00.000Z").getTime();
      const followUpText = "follow-up after compaction";
      const timestamp = Date.now();
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundCompletion = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [{ ...initialSnapshot, recency: initialRecency + 1, streaming: false }]
      );
      mockChatStreamFor(backgroundWorkspaceId, function* () {
        yield { type: "caught-up", hasOlderHistory: false };
        yield compactionRequestEvent("compaction-request-msg", undefined, timestamp);
        yield streamStartEvent(backgroundWorkspaceId, "compaction-stream", {
          historySequence: 2,
          startTime: timestamp + 1,
          mode: "compact",
        });
        yield queuedFollowUpEvent(backgroundWorkspaceId, followUpText);
      });
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, backgroundWorkspaceId);
      expect(
        await waitUntil(() => {
          const state = store.getWorkspaceState(backgroundWorkspaceId);
          return state.isCompacting && state.queuedMessage?.content === followUpText;
        })
      ).toBe(true);
      createAndAddWorkspace(store, activeWorkspaceId);
      releaseBackgroundCompletion();
      await tick(0);

      expectResponseComplete(onResponseComplete, {
        workspaceId: backgroundWorkspaceId,
        isFinal: true,
        completion: { kind: "compaction" },
        completedAt: initialRecency + 1,
      });
    });

    it("does not fire response-complete callback when background streaming stops without recency advance", async () => {
      const activeWorkspaceId = "active-workspace-no-replay";
      const backgroundWorkspaceId = "background-workspace-no-replay";
      const initialRecency = new Date("2024-01-06T00:00:00.000Z").getTime();
      const initialSnapshot = createActivitySnapshot(initialRecency);
      const releaseBackgroundTransition = mockBackgroundActivityTransition(
        backgroundWorkspaceId,
        initialSnapshot,
        [{ ...initialSnapshot, recency: initialRecency, streaming: false }]
      );
      const onResponseComplete = createResponseCompleteSpy();

      recreateStore(onResponseComplete);
      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);
      releaseBackgroundTransition();
      await tick(0);

      expect(onResponseComplete).not.toHaveBeenCalled();
    });
    it("clears activity stream-start recency cache on dispose", () => {
      const workspaceId = "dispose-clears-activity-recency";
      const internalStore = getInternal<{
        activityStreamingStartRecency: Map<string, number>;
      }>(store);

      internalStore.activityStreamingStartRecency.set(workspaceId, Date.now());
      expect(internalStore.activityStreamingStartRecency.has(workspaceId)).toBe(true);

      store.dispose();

      expect(internalStore.activityStreamingStartRecency.size).toBe(0);
    });

    it("keeps newer subscription deltas over a stale bootstrap-retry list", async () => {
      const workspaceId = "activity-retry-delta-race";
      resetStore();

      let listCallCount = 0;
      let releaseSecondList!: (value: Record<string, WorkspaceActivitySnapshot> | null) => void;
      const secondList = new Promise<Record<string, WorkspaceActivitySnapshot> | null>(
        (resolve) => {
          releaseSecondList = resolve;
        }
      );
      mockActivityList.mockImplementation(
        (): Promise<Record<string, WorkspaceActivitySnapshot> | null> => {
          listCallCount += 1;
          return listCallCount === 1 ? Promise.resolve(null) : secondList;
        }
      );

      let releaseEvent!: () => void;
      const eventGate = new Promise<void>((resolve) => {
        releaseEvent = resolve;
      });
      const deltaSnapshot: WorkspaceActivitySnapshot = {
        recency: new Date("2024-01-08T00:00:00.000Z").getTime(),
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: "high",
      };
      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceActivityEvent, void, unknown> {
        await eventGate;
        yield { type: "activity", workspaceId, activity: deltaSnapshot };
        await waitForAbortSignal(options?.signal);
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient({ workspace: mockClient.workspace, terminal: mockClient.terminal } as any);
      createAndAddWorkspace(
        store,
        workspaceId,
        {
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        false
      );

      // The bootstrap retry's list() is in flight (blocked)...
      const secondListStarted = await waitUntil(() => listCallCount >= 2, 5000);
      expect(secondListStarted).toBe(true);
      // ...a live delta lands for this workspace while it is pending...
      releaseEvent();
      const deltaApplied = await waitUntil(
        () => store.getWorkspaceState(workspaceId).canInterrupt === true
      );
      expect(deltaApplied).toBe(true);

      // ...then the older list arrives WITHOUT that workspace: it must confer
      // authority but must not clear the newer delta.
      releaseSecondList({});
      const authoritative = await waitUntil(() => store.isActivityAuthoritative());
      expect(authoritative).toBe(true);
      expect(store.getWorkspaceState(workspaceId).canInterrupt).toBe(true);
    });
  });

  describe("terminal activity", () => {
    it("propagates terminal activity to sidebar state", async () => {
      const workspaceId = "terminal-activity-workspace";
      const events: TerminalActivityEvent[] = [
        {
          type: "snapshot",
          workspaces: {
            [workspaceId]: { activeCount: 2, totalSessions: 3 },
          },
        },
      ];

      const terminalSubscribeMock = mock(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<TerminalActivityEvent, void, unknown> {
        for (const event of events) {
          yield event;
        }
        await waitForAbortSignal(options?.signal);
      });

      const testClient = {
        ...mockClient,
        terminal: {
          activity: {
            subscribe: terminalSubscribeMock,
          },
        },
      };

      resetStore();
      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            makeWorkspaceMetadata(workspaceId, {
              name: "test-branch",
              projectPath: "/test",
              namedWorkspacePath: "/test/test-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
            }),
          ],
        ])
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(testClient as any);

      await tick(50);

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(2);
      expect(sidebarState.terminalSessionCount).toBe(3);
    });

    it("treats missing terminal.activity.subscribe as unsupported capability (no crash/retry)", async () => {
      const workspaceId = "partial-client-workspace";

      resetStore();

      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            makeWorkspaceMetadata(workspaceId, {
              name: "partial-branch",
              projectPath: "/test",
              namedWorkspacePath: "/test/partial-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
            }),
          ],
        ])
      );

      // Client with terminal namespace but no activity.subscribe — should not throw.
      const partialClient = {
        workspace: mockClient.workspace,
        terminal: {},
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(partialClient as any);

      await tick(50);

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(0);
      expect(sidebarState.terminalSessionCount).toBe(0);
    });

    it("re-arms terminal activity after unsupported client is replaced with supported client", async () => {
      const workspaceId = "rearm-terminal-workspace";

      resetStore();
      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            makeWorkspaceMetadata(workspaceId, {
              name: "rearm-branch",
              projectPath: "/test",
              namedWorkspacePath: "/test/rearm-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
            }),
          ],
        ])
      );

      // First: set an unsupported client (no terminal.activity.subscribe)
      const partialClient = {
        workspace: mockClient.workspace,
        terminal: {},
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(partialClient as any);
      await tick(50);

      // Confirm terminal counts are zero after unsupported client.
      expect(store.getWorkspaceSidebarState(workspaceId).terminalActiveCount).toBe(0);
      expect(store.getWorkspaceSidebarState(workspaceId).terminalSessionCount).toBe(0);

      // Second: replace with a supported client that has terminal.activity.subscribe.
      const terminalSubscribeMock = mock(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<TerminalActivityEvent, void, unknown> {
        yield {
          type: "snapshot",
          workspaces: {
            [workspaceId]: { activeCount: 1, totalSessions: 2 },
          },
        };
        await waitForAbortSignal(options?.signal);
      });

      const fullClient = {
        ...mockClient,
        terminal: {
          activity: {
            subscribe: terminalSubscribeMock,
          },
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(fullClient as any);
      await tick(50);

      // The subscription should start after the supported client is set.
      expect(terminalSubscribeMock).toHaveBeenCalled();
      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(1);
      expect(sidebarState.terminalSessionCount).toBe(2);
    });

    it("defaults terminal counts to zero when no activity", () => {
      const workspaceId = "no-terminal-workspace";

      resetStore();

      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            makeWorkspaceMetadata(workspaceId, {
              name: "empty-branch",
              projectPath: "/test",
              namedWorkspacePath: "/test/empty-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
            }),
          ],
        ])
      );

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(0);
      expect(sidebarState.terminalSessionCount).toBe(0);
    });
  });

  describe("getWorkspaceRecency", () => {
    it("should return stable reference when values unchanged", () => {
      const recency1 = store.getWorkspaceRecency();
      const recency2 = store.getWorkspaceRecency();

      // Should be same reference (cached)
      expect(recency1).toBe(recency2);
    });
  });

  describe("model tracking", () => {
    it("should call onModelUsed when stream starts", async () => {
      // Setup mock stream
      mockChatScript([
        { type: "caught-up" },
        tick(0),
        {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-opus-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        },
        tick(10),
      ]);

      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS);

      // Wait for async processing
      await tick(20);

      expect(mockOnModelUsed).toHaveBeenCalledWith("claude-opus-4");
    });
  });

  describe("reference stability", () => {
    it("getAllStates() returns new Map on each call", () => {
      const states1 = store.getAllStates();
      const states2 = store.getAllStates();
      // Should return new Map each time (not cached/reactive)
      expect(states1).not.toBe(states2);
      expect(states1).toEqual(states2); // But contents are equal
    });

    it("getWorkspaceState() returns same reference when state hasn't changed", () => {
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS, false);

      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");
      expect(state1).toBe(state2);
    });

    it("getWorkspaceSidebarState() returns same reference when WorkspaceState hasn't changed", () => {
      const originalNow = Date.now;
      let now = 1000;
      Date.now = () => now;

      try {
        const workspaceId = "test-workspace";
        createAndAddWorkspace(store, workspaceId);

        const aggregator = store.getAggregator(workspaceId);
        expect(aggregator).toBeDefined();
        if (!aggregator) {
          throw new Error("Expected aggregator to exist");
        }

        const streamStart: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: "msg1",
          model: "claude-opus-4",
          historySequence: 1,
          startTime: 500,
          mode: "exec",
        };
        aggregator.handleStreamStart(streamStart);

        const toolStart: ToolCallStartEvent = {
          type: "tool-call-start",
          workspaceId,
          messageId: "msg1",
          toolCallId: "tool1",
          toolName: "test_tool",
          args: {},
          tokens: 0,
          timestamp: 600,
        };
        aggregator.handleToolCallStart(toolStart);

        // Simulate store update (MapStore version bump) after handling events.
        store.bumpState(workspaceId);

        now = 1300;
        const sidebar1 = store.getWorkspaceSidebarState(workspaceId);

        // Advance time without a store bump. Sidebar state should remain stable
        // because it doesn't include timing stats (those use a separate subscription).
        now = 1350;
        const sidebar2 = store.getWorkspaceSidebarState(workspaceId);

        expect(sidebar2).toBe(sidebar1);
      } finally {
        Date.now = originalNow;
      }
    });

    it("syncWorkspaces() does not emit when workspaces unchanged", () => {
      const listener = mock(() => undefined);
      store.subscribe(listener);

      const metadata = new Map<string, FrontendWorkspaceMetadata>();
      store.syncWorkspaces(metadata);
      expect(listener).not.toHaveBeenCalled();

      listener.mockClear();
      store.syncWorkspaces(metadata);
      expect(listener).not.toHaveBeenCalled();
    });

    it("getAggregator does not emit when creating new aggregator (no render side effects)", () => {
      let emitCount = 0;
      const unsubscribe = store.subscribe(() => {
        emitCount++;
      });

      // Add workspace first
      createAndAddWorkspace(store, "test-workspace");

      // Ignore setup emissions so this test only validates getAggregator() side effects.
      emitCount = 0;

      // Simulate what happens during render - component calls getAggregator
      const aggregator1 = store.getAggregator("test-workspace");
      expect(aggregator1).toBeDefined();

      // Should NOT have emitted (would cause "Cannot update component while rendering" error)
      expect(emitCount).toBe(0);

      // Subsequent calls should return same aggregator
      const aggregator2 = store.getAggregator("test-workspace");
      expect(aggregator2).toBe(aggregator1);
      expect(emitCount).toBe(0);

      unsubscribe();
    });
  });

  describe("cache invalidation", () => {
    it("invalidates getWorkspaceState() cache when workspace changes", async () => {
      // Setup mock stream
      mockChatScript([
        { type: "caught-up" },
        tick(30),
        {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-sonnet-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        },
        tick(10),
      ]);

      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS);

      const state1 = store.getWorkspaceState("test-workspace");

      // Wait for async processing
      await tick(70);

      const state2 = store.getWorkspaceState("test-workspace");
      expect(state1).not.toBe(state2); // Cache should be invalidated
      expect(state2.canInterrupt).toBe(true); // Stream started, so can interrupt
    });

    it("invalidates getAllStates() cache when workspace changes", async () => {
      // Setup mock stream
      mockChatScript([
        { type: "caught-up" },
        tick(0),
        {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-sonnet-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        },
        tick(10),
      ]);

      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS);

      const states1 = store.getAllStates();

      // Wait for async processing
      await tick(20);

      const states2 = store.getAllStates();
      expect(states1).not.toBe(states2); // Cache should be invalidated
    });

    it("maintains recency based on createdAt for new workspaces", () => {
      const createdAt = new Date("2024-01-01T00:00:00Z").toISOString();
      createAndAddWorkspace(
        store,
        "test-workspace",
        {
          name: "test-workspace",
          projectPath: "/test/project",
          namedWorkspacePath: "/test/project/test-workspace",
          createdAt,
        },
        false
      );

      const recency = store.getWorkspaceRecency();

      // Recency should be based on createdAt
      expect(recency["test-workspace"]).toBe(new Date(createdAt).getTime());
    });

    it("maintains cache when no changes occur", () => {
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS, false);

      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");
      const recency1 = store.getWorkspaceRecency();
      const recency2 = store.getWorkspaceRecency();

      // Cached values should return same references
      expect(state1).toBe(state2);
      expect(recency1).toBe(recency2);

      // getAllStates returns new Map each time (not cached)
      const allStates1 = store.getAllStates();
      const allStates2 = store.getAllStates();
      expect(allStates1).not.toBe(allStates2);
      expect(allStates1).toEqual(allStates2);
    });
  });

  describe("race conditions", () => {
    it("properly cleans up workspace on removal", () => {
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS, false);

      // Verify workspace exists
      let allStates = store.getAllStates();
      expect(allStates.size).toBe(1);

      // Remove workspace (clears aggregator and unsubscribes IPC)
      store.removeWorkspace("test-workspace");

      // Verify workspace is completely removed
      allStates = store.getAllStates();
      expect(allStates.size).toBe(0);

      // Verify aggregator is gone
      expect(store.getAggregator("test-workspace")).toBeUndefined();
    });

    it("handles concurrent workspace additions", () => {
      // Add workspaces concurrently
      createAndAddWorkspace(
        store,
        "workspace-1",
        {
          name: "workspace-1",
          projectName: "project-1",
          projectPath: "/project-1",
          namedWorkspacePath: "/path/1",
        },
        false
      );
      createAndAddWorkspace(
        store,
        "workspace-2",
        {
          name: "workspace-2",
          projectName: "project-2",
          projectPath: "/project-2",
          namedWorkspacePath: "/path/2",
        },
        false
      );

      const allStates = store.getAllStates();
      expect(allStates.size).toBe(2);
      expect(allStates.has("workspace-1")).toBe(true);
      expect(allStates.has("workspace-2")).toBe(true);
    });

    it("handles workspace removal during state access", () => {
      createAndAddWorkspace(store, "test-workspace", TEST_WORKSPACE_OPTIONS, false);

      const state1 = store.getWorkspaceState("test-workspace");
      expect(state1).toBeDefined();

      // Remove workspace
      store.removeWorkspace("test-workspace");

      // Accessing state after removal should create new aggregator (lazy init)
      const state2 = store.getWorkspaceState("test-workspace");
      expect(state2).toBeDefined();
      expect(state2.loading).toBe(true); // Fresh workspace, not caught up
    });
  });

  it("queued message identity changes when a partial FIFO drain changes visible content", async () => {
    const workspaceId = "queued-message-identity";
    mockChatStreamFor(workspaceId, async function* () {
      yield {
        type: "queued-message-changed",
        workspaceId,
        hasQueuedMessages: true,
        queuedMessages: ["first", "second"],
        displayText: "first\nsecond",
      };
      yield { type: "caught-up", hasOlderHistory: false };
      await tick(25);
      yield {
        type: "queued-message-changed",
        workspaceId,
        hasQueuedMessages: true,
        queuedMessages: ["second"],
        displayText: "second",
      };
    });

    createAndAddWorkspace(store, workspaceId);
    expect(await waitUntil(() => store.getWorkspaceState(workspaceId).queuedMessage != null)).toBe(
      true
    );
    const firstId = store.getWorkspaceState(workspaceId).queuedMessage?.id;

    expect(
      await waitUntil(
        () =>
          store.getWorkspaceState(workspaceId).queuedMessage?.content === "second" &&
          store.getWorkspaceState(workspaceId).queuedMessage?.id !== firstId
      )
    ).toBe(true);
  });

  describe("pending send", () => {
    const pendingSend = { id: "pending-1", content: "hello" };

    async function createCaughtUpWorkspace(
      workspaceId: string,
      liveEvents: (signal: AbortSignal | undefined) => AsyncIterable<WorkspaceChatMessage>
    ): Promise<void> {
      mockChatStreamFor(workspaceId, async function* (signal) {
        yield { type: "caught-up", hasOlderHistory: false };
        yield* liveEvents(signal);
      });
      createAndAddWorkspace(store, workspaceId);
      expect(await waitUntil(() => store.getWorkspaceState(workspaceId).isTranscriptCaughtUp)).toBe(
        true
      );
    }

    it("exposes the pending row until it is cleared by id", async () => {
      const workspaceId = "pending-send-clear";
      await createCaughtUpWorkspace(workspaceId, async function* (signal) {
        await waitForAbortSignal(signal);
        yield* [];
      });

      store.beginPendingSend(workspaceId, pendingSend);
      expect(store.getWorkspaceState(workspaceId).pendingSend).toEqual(pendingSend);

      store.clearPendingSend(workspaceId, "other-send");
      expect(store.getWorkspaceState(workspaceId).pendingSend).toEqual(pendingSend);

      store.clearPendingSend(workspaceId, pendingSend.id);
      expect(store.getWorkspaceState(workspaceId).pendingSend).toBeNull();
    });

    it("clears the pending row when the backend echoes a user message", async () => {
      const workspaceId = "pending-send-user-echo";
      let releaseEcho!: () => void;
      const echoGate = new Promise<void>((resolve) => {
        releaseEcho = resolve;
      });
      await createCaughtUpWorkspace(workspaceId, async function* (signal) {
        await echoGate;
        yield createUserMessageEvent("user-1", "hello", 1, 1);
        await waitForAbortSignal(signal);
      });

      store.beginPendingSend(workspaceId, pendingSend);
      releaseEcho();

      expect(await waitUntil(() => store.getWorkspaceState(workspaceId).pendingSend === null)).toBe(
        true
      );
      expect(store.getWorkspaceState(workspaceId).messages.some((m) => m.id === "user-1")).toBe(
        true
      );
    });

    it("clears the pending row when the send lands in the backend queue", async () => {
      const workspaceId = "pending-send-queued";
      let releaseQueue!: () => void;
      const queueGate = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      await createCaughtUpWorkspace(workspaceId, async function* (signal) {
        await queueGate;
        yield {
          type: "queued-message-changed",
          workspaceId,
          hasQueuedMessages: true,
          queuedMessages: ["hello"],
          displayText: "hello",
        };
        await waitForAbortSignal(signal);
      });

      store.beginPendingSend(workspaceId, pendingSend);
      releaseQueue();

      expect(
        await waitUntil(() => store.getWorkspaceState(workspaceId).queuedMessage !== null)
      ).toBe(true);
      expect(store.getWorkspaceState(workspaceId).pendingSend).toBeNull();
    });
  });

  describe("bash-output events", () => {
    it("retains live output when bash tool result has no output", async () => {
      const workspaceId = "bash-output-workspace-1";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        bashOutputEvent(workspaceId, "call-1", "out\n"),
        bashOutputEvent(workspaceId, "call-1", "err\n", { isError: true, timestamp: 2 }),
        // Simulate tmpfile overflow: tool result has no output field.
        toolCallEndEvent(
          workspaceId,
          "call-1",
          "bash",
          { success: false, error: "overflow", exitCode: -1, wall_duration_ms: 1 },
          { messageId: "m1", timestamp: 3 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const live = store.getBashToolLiveOutput(workspaceId, "call-1");
      expect(live).not.toBeNull();
      if (!live) throw new Error("Expected live output");

      // getSnapshot in useSyncExternalStore requires referential stability when unchanged.
      const liveAgain = store.getBashToolLiveOutput(workspaceId, "call-1");
      expect(liveAgain).toBe(live);

      expect(live.stdout).toContain("out");
      expect(live.stderr).toContain("err");
    });

    it("clears live output when bash tool result includes output", async () => {
      const workspaceId = "bash-output-workspace-2";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        bashOutputEvent(workspaceId, "call-2", "out\n"),
        toolCallEndEvent(
          workspaceId,
          "call-2",
          "bash",
          { success: true, output: "done", exitCode: 0, wall_duration_ms: 1 },
          { messageId: "m2", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const live = store.getBashToolLiveOutput(workspaceId, "call-2");
      expect(live).toBeNull();
    });

    it("replays pre-caught-up bash output after full replay catches up", async () => {
      const workspaceId = "bash-output-workspace-3";

      mockChatScript([
        bashOutputEvent(workspaceId, "call-3", "buffered\n"),
        Promise.resolve(),
        caughtUpEvent({ replay: "full" }),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const live = store.getBashToolLiveOutput(workspaceId, "call-3");
      expect(live).not.toBeNull();
      if (!live) throw new Error("Expected buffered live output after caught-up");
      expect(live.stdout).toContain("buffered");
    });
  });
  describe("advisor-phase events", () => {
    it("tracks the latest live advisor phase while the advisor tool is running", async () => {
      const workspaceId = "advisor-phase-workspace-1";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorPhaseEvent(workspaceId, "call-advisor-1", "preparing_context", 1),
        advisorPhaseEvent(workspaceId, "call-advisor-1", "waiting_for_response", 2),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLatestPhase = await waitUntil(
        () =>
          store.getAdvisorToolLivePhase(workspaceId, "call-advisor-1")?.phase ===
          "waiting_for_response"
      );
      expect(hasLatestPhase).toBe(true);

      const live = store.getAdvisorToolLivePhase(workspaceId, "call-advisor-1");
      expect(live).toEqual({
        phase: "waiting_for_response",
        timestamp: 2,
      });

      const liveAgain = store.getAdvisorToolLivePhase(workspaceId, "call-advisor-1");
      expect(liveAgain).toBe(live);
    });

    it("clears live advisor phase on advisor tool-call-end", async () => {
      const workspaceId = "advisor-phase-workspace-2";
      let releaseToolEnd: (() => void) | undefined;
      const waitForToolEnd = new Promise<void>((resolve) => {
        releaseToolEnd = resolve;
      });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorPhaseEvent(workspaceId, "call-advisor-2", "finalizing_result", 1),
        waitForToolEnd,
        toolCallEndEvent(
          workspaceId,
          "call-advisor-2",
          "advisor",
          { success: true },
          {
            messageId: "m-advisor-2",
            timestamp: 2,
          }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLivePhase = await waitUntil(
        () =>
          store.getAdvisorToolLivePhase(workspaceId, "call-advisor-2")?.phase ===
          "finalizing_result"
      );
      expect(hasLivePhase).toBe(true);

      releaseToolEnd?.();

      const clearedLivePhase = await waitUntil(
        () => store.getAdvisorToolLivePhase(workspaceId, "call-advisor-2") === undefined
      );
      expect(clearedLivePhase).toBe(true);
    });

    it("ignores duplicate advisor phases for the same tool call", async () => {
      const workspaceId = "advisor-phase-workspace-3";
      let releaseDuplicate: (() => void) | undefined;
      const waitForDuplicate = new Promise<void>((resolve) => {
        releaseDuplicate = resolve;
      });

      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          advisorPhaseEvent(workspaceId, "call-advisor-3", "waiting_for_response", 1),
          waitForDuplicate,
          advisorPhaseEvent(workspaceId, "call-advisor-3", "waiting_for_response", 2),
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId);

      const hasInitialPhase = await waitUntil(
        () => store.getAdvisorToolLivePhase(workspaceId, "call-advisor-3")?.timestamp === 1
      );
      expect(hasInitialPhase).toBe(true);

      const live = store.getAdvisorToolLivePhase(workspaceId, "call-advisor-3");
      expect(live).toEqual({
        phase: "waiting_for_response",
        timestamp: 1,
      });
      if (!live) throw new Error("Expected live advisor phase");

      let notificationCount = 0;
      const unsubscribe = store.subscribeKey(workspaceId, () => {
        notificationCount += 1;
      });

      releaseDuplicate?.();
      await tick(10);

      const liveAfterDuplicate = store.getAdvisorToolLivePhase(workspaceId, "call-advisor-3");
      expect(liveAfterDuplicate).toBe(live);
      expect(liveAfterDuplicate).toEqual({
        phase: "waiting_for_response",
        timestamp: 1,
      });
      expect(notificationCount).toBe(0);

      unsubscribe();
    });
  });

  describe("advisor-output events", () => {
    it("accumulates live advisor output while the advisor tool is running", async () => {
      const workspaceId = "advisor-output-workspace-1";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorOutputEvent(workspaceId, "call-advisor-output-1", "first ", 1),
        advisorOutputEvent(workspaceId, "call-advisor-output-1", "second", 2),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLiveOutput = await waitUntil(
        () =>
          store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-1")?.text ===
          "first second"
      );
      expect(hasLiveOutput).toBe(true);

      const live = store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-1");
      expect(live).toEqual({ text: "first second", timestamp: 2 });
      expect(store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-1")).toBe(live);
    });

    it("clears live advisor output on advisor tool-call-end", async () => {
      const workspaceId = "advisor-output-workspace-2";
      let releaseToolEnd: (() => void) | undefined;
      const waitForToolEnd = new Promise<void>((resolve) => {
        releaseToolEnd = resolve;
      });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorOutputEvent(workspaceId, "call-advisor-output-2", "partial advice", 1),
        waitForToolEnd,
        toolCallEndEvent(
          workspaceId,
          "call-advisor-output-2",
          "advisor",
          { type: "advice", advice: "partial advice" },
          { messageId: "m-advisor-output-2", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLiveOutput = await waitUntil(
        () =>
          store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-2")?.text ===
          "partial advice"
      );
      expect(hasLiveOutput).toBe(true);

      releaseToolEnd?.();

      const clearedLiveOutput = await waitUntil(
        () => store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-2") === null
      );
      expect(clearedLiveOutput).toBe(true);
    });

    it("clears stale live advisor output after message deletion", async () => {
      const workspaceId = "advisor-output-workspace-delete";
      let releaseDelete: (() => void) | undefined;
      const waitForDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorOutputEvent(workspaceId, "call-advisor-output-delete", "stale partial advice", 1),
        waitForDelete,
        { type: "delete", historySequences: [1] },
      ]);

      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        advisorLiveStore: { has: (key: string) => boolean };
      }>(store);
      const advisorKey = `${workspaceId}\u0000call-advisor-output-delete`;

      const hasLiveOutput = await waitUntil(
        () =>
          store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-delete")?.text ===
          "stale partial advice"
      );
      expect(hasLiveOutput).toBe(true);
      expect(rawStore.advisorLiveStore.has(advisorKey)).toBe(true);

      releaseDelete?.();

      const clearedLiveOutput = await waitUntil(
        () => store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-delete") === null
      );
      expect(clearedLiveOutput).toBe(true);
      // The delete-time sweep must release the keyed channel as well: with the
      // transient entry gone, no later sweep can rediscover this key.
      expect(rawStore.advisorLiveStore.has(advisorKey)).toBe(false);
    });

    it("releases keyed advisor channels when a full replay resets transient state", async () => {
      const workspaceId = "advisor-output-full-replay-reset";

      mockChatScript(
        [
          caughtUpEvent(),
          Promise.resolve(),
          advisorOutputEvent(workspaceId, "call-advisor-replay-reset", "partial advice", 1),
        ],
        { keepOpen: true }
      );

      createAndAddWorkspace(store, workspaceId);
      const rawStore = getInternal<{
        advisorLiveStore: { has: (key: string) => boolean };
        resetChatStateForReplay: (workspaceId: string) => void;
      }>(store);
      const advisorKey = `${workspaceId}\u0000call-advisor-replay-reset`;

      const hasLiveOutput = await waitUntil(
        () =>
          store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-replay-reset")?.text ===
          "partial advice"
      );
      expect(hasLiveOutput).toBe(true);
      expect(rawStore.advisorLiveStore.has(advisorKey)).toBe(true);

      rawStore.resetChatStateForReplay(workspaceId);

      // The replaced transient maps were the only record of this tool-call ID,
      // so the reset itself must release the keyed channel.
      expect(rawStore.advisorLiveStore.has(advisorKey)).toBe(false);
    });

    it("replays pre-caught-up advisor output after full replay catches up", async () => {
      const workspaceId = "advisor-output-workspace-3";

      mockChatScript([
        advisorOutputEvent(workspaceId, "call-advisor-output-3", "buffered advice", 1),
        Promise.resolve(),
        caughtUpEvent({ replay: "full" }),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLiveOutput = await waitUntil(
        () =>
          store.getAdvisorToolLiveOutput(workspaceId, "call-advisor-output-3")?.text ===
          "buffered advice"
      );
      expect(hasLiveOutput).toBe(true);
    });
  });

  describe("advisor-reasoning-output events", () => {
    it("accumulates live advisor reasoning while the advisor tool is running", async () => {
      const workspaceId = "advisor-reasoning-workspace-1";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorReasoningOutputEvent(workspaceId, "call-advisor-reasoning-1", "thinking ", 1),
        advisorReasoningOutputEvent(workspaceId, "call-advisor-reasoning-1", "through risk", 2),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLiveReasoning = await waitUntil(
        () =>
          store.getAdvisorToolLiveReasoning(workspaceId, "call-advisor-reasoning-1")?.text ===
          "thinking through risk"
      );
      expect(hasLiveReasoning).toBe(true);

      const live = store.getAdvisorToolLiveReasoning(workspaceId, "call-advisor-reasoning-1");
      expect(live).toEqual({ text: "thinking through risk", timestamp: 2 });
      expect(store.getAdvisorToolLiveReasoning(workspaceId, "call-advisor-reasoning-1")).toBe(live);
    });

    it("clears live advisor reasoning on advisor tool-call-end", async () => {
      const workspaceId = "advisor-reasoning-workspace-2";
      let releaseToolEnd: (() => void) | undefined;
      const waitForToolEnd = new Promise<void>((resolve) => {
        releaseToolEnd = resolve;
      });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        advisorReasoningOutputEvent(workspaceId, "call-advisor-reasoning-2", "partial thought", 1),
        waitForToolEnd,
        toolCallEndEvent(
          workspaceId,
          "call-advisor-reasoning-2",
          "advisor",
          { type: "advice", advice: "final advice" },
          { messageId: "m-advisor-reasoning-2", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);

      const hasLiveReasoning = await waitUntil(
        () =>
          store.getAdvisorToolLiveReasoning(workspaceId, "call-advisor-reasoning-2")?.text ===
          "partial thought"
      );
      expect(hasLiveReasoning).toBe(true);

      releaseToolEnd?.();

      const clearedLiveReasoning = await waitUntil(
        () => store.getAdvisorToolLiveReasoning(workspaceId, "call-advisor-reasoning-2") === null
      );
      expect(clearedLiveReasoning).toBe(true);
    });
  });

  describe("workflow-run-attached events", () => {
    it("exposes the exact workflow run while the workflow tool is running", async () => {
      const workspaceId = "workflow-run-attached-workspace-1";
      const run = createWorkflowRunRecord({ id: "wfr_live", workspaceId });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        workflowRunAttachedEvent(workspaceId, "call-workflow-1", run.id, 1, run),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkflowToolLiveRun(workspaceId, "call-workflow-1")).toEqual({
        runId: "wfr_live",
        run,
      });
    });

    it("retains an existing workflow run snapshot when a later attachment omits it", async () => {
      const workspaceId = "workflow-run-attached-workspace-retain-run";
      const run = createWorkflowRunRecord({ id: "wfr_retained", workspaceId });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        workflowRunAttachedEvent(workspaceId, "call-workflow-retain", run.id, 1, run),
        workflowRunAttachedEvent(workspaceId, "call-workflow-retain", run.id, 2),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkflowToolLiveRun(workspaceId, "call-workflow-retain")).toEqual({
        runId: "wfr_retained",
        run,
      });
    });

    it("replays pre-caught-up workflow run attachments after full replay catches up", async () => {
      const workspaceId = "workflow-run-attached-workspace-2";
      const run = createWorkflowRunRecord({ id: "wfr_replayed", workspaceId });

      mockChatScript([
        workflowRunAttachedEvent(workspaceId, "call-workflow-2", run.id, 1, run),
        Promise.resolve(),
        { type: "caught-up", replay: "full" },
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkflowToolLiveRun(workspaceId, "call-workflow-2")).toEqual({
        runId: "wfr_replayed",
        run,
      });
    });

    it("keeps workflow run attachment hints when a background resume result omits the run", async () => {
      const workspaceId = "workflow-run-attached-workspace-keep-after-result";
      const run = createWorkflowRunRecord({
        id: "wfr_keep_after_result",
        workspaceId,
        status: "interrupted",
      });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        workflowRunAttachedEvent(workspaceId, "call-workflow-keep", run.id, 1, run),
        toolCallEndEvent(
          workspaceId,
          "call-workflow-keep",
          "workflow_resume",
          { status: "running", runId: run.id, result: null, mode: "resume" },
          { messageId: "m-workflow-keep", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkflowToolLiveRun(workspaceId, "call-workflow-keep")).toEqual({
        runId: run.id,
        run,
      });
    });

    it("clears workflow run attachment hints when the workflow tool result arrives", async () => {
      const workspaceId = "workflow-run-attached-workspace-3";
      const run = createWorkflowRunRecord({ id: "wfr_cleared", workspaceId });

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        workflowRunAttachedEvent(workspaceId, "call-workflow-3", run.id, 1, run),
        toolCallEndEvent(
          workspaceId,
          "call-workflow-3",
          "workflow_run",
          { status: "completed", runId: run.id, result: null, run },
          { messageId: "m-workflow-3", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getWorkflowToolLiveRun(workspaceId, "call-workflow-3")).toBeNull();
    });
  });

  describe("task-created events", () => {
    it("exposes live taskId while the task tool is running", async () => {
      const workspaceId = "task-created-workspace-1";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        taskCreatedEvent(workspaceId, "call-task-1", "child-workspace-1", 1),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getTaskToolLiveTaskIds(workspaceId, "call-task-1")).toEqual([
        "child-workspace-1",
      ]);
    });

    it("accumulates multiple live taskIds for best-of task tool calls", async () => {
      const workspaceId = "task-created-workspace-best-of";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        taskCreatedEvent(workspaceId, "call-task-best-of", "child-workspace-1", 1),
        taskCreatedEvent(workspaceId, "call-task-best-of", "child-workspace-2", 2),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getTaskToolLiveTaskIds(workspaceId, "call-task-best-of")).toEqual([
        "child-workspace-1",
        "child-workspace-2",
      ]);
    });

    it("clears live taskId on task tool-call-end", async () => {
      const workspaceId = "task-created-workspace-2";

      mockChatScript([
        caughtUpEvent(),
        Promise.resolve(),
        taskCreatedEvent(workspaceId, "call-task-2", "child-workspace-2", 1),
        toolCallEndEvent(
          workspaceId,
          "call-task-2",
          "task",
          { status: "queued", taskId: "child-workspace-2" },
          { messageId: "m-task-2", timestamp: 2 }
        ),
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      expect(store.getTaskToolLiveTaskIds(workspaceId, "call-task-2")).toBeNull();
    });

    it("clears stale active stream context when since replay reports a different stream", async () => {
      const workspaceId = "task-created-workspace-5";
      const firstSubscription = createReleaseGate();
      const getSubscriptionCount = mockChatReconnectScript((subscriptionCount) =>
        subscriptionCount === 1
          ? [
              createHistoryMessageEvent("history-1", 1),
              fullCaughtUpEvent(),
              Promise.resolve(),
              streamStartEvent(workspaceId, "msg-old-stream", {
                historySequence: 2,
                startTime: 1_000,
                model: "claude-3-5-sonnet-20241022",
              }),
              bashOutputEvent(workspaceId, "call-bash-5", "old-stream-output\n", {
                timestamp: 1_001,
              }),
              taskCreatedEvent(workspaceId, "call-task-5", "child-workspace-5", 1_002),
              firstSubscription.wait,
            ]
          : [
              // Since replay re-sends the cursor-boundary row before caught-up.
              createHistoryMessageEvent("history-1", 1),
              sinceCaughtUpEvent(1, "history-1", {
                messageId: "msg-new-stream",
                lastTimestamp: 2_000,
              }),
              Promise.resolve(),
              streamStartEvent(workspaceId, "msg-new-stream", {
                historySequence: 2,
                model: "claude-3-5-sonnet-20241022",
                startTime: 2_000,
              }),
            ]
      );

      createAndAddWorkspace(store, workspaceId);

      const seededOldStream = await waitUntil(() => {
        return (
          store.getAggregator(workspaceId)?.getOnChatCursor()?.stream?.messageId ===
          "msg-old-stream"
        );
      });
      expect(seededOldStream).toBe(true);
      expect(store.getBashToolLiveOutput(workspaceId, "call-bash-5")?.stdout).toContain(
        "old-stream-output"
      );
      expect(store.getTaskToolLiveTaskIds(workspaceId, "call-task-5")).toEqual([
        "child-workspace-5",
      ]);

      firstSubscription.release();

      const switchedToNewStream = await waitUntil(() => {
        return (
          getSubscriptionCount() >= 2 &&
          store.getAggregator(workspaceId)?.getOnChatCursor()?.stream?.messageId ===
            "msg-new-stream" &&
          store.getBashToolLiveOutput(workspaceId, "call-bash-5") === null &&
          store.getTaskToolLiveTaskIds(workspaceId, "call-task-5") === null
        );
      });
      expect(switchedToNewStream).toBe(true);
    });

    it("reuses the server-issued cursor verbatim on the next subscription", async () => {
      const workspaceId = "cursor-reuse-workspace";
      const serverCursor = {
        messageId: "history-7",
        historySequence: 7,
        oldestHistorySequence: 3,
        priorHistoryFingerprint: "0badf00d",
      };
      const firstSubscription = createReleaseGate();
      const requestedModes: unknown[] = [];
      let subscriptionCount = 0;

      mockOnChat.mockImplementation(async function* (
        input?: { workspaceId: string; mode?: unknown },
        _options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        subscriptionCount += 1;
        requestedModes.push(input?.mode);
        if (subscriptionCount === 1) {
          yield createHistoryMessageEvent("history-7", 7);
          yield caughtUpEvent({ replay: "full", cursor: { history: serverCursor } });
          await firstSubscription.wait;
          return;
        }
        yield createHistoryMessageEvent("history-7", 7);
        yield caughtUpEvent({ replay: "since", cursor: { history: serverCursor } });
      });

      createAndAddWorkspace(store, workspaceId);

      const hydrated = await waitUntil(
        () => store.getAggregator(workspaceId)?.getAllMessages().length === 1
      );
      expect(hydrated).toBe(true);
      expect(requestedModes[0]).toBeUndefined();

      firstSubscription.release();

      const resubscribed = await waitUntil(() => subscriptionCount >= 2);
      expect(resubscribed).toBe(true);
      // The client must not recompute any cursor fields; the server-issued cursor is
      // reused verbatim (fingerprint included).
      expect(requestedModes[1]).toEqual({
        type: "since",
        cursor: { history: serverCursor },
      });
    });

    it("forces a full resubscribe when caught-up carries no cursor", async () => {
      const workspaceId = "cursor-missing-workspace";
      const firstSubscription = createReleaseGate();
      const requestedModes: unknown[] = [];
      let subscriptionCount = 0;

      mockOnChat.mockImplementation(async function* (
        input?: { workspaceId: string; mode?: unknown },
        _options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        subscriptionCount += 1;
        requestedModes.push(input?.mode);
        // Replay failures make the server omit the cursor from caught-up.
        yield createHistoryMessageEvent("history-1", 1);
        yield caughtUpEvent({ replay: "full" });
        if (subscriptionCount === 1) {
          await firstSubscription.wait;
        }
      });

      createAndAddWorkspace(store, workspaceId);

      const hydrated = await waitUntil(
        () => store.getAggregator(workspaceId)?.getAllMessages().length === 1
      );
      expect(hydrated).toBe(true);

      firstSubscription.release();

      const resubscribed = await waitUntil(() => subscriptionCount >= 2);
      expect(resubscribed).toBe(true);
      expect(requestedModes[1]).toBeUndefined();
    });

    it("uses compaction boundary context usage when it is the newest usage in the active epoch", async () => {
      const workspaceId = "boundary-context-usage-workspace";

      mockChatScript([
        Promise.resolve(),
        {
          type: "message",
          id: "pre-boundary-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Older context usage" }],
          metadata: {
            historySequence: 1,
            timestamp: 1,
            model: "claude-3-5-sonnet-20241022",
            contextUsage: { inputTokens: 999, outputTokens: 10, totalTokens: undefined },
          },
        },
        {
          type: "message",
          id: "compaction-boundary-summary",
          role: "assistant",
          parts: [{ type: "text", text: "Compacted summary" }],
          metadata: {
            historySequence: 2,
            timestamp: 2,
            model: "claude-3-5-sonnet-20241022",
            compacted: "idle",
            compactionBoundary: true,
            compactionEpoch: 1,
            contextUsage: { inputTokens: 42, outputTokens: 0, totalTokens: undefined },
          },
        },
        { type: "caught-up" },
      ]);

      createAndAddWorkspace(store, workspaceId);
      await tick(10);

      const usage = store.getWorkspaceUsage(workspaceId);
      expect(usage.lastContextUsage?.input.tokens).toBe(42);
      expect(usage.lastContextUsage?.output.tokens).toBe(0);
      expect(usage.lastContextUsage?.model).toBe("claude-3-5-sonnet-20241022");
    });
  });

  describe("mergeTimelineEvents", () => {
    const event = (seq: number) => ({
      v: 1 as const,
      seq,
      id: `event-${seq}`,
      ts: seq,
      kind: "turn.completed",
      source: { system: "workspace" as const },
    });

    it("prepends newer live batches without reordering retained history", () => {
      const newest = [event(6), event(5)];
      const retained = [event(4), event(3), event(2)];

      expect(mergeTimelineEvents(newest, retained).map((item) => item.seq)).toEqual([
        6, 5, 4, 3, 2,
      ]);
    });

    it("normalizes queued live batches that arrive oldest-first", () => {
      const queuedLive = [event(5), event(6)];
      const retained = [event(4), event(3), event(2)];

      expect(mergeTimelineEvents(queuedLive, retained).map((item) => item.seq)).toEqual([
        6, 5, 4, 3, 2,
      ]);
    });

    it("appends older pages without reordering retained history", () => {
      const retained = [event(6), event(5), event(4)];
      const older = [event(3), event(2)];

      expect(mergeTimelineEvents(retained, older).map((item) => item.seq)).toEqual([6, 5, 4, 3, 2]);
    });

    it("falls back to dedupe and ordering for overlapping batches", () => {
      expect(
        mergeTimelineEvents([event(5), event(3)], [event(4), event(3)]).map((item) => item.seq)
      ).toEqual([5, 4, 3]);
    });
  });

  describe("getWorkspaceLastUserPrompt", () => {
    const seedUserMessages = (workspaceId: string, rows: Array<{ id: string; text: string }>) => {
      const rawStore = getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store);
      rawStore.handleChatMessage(workspaceId, caughtUpEvent());
      rows.forEach((row, index) => {
        rawStore.handleChatMessage(workspaceId, {
          type: "message",
          id: row.id,
          role: "user",
          parts: [{ type: "text", text: row.text }],
          metadata: {
            historySequence: index + 1,
            timestamp: (index + 1) * 1_000,
          },
        });
      });
    };

    it("returns the most recent typed prompt", () => {
      const workspaceId = "last-prompt-basic";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [
        { id: "u1", text: "first prompt" },
        { id: "u2", text: "second prompt" },
      ]);

      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBe("second prompt");
    });

    it("keeps scanning past an attachment-only turn with empty text", () => {
      const workspaceId = "last-prompt-attachment-only";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [
        { id: "u1", text: "describe this screenshot" },
        { id: "u2", text: "   " },
      ]);

      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBe("describe this screenshot");
    });

    it("keeps scanning past a staged-attachment notice", () => {
      const workspaceId = "last-prompt-staged-notice";
      createAndAddWorkspace(store, workspaceId);
      const notice = buildStagedAttachmentNotice([
        {
          kind: "staged",
          id: "csv-1",
          filename: "data.csv",
          mediaType: "text/csv",
          sizeBytes: 34,
          stagedPath: ".mux/user-attachments/id/data.csv",
        },
      ]);
      seedUserMessages(workspaceId, [
        { id: "u1", text: "summarize the attached data" },
        { id: "u2", text: notice.trimStart() },
      ]);

      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBe("summarize the attached data");
    });

    it("returns null when every user turn is empty", () => {
      const workspaceId = "last-prompt-all-empty";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [{ id: "u1", text: "" }]);

      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBeNull();
    });

    it("does not invalidate the footer prompt projection for assistant stream deltas", () => {
      const workspaceId = "last-prompt-stream-deltas";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [{ id: "u1", text: "first prompt" }]);
      const listener = mock(() => undefined);
      const unsubscribe = store.subscribeLastUserPrompt(workspaceId, listener);
      const snapshot = store.getWorkspaceLastUserPromptSnapshot(workspaceId);

      const rawStore = getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store);
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-1",
        model: "claude-haiku-3.5",
        historySequence: 2,
        startTime: 2_000,
      });
      rawStore.handleChatMessage(workspaceId, {
        type: "stream-delta",
        workspaceId,
        messageId: "assistant-1",
        delta: "working",
        tokens: 2,
        timestamp: 2_100,
      });

      expect(listener).not.toHaveBeenCalled();
      expect(store.getWorkspaceLastUserPromptSnapshot(workspaceId)).toBe(snapshot);
      unsubscribe();
    });

    it("holds the history epoch steady while messages stream in", () => {
      const workspaceId = "last-prompt-epoch-stable";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [{ id: "u1", text: "first prompt" }]);
      const epoch = store.getWorkspaceHistoryEpoch(workspaceId);

      getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store).handleChatMessage(workspaceId, {
        type: "message",
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "second prompt" }],
        metadata: { historySequence: 2, timestamp: 2_000 },
      });

      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBe("second prompt");
      expect(store.getWorkspaceHistoryEpoch(workspaceId)).toBe(epoch);
    });

    it("advances the history epoch when rows this window never held are deleted", () => {
      const workspaceId = "last-prompt-epoch-clear";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [{ id: "u1", text: "first prompt" }]);
      const epoch = store.getWorkspaceHistoryEpoch(workspaceId);

      getInternal<{
        handleChatMessage: (workspaceId: string, data: WorkspaceChatMessage) => void;
      }>(store).handleChatMessage(workspaceId, {
        type: "delete",
        historySequences: [99],
      });

      expect(store.getWorkspaceHistoryEpoch(workspaceId)).toBeGreaterThan(epoch);
      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBe("first prompt");
    });

    it("advances the history epoch when a full replay replaces the transcript", () => {
      const workspaceId = "last-prompt-epoch-replay";
      createAndAddWorkspace(store, workspaceId);
      seedUserMessages(workspaceId, [{ id: "u1", text: "first prompt" }]);
      const epoch = store.getWorkspaceHistoryEpoch(workspaceId);

      getInternal<{ aggregators: Map<string, StreamingMessageAggregator> }>(store)
        .aggregators.get(workspaceId)!
        .loadHistoricalMessages([], false, { mode: "replace" });

      expect(store.getWorkspaceHistoryEpoch(workspaceId)).toBeGreaterThan(epoch);
      expect(store.getWorkspaceLastUserPrompt(workspaceId)).toBeNull();
    });
  });
});

describe("findRenderedRefineProposalHash", () => {
  const HASH = "a".repeat(64);
  const CREATED_AT = "2024-01-01T00:00:00.000Z";
  const proposalRow = () =>
    createMuxMessage("refine-1", "assistant", "Staged 2 edits", {
      timestamp: 1,
      historySequence: 1,
      muxMetadata: { type: "refine-summary", stagedSetHash: HASH },
    });
  const assistantFiller = (count: number, startSeq: number) =>
    Array.from({ length: count }, (_, i) =>
      createMuxMessage(`filler-${i}`, "assistant", `row ${i}`, {
        timestamp: startSeq + i,
        historySequence: startSeq + i,
      })
    );

  it("returns the newest rendered proposal hash", () => {
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages([proposalRow(), ...assistantFiller(3, 2)], false);
    expect(findRenderedRefineProposalHash(aggregator)).toBe(HASH);
  });

  it("ignores a proposal row hidden by the display cap until Load all reveals it (r68)", () => {
    // A staged proposal (e.g. from a foreign backend) buried behind enough
    // later chat falls out of the rendered window: approving it would apply
    // edits this user never saw, so the scan must not surface its hash from
    // internal history.
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages([proposalRow(), ...assistantFiller(200, 2)], false);
    expect(findRenderedRefineProposalHash(aggregator)).toBeNull();
    // "Load all" disables the cap: the proposal is now actually rendered.
    aggregator.setShowAllMessages(true);
    expect(findRenderedRefineProposalHash(aggregator)).toBe(HASH);
  });
});
