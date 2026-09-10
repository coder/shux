/**
 * Command registry - All slash commands are declared here
 */

import type {
  SlashCommandDefinition,
  ParsedCommand,
  SlashSuggestion,
  SuggestionDefinition,
  SlashSuggestionContext,
  SlashCommandVisibilityContext,
} from "./types";
import minimist from "minimist";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import { assert } from "@/common/utils/assert";
import { isExperimentEnabled as readExperimentEnabled } from "@/browser/hooks/useExperiments";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { parseGoalBudgetInputCents } from "@/common/utils/goals/budgetParser";
import { HEARTBEAT_MAX_INTERVAL_MS, HEARTBEAT_MIN_INTERVAL_MS } from "@/constants/heartbeat";
import { WORKSPACE_ONLY_COMMAND_KEYS } from "@/constants/slashCommands";

function tokenizeCommandLine(input: string): string[] {
  return (input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
    token.replace(/^"(.*)"$/, "$1")
  );
}

/**
 * Parse multiline command input into first-line tokens and remaining message.
 * Used by commands that support messages on subsequent lines (/compact, /new).
 */
function parseMultilineCommand(rawInput: string): {
  firstLine: string;
  tokens: string[];
  message: string | undefined;
  hasMultiline: boolean;
} {
  const hasMultiline = rawInput.includes("\n");
  const lines = rawInput.split("\n");
  const firstLine = lines[0];
  const remainingLines = lines.slice(1).join("\n").trim();

  const tokens = tokenizeCommandLine(firstLine);

  return {
    firstLine,
    tokens,
    message: remainingLines.length > 0 ? remainingLines : undefined,
    hasMultiline,
  };
}

interface CommandHeaderBody {
  headerTokens: string[];
  body: string | undefined;
  bodyHadLeadingBlankLine: boolean;
}

function trimOuterBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

function parseCommandHeaderBody(rawInput: string): CommandHeaderBody {
  const newlineIndex = rawInput.indexOf("\n");
  const header = newlineIndex === -1 ? rawInput : rawInput.slice(0, newlineIndex);
  const rawBody = newlineIndex === -1 ? "" : rawInput.slice(newlineIndex + 1);
  const body = trimOuterBlankLines(rawBody);

  return {
    headerTokens: tokenizeCommandLine(header),
    body: body.trim().length > 0 ? body : undefined,
    bodyHadLeadingBlankLine: /^\s*\r?\n/.test(rawBody),
  };
}

// Suggestion helper functions
function filterAndMapSuggestions<T extends SuggestionDefinition>(
  definitions: readonly T[],
  partial: string,
  build: (definition: T) => SlashSuggestion
): SlashSuggestion[] {
  const normalizedPartial = partial.trim().toLowerCase();

  return definitions
    .filter((definition) =>
      normalizedPartial ? definition.key.toLowerCase().startsWith(normalizedPartial) : true
    )
    .map((definition) => build(definition));
}

const clearCommandDefinition: SlashCommandDefinition = {
  key: "clear",
  description: "Clear history, or use --soft to reset context while preserving history",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }) => {
    if (cleanRemainingTokens.length === 0) {
      return { type: "clear", mode: "hard" };
    }

    if (cleanRemainingTokens.length === 1 && cleanRemainingTokens[0] === "--soft") {
      return { type: "clear", mode: "soft" };
    }

    return {
      type: "unknown-command",
      command: "clear",
      subcommand: cleanRemainingTokens[0],
    };
  },
};

const dreamCommandDefinition: SlashCommandDefinition = {
  key: "dream",
  experimentGate: EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
  description:
    "Consolidate this workspace's agent memory now (merge duplicates, prune stale facts)",
  handler: (): ParsedCommand => ({ type: "dream" }),
};

