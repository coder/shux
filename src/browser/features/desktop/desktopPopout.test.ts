import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DESKTOP_POPOUT_READY_TIMEOUT_MS,
  DESKTOP_POPOUT_CLOSE_EVENT,
  DESKTOP_POPOUT_CLOSE_POLL_MS,
} from "@/common/constants/desktop";
import {
  DesktopPopout,
  getDesktopPopout,
  type DesktopWindowAPI,
  type DesktopPopoutCloseRequest,
} from "./desktopPopout";

// Transport delivery is explicit so stale messages and delayed renderer acknowledgments
// can be exercised without races or sleeps. Real windows/VNC are covered by desktop.spec.ts.
class TestChannel {
  static channels: TestChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly name: string) {
    TestChannel.channels.push(this);
  }
  postMessage(message: unknown) {
    assert(!this.closed);
    this.sent.push(message);
  }
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopPopout handoff", () => {
  let originalWindow: typeof window;
  let originalDocument: typeof document;
  let originalChannel: typeof BroadcastChannel;
  let originalCustomEvent: typeof CustomEvent;
  let closePolls: Array<() => void>;
  let workspaceId: string;
  let api: DesktopWindowAPI;
  let popup: Window;
  let openPopup: Mock<Window["open"]>;
  let deadlines: Array<{ run: () => void; handle: ReturnType<typeof setTimeout> }>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalChannel = globalThis.BroadcastChannel;
    originalCustomEvent = globalThis.CustomEvent;
    globalThis.window = new GlobalWindow({ url: "http://localhost/" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = window.document;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.BroadcastChannel = TestChannel as unknown as typeof BroadcastChannel;
    TestChannel.channels = [];
    workspaceId = crypto.randomUUID();
    popup = new GlobalWindow({ url: "http://localhost/desktop.html" }) as unknown as Window;
    Object.defineProperty(popup, "closed", { value: false, writable: true, configurable: true });
    spyOn(popup, "close").mockImplementation(() => {
      Object.defineProperty(popup, "closed", { value: true });
    });
    spyOn(popup, "focus").mockImplementation(() => undefined);
    openPopup = spyOn(window, "open").mockReturnValue(popup);
    api = {
      openWindow: mock((input: Parameters<DesktopWindowAPI["openWindow"]>[0]) =>
        Promise.resolve({ instanceId: input.instanceId })
      ),
      closeWindow: mock(() => Promise.resolve()),
      getWindow: mock(() => Promise.resolve(null)),
    };
    deadlines = [];
    const schedule = globalThis.setTimeout;
    const captureTimeout = Object.assign((callback: () => void, delay?: number) => {
      assert.equal(delay, DESKTOP_POPOUT_READY_TIMEOUT_MS);
      const handle = schedule(() => undefined, 60_000);
      deadlines.push({ run: callback, handle });
      return handle;
    }, schedule);
    spyOn(globalThis, "setTimeout").mockImplementation(captureTimeout);
    closePolls = [];
    const capturePoll = Object.assign((callback: () => void, delay?: number) => {
      assert.equal(delay, DESKTOP_POPOUT_CLOSE_POLL_MS);
      closePolls.push(callback);
      return closePolls.length;
    }, window.setTimeout);
    spyOn(window, "setTimeout").mockImplementation(capturePoll);
  });

  afterEach(() => {
    for (const deadline of deadlines) clearTimeout(deadline.handle);
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.BroadcastChannel = originalChannel;
    globalThis.CustomEvent = originalCustomEvent;
  });

  function channel() {
    const current = TestChannel.channels.at(-1);
    assert(current, "Handoff must subscribe before the child is opened");
    return current;
  }

  function instanceId() {
    const calls = openPopup.mock.calls;
    const url = calls.at(-1)?.[0];
    assert(url);
    const id = new URL(String(url)).searchParams.get("instanceId");
    assert(id);
    return id;
  }

  function message(type: string, id = instanceId()) {
    channel().receive({ type, instanceId: id });
  }

  test("an unavailable handoff channel reports an error without opening or disconnecting", async () => {
    globalThis.BroadcastChannel = undefined as unknown as typeof BroadcastChannel;
    const popout = new DesktopPopout(workspaceId, false);
    const disconnect = mock(() => undefined);
    popout.attach(disconnect);
    await popout.open(api);
    expect(popout.getSnapshot().state).toBe("inline");
    expect(popout.getSnapshot().error).not.toBeNull();
    expect(openPopup).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  test("blocked popup preserves the inline viewer and permits a fresh retry", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const disconnect = mock(() => undefined);
    popout.attach(disconnect);
    spyOn(window, "open").mockReturnValueOnce(null);
    await popout.open(api);
    expect(popout.getSnapshot().state).toBe("inline");
    expect(popout.getSnapshot().error).toMatch(/block/i);
    expect(disconnect).not.toHaveBeenCalled();
    expect(channel().closed).toBe(true);
    expect(readPersistedState(`desktop-popout:${workspaceId}`, null)).toBeNull();
    await popout.open(api);
    expect(popout.getSnapshot().state).toBe("opening");
    message("ready");
    expect(popout.getSnapshot().state).toBe("detached");
  });

  test("ready disconnects inline before granting; duplicate/stale messages cannot return ownership", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const disconnect = mock(() => {
      expect(channel().sent).toEqual([]);
      expect(popout.getSnapshot().state).toBe("opening");
    });
    popout.attach(disconnect);
    await popout.open(api);
    const id = instanceId();
    expect(disconnect).not.toHaveBeenCalled();
    for (const value of [null, {}, { type: "ready" }, { type: "ready", instanceId: 1 }]) {
      channel().receive(value);
    }
    message("ready", "stale");
    expect(popout.getSnapshot().state).toBe("opening");
    message("ready");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(channel().sent).toEqual([{ type: "grant", instanceId: id }]);
    expect(popout.getSnapshot().state).toBe("detached");
    message("ready");
    message("opened");
    for (const type of ["closed", "failed", "ready", "opened"]) message(type, "stale");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(channel().sent).toHaveLength(1);
    expect(popout.getSnapshot().state).toBe("detached");
  });

  test("restore resumes the inline viewer only when the handoff suspended it", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const suspend = mock(() => undefined);
    const resume = mock(() => undefined);
    popout.attach(suspend, resume);
    // A blocked popup never suspended the inline viewer, so restoring must not restart it.
    spyOn(window, "open").mockReturnValueOnce(null);
    await popout.open(api);
    expect(popout.getSnapshot().state).toBe("inline");
    expect(resume).not.toHaveBeenCalled();
    // A real handoff suspends on ready and resumes once the popout reports closed.
    await popout.open(api);
    message("ready");
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    message("closed");
    expect(popout.getSnapshot().state).toBe("inline");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test("an inline viewer mounted while detached is resumed on restore", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const resume = mock(() => undefined);
    popout.attach(() => undefined, resume, /* suspended */ true);
    await popout.open(api);
    message("ready");
    message("closed");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test("a remount keeps the coordinator and only disconnects the current attachment", async () => {
    const popout = getDesktopPopout(workspaceId);
    const focus = spyOn(popup, "focus");
    const oldDisconnect = mock(() => undefined);
    const currentDisconnect = mock(() => undefined);
    const detachOld = popout.attach(oldDisconnect);
    popout.attach(currentDisconnect);
    detachOld();
    await popout.open(api);
    await popout.open(api);
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    message("ready");
    expect(oldDisconnect).not.toHaveBeenCalled();
    expect(currentDisconnect).toHaveBeenCalledTimes(1);
    expect(getDesktopPopout(workspaceId)).toBe(popout);
    await popout.reconcile(api);
    expect(popout.getSnapshot().state).toBe("detached");
    expect(TestChannel.channels).toHaveLength(1);
  });

  test("unmount before readiness clears only its own disconnect callback", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const disconnect = mock(() => undefined);
    const detach = popout.attach(disconnect);
    await popout.open(api);
    detach();
    message("ready");
    expect(disconnect).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("detached");
    expect(channel().sent).toHaveLength(1);
  });

  test("bring-back waits for the child's closed acknowledgment before inline restoration", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    message("ready");
    message("opened");
    popout.bringBack();
    expect(channel().sent.at(-1)).toEqual({ type: "bring-back", instanceId: instanceId() });
    expect(popout.getSnapshot().state).toBe("detached");
    message("closed");
    expect(popout.getSnapshot()).toEqual({ state: "inline", error: null });
    expect(channel().closed).toBe(true);
    expect(readPersistedState(`desktop-popout:${workspaceId}`, null)).toBeNull();
  });

  test("messages queued from a closed instance cannot affect a later handoff", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    const previousChannel = channel();
    const previousId = instanceId();
    message("ready");
    message("closed");
    await popout.open(api);
    for (const type of ["ready", "opened", "closed", "failed"]) {
      previousChannel.receive({ type, instanceId: previousId });
    }
    expect(popout.getSnapshot().state).toBe("opening");
    expect(channel().sent).toEqual([]);
    message("ready");
    expect(popout.getSnapshot().state).toBe("detached");
  });

  test("a persisted browser hint cannot grant a child or authorize inline input", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "old-window");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    message("ready", "old-window");
    expect(popout.getSnapshot().state).toBe("detached");
    expect(channel().sent).toEqual([]);
    expect(api.openWindow).not.toHaveBeenCalled();
    expect(api.getWindow).not.toHaveBeenCalled();
  });

  test("recovery after browser reload still waits for a live child's release", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "old-window");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    popup.addEventListener(DESKTOP_POPOUT_CLOSE_EVENT, (event) => {
      (event as CustomEvent<DesktopPopoutCloseRequest>).detail.handled = true;
    });
    const recovery = popout.recover(api);
    expect(channel().sent).toEqual([{ type: "bring-back", instanceId: "old-window" }]);
    expect(popout.getSnapshot().state).toBe("detached");
    message("closed", "old-window");
    await recovery;
    expect(popout.getSnapshot().state).toBe("inline");
  });

  test("a stale browser hint can recover by closing a newly acquired empty window", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "missing-window");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    const close = spyOn(popup, "close").mockImplementation(() => {
      Object.defineProperty(popup, "closed", { value: true });
    });
    await popout.recover(api);
    expect(openPopup).toHaveBeenCalledWith("", `xum-desktop-${workspaceId}`, "popup");
    expect(close).toHaveBeenCalledTimes(1);
    expect(popout.getSnapshot().state).toBe("inline");
    expect(readPersistedState(`desktop-popout:${workspaceId}`, null)).toBeNull();
    expect(channel().sent).toEqual([{ type: "bring-back", instanceId: "missing-window" }]);
  });

  test("blocked handle recovery retains the hint and never authorizes another viewer", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "live-window");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    openPopup.mockReturnValue(null);
    const error = await popout.recover(api).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(popout.getSnapshot().state).toBe("detached");
    expect(readPersistedState<string | null>(`desktop-popout:${workspaceId}`, null)).toBe(
      "live-window"
    );
    expect(channel().closed).toBe(false);
    // A live child may still acknowledge the bring-back message despite popup blocking.
    message("closed", "live-window");
    expect(popout.getSnapshot().state).toBe("inline");
  });

  test("a retained closed browser handle restores without opening another window", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    message("ready");
    message("opened");
    Object.defineProperty(popup, "closed", { value: true });
    await popout.recover(api);
    expect(openPopup).toHaveBeenCalledTimes(1);
    expect(popout.getSnapshot().state).toBe("inline");
    expect(channel().closed).toBe(true);
  });

  test("direct recovery releases the child before restoring and does not force-close a handled request", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "live-child");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    const order: string[] = [];
    const close = spyOn(popup, "close");
    popout.subscribe(() => {
      if (popout.getSnapshot().state === "inline") order.push("restore");
    });
    popup.addEventListener(DESKTOP_POPOUT_CLOSE_EVENT, (event) => {
      const request = (event as CustomEvent<DesktopPopoutCloseRequest>).detail;
      expect(request.instanceId).toBe("live-child");
      expect(popout.getSnapshot().state).toBe("detached");
      request.handled = true;
      order.push("release", "disconnect");
      popup.close();
    });
    await popout.recover(api);
    expect(order).toEqual(["release", "disconnect", "restore"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closePolls).toHaveLength(0);
  });

  test("a missed closed message is recovered only after the actual window closes", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "live-child");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    popup.addEventListener(DESKTOP_POPOUT_CLOSE_EVENT, (event) => {
      (event as CustomEvent<DesktopPopoutCloseRequest>).detail.handled = true;
    });
    const close = spyOn(popup, "close");
    await popout.recover(api);
    expect(close).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("detached");
    expect(closePolls).toHaveLength(1);
    Object.defineProperty(popup, "closed", { value: true });
    const poll = closePolls.shift();
    assert(poll);
    poll();
    expect(popout.getSnapshot().state).toBe("inline");
    expect(readPersistedState(`desktop-popout:${workspaceId}`, null)).toBeNull();
  });

  test("close polling times out without granting inline ownership while the child remains open", async () => {
    updatePersistedState(`desktop-popout:${workspaceId}`, "live-child");
    const popout = new DesktopPopout(workspaceId, false);
    await popout.reconcile(api);
    popup.addEventListener(DESKTOP_POPOUT_CLOSE_EVENT, (event) => {
      (event as CustomEvent<DesktopPopoutCloseRequest>).detail.handled = true;
    });
    const now = spyOn(Date, "now").mockReturnValue(1000);
    await popout.recover(api);
    now.mockReturnValue(1000 + DESKTOP_POPOUT_READY_TIMEOUT_MS);
    const poll = closePolls.shift();
    assert(poll);
    poll();
    expect(popout.getSnapshot().state).toBe("detached");
    expect(popout.getSnapshot().error).not.toBeNull();
    expect(channel().sent).toEqual([{ type: "bring-back", instanceId: "live-child" }]);
    expect(readPersistedState<string | null>(`desktop-popout:${workspaceId}`, null)).toBe(
      "live-child"
    );
    expect(closePolls).toHaveLength(0);
  });

  test("readiness timeout closes the unready browser window before restoring", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    const disconnect = mock(() => undefined);
    popout.attach(disconnect);
    await popout.open(api);
    const deadline = deadlines[0];
    assert(deadline);
    const close = spyOn(popup, "close").mockImplementation(() => {
      expect(popout.getSnapshot().state).toBe("opening");
      Object.defineProperty(popup, "closed", { value: true });
    });
    deadline.run();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("inline");
  });

  test("opened before ready cannot cancel the readiness deadline", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    const deadline = deadlines[0];
    assert(deadline);
    const clear = spyOn(globalThis, "clearTimeout");
    message("opened");
    expect(clear).not.toHaveBeenCalledWith(deadline.handle);
    expect(popout.getSnapshot().state).toBe("opening");
  });

  test("opened after grant cancels readiness timeout", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    const deadline = deadlines[0];
    assert(deadline);
    const clear = spyOn(globalThis, "clearTimeout");
    message("ready");
    message("opened");
    expect(clear).toHaveBeenCalledWith(deadline.handle);
  });

  test("manager-confirmed reconciliation re-grants a waiting child before or after its ready message", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    const disconnect = mock(() => undefined);
    popout.attach(disconnect);
    api.getWindow = mock(() => Promise.resolve({ instanceId: "existing" }));
    await popout.reconcile(api);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(popout.getSnapshot().state).toBe("detached");
    expect(channel().sent).toEqual([{ type: "grant", instanceId: "existing" }]);
    // If the first grant preceded the child's subscription, its late ready completes handoff.
    message("ready", "existing");
    expect(channel().sent.at(-1)).toEqual({ type: "grant", instanceId: "existing" });
    expect(channel().sent).toHaveLength(2);
    message("opened", "existing");
    message("ready", "existing");
    expect(channel().sent).toHaveLength(2);
  });

  test("Electron recovery waits for responsive child cleanup without force destruction", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    api.getWindow = mock(() => Promise.resolve({ instanceId: "existing" }));
    await popout.reconcile(api);
    const recovering = popout.recover(api);
    await Promise.resolve();
    expect(channel().sent.at(-1)).toEqual({ type: "bring-back", instanceId: "existing" });
    expect(api.closeWindow).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("detached");
    await popout.reconcile(api);
    message("ready", "existing");
    expect(channel().sent.at(-1)).toEqual({ type: "bring-back", instanceId: "existing" });
    message("closed", "existing");
    await recovering;
    expect(api.closeWindow).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("inline");
  });

  test("Electron recovery force-closes only after an unresponsive child misses its cleanup deadline", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    api.getWindow = mock(() => Promise.resolve({ instanceId: "existing" }));
    await popout.reconcile(api);
    const closed = deferred<void>();
    api.closeWindow = mock(() => closed.promise);
    const recovering = popout.recover(api);
    await Promise.resolve();
    expect(api.closeWindow).not.toHaveBeenCalled();
    const deadline = deadlines.at(-1);
    assert(deadline);
    deadline.run();
    await Promise.resolve();
    expect(api.closeWindow).toHaveBeenCalledWith({ workspaceId, instanceId: "existing" });
    expect(popout.getSnapshot().state).toBe("detached");
    closed.resolve();
    await recovering;
    expect(popout.getSnapshot().state).toBe("inline");
  });

  test("failed Electron reconciliation cannot silently reconnect an unverified inline viewer", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    api.getWindow = mock(() => Promise.reject(new Error("manager unavailable")));
    await popout.reconcile(api);
    expect(popout.getSnapshot().state).not.toBe("inline");
    expect(popout.getSnapshot().error).toMatch(/manager unavailable/);
  });

  test("Electron readiness is handled while openWindow is still pending", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    await popout.reconcile(api);
    const opened = deferred<{ instanceId: string }>();
    let id: string | undefined;
    api.openWindow = mock((input: Parameters<DesktopWindowAPI["openWindow"]>[0]) => {
      id = input.instanceId;
      return opened.promise;
    });
    const disconnect = mock(() => undefined);
    popout.attach(disconnect);
    const opening = popout.open(api);
    assert(id);
    expect(deadlines).toHaveLength(1);
    message("ready", id);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(channel().sent).toEqual([{ type: "grant", instanceId: id }]);
    message("opened", id);
    opened.resolve({ instanceId: id });
    await opening;
    expect(popout.getSnapshot().state).toBe("detached");
  });

  test("a stale manager query cannot restore inline during a newer handoff", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    await popout.reconcile(api);
    const lookup = deferred<{ instanceId: string } | null>();
    api.getWindow = mock(() => lookup.promise);
    const reconciling = popout.reconcile(api);
    await popout.open(api);
    lookup.resolve(null);
    await reconciling;
    expect(popout.getSnapshot().state).toBe("opening");
    expect(channel().closed).toBe(false);
  });

  test("a child startup failure restores inline with a retryable error", async () => {
    const popout = new DesktopPopout(workspaceId, false);
    await popout.open(api);
    message("ready");
    message("failed");
    expect(popout.getSnapshot().state).toBe("inline");
    expect(popout.getSnapshot().error).not.toBeNull();
    expect(channel().closed).toBe(true);
    await popout.open(api);
    expect(popout.getSnapshot().state).toBe("opening");
    expect(popout.getSnapshot().error).toBeNull();
  });

  test("stale Electron recovery cannot close a newer window", async () => {
    const popout = new DesktopPopout(workspaceId, true);
    api.getWindow = mock(() => Promise.resolve({ instanceId: "old" }));
    await popout.reconcile(api);
    const lookup = deferred<{ instanceId: string } | null>();
    api.getWindow = mock(() => lookup.promise);
    const recovery = popout.recover(api);
    message("closed", "old");
    await popout.open(api);
    lookup.resolve({ instanceId: "replacement" });
    await recovery;
    expect(api.closeWindow).not.toHaveBeenCalled();
    expect(popout.getSnapshot().state).toBe("opening");
  });
});
