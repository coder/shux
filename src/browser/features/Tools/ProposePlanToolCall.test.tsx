import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as APIModule from "@/browser/contexts/API";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as UseOpenInEditorModule from "@/browser/hooks/useOpenInEditor";
import * as UseReviewsModule from "@/browser/hooks/useReviews";
import * as UseStartHereModule from "@/browser/hooks/useStartHere";
import * as DiffRendererModule from "@/browser/features/Shared/DiffRenderer";
import * as ReviewTypesModule from "@/common/types/review";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getPlanContentKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

import { ProposePlanToolCall } from "./ProposePlanToolCall";

interface SendMessageArgs {
  workspaceId: string;
  message: string;
  options: SendMessageOptions;
}

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

type ResultVoid = { success: true; data: undefined } | { success: false; error: string };

interface GetConfigResult {
  taskSettings: {
    maxParallelAgentTasks: number;
    maxTaskNestingDepth: number;
    proposePlanImplementReplacesChatHistory?: boolean;
  };
  agentAiDefaults: Record<string, unknown>;
}

interface MockApi {
  config: {
    getConfig: () => Promise<GetConfigResult>;
  };
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
    replaceChatHistory: (args: {
      workspaceId: string;
      summaryMessage: unknown;
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }) => Promise<ResultVoid>;
    sendMessage: (args: SendMessageArgs) => Promise<{ success: true; data: undefined }>;
  };
}

let mockApi: MockApi | null = null;

let startHereCalls: Array<{
  workspaceId: string | undefined;
  content: string;
  isCompacted: boolean;
  options: { deletePlanFile?: boolean; sourceAgentId?: string } | undefined;
}> = [];

let selectableDiffRendererCalls: Array<{ filePath?: string }> = [];

const useStartHereMock = mock(
  (
    workspaceId: string | undefined,
    content: string,
    isCompacted: boolean,
    options?: { deletePlanFile?: boolean; sourceAgentId?: string }
  ) => {
    startHereCalls.push({ workspaceId, content, isCompacted, options });
    return {
      openModal: () => undefined,
      isStartingHere: false,
      buttonLabel: "Start Here",
      buttonEmoji: "",
      disabled: false,
      modal: null,
    };
  }
);

const actualUseStartHereModule = { ...UseStartHereModule };
const actualAPIModule = { ...APIModule };
const actualUseOpenInEditorModule = { ...UseOpenInEditorModule };
const actualWorkspaceContextModule = { ...WorkspaceContextModule };
const actualUseReviewsModule = { ...UseReviewsModule };
const actualDiffRendererModule = { ...DiffRendererModule };
const actualReviewTypesModule = { ...ReviewTypesModule };

async function installProposePlanModuleMocks() {
  await mock.module("@/browser/hooks/useStartHere", () => ({
    ...actualUseStartHereModule,
    useStartHere: useStartHereMock,
  }));
  await mock.module("@/browser/contexts/API", () => ({
    ...actualAPIModule,
    useAPI: () => ({ api: mockApi, status: "connected" as const, error: null }),
  }));
  await mock.module("@/browser/hooks/useOpenInEditor", () => ({
    ...actualUseOpenInEditorModule,
    useOpenInEditor: () => () => Promise.resolve({ success: true } as const),
  }));
  await mock.module("@/browser/contexts/WorkspaceContext", () => ({
    ...actualWorkspaceContextModule,
    useWorkspaceContext: () => ({
      workspaceMetadata: new Map<string, { runtimeConfig?: unknown }>(),
    }),
  }));
  await mock.module("@/browser/hooks/useReviews", () => ({
    ...actualUseReviewsModule,
    useReviews: () => ({
      reviews: [],
      pendingCount: 0,
      attachedCount: 0,
      checkedCount: 0,
      attachedReviews: [],
      addReview: (data: unknown) => ({
        id: "test-review",
        data,
        status: "attached" as const,
        createdAt: Date.now(),
      }),
      attachReview: () => undefined,
      detachReview: () => undefined,
      attachAllPending: () => undefined,
      detachAllAttached: () => undefined,
      checkReview: () => undefined,
      uncheckReview: () => undefined,
      removeReview: () => undefined,
      updateReviewNote: () => undefined,
      clearChecked: () => undefined,
      clearAll: () => undefined,
      getReview: () => undefined,
    }),
  }));
  await mock.module("@/browser/features/Shared/DiffRenderer", () => ({
    ...actualDiffRendererModule,
    SelectableDiffRenderer: (props: { filePath?: string }) => {
      selectableDiffRendererCalls.push({ filePath: props.filePath });
      return <div data-testid="selectable-diff-renderer" data-filepath={props.filePath ?? ""} />;
    },
  }));
  await mock.module("@/common/types/review", () => ({
    ...actualReviewTypesModule,
    isPlanFilePath: (filePath: string) => /[/\\]plans[/\\]/.test(filePath),
    normalizePlanFilePath: (filePath: string) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      const tildeMuxMatch = /^~\/\.mux\/plans\/(.+)$/.exec(normalizedPath);
      if (tildeMuxMatch?.[1]) {
        return `.mux/plans/${tildeMuxMatch[1]}`;
      }

      return normalizedPath;
    },
  }));
}

