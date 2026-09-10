/**
 * Programmatic Tool Calling (PTC) Runtime Interface
 *
 * Abstract interface for JS sandboxes. Currently implemented by QuickJSRuntime,
 * but designed to allow future migration to libbun or other runtimes.
 */

import type {
  CaptureSanitizerBudget,
  PTCEvent,
  PTCExecutionResult,
  PTCToolCallRecord,
} from "./types";

/**
 * Resource limits for sandbox execution.
 */
export interface RuntimeLimits {
  /** Maximum memory in bytes (default: 64MB) */
  memoryBytes?: number;
  /** Maximum execution time in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

/**
 * Interface for a sandboxed JavaScript runtime.
 * Implements Disposable for automatic cleanup with `using` declarations.
 */
export interface IJSRuntime extends Disposable {
  /**
   * Execute JavaScript code in the sandbox.
   * Code is wrapped in an async IIFE to allow top-level await.
   * Returns execution result with partial results on failure.
   */
  eval(code: string): Promise<PTCExecutionResult>;

  /**
   * Register a host function callable from sandbox.
   * The function will be available as a global in the sandbox.
   */
  registerFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void;

  /**
   * Register an object with methods (for namespaced tools like mux.bash).
   * Each method on the object becomes callable from the sandbox.
   *
   * `syncMethods` are registered as plain synchronous host functions (no
   * asyncify). Asyncified methods can only suspend inside the evalCodeAsync
   * stack, so guest continuations resumed after `await somePromise` cannot
   * call them — namespace members that must stay callable post-await (e.g.
   * mux.events) go here instead.
   */
  registerObject(
    name: string,
    obj: Record<string, (...args: unknown[]) => Promise<unknown>>,
    syncMethods?: Record<string, (...args: unknown[]) => unknown>
  ): void;

  /**
   * Register a host function that returns a real Promise INTO the guest
   * (async capability bridge). Unlike registerFunction (asyncified: guest
   * blocks until the host settles), the guest receives the Promise
   * immediately and may await it, chain it, or ignore it (fire-and-forget).
   * eval() waits for in-flight capability promises the returned value depends
   * on, bounded by the same deadline/interrupt semantics.
   */
  registerPromiseFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void;

  /**
   * Register a synchronous host function (no asyncify, no suspension).
   * Required for bridges that must be callable from guest continuations
   * resumed via executePendingJobs (e.g. code after `await capability()`),
   * where asyncified functions cannot suspend. Keep these fast and pure-ish:
   * they block the guest.
   */
  registerSyncFunction(name: string, fn: (...args: unknown[]) => unknown): void;

  /**
   * Write a string property onto the guest `vars` global from the host.
   * Safe to call from inside a registered host function (the VM is suspended
   * but the context is usable — the same window marshal/dump already use) or
   * between evals. Recreates `vars` if the guest clobbered it. Throws when
   * the write does not stick (r29: a guest Proxy vars can swallow writes),
   * so callers surface an honest failure instead of a fake success. Used by
   * mux.load (r12) to place bulk file content into the kernel without ever
   * transiting the model-visible record.
   */
  setVarsProperty(key: string, value: string): void;

  /**
   * Bound guest-supplied args/results captured into tool-call records and
   * streamed events at CREATION time (kernel mode). Post-eval compaction
   * cannot protect host memory or the session history that streamed events
   * land in: a guest looping `xum.tool({big: vars.large})` would otherwise
   * retain and emit every full payload. Pass undefined to disable (ephemeral
   * mode keeps full records — the non-RLM inline-results contract).
   */
  setKernelRecordBounds(bounds: KernelRecordBounds | undefined): void;

  /**
   * Sanitize results captured into records/events at CREATION time in ALL
   * modes (classic + kernel). Unlike setKernelRecordBounds this never bounds
   * ordinary results — the non-RLM inline-results contract keeps them inline —
   * it exists for media containers, whose aggregate base64 must be budgeted
   * before events/records persist into session history (request-time
   * attachment extraction rewrites only the provider copy, never
   * partial.json/chat.jsonl). The guest-visible value is never sanitized.
   * Pass undefined to disable.
   */
  setCaptureResultSanitizer(
    sanitizer:
      | ((toolName: string, result: unknown, budget?: CaptureSanitizerBudget) => unknown)
      | undefined
  ): void;

