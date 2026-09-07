import React from "react";
import type { GitStatus } from "@/common/types/workspace";
import type { GitCommit, GitBranchHeader } from "@/common/utils/git/parseGitLog";
import { cn } from "@/common/lib/utils";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { ToggleGroup, ToggleGroupItem } from "../ToggleGroupPrimitive/ToggleGroupPrimitive";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../Dialog/Dialog";
import { BaseSelectorPopover } from "@/browser/features/RightSidebar/CodeReview/BaseSelectorPopover";

// Helper for indicator colors
const getIndicatorColor = (branch: number): string => {
  switch (branch) {
    case 0:
      return "#6bcc6b"; // Green for HEAD
    case 1:
      return "#6ba3cc"; // Blue for origin/main
    case 2:
      return "#b66bcc"; // Purple for origin/branch
    default:
      return "#6b6b6b"; // Gray fallback
  }
};

function formatCountAbbrev(count: number): string {
  const abs = Math.abs(count);

  if (abs < 1000) {
    return String(count);
  }

  if (abs < 1_000_000) {
    const raw = (abs / 1000).toFixed(1);
    const normalized = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    return `${count < 0 ? "-" : ""}${normalized}k`;
  }

  const raw = (abs / 1_000_000).toFixed(1);
  const normalized = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
  return `${count < 0 ? "-" : ""}${normalized}m`;
}

export type GitStatusIndicatorMode = "divergence" | "line-delta";

export interface GitStatusIndicatorViewProps {
  gitStatus: GitStatus | null;
  tooltipPosition?: "right" | "bottom";
  mode: GitStatusIndicatorMode;
  // Tooltip data
  branchHeaders: GitBranchHeader[] | null;
  commits: GitCommit[] | null;
  dirtyFiles: string[] | null;
  isLoading: boolean;
  errorMessage: string | null;
  // Interaction
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (nextMode: GitStatusIndicatorMode) => void;
  // Base ref for divergence (shared with review panel)
  baseRef: string;
  onBaseChange: (value: string) => void;
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
  /** When true, shows shimmer effect to indicate git status is refreshing */
  isRefreshing?: boolean;
}

const CounterPill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="bg-surface-tertiary flex h-5 shrink-0 items-center rounded-md">{children}</span>
);

const CounterPillDivider: React.FC = () => (
  <span className="bg-border-light h-full w-px shrink-0" aria-hidden="true" />
);

/**
 * Pure presentation component for git status indicator.
 * Displays git status (ahead/behind/dirty) and opens divergence details in a dialog.
 * All data is passed as props - no IPC calls or side effects.
 */
