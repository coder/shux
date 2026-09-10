import assert from "xum/common/utils/assert";

import type { WebviewToExtensionMessage } from "./protocol";

export interface VscodeBridge {
  traceId: string;
  startedAtMs: number;
  postMessage: (payload: WebviewToExtensionMessage) => void;
  onMessage: (handler: (data: unknown) => void) => () => void;
  debugLog: (message: string, data?: unknown) => void;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let cachedBridge: VscodeBridge | null = null;

export function getVscodeBridge(): VscodeBridge {
  if (cachedBridge) {
    return cachedBridge;
  }

  const traceId =
    (document.body && document.body.dataset && document.body.dataset.muxTraceId) || "unknown";

  let vscode: { postMessage: (data: unknown) => void };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore VS Code injects this in the webview
    vscode = acquireVsCodeApi();
  } catch (error) {
    throw new Error(`mux webview: acquireVsCodeApi failed: ${String(error)}`);
  }

  const startedAtMs = Date.now();
  let nextSeq = 1;

  const listeners = new Set<(data: unknown) => void>();

  const onMessage = (handler: (data: unknown) => void): (() => void) => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  };

  window.addEventListener("message", (event: MessageEvent) => {
    for (const handler of listeners) {
      try {
        handler(event.data);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("mux webview: message handler crashed", error);
      }
    }
  });

  const postMessage = (payload: WebviewToExtensionMessage): void => {
    assert(payload && typeof payload === "object" && "type" in payload, "postMessage requires a payload with type");

    const meta = {
      traceId,
      seq: nextSeq++,
      sentAtMs: Date.now(),
      sinceStartMs: Date.now() - startedAtMs,
    };

    const envelope: Record<string, unknown> = { __muxMeta: meta, ...payload };
    vscode.postMessage(envelope);
  };

  const debugLog = (message: string, data?: unknown): void => {
    // Mirror to DevTools console.
    // eslint-disable-next-line no-console
    console.log(`[mux-webview ${traceId}] ${message}`, data);

    try {
      postMessage({ type: "debugLog", message, data });
    } catch {
      // Ignore logging failures.
    }
  };

  // Surface unexpected errors in the extension output channel.
  window.addEventListener("error", (ev) => {
    debugLog("window.error", {
      message: ev.message,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    debugLog("unhandledrejection", { reason: safeStringify(ev.reason) });
  });

  cachedBridge = {
    traceId,
    startedAtMs,
    postMessage,
    onMessage,
    debugLog,
  };

  cachedBridge.debugLog("bridge initialized", { startedAtMs });

  return cachedBridge;
}
