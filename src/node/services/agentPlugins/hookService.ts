/**
 * Tier-1 sandboxed plugin hooks (agent-plugins experiment).
 *
 * Discovers `hooks.js` modules inside Agent Plugin roots (same containers and
 * Project Trust gating as plugin MCP config), loads each one into its own
 * persistent QuickJS sandbox mount (SandboxHostService), and registers one
 * event-spine middleware per loaded hook. Supported hook points:
 *
 * - `tool.execute.before`: may rewrite tool args or deny the call. Denials are
 *   honored as tool errors visible to the model; mutation/visibility is
 *   bounded to tools the plugin's manifest was granted
 *   (`extensions.mux.hooks.tools`).
 * - `tool.execute.after`: may observe the result and annotate it (model-visible
 *   `hook_output`, mirroring the shell hook convention).
 * - `request.assemble`: may contribute context text. Log purity: contributed
 *   context is materialized as a durable `hook-context` row BEFORE the request
 *   mutation, so "model-visible ⟹ logged" holds and the replay harness can
 *   attribute the prompt bytes.
 *
 * Failure posture (self-healing doctrine): a crashing, timing-out, or
 * malformed hook never breaks the turn — log, skip, continue. Only explicit
 * denials from `tool.execute.before` surface to the model.
 */

import assert from "node:assert";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { isBridgeToolGranted, type CapabilityGrants } from "@/common/types/capabilityGrants";
import { getErrorMessage } from "@/common/utils/errors";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import {
  eventSpine,
  type EventSpine,
  type RequestContextOnly,
  type ToolExecuteContext,
} from "@/node/services/events/eventSpine";
import { log } from "@/node/services/log";
import {
  sandboxHostService,
  type AcquireMountOptions,
  type SandboxHostService,
  type SandboxMount,
} from "@/node/services/sandbox/sandboxHostService";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { ensurePathContained } from "@/node/services/tools/skillFileUtils";
import {
  computeAgentPluginContainers,
  discoverAgentPlugins,
  MAX_PLUGIN_HOOK_SOURCE_BYTES,
  readPluginFileWithinRootCapped,
  type AgentPluginContainer,
  type AgentPluginInfo,
} from "./discovery";
import { readMutationEpochToken, STAGING_DIR_NAME } from "./journals";
import {
  buildHookInvokeScript,
  buildHookLoadScript,
  parseHookOutput,
  parseLoadedHookNames,
  resolvePluginHookGrants,
  type PluginHookPoint,
} from "./hookSandbox";

/** Per-eval deadline for hook load + invocation; a stuck hook must never stall a turn. */
const HOOK_EVAL_TIMEOUT_MS = 5_000;
/** hook-context rows inline text up to this size; larger payloads go to the blob store. */
const HOOK_CONTEXT_INLINE_MAX_CHARS = 4_096;
/** Hard cap on contributed context; larger contributions are dropped with a warning. */
const HOOK_CONTEXT_MAX_CHARS = 64 * 1024;
/** Tool results larger than this (as JSON) are omitted from tool.execute.after input. */
const HOOK_RESULT_INPUT_MAX_CHARS = 256 * 1024;

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export interface EnsureWorkspaceHooksArgs {
  workspaceId: string;
  /** Host session dir backing the plugin sandbox mounts. */
  sessionDir: string;
  /** Durable journal for this workspace session (hook-context rows). */
  journal: DurableEventJournal;
  /** agent-plugins experiment gate; false tears down any registered hooks. */
  enabled: boolean;
  /** `~/.mux` root anchoring the global plugin container. */
  xumHome: string;
  /** Host checkout root for project containers; omit for off-host workspaces. */
  projectRoot?: string;
  projectTrusted: boolean;
}

/** One discovered plugin with a hooks.js, plus its pinned source snapshot. */
interface DiscoveredHookPlugin {
  plugin: AgentPluginInfo;
  source: string;
  grants: CapabilityGrants;
}

