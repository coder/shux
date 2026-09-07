import React from "react";
import { cn } from "@/common/lib/utils";
import { getToolIconName, TOOL_ICON_NAMES, type ToolIconName } from "@/common/constants/toolIcons";
import {
  TranscriptIgnoreContextMenu,
  TranscriptQuoteRoot,
} from "@/browser/features/Messages/TranscriptQuoteBoundary";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowDownUp,
  Bell,
  BookOpen,
  Brain,
  BrainCircuit,
  CircleCheck,
  Database,
  FileText,
  GitCommit,
  Globe,
  GraduationCap,
  Hand,
  History,
  Keyboard,
  Layers,
  LayoutGrid,
  Lightbulb,
  MessageCircleQuestion,
  Monitor,
  Move,
  MousePointerClick,
  MessageSquareMore,
  Paperclip,
  Info,
  List,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  ScanEye,
  Square,
  Target,
  Trash2,
  Wrench,
} from "lucide-react";
import { EmojiIcon } from "@/browser/components/icons/EmojiIcon/EmojiIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";

/**
 * Shared styled components for tool UI
 * These primitives provide consistent styling across all tool components
 */

interface ToolContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  expanded: boolean;
}

export const ToolContainer: React.FC<ToolContainerProps> = ({ expanded, className, ...props }) => (
  <div
    className={cn(
      "my-2 rounded font-mono text-[11px] transition-all duration-200",
      "[container-type:inline-size]",
      expanded ? "py-2 px-3" : "py-1 px-3",
      className
    )}
    {...props}
  />
);

export const ToolChrome: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <TranscriptIgnoreContextMenu className={className} {...props} />;

export const ToolHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <ToolChrome
    data-scroll-intent="ignore"
    className={cn(
      "flex items-center gap-2 cursor-pointer select-none text-secondary hover:text-foreground",
      className
    )}
    {...props}
  />
);

interface ExpandIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  expanded: boolean;
}

export const ExpandIcon: React.FC<ExpandIconProps> = ({ expanded, className, ...props }) => (
  <span
    className={cn(
      "inline-block transition-transform duration-200 text-[10px]",
      expanded ? "rotate-90" : "rotate-0",
      className
    )}
    {...props}
  />
);

export const ToolName: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => <span className={cn("font-medium", className)} {...props} />;

interface StatusIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case "executing":
      return "text-pending";
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "interrupted":
      return "text-interrupted";
    case "backgrounded":
      return "text-backgrounded";
    case "redacted":
      return "text-foreground-secondary";
    default:
      return "text-foreground-secondary";
  }
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  className,
  children,
  ...props
}) => (
  <span
    className={cn(
      "text-[10px] ml-auto opacity-80 whitespace-nowrap shrink-0",
      "[&_.status-text]:inline [@container(max-width:350px)]:[&_.status-text]:hidden",
      getStatusColor(status),
      className
    )}
    {...props}
  >
    {children}
  </span>
);

interface ToolDetailsProps extends React.HTMLAttributes<HTMLDivElement> {
  text?: string | null;
}

export const ToolDetails: React.FC<ToolDetailsProps> = ({ text, className, ...props }) => (
  <TranscriptQuoteRoot
    text={text}
    className={cn("mt-2 pt-2 border-t border-white/5 text-foreground", className)}
    {...props}
  />
);

export const DetailSection: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn("my-1.5", className)} {...props} />;

export const DetailLabel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <ToolChrome
    className={cn("text-[10px] text-foreground-secondary mb-1 uppercase tracking-wide", className)}
    {...props}
  />
);

export const DetailContent = React.forwardRef<HTMLPreElement, React.HTMLAttributes<HTMLPreElement>>(
  ({ className, ...props }, ref) => (
    <pre
      ref={ref}
      className={cn(
        "m-0 bg-code-bg rounded-sm text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto",
        className
      )}
      {...props}
    />
  )
);

DetailContent.displayName = "DetailContent";

export const LoadingDots: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => (
  <span
    className={cn(
      "after:inline-block after:w-[3ch] after:text-left after:content-[''] after:animate-[ellipsis_1.2s_steps(4,end)_infinite]",
      className
    )}
    {...props}
  />
);

interface HeaderButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const HeaderButton: React.FC<HeaderButtonProps> = ({ active, className, ...props }) => (
  <button
    className={cn(
      "border border-white/20 text-foreground px-2 py-0.5 rounded-sm cursor-pointer text-[10px]",
      "transition-all duration-200 whitespace-nowrap hover:bg-white/10 hover:border-white/30",
      active && "bg-white/10",
      className
    )}
    {...props}
  />
);

/**
 * Tool icon with tooltip showing tool name.
 *
 * We deliberately render SVG icons instead of emoji glyphs, since emoji rendering varies
 * widely across platforms and fonts.
 */
