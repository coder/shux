import type { Tool } from "ai";
import assert from "@/common/utils/assert";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { isBuiltInTaskTool } from "@/node/services/tools/task";

type AsyncMutexGuard = Awaited<ReturnType<AsyncMutex["acquire"]>>;

interface ParallelTaskArgs {
  agentId?: unknown;
  subagent_type?: unknown;
  isolation?: unknown;
}

interface ToolExecutionContext {
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

function getAbortSignal(options: unknown): AbortSignal | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }

  const context = options as ToolExecutionContext;
  return context.abortSignal;
}

function getToolCallId(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }

  const { toolCallId } = options as ToolExecutionContext;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function getRequestedAgentId(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  // The task tool's inputSchema (buildTaskToolAgentArgsSchema) passes the raw agentId through; the
  // trim()/toLowerCase() normalization only happens inside execute via TOOL_DEFINITIONS.task.schema.
  // Mirror that normalization here so valid-but-non-canonical ids ("Explore", " explore ") are
  // still recognized and share the reader lock instead of falling back to the writer lock.
  const normalize = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  };

  const taskArgs = args as ParallelTaskArgs;
  return normalize(taskArgs.agentId) ?? normalize(taskArgs.subagent_type);
}

// Decide whether a tool call may share the read side of the lock with sibling explore tasks.
//
// MAINTAINER DECISION (do not "harden" this by inspecting the resolved tool set or runtime fork
// isolation): we trust the `explore` agent id as a declaration of read-only intent. The `explore`
// contract is read-only *by prompt*, not by tool removal — the built-in explore agent still has
// `bash`, and a custom project/global override named `explore` may also enable bash/exec. Letting
// two such agents run in parallel is explicitly fine and NOT a race we are trying to prevent here,
// even when the runtime gives them a *shared* checkout. In local runtime the task tool does not
// expose `isolation`, so explore calls arrive with `isolation === undefined` and forks point at
// the same project directory; two parallel explore calls writing to that checkout via bash is
// accepted as best-effort. The only `isolation` value that opts OUT of parallelism is the explicit
// `"none"` (caller-declared shared workspace). What we DO keep serialized regardless: direct
// mutating tools (file_edit_*, bash, config writes) and non-explore forked tasks — those always
// take the exclusive write lock.
//
// This also covers parent-side tool hooks: when a repo configures `.xum/tool_pre`/`tool_post`/
// `tool_hook`, those scripts wrap the task tool's execute and run in the parent checkout. Two
// sibling explore task calls therefore run those hook scripts concurrently. That is the same
// best-effort tradeoff as concurrent explore bash/exec, so the built-in task marker is preserved
// through hook wrapping (see wrapToolsWithHooks) rather than stripped — stripping it serialized
// every explore task in the common case of a repo that merely has a `tool_post` formatter.
function canRunWithSiblingExploreTasks(baseTool: Tool, args: unknown): boolean {
  if (!isBuiltInTaskTool(baseTool)) {
    return false;
  }
  if (getRequestedAgentId(args) !== "explore") {
    return false;
  }
  return (args as ParallelTaskArgs | null)?.isolation !== "none";
}

function releaseLockAfterAbort(acquirePromise: Promise<AsyncMutexGuard>): void {
  void acquirePromise
    .then(async (lock) => {
      await lock[Symbol.asyncDispose]();
    })
    .catch(() => {
      // Ignore acquisition failures while cleaning up an aborted waiter.
    });
}

async function acquireLockOrAbort(
  executionLock: AsyncMutex,
  abortSignal?: AbortSignal
): Promise<AsyncMutexGuard> {
  if (abortSignal?.aborted) {
    throw new Error("Interrupted");
  }

  const acquirePromise = executionLock.acquire();
  if (!abortSignal) {
    return await acquirePromise;
  }

  let abortListener: (() => void) | undefined;
  let didAcquireLock = false;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      reject(new Error("Interrupted"));
    };
    abortSignal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    const lock = await Promise.race([acquirePromise, abortPromise]);
    didAcquireLock = true;
    if (abortListener) {
      abortSignal.removeEventListener("abort", abortListener);
    }

    if (abortSignal.aborted) {
      await lock[Symbol.asyncDispose]();
      throw new Error("Interrupted");
    }

    return lock;
  } catch (error) {
    if (abortListener) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    if (!didAcquireLock && error instanceof Error && error.message === "Interrupted") {
      releaseLockAfterAbort(acquirePromise);
    }
    throw error;
  }
}