/** Host-side state for one loaded plugin hook mount. */
interface LoadedPluginHookState {
  pluginName: string;
  grants: CapabilityGrants;
  /** Pinned hooks.js source; re-evaluated when the mount is rebuilt. */
  source: string;
  mountOptions: AcquireMountOptions;
  hookNames: PluginHookPoint[];
  /** Set at teardown so in-flight invocations stop re-creating dropped mounts. */
  disposed: boolean;
}

interface WorkspaceHookRegistration {
  fingerprint: string;
  unregisters: Array<() => void>;
  states: LoadedPluginHookState[];
  /**
   * Managed-container mutation epoch captured when this registration's
   * plugins were (re)discovered. Every hook invocation revalidates it so an
   * install/update/uninstall committed in ANY process (the epoch bump is the
   * commit signal, same as the MCP manager's cross-process retire sweep)
   * stops already-registered hooks from seeing tool traffic mid-stream,
   * instead of them surviving until the workspace's next send.
   */
  epochStagingRoot: string;
  epochToken: string | undefined;
  /**
   * Fingerprint lines of discovered candidates that failed to load. Retried
   * on later sends WITHOUT tearing down healthy siblings: a full-teardown
   * retry would destroy their persistent mounts, losing cross-turn guest
   * state and re-paying initialization on every send while one plugin stays
   * broken.
   */
  failedLines: Set<string>;
}

interface AgentPluginHookServiceDeps {
  spine?: EventSpine;
  sandboxHost?: SandboxHostService;
  hookTimeoutMs?: number;
  /** Lazy QuickJS loader (the WASM stack must not load at startup). */
  runtimeFactoryLoader?: () => Promise<IJSRuntimeFactory>;
  /** Container computation seam (tests pin containers to temp dirs). */
  computeContainers?: typeof computeAgentPluginContainers;
}

function loadQuickJSRuntimeFactory(): Promise<IJSRuntimeFactory> {
  // The heavy QuickJS WASM stack loads at first runtime creation
  // (QuickJSRuntime.create), not at module import — the static import adds
  // only JS glue to the startup graph, so factory construction stays cheap
  // and lazy behind the runtimeFactoryLoader seam.
  return Promise.resolve(new QuickJSRuntimeFactory());
}

export class AgentPluginHookService {
  private readonly spine: EventSpine;
  private readonly sandboxHost: SandboxHostService;
  private readonly hookTimeoutMs: number;
  private readonly runtimeFactoryLoader: () => Promise<IJSRuntimeFactory>;
  private readonly computeContainers: typeof computeAgentPluginContainers;

  private readonly registrations = new Map<string, WorkspaceHookRegistration>();
  /** Serializes ensure/dispose per workspace (concurrent sends must not race teardown). */
  private readonly locks = new Map<string, AsyncMutex>();
  /** Mounts whose guest hook registry is already loaded (rebuilt mounts miss → reload). */
  private readonly loadedMounts = new WeakSet<SandboxMount>();
  private runtimeFactory: IJSRuntimeFactory | null = null;

  constructor(deps: AgentPluginHookServiceDeps = {}) {
    this.spine = deps.spine ?? eventSpine;
    this.sandboxHost = deps.sandboxHost ?? sandboxHostService;
    this.hookTimeoutMs = deps.hookTimeoutMs ?? HOOK_EVAL_TIMEOUT_MS;
    this.runtimeFactoryLoader = deps.runtimeFactoryLoader ?? loadQuickJSRuntimeFactory;
    this.computeContainers = deps.computeContainers ?? computeAgentPluginContainers;
  }

  /** Normal and headless requests share the same broken-plugin isolation posture. */
  async ensureWorkspaceHooksForRequest(args: EnsureWorkspaceHooksArgs): Promise<void> {
    try {
      await this.ensureWorkspaceHooks(args);
    } catch (error) {
      log.warn("Agent plugin hooks: ensure failed; continuing without plugin hooks", { error });
    }
  }

