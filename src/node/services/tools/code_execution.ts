/**
 * Code Execution Tool for Programmatic Tool Calling (PTC)
 *
 * Executes JavaScript code in a sandboxed QuickJS environment with access to all
 * Xum tools via the `xum.*` namespace (`mux.*` remains a compatibility alias).
 * Enables multi-tool workflows in a single inference instead of multiple round-trips.
 */

import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCConsoleRecord, PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import type {
  ResultHandlePersistArgs,
  SandboxMount,
} from "@/node/services/sandbox/sandboxHostService";
import {
  SandboxSnapshotConflictError,
  VarsSnapshotBudgetError,
} from "@/node/services/sandbox/sandboxHostService";
import type { KernelFileLoader } from "@/node/services/tools/kernelFileLoad";

import { analyzeCode } from "@/node/services/ptc/staticAnalysis";
import { log } from "@/node/services/log";
import { getCachedXumTypes, clearTypeCache } from "@/node/services/ptc/typeGenerator";
import {
  buildHandlePreview,
  RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES,
  RESULT_HANDLE_VARS_CAP_BYTES,
} from "@/constants/resultHandles";
import { KERNEL_COMPACT_ARGS_CAP_BYTES, KERNEL_CONSOLE_CAP_BYTES } from "@/constants/kernelOutput";
import { sliceUtf8Bytes } from "@/common/utils/sliceUtf8Bytes";
import {
  containsMediaContentPayload,
  isKernelRecordResultExempt,
  sanitizeCapturedMediaValue,
} from "@/node/services/ptc/types";
import { jsonSafeClone } from "@/common/utils/jsonSafeClone";

// Default limits
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB
const DEFAULT_TIMEOUT_SECS = 5 * 60; // 5 minutes
const MAX_TIMEOUT_SECS = 60 * 60; // 1 hour

/**
 * Clear all type caches. Call for test isolation or when tool schemas might have changed.
 */
export function clearTypeCaches(): void {
  clearTypeCache();
}

/** PTC event with parentToolCallId attached by code_execution */
export type PTCEventWithParent = PTCEvent & { parentToolCallId: string };

/**
 * Create the code_execution tool.
 *
 * This function is async because it generates TypeScript type definitions
 * from the tool schemas, which requires async JSON Schema to TypeScript conversion.
 *
 * @param runtimeFactory Factory for creating QuickJS runtime instances
 * @param toolBridge Bridge containing tools to expose in sandbox
 * @param emitNestedEvent Callback for streaming nested tool events (includes parentToolCallId)
 * @param withMount Optional SandboxHostService lease runner
 *   (withPersistentMount bound to this workspace's scope). When absent,
 *   behavior is the classic ephemeral per-call flow (create → eval → dispose).
 *   The runner holds the scope lock from mount acquisition through fn's
 *   completion, so the register→eval→persist sequence cannot race concurrent
 *   grant changes or scope disposal; the persistent runtime is not disposed
 *   here.
 */
export type MountRunner = (
  fn: (mount: SandboxMount) => Promise<PTCExecutionResult>
) => Promise<PTCExecutionResult>;

/** Dispatch state (bridge + mount runner + file loader) for a created code_execution instance. */
interface DispatchState {
  toolBridge: ToolBridge;
  withMount: MountRunner | undefined;
  /** Host file loader backing mux.load (kernel mode only); see KernelBridgeOptions. */
  loadFile: KernelFileLoader | undefined;
}

/** Model-visible replacement for an offloaded oversized value. */
export interface OffloadedValueRecord {
  /** Guest expression holding the full value, e.g. "vars.__h3". */
  handle: string;
  /** Bounded head/tail excerpt of the serialized value. */
  preview: string;
  /** Full serialized size in bytes. */
  size: number;
  /** One-line follow-up hint (offloaded top-level return values only). */
  hint?: string;
}

/**
 * Model-visible replacement for a return value that could NOT be retained in
 * the kernel (over the retention cap, or its persistence failed). Unlike
 * OffloadedValueRecord there is deliberately no handle: promising kernel
 * state that does not durably exist would send the model chasing a missing
 * value. The full value is gone; the bounded preview is all that remains.
 */
export interface TruncatedValueRecord {
  truncated: true;
  /** Bounded head/tail excerpt of the serialized value. */
  preview: string;
  /** Full serialized size in bytes. */
  size: number;
  /** Why the value was truncated and how to proceed. */
  note: string;
}

/**
 * A handle stored in guest vars whose durable row/blob has NOT been published
 * yet (r28): publication must wait for the vars snapshot to commit, otherwise
 * a later persistVars failure rewrites the result as truncated while the
 * already-published event keeps claiming a handle the model never received
 * (metrics would count it as handle adoption).
 */
interface PendingResultHandle {
  /** Bare vars key ("__hN"), for retention protection. */
  key: string;
  /** Deferred persistResultHandle args, published after the snapshot commit. */
  persistArgs: ResultHandlePersistArgs;
}

