import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// Keep the fake transport and its events in one realm even after other UI tests install a DOM.
import { GlobalWindow, EventTarget, Event, CustomEvent } from "happy-dom";
import type { APIClient } from "@/browser/contexts/API";

import { watchDesktopViewerFixture } from "./desktopRfb.test-fixture";

const getBootstrap = mock<APIClient["desktop"]["getBootstrap"]>();
const getWindow = mock<APIClient["desktop"]["getWindow"]>();
const api = {
  desktop: {
    getBootstrap,
    getWindow,
    watchViewer: watchDesktopViewerFixture,
    acknowledgeViewerRelease: () => Promise.resolve(),
    detachViewer: () => Promise.resolve(),
  },
};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api }),
}));

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  readonly canvas: HTMLCanvasElement;
  background = "";
  viewOnly = false;
  scaleViewport = false;
  resizeSession = false;
  disconnected = false;
  constructor(
    container: HTMLElement,
    readonly url: string
  ) {
    super();
    this.canvas = container.ownerDocument.createElement("canvas");
    container.appendChild(this.canvas);
    FakeRfb.instances.push(this);
    // Other suites replace queueMicrotask with synchronous execution. Keep the simulated
    // network event asynchronous so the viewer can register its connection listeners first.
    void Promise.resolve().then(() => {
      if (!this.disconnected) this.dispatchEvent(new Event("connect"));
    });
  }
  disconnect() {
    this.disconnected = true;
    this.canvas.remove();
  }
}
void mock.module("@novnc/novnc/lib/rfb", () => ({ default: FakeRfb }));

import { DesktopPanel } from "./DesktopPanel";

type Bootstrap = Awaited<ReturnType<APIClient["desktop"]["getBootstrap"]>>;
const ownCapability = { available: true as const, width: 1280, height: 720, sessionId: "session" };
const sharedBootstrap: Bootstrap = {
  capability: {
    ...ownCapability,
    sharedDesktop: { ownerWorkspaceId: "owner", ownerName: "Original desktop" },
  },
  bridgePath: "/desktop/ws/caller",
  token: "caller-token",
};

async function connectedViewer() {
  await waitFor(() => expect(FakeRfb.instances.length).toBeGreaterThan(0));
  return FakeRfb.instances.at(-1)!;
}

