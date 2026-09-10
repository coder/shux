/**
 * Tool hook env helpers.
 *
 * Hooks are usually written in shell, so we provide a shell-friendly way to access
 * tool inputs without requiring JSON parsing (`jq`, Python, etc.).
 *
 * This module is shared by:
 * - production code (to populate env vars)
 * - docs generation (to list what env vars exist)
 *
 * That way the docs and runtime cannot drift.
 */

export interface FlattenToolHookEnvOptions {
  /**
   * Maximum length for any single env var value.
   *
   * If a value exceeds this limit, the env var is omitted (we do not truncate).
   * Hooks can use `XUM_TOOL_INPUT_PATH`/`XUM_TOOL_RESULT_PATH` for full JSON.
   */
  maxValueLength?: number;

  /** Maximum number of env vars emitted (best-effort safety limit). */
  maxVars?: number;

  /** Maximum number of array elements emitted (best-effort safety limit). */
  maxArrayLength?: number;
}

const DEFAULT_MAX_VALUE_LENGTH = 8_000;
const DEFAULT_MAX_VARS = 2_000;
const DEFAULT_MAX_ARRAY_LENGTH = 500;

function sanitizeEnvVarKeyPart(part: string, options?: { allowPlaceholders?: boolean }): string {
  const trimmed = part.trim();

  // Avoid collapsing back to the prefix when a path segment is empty/whitespace.
  // (e.g. key " " would otherwise become "", yielding env var name == prefix.)
  if (trimmed.length === 0) {
    return "EMPTY";
  }

  // For docs we sometimes want patterns like <INDEX>. Keep the angle brackets so
  // it reads as a template rather than a literal variable name.
  if (options?.allowPlaceholders && /^<[^>]+>$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  // Shell-friendly: [A-Z0-9_]. We still include underscores from the source key.
  // Also: split camelCase/PascalCase into words (filePath -> FILE_PATH).
  const withWordBreaks = trimmed
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2");

  return withWordBreaks.toUpperCase().replaceAll(/[^A-Z0-9_]/g, "_");
}

export function toolHookEnvVarName(
  prefix: string,
  keyPath: string[],
  options?: { allowPlaceholders?: boolean }
): string {
  const parts = [prefix, ...keyPath].map((part) => sanitizeEnvVarKeyPart(part, options));
  return parts.filter(Boolean).join("_");
}

/**
 * Legacy env var aliases emitted for backward compatibility.
 * When the canonical key is present in the flattened output, the legacy key
 * is also set to the same value so existing hooks keep working.
 */
const LEGACY_ENV_ALIASES: ReadonlyArray<{ canonical: string; legacy: string }> = [
  // file tools renamed `file_path` → `path` (canonical); keep the old env var around.
  { canonical: "_PATH", legacy: "_FILE_PATH" },
];

/**
 * Flatten a tool input/result value into env vars.
 *
 * Example:
 *   flattenToolHookValueToEnv({ path: "a.ts" }, "XUM_TOOL_INPUT")
 *     -> { XUM_TOOL_INPUT_PATH: "a.ts", XUM_TOOL_INPUT_FILE_PATH: "a.ts" }
 */
export function flattenToolHookValueToEnv(
  value: unknown,
  prefix: string,
  options?: FlattenToolHookEnvOptions
): Record<string, string> {
  // Guard: Our hooks already have env vars like XUM_TOOL_INPUT/XUM_TOOL_RESULT.
  // We only want to create prefixed sub-keys.
  if (typeof value !== "object" || value === null) {
    return {};
  }
  if (Array.isArray(value)) {
    return {};
  }

  const maxValueLength = options?.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
  const maxVars = options?.maxVars ?? DEFAULT_MAX_VARS;
  const maxArrayLength = options?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;

  const out: Record<string, string> = {};
  let varCount = 0;

  function trySet(key: string, rawValue: string): void {
    if (varCount >= maxVars) return;

    // We intentionally do not truncate values. If an env var doesn't fit, omit it
    // and let hooks use the JSON file (`XUM_TOOL_INPUT_PATH`/`XUM_TOOL_RESULT_PATH`).
    if (rawValue.length > maxValueLength) return;

    out[key] = rawValue;
    varCount += 1;
  }

  function recurse(current: unknown, keyPath: string[]): void {
    if (varCount >= maxVars) return;
    if (current === null || current === undefined) return;

    if (typeof current === "string") {
      trySet(toolHookEnvVarName(prefix, keyPath), current);
      return;
    }

    if (
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      trySet(toolHookEnvVarName(prefix, keyPath), String(current));
      return;
    }

    if (Array.isArray(current)) {
      const arrayCountKey = toolHookEnvVarName(prefix, [...keyPath, "COUNT"]);
      trySet(arrayCountKey, String(current.length));

      // Emit up to N elements to avoid blowing up env size.
      const lengthToEmit = Math.min(current.length, maxArrayLength);
      for (let i = 0; i < lengthToEmit; i += 1) {
        recurse(current[i], [...keyPath, String(i)]);
      }
      return;
    }

    if (typeof current === "object") {
      for (const [k, v] of Object.entries(current)) {
        recurse(v, [...keyPath, k]);
        if (varCount >= maxVars) return;
      }
    }
  }

  recurse(value, []);

  // Emit legacy env var aliases so existing hooks keep working after field renames.
  for (const { canonical, legacy } of LEGACY_ENV_ALIASES) {
    const canonicalKey = prefix + canonical;
    if (canonicalKey in out) {
      out[prefix + legacy] = out[canonicalKey];
    }
  }

  return out;
}
