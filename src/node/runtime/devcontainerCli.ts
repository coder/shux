/**
 * Devcontainer CLI helper - wraps `devcontainer` CLI commands.
 *
 * This module provides async functions for devcontainer operations:
 * - checkVersion: verify CLI is installed and get version
 * - up: build/start container with streaming logs
 * - exec: execute commands inside the container
 * - down: stop and remove the container
 */
import { spawn, spawnSync } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import * as path from "path";
import type { BindMount } from "./credentialForwarding";
import type { InitLogger } from "./Runtime";
import { LineBuffer } from "./initHook";
import { redactDevcontainerArgsForLog } from "./devcontainerLogRedaction";
import { forceCloseStdio, killProcessTree } from "@/node/utils/disposableExec";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

type DevcontainerUpOutcome = "success" | "error";

export interface DevcontainerUpResultLine {
  outcome: DevcontainerUpOutcome;
  containerId?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  message?: string;
  description?: string;
}

export type DevcontainerStdoutParse =
  | { kind: "result"; result: DevcontainerUpResultLine }
  | { kind: "log"; text: string }
  | { kind: "raw"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDevcontainerUpOutcome(value: unknown): value is DevcontainerUpOutcome {
  return value === "success" || value === "error";
}

function isDevcontainerUpResult(value: unknown): value is DevcontainerUpResultLine {
  if (!isRecord(value)) return false;
  return isDevcontainerUpOutcome(value.outcome);
}

function extractDevcontainerLogText(value: Record<string, unknown>): string | null {
  const text = typeof value.text === "string" ? value.text : undefined;
  if (text) {
    const level = typeof value.level === "number" ? value.level : 0;
    const channel = typeof value.channel === "string" ? value.channel : "";
    const type = typeof value.type === "string" ? value.type : "";
    const isError = channel === "error" || type === "error";
    if (level >= 2 || isError) {
      return text;
    }
    return null;
  }

  const name = typeof value.name === "string" ? value.name : undefined;
  if (name) {
    return name;
  }

  return null;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function parseDevcontainerStdoutLine(line: string): DevcontainerStdoutParse | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) {
    return { kind: "raw", text: line };
  }

  const parsed = parseJsonLine(trimmed);
  if (!parsed) {
    return { kind: "raw", text: line };
  }

  if (isDevcontainerUpResult(parsed)) {
    return { kind: "result", result: parsed };
  }

  if (isRecord(parsed)) {
    const text = extractDevcontainerLogText(parsed);
    if (text) {
      return { kind: "log", text };
    }
  }

  return null;
}

export function formatDevcontainerUpError(
  result: DevcontainerUpResultLine,
  stderrSummary?: string
): string {
  const messageParts = [result.message, result.description].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (messageParts.length > 0) {
    return `devcontainer up failed: ${messageParts.join(" - ")}`;
  }

  if (stderrSummary && stderrSummary.trim().length > 0) {
    return `devcontainer up failed: ${stderrSummary.trim()}`;
  }

  return "devcontainer up failed";
}

export function shouldCleanupDevcontainer(result: DevcontainerUpResultLine): boolean {
  return (
    result.outcome === "error" &&
    typeof result.containerId === "string" &&
    result.containerId.trim().length > 0
  );
}
/** Output from `devcontainer up` command */
export interface DevcontainerUpResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/** Devcontainer CLI availability info */
export interface DevcontainerCliInfo {
  available: true;
  version: string;
}

