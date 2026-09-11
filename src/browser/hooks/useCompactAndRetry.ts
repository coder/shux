import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useRouting } from "@/browser/hooks/useRouting";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import {
  formatCompactionCommandLine,
  getFollowUpContentText,
} from "@/browser/utils/compaction/format";
import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
  type CompactionSuggestion,
} from "@/browser/utils/compaction/suggestion";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { extractStagedAttachmentNotices } from "@/browser/features/ChatInput/stagedAttachments";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import type { FilePart, ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  buildAgentSkillMetadata,
  buildMcpPromptUserText,
  buildSkillInvocationUserText,
  withAgentSkillRefs,
  withMcpPromptRefs,
  type CompactionFollowUpInput,
  type DisplayedMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";

interface CompactAndRetryState {
  showCompactionUI: boolean;
  compactionSuggestion: CompactionSuggestion | null;
  isRetryingWithCompaction: boolean;
  hasTriggerUserMessage: boolean;
  hasCompactionRequest: boolean;
  retryWithCompaction: () => Promise<void>;
}

function findTriggerUserMessage(
  messages: DisplayedMessage[]
): Extract<DisplayedMessage, { type: "user" }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "user") {
      return msg;
    }
  }

  return null;
}

/**
 * Build follow-up content from a user message source.
 * Preserves skill metadata if the original message was a skill invocation.
 */
