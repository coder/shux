import "./testDom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import { createDisplayTestClock } from "./displayTestClock";
import type { MobileClient } from "./api";
import { getVisibleMessages } from "./transcript";
import type { WorkspaceChatMessage } from "./transcript";
import { useConversation } from "./useConversation";
import { wakeStreams } from "./streams";
import type { RestoredInput } from "./draft";
import type { SettingsData } from "./settings";

afterEach(cleanup);

function message(
  sequence: number,
  text = `message ${sequence}`
): Extract<WorkspaceChatMessage, { type: "message" }> {
  return {
    type: "message",
    id: String(sequence),
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { historySequence: sequence },
  };
}

type Policy = Awaited<ReturnType<MobileClient["policy"]["get"]>>;
const disabledPolicy: Policy = { source: "none", status: { state: "disabled" }, policy: null };

function fixture(
  getPolicy: () => Promise<Policy> = async () => disabledPolicy,
  reads: {
    config?: () => Promise<SettingsData["config"]>;
    agents?: () => Promise<SettingsData["agents"]>;
    providers?: () => Promise<SettingsData["providers"]>;
  } = {}
) {
  type Page = Awaited<ReturnType<MobileClient["workspace"]["history"]["loadMore"]>>;
  let complete!: (page: Page) => void;
  const page = new Promise<Page>((resolve) => {
    complete = resolve;
  });
  let eventController!: ReadableStreamDefaultController<WorkspaceChatMessage>;
  const policyRequests: AbortSignal[] = [];
  const policySubscriptions: Array<{
    signal: AbortSignal;
    events: ReadableStreamDefaultController<void>;
    fail: (error: Error) => void;
  }> = [];
  const configSubscriptions: typeof policySubscriptions = [];
  const providerSubscriptions: typeof policySubscriptions = [];
  const settingsRequests: Array<{ path: string; signal: AbortSignal }> = [];
  const settingsOrder: string[] = [];
  function notifications(
    subscriptions: typeof policySubscriptions,
    signal: AbortSignal,
    source: string
  ) {
    const events = new ReadableStream<void>({
      start(controller) {
        const close = () => controller.close();
        subscriptions.push({
          signal,
          events: controller,
          fail(error) {
            signal.removeEventListener("abort", close);
            controller.error(error);
          },
        });
        signal.addEventListener("abort", close, { once: true });
      },
    });
    return (async function* () {
      settingsOrder.push(`${source}.listen`);
      yield* events.values();
    })();
  }
  const restored: RestoredInput[] = [];
  const chatRequests: AbortSignal[] = [];
  const chatInputs: unknown[] = [];
  const requests: Array<{ input: unknown; signal?: AbortSignal }> = [];
  const client = createORPCClient<MobileClient>({
    call: async (path, input, options) => {
      switch (path.join(".")) {
        case "policy.get":
          policyRequests.push(options.signal!);
          return getPolicy();
        case "policy.onChanged":
          return new ReadableStream<void>({
            start(controller) {
              const close = () => controller.close();
              policySubscriptions.push({
                signal: options.signal!,
                events: controller,
                fail(error) {
                  options.signal?.removeEventListener("abort", close);
                  controller.error(error);
                },
              });
              options.signal?.addEventListener("abort", close, { once: true });
            },
          }).values();
        case "config.onConfigChanged":
          settingsOrder.push("config.subscribe");
          return notifications(configSubscriptions, options.signal!, "config");
        case "providers.onConfigChanged":
          settingsOrder.push("providers.subscribe");
          return notifications(providerSubscriptions, options.signal!, "providers");
        case "config.getConfig":
          settingsOrder.push("config.read");
          settingsRequests.push({ path: "config", signal: options.signal! });
          return reads.config ? reads.config() : { agentAiDefaults: {} };
        case "providers.getConfig":
          settingsOrder.push("providers.read");
          settingsRequests.push({ path: "providers", signal: options.signal! });
          return reads.providers ? reads.providers() : {};
        case "agents.list":
          settingsOrder.push("agents.read");
          settingsRequests.push({ path: "agents", signal: options.signal! });
          return reads.agents ? reads.agents() : [];
        case "workspace.onChat":
          chatRequests.push(options.signal!);
          chatInputs.push(input);
          return new ReadableStream<WorkspaceChatMessage>({
            start(controller) {
              eventController = controller;
              options.signal?.addEventListener(
                "abort",
                () => {
                  if (controller.desiredSize !== null) {
                    try {
                      controller.close();
                    } catch {
                      /* The test may have closed the stream first. */
                    }
                  }
                },
                { once: true }
              );
            },
          }).values();
        case "workspace.history.loadMore":
          requests.push({ input, signal: options.signal });
          return page;
        default:
          throw new Error(`Unexpected call: ${path.join(".")}`);
      }
    },
  });
  const lifetime = new AbortController();
  const view = renderHook<
    ReturnType<typeof useConversation>,
    {
      workspaceId: string;
      signal: AbortSignal;
      onRestore?: (event: RestoredInput) => void;
    }
  >(
    ({ workspaceId, signal, onRestore }) => useConversation(client, workspaceId, signal, onRestore),
    {
      initialProps: {
        workspaceId: "workspace",
        signal: lifetime.signal,
        onRestore: (event) => restored.push(event),
      },
    }
  );
  return {
    ...view,
    complete,
    requests,
    restored,
    chatRequests,
    chatInputs,
    policyRequests,
    policySubscriptions,
    configSubscriptions,
    providerSubscriptions,
    settingsRequests,
    settingsOrder,
    lifetime,
    async ready() {
      await waitFor(() => expect(eventController).toBeDefined());
      await act(async () => {
        eventController.enqueue(message(10, "current"));
        eventController.enqueue({ type: "caught-up", hasOlderHistory: true });
      });
      await waitFor(() => expect(view.result.current.transcript.caughtUp).toBe(true));
    },
    async disconnect() {
      await act(async () => eventController.close());
    },
    async emit(event: WorkspaceChatMessage, afterEnqueue?: () => void) {
      await act(async () => {
        eventController.enqueue(event);
        afterEnqueue?.();
      });
    },
  };
}

