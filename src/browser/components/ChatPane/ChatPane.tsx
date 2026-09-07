import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useDeferredValue,
  useMemo,
} from "react";
import { Lightbulb } from "lucide-react";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { cn } from "@/common/lib/utils";
import { ChatInstructionsChatDecoration } from "@/browser/components/InstructionsTab/AdditionalSystemContextScratchpad";
import { MessageRenderer } from "@/browser/features/Messages/MessageRenderer";
import { WorkBundleMessage } from "@/browser/features/Messages/WorkBundleMessage";
import { OperationalBundleMessage } from "@/browser/features/Messages/OperationalBundleMessage";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { useTranscriptContextMenu } from "@/browser/features/Messages/useTranscriptContextMenu";
import type { UserMessageNavigation } from "@/browser/features/Messages/UserMessage";
import { InterruptedBarrier } from "@/browser/features/Messages/ChatBarrier/InterruptedBarrier";
import { useResumeStream } from "@/browser/hooks/useResumeStream";
import { EditCutoffBarrier } from "@/browser/features/Messages/ChatBarrier/EditCutoffBarrier";
import { StreamingBarrier } from "@/browser/features/Messages/ChatBarrier/StreamingBarrier";
import { RetryBarrier } from "@/browser/features/Messages/ChatBarrier/RetryBarrier";
import { PinnedTodoList } from "../PinnedTodoList/PinnedTodoList";
import { ChatInputDecorationStackLane, TranscriptTailStackLane } from "./LayoutStackLane";
import { computeChatViewReveal, useChatViewDataReady } from "./useChatViewDataReady";
import { TranscriptHydrationSkeleton } from "./TranscriptHydrationSkeleton";
import {
  createChatInputDecorationStackItem,
  createTranscriptTailStackItem,
  selectVisibleChatInputDecorations,
  type ChatInputDecorationStackItem,
  type TranscriptTailStackItem,
} from "./layoutStack";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { ChatInput, type ChatInputAPI } from "@/browser/features/ChatInput/index";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import {
  shouldShowInterruptedBarrier,
  mergeConsecutiveStreamErrors,
  computeBashOutputGroupInfos,
  shouldBypassDeferredMessages,
} from "@/browser/utils/messages/messageUtils";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { BashCollapsedSummaryModeProvider } from "@/browser/features/Tools/BashCollapsedSummaryModeContext";
import { BashOutputCollapsedIndicator } from "@/browser/features/Tools/BashOutputCollapsedIndicator";
import {
  getInterruptionContext,
  getLastMainRetryCandidateMessage,
  getLastNonDecorativeMessage,
  isPreTokenInterruptedUserTurn,
} from "@/common/utils/messages/retryEligibility";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useAutoScroll } from "@/browser/hooks/useAutoScroll";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceAggregator,
  useWorkspaceState,
  useWorkspaceUsage,
  useWorkspaceStoreRaw,
} from "@/browser/stores/WorkspaceStore";
import { WorkspaceMenuBar } from "../WorkspaceMenuBar/WorkspaceMenuBar";
import { WorkspaceFooterBar } from "./WorkspaceFooterBar";
import type { DisplayedMessage, QueuedMessage as QueuedMessageData } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useAIViewKeybinds } from "@/browser/hooks/useAIViewKeybinds";
import { QueuedMessage } from "@/browser/features/Messages/QueuedMessage";
import { CompactionWarning } from "../CompactionWarning/CompactionWarning";
import { ContextSwitchWarning as ContextSwitchWarningBanner } from "../ContextSwitchWarning/ContextSwitchWarning";
import {
  ConcurrentLocalWarningDecoration,
  useConcurrentLocalStreamingWorkspaceName,
} from "../ConcurrentLocalWarning/ConcurrentLocalWarning";
import { SubAgentTasksDecoration } from "../SubAgentTasksDecoration/SubAgentTasksDecoration";
import { BackgroundProcessesBanner } from "../BackgroundProcessesBanner/BackgroundProcessesBanner";
import { checkAutoCompaction } from "@/common/utils/compaction/autoCompactionCheck";
import { cancelCompaction } from "@/browser/utils/compaction/handler";
import type { ContextSwitchWarning } from "@/browser/utils/compaction/contextSwitchCheck";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "../../hooks/useAutoCompactionSettings";
import { useContextSwitchWarning } from "@/browser/hooks/useContextSwitchWarning";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import { useAPI } from "@/browser/contexts/API";
import { useChatTranscriptFullWidth } from "@/browser/hooks/useChatTranscriptFullWidth";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import {
  ChatDockColumnProvider,
  ChatDockSurface,
  useChatDockColumnWidthClass,
} from "./chatDockColumn";
import { useTranscriptDensity } from "@/browser/hooks/useTranscriptDensity";
import { useReviews } from "@/browser/hooks/useReviews";
import { ReviewsBanner } from "../ReviewsBanner/ReviewsBanner";
import type { ReviewNoteData } from "@/common/types/review";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  useBackgroundBashActions,
  useBackgroundBashError,
} from "@/browser/contexts/BackgroundBashContext";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import {
  buildEditingStateFromDisplayed,
  canEditDisplayedUserMessage,
  normalizeQueuedMessage,
  type EditingMessageState,
} from "@/browser/utils/chatEditing";
import {
  computeOperationalBundleInfos,
  computeWorkBundleInfos,
} from "@/browser/utils/messages/transcriptRenderProjection";
import { isBlockedPreStreamTaskStatus } from "@/browser/utils/ui/workspaceFiltering";
import { PerfRenderMarker } from "@/browser/utils/perf/PerfRenderMarker";
import {
  CUSTOM_EVENTS,
  type CustomEventType,
  type CustomEventPayloads,
} from "@/common/constants/events";

const TRANSCRIPT_ONLY_NOTICE =
  "This workspace's worktree is no longer available. This is a read-only chat transcript kept for historical and usage-tracking reasons.";

function findTailProposePlanToolId(messages: readonly DisplayedMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "tool") {
      continue;
    }
    return message.toolName === "propose_plan" ? message.id : null;
  }

  return null;
}

function isPixelSnapshotEnvironment(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // Keep production behavior unchanged while suppressing story-only snapshot churn.
  const isStorybookPreview = window.location.pathname.endsWith("iframe.html");
  if (!isStorybookPreview) {
    return false;
  }

  // Inline the check instead of importing isPixel() from @coder/pixel-storybook:
  // that package is a devDependency and must not enter the production bundle.
  return typeof (window as Window & { __PIXEL__?: object }).__PIXEL__ === "object";
}

interface ChatPaneProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  onOpenTerminal: (options?: TerminalSessionCreateOptions) => void;
  /** Hide + inactivate chat pane while immersive review overlay is active. */
  immersiveHidden?: boolean;
}

type ChatPaneContentProps = Omit<
  ChatPaneProps,
  "leftSidebarCollapsed" | "onToggleLeftSidebarCollapsed" | "immersiveHidden"
>;

type ReviewsState = ReturnType<typeof useReviews>;

// Bottom-stick is owned by native CSS scroll anchoring (see useAutoScroll). While
// locked, the transcript content opts OUT of anchoring so the only eligible anchor
// is the 0-height bottom sentinel; the browser then keeps that sentinel pinned as
// rows/tokens/the streaming barrier append above it — no per-frame scrollTop chase.
// When unlocked (manual reading) we drop this so the browser anchors to an onscreen
// row and preserves the reading position while off-screen content above settles.
const TRANSCRIPT_CONTENT_NO_ANCHOR_STYLE = { overflowAnchor: "none" } as const;
// The sentinel is the sole anchor candidate while locked.
const TRANSCRIPT_BOTTOM_SENTINEL_STYLE = { overflowAnchor: "auto" } as const;
// The composer dock is normal scroll content (sticky to the scrollport bottom),
// so the transcript's bottom clearance is reserved by flow layout in the SAME
// layout pass a decoration/textarea height change happens — there is no
// measured channel (the old --composer-h ResizeObserver) that could lag actual
// layout by a frame and tear. The dock must never be a scroll-anchoring
// candidate: while locked the sentinel owns anchoring, and while released the
// browser must anchor to a transcript row, not the sticky dock.
const COMPOSER_DOCK_STYLE = { overflowAnchor: "none" } as const;

function findTranscriptMessageElement(
  scrollContainer: HTMLElement,
  historyId: string
): HTMLElement | undefined {
  return Array.from(scrollContainer.querySelectorAll<HTMLElement>("[data-message-id]")).find(
    (element) => element.getAttribute("data-message-id") === historyId
  );
}

const TIMELINE_REVEAL_HIGHLIGHT_CLASS = "timeline-reveal-highlight";

function findTranscriptRevealElement(
  scrollContainer: HTMLElement,
  anchor: CustomEventPayloads[typeof CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR]
): HTMLElement | undefined {
  if (anchor.toolCallId) {
    const toolElement = Array.from(
      scrollContainer.querySelectorAll<HTMLElement>("[data-tool-call-id]")
    ).find((element) => element.dataset.toolCallId === anchor.toolCallId);
    if (toolElement) {
      return toolElement;
    }
  }

  return anchor.messageId
    ? findTranscriptMessageElement(scrollContainer, anchor.messageId)
    : undefined;
}

function findTimelineRevealMessageIndex(
  messages: readonly DisplayedMessage[],
  anchor: CustomEventPayloads[typeof CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR]
): number {
  if (anchor.toolCallId) {
    const toolIndex = messages.findIndex(
      (message) => message.type === "tool" && message.toolCallId === anchor.toolCallId
    );
    if (toolIndex >= 0) {
      return toolIndex;
    }
  }

  return anchor.messageId
    ? messages.findIndex(
        (message) => "historyId" in message && message.historyId === anchor.messageId
      )
    : -1;
}

