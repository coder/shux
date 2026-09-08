/**
 * Tool assembly: applies tool policy and PTC (Programmatic Tool Calling) experiments.
 *
 * Extracted from `streamMessage()` to isolate the tool policy + PTC experiment
 * concerns (including lazy-loading of heavy PTC dependencies: typescript,
 * prettier, QuickJS WASM).
 *
 * The function takes pre-assembled tools from `getToolsForModel()` and returns
 * the final tool set after policy filtering and PTC wrapping.
 */

import type { Tool } from "ai";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { getErrorMessage } from "@/common/utils/errors";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { SendMessageOptions } from "@/common/orpc/types";

/** Renderer-sent experiment flags (SendMessageOptions.experiments). */
type SendMessageExperiments = SendMessageOptions["experiments"];

import {
  applyToolPolicy,
  applyToolPolicyToNames,
  buildRequiredToolPatterns,
  type ToolPolicy,
} from "@/common/utils/tools/toolPolicy";
import { applyCapabilityGrants } from "@/common/utils/tools/capabilityGrants";
import type { CapabilityGrants } from "@/common/types/capabilityGrants";
// PTC types only — modules lazy-loaded to avoid loading typescript/prettier at startup
import type {
  PTCEventWithParent,
  createCodeExecutionTool as CreateCodeExecutionToolFn,
} from "@/node/services/tools/code_execution";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { PTCExecutionResult } from "@/node/services/ptc/types";
import { sandboxHostService, type SandboxMount } from "@/node/services/sandbox/sandboxHostService";
import { createRefinementRollbackTool } from "@/node/services/tools/refinement_rollback";
import type { KernelFileLoader } from "@/node/services/tools/kernelFileLoad";
import { log } from "./log";
import type { MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getRuntimeTypeForTelemetry, roundToBase2 } from "@/common/telemetry/utils";

// ---------------------------------------------------------------------------
// PTC Lazy-Loading Singleton
// ---------------------------------------------------------------------------

// Lazy-loaded PTC modules (only loaded when experiment is enabled).
// This avoids loading typescript/prettier at startup which causes issues:
// - Integration tests fail without --experimental-vm-modules (prettier uses dynamic imports)
// - Smoke tests fail if typescript isn't in production bundle
// Dynamic imports are justified: PTC pulls in ~10MB of dependencies that would slow startup.
interface PTCModules {
  createCodeExecutionTool: typeof CreateCodeExecutionToolFn;
  QuickJSRuntimeFactory: typeof QuickJSRuntimeFactory;
  ToolBridge: typeof ToolBridge;
  runtimeFactory: QuickJSRuntimeFactory | null;
}
let ptcModules: PTCModules | null = null;

async function getPTCModules(): Promise<PTCModules> {
  if (ptcModules) return ptcModules;

  /* eslint-disable no-restricted-syntax -- Dynamic imports required here to avoid loading
     ~10MB of typescript/prettier/quickjs at startup (causes CI failures) */
  const [codeExecution, quickjs, toolBridge] = await Promise.all([
    import("@/node/services/tools/code_execution"),
    import("@/node/services/ptc/quickjsRuntime"),
    import("@/node/services/ptc/toolBridge"),
  ]);
  /* eslint-enable no-restricted-syntax */

  ptcModules = {
    createCodeExecutionTool: codeExecution.createCodeExecutionTool,
    QuickJSRuntimeFactory: quickjs.QuickJSRuntimeFactory,
    ToolBridge: toolBridge.ToolBridge,
    runtimeFactory: null,
  };
  return ptcModules;
}

// ---------------------------------------------------------------------------
// Tool Policy + PTC Application
// ---------------------------------------------------------------------------

