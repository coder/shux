import { waitFor } from "@storybook/test";

/**
 * Wait for chat messages to finish loading.
 *
 * Waits for data-loaded="true" on the message window, then one RAF
 * to let any pending coalesced scroll from useAutoScroll complete.
 */
export async function waitForChatMessagesLoaded(canvasElement: HTMLElement): Promise<void> {
  // Use 25s timeout to handle CI cold-start scenarios where large dependencies
  // (Shiki, Mermaid) are still being loaded/initialized on busy runners
  await waitFor(
    () => {
      const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
      if (messageWindow?.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }
    },
    { timeout: 25000 }
  );

  // One RAF to let any pending coalesced scroll complete
  await new Promise((r) => requestAnimationFrame(r));
}

export async function waitForChatInputAutofocusDone(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const state = canvasElement
        .querySelector('[data-component="ChatInputSection"]')
        ?.getAttribute("data-autofocus-state");
      if (state !== "done") {
        throw new Error("ChatInput auto-focus not finished");
      }
    },
    { timeout: 5000 }
  );
}

export function blurActiveElement(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Wait for chat messages to load and async rendering (markdown, etc.) to settle.
 *
 * Use this for stories with MarkdownRenderer content that changes element heights
 * after rendering, triggering ResizeObserver scroll. Waits for messages to load
 * plus double-RAF for coalesced scroll to fire and layout to settle.
 */
export async function waitForScrollStabilization(canvasElement: HTMLElement): Promise<void> {
  await waitForChatMessagesLoaded(canvasElement);

  // Wait 2 RAFs: one for coalesced scroll to fire, one for layout to settle
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