const displayStart: WorkspaceChatMessage = {
  type: "stream-start",
  workspaceId: "workspace",
  messageId: "live",
  model: "test:model",
  historySequence: 11,
  startTime: 1,
};
function displayDelta(
  delta: string,
  type: "stream-delta" | "reasoning-delta" = "stream-delta",
  messageId = "live"
): WorkspaceChatMessage {
  return { type, workspaceId: "workspace", messageId, delta, tokens: 1, timestamp: 2 };
}

test("display batching retains mixed IDs and text/reasoning order across immediate tool boundaries", async () => {
  using clock = createDisplayTestClock();
  const view = fixture();
  await view.ready();
  await view.emit(displayStart);
  const before = view.result.current.transcript;
  await view.emit(displayDelta("Think ", "reasoning-delta"));
  await view.emit(displayDelta("ignored", "stream-delta", "stale"));
  await view.emit(displayDelta("first", "reasoning-delta"));
  await view.emit(displayDelta("Answer"));
  expect(view.result.current.transcript).toBe(before);
  expect(clock.pending).toBe(1);
  await view.emit({
    type: "tool-call-start",
    workspaceId: "workspace",
    messageId: "live",
    toolCallId: "question",
    toolName: "ask_user_question",
    args: {},
    timestamp: 3,
    tokens: 1,
  });
  expect(view.result.current.transcript.messages.at(-1)?.parts).toMatchObject([
    { type: "reasoning", text: "Think first" },
    { type: "text", text: "Answer" },
    { type: "dynamic-tool", toolCallId: "question" },
  ]);
  expect(clock.pending).toBe(0);
  await view.emit(displayDelta("After"));
  act(() => clock.flush());
  expect(view.result.current.transcript.messages.at(-1)?.parts.at(-1)).toMatchObject({
    type: "text",
    text: "After",
  });
});

