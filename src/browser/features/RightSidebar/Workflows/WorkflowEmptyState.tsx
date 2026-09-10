import React from "react";
import { BookOpen, Play, Workflow } from "lucide-react";

import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import type { AvailableWorkflow, WorkflowArgSummary } from "@/common/types/workflow";

import { WorkflowPhaseFlow, phaseFlowNodesFromManifest } from "./WorkflowPhaseFlow";

import { WorkflowScopeBadge } from "./WorkflowBadges";
import { stringifyWorkflowArgValue } from "./projectWorkflowRun";

/** Coerce a raw input string to the arg's declared type (best-effort). */
function coerceArgValue(arg: WorkflowArgSummary, raw: string | boolean): unknown {
  if (typeof raw === "boolean") {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (arg.types.includes("integer")) {
    // Only accept a whole integer; leave partial input ("1.9", "10abc") as a string so the
    // backend validates and reports it instead of parseInt silently truncating it.
    return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed;
  }
  if (arg.types.includes("number")) {
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  return trimmed;
}

const WorkflowRunForm: React.FC<{
  script: AvailableWorkflow;
  busy: boolean;
  onSubmit: (args: Record<string, unknown>) => void;
}> = (props) => {
  const [values, setValues] = React.useState<Record<string, string | boolean>>(() => {
    // Seed required boolean args that have no default to `false` so their (unchecked) state is a
    // submittable value: otherwise Start stays disabled on the only visible `false` state and the
    // user has to check-then-uncheck the box to launch with false.
    const initial: Record<string, string | boolean> = {};
    for (const arg of props.script.args) {
      if (arg.required && arg.default === undefined && arg.types.includes("boolean")) {
        initial[arg.name] = false;
      }
    }
    return initial;
  });

  const submit = () => {
    const args: Record<string, unknown> = {};
    for (const arg of props.script.args) {
      const raw = values[arg.name];
      // Skip fields the user never touched (including booleans) so the backend applies the
      // script's declared default / omit semantics — matching slash & chat launches — rather
      // than us forcing a value like `false`.
      if (raw === undefined) {
        continue;
      }
      const coerced = coerceArgValue(arg, raw);
      if (coerced !== undefined) {
        args[arg.name] = coerced;
      }
    }
    props.onSubmit(args);
  };

  const missingRequired = props.script.args.some((arg) => {
    // Optional args, and required args that declare a default, never block Start: submit omits the
    // untouched field and the backend applies the default before validating required (slash/chat).
    if (!arg.required || arg.default !== undefined) {
      return false;
    }
    // A required boolean with no default needs an explicit value; since submit omits untouched
    // fields, block Start until the user sets the checkbox (toggling it defines true/false).
    if (arg.types.includes("boolean")) {
      return values[arg.name] === undefined;
    }
    return String(values[arg.name] ?? "").trim().length === 0;
  });

  return (
    <div className="border-border mt-2 flex flex-col gap-2 border-t pt-2.5">
      {props.script.args.map((arg) => {
        const isBoolean = arg.types.includes("boolean");
        return (
          <label key={arg.name} className="flex flex-col gap-1 text-[11.5px]">
            <span className="text-content-secondary flex items-center gap-1.5">
              <span className="font-mono">{arg.name}</span>
              {arg.required && <span className="text-danger">*</span>}
              <span className="text-muted">{arg.types.join(" | ")}</span>
            </span>
            {isBoolean ? (
              <input
                type="checkbox"
                className="h-3.5 w-3.5 self-start"
                // Reflect the declared default when untouched so the checkbox shows the value that
                // will actually run (submit omits untouched fields → backend applies the default).
                checked={
                  typeof values[arg.name] === "boolean"
                    ? (values[arg.name] as boolean)
                    : arg.default === true
                }
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [arg.name]: event.target.checked }))
                }
              />
            ) : (
              <input
                type="text"
                className="border-border bg-background text-foreground rounded-md border px-2 py-1 text-xs"
                placeholder={
                  arg.default != null ? `default: ${stringifyWorkflowArgValue(arg.default)}` : ""
                }
                value={typeof values[arg.name] === "string" ? (values[arg.name] as string) : ""}
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [arg.name]: event.target.value }))
                }
              />
            )}
          </label>
        );
      })}
      <button
        type="button"
        disabled={props.busy || missingRequired}
        onClick={submit}
        className="border-accent bg-accent inline-flex items-center gap-1 self-start rounded-md border px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      >
        <Play className="h-3 w-3" /> Start
      </button>
    </div>
  );
};

