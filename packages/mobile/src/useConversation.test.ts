import "./testDom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import type { MobileClient } from "./api";
import type { WorkspaceChatMessage } from "./transcript";
import { useConversation } from "./useConversation";

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

function fixture(getPolicy: () => Promise<Policy> = async () => disabledPolicy) {
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
        case "config.getConfig":
          return { agentAiDefaults: {} };
        case "providers.getConfig":
          return {};
        case "agents.list":
          return [];
        case "workspace.onChat":
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
  const view = renderHook(
    ({ workspaceId }) => useConversation(client, workspaceId, lifetime.signal),
    { initialProps: { workspaceId: "workspace" } }
  );
  return {
    ...view,
    complete,
    requests,
    policyRequests,
    policySubscriptions,
    lifetime,
    async ready() {
      await waitFor(() => expect(eventController).toBeDefined());
      await act(async () => {
        eventController.enqueue(message(10, "current"));
        eventController.enqueue({ type: "caught-up", hasOlderHistory: true });
      });
      await waitFor(() => expect(view.result.current.transcript.caughtUp).toBe(true));
    },
    async emit(event: WorkspaceChatMessage) {
      await act(async () => eventController.enqueue(event));
    },
  };
}

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
  view.rerender({ workspaceId: "other" });
  await waitFor(() => expect(view.result.current.settings?.policy).toEqual(blocked));
  expect(view.policySubscriptions).toHaveLength(2);
  expect(view.policySubscriptions[0].signal.aborted).toBe(true);
  expect(view.policyRequests[0].aborted).toBe(true);
  await act(async () => resolve(disabledPolicy));
  expect(view.result.current.settings?.policy).toEqual(blocked);
  expect(view.policySubscriptions[1].signal.aborted).toBe(false);
});
