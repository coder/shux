/**
 * Tool Bridge for PTC
 *
 * Bridges Xum tools into the QuickJS sandbox, making them callable via `xum.*`
 * (canonical) and `mux.*` (compatibility alias). Handles argument validation
 * (Zod-schema tools validate host-side; JSON-Schema-based tools such as MCP
 * pass through to server-side validation) and result serialization.
 */

import { randomUUID } from "node:crypto";
import type { Tool } from "ai";
import type { z } from "zod";
import type { IJSRuntime } from "./runtime";
import type { KernelFileLoader } from "@/node/services/tools/kernelFileLoad";
import { KERNEL_COMPACT_ARGS_CAP_BYTES } from "@/constants/kernelOutput";
import { RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES } from "@/constants/resultHandles";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import {
  FULL_GRANTS,
  isBridgeToolGranted,
  type CapabilityGrants,
} from "@/common/types/capabilityGrants";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import {
  DISPLAY_DATA_STUB,
  MEDIA_BUDGET_EXCEEDED_STUB,
  MEDIA_DATA_STUB,
  mediaUnsupportedStub,
  isMediaPart,
  type ToolAttachmentPart,
} from "@/common/utils/attachments/toolAttachmentParts";
import {
  retainExemptKernelRecordResult,
  retainPersistenceCriticalArgsFields,
  retainWorkflowResultIdentityFields,
  sanitizeMediaRecordCapture,
} from "./types";

/**
 * Aggregate per-eval limits for attachment parts stripped from bridged results.
 * Forwardable parts live outside QuickJS memory accounting, and unsupported
 * media still consumes the byte budget to bound repeated calls.
 */
export const MAX_PENDING_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/**
 * Result shape of an AI SDK Schema's optional custom validator
 * (provider-utils ValidationResult, which the 'ai' package does not re-export).
 */
type SchemaValidationResult = { success: true; value: unknown } | { success: false; error: Error };

/**
 * RLM kernel extras for register(): host bindings that only exist on
 * persistent mounts. Presence of this options object is the availability
 * gate — RLM off (no persistent mount) => mux.task_spawn / mux.events /
 * mux.load are absent from the namespace entirely.
 */
export interface KernelBridgeOptions {
  /** Drains the mount's host→guest event queue (bound to SandboxMount). */
  drainHostEvents: () => unknown[];
  /**
   * Host-side bulk file ingestion backing mux.load (r12). Present only when
   * the assembly could resolve the workspace file context (cwd + runtime).
   * mux.load additionally requires the file_read tool to be bridged — it
   * rides file_read's capability grant.
   */
  loadFile?: KernelFileLoader;
}

/** Admission handle returned by mux.task_spawn (single or grouped spawn). */
export type TaskSpawnAdmissionHandle =
  | { taskId: string; status: "spawned" }
  | { taskIds: string[]; status: "spawned" };

/**
 * Map the task tool's non-blocking (run_in_background) result to the compact
 * admission handle mux.task_spawn returns. The pending result proves the
 * child was admitted by taskService; everything else (status, notes) is
 * intentionally dropped — completion arrives via host events / the durable
 * terminal wake, not by polling this handle.
 */
function extractAdmissionHandle(result: unknown): TaskSpawnAdmissionHandle {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (typeof record.taskId === "string" && record.taskId.length > 0) {
      return { taskId: record.taskId, status: "spawned" };
    }
    const taskIds: unknown = record.taskIds;
    if (
      Array.isArray(taskIds) &&
      taskIds.length > 0 &&
      taskIds.every((id): id is string => typeof id === "string")
    ) {
      return { taskIds, status: "spawned" };
    }
  }
  // Impossible by construction: the task tool's background result always
  // carries taskId(s). Crash-fast so a contract drift surfaces immediately.
  throw new Error("task_spawn: task admission returned no taskId");
}

/**
 * Collision-free synthetic toolCallId for bridged executions. Millisecond
 * timestamps are NOT unique: two concurrent guest calls (e.g. Promise.all of
 * grouped task_spawns) landing in the same ms would share an ID, and the task
 * tool derives its best-of group ID from toolCallId — colliding IDs merge
 * independent launches into one cohort, mixing completion/winner selection
 * across prompts.
 */
function syntheticToolCallId(toolName: string): string {
  return `ptc-${toolName}-${randomUUID()}`;
}