const refineCommandDefinition: SlashCommandDefinition = {
  key: "refine",
  experimentGate: EXPERIMENT_IDS.RLM,
  description:
    "Distill durable lessons from this workspace's trajectory into staged memory/skill edits; approve them with '/refine apply'",
  handler: ({ rawInput }): ParsedCommand => {
    // Security: /refine only STAGES model-proposed edits; the explicit
    // "apply" argument is the user's approval step that writes them.
    const arg = rawInput.trim();
    if (arg === "apply") return { type: "refine", apply: true };
    if (arg === "") return { type: "refine" };
    // Mistyped approvals ("/refine Apply", "/refine apply now") must NOT
    // fall through to a fresh run: that would overwrite the staged proposal
    // the user meant to approve and cost another model call.
    return { type: "unknown-command", command: "refine", subcommand: arg };
  },
};

const compactCommandDefinition: SlashCommandDefinition = {
  key: "compact",
  description:
    "Compact conversation history using AI summarization. Use -t <tokens> to set max output tokens, -m <model> to set compaction model. Add continue message on lines after the command.",
  inputHint: SLASH_COMMAND_HINTS.compact,
  handler: ({ rawInput }): ParsedCommand => {
    const {
      tokens: firstLineTokens,
      message: remainingLines,
      hasMultiline,
    } = parseMultilineCommand(rawInput);

    // Parse flags from first line using minimist
    const parsed = minimist(firstLineTokens, {
      string: ["t", "c", "m"],
      unknown: (arg: string) => {
        // Unknown flags starting with - are errors
        if (arg.startsWith("-")) {
          return false;
        }
        return true;
      },
    });

    // Check for unknown flags (only from first line)
    const unknownFlags = firstLineTokens.filter(
      (token) => token.startsWith("-") && token !== "-t" && token !== "-c" && token !== "-m"
    );
    if (unknownFlags.length > 0) {
      return {
        type: "unknown-command",
        command: "compact",
        subcommand: `Unknown flag: ${unknownFlags[0]}`,
      };
    }

    // Validate -t value if present
    let maxOutputTokens: number | undefined;
    if (parsed.t !== undefined) {
      const tokens = parseInt(parsed.t as string, 10);
      if (isNaN(tokens) || tokens <= 0) {
        return {
          type: "unknown-command",
          command: "compact",
          subcommand: `-t requires a positive number, got ${String(parsed.t)}`,
        };
      }
      maxOutputTokens = tokens;
    }

    // Handle -m (model) flag: resolve abbreviation if present, otherwise use as-is
    let model: string | undefined;
    if (parsed.m !== undefined && typeof parsed.m === "string" && parsed.m.trim().length > 0) {
      const normalized = normalizeModelInput(parsed.m.trim());
      model = normalized.model ?? parsed.m.trim();
    }

    // Reject extra positional arguments UNLESS they're from multiline content
    // (multiline content gets parsed as positional args by minimist since newlines become spaces)
    if (parsed._.length > 0 && !hasMultiline) {
      return {
        type: "unknown-command",
        command: "compact",
        subcommand: `Unexpected argument: ${parsed._[0]}`,
      };
    }

    // Determine continue message:
    // 1. If -c flag present (backwards compat), use it
    // 2. Otherwise, use multiline content (new behavior)
    let continueMessage: string | undefined;

    if (parsed.c !== undefined && typeof parsed.c === "string" && parsed.c.trim().length > 0) {
      // -c flag takes precedence (backwards compatibility)
      continueMessage = parsed.c.trim();
    } else if (remainingLines) {
      // Use multiline content
      continueMessage = remainingLines;
    }

    return { type: "compact", maxOutputTokens, continueMessage, model };
  },
};

const modelCommandDefinition: SlashCommandDefinition = {
  key: "model",
  description: "Select AI model",
  inputHint: SLASH_COMMAND_HINTS.model,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return { type: "model-help" };
    }

    if (cleanRemainingTokens.length === 1) {
      const token = cleanRemainingTokens[0];
      const normalized = normalizeModelInput(token);

      // Resolve abbreviation if present, otherwise use as full model string
      return {
        type: "model-set",
        modelString: normalized.model ?? token,
      };
    }

    // Too many arguments
    return {
      type: "unknown-command",
      command: "model",
      subcommand: cleanRemainingTokens[1],
    };
  },
  suggestions: ({ stage, partialToken }) => {
    // Stage 1: /model [abbreviation]
    if (stage === 1) {
      const abbreviationSuggestions = Object.entries(MODEL_ABBREVIATIONS).map(
        ([abbrev, fullModel]) => ({
          key: abbrev,
          description: fullModel,
        })
      );

      return filterAndMapSuggestions(abbreviationSuggestions, partialToken, (definition) => ({
        id: `command:model:${definition.key}`,
        display: definition.key,
        description: definition.description,
        replacement: `/model ${definition.key}`,
      }));
    }

    return null;
  },
};

