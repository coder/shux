import React from "react";
import {
  Archive,
  ArchiveRestore,
  Ban,
  CircleX,
  FolderX,
  LoaderCircle,
  type LucideIcon,
  SearchX,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
  LoadingDots,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  unwrapResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { TaskWorkspaceLifecycleToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type {
  TaskWorkspaceLifecycleStatus,
  TaskWorkspaceLifecycleTargetResult,
  TaskWorkspaceLifecycleToolArgs,
} from "@/common/types/tools";

/**
 * Transcript card for `task_workspace_lifecycle` — the tool a parent/orchestrator
 * agent uses to reconcile the child workspaces it spun up via `task(kind="workspace")`
 * by archiving them, deleting their on-disk worktree, or removing them entirely.
 *
 * Collapsed, it reads as a glanceable count of what changed (and whether anything is
 * blocked or failed); expanded, it lists each target workspace with its per-target
 * outcome. Mirrors the backend (TaskWorkspaceLifecycleToolResultSchema): the result is
 * `{ results: [...] }` (no top-level `success`), each row discriminated on one of twelve
 * lifecycle `status` values. A thrown execute() surfaces instead as `{ success: false,
 * error }`, handled via the shared ErrorBox.
 *
 * Design intent ported from the "Workspace Lifecycle Tool Call" Xum Design System mockup;
 * the mockup used a simplified placeholder schema (archive|delete, top-level success), so
 * this card preserves its visual vocabulary while binding to the real status union.
 */

type Tone = "warn" | "danger" | "info" | "muted";

// Tone → token classes. We honor the mockup's destructiveness coding rather than a flat
// "green = done": archive is reversible (amber/warn), remove is irreversible (red/danger),
// idempotent no-ops are muted, and "active" (a running turn blocks the action) reads as the
// in-progress/pending tone. All tokens are defined in globals.css.
const TONE_TEXT: Record<Tone, string> = {
  warn: "text-warning",
  danger: "text-danger",
  info: "text-pending",
  muted: "text-secondary",
};
const TONE_BADGE: Record<Tone, string> = {
  warn: "bg-warning-overlay text-warning",
  danger: "bg-danger-overlay text-danger",
  info: "bg-pending/10 text-pending",
  muted: "bg-white/5 text-secondary",
};
const TONE_DOT: Record<Tone, string> = {
  warn: "bg-warning",
  danger: "bg-danger",
  info: "bg-pending",
  muted: "bg-white/30",
};

// Header-summary buckets. "settled" = the workspace is in (or already in) the desired
// state; "blocked" = the action needs a follow-up flag/step before it can proceed;
// "failed" = ownership/scope error. The header pill takes the most severe bucket's tone.
type OutcomeGroup = "settled" | "blocked" | "failed";
const GROUP_TONE: Record<OutcomeGroup, Tone> = {
  settled: "muted",
  blocked: "warn",
  failed: "danger",
};

interface StatusMeta {
  /** Short badge label shown on each row and (for uniform results) in the header pill. */
  label: string;
  tone: Tone;
  group: OutcomeGroup;
  Icon: LucideIcon;
}

// Exhaustive map over the backend status union (Record<Enum,_> catches a missing case at
// compile time if the schema gains a status).
const STATUS_META: Record<TaskWorkspaceLifecycleStatus, StatusMeta> = {
  archived: { label: "Archived", tone: "warn", group: "settled", Icon: Archive },
  already_archived: { label: "Already archived", tone: "muted", group: "settled", Icon: Archive },
  unarchived: { label: "Unarchived", tone: "info", group: "settled", Icon: ArchiveRestore },
  already_unarchived: {
    label: "Already unarchived",
    tone: "muted",
    group: "settled",
    Icon: ArchiveRestore,
  },
  deleted_worktree: { label: "Worktree deleted", tone: "warn", group: "settled", Icon: FolderX },
  already_transcript_only: {
    label: "Worktree already gone",
    tone: "muted",
    group: "settled",
    Icon: FolderX,
  },
  removed: { label: "Removed", tone: "danger", group: "settled", Icon: Trash2 },
  already_removed: { label: "Already removed", tone: "muted", group: "settled", Icon: Trash2 },
  not_found: { label: "Not found", tone: "muted", group: "settled", Icon: SearchX },
  requires_archive: {
    label: "Archive first",
    tone: "warn",
    group: "blocked",
    Icon: TriangleAlert,
  },
  requires_confirmation: {
    label: "Confirm files",
    tone: "warn",
    group: "blocked",
    Icon: ShieldAlert,
  },
  active: { label: "Active turn", tone: "info", group: "blocked", Icon: LoaderCircle },
  invalid_scope: { label: "Out of scope", tone: "danger", group: "failed", Icon: Ban },
  error: { label: "Error", tone: "danger", group: "failed", Icon: CircleX },
};

/**
 * Bucket per-target outcomes into the three header-summary groups. Exported so the
 * classification (which states read as settled vs. needs-attention vs. failed — a
 * user-visible severity decision, not just copy) can be tested directly.
 */
export function summarizeOutcomeGroups(
  rows: TaskWorkspaceLifecycleTargetResult[]
): Record<OutcomeGroup, number> {
  const counts: Record<OutcomeGroup, number> = { settled: 0, blocked: 0, failed: 0 };
  for (const row of rows) counts[STATUS_META[row.status].group] += 1;
  return counts;
}

interface ActionMeta {
  /** Header verb while the call is in flight. */
  gerund: string;
  /** Header verb once resolved (imperative, matching the house style of other tool cards). */
  label: string;
  /** Count unit; delete_worktree acts on the worktree, archive/remove on the workspace. */
  unit: string;
  /** Expanded footer explaining what the action does. */
  note: string;
}

const ACTION_META: Record<TaskWorkspaceLifecycleToolArgs["action"], ActionMeta> = {
  archive: {
    gerund: "Archiving workspaces",
    label: "Archive workspaces",
    unit: "workspace",
    note: "Archived workspaces are hidden from the active list and can be restored later.",
  },
  unarchive: {
    gerund: "Unarchiving workspaces",
    label: "Unarchive workspaces",
    unit: "workspace",
    note: "Restores archived workspaces to the active list without starting a new turn.",
  },
  delete_worktree: {
    gerund: "Deleting worktrees",
    label: "Delete worktrees",
    unit: "worktree",
    note: "Deletes the on-disk worktree to reclaim space; the transcript is kept and the workspace stays archived.",
  },
  remove: {
    gerund: "Removing workspaces",
    label: "Remove workspaces",
    unit: "workspace",
    note: "Removed workspaces are deleted permanently, including transcript and session state.",
  },
};

/**
 * Narrow an arbitrary persisted result to the success payload. Results flow verbatim from
 * transcripts, so we validate against the schema rather than trusting the shape — a
 * malformed result simply renders the requested-args fallback instead of throwing
 * (self-healing).
 */
function extractRows(result: unknown): TaskWorkspaceLifecycleTargetResult[] {
  const parsed = TaskWorkspaceLifecycleToolResultSchema.safeParse(result);
  return parsed.success ? parsed.data.results : [];
}

/**
 * Top-level failure message, if the result represents a failed call rather than a
 * `{ results: [...] }` payload. Covers both the standard thrown shape
 * (`{ success: false, error }`) and the nested code_execution/PTC shape (`{ error }` with no
 * `success` flag, reconstructed by displayedMessageBuilder) — the latter reaches this card
 * now that nested calls route here instead of GenericToolCall. A valid results payload has no
 * top-level `error`, so successful batches (even with per-row errors) are unaffected.
 */
function extractErrorText(result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.results)) return null;
  return typeof record.error === "string" ? record.error : null;
}