/**
 * Hard cap on a xum.load vars key. Keys are variable names; load records are
 * exempt from kernel record compaction (their summaries are bounded by
 * construction), so an unbounded key (e.g. `key: vars.large`) would ride the
 * exemption straight into model context. 128 bytes is generous for any real
 * identifier.
 */
export const LOAD_KEY_MAX_BYTES = 128;

/**
 * Validate mux.load arguments. Manual (no Zod): load is a hand-authored
 * kernel member with no backing tool schema, mirroring task_spawn's style.
 */
function parseLoadArgs(args: unknown): { path: string; key: string } {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const path = record.path;
  const key = record.key;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Invalid arguments for load: path must be a non-empty string");
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Invalid arguments for load: key must be a non-empty string");
  }
  if (Buffer.byteLength(key, "utf8") > LOAD_KEY_MAX_BYTES) {
    throw new Error(
      `Invalid arguments for load: key exceeds ${LOAD_KEY_MAX_BYTES} bytes (use a short variable name)`
    );
  }
  // __-prefixed vars keys are reserved kernel bookkeeping (__hN handles,
  // __handleSeq) — a load must not clobber them.
  if (key.startsWith("__")) {
    throw new Error('Invalid arguments for load: keys starting with "__" are reserved');
  }
  return { path, key };
}

const ptcExcludedTools = new Set(
  Object.entries(TOOL_DEFINITIONS).flatMap(([name, definition]) =>
    "ptcExcluded" in definition ? [name] : []
  )
);

// Media-producing built-ins (attach_file, desktop_screenshot) are deliberately
// bridgeable because attachment bytes stay outside QuickJS memory.

/**
 * Bridge that exposes Xum tools in the QuickJS sandbox under canonical `xum.*` and legacy `mux.*` namespaces.
 */
export class ToolBridge {
  private readonly bridgeableTools: Map<string, Tool>;
  private readonly nonBridgeableTools: Map<string, Tool>;
  /** Bridgeable tools denied by capability grants: stubbed with a clear error
   * in the sandbox and exposed in NEITHER getter (a denied tool must not leak
   * into the model-visible set via getNonBridgeableTools in exclusive mode). */
  private readonly deniedToolNames = new Set<string>();
  private readonly grants: CapabilityGrants;
  /** Vars keys written by xum.load since the last drain (r67): the
   * authoritative host-side record of successful loads, immune to
   * model-visible record bounding (see drainNewlyLoadedVarsKeys). */
  private newlyLoadedVarsKeys: string[] = [];
  /** Attachment parts (model media + display-only files) stripped from
   * bridged results, keyed per runtime so parallel code_execution calls
   * sharing this bridge cannot claim each other's parts (ephemeral runtimes
   * are per-call; persistent mounts serialize evals under the scope lock). */
  private readonly pendingAttachments = new WeakMap<IJSRuntime, ToolAttachmentPart[]>();
  /** Aggregate stripped-media bytes per runtime/eval, including unsupported
   * media that is discarded rather than forwarded to the provider. */
  private readonly pendingAttachmentBytes = new WeakMap<IJSRuntime, number>();

  constructor(tools: Record<string, Tool>, grants?: CapabilityGrants) {
    this.bridgeableTools = new Map();
    this.nonBridgeableTools = new Map();
    this.grants = grants ?? FULL_GRANTS;

    for (const [name, tool] of Object.entries(tools)) {
      // code_execution is the tool that uses the bridge, not a candidate for bridging
      if (name === "code_execution") continue;

      // status_set is dynamic and UI-specific, so it has no catalog entry.
      const isBridgeable =
        name !== "status_set" && !ptcExcludedTools.has(name) && this.hasExecute(tool);
      if (!isBridgeable) {
        this.nonBridgeableTools.set(name, tool);
      } else if (isBridgeToolGranted(this.grants, name)) {
        this.bridgeableTools.set(name, tool);
      } else {
        this.deniedToolNames.add(name);
      }
    }
  }

  /** Get list of tools that will be exposed in sandbox */
  getBridgeableToolNames(): string[] {
    return Array.from(this.bridgeableTools.keys());
  }

