import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import {
  DEFAULT_BASH_COLLAPSED_SUMMARY_MODE,
  type BashCollapsedSummaryMode,
} from "@/common/constants/storage";
import { capitalize } from "@/common/utils/capitalize";
import { formatDuration } from "@/common/utils/formatDuration";

export type BashCollapsedSummary =
  | { kind: "command"; command: string }
  | { kind: "intent"; intent: string }
  | { kind: "intent-command"; intent: string; command: string; durationLabel?: string };

interface BuildBashCollapsedSummaryOptions {
  args: BashToolArgs;
  result?: BashToolResult;
  isBackground: boolean;
  mode?: BashCollapsedSummaryMode;
}

const DURATION_TOKEN_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)`;
const TRAILING_DURATION_PATTERN = new RegExp(
  String.raw`\s+for\s+${DURATION_TOKEN_PATTERN}(?:\s+${DURATION_TOKEN_PATTERN})?\.?$`,
  "iu"
);
const TRAILING_USING_PATTERN = /^(?:(.*)\s+)?using\s+(.+?)\.?$/isu;
/** Two passes catch nested patterns, for example "doing work using cmd for 5s for 3m". */
const MAX_SANITIZE_PASSES = 2;

/** Intent improves scanability; command display remains configurable for verification. */
export function buildBashCollapsedSummary(
  options: BuildBashCollapsedSummaryOptions
): BashCollapsedSummary {
  const command = typeof options.args.script === "string" ? options.args.script : "";
  const mode = options.mode ?? DEFAULT_BASH_COLLAPSED_SUMMARY_MODE;
  if (mode === "command") {
    return { kind: "command", command };
  }

  const displayIntent = sanitizeDisplayableModelIntent(options.args.model_intent, command);
  if (mode === "intent") {
    return {
      kind: "intent",
      intent: displayIntent ?? getIntentOnlyFallback(options.args, command),
    };
  }

  if (!displayIntent) {
    return { kind: "command", command };
  }

  // typeof guard: kernel-mode nested reloads reconstruct partial results
  // without wall_duration_ms; skip the label instead of rendering "for —".
  const durationLabel =
    typeof options.result?.wall_duration_ms === "number" && !options.isBackground
      ? formatDuration(options.result.wall_duration_ms, "decimal")
      : undefined;

  // So users can verify what ran.
  return { kind: "intent-command", intent: displayIntent, command, durationLabel };
}

/** Models may echo `using <command>` and `for <duration>` despite schema guidance, so strip those since Xum appends them. */
export function sanitizeModelIntent(rawIntent: unknown, command: string): string | undefined {
  if (typeof rawIntent !== "string") {
    return undefined;
  }

  let intent = rawIntent.trim().replace(/\s+/gu, " ");
  if (!intent) {
    return undefined;
  }

  for (let i = 0; i < MAX_SANITIZE_PASSES; i++) {
    const before = intent;
    intent = stripTrailingDuration(intent);
    intent = stripTrailingUsingCommand(intent, command);
    intent = stripTrailingDuration(intent);
    if (intent === before) {
      break;
    }
  }

  intent = intent.trim();
  if (!intent) {
    return undefined;
  }

  return capitalize(intent);
}

/** Sanitized intent, or undefined when it merely restates the command. */
export function sanitizeDisplayableModelIntent(
  rawIntent: unknown,
  command: string
): string | undefined {
  const intent = sanitizeModelIntent(rawIntent, command);
  return intent && normalizeForComparison(intent) !== normalizeForComparison(command)
    ? intent
    : undefined;
}

function getIntentOnlyFallback(args: BashToolArgs, command: string): string {
  const displayName = typeof args.display_name === "string" ? args.display_name.trim() : "";
  if (displayName && normalizeForComparison(displayName) !== normalizeForComparison(command)) {
    return capitalize(displayName);
  }

  return "Bash command";
}

function stripTrailingDuration(intent: string): string {
  return intent.replace(TRAILING_DURATION_PATTERN, "").trim();
}

function stripTrailingUsingCommand(intent: string, command: string): string {
  const match = TRAILING_USING_PATTERN.exec(intent);
  if (!match) {
    return intent;
  }

  const prefix = match[1]?.trim() ?? "";
  const candidate = stripWrappingQuotes(match[2] ?? "");
  if (normalizeForComparison(candidate) !== normalizeForComparison(command)) {
    return intent;
  }

  return prefix;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quoteMatch = /^([`'"])(.*)\1$/u.exec(trimmed);
  return quoteMatch?.[2]?.trim() ?? trimmed;
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
