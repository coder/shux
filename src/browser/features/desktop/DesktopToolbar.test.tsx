import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { DesktopToolbar } from "./DesktopToolbar";

describe("DesktopToolbar", () => {
  let originalWindow: typeof window;
  let originalDocument: typeof document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("disables remote controls until connected, while bring-back remains available", () => {
    const onToggleControl = mock(() => undefined);
    const onToggleScale = mock(() => undefined);
    const onDetach = mock(() => undefined);
    const onBringBack = mock(() => undefined);
    const view = render(
      <DesktopToolbar
        connected={false}
        controlling={false}
        scaleToFit
        onToggleControl={onToggleControl}
        onToggleScale={onToggleScale}
        onDetach={onDetach}
        onBringBack={onBringBack}
      />
    );
    for (const name of ["Take control", "Zoom to 100%", "Detach"]) {
      expect(view.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
    const toolbar = view.getByRole("toolbar");
    for (const key of ["c", "z", "d", "b"]) fireEvent.keyDown(toolbar, { key });
    expect(onToggleControl).not.toHaveBeenCalled();
    expect(onToggleScale).not.toHaveBeenCalled();
    expect(onDetach).not.toHaveBeenCalled();
    expect(onBringBack).toHaveBeenCalledTimes(1);
  });

  test("C/Z/D work only in the toolbar, without intercepting modifier shortcuts or repeats", () => {
    const onToggleControl = mock(() => undefined);
    const onToggleScale = mock(() => undefined);
    const onDetach = mock(() => undefined);
    const view = render(
      <>
        <canvas data-testid="desktop" />
        <DesktopToolbar
          connected
          controlling={false}
          scaleToFit
          onToggleControl={onToggleControl}
          onToggleScale={onToggleScale}
          onDetach={onDetach}
        />
      </>
    );
    const control = view.getByRole("button", { name: "Take control" });
    for (const key of ["c", "z", "d"]) {
      fireEvent.keyDown(view.getByTestId("desktop"), { key });
      fireEvent.keyDown(document.body, { key });
      for (const modifier of ["ctrlKey", "altKey", "metaKey", "repeat"]) {
        fireEvent.keyDown(control, { key, [modifier]: true });
      }
    }
    expect(onToggleControl).not.toHaveBeenCalled();
    expect(onToggleScale).not.toHaveBeenCalled();
    expect(onDetach).not.toHaveBeenCalled();

    for (const key of ["c", "z", "d"]) fireEvent.keyDown(control, { key });
    expect(onToggleControl).toHaveBeenCalledTimes(1);
    expect(onToggleScale).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  test("reflects active control and native zoom as pressed actions", () => {
    const view = render(
      <DesktopToolbar
        connected
        controlling
        scaleToFit={false}
        onToggleControl={() => undefined}
        onToggleScale={() => undefined}
      />
    );
    expect(view.getByRole("button", { name: "Release control" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(view.getByRole("button", { name: "Zoom to fit" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(view.queryByRole("button", { name: "Detach" })).toBeNull();
  });
});