  /**
   * Keys xum.load successfully wrote into vars since the last drain (r67).
   * Evals under a persistent mount are serialized by the scope lock, so a
   * post-eval drain yields exactly that eval's loads — plus, after a hard
   * eval crash, any loads the crashed eval completed first, which still
   * belong in retention bookkeeping (their vars entries exist).
   */
  drainNewlyLoadedVarsKeys(): string[] {
    const keys = [...new Set(this.newlyLoadedVarsKeys)];
    this.newlyLoadedVarsKeys = [];
    return keys;
  }

  /** Get the bridgeable tools as a Record */
  getBridgeableTools(): Record<string, Tool> {
    return Object.fromEntries(this.bridgeableTools.entries());
  }

  /**
   * Get tools that cannot be bridged into the sandbox.
   * These are tools that either:
   * - Are explicitly excluded (UI-specific, mode-specific)
   * - Don't have an execute function (provider-native like web_search)
   *
   * In exclusive PTC mode, these should still be available to the model directly.
   */
  getNonBridgeableTools(): Record<string, Tool> {
    return Object.fromEntries(this.nonBridgeableTools.entries());
  }

  /**
   * Register all bridgeable tools on the runtime under canonical `xum` and legacy `mux` namespaces.
   *
   * Tools receive the runtime's abort signal, which is aborted when:
   * - The sandbox timeout is exceeded
   * - runtime.abort() is called (e.g., from the parent's abort signal)
   *
   * This ensures nested tool calls are cancelled when the sandbox times out,
   * not just when the parent stream is cancelled.
   */
  register(runtime: IJSRuntime, kernel?: KernelBridgeOptions): void {
    // Every execution re-registers before eval, so this is the per-eval reset
    // point: stale attachments from a crashed/aborted prior eval on this
    // runtime must not leak into the next eval's drain.
    this.pendingAttachments.delete(runtime);
    this.pendingAttachmentBytes.delete(runtime);
    // Kernel mode bounds record/event capture at creation (host memory and
    // streamed-to-history events); ephemeral registrations keep full records
    // (the non-RLM inline-results contract). Post-eval compaction still
    // bounds the model-visible set. Exempt records (persistence-critical
    // tools, media containers) keep full results through BOTH stages — see
    // isKernelRecordResultExempt.
    runtime.setKernelRecordBounds(
      kernel !== undefined
        ? {
            argsCapBytes: KERNEL_COMPACT_ARGS_CAP_BYTES,
            resultCapBytes: RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES,
            captureRetained: retainExemptKernelRecordResult,
            captureArgsRetained: retainPersistenceCriticalArgsFields,
            captureResultRetained: retainWorkflowResultIdentityFields,
          }
        : undefined
    );
    // Media containers are budgeted at capture in BOTH modes: classic records
    // keep full inline results by contract, but exclusive PTC makes the
    // bridge the only route to executable MCP tools, and request-time
    // attachment extraction rewrites only the provider copy — records/events
    // persisted into partial.json/chat.jsonl need the budget regardless of
    // kernel mode.
    runtime.setCaptureResultSanitizer(sanitizeMediaRecordCapture);
    const xumObj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

    // Grant-denied tools get an explicit stub: the guest sees a clear
    // capability error instead of a confusing "xum.x is not a function".
    for (const name of this.deniedToolNames) {
      xumObj[name] = () =>
        Promise.reject(new Error(`Capability denied: xum.${name} is not granted for this sandbox`));
    }

    for (const [name, tool] of this.bridgeableTools) {
      // Capture tool for closure
      const boundTool = tool;
      const toolName = name;

      xumObj[name] = async (args: unknown) => {
        // MUST be the first operation: the runtime hands over the nested
        // record's callId through a synchronous window (see
        // IJSRuntime.takeActiveHostCallId). Using it as the execute
        // toolCallId lets tool-emitted UI events (workflow-run-attached,
        // task-created, live bash output) target the transcript's nested
        // tool call instead of an id no rendered card carries.
        const bridgedToolCallId = runtime.takeActiveHostCallId() ?? syntheticToolCallId(toolName);
        // Defense in depth: re-check the grant at call time so a stale or
        // mutated bridge can never invoke a non-granted tool.
        if (!isBridgeToolGranted(this.grants, toolName)) {
          throw new Error(`Capability denied: xum.${toolName} is not granted for this sandbox`);
        }

        // Get the runtime's abort signal - this is aborted on timeout or manual abort
        const abortSignal = runtime.getAbortSignal();

        // Check if already aborted before executing
        if (abortSignal?.aborted) {
          throw new Error("Execution aborted");
        }

        // Validate args against the tool's schema (Zod or AI SDK wrapper)
        const validatedArgs = await this.validateArgs(toolName, boundTool, args, abortSignal);

        // validateArgs races the validator against the abort signal; this
        // recheck covers an abort that lands after validation settles but
        // before execute (mirrors the post-await recheck in mux.load).
        if (abortSignal?.aborted) {
          throw new Error("Execution aborted");
        }

        // Execute tool with full options (toolCallId and messages are required by type
        // but not used by most tools; messages stay synthetic for sandbox context)
        const result: unknown = await boundTool.execute!(validatedArgs, {
          abortSignal,
          toolCallId: bridgedToolCallId,
          messages: [],
          context: undefined,
        });

        // Ensure result is JSON-serializable
        return this.stripAttachmentParts(runtime, this.serializeResult(result));
      };
    }

    const syncMethods: Record<string, (...args: unknown[]) => unknown> = {};
    if (kernel !== undefined) {
      this.addKernelMethods(xumObj, syncMethods, kernel, runtime);
    }
    // Same object under both names so saved `mux.*` snippets keep working.
    runtime.registerObject("xum", xumObj, syncMethods);
    runtime.registerObject("mux", xumObj, syncMethods);
  }