/** Build the model-visible record for a value the kernel could not retain. */
function buildTruncatedRecord(preview: string, size: number, note?: string): TruncatedValueRecord {
  return {
    truncated: true,
    preview,
    size,
    note:
      note ??
      `Return value (${size} bytes) exceeded the kernel retention budget and was NOT stored — ` +
        `only this preview remains. Re-derive the data in a follow-up call, returning a smaller ` +
        `slice or aggregate (keep working data in vars).`,
  };
}

/**
 * Offload one oversized value to the persistent kernel. Returns the
 * model-visible replacement record, or null only when the value is
 * sub-threshold or serializes to undefined (bare function/symbol — no bytes
 * reach the transcript, so inline is harmless). Everything else NEVER stays
 * inline: store failures, over-cap sizes, AND unserializable values all
 * degrade to a bounded truncated record.
 */
async function offloadValue(
  mount: SandboxMount,
  value: unknown
): Promise<
  | { record: OffloadedValueRecord; persistArgs: ResultHandlePersistArgs }
  | TruncatedValueRecord
  | null
> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // A THROWING stringify (bare BigInt anywhere in the value) is treated as
    // unretainable, same class as the r17 console fix: the value cannot live
    // in vars (data-only contract), cannot be measured, and can hide an
    // arbitrarily large sibling payload ({payload: 10MB, bad: 1n}) — keeping
    // it inline bypassed the r14 offload/retention tiers entirely and then
    // broke HistoryService's plain stringify at persistence (r22). No
    // preview either: rendering one would require the very serialization
    // that just failed, and String() can also explode on large arrays.
    log.warn(
      "code_execution: return value is not JSON-serializable; truncating to a bounded record"
    );
    return buildTruncatedRecord(
      "",
      0,
      `Return value is not JSON-serializable (e.g. contains a BigInt) and was NOT stored or ` +
        `returned. Convert to JSON-safe data (String(bigint), plain objects/arrays) and return ` +
        `only what you need to see; keep working data in vars.`
    );
  }
  if (typeof serialized !== "string") return null;
  const size = Buffer.byteLength(serialized, "utf8");
  if (size <= RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES) return null;

  // Values beyond the retention cap must never be advertised as handles: the
  // retention pass would protect the fresh handle while it single-handedly
  // exceeds the vars snapshot budget, the snapshot would be rejected, and the
  // mount disposed — the next call would restore a snapshot WITHOUT the
  // handle the record promised. Nor may the value stay inline: a 64MB-sandbox
  // value would defeat kernel context isolation and can exceed the provider
  // context on the next request. Truncate to a bounded preview instead.
  if (size > RESULT_HANDLE_VARS_CAP_BYTES) {
    log.warn(
      "code_execution: return value exceeds the vars retention cap; truncating to a bounded preview",
      { size }
    );
    return buildTruncatedRecord(buildHandlePreview(serialized, size), size);
  }

  // Store in vars FIRST so the model is never pointed at a missing handle.
  // On failure the value must NOT stay inline either (r14): the guest can
  // force this path deliberately (e.g. a write-swallowing Proxy; null and
  // primitive vars are normalized away in-store since r28) and a handle-tier
  // value kept inline would push megabytes into durable history and provider
  // context —
  // truncate to the same bounded record as the over-cap tier. The error
  // detail is deliberately not echoed into the note: guest-influenced eval
  // errors can be arbitrarily large, and the log line above suffices.
  let handleKey: string;
  try {
    handleKey = await mount.storeResultHandle(serialized, RESULT_HANDLE_VARS_CAP_BYTES);
  } catch (error) {
    log.warn(
      "code_execution: result-handle vars assignment failed; truncating to a bounded preview",
      { error }
    );
    return buildTruncatedRecord(
      buildHandlePreview(serialized, size),
      size,
      `Return value (${size} bytes) could NOT be stored in the kernel (the vars namespace is ` +
        `unusable) — only this preview remains. Restore vars to a plain object, then re-derive ` +
        `the data in a follow-up call.`
    );
  }
  const handle = `vars.${handleKey}`;
  const preview = buildHandlePreview(serialized, size);
  // r28: publication of the durable row/blob is DEFERRED — the caller
  // publishes only after persistVars commits the snapshot, so a snapshot
  // failure (which rewrites this record as truncated and disposes the
  // kernel) can never leave a durable event for a handle the model never
  // received.
  return { record: { handle, preview, size }, persistArgs: { handle, preview, serialized } };
}

/**
 * RLM context offloading for the TOP-LEVEL return value: values above the
 * threshold stop entering the model context. The model-visible result is
 * replaced by { handle, preview, size } while the full value lands in
 * vars.__hN (guest), the blob store, and one result-handle durable event.
 * Nested records need no offload machinery in kernel mode — they carry no
 * payload at all (see compactKernelToolCallRecords). Mutates `result` in
 * place.
 */
