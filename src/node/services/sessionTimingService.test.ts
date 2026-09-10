import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";

import { Config } from "@/node/config";
import { SessionTimingService } from "./sessionTimingService";
import type { TelemetryService } from "./telemetryService";
import { normalizeToCanonical } from "@/common/utils/ai/models";

function createMockTelemetryService(): Pick<TelemetryService, "capture"> {
  return {
    capture: mock(() => undefined),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionTimingService", () => {
  let tempDir: string;
  let config: Config;
  let telemetry: Pick<TelemetryService, "capture">;
  let service: SessionTimingService;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `mux-session-timing-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    config = new Config(tempDir);
    telemetry = createMockTelemetryService();
    service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists aborted stream stats to session-timing.json", async () => {
    emitStreamStart();
    emitStreamDelta();
    emitToolCall();
    service.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "test-workspace",
      messageId: "m1",
      metadata: {
        duration: 5000,
        usage: {
          inputTokens: 1,
          outputTokens: 10,
          totalTokens: 11,
          reasoningTokens: 2,
        },
      },
      abortReason: "system",
      abandonPartial: true,
    });

    await service.waitForIdle("test-workspace");

    const snapshot = await service.getSnapshot("test-workspace");
    expect(snapshot.lastRequest?.messageId).toBe("m1");
    expect(snapshot.lastRequest?.totalDurationMs).toBe(5000);
    expect(snapshot.lastRequest?.toolExecutionMs).toBe(1000);
    expect(snapshot.lastRequest?.ttftMs).toBe(1000);
    expect(snapshot.lastRequest?.streamingMs).toBe(3000);
    expect(snapshot.lastRequest?.invalid).toBe(false);

    expect(snapshot.session?.responseCount).toBe(1);
  });

  it("ignores empty aborted streams", async () => {
    emitStreamStart();
    service.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "test-workspace",
      messageId: "m1",
      metadata: { duration: 1000 },
      abortReason: "user",
      abandonPartial: true,
    });

    await service.waitForIdle("test-workspace");

    const snapshot = await service.getSnapshot("test-workspace");
    expect(snapshot.lastRequest).toBeUndefined();
    expect(snapshot.session?.responseCount).toBe(0);
  });

  function emitStreamStart(
    params: {
      workspaceId?: string;
      messageId?: string;
      model?: string;
      startTime?: number;
      historySequence?: number;
      mode?: "exec" | "plan";
      agentId?: string;
      replay?: true;
    } = {}
  ): void {
    service.handleStreamStart({
      type: "stream-start",
      workspaceId: params.workspaceId ?? "test-workspace",
      messageId: params.messageId ?? "m1",
      model: params.model ?? "openai:gpt-4o",
      historySequence: params.historySequence ?? 1,
      startTime: params.startTime ?? 1_000_000,
      mode: params.mode ?? "exec",
      ...(params.agentId != null ? { agentId: params.agentId } : {}),
      ...(params.replay != null ? { replay: params.replay } : {}),
    });
  }

  function emitStreamDelta(
    params: {
      workspaceId?: string;
      messageId?: string;
      delta?: string;
      tokens?: number;
      timestamp?: number;
      replay?: true;
    } = {}
  ): void {
    service.handleStreamDelta({
      type: "stream-delta",
      workspaceId: params.workspaceId ?? "test-workspace",
      messageId: params.messageId ?? "m1",
      delta: params.delta ?? "hi",
      tokens: params.tokens ?? 5,
      timestamp: params.timestamp ?? 1_001_000,
      ...(params.replay != null ? { replay: params.replay } : {}),
    });
  }

  function emitToolCall(
    params: {
      workspaceId?: string;
      messageId?: string;
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      tokens?: number;
      startTimestamp?: number;
      endTimestamp?: number;
      replay?: true;
      deferEnd?: true;
    } = {}
  ): void | (() => void) {
    const workspaceId = params.workspaceId ?? "test-workspace";
    const messageId = params.messageId ?? "m1";
    const toolCallId = params.toolCallId ?? "t1";
    const toolName = params.toolName ?? "bash";

    service.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId,
      toolName,
      args: params.args ?? { cmd: "echo hi" },
      tokens: params.tokens ?? 3,
      timestamp: params.startTimestamp ?? 1_002_000,
      ...(params.replay != null ? { replay: params.replay } : {}),
    });
    const emitEnd = () =>
      service.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId,
        toolName,
        result: { ok: true },
        timestamp: params.endTimestamp ?? 1_003_000,
        ...(params.replay != null ? { replay: params.replay } : {}),
      });
    if (params.deferEnd) {
      return emitEnd;
    }
    emitEnd();
  }

  function emitStreamEnd(
    params: {
      workspaceId?: string;
      messageId?: string;
      model?: string;
      duration?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
    } = {}
  ): void {
    service.handleStreamEnd({
      type: "stream-end",
      workspaceId: params.workspaceId ?? "test-workspace",
      messageId: params.messageId ?? "m1",
      metadata: {
        model: params.model ?? "openai:gpt-4o",
        duration: params.duration ?? 5000,
        usage: {
          inputTokens: params.inputTokens ?? 1,
          outputTokens: params.outputTokens ?? 10,
          totalTokens: params.totalTokens ?? 11,
          ...(params.reasoningTokens != null ? { reasoningTokens: params.reasoningTokens } : {}),
        },
      },
      parts: [],
    });
  }

  function emitCompletedStreamWithOneTool(
    params: {
      workspaceId?: string;
      messageId?: string;
      model?: string;
      startTime?: number;
      duration?: number;
      reasoningTokens?: number;
    } = {}
  ): void {
    const startTime = params.startTime ?? 1_000_000;
    emitStreamStart({ ...params, startTime });
    emitStreamDelta({ ...params, timestamp: startTime + 1000 });
    emitToolCall({ ...params, startTimestamp: startTime + 2000, endTimestamp: startTime + 3000 });
    emitStreamEnd(params);
  }

  describe("rollUpTimingIntoParent", () => {
    it("should roll up child timing into parent without changing parent's lastRequest", async () => {
      const projectPath = "/tmp/mux-session-timing-rollup-test-project";
      const model = "openai:gpt-4o";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      const parentMessageId = "p1";
      emitCompletedStreamWithOneTool({
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
        model,
        reasoningTokens: 2,
      });

      const childMessageId = "c1";
      const startTimeChild = 2_000_000;
      emitStreamStart({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        startTime: startTimeChild,
      });
      emitStreamDelta({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        timestamp: startTimeChild + 200,
      });
      emitStreamEnd({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        duration: 1500,
        outputTokens: 5,
        totalTokens: 6,
      });

      await service.waitForIdle(parentWorkspaceId);
      await service.waitForIdle(childWorkspaceId);

      const before = await service.getSnapshot(parentWorkspaceId);
      expect(before.lastRequest?.messageId).toBe(parentMessageId);

      const beforeLastRequest = before.lastRequest!;

      const rollupResult = await service.rollUpTimingIntoParent(
        parentWorkspaceId,
        childWorkspaceId
      );
      expect(rollupResult.didRollUp).toBe(true);

      const after = await service.getSnapshot(parentWorkspaceId);

      expect(after.lastRequest).toEqual(beforeLastRequest);

      expect(after.session?.responseCount).toBe(2);
      expect(after.session?.totalDurationMs).toBe(6500);
      expect(after.session?.totalToolExecutionMs).toBe(1000);
      expect(after.session?.totalStreamingMs).toBe(4300);
      expect(after.session?.totalTtftMs).toBe(1200);
      expect(after.session?.ttftCount).toBe(2);
      expect(after.session?.totalOutputTokens).toBe(15);
      expect(after.session?.totalReasoningTokens).toBe(2);

      const normalizedModel = normalizeToCanonical(model);
      const key = `${normalizedModel}:exec`;
      expect(after.session?.byModel[key]?.responseCount).toBe(2);
    });

    it("should be idempotent for the same child workspace", async () => {
      const projectPath = "/tmp/mux-session-timing-rollup-test-project";
      const model = "openai:gpt-4o";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const childMessageId = "c1";
      const startTimeChild = 2_000_000;
      emitStreamStart({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        startTime: startTimeChild,
      });
      emitStreamDelta({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        timestamp: startTimeChild + 200,
      });
      emitStreamEnd({
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        duration: 1500,
        outputTokens: 5,
        totalTokens: 6,
      });

      await service.waitForIdle(childWorkspaceId);

      const first = await service.rollUpTimingIntoParent(parentWorkspaceId, childWorkspaceId);
      expect(first.didRollUp).toBe(true);

      const second = await service.rollUpTimingIntoParent(parentWorkspaceId, childWorkspaceId);
      expect(second.didRollUp).toBe(false);

      const result = await service.getSnapshot(parentWorkspaceId);
      expect(result.session?.responseCount).toBe(1);

      const timingFilePath = path.join(
        path.join(config.sessionsDir, parentWorkspaceId),
        "session-timing.json"
      );
      const raw = await fs.readFile(timingFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { rolledUpFrom?: Record<string, true> };
      expect(parsed.rolledUpFrom?.[childWorkspaceId]).toBe(true);
    });
  });
  it("persists completed stream stats to session-timing.json", async () => {
    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";

    emitCompletedStreamWithOneTool({ workspaceId, messageId, model, reasoningTokens: 2 });
    await service.waitForIdle(workspaceId);

    const filePath = path.join(config.sessionsDir, workspaceId, "session-timing.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();

    const file = await service.getSnapshot(workspaceId);
    expect(file.lastRequest?.messageId).toBe(messageId);
    expect(file.lastRequest?.totalDurationMs).toBe(5000);
    expect(file.lastRequest?.toolExecutionMs).toBe(1000);
    expect(file.lastRequest?.ttftMs).toBe(1000);
    expect(file.lastRequest?.streamingMs).toBe(3000);
    expect(file.lastRequest?.invalid).toBe(false);

    expect(file.session?.responseCount).toBe(1);
    expect(file.session?.totalDurationMs).toBe(5000);
    expect(file.session?.totalToolExecutionMs).toBe(1000);
    expect(file.session?.totalStreamingMs).toBe(3000);
    expect(file.session?.totalOutputTokens).toBe(10);
    expect(file.session?.totalReasoningTokens).toBe(2);

    const normalizedModel = normalizeToCanonical(model);
    const key = `${normalizedModel}:exec`;
    expect(file.session?.byModel[key]).toBeDefined();
    expect(file.session?.byModel[key]?.responseCount).toBe(1);
  });

  it("uses agentId for the per-model breakdown when available", async () => {
    const workspaceId = "test-workspace";
    const model = "openai:gpt-4o";

    emitStreamStart({ workspaceId, model, agentId: "explore" });
    emitStreamDelta({ workspaceId, timestamp: 1_000_100 });
    emitStreamEnd({ workspaceId, model, duration: 500 });

    await service.waitForIdle(workspaceId);

    const snapshot = await service.getSnapshot(workspaceId);

    const normalizedModel = normalizeToCanonical(model);
    const key = `${normalizedModel}:explore`;

    expect(snapshot.session?.byModel[key]).toBeDefined();
    expect(snapshot.session?.byModel[key]?.agentId).toBe("explore");
    expect(snapshot.session?.byModel[key]?.mode).toBe("exec");

    // Regression: splitting should not label explore traffic as plain exec.
    expect(snapshot.session?.byModel[`${normalizedModel}:exec`]).toBeUndefined();
  });

  it("ignores replayed events so timing stats aren't double-counted", async () => {
    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 4_000_000;

    emitCompletedStreamWithOneTool({ workspaceId, messageId, model, startTime });

    await service.waitForIdle(workspaceId);

    const timingFilePath = path.join(
      path.join(config.sessionsDir, workspaceId),
      "session-timing.json"
    );
    const beforeRaw = await fs.readFile(timingFilePath, "utf-8");
    const beforeSnapshot = await service.getSnapshot(workspaceId);

    expect(beforeSnapshot.active).toBeUndefined();
    expect(beforeSnapshot.lastRequest?.messageId).toBe(messageId);

    // Replay the same events (e.g., reconnect)
    emitStreamStart({ workspaceId, messageId, model, startTime, replay: true });
    emitStreamDelta({ workspaceId, messageId, timestamp: startTime + 1000, replay: true });
    emitToolCall({
      workspaceId,
      messageId,
      startTimestamp: startTime + 2000,
      endTimestamp: startTime + 3000,
      replay: true,
    });

    await service.waitForIdle(workspaceId);

    const afterRaw = await fs.readFile(timingFilePath, "utf-8");
    const afterSnapshot = await service.getSnapshot(workspaceId);

    expect(afterRaw).toBe(beforeRaw);

    expect(afterSnapshot.active).toBeUndefined();
    expect(afterSnapshot.lastRequest).toEqual(beforeSnapshot.lastRequest);
    expect(afterSnapshot.session).toEqual(beforeSnapshot.session);
  });

  it("does not double-count overlapping tool calls", async () => {
    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 3_000_000;

    emitStreamStart({ workspaceId, messageId, model, startTime });
    emitStreamDelta({ workspaceId, messageId, tokens: 2, timestamp: startTime + 500 });

    // Two tools overlap: [1000, 3000] and [1500, 4000]
    const endFirstTool = emitToolCall({
      workspaceId,
      messageId,
      args: { cmd: "sleep 2" },
      tokens: 1,
      startTimestamp: startTime + 1000,
      endTimestamp: startTime + 3000,
      deferEnd: true,
    }) as () => void;
    const endSecondTool = emitToolCall({
      workspaceId,
      messageId,
      toolCallId: "t2",
      args: { cmd: "sleep 3" },
      tokens: 1,
      startTimestamp: startTime + 1500,
      endTimestamp: startTime + 4000,
      deferEnd: true,
    }) as () => void;
    endFirstTool();
    endSecondTool();

    emitStreamEnd({ workspaceId, messageId, model, outputTokens: 1, totalTokens: 2 });

    await service.waitForIdle(workspaceId);

    const snapshot = await service.getSnapshot(workspaceId);
    expect(snapshot.lastRequest?.totalDurationMs).toBe(5000);

    // Tool wall-time should be the union: [1000, 4000] = 3000ms.
    expect(snapshot.lastRequest?.toolExecutionMs).toBe(3000);
    expect(snapshot.lastRequest?.toolExecutionMs).toBeLessThanOrEqual(
      snapshot.lastRequest?.totalDurationMs ?? 0
    );

    expect(snapshot.lastRequest?.ttftMs).toBe(500);
    expect(snapshot.lastRequest?.streamingMs).toBe(1500);
    expect(snapshot.lastRequest?.invalid).toBe(false);
  });

  it("emits invalid timing telemetry when tool percent would exceed 100%", async () => {
    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 2_000_000;

    emitStreamStart({ workspaceId, messageId, model, startTime });

    emitToolCall({
      workspaceId,
      messageId,
      args: { cmd: "sleep" },
      tokens: 1,
      startTimestamp: startTime + 100,
      endTimestamp: startTime + 10_100,
    });
    emitStreamEnd({
      workspaceId,
      messageId,
      model,
      duration: 1000,
      outputTokens: 1,
      totalTokens: 2,
    });

    await service.waitForIdle(workspaceId);

    expect(telemetry.capture).toHaveBeenCalled();

    const calls = (telemetry.capture as unknown as { mock: { calls: Array<[unknown]> } }).mock
      .calls;

    const invalidCalls = calls.filter((c) => {
      const payload = c[0];
      if (!payload || typeof payload !== "object") {
        return false;
      }

      return (
        "event" in payload && (payload as { event?: unknown }).event === "stream_timing_invalid"
      );
    });

    expect(invalidCalls.length).toBeGreaterThan(0);
  });

  it("throttles delta-driven change events per workspace", async () => {
    const workspaceId = "test-workspace";
    const startTime = 5_000_000;

    const onChange = mock<(workspaceId: string) => void>(() => undefined);

    service.onStatsChange(onChange);
    service.addSubscriber(workspaceId);

    try {
      emitStreamStart({ workspaceId, startTime });

      expect(onChange).toHaveBeenCalledTimes(1);

      // First token should be emitted immediately so TTFT updates promptly.
      emitStreamDelta({ workspaceId, tokens: 1, timestamp: startTime + 100 });

      expect(onChange).toHaveBeenCalledTimes(2);

      // Burst of deltas should coalesce into a single trailing emit.
      for (let i = 0; i < 25; i++) {
        emitStreamDelta({
          workspaceId,
          delta: "x",
          tokens: 1,
          timestamp: startTime + 200 + i,
        });
      }

      // Still only the immediate start + first token emits.
      expect(onChange).toHaveBeenCalledTimes(2);

      await sleep(250);
      expect(onChange).toHaveBeenCalledTimes(3);

      // Without new deltas, we shouldn't keep emitting.
      await sleep(250);
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      service.offStatsChange(onChange);
      service.removeSubscriber(workspaceId);
    }
  });

  it("clears scheduled delta emits when the last subscriber disconnects", async () => {
    const workspaceId = "test-workspace";
    const startTime = 6_000_000;

    const onChange = mock<(workspaceId: string) => void>(() => undefined);

    service.onStatsChange(onChange);
    service.addSubscriber(workspaceId);

    try {
      emitStreamStart({ workspaceId, startTime });
      emitStreamDelta({ workspaceId, tokens: 1, timestamp: startTime + 100 });

      expect(onChange).toHaveBeenCalledTimes(2);

      // Schedule a throttled emit.
      emitStreamDelta({
        workspaceId,
        delta: "x",
        tokens: 1,
        timestamp: startTime + 200,
      });

      const deltaEmitState = (
        service as unknown as { deltaEmitState: Map<string, { timer?: unknown }> }
      ).deltaEmitState;
      expect(deltaEmitState.get(workspaceId)?.timer).toBeDefined();

      // Unsubscribe before the throttle window elapses; timer should be cleared.
      service.removeSubscriber(workspaceId);
      expect(deltaEmitState.has(workspaceId)).toBe(false);

      await sleep(250);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      service.offStatsChange(onChange);
      service.removeSubscriber(workspaceId);
    }
  });
});
