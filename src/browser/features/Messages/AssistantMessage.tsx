import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { useStartHere } from "@/browser/hooks/useStartHere";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import type { DisplayedMessage } from "@/common/types/message";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  Clipboard,
  ClipboardCheck,
  FileText,
  GitBranch,
  ListStart,
  Moon,
  Package,
} from "lucide-react";
import { PopoverError } from "@/browser/components/PopoverError/PopoverError";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import React, { useState } from "react";
import { CompactingMessageContent } from "./CompactingMessageContent";
import { CompactionBackground } from "./CompactionBackground";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { ModelDisplay } from "./ModelDisplay";
import { ModelFallbackBadge } from "./ModelFallbackBadge";
import { TypewriterMarkdown } from "./TypewriterMarkdown";

interface AssistantMessageProps {
  message: DisplayedMessage & { type: "assistant" };
  className?: string;
  workspaceId?: string;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
  className,
  workspaceId,
  isCompacting = false,
  clipboardWriteText = copyToClipboard,
}) => {
  const [showRaw, setShowRaw] = useState(false);
  const { api } = useAPI();
  const forkError = usePopoverError();

  const content = message.content;
  const isStreaming = message.isStreaming;
  const isCompacted = message.isCompacted;
  const isBeforeLatestContextBoundary = message.isBeforeLatestContextBoundary === true;
  const isStreamingCompaction = isStreaming && isCompacting;

  // Use Start Here hook for final assistant messages
  const {
    openModal: openStartHereModal,
    buttonLabel: startHereLabel,
    disabled: startHereDisabled,
    modal: startHereModal,
  } = useStartHere(workspaceId, content, isCompacted || isBeforeLatestContextBoundary, {
    // Preserve legacy plan/exec markers so Start Here keeps plan→exec handoff for old history.
    sourceAgentId: message.agentId ?? message.mode,
  });

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  // Keep only Copy button visible (most common action)
  // Kebab menu saves horizontal space by collapsing less-used actions into a single ⋮ button
  const copyButton: ButtonConfig = {
    label: copied ? "Copied" : "Copy",
    onClick: () => void copyToClipboard(content),
    icon: copied ? <ClipboardCheck /> : <Clipboard />,
  };

  const handleForkFromResponse = async () => {
    if (!workspaceId) {
      forkError.showError(message.historyId, "Workspace ID unavailable");
      return;
    }

    if (!api) {
      forkError.showError(message.historyId, "Not connected to server");
      return;
    }

    try {
      // Response-level forks branch from this assistant turn instead of cloning the entire
      // transcript, so users can explore alternatives without carrying over later replies.
      const result = await forkWorkspace({
        client: api,
        sourceWorkspaceId: workspaceId,
        sourceMessageId: message.historyId,
      });

      if (!result.success) {
        forkError.showError(message.historyId, result.error ?? "Failed to fork chat");
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Failed to fork chat";
      forkError.showError(message.historyId, messageText);
    }
  };

  // Scratch chats cannot be forked (the backend rejects it), so hide the
  // response-level Fork action instead of surfacing a guaranteed error.
  // kind is immutable per workspace, so an imperative store read is safe here;
  // missing metadata (stories, tests) keeps the button visible as before.
  const workspaceStore = useWorkspaceStoreRaw();
  const isScratchWorkspace =
    workspaceId != null && workspaceStore.getWorkspaceMetadata(workspaceId)?.kind === "scratch";

  const buttons: ButtonConfig[] = isStreaming ? [] : [copyButton];

  if (!isStreaming) {
    buttons.push({
      label: startHereLabel,
      onClick: openStartHereModal,
      disabled: startHereDisabled,
      tooltip: "Start a new context from this message and preserve earlier chat history",
      icon: <ListStart />,
    });
    if (!isScratchWorkspace) {
      buttons.push({
        label: "Fork",
        onClick: () => void handleForkFromResponse(),
        disabled: !workspaceId || !api,
        tooltip: "Fork a new workspace from this response",
        icon: <GitBranch />,
      });
    }
    buttons.push({
      label: showRaw ? "Show Markdown" : "Show Text",
      onClick: () => setShowRaw(!showRaw),
      active: showRaw,
      icon: <FileText />,
    });
  }

  // Render appropriate content based on state
  const renderContent = () => {
    // Empty streaming state
    if (isStreaming && !content) {
      return <div className="font-primary text-secondary italic">Waiting for response...</div>;
    }

    if (!content) {
      return null;
    }

    if (!isStreaming && showRaw) {
      return (
        <div className="relative">
          <pre className="text-text bg-code-bg m-0 rounded-sm p-2 pb-8 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {content}
          </pre>
          <div className="absolute right-2 bottom-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] [&_svg]:size-3.5"
              onClick={() => void copyToClipboard(content)}
            >
              {copied ? <ClipboardCheck /> : <Clipboard />}
              {copied ? "Copied" : "Copy to clipboard"}
            </Button>
          </div>
        </div>
      );
    }

    // Use TypewriterMarkdown for both streaming and settled content. Swapping to a
    // different component identity at stream end (previously MarkdownRenderer) caused
    // the entire markdown subtree to unmount/remount — visible as a flash where Shiki
    // highlighting and Mermaid diagrams had to re-run and briefly showed unhighlighted
    // source. isComplete={!isStreaming} makes TypewriterMarkdown bypass smoothing and
    // renders parseIncompleteMarkdown=false, matching the prior static render exactly.
    const contentElement = (
      <TypewriterMarkdown
        content={content}
        isComplete={!isStreaming}
        streamKey={message.historyId}
        streamSource={message.streamPresentation?.source}
        workspaceId={workspaceId}
      />
    );

    // Wrap streaming compaction in special container
    if (isStreamingCompaction) {
      return <CompactingMessageContent>{contentElement}</CompactingMessageContent>;
    }

    return contentElement;
  };

  // Create label with model name and compacted indicator if applicable
  const renderLabel = () => {
    const modelName = message.model;
    const isCompacted = message.isCompacted;
    const isIdleCompacted = message.isIdleCompacted;

    // Keep compaction badges visible beside long model names on narrow transcripts.
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {modelName && (
          <ModelDisplay
            modelString={modelName}
            routedThroughGateway={message.routedThroughGateway}
            routeProvider={message.routeProvider}
          />
        )}
        {message.modelFallback && (
          <ModelFallbackBadge modelFallback={message.modelFallback} effectiveModel={modelName} />
        )}
        {isCompacted && (
          <span className="text-plan-mode bg-plan-mode/10 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {isIdleCompacted ? (
              <Moon aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Package aria-hidden="true" className="h-3 w-3" />
            )}
            <span>{isIdleCompacted ? "idle-compacted" : "compacted"}</span>
          </span>
        )}
      </div>
    );
  };

  const messageWindow = (
    <MessageWindow
      label={renderLabel()}
      variant="assistant"
      message={message}
      buttons={buttons}
      className={className}
      backgroundEffect={isStreamingCompaction ? <CompactionBackground /> : undefined}
    >
      {renderContent()}
    </MessageWindow>
  );

  return (
    <>
      {messageWindow}

      <PopoverError
        error={forkError.error}
        prefix="Failed to fork chat"
        onDismiss={forkError.clearError}
      />
      {startHereModal}
    </>
  );
};
