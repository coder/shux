import React, { useMemo, useState } from "react";

import { SendHorizontal } from "lucide-react";

import type { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";
import { getSendOptionsFromStorage } from "xum/browser/utils/messages/sendOptions";

import { matchesKeybind, formatKeybind, KEYBINDS } from "xum/browser/utils/ui/keybinds";
import { useAPI } from "xum/browser/contexts/API";
import { AgentProvider, useAgent } from "xum/browser/contexts/AgentContext";
import { ThinkingProvider } from "xum/browser/contexts/ThinkingContext";
import { useThinkingLevel } from "xum/browser/hooks/useThinkingLevel";
import { usePersistedState } from "xum/browser/hooks/usePersistedState";
import { useModelsFromSettings } from "xum/browser/hooks/useModelsFromSettings";
import { normalizeToCanonical } from "xum/common/utils/ai/models";
import { useProviderOptions } from "xum/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "xum/browser/hooks/useAutoCompactionSettings";

import { VimTextArea } from "xum/browser/components/VimTextArea/VimTextArea";
import { ModelSelector } from "xum/browser/components/ModelSelector/ModelSelector";
import { ThinkingSelector } from "xum/browser/components/ThinkingSelector/ThinkingSelector";
import { ContextUsageIndicatorButton } from "xum/browser/components/ContextUsageIndicatorButton/ContextUsageIndicatorButton";
import { Tooltip, TooltipTrigger, TooltipContent } from "xum/browser/components/Tooltip/Tooltip";

import type { AgentId } from "xum/common/orpc/schemas";

import { calculateTokenMeterData } from "xum/common/utils/tokens/tokenMeterUtils";
import { createDisplayUsage } from "xum/common/utils/tokens/displayUsage";
import type { ChatUsageDisplay } from "xum/common/utils/tokens/usageAggregator";
import { enforceThinkingPolicy } from "xum/common/utils/thinking/policy";
import { cn } from "xum/common/lib/utils";
import { VIM_ENABLED_KEY, getInputKey, getModelKey } from "xum/common/constants/storage";

const SEND_MESSAGE_TIMEOUT_MS = 30_000;

/**
 * Simple agent toggle for VS Code extension (no agent discovery).
 * Just toggles between Exec and Plan agents.
 */
function SimpleAgentToggle(props: { agentId: AgentId; onChange: (agentId: AgentId) => void }) {
  const isPlan = props.agentId === "plan";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => props.onChange(isPlan ? "exec" : "plan")}
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-[11px] font-medium transition-all duration-150",
            isPlan
              ? "bg-plan-mode text-white hover:bg-plan-mode-hover"
              : "bg-exec-mode text-white hover:bg-exec-mode-hover"
          )}
        >
          {isPlan ? "Plan" : "Exec"}
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        Click to switch to {isPlan ? "Exec" : "Plan"} agent ({formatKeybind(KEYBINDS.TOGGLE_MODE)})
      </TooltipContent>
    </Tooltip>
  );
}

function getLastContextUsage(
  aggregator: StreamingMessageAggregator,
  fallbackModel: string | null
): ChatUsageDisplay | undefined {
  const messages = aggregator.getAllMessages();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      continue;
    }

    if (msg.metadata?.compacted) {
      continue;
    }

    const rawUsage = msg.metadata?.contextUsage;
    if (!rawUsage) {
      continue;
    }

    const providerMetadata =
      msg.metadata?.contextProviderMetadata ?? msg.metadata?.providerMetadata;
    const model = msg.metadata?.model ?? fallbackModel ?? "unknown";

    return createDisplayUsage(rawUsage, model, providerMetadata);
  }

  return undefined;
}

