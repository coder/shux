import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  parseRuntimeString,
  prepareCompactionMessage,
  WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE,
  processSlashCommand,
  type CommandAction,
  type CommandInputDisposition,
  type CommandResult,
  type SlashCommandEnv,
} from "./chatCommands";
import { parseCommand } from "./slashCommands/parser";
import type { ReviewNoteData } from "@/common/types/review";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";

// Simple mock for localStorage to satisfy resolveCompactionModel and experiment gating.
// Note: command helpers read from window.localStorage, so we set both globalThis.localStorage
// and window.localStorage for test isolation.
beforeEach(() => {
  // Ensure `window` exists for browser-environment functions like isExperimentEnabled.
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  }

  const storageData = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageData.set(key, value);
    },
    removeItem: (key: string) => {
      storageData.delete(key);
    },
    clear: () => {
      storageData.clear();
    },
    key: (index: number) => Array.from(storageData.keys())[index] ?? null,
    get length() {
      return storageData.size;
    },
  } as unknown as Storage;

  globalThis.localStorage = storage;

  if (typeof window !== "undefined") {
    try {
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    } catch {
      // Some test DOM environments expose localStorage as a readonly getter.
      (window as unknown as { localStorage?: Storage }).localStorage = storage;
    }
  }
});

describe("parseRuntimeString", () => {
  test.each([undefined, "worktree", "WORKTREE", " worktree "])(
    "returns undefined for default/worktree runtime %#",
    (runtime) => {
      expect(parseRuntimeString(runtime)).toBeUndefined();
    }
  );

  test.each(["local", "LOCAL", " local "])("returns local config for %p", (runtime) => {
    // "local" now returns project-dir runtime config (no srcBaseDir)
    expect(parseRuntimeString(runtime)).toEqual({ type: "local" });
  });

  test.each([
    ["ssh user@host", { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }],
    [
      "ssh User@Host.Example.Com",
      { type: "ssh", host: "User@Host.Example.Com", srcBaseDir: "~/mux" },
    ],
    ["  ssh   user@host  ", { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }],
    ["ssh hostname", { type: "ssh", host: "hostname", srcBaseDir: "~/mux" }],
    ["ssh dev.example.com", { type: "ssh", host: "dev.example.com", srcBaseDir: "~/mux" }],
    ["ssh root@hostname", { type: "ssh", host: "root@hostname", srcBaseDir: "~/mux" }],
    ["docker ubuntu:22.04", { type: "docker", image: "ubuntu:22.04" }],
    ["docker ghcr.io/myorg/dev:latest", { type: "docker", image: "ghcr.io/myorg/dev:latest" }],
    [
      "devcontainer .devcontainer/devcontainer.json",
      { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    ],
  ] as const)("parses %p", (runtime, expected) => {
    expect(parseRuntimeString(runtime)).toEqual(expected);
  });

  test.each([
    ["ssh", "SSH runtime requires host"],
    ["ssh ", "SSH runtime requires host"],
    ["devcontainer", "Dev container runtime requires a config path"],
    ["docker", "Docker runtime requires image"],
    ["docker ", "Docker runtime requires image"],
    [
      "remote",
      "Unknown runtime type: 'remote'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'",
    ],
    [
      "kubernetes",
      "Unknown runtime type: 'kubernetes'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'",
    ],
  ])("throws for invalid runtime %p", (runtime, message) => {
    expect(() => parseRuntimeString(runtime)).toThrow(message);
  });
});

function ensureWindowDispatchEvent(): void {
  Object.defineProperty(window, "dispatchEvent", { value: mock(() => true), configurable: true });
}

const sendMessageOptions: SendMessageOptions = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "off",
  toolPolicy: [],
  agentId: "exec",
};

function createEnv(overrides: Partial<SlashCommandEnv> = {}): SlashCommandEnv {
  return {
    api: null,
    workspaceId: "test-ws",
    variant: "workspace",
    projectPath: "/tmp/project",
    sendMessageOptions,
    ...overrides,
  };
}

type CompleteCommandResult = Extract<CommandResult, { kind: "complete" }>;

async function finishCommand(result: CommandResult): Promise<{
  batches: CommandAction[][];
  result: CompleteCommandResult;
}> {
  const batches: CommandAction[][] = [];
  while (result.kind === "phase") {
    batches.push(result.actions);
    result = await result.continue();
  }
  batches.push(result.actions);
  return { batches, result };
}

function expectDisposition(result: CompleteCommandResult, expected: CommandInputDisposition): void {
  expect(result.inputDisposition).toBe(expected);
}

function expectToast(
  actions: CommandAction[],
  expected: { type: "success" | "error"; message: string; title?: string }
): void {
  const action = actions.find(
    (candidate): candidate is Extract<CommandAction, { type: "show-toast" }> =>
      candidate.type === "show-toast"
  );
  expect(action?.toast.type).toBe(expected.type);
  expect(action?.toast.message).toBe(expected.message);
  if (expected.title) expect(action?.toast.title).toBe(expected.title);
}

function setHeartbeatExperiment(enabled: boolean): void {
  localStorage.setItem(
    getExperimentKey(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS),
    JSON.stringify(enabled)
  );
}

