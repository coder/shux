/**
 * Typed event spine for the main process.
 *
 * dsh-inspired three-way event split (shared foundation for the plugin and RLM
 * experiment tracks):
 *
 * - **Durable events**: rows appended to session journals. The spine does not
 *   persist anything itself — see the record schema in
 *   `src/common/types/durableEvent.ts` and the append/read utilities in
 *   `src/node/utils/journal/`.
 * - **Live waterfall hooks**: ordered, mutating, async middleware (next()-style)
 *   around tool execution and request assembly. Middleware may rewrite the
 *   context before calling `next()` and may rewrite results after it returns.
 * - **Observer events**: read-only fan-out of lifecycle facts. Listeners must
 *   not mutate anything on the hot path; thrown errors are logged and swallowed
 *   so a bad observer can never break the emitting code path.
 *
 * The tool-execution pipeline is around-style: `run("tool.execute", ctx,
 * terminal)` composes middleware around a terminal that executes the tool.
 * This models the legacy `.xum/tool_hook` protocol (which inherently wraps
 * execution) with the same primitive as pre/post hooks. The handoff's
 * `tool.execute.before` / `tool.execute.after` vocabulary is exposed as
 * first-class registration sugar that composes onto the around pipeline.
 */

import assert from "node:assert";
import { EventEmitter } from "node:events";
import type { Tool } from "ai";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

// ---------------------------------------------------------------------------
// Observer events (read-only fan-out)
// ---------------------------------------------------------------------------

export interface ObserverEventMap {
  "workspace.created": { workspaceId: string };
  "workspace.archived": { workspaceId: string };
  /** A sub-agent task delivered its terminal report. */
  "task.reported": { workspaceId: string; taskId: string };
  /** AgentSession lifecycle. Construction/disposal are synchronous, so session
   * lifecycle is observer-only for now; a waterfall variant can be added when a
   * mutating consumer lands. */
  "session.start": { workspaceId: string };
  "session.end": { workspaceId: string };
  "stream.start": { workspaceId: string; messageId: string };
  "stream.end": { workspaceId: string; messageId: string };
}

// ---------------------------------------------------------------------------
// Waterfall hook points (ordered, mutating, async middleware)
// ---------------------------------------------------------------------------

/** Host execution context a tool runs in (shell hooks need all of these). */
export interface ToolExecutionHost {
  runtime: Runtime;
  /** Runtime temp dir for hook scratch files (paths in the runtime's context). */
  runtimeTempDir: string;
  /** Working directory where hooks are discovered. */
  cwd: string;
  workspaceId: string;
  /** Additional environment variables to pass to hooks. */
  env?: Record<string, string>;
}

export interface ToolExecuteContext {
  readonly toolName: string;
  /** Mutable before the terminal runs: middleware may rewrite tool args. */
  args: unknown;
  readonly host: ToolExecutionHost;
  readonly abortSignal?: AbortSignal;
  /** Set by the terminal after the tool actually executed. */
  executed: boolean;
  /** Set by the terminal; mutable after next() returns (middleware may augment). */
  result?: unknown;
  /**
   * Set by middleware to block tool execution; the pipeline skips the terminal
   * and `blocked.result` is returned to the model. Middleware that sets this
   * must not call next().
   */
  blocked?: { result: unknown };
}

export interface RequestAssembleContext {
  readonly workspaceId: string;
  readonly modelString: string;
  /** Mutable: final system prompt text sent to the provider. */
  systemMessage: string;
  /** Mutable: final toolset for the request (middleware may filter). */
  tools: Record<string, Tool>;
}

/** A deliberately separate projection: callbacks cannot obtain the live tool objects. */
export type RequestContextOnly = Omit<RequestAssembleContext, "tools">;

export interface RequestAssemblySnapshot {
  readonly workspaceId: string;
  readonly preservesToolset: boolean;
  run(ctx: RequestAssembleContext): Promise<void>;
}

interface RegistrationOptions {
  order?: number;
  workspaceId?: string;
}

export interface CompactionPrepareContext {
  readonly workspaceId: string;
  readonly reason: "on-send" | "mid-stream" | "continuous-eager";
}

export interface WaterfallPointMap {
  "tool.execute": ToolExecuteContext;
  "request.assemble": RequestAssembleContext;
  "compaction.prepare": CompactionPrepareContext;
}

