import { JSON_SAFE_CLONE_MAX_BIGINT_DIGITS } from "@/constants/json";

// Precomputed so the per-value magnitude gate is a cheap comparison (BigInt
// comparison short-circuits on digit-count mismatch).
const BIGINT_ABS_LIMIT = 10n ** BigInt(JSON_SAFE_CLONE_MAX_BIGINT_DIGITS);

/**
 * Clone a value into the exact shape `JSON.parse(JSON.stringify(value))` would
 * produce: `undefined`/function/symbol array elements become `null`, object
 * properties holding them are dropped, non-finite numbers become `null`, and
 * `toJSON` is honored. A defensive fallback covers values JSON.stringify
 * cannot serialize at all (BigInt, circular references, throwing getters,
 * proxies with throwing traps).
 *
 * Why this exists: tool outputs are persisted as JSON and rehydrated on
 * reload, but the SAME in-memory object is also embedded in the next step's
 * tool-result model message, which the AI SDK validates against a strict
 * JSONValue schema. A non-JSON value that serialization would silently
 * normalize (e.g. `undefined` inside an array) instead fails that validation
 * and kills the live stream with AI_InvalidPromptError, while the retry,
 * rebuilt from rehydrated history, succeeds. Normalizing up front keeps the
 * live and rehydrated shapes identical.
 */
export function jsonSafeClone(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    // JSON.stringify throws on BigInt, cycles, and throwing getters/toJSON.
    return scrubToJsonSafe(value, new WeakSet());
  }
}

/**
 * Best-effort manual walk for values JSON.stringify rejects. Mirrors JSON
 * semantics where possible; unserializable leaves are replaced instead of
 * thrown on (BigInt → decimal string, revisited ancestor → "[Circular]").
 */
function scrubToJsonSafe(value: unknown, ancestors: WeakSet<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      // The sandbox's memory/time caps end at runtime.eval(); a hostile guest
      // can still hand the host a huge BigInt whose decimal expansion is
      // superlinear and would block the event loop. Gate magnitude BEFORE
      // converting.
      if (value >= BIGINT_ABS_LIMIT || value <= -BIGINT_ABS_LIMIT) {
        return `[BigInt: >${JSON_SAFE_CLONE_MAX_BIGINT_DIGITS} digits]`;
      }
      return value.toString();
    case "object":
      break;
    default:
      // undefined, function, symbol: dropped by the caller (object property)
      // or converted to null (array element), matching JSON.stringify.
      return undefined;
  }
  if (value === null) return null;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    // Read toJSON once, guarded: the property itself may be a throwing
    // getter, which must degrade to "no toJSON" instead of throwing here.
    let toJson: unknown;
    try {
      toJson = (value as { toJSON?: unknown }).toJSON;
    } catch {
      toJson = undefined;
    }
    if (typeof toJson === "function") {
      try {
        return scrubToJsonSafe((toJson as (this: unknown) => unknown).call(value), ancestors);
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(value)) {
      // Index loop instead of .map: .map skips holes in sparse arrays, which
      // would survive the clone as `undefined` reads: the exact non-JSON
      // shape this helper exists to eliminate. JSON.stringify emits null for
      // holes; do the same, and for throwing index getters too (array length
      // must be preserved, so dropping is not an option).
      const items: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        let element: unknown;
        try {
          element = value[i];
        } catch {
          element = null;
        }
        items[i] = scrubToJsonSafe(element, ancestors) ?? null;
      }
      return items;
    }
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(value)) {
      let element: unknown;
      try {
        element = (value as Record<string, unknown>)[key];
      } catch {
        continue; // Throwing getter: drop the property, keep the rest.
      }
      const scrubbed = scrubToJsonSafe(element, ancestors);
      if (scrubbed !== undefined) entries.push([key, scrubbed]);
    }
    // fromEntries defines own data properties, so a literal "__proto__" key
    // stays a plain property instead of silently mutating the clone's
    // prototype (and vanishing from the JSON shape).
    return Object.fromEntries(entries);
  } catch {
    // Reflective operations outside the per-property guards can throw for
    // hostile exotic objects (Proxy ownKeys/length traps, revoked proxies).
    // Children handle their own failures via recursion, so this only fires
    // for THIS value being uninspectable: degrade it to a placeholder leaf.
    return "[Unserializable]";
  } finally {
    // Remove on the way out so shared (non-cyclic) references still clone;
    // only genuine ancestor revisits are treated as cycles.
    ancestors.delete(value);
  }
}