/** devcontainer up options */
export interface DevcontainerUpOptions {
  workspaceFolder: string;
  configPath?: string;
  initLogger: InitLogger;
  abortSignal?: AbortSignal;
  /** Additional bind mounts (formatted to CLI wire format when emitting --mount args) */
  additionalMounts?: BindMount[];
  /** Additional remote env vars */
  remoteEnv?: Record<string, string>;
  /** Timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;
}

const DEFAULT_UP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_STDERR_BUFFER_LENGTH = 8_000; // 8KB cap for error summaries
const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000; // 1 minute

async function removeDevcontainerContainer(containerId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn("docker", ["rm", "-f", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_CLEANUP_TIMEOUT_MS,
    });

    proc.on("error", () => {
      resolve();
    });

    proc.on("close", () => {
      resolve();
    });
  });
}
const VERSION_CHECK_TIMEOUT_MS = 10_000; // 10 seconds

const WINDOWS_LOOKUP_TIMEOUT_MS = 5_000;
const WINDOWS_LOOKUP_NEGATIVE_CACHE_MS = 30_000;
// CreateProcess can run these directly; Node >= 20.12 refuses .cmd/.bat
// without a shell (CVE-2024-27980), so those need the cmd.exe wrapper below.
const WINDOWS_DIRECT_EXECUTABLE_REGEXP = /\.(?:com|exe)$/i;
const WINDOWS_CMD_SHIM_REGEXP = /\.(?:cmd|bat)$/i;

/** Injectable seam so tests can exercise the win32/posix branches on any host. */
export interface DevcontainerSpawnDeps {
  platform: NodeJS.Platform;
  /** Bounded PATH lookup returning candidate lines (where.exe output), or null on failure. */
  lookupCommand: (command: string) => string[] | null;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /**
   * Successful win32 resolutions are cached for the process lifetime; misses
   * are cached for a bounded TTL so a missing CLI cannot block the main
   * process with a synchronous where.exe run on every availability check.
   */
  commandCache: { resolved?: string; missedAtMs?: number };
  now: () => number;
}

const defaultSpawnDeps: DevcontainerSpawnDeps = {
  platform: process.platform,
  lookupCommand: (command) => {
    try {
      const result = spawnSync("where.exe", [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: WINDOWS_LOOKUP_TIMEOUT_MS,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") {
        return null;
      }
      return result.stdout.split(/\r?\n/);
    } catch {
      return null;
    }
  },
  spawn,
  commandCache: {},
  now: Date.now,
};

// Vendored from cross-spawn@7.0.6 (MIT), based on https://qntm.org/cmd.
// cross-spawn itself only double-escapes for `node_modules\.bin\*.cmd` paths,
// which misses global npm shims (e.g. %APPDATA%\npm\devcontainer.cmd), so we
// apply its escape algorithm ourselves with double escaping always on.
const CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS_REGEXP, "^$1");
}

function escapeCmdShimArgument(arg: string): string {
  // Double up backslashes preceding a double quote (or the closing quote
  // added below), escape the quote itself, then quote the whole argument.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  // Escape cmd.exe metacharacters twice: once for the cmd.exe we spawn, and
  // once more because npm cmd-shims re-expand %* through a second cmd parse.
  arg = arg.replace(CMD_META_CHARS_REGEXP, "^$1");
  arg = arg.replace(CMD_META_CHARS_REGEXP, "^$1");
  return arg;
}

function resolveWindowsDevcontainerCommand(deps: DevcontainerSpawnDeps): string | null {
  if (deps.commandCache.resolved !== undefined) {
    return deps.commandCache.resolved;
  }
  if (
    deps.commandCache.missedAtMs !== undefined &&
    deps.now() - deps.commandCache.missedAtMs < WINDOWS_LOOKUP_NEGATIVE_CACHE_MS
  ) {
    return null;
  }
  // where.exe lists PATH-order candidates; npm also installs an extensionless
  // POSIX shim and a .ps1, neither of which CreateProcess can run, so pick the
  // first spawnable entry.
  const resolved =
    (deps.lookupCommand("devcontainer") ?? [])
      .map((line) => line.trim())
      .find(
        (line) => WINDOWS_DIRECT_EXECUTABLE_REGEXP.test(line) || WINDOWS_CMD_SHIM_REGEXP.test(line)
      ) ?? null;
  if (resolved !== null) {
    deps.commandCache.resolved = resolved;
    deps.commandCache.missedAtMs = undefined;
  } else {
    deps.commandCache.missedAtMs = deps.now();
  }
  return resolved;
}

/**
 * Terminate a spawned devcontainer process. On Windows the CLI runs beneath
 * the cmd.exe shim wrapper and ChildProcess.kill only signals the direct
 * child, so kill the full tree; on POSIX the CLI is the direct child and
 * keeps its graceful SIGTERM.
 */
export function terminateDevcontainerProc(
  proc: Pick<ChildProcess, "pid" | "kill">,
  deps: { platform: NodeJS.Platform; killTree: (pid: number) => void } = {
    platform: process.platform,
    killTree: killProcessTree,
  }
): void {
  if (deps.platform === "win32" && proc.pid !== undefined) {
    deps.killTree(proc.pid);
    return;
  }
  proc.kill("SIGTERM");
}

