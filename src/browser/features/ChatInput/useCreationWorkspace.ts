import { createElement, useState, useEffect, useCallback, useRef } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type {
  CoderWorkspaceConfig,
  RuntimeConfig,
  RuntimeMode,
  ParsedRuntime,
  RuntimeAvailabilityStatus,
} from "@/common/types/runtime";
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import { buildRuntimeConfig, RUNTIME_MODE } from "@/common/types/runtime";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  getAgentIdKey,
  getInputKey,
  getInputAttachmentsKey,
  getModelKey,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getPendingScopeId,
  getDraftScopeId,
  getPendingDraftSkillDiscoveryKey,
  getPendingWorkspaceSendErrorKey,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { SendMessageError } from "@/common/types/errors";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import type { Toast } from "@/browser/features/ChatInput/ChatInputToast";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import type { WorkspaceCreatedOptions } from "@/browser/features/ChatInput/types";
import type {
  ChatAttachment,
  PendingFileChatAttachment,
} from "@/browser/features/ChatInput/ChatAttachments";
import {
  formatPendingFileStagingError,
  replacePendingFilesWithStaged,
  stagePendingFiles,
} from "@/browser/features/ChatInput/pendingFileAttachments";
import { filePartsToChatAttachments } from "@/browser/features/ChatInput/utils";
import {
  lockInitialStaging,
  unlockInitialStaging,
} from "@/browser/features/ChatInput/initialStagingLock";
import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  estimatePersistedChatAttachmentsChars,
  MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS,
} from "@/browser/features/ChatInput/draftAttachmentsStorage";
import type { MuxMessageMetadata } from "@/common/types/message";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import {
  processSlashCommand,
  type CommandAction,
  type SlashCommandEnv,
} from "@/browser/utils/chatCommands";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  useWorkspaceName,
  type WorkspaceNameState,
  type WorkspaceIdentity,
} from "@/browser/hooks/useWorkspaceName";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  getModelCapabilities,
  getModelCapabilitiesResolved,
} from "@/common/utils/ai/modelCapabilities";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { resolveDevcontainerSelection } from "@/browser/utils/devcontainerSelection";
import { getErrorMessage } from "@/common/utils/errors";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export type CreationSendResult = { success: true } | { success: false; error?: SendMessageError };
export type CreationInitialSlashCommand = Extract<ParsedCommand, { type: "goal-set" }>;

interface UseCreationWorkspaceOptions {
  kind?: "scratch";
  projectPath: string;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => void;
  /** Current message input for name generation */
  message: string;
  /** Sub-project path to use for cwd and AGENTS.md context. */
  subProjectPath?: string | null;
  /** Draft ID for UI-only workspace creation drafts (from URL) */
  draftId?: string | null;
  /** Dynamic workflows gate used when an initial creation command starts a workflow. */
  dynamicWorkflowsEnabled?: boolean;
  /** User's currently selected model (for name generation fallback) */
  userModel?: string;
}

