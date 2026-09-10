/** Storybook-only noVNC transport: exercise real bootstrap wiring without a live desktop server. */
export default class DesktopRfb extends EventTarget {
  static instances: DesktopRfb[] = [];
  readonly url: string;
  readonly preview: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  background = "";
  private scaled = false;
  resizeSession = false;
  viewOnly = false;
  disconnected = false;

  constructor(container: HTMLElement, url: string) {
    super();
    this.url = url;
    this.preview = document.createElement("div");
    this.preview.setAttribute("role", "img");
    this.preview.setAttribute("aria-label", "Desktop session preview");
    this.preview.className = "bg-surface-primary h-full overflow-hidden";
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.canvas.tabIndex = 0;
    this.preview.append(this.canvas);
    container.append(this.preview);
    DesktopRfb.instances.push(this);
    queueMicrotask(() => {
      if (!this.disconnected) {
        this.dispatchEvent(new Event("connect"));
      }
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

  disconnect() {
    this.disconnected = true;
    this.preview.remove();
  }
}