interface WorkflowEmptyStateProps {
  scripts: AvailableWorkflow[];
  onRun: (script: AvailableWorkflow, args: Record<string, unknown>) => void;
  // Keyed by scriptPath (unique) rather than descriptor.name, which can collide across skill
  // workflows that omit meta.name (both normalize to "workflow").
  busyScriptPath: string | null;
}

/**
 * Shown when a workspace has no workflow runs yet: explains what workflows are
 * and lists the scripts available to run. Scripts with declared args reveal an
 * inline form; arg-less scripts start immediately.
 */
export const WorkflowEmptyState: React.FC<WorkflowEmptyStateProps> = (props) => {
  const [configuring, setConfiguring] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 px-4 pt-5 pb-2 text-center">
        <span
          className="text-accent grid h-12 w-12 place-items-center rounded-xl border"
          style={{
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            borderColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
          }}
        >
          <Workflow className="h-6 w-6" />
        </span>
        <div className="text-content-primary text-[15px] font-semibold">No workflow runs yet</div>
        <div className="text-muted max-w-[330px] text-[12.5px] leading-relaxed">
          Workflows are deterministic JavaScript that orchestrate sub-agents — fan out, gather,
          verify, synthesize. Run one to see live progress here.
        </div>
      </div>

      {props.scripts.length > 0 && (
        <>
          <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
            <BookOpen className="h-3 w-3" /> Available workflows
          </div>
          <div className="flex flex-col gap-1.5">
            {props.scripts.map((script) => {
              const isConfiguring = configuring === script.scriptPath;
              const isBusy = props.busyScriptPath === script.scriptPath;
              const onRunClick = () => {
                if (!script.descriptor.executable) {
                  return;
                }
                if (script.args.length === 0) {
                  props.onRun(script, {});
                  return;
                }
                setConfiguring(isConfiguring ? null : script.scriptPath);
              };
              return (
                <div
                  key={script.scriptPath}
                  className="border-border bg-surface-secondary rounded-lg border px-3 py-2.5"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-content-primary flex items-center gap-1.5 text-[13px] font-semibold">
                        <span className="truncate">{script.descriptor.name}</span>
                        <WorkflowScopeBadge scope={script.descriptor.scope} />
                      </div>
                      <div className="text-muted mt-0.5 text-[11.5px] leading-snug">
                        {script.descriptor.description}
                      </div>
                      {!script.descriptor.executable && script.descriptor.blockedReason != null && (
                        <div className="text-danger mt-0.5 text-[11px]">
                          {script.descriptor.blockedReason}
                        </div>
                      )}
                      {/* Pre-run phase preview: the declared/inferred rail with all
                          phases pending, so the flow is visible before any run exists. */}
                      {script.descriptor.phaseManifest != null && (
                        <WorkflowPhaseFlow
                          className="mt-1.5"
                          nodes={phaseFlowNodesFromManifest(script.descriptor.phaseManifest)}
                          provenance={script.descriptor.phaseManifest.provenance}
                        />
                      )}
                      {script.phaseManifestWarning != null && (
                        <div className="text-warning mt-0.5 min-w-0 text-[11px] break-words">
                          Invalid meta.phases declaration — runs will be rejected:{" "}
                          {script.phaseManifestWarning}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={
                        !script.descriptor.executable || (props.busyScriptPath != null && !isBusy)
                      }
                      onClick={onRunClick}
                      className="border-accent bg-accent inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" /> Run
                    </button>
                  </div>
                  {isConfiguring && (
                    <WorkflowRunForm
                      script={script}
                      busy={isBusy}
                      onSubmit={(args) => props.onRun(script, args)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="text-muted pt-1 text-center text-[11.5px]">
        Start one from chat with{" "}
        <span className="border-border bg-surface-secondary rounded border px-1.5 py-px font-mono">
          {`/workflow ${SLASH_COMMAND_HINTS.workflow}`}
        </span>
        ; workspace <span className="text-content-secondary font-mono">.js</span> workflows are
        loaded by explicit path.
      </div>
    </div>
  );
};