  /**
   * Reconcile the workspace's registered plugin hooks with what discovery
   * finds on disk. Cheap when nothing changed (fingerprint over hooks.js
   * sources + grants); loads sandbox mounts and (re)registers spine middleware
   * only on change. Request callers use ensureWorkspaceHooksForRequest to
   * isolate discovery failures: a broken plugin system must never block a send.
   */
  async ensureWorkspaceHooks(args: EnsureWorkspaceHooksArgs): Promise<void> {
    await using _guard = await this.lockFor(args.workspaceId).acquire();

    if (!args.enabled) {
      await this.teardownLocked(args.workspaceId);
      return;
    }

    // Capture the epoch BEFORE discovery: a mutation landing between this
    // read and registration makes the stored token stale, so the dispatch
    // check retires the registration (over-blocking; safe direction).
    const epochStagingRoot = path.join(args.xumHome, STAGING_DIR_NAME);
    const epochToken = await readMutationEpochToken(epochStagingRoot);

    const discovered = await this.discoverHookPlugins(args);
    const fingerprintLines = discovered.map(
      (candidate) =>
        `${candidate.plugin.scope}|${candidate.plugin.containerPath}|${candidate.plugin.dirName}|` +
        `${sha256Hex(candidate.source)}|${JSON.stringify(candidate.grants)}`
    );
    const fingerprint = fingerprintLines.join("\n");

    const existing = this.registrations.get(args.workspaceId);
    if (existing?.fingerprint === fingerprint) {
      // This ensure re-measured everything from disk and found identical
      // content, so the registration is current as of the token captured
      // above — refresh it (an uninstall+identical-reinstall cycle would
      // otherwise leave a permanently stale token that retires the
      // registration on every dispatch).
      existing.epochToken = epochToken;
      // Unchanged configuration. Retry ONLY previously-failed candidates so
      // healthy siblings keep their persistent mounts (cross-turn guest state)
      // instead of being torn down and re-initialized on every send while one
      // plugin stays broken. Still-failing candidates remain in failedLines.
      for (const [candidateIndex, candidate] of discovered.entries()) {
        const line = fingerprintLines[candidateIndex];
        if (line === undefined || !existing.failedLines.has(line)) {
          continue;
        }
        const loaded = await this.loadCandidateLocked(candidate, args);
        if (loaded === null) {
          continue;
        }
        existing.states.push(loaded.state);
        existing.unregisters.push(...loaded.unregisters);
        existing.failedLines.delete(line);
      }
      return;
    }
    await this.teardownLocked(args.workspaceId);
    if (discovered.length === 0) {
      return;
    }

    const unregisters: Array<() => void> = [];
    const states: LoadedPluginHookState[] = [];
    const failedLines = new Set<string>();
    for (const [candidateIndex, candidate] of discovered.entries()) {
      const loaded = await this.loadCandidateLocked(candidate, args);
      if (loaded === null) {
        // Failure isolation: one broken plugin never affects siblings. The
        // recorded line makes the unchanged-fingerprint path above retry it
        // on the next send instead of leaving it disabled for the process
        // lifetime.
        const line = fingerprintLines[candidateIndex];
        if (line !== undefined) {
          failedLines.add(line);
        }
        continue;
      }
      states.push(loaded.state);
      unregisters.push(...loaded.unregisters);
    }

    this.registrations.set(args.workspaceId, {
      fingerprint,
      unregisters,
      states,
      failedLines,
      epochStagingRoot,
      epochToken,
    });
  }