/** Options for applying tool policy and PTC experiments. */
export interface ApplyToolPolicyAndExperimentsOptions {
  /** Tools from `getToolsForModel()` (before policy or PTC). */
  allTools: Record<string, Tool>;
  /** CLI-injected extra tools (bypass policy since they're runtime-provided). */
  extraTools?: Record<string, Tool>;
  /** Composed tool policy (agent → caller → system workspace). */
  effectiveToolPolicy: ToolPolicy | undefined;
  /** PTC experiment flags. */
  experiments?: {
    tokenBudget?: boolean;
    programmaticToolCalling?: boolean;
    /**
     * RLM mode: graduate code_execution onto the persistent per-workspace
     * kernel mount (shared `vars`, snapshot/restore). Gated on the PTC parent
     * by construction — this flag is only read inside the PTC branch below.
     */
    rlm?: boolean;
  };
  /** Callback to forward nested PTC tool events to the stream. */
  emitNestedToolEvent: (event: PTCEventWithParent) => void;
  /**
   * Sandbox host context for code_execution. When set AND persistent mounts
   * are enabled (RLM mode experiment or MUX_SANDBOX_PERSISTENT_MOUNTS=1),
   * code_execution reuses a per-workspace persistent mount (shared `vars`,
   * snapshot/restore) instead of an ephemeral per-call runtime.
   * kernelFileLoader backs mux.load (r12 bulk ingestion) — built by the
   * caller from the workspace cwd/runtime pair the file tools use; only
   * honored in kernel mode with file_read bridged.
   */
  sandbox?: { workspaceId: string; sessionDir: string; kernelFileLoader?: KernelFileLoader };
  /**
   * Capability grants for this assembly (registry-with-filters posture).
   * Omitted = session-scope full grants (identical to pre-grants behavior).
   * Enforced here (tool visibility) and at the sandbox bridge boundary
   * (ToolBridge stubs/denies non-granted mux.* calls).
   */
  capabilityGrants?: CapabilityGrants;
}

/** Env opt-in for persistent code_execution mounts (dogfooding/Track 2). */
export function persistentSandboxMountsEnabled(): boolean {
  return resolveXumEnvironmentValue("SANDBOX_PERSISTENT_MOUNTS", process.env) === "1";
}

/**
 * Backfill the PTC/RLM experiment pair from the backend's persisted overrides
 * (same `?? isExperimentEnabled` pattern as other backend-gated experiments in
 * streamMessage). A renderer with no origin-local override sends `undefined`
 * for these flags while the effective UI and /refine gate resolve against the
 * backend override — tool assembly must agree or a persisted-RLM workspace
 * silently streams with the non-persistent flat/PTC toolset. Explicit
 * renderer values (true or false) always win over the backend fallback.
 */
export function resolveBackendGatedPtcExperiments(
  experiments: SendMessageExperiments | undefined,
  isExperimentEnabled: (experimentId: ExperimentId) => boolean
): NonNullable<SendMessageExperiments> {
  return {
    ...experiments,
    programmaticToolCalling:
      experiments?.programmaticToolCalling ??
      isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
    rlm: experiments?.rlm ?? isExperimentEnabled(EXPERIMENT_IDS.RLM),
    tokenBudget: experiments?.tokenBudget ?? isExperimentEnabled(EXPERIMENT_IDS.TOKEN_BUDGET),
  };
}

/**
 * Apply tool policy, then wrap with PTC code_execution if experiments are enabled.
 *
 * Steps:
 * 1. Merge extra tools (CLI tools bypass policy — injected by runtime, not user)
 * 2. Apply tool policy (agent → caller → system workspace deny/enable rules)
 * 3. If PTC experiment is enabled, lazy-load PTC and create code_execution tool,
 *    replacing bridgeable tools with code_execution only (exclusive posture).
 *    A supplement mode (code_execution alongside the flat tools) used to exist
 *    but measured ~2x tokens/cost vs both PTC-off and exclusive, so it was
 *    removed.
 *
 * @returns The final tool set ready for the AI model.
 */