async function offloadOversizedReturnValue(
  mount: SandboxMount,
  result: PTCExecutionResult
): Promise<PendingResultHandle | null> {
  if (result.result !== undefined) {
    const offloaded = await offloadValue(mount, result.result);
    if (offloaded !== null) {
      if ("truncated" in offloaded) {
        // Over the retention cap: bounded preview only, no kernel state.
        result.result = offloaded;
        return null;
      }
      result.result = {
        ...offloaded.record,
        hint: `Return value exceeded the inline limit; the full value is stored in the kernel — access or slice ${offloaded.record.handle} in a follow-up code_execution call.`,
      } satisfies OffloadedValueRecord;
      return {
        // "vars.__hN" → "__hN": the bare vars key, for retention protection.
        key: offloaded.record.handle.replace(/^vars\./, ""),
        persistArgs: offloaded.persistArgs,
      };
    }
  }
  return null;
}

/**
 * Kernel-mode record suppression (r12): the point of the persistent kernel is
 * that in-kernel data does NOT transit the model context. Every nested
 * mux.* record becomes a compact {toolName, args, ok, bytes, error?} summary —
 * never an inline result, regardless of size. The running guest already
 * received the full value; return value / console / vars are the model's
 * deliberate channels for surfacing data. On failure the error message stays
 * visible (bounded — message only) so the model can retry intelligently.
 * Mutates `result` in place; nested UI events already streamed the full
 * values live.
 *
 * Exception: mux.load records stay as-is when the kernel load is active —
 * their result is a bounded {key, bytes, lines, preview} summary by
 * construction (the file content goes host-side straight into vars and never
 * touches the record), and the model needs the key/shape it just created.
 * When the kernel load is inactive, a bridged tool that happens to be named
 * "load" gets no exception (its records are ordinary and must not leak).
 *
 * Exception: exempt records (agent_skill_read, file_edit_*, media-bearing
 * results — see isKernelRecordResultExempt) keep their result for
 * post-compaction persistence extractors and request-time media extraction.
 */
function compactKernelToolCallRecords(result: PTCExecutionResult, loadActive: boolean): void {
  result.toolCalls = result.toolCalls.map((record) => {
    // Load records keep their result ({key, bytes, lines, preview} — bounded
    // by construction: parseLoadArgs caps the key, the preview is capped
    // host-side; an optional hookResult annotation is repo-controlled hook
    // output, the same trust class ordinary file_read exposes), but their
    // ARGS and ERROR are still guest-influenced: a
    // rejected call's record can carry an unbounded key/path, and host error
    // messages echo guest paths verbatim (ENAMETOOLONG), so bound both like
    // every other record.
    if (loadActive && record.toolName === "load") {
      return {
        ...record,
        args: boundCompactRecordArgs(record.args),
        ...(record.error !== undefined ? { error: boundCompactRecordError(record.error) } : {}),
      };
    }
    // A result already replaced by a __kernelBounded marker at capture
    // (execution-wide retained budget exhausted) carries no extractable
    // payload: the name-based persistence exemption below would keep the
    // marker as the record's result, and edit extractors would then see a
    // result without success:true and drop the record's PATH attribution
    // too. Compact it normally instead — the result-less {ok, bytes} summary
    // keeps crash-safe edited-file tracking and reports the honest size.
    const captureBounded =
      typeof record.result === "object" &&
      record.result !== null &&
      (record.result as { __kernelBounded?: boolean }).__kernelBounded === true &&
      // The boolean is unnamespaced, so a bridged server's result can carry
      // its own __kernelBounded field alongside real media. A GENUINE runtime
      // marker ({__kernelBounded, bytes, preview}) never contains extractable
      // media, so the media exemption takes priority — otherwise a retained,
      // sanitized media payload would be compacted away and the model would
      // never receive the attachment (r27).
      !containsMediaContentPayload(record.result);
    // Exempt records also keep their result (see isKernelRecordResultExempt;
    // creation-time capture bounding applies the same predicate, so the full
    // payload actually reaches this point): persistence extractors mine
    // nested file_edit_* diffs and agent_skill_read snapshots out of history
    // after compaction, and media containers from bridged MCP tools must
    // reach request-time attachment extraction or RLM users could never see
    // bridged screenshots/images.
    if (!captureBounded && isKernelRecordResultExempt(record.toolName, record.result)) {
      return {
        ...record,
        args: boundCompactRecordArgs(record.args),
        ...(record.error !== undefined ? { error: boundCompactRecordError(record.error) } : {}),
      };
    }
    let bytes = 0;
    if (record.result !== undefined) {
      // Creation-time bounding (kernel mode) may have replaced the result
      // with a marker carrying the TRUE size; report that, not marker size.
      const bounded = record.result as { __kernelBounded?: boolean; bytes?: number };
      if (bounded.__kernelBounded === true && typeof bounded.bytes === "number") {
        bytes = bounded.bytes;
      } else {
        try {
          bytes = Buffer.byteLength(JSON.stringify(record.result) ?? "", "utf8");
        } catch {
          // Bridged results are JSON round-tripped, so this is unreachable in
          // practice; size 0 is an honest fallback (nothing model-visible).
          bytes = 0;
        }
      }
    }
    // Tools like file_read resolve normally with {success: false} instead of
    // throwing (missing/oversized/directory paths) — no `error` is recorded.
    // The compact record drops `result`, and its ok bit is what
    // post-compaction read tracking trusts: marking those calls ok would
    // advertise never-read paths in the already-read-files attachment (r22).
    const resultReportsFailure =
      typeof record.result === "object" &&
      record.result !== null &&
      (record.result as { success?: unknown }).success === false;
    return {
      toolName: record.toolName,
      args: boundCompactRecordArgs(record.args),
      ok: record.error === undefined && !resultReportsFailure,
      bytes,
      ...(record.error !== undefined ? { error: boundCompactRecordError(record.error) } : {}),
      duration_ms: record.duration_ms,
    };
  });
}