/** Human-readable identifier for a target: prefer the resolved workspace id. */
function targetIdLabel(target: { taskId?: string | null; workspaceId?: string | null }): string {
  return target.workspaceId ?? target.taskId ?? "workspace";
}

function trimToNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : null;
}

const Dot: React.FC<{ tone: Tone }> = (props) => (
  <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[props.tone])} />
);

/** Compact header pill summarizing outcomes — the collapsed-card glance. */
const HeaderBadge: React.FC<{ rows: TaskWorkspaceLifecycleTargetResult[]; executing: boolean }> = (
  props
) => {
  const base =
    "inline-flex shrink-0 items-center gap-2 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none";

  if (props.executing) {
    return (
      <span className={cn(base, "bg-white/5 text-secondary")}>
        <LoadingDots>Working</LoadingDots>
      </span>
    );
  }
  if (props.rows.length === 0) return null;

  // Uniform outcome → a single solid pill reading e.g. "3 archived" (the common case where
  // every target landed the same way). Mixed → grouped dot-chips by severity.
  const first = props.rows[0].status;
  const uniform = props.rows.every((r) => r.status === first);
  if (uniform) {
    const meta = STATUS_META[first];
    return (
      <span className={cn(base, TONE_BADGE[meta.tone])}>
        <Dot tone={meta.tone} />
        <span className="counter-nums">{props.rows.length}</span>
        <span className="lowercase">{meta.label}</span>
      </span>
    );
  }

  const counts = summarizeOutcomeGroups(props.rows);
  // Pick the most severe non-empty group and map it to its tone via GROUP_TONE so the
  // group→tone mapping stays single-sourced (the dot chips below read from it too).
  const worstGroup: OutcomeGroup =
    counts.failed > 0 ? "failed" : counts.blocked > 0 ? "blocked" : "settled";
  const worst: Tone = GROUP_TONE[worstGroup];
  const chips: Array<{ group: OutcomeGroup; n: number; label: string }> = [
    { group: "settled", n: counts.settled, label: "done" },
    { group: "blocked", n: counts.blocked, label: "blocked" },
    { group: "failed", n: counts.failed, label: "failed" },
  ];

  return (
    <span className={cn(base, TONE_BADGE[worst])}>
      {chips
        .filter((c) => c.n > 0)
        .map((c) => (
          <span key={c.group} className="inline-flex items-center gap-1.5">
            <Dot tone={GROUP_TONE[c.group]} />
            <span className="counter-nums">{c.n}</span>
            <span className="text-secondary">{c.label}</span>
          </span>
        ))}
    </span>
  );
};