export async function applyToolPolicyAndExperiments(
  opts: ApplyToolPolicyAndExperimentsOptions
): Promise<Record<string, Tool>> {
  const { allTools, extraTools, effectiveToolPolicy, experiments, emitNestedToolEvent, sandbox } =
    opts;

  // Merge in extra tools (e.g., CLI-specific tools like set_exit_code).
  // These bypass policy filtering since they're injected by the runtime, not user config.
  const allToolsWithExtra = extraTools ? { ...allTools, ...extraTools } : allTools;

  // Capability grants are a ceiling applied before policy: policy can narrow
  // further but can never re-add a non-granted tool.
  const grantFilteredTools = opts.capabilityGrants
    ? applyCapabilityGrants(allToolsWithExtra, opts.capabilityGrants)
    : allToolsWithExtra;

  // Apply tool policy FIRST — this must happen before PTC to ensure the sandbox
  // respects allow/deny filters. The policy-filtered tools are passed to
  // ToolBridge so the mux.* API only exposes policy-allowed tools.
  const policyFilteredTools = applyToolPolicy(grantFilteredTools, effectiveToolPolicy);

  // The bridge is built from the PRE-grant policy-filtered set: ToolBridge
  // must see grant-denied tools so it can stub them with a catchable
  // "Capability denied" guest error (not a confusing "mux.x is not a
  // function"). Model-visible sets below still use the grant-filtered tools.
  const policyFilteredPreGrant = opts.capabilityGrants
    ? applyToolPolicy(allToolsWithExtra, effectiveToolPolicy)
    : policyFilteredTools;

  // Handle PTC experiment — replace bridgeable tools with code_execution.
  let toolsForModel = policyFilteredTools;
  // RLM rides the PTC parent flag: this flag is only read inside the PTC
  // branch below, so RLM alone (PTC off) is inert by construction.
  const rlmActive = experiments?.rlm === true;
  // A policy that disables EVERY tool (e.g. auto-compaction's `.*` disable
  // rule, inherited alongside the original send's experiment flags) is a
  // no-tools contract: synthesizing code_execution anyway would hand that
  // flow a tool it explicitly forbade. Checked on the PRE-grant policy
  // result so a least-privilege grants ceiling (which stubs, not disables)
  // keeps code_execution as the mandatory bridge entry point. The synthesized
  // name is probed explicitly: an allowlist like [disable .*, enable
  // code_execution] empties the base record yet clearly intends the exclusive
  // entry point to exist, so the base-tool record alone cannot decide.
  const policyLeavesNoTools =
    Object.keys(policyFilteredPreGrant).length === 0 &&
    applyToolPolicyToNames(["code_execution"], effectiveToolPolicy).length === 0;
  if (experiments?.programmaticToolCalling && !policyLeavesNoTools) {
    try {
      // Lazy-load PTC modules only when experiments are enabled
      const ptc = await getPTCModules();

      // Keep mcp_prompt_get direct because sandbox declarations omit its
      // multiline prompt catalog.
      const promptGet = policyFilteredTools.mcp_prompt_get;
      // Policy-REQUIRED tools stay model-visible: "require" gates run
      // completion on a top-level toolResult for that name
      // (StreamManager.createStopWhenCondition), which a nested xum.* call
      // inside a code_execution record never satisfies. Sourced from the
      // grant-and-policy-filtered record so both ceilings still apply.
      const requiredPatterns = buildRequiredToolPatterns(effectiveToolPolicy);
      const requiredTools = Object.fromEntries(
        Object.entries(policyFilteredTools).filter(([name]) =>
          requiredPatterns.some((pattern) => pattern.test(name))
        )
      );

      // Tools promoted to the model-visible set must NOT also stay bridged:
      // the request.assemble hook contract lets middleware filter or wrap
      // top-level tools, and a bridged duplicate would keep dispatching the
      // pre-hook implementation behind the hook's back (the assemble-hook
      // rebuild machinery was removed on the premise that bridged tools are
      // never hook-visible — promotion must preserve that premise).
      const promotedToolNames = new Set(Object.keys(requiredTools));
      if (promptGet !== undefined) {
        promotedToolNames.add("mcp_prompt_get");
      }

      // ToolBridge uses the pre-grant policy-filtered tools — the bridge
      // enforces grants itself (denied tools become explicit error stubs).
      const bridgeInput = Object.fromEntries(
        Object.entries(policyFilteredPreGrant).filter(([name]) => !promotedToolNames.has(name))
      );
      const toolBridge = new ptc.ToolBridge(bridgeInput, opts.capabilityGrants);

      // Singleton runtime factory (WASM module is expensive to load)
      ptc.runtimeFactory ??= new ptc.QuickJSRuntimeFactory();
      const runtimeFactory = ptc.runtimeFactory;

      // Persistent mount opt-in: reuse one per-workspace guest across calls.
      // Grants must flow through: the mount enforces vars/hostEvents exposure,
      // so omitting them here would silently widen to full session grants.
      // bridgeKey identifies the effective bridgeable tool NAMES so the mount
      // is rebuilt when policy changes what the sandbox may reach. Names-only
      // is sufficient for same-name replacements: guest method references
      // dispatch through the runtime's current registration (see
      // QuickJSRuntime.registerObject), so re-registering the fresh bridge
      // retargets even guest-saved references to the newest implementation.
      // The lease runner (withPersistentMount) holds the scope lock from
      // acquisition through execution.
      const bridgeKey = toolBridge.getBridgeableToolNames().sort().join(",");
      // RLM mode is the user-facing opt-in; the env var stays as a dev/test
      // override so persistent mounts can be dogfooded without the experiment.
      const withMount =
        sandbox && (experiments?.rlm === true || persistentSandboxMountsEnabled())
          ? (fn: (mount: SandboxMount) => Promise<PTCExecutionResult>) =>
              sandboxHostService.withPersistentMount(
                {
                  lifetime: "persistent",
                  runtimeFactory,
                  scopeKey: sandbox.workspaceId,
                  sessionDir: sandbox.sessionDir,
                  grants: opts.capabilityGrants,
                  bridgeKey,
                },
                fn
              )
          : undefined;

      const codeExecutionTool = await ptc.createCodeExecutionTool(
        runtimeFactory,
        toolBridge,
        emitNestedToolEvent,
        withMount,
        // Kernel-first description preamble rides RLM; PTC alone (or the
        // env-var mount override) keeps the non-kernel exclusive descriptions.
        // createCodeExecutionTool additionally requires a live persistent
        // mount before honoring it.
        {
          kernelFirst: rlmActive,
          loadFile: sandbox?.kernelFileLoader,
        }
      );

      // code_execution is mandatory — it's the only way to use bridged
      // tools. The experiment flag is the opt-in; policy cannot disable it here since
      // that would leave no way to access tools. nonBridgeable is policy-filtered but
      // comes from the PRE-grant bridge input, so re-apply the grants ceiling here to
      // keep grant-denied non-bridgeable tools out of the model-visible set.
      const nonBridgeable = opts.capabilityGrants
        ? applyCapabilityGrants(toolBridge.getNonBridgeableTools(), opts.capabilityGrants)
        : toolBridge.getNonBridgeableTools();
      toolsForModel = {
        ...nonBridgeable,
        ...requiredTools,
        ...(promptGet !== undefined ? { mcp_prompt_get: promptGet } : {}),
        code_execution: codeExecutionTool,
      };

      // RLM-only model surface: ID-addressed rollback of journaled harness
      // self-modifications (refinement rows). Read inside the PTC branch by
      // construction (RLM is nested under the PTC parent) — with the
      // experiment off the tool never exists and provider requests stay
      // byte-identical. The env-var mount override deliberately does NOT
      // expose it: persistent mounts are a dev override, RLM is the opt-in.
      if (experiments?.rlm === true && sandbox) {
        // Policy and grants are both ceilings over the whole model-visible
        // set; this tool is synthesized after they were applied above, so
        // re-apply BOTH here — a least-privilege assembly (or a policy that
        // disables the tool, e.g. a broad regex disable rule) must not gain a
        // harness-rollback surface. Unlike code_execution in exclusive mode,
        // rollback is never mandatory, so policy may freely remove it.
        let rollback: Record<string, Tool> = {
          refinement_rollback: createRefinementRollbackTool(sandbox),
        };
        rollback = applyToolPolicy(rollback, effectiveToolPolicy);
        if (opts.capabilityGrants) {
          rollback = applyCapabilityGrants(rollback, opts.capabilityGrants);
        }
        toolsForModel = { ...toolsForModel, ...rollback };
      }
    } catch (error) {
      // PTC fails CLOSED (r49): the experiment is exclusive-only, so silently
      // degrading to the complete flat toolset would change user-visible
      // semantics while the run is still recorded as PTC (corrupting
      // experiment results) — and for RLM would additionally drop the
      // persistent kernel's nested-result context isolation. Surfacing the
      // failure lets the send fail visibly and the user retry once the cause
      // (e.g. QuickJS WASM load) clears.
      throw new Error(
        `PTC exclusive assembly failed and must not silently fall back to flat tools: ${getErrorMessage(error)}`
      );
    }
  }

  return toolsForModel;
}

