import React, { useLayoutEffect, useRef, useState } from "react";
import { FileText, Info, Layers } from "lucide-react";
import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import { BASH_DEFAULT_TIMEOUT_SECS } from "@/common/constants/toolLimits";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  ToolIcon,
  ErrorBox,
  ExitCodeBadge,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { formatDuration } from "@/common/utils/formatDuration";
import { cn } from "@/common/lib/utils";
import { ElapsedTimeDisplay } from "./Shared/ElapsedTimeDisplay";
import { useBashToolLiveOutput } from "@/browser/stores/WorkspaceStore";
import { useForegroundBashToolCallIds } from "@/browser/stores/BackgroundBashStore";
import { useBackgroundBashActions } from "@/browser/contexts/BackgroundBashContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { buildBashCollapsedSummary } from "./bashCollapsedSummary";
import { useBashCollapsedSummaryMode } from "./BashCollapsedSummaryModeContext";
import { BackgroundBashOutputDialog } from "@/browser/components/BackgroundBashOutputDialog/BackgroundBashOutputDialog";

interface BashToolCallProps {
  workspaceId?: string;
  toolCallId?: string;
  args: BashToolArgs;
  result?: BashToolResult;
  status?: ToolStatus;
  startedAt?: number;
}

type BashLiveOutputView = NonNullable<ReturnType<typeof useBashToolLiveOutput>>;

const EMPTY_LIVE_OUTPUT: BashLiveOutputView = {
  stdout: "",
  stderr: "",
  combined: "",
  truncated: false,
};

