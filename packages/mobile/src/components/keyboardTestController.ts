import { mock } from "bun:test";
import { Fragment } from "react";
import KeyboardAvoidingView from "../../node_modules/react-native-keyboard-controller/src/components/KeyboardAvoidingView";

// The preceding preload replaces native hosts; keep the installed KAV itself real.
mock.module("react-native-keyboard-controller", () => ({
  KeyboardProvider: Fragment,
  KeyboardAvoidingView,
}));
