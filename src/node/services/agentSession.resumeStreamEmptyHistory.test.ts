import { describe, expect, test, mock, afterEach } from "bun:test";

import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";

describe("AgentSession.resumeStream", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("returns an error when history is empty", async () => {
    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => aiService),
      off: mock(() => aiService),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const initStateManager: InitStateManager = {
      on: mock(() => initStateManager),
      off: mock(() => initStateManager),
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("unknown");
    if (result.error.type !== "unknown") {
      throw new Error(`Expected unknown error, got ${result.error.type}`);
    }
    expect(result.error.raw).toContain("history is empty");
    expect(streamMessage).toHaveBeenCalledTimes(0);
  });
});
