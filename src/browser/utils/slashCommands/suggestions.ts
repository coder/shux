/**
 * Slash command suggestions generation
 */

import { filterAndRankByNameMatch } from "@/browser/utils/suggestionMatching";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getSlashCommandDefinitions } from "./parser";
import { isSlashCommandVisible, SLASH_COMMAND_DEFINITION_MAP } from "./registry";
import type {
  SlashCommandDefinition,
  SlashSuggestion,
  SlashSuggestionContext,
  SuggestionDefinition,
} from "./types";

const COMMAND_DEFINITIONS = getSlashCommandDefinitions();

function filterAndMapSuggestions<T extends SuggestionDefinition>(
  definitions: readonly T[],
  partial: string,
  build: (definition: T) => SlashSuggestion,
  filter?: (definition: T) => boolean
): SlashSuggestion[] {
  const candidates = filter ? definitions.filter(filter) : [...definitions];
  return filterAndRankByNameMatch(candidates, partial, (definition) => definition.key).map(
    (definition) => build(definition)
  );
}

function buildTopLevelSuggestions(
  partial: string,
  context: SlashSuggestionContext
): SlashSuggestion[] {
  const commandSuggestions = filterAndMapSuggestions(
    COMMAND_DEFINITIONS,
    partial,
    (definition) => {
      const appendSpace = definition.appendSpace ?? true;
      const replacement = `/${definition.key}${appendSpace ? " " : ""}`;
      return {
        id: `command:${definition.key}`,
        display: `/${definition.key}`,
        description: definition.description,
        replacement,
      };
    },
    (definition) => isSlashCommandVisible(definition, context)
  );

  const formatScopeLabel = (scope: string): string => {
    if (scope === "global") {
      return "user";
    }
    return scope;
  };

  // The skill build callback below hardcodes the trailing space, so we omit
  // `appendSpace` here — leaving it set would be a no-op and falsely suggest
  // the build path consults it.
  // user-invocable: false skills are hidden from user-facing invocation surfaces
  // (this covers both the chat slash menu and the command palette skill list).
  const skillDefinitions: Array<SuggestionDefinition & { argumentHint?: string }> = (
    context.agentSkills ?? []
  )
    .filter((skill) => skill.userInvocable !== false)
    .filter((skill) => !SLASH_COMMAND_DEFINITION_MAP.has(skill.name))
    .map((skill) => ({
      key: skill.name,
      description: `${skill.description} (${formatScopeLabel(skill.scope)})`,
      argumentHint: skill.argumentHint,
    }));

  const skillSuggestions = filterAndMapSuggestions(skillDefinitions, partial, (definition) => {
    const replacement = `/${definition.key} `;
    return {
      id: `skill:${definition.key}`,
      // Skills with an argument-hint show it next to the name (e.g.
      // "/fix-issue [issue-number]") so users learn the expected arguments in
      // the invocation UI itself; matching/replacement still use only the name.
      display:
        definition.argumentHint === undefined
          ? `/${definition.key}`
          : `/${definition.key} ${definition.argumentHint}`,
      description: definition.description,
      kind: "skill",
      replacement,
    };
  });

  // Agent Plugins: manifest-contributed commands are pure data-driven entries
  // whose replacement IS the expansion text (no parser/send-path involvement).
  // Built-in command keys and skill names take precedence on collision.
  const claimedSkillNames = new Set(skillDefinitions.map((definition) => definition.key));
  const pluginCommandSuggestions = filterAndRankByNameMatch(
    (context.pluginCommands ?? []).filter(
      (command) =>
        !SLASH_COMMAND_DEFINITION_MAP.has(command.name) && !claimedSkillNames.has(command.name)
    ),
    partial,
    (command) => command.name
  ).map((command) => ({
    id: `plugin-command:${command.name}`,
    display: `/${command.name}`,
    description: `${command.description ?? "Plugin command"} (plugin:${command.pluginName})`,
    replacement: command.expansion,
  }));

  const promptSuggestions = filterAndRankByNameMatch(
    context.mcpPrompts ?? [],
    partial,
    (prompt) => prompt.commandKey
  ).map((prompt) => {
    const argumentHint = (prompt.arguments ?? [])
      .map((argument) => `[${argument.name}${argument.required ? "" : "?"}]`)
      .join(" ");
    return {
      id: `mcp-prompt:${prompt.commandKey}`,
      display: `/${prompt.commandKey}${argumentHint ? ` ${argumentHint}` : ""}`,
      description: `${prompt.description ?? "MCP prompt"} (${prompt.serverName})`,
      replacement: `/${prompt.commandKey} `,
    };
  });

  // Model alias one-shot suggestions (e.g., /haiku, /sonnet, /opus+high).
  // The build callback below hardcodes the trailing space, so `appendSpace`
  // is intentionally omitted here.
  const modelAliasDefinitions: SuggestionDefinition[] = Object.entries(MODEL_ABBREVIATIONS).map(
    ([alias, modelId]) => ({
      key: alias,
      description: `Send with ${formatModelDisplayName(modelId.split(":")[1] ?? modelId)} (one message, +level for thinking)`,
    })
  );

  const modelAliasSuggestions = filterAndMapSuggestions(
    modelAliasDefinitions,
    partial,
    (definition) => ({
      id: `model-oneshot:${definition.key}`,
      display: `/${definition.key}`,
      description: definition.description,
      replacement: `/${definition.key} `,
    })
  );

  return [
    ...commandSuggestions,
    ...skillSuggestions,
    ...pluginCommandSuggestions,
    ...promptSuggestions,
    ...modelAliasSuggestions,
  ];
}

