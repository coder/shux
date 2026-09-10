import React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  FileText,
  GitBranch,
  Layers,
  ListTree,
  X,
  Zap,
} from "lucide-react";

import { WorkflowJsonBlock } from "@/browser/features/Tools/WorkflowToolShared";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useReducedMotion } from "@/browser/hooks/useReducedMotion";
import { useWorkflowRunById } from "@/browser/hooks/useWorkflowRunById";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  isActiveWorkflowChildEventStatus,
  isActiveWorkflowRunStatus,
} from "@/common/types/workflow";

import { WorkflowLiveDot } from "./WorkflowBadges";
import { WorkflowLongText } from "./WorkflowLongText";
import { WorkflowPhaseFlow, phaseFlowNodesFromView } from "./WorkflowPhaseFlow";
import {
  getActiveWorkflowPhase,
  isUnvisitedPhaseLifecycle,
  projectWorkflowRun,
  type WorkflowPhaseView,
  type WorkflowRunView,
  type WorkflowStepView,
} from "./projectWorkflowRun";
import {
  WORKFLOW_TONE_VAR,
  formatWorkflowCost,
  formatWorkflowDuration,
  formatWorkflowTokens,
  getWorkflowStepTone,
  hasDisplayableWorkflowReport,
  workflowStructuredOutputEntries,
} from "./workflowDisplay";

const ASK_MODE_BORDER = "color-mix(in srgb, var(--color-ask-mode) 35%, transparent)";
const MAX_INLINE_NESTED_WORKFLOW_DEPTH = 3;

interface WorkflowTimelineProps {
  view: WorkflowRunView;
  workspaceId?: string;
  nestedDepth?: number;
  showFinalReport?: boolean;
}

interface WorkflowPhaseSectionProps {
  phase: WorkflowPhaseView;
  workspaceId?: string;
  nestedDepth: number;
  /** Registers the section root so the phase rail can scroll it into view. */
  sectionRef?: (element: HTMLDivElement | null) => void;
}

interface WorkflowStepRowProps {
  step: WorkflowStepView;
  isLast: boolean;
  workspaceId?: string;
  nestedDepth: number;
}

function getNestedWorkflowSummary(input: {
  childView: WorkflowRunView | null;
  fallbackStatus?: WorkflowStepView["nestedWorkflowStatus"];
}): string {
  if (input.childView == null) {
    return input.fallbackStatus ?? "loading";
  }
  const activePhase = getActiveWorkflowPhase(input.childView.phases);
  const phaseLabel =
    activePhase != null && activePhase.label.length > 0 ? ` · ${activePhase.label}` : "";
  return `${input.childView.status} · ${input.childView.stats.done}/${input.childView.stats.total} steps${phaseLabel}`;
}

const WorkflowStepNode: React.FC<{ step: WorkflowStepView; color: string }> = (props) => {
  if (props.step.status === "running") {
    return <WorkflowLiveDot />;
  }
  if (props.step.status === "completed") {
    return <Check className="h-2.5 w-2.5" style={{ color: props.color }} />;
  }
  if (props.step.status === "failed") {
    return <X className="h-2.5 w-2.5" style={{ color: props.color }} />;
  }
  // interrupted
  return <span className="h-1.5 w-1.5 rounded-full" style={{ background: props.color }} />;
};

/**
 * Disclosure state that opens when a signal is initially true AND auto-opens if the value
 * transitions to true later — e.g. a live run whose phase/step fails, or a nested workflow event
 * arriving after the parent row has already mounted. Uses React's "adjust state during render"
 * pattern (no effect). The user can still collapse it afterward; only a fresh false→true
 * transition forces it open.
 */
function useDisclosureOpenOnSignal(
  failed: boolean,
  defaultOpen = false
): readonly [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = React.useState(failed || defaultOpen);
  const [prevFailed, setPrevFailed] = React.useState(failed);
  const [prevDefaultOpen, setPrevDefaultOpen] = React.useState(defaultOpen);
  if (failed !== prevFailed) {
    setPrevFailed(failed);
    if (failed) {
      setOpen(true);
    }
  }
  if (defaultOpen !== prevDefaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen) {
      setOpen(true);
    }
  }
  return [open, setOpen] as const;
}

