/**
 * Higher-order function that wraps a tool with hook support.
 *
 * Tool execution runs through the event spine's `tool.execute` waterfall
 * (see src/node/services/events/eventSpine.ts). The shell hook protocol lives
 * in `shellToolHookMiddleware`, registered as the built-in middleware on that
 * point, so future consumers (plugin hooks, turn-envelope emission) compose
 * around the same pipeline.
 *
 * Hook priority (new → legacy):
 * - Pre-execution: tool_pre → tool_hook (if no tool_pre)
 * - Post-execution: tool_post → tool_hook (only if tool_hook was used for pre)
 *
 * New model (tool_pre/tool_post):
 * - tool_pre: runs before tool, exit 0 = allow, non-zero = block
 * - tool_post: runs after tool with result in MUX_TOOL_RESULT/MUX_TOOL_RESULT_PATH
 *
 * Legacy model (tool_hook): single hook with marker protocol (echo $MUX_EXEC)
 */

import assert from "node:assert";
import type { Tool } from "ai";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import type { Runtime } from "@/node/runtime/Runtime";
import type { WithHookOutput, MayHaveHookOutput } from "@/common/types/tools";
import {
  getHookPath,
  getPreHookPath,
  getPostHookPath,
  runWithHook,
  runPreHook,
  runPostHook,
} from "@/node/services/hooks";
import {
  eventSpine,
  type ToolExecuteContext,
  type WaterfallNext,
} from "@/node/services/events/eventSpine";
import { log } from "@/node/services/log";

export interface HookConfig {
  /** Runtime for hook execution (local or SSH) */
  runtime: Runtime;
  /** Runtime temp dir for hook scratch files (paths in the runtime's context) */
  runtimeTempDir: string;
  /** Working directory where hooks are discovered */
  cwd: string;
  /** Workspace ID for hook context */
  workspaceId: string;
  /** Additional environment variables to pass to hooks */
  env?: Record<string, string>;
}

/**
 * Derive the hook config every hook-wrapped tool runs with, or null when
 * hooks must not run. Host-side reads (mux.load and intuition) share this
 * trust gate with public tools: repo-controlled hooks run only for trusted projects.
 */
export function deriveToolHookConfig(config: ToolConfiguration): HookConfig | null {
  // Skip hooks for untrusted projects — repo-controlled scripts must not run
  if (config.trusted !== true) {
    return null;
  }

  // Hooks require workspaceId, cwd, and runtime
  if (!config.workspaceId || !config.cwd || !config.runtime) {
    return null;
  }

  return {
    runtime: config.runtime,
    cwd: config.cwd,
    runtimeTempDir: config.runtimeTempDir,
    workspaceId: config.workspaceId,
    // Match bash tool behavior: xumEnv is present and secrets override it.
    env: {
      ...(config.xumEnv ?? {}),
      ...(config.secrets ?? {}),
    },
  };
}

const HOOK_OUTPUT_MAX_CHARS = 64 * 1024;

function truncateHookOutput(output: string): string {
  if (output.length <= HOOK_OUTPUT_MAX_CHARS) {
    return output;
  }
  return output.slice(0, HOOK_OUTPUT_MAX_CHARS) + "\n\n[hook_output truncated]";
}

/**
 * Wrap a tool to execute within hook context if hooks exist.
 *
 * Hook priority:
 * - Pre: tool_pre (new) → tool_hook (legacy)
 * - Post: tool_post (new) → tool_hook (only if used for pre)
 */
export function withHooks<TParameters, TResult>(
  toolName: string,
  tool: Tool<TParameters, TResult>,
  config: HookConfig
): Tool<TParameters, TResult> {
  // Access the tool as a record to get its properties.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const toolRecord = tool as any as Record<string, unknown>;
  const originalExecute = toolRecord.execute;

  if (typeof originalExecute !== "function") {
    return tool;
  }

  const executeFn = originalExecute as (
    this: unknown,
    args: TParameters,
    options: unknown
  ) => unknown;

  // Avoid mutating cached tools in place (e.g. MCP tools cached per workspace).
  // Repeated getToolsForModel() calls should not stack wrappers.
  const wrappedTool = cloneToolPreservingDescriptors(tool) as Tool<TParameters, TResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const wrappedToolRecord = wrappedTool as any as Record<string, unknown>;

  wrappedToolRecord.execute = async (args: TParameters, options: unknown) => {
    // Extract abort signal from tool options (if present)
    const abortSignal =
      options && typeof options === "object" && "abortSignal" in options
        ? (options as { abortSignal?: AbortSignal }).abortSignal
        : undefined;

    const outcome = await runThroughToolHookPipeline({
      toolName,
      args,
      config,
      abortSignal,
      execute: (currentArgs) =>
        Promise.resolve(executeFn.call(tool, currentArgs, options) as TResult | Promise<TResult>),
    });
    // Blocked executions surface the hook's error object as the tool result.
    return outcome.result as TResult;
  };

  return wrappedTool;
}