export function buildFollowUpFromSource(
  source: Extract<DisplayedMessage, { type: "user" }>,
  // Null ctx degrades gracefully: numeric one-shot thinking rides along as an
  // index for the backend to resolve instead of resolving here.
  ctx: { providersConfig: ProvidersConfigMap | null; currentModel: string | null } = {
    providersConfig: null,
    currentModel: null,
  }
): CompactionFollowUpInput {
  const slashMcpPromptRef = source.mcpPromptRefs?.find((ref) => ref.source === "slash");
  // A composed one-shot skill send ("/haiku+0 /done args") stores the full
  // typed text as content; re-parse it so the rebuilt follow-up keeps the
  // explicit model AND thinking overrides instead of falling back to class
  // routing / ambient workspace thinking.
  // trimStart matches parseCommand's own tolerance for leading whitespace —
  // a column-zero guard would silently drop the preserved one-shot.
  const parsedOneShot =
    source.agentSkill && source.content.trimStart().startsWith("/")
      ? parseCommand(source.content)
      : null;
  const oneShot = parsedOneShot?.type === "model-oneshot" ? parsedOneShot : null;
  const oneShotModel = oneShot?.modelString;
  const rawThinking = oneShot?.thinkingLevel;

  // Numeric thinking is model-relative, and the model that streams is decided
  // at dispatch: class routing can pick another model, and even an explicit
  // one-shot model can map to a different provider model by the time a long
  // compaction finishes. The RAW index therefore always rides along for the
  // backend to resolve against the model that actually streams; the level
  // resolved here (against the explicit model, else the current one) is only
  // the fallback for a send the backend does not re-resolve.
  let thinkingLevel: CompactionFollowUpInput["thinkingLevel"];
  let oneShotThinkingIndex: number | undefined;
  if (rawThinking != null) {
    if (typeof rawThinking !== "number") {
      thinkingLevel = rawThinking;
    } else {
      oneShotThinkingIndex = rawThinking;
      const referenceModel = oneShotModel ?? ctx.currentModel;
      thinkingLevel = referenceModel
        ? resolveThinkingInput(rawThinking, referenceModel, ctx.providersConfig)
        : undefined;
    }
  }
  const carriesOneShot = oneShotModel != null || rawThinking != null;

  const skillMetadata =
    source.agentSkill && source.agentSkill.skillName !== slashMcpPromptRef?.commandKey
      ? buildAgentSkillMetadata({
          rawCommand: source.content,
          // Preserve the displayed prefix (composed one-shots render
          // "/haiku+0 /done") — without it the rebuilt transcript loses the
          // command badge, which keys its highlighting on this value.
          commandPrefix: source.commandPrefix,
          skillName: source.agentSkill.skillName,
          scope: source.agentSkill.scope,
          arguments: source.agentSkill.arguments,
        })
      : undefined;

  // Slash messages display raw commands but send transformed text. Rebuild
  // provider content and preserve slash metadata so retried rows remain editable
  // as their original invocation.
  let text = source.content;
  let promptMetadata: MuxMessageMetadata | undefined;
  // Trim only for command detection/extraction (the parser accepted the
  // original send from a trimmed view); rawCommand keeps source.content
  // verbatim so the retried row displays exactly like the original.
  const trimmedContent = source.content.trimStart();
  if (skillMetadata && source.agentSkill) {
    // The displayed content is the raw command ("/haiku+0 /done finish"),
    // but dispatchPendingFollowUp sends text VERBATIM (no slash parsing):
    // the retry must carry the same model-facing payload the original send
    // streamed, with the raw command retained in metadata only. Generated
    // <attached-files> notices ride the content (staged attachments are
    // deliberately absent from fileParts) and must survive the rebuild.
    text = [
      buildSkillInvocationUserText(source.agentSkill.skillName, source.agentSkill.arguments ?? ""),
      ...extractStagedAttachmentNotices(source.content),
    ].join("\n");
  } else if (slashMcpPromptRef && trimmedContent.startsWith("/")) {
    const argumentText = trimmedContent.replace(/^\/\S+/, "").trimStart();
    text = buildMcpPromptUserText(
      slashMcpPromptRef.serverName,
      slashMcpPromptRef.promptName,
      argumentText
    );
    promptMetadata = {
      type: "normal",
      rawCommand: source.content,
      commandPrefix: `/${slashMcpPromptRef.commandKey}`,
    };
  }

  return {
    text,
    fileParts: source.fileParts,
    reviews: source.reviews,
    ...(oneShotModel != null ? { model: oneShotModel, skipSkillModelRouting: true } : {}),
    ...(thinkingLevel != null ? { thinkingLevel } : {}),
    ...(oneShotThinkingIndex != null ? { oneShotThinkingIndex } : {}),
    // The original one-shot send never persisted its overrides as workspace
    // defaults; the re-dispatch must not either.
    ...(carriesOneShot ? { skipAiSettingsPersistence: true } : {}),
    // Inline skill refs must survive alongside prompt refs; withAgentSkillRefs
    // dedupes against the slash ref that buildAgentSkillMetadata already added.
    muxMetadata: withAgentSkillRefs(
      withMcpPromptRefs(skillMetadata ?? promptMetadata, source.mcpPromptRefs ?? []),
      source.agentSkillRefs ?? []
    ),
  };
}

