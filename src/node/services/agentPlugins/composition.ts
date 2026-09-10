import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type {
  WorkspaceComposition,
  WorkspaceCompositionEntry,
  WorkspaceCompositionPlugin,
} from "@/common/orpc/schemas/agentPlugins";
import type { MCPServerInfo } from "@/common/types/mcp";
import type { Runtime } from "@/node/runtime/Runtime";
import { discoverAgentDefinitions } from "@/node/services/agentDefinitions/agentDefinitionsService";
import {
  discoverAgentSkills,
  getDefaultAgentSkillsRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { discoverWorkflowScripts } from "@/node/services/workflows/workflowScriptDiscovery";

import { joinPathLike } from "@/node/services/hooks";
import { discoverWorkspaceAgentPlugins, type AgentPluginInfo } from "./discovery";

/**
 * Workspace composition inspector (the `--dump-config` analog): computes the
 * effective set of skills, agents, workflows, MCP servers, slash commands, and
 * hooks by layer, including which entry shadowed which.
 *
 * The composition reuses the production loaders (skill/agent/workflow
 * discovery, MCP config layers) rather than forking parallel loading paths, so
 * what it reports is what streams actually load. Plugin discovery/validation
 * itself is NOT experiment-gated — the `plugins` and `diagnostics` sections
 * are always populated — but plugin artifacts only join the per-kind layers
 * when the agent-plugins experiment is enabled, mirroring load behavior.
 */
export interface BuildWorkspaceCompositionArgs {
  runtime: Runtime;
  /** Execution/discovery path of the workspace (host checkout for local workspaces). */
  workspacePath: string;
  /**
   * Host checkout root anchoring plugin containers, or null for off-host
   * runtimes (SSH/Docker). Plugin discovery is host-filesystem-only and
   * production never loads plugin containers off-host, so a null suppresses
   * it — passing the remote workspacePath instead would report host files
   * production never loads.
   */
  hostCheckoutRoot: string | null;
  xumHome: string;
  projectTrusted: boolean;
  agentPluginsEnabled: boolean;
  /** MCP servers split by config layer (see MCPConfigService.listServerLayers). */
  listMcpServerLayers: () => Promise<{
    plugin: Record<string, MCPServerInfo>;
    global: Record<string, MCPServerInfo>;
    project: Record<string, MCPServerInfo>;
  }>;
}

/** Layer label for one entry: built-in | global | project | plugin:<name>. */
function sourceLabel(scope: string, pluginName?: string): string {
  return pluginName !== undefined ? `plugin:${pluginName}` : scope;
}

/**
 * Mark shadowed entries: within each name, the first entry (highest
 * precedence) is effective and later ones record who overrode them. Entries
 * must arrive in precedence order within each name group.
 */
function markShadowed(entries: WorkspaceCompositionEntry[]): WorkspaceCompositionEntry[] {
  const effectiveSourceByName = new Map<string, string>();
  return entries.map((entry) => {
    const winner = effectiveSourceByName.get(entry.name);
    if (winner === undefined) {
      effectiveSourceByName.set(entry.name, entry.source);
      return entry;
    }
    return { ...entry, shadowedBy: winner };
  });
}

function summarizePlugin(plugin: AgentPluginInfo): WorkspaceCompositionPlugin {
  const components: string[] = [
    ...(plugin.skillsDir !== undefined ? ["skills"] : []),
    ...(plugin.mcpConfigPath !== undefined ? ["mcp"] : []),
    ...(plugin.agentsDir !== undefined ? ["agents"] : []),
    ...(plugin.workflowsDir !== undefined ? ["workflows"] : []),
    ...(plugin.hooksPath !== undefined ? ["hooks"] : []),
    ...((plugin.manifest.contributes?.slashCommands?.length ?? 0) > 0 ? ["slashCommands"] : []),
  ];
  return {
    name: plugin.name,
    scope: plugin.scope,
    rootPath: plugin.rootPath,
    components,
    ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
  };
}

/** Shell tool hooks: project Xum metadata shadows the runtime user's Xum home. */
const SHELL_HOOK_FILENAMES = ["tool_hook", "tool_pre", "tool_post"] as const;

async function collectShellHookEntries(
  runtime: Runtime,
  workspacePath: string
): Promise<WorkspaceCompositionEntry[]> {
  const entries: WorkspaceCompositionEntry[] = [];
  // Match production hook resolution on the workspace runtime filesystem.
  const layers: Array<{ dir: string; source: string }> = listProjectMetadataRelativePaths("").map(
    (relativePath) => ({
      dir: joinPathLike(workspacePath, relativePath),
      source: "project",
    })
  );
  try {
    const homeDir = await runtime.resolvePath(runtime.getXumHome());
    layers.push({ dir: homeDir, source: "global" });
  } catch {
    // Home resolution failed (e.g. dead SSH connection) — skip the user layer,
    // matching hooks.ts's best-effort fallback.
  }
  for (const hookName of SHELL_HOOK_FILENAMES) {
    for (const layer of layers) {
      try {
        const stat = await runtime.stat(joinPathLike(layer.dir, hookName));
        if (stat.isDirectory) continue;
      } catch {
        continue;
      }
      entries.push({ name: hookName, source: layer.source, description: "shell tool hook" });
    }
  }
  return entries;
}

/** Plugin workflow scripts encode their provider as plugin://<name>/... */
function workflowSourceLabel(scope: string, canonicalScriptPath?: string): string {
  if (canonicalScriptPath?.startsWith("plugin://")) {
    const remainder = canonicalScriptPath.slice("plugin://".length);
    const pluginName = remainder.slice(0, remainder.indexOf("/"));
    if (pluginName.length > 0) {
      return `plugin:${pluginName}`;
    }
  }
  return scope;
}

export async function buildWorkspaceComposition(
  args: BuildWorkspaceCompositionArgs
): Promise<WorkspaceComposition> {
  // Plugin discovery + manifest validation runs unconditionally for host
  // workspaces (inspection is not experiment-gated); only the per-kind layers
  // below honor the experiment gate. Off-host (null root) discovers nothing,
  // matching production's hostCheckoutRoot gating.
  const { plugins, diagnostics } =
    args.hostCheckoutRoot != null
      ? await discoverWorkspaceAgentPlugins({
          workspacePath: args.hostCheckoutRoot,
          xumHome: args.xumHome,
          projectTrusted: args.projectTrusted,
        })
      : { plugins: [], diagnostics: [] };

  // Off-host also suppresses plugin roots in the runtime-based loaders below:
  // they gate on runtime class internally (RemoteRuntime), but the null host
  // root is the authoritative off-host signal here.
  const includeAgentPlugins = args.agentPluginsEnabled && args.hostCheckoutRoot != null;

  // Production (skillStorageContext.buildProjectLocalRoots) anchors plugin
  // SKILL containers at the CHECKOUT root: for subProjectPath workspaces the
  // execution path is a subdirectory, but plugins live at the checkout level.
  // Ordinary skill roots stay at the execution path. Agents and workflows
  // below intentionally keep execution-path defaults — production derives
  // their plugin containers from the discovery path, so checkout-anchoring
  // them here would report artifacts production never loads.
  const defaultSkillRoots = includeAgentPlugins
    ? getDefaultAgentSkillsRoots(args.runtime, args.workspacePath, { includeAgentPlugins: true })
    : undefined;
  const checkoutSkillRoots =
    defaultSkillRoots?.projectPluginRoots != null && args.hostCheckoutRoot != null
      ? {
          roots: {
            ...defaultSkillRoots,
            projectPluginRoots: [
              ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
                args.runtime.normalizePath(relativePath, args.hostCheckoutRoot!)
              ),
              args.runtime.normalizePath(".agents/plugins", args.hostCheckoutRoot),
            ],
          },
          // Same repo boundary production uses: the checkout root contains the
          // execution path, so ordinary project roots stay contained while
          // checkout-level plugin roots pass the repo-symlink posture check.
          containment: { kind: "local" as const, root: args.hostCheckoutRoot },
        }
      : undefined;

  const skillDescriptors = await discoverAgentSkills(args.runtime, args.workspacePath, {
    dedupeByName: false,
    includeAgentPlugins,
    ...(checkoutSkillRoots ?? {}),
  });
  const skills = markShadowed(
    skillDescriptors.map((skill) => ({
      name: skill.name,
      source: sourceLabel(skill.scope, skill.pluginName),
      description: skill.description,
    }))
  );

  const agentDescriptors = await discoverAgentDefinitions(args.runtime, args.workspacePath, {
    dedupeById: false,
    includeAgentPlugins,
  });
  const agents = markShadowed(
    agentDescriptors.map((agent) => ({
      name: agent.id,
      source: sourceLabel(agent.scope, agent.pluginName),
      ...(agent.description !== undefined ? { description: agent.description } : {}),
    }))
  );

  // Workflow discovery already dedupes by skill name and plugin identity, so
  // these are effective entries only (skill shadowing shows up under skills).
  let workflows: WorkspaceCompositionEntry[] = [];
  try {
    const availableWorkflows = await discoverWorkflowScripts({
      runtime: args.runtime,
      workspacePath: args.workspacePath,
      projectTrusted: args.projectTrusted,
      includeAgentPlugins,
    });
    workflows = availableWorkflows.map((workflow) => ({
      name: workflow.descriptor.name,
      source: workflowSourceLabel(
        workflow.descriptor.scope,
        workflow.descriptor.canonicalScriptPath
      ),
      description: workflow.descriptor.description,
    }));
  } catch (error) {
    log.warn(`Composition inspector: workflow enumeration failed: ${getErrorMessage(error)}`);
  }

  // MCP layers in precedence order (project config > global config > plugin).
  const serverLayers = await args.listMcpServerLayers();
  const mcpEntry = (
    key: string,
    info: MCPServerInfo,
    layer: string
  ): WorkspaceCompositionEntry => ({
    name: key,
    source: info.plugin !== undefined ? `plugin:${info.plugin.pluginName}` : layer,
  });
  const mcpServers = markShadowed([
    ...Object.entries(serverLayers.project).map(([key, info]) => mcpEntry(key, info, "project")),
    ...Object.entries(serverLayers.global).map(([key, info]) => mcpEntry(key, info, "global")),
    ...Object.entries(serverLayers.plugin).map(([key, info]) => mcpEntry(key, info, "plugin")),
  ]);

  // Contributed slash commands load only when the experiment is enabled. The
  // loading path (collectPluginSlashCommands) applies the same first-wins rule;
  // here every declaration is listed so duplicate names show up as shadowed.
  const slashCommands = includeAgentPlugins
    ? markShadowed(
        plugins.flatMap((plugin) =>
          (plugin.manifest.contributes?.slashCommands ?? []).map((command) => ({
            name: command.name,
            source: `plugin:${plugin.name}`,
            ...(command.description !== undefined ? { description: command.description } : {}),
          }))
        )
      )
    : [];

  const hooks = [
    ...markShadowed(await collectShellHookEntries(args.runtime, args.workspacePath)),
    // Plugin hooks all run (no shadowing between plugins).
    ...(includeAgentPlugins
      ? plugins
          .filter((plugin) => plugin.hooksPath !== undefined)
          .map((plugin) => ({
            name: "hooks.js",
            source: `plugin:${plugin.name}`,
            description: "sandboxed plugin hooks",
          }))
      : []),
  ];

  return {
    agentPluginsEnabled: args.agentPluginsEnabled,
    plugins: plugins.map(summarizePlugin),
    diagnostics: diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      scope: diagnostic.scope,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    skills,
    agents,
    workflows,
    mcpServers,
    slashCommands,
    hooks,
  };
}
