import type { TurnCoordinator } from "./turnCoordinator";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import {
  AgentSession,
  clearProviderConfigFixableAbandonMarkers,
  type AgentSessionAIService,
} from "./agentSession";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceChatMessage, SendMessageOptions } from "@/common/orpc/types";
import {
  createMuxMessage,
  pickStartupRetrySendOptions,
  type MuxMessage,
} from "@/common/types/message";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
  goalKind?: typeof GOAL_CONTINUATION_KIND;
}

interface RetryableSessionForTests {
  retryActiveStream: () => Promise<void>;
  lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
  resumeStream: (options: SendMessageOptions) => Promise<
    | { success: true; data: { started: boolean } }
    | {
        success: false;
        error: { type: "runtime_start_failed"; message: string };
        failureHandled?: true;
      }
  >;
}

interface SessionBundle {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  aiService: AgentSessionAIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
  cleanup: () => Promise<void>;
}

async function createSessionBundle(
  workspaceId: string,
  aiServiceOverrides?: Partial<AgentSessionAIService>
): Promise<SessionBundle> {
  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceId,
    projectName: "project",
    projectPath: "/tmp/project",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    aiSettingsByAgent: {
      [WORKSPACE_DEFAULTS.agentId]: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
    },
  };

  return createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      ...aiServiceOverrides,
    },
    initStateManagerOverrides: {
      replayInit: mock(() => Promise.resolve()),
    },
    captureEvents: true,
  });
}

