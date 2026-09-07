import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { STOP_UNRECORDED_MESSAGE } from "../../src/common/constants/workspace";
import type { OnChatMode, WorkspaceChatMessage } from "../../src/common/orpc/types";
import { MuxAgent } from "../../src/node/acp/agent";
import type { ORPCClient, ServerConnection } from "../../src/node/acp/serverConnection";

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;

interface Harness {
  agent: MuxAgent;
  sendMessageCalls: Array<{
    workspaceId: string;
    message: string;
    options: Record<string, unknown>;
  }>;
  delegatedToolAnswers: Array<{
    workspaceId: string;
    toolCallId: string;
    result: unknown;
  }>;
  interruptCalls: Array<{
    workspaceId: string;
    options?: Record<string, unknown>;
  }>;
  pushChatEvent: (event: WorkspaceChatMessage) => void;
  closeConnection: () => void;
  connectionClosed: Promise<void>;
}

function createWorkspaceInfo(overrides?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws-default",
    name: "ws-default",
    title: "Default workspace",
    projectName: "project",
    projectPath: "/repo/default",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/repo/default/.mux/ws-default",
    agentId: "exec",
    aiSettings: {
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "medium",
    },
    aiSettingsByAgent: {
      exec: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
    },
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function createControllableAcpStream(options?: { output?: WritableStream<Uint8Array> }): {
  stream: ReturnType<typeof ndJsonStream>;
  closeInput: () => void;
} {
  let inputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      inputController = controller;
    },
  });

  const output = options?.output ?? new WritableStream<Uint8Array>({});
  return {
    stream: ndJsonStream(output, input),
    closeInput: () => {
      inputController?.close();
    },
  };
}

function createControlledChatStream(): {
  stream: AsyncIterable<WorkspaceChatMessage>;
  push: (event: WorkspaceChatMessage) => void;
} {
  const pendingEvents: WorkspaceChatMessage[] = [];
  let pendingResolve: ((result: IteratorResult<WorkspaceChatMessage>) => void) | null = null;

  const push = (event: WorkspaceChatMessage) => {
    if (pendingResolve != null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ done: false, value: event });
      return;
    }

    pendingEvents.push(event);
  };

  const stream: AsyncIterable<WorkspaceChatMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          if (pendingEvents.length > 0) {
            const next = pendingEvents.shift();
            if (next == null) {
              return { done: true, value: undefined };
            }
            return { done: false, value: next };
          }

          return new Promise<IteratorResult<WorkspaceChatMessage>>((resolve) => {
            pendingResolve = resolve;
          });
        },
      };
    },
  };

  return { stream, push };
}

function createDelayedTeardownChatStream(): {
  stream: AsyncIterable<WorkspaceChatMessage>;
  returnCalled: Promise<void>;
  releaseTeardown: () => void;
  returnCompleted: Promise<void>;
} {
  let pendingResolve: ((result: IteratorResult<WorkspaceChatMessage>) => void) | null = null;
  let isClosed = false;

  let resolveReturnCalled!: () => void;
  const returnCalled = new Promise<void>((resolve) => {
    resolveReturnCalled = resolve;
  });

  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });

  let resolveReturnCompleted!: () => void;
  const returnCompleted = new Promise<void>((resolve) => {
    resolveReturnCompleted = resolve;
  });

  const closeIterator = () => {
    isClosed = true;
    if (pendingResolve != null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ done: true, value: undefined });
    }
  };

  const stream: AsyncIterable<WorkspaceChatMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          if (isClosed) {
            return { done: true, value: undefined };
          }

          return await new Promise<IteratorResult<WorkspaceChatMessage>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          closeIterator();
          resolveReturnCalled();
          await teardownGate;
          resolveReturnCompleted();
          return { done: true, value: undefined };
        },
      };
    },
  };

  return {
    stream,
    returnCalled,
    releaseTeardown,
    returnCompleted,
  };
}

