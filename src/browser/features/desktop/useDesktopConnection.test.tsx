import type { Context } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  type Mock,
} from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIClient, UseAPIResult } from "@/browser/contexts/API";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import type * as DesktopModule from "./useDesktopConnection";
import { wrapAsyncIterator } from "@orpc/shared";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import type { DesktopViewerEventSchema } from "@/common/orpc/schemas/api";
import type { z } from "zod";

import DesktopRfbFixture from "./desktopRfb.test-fixture";

type DesktopViewerEvent = z.infer<typeof DesktopViewerEventSchema>;

// Bun's module mocks are process-wide. As in useAIViewKeybinds.test, load an isolated
// hook/API pair instead of letting the RFB test double leak into other suites.
const directory = dirname(fileURLToPath(import.meta.url));
const suffix = randomUUID();
const hookPath = join(directory, `useDesktopConnection.real.${suffix}.ts`);
const apiPath = join(directory, `API.real.${suffix}.tsx`);
let useDesktopConnection: typeof DesktopModule.useDesktopConnection;
let APIContext: Context<UseAPIResult | null>;

beforeAll(async () => {
  const source = await readFile(join(directory, "useDesktopConnection.ts"), "utf8");
  const isolatedSource = source
    .replaceAll("@novnc/novnc/lib/rfb", "./desktopRfb.test-fixture")
    .replace('from "@/browser/contexts/API"', `from "./API.real.${suffix}.tsx"`);
  expect(isolatedSource).not.toBe(source);
  await writeFile(hookPath, isolatedSource);
  await writeFile(apiPath, await readFile(join(directory, "../../contexts/API.tsx"), "utf8"));
  ({ useDesktopConnection } = requireTestModule<typeof DesktopModule>(hookPath));
  ({ APIContext } = requireTestModule<{ APIContext: Context<UseAPIResult | null> }>(apiPath));
});

afterAll(async () => {
  await Promise.all([rm(hookPath, { force: true }), rm(apiPath, { force: true })]);
});