const vimCommandDefinition: SlashCommandDefinition = {
  key: "vim",
  description: "Toggle Vim mode for the chat input",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length > 0) {
      return {
        type: "unknown-command",
        command: "vim",
        subcommand: cleanRemainingTokens[0],
      };
    }

    return { type: "vim-toggle" };
  },
};

const planOpenCommandDefinition: SlashCommandDefinition = {
  key: "open",
  description: "Open plan in external editor",
  appendSpace: false,
  handler: (): ParsedCommand => ({ type: "plan-open" }),
};

const planCommandDefinition: SlashCommandDefinition = {
  key: "plan",
  description: "Show or edit the current plan",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length > 0) {
      return { type: "unknown-command", command: "plan", subcommand: cleanRemainingTokens[0] };
    }
    return { type: "plan-show" };
  },
  children: [planOpenCommandDefinition],
};

const forkCommandDefinition: SlashCommandDefinition = {
  key: "fork",
  description: "Fork workspace. Optionally include a start message.",
  inputHint: SLASH_COMMAND_HINTS.fork,
  handler: ({ rawInput }): ParsedCommand => {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      // No args → immediate fork with auto-generated name, no start message
      return { type: "fork" };
    }

    // Everything after /fork is the start message (name is auto-generated by backend)
    return {
      type: "fork",
      startMessage: trimmed,
    };
  },
};

const newCommandDefinition: SlashCommandDefinition = {
  key: "new",
  description:
    "Create a new workspace from the project's trunk branch. Optionally include a start message.",
  inputHint: SLASH_COMMAND_HINTS.new,
  handler: ({ rawInput }): ParsedCommand => {
    // Mirror /fork: everything after /new is the optional start message.
    // The workspace branch name is auto-generated by the backend (like /fork),
    // and the title is filled in from the start message when one is provided.
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      return { type: "new" };
    }
    return {
      type: "new",
      startMessage: trimmed,
    };
  },
};

const IDLE_USAGE = `/idle ${SLASH_COMMAND_HINTS.idle}`;
const HEARTBEAT_USAGE = `/heartbeat ${SLASH_COMMAND_HINTS.heartbeat}`;
const HEARTBEAT_INTERVAL_GRANULARITY_MS = 60_000;

// Keep slash-command validation aligned with the shared heartbeat bounds.
assert(
  HEARTBEAT_MIN_INTERVAL_MS % HEARTBEAT_INTERVAL_GRANULARITY_MS === 0,
  "Heartbeat minimum interval must be expressed in whole minutes"
);
assert(
  HEARTBEAT_MAX_INTERVAL_MS % HEARTBEAT_INTERVAL_GRANULARITY_MS === 0,
  "Heartbeat maximum interval must be expressed in whole minutes"
);

const HEARTBEAT_MINUTES_MIN = HEARTBEAT_MIN_INTERVAL_MS / HEARTBEAT_INTERVAL_GRANULARITY_MS;
const HEARTBEAT_MINUTES_MAX = HEARTBEAT_MAX_INTERVAL_MS / HEARTBEAT_INTERVAL_GRANULARITY_MS;

