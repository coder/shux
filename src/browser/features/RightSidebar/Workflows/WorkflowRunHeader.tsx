import React from "react";
import { Check, ChevronRight, Clock, Coins, Play, RotateCcw, Square, Workflow } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { canRetryWorkflowFromCheckpoint } from "@/common/utils/workflowRetryEligibility";

import { WorkflowScopeBadge, WorkflowStatusPill } from "./WorkflowBadges";
import { WorkflowLongText } from "./WorkflowLongText";
import type { WorkflowRunView } from "./projectWorkflowRun";
import {
  formatWorkflowCost,
  formatWorkflowDuration,
  formatWorkflowTokens,
} from "./workflowDisplay";

const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50";
const BTN_DEFAULT = `${BTN_BASE} border-border bg-surface-secondary text-foreground hover:bg-hover`;
const BTN_ACCENT = `${BTN_BASE} border-accent bg-accent text-white hover:opacity-90`;

function isInlineWorkflowPath(scriptPath: string): boolean {
  return scriptPath.startsWith("inline://");
}

/** Resolvable script path to re-invoke this run with, or null when the record stores none. */
export function getWorkflowRunRerunScriptPath(run: WorkflowRunRecord): string | null {
  if (run.workflow.sourceKind === "inline") {
    return null;
  }
  const scriptPath =
    run.workflow.canonicalScriptPath ??
    run.workflow.sourcePath ??
    run.workflow.requestedScriptPath ??
    null;
  if (scriptPath == null || isInlineWorkflowPath(scriptPath)) {
    return null;
  }
  return scriptPath;
}

interface WorkflowRunHeaderProps {
  workspaceId: string;
  run: WorkflowRunRecord;
  view: WorkflowRunView;
  /** Bumped after a control action so the panel can refocus the (now-active) run. */
  onAfterAction?: () => void;
}

