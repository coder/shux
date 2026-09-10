/**
 * Unified logging for xum (backend + CLI)
 *
 * Features:
 * - Log levels: error, warn, info, debug (hierarchical)
 * - EPIPE protection for piped output
 * - Caller file:line prefix for debugging
 * - Colored output in TTY
 *
 * Log level selection (in priority order):
 * 1. XUM_LOG_LEVEL env var (error|warn|info|debug); MUX_LOG_LEVEL is accepted
 * 2. XUM_DEBUG=1 → debug level
 * 3. CLI mode (no Electron) → error level (quiet by default)
 * 4. Desktop mode → info level
 *
 * Use log.setLevel() to override programmatically (e.g., --verbose flag).
 */

import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { parseBoolEnv } from "@/common/utils/env";
import { getErrorMessage } from "@/common/utils/errors";
import { getXumHome, getXumLogsDir } from "@/common/constants/paths";
import { clearLogEntries, hasDebugSubscriber, pushLogEntry } from "./logBuffer";

process.once("exit", () => {
  closeLogFile();
});

// Lazy-initialized to avoid circular dependency with config.ts
let _debugObjDir: string | null = null;
function getDebugObjDir(): string {
  _debugObjDir ??= path.join(getXumHome(), "debug_obj");
  return _debugObjDir;
}

/** Logging types */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  debug_obj: (filename: string, obj: unknown) => void;
  setLevel: (level: LogLevel) => void;
  getLevel: () => LogLevel;
  isDebugMode: () => boolean;
  withFields: (fields: LogFields) => Logger;
}
export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Determine the default log level based on environment
 */
function getDefaultLogLevel(): LogLevel {
  // Explicit env var takes priority
  const envLevel = resolveXumEnvironmentValue("LOG_LEVEL", process.env)?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_PRIORITY) {
    return envLevel as LogLevel;
  }

  // XUM_DEBUG=1 enables debug level
  if (parseBoolEnv(resolveXumEnvironmentValue("DEBUG", process.env))) {
    return "debug";
  }

  // CLI mode (no Electron) defaults to error (quiet)
  // Desktop mode defaults to info
  const isElectron = "electron" in process.versions;
  return isElectron ? "info" : "error";
}

type FileSinkState =
  | { status: "idle" }
  | { status: "open"; stream: fs.WriteStream; path: string; size: number }
  | { status: "degraded"; reason: string; retryAfterMs: number }
  | { status: "closed" };

let fileSinkState: FileSinkState = { status: "idle" };
let sinkTransition: Promise<void> = Promise.resolve();
let sinkTransitionDepth = 0;
let sinkLifecycleEpoch = 0;

function enqueueSinkTransition(task: () => Promise<void>): Promise<void> {
  sinkTransitionDepth += 1;

  // `run` is the caller-visible promise: resolves/rejects with the task's real outcome.
  const run = sinkTransition.catch(() => undefined).then(task);

  // The internal chain absorbs failures so subsequent commands still execute,
  // but only transitions to degraded if the sink hasn't been terminally closed.
  sinkTransition = run
    .catch((error) => {
      if (fileSinkState.status !== "closed") {
        setDegradedState(error);
      }
    })
    .finally(() => {
      sinkTransitionDepth -= 1;
    });

  return run;
}

const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 3;
const LOG_FILE_RETRY_BACKOFF_MS = 30_000;

function createSafeStream(filePath: string): fs.WriteStream {
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  stream.on("error", (error) => {
    // Ignore stale stream errors after rotation/clear/close; only active stream
    // failures should flip the sink into degraded mode.
    if (fileSinkState.status !== "open" || fileSinkState.stream !== stream) {
      return;
    }

    fileSinkState = {
      status: "degraded",
      reason: getErrorMessage(error),
      retryAfterMs: Date.now() + LOG_FILE_RETRY_BACKOFF_MS,
    };

    try {
      stream.destroy();
    } catch {
      // logger must fail silently
    }
  });
  return stream;
}

function setDegradedState(error: unknown): void {
  fileSinkState = {
    status: "degraded",
    reason: getErrorMessage(error),
    retryAfterMs: Date.now() + LOG_FILE_RETRY_BACKOFF_MS,
  };
}

