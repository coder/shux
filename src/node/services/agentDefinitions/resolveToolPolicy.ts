import {
  collectToolConfigsFromResolvedChain,
  isPlanLikeInResolvedChain,
  normalizeLiteralRequiredToolPattern,
  type ToolsConfig,
} from "@/common/utils/agentTools";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/**
 * Minimal agent structure needed for tool policy resolution.
 * Compatible with AgentForInheritance from resolveAgentInheritanceChain.
 */
export interface AgentLikeForPolicy {
  tools?: ToolsConfig;
}

export interface ResolveToolPolicyOptions {
  /**
   * Pre-resolved inheritance chain from resolveAgentInheritanceChain.
   * Ordered child → base (selected agent first, then its base, etc.).
   */
  agents: readonly AgentLikeForPolicy[];
  isSubagent: boolean;
  disableTaskToolsForDepth: boolean;
  /** Whether the advisor tool is eligible for this agent (experiment on + per-agent config) */
  advisorEnabled?: boolean;
}

// Tools that are never allowed in autonomous sub-agent flows.
// Single source of truth: SUBAGENT_HARD_DENY is derived from this list.
const SUBAGENT_HARD_DENIED_TOOLS = ["ask_user_question"] as const;

const SUBAGENT_HARD_DENY: ToolPolicy = SUBAGENT_HARD_DENIED_TOOLS.map((tool) => ({
  regex_match: tool,
  action: "disable" as const,
}));

const DEPTH_HARD_DENY: ToolPolicy = [
  { regex_match: "task", action: "disable" },
  { regex_match: "task_.*", action: "disable" },
];

function matchesToolPattern(pattern: string, toolName: string): boolean {
  try {
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(toolName);
  } catch {
    return false;
  }
}

function matchesSubagentHardDeniedTool(pattern: string): boolean {
  return SUBAGENT_HARD_DENIED_TOOLS.some((toolName) => matchesToolPattern(pattern, toolName));
}

/**
 * Resolves tool policy for an agent, including inherited tools from base agents.
 *
 * The policy is built from:
 * 1. Inheritance chain processed base → child:
 *    - Each layer's `tools.add` patterns (enable)
 *    - Each layer's `tools.remove` patterns (disable)
 *    - Effective `tools.require` pattern (require), where child layers override base layers
 * 2. Runtime restrictions (subagent limits, depth limits) applied last
 *
 * Example: ask (base: exec)
 * - exec has add: [.*], remove: [propose_plan, ask_user_question]
 * - ask has remove: [file_edit_.*]
 * - Result: deny-all → enable .* → disable propose_plan → disable ask_user_question → disable file_edit_.*
 *
 * Subagent completion tool is mode-dependent:
 * - plan-like subagents: enable `propose_plan`, disable `agent_report`
 * - non-plan subagents: disable `propose_plan`, enable `agent_report`
 */
export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const { agents, isSubagent, disableTaskToolsForDepth } = options;

  // History recovery uses the deny-all baseline too: enabling its experiment
  // must not widen a deliberately narrow agent allowlist.
  const agentPolicy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

  // Process inheritance chain: base → child
  const configs = collectToolConfigsFromResolvedChain(agents);
  let effectiveRequirePattern: string | undefined;
  for (const config of configs) {
    // Enable tools from add list (treated as regex patterns)
    if (config.add) {
      for (const pattern of config.add) {
        const trimmed = pattern.trim();
        if (trimmed.length > 0) {
          agentPolicy.push({ regex_match: trimmed, action: "enable" });
        }
      }
    }

    // Disable tools from remove list
    if (config.remove) {
      for (const pattern of config.remove) {
        const trimmed = pattern.trim();
        if (trimmed.length > 0) {
          agentPolicy.push({ regex_match: trimmed, action: "disable" });
        }
      }
    }

    // Require tools from require list. Child layers override base layers and
    // the last entry in each list wins so policy construction can never emit
    // multiple required tools.
    if (config.require) {
      const cleanedPatterns = config.require
        .map((pattern) => normalizeLiteralRequiredToolPattern(pattern))
        .filter((pattern): pattern is string => pattern !== undefined);
      effectiveRequirePattern = cleanedPatterns.at(-1);
    }
  }

  if (effectiveRequirePattern) {
    // Subagents must not require tools that are hard-denied at runtime: a disabled
    // required tool can collapse the entire toolset. Legacy non-plan agents may still
    // require agent_report from the old terminal-tool contract; drop that requirement
    // so progress updates cannot stop the turn before the final assistant response.
    const isLegacySubagentAgentReportRequire =
      isSubagent &&
      effectiveRequirePattern === "agent_report" &&
      !isPlanLikeInResolvedChain(agents);
    if (
      !isLegacySubagentAgentReportRequire &&
      !(isSubagent && matchesSubagentHardDeniedTool(effectiveRequirePattern))
    ) {
      agentPolicy.push({ regex_match: effectiveRequirePattern, action: "require" });
    }
  }

  // Runtime restrictions (applied last, cannot be overridden)
  const runtimePolicy: ToolPolicy = [];

  if (disableTaskToolsForDepth) {
    runtimePolicy.push(...DEPTH_HARD_DENY);
  }

  if (isSubagent) {
    runtimePolicy.push(...SUBAGENT_HARD_DENY);

    const isPlanLikeSubagent = isPlanLikeInResolvedChain(agents);
    if (isPlanLikeSubagent) {
      // Plan-mode subagents must finish by proposing a plan, not by reporting.
      runtimePolicy.push({ regex_match: "propose_plan", action: "require" });
      runtimePolicy.push({ regex_match: "agent_report", action: "disable" });
    } else {
      // Non-plan subagents complete with their final assistant message. agent_report remains
      // available for optional incremental updates that wake the parent while work continues.
      runtimePolicy.push({ regex_match: "propose_plan", action: "disable" });
      runtimePolicy.push({ regex_match: "agent_report", action: "enable" });
    }
  }

  // Advisor tool gating: enable only when explicitly eligible, disable otherwise.
  // This rule is last so it overrides broad inherited patterns like add: [".*"].
  if (options.advisorEnabled) {
    runtimePolicy.push({ regex_match: "advisor", action: "enable" });
  } else {
    runtimePolicy.push({ regex_match: "advisor", action: "disable" });
  }

  return [...agentPolicy, ...runtimePolicy];
}