export const WorkflowRunHeader: React.FC<WorkflowRunHeaderProps> = (props) => {
  const { api } = useAPI();
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const run = props.run;
  const view = props.view;
  const isLive = run.status === "running" || run.status === "backgrounded";
  const canRetry = run.status === "failed" && canRetryWorkflowFromCheckpoint(run);
  // Legacy/persisted records can lack a stored script path; workflows.start rejects a bare
  // workflow name, so only offer Re-run when a resolvable path exists.
  const rerunScriptPath = getWorkflowRunRerunScriptPath(run);
  const canRerun = rerunScriptPath != null;

  const runAction = async (action: () => Promise<unknown>) => {
    if (api == null || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await action();
      props.onAfterAction?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Workflow action failed");
    } finally {
      setBusy(false);
    }
  };

  // Click handlers return void (fire-and-forget into runAction, which owns the busy
  // guard + error state) so they satisfy onClick's void-return contract.
  const interrupt = () => {
    void runAction(() =>
      api!.workflows.interrupt({ workspaceId: props.workspaceId, runId: run.id })
    );
  };
  const resume = () => {
    void runAction(() => api!.workflows.resume({ workspaceId: props.workspaceId, runId: run.id }));
  };
  const retry = () => {
    void runAction(() =>
      api!.workflows.retryFromCheckpoint({ workspaceId: props.workspaceId, runId: run.id })
    );
  };
  const rerun = () => {
    if (rerunScriptPath == null) {
      return;
    }
    void runAction(() =>
      api!.workflows.start({
        workspaceId: props.workspaceId,
        scriptPath: rerunScriptPath,
        args: run.args,
        // Background the re-run so the action returns immediately; the new run streams
        // into the tab via the subscription.
        runInBackground: true,
      })
    );
  };

  return (
    <div className="border-border flex flex-col gap-2.5 border-b pb-3.5">
      <div className="flex items-center gap-2">
        <span className="text-accent flex min-w-0 items-center gap-2">
          <Workflow className="h-[15px] w-[15px] shrink-0" />
          <span className="text-content-primary truncate text-[15px] font-semibold">
            {run.workflow.name}
          </span>
          <WorkflowScopeBadge scope={run.workflow.scope} />
        </span>
        <span className="ml-auto">
          <WorkflowStatusPill status={run.status} />
        </span>
      </div>

      {view.argEntries.length > 0 && (
        <div className="flex flex-col gap-1">
          {view.argEntries.map((entry, index) => (
            <div
              key={entry.key ?? index}
              className="border-border bg-surface-secondary text-content-secondary flex min-w-0 gap-1.5 rounded-md border px-2 py-1 text-xs"
            >
              {entry.stages != null ? (
                // Keep the step stream visible until details are requested; launch metadata
                // describes a plan, not evidence of runtime progress.
                <details className="group/stages min-w-0 flex-1">
                  <summary className="focus-visible:outline-accent cursor-pointer list-none rounded focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                    <span className="text-muted flex items-center gap-1 font-medium">
                      <ChevronRight className="h-3 w-3 shrink-0 group-open/stages:rotate-90" />
                      <span>Planned stages</span>
                      <span className="counter-nums">· {entry.stages.length}</span>
                    </span>
                    <span className="text-content-primary mt-1 flex flex-wrap gap-x-3 gap-y-1 group-open/stages:hidden">
                      {entry.stages.map((stage, stageIndex) => (
                        <span key={stageIndex} className="max-w-full min-w-0 break-words">
                          <span className="text-muted counter-nums">{stageIndex + 1}.</span>{" "}
                          {stage.name}
                        </span>
                      ))}
                    </span>
                  </summary>
                  <ol
                    aria-label="Planned stages"
                    className="counter-nums mt-2 list-decimal space-y-2 pl-5"
                  >
                    {entry.stages.map((stage, stageIndex) => (
                      <li key={stageIndex} className="min-w-0 space-y-0.5 break-words">
                        <div className="text-content-primary font-medium">{stage.name}</div>
                        {stage.role && <div className="text-muted">{stage.role}</div>}
                        {stage.brief && (
                          <WorkflowLongText
                            text={stage.brief}
                            title={`Stage ${stageIndex + 1}: ${stage.name}`}
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                  <details className="group mt-2 min-w-0">
                    <summary className="text-muted hover:text-foreground focus-visible:outline-accent flex cursor-pointer list-none items-center gap-1 rounded focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="h-3 w-3 shrink-0 group-open:rotate-90" />
                      Original argument
                    </summary>
                    <WorkflowLongText
                      className="mt-1"
                      text={entry.value}
                      title="Argument: stages"
                    />
                  </details>
                </details>
              ) : (
                <>
                  {entry.key != null && (
                    <span className="text-muted shrink-0 font-mono text-[11px]">{entry.key}</span>
                  )}
                  {/* Long values preview-truncate; expand inline or open the full view. */}
                  <WorkflowLongText
                    className="flex-1"
                    text={entry.value}
                    title={entry.key != null ? `Argument: ${entry.key}` : "Workflow argument"}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-muted flex flex-wrap items-center gap-3 text-[11.5px] tabular-nums">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatWorkflowDuration(view.stats.elapsedMs)}
          {isLive ? " elapsed" : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <Check className="h-3 w-3" />
          {view.stats.done}/{view.stats.total} steps
        </span>
        {view.stats.usage != null && (
          <span className="inline-flex items-center gap-1">
            <Coins className="h-3 w-3" />
            {formatWorkflowTokens(view.stats.usage.tokens)} tok ·{" "}
            {formatWorkflowCost(view.stats.usage.costUsd)}
          </span>
        )}
        <span className="ml-auto font-mono text-[10.5px] opacity-70">{run.id}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {isLive ? (
          <button type="button" className={BTN_DEFAULT} onClick={interrupt} disabled={busy}>
            <Square className="h-3 w-3" /> Interrupt
          </button>
        ) : run.status === "interrupted" ? (
          <>
            <button type="button" className={BTN_ACCENT} onClick={resume} disabled={busy}>
              <Play className="h-3 w-3" /> Resume
            </button>
            {canRerun && (
              <button type="button" className={BTN_DEFAULT} onClick={rerun} disabled={busy}>
                <RotateCcw className="h-3 w-3" /> Re-run
              </button>
            )}
          </>
        ) : (
          <>
            {canRetry && (
              <button type="button" className={BTN_ACCENT} onClick={retry} disabled={busy}>
                <Play className="h-3 w-3" /> Retry from checkpoint
              </button>
            )}
            {canRerun && (
              <button type="button" className={BTN_DEFAULT} onClick={rerun} disabled={busy}>
                <RotateCcw className="h-3 w-3" /> Re-run
              </button>
            )}
          </>
        )}
      </div>

      {actionError != null && <div className="text-danger text-xs">{actionError}</div>}
    </div>
  );
};
