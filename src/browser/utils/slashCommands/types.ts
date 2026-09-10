/**
 * Shared types for slash command system
 *
 * NOTE: `/<command>-help` types are an anti-pattern. Commands should prefer opening
 * a modal when misused or called with no arguments, rather than showing help toasts.
 * This provides a better UX by guiding users through the UI instead of showing text.
 *
 * Existing `-help` types are kept for backward compatibility but should not be added
 * for new commands.
 */

import type { ExperimentId } from "@/common/constants/experiments";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { PluginSlashCommandDescriptor } from "@/common/orpc/schemas/agentPlugins";
import type { ParsedThinkingInput } from "@/common/types/thinking";

export type ParsedCommand =
  | { type: "model-set"; modelString: string }
  | {
      type: "model-oneshot";
      /** Resolved model string (e.g. "anthropic:claude-haiku-4"). Undefined when only thinking is overridden (e.g. "/+2"). */
      modelString?: string;
      /** One-shot thinking level override — named (ThinkingLevel) or numeric index (resolved at send time against the model's policy). */
      thinkingLevel?: ParsedThinkingInput;
      message: string;
    }
  | { type: "model-help" }
  | { type: "clear"; mode: "hard" | "soft" }
  | { type: "compact"; maxOutputTokens?: number; continueMessage?: string; model?: string }
  | { type: "dream" }
  | { type: "refine"; apply?: boolean }
  | { type: "fork"; startMessage?: string }
  | { type: "new"; startMessage?: string }
  | { type: "vim-toggle" }
  | { type: "plan-show" }
  | { type: "plan-open" }
  | { type: "workflow-run"; scriptPath: string; argsText?: string }
  | { type: "debug-llm-request" }
  | { type: "unknown-command"; command: string; subcommand?: string }
  | { type: "command-unknown-flag"; command: string; flag: string; usage?: string }
  | { type: "command-missing-args"; command: string; usage: string }
  | { type: "command-invalid-args"; command: string; input: string; usage: string }
  | { type: "idle-compaction"; hours: number | null }
  | { type: "heartbeat-set"; minutes: number | null }
  | { type: "goal-show" }
  | { type: "goal-set"; objective: string; budgetCents?: number | null; turnCap?: number | null }
  | { type: "goal-budget"; budgetCents: number | null }
  | { type: "goal-pause" }
  | { type: "goal-resume" }
  | { type: "goal-complete"; summary?: string }
  | { type: "goal-clear" }
  | null;

export interface SuggestionsHandlerArgs {
  stage: number;
  partialToken: string;
  definitionPath: readonly SlashCommandDefinition[];
  completedTokens: string[];
  context: SlashSuggestionContext;
}

export type SuggestionsHandler = (args: SuggestionsHandlerArgs) => SlashSuggestion[] | null;

export interface SlashCommandVisibilityContext {
  /** Variant determines which commands are available */
  variant?: "workspace" | "creation";
  /**
   * Optional resolver for experiment state. Tests and React callers can inject
   * hook-derived values instead of reading from localStorage directly.
   */
  isExperimentEnabled?: (experimentId: ExperimentId) => boolean | undefined;
}

export interface SlashCommandDefinition {
  key: string;
  description: string;
  inputHint?: string;
  appendSpace?: boolean;
  /** Required experiment for visibility in suggestions, palette results, and ghost hints. */
  experimentGate?: ExperimentId;
  handler?: SlashCommandHandler;
  children?: readonly SlashCommandDefinition[];
  suggestions?: SuggestionsHandler;
}

interface SlashCommandHandlerArgs {
  definition: SlashCommandDefinition;
  path: readonly SlashCommandDefinition[];
  remainingTokens: string[];
  cleanRemainingTokens: string[];
  rawInput: string; // Raw input after command name, preserving newlines
}

export type SlashCommandHandler = (input: SlashCommandHandlerArgs) => ParsedCommand;

export interface SlashSuggestion {
  id: string;
  display: string;
  description: string;
  kind?: "command" | "skill" | "model";
  replacement: string;
}

export interface SlashSuggestionContext extends SlashCommandVisibilityContext {
  agentSkills?: AgentSkillDescriptor[];
  mcpPrompts?: MCPPromptDescriptor[];
  /** Agent Plugins: manifest-contributed commands (name -> expansion). */
  pluginCommands?: PluginSlashCommandDescriptor[];
}

export interface SuggestionDefinition {
  key: string;
  description: string;
  appendSpace?: boolean;
}
