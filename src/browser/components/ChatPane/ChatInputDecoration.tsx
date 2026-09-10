import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { useChatDockColumnWidthClass } from "./chatDockColumn";

interface ChatInputDecorationProps {
  expanded: boolean;
  onToggle: () => void;
  summary: ReactNode;
  renderExpanded?: () => ReactNode;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
  dataComponent?: string;
  /**
   * Optional icon rendered in the trailing slot of the collapsed row. When
   * omitted the component shows the default expand/collapse chevron. Pass a
   * custom icon (e.g. an external-link / arrow) for "link-style" decorations
   * whose `onToggle` navigates elsewhere instead of expanding inline.
   */
  trailingIcon?: ReactNode;
}

// Keep collapsible decorations aligned with the chat input gutter so swapping
// between pending reviews, queued messages, and background bash banners does
// not make the stack jump horizontally in collapsed state. Encapsulating the
// shared wrapper/button structure here also prevents the collapsed chrome from
// drifting again as individual decorations evolve, while `renderExpanded`
// keeps large hidden detail trees out of collapsed rerenders.
export function ChatInputDecoration(props: ChatInputDecorationProps) {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div
      className={cn("bg-surface-primary", CHAT_DOCK_GUTTER_CLASS, props.className)}
      data-component={props.dataComponent}
    >
      <button
        type="button"
        onClick={props.onToggle}
        className={cn(
          // Use a fixed collapsed row height so every decoration reads with the
          // same top/bottom breathing room regardless of icon/text mix.
          "group mobile-touch-row flex h-6 items-center gap-2 text-xs leading-none transition-colors",
          columnWidthClass,
          props.summaryClassName
        )}
      >
        {props.summary}
        <div className="ml-auto">
          {props.trailingIcon ??
            (props.expanded ? (
              <ChevronDown className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
            ) : (
              <ChevronRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
            ))}
        </div>
      </button>
      {props.expanded && props.renderExpanded && (
        <div className={cn(columnWidthClass, props.contentClassName)}>{props.renderExpanded()}</div>
      )}
    </div>
  );
}