const idleCommandDefinition: SlashCommandDefinition = {
  key: "idle",
  description: `Configure idle compaction for this project. Usage: ${IDLE_USAGE}`,
  inputHint: SLASH_COMMAND_HINTS.idle,
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return {
        type: "command-missing-args",
        command: "idle",
        usage: IDLE_USAGE,
      };
    }

    const arg = cleanRemainingTokens[0].toLowerCase();

    // "off", "disable", or "0" all disable idle compaction
    if (arg === "off" || arg === "disable" || arg === "0") {
      return { type: "idle-compaction", hours: null };
    }

    const hours = parseInt(arg, 10);
    if (isNaN(hours) || hours < 1) {
      return {
        type: "command-invalid-args",
        command: "idle",
        input: arg,
        usage: IDLE_USAGE,
      };
    }

    return { type: "idle-compaction", hours };
  },
};

const heartbeatCommandDefinition: SlashCommandDefinition = {
  key: "heartbeat",
  experimentGate: EXPERIMENT_IDS.WORKSPACE_HEARTBEATS,
  description: `Configure workspace heartbeats. Usage: ${HEARTBEAT_USAGE}`,
  inputHint: SLASH_COMMAND_HINTS.heartbeat,
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return {
        type: "command-missing-args",
        command: "heartbeat",
        usage: HEARTBEAT_USAGE,
      };
    }

    const input = cleanRemainingTokens.join(" ");
    if (cleanRemainingTokens.length !== 1) {
      return {
        type: "command-invalid-args",
        command: "heartbeat",
        input,
        usage: HEARTBEAT_USAGE,
      };
    }

    const arg = cleanRemainingTokens[0].toLowerCase();
    if (arg === "off" || arg === "disable" || arg === "0") {
      return { type: "heartbeat-set", minutes: null };
    }

    if (!/^\d+$/.test(arg)) {
      return {
        type: "command-invalid-args",
        command: "heartbeat",
        input,
        usage: HEARTBEAT_USAGE,
      };
    }

    const minutes = Number(arg);
    if (
      !Number.isSafeInteger(minutes) ||
      minutes < HEARTBEAT_MINUTES_MIN ||
      minutes > HEARTBEAT_MINUTES_MAX
    ) {
      return {
        type: "command-invalid-args",
        command: "heartbeat",
        input,
        usage: HEARTBEAT_USAGE,
      };
    }

    return { type: "heartbeat-set", minutes };
  },
};

/**
 * Slash-command-shaped wrapper around the canonical
 * `parseGoalBudgetInputCents` parser. Returns `null` for both "no budget"
 * (empty) and "invalid input" — slash command callers do not need to
 * distinguish between those cases.
 *
 * Pre-DEREM-21 (Coder-agents-review P3) this had a stricter regex that
 * required a `$` prefix; that has been unified with the GoalTab editor.
 */
export function parseGoalBudgetCents(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = parseGoalBudgetInputCents(value);
  return typeof parsed === "number" ? parsed : null;
}