describe("DesktopPanel binding", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = window.document;
    FakeRfb.instances = [];
    getBootstrap.mockReset();
    getBootstrap.mockResolvedValue(sharedBootstrap);
    getWindow.mockReset();
    getWindow.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test.each(["button", "keyboard"])(
    "successful Electron recovery via %s clears the previous action error",
    async (interaction) => {
      Object.defineProperty(window, "api", { configurable: true, value: {} });
      getWindow.mockRejectedValueOnce(new Error("Initial manager failure"));
      const view = render(<DesktopPanel workspaceId={`electron-recovery-${interaction}`} />);
      await waitFor(() =>
        expect(view.getByRole("alert").textContent).toContain("Initial manager failure")
      );

      const recover = () => {
        const button = view.getByRole("button", { name: "Reconnect here" });
        if (interaction === "button") button.click();
        else button.dispatchEvent(new window.KeyboardEvent("keydown", { key: "r", bubbles: true }));
      };
      getWindow.mockRejectedValueOnce(new Error("Recovery manager failure"));
      await act(async () => {
        recover();
        await Promise.resolve();
      });
      expect(getWindow).toHaveBeenCalledTimes(2);
      expect(view.queryByRole("toolbar", { name: "Desktop controls" })).toBeNull();

      await act(async () => {
        recover();
        await Promise.resolve();
      });
      await connectedViewer();
      expect(getWindow).toHaveBeenCalledTimes(3);
      expect(view.getByRole("toolbar", { name: "Desktop controls" })).toBeTruthy();
      expect(view.queryByRole("alert")).toBeNull();
    }
  );

  test.each(["native", "synchronous"])(
    "browser detach opens before the click returns with %s queueMicrotask",
    async (scheduling) => {
      const queueMicrotask = globalThis.queueMicrotask;
      if (scheduling === "synchronous") globalThis.queueMicrotask = (callback) => callback();
      try {
        const open = mock(() => null);
        window.open = open;
        const view = render(<DesktopPanel workspaceId={`browser-detach-gesture-${scheduling}`} />);
        await connectedViewer();
        const detachButton = view.getByRole("button", { name: "Detach" });
        await waitFor(() => expect(detachButton.hasAttribute("disabled")).toBe(false));
        act(() => {
          detachButton.click();
          expect(open).toHaveBeenCalledTimes(1);
        });
      } finally {
        globalThis.queueMicrotask = queueMicrotask;
      }
    }
  );

  test("shows bootstrap binding while connecting with the caller's bridge and token", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    expect(getBootstrap).toHaveBeenCalledWith({
      workspaceId: "caller",
      viewerId: expect.any(String) as string,
    });
    expect(getBootstrap).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "owner" })
    );
    expect(viewer.url).toBe("ws://localhost/desktop/ws/caller?token=caller-token");
    expect(view.getByText(/Original desktop/)).toBeTruthy();
  });

  test("does not show a shared target for an independent desktop", async () => {
    getBootstrap.mockResolvedValue({ ...sharedBootstrap, capability: ownCapability });
    const view = render(<DesktopPanel workspaceId="isolated" />);
    await connectedViewer();
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("clears the binding after security failure and keeps it cleared when retry bootstrap fails", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    act(() => {
      viewer.dispatchEvent(
        new CustomEvent("securityfailure", { detail: { status: 1, reason: "expired token" } })
      );
    });
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(viewer.disconnected).toBe(true);
    getBootstrap.mockRejectedValueOnce(new Error("binding removed"));
    act(() => view.getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(2));
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("clears disconnected target metadata before a reconnect gets a new bootstrap", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    act(() => {
      viewer.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } }));
    });
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(viewer.disconnected).toBe(true);
  });

  test("disposes the previous binding and bootstraps the newly selected workspace", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const previousViewer = await connectedViewer();
    getBootstrap.mockResolvedValue({
      capability: ownCapability,
      bridgePath: "/desktop/ws/isolated",
      token: "isolated-token",
    });
    view.rerender(<DesktopPanel workspaceId="isolated" />);
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(previousViewer.disconnected).toBe(true);
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(2));
    expect(getBootstrap).toHaveBeenLastCalledWith({
      workspaceId: "isolated",
      viewerId: expect.any(String) as string,
    });
    expect(FakeRfb.instances[1].url).toBe(
      "ws://localhost/desktop/ws/isolated?token=isolated-token"
    );
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("ignores a late bootstrap from the workspace that was switched away from", async () => {
    const pending = Promise.withResolvers<Bootstrap>();
    getBootstrap.mockReturnValueOnce(pending.promise);
    const view = render(<DesktopPanel workspaceId="caller" />);
    // Bootstrap follows the viewer registration, so wait for the caller's request to be in
    // flight before switching workspaces underneath it.
    await waitFor(() =>
      expect(getBootstrap).toHaveBeenCalledWith({
        workspaceId: "caller",
        viewerId: expect.any(String) as string,
      })
    );
    getBootstrap.mockResolvedValue({ ...sharedBootstrap, capability: ownCapability });
    view.rerender(<DesktopPanel workspaceId="isolated" />);
    await connectedViewer();
    await act(async () => {
      pending.resolve(sharedBootstrap);
      await pending.promise;
    });
    expect(FakeRfb.instances).toHaveLength(1);
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(getBootstrap).toHaveBeenLastCalledWith({
      workspaceId: "isolated",
      viewerId: expect.any(String) as string,
    });
  });
});
