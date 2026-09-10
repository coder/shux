import type { ReactElement } from "react";
import { BellRing } from "lucide-react";
import type { DisplayedMessage } from "@/common/types/message";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import { WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE } from "@/common/utils/workflowRunMessages";
import { CollapsibleMachineMessage } from "./CollapsibleMachineMessage";

interface BackgroundWorkWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  summary: string;
  className?: string;
}

export function getBackgroundWorkWakeSummary(content: string): string | null {
  const normalized = content.trimStart();
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.workspaceTurnsTerminal)) {
    return "Background workspace turn finished";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.awaitableWorkActive)) {
    return "Waiting for background work";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted)) {
    return "Background sub-agents finished";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.subagentsFailed)) {
    return "Background sub-agents failed";
  }
  // The terminal-attention drain delivers background workflow results as one coalesced
  // synthetic prompt without workflow-result metadata, so recognize it by its opening
  // sentence like the other machine-authored wakes above.
  if (normalized.startsWith(WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE)) {
    return "Background workflow finished";
  }
  return null;
}

/**
 * Background-work prompts are machine-authored control events, not user input. Keep the exact
 * model-facing directive inspectable without letting implementation details dominate the transcript.
 */
export function BackgroundWorkWakeMessage(props: BackgroundWorkWakeMessageProps): ReactElement {
  return (
    <CollapsibleMachineMessage
      content={props.message.content}
      summary={props.summary}
      icon={<BellRing aria-hidden="true" className="size-3.5 shrink-0" />}
      marker="background-work-wake"
      className={props.className}
    />
  );
}