  /**
   * RLM kernel namespace members (persistent mounts only):
   * - mux.task_spawn: fire-and-forget spawn. Same params as mux.task, forced
   *   run_in_background so the underlying tool returns as soon as taskService
   *   admits the child — an asyncified call that never waits for completion.
   *   Rides the same capability grant as `task`.
   * - mux.events: drains the mount's host→guest event queue (spawned-task
   *   terminal reports). MUST be a sync method: guests call it from
   *   continuations after `await`, where asyncified functions cannot suspend
   *   (see IJSRuntime.registerObject / QuickJSRuntime asyncify docs).
   */
  private addKernelMethods(
    xumObj: Record<string, (...args: unknown[]) => Promise<unknown>>,
    syncMethods: Record<string, (...args: unknown[]) => unknown>,
    kernel: KernelBridgeOptions,
    runtime: IJSRuntime
  ): void {
    const taskTool = this.bridgeableTools.get("task");
    if (taskTool !== undefined) {
      xumObj.task_spawn = async (args: unknown) => {
        // First operation, same synchronous-window contract as the regular
        // bridged tools above.
        const bridgedToolCallId =
          runtime.takeActiveHostCallId() ?? syntheticToolCallId("task_spawn");
        // task_spawn is subject to the same grant as task (defense in depth,
        // mirroring the per-call re-check on regular bridged tools).
        if (!isBridgeToolGranted(this.grants, "task")) {
          throw new Error("Capability denied: mux.task_spawn is not granted for this sandbox");
        }
        const abortSignal = runtime.getAbortSignal();
        if (abortSignal?.aborted) {
          throw new Error("Execution aborted");
        }
        const baseArgs = typeof args === "object" && args !== null ? args : {};
        const validatedArgs = await this.validateArgs(
          "task",
          taskTool,
          { ...baseArgs, run_in_background: true },
          abortSignal
        );
        // Same post-validation recheck as regular bridged tools: an abort that
        // lands after validation settles must not spawn the child.
        if (abortSignal?.aborted) {
          throw new Error("Execution aborted");
        }
        const result: unknown = await taskTool.execute!(validatedArgs, {
          abortSignal,
          toolCallId: bridgedToolCallId,
          messages: [],
          context: undefined,
        });
        return extractAdmissionHandle(result);
      };
    } else if (this.deniedToolNames.has("task")) {
      xumObj.task_spawn = () =>
        Promise.reject(
          new Error("Capability denied: mux.task_spawn is not granted for this sandbox")
        );
    }

    // mux.load (r12): honest bulk ingestion — the file content goes host-side
    // straight into vars[key]; the guest return (and thus the model-visible
    // record) only ever carries {key, bytes, lines, preview}. Rides the
    // file_read capability grant, mirroring task_spawn riding task's.
    const loadFile = kernel.loadFile;
    if (loadFile !== undefined) {
      if (this.bridgeableTools.has("file_read")) {
        xumObj.load = async (args: unknown) => {
          // Defense in depth: same call-time re-checks as regular bridged tools.
          if (!isBridgeToolGranted(this.grants, "file_read")) {
            throw new Error("Capability denied: mux.load is not granted for this sandbox");
          }
          // Loaded content lives in vars — without the vars grant there is no
          // namespace to load into.
          if (!this.grants.vars) {
            throw new Error("Capability denied: mux.load requires the vars grant");
          }
          const abortSignal = runtime.getAbortSignal();
          if (abortSignal?.aborted) {
            throw new Error("Execution aborted");
          }
          const { path, key } = parseLoadArgs(args);
          // Propagate kernel cancellation into the underlying I/O — without
          // it a stalled remote read rides RemoteRuntime's 300s cat timeout
          // even when code_execution's deadline is much shorter.
          const loaded = await loadFile({ path, abortSignal });
          // Re-check after the read: an abort that landed mid-read must not
          // mutate vars (the snapshot would persist a load the caller
          // believes was cancelled).
          if (abortSignal?.aborted) {
            throw new Error("Execution aborted");
          }
          // Host-side write into the guest heap: the content reaches
          // vars[key] without passing through the return value below (which
          // is all the record, the events, and the model ever see).
          runtime.setVarsProperty(key, loaded.content);
          // Authoritative load-key tracking (r67): the vars entry exists the
          // moment the write above succeeds, regardless of what happens to
          // the model-visible record (an oversized hookResult annotation can
          // get the whole record replaced by a keyless __kernelBounded
          // marker). Retention bookkeeping reads this buffer, not the
          // records, so annotated loads can never bypass the managed-vars cap.
          this.newlyLoadedVarsKeys.push(key);
          return {
            key,
            bytes: loaded.bytes,
            lines: loaded.lines,
            preview: loaded.preview,
            // r54: bounded model-visible hook annotations (never full content).
            ...(loaded.hookResult !== undefined ? { hookResult: loaded.hookResult } : {}),
          };
        };
      } else if (this.deniedToolNames.has("file_read")) {
        xumObj.load = () =>
          Promise.reject(new Error("Capability denied: mux.load is not granted for this sandbox"));
      }
    }

    syncMethods.events = this.grants.hostEvents
      ? () => kernel.drainHostEvents()
      : () => {
          throw new Error("Capability denied: mux.events is not granted for this sandbox");
        };
  }