const NestedWorkflowStepPanel: React.FC<{
  step: WorkflowStepView;
  workspaceId?: string;
  nestedDepth: number;
  parentOpen: boolean;
}> = (props) => {
  const nestedRunId = props.step.nestedWorkflowRunId;
  const withinDepthLimit = props.nestedDepth < MAX_INLINE_NESTED_WORKFLOW_DEPTH;
  const fallbackActive = isActiveWorkflowChildEventStatus(props.step.nestedWorkflowStatus);
  // Poll while the panel is mounted: checkpoint retries can reuse the child run id without a new
  // parent started event, so the durable child record is the source of truth for live progress.
  const childRunState = useWorkflowRunById({
    workspaceId: props.workspaceId,
    runId: nestedRunId,
    enabled:
      nestedRunId != null &&
      props.workspaceId != null &&
      withinDepthLimit &&
      (props.parentOpen || fallbackActive),
    pollAfterTerminal: true,
    pollWhileActive: true,
  });
  const childRun = childRunState.run;
  const childView = childRun != null ? projectWorkflowRun(childRun) : null;
  const childActive = childRun != null && isActiveWorkflowRunStatus(childRun.status);
  const childSummary = getNestedWorkflowSummary({
    childView,
    fallbackStatus: props.step.nestedWorkflowStatus,
  });

  if (nestedRunId == null) {
    return null;
  }

  return (
    <div className="border-border bg-surface-secondary/40 mt-2.5 flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {childActive || (childRun == null && fallbackActive) ? <WorkflowLiveDot /> : null}
        <span className="text-content-primary min-w-0 truncate text-xs font-semibold">
          Nested workflow {props.step.nestedWorkflowName ?? props.step.title}
        </span>
        <span className="text-muted counter-nums-mono min-w-0 truncate text-[10px]">
          {nestedRunId}
        </span>
      </div>
      <div className="text-muted text-[11px]">{childSummary}</div>

      {!withinDepthLimit ? (
        <div className="text-muted text-[11px]">
          Nested workflow depth limit reached; showing summary only.
        </div>
      ) : childRunState.error != null ? (
        <div className="text-danger text-[11px]">{childRunState.error}</div>
      ) : childRunState.loading && childRun == null ? (
        <div className="text-muted text-[11px]">Loading nested workflow…</div>
      ) : childRun != null && childView != null ? (
        <div className="border-border/70 border-l pl-3">
          <WorkflowTimeline
            view={childView}
            workspaceId={childRun.workspaceId}
            nestedDepth={props.nestedDepth + 1}
          />
        </div>
      ) : (
        <div className="text-muted text-[11px]">Nested workflow run is not available.</div>
      )}
    </div>
  );
};

