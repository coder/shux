import assert from "node:assert/strict";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { formatWithOptions } from "node:util";
import { Command } from "commander";
import { isolateStdoutForAcp, runAcpAdapter } from "../node/acp/adapter";
import { connectToServer } from "../node/acp/serverConnection";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { getParseOptions } from "./argv";

const program = new Command();

async function closeWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    stream.once("close", finish);
    stream.once("error", finish);
    stream.end();
  });
}

async function installAcpLogFileRedirect(logFilePath: string): Promise<() => Promise<void>> {
  assert(logFilePath.trim().length > 0, "installAcpLogFileRedirect: logFilePath must be non-empty");

  const resolvedLogPath = path.resolve(logFilePath);
  const logDirectory = path.dirname(resolvedLogPath);

  await mkdir(logDirectory, { recursive: true });
  await appendFile(resolvedLogPath, "", "utf8");

  const fallbackError = console.error.bind(console);
  const logStream = createWriteStream(resolvedLogPath, {
    flags: "a",
    encoding: "utf8",
  });

  let streamHasFailed = false;
  logStream.on("error", (error) => {
    streamHasFailed = true;
    fallbackError("[acp] ACP log file stream failed; falling back to stderr", {
      logFilePath: resolvedLogPath,
      error,
    });
  });

  const appendLogLine = (level: string, args: unknown[]): void => {
    if (streamHasFailed) {
      fallbackError(...args);
      return;
    }

    const message = formatWithOptions({ colors: false, depth: null }, ...args);
    const logLine = `${new Date().toISOString()} [${level}] ${message}\n`;

    try {
      logStream.write(logLine);
    } catch (error) {
      streamHasFailed = true;
      fallbackError("[acp] Failed to append to ACP log file; falling back to stderr", {
        logFilePath: resolvedLogPath,
        error,
      });
      fallbackError(...args);
    }
  };

  // Keep ACP logs out of stderr when an explicit log file is requested.
  console.error = (...args: unknown[]) => {
    appendLogLine("ERROR", args);
  };
  console.warn = (...args: unknown[]) => {
    appendLogLine("WARN", args);
  };
  console.log = (...args: unknown[]) => {
    appendLogLine("INFO", args);
  };
  console.info = (...args: unknown[]) => {
    appendLogLine("INFO", args);
  };
  console.debug = (...args: unknown[]) => {
    appendLogLine("DEBUG", args);
  };
  console.dir = (...args: unknown[]) => {
    appendLogLine("DIR", args);
  };

  appendLogLine("INFO", [`[acp] Logging redirected to ${resolvedLogPath}`]);

  return async () => {
    await closeWriteStream(logStream);
  };
}

let cleanupAcpLogRedirect: (() => Promise<void>) | undefined;

program
  .name("xum acp")
  .description("ACP (Agent-Client Protocol) stdio interface for editor integration")
  .option("--server-url <url>", "URL of a running xum server")
  .option("--auth-token <token>", "Auth token for server connection")
  .option("--log-file <path>", "Write ACP logs to a file instead of stderr")
  .action(async (options: Record<string, unknown>) => {
    const serverUrl = typeof options.serverUrl === "string" ? options.serverUrl : undefined;
    const authToken = typeof options.authToken === "string" ? options.authToken : undefined;
    const logFile = typeof options.logFile === "string" ? options.logFile : undefined;

    // Redirect console.log to stderr immediately — before any code that may
    // log to stdout (connectToServer can start an in-process server).
    isolateStdoutForAcp();

    if (logFile != null) {
      cleanupAcpLogRedirect = await installAcpLogFileRedirect(logFile);
    }

    console.error("[acp] Connecting to xum server…");
    const connection = await connectToServer({
      serverUrl: serverUrl ?? resolveXumEnvironmentValue("SERVER_URL", process.env),
      authToken: authToken ?? resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", process.env),
    });
    console.error("[acp] Connected to server at", connection.baseUrl);

    console.error("[acp] Starting ACP adapter — reading stdin");
    await runAcpAdapter(connection);
  });

void (async () => {
  try {
    await program.parseAsync(process.argv, getParseOptions());
  } catch (error) {
    console.error("Failed to start ACP adapter:", error);
    process.exitCode = 1;
  } finally {
    if (cleanupAcpLogRedirect != null) {
      await cleanupAcpLogRedirect();
    }
  }
})();