function syncCreationPreferences(projectPath: string, workspaceId: string): void {
  const projectScopeId = getProjectScopeId(projectPath);

  // Sync model from project scope to workspace scope
  // This ensures the model used for creation is persisted for future resumes
  const projectModel = readPersistedState<string | null>(getModelKey(projectScopeId), null);
  if (projectModel) {
    setWorkspaceModelWithOrigin(workspaceId, projectModel, "sync");
  }

  const projectAgentId = readPersistedState<string | null>(getAgentIdKey(projectScopeId), null);
  const globalDefaultAgentId = readPersistedState<string>(
    getAgentIdKey(GLOBAL_SCOPE_ID),
    WORKSPACE_DEFAULTS.agentId
  );
  const effectiveAgentId =
    typeof projectAgentId === "string" && projectAgentId.trim().length > 0
      ? normalizeAgentId(projectAgentId, WORKSPACE_DEFAULTS.agentId)
      : normalizeAgentId(globalDefaultAgentId, WORKSPACE_DEFAULTS.agentId);
  updatePersistedState(getAgentIdKey(workspaceId), effectiveAgentId);

  const projectThinkingLevel = readPersistedState<ThinkingLevel | null>(
    getThinkingLevelKey(projectScopeId),
    null
  );
  if (projectThinkingLevel !== null) {
    updatePersistedState(getThinkingLevelKey(workspaceId), projectThinkingLevel);
  }

  // Mirror thinkingLevel: carry the creation-time pro reasoning-mode choice into
  // the new workspace's scope so it survives the project→workspace transition.
  // Coerced so a corrupt persisted value is dropped instead of copied forward.
  const projectReasoningMode = coerceOpenAIReasoningMode(
    readPersistedState<OpenAIReasoningMode | null>(getReasoningModeKey(projectScopeId), null)
  );
  if (projectReasoningMode != null) {
    updatePersistedState(getReasoningModeKey(workspaceId), projectReasoningMode);
  }

  if (projectModel) {
    const effectiveThinking: ThinkingLevel = projectThinkingLevel ?? "off";

    type AgentSettingsCache = Partial<
      Record<
        string,
        { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
      >
    >;
    updatePersistedState<AgentSettingsCache>(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      (prev) => {
        const record: AgentSettingsCache = prev && typeof prev === "object" ? prev : {};
        return {
          ...record,
          [effectiveAgentId]: {
            model: projectModel,
            thinkingLevel: effectiveThinking,
            ...(projectReasoningMode != null ? { reasoningMode: projectReasoningMode } : {}),
          },
        };
      },
      {}
    );
  }

  // Auto-enable notifications if the project-level preference is set
  const autoEnableNotifications = readPersistedState<boolean>(
    getNotifyOnResponseAutoEnableKey(projectPath),
    false
  );
  if (autoEnableNotifications) {
    updatePersistedState(getNotifyOnResponseKey(workspaceId), true);
  }
}

const PDF_MEDIA_TYPE = "application/pdf";

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

interface UseCreationWorkspaceReturn {
  branches: string[];
  /** Whether listBranches has completed (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  setTrunkBranch: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  /** Fallback Coder config used when re-selecting Coder runtime. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Fallback SSH host used when leaving the Coder runtime. */
  sshHostFallback: string;
  defaultRuntimeMode: RuntimeChoice;
  /** Set the currently selected runtime (discriminated union) */
  setSelectedRuntime: (runtime: ParsedRuntime) => void;
  /** Set the default runtime choice for this project (persists via checkbox) */
  setDefaultRuntimeChoice: (choice: RuntimeChoice) => void;
  toast: Toast | null;
  setToast: (toast: Toast | null) => void;
  isSending: boolean;
  handleSend: (
    message: string,
    fileParts?: FilePart[],
    optionsOverride?: Partial<SendMessageOptions>,
    initialSlashCommand?: CreationInitialSlashCommand,
    pendingFiles?: PendingFileChatAttachment[]
  ) => Promise<CreationSendResult>;
  /** Workspace name/title generation state and actions (for CreationControls) */
  nameState: WorkspaceNameState;
  /** The confirmed identity being used for creation (null until generation resolves) */
  creatingWithIdentity: WorkspaceIdentity | null;
  /** Reload branches (e.g., after git init) */
  reloadBranches: () => Promise<void>;
  /** Runtime availability state for each mode (loading/failed/loaded) */
  runtimeAvailabilityState: RuntimeAvailabilityState;
  /** Trust confirmation dialog element — render in parent component tree */
  trustDialog: React.ReactNode;
}

/** Runtime availability status for each mode */
export type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

export type RuntimeAvailabilityState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: RuntimeAvailabilityMap };

