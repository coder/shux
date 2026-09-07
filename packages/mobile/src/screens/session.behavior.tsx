import { secureStore, stackState } from "./sessionTestPlatform";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import { ConnectedApp } from "../../App";
import type { Connection } from "./ConnectScreen";
import type { MobileClient } from "../api";
import type { SettingsData } from "../settings";
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

type Policy = Awaited<ReturnType<MobileClient["policy"]["get"]>>;
const disabledPolicy: Policy = { source: "none", status: { state: "disabled" }, policy: null };
function fixture(
  messages: WorkspaceChatMessage[] = [],
  wide = false,
  initialPolicy: Policy | Error = disabledPolicy
) {
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
  let config: SettingsData["config"] = { agentAiDefaults: {}, defaultModel: model };
  let providers: SettingsData["providers"] = {
    anthropic: { isConfigured: true, isEnabled: true, apiKeySet: true, models: ["allowed"] },
  };
  const configEvents: ReadableStreamDefaultController<void>[] = [];
  const providerEvents: ReadableStreamDefaultController<void>[] = [];
  let configRead = async () => config;
  let policy = initialPolicy;
  const policyEvents: ReadableStreamDefaultController<void>[] = [];
  let closed = 0;
  let reconnected = 0;
  let disconnected = 0;
  let send = async (): Promise<unknown> => ({ success: true });
  let interrupt = async (): Promise<unknown> => ({ success: true });
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
        case "policy.get":
          if (policy instanceof Error) throw policy;
          return policy;
        case "policy.onChanged":
          return events<void>(options.signal, [], (controller) => policyEvents.push(controller));
        case "config.onConfigChanged":
          return events<void>(options.signal, [], (controller) => configEvents.push(controller));
        case "providers.onConfigChanged":
          return events<void>(options.signal, [], (controller) => providerEvents.push(controller));
        case "config.getConfig":
          return configRead();
        case "providers.getConfig":
          return providers;
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
        case "workspace.interruptStream":
          return interrupt();
        case "workspace.sendMessage":
          return send();
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
    setSend(value: typeof send) {
      send = value;
    },
    setInterrupt(value: typeof interrupt) {
      interrupt = value;
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
    setConfigRead(read: typeof configRead) {
      configRead = read;
    },
    async updateConfig(next: SettingsData["config"]) {
      config = next;
      await act(async () => configEvents.at(-1)!.enqueue());
    },
    async updateProviders(next: SettingsData["providers"]) {
      providers = next;
      await act(async () => providerEvents.at(-1)!.enqueue());
    },
    async updatePolicy(next: Policy) {
      policy = next;
      await act(async () => policyEvents.at(-1)!.enqueue());
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

function questionInput(id: string) {
  return {
    questions: [
      {
        question: `Answer ${id}?`,
        header: "Branch",
        options: [
          { label: "main", description: "Stable branch" },
          { label: "next", description: "Upcoming release" },
        ],
        multiSelect: false,
      },
    ],
  };
}

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
        input: questionInput(id),
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
  fireEvent.click(
    within(view.getByRole("radiogroup", { name: `Answer ${id}?` })).getByRole("radio", {
      name: "main",
    })
  );
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
    options: { model, agentId: "exec", allowAgentSetGoal: true },
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
      args: questionInput("live"),
      timestamp: 1,
    },
  ]);
  await view.select("alpha");
  expect(
    within(view.getByRole("radiogroup", { name: "Answer old?" }))
      .getByRole("radio", { name: "main" })
      .getAttribute("aria-disabled")
  ).toBe("true");
  fireEvent.click(
    within(view.getByRole("radiogroup", { name: "Answer live?" })).getByRole("radio", {
      name: "main",
    })
  );
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
    expect(
      within(view.getByRole("radiogroup", { name: "Answer old?" }))
        .getByRole("radio", { name: "main" })
        .getAttribute("aria-disabled")
    ).toBe("true");
    expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  });
}

