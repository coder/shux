import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  isInitialStagingLocked,
  subscribeInitialStagingLock,
} from "@/browser/features/ChatInput/initialStagingLock";
import {
  CommandSuggestions,
  COMMAND_SUGGESTION_KEYS,
} from "@/browser/features/ChatInput/CommandSuggestions";
import type { Toast } from "@/browser/features/ChatInput/ChatInputToast";
import { ConnectionStatusToast } from "@/browser/components/ConnectionStatusToast/ConnectionStatusToast";
import { ChatInputToast } from "@/browser/features/ChatInput/ChatInputToast";
import type { SendMessageError } from "@/common/types/errors";
import { createErrorToast } from "@/browser/features/ChatInput/ChatInputToasts";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import {
  readPersistedState,
  usePersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import { ThinkingSelector } from "@/browser/components/ThinkingSelector/ThinkingSelector";
import {
  getAllowedRuntimeModesForUi,
  isParsedRuntimeAllowedByPolicy,
} from "@/browser/utils/policyUi";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import {
  useAdditionalSystemContextHydrated,
  useAdditionalSystemContextSnapshot,
} from "@/browser/utils/additionalSystemContextStore";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  clearPendingWorkspaceAiSettings,
  markPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import { resolveWorkspaceAiSettingsForAgent } from "@/browser/utils/workspaceModeAi";
import {
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  AGENT_AI_DEFAULTS_KEY,
  VIM_ENABLED_KEY,
  RUNTIME_ENABLEMENT_KEY,
  getProjectScopeId,
  getPendingDraftSkillDiscoveryKey,
  getPendingWorkspaceSendErrorKey,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";
import {
  prepareCompactionMessage,
  processSlashCommand,
  type CommandAction,
  type SlashCommandEnv,
} from "@/browser/utils/chatCommands";
import {
  addWorkflowRunCardMessageForRun,
  getWorkflowRunCardProjection,
} from "@/browser/utils/workflowRunMessages";
import { Button } from "@/browser/components/Button/Button";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { extractInlineSkillReferenceCandidates } from "@/browser/utils/agentSkills/inlineSkillReferences";
import {
  convertSymbolCommandAtCursor,
  convertTerminatedSymbolCommand,
} from "@/browser/features/ChatInput/symbolShortcuts";
import {
  formatProjectHierarchyLabel,
  resolveWorkspaceCreationScope,
} from "@/common/utils/subProjects";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { CreationProjectSelect } from "./CreationProjectSelect";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { AgentModePicker } from "@/browser/components/AgentModePicker/AgentModePicker";
import { ContextUsageIndicatorButton } from "@/browser/components/ContextUsageIndicatorButton/ContextUsageIndicatorButton";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceStoreRaw,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { getPlaceholderTip } from "./placeholderTips";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { useIdleCompactionHours } from "@/browser/hooks/useIdleCompactionHours";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import {
  matchesKeybind,
  formatKeybind,
  KEYBINDS,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  ModelSelector,
  type ModelSelectorRef,
} from "@/browser/components/ModelSelector/ModelSelector";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { SendHorizontal } from "lucide-react";
import { AttachFileButton } from "./AttachFileButton";
import { VimTextArea } from "@/browser/components/VimTextArea/VimTextArea";
import { ChatAttachments } from "@/browser/features/ChatInput/ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import {
  buildPendingFromRestoredInput,
  type PendingUserMessage,
} from "@/browser/utils/chatEditing";

import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { type OpenAIReasoningMode, type ThinkingLevel } from "@/common/types/thinking";
import {
  DEFAULT_RUNTIME_ENABLEMENT,
  normalizeRuntimeEnablement,
  type CoderWorkspaceConfig,
} from "@/common/types/runtime";
import {
  type AgentSkillReference,
  type MuxMessageMetadata,
  type ReviewNoteDataForDisplay,
  withAgentSkillRefs,
  withMcpPromptRefs,
} from "@/common/types/message";
import {
  getModelCapabilities,
  getModelCapabilitiesResolved,
} from "@/common/utils/ai/modelCapabilities";
import { KNOWN_MODELS, MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { trackCommandUsed } from "@/common/telemetry";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";

import { CreationCenterContent } from "./CreationCenterContent";
import { cn } from "@/common/lib/utils";
import type {
  ChatInputProps,
  ChatInputAPI,
  GoalInterventionPolicy,
  QueueDispatchMode,
} from "./types";
import { CreationControls } from "./CreationControls";
import { SEND_DISPATCH_MODES } from "./sendDispatchModes";
import { CodexOauthWarningBanner } from "./CodexOauthWarningBanner";
import { useCreationWorkspace } from "./useCreationWorkspace";
import { useCoderWorkspace } from "@/browser/hooks/useCoderWorkspace";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { usePowerMode } from "@/browser/contexts/PowerModeContext";
import { useVoiceInput } from "@/browser/hooks/useVoiceInput";
import { VoiceInputButton } from "./VoiceInputButton";
import {
  formatPendingFileStagingError,
  getPendingFileAttachments,
  replacePendingFilesWithStaged,
  stagePendingFiles,
} from "./pendingFileAttachments";
import { RecordingOverlay } from "./RecordingOverlay";
import { AttachedReviewsPanel } from "./AttachedReviewsPanel";
import {
  buildSkillInvocationMetadata,
  hasProjectScopedSkillRef,
  parseCommandWithSkillInvocation,
  resolveInlineSkillRefsForSend,
  resolveMcpPromptRefsForSend,
  validateCreationRuntime,
  filePartsToChatAttachments,
  type MCPPromptInvocation,
  type SkillInvocation,
  type SkillResolutionTarget,
} from "./utils";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { isGoalRunning } from "@/common/types/goal";
import { appendStagedAttachmentNotice, getStagedAttachments } from "./stagedAttachments";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  COMPOSER_CONTROL_HEIGHT_CLASS,
  COMPOSER_ICON_ONLY_HIDE_CLASS,
  COMPOSER_WORKSPACE_ICON_ONLY_HIDE_CLASS,
  CHAT_DOCK_GUTTER_CLASS,
  CREATION_COLUMN_MAX_WIDTH_CLASS,
} from "@/constants/layout";
import { useChatDockColumnWidthClass } from "@/browser/components/ChatPane/chatDockColumn";
import { prepareMessagePayload } from "./prepareMessagePayload";
import {
  estimateBase64DataUrlBytes,
  isPdfAttachment,
  useComposerAttachments,
} from "./useComposerAttachments";
import { useComposerDraft } from "./useComposerDraft";
import { useComposerSuggestions } from "./useComposerSuggestions";

export type { ChatInputProps, ChatInputAPI };

interface SendOverrides {
  queueDispatchMode?: QueueDispatchMode;
  goalInterventionPolicy?: GoalInterventionPolicy;
}

interface InternalSendOverrides extends SendOverrides {
  skipBoundaryEditConfirmation?: boolean;
}

const ChatInputInner: React.FC<ChatInputProps> = (props) => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const runtimePolicy = useMemo(
    () => getAllowedRuntimeModesForUi(effectivePolicy),
    [effectivePolicy]
  );
  const { variant } = props;
  const { userProjects } = useProjectContext();
  const creationScope =
    variant === "creation"
      ? resolveWorkspaceCreationScope(props.projectPath, userProjects, props.pendingSubProjectPath)
      : null;
  const creationParentProjectPath = creationScope?.projectPath ?? "";
  const creationSubProjectPath = creationScope?.subProjectPath ?? undefined;
  const creationProject =
    variant === "creation" ? userProjects.get(creationParentProjectPath) : undefined;
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();
  const dynamicWorkflowsExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const atMentionProjectPath =
    variant === "creation" && props.kind !== "scratch" ? props.projectPath : null;
  const asyncCommandScopeRef = useRef<{ variant: typeof variant; workspaceId: string | null }>({
    variant,
    workspaceId: variant === "workspace" ? props.workspaceId : null,
  });
  const asyncCommandTokenRef = useRef(0);
  const workspaceId = variant === "workspace" ? props.workspaceId : null;
  // One controller covers all sends in a composer scope. Scope changes abort
  // stale continuations; unmount does not, so submitted sends can still reach
  // their captured workspace after navigation.
  const sendResolutionAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    asyncCommandScopeRef.current = { variant, workspaceId };
    sendResolutionAbortRef.current?.abort();
    sendResolutionAbortRef.current = null;
  }, [variant, workspaceId]);

  const store = useWorkspaceStoreRaw();
  const workspaceSidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const workspaceGoal = workspaceSidebarState?.goal ?? null;

  // Lock the composer while a creation-flow staging + initial send is still in
  // flight for this workspace (deferred runtimes can hold it for minutes), so a
  // user send cannot leapfrog the initial message and a failure transfer cannot
  // overwrite a freshly typed draft.
  const initialStagingLocked = useSyncExternalStore(subscribeInitialStagingLock, () =>
    variant === "workspace" ? isInitialStagingLocked(props.workspaceId) : false
  );

  // Extract workspace-specific props with defaults
  const disabled = (props.disabled ?? false) || initialStagingLocked;
  const editingMessage = variant === "workspace" ? props.editingMessage : undefined;
  const [pendingBoundaryEditConfirmation, setPendingBoundaryEditConfirmation] =
    useState<SendOverrides | null>(null);
  // Hide edit-mode chrome as soon as an edit send starts so the input doesn't sit blank
  // while the backend acknowledges the edit and begins the replacement stream.
  const [optimisticallyDismissedEditId, setOptimisticallyDismissedEditId] = useState<string | null>(
    null
  );
  const editingMessageForUi =
    editingMessage?.id === optimisticallyDismissedEditId ? undefined : editingMessage;
  const isTranscriptCaughtUp =
    variant === "workspace" ? (props.isTranscriptCaughtUp ?? false) : false;
  const isStreamStarting = variant === "workspace" ? (props.isStreamStarting ?? false) : false;
  const isCompacting = variant === "workspace" ? (props.isCompacting ?? false) : false;
  const [isMobileTouch, setIsMobileTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileTouchMediaQuery = window.matchMedia("(max-width: 768px) and (pointer: coarse)");
    const handleMobileTouchChange = () => {
      setIsMobileTouch(mobileTouchMediaQuery.matches);
    };

    handleMobileTouchChange();
    mobileTouchMediaQuery.addEventListener("change", handleMobileTouchChange);
    return () => {
      mobileTouchMediaQuery.removeEventListener("change", handleMobileTouchChange);
    };
  }, []);
  useEffect(() => {
    if (
      optimisticallyDismissedEditId != null &&
      editingMessage?.id !== optimisticallyDismissedEditId
    ) {
      setOptimisticallyDismissedEditId(null);
    }
  }, [editingMessage?.id, optimisticallyDismissedEditId]);
  // runtimeType for telemetry - defaults to "worktree" if not provided
  const runtimeType = variant === "workspace" ? (props.runtimeType ?? "worktree") : "worktree";

  // Callback for model changes (both variants support this)
  const onModelChange = props.onModelChange;

  // User request: keep creation runtime controls synced with Settings enablement toggles.
  const [rawRuntimeEnablement] = usePersistedState(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );
  const runtimeEnablement = normalizeRuntimeEnablement(rawRuntimeEnablement);

  // Track concurrent sends with a counter (not boolean) to handle queued follow-ups correctly.
  // When a follow-up is queued during stream-start, it resolves immediately but shouldn't
  // clear the "in flight" state until all sends complete.
  const [sendingCount, setSendingCount] = useState(0);
  const isSending = sendingCount > 0;
  const sendModeMenuContainerRef = useRef<HTMLDivElement>(null);
  const [hideReviewsDuringSend, setHideReviewsDuringSend] = useState(false);
  const projectedWorkflowRunCardKeysRef = useRef(new Set<string>());
  const workflowsRequestIdRef = useRef(0);
  const [toast, setToast] = useState<Toast | null>(null);
  // State for destructive command confirmation modal (currently only /clear).
  const [pendingDestructiveCommand, setPendingDestructiveCommand] = useState(false);
  const pushToast = useCallback(
    (nextToast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => {
      // Keep a dedicated "info" intent for callsites while rendering with the shared non-error toast style.
      const type = nextToast.type === "info" ? "success" : nextToast.type;
      setToast({ id: Date.now().toString(), ...nextToast, type });
    },
    [setToast]
  );
  // A draft transferred from a failed creation send may have resolved its
  // slash skill against the project path; honor that choice on the retry.
  // listener: true keeps this in sync when the transfer lands after mount and
  // when a successful send clears the key, so the skill descriptor list below
  // reloads under the matching discovery target.
  const [transferredDraftProjectDiscovery] = usePersistedState<boolean>(
    variant === "workspace" && workspaceId
      ? getPendingDraftSkillDiscoveryKey(workspaceId)
      : "__unused__",
    false,
    { listener: true }
  );

  // Subscribe to pending send errors from creation flow. Uses listener: true so
  // late failures (e.g., slow devcontainer startup) still surface a toast.
  const pendingErrorKey =
    variant === "workspace" && workspaceId ? getPendingWorkspaceSendErrorKey(workspaceId) : null;
  const [pendingError, setPendingError] = usePersistedState<SendMessageError | null>(
    pendingErrorKey ?? "__unused__",
    null,
    { listener: true }
  );
  useEffect(() => {
    if (!pendingErrorKey || !pendingError) return;
    setToast(createErrorToast(pendingError));
    setPendingError(null);
  }, [pendingErrorKey, pendingError, setPendingError]);

  const handleToastDismiss = useCallback(() => {
    setToast(null);
  }, []);

  const draft = useComposerDraft({
    variant,
    workspaceId,
    creationProjectPath: creationParentProjectPath,
    pendingDraftId: variant === "creation" ? (props.pendingDraftId ?? undefined) : undefined,
    attachedReviews: variant === "workspace" ? (props.attachedReviews ?? []) : [],
    pushToast,
  });
  const { input, setInput, attachments, setAttachments, draftReviews, setDraftReviews } = draft;
  const { getDraft, setDraft, preEditDraftRef, preEditReviewsRef } = draft;
  const { reviewOverrideActive, reviewData, reviewIdsForCheck, reviewPanelItems } = draft;
  const { removeDraftReview, updateDraftReviewNote, storageKeys, latestInputValueRef } = draft;
  const {
    processingAttachmentCount,
    handlePaste,
    handleAttachFiles,
    handleDragOver,
    handleDrop,
    handleRemoveAttachment,
  } = useComposerAttachments({
    variant,
    workspaceId,
    setAttachments,
    editingMessage: editingMessageForUi != null,
    pushToast,
  });
  const workspaceIdForComposerClear = variant === "workspace" ? props.workspaceId : null;
  const onDetachAllReviewsForComposerClear =
    variant === "workspace" ? props.onDetachAllReviews : undefined;

  // Creation sends can resolve after navigation; guard draft clears on unmounted inputs.
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<ModelSelectorRef>(null);
  const powerMode = usePowerMode();
  const handleInputChange = useCallback(
    (next: string, caretFromEvent?: number) => {
      if (powerMode.enabled) {
        const prev = latestInputValueRef.current;
        const delta = next.length - prev.length;

        if (next !== prev) {
          // Power Mode positioning depends on the textarea's post-layout size/position.
          // On backspace/delete the textarea can shrink (auto-resize) which shifts the caret
          // downward; if we measure immediately we can get a stale bounding rect and the
          // fireworks appear out-of-sync with the cursor.
          const intensity = delta > 0 ? Math.min(6, delta) : delta < 0 ? Math.min(6, -delta) : 1;
          const kind = delta < 0 ? "delete" : "insert";
          // Capture the caret index now (before rAF) so bursts queued within the same frame
          // don't all measure the latest caret position and appear "ahead" during fast typing.
          const caretIndex = caretFromEvent ?? inputRef.current?.selectionStart ?? next.length;

          requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) {
              return;
            }

            const emit = () => powerMode.burstFromTextarea(el, intensity, kind, caretIndex);

            // When the textarea is scrollable, scrollTop may settle one frame after
            // the layout shift, so defer measurement to a second rAF.
            if (el.scrollHeight > el.clientHeight) {
              requestAnimationFrame(emit);
              return;
            }

            emit();
          });
        }
      }

      // Auto-convert a backslash symbol command (e.g. "\alpha" -> α, "\leq" -> ≤).
      // Eager path fires only for unambiguous names; the terminator path accepts
      // a completed name when a space/punctuation follows (e.g. "\in " -> "∈ ").
      // Both only act at the caret, so partial/mid-word edits are left untouched.
      const caret = caretFromEvent ?? inputRef.current?.selectionStart ?? next.length;
      const converted =
        convertSymbolCommandAtCursor(next, caret) ?? convertTerminatedSymbolCommand(next, caret);
      if (converted) {
        setInput(converted.text);
        const newCursor = converted.cursor;
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el || el.disabled) {
            return;
          }
          el.selectionStart = newCursor;
          el.selectionEnd = newCursor;
        });
        return { text: converted.text, cursor: converted.cursor };
      }

      setInput(next);
      return { text: next, cursor: caret };
    },
    [latestInputValueRef, powerMode, setInput]
  );

  const { open } = useSettings();
  const { selectedWorkspace, beginWorkspaceCreation } = useWorkspaceContext();
  const { agentId, currentAgent, agents } = useAgent();

  // Use current agent's uiColor, or neutral border until agents load
  const agentColor = currentAgent?.uiColor ?? "var(--color-border-light)";
  const composerSurfaceStyle: React.CSSProperties & { "--composer-focus-border": string } = {
    "--composer-focus-border": agentColor,
  };
  const {
    models,
    hiddenModelsForSelector,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
    codexOauthSet,
    requiresCodexOauth,
  } = useModelsFromSettings();

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const telemetry = useTelemetry();
  const [vimEnabled, setVimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, {
    listener: true,
  });
  const { startSequence: startTutorial } = useTutorial();

  // Track transcription provider prerequisites from Settings → Providers.
  const [openAIKeySet, setOpenAIKeySet] = useState(false);
  const [openAIProviderEnabled, setOpenAIProviderEnabled] = useState(true);
  const [muxGatewayCouponSet, setMuxGatewayCouponSet] = useState(false);
  const [muxGatewayEnabled, setMuxGatewayEnabled] = useState(true);
  const isTranscriptionAvailable =
    (openAIProviderEnabled && openAIKeySet) || (muxGatewayEnabled && muxGatewayCouponSet);

  // Voice input - appends transcribed text to input
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setInput((prev) => {
        const separator = prev.length > 0 && !prev.endsWith(" ") ? " " : "";
        return prev + separator + text;
      });
    },
    onError: (error) => {
      pushToast({ type: "error", message: error });
    },
    onSend: () => void handleSend(),
    isTranscriptionAvailable,
    useRecordingKeybinds: true,
    api,
  });

  const voiceInputUnavailableMessage =
    "Voice input requires a Xum Gateway login or an OpenAI API key. Configure in Settings → Providers.";

  // Start creation tutorial when entering creation mode
  useEffect(() => {
    if (variant === "creation") {
      // Small delay to ensure UI is rendered
      const timer = setTimeout(() => {
        startTutorial("creation");
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [variant, startTutorial]);

  // Get current send message options from shared hook (must be at component top level)
  // For creation variant, use project-scoped key; for workspace, use workspace ID
  const sendMessageOptions = useSendMessageOptions(
    variant === "workspace" ? props.workspaceId : getProjectScopeId(creationParentProjectPath)
  );
  const composerSuggestions = useComposerSuggestions({
    input,
    setInput,
    inputRef,
    variant,
    workspaceId,
    projectPath: atMentionProjectPath,
    disableWorkspaceAgents: sendMessageOptions.disableWorkspaceAgents === true,
  });
  const { agentSkillDescriptors, handleInputCaretChange, mcpPromptDescriptors } =
    composerSuggestions;
  const handleComposerInputChange = (next: string, caret?: number) => {
    // Feed the suggestion seam the applied text/cursor: symbol auto-conversion
    // can rewrite both, and caret state keyed to the pre-conversion text would
    // fall back to end-of-input over the converted draft.
    const applied = handleInputChange(next, caret);
    handleInputCaretChange(applied.cursor, applied.text);
  };
  const additionalSystemContext = useAdditionalSystemContextSnapshot(
    variant === "workspace" ? props.workspaceId : ""
  );
  const additionalSystemContextHydrated = useAdditionalSystemContextHydrated(
    variant === "workspace" ? props.workspaceId : ""
  );
  // Extract models for convenience (don't create separate state - use hook as single source of truth)
  // - preferredModel: selected model used for backend routing, preserving explicit gateway choices
  // - baseModel: canonical format for UI display and policy checks (e.g., ThinkingSelector)
  const preferredModel = sendMessageOptions.model;
  const baseModel = sendMessageOptions.baseModel;

  // Context usage indicator data (workspace variant only)
  const workspaceIdForUsage = variant === "workspace" ? props.workspaceId : "";
  const usage = useWorkspaceUsage(workspaceIdForUsage);
  const { has1MContext } = useProviderOptions();
  const { config: providersConfig } = useProvidersConfig();
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  // Token counts come from usage metadata, but context limits/1M eligibility should
  // follow the currently selected model unless a stream is actively running.
  const activeUsageModel = usage?.liveUsage?.model ?? null;
  const contextDisplayModel = activeUsageModel ?? baseModel;
  const use1M = has1MContext(contextDisplayModel);
  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, contextDisplayModel, use1M, false, providersConfig)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, contextDisplayModel, use1M, providersConfig]);
  const autoCompactionProps = useAutoCompactionSettings(workspaceIdForUsage, contextDisplayModel);

  // Idle compaction settings (per-project, persisted to backend for idleCompactionService)
  const { hours: idleCompactionHours, setHours: setIdleCompactionHours } = useIdleCompactionHours({
    projectPath: selectedWorkspace?.projectPath ?? null,
  });
  const idleCompactionProps = useMemo(
    () => ({
      hours: idleCompactionHours,
      setHours: setIdleCompactionHours,
    }),
    [idleCompactionHours, setIdleCompactionHours]
  );

  const setPreferredModel = useCallback(
    (model: string) => {
      type WorkspaceAISettingsByAgentCache = Partial<
        Record<
          string,
          { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
        >
      >;

      const selectedModel = normalizeSelectedModel(model);
      if (
        variant === "workspace" &&
        hasBudgetedResumableGoal(workspaceGoal) &&
        !modelHasPricingData(selectedModel, providersConfig)
      ) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
        });
        return;
      }

      ensureModelInSettings(selectedModel); // Ensure model exists in Settings

      if (onModelChange) {
        // Notify parent of model change (for context switch warning + persisted model metadata).
        // Called before early returns so warnings work even offline or with custom agents.
        onModelChange(selectedModel);
      } else {
        const scopeId =
          variant === "creation" ? getProjectScopeId(creationParentProjectPath) : workspaceId;
        if (scopeId) {
          setWorkspaceModelWithOrigin(scopeId, selectedModel, "user");
        }
      }

      if (variant !== "workspace" || !workspaceId) {
        return;
      }

      const normalizedAgentId = normalizeAgentId(agentId, "exec");

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            // Include reasoningMode so a model change cannot wipe the persisted
            // pro-mode choice (backend replaces the agent's settings wholesale).
            [normalizedAgentId]: { model: selectedModel, thinkingLevel, reasoningMode },
          };
        },
        {}
      );

      // Workspace variant: persist to backend for cross-device consistency.
      if (!api) {
        return;
      }

      markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
        model: selectedModel,
        thinkingLevel,
        reasoningMode,
      });

      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: normalizedAgentId,
          aiSettings: { model: selectedModel, thinkingLevel, reasoningMode },
        })
        .then((result) => {
          if (!result.success) {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          }
        })
        .catch(() => {
          clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          // Best-effort only. If offline or backend is old, sendMessage will persist.
        });
    },
    [
      api,
      agentId,
      creationParentProjectPath,
      ensureModelInSettings,
      providersConfig,
      onModelChange,
      thinkingLevel,
      reasoningMode,
      variant,
      workspaceGoal,
      workspaceId,
    ]
  );

  // Model cycling candidates: all visible models (custom + built-in, minus hidden).
  const cycleModels = models;

  const cycleToNextModel = useCallback(() => {
    if (cycleModels.length < 2) {
      return;
    }

    const currentIndex = cycleModels.indexOf(baseModel);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleModels.length;
    const nextModel = cycleModels[nextIndex];
    if (nextModel) {
      setPreferredModel(nextModel);
    }
  }, [baseModel, cycleModels, setPreferredModel]);

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.open();
  }, []);
  const hasCreationRuntimeOverrides =
    creationProject?.runtimeOverridesEnabled === true ||
    Boolean(creationProject?.runtimeEnablement) ||
    creationProject?.defaultRuntime !== undefined;
  // Keep workspace creation in sync with Settings → Runtimes project overrides.
  const creationRuntimeEnablement =
    variant === "creation" && hasCreationRuntimeOverrides
      ? normalizeRuntimeEnablement(creationProject?.runtimeEnablement)
      : runtimeEnablement;
  const [hasAttemptedCreateSend, setHasAttemptedCreateSend] = useState(false);

  // Creation-specific state (hook always called, but only used when variant === "creation")
  // This avoids conditional hook calls which violate React rules
  const creationNameMessage =
    variant === "creation"
      ? (() => {
          const parsedCreationCommand = parseCommand(input.trim());
          if (parsedCreationCommand?.type === "goal-set") {
            return parsedCreationCommand.objective;
          }
          if (input.trim().length === 0 && attachments.length > 0) {
            const filenames = attachments
              .map((attachment) => attachment.filename)
              .filter((filename): filename is string => typeof filename === "string");
            return filenames.length > 0 ? `Attached files: ${filenames.join(", ")}` : "";
          }
          return input;
        })()
      : "";
  const creationState = useCreationWorkspace(
    variant === "creation"
      ? {
          kind: props.kind,
          projectPath: creationParentProjectPath,
          subProjectPath: creationSubProjectPath,
          onWorkspaceCreated: props.onWorkspaceCreated,
          message: creationNameMessage,
          dynamicWorkflowsEnabled: dynamicWorkflowsExperimentEnabled,
          draftId: props.pendingDraftId,
          userModel: preferredModel,
        }
      : {
          // Dummy values for workspace variant (never used)
          projectPath: "",
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onWorkspaceCreated: () => {},
          message: "",
        }
  );

  // Creation sends also pass through the async resolution phase guarded by
  // sendingCount, so include it alongside the creation-specific flag.
  const isSendInFlight = variant === "creation" ? creationState.isSending || isSending : isSending;
  const sendInFlightBlocksInput =
    variant === "workspace" ? isSendInFlight && !isStreamStarting : isSendInFlight;

  // Coder workspace state - config is owned by selectedRuntime.coder, this hook manages async data
  const currentRuntime = creationState.selectedRuntime;
  const coderRuntimeHost = currentRuntime.mode === "ssh" ? currentRuntime.host : null;
  const setCreationSelectedRuntime = creationState.setSelectedRuntime;
  // Plain function: React Compiler stabilizes this handler from its primitive host
  // and compiler-stable runtime setter dependencies.
  const handleCoderConfigChange = (config: CoderWorkspaceConfig | null) => {
    if (coderRuntimeHost == null) return;
    // Existing Coder workspaces name the SSH host; new ones derive it later.
    const computedHost = config?.workspaceName ? `${config.workspaceName}.coder` : coderRuntimeHost;
    setCreationSelectedRuntime({
      mode: "ssh",
      host: computedHost,
      coder: config ?? undefined,
    });
  };
  const coderState = useCoderWorkspace({
    coderConfig: currentRuntime.mode === "ssh" ? (currentRuntime.coder ?? null) : null,
    onCoderConfigChange: handleCoderConfigChange,
    coderInfoRefreshPolicy: variant === "creation" ? "mount-and-focus" : "mount-only",
  });

  const creationRuntimeError =
    variant === "creation" && props.kind !== "scratch"
      ? validateCreationRuntime(creationState.selectedRuntime, coderState.presets.length)
      : null;

  const creationRuntimePolicyError =
    variant === "creation" &&
    props.kind !== "scratch" &&
    effectivePolicy?.runtimes != null &&
    !isParsedRuntimeAllowedByPolicy(effectivePolicy, creationState.selectedRuntime)
      ? creationState.selectedRuntime.mode === "ssh" &&
        !creationState.selectedRuntime.coder &&
        runtimePolicy.allowSshHost === false &&
        runtimePolicy.allowSshCoder
        ? "Host SSH runtimes are disabled by policy. Select the Coder runtime instead."
        : "Selected runtime is disabled by policy."
      : null;

  const runtimeFieldError =
    variant === "creation" && hasAttemptedCreateSend ? (creationRuntimeError?.mode ?? null) : null;

  const creationControlsProps =
    variant === "creation" && props.kind !== "scratch"
      ? ({
          branches: creationState.branches,
          branchesLoaded: creationState.branchesLoaded,
          trunkBranch: creationState.trunkBranch,
          onTrunkBranchChange: creationState.setTrunkBranch,
          selectedRuntime: creationState.selectedRuntime,
          coderConfigFallback: creationState.coderConfigFallback,
          sshHostFallback: creationState.sshHostFallback,
          defaultRuntimeMode: creationState.defaultRuntimeMode,
          onSelectedRuntimeChange: creationState.setSelectedRuntime,
          onSetDefaultRuntime: creationState.setDefaultRuntimeChoice,
          disabled: isSendInFlight,
          projectPath: creationParentProjectPath,
          // Surface the actually-targeted project (possibly a sub-project) to
          // the dropdown so the trigger label reflects what the user picked,
          // while runtime/settings scoping stays on the parent above. When
          // creating from the sidebar's "+ New chat" on a sub-project header,
          // the URL/route is the parent project and the sub-project comes via
          // the draft (pendingSubProjectPath / creationSubProjectPath); both
          // routes (deep link to a sub-project, or sidebar "+") collapse here.
          selectedProjectPath: creationSubProjectPath ?? props.projectPath,
          userProjects,
          onSelectedProjectPathChange: beginWorkspaceCreation,
          projectName: props.projectName,
          nameState: creationState.nameState,
          runtimeAvailabilityState: creationState.runtimeAvailabilityState,
          runtimeEnablement: creationRuntimeEnablement,
          allowedRuntimeModes: runtimePolicy.allowedModes,
          allowSshHost: runtimePolicy.allowSshHost,
          allowSshCoder: runtimePolicy.allowSshCoder,
          runtimePolicyError: creationRuntimePolicyError,
          coderInfo: coderState.coderInfo,
          runtimeFieldError,
          // Pass coderProps when CLI is available/outdated, Coder is enabled, or still checking (so "Checking…" UI renders)
          coderProps:
            coderState.coderInfo === null ||
            coderState.enabled ||
            coderState.coderInfo?.state !== "unavailable"
              ? {
                  enabled: coderState.enabled,
                  onEnabledChange: coderState.setEnabled,
                  coderInfo: coderState.coderInfo,
                  coderConfig: coderState.coderConfig,
                  onCoderConfigChange: coderState.setCoderConfig,
                  templates: coderState.templates,
                  templatesError: coderState.templatesError,
                  presets: coderState.presets,
                  presetsError: coderState.presetsError,
                  existingWorkspaces: coderState.existingWorkspaces,
                  workspacesError: coderState.workspacesError,
                  loadingTemplates: coderState.loadingTemplates,
                  loadingPresets: coderState.loadingPresets,
                  loadingWorkspaces: coderState.loadingWorkspaces,
                }
              : undefined,
        } satisfies React.ComponentProps<typeof CreationControls>)
      : null;
  const hasTypedText = input.trim().length > 0;
  const hasImages = attachments.length > 0;
  const hasReviews = reviewData !== undefined;
  // Disable send while Coder presets are loading (user could bypass preset validation)
  const policyBlocksCreateSend = variant === "creation" && creationRuntimePolicyError != null;
  const coderPresetsLoading =
    coderState.enabled && !coderState.coderConfig?.existingWorkspace && coderState.loadingPresets;
  const isProcessingAttachments = processingAttachmentCount > 0;
  const canSend =
    (hasTypedText || hasImages || hasReviews) &&
    !disabled &&
    !sendInFlightBlocksInput &&
    !isProcessingAttachments &&
    !coderPresetsLoading &&
    !policyBlocksCreateSend;
  const runningGoalActive =
    variant === "workspace" && isGoalRunning(workspaceGoal?.status ?? "paused");

  // Send defaults to tool-end on click; advanced dispatch modes remain available via
  // right-click and touch long-press whenever there's a sendable workspace draft.
  const canChooseDispatchMode = variant === "workspace" && canSend;
  const sendModeMenu = useContextMenuPosition({
    longPress: true,
    canOpen: () => canChooseDispatchMode,
  });
  const {
    isOpen: isSendModeMenuOpen,
    onContextMenu: openSendModeMenuFromContext,
    touchHandlers: sendModeMenuTouchHandlers,
    suppressClickIfLongPress: suppressSendClickIfLongPress,
    close: closeSendModeMenu,
  } = sendModeMenu;

  useEffect(() => {
    if (canChooseDispatchMode) {
      return;
    }

    closeSendModeMenu();
  }, [canChooseDispatchMode, closeSendModeMenu]);

  useEffect(() => {
    if (!isSendModeMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (sendModeMenuContainerRef.current?.contains(event.target as Node)) {
        return;
      }
      closeSendModeMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      // Mark Escape as handled so global interrupt listeners do not cancel the stream
      // when users are only dismissing this inline send-mode menu.
      event.preventDefault();
      event.stopPropagation();
      closeSendModeMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeSendModeMenu, isSendModeMenuOpen]);

  // User request: this sync effect runs on mount and when defaults/config change.
  // Only treat *real* agent changes as explicit (origin "agent"); everything else is "sync".
  const prevCreationAgentIdRef = useRef<string | null>(null);
  const prevCreationScopeIdRef = useRef<string | null>(null);
  // Creation variant: keep the project-scoped model/thinking in sync with global agent defaults
  // so switching agents uses the configured defaults (and respects "inherit" semantics).
  useEffect(() => {
    if (variant !== "creation") {
      // Reset tracking on variant transitions so creation entry never counts as an explicit switch.
      prevCreationAgentIdRef.current = null;
      prevCreationScopeIdRef.current = null;
      return;
    }

    const scopeId = getProjectScopeId(creationParentProjectPath);
    const modelKey = getModelKey(scopeId);
    const thinkingKey = getThinkingLevelKey(scopeId);

    const fallbackModel = defaultModel;

    const normalizedAgentId = normalizeAgentId(agentId, "exec");

    const isExplicitAgentSwitch =
      prevCreationAgentIdRef.current !== null &&
      prevCreationScopeIdRef.current === scopeId &&
      prevCreationAgentIdRef.current !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevCreationAgentIdRef.current = normalizedAgentId;
    prevCreationScopeIdRef.current = scopeId;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    // Configured defaults (direct or base-chain, field-wise) must reach the
    // first turn of a new workspace too, not just post-creation agent syncs:
    // a custom agent inheriting model/thinking/pro from its base would
    // otherwise send the first prompt with the ambient model and Pro gated off
    // until WorkspaceModeAISync corrects the workspace.
    const reasoningKey = getReasoningModeKey(scopeId);
    const existingReasoning = readPersistedState<OpenAIReasoningMode>(reasoningKey, "standard");
    const {
      resolvedModel,
      resolvedThinking,
      resolvedReasoningMode: resolvedReasoning,
    } = resolveWorkspaceAiSettingsForAgent({
      agentId: normalizedAgentId,
      agentAiDefaults,
      fallbackModel,
      existingModel,
      existingThinking,
      existingReasoningMode: existingReasoning,
      agentBaseById: new Map(agents.map((agent) => [agent.id, agent.base])),
    });

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(scopeId, resolvedModel, isExplicitAgentSwitch ? "agent" : "sync");
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }

    if (existingReasoning !== resolvedReasoning) {
      updatePersistedState(reasoningKey, resolvedReasoning);
    }
  }, [agentAiDefaults, agentId, agents, creationParentProjectPath, defaultModel, variant]);

  const chatDockColumnWidthClass = useChatDockColumnWidthClass();

  // Expose ChatInput auto-focus completion for Storybook/tests.
  const chatInputSectionRef = useRef<HTMLDivElement | null>(null);
  const setChatInputAutoFocusState = useCallback((state: "pending" | "done") => {
    chatInputSectionRef.current?.setAttribute("data-autofocus-state", state);
  }, []);

  const focusMessageInput = useCallback(() => {
    const element = inputRef.current;
    if (!element || element.disabled) {
      return;
    }

    element.focus();

    requestAnimationFrame(() => {
      const cursor = element.value.length;
      element.selectionStart = cursor;
      element.selectionEnd = cursor;
      // Skip the resize dance when empty: reading scrollHeight after a height write
      // forces a synchronous reflow, and this rAF fires right after a workspace
      // switch while the freshly mounted transcript is still dirty — laying out the
      // whole document before first paint. Empty composers are sized by CSS alone
      // (rows=1 + min-height; see useAutoResizeTextarea).
      if (element.value !== "") {
        element.style.height = "auto";
        element.style.height = Math.min(element.scrollHeight, window.innerHeight * 0.5) + "px";
      }
    });
  }, []);

  const applyDraftFromPending = useCallback(
    (pending: PendingUserMessage, attachmentKeyPrefix: string) => {
      const providerAttachments = filePartsToChatAttachments(
        pending.fileParts,
        attachmentKeyPrefix
      );
      const stagedAttachments = pending.stagedAttachments.map((attachment, index) => ({
        ...attachment,
        id: `${attachmentKeyPrefix}-staged-${index}`,
      }));
      setDraft({
        text: pending.content,
        attachments: [...providerAttachments, ...stagedAttachments],
      });
    },
    [setDraft]
  );

  // Restore a full pending draft (text + attachments + reviews), e.g. queued message edits.
  const restoreDraft = useCallback(
    (pending: PendingUserMessage) => {
      applyDraftFromPending(pending, `restored-${Date.now()}`);
      setDraftReviews(pending.reviews);
      focusMessageInput();
    },
    [applyDraftFromPending, focusMessageInput, setDraftReviews]
  );

  const restorePreEditDraft = useCallback(() => {
    setDraft(preEditDraftRef.current);
    setDraftReviews(preEditReviewsRef.current);
  }, [preEditDraftRef, preEditReviewsRef, setDraft, setDraftReviews]);

  // Method to restore text to input (used by compaction cancel)
  const restoreText = useCallback(
    (text: string) => {
      setInput(() => text);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  // Method to append text to input (used by Code Review notes)
  const appendText = useCallback(
    (text: string) => {
      setInput((prev) => {
        // Add blank line before if there's existing content
        const separator = prev.trim() ? "\n\n" : "";
        return prev + separator + text;
      });
      // Don't focus - user wants to keep reviewing
    },
    [setInput]
  );

  // Method to prepend text to input (used by manual compact trigger)
  const prependText = useCallback(
    (text: string) => {
      setInput((prev) => text + prev);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  const handleSendRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const send = useCallback(() => {
    return handleSendRef.current();
  }, []);

  const onReady = props.onReady;

  // Provide API to parent via callback. Latest-ref wrappers (see handleSendRef)
  // keep the handed-out object stable even though the draft helpers are not
  // identity-stable without manual memoization; re-invoking onReady per render
  // would churn parent state.
  const composerApiRef = useRef({ restoreText, restoreDraft, appendText, prependText });
  useEffect(() => {
    composerApiRef.current = { restoreText, restoreDraft, appendText, prependText };
  });
  useEffect(() => {
    if (onReady) {
      onReady({
        focus: focusMessageInput,
        send,
        restoreText: (text) => composerApiRef.current.restoreText(text),
        restoreDraft: (pending) => composerApiRef.current.restoreDraft(pending),
        appendText: (text) => composerApiRef.current.appendText(text),
        prependText: (text) => composerApiRef.current.prependText(text),
      });
    }
  }, [onReady, focusMessageInput, send]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_I)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_A)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.CYCLE_MODEL)) {
        event.preventDefault();
        focusMessageInput();
        cycleToNextModel();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [cycleToNextModel, focusMessageInput, openModelSelector]);

  // When entering editing mode, save current draft and populate with message content
  useEffect(() => {
    if (editingMessage) {
      preEditDraftRef.current = getDraft();
      preEditReviewsRef.current = draftReviews;
      applyDraftFromPending(editingMessage.pending, `edit-${editingMessage.id}`);
      setDraftReviews(editingMessage.pending.reviews);
      // Auto-resize textarea and focus
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
          inputRef.current.style.height =
            Math.min(inputRef.current.scrollHeight, window.innerHeight * 0.5) + "px";
          inputRef.current.focus();
        }
      }, 0);
    }
    // Key on the edit target only: function deps (applyDraftFromPending via the
    // draft hook) are not identity-stable without manual memoization, and
    // re-running would clobber the user's in-progress edit text every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingMessage?.id]);

  // Project live workflow run cards for foreground slash invocations after reloads.
  useEffect(() => {
    let isMounted = true;
    const requestId = ++workflowsRequestIdRef.current;

    const loadWorkflows = async () => {
      if (!api || !dynamicWorkflowsExperimentEnabled) {
        return;
      }

      try {
        const discoveryWorkspaceId = variant === "workspace" && workspaceId ? workspaceId : null;
        const runs =
          discoveryWorkspaceId != null && isTranscriptCaughtUp
            ? await api.workflows.listRuns({ workspaceId: discoveryWorkspaceId })
            : [];
        if (!isMounted || workflowsRequestIdRef.current !== requestId) {
          return;
        }
        if (discoveryWorkspaceId == null) {
          return;
        }
        const muxMessages = store.getWorkspaceState(discoveryWorkspaceId).muxMessages;
        for (const run of runs) {
          const projection = getWorkflowRunCardProjection(muxMessages, run);
          if (!projection.shouldProject) {
            continue;
          }
          const cardKey = `${discoveryWorkspaceId}:${run.id}:${run.updatedAt}:${run.status}`;
          if (projectedWorkflowRunCardKeysRef.current.has(cardKey)) {
            continue;
          }
          projectedWorkflowRunCardKeysRef.current.add(cardKey);
          addWorkflowRunCardMessageForRun(discoveryWorkspaceId, run, {
            existingMessage: projection.existingMessage,
          });
        }
      } catch (error) {
        console.error("Failed to project workflow run cards:", error);
      }
    };

    void loadWorkflows();

    return () => {
      isMounted = false;
    };
  }, [
    api,
    variant,
    workspaceId,
    atMentionProjectPath,
    dynamicWorkflowsExperimentEnabled,
    isTranscriptCaughtUp,
    store,
  ]);

  // Voice input: track transcription provider availability (subscribe to provider config changes)
  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Some oRPC iterators don't eagerly close on abort alone.
    // Ensure we `return()` them so backend subscriptions clean up EventEmitter listeners.
    let iterator: AsyncIterator<unknown> | null = null;

    const checkTranscriptionConfig = async () => {
      try {
        const config = await api.providers.getConfig();
        if (!signal.aborted) {
          setOpenAIKeySet(config?.openai?.apiKeySet ?? false);
          setOpenAIProviderEnabled(config?.openai?.isEnabled ?? true);
          setMuxGatewayCouponSet(config?.["mux-gateway"]?.couponCodeSet ?? false);
          setMuxGatewayEnabled(config?.["mux-gateway"]?.isEnabled ?? true);
        }
      } catch {
        // Ignore errors fetching config
      }
    };

    // Initial fetch
    void checkTranscriptionConfig();

    // Subscribe to provider config changes via oRPC
    (async () => {
      try {
        const subscribedIterator = await api.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void checkTranscriptionConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  // Allow external components (e.g., CommandPalette, Queued message edits) to insert text
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{
        text: string;
        mode?: "append" | "replace";
        fileParts?: FilePart[];
        reviews?: ReviewNoteDataForDisplay[];
        workspaceId?: string;
      }>;

      if (
        customEvent.detail.workspaceId != null &&
        workspaceIdForComposerClear !== customEvent.detail.workspaceId
      ) {
        return;
      }

      const { text, mode = "append", fileParts, reviews } = customEvent.detail;
      const restoredIdPrefix = `restored-${Date.now()}`;
      const restoredPending = buildPendingFromRestoredInput({
        content: text,
        fileParts: fileParts ?? [],
        reviews: reviews ?? [],
        idPrefix: restoredIdPrefix,
      });
      const hasFileParts = restoredPending.fileParts.length > 0;
      const hasStagedAttachments = restoredPending.stagedAttachments.length > 0;
      const hasReviews = restoredPending.reviews.length > 0;

      if (mode === "replace") {
        if (editingMessageForUi) {
          return;
        }
        if (hasFileParts || hasStagedAttachments || hasReviews) {
          restoreDraft(restoredPending);
        } else {
          restoreText(restoredPending.content);
        }
      } else if (hasFileParts || hasStagedAttachments || hasReviews) {
        const currentText = getDraft().text;
        const separator = currentText.trim() ? "\n\n" : "";
        applyDraftFromPending(
          {
            ...restoredPending,
            content: currentText + separator + restoredPending.content,
          },
          restoredIdPrefix
        );
      } else {
        appendText(restoredPending.content);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
  }, [
    appendText,
    restoreText,
    restoreDraft,
    applyDraftFromPending,
    getDraft,
    editingMessageForUi,
    workspaceIdForComposerClear,
  ]);

  useEffect(() => {
    const handler = (event: CustomEvent<{ workspaceId: string }>) => {
      if (workspaceIdForComposerClear !== event.detail.workspaceId) {
        return;
      }

      setInput("");
      setAttachments([]);
      setDraftReviews(null);
      onDetachAllReviewsForComposerClear?.();
      if (inputRef.current) {
        inputRef.current.style.height = "";
      }
    };

    window.addEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handler as EventListener);
  }, [
    onDetachAllReviewsForComposerClear,
    setAttachments,
    setDraftReviews,
    setInput,
    workspaceIdForComposerClear,
  ]);

  // Allow external components to open the Model Selector
  useEffect(() => {
    const handler = () => {
      // Open the inline ModelSelector and let it take focus itself
      modelSelectorRef.current?.open();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
  }, []);

  // Show toast when thinking level is changed via command palette (workspace only)
  useEffect(() => {
    if (variant !== "workspace") return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; level: ThinkingLevel }>).detail;
      if (detail?.workspaceId !== props.workspaceId || !detail.level) {
        return;
      }

      const level = detail.level;
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "Off — fastest responses",
        low: "Low — adds light reasoning",
        medium: "Medium — balanced reasoning",
        high: "High — maximum reasoning depth",
        xhigh: "Max — deepest possible reasoning",
        max: "Max — deepest possible reasoning",
      };

      pushToast({
        type: "success",
        message: `Thinking effort set to ${levelDescriptions[level]}`,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
  }, [variant, props, pushToast]);

  // Show the backend's one-shot child-budget warning on the matching parent workspace.
  useEffect(() => {
    if (variant !== "workspace") return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; message: string }>).detail;
      if (detail?.workspaceId !== workspaceId || !detail.message) {
        return;
      }

      pushToast({ type: "error", message: detail.message });
    };

    window.addEventListener(CUSTOM_EVENTS.GOAL_CHILD_BUDGET_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.GOAL_CHILD_BUDGET_TOAST, handler as EventListener);
  }, [variant, workspaceId, pushToast]);

  // Show toast feedback for analytics rebuild command palette action.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ type: "success" | "error"; message: string; title?: string }>
      ).detail;

      if (!detail || (detail.type !== "success" && detail.type !== "error")) {
        return;
      }

      pushToast({
        type: detail.type,
        title: detail.title,
        message: detail.message,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handler as EventListener);
  }, [pushToast]);

  // Voice input: command palette toggle + global recording keybinds
  useEffect(() => {
    if (!voiceInput.shouldShowUI) return;

    const handleToggle = () => {
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
    };

    window.addEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    };
  }, [voiceInput, pushToast, voiceInputUnavailableMessage]);

  // Auto-focus chat input when workspace changes (workspace only).
  const workspaceIdForFocus = variant === "workspace" ? props.workspaceId : null;
  useEffect(() => {
    if (variant !== "workspace") return;

    const maxFrames = 10;
    setChatInputAutoFocusState("pending");

    let cancelled = false;
    let rafId: number | null = null;
    let attempts = 0;

    const step = () => {
      if (cancelled) return;

      attempts += 1;

      const input = inputRef.current;
      const active = document.activeElement;

      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        const isWithinChatInput = !!chatInputSectionRef.current?.contains(active);
        const isInput = !!input && active === input;
        if (!isWithinChatInput && !isInput) {
          setChatInputAutoFocusState("done");
          return;
        }
      }

      focusMessageInput();

      const isFocused = !!input && document.activeElement === input;
      const isDone = isFocused || attempts >= maxFrames;

      if (isDone) {
        setChatInputAutoFocusState("done");
        return;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      setChatInputAutoFocusState("done");
    };
  }, [variant, workspaceIdForFocus, focusMessageInput, setChatInputAutoFocusState]);

  // Shared slash command execution for creation + workspace inputs.
  const commandWorkspaceId = variant === "workspace" ? props.workspaceId : undefined;
  const commandProjectPath =
    variant === "creation" ? props.projectPath : (selectedWorkspace?.projectPath ?? null);
  const commandOnCancelEdit = variant === "workspace" ? props.onCancelEdit : undefined;

  // Keep this helper as a plain function so command wiring stays readable without a giant
  // dependency list; the React Compiler already handles memoization.
  const executeParsedCommand = async (
    parsed: ParsedCommand | null,
    restoreInput: string,
    options?: {
      skipConfirmation?: boolean;
      queueDispatchMode?: QueueDispatchMode;
      goalInterventionPolicy?: GoalInterventionPolicy;
    }
  ): Promise<boolean> => {
    if (!parsed) {
      return false;
    }

    // /<model-alias> ... is a *send modifier* (one-shot model override), not a command with its own
    // side effects. Let the normal send flow handle it so post-send behavior can't drift.
    if (parsed.type === "model-oneshot") {
      if (variant !== "workspace") {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: "Model one-shot is only available in workspace view",
        });
        return true;
      }
      return false;
    }

    const isDestructive = parsed.type === "clear" && parsed.mode === "hard";
    if (isDestructive && variant === "workspace" && !options?.skipConfirmation) {
      setPendingDestructiveCommand(true);
      return true;
    }

    // Pending files block every command (even /compact) because command sends
    // never stage them, so they'd be silently dropped.
    if (
      getPendingFileAttachments(attachments).length > 0 ||
      (getStagedAttachments(attachments).length > 0 && parsed.type !== "compact")
    ) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "This command cannot include staged files. Remove them or send a normal message.",
      });
      return true;
    }

    const reviewsData = reviewData;
    const dispatchMode = options?.queueDispatchMode ?? "tool-end";
    // Thread dispatch mode into send options so queued command sends stay in sync with normal sends.
    const commandSendMessageOptions: SendMessageOptions = {
      ...sendMessageOptions,
      ...(options?.goalInterventionPolicy
        ? { goalInterventionPolicy: options.goalInterventionPolicy }
        : {}),
      ...(dispatchMode === "tool-end" ? {} : { queueDispatchMode: dispatchMode }),
    };
    // Prepare file parts for commands that need to send messages with attachments
    const commandFileParts = chatAttachmentsToFileParts(attachments, { validate: true });
    const asyncCommandToken = ++asyncCommandTokenRef.current;
    const commandEnv: SlashCommandEnv = {
      api,
      variant,
      workspaceId: commandWorkspaceId,
      projectPath: commandProjectPath,
      rawInput: restoreInput,
      dynamicWorkflowsEnabled: dynamicWorkflowsExperimentEnabled,
      currentModel: workspaceSidebarState?.currentModel ?? null,
      sendMessageOptions: commandSendMessageOptions,
      resetContext: variant === "workspace" ? props.onResetContext : undefined,
      truncateHistory: variant === "workspace" ? props.onTruncateHistory : undefined,
      editMessageId: editingMessageForUi?.id,
      reviews: reviewsData,
      attachments,
      fileParts: commandFileParts.length > 0 ? commandFileParts : undefined,
      attachedReviewIds: reviewIdsForCheck,
      isCurrent: () => {
        const scope = asyncCommandScopeRef.current;
        return (
          asyncCommandToken === asyncCommandTokenRef.current &&
          scope.variant === "workspace" &&
          scope.workspaceId === commandWorkspaceId
        );
      },
    };

    // Command actions stop at the caller's UI boundary; creation mode intentionally has its own applier.
    const applyCommandActions = (actions: CommandAction[]) => {
      for (const action of actions) {
        switch (action.type) {
          case "clear-input":
            setInput("");
            break;
          case "reset-input-height":
            if (inputRef.current) inputRef.current.style.height = "";
            break;
          case "show-toast":
            setToast(action.toast);
            break;
          case "set-preferred-model":
            setPreferredModel(action.model);
            break;
          case "toggle-vim":
            setVimEnabled((enabled) => !enabled);
            break;
          case "set-sending":
            setSendingCount((count) => count + (action.sending ? 1 : -1));
            break;
          case "clear-attachments":
            setAttachments([]);
            break;
          case "detach-reviews":
            if (variant === "workspace") props.onDetachAllReviews?.();
            break;
          case "check-reviews":
            if (variant === "workspace" && action.reviewIds.length > 0) {
              props.onCheckReviews?.(action.reviewIds);
            }
            break;
          case "message-sent":
            if (variant === "workspace") props.onMessageSent?.(action.dispatchMode);
            break;
          case "cancel-edit":
            commandOnCancelEdit?.();
            break;
        }
      }
    };

    let result = await processSlashCommand(parsed, commandEnv);
    while (result.kind === "phase") {
      applyCommandActions(result.actions);
      result = await result.continue();
    }
    applyCommandActions(result.actions);
    if (result.backgroundTask) {
      void result.backgroundTask().then(applyCommandActions);
    }

    switch (result.inputDisposition) {
      case "consume":
        // Commands clear the composer through their own clear-input actions;
        // clearing again here would wipe a draft typed while phases ran.
        setDraftReviews(null);
        break;
      case "restore":
        setInput(restoreInput);
        break;
      case "restore-if-empty":
        // Async phases can outlive the invoking render, so check the live
        // persisted draft: the getDraft closure captured here still reports
        // this render's input and would refuse to restore over a newer draft.
        if (readPersistedState(storageKeys.inputKey, "").trim().length === 0) {
          setInput(restoreInput);
        } else {
          setDraftReviews(null);
        }
        break;
    }

    return true;
  };

  // Handle destructive command confirmation (currently only /clear).
  const handleDestructiveCommandConfirm = async () => {
    if (!pendingDestructiveCommand || variant !== "workspace") return;

    const parsedCommand: ParsedCommand = { type: "clear", mode: "hard" };

    setPendingDestructiveCommand(false);
    await executeParsedCommand(parsedCommand, input, { skipConfirmation: true });
  };

  const handleDestructiveCommandCancel = useCallback(() => {
    setPendingDestructiveCommand(false);
  }, []);

  const handleSend = async (overrides?: InternalSendOverrides) => {
    if (!canSend) {
      return;
    }

    closeSendModeMenu();

    const messageText = input.trim();
    const skillDiscovery: SkillResolutionTarget | null =
      variant === "creation"
        ? atMentionProjectPath
          ? { kind: "project", projectPath: atMentionProjectPath }
          : null
        : variant === "workspace" && workspaceId
          ? {
              kind: "workspace",
              workspaceId,
              disableWorkspaceAgents:
                sendMessageOptions.disableWorkspaceAgents === true ||
                transferredDraftProjectDiscovery,
            }
          : null;
    // Resolving commands/references can include cold MCP server startup and
    // prompt discovery; mark the send in flight so a second Enter cannot start
    // a duplicate send against the same captured draft.
    setSendingCount((c) => c + 1);
    sendResolutionAbortRef.current ??= new AbortController();
    const resolutionSignal = sendResolutionAbortRef.current.signal;
    const isSendScopeCurrent = () =>
      !resolutionSignal.aborted &&
      asyncCommandScopeRef.current.variant === variant &&
      asyncCommandScopeRef.current.workspaceId === workspaceId;
    let parsed: ParsedCommand;
    let skillInvocation: SkillInvocation | null;
    let mcpPromptInvocation: MCPPromptInvocation | null;
    let combinedSkillRefs: AgentSkillReference[];
    let mcpPromptRefsResult: Awaited<ReturnType<typeof resolveMcpPromptRefsForSend>>;
    try {
      const resolution = await parseCommandWithSkillInvocation({
        messageText,
        agentSkillDescriptors,
        mcpPromptDescriptors,
        api,
        discovery: skillDiscovery,
        signal: resolutionSignal,
      });
      if (!isSendScopeCurrent()) return;
      parsed = resolution.parsed;
      skillInvocation = resolution.skillInvocation;
      mcpPromptInvocation = resolution.mcpPromptInvocation;
      if (resolution.error) {
        pushToast({ type: "error", message: resolution.error });
        return;
      }
      const inlineReferenceCandidates = extractInlineSkillReferenceCandidates(messageText);
      [combinedSkillRefs, mcpPromptRefsResult] = await Promise.all([
        resolveInlineSkillRefsForSend({
          messageText,
          slashInvocation: skillInvocation,
          agentSkillDescriptors,
          api,
          discovery: skillDiscovery,
          candidates: inlineReferenceCandidates,
        }),
        resolveMcpPromptRefsForSend({
          messageText,
          slashInvocation: mcpPromptInvocation,
          descriptors: mcpPromptDescriptors,
          api,
          discovery: skillDiscovery,
          candidates: inlineReferenceCandidates,
          signal: resolutionSignal,
        }),
      ]);
      if (!isSendScopeCurrent()) return;
      if (mcpPromptRefsResult.error) {
        pushToast({ type: "error", message: mcpPromptRefsResult.error });
        return;
      }
    } finally {
      setSendingCount((c) => c - 1);
    }
    const combinedMcpPromptRefs = mcpPromptRefsResult.refs;

    // Route to creation handler for creation variant
    if (variant === "creation") {
      // The initial /goal path sets a goal without sending a user message, so
      // attachments would be silently dropped. With attachments present, skip
      // command processing and send the raw text as a normal message instead.
      const goalCommandBypassedForAttachments =
        parsed?.type === "goal-set" && attachments.length > 0;
      const initialSlashCommand =
        parsed?.type === "goal-set" && !goalCommandBypassedForAttachments ? parsed : undefined;
      if (
        !initialSlashCommand &&
        !goalCommandBypassedForAttachments &&
        parsed?.type !== "workflow-run"
      ) {
        const commandHandled = await executeParsedCommand(parsed, input);
        if (commandHandled) {
          return;
        }
      }

      let creationMessageTextForSend =
        initialSlashCommand?.type === "goal-set" ? initialSlashCommand.objective : messageText;
      let creationOptionsOverride: Partial<SendMessageOptions> | undefined;

      if (skillInvocation) {
        if (!api) {
          pushToast({ type: "error", message: "Not connected to server" });
          return;
        }

        creationMessageTextForSend = skillInvocation.userText;
      }

      if (combinedSkillRefs.length > 0) {
        const baseMetadata = skillInvocation
          ? buildSkillInvocationMetadata(
              messageText,
              skillInvocation.descriptor,
              skillInvocation.argumentText
            )
          : undefined;
        const muxMetadata = withAgentSkillRefs(baseMetadata, combinedSkillRefs);
        if (!muxMetadata) {
          throw new Error("Expected skill metadata when skill refs are present");
        }

        creationOptionsOverride = {
          muxMetadata,
          // In the creation flow, project-scoped skills may not exist in the new worktree.
          // Force project-path discovery for this send so resolution matches suggestions.
          ...(hasProjectScopedSkillRef(combinedSkillRefs) ? { disableWorkspaceAgents: true } : {}),
        };
      }

      setHasAttemptedCreateSend(true);

      if (props.kind !== "scratch") {
        const runtimeError = validateCreationRuntime(
          creationState.selectedRuntime,
          coderState.presets.length
        );
        if (runtimeError) {
          return;
        }
      }

      // Creation variant: simple message send + workspace creation
      const creationFileParts = chatAttachmentsToFileParts(attachments);
      const creationPendingFiles = getPendingFileAttachments(attachments);
      const creationResult = await creationState.handleSend(
        creationMessageTextForSend,
        creationFileParts.length > 0 ? creationFileParts : undefined,
        creationOptionsOverride,
        initialSlashCommand,
        creationPendingFiles.length > 0 ? creationPendingFiles : undefined
      );

      if (creationResult.success) {
        if (isMountedRef.current) {
          setInput("");
          setAttachments([]);
          // Height is managed by VimTextArea's useLayoutEffect - clear inline style
          // to let CSS min-height take over
          if (inputRef.current) {
            inputRef.current.style.height = "";
          }
        }
      }
      return;
    }

    // Workspace variant: full command handling + message send
    if (variant !== "workspace") return; // Type guard

    if (
      editingMessageForUi?.isBeforeLatestContextBoundary === true &&
      overrides?.skipBoundaryEditConfirmation !== true
    ) {
      // Re-enable the old pre-compaction edit flow, but confirm at send time because
      // the backend truncates through the context boundary and discards its summary.
      setPendingBoundaryEditConfirmation({
        ...(overrides?.queueDispatchMode ? { queueDispatchMode: overrides.queueDispatchMode } : {}),
        ...(overrides?.goalInterventionPolicy
          ? { goalInterventionPolicy: overrides.goalInterventionPolicy }
          : {}),
      });
      return;
    }

    try {
      const modelOneShot = parsed?.type === "model-oneshot" ? parsed : null;
      // Mirror the creation-composer /goal bypass: with attachments present,
      // send the raw text as a normal message instead of processing the
      // command, which would drop the files. Transferred staging-failure
      // drafts (raw /goal text + staged/pending chips) retry through here.
      const goalCommandBypassedForAttachments =
        parsed?.type === "goal-set" && attachments.length > 0;
      const commandHandled =
        modelOneShot || goalCommandBypassedForAttachments
          ? false
          : await executeParsedCommand(parsed, input, {
              goalInterventionPolicy: overrides?.goalInterventionPolicy,
              queueDispatchMode: overrides?.queueDispatchMode,
            });
      if (commandHandled) {
        return;
      }

      // A normal workspace send supersedes any pending asynchronous slash
      // command completion. If that older command fails after this send clears
      // the composer, it must not restore stale command text over the newer turn.
      asyncCommandTokenRef.current++;

      const modelOverride = modelOneShot?.modelString;

      // Regular message (or /<model-alias> one-shot override) - send directly via API
      const messageTextForSend =
        modelOneShot?.message ??
        skillInvocation?.userText ??
        mcpPromptInvocation?.userText ??
        messageText;

      if (!api) {
        pushToast({ type: "error", message: "Not connected to server" });
        return;
      }
      setSendingCount((c) => c + 1);

      // Pending files only reach workspace composers via transferred creation
      // drafts; stage them before the notice is built.
      let sendAttachments = attachments;
      const pendingFilesForSend = getPendingFileAttachments(attachments);
      if (pendingFilesForSend.length > 0) {
        const stagingOutcome = await stagePendingFiles(api, props.workspaceId, pendingFilesForSend);
        if (stagingOutcome.staged.length > 0) {
          sendAttachments = replacePendingFilesWithStaged(attachments, stagingOutcome.staged);
          // Swap staged chips into the composer so a later failure or retry
          // can't re-stage duplicate copies.
          setAttachments(sendAttachments);
        }
        if (stagingOutcome.failures.length > 0) {
          setToast(
            createErrorToast({
              type: "unknown",
              raw: formatPendingFileStagingError(stagingOutcome.failures),
            })
          );
          setSendingCount((c) => c - 1);
          return;
        }
      }

      const skillMuxMetadata = skillInvocation
        ? buildSkillInvocationMetadata(
            appendStagedAttachmentNotice(messageText, sendAttachments),
            skillInvocation.descriptor,
            skillInvocation.argumentText
          )
        : undefined;
      const promptMuxMetadata: MuxMessageMetadata | undefined = mcpPromptInvocation
        ? {
            type: "normal",
            // Include the staged-attachment notice so edit restoration and
            // compact-and-retry (which prefer rawCommand) keep the attached files.
            rawCommand: appendStagedAttachmentNotice(messageText, sendAttachments),
            commandPrefix: `/${mcpPromptInvocation.descriptor.commandKey}`,
          }
        : undefined;

      const policyModel = modelOverride ?? baseModel;

      // Preflight: if the message includes PDFs, ensure the selected model can accept them.
      const pdfAttachments = attachments.filter(isPdfAttachment);
      if (pdfAttachments.length > 0) {
        const caps = getModelCapabilitiesResolved(policyModel, providersConfig);
        if (caps && !caps.supportsPdfInput) {
          const pdfCapableKnownModels = Object.values(KNOWN_MODELS)
            .map((m) => m.id)
            .filter((model) => getModelCapabilities(model)?.supportsPdfInput);
          const pdfCapableExamples = pdfCapableKnownModels.slice(0, 3);
          const examplesSuffix =
            pdfCapableKnownModels.length > pdfCapableExamples.length ? ", and others." : ".";

          pushToast({
            type: "error",
            title: "PDF not supported",
            message:
              `Model ${policyModel} does not support PDF input.` +
              (pdfCapableExamples.length > 0
                ? ` Try e.g.: ${pdfCapableExamples.join(", ")}${examplesSuffix}`
                : " Choose a model with PDF support."),
          });
          setSendingCount((c) => c - 1);
          return;
        }

        if (caps?.maxPdfSizeMb !== undefined) {
          const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
          for (const attachment of pdfAttachments) {
            const bytes = estimateBase64DataUrlBytes(attachment.url);
            if (bytes !== null && bytes > maxBytes) {
              const actualMb = (bytes / (1024 * 1024)).toFixed(1);
              pushToast({
                type: "error",
                title: "PDF too large",
                message: `${attachment.filename ?? "PDF"} is ${actualMb}MB, but ${policyModel} allows up to ${caps.maxPdfSizeMb}MB per PDF.`,
              });
              setSendingCount((c) => c - 1);
              return;
            }
          }
        }
      }
      // Save current draft state for restoration on error
      const preSendDraft = { ...getDraft(), attachments: sendAttachments };
      const preSendReviews = draftReviews;
      const editMessageForSend = editingMessageForUi;

      try {
        // Prepare file parts if any
        const fileParts = chatAttachmentsToFileParts(sendAttachments, { validate: true });
        const sendFileParts = editMessageForSend
          ? fileParts
          : fileParts.length > 0
            ? fileParts
            : undefined;

        // Prepare reviews data (used for both compaction continueMessage and normal send)
        const reviewsData = reviewData;

        // When editing a /compact command, regenerate the actual summarization request
        let actualMessageText = messageTextForSend;
        let muxMetadata: MuxMessageMetadata | undefined = skillMuxMetadata ?? promptMuxMetadata;
        let compactionOptions: Partial<SendMessageOptions> = {};

        let appendStagedNoticeToUserMessage = true;
        if (editMessageForSend && actualMessageText.startsWith("/")) {
          const parsed = parseCommand(messageText);
          if (parsed?.type === "compact") {
            // Inline refs ride the follow-up message so their snapshots
            // materialize after compaction, not on the summarization turn.
            const followUpMuxMetadata = withMcpPromptRefs(
              withAgentSkillRefs(undefined, combinedSkillRefs),
              combinedMcpPromptRefs
            );
            const {
              messageText: regeneratedText,
              metadata,
              sendOptions,
            } = prepareCompactionMessage({
              api,
              workspaceId: props.workspaceId,
              maxOutputTokens: parsed.maxOutputTokens,
              // Include current attachments + reviews in followUpContent so they're queued
              // after compaction completes, not just attached to the compaction request.
              followUpContent:
                parsed.continueMessage ||
                sendFileParts?.length ||
                reviewsData?.length ||
                getStagedAttachments(sendAttachments).length ||
                followUpMuxMetadata
                  ? {
                      text: appendStagedAttachmentNotice(
                        parsed.continueMessage ?? "",
                        sendAttachments
                      ),
                      fileParts: sendFileParts,
                      reviews: reviewsData,
                      ...(followUpMuxMetadata ? { muxMetadata: followUpMuxMetadata } : {}),
                    }
                  : undefined,
              model: parsed.model,
              sendMessageOptions,
            });
            appendStagedNoticeToUserMessage = false;
            actualMessageText = regeneratedText;
            muxMetadata = metadata;
            compactionOptions = sendOptions;
          }
        }

        const preparedMessage = prepareMessagePayload({
          messageText,
          messageTextForSend,
          attachments: sendAttachments,
          fileParts,
          reviews: reviewsData,
          reviewIds: reviewIdsForCheck,
          editMessageId: editMessageForSend?.id,
          baseMetadata: muxMetadata,
          agentSkillRefs: combinedSkillRefs,
          mcpPromptRefs: combinedMcpPromptRefs,
          sendMessageOptions,
          compactionOptions,
          compactionMessageText: actualMessageText,
          appendStagedNotice: appendStagedNoticeToUserMessage,
          modelOneShot,
          policyModel,
          transferredDraftProjectDiscovery,
          additionalSystemContextHydrated,
          additionalSystemContext,
          goalInterventionPolicy: overrides?.goalInterventionPolicy,
          queueDispatchMode: overrides?.queueDispatchMode,
        });
        const finalMessageText = preparedMessage.message;
        const sendOptions = preparedMessage.options;
        const effectiveModel = preparedMessage.effectiveModel;
        const sentReviewIds = preparedMessage.sentReviewIds;

        if (editMessageForSend) {
          setOptimisticallyDismissedEditId(editMessageForSend.id);
        }

        // Clear input, images, and hide reviews immediately for responsive UI
        // Text/images are restored if send fails; reviews remain "attached" in state
        // so they'll reappear naturally on failure (we only call onCheckReviews on success)
        setInput("");
        setDraftReviews(null);
        setAttachments([]);
        setHideReviewsDuringSend(true);
        // Clear inline height style - VimTextArea's useLayoutEffect will handle sizing
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }

        props.onMessageSendStarted?.(overrides?.queueDispatchMode ?? "tool-end");

        const result = await api.workspace.sendMessage({
          workspaceId: props.workspaceId,
          message: finalMessageText,
          options: sendOptions,
        });

        if (!result.success) {
          // Log error for debugging
          console.error("Failed to send message:", result.error);
          // Show error using enhanced toast
          setToast(createErrorToast(result.error));
          // Restore draft on error so user can try again
          setOptimisticallyDismissedEditId(null);
          setDraft(preSendDraft);
          setDraftReviews(preSendReviews);
        } else {
          // Track telemetry for successful message send
          telemetry.messageSent(
            props.workspaceId,
            effectiveModel,
            sendMessageOptions.agentId ?? agentId ?? WORKSPACE_DEFAULTS.agentId,
            finalMessageText.length,
            runtimeType,
            sendMessageOptions.thinkingLevel ?? "off"
          );

          if (modelOneShot) {
            trackCommandUsed("model");
          }

          // Mark workspace as read after sending a message.
          // This prevents the unread indicator from showing when the user
          // just interacted with the workspace (their own message bumps recencyTimestamp,
          // but since they initiated it, they've "read" the workspace).
          updatePersistedState(getWorkspaceLastReadKey(props.workspaceId), Date.now());

          if (transferredDraftProjectDiscovery) {
            // The transferred creation draft has been sent; later sends use
            // normal workspace skill discovery again.
            updatePersistedState(getPendingDraftSkillDiscoveryKey(props.workspaceId), undefined);
          }

          // Mark attached reviews as completed (checked)
          if (sentReviewIds.length > 0) {
            props.onCheckReviews?.(sentReviewIds);
          }

          // Exit editing mode if we were editing
          if (editMessageForSend && props.onCancelEdit) {
            props.onCancelEdit();
          } else if (editMessageForSend) {
            setOptimisticallyDismissedEditId(null);
          }
          props.onMessageSent?.(overrides?.queueDispatchMode ?? "tool-end");
        }
      } catch (error) {
        // Handle unexpected errors
        console.error("Unexpected error sending message:", error);
        setToast(
          createErrorToast({
            type: "unknown",
            raw: error instanceof Error ? error.message : "Failed to send message",
          })
        );
        // Restore draft on error
        setOptimisticallyDismissedEditId(null);
        setDraft(preSendDraft);
        setDraftReviews(preSendReviews);
      } finally {
        setSendingCount((c) => c - 1);
        setHideReviewsDuringSend(false);
      }
    } finally {
      // Always restore focus at the end
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  };

  const handleBoundaryEditConfirm = async () => {
    const pendingOverrides = pendingBoundaryEditConfirmation;
    const pendingEdit = editingMessageForUi;
    if (!pendingOverrides || variant !== "workspace" || !pendingEdit) {
      setPendingBoundaryEditConfirmation(null);
      return;
    }

    setPendingBoundaryEditConfirmation(null);
    await handleSend({ ...pendingOverrides, skipBoundaryEditConfirmation: true });
  };

  const handleBoundaryEditCancel = () => {
    setPendingBoundaryEditConfirmation(null);
  };

  // Keep the imperative API pointing at the latest send handler.
  handleSendRef.current = handleSend;

  // Handler for Escape in vim normal mode - cancels edit if editing
  const handleEscapeInNormalMode = () => {
    if (variant === "workspace" && editingMessageForUi && props.onCancelEdit) {
      restorePreEditDraft();
      props.onCancelEdit();
      inputRef.current?.blur();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle voice input toggle (Ctrl+D / Cmd+D)
    if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT) && voiceInput.shouldShowUI) {
      e.preventDefault();
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
      return;
    }

    // Space on empty input starts voice recording (ignore key repeat from holding)
    if (
      e.key === " " &&
      !e.repeat &&
      input.trim() === "" &&
      voiceInput.shouldShowUI &&
      voiceInput.isAvailable &&
      voiceInput.state === "idle"
    ) {
      e.preventDefault();
      voiceInput.start();
      return;
    }

    // Cycle models (Ctrl+/)
    if (matchesKeybind(e, KEYBINDS.CYCLE_MODEL)) {
      e.preventDefault();
      cycleToNextModel();
      return;
    }

    // Handle cancel edit (Escape) - workspace only
    // In vim mode, escape first goes to normal mode; escapeInNormalMode callback handles cancel
    // In non-vim mode, escape directly cancels edit
    if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
      if (variant === "workspace" && editingMessageForUi && props.onCancelEdit && !vimEnabled) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        restorePreEditDraft();
        props.onCancelEdit();
        const isFocused = document.activeElement === inputRef.current;
        if (isFocused) {
          inputRef.current?.blur();
        }
        return;
      }
    }

    // Handle up arrow on empty input - edit last user message (workspace only)
    if (
      variant === "workspace" &&
      e.key === "ArrowUp" &&
      !editingMessageForUi &&
      input.trim() === "" &&
      props.onEditLastUserMessage
    ) {
      e.preventDefault();
      props.onEditLastUserMessage();
      return;
    }

    // Note: ESC handled by VimTextArea (for mode transitions) and CommandSuggestions (for dismissal)

    if (composerSuggestions.isVisible && COMMAND_SUGGESTION_KEYS.includes(e.key)) {
      return;
    }

    const hasOnlyQueuedMessage =
      variant === "workspace" &&
      !editingMessageForUi &&
      props.queuedMessage != null &&
      input.trim() === "" &&
      attachments.length === 0 &&
      reviewPanelItems.length === 0;

    // Existing send keybinds edit the queued boundary when the composer itself is empty.
    if (hasOnlyQueuedMessage && matchesKeybind(e, KEYBINDS.SEND_QUEUED_MESSAGE_NOW)) {
      if (!props.onSendQueuedImmediately || e.repeat) return;
      e.preventDefault();
      stopKeyboardPropagation(e);
      props.onSendQueuedImmediately().catch((error: unknown) => {
        props.onQueuedActionError?.(error);
      });
      return;
    }

    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE_AFTER_TURN)) {
      e.preventDefault();
      if (hasOnlyQueuedMessage && props.onQueuedDispatchModeChange) {
        stopKeyboardPropagation(e);
        props.onQueuedDispatchModeChange("turn-end").catch((error: unknown) => {
          props.onQueuedActionError?.(error);
        });
      } else {
        void handleSend({ queueDispatchMode: "turn-end" });
      }
      return;
    }

    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
      // Mobile keyboards should keep Enter for newlines; sending remains button-driven.
      if (isMobileTouch) {
        return;
      }
      if (hasOnlyQueuedMessage && props.onQueuedDispatchModeChange && !e.repeat) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        props.onQueuedDispatchModeChange("tool-end").catch((error: unknown) => {
          props.onQueuedActionError?.(error);
        });
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  };

  const interruptKeybind = vimEnabled
    ? KEYBINDS.INTERRUPT_STREAM_VIM
    : KEYBINDS.INTERRUPT_STREAM_NORMAL;

  // Build placeholder text based on current state
  const placeholder = (() => {
    // Creation view keeps the onboarding prompt; workspace stays concise for the inline hints.
    if (variant === "creation") {
      return props.kind === "scratch"
        ? "Describe your goals to start a scratch chat..."
        : "Describe your goals to create a workspace...";
    }

    // Workspace variant placeholders
    if (editingMessageForUi) {
      if (isMobileTouch) {
        return "Edit your message...";
      }
      const cancelHint = vimEnabled
        ? `${formatKeybind(KEYBINDS.CANCEL_EDIT)}×2 to cancel`
        : `${formatKeybind(KEYBINDS.CANCEL_EDIT)} to cancel`;
      return `Edit your message... (${cancelHint}, ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send)`;
    }
    if (disabled) {
      if (initialStagingLocked) {
        return "Staging attached files...";
      }
      const disabledReason = props.disabledReason;
      if (typeof disabledReason === "string" && disabledReason.trim().length > 0) {
        return disabledReason;
      }
    }
    if (isCompacting) {
      if (isMobileTouch) {
        return "Compacting...";
      }
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    // Tip carousel: rotates the placeholder through a curated list of
    // slash-command tricks on a wall-clock bucket so switching workspaces
    // mid-bucket doesn't reroll the visible tip. See placeholderTips.ts.
    //
    if (isMobileTouch || props.kind === "scratch") {
      return "Type a message...";
    }
    return getPlaceholderTip();
  })();

  const activeToast = toast ?? (variant === "creation" ? creationState.toast : null);

  // No wrapper needed - parent controls layout for both variants
  const Wrapper = React.Fragment;
  const wrapperProps = {};

  return (
    <Wrapper {...wrapperProps}>
      {creationState.trustDialog}
      {/* Loading overlay during workspace creation */}
      {variant === "creation" && (
        <CreationCenterContent
          projectName={props.projectName}
          isSending={isSendInFlight}
          workspaceName={
            isSendInFlight && props.kind !== "scratch"
              ? creationState.creatingWithIdentity?.name
              : undefined
          }
          workspaceTitle={isSendInFlight ? creationState.creatingWithIdentity?.title : undefined}
        />
      )}

      {/* Input section - centered card for creation, bottom bar for workspace */}
      <div
        ref={chatInputSectionRef}
        className={cn(
          "relative flex flex-col gap-1",
          variant === "creation"
            ? `w-full ${CREATION_COLUMN_MAX_WIDTH_CLASS}`
            : // WorkspaceFooterBar owns the bottom safe-area inset.
              `bg-surface-primary pb-2 ${CHAT_DOCK_GUTTER_CLASS}`
        )}
        data-component="ChatInputSection"
        data-autofocus-state="done"
      >
        <div className={cn(variant === "creation" ? "w-full" : chatDockColumnWidthClass)}>
          {/* Toasts (overlay) */}
          <div className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 flex flex-col gap-2 [&>*]:pointer-events-auto">
            <ConnectionStatusToast wrap={false} />
            <ChatInputToast
              toast={activeToast}
              wrap={false}
              onDismiss={() => {
                handleToastDismiss();
                if (variant === "creation") {
                  creationState.setToast(null);
                }
              }}
            />
          </div>

          {/* Attached reviews preview - show styled blocks with remove/edit buttons */}
          {/* Hide during send to avoid duplicate display with the sent message */}
          {variant === "workspace" && !hideReviewsDuringSend && (
            <AttachedReviewsPanel
              reviews={reviewPanelItems}
              onDetachAll={
                reviewOverrideActive
                  ? () =>
                      setDraftReviews((prev) => (prev === null || prev.length === 0 ? prev : []))
                  : props.onDetachAllReviews
              }
              onDetach={reviewOverrideActive ? removeDraftReview : props.onDetachReview}
              onCheck={reviewOverrideActive ? removeDraftReview : props.onCheckReview}
              onDelete={reviewOverrideActive ? removeDraftReview : props.onDeleteReview}
              onUpdateNote={reviewOverrideActive ? updateDraftReviewNote : props.onUpdateReviewNote}
            />
          )}

          {/* Creation header controls - shown above textarea for creation variant */}
          {creationControlsProps && <CreationControls {...creationControlsProps} />}

          {/* Scratch chats have no CreationControls, but mobile users still
              need the current scope visible and a way to reach a project's
              creation page: on narrow viewports the sidebar auto-collapses
              after opening the scratch page from it. */}
          {variant === "creation" && props.kind === "scratch" && (
            <div className="mb-3 flex items-center" data-component="ScratchProjectGroup">
              <CreationProjectSelect
                selected={SCRATCH_PROJECT_CONFIG_KEY}
                selectedLabel={SCRATCH_PROJECT_NAME}
                tooltip={SCRATCH_PROJECT_NAME}
                options={[
                  { value: SCRATCH_PROJECT_CONFIG_KEY, label: SCRATCH_PROJECT_NAME },
                  ...Array.from(userProjects.keys()).map((path) => ({
                    value: path,
                    label: formatProjectHierarchyLabel(path, userProjects),
                  })),
                ]}
                onChange={(path) => {
                  if (path !== SCRATCH_PROJECT_CONFIG_KEY) {
                    beginWorkspaceCreation(path);
                  }
                }}
              />
            </div>
          )}

          <CodexOauthWarningBanner
            requiresCodexOauth={requiresCodexOauth(baseModel)}
            codexOauthSet={codexOauthSet}
            onOpenProviders={() => open("providers", { expandProvider: "openai" })}
          />

          <CommandSuggestions
            suggestions={composerSuggestions.suggestions}
            onSelectSuggestion={composerSuggestions.select}
            onDismiss={composerSuggestions.dismiss}
            isVisible={composerSuggestions.isVisible}
            ariaLabel={composerSuggestions.ariaLabel}
            listId={composerSuggestions.listId}
            anchorRef={variant === "creation" ? inputRef : undefined}
            highlightQuery={composerSuggestions.highlightQuery}
            isFileSuggestion={composerSuggestions.isFileSuggestion}
            selectedIndex={composerSuggestions.selectedIndex}
            onSelectedIndexChange={composerSuggestions.setSelectedIndex}
          />

          {/* Scope the focus border to the textarea so sibling controls do not trigger it. */}
          <div
            className={cn(
              "rounded-md border p-2",
              editingMessageForUi
                ? "bg-editing-mode-alpha border-editing-mode"
                : "border-border-light has-[textarea:focus]:border-[var(--composer-focus-border)]"
            )}
            style={composerSurfaceStyle}
            data-component="ChatInputSurface"
          >
            <div className="relative flex items-end pb-1" data-component="ChatInputControls">
              {/* Recording/transcribing overlay - replaces textarea when active */}
              {voiceInput.state !== "idle" ? (
                <RecordingOverlay
                  state={voiceInput.state}
                  agentColor={agentColor}
                  mediaRecorder={voiceInput.mediaRecorder}
                  onStop={voiceInput.toggle}
                />
              ) : (
                <>
                  <VimTextArea
                    ref={inputRef}
                    data-escape-interrupts-stream="true"
                    value={input}
                    ghostHint={composerSuggestions.ghostHint}
                    onChange={handleComposerInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onKeyUp={composerSuggestions.handleCursorActivity}
                    onMouseUp={composerSuggestions.handleCursorActivity}
                    onSelect={composerSuggestions.handleCursorActivity}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onEscapeInNormalMode={handleEscapeInNormalMode}
                    suppressKeys={
                      composerSuggestions.isVisible ? COMMAND_SUGGESTION_KEYS : undefined
                    }
                    placeholder={placeholder}
                    disabled={!editingMessageForUi && (disabled || sendInFlightBlocksInput)}
                    aria-label={editingMessageForUi ? "Edit your last message" : "Message Claude"}
                    aria-autocomplete="list"
                    aria-controls={
                      composerSuggestions.isVisible ? composerSuggestions.listId : undefined
                    }
                    aria-expanded={composerSuggestions.isVisible}
                    // Creation favors prompt space; workspaces preserve transcript space. Mobile
                    // hides the shortcut hints the workspace floor exists for, so that room is
                    // dead space on a screen that has none to spare.
                    className={
                      variant === "creation" ? "min-h-36" : isMobileTouch ? "min-h-9" : "min-h-22"
                    }
                  />
                  {/* Keep shortcuts visible in both creation + workspace without bloating the footer or crowding it. */}
                  {input.trim() === "" && !editingMessageForUi && (
                    <div className="mobile-hide-shortcut-hints text-muted @container pointer-events-none absolute right-2 bottom-3 left-2 flex flex-nowrap items-center gap-4 overflow-hidden text-[11px] whitespace-nowrap">
                      <span className="shrink-0">
                        <span className="font-mono">{formatKeybind(KEYBINDS.FOCUS_CHAT)}</span>
                        <span> - focus chat</span>
                      </span>
                      <span className="shrink-0 [@container(max-width:520px)]:hidden">
                        <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_MODEL)}</span>
                        <span> - change model</span>
                      </span>
                      <span className="shrink-0 [@container(max-width:640px)]:hidden">
                        <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_AGENT)}</span>
                        <span> - change agent</span>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <ChatAttachments attachments={attachments} onRemove={handleRemoveAttachment} />

            <div className="flex flex-col gap-0.5" data-component="ChatModeToggles">
              {/* Editing indicator - workspace only */}
              {variant === "workspace" && editingMessageForUi && (
                <div className="text-edit-mode text-[11px] font-medium">
                  Editing message{" "}
                  <span className="mobile-hide-shortcut-hints">
                    ({formatKeybind(KEYBINDS.CANCEL_EDIT)}
                    {vimEnabled ? "×2" : ""} to cancel)
                  </span>
                </div>
              )}

              {/* 320px is a container breakpoint, not a minimum width. The row must shrink to
                keep trailing controls inside narrow composers. */}
              <div
                className="@container flex flex-nowrap items-center gap-1.5"
                data-component="ComposerControlRow"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <div
                    className="min-w-0 [@container(max-width:320px)]:hidden"
                    data-tutorial="mode-selector"
                  >
                    <AgentModePicker
                      className="min-w-0"
                      iconOnlyHideClassName={
                        variant === "workspace"
                          ? COMPOSER_WORKSPACE_ICON_ONLY_HIDE_CLASS
                          : COMPOSER_ICON_ONLY_HIDE_CLASS
                      }
                      onComplete={() => inputRef.current?.focus()}
                    />
                  </div>

                  {/* Inset outlines preserve the boundary over hover backgrounds and in forced colors. */}
                  <div
                    className={cn(
                      "outline-border-light flex min-w-0 items-center gap-1.5 rounded-md px-1.5 outline-1 -outline-offset-1",
                      COMPOSER_CONTROL_HEIGHT_CLASS
                    )}
                    data-component="ModelSelectorGroup"
                    data-tutorial="model-selector"
                  >
                    <ModelSelector
                      ref={modelSelectorRef}
                      value={baseModel}
                      onChange={setPreferredModel}
                      models={models}
                      onComplete={() => inputRef.current?.focus()}
                      defaultModel={defaultModel}
                      onSetDefaultModel={setDefaultModel}
                      hiddenModels={hiddenModelsForSelector}
                      onOpenSettings={() => open("models")}
                      className="h-full max-w-[8rem] min-w-0"
                      tooltipExtraContent={
                        <>
                          <strong>Click to edit</strong>
                          <br />
                          <strong>{formatKeybind(KEYBINDS.CYCLE_MODEL)}</strong> to cycle models
                          <br />
                          <br />
                          <strong>Abbreviations:</strong>
                          {MODEL_ABBREVIATION_EXAMPLES.map((ex) => (
                            <React.Fragment key={ex.abbrev}>
                              <br />• <code>/model {ex.abbrev}</code> - {ex.displayName}
                            </React.Fragment>
                          ))}
                          <br />
                          <br />
                          <strong>Full format:</strong>
                          <br />
                          <code>/model provider:model-name</code>
                          <br />
                          (e.g., <code>/model anthropic:claude-sonnet-4-5</code>)
                        </>
                      }
                    />
                    <span className="bg-border-light h-3.5 w-px shrink-0" aria-hidden="true" />

                    <div
                      className="flex shrink-0 items-center"
                      data-component="ThinkingSelectorGroup"
                    >
                      <ThinkingSelector modelString={baseModel} />
                    </div>
                  </div>

                  {variant === "workspace" && (
                    <ContextUsageIndicatorButton
                      data={contextUsageData}
                      autoCompaction={autoCompactionProps}
                      idleCompaction={idleCompactionProps}
                      model={contextDisplayModel}
                    />
                  )}
                </div>

                <div
                  className="flex shrink-0 items-center justify-end gap-1"
                  data-component="ModelControls"
                >
                  {/* Attach and voice sit below the textarea rather than in an absolute overlay so
                  they can never visually intersect typed or wrapped text. */}
                  <div
                    className="flex shrink-0 items-center gap-0"
                    data-component="InputMethodGroup"
                  >
                    <AttachFileButton
                      onFiles={handleAttachFiles}
                      disabled={disabled || sendInFlightBlocksInput || !!editingMessageForUi}
                    />
                    <VoiceInputButton
                      state={voiceInput.state}
                      isAvailable={voiceInput.isAvailable}
                      shouldShowUI={voiceInput.shouldShowUI}
                      requiresSecureContext={voiceInput.requiresSecureContext}
                      onToggle={voiceInput.toggle}
                      disabled={disabled || sendInFlightBlocksInput}
                      agentColor={agentColor}
                    />
                  </div>

                  <div ref={sendModeMenuContainerRef} className="relative">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          onClick={() => {
                            if (suppressSendClickIfLongPress()) {
                              return;
                            }

                            void handleSend();
                          }}
                          onContextMenu={openSendModeMenuFromContext}
                          onTouchStart={sendModeMenuTouchHandlers.onTouchStart}
                          onTouchEnd={sendModeMenuTouchHandlers.onTouchEnd}
                          onTouchMove={sendModeMenuTouchHandlers.onTouchMove}
                          onTouchCancel={sendModeMenuTouchHandlers.onTouchEnd}
                          disabled={!canSend}
                          aria-label="Send message"
                          aria-expanded={canChooseDispatchMode ? isSendModeMenuOpen : undefined}
                          aria-haspopup={canChooseDispatchMode ? "menu" : undefined}
                          size="xs"
                          variant="ghost"
                          className={cn(
                            // Keep the filled action compact so it reads as an icon button, not a
                            // second bordered control competing with the picker groups.
                            "inline-flex h-7 w-7 items-center justify-center rounded-full p-0 font-medium transition-colors duration-200",
                            // Pin text colors because the ghost variant otherwise overrides the glyph.
                            canSend
                              ? "bg-composer-send hover:bg-composer-send text-composer-send-foreground hover:text-composer-send-foreground hover:opacity-90"
                              : "bg-surface-secondary text-composer-send-foreground",
                            "[@media(hover:none)_and_(pointer:coarse)]:h-9 [@media(hover:none)_and_(pointer:coarse)]:w-9 [@media(hover:none)_and_(pointer:coarse)]:text-sm"
                          )}
                        >
                          <SendHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent align="start" className="max-w-80 whitespace-normal">
                        <strong>Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})</strong>
                        {variant === "workspace" && (
                          <>
                            <br />
                            <br />
                            <strong>Right-click or long-press for advanced send modes:</strong>
                            {runningGoalActive && !editingMessageForUi && (
                              <>
                                <br />
                                Manual sends pause the current goal; use Resume to continue it.
                              </>
                            )}
                            {SEND_DISPATCH_MODES.map((entry) => (
                              <React.Fragment key={entry.mode}>
                                <br />
                                {entry.label}: <kbd>{formatKeybind(entry.keybind)}</kbd>
                              </React.Fragment>
                            ))}
                          </>
                        )}
                      </TooltipContent>
                    </Tooltip>

                    {canChooseDispatchMode && isSendModeMenuOpen && (
                      <div className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 min-w-[12.5rem] rounded-md border p-1.5 shadow-md">
                        {SEND_DISPATCH_MODES.map((entry) => (
                          <button
                            key={entry.mode}
                            type="button"
                            className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1 text-left text-xs"
                            onClick={() => {
                              closeSendModeMenu();
                              void handleSend(
                                entry.mode === "tool-end"
                                  ? undefined
                                  : { queueDispatchMode: entry.mode }
                              );
                            }}
                          >
                            <span className="whitespace-nowrap">{entry.label}</span>
                            <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-1.5 py-px font-mono text-[10px] whitespace-nowrap">
                              {formatKeybind(entry.keybind)}
                            </kbd>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={pendingBoundaryEditConfirmation !== null}
        title="Edit Message Before Context Boundary?"
        description="Sending this edit will discard the latest compaction or reset summary and every message after the edited one, then continue from the rewritten history."
        warning="This action cannot be undone."
        confirmLabel="Edit and Send"
        onConfirm={handleBoundaryEditConfirm}
        onCancel={handleBoundaryEditCancel}
      />

      {/* Confirmation modal for destructive commands (currently only /clear). */}
      <ConfirmationModal
        isOpen={pendingDestructiveCommand}
        title="Clear Chat History?"
        description="This will remove all messages from the conversation."
        warning="This action cannot be undone."
        confirmLabel="Clear"
        onConfirm={handleDestructiveCommandConfirm}
        onCancel={handleDestructiveCommandCancel}
      />
    </Wrapper>
  );
};

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";