export function useCompactAndRetry(props: { workspaceId: string }): CompactAndRetryState {
  const workspaceState = useWorkspaceState(props.workspaceId);
  const { api } = useAPI();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const [providersConfig, setProvidersConfig] = useState<ProvidersConfigMap | null>(null);
  const { routePriority, routeOverrides } = useRouting();
  const [isRetryingWithCompaction, setIsRetryingWithCompaction] = useState(false);
  const isMountedRef = useRef(true);
  const autoCompactionAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const lastMessage = workspaceState
    ? workspaceState.messages[workspaceState.messages.length - 1]
    : undefined;

  const triggerUserMessage = useMemo(() => {
    if (!workspaceState) return null;
    return findTriggerUserMessage(workspaceState.messages);
  }, [workspaceState]);

  const isCompactionRecoveryFlow =
    lastMessage?.type === "stream-error" && !!triggerUserMessage?.compactionRequest;

  const isContextExceeded =
    lastMessage?.type === "stream-error" && lastMessage.errorType === "context_exceeded";

  const showCompactionUI = isContextExceeded || isCompactionRecoveryFlow;

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const configuredCompactionModel = agentAiDefaults.compact?.modelString ?? "";

  useEffect(() => {
    if (!api) return;
    if (!showCompactionUI) return;
    if (providersConfig) return;

    let active = true;
    const fetchProvidersConfig = async () => {
      try {
        const cfg = await api.providers.getConfig();
        if (active) {
          setProvidersConfig(cfg);
        }
      } catch {
        // Ignore failures fetching config (we just won't show a suggestion).
      }
    };

    fetchProvidersConfig().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [api, showCompactionUI, providersConfig]);

  const compactionTargetModel = useMemo(() => {
    if (!showCompactionUI) return null;
    if (triggerUserMessage?.compactionRequest?.parsed.model) {
      return triggerUserMessage.compactionRequest.parsed.model;
    }
    if (lastMessage?.type === "stream-error") {
      return lastMessage.model ?? workspaceState?.currentModel ?? null;
    }
    return workspaceState?.currentModel ?? null;
  }, [showCompactionUI, triggerUserMessage, lastMessage, workspaceState?.currentModel]);

  const compactionSuggestion = useMemo<CompactionSuggestion | null>(() => {
    if (!showCompactionUI || !compactionTargetModel) {
      return null;
    }

    if (isCompactionRecoveryFlow) {
      return getHigherContextCompactionSuggestion({
        currentModel: compactionTargetModel,
        providersConfig,
        policy: effectivePolicy,
        routePriority,
        routeOverrides,
      });
    }

    const preferred = configuredCompactionModel.trim();
    if (preferred.length > 0) {
      const explicit = getExplicitCompactionSuggestion({
        modelId: preferred,
        providersConfig,
        policy: effectivePolicy,
        routePriority,
        routeOverrides,
      });
      if (explicit) {
        return explicit;
      }
    }

    return getHigherContextCompactionSuggestion({
      currentModel: compactionTargetModel,
      providersConfig,
      policy: effectivePolicy,
      routePriority,
      routeOverrides,
    });
  }, [
    compactionTargetModel,
    showCompactionUI,
    isCompactionRecoveryFlow,
    providersConfig,
    effectivePolicy,
    configuredCompactionModel,
    routePriority,
    routeOverrides,
  ]);

  /**
   * Manual retry: user clicked "Compact & retry" button.
   * On failure, falls back to inserting the command into chat input.
   */
  const retryWithCompaction = useCallback(async (): Promise<void> => {
    const insertIntoChatInput = (text: string, fileParts?: FilePart[]): void => {
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
          text,
          mode: "replace",
          fileParts,
        })
      );
    };

    if (!compactionSuggestion) {
      insertIntoChatInput("/compact\n");
      return;
    }

    const suggestedCommandLine = formatCompactionCommandLine({
      model: compactionSuggestion.modelArg,
    });

    if (!api) {
      insertIntoChatInput(suggestedCommandLine + "\n");
      return;
    }

    if (isMountedRef.current) {
      setIsRetryingWithCompaction(true);
    }
    try {
      const sendMessageOptions = getSendOptionsFromStorage(props.workspaceId);
      const source = triggerUserMessage;

      if (!source) {
        insertIntoChatInput(suggestedCommandLine + "\n");
        return;
      }

      // For compaction recovery (retrying a failed /compact), preserve the original settings.
      // The nested follow-up content is already in the correct format.
      if (source.compactionRequest) {
        const parsedCompaction = source.compactionRequest.parsed;
        const maxOutputTokens = parsedCompaction.maxOutputTokens;
        const nestedFollowUp = parsedCompaction.followUpContent;
        const result = await executeCompaction({
          api,
          workspaceId: props.workspaceId,
          sendMessageOptions,
          model: compactionSuggestion.modelId,
          maxOutputTokens,
          followUpContent: nestedFollowUp,
          editMessageId: source.id,
        });

        if (!result.success) {
          console.error("Failed to retry compaction:", result.error);

          const slashCommand = formatCompactionCommandLine({
            model: compactionSuggestion.modelArg,
            maxOutputTokens,
          });

          const continueText = getFollowUpContentText(nestedFollowUp);
          const fallbackText = continueText ? `${slashCommand}\n${continueText}` : slashCommand;
          const shouldAppendNewline = !continueText;

          insertIntoChatInput(
            fallbackText + (shouldAppendNewline ? "\n" : ""),
            nestedFollowUp?.fileParts
          );
        }

        return;
      }

      // For normal messages (not /compact), build follow-up content directly.
      const followUpContent = buildFollowUpFromSource(source, {
        providersConfig,
        // Numeric one-shot thinking is model-relative: resolve the fallback
        // against the model the retry will actually be sent with (the
        // persisted send options), not the last streamed model — after a
        // routed skill turn that is the previous class model. The backend
        // re-resolves the raw index against the final model regardless.
        currentModel: sendMessageOptions.model ?? workspaceState?.currentModel ?? null,
      });
      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion.modelId,
        followUpContent,
        editMessageId: source.id,
      });

      if (!result.success) {
        console.error("Failed to start compaction:", result.error);
        insertIntoChatInput(suggestedCommandLine + "\n" + source.content, source.fileParts);
      }
    } catch (error) {
      console.error("Failed to retry with compaction:", error);
      insertIntoChatInput(suggestedCommandLine + "\n");
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }, [
    api,
    compactionSuggestion,
    props.workspaceId,
    triggerUserMessage,
    providersConfig,
    workspaceState?.currentModel,
  ]);

  /**
   * Auto-compact on context_exceeded. Runs silently - never touches chat input.
   * Returns true if compaction was attempted, false if preconditions not met.
   */
  const autoCompact = useCallback(async (): Promise<boolean> => {
    if (!api || !triggerUserMessage || triggerUserMessage.compactionRequest) {
      return false;
    }

    if (isMountedRef.current) {
      setIsRetryingWithCompaction(true);
    }

    try {
      const sendMessageOptions = getSendOptionsFromStorage(props.workspaceId);
      const followUpContent = buildFollowUpFromSource(triggerUserMessage, {
        providersConfig,
        // Numeric one-shot thinking is model-relative: resolve the fallback
        // against the model the retry will actually be sent with (the
        // persisted send options), not the last streamed model — after a
        // routed skill turn that is the previous class model. The backend
        // re-resolves the raw index against the final model regardless.
        currentModel: sendMessageOptions.model ?? workspaceState?.currentModel ?? null,
      });

      const result = await executeCompaction({
        api,
        workspaceId: props.workspaceId,
        sendMessageOptions,
        model: compactionSuggestion?.modelId,
        followUpContent,
        editMessageId: triggerUserMessage.id,
      });

      if (!result.success) {
        console.error("Auto-compaction failed:", result.error);
      }
      return result.success;
    } catch (error) {
      console.error("Auto-compaction error:", error);
      return false;
    } finally {
      if (isMountedRef.current) {
        setIsRetryingWithCompaction(false);
      }
    }
  }, [
    api,
    compactionSuggestion?.modelId,
    props.workspaceId,
    triggerUserMessage,
    providersConfig,
    workspaceState?.currentModel,
  ]);

  // Auto-trigger compaction on context_exceeded for seamless recovery.
  // Only auto-compact if we have a compaction suggestion; otherwise show manual UI.
  const shouldAutoCompact =
    api &&
    isContextExceeded &&
    providersConfig !== undefined &&
    compactionSuggestion &&
    triggerUserMessage &&
    !triggerUserMessage.compactionRequest &&
    lastMessage?.type === "stream-error" &&
    !isRetryingWithCompaction;

  useEffect(() => {
    if (!shouldAutoCompact || !lastMessage) return;
    if (autoCompactionAttemptRef.current === lastMessage.id) return;

    autoCompactionAttemptRef.current = lastMessage.id;
    autoCompact().catch(() => undefined);
  }, [shouldAutoCompact, lastMessage, autoCompact]);

  return {
    showCompactionUI,
    compactionSuggestion,
    isRetryingWithCompaction,
    hasTriggerUserMessage: !!triggerUserMessage,
    hasCompactionRequest: !!triggerUserMessage?.compactionRequest,
    retryWithCompaction,
  };
}