// Persist a failed creation send's draft under the new workspace's keys so the
// retry happens there instead of creating a duplicate workspace.
function transferDraftToWorkspace(
  workspaceId: string,
  text: string,
  attachments: ChatAttachment[],
  forceProjectSkillDiscovery: boolean
): void {
  if (forceProjectSkillDiscovery) {
    // The original send resolved its slash skill against the project path;
    // carry that choice so the retry cannot resolve a different skill from
    // the new worktree.
    updatePersistedState(getPendingDraftSkillDiscoveryKey(workspaceId), true);
  }
  updatePersistedState(getInputKey(workspaceId), text);
  // Base64-bearing attachments can exceed the persistence cap. Drop the
  // largest ones first so small retryable chips (e.g. a pending file whose
  // staging failed) survive the transfer.
  let persistable = attachments;
  while (
    persistable.length > 0 &&
    estimatePersistedChatAttachmentsChars(persistable) > MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS
  ) {
    const largest = persistable.reduce((a, b) =>
      JSON.stringify(b).length > JSON.stringify(a).length ? b : a
    );
    persistable = persistable.filter((attachment) => attachment !== largest);
  }
  updatePersistedState(
    getInputAttachmentsKey(workspaceId),
    persistable.length > 0 ? persistable : undefined
  );
}

/**
 * Hook for managing workspace creation state and logic
 * Handles:
 * - Branch selection
 * - Runtime configuration (local vs SSH)
 * - Workspace name generation
 * - Message sending with workspace creation
 */
