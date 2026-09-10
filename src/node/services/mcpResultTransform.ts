import {
  MCP_TOOL_RESULT_MAX_TEXT_BYTES,
  MCP_TOOL_RESULT_MAX_TOTAL_BYTES,
} from "@/common/constants/toolLimits";
import { log } from "@/node/services/log";

/**
 * Maximum size of base64 image data in bytes before we drop it.
 *
 * Rationale: providers already accept multi‑megabyte images, but a single
 * 20–30MB screenshot can still blow up request sizes or hit provider limits
 * (e.g., Anthropic ~32MB total request). We keep a generous per‑image guard to
 * pass normal screenshots while preventing pathological payloads.
 */
export const MAX_IMAGE_DATA_BYTES = 8 * 1024 * 1024; // 8MB guard per image

/**
 * MCP CallToolResult content types (MCP spec wire shapes)
 */
interface MCPTextContent {
  type: "text";
  text: string;
}

interface MCPImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface MCPAudioContent {
  type: "audio";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

type MCPContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

export interface MCPCallToolResult {
  content?: MCPContent[];
  isError?: boolean;
  toolResult?: unknown;
  structuredContent?: unknown;
}

export function isMCPErrorResult(value: unknown): value is MCPCallToolResult & { isError: true } {
  return (
    value != null && typeof value === "object" && (value as { isError?: unknown }).isError === true
  );
}

/**
 * Turn an `isError` result into the message of the thrown tool error. Text and
 * text-resource parts are the message; binary parts are described, not inlined.
 */
export function describeMCPErrorResult(result: MCPCallToolResult): string {
  const content = result.content ?? [];
  // A blank text part explains nothing, so it must not shadow structured details.
  const readableParts = content
    .flatMap((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "resource") {
        return item.resource.text ?? item.resource.uri;
      }
      return [];
    })
    .filter((part) => part.trim().length > 0);
  const binaryParts = content.flatMap((item) => {
    if (item.type === "image") {
      return describeBinaryErrorPart("Image", item.data, item.mimeType);
    }
    if (item.type === "audio") {
      return describeBinaryErrorPart("Audio", item.data, item.mimeType);
    }
    return [];
  });
  // Servers may explain the failure only in structuredContent (spec) or the
  // legacy toolResult and leave `content` empty; an empty array tells the
  // model nothing, so fall through to the whole result instead.
  const description =
    readableParts.length > 0
      ? readableParts.join("\n")
      : binaryParts.length > 0
        ? binaryParts.join("\n")
        : stringifyMCPErrorValue(
            result.structuredContent ?? result.toolResult ?? (content.length > 0 ? content : result)
          );
  // The error message enters history like any tool result text, so it gets the
  // same byte cap as a successful result.
  return truncateUtf8Bytes(
    description,
    MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    "\n[MCP error details truncated]"
  );
}

function stringifyMCPErrorValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "MCP tool call failed";
  } catch {
    return "MCP tool call failed";
  }
}

function describeBinaryErrorPart(kind: string, data: string, mediaType: string): string {
  const dataLength = data.length;
  if (dataLength > MAX_IMAGE_DATA_BYTES) {
    return `[${kind} omitted: ${formatBytesSI(dataLength)} exceeds per-${kind.toLowerCase()} guard of ${formatBytesSI(MAX_IMAGE_DATA_BYTES)}.]`;
  }
  return `[${kind} omitted from MCP error text: ${formatBytesSI(dataLength)}, ${mediaType}.]`;
}

/**
 * AI SDK LanguageModelV2ToolResultOutput content types
 */
type AISDKContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

/**
 * Format byte size as human-readable string (KB or MB).
 * Uses decimal (SI) units (1000-based) — intentionally different from the shared
 * binary-unit formatBytes in @/common/utils/formatBytes which uses 1024-based thresholds.
 */
