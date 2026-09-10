/**
 * Programmatic Tool Calling (PTC) Types
 *
 * Event and result types for the sandboxed JS runtime that enables
 * multi-tool workflows via code execution.
 */

import type {
  CodeExecutionConsoleRecord,
  CodeExecutionResult,
  CodeExecutionToolCallRecord,
} from "@/common/types/codeExecution";
import { FILE_EDIT_TOOL_NAMES } from "@/common/types/tools";
import { WorkflowRunStatusSchema } from "@/common/orpc/schemas/workflow";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import { MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import {
  KERNEL_COMPACT_ARGS_CAP_BYTES,
  KERNEL_RETAINED_CONTAINER_MAX_PARTS,
  KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
  KERNEL_SANITIZED_MEDIA_VALUE_MAX_BYTES,
  KERNEL_RETAINED_PATH_MAX_BYTES,
} from "@/constants/kernelOutput";

/**
 * Event emitted when a tool call starts within the sandbox.
 */
export interface PTCToolCallStartEvent {
  type: "tool-call-start";
  callId: string; // Unique ID for correlation with end event
  toolName: string;
  args: unknown;
  startTime: number;
}

/**
 * Event emitted when a tool call ends within the sandbox.
 */
export interface PTCToolCallEndEvent {
  type: "tool-call-end";
  callId: string; // Same ID as start event for correlation
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  startTime: number;
  endTime: number;
}

/**
 * Event emitted when console.log/warn/error is called in the sandbox.
 */
export interface PTCConsoleEvent {
  type: "console";
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

export type PTCEvent = PTCToolCallStartEvent | PTCToolCallEndEvent | PTCConsoleEvent;

export type PTCToolCallRecord = CodeExecutionToolCallRecord;
export type PTCConsoleRecord = CodeExecutionConsoleRecord;
export type PTCExecutionResult = CodeExecutionResult;

/**
 * Nested records whose FULL result must survive kernel-mode capture bounding
 * and post-eval compaction (both consult this predicate):
 *
 * - Persistence-critical tools: post-compaction extractors mine successful
 *   nested file_edit_* diffs (extractEditedFileDiffs) and agent_skill_read
 *   snapshots (loadedSkillSnapshots) out of history. Their results are
 *   repo-controlled and tool-side bounded (~50k-char diff/snapshot caps), so
 *   retaining them matches what classic-mode records already expose.
 * - Media-bearing results: any bridged MCP tool may return a content
 *   container carrying base64 media. Request-time extraction
 *   (extractToolMediaAsUserMessages) turns nested media into model-visible
 *   multimodal attachments — impossible if capture bounding or compaction
 *   already dropped the payload, which would leave RLM users unable to see
 *   bridged screenshots/images at all. Media size is host-tool-produced (the
 *   same trust class as classic-mode records) and rasters are resized at
 *   request time.
 */
export function isKernelRecordResultExempt(toolName: string, result: unknown): boolean {
  return isPersistenceCriticalRecordToolName(toolName) || containsMediaContentPayload(result);
}

/**
 * Capture-time counterpart of isKernelRecordResultExempt (see
 * KernelRecordBounds.captureRetained): returns the value the record should
 * retain, or undefined to apply normal result bounding. Retained values are
 * SANITIZED, never raw:
 *
 * - Persistence-critical results are reduced to the bounded shape the
 *   extractors actually consume (see boundPersistenceCriticalResult) — the
 *   raw results are unbounded upstream (generateDiff has no cap), so a loop
 *   of large edits must not accumulate megabytes per execution in streamed
 *   events and persisted records.
 * - Media containers keep supported parts under an aggregate budget;
 *   unsupported parts (audio/blobs) and over-budget parts become bounded
 *   text placeholders BEFORE the record is retained and persisted.
 */
export function retainExemptKernelRecordResult(toolName: string, result: unknown): unknown {
  if (isPersistenceCriticalRecordToolName(toolName)) {
    return boundPersistenceCriticalResult(toolName, result);
  }
  if (!containsMediaContentPayload(result)) return undefined;
  // The budgeted graph walk handles every exempt shape (containers, bare
  // leaves, wrappers around either — r24); the container sanitizer alone
  // would crash on non-container shapes the exemption now accepts.
  return sanitizeCapturedMediaValue(result);
}

/**
 * Reduce a persistence-critical result to the bounded shape the
 * post-compaction extractors consume:
 *
 * - file_edit_*: { success?, diff?, diffTruncated?, error? } with oversized
 *   diffs truncated at a HUNK boundary (see boundRetainedEditDiff) — the
 *   ui_only diff variant is flattened onto `diff`, which the extractor reads
 *   as its fallback.
 * - agent_skill_read: { success, skill } / { success, error } passes through
 *   when its serialized size fits MAX_FILE_CONTENT_SIZE; oversized packages
 *   keep a schema-valid skill with a truncated body (see
 *   boundOversizedSkillPackage) instead of being discarded.
 */
function boundPersistenceCriticalResult(toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as { success?: unknown; error?: unknown };
  const success = typeof record.success === "boolean" ? { success: record.success } : {};
  const error =
    typeof record.error === "string"
      ? { error: record.error.slice(0, KERNEL_COMPACT_ARGS_CAP_BYTES) }
      : {};

  if (toolName === "agent_skill_read") {
    const skill = (result as { skill?: unknown }).skill;
    const reduced = { ...success, ...error, ...(skill !== undefined ? { skill } : {}) };
    const reducedLength = serializedJsonLength(reduced);
    if (reducedLength === undefined) return undefined;
    if (reducedLength <= MAX_FILE_CONTENT_SIZE) return reduced;
    return boundOversizedSkillPackage(skill, reducedLength, success, error);
  }

  const rawDiff = (result as { diff?: unknown }).diff;
  const uiOnlyDiff = getToolOutputUiOnly(result)?.file_edit?.diff;
  const diff = typeof uiOnlyDiff === "string" ? uiOnlyDiff : rawDiff;
  return {
    ...success,
    ...error,
    ...(typeof diff === "string" ? boundRetainedEditDiff(diff) : {}),
  };
}

/**
 * Note appended when a retained skill body is truncated at capture. Distinct
 * from the snapshot-limit note in skillSnapshot.ts: this cut point depends on
 * the package's serialized overhead, not MAX_AGENT_SKILL_SNAPSHOT_CHARS.
 */
const SKILL_BODY_CAPTURE_TRUNCATION_NOTE =
  "\n\n[Skill body truncated at capture to fit the retained-record cap]";

/**
 * Truncate an oversized skill package's BODY — the only unbounded field the
 * snapshot extractor consumes — so the retained {success, skill} fits
 * MAX_FILE_CONTENT_SIZE while AgentSkillPackageSchema still parses. A valid
 * skill whose package serializes just above the cap (body near the separately
 * supported 50k snapshot limit plus frontmatter overhead) must degrade to a
 * bounded body like createLoadedSkillSnapshot does, not lose the whole
 * package to a __kernelBounded marker (which compaction then drops entirely,
 * erasing the skill instructions from every later turn).
 *
 * The budget is computed in SERIALIZED space (r21): subtracting the RAW body
 * length from the package's serialized length treated the body's own escape
 * inflation (newlines, quotes, backslashes serialize to 2+ chars) as fixed
 * overhead, so an escape-heavy body drove the budget negative and lost the
 * whole package even though a shorter serialized prefix fits. Returns
 * undefined (normal bounding) for malformed packages the extractor would
 * reject anyway, or when the true non-body overhead alone exceeds the cap.
 */
function boundOversizedSkillPackage(
  skill: unknown,
  reducedLength: number,
  success: { success?: boolean },
  error: { error?: string }
): unknown {
  if (typeof skill !== "object" || skill === null) return undefined;
  const body = (skill as { body?: unknown }).body;
  if (typeof body !== "string") return undefined;
  // Serialized note length minus the surrounding quotes.
  const noteSerializedChars = JSON.stringify(SKILL_BODY_CAPTURE_TRUNCATION_NOTE).length - 2;
  // True non-body overhead: package serialized length minus the body's
  // SERIALIZED content chars (between its quotes).
  const serializedBodyChars = JSON.stringify(body).length - 2;
  const overhead = reducedLength - serializedBodyChars;
  // Zero is a VALID budget (r24): the empty body prefix + note then fits the
  // cap exactly; only a negative budget (overhead + note alone exceed the
  // cap) makes the package unretainable.
  const serializedBudget = MAX_FILE_CONTENT_SIZE - overhead - noteSerializedChars;
  if (serializedBudget < 0) return undefined;
  // Largest raw-body prefix whose serialized form fits the budget, searched
  // over CODE-POINT boundaries (r22): serialized length is NOT monotonic in
  // code units across a surrogate pair — a lone high surrogate escapes to 6
  // chars while the completed pair serializes as 2, so a code-unit midpoint
  // landing inside a leading emoji could reject a budget the whole pair fits.
  // Boundary prefixes never split pairs, and appending one code point (or one
  // unpaired surrogate, kept as its own unit) strictly grows the serialized
  // form, restoring monotonicity for the search.
  const boundaries: number[] = [0];
  for (let i = 0; i < body.length; ) {
    const code = body.charCodeAt(i);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < body.length &&
      body.charCodeAt(i + 1) >= 0xdc00 &&
      body.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
    boundaries.push(i);
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const midSerializedChars = JSON.stringify(body.slice(0, boundaries[mid])).length - 2;
    if (midSerializedChars <= serializedBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // cut === 0 (budget positive but smaller than the first code point) still
  // retains the package with an empty body prefix + note (r23): the empty
  // prefix is schema-valid and fits (serializedBudget > 0 established that
  // overhead + note fit under the cap), while returning undefined would
  // collapse the whole package to a kernel marker and erase the skill from
  // post-compaction context.
  const cut = boundaries[low];
  return {
    ...success,
    ...error,
    skill: { ...skill, body: `${body.slice(0, cut)}${SKILL_BODY_CAPTURE_TRUNCATION_NOTE}` },
  };
}

/**
 * Bound an oversized unified diff at a HUNK boundary. A mid-hunk slice is not
 * parseable — parsePatch throws on it and applyPatch cannot apply it — so
 * combineDiffs would fall back to ONLY the last diff for the file: a later
 * small edit would erase the earlier large edit from post-compaction context
 * entirely. Whole hunks form a valid, applicable prefix, and diffTruncated
 * propagates the loss to FileEditDiff.truncated (see extractEditedFileDiffs).
 * When not even the first hunk fits, only the flag is retained; the record
 * still attributes the edit via success + path.
 */
function boundRetainedEditDiff(diff: string): { diff?: string; diffTruncated?: true } {
  if (diff.length <= MAX_FILE_CONTENT_SIZE) return { diff };
  // Hunk headers are the only diff lines starting with "@@ " (body lines
  // start with ' ', '+', '-', or '\').
  const hunkHeader = /^@@ /gm;
  const hunkStarts: number[] = [];
  let match;
  while ((match = hunkHeader.exec(diff)) !== null) hunkStarts.push(match.index);
  let end = 0;
  for (let i = 0; i < hunkStarts.length; i++) {
    const hunkEnd = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : diff.length;
    if (hunkEnd > MAX_FILE_CONTENT_SIZE) break;
    end = hunkEnd;
  }
  if (end === 0) return { diffTruncated: true };
  return { diff: diff.slice(0, end), diffTruncated: true };
}

/**
 * JSON.stringify length in CHARACTERS, or undefined when unserializable
 * (cycles, BigInt). Used for the persistence-critical caps, which are char
 * caps by design: MAX_FILE_CONTENT_SIZE bounds repo-controlled diff/skill
 * text everywhere else in the codebase via .length/.slice(), and the
 * downstream extractors compare the same way.
 */
function serializedJsonLength(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
}

/**
 * JSON.stringify length in UTF-8 BYTES, or undefined when unserializable.
 * The media budget is a byte bound on persisted history: charging chars
 * would let server-controlled multibyte metadata (e.g. "image/" + millions
 * of CJK characters) occupy ~3x the documented budget on disk.
 */
function serializedJsonByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

/** Media-part shape check shared by the container predicates below. */
function asMediaPart(item: unknown): { data: string; mediaType?: string } | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as { type?: unknown; data?: unknown; mediaType?: unknown };
  if (record.type !== "media" || typeof record.data !== "string") return null;
  return {
    data: record.data,
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
  };
}

/**
 * Bounded label for placeholder text: mediaType is server-controlled and can
 * itself be arbitrarily long ("image/" + megabytes still passes the
 * supported-type prefix check), so never interpolate it raw.
 */
function boundedMediaTypeLabel(mediaType: string | undefined): string {
  if (mediaType === undefined) return "unknown";
  return mediaType.length > 100 ? `${mediaType.slice(0, 100)}…` : mediaType;
}

/**
 * See retainExemptKernelRecordResult / sanitizeMediaRecordCapture: sanitize a
 * retained media container. Unsupported media parts are always replaced with
 * bounded placeholders, and every OTHER retained part — media or not — is
 * charged its FULL serialized size (metadata and structure included) against
 * an aggregate budget (KERNEL_RETAINED_MEDIA_BUDGET_BYTES): MCP enforces only
 * a per-part data guard, so payloads could otherwise hide in mediaType
 * strings, sibling fields, or many individually-allowed images and persist
 * unbounded bytes into events and chat.jsonl rows. Part COUNT is bounded
 * separately (KERNEL_RETAINED_CONTAINER_MAX_PARTS) so placeholder structure
 * cannot grow without bound either. Idempotent: placeholders are small text
 * parts that re-charge identically on a second pass.
 */
function sanitizeRetainedMediaContainer(
  result: unknown,
  budget: { remainingBytes: number } = { remainingBytes: KERNEL_RETAINED_MEDIA_BUDGET_BYTES }
): unknown {
  const container = result as { type: "content"; value: unknown[] };
  const parts = container.value.slice(0, KERNEL_RETAINED_CONTAINER_MAX_PARTS);
  let changed = parts.length < container.value.length;
  const value: unknown[] = parts.map((item) => {
    const media = asMediaPart(item);
    if (
      media !== null &&
      (media.mediaType === undefined || !isSupportedAttachmentMediaType(media.mediaType))
    ) {
      changed = true;
      return {
        type: "text",
        text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — not supported as a model attachment]`,
      };
    }
    const serialized = serializedJsonByteLength(item);
    if (serialized !== undefined && serialized <= budget.remainingBytes) {
      budget.remainingBytes -= serialized;
      return item;
    }
    changed = true;
    return media !== null
      ? {
          type: "text",
          text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — aggregate media budget exceeded]`,
        }
      : {
          type: "text",
          text: `[part bounded at capture: ${serialized ?? "unserializable"} serialized bytes — aggregate media budget exceeded]`,
        };
  });
  if (parts.length < container.value.length) {
    value.push({
      type: "text",
      text: `[${container.value.length - parts.length} additional part(s) bounded at capture — container part limit exceeded]`,
    });
  }
  return changed ? { ...container, value } : result;
}

/**
 * Mode-independent capture sanitizer (see IJSRuntime.setCaptureResultSanitizer),
 * applied to results captured into records/events in BOTH classic and kernel
 * mode. Classic (non-RLM) records keep full inline results by contract, but
 * media containers are the exception: exclusive PTC makes the bridge the only
 * route to executable MCP tools, records/events persist into
 * partial.json/chat.jsonl, and request-time attachment extraction rewrites
 * only the provider copy — without a capture budget a server returning many
 * individually-allowed images would persist unbounded multi-megabyte records
 * in default (non-RLM) PTC mode. The guest still receives the full value.
 */
export function sanitizeMediaRecordCapture(
  _toolName: string,
  result: unknown,
  budget?: CaptureSanitizerBudget
): unknown {
  return sanitizeCapturedMediaValue(result, budget);
}

/**
 * Aggregate allowances shared across every capture that sanitizes against the
 * same budget object (classic mode shares ONE per execution — see
 * QuickJSRuntime.classicSanitizerBudgets; kernel mode gets a fresh one per
 * call, its cross-call growth being bounded by the retained-result budget).
 */
export interface CaptureSanitizerBudget {
  /** Bytes left for RETAINED supported media parts (and their retained
   * container siblings) — see KERNEL_RETAINED_MEDIA_BUDGET_BYTES. */
  remainingBytes: number;
  /** Serialized bytes left for media-BEARING sanitized values as a whole,
   * placeholders and non-media siblings included — see
   * KERNEL_SANITIZED_MEDIA_VALUE_MAX_BYTES. Placeholders are emitted for
   * safety and never debit the media allowance above, so without this
   * charge a loop of calls returning unsupported media would retain another
   * placeholder-flooded record per call without bound (r27 security).
   * Media-free values stay uncharged (classic keeps them inline by
   * contract). */
  remainingSanitizedBytes: number;
}

export function createCaptureSanitizerBudget(): CaptureSanitizerBudget {
  return {
    remainingBytes: KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
    remainingSanitizedBytes: KERNEL_SANITIZED_MEDIA_VALUE_MAX_BYTES,
  };
}

/** Constant replacement for media-bearing values captured after the shared
 * sanitized-value allowance is spent (r30): retention stops entirely rather
 * than emitting another size-annotated marker per call. */
export const SANITIZER_BUDGET_EXHAUSTED_STUB =
  "[media-bearing value omitted: capture sanitizer budget exhausted]";

/**
 * Tool-name-free form of sanitizeMediaRecordCapture for values that are not
 * nested tool records: the classic execution's outer return value and console
 * args also persist into the code_execution history row (see
 * createCodeExecutionTool), and `return xum.<mediaTool>(...)` /
 * `console.log(...)` would otherwise carry the raw unbudgeted container.
 *
 * Walks the ENTIRE value graph, not just the root: guests can wrap bridged
 * results arbitrarily (`return { image: xum.mcp__shots__take({}) }`), and a
 * root-only check would pass the wrapper through raw. All containers found in
 * one value share a single aggregate budget, so wrapping N containers cannot
 * multiply the bound. Object identity is memoized (shared subtrees stay
 * linear; cycle back-edges resolve to a bounded placeholder — cyclic values
 * cannot JSON-persist anyway).
 */
export function sanitizeCapturedMediaValue(
  value: unknown,
  // A caller-shared budget bounds media across MULTIPLE captures (classic
  // mode shares one per execution — see QuickJSRuntime.boundCaptureResult);
  // absent, each call gets the standalone per-value allowance.
  budget: CaptureSanitizerBudget = createCaptureSanitizerBudget()
): unknown {
  const state = { sawMedia: false };
  const sanitized = sanitizeMediaValueGraph(value, budget, state);
  if (!state.sawMedia) return sanitized;
  // Final serialized-output cap (r24): placeholders replacing unsupported or
  // over-budget media never consume the media budget (they must always be
  // emitted for safety), so a value flooding many media nodes could append
  // placeholder structures without bound. The cap DEBITS the shared budget
  // (r27 security): a per-value-only cap would let a loop of calls retain
  // another placeholder-flooded multi-megabyte record per call — once the
  // execution-wide allowance is spent, media-bearing values collapse to this
  // small marker. Media-free values are untouched and uncharged (classic
  // mode keeps full inline results/args by contract).
  const bytes = serializedJsonByteLength(sanitized);
  if (bytes !== undefined && bytes <= budget.remainingSanitizedBytes) {
    budget.remainingSanitizedBytes -= bytes;
    return sanitized;
  }
  // Over the remaining allowance (or unserializable).
  if (budget.remainingSanitizedBytes <= 0) {
    // Exhausted (r30): retention STOPS — a constant stub with no further
    // debit, so a fast call loop cannot keep accumulating size-annotated
    // markers nor drive the counter unboundedly negative. Per-record
    // structural overhead is all that remains, same as any non-media loop.
    return SANITIZER_BUDGET_EXHAUSTED_STUB;
  }
  const marker = `[value bounded at capture: ${bytes ?? "unserializable"} serialized bytes after media sanitization exceed the remaining sanitized-value budget]`;
  // The marker is charged too (r28): total marker bytes stay bounded by the
  // initial allowance, after which the exhausted branch above takes over.
  budget.remainingSanitizedBytes -= serializedJsonByteLength(marker) ?? marker.length;
  return marker;
}

/**
 * Iterative (explicit stack, post-order copy-on-write) traversal of the
 * value graph: media containers and standalone leaves are sanitized wherever
 * they sit, while media-free spans pass through with IDENTITY preserved —
 * classic mode keeps full inline results/args by contract, so depth-based
 * replacement of legitimate deep JSON is not acceptable (r25); iteration
 * removes the need for any depth bound. In-memory cycle back-edges resolve
 * to a bounded placeholder (cyclic values cannot JSON-persist anyway);
 * shared subtrees are processed once and reused.
 */
function sanitizeMediaValueGraph(
  root: unknown,
  budget: { remainingBytes: number },
  state: { sawMedia: boolean }
): unknown {
  if (typeof root !== "object" || root === null) return root;
  if (isMediaContentContainer(root)) {
    state.sawMedia = true;
    return sanitizeRetainedMediaContainer(root, budget);
  }
  if (asMediaPart(root) !== null) {
    // STANDALONE media leaves too (r23): guest code can pluck a part out of
    // a container (`const part = image.value[0]`) and return it, log it, or
    // pass it as another tool's argument — container-only recognition would
    // let that copy persist unbudgeted base64 on every call.
    state.sawMedia = true;
    return sanitizeStandaloneMediaPart(root, budget);
  }
  // Copy-on-write rebuilds keyed by original node identity; nodes absent
  // from this map are unchanged and reused as-is.
  const changed = new Map<object, unknown>();
  const processed = new Set<object>();
  const visiting = new Set<object>();
  const stack: Array<{ node: object; entered: boolean }> = [{ node: root, entered: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    if (!frame.entered) {
      if (processed.has(node) || visiting.has(node)) {
        stack.pop();
        continue;
      }
      frame.entered = true;
      visiting.add(node);
      const children: unknown[] = Array.isArray(node)
        ? node
        : Object.values(node as Record<string, unknown>);
      for (const child of children) {
        if (typeof child !== "object" || child === null) continue;
        if (processed.has(child) || visiting.has(child)) continue;
        // Media shapes are handled atomically at the parent's exit phase
        // (container parts are charged their full serialized size, so there
        // is no need to descend into them).
        if (isMediaContentContainer(child) || asMediaPart(child) !== null) continue;
        stack.push({ node: child, entered: false });
      }
      continue;
    }
    stack.pop();
    let nodeChanged = false;
    const rewriteChild = (child: unknown): unknown => {
      if (typeof child !== "object" || child === null) return child;
      if (isMediaContentContainer(child)) {
        state.sawMedia = true;
        const sanitized = sanitizeRetainedMediaContainer(child, budget);
        if (sanitized !== child) nodeChanged = true;
        return sanitized;
      }
      if (asMediaPart(child) !== null) {
        state.sawMedia = true;
        const sanitized = sanitizeStandaloneMediaPart(child, budget);
        if (sanitized !== child) nodeChanged = true;
        return sanitized;
      }
      // Back-edge to a node still being processed (self/ancestor cycle):
      // bounded placeholder instead of infinite structure.
      if (visiting.has(child)) {
        nodeChanged = true;
        return "[cyclic value bounded at capture]";
      }
      if (changed.has(child)) {
        nodeChanged = true;
        return changed.get(child);
      }
      return child;
    };
    // Rebuild while this node is still in `visiting` so self-references are
    // detected as cycles.
    const rebuilt = Array.isArray(node)
      ? node.map(rewriteChild)
      : Object.fromEntries(
          Object.entries(node as Record<string, unknown>).map(([key, child]) => [
            key,
            rewriteChild(child),
          ])
        );
    visiting.delete(node);
    processed.add(node);
    if (nodeChanged) {
      changed.set(node, rebuilt);
    }
  }
  return changed.has(root) ? changed.get(root) : root;
}

/**
 * Standalone {type:"media"} leaf outside any content container: unsupported
 * media is always replaced, supported media is charged its full serialized
 * size against the shared budget — mirroring sanitizeRetainedMediaContainer's
 * per-part handling so plucked parts cost the same as containered ones.
 */
function sanitizeStandaloneMediaPart(value: unknown, budget: { remainingBytes: number }): unknown {
  const media = asMediaPart(value);
  if (media === null) return value;
  if (media.mediaType === undefined || !isSupportedAttachmentMediaType(media.mediaType)) {
    return {
      type: "text",
      text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — not supported as a model attachment]`,
    };
  }
  const serialized = serializedJsonByteLength(value);
  if (serialized !== undefined && serialized <= budget.remainingBytes) {
    budget.remainingBytes -= serialized;
    return value;
  }
  return {
    type: "text",
    text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — aggregate media budget exceeded]`,
  };
}

/**
 * Any MCP-style content container carrying at least one media part —
 * supported or not. Broader than containsMediaContentPayload (which gates the
 * kernel retain EXEMPTION on extractable/supported media): the capture
 * sanitizer must also bound containers holding only unsupported media
 * (audio/blobs), which classic mode would otherwise persist raw.
 */
function isMediaContentContainer(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const container = result as { type?: unknown; value?: unknown };
  if (container.type !== "content" || !Array.isArray(container.value)) return false;
  return container.value.some((item: unknown) => asMediaPart(item) !== null);
}

/**
 * Capture-time attribution fields merged onto a __kernelBounded ARGS marker
 * (see KernelRecordBounds.captureArgsRetained): a file_edit_* whose args
 * exceed the kernel args cap (e.g. inserting >2 KiB of content) would
 * otherwise lose its `path`, and both post-compaction diff preservation and
 * crash-safe edited-file tracking skip records they cannot attribute —
 * silently dropping a successful edit whose bounded diff WAS retained. Only
 * the validated path field is preserved; the marker's preview keeps the head
 * of everything else.
 */
export function retainPersistenceCriticalArgsFields(
  toolName: string,
  args: unknown
): Record<string, unknown> | undefined {
  if (toolName === "workflow_run") {
    // A workflow_run whose args exceed the kernel args cap (large inline
    // script_source or invocation args) would otherwise lose script_path,
    // leaving the transcript workflow card without a display name until the
    // durable run loads. Same serialized-byte bound as file paths below.
    const scriptPath = (args as { script_path?: unknown } | null | undefined)?.script_path;
    if (typeof scriptPath !== "string" || scriptPath.length === 0) return undefined;
    const scriptPathBytes = serializedJsonByteLength(scriptPath);
    if (scriptPathBytes === undefined || scriptPathBytes > KERNEL_RETAINED_PATH_MAX_BYTES) {
      return undefined;
    }
    return { script_path: scriptPath };
  }
  if (!isPersistenceCriticalRecordToolName(toolName)) return undefined;
  const path = extractToolFilePath(args);
  if (path === undefined) return undefined;
  // Bound by SERIALIZED bytes, not UTF-16 code units (r26): JSON escaping can
  // expand a code-unit-capped multibyte/lone-surrogate string ~6x (to ~24
  // KiB), and this field merges onto a 2 KiB args marker — repeated oversized
  // records would persist and stream far past the advertised per-record cap.
  const serializedBytes = serializedJsonByteLength(path);
  if (serializedBytes === undefined || serializedBytes > KERNEL_RETAINED_PATH_MAX_BYTES) {
    return undefined;
  }
  return { path };
}

/**
 * Run-identity fields merged onto a __kernelBounded RESULT marker (see
 * KernelRecordBounds.captureResultRetained): a workflow_run/workflow_resume
 * result embedding a large run record or workflow output exceeds the kernel
 * result cap, and a bare marker would strip the runId/status the transcript
 * card needs to re-fetch the durable run after reload. Only the validated
 * identity fields are preserved; the run record and workflow output stay
 * bounded (never exempt workflow results from bounding: they can carry
 * megabytes of delegated-agent output).
 */
export function retainWorkflowResultIdentityFields(
  toolName: string,
  result: unknown
): Record<string, unknown> | undefined {
  if (toolName !== "workflow_run" && toolName !== "workflow_resume") return undefined;
  if (typeof result !== "object" || result === null) return undefined;
  const { runId, status } = result as { runId?: unknown; status?: unknown };
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  const runIdBytes = serializedJsonByteLength(runId);
  if (runIdBytes === undefined || runIdBytes > KERNEL_RETAINED_PATH_MAX_BYTES) return undefined;
  const parsedStatus = WorkflowRunStatusSchema.safeParse(status);
  return { runId, ...(parsedStatus.success ? { status: parsedStatus.data } : {}) };
}

/** See isKernelRecordResultExempt (persistence-critical branch). */
export function isPersistenceCriticalRecordToolName(toolName: string): boolean {
  return (
    toolName === "agent_skill_read" ||
    FILE_EDIT_TOOL_NAMES.includes(toolName as (typeof FILE_EDIT_TOOL_NAMES)[number])
  );
}

/**
 * MCP-style content container ({ type: "content", value: [...] }) holding at
 * least one media part that request-time extraction will actually consume
 * (supported attachment types: images/PDF/SVG). Unsupported media (audio,
 * blobs — up to MiBs of base64 the model can never see as an attachment) does
 * not justify exempting the record from kernel bounding; extraction replaces
 * any unsupported parts that ride along in an exempted container with bounded
 * placeholders at request time.
 *
 * The search walks through wrappers and non-media parts (r19) and accepts
 * the exact shapes the capture sanitizer bounds and the request-time
 * extractor consumes: content containers with an immediate supported media
 * child, and standalone supported media leaves (r24 — r20 restricted the
 * predicate to containers when downstream was container-only; r23 taught
 * both the sanitizer and the extractor to bound/extract standalone leaves,
 * so declining the exemption for them now just collapses an extractable
 * payload to a __kernelBounded marker). Retention stays bounded:
 * retainExemptKernelRecordResult sanitizes through the same budgeted graph
 * walk before the record is kept.
 */
export function containsMediaContentPayload(result: unknown): boolean {
  // Iterative, unbounded scan aligned with sanitizeMediaValueGraph (r26): the
  // retention sanitizer preserves media below ANY wrapper depth, so a
  // depth-capped predicate here would decline the exemption for payloads the
  // bounded retention walk can handle — kernel compaction would then drop an
  // extractable result before request-time extraction could attach it. The
  // visited set keeps shared subtrees linear and terminates cycle back-edges.
  const stack: unknown[] = [result];
  const visited = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const media = asMediaPart(value);
    if (media !== null) {
      if (media.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType)) {
        return true;
      }
      // Media leaves are terminal for the sanitizer/extractor — their fields
      // are never scanned for deeper payloads.
      continue;
    }
    if (isContentContainerShape(value) && hasImmediateSupportedMedia(value)) return true;
    const children: unknown[] = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (const child of children) stack.push(child);
  }
  return false;
}

function isContentContainerShape(value: unknown): value is { type: "content"; value: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const container = value as { type?: unknown; value?: unknown };
  return container.type === "content" && Array.isArray(container.value);
}

/** Immediate children only: the shape the sanitizer and extractor consume. */
function hasImmediateSupportedMedia(container: { value: unknown[] }): boolean {
  return container.value.some((item: unknown) => {
    const media = asMediaPart(item);
    return media?.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType);
  });
}