test("new stream identity and immediate policy updates are not delayed by the display throttle", async () => {
  using clock = createDisplayTestClock();
  let policy = disabledPolicy;
  const view = fixture(() => Promise.resolve(policy));
  await view.ready();
  await view.emit(displayStart);
  await view.emit(displayDelta("old tail"));
  await view.emit({ ...displayStart, messageId: "next", historySequence: 12 });
  expect(clock.pending).toBe(0);
  expect(view.result.current.transcript.streamingMessageId).toBe("next");
  expect(
    view.result.current.transcript.messages.find((message) => message.id === "live")?.parts[0]
  ).toMatchObject({ text: "old tail" });
  await view.emit(displayDelta("new tail", "stream-delta", "next"));
  policy = { source: "env", status: { state: "blocked", reason: "Policy changed" }, policy: null };
  await act(async () => view.policySubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.policy?.status.state).toBe("blocked"));
  expect(clock.pending).toBe(1);
  act(() => clock.flush());
  expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
    text: "new tail",
  });
});

test("restore and disconnect flush pending text immediately; deleting history cannot be undone by a timer or page", async () => {
  using clock = createDisplayTestClock();
  const view = fixture();
  await view.ready();
  await view.emit(displayStart);
  await view.emit(displayDelta("Before restore"));
  await view.emit({ type: "restore-to-input", workspaceId: "workspace", text: "draft" });
  expect(view.restored).toHaveLength(1);
  expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
    text: "Before restore",
  });
  let page!: Promise<void>;
  act(() => {
    page = view.result.current.loadOlder();
  });
  await view.emit(displayDelta(" pending"));
  await view.emit({ type: "delete", historySequences: [11] });
  expect(clock.pending).toBe(0);
  await act(async () => {
    view.complete({
      messages: [{ ...message(11), id: "live" }],
      hasOlder: false,
      nextCursor: null,
    });
    await page;
  });
  act(() => clock.flush());
  expect(view.result.current.transcript.messages.some((row) => row.id === "live")).toBe(false);
  await view.emit(displayStart);
  await view.emit(displayDelta("Keep on disconnect"));
  await view.disconnect();
  // A dropped stream is not an error: the transcript stays, but is read-only until resynced.
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.transcript.caughtUp).toBe(false);
  expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
    text: "Keep on disconnect",
  });
  expect(clock.pending).toBe(0);
});

test.each(["stream-abort", "stream-end", "stream-metadata"] as const)(
  "%s flushes queued deltas synchronously",
  async (type) => {
    using clock = createDisplayTestClock();
    const view = fixture();
    await view.ready();
    await view.emit(displayStart);
    await view.emit(displayDelta("tail"));
    if (type === "stream-end")
      await view.emit({
        type,
        workspaceId: "workspace",
        messageId: "live",
        metadata: { model: "test:model" },
        parts: [{ type: "text", text: "final" }],
      });
    else if (type === "stream-abort")
      await view.emit({ type, workspaceId: "workspace", messageId: "live", abortReason: "user" });
    else
      await view.emit({
        type,
        workspaceId: "workspace",
        messageId: "live",
        metadata: {
          model: "test:fallback",
          metadataModel: "test:fallback",
          contextWindowTokens: null,
          routedThroughGateway: false,
          routeProvider: null,
        },
      });
    expect(clock.pending).toBe(0);
    expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
      text: type === "stream-end" ? "final" : "tail",
    });
  }
);

test.each(["workspace", "connection", "abort", "unmount"] as const)(
  "%s discards queued display deltas and its timer",
  async (change) => {
    using clock = createDisplayTestClock();
    const view = fixture();
    await view.ready();
    await view.emit(displayStart);
    await view.emit(displayDelta("stale"));
    expect(clock.pending).toBe(1);
    if (change === "unmount") view.unmount();
    else if (change === "abort") act(() => view.lifetime.abort());
    else
      view.rerender({
        workspaceId: change === "workspace" ? "new" : "workspace",
        signal: change === "connection" ? new AbortController().signal : view.lifetime.signal,
      });
    expect(clock.pending).toBe(0);
    act(() => clock.flush());
    if (change !== "unmount")
      expect(
        view.result.current.transcript.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "stale")
        )
      ).toBe(false);
  }
);

