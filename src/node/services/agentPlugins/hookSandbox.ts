/**
 * Guest-side protocol for Tier-1 sandboxed plugin hooks (agent-plugins
 * experiment): a plugin's `hooks.js` runs inside a QuickJS sandbox mount, and
 * the host adapter (hookService.ts) marshals event-spine contexts in and hook
 * outputs back out as JSON.
 *
 * Module shape (mirrors OpenCode's validated hook vocabulary): `hooks.js` is a
 * script whose completion value is an object mapping hook names to functions,
 * e.g.
 *
 *   ({
 *     "tool.execute.before": async (input) => ({ deny: "..." }),
 *     "request.assemble": (input) => ({ context: "..." }),
 *   })
 *
 * Asyncify constraint (see the docs in src/node/services/ptc/quickjsRuntime.ts):
 * asyncified bridge functions cannot be called from guest continuations resumed
 * via executePendingJobs (code after `await` on a capability promise) — asyncify
 * replay corrupts results. Hook mounts therefore register NO asyncified bridge
 * functions at all: the `mux` namespace installed by the load prelude is a pure
 * guest Proxy that throws catchable "Capability denied" errors, and the host
 * invokes hooks via `runtime.eval()` whose returned promise is settled by the
 * eval resolve loop. Async hooks (with internal `await`s) are safe because no
 * guest→host asyncified call can occur inside them.
 *
 * eval() wraps code in a PLAIN function (`(function() { ... })()`), so scripts
 * here must not use top-level `await`; async hook results are returned as a
 * promise, which the eval resolve loop awaits (bounded by the mount deadline).
 */

import assert from "node:assert";
import { LEAST_PRIVILEGE_GRANTS, type CapabilityGrants } from "@/common/types/capabilityGrants";
import type { AgentPluginManifest } from "./manifest";

/** The three hook points supported by Tier-1 plugin hooks. */
export const PLUGIN_HOOK_POINTS = [
  "tool.execute.before",
  "tool.execute.after",
  "request.assemble",
] as const;

export type PluginHookPoint = (typeof PLUGIN_HOOK_POINTS)[number];

export function isPluginHookPoint(value: string): value is PluginHookPoint {
  return (PLUGIN_HOOK_POINTS as readonly string[]).includes(value);
}

/** Guest global holding the plugin's loaded hook registry (one plugin per mount). */
const HOOK_REGISTRY_GLOBAL = "__muxPluginHooks";

/**
 * Resolve the capability grants a plugin's hooks run under. Default is least
 * privilege (project-scope posture per capabilityGrants.ts). A manifest may
 * request tool visibility via `extensions.mux.hooks.tools` (array of tool
 * names); the request is honored because hook plugins only load from trusted
 * sources (project containers are Project-Trust-gated at discovery, global
 * containers are user-authored). Grants bound which tools the plugin's
 * tool.execute hooks may observe/mutate; they never enable bridge invocation,
 * vars, or host events in v1.
 */
export function resolvePluginHookGrants(manifest: AgentPluginManifest): CapabilityGrants {
  const requested = readRequestedHookTools(manifest.extensions);
  if (requested.length === 0) {
    return LEAST_PRIVILEGE_GRANTS;
  }
  return {
    version: 1,
    bridgeTools: { allow: requested },
    vars: false,
    hostEvents: false,
  };
}

/** Defensive parse of `extensions.mux.hooks.tools`; malformed shapes yield []. */
function readRequestedHookTools(extensions: Record<string, unknown> | undefined): string[] {
  const mux = extensions?.mux;
  if (mux === null || typeof mux !== "object" || Array.isArray(mux)) {
    return [];
  }
  const hooks = (mux as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    return [];
  }
  const tools = (hooks as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  const names = tools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
  // Sorted + deduped so grants comparison (mount reuse keys) is stable.
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Build the one-time load script for a plugin mount:
 * 1. installs the `mux` capability namespace as a deny-by-default Proxy whose
 *    errors are catchable guest `Error`s (same "Capability denied" phrasing as
 *    ToolBridge stubs), and
 * 2. evaluates hooks.js via guest indirect eval (script completion-value
 *    semantics — "the module evaluates to an object"), keeping the hook
 *    functions alive in a guest global registry, and
 * 3. returns the supported hook names found, as a JSON array.
 */
export function buildHookLoadScript(args: { source: string; grants: CapabilityGrants }): string {
  assert(
    args.grants.bridgeTools.allow !== "all",
    "plugin hook grants must enumerate tools; 'all' is session-scope only"
  );
  const grantedNames = args.grants.bridgeTools.allow;
  return `
    (function installMuxNamespace() {
      const granted = new Set(${JSON.stringify(grantedNames)});
      globalThis.mux = new Proxy({}, {
        get: (_target, prop) => () => {
          const name = String(prop);
          if (!granted.has(name)) {
            throw new Error("Capability denied: mux." + name + " is not granted for this sandbox");
          }
          // v1: grants bound tool.execute hook visibility only; no tool is
          // invocable from a hook sandbox.
          throw new Error("mux." + name + " is granted for tool.execute hooks only; plugin hooks cannot invoke tools");
        },
      });
    })();
    const hooksModule = (0, eval)(${JSON.stringify(args.source)});
    if (hooksModule === null || typeof hooksModule !== "object") {
      throw new Error("hooks.js must evaluate to an object mapping hook names to functions");
    }
    const registry = {};
    for (const hookName of ${JSON.stringify(PLUGIN_HOOK_POINTS)}) {
      if (typeof hooksModule[hookName] === "function") {
        registry[hookName] = hooksModule[hookName];
      }
    }
    globalThis.${HOOK_REGISTRY_GLOBAL} = registry;
    return JSON.stringify(Object.keys(registry));
  `;
}

/**
 * Build the per-event invoke script: JSON input in, JSON output (or null)
 * back. Returns a promise for async hooks — resolved by the eval resolve loop.
 */
export function buildHookInvokeScript(hookName: PluginHookPoint, inputJson: string): string {
  return `
    const hook = (globalThis.${HOOK_REGISTRY_GLOBAL} || {})[${JSON.stringify(hookName)}];
    if (typeof hook !== "function") {
      return JSON.stringify(null);
    }
    const input = JSON.parse(${JSON.stringify(inputJson)});
    return Promise.resolve(hook(input)).then(function (output) {
      return JSON.stringify(output === undefined ? null : output);
    });
  `;
}

/**
 * Parse the JSON returned by an invoke script into a hook output record.
 * `null` means "no-op". Throws on malformed payloads (caller treats a throw as
 * a hook failure: log, skip, continue).
 */
export function parseHookOutput(resultJson: unknown): Record<string, unknown> | null {
  assert(typeof resultJson === "string", "hook invoke result must be a JSON string");
  const parsed: unknown = JSON.parse(resultJson);
  if (parsed === null) {
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook output must be an object or undefined");
  }
  return parsed as Record<string, unknown>;
}

/** Parse the JSON hook-name array returned by the load script. */
export function parseLoadedHookNames(resultJson: unknown): PluginHookPoint[] {
  assert(typeof resultJson === "string", "hook load result must be a JSON string");
  const parsed: unknown = JSON.parse(resultJson);
  assert(Array.isArray(parsed), "hook load result must be a JSON array");
  return parsed.filter(
    (name): name is PluginHookPoint => typeof name === "string" && isPluginHookPoint(name)
  );
}