  /**
   * Load one discovered plugin's hooks.js into its persistent mount and
   * register its spine middleware. Returns null on load failure (the mount
   * scope is dropped quietly; callers decide retry bookkeeping).
   */
  private async loadCandidateLocked(
    candidate: DiscoveredHookPlugin,
    args: EnsureWorkspaceHooksArgs
  ): Promise<{ state: LoadedPluginHookState; unregisters: Array<() => void> } | null> {
    const plugin = candidate.plugin;
    const runtimeFactory = await this.getRuntimeFactory();
    // Scope key must be unique per plugin instance AND distinct from the
    // workspace's code_execution mount (different grants would thrash it).
    const scopeKey = `plugin-hooks|${args.workspaceId}|${plugin.scope}|${plugin.containerPath}|${plugin.dirName}`;
    const state: LoadedPluginHookState = {
      pluginName: plugin.name,
      grants: candidate.grants,
      source: candidate.source,
      mountOptions: {
        lifetime: "persistent",
        runtimeFactory,
        scopeKey,
        sessionDir: args.sessionDir,
        grants: candidate.grants,
        // Source hash as bridge identity: editing hooks.js rebuilds the
        // mount, which is the only reliable way to drop stale guest state.
        bridgeKey: `plugin-hooks:${sha256Hex(candidate.source)}`,
      },
      hookNames: [],
      disposed: false,
    };

    try {
      state.hookNames = await this.sandboxHost.withPersistentMount(state.mountOptions, (mount) =>
        this.ensureMountLoaded(mount, state)
      );
    } catch (error) {
      log.warn(
        `Agent plugin hooks: failed to load hooks.js for '${plugin.name}'; skipping this plugin`,
        { error }
      );
      await this.dropScopeQuietly(scopeKey);
      return null;
    }

    const unregisters = state.hookNames.map((hookName) =>
      this.registerHookMiddleware(hookName, state, args)
    );
    return { state, unregisters };
  }

  /** Tear down a workspace's hooks (archive/removal). Never throws. */
  async disposeWorkspace(workspaceId: string): Promise<void> {
    try {
      await using _guard = await this.lockFor(workspaceId).acquire();
      await this.teardownLocked(workspaceId);
    } catch (error) {
      log.warn(`Agent plugin hooks: dispose failed for workspace ${workspaceId}`, { error });
    }
  }

  // --- discovery ---

  private async discoverHookPlugins(
    args: EnsureWorkspaceHooksArgs
  ): Promise<DiscoveredHookPlugin[]> {
    const containers: AgentPluginContainer[] = this.computeContainers({
      xumHome: args.xumHome,
      projectRoot: args.projectRoot,
      projectTrusted: args.projectTrusted,
    });
    const { plugins } = await discoverAgentPlugins(containers);

    const result: DiscoveredHookPlugin[] = [];
    for (const plugin of plugins) {
      if (plugin.hooksPath === undefined) {
        continue;
      }
      if (plugin.scope === "project") {
        // Same repo-symlink posture as plugin MCP config: the plugin root
        // itself must stay inside the trusted checkout.
        assert(args.projectRoot, "project-scope plugins require a projectRoot");
        try {
          await ensurePathContained(args.projectRoot, plugin.rootPath);
        } catch (error) {
          log.warn(
            `Agent plugin hooks: skipping project plugin '${plugin.name}': plugin root escapes the project root: ${getErrorMessage(error)}`
          );
          continue;
        }
      }
      let source: string;
      try {
        source = await readHookSourceCapped(plugin.hooksPath, plugin.rootPath);
      } catch (error) {
        log.warn(`Agent plugin hooks: failed to read ${plugin.hooksPath}; skipping`, { error });
        continue;
      }
      result.push({ plugin, source, grants: resolvePluginHookGrants(plugin.manifest) });
    }
    return result;
  }

  // --- loading ---

  private async getRuntimeFactory(): Promise<IJSRuntimeFactory> {
    this.runtimeFactory ??= await this.runtimeFactoryLoader();
    return this.runtimeFactory;
  }

  /** Load the plugin's hooks.js into the mount once (per mount instance). */
  private async ensureMountLoaded(
    mount: SandboxMount,
    state: LoadedPluginHookState
  ): Promise<PluginHookPoint[]> {
    if (this.loadedMounts.has(mount)) {
      return state.hookNames;
    }
    mount.runtime.setLimits({ timeoutMs: this.hookTimeoutMs });
    const result = await mount.runtime.eval(
      buildHookLoadScript({ source: state.source, grants: state.grants })
    );
    if (!result.success) {
      throw new Error(`hooks.js load failed: ${result.error ?? "unknown error"}`);
    }
    const hookNames = parseLoadedHookNames(result.result);
    this.loadedMounts.add(mount);
    return hookNames;
  }

