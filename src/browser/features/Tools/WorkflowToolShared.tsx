import React from "react";

import { cn } from "@/common/lib/utils";
import type { WorkflowScriptDescriptor } from "@/common/types/workflow";
import { DetailSection } from "./Shared/ToolPrimitives";
import { JsonHighlight } from "./Shared/HighlightedCode";

export const WORKFLOW_ACTION_BUTTON_CLASS =
  "text-muted hover:text-foreground border-border rounded border px-2 py-1 disabled:opacity-50 disabled:hover:text-muted";

export function WorkflowKindBadge() {
  return (
    <span className="border-border-light text-plan-mode shrink-0 rounded border px-1 py-0.5 text-[9px] tracking-wide uppercase">
      Workflow
    </span>
  );
}

export function WorkflowBadge(props: {
  children: React.ReactNode;
  tone?: "normal" | "success" | "warning" | "danger";
}) {
  return (
    <span
      className={cn(
        "border-border bg-background/40 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        props.tone === "success" && "border-success/30 text-success",
        props.tone === "warning" && "border-warning/30 text-warning",
        // Blocked workflows/actions need to stand apart from yellow external-action warnings.
        props.tone === "danger" && "border-danger/40 bg-danger-overlay text-danger",
        (props.tone == null || props.tone === "normal") && "text-muted"
      )}
    >
      {props.children}
    </span>
  );
}

export function BlockedBadge() {
  return <WorkflowBadge tone="danger">blocked</WorkflowBadge>;
}

export function WorkflowSection(props: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DetailSection className={props.className}>
      <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">{props.title}</div>
      {props.children}
    </DetailSection>
  );
}

export function WorkflowJsonBlock(props: {
  value: unknown;
  className?: string;
  ariaLabel?: string;
}) {
  const isNamedScrollRegion = props.ariaLabel != null;
  return (
    <div
      className={cn(
        "border-border bg-code-bg max-h-[240px] overflow-auto rounded border p-2",
        props.className
      )}
      role={isNamedScrollRegion ? "region" : undefined}
      tabIndex={isNamedScrollRegion ? 0 : undefined}
      aria-label={props.ariaLabel}
    >
      <JsonHighlight value={props.value} />
    </div>
  );
}

export function WorkflowScriptCard(props: {
  descriptor: WorkflowScriptDescriptor;
  compact?: boolean;
}) {
  const descriptor = props.descriptor;
  const metadataRows = [
    ["requested", descriptor.requestedScriptPath],
    ["canonical", descriptor.canonicalScriptPath ?? descriptor.sourcePath],
    ["hash", descriptor.sourceHash],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);
  return (
    <div className="border-border bg-background/30 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-mono text-[12px] font-medium">{descriptor.name}</span>
        <WorkflowBadge>{descriptor.scope}</WorkflowBadge>
        {descriptor.sourceKind && <WorkflowBadge>{descriptor.sourceKind}</WorkflowBadge>}
        {!descriptor.executable && <BlockedBadge />}
      </div>
      {!props.compact && (
        <div className="text-muted mt-1 text-[11px]">{descriptor.description}</div>
      )}
      {metadataRows.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {metadataRows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-[10px]">
              <span className="text-muted uppercase">{label}</span>
              <span className="text-muted truncate font-mono">{value}</span>
            </div>
          ))}
        </div>
      )}
      {descriptor.blockedReason && (
        <div className="text-warning mt-1 text-[10px]">{descriptor.blockedReason}</div>
      )}
    </div>
  );
}
