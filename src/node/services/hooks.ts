/**
 * Runtime-backed project/user hooks for environment setup, policy, and validation.
 * A hook prints its unique XUM_EXEC marker to receive the tool result on stdin;
 * a non-zero exit reports failure to the model.
 */

import * as crypto from "crypto";
import * as path from "path";
import {
  listProjectMetadataRelativePaths,
  withLegacyMuxEnvironmentAliases,
} from "@/common/compat/legacyMux";
import { flattenToolHookValueToEnv } from "@/common/utils/tools/toolHookEnv";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { execBuffered, writeFileString } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";

const HOOK_FILENAME = "tool_hook";
const PRE_HOOK_FILENAME = "tool_pre";
const POST_HOOK_FILENAME = "tool_post";
const TOOL_ENV_FILENAME = "tool_env";
const TOOL_INPUT_ENV_LIMIT = 8_000;
const FLATTENED_TOOL_ENV_MAX_VARS = 200;
const FLATTENED_TOOL_ENV_MAX_ARRAY_LENGTH = 50;
const DEFAULT_HOOK_PHASE_TIMEOUT_MS = 10_000; // 10 seconds
const EXEC_MARKER_PREFIX = "MUX_EXEC_";
const HOOK_PATH_ENV = "XUM_INTERNAL_HOOK_PATH";

function buildHookCommand(): string {
  return `hook_path="$${HOOK_PATH_ENV}"; unset ${HOOK_PATH_ENV}; "$hook_path"`;
}