  /**
   * Attachment-carrying parts inside bridged tool results (e.g. attach_file)
   * are useless as sandbox values: guests cannot see pixels, and the base64
   * would bloat vars, result handles, model-visible records, and the
   * host-side nested-call records/events (which sit outside QuickJS memory
   * accounting). Supported media and display-only files are carried onto
   * code_execution's result, while unsupported media is discarded. Nested
   * media copies become text so request extraction cannot treat stubs as files.
   */
  private stripAttachmentParts(runtime: IJSRuntime, serialized: unknown): unknown {
    if (!isToolContentResult(serialized)) {
      return serialized;
    }
    const carriedParts: ToolAttachmentPart[] = [];
    const pending = this.pendingAttachments.get(runtime) ?? [];
    let pendingBytes = this.pendingAttachmentBytes.get(runtime) ?? 0;
    let changed = false;
    const strip = <T extends ToolAttachmentPart>(
      part: T,
      stub: string,
      carry: boolean
    ): T | { type: "text"; text: string } => {
      if (
        carry &&
        pending.length + carriedParts.length >= MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST
      ) {
        return { type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB };
      }
      const partBytes = Buffer.byteLength(JSON.stringify(part), "utf8");
      if (pendingBytes + partBytes > MAX_PENDING_ATTACHMENT_BYTES) {
        return { type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB };
      }
      const stripped = isMediaPart(part)
        ? { type: "text" as const, text: stub }
        : { ...part, data: stub };
      const strippedBytes = carry ? Buffer.byteLength(JSON.stringify(stripped), "utf8") : 0;
      const retainedBytes = partBytes + strippedBytes;
      if (pendingBytes + retainedBytes > MAX_PENDING_ATTACHMENT_BYTES) {
        return { type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB };
      }
      pendingBytes += retainedBytes;
      this.pendingAttachmentBytes.set(runtime, pendingBytes);
      if (carry) {
        carriedParts.push(part);
      }
      return stripped;
    };
    const newValue = serialized.value.map((item) => {
      if (isMediaPart(item)) {
        changed = true;
        const supported = isSupportedAttachmentMediaType(item.mediaType);
        return strip(
          item,
          supported ? MEDIA_DATA_STUB : mediaUnsupportedStub(item.mediaType),
          supported
        );
      }
      if (isDisplayOnlyFilePart(item)) {
        changed = true;
        return strip(item, DISPLAY_DATA_STUB, true);
      }
      return item;
    });
    if (!changed) {
      return serialized;
    }
    if (carriedParts.length > 0) {
      for (const part of carriedParts) {
        pending.push(part);
      }
      this.pendingAttachments.set(runtime, pending);
    }
    return { type: "content", value: newValue };
  }

