import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { LayoutChangeEvent } from "react-native";
import { KeyboardAvoidingView } from "./Keyboard.native";
import { geometry } from "./keyboardTestRuntime";

afterEach(cleanup);

for (const windowY of [59, 110]) {
  test(`keeps the input above predictive text at window offset ${windowY}`, async () => {
    geometry.windowY = windowY;
    geometry.progress = 1;
    geometry.keyboardHeight = 336;
    const height = geometry.screenHeight - windowY - 34;
    const view = render(<KeyboardAvoidingView />);
    expect(geometry.onLayout).not.toBeNull();
    await act(async () => {
      await geometry.onLayout!({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
      } as LayoutChangeEvent);
    });
    const padding = () =>
      Number.parseFloat((view.container.firstChild as HTMLElement).style.paddingBottom);
    for (const keyboardHeight of [336, 380]) {
      geometry.keyboardHeight = keyboardHeight;
      view.rerender(<KeyboardAvoidingView />);
      // A bottommost input meets the keyboard top, without adding the header
      // inside the avoiding view or double-counting the bottom safe area.
      expect(windowY + height - padding()).toBe(geometry.screenHeight - keyboardHeight);
    }
    geometry.progress = 0;
    view.rerender(<KeyboardAvoidingView />);
    expect(padding()).toBe(0);
    geometry.progress = 1;
    view.rerender(<KeyboardAvoidingView enabled={false} />);
    expect((view.container.firstChild as HTMLElement).style.paddingBottom).toBe("");
  });
}
