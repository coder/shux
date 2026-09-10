import type { ToolConfiguration } from "@/common/utils/tools/tools";

/**
 * Where AGENTS.md lives for a given workspace scope.
 *
 * - global-local / project-local: host filesystem, use resolveAgentsPathWithinRoot + fs/promises.
 * - project-runtime: active runtime workspace, use runtime.normalizePath + readFileString/writeFileString.
 */
export type XumAgentsStorageContext =
  | { kind: "global-local"; root: string }
  | { kind: "project-local"; root: string }
  | { kind: "project-runtime"; workspacePath: string; hostProjectRoot: string };

/**
 * Derive AGENTS storage context from tool configuration.
 */
export function resolveXumAgentsStorageContext(config: ToolConfiguration): XumAgentsStorageContext {
  const scope = config.xumScope!;
  if (scope.type === "global") {
    return { kind: "global-local", root: scope.xumHome };
  }

  if (scope.projectStorageAuthority === "runtime") {
    return {
      kind: "project-runtime",
      workspacePath: config.cwd,
      hostProjectRoot: scope.projectRoot,
    };
  }

  return { kind: "project-local", root: scope.projectRoot };
}