export const BashToolCall: React.FC<BashToolCallProps> = ({
  workspaceId,
  toolCallId,
  args,
  result,
  status = "pending",
  startedAt,
}) => {
  // Bash uses the per-workspace sticky auto-expand preference like every other tool
  // (via useToolExpansion), keyed by tool name. It no longer special-cases the latest
  // streaming command; live output still renders below when the row is expanded.
  const { expanded, toggleExpanded } = useToolExpansion();
  const [outputDialogOpen, setOutputDialogOpen] = useState(false);
  const bashCollapsedSummaryMode = useBashCollapsedSummaryMode();

  const resultHasOutput = typeof result?.output === "string";
  const shouldTrackLiveBashState = Boolean(
    workspaceId &&
    toolCallId &&
    (status === "executing" || (status === "completed" && !resultHasOutput))
  );

  const foregroundBashToolCallIds = useForegroundBashToolCallIds(
    status === "executing" ? workspaceId : undefined
  );
  const { sendToBackground } = useBackgroundBashActions();

  const liveOutput = useBashToolLiveOutput(
    shouldTrackLiveBashState ? workspaceId : undefined,
    shouldTrackLiveBashState ? toolCallId : undefined
  );

  const outputRef = useRef<HTMLPreElement>(null);
  const outputPinnedRef = useRef(true);

  const updatePinned = (el: HTMLPreElement) => {
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    outputPinnedRef.current = distanceToBottom < 40;
  };

  const liveOutputView = liveOutput ?? EMPTY_LIVE_OUTPUT;
  const combinedLiveOutput = liveOutputView.combined;

  const isPending = status === "executing" || status === "pending";
  const backgroundProcessId =
    result && "backgroundProcessId" in result ? result.backgroundProcessId : null;
  const isBackground = args.run_in_background ?? Boolean(backgroundProcessId);

  const bashCollapsedSummary = buildBashCollapsedSummary({
    args,
    result,
    isBackground,
    mode: bashCollapsedSummaryMode,
  });
  const showsDurationInCollapsedSummary = bashCollapsedSummary.kind === "intent-command";

  // Override status for backgrounded processes: the aggregator sees success=true and marks "completed",
  // but for a foreground→background migration we want to show "backgrounded"
  const effectiveStatus: ToolStatus =
    status === "completed" && backgroundProcessId !== null ? "backgrounded" : status;

  const showLiveOutput =
    !isBackground && (status === "executing" || (Boolean(liveOutput) && !resultHasOutput));

  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el || !expanded || !showLiveOutput) return;
    if (outputPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [combinedLiveOutput, expanded, showLiveOutput]);

  const canSendToBackground = Boolean(
    toolCallId && workspaceId && foregroundBashToolCallIds.has(toolCallId)
  );
  const handleSendToBackground =
    toolCallId && workspaceId
      ? () => {
          sendToBackground(toolCallId);
        }
      : undefined;
  const truncatedInfo = result && "truncated" in result ? result.truncated : undefined;
  const note = result && "note" in result ? result.note : undefined;

  const isBackgroundResult = backgroundProcessId !== null;
  const completedOutput = isBackgroundResult ? undefined : result?.output;
  const completedHasOutput = typeof completedOutput === "string" && completedOutput.length > 0;
  const showCompletedOutputSection = !isBackgroundResult && (completedHasOutput || Boolean(note));

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="bash" />
        {bashCollapsedSummary.kind === "intent-command" ? (
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="text-text truncate">{bashCollapsedSummary.intent}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-muted font-monospace min-w-0 flex-1 truncate text-[10px]">
                {bashCollapsedSummary.command}
              </span>
              {!isBackground && (
                <span
                  className={cn(
                    "shrink-0 text-[10px] tabular-nums whitespace-nowrap [@container(max-width:500px)]:hidden",
                    isPending ? "text-pending" : "text-text-secondary"
                  )}
                >
                  {bashCollapsedSummary.durationLabel ? (
                    <>for {bashCollapsedSummary.durationLabel}</>
                  ) : (
                    <>
                      timeout: {args.timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS}s
                      <ElapsedTimeDisplay
                        startedAt={startedAt}
                        isActive={isPending}
                        prefix="for "
                      />
                    </>
                  )}
                </span>
              )}
            </span>
          </span>
        ) : bashCollapsedSummary.kind === "intent" ? (
          <span className="text-text max-w-96 truncate">{bashCollapsedSummary.intent}</span>
        ) : (
          <span className="text-text font-monospace max-w-96 truncate">
            {bashCollapsedSummary.command}
          </span>
        )}
        {isBackground && backgroundProcessId && workspaceId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOutputDialogOpen(true);
                }}
                className="text-muted hover:text-secondary ml-2 rounded p-1 transition-colors"
              >
                <FileText size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>View output</TooltipContent>
          </Tooltip>
        )}
        {isBackground && (
          // Background mode: show icon and display name
          <span className="text-muted ml-2 flex items-center gap-1 text-[10px] whitespace-nowrap">
            <Layers size={10} />
            {args.display_name}
          </span>
        )}
        {!isBackground && !showsDurationInCollapsedSummary && (
          // Normal mode: show timeout and duration
          <span
            className={cn(
              "ml-2 text-[10px] tabular-nums whitespace-nowrap [@container(max-width:500px)]:hidden",
              isPending ? "text-pending" : "text-text-secondary"
            )}
          >
            timeout: {args.timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS}s
            {/* Kernel-mode nested reloads reconstruct partial results without
                wall_duration_ms/exitCode; skip those fields instead of
                rendering "took —" and an empty exit-code pill. */}
            {typeof result?.wall_duration_ms === "number" &&
              ` • took ${formatDuration(result.wall_duration_ms)}`}
            {!result && <ElapsedTimeDisplay startedAt={startedAt} isActive={isPending} />}
          </span>
        )}
        {!isBackground && typeof result?.exitCode === "number" && (
          <ExitCodeBadge exitCode={result.exitCode} className="ml-2" />
        )}
        <StatusIndicator status={effectiveStatus}>
          {getStatusDisplay(effectiveStatus)}
        </StatusIndicator>
        {/* Show "Background" button when bash is executing and can be sent to background.
            Use invisible when executing but not yet confirmed as foreground to avoid layout flash. */}
        {status === "executing" && !isBackground && handleSendToBackground && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation(); // Don't toggle expand
                  handleSendToBackground();
                }}
                disabled={!canSendToBackground}
                className={cn(
                  "ml-2 flex cursor-pointer items-center gap-1 rounded p-1 text-[10px] font-medium transition-colors",
                  "bg-[var(--color-pending)]/20 text-[var(--color-pending)]",
                  "hover:bg-[var(--color-pending)]/30",
                  "disabled:pointer-events-none disabled:invisible"
                )}
              >
                <Layers size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Send to background — process continues but agent stops waiting
            </TooltipContent>
          </Tooltip>
        )}
      </ToolHeader>
      {backgroundProcessId && workspaceId && (
        <BackgroundBashOutputDialog
          open={outputDialogOpen}
          onOpenChange={setOutputDialogOpen}
          workspaceId={workspaceId}
          processId={backgroundProcessId}
          displayName={args.display_name}
          script={args.script}
        />
      )}

      {expanded && (
        <ToolDetails>
          {typeof args.model_intent === "string" && args.model_intent.trim().length > 0 && (
            <DetailSection>
              <DetailLabel>Intent</DetailLabel>
              <DetailContent className="px-2 py-1.5 whitespace-pre-wrap">
                {args.model_intent}
              </DetailContent>
            </DetailSection>
          )}
          <DetailSection>
            <DetailLabel>Script</DetailLabel>
            <DetailContent className="px-2 py-1.5">{args.script}</DetailContent>
          </DetailSection>

          {/* Truncation notices */}
          {showLiveOutput && liveOutputView.truncated && (
            <div className="text-muted px-2 text-[10px] italic">
              Live output truncated (showing last ~1MB)
            </div>
          )}

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {truncatedInfo && (
                <div className="text-muted px-2 text-[10px] italic">
                  Output truncated — reason: {truncatedInfo.reason} • totalLines:{" "}
                  {truncatedInfo.totalLines}
                </div>
              )}
            </>
          )}

          {/* Unified output section — single DOM tree for streaming + completed output
              so React reconciles the same elements instead of unmounting/remounting,
              which preserves scroll position and prevents layout flash. */}
          {(showLiveOutput || showCompletedOutputSection) && (
            <DetailSection>
              <DetailLabel className="flex items-center gap-1">
                <span>Output</span>
                {note && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="View notice"
                        className="text-muted hover:text-secondary translate-y-[-1px] rounded p-0.5 transition-colors"
                      >
                        <Info size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="max-w-xs break-words whitespace-pre-wrap">{note}</div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </DetailLabel>
              <div className="relative">
                <DetailContent
                  ref={outputRef}
                  onScroll={showLiveOutput ? (e) => updatePinned(e.currentTarget) : undefined}
                  className={cn(
                    "px-2 py-1.5",
                    (showLiveOutput ? combinedLiveOutput.length === 0 : !completedHasOutput) &&
                      "text-muted italic"
                  )}
                >
                  {showLiveOutput
                    ? combinedLiveOutput.length > 0
                      ? combinedLiveOutput
                      : status === "redacted"
                        ? "Output excluded from shared transcript"
                        : "No output yet"
                    : completedHasOutput
                      ? completedOutput
                      : "No output"}
                </DetailContent>
              </div>
            </DetailSection>
          )}

          {/* Background process info */}
          {backgroundProcessId && (
            <div className="flex items-center gap-2 text-[11px]">
              <Layers size={12} className="text-muted shrink-0" />
              <span className="text-muted">Background process</span>
              <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
                {backgroundProcessId}
              </code>
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
