import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { isMultiProject } from "@/common/utils/multiProject";
import { secretsToRecord } from "@/common/types/secrets";
import {
  ALL_WORKSPACES_TARGET,
  MCP_OVERRIDES_READ_TIMEOUT_MS,
  MCP_OVERRIDES_REVISION_UNAVAILABLE,
} from "@/node/services/workspaceMcpOverridesService";
import type { ORPCContext } from "@/node/orpc/context";
import { createRuntimeForWorkspace, resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { isProjectTrusted, isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { buildWorkspaceComposition } from "./composition";
import { discoverWorkspaceAgentPlugins } from "./discovery";
import {
  buildAddedPluginKeyValidator,
  resolveAgentPluginsMcpContext,
  type AgentPluginsMcpContext,
} from "./mcpConfig";
import { collectPluginSlashCommands } from "./slashCommands";

async function resolveWorkspaceAgentPluginsMcpContext(
  context: ORPCContext,
  workspaceId: string | null | undefined,
  projectPath: string | null | undefined
): Promise<AgentPluginsMcpContext | null | undefined> {
  const trimmed = workspaceId?.trim();
  if (!trimmed) return undefined;
  try {
    const result = await context.aiService.getWorkspaceMetadata(trimmed);
    if (!result.success) return undefined;
    const metadata = result.data;
    if (metadata.projectPath !== projectPath?.trim()) {
      log.debug("Ignoring Agent Plugins workspace context for mismatched project", {
        workspaceId: trimmed,
        requestedProjectPath: projectPath,
        workspaceProjectPath: metadata.projectPath,
      });
      return undefined;
    }
    return resolveAgentPluginsMcpContext(
      metadata,
      resolveWorkspaceRootPath(metadata, createRuntimeForWorkspace(metadata))
    );
  } catch (error) {
    log.debug("Failed to resolve Agent Plugins MCP context for workspace", {
      workspaceId: trimmed,
      error,
    });
    return undefined;
  }
}

export async function getWorkspaceMcpOverrides(context: ORPCContext, workspaceId: string) {
  const policy = context.policyService.getEffectivePolicy();
  if (
    context.policyService.isEnforced() &&
    policy?.mcp.allowUserDefined.stdio === false &&
    policy.mcp.allowUserDefined.remote === false
  ) {
    return { overrides: {}, revision: "mcp-disabled-by-policy" };
  }
  try {
    // Bounded and strict like every other request-path read: an inheriting
    // workspace resolves through its ancestors' documents (remote reads allow
    // minutes per level), and the settings view must either show the
    // established state or report it unavailable — never hang, never guess.
    return await context.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId, {
      mode: "strict",
      timeoutMs: MCP_OVERRIDES_READ_TIMEOUT_MS,
    });
  } catch {
    // The sentinel revision makes the dialog's save a repair of the unreadable
    // document (see writeOverridesLocked) rather than a permanent conflict.
    return { overrides: {}, revision: MCP_OVERRIDES_REVISION_UNAVAILABLE };
  }
}

export async function listWorkspaceMcpPrompts(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  // Archive admission pairing (see WorkspaceService.acquireMcpPromptDiscoveryAdmission): held
  // through ensureReady and server startup below, both of which would otherwise re-wake a
  // stopped Coder workspace or start stdio servers inside a checkout the archive is removing.
  // Discovery degrades to an empty catalog instead of erroring, like file completions.
  using admission = context.workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
  if (admission === undefined) return [];
  await context.initStateManager.waitForInit(workspaceId, signal);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const { runtime, workspacePath, hostCheckoutRoot } = runtimeResult.data;
  const ready = await runtime.ensureReady(signal ? { signal } : undefined);
  if (!ready.ready) throw new Error(ready.error);
  // Forward the authority too: a snapshot the service could not establish
  // must make the manager re-read disk (and fail closed), not start servers.
  // Bounded and cancellable like the send path: an inheriting child's
  // resolution reads through an SSH/Docker parent (minutes per remote op),
  // and discovery holds its archive admission for the duration.
  const overridesReadStartedAt = Date.now();
  const { overrides, authoritative } =
    await context.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId, {
      timeoutMs: MCP_OVERRIDES_READ_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
  if (signal?.aborted) return [];
  const projectSecrets = await secretsToRecord(
    isMultiProject(metadata)
      ? mergeMultiProjectSecrets(metadata, context.secretsStore)
      : context.secretsStore.getEffectiveSecrets(metadata.projectPath)
  );
  // `return await`, not `return`: `using` disposes at block exit, and a bare returned promise
  // would release the admission before server startup settles.
  return await context.mcpServerManager.getPromptsForWorkspace(
    {
      workspaceId,
      projectPath: metadata.projectPath,
      runtime,
      workspacePath,
      trusted: isWorkspaceProjectTrusted(context.config, metadata),
      overrides,
      overridesAuthoritative: authoritative,
      // Like the send path: a non-authoritative read that exhausted its
      // budget must not be followed by a second full-length attempt inside
      // the manager while discovery holds its archive admission.
      ...(authoritative
        ? {}
        : { overridesReadDeadlineAt: overridesReadStartedAt + MCP_OVERRIDES_READ_TIMEOUT_MS }),
      projectSecrets,
      agentPlugins: hostCheckoutRoot
        ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
        : null,
    },
    signal ? { signal } : undefined
  );
}

export async function setWorkspaceMcpOverrides(
  context: ORPCContext,
  input: {
    workspaceId: string;
    overrides: Parameters<
      ORPCContext["workspaceMcpOverridesService"]["setOverridesForWorkspace"]
    >[1];
    expectedRevision: string;
  }
) {
  try {
    await context.workspaceMcpOverridesService.setOverridesForWorkspace(
      input.workspaceId,
      input.overrides,
      {
        expectedRevision: input.expectedRevision,
        validateAgainstCurrent: buildAddedPluginKeyValidator(async () => {
          const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
          if (!metadataResult.success) throw new Error(metadataResult.error);
          const projectPath = metadataResult.data.projectPath;
          const servers = await context.mcpConfigService.listServers(
            projectPath,
            isProjectTrusted(context.config, projectPath),
            {
              agentPlugins: await resolveWorkspaceAgentPluginsMcpContext(
                context,
                input.workspaceId,
                projectPath
              ),
            }
          );
          return new Set(Object.keys(servers).filter((key) => key.startsWith("plugin:")));
        }),
        // `target` differs from input.workspaceId for affected sharers/descendants;
        // null = state not establishable, drop the cache instead of guessing.
        publish: (persisted, target) =>
          persisted === null
            ? Promise.resolve(
                target === ALL_WORKSPACES_TARGET
                  ? context.mcpServerManager.forgetAllWorkspaceOverrides()
                  : context.mcpServerManager.forgetWorkspaceOverrides(target)
              )
            : context.mcpServerManager.applyWorkspaceOverrides(target, persisted),
      }
    );
    return { success: true as const, data: undefined };
  } catch (error) {
    return { success: false as const, error: getErrorMessage(error) };
  }
}

export async function listWorkspacePluginSlashCommands(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS)) return [];
  await context.initStateManager.waitForInit(workspaceId, signal);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const { hostCheckoutRoot } = runtimeResult.data;
  if (!hostCheckoutRoot) return [];
  const { plugins } = await discoverWorkspaceAgentPlugins({
    workspacePath: hostCheckoutRoot,
    xumHome: context.config.rootDir,
    projectTrusted: isWorkspaceProjectTrusted(context.config, metadata),
  });
  return collectPluginSlashCommands(plugins);
}

export async function getWorkspacePluginComposition(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  await context.initStateManager.waitForInit(workspaceId, signal);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const { runtime, workspacePath, hostCheckoutRoot } = runtimeResult.data;
  const projectTrusted = isWorkspaceProjectTrusted(context.config, metadata);
  const agentPlugins = hostCheckoutRoot
    ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
    : null;
  return buildWorkspaceComposition({
    runtime,
    workspacePath,
    hostCheckoutRoot,
    xumHome: context.config.rootDir,
    projectTrusted,
    agentPluginsEnabled: context.experimentsService.isExperimentEnabled(
      EXPERIMENT_IDS.AGENT_PLUGINS
    ),
    listMcpServerLayers: () =>
      context.mcpConfigService.listServerLayers(metadata.projectPath, projectTrusted, {
        agentPlugins,
      }),
  });
}
