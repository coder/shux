import type {
  ExecOptions,
  ExecStream,
  InitLogger,
  Runtime,
  WorkspaceInitParams,
  WorkspaceInitResult,
} from "./Runtime";
import { shellQuote } from "@/common/utils/shell";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  isWorktreeRuntime,
  isSSHRuntime,
  isDockerRuntime,
  isDevcontainerRuntime,
  type RuntimeConfig,
  type RuntimeMode,
} from "@/common/types/runtime";

import {
  listProjectMetadataRelativePaths,
  withLegacyMuxEnvironmentAliases,
} from "@/common/compat/legacyMux";
import { log } from "@/node/services/log";
import type { ThinkingLevel } from "@/common/types/thinking";
import { assert } from "@/common/utils/assert";
import {
  DISABLE_PROJECT_AUTOMATION_ENV,
  projectAutomationDisabled,
} from "@/node/utils/projectAutomation";

/**
 * Check whether the init hook should be skipped and log the reason.
 * Returns true if the hook should be skipped (caller should return early).
 *
 * Centralized here so all runtimes share the same gating logic:
 * - skipInitHook: explicitly disabled (e.g., fork operations)
 * - !trusted: project not trusted (repo-controlled code must not run)
 */
export function shouldSkipInitHook(
  params: { skipInitHook?: boolean; trusted?: boolean },
  initLogger: InitLogger
): boolean {
  if (params.skipInitHook) {
    initLogger.logStep("Skipping .xum/init hook (disabled for this task)");
    return true;
  }
  if (!params.trusted) {
    log.debug(
      "Skipping .xum/init hook (project not trusted — should not reach here in normal flow)"
    );
    initLogger.logStep("Skipping .xum/init hook (project not trusted)");
    return true;
  }
  if (projectAutomationDisabled()) {
    initLogger.logStep(`Skipping .xum/init hook (${DISABLE_PROJECT_AUTOMATION_ENV}=1)`);
    return true;
  }
  return false;
}

/** Resolve the preferred executable init hook inside the target checkout. */
export async function findInitHookRelativePath(
  runtime: Runtime,
  workspacePath: string
): Promise<string | null> {
  for (const relativePath of listProjectMetadataRelativePaths("init")) {
    const probe = await execBuffered(runtime, `test -x ${shellQuote(relativePath)}`, {
      cwd: workspacePath,
      timeout: 5,
    });
    if (probe.exitCode === 0) return relativePath;
  }
  return null;
}

/**
 * Get canonical XUM_ environment variables for bash execution, plus MUX_ aliases
 * so existing repository hooks continue to work after upgrade and downgrade.
 */
export function getXumEnv(
  projectPath: string,
  runtime: RuntimeMode,
  workspaceName: string,
  options?: {
    modelString?: string;
    thinkingLevel?: ThinkingLevel;
    /** Cumulative session costs in USD (if available) */
    costsUsd?: number;
    workspaceId?: string;
  }
): Record<string, string> {
  if (!projectPath) {
    throw new Error("getXumEnv: projectPath is required");
  }
  if (!workspaceName) {
    throw new Error("getXumEnv: workspaceName is required");
  }

  const env: Record<string, string> = {
    XUM_PROJECT_PATH: projectPath,
    XUM_RUNTIME: runtime,
    XUM_WORKSPACE_NAME: workspaceName,
  };

  if (options?.workspaceId != null) {
    assert(options.workspaceId.trim().length > 0, "workspaceId must not be empty");
    env.XUM_WORKSPACE_ID = options.workspaceId;
  }

  if (options?.modelString) {
    env.XUM_MODEL_STRING = options.modelString;
  }

  if (options?.thinkingLevel !== undefined) {
    env.XUM_THINKING_LEVEL = options.thinkingLevel;
  }

  if (options?.costsUsd !== undefined) {
    env.XUM_COSTS_USD = options.costsUsd.toFixed(2);
  }

  return withLegacyMuxEnvironmentAliases(env);
}

/**
 * Get the effective runtime type from a RuntimeConfig.
 * Handles legacy "local" with srcBaseDir → "worktree" mapping.
 */
export function getRuntimeType(config: RuntimeConfig | undefined): RuntimeMode {
  if (!config) return "worktree"; // Default to worktree for undefined config
  if (isSSHRuntime(config)) return "ssh";
  if (isDockerRuntime(config)) return "docker";
  if (isDevcontainerRuntime(config)) return "devcontainer";
  if (isWorktreeRuntime(config)) return "worktree";
  return "local";
}

/**
 * Line-buffered logger that splits stream output into lines and logs them
 * Handles incomplete lines by buffering until a newline is received
 */
export class LineBuffer {
  private buffer = "";
  private readonly logLine: (line: string) => void;

  constructor(logLine: (line: string) => void) {
    this.logLine = logLine;
  }

  /**
   * Process a chunk of data, splitting on newlines and logging complete lines
   */
  append(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // Keep last incomplete line
    for (const line of lines) {
      if (line) this.logLine(line);
    }
  }