test("a paused display timer cannot accumulate an unbounded delta queue", async () => {
  using clock = createDisplayTestClock();
  const view = fixture();
  await view.ready();
  await view.emit(displayStart);
  for (let index = 0; index < 1100; index++) await view.emit(displayDelta("x"));
  const displayed = view.result.current.transcript.messages.at(-1)?.parts[0];
  expect(displayed?.type === "text" ? displayed.text.length : 0).toBeGreaterThan(0);
  expect(clock.pending).toBeLessThanOrEqual(1);
  act(() => clock.flush());
  expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
    text: "x".repeat(1100),
  });
});

test("history pagination incorporates pending live deltas before merging older rows", async () => {
  using clock = createDisplayTestClock();
  const view = fixture();
  await view.ready();
  await view.emit(displayStart);
  let page!: Promise<void>;
  act(() => {
    page = view.result.current.loadOlder();
  });
  await view.emit(displayDelta("live text"));
  await act(async () => {
    view.complete({ messages: [message(1)], hasOlder: false, nextCursor: null });
    await page;
  });
  expect(clock.pending).toBe(0);
  expect(view.result.current.transcript.messages.map((message) => message.id)).toEqual([
    "1",
    "10",
    "live",
  ]);
  expect(view.result.current.transcript.messages.at(-1)?.parts[0]).toMatchObject({
    text: "live text",
  });
});

test("restore events use the latest workspace callback once without resubscribing or replaying queue snapshots", async () => {
  const view = fixture();
  await view.ready();
  const event: RestoredInput = {
    type: "restore-to-input",
    workspaceId: "workspace",
    text: "Follow up",
    fileParts: [
      { url: "data:text/plain;base64,dGV4dA==", mediaType: "text/plain", filename: "draft.txt" },
    ],
    reviews: [{ filePath: "draft.ts", lineRange: "1", selectedCode: "draft", userNote: "Keep it" }],
  };
  await view.emit({ ...event, workspaceId: "other" });
  await view.emit({
    type: "queued-message-changed",
    workspaceId: "workspace",
    queuedMessages: [event.text],
    displayText: event.text,
    fileParts: event.fileParts,
    reviews: event.reviews,
  });
  expect(view.restored).toHaveLength(0);
  const transcript = view.result.current.transcript;
  await view.emit(event);
  expect(view.restored).toEqual([event]);
  expect(view.result.current.transcript).toBe(transcript);
  const replacement: RestoredInput[] = [];
  view.rerender({
    workspaceId: "workspace",
    signal: view.lifetime.signal,
    onRestore: (value) => replacement.push(value),
  });
  expect(replacement).toHaveLength(0);
  await view.emit(event);
  expect(view.restored).toHaveLength(1);
  expect(replacement).toEqual([event]);
  expect(view.chatRequests).toHaveLength(1);
  await view.emit(event, () => view.lifetime.abort());
  expect(replacement).toHaveLength(1);
});

