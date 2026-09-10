import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
import {
  toWorkspaceSelection,
  useOptionalWorkspaceContext,
} from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  pinTimelineRevealTarget,
  useWorkspaceStoreRaw,
  useWorkspaceTimeline,
  type HistoryLoadResult,
  type WorkspaceState,
  type WorkspaceTimelineSnapshot,
} from "@/browser/stores/WorkspaceStore";
import { revealTimelineTarget } from "@/browser/utils/timelineReveal";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { KEYBINDS, isEditableElement, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import { capitalize } from "@/common/utils/capitalize";
import { formatDuration } from "@/common/utils/formatDuration";
import {
  TIMELINE_ROW_DIGEST_MAX_LENGTH,
  TIMELINE_TEXT_MAX_LENGTH,
  truncateTimelineRowDigest,
  type TimelineAnchor,
  type TimelineEvent,
  type TimelinePreview,
} from "@/common/orpc/schemas/timeline";
import { isSubagentFallbackTitle } from "@/common/utils/subagentReportEnvelope";

import {
  TIMELINE_CATEGORIES,
  formatTimelineTime,
  getTimelineDayLabel,
  getTimelineEventCategories,
  getTimelineEventKind,
  getAgentEventIcon,
  getAgentEventTint,
  getTimelineEventTitle,
  getTimelinePresentation,
  isMachineryKind,
  type TimelineCategory,
} from "./timelinePresentation";

interface TimelinePanelProps {
  workspaceId: string;
}

export interface TimelineWorkspaceStore {
  getWorkspaceState: (
    workspaceId: string
  ) => Pick<WorkspaceState, "messages" | "muxMessages" | "hasOlderHistory">;
  loadOlderHistory: (workspaceId: string) => Promise<HistoryLoadResult>;
  loadOlderTimeline: (workspaceId: string) => Promise<void>;
  retryTimeline: (workspaceId: string) => void;
}

type TimelineFilter = "all" | TimelineCategory;

interface DayGroup {
  key: string;
  label: string;
  events: TimelineEvent[];
}

interface CollapsedRun {
  key: string;
  kind: string;
  events: TimelineEvent[];
}

type DayItem = TimelineEvent | CollapsedRun;

const BOUNDARY_KINDS = new Set([
  "compaction.triggered",
  "compaction.completed",
  "context.reset",
  "history.cleared",
]);

// A completed turn renders as a boundary rule between stretches of work. Interruptions and failures
// keep the full row so they stand out.
const TURN_END_KIND = "turn.completed";

// Rule rows are already a single line, so collapsing a run of them would hide more than it saves.
function isRuleKind(kind: string): boolean {
  return kind === TURN_END_KIND || BOUNDARY_KINDS.has(kind);
}

// Rules a machinery turn produces itself (its completion, auto-compaction cycles) would otherwise
// split machinery stretches apart. Deliberate boundaries (context.reset, history.cleared) stay out
// so they always break a group.
const ABSORBED_RULE_KINDS = new Set([
  TURN_END_KIND,
  "compaction.triggered",
  "compaction.completed",
]);

const FILTERS: Array<{ value: TimelineFilter; label: string }> = [
  { value: "all", label: "All" },
  ...TIMELINE_CATEGORIES.map((category) => ({
    value: category,
    label: capitalize(category),
  })),
];

function isTimelineFilter(value: string): value is TimelineFilter {
  return value === "all" || TIMELINE_CATEGORIES.some((category) => category === value);
}

function getDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupEventsByDay(events: TimelineEvent[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const event of events) {
    const key = getDayKey(event.ts);
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      groups.set(key, { key, label: getTimelineDayLabel(event.ts), events: [event] });
    }
  }
  return Array.from(groups.values());
}

// An interruption abandons the in-flight retry, so both rows tell the same story. Dropping the
// retry row only when its interruption renders next to it keeps it visible under the Errors
// filter, where the interruption row is filtered out.
function isRedundantAbandonedRetry(event: TimelineEvent, next: TimelineEvent | undefined): boolean {
  return (
    getTimelineEventKind(event) === "retry.abandoned" &&
    event.data?.reason === "aborted" &&
    next != null &&
    getTimelineEventKind(next) === "turn.interrupted"
  );
}

