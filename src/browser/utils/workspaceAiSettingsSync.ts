import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export function getWorkspaceAiSettingsFromMetadata(
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined
): {
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  reasoningMode: OpenAIReasoningMode | undefined;
} {
  const settings =
    (agentId ? metadata?.aiSettingsByAgent?.[agentId] : undefined) ?? metadata?.aiSettings;
  return {
    model: settings?.model,
    thinkingLevel: settings?.thinkingLevel,
    reasoningMode: settings?.reasoningMode,
  };
}

export function resolveEffectiveComposerModel(
  preferredModel: unknown,
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined,
  defaultModel: string
): string {
  const metadataModel = getWorkspaceAiSettingsFromMetadata(metadata, agentId).model;
  // Match ChatInput precedence so shortcuts and palette actions gate on the model users see.
  return normalizeModelPreference(preferredModel, metadataModel ?? defaultModel);
}
