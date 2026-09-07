import type { StreamEndEvent } from "@/common/types/stream";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";

import type { SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { Ok, Err } from "@/common/types/result";
import { ProvidersConfigStore, type Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import { AgentSession } from "./agentSession";
import type { CompactionMonitor } from "./compactionMonitor";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  createStreamLifecycleMocks,
} from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

describe("AgentSession on-send auto-compaction snapshot deferral", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await historyCleanup?.();
  });

  async function createSessionHarness(args: {
    workspaceId: string;
    streamMessage?: AIService["streamMessage"];
    config?: Config;
    captureEvents?: boolean;
  }) {
    const harness = await createAgentSessionHarness({
      workspaceId: args.workspaceId,
      config: args.config,
      aiServiceOverrides: args.streamMessage ? { streamMessage: args.streamMessage } : undefined,
      captureEvents: args.captureEvents,
    });
    historyCleanup = harness.cleanup;
    return harness;
  }

  test("does not persist or emit snapshots before forced on-send compaction", async () => {
    const workspaceId = "ws-auto-compaction-snapshot-deferral";

    const streamMessage = mock((_history: MuxMessage[]) =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, historyService, events, backgroundProcessManager } =
      await createSessionHarness({
        workspaceId,
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
        captureEvents: true,
      });
    const cleanupSpy = spyOn(backgroundProcessManager, "cleanup");

    const syntheticSnapshot = createMuxMessage(
      "file-snapshot-1",
      "user",
      "<snapshot>@foo.ts</snapshot>",
      {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["@foo.ts"],
      }
    );

    const internals = session as unknown as {
      materializeFileAtMentionsSnapshot: (
        text: string
      ) => Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null>;
      compactionMonitor: CompactionMonitor;
    };

    internals.materializeFileAtMentionsSnapshot = mock((_text: string) =>
      Promise.resolve({
        snapshotMessage: syntheticSnapshot,
        materializedTokens: ["@foo.ts"],
      })
    );

    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const result = await session.sendMessage("please inspect @foo.ts", {
      model: "openai:gpt-4o",
      agentId: "exec",
      disableWorkspaceAgents: true,
      toolPolicy: restrictedPolicy,
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedSnapshot = historyResult.data.some(
      (message) => message.metadata?.fileAtMentionSnapshot?.includes("@foo.ts") === true
    );
    expect(persistedSnapshot).toBe(false);

    const persistedCompactionMessage = historyResult.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionMessage).toBeDefined();
    expect(persistedCompactionMessage?.metadata?.disableWorkspaceAgents).toBe(true);
    // The durable follow-up must keep the caller's restrictions: the redispatched turn
    // reconstructs its options from this persisted request, and dropping the policy there
    // would resume the conversation allow-all after compaction.
    const followUpContent =
      persistedCompactionMessage?.metadata?.muxMetadata?.type === "compaction-request"
        ? persistedCompactionMessage.metadata.muxMetadata.parsed.followUpContent
        : undefined;
    expect(followUpContent?.toolPolicy).toEqual(restrictedPolicy);
    expect(followUpContent?.disableWorkspaceAgents).toBe(true);

    const emittedSnapshot = events.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "id" in message &&
        message.id === "file-snapshot-1"
    );
    expect(emittedSnapshot).toBe(false);
    expect(cleanupSpy).not.toHaveBeenCalled();

    await session.dispose();
  });

  test("tracks a compaction request when a synthetic snapshot follows it", async () => {
    const model = "openai:gpt-4o";
    const { session } = await createSessionHarness({
      workspaceId: "ws-auto-compaction-request-correlation",
    });
    const compactionMetadata = {
      type: "compaction-request" as const,
      rawCommand: "/compact",
      parsed: {},
      source: "auto-compaction" as const,
    };
    const compactionRequest = createMuxMessage(
      "compaction-request",
      "user",
      "Summarize the conversation",
      {
        synthetic: true,
        muxMetadata: compactionMetadata,
      }
    );
    const snapshot = createMuxMessage("file-change", "user", "<file-change />", {
      synthetic: true,
    });
    const internals = session as unknown as {
      resolveCompactionRequest: (
        history: MuxMessage[],
        modelString: string,
        options: SendMessageOptions
      ) => { id: string; source?: string } | undefined;
    };

    const request = internals.resolveCompactionRequest([compactionRequest, snapshot], model, {
      model,
      agentId: "compact",
      muxMetadata: compactionMetadata,
    });

    expect(request).toMatchObject({
      id: compactionRequest.id,
      source: "auto-compaction",
    });

    await session.dispose();
  });

  test("does not materialize skill snapshots (or run their directives) on deferred on-send compaction turns", async () => {
    const workspaceId = "ws-auto-compaction-skill-snapshot-deferral";

    const { session } = await createSessionHarness({ workspaceId });

    const internals = session as unknown as {
      materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
      compactionMonitor: CompactionMonitor;
    };

    // Materialization can execute skill dynamic-context directives (side effects),
    // so a turn that defers to on-send compaction must not materialize at all —
    // the post-compaction follow-up re-enters sendMessage and materializes then.
    const materializeSkillSnapshots = mock(() => Promise.resolve([]));
    internals.materializeAgentSkillSnapshots = materializeSkillSnapshots;

    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("use my-skill", {
      model: "openai:gpt-4o",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/my-skill",
        skillName: "my-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);
    expect(materializeSkillSnapshots).not.toHaveBeenCalled();

    await session.dispose();
  });

  test("stamps on-send auto-compaction requests with the RLM keep-recent tail only when RLM is on", async () => {
    const runCase = async (args: {
      workspaceId: string;
      experiments?: SendMessageOptions["experiments"];
    }) => {
      const { session, historyService } = await createSessionHarness({
        workspaceId: args.workspaceId,
      });

      // Seed a prior turn so the keep-recent selector has a safe user boundary
      // (u1 @ seq 2) with a provider-eligible head (u0, a0) before it.
      for (const message of [
        createMuxMessage("u0", "user", "old question"),
        createMuxMessage("a0", "assistant", "old answer"),
        createMuxMessage("u1", "user", "recent question"),
        createMuxMessage("a1", "assistant", "recent answer"),
      ]) {
        const seedResult = await historyService.appendToHistory(args.workspaceId, message);
        if (!seedResult.success) throw new Error(seedResult.error);
      }

      const internals = session as unknown as { compactionMonitor: CompactionMonitor };
      internals.compactionMonitor = {
        checkBeforeSend: mock(() => ({
          shouldShowWarning: true,
          shouldForceCompact: true,
          usagePercentage: 99,
          thresholdPercentage: 85,
        })),
        checkMidStream: mock(() => false),
        resetForNewStream: mock(() => undefined),
        setThreshold: mock(() => undefined),
        getThreshold: mock(() => 0.85),
      } as unknown as CompactionMonitor;

      const result = await session.sendMessage("next question", {
        model: "openai:gpt-4o",
        agentId: "exec",
        ...(args.experiments ? { experiments: args.experiments } : {}),
      });
      expect(result.success).toBe(true);

      const historyResult = await historyService.getHistoryFromLatestBoundary(args.workspaceId);
      if (!historyResult.success) throw new Error(String(historyResult.error));
      const request = historyResult.data.find(
        (message) => message.metadata?.muxMetadata?.type === "compaction-request"
      );
      expect(request).toBeDefined();

      await session.dispose();
      const muxMetadata = request?.metadata?.muxMetadata;
      return muxMetadata?.type === "compaction-request" ? muxMetadata.keepRecentTail : undefined;
    };

    // RLM on (sub-experiment of PTC): stamped with u1's historySequence.
    const stamped = await runCase({
      workspaceId: "ws-auto-compaction-rlm-stamp-on",
      experiments: { programmaticToolCalling: true, rlm: true },
    });
    expect(stamped).toEqual({ startHistorySequence: 2 });
    await historyCleanup?.();

    // RLM flag without a PTC parent flag stays inert.
    const inert = await runCase({
      workspaceId: "ws-auto-compaction-rlm-stamp-inert",
      experiments: { rlm: true },
    });
    expect(inert).toBeUndefined();
    await historyCleanup?.();

    // RLM off: byte-identical request metadata (no stamp).
    const unstamped = await runCase({ workspaceId: "ws-auto-compaction-rlm-stamp-off" });
    expect(unstamped).toBeUndefined();
  });

  test("preserves goal kind and goal identity on auto-compaction follow-up requests", async () => {
    const { session } = await createSessionHarness({
      workspaceId: "ws-auto-compaction-goal-kind",
    });

    const followUp = (
      session as unknown as {
        buildAutoCompactionFollowUp: (params: {
          messageText: string;
          options: SendMessageOptions;
          modelForStream: string;
          goalKind?: typeof GOAL_CONTINUATION_KIND;
          goalId?: string;
        }) => CompactionFollowUpRequest;
      }
    ).buildAutoCompactionFollowUp({
      messageText: "Continue goal",
      options: { model: "openai:gpt-4o", agentId: "exec" },
      modelForStream: "openai:gpt-4o",
      goalKind: GOAL_CONTINUATION_KIND,
      goalId: "goal-compaction-scope",
    });

    expect(followUp.goalKind).toBe(GOAL_CONTINUATION_KIND);
    // Codex P2 (PRRT_kwDOPxxmWM6cIv2E): the re-dispatched follow-up row must
    // stay goal-scoped instead of degrading to a legacy unscoped row.
    expect(followUp.goalId).toBe("goal-compaction-scope");
    await session.dispose();
  });

  test("triggers on-send compaction at threshold even before force buffer", async () => {
    const workspaceId = "ws-auto-compaction-on-send-threshold";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: false,
        usagePercentage: 72,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(true);

    await session.dispose();
  });

  test("uses preferred compaction model for on-send auto-compaction requests", async () => {
    const workspaceId = "ws-auto-compaction-preferred-model";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const compactionModel = "openai:gpt-4o-mini";
    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: { compact: { modelString: compactionModel } },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({
      workspaceId,
      config,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 95,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const compactionRequestMessage = requestMessages.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );

    expect(compactionRequestMessage?.metadata?.muxMetadata?.requestedModel).toBe(compactionModel);

    await session.dispose();
  });

  test("does not trigger compaction at 200K threshold when 1M context is preserved after agent routing", async () => {
    const workspaceId = "ws-auto-compaction-preserved-1m-routing";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session, historyService } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const appendSeedUsage = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-1m-routing-usage", "assistant", "existing context", {
        timestamp: Date.now() - 1_000,
        model: "anthropic:claude-sonnet-4-5",
        contextUsage: {
          inputTokens: 150_000,
          outputTokens: 0,
          totalTokens: 150_000,
        },
      })
    );
    expect(appendSeedUsage.success).toBe(true);

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-6",
      agentId: "exec",
      providerOptions: {
        anthropic: {
          // Keep the routed follow-up's 1M intent visible to the compaction check so
          // it uses the 1M limit instead of the default 200K Anthropic limit.
          use1MContext: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(false);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedCompactionRequest = historyResult.data.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionRequest).toBe(false);

    await session.dispose();
  });

  test("does trigger compaction at the default beta Anthropic threshold when beta features disable 1M", async () => {
    const workspaceId = "ws-auto-compaction-disabled-beta-1m";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session, historyService } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const appendSeedUsage = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-disabled-beta-usage", "assistant", "existing context", {
        timestamp: Date.now() - 1_000,
        model: "anthropic:claude-sonnet-4-5",
        contextUsage: {
          inputTokens: 150_000,
          outputTokens: 0,
          totalTokens: 150_000,
        },
      })
    );
    expect(appendSeedUsage.success).toBe(true);

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      providerOptions: {
        anthropic: {
          use1MContext: true,
          disableBetaFeatures: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedCompactionRequest = historyResult.data.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionRequest).toBe(true);

    await session.dispose();
  });

  test("compaction model inherit uses caller-provided baseOptions.model when no preferred model configured", async () => {
    const workspaceId = "ws-auto-compaction-inherit-base-options-model";

    const { session } = await createSessionHarness({ workspaceId });

    const inheritedModel = "anthropic:claude-sonnet-4-6";
    const baseOptions: SendMessageOptions = {
      model: inheritedModel,
      agentId: "exec",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: inheritedModel,
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
        metadata: {
          requestedModel?: string;
          parsed?: {
            model?: string;
          };
        };
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.model).toBe(inheritedModel);
    expect(compactionRequest.metadata.requestedModel).toBe(inheritedModel);
    expect(compactionRequest.metadata.parsed?.model).toBe(inheritedModel);

    await session.dispose();
  });

  test("clears strictAgentResolution on the internal compact request", async () => {
    const workspaceId = "ws-auto-compaction-clears-strict";

    const { session } = await createSessionHarness({ workspaceId });

    // A strict explicit-agent workspace turn hitting auto-compaction: the internal
    // request intentionally runs the hidden compact agent, so the strict gate must not
    // apply to it (it would reject compact as not selectable and break compaction).
    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-sonnet-4-6",
      agentId: "plan",
      strictAgentResolution: true,
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: baseOptions.model,
      agentId: "plan",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => { sendOptions: SendMessageOptions };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.agentId).toBe("compact");
    expect(compactionRequest.sendOptions.strictAgentResolution).toBeUndefined();

    await session.dispose();
  });

  test("compaction model explicit override takes priority over baseOptions.model", async () => {
    const workspaceId = "ws-auto-compaction-explicit-model-overrides-base-model";

    const compactionModel = "openai:gpt-5.5";
    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: { compact: { modelString: compactionModel } },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({ workspaceId, config });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-sonnet-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
        metadata: {
          requestedModel?: string;
          parsed?: {
            model?: string;
          };
        };
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.model).toBe(compactionModel);
    expect(compactionRequest.metadata.requestedModel).toBe(compactionModel);
    expect(compactionRequest.metadata.parsed?.model).toBe(compactionModel);

    await session.dispose();
  });

  test("compaction thinking level prefers compact agent default over baseOptions", async () => {
    const workspaceId = "ws-auto-compaction-compact-thinking-default";

    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: {
          compact: { modelString: "openai:gpt-5.5", thinkingLevel: "high" },
        },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({ workspaceId, config });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      thinkingLevel: "low",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    // The compact agent's configured thinking level wins over the active stream's,
    // matching desktop /compact (applyCompactionOverrides).
    expect(compactionRequest.sendOptions.thinkingLevel).toBe("high");

    await session.dispose();
  });

  test("compaction thinking level falls back to baseOptions when compact default is unset", async () => {
    const workspaceId = "ws-auto-compaction-base-thinking-fallback";

    const { session } = await createSessionHarness({ workspaceId });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      thinkingLevel: "medium",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "on-send",
    });

    expect(compactionRequest.sendOptions.thinkingLevel).toBe("medium");

    await session.dispose();
  });

  test("threads providers config into pre-send and mid-stream compaction checks", async () => {
    const workspaceId = "ws-auto-compaction-providers-config";

    const { config, historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const providersConfig = {
      openai: {
        models: [
          {
            id: "openai:gpt-4o",
            contextWindow: 222_222,
          },
        ],
      },
    };
    new ProvidersConfigStore(config.rootDir).saveProvidersConfig(providersConfig);

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      const usage = {
        inputTokens: 42,
        outputTokens: 1,
        totalTokens: 43,
      };

      aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: "assistant-providers-config",
        usage,
      });

      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-providers-config",
        parts: [],
        metadata: {
          model: "openai:gpt-4o",
          contextUsage: usage,
          providerMetadata: {},
        },
      });

      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((_params: unknown) => ({
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage: 85,
    }));
    const checkMidStream = mock((_params: unknown) => false);

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);
    expect(checkBeforeSend.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    expect(checkMidStream).toHaveBeenCalledTimes(1);
    expect(checkMidStream.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    await session.dispose();
  });

  test("seeds on-send compaction usage from the active compaction epoch only", async () => {
    const workspaceId = "ws-auto-compaction-seed-active-epoch";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const oldUsage = {
      inputTokens: 95_000,
      outputTokens: 100,
      totalTokens: 95_100,
    };

    const appendOldUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-old-before-boundary", "user", "old prompt", {
        timestamp: Date.now() - 4_000,
      })
    );
    expect(appendOldUser.success).toBe(true);

    const appendOldAssistant = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-old-before-boundary", "assistant", "old reply", {
        timestamp: Date.now() - 3_000,
        model: "openai:gpt-4o",
        contextUsage: oldUsage,
      })
    );
    expect(appendOldAssistant.success).toBe(true);

    const appendBoundary = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-compaction-boundary", "assistant", "compacted summary", {
        timestamp: Date.now() - 2_000,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 7,
      })
    );
    expect(appendBoundary.success).toBe(true);

    const appendCurrentEpochUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-after-boundary", "user", "fresh prompt after compaction", {
        timestamp: Date.now() - 1_000,
      })
    );
    expect(appendCurrentEpochUser.success).toBe(true);

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({}),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((params: unknown) => {
      expect((params as { usage?: unknown }).usage).toBeUndefined();
      return {
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      };
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("new prompt after restart", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);

    await session.dispose();
  });

  test("surfaces nested dispatch failures after mid-stream compaction interrupt", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-dispatch-failure";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    let streamCallCount = 0;
    const streamMessage = mock((_request: unknown) => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const stopStream = mock((_workspaceId: string) => {
      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({}),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as {
      compactionMonitor: CompactionMonitor;
      sendMessage: AgentSession["sendMessage"];
    };

    let midStreamChecks = 0;
    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock((_params: unknown) => {
        midStreamChecks += 1;
        return midStreamChecks === 1;
      }),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const originalSendMessage = session.sendMessage.bind(session);
    let sendCallCount = 0;
    internals.sendMessage = (async (...args: Parameters<AgentSession["sendMessage"]>) => {
      sendCallCount += 1;
      if (sendCallCount === 1) {
        return originalSendMessage(...args);
      }

      return Err({ type: "unknown", raw: "mid-stream compaction dispatch failed" });
    }) as AgentSession["sendMessage"];

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent(({ message }) => {
      events.push(message);
    });

    const result = await internals.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (!events.some((event) => event.type === "stream-error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const streamError = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "stream-error" }> =>
        event.type === "stream-error"
    );
    expect(streamError).toBeDefined();
    expect(streamError?.error).toContain("mid-stream compaction dispatch failed");
    expect(stopStream).toHaveBeenCalledTimes(1);

    await session.dispose();
  });

  test("hides default follow-up sentinel in mid-stream auto-compaction prompts", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-sentinel";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamHistories: MuxMessage[][] = [];
    let streamCallCount = 0;
    const streamMessage = mock((request: unknown) => {
      const requestMessages =
        typeof request === "object" && request !== null && "messages" in request
          ? (request as { messages?: unknown }).messages
          : undefined;
      streamHistories.push(Array.isArray(requestMessages) ? (requestMessages as MuxMessage[]) : []);
      streamCallCount += 1;

      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const stopStream = mock((_workspaceId: string) => {
      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({}),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    let midStreamChecks = 0;
    const checkMidStream = mock((_params: unknown) => {
      midStreamChecks += 1;
      return midStreamChecks === 1;
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const workspaceTurnMetadata = {
      type: "workspace-turn-task",
      taskHandleId: "wst_mid_stream_compaction",
      ownerWorkspaceId: "parent-mid-stream-compaction",
      turnId: "turn-mid-stream-compaction",
    } as const;
    const result = await session.sendMessage(
      "hello",
      {
        model: "openai:gpt-4o",
        agentId: "exec",
        muxMetadata: workspaceTurnMetadata,
      },
      { agentInitiated: true }
    );

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (streamHistories.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(streamHistories.length).toBeGreaterThanOrEqual(2);
    const compactionHistory = streamHistories[1];
    const compactionRequestMessage = [...compactionHistory]
      .reverse()
      .find((message) => message.metadata?.muxMetadata?.type === "compaction-request");

    expect(compactionRequestMessage).toBeDefined();

    const compactionRequestMetadata = compactionRequestMessage?.metadata?.muxMetadata;
    expect(compactionRequestMetadata?.type).toBe("compaction-request");
    if (compactionRequestMetadata?.type !== "compaction-request") {
      throw new Error("Expected a persisted mid-stream compaction request");
    }
    expect(compactionRequestMetadata.parsed.followUpContent?.muxMetadata).toEqual(
      workspaceTurnMetadata
    );
    expect(compactionRequestMetadata.parsed.followUpContent?.agentInitiated).toBe(true);

    const compactionRequestText =
      compactionRequestMessage?.parts.find((part) => part.type === "text")?.text ?? "";
    expect(compactionRequestText).not.toContain("The user wants to continue with:");
    expect(compactionRequestText).not.toContain("[CONTINUE]");
    expect(stopStream).toHaveBeenCalledTimes(1);

    await session.dispose();
  });
});

describe("AgentSession on-send auto-compaction for synthetic guidance sends", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await historyCleanup?.();
  });

  interface GuidanceStreamFixture {
    session: AgentSession;
    historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"];
    aiEmitter: EventEmitter;
    streamHistories: MuxMessage[][];
    events: WorkspaceChatMessage[];
  }

  /**
   * Harness that mimics a parent workspace sending guidance to a child task:
   * sendMessage with internal {synthetic, agentInitiated} and a mock AI stream
   * that completes with a prose summary so compaction can finish end-to-end.
   */
  async function createGuidanceHarness(args: {
    workspaceId: string;
    summaryText?: string;
  }): Promise<GuidanceStreamFixture> {
    const workspaceId = args.workspaceId;
    const streamHistories: MuxMessage[][] = [];

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((request: unknown) => {
      const requestMessages =
        typeof request === "object" && request !== null && "messages" in request
          ? (request as { messages?: unknown }).messages
          : undefined;
      streamHistories.push(Array.isArray(requestMessages) ? (requestMessages as MuxMessage[]) : []);

      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: `assistant-${streamHistories.length}`,
        model: "openai:gpt-4o",
        historySequence: streamHistories.length,
        startTime: Date.now(),
      });

      const usage = {
        inputTokens: 42,
        outputTokens: 10,
        totalTokens: 52,
      };
      const streamEnd: StreamEndEvent = {
        type: "stream-end",
        workspaceId,
        messageId: `assistant-${streamHistories.length}`,
        parts: [{ type: "text", text: args.summaryText ?? "Summary of the conversation so far." }],
        metadata: {
          model: "openai:gpt-4o",
          usage,
          contextUsage: usage,
        },
      };
      aiEmitter.emit("stream-end", streamEnd);
      return Promise.resolve(
        Ok({
          messageId: streamEnd.messageId,
          completion: Promise.resolve({ status: "completed" as const, streamEnd }),
        })
      );
    });

    const harness = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      aiEmitter,
      aiServiceOverrides: {
        isStreaming: mock((_workspaceId: string) => false),
        stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
        getWorkspaceMetadata: mock((_workspaceId: string) =>
          // No real workspace behind the test session; skip @file snapshot materialization.
          Promise.resolve(Err("no workspace metadata in test"))
        ),
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    historyCleanup = harness.cleanup;

    // Cross the on-send threshold unconditionally.
    (harness.session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 95,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    return {
      session: harness.session,
      historyService: harness.historyService,
      aiEmitter,
      streamHistories,
      events: harness.events,
    };
  }

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 2000
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return predicate();
  }

  test("applies compaction when synthetic agent-initiated send crosses the threshold", async () => {
    const fixture = await createGuidanceHarness({
      workspaceId: "ws-auto-compaction-synthetic-guidance",
    });

    const result = await fixture.session.sendMessage(
      "Updated guidance from parent: focus on the failing tests.",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: true, agentInitiated: true, startStreamInBackground: true }
    );
    expect(result.success).toBe(true);

    // First stream must carry the persisted compaction request.
    await waitFor(() => fixture.streamHistories.length >= 1);
    expect(fixture.streamHistories.length).toBeGreaterThanOrEqual(1);
    const firstRequestHasCompactionRequest = fixture.streamHistories[0].some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(firstRequestHasCompactionRequest).toBe(true);

    // Compaction must complete: a boundary summary lands in durable history.
    const boundaryLanded = await waitFor(async () => {
      const historyResult = await fixture.historyService.getHistoryFromLatestBoundary(
        "ws-auto-compaction-synthetic-guidance"
      );
      return (
        historyResult.success &&
        historyResult.data.some((message) => message.metadata?.compactionBoundary === true)
      );
    });
    expect(boundaryLanded).toBe(true);

    // The original guidance text is re-dispatched as the post-compaction follow-up.
    const followUpDispatched = await waitFor(() =>
      fixture.streamHistories.some((history) =>
        history.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text.includes("focus on the failing tests")
            )
        )
      )
    );
    expect(followUpDispatched).toBe(true);

    expect(
      fixture.events.some(
        (event) => (event as { type?: string }).type === "auto-compaction-triggered"
      )
    ).toBe(true);
    expect(
      fixture.events.some(
        (event) => (event as { type?: string }).type === "auto-compaction-completed"
      )
    ).toBe(true);

    await fixture.session.dispose();
  });

  // Characterization: sends carrying preTurnMessages (family-message payloads)
  // intentionally skip on-send compaction. The trigger row references its
  // payload by message ID, so compacting the payload away would dangle that
  // reference, and the follow-up metadata cannot carry pre-turn rows. Mid-stream
  // forcing remains the context-limit backstop for these sends.
  test("family-payload sends with preTurnMessages skip on-send compaction", async () => {
    const fixture = await createGuidanceHarness({
      workspaceId: "ws-auto-compaction-family-payload",
    });

    const payloadRow = createMuxMessage("payload-1", "assistant", "[Untrusted family message]", {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "family-message" },
    });

    const result = await fixture.session.sendMessage(
      "Child task abc sent a family message recorded in assistant message payload-1.",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: true, agentInitiated: true, preTurnMessages: [payloadRow] }
    );
    expect(result.success).toBe(true);

    // No on-send compaction request is created for family-payload sends.
    expect(fixture.streamHistories.length).toBeGreaterThanOrEqual(1);
    const firstRequestHasCompactionRequest = fixture.streamHistories[0].some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(firstRequestHasCompactionRequest).toBe(false);

    // The payload and trigger persist as a normal turn instead.
    const historyResult = await fixture.historyService.getHistoryFromLatestBoundary(
      "ws-auto-compaction-family-payload"
    );
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }
    expect(historyResult.data.some((message) => message.id === "payload-1")).toBe(true);

    await fixture.session.dispose();
  });

  test("startup retry of an interrupted compaction keeps compaction identity", async () => {
    const workspaceId = "ws-compaction-startup-retry";
    const fixture = await createGuidanceHarness({ workspaceId });

    // Simulate a crash mid-compaction: durable compaction request row followed
    // by a synthetic row (e.g. a file-change notice) appended before resume.
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-prior", "assistant", "prior context", {
        timestamp: Date.now(),
        model: "openai:gpt-4o",
      })
    );
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("compaction-req-1", "user", "Summarize the conversation.", {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          commandPrefix: "/compact",
          parsed: {},
          requestedModel: "openai:gpt-4o",
          source: "auto-compaction",
        },
      })
    );
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("file-change-1", "user", "<system-file-update>foo.ts</system-file-update>", {
        timestamp: Date.now(),
        synthetic: true,
      })
    );

    const outcome = await (
      fixture.session as unknown as {
        scheduleStartupAutoRetryIfNeeded: () => Promise<string>;
      }
    ).scheduleStartupAutoRetryIfNeeded();
    expect(outcome).toBe("completed");

    // The resumed stream must still be tracked as a compaction request.
    const streamed = await waitFor(() => fixture.streamHistories.length >= 1, 5000);
    expect(streamed).toBe(true);
    const retriedRequestHasCompactionRow = fixture.streamHistories[0].some(
      (message) =>
        message.id === "compaction-req-1" ||
        message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(retriedRequestHasCompactionRow).toBe(true);

    // Compaction must complete on the resumed stream instead of the summary
    // being recorded as a plain assistant response.
    const boundaryLanded = await waitFor(async () => {
      const historyResult = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
      return (
        historyResult.success &&
        historyResult.data.some((message) => message.metadata?.compactionBoundary === true)
      );
    });
    expect(boundaryLanded).toBe(true);

    await fixture.session.dispose();
  });
});