describe("AgentSession startup auto-retry recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("schedules startup auto-retry for interrupted user tail", async () => {
    const workspaceId = "startup-retry-user-tail";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Hello from interrupted turn", {
        timestamp: Date.now(),
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
        disableWorkspaceAgents: true,
      })
    );
    expect(appendResult.success).toBe(true);

    const appendSnapshotResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snapshot-1", "user", "<snapshot>", {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["token"],
      })
    );
    expect(appendSnapshotResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    const scheduledEvent = events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduledEvent).toBeDefined();

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup auto-retry options to be captured");
    }
    expect(retryOptions.options.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.options.agentId).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(retryOptions.options.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
    expect(retryOptions.options.disableWorkspaceAgents).toBe(true);

    await session.dispose();
  });

  test("startup auto-retry does not dispatch once the workspace is archived on disk", async () => {
    const workspaceId = "startup-retry-archived";
    const { session, config, historyService, events, cleanup } =
      await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before the archive", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    // The archive lands while the check is still reading history (a regular session the client
    // created is not disposed by archive, so only the durable state can stop the dispatch).
    const getLastMessages = historyService.getLastMessages.bind(historyService);
    spyOn(historyService, "getLastMessages").mockImplementation(async (id, count) => {
      const result = await getLastMessages(id, count);
      await config.editConfig((cfg) => {
        cfg.projects.set("/tmp/project", {
          workspaces: [
            {
              id: workspaceId,
              path: `/tmp/project/${workspaceId}`,
              name: workspaceId,
              archivedAt: new Date().toISOString(),
            },
          ],
        });
        return cfg;
      });
      return result;
    });

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    // Completed rather than deferred: nothing reruns the check for an archived workspace.

    await session.dispose();
  });

  test("auto-retry abandons instead of resuming once the workspace is archived on disk", async () => {
    const workspaceId = "startup-retry-archived-before-timer";
    const { session, config, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as RetryableSessionForTests;
    privateSession.lastAutoRetryResumeRequest = {
      options: { model: "anthropic:claude-sonnet-4-5", agentId: "exec" },
    };
    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    // The archive lands during the backoff countdown; only the durable state can stop the timer.
    await config.editConfig((cfg) => {
      cfg.projects.set("/tmp/project", {
        workspaces: [
          {
            id: workspaceId,
            path: `/tmp/project/${workspaceId}`,
            name: workspaceId,
            archivedAt: new Date().toISOString(),
          },
        ],
      });
      return cfg;
    });

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).not.toHaveBeenCalled();
    const abandonedReasons = events
      .filter(
        (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-abandoned" }> =>
          event.type === "auto-retry-abandoned"
      )
      .map((event) => event.reason);
    expect(abandonedReasons).toEqual(["workspace_archived"]);

    await session.dispose();
  });

  test("beginShutdown cancels the pending retry and stops re-arming or streaming", async () => {
    const workspaceId = "startup-retry-shutdown";
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
    );
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId, {
      streamMessage: streamMessage as unknown as AgentSessionAIService["streamMessage"],
    });
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      handleStreamFailureForAutoRetry: (error: { type: string; message?: string }) => Promise<void>;
    };
    await privateSession.handleStreamFailureForAutoRetry({ type: "unknown", message: "boom" });
    expect(session.shouldRetainAfterStartupRecovery()).toBe(true);
    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(scheduledBefore).toBe(1);

    session.beginShutdown();

    expect(session.shouldRetainAfterStartupRecovery()).toBe(false);
    await privateSession.handleStreamFailureForAutoRetry({ type: "unknown", message: "boom" });
    expect(events.filter((event) => event.type === "auto-retry-scheduled").length).toBe(
      scheduledBefore
    );
    // Not disposed, but sends are refused before any row lands: a follow-up row persisted here
    // would read as a dispatched turn on the next startup while its stream never ran.
    const sendResult = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(false);
    expect(streamMessage).not.toHaveBeenCalled();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);

    await session.dispose();
  });

  test.each(["materialize", "append"] as const)(
    "beginShutdown inside the %s await rolls the unaccepted turn back instead of leaving a row",
    async (window) => {
      const workspaceId = `startup-retry-shutdown-mid-${window}`;
      const streamMessage = mock(() =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
      );
      const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
        streamMessage: streamMessage as unknown as AgentSessionAIService["streamMessage"],
      });
      cleanups.push(cleanup);
      const seeded = [
        createMuxMessage("user-0", "user", "earlier turn", { timestamp: Date.now() }),
        createMuxMessage("assistant-0", "assistant", "earlier answer", { timestamp: Date.now() }),
      ];
      for (const row of seeded) {
        expect((await historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }

      // Shutdown lands after the pre-persist latch check passed, inside a later pre-acceptance
      // await: snapshot materialization, or the user row's own append (already durable then).
      if (window === "materialize") {
        const internals = session as unknown as {
          materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
        };
        const materialize = internals.materializeAgentSkillSnapshots.bind(session);
        internals.materializeAgentSkillSnapshots = async (...args: unknown[]) => {
          const snapshots = await materialize(...args);
          session.beginShutdown();
          return snapshots;
        };
      } else {
        const append = historyService.appendToHistory.bind(historyService);
        spyOn(historyService, "appendToHistory").mockImplementation(async (id, message) => {
          const result = await append(id, message);
          session.beginShutdown();
          return result;
        });
      }

      const sendResult = await session.sendMessage("hello", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      });
      expect(sendResult.success).toBe(false);
      expect(streamMessage).not.toHaveBeenCalled();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data.map((row) => row.id) : ["unexpected"]).toEqual(
        seeded.map((row) => row.id)
      );

      await session.dispose();
    }
  );

  test.each(["materialize", "append"] as const)(
    "beginShutdown inside an edit's %s await keeps the replacement row after truncation",
    async (window) => {
      const workspaceId = `startup-retry-shutdown-edit-${window}`;
      const streamMessage = mock(() =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
      );
      const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
        streamMessage: streamMessage as unknown as AgentSessionAIService["streamMessage"],
      });
      cleanups.push(cleanup);
      for (const [id, role, text] of [
        ["u0", "user", "first turn"],
        ["a0", "assistant", "first answer"],
        ["u1", "user", "original wording"],
        ["a1", "assistant", "answer to the original"],
      ] as const) {
        const row = createMuxMessage(id, role, text, { timestamp: Date.now() });
        expect((await historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }

      // The edit has already truncated u1 and a1 when shutdown lands; only the replacement row
      // records the user's input now, so it must survive instead of being rolled back.
      if (window === "materialize") {
        const internals = session as unknown as {
          materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
        };
        const materialize = internals.materializeAgentSkillSnapshots.bind(session);
        internals.materializeAgentSkillSnapshots = async (...args: unknown[]) => {
          const snapshots = await materialize(...args);
          session.beginShutdown();
          return snapshots;
        };
      } else {
        const append = historyService.appendToHistory.bind(historyService);
        spyOn(historyService, "appendToHistory").mockImplementation(async (id, message) => {
          const result = await append(id, message);
          session.beginShutdown();
          return result;
        });
      }

      const sendResult = await session.sendMessage("edited wording", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        editMessageId: "u1",
      });
      expect(sendResult.success).toBe(false);
      expect(streamMessage).not.toHaveBeenCalled();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data : ["unexpected"]).toMatchObject([
        { id: "u0" },
        { id: "a0" },
        { role: "user", parts: [{ type: "text", text: "edited wording" }] },
      ]);

      await session.dispose();
    }
  );

  test("beginShutdown during pre-stream awaits stops the stream before the provider", async () => {
    const workspaceId = "startup-retry-shutdown-mid-prepare";
    const streamMessage = mock(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
    );
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
      streamMessage: streamMessage as unknown as AgentSessionAIService["streamMessage"],
    });
    cleanups.push(cleanup);

    // Shutdown lands while the stream start is already past its entry check, awaiting disk I/O.
    const commitPartial = historyService.commitPartial.bind(historyService);
    spyOn(historyService, "commitPartial").mockImplementation(async (id) => {
      const result = await commitPartial(id);
      session.beginShutdown();
      return result;
    });

    const sendResult = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(true);
    expect(streamMessage).not.toHaveBeenCalled();

    await session.dispose();
  });

  test("visible completed subagent report cards do not schedule startup auto-retry", async () => {
    const workspaceId = "startup-retry-subagent-report-card";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    await session.dispose();
  });

  test("visible completed subagent report cards do not mask recoverable assistant partials", async () => {
    const workspaceId = "startup-retry-subagent-report-with-partial";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original-user", "user", "Continue the original task", {
        timestamp: Date.now(),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Interrupted response", {
        timestamp: Date.now(),
        partial: true,
      })
    );

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    await session.dispose();
  });

  test("hidden completed subagent reports preserve the existing startup retry fallback", async () => {
    const workspaceId = "startup-retry-hidden-subagent-report";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original-user", "user", "Continue the original task", {
        timestamp: Date.now(),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "hidden-completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    await session.dispose();
  });

  test("startup auto-retry reuses workspace-turn metadata from the retry user message", async () => {
    const workspaceId = "startup-retry-workspace-turn-metadata";
    const { session, historyService, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-id",
    };
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Complete the workspace turn", {
        timestamp: Date.now(),
        retrySendOptions: { model: "openai:gpt-4o", agentId: "exec" },
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const streamMessageMock = mock(
      (_payload: Parameters<AgentSessionAIService["streamMessage"]>[0]) =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    aiService.streamMessage =
      streamMessageMock as unknown as AgentSessionAIService["streamMessage"];
    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;

      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
    };

    await session.ensureStartupAutoRetryCheck();
    expect(privateSession.lastAutoRetryResumeRequest?.options.muxMetadata).toEqual(muxMetadata);

    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0]).toMatchObject({ muxMetadata });

    await session.dispose();
  });

  test("startup auto-retry does not stamp workflow-result metadata on assistant streams", async () => {
    const workspaceId = "startup-retry-workflow-result-metadata";
    const { session, historyService, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const workflowMetadata = {
      type: "workflow-result" as const,
      rawCommand: "/deep-research mux",
      runId: "wfr_1",
    };
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Use the workflow result", {
        timestamp: Date.now(),
        retrySendOptions: pickStartupRetrySendOptions({
          model: "openai:gpt-4o",
          agentId: "exec",
          muxMetadata: workflowMetadata,
        }),
        muxMetadata: workflowMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const streamMessageMock = mock(
      (_payload: Parameters<AgentSessionAIService["streamMessage"]>[0]) =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    aiService.streamMessage =
      streamMessageMock as unknown as AgentSessionAIService["streamMessage"];
    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
    };

    await session.ensureStartupAutoRetryCheck();
    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0].muxMetadata).toBeUndefined();

    await session.dispose();
  });

  test("restores persisted retry send options for startup auto-retry", async () => {
    const workspaceId = "startup-retry-preserve-options";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted with custom send options", {
        timestamp: Date.now(),
        kind: GOAL_CONTINUATION_KIND,
        retrySendOptions: {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          thinkingLevel: "high",
          toolPolicy: [{ regex_match: "bash", action: "disable" }],
          additionalSystemInstructions: "Use one sentence.",
          maxOutputTokens: 2048,
          providerOptions: {
            anthropic: {
              use1MContext: true,
              use1MContextModels: ["anthropic:claude-sonnet-4-5"],
            },
          },
          allowAgentSetGoal: true,
          disableWorkspaceAgents: true,
        },
      })
    );
    expect(appendResult.success).toBe(true);

    const startupRetryModelHint = await session.getStartupAutoRetryModelHint();
    expect(startupRetryModelHint).toBe("anthropic:claude-sonnet-4-5");

    await session.ensureStartupAutoRetryCheck();

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup retry options");
    }

    expect(retryOptions.options.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.options.agentId).toBe("exec");
    expect(retryOptions.options.thinkingLevel).toBe("high");
    expect(retryOptions.options.additionalSystemInstructions).toBe("Use one sentence.");
    expect(retryOptions.options.maxOutputTokens).toBe(2048);
    expect(retryOptions.options.toolPolicy).toEqual([{ regex_match: "bash", action: "disable" }]);
    expect(retryOptions.options.allowAgentSetGoal).toBe(true);
    expect(retryOptions.options.disableWorkspaceAgents).toBe(true);
    expect(retryOptions.goalKind).toBe(GOAL_CONTINUATION_KIND);

    expect(retryOptions.options.providerOptions?.anthropic?.use1MContext).toBe(true);

    await session.dispose();
  });

  test("startup auto-retry discards goal attribution when the persisted goal ID is malformed", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cQt3o): chat.jsonl is unchecked JSON. A
    // present-but-invalid goalId must not resume the turn as goal-driven with
    // untrustworthy identity — a later compaction would persist a missing-ID
    // follow-up that bypasses buildGoalRedispatchAdmission entirely.
    const workspaceId = "startup-retry-malformed-goal-id";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted goal turn", {
        timestamp: Date.now(),
        kind: GOAL_CONTINUATION_KIND,
        goalId: "" as unknown as string,
        retrySendOptions: {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          goalKind: GOAL_CONTINUATION_KIND,
        },
      })
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest & { goalId?: string };
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    expect(retryOptions?.goalKind).toBeUndefined();
    expect(retryOptions?.goalId).toBeUndefined();

    await session.dispose();
  });

  test.each([
    undefined,
    "queued",
    "starting",
    "running",
    "awaiting_report",
    "interrupted",
    "reported",
  ] as const)("leaves child startup recovery to TaskService (status=%s)", async (taskStatus) => {
    const workspaceId = "startup-child-owned";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId, {
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: workspaceId,
            name: workspaceId,
            projectName: "project",
            projectPath: "/tmp/project",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            parentWorkspaceId: "parent",
            taskStatus,
          })
        )
      ),
    });
    cleanups.push(cleanup);
    const followUp = spyOn(
      session as unknown as { dispatchPendingFollowUp(): Promise<boolean> },
      "dispatchPendingFollowUp"
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Unfinished child turn")
    );
    try {
      await session.ensureStartupAutoRetryCheck();
      expect(followUp).not.toHaveBeenCalled();
      expect(session.hasPendingAutoRetry()).toBe(false);
      expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      expect(await session.getStartupAutoRetryModelHint()).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  test.each([
    { reason: "aborted", userMessageId: "user-1", stopped: true },
    { reason: "aborted", userMessageId: undefined, stopped: true },
    { reason: "aborted", userMessageId: "older-user", stopped: false },
    { reason: "context_exceeded", userMessageId: "user-1", stopped: false },
  ])("reads applicable durable user-stop evidence: %j", async (marker) => {
    const workspaceId = "startup-task-stop";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Current intent")
    );
    await fsPromises.writeFile(
      path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json"),
      JSON.stringify({
        startupAutoRetryAbandon: { reason: marker.reason, userMessageId: marker.userMessageId },
      })
    );
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(marker.stopped);
      const history = await historyService.getLastMessages(workspaceId, 20);
      expect(history.success && history.data.map((message) => message.id)).toEqual(["user-1"]);
    } finally {
      await session.dispose();
    }
  });

  test("preserves a scoped Stop until history proves a newer user intent", async () => {
    const workspaceId = "startup-long-stopped-task";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendManyToHistory(workspaceId, [
      createMuxMessage("stopped-user", "user", "Long-running task"),
      ...Array.from({ length: 21 }, (_, index) =>
        createMuxMessage(`assistant-${index}`, "assistant", "Work")
      ),
    ]);
    const preferencePath = path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json");
    await fsPromises.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "stopped-user" },
      })
    );
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(true);
      spyOn(historyService, "getLastMessages").mockRejectedValueOnce(new Error("unreadable"));
      expect(await session.isStartupRecoveryBlocked()).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("notice", "user", "Snapshot", { synthetic: true })
      );
      expect(await session.isStartupRecoveryBlocked()).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("guidance", "user", "Continue", {
          synthetic: true,
          retrySendOptions: { model: "openai:gpt-4o", agentId: "exec", agentInitiated: true },
        })
      );
      expect(await session.isStartupRecoveryBlocked()).toBe(false);
      expect(JSON.parse(await fsPromises.readFile(preferencePath, "utf-8"))).toMatchObject({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "stopped-user" },
      });
    } finally {
      await session.dispose();
    }
  });

  test("blocks task recovery on a real partial-file read error but not a missing partial", async () => {
    const workspaceId = "startup-unreadable-partial";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "Pending work")
    );
    const partialPath = path.join(config.sessionsDir, workspaceId, "partial.json");
    await fsPromises.mkdir(partialPath);
    const wait = spyOn(
      session as unknown as { waitForStartupReadRetry(delay: number): Promise<void> },
      "waitForStartupReadRetry"
    ).mockResolvedValue(undefined);
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(true);
      expect(wait).toHaveBeenCalled();
      await fsPromises.rm(partialPath, { recursive: true });
      expect(await session.isStartupRecoveryBlocked()).toBe(false);
    } finally {
      wait.mockRestore();
      await session.dispose();
    }
  });

  test("does not strand a task behind crash-truncated partial JSON", async () => {
    const workspaceId = "startup-corrupt-partial";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Continue"));
    await fsPromises.writeFile(
      path.join(config.sessionsDir, workspaceId, "partial.json"),
      '{"id":'
    );
    const wait = spyOn(
      session as unknown as { waitForStartupReadRetry(delay: number): Promise<void> },
      "waitForStartupReadRetry"
    );
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(false);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      await session.dispose();
    }
  });

  test("task read retries settle while a provider stream remains active", async () => {
    const workspaceId = "startup-busy-read-retry";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
      isStreaming: mock(() => true),
    });
    cleanups.push(cleanup);
    await historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Work"));
    const read = spyOn(historyService, "getLastMessages").mockRejectedValueOnce(
      new Error("busy disk")
    );
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(false);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("retries a transient task blocker read without restarting the app", async () => {
    const workspaceId = "startup-transient-partial";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "Pending work")
    );
    const partialPath = path.join(config.sessionsDir, workspaceId, "partial.json");
    await fsPromises.mkdir(partialPath);
    const wait = spyOn(
      session as unknown as { waitForStartupReadRetry(delay: number): Promise<void> },
      "waitForStartupReadRetry"
    ).mockImplementationOnce(() => fsPromises.rm(partialPath, { recursive: true }));
    try {
      expect(await session.isStartupRecoveryBlocked()).toBe(false);
      expect(wait).toHaveBeenCalledTimes(1);
    } finally {
      wait.mockRestore();
      await session.dispose();
    }
  });

  test("does not start recovery while workspace identity is unavailable", async () => {
    const { session, historyService, events, cleanup } = await createSessionBundle(
      "startup-unknown",
      {
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("unavailable"))),
      }
    );
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      "startup-unknown",
      createMuxMessage("user-1", "user", "Unfinished")
    );
    const followUp = spyOn(
      session as unknown as { dispatchPendingFollowUp(): Promise<boolean> },
      "dispatchPendingFollowUp"
    );
    try {
      await session.runStartupRecovery();
      expect(followUp).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  test("replays pending auto-retry schedule during reconnect catch-up", async () => {
    const workspaceId = "startup-retry-replay-snapshot";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before reconnect", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    const replayEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => {
      replayEvents.push(message);
    });

    const scheduledIndex = replayEvents.findIndex((event) => event.type === "auto-retry-scheduled");
    const caughtUpIndex = replayEvents.findIndex((event) => event.type === "caught-up");

    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    expect(caughtUpIndex).toBeGreaterThanOrEqual(0);
    expect(scheduledIndex).toBeLessThan(caughtUpIndex);

    await session.dispose();
  });

  test("respects persisted auto-retry opt-out across restart", async () => {
    const workspaceId = "startup-retry-opt-out";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();
    expect(await secondSession.isStartupRecoveryBlocked()).toBe(true);

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("respects legacy auto-retry opt-out hint when backend preference is missing", async () => {
    const workspaceId = "startup-retry-legacy-opt-out";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before migration", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    session.setLegacyAutoRetryEnabledHint(false);
    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    const preferencePath = (
      session as unknown as {
        getAutoRetryPreferencePath: () => string;
      }
    ).getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: unknown;
    };
    expect(persisted.enabled).toBe(false);

    await session.dispose();
  });

  test("does not persist temporary auto-retry enable across restart", async () => {
    const workspaceId = "startup-retry-temporary-enable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    await firstSession.setAutoRetryEnabled(true, { persist: false });
    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("does not reschedule startup retries after persisted non-retryable failure", async () => {
    const workspaceId = "startup-retry-non-retryable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted prompt", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await (
      firstSession as unknown as {
        persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      }
    ).persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("clears persisted startup abandon state once retry resumes successfully", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-resume";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      retryActiveStream: () => Promise<void>;
      getAutoRetryPreferencePath: () => string;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    await privateSession.persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    const preferencePath = privateSession.getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    await session.dispose();
  });

  test("provider config changes clear credential abandon state without starting a stream", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-provider-config";
    const { session, aiService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };
    await privateSession.persistStartupAutoRetryAbandon("authentication", "user-1");
    const preferencePath = privateSession.getAutoRetryPreferencePath();
    const streamMessageSpy = spyOn(aiService, "streamMessage");

    await session.handleProviderConfigChanged();

    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);
    expect(streamMessageSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
  });

  test("a marker recorded while an older clear is still unlinking is written after it and acknowledged once written", async () => {
    const workspaceId = "startup-retry-serialized-abandon-writes";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      clearStartupAutoRetryAbandon: () => Promise<void>;
      getAutoRetryPreferencePath: () => string;
    };
    const preferencePath = privateSession.getAutoRetryPreferencePath();

    // An in-memory preference file whose unlink and marker write the test holds open, so the clear's
    // unlink and the Stop's marker write can be ordered exactly (real I/O would race them).
    let fileContent: string | null = null;
    let markerWrites = 0;
    let holdMarkerWrites = false;
    const unlinkEntered = Promise.withResolvers<void>();
    const releaseUnlink = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
    const { unlink, mkdir, writeFile } = fsPromises;
    const spies = [
      spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
        if (target !== preferencePath) return unlink(target);
        unlinkEntered.resolve();
        await releaseUnlink.promise;
        fileContent = null;
      }),
      spyOn(fsPromises, "mkdir").mockImplementation(async (target, options) => {
        if (target !== path.dirname(preferencePath)) await mkdir(target, options);
      }),
      spyOn(fsPromises, "writeFile").mockImplementation(async (target, data, options) => {
        if (target !== preferencePath || typeof data !== "string") {
          return writeFile(target, data, options);
        }
        if (holdMarkerWrites) {
          markerWrites += 1;
          await releaseWrite.promise;
        }
        fileContent = data;
      }),
    ];
    try {
      await privateSession.persistStartupAutoRetryAbandon("authentication", "user-1");
      holdMarkerWrites = true;
      const clearing = privateSession.clearStartupAutoRetryAbandon();
      await unlinkEntered.promise;
      const recording = privateSession.persistStartupAutoRetryAbandon("aborted", "user-2");
      // A macrotask drains every microtask-resolved fake step the recording could have taken: the
      // marker write waits for the clear's unlink instead of racing it.
      await macrotask();
      expect(markerWrites).toBe(0);
      releaseUnlink.resolve();
      await clearing;

      // The clear's completion does not acknowledge the marker that is still being written.
      let acknowledged: boolean | undefined;
      const ack = session.recordPendingAutoRetryState().then((recorded) => {
        acknowledged = recorded;
        return recorded;
      });
      await macrotask();
      expect(acknowledged).toBeUndefined();
      releaseWrite.resolve();
      expect(await ack).toBe(true);
      await recording;
      expect(fileContent).not.toBeNull();
      const persisted = JSON.parse(fileContent!) as {
        startupAutoRetryAbandon?: { reason: string; userMessageId?: string };
      };
      expect(persisted.startupAutoRetryAbandon).toEqual({
        reason: "aborted",
        userMessageId: "user-2",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("a marker recorded while the preference file is still loading survives the load and keeps the file's opt-out", async () => {
    const workspaceId = "startup-retry-marker-during-preference-load";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      loadAutoRetryEnabledPreference: () => Promise<boolean>;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };
    const preferencePath = privateSession.getAutoRetryPreferencePath();
    await fsPromises.mkdir(path.dirname(preferencePath), { recursive: true });
    await fsPromises.writeFile(preferencePath, JSON.stringify({ enabled: false }) + "\n", "utf-8");

    // The first preference read is held open, as in a fresh session whose startup check is still
    // reading the file when a Stop withdraws an accepted wake.
    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const readFile = fsPromises.readFile.bind(fsPromises);
    const readSpy = spyOn(fsPromises, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readFile>
    ) => {
      const raw = await readFile(...args);
      if (args[0] !== preferencePath) return raw;
      readEntered.resolve();
      await releaseRead.promise;
      return raw;
    }) as typeof fsPromises.readFile);
    try {
      const loading = privateSession.loadAutoRetryEnabledPreference();
      await readEntered.promise;
      const recording = privateSession.persistStartupAutoRetryAbandon("aborted", "user-2");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Nothing is written from unloaded state while the read is pending.
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
      releaseRead.resolve();
      expect(await loading).toBe(false);
      await recording;

      expect(privateSession.startupAutoRetryAbandon).toEqual({
        reason: "aborted",
        userMessageId: "user-2",
      });
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({
        enabled: false,
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "user-2" },
      });
      expect(await session.recordPendingAutoRetryState()).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("provider config changes preserve non-fixable abandon state without starting a stream", async () => {
    const workspaceId = "startup-retry-keep-abandon-on-provider-config";
    const { session, aiService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };
    await privateSession.persistStartupAutoRetryAbandon("context_exceeded", "user-1");
    const preferencePath = privateSession.getAutoRetryPreferencePath();
    const streamMessageSpy = spyOn(aiService, "streamMessage");

    await session.handleProviderConfigChanged();

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "context_exceeded",
      userMessageId: "user-1",
    });
    expect(await Bun.file(preferencePath).exists()).toBe(true);
    expect(streamMessageSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
  });

  test("provider config sweep clears fixable markers for workspaces without live sessions", async () => {
    const workspaceId = "startup-retry-sweep-closed-workspace";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      getAutoRetryPreferencePath: () => string;
    };
    await privateSession.persistStartupAutoRetryAbandon("authentication", "user-1");
    const preferencePath = privateSession.getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    // Not in the skip set = no live session for this workspace.
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());

    expect(await Bun.file(preferencePath).exists()).toBe(false);
  });

  test("provider config sweep preserves non-fixable markers and skips live sessions", async () => {
    const workspaceId = "startup-retry-sweep-preserve";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      getAutoRetryPreferencePath: () => string;
    };
    const preferencePath = privateSession.getAutoRetryPreferencePath();

    await privateSession.persistStartupAutoRetryAbandon("context_exceeded", "user-1");
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    await privateSession.persistStartupAutoRetryAbandon("authentication", "user-1");
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set([workspaceId]));
    expect(await Bun.file(preferencePath).exists()).toBe(true);
  });

  test("an auto-retry opt-out whose write failed is not acknowledged as recorded until it is written", async () => {
    const workspaceId = "startup-retry-unrecorded-opt-out";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const preferencePath = (
      session as unknown as { getAutoRetryPreferencePath: () => string }
    ).getAutoRetryPreferencePath();

    let failWrites = true;
    const { writeFile } = fsPromises;
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(
      async (target, data, options) => {
        if (target === preferencePath && failWrites) throw new Error("EIO");
        return writeFile(target, data, options);
      }
    );
    try {
      // A RetryBarrier Stop with no active stream: the opt-out is the only state it relies on.
      await session.setAutoRetryEnabled(false);
      expect(await Bun.file(preferencePath).exists()).toBe(false);
      expect(await session.recordPendingAutoRetryState()).toBe(false);

      failWrites = false;
      expect(await session.recordPendingAutoRetryState()).toBe(true);
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("provider config sweep keeps a persisted auto-retry opt-out while clearing the marker", async () => {
    const workspaceId = "startup-retry-sweep-keep-opt-out";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistAutoRetryEnabledPreference: (enabled: boolean) => Promise<void>;
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      getAutoRetryPreferencePath: () => string;
    };
    await privateSession.persistAutoRetryEnabledPreference(false);
    await privateSession.persistStartupAutoRetryAbandon("quota", "user-1");
    const preferencePath = privateSession.getAutoRetryPreferencePath();

    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: boolean;
      startupAutoRetryAbandon?: unknown;
    };
    expect(persisted.enabled).toBe(false);
    expect(persisted.startupAutoRetryAbandon).toBeUndefined();
  });

  test("reschedules retry when resumeStream defers without starting a stream", async () => {
    const workspaceId = "startup-retry-resume-deferred";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: true as const,
        data: { started: false },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    await session.dispose();
  });

  test("does not re-process retry failures already handled by resumeStream", async () => {
    const workspaceId = "startup-retry-no-double-process-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as RetryableSessionForTests;

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
        failureHandled: true as const,
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore);

    await session.dispose();
  });

  test("handles unprocessed resume failures by scheduling the next retry", async () => {
    const workspaceId = "startup-retry-process-unhandled-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as RetryableSessionForTests;

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    await session.dispose();
  });

  test("retryActiveStream resumes the reconstructed follow-up after compaction handoff send fails", async () => {
    const workspaceId = "startup-retry-follow-up-handoff";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-follow-up", "assistant", "Compaction summary", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "resume the original work",
            model: "openai:gpt-4o",
            agentId: "exec",
            thinkingLevel: "high",
          },
        },
      })
    );
    expect(appendResult.success).toBe(true);

    const privateSession = session as unknown as {
      dispatchPendingFollowUp: () => Promise<boolean>;
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      sendMessage: (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean }
      ) => Promise<
        { success: true } | { success: false; error: { type: string; message?: string } }
      >;
      resumeStream: (
        options: SendMessageOptions,
        internal?: { agentInitiated?: boolean }
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "compact",
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      },
      agentInitiated: true,
    };
    privateSession.sendMessage = mock(() =>
      Promise.resolve({
        success: false as const,
        error: { type: "runtime_start_failed", message: "startup failed" },
      })
    );

    let dispatchError: unknown;
    try {
      await privateSession.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }
    expect(dispatchError).toBeInstanceOf(Error);
    expect((dispatchError as Error).message).toContain("Failed to dispatch pending follow-up");

    const resumeStreamMock = mock(
      (_options: SendMessageOptions, _internal?: { agentInitiated?: boolean }) =>
        Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    const firstCall = resumeStreamMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [optionsArg, internalArg] = firstCall as unknown as [
      SendMessageOptions,
      { agentInitiated?: boolean } | undefined,
    ];
    expect(optionsArg).toEqual(
      expect.objectContaining({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "high",
      }) as SendMessageOptions
    );
    expect(optionsArg.toolPolicy).toBeUndefined();
    expect(internalArg?.agentInitiated).toBeUndefined();

    await session.dispose();
  });

  test("same-session auto-retry preserves ACP correlation fields", async () => {
    const workspaceId = "startup-retry-preserves-acp-fields";
    const { session, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const acpPromptId = "acp-prompt-123";
    const delegatedToolNames = ["bash", "task"];
    const muxMetadata = {
      source: "acp",
      promptCorrelationId: "fallback-prompt-456",
      delegatedToolNames: ["bash"],
    };

    let streamCallCount = 0;
    const streamMessageMock = mock((_payload: Record<string, unknown>) => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        return Promise.resolve({
          success: false as const,
          error: {
            type: "runtime_start_failed" as const,
            message: "startup failed",
          },
        });
      }

      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    aiService.streamMessage =
      streamMessageMock as unknown as AgentSessionAIService["streamMessage"];

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
    };

    const sendResult = await session.sendMessage("Retry the ACP request", {
      model: "openai:gpt-4o",
      agentId: "exec",
      acpPromptId,
      delegatedToolNames,
      muxMetadata,
    });

    expect(sendResult.success).toBe(false);
    expect(privateSession.lastAutoRetryResumeRequest?.options.acpPromptId).toBe(acpPromptId);
    expect(privateSession.lastAutoRetryResumeRequest?.options.delegatedToolNames).toEqual(
      delegatedToolNames
    );
    expect(privateSession.lastAutoRetryResumeRequest?.options.muxMetadata).toEqual(muxMetadata);

    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(2);
    const retryPayload = streamMessageMock.mock.calls[1]?.[0] as {
      acpPromptId?: string;
      delegatedToolNames?: string[];
    };
    expect(retryPayload.acpPromptId).toBe(acpPromptId);
    expect(retryPayload.delegatedToolNames).toEqual(delegatedToolNames);

    await session.dispose();
  });

  test("compaction retry failure preserves the adjusted 1M-context retry request", async () => {
    const workspaceId = "startup-retry-compaction-adjusted-request";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "compact",
    };
    const retriedOptions: SendMessageOptions = {
      ...baseOptions,
      providerOptions: {
        anthropic: {
          use1MContext: true,
          use1MContextModels: [baseOptions.model],
        },
      },
    };

    const privateSession = session as unknown as {
      maybeRetryCompactionOnContextExceeded: (data: {
        messageId: string;
        errorType?: string;
      }) => Promise<boolean>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      activeCompactionRequest?: {
        id: string;
        modelString: string;
        options?: SendMessageOptions;
        source?: "idle-compaction" | "auto-compaction";
      };
      activeStreamContext?: {
        modelString: string;
        options?: SendMessageOptions;
        agentInitiated?: boolean;
        openaiTruncationModeOverride?: "auto" | "disabled";
        providersConfig: unknown;
      };
      supports1MContextRetry: (modelString: string) => boolean;
      is1MContextEnabledForModel: (
        modelString: string,
        options?: SendMessageOptions,
        providersConfig?: unknown
      ) => boolean;
      withAnthropic1MContext: (
        modelString: string,
        options?: SendMessageOptions
      ) => SendMessageOptions | null;
      finalizeCompactionRetry: (messageId: string) => Promise<void>;
      streamWithHistory: (
        modelString: string,
        options?: SendMessageOptions,
        openaiTruncationModeOverride?: "auto" | "disabled",
        disablePostCompactionAttachments?: boolean,
        agentInitiated?: boolean
      ) => Promise<
        | { success: true; data: undefined }
        | {
            success: false;
            error: { type: "runtime_start_failed"; message: string };
            failureHandled?: true;
          }
      >;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "openai:gpt-4o-mini",
        agentId: "compact",
      },
      agentInitiated: true,
    };
    privateSession.activeCompactionRequest = {
      id: "compaction-request-1",
      modelString: baseOptions.model,
      options: baseOptions,
      source: "auto-compaction",
    };
    privateSession.activeStreamContext = {
      modelString: baseOptions.model,
      options: baseOptions,
      agentInitiated: true,
      providersConfig: null,
    };
    privateSession.supports1MContextRetry = mock(() => true);
    privateSession.is1MContextEnabledForModel = mock(() => false);
    privateSession.withAnthropic1MContext = mock(() => retriedOptions);
    privateSession.finalizeCompactionRetry = mock(() => Promise.resolve());
    const streamWithHistoryMock = mock(() =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "retry startup failed",
        },
      })
    );
    privateSession.streamWithHistory = streamWithHistoryMock;

    const retried = await privateSession.maybeRetryCompactionOnContextExceeded({
      messageId: "assistant-retry-failure",
      errorType: "context_exceeded",
    });

    expect(retried).toBe(false);
    expect(streamWithHistoryMock).toHaveBeenCalledTimes(1);
    expect(privateSession.lastAutoRetryResumeRequest?.options.model).toBe(baseOptions.model);
    expect(privateSession.lastAutoRetryResumeRequest?.options.agentId).toBe("compact");
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.providerOptions?.anthropic?.use1MContext
    ).toBe(true);
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.providerOptions?.anthropic
        ?.use1MContextModels
    ).toEqual([baseOptions.model]);
    expect(privateSession.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);

    await session.dispose();
  });

  test("persists startup abandon marker for pre-stream user aborts", async () => {
    const workspaceId = "startup-retry-pre-stream-abort";
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceId,
      projectName: "project",
      projectPath: "/tmp/project",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      aiSettingsByAgent: {
        exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      },
    };

    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      getStreamInfo: mock(() => undefined),
      replayStream: mock(() => Promise.resolve()),
      streamMessage: mock(() =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
      ),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
    }) as unknown as AgentSessionAIService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const privateSession = session as unknown as {
      coordinator: TurnCoordinator;
      activeStreamUserMessageId?: string;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    privateSession.activeStreamUserMessageId = "user-1";
    privateSession.coordinator.prepare({
      kind: "fresh",
      intent: "handoff",
      expectedTurnId: privateSession.coordinator.turnId,
    });

    void runSessionTerminalPolicy(session, aiEmitter, {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "user",
      metadata: {},
    });

    const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (condition()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    const abandonPersisted = await waitUntil(() => privateSession.startupAutoRetryAbandon !== null);
    expect(abandonPersisted).toBe(true);

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    const preferencePath = privateSession.getAutoRetryPreferencePath();
    const waitForPreferenceFile = async (timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await Bun.file(preferencePath).exists()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    expect(await waitForPreferenceFile()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    await session.dispose();
  });

  test("skips persisting startup abandon marker for non-user abort reasons", async () => {
    const workspaceId = "startup-retry-system-abort-skip";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      updateStartupAutoRetryAbandonFromAbort: (
        abortReason: "user" | "startup" | "system" | undefined,
        userMessageId?: string
      ) => Promise<void>;
    };

    const preferencePath = privateSession.getAutoRetryPreferencePath();

    await privateSession.updateStartupAutoRetryAbandonFromAbort("system", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    await privateSession.updateStartupAutoRetryAbandonFromAbort("user", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });
    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    await session.dispose();
  });

  test("does not schedule startup auto-retry while ask_user_question is waiting", async () => {
    const workspaceId = "startup-retry-ask-user";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const writePartialResult = await historyService.writePartial(
      workspaceId,
      createMuxMessage(
        "assistant-1",
        "assistant",
        "",
        {
          timestamp: Date.now(),
          model: "anthropic:claude-sonnet-4-5",
          partial: true,
          agentId: "exec",
        },
        [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: { question: "Name?" },
          },
        ]
      )
    );
    expect(writePartialResult.success).toBe(true);
    expect(await session.isStartupRecoveryBlocked()).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await session.dispose();
  });
});