export const ChatPane: React.FC<ChatPaneProps> = (props) => {
  const workspaceId = props.workspaceId;
  const immersiveHidden = props.immersiveHidden ?? false;
  const { workspaceMetadata } = useWorkspaceContext();
  const chatAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chatPaneElement = chatAreaRef.current;
    if (!chatPaneElement) {
      return;
    }

    if (immersiveHidden) {
      chatPaneElement.setAttribute("inert", "");
    } else {
      chatPaneElement.removeAttribute("inert");
    }

    return () => {
      chatPaneElement.removeAttribute("inert");
    };
  }, [immersiveHidden, workspaceId]);

  const meta = workspaceMetadata.get(workspaceId);
  const workspaceTitle = meta?.title ?? meta?.name ?? props.workspaceName;

  return (
    <PerfRenderMarker id="chat-pane">
      <div
        ref={chatAreaRef}
        aria-hidden={immersiveHidden || undefined}
        // Tells the app root that this column ends in a row (WorkspaceFooterBar) which reserves the
        // bottom safe-area inset itself. Dropped while hidden so the inset stays with the root for
        // whatever replaces the column.
        data-bottom-inset-owner={immersiveHidden ? undefined : true}
        className={cn(
          "bg-surface-primary relative flex min-w-96 flex-1 flex-col",
          // Immersive review overlays the entire workspace, so hiding the chat pane removes
          // its layout cost while preserving component state for the return transition.
          immersiveHidden && "hidden",
          "[@media(max-width:768px)]:max-h-full [@media(max-width:768px)]:w-full",
          "[@media(max-width:768px)]:min-w-0"
        )}
      >
        <PerfRenderMarker id="chat-pane.header">
          <WorkspaceMenuBar
            workspaceId={workspaceId}
            projectName={props.projectName}
            projectPath={props.projectPath}
            workspaceName={props.workspaceName}
            workspaceTitle={workspaceTitle}
            leftSidebarCollapsed={props.leftSidebarCollapsed}
            onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
            namedWorkspacePath={props.namedWorkspacePath}
            runtimeConfig={props.runtimeConfig}
            onOpenTerminal={props.onOpenTerminal}
          />
        </PerfRenderMarker>

        <ChatPaneContent
          workspaceId={workspaceId}
          projectPath={props.projectPath}
          projectName={props.projectName}
          workspaceName={props.workspaceName}
          namedWorkspacePath={props.namedWorkspacePath}
          runtimeConfig={props.runtimeConfig}
          onOpenTerminal={props.onOpenTerminal}
        />

        {/* Reset the footer's scroll and popover state because ChatPane remains mounted across
            workspace switches. */}
        <WorkspaceFooterBar
          key={workspaceId}
          workspaceId={workspaceId}
          projectName={props.projectName}
          projectPath={props.projectPath}
          workspaceName={props.workspaceName}
          namedWorkspacePath={props.namedWorkspacePath}
          runtimeConfig={props.runtimeConfig}
        />
      </div>
    </PerfRenderMarker>
  );
};

