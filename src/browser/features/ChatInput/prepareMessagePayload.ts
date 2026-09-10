import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { ChatAttachment } from "./ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import {
  prepareUserMessageForSend,
  type AgentSkillReference,
  type MCPPromptReference,
  type MuxMessageMetadata,
  type ReviewNoteDataForDisplay,
  withAgentSkillRefs,
  withMcpPromptRefs,
} from "@/common/types/message";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import { appendStagedAttachmentNotice } from "./stagedAttachments";
import { hasProjectScopedSkillRef } from "./utils";
import type { GoalInterventionPolicy, QueueDispatchMode } from "./types";

type ModelOneShot = Extract<NonNullable<ParsedCommand>, { type: "model-oneshot" }>;

interface PrepareMessagePayloadInput {
  messageText: string;
  messageTextForSend: string;
  attachments: ChatAttachment[];
  fileParts?: FilePart[];
  reviews?: ReviewNoteDataForDisplay[];
  reviewIds: string[];
  editMessageId?: string;
  baseMetadata?: MuxMessageMetadata;
  agentSkillRefs: AgentSkillReference[];
  mcpPromptRefs: MCPPromptReference[];
  sendMessageOptions: SendMessageOptions;
  compactionOptions?: Partial<SendMessageOptions>;
  compactionMessageText?: string;
  appendStagedNotice?: boolean;
  modelOneShot?: ModelOneShot | null;
  policyModel: string;
  transferredDraftProjectDiscovery: boolean;
  additionalSystemContextHydrated: boolean;
  additionalSystemContext: { enabled: boolean; content: string };
  goalInterventionPolicy?: GoalInterventionPolicy;
  queueDispatchMode?: QueueDispatchMode;
}

interface PreparedMessagePayload {
  message: string;
  // The schema leaves muxMetadata untyped (z.any()); narrow it at this seam.
  options: Omit<SendMessageOptions, "muxMetadata"> & {
    fileParts?: FilePart[];
    muxMetadata?: MuxMessageMetadata;
  };
  effectiveModel: string;
  sentReviewIds: string[];
}

export function prepareMessagePayload(input: PrepareMessagePayloadInput): PreparedMessagePayload {
  const fileParts =
    input.fileParts ?? chatAttachmentsToFileParts(input.attachments, { validate: true });
  const sendFileParts = input.editMessageId
    ? fileParts
    : fileParts.length > 0
      ? fileParts
      : undefined;
  let metadata = input.baseMetadata;
  // Refs on a compaction request would make the summarization turn materialize
  // skill snapshots; the caller carries them on the compaction follow-up instead.
  if (metadata?.type !== "compaction-request") {
    if (input.agentSkillRefs.length > 0) {
      metadata = withAgentSkillRefs(metadata, input.agentSkillRefs);
    }
    if (input.mcpPromptRefs.length > 0) {
      metadata = withMcpPromptRefs(metadata, input.mcpPromptRefs);
    }
  }

  const actualMessageText = input.compactionMessageText ?? input.messageTextForSend;
  const userMessageText =
    input.appendStagedNotice === false
      ? actualMessageText
      : appendStagedAttachmentNotice(actualMessageText, input.attachments);
  const prepared = prepareUserMessageForSend(
    { text: userMessageText, reviews: input.reviews },
    metadata
  );
  const compactionOptions = input.compactionOptions ?? {};
  const additionalSystemInstructions =
    compactionOptions.additionalSystemInstructions ??
    input.sendMessageOptions.additionalSystemInstructions;
  const effectiveModel =
    input.modelOneShot?.modelString ?? compactionOptions.model ?? input.sendMessageOptions.model;
  const trimmedMessageText = input.messageText.trim();
  const commandPrefix = input.modelOneShot
    ? trimmedMessageText
        .slice(0, trimmedMessageText.length - input.modelOneShot.message.length)
        .trimEnd()
    : undefined;
  const rawCommand = commandPrefix
    ? appendStagedAttachmentNotice(trimmedMessageText, input.attachments)
    : undefined;
  metadata = {
    ...(prepared.metadata ?? { type: "normal" }),
    requestedModel: effectiveModel,
    ...(rawCommand ? { rawCommand, commandPrefix } : {}),
  };

  const rawThinkingOverride = input.modelOneShot?.thinkingLevel;
  const thinkingOverride =
    rawThinkingOverride != null
      ? resolveThinkingInput(rawThinkingOverride, input.policyModel)
      : undefined;

  return {
    message: prepared.finalText,
    effectiveModel,
    sentReviewIds: input.reviewIds,
    options: {
      ...input.sendMessageOptions,
      ...compactionOptions,
      ...(input.transferredDraftProjectDiscovery && hasProjectScopedSkillRef(input.agentSkillRefs)
        ? { disableWorkspaceAgents: true }
        : {}),
      ...(input.modelOneShot?.modelString ? { model: input.modelOneShot.modelString } : {}),
      ...(thinkingOverride ? { thinkingLevel: thinkingOverride } : {}),
      ...(input.modelOneShot ? { skipAiSettingsPersistence: true } : {}),
      ...(input.goalInterventionPolicy
        ? { goalInterventionPolicy: input.goalInterventionPolicy }
        : {}),
      ...(input.queueDispatchMode ? { queueDispatchMode: input.queueDispatchMode } : {}),
      ...(input.additionalSystemContextHydrated
        ? {
            additionalSystemContext: input.additionalSystemContext.enabled
              ? input.additionalSystemContext.content
              : "",
          }
        : {}),
      additionalSystemInstructions,
      editMessageId: input.editMessageId,
      fileParts: sendFileParts,
      muxMetadata: metadata,
    },
  };
}