const WorkflowStepRow: React.FC<WorkflowStepRowProps> = (props) => {
  const step = props.step;
  const hasNestedWorkflow = step.nestedWorkflowRunId != null;
  const showReport = hasDisplayableWorkflowReport(
    step.result?.reportMarkdown,
    step.result?.structuredOutput !== undefined
  );
  const hasResultTitle = step.result?.title != null && step.result.title.length > 0;
  const hasStructuredOutput = step.result?.structuredOutput !== undefined;
  const hasStepMetadata =
    step.durationMs != null ||
    step.usage?.tokens != null ||
    step.usage?.costUsd != null ||
    step.taskId != null;
  const hasStandaloneStepResult =
    !hasNestedWorkflow && (hasResultTitle || showReport || hasStructuredOutput);
  const hasStandaloneStepMetadata = hasStepMetadata && !hasNestedWorkflow;
  const hasStepDetailContent =
    step.status === "failed" || hasStandaloneStepResult || hasStandaloneStepMetadata;
  const expandable =
    step.status === "failed" ||
    hasNestedWorkflow ||
    (step.status === "completed" && hasStepDetailContent);
  // Surface failures by default (including live failures that arrive after the row mounted while
  // running); active nested workflows also start open so their child progress is visible.
  const [open, setOpen] = useDisclosureOpenOnSignal(
    step.status === "failed",
    hasNestedWorkflow &&
      (step.status === "running" || isActiveWorkflowChildEventStatus(step.nestedWorkflowStatus))
  );
  const color = WORKFLOW_TONE_VAR[getWorkflowStepTone(step.status)];
  const workspaceStore = useWorkspaceStoreRaw();
  // Subscribe to derived workspace metadata so the Open action disappears once the
  // child workspace is deleted; it shows only while the step's workspace still exists.
  const canOpenWorkspace = React.useSyncExternalStore(
    workspaceStore.subscribeDerived,
    () =>
      step.taskWorkspaceId != null &&
      workspaceStore.getWorkspaceMetadata(step.taskWorkspaceId) != null,
    () => false
  );
  const openTaskWorkspace = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (step.taskWorkspaceId == null) {
      return;
    }
    workspaceStore.navigateToWorkspace(step.taskWorkspaceId);
  };
  const headerContent = (
    <>
      <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">{step.title}</span>
      {step.status === "completed" && step.durationMs != null && (
        <span className="text-muted shrink-0 text-[11px] tabular-nums">
          {formatWorkflowDuration(step.durationMs)}
        </span>
      )}
      {step.status === "running" && (
        <span className="text-accent shrink-0 text-[11px]">running…</span>
      )}
      {step.status === "failed" && (
        <span className="shrink-0 text-[11px]" style={{ color }}>
          failed
        </span>
      )}
      {hasNestedWorkflow && (
        <span className="border-border text-plan-mode shrink-0 rounded border px-1.5 py-px text-[10px]">
          nested
        </span>
      )}
      {expandable &&
        (open ? (
          <ChevronDown className="text-muted h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3 shrink-0" />
        ))}
    </>
  );

  const nestedWorkflowPanel = hasNestedWorkflow ? (
    <NestedWorkflowStepPanel
      step={step}
      workspaceId={props.workspaceId}
      nestedDepth={props.nestedDepth}
      parentOpen={open}
    />
  ) : null;

  return (
    <div className="flex gap-3">
      <div className="relative flex w-[18px] shrink-0 flex-col items-center">
        <span
          className="bg-background z-10 mt-2 grid h-[17px] w-[17px] place-items-center rounded-full border"
          style={{ borderColor: color }}
        >
          <WorkflowStepNode step={step} color={color} />
        </span>
        {!props.isLast && <span className="bg-border w-px flex-1" />}
      </div>
      <div className="min-w-0 flex-1 pt-0.5 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="hover:bg-surface-secondary flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
              aria-expanded={open}
            >
              {headerContent}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left">
              {headerContent}
            </div>
          )}
          {canOpenWorkspace && (
            <button
              type="button"
              aria-label={`Open workspace for workflow step ${step.title}`}
              onClick={openTaskWorkspace}
              className="border-border bg-surface-primary text-content-secondary hover:bg-surface-secondary shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium"
            >
              Open
            </button>
          )}
        </div>

        {open &&
          expandable &&
          (hasStepDetailContent ? (
            <div className="border-border bg-surface-primary mx-2 mb-1.5 rounded-lg border p-3">
              {step.status === "failed" ? (
                <div className="flex gap-2 text-[12.5px] leading-relaxed" style={{ color }}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <WorkflowLongText
                    className="flex-1"
                    text={step.error ?? "Sub-agent failed"}
                    title={`${step.title} — error`}
                  />
                </div>
              ) : (
                <>
                  {hasResultTitle && (
                    <div className="text-content-primary mb-1.5 text-xs font-semibold">
                      {step.result?.title}
                    </div>
                  )}
                  {showReport && (
                    <div className="text-content-secondary text-[12.5px]">
                      <WorkflowLongText
                        markdown
                        text={step.result!.reportMarkdown}
                        title={`${step.title} — report`}
                      />
                    </div>
                  )}
                  {hasStructuredOutput && (
                    <div className="mt-2.5 flex flex-col gap-1">
                      <div className="text-muted text-[10px] font-semibold tracking-wide uppercase">
                        Structured output
                      </div>
                      <WorkflowJsonBlock
                        value={step.result?.structuredOutput}
                        className="max-h-[220px]"
                        ariaLabel={`Structured output for ${step.title}`}
                      />
                    </div>
                  )}
                  {hasStepMetadata && (
                    <div className="border-border text-muted mt-2.5 flex flex-wrap gap-3 border-t pt-2 text-[11px] tabular-nums">
                      {step.durationMs != null && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {formatWorkflowDuration(step.durationMs)}
                        </span>
                      )}
                      {step.usage?.tokens != null && (
                        <span className="inline-flex items-center gap-1">
                          <Zap className="h-3 w-3" /> {formatWorkflowTokens(step.usage.tokens)} tok
                        </span>
                      )}
                      {step.usage?.costUsd != null && (
                        <span className="inline-flex items-center gap-1">
                          <Coins className="h-3 w-3" /> {formatWorkflowCost(step.usage.costUsd)}
                        </span>
                      )}
                      {step.taskId != null && <span className="font-mono">task {step.taskId}</span>}
                    </div>
                  )}
                </>
              )}
              {nestedWorkflowPanel}
            </div>
          ) : (
            <div className="mx-2 mb-1.5">{nestedWorkflowPanel}</div>
          ))}
      </div>
    </div>
  );
};