function buildSubcommandSuggestions(
  commandDefinition: SlashCommandDefinition,
  partial: string,
  prefixTokens: string[],
  context: SlashSuggestionContext
): SlashSuggestion[] {
  const subcommands = commandDefinition.children ?? [];

  return filterAndMapSuggestions(
    subcommands,
    partial,
    (definition) => {
      const appendSpace = definition.appendSpace ?? true;
      const replacementTokens = [...prefixTokens, definition.key];
      const replacementBase = `/${replacementTokens.join(" ")}`;
      return {
        id: `command:${replacementTokens.join(":")}`,
        display: definition.key,
        description: definition.description,
        replacement: `${replacementBase}${appendSpace ? " " : ""}`,
      };
    },
    (definition) => isSlashCommandVisible(definition, context)
  );
}

export function getSlashCommandSuggestions(
  input: string,
  context: SlashSuggestionContext = {}
): SlashSuggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const remainder = input.slice(1);
  if (remainder.startsWith(" ")) {
    return [];
  }

  const parts = remainder.split(/\s+/);
  const tokens = parts.filter((part) => part.length > 0);
  const hasTrailingSpace = remainder.endsWith(" ") || remainder.length === 0;
  const completedTokens = hasTrailingSpace ? tokens : tokens.slice(0, -1);
  const partialToken = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const stage = completedTokens.length;

  if (stage === 0) {
    return buildTopLevelSuggestions(partialToken, context);
  }

  const rootKey = completedTokens[0] ?? tokens[0];
  if (!rootKey) {
    return [];
  }

  const rootDefinition = SLASH_COMMAND_DEFINITION_MAP.get(rootKey);
  if (!rootDefinition) {
    return [];
  }

  if (!isSlashCommandVisible(rootDefinition, context)) {
    return [];
  }

  const definitionPath: SlashCommandDefinition[] = [rootDefinition];
  let lastDefinition = rootDefinition;

  for (let i = 1; i < completedTokens.length; i++) {
    const token = completedTokens[i];
    const nextDefinition = (lastDefinition.children ?? []).find((child) => child.key === token);

    if (!nextDefinition) {
      break;
    }
    if (!isSlashCommandVisible(nextDefinition, context)) {
      return [];
    }

    definitionPath.push(nextDefinition);
    lastDefinition = nextDefinition;
  }

  const matchedDefinitionCount = definitionPath.length;

  // Try custom suggestions handler from the last matched definition
  if (lastDefinition.suggestions) {
    const customSuggestions = lastDefinition.suggestions({
      stage,
      partialToken,
      definitionPath,
      completedTokens,
      context,
    });

    if (customSuggestions !== null) {
      return customSuggestions;
    }
  }

  // Fall back to subcommand suggestions if available
  if (stage <= matchedDefinitionCount) {
    const definitionForSuggestions = definitionPath[Math.max(0, stage - 1)];

    if (definitionForSuggestions && (definitionForSuggestions.children ?? []).length > 0) {
      const prefixTokens = completedTokens.slice(0, stage);
      return buildSubcommandSuggestions(
        definitionForSuggestions,
        partialToken,
        prefixTokens,
        context
      );
    }
  }

  return [];
}