const completedWorkflowRun = {
  id: "wfr_123",
  workspaceId: "test-ws",
  workflow: {
    name: "skill://deep-research/workflow.js",
    description: "Deep research",
    scope: "built-in",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:test",
  args: { input: "mux" },
  status: "completed" as const,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:01.000Z",
  events: [],
  steps: [],
};

describe("processSlashCommand workflow results", () => {
  test("returns validation failures without starting a workflow", async () => {
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "running", result: null })
    );
    const disabled = await processSlashCommand(
      { type: "workflow-run", scriptPath: "skill://deep-research/workflow.js", argsText: "{}" },
      createEnv({
        api: { workflows: { start } } as unknown as SlashCommandEnv["api"],
        dynamicWorkflowsEnabled: false,
      })
    );
    expect(disabled.kind).toBe("complete");
    if (disabled.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(disabled, "restore");
    expectToast(disabled.actions, { type: "error", message: "Dynamic workflows are disabled" });
    expect(start).not.toHaveBeenCalled();

    const invalidArgs = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: "freeform arguments",
      },
      createEnv({
        api: { workflows: { start } } as unknown as SlashCommandEnv["api"],
        dynamicWorkflowsEnabled: true,
      })
    );
    expect(invalidArgs.kind).toBe("complete");
    if (invalidArgs.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(invalidArgs, "restore");
    expectToast(invalidArgs.actions, {
      type: "error",
      message: WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE,
    });
    expect(start).not.toHaveBeenCalled();
  });

  test("keeps each workflow await behind a lazy phase", async () => {
    const workflowResult = {
      reportMarkdown: "# Research\n\nFindings",
      structuredOutput: { confidence: "high" },
    };
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "completed" as const, result: workflowResult })
    );
    const getRun = mock(() => Promise.resolve(completedWorkflowRun));
    const sentMessages: Array<{ message: string; options: { muxMetadata?: { type?: string } } }> =
      [];
    const sendMessage = mock((input: (typeof sentMessages)[number]) => {
      sentMessages.push(input);
      return Promise.resolve({ success: true });
    });
    const initial = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      createEnv({
        api: {
          workflows: { start, getRun },
          workspace: { sendMessage },
        } as unknown as SlashCommandEnv["api"],
        rawInput: '/deep-research {"input":"mux"}',
        dynamicWorkflowsEnabled: true,
      })
    );
    expect(initial.kind).toBe("phase");
    if (initial.kind !== "phase") throw new Error("expected phase result");
    expect(initial.actions).toEqual([
      { type: "clear-input" },
      { type: "set-sending", sending: true },
    ]);
    expect(start).not.toHaveBeenCalled();

    const afterStart = await initial.continue();
    expect(afterStart.kind).toBe("phase");
    if (afterStart.kind !== "phase") throw new Error("expected phase result");
    expect(afterStart.actions).toEqual([{ type: "set-sending", sending: false }]);
    expect(getRun).not.toHaveBeenCalled();

    const afterPoll = await afterStart.continue();
    expect(afterPoll.kind).toBe("phase");
    if (afterPoll.kind !== "phase") throw new Error("expected phase result");
    expect(afterPoll.actions).toEqual([{ type: "set-sending", sending: true }]);
    expect(sendMessage).not.toHaveBeenCalled();

    const complete = await afterPoll.continue();
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(complete, "consume");
    expect(complete.actions.slice(0, 2)).toEqual([
      { type: "set-sending", sending: false },
      { type: "message-sent", dispatchMode: "tool-end" },
    ]);
    expect(complete.actions[2]).toMatchObject({ type: "show-toast", toast: { type: "success" } });
    expect(sentMessages[0]?.message).toContain("<mux_workflow_result>");
    expect(sentMessages[0]?.message).toContain("Findings");
    expect(sentMessages[0]?.options.muxMetadata?.type).toBe("workflow-result");
  });

  test("completes after start when the invocation message is already persisted", async () => {
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_123",
        status: "running" as const,
        result: null,
        invocationMessagePersisted: true,
      })
    );
    const initial = await processSlashCommand(
      { type: "workflow-run", scriptPath: "skill://flow/workflow.js", argsText: "{}" },
      createEnv({
        api: { workflows: { start } } as unknown as SlashCommandEnv["api"],
        dynamicWorkflowsEnabled: true,
      })
    );
    const settled = await finishCommand(initial);
    expectDisposition(settled.result, "consume");
    expect(settled.batches).toHaveLength(2);
    expectToast(settled.result.actions, {
      type: "success",
      message: "Workflow skill://flow/workflow.js started",
    });
  });

  test("returns consume without continuation actions when polling is superseded", async () => {
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "completed" as const, result: null })
    );
    const getRun = mock(() => Promise.resolve(completedWorkflowRun));
    const initial = await processSlashCommand(
      { type: "workflow-run", scriptPath: "skill://flow/workflow.js", argsText: "{}" },
      createEnv({
        api: {
          workflows: { start, getRun },
          workspace: { sendMessage: mock(() => Promise.resolve({ success: true })) },
        } as unknown as SlashCommandEnv["api"],
        dynamicWorkflowsEnabled: true,
        isCurrent: () => false,
      })
    );
    const settled = await finishCommand(initial);
    expectDisposition(settled.result, "consume");
    expect(settled.result.actions).toEqual([]);
  });

  test("uses restore-if-empty for workflow failures", async () => {
    const initial = await processSlashCommand(
      { type: "workflow-run", scriptPath: "skill://flow/workflow.js", argsText: "{}" },
      createEnv({
        api: {
          workflows: { start: mock(() => Promise.reject(new Error("workflow failed"))) },
        } as unknown as SlashCommandEnv["api"],
        dynamicWorkflowsEnabled: true,
      })
    );
    const settled = await finishCommand(initial);
    expectDisposition(settled.result, "restore-if-empty");
    expectToast(settled.result.actions, { type: "error", message: "workflow failed" });
    expect(settled.result.actions[0]).toEqual({ type: "set-sending", sending: false });
  });

  test("does not send an interrupted workflow result to the agent", async () => {
    const sendMessage = mock(() => Promise.resolve({ success: true }));
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "interrupted" as const, result: null })
    );
    const getRun = mock(() =>
      Promise.resolve({ ...completedWorkflowRun, status: "interrupted" as const })
    );
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "workflow-run", scriptPath: "skill://flow/workflow.js", argsText: "{}" },
        createEnv({
          api: {
            workflows: { start, getRun },
            workspace: { sendMessage },
          } as unknown as SlashCommandEnv["api"],
          dynamicWorkflowsEnabled: true,
        })
      )
    );
    expectDisposition(settled.result, "consume");
    expectToast(settled.result.actions, {
      type: "success",
      message: "Workflow skill://flow/workflow.js interrupted",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("processSlashCommand clear results", () => {
  test("hard clear returns actions around truncation", async () => {
    const truncateHistory = mock(() => Promise.resolve());
    const initial = await processSlashCommand(
      { type: "clear", mode: "hard" },
      createEnv({ truncateHistory })
    );
    expect(initial.kind).toBe("phase");
    if (initial.kind !== "phase") throw new Error("expected phase result");
    expect(initial.actions).toEqual([{ type: "clear-input" }, { type: "reset-input-height" }]);
    expect(truncateHistory).not.toHaveBeenCalled();
    const complete = await initial.continue();
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(complete, "consume");
    expect(complete.actions.slice(0, 2)).toEqual([
      { type: "clear-attachments" },
      { type: "detach-reviews" },
    ]);
    expect(truncateHistory).toHaveBeenCalledWith(1);
  });

  test("soft clear preserves attachments for no-op and restores on failure", async () => {
    const noOp = await finishCommand(
      await processSlashCommand(
        { type: "clear", mode: "soft" },
        createEnv({ resetContext: () => Promise.resolve("noop") })
      )
    );
    expectDisposition(noOp.result, "consume");
    expect(noOp.result.actions).not.toContainEqual({ type: "clear-attachments" });
    expectToast(noOp.result.actions, {
      type: "success",
      message: "No context to reset",
    });

    const failure = await finishCommand(
      await processSlashCommand(
        { type: "clear", mode: "soft" },
        createEnv({
          resetContext: () => Promise.reject(new Error("reset failed")),
        })
      )
    );
    expectDisposition(failure.result, "restore");
    expectToast(failure.result.actions, { type: "error", message: "reset failed" });
  });

  test("missing clear capabilities consume without a toast", async () => {
    const soft = await processSlashCommand({ type: "clear", mode: "soft" }, createEnv());
    expect(soft).toEqual({ kind: "complete", actions: [], inputDisposition: "consume" });
    const hard = await finishCommand(
      await processSlashCommand({ type: "clear", mode: "hard" }, createEnv())
    );
    expectDisposition(hard.result, "consume");
    expect(hard.result.actions).toEqual([]);
  });
});

describe("processSlashCommand model and gating results", () => {
  test("reports provider verification failure through result data", async () => {
    const result = await processSlashCommand(
      { type: "model-set", modelString: "custom:model" },
      createEnv({
        api: {
          providers: { getConfig: mock(() => Promise.reject(new Error("offline"))) },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(result, "restore");
    expectToast(result.actions, {
      type: "error",
      message: 'Could not verify provider "custom": backend unreachable. Please retry.',
    });
  });

  test("refuses an unpriced model for a budgeted active goal", async () => {
    const result = await processSlashCommand(
      { type: "model-set", modelString: "openai:unpriced-model" },
      createEnv({
        api: {
          providers: { getConfig: mock(() => Promise.resolve({ openai: { models: [] } })) },
          workspace: {
            getGoal: mock(() =>
              Promise.resolve({
                goal: { objective: "ship", status: "active", budgetCents: 500 },
              })
            ),
          },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(result, "restore");
    expect(result.actions[0]).toMatchObject({ type: "show-toast", toast: { type: "error" } });
  });

  test("returns model and vim actions", async () => {
    const model = await processSlashCommand(
      { type: "model-set", modelString: "anthropic:claude-sonnet-4-6" },
      createEnv({
        api: {
          providers: {
            getConfig: mock(() => Promise.resolve({})),
            setModels: mock(() => Promise.resolve()),
          },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    expect(model.kind).toBe("complete");
    if (model.kind !== "complete") throw new Error("expected complete result");
    expect(model.actions).toContainEqual({
      type: "set-preferred-model",
      model: "anthropic:claude-sonnet-4-6",
    });
    const vim = await processSlashCommand({ type: "vim-toggle" }, createEnv());
    expect(vim).toEqual({
      kind: "complete",
      actions: [{ type: "clear-input" }, { type: "toggle-vim" }],
      inputDisposition: "consume",
    });
  });

  test("returns goal parse errors during creation", async () => {
    const result = await processSlashCommand(
      { type: "command-missing-args", command: "goal", usage: "/goal <objective>" },
      createEnv({ variant: "creation", workspaceId: undefined })
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(result, "restore");
    expectToast(result.actions, {
      type: "error",
      message: "/goal requires arguments",
    });
  });

  test("returns require-client and workspace-creation guard results", async () => {
    const disconnected = await processSlashCommand(
      { type: "idle-compaction", hours: 2 },
      createEnv({ api: null })
    );
    if (disconnected.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(disconnected, "restore");
    expectToast(disconnected.actions, { type: "error", message: "Not connected to server" });

    const guarded = await processSlashCommand(
      { type: "clear", mode: "soft" },
      createEnv({ variant: "creation", workspaceId: undefined })
    );
    if (guarded.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(guarded, "restore");
    expectToast(guarded.actions, {
      type: "error",
      message: "Command not available during workspace creation",
    });
  });

  test("returns idle-compaction and debug actions", async () => {
    const setIdleCompaction = mock(() => Promise.resolve({ success: true, data: undefined }));
    const idle = await processSlashCommand(
      { type: "idle-compaction", hours: 2 },
      createEnv({
        api: {
          projects: { idleCompaction: { set: setIdleCompaction } },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    if (idle.kind !== "phase") throw new Error("expected phase result");
    expect(idle.actions).toEqual([{ type: "clear-input" }]);
    expect(setIdleCompaction).not.toHaveBeenCalled();
    const idleComplete = await idle.continue();
    if (idleComplete.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(idleComplete, "consume");
    expectToast(idleComplete.actions, {
      type: "success",
      message: "Idle compaction set to 2 hours",
    });

    ensureWindowDispatchEvent();
    const debug = await processSlashCommand({ type: "debug-llm-request" }, createEnv());
    expect(debug).toEqual({
      kind: "complete",
      actions: [{ type: "clear-input" }],
      inputDisposition: "consume",
    });
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mux:openDebugLlmRequest" })
    );
  });
});

function createGoalEnv(api: SlashCommandEnv["api"]): SlashCommandEnv {
  return createEnv({ api, workspaceId: "goal-ws" });
}

describe("processSlashCommand goal results", () => {
  test("retries one conflict and returns a consumed result", async () => {
    ensureWindowDispatchEvent();
    const getGoal = mock()
      .mockResolvedValueOnce({
        goal: { goalId: "11111111-1111-4111-8111-111111111111", objective: "old" },
      })
      .mockResolvedValueOnce({
        goal: { goalId: "22222222-2222-4222-8222-222222222222", objective: "fresh" },
      });
    const setGoal = mock()
      .mockResolvedValueOnce({
        success: false,
        error: {
          type: "goal_conflict",
          expectedGoalId: "11111111-1111-4111-8111-111111111111",
          actualGoalId: "22222222-2222-4222-8222-222222222222",
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { goalId: "33333333-3333-4333-8333-333333333333", objective: "new" },
      });
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "goal-set", objective: "new" },
        createGoalEnv({
          config: { getConfig: mock(() => Promise.resolve({})) },
          workspace: { getGoal, setGoal },
        } as unknown as SlashCommandEnv["api"])
      )
    );
    expect(settled.batches[0]).toEqual([{ type: "clear-input" }]);
    expectDisposition(settled.result, "consume");
    expect(settled.result.actions).toEqual([]);
    expect(setGoal).toHaveBeenCalledTimes(2);
  });

  test("surfaces a second conflict as a restore result", async () => {
    const conflict = {
      success: false as const,
      error: {
        type: "goal_conflict" as const,
        expectedGoalId: "11111111-1111-4111-8111-111111111111",
        actualGoalId: "22222222-2222-4222-8222-222222222222",
      },
    };
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "goal-pause" },
        createGoalEnv({
          workspace: {
            getGoal: mock(() =>
              Promise.resolve({
                goal: { goalId: "11111111-1111-4111-8111-111111111111" },
              })
            ),
            setGoal: mock(() => Promise.resolve(conflict)),
          },
        } as unknown as SlashCommandEnv["api"])
      )
    );
    expectDisposition(settled.result, "restore");
    expectToast(settled.result.actions, {
      type: "error",
      message: "Goal changed in another window. Please try again.",
    });
  });

  test("passes configured defaults and multiline objectives to the backend", async () => {
    ensureWindowDispatchEvent();
    const objective = "Implement PRD\n\nRead first:\n- CONTEXT.md\n- PRD.md";
    const parsed = parseCommand("/goal " + objective);
    if (parsed?.type !== "goal-set") throw new Error("expected goal-set");
    const setGoal = mock(() =>
      Promise.resolve({
        success: true,
        data: { goalId: "33333333-3333-4333-8333-333333333333", objective },
      })
    );
    const settled = await finishCommand(
      await processSlashCommand(
        parsed,
        createGoalEnv({
          config: {
            getConfig: mock(() =>
              Promise.resolve({
                goalDefaults: {
                  defaultBudgetCents: 350,
                  defaultTurnCap: 25,
                  alwaysRequireExplicitBudget: true,
                },
              })
            ),
          },
          workspace: {
            getGoal: mock(() => Promise.resolve({ goal: null })),
            setGoal,
          },
        } as unknown as SlashCommandEnv["api"])
      )
    );
    expectDisposition(settled.result, "consume");
    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      objective,
      expectedGoalId: null,
      budgetCents: 350,
      turnCap: 25,
    });
  });

  test("returns lifecycle success and pricing failure actions", async () => {
    const paused = await finishCommand(
      await processSlashCommand(
        { type: "goal-pause" },
        createGoalEnv({
          workspace: {
            getGoal: mock(() => Promise.resolve({ goal: null })),
            setGoal: mock(() =>
              Promise.resolve({ success: true, data: { goalId: "id", status: "paused" } })
            ),
          },
        } as unknown as SlashCommandEnv["api"])
      )
    );
    expectDisposition(paused.result, "consume");
    expectToast(paused.result.actions, { type: "success", message: "Goal paused" });

    const resume = await finishCommand(
      await processSlashCommand(
        { type: "goal-resume" },
        createGoalEnv({
          providers: { getConfig: mock(() => Promise.resolve({})) },
          workspace: {
            getGoal: mock(() => Promise.resolve({ goal: { status: "paused", budgetCents: 500 } })),
          },
        } as unknown as SlashCommandEnv["api"])
      )
    );
    expectDisposition(resume.result, "restore");
    expect(resume.result.actions[0]).toMatchObject({
      type: "show-toast",
      toast: { type: "error" },
    });
  });
});

describe("processSlashCommand heartbeat results", () => {
  test("returns gating errors before a phase", async () => {
    const api = {
      workspace: { heartbeat: { get: mock(), set: mock() } },
    } as unknown as SlashCommandEnv["api"];
    const disabled = await processSlashCommand(
      { type: "heartbeat-set", minutes: 30 },
      createEnv({ api })
    );
    expect(disabled.kind).toBe("complete");
    if (disabled.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(disabled, "restore");
    expect(disabled.actions[0]).toMatchObject({ type: "show-toast", toast: { type: "error" } });

    setHeartbeatExperiment(true);
    const missing = await processSlashCommand(
      { type: "heartbeat-set", minutes: 30 },
      createEnv({ api, workspaceId: undefined })
    );
    expect(missing.kind).toBe("complete");
    if (missing.kind !== "complete") throw new Error("expected complete result");
    expectToast(missing.actions, { type: "error", message: "No workspace selected" });
  });

  test("preserves saved heartbeat fields and returns success", async () => {
    setHeartbeatExperiment(true);
    const heartbeatGet = mock(() =>
      Promise.resolve({
        enabled: true as const,
        intervalMs: 45 * 60 * 1000,
        message: "Review the workspace status before taking action.",
      })
    );
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const initial = await processSlashCommand(
      { type: "heartbeat-set", minutes: 30 },
      createEnv({
        api: {
          workspace: { heartbeat: { get: heartbeatGet, set: heartbeatSet } },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    expect(initial.kind).toBe("phase");
    if (initial.kind !== "phase") throw new Error("expected phase result");
    expect(initial.actions).toEqual([{ type: "clear-input" }]);
    const complete = await initial.continue();
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(complete, "consume");
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      message: "Review the workspace status before taking action.",
    });
    expectToast(complete.actions, {
      type: "success",
      message: "Heartbeat set to every 30 minutes",
    });
  });

  test("uses the default interval when disabling without saved settings", async () => {
    setHeartbeatExperiment(true);
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "heartbeat-set", minutes: null },
        createEnv({
          api: {
            workspace: {
              heartbeat: {
                get: mock(() => Promise.reject(new Error("missing"))),
                set: heartbeatSet,
              },
            },
          } as unknown as SlashCommandEnv["api"],
        })
      )
    );
    expectDisposition(settled.result, "consume");
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: false,
      intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
    });
  });

  test("returns backend update failures with restore disposition", async () => {
    setHeartbeatExperiment(true);
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "heartbeat-set", minutes: 30 },
        createEnv({
          api: {
            workspace: {
              heartbeat: {
                get: mock(() => Promise.resolve({ enabled: false, intervalMs: 1 })),
                set: mock(() =>
                  Promise.resolve({ success: false, error: "Heartbeat update failed" })
                ),
              },
            },
          } as unknown as SlashCommandEnv["api"],
        })
      )
    );
    expectDisposition(settled.result, "restore");
    expectToast(settled.result.actions, {
      type: "error",
      message: "Heartbeat update failed",
    });
  });
});

describe("detached command work", () => {
  test("dream returns immediately and maps success and rejection to settle actions", async () => {
    const consolidate = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { ops: [{ applied: true }, { applied: false }] },
      })
    );
    const result = await processSlashCommand(
      { type: "dream" },
      createEnv({
        api: { memory: { consolidate } } as unknown as SlashCommandEnv["api"],
      })
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(result, "consume");
    expect(result.actions).toEqual([{ type: "clear-input" }]);
    expect(consolidate).not.toHaveBeenCalled();
    const successActions = await result.backgroundTask?.();
    expect(successActions).toBeDefined();
    expectToast(successActions ?? [], {
      type: "success",
      message: "Memory consolidated: 1 change(s)",
    });

    const failed = await processSlashCommand(
      { type: "dream" },
      createEnv({
        api: {
          memory: {
            consolidate: mock(() =>
              Promise.resolve({ success: false as const, error: "backend refused" })
            ),
          },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    if (failed.kind !== "complete") throw new Error("expected complete result");
    const failedActions = await failed.backgroundTask?.();
    expectToast(failedActions ?? [], {
      type: "error",
      message: "Memory consolidation failed: backend refused",
    });

    const rejected = await processSlashCommand(
      { type: "dream" },
      createEnv({
        api: {
          memory: { consolidate: mock(() => Promise.reject(new Error("offline"))) },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    if (rejected.kind !== "complete") throw new Error("expected complete result");
    const rejectedActions = await rejected.backgroundTask?.();
    expectToast(rejectedActions ?? [], {
      type: "error",
      message: "Memory consolidation failed: Error: offline",
    });
  });

  test("refine returns immediate validation or detached settle actions", async () => {
    const missingProposal = await processSlashCommand(
      { type: "refine", apply: true },
      createEnv({
        api: { refinements: {} } as unknown as SlashCommandEnv["api"],
      })
    );
    if (missingProposal.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(missingProposal, "consume");
    expect(missingProposal.backgroundTask).toBeUndefined();
    expect(missingProposal.actions[0]).toEqual({ type: "clear-input" });
    expect(missingProposal.actions[1]).toMatchObject({
      type: "show-toast",
      toast: { type: "error" },
    });

    const run = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { applied: [], staged: [{ path: "src/a.ts" }], failed: [], noOp: false },
      })
    );
    const result = await processSlashCommand(
      { type: "refine", apply: false },
      createEnv({
        api: { refinements: { run } } as unknown as SlashCommandEnv["api"],
      })
    );
    if (result.kind !== "complete") throw new Error("expected complete result");
    expect(run).not.toHaveBeenCalled();
    const actions = await result.backgroundTask?.();
    expectToast(actions ?? [], {
      type: "success",
      message: "Refine: 1 edit(s) staged — approve with /refine apply",
    });

    const failed = await processSlashCommand(
      { type: "refine", apply: false },
      createEnv({
        api: {
          refinements: {
            run: mock(() => Promise.resolve({ success: false as const, error: "backend refused" })),
          },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    if (failed.kind !== "complete") throw new Error("expected complete result");
    expectToast((await failed.backgroundTask?.()) ?? [], {
      type: "error",
      message: "Refine failed: backend refused",
    });

    const rejected = await processSlashCommand(
      { type: "refine", apply: false },
      createEnv({
        api: {
          refinements: { run: mock(() => Promise.reject(new Error("offline"))) },
        } as unknown as SlashCommandEnv["api"],
      })
    );
    if (rejected.kind !== "complete") throw new Error("expected complete result");
    expectToast((await rejected.backgroundTask?.()) ?? [], {
      type: "error",
      message: "Refine failed: Error: offline",
    });
  });
});

describe("compact and plan command results", () => {
  test("compact returns phased composer actions and terminal review actions", async () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10-15",
        selectedCode: "const x = 1;",
        userNote: "Please fix this bug",
      },
    ];
    const sentMessages: Array<{
      options?: { muxMetadata?: { parsed?: { followUpContent?: { reviews?: ReviewNoteData[] } } } };
    }> = [];
    const sendMessage = mock((input: (typeof sentMessages)[number]) => {
      sentMessages.push(input);
      return Promise.resolve({ success: true });
    });
    const initial = await processSlashCommand(
      { type: "compact" },
      createEnv({
        api: { workspace: { sendMessage } } as unknown as SlashCommandEnv["api"],
        reviews,
        editMessageId: "edit-id",
        attachedReviewIds: ["review-1"],
        sendMessageOptions: { ...sendMessageOptions, queueDispatchMode: "turn-end" },
      })
    );
    expect(initial.kind).toBe("phase");
    if (initial.kind !== "phase") throw new Error("expected phase result");
    expect(initial.actions).toEqual([
      { type: "clear-input" },
      { type: "clear-attachments" },
      { type: "set-sending", sending: true },
    ]);
    const complete = await initial.continue();
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(complete, "consume");
    expect(complete.actions).toContainEqual({ type: "cancel-edit" });
    expect(complete.actions).toContainEqual({ type: "check-reviews", reviewIds: ["review-1"] });
    expect(complete.actions).toContainEqual({ type: "message-sent", dispatchMode: "turn-end" });
    expect(sentMessages[0]?.options?.muxMetadata?.parsed?.followUpContent?.reviews).toEqual(
      reviews
    );
  });

  test("compact validation errors restore without starting a phase", async () => {
    const result = await processSlashCommand(
      { type: "compact", model: "invalid" },
      createEnv({ api: {} as unknown as SlashCommandEnv["api"] })
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete result");
    expectDisposition(result, "restore");
    expect(result.actions[0]).toMatchObject({ type: "show-toast", toast: { type: "error" } });
  });

  test("plan show replaces its singleton preview", async () => {
    const workspaceId = "test-workspace-id";
    const store = useWorkspaceStoreRaw();
    store.dispose();
    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "test-workspace",
      title: "Test Workspace",
      projectName: "Project",
      projectPath: "/tmp/project",
      namedWorkspacePath: "/tmp/project/test-workspace",
      runtimeConfig: { type: "local" },
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    workspaceStore.addWorkspace(metadata);
    try {
      for (const content of ["# First plan", "# Updated plan"]) {
        const settled = await finishCommand(
          await processSlashCommand(
            { type: "plan-show" },
            createEnv({
              workspaceId,
              api: {
                workspace: {
                  getPlanContent: mock(() =>
                    Promise.resolve({
                      success: true,
                      data: { content, path: "/path/to/plan.md" },
                    })
                  ),
                },
              } as unknown as SlashCommandEnv["api"],
            })
          )
        );
        expectDisposition(settled.result, "consume");
      }
      const previews = store
        .getWorkspaceState(workspaceId)
        .messages.filter((message) => message.type === "plan-display");
      expect(previews).toHaveLength(1);
      expect(previews[0]).toMatchObject({ content: "# Updated plan" });
    } finally {
      store.dispose();
    }
  });

  test("plan show missing result consumes with an error toast", async () => {
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "plan-show" },
        createEnv({
          api: {
            workspace: {
              getPlanContent: mock(() =>
                Promise.resolve({ success: false, error: "No plan found" })
              ),
            },
          } as unknown as SlashCommandEnv["api"],
        })
      )
    );
    expectDisposition(settled.result, "consume");
    expectToast(settled.result.actions, {
      type: "error",
      message: "No plan found for this workspace",
    });
  });

  test("plan open with no plan consumes with an error toast and skips the editor", async () => {
    const getInfo = mock(() => Promise.resolve(null));
    const settled = await finishCommand(
      await processSlashCommand(
        { type: "plan-open" },
        createEnv({
          api: {
            workspace: {
              getPlanContent: mock(() =>
                Promise.resolve({ success: false, error: "No plan found" })
              ),
              getInfo,
            },
          } as unknown as SlashCommandEnv["api"],
        })
      )
    );
    expectDisposition(settled.result, "consume");
    expectToast(settled.result.actions, {
      type: "error",
      message: "No plan found for this workspace",
    });
    expect(getInfo).not.toHaveBeenCalled();
  });

  test("plan open surfaces an editor-open failure as an error toast", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({ success: true, data: { content: "# My Plan", path: "/path/to/plan.md" } })
    );
    const getInfo = mock(() =>
      Promise.resolve({ runtimeConfig: { type: "local" } } as unknown as FrontendWorkspaceMetadata)
    );
    // openInEditor opens a blank placeholder window before its awaits; give it a
    // live stub so the flow reaches the recordEditorOpen admission check, whose
    // refusal is the deterministic failure path independent of deep-link launch.
    const windowWithOpen = window as unknown as { open?: (...args: unknown[]) => unknown };
    const previousOpen = windowWithOpen.open;
    windowWithOpen.open = () => ({
      closed: false,
      close: () => undefined,
      location: { href: "" },
    });
    // This suite aliases window to globalThis, which turns the tests/setup.ts
    // location getter (window.location fallback) into infinite recursion when
    // deep-link code reads location. Pin an own-value location for this test.
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "http://localhost/", hostname: "localhost" },
    });
    try {
      const settled = await finishCommand(
        await processSlashCommand(
          { type: "plan-open" },
          createEnv({
            api: {
              workspace: { getPlanContent, getInfo },
              general: {
                recordEditorOpen: mock(() =>
                  Promise.resolve({ success: false, error: "Archive in progress" })
                ),
              },
            } as unknown as SlashCommandEnv["api"],
          })
        )
      );
      expectDisposition(settled.result, "consume");
      expectToast(settled.result.actions, { type: "error", message: "Archive in progress" });
      expect(getPlanContent).toHaveBeenCalledWith({ workspaceId: "test-ws" });
      expect(getInfo).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    } finally {
      windowWithOpen.open = previousOpen;
      if (previousLocation) {
        Object.defineProperty(globalThis, "location", previousLocation);
      }
    }
  });
});

describe("prepareCompactionMessage", () => {
  const createBaseOptions = (): SendMessageOptions => ({
    model: "anthropic:claude-sonnet-4-6",
    thinkingLevel: "medium",
    toolPolicy: [],
    agentId: "exec",
  });

  function expectCompactionMetadata(
    metadata: ReturnType<typeof prepareCompactionMessage>["metadata"]
  ): asserts metadata is Extract<
    ReturnType<typeof prepareCompactionMessage>["metadata"],
    { type: "compaction-request" }
  > {
    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }
  }

  test("builds followUpContent from input", () => {
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      followUpContent: { text: "Keep building" },
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // followUpContent includes model/agentId from sendMessageOptions (captured for follow-up)
    expect(metadata.parsed.followUpContent?.text).toBe("Keep building");
    expect(metadata.parsed.followUpContent?.model).toBe("anthropic:claude-sonnet-4-6");
    expect(metadata.parsed.followUpContent?.agentId).toBe("exec");
  });

  test("compaction recovery keeps the persisted follow-up's restrictions when retry options lack them", () => {
    // Retrying a failed compaction passes the already-persisted follow-up together with
    // storage-derived send options, which never carry a caller toolPolicy. The preserved
    // restrictions must survive that recomposition or the recovered follow-up resumes with
    // unrestricted caller tools.
    const recoveredFollowUp = {
      text: "Keep building",
      model: "openai:gpt-4o",
      agentId: "code",
      toolPolicy: [{ regex_match: "^bash$", action: "disable" as const }],
      disableWorkspaceAgents: true,
    };
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: recoveredFollowUp,
      sendMessageOptions: { model: "anthropic:claude-sonnet-4-6", agentId: "exec" },
    });

    expectCompactionMetadata(metadata);
    expect(metadata.parsed.followUpContent?.toolPolicy).toEqual(recoveredFollowUp.toolPolicy);
    expect(metadata.parsed.followUpContent?.disableWorkspaceAgents).toBe(true);
    // Existing model/agentId still win over the retry-time options.
    expect(metadata.parsed.followUpContent?.model).toBe("openai:gpt-4o");
    expect(metadata.parsed.followUpContent?.agentId).toBe("code");
  });

  test("carried one-shot overrides win over ambient preserved send options", () => {
    // A compact-and-retry rebuild of "/haiku+0 /skill" carries the one-shot's
    // model, thinking, and persistence semantics in followUpContent; the
    // ambient stored options (different thinking, no skip flags) must not
    // clobber them.
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "/haiku+0 /done finish up",
        model: "anthropic:claude-3-5-haiku",
        skipSkillModelRouting: true,
        thinkingLevel: "off",
        skipAiSettingsPersistence: true,
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    const followUp = metadata.parsed.followUpContent;
    expect(followUp?.model).toBe("anthropic:claude-3-5-haiku");
    expect(followUp?.skipSkillModelRouting).toBe(true);
    expect(followUp?.thinkingLevel).toBe("off");
    expect(followUp?.skipAiSettingsPersistence).toBe(true);
  });

  test("a thinking-only carried one-shot keeps its raw index for routed re-resolution", () => {
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "/+0 /done finish up",
        thinkingLevel: "medium",
        oneShotThinkingIndex: 0,
        skipAiSettingsPersistence: true,
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    const followUp = metadata.parsed.followUpContent;
    // No model override: the re-dispatch stays routable...
    expect(followUp?.model).toBe("anthropic:claude-sonnet-4-6");
    expect(followUp?.skipSkillModelRouting).toBeUndefined();
    // ...and the raw index survives so the backend can re-ladder it.
    expect(followUp?.oneShotThinkingIndex).toBe(0);
    expect(followUp?.thinkingLevel).toBe("medium");
  });

  test("does not create followUpContent when no text or images provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeUndefined();
  });

  test("captures model/agentId from sendMessageOptions for follow-up", () => {
    // Use different model/agentId than base options to verify they're captured
    const sendMessageOptions: SendMessageOptions = {
      model: "openai:gpt-4o",
      thinkingLevel: "medium",
      toolPolicy: [],
      agentId: "code",
    };

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // Follow-up should use the user's original model/agentId
    expect(metadata.parsed.followUpContent?.model).toBe("openai:gpt-4o");
    expect(metadata.parsed.followUpContent?.agentId).toBe("code");
  });

  test("uses agentId from sendMessageOptions in followUpContent", () => {
    const sendMessageOptions: SendMessageOptions = {
      model: "openai:gpt-4o",
      thinkingLevel: "medium",
      toolPolicy: [],
      agentId: "exec",
    };

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent?.agentId).toBe("exec");
  });

  test("creates followUpContent when text is provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue with this" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("Continue with this");
  });

  test("rawCommand includes multiline continue payload", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 2048,
      model: "anthropic:claude-3-5-haiku",
      followUpContent: { text: "Line 1\nLine 2" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.rawCommand).toBe(
      "/compact -t 2048 -m anthropic:claude-3-5-haiku\nLine 1\nLine 2"
    );
  });

  test("omits default resume text from compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expect(messageText).not.toContain("The user wants to continue with: Continue");

    expectCompactionMetadata(metadata);

    // Still queued for auto-send after compaction
    expect(metadata.parsed.followUpContent?.text).toBe("Continue");
  });

  test("includes non-default continue text in compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "fix tests" },
      sendMessageOptions,
    });

    expect(messageText).toContain("The user wants to continue with: fix tests");
  });

  test("creates followUpContent when images are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "",
        fileParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.fileParts).toHaveLength(1);
  });

  test("creates followUpContent when reviews are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Please fix this",
          },
        ],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
    expect(metadata.parsed.followUpContent?.reviews?.[0].userNote).toBe("Please fix this");
  });

  test("creates followUpContent with reviews and text combined", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "Also check the tests",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Fix this bug",
          },
        ],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("Also check the tests");
    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
  });

  test("builds followUpContent from sourceContent with skill metadata", () => {
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "/tests run all tests",
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/tests run all tests",
          skillName: "tests",
          scope: "project",
        },
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // Follow-up content should be built from sourceContent.
    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("/tests run all tests");

    // Skill metadata should be preserved in muxMetadata
    expect(metadata.parsed.followUpContent?.muxMetadata).toEqual({
      type: "agent-skill",
      rawCommand: "/tests run all tests",
      skillName: "tests",
      scope: "project",
    });
  });

  test("does not treat 'Continue' as default resume when reviews are present", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "Continue",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10",
            selectedCode: "x = 1",
            userNote: "Check this",
          },
        ],
      },
      sendMessageOptions,
    });

    // When reviews are present, "Continue" should be included in compaction prompt
    // because there's actual work to continue with (the reviews)
    expect(messageText).toContain("The user wants to continue with: Continue");

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
  });
});
