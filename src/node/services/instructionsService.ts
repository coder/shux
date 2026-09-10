import {
  flattenInstructionFiles,
  type InstructionFile,
  type InstructionSet,
  type InstructionSources,
  type WorkspaceInstructions,
} from "@/common/types/instructions";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { Config } from "@/node/config";
import {
  createRuntimeContextForWorkspace,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import type { AIService } from "@/node/services/aiService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import { loadInstructionSources } from "@/node/services/systemMessage";
import { log } from "@/node/services/log";
import {
  readAdditionalSystemContext,
  writeAdditionalSystemContext,
} from "@/node/services/additionalSystemContext";

/**
 * InstructionsService — exposes the instruction context (AGENTS.md, CLAUDE.md,
 * AGENTS.local.md, …) loaded for a workspace as a structured payload.
 *
 * Sharing types with `buildSystemMessage` (via `@/common/types/instructions`)
 * guarantees the right-sidebar Instructions tab and the actual prompt builder
 * stay in lockstep — the same `InstructionFile`s the panel renders are the
 * ones the agent sees.
 */
export class InstructionsService {
  constructor(
    private readonly config: Config,
    private readonly aiService: AIService,
    private readonly tokenizerService: TokenizerService
  ) {}

  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }
  }

  async getAdditionalSystemContext(
    workspaceId: string
  ): Promise<{ content: string; enabled: boolean }> {
    await this.assertWorkspaceExists(workspaceId);
    return await readAdditionalSystemContext(this.config, workspaceId);
  }

  async setAdditionalSystemContext(
    workspaceId: string,
    content: string,
    enabled: boolean
  ): Promise<{ content: string; enabled: boolean }> {
    await this.assertWorkspaceExists(workspaceId);
    await writeAdditionalSystemContext(this.config, workspaceId, { content, enabled });
    return { content, enabled };
  }

  /**
   * Load the full instruction context for a workspace, optionally annotated
   * with per-file token counts for the active (or supplied) model.
   *
   * Token counting failures are non-fatal — the panel still renders, it just
   * omits the count rather than blocking on tokenizer issues.
   */
  async getWorkspaceInstructions(
    workspaceId: string,
    modelOverride?: string | null
  ): Promise<WorkspaceInstructions> {
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }
    const metadata = metadataResult.data;

    // Use the workspace *root* (without sub-project segment) so the parent
    // project's AGENTS.md is read for sub-project workspaces; otherwise the
    // panel would only show the sub-project's own AGENTS.md, mirroring the
    // historical bug in the prompt builder.
    const { runtime } = createRuntimeContextForWorkspace(metadata);
    const workspaceRootPath = resolveWorkspaceRootPath(metadata, runtime);
    const sources = await loadInstructionSources(
      metadata,
      runtime,
      workspaceRootPath,
      this.config.loadConfigOrDefault().projects,
      this.aiService.isClaudeSkillsCompatEnabled()
    );

    const trimmedOverride = modelOverride?.trim();
    // Model selection is persisted per-agent (aiSettingsByAgent); workspace-scoped
    // aiSettings is the legacy field. Resolve like the stream path does, otherwise
    // token counting silently skips for workspaces without legacy settings.
    const agentId = normalizeAgentId(metadata.agentId, WORKSPACE_DEFAULTS.agentId);
    const model =
      (trimmedOverride && trimmedOverride.length > 0 ? trimmedOverride : null) ??
      metadata.aiSettingsByAgent?.[agentId]?.model ??
      metadata.aiSettingsByAgent?.[WORKSPACE_DEFAULTS.agentId]?.model ??
      metadata.aiSettings?.model ??
      null;
    const flatRaw = flattenInstructionFiles(sources);

    let tokensByPath: Map<string, number> | null = null;
    let totalTokens: number | null = null;
    if (model && flatRaw.length > 0) {
      try {
        const counts = await Promise.all(
          flatRaw.map((f) => this.tokenizerService.countTokens(model, f.content))
        );
        tokensByPath = new Map(flatRaw.map((f, i) => [f.path, counts[i]]));
        totalTokens = counts.reduce((acc, n) => acc + n, 0);
      } catch (err) {
        // Tokenizer hiccups (unknown model, worker crash, …) shouldn't break the panel.
        log.debug(`InstructionsService: failed to count tokens for workspace ${workspaceId}`, err);
        tokensByPath = null;
        totalTokens = null;
      }
    }

    const annotateFile = (file: InstructionFile): InstructionFile => ({
      ...file,
      tokens: tokensByPath?.get(file.path) ?? null,
    });
    const annotateSet = (set: InstructionSet): InstructionSet => ({
      ...set,
      files: set.files.map(annotateFile),
    });

    const annotatedSources: InstructionSources = {
      global: sources.global.map(annotateSet),
      context: sources.context.map(annotateSet),
    };
    const annotatedFiles = flattenInstructionFiles(annotatedSources);

    return {
      workspaceId,
      model,
      additionalSystemContext: await readAdditionalSystemContext(this.config, workspaceId),
      sources: annotatedSources,
      files: annotatedFiles,
      totalTokens,
    };
  }
}