/** Outcome of one hook-gated execution (see runThroughToolHookPipeline). */
export type ToolHookPipelineOutcome<TResult> =
  | { blocked: true; result: unknown }
  | { blocked: false; result: TResult };

/**
 * Run one execution through the event spine's `tool.execute` waterfall — the
 * same pipeline (plugin middleware + shell tool_pre/tool_post/tool_hook
 * protocol) every hook-wrapped tool runs through. Exported so non-tool
 * executions that must honor the same trust boundary (mux.load's bulk read
 * riding file_read's hook gate) share this pipeline instead of reimplementing
 * or bypassing it. Middleware may rewrite args; `execute` receives the
 * current ones.
 */
export async function runThroughToolHookPipeline<TArgs, TResult>(input: {
  toolName: string;
  args: TArgs;
  config: HookConfig;
  abortSignal?: AbortSignal;
  execute: (args: TArgs) => Promise<TResult>;
}): Promise<ToolHookPipelineOutcome<TResult>> {
  const { toolName, config } = input;
  ensureShellToolHookMiddleware();

  const ctx: ToolExecuteContext = {
    toolName,
    args: input.args,
    host: {
      runtime: config.runtime,
      runtimeTempDir: config.runtimeTempDir,
      cwd: config.cwd,
      workspaceId: config.workspaceId,
      env: config.env,
    },
    abortSignal: input.abortSignal,
    executed: false,
  };

  await eventSpine.run("tool.execute", ctx, async (c) => {
    assert(!c.blocked, `tool.execute terminal reached with blocked context (${toolName})`);
    // Middleware may have rewritten args; execute with the current ones.
    c.result = await input.execute(c.args as TArgs);
    c.executed = true;
  });

  if (ctx.blocked) {
    return { blocked: true, result: ctx.blocked.result };
  }
  assert(
    ctx.executed,
    `tool.execute middleware for ${toolName} neither executed nor blocked the tool`
  );
  return { blocked: false, result: ctx.result as TResult };
}

// ---------------------------------------------------------------------------
// Shell tool hook middleware (built-in `tool.execute` consumer)
// ---------------------------------------------------------------------------

let shellToolHookMiddlewareRegistered = false;

/**
 * Idempotently register the shell hook middleware on the spine. Invoked from
 * withHooks() so every entry point that wraps tools (desktop, CLI, tests) gets
 * identical hook behavior without a separate bootstrap step.
 */
function ensureShellToolHookMiddleware(): void {
  if (shellToolHookMiddlewareRegistered) return;
  shellToolHookMiddlewareRegistered = true;
  eventSpine.use("tool.execute", shellToolHookMiddleware);
}

/**
 * The `.xum/tool_pre` / `.xum/tool_post` / legacy `.xum/tool_hook` protocol as
 * around-style middleware. Behavior is identical to the pre-spine withHooks
 * implementation; the legacy protocol inherently wraps execution, which is why
 * the pipeline is around-style.
 */