  /**
   * Shared per-execution capture-sanitizer budget for a classic (non-kernel)
   * execution's record array. The outer return value persists into the same
   * history row as the nested records, so it must draw from the SAME
   * allowance (r29) — sanitizing it against a fresh per-value budget would
   * let one execution retain roughly twice the intended media bound.
   */
  classicCaptureBudgetFor?(toolCalls: PTCToolCallRecord[]): CaptureSanitizerBudget;

  /**
   * Route late guest-continuation execution through a host-provided gate.
   * When a fire-and-forget capability (registerPromiseFunction) settles after
   * its originating eval() returned, the runtime must run pending guest jobs —
   * but on a shared/persistent runtime that must not interleave with a later
   * eval. The gate lets the owner (e.g. SandboxMount) serialize the run under
   * its exclusive lock. Without a gate, jobs run immediately on settlement.
   */
  setPendingJobGate(gate: (run: () => void) => void): void;

  /**
   * Set memory/CPU limits for the sandbox.
   * Must be called before eval() to take effect.
   */
  setLimits(limits: RuntimeLimits): void;

  /**
   * Subscribe to events for UI streaming (tool calls, console output).
   * Only one handler can be active at a time.
   */
  onEvent(handler: (event: PTCEvent) => void): void;

  /**
   * Abort the currently running execution.
   * The sandbox will stop at the next interrupt check point.
   */
  abort(): void;

  /**
   * Get the abort signal for the current execution.
   * This signal is aborted when the sandbox times out or abort() is called.
   * Used by tool bridge to propagate cancellation to nested tool calls.
   */
  getAbortSignal(): AbortSignal | undefined;

  /**
   * Consume the record callId of the host call currently being dispatched.
   * The runtime sets it synchronously immediately before invoking a
   * registered host function, and the tool bridge must read it as its FIRST
   * synchronous operation (before any await): the value is only coherent
   * inside that same synchronous window. Consuming (clear-on-read) prevents a
   * stale id from leaking into a host function invoked outside the runtime
   * dispatch path. Bridges use it as the nested tool call's toolCallId so
   * UI events emitted by the tool (workflow-run-attached, task-created, live
   * bash output) land on the SAME id the transcript's nested record carries.
   */
  takeActiveHostCallId(): string | undefined;

  /**
   * Clean up resources. Called automatically with `using` declarations.
   */
  dispose(): void;
}

/** Caps applied to record/event capture when kernel record bounding is on. */
export interface KernelRecordBounds {
  /** Max serialized bytes of `args` kept in a record/event. */
  argsCapBytes: number;
  /** Max serialized bytes of `result` kept in a record/event. */
  resultCapBytes: number;
  /**
   * Capture-time retain override for records that must keep (a possibly
   * sanitized form of) their full result — persistence-critical tools and
   * extractable media containers (see retainExemptKernelRecordResult):
   * post-eval compaction and request-time extractors need the payload.
   * Returns the value to retain in the record, or undefined to apply normal
   * result bounding. Args and errors stay bounded regardless.
   */
  captureRetained?: (toolName: string, result: unknown) => unknown;
  /**
   * Attribution fields merged onto a __kernelBounded ARGS marker when
   * bounding replaces the args of a record (see
   * retainPersistenceCriticalArgsFields): post-compaction extractors need the
   * validated file path of an oversized file_edit_* call to attribute its
   * retained diff. Marker fields win on key collisions.
   */
  captureArgsRetained?: (toolName: string, args: unknown) => Record<string, unknown> | undefined;
  /**
   * Identity fields merged onto a __kernelBounded RESULT marker when bounding
   * replaces the result of a record (see retainWorkflowResultIdentityFields):
   * an oversized workflow_run/workflow_resume result would otherwise lose the
   * runId and status the transcript card needs to re-render the durable run
   * after reload. Marker fields win on key collisions, so retained fields can
   * never spoof __kernelBounded/bytes/preview.
   */
  captureResultRetained?: (
    toolName: string,
    result: unknown
  ) => Record<string, unknown> | undefined;
}

/**
 * Factory for creating JS runtime instances.
 */
export interface IJSRuntimeFactory {
  create(): Promise<IJSRuntime>;
}
