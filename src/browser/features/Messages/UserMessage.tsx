import React from "react";
import { APIContext } from "@/browser/contexts/API";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import {
  stripStagedAttachmentNotice,
  type DisplayStagedAttachment,
} from "@/browser/features/ChatInput/stagedAttachments";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { UserMessageContent } from "./UserMessageContent";
import { GoalSyntheticMessageContent } from "./GoalSyntheticMessageContent";
import {
  formatSubagentStructuredOutput,
  parseSubagentReportEnvelope,
  SubagentReportMessageContent,
} from "./SubagentReportMessageContent";
import { parseSubagentFailureEnvelope } from "@/common/utils/subagentFailureEnvelope";
import { SubagentFailureMessageContent } from "./SubagentFailureMessageContent";
import { TerminalOutput } from "./TerminalOutput";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { createDownloadRetryCache } from "@/browser/utils/downloadFile";
import {
  buildEditingStateFromDisplayed,
  canEditDisplayedUserMessage,
  type EditingMessageState,
} from "@/browser/utils/chatEditing";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  Pencil,
  Target,
} from "lucide-react";

function base64ToBlob(dataBase64: string, mediaType: string): Blob {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mediaType });
}

/** Navigation info for navigating between user messages */
export interface UserMessageNavigation {
  /** History ID of the previous user message (undefined if this is the first) */
  prevUserMessageId?: string;
  /** History ID of the next user message (undefined if this is the last) */
  nextUserMessageId?: string;
  /** Callback to navigate to a specific message by history ID */
  onNavigate: (historyId: string) => void;
}

interface UserMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
  onEdit?: (message: EditingMessageState) => void;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
  /** Navigation info for backward/forward between user messages */
  navigation?: UserMessageNavigation;
}