const WorkflowPhaseSection: React.FC<WorkflowPhaseSectionProps> = (props) => {
  const phase = props.phase;
  const allDone = phase.total > 0 && phase.done === phase.total;
  // Phase events can carry a structured `details` info object (e.g. {angleCount, maxSources}).
  const detailObject =
    phase.details != null && typeof phase.details === "object" ? phase.details : null;
  const hasInfo = phase.detail != null || detailObject != null;
  // The header collapses the whole phase body (its details + steps) in one click. Collapsed by
  // default to keep a fanned-out run (20+ steps) scannable — except failed phases, which start
  // open so the failure (and the failed step's error) is visible without a manual expand.
  const hasBody = phase.steps.length > 0 || hasInfo;
  const [open, setOpen] = useDisclosureOpenOnSignal(phase.failed);

  const headerContent = (
    <>
      <span className="border-border bg-surface-secondary text-content-secondary grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md border">
        <Layers className="h-3 w-3" />
      </span>
      {phase.label.length > 0 && (
        // Declared labels may run to 120 chars: truncate so the count/status/disclosure
        // cells stay on-card at narrow widths, with the full text one hover away.
        <TooltipIfPresent tooltip={phase.label}>
          <span className="text-content-primary min-w-0 truncate text-[13px] font-semibold">
            {phase.label}
          </span>
        </TooltipIfPresent>
      )}
      {phase.total > 0 && (
        <span className="text-muted text-[11px] tabular-nums">
          {phase.done}/{phase.total}
        </span>
      )}
      {phase.steps.length > 1 && (
        <span
          className="text-ask-mode inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px]"
          style={{ borderColor: ASK_MODE_BORDER }}
        >
          <GitBranch className="h-2.5 w-2.5" /> parallel
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {phase.running ? (
          <WorkflowLiveDot />
        ) : phase.failed ? (
          <AlertTriangle className="h-3 w-3" style={{ color: WORKFLOW_TONE_VAR.destructive }} />
        ) : allDone ? (
          <Check className="text-success h-3 w-3" />
        ) : null}
        {hasBody &&
          (open ? (
            <ChevronDown className="text-muted h-3 w-3" />
          ) : (
            <ChevronRight className="text-muted h-3 w-3" />
          ))}
      </span>
    </>
  );

  return (
    <div ref={props.sectionRef}>
      {hasBody ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="hover:bg-surface-secondary flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 text-left"
          aria-expanded={open}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 py-1.5">{headerContent}</div>
      )}
      {open && hasInfo && (
        <div className="mb-1.5 ml-[30px] flex flex-col gap-1">
          {phase.detail != null && (
            <div className="text-content-secondary text-[12px]">
              <WorkflowLongText
                text={phase.detail}
                title={`${phase.label.length > 0 ? phase.label : "Phase"} — details`}
              />
            </div>
          )}
          {detailObject != null && (
            <WorkflowJsonBlock
              value={detailObject}
              className="max-h-[200px]"
              ariaLabel={`${phase.label} details`}
            />
          )}
        </div>
      )}
      {open && phase.steps.length > 0 && (
        <div className="flex flex-col">
          {phase.steps.map((step, index) => (
            <WorkflowStepRow
              key={step.stepId}
              step={step}
              isLast={index === phase.steps.length - 1}
              workspaceId={props.workspaceId}
              nestedDepth={props.nestedDepth}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const WorkflowFinalReport: React.FC<{ view: WorkflowRunView }> = (props) => {
  // Collapsible (expanded by default) so a long report/structured output can be folded away.
  const [open, setOpen] = React.useState(true);
  const result = props.view.result;
  if (result == null) {
    return null;
  }
  const stats = workflowStructuredOutputEntries(result.structuredOutput);
  const showReport = hasDisplayableWorkflowReport(
    result.reportMarkdown,
    result.structuredOutput !== undefined
  );
  // The full machine-readable result returned to the agent/model. Treat an explicit `null` as
  // present (render it) — only `undefined` means "no structured output", matching the step
  // renderer and chat card; `!= null` would hide a valid null output and leave an empty report.
  const hasStructuredOutput = result.structuredOutput !== undefined;
  return (
    <div
      className="bg-surface-primary flex flex-col gap-2.5 rounded-xl border p-3.5"
      style={{ borderColor: "color-mix(in srgb, var(--color-success) 30%, var(--color-border))" }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-muted flex w-full items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase"
        aria-expanded={open}
      >
        <FileText className="h-3 w-3" /> Final report
        <span className="ml-auto">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {open && (
        <>
          {showReport && (
            <div className="text-content-secondary text-[12.5px]">
              <WorkflowLongText markdown text={result.reportMarkdown} title="Final report" />
            </div>
          )}
          {stats.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {/* Field labels lead and stay emphasized so report chips scan as key → value. */}
              {stats.map((stat) => (
                <span
                  key={stat.key}
                  className="border-border bg-surface-secondary text-muted rounded-md border px-2 py-0.5 text-[11px] tabular-nums"
                >
                  <b className="text-content-primary font-semibold">{stat.key}</b> {stat.value}
                </span>
              ))}
            </div>
          )}
          {hasStructuredOutput && (
            <div className="flex flex-col gap-1">
              <div className="text-muted text-[10px] font-semibold tracking-wide uppercase">
                Structured output
              </div>
              <WorkflowJsonBlock
                value={result.structuredOutput}
                className="max-h-[280px]"
                ariaLabel="Workflow structured output"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** "Timeline" run body: a vertical stream of phases and their agent steps. */
export const WorkflowTimeline: React.FC<WorkflowTimelineProps> = (props) => {
  const view = props.view;
  const nestedDepth = props.nestedDepth ?? 0;
  const phaseManifest = view.workflow.phaseManifest;
  // The step stream keeps today's observed-only sections: declared-but-unvisited
  // phases live on the rail (pending/skipped/…), not as empty step sections.
  const visitedPhases = view.phases.filter((phase) => !isUnvisitedPhaseLifecycle(phase.lifecycle));
  const phaseSectionRefs = React.useRef(new Map<string, HTMLDivElement>());
  const prefersReducedMotion = useReducedMotion();
  const scrollToPhase = (name: string) => {
    phaseSectionRefs.current
      .get(name)
      ?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  };
  return (
    <div className="flex flex-col gap-4">
      {/* Surface a run-level failure (e.g. setup/compile/eval errors that occur before any step)
          so a failed run never shows just "No steps yet" with no reason. */}
      {view.errorMessage != null && view.status === "failed" && (
        <div
          className="flex gap-2 rounded-lg border p-3 text-[12.5px] leading-relaxed"
          style={{
            color: WORKFLOW_TONE_VAR.destructive,
            borderColor: "color-mix(in srgb, var(--color-danger) 35%, transparent)",
            background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
          }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <WorkflowLongText className="flex-1" text={view.errorMessage} title="Workflow error" />
        </div>
      )}
      {props.showFinalReport !== false && <WorkflowFinalReport view={view} />}
      {/* Runs without a manifest render exactly as before (no rail). */}
      {phaseManifest != null && (
        <div className="flex flex-col gap-1">
          <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
            <GitBranch className="h-3 w-3" /> Phases
          </div>
          <WorkflowPhaseFlow
            nodes={phaseFlowNodesFromView(view.phases)}
            provenance={phaseManifest.provenance}
            onPhaseSelect={scrollToPhase}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
          <ListTree className="h-3 w-3" /> Step stream
        </div>
        {visitedPhases.length === 0 ? (
          <div className="text-muted px-2 py-3 text-xs">No steps yet.</div>
        ) : (
          visitedPhases.map((phase) => (
            <WorkflowPhaseSection
              key={phase.name || "__ungrouped"}
              phase={phase}
              workspaceId={props.workspaceId}
              nestedDepth={nestedDepth}
              sectionRef={(element) => {
                if (element != null) {
                  phaseSectionRefs.current.set(phase.name, element);
                } else {
                  phaseSectionRefs.current.delete(phase.name);
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );
};