function createLingeringTeardownChatStream(): {
  stream: AsyncIterable<WorkspaceChatMessage>;
  push: (event: WorkspaceChatMessage) => void;
  returnCalled: Promise<void>;
  releaseTeardown: () => void;
  returnCompleted: Promise<void>;
} {
  const pendingEvents: WorkspaceChatMessage[] = [];
  let pendingResolve: ((result: IteratorResult<WorkspaceChatMessage>) => void) | null = null;
  let isClosed = false;

  let resolveReturnCalled!: () => void;
  const returnCalled = new Promise<void>((resolve) => {
    resolveReturnCalled = resolve;
  });

  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });

  let resolveReturnCompleted!: () => void;
  const returnCompleted = new Promise<void>((resolve) => {
    resolveReturnCompleted = resolve;
  });

  const closeIterator = () => {
    isClosed = true;
    if (pendingResolve != null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ done: true, value: undefined });
    }
  };

  const push = (event: WorkspaceChatMessage) => {
    if (isClosed) {
      return;
    }

    if (pendingResolve != null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ done: false, value: event });
      return;
    }

    pendingEvents.push(event);
  };

  const stream: AsyncIterable<WorkspaceChatMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          if (isClosed) {
            return { done: true, value: undefined };
          }

          if (pendingEvents.length > 0) {
            const next = pendingEvents.shift();
            if (next == null) {
              return { done: true, value: undefined };
            }
            return { done: false, value: next };
          }

          return await new Promise<IteratorResult<WorkspaceChatMessage>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          resolveReturnCalled();
          await teardownGate;
          closeIterator();
          resolveReturnCompleted();
          return { done: true, value: undefined };
        },
      };
    },
  };

  return {
    stream,
    push,
    returnCalled,
    releaseTeardown,
    returnCompleted,
  };
}

interface HarnessOptions {
  onChat?: (input: {
    workspaceId: string;
    mode?: OnChatMode;
  }) => Promise<AsyncIterable<WorkspaceChatMessage>>;
  sendMessage?: (input: {
    workspaceId: string;
    message: string;
    options: Record<string, unknown>;
  }) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  interruptStream?: (input: {
    workspaceId: string;
    options?: Record<string, unknown>;
  }) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  /** Custom output WritableStream for simulating stdout backpressure. */
  acpOutputStream?: WritableStream<Uint8Array>;
  agentOptions?: ConstructorParameters<typeof MuxAgent>[2];
}

function createHarness(options?: HarnessOptions): Harness {
  const workspacesById = new Map<string, WorkspaceInfo>();
  let workspaceIdCounter = 0;
  const sendMessageCalls: Array<{
    workspaceId: string;
    message: string;
    options: Record<string, unknown>;
  }> = [];
  const delegatedToolAnswers: Array<{
    workspaceId: string;
    toolCallId: string;
    result: unknown;
  }> = [];
  const interruptCalls: Array<{
    workspaceId: string;
    options?: Record<string, unknown>;
  }> = [];
  const chatStream = createControlledChatStream();

  const client = {
    config: {
      getConfig: async () => ({}),
    },
    projects: {
      list: async () => [],
      listBranches: async () => ({
        branches: ["main"],
        currentBranch: "main",
        recommendedTrunk: "main",
      }),
      setTrust: async () => {},
    },
    agents: {
      list: async () => [],
    },
    agentSkills: {
      list: async () => [],
      listDiagnostics: async () => {
        throw new Error("createHarness: listDiagnostics not implemented for this test");
      },
      get: async () => {
        throw new Error("createHarness: get not implemented for this test");
      },
    },
    workspace: {
      create: async (input: {
        projectPath: string;
        branchName: string;
        trunkBranch?: string;
        title?: string;
        runtimeConfig?: WorkspaceInfo["runtimeConfig"];
      }) => {
        workspaceIdCounter += 1;
        const workspaceId = `ws-${workspaceIdCounter}`;
        const metadata = createWorkspaceInfo({
          id: workspaceId,
          name: input.branchName,
          title: input.title ?? input.branchName,
          projectPath: input.projectPath,
          namedWorkspacePath: `${input.projectPath}/.mux/${input.branchName}`,
          runtimeConfig: input.runtimeConfig ?? { type: "local" },
        });
        workspacesById.set(workspaceId, metadata);

        return {
          success: true as const,
          metadata,
        };
      },
      getInfo: async ({ workspaceId }: { workspaceId: string }) =>
        workspacesById.get(workspaceId) ?? null,
      onChat: async (input: { workspaceId: string; mode?: OnChatMode }) =>
        (await options?.onChat?.(input)) ?? chatStream.stream,
      sendMessage: async (input: {
        workspaceId: string;
        message: string;
        options: Record<string, unknown>;
      }) => {
        sendMessageCalls.push(input);
        if (options?.sendMessage != null) {
          return await options.sendMessage(input);
        }
        return { success: true as const, data: {} };
      },
      answerDelegatedToolCall: async (input: {
        workspaceId: string;
        toolCallId: string;
        result: unknown;
      }) => {
        delegatedToolAnswers.push(input);
        return { success: true as const, data: undefined };
      },
      interruptStream: async (input: {
        workspaceId: string;
        options?: Record<string, unknown>;
      }) => {
        interruptCalls.push(input);
        if (options?.interruptStream != null) {
          return await options.interruptStream(input);
        }
        return { success: true as const, data: undefined };
      },
      updateModeAISettings: async () => ({ success: true as const, data: undefined }),
      updateAgentAISettings: async () => ({ success: true as const, data: undefined }),
    },
  };

  const server: ServerConnection = {
    client: client as unknown as ORPCClient,
    baseUrl: "ws://127.0.0.1:1234",
    close: async () => undefined,
  };

  const { stream, closeInput } = createControllableAcpStream({
    output: options?.acpOutputStream,
  });

  let agentInstance: MuxAgent | null = null;
  const connection = new AgentSideConnection((connectionToAgent) => {
    const createdAgent = new MuxAgent(connectionToAgent, server, options?.agentOptions);
    agentInstance = createdAgent;
    return createdAgent;
  }, stream);

  if (agentInstance == null) {
    throw new Error("createHarness: failed to construct MuxAgent");
  }

  return {
    agent: agentInstance,
    sendMessageCalls,
    delegatedToolAnswers,
    interruptCalls,
    pushChatEvent: chatStream.push,
    closeConnection: closeInput,
    connectionClosed: connection.closed,
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitForCondition: timed out");
    }
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLastMuxMetadata(harness: Harness): Record<string, unknown> {
  const lastSend = harness.sendMessageCalls.at(-1);
  if (lastSend == null) {
    throw new Error("Expected prompt send call before reading muxMetadata");
  }

  const muxMetadata = lastSend.options["muxMetadata"];
  if (!isRecord(muxMetadata)) {
    throw new Error("Expected prompt send options to include muxMetadata record");
  }

  return muxMetadata;
}

function getPromptCorrelationId(harness: Harness): string {
  const promptCorrelationId = getLastMuxMetadata(harness)["acpPromptId"];
  if (typeof promptCorrelationId !== "string") {
    throw new Error("Expected prompt send options to include acpPromptId");
  }

  return promptCorrelationId;
}

async function initializeDefaultAgent(harness: Harness): Promise<void> {
  await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
}

async function createDefaultSession(harness: Harness, cwd = "/repo/acp-go-sdk") {
  return await harness.agent.newSession({
    cwd,
    mcpServers: [],
    _meta: { trunkBranch: "main" },
  });
}

async function startPromptTurn(
  harness: Harness,
  sessionId: string,
  text = "hello"
): Promise<{
  promptPromise: ReturnType<MuxAgent["prompt"]>;
  promptCorrelationId: string;
}> {
  const promptPromise = harness.agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  });

  await waitForCondition(() => harness.sendMessageCalls.length > 0);
  return { promptPromise, promptCorrelationId: getPromptCorrelationId(harness) };
}