async function restoreProposePlanModuleMocks() {
  // Bun's mock.module() has no disposer, and mock.restore() does not undo module mocks.
  // Restore real exports so this test's renderer stubs do not leak into review suites.
  await mock.module("@/browser/hooks/useStartHere", () => actualUseStartHereModule);
  await mock.module("@/browser/contexts/API", () => actualAPIModule);
  await mock.module("@/browser/hooks/useOpenInEditor", () => actualUseOpenInEditorModule);
  await mock.module("@/browser/contexts/WorkspaceContext", () => actualWorkspaceContextModule);
  await mock.module("@/browser/hooks/useReviews", () => actualUseReviewsModule);
  await mock.module("@/browser/features/Shared/DiffRenderer", () => actualDiffRendererModule);
  await mock.module("@/common/types/review", () => actualReviewTypesModule);
}

const WORKSPACE_ID = "ws-123";
const PLAN_PATH = "~/.mux/plans/demo/ws-123.md";
const PLAN_CONTENT = "# My Plan\n\nDo the thing.";

const DEFAULT_CONFIG: GetConfigResult = {
  taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
  agentAiDefaults: {},
};

function createTestAgent(
  id: string,
  name: string,
  model: string,
  thinkingLevel: NonNullable<AgentDefinitionDescriptor["aiDefaults"]>["thinkingLevel"]
): AgentDefinitionDescriptor {
  return {
    id,
    name,
    scope: "built-in",
    uiSelectable: true,
    subagentRunnable: true,
    aiDefaults: { model, thinkingLevel },
  };
}

const TEST_AGENTS = [
  createTestAgent("exec", "Exec", "openai:gpt-5.2", "low"),
  createTestAgent("plan", "Plan", "anthropic:claude-sonnet-4-5", "high"),
];

const noop = () => {
  // intentional noop for tests
};

function renderToolCall(content: JSX.Element, agentId = "plan") {
  return render(
    <AgentProvider
      value={{
        agentId,
        setAgentId: noop,
        currentAgent: TEST_AGENTS.find((entry) => entry.id === agentId),
        agents: TEST_AGENTS,
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        disableWorkspaceAgents: false,
        setDisableWorkspaceAgents: noop,
      }}
    >
      <TooltipProvider>{content}</TooltipProvider>
    </AgentProvider>
  );
}

type ProposePlanProps = ComponentProps<typeof ProposePlanToolCall>;

