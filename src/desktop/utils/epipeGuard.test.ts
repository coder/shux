import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installEpipeGuard, isEpipeError } from "./epipeGuard";

function errnoError(code: string): Error {
  const error: NodeJS.ErrnoException = new Error(`write ${code}`);
  error.code = code;
  return error;
}

describe("isEpipeError", () => {
  test("matches errors with code EPIPE", () => {
    expect(isEpipeError(errnoError("EPIPE"))).toBe(true);
  });

  test("rejects other errno codes", () => {
    expect(isEpipeError(errnoError("ECONNRESET"))).toBe(false);
    expect(isEpipeError(errnoError("EIO"))).toBe(false);
  });

  test("rejects errors without a code and non-error values", () => {
    expect(isEpipeError(new Error("write EPIPE"))).toBe(false);
    expect(isEpipeError("EPIPE")).toBe(false);
    expect(isEpipeError(null)).toBe(false);
    expect(isEpipeError(undefined)).toBe(false);
  });
});

describe("installEpipeGuard", () => {
  test("swallows EPIPE errors emitted on the stream", () => {
    const stream = new EventEmitter();
    installEpipeGuard(stream);
    expect(() => stream.emit("error", errnoError("EPIPE"))).not.toThrow();
  });

  test("rethrows non-EPIPE errors so they still surface", () => {
    const stream = new EventEmitter();
    installEpipeGuard(stream);
    expect(() => stream.emit("error", errnoError("ENOSPC"))).toThrow("write ENOSPC");
  });

  test("tolerates a missing stream", () => {
    expect(() => installEpipeGuard(undefined)).not.toThrow();
  });
});
