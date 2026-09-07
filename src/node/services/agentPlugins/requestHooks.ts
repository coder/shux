import * as path from "node:path";
import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { agentPluginHookService } from "./hookService";
import { resolveAgentPluginsMcpContext } from "./mcpConfig";

/** Shared lazy hook setup for ordinary request building and rollover admission. No model/tools. */
export async function prepareWorkspaceRequestHooks(args: {
  config: Config;
  metadata: WorkspaceMetadata;
  hostCheckoutRoot: string | null;
  enabled: boolean;
  journal: DurableEventJournal;
}): Promise<void> {
  const pluginContext = args.hostCheckoutRoot
    ? resolveAgentPluginsMcpContext(args.metadata, args.hostCheckoutRoot)
    : null;
  await agentPluginHookService.ensureWorkspaceHooksForRequest({
    workspaceId: args.metadata.id,
    sessionDir: path.join(args.config.sessionsDir, args.metadata.id),
    journal: args.journal,
    enabled: args.enabled,
    xumHome: args.config.rootDir,
    projectRoot: pluginContext?.projectRoot,
    projectTrusted: isWorkspaceProjectTrusted(args.config, args.metadata),
  });
}
