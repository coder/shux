import React, { useState, useEffect, useRef } from "react";
import type {
  ProposePlanToolResult,
  ProposePlanToolError,
  LegacyProposePlanToolArgs,
  LegacyProposePlanToolResult,
} from "@/common/types/tools";
import {
  ToolChrome,
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { PlanAnnotationView } from "./PlanAnnotationView";
import { extractPlanHeadings } from "./ProposePlan/extractPlanHeadings";
import { PlanTableOfContents } from "./ProposePlan/PlanTableOfContents";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { IconActionButton, type ButtonConfig } from "../Messages/MessageWindow";
import {
  formatKeybind,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { useStartHere } from "@/browser/hooks/useStartHere";
import { useReviews } from "@/browser/hooks/useReviews";
import { createMuxMessage } from "@/common/types/message";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { TranscriptQuoteRoot } from "../Messages/TranscriptQuoteBoundary";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { PopoverError } from "@/browser/components/PopoverError/PopoverError";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getPlanContentKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  resolveWorkspaceAiSettingsForAgent,
  type WorkspaceAISettingsCache,
} from "@/browser/utils/workspaceModeAi";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ReviewActionCallbacks } from "../Shared/InlineReviewNote";
import { isPlanFilePath, normalizePlanFilePath } from "@/common/types/review";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import {
  Check,
  Clipboard,
  ClipboardCheck,
  ClipboardList,
  Copy,
  FileText,
  ListStart,
  MessageSquareOff,
  MessageSquarePlus,
  Pencil,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Check if the result is a successful file-based propose_plan result.
 * Note: planContent may be absent in newer results (context optimization).
 */
function isProposePlanResult(result: unknown): result is ProposePlanToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "planPath" in result
  );
}

/**
 * Result type that may have planContent (for backwards compatibility with old chat history)
 */
interface ProposePlanResultWithContent extends ProposePlanToolResult {
  planContent?: string;
}

/**
 * Check if the result is an error from propose_plan tool
 */
function isProposePlanError(result: unknown): result is ProposePlanToolError {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false &&
    "error" in result
  );
}

/**
 * Check if the result is from the legacy propose_plan tool (title + plan params)
 */
function isLegacyProposePlanResult(result: unknown): result is LegacyProposePlanToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "title" in result &&
    "plan" in result
  );
}

/**
 * Check if args are from the legacy propose_plan tool
 */
function isLegacyProposePlanArgs(args: unknown): args is LegacyProposePlanToolArgs {
  return args !== null && typeof args === "object" && "title" in args && "plan" in args;
}

interface ProposePlanToolCallProps {
  args: Record<string, unknown>;
  result?: unknown;
  status?: ToolStatus;
  workspaceId?: string;
  /** Whether this is the latest propose_plan in the conversation */
  isLatest?: boolean;
  /** When true, renders as ephemeral preview (no tool wrapper, shows close button) */
  isEphemeralPreview?: boolean;
  /** Callback when user closes ephemeral preview */
  onClose?: () => void;
  /** Direct content for ephemeral preview (bypasses args/result extraction) */
  content?: string;
  /** Direct path for ephemeral preview */
  path?: string;
  /** Optional className for the outer wrapper */
  className?: string;
}

