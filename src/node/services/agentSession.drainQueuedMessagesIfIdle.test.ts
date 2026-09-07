import type { TurnCoordinator } from "./turnCoordinator";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as path from "node:path";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";
import { Err } from "@/common/types/result";

/**
 * drainQueuedMessagesIfIdle is the release valve for messages queued behind a
 * WorkspaceService preflight that never became a turn. It must defer to every
 * owner of the next dispatch, not just an active turn phase.
 */

const WORKSPACE_ID = "workspace-drain-if-idle-test";

interface PrivateSessionAccess {
  midStreamCompactionPending: boolean;
  coordinator: TurnCoordinator;
  activeStreamContext?: { modelString: string; options?: unknown; providersConfig: null };
  interruptForCompaction: () => Promise<void>;
}

describe("AgentSession.drainQueuedMessagesIfIdle", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let session: AgentSession | undefined;

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  async function createSession(): Promise<AgentSession> {
    const created = await createTestHistoryService();
    cleanup = created.cleanup;
    const aiEmitter = new EventEmitter();
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
      rootDir: created.config.rootDir,
      sessionsDir: created.config.sessionsDir,
      srcDir: path.join(created.config.rootDir, "src"),
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;
    session = new AgentSession({
      workspaceId: WORKSPACE_ID,
      config,
      historyService: created.historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    return session;
  }

  const cases: Array<[string, (s: PrivateSessionAccess) => void, number]> = [
    ["an idle session drains", () => undefined, 1],
    // Codex P1 (PRRT_kwDOPxxmWM6eaers): between interruptForCompaction stopping the original
    // stream and dispatching the compaction request, the turn phase is IDLE while the
    // compaction still owns the next dispatch.
    [
      "a pending mid-stream compaction owns the next dispatch",
      (s) => {
        const token = s.coordinator.beginCompactionObservation("legacy");
        if (!token) throw new Error("Expected compaction owner");
        s.coordinator.setCompactionStage(token, "stopping");
      },
      0,
    ],
    // Codex P2 (PRRT_kwDOPxxmWM6ebIHW): this is the only drain the queued input gets, and a
    // retry that is later abandoned never drains, so a scheduled retry must not hold it.
    // The retry defers to the busy session and is cancelled by stream success.
    [
      "a scheduled auto-retry does not hold the queue",
      (s) => {
        s.coordinator.beginRetry();
      },
      1,
    ],
  ];

  test.each(cases)("%s", async (_name, arrange, expectedDispatches) => {
    const agentSession = await createSession();
    const dispatch = spyOn(agentSession, "sendQueuedMessages").mockImplementation(() => undefined);
    agentSession.queueMessage("queued behind a failed preflight", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    arrange(agentSession as unknown as PrivateSessionAccess);

    agentSession.drainQueuedMessagesIfIdle();

    expect(dispatch).toHaveBeenCalledTimes(expectedDispatches);
  });

  test("a mid-stream compaction that never becomes a turn releases the queue it held", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6ebqSN): a drain deferred to the pending compaction has no
    // other retry, so the compaction's exit must drain when its request failed to start.
    const agentSession = await createSession();
    const dispatch = spyOn(agentSession, "sendQueuedMessages").mockImplementation(() => undefined);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    agentSession.queueMessage("queued during the interrupted stream", sendOptions);
    const privateSession = agentSession as unknown as PrivateSessionAccess;
    privateSession.activeStreamContext = {
      modelString: sendOptions.model,
      options: sendOptions,
      providersConfig: null,
    };
    spyOn(agentSession, "sendMessage").mockResolvedValue(
      Err({ type: "unknown", raw: "compaction request rejected before admission" })
    );

    await privateSession.interruptForCompaction();

    expect(privateSession.midStreamCompactionPending).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("an empty queue never dispatches", async () => {
    const agentSession = await createSession();
    const dispatch = spyOn(agentSession, "sendQueuedMessages").mockImplementation(() => undefined);

    agentSession.drainQueuedMessagesIfIdle();

    expect(dispatch).not.toHaveBeenCalled();
  });
});
