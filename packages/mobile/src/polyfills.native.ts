import { ReadableStream, TransformStream, WritableStream } from "web-streams-polyfill";

// RN's abort-controller lacks this method even after Expo's patch. oRPC calls it
// before sending the first request, so an otherwise healthy native connection fails.
if (typeof AbortSignal.prototype.throwIfAborted !== "function") {
  AbortSignal.prototype.throwIfAborted = function (this: AbortSignal) {
    if (this.aborted) {
      throw "reason" in this
        ? this.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }
  };
}

// oRPC uses Web Streams for its peer transport; Hermes is not a browser runtime.
if (typeof globalThis.ReadableStream === "undefined") {
  Object.assign(globalThis, { ReadableStream, TransformStream, WritableStream });
}