class SharedExecutionReadGuard implements AsyncDisposable {
  constructor(private readonly lock: SharedExecutionLock) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.lock.releaseRead();
  }
}

class SharedExecutionWriteGuard implements AsyncDisposable {
  constructor(
    private readonly turnstileLock: AsyncMutexGuard,
    private readonly roomEmptyLock: AsyncMutexGuard
  ) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.roomEmptyLock[Symbol.asyncDispose]();
    await this.turnstileLock[Symbol.asyncDispose]();
  }
}

class SharedExecutionLock {
  private readonly turnstile = new AsyncMutex();
  private readonly roomEmpty = new AsyncMutex();
  private readonly readerCountLock = new AsyncMutex();
  private activeReaders = 0;
  private roomEmptyGuard: AsyncMutexGuard | undefined;

  async acquireRead(abortSignal?: AbortSignal): Promise<AsyncDisposable> {
    await using _turnstile = await acquireLockOrAbort(this.turnstile, abortSignal);
    await using _readerCountLock = await acquireLockOrAbort(this.readerCountLock, abortSignal);
    if (this.activeReaders === 0) {
      this.roomEmptyGuard = await acquireLockOrAbort(this.roomEmpty, abortSignal);
    }
    this.activeReaders += 1;
    return new SharedExecutionReadGuard(this);
  }

  async acquireWrite(abortSignal?: AbortSignal): Promise<AsyncDisposable> {
    const turnstileLock = await acquireLockOrAbort(this.turnstile, abortSignal);
    try {
      const roomEmptyLock = await acquireLockOrAbort(this.roomEmpty, abortSignal);
      return new SharedExecutionWriteGuard(turnstileLock, roomEmptyLock);
    } catch (error) {
      await turnstileLock[Symbol.asyncDispose]();
      throw error;
    }
  }

  async releaseRead(): Promise<void> {
    await using _readerCountLock = await this.readerCountLock.acquire();
    assert(this.activeReaders > 0, "SharedExecutionLock.releaseRead called with no active readers");
    this.activeReaders -= 1;
    if (this.activeReaders === 0) {
      const roomEmptyGuard = this.roomEmptyGuard;
      this.roomEmptyGuard = undefined;
      await roomEmptyGuard?.[Symbol.asyncDispose]();
    }
  }
}

/**
 * Serialize sibling tool execution for a single stream without changing the
 * provider's parallel-tool-call planning behavior. Built-in forked explore
 * tasks share the read side so they can overlap with each other, while every
 * other tool call stays exclusive.
 *
 * `onExecutionStart` fires right after the execution lock is acquired (i.e.
 * when the tool actually starts running, not when the model emitted the call),
 * so queued siblings don't count wait time as execution time.
 */
export function withSequentialExecution(
  tools: Record<string, Tool> | undefined,
  onExecutionStart?: (toolCallId: string) => void
): Record<string, Tool> | undefined {
  if (!tools) {
    return tools;
  }

  const executionLock = new SharedExecutionLock();
  const wrappedTools: Record<string, Tool> = { ...tools };

  for (const [toolName, baseTool] of Object.entries(tools)) {
    assert(toolName.length > 0, "tool names must be non-empty");

    const baseToolRecord = baseTool as Record<string, unknown>;
    const originalExecute = baseToolRecord.execute;
    if (typeof originalExecute !== "function") {
      continue;
    }

    const executeFn = originalExecute as (
      this: unknown,
      args: unknown,
      options: unknown
    ) => unknown;
    const wrappedTool = cloneToolPreservingDescriptors(baseTool);
    const wrappedToolRecord = wrappedTool as Record<string, unknown>;

    wrappedToolRecord.execute = async (args: unknown, options: unknown) => {
      const abortSignal = getAbortSignal(options);
      await using _lock = canRunWithSiblingExploreTasks(baseTool, args)
        ? await executionLock.acquireRead(abortSignal)
        : await executionLock.acquireWrite(abortSignal);
      const toolCallId = getToolCallId(options);
      if (onExecutionStart && toolCallId !== undefined) {
        onExecutionStart(toolCallId);
      }
      return await executeFn.call(baseTool, args, options);
    };

    wrappedTools[toolName] = wrappedTool;
  }

  return wrappedTools;
}
