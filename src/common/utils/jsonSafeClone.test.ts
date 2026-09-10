import { describe, it, expect } from "bun:test";
import { jsonSafeClone } from "./jsonSafeClone";

describe("jsonSafeClone", () => {
  it("passes JSON-safe values through structurally unchanged", () => {
    const value = { a: 1, b: "x", c: [true, null, { d: 2 }] };
    expect(jsonSafeClone(value)).toEqual(value);
  });

  it("normalizes undefined like JSON serialization does", () => {
    expect(jsonSafeClone({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(jsonSafeClone([undefined, 1, undefined])).toEqual([null, 1, null]);
    expect(jsonSafeClone(undefined)).toBeUndefined();
  });

  it("normalizes functions and non-finite numbers like JSON serialization does", () => {
    expect(jsonSafeClone({ fn: () => 1, n: NaN, i: Infinity, ok: 2 })).toEqual({
      n: null,
      i: null,
      ok: 2,
    });
    expect(jsonSafeClone([() => 1])).toEqual([null]);
  });

  it("honors toJSON", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(jsonSafeClone({ date })).toEqual({ date: "2026-01-02T03:04:05.000Z" });
  });

  it("converts BigInt to a decimal string instead of throwing", () => {
    expect(jsonSafeClone({ big: 123n, keep: [1n] })).toEqual({ big: "123", keep: ["1"] });
  });

  it("replaces oversized BigInts with a placeholder instead of expanding them", () => {
    const huge = 10n ** 4096n;
    expect(jsonSafeClone({ huge })).toEqual({ huge: "[BigInt: >4096 digits]" });
    expect(jsonSafeClone({ huge: -huge })).toEqual({ huge: "[BigInt: >4096 digits]" });
    // Values inside the bound still convert exactly.
    const large = 10n ** 4095n;
    expect(jsonSafeClone({ large })).toEqual({ large: large.toString() });
  });

  it("replaces circular references instead of throwing", () => {
    const cyclic: { self?: unknown; ok: number } = { ok: 1 };
    cyclic.self = cyclic;
    expect(jsonSafeClone(cyclic)).toEqual({ ok: 1, self: "[Circular]" });
  });

  it("preserves shared non-cyclic references in the fallback path", () => {
    const shared = { v: 1 };
    // BigInt forces the manual scrub; the DAG must not be treated as a cycle.
    const value = { a: shared, b: shared, big: 1n };
    expect(jsonSafeClone(value)).toEqual({ a: { v: 1 }, b: { v: 1 }, big: "1" });
  });

  it("drops properties whose getters throw, keeping the rest", () => {
    const value: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(value, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(jsonSafeClone(value)).toEqual({ ok: 1 });
  });

  it("produces output that is stable under a JSON round-trip", () => {
    const messy = {
      arr: [undefined, NaN, { nested: undefined, big: 7n }],
      fn: () => 1,
    };
    const cloned = jsonSafeClone(messy);
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(cloned);
  });

  it("fills sparse array holes with null in the fallback path", () => {
    // BigInt forces the manual scrub; holes must become null (as JSON.stringify
    // emits), not survive as undefined reads that fail strict JSONValue checks.
    const value = { sparse: new Array(2) as unknown[], big: 1n };
    const cloned = jsonSafeClone(value) as { sparse: unknown[]; big: string };
    expect(cloned.sparse).toEqual([null, null]);
    expect(Object.hasOwn(cloned.sparse, 0)).toBe(true);
    expect(Object.hasOwn(cloned.sparse, 1)).toBe(true);
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(cloned);
  });

  it("treats a throwing toJSON getter as absent instead of throwing", () => {
    const value = {
      keep: "x",
      get toJSON(): unknown {
        throw new Error("toJSON getter boom");
      },
    };
    expect(jsonSafeClone(value)).toEqual({ keep: "x" });
  });

  it("degrades objects with throwing reflective traps to a placeholder", () => {
    const throwingOwnKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      }
    );
    expect(jsonSafeClone({ keep: 1, evil: throwingOwnKeys })).toEqual({
      keep: 1,
      evil: "[Unserializable]",
    });

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(jsonSafeClone({ p: proxy, big: 1n })).toEqual({ p: "[Unserializable]", big: "1" });
  });

  it("keeps a literal __proto__ key as an own property in the fallback path", () => {
    const nested = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    const value = { big: 1n, nested };
    const cloned = jsonSafeClone(value) as { big: string; nested: Record<string, unknown> };
    expect(Object.hasOwn(cloned.nested, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(cloned.nested)).toBe(Object.prototype);
    expect(JSON.stringify(cloned.nested)).toBe('{"__proto__":{"x":1}}');
  });
});