/**
 * Spawn the devcontainer CLI portably.
 *
 * On Windows, npm installs the CLI as `devcontainer.cmd`/`devcontainer.ps1`
 * shims. Node's spawn does not consult PATHEXT, so the bare name fails even
 * when the CLI is on PATH. We resolve the real entry via where.exe, spawn
 * .exe/.com directly, and wrap .cmd/.bat shims in `cmd.exe /d /s /c` with
 * fully escaped arguments instead of a blanket `shell: true` (the exec site
 * passes arbitrary `bash -c` payloads that cmd.exe would reinterpret).
 */
export function spawnDevcontainer(
  args: string[],
  options: SpawnOptions,
  deps: DevcontainerSpawnDeps = defaultSpawnDeps
): ChildProcess {
  if (deps.platform !== "win32") {
    return deps.spawn("devcontainer", args, options);
  }
  const resolved = resolveWindowsDevcontainerCommand(deps);
  if (resolved === null) {
    // Keep the status-quo failure surface: callers report the CLI as missing.
    return deps.spawn("devcontainer", args, options);
  }
  if (WINDOWS_CMD_SHIM_REGEXP.test(resolved)) {
    const shellCommand = [
      escapeCmdCommand(path.normalize(resolved)),
      ...args.map(escapeCmdShimArgument),
    ].join(" ");
    return deps.spawn(process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", `"${shellCommand}"`], {
      ...options,
      // The command line is pre-escaped; tell Node not to re-quote it.
      windowsVerbatimArguments: true,
    });
  }
  return deps.spawn(resolved, args, options);
}

/**
 * Check if devcontainer CLI is installed and get version.
 */
export async function checkDevcontainerCliVersion(): Promise<DevcontainerCliInfo | null> {
  return new Promise((resolve) => {
    // Explicit timer instead of the spawn-level timeout: Node's built-in kill
    // signals only the direct child (the cmd.exe wrapper on Windows), and a
    // surviving CLI descendant would hold the stdio pipes open so "close"
    // never fires. Settle immediately and force-close the pipes instead.
    const proc = spawnDevcontainer(["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const settle = (result: DevcontainerCliInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      terminateDevcontainerProc(proc);
      forceCloseStdio(proc);
      settle(null);
    }, VERSION_CHECK_TIMEOUT_MS);

    let stdout = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      settle(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        settle({ available: true, version: stdout.trim() });
      } else {
        settle(null);
      }
    });
  });
}

/**
 * Run `devcontainer up` with streaming logs.
 * Parses the JSON output to extract container info.
 */