interface ToolIconProps {
  toolName: string;
  /**
   * Optional emoji provided by the tool call (e.g. status_set). When present, we render a
   * corresponding icon via EmojiIcon.
   */
  emoji?: string;
  /**
   * Optional control for whether the emoji icon should spin.
   *
   * This is useful when the emoji maps to a spinner (e.g. 🔄), but the tool call itself
   * is already completed.
   */
  emojiSpin?: boolean;
  className?: string;
}

const toolIcons: Record<ToolIconName, LucideIcon> = {
  Activity,
  ArrowDownUp,
  Bell,
  BookOpen,
  Brain,
  BrainCircuit,
  CircleCheck,
  Database,
  FileText,
  GitCommit,
  Globe,
  GraduationCap,
  Hand,
  History,
  Keyboard,
  Layers,
  LayoutGrid,
  Lightbulb,
  List,
  MessageCircleQuestion,
  MessageSquareMore,
  Monitor,
  MousePointerClick,
  Move,
  Paperclip,
  Pencil,
  RotateCcw,
  ScanEye,
  Search,
  Sparkles,
  Square,
  Target,
  Trash2,
  Wrench,
};

export const TOOL_NAME_TO_ICON: Partial<Record<string, LucideIcon>> = Object.fromEntries(
  Object.entries(TOOL_ICON_NAMES).map(([toolName, icon]) => [toolName, toolIcons[icon]])
);

export const ToolIcon: React.FC<ToolIconProps> = ({ toolName, emoji, emojiSpin, className }) => {
  const Icon = toolIcons[getToolIconName(toolName)];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center text-secondary [&_svg]:size-3",
            className
          )}
        >
          {emoji ? <EmojiIcon emoji={emoji} spin={emojiSpin} /> : <Icon aria-hidden="true" />}
        </span>
      </TooltipTrigger>
      <TooltipContent>{toolName}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Error display box with danger styling
 */
type ErrorBoxProps = React.HTMLAttributes<HTMLDivElement>;

export const ErrorBox: React.FC<ErrorBoxProps> = ({ className, ...props }) => (
  <div
    className={cn(
      "rounded border-l-2 px-2 py-1.5 text-[11px] text-danger bg-danger-overlay border-danger",
      className
    )}
    {...props}
  />
);

/**
 * Badge for displaying exit codes or process status
 */
interface ExitCodeBadgeProps {
  exitCode: number;
  className?: string;
}

export const ExitCodeBadge: React.FC<ExitCodeBadgeProps> = ({ exitCode, className }) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      exitCode === 0 ? "bg-success text-on-success" : "bg-danger text-on-danger",
      className
    )}
  >
    {exitCode}
  </span>
);

/**
 * Badge for displaying process status (exited, killed, failed, interrupted)
 */
interface ProcessStatusBadgeProps {
  status: "exited" | "killed" | "failed" | "interrupted";
  exitCode?: number;
  className?: string;
}

export const ProcessStatusBadge: React.FC<ProcessStatusBadgeProps> = ({
  status,
  exitCode,
  className,
}) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      status === "exited" && exitCode === 0
        ? "bg-success text-on-success"
        : status === "interrupted"
          ? "bg-warning text-on-warning"
          : "bg-danger text-on-danger",
      className
    )}
  >
    {status}
    {exitCode !== undefined && ` (${exitCode})`}
  </span>
);

/**
 * Badge for output availability status
 */
interface OutputStatusBadgeProps {
  hasOutput: boolean;
  className?: string;
}

export const OutputStatusBadge: React.FC<OutputStatusBadgeProps> = ({ hasOutput, className }) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      hasOutput ? "bg-pending/20 text-pending" : "bg-muted-foreground/20 text-muted-foreground",
      className
    )}
  >
    {hasOutput ? "new output" : "no output"}
  </span>
);

/**
 * Output display section for bash-like tools
 */
interface OutputSectionProps {
  output?: string;
  emptyMessage?: string;
  note?: string;
}

export const OutputSection: React.FC<OutputSectionProps> = ({
  output,
  emptyMessage = "No output",
  note,
}) => {
  const hasOutput = typeof output === "string" && output.length > 0;
  const showLabel = hasOutput || Boolean(note);

  // Preserve existing behavior: when we have no output (and no note), render only the empty message.
  if (!showLabel) {
    return (
      <DetailSection>
        <DetailContent className="text-muted px-2 py-1.5 italic">{emptyMessage}</DetailContent>
      </DetailSection>
    );
  }

  return (
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
      <DetailContent className={cn("px-2 py-1.5", !hasOutput && "text-muted italic")}>
        {hasOutput ? output : emptyMessage}
      </DetailContent>
    </DetailSection>
  );
};
