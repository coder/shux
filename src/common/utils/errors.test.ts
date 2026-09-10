import { describe, it, expect } from "bun:test";
import { clampErrorMessage, getErrorMessage } from "./errors";

describe("getErrorMessage", () => {
  it("returns string representation of non-Error values", () => {
    expect(getErrorMessage("boom")).toBe("boom");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("returns .message from a plain object with a message property", () => {
    expect(getErrorMessage({ message: "rate limit exceeded", code: 429 })).toBe(
      "rate limit exceeded"
    );
  });

  it("falls back to String() when reading message throws", () => {
    const obj = {};
    Object.defineProperty(obj, "message", {
      get() {
        throw new Error("getter boom");
      },
    });

    expect(getErrorMessage(obj)).toBe("[object Object]");
  });

  it("returns JSON for a plain object without a message property", () => {
    expect(getErrorMessage({ code: 429, status: "error" })).toBe('{"code":429,"status":"error"}');
  });

  it("returns JSON for a plain object with empty message", () => {
    expect(getErrorMessage({ message: "", code: 500 })).toBe('{"message":"","code":500}');
  });

  it("returns JSON for an array error value", () => {
    expect(getErrorMessage(["error1", "error2"])).toBe('["error1","error2"]');
  });

  it("falls back to String() when JSON serialization returns undefined", () => {
    const obj = {
      toJSON: () => undefined,
    };
    expect(getErrorMessage(obj)).toBe("[object Object]");
  });

  it("serializes circular plain objects with a [Circular] marker instead of degrading", () => {
    const obj: Record<string, unknown> = { code: 500 };
    obj.self = obj;
    expect(getErrorMessage(obj)).toBe('{"code":500,"self":"[Circular]"}');
  });

  it("keeps shared (non-cyclic) sibling references intact", () => {
    // Only true cycles become [Circular]; a payload referencing the same
    // detail object from two fields must serialize both occurrences.
    const detail = { reason: "quota" };
    const obj = { error: detail, details: detail };
    expect(getErrorMessage(obj)).toBe('{"error":{"reason":"quota"},"details":{"reason":"quota"}}');
  });

  it("returns .message for a plain Error", () => {
    expect(getErrorMessage(new Error("something failed"))).toBe("something failed");
  });

  it("walks a single-level cause chain", () => {
    const inner = new Error("ENOENT: no such file");
    const outer = new Error("Failed to read file /foo:", { cause: inner });
    expect(getErrorMessage(outer)).toBe("Failed to read file /foo: [cause: ENOENT: no such file]");
  });

  it("walks a multi-level cause chain", () => {
    const root = new Error("connection reset");
    const mid = new Error("SSH read failed", { cause: root });
    const top = new Error("Failed to stat /remote/path:", { cause: mid });
    expect(getErrorMessage(top)).toBe(
      "Failed to stat /remote/path: [cause: SSH read failed] [cause: connection reset]"
    );
  });

  it("skips cause whose message is already in the parent", () => {
    // RuntimeError often embeds the inner message in its own message
    const inner = new Error("permission denied");
    const outer = new Error("Failed to read file: permission denied", { cause: inner });
    expect(getErrorMessage(outer)).toBe("Failed to read file: permission denied");
  });

  it("handles cause that is not an Error", () => {
    const err = new Error("wrapped", { cause: "string cause" });
    // Non-Error causes are not walked
    expect(getErrorMessage(err)).toBe("wrapped");
  });

  it("skips non-informative [object Object] cause messages", () => {
    const inner = new Error("[object Object]");
    const outer = new Error("outer", { cause: inner });
    expect(getErrorMessage(outer)).toBe("outer");
  });

  it("handles empty cause message", () => {
    const inner = new Error("");
    const outer = new Error("outer", { cause: inner });
    // Empty cause message is skipped
    expect(getErrorMessage(outer)).toBe("outer");
  });

  it("handles cyclic cause chain without hanging", () => {
    const a = new Error("error A");
    const b = new Error("error B", { cause: a });
    // Create a cycle: a -> b -> a -> ...
    a.cause = b;
    const result = getErrorMessage(b);
    expect(result).toContain("error B");
    expect(result).toContain("error A");
  });

  it("handles self-referencing cause", () => {
    const err = new Error("self");
    err.cause = err;
    expect(getErrorMessage(err)).toBe("self");
  });
});

describe("clampErrorMessage", () => {
  it("returns short messages unchanged", () => {
    expect(clampErrorMessage("boom", 100)).toBe("boom");
  });

  it("clamps oversized messages while keeping head and tail", () => {
    const head = "Invalid prompt: schema mismatch. ";
    const tail = " Error message: expected string, received undefined";
    const message = head + "x".repeat(100_000) + tail;

    const clamped = clampErrorMessage(message, 1_000);

    expect(clamped.length).toBeLessThan(1_100);
    expect(clamped.startsWith(head)).toBe(true);
    expect(clamped.endsWith(tail)).toBe(true);
    expect(clamped).toContain("chars omitted");
  });

  it("clamps at the default bound", () => {
    const clamped = clampErrorMessage("y".repeat(500_000));
    expect(clamped.length).toBeLessThan(10_000);
  });
});
