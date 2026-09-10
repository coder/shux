import type { Tool } from "ai";
import type { z } from "zod";
import type { ToolPolicySchema } from "@/common/orpc/schemas/stream";
import { CONTEXT_FLUSH_TOOL_POLICY_RULE } from "@/common/constants/contextBudget";

/**
 * Tool policy - array of filters applied in order
 * Default behavior is "allow" (all tools enabled) for backwards compatibility
 * Inferred from ToolPolicySchema (single source of truth)
 */
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/**
 * Apply tool policy to filter available tool names.
 *
 * Algorithm:
 * - Filters are applied in order, with default behavior "allow all".
 * - "require" acts like "enable" for filtering purposes.
 * - The last matching filter wins for each tool.
 */
export function applyToolPolicyToNames(toolNames: string[], policy?: ToolPolicy): string[] {
  if (!policy || policy.length === 0) {
    return toolNames;
  }

  // Build a map of tool name -> enabled status.
  // "require" acts as "enable" for filtering purposes — enforcement
  // happens at the stream level (stop-when + post-stream recovery).
  const toolStatus = new Map<string, boolean>();
  for (const toolName of toolNames) {
    toolStatus.set(toolName, true);
  }

  for (const filter of policy) {
    const regex = new RegExp(`^${filter.regex_match}$`);
    const shouldEnable = filter.action !== "disable";

    for (const toolName of toolNames) {
      if (regex.test(toolName)) {
        toolStatus.set(toolName, shouldEnable);
      }
    }
  }

  return toolNames.filter((toolName) => toolStatus.get(toolName) === true);
}

/**
 * Build anchored regexes for the policy's `require` rules.
 *
 * Strips existing anchors to avoid double-anchoring recovery policies
 * (e.g. "^agent_report$" would otherwise become "^^agent_report$$").
 * Shared by StreamManager's stop-when condition and the tool-search catalog
 * classifier (required tools must never be deferred).
 */
export function buildRequiredToolPatterns(policy?: ToolPolicy): RegExp[] {
  return (policy ?? [])
    .filter((filter) => filter.action === "require")
    .map((filter) => {
      const rawPattern = filter.regex_match.replace(/^\^/, "").replace(/\$$/, "");
      return new RegExp(`^${rawPattern}$`);
    });
}

/**
 * Apply tool policy to filter available tools
 * @param tools All available tools
 * @param policy Optional policy to apply (default: allow all)
 * @returns Filtered tools based on policy
 */
export function applyToolPolicy(
  tools: Record<string, Tool>,
  policy?: ToolPolicy
): Record<string, Tool> {
  const enabledToolNames = new Set(applyToolPolicyToNames(Object.keys(tools), policy));
  // new_context only makes sense when the sealed window can be read back: a policy that
  // disables session_history must not leave a request tool whose rollover could never be admitted.
  if (!enabledToolNames.has("session_history")) enabledToolNames.delete("new_context");

  return Object.fromEntries(
    Object.entries(tools).filter(([toolName]) => enabledToolNames.has(toolName))
  );
}

/** Rollover must honor the same last-match regex policy as tool assembly. */
export function isSessionHistoryDisabled(policy?: ToolPolicy): boolean {
  return applyToolPolicyToNames(["session_history"], policy).length === 0;
}

/**
 * Caller policy for a context-budget final-flush turn: the memory-only ceiling is appended
 * last so it wins regardless of the caller's or agent's own rules, while `memory` keeps
 * whatever verdict the inherited policy gave it.
 */
export function withContextBudgetFlushToolPolicy(policy?: ToolPolicy): ToolPolicy {
  return [...(policy ?? []), CONTEXT_FLUSH_TOOL_POLICY_RULE];
}