test("hidden replay and all-hidden pages retain raw cursors and advance pagination", async () => {
  const view = fixture();
  await view.ready();
  const hidden: WorkspaceChatMessage = {
    type: "message",
    id: "hidden",
    role: "user",
    parts: [],
    metadata: { historySequence: 8, synthetic: true },
  };
  await view.emit(hidden);
  const nextCursor = { beforeHistorySequence: 4, beforeMessageId: "older-hidden" };
  await act(async () => {
    const pending = view.result.current.loadOlder();
    view.complete({
      messages: [
        { ...hidden, id: "older-hidden", metadata: { historySequence: 4, synthetic: true } },
      ],
      nextCursor,
      hasOlder: true,
    });
    await pending;
  });
  expect(view.requests[0].input).toEqual({
    workspaceId: "workspace",
    cursor: { beforeHistorySequence: 8, beforeMessageId: "hidden" },
  });
  expect(
    getVisibleMessages(view.result.current.transcript.messages).map((item) => item.id)
  ).toEqual(["10"]);
  expect(view.result.current.transcript.messages.map((item) => item.id)).toEqual([
    "older-hidden",
    "hidden",
    "10",
  ]);
  expect(view.result.current.transcript.caughtUp).toBe(true);
  expect(view.result.current.transcript.hasOlderHistory).toBe(true);
  await act(async () => view.result.current.loadOlder());
  expect(view.requests[1].input).toEqual({ workspaceId: "workspace", cursor: nextCursor });
  await view.emit({ type: "delete", historySequences: [4, 8] });
  expect(view.result.current.transcript.messages.map((item) => item.id)).toEqual(["10"]);
});

test("older history is inserted without replacing newer copies and uses the oldest wire row", async () => {
  const view = fixture();
  await view.ready();
  await act(async () => {
    const pending = view.result.current.loadOlder();
    view.complete({
      messages: [message(2), message(10, "stale")],
      nextCursor: null,
      hasOlder: false,
    });
    await pending;
  });
  expect(view.requests[0].input).toEqual({
    workspaceId: "workspace",
    cursor: { beforeHistorySequence: 10, beforeMessageId: "10" },
  });
  expect(view.result.current.transcript.messages.map((item) => item.id)).toEqual(["2", "10"]);
  expect(view.result.current.transcript.messages[1].parts).toEqual([
    { type: "text", text: "current" },
  ]);
  expect(view.result.current.transcript.hasOlderHistory).toBe(false);
});

test("truncate cancels an older-history read so its late response cannot resurrect removed messages", async () => {
  const view = fixture();
  await view.ready();
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.loadOlder();
  });
  await view.emit({ type: "delete", historySequences: [2, 10] });
  expect(view.requests[0].signal?.aborted).toBe(true);
  await act(async () => {
    view.complete({ messages: [message(2)], nextCursor: null, hasOlder: false });
    await pending;
  });
  expect(view.result.current.transcript.messages).toEqual([]);
});

test("switching away aborts an in-flight page and duplicate taps do not start another read", async () => {
  const view = fixture();
  await view.ready();
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.loadOlder();
    view.result.current.loadOlder();
  });
  expect(view.requests).toHaveLength(1);
  view.unmount();
  expect(view.requests[0].signal?.aborted).toBe(true);
  view.complete({ messages: [message(2)], nextCursor: null, hasOlder: false });
  await pending;
});

test("initial policy and live changes are loaded once per event and abort with their scope", async () => {
  let policy: Policy = {
    source: "env",
    status: { state: "blocked", reason: "upgrade required" },
    policy: null,
  };
  const view = fixture(async () => policy);
  await view.ready();
  await waitFor(() => expect(view.result.current.settings?.policy).toEqual(policy));
  expect(view.policyRequests).toHaveLength(1);
  policy = disabledPolicy;
  await act(async () => view.policySubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.policy).toEqual(disabledPolicy));
  expect(view.policyRequests).toHaveLength(2);
  view.unmount();
  expect(view.policySubscriptions[0].signal.aborted).toBe(true);
  expect(view.policyRequests.every((signal) => signal.aborted)).toBe(true);
});

test("a failed policy read stays unavailable without hiding settings and a change can recover it", async () => {
  let fail = true;
  const view = fixture(async () => {
    if (fail) throw new Error("policy fetch failed");
    return disabledPolicy;
  });
  await view.ready();
  await waitFor(() => expect(view.policyRequests).toHaveLength(1));
  expect(view.result.current.settings).not.toBeNull();
  expect(view.result.current.settings?.policy).toBeNull();
  fail = false;
  await act(async () => view.policySubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.policy).toEqual(disabledPolicy));
  await act(async () => view.policySubscriptions[0].fail(new Error("subscription lost")));
  await waitFor(() => expect(view.result.current.settings?.policy).toBeNull());
});