/**
 * Bound the error echoed in a compact kernel record (defense in depth behind
 * the runtime's creation-time bounding). Host error messages can embed
 * guest-supplied data verbatim — ENAMETOOLONG echoes the full oversized path —
 * and the compact record is the model-visible surface, so an unbounded error
 * would persist megabytes into history and provider context.
 */
function boundCompactRecordError(error: string): string {
  const bytes = Buffer.byteLength(error, "utf8");
  if (bytes <= KERNEL_COMPACT_ARGS_CAP_BYTES) return error;
  return `${sliceUtf8Bytes(error, KERNEL_COMPACT_ARGS_CAP_BYTES)}…[${bytes} bytes total; truncated]`;
}

/**
 * Bound the args echoed in a compact kernel record. Args are guest-supplied
 * and can embed kernel data (e.g. `xum.file_write({content: vars.large})`),
 * which would reopen the context leak that result suppression closed. Small
 * args pass through untouched; oversized args are replaced with a bounded
 * head preview plus the true size.
 */
function boundCompactRecordArgs(args: unknown): unknown {
  // Already bounded at creation time (kernel record bounds in the runtime):
  // pass the marker through instead of double-wrapping it.
  if (
    typeof args === "object" &&
    args !== null &&
    (args as { __kernelBounded?: boolean }).__kernelBounded === true
  ) {
    return args;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    // Bridged args are JSON round-tripped, so this is unreachable in
    // practice; suppress entirely rather than risk leaking via toString.
    return { argsPreview: "[unserializable]", argsBytes: 0 };
  }
  const size = Buffer.byteLength(serialized, "utf8");
  if (size <= KERNEL_COMPACT_ARGS_CAP_BYTES) return args;
  return {
    argsPreview: `${sliceUtf8Bytes(serialized, KERNEL_COMPACT_ARGS_CAP_BYTES)}…[${size} bytes total; truncated]`,
    argsBytes: size,
  };
}

/**
 * Kernel-mode console bound (r12): console output is the model's deliberate
 * debug/print channel and stays visible, but it must not become a suppression
 * bypass. Total console bytes per execution are capped; the crossing record
 * keeps a bounded head and a final warn record reports what was dropped —
 * never a silent drop. Byte accounting uses the JSON serialization of each
 * record's args (what the model would see). Mutates `result` in place.
 */
function capKernelConsoleOutput(result: PTCExecutionResult): void {
  let total = 0;
  let droppedRecords = 0;
  let droppedBytes = 0;
  const kept: PTCConsoleRecord[] = [];
  for (const record of result.consoleOutput) {
    let serialized: string;
    try {
      serialized = JSON.stringify(record.args) ?? "";
    } catch {
      serialized = "";
    }
    const size = Buffer.byteLength(serialized, "utf8");
    if (droppedRecords === 0 && total + size <= KERNEL_CONSOLE_CAP_BYTES) {
      kept.push(record);
      total += size;
      continue;
    }
    droppedRecords += 1;
    if (droppedRecords === 1 && total < KERNEL_CONSOLE_CAP_BYTES) {
      // Crossing record: keep a bounded head instead of dropping it whole.
      const remaining = KERNEL_CONSOLE_CAP_BYTES - total;
      kept.push({
        level: record.level,
        args: [`${sliceUtf8Bytes(serialized, remaining)}…[truncated]`],
        timestamp: record.timestamp,
      });
      droppedBytes += Math.max(0, size - remaining);
      total = KERNEL_CONSOLE_CAP_BYTES;
      continue;
    }
    droppedBytes += size;
  }
  if (droppedRecords === 0) return;
  kept.push({
    level: "warn",
    args: [
      `[console output truncated: ${KERNEL_CONSOLE_CAP_BYTES}-byte kernel cap reached; ${droppedRecords} record(s) / ~${droppedBytes} bytes dropped]`,
    ],
    timestamp: result.consoleOutput[result.consoleOutput.length - 1]?.timestamp ?? 0,
  });
  result.consoleOutput = kept;
}

/** Model-facing description options for createCodeExecutionTool. */
export interface CodeExecutionToolOptions {
  /**
   * RLM + PTC-exclusive posture: code_execution is the single kernel tool, so
   * its description leads with a short preamble tying the kernel features
   * (persistent vars, result handles + slicing, task_spawn/events) together.
   * Only honored when a persistent mount exists — advertising kernel features
   * without a kernel would instruct the model to use APIs that don't exist.
   */
  kernelFirst?: boolean;
  /**
   * Host file loader backing mux.load (r12 bulk ingestion). Only honored in
   * kernel mode with file_read bridged — same "never advertise a missing
   * API" rule as kernelFirst.
   */
  loadFile?: KernelFileLoader;
}

