/**
 * QuickJS Runtime Implementation
 *
 * Implements IJSRuntime using quickjs-emscripten for sandboxed JavaScript execution.
 * Uses Asyncify to allow async host functions to appear synchronous in the sandbox.
 */

import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { QuickJSAsyncFFI } from "@jitl/quickjs-wasmfile-release-asyncify/ffi";
import crypto from "crypto";
import type { IJSRuntime, IJSRuntimeFactory, KernelRecordBounds, RuntimeLimits } from "./runtime";
import type { PTCEvent, PTCExecutionResult, PTCToolCallRecord, PTCConsoleRecord } from "./types";
import type { CaptureSanitizerBudget } from "./types";
import { createCaptureSanitizerBudget } from "./types";
import {
  CONSOLE_CAPTURE_BUDGET_BYTES,
  KERNEL_RETAINED_EXECUTION_BUDGET_BYTES,
} from "@/constants/kernelOutput";
import { sliceUtf8Bytes } from "@/common/utils/sliceUtf8Bytes";

/** Capture-time console retention accounting for one eval (see setupConsole). */
interface ConsoleCaptureBudget {
  retainedBytes: number;
  droppedRecords: number;
  /** The truncation record installed when the budget tripped; its text is
   * updated in place as later drops accumulate. Null while under budget. */
  marker: PTCConsoleRecord | null;
}
import { UNAVAILABLE_IDENTIFIERS } from "./staticAnalysis";

// Default limits
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** One QuickJS context can mint at most 65,536 host-function ids over its
 * lifetime (quickjs-emscripten stores them in a signed 16-bit slot). Past
 * that, ids silently wrap on the C side and guest calls dispatch to whatever
 * closure minted the aliased id 65,536 allocations earlier. Handle reuse in
 * registerObject keeps steady-state allocation near zero, so approaching this
 * limit means an unbounded-registration bug; fail loudly instead of letting
 * dispatch corrupt. */
const HOST_FN_ID_LIMIT = 60_000;

/** Generate a short random ID for PTC nested tool calls (10 hex chars). */
function generateCallId(): string {
  return crypto.randomBytes(5).toString("hex");
}

/** Guest globals used for per-reaction attribution (see REACTION_TAGGING_SCRIPT). */
const EVAL_GENERATION_GLOBAL = "__muxEvalGeneration";
const REACTION_OWNER_GLOBAL = "__muxReactionOwner";
const RETAIN_GENERATION_FN = "__muxRetainGeneration";
const RELEASE_GENERATION_FN = "__muxReleaseGeneration";
const WRAP_PROMISE_FN = "__muxWrapPromise";

/**
 * Installed once per context: tags every promise reaction with the eval
 * generation that REGISTERED it. Persistent mounts share one context across
 * evals, and a capability promise from eval N can settle while eval M runs —
 * QuickJS's job queue carries no per-job ownership, so registration is the
 * only point where the owner is knowable.
 *
 * Mechanics:
 * - Promise.prototype.then is patched (catch()/finally() delegate to then()
 *   per spec) to wrap callbacks: the owner global is set for the callback's
 *   duration, and a restore job is enqueued AFTER the callback instead of
 *   restoring synchronously — so jobs the callback itself enqueued (await
 *   resumptions it resolved) still run under its owner (one-hop ownership
 *   propagation).
 * - Each tagged registration retains its owner's attribution context via a
 *   host refcount (RETAIN/RELEASE_GENERATION_FN) so contexts live exactly as
 *   long as outstanding reactions, not a fixed eval count.
 * - Capability promises are wrapped in a Promise SUBCLASS (WRAP_PROMISE_FN):
 *   `await` on a non-%Promise%-constructor promise goes through the thenable
 *   path, which calls the PATCHED then — so await continuations on
 *   capability promises are tagged too, not just explicit .then chains.
 *
 * Host entry points (console, capability calls) read the owner global to
 * route records to the owning eval's context. Best-effort observability, not
 * a security boundary: guests can overwrite the patch, and exotic untagged
 * chains (await on plain guest promises) fall back to the drain context.
 */
const REACTION_TAGGING_SCRIPT = `
(() => {
  const origThen = Promise.prototype.then;
  const origResolve = Promise.resolve.bind(Promise);
  const retain = globalThis.${RETAIN_GENERATION_FN};
  const release = globalThis.${RELEASE_GENERATION_FN};
  // Monotonic count of tagged-callback runs; guards deferred restores.
  let tagEpoch = 0;
  Promise.prototype.then = function (onFulfilled, onRejected) {
    const owner =
      globalThis.${REACTION_OWNER_GLOBAL} !== undefined
        ? globalThis.${REACTION_OWNER_GLOBAL}
        : globalThis.${EVAL_GENERATION_GLOBAL};
    if (owner === undefined) {
      return origThen.call(this, onFulfilled, onRejected);
    }
    if (typeof onFulfilled !== "function" && typeof onRejected !== "function") {
      // No user callback can run; nothing to tag or retain.
      return origThen.call(this, onFulfilled, onRejected);
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) { released = true; release(owner); }
    };
    // BOTH branches are wrapped (with the spec's identity/rethrow defaults
    // for missing handlers) so exactly one wrapper runs at settlement and
    // the retain is ALWAYS released — a single-handler reaction settling
    // through the opposite branch must not leak its owner refcount.
    const wrap = (fn, fallback) =>
      function (value) {
        const prev = globalThis.${REACTION_OWNER_GLOBAL};
        globalThis.${REACTION_OWNER_GLOBAL} = owner;
        tagEpoch += 1;
        const myEpoch = tagEpoch;
        try {
          // Plain call (no receiver): native reactions invoke handlers with
          // an undefined this — forwarding the sloppy-mode wrapper's
          // globalThis would change strict-mode handler semantics.
          return typeof fn === "function" ? fn(value) : fallback(value);
        } finally {
          releaseOnce();
          // Deferred one-hop restore: jobs this callback enqueued run
          // before the restore job, inheriting its owner. Epoch-guarded
          // so a restore from an EARLIER callback in a settlement
          // cascade cannot clear the owner out from under a LATER
          // callback's still-queued continuations (the host resets the
          // owner at every drain-batch boundary regardless).
          origThen.call(origResolve(), () => {
            if (tagEpoch === myEpoch) {
              globalThis.${REACTION_OWNER_GLOBAL} = prev;
            }
          });
        }
      };
    retain(owner);
    try {
      return origThen.call(
        this,
        wrap(onFulfilled, (value) => value),
        wrap(onRejected, (reason) => { throw reason; })
      );
    } catch (registrationError) {
      // Registration failed (non-promise receiver, throwing Symbol.species
      // constructor, ...): no wrapper will ever run, so release the retain
      // here or the owner's context leaks toward the hard cap.
      releaseOnce();
      throw registrationError;
    }
  };
  // Subclass wrapper for capability promises: \`await\` on a promise whose
  // constructor is not %Promise% takes the spec's thenable path, which calls
  // the PATCHED then — tagging await continuations at registration time.
  class MuxCapabilityPromise extends Promise {}
  globalThis.${WRAP_PROMISE_FN} = (promise) => MuxCapabilityPromise.resolve(promise);
})();
`;

/** Per-eval attribution sinks; see generationContexts. */
interface AttributionContext {
  toolCalls: PTCToolCallRecord[];
  consoleOutput: PTCConsoleRecord[];
  eventHandler: ((event: PTCEvent) => void) | undefined;
}

/** Attribution context plus the number of outstanding tagged reactions that
 * still reference it (guest-driven retain/release). */
interface GenerationContextEntry {
  context: AttributionContext;
  refs: number;
}

/** Soft cap on retained IDLE (refs === 0) attribution contexts. Generations
 * with outstanding reactions are always retained; a hard cap bounds memory
 * against pathological never-settling registrations. */
const MAX_IDLE_GENERATION_CONTEXTS = 8;
const MAX_GENERATION_CONTEXTS = 64;

/**
 * QuickJS-based JavaScript runtime for PTC.
 * Uses Asyncify build for async host function support.
 */