export async function devcontainerUp(
  options: DevcontainerUpOptions
): Promise<DevcontainerUpResult> {
  const {
    workspaceFolder,
    configPath,
    initLogger,
    abortSignal,
    additionalMounts,
    remoteEnv,
    timeoutMs = DEFAULT_UP_TIMEOUT_MS,
  } = options;

  const baseArgs = ["up", "--log-format", "json", "--workspace-folder", workspaceFolder];

  if (configPath) {
    baseArgs.push("--config", configPath);
  }

  // Add mounts for credential sharing
  if (additionalMounts) {
    for (const mount of additionalMounts) {
      // Single formatting point — the devcontainer CLI only accepts type/source/target/external.
      baseArgs.push("--mount", `type=bind,source=${mount.source},target=${mount.target}`);
    }
  }

  // Add remote env vars
  if (remoteEnv) {
    for (const [key, value] of Object.entries(remoteEnv)) {
      baseArgs.push("--remote-env", `${key}=${value}`);
    }
  }

  const runUp = (args: string[]): Promise<DevcontainerUpResult> => {
    const logArgs = redactDevcontainerArgsForLog(args);
    initLogger.logStep(`Running: devcontainer ${logArgs.join(" ")}`);

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error("devcontainer up aborted"));
        return;
      }

      // Timeout is enforced by the explicit timer below, not the spawn-level
      // option: Node's built-in timeout signals only the direct child, which
      // on Windows is the cmd.exe wrapper rather than the CLI itself.
      const proc = spawnDevcontainer(args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: workspaceFolder,
      });

      let settled = false;
      let lastResultLine: DevcontainerUpResultLine | null = null;
      let stderrBuffer = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const settleSuccess = (result: DevcontainerUpResult) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      const appendStderrSummary = (text: string) => {
        if (stderrBuffer.length >= MAX_STDERR_BUFFER_LENGTH) return;
        const next = `${text}\n`;
        stderrBuffer = (stderrBuffer + next).slice(0, MAX_STDERR_BUFFER_LENGTH);
      };
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      };

      const stdoutLineBuffer = new LineBuffer((line) => {
        const parsed = parseDevcontainerStdoutLine(line);
        if (!parsed) return;
        if (parsed.kind === "result") {
          lastResultLine = parsed.result;
          return;
        }
        if (parsed.kind === "log") {
          initLogger.logStdout(parsed.text);
          return;
        }
        initLogger.logStdout(parsed.text);
      });

      const stderrLineBuffer = new LineBuffer((line) => {
        const parsed = parseDevcontainerStdoutLine(line);
        if (parsed?.kind === "result") {
          lastResultLine ??= parsed.result;
          return;
        }
        const summaryText = parsed ? parsed.text : line;
        appendStderrSummary(summaryText);
        if (!parsed) return;
        initLogger.logStdout(parsed.text);
      });

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutLineBuffer.append(data.toString());
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrLineBuffer.append(data.toString());
      });

      const abortHandler = () => {
        terminateDevcontainerProc(proc);
        settleError(new Error("devcontainer up aborted"));
      };

      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          terminateDevcontainerProc(proc);
          settleError(new Error(`devcontainer up timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      if (abortSignal?.aborted) {
        abortHandler();
      }

      const finalizeError = async (message: string, result?: DevcontainerUpResultLine | null) => {
        if (result && shouldCleanupDevcontainer(result)) {
          try {
            await removeDevcontainerContainer(result.containerId ?? "");
          } catch (cleanupError) {
            log.debug("Failed to remove devcontainer container", {
              cleanupError,
              containerId: result.containerId,
            });
          }
        }
        settleError(new Error(message));
      };

      proc.on("error", (err) => {
        abortSignal?.removeEventListener("abort", abortHandler);
        stdoutLineBuffer.flush();
        stderrLineBuffer.flush();
        settleError(new Error(`devcontainer up failed: ${getErrorMessage(err)}`));
      });

      proc.on("close", (code) => {
        const handleClose = async () => {
          abortSignal?.removeEventListener("abort", abortHandler);
          stdoutLineBuffer.flush();
          stderrLineBuffer.flush();

          if (settled) return;

          const stderrSummary = stderrBuffer.trim();

          if (lastResultLine) {
            if (lastResultLine.outcome === "success") {
              if (
                !lastResultLine.containerId ||
                !lastResultLine.remoteUser ||
                !lastResultLine.remoteWorkspaceFolder
              ) {
                await finalizeError(
                  "devcontainer up output missing required fields",
                  lastResultLine
                );
                return;
              }

              settleSuccess({
                containerId: lastResultLine.containerId,
                remoteUser: lastResultLine.remoteUser,
                remoteWorkspaceFolder: lastResultLine.remoteWorkspaceFolder,
              });
              return;
            }

            await finalizeError(
              formatDevcontainerUpError(lastResultLine, stderrSummary),
              lastResultLine
            );
            return;
          }

          if (code !== 0) {
            const suffix = stderrSummary.length > 0 ? `: ${stderrSummary}` : "";
            settleError(new Error(`devcontainer up exited with code ${String(code)}${suffix}`));
            return;
          }

          const suffix = stderrSummary.length > 0 ? `: ${stderrSummary}` : "";
          settleError(new Error(`devcontainer up did not produce result output${suffix}`));
        };

        void handleClose();
      });
    });
  };

  return runUp(baseArgs);
}

export type DevcontainerProbeResult =
  | { kind: "found"; containerId: string }
  | { kind: "absent" }
  | { kind: "error"; message: string };

export type DevcontainerStopResult =
  | { kind: "stopped" }
  | { kind: "absent" }
  | { kind: "error"; message: string };

export async function probeDevcontainerStatuses(
  workspacePaths: string[],
  timeoutMs = 10_000
): Promise<Record<string, DevcontainerProbeResult>> {
  const results: Record<string, DevcontainerProbeResult> = {};
  for (const workspacePath of workspacePaths) {
    results[workspacePath] = { kind: "absent" };
  }

  if (workspacePaths.length === 0) {
    return results;
  }

  const requestedPaths = new Set(workspacePaths);

  return await new Promise((resolve) => {
    const proc = spawn(
      "docker",
      [
        "ps",
        "--filter",
        "label=devcontainer.local_folder",
        "--format",
        '{{.ID}}\t{{.Label "devcontainer.local_folder"}}',
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const resolveAllError = (message: string) => {
      for (const workspacePath of workspacePaths) {
        results[workspacePath] = { kind: "error", message };
      }
      resolve(results);
    };

    proc.on("error", (error) => {
      resolveAllError(getErrorMessage(error));
    });

    proc.on("close", (code, signal) => {
      if (code !== 0) {
        const stderrMessage = stderr.trim();
        const exitMessage = signal
          ? `docker ps exited with signal ${signal}`
          : `docker ps exited with code ${code ?? "null"}`;
        resolveAllError(stderrMessage ? `${exitMessage}: ${stderrMessage}` : exitMessage);
        return;
      }

      for (const line of stdout.split("\n")) {
        const [containerId, workspacePath] = line.split("\t");
        if (!containerId || !workspacePath || !requestedPaths.has(workspacePath)) {
          continue;
        }
        results[workspacePath] = { kind: "found", containerId };
      }

      resolve(results);
    });
  });
}
/**
 * Get the container name for a devcontainer workspace.
 * Returns null if no container exists.
 *
 * Note: VS Code devcontainer deep links require the container NAME (not ID).
 * The devcontainer CLI only returns container ID, so we query Docker directly.
 */
export async function getDevcontainerContainerName(
  workspaceFolder: string,
  timeoutMs = 10_000
): Promise<string | null> {
  // The devcontainer CLI labels containers with the workspace folder path
  const labelValue = workspaceFolder;

  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "--format", "{{.Names}}", "--filter", `label=devcontainer.local_folder=${labelValue}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }
    );

    let stdout = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // Return first container name (there should only be one)
        resolve(stdout.trim().split("\n")[0]);
      } else {
        resolve(null);
      }
    });
  });
}