function formatBytesSI(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

// Enforce byte budgets on UTF-8 bytes; non-ASCII text can use up to three
// bytes per UTF-16 code unit. Backs up to a UTF-8 sequence boundary before
// decoding.
export function truncateUtf8Bytes(text: string, maxBytes: number, marker: string): string {
  // Encoding at most maxBytes UTF-16 code units bounds the temporary buffer
  // while still covering maxBytes UTF-8 bytes.
  const prefix = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  const bytes = Buffer.from(prefix, "utf8");
  if (prefix === text && bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8") + marker;
}

/**
 * Shared text budget threaded through one result so many text parts cannot
 * multiply the cap. Charged in serialized JSON bytes (escape expansion plus
 * per-part wrapper overhead), so neither part count nor escape-heavy content
 * (control characters serialize 6x) can multiply the persisted size.
 */
interface TextBudget {
  remaining: number;
}

// Serialized wrapper cost of one {"type":"text","text":"..."} part plus its
// array comma; kept parts may carry small extra fields, which the total
// serialized backstop still bounds.
const PART_SERIALIZATION_OVERHEAD_BYTES = 32;
// Below this many payload bytes a truncated fragment carries no signal; drop
// the part instead.
const MIN_KEPT_TEXT_BYTES = 16;

function textTruncationNotice(byteLength: number): string {
  return `[MCP tool result text truncated: ${formatBytesSI(byteLength)} exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} cap. Narrow the query to reduce output size.]`;
}

/** Serialized byte length of `text` as a JSON string, minus the outer quotes. */
function escapedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Charge `text` against the budget in serialized bytes. Returns the (possibly
 * truncated) text, or null when the remaining budget is too small to carry a
 * useful fragment and the part should be dropped.
 */
function capText(text: string, budget: TextBudget): { text: string; truncated: boolean } | null {
  const rawBytes = Buffer.byteLength(text, "utf8");
  // JSON escaping only expands (multi-byte characters serialize as-is), so raw
  // bytes lower-bound the serialized cost; only measure exactly when the raw
  // size already fits, keeping stringify off pathologically large inputs.
  if (rawBytes + PART_SERIALIZATION_OVERHEAD_BYTES <= budget.remaining) {
    const cost = escapedTextBytes(text) + PART_SERIALIZATION_OVERHEAD_BYTES;
    if (cost <= budget.remaining) {
      budget.remaining -= cost;
      return { text, truncated: false };
    }
  }
  const allowed = budget.remaining - PART_SERIALIZATION_OVERHEAD_BYTES;
  if (allowed < MIN_KEPT_TEXT_BYTES) {
    return null;
  }
  // Escaped size is monotonic in the kept prefix but not linear, so shrink
  // proportionally until the serialized fragment fits. Raw bytes strictly
  // decrease each pass and one escape-dense pass reduces size by at least the
  // overshoot ratio, so this converges in a few iterations.
  let candidate = truncateUtf8Bytes(text, allowed, "");
  let fits = false;
  for (let i = 0; i < 32; i += 1) {
    const escaped = escapedTextBytes(candidate);
    if (escaped <= allowed) {
      fits = true;
      break;
    }
    const candidateRaw = Buffer.byteLength(candidate, "utf8");
    const shrunk = Math.min(candidateRaw - 1, Math.floor((candidateRaw * allowed) / escaped));
    if (shrunk < MIN_KEPT_TEXT_BYTES) {
      return null;
    }
    candidate = truncateUtf8Bytes(candidate, shrunk, "");
  }
  if (!fits) {
    return null;
  }
  budget.remaining = 0;
  return { text: `${candidate}\n\n${textTruncationNotice(rawBytes)}`, truncated: true };
}

function omittedPartsNotice(count: number): string {
  return `[${count} content part(s) omitted: MCP tool result exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} text cap]`;
}

function omittedValueNotice(kind: string, byteLength: number): string {
  return `[MCP ${kind} omitted: ${formatBytesSI(byteLength)} exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} cap. Narrow the query to reduce output size.]`;
}

function metadataOmittedNotice(byteLength: number): string {
  return `[MCP result metadata omitted: result serialized to ${formatBytesSI(byteLength)}, exceeding the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TOTAL_BYTES)} total cap. Narrow the query to reduce output size.]`;
}

function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    // Unserializable results (circular refs, BigInt) cannot be persisted to
    // chat.jsonl anyway; treat them as oversized so they become a bounded notice.
    return Number.POSITIVE_INFINITY;
  }
}

/** Binary media guard shared by image/audio content and blob resources. */
function toGuardedMediaPart(
  kind: string,
  data: string | undefined,
  mediaType: string
): AISDKContentPart {
  const dataLength = data?.length ?? 0;
  if (dataLength > MAX_IMAGE_DATA_BYTES) {
    log.warn(`[MCP] ${kind} data too large, omitting from context`, {
      mediaType,
      dataLength,
      maxAllowed: MAX_IMAGE_DATA_BYTES,
    });
    return {
      type: "text",
      text: `[${kind} omitted: ${formatBytesSI(dataLength)} exceeds per-${kind.toLowerCase()} guard of ${formatBytesSI(MAX_IMAGE_DATA_BYTES)}. Reduce resolution or quality and retry.]`,
    };
  }
  return { type: "media", data: data ?? "", mediaType };
}