describe("useDesktopConnection control ownership", () => {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
  };
  const bootstrap = {
    capability: { available: true as const, width: 1280, height: 720, sessionId: "desktop-test" },
    bridgePath: "/desktop/ws",
    token: "test-token",
  };
  let getBootstrap: Mock<APIClient["desktop"]["getBootstrap"]> = mock(() =>
    Promise.resolve(bootstrap)
  );

  const watchViewer = mock<APIClient["desktop"]["watchViewer"]>();
  const acknowledgeViewerRelease = mock<APIClient["desktop"]["acknowledgeViewerRelease"]>();
  const detachViewer = mock<APIClient["desktop"]["detachViewer"]>();
  let autoReady = true;
  const registrations: Array<{
    queue: ReturnType<typeof createAsyncMessageQueue<DesktopViewerEvent>>;
    signal: AbortSignal;
    viewerId: string;
    failure: Error | null;
  }> = [];

  beforeEach(() => {
    const dom = new GlobalWindow({ url: "http://localhost:3000" }) as unknown as Window &
      typeof globalThis;
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      KeyboardEvent: dom.KeyboardEvent,
      MouseEvent: dom.MouseEvent,
      Event: dom.Event,
    });
    DesktopRfbFixture.instances = [];
    getBootstrap = mock(() => Promise.resolve(bootstrap));
    registrations.length = 0;
    autoReady = true;
    acknowledgeViewerRelease.mockReset();
    acknowledgeViewerRelease.mockResolvedValue(undefined);
    detachViewer.mockReset();
    detachViewer.mockResolvedValue(undefined);
    watchViewer.mockReset();
    watchViewer.mockImplementation((input, { signal } = {}) => {
      if (!signal) throw new Error("Viewer registration must be abortable");
      // The pane names its registration up front (a fresh UUID per attempt).
      if (typeof input.viewerId !== "string" || input.viewerId.length === 0) {
        throw new Error("Viewer registration must be named by the pane");
      }
      const registration = {
        queue: createAsyncMessageQueue<DesktopViewerEvent>(),
        signal,
        viewerId: input.viewerId,
        failure: null as Error | null,
      };
      registrations.push(registration);
      signal.addEventListener("abort", registration.queue.end, { once: true });
      if (autoReady) registration.queue.push({ type: "ready", viewerId: registration.viewerId });
      async function* events() {
        yield* registration.queue.iterate();
        if (registration.failure) throw registration.failure;
      }
      return Promise.resolve(wrapAsyncIterator(events(), {}));
    });
  });

  afterEach(() => {
    cleanup();
    Object.assign(globalThis, originals);
  });

  function mountConnection(options?: DesktopModule.UseDesktopConnectionOptions) {
    let desktop!: DesktopModule.UseDesktopConnectionResult;
    function Harness() {
      desktop = useDesktopConnection("workspace-1", options);
      return <div ref={desktop.containerRef} />;
    }
    const client: RecursivePartial<APIClient> = {
      desktop: { getBootstrap, watchViewer, acknowledgeViewerRelease, detachViewer },
    };
    const view = render(
      <APIContext.Provider
        value={{
          status: "connected",
          api: client as APIClient,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <Harness />
      </APIContext.Provider>
    );
    return {
      ...view,
      get desktop() {
        return desktop;
      },
    };
  }

  async function connect(view: ReturnType<typeof mountConnection>) {
    act(() => view.desktop.connect());
    await waitFor(() => expect(view.desktop.state).toBe("connected"));
    const rfb = DesktopRfbFixture.instances.at(-1);
    if (!rfb) throw new Error("Desktop did not construct an RFB connection");
    return rfb;
  }

  function holdKeysAndDrag(rfb: DesktopRfbFixture) {
    for (const [key, code] of [
      ["Shift", "ShiftLeft"],
      ["Control", "ControlLeft"],
    ]) {
      rfb.canvas.dispatchEvent(new KeyboardEvent("keydown", { key, code }));
    }
    rfb.canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
  }

  test("starts view-only, blocks guest input, and changes scale live without reconnecting", async () => {
    const view = mountConnection();
    expect(view.desktop.controlling).toBe(false);
    expect(view.desktop.scaleToFit).toBe(true);
    const rfb = await connect(view);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.resizeSession).toBe(false);
    holdKeysAndDrag(rfb);
    expect(rfb.input).toEqual([]);

    act(() => view.desktop.setScaleToFit(false));
    expect(rfb.scaleViewport).toBe(false);
    expect(view.desktop.scaleToFit).toBe(false);
    act(() => view.desktop.setScaleToFit(true));
    expect(rfb.scaleViewport).toBe(true);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
    expect(DesktopRfbFixture.instances).toHaveLength(1);
    expect(rfb.disconnectCount).toBe(0);
  });

  test.each(["release", "blur", "hidden", "disconnect", "network", "unmount"])(
    "%s releases held keys and drag before noVNC becomes view-only",
    async (reason) => {
      const view = mountConnection();
      const rfb = await connect(view);
      act(() => view.desktop.setControlling(true));
      expect(view.desktop.controlling).toBe(true);
      expect(rfb.viewOnly).toBe(false);
      holdKeysAndDrag(rfb);
      act(() => {
        if (reason === "release") view.desktop.setControlling(false);
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        if (reason === "hidden") {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (reason === "disconnect") view.desktop.disconnect();
        if (reason === "network") {
          rfb.events.dispatchEvent(
            new window.CustomEvent("disconnect", { detail: { clean: false } })
          );
        }
        if (reason === "unmount") view.unmount();
      });
      expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toEqual([
        { type: "keyup", code: "ShiftLeft", viewOnly: false },
        { type: "keyup", code: "ControlLeft", viewOnly: false },
        { type: "mouseup", button: 0, viewOnly: false },
      ]);
      expect(rfb.viewOnly).toBe(true);
      if (reason !== "unmount") expect(view.desktop.controlling).toBe(false);
      if (["disconnect", "network", "unmount"].includes(reason))
        expect(rfb.disconnectCount).toBe(1);
      else expect(rfb.disconnectCount).toBe(0);
    }
  );

  test("moving focus from a control button to the canvas retains control until the window blurs", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const button = document.createElement("button");
    view.container.appendChild(button);
    button.focus();
    act(() => view.desktop.setControlling(true));
    holdKeysAndDrag(rfb);

    act(() => rfb.canvas.focus());
    expect(document.activeElement).toBe(rfb.canvas);
    expect(view.desktop.controlling).toBe(true);
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toEqual([]);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(view.desktop.controlling).toBe(false);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toHaveLength(3);
  });

  test("graceful disconnect releases inputs immediately but waits for the transport close", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    act(() => view.desktop.setControlling(true));
    holdKeysAndDrag(rfb);
    let completed = false;
    let disconnected!: Promise<void>;
    act(() => {
      disconnected = view.desktop.disconnectAndWait().then(() => {
        completed = true;
      });
    });
    expect(rfb.disconnectCount).toBe(1);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.input.filter((event) => event.type === "keyup")).toHaveLength(2);
    expect(rfb.input.filter((event) => event.type === "mouseup")).toHaveLength(1);
    await Promise.resolve();
    expect(completed).toBe(false);
    rfb.events.dispatchEvent(new Event("disconnect"));
    await disconnected;
    expect(completed).toBe(true);
  });

  test("graceful disconnect is bounded when the transport never announces close", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    await act(async () => {
      await view.desktop.disconnectAndWait();
    });
    expect(rfb.disconnectCount).toBe(1);
    expect(view.desktop.state).toBe("idle");
  });

  test("a replacement connection retains zoom but never inherits control", async () => {
    const view = mountConnection();
    const previous = await connect(view);
    act(() => {
      view.desktop.setControlling(true);
      view.desktop.setScaleToFit(false);
    });
    const replacement = await connect(view);
    expect(previous.disconnectCount).toBe(1);
    expect(replacement).not.toBe(previous);
    expect(replacement.scaleViewport).toBe(false);
    expect(replacement.resizeSession).toBe(false);
    expect(replacement.viewOnly).toBe(true);
    expect(view.desktop.controlling).toBe(false);
    expect(getBootstrap).toHaveBeenCalledTimes(2);
  });

  test("connects after another suite replaces queueMicrotask with synchronous scheduling", async () => {
    const queueMicrotask = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (callback) => callback();
    try {
      const view = mountConnection();
      const rfb = await connect(view);
      expect(rfb.viewOnly).toBe(true);
    } finally {
      globalThis.queueMicrotask = queueMicrotask;
    }
  });

  test("waits for registered ready before creating a browser VNC connection", async () => {
    autoReady = false;
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(registrations).toHaveLength(1));
    expect(DesktopRfbFixture.instances).toHaveLength(0);
    act(() => view.desktop.setControlling(true));
    expect(view.desktop.controlling).toBe(false);
    const registration = registrations[0];
    registration.queue.push({ type: "ready", viewerId: registration.viewerId });
    await waitFor(() => expect(view.desktop.state).toBe("connected"));
    expect(DesktopRfbFixture.instances).toHaveLength(1);
    expect(registration.signal.aborted).toBe(false);
  });

  test("registers the viewer before bootstrap so the pane is attached before the desktop starts", async () => {
    autoReady = false;
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(registrations).toHaveLength(1));
    // Bootstrap clears the backend's startup reservation; it must not run until the pane is
    // registered, or an agent-driven archive could close the desktop in between.
    expect(getBootstrap).not.toHaveBeenCalled();
    const registration = registrations[0];
    registration.queue.push({ type: "ready", viewerId: registration.viewerId });
    await waitFor(() => expect(view.desktop.state).toBe("connected"));
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });

  test("a release during bootstrap ACKs and prevents the pending bootstrap from connecting", async () => {
    let resolveBootstrap!: (value: typeof bootstrap) => void;
    getBootstrap = mock(
      () =>
        new Promise<typeof bootstrap>((done) => {
          resolveBootstrap = done;
        })
    );
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(1));
    const registration = registrations[0];
    registration.queue.push({ type: "release", viewerId: registration.viewerId });
    await waitFor(() =>
      expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: registration.viewerId })
    );
    await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
    await act(async () => {
      resolveBootstrap(bootstrap);
      await Promise.resolve();
    });
    expect(DesktopRfbFixture.instances).toHaveLength(0);
  });

  test.each(["disconnect", "unmount"])("%s cancels registration before ready", async (action) => {
    autoReady = false;
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(registrations).toHaveLength(1));
    const registration = registrations[0];
    act(() => {
      if (action === "unmount") view.unmount();
      else view.desktop.disconnect();
    });
    expect(registration.signal.aborted).toBe(true);
    registration.queue.push({ type: "ready", viewerId: registration.viewerId });
    await act(async () => {
      await Promise.resolve();
    });
    expect(DesktopRfbFixture.instances).toHaveLength(0);
  });

  test("a reconnect while the first registration is still pending reuses it instead of superseding it", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<APIClient["desktop"]["watchViewer"]>>>();
    watchViewer.mockReturnValueOnce(pending.promise);
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(watchViewer).toHaveBeenCalledTimes(1));
    const [input, init] = watchViewer.mock.calls[0];
    // Superseding the pending registration would give it up definitively before a successor is
    // ready; the new attempt waits for it instead.
    act(() => view.desktop.connect());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(watchViewer).toHaveBeenCalledTimes(1);
    expect(init?.signal?.aborted).toBe(false);
    expect(detachViewer).not.toHaveBeenCalled();
    const events = wrapAsyncIterator(
      (async function* () {
        yield await Promise.resolve({ type: "ready" as const, viewerId: input.viewerId ?? "" });
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
      {}
    );
    await act(async () => {
      pending.resolve(events);
      await pending.promise;
    });
    await waitFor(() => expect(view.desktop.state).toBe("connected"));
    expect(DesktopRfbFixture.instances).toHaveLength(1);
    expect(watchViewer).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    "release drains held input and ACKs before abort (unmount=%s)",
    async (unmount) => {
      const ack = Promise.withResolvers<void>();
      acknowledgeViewerRelease.mockReturnValueOnce(ack.promise);
      const view = mountConnection();
      const rfb = await connect(view);
      act(() => view.desktop.setControlling(true));
      holdKeysAndDrag(rfb);
      const registration = registrations[0];
      registration.queue.push({ type: "release", viewerId: registration.viewerId });
      await waitFor(() => expect(rfb.disconnectCount).toBe(1));
      expect(rfb.input.filter((event) => event.type === "keyup")).toHaveLength(2);
      expect(rfb.input.filter((event) => event.type === "mouseup")).toHaveLength(1);
      expect(rfb.viewOnly).toBe(true);
      expect(registration.signal.aborted).toBe(false);
      expect(acknowledgeViewerRelease).not.toHaveBeenCalled();
      if (unmount) view.unmount();
      expect(registration.signal.aborted).toBe(false);
      rfb.events.dispatchEvent(new Event("disconnect"));
      await waitFor(() =>
        expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: registration.viewerId })
      );
      expect(registration.signal.aborted).toBe(false);
      ack.resolve();
      await waitFor(() => expect(registration.signal.aborted).toBe(true));
      if (!unmount) {
        await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
        act(() => view.desktop.connect());
        expect(getBootstrap).toHaveBeenCalledTimes(1);
      }
    }
  );

  test("failed ACK still retires the registration without reconnecting", async () => {
    acknowledgeViewerRelease.mockImplementationOnce(() => Promise.reject(new Error("ACK failed")));
    const view = mountConnection();
    const rfb = await connect(view);
    const registration = registrations[0];
    registration.queue.push({ type: "release", viewerId: registration.viewerId });
    await waitFor(() => expect(rfb.disconnectCount).toBe(1));
    rfb.events.dispatchEvent(new Event("disconnect"));
    await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
    expect(registration.signal.aborted).toBe(true);
    act(() => view.desktop.connect());
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });

  test.each(["end", "error"])(
    "subscription loss before ready fails the connection and releases the registration (%s)",
    async (failure) => {
      autoReady = false;
      const view = mountConnection();
      act(() => view.desktop.connect());
      await waitFor(() => expect(registrations).toHaveLength(1));
      const registration = registrations[0];
      if (failure === "error") registration.failure = new Error("Stream failed");
      registration.queue.end();
      await waitFor(() => expect(view.desktop.state).toBe("error"));
      expect(registration.signal.aborted).toBe(true);
      expect(DesktopRfbFixture.instances).toHaveLength(0);
      expect(getBootstrap).not.toHaveBeenCalled();
      expect(acknowledgeViewerRelease).not.toHaveBeenCalled();
    }
  );

  test.each(["end", "error"])(
    "subscription loss after ready drops control, keeps the bridge, and re-registers (%s)",
    async (failure) => {
      const view = mountConnection();
      const rfb = await connect(view);
      act(() => view.desktop.setControlling(true));
      holdKeysAndDrag(rfb);
      const registration = registrations[0];
      // The replacement registers immediately; hold its ready so the unregistered window is
      // observable.
      autoReady = false;
      if (failure === "error") registration.failure = new Error("Stream failed");
      registration.queue.end();
      // The server can no longer ask for a release, so held input is released proactively...
      await waitFor(() => expect(rfb.viewOnly).toBe(true));
      expect(rfb.input.filter((event) => event.type === "keyup")).toHaveLength(2);
      expect(rfb.input.filter((event) => event.type === "mouseup")).toHaveLength(1);
      expect(registration.signal.aborted).toBe(true);
      // ...but the healthy VNC bridge stays up (it still marks the pane as attached) and the
      // pane re-registers in the background instead of tearing the connection down.
      expect(rfb.disconnectCount).toBe(0);
      expect(view.desktop.state).toBe("connected");
      await waitFor(() => expect(registrations).toHaveLength(2));
      expect(rfb.disconnectCount).toBe(0);
      expect(DesktopRfbFixture.instances).toHaveLength(1);
      // Control cannot be re-taken without a release channel.
      act(() => view.desktop.setControlling(true));
      expect(view.desktop.controlling).toBe(false);
      expect(rfb.viewOnly).toBe(true);
      // Once the replacement is ready, control is available again...
      const replacement = registrations[1];
      replacement.queue.push({ type: "ready", viewerId: replacement.viewerId });
      await waitFor(() => {
        act(() => view.desktop.setControlling(true));
        expect(view.desktop.controlling).toBe(true);
      });
      // ...and the replacement registration still delivers cooperative release.
      replacement.queue.push({ type: "release", viewerId: replacement.viewerId });
      await waitFor(() =>
        expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: replacement.viewerId })
      );
      expect(rfb.disconnectCount).toBe(1);
    }
  );

  test("a failed reconnect attempt keeps the ready registration through the backoff", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const registration = registrations[0];
    getBootstrap.mockImplementationOnce(() => Promise.reject(new Error("backend hiccup")));
    rfb.events.dispatchEvent(new Event("disconnect"));
    // First retry fails at bootstrap; the pane is still mounted and must stay attached.
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await waitFor(() => expect(view.desktop.state).toBe("disconnected"));
    expect(registration.signal.aborted).toBe(false);
    expect(watchViewer).toHaveBeenCalledTimes(1);
    // The next retry reuses it and reconnects.
    await waitFor(() => expect(view.desktop.state).toBe("connected"), { timeout: 10_000 });
    expect(watchViewer).toHaveBeenCalledTimes(1);
    expect(registration.signal.aborted).toBe(false);
  });

  test("a failed reconnect attempt with no ready registration keeps the earlier graces", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    // The release stream drops after ready; its replacement is still awaiting ready...
    autoReady = false;
    registrations[0].queue.end();
    await waitFor(() => expect(registrations).toHaveLength(2));
    // ...when the bridge drops too. The reconnect reuses the pending replacement...
    act(() => rfb.events.dispatchEvent(new Event("disconnect")));
    await waitFor(() => expect(view.desktop.state).toBe("checking"), { timeout: 5_000 });
    // ...which fails before ready, as does the fresh registration the attempt makes instead.
    registrations[1].failure = new Error("replacement lost");
    registrations[1].queue.end();
    await waitFor(() => expect(registrations).toHaveLength(3));
    registrations[2].failure = new Error("registration lost");
    registrations[2].queue.end();
    await waitFor(() => expect(view.desktop.state).toBe("disconnected"));
    // A retry is scheduled, so the graces the earlier attachments left are all that keeps the
    // pane attached through the backoff: nothing may retract them.
    expect(detachViewer).not.toHaveBeenCalled();
  });

  test("suspend keeps the ready registration and a later connect reuses it", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const registration = registrations[0];
    act(() => view.desktop.suspend());
    expect(view.desktop.state).toBe("idle");
    expect(rfb.disconnectCount).toBe(1);
    // Suspended (desktop shown in a popout): the pane stays attached...
    expect(registration.signal.aborted).toBe(false);
    // ...and still honors a release while suspended.
    await connect(view);
    expect(watchViewer).toHaveBeenCalledTimes(1);
    expect(DesktopRfbFixture.instances).toHaveLength(2);
    act(() => view.desktop.suspend());
    registration.queue.push({ type: "release", viewerId: registration.viewerId });
    await waitFor(() =>
      expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: registration.viewerId })
    );
    await waitFor(() => expect(registration.signal.aborted).toBe(true));
    act(() => view.desktop.connect());
    expect(getBootstrap).toHaveBeenCalledTimes(2);
  });

  test("suspend keeps a registration that is still awaiting ready instead of detaching it", async () => {
    autoReady = false;
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(registrations).toHaveLength(1));
    const registration = registrations[0];
    // The popout child registers only once granted; the pending inline registration stays the
    // pane's lease through the handoff rather than being given up definitively.
    act(() => view.desktop.suspend());
    expect(registration.signal.aborted).toBe(false);
    expect(detachViewer).not.toHaveBeenCalled();
    registration.queue.push({ type: "ready", viewerId: registration.viewerId });
    await waitFor(() => expect(view.desktop.register()).resolves.toBe(true));
    expect(watchViewer).toHaveBeenCalledTimes(1);
  });

  test("register attaches without bootstrapping and connect reuses the registration", async () => {
    const view = mountConnection();
    let ready: Promise<boolean> | undefined;
    act(() => {
      ready = view.desktop.register();
    });
    await waitFor(() => expect(registrations).toHaveLength(1));
    // Resolves once the backend reported the registration ready, so a handoff can wait for it.
    expect(await ready).toBe(true);
    expect(getBootstrap).not.toHaveBeenCalled();
    expect(view.desktop.state).toBe("idle");
    await connect(view);
    expect(watchViewer).toHaveBeenCalledTimes(1);
  });

  test("a terminal unavailable bootstrap gives the viewer up definitively", async () => {
    getBootstrap.mockImplementationOnce(() =>
      Promise.resolve({ ...bootstrap, capability: { available: false, reason: "disabled" } })
    );
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
    expect(registrations).toHaveLength(1);
    // Definitive detach first (no attachment grace on the backend), then the abort.
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registrations[0].viewerId });
    expect(registrations[0].signal.aborted).toBe(true);
  });

  test("a terminal outcome also gives up the registrations it superseded during bootstrap", async () => {
    let resolveBootstrap!: (value: Awaited<ReturnType<typeof getBootstrap>>) => void;
    getBootstrap = mock(
      () =>
        new Promise<Awaited<ReturnType<typeof getBootstrap>>>((done) => {
          resolveBootstrap = done;
        })
    );
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(1));
    // The ready subscription drops while bootstrap is pending: the backend stamps a grace for
    // it and the pane re-registers at once.
    registrations[0].queue.end();
    await waitFor(() => expect(registrations).toHaveLength(2));
    await act(async () => {
      resolveBootstrap({ ...bootstrap, capability: { available: false, reason: "disabled" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
    // Both the replacement and the superseded registration are detached definitively, so the
    // superseded one's grace cannot keep a pane that shows nothing attached.
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registrations[1].viewerId });
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registrations[0].viewerId });
  });

  test("a security failure before the first connect is terminal and gives the viewer up", async () => {
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(DesktopRfbFixture.instances).toHaveLength(1));
    const rfb = DesktopRfbFixture.instances[0];
    act(() => {
      rfb.events.dispatchEvent(
        new window.CustomEvent("securityfailure", { detail: { status: 1, reason: "expired" } })
      );
    });
    await waitFor(() => expect(view.desktop.state).toBe("error"));
    // Definitive detach (no backend grace) precedes the abort, and nothing re-registers.
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registrations[0].viewerId });
    expect(registrations[0].signal.aborted).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(registrations).toHaveLength(1);
  });

  test("bootstrap names the ready registration so the bridge is attributed to it", async () => {
    const view = mountConnection();
    await connect(view);
    expect(getBootstrap).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      viewerId: registrations[0].viewerId,
    });
  });

  test("an explicit disconnect gives the registration up definitively before aborting it", async () => {
    const view = mountConnection();
    await connect(view);
    const registration = registrations[0];
    const abortedAtDetach: boolean[] = [];
    detachViewer.mockImplementationOnce(() => {
      abortedAtDetach.push(registration.signal.aborted);
      return Promise.resolve();
    });
    act(() => view.desktop.disconnect());
    // The pane will not reconnect: the backend learns that before the abort and the bridge
    // close can stamp attachment graces.
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registration.viewerId });
    expect(abortedAtDetach).toEqual([false]);
    await waitFor(() => expect(registration.signal.aborted).toBe(true));
  });

  test("a pane that unmounts before ready still gives its named registration up definitively", async () => {
    autoReady = false;
    const view = mountConnection();
    act(() => view.desktop.connect());
    await waitFor(() => expect(registrations).toHaveLength(1));
    const registration = registrations[0];
    act(() => view.unmount());
    // The backend registered the pane before ready reached it: the id the pane chose is detached
    // before the abort, so no dropped-viewer grace is left behind.
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: registration.viewerId });
    expect(registration.signal.aborted).toBe(true);
  });

  test("a close that keeps the grace aborts the registration without a definitive detach", async () => {
    const view = mountConnection();
    await connect(view);
    const registration = registrations[0];
    // A popout closing on its own may be handing off to an inline pane whose lease is still in
    // flight: the bounded grace the abort leaves behind is wanted, so nothing retracts it.
    await act(() => view.desktop.disconnectAndWait({ keepGrace: true }));
    expect(detachViewer).not.toHaveBeenCalled();
    expect(registration.signal.aborted).toBe(true);
  });

  test("unmount keeps the grace when the pane's desktop is handing off to a popout", async () => {
    let handingOff = false;
    const view = mountConnection({ unmountKeepsGrace: () => handingOff });
    await connect(view);
    handingOff = true;
    act(() => view.unmount());
    // The popup exists but connects only after ready/grant: the abort's bounded grace covers
    // the gap, so nothing retracts it.
    expect(detachViewer).not.toHaveBeenCalled();
    expect(registrations[0].signal.aborted).toBe(true);
  });

  test("normal unmount unregisters after releasing held input", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    act(() => view.desktop.setControlling(true));
    holdKeysAndDrag(rfb);
    const aborted = mock(() => {
      expect(rfb.disconnectCount).toBe(1);
      expect(
        rfb.input.filter((event) => event.type === "keyup" || event.type === "mouseup")
      ).toHaveLength(3);
    });
    registrations[0].signal.addEventListener("abort", aborted);
    view.unmount();
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  test("the Electron popout window relies on native cleanup instead of a viewer registration", async () => {
    Object.defineProperty(window, "api", { value: {} });
    const view = mountConnection({ nativeWindowCleanup: true });
    await connect(view);
    expect(watchViewer).not.toHaveBeenCalled();
    // It still names its bridge, and gives that name up when the window's cleanup disconnects,
    // so the bridge's detachment grace is retracted like a registered pane's.
    const call = getBootstrap.mock.calls[0]?.[0];
    expect(typeof call?.viewerId).toBe("string");
    expect(call?.viewerId?.length).toBeGreaterThan(0);
    act(() => view.desktop.disconnect());
    expect(detachViewer).toHaveBeenCalledWith({ viewerId: call?.viewerId });
  });

  test.each([
    ["Electron inline", false],
    ["browser popout", true],
  ])(
    "the %s pane registers a viewer (nativeWindowCleanup=%s only skips in Electron)",
    async (surface, nativeWindowCleanup) => {
      if (surface === "Electron inline") Object.defineProperty(window, "api", { value: {} });
      const view = mountConnection({ nativeWindowCleanup });
      await connect(view);
      expect(watchViewer).toHaveBeenCalledTimes(1);
    }
  );

  test("a transient transport drop keeps the viewer registered through the reconnect backoff", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const registration = registrations[0];
    // Simulate the bridge socket dropping: the pane stays mounted and schedules a reconnect.
    rfb.events.dispatchEvent(new Event("disconnect"));
    await waitFor(() => expect(view.desktop.state).toBe("disconnected"));
    expect(registration.signal.aborted).toBe(false);
    // The reconnect reuses the ready registration rather than re-registering.
    await waitFor(() => expect(view.desktop.state).toBe("connected"), { timeout: 5_000 });
    expect(watchViewer).toHaveBeenCalledTimes(1);
    expect(registration.signal.aborted).toBe(false);
    expect(DesktopRfbFixture.instances).toHaveLength(2);
    // A release after the reconnect is still honored by the retained registration.
    registration.queue.push({ type: "release", viewerId: registration.viewerId });
    await waitFor(() =>
      expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: registration.viewerId })
    );
    await waitFor(() => expect(registration.signal.aborted).toBe(true));
    expect(DesktopRfbFixture.instances[1].disconnectCount).toBe(1);
  });

  test("a release during the reconnect backoff disconnects, ACKs, and stops reconnecting", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const registration = registrations[0];
    rfb.events.dispatchEvent(new Event("disconnect"));
    await waitFor(() => expect(view.desktop.state).toBe("disconnected"));
    registration.queue.push({ type: "release", viewerId: registration.viewerId });
    await waitFor(() =>
      expect(acknowledgeViewerRelease).toHaveBeenCalledWith({ viewerId: registration.viewerId })
    );
    await waitFor(() => expect(registration.signal.aborted).toBe(true));
    await waitFor(() => expect(view.desktop.state).toBe("unavailable"));
    // The pending backoff timer must not resurrect the connection after the release.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
    expect(DesktopRfbFixture.instances).toHaveLength(1);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });

  test("unmount prevents a pending bootstrap from creating a connection", async () => {
    let resolve!: (value: typeof bootstrap) => void;
    getBootstrap = mock(
      () =>
        new Promise<typeof bootstrap>((done) => {
          resolve = done;
        })
    );
    const view = mountConnection();
    act(() => view.desktop.connect());
    expect(view.desktop.state).toBe("checking");
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolve(bootstrap);
      await Promise.resolve();
    });
    window.dispatchEvent(new Event("blur"));
    expect(DesktopRfbFixture.instances).toHaveLength(0);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });
});