  // --- spine adapters ---

  private registerHookMiddleware(
    hookName: PluginHookPoint,
    state: LoadedPluginHookState,
    args: EnsureWorkspaceHooksArgs
  ): () => void {
    switch (hookName) {
      case "tool.execute.before":
        return this.spine.useBefore("tool.execute", (ctx) =>
          this.runToolExecuteBefore(ctx, state, args.workspaceId)
        );
      case "tool.execute.after":
        return this.spine.useAfter("tool.execute", (ctx) =>
          this.runToolExecuteAfter(ctx, state, args.workspaceId)
        );
      case "request.assemble":
        return this.spine.useRequestContext((ctx) => this.runRequestAssemble(ctx, state, args), {
          workspaceId: args.workspaceId,
        });
    }
  }

  private async runToolExecuteBefore(
    ctx: ToolExecuteContext,
    state: LoadedPluginHookState,
    workspaceId: string
  ): Promise<void> {
    if (ctx.host.workspaceId !== workspaceId) {
      return;
    }
    // Bounded mutation: a hook neither sees nor touches tools outside its grants.
    if (!isBridgeToolGranted(state.grants, ctx.toolName)) {
      return;
    }
    const output = await this.invokeHook(workspaceId, state, "tool.execute.before", {
      toolName: ctx.toolName,
      args: ctx.args,
      workspaceId,
      cwd: ctx.host.cwd,
    });
    if (output === null) {
      return;
    }
    const deny = output.deny;
    if (typeof deny === "string" && deny.length > 0) {
      // Denials are honored as tool errors visible to the model (same result
      // shape as shell pre-hook blocks).
      ctx.blocked = {
        result: { error: `Tool call blocked by plugin '${state.pluginName}' hook: ${deny}` },
      };
      return;
    }
    // JSON round-trip means a present `args` key is an intentional rewrite
    // (JSON cannot carry undefined). Only plain objects are accepted: tool
    // executors destructure their input, and a null/array/scalar rewrite
    // would bypass the AI SDK's input validation and throw inside the tool —
    // a malformed hook must stay an isolated failure (keep original args).
    if (Object.hasOwn(output, "args")) {
      const rewrite = output.args;
      if (rewrite !== null && typeof rewrite === "object" && !Array.isArray(rewrite)) {
        ctx.args = rewrite;
      } else {
        log.warn(
          `Agent plugin hooks: '${state.pluginName}' tool.execute.before returned a non-object args rewrite; keeping original args`,
          { toolName: ctx.toolName }
        );
      }
    }
  }

  private async runToolExecuteAfter(
    ctx: ToolExecuteContext,
    state: LoadedPluginHookState,
    workspaceId: string
  ): Promise<void> {
    if (ctx.host.workspaceId !== workspaceId) {
      return;
    }
    if (!isBridgeToolGranted(state.grants, ctx.toolName)) {
      return;
    }
    if (!ctx.executed) {
      return;
    }
    const input: Record<string, unknown> = {
      toolName: ctx.toolName,
      args: ctx.args,
      workspaceId,
    };
    try {
      // Results can be huge or non-JSON (streaming iterables); omit rather
      // than fail the hook. `resultOmitted` tells the hook why.
      const resultJson: string | undefined = JSON.stringify(ctx.result);
      if (typeof resultJson === "string" && resultJson.length <= HOOK_RESULT_INPUT_MAX_CHARS) {
        input.result = ctx.result;
      } else {
        input.resultOmitted = true;
      }
    } catch {
      input.resultOmitted = true;
    }
    const output = await this.invokeHook(workspaceId, state, "tool.execute.after", input);
    const annotation = output?.annotation;
    if (typeof annotation === "string" && annotation.length > 0) {
      ctx.result = annotateResult(ctx.result, annotation, state.pluginName);
    }
  }

