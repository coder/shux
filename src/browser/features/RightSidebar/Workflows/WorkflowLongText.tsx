import React from "react";
import { Maximize2 } from "lucide-react";

import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/browser/components/Dialog/Dialog";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { cn } from "@/common/lib/utils";

import { formatCompactCount, getWorkflowTextPreview } from "./workflowDisplay";

const CONTROL_BUTTON_CLASS =
  "text-muted hover:text-foreground hover:bg-surface-secondary inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium";

interface WorkflowLongTextProps {
  text: string;
  /** Human label for the full-view dialog title and accessible names. */
  title: string;
  /** Render the full text as markdown (agent reports); the preview is always plain text. */
  markdown?: boolean;
  charLimit?: number;
  className?: string;
}

/**
 * Freeform workflow text (prompts/args, reports, errors) can be tens of KB;
 * rendering it in full makes the sidebar unusably long (and mounts a huge DOM).
 * Show a bounded plain-text preview with explicit "Show more" (inline expand)
 * and "Full view" (dialog with copy) affordances. Short text renders exactly as
 * before, with no extra chrome.
 */
export const WorkflowLongText: React.FC<WorkflowLongTextProps> = (props) => {
  const [expanded, setExpanded] = React.useState(false);
  const { preview, truncated, totalChars } = getWorkflowTextPreview(props.text, props.charLimit);

  const fullContent = props.markdown ? (
    <MarkdownRenderer content={props.text} />
  ) : (
    <span className="break-words whitespace-pre-wrap">{props.text}</span>
  );

  if (!truncated) {
    return <div className={cn("min-w-0", props.className)}>{fullContent}</div>;
  }

  return (
    <Dialog>
      <div className={cn("flex min-w-0 flex-col gap-1", props.className)}>
        {expanded ? (
          fullContent
        ) : (
          <span className="break-words whitespace-pre-wrap">{preview}…</span>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={CONTROL_BUTTON_CLASS}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? `Show less of ${props.title}` : `Show more of ${props.title}`}
          >
            {expanded ? "Show less" : `Show more (${formatCompactCount(totalChars)} chars)`}
          </button>
          {/* A registered trigger restores keyboard focus when the full view closes. */}
          <DialogTrigger asChild>
            <button
              type="button"
              className={CONTROL_BUTTON_CLASS}
              aria-label={`Open ${props.title} in full view`}
            >
              <Maximize2 className="h-2.5 w-2.5" /> Full view
            </button>
          </DialogTrigger>
        </div>
        <DialogContent
          className="flex max-h-[85vh] flex-col gap-3 overflow-hidden"
          maxWidth="56rem"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-8 text-sm">
              <span className="min-w-0 truncate">{props.title}</span>
              <CopyButton text={props.text} />
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto text-[12.5px]">{fullContent}</div>
        </DialogContent>
      </div>
    </Dialog>
  );
};
