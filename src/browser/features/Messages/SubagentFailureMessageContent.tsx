import { ArrowRightLeft, ChevronRight, CircleAlert } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { SubagentFailureEnvelope } from "@/common/utils/subagentFailureEnvelope";

export function SubagentFailureMessageContent(props: { failure: SubagentFailureEnvelope }) {
  // A superseded turn stops reporting, but its workspace keeps running under the new input.
  // Present that handoff without the alarming failure protocol or a misleading workspace error.
  const isSuperseded = props.failure.errorType === "workspace_turn_superseded";
  const StatusIcon = isSuperseded ? ArrowRightLeft : CircleAlert;
  const metadata = [
    ["Task ID", props.failure.taskId],
    ["Error type", props.failure.errorType],
    ["Execution ID", props.failure.executionId],
    ["Execution version", props.failure.executionVersion],
  ];

  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <StatusIcon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", isSuperseded ? "text-muted" : "text-error")}
      />
      <div className="min-w-0 flex-1 text-sm text-[var(--color-user-text)]">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium">
            {isSuperseded ? "New input took over" : "Subagent task failed"}
          </span>
          <span className="text-muted text-xs [overflow-wrap:anywhere]">
            {props.failure.agentType}
          </span>
        </div>
        <p className="text-muted mt-1 leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
          {isSuperseded
            ? "The workspace continues with the new input. This delegated turn won’t return a report."
            : props.failure.errorMessage}
        </p>
        <details className="group mt-2">
          <summary className="text-muted hover:text-foreground focus-visible:ring-ring flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-3 shrink-0 group-open:rotate-90" />
            Technical details
          </summary>
          <div className="mt-2 border-t border-[var(--color-user-border)] pt-2">
            <dl className="space-y-1 text-xs">
              {metadata.map(([label, value]) =>
                value ? (
                  <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-mono [overflow-wrap:anywhere]">{value}</dd>
                  </div>
                ) : null
              )}
            </dl>
            {isSuperseded && (
              <p className="text-muted mt-2 text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                {props.failure.errorMessage}
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