function ChatComposerInner(props: {
  workspaceId: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  aggregator: StreamingMessageAggregator | null;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  const apiState = useAPI();
  const api = apiState.api;

  const { agentId, setAgentId } = useAgent();
  const [thinkingLevel] = useThinkingLevel();

  const { options: providerOptions } = useProviderOptions();
  const use1M = providerOptions.anthropic?.use1MContext ?? false;

  const {
    models,
    customModels,
    hiddenModels,
    hideModel,
    unhideModel,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
  } = useModelsFromSettings();

  const modelKey = getModelKey(props.workspaceId);
  const [preferredModel, setPreferredModel] = usePersistedState<string>(modelKey, defaultModel, {
    listener: true,
  });

  const baseModel = normalizeToCanonical(preferredModel);

  const inputKey = getInputKey(props.workspaceId);
  const [input, setInput] = usePersistedState<string>(inputKey, "", { listener: true });

  const [vimEnabled, setVimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, {
    listener: true,
  });
  const [isSending, setIsSending] = useState(false);

  const aggregator = props.aggregator;
  const canInterruptStream = Boolean(aggregator?.getActiveStreamMessageId());
  const isCompactingStream = aggregator?.isCompacting() ?? false;
  const usageModelFromAggregator = aggregator?.getCurrentModel() ?? null;

  // Note: avoid memoizing against the aggregator reference.
  // The aggregator mutates in-place as events stream in.
  const lastContextUsage = aggregator
    ? getLastContextUsage(aggregator, usageModelFromAggregator)
    : undefined;

  const liveUsage = (() => {
    if (!aggregator) {
      return undefined;
    }

    const activeStreamMessageId = aggregator.getActiveStreamMessageId();
    if (!activeStreamMessageId) {
      return undefined;
    }

    const model = usageModelFromAggregator;
    if (!model) {
      return undefined;
    }

    const rawUsage = aggregator.getActiveStreamUsage(activeStreamMessageId);
    const providerMetadata = aggregator.getActiveStreamStepProviderMetadata(activeStreamMessageId);

    return rawUsage ? createDisplayUsage(rawUsage, model, providerMetadata) : undefined;
  })();

  const lastUsage = liveUsage ?? lastContextUsage;
  const usageModel = lastUsage?.model ?? usageModelFromAggregator;

  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, usageModel ?? "unknown", use1M, false)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, usageModel, use1M]);

  const autoCompactionSettings = useAutoCompactionSettings(props.workspaceId, usageModel);

  const canSend =
    !props.disabled &&
    !isSending &&
    input.trim().length > 0 &&
    apiState.status === "connected" &&
    Boolean(api);

  const onModelChange = (model: string) => {
    const canonicalModel = normalizeToCanonical(model);
    ensureModelInSettings(canonicalModel);
    setPreferredModel(canonicalModel);

    if (!api) {
      return;
    }

    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, thinkingLevel);

    api.workspace
      .updateAgentAISettings({
        workspaceId: props.workspaceId,
        agentId,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
      })
      .catch(() => {
        // Best-effort only.
      });
  };

  const cycleModels = customModels.length > 0 ? customModels : models;

  const cycleToNextModel = () => {
    if (cycleModels.length < 2) {
      return;
    }

    const currentIndex = cycleModels.indexOf(baseModel);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleModels.length;
    const nextModel = cycleModels[nextIndex];
    if (nextModel) {
      onModelChange(nextModel);
    }
  };

  const onSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed === "/vim") {
      const next = !vimEnabled;
      setVimEnabled(next);
      setInput("");
      props.onNotice({ level: "info", message: `Vim mode ${next ? "enabled" : "disabled"}.` });
      return;
    }

    if (!api) {
      props.onNotice({ level: "error", message: "Not connected to Xum server." });
      return;
    }

    setIsSending(true);
    setInput("");

    const restoreTrimmedIfSafe = () => {
      // Avoid clobbering a new draft typed while the request is in flight.
      setInput((current) => (current.trim().length === 0 ? trimmed : current));
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, SEND_MESSAGE_TIMEOUT_MS);

    try {
      const options = getSendOptionsFromStorage(props.workspaceId);

      const result = await api.workspace.sendMessage(
        {
          workspaceId: props.workspaceId,
          message: trimmed,
          options,
        },
        { signal: controller.signal }
      );

      if (!result.success) {
        const errorString =
          typeof result.error === "string" ? result.error : JSON.stringify(result.error, null, 2);
        props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
        restoreTrimmedIfSafe();
        return;
      }

      props.onSendComplete();
    } catch (error) {
      if (controller.signal.aborted) {
        props.onNotice({
          level: "error",
          message: `Send timed out after ${SEND_MESSAGE_TIMEOUT_MS / 1000}s. Try again.`,
        });
        restoreTrimmedIfSafe();
        return;
      }

      const errorString = error instanceof Error ? error.message : String(error);
      props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
      restoreTrimmedIfSafe();
    } finally {
      clearTimeout(timeoutId);
      setIsSending(false);
    }
  };

  const placeholder = (() => {
    if (props.disabled) {
      const disabledReason = props.disabledReason;
      if (typeof disabledReason === "string" && disabledReason.trim().length > 0) {
        return disabledReason;
      }
    }

    if (isCompactingStream) {
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    const hints: string[] = [];
    if (canInterruptStream) {
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      hints.push(`${formatKeybind(interruptKeybind)} to interrupt`);
    }

    hints.push(
      `${formatKeybind(KEYBINDS.SEND_MESSAGE)} to ${canInterruptStream ? "queue" : "send"}`
    );
    hints.push(`Click model to choose, ${formatKeybind(KEYBINDS.CYCLE_MODEL)} to cycle`);
    hints.push(`/vim to toggle Vim mode (${vimEnabled ? "on" : "off"})`);

    return `Type a message... (${hints.join(", ")})`;
  })();

  return (
    <div className="flex flex-col gap-2">
      <VimTextArea
        value={input}
        onChange={setInput}
        placeholder={placeholder}
        disabled={props.disabled}
        onKeyDown={(e) => {
          if (matchesKeybind(e, KEYBINDS.CYCLE_MODEL)) {
            e.preventDefault();
            cycleToNextModel();
            return;
          }

          if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
            e.preventDefault();
            void onSend();
          }
        }}
      />

      <div className="flex flex-col gap-2">
        <div className="w-full min-w-0" data-component="ModelSelectorGroup">
          <ModelSelector
            value={baseModel}
            onChange={onModelChange}
            models={models}
            hiddenModels={hiddenModels}
            defaultModel={defaultModel}
            onSetDefaultModel={setDefaultModel}
            onHideModel={hideModel}
            onUnhideModel={unhideModel}
          />
        </div>

        <div className="@container flex items-center justify-between gap-2">
          <div className="flex shrink-0 items-center overflow-visible">
            <ThinkingSelector modelString={baseModel} allowProMode={false} allowFastMode={false} />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <ContextUsageIndicatorButton
              data={contextUsageData}
              autoCompaction={autoCompactionSettings}
            />
            <SimpleAgentToggle agentId={agentId} onChange={setAgentId} />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onSend()}
                  disabled={!canSend}
                  aria-label="Send message"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border border-border-light px-1.5 py-0.5 text-[11px] font-medium text-white transition-colors duration-200 disabled:opacity-50",
                    agentId === "plan"
                      ? "bg-plan-mode hover:bg-plan-mode-hover disabled:hover:bg-plan-mode"
                      : "bg-exec-mode hover:bg-exec-mode-hover disabled:hover:bg-exec-mode"
                  )}
                >
                  <SendHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent align="center">
                Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatComposer(props: {
  workspaceId: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  aggregator: StreamingMessageAggregator | null;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  return (
    <AgentProvider workspaceId={props.workspaceId}>
      <ThinkingProvider workspaceId={props.workspaceId}>
        <ChatComposerInner
          workspaceId={props.workspaceId}
          disabled={props.disabled}
          disabledReason={props.disabledReason}
          aggregator={props.aggregator}
          onSendComplete={props.onSendComplete}
          onNotice={props.onNotice}
        />
      </ThinkingProvider>
    </AgentProvider>
  );
}
