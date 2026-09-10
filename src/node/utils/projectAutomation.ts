import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";

/**
 * Process-wide kill-switch for automatic repo-controlled automation:
 * .xum/init hooks, bash tool hooks (tool_env/tool_pre/tool_post),
 * project-local MCP servers (.xum/mcp.jsonc), project plugin containers
 * (.xum/plugins hooks/commands/MCP), and git hooks in trusted checkouts
 * (gitHooksAllowed in gitNoHooksEnv.ts).
 *
 * Benchmark harnesses (benchmarks/terminal_bench/mux-run.sh) set this when
 * running dataset-controlled repos: the project needs config trust so
 * sub-agent delegation works, but repo-supplied processes must not execute
 * automatically with provider credentials in the environment.
 */
export const DISABLE_PROJECT_AUTOMATION_ENV_SUFFIX = "DISABLE_PROJECT_AUTOMATION";

/** Canonical variable name for user-facing messaging; the legacy MUX_* alias is honored too. */
export const DISABLE_PROJECT_AUTOMATION_ENV = "XUM_DISABLE_PROJECT_AUTOMATION";

export function projectAutomationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Canonical XUM_* takes precedence over the legacy MUX_* alias, matching
  // every other product environment setting (resolveXumEnvironmentValue).
  return resolveXumEnvironmentValue(DISABLE_PROJECT_AUTOMATION_ENV_SUFFIX, env) === "1";
}