test("a late policy response cannot update an aborted connection lifetime", async () => {
  let resolve!: (policy: Policy) => void;
  const view = fixture(
    () =>
      new Promise<Policy>((done) => {
        resolve = done;
      })
  );
  await view.ready();
  await waitFor(() => expect(view.policyRequests).toHaveLength(1));
  act(() => view.lifetime.abort());
  await act(async () => resolve(disabledPolicy));
  expect(view.result.current.settings?.policy).toBeNull();
  expect(view.policySubscriptions[0].signal.aborted).toBe(true);
});

test("switching workspace cancels old policy scope and ignores its late snapshot", async () => {
  let resolve!: (policy: Policy) => void;
  let first = true;
  const blocked: Policy = {
    source: "env",
    status: { state: "blocked", reason: "upgrade required" },
    policy: null,
  };
  const view = fixture(() => {
    if (!first) return Promise.resolve(blocked);
    first = false;
    return new Promise<Policy>((done) => {
      resolve = done;
    });
  });
  await view.ready();
  view.rerender({ workspaceId: "other", signal: view.lifetime.signal });
  await waitFor(() => expect(view.result.current.settings?.policy).toEqual(blocked));
  expect(view.policySubscriptions).toHaveLength(2);
  expect(view.policySubscriptions[0].signal.aborted).toBe(true);
  expect(view.policyRequests[0].aborted).toBe(true);
  await act(async () => resolve(disabledPolicy));
  expect(view.result.current.settings?.policy).toEqual(blocked);
  expect(view.policySubscriptions[1].signal.aborted).toBe(false);
});

test("settings subscriptions precede reads and refresh privacy, routes and provider availability", async () => {
  let config: SettingsData["config"] = { agentAiDefaults: {} };
  let providers: SettingsData["providers"] = {};
  const view = fixture(undefined, {
    config: async () => config,
    providers: async () => providers,
  });
  await view.ready();
  expect(view.configSubscriptions).toHaveLength(1);
  expect(view.providerSubscriptions).toHaveLength(1);
  // Both subscriptions are registered before any settings snapshot is read.
  expect(view.settingsOrder.slice(0, 2)).toEqual(["config.subscribe", "providers.subscribe"]);
  expect(view.settingsOrder.slice(2)).toEqual(
    expect.arrayContaining(["config.read", "agents.read", "providers.read"])
  );
  config = {
    ...config,
    routePriority: ["coder"],
    routeOverrides: { "openai:gpt-4o": "direct" },
    userPreferences: {
      ai: {
        providerOptions: { anthropic: { disableBetaFeatures: true }, google: { cache: false } },
      },
    },
  };
  await act(async () => view.configSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.config).toEqual(config));
  providers = {
    anthropic: { isEnabled: false, isConfigured: true, apiKeySet: true },
    openai: { isEnabled: true, isConfigured: true, apiKeySet: true, store: false },
  };
  await act(async () => view.providerSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.providers).toEqual(providers));
  expect(view.result.current.settings?.config).toEqual(config);
  view.unmount();
  expect(view.configSubscriptions[0].signal.aborted).toBe(true);
  expect(view.providerSubscriptions[0].signal.aborted).toBe(true);
});