function waitForStreamClose(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve();
    };

    stream.once("close", finish);
    stream.once("error", finish);
    // .end() callback fires on 'finish', which precedes 'close'—
    // but the callback guarantees flush completed.
    stream.end(() => finish());
  });
}

function stripAnsi(text: string): string {
  // Matches standard ANSI escape codes for colors/styles.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function ensureSinkOpen(): void {
  // Bail while a transition (rotate/clear/close) is in progress — the queue
  // will reopen the sink if appropriate.
  if (sinkTransitionDepth > 0) {
    return;
  }

  if (fileSinkState.status === "open" || fileSinkState.status === "closed") {
    return;
  }

  if (fileSinkState.status === "degraded" && Date.now() < fileSinkState.retryAfterMs) {
    return;
  }

  try {
    const logsDir = getXumLogsDir();
    const activeLogPath = path.join(logsDir, "mux.log");

    fs.mkdirSync(logsDir, { recursive: true });

    let fileSize = 0;
    try {
      fileSize = fs.statSync(activeLogPath).size;
    } catch {
      fileSize = 0;
    }

    const stream = createSafeStream(activeLogPath);
    fileSinkState = { status: "open", stream, path: activeLogPath, size: fileSize };
  } catch (error) {
    // Never throw from the logger; enter degraded mode and retry later.
    setDegradedState(error);
  }
}

function rotateSink(): void {
  if (fileSinkState.status !== "open") {
    return;
  }

  const openSink = fileSinkState;
  const transitionEpoch = sinkLifecycleEpoch;
  // Immediately move to idle so writeSink() won't write to the old stream.
  fileSinkState = { status: "idle" };

  enqueueSinkTransition(async () => {
    await waitForStreamClose(openSink.stream);

    const logsDir = path.dirname(openSink.path);

    // Shift: mux.3.log → deleted, mux.2.log → mux.3.log, etc.
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = path.join(logsDir, i === 1 ? "mux.log" : `mux.${i - 1}.log`);
      const to = path.join(logsDir, `mux.${i}.log`);
      try {
        fs.renameSync(from, to);
      } catch {
        // file may not exist
      }
    }

    if (fileSinkState.status === "closed" || transitionEpoch !== sinkLifecycleEpoch) {
      return;
    }

    const stream = createSafeStream(openSink.path);
    fileSinkState = { status: "open", stream, path: openSink.path, size: 0 };
  }).catch(() => undefined);
}

function writeSink(cleanLineWithNewline: string): void {
  try {
    ensureSinkOpen();
    if (fileSinkState.status !== "open") {
      return;
    }

    const openSink = fileSinkState;
    const bytes = Buffer.byteLength(cleanLineWithNewline, "utf-8");

    openSink.stream.write(cleanLineWithNewline);

    // Stream writes are async and can error out-of-band. Only update size
    // when this sink instance is still active.
    if (fileSinkState.status !== "open" || fileSinkState.stream !== openSink.stream) {
      return;
    }

    const nextSize = openSink.size + bytes;
    fileSinkState = { ...openSink, size: nextSize };

    if (nextSize >= MAX_LOG_FILE_SIZE) {
      rotateSink();
    }
  } catch {
    // Silent failure.
  }
}

export function getLogFilePath(): string {
  return path.join(getXumLogsDir(), "mux.log");
}

function clearSink(): Promise<void> {
  const logsDir = getXumLogsDir();
  const activeLogPath = path.join(logsDir, "mux.log");

  const openSink = fileSinkState.status === "open" ? fileSinkState : null;
  const transitionEpoch = sinkLifecycleEpoch;
  // Immediately move to idle so writeSink() won't write to the old stream.
  if (openSink) {
    fileSinkState = { status: "idle" };
  }

  return enqueueSinkTransition(async () => {
    if (openSink) {
      await waitForStreamClose(openSink.stream);
    }

    fs.mkdirSync(logsDir, { recursive: true });

    // Truncate the active log. Throws on permission errors.
    const fd = fs.openSync(activeLogPath, "w");
    fs.closeSync(fd);

    // Remove rotated files — missing files are fine.
    for (let i = 1; i <= MAX_LOG_FILES; i++) {
      const rotatedPath = path.join(logsDir, `mux.${i}.log`);
      try {
        fs.unlinkSync(rotatedPath);
      } catch {
        // file may not exist
      }
    }

    if (!openSink || fileSinkState.status === "closed" || transitionEpoch !== sinkLifecycleEpoch) {
      return;
    }

    const stream = createSafeStream(activeLogPath);
    fileSinkState = { status: "open", stream, path: activeLogPath, size: 0 };
  });
}