export class QuickJSRuntime implements IJSRuntime {
  private disposed = false;
  private eventHandler?: (event: PTCEvent) => void;
  private abortController?: AbortController;
  /** See IJSRuntime.takeActiveHostCallId: set synchronously right before a
   * registered host function is invoked, consumed by the tool bridge inside
   * that same synchronous window. */
  private activeHostCallId?: string;
  private abortRequested = false; // Track abort requests before eval() starts
  private limits: RuntimeLimits = {};
  private consoleSetup = false;
  /** Serializes late-settlement guest continuations; see setPendingJobGate. */
  private pendingJobGate?: (run: () => void) => void;
  /** Kernel-mode caps on record/event capture; see IJSRuntime.setKernelRecordBounds. */
  private kernelRecordBounds?: KernelRecordBounds;
  /** Mode-independent record sanitizer; see IJSRuntime.setCaptureResultSanitizer. */
  private captureResultSanitizer?: (
    toolName: string,
    result: unknown,
    budget?: CaptureSanitizerBudget
  ) => unknown;
  /** Per-execution shared media budget for the capture sanitizer in CLASSIC
   * (non-kernel) mode, keyed like retainedResultBudgets. Classic records keep
   * full inline results and have no kernel caps, so without sharing, every
   * call would mint a fresh per-value media allowance and a model-authored
   * loop of bridged media calls could persist unbounded multi-megabyte
   * records into partial/final history (r19). Kernel mode keeps per-call
   * allowances — its cross-call growth is already bounded by
   * retainedResultBudgets. */
  private readonly classicSanitizerBudgets = new WeakMap<
    PTCToolCallRecord[],
    CaptureSanitizerBudget
  >();
  /** Per-execution byte budgets for RETAINED record results, keyed by the
   * attribution's record array like consoleBudgets (fresh array per eval;
   * late fire-and-forget settlements share their originating eval's budget).
   * Retained results bypass the per-record kernel bound by design, so their
   * SUM must be bounded here (see boundCaptureResult). */
  private readonly retainedResultBudgets = new WeakMap<
    PTCToolCallRecord[],
    { remainingBytes: number }
  >();
  /** Monotonic eval counter + the generation currently inside eval() (null
   * between evals). Distinguishes settlements arriving mid-eval (queued for
   * the eval's own drain points) from truly-late ones between evals (gated).
   * Reaction attribution is per-registration via REACTION_TAGGING_SCRIPT +
   * generationContexts; the drain-context swaps are only the fallback for
   * untagged (await-registered) continuations. */
  private evalGeneration = 0;
  private activeEvalGeneration: number | null = null;
  /** Attribution sinks per eval generation. Tagged reactions route their
   * console output and nested capability records to the eval that REGISTERED
   * them, no matter which eval's drain executes the job. Retention is
   * refcount-driven (outstanding tagged reactions), with a soft cap on idle
   * entries and a hard memory bound; see pruneGenerationContexts. */
  private readonly generationContexts = new Map<number, GenerationContextEntry>();
  /** True only while eval()'s returned-value resolve loop coordinates VM
   * access (evalCodeAsync completed, VM idle at the top level). Settlements
   * may touch the VM directly ONLY then: during asyncified suspension the
   * WASM stack is unwound and re-entry would corrupt it, and between evals
   * another call may own the runtime. */
  private directSettleAllowed = false;
  /** VM-facing settlements that could not safely touch the VM on arrival:
   * either the active eval was suspended inside an asyncified call, or the
   * settlement landed between evals and must serialize through the
   * pending-job gate (whose lock acquisition can lose the race to the next
   * code_execution call). Drained at eval start, by the resolve loop, at
   * eval end, and by the gate — whichever runs first; later drains see an
   * empty queue. */
  private readonly queuedLateSettlements: Array<() => void> = [];
  /** Current registration per registerObject name; guest methods dispatch
   * through this at call time so re-registration retargets saved references. */
  private readonly registeredObjects = new Map<
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>>
  >();
  /** Same late-bound dispatch for registerObject sync methods: guest-saved
   * references must never pin a replaced implementation. */
  private readonly registeredObjectSyncMethods = new Map<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >();
  /** Guest host-function handles cached per registerObject name + method.
   * Re-registration must not mint fresh host-function ids (see
   * HOST_FN_ID_LIMIT): persistent mounts re-register the tool bridge on
   * every eval, which exhausted the 16-bit id space in a few hundred calls
   * and misrouted every later xum.* call to an unrelated tool. Dispatch is
   * late-bound through the maps above, so a cached guest function stays
   * correct across re-registrations; only never-seen method names allocate. */
  private readonly registeredObjectFnHandles = new Map<
    string,
    Map<string, { kind: "async" | "sync"; handle: QuickJSHandle }>
  >();
  /** Host-function ids minted on this context; see HOST_FN_ID_LIMIT. */
  private hostFnAllocations = 0;

  // Execution state (reset per eval)
  private toolCalls: PTCToolCallRecord[] = [];
  private consoleOutput: PTCConsoleRecord[] = [];
  /** Per-eval console capture budgets, keyed by the attribution's console
   * array (see consoleBudgetFor); WeakMap so budgets die with their eval. */
  private readonly consoleBudgets = new WeakMap<PTCConsoleRecord[], ConsoleCaptureBudget>();

  // In-flight async-capability promises (registerPromiseFunction). eval()'s
  // resolve loop awaits these when the returned value is still pending, so a
  // guest `await` on a capability promise is not misreported as stuck.
  // NOT reset per eval: fire-and-forget capabilities from a previous call on a
  // persistent mount may legitimately still be settling.
  private readonly pendingHostPromises = new Set<Promise<void>>();

  private constructor(private readonly ctx: QuickJSAsyncContext) {
    // Install per-reaction attribution before ANY registration or eval:
    // registerPromiseFunction wraps its returned promises via the guest
    // helper this script defines.
    this.setupReactionTagging();
  }

  static async create(): Promise<QuickJSRuntime> {
    // Create the async variant manually due to bun's package export resolution issues.
    // The self-referential import in the variant package doesn't resolve correctly.
    const variant = {
      type: "async" as const,
      importFFI: () => Promise.resolve(QuickJSAsyncFFI),
      // eslint-disable-next-line @typescript-eslint/require-await -- sync require wrapped for interface
      importModuleLoader: async () => {
        // Use require() with the named export path since bun's dynamic import()
        // doesn't resolve package exports correctly from within node_modules
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        const mod = require("@jitl/quickjs-wasmfile-release-asyncify/emscripten-module");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
        return mod.default ?? mod;
      },
    };

    const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
    const ctx = QuickJS.newContext();
    return new QuickJSRuntime(ctx);
  }

  setLimits(limits: RuntimeLimits): void {
    this.limits = limits;

    // Apply memory limit to the runtime
    const memoryBytes = limits.memoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.ctx.runtime.setMemoryLimit(memoryBytes);
  }

  onEvent(handler: (event: PTCEvent) => void): void {
    this.eventHandler = handler;
  }

  registerFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    this.assertNotDisposed("registerFunction");

    const handle = this.newAsyncifiedHostFunction(name, async (...argHandles) => {
      if (this.abortController?.signal.aborted) {
        throw new Error("Execution aborted");
      }

      // Convert QuickJS handles to JS values - cast to unknown at the FFI boundary
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      const startTime = Date.now();
      // Generate our own callId for nested tool calls. Regular tool calls get IDs from
      // the model (e.g. Anthropic's toolu_*, OpenAI's call_*), but PTC nested calls are
      // executed in our sandbox, not requested by the model.
      const callId = generateCallId();

      // Kernel mode bounds captured args/results at creation: records and
      // streamed events must never retain full guest payloads (host memory +
      // session history growth); the guest still receives full values.
      const recordArgs = this.boundCaptureArgs(args[0], name, this.toolCalls);

      // Emit start event
      this.eventHandler?.({
        type: "tool-call-start",
        callId,
        toolName: name,
        args: recordArgs,
        startTime,
      });

      try {
        // Hand the record callId to the dispatched function (tool bridge)
        // through the synchronous window contract; see takeActiveHostCallId.
        this.activeHostCallId = callId;
        const result = await fn(...args);
        const endTime = Date.now();
        const duration_ms = endTime - startTime;
        const recordResult = this.boundCaptureResult(result, name, this.toolCalls);

        // Record tool call
        this.toolCalls.push({
          toolName: name,
          args: recordArgs,
          result: recordResult,
          duration_ms,
        });

        // Emit end event
        this.eventHandler?.({
          type: "tool-call-end",
          callId,
          toolName: name,
          args: recordArgs,
          result: recordResult,
          startTime,
          endTime,
        });

        // Marshal result back to QuickJS
        return this.marshal(result);
      } catch (error) {
        const endTime = Date.now();
        const duration_ms = endTime - startTime;
        const errorStr = error instanceof Error ? error.message : String(error);
        const recordError = this.boundCaptureError(errorStr);

        // Record failed tool call
        this.toolCalls.push({
          toolName: name,
          args: recordArgs,
          error: recordError,
          duration_ms,
        });

        // Emit end event with error
        this.eventHandler?.({
          type: "tool-call-end",
          callId,
          toolName: name,
          args: recordArgs,
          error: recordError,
          startTime,
          endTime,
        });

        // Re-throw to propagate error to sandbox
        throw error;
      }
    });

