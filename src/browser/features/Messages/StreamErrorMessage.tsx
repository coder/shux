import React from "react";
import { AlertTriangle, Bug, ExternalLink } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useCompactAndRetry } from "@/browser/hooks/useCompactAndRetry";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { MUX_GATEWAY_ORIGIN } from "@/common/constants/muxGatewayOAuth";
import { cn } from "@/common/lib/utils";
import { getModelProvider } from "@/common/utils/ai/models";
import type { DisplayedMessage } from "@/common/types/message";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { useOptionalMessageListContext } from "./MessageListContext";

interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  className?: string;
}

interface StreamErrorMessageBaseProps extends StreamErrorMessageProps {
  compactRetryAction?: React.ReactNode;
  compactionDetails?: React.ReactNode;
}

function formatContextTokens(tokens: number): string {
  return formatTokens(tokens).replace(/\.0([kM])$/, "$1");
}

const StreamErrorMessageBase: React.FC<StreamErrorMessageBaseProps> = (props) => {
  const message = props.message;
  const className = props.className;
  const compactRetryAction = props.compactRetryAction;
  const compactionDetails = props.compactionDetails;

  const debugAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST));
          }}
          aria-label="Open last LLM request debug modal"
          className="text-error/80 hover:text-error h-6 w-6"
        >
          <Bug className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="center">
        <div className="flex items-center gap-2">
          <span>Debug last LLM request</span>
          <code className="bg-foreground/5 text-foreground/80 border-foreground/10 rounded-sm border px-1.5 py-0.5 font-mono text-[10px]">
            /debug-llm-request
          </code>
        </div>
      </TooltipContent>
    </Tooltip>
  );

  // Runtime unavailable gets a distinct, friendlier presentation.
  // This is a permanent failure (container/runtime doesn't exist), not a transient stream error.
  // The backend sends "Container unavailable..." for Docker or "Runtime unavailable..." for others.
  if (message.errorType === "runtime_not_ready") {
    // Extract title from error message (e.g., "Container unavailable" or "Runtime unavailable")
    const title = message.error?.split(".")[0] ?? "Runtime Unavailable";
    return (
      <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
        <div className="font-primary text-error mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <span>{title}</span>
          <div className="ml-auto flex items-center">{debugAction}</div>
        </div>
        <div className="text-foreground/80 text-[13px] leading-relaxed">{message.error}</div>
      </div>
    );
  }

  const provider = message.model ? getModelProvider(message.model) : "";
  const isAnthropicOverloaded =
    provider === "anthropic" &&
    message.errorType === "server_error" &&
    /\bHTTP\s*529\b|overloaded/i.test(message.error);
  const isEmptyOutputError = message.errorType === "empty_output";
  const isMaxOutputTokensError = message.errorType === "max_output_tokens";
  // Terminal refusal: distinct from network/empty-output messaging because retrying
  // the same request will refuse again (no auto-retry is scheduled for this type).
  const isModelRefusalError = message.errorType === "model_refusal";
  // Gateway quota failures need explicit attribution so users know mux gateway credits,
  // not a provider quota, are blocking the request.
  const isMuxGatewayQuotaError =
    message.errorType === "quota" && message.routedThroughGateway === true;

  const title = isMuxGatewayQuotaError
    ? "Xum Gateway credits depleted"
    : isAnthropicOverloaded
      ? "Service overloaded"
      : isEmptyOutputError
        ? "No assistant output"
        : isMaxOutputTokensError
          ? "Response truncated"
          : isModelRefusalError
            ? "Model refused to respond"
            : "Stream Error";
  const pill = isAnthropicOverloaded ? "overloaded" : message.errorType;
  const body = isMuxGatewayQuotaError
    ? "Your Xum Gateway credits have been depleted. Add credits or configure another provider to continue."
    : message.error;

  const ctaAction = isMuxGatewayQuotaError ? (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="text-error/80 hover:text-error h-6 px-2 text-[10px]"
    >
      <a href={MUX_GATEWAY_ORIGIN} target="_blank" rel="noopener noreferrer">
        Add credits <ExternalLink className="ml-1 h-3 w-3" />
      </a>
    </Button>
  ) : isAnthropicOverloaded ? (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="text-error/80 hover:text-error h-6 px-2 text-[10px]"
    >
      <a href="https://status.anthropic.com" target="_blank" rel="noopener noreferrer">
        Status <ExternalLink className="ml-1 h-3 w-3" />
      </a>
    </Button>
  ) : null;

  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>{title}</span>
        <code className="bg-foreground/5 text-foreground/80 border-foreground/10 rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {pill}
        </code>
        <div className="ml-auto flex items-center gap-2">
          {showCount && (
            <span className="text-error rounded-sm bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide">
              ×{message.errorCount}
            </span>
          )}
          {ctaAction}
          {debugAction}
        </div>
      </div>
      <div className="text-foreground font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {body}
      </div>
      {compactionDetails}
      {compactRetryAction ? (
        <div className="mt-3 flex items-center justify-start">{compactRetryAction}</div>
      ) : null}
    </div>
  );
};

