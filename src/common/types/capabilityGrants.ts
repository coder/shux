/**
 * Capability grants (substrate 4 of the shared agent foundation): one small
 * vocabulary for "what can this guest / hook / tool-set do".
 *
 * Enforced at two points:
 * - the sandbox bridge boundary (ToolBridge filters + re-checks per call), and
 * - tool assembly (applyCapabilityGrants filter over the assembled tool set).
 *
 * Scope model (surfaces through existing Project Trust concepts):
 * - `session` scope: model-authored code running in the user's own session
 *   (PTC code_execution). Gets the full bridge — matches pre-grants behavior.
 * - `project` scope: repo-controlled code (future Tier-1 plugin hooks).
 *   Defaults to least privilege; an untrusted project always resolves to
 *   least privilege regardless of requested scope.
 */

export interface CapabilityGrants {
  version: 1;
  /** Which mux.* bridge tools the guest may invoke. */
  bridgeTools: { allow: "all" } | { allow: readonly string[] };
  /** Guest-visible persistent `vars` namespace. */
  vars: boolean;
  /** Host→guest event queue + drain. */
  hostEvents: boolean;
}

/** Everything the session's own agent code may already do today. */
export const FULL_GRANTS: CapabilityGrants = {
  version: 1,
  bridgeTools: { allow: "all" },
  vars: true,
  hostEvents: true,
};

/** Deny-by-default: no bridge tools, no vars, no host events. */
export const LEAST_PRIVILEGE_GRANTS: CapabilityGrants = {
  version: 1,
  bridgeTools: { allow: [] },
  vars: false,
  hostEvents: false,
};

export interface ResolveCapabilityGrantsOptions {
  /** Who authored the code the grants govern. */
  scope: "session" | "project";
}

/**
 * Resolve default grants from code scope. Session-scoped (model-authored)
 * code keeps the full bridge; project-scoped (repo-controlled) code is least
 * privilege — capabilities must be granted explicitly (e.g. via a future
 * plugin manifest gated on Project Trust), never implicitly.
 */
export function resolveCapabilityGrants(options: ResolveCapabilityGrantsOptions): CapabilityGrants {
  if (options.scope === "session") {
    return FULL_GRANTS;
  }
  return LEAST_PRIVILEGE_GRANTS;
}

/** Check whether a mux.* bridge tool is granted. */
export function isBridgeToolGranted(grants: CapabilityGrants, toolName: string): boolean {
  if (grants.bridgeTools.allow === "all") {
    return true;
  }
  return grants.bridgeTools.allow.includes(toolName);
}