test("agent catalogs refresh with config/providers and stale catalog success or failure cannot win", async () => {
  type Catalog = SettingsData["agents"];
  const enabled: Catalog = [
    { id: "scout", name: "Scout", uiSelectable: true, subagentRunnable: false, scope: "global" },
  ];
  let complete!: (value: Catalog) => void;
  let fail!: (error: Error) => void;
  let initial = true;
  let catalog = enabled;
  const view = fixture(undefined, {
    agents: () => {
      if (initial) {
        initial = false;
        return new Promise<Catalog>((resolve, reject) => {
          complete = resolve;
          fail = reject;
        });
      }
      return Promise.resolve(catalog);
    },
  });
  await view.ready();
  expect(view.result.current.settings).toBeNull();
  const first = view.settingsRequests.find((request) => request.path === "agents")!;
  await act(async () => view.configSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.agents).toEqual(enabled));
  expect(first.signal.aborted).toBe(true);
  await act(async () => complete([]));
  expect(view.result.current.settings?.agents).toEqual(enabled);
  initial = true;
  await act(async () => view.providerSubscriptions[0].events.enqueue());
  const staleFailure = fail;
  catalog = [];
  await act(async () => view.configSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.agents).toEqual([]));
  await act(async () => staleFailure(new Error("old catalog failed")));
  expect(view.result.current.settingsError).toBeNull();
  expect(view.result.current.settings?.agents).toEqual([]);
  catalog = enabled;
  await act(async () => view.providerSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.agents).toEqual(enabled));
  expect(view.settingsRequests.filter((request) => request.path === "agents")).toHaveLength(5);
});