/** Per-row blocked-state hint: tells the agent the follow-up step that would unblock it. */
function blockedHint(
  status: TaskWorkspaceLifecycleStatus,
  action: TaskWorkspaceLifecycleToolArgs["action"]
): string | null {
  switch (status) {
    case "requires_archive":
      return `Archive this workspace before ${action === "remove" ? "removing it" : "deleting its worktree"}.`;
    case "requires_confirmation":
      return "Re-run with these paths listed in acknowledged_untracked_paths to confirm.";
    case "active":
      return "Pass interrupt_active: true to act on a running turn.";
    default:
      return null;
  }
}

// Labeled, scrollable list of identifiers (untracked paths or active task ids). Both are
// repo-/runtime-controlled strings that can be long, so break-all + a capped scroll keep the
// row from overflowing its container on narrow/mobile widths.
const DetailList: React.FC<{ label: string; items: string[] }> = (props) => (
  <div className="mt-1.5">
    <div className="text-secondary mb-1 text-[10px] tracking-wide uppercase">{props.label}</div>
    <ul className="bg-code-bg max-h-32 space-y-0.5 overflow-y-auto rounded px-2 py-1.5">
      {props.items.map((item, i) => (
        <li key={i} className="text-foreground break-all">
          {item}
        </li>
      ))}
    </ul>
  </div>
);

const WorkspaceRow: React.FC<{
  row: TaskWorkspaceLifecycleTargetResult;
  action: TaskWorkspaceLifecycleToolArgs["action"];
  last: boolean;
}> = (props) => {
  const row = props.row;
  const meta = STATUS_META[row.status];
  const Icon = meta.Icon;
  const idLabel = targetIdLabel(row);
  const displayName = trimToNonEmpty(row.displayName);
  // Match the left-sidebar label when the backend captured one, while still keeping the
  // stable workspace/task identifiers visible for copy/paste and debugging.
  const primary = displayName != null && displayName !== idLabel ? displayName : idLabel;
  const secondaryItems = [
    primary !== idLabel ? idLabel : null,
    row.taskId != null && row.taskId !== idLabel ? row.taskId : null,
  ].filter((item): item is string => item != null);
  const secondary = secondaryItems.length > 0 ? secondaryItems.join(" · ") : null;
  const hint = blockedHint(row.status, props.action);

  return (
    <div className={cn("py-2", props.last ? "" : "border-b border-white/5")}>
      <div className="flex items-center gap-2.5">
        <span className={cn("inline-flex shrink-0 [&_svg]:size-3.5", TONE_TEXT[meta.tone])}>
          <Icon aria-hidden="true" />
        </span>
        <span className="text-foreground min-w-0 flex-1 truncate">{primary}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase",
            TONE_BADGE[meta.tone]
          )}
        >
          {meta.label}
        </span>
      </div>

      {/* Sub-lines align under the primary id (icon size-3.5 + gap-2.5 ≈ pl-6). */}
      {secondary && (
        <div className="text-secondary mt-0.5 truncate pl-6 text-[10px]">{secondary}</div>
      )}
      {row.error && <div className="text-danger mt-1 pl-6 break-words">{row.error}</div>}
      {row.note && <div className="text-secondary mt-1 pl-6 break-words">{row.note}</div>}
      <div className="pl-6">
        {row.paths && row.paths.length > 0 && (
          <DetailList
            label={
              row.status === "requires_confirmation"
                ? "Untracked files that would be lost"
                : "Paths"
            }
            items={row.paths}
          />
        )}
        {row.activeTaskIds && row.activeTaskIds.length > 0 && (
          <DetailList label="Active turns" items={row.activeTaskIds} />
        )}
        {hint && <div className="text-muted mt-1 text-[10.5px] italic">{hint}</div>}
      </div>
    </div>
  );
};