function dominantMachineryKind(run: TimelineEvent[]): string {
  const counts = new Map<string, number>();
  let dominant = getTimelineEventKind(run[0]);
  for (const event of run) {
    const kind = getTimelineEventKind(event);
    if (!isMachineryKind(kind)) continue;
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    if (count > (counts.get(dominant) ?? 0)) dominant = kind;
  }
  return dominant;
}

// Timeline pages render newest-first, but the scan reasons chronologically: a machinery turn's
// completion rule lands after the event that dispatched it. Reverse in and back out instead of
// teaching every rule the inverted direction.
function collapseConsecutiveEvents(newestFirst: TimelineEvent[]): DayItem[] {
  const chronological = newestFirst.toReversed();
  const events = chronological.filter(
    (event, index) => !isRedundantAbandonedRetry(event, chronological[index + 1])
  );
  const items: DayItem[] = [];
  let index = 0;

  while (index < events.length) {
    const event = events[index];
    const kind = getTimelineEventKind(event);

    if (isMachineryKind(kind)) {
      const run: TimelineEvent[] = [event];
      let machineryCount = 1;
      let end = index + 1;
      while (end < events.length) {
        const nextKind = getTimelineEventKind(events[end]);
        if (isMachineryKind(nextKind)) {
          machineryCount++;
        } else if (!ABSORBED_RULE_KINDS.has(nextKind)) {
          break;
        }
        run.push(events[end]);
        end++;
      }
      if (machineryCount >= 2) {
        items.push({
          key: `${event.id}:machinery`,
          kind: dominantMachineryKind(run),
          events: run.reverse(),
        });
      } else {
        items.push(...run);
      }
      index = end;
      continue;
    }

    if (isRuleKind(kind)) {
      items.push(event);
      index++;
      continue;
    }

    let end = index + 1;
    while (end < events.length && getTimelineEventKind(events[end]) === kind) {
      end++;
    }

    const run = events.slice(index, end);
    if (run.length >= 3) {
      items.push({ key: `${event.id}:${kind}`, kind, events: run.reverse() });
    } else {
      items.push(...run);
    }
    index = end;
  }

  return items.reverse();
}

function isCollapsedRun(item: DayItem): item is CollapsedRun {
  return "events" in item;
}

const TASK_LIFECYCLE_KINDS = new Set([
  "task.created",
  "task.progress",
  "task.reported",
  "task.failed",
  "task.interrupted",
]);

// Mapper and TaskService rows encode untitled reports and digest lengths differently, so
// canonicalize both fields before cross-producer dedupe; the digest distinguishes untitled
// updates because they share a fallback title. Comparing capped previews is a deliberate
// tradeoff: rows store only the capped digest, so reports that diverge past the cap collapse
// into one row while their full text stays in the transcript.
function taskRowContentKey(event: TimelineEvent): string {
  const title = event.data?.title;
  const canonicalTitle = title == null || isSubagentFallbackTitle(title) ? "" : title;
  const digest = event.data?.digest;
  const canonicalDigest = digest == null ? "" : truncateTimelineRowDigest(digest);
  return `${canonicalTitle}\u0000${canonicalDigest}`;
}

// A newer lifecycle row makes task.created redundant, but its transcript anchor may still be the
// task's only reveal target. Deduplicate only task.progress rows whose title and digest match a
// newer row for that task; terminal rows remain because a reawakened task can report again.
function dropSupersededTaskRows(newestFirst: TimelineEvent[]): TimelineEvent[] {
  const startAnchors = new Map<string, TimelineAnchor>();
  for (const event of newestFirst) {
    const anchor = event.anchor;
    if (
      anchor?.taskId != null &&
      getTimelineEventKind(event) === "task.created" &&
      hasTranscriptAnchor(anchor)
    ) {
      startAnchors.set(anchor.taskId, anchor);
    }
  }

  const supersededTaskIds = new Set<string>();
  const newerRowKeys = new Set<string>();
  const events: TimelineEvent[] = [];
  for (const event of newestFirst) {
    const taskId = event.anchor?.taskId;
    if (taskId == null) {
      events.push(event);
      continue;
    }
    const kind = getTimelineEventKind(event);
    if (kind === "task.created" && supersededTaskIds.has(taskId)) {
      continue;
    }
    const contentKey = `${taskId}:${taskRowContentKey(event)}`;
    if (kind === "task.progress" && newerRowKeys.has(contentKey)) {
      continue;
    }
    if (TASK_LIFECYCLE_KINDS.has(kind)) {
      supersededTaskIds.add(taskId);
      newerRowKeys.add(contentKey);
      const start = startAnchors.get(taskId);
      if (kind !== "task.created" && start != null && !hasTranscriptAnchor(event.anchor)) {
        events.push({
          ...event,
          anchor: {
            ...event.anchor,
            ...(start.historySequence != null ? { historySequence: start.historySequence } : {}),
            ...(start.messageId != null ? { messageId: start.messageId } : {}),
            ...(start.toolCallId != null ? { toolCallId: start.toolCallId } : {}),
          },
        });
        continue;
      }
    }
    events.push(event);
  }
  return events;
}

