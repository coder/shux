import { mock } from "bun:test";
import { EventEmitter } from "events";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { Err, Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import type { TurnStreamHandle } from "@/node/services/streamManager";
import { AgentSession, type AgentSessionAIService } from "@/node/services/agentSession";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { StreamErrorType } from "@/common/types/errors";

export function createStartedTurnHandle(messageId = "test-assistant"): TurnStreamHandle {
  return { messageId, completion: new Promise(() => undefined) };
}

export function createFailedTurnHandle(
  messageId: string,
  failure: { error: string; errorType: StreamErrorType }
): TurnStreamHandle {
  return {
    messageId,
    completion: Promise.resolve({
      status: "failed" as const,
      streamError: { messageId, ...failure },
    }),
  };
}

/**
 * Isolated terminal-policy tests with no engine. Lifecycle tests must instead
 * return controllable handles through streamMessage (see turnCompletion.test.ts).
 */
export function runSessionTerminalPolicy(
  session: AgentSession,
  emitter: EventEmitter,
  payload: StreamEndEvent | StreamAbortEvent
): Promise<void> {
  const policy = session as unknown as {
    handleTurnSuccess(payload: StreamEndEvent): Promise<void>;
    handleTurnAbort(payload: StreamAbortEvent, systemMessageTokens?: number): Promise<void>;
    streamManager: {
      getStreamInfo(
        workspaceId: string
      ): { initialMetadata?: { systemMessageTokens?: number } } | undefined;
    };
  };
  const systemMessageTokens = policy.streamManager.getStreamInfo(payload.workspaceId)
    ?.initialMetadata?.systemMessageTokens;
  emitter.emit(payload.type, payload);
  return payload.type === "stream-end"
    ? policy.handleTurnSuccess(payload)
    : policy.handleTurnAbort(payload, systemMessageTokens);
}

function createAgentSessionTestConfig(sessionDir = "/tmp"): Config {
  return {
    rootDir: sessionDir,
    sessionsDir: sessionDir,
    srcDir: sessionDir,
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;
}

function createMockBackgroundProcessManager(
  overrides?: Partial<BackgroundProcessManager>
): BackgroundProcessManager {
  return {
    cleanup: mock((_workspaceId: string) => Promise.resolve()),
    setMessageQueued: mock((_workspaceId: string, _queued: boolean) => void _queued),
    ...overrides,
  } as unknown as BackgroundProcessManager;
}

function createMockInitStateManager(overrides?: Partial<InitStateManager>): InitStateManager {
  return Object.assign(new EventEmitter(), overrides) as unknown as InitStateManager;
}

/** Stream-lifecycle surface AgentSession's constructor requires from its engine seam. */
export function createStreamLifecycleMocks() {
  return {
    isStreaming: mock((_workspaceId: string) => false),
    stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    getStreamInfo: mock((_workspaceId: string) => undefined),
    replayStream: mock((_workspaceId: string, _options?: { afterTimestamp?: number }) =>
      Promise.resolve()
    ),
  };
}

function createMockAiService(args?: {
  emitter?: EventEmitter;
  overrides?: Partial<AgentSessionAIService>;
}): {
  aiEmitter: EventEmitter;
  aiService: AgentSessionAIService;
} {
  const aiEmitter = args?.emitter ?? new EventEmitter();
  const aiService: AgentSessionAIService = Object.assign(aiEmitter, {
    // Real implementations report failures as Err results, never rejections.
    createModelWithPinnedMetadata: mock(() =>
      Promise.resolve(
        Err({ type: "unknown" as const, raw: "Test AI service cannot create models" })
      )
    ),
    getWorkspaceMetadata: mock(() =>
      Promise.resolve(Err("Test AI service has no workspace metadata"))
    ),
    getProvidersConfig: mock(() => null),
    isExperimentEnabled: mock((_experimentId) => false),
    ...createStreamLifecycleMocks(),
    streamMessage: mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle("test-assistant-message")))
    ),
    ...args?.overrides,
  });
  return { aiEmitter, aiService };
}

export interface AgentSessionHarnessOptions {
  workspaceId: string;
  config?: Config;
  historyService?: HistoryService;
  aiService?: AgentSessionAIService;
  aiEmitter?: EventEmitter;
  aiServiceOverrides?: Partial<AgentSessionAIService>;
  initStateManager?: InitStateManager;
  initStateManagerOverrides?: Partial<InitStateManager>;
  backgroundProcessManager?: BackgroundProcessManager;
  backgroundProcessManagerOverrides?: Partial<BackgroundProcessManager>;
  workspaceGoalService?: WorkspaceGoalService;
  mcpServerManager?: MCPServerManager;
  onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  captureEvents?: boolean;
}

export interface AgentSessionHarness {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  cleanup: () => Promise<void>;
  aiEmitter: EventEmitter;
  aiService: AgentSessionAIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
}

export async function createAgentSessionHarness(
  options: AgentSessionHarnessOptions
): Promise<AgentSessionHarness> {
  const testHistory = options.historyService ? undefined : await createTestHistoryService();
  const historyService = options.historyService ?? testHistory!.historyService;
  const config = options.config ?? testHistory?.config ?? createAgentSessionTestConfig();
  const cleanup = testHistory?.cleanup ?? (() => Promise.resolve());
  const { aiEmitter, aiService } = options.aiService
    ? { aiEmitter: options.aiEmitter ?? new EventEmitter(), aiService: options.aiService }
    : createMockAiService({
        emitter: options.aiEmitter,
        overrides: options.aiServiceOverrides,
      });
  const initStateManager =
    options.initStateManager ?? createMockInitStateManager(options.initStateManagerOverrides);
  const backgroundProcessManager =
    options.backgroundProcessManager ??
    createMockBackgroundProcessManager(options.backgroundProcessManagerOverrides);

  const session = new AgentSession({
    workspaceId: options.workspaceId,
    config,
    historyService,
    aiService,
    mcpServerManager: options.mcpServerManager,
    initStateManager,
    workspaceGoalService: options.workspaceGoalService,
    backgroundProcessManager,
    onCompactionComplete: options.onCompactionComplete,
  });

  const events: WorkspaceChatMessage[] = [];
  if (options.captureEvents) {
    session.onChatEvent(({ message }) => {
      events.push(message);
    });
  }

  return {
    session,
    config,
    historyService,
    cleanup,
    aiEmitter,
    aiService,
    initStateManager,
    backgroundProcessManager,
    events,
  };
}