async function createDefaultPromptTurn(
  harness: Harness,
  cwd = "/repo/acp-go-sdk"
): Promise<{
  newSessionResponse: Awaited<ReturnType<MuxAgent["newSession"]>>;
  promptPromise: ReturnType<MuxAgent["prompt"]>;
  promptCorrelationId: string;
}> {
  await initializeDefaultAgent(harness);
  const newSessionResponse = await createDefaultSession(harness, cwd);
  const turn = await startPromptTurn(harness, newSessionResponse.sessionId);
  return { newSessionResponse, ...turn };
}

function trackSettled<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return () => settled;
}

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-5";
const EDITOR_DELEGATION_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

async function initializeEditorDelegationAgent(harness: Harness): Promise<void> {
  await harness.agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: EDITOR_DELEGATION_CAPABILITIES,
  });
}

function streamStart(
  workspaceId: string,
  messageId: string,
  overrides: Record<string, unknown> = {}
): WorkspaceChatMessage {
  return {
    type: "stream-start",
    workspaceId,
    messageId,
    model: DEFAULT_MODEL,
    historySequence: 3,
    startTime: Date.now(),
    ...overrides,
  } as WorkspaceChatMessage;
}

function streamEnd(
  workspaceId: string,
  messageId: string,
  overrides: Record<string, unknown> = {}
): WorkspaceChatMessage {
  return {
    type: "stream-end",
    workspaceId,
    messageId,
    metadata: { model: DEFAULT_MODEL },
    parts: [],
    ...overrides,
  } as WorkspaceChatMessage;
}