  /**
   * Drain forwardable attachment parts stripped from bridged results on this
   * runtime. register() clears stale entries before each eval, so a post-eval
   * drain yields exactly that eval's supported media and display-only files.
   */
  drainPendingAttachments(runtime: IJSRuntime): ToolAttachmentPart[] {
    const pending = this.pendingAttachments.get(runtime) ?? [];
    this.pendingAttachments.delete(runtime);
    this.pendingAttachmentBytes.delete(runtime);
    return pending;
  }

  private hasExecute(tool: Tool): tool is Tool & { execute: NonNullable<Tool["execute"]> } {
    return typeof tool.execute === "function";
  }

  private async validateArgs(
    toolName: string,
    tool: Tool,
    args: unknown,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    // Guests may call a capability with zero arguments (mux.tool()). Provider
    // tool calls always deliver an args object, and downstream consumers (MCP
    // servers, Zod object schemas) assume one — passing undefined through
    // produced opaque TypeErrors instead of readable validation errors.
    // Treat a zero-arg call as the canonical empty-args call.
    if (args === undefined) {
      args = {};
    }

    // AI SDK tools carry their schema on 'inputSchema'; some legacy tools use 'parameters'.
    const toolRecord = tool as { inputSchema?: unknown; parameters?: unknown };
    const schema = toolRecord.inputSchema ?? toolRecord.parameters;
    if (schema == null) return args;

    // Built-in tools carry Zod schemas and are validated here for early,
    // readable errors. Zod detection mirrors
    // typeGenerator.getInputJsonSchema's "_def" check.
    if (typeof schema === "object" && "_def" in schema) {
      const result = (schema as z.ZodType).safeParse(args);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid arguments for ${toolName}: ${issues}`);
      }
      return result.data;
    }

    // Non-Zod tools carry the AI SDK's jsonSchema() wrapper
    // ({ jsonSchema: <raw JSON Schema>, validate? }), which has no safeParse.
    // A wrapper-provided validator must be honored exactly like the direct
    // (non-kernel) call path does: it may reject invalid input or return a
    // normalized value, and may be async (ValidationResult | PromiseLike).
    const validate = (schema as { validate?: unknown }).validate;
    if (typeof validate === "function") {
      const validation = Promise.resolve(
        (
          validate as (
            value: unknown
          ) => SchemaValidationResult | PromiseLike<SchemaValidationResult>
        )(args)
      );
      // Race the validator against the runtime abort signal: QuickJS eval
      // aborts only settle suspended asyncified host calls, so a validator
      // that never settles would otherwise block this await forever and keep
      // a persistent kernel locked past timeouts and interrupts.
      const raced = await raceWithAbortAndTimeout(validation, { signal: abortSignal });
      if (raced.kind !== "ok") {
        throw new Error("Execution aborted");
      }
      const result = raced.value;
      if (!result.success) {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        throw new Error(`Invalid arguments for ${toolName}: ${message}`);
      }
      return result.value;
    }

    // Validator-less JSON Schema (e.g. MCP tools): pass through untouched,
    // matching the direct call path; the MCP server validates (and
    // mcpServerManager sanitizes) on its side.
    return args;
  }

  private serializeResult(result: unknown): unknown {
    try {
      // Round-trip through JSON to ensure QuickJS can handle the value.
      // Media returned by bridged MCP tools passes through intact: the guest
      // may legitimately process the bytes, and the classic (non-RLM) record
      // keeps the full result so extractAttachmentsFromToolOutput can lift
      // nested media into model-visible multimodal parts at request time.
      return JSON.parse(JSON.stringify(result));
    } catch {
      return { error: "Result not JSON-serializable" };
    }
  }
}