const ChatPaneContent: React.FC<ChatPaneContentProps> = (props) => {
  const {
    workspaceId,
    projectPath,
    projectName,
    workspaceName,
    namedWorkspacePath,
    runtimeConfig,
    onOpenTerminal,
  } = props;
  const workspaceState = useWorkspaceState(workspaceId);
  const chatTranscriptFullWidth = useChatTranscriptFullWidth();
  const [transcriptDensity] = useTranscriptDensity();
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceContext();
  const storeRaw = useWorkspaceStoreRaw();
  const aggregator = useWorkspaceAggregator(workspaceId);
  const workspaceUsage = useWorkspaceUsage(workspaceId);
  const reviews = useReviews(workspaceId);
  const { autoBackgroundOnSend } = useBackgroundBashActions();
  const { clearError: clearBackgroundBashError } = useBackgroundBashError();

  // Transcript-only workspaces preserve historical chat and usage after the worktree is deleted,
  // so the transcript stays readable while new sends remain disabled.
  const meta = workspaceMetadata.get(workspaceId);
  const hasRepository = hasWorkspaceRepository(meta);
  const transcriptOnly = meta?.transcriptOnly ?? false;
  const isPreStreamAgentTask =
    Boolean(meta?.parentWorkspaceId) && isBlockedPreStreamTaskStatus(meta?.taskStatus);
  const preStreamAgentTaskLabel = meta?.taskStatus === "starting" ? "Starting" : "Queued";
  const queuedAgentTaskPrompt =
    isPreStreamAgentTask &&
    typeof meta?.taskPrompt === "string" &&
    meta.taskPrompt.trim().length > 0
      ? meta.taskPrompt
      : null;
  const shouldShowQueuedAgentTaskPrompt =
    Boolean(queuedAgentTaskPrompt) && (workspaceState?.messages.length ?? 0) === 0;
  const concurrentLocalStreamingWorkspaceName = useConcurrentLocalStreamingWorkspaceName({
    workspaceId,
    projectPath,
    runtimeConfig,
  });

  const { has1MContext } = useProviderOptions();
  // Resolve 1M context per-model (uses the pending model for the current workspace)
  const pendingSendOptions = useSendMessageOptions(workspaceId);
  const pendingModel = pendingSendOptions.model;
  const use1M = has1MContext(pendingModel);

  const { config: providersConfig } = useProvidersConfig();

  // First-paint readiness barrier: all decoration data sources known (or the
  // resilience deadline passed). Gates the reveal so decorations can't pop in
  // after the transcript is visible.
  const chatViewDataReady = useChatViewDataReady(workspaceId);

  const { threshold: autoCompactionThreshold, rolloverEnabled } = useAutoCompactionSettings(
    workspaceId,
    pendingModel
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    // Keep backend session threshold in sync with the persisted per-model slider value.
    const normalizedThreshold = Math.max(0.1, Math.min(1, autoCompactionThreshold / 100));
    void api.workspace.setAutoCompactionThreshold({
      workspaceId,
      threshold: normalizedThreshold,
    });
  }, [api, workspaceId, autoCompactionThreshold]);

  const [queuedActionErrorState, setQueuedActionErrorState] = useState<{
    workspaceId: string;
    messageId: string;
    error: string;
  } | null>(null);
  const queuedActionError =
    queuedActionErrorState?.workspaceId === workspaceId &&
    queuedActionErrorState.messageId === workspaceState?.queuedMessage?.id
      ? queuedActionErrorState.error
      : null;

  const [editingState, setEditingState] = useState(() => ({
    workspaceId,
    message: undefined as EditingMessageState | undefined,
  }));
  const editingMessage =
    editingState.workspaceId === workspaceId ? editingState.message : undefined;
  const setEditingMessage = useCallback(
    (message: EditingMessageState | undefined) => {
      setEditingState({
        workspaceId,
        message: transcriptOnly ? undefined : message,
      });
    },
    [workspaceId, transcriptOnly]
  );

  // Transcript-only workspaces swap the composer for a read-only notice, so clear any
  // stale edit state instead of leaving the transcript stuck at an edit cutoff.
  useEffect(() => {
    if (transcriptOnly && editingMessage) {
      setEditingState({ workspaceId, message: undefined });
    }
  }, [editingMessage, transcriptOnly, workspaceId]);

  // Track which bash_output groups are expanded (keyed by first message ID)
  const [expandedBashGroups, setExpandedBashGroups] = useState<Set<string>>(new Set());

  const [workBundleExpansionOverrides, setWorkBundleExpansionOverrides] = useState<
    Map<string, boolean>
  >(new Map());

  const [operationalBundleExpansionOverrides, setOperationalBundleExpansionOverrides] = useState<
    Map<string, boolean>
  >(new Map());

  // Extract state from workspace state

  // Keep a ref to the latest workspace state so event handlers (passed to memoized children)
  // can stay referentially stable during streaming while still reading fresh data.
  const workspaceStateRef = useRef(workspaceState);
  useEffect(() => {
    workspaceStateRef.current = workspaceState;
  }, [workspaceState]);
  const {
    messages,
    canInterrupt,
    isCompacting,
    isStreamStarting,
    loading,
    isHydratingTranscript,
    isTranscriptCaughtUp,
    hasOlderHistory,
    loadingOlderHistory,
    activeBashMonitorCount,
  } = workspaceState;
  const shouldShowPinnedTodoList = workspaceState.todos.length > 0;
  const shouldShowReviewsBanner = reviews.reviews.length > 0;
  const shouldRenderLoadOlderMessagesButton = hasOlderHistory && !isPixelSnapshotEnvironment();
  const loadOlderMessagesShortcutLabel = formatKeybind(KEYBINDS.LOAD_OLDER_MESSAGES);

  const {
    warning: contextSwitchWarning,
    handleModelChange,
    handleCompact: handleContextSwitchCompact,
    handleDismiss: handleContextSwitchDismiss,
  } = useContextSwitchWarning({
    workspaceId,
    messages,
    pendingModel,
    use1M,
    workspaceUsage,
    api: api ?? undefined,
    pendingSendOptions,
    providersConfig,
  });

  // Apply message transformations:
  // 1. Merge consecutive identical stream errors
  // (bash_output grouping is done at render-time, not as a transformation)
  // Use useDeferredValue to allow React to defer the heavy message list rendering
  // during rapid updates (streaming), keeping the UI responsive.
  // Must be defined before any early returns to satisfy React Hooks rules.
  const transformedMessages = useMemo(() => mergeConsecutiveStreamErrors(messages), [messages]);
  const immediateMessageSnapshot = useMemo(
    () => ({ workspaceId, messages: transformedMessages }),
    [workspaceId, transformedMessages]
  );
  const deferredMessageSnapshot = useDeferredValue(immediateMessageSnapshot);

  // CRITICAL: Show immediate messages when streaming or when message count changes.
  // useDeferredValue can defer indefinitely if React keeps getting new work (rapid deltas).
  // During active streaming (reasoning, text), we MUST show immediate updates or the UI
  // appears frozen while only the token counter updates (reads aggregator directly).
  // Also bypass the deferred snapshot when it still belongs to the previous workspace so
  // chat switches cannot briefly render stale transcript rows from the old workspace.
  const shouldBypassDeferral = shouldBypassDeferredMessages(
    immediateMessageSnapshot.messages,
    deferredMessageSnapshot.messages,
    {
      immediateWorkspaceId: workspaceId,
      deferredWorkspaceId: deferredMessageSnapshot.workspaceId,
    }
  );
  const deferredMessages = shouldBypassDeferral
    ? immediateMessageSnapshot.messages
    : deferredMessageSnapshot.messages;

  const latestMessageId = getLastNonDecorativeMessage(deferredMessages)?.id ?? null;
  const messageListContextValue = useMemo(
    () => ({
      workspaceId,
      latestMessageId,
      openTerminal: onOpenTerminal,
    }),
    [workspaceId, latestMessageId, onOpenTerminal]
  );

  const taskReportLinking = useMemo(
    () => computeTaskReportLinking(deferredMessages),
    [deferredMessages]
  );

  // Precompute bash_output grouping once per message snapshot so row rendering stays O(n).
  const bashOutputGroupInfos = useMemo(
    () => computeBashOutputGroupInfos(deferredMessages),
    [deferredMessages]
  );

  const workBundleInfos = useMemo(
    () => (transcriptDensity === "hyper" ? computeWorkBundleInfos(deferredMessages) : undefined),
    [deferredMessages, transcriptDensity]
  );

  const operationalBundleInfos = useMemo(
    () =>
      computeOperationalBundleInfos(deferredMessages, {
        isTurnActive: isStreamStarting || canInterrupt,
        taskAwaitPollsOnly: transcriptDensity !== "hyper",
      }),
    [canInterrupt, deferredMessages, isStreamStarting, transcriptDensity]
  );

  // A tail propose_plan usually means the agent paused for user review; reveal only the
  // containing hyper-density bundles by default so historical plans stay collapsed.
  const tailProposePlanToolId =
    transcriptDensity === "hyper" ? findTailProposePlanToolId(deferredMessages) : null;
  const tailProposePlanIndex =
    tailProposePlanToolId === null
      ? -1
      : deferredMessages.findIndex((message) => message.id === tailProposePlanToolId);
  const tailProposePlanWorkBundleKey =
    tailProposePlanIndex === -1 ? null : (workBundleInfos?.[tailProposePlanIndex]?.key ?? null);
  const tailProposePlanOperationalBundleKey =
    tailProposePlanIndex === -1
      ? null
      : (operationalBundleInfos?.[tailProposePlanIndex]?.key ?? null);

  const autoCompactionResult = useMemo(
    () =>
      checkAutoCompaction(
        workspaceUsage,
        pendingModel,
        use1M,
        autoCompactionThreshold / 100,
        undefined,
        providersConfig
      ),
    [workspaceUsage, pendingModel, use1M, providersConfig, autoCompactionThreshold]
  );

  // Show warning when: shouldShowWarning flag is true AND not currently compacting.
  // Context-switch warning takes priority so we don't show competing banners.
  const shouldShowCompactionWarning =
    !isCompacting && autoCompactionResult.shouldShowWarning && !contextSwitchWarning;

  // Vim mode state - needed for keybind selection (Ctrl+C in vim, Esc otherwise)
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });

  // Use auto-scroll hook for scroll management
  const {
    contentRef,
    sentinelRef,
    autoScroll,
    disableAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserScrollIntent,
    handleScrollContainerWheel,
    handleScrollContainerMouseDown,
    handleScrollContainerMouseMove,
    handleScrollContainerMouseUp,
    handleScrollContainerKeyDown,
  } = useAutoScroll();

  const [pendingTimelineReveal, setPendingTimelineReveal] = useState<
    CustomEventPayloads[typeof CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR] | null
  >(null);
  const highlightedTimelineElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handleTimelineReveal = (event: Event) => {
      const customEvent = event as CustomEventType<typeof CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR>;
      if (customEvent.detail.workspaceId !== workspaceId) {
        return;
      }
      disableAutoScroll();
      setPendingTimelineReveal(customEvent.detail);
    };

    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, handleTimelineReveal);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, handleTimelineReveal);
    };
  }, [disableAutoScroll, workspaceId]);

  // Store history loads can finish before the deferred transcript renders.
  // Keep the reveal pending while its collapsed bundles expand.
  useLayoutEffect(() => {
    if (!pendingTimelineReveal) {
      return;
    }
    if (pendingTimelineReveal.workspaceId !== workspaceId) {
      setPendingTimelineReveal(null);
      return;
    }

    const targetIndex = findTimelineRevealMessageIndex(deferredMessages, pendingTimelineReveal);
    if (targetIndex < 0) {
      return;
    }

    const bashOutputGroup = bashOutputGroupInfos[targetIndex];
    const bashGroupKey = bashOutputGroup
      ? deferredMessages[bashOutputGroup.firstIndex]?.id
      : undefined;
    if (bashGroupKey && !expandedBashGroups.has(bashGroupKey)) {
      setExpandedBashGroups((current) => new Set(current).add(bashGroupKey));
      return;
    }

    const workBundle = workBundleInfos?.[targetIndex];
    if (workBundle && workBundleExpansionOverrides.get(workBundle.key) !== true) {
      setWorkBundleExpansionOverrides((current) => new Map(current).set(workBundle.key, true));
      return;
    }

    const operationalBundle = operationalBundleInfos?.[targetIndex];
    if (
      operationalBundle &&
      operationalBundleExpansionOverrides.get(operationalBundle.key) !== true
    ) {
      setOperationalBundleExpansionOverrides((current) =>
        new Map(current).set(operationalBundle.key, true)
      );
      return;
    }

    const scrollContainer = contentRef.current;
    const targetElement = scrollContainer
      ? findTranscriptRevealElement(scrollContainer, pendingTimelineReveal)
      : undefined;
    if (!targetElement) {
      return;
    }

    // The highlight marks where the reveal landed and stays until the next reveal replaces it or the
    // pane unmounts. Dismissing it on a timer would coordinate DOM state outside React and can
    // overrun whenever a backgrounded tab throttles timers.
    highlightedTimelineElementRef.current?.classList.remove(TIMELINE_REVEAL_HIGHLIGHT_CLASS);
    highlightedTimelineElementRef.current = targetElement;
    targetElement.classList.add(TIMELINE_REVEAL_HIGHLIGHT_CLASS);
    targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
    setPendingTimelineReveal(null);
  }, [
    bashOutputGroupInfos,
    contentRef,
    deferredMessages,
    expandedBashGroups,
    operationalBundleExpansionOverrides,
    operationalBundleInfos,
    pendingTimelineReveal,
    workBundleExpansionOverrides,
    workBundleInfos,
    workspaceId,
  ]);

  useEffect(() => {
    return () => {
      highlightedTimelineElementRef.current?.classList.remove(TIMELINE_REVEAL_HIGHLIGHT_CLASS);
      highlightedTimelineElementRef.current = null;
    };
  }, [workspaceId]);

  // The composer dock lives inside the scrollport (sticky to its bottom), so
  // mousedown/keydown events from the composer bubble to the transcript
  // handlers. Typing or clicking in the composer is not transcript scroll
  // intent. Wheel/touch are intentionally not filtered because native scroll
  // chaining can move the transcript.
  const composerDockRef = useRef<HTMLDivElement>(null);
  const isComposerDockEvent = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Node && (composerDockRef.current?.contains(target) ?? false);
  }, []);

  const handleTranscriptWheel = handleScrollContainerWheel;

  const handleTranscriptMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isComposerDockEvent(event.target)) {
        return;
      }
      handleScrollContainerMouseDown(event);
    },
    [handleScrollContainerMouseDown, isComposerDockEvent]
  );

  const handleTranscriptTouchMove = markUserScrollIntent;

  const handleTranscriptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isComposerDockEvent(event.target)) {
        return;
      }
      handleScrollContainerKeyDown(event);
    },
    [handleScrollContainerKeyDown, isComposerDockEvent]
  );

  const handleJumpToBottom = jumpToBottom;

  // Handler to navigate (scroll) to a specific message by historyId
  const handleNavigateToMessage = useCallback(
    (historyId: string) => {
      // Disable auto-scroll so the navigation isn't undone by streaming content
      disableAutoScroll();
      requestAnimationFrame(() => {
        const scrollContainer = contentRef.current;
        if (!scrollContainer) return;
        findTranscriptMessageElement(scrollContainer, historyId)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    },
    [contentRef, disableAutoScroll]
  );

  // Precompute per-user navigation objects so MessageRenderer rows receive stable prop
  // references across non-message updates (usage bumps, stats updates, etc.).
  const userMessageNavigationByHistoryId = useMemo(() => {
    const userHistoryIds: string[] = [];
    for (const message of deferredMessages) {
      // Machine wakes and budget warnings should not interrupt navigation between human prompts.
      if (
        message.type === "user" &&
        message.bashMonitorWake == null &&
        message.agentPeerMessageTrigger == null &&
        message.contextBudgetWarning == null
      ) {
        userHistoryIds.push(message.historyId);
      }
    }

    if (userHistoryIds.length < 2) {
      return null;
    }

    const navigationByHistoryId = new Map<string, UserMessageNavigation>();
    for (let index = 0; index < userHistoryIds.length; index++) {
      navigationByHistoryId.set(userHistoryIds[index], {
        prevUserMessageId: index > 0 ? userHistoryIds[index - 1] : undefined,
        nextUserMessageId:
          index < userHistoryIds.length - 1 ? userHistoryIds[index + 1] : undefined,
        onNavigate: handleNavigateToMessage,
      });
    }

    return navigationByHistoryId;
  }, [deferredMessages, handleNavigateToMessage]);

  // ChatInput API for focus management
  const chatInputAPI = useRef<ChatInputAPI | null>(null);

  const handleQuoteText = useCallback((quotedText: string) => {
    chatInputAPI.current?.appendText(quotedText);
    chatInputAPI.current?.focus();
  }, []);

  // Right-clicking transcript text offers quick quote/copy actions,
  // using selection first and hovered text as a fallback when nothing is selected.
  const transcriptContextMenu = useTranscriptContextMenu({
    transcriptRootRef: contentRef,
    onQuoteText: handleQuoteText,
    hasInputTarget: !transcriptOnly,
  });

  // Workspace switches should not leak background bash errors into the newly selected chat.
  useEffect(() => {
    clearBackgroundBashError();
  }, [clearBackgroundBashError, workspaceId]);

  useEffect(() => {
    setEditingState({ workspaceId, message: undefined });
    setExpandedBashGroups(new Set());
    setWorkBundleExpansionOverrides(new Map());
    setOperationalBundleExpansionOverrides(new Map());
    setPendingTimelineReveal(null);
  }, [workspaceId]);

  const handleChatInputReady = useCallback((api: ChatInputAPI) => {
    chatInputAPI.current = api;
  }, []);

  // Handler for review notes from Code Review tab - adds review (starts attached)
  // Depend only on addReview (not whole reviews object) to keep callback stable
  const { addReview, checkReview } = reviews;

  const handleCheckReviews = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        checkReview(id);
      }
    },
    [checkReview]
  );
  const handleReviewNote = useCallback(
    (data: ReviewNoteData) => {
      addReview(data);
      // New reviews start with status "attached" so they appear in chat input immediately
    },
    [addReview]
  );

  // Handlers for editing messages
  const handleEditUserMessage = useCallback(
    (message: EditingMessageState) => {
      setEditingMessage(message);
    },
    [setEditingMessage]
  );

  const restoreQueuedDraft = useCallback(
    async (queuedMessage: QueuedMessageData) => {
      const inputApi = chatInputAPI.current;
      if (!inputApi) return;

      await api?.workspace.clearQueue({ workspaceId });
      inputApi.restoreDraft(normalizeQueuedMessage(queuedMessage));
    },
    [api, workspaceId]
  );

  const handleEditQueuedMessage = useCallback(async () => {
    const queuedMessage = workspaceState?.queuedMessage;
    if (!queuedMessage) return;

    await restoreQueuedDraft(queuedMessage);
  }, [restoreQueuedDraft, workspaceState?.queuedMessage]);

  const sendQueuedImmediatelyInFlightRef = useRef<string | null>(null);

  // The backend can resolve the interrupt RPC before the queued-message-cleared
  // event renders, so keep duplicate send-now attempts blocked until the queued
  // message id changes or clears.
  useEffect(() => {
    const queuedMessageId = workspaceState?.queuedMessage?.id ?? null;
    if (queuedMessageId !== sendQueuedImmediatelyInFlightRef.current) {
      sendQueuedImmediatelyInFlightRef.current = null;
    }
  }, [workspaceState?.queuedMessage?.id]);

  const clearQueuedActionError = () => setQueuedActionErrorState(null);
  const handleQueuedActionError = (error: unknown) => {
    const queuedMessageId = workspaceState?.queuedMessage?.id;
    if (!queuedMessageId) return;
    setQueuedActionErrorState({
      workspaceId,
      messageId: queuedMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  // Handler for sending queued message immediately (interrupt + send)
  const handleSendQueuedImmediately = useCallback(async () => {
    const queuedMessage = workspaceState?.queuedMessage;
    if (
      !api ||
      !queuedMessage ||
      !workspaceState.canInterrupt ||
      sendQueuedImmediatelyInFlightRef.current === queuedMessage.id
    ) {
      return;
    }

    clearQueuedActionError();
    sendQueuedImmediatelyInFlightRef.current = queuedMessage.id;
    // Release the duplicate-send guard only if it still points at this attempt; a
    // newer queued message (or a clear) may have already reset it in the meantime.
    const clearInFlightGuardIfCurrent = () => {
      if (sendQueuedImmediatelyInFlightRef.current === queuedMessage.id) {
        sendQueuedImmediatelyInFlightRef.current = null;
      }
    };
    try {
      // Set "interrupting" state immediately so UI shows "interrupting..." without flash.
      storeRaw.setInterrupting(workspaceId);
      const interruptResult = await api.workspace.interruptStream({
        workspaceId,
        options: { sendQueuedImmediately: true },
      });
      if (!interruptResult.success) {
        clearInFlightGuardIfCurrent();
        throw new Error(interruptResult.error);
      }
    } catch (error) {
      clearInFlightGuardIfCurrent();
      throw error;
    }
  }, [api, workspaceId, workspaceState?.queuedMessage, workspaceState?.canInterrupt, storeRaw]);

  const handleQueuedDispatchModeChange = async (queueDispatchMode: QueueDispatchMode) => {
    clearQueuedActionError();
    if (!api) {
      throw new Error("Workspace API is unavailable.");
    }
    const result = await api.workspace.setQueuedMessageDispatchMode({
      workspaceId,
      queueDispatchMode,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    if (!result.data) {
      throw new Error("The queued message is no longer available.");
    }
  };

  const handleCancelCompactionFromBarrier = useCallback(() => {
    if (!api || !aggregator) {
      return;
    }

    void cancelCompaction(api, workspaceId, aggregator, setEditingMessage);
  }, [api, workspaceId, aggregator, setEditingMessage]);

  const handleEditLastUserMessage = useCallback(async () => {
    if (transcriptOnly) return;

    const current = workspaceStateRef.current;
    if (!current) return;

    if (current.queuedMessage) {
      await restoreQueuedDraft(current.queuedMessage);
      return;
    }

    // Otherwise, edit last user message
    const transformedMessages = mergeConsecutiveStreamErrors(current.messages);
    const lastUserMessage = [...transformedMessages]
      .reverse()
      .find(
        (msg): msg is Extract<DisplayedMessage, { type: "user" }> =>
          msg.type === "user" && canEditDisplayedUserMessage(msg)
      );

    if (!lastUserMessage) {
      return;
    }

    setEditingMessage(buildEditingStateFromDisplayed(lastUserMessage));
    disableAutoScroll(); // Show jump-to-bottom indicator

    // Scroll to the message being edited
    requestAnimationFrame(() => {
      const scrollContainer = contentRef.current;
      if (!scrollContainer) return;
      findTranscriptMessageElement(scrollContainer, lastUserMessage.historyId)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }, [restoreQueuedDraft, contentRef, disableAutoScroll, setEditingMessage, transcriptOnly]);

  const handleEditLastUserMessageClick = useCallback(() => {
    void handleEditLastUserMessage();
  }, [handleEditLastUserMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(undefined);
    // handleEditLastUserMessage disabled auto-scroll to keep the view centered
    // on the edited message. Dismissing the edit hands scroll ownership back to
    // the transcript tail; without this the view stays scrolled up until the
    // user manually returns to the bottom.
    jumpToBottom();
  }, [jumpToBottom, setEditingMessage]);

  const handleMessageSendStarted = useCallback(() => {
    // Re-arm and pin before the send request crosses the IPC boundary. Waiting for
    // send success can be too late because the backend may not resolve until the
    // stream has already produced rows, leaving the first deltas offscreen when the
    // user had previously scrolled up.
    handleJumpToBottom();
  }, [handleJumpToBottom]);

  const handleMessageSent = useCallback(
    (dispatchMode: QueueDispatchMode = "tool-end") => {
      // Only background foreground bashes for "tool-end" sends (Enter).
      // "turn-end" sends (Ctrl/Cmd+Enter) let the stream finish naturally —
      // backgrounding would disrupt a foreground bash the user wants to complete.
      if (dispatchMode === "tool-end") {
        autoBackgroundOnSend();
      }

      // Slash-command send paths still report after backend success; keep this
      // harmless duplicate pin so those paths also re-arm auto-scroll.
      handleJumpToBottom();
    },
    [autoBackgroundOnSend, handleJumpToBottom]
  );

  const handleClearHistory = useCallback(
    async (percentage = 1.0) => {
      // Re-arm the tail before clearing so the empty/starting state owns the bottom.
      handleJumpToBottom();

      // Truncate history in backend
      const result = await api?.workspace.truncateHistory({ workspaceId, percentage });
      // A partial failure (history already deleted but durable cleanup —
      // e.g. sandbox kernel invalidation — failed) carries the only warning
      // that cleared state may reappear after a restart. Throw so callers
      // (slash command, dialogs) surface it instead of reporting success.
      if (result && !result.success) {
        throw new Error(result.error);
      }
    },
    [workspaceId, handleJumpToBottom, api]
  );

  const handleResetContext = useCallback(async (): Promise<"reset" | "noop"> => {
    handleJumpToBottom();

    const result = await api?.workspace.resetContext({ workspaceId });
    if (!result?.success) {
      throw new Error(result?.error ?? "Failed to reset context");
    }
    return result.data;
  }, [workspaceId, handleJumpToBottom, api]);

  const openInEditor = useOpenInEditor();
  const handleOpenInEditor = useCallback(() => {
    void openInEditor(workspaceId, namedWorkspacePath, runtimeConfig);
  }, [workspaceId, namedWorkspacePath, openInEditor, runtimeConfig]);

  // Intentionally no message/todo-driven auto-scroll effect here. Bottom pinning is
  // owned by the scrollport/content ResizeObservers inside `useAutoScroll`, which
  // pins viewport or content-size changes before paint. Calling `performAutoScroll`
  // as a separate double-RAF on every delta used to race the RO pin, occasionally
  // painting one frame at the wrong scrollTop (visible as a brief downward jitter).

  const hasLoadedTranscriptRows = !workspaceState.loading && workspaceState.messages.length > 0;

  // Reset transcript scroll ownership when switching workspaces. `jumpToBottom` both re-arms
  // the ref-backed auto-scroll flag and pins any cached rows before paint; if rows are still
  // hydrating, the next content resize owns the tail instead of showing the prior workspace's state.
  useLayoutEffect(() => {
    handleJumpToBottom();
  }, [hasLoadedTranscriptRows, handleJumpToBottom, workspaceId]);

  // Compute showRetryBarrier once for both keybinds and UI.
  // Track if last message was interrupted or errored (for RetryBarrier).
  const interruption = workspaceState
    ? getInterruptionContext(
        workspaceState.messages,
        workspaceState.pendingStreamStartTime,
        workspaceState.runtimeStatus,
        workspaceState.lastAbortReason
      )
    : null;

  const hasInterruptedStream = interruption?.hasInterruptedStream ?? false;
  const shouldShowStreamingBarrier = isStreamStarting || canInterrupt;
  // An armed background bash monitor means the turn ended but the agent will be
  // woken on matching output. Keep the barrier mounted so StreamingBarrier can
  // show its "waiting on monitor" state instead of the chat looking idle.
  const shouldMountStreamingBarrier = shouldShowStreamingBarrier || activeBashMonitorCount > 0;
  // Keep rendering cached transcript rows during incremental catch-up so workspace switches
  // feel stable, but active stream-start/interrupt states should keep their barrier visible
  // instead of flashing full-height transcript placeholders. The skeleton additionally holds
  // until decoration data sources are known so the transcript and all composer decorations
  // reveal in ONE commit — see useChatViewDataReady for the contract.
  const { showHydrationPlaceholder: showTranscriptHydrationPlaceholder, revealDecorations } =
    computeChatViewReveal({
      isHydratingTranscript,
      chatViewDataReady,
      hasRenderableMessages: deferredMessages.length > 0,
      // Any mounted barrier (including waiting-on-monitor) counts: a cleared
      // transcript with an armed monitor must not flash placeholders under it.
      shouldShowStreamingBarrier: shouldMountStreamingBarrier,
    });
  const showEmptyTranscriptPlaceholder =
    deferredMessages.length === 0 &&
    !showTranscriptHydrationPlaceholder &&
    !shouldMountStreamingBarrier;
  const showRetryBarrier =
    !isHydratingTranscript && !shouldShowStreamingBarrier && hasInterruptedStream;
  const isAutoRetryActive =
    workspaceState.autoRetryStatus?.type === "auto-retry-scheduled" ||
    workspaceState.autoRetryStatus?.type === "auto-retry-starting";

  const lastRetryCandidateMessage = getLastMainRetryCandidateMessage(workspaceState.messages);
  const suppressRetryBarrier =
    lastRetryCandidateMessage?.type === "stream-error" &&
    lastRetryCandidateMessage.errorType === "context_exceeded";
  const shouldMountRetryBarrier = !suppressRetryBarrier;
  const showRetryBarrierUI = showRetryBarrier && !suppressRetryBarrier;

  // Derive inline transcript chrome once so row rendering and layout pinning share the exact same
  // visibility decision. This keeps late interrupted markers from sneaking in through a second code
  // path after hydration or auto-retry state changes.
  const interruptedBarrierMessageIds = new Set<string>();
  for (const message of deferredMessages) {
    if (
      shouldShowInterruptedBarrier(message, {
        isHydratingTranscript,
        isAutoRetryActive,
      })
    ) {
      interruptedBarrierMessageIds.add(message.id);
    }
  }
  // A turn interrupted before its first token leaves the user message as the tail
  // with no assistant row, so the loop above never marks it. Mark it here (subject
  // to the same hydration/auto-retry/streaming suppression) so the divider still
  // offers to continue. interruptedTailResumable/render both key off this set.
  if (
    !isHydratingTranscript &&
    !isAutoRetryActive &&
    !shouldShowStreamingBarrier &&
    lastRetryCandidateMessage != null &&
    isPreTokenInterruptedUserTurn(lastRetryCandidateMessage, workspaceState.lastAbortReason)
  ) {
    interruptedBarrierMessageIds.add(lastRetryCandidateMessage.id);
  }

  // Owned here so the click and keybind paths share one resume/error. resetKey is
  // the resume target, so error/spinner reset when the interrupted turn changes.
  const { resume: resumeInterruptedStreamAsync, error: resumeInterruptedError } = useResumeStream(
    workspaceId,
    lastRetryCandidateMessage?.id
  );
  const resumeInterruptedStream = () => void resumeInterruptedStreamAsync();
  // Resumable only on the writable tail and only when RetryBarrier is suppressed
  // (user-aborted case). When RetryBarrier is visible, its button owns resume.
  const interruptedTailResumable =
    !transcriptOnly &&
    !showRetryBarrierUI &&
    lastRetryCandidateMessage != null &&
    interruptedBarrierMessageIds.has(lastRetryCandidateMessage.id);
  const transcriptTailItems: TranscriptTailStackItem[] = [];
  if (shouldMountRetryBarrier) {
    transcriptTailItems.push(
      createTranscriptTailStackItem({
        key: "retry-barrier",
        node: <RetryBarrier workspaceId={workspaceId} visible={showRetryBarrierUI} />,
      })
    );
  }
  if (shouldMountStreamingBarrier) {
    transcriptTailItems.push(
      createTranscriptTailStackItem({
        key: "streaming-barrier",
        node: (
          <StreamingBarrier
            workspaceId={workspaceId}
            vimEnabled={vimEnabled}
            onCancelCompaction={handleCancelCompactionFromBarrier}
          />
        ),
      })
    );
  }
  if (shouldShowQueuedAgentTaskPrompt) {
    transcriptTailItems.push(
      createTranscriptTailStackItem({
        key: "queued-agent-prompt",
        node: (
          <div className="mt-4 mb-1 ml-auto w-fit max-w-full">
            <div className="rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] px-3 py-2 text-sm">
              <div className="text-muted mb-1 text-[11px] font-medium">
                {preStreamAgentTaskLabel}
              </div>
              <MarkdownRenderer
                content={queuedAgentTaskPrompt ?? ""}
                className="user-message-markdown text-foreground"
                preserveLineBreaks
                style={{ overflowWrap: "break-word", wordBreak: "break-word" }}
              />
            </div>
          </div>
        ),
      })
    );
  }
  const handleLoadOlderHistory = useCallback(() => {
    if (!shouldRenderLoadOlderMessagesButton || loadingOlderHistory) {
      return;
    }

    storeRaw.loadOlderHistory(workspaceId).catch((error) => {
      console.warn(`[ChatPane] Failed to load older history for ${workspaceId}:`, error);
    });
  }, [loadingOlderHistory, shouldRenderLoadOlderMessagesButton, storeRaw, workspaceId]);

  // Handle keyboard shortcuts (using optional refs that are safe even if not initialized)
  useAIViewKeybinds({
    workspaceId,
    // Allow interrupt keybind even while waiting for stream-start ("starting...").
    canInterrupt:
      (workspaceState?.canInterrupt ?? false) || (workspaceState?.isStreamStarting ?? false),
    showRetryBarrier,
    chatInputAPI,
    jumpToBottom: handleJumpToBottom,
    loadOlderHistory: shouldRenderLoadOlderMessagesButton ? handleLoadOlderHistory : null,
    handleOpenTerminal: onOpenTerminal,
    handleOpenInEditor,
    aggregator,
    setEditingMessage,
    vimEnabled,
    canResumeInterruptedStream: interruptedTailResumable,
    resumeInterruptedStream,
  });

  // Clear editing state if the message being edited no longer exists
  // Must be before early return to satisfy React Hooks rules
  useEffect(() => {
    if (!workspaceState || !editingMessage) return;

    const transformedMessages = mergeConsecutiveStreamErrors(workspaceState.messages);
    const editCutoffHistoryId = transformedMessages.find(
      (
        msg
      ): msg is Exclude<
        DisplayedMessage,
        { type: "history-hidden" | "workspace-init" | "compaction-boundary" }
      > =>
        msg.type !== "history-hidden" &&
        msg.type !== "workspace-init" &&
        msg.type !== "compaction-boundary" &&
        msg.historyId === editingMessage.id
    )?.historyId;

    if (!editCutoffHistoryId) {
      // Message was replaced or deleted - clear editing state
      setEditingMessage(undefined);
    }
  }, [workspaceState, editingMessage, setEditingMessage]);

  // When editing, find the cutoff point
  const editCutoffHistoryId = editingMessage
    ? transformedMessages.find(
        (
          msg
        ): msg is Exclude<
          DisplayedMessage,
          { type: "history-hidden" | "workspace-init" | "compaction-boundary" }
        > =>
          msg.type !== "history-hidden" &&
          msg.type !== "workspace-init" &&
          msg.type !== "compaction-boundary" &&
          msg.historyId === editingMessage.id
      )?.historyId
    : undefined;

  // Find the ID of the latest propose_plan tool call for external edit detection
  // Only the latest plan should fetch fresh content from disk
  let latestProposePlanId: string | null = null;
  for (let i = transformedMessages.length - 1; i >= 0; i--) {
    const msg = transformedMessages[i];
    if (msg.type === "tool" && msg.toolName === "propose_plan") {
      latestProposePlanId = msg.id;
      break;
    }
  }

  const setWorkBundleExpanded = (key: string, expanded: boolean) => {
    setWorkBundleExpansionOverrides((prev) => new Map(prev).set(key, expanded));
  };

  const setOperationalBundleExpanded = (key: string, expanded: boolean) => {
    setOperationalBundleExpansionOverrides((prev) => new Map(prev).set(key, expanded));
  };

  const toggleBashOutputGroup = (groupKey: string) => {
    setExpandedBashGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const renderMessageAtIndex = (
    message: DisplayedMessage,
    index: number,
    options: { key: string; className?: string }
  ): React.ReactNode => {
    const bashOutputGroup = bashOutputGroupInfos[index];
    const groupKey = bashOutputGroup ? deferredMessages[bashOutputGroup.firstIndex]?.id : undefined;
    const isGroupExpanded = groupKey ? expandedBashGroups.has(groupKey) : false;

    if (bashOutputGroup?.position === "middle" && !isGroupExpanded) {
      return null;
    }

    const isAtCutoff =
      editCutoffHistoryId !== undefined &&
      message.type !== "history-hidden" &&
      message.type !== "workspace-init" &&
      message.type !== "compaction-boundary" &&
      message.historyId === editCutoffHistoryId;

    const taskReportLinkingForMessage =
      message.type === "tool" && (message.toolName === "task" || message.toolName === "task_await")
        ? taskReportLinking
        : undefined;

    const messageNode = (
      <MessageRenderer
        message={message}
        onEditUserMessage={transcriptOnly ? undefined : handleEditUserMessage}
        workspaceId={workspaceId}
        isCompacting={isCompacting}
        onReviewNote={handleReviewNote}
        isLatestProposePlan={
          message.type === "tool" &&
          message.toolName === "propose_plan" &&
          message.id === latestProposePlanId
        }
        bashOutputGroup={bashOutputGroup}
        taskReportLinking={taskReportLinkingForMessage}
        userMessageNavigation={
          message.type === "user"
            ? userMessageNavigationByHistoryId?.get(message.historyId)
            : undefined
        }
      />
    );

    return (
      <React.Fragment key={options.key}>
        {options.className ? <div className={options.className}>{messageNode}</div> : messageNode}
        {bashOutputGroup?.position === "first" && groupKey && (
          <BashOutputCollapsedIndicator
            processId={bashOutputGroup.processId}
            collapsedCount={bashOutputGroup.collapsedCount}
            isExpanded={isGroupExpanded}
            onToggle={() => toggleBashOutputGroup(groupKey)}
          />
        )}
        {isAtCutoff && <EditCutoffBarrier />}
        {interruptedBarrierMessageIds.has(message.id) && (
          <InterruptedBarrier
            resumable={interruptedTailResumable && message.id === lastRetryCandidateMessage?.id}
            onResume={resumeInterruptedStream}
            error={resumeInterruptedError}
          />
        )}
      </React.Fragment>
    );
  };

  return (
    <>
      <PerfRenderMarker id="chat-pane.transcript">
        {/* Spacer for fixed mobile header - mobile-header-spacer adds padding-top on touch devices.
            The composer dock is IN-FLOW scroll content (sticky to the scrollport
            bottom), so this region — and therefore the scrollport's clientHeight —
            never resizes when the composer grows or shrinks. */}
        <div className="mobile-header-spacer relative flex-1 overflow-hidden">
          <div
            ref={contentRef}
            onWheel={handleTranscriptWheel}
            onMouseDown={handleTranscriptMouseDown}
            onMouseMove={handleScrollContainerMouseMove}
            onMouseUp={handleScrollContainerMouseUp}
            onTouchMove={handleTranscriptTouchMove}
            onKeyDown={handleTranscriptKeyDown}
            onScroll={handleScroll}
            onContextMenu={transcriptContextMenu.onContextMenu}
            tabIndex={0}
            data-testid="message-window"
            // Settled marker for perf tests and story play helpers: includes
            // decoration data readiness so waiting on it observes the chat
            // view's final (post-reveal) layout.
            data-loaded={!loading && !isHydratingTranscript && chatViewDataReady}
            // Browser scroll anchoring stays ENABLED on the scrollport; the
            // overflow-anchor policy lives on the inner content (opt rows out while
            // locked so the bottom sentinel is the sole anchor). No bottom padding:
            // clearance for the composer is the in-flow dock itself, so it is always
            // exact and reserved in the same layout pass as any dock height change.
            // The flex column makes the transcript content stretch (flex-1) so the
            // dock sits at the scrollport bottom even when the transcript is short.
            // The named `transcript` container is what the sticky plan TOC queries
            // for visibility — using a container query rather than a viewport media
            // query means sidebars opening/closing correctly hide the TOC even when
            // the viewport width is unchanged. See `.plan-toc-aside` in globals.css.
            className="@container/transcript flex h-full flex-col overflow-x-hidden overflow-y-auto px-[15px] pt-[15px] leading-[1.5] break-words whitespace-pre-wrap"
          >
            <div
              // While locked, opt the whole transcript subtree out of scroll
              // anchoring so the only anchor candidate is the sibling bottom
              // sentinel below — native anchoring then pins the bottom on append.
              style={autoScroll ? TRANSCRIPT_CONTENT_NO_ANCHOR_STYLE : undefined}
              role="log"
              aria-live={canInterrupt ? "polite" : "off"}
              aria-busy={canInterrupt || isHydratingTranscript}
              aria-label="Conversation transcript"
              className={cn(
                // `plan-toc-aware` opts only the centered max-w transcript into the
                // sticky plan TOC layout. In `chatTranscriptFullWidth` mode the plan
                // already fills the available width, so the TOC would either
                // overlap content or get clipped by `overflow-x-hidden`.
                // `w-full` is required in the centered mode because auto cross-axis
                // margins disable flex-item stretch.
                chatTranscriptFullWidth ? "w-full" : "plan-toc-aware max-w-4xl mx-auto w-full",
                // `flex-1` pushes the dock to the scrollport bottom for short
                // transcripts; `pb-[15px]` keeps the original gap between the last
                // message and the composer.
                "flex-1 pb-[15px]",
                // Only the empty/centered placeholder fills height (as a flex column
                // so the placeholder's flex-1 centering works). The hydration
                // skeleton renders in normal top-aligned transcript flow so it sits
                // where real messages will, avoiding a jump when hydration completes.
                showEmptyTranscriptPlaceholder && "flex flex-col"
              )}
            >
              {showTranscriptHydrationPlaceholder ? (
                <TranscriptHydrationSkeleton />
              ) : showEmptyTranscriptPlaceholder ? (
                <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center [&_h3]:m-0 [&_h3]:mb-2.5 [&_h3]:text-base [&_h3]:font-medium [&_p]:m-0 [&_p]:text-[13px]">
                  <h3>No Messages Yet</h3>
                  <p>Send a message below to begin</p>
                  {hasRepository && (
                    <p className="text-muted mt-5 flex items-start gap-2 text-xs">
                      <Lightbulb aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Tip: Add a{" "}
                        <code className="bg-inline-code-dark-bg text-code-string rounded-[3px] px-1.5 py-0.5 font-mono text-[11px]">
                          .xum/init
                        </code>{" "}
                        hook to your project to run setup commands
                        <br />
                        (e.g., install dependencies, build) when creating new workspaces
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <BashCollapsedSummaryModeProvider>
                  <MessageListProvider value={messageListContextValue}>
                    {shouldRenderLoadOlderMessagesButton && (
                      <div className="flex justify-center py-3">
                        <TooltipIfPresent
                          tooltip={`Load older messages (${loadOlderMessagesShortcutLabel})`}
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={handleLoadOlderHistory}
                            disabled={loadingOlderHistory}
                            className="text-muted hover:text-foreground text-xs underline underline-offset-2 transition-colors disabled:opacity-50"
                          >
                            {loadingOlderHistory ? "Loading..." : "Load older messages"}
                          </button>
                        </TooltipIfPresent>
                      </div>
                    )}
                    {deferredMessages.map((msg, index) => {
                      const workBundle = workBundleInfos?.[index];
                      const operationalBundle = workBundle
                        ? undefined
                        : operationalBundleInfos?.[index];
                      const workBundleOverride = workBundle
                        ? workBundleExpansionOverrides.get(workBundle.key)
                        : undefined;
                      const defaultRevealTailPlanWorkBundle =
                        tailProposePlanWorkBundleKey !== null &&
                        workBundle?.key === tailProposePlanWorkBundleKey;
                      const isWorkBundleExpanded = workBundle
                        ? (workBundleOverride ??
                          (defaultRevealTailPlanWorkBundle || workBundle.defaultExpanded))
                        : false;

                      const keepCollapsedWorkBundleMemberVisible =
                        msg.type === "user" ||
                        (msg.type === "assistant" && workBundle?.position === "final");
                      if (
                        (workBundle?.position === "member" || workBundle?.position === "final") &&
                        (isWorkBundleExpanded || !keepCollapsedWorkBundleMemberVisible)
                      ) {
                        return null;
                      }

                      const renderWorkBundle = workBundle?.position === "head";
                      const renderMessageBeforeWorkBundle = renderWorkBundle && msg.type === "user";
                      const renderMessageAfterWorkBundle = !renderWorkBundle;
                      const operationalBundleOverride = operationalBundle
                        ? operationalBundleExpansionOverrides.get(operationalBundle.key)
                        : undefined;
                      const defaultRevealTailPlanOperationalBundle =
                        tailProposePlanOperationalBundleKey !== null &&
                        operationalBundle?.key === tailProposePlanOperationalBundleKey;
                      const isOperationalBundleExpanded = operationalBundle
                        ? operationalBundle.summary.tone !== undefined ||
                          (operationalBundleOverride ??
                            (defaultRevealTailPlanOperationalBundle ||
                              operationalBundle.defaultExpanded))
                        : false;

                      if (
                        operationalBundle?.position === "member" &&
                        !isOperationalBundleExpanded
                      ) {
                        return null;
                      }

                      const renderOperationalBundle = operationalBundle?.position === "head";
                      const renderMessageAfterOperationalBundle =
                        renderMessageAfterWorkBundle &&
                        (!renderOperationalBundle || isOperationalBundleExpanded);

                      return (
                        <React.Fragment key={`${workspaceId}:${msg.id}`}>
                          {renderMessageBeforeWorkBundle &&
                            renderMessageAtIndex(msg, index, {
                              key: `${workspaceId}:${msg.id}:message`,
                            })}
                          {renderWorkBundle && workBundle && (
                            <WorkBundleMessage
                              item={workBundle}
                              expanded={isWorkBundleExpanded}
                              onToggle={() =>
                                setWorkBundleExpanded(workBundle.key, !isWorkBundleExpanded)
                              }
                            />
                          )}
                          {renderWorkBundle &&
                            workBundle &&
                            isWorkBundleExpanded &&
                            workBundle.entries.map((entry) => {
                              const nestedOperationalBundle =
                                operationalBundleInfos?.[entry.originalIndex];
                              const nestedOverride = nestedOperationalBundle
                                ? operationalBundleExpansionOverrides.get(
                                    nestedOperationalBundle.key
                                  )
                                : undefined;
                              const defaultRevealTailPlanNestedBundle =
                                tailProposePlanOperationalBundleKey !== null &&
                                nestedOperationalBundle?.key ===
                                  tailProposePlanOperationalBundleKey;
                              const isNestedExpanded = nestedOperationalBundle
                                ? nestedOperationalBundle.summary.tone !== undefined ||
                                  (nestedOverride ??
                                    (defaultRevealTailPlanNestedBundle ||
                                      nestedOperationalBundle.defaultExpanded))
                                : false;

                              if (
                                nestedOperationalBundle?.position === "member" &&
                                !isNestedExpanded
                              ) {
                                return null;
                              }

                              const renderNestedBundle =
                                nestedOperationalBundle?.position === "head";
                              const renderNestedMessage = !renderNestedBundle || isNestedExpanded;

                              return (
                                <React.Fragment
                                  key={`${workspaceId}:${workBundle.key}:${entry.message.id}`}
                                >
                                  {renderNestedBundle && nestedOperationalBundle && (
                                    <OperationalBundleMessage
                                      item={nestedOperationalBundle}
                                      expanded={isNestedExpanded}
                                      onToggle={() =>
                                        setOperationalBundleExpanded(
                                          nestedOperationalBundle.key,
                                          !isNestedExpanded
                                        )
                                      }
                                    />
                                  )}
                                  {renderNestedMessage &&
                                    renderMessageAtIndex(entry.message, entry.originalIndex, {
                                      key: `${workspaceId}:${workBundle.key}:${entry.message.id}:message`,
                                    })}
                                </React.Fragment>
                              );
                            })}
                          {renderOperationalBundle && operationalBundle && (
                            <OperationalBundleMessage
                              item={operationalBundle}
                              expanded={isOperationalBundleExpanded}
                              onToggle={() =>
                                setOperationalBundleExpanded(
                                  operationalBundle.key,
                                  !isOperationalBundleExpanded
                                )
                              }
                            />
                          )}
                          {renderMessageAfterOperationalBundle &&
                            renderMessageAtIndex(msg, index, {
                              key: `${workspaceId}:${msg.id}:message`,
                              className: operationalBundle ? "ml-4" : undefined,
                            })}
                        </React.Fragment>
                      );
                    })}
                  </MessageListProvider>
                </BashCollapsedSummaryModeProvider>
              )}
              <TranscriptTailStackLane items={transcriptTailItems} />
            </div>
            {/* Bottom anchor: a 0-height sibling of the transcript content. While
                locked it is the sole `overflow-anchor: auto` element, so native CSS
                scroll anchoring keeps it (and therefore the bottom) pinned as rows
                append above it. It sits between the transcript content and the
                in-flow composer dock: appends grow content ABOVE it (anchoring
                compensates), while dock growth happens BELOW it (covered by the
                scrollport-children ResizeObserver in useAutoScroll, which re-pins
                before paint). */}
            <div
              ref={sentinelRef}
              data-testid="transcript-bottom-sentinel"
              aria-hidden="true"
              className="h-0 w-full"
              style={TRANSCRIPT_BOTTOM_SENTINEL_STYLE}
            />
            <PerfRenderMarker id="chat-pane.input">
              {/* The composer dock is in-flow scroll content stuck to the scrollport
                  bottom: clearance for the last message is reserved by normal flow
                  layout in the same pass as any dock height change (no measured
                  --composer-h channel to lag a frame behind and tear), while
                  `sticky` keeps the composer visually pinned over the transcript
                  when the user scrolls up. `mx-[-15px]` cancels the scrollport's
                  horizontal padding so the dock stays full-bleed; `whitespace-normal
                  break-normal` reset the transcript text inheritance. clientHeight
                  of the scrollport never changes with dock height (send-flash
                  invariant). `bg-surface-primary` keeps transcript content from
                  showing through gaps between decoration banners. */}
              <ChatDockColumnProvider value={chatTranscriptFullWidth}>
                <div
                  ref={composerDockRef}
                  data-testid="chat-composer-dock"
                  className="bg-surface-primary sticky bottom-0 z-10 mx-[-15px] break-normal whitespace-normal"
                  style={COMPOSER_DOCK_STYLE}
                >
                  {!autoScroll && (
                    <button
                      onClick={handleJumpToBottom}
                      type="button"
                      // Sit just above the composer dock (8px gap), tracking its live
                      // height through normal layout instead of a measured offset.
                      className="assistant-chip font-primary text-foreground hover:assistant-chip-hover absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 cursor-pointer rounded-[20px] px-2 py-1 text-xs font-medium shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-[1px] transition-transform duration-200 hover:scale-105 active:scale-95"
                    >
                      Jump to bottom{" "}
                      <span className="mobile-hide-shortcut-hints">
                        ({formatKeybind(KEYBINDS.JUMP_TO_BOTTOM)})
                      </span>
                    </button>
                  )}
                  {transcriptOnly ? (
                    // Transcript-only workspaces keep their historical transcript, but the whole
                    // composer surface is replaced with a single read-only notice.
                    <TranscriptOnlyNoticePane />
                  ) : (
                    <ChatInputPane
                      kind={meta?.kind}
                      workspaceId={workspaceId}
                      projectName={projectName}
                      workspaceName={workspaceName}
                      revealDecorations={revealDecorations}
                      isStreamStarting={isStreamStarting}
                      isTranscriptCaughtUp={isTranscriptCaughtUp}
                      runtimeConfig={runtimeConfig}
                      isPreStreamAgentTask={isPreStreamAgentTask}
                      preStreamAgentTaskStatus={
                        meta?.taskStatus === "starting" ? "starting" : "queued"
                      }
                      isCompacting={isCompacting}
                      shouldShowPinnedTodoList={shouldShowPinnedTodoList}
                      shouldShowReviewsBanner={shouldShowReviewsBanner}
                      concurrentLocalStreamingWorkspaceName={concurrentLocalStreamingWorkspaceName}
                      canInterrupt={canInterrupt}
                      autoCompactionResult={autoCompactionResult}
                      shouldShowCompactionWarning={shouldShowCompactionWarning}
                      rolloverEnabled={rolloverEnabled}
                      contextSwitchWarning={contextSwitchWarning}
                      onContextSwitchCompact={handleContextSwitchCompact}
                      onContextSwitchDismiss={handleContextSwitchDismiss}
                      onModelChange={handleModelChange}
                      onMessageSendStarted={handleMessageSendStarted}
                      onMessageSent={handleMessageSent}
                      onResetContext={handleResetContext}
                      onTruncateHistory={handleClearHistory}
                      editingMessage={editingMessage}
                      onCancelEdit={handleCancelEdit}
                      onEditLastUserMessage={handleEditLastUserMessageClick}
                      onChatInputReady={handleChatInputReady}
                      queuedMessage={workspaceState?.queuedMessage ?? null}
                      onEditQueuedMessage={() => void handleEditQueuedMessage()}
                      onSendQueuedImmediately={
                        workspaceState?.canInterrupt ? handleSendQueuedImmediately : undefined
                      }
                      onQueuedDispatchModeChange={handleQueuedDispatchModeChange}
                      onQueuedActionError={handleQueuedActionError}
                      queuedActionError={queuedActionError}
                      onClearQueuedActionError={clearQueuedActionError}
                      reviews={reviews}
                      onCheckReviews={handleCheckReviews}
                    />
                  )}
                </div>
              </ChatDockColumnProvider>
            </PerfRenderMarker>
          </div>
          {transcriptContextMenu.menu}
        </div>
      </PerfRenderMarker>
    </>
  );
};

const TranscriptOnlyNoticePane: React.FC = () => {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div
      className={cn("bg-surface-primary border-border-light border-t pb-2", CHAT_DOCK_GUTTER_CLASS)}
    >
      <div className={cn("py-4", columnWidthClass)}>
        <p role="note" className="text-muted text-sm leading-6">
          {TRANSCRIPT_ONLY_NOTICE}
        </p>
      </div>
    </div>
  );
};

interface ChatInputPaneProps {
  kind?: "scratch";
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  /**
   * False until the chat view's one-commit reveal (transcript + decorations
   * together). The decoration lane stays empty before that so a decoration
   * can never mount after paint and shift the transcript.
   */
  revealDecorations: boolean;
  runtimeConfig?: RuntimeConfig;
  isPreStreamAgentTask: boolean;
  preStreamAgentTaskStatus: "queued" | "starting";
  isCompacting: boolean;
  isStreamStarting: boolean;
  isTranscriptCaughtUp: boolean;
  shouldShowPinnedTodoList: boolean;
  shouldShowReviewsBanner: boolean;
  concurrentLocalStreamingWorkspaceName: string | null;
  canInterrupt: boolean;
  autoCompactionResult: ReturnType<typeof checkAutoCompaction>;
  shouldShowCompactionWarning: boolean;
  rolloverEnabled: boolean;
  contextSwitchWarning: ContextSwitchWarning | null;
  onContextSwitchCompact: () => void;
  onContextSwitchDismiss: () => void;
  onModelChange?: (model: string) => void;
  onMessageSendStarted: (dispatchMode: QueueDispatchMode) => void;
  onMessageSent: (dispatchMode: QueueDispatchMode) => void;
  onResetContext: () => Promise<"reset" | "noop">;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  editingMessage: EditingMessageState | undefined;
  onCancelEdit: () => void;
  onEditLastUserMessage: () => void;
  onChatInputReady: (api: ChatInputAPI) => void;
  queuedMessage: QueuedMessageData | null;
  onEditQueuedMessage: () => void;
  onSendQueuedImmediately: (() => Promise<void>) | undefined;
  onQueuedDispatchModeChange: (mode: QueueDispatchMode) => Promise<void>;
  queuedActionError: string | null;
  onQueuedActionError: (error: unknown) => void;
  onClearQueuedActionError: () => void;
  reviews: ReviewsState;
  onCheckReviews: (ids: string[]) => void;
}

const ChatInputPane: React.FC<ChatInputPaneProps> = (props) => {
  const { reviews } = props;

  // Keep optional banners/warnings on one shared lane so the seam right above the textarea is
  // owned by a single component boundary. That lets hydration reserve only the volatile
  // workspace-specific decoration stack instead of the whole composer pane.
  const decorationEntries: ChatInputDecorationStackItem[] = [];
  const addDecorationEntry = (entry: { key: string; node: React.ReactNode }) => {
    decorationEntries.push(createChatInputDecorationStackItem(entry));
  };

  // Keep the user's pending follow-up closest to the transcript, above every workspace decoration,
  // so it reads as the next message rather than as another banner competing near the composer.
  if (props.queuedMessage) {
    decorationEntries.push(
      createChatInputDecorationStackItem({
        key: "queued-message",
        // The queued follow-up is synchronous chat state, not an async decoration. Keep it visible
        // while compaction/reconnect bypasses the hydration skeleton but other data is still loading.
        revealBeforeReady: true,
        node: (
          <QueuedMessage
            message={props.queuedMessage}
            onEdit={() => void props.onEditQueuedMessage()}
            onChangeDispatchMode={props.onQueuedDispatchModeChange}
            onActionError={props.onQueuedActionError}
            actionError={props.queuedActionError}
            onActionStart={props.onClearQueuedActionError}
            onSendImmediately={props.onSendQueuedImmediately}
          />
        ),
      })
    );
  }
  if (props.shouldShowCompactionWarning) {
    addDecorationEntry({
      key: "compaction-warning",
      node: (
        <ChatDockSurface>
          <CompactionWarning
            usagePercentage={props.autoCompactionResult.usagePercentage}
            thresholdPercentage={props.autoCompactionResult.thresholdPercentage}
            isStreaming={props.canInterrupt}
            rolloverEnabled={props.rolloverEnabled}
          />
        </ChatDockSurface>
      ),
    });
  }
  if (props.contextSwitchWarning) {
    addDecorationEntry({
      key: "context-switch-warning",
      node: (
        <ChatDockSurface>
          <ContextSwitchWarningBanner
            warning={props.contextSwitchWarning}
            onCompact={props.onContextSwitchCompact}
            onDismiss={props.onContextSwitchDismiss}
          />
        </ChatDockSurface>
      ),
    });
  }
  // User rationale: keeping this warning inside the transcript tail made every appended
  // message insert above a live tail row, so bottom-lock had to correct after layout and
  // visibly flashed while another local agent was active. Pin it with composer decorations
  // instead; new transcript rows no longer move the warning.
  if (props.concurrentLocalStreamingWorkspaceName) {
    addDecorationEntry({
      key: "concurrent-local-warning",
      node: (
        <ConcurrentLocalWarningDecoration
          streamingWorkspaceName={props.concurrentLocalStreamingWorkspaceName}
        />
      ),
    });
  }

  if (props.shouldShowPinnedTodoList) {
    addDecorationEntry({
      key: "pinned-todo-list",
      node: <PinnedTodoList workspaceId={props.workspaceId} />,
    });
  }
  addDecorationEntry({
    key: "sub-agent-tasks",
    // Durable sub-agents live with their parent chat instead of relying only on nested sidebar rows.
    // The decoration is collapsed by default, so inactive task history is available without noise.
    // Keyed by workspace: ChatPane stays mounted across workspace switches, and the decoration
    // retains observed workflow-run refs that must never leak into another chat's tray.
    node: <SubAgentTasksDecoration key={props.workspaceId} workspaceId={props.workspaceId} />,
  });
  addDecorationEntry({
    key: "background-processes",
    node: <BackgroundProcessesBanner workspaceId={props.workspaceId} />,
  });
  // The Chat Instructions decoration is intentionally self-gating: it renders
  // nothing when the scratchpad is empty or disabled, so it can always be in
  // the decoration lane without affecting layout for users who don't use it.
  addDecorationEntry({
    key: "chat-instructions",
    node: <ChatInstructionsChatDecoration workspaceId={props.workspaceId} />,
  });
  if (props.shouldShowReviewsBanner) {
    addDecorationEntry({
      key: "reviews-banner",
      node: <ReviewsBanner workspaceId={props.workspaceId} />,
    });
  }
  if (props.isPreStreamAgentTask) {
    addDecorationEntry({
      key: "pre-stream-agent-task",
      node: (
        <ChatDockSurface>
          <div className="border-border-medium bg-background-secondary text-muted rounded-md border px-3 py-2 text-xs">
            {props.preStreamAgentTaskStatus === "starting"
              ? "This agent task is starting and will become editable after launch accepts the initial prompt."
              : "This agent task is queued and will start automatically when a parallel slot is available."}
          </div>
        </ChatDockSurface>
      ),
    });
  }
  // The decoration lane lives inside the in-flow sticky composer dock, so a
  // decoration mounting/unmounting reflows the transcript clearance in the same
  // layout pass; the bottom stays pinned via native anchoring plus the
  // scrollport-children ResizeObserver in useAutoScroll. Until the one-commit
  // reveal the lane renders empty: readiness is monotonic per mounted
  // workspace, so this only ever delays the initial mount — it never unmounts
  // visible decorations.

  return (
    <>
      <ChatInputDecorationStackLane
        items={selectVisibleChatInputDecorations(decorationEntries, props.revealDecorations)}
      />
      <ChatInput
        key={props.workspaceId}
        variant="workspace"
        kind={props.kind}
        workspaceId={props.workspaceId}
        runtimeType={getRuntimeTypeForTelemetry(props.runtimeConfig)}
        onMessageSendStarted={props.onMessageSendStarted}
        onMessageSent={props.onMessageSent}
        onResetContext={props.onResetContext}
        onTruncateHistory={props.onTruncateHistory}
        onModelChange={props.onModelChange}
        disabled={!props.projectName || !props.workspaceName || props.isPreStreamAgentTask}
        disabledReason={
          props.isPreStreamAgentTask
            ? props.preStreamAgentTaskStatus === "starting"
              ? "Starting - waiting for launch to accept the initial prompt."
              : "Queued - waiting for an available parallel task slot. This will start automatically."
            : undefined
        }
        isTranscriptCaughtUp={props.isTranscriptCaughtUp}
        isStreamStarting={props.isStreamStarting}
        isCompacting={props.isCompacting}
        editingMessage={props.editingMessage}
        onCancelEdit={props.onCancelEdit}
        onEditLastUserMessage={props.onEditLastUserMessage}
        canInterrupt={props.canInterrupt}
        queuedMessage={props.queuedMessage}
        onQueuedDispatchModeChange={props.onQueuedDispatchModeChange}
        onQueuedActionError={props.onQueuedActionError}
        onSendQueuedImmediately={props.onSendQueuedImmediately}
        onReady={props.onChatInputReady}
        attachedReviews={reviews.attachedReviews}
        onDetachReview={reviews.detachReview}
        onDetachAllReviews={reviews.detachAllAttached}
        onCheckReview={reviews.checkReview}
        onCheckReviews={props.onCheckReviews}
        onDeleteReview={reviews.removeReview}
        onUpdateReviewNote={reviews.updateReviewNote}
      />
    </>
  );
};