export async function clearLogsForApi() {
  try {
    await clearLogFiles();
    clearLogEntries();
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: getErrorMessage(error) };
  }
}

export function clearLogFiles(): Promise<void> {
  return clearSink();
}

function closeSink(): void {
  const openSink = fileSinkState.status === "open" ? fileSinkState : null;

  // Terminal state — set immediately so no new writes start.
  fileSinkState = { status: "closed" };
  sinkLifecycleEpoch += 1;

  if (!openSink) {
    return;
  }

  enqueueSinkTransition(async () => {
    await waitForStreamClose(openSink.stream);
  }).catch(() => undefined);
}

export function closeLogFile(): void {
  closeSink();
}

/** @internal Test seam: reset singleton sink state for hermetic tests. */
export function __resetFileSinkForTests(): void {
  if (fileSinkState.status === "open") {
    try {
      fileSinkState.stream.end();
    } catch {
      // silent
    }
  }

  fileSinkState = { status: "idle" };
  sinkTransition = Promise.resolve();
  sinkTransitionDepth = 0;
  sinkLifecycleEpoch = 0;
}

let currentLogLevel: LogLevel = getDefaultLogLevel();

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLogLevel];
}

/**
 * Check if debug mode is enabled (for backwards compatibility)
 */
function isDebugMode(): boolean {
  return currentLogLevel === "debug";
}

/**
 * Check if we're running in a TTY (terminal) that supports colors
 */
function supportsColor(): boolean {
  return process.stdout.isTTY ?? false;
}

// Chalk can be unexpectedly hoisted or partially mocked in certain test runners.
// Guard each style helper to avoid runtime TypeErrors (e.g., dim is not a function).
const chalkDim =
  typeof (chalk as { dim?: (text: string) => string }).dim === "function"
    ? (chalk as { dim: (text: string) => string }).dim
    : (text: string) => text;
const chalkCyan =
  typeof (chalk as { cyan?: (text: string) => string }).cyan === "function"
    ? (chalk as { cyan: (text: string) => string }).cyan
    : (text: string) => text;
const chalkGray =
  typeof (chalk as { gray?: (text: string) => string }).gray === "function"
    ? (chalk as { gray: (text: string) => string }).gray
    : (text: string) => text;
const chalkRed =
  typeof (chalk as { red?: (text: string) => string }).red === "function"
    ? (chalk as { red: (text: string) => string }).red
    : (text: string) => text;
const chalkYellow =
  typeof (chalk as { yellow?: (text: string) => string }).yellow === "function"
    ? (chalk as { yellow: (text: string) => string }).yellow
    : (text: string) => text;

/**
 * Get kitchen time timestamp for logs (12-hour format with milliseconds)
 * Format: 8:23.456PM (hours:minutes.milliseconds)
 */
function getTimestamp(): string {
  const now = new Date();
  let hours = now.getHours();
  const minutes = now.getMinutes();
  const milliseconds = now.getMilliseconds();

  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // Convert 0 to 12

  const mm = String(minutes).padStart(2, "0");
  const ms = String(milliseconds).padStart(3, "0"); // 3 digits: 000-999

  return `${hours}:${mm}.${ms}${ampm}`;
}

interface ParsedStackFrame {
  filePath: string;
  lineNum: string;
}

function parseStackFrame(stackLine: string): ParsedStackFrame | null {
  const match = /\((.+):(\d+):\d+\)$/.exec(stackLine) ?? /at (.+):(\d+):\d+$/.exec(stackLine);
  if (!match) {
    return null;
  }

  const [, filePath, lineNum] = match;
  return { filePath, lineNum };
}