export const GitStatusIndicatorView: React.FC<GitStatusIndicatorViewProps> = ({
  gitStatus,
  tooltipPosition: _tooltipPosition = "right",
  mode,
  branchHeaders,
  commits,
  dirtyFiles,
  isLoading,
  errorMessage,
  isOpen,
  onOpenChange,
  onModeChange,
  baseRef,
  onBaseChange,
  isWorking = false,
  isRefreshing = false,
}) => {
  // Handle null gitStatus (initial loading state)
  if (!gitStatus) {
    return (
      <span
        className="text-accent relative flex items-center gap-1 font-mono text-[11px]"
        aria-hidden="true"
      />
    );
  }

  const outgoingLines = gitStatus.outgoingAdditions + gitStatus.outgoingDeletions;
  const incomingLines = gitStatus.incomingAdditions + gitStatus.incomingDeletions;

  // Render empty placeholder when nothing to show (prevents layout shift)
  const isEmpty =
    mode === "divergence"
      ? gitStatus.ahead === 0 && gitStatus.behind === 0 && !gitStatus.dirty
      : outgoingLines === 0 && !gitStatus.dirty && incomingLines === 0;

  if (isEmpty) {
    return (
      <span
        className="text-accent relative flex items-center gap-1 font-mono text-[11px]"
        aria-hidden="true"
      />
    );
  }

  // Render colored indicator characters
  const renderIndicators = (indicators: string) => {
    return (
      <span className="text-placeholder mr-2 shrink-0 font-mono whitespace-pre">
        {Array.from(indicators).map((char, index) => (
          <span key={index} style={{ color: getIndicatorColor(index) }}>
            {char}
          </span>
        ))}
      </span>
    );
  };

  // Render branch header showing which column corresponds to which branch
  const renderBranchHeaders = () => {
    if (!branchHeaders || branchHeaders.length === 0) {
      return null;
    }

    return (
      <div className="border-separator-light mb-2 flex flex-col gap-0.5 border-b pb-2">
        {branchHeaders.map((header, index) => (
          <div key={index} className="flex gap-2 font-mono leading-snug">
            <span className="text-placeholder mr-2 shrink-0 font-mono whitespace-pre">
              {/* Create spacing to align with column */}
              {Array.from({ length: header.columnIndex }).map((_, i) => (
                <span key={i} style={{ color: getIndicatorColor(i) }}>
                  {" "}
                </span>
              ))}
              <span style={{ color: getIndicatorColor(header.columnIndex) }}>!</span>
            </span>
            <span className="text-foreground">[{header.branch}]</span>
          </div>
        ))}
      </div>
    );
  };

  // Render dirty files section
  const renderDirtySection = () => {
    if (!dirtyFiles || dirtyFiles.length === 0) {
      return null;
    }

    const LIMIT = 20;
    const displayFiles = dirtyFiles.slice(0, LIMIT);
    const isTruncated = dirtyFiles.length > LIMIT;

    return (
      <div className="border-separator-light mb-2 border-b pb-2">
        <div className="text-git-dirty mb-1 font-mono font-semibold">Uncommitted changes:</div>
        <div className="flex flex-col gap-px">
          {displayFiles.map((line, index) => (
            <div
              key={index}
              className="text-foreground font-mono text-[11px] leading-snug whitespace-pre"
            >
              {line}
            </div>
          ))}
        </div>
        {isTruncated && (
          <div className="text-muted-light mt-1 text-[10px] italic">
            (showing {LIMIT} of {dirtyFiles.length} files)
          </div>
        )}
      </div>
    );
  };

  const renderTooltipContent = () => {
    if (isLoading) {
      return "Loading...";
    }

    if (errorMessage) {
      return errorMessage;
    }

    if (!commits || commits.length === 0) {
      return "No commits to display";
    }

    return (
      <>
        {renderDirtySection()}
        {renderBranchHeaders()}
        <div className="flex flex-col gap-1">
          {commits.map((commit, index) => (
            <div key={`${commit.hash}-${index}`} className="flex flex-col gap-0.5">
              <div className="flex gap-2 font-mono leading-snug">
                {renderIndicators(commit.indicators)}
                <span className="text-accent shrink-0 select-all">{commit.hash}</span>
                <span className="text-muted-light shrink-0">{commit.date}</span>
                <span className="text-foreground flex-1 break-words">{commit.subject}</span>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };

  const outgoingHasDelta = gitStatus.outgoingAdditions > 0 || gitStatus.outgoingDeletions > 0;
  const hasCommitDivergence = gitStatus.ahead > 0 || gitStatus.behind > 0;

  // Dynamic color based on working state
  // Idle: muted/grayscale, Working: original accent colors
  const statusColor = isWorking ? "text-accent" : "text-muted";
  const dirtyColor = isWorking ? "text-git-dirty" : "text-muted";
  const additionsColor = isWorking ? "text-success-light" : "text-muted";
  const deletionsColor = isWorking ? "text-warning-light" : "text-muted";

  // Dialog content with git divergence details
  const dialogContent = (
    <>
      <div className="border-separator-light mb-2 flex flex-col gap-1 border-b pb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-light">Divergence:</span>
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(value) => {
              if (!value) return;
              onModeChange(value as GitStatusIndicatorMode);
            }}
            aria-label="Git status indicator mode"
            size="sm"
          >
            <ToggleGroupItem value="line-delta" aria-label="Show line delta" size="sm">
              Lines
            </ToggleGroupItem>
            <ToggleGroupItem value="divergence" aria-label="Show commit divergence" size="sm">
              Commits
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-light">Base:</span>
          <BaseSelectorPopover value={baseRef} onChange={onBaseChange} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="text-muted-light">Overview:</span>
          {outgoingHasDelta || incomingLines > 0 ? (
            <span className="flex items-center gap-2">
              {gitStatus.outgoingAdditions > 0 && (
                <span className={cn("font-normal", additionsColor)}>
                  +{formatCountAbbrev(gitStatus.outgoingAdditions)}
                </span>
              )}
              {gitStatus.outgoingDeletions > 0 && (
                <span className={cn("font-normal", deletionsColor)}>
                  -{formatCountAbbrev(gitStatus.outgoingDeletions)}
                </span>
              )}
              {incomingLines > 0 && (
                <span className="text-muted">↓{formatCountAbbrev(incomingLines)}</span>
              )}
            </span>
          ) : (
            <span className="text-muted">Lines: 0</span>
          )}
          {hasCommitDivergence ? (
            <span className="text-muted">
              Commits: {formatCountAbbrev(gitStatus.ahead)} ahead ·{" "}
              {formatCountAbbrev(gitStatus.behind)} behind
            </span>
          ) : (
            <span className="text-muted">Commits: 0</span>
          )}
        </div>
      </div>

      {renderTooltipContent()}
    </>
  );

  const triggerContent = (
    <>
      {mode === "divergence" ? (
        hasCommitDivergence && (
          <CounterPill>
            {gitStatus.ahead > 0 && (
              <span className="flex items-center px-1.5 font-normal">
                ↑{formatCountAbbrev(gitStatus.ahead)}
              </span>
            )}
            {gitStatus.ahead > 0 && gitStatus.behind > 0 && <CounterPillDivider />}
            {gitStatus.behind > 0 && (
              <span className="flex items-center px-1.5 font-normal">
                ↓{formatCountAbbrev(gitStatus.behind)}
              </span>
            )}
          </CounterPill>
        )
      ) : (
        <>
          {outgoingHasDelta ? (
            <CounterPill>
              {gitStatus.outgoingAdditions > 0 && (
                <span className={cn("flex items-center px-1.5 font-normal", additionsColor)}>
                  +{formatCountAbbrev(gitStatus.outgoingAdditions)}
                </span>
              )}
              {gitStatus.outgoingAdditions > 0 && gitStatus.outgoingDeletions > 0 && (
                <CounterPillDivider />
              )}
              {gitStatus.outgoingDeletions > 0 && (
                <span className={cn("flex items-center px-1.5 font-normal", deletionsColor)}>
                  -{formatCountAbbrev(gitStatus.outgoingDeletions)}
                </span>
              )}
            </CounterPill>
          ) : (
            // Keep line-delta mode in line units when only incoming changes exist.
            incomingLines > 0 && (
              <span className="text-muted flex items-center font-normal">
                ↓{formatCountAbbrev(incomingLines)}
              </span>
            )
          )}
        </>
      )}
      {gitStatus.dirty && (
        <span className={cn("flex items-center leading-none font-normal", dirtyColor)}>*</span>
      )}
    </>
  );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      {/* Click to inspect divergence details; hover previews were removed per UX request. */}
      <button
        type="button"
        className={cn(
          "relative flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-mono text-[11px] transition-colors",
          statusColor,
          isRefreshing && "animate-pulse"
        )}
        aria-label="View git divergence details"
        onKeyDown={stopKeyboardPropagation}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(true);
        }}
      >
        {triggerContent}
      </button>
      <DialogContent
        // Give divergence details a bit more room before falling back to horizontal scroll.
        maxWidth="860px"
        maxHeight="80vh"
        className="bg-modal-bg text-foreground border-separator-light z-[10000] w-[min(92vw,860px)] min-w-0 overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre shadow-[0_4px_12px_rgba(0,0,0,0.5)]"
      >
        <DialogHeader className="mb-1">
          <DialogTitle className="text-foreground text-sm">Git divergence details</DialogTitle>
        </DialogHeader>
        {dialogContent}
      </DialogContent>
    </Dialog>
  );
};