function getEventDetail(event: TimelineEvent): string | null {
  const data = event.data;
  if (!data) return null;

  const details: string[] = [];
  if (data.title) details.push(data.title);
  else if (data.digest) details.push(data.digest);
  if (data.model || data.mode) details.push([data.model, data.mode].filter(Boolean).join(" · "));
  if (data.reason) details.push(data.reason);
  if (data.durationMs != null) details.push(formatDuration(data.durationMs, "precise"));
  return details.length > 0 ? details.join(" · ") : null;
}

function hasTranscriptAnchor(anchor: TimelineAnchor | undefined): boolean {
  return anchor?.toolCallId != null || anchor?.messageId != null || anchor?.historySequence != null;
}

// Producers cut digests to fixed lengths with a "..." suffix, so only a digest at exactly one of
// those lengths is treated as truncated; a digest that naturally ends in "..." must match in full.
function stripTruncationSuffix(text: string): string {
  const truncated =
    text.endsWith("...") &&
    (text.length === TIMELINE_ROW_DIGEST_MAX_LENGTH || text.length === TIMELINE_TEXT_MAX_LENGTH);
  return truncated ? text.slice(0, -3) : text;
}

function excerptCovers(excerpt: string, text: string | null): boolean {
  return text != null && text !== "" && excerpt.startsWith(stripTruncationSuffix(text));
}

function TimelineRuleRow(props: {
  event: TimelineEvent;
  selected: boolean;
  onSelect: (eventId: string) => void;
}) {
  const kind = getTimelineEventKind(props.event);
  const turnEnd = kind === TURN_END_KIND;
  const presentation = getTimelinePresentation(kind);
  const detail = getEventDetail(props.event);
  const epoch = props.event.epoch != null ? `Epoch ${props.event.epoch}` : "Context boundary";
  const rule = (
    <div className={cn("border-border min-w-3 flex-1 border-t", turnEnd && "border-dotted")} />
  );
  const label = (
    <span
      className={cn(
        "text-muted counter-nums min-w-0 truncate text-[10px] font-medium tracking-wide",
        !turnEnd && "uppercase",
        props.selected && "text-content-primary"
      )}
    >
      {turnEnd ? (detail ?? presentation.label) : `${epoch} · ${presentation.label}`}
    </span>
  );
  const body = turnEnd ? (
    <>
      {rule}
      {label}
      <time
        dateTime={new Date(props.event.ts).toISOString()}
        className="text-muted counter-nums shrink-0 text-[10px]"
      >
        {formatTimelineTime(props.event.ts)}
      </time>
    </>
  ) : (
    <>
      {rule}
      {label}
      {rule}
    </>
  );

  if (!hasTranscriptAnchor(props.event.anchor)) {
    return (
      <div className="my-2 flex min-w-0 items-center gap-2" role="separator">
        {body}
      </div>
    );
  }

  // An anchored rule may point into archived history, so keep it selectable as a reveal path.
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-timeline-event-id={props.event.id}
      data-timeline-event-kind={props.event.kind}
      onClick={() => props.onSelect(props.event.id)}
      className="hover:bg-hover focus-visible:ring-accent my-2 flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 focus-visible:ring-1 focus-visible:outline-none"
    >
      {body}
    </button>
  );
}