export async function stopDevcontainer(workspacePath: string): Promise<DevcontainerStopResult> {
  const labelValue = workspacePath;

  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "-q", "--filter", `label=devcontainer.local_folder=${labelValue}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      resolve({
        kind: "error",
        message: `Docker is not available: ${getErrorMessage(error)}`,
      });
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderrMessage = stderr.trim();
        resolve({
          kind: "error",
          message: `Failed to query containers: ${stderrMessage || `docker ps exited with code ${code ?? "null"}`}`,
        });
        return;
      }

      const containerId = stdout.trim().split("\n")[0];
      if (!containerId) {
        resolve({ kind: "absent" });
        return;
      }

      const removeProc = spawn("docker", ["rm", "-f", containerId], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_CLEANUP_TIMEOUT_MS,
      });

      let removeStderr = "";
      removeProc.stderr?.on("data", (data: Buffer) => {
        removeStderr += data.toString();
      });

      removeProc.on("error", (error) => {
        resolve({
          kind: "error",
          message: `Docker is not available: ${getErrorMessage(error)}`,
        });
      });

      removeProc.on("close", (removeCode) => {
        if (removeCode === 0) {
          resolve({ kind: "stopped" });
          return;
        }

        const stderrMessage = removeStderr.trim();
        resolve({
          kind: "error",
          message: `Failed to remove container: ${stderrMessage || `docker rm -f exited with code ${removeCode ?? "null"}`}`,
        });
      });
    });
  });
}

/**
 * Stop and remove the devcontainer (best-effort cleanup).
 * Does not throw on failure - container may not exist.
 *
 * Note: `devcontainer down` is not yet implemented in the CLI (as of v0.81.1),
 * so we use docker commands directly with the container label.
 */
export async function devcontainerDown(
  workspaceFolder: string,
  _configPath?: string,
  _timeoutMs = 60_000
): Promise<void> {
  await stopDevcontainer(workspaceFolder);
}
