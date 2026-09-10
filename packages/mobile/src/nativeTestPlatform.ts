import {
  AbortController as NativeAbortController,
  AbortSignal as NativeAbortSignal,
} from "abort-controller/dist/abort-controller";
import { installAbortSignalPatch } from "expo/src/winter/AbortSignal";

// Bun aliases the bare package name to its built-in; use the installed implementation above.
if ("throwIfAborted" in NativeAbortSignal.prototype) {
  throw new Error("Native transport tests require React Native's legacy AbortSignal.");
}

// Bun's fetch ignores a foreign AbortSignal, but the platform fetch the app ships with
// (expo/fetch) cancels its native request from React Native's signal. Bridge the
// legacy signal into Bun's so cancellation reaches the network here as well.
const RuntimeAbortController = globalThis.AbortController;
const runtimeFetch = globalThis.fetch;
const bridgedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (!init?.signal) return runtimeFetch(input, init);
  const controller = new RuntimeAbortController();
  const forward = () => controller.abort();
  if (init.signal.aborted) forward();
  else init.signal.addEventListener("abort", forward, { once: true });
  return runtimeFetch(input, { ...init, signal: controller.signal });
};

// Match RN's setUpXHR plus Expo's winter patch, rather than Bun's newer AbortSignal.
Object.assign(globalThis, {
  AbortController: NativeAbortController,
  AbortSignal: NativeAbortSignal,
  fetch: bridgedFetch,
});
installAbortSignalPatch(globalThis.AbortSignal);