test("a newer config event cancels a stale initial read rather than exposing old privacy settings", async () => {
  let resolve!: (config: SettingsData["config"]) => void;
  let first = true;
  const latest: SettingsData["config"] = {
    agentAiDefaults: {},
    userPreferences: { ai: { providerOptions: { anthropic: { disableBetaFeatures: true } } } },
  };
  const view = fixture(undefined, {
    config: () => {
      if (!first) return Promise.resolve(latest);
      first = false;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await waitFor(() => expect(view.settingsRequests.length).toBeGreaterThan(0));
  expect(view.configSubscriptions).toHaveLength(1);
  expect(view.providerSubscriptions).toHaveLength(1);
  expect(view.result.current.settings).toBeNull();
  await act(async () => view.configSubscriptions[0].events.enqueue());
  await waitFor(() => expect(view.result.current.settings?.config).toEqual(latest));
  expect(view.settingsRequests[0].signal.aborted).toBe(true);
  await act(async () => resolve({ agentAiDefaults: {} }));
  expect(view.result.current.settings?.config).toEqual(latest);
});

test.each(["config", "providers", "agents"] as const)(
  "a failed %s refresh blocks settings until a later notification recovers",
  async (source) => {
    let failed = false;
    const view = fixture(undefined, {
      config: async () => {
        if (source === "config" && failed) throw new Error("unavailable");
        return { agentAiDefaults: {} };
      },
      agents: async () => {
        if (source === "agents" && failed) throw new Error("unavailable");
        return [];
      },
      providers: async () => {
        if (source === "providers" && failed) throw new Error("unavailable");
        return {};
      },
    });
    await view.ready();
    failed = true;
    const subscription =
      source === "providers" ? view.providerSubscriptions[0] : view.configSubscriptions[0];
    await act(async () => subscription.events.enqueue());
    await waitFor(() => expect(view.result.current.settingsError).not.toBeNull());
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.settings).toBeNull();
    failed = false;
    await act(async () => subscription.events.enqueue());
    await waitFor(() => expect(view.result.current.settings).not.toBeNull());
    expect(view.result.current.settingsError).toBeNull();
    await act(async () => subscription.fail(new Error("disconnected")));
    await waitFor(() => expect(view.result.current.settings).toBeNull());
    expect(view.result.current.settingsError).not.toBeNull();
    expect(view.result.current.error).toBeNull();
  }
);

test.each(["workspace", "connection"])(
  "replacing the %s cancels old settings subscriptions and ignores pending snapshots",
  async (scope) => {
    let resolve!: (config: SettingsData["config"]) => void;
    let first = true;
    const current: SettingsData["config"] = { agentAiDefaults: {}, routePriority: ["coder"] };
    const view = fixture(undefined, {
      config: () => {
        if (!first) return Promise.resolve(current);
        first = false;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    await waitFor(() => expect(view.settingsRequests.length).toBeGreaterThan(0));
    const signal = scope === "connection" ? new AbortController().signal : view.lifetime.signal;
    view.rerender({ workspaceId: scope === "workspace" ? "other" : "workspace", signal });
    await waitFor(() => expect(view.result.current.settings?.config).toEqual(current));
    expect(view.configSubscriptions[0].signal.aborted).toBe(true);
    expect(view.providerSubscriptions[0].signal.aborted).toBe(true);
    await act(async () => resolve({ agentAiDefaults: {} }));
    expect(view.result.current.settings?.config).toEqual(current);
  }
);

const anchor = { messageId: "10", historySequence: 10, oldestHistorySequence: 9 };

test.each(["since", "full"] as const)(
  "a dropped conversation resumes from the server cursor and reconciles a %s replay atomically",
  async (replay) => {
    const view = fixture();
    await waitFor(() => expect(view.chatInputs).toHaveLength(1));
    await view.emit(message(9, "older"));
    await view.emit(message(10, "anchor"));
    await view.emit(displayStart);
    await view.emit({ type: "caught-up", hasOlderHistory: true, cursor: { history: anchor } });
    await waitFor(() => expect(view.result.current.transcript.caughtUp).toBe(true));
    expect(view.result.current.transcript.streaming).toBe(true);
    await view.disconnect();
    // The transcript stays on screen, read-only, while the suffix is re-synced.
    expect(view.result.current.transcript.caughtUp).toBe(false);
    expect(view.result.current.transcript.messages.map((row) => row.id)).toEqual([
      "9",
      "10",
      "live",
    ]);
    act(() => wakeStreams());
    await waitFor(() => expect(view.chatInputs).toHaveLength(2));
    expect(view.chatInputs[1]).toEqual({
      workspaceId: "workspace",
      mode: { type: "since", cursor: { history: anchor } },
    });
    expect(view.chatRequests[0].aborted).toBe(true);
    // Replayed rows are buffered: nothing changes until caught-up arrives.
    await view.emit(message(10, "anchor rewritten"));
    await view.emit({ ...message(11, "finished while offline"), id: "live" });
    if (replay === "full") await view.emit(message(8, "row the client never had"));
    expect(view.result.current.transcript.messages.map((row) => row.parts[0])).toEqual([
      { type: "text", text: "older" },
      { type: "text", text: "anchor" },
    ]);
    expect(view.result.current.transcript.messages[2].metadata?.partial).toBe(true);
    await view.emit(
      replay === "since"
        ? {
            type: "caught-up",
            replay: "since",
            cursor: { history: { ...anchor, historySequence: 11, messageId: "live" } },
          }
        : {
            type: "caught-up",
            replay: "full",
            downgradeReason: "oldest-mismatch",
            hasOlderHistory: false,
          }
    );
    const { transcript } = view.result.current;
    expect(transcript.caughtUp).toBe(true);
    expect(transcript.streaming).toBe(false);
    expect(transcript.messages.map((row) => [row.id, row.parts[0]])).toEqual(
      replay === "since"
        ? [
            ["9", { type: "text", text: "older" }],
            ["10", { type: "text", text: "anchor rewritten" }],
            ["live", { type: "text", text: "finished while offline" }],
          ]
        : [
            ["8", { type: "text", text: "row the client never had" }],
            ["10", { type: "text", text: "anchor rewritten" }],
            ["live", { type: "text", text: "finished while offline" }],
          ]
    );
    // A since replay keeps the pagination the client already knows; a full one is authoritative.
    expect(transcript.hasOlderHistory).toBe(replay === "since");
    expect(view.result.current.error).toBeNull();
  }
);

test("without a server cursor a dropped conversation replays in full from an empty transcript", async () => {
  const view = fixture();
  await view.ready();
  await view.disconnect();
  act(() => wakeStreams());
  await waitFor(() => expect(view.chatInputs).toHaveLength(2));
  expect(view.chatInputs[1]).toEqual({ workspaceId: "workspace", mode: { type: "full" } });
  expect(view.result.current.transcript.messages).toEqual([]);
  await view.emit(message(12, "fresh"));
  expect(view.result.current.transcript.messages.map((row) => row.id)).toEqual(["12"]);
});
