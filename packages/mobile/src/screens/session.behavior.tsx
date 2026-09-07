import { secureStore, stackState } from "./sessionTestPlatform";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import { ConnectedApp } from "../../App";
import type { Connection } from "./ConnectScreen";
import type { MobileClient } from "../api";
import type { WorkspaceChatMessage } from "../transcript";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";

const model = "anthropic:claude-sonnet-4-5";
const workspaces: FrontendWorkspaceMetadata[] = ["alpha", "beta"].map((id) => ({
  id,
  name: id,
  projectName: "project",
  projectPath: "/project",
  namedWorkspacePath: `/project/${id}`,
  runtimeConfig: { type: "local" },
}));
afterEach(() => {
  cleanup();
  secureStore.clear = async () => {};
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(messages: WorkspaceChatMessage[] = [], wide = false) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: wide ? 1200 : 375,
  });
  act(() => window.dispatchEvent(new Event("resize")));
  const chats: Array<{
    workspaceId: string;
    signal: AbortSignal;
    events: ReadableStreamDefaultController<WorkspaceChatMessage>;
    end: () => void;
  }> = [];
  const calls: Array<{ path: string; input: unknown; signal?: AbortSignal }> = [];
  let closed = 0;
  let reconnected = 0;
  let disconnected = 0;
  let answer = async (): Promise<unknown> => ({ success: true });
  let resume = async (): Promise<unknown> => ({ success: true, data: { started: true } });
  function events<T>(
    signal?: AbortSignal,
    initial: T[] = [],
    onStart?: (controller: ReadableStreamDefaultController<T>, end: () => void) => void
  ) {
    return new ReadableStream<T>({
      start(controller) {
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          controller.close();
        };
        signal?.addEventListener("abort", end, { once: true });
        initial.forEach((event) => controller.enqueue(event));
        onStart?.(controller, end);
      },
    }).values();
  }
  const client = createORPCClient<MobileClient>({
    call: async (path, input, options) => {
      const name = path.join(".");
      calls.push({ path: name, input, signal: options.signal });
      switch (name) {
        case "workspace.onMetadata":
          return events(options.signal);
        case "workspace.list":
          return workspaces;
        case "projects.list":
          return [];
        case "config.getConfig":
          return { agentAiDefaults: {}, defaultModel: model };
        case "providers.getConfig":
          return {};
        case "agents.list":
          return [
            { id: "exec", name: "Exec", uiSelectable: true },
            { id: "plan", name: "Plan", uiSelectable: true },
          ];
        case "workspace.onChat": {
          if (
            !options.signal ||
            !input ||
            typeof input !== "object" ||
            !("workspaceId" in input) ||
            typeof input.workspaceId !== "string"
          )
            throw new Error("Missing subscription identity");
          const workspaceId = input.workspaceId;
          const signal = options.signal;
          return events<WorkspaceChatMessage>(
            signal,
            [...messages, { type: "caught-up" }],
            (controller, end) => chats.push({ workspaceId, signal, events: controller, end })
          );
        }
        case "workspace.answerAskUserQuestion":
          return answer();
        case "workspace.resumeStream":
          return resume();
        case "workspace.sendMessage":
          return { success: true };
        case "workspace.executeBash":
          return { success: true, data: { success: true, output: "" } };
        default:
          throw new Error(`Unexpected call: ${name}`);
      }
    },
  });
  const connection: Connection = {
    client,
    endpoint: "https://example.test",
    close() {
      closed++;
    },
    async reconnect() {
      reconnected++;
      return connection;
    },
  };
  const view = render(
    <ConnectedApp
      connection={connection}
      onDisconnect={() => {
        disconnected++;
        view.unmount();
      }}
    />
  );
  return {
    ...view,
    calls,
    chats,
    get closed() {
      return closed;
    },
    get reconnected() {
      return reconnected;
    },
    get disconnected() {
      return disconnected;
    },
    setAnswer(value: typeof answer) {
      answer = value;
    },
    setResume(value: typeof resume) {
      resume = value;
    },
    async select(id: string) {
      fireEvent.click(await view.findByRole("button", { name: id }));
      await waitFor(() =>
        expect(
          view.getByRole("button", { name: "Choose mode" }).getAttribute("aria-disabled")
        ).not.toBe("true")
      );
    },
    async emit(event: WorkspaceChatMessage) {
      await act(async () => chats.at(-1)!.events.enqueue(event));
    },
  };
}