export const ProposePlanToolCall: React.FC<ProposePlanToolCallProps> = (props) => {
  const {
    args,
    result,
    status = "pending",
    workspaceId,
    isLatest,
    isEphemeralPreview,
    onClose,
    content: directContent,
    path: directPath,
    className,
  } = props;
  const { expanded, toggleExpanded } = useToolExpansion(true); // Expand by default
  const [showRaw, setShowRaw] = useState(false);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [isImplementing, setIsImplementing] = useState(false);
  const [isContinuingInAuto, setIsContinuingInAuto] = useState(false);
  const [implementReplacesChatHistory, setImplementReplacesChatHistory] = useState(false);

  // On small screens, render the primary plan actions (Implement / Continue in Auto) as
  // shortcut icons alongside the other action buttons to avoid right-side overflow.
  const [isNarrowScreen, setIsNarrowScreen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 768;
  });

  const isImplementingRef = useRef(false);
  const isContinuingInAutoRef = useRef(false);
  const isMountedRef = useRef(true);
  // Anchors the plan body so PlanTableOfContents can `querySelectorAll("h1,h2,h3...")`
  // and `scrollIntoView` the matching rendered heading. Pointing at `plan-surface`
  // also implicitly scopes lookups away from neighbouring tool calls/transcripts.
  const planContentRef = useRef<HTMLDivElement>(null);
  const { api } = useAPI();
  const { agentId: currentAgentId, agents } = useAgent();
  const isAutoMode = currentAgentId === "auto";
  const openInEditor = useOpenInEditor();
  const workspaceContext = useOptionalWorkspaceContext();
  const editorError = usePopoverError();
  const editButtonRef = useRef<HTMLDivElement>(null);

  // Get runtimeConfig for the workspace (needed for SSH-aware editor opening)
  const workspaceMetadata = workspaceId
    ? workspaceContext?.workspaceMetadata.get(workspaceId)
    : undefined;
  const runtimeConfig = workspaceMetadata?.runtimeConfig;

  // Fresh content from disk for the latest plan (external edit detection)
  // Only use cache for completed tools (page reload case) - not for in-flight tools
  // which may have stale cache from a previous propose_plan call
  const cacheKey = workspaceId ? getPlanContentKey(workspaceId) : "";
  const shouldUseCache = workspaceId && isLatest && !isEphemeralPreview && status === "completed";
  const cached = shouldUseCache
    ? readPersistedState<{ content: string; path: string } | null>(cacheKey, null)
    : null;

  const [freshContent, setFreshContent] = useState<string | null>(cached?.content ?? null);
  const [freshPath, setFreshPath] = useState<string | null>(cached?.path ?? null);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setIsNarrowScreen(window.innerWidth <= 768);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!api) return;
    if (isEphemeralPreview) return;
    if (!isLatest) return;
    if (status !== "completed") return;

    let cancelled = false;

    void api.config
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setImplementReplacesChatHistory(
          cfg.taskSettings.proposePlanImplementReplacesChatHistory ?? false
        );
      })
      .catch(() => {
        // Ignore failures (we'll default to old behavior).
      });

    return () => {
      cancelled = true;
    };
  }, [api, isEphemeralPreview, isLatest, status]);

  // Fetch fresh plan content for the latest plan
  // Re-fetches on mount, when window regains focus, and when tool completes
  useEffect(() => {
    if (isEphemeralPreview || !isLatest || !workspaceId || !api) return;

    const fetchPlan = async () => {
      try {
        const res = await api.workspace.getPlanContent({ workspaceId });
        if (res.success) {
          setFreshContent(res.data.content);
          setFreshPath(res.data.path);
          // Update cache for page reload (only useful when tool is completed)
          updatePersistedState(cacheKey, { content: res.data.content, path: res.data.path });
        }
      } catch {
        // Fetch failed, keep existing content
      }
    };

    // Fetch immediately on mount
    void fetchPlan();

    // Re-fetch when window regains focus (user returns from external editor)
    const handleFocus = () => void fetchPlan();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
    // status in deps ensures refetch when tool completes (captures final file state)
  }, [api, workspaceId, isLatest, isEphemeralPreview, cacheKey, status]);

  // Determine plan content and title based on result type
  // For ephemeral previews, use direct content/path props
  // For the latest plan, prefer fresh content from disk (external edit support)
  let planContent: string;
  let planTitle: string;
  let planPath: string | undefined;
  let errorMessage: string | undefined;

  if (isEphemeralPreview && directContent !== undefined) {
    // Ephemeral preview mode: use direct props
    planContent = directContent;
    planPath = directPath;
    const titleMatch = /^#\s+(.+)$/m.exec(directContent);
    planTitle = titleMatch ? titleMatch[1] : "Plan";
  } else if (isLatest && freshContent !== null) {
    planContent = freshContent;
    planPath = freshPath ?? undefined;
    // Extract title from first markdown heading or use filename
    const titleMatch = /^#\s+(.+)$/m.exec(freshContent);
    planTitle = titleMatch ? titleMatch[1] : (planPath?.split("/").pop() ?? "Plan");
  } else if (isProposePlanResult(result)) {
    // New format: planContent may be absent (context optimization)
    // For backwards compatibility, check if planContent exists in old chat history
    const resultWithContent = result as ProposePlanResultWithContent;
    planPath = result.planPath;
    if (resultWithContent.planContent) {
      // Old result with embedded content (backwards compatibility)
      planContent = resultWithContent.planContent;
      const titleMatch = /^#\s+(.+)$/m.exec(resultWithContent.planContent);
      planTitle = titleMatch ? titleMatch[1] : (planPath.split("/").pop() ?? "Plan");
    } else {
      // New result without content - show path info, content is fetched for latest
      planContent = `*Plan saved to ${planPath}*`;
      planTitle = planPath.split("/").pop() ?? "Plan";
    }
  } else if (isLegacyProposePlanResult(result)) {
    // Legacy format: title + plan passed directly (no file)
    planContent = result.plan;
    planTitle = result.title;
  } else if (isProposePlanError(result)) {
    // Error from backend (e.g., plan file missing or empty)
    planContent = "";
    planTitle = "Plan Error";
    errorMessage = result.error;
  } else if (isLegacyProposePlanArgs(args)) {
    // Fallback to args for legacy format (streaming state before result)
    planContent = args.plan;
    planTitle = args.title;
  } else {
    // No valid plan data available (e.g., pending state)
    planContent = "";
    planTitle = "Plan";
  }

  const reviews = useReviews(workspaceId ?? "");
  const effectivePlanPath = planPath != null ? (normalizePlanFilePath(planPath) ?? planPath) : null;
  const planReviews =
    effectivePlanPath == null
      ? []
      : reviews.reviews.filter((review) => {
          if (!isPlanFilePath(review.data.filePath)) {
            return false;
          }

          const normalizedReviewPath = normalizePlanFilePath(review.data.filePath);
          return normalizedReviewPath === effectivePlanPath;
        });
  const reviewActions: ReviewActionCallbacks = {
    onEditComment: reviews.updateReviewNote,
    onComplete: reviews.checkReview,
    onDetach: reviews.detachReview,
    onDelete: reviews.removeReview,
    onAttach: reviews.attachReview,
    onUncheck: reviews.uncheckReview,
  };

  // Format: Title as H1 + plan content for "Start Here" functionality.
  // Note: we intentionally preserve the plan file on disk when starting here so it can be
  // referenced later (e.g., via post-compaction attachments).
  const planContentTrimmed = planContent.trim();
  const hasPlanContentInChat =
    planContentTrimmed.length > 0 && !planContentTrimmed.startsWith("*Plan saved to ");

  const isEphemeralPreviewMode = isEphemeralPreview ?? false;
  const hasCompletedToolCall = status === "completed" && !isProposePlanError(result);
  const canAnnotate = Boolean(
    (isEphemeralPreviewMode || ((isLatest ?? false) && hasCompletedToolCall)) &&
    hasPlanContentInChat &&
    workspaceId &&
    planPath
  );
  const isPlanVisible = isEphemeralPreviewMode || expanded;

  useEffect(() => {
    if (canAnnotate) return;

    setAnnotateMode(false);
  }, [canAnnotate]);

  useEffect(() => {
    // Scope the global annotate shortcut to the latest non-ephemeral plan tool call.
    // Ephemeral previews can still use the button, but should not all toggle together.
    const canUseAnnotateKeybind =
      canAnnotate && isPlanVisible && (isLatest ?? false) && !isEphemeralPreviewMode;

    if (!canUseAnnotateKeybind) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableElement(event.target)) {
        return;
      }

      if (!matchesKeybind(event, KEYBINDS.TOGGLE_PLAN_ANNOTATE)) {
        return;
      }

      event.preventDefault();
      setAnnotateMode((currentAnnotateMode) => {
        const nextAnnotateMode = !currentAnnotateMode;
        if (nextAnnotateMode) {
          setShowRaw(false);
        }
        return nextAnnotateMode;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canAnnotate, isPlanVisible, isLatest, isEphemeralPreviewMode]);

  // When using "Start Here" (replace chat history), the plan is already included in the
  // conversation *only* when the Propose Plan tool result includes full plan text.
  // Keeping this note short avoids token bloat while discouraging redundant plan-file
  // reads in Exec.
  const startHereNote = hasPlanContentInChat
    ? "\n\nNote: This chat already contains the full plan; no need to re-open the plan file."
    : planContentTrimmed.startsWith("*Plan saved to ")
      ? "\n\nNote: This chat only includes a placeholder. Read the plan file below for the full plan."
      : "";

  const planPathNote = planPath ? `\n\n---\n\n*Plan file preserved at:* \`${planPath}\`` : "";
  const startHereContent = `# ${planTitle}\n\n${planContent}${startHereNote}${planPathNote}`;
  const {
    openModal,
    buttonLabel,
    disabled: startHereDisabled,
    modal,
  } = useStartHere(workspaceId, startHereContent, false, {
    // Preserve the source agent so exec can detect a plan→exec transition
    // even after replacing chat history.
    sourceAgentId: "plan",
  });

  const replaceChatHistoryWithPlan = async (args: { idPrefix: string; errorContext: string }) => {
    if (!workspaceId || !api) return;

    try {
      const summaryMessage = createMuxMessage(
        `${args.idPrefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        "assistant",
        startHereContent,
        {
          timestamp: Date.now(),
          compacted: "user",
          // Preserve the source agent so plan-origin compactions can be detected.
          agentId: "plan",
        }
      );

      const result = await api.workspace.replaceChatHistory({
        workspaceId,
        summaryMessage,
        mode: "append-compaction-boundary",
        deletePlanFile: false,
      });

      if (!result.success) {
        console.error(args.errorContext, result.error);
      }
    } catch (err) {
      console.error(args.errorContext, err);
    }
  };

  // User request: propose_plan primary actions send immediately after agent switch.
  // Resolve and persist model/thinking synchronously here so the follow-up message
  // uses the target agent defaults instead of stale planning-mode preferences.
  const resolveAndPersistTargetAgentSettings = (args: {
    workspaceId: string;
    targetAgentId: "auto" | "exec";
  }): { resolvedModel: string; resolvedThinking: ThinkingLevel } => {
    const modelKey = getModelKey(args.workspaceId);
    const thinkingKey = getThinkingLevelKey(args.workspaceId);
    const reasoningKey = getReasoningModeKey(args.workspaceId);
    const fallbackModel = getDefaultModel();

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const existingReasoning = readPersistedState<OpenAIReasoningMode>(reasoningKey, "standard");
    const agentAiDefaults = readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {});
    const workspaceByAgent = readPersistedState<WorkspaceAISettingsCache>(
      getWorkspaceAISettingsByAgentKey(args.workspaceId),
      {}
    );

    const { resolvedModel, resolvedThinking, resolvedReasoningMode } =
      resolveWorkspaceAiSettingsForAgent({
        agentId: args.targetAgentId,
        agentAiDefaults,
        // Propose-plan actions are explicit mode switches; honor any per-agent
        // workspace override before inheriting the previously active plan settings.
        workspaceByAgent,
        useWorkspaceByAgentFallback: true,
        fallbackModel,
        existingModel,
        existingThinking,
        existingReasoningMode: existingReasoning,
        agentBaseById: new Map(agents.map((agent) => [agent.id, agent.base])),
      });

    updatePersistedState(getAgentIdKey(args.workspaceId), args.targetAgentId);

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(args.workspaceId, resolvedModel, "agent");
    }
    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }
    // Persist before getSendOptionsFromStorage reads the key for the follow-up send.
    if (existingReasoning !== resolvedReasoningMode) {
      updatePersistedState(reasoningKey, resolvedReasoningMode);
    }

    return { resolvedModel, resolvedThinking };
  };

  const handleImplement = async () => {
    if (!workspaceId || !api) return;
    if (isImplementingRef.current) return;

    isImplementingRef.current = true;
    if (isMountedRef.current) {
      setIsImplementing(true);
    }

    try {
      let shouldReplaceChatHistory = false;

      try {
        const cfg = await api.config.getConfig();
        shouldReplaceChatHistory =
          cfg.taskSettings.proposePlanImplementReplacesChatHistory ?? false;
      } catch {
        // Ignore config read errors (we'll default to old behavior).
      }

      if (shouldReplaceChatHistory) {
        await replaceChatHistoryWithPlan({
          idPrefix: "start-here",
          errorContext: "Failed to replace chat history before implementing:",
        });
      }

      const targetAgentId = "exec";
      const { resolvedModel, resolvedThinking } = resolveAndPersistTargetAgentSettings({
        workspaceId,
        targetAgentId,
      });
      const sendMessageOptions = getSendOptionsFromStorage(workspaceId);

      await api.workspace.sendMessage({
        workspaceId,
        message: "Implement the plan",
        options: {
          ...sendMessageOptions,
          agentId: targetAgentId,
          model: resolvedModel,
          thinkingLevel: resolvedThinking,
        },
      });
    } catch {
      // Best-effort: user can retry manually if sending fails.
    } finally {
      isImplementingRef.current = false;
      if (isMountedRef.current) {
        setIsImplementing(false);
      }
    }
  };
  const handleContinueInAuto = async () => {
    if (!workspaceId || !api) return;
    if (isContinuingInAutoRef.current) return;

    isContinuingInAutoRef.current = true;
    if (isMountedRef.current) {
      setIsContinuingInAuto(true);
    }

    try {
      let shouldReplaceChatHistory = false;

      try {
        const cfg = await api.config.getConfig();
        shouldReplaceChatHistory =
          cfg.taskSettings.proposePlanImplementReplacesChatHistory ?? false;
      } catch {
        // Ignore config read errors (we'll default to old behavior).
      }

      if (shouldReplaceChatHistory) {
        await replaceChatHistoryWithPlan({
          idPrefix: "continue-auto",
          errorContext: "Failed to replace chat history before continuing in auto:",
        });
      }

      const targetAgentId = "auto";
      const { resolvedModel, resolvedThinking } = resolveAndPersistTargetAgentSettings({
        workspaceId,
        targetAgentId,
      });
      const sendMessageOptions = getSendOptionsFromStorage(workspaceId);

      await api.workspace.sendMessage({
        workspaceId,
        message: "Implement the plan",
        options: {
          ...sendMessageOptions,
          agentId: targetAgentId,
          model: resolvedModel,
          thinkingLevel: resolvedThinking,
        },
      });
    } catch {
      // Best-effort: user can retry manually if sending fails.
    } finally {
      isContinuingInAutoRef.current = false;
      if (isMountedRef.current) {
        setIsContinuingInAuto(false);
      }
    }
  };

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();
  // Separate instance so the "Copy file path" button has independent feedback.
  const { copied: copiedPath, copyToClipboard: copyPathToClipboard } = useCopyToClipboard();

  const handleOpenInEditor = async () => {
    if (!planPath || !workspaceId) return;

    // Capture positioning from the ref for error popover placement
    const anchorPosition = editButtonRef.current
      ? (() => {
          const { bottom, left } = editButtonRef.current.getBoundingClientRect();
          return { top: bottom + 8, left };
        })()
      : { top: 100, left: 100 };

    try {
      const result = await openInEditor(workspaceId, planPath, runtimeConfig, { isFile: true });
      if (!result.success && result.error) {
        editorError.showError("plan-editor", result.error, anchorPosition);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      editorError.showError("plan-editor", message, anchorPosition);
    }
  };

  const statusDisplay = getStatusDisplay(status);

  // Build action buttons array (similar to AssistantMessage)
  const copyButton: ButtonConfig = {
    label: copied ? "Copied" : "Copy",
    onClick: () => void copyToClipboard(planContent),
    icon: copied ? <ClipboardCheck /> : <Clipboard />,
  };

  const actionButtons: ButtonConfig[] = [copyButton];

  // Copy the plan's on-disk file path (replaces the former mux.md "Share" link action).
  // Use the Copy/Check icons (the repo's copy-a-value idiom, see RuntimeBadge) so this
  // button is visually distinct from the Clipboard "Copy" button that copies plan content.
  if (planPath) {
    actionButtons.push({
      label: copiedPath ? "Copied" : "Copy file path",
      onClick: () => void copyPathToClipboard(planPath),
      icon: copiedPath ? <Check /> : <Copy />,
      tooltip: planPath,
    });
  }

  // Edit button config (rendered separately with ref for error positioning)
  const showEditButton = (isEphemeralPreview ?? isLatest) && planPath && workspaceId;
  const editButton: ButtonConfig | null = showEditButton
    ? {
        label: "Edit",
        onClick: () => void handleOpenInEditor(),
        icon: <Pencil />,
        tooltip: "Open plan in external editor",
      }
    : null;

  const shouldShowPrimaryActions = Boolean(
    status === "completed" && !errorMessage && isLatest && !isEphemeralPreview && workspaceId
  );

  const implementButton: ButtonConfig | null =
    shouldShowPrimaryActions && !isAutoMode
      ? {
          label: "Implement",
          onClick: () => void handleImplement(),
          disabled: !api || isImplementing || isContinuingInAuto,
          icon: <Play className="size-4" />,
          tooltip: implementReplacesChatHistory
            ? "Replace chat history with this plan, switch to Exec, and start implementing"
            : "Switch to Exec and start implementing",
        }
      : null;

  const autoButton: ButtonConfig | null =
    shouldShowPrimaryActions && isAutoMode
      ? {
          label: "Continue in Auto",
          onClick: () => void handleContinueInAuto(),
          disabled: !api || isContinuingInAuto || isImplementing,
          icon: <Sparkles className="size-4" />,
          tooltip: implementReplacesChatHistory
            ? "Replace chat history with this plan, switch to Auto, and let it decide the executor"
            : "Switch to Auto and let it decide the executor",
        }
      : null;

  // Start Here button: only for tool calls, not ephemeral previews
  if (!isEphemeralPreview && workspaceId) {
    actionButtons.push({
      label: buttonLabel,
      onClick: openModal,
      disabled: startHereDisabled,
      icon: <ListStart />,
      tooltip: "Replace all chat history with this plan",
    });
  }

  if (canAnnotate) {
    actionButtons.push({
      label: annotateMode ? "Exit Annotate" : "Annotate",
      onClick: () => {
        setAnnotateMode((currentAnnotateMode) => {
          const nextAnnotateMode = !currentAnnotateMode;
          if (nextAnnotateMode) {
            setShowRaw(false);
          }
          return nextAnnotateMode;
        });
      },
      active: annotateMode,
      icon: annotateMode ? <MessageSquareOff /> : <MessageSquarePlus />,
      tooltip: `${annotateMode ? "Exit" : "Enter"} annotation mode (${formatKeybind(KEYBINDS.TOGGLE_PLAN_ANNOTATE)})`,
    });
  }

  // Show raw toggle
  actionButtons.push({
    label: showRaw ? "Show Markdown" : "Show Text",
    onClick: () => {
      const next = !showRaw;
      setShowRaw(next);
      if (next) {
        setAnnotateMode(false);
      }
    },
    active: showRaw,
    icon: <FileText />,
  });

  // Close button: only for ephemeral previews
  if (isEphemeralPreview && onClose) {
    actionButtons.push({
      label: "Close",
      onClick: onClose,
      icon: <X />,
      tooltip: "Close preview",
    });
  }

  const planContentBody = errorMessage ? (
    <div className="text-error rounded-sm p-2 font-mono text-xs">{errorMessage}</div>
  ) : annotateMode && canAnnotate ? (
    <PlanAnnotationView
      planContent={planContent}
      planPath={effectivePlanPath ?? undefined}
      onReviewNote={reviews.addReview}
      reviews={planReviews}
      reviewActions={reviewActions}
    />
  ) : showRaw ? (
    <div className="relative">
      <pre className="text-text bg-code-bg m-0 rounded-sm p-2 pb-8 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {planContent}
      </pre>
      <div className="absolute right-2 bottom-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px] [&_svg]:size-3.5"
          onClick={() => void copyToClipboard(planContent)}
        >
          {copied ? <ClipboardCheck /> : <Clipboard />}
          {copied ? "Copied" : "Copy to clipboard"}
        </Button>
      </div>
    </div>
  ) : (
    <MarkdownRenderer content={planContent} />
  );

  const planBodyClassName = !errorMessage && !annotateMode && !showRaw ? "plan-content" : undefined;

  const planQuoteContent = isEphemeralPreview ? (
    <TranscriptQuoteRoot text={errorMessage ?? planContent} className={planBodyClassName}>
      {planContentBody}
    </TranscriptQuoteRoot>
  ) : (
    <div className={planBodyClassName}>{planContentBody}</div>
  );

  // Show the table of contents only for normal markdown content. Annotate mode,
  // raw text, and error states either have no headings or use a custom renderer,
  // so a TOC there would be either empty or misleading.
  const showToc = !errorMessage && !annotateMode && !showRaw && hasPlanContentInChat;
  const tocEntries = showToc ? extractPlanHeadings(planContent) : [];

  // Shared plan UI content (used in both tool call and ephemeral preview modes)
  const planUI = (
    <div
      ref={planContentRef}
      className={cn(
        "plan-surface rounded-md p-3 shadow-md",
        annotateMode && "ring-accent/30 ring-1"
      )}
    >
      {/* Header: title only */}
      <ToolChrome className="plan-divider mb-3 flex items-center gap-2 border-b pb-2">
        <ClipboardList aria-hidden="true" className="h-4 w-4" />
        <div className="text-plan-mode font-mono text-[13px] font-semibold">{planTitle}</div>
        {annotateMode && (
          <div className="bg-accent/10 text-accent rounded px-1.5 py-0.5 font-mono text-[10px] font-medium">
            Annotating
          </div>
        )}
        {isEphemeralPreview && (
          <div className="text-muted font-mono text-[10px] italic">preview only</div>
        )}
      </ToolChrome>

      {/* Content */}
      {planQuoteContent}

      {/* Completion guidance: only for completed tool calls without errors, not ephemeral previews */}
      {!isEphemeralPreview && status === "completed" && !errorMessage && (
        <ToolChrome className="plan-divider text-muted mt-3 border-t pt-3 text-[11px] leading-normal italic">
          Respond with revisions or switch to the Exec agent (
          <span className="font-primary not-italic">{formatKeybind(KEYBINDS.CYCLE_AGENT)}</span> to
          cycle) and ask to implement.
        </ToolChrome>
      )}

      {/* Actions row at the bottom (matching MessageWindow style) */}
      <ToolChrome className="mt-3 flex items-center gap-0.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {actionButtons.map((button, index) => (
            <IconActionButton key={index} button={button} />
          ))}

          {/* Edit button rendered with ref for error popover positioning */}
          {editButton && (
            <div ref={editButtonRef}>
              <IconActionButton button={editButton} />
            </div>
          )}
        </div>

        {/* Mobile: icon-only plan actions, right-aligned, white */}
        {isNarrowScreen && (implementButton ?? autoButton) && (
          <div className="[&_button]:text-foreground ml-auto flex items-center gap-0.5">
            {implementButton && <IconActionButton button={implementButton} />}
            {autoButton && <IconActionButton button={autoButton} />}
          </div>
        )}

        {!isNarrowScreen && (implementButton ?? autoButton) && (
          <div className="ml-auto flex items-center gap-1">
            {implementButton && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1"
                    onClick={implementButton.onClick}
                    disabled={implementButton.disabled}
                  >
                    {implementButton.icon}
                    <span className="leading-none">{implementButton.label}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {implementButton.tooltip ?? implementButton.label}
                </TooltipContent>
              </Tooltip>
            )}

            {autoButton && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1"
                    onClick={autoButton.onClick}
                    disabled={autoButton.disabled}
                  >
                    {autoButton.icon}
                    <span className="leading-none">{autoButton.label}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {autoButton.tooltip ?? autoButton.label}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </ToolChrome>
    </div>
  );

  // Layout container that positions the TOC affordances alongside the plan. The
  // `plan-toc-layout` class establishes `position: relative` so CSS can place a
  // compact hint or sticky TOC in the left gutter when the transcript container
  // has enough horizontal room.
  const planLayout = (
    <div className="plan-toc-layout">
      {planUI}
      {showToc && (
        <PlanTableOfContents entries={tocEntries} contentRef={planContentRef} title={planTitle} />
      )}
    </div>
  );

  // Ephemeral preview mode: simple wrapper without tool container
  if (isEphemeralPreview) {
    return (
      <>
        <div className={cn("px-4 py-2", className)}>{planLayout}</div>
        <PopoverError error={editorError.error} prefix="Failed to open editor" />
      </>
    );
  }

  // Tool call mode: full tool container with header
  return (
    <>
      <ToolContainer expanded={expanded}>
        <ToolHeader onClick={toggleExpanded}>
          <ExpandIcon expanded={expanded}>▶</ExpandIcon>
          <ToolName>propose_plan</ToolName>
          <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
        </ToolHeader>

        {expanded && <ToolDetails text={errorMessage ?? planContent}>{planLayout}</ToolDetails>}

        {modal}
      </ToolContainer>
      <PopoverError error={editorError.error} prefix="Failed to open editor" />
    </>
  );
};
