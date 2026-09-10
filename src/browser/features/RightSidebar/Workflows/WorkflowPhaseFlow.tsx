import React from "react";
import { motion } from "motion/react";
import { Check, GitBranch, Minus, Pause, X } from "lucide-react";

import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useReducedMotion } from "@/browser/hooks/useReducedMotion";
import type { WorkflowPhaseManifest } from "@/common/types/workflow";

import { WorkflowLiveDot } from "./WorkflowBadges";
import { isUnvisitedPhaseLifecycle } from "./projectWorkflowRun";
import type { WorkflowPhaseLifecycle, WorkflowPhaseView } from "./projectWorkflowRun";
import { WORKFLOW_TONE_VAR } from "./workflowDisplay";

/**
 * Compact horizontal phase rail: the workflow's declared (or inferred) phase
 * manifest with live lifecycle states. Deliberately custom SVG-free flex +
 * `motion` rather than Mermaid: live status UI needs cheap re-render and
 * theme-variable styling; Mermaid stays for authored diagrams.
 */
export interface WorkflowPhaseFlowNode {
  name: string;
  label: string;
  lifecycle: WorkflowPhaseLifecycle;
  parallel?: boolean;
  /** Optional tooltip body (declared description or observed phase detail). */
  description?: string;
}

interface WorkflowPhaseFlowProps {
  nodes: readonly WorkflowPhaseFlowNode[];
  /** "inferred" renders a muted provenance hint on the rail. */
  provenance: WorkflowPhaseManifest["provenance"];
  /** Optional phase jump (e.g. scroll the timeline section into view). */
  onPhaseSelect?: (name: string) => void;
  className?: string;
}

/** Pre-run preview nodes: every declared phase rendered as pending. */
export function phaseFlowNodesFromManifest(
  manifest: WorkflowPhaseManifest
): WorkflowPhaseFlowNode[] {
  return manifest.phases.map((phase) => ({
    name: phase.name,
    label: phase.label ?? phase.name,
    lifecycle: "pending",
    ...(phase.parallel === true ? { parallel: true } : {}),
    ...(phase.description != null ? { description: phase.description } : {}),
  }));
}

/** Live nodes from the projected run view (the implicit "" bucket is not a rail phase). */
export function phaseFlowNodesFromView(
  phases: readonly WorkflowPhaseView[]
): WorkflowPhaseFlowNode[] {
  return phases
    .filter((phase) => phase.name !== "")
    .map((phase) => ({
      name: phase.name,
      label: phase.label,
      lifecycle: phase.lifecycle,
      ...(phase.parallel === true ? { parallel: true } : {}),
      ...(phase.detail != null ? { description: phase.detail } : {}),
    }));
}

interface PhaseNodeStyle {
  labelClassName: string;
  marker: React.ReactNode;
}

function getPhaseNodeStyle(lifecycle: WorkflowPhaseLifecycle): PhaseNodeStyle {
  switch (lifecycle) {
    case "pending":
      return {
        labelClassName: "text-muted",
        marker: (
          <span className="border-muted-foreground/50 h-2 w-2 shrink-0 rounded-full border border-dashed" />
        ),
      };
    case "running":
      return { labelClassName: "text-content-primary font-semibold", marker: <WorkflowLiveDot /> };
    case "completed":
      return {
        labelClassName: "text-content-secondary",
        marker: (
          <Check className="h-2.5 w-2.5 shrink-0" style={{ color: WORKFLOW_TONE_VAR.success }} />
        ),
      };
    case "failed":
      return {
        labelClassName: "text-content-primary",
        marker: (
          <X className="h-2.5 w-2.5 shrink-0" style={{ color: WORKFLOW_TONE_VAR.destructive }} />
        ),
      };
    case "interrupted":
      return {
        labelClassName: "text-muted",
        marker: (
          <Pause className="h-2.5 w-2.5 shrink-0" style={{ color: WORKFLOW_TONE_VAR.warning }} />
        ),
      };
    case "skipped":
      return {
        labelClassName: "text-muted/70 line-through decoration-1",
        marker: <Minus className="text-muted/70 h-2.5 w-2.5 shrink-0" />,
      };
    case "not-reached":
      return {
        labelClassName: "text-muted/70",
        marker: (
          <span className="border-muted-foreground/40 h-2 w-2 shrink-0 rounded-full border" />
        ),
      };
    case "not-visited":
      return {
        labelClassName: "text-muted/70",
        marker: <span className="bg-muted-foreground/30 h-1.5 w-1.5 shrink-0 rounded-full" />,
      };
  }
}

