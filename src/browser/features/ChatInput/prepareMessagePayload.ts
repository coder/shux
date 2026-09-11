import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { ChatAttachment } from "./ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import type { FilePart, SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
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
import { hasProjectScopedSkillRef, type SkillInvocation } from "./utils";
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
  /**
   * One-shot override composed with a skill invocation ("/haiku+0 /done").
   * It rides the invocation rather than parsing as a bare model-oneshot, so
   * only option building consumes it — the transcript prefix metadata is the
   * skill path's job (composedPrefixMatch in the caller).
   */
  skillOneShot?: SkillInvocation["oneShot"] | null;
  /** True for slash skill invocations (routable unless a model override rides along). */
  hasSkillInvocation?: boolean;
  policyModel: string;
  /**
   * Provider configuration for model-relative thinking resolution: a numeric
   * one-shot index maps into the SELECTED model's ladder, and a provider model
   * configured with `mappedToModel` has its target's ladder, not the default.
   */
  providersConfig?: ProvidersConfigMap | null;
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
  // Model/thinking override from either a bare one-shot ("/haiku+0 msg") or
  // one composed with a skill invocation ("/haiku+0 /done args").
  const oneShotOverride = input.modelOneShot ?? input.skillOneShot ?? null;
  const oneShotModelOverride = oneShotOverride?.modelString;
  const effectiveModel =
    oneShotModelOverride ?? compactionOptions.model ?? input.sendMessageOptions.model;
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

  const rawThinkingOverride = oneShotOverride?.thinkingLevel;
  const thinkingOverride =
    rawThinkingOverride != null
      ? resolveThinkingInput(rawThinkingOverride, input.policyModel, input.providersConfig)
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
      ...(oneShotModelOverride ? { model: oneShotModelOverride } : {}),
      ...(thinkingOverride ? { thinkingLevel: thinkingOverride } : {}),
      ...(oneShotOverride ? { skipAiSettingsPersistence: true } : {}),
      // Only a model-carrying one-shot bypasses class routing; a thinking-only
      // override (/+2 /skill) layers on top of routing.
      ...(oneShotModelOverride ? { skipSkillModelRouting: true } : {}),
      // Numeric thinking is model-relative and thinkingOverride above was
      // resolved client-side. A routable skill send may stream on a different
      // (class) model, and an explicit one-shot model's ladder depends on
      // provider mappings the backend resolves authoritatively, so pass the
      // raw index for the backend to re-resolve against whatever model
      // actually streams.
      ...(input.hasSkillInvocation === true && typeof rawThinkingOverride === "number"
        ? { oneShotThinkingIndex: rawThinkingOverride }
        : {}),
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