  private async runRequestAssemble(
    ctx: RequestContextOnly,
    state: LoadedPluginHookState,
    args: EnsureWorkspaceHooksArgs
  ): Promise<void> {
    if (ctx.workspaceId !== args.workspaceId) {
      return;
    }
    const output = await this.invokeHook(args.workspaceId, state, "request.assemble", {
      workspaceId: args.workspaceId,
      modelString: ctx.modelString,
    });
    const context = output?.context;
    if (typeof context !== "string" || context.length === 0) {
      return;
    }
    if (context.length > HOOK_CONTEXT_MAX_CHARS) {
      log.warn(
        `Agent plugin hooks: '${state.pluginName}' request.assemble context exceeds ${HOOK_CONTEXT_MAX_CHARS} chars; dropping`
      );
      return;
    }
    // Log purity ("model-visible ⟹ logged"): materialize the durable
    // hook-context row BEFORE mutating the request. If the row cannot be
    // persisted, the content must not become model-visible.
    const hookId = `plugin:${state.pluginName}:request.assemble`;
    try {
      if (context.length <= HOOK_CONTEXT_INLINE_MAX_CHARS) {
        await args.journal.append({
          workspaceId: args.workspaceId,
          kind: "hook-context",
          data: { hookId, placement: "system-prompt", text: context },
        });
      } else {
        // publishWithBlob: put + append under the journal blob lock so a
        // concurrent reclamation pass can never treat the freshly stored
        // blob as unreferenced (content addressing can share hashes).
        await args.journal.publishWithBlob(context, (ref) => ({
          workspaceId: args.workspaceId,
          kind: "hook-context",
          data: { hookId, placement: "system-prompt", blobHash: ref },
        }));
      }
    } catch (error) {
      log.warn(
        `Agent plugin hooks: failed to journal '${state.pluginName}' context; dropping it from the request`,
        { error }
      );
      return;
    }
    ctx.systemMessage = `${ctx.systemMessage}\n\n${context}`;
  }

  // --- invocation ---

  /**
   * Revalidate the registration's managed-container mutation epoch before a
   * hook sees any input. A committed install/update/uninstall (this process
   * or a sibling — the epoch file is the cross-process commit signal) must
   * stop already-registered hooks from observing tool args/results or
   * injecting rewrites/denials/context for the rest of the current stream;
   * without this they would survive until the workspace's next send calls
   * ensureWorkspaceHooks. On staleness the registration is torn down and the
   * invocation is refused; the next send re-discovers from disk.
   */
  private async retireIfEpochStale(workspaceId: string): Promise<boolean> {
    const registration = this.registrations.get(workspaceId);
    if (!registration) {
      // Torn down since the middleware fired (teardown unregisters first,
      // but an in-flight dispatch may already hold the callback).
      return true;
    }
    const current = await readMutationEpochToken(registration.epochStagingRoot);
    if (current === registration.epochToken) {
      return false;
    }
    await using _guard = await this.lockFor(workspaceId).acquire();
    // Recheck under the lock: a concurrent ensure may have already replaced
    // the registration with a freshly-discovered (current) one.
    if (this.registrations.get(workspaceId) === registration) {
      log.info(
        `Agent plugin hooks: managed plugin mutation detected; retiring workspace ${workspaceId} hooks until the next send`
      );
      await this.teardownLocked(workspaceId);
    }
    return true;
  }