function isLoggerStackFrame(stackLine: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (
    normalizedPath.endsWith("/src/node/services/log.ts") ||
    normalizedPath.endsWith("/src/node/services/log.js")
  ) {
    return true;
  }

  return (
    stackLine.includes("getCallerLocation") ||
    stackLine.includes("safePipeLog") ||
    stackLine.includes("formatLogLine")
  );
}

function formatCallerLocation(filePath: string, lineNum: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedCwd = process.cwd().replace(/\\/g, "/");

  if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return `${normalizedPath.slice(normalizedCwd.length + 1)}:${lineNum}`;
  }

  const srcIndex = normalizedPath.lastIndexOf("/src/");
  if (srcIndex >= 0) {
    return `${normalizedPath.slice(srcIndex + 1)}:${lineNum}`;
  }

  return `${path.basename(normalizedPath)}:${lineNum}`;
}

/**
 * Get the first non-logger caller frame from the stack trace.
 *
 * We intentionally scan frames instead of using a fixed stack index because
 * wrapper levels can shift over time and otherwise collapse locations to the
 * logger wrapper (e.g. log.ts:488) instead of the real call site.
 */
function getCallerLocation(): string {
  const stackLines = new Error().stack?.split("\n").slice(1) ?? [];

  for (const stackLine of stackLines) {
    const parsedFrame = parseStackFrame(stackLine);
    if (!parsedFrame) {
      continue;
    }

    if (parsedFrame.filePath.startsWith("node:")) {
      continue;
    }

    if (isLoggerStackFrame(stackLine, parsedFrame.filePath)) {
      continue;
    }

    return formatCallerLocation(parsedFrame.filePath, parsedFrame.lineNum);
  }

  return "unknown:0";
}

/**
 * Pipe-safe logging function with styled timestamp and caller location
 * Format: 8:23.456PM src/main.ts:23 <message>
 * @param level - Log level
 * @param args - Arguments to log
 */
function formatLogLine(level: LogLevel): {
  timestamp: string;
  location: string;
  useColor: boolean;
  prefix: string;
} {
  const timestamp = getTimestamp();
  const location = getCallerLocation();
  const useColor = supportsColor();

  // Apply colors based on level (if terminal supports it)
  let prefix: string;
  if (useColor) {
    const coloredTimestamp = chalkDim(timestamp);
    const coloredLocation = chalkCyan(location);

    if (level === "error") {
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    } else if (level === "warn") {
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    } else if (level === "debug") {
      prefix = `${coloredTimestamp} ${chalkGray(location)}`;
    } else {
      // info
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    }
  } else {
    // No colors
    prefix = `${timestamp} ${location}`;
  }

  return { timestamp, location, useColor, prefix };
}

function safePipeLog(level: LogLevel, ...args: unknown[]): void {
  const shouldConsoleLog = shouldLog(level);

  // Fast path: skip formatting entirely for debug entries that won't be
  // logged to console or persisted. Avoids the expensive new Error().stack
  // capture in getCallerLocation() on hot callsites.
  if (level === "debug" && !shouldConsoleLog && !hasDebugSubscriber()) {
    return;
  }

  const { timestamp, location, useColor, prefix } = formatLogLine(level);

  try {
    if (shouldConsoleLog) {
      if (level === "error") {
        // Color the entire error message red if supported
        if (useColor) {
          console.error(
            prefix,
            ...args.map((arg) => (typeof arg === "string" ? chalkRed(arg) : arg))
          );
        } else {
          console.error(prefix, ...args);
        }
      } else if (level === "warn") {
        // Color the entire warning message yellow if supported
        if (useColor) {
          console.error(
            prefix,
            ...args.map((arg) => (typeof arg === "string" ? chalkYellow(arg) : arg))
          );
        } else {
          console.error(prefix, ...args);
        }
      } else {
        // info and debug go to stdout
        console.log(prefix, ...args);
      }
    }
  } catch (error) {
    // Silently ignore EPIPE and other console errors
    const errorCode =
      error && typeof error === "object" && "code" in error ? error.code : undefined;
    const errorMessage =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "Unknown error";

    if (errorCode !== "EPIPE") {
      try {
        const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
        stream.write(`${timestamp} ${location} Console error: ${errorMessage}\n`);
      } catch {
        // Even the fallback might fail, just ignore
      }
    }
  }

  // Always persist error/warn/info to buffer+file.
  // Debug entries only persist when console level includes debug
  // or an Output tab subscriber has requested debug level.
  const shouldPersist = level !== "debug" || shouldConsoleLog || hasDebugSubscriber();
  if (!shouldPersist) {
    return;
  }

  // Build a best-effort, pre-formatted single-line message for file/buffer.
  // Note: console output behavior is intentionally unchanged.
  const message = args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Error) {
        return arg.stack ?? arg.message;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");

  const formattedLine = `${prefix} ${message}`;
  const cleanLine = stripAnsi(formattedLine);

  writeSink(`${cleanLine}\n`);

  pushLogEntry({
    timestamp: Date.now(),
    level,
    // Send just the log message, not the pre-formatted line (timestamp+location
    // are already separate fields — no need to duplicate them in the message).
    message,
    location,
  });
}

