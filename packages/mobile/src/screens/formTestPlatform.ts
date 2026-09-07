import "../testDom";
import { mock } from "bun:test";
import { createElement } from "react";
import { TOOL_ICON_NAMES } from "../../../../src/common/constants/toolIcons";
// @ts-expect-error React Native Web publishes JS only; production types use React Native.
import * as NativeWeb from "react-native-web";

// Exercise real Pressable/TextInput/Modal behavior without loading native host modules.
// Insets and SVG painting are covered by the real-browser visual gate, not happy-dom.
mock.module("react-native", () => NativeWeb);
mock.module("react-native-safe-area-context", () => ({ SafeAreaView: NativeWeb.View }));
const icon = () => null;
mock.module("react-native-svg", () => ({ default: NativeWeb.View, Circle: icon }));
mock.module("lucide-react-native", () =>
  Object.fromEntries(
    [
      ...new Set([
        ...Object.values(TOOL_ICON_NAMES),
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "Eye",
        "EyeOff",
        "GitCompareArrows",
        "Square",
        "CheckCircle2",
        "FileCode",
        "RefreshCw",
        "AlertCircle",
        "ChevronLeft",
        "Info",
        "TriangleAlert",
        "X",
        "Check",
        "ChevronDown",
        "ChevronRight",
        "Cpu",
        "Bot",
        "ClipboardList",
        "Code2",
        "Folder",
        "Search",
        "Settings",
        "SquarePen",
        "Plus",
        "MessageSquare",
        "KeyRound",
        "LogOut",
        "Server",
        "ShieldCheck",
        "Brain",
        "File",
        "Pause",
        "Wrench",
      ]),
    ].map((name) => [name, () => createElement("svg", { "data-icon": name, "aria-hidden": true })])
  )
);