  /**
   * Invoke one hook in the plugin's mount. Returns null on any failure
   * (crash, timeout, malformed output) — log, skip, continue.
   */
  private async invokeHook(
    workspaceId: string,
    state: LoadedPluginHookState,
    hookName: PluginHookPoint,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    if (state.disposed) {
      return null;
    }
    if (await this.retireIfEpochStale(workspaceId)) {
      return null;
    }
    if (state.disposed) {
      // Re-check: the epoch validation above may have awaited; a concurrent
      // teardown could have disposed this state in the meantime.
      return null;
    }
    try {
      const inputJson = JSON.stringify(input);
      assert(typeof inputJson === "string", "hook input must be JSON-serializable");
      const evalResult = await this.sandboxHost.withPersistentMount(
        state.mountOptions,
        async (mount) => {
          await this.ensureMountLoaded(mount, state);
          return await mount.runtime.eval(buildHookInvokeScript(hookName, inputJson));
        }
      );
      if (!evalResult.success) {
        log.warn(
          `Agent plugin hooks: '${state.pluginName}' ${hookName} failed; continuing without it`,
          { error: evalResult.error }
        );
        return null;
      }
      return parseHookOutput(evalResult.result);
    } catch (error) {
      log.warn(
        `Agent plugin hooks: '${state.pluginName}' ${hookName} errored; continuing without it`,
        { error }
      );
      return null;
    }
  }

  // --- lifecycle ---

  private lockFor(workspaceId: string): AsyncMutex {
    let lock = this.locks.get(workspaceId);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(workspaceId, lock);
    }
    return lock;
  }

  /** Caller must hold the workspace lock. */
  private async teardownLocked(workspaceId: string): Promise<void> {
    const existing = this.registrations.get(workspaceId);
    if (!existing) {
      return;
    }
    this.registrations.delete(workspaceId);
    for (const unregister of existing.unregisters) {
      unregister();
    }
    for (const state of existing.states) {
      // Stops in-flight invocations from re-creating the dropped mount. A
      // middleware call already past this check may still recreate one stray
      // mount; it stays inert (unreachable state) until disposeAll.
      state.disposed = true;
      const scopeKey = state.mountOptions.scopeKey;
      assert(scopeKey, "plugin hook mounts always carry a scopeKey");
      await this.dropScopeQuietly(scopeKey);
    }
  }

  private async dropScopeQuietly(scopeKey: string): Promise<void> {
    try {
      // dropScope (not disposeScope): hook mounts have no vars to snapshot,
      // so no disk writes are wanted here.
      await this.sandboxHost.dropScope(scopeKey);
    } catch (error) {
      log.warn(`Agent plugin hooks: failed to drop sandbox scope ${scopeKey}`, { error });
    }
  }
}

/**
 * Annotate a tool result with model-visible hook feedback, mirroring the
 * shell hook `hook_output` convention. v1 annotates plain object results
 * only; streaming iterables and primitives pass through untouched.
 */
function annotateResult(result: unknown, annotation: string, pluginName: string): unknown {
  const note = `[plugin:${pluginName}] ${annotation}`;
  if (result !== null && typeof result === "object" && !(Symbol.asyncIterator in result)) {
    const existing = (result as { hook_output?: unknown }).hook_output;
    const merged =
      typeof existing === "string" && existing.length > 0 ? `${existing}\n${note}` : note;
    return { ...result, hook_output: merged };
  }
  log.debug(`Agent plugin hooks: '${pluginName}' annotation skipped (non-object tool result)`);
  return result;
}

/**
 * Read hooks.js through one file handle with a same-handle size check.
 * Discovery's stat-based cap and this read are separated by an update-sized
 * TOCTOU window — a managed update can promote a replacement tree between
 * them, making the canonical path name a file discovery never measured — so
 * the ceiling must be enforced at the read itself. Reading exactly the
 * fstat-reported byte count through the same handle also bounds the read if
 * the file grows mid-read. Exported for tests.
 */
export async function readHookSourceCapped(hooksPath: string, pluginRoot: string): Promise<string> {
  const result = await readPluginFileWithinRootCapped({
    filePath: hooksPath,
    pluginRoot,
    maxBytes: MAX_PLUGIN_HOOK_SOURCE_BYTES,
    label: "hooks.js",
  });
  return result.content;
}

/** Process-wide singleton (mirrors eventSpine/sandboxHostService). */
export const agentPluginHookService = new AgentPluginHookService();