async function shellToolHookMiddleware(
  ctx: ToolExecuteContext,
  next: WaterfallNext
): Promise<void> {
  const { runtime, cwd } = ctx.host;

  // Find hooks (checked per call - hooks can be added/removed dynamically)
  const [preHookPath, postHookPath, legacyHookPath] = await Promise.all([
    getPreHookPath(runtime, cwd),
    getPostHookPath(runtime, cwd),
    getHookPath(runtime, cwd),
  ]);

  // No hooks at all - continue the pipeline directly
  if (!preHookPath && !postHookPath && !legacyHookPath) {
    return next();
  }

  const toolName = ctx.toolName;
  const hookContext = {
    tool: toolName,
    toolInput: JSON.stringify(ctx.args),
    toolInputValue: ctx.args,
    workspaceId: ctx.host.workspaceId,
    projectDir: cwd,
    runtimeTempDir: ctx.host.runtimeTempDir,
    env: ctx.host.env,
    abortSignal: ctx.abortSignal,
  };

  // Use new model (tool_pre/tool_post) if tool_pre exists
  if (preHookPath) {
    log.debug("[withHooks] Running tool with pre/post hooks", {
      toolName,
      preHookPath,
      postHookPath,
    });

    const hookStart = Date.now();
    const preResult = await runPreHook(runtime, preHookPath, hookContext);

    // Pre-hook blocked tool
    if (!preResult.allowed) {
      const output = truncateHookOutput(
        preResult.output || `Tool blocked by pre-hook (exit ${preResult.exitCode})`
      );
      log.debug("[withHooks] Pre-hook blocked tool", { toolName, output });
      ctx.blocked = { result: { error: output } };
      return;
    }

    // Execute tool (rest of pipeline)
    await next();

    // Run post-hook if exists
    if (postHookPath) {
      const postResult = await runPostHook(runtime, postHookPath, hookContext, ctx.result);
      const hookDurationMs = Date.now() - hookStart;
      let hookOutput = postResult.output;

      if (!postResult.success && !hookOutput) {
        hookOutput = `Post-hook failed (exit code ${postResult.exitCode})`;
      }

      if (hookOutput) {
        hookOutput = truncateHookOutput(hookOutput);
        log.debug("[withHooks] Post-hook produced output", {
          toolName,
          success: postResult.success,
          output: hookOutput,
        });
        ctx.result = appendHookOutput(ctx.result, hookOutput, hookDurationMs, postHookPath);
      }
    }
    return;
  }

  // Fall back to legacy model (tool_hook) if it exists
  if (legacyHookPath) {
    log.debug("[withHooks] Running tool with legacy hook", { toolName, hookPath: legacyHookPath });

    const hookStart = Date.now();
    const { result, hook } = await runWithHook<unknown>(
      runtime,
      legacyHookPath,
      hookContext,
      async () => {
        await next();
        return ctx.result;
      },
      {
        slowThresholdMs: 10000,
        onSlowHook: (phase, elapsedMs) => {
          const seconds = (elapsedMs / 1000).toFixed(1);
          log.warn(`[withHooks] Slow ${phase}-hook for ${toolName}: ${seconds}s`);
          console.warn(`⚠️  Slow tool hook (${phase}): ${toolName} took ${seconds}s`);
        },
      }
    );
    const hookDurationMs = Date.now() - hookStart;

    // Hook blocked tool execution (exited before $MUX_EXEC)
    if (!hook.toolExecuted) {
      const blockOutput = truncateHookOutput(
        [hook.stdoutBeforeExec, hook.stderr].filter(Boolean).join("\n").trim()
      );
      log.debug("[withHooks] Hook blocked tool execution", { toolName, output: blockOutput });
      ctx.blocked = {
        result: { error: blockOutput || "Tool blocked by hook (exited before $MUX_EXEC)" },
      };
      return;
    }

    // Combine stdout and stderr for hook output
    let hookOutput = [hook.stdout, hook.stderr].filter(Boolean).join("\n").trim();

    if (!hook.success && !hookOutput) {
      hookOutput = `Tool hook failed (exit code ${hook.exitCode})`;
    }

    if (hookOutput) {
      hookOutput = truncateHookOutput(hookOutput);
      log.debug("[withHooks] Hook produced output", {
        toolName,
        success: hook.success,
        output: hookOutput,
      });
      ctx.result = appendHookOutput(result, hookOutput, hookDurationMs, legacyHookPath);
      return;
    }

    // Note: result could be TResult or AsyncIterable<TResult>
    ctx.result = result;
    return;
  }

  // Only post hook exists (no pre) - execute tool then run post
  assert(postHookPath, "shellToolHookMiddleware: expected tool_post path in post-only branch");
  await next();
  const postStart = Date.now();
  const postResult = await runPostHook(runtime, postHookPath, hookContext, ctx.result);
  const hookDurationMs = Date.now() - postStart;
  if (postResult.output) {
    ctx.result = appendHookOutput(
      ctx.result,
      truncateHookOutput(postResult.output),
      hookDurationMs,
      postHookPath
    );
  }
}

/** Check if a value is an AsyncIterable (streaming result) */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Append hook output to tool result.
 * This lets the LLM see hook feedback (errors, formatter notifications) alongside the tool result.
 *
 * Note: AsyncIterable (streaming) results are wrapped to preserve the iterator while attaching hook_output.
 */
function appendHookOutput<T>(
  result: T | AsyncIterable<T> | undefined,
  output: string,
  durationMs?: number,
  hookPath?: string
): MayHaveHookOutput<T> | AsyncIterable<T> {
  if (result === undefined) {
    const errorResult: WithHookOutput & { error: string } = {
      error: output,
      hook_output: output,
      hook_duration_ms: durationMs,
      hook_path: hookPath,
    };
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    return errorResult as unknown as MayHaveHookOutput<T>;
  }

  // AsyncIterable (streaming) results: preserve streaming while attaching hook_output.
  if (isAsyncIterable<T>(result)) {
    const iterable = result;
    const iteratorFn = iterable[Symbol.asyncIterator].bind(iterable);
    const wrappedIterable: AsyncIterable<T> & WithHookOutput = {
      hook_output: output,
      hook_duration_ms: durationMs,
      hook_path: hookPath,
      [Symbol.asyncIterator]: iteratorFn,
    };
    return wrappedIterable;
  }

  // If result is an object, add hook_output field
  if (typeof result === "object" && result !== null) {
    const withOutput: MayHaveHookOutput<T> = {
      ...(result as T),
      hook_output: output,
      hook_duration_ms: durationMs,
      hook_path: hookPath,
    };
    return withOutput;
  }

  // For primitive results, wrap in object
  const wrapped: { result: T } & WithHookOutput = {
    result,
    hook_output: output,
    hook_duration_ms: durationMs,
    hook_path: hookPath,
  };
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  return wrapped as unknown as MayHaveHookOutput<T>;
}