test("failed credential clearing leaves the session usable and reconnectable before retrying disconnect", async () => {
  const view = fixture();
  await view.select("alpha");
  fireEvent.click(view.getByRole("button", { name: "Connection settings" }));
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  const clear = deferred<void>();
  secureStore.clear = () => clear.promise;
  fireEvent.click(view.getByRole("button", { name: "Disconnect & forget credentials" }));
  expect(view.closed).toBe(0);
  expect(view.chats[0].signal.aborted).toBe(false);
  await act(async () => clear.reject(new Error("keychain locked")));
  expect(view.disconnected).toBe(0);
  expect(view.getByRole("alert")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Keep connection" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Still usable" } });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  expect(view.calls.filter((call) => call.path === "workspace.sendMessage")).toHaveLength(1);
  await act(async () => view.chats[0].end());
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Retry" })));
  await waitFor(() => expect(view.reconnected).toBe(1));
  await waitFor(() => expect(view.chats).toHaveLength(2));
  secureStore.clear = async () => {};
  fireEvent.click(view.getByRole("button", { name: "Connection settings" }));
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Disconnect & forget credentials" }))
  );
  expect(view.disconnected).toBe(1);
  expect(view.chats[1].signal.aborted).toBe(true);
});

test("wide selections replace detail subscriptions without losing the workspace anchor, drafts or choices", async () => {
  const view = fixture([], true);
  await view.select("alpha");
  const anchor = stackState.routes[0].key;
  const active = stackState.routes[1].key;
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "alpha draft" } });
  fireEvent.click(view.getByRole("button", { name: "Choose mode" }));
  fireEvent.click(view.getByRole("radio", { name: "Plan" }));
  await view.select("alpha");
  expect(stackState.routes[1].key).toBe(active);
  expect(view.chats).toHaveLength(1);
  await view.select("beta");
  expect(view.chats[0].signal.aborted).toBe(true);
  expect(view.chats.filter((chat) => !chat.signal.aborted).map((chat) => chat.workspaceId)).toEqual(
    ["beta"]
  );
  expect(stackState.routes).toHaveLength(2);
  expect(stackState.routes[0].key).toBe(anchor);
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "beta draft" } });
  await view.select("alpha");
  expect(view.getByLabelText("Message")).toHaveProperty("value", "alpha draft");
  expect(view.getByRole("button", { name: "Choose mode" }).textContent).toContain("Plan");
  fireEvent.click(view.getByRole("button", { name: "Back to workspaces" }));
  expect(stackState.routes.map((route) => route.name)).toEqual(["Workspaces"]);
  expect(view.chats.every((chat) => chat.signal.aborted)).toBe(true);
  await view.select("beta");
  expect(view.getByLabelText("Message")).toHaveProperty("value", "beta draft");
});

for (const detail of ["Settings", "Changes"] as const) {
  test(`wide ${detail} selection prunes old details and reuses only the selected conversation`, async () => {
    const view = fixture([], true);
    await view.select("alpha");
    const alphaKey = stackState.routes[1].key;
    const open = () =>
      fireEvent.click(
        view.getByRole("button", {
          name: detail === "Settings" ? "Connection settings" : "View changes",
        })
      );
    open();
    expect(stackState.routes.map((route) => route.name)).toEqual([
      "Workspaces",
      "Conversation",
      detail,
    ]);
    await view.select("alpha");
    expect(stackState.routes).toHaveLength(2);
    expect(stackState.routes[1].key).toBe(alphaKey);
    expect(view.chats).toHaveLength(1);
    open();
    await view.select("beta");
    expect(stackState.routes).toHaveLength(2);
    expect(view.chats[0].signal.aborted).toBe(true);
    expect(
      view.calls
        .filter((call) => call.path === "workspace.executeBash")
        .every((call) => call.signal?.aborted)
    ).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Back to workspaces" }));
    expect(stackState.routes.map((route) => route.name)).toEqual(["Workspaces"]);
  });
}

