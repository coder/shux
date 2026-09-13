import { normalizeAgentId } from "@/common/utils/agentIds";

/** Default per-turn usage cap for the experimental advisor tool. */
export const ADVISOR_DEFAULT_MAX_USES_PER_TURN = 3;

/** Upper bound on the advisor tool's `question` input (schema and description share it). */
export const ADVISOR_QUESTION_MAX_CHARS = 2000;

const ADVISOR_ENABLED_BY_DEFAULT_AGENT_IDS = new Set(["exec", "plan"]);

export function isAdvisorEnabledByDefaultForAgent(agentId: string): boolean {
  return ADVISOR_ENABLED_BY_DEFAULT_AGENT_IDS.has(normalizeAgentId(agentId, ""));
}

export function resolveAdvisorEnabledForAgent(
  agentId: string,
  advisorEnabledOverride: boolean | undefined
): boolean {
  return advisorEnabledOverride ?? isAdvisorEnabledByDefaultForAgent(agentId);
}

/** Tail-biased truncation budget for same-step commentary included in advisor handoffs. */
export const ADVISOR_HANDOFF_MAX_TEXT_CHARS = 4000;

/** Tail-biased truncation budget for same-step reasoning included in advisor handoffs. */
export const ADVISOR_HANDOFF_MAX_REASONING_CHARS = 4000;

/**
 * Shared guidance for when and how to use the advisor tool.
 * Reused by the tool description and the system-prompt advisor-guidance section.
 *
 * The "no tools / supply context" sentences exist because calling agents
 * frequently invoke the advisor with insufficient context, as if it could
 * investigate on its own. The advisor only sees the existing transcript plus
 * the `question`, so the caller is responsible for surfacing the relevant
 * files, errors, and options before (or inside) the call.
 */
export const ADVISOR_USAGE_GUIDANCE =
  "Use this when you need help with planning ambiguity or high-impact architectural decisions, " +
  "when weighing tradeoffs between approaches, or after repeated failures when the strategy is unclear. " +
  "The advisor has no tools — it cannot read files, run commands, search code, or browse — and only " +
  "sees the existing conversation transcript plus your `question`. Before calling, make sure the " +
  "relevant files, errors, and options are already visible in the transcript (read them first) or paste " +
  "the essential excerpts into `question`. Frame a specific decision or tradeoff; do not ask the advisor " +
  "to investigate something it cannot see.";

/** Description shown to the model when the advisor tool is registered. */
export const ADVISOR_TOOL_DESCRIPTION =
  "Ask a stronger model for strategic advice based on the live conversation transcript. " +
  ADVISOR_USAGE_GUIDANCE +
  ` Pass a brief \`question\` (at most ${ADVISOR_QUESTION_MAX_CHARS} characters) summarizing the decision or ambiguity.`;

/**
 * System prompt for the nested advisor model call.
 * Keep the role boundary explicit because the advisor sees the live transcript
 * from the calling assistant. The prompt uses capability wording instead of
 * policy wording so the advisor does not waste effort reasoning about tools or
 * whether it should answer the end user directly.
 */
export const ADVISOR_SYSTEM_PROMPT = `You are a strategic advisor for the calling assistant.

Your job is to help the calling assistant decide what to do next based on the live conversation transcript.
You are not the assistant responding to the end user.
You have no tools available. You cannot execute commands, inspect files, edit code, browse, or call tools.

Provide concise, actionable guidance grounded in the conversation so far.
Focus on the highest-leverage advice:
- clarify the best strategy when the path is ambiguous
- compare tradeoffs between plausible approaches
- identify key risks, assumptions, and next steps

Address the calling assistant directly, not the end user.
Do not ask the end user follow-up questions.
Do not speak as if you are about to take actions yourself.
Do not narrate tool use, file inspection, or implementation steps as your own actions.
You may suggest user-facing wording when helpful, but keep the response addressed to the calling assistant.

If the current direction already looks sound, confirm it briefly and explain why.
Keep the response concise and pointed.
The final user message may contain a structured advisor handoff summarizing the immediate consultation request and same-step context.`;