describe("ACP prompt stream correlation", () => {
  it("sends session-local picker settings despite unchanged workspace metadata", async () => {
    const harness = createHarness();
    await initializeDefaultAgent(harness);
    const { sessionId } = await createDefaultSession(harness);
    for (const [configId, value] of [
      ["agentMode", "plan"],
      ["model", "openai:gpt-5.2"],
      ["thinkingLevel", "high"],
      ["agentMode", "plan"],
    ]) {
      await harness.agent.setSessionConfigOption({ sessionId, configId, value });
    }
    expect(harness.sendMessageCalls).toHaveLength(0);

    const { promptPromise, promptCorrelationId } = await startPromptTurn(harness, sessionId);
    expect(harness.sendMessageCalls[0]?.options).toMatchObject({
      agentId: "plan",
      model: "openai:gpt-5.2",
      thinkingLevel: "high",
    });
    harness.pushChatEvent(
      streamStart(sessionId, "assistant-local", { acpPromptId: promptCorrelationId })
    );
    harness.pushChatEvent(streamEnd(sessionId, "assistant-local"));
    await expect(promptPromise).resolves.toMatchObject({ stopReason: "end_turn" });
    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("ignores unrelated stream-start/end pairs while waiting for this prompt turn", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    const isPromptSettled = trackSettled(promptPromise);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-other", {
        historySequence: 2,
        acpPromptId: "unrelated-prompt-id",
      })
    );

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-other"));

    await sleep(25);
    expect(isPromptSettled()).toBe(false);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-target"));

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("completes prompt turns from correlated stream-end when stream-start is missing", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    const isPromptSettled = trackSettled(promptPromise);

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-other", {
        acpPromptId: "unrelated-prompt-id",
      })
    );

    await sleep(25);
    expect(isPromptSettled()).toBe(false);

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("rejects prompt turns when terminal stream events never arrive", async () => {
    const harness = createHarness({
      agentOptions: {
        turnCorrelationTimeoutMs: 50,
      },
    });
    const { promptPromise } = await createDefaultPromptTurn(harness);

    const timeoutGuard = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Expected prompt turn timeout but prompt stayed pending")),
        1_000
      );
    });

    await expect(Promise.race([promptPromise, timeoutGuard])).rejects.toThrow(
      "prompt turn timed out"
    );

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("keeps prompt turn alive while correlated stream activity continues", async () => {
    const harness = createHarness({
      agentOptions: {
        turnCorrelationTimeoutMs: 100,
      },
    });
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    // Keep the stream active for longer than turnCorrelationTimeoutMs to prove
    // timeout is inactivity-based (not a fixed wall-clock timer).
    for (let i = 0; i < 4; i++) {
      await sleep(40);
      harness.pushChatEvent({
        type: "stream-delta",
        workspaceId: newSessionResponse.sessionId,
        messageId: "assistant-target",
        delta: `chunk-${i} `,
        tokens: 1,
        timestamp: Date.now(),
      } as WorkspaceChatMessage);
    }

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("does not time out correlated turns during quiet periods before terminal events", async () => {
    const harness = createHarness({
      agentOptions: {
        turnCorrelationTimeoutMs: 100,
      },
    });
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    const isPromptSettled = trackSettled(promptPromise);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    // Wait longer than turnCorrelationTimeoutMs with no correlated deltas.
    await sleep(150);
    expect(isPromptSettled()).toBe(false);

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("completes prompt turns when stream-start omits acpPromptId but terminal event is correlated", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    // Simulate runtimes that omit correlation metadata on live stream-start.
    harness.pushChatEvent(streamStart(newSessionResponse.sessionId, "assistant-target"));

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("completes prompt turns from live stream events when acpPromptId is missing", async () => {
    const harness = createHarness({
      agentOptions: {
        turnCorrelationTimeoutMs: 100,
      },
    });
    const { newSessionResponse, promptPromise } = await createDefaultPromptTurn(harness);

    // Simulate runtimes that omit correlation metadata on live stream events.
    harness.pushChatEvent(streamStart(newSessionResponse.sessionId, "assistant-target"));

    // Keep the stream active longer than turnCorrelationTimeoutMs to prove the
    // fallback stream-start binding refreshes inactivity while acpPromptId is missing.
    for (let i = 0; i < 4; i++) {
      await sleep(40);
      harness.pushChatEvent({
        type: "stream-delta",
        workspaceId: newSessionResponse.sessionId,
        messageId: "assistant-target",
        delta: `chunk-${i} `,
        tokens: 1,
        timestamp: Date.now(),
      } as WorkspaceChatMessage);
    }

    // Terminal event may also omit acpPromptId in older runtimes.
    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-target"));

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("ignores stale uncorrelated stream-start events older than the active prompt", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    const isPromptSettled = trackSettled(promptPromise);

    // Simulate a stale stream-start from before this prompt began.
    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-stale", {
        historySequence: 1,
        startTime: 1,
      })
    );

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-stale"));

    await sleep(25);
    expect(isPromptSettled()).toBe(false);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("completes prompt turns from replay-flagged correlated stream events", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    // Simulate pre-caught-up replay classification from full-mode subscriptions.
    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
        replay: true,
      })
    );

    // Deliberately omit acpPromptId to ensure message-id matching still completes.
    harness.pushChatEvent(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        replay: true,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("resolves pending prompts as cancelled when cancel succeeds without terminal stream events", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise } = await createDefaultPromptTurn(harness);

    await harness.agent.cancel({
      sessionId: newSessionResponse.sessionId,
    });

    await expect(promptPromise).resolves.toEqual({
      stopReason: "cancelled",
      usage: undefined,
    });

    expect(harness.interruptCalls).toEqual([
      {
        workspaceId: newSessionResponse.sessionId,
        options: { retireBashMonitorAttention: true },
      },
    ]);

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("settles pending prompts as cancelled when the Stop stopped the stream but was not recorded", async () => {
    const harness = createHarness({
      interruptStream: async () => ({ success: false, error: STOP_UNRECORDED_MESSAGE }),
    });
    const { newSessionResponse, promptPromise } = await createDefaultPromptTurn(harness);

    await expect(harness.agent.cancel({ sessionId: newSessionResponse.sessionId })).rejects.toThrow(
      STOP_UNRECORDED_MESSAGE
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "cancelled",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("accepts correlated terminal events even when messageId is empty", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent({
      type: "stream-abort",
      workspaceId: newSessionResponse.sessionId,
      messageId: "",
      abortReason: "system",
      acpPromptId: promptCorrelationId,
      metadata: {
        duration: 1,
      },
    } as WorkspaceChatMessage);

    await expect(promptPromise).resolves.toEqual({
      stopReason: "cancelled",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("attaches delegated tool metadata when local runtime and editor capabilities allow delegation", async () => {
    const harness = createHarness();
    await initializeEditorDelegationAgent(harness);
    const newSessionResponse = await createDefaultSession(harness);
    const { promptPromise, promptCorrelationId } = await startPromptTurn(
      harness,
      newSessionResponse.sessionId
    );

    const muxMetadata = getLastMuxMetadata(harness);

    expect(muxMetadata["acpDelegatedTools"]).toEqual([
      "file_read",
      "file_write",
      "file_edit_replace_string",
      "file_edit_insert",
      "bash",
    ]);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-target"));

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("answers delegated tool calls back to the server for the active prompt turn", async () => {
    const harness = createHarness();
    await initializeEditorDelegationAgent(harness);
    const newSessionResponse = await createDefaultSession(harness);

    const toolRouter = (
      harness.agent as unknown as {
        toolRouter: {
          shouldDelegateToEditor: (sessionId: string, toolName: string) => boolean;
          delegateToEditor: (
            sessionId: string,
            toolName: string,
            params: Record<string, unknown>
          ) => Promise<unknown>;
        };
      }
    ).toolRouter;

    toolRouter.shouldDelegateToEditor = (_sessionId, toolName) => toolName === "bash";
    toolRouter.delegateToEditor = async (_sessionId, _toolName, _params) => ({
      terminalId: "term-1",
    });

    const { promptPromise, promptCorrelationId } = await startPromptTurn(
      harness,
      newSessionResponse.sessionId
    );

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 4,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent({
      type: "tool-call-start",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-target",
      toolCallId: "tool-bash",
      toolName: "bash",
      args: { script: "echo hi" },
      tokens: 1,
      timestamp: Date.now(),
    } as WorkspaceChatMessage);

    await waitForCondition(() => harness.delegatedToolAnswers.length === 1);
    expect(harness.delegatedToolAnswers[0]).toEqual({
      workspaceId: newSessionResponse.sessionId,
      toolCallId: "tool-bash",
      result: { terminalId: "term-1" },
    });

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-target"));

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("interrupts active turns on ACP disconnect to unblock delegated tool waits", async () => {
    const harness = createHarness();
    await initializeEditorDelegationAgent(harness);
    const newSessionResponse = await createDefaultSession(harness);
    const { promptPromise } = await startPromptTurn(harness, newSessionResponse.sessionId);

    harness.closeConnection();

    await expect(promptPromise).rejects.toThrow("Xum ACP connection closed");
    await waitForCondition(() => harness.interruptCalls.length === 1);

    expect(harness.interruptCalls[0]).toEqual({
      workspaceId: newSessionResponse.sessionId,
      options: {
        abandonPartial: true,
      },
    });

    await harness.connectionClosed;
  });

  it("interrupts every active turn before disconnect session eviction runs", async () => {
    let releaseFirstInterrupt: (() => void) | undefined;
    const firstInterruptGate = new Promise<void>((resolve) => {
      releaseFirstInterrupt = resolve;
    });
    const interruptedWorkspaceIds: string[] = [];

    const harness = createHarness({
      interruptStream: async (input) => {
        interruptedWorkspaceIds.push(input.workspaceId);
        if (interruptedWorkspaceIds.length === 1) {
          await firstInterruptGate;
        }
        return { success: true, data: undefined };
      },
    });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const firstSession = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const secondSession = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const firstPrompt = harness.agent
      .prompt({
        sessionId: firstSession.sessionId,
        prompt: [{ type: "text", text: "hello from first turn" }],
      })
      .then(
        () => new Error("first prompt unexpectedly resolved"),
        (error: unknown) =>
          error instanceof Error ? error : new Error(`first prompt rejected: ${String(error)}`)
      );

    const secondPrompt = harness.agent
      .prompt({
        sessionId: secondSession.sessionId,
        prompt: [{ type: "text", text: "hello from second turn" }],
      })
      .then(
        () => new Error("second prompt unexpectedly resolved"),
        (error: unknown) =>
          error instanceof Error ? error : new Error(`second prompt rejected: ${String(error)}`)
      );

    await waitForCondition(() => harness.sendMessageCalls.length === 2);

    harness.closeConnection();

    await waitForCondition(() => interruptedWorkspaceIds.length === 1);
    if (releaseFirstInterrupt == null) {
      throw new Error("Expected first interrupt gate resolver to be initialized");
    }
    releaseFirstInterrupt();

    await waitForCondition(() => interruptedWorkspaceIds.length === 2);
    expect([...interruptedWorkspaceIds].sort()).toEqual(
      [firstSession.sessionId, secondSession.sessionId].sort()
    );

    const firstPromptResult = await firstPrompt;
    const secondPromptResult = await secondPrompt;
    expect(firstPromptResult.message).toContain("Xum ACP connection closed");
    expect(secondPromptResult.message).toContain("Xum ACP connection closed");

    await harness.connectionClosed;
  });

  it("continues disconnect cleanup when interruptStream reports backend failure", async () => {
    const harness = createHarness({
      interruptStream: async () => ({
        success: false,
        error: "interrupt failed",
      }),
    });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const promptPromise = harness.agent
      .prompt({
        sessionId: newSessionResponse.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      })
      .then(
        () => new Error("prompt unexpectedly resolved"),
        (error: unknown) =>
          error instanceof Error ? error : new Error(`prompt rejected: ${String(error)}`)
      );

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    harness.closeConnection();

    const promptResult = await promptPromise;
    expect(promptResult.message).toContain("Xum ACP connection closed");
    await waitForCondition(() => harness.interruptCalls.length === 1);
    await expect(harness.agent.waitForDisconnectCleanup()).resolves.toBeUndefined();

    await harness.connectionClosed;
  });

  it("rejects promptly when chat subscription drops before terminal events", async () => {
    const endedChatStream: AsyncIterable<WorkspaceChatMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };

    const harness = createHarness({
      onChat: async () => endedChatStream,
    });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const promptResult = await Promise.race<Error | "timed_out" | "resolved">([
      harness.agent
        .prompt({
          sessionId: newSessionResponse.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        })
        .then(() => "resolved" as const)
        .catch((error: unknown) =>
          error instanceof Error ? error : new Error(`prompt rejected: ${String(error)}`)
        ),
      new Promise<"timed_out">((resolve) => {
        setTimeout(() => resolve("timed_out"), 500);
      }),
    ]);

    expect(promptResult).not.toBe("timed_out");
    expect(promptResult).not.toBe("resolved");
    if (promptResult === "timed_out" || promptResult === "resolved") {
      throw new Error("Expected prompt to reject when chat stream ends before terminal events");
    }

    expect(promptResult.message).toContain("Chat stream ended unexpectedly");

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("does not let stale onChat teardown reject the active prompt after mode-switch replacement", async () => {
    const staleSubscription = createDelayedTeardownChatStream();
    const replacementSubscription = createControlledChatStream();
    let onChatCallCount = 0;

    const harness = createHarness({
      onChat: async () => {
        onChatCallCount += 1;
        return onChatCallCount === 1 ? staleSubscription.stream : replacementSubscription.stream;
      },
    });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const privateAgent = harness.agent as unknown as {
      ensureChatSubscription: (
        sessionId: string,
        workspaceId: string,
        onChatMode: OnChatMode
      ) => Promise<void>;
    };

    await privateAgent.ensureChatSubscription(
      newSessionResponse.sessionId,
      newSessionResponse.sessionId,
      { type: "live" }
    );
    await staleSubscription.returnCalled;

    const promptPromise = harness.agent.prompt({
      sessionId: newSessionResponse.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const promptCorrelationId = getPromptCorrelationId(harness);

    staleSubscription.releaseTeardown();
    await staleSubscription.returnCompleted;
    await Promise.resolve();

    replacementSubscription.push(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    replacementSubscription.push(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("ignores stale stream events after mode-switch replacement when old teardown times out", async () => {
    const staleSubscription = createLingeringTeardownChatStream();
    const replacementSubscription = createControlledChatStream();
    let onChatCallCount = 0;

    const harness = createHarness({
      agentOptions: {
        turnCorrelationTimeoutMs: 250,
      },
      onChat: async () => {
        onChatCallCount += 1;
        return onChatCallCount === 1 ? staleSubscription.stream : replacementSubscription.stream;
      },
    });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const privateAgent = harness.agent as unknown as {
      ensureChatSubscription: (
        sessionId: string,
        workspaceId: string,
        onChatMode: OnChatMode
      ) => Promise<void>;
    };

    await privateAgent.ensureChatSubscription(
      newSessionResponse.sessionId,
      newSessionResponse.sessionId,
      { type: "live" }
    );
    await staleSubscription.returnCalled;

    const promptPromise = harness.agent.prompt({
      sessionId: newSessionResponse.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const promptCorrelationId = getPromptCorrelationId(harness);

    const isPromptSettled = trackSettled(promptPromise);

    // These stale events would previously correlate via stream-start fallback
    // and incorrectly resolve the active turn after mode-switch replacement.
    staleSubscription.push({
      type: "stream-start",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-stale",
      model: "anthropic:claude-sonnet-4-5",
      historySequence: 3,
      startTime: Date.now(),
    } as WorkspaceChatMessage);

    staleSubscription.push(streamEnd(newSessionResponse.sessionId, "assistant-stale"));

    await sleep(50);
    expect(isPromptSettled()).toBe(false);

    replacementSubscription.push(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 4,
        acpPromptId: promptCorrelationId,
      })
    );

    replacementSubscription.push(
      streamEnd(newSessionResponse.sessionId, "assistant-target", {
        acpPromptId: promptCorrelationId,
      })
    );

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    staleSubscription.releaseTeardown();
    await staleSubscription.returnCompleted;

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("ignores usage deltas from unrelated streams when completing the active prompt", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-other", {
        historySequence: 2,
        acpPromptId: "unrelated-prompt-id",
      })
    );

    harness.pushChatEvent({
      type: "usage-delta",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-other",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      cumulativeUsage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    } as WorkspaceChatMessage);

    harness.pushChatEvent(
      streamStart(newSessionResponse.sessionId, "assistant-target", {
        historySequence: 3,
        acpPromptId: promptCorrelationId,
      })
    );

    harness.pushChatEvent(streamEnd(newSessionResponse.sessionId, "assistant-target"));

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("treats runtime error events as terminal failures for the matching prompt", async () => {
    const harness = createHarness();
    const { newSessionResponse, promptPromise, promptCorrelationId } =
      await createDefaultPromptTurn(harness);

    const isPromptSettled = trackSettled(promptPromise);

    harness.pushChatEvent({
      type: "error",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-other",
      error: "runtime unavailable",
      errorType: "runtime_not_ready",
    } as WorkspaceChatMessage);

    await sleep(25);
    expect(isPromptSettled()).toBe(false);

    harness.pushChatEvent({
      type: "error",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-target",
      error: "runtime unavailable",
      errorType: "runtime_not_ready",
      acpPromptId: promptCorrelationId,
    } as WorkspaceChatMessage);

    await expect(promptPromise).rejects.toThrow("runtime unavailable");

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("resolves prompt turn even when stdout backpressure blocks sessionUpdate writes", async () => {
    // Simulate stdout backpressure: each sessionUpdate write is artificially
    // slow. Without the asyncMessageQueue decoupling, stream-end would stall
    // behind the blocked writes and prompt() would hang indefinitely.
    let writeCount = 0;
    const slowOutput = new WritableStream<Uint8Array>({
      async write() {
        writeCount++;
        // 50ms per write — 20 events × 50ms = ~1s of backpressure, but
        // prompt() should resolve as soon as stream-end is observed.
        await sleep(50);
      },
    });

    const harness = createHarness({ acpOutputStream: slowOutput });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const session = await harness.agent.newSession({
      cwd: "/repo/backpressure-test",
      mcpServers: [],
      _meta: { trunkBranch: "main" },
    });

    const promptPromise = harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const promptCorrelationId = getPromptCorrelationId(harness);

    // Emit stream-start to bind the turn to a message
    harness.pushChatEvent(
      streamStart(session.sessionId, "assistant-bp", {
        historySequence: 2,
        acpPromptId: promptCorrelationId,
      })
    );

    // Flood 20 stream-delta events. Each translates to a sessionUpdate write
    // that takes ~50ms, creating substantial backpressure.
    for (let i = 0; i < 20; i++) {
      harness.pushChatEvent({
        type: "stream-delta",
        workspaceId: session.sessionId,
        messageId: "assistant-bp",
        delta: `chunk-${i} `,
        tokens: 1,
        timestamp: Date.now(),
      } as WorkspaceChatMessage);
    }

    // Emit stream-end. With the old observeChatStream approach, this event
    // would be stuck behind the 20 blocked sessionUpdate writes, causing
    // handleStreamEvent(stream-end) to never fire and prompt() to hang.
    harness.pushChatEvent({
      type: "stream-end",
      workspaceId: session.sessionId,
      messageId: "assistant-bp",
      metadata: { model: "anthropic:claude-sonnet-4-5" },
      parts: [],
      acpPromptId: promptCorrelationId,
    } as WorkspaceChatMessage);

    // prompt() should resolve quickly — well before the ~1s of backpressured
    // writes complete — because handleStreamEvent runs in the drain loop,
    // decoupled from the forwarding pipeline.
    const result = await Promise.race([
      promptPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("prompt() hung — backpressure deadlock regression")),
          2_000
        )
      ),
    ]);

    expect(result).toBeDefined();
    expect(result.stopReason).toBe("end_turn");

    // Sanity: some writes happened (stream was being forwarded)
    expect(writeCount).toBeGreaterThan(0);

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("resolves prompt turn when queue saturation drops deltas but preserves terminal events", async () => {
    let writesUnblocked = false;
    let releaseBlockedWrites: (() => void) | undefined;
    const blockedWritesGate = new Promise<void>((resolve) => {
      releaseBlockedWrites = resolve;
    });

    const blockedOutput = new WritableStream<Uint8Array>({
      async write() {
        if (writesUnblocked) {
          return;
        }

        await blockedWritesGate;
      },
    });

    const harness = createHarness({ acpOutputStream: blockedOutput });
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const session = await harness.agent.newSession({
      cwd: "/repo/backpressure-saturation-test",
      mcpServers: [],
      _meta: { trunkBranch: "main" },
    });

    const promptPromise = harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const promptCorrelationId = getPromptCorrelationId(harness);

    harness.pushChatEvent(
      streamStart(session.sessionId, "assistant-saturated", {
        historySequence: 2,
        acpPromptId: promptCorrelationId,
      })
    );

    // Emit far more events than MAX_BUFFERED_CHAT_EVENTS. The drain loop must
    // still read through to stream-end (resolving prompt()) even while
    // forwarding is blocked and non-terminal deltas are being dropped.
    for (let i = 0; i < 6_000; i++) {
      harness.pushChatEvent({
        type: "stream-delta",
        workspaceId: session.sessionId,
        messageId: "assistant-saturated",
        delta: `chunk-${i} `,
        tokens: 1,
        timestamp: Date.now(),
      } as WorkspaceChatMessage);
    }

    harness.pushChatEvent({
      type: "stream-end",
      workspaceId: session.sessionId,
      messageId: "assistant-saturated",
      metadata: { model: "anthropic:claude-sonnet-4-5" },
      parts: [],
      acpPromptId: promptCorrelationId,
    } as WorkspaceChatMessage);

    const result = await Promise.race([
      promptPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("prompt() hung when onChat queue saturated before terminal event")),
          2_000
        )
      ),
    ]);

    expect(result).toBeDefined();
    expect(result.stopReason).toBe("end_turn");

    writesUnblocked = true;
    if (releaseBlockedWrites == null) {
      throw new Error("Expected blocked output stream to expose release callback");
    }
    releaseBlockedWrites();
    harness.closeConnection();
    await harness.connectionClosed;
  }, 15_000);
});
