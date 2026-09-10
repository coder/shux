import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";
import assert from "xum/common/utils/assert";

import type { OrpcResponse, OrpcStreamData, OrpcStreamEnd, OrpcStreamError } from "./protocol";
import type { VscodeBridge } from "./vscodeBridge";

/**
 * ORPC ClientLink implementation for the VS Code webview.
 *
 * Message protocol (via {@link VscodeBridge}):
 * - Webview → extension: `orpcCall`, `orpcCancel`, `orpcStreamCancel`
 * - Extension → webview: `orpcResponse`, `orpcStreamData`, `orpcStreamEnd`, `orpcStreamError`
 */

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

export interface CreateVscodeOrpcLinkOptions {
  callTimeoutMs?: number;
  maxBufferedStreamEvents?: number;
}

const DEFAULT_ORPC_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFERED_STREAM_EVENTS = 200;

function isOrpcResponseMessage(raw: unknown): raw is OrpcResponse {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const record = raw as Record<string, unknown>;
  if (record.type !== "orpcResponse") {
    return false;
  }

  if (typeof record.requestId !== "string") {
    return false;
  }

  if (record.ok === true) {
    if (record.kind === "value") {
      return "value" in record;
    }

    if (record.kind === "stream") {
      return typeof record.streamId === "string";
    }

    return false;
  }

  if (record.ok === false) {
    return typeof record.error === "string";
  }

  return false;
}

function isOrpcStreamDataMessage(raw: unknown): raw is OrpcStreamData {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const record = raw as Record<string, unknown>;
  return record.type === "orpcStreamData" && typeof record.streamId === "string";
}

function isOrpcStreamEndMessage(raw: unknown): raw is OrpcStreamEnd {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const record = raw as Record<string, unknown>;
  return record.type === "orpcStreamEnd" && typeof record.streamId === "string";
}

function isOrpcStreamErrorMessage(raw: unknown): raw is OrpcStreamError {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const record = raw as Record<string, unknown>;
  return (
    record.type === "orpcStreamError" &&
    typeof record.streamId === "string" &&
    typeof record.error === "string"
  );
}

