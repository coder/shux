import React from "react";
import { cn } from "@/common/lib/utils";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import type { DisplayedMessage } from "@/common/types/message";

interface CompactionBoundaryMessageProps {
  message: Extract<DisplayedMessage, { type: "compaction-boundary" }>;
  className?: string;
}

export const CompactionBoundaryMessage: React.FC<CompactionBoundaryMessageProps> = (props) => {
  const epochLabel =
    typeof props.message.compactionEpoch === "number" ? ` #${props.message.compactionEpoch}` : "";
  const label =
    props.message.boundaryKind === CONTEXT_BOUNDARY_KINDS.RESET
      ? props.message.contextWindowRollover
        ? "Context window rollover"
        : "Context reset"
      : props.message.strategy === "continuous"
        ? `Continuous compaction${epochLabel}`
        : `Compaction boundary${epochLabel}`;

  return (
    <div
      className={cn(
        "my-4 flex items-center gap-3 text-[11px] uppercase tracking-[0.08em]",
        props.className
      )}
      data-testid="compaction-boundary"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
    >
      <span className="bg-border h-px flex-1" />
      <span className="text-muted font-medium">{label}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
};