test("a complete historical pending question is not recoverable", async () => {
  const view = fixture([question("complete", 1, false)]);
  await view.select("alpha");
  expect(
    within(view.getByRole("radiogroup", { name: "Answer complete?" }))
      .getByRole("radio", { name: "main" })
      .getAttribute("aria-disabled")
  ).toBe("true");
});

function answeredPartial(id = "question", partial = true) {
  const message = question(id, 1, partial);
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "dynamic-tool"
        ? { ...part, state: "output-available" as const, output: { summary: "answered" } }
        : part
    ),
  };
}

test("replayed saved answers offer manual resume, preserve no-op/error retries, and suppress duplicate starts until reconnect", async () => {
  const saved = answeredPartial();
  const view = fixture([saved]);
  await view.select("alpha");
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(callCount(view, "resumeStream")).toBe(0);
  view.setResume(async () => ({ success: true, data: { started: false } }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Resume agent" })));
  expect(callCount(view, "resumeStream")).toBe(1);
  view.setResume(async () => {
    throw new Error("offline");
  });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Resume agent" })));
  expect(view.getByRole("alert").textContent).toContain("offline");
  const resume = deferred<unknown>();
  view.setResume(() => resume.promise);
  const retry = view.getByRole("button", { name: "Resume agent" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(callCount(view, "resumeStream")).toBe(3);
  await act(async () => resume.resolve({ success: true, data: { started: true } }));
  await view.emit(saved);
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Keep draft" } });
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  await act(async () => view.chats[0].end());
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Retry" })));
  await waitFor(() => expect(view.chats).toHaveLength(2));
  expect(await view.findByRole("button", { name: "Resume agent" })).toBeDefined();
  expect(callCount(view, "resumeStream")).toBe(3);
});

test("an answered partial retains manual recovery after switching away and remounting", async () => {
  const messages: WorkspaceChatMessage[] = [question()];
  const view = fixture(messages);
  await view.select("alpha");
  view.setAnswer(async () => {
    messages[0] = answeredPartial();
    view.chats.at(-1)!.events.enqueue(answered());
    return { success: true };
  });
  view.setResume(async () => ({ success: false, error: "provider unavailable" }));
  await submitAnswer(view);
  fireEvent.click(view.getByRole("button", { name: "Back to workspaces" }));
  await view.select("alpha");
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(view.getByRole("button", { name: "Resume agent" })).toBeDefined();
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
});

test("completed answers do not enable recovery for historical rows, completed turns or active streams", async () => {
  const saved = answeredPartial();
  for (const messages of [
    [answeredPartial("complete", false)],
    [saved, question("newer", 2)],
    [
      saved,
      { type: "message", id: "user", role: "user", parts: [], metadata: { historySequence: 2 } },
    ],
    [
      saved,
      { type: "stream-lifecycle", workspaceId: "alpha", phase: "streaming", hadAnyOutput: true },
    ],
  ] satisfies WorkspaceChatMessage[][]) {
    const view = fixture(messages);
    await view.select("alpha");
    expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
    expect(callCount(view, "resumeStream")).toBe(0);
    view.unmount();
  }
});

test("durable answer recovery still waits for policy and live settings", async () => {
  const view = fixture([answeredPartial()], false, {
    source: "env",
    status: { state: "blocked", reason: "upgrade required" },
    policy: null,
  });
  await view.select("alpha");
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  const config = deferred<SettingsData["config"]>();
  view.setConfigRead(() => config.promise);
  await view.updateConfig({ agentAiDefaults: {} });
  await view.updatePolicy(disabledPolicy);
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  const providerOptions = { anthropic: { disableBetaFeatures: true } };
  await act(async () =>
    config.resolve({ agentAiDefaults: {}, userPreferences: { ai: { providerOptions } } })
  );
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Resume agent" })));
  expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  expect(view.calls.find((call) => call.path === "workspace.resumeStream")?.input).toMatchObject({
    options: { providerOptions },
  });
});

test("a successful no-op resume keeps the recovery action without resubmitting the answer", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  view.setAnswer(async () => {
    view.chats.at(-1)!.events.enqueue(answered());
    return { success: true };
  });
  view.setResume(async () => ({ success: true, data: { started: false } }));
  await submitAnswer(view);
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
  const retry = view.getByRole("button", { name: "Resume agent" });
  view.setResume(async () => ({ success: true, data: { started: true } }));
  await act(async () => fireEvent.click(retry));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(2);
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
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

test("blocked initial model stays selected and editable while a permitted choice unlocks sending", async () => {
  const view = fixture([], false, {
    source: "env",
    status: { state: "enforced" },
    policy: {
      policyFormatVersion: "0.1",
      providerAccess: [{ id: "anthropic", allowedModels: ["allowed"] }],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    },
  });
  await view.select("alpha");
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Keep draft" } });
  expect(view.getByRole("alert")).toBeDefined();
  expect(view.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  expect(view.getByRole("radio", { name: model }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(view.getByRole("radio", { name: "anthropic:allowed" }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  expect(callCount(view, "sendMessage")).toBe(1);
  expect(view.calls.find((call) => call.path === "workspace.sendMessage")?.input).toMatchObject({
    message: "Keep draft",
    options: { model: "anthropic:allowed" },
  });
});

test("server minimum-client block disables answers and sending until live policy recovery", async () => {
  const blocked: Policy = {
    source: "env",
    status: { state: "blocked", reason: "minimum_client_version requires server upgrade" },
    policy: null,
  };
  const view = fixture([question()], false, blocked);
  await view.select("alpha");
  expect(view.getByRole("alert").textContent).toContain(blocked.status.reason!);
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Retained" } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(0);
  expect(view.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  await view.updatePolicy(disabledPolicy);
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  await submitAnswer(view);
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
});

test("policy changes during a saved answer prevent automatic resume and permit resume-only recovery", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  const pending = deferred<unknown>();
  view.setAnswer(() => pending.promise);
  await submitAnswer(view);
  await view.updatePolicy({
    source: "env",
    status: { state: "blocked", reason: "upgrade required" },
    policy: null,
  });
  await act(async () => pending.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(0);
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  await view.updatePolicy(disabledPolicy);
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Resume agent" })));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
});

test("an initial policy read failure exposes retry and preserves model access and draft without permitting a send", async () => {
  const view = fixture([], false, new Error("policy unavailable"));
  await view.select("alpha");
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Keep me" } });
  expect(view.getByRole("alert")).toBeDefined();
  expect(view.getByRole("button", { name: "Choose model" }).getAttribute("aria-disabled")).not.toBe(
    "true"
  );
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(0);
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Retry" })));
  await waitFor(() =>
    expect(view.calls.filter((call) => call.path === "policy.get")).toHaveLength(2)
  );
  expect(view.reconnected).toBe(1);
  await view.updatePolicy(disabledPolicy);
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(view.getByLabelText("Message")).toHaveProperty("value", "Keep me");
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  expect(callCount(view, "sendMessage")).toBe(1);
});

test("answer continuation resumes with the same latest selection that policy permits", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  const pending = deferred<unknown>();
  view.setAnswer(() => pending.promise);
  await submitAnswer(view);
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  fireEvent.click(view.getByRole("radio", { name: "anthropic:allowed" }));
  await view.updatePolicy({
    source: "env",
    status: { state: "enforced" },
    policy: {
      policyFormatVersion: "0.1",
      providerAccess: [{ id: "anthropic", allowedModels: ["allowed"] }],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    },
  });
  await act(async () => pending.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(1);
  expect(view.calls.find((call) => call.path === "workspace.resumeStream")?.input).toMatchObject({
    options: { model: "anthropic:allowed" },
  });
});

test("live privacy changes replace stale selection options for sending and answer continuation", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  fireEvent.click(view.getByRole("radio", { name: "anthropic:allowed" }));
  const providerOptions = {
    anthropic: { disableBetaFeatures: true, cacheTtl: "1h" as const },
    google: { cache: false },
  };
  await view.updateConfig({
    agentAiDefaults: {},
    defaultModel: "openai:different-default",
    userPreferences: { ai: { providerOptions } },
  });
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Private request" } });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  expect(view.calls.find((call) => call.path === "workspace.sendMessage")?.input).toMatchObject({
    message: "Private request",
    options: { model: "anthropic:allowed", providerOptions },
  });
  const answer = deferred<unknown>();
  view.setAnswer(() => answer.promise);
  await submitAnswer(view);
  const changedOptions = {
    ...providerOptions,
    anthropic: { disableBetaFeatures: false },
  };
  await view.updateConfig({
    agentAiDefaults: {},
    userPreferences: { ai: { providerOptions: changedOptions } },
  });
  await act(async () => answer.resolve({ success: true }));
  expect(view.calls.find((call) => call.path === "workspace.resumeStream")?.input).toMatchObject({
    options: { model: "anthropic:allowed", providerOptions: changedOptions },
  });
});

test("live route and provider changes re-evaluate policy without replacing the selected model", async () => {
  const view = fixture();
  await view.select("alpha");
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  fireEvent.click(view.getByRole("radio", { name: "anthropic:allowed" }));
  const providers = {
    anthropic: { isConfigured: true, isEnabled: true, apiKeySet: true },
    coder: { isConfigured: true, isEnabled: true, apiKeySet: false, models: ["anthropic/allowed"] },
  };
  await view.updateProviders(providers);
  const config = { agentAiDefaults: {}, routePriority: ["coder", "direct"] };
  await view.updateConfig(config);
  await view.updatePolicy({
    source: "env",
    status: { state: "enforced" },
    policy: {
      policyFormatVersion: "0.1",
      providerAccess: [{ id: "coder" }],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    },
  });
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Same model" } });
  const send = () => view.getByRole("button", { name: "Send message" });
  expect(send().getAttribute("aria-disabled")).not.toBe("true");
  await view.updateConfig({ ...config, routeOverrides: { "anthropic:allowed": "direct" } });
  expect(send().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(send());
  expect(callCount(view, "sendMessage")).toBe(0);
  await view.updateConfig(config);
  expect(send().getAttribute("aria-disabled")).not.toBe("true");
  await view.updateProviders({ ...providers, coder: { ...providers.coder, isEnabled: false } });
  expect(send().getAttribute("aria-disabled")).toBe("true");
  await view.updateProviders(providers);
  await act(async () => fireEvent.click(send()));
  expect(view.calls.find((call) => call.path === "workspace.sendMessage")?.input).toMatchObject({
    options: { model: "anthropic:allowed" },
  });
  expect(view.calls.filter((call) => call.path === "agents.list")).toHaveLength(1);
});

test("unavailable live settings prevent send and retain resume-only recovery after an answer is saved", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  const answer = deferred<unknown>();
  view.setAnswer(() => answer.promise);
  await submitAnswer(view);
  const read = deferred<SettingsData["config"]>();
  view.setConfigRead(() => read.promise);
  await view.updateConfig({ agentAiDefaults: {} });
  await view.emit(answered());
  await act(async () => answer.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(0);
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Wait for settings" } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(0);
  const providerOptions = { anthropic: { disableBetaFeatures: true } };
  await act(async () =>
    read.resolve({ agentAiDefaults: {}, userPreferences: { ai: { providerOptions } } })
  );
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Resume agent" })));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(view.calls.find((call) => call.path === "workspace.resumeStream")?.input).toMatchObject({
    options: { providerOptions },
  });
});

function restoredInput(): Extract<WorkspaceChatMessage, { type: "restore-to-input" }> {
  return {
    type: "restore-to-input",
    workspaceId: "alpha",
    text: "Queued follow-up",
    fileParts: [
      { filename: "queue.txt", mediaType: "text/plain", url: "data:text/plain;base64,cXVldWU=" },
    ],
    reviews: [
      {
        filePath: "src/queue.ts",
        lineRange: "10-11",
        selectedCode: "const next = 1;",
        selectedDiff: "+const next = 1;",
        oldStart: 10,
        newStart: 10,
        userNote: "Preserve the queued input",
      },
    ],
  };
}

test("interrupt restores the full queue into the existing draft once and keeps it across navigation/reconnect", async () => {
  const restored = restoredInput();
  const replay: WorkspaceChatMessage[] = [
    {
      type: "stream-start",
      workspaceId: "alpha",
      messageId: "live",
      historySequence: 1,
      startTime: 1,
      model,
    },
    {
      type: "queued-message-changed",
      workspaceId: "alpha",
      queuedMessages: [restored.text],
      displayText: restored.text,
      fileParts: restored.fileParts,
      reviews: restored.reviews,
    },
  ];
  const view = fixture(replay);
  await view.select("alpha");
  expect(view.getByLabelText("Message")).toHaveProperty("value", "");
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Existing draft" } });
  view.setInterrupt(async () => {
    view.chats[0].events.enqueue(restored);
    const idle = {
      type: "stream-lifecycle",
      workspaceId: "alpha",
      phase: "idle",
      hadAnyOutput: true,
    } as const;
    view.chats[0].events.enqueue(idle);
    replay.splice(0, replay.length, idle);
    return { success: true };
  });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Interrupt agent" })));
  expect(view.calls.find((call) => call.path === "workspace.interruptStream")?.input).toEqual({
    workspaceId: "alpha",
    options: { retireBashMonitorAttention: true, disableAutoRetry: true },
  });
  expect(view.getByLabelText("Message")).toHaveProperty(
    "value",
    "Existing draft\n\nQueued follow-up"
  );
  expect(view.getByText("queue.txt")).toBeDefined();
  expect(view.getByText("1 review note")).toBeDefined();
  await view.emit({ ...restored, workspaceId: "beta", text: "Wrong workspace" });
  expect(callCount(view, "onChat")).toBe(1);
  expect(view.getByLabelText("Message")).toHaveProperty(
    "value",
    "Existing draft\n\nQueued follow-up"
  );
  fireEvent.click(view.getByRole("button", { name: "Back to workspaces" }));
  await view.select("alpha");
  await act(async () => view.chats.at(-1)!.end());
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Retry" })));
  await waitFor(() => expect(view.chats).toHaveLength(3));
  expect(view.getByLabelText("Message")).toHaveProperty(
    "value",
    "Existing draft\n\nQueued follow-up"
  );
  expect(view.getAllByText("queue.txt")).toHaveLength(1);
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  const request = view.calls.find((call) => call.path === "workspace.sendMessage")?.input;
  expect(request).toMatchObject({
    options: { fileParts: restored.fileParts, muxMetadata: { reviews: restored.reviews } },
  });
  expect(request).toHaveProperty(
    "message",
    expect.stringContaining("Existing draft\n\nQueued follow-up")
  );
  expect(request).toHaveProperty("message", expect.stringContaining(restored.reviews![0].userNote));
  expect(request).toHaveProperty(
    "message",
    expect.stringContaining(restored.reviews![0].selectedCode)
  );
  expect(view.getByLabelText("Message")).toHaveProperty("value", "");
  expect(view.queryByText("queue.txt")).toBeNull();
  expect(view.queryByText("1 review note")).toBeNull();
});

test("failed sends preserve full restored drafts and successful sends cannot erase newer text or extras", async () => {
  const restored = restoredInput();
  const view = fixture();
  await view.select("alpha");
  await view.emit(restored);
  view.setSend(async () => ({ success: false, error: "send unavailable" }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
  expect(view.getByRole("alert").textContent).toContain("send unavailable");
  expect(view.getByLabelText("Message")).toHaveProperty("value", restored.text);
  expect(view.getByText("queue.txt")).toBeDefined();
  expect(view.getByText("1 review note")).toBeDefined();
  const send = deferred<unknown>();
  view.setSend(() => send.promise);
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(2);
  expect(view.getByLabelText("Message").getAttribute("readonly")).toBeNull();
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "New draft" } });
  await view.emit({
    ...restored,
    text: "Another restore",
    fileParts: [{ ...restored.fileParts![0], filename: "new.txt" }],
  });
  expect(view.getByText("queue.txt")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Remove attachment queue.txt" }));
  await act(async () => send.resolve({ success: true }));
  expect(view.getByLabelText("Message")).toHaveProperty("value", "New draft\n\nAnother restore");
  expect(view.queryByText("queue.txt")).toBeNull();
  expect(view.getByText("new.txt")).toBeDefined();
  expect(view.getByText("2 review notes")).toBeDefined();
  expect(callCount(view, "onChat")).toBe(1);
  expect(view.calls.filter((call) => call.path === "workspace.sendMessage")[1].input).toMatchObject(
    {
      options: { fileParts: restored.fileParts, muxMetadata: { reviews: restored.reviews } },
    }
  );
  fireEvent.click(view.getByRole("button", { name: "Remove review notes" }));
  expect(view.queryByText("2 review notes")).toBeNull();
});

for (const extra of ["attachment", "review"] as const) {
  test(`${extra}-only restored drafts send without text`, async () => {
    const restored = restoredInput();
    const view = fixture();
    await view.select("alpha");
    await view.emit({
      ...restored,
      text: "",
      fileParts: extra === "attachment" ? restored.fileParts : [],
      reviews: extra === "review" ? restored.reviews : [],
    });
    expect(view.getByLabelText("Message")).toHaveProperty("value", "");
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Send message" })));
    expect(callCount(view, "sendMessage")).toBe(1);
    expect(view.calls.find((call) => call.path === "workspace.sendMessage")?.input).toMatchObject(
      extra === "attachment"
        ? { message: "", options: { fileParts: restored.fileParts } }
        : { options: { muxMetadata: { reviews: restored.reviews } } }
    );
    expect(view.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe(
      "true"
    );
  });
}

test("live interruption remains available during pending and failed settings refreshes, but not a lost transport", async () => {
  const view = fixture([
    {
      type: "stream-start",
      workspaceId: "alpha",
      messageId: "live",
      historySequence: 1,
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
      args: questionInput("live"),
      timestamp: 1,
    },
  ]);
  await view.select("alpha");
  const read = deferred<SettingsData["config"]>();
  view.setConfigRead(() => read.promise);
  await view.updateConfig({ agentAiDefaults: {} });
  const interrupt = () => view.getByRole("button", { name: "Interrupt agent" });
  expect(interrupt().getAttribute("aria-disabled")).not.toBe("true");
  expect(view.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
  await act(async () => fireEvent.click(interrupt()));
  expect(callCount(view, "interruptStream")).toBe(1);
  await act(async () => read.reject(new Error("settings unavailable")));
  expect(view.getByRole("alert")).toBeDefined();
  expect(interrupt().getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => fireEvent.click(interrupt()));
  expect(callCount(view, "interruptStream")).toBe(2);
  expect(callCount(view, "sendMessage")).toBe(0);
  expect(callCount(view, "answerAskUserQuestion")).toBe(0);
  expect(callCount(view, "resumeStream")).toBe(0);
  await act(async () => view.chats[0].end());
  expect(view.queryByRole("button", { name: "Interrupt agent" })).toBeNull();
  expect(view.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
});

test("policy-off live provider loss retains selection and blocks send and answers until restored", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Keep this draft" } });
  await view.updateProviders({
    anthropic: { isEnabled: false, isConfigured: false, apiKeySet: true },
  });
  expect(view.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
  expect(view.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
    "true"
  );
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  expect(callCount(view, "sendMessage")).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  expect(view.getByRole("radio", { name: model }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(view.getByRole("radio", { name: model }));
  await view.updateProviders({
    anthropic: { isEnabled: true, isConfigured: true, apiKeySet: true },
  });
  await submitAnswer(view);
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
  expect(view.getByLabelText("Message")).toHaveProperty("value", "Keep this draft");
});

test("lost credentials during answer saving block resume until a valid route is restored", async () => {
  const view = fixture([question()]);
  await view.select("alpha");
  const answer = deferred<unknown>();
  view.setAnswer(() => answer.promise);
  await submitAnswer(view);
  await view.updateProviders({
    anthropic: { isEnabled: true, isConfigured: false, apiKeySet: false },
  });
  await view.emit(answered());
  await act(async () => answer.resolve({ success: true }));
  expect(callCount(view, "resumeStream")).toBe(0);
  expect(view.queryByRole("button", { name: "Resume agent" })).toBeNull();
  await view.updateProviders({
    anthropic: { isEnabled: true, isConfigured: true, apiKeySet: true },
  });
  await act(async () => fireEvent.click(await view.findByRole("button", { name: "Resume agent" })));
  expect(callCount(view, "answerAskUserQuestion")).toBe(1);
  expect(callCount(view, "resumeStream")).toBe(1);
});

test("an unavailable current route does not disable interruption of its already-running stream", async () => {
  const view = fixture([
    {
      type: "stream-start",
      workspaceId: "alpha",
      messageId: "live",
      historySequence: 1,
      startTime: 1,
      model,
    },
  ]);
  await view.select("alpha");
  await view.updateProviders({});
  expect(view.getByRole("alert")).toBeDefined();
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Interrupt agent" })));
  expect(callCount(view, "interruptStream")).toBe(1);
});

test("live direct-auth and routing changes gate the current OpenAI selection without blocking a valid gateway", async () => {
  const view = fixture();
  await view.select("alpha");
  const openai = {
    isConfigured: true,
    isEnabled: true,
    apiKeySet: true,
    codexOauthSet: false,
    models: ["gpt-4o"],
  };
  await view.updateProviders({ openai });
  fireEvent.click(view.getByRole("button", { name: "Choose model" }));
  fireEvent.click(view.getByRole("radio", { name: "openai:gpt-4o" }));
  fireEvent.change(view.getByLabelText("Message"), {
    target: { value: "Use the available route" },
  });
  const send = () => view.getByRole("button", { name: "Send message" });
  expect(send().getAttribute("aria-disabled")).not.toBe("true");
  const oauthOnly = { ...openai, apiKeySet: false, codexOauthSet: true };
  await view.updateProviders({ openai: oauthOnly });
  expect(send().getAttribute("aria-disabled")).toBe("true");
  const coder = {
    isConfigured: true,
    isEnabled: true,
    apiKeySet: false,
    models: ["openai/gpt-4o"],
    discoveredModels: ["openai/gpt-4o"],
  };
  await view.updateConfig({ agentAiDefaults: {}, routePriority: ["coder", "direct"] });
  await view.updateProviders({ openai: oauthOnly, coder });
  expect(send().getAttribute("aria-disabled")).not.toBe("true");
  await view.updateConfig({
    agentAiDefaults: {},
    routePriority: ["coder", "direct"],
    routeOverrides: { "openai:gpt-4o": "direct" },
  });
  expect(send().getAttribute("aria-disabled")).toBe("true");
  await view.updateConfig({ agentAiDefaults: {}, routePriority: ["coder", "direct"] });
  await view.updateProviders({
    openai: oauthOnly,
    coder: { ...coder, removedModels: ["openai/gpt-4o"] },
  });
  expect(send().getAttribute("aria-disabled")).toBe("true");
  await view.updateProviders({ openai: oauthOnly, coder });
  await act(async () => fireEvent.click(send()));
  expect(callCount(view, "sendMessage")).toBe(1);
  expect(view.calls.find((call) => call.path === "workspace.sendMessage")?.input).toMatchObject({
    options: { model: "openai:gpt-4o" },
  });
});
