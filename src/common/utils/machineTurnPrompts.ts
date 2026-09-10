import type { TimelineEventKind } from "@/common/orpc/schemas/timeline";
import { WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE } from "@/common/utils/workflowRunMessages";

// Fallback openings used when specific muxMetadata is absent or only a persisted digest remains.
// Prompt producers and timeline classification share them so their wording cannot drift.
export const BASH_MONITOR_WAKE_HEADINGS = {
  matched: "A background bash monitor matched output.",
  lost: "Xum restarted and background bash monitors were lost.",
  mixed: "Background bash monitor updates (including monitors lost to a Xum restart).",
  // Do not reword existing headings above: persisted timeline rows classify by exact prefix.
  exited: "A monitored background bash process finished.",
  failed: "A background bash monitor failed at runtime.",
  mixedRuntimeFailure: "Background bash monitor updates (including runtime monitor failures).",
} as const;

export const BACKGROUND_WORK_WAKE_OPENINGS = {
  subagentsCompleted: "Background sub-agent task(s) have completed.",
  subagentsFailed: "Background sub-agent task(s) failed terminally and will not produce reports.",
  workspaceTurnsTerminal: "Background workspace turn(s) have reached a terminal state:",
  awaitableWorkActive: "You have active background ",
} as const;

const PROMPT_OPENINGS_BY_KIND: ReadonlyArray<{
  kind: TimelineEventKind;
  openings: readonly string[];
}> = [
  { kind: "turn.monitor_wake", openings: Object.values(BASH_MONITOR_WAKE_HEADINGS) },
  { kind: "workflow.result", openings: [WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE] },
  { kind: "turn.background_wake", openings: Object.values(BACKGROUND_WORK_WAKE_OPENINGS) },
];

/**
 * Classifies a machine-authored turn from its prompt text. Also used on persisted timeline rows,
 * whose digest is whitespace-collapsed and truncated to 120 characters, so every opening above must
 * stay single-spaced and shorter than that.
 */
export function classifyMachineTurnPromptKind(text: string): TimelineEventKind | null {
  const normalized = text.trimStart();
  for (const entry of PROMPT_OPENINGS_BY_KIND) {
    if (entry.openings.some((opening) => normalized.startsWith(opening))) {
      return entry.kind;
    }
  }
  return null;
}
