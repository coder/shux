import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";
import { DisposableTempDir } from "@/node/services/tempDir";
import { findBundledTypeScriptLibDir, validateTypes } from "./typeValidator";
import { generateXumTypes } from "./typeGenerator";

/**
 * Create a mock tool with the given schema.
 */
function createMockTool(schema: z.ZodType): Tool {
  return {
    description: "Mock tool",
    inputSchema: schema,
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("validateTypes", () => {
  let xumTypes: string;

  // Generate types once for all tests
  beforeAll(async () => {
    const tools = {
      file_read: createMockTool(
        z.object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
      ),
      bash: createMockTool(
        z.object({
          script: z.string(),
          timeout_secs: z.number(),
          run_in_background: z.boolean(),
          display_name: z.string(),
        })
      ),
    };
    xumTypes = await generateXumTypes(tools);
  });

  test("accepts guest code branching on load's hookResult annotation (r58)", async () => {
    // xum.load returns hookResult when a repo tool hook or plugin middleware
    // annotated the read. Kernel programs are TypeScript-analyzed before
    // execution, so an undeclared runtime property would make the annotation
    // unreachable to guest code even though the value supports it.
    const kernelTypes = await generateXumTypes({}, { kernel: true, load: true });
    const result = validateTypes(
      `
      const loaded = xum.load({ path: "a.txt", key: "a" });
      if (loaded.hookResult !== undefined) {
        console.log(loaded.hookResult);
      }
      return loaded.bytes;
    `,
      kernelTypes
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("finds bundled TypeScript libs from Docker server bundle layout", async () => {
    using tmp = new DisposableTempDir("type-validator");
    const runtimeDir = path.join(tmp.path, "dist", "runtime");
    const libDir = path.join(tmp.path, "dist", "typescript-lib");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, "lib.es2023.d.ts.txt"), "");

    expect(findBundledTypeScriptLibDir(runtimeDir)).toBe(libDir);
  });

  test.each(["xum", "mux"] as const)(
    "accepts valid code with correct property names via %s",
    (ns) => {
      const result = validateTypes(
        `
      const content = ${ns}.file_read({ filePath: "test.txt" });
      return content.success;
    `,
        xumTypes
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  );

  test("accepts code using optional properties", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: "test.txt", offset: 10, limit: 50 });
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches wrong property name", () => {
    const result = validateTypes(
      `
      mux.file_read({ path: "test.txt" });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    // Error should mention 'path' doesn't exist or 'filePath' is missing
    expect(
      result.errors.some((e) => e.message.includes("path") || e.message.includes("filePath"))
    ).toBe(true);
  });

  test("catches missing required property", () => {
    const result = validateTypes(
      `
      mux.bash({ script: "ls" });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    // Should error on missing required props
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("catches wrong type for property", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: 123 });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("number") || e.message.includes("string"))
    ).toBe(true);
  });

  test("catches calling non-existent tool", () => {
    const result = validateTypes(
      `
      mux.nonexistent_tool({ foo: "bar" });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("nonexistent_tool"))).toBe(true);
  });

  test("returns line numbers for type errors", () => {
    const result = validateTypes(
      `const x = 1;
const y = 2;
mux.file_read({ path: "test.txt" });`,
      xumTypes
    );
    expect(result.valid).toBe(false);
    // Error should be on line 3 (the mux.file_read call)
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(3);
  });

  test("returns line 1 for error on first line", () => {
    const result = validateTypes(`mux.file_read({ path: "test.txt" });`, xumTypes);
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(1);
  });

  test("returns correct line for error on last line of multi-line code", () => {
    const result = validateTypes(
      `const a = 1;
const b = 2;
const c = 3;
const d = 4;
mux.file_read({ path: "wrong" });`,
      xumTypes
    );
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(5);
  });

  test("returns column number for type errors", () => {
    // Column should point to the problematic property
    const result = validateTypes(`mux.file_read({ path: "test.txt" });`, xumTypes);
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.column !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.column).toBeGreaterThan(0);
  });

  test("allows dynamic property access (no strict checking on unknown keys)", () => {
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      const key = "content";
      console.log(result[key]);
    `,
      xumTypes
    );
    // This should pass - we don't enforce strict property checking on results
    expect(result.valid).toBe(true);
  });

  test("allows console.log/warn/error", () => {
    const result = validateTypes(
      `
      console.log("hello");
      console.warn("warning");
      console.error("error");
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows dynamic properties on empty object literals", () => {
    // Claude frequently uses this pattern to collate parallel reads
    const result = validateTypes(
      `
      const results = {};
      results.file1 = mux.file_read({ filePath: "a.txt" });
      results.file2 = mux.file_read({ filePath: "b.txt" });
      return results;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test.each(["xum", "mux"] as const)("still catches %s tool typos", (ns) => {
    // Must not filter errors for typos on the scripting namespace
    const result = validateTypes(
      `
      ${ns}.file_reade({ filePath: "test.txt" });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("file_reade"))).toBe(true);
  });

  test("catches reads from empty object literals (typos)", () => {
    // Reads from {} should still error - only writes are allowed
    const result = validateTypes(
      `
      const results = {};
      results.file1 = mux.file_read({ filePath: "a.txt" });
      return results.filee1;  // typo: should be file1
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("filee1"))).toBe(true);
  });

  test("catches empty object properties used in tool args", () => {
    // Using unset properties from {} in tool calls should error
    const result = validateTypes(
      `
      const config = {};
      mux.file_read({ filePath: config.path });  // config.path doesn't exist
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("path"))).toBe(true);
  });

  test("catches empty object reads in expressions", () => {
    // Reading from {} in any expression context should error
    const result = validateTypes(
      `
      const obj = {};
      const x = obj.value + 1;  // obj.value doesn't exist
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("value"))).toBe(true);
  });

  test("catches empty object reads in conditionals", () => {
    const result = validateTypes(
      `
      const obj = {};
      if (obj.flag) { console.log("yes"); }  // obj.flag doesn't exist
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("flag"))).toBe(true);
  });

  test("allows multiple writes to empty object", () => {
    const result = validateTypes(
      `
      const data = {};
      data.a = 1;
      data.b = 2;
      data.c = mux.file_read({ filePath: "test.txt" });
      data.d = "string";
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches compound assignment on empty object (+=)", () => {
    // Compound assignments read then write, so should error
    const result = validateTypes(
      `
      const obj = {};
      obj.count += 1;  // reads obj.count first
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("count"))).toBe(true);
  });

  test("allows reads from {} after bracket writes", () => {
    // The exact pattern that triggered this fix: bracket writes then dot reads
    const result = validateTypes(
      `
      const results = {};
      const files = [{ label: "a" }, { label: "b" }];
      for (const f of files) { results[f.label] = mux.file_read({ filePath: f.label }); }
      return results.a.success;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows multiple dot reads from {} bag after bracket writes", () => {
    // The full pattern: bracket writes then multiple dot reads with chained access
    const result = validateTypes(
      `
      const results = {};
      const files = [{ path: "a.go", label: "conn" }, { path: "b.go", label: "sdk" }];
      for (const f of files) { results[f.label] = mux.file_read({ filePath: f.path }); }
      return results.conn.success ? results.conn.content : results.sdk.error;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches bag reads in bracket-write RHS before assignment applies", () => {
    const result = validateTypes(
      `
      const r = {};
      r["a"] = r.typo;
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });

  test("catches bag reads in bracket-write index expression before assignment applies", () => {
    const result = validateTypes(
      `
      const r = {};
      r[r.typo] = 1;
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });
  test("does not suppress bag reads in nested function due to outer writes", () => {
    const result = validateTypes(
      `
      const r = {};
      r["a"] = 1;
      function f() { return r.typo; }
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });

  test("allows bag reads inside nested function after in-scope bracket write", () => {
    const result = validateTypes(
      `
      const r = {};
      function f() {
        r["a"] = 1;
        return r.a;
      }
      return f();
    `,
      xumTypes
    );

    expect(result.valid).toBe(true);
  });
  test("catches bag reads before first bracket write", () => {
    const result = validateTypes(
      `
      const r = {};
      return r.typo;
      r["a"] = 1;
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });

  test("catches bag reads when only nested function writes exist", () => {
    const result = validateTypes(
      `
      const r = {};
      function fill() { r["a"] = 1; }
      return r.typo;
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });
  test("does not suppress TS2339 for shadowed bag name in inner scope", () => {
    const result = validateTypes(
      `
      const results = {};
      results["a"] = 1;
      {
        const results = {};
        return results.typo;
      }
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });

  test("does not treat let {} + bracket writes as a dynamic bag (reassignment hazard)", () => {
    const result = validateTypes(
      `
      let results = {};
      results["a"] = 1;
      results = { ok: true };
      return results.typo;
    `,
      xumTypes
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typo"))).toBe(true);
  });

  test.each(["xum", "mux"] as const)("still catches %s shadowing with {}", (ns) => {
    // const ns = {} must NOT be treated as a dynamic bag — shadowing the scripting namespace is a real bug
    const result = validateTypes(
      `
      const ${ns} = {};
      ${ns}.file_read({ filePath: "test.txt" });
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("file_read"))).toBe(true);
  });

  test("catches reads on {} without bracket writes (not a dynamic bag)", () => {
    // Only dot-notation writes — no bracket writes — should NOT suppress reads
    const result = validateTypes(
      `
      const data = {};
      data.x = 1;
      return data.y;
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("y"))).toBe(true);
  });

  test("catches compound assignment on {} bag (+=)", () => {
    // Even on a dynamic bag variable, compound assignment reads first — should error
    const result = validateTypes(
      `
      const results = {};
      results["key"] = 1;
      results.count += 1;
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("count"))).toBe(true);
  });

  test("accepts ES2021+ features (replaceAll, at, etc.)", () => {
    const result = validateTypes(
      `
      const str = "a-b-c".replaceAll("-", "_");
      const arr = [1, 2, 3];
      const last = arr.at(-1);
      const hasA = Object.hasOwn({ a: 1 }, "a");
      return { str, last, hasA };
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows discriminated union narrowing with negation (!result.success)", () => {
    // This is the idiomatic pattern for handling Result types
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      if (!result.success) {
        console.log(result.error);  // Should be allowed after narrowing
        return { error: result.error };
      }
      return { content: result.content };
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows discriminated union narrowing with === false", () => {
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      if (result.success === false) {
        console.log(result.error);
        return null;
      }
      return result.content;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches syntax error gracefully", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: "test.txt" // missing closing brace
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Empty array push/unshift patterns (regression tests for never[] fix)
  // ==========================================================================

  test("allows empty array with push pattern", () => {
    // Claude frequently collects results in an empty array
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array with unshift pattern", () => {
    const result = validateTypes(
      `
      const results = [];
      results.unshift(mux.file_read({ filePath: "a.txt" }));
      return results;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array with push inside loop", () => {
    const result = validateTypes(
      `
      const files = ["a.txt", "b.txt"];
      const results = [];
      for (const f of files) {
        results.push(mux.file_read({ filePath: f }));
      }
      return results;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows push with primitive values", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push(1);
      arr.push("hello");
      arr.push({ foo: "bar" });
      return arr;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Patterns that must continue to work (regression tests)
  // ==========================================================================

  test("allows untyped function parameters", () => {
    const result = validateTypes(
      `
      function process(x) { return x.success; }
      const r = mux.file_read({ filePath: "test.txt" });
      return process(r);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows untyped arrow function parameters", () => {
    const result = validateTypes(
      `
      const process = (x) => x.success;
      const r = mux.file_read({ filePath: "test.txt" });
      return process(r);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows destructuring parameters", () => {
    // Test that untyped destructuring params work (no TS7031 error)
    const result = validateTypes(
      `
      function processArgs({ a, b }) { return a + b; }
      return processArgs({ a: 1, b: 2 });
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows rest parameters", () => {
    const result = validateTypes(
      `
      function all(...args) { return args.length; }
      return all(1, 2, 3);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows callbacks on typed arrays", () => {
    const result = validateTypes(
      `
      const nums = [1, 2, 3];
      const doubled = nums.map(x => x * 2);
      const evens = nums.filter(x => x % 2 === 0);
      nums.forEach(x => console.log(x));
      return { doubled, evens };
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Empty array operations beyond push/unshift (preprocessing tests)
  // These patterns require the preprocessing approach ([] → [] as any[])
  // ==========================================================================

  test("allows map on empty array that gets populated", () => {
    // Preprocessing transforms [] to [] as any[], so operations work
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results.map(r => r.success);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows filter on empty array", () => {
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results.filter(r => r.success);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows forEach on empty array", () => {
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.forEach(r => console.log(r.success));
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows spread of empty array", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push(1);
      const copy = [...arr];
      return copy;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows index access on empty array", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push("hello");
      return arr[0];
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array in object property", () => {
    const result = validateTypes(
      `
      const obj = { items: [] };
      obj.items.push(1);
      return obj;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array as function argument", () => {
    const result = validateTypes(
      `
      function process(arr) { return arr.length; }
      return process([]);
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array in return statement", () => {
    const result = validateTypes(
      `
      function empty() { return []; }
      return empty();
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Empty array literal access patterns (parenthesized assertions)
  // ==========================================================================

  test("handles member access on empty array literal", () => {
    const result = validateTypes(
      `
      const mapped = [].map((x) => x);
      return mapped;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles index access on empty array literal", () => {
    const result = validateTypes(
      `
      const first = [][0];
      return first;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles optional chaining on empty array literal", () => {
    const result = validateTypes(
      `
      const length = []?.length;
      return length;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles property access on empty array literal", () => {
    const result = validateTypes(
      `
      const length = [].length;
      return length;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Multiple arrays and nesting
  // ==========================================================================

  test("handles multiple empty arrays in same statement", () => {
    const result = validateTypes(
      `
      const a = [], b = [];
      a.push(1);
      b.push("hello");
      return { a, b };
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles nested empty arrays", () => {
    const result = validateTypes(
      `
      const matrix = [];
      matrix.push([]);
      matrix[0].push(1);
      return matrix;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Logical expressions with empty arrays
  // ==========================================================================

  test("still fixes empty arrays in logical OR expressions", () => {
    const result = validateTypes(
      `
      const condition = Math.random() > 0.5;
      const maybe = condition ? [] : null;
      const nums = maybe || [1];
      nums.push(2);
      return nums;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves typeof on empty arrays", () => {
    const result = validateTypes(
      `
      const t = typeof [];
      return t.toUpperCase();
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves unary numeric operators on empty arrays", () => {
    const result = validateTypes(
      `
      const value = +[];
      return value;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves void on empty arrays", () => {
    const result = validateTypes(
      `
      const value = void [];
      return value;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("still fixes empty arrays in nullish coalescing expressions", () => {
    const result = validateTypes(
      `
      const condition = Math.random() > 0.5;
      const maybe = condition ? [] : undefined;
      const nums = maybe ?? [1];
      nums.push(2);
      return nums;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Destructuring patterns (valid JS that must not break)
  // ==========================================================================

  test("handles empty array destructuring in for-of LHS", () => {
    // for-of allows destructuring patterns directly in the loop header.
    const result = validateTypes(
      `
      const items = [[1], [2]];
      let count = 0;
      for ([] of items) {
        count += 1;
      }
      return count;
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles empty array destructuring in for-in LHS", () => {
    // for-in does not allow destructuring patterns in TypeScript, but the error
    // should remain about the pattern (not a rewritten `as any[]` assertion).
    const result = validateTypes(
      `
      const obj = { a: 1, b: 2 };
      let count = 0;
      for ([] in obj) {
        count += 1;
      }
      return count;
    `,
      xumTypes
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.message.includes("cannot be a destructuring pattern"))
    ).toBe(true);
    expect(
      result.errors.some((error) => error.message.includes('must be of type "string" or "any"'))
    ).toBe(false);
  });
  test("handles destructuring assignment on LHS", () => {
    // ([] = foo) should not become ([] as any[] = foo) which is invalid
    const result = validateTypes(
      `
      let foo = [1, 2, 3];
      let a, b;
      ([a, b] = foo);
      return [a, b];
    `,
      xumTypes
    );
    expect(result.valid).toBe(true);
  });
});
