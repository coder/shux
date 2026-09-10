import assert from "@/common/utils/assert";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";

const DEFAULT_MAX_SAFE_STRING_CHARS = 12_000;
const DEFAULT_MAX_ERROR_MESSAGE_CHARS = 2_000;
const DEFAULT_PROVIDER_PREVIEW_CHARS = 64;
const DEFAULT_ERROR_PREVIEW_CHARS = 240;
const MAX_RECURSION_DEPTH = 8;

interface TextSafetyStats {
  length: number;
  nulCount: number;
  controlCount: number;
  replacementCount: number;
}

interface SanitizeStringOptions {
  maxChars?: number;
  reason?: "provider-output" | "error-message";
}

// eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsafeText(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      code === 0xfffd
    ) {
      return true;
    }
  }
  return false;
}

function isSupportedMediaPart(value: Record<string, unknown>): boolean {
  return (
    value.type === "media" &&
    typeof value.data === "string" &&
    typeof value.mediaType === "string" &&
    isSupportedAttachmentMediaType(value.mediaType)
  );
}

function getTextSafetyStats(value: string): TextSafetyStats {
  let nulCount = 0;
  let controlCount = 0;
  let replacementCount = 0;

  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0) {
      nulCount += 1;
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controlCount += 1;
    }
    if (code === 0xfffd) {
      replacementCount += 1;
    }
  }

  return {
    length: value.length,
    nulCount,
    controlCount,
    replacementCount,
  };
}

function isBinaryLikeText(value: string, stats: TextSafetyStats): boolean {
  if (stats.nulCount > 0 || stats.replacementCount > 0) {
    return true;
  }

  if (value.length === 0) {
    return false;
  }

  return stats.controlCount / value.length > 0.02;
}

function escapePreview(value: string, maxChars: number): string {
  assert(Number.isInteger(maxChars) && maxChars > 0, "preview maxChars must be positive");

  let escaped = "";
  for (const char of value) {
    if (escaped.length >= maxChars) {
      break;
    }
    const code = char.codePointAt(0)!;
    if (char === "\n") {
      escaped += "\\n";
    } else if (char === "\r") {
      escaped += "\\r";
    } else if (char === "\t") {
      escaped += "\\t";
    } else if (code >= 32 && code !== 127 && code !== 0xfffd) {
      escaped += char;
    } else {
      escaped += `\\u{${code.toString(16)}}`;
    }
  }
  return escaped;
}

/** Bound and redact provider-visible strings so binary response bodies cannot poison history. */
export function sanitizeStringForProviderOutput(
  value: string,
  options: SanitizeStringOptions = {}
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_SAFE_STRING_CHARS;
  assert(Number.isInteger(maxChars) && maxChars > 0, "sanitize maxChars must be positive");

  if (value.length <= maxChars && !hasUnsafeText(value)) {
    return value;
  }

  const stats = getTextSafetyStats(value);
  const binaryLike = isBinaryLikeText(value, stats);
  if (!binaryLike && value.length <= maxChars) {
    return value;
  }

  const reason = options.reason ?? "provider-output";
  const previewChars =
    reason === "error-message" ? DEFAULT_ERROR_PREVIEW_CHARS : DEFAULT_PROVIDER_PREVIEW_CHARS;
  const preview = escapePreview(value, previewChars);
  const counts = `length=${stats.length}, nul=${stats.nulCount}, control=${stats.controlCount}, replacement=${stats.replacementCount}`;

  if (binaryLike) {
    return `[redacted binary-like ${reason}; ${counts}; preview="${preview}"]`;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${reason}; ${counts}]`;
}

export function sanitizeErrorMessageForDisplay(message: string): string {
  return sanitizeStringForProviderOutput(message, {
    maxChars: DEFAULT_MAX_ERROR_MESSAGE_CHARS,
    reason: "error-message",
  });
}

export function sanitizeUnknownForProviderOutput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return sanitizeStringForProviderOutput(value);
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_RECURSION_DEPTH) {
    return "[redacted deeply nested provider output]";
  }

  if (Array.isArray(value)) {
    const arrayValue = value as readonly unknown[];
    let sanitizedItems: unknown[] | undefined;
    for (let index = 0; index < arrayValue.length; index += 1) {
      const item = arrayValue[index];
      const sanitizedItem = sanitizeUnknownForProviderOutput(item, depth + 1);
      if (sanitizedItems) {
        sanitizedItems[index] = sanitizedItem;
      } else if (sanitizedItem !== item) {
        sanitizedItems = arrayValue.slice(0, index);
        sanitizedItems[index] = sanitizedItem;
      }
    }
    return sanitizedItems ?? value;
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  if (isSupportedMediaPart(value)) {
    return value;
  }

  let sanitizedRecord: Record<string, unknown> | undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    const sanitizedValue = sanitizeUnknownForProviderOutput(nestedValue, depth + 1);
    if (sanitizedRecord) {
      sanitizedRecord[key] = sanitizedValue;
    } else if (sanitizedValue !== nestedValue) {
      sanitizedRecord = { ...value };
      sanitizedRecord[key] = sanitizedValue;
    }
  }
  return sanitizedRecord ?? value;
}
