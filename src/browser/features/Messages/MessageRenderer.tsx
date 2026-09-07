import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";
import type { TaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import type { ReviewNoteData } from "@/common/types/review";
import type { EditingMessageState } from "@/browser/utils/chatEditing";
import { UserMessage, type UserMessageNavigation } from "./UserMessage";
import { AgentPeerMessage } from "./AgentPeerMessage";
import { BashMonitorWakeMessage } from "./BashMonitorWakeMessage";
import { CollapsibleMachineMessage } from "./CollapsibleMachineMessage";
import { AlertTriangle, MessageSquare } from "lucide-react";
import {
  BackgroundWorkWakeMessage,
  getBackgroundWorkWakeSummary,
} from "./BackgroundWorkWakeMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolMessage } from "./ToolMessage";
import { ReasoningMessage } from "./ReasoningMessage";
import { StreamErrorMessage } from "./StreamErrorMessage";
import { CompactionBoundaryMessage } from "./CompactionBoundaryMessage";
import { HistoryHiddenMessage } from "./HistoryHiddenMessage";
import { InitMessage } from "./InitMessage";
import { ProposePlanToolCall } from "../Tools/ProposePlanToolCall";
import { removeEphemeralMessage, useStreamingMessageDelta } from "@/browser/stores/WorkspaceStore";
import { TranscriptMessageBoundary, TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";

interface MessageRendererProps {
  message: DisplayedMessage;
  className?: string;
  onEditUserMessage?: (message: EditingMessageState) => void;
  onEditQueuedMessage?: () => void;
  workspaceId?: string;
  isCompacting?: boolean;
  /** Handler for adding review notes from inline diffs */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Whether this message is the latest propose_plan tool call (for external edit detection) */
  isLatestProposePlan?: boolean;
  /** Optional bash_output grouping info (computed at render-time) */
  bashOutputGroup?: BashOutputGroupInfo;
  /** Optional task report linking context (computed at render-time) */
  taskReportLinking?: TaskReportLinking;
  /** Navigation info for user messages (backward/forward between user messages) */
  userMessageNavigation?: UserMessageNavigation;
}

function getMessageHistoryId(message: DisplayedMessage): string | undefined {
  if (
    message.type === "history-hidden" ||
    message.type === "workspace-init" ||
    message.type === "compaction-boundary"
  ) {
    return undefined;
  }

  return message.historyId;
}

function getTranscriptQuoteText(message: DisplayedMessage): string | null {
  switch (message.type) {
    case "reasoning":
      return message.content;
    case "stream-error":
      return message.error;
    case "workspace-init":
      return [
        message.hookPath,
        message.truncatedLines
          ? `... ${message.truncatedLines.toLocaleString()} earlier lines truncated ...`
          : null,
        ...message.lines.map((line) => line.line),
      ]
        .filter((line) => line != null && line.length > 0)
        .join("\n");
    default:
      return null;
  }
}

// Memoized to prevent unnecessary re-renders when parent (AIView) updates
export const MessageRenderer = React.memo<MessageRendererProps>(
  ({
    message,
    className,
    onEditUserMessage,
    workspaceId,
    isCompacting,
    onReviewNote,
    isLatestProposePlan,
    bashOutputGroup,
    taskReportLinking,
    userMessageNavigation,
  }) => {
    message = useStreamingMessageDelta(workspaceId, message);
    let renderedMessage: React.ReactNode;

    // Route based on message type
    switch (message.type) {
      case "user": {
        const backgroundWorkWakeSummary =
          message.isSynthetic === true ? getBackgroundWorkWakeSummary(message.content) : null;
        renderedMessage =
          message.contextBudgetWarning != null ? (
            <CollapsibleMachineMessage
              content={message.content}
              summary="Context budget warning"
              icon={<AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />}
              marker="context-budget-warning"
              className={className}
            />
          ) : message.bashMonitorWake != null ? (
            <BashMonitorWakeMessage message={message} className={className} />
          ) : message.agentPeerMessageTrigger != null ? (
            // The wake trigger is backend-generated control text: a full user bubble would
            // falsely present it as human input (the payload renders separately as the
            // assistant-side agent-message card).
            <CollapsibleMachineMessage
              content={message.content}
              summary="Agent message notification"
              icon={<MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />}
              marker="agent-peer-message-trigger"
              className={className}
            />
          ) : backgroundWorkWakeSummary != null ? (
            <BackgroundWorkWakeMessage
              message={message}
              summary={backgroundWorkWakeSummary}
              className={className}
            />
          ) : (
            <UserMessage
              message={message}
              className={className}
              onEdit={onEditUserMessage}
              isCompacting={isCompacting}
              navigation={userMessageNavigation}
            />
          );
        break;
      }
      case "assistant":
        // Peer message payloads are assistant-role synthetic rows (peer bytes never gain
        // user-role authority); backend-attached metadata gates the card presentation.
        renderedMessage =
          message.agentPeerMessage != null ? (
            <AgentPeerMessage message={message} className={className} />
          ) : (
            <AssistantMessage
              message={message}
              className={className}
              workspaceId={workspaceId}
              isCompacting={isCompacting}
            />
          );
        break;
      case "tool":
        renderedMessage = (
          <ToolMessage
            message={message}
            className={className}
            workspaceId={workspaceId}
            onReviewNote={onReviewNote}
            isLatestProposePlan={isLatestProposePlan}
            bashOutputGroup={bashOutputGroup}
            taskReportLinking={taskReportLinking}
          />
        );
        break;
      case "reasoning":
        renderedMessage = (
          <ReasoningMessage message={message} className={className} workspaceId={workspaceId} />
        );
        break;
      case "stream-error":
        renderedMessage = <StreamErrorMessage message={message} className={className} />;
        break;
      case "compaction-boundary":
        renderedMessage = <CompactionBoundaryMessage message={message} className={className} />;
        break;
      case "history-hidden":
        renderedMessage = (
          <HistoryHiddenMessage message={message} className={className} workspaceId={workspaceId} />
        );
        break;
      case "workspace-init":
        renderedMessage = <InitMessage message={message} className={className} />;
        break;
      case "plan-display":
        renderedMessage = (
          <ProposePlanToolCall
            args={{}}
            isEphemeralPreview={true}
            content={message.content}
            path={message.path}
            workspaceId={workspaceId}
            onClose={() => {
              if (workspaceId) {
                removeEphemeralMessage(workspaceId, message.historyId);
              }
            }}
            className={className}
          />
        );
        break;
      default: {
        const _exhaustive: never = message;
        console.error("don't know how to render message", _exhaustive);
        return null;
      }
    }

    const quoteText = getTranscriptQuoteText(message);

    return (
      <TranscriptMessageBoundary
        data-testid="chat-message"
        data-message-id={getMessageHistoryId(message)}
        data-tool-call-id={message.type === "tool" ? message.toolCallId : undefined}
      >
        {quoteText === null ? (
          renderedMessage
        ) : (
          <TranscriptQuoteRoot text={quoteText}>{renderedMessage}</TranscriptQuoteRoot>
        )}
      </TranscriptMessageBoundary>
    );
  }
);

MessageRenderer.displayName = "MessageRenderer";