const LIFECYCLE_HINT: Record<WorkflowPhaseLifecycle, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
  "not-reached": "Not reached",
  "not-visited": "Not visited",
};

/**
 * Tooltip body for a rail node. The label leads: pills are width-capped and
 * truncate, and labels may run to 120 chars, so the tooltip is the only place
 * the full text is guaranteed readable.
 */
export function phaseNodeTooltip(node: WorkflowPhaseFlowNode): string {
  return [node.label, LIFECYCLE_HINT[node.lifecycle], node.description]
    .filter((part) => part != null && part.length > 0)
    .join(" — ");
}

const PhaseFlowNode: React.FC<{
  node: WorkflowPhaseFlowNode;
  /** Shared layoutId for the active pill; null renders the highlight statically. */
  activeLayoutId: string | null;
  onSelect?: (name: string) => void;
}> = (props) => {
  const node = props.node;
  const style = getPhaseNodeStyle(node.lifecycle);
  const tooltip = phaseNodeTooltip(node);
  const content = (
    <>
      {node.lifecycle === "running" && (
        // Shared layoutId per rail: when the active phase advances, the pill
        // animates from the previous node to the next one. Under
        // prefers-reduced-motion the same pill is drawn in place with no motion.
        <motion.span
          layoutId={props.activeLayoutId ?? undefined}
          className="absolute inset-0 rounded-full"
          style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)" }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      <span className="relative flex min-w-0 items-center gap-1.5">
        {style.marker}
        <span className={`min-w-0 truncate text-[11px] ${style.labelClassName}`}>{node.label}</span>
        {node.parallel === true && (
          <GitBranch className="text-muted h-2.5 w-2.5 shrink-0" aria-label="Fan-out phase" />
        )}
      </span>
    </>
  );
  const sharedClassName =
    "relative flex max-w-[160px] min-w-0 items-center rounded-full px-2 py-0.5";
  // Only visited phases have a step section to jump to (the timeline keeps
  // pending/skipped/not-reached phases on the rail alone), so an unvisited node
  // must not advertise a click/keyboard affordance that would do nothing.
  const selectable = props.onSelect != null && !isUnvisitedPhaseLifecycle(node.lifecycle);
  return (
    <TooltipIfPresent tooltip={tooltip.length > 0 ? tooltip : undefined}>
      {selectable ? (
        <button
          type="button"
          onClick={() => props.onSelect?.(node.name)}
          className={`${sharedClassName} hover:bg-surface-secondary focus-visible:ring-accent cursor-pointer focus-visible:ring-1 focus-visible:outline-none`}
        >
          {content}
        </button>
      ) : (
        // Not focusable, so the hover tooltip is unreachable for keyboard and
        // screen-reader users: expose the lifecycle (and description) as the
        // accessible name instead of the bare label.
        <span className={sharedClassName} role="img" aria-label={tooltip}>
          {content}
        </span>
      )}
    </TooltipIfPresent>
  );
};

export const WorkflowPhaseFlow: React.FC<WorkflowPhaseFlowProps> = (props) => {
  // Unique per rail instance so simultaneous rails (nested runs, several cards)
  // never animate their active pills into each other.
  const layoutId = React.useId();
  const prefersReducedMotion = useReducedMotion();
  const activeLayoutId = prefersReducedMotion ? null : layoutId;
  if (props.nodes.length === 0) {
    return null;
  }
  return (
    <div className={`flex flex-col gap-1 ${props.className ?? ""}`}>
      {/* Wraps at narrow widths (~375px) instead of overflowing the card. */}
      <div className="flex min-w-0 flex-wrap items-center gap-y-1" role="list">
        {props.nodes.map((node, index) => (
          // The connector lives INSIDE the node's flex item so a wrap can never
          // strand a dangling line at the end of a row.
          <span key={node.name} role="listitem" className="flex min-w-0 items-center">
            {index > 0 && <span aria-hidden="true" className="bg-border h-px w-2.5 shrink-0" />}
            <PhaseFlowNode
              node={node}
              activeLayoutId={activeLayoutId}
              onSelect={props.onPhaseSelect}
            />
          </span>
        ))}
        {props.provenance === "inferred" && (
          <TooltipIfPresent tooltip="Phases inferred from the script's phase() calls; order and coverage are best-effort. Declare meta.phases for an exact rail.">
            <span className="text-muted/80 ml-1.5 text-[10px] italic">inferred</span>
          </TooltipIfPresent>
        )}
      </div>
    </div>
  );
};