function parseGoalTurnCap(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const GOAL_USAGE = `/goal ${SLASH_COMMAND_HINTS.goal}`;
const GOAL_BUDGET_USAGE = "/goal budget <amount>";

function invalidGoalBodyArgs(
  body: string
): Extract<ParsedCommand, { type: "command-invalid-args" }> {
  return { type: "command-invalid-args", command: "goal", input: body, usage: GOAL_USAGE };
}

function unknownGoalFlag(flag: string): Extract<ParsedCommand, { type: "command-unknown-flag" }> {
  return { type: "command-unknown-flag", command: "goal", flag, usage: GOAL_USAGE };
}

// Goal subcommands whose only behavior is to emit a single typed lifecycle
// event with no arguments. Centralizing the action→type mapping keeps the
// handler from repeating identical three-line `if (action === "...")` blocks
// (each with the same `if (body) return invalidGoalBodyArgs(body)` guard)
// for every new lifecycle verb.
type SimpleGoalLifecycleType = Extract<
  ParsedCommand,
  { type: "goal-clear" | "goal-pause" | "goal-resume" }
>["type"];
const SIMPLE_GOAL_LIFECYCLE_TYPES: Record<string, SimpleGoalLifecycleType> = {
  clear: "goal-clear",
  pause: "goal-pause",
  resume: "goal-resume",
};

const goalCommandDefinition: SlashCommandDefinition = {
  key: "goal",
  description: `Create, view, or clear a workspace goal. Usage: ${GOAL_USAGE}`,
  inputHint: SLASH_COMMAND_HINTS.goal,
  appendSpace: false,
  handler: ({ rawInput }): ParsedCommand => {
    const { headerTokens, body, bodyHadLeadingBlankLine } = parseCommandHeaderBody(rawInput);

    if (headerTokens.length === 0 && !body) {
      return { type: "goal-show" };
    }

    const action = headerTokens[0]?.toLowerCase();
    if (action != null && action in SIMPLE_GOAL_LIFECYCLE_TYPES) {
      if (body) {
        return invalidGoalBodyArgs(body);
      }
      return { type: SIMPLE_GOAL_LIFECYCLE_TYPES[action] };
    }

    if (action === "complete") {
      if (body) {
        return invalidGoalBodyArgs(body);
      }
      const parsed = minimist(headerTokens.slice(1), {
        string: ["summary"],
        unknown: (arg: string) => !arg.startsWith("-"),
      });
      const unknownFlag = headerTokens.slice(1).find((token) => {
        return token.startsWith("-") && token !== "--summary";
      });
      if (unknownFlag) {
        return unknownGoalFlag(unknownFlag);
      }
      if (parsed._.length > 0) {
        return {
          type: "command-invalid-args",
          command: "goal",
          input: parsed._.join(" "),
          usage: `/goal complete --summary "<summary>"`,
        };
      }
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : undefined;
      return summary ? { type: "goal-complete", summary } : { type: "goal-complete" };
    }

    if (action === "budget") {
      if (body) {
        return invalidGoalBodyArgs(body);
      }
      const budgetTokens = headerTokens.slice(1);
      if (budgetTokens.length === 0) {
        return {
          type: "command-missing-args",
          command: "goal",
          usage: GOAL_BUDGET_USAGE,
        };
      }
      if (budgetTokens.length > 1) {
        return {
          type: "command-invalid-args",
          command: "goal",
          input: budgetTokens.join(" "),
          usage: GOAL_BUDGET_USAGE,
        };
      }
      const budgetCents = parseGoalBudgetCents(budgetTokens[0]);
      if (budgetCents == null) {
        return {
          type: "command-invalid-args",
          command: "goal",
          input: budgetTokens[0],
          usage: GOAL_BUDGET_USAGE,
        };
      }
      return { type: "goal-budget", budgetCents };
    }

    let budgetCents: number | undefined;
    let turnCap: number | undefined;
    let objectiveStartIndex = 0;

    if (headerTokens[0] === "-b") {
      const budgetInput = headerTokens[1];
      if (budgetInput == null) {
        return {
          type: "command-missing-args",
          command: "goal",
          usage: GOAL_USAGE,
        };
      }

      const parsedBudgetCents = parseGoalBudgetCents(budgetInput);
      if (parsedBudgetCents == null) {
        return {
          type: "command-invalid-args",
          command: "goal",
          input: budgetInput,
          usage: GOAL_USAGE,
        };
      }

      budgetCents = parsedBudgetCents;
      objectiveStartIndex = 2;
    }

    if (headerTokens[objectiveStartIndex] === "--turns") {
      const turnInput = headerTokens[objectiveStartIndex + 1];
      const parsedTurnCap = parseGoalTurnCap(turnInput);
      if (parsedTurnCap == null) {
        return {
          type: "command-invalid-args",
          command: "goal",
          input: String(turnInput),
          usage: GOAL_USAGE,
        };
      }

      turnCap = parsedTurnCap;
      objectiveStartIndex += 2;
    }

    // Only a leading budget/turn flag prefix is command syntax; everything
    // after that is user-authored goal text so objectives can mention
    // flag-looking strings (including deprecated-looking budget flags).
    const objectiveTokens = headerTokens.slice(objectiveStartIndex);
    const headerObjective = objectiveTokens.join(" ").trim();
    const objective = [headerObjective, body]
      .filter((part): part is string => part != null && part.length > 0)
      .join(headerObjective && bodyHadLeadingBlankLine ? "\n\n" : "\n");
    if (objective.length === 0) {
      return {
        type: "command-missing-args",
        command: "goal",
        usage: GOAL_USAGE,
      };
    }

    const result: Extract<ParsedCommand, { type: "goal-set" }> = { type: "goal-set", objective };
    if (budgetCents !== undefined) {
      result.budgetCents = budgetCents;
    }
    if (turnCap !== undefined) {
      result.turnCap = turnCap;
    }

    return result;
  },
};

const WORKFLOW_COMMAND_USAGE = `/workflow ${SLASH_COMMAND_HINTS.workflow}`;

const workflowCommandDefinition: SlashCommandDefinition = {
  key: "workflow",
  description: "Run an explicit workflow by script path",
  experimentGate: EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
  inputHint: SLASH_COMMAND_HINTS.workflow,
  handler: ({ rawInput }): ParsedCommand => {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return { type: "command-missing-args", command: "workflow", usage: WORKFLOW_COMMAND_USAGE };
    }
    const firstWhitespace = trimmed.search(/\s/u);
    const scriptPath = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
    const argsText = firstWhitespace === -1 ? undefined : trimmed.slice(firstWhitespace).trim();
    return {
      type: "workflow-run",
      scriptPath,
      ...(argsText ? { argsText } : {}),
    };
  },
};

