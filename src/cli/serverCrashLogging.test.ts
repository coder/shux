import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendServerCrashLogSync,
  buildServerCrashLogEntry,
  redactServerArgvForLogs,
} from "./serverCrashLogging";

describe("serverCrashLogging", () => {
  test("redacts auth tokens in argv", () => {
    expect(
      redactServerArgvForLogs([
        "node",
        "mux",
        "server",
        "--auth-token",
        "secret-token",
        "--auth-token=another-secret",
        "--port",
        "3000",
      ])
    ).toEqual([
      "node",
      "mux",
      "server",
      "--auth-token",
      "<redacted>",
      "--auth-token=<redacted>",
      "--port",
      "3000",
    ]);
  });

  test("includes stack traces and redacted argv in crash entries", () => {
    const error = new Error("boom");
    const entry = buildServerCrashLogEntry({
      event: "Unhandled promise rejection",
      detail: error,
      context: { origin: "unhandledRejection" },
      argv: ["node", "mux", "server", "--auth-token", "secret-token"],
      cwd: "/tmp/workspace",
      pid: 42,
      timestamp: new Date("2026-03-10T00:00:00.000Z"),
    });

    expect(entry).toContain(
      "2026-03-10T00:00:00.000Z [xum server crash] Unhandled promise rejection"
    );
    expect(entry).toContain("pid=42 cwd=/tmp/workspace");
    expect(entry).toContain('argv=["node","mux","server","--auth-token","<redacted>"]');
    expect(entry).toContain('context={\n  "origin": "unhandledRejection"\n}');
    expect(entry).toContain("Error: boom");
    expect(entry).not.toContain("secret-token");
  });

  test("falls back when crash entry construction throws", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-server-crash-log-fallback-"));
    const logFilePath = path.join(tempDir, "logs", "mux.log");
    const cwdSpy = spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });

    try {
      const entry = appendServerCrashLogSync({
        event: "Fatal process error",
        detail: new Error("boom"),
        logFilePath,
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
      });

      expect(entry).toContain("[xum server crash] Fatal process error");
      expect(entry).toContain("failed_to_build_crash_entry=cwd missing");

      const written = await fs.readFile(logFilePath, "utf-8");
      expect(written).toContain("failed_to_build_crash_entry=cwd missing");
    } finally {
      cwdSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("appends crash entries to disk synchronously", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-server-crash-log-"));
    const logFilePath = path.join(tempDir, "logs", "mux.log");

    try {
      appendServerCrashLogSync({
        event: "beforeExit",
        context: { code: 0 },
        argv: ["node", "mux", "server"],
        cwd: "/tmp/workspace",
        pid: 7,
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
        logFilePath,
      });

      const written = await fs.readFile(logFilePath, "utf-8");
      expect(written).toContain("[xum server crash] beforeExit");
      expect(written).toContain('context={\n  "code": 0\n}');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
