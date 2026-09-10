import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { trackDesktopInput } from "./desktopInput";

describe("desktop input ownership", () => {
  const originalKeyboardEvent = globalThis.KeyboardEvent;
  const originalMouseEvent = globalThis.MouseEvent;
  let dom: Window & typeof globalThis;
  let canvas: HTMLCanvasElement;
  let controlling: boolean;
  let input: ReturnType<typeof trackDesktopInput>;

  beforeEach(() => {
    dom = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.KeyboardEvent = dom.KeyboardEvent;
    globalThis.MouseEvent = dom.MouseEvent;
    canvas = dom.document.createElement("canvas");
    dom.document.body.appendChild(canvas);
    controlling = false;
    input = trackDesktopInput(canvas, () => controlling);
  });

  afterEach(() => {
    input.dispose();
    globalThis.KeyboardEvent = originalKeyboardEvent;
    globalThis.MouseEvent = originalMouseEvent;
  });

  test("view-only input never becomes a held remote key or button", () => {
    const keyUp = mock(() => undefined);
    const mouseUp = mock(() => undefined);
    canvas.addEventListener("keyup", keyUp);
    canvas.addEventListener("mouseup", mouseUp);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));

    controlling = true;
    input.release();

    expect(keyUp).not.toHaveBeenCalled();
    expect(mouseUp).not.toHaveBeenCalled();
  });

  test("releases held Shift/Ctrl and a drag at its last position without leaking app events", () => {
    controlling = true;
    const releasedKeys: KeyboardEvent[] = [];
    const releasedButtons: MouseEvent[] = [];
    const appKey = mock(() => undefined);
    const appMouse = mock(() => undefined);
    canvas.addEventListener("keyup", (event) => releasedKeys.push(event));
    canvas.addEventListener("mouseup", (event) => releasedButtons.push(event));
    dom.addEventListener("keyup", appKey);
    dom.addEventListener("mouseup", appMouse);

    for (const [key, code, location] of [
      ["Shift", "ShiftLeft", 1],
      ["Control", "ControlRight", 2],
    ] as const) {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key, code, location, bubbles: true }));
      // Key repeat must not create a duplicate release.
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key, code, location, repeat: true }));
    }
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 5, clientY: 10 }));
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 90, clientY: 120 }));
    input.release();
    input.release();

    expect(releasedKeys.map(({ key, code, location }) => ({ key, code, location }))).toEqual([
      { key: "Shift", code: "ShiftLeft", location: 1 },
      { key: "Control", code: "ControlRight", location: 2 },
    ]);
    expect(
      releasedButtons.map(({ button, clientX, clientY }) => ({ button, clientX, clientY }))
    ).toEqual([{ button: 0, clientX: 90, clientY: 120 }]);
    expect(appKey).not.toHaveBeenCalled();
    expect(appMouse).not.toHaveBeenCalled();
  });

  test("does not release inputs that were already lifted", () => {
    controlling = true;
    const keyUp = mock(() => undefined);
    const mouseUp = mock(() => undefined);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
    canvas.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA" }));
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    canvas.addEventListener("keyup", keyUp);
    canvas.addEventListener("mouseup", mouseUp);
    input.release();
    expect(keyUp).not.toHaveBeenCalled();
    expect(mouseUp).not.toHaveBeenCalled();
  });

  test("canvas handlers still receive keyboard input but the app does not until disposal", () => {
    const remoteKey = mock(() => undefined);
    const appKey = mock(() => undefined);
    canvas.addEventListener("keydown", remoteKey);
    dom.addEventListener("keydown", appKey);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(remoteKey).toHaveBeenCalledTimes(1);
    expect(appKey).not.toHaveBeenCalled();

    input.dispose();
    controlling = true;
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const keyUp = mock(() => undefined);
    canvas.addEventListener("keyup", keyUp);
    input.release();
    expect(remoteKey).toHaveBeenCalledTimes(2);
    expect(appKey).toHaveBeenCalledTimes(1);
    expect(keyUp).not.toHaveBeenCalled();
  });
});
