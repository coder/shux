/**
 * Deterministic fuzzing helpers for unit tests.
 *
 * Uses a seeded PRNG (mulberry32) so fuzz tests are reproducible in CI: a
 * failure always reports the seed, and re-running with that seed replays the
 * exact input sequence. Intentionally dependency-free (no fast-check).
 */

export type Rng = () => number;

/** Seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() requires a non-empty array");
  return items[randInt(rng, items.length)];
}

/**
 * Fragments chosen to stress model-string parsing: separators, path traversal,
 * prototype pollution keys, unicode (including lone surrogates), and known
 * provider/gateway prefixes.
 */
const STRING_FRAGMENTS: readonly string[] = [
  "",
  ":",
  "::",
  "/",
  "//",
  ".",
  "..",
  "-",
  " ",
  "\n",
  "\t",
  "\0",
  "a",
  "model",
  "anthropic",
  "openai",
  "google",
  "coder",
  "mux-gateway",
  "openrouter",
  "bedrock",
  "github-copilot",
  "ollama",
  "claude-sonnet-5",
  "gpt-5",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "../../etc/passwd",
  "%3A",
  "\uD800", // lone high surrogate
  "\uDC00", // lone low surrogate
  "😀",
  "日本語",
  "e\u0301", // combining accent
  "\uFEFF", // BOM
];

/** Random string built from parser-hostile fragments. */
export function randomFragmentString(rng: Rng, maxFragments = 8): string {
  const count = randInt(rng, maxFragments + 1);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += pick(rng, STRING_FRAGMENTS);
  }
  return out;
}

/**
 * Random JSON-ish value including hostile non-JSON values: NaN/Infinity,
 * negative and unsafe-huge numbers, BigInt, functions, symbols, Dates, cyclic
 * objects, arrays-as-objects, and objects with throwing getters.
 */
export function randomHostileValue(rng: Rng, depth = 0): unknown {
  const leafChoices: ReadonlyArray<() => unknown> = [
    () => undefined,
    () => null,
    () => true,
    () => false,
    () => 0,
    () => -1,
    () => NaN,
    () => Infinity,
    () => -Infinity,
    () => 0.5,
    () => Number.MAX_SAFE_INTEGER + 1,
    () => 1e21,
    () => randInt(rng, 100000),
    () => -randInt(rng, 100000),
    () => randomFragmentString(rng),
    () => "x".repeat(randInt(rng, 4096)),
    () => BigInt(randInt(rng, 1000)),
    () => Symbol("fuzz"),
    () => () => "fn",
    () => new Date(randInt(rng, 2 ** 31) * 1000),
    () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    },
    () => {
      const hostile = {};
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("hostile getter");
        },
        enumerable: true,
      });
      return hostile;
    },
  ];
  if (depth >= 3) return pick(rng, leafChoices)();

  const branch = rng();
  if (branch < 0.6) return pick(rng, leafChoices)();
  if (branch < 0.8) {
    const len = randInt(rng, 4);
    return Array.from({ length: len }, () => randomHostileValue(rng, depth + 1));
  }
  const obj: Record<string, unknown> = {};
  const keys = randInt(rng, 4);
  for (let i = 0; i < keys; i++) {
    obj[randomFragmentString(rng, 2) || "k"] = randomHostileValue(rng, depth + 1);
  }
  return obj;
}
