import "../testDom";
import { mock } from "bun:test";
import { useRef } from "react";
import type { ReactNode, Ref } from "react";
import type { LayoutChangeEvent } from "react-native";

export const geometry = {
  screenHeight: 844,
  windowY: 59,
  keyboardHeight: 336,
  progress: 1,
  onLayout: null as ((event: LayoutChangeEvent) => Promise<void>) | null,
};

function View(props: {
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
  style?: object[];
  onLayout?: typeof geometry.onLayout;
}) {
  geometry.onLayout = props.onLayout ?? null;
  return (
    <div ref={props.ref} style={Object.assign({}, ...[props.style].flat())}>
      {props.children}
    </div>
  );
}

// Run the installed KAV calculation, replacing only native measurements and the
// UI-thread host. Animation getters stay live as keyboard geometry changes.
mock.module("react-native", () => ({ View }));
mock.module("react-native-reanimated", () => ({
  default: { View },
  interpolate: (value: number, _input: number[], output: number[]) => value * output[1],
  runOnUI: (fn: (value: unknown) => void) => fn,
  useAnimatedStyle: (fn: () => object) => fn(),
  useDerivedValue: (fn: () => unknown) => ({
    get value() {
      return fn();
    },
  }),
  useSharedValue: (value: unknown) => useRef({ value }).current,
}));
const controller = "../../node_modules/react-native-keyboard-controller/src/";
mock.module(`${controller}bindings`, () => ({
  KeyboardControllerNative: {
    viewPositionInWindow: async () => ({ x: 0, y: geometry.windowY }),
  },
}));
mock.module(`${controller}hooks`, () => ({
  useWindowDimensions: () => ({ height: geometry.screenHeight }),
}));
mock.module(`${controller}utils/findNodeHandle`, () => ({ findNodeHandle: () => 1 }));
mock.module(`${controller}components/KeyboardAvoidingView/hooks`, () => ({
  useKeyboardAnimation: () => ({
    heightWhenOpened: {
      get value() {
        return geometry.keyboardHeight;
      },
    },
    progress: {
      get value() {
        return geometry.progress;
      },
    },
    isClosed: {
      get value() {
        return geometry.progress === 0;
      },
    },
  }),
  useTranslateAnimation: () => ({ translate: { value: 0 }, padding: { value: 0 } }),
}));
