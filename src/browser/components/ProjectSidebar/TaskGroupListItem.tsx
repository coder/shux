import { ChevronRight, Layers3, Workflow } from "lucide-react";

import { StatusDot, type VisualState } from "@/browser/components/AgentListItem/StatusDot";
import { getSidebarItemPaddingLeft } from "@/browser/components/sidebarItemLayout";
import { cn } from "@/common/lib/utils";
import {
  formatSidebarTaskGroupHeader,
  formatSidebarTaskGroupItemsLabel,
  type SidebarGroupKind,
} from "./sidebarTaskGroups";

interface TaskGroupListItemProps {
  groupId: string;
  title: string;
  kind: SidebarGroupKind;
  sectionId?: string;
  depth: number;
  totalCount: number;
  visibleCount: number;
  completedCount: number;
  /** Workflow run is active between transient worker steps; does not imply a running member. */
  isRunActive?: boolean;
  runningCount: number;
  queuedCount: number;
  interruptedCount: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
}

/**
 * Aggregate member state in the same visual language as agent rows. Running
 * wins over interrupted: while any member still works the group is making
 * progress, so the error-ish interrupted state only surfaces once nothing is
 * running anymore.
 */
function getAggregateVisualState(props: TaskGroupListItemProps): VisualState {
  if (props.isRunActive === true || props.runningCount > 0) {
    return "active";
  }
  if (props.interruptedCount > 0) {
    return "error";
  }
  return "idle";
}

export function TaskGroupListItem(props: TaskGroupListItemProps) {
  const hasRunningWork = props.isRunActive === true || props.runningCount > 0;
  const aggregateState = getAggregateVisualState(props);
  const statusDescriptionId = `task-group-status-${props.groupId}`;
  const paddingLeft = getSidebarItemPaddingLeft(props.depth);
  const KindGlyph = props.kind === "workflow" ? Workflow : Layers3;
  const showProgressFraction = props.kind !== "workflow";
  const statusParts: string[] = [];
  if (props.isRunActive === true) {
    statusParts.push("Workflow running");
  }
  if (props.runningCount > 0) {
    statusParts.push(`${props.runningCount} running`);
  }
  if (props.queuedCount > 0) {
    statusParts.push(`${props.queuedCount} queued`);
  }
  if (props.completedCount > 0) {
    statusParts.push(`${props.completedCount} completed`);
  }
  if (props.interruptedCount > 0) {
    statusParts.push(`${props.interruptedCount} interrupted`);
  }
  if (props.visibleCount !== props.totalCount) {
    statusParts.push(`${props.visibleCount}/${props.totalCount} visible`);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={props.isExpanded}
      aria-label={`${props.isExpanded ? "Collapse" : "Expand"} task group ${props.title}`}
      aria-describedby={statusDescriptionId}
      data-testid={`task-group-${props.groupId}`}
      data-running={hasRunningWork}
      data-aggregate-state={aggregateState}
      className={cn(
        "bg-surface-primary relative flex items-start rounded-l-sm py-2 pr-2 select-none transition-all duration-150 hover:bg-surface-secondary",
        props.sectionId != null ? "ml-2" : "ml-0",
        // Running state must not reuse the selected background: it made active
        // workflow groups look permanently selected. Activity is conveyed by the
        // status dot, green icon, and status text instead (matches AgentListItem).
        props.isSelected && "bg-surface-secondary"
      )}
      style={{ paddingLeft }}
      onClick={() => {
        props.onToggle();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onToggle();
        }
      }}
    >
      {/* Leading slot mirrors agent rows: the sub-agent connector elbow lands on
          the status dot center, so the header reads as part of the tree. */}
      <StatusDot state={aggregateState} isSubAgent />
      {/* Expanded member rows keep their shared rail one-and-a-half indent steps
          in (getTaskGroupMemberDepth), which is exactly this chevron's center -
          the disclosure control visually anchors the member trunk. */}
      <span
        aria-hidden="true"
        className="text-muted -ml-0.5 inline-flex w-3 shrink-0 items-center justify-center self-center"
        data-testid="task-group-chevron"
      >
        <ChevronRight
          className="h-3 w-3 transition-transform duration-150"
          style={{ transform: props.isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </span>
      <div className="ml-1.5 flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className={cn(
            "grid min-w-0 items-center gap-1.5",
            showProgressFraction ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <KindGlyph
              aria-hidden="true"
              className={cn(
                "h-3 w-3 shrink-0",
                hasRunningWork ? "text-content-success" : "text-muted"
              )}
              data-testid="task-group-status-icon"
            />
            <span
              className={cn(
                "min-w-0 truncate text-left text-[14px] leading-6",
                hasRunningWork ? "text-content-primary" : "text-foreground"
              )}
            >
              {formatSidebarTaskGroupHeader(props.kind, props.totalCount, props.title)}
            </span>
          </span>
          {showProgressFraction && (
            <span className="text-muted text-[11px]">
              {props.completedCount}/{props.totalCount}
            </span>
          )}
        </div>
        <div
          id={statusDescriptionId}
          className="text-muted flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-4"
        >
          {statusParts.length > 0 ? (
            statusParts.map((part) => <span key={part}>{part}</span>)
          ) : (
            <span>
              {props.totalCount} {formatSidebarTaskGroupItemsLabel(props.kind).toLowerCase()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