interface StreamErrorMessageWithRetryProps extends StreamErrorMessageProps {
  workspaceId: string;
}

const StreamErrorMessageWithRetry: React.FC<StreamErrorMessageWithRetryProps> = (props) => {
  const compactAndRetry = useCompactAndRetry({ workspaceId: props.workspaceId });
  const showCompactRetry = compactAndRetry.showCompactionUI;

  let compactRetryLabel = "Compact & retry";
  if (showCompactRetry) {
    if (compactAndRetry.isRetryingWithCompaction) {
      compactRetryLabel = "Starting...";
    } else if (!compactAndRetry.compactionSuggestion || !compactAndRetry.hasTriggerUserMessage) {
      compactRetryLabel = "Insert /compact";
    } else if (compactAndRetry.hasCompactionRequest) {
      compactRetryLabel = "Retry compaction";
    }
  }

  const compactRetryAction = showCompactRetry ? (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        compactAndRetry.retryWithCompaction().catch(() => undefined);
      }}
      disabled={compactAndRetry.isRetryingWithCompaction}
      className="border-warning/50 text-foreground bg-warning/10 hover:bg-warning/15 hover:text-foreground h-6 px-2 text-[10px]"
    >
      {compactRetryLabel}
    </Button>
  ) : null;

  const compactionSuggestion = compactAndRetry.compactionSuggestion;
  const compactionDetails = showCompactRetry ? (
    <div className="font-primary text-foreground/80 mt-3 text-[12px]">
      <span className="text-foreground font-semibold">Context window exceeded.</span>{" "}
      {compactionSuggestion ? (
        compactionSuggestion.kind === "preferred" ? (
          <>
            We&apos;ll compact with your configured compaction model{" "}
            <span className="text-foreground font-semibold">
              {compactionSuggestion.displayName}
            </span>
            {compactionSuggestion.maxInputTokens !== null ? (
              <> ({formatContextTokens(compactionSuggestion.maxInputTokens)} context)</>
            ) : null}{" "}
            to unblock you. Your workspace model stays the same.
          </>
        ) : (
          <>
            We&apos;ll compact with{" "}
            <span className="text-foreground font-semibold">
              {compactionSuggestion.displayName}
            </span>
            {compactionSuggestion.maxInputTokens !== null ? (
              <> ({formatContextTokens(compactionSuggestion.maxInputTokens)} context)</>
            ) : null}{" "}
            to unblock you with a higher-context model. Your workspace model stays the same.
          </>
        )
      ) : (
        <>Compact this chat to unblock you. Your workspace model stays the same.</>
      )}
    </div>
  ) : null;

  return (
    <StreamErrorMessageBase
      message={props.message}
      className={props.className}
      compactRetryAction={compactRetryAction}
      compactionDetails={compactionDetails}
    />
  );
};

// RetryBarrier handles auto-retry; compaction retry UI lives here for stream errors.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = (props) => {
  const messageListContext = useOptionalMessageListContext();
  const latestMessageId = messageListContext?.latestMessageId ?? null;
  const workspaceId = messageListContext?.workspaceId ?? null;
  const isLatestMessage = latestMessageId === props.message.id;

  if (!workspaceId || !isLatestMessage) {
    return <StreamErrorMessageBase message={props.message} className={props.className} />;
  }

  return (
    <StreamErrorMessageWithRetry
      message={props.message}
      className={props.className}
      workspaceId={workspaceId}
    />
  );
};