function TimelineEventRow(props: {
  event: TimelineEvent;
  selected: boolean;
  onSelect: (eventId: string) => void;
}) {
  const presentation = getTimelinePresentation(getTimelineEventKind(props.event));
  const title = getTimelineEventTitle(props.event);
  const detail = getEventDetail(props.event);
  const agentAuthored = props.event.source.system === "agent";
  const badge = props.event.data?.category?.replace(/_/g, " ") ?? "Agent";
  const tint = getAgentEventTint(props.event.data?.category);
  const Icon =
    (agentAuthored ? getAgentEventIcon(props.event.data?.category) : undefined) ??
    presentation.icon;
  const failed = props.event.status === "failed";
  const interrupted = props.event.status === "interrupted";

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-timeline-event-id={props.event.id}
      data-timeline-event-kind={props.event.kind}
      data-timeline-source={props.event.source.system}
      onClick={() => props.onSelect(props.event.id)}
      className={cn(
        "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors",
        "hover:bg-hover focus-visible:ring-accent focus-visible:ring-1 focus-visible:outline-none",
        agentAuthored && tint.row,
        failed && "border-danger/40 bg-danger-overlay",
        interrupted && !failed && "border-warning/40 bg-warning-overlay",
        props.selected && "border-accent/60 bg-accent/10"
      )}
    >
      <span
        className={cn(
          "border-border bg-surface-secondary text-content-secondary mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
          agentAuthored && tint.icon,
          failed && "border-danger/50 text-danger",
          interrupted && !failed && "border-warning/50 text-warning"
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="text-content-primary line-clamp-2 min-w-0 text-xs font-medium">
          {title}
        </span>
        {agentAuthored || detail ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {agentAuthored ? (
              <span
                className={cn(
                  "shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase",
                  tint.badge
                )}
              >
                {badge}
              </span>
            ) : null}
            {detail ? (
              <span className="text-muted min-w-0 truncate text-[11px]">{detail}</span>
            ) : null}
          </span>
        ) : null}
      </span>
      <time
        dateTime={new Date(props.event.ts).toISOString()}
        className="text-muted counter-nums shrink-0 pt-0.5 text-[10px]"
      >
        {formatTimelineTime(props.event.ts)}
      </time>
    </button>
  );
}