const debugLlmRequestCommandDefinition: SlashCommandDefinition = {
  key: "debug-llm-request",
  description: "Show the last LLM request sent (debug)",
  appendSpace: false,
  handler: (): ParsedCommand => ({ type: "debug-llm-request" }),
};

export const SLASH_COMMAND_DEFINITIONS: readonly SlashCommandDefinition[] = [
  clearCommandDefinition,
  compactCommandDefinition,
  dreamCommandDefinition,
  refineCommandDefinition,
  modelCommandDefinition,
  planCommandDefinition,

  forkCommandDefinition,
  newCommandDefinition,
  vimCommandDefinition,
  idleCommandDefinition,
  heartbeatCommandDefinition,
  goalCommandDefinition,
  workflowCommandDefinition,
  debugLlmRequestCommandDefinition,
];

export const SLASH_COMMAND_DEFINITION_MAP = new Map(
  SLASH_COMMAND_DEFINITIONS.map((definition) => [definition.key, definition])
);

const COMMAND_GHOST_HINT_PATTERN = /^\/(\S+) +$/;

function normalizeVisibilityContext(
  contextOrVariant?: SlashCommandVisibilityContext | SlashSuggestionContext["variant"]
): SlashCommandVisibilityContext {
  return typeof contextOrVariant === "string"
    ? { variant: contextOrVariant }
    : (contextOrVariant ?? {});
}

/**
 * Single visibility gate for every slash-command discovery surface. Keeping the
 * experiment on the command definition prevents one surface from forgetting to
 * hide a gated command when another surface already does.
 */
export function isSlashCommandVisible(
  definition: SlashCommandDefinition,
  context: SlashCommandVisibilityContext = {}
): boolean {
  if (context.variant === "creation" && WORKSPACE_ONLY_COMMAND_KEYS.has(definition.key)) {
    return false;
  }

  if (definition.experimentGate == null) {
    return true;
  }

  try {
    const resolveExperiment = context.isExperimentEnabled ?? readExperimentEnabled;
    return resolveExperiment(definition.experimentGate) === true;
  } catch {
    // Experiment check unavailable (e.g., test environments without window) — hide by default.
    return false;
  }
}

export function getCommandGhostHint(
  input: string,
  showCommandSuggestions: boolean,
  contextOrVariant?: SlashCommandVisibilityContext | SlashSuggestionContext["variant"]
): string | null {
  if (showCommandSuggestions) {
    return null;
  }

  const match = COMMAND_GHOST_HINT_PATTERN.exec(input);
  if (!match) {
    return null;
  }

  const commandKey = match[1];
  const definition = SLASH_COMMAND_DEFINITION_MAP.get(commandKey);
  if (
    !definition ||
    !isSlashCommandVisible(definition, normalizeVisibilityContext(contextOrVariant))
  ) {
    return null;
  }

  return definition.inputHint ?? null;
}
