import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import "./src/polyfills";
import App from "./App";

registerRootComponent(App);