/**
 * Transform MCP tool result to AI SDK format.
 * Converts MCP binary content (image, audio, embedded blob resources) to AI
 * SDK "media" parts — the single conversion layer for MCP media (mixed
 * text+binary results included). Truncates large payloads to prevent context
 * overflow.
 */
export function transformMCPResult(result: unknown): unknown {
  // Primitive string results skip the content-array capping below, so bound
  // them directly. A full budget always yields a non-null capText result.
  if (typeof result === "string") {
    const capped = capText(result, { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES });
    if (!capped?.truncated) {
      return result;
    }
    log.warn("[MCP] string tool result too large, truncating", {
      size: Buffer.byteLength(result, "utf8"),
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return capped.text;
  }

  if (!result || typeof result !== "object") {
    return result;
  }

  const typed = result as MCPCallToolResult;

  // If it has toolResult (non-standard result shape), pass through as-is when
  // it fits the cap; otherwise replace it with a bounded notice.
  if (typed.toolResult !== undefined) {
    const size = jsonByteLength(result);
    if (size <= MCP_TOOL_RESULT_MAX_TEXT_BYTES) {
      return result;
    }
    log.warn("[MCP] toolResult too large, omitting", {
      size,
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return { toolResult: omittedValueNotice("toolResult", size) };
  }

  // If no content array, pass through when it fits the cap; otherwise replace
  // with a bounded notice in MCP text shape so toModelOutput surfaces it.
  if (!typed.content || !Array.isArray(typed.content)) {
    const size = jsonByteLength(result);
    if (size <= MCP_TOOL_RESULT_MAX_TEXT_BYTES) {
      return result;
    }
    log.warn("[MCP] tool result too large, omitting", {
      size,
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return { content: [{ type: "text", text: omittedValueNotice("tool result", size) }] };
  }

  // Only rewrite results carrying binary payloads. Text-only results pass
  // through in MCP shape for the tool's toModelOutput conversion, with
  // oversized text capped in place.
  const hasBinaryContent = typed.content.some(
    (c) =>
      c.type === "image" ||
      c.type === "audio" ||
      (c.type === "resource" && typeof c.resource?.blob === "string")
  );
  if (!hasBinaryContent) {
    return capTextOnlyResult(typed);
  }

  // Debug: log what we received from MCP
  log.debug("[MCP] transformMCPResult input", {
    contentTypes: typed.content.map((c) => c.type),
  });

  // Transform to AI SDK content format
  const budget: TextBudget = { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES };
  let omitted = 0;
  let truncated = false;
  const transformedContent: AISDKContentPart[] = [];
  const pushCappedText = (text: string): void => {
    const capped = capText(text, budget);
    if (capped === null) {
      omitted += 1;
      return;
    }
    truncated ||= capped.truncated;
    transformedContent.push({ type: "text", text: capped.text });
  };
  for (const item of typed.content) {
    if (item.type === "text") {
      pushCappedText(item.text);
    } else if (item.type === "image") {
      // Ensure mediaType is present - default to image/png if missing
      transformedContent.push(toGuardedMediaPart("Image", item.data, item.mimeType || "image/png"));
    } else if (item.type === "audio") {
      transformedContent.push(toGuardedMediaPart("Audio", item.data, item.mimeType || "audio/wav"));
    } else if (item.type === "resource") {
      if (typeof item.resource.blob === "string") {
        transformedContent.push(
          toGuardedMediaPart(
            "Resource",
            item.resource.blob,
            item.resource.mimeType ?? "application/octet-stream"
          )
        );
      } else {
        // Text resources: surface the text (or the URI as a reference).
        pushCappedText(item.resource.text ?? item.resource.uri);
      }
    } else {
      // Fallback: stringify unknown content
      pushCappedText(JSON.stringify(item));
    }
  }
  if (omitted > 0) {
    transformedContent.push({ type: "text", text: omittedPartsNotice(omitted) });
  }
  if (truncated || omitted > 0) {
    log.warn("[MCP] tool result text exceeded cap, truncated", {
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
      omittedParts: omitted,
    });
  }

  return { type: "content", value: transformedContent };
}

/**
 * Cap the text surfaces of a text-only MCP result while preserving its wire
 * shape (content array + isError). Returns the original object when nothing
 * exceeds the cap.
 */
function capTextOnlyResult(typed: MCPCallToolResult): unknown {
  const budget: TextBudget = { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES };
  let changed = false;
  let omitted = 0;
  const cappedContent: MCPContent[] = [];

  for (const item of typed.content ?? []) {
    if (item.type === "text") {
      const capped = capText(item.text, budget);
      if (capped === null) {
        omitted += 1;
        continue;
      }
      changed ||= capped.truncated;
      cappedContent.push(capped.truncated ? { ...item, text: capped.text } : item);
      continue;
    }
    if (item.type === "resource" && typeof item.resource?.text === "string") {
      const capped = capText(item.resource.text, budget);
      if (capped === null) {
        omitted += 1;
        continue;
      }
      changed ||= capped.truncated;
      cappedContent.push(
        capped.truncated ? { ...item, resource: { ...item.resource, text: capped.text } } : item
      );
      continue;
    }
    cappedContent.push(item);
  }

  if (omitted > 0) {
    changed = true;
    cappedContent.push({ type: "text", text: omittedPartsNotice(omitted) });
  }

  // structuredContent duplicates the content text as JSON and is invisible to
  // the model (toModelOutput only reads content), so drop it wholesale when
  // oversized instead of truncating JSON mid-structure.
  const structuredSize =
    typed.structuredContent !== undefined ? jsonByteLength(typed.structuredContent) : 0;
  const dropStructured = structuredSize > MCP_TOOL_RESULT_MAX_TEXT_BYTES;
  if (dropStructured) {
    changed = true;
    cappedContent.push({
      type: "text",
      text: omittedValueNotice("structuredContent", structuredSize),
    });
  }

  if (changed) {
    log.warn("[MCP] tool result text exceeded cap, truncated", {
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
      omittedParts: omitted,
      structuredContentDropped: dropStructured,
    });
  }

  const candidate: MCPCallToolResult = changed ? { ...typed, content: cappedContent } : typed;
  if (changed && dropStructured) {
    delete candidate.structuredContent;
  }

  // The per-surface caps above cannot reach server-controlled metadata
  // (result- and part-level _meta, unknown fields, resource URIs), so a total
  // serialized budget backstops them: anything still oversized is flattened to
  // bounded text parts so no unbounded bytes reach history.
  const totalSize = jsonByteLength(candidate);
  if (totalSize <= MCP_TOOL_RESULT_MAX_TOTAL_BYTES) {
    return candidate;
  }

  log.warn("[MCP] tool result metadata exceeded total cap, flattening", {
    totalSize,
    cap: MCP_TOOL_RESULT_MAX_TOTAL_BYTES,
  });

  const rebuildBudget: TextBudget = { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES };
  let dropped = 0;
  const boundedContent: MCPContent[] = [];
  for (const item of cappedContent) {
    let text: string;
    if (item.type === "text") {
      text = item.text;
    } else {
      try {
        text = JSON.stringify(item);
      } catch {
        text = "[unserializable content part omitted]";
      }
    }
    const capped = capText(text, rebuildBudget);
    if (capped === null) {
      dropped += 1;
      continue;
    }
    boundedContent.push({ type: "text", text: capped.text });
  }
  if (dropped > 0) {
    boundedContent.push({ type: "text", text: omittedPartsNotice(dropped) });
  }
  boundedContent.push({ type: "text", text: metadataOmittedNotice(totalSize) });

  const rebuilt: MCPCallToolResult = {
    // Strictly-true check: hostile servers can put unbounded junk in isError.
    ...(typed.isError === true ? { isError: true } : {}),
    content: boundedContent,
    // Kept structuredContent is already bounded by its own serialized cap above.
    ...(typed.structuredContent !== undefined && !dropStructured
      ? { structuredContent: typed.structuredContent }
      : {}),
  };

  // Remeasure the rebuilt output. Unreachable while every component above is
  // budgeted in serialized bytes, but a bounded collapse beats trusting that
  // invariant with history durability at stake.
  const rebuiltSize = jsonByteLength(rebuilt);
  if (rebuiltSize > MCP_TOOL_RESULT_MAX_TOTAL_BYTES) {
    log.error("[MCP] rebuilt tool result still exceeds total cap, collapsing", {
      rebuiltSize,
      cap: MCP_TOOL_RESULT_MAX_TOTAL_BYTES,
    });
    return {
      ...(typed.isError === true ? { isError: true } : {}),
      content: [{ type: "text", text: metadataOmittedNotice(totalSize) }],
    };
  }
  return rebuilt;
}