function createMockApi(
  overrides: {
    config?: GetConfigResult;
    getPlanContent?: MockApi["workspace"]["getPlanContent"];
    replaceChatHistory?: MockApi["workspace"]["replaceChatHistory"];
    sendMessage?: MockApi["workspace"]["sendMessage"];
  } = {}
): MockApi {
  return {
    config: { getConfig: () => Promise.resolve(overrides.config ?? DEFAULT_CONFIG) },
    workspace: {
      getPlanContent:
        overrides.getPlanContent ??
        (() =>
          Promise.resolve({
            success: true,
            data: { content: PLAN_CONTENT, path: PLAN_PATH },
          })),
      replaceChatHistory:
        overrides.replaceChatHistory ?? (() => Promise.resolve({ success: true, data: undefined })),
      sendMessage:
        overrides.sendMessage ?? (() => Promise.resolve({ success: true, data: undefined })),
    },
  };
}

function renderPlanToolCall(props: Partial<ProposePlanProps> = {}, agentId?: string) {
  return renderToolCall(
    <ProposePlanToolCall args={{}} workspaceId={WORKSPACE_ID} isLatest={false} {...props} />,
    agentId
  );
}

function renderCompletedPlan(props: Partial<ProposePlanProps> = {}) {
  return renderPlanToolCall({
    status: "completed",
    result: { success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT },
    isLatest: true,
    ...props,
  });
}

function startInPlanMode(workspaceId = WORKSPACE_ID, model?: string, thinkingLevel?: string) {
  window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
  if (model) updatePersistedState(getModelKey(workspaceId), model);
  if (thinkingLevel) updatePersistedState(getThinkingLevelKey(workspaceId), thinkingLevel);
}

function recordSendMessage(calls: SendMessageArgs[]): MockApi["workspace"]["sendMessage"] {
  return (args) => {
    calls.push(args);
    return Promise.resolve({ success: true, data: undefined });
  };
}

function expectSingleQuoteRoot(view: { container: HTMLElement }, text: string) {
  const quoteRoots = Array.from(
    view.container.querySelectorAll<HTMLElement>("[data-transcript-quote-root]")
  );
  expect(quoteRoots).toHaveLength(1);
  expect(
    quoteRoots.find((element) => element.getAttribute("data-transcript-quote-text") === text)
  ).toBeDefined();
}

