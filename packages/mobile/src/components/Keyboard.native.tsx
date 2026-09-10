import type { KeyboardAvoidingViewProps } from "react-native";
import { KeyboardAvoidingView as NativeKeyboardAvoidingView } from "react-native-keyboard-controller";

export { KeyboardProvider } from "react-native-keyboard-controller";

export function KeyboardAvoidingView(props: KeyboardAvoidingViewProps) {
  // Safe areas and page sheets put local layout and keyboard frames in different
  // coordinate spaces. Native measures in window coordinates; web keeps core behavior.
  return <NativeKeyboardAvoidingView {...props} behavior="padding" automaticOffset />;
}
