import { useState, type ReactElement } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";

import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import { parseAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";

interface AgentPeerMessageProps {
  message: DisplayedMessage & { type: "assistant" };
  className?: string;
}

/**
 * Intra-tree agent peer messages are machine-authored, untrusted input: keep them visible and
 * attributable (sender + relationship) without a full user bubble. Payloads are assistant-role
 * synthetic pre-turn rows (peer bytes never gain user-role authority); rendering is gated on the
 * backend-attached agent-peer-message metadata (see displayedMessageBuilder), so a lookalike
 * envelope in ordinary text renders as a plain message.
 */
export function AgentPeerMessage(props: AgentPeerMessageProps): ReactElement {
  // Peer traffic can be chatty; keep the transcript scannable until the user opts in.
  const [expanded, setExpanded] = useState(false);
  const meta = props.message.agentPeerMessage;
  const envelope = parseAgentMessageEnvelope(props.message.content);
  const fromTitle = meta?.fromTitle ?? envelope?.fromTitle;
  const fromWorkspaceId = meta?.fromWorkspaceId ?? envelope?.from;
  const relationship = meta?.relationship ?? envelope?.relationship;

  return (
    <div
      data-agent-peer-message
      data-message-block
      // Incoming machine traffic reads as an assistant-side row (left-aligned), not a user bubble.
      className={cn("my-2 flex min-w-0 flex-col items-start", props.className)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="text-muted hover:bg-muted/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <span className="bg-muted/20 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
          agent message
        </span>
        <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">Message from {fromTitle ?? fromWorkspaceId ?? "agent"}</span>
        {relationship != null && (
          <span className="bg-muted/20 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {relationship}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0", expanded && "rotate-90")}
        />
        <span className="sr-only">{expanded ? "Hide message" : "Show message"}</span>
      </button>
      {expanded &&
        (envelope != null ? (
          <TranscriptQuoteRoot text={envelope.message} className="mt-1.5 w-full">
            <div className="border-border bg-muted/5 rounded-md border p-2">
              <MarkdownRenderer content={envelope.message} className="text-sm leading-relaxed" />
            </div>
          </TranscriptQuoteRoot>
        ) : (
          // Defensive fallback: metadata says peer message but the envelope failed to parse
          // (e.g. truncated history row) — show the raw model-facing text instead of hiding it.
          <pre className="text-muted bg-muted/5 border-border mt-1.5 max-h-[40vh] w-full overflow-y-auto rounded-md border p-2 text-xs leading-relaxed whitespace-pre-wrap">
            {props.message.content}
          </pre>
        ))}
    </div>
  );
}
