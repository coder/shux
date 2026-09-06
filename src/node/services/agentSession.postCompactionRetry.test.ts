import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import type { MuxMessage } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createTestHistoryService } from "./testHistoryService";
import {
  createFailedTurnHandle,
  createStartedTurnHandle,
  createStreamLifecycleMocks,
} from "./agentSession.testHarness";

function contextExceededResult(messageId: string) {
  return {
    success: true as const,
    data: createFailedTurnHandle(messageId, {
      error: "Context length exceeded",
      errorType: "context_exceeded",
    }),
  };
}

function createPersistedPostCompactionState(options: {
  filePath: string;
  diffs: Array<{ path: string; diff: string; truncated: boolean }>;
}): Promise<void> {
  const payload = {
    version: 1 as const,
    createdAt: Date.now(),
    diffs: options.diffs,
  };

  return fsPromises.writeFile(options.filePath, JSON.stringify(payload));
}

describe("AgentSession post-compaction context retry", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("retries once without post-compaction injection on context_exceeded", async () => {
    const workspaceId = "ws";
    const sessionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));
    const sessionDir = path.join(sessionsDir, workspaceId);
    await fsPromises.mkdir(sessionDir);
    const postCompactionPath = path.join(sessionDir, "post-compaction.json");

    await createPersistedPostCompactionState({
      filePath: postCompactionPath,
      diffs: [
        {
          path: "/tmp/foo.ts",
          diff: "@@ -1 +1 @@\n-foo\n+bar\n",
          truncated: false,
        },
      ],
    });

    const history: MuxMessage[] = [
      {
        id: "compaction-summary",
        role: "assistant",
        parts: [{ type: "text", text: "Summary" }],
        metadata: { timestamp: 1000, compacted: "user" },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }
    spyOn(historyService, "deleteMessage");

    const aiEmitter = new EventEmitter();

    let resolveSecondCall: (() => void) | undefined;
    const secondCall = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });

    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;

      if (callCount === 1) {
        // Simulate a provider context limit error before any deltas.
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });

        return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
      }

      resolveSecondCall?.();
      return Promise.resolve({
        success: true as const,
        data: createStartedTurnHandle("assistant-retry"),
      });
    });

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.on(String(eventName), listener);
        return this;
      },
      off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.off(String(eventName), listener);
        return this;
      },
      streamMessage,
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      rootDir: sessionsDir,
      sessionsDir,
      srcDir: "/tmp",
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    // Exercise the public resume facade so retry preparation has a real admitted owner.
    await session.resumeStream(options);

    // Wait for the retry call to happen.
    await Promise.race([
      secondCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);

    expect(streamMessage).toHaveBeenCalledTimes(2);

    // Codex fast-retry scenario: a waiter that arrives only after the retry
    // already started (and possibly finished) must still see the recorded
    // "retry-started" outcome for this attempt instead of sampling live flags.
    expect(await session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")).toBe(
      "retry-started"
    );

    // With the options bag, arg[0] is the StreamMessageOptions object.
    const firstOpts = (streamMessage as ReturnType<typeof mock>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Array.isArray(firstOpts.postCompactionAttachments)).toBe(true);

    const secondOpts = (streamMessage as ReturnType<typeof mock>).mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(secondOpts.postCompactionAttachments).toBeNull();

    expect((historyService.deleteMessage as ReturnType<typeof mock>).mock.calls[0][1]).toBe(
      "assistant-ctx-exceeded"
    );

    // Pending post-compaction state should be discarded.
    let exists = true;
    try {
      await fsPromises.stat(postCompactionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    session.dispose();
  });

  // Waiters (task/workspace-turn stream-error settlement) treat the resolved
  // decision as "the retry outcome is known". Resolving while retry startup is
  // still in flight would let a pre-stream startup failure (no further error
  // event) leave a child task running until the parent times out.
  test("recovery decision resolves only after the context retry startup outcome is known", async () => {
    const workspaceId = "ws-decision";
    const sessionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));
    const sessionDir = path.join(sessionsDir, workspaceId);
    await fsPromises.mkdir(sessionDir);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let releaseRetryStartup!: () => void;
    const retryStartupGate = new Promise<void>((resolve) => {
      releaseRetryStartup = resolve;
    });
    let retryStartupInvoked!: () => void;
    const retryStartupStarted = new Promise<void>((resolve) => {
      retryStartupInvoked = resolve;
    });

    let callCount = 0;
    const streamMessage = mock(async (..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return contextExceededResult("assistant-ctx-exceeded");
      }
      // Retry startup in flight: hold it until the test releases, then fail
      // pre-stream (e.g. commitPartial / history read failure).
      retryStartupInvoked();
      await retryStartupGate;
      return {
        success: false as const,
        error: { type: "unknown" as const, raw: "startup failed before stream" },
      };
    });

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.on(String(eventName), listener);
        return this;
      },
      off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.off(String(eventName), listener);
        return this;
      },
      streamMessage,
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
      isStreaming: mock(() => false),
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      rootDir: sessionsDir,
      sessionsDir,
      srcDir: "/tmp",
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    // The error event began a recovery decision and kicked off the retry.
    await Promise.race([
      retryStartupStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry never started")), 1000)),
    ]);

    let decidedOutcome: string | undefined;
    let decided = false;
    const decision = session
      .waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")
      .then((outcome) => {
        decided = true;
        decidedOutcome = outcome;
      });

    // Retry startup still in flight: the decision must stay pending so waiters
    // cannot observe a transient PREPARING as a started recovery.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toBe(false);

    releaseRetryStartup();
    await Promise.race([
      decision,
      new Promise((_, reject) => setTimeout(() => reject(new Error("decision timeout")), 1000)),
    ]);

    // Startup failed pre-stream: the recorded outcome must be terminal so
    // task settlement can interrupt the child instead of waiting forever.
    expect(decided).toBe(true);
    expect(decidedOutcome).toBe("terminal");
    expect(session.isPreparingTurn()).toBe(false);
    expect(callCount).toBe(2);

    session.dispose();
  });

  // Overlapping recovery episodes: a retry stream can emit its own error
  // before the original retry path resumes. Each error event must get its own
  // per-attempt decision — folding them into one would let the first
  // episode's "retry-started" mask the second's "terminal", leaving task
  // settlement convinced the (dead) retry is still carrying the turn.
  test("a retry that starts and then fails terminally records separate per-attempt outcomes", async () => {
    const workspaceId = "ws-overlap";
    const sessionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));
    const sessionDir = path.join(sessionsDir, workspaceId);
    await fsPromises.mkdir(sessionDir);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-attempt-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return Promise.resolve(contextExceededResult("assistant-attempt-1"));
      }
      // The retry's startup succeeds, but the stream dies immediately with a
      // terminal error — emitted before the original retry path resumes.
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-attempt-2",
        error: "The model refused to continue",
        errorType: "model_refusal",
      });
      return Promise.resolve({
        success: true as const,
        data: createFailedTurnHandle("assistant-attempt-2", {
          error: "The model refused to continue",
          errorType: "model_refusal",
        }),
      });
    });

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.on(String(eventName), listener);
        return this;
      },
      off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.off(String(eventName), listener);
        return this;
      },
      streamMessage,
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
      isStreaming: mock(() => false),
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      rootDir: sessionsDir,
      sessionsDir,
      srcDir: "/tmp",
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout`)), 1000)
        ),
      ]);

    // Attempt 1's recovery started a retry; attempt 2 (the retry's own death)
    // is terminal. A settlement waiter keyed to attempt 2 must see terminal.
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-1"),
        "attempt-1 decision"
      )
    ).toBe("retry-started");
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-2"),
        "attempt-2 decision"
      )
    ).toBe("terminal");
    expect(callCount).toBe(2);

    session.dispose();
  });
});
