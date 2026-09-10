import type { IntuitionToolArgs, IntuitionToolResult } from "@/common/types/tools";
import { IntuitionToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { GenericToolCall } from "./GenericToolCall";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

type IntuitionView = IntuitionToolResult | { kind: "pending" } | { kind: "invalid" };

export function toIntuitionView(result: unknown): IntuitionView {
  const unwrapped = unwrapResult(result);
  if (unwrapped == null) return { kind: "pending" };
  if (isToolErrorResult(unwrapped)) {
    return { kind: "error", isError: true, message: unwrapped.error };
  }
  const parsed = IntuitionToolResultSchema.safeParse(unwrapped);
  return parsed.success ? parsed.data : { kind: "invalid" };
}

interface IntuitionToolCallProps {
  args: IntuitionToolArgs;
  result?: unknown;
  status?: ToolStatus;
}

export function IntuitionToolCall(props: IntuitionToolCallProps) {
  const { expanded, toggleExpanded } = useToolExpansion();
  const view = toIntuitionView(props.result);
  if (view.kind === "invalid") return <GenericToolCall {...props} toolName="intuition" />;

  const status = view.kind === "error" ? "failed" : (props.status ?? "pending");
  const memories = view.kind === "recognized" ? view.memories : [];
  const candidates = view.kind === "recognized" || view.kind === "uncertain" ? view.candidates : [];
  const topRelevance = Math.max(0, ...[...memories, ...candidates].map((item) => item.relevance));
  const badge =
    view.kind === "recognized"
      ? `recognized ${memories.length}`
      : view.kind === "uncertain"
        ? candidates.length > 0
          ? `uncertain · ${candidates.length} ${candidates.length === 1 ? "lead" : "leads"}`
          : "no matches"
        : view.kind === "limit_reached"
          ? "limit"
          : null;

  // SECURITY AUDIT: cues and memory contents are attacker-controlled. Render all
  // fields as plain React text, never Markdown or HTML (including excerpts).
  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader
        className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] @[400px]:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto]"
        role="button"
        tabIndex={0}
        aria-label="Memory intuition details"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="intuition" />
        <span className="text-muted-foreground truncate italic">{props.args.cue}</span>
        <span className="text-secondary bg-code-bg counter-nums rounded px-1 whitespace-nowrap empty:p-0">
          {badge}
        </span>
        <span className="text-muted counter-nums hidden whitespace-nowrap @[400px]:inline">
          {topRelevance > 0 ? `${Math.round(topRelevance * 100)}%` : null}
        </span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>
      {expanded && (
        <ToolDetails className="break-words">
          {view.kind === "pending" && (
            <div className="text-muted italic">
              {status === "redacted"
                ? "Output excluded from shared transcript"
                : "Waiting for result"}
            </div>
          )}
          {view.kind === "error" && <ErrorBox>{view.message}</ErrorBox>}
          {view.kind === "limit_reached" && <div className="text-muted">{view.message}</div>}
          {memories.map((memory, index) => (
            <div key={index} className="border-border-light border-b px-2 py-2 last:border-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <span className="text-foreground break-all">{memory.path}</span>
                <span className="text-muted counter-nums">
                  {Math.round(memory.relevance * 100)}%
                </span>
              </div>
              <div className="text-secondary mt-1">{memory.why}</div>
              <div className="text-foreground mt-2 whitespace-pre-wrap">{memory.excerpt}</div>
            </div>
          ))}
          {candidates.length > 0 && (
            <div className="px-2 py-2">
              <div className="text-muted mb-1">Uncertain leads</div>
              {candidates.map((candidate, index) => (
                <div key={index} className="py-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <span className="text-foreground break-all">{candidate.path}</span>
                    <span className="text-muted counter-nums">
                      {Math.round(candidate.relevance * 100)}%
                    </span>
                  </div>
                  {candidate.description && (
                    <div className="text-secondary">{candidate.description}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {view.kind === "uncertain" && candidates.length === 0 && (
            <div className="text-muted italic">No relevant memories found.</div>
          )}
          {view.kind === "uncertain" && view.note && (
            <div className="text-muted mt-1">{view.note}</div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
