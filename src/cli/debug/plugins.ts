import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { WorkspaceCompositionEntry } from "@/common/orpc/schemas/agentPlugins";
import { isMultiProject } from "@/common/utils/multiProject";
import { defaultConfig } from "@/node/config";
import {
  createRuntimeContextForWorkspace,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import { buildWorkspaceComposition } from "@/node/services/agentPlugins/composition";
import {
  createAgentPluginsMcpProvider,
  resolveAgentPluginsMcpContext,
} from "@/node/services/agentPlugins/mcpConfig";
import { readPersistedExperimentEnabled } from "@/node/services/experimentsService";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";

function printEntries(label: string, entries: WorkspaceCompositionEntry[]): void {
  console.log(`${label} (${entries.length}):`);
  for (const entry of entries) {
    const description = entry.description ? ` — ${entry.description}` : "";
    const shadowed = entry.shadowedBy ? `  [shadowed by ${entry.shadowedBy}]` : "";
    console.log(`  - ${entry.name}  (${entry.source})${description}${shadowed}`);
  }
  console.log();
}

/**
 * Composition inspector (the dsh --dump-config analog): print the effective
 * per-workspace composition by layer — every skill/agent/workflow/MCP server/
 * slash command/hook, its source (built-in | global | project | plugin:<name>),
 * and what shadowed what.
 *
 * Runs host-locally against the workspace checkout; plugin discovery and
 * manifest validation work regardless of the agent-plugins experiment, which
 * only gates whether plugin artifacts join the effective layers.
 *
 * Usage: bun run debug plugins <workspace-id>
 */
export async function pluginsCommand(workspaceId: string): Promise<void> {
  const workspace = defaultConfig.findWorkspace(workspaceId);
  if (!workspace) {
    console.error(`Workspace not found: ${workspaceId}`);
    process.exitCode = 1;
    return;
  }
  const allMetadata = await defaultConfig.getAllWorkspaceMetadata();
  const metadata = allMetadata.find((entry) => entry.id === workspaceId);
  if (!metadata) {
    console.error(`Workspace metadata not found: ${workspaceId}`);
    process.exitCode = 1;
    return;
  }
  if (isMultiProject(metadata)) {
    // The oRPC endpoint composes multi-project workspaces through
    // MultiProjectRuntime; reconstructing that fan-out here is out of scope
    // for a host-local debug command.
    console.error(
      "Multi-project workspaces are not supported by this command; use the app's composition inspector."
    );
    process.exitCode = 1;
    return;
  }

  // Same runtime + host-checkout resolution as the oRPC composition endpoint
  // (AIService.createWorkspaceRuntimeContext): SSH/Docker checkouts are not
  // host paths, so scanning workspace.workspacePath through LocalRuntime would
  // report files production never loads.
  const metadataWithPath = { ...metadata, namedWorkspacePath: workspace.workspacePath };
  const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadataWithPath);
  const hostCheckoutRoot =
    metadata.runtimeConfig.type !== "ssh" && metadata.runtimeConfig.type !== "docker"
      ? resolveWorkspaceRootPath(metadataWithPath, runtime)
      : null;

  const projectTrusted = isWorkspaceProjectTrusted(defaultConfig, metadata);
  const agentPluginsEnabled = await readPersistedExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS, {
    xumHome: defaultConfig.rootDir,
  });

  const mcpConfigService = new MCPConfigService(defaultConfig, {
    agentPluginsMcpProvider: createAgentPluginsMcpProvider({
      xumHome: defaultConfig.rootDir,
      isEnabled: () => agentPluginsEnabled,
    }),
  });

  // Off-host gating mirrors the endpoint: plugin containers anchor at the
  // host checkout root when there is one; plugin MCP servers additionally
  // require a local/worktree runtime (resolveAgentPluginsMcpContext).
  const agentPlugins = hostCheckoutRoot
    ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
    : null;
  const composition = await buildWorkspaceComposition({
    runtime,
    // Execution path: production loaders discover from here (subProjectPath
    // workspaces run in the subdirectory).
    workspacePath,
    // Null for SSH/Docker: plugin containers are host-only and production
    // never loads them off-host, so discovery must not scan the remote
    // workspacePath as if it were a host project root.
    hostCheckoutRoot,
    xumHome: defaultConfig.rootDir,
    projectTrusted,
    agentPluginsEnabled,
    listMcpServerLayers: () =>
      mcpConfigService.listServerLayers(metadata.projectPath, projectTrusted, {
        agentPlugins,
      }),
  });

  console.log(`\n=== Plugin composition for workspace: ${workspaceId} ===\n`);
  console.log(`workspace path: ${workspacePath}`);
  if (hostCheckoutRoot === null) {
    console.log("host checkout: none (off-host runtime) — plugin containers are not loaded");
  } else if (hostCheckoutRoot !== workspacePath) {
    console.log(`host checkout (plugin containers): ${hostCheckoutRoot}`);
  }
  console.log(`project trusted: ${projectTrusted ? "yes" : "no"}`);
  console.log(
    `agent-plugins experiment: ${composition.agentPluginsEnabled ? "enabled" : "disabled (plugin artifacts are discovered but not loaded)"}`
  );
  console.log();

  console.log(`Plugins (${composition.plugins.length}):`);
  for (const plugin of composition.plugins) {
    const version = plugin.version ? `  v${plugin.version}` : "";
    const components =
      plugin.components.length > 0 ? plugin.components.join(", ") : "no components";
    console.log(`  - ${plugin.name} (${plugin.scope})${version}  [${components}]`);
    console.log(`      ${plugin.rootPath}`);
  }
  console.log();

  if (composition.diagnostics.length > 0) {
    console.log(`Diagnostics (${composition.diagnostics.length}):`);
    for (const diagnostic of composition.diagnostics) {
      console.log(`  - [${diagnostic.severity}] ${diagnostic.path}: ${diagnostic.message}`);
    }
    console.log();
  }

  printEntries("Skills", composition.skills);
  printEntries("Agents", composition.agents);
  printEntries("Workflows", composition.workflows);
  printEntries("MCP servers", composition.mcpServers);
  printEntries("Slash commands", composition.slashCommands);
  printEntries("Hooks", composition.hooks);
}
