/**
 * Tests for PTC Static Analysis
 */

import { describe, test, expect, afterAll } from "bun:test";
import { analyzeCode, disposeAnalysisContext } from "./staticAnalysis";
import { CODE_EXECUTION_STRING_GUIDANCE } from "@/constants/codeExecution";

afterAll(() => {
  disposeAnalysisContext();
});

describe("staticAnalysis", () => {
  describe("syntax validation", () => {
    test("valid code passes", async () => {
      const result = await analyzeCode(`
        const x = 1;
        const y = 2;
        return x + y;
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("syntax error is detected", async () => {
      const result = await analyzeCode(`
        const x = 1
        const y = 2 +
      `);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe("syntax");
    });

    test("unclosed brace is detected", async () => {
      const result = await analyzeCode(`
        if (true) {
          const x = 1;
      `);
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("syntax");
    });

    test("invalid token is detected", async () => {
      const result = await analyzeCode(`
        const x = @invalid;
      `);
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("syntax");
    });

    test.each([
      'return "first\nsecond";',
      "return 'first\nsecond';",
      'return "first\r\nsecond";',
      'return "unfinished',
    ])("adds quoting guidance to unterminated strings: %j", async (code) => {
      const result = await analyzeCode(code);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ type: "syntax", line: 1 });
      // Test diagnostic routing, not the wording of the shared guidance.
      expect(result.errors[0].message).toContain(CODE_EXECUTION_STRING_GUIDANCE);
    });

    test("does not add string guidance to unrelated syntax errors", async () => {
      const result = await analyzeCode('const s = "valid string";\nreturn @;');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({ type: "syntax", line: 2 });
      expect(result.errors[0].message).not.toContain(CODE_EXECUTION_STRING_GUIDANCE);
    });

    test("await expression gives clear error message", async () => {
      const result = await analyzeCode(`const x = await mux.bash({ script: "ls" })`);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe("syntax");
      // Should give clear message about await, not obtuse "expecting ';'"
      expect(result.errors[0].message).toContain("await");
      expect(result.errors[0].message).toContain("not supported");
    });
    test("await in class field inside async function gets clear error", async () => {
      const result = await analyzeCode("async function f() { class C { x = await foo(); } }");
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("await");
      expect(result.errors[0].message).toContain("not supported");
    });

    test("await in async function default param gets clear error", async () => {
      // QuickJS gives "await in default expression" (not "expecting ';'"),
      // so the rewrite doesn't apply — but the message is already clear.
      const result = await analyzeCode("async function f(a = await foo()) {}");
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("await");
    });

    test("does not mislabel malformed template literal containing await text", async () => {
      // Unescaped backticks break the template; `await` appears in string content, not code.
      const result = await analyzeCode("const s = `x\n1. `file`\nawait x\n`;");
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("syntax");
      expect(result.errors[0].message).not.toContain("`await` is not supported");
    });

    test("does not mislabel syntax error when await appears in a comment", async () => {
      const result = await analyzeCode("const x = 1 +\n// await something\n");
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("syntax");
      expect(result.errors[0].message).not.toContain("`await` is not supported");
    });

    test("does not mislabel syntax error when await appears in a string", async () => {
      const result = await analyzeCode('const x = "await foo"\nconst y = 1 +\n');
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("syntax");
      expect(result.errors[0].message).not.toContain("`await` is not supported");
    });

    test("allows return statements (wrapped in function)", async () => {
      const result = await analyzeCode(`
        const x = mux.fileRead("test.txt");
        return x;
      `);
      expect(result.valid).toBe(true);
    });
  });

  describe("unavailable patterns", () => {
    test("dynamic import() is unavailable", async () => {
      const result = await analyzeCode(`
        const mod = import("./module.js");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("import()"))).toBe(true);
    });

    test("require() is unavailable", async () => {
      const result = await analyzeCode(`
        const fs = require("fs");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("require()"))).toBe(true);
    });
  });

  describe("unavailable globals", () => {
    test("process is unavailable", async () => {
      const result = await analyzeCode(`
        const env = process.env;
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("process"))).toBe(true);
    });

    test("window is unavailable", async () => {
      const result = await analyzeCode(`
        window.alert("hi");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("window"))).toBe(true);
    });

    test("fetch is unavailable", async () => {
      const result = await analyzeCode(`
        fetch("https://example.com");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("fetch"))).toBe(true);
    });

    test("document is unavailable", async () => {
      const result = await analyzeCode(`
        document.getElementById("test");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("document"))).toBe(true);
    });

    test("multiple unavailable globals produce one error each", async () => {
      const result = await analyzeCode(`
        const a = process.env;
        const b = window.location;
        const c = fetch("url");
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.filter((e) => e.type === "unavailable_global")).toHaveLength(3);
    });

    test("same global used twice produces only one error", async () => {
      const result = await analyzeCode(`
        const a = process.env;
        const b = process.cwd();
      `);
      expect(result.valid).toBe(false);
      expect(result.errors.filter((e) => e.message.includes("process"))).toHaveLength(1);
    });

    test("property access obj.process does not error", async () => {
      const result = await analyzeCode(`
        const obj = { foo: "bar" };
        return obj.process;
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("object key like { process: ... } does NOT error (AST-based detection)", async () => {
      const result = await analyzeCode(`
        const obj = { process: "running" };
      `);
      // AST-based detection correctly identifies this as an object key, not a reference
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("error includes line number", async () => {
      const result = await analyzeCode(`const x = 1;
const y = 2;
const env = process.env;`);
      const processError = result.errors.find((e) => e.message.includes("process"));
      expect(processError?.line).toBe(3);
    });
  });

  describe("local variable shadowing", () => {
    test("local variable shadowing fetch does not error", async () => {
      const result = await analyzeCode(`
        const fetch = mux.file_read({ path: "a.txt" });
        return fetch.content;
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("function declaration shadowing fetch does not error", async () => {
      const result = await analyzeCode(`
        function fetch() { return 1; }
        return fetch();
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("parameter shadowing process does not error", async () => {
      const result = await analyzeCode(`
        function run(process) { return process.id; }
        return run({ id: 1 });
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("unshadowed fetch still errors", async () => {
      const result = await analyzeCode(`fetch("https://example.com")`);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("fetch"))).toBe(true);
    });

    test("multiple variables shadowing different globals", async () => {
      const result = await analyzeCode(`
        const fetch = mux.file_read({ path: "a.txt" });
        const process = { id: 1 };
        return { content: fetch.content, id: process.id };
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("allowed constructs (work in QuickJS)", () => {
    test("eval() is allowed", async () => {
      const result = await analyzeCode(`
        const x = eval("1 + 1");
      `);
      expect(result.valid).toBe(true);
    });

    test("new Function() is allowed", async () => {
      const result = await analyzeCode(`
        const fn = new Function("a", "b", "return a + b");
      `);
      expect(result.valid).toBe(true);
    });

    test("globalThis is allowed", async () => {
      const result = await analyzeCode(`
        const pi = globalThis.Math.PI;
      `);
      expect(result.valid).toBe(true);
    });

    test("Proxy is allowed", async () => {
      const result = await analyzeCode(`
        const p = new Proxy({}, {});
      `);
      expect(result.valid).toBe(true);
    });

    test("Reflect is allowed", async () => {
      const result = await analyzeCode(`
        const x = Reflect.get({a: 1}, "a");
      `);
      expect(result.valid).toBe(true);
    });
  });

  describe("line number reporting", () => {
    test("reports line number for unavailable pattern", async () => {
      const result = await analyzeCode(`const x = 1;
const y = 2;
require("fs");
const z = 3;`);
      const requireError = result.errors.find((e) => e.message.includes("require"));
      expect(requireError?.line).toBe(3);
    });
  });

  describe("valid code examples", () => {
    test("file reading and processing", async () => {
      const result = await analyzeCode(`
        const content = mux.fileRead("package.json");
        const pkg = JSON.parse(content);
        return pkg.name;
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("array operations", async () => {
      const result = await analyzeCode(`
        const files = ["a.txt", "b.txt", "c.txt"];
        const results = [];
        for (const file of files) {
          results.push(mux.fileRead(file));
        }
        return results;
      `);
      expect(result.valid).toBe(true);
    });

    test("using Date and Math", async () => {
      const result = await analyzeCode(`
        const now = new Date();
        const random = Math.floor(Math.random() * 100);
        console.log("Time:", now.toISOString());
        return random;
      `);
      expect(result.valid).toBe(true);
    });

    test("object and array manipulation", async () => {
      const result = await analyzeCode(`
        const data = { items: [1, 2, 3] };
        const doubled = data.items.map(x => x * 2);
        const sum = doubled.reduce((a, b) => a + b, 0);
        return { doubled, sum };
      `);
      expect(result.valid).toBe(true);
    });

    test("try-catch error handling", async () => {
      const result = await analyzeCode(`
        try {
          const content = mux.fileRead("maybe-missing.txt");
          return content;
        } catch (err) {
          console.error("File not found:", err.message);
          return null;
        }
      `);
      expect(result.valid).toBe(true);
    });

    test("regex operations", async () => {
      const result = await analyzeCode(`
        const text = mux.fileRead("log.txt");
        const pattern = /error:.*/gi;
        const matches = text.match(pattern);
        return matches || [];
      `);
      expect(result.valid).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("empty code is valid", async () => {
      const result = await analyzeCode("");
      expect(result.valid).toBe(true);
    });

    test("whitespace only is valid", async () => {
      const result = await analyzeCode("   \n\n  \t  ");
      expect(result.valid).toBe(true);
    });

    test("comment only is valid", async () => {
      const result = await analyzeCode(`
        // This is a comment
        /* Multi-line
           comment */
      `);
      expect(result.valid).toBe(true);
    });

    test("require in string literal does NOT error (AST-based detection)", async () => {
      const result = await analyzeCode(`
        const msg = "Use require() to import modules";
        console.log(msg);
      `);

      // We intentionally avoid pattern/substring scanning for require()/import() because those
      // keywords can appear in user strings.
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("process in string literal does NOT error (AST-based detection)", async () => {
      const result = await analyzeCode(`
        const msg = "The process is complete";
        console.log(msg);
      `);
      // AST-based detection correctly ignores string literal content
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
