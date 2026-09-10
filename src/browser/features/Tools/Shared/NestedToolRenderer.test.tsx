import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { APIContext } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { NestedToolRenderer } from "./NestedToolRenderer";

// BashToolCall requires the background-bash actions context; expanded generic
// cards highlight JSON, which requires the theme context.
function Providers(props: { children: ReactNode }) {
  return (
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>
        <BackgroundBashProvider workspaceId="ws-test">{props.children}</BackgroundBashProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  delete (globalThis as { window?: Window }).window;
  delete (globalThis as { document?: Document }).document;
});

describe("NestedToolRenderer", () => {
  test("renders hook output for nested tool results", () => {
    const { getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "echo hook" }}
          output={{ success: true, hook_output: "post hook ran", hook_duration_ms: 42 }}
          status="completed"
        />
      </Providers>
    );

    expect(getByText("hook output")).toBeDefined();
  });

  test("reload-reconstructed kernel calls (no output) render no duration or exit-code detail", () => {
    const { queryByText, getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={undefined}
          status="completed"
        />
      </Providers>
    );

    // Without a result there is no wall_duration_ms/exitCode: the card must
    // not render "took —" or an empty exit-code pill.
    expect(getByText(/timeout: 60s/)).toBeDefined();
    expect(queryByText(/took/)).toBeNull();
    expect(queryByText(/—/)).toBeNull();
  });

  test("real tool outputs matching the old synthetic summary shape are preserved", () => {
    const { getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="my_custom_tool"
          input={{ q: 1 }}
          output={{ suppressed: true, ok: true, bytes: 12345 }}
          status="completed"
        />
      </Providers>
    );

    // {suppressed, ok, bytes} from an actual tool is ordinary output and must
    // not be stripped as a reconstruction stand-in: the generic card still
    // shows a Result section for it.
    fireEvent.click(getByText("my_custom_tool"));
    expect(getByText("Result")).toBeDefined();
  });

  test("reconstructed failure shape skips missing duration/exit-code fields", () => {
    const { queryByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={{ success: false, error: "boom" }}
          status="failed"
        />
      </Providers>
    );

    expect(queryByText(/took/)).toBeNull();
    expect(queryByText(/—/)).toBeNull();
  });

  test("full bash results keep the duration and exit-code badge", () => {
    const { getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={{ success: true, output: "a", exitCode: 0, wall_duration_ms: 1500 }}
          status="completed"
        />
      </Providers>
    );

    expect(getByText(/took 2s/)).toBeDefined();
    expect(getByText("0")).toBeDefined();
  });

  test("passes workspace identity to nested workflow components", async () => {
    const iterator: AsyncIterableIterator<never> = {
      next: () => new Promise(() => undefined),
      return: () => Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const subscribe = mock((_input: { workspaceId: string }, _options: { signal: AbortSignal }) =>
      Promise.resolve(iterator)
    );
    const getRun = mock(() => Promise.resolve(null));
    const client = { workflows: { subscribe, getRun } };

    render(
      <APIContext.Provider
        value={{
          status: "connected",
          api: client as never,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <Providers>
          <NestedToolRenderer
            toolName="workflow_run"
            input={{ script_path: "skill://research/workflow.js", run_in_background: true }}
            output={{ status: "running", runId: "wfr_nested", result: null }}
            status="executing"
            workspaceId="ws-nested"
            toolCallId="nested-tool-call"
          />
        </Providers>
      </APIContext.Provider>
    );

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    expect(subscribe.mock.calls[0]?.[0]).toEqual({ workspaceId: "ws-nested" });
    expect(subscribe.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
});