/**
 * Fallback when no parseable result rows exist yet (executing, interrupted, or a degraded
 * result): surface what the agent requested so the expanded card is never blank.
 */
const RequestedTargets: React.FC<{
  args: TaskWorkspaceLifecycleToolArgs;
  meta: ActionMeta;
  executing: boolean;
}> = (props) => {
  const targets = Array.isArray(props.args.targets) ? props.args.targets : [];
  return (
    <div className="bg-code-bg rounded px-3 py-2 text-[11px]">
      {props.executing ? (
        <div className="text-muted mb-1.5 italic">
          {props.meta.gerund}
          {targets.length > 0 ? ` (${targets.length})` : ""}
          <LoadingDots />
        </div>
      ) : (
        <div className="text-secondary mb-1.5 text-[10px] tracking-wide uppercase">Requested</div>
      )}
      <ul className="space-y-0.5">
        {targets.map((t, i) => (
          <li key={i} className="text-foreground break-all">
            {targetIdLabel(t)}
          </li>
        ))}
      </ul>
    </div>
  );
};

interface WorkspaceLifecycleToolCallProps {
  args: TaskWorkspaceLifecycleToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const WorkspaceLifecycleToolCall: React.FC<WorkspaceLifecycleToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  const action = props.args.action;
  const meta = ACTION_META[action];
  // Tool results may be persisted/emitted in the SDK JSON-container shape
  // ({ type: "json", value: ... }); unwrap (idempotent for already-bare results) before
  // parsing so a valid { results: [...] } payload isn't misread as malformed.
  const result = unwrapResult(props.result);
  const errorText = extractErrorText(result);
  const rows = extractRows(result);
  const executing = status === "executing";

  const total =
    rows.length > 0
      ? rows.length
      : Array.isArray(props.args.targets)
        ? props.args.targets.length
        : 0;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="task_workspace_lifecycle" />
        {/* Verb truncates as a last resort so the header never overflows; the count is
            hidden on narrow containers (the badge already conveys it there), mirroring how
            HeartbeatToolCall hides its secondary header text below @sm. */}
        <span className="text-secondary min-w-0 truncate font-medium">
          {executing ? meta.gerund : meta.label}
        </span>
        {total > 0 && (
          <span className="text-secondary counter-nums hidden whitespace-nowrap @sm:inline">
            {total} {meta.unit}
            {total === 1 ? "" : "s"}
          </span>
        )}
        {!errorText && (rows.length > 0 || executing) && (
          <HeaderBadge rows={rows} executing={executing} />
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorText && <ErrorBox>{errorText}</ErrorBox>}

          {rows.length > 0 && (
            <>
              <div className="bg-code-bg rounded px-3 py-1.5">
                <div className="flex flex-col">
                  {rows.map((row, i) => (
                    <WorkspaceRow
                      key={row.workspaceId ?? row.taskId ?? i}
                      row={row}
                      action={action}
                      last={i === rows.length - 1}
                    />
                  ))}
                </div>
              </div>
              <div className="text-muted mt-2 px-1 text-[10.5px] leading-relaxed">{meta.note}</div>
            </>
          )}

          {rows.length === 0 && !errorText && (
            <RequestedTargets args={props.args} meta={meta} executing={executing} />
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
