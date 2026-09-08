import { markdownUpdates } from "./streamingTestProfiler";
import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import type { MobileClient } from "../api";
import type { WorkspaceChatMessage } from "../transcript";
import { ConversationScreen } from "./ConversationScreen";
import { createDisplayTestClock } from "../displayTestClock";
import { EMPTY_DRAFT } from "../draft";
afterEach(cleanup);

test("120 separately delivered deltas render Markdown once per display flush while input and Stop remain immediate", async () => {
  using clock = createDisplayTestClock();
  let stream!: ReadableStreamDefaultController<WorkspaceChatMessage>;
  let interruptions = 0;
  const client = createORPCClient<MobileClient>({
    call: async (path, _input, options) => {
      switch (path.join(".")) {
        case "config.getConfig":
          return { agentAiDefaults: {}, defaultModel: "anthropic:claude-sonnet-4-5" };
        case "providers.getConfig":
          return { anthropic: { isConfigured: true, isEnabled: true, apiKeySet: true } };
        case "agents.list":
          return [{ id: "exec", name: "Exec", uiSelectable: true }];
        case "policy.get":
          return { source: "none", status: { state: "disabled" }, policy: null };
        case "server.onChanged":
          return new ReadableStream<never>({
            start(controller) {
              options.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }).values();
        case "workspace.onChat":
          return new ReadableStream<WorkspaceChatMessage>({
            start(controller) {
              stream = controller;
              options.signal?.addEventListener("abort", () => controller.close(), { once: true });
              controller.enqueue({
                type: "stream-start",
                workspaceId: "w",
                messageId: "live",
                historySequence: 1,
                startTime: 1,
                model: "anthropic:claude-sonnet-4-5",
              });
              controller.enqueue({ type: "caught-up" });
            },
          }).values();
        case "workspace.interruptStream":
          interruptions++;
          stream.enqueue({
            type: "stream-abort",
            workspaceId: "w",
            messageId: "live",
            abortReason: "user",
          });
          return { success: true };
        default:
          throw new Error(`Unexpected ${path.join(".")}`);
      }
    },
  });
  const lifetime = new AbortController();
  function Screen() {
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    return (
      <ConversationScreen
        client={client}
        workspace={{
          id: "w",
          name: "work",
          projectName: "project",
          projectPath: "/project",
          namedWorkspacePath: "/project/work",
          runtimeConfig: { type: "local" },
        }}
        serverLabel="test"
        signal={lifetime.signal}
        connected
        onReconnect={async () => {}}
        onBack={() => {}}
        onSettings={() => {}}
        onChanges={() => {}}
        selection={null}
        onSelectionChange={() => {}}
        draft={draft}
        onDraftChange={setDraft}
      />
    );
  }
  const view = render(<Screen />);
  await view.findByRole("button", { name: "Interrupt agent" });
  const seed = "An existing paragraph. ".repeat(200);
  const emit = (delta: string) =>
    act(async () =>
      stream.enqueue({
        type: "stream-delta",
        workspaceId: "w",
        messageId: "live",
        delta,
        tokens: 1,
        timestamp: 2,
      })
    );
  await emit(seed);
  act(() => clock.flush());
  const before = markdownUpdates.count;
  for (let index = 0; index < 120; index++) await emit("x");
  expect(markdownUpdates.count - before).toBeLessThanOrEqual(1);
  expect(clock.pending).toBe(1);
  act(() => clock.flush());
  expect(markdownUpdates.count - before).toBe(1);
  expect(view.getByText(seed + "x".repeat(120))).toBeDefined();
  await emit("stop-tail");
  fireEvent.change(view.getByLabelText("Message"), { target: { value: "Responsive draft" } });
  expect(view.getByLabelText("Message")).toHaveProperty("value", "Responsive draft");
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Interrupt agent" })));
  expect(interruptions).toBe(1);
  expect(clock.pending).toBe(0);
  expect(view.getByText(seed + "x".repeat(120) + "stop-tail")).toBeDefined();
  expect(view.queryByRole("button", { name: "Interrupt agent" })).toBeNull();
  expect(view.getByLabelText("Message")).toHaveProperty("value", "Responsive draft");
});
