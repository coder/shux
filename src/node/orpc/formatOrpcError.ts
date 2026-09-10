import { ORPCError, ValidationError } from "@orpc/server";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { inspect } from "node:util";
import { DYNAMIC_WORKFLOWS_DISABLED_ERROR_MESSAGE } from "@/node/services/workflows/WorkflowService";
import { WorkflowArgsValidationError } from "@/node/services/workflows/workflowArgs";
import { WorkflowDeclaredPhasesValidationError } from "@/node/services/workflows/workflowMetadata";

export interface FormattedOrpcError {
  /**
   * Human-readable error message suitable for console output.
   *
   * Keep this as a string so we don't lose nested details to Node's `[Object]` / `[Array]` printing.
   */
  message: string;
  /**
   * JSON-serializable debug payload for log.debug_obj().
   *
   * This is intentionally best-effort and must never throw.
   */
  debugDump: Record<string, unknown>;
}

interface RequestContext {
  method?: string;
  /** Full URL string (if available). */
  url?: string;
  /** URL pathname + search (if available). */
  path?: string;
  prefix?: string;
  headers?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function redactHeaders(headers: unknown): Record<string, unknown> | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") {
      result[key] = "<redacted>";
      continue;
    }

    result[key] = value;
  }

  return result;
}

function extractRequestContext(interceptorOptions: unknown): RequestContext {
  if (!isRecord(interceptorOptions)) {
    return {};
  }

  const prefix =
    typeof interceptorOptions.prefix === "string" ? interceptorOptions.prefix : undefined;
  const request = isRecord(interceptorOptions.request) ? interceptorOptions.request : undefined;

  const method = request && typeof request.method === "string" ? request.method : undefined;

  const urlRaw = request ? request.url : undefined;
  const url =
    urlRaw instanceof URL ? urlRaw.toString() : typeof urlRaw === "string" ? urlRaw : undefined;

  const path = urlRaw instanceof URL ? `${urlRaw.pathname}${urlRaw.search}` : undefined;

  const headers = request ? redactHeaders(request.headers) : undefined;

  return {
    method,
    url,
    path,
    prefix,
    headers,
  };
}

interface JsonSafeOptions {
  depth: number;
  seen: WeakSet<object>;
}

