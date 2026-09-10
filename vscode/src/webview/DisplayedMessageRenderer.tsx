import React from "react";

import type { DisplayedMessage } from "xum/common/types/message";

import { AssistantMessage } from "xum/browser/features/Messages/AssistantMessage";
import { HistoryHiddenMessage } from "xum/browser/features/Messages/HistoryHiddenMessage";
import { InitMessage } from "xum/browser/features/Messages/InitMessage";
import { MarkdownRenderer } from "xum/browser/features/Messages/MarkdownRenderer";
import { MessageWindow } from "xum/browser/features/Messages/MessageWindow";
import { ReasoningMessage } from "xum/browser/features/Messages/ReasoningMessage";
import { StreamErrorMessage } from "xum/browser/features/Messages/StreamErrorMessage";
import { ToolMessage } from "xum/browser/features/Messages/ToolMessage";
import { UserMessage } from "xum/browser/features/Messages/UserMessage";

export function DisplayedMessageRenderer(props: {
  message: DisplayedMessage;
  workspaceId: string | null;
}): JSX.Element | null {
  const message = props.message;

  switch (message.type) {
    case "user":
      return <UserMessage message={message} />;

    case "assistant":
      return <AssistantMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    case "reasoning":
      return <ReasoningMessage message={message} />;

    case "stream-error":
      return <StreamErrorMessage message={message} />;

    case "history-hidden":
      return <HistoryHiddenMessage message={message} />;

    case "workspace-init":
      return <InitMessage message={message} />;

    case "plan-display": {
      // Ephemeral plan output (e.g. /plan). Render it as an assistant-style markdown block.
      return (
        <MessageWindow label={null} variant="assistant" message={message}>
          <MarkdownRenderer content={message.content} />
        </MessageWindow>
      );
    }

    case "tool":
      return <ToolMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    case "generated-image": {
      const imageCount = message.images.length;
      return (
        <MessageWindow label={null} variant="assistant" message={message}>
          <div className="border-border-light bg-background-secondary rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
              <div className="text-foreground text-sm font-medium">
                Generated {imageCount === 1 ? "image" : `${imageCount} images`}
              </div>
              <div className="text-muted text-xs">{message.model}</div>
            </div>
            <div className="text-muted mb-3 line-clamp-3 text-xs">{message.prompt}</div>
            <div className="space-y-1">
              {message.images.map((image, index) => (
                <div key={`${image.path}-${index}`} className="text-muted min-w-0 text-xs">
                  <code className="truncate" title={image.path}>
                    {image.path}
                  </code>
                </div>
              ))}
            </div>
            {message.warnings && message.warnings.length > 0 && (
              <div className="text-warning mt-3 text-xs">{message.warnings.join(" ")}</div>
            )}
          </div>
        </MessageWindow>
      );
    }

    default: {
      const _exhaustive: never = message;
      console.error("mux webview: unknown displayed message", _exhaustive);
      return null;
    }
  }
}
