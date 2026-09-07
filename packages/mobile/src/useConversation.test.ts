import "./testDom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import type { MobileClient } from "./api";
import type { WorkspaceChatMessage } from "./transcript";
import { useConversation } from "./useConversation";
import type { RestoredInput } from "./draft";
import type { SettingsData } from "./settings";

afterEach(cleanup);

function message(sequence: number, text = `message ${sequence}`): WorkspaceChatMessage {
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
          return [];
        case "workspace.onChat":
          chatRequests.push(options.signal!);
          return new ReadableStream<WorkspaceChatMessage>({
            start(controller) {
              eventController = controller;
              options.signal?.addEventListener("abort", () => controller.close(), { once: true });
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
    async emit(event: WorkspaceChatMessage, afterEnqueue?: () => void) {
      await act(async () => {
        eventController.enqueue(event);
        afterEnqueue?.();
      });
    },
  };
}

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

test("older history is inserted without replacing newer copies and uses the oldest visible row", async () => {
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
  expect(view.settingsOrder.slice(0, 4)).toEqual([
    "config.subscribe",
    "providers.subscribe",
    "config.listen",
    "providers.listen",
  ]);
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

test.each(["config", "providers"] as const)(
  "a failed %s refresh blocks settings until a later notification recovers",
  async (source) => {
    let failed = false;
    const view = fixture(undefined, {
      config: async () => {
        if (source === "config" && failed) throw new Error("unavailable");
        return { agentAiDefaults: {} };
      },
      providers: async () => {
        if (source === "providers" && failed) throw new Error("unavailable");
        return {};
      },
    });
    await view.ready();
    failed = true;
    const subscription =
      source === "config" ? view.configSubscriptions[0] : view.providerSubscriptions[0];
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