  /**
   * Flush any remaining buffered data (called when stream closes)
   */
  flush(): void {
    if (this.buffer) {
      this.logLine(this.buffer);
      this.buffer = "";
    }
  }
}

/**
 * Create line-buffered loggers for stdout and stderr
 * Returns an object with append and flush methods for each stream
 */
export function createLineBufferedLoggers(initLogger: InitLogger) {
  const stdoutBuffer = new LineBuffer((line) => initLogger.logStdout(line));
  const stderrBuffer = new LineBuffer((line) => initLogger.logStderr(line));

  return {
    stdout: {
      append: (data: string) => stdoutBuffer.append(data),
      flush: () => stdoutBuffer.flush(),
    },
    stderr: {
      append: (data: string) => stderrBuffer.append(data),
      flush: () => stderrBuffer.flush(),
    },
  };
}

/**
 * Minimal runtime interface needed for running init hooks.
 * This allows the helper to work with any runtime implementation.
 */
export interface InitHookRuntime {
  exec(command: string, options: ExecOptions): Promise<ExecStream>;
}

export interface WorkspaceInitHookOptions {
  params: WorkspaceInitParams;
  runtimeType: RuntimeMode;
  findHookRelativePath: () => Promise<string | null>;
  beforeHook?: () => Promise<void>;
  runHook: (args: {
    hookRelativePath: string;
    xumEnv: Record<string, string>;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
  }) => Promise<void>;
}

/**
 * Shared initWorkspace flow for runtimes whose init phase is "optional .xum/init hook"
 * plus any runtime-specific preparation that must happen before hook gating.
 */
export async function runWorkspaceInitHook(
  options: WorkspaceInitHookOptions
): Promise<WorkspaceInitResult> {
  const { params, runtimeType, findHookRelativePath, beforeHook, runHook } = options;
  const { projectPath, branchName, initLogger, abortSignal, env } = params;

  try {
    // skipInitHook only disables repo-controlled hook execution; provisioning/materialization
    // that makes the workspace usable still belongs in beforeHook().
    await beforeHook?.();

    if (shouldSkipInitHook(params, initLogger)) {
      initLogger.logComplete(0);
      return { success: true };
    }

    const hookRelativePath = await findHookRelativePath();
    if (hookRelativePath == null) {
      initLogger.logComplete(0);
      return { success: true };
    }

    initLogger.enterHookPhase?.();
    const xumEnv = { ...env, ...getXumEnv(projectPath, runtimeType, branchName) };
    await runHook({ hookRelativePath, xumEnv, initLogger, abortSignal });
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    initLogger.logStderr(`Initialization failed: ${errorMsg}`);
    initLogger.logComplete(-1);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Run .xum/init hook on a runtime and stream output to logger.
 * Shared implementation used by SSH and Docker runtimes.
 *
 * @param runtime - Runtime instance with exec capability
 * @param hookPath - Full path to the init hook (e.g., "/src/.xum/init" or "~/mux/project/workspace/.xum/init")
 * @param workspacePath - Working directory for the hook
 * @param xumEnv - Canonical XUM_ variables plus legacy MUX_ aliases
 * @param initLogger - Logger for streaming output
 * @param abortSignal - Optional abort signal
 */
export async function runInitHookOnRuntime(
  runtime: InitHookRuntime,
  hookPath: string,
  workspacePath: string,
  xumEnv: Record<string, string>,
  initLogger: InitLogger,
  abortSignal?: AbortSignal
): Promise<void> {
  initLogger.logStep(`Running init hook: ${hookPath}`);

  const hookStream = await runtime.exec(hookPath, {
    cwd: workspacePath,
    timeout: 3600, // 1 hour - generous timeout for init hooks
    abortSignal,
    // When init is cancellable (archive/remove), we want abort to actually stop the remote hook.
    // With OpenSSH, allocating a PTY ensures the remote process is tied to the session and
    // receives a hangup when the client disconnects.
    forcePTY: abortSignal !== undefined,
    env: xumEnv,
  });

  // Create line-buffered loggers for proper output handling
  const loggers = createLineBufferedLoggers(initLogger);
  const stdoutReader = hookStream.stdout.getReader();
  const stderrReader = hookStream.stderr.getReader();
  const decoder = new TextDecoder();

  // Read stdout in parallel
  const readStdout = async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        loggers.stdout.append(decoder.decode(value, { stream: true }));
      }
      loggers.stdout.flush();
    } finally {
      stdoutReader.releaseLock();
    }
  };

  // Read stderr in parallel
  const readStderr = async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        loggers.stderr.append(decoder.decode(value, { stream: true }));
      }
      loggers.stderr.flush();
    } finally {
      stderrReader.releaseLock();
    }
  };

  // Wait for all streams and exit code
  const [exitCode] = await Promise.all([hookStream.exitCode, readStdout(), readStderr()]);

  // Log completion with exit code - hook failures are non-fatal per docs/hooks/init.mdx
  // ("failures are logged but don't prevent workspace usage")
  initLogger.logComplete(exitCode);
}
