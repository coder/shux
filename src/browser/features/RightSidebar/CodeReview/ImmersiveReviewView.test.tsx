import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useEffect, useState, type ComponentProps } from "react";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { DiffHunk, Review } from "@/common/types/review";

interface MockApiClient {
  workspace: {
    executeBash: (...args: unknown[]) => Promise<{
      success: true;
      data: {
        success: boolean;
        output: string;
        exitCode: number;
        truncated?: { reason: string; totalLines: number };
      };
    }>;
  };
}

let mockApi: MockApiClient;
let clipboardWrites: string[] = [];

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/utils/clipboard", () => ({
  copyToClipboard: (text: string) => {
    clipboardWrites.push(text);
    return Promise.resolve();
  },
}));

import { ImmersiveReviewView, shouldPreserveImmersiveContextCursor } from "./ImmersiveReviewView";

function createHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: "hunk-1",
    filePath: "src/example.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: "@@ -1 +1 @@",
    content: "-old line\n+new line",
    ...overrides,
  };
}

function createFileTree(filePath: string): FileTreeNode {
  return createFileTreeForPaths([filePath]);
}

function createFileTreeForPaths(filePaths: string[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const isLastSegment = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let next = current.children.find((child) => child.path === path);
      if (!next) {
        next = {
          name: segment,
          path,
          isDirectory: !isLastSegment,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  return root;
}

function encodeFileReadOutput(content: string): string {
  return `${Buffer.byteLength(content, "utf8")}\n${Buffer.from(content, "utf8").toString("base64")}`;
}

function renderImmersiveReview(
  overrides: Partial<ComponentProps<typeof ImmersiveReviewView>> = {}
) {
  const hunk = createHunk();

  return render(
    <ThemeProvider forcedTheme="dark">
      <ImmersiveReviewView
        workspaceId="workspace-1"
        fileTree={createFileTree(hunk.filePath)}
        hunks={[hunk]}
        allHunks={[hunk]}
        isRead={() => false}
        onToggleRead={mock(() => undefined)}
        onMarkFileAsRead={mock(() => undefined)}
        selectedHunkId={hunk.id}
        onSelectHunk={mock(() => undefined)}
        onExit={mock(() => undefined)}
        isTouchImmersive={true}
        reviewsByFilePath={new Map()}
        firstSeenMap={{}}
        {...overrides}
      />
    </ThemeProvider>
  );
}

describe("ImmersiveReviewView", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  let originalHTMLElement: typeof globalThis.HTMLElement;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalHTMLElement = globalThis.HTMLElement;

    const dom = new GlobalWindow({ url: "http://localhost" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.navigator = dom.navigator as unknown as Navigator;
    // Keyboard handlers guard with `target instanceof HTMLElement`; expose the active
    // dom's constructor so the guard sees this window's elements instead of throwing.
    globalThis.HTMLElement = dom.HTMLElement as unknown as typeof globalThis.HTMLElement;
    globalThis.requestAnimationFrame = dom.requestAnimationFrame.bind(
      dom
    ) as unknown as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = dom.cancelAnimationFrame.bind(
      dom
    ) as unknown as typeof globalThis.cancelAnimationFrame;

    globalThis.window.api = { platform: "linux", versions: {} };

    clipboardWrites = [];
    mockApi = {
      workspace: {
        executeBash: mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              success: true,
              output: "",
              exitCode: 0,
            },
          })
        ),
      },
    };
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.HTMLElement = originalHTMLElement;
  });

  test("only preserves context cursors while overlay content is unchanged", () => {
    const previousRange = { startIndex: 0, endIndex: 1 };

    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 2,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "compact overlay",
      })
    ).toBe(true);

    // Compact hunk overlays and hydrated full-file overlays use different
    // numeric row indices. Do not carry an out-of-hunk compact cursor across
    // hydration, or the reveal can replay a stale context/separator row.
    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 2,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "hydrated full-file overlay",
      })
    ).toBe(false);

    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 1,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "compact overlay",
      })
    ).toBe(false);
  });

  test("skips full-file reads when the selected hunk starts beyond the render budget", () => {
    const farHunk = createHunk({
      id: "hunk-far",
      oldStart: 5000,
      newStart: 5000,
      header: "@@ -5000 +5000 @@",
      content: "-old far line\n+new far line",
    });

    const view = renderImmersiveReview({
      fileTree: createFileTree(farHunk.filePath),
      hunks: [farHunk],
      allHunks: [farHunk],
      selectedHunkId: farHunk.id,
    });

    expect(view.container.textContent ?? "").toContain("new far line");
    expect(mockApi.workspace.executeBash).not.toHaveBeenCalled();
  });

  test("shows the assisted-mode badge only while the Assisted filter is active", () => {
    // Off by default: the badge must not appear when not filtering.
    const off = renderImmersiveReview();
    expect(off.queryByTestId("immersive-assisted-mode-badge")).toBeNull();
    cleanup();

    // On: the header surfaces the badge with the unread/total counts so the
    // active filter mode is visible even though the control bar is hidden
    // behind the immersive overlay.
    const on = renderImmersiveReview({
      assistedOnly: true,
      assistedCount: 3,
      assistedUnreadCount: 2,
    });
    const badge = on.getByTestId("immersive-assisted-mode-badge");
    expect(badge.textContent ?? "").toContain("Assisted");
    expect(badge.textContent ?? "").toContain("2/3");
  });

  test("guest Escape and Tab cannot exit or change host immersive review", () => {
    const onExit = mock(() => undefined);
    const view = renderImmersiveReview({ isTouchImmersive: false, onExit });
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    for (const key of ["Escape", "Tab"]) {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fireEvent(canvas, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("reserves the assisted banner slot while iterating through hunks in one file", () => {
    const assistedHunk = createHunk({
      id: "hunk-assisted",
      filePath: "src/example.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old assisted\n+new assisted",
    });
    const regularHunk = createHunk({
      id: "hunk-regular",
      filePath: assistedHunk.filePath,
      oldStart: 12,
      oldLines: 1,
      newStart: 12,
      newLines: 1,
      header: "@@ -12 +12 @@",
      content: "-old regular\n+new regular",
    });
    const hunks = [assistedHunk, regularHunk];
    const assistedComment = "Inspect this change\nThe full rationale should remain available.";
    const assistedHunkIds = new Set([assistedHunk.id]);
    const assistedCommentByHunkId = new Map([[assistedHunk.id, assistedComment]]);

    const renderView = (selectedHunkId: string, visibleHunks: DiffHunk[] = hunks) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTree(assistedHunk.filePath)}
          hunks={visibleHunks}
          allHunks={hunks}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={mock(() => undefined)}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
          assistedHunkIds={assistedHunkIds}
          assistedCommentByHunkId={assistedCommentByHunkId}
        />
      </ThemeProvider>
    );

    const view = render(renderView(assistedHunk.id));

    expect(view.container.querySelector('[data-assisted-banner-slot="true"]')).toBeTruthy();
    const banner = view.getByTestId("immersive-assisted-banner");
    expect(banner.textContent ?? "").toContain("Inspect this change");
    expect(banner.getAttribute("title")).toBe(assistedComment);

    view.rerender(renderView(regularHunk.id));

    // The fixed slot remains mounted for same-file hunk iteration, but the
    // selected-hunk callout content disappears when the plain hunk is selected.
    expect(view.getByTestId("immersive-assisted-banner-slot")).toBeTruthy();
    expect(view.queryByTestId("immersive-assisted-banner")).toBeNull();

    // Filters can hide the assisted hunk while the file remains active; reserve
    // from allHunks so hide-read/search does not collapse the layout mid-file.
    view.rerender(renderView(regularHunk.id, [regularHunk]));
    expect(view.getByTestId("immersive-assisted-banner-slot")).toBeTruthy();
    expect(view.queryByTestId("immersive-assisted-banner")).toBeNull();
  });

  test("normalizes CRLF hunk rows in compact overlays", () => {
    const crlfHunk = createHunk({
      id: "hunk-crlf",
      oldStart: 5000,
      newStart: 5000,
      header: "@@ -5000 +5000 @@",
      content: "-old crlf\r\n+new crlf\r\n context crlf\r",
    });

    const view = renderImmersiveReview({
      fileTree: createFileTree(crlfHunk.filePath),
      hunks: [crlfHunk],
      allHunks: [crlfHunk],
      selectedHunkId: crlfHunk.id,
    });

    expect(view.container.textContent ?? "").toContain("new crlf");
    expect(view.container.textContent ?? "").not.toContain("\r");
  });

  test("defers the compact diff renderer while full-file context is pending", async () => {
    type ExecuteBashResult = Awaited<ReturnType<MockApiClient["workspace"]["executeBash"]>>;
    let resolveRead: (result: ExecuteBashResult) => void = () => {
      throw new Error("executeBash was not called");
    };
    mockApi.workspace.executeBash = mock(
      () =>
        new Promise<ExecuteBashResult>((resolve) => {
          resolveRead = resolve;
        })
    );

    const view = renderImmersiveReview();

    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("immersive-diff-reveal-skeleton")).toBeTruthy();
    // Full-file hydration is the expected end state for this hunk, so do not spend
    // a hidden render/highlight pass on the compact hunk rows that would be thrown away.
    expect(view.container.textContent ?? "").not.toContain("new line");

    resolveRead({
      success: true as const,
      data: {
        success: true,
        output: encodeFileReadOutput("new line\ncontext after selected hunk\n"),
        exitCode: 0,
      },
    });

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("context after selected hunk")
    );
  });

  test("keeps same-file hunk-set changes instant without re-reading or re-covering", async () => {
    // Two in-budget hunks in one file. After the file hydrates, marking a hunk read while
    // read hunks are hidden removes it from the visible set and rebuilds the overlay. That
    // rebuild must stay an in-memory, instant operation: no second file read (the body is
    // cached per file path) and no loading cover (the file is already on screen).
    const hunkA = createHunk({
      id: "hunk-a",
      newStart: 5,
      newLines: 1,
      header: "@@ -5 +5 @@",
      content: "-old a\n+new a",
    });
    const hunkB = createHunk({
      id: "hunk-b",
      newStart: 10,
      newLines: 1,
      header: "@@ -10 +10 @@",
      content: "-old b\n+new b",
    });

    const fileBody = `${Array.from({ length: 20 }, (_, index) => `file line ${index + 1}`).join(
      "\n"
    )}\n`;
    let readCount = 0;
    mockApi.workspace.executeBash = mock(() => {
      readCount += 1;
      return Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(fileBody), exitCode: 0 },
      });
    });

    const renderView = (hunks: DiffHunk[], selectedHunkId: string) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTree(hunkA.filePath)}
          hunks={hunks}
          allHunks={[hunkA, hunkB]}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={mock(() => undefined)}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
        />
      </ThemeProvider>
    );

    const view = render(renderView([hunkA, hunkB], hunkA.id));

    // Full-file context hydrates and the loading cover clears (file is on screen).
    await waitFor(() => expect(view.container.textContent ?? "").toContain("file line 12"));
    await waitFor(() => expect(view.queryByTestId("immersive-diff-reveal-overlay")).toBeNull());
    const readsAfterHydration = readCount;
    expect(readsAfterHydration).toBeGreaterThanOrEqual(1);

    // Mark hunk A read (hidden): the visible hunk set shrinks to [hunkB] in the same file.
    view.rerender(renderView([hunkB], hunkB.id));

    // Give any (incorrect) re-read / re-cover a chance to appear before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readCount).toBe(readsAfterHydration);
    expect(view.queryByTestId("immersive-diff-reveal-overlay")).toBeNull();
    expect(view.queryByTestId("immersive-diff-reveal-skeleton")).toBeNull();
    expect(view.container.textContent ?? "").toContain("file line 12");
  });

  test("re-reads the full-file body when the file's diff content changes", async () => {
    const baseHunk = createHunk({
      id: "hunk-a",
      newStart: 5,
      newLines: 1,
      header: "@@ -5 +5 @@",
      content: "-old a\n+new a v1",
    });
    // Same id (hash of path + line ranges) but different content, as if a tool edited the
    // file in place and the diff was re-fetched. Content -- not the id -- must invalidate
    // the cached full-file body so reviewers never see stale surrounding lines.
    const editedHunk = createHunk({
      id: "hunk-a",
      newStart: 5,
      newLines: 1,
      header: "@@ -5 +5 @@",
      content: "-old a\n+new a v2",
    });

    const fileBody = `${Array.from({ length: 20 }, (_, index) => `file line ${index + 1}`).join(
      "\n"
    )}\n`;
    let readCount = 0;
    mockApi.workspace.executeBash = mock(() => {
      readCount += 1;
      return Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(fileBody), exitCode: 0 },
      });
    });

    const renderView = (hunk: DiffHunk) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTree(baseHunk.filePath)}
          hunks={[hunk]}
          allHunks={[hunk]}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={hunk.id}
          onSelectHunk={mock(() => undefined)}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
        />
      </ThemeProvider>
    );

    const view = render(renderView(baseHunk));
    // Full-file context hydrates: a context-only line from the file body is visible.
    await waitFor(() => expect(view.container.textContent ?? "").toContain("file line 12"));
    const readsAfterFirstHydration = readCount;

    // The diff content changed in place. The cached body must be invalidated, and the stale
    // full-file context must NOT remain on screen while the new body re-reads -- settled
    // state is tracked by content version, so the overlay drops to the compact hunk (which
    // does not include the file-body context line) until the fresh body loads.
    view.rerender(renderView(editedHunk));
    expect(view.container.textContent ?? "").not.toContain("file line 12");
    await waitFor(() => expect(readCount).toBeGreaterThan(readsAfterFirstHydration));
    await waitFor(() => expect(view.container.textContent ?? "").toContain("file line 12"));
  });

  test("loads full-file context for an in-budget selected hunk even when another hunk is far away", async () => {
    const nearHunk = createHunk({
      id: "hunk-near",
      newStart: 40,
      newLines: 1,
      header: "@@ -40 +40 @@",
      content: "-old near line\n+new near line",
    });
    const farHunk = createHunk({
      id: "hunk-far",
      newStart: 5000,
      newLines: 1,
      header: "@@ -5000 +5000 @@",
      content: "-old far line\n+new far line",
    });

    renderImmersiveReview({
      fileTree: createFileTree(nearHunk.filePath),
      hunks: [nearHunk, farHunk],
      allHunks: [nearHunk, farHunk],
      selectedHunkId: nearHunk.id,
    });

    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));
  });

  test("accepts full-file context at the line budget when the file ends with a newline", async () => {
    const lineBudget = 1500;
    const fileContent = `${[
      "new line",
      "context after selected hunk",
      ...Array.from({ length: lineBudget - 2 }, (_, index) => `filler ${index}`),
    ].join("\n")}\n`;
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: true,
          output: encodeFileReadOutput(fileContent),
          exitCode: 0,
        },
      })
    );

    const view = renderImmersiveReview();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("context after selected hunk")
    );
  });

  test("retries full-file context after a transient read failure", async () => {
    const firstHunk = createHunk({ id: "hunk-first", filePath: "src/first.ts" });
    const secondHunk = createHunk({ id: "hunk-second", filePath: "src/second.ts" });
    const allHunks = [firstHunk, secondHunk];
    const fileTree = createFileTreeForPaths(allHunks.map((hunk) => hunk.filePath));
    const onSelectHunk = mock((_hunkId: string | null) => undefined);
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: false,
          output: "",
          exitCode: 1,
        },
      })
    );

    const renderView = (selectedHunkId: string) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={fileTree}
          hunks={allHunks}
          allHunks={allHunks}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={onSelectHunk}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
        />
      </ThemeProvider>
    );

    const view = render(renderView(firstHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));

    view.rerender(renderView(secondHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(2));

    view.rerender(renderView(firstHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(3));
  });

  test("weights completion by changed lines instead of hunk count", () => {
    const smallHunk = createHunk({
      id: "hunk-small",
      header: "@@ -1,0 +1,1 @@",
      oldLines: 0,
      newLines: 1,
      content: "+single added line",
    });
    const largeHunk = createHunk({
      id: "hunk-large",
      header: "@@ -3,0 +3,3 @@",
      oldLines: 0,
      newLines: 3,
      content: "+first added line\n+second added line\n+third added line",
    });
    const view = renderImmersiveReview({
      hunks: [smallHunk, largeHunk],
      allHunks: [smallHunk, largeHunk],
      selectedHunkId: smallHunk.id,
      isRead: (hunkId) => hunkId === largeHunk.id,
    });

    const progressBar = view.getByRole("progressbar", {
      name: "Review completion by changed lines",
    });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("75");
    expect(progressBar.getAttribute("aria-valuetext")).toContain("3/4");
  });

  test("shows a completion state when all hunks are reviewed and hidden", () => {
    const hunk = createHunk();
    const onExit = mock(() => undefined);
    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [hunk],
      isRead: (hunkId) => hunkId === hunk.id,
      selectedHunkId: null,
      onExit,
    });

    expect(view.getByTestId("immersive-review-complete")).toBeTruthy();
    expect(view.queryByText("No hunks for this file")).toBeNull();

    const progressBar = view.getByRole("progressbar", {
      name: "Review completion by changed lines",
    });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("100");

    fireEvent.click(view.getByRole("button", { name: "Return to chat" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("keeps the regular empty-file state when hunks are hidden for some other reason", () => {
    const hunk = createHunk();
    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [hunk],
      isRead: () => false,
      selectedHunkId: null,
    });

    expect(view.queryByTestId("immersive-review-complete")).toBeNull();
    expect(view.getByText("No hunks for this file")).toBeTruthy();
  });

  test("marking an unread hunk as read advances to the next hunk even when read hunks stay visible", async () => {
    const firstHunk = createHunk({
      id: "hunk-first",
      filePath: "src/example.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old first\n+new first",
    });
    const secondHunk = createHunk({
      id: "hunk-second",
      filePath: "src/example.ts",
      newStart: 3,
      newLines: 1,
      oldStart: 3,
      oldLines: 1,
      header: "@@ -3 +3 @@",
      content: "-old second\n+new second",
    });
    const onToggleRead = mock(() => undefined);

    const view = renderImmersiveReview({
      fileTree: createFileTree(firstHunk.filePath),
      hunks: [firstHunk, secondHunk],
      allHunks: [firstHunk, secondHunk],
      selectedHunkId: firstHunk.id,
      onToggleRead,
      isTouchImmersive: false,
    });

    expect(
      view.getByTestId("immersive-review-view").getAttribute("data-selected-hunk-position")
    ).toBe("1");

    const markReadButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mark hunk as read"]'
    );
    expect(markReadButton).toBeTruthy();
    fireEvent.click(markReadButton!);

    await waitFor(() =>
      expect(
        view.getByTestId("immersive-review-view").getAttribute("data-selected-hunk-position")
      ).toBe("2")
    );
    expect(onToggleRead).toHaveBeenCalledWith(firstHunk.id);
  });

  test("marking a locally navigated hunk as read ignores the parent selection echo", async () => {
    const firstHunk = createHunk({
      id: "hunk-first",
      filePath: "src/example.ts",
      newStart: 1,
      oldStart: 1,
      header: "@@ -1 +1 @@",
      content: "-old first\n+new first",
    });
    const secondHunk = createHunk({
      id: "hunk-second",
      filePath: "src/example.ts",
      newStart: 3,
      oldStart: 3,
      header: "@@ -3 +3 @@",
      content: "-old second\n+new second",
    });
    const thirdHunk = createHunk({
      id: "hunk-third",
      filePath: "src/example.ts",
      newStart: 5,
      oldStart: 5,
      header: "@@ -5 +5 @@",
      content: "-old third\n+new third",
    });
    const onToggleRead = mock(() => undefined);

    function ParentEchoHarness() {
      const [parentSelectedHunkId, setParentSelectedHunkId] = useState<string | null>(firstHunk.id);

      return (
        <ThemeProvider forcedTheme="dark">
          <ImmersiveReviewView
            workspaceId="workspace-1"
            fileTree={createFileTree(firstHunk.filePath)}
            hunks={[firstHunk, secondHunk, thirdHunk]}
            allHunks={[firstHunk, secondHunk, thirdHunk]}
            isRead={() => false}
            onToggleRead={onToggleRead}
            onMarkFileAsRead={mock(() => undefined)}
            selectedHunkId={parentSelectedHunkId}
            onSelectHunk={setParentSelectedHunkId}
            onExit={mock(() => undefined)}
            isTouchImmersive={false}
            reviewsByFilePath={new Map()}
            firstSeenMap={{}}
          />
        </ThemeProvider>
      );
    }

    const view = render(<ParentEchoHarness />);

    const findMarkReadButton = () =>
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Mark hunk as read"]');

    const firstMarkReadButton = findMarkReadButton();
    expect(firstMarkReadButton).toBeTruthy();
    fireEvent.click(firstMarkReadButton!);
    await waitFor(() =>
      expect(
        view.getByTestId("immersive-review-view").getAttribute("data-selected-hunk-position")
      ).toBe("2")
    );

    const secondMarkReadButton = findMarkReadButton();
    expect(secondMarkReadButton).toBeTruthy();
    fireEvent.click(secondMarkReadButton!);

    // The parent commits the just-read second hunk after the click. Keep the
    // immersive-local work queue on the third hunk instead of replaying that echo.
    await waitFor(() =>
      expect(
        view.getByTestId("immersive-review-view").getAttribute("data-selected-hunk-position")
      ).toBe("3")
    );
    expect(onToggleRead).toHaveBeenCalledWith(firstHunk.id);
    expect(onToggleRead).toHaveBeenCalledWith(secondHunk.id);
  });

  test("clicking a sidebar review selects its hunk even when hidden by the active filter", () => {
    // Repro for: clicking a pending review in the immersive sidebar should
    // jump back to the hunk the review was attached to. Previously, when
    // hide-read (or any other frontend filter) had removed the review's hunk
    // from the visible list, the navigation handler still computed the right
    // target hunk id from `allHunks` — but the parent panel reset the
    // selection on the next render because it validated against the filtered
    // hunks. Lock in the immersive contract by asserting the explicit target
    // hunk id propagates out of `onSelectHunk`.
    const visibleHunk = createHunk({
      id: "hunk-visible",
      filePath: "src/visible.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old visible\n+new visible",
    });
    const reviewedHunk = createHunk({
      id: "hunk-reviewed",
      filePath: "src/reviewed.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old reviewed\n+new reviewed",
    });
    const pendingReview: Review = {
      id: "review-1",
      data: {
        filePath: reviewedHunk.filePath,
        lineRange: "+1",
        selectedCode: "// sample",
        userNote: "Take another look here",
      },
      status: "pending",
      createdAt: 1000,
    };
    const reviewsByFilePath = new Map<string, Review[]>([[reviewedHunk.filePath, [pendingReview]]]);
    const onSelectHunk = mock((_hunkId: string | null) => undefined);

    const view = renderImmersiveReview({
      fileTree: createFileTreeForPaths([visibleHunk.filePath, reviewedHunk.filePath]),
      // visibleHunk is the only currently-visible hunk (hide-read or search has
      // removed reviewedHunk), but reviewedHunk still exists in the diff.
      hunks: [visibleHunk],
      allHunks: [visibleHunk, reviewedHunk],
      isRead: (hunkId) => hunkId === reviewedHunk.id,
      selectedHunkId: visibleHunk.id,
      onSelectHunk,
      reviewsByFilePath,
      isTouchImmersive: false,
    });

    const noteCard = view.container.querySelector<HTMLElement>('[data-note-index="0"]');
    expect(noteCard).toBeTruthy();

    onSelectHunk.mockClear();
    fireEvent.click(noteCard!);

    const selectedIds = onSelectHunk.mock.calls.map(([hunkId]) => hunkId);
    expect(selectedIds).toContain(reviewedHunk.id);
    // The view must not silently fall back to the first visible hunk.
    expect(selectedIds).not.toEqual([visibleHunk.id]);
  });

  test("parent panel keeps the explicit sidebar selection in immersive mode after click", () => {
    // End-to-end repro that mirrors how ReviewPanel hosts ImmersiveReviewView:
    // selectedHunkId lives in the parent and a useEffect re-validates it
    // whenever filtered hunks change. With the immersive-aware fix the parent
    // only resets when the hunk vanishes from the diff entirely, so clicking a
    // pending review for a hidden hunk keeps the immersive view on that hunk's
    // file (instead of bouncing back to the first visible hunk).
    const visibleHunk = createHunk({
      id: "hunk-visible",
      filePath: "src/visible.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old visible\n+new visible",
    });
    const reviewedHunk = createHunk({
      id: "hunk-reviewed",
      filePath: "src/reviewed.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old reviewed\n+new reviewed",
    });
    const pendingReview: Review = {
      id: "review-1",
      data: {
        filePath: reviewedHunk.filePath,
        lineRange: "+1",
        selectedCode: "// sample",
        userNote: "Take another look here",
      },
      status: "pending",
      createdAt: 1000,
    };
    const reviewsByFilePath = new Map<string, Review[]>([[reviewedHunk.filePath, [pendingReview]]]);

    const filteredHunks = [visibleHunk];
    const allHunks = [visibleHunk, reviewedHunk];

    function ParentPanelHarness() {
      const [selectedHunkId, setSelectedHunkId] = useState<string | null>(visibleHunk.id);

      // Mirrors ReviewPanel's selection-validity effect with the immersive
      // branch. Keep the explicit selection even when it's been hidden by an
      // active filter, since the immersive view supports rendering it from
      // `allHunks`. Switching `allHunks.some` back to `filteredHunks.some`
      // here reproduces the original bug and makes this test fail.
      useEffect(() => {
        if (filteredHunks.length === 0) return;
        const selectionExists =
          selectedHunkId && allHunks.some((hunk) => hunk.id === selectedHunkId);
        if (!selectionExists) {
          setSelectedHunkId(filteredHunks[0].id);
        }
      }, [selectedHunkId]);

      return (
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTreeForPaths([visibleHunk.filePath, reviewedHunk.filePath])}
          hunks={filteredHunks}
          allHunks={allHunks}
          isRead={(hunkId) => hunkId === reviewedHunk.id}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={setSelectedHunkId}
          onExit={mock(() => undefined)}
          isTouchImmersive={false}
          reviewsByFilePath={reviewsByFilePath}
          firstSeenMap={{}}
        />
      );
    }

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <ParentPanelHarness />
      </ThemeProvider>
    );

    // Sanity-check the initial state: we start on the visible hunk's file.
    expect(view.container.textContent ?? "").toContain(visibleHunk.filePath);

    const noteCard = view.container.querySelector<HTMLElement>('[data-note-index="0"]');
    expect(noteCard).toBeTruthy();
    fireEvent.click(noteCard!);

    // After the click the immersive header switches to the reviewed file —
    // the parent panel must NOT have reset the selection back to the first
    // visible hunk.
    expect(view.container.textContent ?? "").toContain(reviewedHunk.filePath);
  });

  test("copy button copies the entire on-disk file even when the display read is line-budgeted", async () => {
    const fullContent = `first line\n${Array.from({ length: 60 }, (_, i) => `line ${i + 2}`).join("\n")}\nlast line`;

    // The full-file display read carries an awk line budget; the copy read must not,
    // so it still yields the whole file when the display falls back to compact hunks.
    const copyReadCalls: Array<{ script: string; options?: { cwdMode?: string } }> = [];
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const input = args[0] as { script: string; options?: { cwdMode?: string } };
      if (input.script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      copyReadCalls.push(input);
      return Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(fullContent), exitCode: 0 },
      });
    });

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe(fullContent);
    // Single-project hunk paths are repo-root-relative, so the copy read must run
    // from the repo root (default mode would run from a subproject cwd).
    expect(copyReadCalls[0]?.options).toEqual({ cwdMode: "repo-root" });
  });

  test("pressing the copy-file key copies the file, but not while typing", async () => {
    const fullContent = "first line\nmiddle\nlast line";
    let executeBashCalls = 0;
    mockApi.workspace.executeBash = mock(() => {
      executeBashCalls += 1;
      return Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(fullContent), exitCode: 0 },
      });
    });

    const view = renderImmersiveReview({ isTouchImmersive: false });

    fireEvent.keyDown(globalThis.window as unknown as Element, { key: "y" });
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe(fullContent);

    // Typing "y" in an editable element must not trigger the copy. The guard is
    // synchronous, so the read-call count must not move.
    const callsAfterCopy = executeBashCalls;
    const input = document.createElement("input");
    view.container.appendChild(input);
    fireEvent.keyDown(input, { key: "y" });
    expect(executeBashCalls).toBe(callsAfterCopy);
    expect(clipboardWrites).toHaveLength(1);
  });

  test("discards a copy that completes after navigating to another file", async () => {
    const fileAHunk = createHunk({ id: "hunk-a", filePath: "src/a.ts" });
    const fileBHunk = createHunk({ id: "hunk-b", filePath: "src/b.ts" });

    let resolveRead: ((value: unknown) => void) | undefined;
    mockApi.workspace.executeBash = mock(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve as (value: unknown) => void;
        })
    ) as unknown as MockApiClient["workspace"]["executeBash"];

    function NavigationHarness() {
      const [selectedHunkId, setSelectedHunkId] = useState<string | null>(fileAHunk.id);
      return (
        <ThemeProvider forcedTheme="dark">
          <ImmersiveReviewView
            workspaceId="workspace-1"
            fileTree={createFileTreeForPaths([fileAHunk.filePath, fileBHunk.filePath])}
            hunks={[fileAHunk, fileBHunk]}
            allHunks={[fileAHunk, fileBHunk]}
            isRead={() => false}
            onToggleRead={mock(() => undefined)}
            onMarkFileAsRead={mock(() => undefined)}
            selectedHunkId={selectedHunkId}
            onSelectHunk={setSelectedHunkId}
            onExit={mock(() => undefined)}
            isTouchImmersive={true}
            reviewsByFilePath={new Map()}
            firstSeenMap={{}}
          />
        </ThemeProvider>
      );
    }

    const view = render(<NavigationHarness />);

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);
    await waitFor(() => expect(resolveRead).toBeTruthy());

    // Navigate to file B while the read for file A is still in flight.
    const nextFileButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next file"]'
    );
    expect(nextFileButton).toBeTruthy();
    fireEvent.click(nextFileButton!);
    await waitFor(() => expect(view.container.textContent ?? "").toContain("b.ts"));

    resolveRead!({
      success: true as const,
      data: { success: true, output: encodeFileReadOutput("file A contents"), exitCode: 0 },
    });

    // The stale completion must not reach the clipboard. The handler continuation
    // (including any would-be clipboard write) is a bounded microtask chain after the
    // resolved read, so drain microtasks deterministically instead of sleeping.
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
    expect(clipboardWrites).toHaveLength(0);
  });

  test("discards a copy when the file changes in place while the read is pending", async () => {
    const hunkV1 = createHunk({ content: "-old line\n+new line" });

    // Copy reads carry no awk line budget; overlay full-file reads do.
    const pendingReads: Array<(value: unknown) => void> = [];
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const { script } = args[0] as { script: string };
      if (script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      return new Promise((resolve) => {
        pendingReads.push(resolve as (value: unknown) => void);
      });
    }) as unknown as MockApiClient["workspace"]["executeBash"];

    function InPlaceEditHarness() {
      const [hunks, setHunks] = useState([hunkV1]);
      return (
        <ThemeProvider forcedTheme="dark">
          <button
            type="button"
            data-testid="edit-file"
            onClick={() => setHunks([createHunk({ content: "-old line\n+edited line" })])}
          >
            edit
          </button>
          <ImmersiveReviewView
            workspaceId="workspace-1"
            fileTree={createFileTree(hunkV1.filePath)}
            hunks={hunks}
            allHunks={hunks}
            isRead={() => false}
            onToggleRead={mock(() => undefined)}
            onMarkFileAsRead={mock(() => undefined)}
            selectedHunkId={hunkV1.id}
            onSelectHunk={mock(() => undefined)}
            onExit={mock(() => undefined)}
            isTouchImmersive={true}
            reviewsByFilePath={new Map()}
            firstSeenMap={{}}
          />
        </ThemeProvider>
      );
    }

    const view = render(<InPlaceEditHarness />);

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    // An edit changes the same file's diff content while the read is pending.
    fireEvent.click(view.getByTestId("edit-file"));

    pendingReads[0]({
      success: true as const,
      data: { success: true, output: encodeFileReadOutput("pre-edit contents"), exitCode: 0 },
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
    // The pre-edit payload must not reach the clipboard or report success.
    expect(clipboardWrites).toHaveLength(0);
    expect(
      view.container
        .querySelector('button[aria-label="Copy file contents"]')
        ?.getAttribute("data-copy-file-feedback")
    ).toBeNull();
  });

  test("discards a copy that completes after navigating away and back (ABA)", async () => {
    const fileAHunk = createHunk({ id: "hunk-a", filePath: "src/a.ts" });
    const fileBHunk = createHunk({ id: "hunk-b", filePath: "src/b.ts" });

    // Copy reads carry no awk line budget; overlay full-file reads do.
    const pendingReads: Array<(value: unknown) => void> = [];
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const { script } = args[0] as { script: string };
      if (script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      return new Promise((resolve) => {
        pendingReads.push(resolve as (value: unknown) => void);
      });
    }) as unknown as MockApiClient["workspace"]["executeBash"];

    function NavigationHarness() {
      const [selectedHunkId, setSelectedHunkId] = useState<string | null>(fileAHunk.id);
      return (
        <ThemeProvider forcedTheme="dark">
          <ImmersiveReviewView
            workspaceId="workspace-1"
            fileTree={createFileTreeForPaths([fileAHunk.filePath, fileBHunk.filePath])}
            hunks={[fileAHunk, fileBHunk]}
            allHunks={[fileAHunk, fileBHunk]}
            isRead={() => false}
            onToggleRead={mock(() => undefined)}
            onMarkFileAsRead={mock(() => undefined)}
            selectedHunkId={selectedHunkId}
            onSelectHunk={setSelectedHunkId}
            onExit={mock(() => undefined)}
            isTouchImmersive={true}
            reviewsByFilePath={new Map()}
            firstSeenMap={{}}
          />
        </ThemeProvider>
      );
    }

    const view = render(<NavigationHarness />);

    const clickCopy = () => {
      const button = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy file contents"]'
      );
      expect(button).toBeTruthy();
      fireEvent.click(button!);
    };
    const navigate = (label: "Next file" | "Previous file", expectText: string) => {
      const button = view.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`
      );
      expect(button).toBeTruthy();
      fireEvent.click(button!);
      return waitFor(() => expect(view.container.textContent ?? "").toContain(expectText));
    };

    clickCopy();
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    // A -> B -> A while the read for A is still pending.
    await navigate("Next file", "b.ts");
    await navigate("Previous file", "a.ts");

    // The stale read for A resolves after returning to A: it must be discarded even
    // though the active path matches again.
    pendingReads[0]({
      success: true as const,
      data: { success: true, output: encodeFileReadOutput("stale A contents"), exitCode: 0 },
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
    expect(clipboardWrites).toHaveLength(0);

    // Navigation freed the pending slot, so a replacement copy of A can start.
    clickCopy();
    await waitFor(() => expect(pendingReads).toHaveLength(2));
  });

  test("rejects truncated reads instead of copying a partial file", async () => {
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: true,
          output: encodeFileReadOutput("partial contents"),
          exitCode: 0,
          truncated: { reason: "too big", totalLines: 1 },
        },
      })
    );

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    // The rejection must be user-visible, not just a console log.
    await waitFor(() =>
      expect(
        view.container
          .querySelector('button[aria-label="Copy file contents"]')
          ?.getAttribute("data-copy-file-feedback")
      ).toBe("failed")
    );
    expect(clipboardWrites).toHaveLength(0);
  });

  test("multi-project copies anchor containment to the project symlink", async () => {
    const fullContent = "multi project contents";
    const copyReadCalls: Array<{ script: string; options?: { cwdMode?: string } }> = [];
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const input = args[0] as { script: string; options?: { cwdMode?: string } };
      copyReadCalls.push(input);
      return Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(fullContent), exitCode: 0 },
      });
    });

    const view = renderImmersiveReview({ isMultiProjectWorkspace: true });

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe(fullContent);
    const copyRead = copyReadCalls.find((call) => !call.script.includes("awk 'NR >"));
    expect(copyRead).toBeTruthy();
    // Multi-project hunk paths are container-root-relative, so the read must run in
    // default (container-root) mode; the project-symlink containment invariant itself
    // is covered behaviorally by the real-bash tests in fileRead.test.ts.
    expect(copyRead!.options).toBeUndefined();
  });

  test("serializes same-file copies and ignores key repeat", async () => {
    // Copy reads carry no awk line budget; overlay full-file reads do.
    let executeBashCalls = 0;
    let resolveRead: ((value: unknown) => void) | undefined;
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const { script } = args[0] as { script: string };
      if (script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      executeBashCalls += 1;
      return new Promise((resolve) => {
        resolveRead = resolve as (value: unknown) => void;
      });
    }) as unknown as MockApiClient["workspace"]["executeBash"];

    renderImmersiveReview({ isTouchImmersive: false });

    fireEvent.keyDown(globalThis.window as unknown as Element, { key: "y" });
    await waitFor(() => expect(executeBashCalls).toBe(1));

    // OS key repeat and a second same-file request while the read is pending
    // must not fan out more backend reads.
    fireEvent.keyDown(globalThis.window as unknown as Element, { key: "y", repeat: true });
    fireEvent.keyDown(globalThis.window as unknown as Element, { key: "y" });
    expect(executeBashCalls).toBe(1);

    resolveRead!({
      success: true as const,
      data: { success: true, output: encodeFileReadOutput("contents"), exitCode: 0 },
    });
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));

    // After completion the same file can be copied again.
    fireEvent.keyDown(globalThis.window as unknown as Element, { key: "y" });
    await waitFor(() => expect(executeBashCalls).toBe(2));
  });

  test("clears prior feedback while a new copy is pending", async () => {
    // Copy reads carry no awk line budget; overlay full-file reads do.
    let resolveRead: ((value: unknown) => void) | undefined;
    let copyReadCount = 0;
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const { script } = args[0] as { script: string };
      if (script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      copyReadCount += 1;
      if (copyReadCount === 1) {
        return Promise.resolve({
          success: true as const,
          data: { success: true, output: encodeFileReadOutput("contents"), exitCode: 0 },
        });
      }
      return new Promise((resolve) => {
        resolveRead = resolve as (value: unknown) => void;
      });
    }) as unknown as MockApiClient["workspace"]["executeBash"];

    const view = renderImmersiveReview();

    const findCopyButton = () =>
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Copy file contents"]');
    fireEvent.click(findCopyButton()!);
    await waitFor(() =>
      expect(findCopyButton()?.getAttribute("data-copy-file-feedback")).toBe("copied")
    );

    // Starting a second copy must clear the stale success while the read hangs.
    fireEvent.click(findCopyButton()!);
    await waitFor(() =>
      expect(findCopyButton()?.getAttribute("data-copy-file-feedback")).toBeNull()
    );
    expect(resolveRead).toBeTruthy();
  });

  test("reports a size-specific failure for oversized files", async () => {
    // Copy reads carry no awk line budget; overlay full-file reads do. The copy read
    // budget itself is exercised behaviorally in fileRead.test.ts; here the backend
    // returns the deterministic too-large exit it produces for oversized files.
    mockApi.workspace.executeBash = mock((...args: unknown[]) => {
      const { script } = args[0] as { script: string };
      if (script.includes("awk 'NR >")) {
        return Promise.resolve({
          success: true as const,
          data: { success: false, output: "", exitCode: 43 },
        });
      }
      return Promise.resolve({
        success: true as const,
        data: { success: false, output: "", exitCode: 42 },
      });
    });

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('button[aria-label="Copy file contents"]')
          ?.getAttribute("data-copy-file-feedback")
      ).toBe("failed")
    );
    expect(clipboardWrites).toHaveLength(0);
    // The failure must tell the user it is a size problem, not a generic error.
    expect(view.container.textContent ?? "").toContain("file is larger than 750 KB");
  });

  test("shows a visible failure when the API is unavailable", async () => {
    // APIContext supplies api: null while connecting/reconnecting/errored.
    mockApi = null as unknown as MockApiClient;

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('button[aria-label="Copy file contents"]')
          ?.getAttribute("data-copy-file-feedback")
      ).toBe("failed")
    );
    expect(view.container.textContent ?? "").toContain("backend connection unavailable");
    expect(clipboardWrites).toHaveLength(0);
  });

  test("rejects partial payloads from unsuccessful script exits", async () => {
    // Simulates base64 dying after stat emitted the size: the script exits nonzero
    // but leaves parseable output that would decode to empty text.
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { success: false, output: "19\n", exitCode: 1 },
      })
    );

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('button[aria-label="Copy file contents"]')
          ?.getAttribute("data-copy-file-feedback")
      ).toBe("failed")
    );
    expect(clipboardWrites).toHaveLength(0);
  });

  test("shows a visible failure when copying a binary file", async () => {
    // NUL bytes make processFileContents classify the payload as binary.
    const binaryOutput = `4\n${Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64")}`;
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { success: true, output: binaryOutput, exitCode: 0 },
      })
    );

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('button[aria-label="Copy file contents"]')
          ?.getAttribute("data-copy-file-feedback")
      ).toBe("failed")
    );
    expect(clipboardWrites).toHaveLength(0);
  });

  test("no copy affordance for a deleted file", () => {
    const deletedHunk = createHunk({ changeType: "deleted" });

    const view = renderImmersiveReview({
      hunks: [deletedHunk],
      allHunks: [deletedHunk],
    });

    expect(view.container.querySelector('button[aria-label="Copy file contents"]')).toBeNull();
  });

  test("no copy affordance for a hunk-less deleted file known only to the file tree", () => {
    // Deleting an empty or binary file yields no hunks; the active file then comes
    // from the file tree, whose numstat entry still carries the deletion status.
    const tree = createFileTree("src/gone.bin");
    const leaf = tree.children[0]?.children[0];
    expect(leaf?.path).toBe("src/gone.bin");
    leaf.stats = { filePath: "src/gone.bin", additions: 0, deletions: 0, changeType: "deleted" };

    const view = renderImmersiveReview({
      fileTree: tree,
      hunks: [],
      allHunks: [],
      selectedHunkId: null,
    });

    expect(view.container.textContent ?? "").toContain("gone.bin");
    expect(view.container.querySelector('button[aria-label="Copy file contents"]')).toBeNull();
  });

  test("no copy affordance for a deleted file whose hunks are all filtered out", () => {
    const deletedHunk = createHunk({ changeType: "deleted" });

    // Filters (search/assisted/read) can empty the visible hunk list while the
    // active file still resolves to the deleted file via the unfiltered set.
    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [deletedHunk],
      selectedHunkId: deletedHunk.id,
    });

    expect(view.container.textContent ?? "").toContain(deletedHunk.filePath);
    expect(view.container.querySelector('button[aria-label="Copy file contents"]')).toBeNull();
  });

  test("copies SVG markup as text instead of rejecting it as an image", async () => {
    const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { success: true, output: encodeFileReadOutput(svgSource), exitCode: 0 },
      })
    );

    const view = renderImmersiveReview();

    const copyButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy file contents"]'
    );
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton!);

    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe(svgSource);
  });

  test("no copy affordance when the review is complete", () => {
    const hunk = createHunk();

    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [hunk],
      isRead: () => true,
      selectedHunkId: null,
    });

    expect(view.container.textContent ?? "").toContain("Review complete");
    expect(view.container.querySelector('button[aria-label="Copy file contents"]')).toBeNull();
  });
});