/**
 * Dump an object to a JSON file in the debug_obj directory (only in debug mode)
 * @param filename - Name of the file (can include subdirectories like "workspace_id/file.json")
 * @param obj - Object to serialize and dump
 */
function debugObject(filename: string, obj: unknown): void {
  if (!isDebugMode()) {
    return;
  }

  try {
    // Ensure debug_obj directory exists
    const debugObjDir = getDebugObjDir();
    fs.mkdirSync(debugObjDir, { recursive: true });

    const filePath = path.join(debugObjDir, filename);
    const dirPath = path.dirname(filePath);

    // Ensure subdirectories exist
    fs.mkdirSync(dirPath, { recursive: true });

    // Write the object as pretty-printed JSON
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");

    safePipeLog("debug", `Dumped object to ${filePath}`);
  } catch (error) {
    // Don't crash if we can't write debug files
    safePipeLog("error", `Failed to dump debug object to ${filename}:`, error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (value instanceof Error) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function normalizeFields(fields?: LogFields): LogFields | undefined {
  return fields && Object.keys(fields).length > 0 ? fields : undefined;
}

function mergeLogFields(base?: LogFields, extra?: LogFields): LogFields | undefined {
  return normalizeFields({ ...(base ?? {}), ...(extra ?? {}) });
}

const baseLogger = {
  debug_obj: debugObject,
  setLevel: (level: LogLevel): void => {
    currentLogLevel = level;
  },
  getLevel: (): LogLevel => currentLogLevel,
  isDebugMode,
};
function appendFieldsToArgs(args: unknown[], fields?: LogFields): unknown[] {
  if (!fields) {
    return args;
  }
  if (args.length === 0) {
    return [fields];
  }
  const lastArg = args[args.length - 1];
  if (isPlainObject(lastArg)) {
    return [...args.slice(0, -1), { ...fields, ...lastArg }];
  }
  return [...args, fields];
}

function createLogger(boundFields?: LogFields): Logger {
  const normalizedFields = normalizeFields(boundFields);
  const logAtLevel =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      safePipeLog(level, ...appendFieldsToArgs(args, normalizedFields));
    };

  return {
    ...baseLogger,
    info: logAtLevel("info"),
    warn: logAtLevel("warn"),
    error: logAtLevel("error"),
    debug: logAtLevel("debug"),
    withFields: (fields: LogFields): Logger =>
      createLogger(mergeLogFields(normalizedFields, fields)),
  };
}

/**
 * Unified logging interface for xum
 *
 * Log levels (hierarchical - each includes all levels above it):
 * - error: Critical failures only
 * - warn: Warnings + errors
 * - info: Informational + warnings + errors
 * - debug: Everything (verbose)
 *
 * Default levels:
 * - CLI mode: error (quiet by default)
 * - Desktop mode: info
 * - MUX_DEBUG=1: debug
 * - MUX_LOG_LEVEL=<level>: explicit override
 *
 * Use log.withFields({ workspaceId }) to create a sub-logger that
 * automatically includes fields in every log entry.
 */
export const log = createLogger();
