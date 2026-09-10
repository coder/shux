import path from "node:path";

import {
  getCanonicalProjectMetadataRelativePath,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";
import type { XumToolScope } from "@/common/types/toolScope";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

import {
  buildProjectSkillRoots,
  getDefaultAgentSkillsRoots,
  type AgentSkillsRoots,
} from "./agentSkillsService";

export type SkillStorageKind = "global-local" | "project-local" | "project-runtime";

export type ProjectSkillContainment =
  | { kind: "none" }
  | { kind: "local"; root: string }
  | { kind: "runtime"; root: string };

export interface SkillStorageContext {
  kind: SkillStorageKind;
  runtime: Runtime;
  workspacePath: string;
  roots?: AgentSkillsRoots;
  containment: ProjectSkillContainment;
}

function buildProjectLocalRoots(
  runtime: Runtime,
  xumScope: Extract<XumToolScope, { type: "project" }>,
  options?: { includeClaudeSkills?: boolean; includeAgentPlugins?: boolean }
): AgentSkillsRoots {
  const projectSearchRoot = xumScope.checkoutRoot ?? xumScope.projectRoot;

  return {
    projectRoot: path.join(xumScope.projectRoot, getCanonicalProjectMetadataRelativePath("skills")),
    projectSearchRoot,
    projectRoots: buildProjectSkillRoots(runtime, xumScope.projectRoot, projectSearchRoot, {
      includeClaudeSkills: options?.includeClaudeSkills,
    }),
    globalRoot: path.join(xumScope.xumHome, "skills"),
    universalRoot: "~/.agents/skills",
    ...(options?.includeClaudeSkills ? { globalClaudeRoot: "~/.claude/skills" } : {}),
    // agent-plugins experiment: read-only plugin containers at lowest precedence within each scope.
    // Containers anchor at the CHECKOUT root: for subProjectPath workspaces
    // `projectRoot` is the execution subdirectory, but plugins live (and are
    // listed by the UI) at the checkout level.
    ...(options?.includeAgentPlugins
      ? {
          projectPluginRoots: [
            ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
              path.join(projectSearchRoot, relativePath)
            ),
            path.join(projectSearchRoot, ".agents", "plugins"),
          ],
          globalPluginRoots: [path.join(xumScope.xumHome, "plugins"), "~/.agents/plugins"],
        }
      : {}),
  };
}

function buildGlobalLocalRoots(input: {
  runtime: Runtime;
  xumScope?: XumToolScope | null;
  includeClaudeSkills?: boolean;
  includeAgentPlugins?: boolean;
}): AgentSkillsRoots {
  const xumHome = input.xumScope?.xumHome ?? input.runtime.getXumHome();

  return {
    projectRoot: "",
    globalRoot: path.join(xumHome, "skills"),
    universalRoot: "~/.agents/skills",
    // claude-skills-compat experiment: read-only root at lowest global precedence.
    ...(input.includeClaudeSkills ? { globalClaudeRoot: "~/.claude/skills" } : {}),
    // agent-plugins experiment: read-only plugin containers at lowest global precedence.
    ...(input.includeAgentPlugins
      ? { globalPluginRoots: [path.join(xumHome, "plugins"), "~/.agents/plugins"] }
      : {}),
  };
}

function resolveProjectLocalRuntime(input: {
  runtime: Runtime;
  xumScope: Extract<XumToolScope, { type: "project" }>;
}): Runtime {
  if (input.runtime instanceof DevcontainerRuntime) {
    // Devcontainer commands run in the container, but project-local skill roots point at
    // host paths. Use host-local I/O here so discovery can still reach host-global skills.
    return new LocalRuntime(input.xumScope.projectRoot);
  }

  return input.runtime;
}

/**
 * Resolve skill storage context from workspace scope, swapping in a host-local runtime
 * when the selected skill roots live on the host filesystem.
 */
export function resolveSkillStorageContext(input: {
  runtime: Runtime;
  workspacePath: string;
  xumScope?: XumToolScope | null;
  /** claude-skills-compat experiment: include read-only .claude/skills roots in discovery. */
  includeClaudeSkills?: boolean;
  /** agent-plugins experiment: include read-only Agent Plugins skill roots in discovery. */
  includeAgentPlugins?: boolean;
}): SkillStorageContext {
  if (input.xumScope?.type !== "project") {
    return {
      kind: "global-local",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      // Keep global-scope discovery global-only so downstream readers do not
      // fall back to workspace-local roots when the caller targets ~/.xum.
      roots: buildGlobalLocalRoots({
        runtime: input.runtime,
        xumScope: input.xumScope,
        includeClaudeSkills: input.includeClaudeSkills,
        includeAgentPlugins: input.includeAgentPlugins,
      }),
      containment: { kind: "none" },
    };
  }

  const projectSearchRoot = input.xumScope.checkoutRoot ?? input.workspacePath;
  if (input.xumScope.projectStorageAuthority === "runtime") {
    return {
      kind: "project-runtime",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      roots: getDefaultAgentSkillsRoots(input.runtime, input.workspacePath, {
        includeClaudeSkills: input.includeClaudeSkills,
        includeAgentPlugins: input.includeAgentPlugins,
        projectSearchRoot,
      }),
      containment: {
        kind: "runtime",
        root: projectSearchRoot,
      },
    };
  }

  const projectRuntime = resolveProjectLocalRuntime({
    runtime: input.runtime,
    xumScope: input.xumScope,
  });
  return {
    kind: "project-local",
    runtime: projectRuntime,
    workspacePath: input.workspacePath,
    roots: buildProjectLocalRoots(projectRuntime, input.xumScope, {
      includeClaudeSkills: input.includeClaudeSkills,
      includeAgentPlugins: input.includeAgentPlugins,
    }),
    containment: {
      kind: "local",
      // The checkout root (when present) contains projectRoot, so this stays a
      // correct repo boundary while also covering inherited and plugin roots.
      root: input.xumScope.checkoutRoot ?? input.xumScope.projectRoot,
    },
  };
}