// ---------------------------------------------------------------------------
// MCP Telemetry
// ---------------------------------------------------------------------------

/** Capture MCP tool configuration telemetry and log the final tool set. */
export function captureMcpToolTelemetry(opts: {
  telemetryService?: TelemetryService;
  mcpStats: MCPWorkspaceStats | undefined;
  mcpTools: Record<string, Tool> | undefined;
  tools: Record<string, Tool>;
  mcpSetupDurationMs: number;
  workspaceId: string;
  modelString: string;
  effectiveAgentId: string;
  metadata: WorkspaceMetadata;
  effectiveToolPolicy: ToolPolicy | undefined;
}): void {
  const {
    telemetryService,
    mcpStats,
    mcpTools,
    tools,
    mcpSetupDurationMs,
    workspaceId,
    modelString,
    effectiveAgentId,
    metadata,
    effectiveToolPolicy,
  } = opts;

  const effectiveMcpStats: MCPWorkspaceStats =
    mcpStats ??
    ({
      enabledServerCount: 0,
      startedServerCount: 0,
      failedServerCount: 0,
      autoFallbackCount: 0,
      failedServerNames: [],
      hasStdio: false,
      hasHttp: false,
      hasSse: false,
      transportMode: "none",
    } satisfies MCPWorkspaceStats);

  const mcpToolNames = new Set(Object.keys(mcpTools ?? {}));
  const toolNames = Object.keys(tools);
  const mcpToolCount = toolNames.filter((name) => mcpToolNames.has(name)).length;
  const totalToolCount = toolNames.length;
  const builtinToolCount = Math.max(0, totalToolCount - mcpToolCount);

  telemetryService?.capture({
    event: "mcp_context_injected",
    properties: {
      workspaceId,
      model: modelString,
      agentId: effectiveAgentId,
      runtimeType: getRuntimeTypeForTelemetry(metadata.runtimeConfig),

      mcp_server_enabled_count: effectiveMcpStats.enabledServerCount,
      mcp_server_started_count: effectiveMcpStats.startedServerCount,
      mcp_server_failed_count: effectiveMcpStats.failedServerCount,

      mcp_tool_count: mcpToolCount,
      total_tool_count: totalToolCount,
      builtin_tool_count: builtinToolCount,

      mcp_transport_mode: effectiveMcpStats.transportMode,
      mcp_has_http: effectiveMcpStats.hasHttp,
      mcp_has_sse: effectiveMcpStats.hasSse,
      mcp_has_stdio: effectiveMcpStats.hasStdio,
      mcp_auto_fallback_count: effectiveMcpStats.autoFallbackCount,
      mcp_setup_duration_ms_b2: roundToBase2(mcpSetupDurationMs),
    },
  });

  log.info("AIService.streamMessage: tool configuration", {
    workspaceId,
    model: modelString,
    toolNames: Object.keys(tools),
    hasToolPolicy: Boolean(effectiveToolPolicy),
  });
}