export async function createCodeExecutionTool(
  runtimeFactory: IJSRuntimeFactory,
  toolBridge: ToolBridge,
  emitNestedEvent?: (event: PTCEventWithParent) => void,
  withMount?: MountRunner,
  options?: CodeExecutionToolOptions
): Promise<Tool> {
  const bridgeableTools = toolBridge.getBridgeableTools();
  const state: DispatchState = { toolBridge, withMount, loadFile: options?.loadFile };

  // Kernel mode = persistent mount available (RLM experiment, or the
  // XUM_SANDBOX_PERSISTENT_MOUNTS dev override that rides the same path).
  // Gates every model-visible kernel surface below so RLM-off requests stay
  // byte-identical to today.
  const kernel = withMount !== undefined;

  // xum.load availability: kernel mode + a host file loader + file_read
  // bridged (load rides file_read's grant). Must match
  // ToolBridge.addKernelMethods so types/description never advertise a
  // missing member.
  const loadEnabled = kernel && options?.loadFile !== undefined && "file_read" in bridgeableTools;

  // Generate xum types for type validation and documentation (cached by tool set hash)
  const xumTypes = await getCachedXumTypes(bridgeableTools, { kernel, load: loadEnabled });

  // Persistent-kernel addendum: only advertised when this instance runs on a
  // persistent mount (RLM mode or XUM_SANDBOX_PERSISTENT_MOUNTS). Ephemeral
  // instances must keep today's description byte-identical so RLM-off
  // provider requests are unchanged.
  const persistentKernelNotes = !kernel
    ? ""
    : `

**Persistent kernel:** the global \`vars\` object persists across code_execution calls and turns (JSON-serializable values only) and survives restarts via snapshots. Nested tool results do NOT enter your context: each mux.* call's visible record is a compact {tool, ok, bytes} summary (plus the error message on failure). Data reaches you only through your \`return\` value (offloaded to a {handle, preview, size} vars handle like \`vars.__h1\` when >${Math.floor(RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES / 1024)}KB serialized — read or slice it in a follow-up call), \`console\` output (capped at ${Math.floor(KERNEL_CONSOLE_CAP_BYTES / 1024)}KB per execution), and \`vars\`. Keep working data in \`vars\` and return only what you need to see. Note \`mux.file_read\` errors beyond its ~16KB/1000-line per-call cap (it does not offload).${
        loadEnabled
          ? `
**Bulk file ingestion:** \`xum.load({path, key})\` reads a whole file host-side into \`vars[key]\` (string) and shows you only {key, bytes, lines, preview}. Use it instead of paginated \`xum.file_read\` for large files.`
          : ""
      }${
        "task" in bridgeableTools
          ? `
**Fire-and-forget sub-agents:** \`xum.task_spawn(args)\` (same args as \`xum.task\`) returns immediately with {taskId, status:"spawned"} once the child is admitted. Terminal reports are queued in the kernel — drain with \`xum.events()\` in a later call. The queue is best-effort (an app restart may drop it); every report still reaches you via the normal task wake.`
          : ""
      }`;

  // Kernel-first preamble: only for the RLM + exclusive posture (see
  // CodeExecutionToolOptions). Exclusive mode without RLM and the env-var
  // mount override keep their current descriptions byte-identical.
  const kernelFirstPreamble =
    kernel && options?.kernelFirst === true
      ? `**Kernel-first workflow:** this is your primary tool — other tools are \`mux.*\` calls inside it. Write complete programs: batch ALL steps of a task — every file load, transformation, and check — into a single call using loops and in-code error handling (try/catch), instead of one tool call per code_execution; split into separate calls only when a later step genuinely depends on your own review of intermediate output. Persist state in \`vars\` across calls and turns; nested results stay in the kernel (you see compact {tool, ok, bytes} summaries), and an oversized return value comes back as {handle, preview, size} — read or slice the full value at its handle in a follow-up call${
          "task" in bridgeableTools
            ? "; spawn sub-agents with `xum.task_spawn(...)` and collect their reports with `xum.events()`"
            : ""
        }.

`
      : "";

  const codeExecutionTool = tool({
    description: `${kernelFirstPreamble}Execute sandboxed JavaScript to batch tools and transform outputs.

**When to use:** Prefer this tool when making 2+ tool calls, especially when later calls depend on earlier results. Reduces round-trip latency.

**Available tools (TypeScript definitions):**
\`\`\`typescript
${xumTypes}
\`\`\`

**Usage notes:**
- \`xum.*\` functions are synchronous—do not use \`await\`. \`mux.*\` is a compatibility alias.
- Use \`return\` to provide a final result to the model
- Use \`console.log/warn/error\` for debugging - output is captured
- Results are JSON-serialized; non-serializable values return \`{ error: "..." }\`
- On failure, partial results (completed tool calls) are returned for debugging${persistentKernelNotes}

**Security:** The sandbox has no access to \`require\`, \`import\`, \`process\`, \`fetch\`, or filesystem outside of \`xum.*\` tools.`,

    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript code to execute. xum.* calls are synchronous—do not use await. mux.* is a compatibility alias. Use 'return' for final result."
        ),
      timeout_secs: z
        .number()
        .int()
        .positive()
        .nullish()
        .describe(
          "Execution timeout in seconds (default: 300, max: 3600). " +
            "Increase when spawning subagents that may take 5-15+ minutes."
        ),
    }),

    execute: async (
      { code, timeout_secs },
      { abortSignal, toolCallId }
    ): Promise<PTCExecutionResult> => {
      const execStartTime = Date.now();

      const { toolBridge: activeBridge, withMount: activeMount, loadFile: activeLoadFile } = state;

      // Mirrors the creation-time loadEnabled gate.
      const loadActive =
        activeLoadFile !== undefined && activeBridge.getBridgeableToolNames().includes("file_read");

      // Static analysis before execution - catch syntax errors and sandbox-forbidden patterns.
      // TypeScript typing issues are intentionally non-blocking for one-off runtime scripts.
      const analysis = await analyzeCode(code);
      if (!analysis.valid) {
        const errorMessages = analysis.errors.map((e) => {
          const location =
            e.line && e.column
              ? ` (line ${e.line}, col ${e.column})`
              : e.line
                ? ` (line ${e.line})`
                : "";
          return `- ${e.message}${location}`;
        });
        return {
          success: false,
          error: `Code analysis failed:\n${errorMessages.join("\n")}`,
          toolCalls: [],
          consoleOutput: [],
          duration_ms: Date.now() - execStartTime,
        };
      }

      const runWithRuntime = async (
        mount: SandboxMount | null,
        runtime: IJSRuntime
      ): Promise<PTCExecutionResult> => {
        const onAbort = () => runtime.abort();
        try {
          // Set resource limits (clamp timeout to max)
          const timeoutSecs = Math.min(timeout_secs ?? DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
          runtime.setLimits({
            memoryBytes: DEFAULT_MEMORY_BYTES,
            timeoutMs: timeoutSecs * 1000,
          });

          // Subscribe to events for UI streaming
          // Wrap callback to include parentToolCallId from AI SDK context
          if (emitNestedEvent) {
            runtime.onEvent((event: PTCEvent) => {
              emitNestedEvent({ ...event, parentToolCallId: toolCallId });
            });
          }

          // Register tools - they'll use runtime.getAbortSignal() for cancellation.
          // Always re-register, even on reused persistent mounts: each request
          // builds a fresh ToolBridge from the CURRENT policy + grants, and a
          // stale bridge would keep exposing tools after permissions narrowed.
          // Registration just overwrites the guest's `xum`/`mux` globals and
          // reuses cached guest function handles (QuickJS host-function ids
          // are a finite per-context budget; see QuickJSRuntime), so this is
          // cheap and idempotent. Persistent mounts get the kernel extras
          // (xum.task_spawn / xum.events) bound to this mount's event queue.
          activeBridge.register(
            runtime,
            mount?.lifetime === "persistent"
              ? {
                  drainHostEvents: () => mount.drainHostEvents(),
                  ...(activeLoadFile !== undefined ? { loadFile: activeLoadFile } : {}),
                }
              : undefined
          );

          // Handle abort signal - interrupt sandbox and cancel nested tools
          if (abortSignal) {
            // If already aborted, abort runtime immediately
            if (abortSignal.aborted) {
              runtime.abort();
            } else {
              abortSignal.addEventListener("abort", onAbort, { once: true });
            }
          }

          // Execute the code. Detach the abort listener the moment eval
          // settles (r53): its only job is interrupting THIS eval, and the
          // post-eval persistence below (vars snapshot + handle publication)
          // takes real time. eval()'s finally has already cleared the
          // runtime's sticky abort flag, so an Esc landing in that window
          // would re-set it via onAbort — and the NEXT call on this reused
          // persistent runtime would then abort immediately at its own
          // eval() start. The outer finally's removal stays as the safety
          // net for pre-eval throws (removeEventListener is idempotent).
          let result: PTCExecutionResult;
          try {
            result = await runtime.eval(code);
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
          }

          // Kernel-mode context isolation (r12): nested records become compact
          // summaries and console output is bounded, regardless of grants —
          // suppression only drops data, it stores nothing. Runs even for
          // failed evals: partial toolCalls records are model-visible too and
          // must not leak either (their error messages stay visible).
          if (mount?.lifetime === "persistent") {
            compactKernelToolCallRecords(result, loadActive);
            capKernelConsoleOutput(result);
          } else {
            // Classic executions have no offload stage, so a guest that
            // RETURNS a bridged media container assigns the raw multi-image
            // payload directly to the outer result, which persists into this
            // record's history row — the capture sanitizer only covers nested
            // tool-call records and console args, and request-time attachment
            // extraction rewrites only the provider copy, never
            // partial.json/chat.jsonl. Budget it at the same boundary, using
            // the SAME execution allowance as the nested records (r29): a
            // fresh per-value budget would retain the payload twice (record +
            // outer result), doubling the intended media bound. Kernel mode
            // is excluded on purpose: its outer result feeds vars-handle
            // offloading, which must store full fidelity for the guest.
            result.result = sanitizeCapturedMediaValue(
              result.result,
              runtime.classicCaptureBudgetFor?.(result.toolCalls)
            );
          }

          // Nested tools that produced attachments (e.g. attach_file) had
          // their media/display-file bytes stripped from sandbox-visible
          // values by the bridge; re-attach the originals on this result so
          // the request path delivers media to the model as real attachments
          // (extractToolMediaAsUserMessages) and the UI renders both kinds
          // from the carrier. Drain even for failed evals: received parts are
          // still valid, and leaving them pending would let them leak into a
          // later eval on this runtime.
          const attachmentParts = activeBridge.drainPendingAttachments(runtime);
          if (attachmentParts.length > 0) {
            result.attachments = attachmentParts;
          }

          // RLM return-value offloading BEFORE the vars snapshot below, so the
          // handle vars land in the same durable snapshot the model's
          // {handle, preview, size} record relies on.
          let pendingHandle: PendingResultHandle | null = null;
          if (mount?.lifetime === "persistent" && mount.grants.vars) {
            pendingHandle = await offloadOversizedReturnValue(mount, result);
            const returnHandleKey = pendingHandle?.key ?? null;

            // r12: loads count toward the r4 vars retention cap — register
            // this call's loaded keys and evict oldest managed entries
            // (handles + loads) beyond the cap. Keys the model was JUST told
            // about (new loads + the fresh return handle) are protected.
            // Retention failure must never fail the call (self-healing).
            // Keys come from the bridge's host-side buffer (r67), not the
            // model-visible records: an oversized hookResult annotation can
            // get a load record replaced by a keyless __kernelBounded
            // marker, and record-derived keys would then miss the vars
            // entry, letting repeated annotated loads bypass the cap.
            const newLoadKeys = activeBridge.drainNewlyLoadedVarsKeys();
            if (newLoadKeys.length > 0 || returnHandleKey !== null) {
              try {
                await mount.enforceVarsRetention({
                  newLoadKeys,
                  protectedKeys:
                    returnHandleKey !== null ? [...newLoadKeys, returnHandleKey] : newLoadKeys,
                  capBytes: RESULT_HANDLE_VARS_CAP_BYTES,
                });
              } catch (error) {
                log.warn("code_execution: vars retention enforcement failed; continuing", {
                  error,
                });
              }
            }
          }

          // Persist the shared vars namespace after each call on persistent
          // mounts so state survives crashes/restarts (turn-boundary snapshots
          // are the Track 2 refinement; per-call is the safe foundation).
          // Failed/timed-out/aborted evals may still have mutated vars before
          // failing and the live guest keeps those mutations, so persist after
          // failures too — memory and disk must agree.
          if (mount?.lifetime === "persistent" && mount.grants.vars) {
            let snapshotCommitted = false;
            try {
              await mount.persistVars();
              snapshotCommitted = true;
            } catch (persistError) {
              // Vars became unsnapshottable (cycle) or exceeded the snapshot
              // budget. Leaving the live mount would make memory and disk
              // permanently disagree; dispose it so the next acquire rebuilds
              // from the last durable snapshot. Never mask the eval result
              // with a snapshot error — but DO tell the model via a console
              // record when its own state was the cause, so it can trim vars
              // instead of silently losing this call's mutations.
              log.warn(
                "code_execution: vars snapshot failed; disposing mount so the next call restores the last durable snapshot",
                { persistError }
              );
              if (persistError instanceof VarsSnapshotBudgetError) {
                result.consoleOutput.push({
                  level: "warn",
                  args: [`[kernel] ${persistError.message}`],
                  timestamp: Date.now(),
                });
              }
              // Foreign-instance conflict (r68): the eval may have READ stale
              // vars (the foreign publish can land after the lease check,
              // mid-eval) and its mutations were refused, so returning the
              // eval as successful would silently drop them and leave stale
              // computed results model-visible. Fail the whole call as a
              // retryable conflict instead; the rewrites below still make the
              // records honest, and the next call rebuilds from the newest
              // (foreign) snapshot.
              const snapshotConflict = persistError instanceof SandboxSnapshotConflictError;
              if (snapshotConflict) {
                result.success = false;
                result.result = undefined;
                // Invoked nested calls are NOT rolled back by the conflict
                // (r69): a task message sent or file mutated inside this eval
                // already happened externally — only the vars persistence was
                // refused. A blanket "re-run" would replay those effects, so
                // when any were invoked, name them and instruct
                // reconciliation instead. A record with an error is NOT proof
                // of no side effect (r70): a tool can mutate externally and
                // then reject (e.g. a post-tool hook throws), so every
                // invoked non-load call counts conservatively. Loads are
                // excluded: they are reads whose vars entries did NOT survive
                // (their records are rewritten below with re-issue advice),
                // so replaying them is the fix, not a hazard.
                const invokedSideEffects = [
                  ...new Set(
                    result.toolCalls
                      .filter((record) => !(loadActive && record.toolName === "load"))
                      .map((record) => record.toolName)
                  ),
                ];
                result.error =
                  `${persistError.message}. Another Xum instance changed this workspace's ` +
                  `kernel state while this call ran: the call's vars mutations were discarded ` +
                  `and any value computed from the old state may be stale. The kernel rebuilds ` +
                  `from the newest snapshot on the next call. ` +
                  (invokedSideEffects.length > 0
                    ? `CAUTION: nested tool call(s) inside this eval were invoked and any ` +
                      `external effects were NOT rolled back (${invokedSideEffects.join(", ")}). ` +
                      `Do NOT re-run this call as-is — re-derive the lost vars state with a new ` +
                      `call that does not repeat those side effects.`
                    : `Re-run this call.`);
              }
              // A handle advertised THIS call did not survive (the mount is
              // being disposed and the next call restores the previous
              // durable snapshot). Applies to EVERY persist failure — over-
              // budget namespaces AND unsnapshottable state (e.g. the guest
              // created a cycle after the handle was stored). Rewrite the
              // result so the model is never promised missing state.
              const advertised = result.result as Partial<OffloadedValueRecord> | undefined;
              if (
                pendingHandle !== null &&
                advertised !== undefined &&
                typeof advertised.handle === "string" &&
                typeof advertised.preview === "string" &&
                typeof advertised.size === "number"
              ) {
                result.result = buildTruncatedRecord(advertised.preview, advertised.size);
              }
              // r14: loads advertised THIS call do not survive either — the
              // restored snapshot lacks their keys (a successful load can
              // itself be what pushed vars over the budget, since new load
              // keys are protected from retention eviction). Rewrite each
              // successful load record as a failure so the model is never
              // told a key exists that the durable snapshot lacks.
              if (loadActive) {
                for (const record of result.toolCalls) {
                  if (record.toolName !== "load" || record.error !== undefined) continue;
                  record.result = undefined;
                  record.error = snapshotConflict
                    ? "load succeeded in-kernel, but its vars entry did NOT survive: another " +
                      "Xum instance changed this workspace's kernel state concurrently. " +
                      "Re-issue the load."
                    : "load succeeded in-kernel, but its vars entry did NOT survive: the " +
                      "post-call vars snapshot failed and the kernel was reset to the last " +
                      "durable state. Free vars space (or load less), then re-issue the load.";
                }
              }
              mount.dispose();
            }
            // r28: publish the durable handle row/blob only AFTER the
            // snapshot committed. Publishing before persistVars left a
            // provenance row (and a metrics handle-adoption count) claiming a
            // handle the model never received whenever the snapshot failed
            // and the result was rewritten as truncated above. The
            // model-visible preview is durably logged with the tool result in
            // chat.jsonl either way; a journaling failure here only degrades
            // durability of the FULL value and must never fail the call
            // (self-healing doctrine).
            if (snapshotCommitted && pendingHandle !== null) {
              try {
                await mount.persistResultHandle(pendingHandle.persistArgs);
              } catch (error) {
                log.warn("code_execution: result-handle journaling failed; continuing", { error });
              }
            }
          }
          // Guest values arrive via ctx.dump() and can contain undefined (e.g.
          // console.log(undefined) or a returned {a: undefined}) or other
          // non-JSON values. Persistence JSON-normalizes them on reload, but
          // the LIVE object is embedded verbatim in the next step's
          // tool-result message, where the AI SDK's ModelMessage validation
          // rejects it and kills the stream (AI_InvalidPromptError) — while
          // the retry, rebuilt from rehydrated history, succeeds. Clone into
          // the exact JSON shape persistence produces so live and rehydrated
          // behavior are identical. Must stay the LAST step: the snapshot-
          // conflict rewrites above reintroduce undefined fields.
          return jsonSafeClone(result) as PTCExecutionResult;
        } finally {
          // A late abort of THIS call's signal must not poison a reused runtime.
          abortSignal?.removeEventListener("abort", onAbort);
        }
      };

      // Persistent mounts can be handed to concurrent code_execution calls
      // for the same workspace, but eval() mutates runtime-wide state (abort
      // controller, tool-call attribution, event handler). The lease runner
      // holds the scope lock from acquisition through the whole
      // register→eval→persist sequence, so concurrent calls, grant changes,
      // and scope disposal are all serialized against this execution.
      if (activeMount) {
        return await activeMount((mount) => runWithRuntime(mount, mount.runtime));
      }
      // Classic ephemeral flow: per-call runtime, no serialization needed.
      const runtime = await runtimeFactory.create();
      try {
        return await runWithRuntime(null, runtime);
      } finally {
        runtime.dispose();
      }
    },
  });
  return codeExecutionTool;
}
