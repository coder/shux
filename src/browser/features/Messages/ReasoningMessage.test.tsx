import * as RealMarkdownCore from "./MarkdownCore";
import * as RealSmoothStreaming from "@/browser/hooks/useSmoothStreamingText";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReasoningMessage } from "./ReasoningMessage";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";
import { installDom } from "../../../../tests/ui/dom";
import type { DisplayedMessage } from "@/common/types/message";
import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { MessageListProvider } from "./MessageListContext";
import type { AutoExpandPrefs } from "./useStickyExpand";

// Streaming reasoning uses TypewriterMarkdown → useSmoothStreamingText, which drives
// a RAF loop. happy-dom doesn't ship requestAnimationFrame, and we only care about
// the reasoning collapse/transition behavior here, so stub the smooth engine out.
// Scope module mocks to each test so renderer assertions use the real pipeline.
const realModules: Array<[string, Record<string, unknown>]> = [
  ["./MarkdownCore", { ...RealMarkdownCore }],
  ["@/browser/hooks/useSmoothStreamingText", { ...RealSmoothStreaming }],
];

async function installModuleMocks() {
  await mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
    useSmoothStreamingText: (options: UseSmoothStreamingTextOptions) => ({
      visibleText: options.fullText,
      isCaughtUp: !options.isStreaming,
    }),
  }));

  // Streamdown's async markdown pipeline is heavy and not what we're testing here —
  // the layout-stability contract is independent of how the inner content is rendered.
  // A stand-in MarkdownCore keeps the text queryable and render times bounded.
  await mock.module("./MarkdownCore", () => ({
    MarkdownCore: (props: { content: string }) => (
      <div data-testid="markdown-core-stub">{props.content}</div>
    ),
  }));
}

async function restoreModuleMocks() {
  for (const [path, exports] of realModules) await mock.module(path, () => exports);
}

function createReasoningMessage(
  content: string,
  overrides?: Partial<DisplayedMessage & { type: "reasoning" }>
): DisplayedMessage & { type: "reasoning" } {
  return {
    type: "reasoning",
    id: "reasoning-1",
    historyId: "history-1",
    content,
    historySequence: 1,
    isStreaming: false,
    isPartial: false,
    isLastPartOfMessage: true,
    ...overrides,
  };
}

function makeWrapper(workspaceId: string) {
  return function Wrapper(props: { children: React.ReactNode }) {
    return (
      <MessageListProvider value={{ workspaceId, latestMessageId: null }}>
        {props.children}
      </MessageListProvider>
    );
  };
}

describe("ReasoningMessage", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(async () => {
    await installModuleMocks();
    cleanupDom = installDom();
  });

  afterEach(async () => {
    cleanup();
    await restoreModuleMocks();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("expands completed multi-line reasoning when header is clicked", () => {
    const message = createReasoningMessage("Summary line\nSecond line details");

    const { getByText, queryByText } = render(<ReasoningMessage message={message} />);

    // Collapsed reasoning should not render full markdown until expanded.
    expect(queryByText(/Second line details/)).toBeNull();

    fireEvent.click(getByText("Summary line"));

    expect(getByText(/Second line details/)).toBeDefined();
  });

  test("renders leading markdown-bold summary text as bold", () => {
    const message = createReasoningMessage("**Collecting context**\nSecond line details");

    const { container } = render(<ReasoningMessage message={message} />);

    const strongSummary = container.querySelector("strong");
    expect(strongSummary).not.toBeNull();
    expect(strongSummary?.textContent).toBe("Collecting context");
  });

  // The reasoning content container is the single <div> with these characteristic
  // font + opacity classes; the header icon's aria-hidden is on an SVG, so we
  // specifically target the text container.
  function getReasoningContentContainer(container: HTMLElement): HTMLDivElement | null {
    return (
      Array.from(container.querySelectorAll("div")).find((el) =>
        el.className.includes("italic opacity-85")
      ) ?? null
    );
  }

  test("quiet default: a streaming multi-line block starts collapsed", () => {
    // No preference set → new thinking stays collapsed even while streaming, instead
    // of the old expand-while-streaming-then-auto-collapse behavior (which mutated a
    // present block and caused a visible height tear).
    const streamingMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} />);

    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("true");
  });

  test("shows only one ellipsis for collapsed streaming reasoning", () => {
    const streamingMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} />);

    // The accessible activity label omits its own dots while the separate
    // collapsed-content marker supplies the one visible ellipsis.
    expect(view.container.querySelector(".shimmer-text-base")?.textContent).toBe("Thinking");
    expect(view.getByTestId("reasoning-ellipsis").textContent).toBe("...");
    expect(view.container.querySelector(".shimmer-text-sweep")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  test("does not auto-collapse on stream completion (keeps the mounted expand state)", () => {
    // The streaming→settled transition must not mutate the block: the deleted
    // auto-collapse effect was the source of the mid-turn height tear. With the
    // 'thinking' preference expanded, the block mounts expanded and stays expanded
    // across completion.
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { thinking: true });
    const streamingMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} workspaceId="ws-1" />, {
      wrapper: makeWrapper("ws-1"),
    });
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");

    const settledMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: false,
      isLastPartOfMessage: true,
    });
    view.rerender(<ReasoningMessage message={settledMessage} workspaceId="ws-1" />);

    // Still expanded — no auto-collapse.
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");
  });

  test("inherits the workspace 'thinking' preference at mount", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { thinking: true });
    const message = createReasoningMessage("Summary line\nSecond line details");

    const view = render(<ReasoningMessage message={message} workspaceId="ws-1" />, {
      wrapper: makeWrapper("ws-1"),
    });

    // Mounts expanded because the workspace preference says thinking=expanded.
    expect(view.getByText(/Second line details/)).toBeDefined();
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");
  });

  test("an expanded streaming block keeps its content height uncontrolled (no clipping)", () => {
    // While streaming AND expanded, height stays uncontrolled so async markdown
    // growth (Shiki/Mermaid) isn't clipped by a stale measured height or a collapse
    // transition. (A collapsed streaming block instead gets height:0 — see the quiet
    // default test above.)
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { thinking: true });
    const streamingMessage = createReasoningMessage("Summary\nBody", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} workspaceId="ws-1" />, {
      wrapper: makeWrapper("ws-1"),
    });

    const contentContainer = getReasoningContentContainer(view.container);
    expect(contentContainer).toBeDefined();
    expect(contentContainer?.getAttribute("aria-hidden")).toBe("false");
    expect(contentContainer?.className).not.toMatch(/\boverflow-hidden\b/);
  });
});