function CollapsedEventRun(props: {
  run: CollapsedRun;
  expanded: boolean;
  selectedEventId: string | null;
  onToggle: (key: string) => void;
  onSelect: (eventId: string) => void;
}) {
  const presentation = getTimelinePresentation(props.run.kind);
  const Icon = presentation.icon;
  // Count only machinery events (absorbed rules are decoration) and use a neutral label when no
  // single kind represents the group.
  const counted = props.run.events.filter((event) => !isRuleKind(getTimelineEventKind(event)));
  const mixed = new Set(counted.map((event) => getTimelineEventKind(event))).size > 1;
  const label = mixed ? "automatic" : presentation.label;

  if (props.expanded) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <button
          type="button"
          aria-expanded="true"
          data-timeline-collapsed-kind={props.run.kind}
          data-timeline-collapsed-count={counted.length}
          onClick={() => props.onToggle(props.run.key)}
          className="text-muted hover:bg-hover focus-visible:ring-accent flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] focus-visible:ring-1 focus-visible:outline-none"
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          <span className="counter-nums shrink-0">{counted.length}</span>
          <span className="min-w-0 truncate">{label} events</span>
        </button>
        {props.run.events.map((event) =>
          isRuleKind(getTimelineEventKind(event)) ? (
            <TimelineRuleRow
              key={event.id}
              event={event}
              selected={props.selectedEventId === event.id}
              onSelect={props.onSelect}
            />
          ) : (
            <TimelineEventRow
              key={event.id}
              event={event}
              selected={props.selectedEventId === event.id}
              onSelect={props.onSelect}
            />
          )
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded="false"
      data-timeline-collapsed-kind={props.run.kind}
      data-timeline-collapsed-count={counted.length}
      onClick={() => props.onToggle(props.run.key)}
      className="border-border bg-surface-secondary/50 hover:bg-hover focus-visible:ring-accent grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left focus-visible:ring-1 focus-visible:outline-none"
    >
      <span className="border-border bg-surface-primary text-content-secondary flex h-6 w-6 shrink-0 items-center justify-center rounded-full border">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-content-secondary min-w-0 truncate text-xs">
        <span className="counter-nums font-medium">{counted.length}</span> {label} events
      </span>
      <ChevronRight className="text-muted h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: TimelinePreview }
  | { status: "unavailable" };

function TimelinePreviewCard(props: {
  workspaceId: string;
  event: TimelineEvent;
  workspaceStore: TimelineWorkspaceStore;
}) {
  const { api } = useAPI();
  const workspaceContext = useOptionalWorkspaceContext();
  const workspaceStore = props.workspaceStore;
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [revealState, setRevealState] = useState<"idle" | "revealing" | "not-found" | "error">(
    "idle"
  );

  const revealOperationRef = useRef(0);
  const revealButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const operationRef = revealOperationRef;
    return () => {
      operationRef.current++;
    };
  }, []);

  useEffect(() => {
    const anchor = props.event.anchor;
    if (
      !anchor ||
      !api ||
      (anchor.toolCallId == null && anchor.messageId == null && anchor.historySequence == null)
    ) {
      setPreviewState({ status: "unavailable" });
      return;
    }

    let cancelled = false;
    setPreviewState({ status: "loading" });

    api.workspace.timeline
      .preview({ workspaceId: props.workspaceId, ...anchor })
      .then((preview) => {
        if (!cancelled) {
          setPreviewState(preview ? { status: "ready", preview } : { status: "unavailable" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewState({ status: "unavailable" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, props.event, props.workspaceId]);

  const anchor = props.event.anchor;
  const childWorkspace = anchor?.childWorkspaceId
    ? workspaceContext?.workspaceMetadata.get(anchor.childWorkspaceId)
    : undefined;
  const hasTranscriptTarget = hasTranscriptAnchor(anchor);

  const resolveRevealTarget = (currentAnchor: TimelineAnchor) => {
    const messageId =
      currentAnchor.messageId ??
      (currentAnchor.historySequence != null
        ? workspaceStore
            .getWorkspaceState(props.workspaceId)
            .muxMessages.find(
              (message) => message.metadata?.historySequence === currentAnchor.historySequence
            )?.id
        : undefined);
    return { messageId, toolCallId: currentAnchor.toolCallId };
  };

  const handleReveal = async () => {
    if (!anchor || !hasTranscriptTarget || revealState === "revealing") {
      return;
    }

    const operation = ++revealOperationRef.current;
    setRevealState("revealing");

    try {
      const result = await revealTimelineTarget({
        workspaceId: props.workspaceId,
        getTarget: () => resolveRevealTarget(anchor),
        workspaceStore,
        pinTarget: pinTimelineRevealTarget,
        isCancelled: () => operation !== revealOperationRef.current,
      });
      if (result === "cancelled") {
        return;
      }
      setRevealState(result === "revealed" ? "idle" : result);
    } catch {
      if (operation === revealOperationRef.current) {
        setRevealState("error");
      }
    }
  };

  // The card is mounted only while an event is selected, so a window listener is scoped to the
  // selection and works without focusing the sidebar. Activating the button rather than calling the
  // handler keeps one reveal path and inherits its disabled state while a reveal is in flight.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const button = revealButtonRef.current;
      if (
        !button ||
        button.disabled ||
        !matchesKeybind(event, KEYBINDS.REVEAL_TIMELINE_EVENT) ||
        isEditableElement(event.target)
      ) {
        return;
      }
      // Duplicate panels can be mounted at once: narrow viewports CSS-hide the right
      // sidebar without unmounting its Timeline tab while the mobile dialog mounts a
      // second panel. Only the visible panel may act on this window-level shortcut:
      // offsetParent is null inside display:none subtrees, and content outside an open
      // modal dialog (or an inert-hidden sidebar) is marked aria-hidden/inert.
      if (button.offsetParent === null || button.closest("[inert], [aria-hidden='true']") != null) {
        return;
      }
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = getTimelineEventTitle(props.event);
  const digest = props.event.data?.description ?? props.event.data?.digest ?? null;
  const loadedExcerpt = previewState.status === "ready" ? previewState.preview.textExcerpt : "";
  // Each stretch of text renders once: the excerpt supersedes a digest it covers, and an excerpt
  // that only repeats a description-backed title (agent events preview their own description) adds
  // nothing. A generic kind-label title never suppresses the excerpt, since a prompt can happen to
  // open with those same words.
  const excerpt =
    props.event.data?.description != null && excerptCovers(loadedExcerpt, title)
      ? ""
      : loadedExcerpt;
  const eventText = digest === title || excerptCovers(loadedExcerpt, digest) ? null : digest;

  return (
    <div className="border-border bg-surface-secondary mx-3 mb-3 shrink-0 rounded-md border p-3">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-content-primary min-w-0 text-xs font-medium">{title}</span>
          <time
            dateTime={new Date(props.event.ts).toISOString()}
            className="text-muted counter-nums shrink-0 text-[10px]"
          >
            {formatTimelineTime(props.event.ts)}
          </time>
        </div>
        {eventText ? (
          <div className="text-content-secondary max-h-24 overflow-hidden text-xs whitespace-pre-wrap">
            {eventText}
          </div>
        ) : null}
        {previewState.status === "loading" ? (
          <div className="text-muted text-xs">Loading preview…</div>
        ) : excerpt ? (
          <div className="border-border flex min-w-0 flex-col gap-1 border-t pt-2">
            <span className="text-muted text-[10px] capitalize">
              {previewState.status === "ready" ? previewState.preview.role : ""}
            </span>
            <div className="text-content-secondary max-h-24 overflow-hidden text-xs whitespace-pre-wrap">
              {excerpt}
            </div>
          </div>
        ) : digest == null ? (
          <div className="text-muted text-xs">Preview unavailable</div>
        ) : null}
      </div>

      {hasTranscriptTarget || anchor?.childWorkspaceId ? (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <div className="flex flex-wrap gap-2">
            {hasTranscriptTarget ? (
              <button
                type="button"
                ref={revealButtonRef}
                data-testid="timeline-reveal"
                disabled={revealState === "revealing"}
                onClick={() => void handleReveal()}
                className="border-border bg-surface-primary text-content-primary hover:bg-hover focus-visible:ring-accent rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
              >
                {revealState === "revealing" ? "Revealing…" : "Reveal in transcript"}
              </button>
            ) : null}
            {anchor?.childWorkspaceId ? (
              <button
                type="button"
                disabled={!childWorkspace || !workspaceContext}
                onClick={() => {
                  if (childWorkspace && workspaceContext) {
                    workspaceContext.setSelectedWorkspace(toWorkspaceSelection(childWorkspace));
                  }
                }}
                className="border-border bg-surface-primary text-content-primary hover:bg-hover focus-visible:ring-accent rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:opacity-60"
              >
                Open child workspace
              </button>
            ) : null}
          </div>
          {revealState === "not-found" ? (
            <div data-testid="timeline-reveal-not-found" className="text-muted text-[10px]">
              Too far back; showing preview only
            </div>
          ) : revealState === "error" ? (
            <div className="text-muted text-[10px]">Reveal unavailable</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface TimelinePanelViewProps extends TimelinePanelProps {
  timeline: WorkspaceTimelineSnapshot;
  workspaceStore: TimelineWorkspaceStore;
}

export function TimelinePanelView(props: TimelinePanelViewProps) {
  const timeline = props.timeline;
  const workspaceStore = props.workspaceStore;
  // listener keeps duplicate mounts in sync: a CSS-hidden sidebar tab and the mobile
  // timeline dialog can both be mounted, sharing this persisted filter.
  const [storedFilter, setStoredFilter] = usePersistedState<string>(
    `timeline-filter:${props.workspaceId}`,
    "all",
    { listener: true }
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const filter = isTimelineFilter(storedFilter) ? storedFilter : "all";
  const filteredEvents = dropSupersededTaskRows(
    timeline.events.filter(
      (event) => filter === "all" || getTimelineEventCategories(event).includes(filter)
    )
  );
  const selectedEvent = filteredEvents.find((event) => event.id === selectedEventId);
  const dayGroups = groupEventsByDay(filteredEvents);

  const toggleRun = (key: string) => {
    setExpandedRuns((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedEventId) {
          stopKeyboardPropagation(event);
          setSelectedEventId(null);
        }
      }}
    >
      <div className="border-border shrink-0 border-b px-3 py-2.5">
        <div className="scrollbar-none flex min-w-0 gap-1.5 overflow-x-auto">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setStoredFilter(item.value)}
              className={cn(
                "border-border bg-surface-secondary text-content-secondary hover:bg-hover shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                filter === item.value && "border-accent/60 bg-accent/10 text-content-primary"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="scrollbar-none min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3">
        {!timeline.initialized ? (
          <div className="text-muted flex h-full items-center justify-center text-sm">
            Loading timeline…
          </div>
        ) : timeline.events.length === 0 ? (
          timeline.loadError ? (
            // A failed subscription also lands here with no events, so it must not be reported as an
            // empty timeline: without this the panel stays stuck until it is unmounted and reopened.
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="text-content-primary text-sm font-medium">Timeline unavailable</div>
              <div className="text-danger max-w-full text-xs break-words">{timeline.loadError}</div>
              <button
                type="button"
                onClick={() => workspaceStore.retryTimeline(props.workspaceId)}
                className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="text-content-primary text-sm font-medium">No timeline events yet</div>
              <div className="text-muted mt-1 text-xs">
                Prompts, agent events, goals, heartbeats, sub-agents, and workflows land here.
              </div>
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {filteredEvents.length === 0 ? (
              // Older pages may still hold matches, so this keeps the pagination footer reachable.
              <div className="text-muted px-6 py-6 text-center text-sm">
                No events match this filter.
              </div>
            ) : null}
            {dayGroups.map((group) => (
              <section key={group.key} className="min-w-0">
                <h2 className="text-muted mb-2 text-[10px] font-semibold tracking-wide uppercase">
                  {group.label}
                </h2>
                <div className="flex min-w-0 flex-col gap-1">
                  {collapseConsecutiveEvents(group.events).map((item) => {
                    if (isCollapsedRun(item)) {
                      return (
                        <CollapsedEventRun
                          key={item.key}
                          run={item}
                          expanded={Boolean(expandedRuns[item.key])}
                          selectedEventId={selectedEventId}
                          onToggle={toggleRun}
                          onSelect={setSelectedEventId}
                        />
                      );
                    }
                    if (isRuleKind(getTimelineEventKind(item))) {
                      return (
                        <TimelineRuleRow
                          key={item.id}
                          event={item}
                          selected={selectedEventId === item.id}
                          onSelect={setSelectedEventId}
                        />
                      );
                    }
                    return (
                      <TimelineEventRow
                        key={item.id}
                        event={item}
                        selected={selectedEventId === item.id}
                        onSelect={setSelectedEventId}
                      />
                    );
                  })}
                </div>
              </section>
            ))}

            <div className="flex flex-col items-center gap-2 pt-1 pb-2">
              {timeline.loadError ? (
                <div className="text-danger max-w-full truncate text-xs">{timeline.loadError}</div>
              ) : null}
              {/* A dead subscription stops delivering new events, so it needs an explicit retry even
                  though rows are already on screen. A failed page recovers via "Load older". */}
              {timeline.loadErrorKind === "subscription" ? (
                <button
                  type="button"
                  onClick={() => workspaceStore.retryTimeline(props.workspaceId)}
                  className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none"
                >
                  Reconnect
                </button>
              ) : null}
              {timeline.hasOlder ? (
                <button
                  type="button"
                  disabled={timeline.loadingOlder}
                  onClick={() => void workspaceStore.loadOlderTimeline(props.workspaceId)}
                  className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
                >
                  {timeline.loadingOlder ? "Loading older…" : "Load older"}
                </button>
              ) : (
                <div className="text-muted text-[10px]">Beginning of timeline</div>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedEvent?.anchor ? (
        <TimelinePreviewCard
          key={selectedEvent.id}
          workspaceId={props.workspaceId}
          event={selectedEvent}
          workspaceStore={workspaceStore}
        />
      ) : null}
    </div>
  );
}

export function TimelinePanel(props: TimelinePanelProps) {
  const timeline = useWorkspaceTimeline(props.workspaceId);
  const workspaceStore = useWorkspaceStoreRaw();

  return (
    <TimelinePanelView
      workspaceId={props.workspaceId}
      timeline={timeline}
      workspaceStore={workspaceStore}
    />
  );
}
