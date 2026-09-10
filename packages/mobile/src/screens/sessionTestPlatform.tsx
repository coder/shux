import "./formTestPlatform";
import { mock } from "bun:test";
import {
  createNavigatorFactory,
  StackRouter,
  useNavigationBuilder,
} from "@react-navigation/native";
import type {
  ParamListBase,
  StackActionHelpers,
  StackNavigationState,
  StackRouterOptions,
} from "@react-navigation/native";
import type {
  NativeStackNavigationEventMap,
  NativeStackNavigationOptions,
  NativeStackNavigatorProps,
} from "@react-navigation/native-stack";
// @ts-expect-error React Native Web publishes JS only; production types use React Native.
import * as NativeWeb from "react-native-web";

export let stackState: StackNavigationState<ParamListBase>;
// Keep the real stack router and all retained screens mounted, substituting only
// the native view host. These tests must catch subscriptions hidden below the active route.
function TestStack(props: NativeStackNavigatorProps) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, props);
  stackState = state;
  return (
    <NavigationContent>
      {state.routes.map((route, index) => (
        <div key={route.key} hidden={index !== state.index}>
          {descriptors[route.key].render()}
        </div>
      ))}
    </NavigationContent>
  );
}
mock.module("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: createNavigatorFactory(TestStack),
}));
mock.module("react-native-safe-area-context", () => ({
  SafeAreaView: NativeWeb.View,
  SafeAreaProvider: NativeWeb.View,
}));
export const secureStore = { clear: async () => {} };
mock.module("expo-secure-store", () => ({ deleteItemAsync: () => secureStore.clear() }));
