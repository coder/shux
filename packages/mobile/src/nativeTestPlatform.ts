import {
  AbortController as NativeAbortController,
  AbortSignal as NativeAbortSignal,
} from "abort-controller/dist/abort-controller";
import { installAbortSignalPatch } from "expo/src/winter/AbortSignal";

// Bun aliases the bare package name to its built-in; use the installed implementation above.
if ("throwIfAborted" in NativeAbortSignal.prototype) {
  throw new Error("Native transport tests require React Native's legacy AbortSignal.");
}

// Match RN's setUpXHR plus Expo's winter patch, rather than Bun's newer AbortSignal.
Object.assign(globalThis, {
  AbortController: NativeAbortController,
  AbortSignal: NativeAbortSignal,
});
installAbortSignalPatch(globalThis.AbortSignal);
