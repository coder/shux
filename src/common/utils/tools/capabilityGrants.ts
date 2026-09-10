/**
 * Tool-assembly enforcement of capability grants: the second of the two
 * enforcement points (the first is the sandbox bridge boundary in
 * src/node/services/ptc/toolBridge.ts). One vocabulary — CapabilityGrants —
 * drives both, replacing hard-coded posture sets with a filter.
 */

import type { Tool } from "ai";
import { isBridgeToolGranted, type CapabilityGrants } from "@/common/types/capabilityGrants";

/**
 * Filter an assembled tool set down to the granted tools. Grants are a
 * ceiling: they only remove tools and compose with tool policy (which can
 * narrow further but never re-add a non-granted tool).
 */
export function applyCapabilityGrants(
  tools: Record<string, Tool>,
  grants: CapabilityGrants
): Record<string, Tool> {
  if (grants.bridgeTools.allow === "all") {
    return tools;
  }
  const filtered: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isBridgeToolGranted(grants, name)) {
      filtered[name] = tool;
    }
  }
  return filtered;
}
