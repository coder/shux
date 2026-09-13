import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { requireTestModule } from "@/browser/testUtils";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type * as DiffRendererModule from "./DiffRenderer";

let SelectableDiffRenderer!: typeof DiffRendererModule.SelectableDiffRenderer;
let isolatedDiffRendererPath: string | null = null;

const sharedDir = dirname(fileURLToPath(import.meta.url));

async function importIsolatedSelectableDiffRenderer() {
  const isolatedPath = join(sharedDir, `DiffRenderer.dragSelect.real.${randomUUID()}.tsx`);

  // Load a unique temp copy of the real module so earlier Bun mock.module registrations for
  // @/browser/features/Shared/DiffRenderer cannot swap in the stubbed renderer for this suite.
  await copyFile(join(sharedDir, "DiffRenderer.tsx"), isolatedPath);
  ({ SelectableDiffRenderer } = requireTestModule<{
    SelectableDiffRenderer: typeof DiffRendererModule.SelectableDiffRenderer;
  }>(isolatedPath));

  return isolatedPath;
}

describe("SelectableDiffRenderer drag selection", () => {
  let onReviewNote: Mock<(data: unknown) => void>;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  let rafHandleCounter = 0;
  const rafTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(async () => {
    isolatedDiffRendererPath = await importIsolatedSelectableDiffRenderer();

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    rafHandleCounter = 0;
    rafTimeouts.clear();

    // Happy DOM in this isolated test does not provide RAF globals, but the review composer
    // schedules textarea resize/drag updates through animation frames during drag selection.
    const requestAnimationFrameMock: typeof requestAnimationFrame = (callback) => {
      rafHandleCounter += 1;
      const handle = rafHandleCounter;
      const timeout = setTimeout(() => {
        rafTimeouts.delete(handle);
        callback(Date.now());
      }, 0);
      rafTimeouts.set(handle, timeout);
      return handle;
    };

    const cancelAnimationFrameMock: typeof cancelAnimationFrame = (handle) => {
      const timeout = rafTimeouts.get(handle);
      if (!timeout) {
        return;
      }

      clearTimeout(timeout);
      rafTimeouts.delete(handle);
    };

    globalThis.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
    globalThis.window.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.window.cancelAnimationFrame = cancelAnimationFrameMock;

    onReviewNote = mock(() => undefined);
  });

  afterEach(async () => {
    cleanup();

    for (const timeout of rafTimeouts.values()) {
      clearTimeout(timeout);
    }
    rafTimeouts.clear();

    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;

    if (globalThis.window) {
      globalThis.window.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.window.cancelAnimationFrame = originalCancelAnimationFrame;
    }

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;

    if (isolatedDiffRendererPath) {
      await rm(isolatedDiffRendererPath, { force: true });
      isolatedDiffRendererPath = null;
    }
  });

  test("hovering the review button does not show a tooltip", async () => {
    const content = "+const a = 1;\n+const b = 2;";

    const { container } = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <SelectableDiffRenderer
            content={content}
            filePath="src/test.ts"
            onReviewNote={onReviewNote}
            maxHeight="none"
            enableHighlighting={false}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    const commentButton = await waitFor(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Add review comment"]')
    );
    expect(commentButton).toBeTruthy();
    expect(commentButton?.getAttribute("title")).toBeNull();

    fireEvent.mouseEnter(commentButton!);

    expect(document.body.textContent).not.toContain(
      "Add review comment (Shift-click or drag to select range)"
    );
  });

  test("typing in the review composer does not schedule textarea layout work per key", async () => {
    const content = Array.from({ length: 200 }, (_, index) => ` line ${index + 1}`).join("\n");

    const { container, getByPlaceholderText } = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <SelectableDiffRenderer
            content={content}
            filePath="src/test.ts"
            onReviewNote={onReviewNote}
            maxHeight="none"
            enableHighlighting={false}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    const commentButton = await waitFor(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Add review comment"]')
    );
    expect(commentButton).toBeTruthy();

    fireEvent.click(commentButton!);
    const textarea = (await waitFor(() =>
      getByPlaceholderText(/Add a review note/i)
    )) as HTMLTextAreaElement;

    const animationFramesBeforeTyping = rafHandleCounter;
    fireEvent.input(textarea, { target: { value: "a" } });
    fireEvent.input(textarea, { target: { value: "ab" } });

    expect(rafHandleCounter).toBe(animationFramesBeforeTyping);
  });

  test("dragging on the indicator column selects a line range", async () => {
    const content = "+const a = 1;\n+const b = 2;\n+const c = 3;";

    const { container, getByPlaceholderText } = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <SelectableDiffRenderer
            content={content}
            filePath="src/test.ts"
            onReviewNote={onReviewNote}
            maxHeight="none"
            enableHighlighting={false}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    await waitFor(() => {
      const indicators = container.querySelectorAll('[data-diff-indicator="true"]');
      expect(indicators.length).toBe(3);
    });

    const indicators = Array.from(
      container.querySelectorAll<HTMLSpanElement>('[data-diff-indicator="true"]')
    );

    fireEvent.mouseDown(indicators[0], { button: 0 });
    fireEvent.mouseEnter(indicators[2]);
    fireEvent.mouseUp(window);

    const textarea = (await waitFor(() =>
      getByPlaceholderText(/Add a review note/i)
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      const selectedLines = Array.from(
        container.querySelectorAll<HTMLElement>('.selectable-diff-line[data-selected="true"]')
      );
      expect(selectedLines.length).toBe(3);

      const allLines = Array.from(container.querySelectorAll<HTMLElement>(".selectable-diff-line"));
      expect(allLines.length).toBe(3);

      // Input should render *after* the last selected line (line 2).
      const inputWrapper = allLines[2]?.nextElementSibling;
      expect(inputWrapper).toBeTruthy();
      expect(inputWrapper?.querySelector("textarea")).toBe(textarea);
    });
  });
});