    this.ctx.setProp(this.ctx.global, name, handle);
    handle.dispose();
  }

  registerPromiseFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    this.assertNotDisposed("registerPromiseFunction");

    // Plain (non-asyncified) host function: it must return synchronously, so
    // it hands the guest a deferred VM promise and settles it when the host
    // promise settles. This is the async capability bridge: the guest can
    // fire-and-forget or await the returned Promise.
    const fnHandle = this.newHostFunction(name, (...argHandles) => {
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      const startTime = Date.now();
      const callId = generateCallId();
      const deferred = this.ctx.newPromise();

      // Capture per-eval attribution state NOW: a fire-and-forget capability
      // can settle after its originating eval() returned (timeout/abort or
      // un-awaited call). eval() swaps this.toolCalls/this.eventHandler per
      // execution, so consulting them at settlement would report the record
      // under a later eval and emit it to the wrong handler. Resolved via
      // currentAttribution(): a capability started inside a tagged reaction
      // records to the eval that REGISTERED the reaction, not whichever
      // eval's drain happens to execute it.
      const attribution = this.currentAttribution();
      const toolCalls = attribution.toolCalls;
      const consoleOutput = attribution.consoleOutput;
      const eventHandler = attribution.eventHandler;

      eventHandler?.({
        type: "tool-call-start",
        callId,
        toolName: name,
        args: args[0],
        startTime,
      });

      // VM-facing settlement: marshal + resolve/reject + drain continuations.
      // May touch the VM directly ONLY while an eval's resolve loop is
      // coordinating (directSettleAllowed): during asyncified suspension the
      // WASM stack is unwound and re-entry would corrupt it, and between
      // evals another call may own the runtime. Routing through the gate
      // while an eval holds the mount lock would deadlock (the gate waits on
      // that very lock), so mid-eval arrivals are queued for the eval's own
      // drain points instead.
      const settleInVm = (run: () => void) => {
        const execute = () => {
          if (this.disposed) return;
          // Reaction attribution is per-registration: tagged callbacks route
          // console output and nested capability records to the eval that
          // registered them via currentAttribution(), regardless of which
          // drain executes the job. The branches below only choose the
          // FALLBACK context for untagged (await-registered) continuations.
          if (this.activeEvalGeneration !== null) {
            // A consuming eval is draining: fall back to its state (it may
            // have created untagged continuations on this promise itself).
            // The originating eval still owns the tool-call record via the
            // attribution captured at call time above.
            run();
            this.drainPendingJobs();
            this.clearReactionOwner();
            return;
          }
          // Between evals: fall back to the ORIGINATING eval's attribution
          // state — the runtime's mutable fields may have been swapped by
          // later evals. Restore afterwards.
          const prevToolCalls = this.toolCalls;
          const prevConsoleOutput = this.consoleOutput;
          const prevEventHandler = this.eventHandler;
          this.toolCalls = toolCalls;
          this.consoleOutput = consoleOutput;
          this.eventHandler = eventHandler;
          try {
            run();
            this.drainPendingJobs();
            this.clearReactionOwner();
          } finally {
            this.toolCalls = prevToolCalls;
            this.consoleOutput = prevConsoleOutput;
            this.eventHandler = prevEventHandler;
          }
        };
        if (this.directSettleAllowed) {
          // The active eval is parked in its resolve loop: the VM is idle at
          // the top level and this call's owner holds the mount lock, so the
          // settlement may land now (the loop may itself be awaiting it).
          execute();
          return;
        }
        this.queuedLateSettlements.push(execute);
        if (this.activeEvalGeneration !== null) {
          // The active eval is suspended inside an asyncified capability
          // call: touching the VM would re-enter the unwound WASM stack.
          // The eval's resolve loop or finally-block drain lands the queue.
          return;
        }
        if (this.pendingJobGate) {
          // Between evals on a shared runtime: schedule a serialized drain.
          this.pendingJobGate(() => this.drainQueuedLateSettlements());
        } else {
          // Between evals on a single-owner (ephemeral) runtime: the VM is
          // idle and nothing else can hold it — land immediately.
          this.drainQueuedLateSettlements();
        }
      };

      const settle = (async () => {
        try {
          const result = await fn(...args);
          const endTime = Date.now();
          // Same creation-time bounding as synchronous bridges (kernel mode).
          const recordArgs = this.boundCaptureArgs(args[0], name, toolCalls);
          const recordResult = this.boundCaptureResult(result, name, toolCalls);
          toolCalls.push({
            toolName: name,
            args: recordArgs,
            result: recordResult,
            duration_ms: endTime - startTime,
          });
          eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: name,
            args: recordArgs,
            result: recordResult,
            startTime,
            endTime,
          });
          settleInVm(() => {
            const valueHandle = this.marshal(result);
            deferred.resolve(valueHandle);
            valueHandle.dispose();
          });
        } catch (error) {
          const endTime = Date.now();
          const errorStr = error instanceof Error ? error.message : String(error);
          const recordError = this.boundCaptureError(errorStr);
          const recordArgs = this.boundCaptureArgs(args[0], name, toolCalls);
          toolCalls.push({
            toolName: name,
            args: recordArgs,
            error: recordError,
            duration_ms: endTime - startTime,
          });
          eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: name,
            args: recordArgs,
            error: recordError,
            startTime,
            endTime,
          });
          settleInVm(() => {
            const errorHandle = this.marshal({ name: "Error", message: errorStr });
            deferred.reject(errorHandle);
            errorHandle.dispose();
          });
        }
      })();

      // Track settlement so eval()'s resolve loop can wait on it. The tracked
      // promise never rejects (settle() catches everything above). Note: for
      // gated late settlements this resolves when the settlement is HANDED to
      // the gate; the VM effect lands when the gate runs it under the lock.
      const tracked: Promise<void> = settle.finally(() => {
        this.pendingHostPromises.delete(tracked);
      });
      this.pendingHostPromises.add(tracked);

      // Consume the settled promise: nothing chains on it anymore (the gate
      // handles continuation draining), and an unconsumed rejection would be
      // reported as unhandled.
      deferred.settled.catch(() => undefined);

      // Hand the guest a tagged capability promise (Promise subclass) so
      // `await` continuations are attributed at registration time; see
      // REACTION_TAGGING_SCRIPT. Fall back to the raw promise if wrapping
      // fails (attribution degrades; behavior does not).
      const wrapFnHandle = this.ctx.getProp(this.ctx.global, WRAP_PROMISE_FN);
      const wrapResult = this.ctx.callFunction(wrapFnHandle, this.ctx.undefined, deferred.handle);
      wrapFnHandle.dispose();
      if (wrapResult.error) {
        wrapResult.error.dispose();
        // Ownership of deferred.handle transfers to the wrapper (return value).
        return deferred.handle;
      }
      deferred.handle.dispose();
      return wrapResult.value;
    });

    this.ctx.setProp(this.ctx.global, name, fnHandle);
    fnHandle.dispose();
  }

  setKernelRecordBounds(bounds: KernelRecordBounds | undefined): void {
    this.kernelRecordBounds = bounds;
  }

  setCaptureResultSanitizer(
    sanitizer:
      | ((toolName: string, result: unknown, budget?: CaptureSanitizerBudget) => unknown)
      | undefined
  ): void {
    this.captureResultSanitizer = sanitizer;
  }

  /**
   * Bound a guest-supplied value at record/event CREATION time (kernel mode
   * only). Records live in host memory for the whole eval and events land in
   * partial/final session history via the stream manager, so post-eval
   * compaction cannot protect either — a guest looping large nested args
   * would otherwise grow both without bound. The marker keeps the true size
   * so downstream compaction reports honest byte counts.
   */
  private boundCapture(value: unknown, capBytes: number): unknown {
    if (this.kernelRecordBounds === undefined) return value;
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? "";
    } catch {
      // Bridged values are JSON round-tripped, so this is unreachable in
      // practice; suppress rather than risk leaking via toString.
      return { __kernelBounded: true, bytes: 0, preview: "[unserializable]" };
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= capBytes) return value;
    return {
      __kernelBounded: true,
      bytes,
      // capBytes is a byte budget: slice by UTF-8 bytes, not code units
      // (multibyte text would otherwise retain up to ~4x the cap).
      preview: `${sliceUtf8Bytes(serialized, capBytes)}…[${bytes} bytes total; truncated]`,
    };
  }

  private boundCaptureArgs(
    value: unknown,
    toolName: string,
    toolCalls: PTCToolCallRecord[]
  ): unknown {
    if (this.kernelRecordBounds === undefined) {
      // Classic mode has no args cap, but media containers passed AS
      // ARGUMENTS to another bridged tool (e.g. {payload: image}) would
      // otherwise copy unbudgeted base64 into every start/end event and
      // record (r22) — the result sanitizer only covers the producing call.
      // Sanitize against the same shared per-execution budget; the guest
      // still passes the full value to the tool.
      return this.captureResultSanitizer !== undefined
        ? this.captureResultSanitizer(toolName, value, this.classicCaptureBudgetFor(toolCalls))
        : value;
    }
    const bounded = this.boundCapture(value, this.kernelRecordBounds.argsCapBytes);
    if (bounded === value) return value;
    // The marker replaced the args entirely: merge back attribution fields
    // (e.g. the file path of a persistence-critical edit) so post-compaction
    // extractors can still attribute the record. Marker fields are spread
    // last so retained fields can never spoof __kernelBounded/bytes/preview.
    const retained = this.kernelRecordBounds.captureArgsRetained?.(toolName, value);
    return retained !== undefined ? { ...retained, ...(bounded as object) } : bounded;
  }

  /**
   * Bound error strings captured into records/events (kernel mode). Host
   * error messages can embed guest-supplied data verbatim — e.g. ENAMETOOLONG
   * echoes a multi-megabyte path — and record errors stay model-visible
   * through compaction, so an unbounded message would reopen the context
   * leak that args/result bounding closed. The guest-facing rejection keeps
   * the full message (kernel-side only; return values are bounded anyway).
   */
  private boundCaptureError(errorStr: string): string {
    if (this.kernelRecordBounds === undefined) return errorStr;
    const capBytes = this.kernelRecordBounds.argsCapBytes;
    const bytes = Buffer.byteLength(errorStr, "utf8");
    if (bytes <= capBytes) return errorStr;
    // Byte-safe truncation for the same reason as boundCapture.
    return `${sliceUtf8Bytes(errorStr, capBytes)}…[${bytes} bytes total; truncated]`;
  }

  private boundCaptureResult(
    value: unknown,
    toolName: string,
    toolCalls: PTCToolCallRecord[]
  ): unknown {
    // The mode-independent sanitizer runs first (both classic and kernel
    // mode): media containers are budgeted at capture because records/events
    // persist into session history in every mode, and request-time
    // attachment extraction rewrites only the provider copy. Classic mode
    // shares ONE sanitizer budget per execution (see classicSanitizerBudgets);
    // kernel mode keeps per-call allowances backed by the retained budget.
    const sanitized =
      this.captureResultSanitizer !== undefined
        ? this.captureResultSanitizer(
            toolName,
            value,
            this.kernelRecordBounds === undefined
              ? this.classicCaptureBudgetFor(toolCalls)
              : undefined
          )
        : value;
    if (this.kernelRecordBounds === undefined) return sanitized;
    // Retained records (persistence-critical tools, media containers) keep a
    // possibly sanitized full result: compaction and request-time extractors
    // reconstruct context from them, so a bounded preview would silently
    // lose it.
    const retained = this.kernelRecordBounds.captureRetained?.(toolName, sanitized);
    if (retained !== undefined) {
      // Execution-wide budget on retained results: each is individually
      // bounded, but retention bypasses the per-record kernel cap by design,
      // so a loop of retained calls would otherwise append ~3MiB containers
      // or 50k-char persistence records without limit. Unserializable
      // values count as overflow — never retain for free.
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(retained) ?? "", "utf8");
      } catch {
        size = Number.POSITIVE_INFINITY;
      }
      const budget = this.retainedBudgetFor(toolCalls);
      if (size <= budget.remainingBytes) {
        budget.remainingBytes -= size;
        return retained;
      }
      // Budget exhausted: fall back to normal bounding — oversized results
      // become honest-size markers, small results still pass inline.
      return this.applyRetainedResultFields(
        QuickJSRuntime.preserveSuccessBit(
          this.boundCapture(sanitized, this.kernelRecordBounds.resultCapBytes),
          retained
        ),
        toolName,
        sanitized
      );
    }
    return this.applyRetainedResultFields(
      QuickJSRuntime.preserveSuccessBit(
        this.boundCapture(sanitized, this.kernelRecordBounds.resultCapBytes),
        sanitized
      ),
      toolName,
      sanitized
    );
  }

  /** Merge captureResultRetained identity fields under a __kernelBounded
   * result marker (marker fields win on collisions, mirroring the
   * captureArgsRetained merge in boundCaptureArgs). No-op for results that
   * survived bounding inline. */
  private applyRetainedResultFields(bounded: unknown, toolName: string, source: unknown): unknown {
    if (
      typeof bounded !== "object" ||
      bounded === null ||
      (bounded as { __kernelBounded?: boolean }).__kernelBounded !== true
    ) {
      return bounded;
    }
    const retained = this.kernelRecordBounds?.captureResultRetained?.(toolName, source);
    return retained !== undefined ? { ...retained, ...bounded } : bounded;
  }

  /** A boolean success bit is preserved onto EVERY __kernelBounded result
   * marker (r29 — not just the retained-budget-exhausted branch): compaction
   * folds result.success===false into the compact ok bit, and a FAILED call
   * whose oversized result was replaced by a marker would otherwise be
   * misreported as ok:true — advertising a never-applied edit path or a
   * never-read file in crash-safe attachment tracking. */
  private static preserveSuccessBit(bounded: unknown, source: unknown): unknown {
    if (typeof source !== "object" || source === null) return bounded;
    const success = (source as { success?: unknown }).success;
    if (
      typeof success === "boolean" &&
      typeof bounded === "object" &&
      bounded !== null &&
      (bounded as { __kernelBounded?: boolean }).__kernelBounded === true
    ) {
      return { ...bounded, success };
    }
    return bounded;
  }

  /** Get-or-create the retained-result budget for one attribution's record
   * array (keying mirrors consoleBudgetFor). */
  private retainedBudgetFor(toolCalls: PTCToolCallRecord[]): { remainingBytes: number } {
    let budget = this.retainedResultBudgets.get(toolCalls);
    if (!budget) {
      budget = { remainingBytes: KERNEL_RETAINED_EXECUTION_BUDGET_BYTES };
      this.retainedResultBudgets.set(toolCalls, budget);
    }
    return budget;
  }

  /** Get-or-create the classic-mode shared sanitizer budget for one
   * attribution's record array (see classicSanitizerBudgets). Public because
   * the classic outer return value persists into the same history row and
   * must draw from the same allowance (r29; see IJSRuntime). */
  classicCaptureBudgetFor(toolCalls: PTCToolCallRecord[]): CaptureSanitizerBudget {
    let budget = this.classicSanitizerBudgets.get(toolCalls);
    if (!budget) {
      budget = createCaptureSanitizerBudget();
      this.classicSanitizerBudgets.set(toolCalls, budget);
    }
    return budget;
  }

  setPendingJobGate(gate: (run: () => void) => void): void {
    this.pendingJobGate = gate;
  }

  registerSyncFunction(name: string, fn: (...args: unknown[]) => unknown): void {
    this.assertNotDisposed("registerSyncFunction");

    const fnHandle = this.newHostFunction(name, (...argHandles) => {
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      // Host exceptions propagate to the guest as thrown errors.
      const result = fn(...args);
      return this.marshal(result);
    });

    this.ctx.setProp(this.ctx.global, name, fnHandle);
    fnHandle.dispose();
  }

  /**
   * Array.isArray over a guest handle. Named properties DO store on a guest
   * array (the read-back verify passes) but JSON.stringify(vars) ignores
   * them, so a load landing on `vars = []` would report success while the
   * next snapshot durably commits `[]` — after a restart the loaded key is
   * gone (r49, same normalization as storeResultHandle's guest code).
   */
  private isGuestArray(handle: QuickJSHandle): boolean {
    const arrayCtor = this.ctx.getProp(this.ctx.global, "Array");
    const isArrayFn = this.ctx.getProp(arrayCtor, "isArray");
    try {
      const call = this.ctx.callFunction(isArrayFn, this.ctx.undefined, handle);
      if (call.error) {
        call.error.dispose();
        return false;
      }
      const result: unknown = this.ctx.dump(call.value);
      call.value.dispose();
      return result === true;
    } finally {
      isArrayFn.dispose();
      arrayCtor.dispose();
    }
  }

  setVarsProperty(key: string, value: string): void {
    this.assertNotDisposed("setVarsProperty");
    const valueHandle = this.ctx.newString(value);
    let varsHandle = this.ctx.getProp(this.ctx.global, "vars");
    // vars is guest-writable: if the guest deleted or clobbered it (non-object,
    // null, or an array whose named properties JSON.stringify would drop),
    // recreate the namespace instead of crashing the write mid-eval.
    const clobbered =
      this.ctx.typeof(varsHandle) !== "object" ||
      this.ctx.eq(varsHandle, this.ctx.null) ||
      this.isGuestArray(varsHandle);
    if (clobbered) {
      varsHandle.dispose();
      varsHandle = this.ctx.newObject();
      this.ctx.setProp(this.ctx.global, "vars", varsHandle);
    }
    this.ctx.setProp(varsHandle, key, valueHandle);
    // r29: a guest Proxy vars whose traps lie (set/defineProperty returning
    // true without storing) swallows this write silently — mux.load would
    // then return a successful {key, bytes, lines, preview} record while
    // vars[key] never existed, and the next snapshot would durably commit
    // the miss. Read the property back and throw so the caller's error path
    // reports an honest failure to the model (same in-eval verify as the
    // handle store in sandboxHostService).
    let stored = false;
    try {
      const readBack = this.ctx.getProp(varsHandle, key);
      stored = this.ctx.eq(readBack, valueHandle);
      readBack.dispose();
      if (stored) {
        // r54: the identity read-back above goes through the SAME [[Get]] a
        // lying Proxy controls — a get trap that echoes the just-assigned
        // value passes it while [[OwnPropertyKeys]] omits the key, so
        // JSON.stringify(vars) (exactly what the durable snapshot persists)
        // would drop the load and it would vanish after a restart. Verify
        // through the serialization itself: stash the expected value in a
        // temp global (string identity survives) and compare against the
        // parse(stringify(vars)) round trip.
        this.ctx.setProp(this.ctx.global, "__xumVarsWriteVerify", valueHandle);
        const verify = this.ctx.evalCode(
          `(function () {
            try {
              const round = JSON.parse(JSON.stringify(globalThis.vars));
              return (
                round !== null &&
                typeof round === "object" &&
                round[${JSON.stringify(key)}] === globalThis.__xumVarsWriteVerify
              );
            } catch {
              return false;
            } finally {
              delete globalThis.__xumVarsWriteVerify;
            }
          })()`
        );
        if (verify.error) {
          verify.error.dispose();
          stored = false;
        } else {
          const survived: unknown = this.ctx.dump(verify.value);
          verify.value.dispose();
          stored = survived === true;
        }
      }
    } finally {
      varsHandle.dispose();
      valueHandle.dispose();
    }
    if (!stored) {
      throw new Error(
        `vars assignment did not store ${JSON.stringify(key)} — the guest vars namespace swallows or hides writes from serialization; restore vars to a plain object and retry`
      );
    }
  }

  registerObject(
    name: string,
    obj: Record<string, (...args: unknown[]) => Promise<unknown>>,
    syncMethods?: Record<string, (...args: unknown[]) => unknown>
  ): void {
    this.assertNotDisposed("registerObject");
    for (const methodName of Object.keys(syncMethods ?? {})) {
      // Impossible-by-construction guard: one name cannot be both asyncified
      // and sync — the last setProp would silently win.
      if (methodName in obj) {
        throw new Error(`registerObject: method ${name}.${methodName} is both async and sync`);
      }
    }

    // Store the CURRENT registration: guest-side methods dispatch through
    // this map at call time, so re-registering (persistent mounts re-register
    // the tool bridge every call) retargets even guest-saved references like
    // `savedBash = mux.bash` to the newest implementation. A saved reference
    // can therefore never pin a replaced tool or bypass a wrapper installed
    // by a later registration.
    this.registeredObjects.set(name, obj);
    this.registeredObjectSyncMethods.set(name, syncMethods ?? {});

    // Reuse cached guest functions across re-registrations; see
    // registeredObjectFnHandles for why minting fresh ids per registration
    // corrupts dispatch on long-lived runtimes.
    let fnCache = this.registeredObjectFnHandles.get(name);
    if (fnCache === undefined) {
      fnCache = new Map();
      this.registeredObjectFnHandles.set(name, fnCache);
    }

    // Create object in QuickJS
    const objHandle = this.ctx.newObject();

    for (const methodName of Object.keys(obj)) {
      const cachedAsync = fnCache.get(methodName);
      if (cachedAsync?.kind === "async") {
        this.ctx.setProp(objHandle, methodName, cachedAsync.handle);
        continue;
      }
      if (cachedAsync !== undefined) {
        // The method flipped kinds since the last registration; the cached
        // guest function would route through the wrong wrapper. Replace it.
        cachedAsync.handle.dispose();
      }
      const fnHandle = this.newAsyncifiedHostFunction(methodName, async (...argHandles) => {
        if (this.abortController?.signal.aborted) {
          throw new Error("Execution aborted");
        }

        // Late-bound dispatch (see registeredObjects note above).
        const fn = this.registeredObjects.get(name)?.[methodName];
        if (fn === undefined) {
          throw new Error(`${name}.${methodName} is no longer available in this sandbox`);
        }

        // Convert QuickJS handles to JS values - cast to unknown at the FFI boundary
        const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
        const startTime = Date.now();
        const callId = generateCallId();

        // Same creation-time bounding as registerFunction (kernel mode).
        const recordArgs = this.boundCaptureArgs(args[0], methodName, this.toolCalls);

        // Emit start event
        this.eventHandler?.({
          type: "tool-call-start",
          callId,
          toolName: methodName,
          args: recordArgs,
          startTime,
        });

        try {
          // Same synchronous-window handoff as registerFunction.
          this.activeHostCallId = callId;
          const result = await fn(...args);
          const endTime = Date.now();
          const duration_ms = endTime - startTime;
          const recordResult = this.boundCaptureResult(result, methodName, this.toolCalls);

          // Record tool call
          this.toolCalls.push({
            toolName: methodName,
            args: recordArgs,
            result: recordResult,
            duration_ms,
          });

          // Emit end event
          this.eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: methodName,
            args: recordArgs,
            result: recordResult,
            startTime,
            endTime,
          });

          return this.marshal(result);
        } catch (error) {
          const endTime = Date.now();
          const duration_ms = endTime - startTime;
          const errorStr = error instanceof Error ? error.message : String(error);
          const recordError = this.boundCaptureError(errorStr);

          this.toolCalls.push({
            toolName: methodName,
            args: recordArgs,
            error: recordError,
            duration_ms,
          });

          this.eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: methodName,
            args: recordArgs,
            error: recordError,
            startTime,
            endTime,
          });

          throw error;
        }
      });

      fnCache.set(methodName, { kind: "async", handle: fnHandle });
      this.ctx.setProp(objHandle, methodName, fnHandle);
    }

    // Sync methods: plain (non-asyncified) host functions. Asyncified methods
    // can only suspend inside the evalCodeAsync stack, so guest continuations
    // resumed via executePendingJobs (code after `await capability()`) cannot
    // call them — asyncify replays the call and returns garbage. Sync methods
    // never suspend, so they stay safe post-await (see registerSyncFunction).
    for (const methodName of Object.keys(syncMethods ?? {})) {
      const cachedSync = fnCache.get(methodName);
      if (cachedSync?.kind === "sync") {
        this.ctx.setProp(objHandle, methodName, cachedSync.handle);
        continue;
      }
      if (cachedSync !== undefined) {
        cachedSync.handle.dispose();
      }
      const fnHandle = this.newHostFunction(methodName, (...argHandles) => {
        // Late-bound dispatch (see registeredObjects note above).
        const fn = this.registeredObjectSyncMethods.get(name)?.[methodName];
        if (fn === undefined) {
          throw new Error(`${name}.${methodName} is no longer available in this sandbox`);
        }
        const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
        // Host exceptions propagate to the guest as thrown errors.
        return this.marshal(fn(...args));
      });
      fnCache.set(methodName, { kind: "sync", handle: fnHandle });
      this.ctx.setProp(objHandle, methodName, fnHandle);
    }

    // Methods absent from this registration: drop their cached handles so a
    // later re-add mints a fresh function of the right kind. Guest-saved
    // references to a removed method stay callable in the VM but fail closed
    // through the late-bound lookup.
    const currentSyncMethods = syncMethods ?? {};
    for (const [methodName, cached] of fnCache) {
      if (!(methodName in obj) && !(methodName in currentSyncMethods)) {
        cached.handle.dispose();
        fnCache.delete(methodName);
      }
    }

    this.ctx.setProp(this.ctx.global, name, objHandle);
    objHandle.dispose();
  }

  async eval(code: string): Promise<PTCExecutionResult> {
    this.assertNotDisposed("eval");

    const execStartTime = Date.now();
    this.abortController = new AbortController();
    this.toolCalls = [];
    this.consoleOutput = [];

    // Honor abort requests made before eval() was called
    if (this.abortRequested) {
      this.abortController.abort();
    }

    // Set up console capturing (only once; reaction tagging is installed in
    // the constructor because registrations precede the first eval)
    if (!this.consoleSetup) {
      this.setupConsole();
      this.consoleSetup = true;
    }

    // Set up interrupt handler for cancellation and timeout
    const timeoutMs = this.limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    this.ctx.runtime.setInterruptHandler(() => {
      if (this.abortController?.signal.aborted) {
        return true; // Interrupt execution
      }
      if (Date.now() > deadline) {
        this.abortController?.abort();
        return true; // Interrupt execution due to timeout
      }
      return false; // Continue execution
    });

    // Set up a real timeout timer that fires even during async suspension.
    // The interrupt handler only runs during QuickJS execution, but when suspended
    // waiting for an async host function (e.g., mux.bash()), it never fires.
    // This timer ensures nested tools are cancelled when the deadline is exceeded.
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, timeoutMs);

    // Land late settlements whose gate callback lost the mount-lock race to
    // this call (the lock is already held by our code_execution invocation,
    // so the gate cannot run until we return). Must happen before guest code
    // runs so a promise stored by a prior eval is consumable here; the gate's
    // eventual drain then finds an empty queue and no-ops. Placed after the
    // interrupt handler + timer setup so the drain runs under THIS eval's
    // deadline (not a stale one), and BEFORE the generation is marked active
    // so the drained reactions — all created by prior evals — bind to their
    // originating attribution state.
    this.drainQueuedLateSettlements();
    this.activeEvalGeneration = ++this.evalGeneration;

    // Register this eval's attribution sinks and expose the generation to
    // the guest so reactions registered from here on are tagged with it
    // (REACTION_TAGGING_SCRIPT). Placed after the drain: drained reactions
    // belong to prior generations.
    this.generationContexts.set(this.activeEvalGeneration, {
      context: {
        toolCalls: this.toolCalls,
        consoleOutput: this.consoleOutput,
        eventHandler: this.eventHandler,
      },
      refs: 0,
    });
    this.pruneGenerationContexts();
    const generationHandle = this.ctx.newNumber(this.activeEvalGeneration);
    this.ctx.setProp(this.ctx.global, EVAL_GENERATION_GLOBAL, generationHandle);
    generationHandle.dispose();

    // Wrap code in function to allow return statements.
    // With asyncify, async host functions appear synchronous to QuickJS,
    // so we don't need an async IIFE. Using evalCodeAsync handles the suspension.
    const wrappedCode = `(function() { ${code} })()`;

    try {
      const evalResult = await this.ctx.evalCodeAsync(wrappedCode);
      // Top-level guest execution finished: the VM is idle and this call
      // still owns the runtime, so settlements may now land directly (the
      // resolve loop below coordinates, and may itself await them).
      this.directSettleAllowed = true;

      if (evalResult.error) {
        const errObj: unknown = this.ctx.dump(evalResult.error) as unknown;
        evalResult.error.dispose();

        const duration_ms = Date.now() - execStartTime;
        const errorMessage = this.getErrorMessage(errObj, deadline, timeoutMs);

        return {
          success: false,
          error: errorMessage,
          toolCalls: this.toolCalls,
          consoleOutput: this.consoleOutput,
          duration_ms,
        };
      }

      const resolvedValue = await this.resolveReturnedValue(evalResult.value, deadline, timeoutMs);
      evalResult.value.dispose();

      if (!resolvedValue.success) {
        return {
          success: false,
          error: resolvedValue.error,
          toolCalls: this.toolCalls,
          consoleOutput: this.consoleOutput,
          duration_ms: Date.now() - execStartTime,
        };
      }

      return {
        success: true,
        result: resolvedValue.value,
        toolCalls: this.toolCalls,
        consoleOutput: this.consoleOutput,
        duration_ms: Date.now() - execStartTime,
      };
    } catch (error) {
      const duration_ms = Date.now() - execStartTime;
      const errorMessage = this.getErrorMessage(error, deadline, timeoutMs);

      return {
        success: false,
        error: errorMessage,
        toolCalls: this.toolCalls,
        consoleOutput: this.consoleOutput,
        duration_ms,
      };
    } finally {
      clearTimeout(timeoutId);
      // An abort applies to the eval it interrupted (or the one about to
      // start), not to future evals: persistent mounts reuse this runtime
      // across calls, and a sticky flag would poison every later eval.
      this.abortRequested = false;
      // Run microtasks this eval enqueued BEFORE dropping its generation:
      // fire-and-forget reactions and internal thenable jobs (an `await` on
      // a capability promise registers through the patched then here) must
      // tag with THIS eval as owner, not whichever eval drains them later.
      if (!this.disposed) {
        // A failed fire-and-forget guest job is dropped (surfacing it would
        // mask the eval result) — same policy as the gate's drain.
        this.drainPendingJobs();
        this.clearReactionOwner();
      }
      // Settlements arriving from here on are LATE (post-eval) and must be
      // queued; see settleInVm in registerPromiseFunction.
      this.directSettleAllowed = false;
      this.activeEvalGeneration = null;
      // Land settlements queued while guest code was suspended inside an
      // asyncified call and not consumed by the resolve loop (e.g. the guest
      // returned a plain value or threw). Serialized through the gate when
      // present; a gateless (ephemeral) runtime is single-owner and idle.
      if (this.queuedLateSettlements.length > 0) {
        if (this.pendingJobGate) {
          this.pendingJobGate(() => this.drainQueuedLateSettlements());
        } else {
          this.drainQueuedLateSettlements();
        }
      }
    }
  }

  abort(): void {
    this.abortRequested = true;
    this.abortController?.abort();
  }

  takeActiveHostCallId(): string | undefined {
    const callId = this.activeHostCallId;
    this.activeHostCallId = undefined;
    return callId;
  }

  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  dispose(): void {
    if (!this.disposed) {
      // The registerObject handle cache owns live guest values; release them
      // before the context goes down.
      for (const fnCache of this.registeredObjectFnHandles.values()) {
        for (const cached of fnCache.values()) {
          cached.handle.dispose();
        }
      }
      this.registeredObjectFnHandles.clear();
      this.ctx.dispose();
      this.disposed = true;
      // Queued late settlements would no-op anyway (guarded checks disposed);
      // drop them so their closures are not retained.
      this.queuedLateSettlements.length = 0;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // --- Private helpers ---

  /** Mint one host-function id, failing loudly at the budget: exceeding the
   * real 16-bit space silently misroutes guest calls to unrelated closures
   * (see HOST_FN_ID_LIMIT). All host-function creation must flow through this
   * and newAsyncifiedHostFunction. */
  private newHostFunction(
    name: string,
    fn: Parameters<QuickJSAsyncContext["newFunction"]>[1]
  ): QuickJSHandle {
    this.trackHostFnAllocation(name);
    return this.ctx.newFunction(name, fn);
  }

  /** Asyncified variant of newHostFunction; same id budget. */
  private newAsyncifiedHostFunction(
    name: string,
    fn: Parameters<QuickJSAsyncContext["newAsyncifiedFunction"]>[1]
  ): QuickJSHandle {
    this.trackHostFnAllocation(name);
    return this.ctx.newAsyncifiedFunction(name, fn);
  }

  private trackHostFnAllocation(name: string): void {
    this.hostFnAllocations += 1;
    if (this.hostFnAllocations > HOST_FN_ID_LIMIT) {
      throw new Error(
        `QuickJS host-function id budget exhausted registering "${name}"; dispose and recreate this runtime`
      );
    }
  }

  private assertNotDisposed(method: string): void {
    if (this.disposed) {
      throw new Error(`Cannot call ${method} on disposed QuickJSRuntime`);
    }
  }

  /** Execute pending guest jobs and dispose the disposable result in both
   * the success and error cases — dropping it leaks QuickJS handles, which
   * accumulates across repeated capability settlements on persistent mounts.
   * Fire-and-forget drain: a failed guest job here has nothing to report to
   * (same policy as eval()'s finally drain). */
  private drainPendingJobs(): void {
    const result = this.ctx.runtime.executePendingJobs();
    if (result.error) {
      result.error.dispose();
    } else {
      result.dispose();
    }
  }

  /** Run queued late settlements in arrival order; returns whether any ran.
   * Called from eval() start, the resolve loop, and eval() end (all under
   * the caller's mount lock) and from the pending-job gate (under the gate's
   * own lock acquisition) — whichever runs first; later drains see an empty
   * queue. Each entry no-ops after dispose. */
  private drainQueuedLateSettlements(): boolean {
    let drained = false;
    while (this.queuedLateSettlements.length > 0) {
      const run = this.queuedLateSettlements.shift();
      run?.();
      drained = true;
    }
    return drained;
  }

  private async resolveReturnedValue(
    handle: QuickJSHandle,
    deadline: number,
    timeoutMs: number
  ): Promise<{ success: true; value: unknown } | { success: false; error: string }> {
    let promiseState = this.ctx.getPromiseState(handle);
    while (promiseState.type === "pending") {
      if (this.abortController?.signal.aborted || Date.now() > deadline) {
        return {
          success: false,
          error: this.getErrorMessage("Execution interrupted", deadline, timeoutMs),
        };
      }
      // Land settlements queued while guest code was suspended inside an
      // asyncified call (see settleInVm): the returned value may be a prior
      // eval's promise that only these settlements can resolve.
      const drainedQueued = this.drainQueuedLateSettlements();
      if (this.ctx.runtime.hasPendingJob()) {
        const pendingJobs = this.ctx.runtime.executePendingJobs();
        if (pendingJobs.error) {
          const errorObj: unknown = pendingJobs.error.context.dump(pendingJobs.error) as unknown;
          const error = this.getErrorMessage(errorObj, deadline, timeoutMs);
          pendingJobs.dispose();
          return { success: false, error };
        }
        pendingJobs.dispose();
      } else if (!drainedQueued && this.pendingHostPromises.size > 0) {
        // The returned value may depend on an in-flight async capability
        // (registerPromiseFunction). Wait for any settlement, bounded by the
        // deadline/abort; each settlement schedules executePendingJobs.
        await this.waitForAnyHostPromise(deadline);
      } else if (!drainedQueued) {
        // Nothing can ever settle this promise.
        break;
      }
      promiseState = this.ctx.getPromiseState(handle);
    }

    if (promiseState.type === "pending") {
      return { success: false, error: "Execution returned a pending Promise" };
    }
    if (promiseState.type === "rejected") {
      const errorObj: unknown = this.ctx.dump(promiseState.error) as unknown;
      promiseState.error.dispose();
      return { success: false, error: this.getErrorMessage(errorObj, deadline, timeoutMs) };
    }

    try {
      const valueHandle = promiseState.notAPromise ? handle : promiseState.value;
      const value: unknown = this.ctx.dump(valueHandle) as unknown;
      return { success: true, value };
    } finally {
      if (!promiseState.notAPromise) {
        promiseState.value.dispose();
      }
    }
  }

  /**
   * Wait until any in-flight async-capability promise settles, the deadline
   * passes, or the execution is aborted. Tracked promises never reject.
   */
  private async waitForAnyHostPromise(deadline: number): Promise<void> {
    const abortSignal = this.abortController?.signal;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, deadline - Date.now()) + 1);
      abortSignal?.addEventListener("abort", finish, { once: true });
      for (const pending of this.pendingHostPromises) {
        void pending.then(finish);
      }
    });
  }

  /**
   * Format a QuickJS error object into a readable error message.
   */
  private formatError(errorObj: unknown): string {
    if (typeof errorObj === "object" && errorObj !== null) {
      const err = errorObj as { name?: string; message?: string; stack?: string };
      if (err.name && err.message) {
        return `${err.name}: ${err.message}`;
      }
      if (err.message) {
        return err.message;
      }
    }
    return String(errorObj);
  }

  /**
   * Get appropriate error message, checking for timeout/abort conditions.
   * Also provides friendlier messages for common sandbox errors.
   */
  private getErrorMessage(errorObj: unknown, deadline: number, timeoutMs: number): string {
    const isAborted = this.abortController?.signal.aborted;
    const isTimedOut = Date.now() > deadline;

    if (isAborted && isTimedOut) {
      return `Execution timeout (${timeoutMs}ms exceeded)`;
    }
    if (isAborted) {
      return "Execution aborted";
    }

    // Check for QuickJS interrupt error
    const formatted = this.formatError(errorObj);
    if (formatted.includes("interrupted")) {
      if (isTimedOut) {
        return `Execution timeout (${timeoutMs}ms exceeded)`;
      }
      return "Execution interrupted";
    }

    // Provide friendlier message for unavailable globals
    const refErrorMatch = /ReferenceError: '?(\w+)'? is not defined/.exec(formatted);
    if (refErrorMatch) {
      const identifier = refErrorMatch[1];
      if (UNAVAILABLE_IDENTIFIERS.has(identifier)) {
        return `'${identifier}' is not available in the sandbox. Use mux.* tools for I/O operations.`;
      }
    }

    return formatted;
  }

  /**
   * Set up console.log/warn/error to capture output, bounded at CAPTURE time
   * (r15): every dumped record used to be retained host-side as the guest
   * ran, so a `console.log` loop over large values could exhaust process
   * memory over the eval timeout before any post-eval cap executed — the
   * QuickJS heap limit does not bound host-side retention. Each attribution
   * array gets a byte budget; once exhausted, further records are neither
   * dumped nor retained nor streamed (a single mutable marker record counts
   * the drops), so retained memory is O(budget), not O(guest output).
   */
  private setupConsole(): void {
    const consoleObj = this.ctx.newObject();

    for (const level of ["log", "warn", "error"] as const) {
      const fn = this.newHostFunction(level, (...argHandles) => {
        const timestamp = Date.now();
        // Route to the eval that registered the enclosing reaction (falls
        // back to the current drain context for untagged code).
        const attribution = this.currentAttribution();
        const budget = this.consoleBudgetFor(attribution.consoleOutput);

        if (budget.marker !== null) {
          // Budget exhausted: do NOT dump the handles (dumping materializes
          // the values host-side — the very retention being bounded). Count
          // the drop and keep the marker's text accurate in place.
          budget.droppedRecords += 1;
          budget.marker.args[0] =
            `[console output truncated at capture: ${CONSOLE_CAPTURE_BUDGET_BYTES}-byte ` +
            `retention budget reached; ${budget.droppedRecords} record(s) dropped]`;
          return;
        }

        const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
        // Same measurement as the post-eval kernel cap: the JSON serialization
        // of the args. UNLIKE that cap's zero fallback, an unserializable
        // record (e.g. BigInt — preserved by dump, throws in JSON.stringify)
        // is treated as OVERFLOW: charging it zero would retain it for free,
        // so a guest pairing every large payload with one BigInt could grow
        // host memory unbounded past the budget (r17).
        let size: number;
        try {
          size = Buffer.byteLength(JSON.stringify(args) ?? "", "utf8");
        } catch {
          size = Number.POSITIVE_INFINITY;
        }

        if (budget.retainedBytes + size > CONSOLE_CAPTURE_BUDGET_BYTES) {
          // Crossing record: drop it whole and install the marker. No
          // bounded-head slice here — the post-eval kernel cap already does
          // head-slicing at its (much smaller) model-visible cap, and capture
          // only needs the memory bound.
          const marker: PTCConsoleRecord = {
            level: "warn",
            args: [
              `[console output truncated at capture: ${CONSOLE_CAPTURE_BUDGET_BYTES}-byte ` +
                `retention budget reached; 1 record(s) dropped]`,
            ],
            timestamp,
          };
          budget.marker = marker;
          budget.droppedRecords = 1;
          attribution.consoleOutput.push(marker);
          return;
        }

        budget.retainedBytes += size;
        // Media containers are budgeted at capture like tool-call records
        // (see setCaptureResultSanitizer): console events stream into session
        // history immediately, so any later sanitization would miss the
        // streamed copy. Budget accounting stays on the raw size above —
        // sanitization only shrinks, never grows.
        const sanitizer = this.captureResultSanitizer;
        const captured =
          sanitizer !== undefined
            ? args.map((arg) =>
                sanitizer(
                  "console",
                  arg,
                  // Classic mode draws from the same execution allowance as
                  // nested records and the outer return (r29): console-arg
                  // media must not mint a fresh per-value budget. Kernel mode
                  // keeps per-call allowances (cross-call growth is bounded
                  // by the retained-result budget and this console budget).
                  this.kernelRecordBounds === undefined
                    ? this.classicCaptureBudgetFor(attribution.toolCalls)
                    : undefined
                )
              )
            : args;
        attribution.consoleOutput.push({ level, args: captured, timestamp });
        attribution.eventHandler?.({
          type: "console",
          level,
          args: captured,
          timestamp,
        });
      });
      this.ctx.setProp(consoleObj, level, fn);
      fn.dispose();
    }

    this.ctx.setProp(this.ctx.global, "console", consoleObj);
    consoleObj.dispose();
  }

  /** Get-or-create the capture budget for one attribution's console array.
   * Keyed by the array itself: each eval creates a fresh array, and late
   * fire-and-forget continuations share their originating eval's budget. */
  private consoleBudgetFor(consoleOutput: PTCConsoleRecord[]): ConsoleCaptureBudget {
    let budget = this.consoleBudgets.get(consoleOutput);
    if (!budget) {
      budget = { retainedBytes: 0, droppedRecords: 0, marker: null };
      this.consoleBudgets.set(consoleOutput, budget);
    }
    return budget;
  }

  /** Install the promise-reaction tagging patch; see REACTION_TAGGING_SCRIPT. */
  private setupReactionTagging(): void {
    // Host refcount endpoints must exist before the script captures them.
    const retainFn = this.newHostFunction(RETAIN_GENERATION_FN, (genHandle) => {
      const gen: unknown = this.ctx.dump(genHandle) as unknown;
      if (typeof gen !== "number") return;
      const entry = this.generationContexts.get(gen);
      if (entry) entry.refs += 1;
    });
    this.ctx.setProp(this.ctx.global, RETAIN_GENERATION_FN, retainFn);
    retainFn.dispose();
    const releaseFn = this.newHostFunction(RELEASE_GENERATION_FN, (genHandle) => {
      const gen: unknown = this.ctx.dump(genHandle) as unknown;
      if (typeof gen !== "number") return;
      const entry = this.generationContexts.get(gen);
      if (entry && entry.refs > 0) entry.refs -= 1;
    });
    this.ctx.setProp(this.ctx.global, RELEASE_GENERATION_FN, releaseFn);
    releaseFn.dispose();

    const result = this.ctx.evalCode(REACTION_TAGGING_SCRIPT);
    if (result.error) {
      const errObj: unknown = this.ctx.dump(result.error) as unknown;
      result.error.dispose();
      // Startup invariant — the script is static; crash fast if it breaks.
      throw new Error(`Failed to install reaction tagging: ${this.formatError(errObj)}`);
    }
    result.value.dispose();
  }

  /** Generation of the eval that registered the currently-running promise
   * reaction, or undefined outside tagged callbacks. */
  private readReactionOwner(): number | undefined {
    const handle = this.ctx.getProp(this.ctx.global, REACTION_OWNER_GLOBAL);
    try {
      const value: unknown = this.ctx.dump(handle) as unknown;
      return typeof value === "number" ? value : undefined;
    } finally {
      handle.dispose();
    }
  }

  /** Reset the guest owner global at a drain-batch boundary: the deferred
   * one-hop restore inside REACTION_TAGGING_SCRIPT can leave a stale owner
   * when tagged callbacks from different owners interleave in one batch. */
  private clearReactionOwner(): void {
    if (this.disposed) return;
    this.ctx.setProp(this.ctx.global, REACTION_OWNER_GLOBAL, this.ctx.undefined);
  }

  /** Attribution sinks for the code executing RIGHT NOW: the registering
   * eval's context when inside a tagged reaction, else the current drain
   * context (the runtime's mutable fields, possibly swapped by settleInVm). */
  private currentAttribution(): AttributionContext {
    const owner = this.readReactionOwner();
    if (owner !== undefined) {
      const entry = this.generationContexts.get(owner);
      if (entry) {
        return entry.context;
      }
    }
    return {
      toolCalls: this.toolCalls,
      consoleOutput: this.consoleOutput,
      eventHandler: this.eventHandler,
    };
  }

  /** Retention policy for attribution contexts: generations with outstanding
   * tagged reactions (refs > 0) are retained so a reaction can settle any
   * number of evals later; idle entries beyond a soft cap are evicted
   * oldest-first. A hard cap bounds memory against pathological
   * never-settling registrations (evicted reactions fall back to the drain
   * context). The active generation is never evicted. */
  private pruneGenerationContexts(): void {
    const evict = (spare: number, includeRetained: boolean) => {
      for (const [gen, entry] of this.generationContexts) {
        if (spare <= 0) break;
        if (gen === this.activeEvalGeneration) continue;
        if (!includeRetained && entry.refs > 0) continue;
        this.generationContexts.delete(gen);
        spare -= 1;
      }
    };
    let idle = 0;
    for (const [gen, entry] of this.generationContexts) {
      if (entry.refs === 0 && gen !== this.activeEvalGeneration) idle += 1;
    }
    evict(idle - MAX_IDLE_GENERATION_CONTEXTS, false);
    evict(this.generationContexts.size - MAX_GENERATION_CONTEXTS, true);
  }

  /**
   * Marshal a JavaScript value into a QuickJS handle.
   *
   * Recursively converts JS values to QuickJS handles with:
   * - Cycle detection (circular refs become "[Circular]")
   * - Native BigInt support
   * - Preserved undefined in objects/arrays
   * - Explicit markers for unserializable types (functions, symbols)
   */
  private marshal(value: unknown, seen = new WeakSet<object>()): QuickJSHandle {
    if (value === undefined) {
      return this.ctx.undefined;
    }
    if (value === null) {
      return this.ctx.null;
    }
    if (typeof value === "boolean") {
      return value ? this.ctx.true : this.ctx.false;
    }
    if (typeof value === "number") {
      return this.ctx.newNumber(value);
    }
    if (typeof value === "string") {
      return this.ctx.newString(value);
    }
    if (typeof value === "bigint") {
      return this.ctx.newBigInt(value);
    }

    // Functions and symbols can't be marshaled - return explicit marker
    if (typeof value === "function" || typeof value === "symbol") {
      return this.marshalObject({ __unserializable__: typeof value }, seen);
    }

    // Objects and arrays - recursively marshal with cycle detection
    if (typeof value === "object") {
      // Date → ISO string (matches JSON.stringify behavior)
      if (value instanceof Date) {
        return this.ctx.newString(value.toISOString());
      }

      // Check for circular reference - `seen` tracks current ancestors in the
      // traversal path, not all visited objects. This correctly handles shared
      // references (same object in multiple places) vs true cycles.
      if (seen.has(value)) {
        return this.ctx.newString("[Circular]");
      }
      seen.add(value);

      try {
        if (Array.isArray(value)) {
          return this.marshalArray(value, seen);
        }
        return this.marshalObject(value as Record<string, unknown>, seen);
      } finally {
        // Remove from path after processing - allows same object to appear
        // in multiple non-circular positions (shared references)
        seen.delete(value);
      }
    }

    // Unknown type - shouldn't happen but be defensive
    return this.ctx.undefined;
  }

  private marshalArray(arr: unknown[], seen: WeakSet<object>): QuickJSHandle {
    const handle = this.ctx.newArray();
    for (let i = 0; i < arr.length; i++) {
      const elem = this.marshal(arr[i], seen);
      this.ctx.setProp(handle, i, elem);
      elem.dispose();
    }
    return handle;
  }

  private marshalObject(obj: Record<string, unknown>, seen: WeakSet<object>): QuickJSHandle {
    const handle = this.ctx.newObject();
    for (const [key, val] of Object.entries(obj)) {
      const valHandle = this.marshal(val, seen);
      this.ctx.setProp(handle, key, valHandle);
      valHandle.dispose();
    }
    return handle;
  }
}

/**
 * Factory for creating QuickJS runtime instances.
 */
export class QuickJSRuntimeFactory implements IJSRuntimeFactory {
  async create(): Promise<QuickJSRuntime> {
    return QuickJSRuntime.create();
  }
}
