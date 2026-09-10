/**
 * Command parser for parsing chat commands
 */

import type { ParsedCommand, SlashCommandDefinition } from "./types";
import { SLASH_COMMAND_DEFINITION_MAP } from "./registry";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { parseThinkingInput, type ParsedThinkingInput } from "@/common/types/thinking";

function tokenizeSlashCommandTokens(input: string): string[] {
  return input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function unquoteSlashCommandToken(token: string): string {
  return token.replace(/^"(.*)"$/, "$1");
}

export function tokenizeSlashCommandArguments(input: string): string[] {
  return tokenizeSlashCommandTokens(input).map(unquoteSlashCommandToken);
}

/**
 * Parse a raw command string into a structured command
 * @param input The raw command string (e.g., "/model sonnet" or "/compact -t 5000")
 * @returns Parsed command or null if not a command
 */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Remove leading slash and split by spaces (respecting quotes)
  // Parse tokens from the full input so newlines can act as whitespace between args.
  const parts = tokenizeSlashCommandTokens(trimmed.substring(1));
  if (parts.length === 0) {
    return null;
  }

  const [commandKey, ...restTokens] = parts;
  const definition = SLASH_COMMAND_DEFINITION_MAP.get(commandKey);

  if (!definition) {
    // Parse oneshot syntax: /model, /model+thinking, /+thinking
    // Examples: /haiku, /opus+2, /+0, /haiku+medium, /sonnet+high
    const oneshotResult = commandKey ? parseOneshotCommandKey(commandKey) : null;
    if (oneshotResult) {
      // Extract the message: everything after the command key
      const commandKeyWithSlash = `/${commandKey}`;
      let message = trimmed.substring(commandKeyWithSlash.length);
      // Only trim spaces at the start, not newlines (preserves multiline messages)
      while (message.startsWith(" ")) {
        message = message.substring(1);
      }

      // If no message provided, show model help instead
      if (!message.trim()) {
        return { type: "model-help" };
      }

      return {
        type: "model-oneshot",
        ...oneshotResult,
        message,
      };
    }

    return {
      type: "unknown-command",
      command: commandKey ?? "",
      subcommand: restTokens[0],
    };
  }

  const path: SlashCommandDefinition[] = [definition];
  let remainingTokens = restTokens;

  while (remainingTokens.length > 0) {
    const currentDefinition = path[path.length - 1];
    const children = currentDefinition.children ?? [];
    const nextToken = remainingTokens[0];
    const nextDefinition = children.find((child) => child.key === nextToken);

    if (!nextDefinition) {
      break;
    }

    path.push(nextDefinition);
    remainingTokens = remainingTokens.slice(1);
  }

  const targetDefinition = path[path.length - 1];

  if (!targetDefinition.handler) {
    return {
      type: "unknown-command",
      command: commandKey ?? "",
      subcommand: remainingTokens[0],
    };
  }

  const cleanRemainingTokens = remainingTokens.map(unquoteSlashCommandToken);

  // Calculate rawInput: everything after the command key, preserving newlines
  // For "/compact -t 5000\nContinue here", rawInput should be "-t 5000\nContinue here"
  // For "/compact\nContinue here", rawInput should be "\nContinue here"
  // We trim leading spaces on the first line only, not newlines
  const commandKeyWithSlash = `/${commandKey}`;
  let rawInput = trimmed.substring(commandKeyWithSlash.length);
  // Only trim spaces at the start, not newlines
  while (rawInput.startsWith(" ")) {
    rawInput = rawInput.substring(1);
  }

  return targetDefinition.handler({
    definition: targetDefinition,
    path,
    remainingTokens,
    cleanRemainingTokens,
    rawInput,
  });
}

/**
 * Get slash command definitions for use in suggestions
 */
export function getSlashCommandDefinitions(): readonly SlashCommandDefinition[] {
  return Array.from(SLASH_COMMAND_DEFINITION_MAP.values());
}

/**
 * Parse a oneshot command key into model + thinking overrides.
 *
 * Supported forms:
 * - "haiku"        → model override only (existing behavior)
 * - "opus+2"       → model + numeric thinking level (0=off, 1=low, 2=medium, 3=high, 4=max)
 * - "haiku+medium" → model + named thinking level
 * - "+0"           → thinking-only override (use current model)
 * - "+high"        → thinking-only override with named level
 *
 * Returns null if the key doesn't match any valid oneshot pattern.
 */
function parseOneshotCommandKey(
  key: string
): { modelString?: string; thinkingLevel?: ParsedThinkingInput } | null {
  const plusIndex = key.indexOf("+");

  if (plusIndex === -1) {
    // No "+": plain model alias (e.g., "haiku")
    if (!Object.hasOwn(MODEL_ABBREVIATIONS, key)) return null;
    const normalized = normalizeModelInput(key);
    return { modelString: normalized.model ?? MODEL_ABBREVIATIONS[key] };
  }

  // Has "+": parse model (optional) and thinking level
  const modelPart = key.substring(0, plusIndex); // "" for "+0"
  const thinkingPart = key.substring(plusIndex + 1); // "2", "medium", etc.

  // Thinking part is required when "+" is present
  if (!thinkingPart) return null;

  const thinkingLevel = parseThinkingInput(thinkingPart);
  if (thinkingLevel == null) return null;

  // Thinking-only override (e.g., "+0", "+high")
  if (!modelPart) {
    return { thinkingLevel };
  }

  // Model + thinking override (e.g., "opus+2", "haiku+medium")
  if (!Object.hasOwn(MODEL_ABBREVIATIONS, modelPart)) return null;
  const normalized = normalizeModelInput(modelPart);
  return {
    modelString: normalized.model ?? MODEL_ABBREVIATIONS[modelPart],
    thinkingLevel,
  };
}