export type WaterfallNext = () => Promise<void>;
/** Middleware may be sync or async; the runner awaits either way. */
export type WaterfallMiddleware<C> = (ctx: C, next: WaterfallNext) => void | Promise<void>;

/** Simple callback shape used by the before/after registration sugar. */
export type HookCallback<C> = (ctx: C) => void | Promise<void>;

interface Registration {
  // Stored type-erased; the registration helpers are fully typed.
  middleware: WaterfallMiddleware<unknown>;
  order: number;
  seq: number;
  workspaceId?: string;
  preservesToolset: boolean;
}

/** Duck-check for contexts that support blocking (currently tool.execute). */
function isBlocked(ctx: unknown): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    "blocked" in ctx &&
    (ctx as { blocked?: unknown }).blocked != null
  );
}

export class EventSpine {
  private readonly observers = new EventEmitter();
  private readonly waterfalls = new Map<string, Registration[]>();
  private registrationSeq = 0;

  constructor() {
    // Unbounded read-only fan-out; listener count is not a leak signal here.
    this.observers.setMaxListeners(0);
  }

  // --- Observer events ---

  emit<K extends keyof ObserverEventMap>(event: K, payload: ObserverEventMap[K]): void {
    this.observers.emit(event, payload);
  }

  /** Subscribe to a read-only observer event. Returns an unsubscribe function. */
  // The listener returns `unknown` (not `void`) so async listeners and
  // expression-bodied arrows both typecheck; return values are ignored except
  // promises, whose rejections are captured below.
  subscribe<K extends keyof ObserverEventMap>(
    event: K,
    listener: (payload: ObserverEventMap[K]) => unknown
  ): () => void {
    // Observers are read-only fan-out: a throwing OR rejecting listener must
    // never break the emitting code path (stream loop, workspace lifecycle,
    // ...). Async listener rejections are logged, not awaited — emission
    // stays non-blocking.
    const wrapped = (payload: ObserverEventMap[K]) => {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            log.error(`EventSpine observer for '${event}' rejected`, { error });
          });
        }
      } catch (error) {
        log.error(`EventSpine observer for '${event}' threw`, { error });
      }
    };
    this.observers.on(event, wrapped);
    return () => this.observers.off(event, wrapped);
  }

  // --- Waterfall hooks ---

  /** Register around-style middleware on a hook point. Returns an unregister function. */
  use<K extends keyof WaterfallPointMap>(
    point: K,
    middleware: WaterfallMiddleware<WaterfallPointMap[K]>,
    opts?: RegistrationOptions
  ): () => void {
    return this.register(point, middleware, opts, false);
  }

  private register<K extends keyof WaterfallPointMap>(
    point: K,
    middleware: WaterfallMiddleware<WaterfallPointMap[K]>,
    opts: RegistrationOptions | undefined,
    preservesToolset: boolean
  ): () => void {
    if (opts?.workspaceId != null)
      assert(opts.workspaceId.length > 0, "Workspace scope must not be empty");
    const registrations = this.waterfalls.get(point) ?? [];
    const registration: Registration = Object.freeze({
      middleware: middleware as WaterfallMiddleware<unknown>,
      order: opts?.order ?? 0,
      seq: this.registrationSeq++,
      workspaceId: opts?.workspaceId,
      preservesToolset,
    });
    registrations.push(registration);
    // Stable order: explicit order first, then registration sequence.
    registrations.sort((a, b) => a.order - b.order || a.seq - b.seq);
    this.waterfalls.set(point, registrations);
    return () => {
      const current = this.waterfalls.get(point);
      if (!current) return;
      const index = current.indexOf(registration);
      if (index !== -1) current.splice(index, 1);
    };
  }

  /**
   * Registration sugar for the handoff/OpenCode hook vocabulary:
   * - `tool.execute.before` runs before the tool executes; if the callback sets
   *   `ctx.blocked`, the rest of the pipeline (including the tool) is skipped.
   * - `tool.execute.after` runs after the tool executed; skipped when blocked.
   */
  useBefore<K extends keyof WaterfallPointMap>(
    point: K,
    callback: HookCallback<WaterfallPointMap[K]>,
    opts?: RegistrationOptions
  ): () => void {
    return this.use(
      point,
      async (ctx, next) => {
        await callback(ctx);
        if (!isBlocked(ctx)) {
          await next();
        }
      },
      opts
    );
  }

  useAfter<K extends keyof WaterfallPointMap>(
    point: K,
    callback: HookCallback<WaterfallPointMap[K]>,
    opts?: RegistrationOptions
  ): () => void {
    return this.use(
      point,
      async (ctx, next) => {
        await next();
        if (!isBlocked(ctx)) {
          await callback(ctx);
        }
      },
      opts
    );
  }

  /** Toolset preservation is by construction, not a claim made by arbitrary middleware. */
  useRequestContext(
    callback: HookCallback<RequestContextOnly>,
    opts?: RegistrationOptions
  ): () => void {
    return this.register(
      "request.assemble",
      async (ctx, next) => {
        const projection: RequestContextOnly = {
          workspaceId: ctx.workspaceId,
          modelString: ctx.modelString,
          systemMessage: ctx.systemMessage,
        };
        await callback(projection);
        assert(typeof projection.systemMessage === "string", "Request context must remain text");
        ctx.systemMessage = projection.systemMessage;
        await next();
      },
      opts,
      true
    );
  }

  captureRequestAssembly(workspaceId: string): RequestAssemblySnapshot {
    assert(workspaceId.length > 0, "Request assembly snapshot requires a workspace");
    const registrations = Object.freeze(
      this.applicableRegistrations("request.assemble", workspaceId)
    );
    return Object.freeze({
      workspaceId,
      preservesToolset: registrations.every((registration) => registration.preservesToolset),
      run: async (ctx: RequestAssembleContext) => {
        assert(ctx.workspaceId === workspaceId, "Request assembly snapshot workspace mismatch");
        await this.runRegistrations("request.assemble", registrations, ctx);
      },
    });
  }

  private applicableRegistrations(
    point: keyof WaterfallPointMap,
    workspaceId: string
  ): Registration[] {
    return (this.waterfalls.get(point) ?? []).filter(
      (registration) => registration.workspaceId == null || registration.workspaceId === workspaceId
    );
  }

  /** True when at least one middleware is registered on the point. Lets hot
   * paths skip context construction entirely when the pipeline is empty. */
  hasMiddleware(point: keyof WaterfallPointMap): boolean {
    return (this.waterfalls.get(point)?.length ?? 0) > 0;
  }

  /**
   * Run the waterfall for a hook point. Middleware is composed around the
   * optional terminal. Contract: a context with a truthy `blocked` property
   * never reaches the terminal.
   */
  async run<K extends keyof WaterfallPointMap>(
    point: K,
    ctx: WaterfallPointMap[K],
    terminal?: (ctx: WaterfallPointMap[K]) => void | Promise<void>
  ): Promise<void> {
    await this.runRegistrations(point, this.waterfalls.get(point) ?? [], ctx, terminal);
  }

  private async runRegistrations<K extends keyof WaterfallPointMap>(
    point: K,
    registrations: readonly Registration[],
    ctx: WaterfallPointMap[K],
    terminal?: (ctx: WaterfallPointMap[K]) => void | Promise<void>
  ): Promise<void> {
    const workspaceId = "host" in ctx ? ctx.host.workspaceId : ctx.workspaceId;
    const dispatch = async (index: number): Promise<void> => {
      if (index < registrations.length) {
        const registration = registrations[index];
        if (registration.workspaceId != null && registration.workspaceId !== workspaceId) {
          return dispatch(index + 1);
        }
        let nextCalled = false;
        const next: WaterfallNext = () => {
          assert(!nextCalled, `EventSpine '${point}' middleware called next() more than once`);
          nextCalled = true;
          return dispatch(index + 1);
        };
        await registration.middleware(ctx, next);
        return;
      }
      if (terminal && !isBlocked(ctx)) {
        await terminal(ctx);
      }
    };
    await dispatch(0);
  }
}

/**
 * Process-wide spine singleton (mirrors the workflowRunStreamHub pattern).
 * Main-process services emit into it; middleware/observers are registered by
 * built-in consumers (shell tool hooks) and, later, plugin/experiment tracks.
 */
export const eventSpine = new EventSpine();