function getHookPathEnv(projectDir: string, hookPath: string): Record<string, string> {
  return {
    [HOOK_PATH_ENV]: hookPath,
    XUM_PROJECT_DIR: projectDir,
    MUX_PROJECT_DIR: projectDir,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}
// Exported for the composition inspector, which mirrors this module's hook
// resolution through the workspace runtime.
export function joinPathLike(basePath: string, ...parts: string[]): string {
  // For SSH runtimes (and most Unix paths), we want POSIX joins.
  // For Windows-style paths, use native joins.
  if (basePath.includes("\\") || /^[a-zA-Z]:/.test(basePath)) {
    return path.join(basePath, ...parts);
  }
  return path.posix.join(basePath, ...parts);
}

/**
 * User-global hooks/tool_env live in the runtime xum home, not a hardcoded ~/.mux.
 * Local `~/.xum` resolves through expandTilde → getXumHome(), so XUM_ROOT and a
 * leftover ~/.mux stay on one tree. Project-local files prefer `.xum/` and fall back to `.mux/`.
 */
async function getUserGlobalConfigPath(runtime: Runtime, filename: string): Promise<string | null> {
  try {
    const userHome = await runtime.resolvePath(runtime.getXumHome());
    const userPath = joinPathLike(userHome, filename);
    if (await isFile(runtime, userPath)) {
      return userPath;
    }
  } catch {
    // resolvePath failed - skip user-level file
  }
  return null;
}

async function getProjectOrGlobalConfigPath(
  runtime: Runtime,
  projectDir: string,
  filename: string
): Promise<string | null> {
  for (const relativePath of listProjectMetadataRelativePaths(filename)) {
    const projectPath = joinPathLike(projectDir, relativePath);
    if (await isFile(runtime, projectPath)) {
      return projectPath;
    }
  }
  return getUserGlobalConfigPath(runtime, filename);
}

function getToolInputValueForEnv(context: {
  toolInput: string;
  toolInputValue?: unknown;
}): unknown {
  if (context.toolInputValue !== undefined) {
    return context.toolInputValue;
  }

  try {
    return JSON.parse(context.toolInput) as unknown;
  } catch {
    return undefined;
  }
}

export interface HookContext {
  /** Tool name (e.g., "bash", "file_edit_replace_string") */
  tool: string;
  /** Tool input as JSON string */
  toolInput: string;
  /**
   * Tool input as a structured value (best-effort), used for flattened env vars.
   *
   * Optional for backwards compatibility; when omitted we'll attempt to parse
   * `toolInput` as JSON.
   */
  toolInputValue?: unknown;
  /** Workspace ID */
  workspaceId: string;
  /** Runtime temp dir for hook scratch files (paths in the runtime's context) */
  runtimeTempDir?: string;
  /** Project directory (cwd) */
  projectDir: string;
  /** Additional environment variables to pass to hook */
  env?: Record<string, string>;
  /** External abort signal (e.g., from workspace deletion) */
  abortSignal?: AbortSignal;
}

export interface HookResult {
  /** Whether the hook succeeded (exit code 0) */
  success: boolean;
  /** Stdout output from hook before the __MUX_EXEC__ marker */
  stdoutBeforeExec: string;
  /** Stdout output from hook (after __MUX_EXEC__ marker) */
  stdout: string;
  /** Stderr output from hook */
  stderr: string;
  /** Hook process exit code */
  exitCode: number;
  /** Whether the tool was executed (hook printed __MUX_EXEC__) */
  toolExecuted: boolean;
}

/**
 * Find the tool_hook executable for a given project directory.
 * Uses runtime abstraction so it works for both local and SSH workspaces.
 * Returns null if no hook exists.
 *
 * Note: We don't check execute permissions via runtime since FileStat doesn't
 * expose mode bits. The hook will fail at execution time if not executable.
 */
export async function getHookPath(runtime: Runtime, projectDir: string): Promise<string | null> {
  return getProjectOrGlobalConfigPath(runtime, projectDir, HOOK_FILENAME);
}

/**
 * Find the tool_env file for a given project directory.
 * This file is sourced before bash tool scripts to set up environment.
 * Returns null if no tool_env exists.
 */
export async function getToolEnvPath(runtime: Runtime, projectDir: string): Promise<string | null> {
  return getProjectOrGlobalConfigPath(runtime, projectDir, TOOL_ENV_FILENAME);
}

/**
 * Find the tool_pre executable for a given project directory.
 * This hook runs before tool execution; exit non-zero to block.
 * Returns null if no tool_pre exists.
 */
export async function getPreHookPath(runtime: Runtime, projectDir: string): Promise<string | null> {
  return getProjectOrGlobalConfigPath(runtime, projectDir, PRE_HOOK_FILENAME);
}

/**
 * Find the tool_post executable for a given project directory.
 * This hook runs after tool execution with result available.
 * Returns null if no tool_post exists.
 */
export async function getPostHookPath(
  runtime: Runtime,
  projectDir: string
): Promise<string | null> {
  return getProjectOrGlobalConfigPath(runtime, projectDir, POST_HOOK_FILENAME);
}

// When probing hook files over SSH, avoid hanging on dead connections.
// Hook discovery is best-effort; a short timeout keeps tool execution responsive.
const HOOK_FILE_STAT_TIMEOUT_MS = 2000;

async function isFile(runtime: Runtime, filePath: string): Promise<boolean> {
  try {
    const stat = await runtime.stat(filePath, AbortSignal.timeout(HOOK_FILE_STAT_TIMEOUT_MS));
    return !stat.isDirectory;
  } catch {
    return false;
  }
}

/** Options for hook timing warnings */
export interface HookTimingOptions {
  /** Threshold in ms before warning about slow hooks (default: 10000) */
  slowThresholdMs?: number;
  /** Maximum time allowed for hook pre-logic (until __MUX_EXEC__). Defaults to 10 seconds. */
  preHookTimeoutMs?: number;
  /** Maximum time allowed for hook post-logic (after tool result is sent). Defaults to 10 seconds. */
  postHookTimeoutMs?: number;
  /** Callback when hook phase exceeds threshold */
  onSlowHook?: (phase: "pre" | "post", elapsedMs: number) => void;
}

/**
 * Execute a tool with hook wrapping.
 * Uses runtime.exec() so hooks work for both local and SSH workspaces.
 *
 * @param runtime Runtime to execute the hook in
 * @param hookPath Path to the hook executable
 * @param context Hook context with tool info
 * @param executeTool Callback to execute the actual tool (called when hook signals __XUM_EXEC__)
 * @param timingOptions Optional timing/warning configuration
 * @returns Hook result with success status and any stderr output
 */
export async function runWithHook<T>(
  runtime: Runtime,
  hookPath: string,
  context: HookContext,
  executeTool: () => Promise<T | AsyncIterable<T>>,
  timingOptions?: HookTimingOptions
): Promise<{ result: T | AsyncIterable<T> | undefined; hook: HookResult }> {
  const slowThresholdMs = timingOptions?.slowThresholdMs ?? 10000;
  const onSlowHook = timingOptions?.onSlowHook;
  const preHookTimeoutMs = timingOptions?.preHookTimeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;
  const postHookTimeoutMs = timingOptions?.postHookTimeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;
  const hookStartTime = Date.now();

  // Generate a unique marker for this invocation to prevent accidental triggers
  const execMarker = `${EXEC_MARKER_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;

  let toolInputPath: string | undefined;
  let toolInputEnv = context.toolInput;
  if (context.toolInput.length > TOOL_INPUT_ENV_LIMIT) {
    // Tool input can be massive (file_edit_* old/new strings) and can exceed limits
    // when injected as env vars (especially over SSH, where env is embedded into a
    // single bash -c command string). Prefer writing the full JSON to a temp file.
    try {
      const tempDir = context.runtimeTempDir ?? "/tmp";
      toolInputPath = joinPathLike(
        tempDir,
        `xum-tool-input-${Date.now()}-${crypto.randomUUID()}.json`
      );
      await writeFileString(runtime, toolInputPath, context.toolInput);
      toolInputEnv = "__MUX_TOOL_INPUT_FILE__";
    } catch (err) {
      log.debug("[hooks] Failed to write tool input to temp file; falling back to truncation", {
        error: err,
      });
      toolInputPath = undefined;
      toolInputEnv = context.toolInput.slice(0, TOOL_INPUT_ENV_LIMIT);
    }
  }

  const toolInputValueForEnv = getToolInputValueForEnv(context);

  const canonicalHookEnv: Record<string, string> = {
    ...(context.env ?? {}),
    XUM_TOOL: context.tool,
    ...flattenToolHookValueToEnv(toolInputValueForEnv, "XUM_TOOL_INPUT", {
      maxValueLength: TOOL_INPUT_ENV_LIMIT,
      maxVars: FLATTENED_TOOL_ENV_MAX_VARS,
      maxArrayLength: FLATTENED_TOOL_ENV_MAX_ARRAY_LENGTH,
    }),
    // Ensure the base JSON env var cannot be overwritten by flattened fields.
    XUM_TOOL_INPUT: toolInputEnv,
    XUM_WORKSPACE_ID: context.workspaceId,
    XUM_EXEC: execMarker,
  };
  if (toolInputPath) {
    canonicalHookEnv.XUM_TOOL_INPUT_PATH = toolInputPath;
  }
  const hookEnv = withLegacyMuxEnvironmentAliases(canonicalHookEnv);

  const abortController = new AbortController();
  let timeoutPhase: "pre" | "post" | "external" | undefined;
  let preTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let postTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Forward external abort signal (e.g., workspace deletion)
  if (context.abortSignal) {
    if (context.abortSignal.aborted) {
      timeoutPhase = "external";
      abortController.abort();
    } else {
      context.abortSignal.addEventListener(
        "abort",
        () => {
          timeoutPhase = "external";
          abortController.abort();
        },
        { once: true }
      );
    }
  }

  if (preHookTimeoutMs > 0) {
    preTimeoutHandle = setTimeout(() => {
      timeoutPhase = "pre";
      abortController.abort();
    }, preHookTimeoutMs);
  }

  let stream;
  try {
    stream = await runtime.exec(buildHookCommand(), {
      cwd: context.projectDir,
      env: hookEnv,
      pathEnv: getHookPathEnv(context.projectDir, hookPath),
      abortSignal: abortController.signal,
    });
  } catch (err) {
    if (preTimeoutHandle) {
      clearTimeout(preTimeoutHandle);
      preTimeoutHandle = undefined;
    }
    log.error("[hooks] Failed to spawn hook", { hookPath, error: err });
    if (toolInputPath) {
      try {
        await execBuffered(runtime, `rm -f ${shellQuote(toolInputPath)}`, {
          cwd: context.projectDir,
          timeout: 5,
        });
      } catch {
        // Best-effort cleanup
      }
    }
    return {
      result: undefined,
      hook: {
        success: false,
        stdoutBeforeExec: "",
        stdout: "",
        stderr: `Failed to execute hook: ${getErrorMessage(err)}`,
        exitCode: -1,
        toolExecuted: false,
      },
    };
  }

  let toolResult: T | AsyncIterable<T> | undefined;
  let toolError: Error | undefined;
  let hookStdinWriteError: Error | undefined;
  let toolExecuted = false;
  let toolResultSentTime: number | undefined;
  let stderrOutput = "";
  let stdoutBuffer = "";
  let stdoutBeforeExec = "";
  let stdoutAfterMarker = "";
  let toolPromise: Promise<void> | undefined;

  // Read stderr in background
  const stderrReader = stream.stderr.getReader();
  const stderrPromise = (async () => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrOutput += decoder.decode(value, { stream: true });
      }
    } catch {
      // Ignore stream errors (e.g. abort)
    } finally {
      stderrReader.releaseLock();
    }
  })();

  // Read stdout, watching for __XUM_EXEC__ marker
  const stdoutReader = stream.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      if (toolExecuted) {
        // After marker: capture for hook output
        stdoutAfterMarker += chunk;
        continue;
      }

      stdoutBuffer += chunk;

      const markerIdx = stdoutBuffer.indexOf(execMarker);
      if (markerIdx === -1) {
        continue;
      }

      // Marker detected: allow tool execution.
      // Stop the pre-hook timeout clock and start the tool.
      if (preTimeoutHandle) {
        clearTimeout(preTimeoutHandle);
        preTimeoutHandle = undefined;
      }

      // Check pre-hook timing before marking as executed
      const preHookElapsed = Date.now() - hookStartTime;
      if (onSlowHook && preHookElapsed > slowThresholdMs) {
        onSlowHook("pre", preHookElapsed);
      }

      toolExecuted = true;
      stdoutBeforeExec = stdoutBuffer.slice(0, markerIdx);
      stdoutAfterMarker = stdoutBuffer.slice(markerIdx + execMarker.length);

      // Execute tool + send result to hook stdin in the background so we can
      // continue draining stdout (hooks may log after __XUM_EXEC__).
      toolPromise = (async () => {
        try {
          try {
            toolResult = await executeTool();
          } catch (err) {
            toolError = err instanceof Error ? err : new Error(String(err));
          }

          const payload = toolError ? { error: toolError.message } : toolResult;
          const payloadForHook = isAsyncIterable(payload) ? { streaming: true } : payload;

          const writer = stream.stdin.getWriter();
          try {
            await writer.write(new TextEncoder().encode(JSON.stringify(payloadForHook) + "\n"));
          } catch (err) {
            hookStdinWriteError = err instanceof Error ? err : new Error(String(err));
          } finally {
            try {
              await writer.close();
            } catch {
              // Ignore close errors (e.g. EPIPE if hook exited)
            }
            toolResultSentTime = Date.now();

            if (postHookTimeoutMs > 0) {
              postTimeoutHandle = setTimeout(() => {
                timeoutPhase = "post";
                abortController.abort();
              }, postHookTimeoutMs);
            }
          }
        } catch (err) {
          // This should never throw, but guard to avoid unhandled rejections.
          hookStdinWriteError = err instanceof Error ? err : new Error(String(err));
        }
      })();
    }
  } catch {
    // Ignore stream errors (e.g. abort)
  } finally {
    stdoutReader.releaseLock();
  }

  // If hook exited before __XUM_EXEC__, close stdin
  if (!toolExecuted) {
    // Cancel the pre-hook timeout.
    if (preTimeoutHandle) {
      clearTimeout(preTimeoutHandle);
      preTimeoutHandle = undefined;
    }
    const writer = stream.stdin.getWriter();
    try {
      await writer.close();
    } catch {
      // Ignore close errors (e.g. hook already exited)
    }
  }

  // Wait for tool execution (if started), stderr collection, and exit code
  await toolPromise;
  await stderrPromise;
  const exitCode = await stream.exitCode;

  if (postTimeoutHandle) {
    clearTimeout(postTimeoutHandle);
    postTimeoutHandle = undefined;
  }

  // Check post-hook timing (time from result sent to hook exit)
  if (onSlowHook && toolResultSentTime) {
    const postHookElapsed = Date.now() - toolResultSentTime;
    if (postHookElapsed > slowThresholdMs) {
      onSlowHook("post", postHookElapsed);
    }
  }

  if (timeoutPhase === "pre") {
    stderrOutput += `\nHook timed out before $MUX_EXEC marker (${preHookTimeoutMs}ms)`;
  } else if (timeoutPhase === "post") {
    stderrOutput += `\nHook timed out after tool result was sent (${postHookTimeoutMs}ms)`;
  } else if (timeoutPhase === "external") {
    stderrOutput += `\nHook aborted (workspace deleted or request cancelled)`;
  }
  if (hookStdinWriteError) {
    stderrOutput += `\nFailed to write tool result to hook stdin: ${hookStdinWriteError.message}`;
  }

  if (toolInputPath) {
    try {
      await execBuffered(runtime, `rm -f ${shellQuote(toolInputPath)}`, {
        cwd: context.projectDir,
        timeout: 5,
      });
    } catch {
      // Best-effort cleanup
    }
  }

  // If tool threw an error, rethrow it after hook completes
  // This ensures tool failures propagate even when hooks are present
  if (toolError) {
    throw toolError;
  }

  return {
    result: toolResult,
    hook: {
      success: exitCode === 0,
      stdoutBeforeExec: (toolExecuted ? stdoutBeforeExec : stdoutBuffer).trim(),
      stdout: stdoutAfterMarker.trim(),
      stderr: stderrOutput.trim(),
      exitCode,
      toolExecuted,
    },
  };
}

/** Result from running a pre-hook */
export interface PreHookResult {
  /** Whether the tool is allowed to proceed (exit code 0) */
  allowed: boolean;
  /** Combined stdout + stderr output */
  output: string;
  /** Hook process exit code */
  exitCode: number;
}

/** Result from running a post-hook */
export interface PostHookResult {
  /** Whether the hook succeeded (exit code 0) */
  success: boolean;
  /** Combined stdout + stderr output */
  output: string;
  /** Hook process exit code */
  exitCode: number;
}

/** Context for pre/post hooks (simpler than HookContext) */
export interface SimpleHookContext {
  /** Tool name */
  tool: string;
  /** Tool input as JSON string */
  toolInput: string;
  /**
   * Tool input as a structured value (best-effort), used for flattened env vars.
   *
   * Optional for backwards compatibility; when omitted we'll attempt to parse
   * `toolInput` as JSON.
   */
  toolInputValue?: unknown;
  /** Workspace ID */
  workspaceId: string;
  /** Project directory */
  projectDir: string;
  /** Runtime temp dir for scratch files */
  runtimeTempDir?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** External abort signal */
  abortSignal?: AbortSignal;
}

/** Options for pre/post hook execution */
export interface SimpleHookOptions {
  /** Timeout in ms (default: 5 minutes) */
  timeoutMs?: number;
}

/**
 * Run a pre-hook (tool_pre) before tool execution.
 * Simple model: spawn hook, wait for exit, check exit code.
 * Exit 0 = allow tool, non-zero = block tool.
 */
export async function runPreHook(
  runtime: Runtime,
  hookPath: string,
  context: SimpleHookContext,
  options?: SimpleHookOptions
): Promise<PreHookResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;

  // Prepare tool input (file if large)
  const { toolInputEnv, toolInputPath, cleanup } = await prepareToolInput(
    runtime,
    context.toolInput,
    context.runtimeTempDir,
    context.projectDir
  );

  const toolInputValueForEnv = getToolInputValueForEnv(context);

  const canonicalHookEnv: Record<string, string> = {
    ...(context.env ?? {}),
    XUM_TOOL: context.tool,
    ...flattenToolHookValueToEnv(toolInputValueForEnv, "XUM_TOOL_INPUT", {
      maxValueLength: TOOL_INPUT_ENV_LIMIT,
      maxVars: FLATTENED_TOOL_ENV_MAX_VARS,
      maxArrayLength: FLATTENED_TOOL_ENV_MAX_ARRAY_LENGTH,
    }),
    // Ensure the base JSON env var cannot be overwritten by flattened fields.
    XUM_TOOL_INPUT: toolInputEnv,
    XUM_WORKSPACE_ID: context.workspaceId,
  };
  if (toolInputPath) {
    canonicalHookEnv.XUM_TOOL_INPUT_PATH = toolInputPath;
  }
  const hookEnv = withLegacyMuxEnvironmentAliases(canonicalHookEnv);

  try {
    const result = await execBuffered(runtime, buildHookCommand(), {
      cwd: context.projectDir,
      env: hookEnv,
      pathEnv: getHookPathEnv(context.projectDir, hookPath),
      timeout: Math.ceil(timeoutMs / 1000),
      abortSignal: context.abortSignal,
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      allowed: result.exitCode === 0,
      output,
      exitCode: result.exitCode ?? -1,
    };
  } catch (err) {
    log.error("[hooks] Pre-hook execution failed", { hookPath, error: err });
    return {
      allowed: false,
      output: `Pre-hook failed: ${getErrorMessage(err)}`,
      exitCode: -1,
    };
  } finally {
    await cleanup();
  }
}

/**
 * Run a post-hook (tool_post) after tool execution.
 * Simple model: spawn hook with result in env/file, wait for exit.
 */
export async function runPostHook(
  runtime: Runtime,
  hookPath: string,
  context: SimpleHookContext,
  toolResult: unknown,
  options?: SimpleHookOptions
): Promise<PostHookResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_PHASE_TIMEOUT_MS;
  const resultJson = JSON.stringify(toolResult);

  // Prepare tool input (file if large)
  const {
    toolInputEnv,
    toolInputPath,
    cleanup: cleanupInput,
  } = await prepareToolInput(
    runtime,
    context.toolInput,
    context.runtimeTempDir,
    context.projectDir
  );

  // Prepare tool result (best-effort file; env var placeholder if large)
  const resultPath = joinPathLike(
    context.runtimeTempDir ?? "/tmp",
    `xum-tool-result-${Date.now()}-${crypto.randomUUID()}.json`
  );
  let resultPathForEnv: string | undefined;
  let resultEnv = resultJson;
  try {
    await writeFileString(runtime, resultPath, resultJson);
    resultPathForEnv = resultPath;
    if (resultJson.length > TOOL_INPUT_ENV_LIMIT) {
      resultEnv = "__MUX_TOOL_RESULT_FILE__";
    }
  } catch (err) {
    log.debug("[hooks] Failed to write tool result to temp file", { error: err });
    resultPathForEnv = undefined;
    resultEnv = resultJson.slice(0, TOOL_INPUT_ENV_LIMIT);
  }

  const toolInputValueForEnv = getToolInputValueForEnv(context);

  const canonicalHookEnv: Record<string, string> = {
    ...(context.env ?? {}),
    XUM_TOOL: context.tool,
    ...flattenToolHookValueToEnv(toolInputValueForEnv, "XUM_TOOL_INPUT", {
      maxValueLength: TOOL_INPUT_ENV_LIMIT,
      maxVars: FLATTENED_TOOL_ENV_MAX_VARS,
      maxArrayLength: FLATTENED_TOOL_ENV_MAX_ARRAY_LENGTH,
    }),
    ...flattenToolHookValueToEnv(toolResult, "XUM_TOOL_RESULT", {
      maxValueLength: TOOL_INPUT_ENV_LIMIT,
      maxVars: FLATTENED_TOOL_ENV_MAX_VARS,
      maxArrayLength: FLATTENED_TOOL_ENV_MAX_ARRAY_LENGTH,
    }),
    // Ensure base JSON env vars cannot be overwritten by flattened fields.
    XUM_TOOL_INPUT: toolInputEnv,
    XUM_WORKSPACE_ID: context.workspaceId,
    XUM_TOOL_RESULT: resultEnv,
  };
  if (toolInputPath) {
    canonicalHookEnv.XUM_TOOL_INPUT_PATH = toolInputPath;
  }
  if (resultPathForEnv) {
    canonicalHookEnv.XUM_TOOL_RESULT_PATH = resultPathForEnv;
  }
  const hookEnv = withLegacyMuxEnvironmentAliases(canonicalHookEnv);

  const cleanup = async () => {
    await cleanupInput();
    if (!resultPathForEnv) return;

    try {
      await execBuffered(runtime, `rm -f ${shellQuote(resultPathForEnv)}`, {
        cwd: context.projectDir,
        timeout: 5,
      });
    } catch {
      // Best-effort
    }
  };

  try {
    const result = await execBuffered(runtime, buildHookCommand(), {
      cwd: context.projectDir,
      env: hookEnv,
      pathEnv: getHookPathEnv(context.projectDir, hookPath),
      timeout: Math.ceil(timeoutMs / 1000),
      abortSignal: context.abortSignal,
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      success: result.exitCode === 0,
      output,
      exitCode: result.exitCode ?? -1,
    };
  } catch (err) {
    log.error("[hooks] Post-hook execution failed", { hookPath, error: err });
    return {
      success: false,
      output: `Post-hook failed: ${getErrorMessage(err)}`,
      exitCode: -1,
    };
  } finally {
    await cleanup();
  }
}

/** Helper to prepare tool input (write to file if large) */
async function prepareToolInput(
  runtime: Runtime,
  toolInput: string,
  runtimeTempDir: string | undefined,
  projectDir: string
): Promise<{
  toolInputEnv: string;
  toolInputPath: string | undefined;
  cleanup: () => Promise<void>;
}> {
  let toolInputPath: string | undefined;
  let toolInputEnv = toolInput;

  if (toolInput.length > TOOL_INPUT_ENV_LIMIT) {
    try {
      const tempDir = runtimeTempDir ?? "/tmp";
      toolInputPath = joinPathLike(
        tempDir,
        `xum-tool-input-${Date.now()}-${crypto.randomUUID()}.json`
      );
      await writeFileString(runtime, toolInputPath, toolInput);
      toolInputEnv = "__MUX_TOOL_INPUT_FILE__";
    } catch (err) {
      log.debug("[hooks] Failed to write tool input to temp file", { error: err });
      toolInputPath = undefined;
      toolInputEnv = toolInput.slice(0, TOOL_INPUT_ENV_LIMIT);
    }
  }

  const cleanup = async () => {
    if (toolInputPath) {
      try {
        await execBuffered(runtime, `rm -f ${shellQuote(toolInputPath)}`, {
          cwd: projectDir,
          timeout: 5,
        });
      } catch {
        // Best-effort
      }
    }
  };

  return { toolInputEnv, toolInputPath, cleanup };
}