test("settings opened from the wide workspace root retains the back anchor when selecting a workspace", async () => {
  const view = fixture([], true);
  fireEvent.click(await view.findByRole("button", { name: "Settings" }));
  await view.select("beta");
  expect(stackState.routes.map((route) => route.name)).toEqual(["Workspaces", "Conversation"]);
  fireEvent.click(view.getByRole("button", { name: "Connection settings" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(view.chats).toHaveLength(1);
  expect(view.chats[0].signal.aborted).toBe(false);
});

function question(
  id = "question",
  sequence = 1,
  partial = true
): Extract<WorkspaceChatMessage, { type: "message" }> {
  return {
    type: "message",
    id,
    role: "assistant",
    metadata: { historySequence: sequence, partial },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "ask_user_question",
        toolCallId: id,
        state: "input-available",
        input: { questions: [{ question: `Answer ${id}?` }] },
      },
    ],
  };
}
function answered(id = "question"): WorkspaceChatMessage {
  return {
    type: "tool-call-end",
    workspaceId: "alpha",
    messageId: id,
    toolCallId: id,
    toolName: "ask_user_question",
    result: { summary: "answered" },
    timestamp: 1,
  };
}
function callCount(view: ReturnType<typeof fixture>, name: string) {
  return view.calls.filter((call) => call.path === `workspace.${name}`).length;
}
async function submitAnswer(view: ReturnType<typeof fixture>, id = "question") {
  fireEvent.change(view.getByLabelText(`Answer ${id}?`), { target: { value: "main" } });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send answers" })));
}

test("the latest recovered partial can be answered once and resumes only after saving with current options", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  const answer = deferred<unknown>();
  view.setAnswer(() => answer.promise);
  await submitAnswer(view);
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(0);
  await view.emit(answered());
  await act(async () => answer.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(1);
  expect(view.calls.find((call) => call.path === "workspace.resumeStream")?.input).toMatchObject({
    workspaceId: "alpha",
    options: { model, agentId: "exec" },
  });
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
});

test("live questions do not resume, and older pending partials stay disabled while streaming", async () => {
  const view = fixture([
    question("old"),
    {
      type: "stream-start",
      workspaceId: "alpha",
      messageId: "live",
      historySequence: 2,
      startTime: 1,
      model,
    },
    {
      type: "tool-call-start",
      workspaceId: "alpha",
      messageId: "live",
      toolCallId: "live",
      toolName: "ask_user_question",
      tokens: 1,
      args: { questions: [{ question: "Answer live?" }] },
      timestamp: 1,
    },
  ]);
  await view.select("alpha");
  expect(view.getByLabelText("Answer old?").getAttribute("readonly")).not.toBeNull();
  fireEvent.change(view.getByLabelText("Answer live?"), { target: { value: "main" } });
  const buttons = view.getAllByRole("button", { name: "Send answers" });
  await act(async () => buttons.forEach((button) => fireEvent.click(button)));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(0);
});

for (const latest of [
  question("later", 2),
  {
    type: "message",
    id: "user",
    role: "user",
    parts: [{ type: "text", text: "Move on" }],
    metadata: { historySequence: 2 },
  },
] satisfies WorkspaceChatMessage[]) {
  test(`an old recovered question is not re-enabled by a later ${latest.role} message`, async () => {
    const view = fixture([question("old"), latest]);
    await view.select("alpha");
    expect(view.getByLabelText("Answer old?").getAttribute("readonly")).not.toBeNull();
    expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  });
}

test("a complete historical pending question is not recoverable", async () => {
  const view = fixture([question("complete", 1, false)]);
  await view.select("alpha");
  expect(view.getByLabelText("Answer complete?").getAttribute("readonly")).not.toBeNull();
});

test("answer failure is retryable without resuming; resume failure survives tool completion and retries only resume", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  view.setAnswer(async () => ({ success: false, error: "storage unavailable" }));
  await submitAnswer(view);
  expect(view.getByRole("alert").textContent).toContain("storage unavailable");
  expect(callCount(view, "resumeStream")).toBe(0);
  view.setAnswer(async () => {
    view.chats.at(-1)!.events.enqueue(answered());
    return { success: true };
  });
  view.setResume(async () => ({
    success: false,
    error: { type: "unknown", raw: "resume unavailable" },
  }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send answers" })));
  expect(view.getByRole("alert").textContent).toContain("resume unavailable");
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  const resumed = deferred<unknown>();
  view.setResume(() => resumed.promise);
  fireEvent.click(view.getByRole("button", { name: "Resume agent" }));
  fireEvent.click(view.getByRole("button", { name: "Resume agent" }));
  expect(callCount(view, "resumeStream")).toBe(2);
  expect(callCount(view, "answerAskUserQuestion")).toBe(2);
  await act(async () => resumed.resolve({ success: true, data: { started: true } }));
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

test("a competing stream or newer turn prevents recovery from resuming a stale answer", async () => {
  for (const event of [
    {
      type: "stream-start",
      workspaceId: "alpha",
      messageId: "other",
      historySequence: 2,
      startTime: 1,
      model,
    },
    {
      type: "message",
      id: "next",
      role: "user",
      parts: [{ type: "text", text: "Move on" }],
      metadata: { historySequence: 2 },
    },
  ] satisfies WorkspaceChatMessage[]) {
    const view = fixture([question()]);
    await view.select("alpha");
    const pending = deferred<unknown>();
    view.setAnswer(() => pending.promise);
    await submitAnswer(view);
    await view.emit(event);
    await act(async () => pending.resolve({ success: true }));
    expect(callCount(view, "resumeStream")).toBe(0);
    view.unmount();
  }
});

test("reconnect cancels the old answer's resume continuation and reconciles pending recovery", async () => {
  const view = fixture([question()], true);
  await view.select("alpha");
  const oldAnswer = deferred<unknown>();
  view.setAnswer(() => oldAnswer.promise);
  await submitAnswer(view);
  await act(async () => view.chats[0].end());
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Retry" })));
  await waitFor(() => expect(view.chats).toHaveLength(2));
  await act(async () => oldAnswer.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(0);
  view.setAnswer(async () => ({ success: true }));
  await submitAnswer(view);
  expect(callCount(view, "answerAskUserQuestion")).toBe(2);
  expect(callCount(view, "resumeStream")).toBe(1);
});
