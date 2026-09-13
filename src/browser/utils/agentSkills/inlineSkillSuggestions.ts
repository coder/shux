import { filterAndRankByNameMatch } from "@/browser/utils/suggestionMatching";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";

interface InlineSkillSuggestionContext {
  /** The token typed after `$`. Empty string is allowed (just typed `$`). */
  partial: string;
  /** Already-loaded descriptors for current discovery target. */
  descriptors: AgentSkillDescriptor[];
  mcpPrompts?: MCPPromptDescriptor[];
}

interface InlineSkillSuggestionRefreshContext {
  inputChanged: boolean;
  previousPartial: string | null;
  partial: string;
  previousDescriptors: AgentSkillDescriptor[] | null;
  descriptors: AgentSkillDescriptor[];
  previousMcpPrompts?: MCPPromptDescriptor[] | null;
  mcpPrompts?: MCPPromptDescriptor[];
}

const INLINE_SKILL_INSERT_EXISTING_SEPARATOR_RE = /[\s.,;:!?)\]}>"'`]/;

export function shouldRefreshInlineSkillSuggestions(
  context: InlineSkillSuggestionRefreshContext
): boolean {
  return (
    context.inputChanged ||
    context.previousPartial !== context.partial ||
    context.previousDescriptors !== context.descriptors ||
    context.previousMcpPrompts !== context.mcpPrompts
  );
}

export function getInlineSkillInsertionTrailingText(after: string): "" | " " {
  // At end-of-input, add a space so the cursor is ready for continued typing.
  // Before whitespace, punctuation, or closers, skip the space to avoid doubling.
  if (after.length === 0) return " ";
  if (INLINE_SKILL_INSERT_EXISTING_SEPARATOR_RE.test(after[0] ?? "")) return "";
  return " ";
}

/** MCP prompts with required arguments are omitted because inline references cannot supply them. */
export function getInlineSkillSuggestions(
  context: InlineSkillSuggestionContext
): SlashSuggestion[] {
  const skills = filterAndRankByNameMatch(
    context.descriptors.filter((descriptor) => descriptor.userInvocable !== false),
    context.partial,
    (descriptor) => descriptor.name
  ).map((descriptor) => ({
    id: `inline-skill:${descriptor.name}`,
    display: `$${descriptor.name}`,
    description: descriptor.description ?? "",
    replacement: `$${descriptor.name}`,
  }));
  const prompts = filterAndRankByNameMatch(
    (context.mcpPrompts ?? []).filter(
      (prompt) => !(prompt.arguments ?? []).some((argument) => argument.required)
    ),
    context.partial,
    (prompt) => prompt.commandKey
  ).map((prompt) => ({
    id: `inline-mcp-prompt:${prompt.commandKey}`,
    display: `$${prompt.commandKey}`,
    description: prompt.description ?? `MCP prompt from ${prompt.serverName}`,
    replacement: `$${prompt.commandKey}`,
  }));
  return [...skills, ...prompts];
}
