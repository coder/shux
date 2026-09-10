import type { ReactNode } from "react";
import { ChevronRight, CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { ToolChrome, ToolContainer, ToolDetails, ToolIcon } from "./ToolPrimitives";
import { useToolExpansion, type ToolStatus } from "./toolUtils";

interface AgentCommunicationCardProps {
  toolName: "agent_report" | "task_send_message";
  title: string;
  destination: ReactNode;
  status: ToolStatus;
  statusLabel?: string;
  preview: string;
  initiallyExpanded: boolean;
  children: ReactNode;
  error?: ReactNode;
}

const DELIVERY_LABELS: Record<ToolStatus, string> = {
  pending: "Pending",
  executing: "Sending…",
  completed: "Sent",
  failed: "Not sent",
  interrupted: "Interrupted",
  backgrounded: "Queued",
  redacted: "Redacted",
};

/** Outgoing agent communication should read like the received report, not a command log. */
export function AgentCommunicationCard(props: AgentCommunicationCardProps) {
  const { expanded, toggleExpanded } = useToolExpansion(props.initiallyExpanded);
  const StatusIcon =
    props.status === "completed"
      ? CircleCheck
      : props.status === "failed" || props.status === "interrupted"
        ? CircleAlert
        : Clock3;

  return (
    <ToolContainer
      expanded={expanded}
      className="font-primary rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] py-3 text-sm"
      data-component="AgentCommunicationCard"
    >
      <ToolChrome>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          data-scroll-intent="ignore"
          className="focus-visible:ring-ring flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <ToolIcon toolName={props.toolName} className="text-muted mt-0.5 [&_svg]:size-4" />
          <span className="min-w-0 flex-1 truncate text-sm leading-snug font-medium text-[var(--color-user-text)]">
            {props.title}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn("text-muted mt-0.5 size-4 shrink-0", expanded && "rotate-90")}
          />
        </button>
        <div className="text-muted mt-0.5 ml-6.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-snug">
          <span className="min-w-0 truncate">{props.destination}</span>
          <span aria-hidden="true">·</span>
          <span
            role="status"
            className={cn(
              "inline-flex items-center gap-1",
              props.status === "completed" && "text-success",
              props.status === "failed" && "text-danger",
              props.status === "interrupted" && "text-interrupted",
              (props.status === "executing" || props.status === "backgrounded") &&
                "text-backgrounded"
            )}
          >
            <StatusIcon aria-hidden="true" className="size-3 shrink-0" />
            {props.statusLabel ?? DELIVERY_LABELS[props.status]}
          </span>
        </div>
      </ToolChrome>
      {expanded ? (
        <ToolDetails className="mt-3 border-0 pt-0 text-sm leading-[1.6] [overflow-wrap:anywhere]">
          {props.children}
        </ToolDetails>
      ) : (
        <ToolChrome className="text-muted mt-2 truncate text-xs">
          {props.preview.trim().split("\n")[0]}
        </ToolChrome>
      )}
      {props.error}
    </ToolContainer>
  );
}
