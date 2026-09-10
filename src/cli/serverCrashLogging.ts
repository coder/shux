import * as fs from "node:fs";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { getLogFilePath } from "@/node/services/log";

export interface ServerCrashLogOptions {
  event: string;
  detail?: unknown;
  context?: Record<string, unknown>;
  argv?: readonly string[];
  cwd?: string;
  pid?: number;
  timestamp?: Date;
  logFilePath?: string;
}

export function redactServerArgvForLogs(argv: readonly string[]): string[] {
  const redactedArgv: string[] = [];
  let redactNextArg = false;

  for (const arg of argv) {
    if (redactNextArg) {
      redactedArgv.push("<redacted>");
      redactNextArg = false;
      continue;
    }

    if (arg === "--auth-token") {
      redactedArgv.push(arg);
      redactNextArg = true;
      continue;
    }

    if (arg.startsWith("--auth-token=")) {
      redactedArgv.push("--auth-token=<redacted>");
      continue;
    }

    redactedArgv.push(arg);
  }

  return redactedArgv;
}

function formatCrashDetail(detail: unknown): string {
  if (detail instanceof Error) {
    const messageWithCauses = getErrorMessage(detail);
    if (!detail.stack) {
      return messageWithCauses;
    }
    if (messageWithCauses === detail.message) {
      return detail.stack;
    }
    return `${detail.stack}\nCause chain: ${messageWithCauses}`;
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    const serialized = JSON.stringify(detail, null, 2);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to the string helper below.
  }

  return getErrorMessage(detail);
}

export function buildServerCrashLogEntry(options: ServerCrashLogOptions): string {
  const lines = [
    `${(options.timestamp ?? new Date()).toISOString()} [xum server crash] ${options.event}`,
    `pid=${options.pid ?? process.pid} cwd=${options.cwd ?? process.cwd()}`,
    `argv=${JSON.stringify(redactServerArgvForLogs(options.argv ?? process.argv))}`,
  ];

  if (options.context && Object.keys(options.context).length > 0) {
    lines.push(`context=${formatCrashDetail(options.context)}`);
  }

  if (options.detail !== undefined) {
    lines.push(formatCrashDetail(options.detail));
  }

  return `${lines.join("\n")}\n`;
}

export function appendServerCrashLogSync(options: ServerCrashLogOptions): string {
  let entry: string;
  try {
    entry = buildServerCrashLogEntry(options);
  } catch (error) {
    // Crash hooks must survive even if the current working directory disappeared
    // or another formatting helper throws while we're already handling a fatal error.
    entry = `${(options.timestamp ?? new Date()).toISOString()} [xum server crash] ${options.event}\nfailed_to_build_crash_entry=${getErrorMessage(error)}\n`;
  }

  const logFilePath = options.logFilePath ?? getLogFilePath();

  // Fatal crashes can terminate the process before the async logger flushes,
  // so server-mode crash hooks append a compact entry synchronously.
  try {
    // eslint-disable-next-line local/no-sync-fs-methods -- crash handlers must create the log directory before the process exits.
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    // eslint-disable-next-line local/no-sync-fs-methods -- synchronous append is intentional so fatal exits still leave a breadcrumb.
    fs.appendFileSync(logFilePath, entry, "utf-8");
  } catch {
    // Best effort: crash logging must never trigger a second failure.
  }

  return entry;
}