class VscodeOrpcAsyncIterator<T> implements AsyncIterator<T>, AsyncIterable<T> {
  private readonly pending: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];

  private readonly buffered: T[] = [];
  private done = false;
  private error: Error | null = null;

  private readonly abortSignal: AbortSignal | undefined;
  private readonly abortListener: (() => void) | null;

  constructor(
    private readonly bridge: VscodeBridge,
    private readonly streamId: string,
    abortSignal: AbortSignal | undefined,
    private readonly onFinish: (() => void) | undefined,
    private readonly maxBufferedStreamEvents: number
  ) {
    this.abortSignal = abortSignal;

    if (abortSignal) {
      if (abortSignal.aborted) {
        this.abortListener = null;
        this.cancel("AbortSignal already aborted");
      } else {
        const listener = () => {
          this.cancel("AbortSignal aborted");
        };
        this.abortListener = listener;
        abortSignal.addEventListener("abort", listener, { once: true });
      }
    } else {
      this.abortListener = null;
    }
  }

  private cleanup(): void {
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }

    this.onFinish?.();
  }

  push(value: T): void {
    if (this.done) {
      return;
    }

    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    if (this.buffered.length >= this.maxBufferedStreamEvents) {
      this.cancel(`buffer overflow (maxBufferedStreamEvents=${this.maxBufferedStreamEvents})`);
      return;
    }

    this.buffered.push(value);
  }

  end(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.cleanup();

    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.cleanup();
    this.error = error instanceof Error ? error : new Error(String(error));

    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.reject(this.error);
    }
  }

  cancel(reason: string): void {
    if (this.done) {
      return;
    }

    try {
      this.bridge.postMessage({ type: "orpcStreamCancel", streamId: this.streamId });
    } catch {
      // Best-effort: the webview might be disposed.
    }

    this.fail(new Error(`Stream cancelled: ${reason}`));
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) {
      throw this.error;
    }

    if (this.buffered.length > 0) {
      const value = this.buffered.shift() as T;
      return { value, done: false };
    }

    if (this.done) {
      return { value: undefined as unknown as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.cancel("Iterator return() called");
    return { value: undefined as unknown as T, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

export function createVscodeOrpcLink(
  bridge: VscodeBridge,
  options: CreateVscodeOrpcLinkOptions = {}
): ClientLink<ClientContext> {
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_ORPC_CALL_TIMEOUT_MS;
  const maxBufferedStreamEvents = options.maxBufferedStreamEvents ?? DEFAULT_MAX_BUFFERED_STREAM_EVENTS;

  assert(typeof callTimeoutMs === "number" && callTimeoutMs >= 0, "callTimeoutMs must be >= 0");
  assert(
    typeof maxBufferedStreamEvents === "number" &&
      Number.isFinite(maxBufferedStreamEvents) &&
      maxBufferedStreamEvents > 0,
    "maxBufferedStreamEvents must be a finite number > 0"
  );

  const pendingCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      abortSignal?: AbortSignal | undefined;
      clearTimeout: () => void;
    }
  >();

  const activeStreams = new Map<string, VscodeOrpcAsyncIterator<unknown>>();

  bridge.onMessage((raw) => {
    if (isOrpcResponseMessage(raw)) {
      const pending = pendingCalls.get(raw.requestId);
      if (!pending) {
        return;
      }

      pendingCalls.delete(raw.requestId);
      pending.clearTimeout();

      if (!raw.ok) {
        pending.reject(new Error(raw.error));
        return;
      }

      if (raw.kind === "value") {
        pending.resolve(raw.value);
        return;
      }

      const iterator = new VscodeOrpcAsyncIterator<unknown>(
        bridge,
        raw.streamId,
        pending.abortSignal,
        () => activeStreams.delete(raw.streamId),
        maxBufferedStreamEvents
      );
      activeStreams.set(raw.streamId, iterator);
      pending.resolve(iterator);
      return;
    }

    if (isOrpcStreamDataMessage(raw)) {
      const stream = activeStreams.get(raw.streamId);
      stream?.push(raw.value);
      return;
    }

    if (isOrpcStreamEndMessage(raw)) {
      const stream = activeStreams.get(raw.streamId);
      stream?.end();
      return;
    }

    if (isOrpcStreamErrorMessage(raw)) {
      const stream = activeStreams.get(raw.streamId);
      stream?.fail(new Error(raw.error));
    }
  });

  const call = async (path: readonly string[], input: unknown, options: ClientOptions<ClientContext>) => {
    assert(Array.isArray(path), "ORPC call requires path array");

    const requestId = createRequestId();

    if (options.signal?.aborted) {
      throw new Error("ORPC call aborted before dispatch");
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const callPromise = new Promise<unknown>((resolve, reject) => {
      pendingCalls.set(requestId, {
        resolve,
        reject: (error) => reject(error),
        abortSignal: options.signal,
        clearTimeout: () => {
          if (!timeoutId) {
            return;
          }

          clearTimeout(timeoutId);
          timeoutId = null;
        },
      });
    });

    if (callTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const pending = pendingCalls.get(requestId);
        if (!pending) {
          return;
        }

        pendingCalls.delete(requestId);
        pending.clearTimeout();
        pending.reject(new Error(`ORPC call timed out after ${callTimeoutMs}ms`));

        try {
          bridge.postMessage({ type: "orpcCancel", requestId });
        } catch {
          // Best-effort: the webview might be disposed.
        }
      }, callTimeoutMs);
    }

    const onAbort = () => {
      const pending = pendingCalls.get(requestId);
      if (!pending) {
        return;
      }

      pendingCalls.delete(requestId);
      pending.clearTimeout();
      pending.reject(new Error("ORPC call aborted"));

      try {
        bridge.postMessage({ type: "orpcCancel", requestId });
      } catch {
        // Best-effort: the webview might be disposed.
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      try {
        bridge.postMessage({
          type: "orpcCall",
          requestId,
          path: [...path],
          input,
          lastEventId: options.lastEventId,
        });
      } catch (error) {
        const pending = pendingCalls.get(requestId);
        if (pending) {
          pendingCalls.delete(requestId);
          pending.clearTimeout();
        }

        throw error;
      }

      return await callPromise;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  };

  return { call };
}
