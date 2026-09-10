import type { ReactElement } from "react";
import { CircleStop, Target } from "lucide-react";
import { unescapeXml } from "@/common/utils/xml";
import { GOAL_OBJECTIVE_CLOSE_TAG, GOAL_OBJECTIVE_OPEN_TAG } from "@/constants/goals";

type GoalCardVariant = "continuation" | "budget-limit";

interface GoalSyntheticMessageContentProps {
  content: string;
  kind: GoalCardVariant;
}

const FIRST_PARAGRAPH_DELIMITER = "\n\n";
const MAX_LIMIT_REASON_LENGTH = 160;

function extractObjective(content: string): string | null {
  const objectiveStart = content.indexOf(GOAL_OBJECTIVE_OPEN_TAG);
  if (objectiveStart === -1) return null;

  const valueStart = objectiveStart + GOAL_OBJECTIVE_OPEN_TAG.length;
  const objectiveEnd = content.indexOf(GOAL_OBJECTIVE_CLOSE_TAG, valueStart);
  if (objectiveEnd === -1) return null;

  const objective = content.slice(valueStart, objectiveEnd).trim();
  return objective.length > 0 ? unescapeXml(objective) : null;
}

function extractFirstParagraph(content: string): string | null {
  const delimiterIndex = content.indexOf(FIRST_PARAGRAPH_DELIMITER);
  if (delimiterIndex === -1) return null;

  const paragraph = content.slice(0, delimiterIndex).trim();
  if (!paragraph) return null;
  if (paragraph.length > MAX_LIMIT_REASON_LENGTH) return null;
  if (paragraph.includes(GOAL_OBJECTIVE_OPEN_TAG)) return null;

  return paragraph;
}

/**
 * Hides model-only goal prompt internals while surfacing the user-
 * facing goal event.
 *
 * Aesthetic rationale (this is the card the user sees in the
 * transcript when Xum auto-continues an active goal or wraps up at a
 * budget limit):
 *
 *  • The card renders INSIDE the user-message bubble — the parent
 *    bubble already contributes `border + rounded-lg + px-3 py-2` plus
 *    a tinted surface. The pre-existing implementation added a second
 *    border + tinted background + extra padding inside that bubble,
 *    which doubled the chrome and made the card look heavy and out of
 *    place; the `min-w-[18rem]` blew out the bubble even for short
 *    objectives so it sat awkwardly mid-transcript. The new layout
 *    treats this content as plain text inside the bubble and lets the
 *    bubble do the framing.
 *
 *  • A small inline icon replaces the chunky icon "badge" so the icon
 *    sits at the same scale as the title text. `mt-0.5` vertically
 *    centers it against the first text line (the 16px icon vs 20px
 *    line-height of `text-sm` needs the 2px nudge).
 *
 *  • The `goal continuation` / `budget limit wrap-up` pill in the
 *    message meta row remains, so the user still sees the synthetic-
 *    nature label below the bubble alongside the timestamp.
 */
export function GoalSyntheticMessageContent(props: GoalSyntheticMessageContentProps): ReactElement {
  const objective = extractObjective(props.content);
  let title = "Continuing active goal";
  let description = "Xum is taking the next step automatically.";
  let Icon: typeof Target = Target;

  if (props.kind === "budget-limit") {
    title = "Goal limit reached";
    description = extractFirstParagraph(props.content) ?? "Xum is wrapping up the current goal.";
    Icon = CircleStop;
  }

  return (
    <div className="not-italic">
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden="true" className="text-muted mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug font-medium text-[var(--color-user-text)]">
            {title}
          </div>
          <div className="text-muted mt-0.5 text-xs leading-snug">{description}</div>
        </div>
      </div>
      {objective && (
        // The blockquote is intentionally outside the icon row so it
        // can span the full bubble width. A small top margin keeps it
        // visually grouped with the title/description above without
        // resurrecting the heavier `space-y-2` rhythm.
        <blockquote className="mt-2 border-l-2 border-[var(--color-user-border)] pl-3 text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-user-text)]">
          {objective}
        </blockquote>
      )}
    </div>
  );
}
