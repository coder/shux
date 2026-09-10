import { wrapAsyncIterator } from "@orpc/shared";
import type { APIClient } from "@/browser/contexts/API";

export const watchDesktopViewerFixture: APIClient["desktop"]["watchViewer"] = (
  input,
  { signal } = {}
) => {
  async function* events() {
    // The pane names its registration; the backend echoes that name in ready.
    yield { type: "ready" as const, viewerId: input.viewerId ?? "desktop-fixture" };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  return Promise.resolve(wrapAsyncIterator(events(), {}));
};

// Shared noVNC boundary for deterministic hook tests and full-app Storybook fixtures.
// It deliberately models only the public RFB surface used by the viewer; real input
// translation and desktop rendering still require the live-desktop dogfood gate.
export default class DesktopRfbFixture {
  static instances: DesktopRfbFixture[] = [];
  readonly canvas: HTMLCanvasElement;
  readonly events: DocumentFragment;
  readonly input: Array<{ type: string; code?: string; button?: number; viewOnly: boolean }> = [];
  background = "";
  viewOnly = false;
  resizeSession = true;
  disconnectCount = 0;
  private scaled = false;

  constructor(
    container: HTMLElement,
    readonly url: string
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Desktop test screen");
    this.canvas.style.background = "var(--color-sidebar)";
    this.events = document.createDocumentFragment();
    container.appendChild(this.canvas);
    DesktopRfbFixture.instances.push(this);
    for (const type of ["keydown", "keyup"] as const) {
      this.canvas.addEventListener(type, (event) => {
        if (!this.viewOnly) this.input.push({ type, code: event.code, viewOnly: this.viewOnly });
      });
    }
    for (const type of ["mousedown", "mouseup"] as const) {
      this.canvas.addEventListener(type, (event) => {
        if (!this.viewOnly)
          this.input.push({ type, button: event.button, viewOnly: this.viewOnly });
      });
    }
    // Some unit suites replace global queueMicrotask with a synchronous mock. Promise jobs
    // still let the hook install its listeners before this simulated network event fires.
    void Promise.resolve().then(() => {
      if (!this.disconnectCount) this.events.dispatchEvent(new Event("connect"));
    });
  }

  get scaleViewport() {
    return this.scaled;
  }

  set scaleViewport(value: boolean) {
    this.scaled = value;
    this.canvas.style.width = value ? "100%" : "1280px";
    this.canvas.style.height = value ? "auto" : "720px";
  }

  addEventListener(type: string, listener: EventListener) {
    this.events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.events.removeEventListener(type, listener);
  }

  disconnect() {
    this.disconnectCount += 1;
    this.canvas.remove();
  }
}