// Module-level so all messages share one retry slot, bounding retained
// staged-attachment bytes to a single blob renderer-wide (iOS share-sheet
// retries only ever target the most recent tap).
const stagedDownloads = createDownloadRetryCache();

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  className,
  onEdit,
  isCompacting,
  clipboardWriteText = copyToClipboard,
  navigation,
}) => {
  const isSynthetic = message.isSynthetic === true;
  const isGoalContinuation = message.isGoalContinuation === true;
  const isBudgetLimitWrapup = message.isBudgetLimitWrapup === true;
  const content = message.content;
  const visibleContent = stripStagedAttachmentNotice(content);
  // Only backend-authored synthetic messages may opt into protocol-aware presentation. A user who
  // types a lookalike envelope should continue to see an ordinary escaped user message.
  const subagentReport = isSynthetic ? parseSubagentReportEnvelope(content) : null;
  const subagentFailure = isSynthetic ? parseSubagentFailureEnvelope(content) : null;
  const structuredOutputJson = subagentReport
    ? formatSubagentStructuredOutput(subagentReport)
    : undefined;
  const copyContent = subagentReport
    ? [
        subagentReport.reportMarkdown,
        ...(structuredOutputJson ? [`Structured output:\n${structuredOutputJson}`] : []),
      ].join("\n\n")
    : visibleContent;
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });
  const isMobileTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

  const apiState = React.useContext(APIContext);
  const api = apiState?.api ?? null;
  const workspaceContext = useOptionalWorkspaceContext();
  const workspaceId = workspaceContext?.selectedWorkspace?.workspaceId ?? null;

  // Tracks the workspace this message currently renders for (null once
  // unmounted), so an in-flight download fetch can detect that the user
  // navigated away and must not fire a share sheet for the old workspace.
  const activeWorkspaceIdRef = React.useRef<string | null>(workspaceId);
  React.useEffect(() => {
    activeWorkspaceIdRef.current = workspaceId;
    return () => {
      activeWorkspaceIdRef.current = null;
    };
  }, [workspaceId]);

  // Forked workspaces copy staged attachments under the same relative path,
  // so the cache key needs the workspaceId to avoid serving another
  // workspace's bytes after navigation.
  const handleDownloadStagedAttachment = (attachment: DisplayStagedAttachment) =>
    stagedDownloads.download(
      `${workspaceId ?? ""}:${attachment.stagedPath}`,
      async () => {
        if (api == null || workspaceId == null) {
          console.warn("Cannot download staged attachment without an active workspace connection.");
          return null;
        }

        const result = await api.workspace.downloadStagedAttachment({
          workspaceId,
          stagedPath: attachment.stagedPath,
        });
        if (!result.success) {
          console.error("Failed to download staged attachment:", result.error);
          return null;
        }

        return {
          blob: base64ToBlob(result.data.dataBase64, result.data.mediaType),
          filename: result.data.filename || attachment.filename,
        };
      },
      () => activeWorkspaceIdRef.current === workspaceId
    );

  console.assert(
    typeof clipboardWriteText === "function",
    "UserMessage expects clipboardWriteText to be a callable function."
  );

  const isLocalCommandOutput =
    content.startsWith("<local-command-stdout>") && content.endsWith("</local-command-stdout>");

  // Extract the actual output if it's a local command
  const extractedOutput = isLocalCommandOutput
    ? content.slice("<local-command-stdout>".length, -"</local-command-stdout>".length).trim()
    : "";

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  const canEdit = canEditDisplayedUserMessage(message);

  const handleEdit = () => {
    // Goal-synthetic messages keep raw model prompts available via Copy/JSON only.
    if (onEdit && canEdit) {
      onEdit(buildEditingStateFromDisplayed(message));
    }
  };

  // Navigation buttons - always reserve space to avoid layout shift
  // Only show when navigation prop is provided (indicates more than one user message)
  const showNavigation = navigation !== undefined;
  const hasPrev = navigation?.prevUserMessageId !== undefined;
  const hasNext = navigation?.nextUserMessageId !== undefined;

  // Keep Copy and Edit buttons visible (most common actions)
  // Navigation buttons appear first when there are multiple user messages
  const buttons: ButtonConfig[] = [
    // Navigation: backward (previous user message)
    ...(showNavigation
      ? [
          {
            label: "Previous message",
            onClick: hasPrev
              ? () => navigation.onNavigate(navigation.prevUserMessageId!)
              : undefined,
            disabled: !hasPrev,
            icon: <ChevronLeft className={!hasPrev ? "opacity-30" : undefined} />,
            tooltip: hasPrev ? "Go to previous message" : undefined,
          },
        ]
      : []),
    // Navigation: forward (next user message)
    ...(showNavigation
      ? [
          {
            label: "Next message",
            onClick: hasNext
              ? () => navigation.onNavigate(navigation.nextUserMessageId!)
              : undefined,
            disabled: !hasNext,
            icon: <ChevronRight className={!hasNext ? "opacity-30" : undefined} />,
            tooltip: hasNext ? "Go to next message" : undefined,
          },
        ]
      : []),
    ...(onEdit && canEdit
      ? [
          {
            label: "Edit",
            onClick: handleEdit,
            disabled: isCompacting,
            icon: <Pencil />,
            tooltip: isCompacting
              ? isMobileTouch
                ? "Cannot edit while compacting"
                : `Cannot edit while compacting (${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel)`
              : undefined,
          },
        ]
      : []),
    {
      label: copied ? "Copied" : "Copy",
      onClick: () => void copyToClipboard(copyContent),
      icon: copied ? <ClipboardCheck /> : <Clipboard />,
    },
  ];

  let label: React.ReactNode = null;
  if (isBudgetLimitWrapup) {
    label = (
      <span className="bg-warning/10 text-warning flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Target aria-hidden="true" className="h-3 w-3" />
        budget limit wrap-up
      </span>
    );
  } else if (isGoalContinuation) {
    label = (
      <span className="bg-muted/20 text-muted flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Target aria-hidden="true" className="h-3 w-3" />
        goal continuation
      </span>
    );
  } else if (subagentReport) {
    const isInProgress = subagentReport.status === "in_progress";
    label = (
      <span
        className={cn(
          "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase",
          isInProgress ? "bg-backgrounded/10 text-backgrounded" : "bg-success/10 text-success"
        )}
      >
        <Bot aria-hidden="true" className="h-3 w-3" />
        {isInProgress ? "subagent update" : "subagent report"}
      </span>
    );
  } else if (subagentFailure) {
    label = (
      <span className="bg-muted/20 text-muted flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Bot aria-hidden="true" className="h-3 w-3" />
        subagent
      </span>
    );
  } else if (isSynthetic) {
    label = (
      <span className="bg-muted/20 text-muted rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        auto
      </span>
    );
  }
  const syntheticClassName = cn(
    className,
    isSynthetic && !subagentReport && !subagentFailure && "opacity-70",
    (subagentReport ?? subagentFailure) && "ml-0 w-full",
    (isGoalContinuation || isBudgetLimitWrapup) && "italic"
  );

  let renderedContent: React.ReactNode;
  if (isLocalCommandOutput) {
    renderedContent = <TerminalOutput output={extractedOutput} isError={false} />;
  } else if (isGoalContinuation || isBudgetLimitWrapup) {
    renderedContent = (
      <GoalSyntheticMessageContent
        content={content}
        kind={isBudgetLimitWrapup ? "budget-limit" : "continuation"}
      />
    );
  } else if (subagentReport) {
    renderedContent = <SubagentReportMessageContent report={subagentReport} />;
  } else if (subagentFailure) {
    renderedContent = <SubagentFailureMessageContent failure={subagentFailure} />;
  } else {
    renderedContent = (
      <UserMessageContent
        content={content}
        commandPrefix={message.commandPrefix}
        agentSkillSnapshot={message.agentSkill?.snapshot}
        inlineSkillSnapshots={message.inlineSkillSnapshots}
        reviews={message.reviews}
        fileParts={message.fileParts}
        onDownloadStagedAttachment={(attachment) => void handleDownloadStagedAttachment(attachment)}
        variant="sent"
      />
    );
  }

  return (
    <MessageWindow
      label={label}
      message={message}
      buttons={buttons}
      className={syntheticClassName}
      variant="user"
    >
      {renderedContent}
    </MessageWindow>
  );
};