export function useCreationWorkspace({
  kind,
  projectPath,
  onWorkspaceCreated,
  message,
  subProjectPath,
  draftId,
  dynamicWorkflowsEnabled = false,
  userModel,
}: UseCreationWorkspaceOptions): UseCreationWorkspaceReturn {
  const workspaceContext = useOptionalWorkspaceContext();
  const promoteWorkspaceDraft = workspaceContext?.promoteWorkspaceDraft;
  const deleteWorkspaceDraft = workspaceContext?.deleteWorkspaceDraft;
  const { currentWorkspaceId, currentProjectId, pendingDraftId } = useRouter();
  const isMountedRef = useRef(true);
  const latestRouteRef = useRef({ currentWorkspaceId, currentProjectId, pendingDraftId });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Keep router state fresh synchronously so auto-navigation checks don't lag behind route changes.
  latestRouteRef.current = { currentWorkspaceId, currentProjectId, pendingDraftId };
  const { api } = useAPI();
  const { getProjectConfig, refreshProjects, loading: projectsLoading } = useProjectContext();
  const { config: providersConfig } = useProvidersConfig();
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [trustPrompt, setTrustPrompt] = useState<{
    resolve: (trusted: boolean) => void;
    /** Snapshot of the project path that triggered the trust prompt,
     * so onConfirm trusts the correct project even if the user navigates. */
    projectPath: string;
  } | null>(null);
  // The confirmed identity being used for workspace creation (set after waitForGeneration resolves)
  const [creatingWithIdentity, setCreatingWithIdentity] = useState<WorkspaceIdentity | null>(null);
  const [runtimeAvailabilityState, setRuntimeAvailabilityState] =
    useState<RuntimeAvailabilityState>({ status: "loading" });

  // Centralized draft workspace settings with automatic persistence
  const {
    settings,
    coderConfigFallback,
    sshHostFallback,
    setSelectedRuntime,
    setDefaultRuntimeChoice,
    setTrunkBranch,
  } = useDraftWorkspaceSettings(projectPath, branches, recommendedTrunk);

  // Persist draft workspace name generation state per draft (so multiple drafts don't share a
  // single auto-naming/manual-name state).
  const workspaceNameScopeId =
    projectPath.trim().length > 0
      ? typeof draftId === "string" && draftId.trim().length > 0
        ? getDraftScopeId(projectPath, draftId)
        : getPendingScopeId(projectPath)
      : null;

  // Project scope ID for reading send options at send time
  const projectScopeId = getProjectScopeId(projectPath);

  // Workspace name generation with debounce
  // Backend tries cheap models first, then user's model, then any available
  const workspaceNameState = useWorkspaceName({
    message,
    debounceMs: 500,
    userModel,
    scopeId: workspaceNameScopeId,
  });

  // Destructure name state functions for use in callbacks
  const { waitForGeneration } = workspaceNameState;

  // Load branches - used on mount and after git init
  // Returns a cleanup function to track mounted state
  const loadBranches = useCallback(async () => {
    if (kind === "scratch" || !projectPath.length || !api) return;
    setBranchesLoaded(false);
    try {
      const result = await api.projects.listBranches({ projectPath });
      setBranches(result.branches);
      setRecommendedTrunk(result.recommendedTrunk);
    } catch (err) {
      console.error("Failed to load branches:", err);
    } finally {
      setBranchesLoaded(true);
    }
  }, [kind, projectPath, api]);

  // Load branches and runtime availability on mount with mounted guard
  useEffect(() => {
    if (kind === "scratch") {
      setBranchesLoaded(true);
      return;
    }
    if (!projectPath.length || !api) return;
    let mounted = true;
    setBranchesLoaded(false);
    setRuntimeAvailabilityState({ status: "loading" });
    const doLoad = async () => {
      try {
        // Use allSettled so failures are independent - branches can load even if availability fails
        const [branchResult, availabilityResult] = await Promise.allSettled([
          api.projects.listBranches({ projectPath }),
          api.projects.runtimeAvailability({ projectPath }),
        ]);
        if (!mounted) return;
        if (branchResult.status === "fulfilled") {
          setBranches(branchResult.value.branches);
          setRecommendedTrunk(branchResult.value.recommendedTrunk);
        } else {
          console.error("Failed to load branches:", branchResult.reason);
        }
        if (availabilityResult.status === "fulfilled") {
          setRuntimeAvailabilityState({ status: "loaded", data: availabilityResult.value });
        } else {
          setRuntimeAvailabilityState({ status: "failed" });
        }
      } finally {
        if (mounted) {
          setBranchesLoaded(true);
        }
      }
    };
    void doLoad();
    return () => {
      mounted = false;
    };
  }, [kind, projectPath, api]);

  // Cleanup: resolve trust prompt on unmount so handleSend doesn't wedge
  useEffect(() => {
    return () => {
      if (trustPrompt) {
        trustPrompt.resolve(false);
      }
    };
  }, [trustPrompt]);

  const handleSend = useCallback(
    async (
      messageText: string,
      fileParts?: FilePart[],
      optionsOverride?: Partial<SendMessageOptions>,
      initialSlashCommand?: CreationInitialSlashCommand,
      pendingFiles?: PendingFileChatAttachment[]
    ): Promise<CreationSendResult> => {
      const pendingFilesToStage = pendingFiles ?? [];
      // File-only sends are valid; the attached-files notice or provider file
      // parts carry the content.
      const hasSendableAttachments = pendingFilesToStage.length > 0 || (fileParts?.length ?? 0) > 0;
      if ((!messageText.trim() && !hasSendableAttachments) || isSending || !api) {
        return { success: false };
      }

      // Build runtime config early (used later for workspace creation)
      let runtimeSelection = settings.selectedRuntime;

      // Scratch chats always run on the local runtime and never load runtime
      // availability, so the devcontainer preflight below would block creation
      // forever (availability stays "loading") for users whose default runtime
      // is Dev Container. createScratch() ignores runtimeConfig entirely.
      if (kind !== "scratch" && runtimeSelection.mode === RUNTIME_MODE.DEVCONTAINER) {
        const devcontainerSelection = resolveDevcontainerSelection({
          selectedRuntime: runtimeSelection,
          availabilityState: runtimeAvailabilityState,
        });

        if (!devcontainerSelection.isCreatable) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: "Select a devcontainer configuration before creating the workspace.",
          });
          return { success: false };
        }

        // Update selection with resolved config if different (persist the resolved value)
        if (devcontainerSelection.configPath !== runtimeSelection.configPath) {
          runtimeSelection = {
            ...runtimeSelection,
            configPath: devcontainerSelection.configPath,
          };
          setSelectedRuntime(runtimeSelection);
        }
      }

      const runtimeConfig: RuntimeConfig | undefined = buildRuntimeConfig(runtimeSelection);

      setIsSending(true);
      setToast(null);
      // If user provided a manual name, show it immediately in the overlay
      // instead of "Generating name…". Auto-generated names still show the
      // loading text until generation resolves.
      setCreatingWithIdentity(
        !workspaceNameState.autoGenerate && workspaceNameState.name.trim()
          ? { name: workspaceNameState.name.trim(), title: workspaceNameState.name.trim() }
          : null
      );

      let createdWorkspaceId: string | null = null;

      try {
        // Wait for identity generation to complete (blocks if still in progress)
        // Returns null if generation failed or manual name is empty (error already set in hook)
        const identity = await waitForGeneration();
        if (!identity) {
          setIsSending(false);
          return { success: false };
        }

        // Set the confirmed identity for splash UI display
        setCreatingWithIdentity(identity);

        const normalizedTitle = typeof identity.title === "string" ? identity.title.trim() : "";
        const createTitle = normalizedTitle || undefined;

        // Read send options fresh from localStorage at send time to avoid
        // race conditions with React state updates (requestAnimationFrame batching
        // in usePersistedState can delay state updates after model selection).
        // Override agentId from current draft settings so first-send uses the same
        // project/global/default resolution chain as the creation UI.
        const sendMessageOptions = {
          ...getSendOptionsFromStorage(projectScopeId),
          agentId: settings.agentId,
        };
        // Use normalized override if provided, otherwise fall back to already-normalized storage model
        const normalizedOverride = optionsOverride?.model
          ? normalizeModelInput(optionsOverride.model)
          : null;
        const baseModel = normalizedOverride?.model ?? sendMessageOptions.model;

        // Preflight: if the first message includes PDFs, ensure the selected model can accept them.
        // This prevents creating an empty workspace when the initial send is rejected.
        const pdfFileParts = (fileParts ?? []).filter(
          (part) => getBaseMediaType(part.mediaType) === PDF_MEDIA_TYPE
        );
        if (pdfFileParts.length > 0) {
          const caps = getModelCapabilitiesResolved(baseModel, providersConfig);
          if (caps && !caps.supportsPdfInput) {
            const pdfCapableKnownModels = Object.values(KNOWN_MODELS)
              .map((m) => m.id)
              .filter((model) => getModelCapabilities(model)?.supportsPdfInput);
            const pdfCapableExamples = pdfCapableKnownModels.slice(0, 3);
            const examplesSuffix =
              pdfCapableKnownModels.length > pdfCapableExamples.length ? ", and others." : ".";

            setToast({
              id: Date.now().toString(),
              type: "error",
              title: "PDF not supported",
              message:
                `Model ${baseModel} does not support PDF input.` +
                (pdfCapableExamples.length > 0
                  ? ` Try e.g.: ${pdfCapableExamples.join(", ")}${examplesSuffix}`
                  : " Choose a model with PDF support."),
            });
            setIsSending(false);
            return { success: false };
          }

          if (caps?.maxPdfSizeMb !== undefined) {
            const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
            for (const part of pdfFileParts) {
              const bytes = estimateBase64DataUrlBytes(part.url);
              if (bytes !== null && bytes > maxBytes) {
                const actualMb = (bytes / (1024 * 1024)).toFixed(1);
                setToast({
                  id: Date.now().toString(),
                  type: "error",
                  title: "PDF too large",
                  message: `${part.filename ?? "PDF"} is ${actualMb}MB, but ${baseModel} allows up to ${caps.maxPdfSizeMb}MB per PDF.`,
                });
                setIsSending(false);
                return { success: false };
              }
            }
          }
        }

        // Gate: untrusted projects must be confirmed before workspace creation.
        // Skip while projects are still loading — the backend gate catches untrusted projects.
        if (kind !== "scratch" && !projectsLoading && !getProjectConfig(projectPath)?.trusted) {
          const userConfirmed = await new Promise<boolean>((resolve) => {
            setTrustPrompt({ resolve, projectPath });
          });
          if (!userConfirmed) {
            // User cancelled the trust dialog, or trust API call failed
            // (which already showed its own error toast). Silently abort.
            setIsSending(false);
            return { success: false };
          }
          // Trust was confirmed and set, continue with creation
        }

        const createResult =
          kind === "scratch"
            ? await api.workspace.createScratch({ title: createTitle })
            : await api.workspace.create({
                projectPath,
                branchName: identity.name,
                trunkBranch: settings.trunkBranch,
                title: createTitle,
                runtimeConfig,
                subProjectPath: subProjectPath ?? undefined,
              });

        if (!createResult.success) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: createResult.error,
          });
          setIsSending(false);
          return { success: false };
        }

        const { metadata } = createResult;
        createdWorkspaceId = metadata.id;

        // Best-effort: persist the initial AI settings to the backend immediately so this workspace
        // is portable across devices even before the first stream starts. Initial /goal commands do
        // not send a normal user message, so they await this write before setting the goal; that lets
        // the backend kickoff continuation use the same model/agent selected in creation.
        const initialAiSettingsPersisted = api.workspace
          .updateAgentAISettings({
            workspaceId: metadata.id,
            agentId: settings.agentId,
            aiSettings: {
              model: settings.model,
              thinkingLevel: settings.thinkingLevel,
              reasoningMode: settings.reasoningMode,
            },
            persistSelectedAgentId: true,
          })
          .catch(() => null);

        const isDraftScope = typeof draftId === "string" && draftId.trim().length > 0;
        const pendingScopeId = projectPath
          ? isDraftScope
            ? getDraftScopeId(projectPath, draftId)
            : getPendingScopeId(projectPath)
          : null;

        const clearPendingDraft = () => {
          // Once the workspace exists, drop the draft even if the initial send fails
          // so we don't keep a hidden placeholder in the sidebar.
          if (!pendingScopeId) {
            return;
          }

          if (isDraftScope && deleteWorkspaceDraft && typeof draftId === "string") {
            deleteWorkspaceDraft(projectPath, draftId);
            return;
          }

          updatePersistedState(getInputKey(pendingScopeId), "");
          updatePersistedState(getInputAttachmentsKey(pendingScopeId), undefined);
        };

        // Sync preferences before switching (keeps workspace settings consistent).
        syncCreationPreferences(projectPath, metadata.id);

        // Switch to the workspace immediately after creation unless the user navigated away
        // from the draft that initiated the creation (avoid yanking focus to the new workspace).
        const shouldAutoNavigate =
          !isDraftScope ||
          (() => {
            if (!isMountedRef.current) return false;
            const latestRoute = latestRouteRef.current;
            if (latestRoute.currentWorkspaceId) return false;
            return latestRoute.pendingDraftId === draftId;
          })();

        // Navigate before staging: stageAttachment waits for runtime init, which
        // can take minutes on deferred runtimes (Coder/SSH/devcontainer). The
        // optimistic pending-send state is cleared below if staging fails.
        // Lock the mounted composer for that window so a user send cannot
        // leapfrog the initial message; the finally below unlocks on all paths.
        if (pendingFilesToStage.length > 0) {
          lockInitialStaging(metadata.id);
        }
        onWorkspaceCreated(metadata, {
          autoNavigate: shouldAutoNavigate,
          pendingStreamModel: shouldAutoNavigate ? baseModel : null,
          markPendingInitialSend: initialSlashCommand == null,
        });

        if (typeof draftId === "string" && draftId.trim().length > 0 && promoteWorkspaceDraft) {
          // UI-only: show the created workspace in-place where the draft was rendered.
          promoteWorkspaceDraft(projectPath, draftId, metadata);
        }

        // Persistently clear the draft as soon as the workspace exists so a refresh
        // during the initial send can't resurrect the draft entry in the sidebar.
        clearPendingDraft();

        // Stage pending files now that the worktree exists on disk, before the
        // first send so the attached-files notice can reference real staged paths.
        const stagingOutcome =
          pendingFilesToStage.length > 0
            ? await stagePendingFiles(api, metadata.id, pendingFilesToStage)
            : { staged: [], failures: [] };
        const stagingFailed = stagingOutcome.failures.length > 0;

        // SendMessageOptions.muxMetadata is a black box (z.any); the creation
        // caller only ever passes XumMessageMetadata built in ChatInput.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const overrideMuxMetadata: MuxMessageMetadata | undefined = optionsOverride?.muxMetadata;
        const overrideRawCommand =
          overrideMuxMetadata &&
          "rawCommand" in overrideMuxMetadata &&
          typeof overrideMuxMetadata.rawCommand === "string"
            ? overrideMuxMetadata.rawCommand
            : null;

        if (stagingFailed) {
          workspaceStore.clearPendingInitialSendState(metadata.id);
          // Fail closed: a partial notice would misrepresent the workspace
          // contents. Transfer the draft (staged results kept, failed files
          // still pending) so the user can retry from the workspace composer.
          // For slash-skill sends messageText is the rewritten skill text;
          // restore the original typed command from rawCommand so the retry
          // re-invokes the skill.
          transferDraftToWorkspace(
            metadata.id,
            overrideRawCommand ?? messageText,
            [
              ...filePartsToChatAttachments(fileParts ?? [], `${Date.now()}-transferred`),
              ...replacePendingFilesWithStaged(pendingFilesToStage, stagingOutcome.staged),
            ],
            optionsOverride?.disableWorkspaceAgents === true
          );
          updatePersistedState(getPendingWorkspaceSendErrorKey(metadata.id), {
            type: "unknown",
            raw: formatPendingFileStagingError(stagingOutcome.failures),
          } satisfies SendMessageError);
          setIsSending(false);
          return { success: false };
        }

        if (initialSlashCommand) {
          await initialAiSettingsPersisted;
          const commandEnv: SlashCommandEnv = {
            api,
            workspaceId: metadata.id,
            variant: "workspace",
            projectPath: metadata.projectPath,
            rawInput: messageText,
            dynamicWorkflowsEnabled,
            sendMessageOptions,
          };
          // Creation owns only toast state; composer actions intentionally remain local to ChatInput.
          const applyCommandActions = (actions: CommandAction[]) => {
            for (const action of actions) {
              if (action.type === "show-toast") setToast(action.toast);
            }
          };
          let commandResult = await processSlashCommand(initialSlashCommand, commandEnv);
          while (commandResult.kind === "phase") {
            applyCommandActions(commandResult.actions);
            commandResult = await commandResult.continue();
          }
          applyCommandActions(commandResult.actions);
          if (commandResult.backgroundTask) {
            void commandResult.backgroundTask().then(applyCommandActions);
          }
          setIsSending(false);

          if (commandResult.inputDisposition !== "consume") {
            workspaceStore.clearPendingInitialSendState(metadata.id);
            return { success: false };
          }

          if (initialSlashCommand.type === "goal-set") {
            const openGoalTab = () => {
              window.dispatchEvent(
                createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: metadata.id })
              );
            };
            if (typeof window.requestAnimationFrame === "function") {
              window.requestAnimationFrame(openGoalTab);
            } else {
              openGoalTab();
            }
          }
          return { success: true };
        }

        setIsSending(false);

        // Wait for the initial send result so we can surface errors.
        const additionalSystemInstructions = [
          sendMessageOptions.additionalSystemInstructions,
          optionsOverride?.additionalSystemInstructions,
        ]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join("\n\n");

        // Skill metadata was built before staging, so its rawCommand (preferred
        // over message text for transcript display) lacks the notice; patch it
        // so the displayed message keeps the staged attachment chips.
        const muxMetadataWithNotice =
          stagingOutcome.staged.length > 0 && overrideMuxMetadata && overrideRawCommand !== null
            ? {
                ...overrideMuxMetadata,
                rawCommand: appendStagedAttachmentNotice(overrideRawCommand, stagingOutcome.staged),
              }
            : overrideMuxMetadata;

        // A transport-level rejection (e.g. oRPC disconnect) must flow through
        // the same failure branch as success:false: the outer catch would skip
        // the staged-draft transfer and the creation draft is already cleared.
        const sendResult = await api.workspace
          .sendMessage({
            workspaceId: metadata.id,
            message: appendStagedAttachmentNotice(messageText, stagingOutcome.staged),
            options: {
              ...sendMessageOptions,
              ...optionsOverride,
              ...(muxMetadataWithNotice ? { muxMetadata: muxMetadataWithNotice } : {}),
              additionalSystemInstructions: additionalSystemInstructions.length
                ? additionalSystemInstructions
                : undefined,
              fileParts: fileParts && fileParts.length > 0 ? fileParts : undefined,
            },
          })
          .catch((sendErr: unknown): { success: false; error: SendMessageError } => ({
            success: false,
            error: { type: "unknown", raw: getErrorMessage(sendErr) },
          }));

        if (!sendResult.success) {
          if (createdWorkspaceId) {
            workspaceStore.clearPendingInitialSendState(createdWorkspaceId);
          }
          if (stagingOutcome.staged.length > 0) {
            // The creation draft was already cleared; without a transferred
            // draft the staged files would sit in the workspace with no
            // chips/notice to retry the send with.
            transferDraftToWorkspace(
              metadata.id,
              overrideRawCommand ?? messageText,
              [
                ...filePartsToChatAttachments(fileParts ?? [], `${Date.now()}-transferred`),
                ...stagingOutcome.staged,
              ],
              optionsOverride?.disableWorkspaceAgents === true
            );
          }
          if (sendResult.error) {
            // Persist the failure so the workspace view can surface a toast after navigation.
            updatePersistedState(getPendingWorkspaceSendErrorKey(metadata.id), sendResult.error);
          }
          return { success: false, error: sendResult.error };
        }

        return { success: true };
      } catch (err) {
        if (createdWorkspaceId) {
          workspaceStore.clearPendingInitialSendState(createdWorkspaceId);
        }
        const errorMessage = getErrorMessage(err);
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: `Failed to create workspace: ${errorMessage}`,
        });
        setIsSending(false);
        return { success: false };
      } finally {
        if (createdWorkspaceId) {
          unlockInitialStaging(createdWorkspaceId);
        }
      }
    },
    [
      kind,
      api,
      isSending,
      projectPath,
      projectScopeId,
      getProjectConfig,
      projectsLoading,
      onWorkspaceCreated,
      settings.selectedRuntime,
      runtimeAvailabilityState,
      setSelectedRuntime,
      settings.agentId,
      settings.model,
      settings.thinkingLevel,
      settings.reasoningMode,
      settings.trunkBranch,
      waitForGeneration,
      workspaceNameState.autoGenerate,
      workspaceNameState.name,
      subProjectPath,
      dynamicWorkflowsEnabled,
      draftId,
      promoteWorkspaceDraft,
      deleteWorkspaceDraft,
      providersConfig,
    ]
  );

  const trustDialog = trustPrompt
    ? createElement(ConfirmationModal, {
        isOpen: true,
        title: "Trust this project?",
        description:
          "Creating a workspace will execute repository scripts. Only trust projects from sources you trust.",
        warning:
          "This includes .xum/init, .xum/tool_env, .xum/tool_pre, .xum/tool_post, and git hooks.",
        confirmLabel: "Trust and continue",
        cancelLabel: "Don't create",
        onConfirm: async () => {
          try {
            if (!api) throw new Error("API not available");
            await api.projects.setTrust({
              projectPath: trustPrompt.projectPath,
              trusted: true,
            });
            // Trust persisted — resolve immediately. Refresh is best-effort
            // so a transient failure doesn't block workspace creation.
            trustPrompt.resolve(true);
            setTrustPrompt(null);
            refreshProjects().catch(() => {
              // best-effort — trust was already persisted
            });
          } catch {
            // Trust API failed — abort creation and notify user
            trustPrompt.resolve(false);
            setTrustPrompt(null);
            setToast({
              id: Date.now().toString(),
              type: "error",
              message: "Failed to trust project. Please try again.",
            });
          }
        },
        onCancel: () => {
          trustPrompt.resolve(false);
          setTrustPrompt(null);
        },
      })
    : null;

  return {
    branches,
    branchesLoaded,
    trunkBranch: settings.trunkBranch,
    setTrunkBranch,
    selectedRuntime: settings.selectedRuntime,
    coderConfigFallback,
    sshHostFallback,
    defaultRuntimeMode: settings.defaultRuntimeMode,
    setSelectedRuntime,
    setDefaultRuntimeChoice,
    toast,
    setToast,
    isSending,
    handleSend,
    // Workspace name/title state (for CreationControls)
    nameState: workspaceNameState,
    // The confirmed identity being used for creation (null until generation resolves)
    creatingWithIdentity,
    // Reload branches (e.g., after git init)
    reloadBranches: loadBranches,
    // Runtime availability state for each mode
    runtimeAvailabilityState,
    trustDialog,
  };
}