function toJsonSafe(value: unknown, options: JsonSafeOptions): unknown {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function${value.name ? ` ${value.name}` : ""}]`;
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause:
        options.depth > 0
          ? toJsonSafe(value.cause, { ...options, depth: options.depth - 1 })
          : undefined,
    };
  }

  if (Array.isArray(value)) {
    if (options.depth <= 0) {
      return `Array(${value.length})`;
    }

    return value
      .slice(0, 100)
      .map((entry) => toJsonSafe(entry, { ...options, depth: options.depth - 1 }));
  }

  if (isPlainObject(value)) {
    if (options.seen.has(value)) {
      return "[Circular]";
    }

    if (options.depth <= 0) {
      return `Object(${Object.keys(value).length})`;
    }

    options.seen.add(value);

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);

    for (const [key, entry] of entries.slice(0, 200)) {
      out[key] = toJsonSafe(entry, { ...options, depth: options.depth - 1 });
    }

    if (entries.length > 200) {
      out.__truncated__ = `+${entries.length - 200} keys`;
    }

    return out;
  }

  return value;
}

function summarizeForLogs(value: unknown, depth = 1): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    const trimmed = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    return JSON.stringify(trimmed);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);

    if (depth <= 0) {
      return `Object(${keys.length})`;
    }

    const preview = keys.slice(0, 10).map((key) => {
      const entry = value[key];
      return `${key}: ${summarizeForLogs(entry, depth - 1)}`;
    });

    const suffix = keys.length > 10 ? ", …" : "";
    return `{ ${preview.join(", ")}${suffix} }`;
  }

  // Fallback for non-plain objects.
  return inspect(value, { depth: 3, maxArrayLength: 50, breakLength: 120 });
}

function isIssue(value: unknown): value is StandardSchemaV1.Issue {
  return isRecord(value) && typeof value.message === "string";
}

function formatIssuePath(path: StandardSchemaV1.Issue["path"]): string {
  if (!path || path.length === 0) {
    return "<root>";
  }

  const parts: string[] = [];

  for (const segment of path) {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment
        ? (segment as { key: PropertyKey }).key
        : segment;

    if (typeof key === "number") {
      parts.push(`[${key}]`);
      continue;
    }

    if (typeof key === "string") {
      const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
      if (parts.length === 0) {
        parts.push(isIdentifier ? key : `[${JSON.stringify(key)}]`);
      } else {
        parts.push(isIdentifier ? `.${key}` : `[${JSON.stringify(key)}]`);
      }
      continue;
    }

    const rendered = typeof key === "symbol" ? key.toString() : String(key);
    parts.push(parts.length === 0 ? `[${rendered}]` : `[${rendered}]`);
  }

  return parts.join("");
}

function getValidationErrorInfo(
  cause: unknown
): { message?: string; issues: readonly StandardSchemaV1.Issue[]; data: unknown } | null {
  if (cause instanceof ValidationError) {
    return {
      message: cause.message,
      issues: cause.issues,
      // oRPC >=1.14 renamed `ValidationError.data` to `invalidData`.
      data: cause.invalidData,
    };
  }

  if (!isRecord(cause) || !isUnknownArray(cause.issues)) {
    return null;
  }

  const issues = cause.issues.filter(isIssue);

  return {
    message: typeof cause.message === "string" ? cause.message : undefined,
    issues,
    data: "data" in cause ? cause.data : undefined,
  };
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  return inspect(value, { depth: 5, maxArrayLength: 50, breakLength: 120 });
}

export function formatOrpcError(error: unknown, interceptorOptions?: unknown): FormattedOrpcError {
  try {
    const requestContext = extractRequestContext(interceptorOptions);
    const where =
      requestContext.method && requestContext.path
        ? `${requestContext.method} ${requestContext.path}`
        : (requestContext.path ?? requestContext.url);

    const whereSuffix = where ? ` ${where}` : "";

    const debugDump: Record<string, unknown> = {
      request: requestContext,
    };

    if (error instanceof ORPCError) {
      const code = typeof error.code === "string" ? error.code : String(error.code);
      // oRPC >=1.14 removed `ORPCError.status`; derive the HTTP status from the
      // shared code→status table (custom codes have no fixed status).
      const statusFromCode = (COMMON_ERROR_STATUS_MAP as Record<string, number>)[code];
      const status = typeof statusFromCode === "number" ? statusFromCode : undefined;

      debugDump.error = {
        type: "ORPCError",
        code,
        status,
        message: error.message,
        data: toJsonSafe(error.data, { depth: 6, seen: new WeakSet() }),
        stack: error.stack,
      };

      const validation = getValidationErrorInfo(error.cause);
      if (validation) {
        debugDump.cause = {
          type: "ValidationError",
          message: validation.message,
          issues: toJsonSafe(validation.issues, { depth: 6, seen: new WeakSet() }),
          data: toJsonSafe(validation.data, { depth: 6, seen: new WeakSet() }),
        };

        const lines: string[] = [];
        lines.push(
          `ORPC${whereSuffix}: ${code} ${error.message}${
            status !== undefined ? ` (status ${status})` : ""
          }`
        );

        if (validation.issues.length > 0) {
          const maxIssues = 5;
          lines.push(`Validation issues (${validation.issues.length}):`);

          for (const issue of validation.issues.slice(0, maxIssues)) {
            const path = formatIssuePath(issue.path);
            lines.push(`  - ${path}: ${issue.message}`);
          }

          if (validation.issues.length > maxIssues) {
            lines.push(`  (+${validation.issues.length - maxIssues} more)`);
          }
        }

        lines.push(`Data: ${summarizeForLogs(validation.data, 1)}`);

        return {
          message: lines.join("\n"),
          debugDump,
        };
      }

      // Non-validation ORPC error.
      debugDump.cause = toJsonSafe(error.cause, { depth: 6, seen: new WeakSet() });

      return {
        message: `ORPC${whereSuffix}: ${code} ${error.message}${
          status !== undefined ? ` (status ${status})` : ""
        }`,
        debugDump,
      };
    }

    // Unknown error shape.
    debugDump.error = toJsonSafe(error, { depth: 6, seen: new WeakSet() });

    return {
      message: `ORPC${whereSuffix}: ${formatUnknown(error)}`,
      debugDump,
    };
  } catch (formatError) {
    // Best-effort: formatting should never crash the server.
    const fallback = `ORPC: Failed to format error: ${formatUnknown(formatError)}\nOriginal error: ${formatUnknown(error)}`;

    return {
      message: fallback,
      debugDump: {
        formatError: toJsonSafe(formatError, { depth: 4, seen: new WeakSet() }),
        originalError: toJsonSafe(error, { depth: 4, seen: new WeakSet() }),
      },
    };
  }
}

export function throwWorkflowOrpcError(error: unknown): never {
  if (
    error instanceof WorkflowArgsValidationError ||
    error instanceof WorkflowDeclaredPhasesValidationError ||
    (error instanceof Error && error.message === DYNAMIC_WORKFLOWS_DISABLED_ERROR_MESSAGE)
  ) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}