describe("ProposePlanToolCall", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await restoreProposePlanModuleMocks();
  });

  beforeEach(async () => {
    startHereCalls = [];
    selectableDiffRendererCalls = [];
    mockApi = null;
    cleanupDom = installDom();
    await installProposePlanModuleMocks();
  });

  afterEach(async () => {
    cleanup();
    await restoreProposePlanModuleMocks();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("does not claim plan is in chat when Start Here content is a placeholder", () => {
    renderPlanToolCall({ result: { success: true, planPath: PLAN_PATH } });

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.content).toContain("*Plan saved to");
    expect(startHereCalls[0]?.content).not.toContain(
      "Note: This chat already contains the full plan"
    );
    expect(startHereCalls[0]?.content).toContain("Read the plan file below");
  });
  test("keeps plan file on disk and includes plan path note in Start Here content", () => {
    renderPlanToolCall({
      // Old-format chat history may include planContent; this is the easiest path to
      // ensure the rendered Start Here message includes the full plan + the path note.
      result: { success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT },
    });

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.options).toEqual({ sourceAgentId: "plan" });
    expect(startHereCalls[0]?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHereCalls[0]?.content).toContain("*Plan file preserved at:*");
    expect(startHereCalls[0]?.content).toContain("Note: This chat already contains the full plan");
    expect(startHereCalls[0]?.content).toContain(PLAN_PATH);
  });

  test.each([
    ["shows", true],
    ["hides", false],
  ])("%s Annotate button based on latest completed plan state", (verb, isLatest) => {
    const view = renderCompletedPlan({ isLatest });
    const button = view.queryByRole("button", { name: "Annotate" });

    if (verb === "shows") expect(button).not.toBeNull();
    else expect(button).toBeNull();
  });

  test("hides Annotate button while latest plan call is still executing", async () => {
    let getPlanContentCalls = 0;

    mockApi = createMockApi({
      getPlanContent: () => {
        getPlanContentCalls += 1;
        return Promise.resolve({
          success: true,
          data: { content: PLAN_CONTENT, path: PLAN_PATH },
        });
      },
    });

    const view = renderPlanToolCall({ status: "executing", isLatest: true });

    await waitFor(() => expect(getPlanContentCalls).toBe(1));
    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("passes normalized plan path to annotation view", () => {
    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));

    const renderer = view.getByTestId("selectable-diff-renderer");
    expect(renderer.getAttribute("data-filepath")).toBe(".mux/plans/demo/ws-123.md");
    expect(selectableDiffRendererCalls[selectableDiffRendererCalls.length - 1]?.filePath).toBe(
      ".mux/plans/demo/ws-123.md"
    );
  });

  test("hides Annotate button when completed propose_plan result is an error", () => {
    updatePersistedState(getPlanContentKey(WORKSPACE_ID), {
      content: "# Cached Plan\n\nDo the thing.",
      path: PLAN_PATH,
    });

    const view = renderPlanToolCall({
      status: "completed",
      result: { success: false, error: "failed to generate plan" },
      isLatest: true,
    });

    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("annotate mode and raw mode are mutually exclusive", () => {
    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "Show Text" }));
    expect(view.queryByTestId("plan-annotation-view")).toBeNull();
    expect(view.container.querySelector("pre")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();
    expect(view.container.querySelector("pre")).toBeNull();
  });

  test("exposes the plan body as an explicit transcript quote root", () => {
    expectSingleQuoteRoot(renderCompletedPlan(), PLAN_CONTENT);
  });

  test("keeps the plan transcript quote root in ephemeral previews", () => {
    const planContent = "# Preview Plan\n\nShip it.";
    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        content={planContent}
        path={PLAN_PATH}
        workspaceId={WORKSPACE_ID}
        isEphemeralPreview={true}
      />
    );

    expectSingleQuoteRoot(view, planContent);
  });

  test("does not toggle annotate mode with Shift+A in ephemeral previews", () => {
    const view = renderToolCall(
      <>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# My Plan\n\nDo the thing."
          path={PLAN_PATH}
          workspaceId={WORKSPACE_ID}
          isEphemeralPreview={true}
        />
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# Another Plan\n\nDo the other thing."
          path={PLAN_PATH}
          workspaceId={WORKSPACE_ID}
          isEphemeralPreview={true}
        />
      </>
    );

    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);

    fireEvent.keyDown(document, { key: "a", shiftKey: true });

    expect(view.queryByRole("button", { name: "Exit Annotate" })).toBeNull();
    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const execModel = "openai:gpt-5.2";
    const execThinking = "low";

    startInPlanMode(WORKSPACE_ID, "anthropic:claude-sonnet-4-5", "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel, thinkingLevel: execThinking },
    });

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execThinking);

    // Clicking Implement should switch the workspace agent to exec.
    //
    // Note: some tests in this repo mock the `usePersistedState` module globally. In that case,
    // `updatePersistedState` won't actually write to localStorage here, so we assert the call.
    const agentKey = getAgentIdKey(WORKSPACE_ID);
    const modelKey = getModelKey(WORKSPACE_ID);
    const thinkingKey = getThinkingLevelKey(WORKSPACE_ID);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "exec");
      expect(updatePersistedState).toHaveBeenCalledWith(modelKey, execModel);
      expect(updatePersistedState).toHaveBeenCalledWith(thinkingKey, execThinking);
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("exec");
      expect(JSON.parse(window.localStorage.getItem(modelKey)!)).toBe(execModel);
      expect(JSON.parse(window.localStorage.getItem(thinkingKey)!)).toBe(execThinking);
    }
  });

  test("uses workspace-by-agent override for Implement when exec defaults inherit", async () => {
    const execWorkspaceModel = "openai:gpt-5.2-pro";
    const execWorkspaceThinking = "medium";

    startInPlanMode(WORKSPACE_ID, "anthropic:claude-sonnet-4-5", "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});
    updatePersistedState(getWorkspaceAISettingsByAgentKey(WORKSPACE_ID), {
      exec: { model: execWorkspaceModel, thinkingLevel: execWorkspaceThinking },
    });

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execWorkspaceModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execWorkspaceThinking);
  });

  test("replaces chat history before implementing when setting enabled", async () => {
    startInPlanMode();

    const calls: Array<"replaceChatHistory" | "sendMessage"> = [];
    const replaceChatHistoryCalls: Array<
      Parameters<MockApi["workspace"]["replaceChatHistory"]>[0]
    > = [];
    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = createMockApi({
      config: {
        ...DEFAULT_CONFIG,
        taskSettings: {
          ...DEFAULT_CONFIG.taskSettings,
          proposePlanImplementReplacesChatHistory: true,
        },
      },
      replaceChatHistory: (args) => {
        calls.push("replaceChatHistory");
        replaceChatHistoryCalls.push(args);
        return Promise.resolve({ success: true, data: undefined });
      },
      sendMessage: (args) => {
        calls.push("sendMessage");
        sendMessageCalls.push(args);
        return Promise.resolve({ success: true, data: undefined });
      },
    });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(replaceChatHistoryCalls.length).toBe(1);
    expect(calls).toEqual(["replaceChatHistory", "sendMessage"]);

    const replaceArgs = replaceChatHistoryCalls[0];
    expect(replaceArgs?.deletePlanFile).toBe(false);
    expect(replaceArgs?.mode).toBe("append-compaction-boundary");

    const summaryMessage = replaceArgs?.summaryMessage as {
      role?: string;
      metadata?: { agentId?: string };
      parts?: Array<{ type?: string; text?: string }>;
    };

    expect(summaryMessage.role).toBe("assistant");
    expect(summaryMessage.parts?.[0]?.text).toContain(
      "Note: This chat already contains the full plan"
    );
    expect(summaryMessage.metadata?.agentId).toBe("plan");
    expect(summaryMessage.parts?.[0]?.text).toContain("*Plan file preserved at:*");
    expect(summaryMessage.parts?.[0]?.text).toContain(PLAN_PATH);
  });

  test("renders a plan table of contents derived from the plan's markdown headings", () => {
    // Note: we deliberately don't assert against rendered <h1>/<h2> elements here
    // because some sibling test files mock MarkdownCore at file scope (file-scope
    // module mocks persist across files in this runner). The TOC's source of truth
    // is the markdown TEXT, not the rendered DOM, so this assertion stays robust.
    const planContent = [
      "# Title",
      "",
      "intro paragraph",
      "",
      "## Section A",
      "",
      "body",
      "",
      "## Section B",
      "",
      "more",
    ].join("\n");

    const view = renderCompletedPlan({
      result: { success: true, planPath: PLAN_PATH, planContent },
    });

    const toc = view.getByTestId("plan-toc");
    expect(toc.textContent).toContain("Title");
    expect(toc.textContent).toContain("Section A");
    expect(toc.textContent).toContain("Section B");

    // Each entry is a real <button>, so the user can drive navigation with the
    // keyboard. The dedicated PlanTableOfContents.test.tsx verifies the
    // scrollIntoView wiring directly.
    expect(view.getByRole("button", { name: "Section A" })).toBeDefined();
    expect(view.getByRole("button", { name: "Section B" })).toBeDefined();
  });

  test("does not render a plan TOC for plans with fewer than two visible headings", () => {
    // PLAN_CONTENT only has one heading ("# My Plan"), so the TOC should not appear.
    const view = renderCompletedPlan();
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("does not render a plan TOC while annotate mode is active", () => {
    // Need at least two h2+ entries; h1 is reserved for the TOC's heading
    // (the plan title) and never shows up as a list item.
    const planContent = "# A\n\nbody\n\n## B\n\nmore\n\n## C\n\nmore";
    const view = renderCompletedPlan({
      result: { success: true, planPath: PLAN_PATH, planContent },
    });

    // Sanity: TOC is visible before annotate mode.
    expect(view.queryByTestId("plan-toc")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));

    expect(view.queryByTestId("plan-toc")).toBeNull();
  });
});
