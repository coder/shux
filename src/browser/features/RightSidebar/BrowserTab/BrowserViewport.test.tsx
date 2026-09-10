import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { BrowserSession } from "./browserBridgeTypes";
import { BrowserViewport, mapDomPointToViewport } from "./BrowserViewport";

const sendInputMock = mock();

const FRAME_METADATA = {
  deviceWidth: 100,
  deviceHeight: 100,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
} as const;

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    sessionName: "alpha",
    status: "live",
    frameBase64: "frame-data",
    lastError: null,
    streamState: "live",
    frameMetadata: { ...FRAME_METADATA },
    currentUrl: null,
    isPageLoading: false,
    pendingUrl: null,
    streamErrorMessage: null,
    ...overrides,
  };
}

function renderViewport(session: BrowserSession, overrides?: { screenshotSrc?: string | null }) {
  return render(
    <BrowserViewport
      panelId="browser-preview-viewport"
      workspaceId="workspace-1"
      session={session}
      screenshotSrc={overrides?.screenshotSrc ?? "data:image/jpeg;base64,frame-data"}
      visibleError={null}
      placeholder={<div>placeholder</div>}
      sendInput={sendInputMock}
    />
  );
}

describe("BrowserViewport", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    sendInputMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("maps object-contain coordinates and ignores letterboxed gutters", () => {
    expect(
      mapDomPointToViewport(150, 100, { left: 0, top: 0, width: 300, height: 200 }, FRAME_METADATA)
    ).toEqual({ x: 50, y: 50 });
    expect(
      mapDomPointToViewport(10, 100, { left: 0, top: 0, width: 300, height: 200 }, FRAME_METADATA)
    ).toBeNull();
  });

  test("defaults intrinsic frame mapping to 1x display scale", () => {
    const highResolutionMetadata = {
      ...FRAME_METADATA,
      deviceWidth: 2160,
      deviceHeight: 2160,
    };

    expect(
      mapDomPointToViewport(
        500,
        500,
        { left: 0, top: 0, width: 1000, height: 1000 },
        highResolutionMetadata,
        { frameImageSize: { width: 720, height: 720 } }
      )
    ).toEqual({ x: 1080, y: 1080 });
    expect(
      mapDomPointToViewport(
        100,
        500,
        { left: 0, top: 0, width: 1000, height: 1000 },
        highResolutionMetadata,
        { frameImageSize: { width: 720, height: 720 } }
      )
    ).toBeNull();
  });

  test("maps input within the DPR-capped frame", () => {
    const highResolutionMetadata = {
      ...FRAME_METADATA,
      deviceWidth: 2160,
      deviceHeight: 2160,
    };
    const options = {
      devicePixelRatio: 2,
      frameImageSize: { width: 720, height: 720 },
    };

    expect(
      mapDomPointToViewport(
        500,
        500,
        { left: 0, top: 0, width: 1000, height: 1000 },
        highResolutionMetadata,
        options
      )
    ).toEqual({ x: 1080, y: 1080 });
    expect(
      mapDomPointToViewport(
        330,
        500,
        { left: 0, top: 0, width: 1000, height: 1000 },
        highResolutionMetadata,
        options
      )
    ).toEqual({ x: 60, y: 1080 });
    expect(
      mapDomPointToViewport(
        300,
        500,
        { left: 0, top: 0, width: 1000, height: 1000 },
        highResolutionMetadata,
        options
      )
    ).toBeNull();
  });

  test("does not enlarge the frame when device pixel ratio is below 1", () => {
    const highResolutionMetadata = {
      ...FRAME_METADATA,
      deviceWidth: 2160,
      deviceHeight: 2160,
    };
    const surface = { left: 0, top: 0, width: 360, height: 360 };
    const frameImageSize = { width: 720, height: 720 };

    expect(
      mapDomPointToViewport(180, 180, surface, highResolutionMetadata, {
        devicePixelRatio: 0.5,
        frameImageSize,
      })
    ).toEqual(mapDomPointToViewport(180, 180, surface, highResolutionMetadata, { frameImageSize }));
  });

  test("maps decoded frame height when Chrome outer height differs from the page viewport", () => {
    expect(
      mapDomPointToViewport(
        640,
        317,
        { left: 0, top: 0, width: 1280, height: 633 },
        { ...FRAME_METADATA, deviceWidth: 1280, deviceHeight: 720 },
        { frameImageSize: { width: 1280, height: 633 } }
      )
    ).toEqual({ x: 640, y: 317 });
  });

  test("uses decoded frame dimensions for click input when outer height differs", () => {
    const view = renderViewport(
      createSession({
        frameMetadata: { ...FRAME_METADATA, deviceWidth: 1280, deviceHeight: 720 },
      })
    );
    const image = view.getByAltText("Browser session screenshot") as HTMLImageElement;
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1280 },
      naturalHeight: { configurable: true, value: 633 },
    });
    fireEvent.load(image);
    Object.assign(viewport, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => true,
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 1280,
        height: 633,
        right: 1280,
        bottom: 633,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 640,
      clientY: 317,
      detail: 1,
    });

    expect(sendInputMock).toHaveBeenCalledWith({
      type: "input_mouse",
      eventType: "mousePressed",
      x: 640,
      y: 317,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
  });

  test("forwards mapped click and wheel input for interactive sessions", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    Object.assign(viewport, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => true,
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 150,
      clientY: 100,
      detail: 1,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 0,
      clientX: 150,
      clientY: 100,
      detail: 1,
    });
    const wheelEvent = new globalThis.window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 4,
      deltaY: 12,
      shiftKey: true,
    });
    Object.defineProperties(wheelEvent, {
      clientX: { configurable: true, value: 150 },
      clientY: { configurable: true, value: 100 },
    });
    fireEvent(viewport, wheelEvent);

    expect(sendInputMock).toHaveBeenCalledTimes(3);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      type: "input_mouse",
      eventType: "mousePressed",
      x: 50,
      y: 50,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      type: "input_mouse",
      eventType: "mouseReleased",
      x: 50,
      y: 50,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      type: "input_mouse",
      eventType: "mouseWheel",
      x: 50,
      y: 50,
      deltaX: 4,
      deltaY: 12,
      modifiers: 0,
    });
  });

  test("DPR-caps the loaded screenshot and pointer hit testing", () => {
    Object.defineProperty(globalThis.window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    const view = renderViewport(
      createSession({
        frameMetadata: {
          ...FRAME_METADATA,
          deviceWidth: 2160,
          deviceHeight: 2160,
        },
      })
    );
    const image = view.getByAltText("Browser session screenshot") as HTMLImageElement;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 720 },
      naturalHeight: { configurable: true, value: 720 },
    });
    fireEvent.load(image);

    expect(image.style.maxWidth).toBe("min(100%, 360px)");
    expect(image.style.maxHeight).toBe("min(100%, 360px)");

    const viewport = view.getByRole("region", { name: "Browser viewport" });
    Object.assign(viewport, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => true,
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
        right: 1000,
        bottom: 1000,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 500,
      clientY: 500,
      detail: 1,
    });
    fireEvent.pointerDown(viewport, {
      pointerId: 8,
      button: 0,
      buttons: 1,
      clientX: 300,
      clientY: 500,
      detail: 1,
    });

    expect(sendInputMock).toHaveBeenCalledTimes(1);
    expect(sendInputMock).toHaveBeenCalledWith({
      type: "input_mouse",
      eventType: "mousePressed",
      x: 1080,
      y: 1080,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
  });

  test("sends printable typing without duplicating char events", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    fireEvent.focus(viewport);
    fireEvent.keyDown(viewport, { key: "a", code: "KeyA" });
    fireEvent.keyUp(viewport, { key: "a", code: "KeyA" });

    expect(sendInputMock).toHaveBeenCalledTimes(2);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      type: "input_keyboard",
      eventType: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      type: "input_keyboard",
      eventType: "keyUp",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
  });

  test("uses rawKeyDown for non-text editing keys like Backspace", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    fireEvent.focus(viewport);
    fireEvent.keyDown(viewport, { key: "Backspace", code: "Backspace" });
    fireEvent.keyUp(viewport, { key: "Backspace", code: "Backspace" });

    expect(sendInputMock).toHaveBeenCalledTimes(2);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      type: "input_keyboard",
      eventType: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      type: "input_keyboard",
      eventType: "keyUp",
      key: "Backspace",
      code: "Backspace",
      modifiers: 0,
    });
  });
});
