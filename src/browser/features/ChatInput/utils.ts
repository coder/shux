import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand, tokenizeSlashCommandArguments } from "@/browser/utils/slashCommands/parser";
import type { APIClient } from "@/browser/contexts/API";
import {
  extractInlineSkillReferenceCandidates,
  resolveInlineSkillReferences,
  type InlineSkillCandidate,
} from "@/browser/utils/agentSkills/inlineSkillReferences";
import { resolveSkillUserInvocable } from "@/common/orpc/schemas/agentSkill";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import {
  buildMcpPromptBaseKey,
  isMcpPromptCommandKey,
} from "@/common/utils/tools/mcpPromptCommandKey";
import type { ParsedRuntime } from "@/common/types/runtime";
import type { ParsedThinkingInput } from "@/common/types/thinking";
import {
  buildAgentSkillMetadata,
  dedupeAgentSkillRefs,
  buildMcpPromptUserText,
  buildSkillInvocationUserText,
  dedupeMcpPromptRefs,
  type AgentSkillReference,
  type MCPPromptReference,
  type MuxMessageMetadata,
} from "@/common/types/message";
import type { FilePart } from "@/common/orpc/types";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";

export type CreationRuntimeValidationError =
  | { mode: "docker"; kind: "missingImage" }
  | { mode: "ssh"; kind: "missingHost" }
  | { mode: "ssh"; kind: "missingCoderWorkspace" }
  | { mode: "ssh"; kind: "missingCoderTemplate" }
  | { mode: "ssh"; kind: "missingCoderPreset" };

export interface SkillInvocation {
  descriptor: AgentSkillDescriptor;
  userText: string;
  /** Trimmed text after the slash command (e.g. "123 high" for "/fix-issue 123 high"). */
  argumentText: string;
  /**
   * One-shot model/thinking override composed with the invocation
   * ("/haiku+0 /done args"). Applies to this send only; carrying
   * skipAiSettingsPersistence also bypasses backend per-skill class routing
   * (an explicit override wins over the skill's model class).
   */
  oneShot?: {
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
  };
}

export interface MCPPromptInvocation {
  descriptor: MCPPromptDescriptor;
  userText: string;
  arguments: Record<string, string>;
}

function mapPromptArguments(
  descriptor: MCPPromptDescriptor,
  input: string
): { arguments: Record<string, string>; missingRequired?: string } {
  const definitions = descriptor.arguments ?? [];
  const tokens = tokenizeSlashCommandArguments(input);
  const values: Record<string, string> = {};
  let tokenIndex = 0;
  for (const [index, definition] of definitions.entries()) {
    // Skip an optional slot when the remaining tokens are needed by later
    // required arguments, so `[optional, required]` maps one token to the
    // required argument instead of reporting it missing.
    const requiredAfter = definitions.slice(index + 1).filter((d) => d.required).length;
    if (!definition.required && tokens.length - tokenIndex <= requiredAfter) {
      continue;
    }
    const value =
      index === definitions.length - 1
        ? tokens.slice(tokenIndex).join(" ")
        : (tokens[tokenIndex] ?? "");
    if (!value) {
      if (definition.required) return { arguments: values, missingRequired: definition.name };
      continue;
    }
    values[definition.name] = value;
    tokenIndex++;
  }
  return { arguments: values };
}

export type SkillResolutionTarget =
  | { kind: "project"; projectPath: string }
  | { kind: "workspace"; workspaceId: string; disableWorkspaceAgents?: boolean };

type UnknownSlashCommand = Extract<ParsedCommand, { type: "unknown-command" }>;

function isUnknownSlashCommand(value: ParsedCommand): value is UnknownSlashCommand {
  return value !== null && value.type === "unknown-command";
}

export function buildSkillInvocationMetadata(
  rawCommand: string,
  descriptor: AgentSkillDescriptor,
  argumentText: string,
  /**
   * Overrides the default `/${name}` prefix for composed one-shot invocations
   * ("/haiku+0 /done"): the transcript badge only renders when rawCommand
   * starts with commandPrefix, so the prefix must include the one-shot token.
   */
  commandPrefixOverride?: string
): MuxMessageMetadata {
  return buildAgentSkillMetadata({
    rawCommand,
    commandPrefix: commandPrefixOverride ?? `/${descriptor.name}`,
    skillName: descriptor.name,
    scope: descriptor.scope,
    arguments: argumentText,
  });
}

// parseCommand() trims before matching, so pasted or draft-restored text with
// leading whitespace must be sliced from the same trimmed view or the command
// falls through as literal text.
function textAfterCommandPrefix(messageText: string, command: string): string {
  return messageText.trimStart().slice(`/${command}`.length);
}

// Exact commandKey wins across the whole catalog; stableKey only recovers
// drafts whose collision-suffixed key changed, so an alias must never shadow
// another prompt's current commandKey.
function findPromptDescriptor(
  descriptors: MCPPromptDescriptor[],
  command: string,
  isEligible: (descriptor: MCPPromptDescriptor) => boolean = () => true
): MCPPromptDescriptor | undefined {
  return (
    descriptors.find((descriptor) => descriptor.commandKey === command && isEligible(descriptor)) ??
    descriptors.find((descriptor) => descriptor.stableKey === command && isEligible(descriptor))
  );
}

async function loadMcpPromptDescriptors(options: {
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  commandKeys: string[];
  signal?: AbortSignal;
}): Promise<MCPPromptDescriptor[] | null> {
  const hasAllDescriptors = options.commandKeys.every(
    (commandKey) => findPromptDescriptor(options.descriptors, commandKey) !== undefined
  );
  if (hasAllDescriptors || !options.api || options.discovery?.kind !== "workspace") {
    return options.descriptors;
  }

  try {
    return await options.api.workspace.mcp.prompts.list(
      { workspaceId: options.discovery.workspaceId },
      options.signal !== undefined ? { signal: options.signal } : undefined
    );
  } catch {
    return null;
  }
}

async function resolveMcpPromptInvocation(options: {
  messageText: string;
  parsed: ParsedCommand;
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  signal?: AbortSignal;
}): Promise<{ invocation: MCPPromptInvocation | null; error?: string }> {
  if (!isUnknownSlashCommand(options.parsed) || !isMcpPromptCommandKey(options.parsed.command)) {
    return { invocation: null };
  }

  const command = options.parsed.command;
  const afterPrefix = textAfterCommandPrefix(options.messageText, command);
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) return { invocation: null };

  const descriptors = await loadMcpPromptDescriptors({
    descriptors: options.descriptors,
    api: options.api,
    discovery: options.discovery,
    commandKeys: [command],
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const descriptor = descriptors ? findPromptDescriptor(descriptors, command) : undefined;
  if (!descriptor) {
    // A new collision can orphan an unsuffixed key from an old draft. Block the
    // send and offer current keys rather than treating it as plain text.
    const baseMatches = (descriptors ?? []).filter(
      (candidate) => buildMcpPromptBaseKey(candidate.serverName, candidate.promptName) === command
    );
    if (baseMatches.length > 0) {
      const candidates = baseMatches.map((candidate) => `/${candidate.commandKey}`).join(" or ");
      return {
        invocation: null,
        error: `'/${command}' no longer matches an MCP prompt key; did you mean ${candidates}?`,
      };
    }
    // The mcp__ prefix is reserved, so an unresolvable command must block the
    // send instead of falling through as literal text.
    return {
      invocation: null,
      error:
        descriptors === null
          ? `Could not load MCP prompts to resolve '/${command}'; check the MCP server connection and try again.`
          : `'/${command}' does not match any available MCP prompt.`,
    };
  }

  const mapped = mapPromptArguments(descriptor, afterPrefix.trim());
  if (mapped.missingRequired) {
    return {
      invocation: null,
      error: `Missing required MCP prompt argument: ${mapped.missingRequired}`,
    };
  }
  const argumentText = afterPrefix.trimStart();
  return {
    invocation: {
      descriptor,
      userText: buildMcpPromptUserText(descriptor.serverName, descriptor.promptName, argumentText),
      arguments: mapped.arguments,
    },
  };
}

async function resolveSkillInvocation(options: {
  messageText: string;
  parsed: ParsedCommand;
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}): Promise<SkillInvocation | null> {
  if (!isUnknownSlashCommand(options.parsed)) {
    return null;
  }

  const command = options.parsed.command;
  const afterPrefix = textAfterCommandPrefix(options.messageText, command);
  const hasSeparator = afterPrefix.length === 0 || /^\s/.test(afterPrefix);

  if (!hasSeparator) {
    return null;
  }

  // user-invocable: false skills must be treated as nonexistent for typed /skill-name
  // invocation (they remain model-invocable via agent_skill_read).
  let skill: AgentSkillDescriptor | undefined = options.agentSkillDescriptors.find(
    (candidate) => candidate.name === command && candidate.userInvocable !== false
  );

  if (!skill && options.api && options.discovery) {
    try {
      const pkg =
        options.discovery.kind === "project"
          ? await options.api.agentSkills.get({
              projectPath: options.discovery.projectPath,
              skillName: command,
            })
          : await options.api.agentSkills.get({
              workspaceId: options.discovery.workspaceId,
              disableWorkspaceAgents: options.discovery.disableWorkspaceAgents,
              skillName: command,
            });
      // The remote fallback fetches raw frontmatter, so apply the same user-invocability
      // gate the local descriptor list already carries in normalized form.
      if (resolveSkillUserInvocable(pkg.frontmatter) !== false) {
        skill = {
          name: pkg.frontmatter.name,
          description: pkg.frontmatter.description,
          scope: pkg.scope,
        };
      }
    } catch {
      // Not a skill (or not available yet) - fall through.
    }
  }

  if (!skill) {
    return null;
  }

  return {
    descriptor: skill,
    userText: buildSkillInvocationUserText(skill.name, afterPrefix.trimStart()),
    argumentText: afterPrefix.trim(),
  };
}

export async function parseCommandWithSkillInvocation(options: {
  messageText: string;
  agentSkillDescriptors: AgentSkillDescriptor[];
  mcpPromptDescriptors?: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  signal?: AbortSignal;
  /** Allow "/model+thinking /skill args" composition (workspace sends only). */
  composeOneShot?: boolean;
}): Promise<{
  parsed: ParsedCommand;
  skillInvocation: SkillInvocation | null;
  mcpPromptInvocation: MCPPromptInvocation | null;
  error?: string;
}> {
  const parsed = parseCommand(options.messageText);
  const promptResolution = await resolveMcpPromptInvocation({
    messageText: options.messageText,
    parsed,
    descriptors: options.mcpPromptDescriptors ?? [],
    api: options.api,
    discovery: options.discovery,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (promptResolution.invocation || promptResolution.error) {
    return {
      parsed: promptResolution.invocation ? null : parsed,
      skillInvocation: null,
      mcpPromptInvocation: promptResolution.invocation,
      ...(promptResolution.error ? { error: promptResolution.error } : {}),
    };
  }

  let skillInvocation = await resolveSkillInvocation({
    messageText: options.messageText,
    parsed,
    agentSkillDescriptors: options.agentSkillDescriptors,
    api: options.api,
    discovery: options.discovery,
  });

  // Compose one-shot model overrides with skill invocations: "/haiku+0 /done args"
  // runs the done skill on Haiku for this send only. Re-running parseCommand on the
  // one-shot's message keeps registered commands ("/haiku+0 /compact") and nested
  // one-shots out of skill resolution — only unknown-command remainders are
  // candidate skills, exactly like a bare "/done args".
  if (
    options.composeOneShot === true &&
    skillInvocation == null &&
    parsed?.type === "model-oneshot"
  ) {
    const innerParsed = parseCommand(parsed.message);
    const innerInvocation = await resolveSkillInvocation({
      messageText: parsed.message,
      parsed: innerParsed,
      agentSkillDescriptors: options.agentSkillDescriptors,
      api: options.api,
      discovery: options.discovery,
    });
    if (innerInvocation != null) {
      skillInvocation = {
        ...innerInvocation,
        oneShot: {
          ...(parsed.modelString != null ? { modelString: parsed.modelString } : {}),
          ...(parsed.thinkingLevel != null ? { thinkingLevel: parsed.thinkingLevel } : {}),
        },
      };
    }
  }

  return {
    parsed: skillInvocation == null ? parsed : null,
    skillInvocation,
    mcpPromptInvocation: null,
  };
}

/**
 * Resolve inline `$skill` references found in the user's authored message text.
 *
 * - Parses `$skill` candidates from the original user text (not the slash-rewritten userText),
 *   so a mixed `/deep-review Please also follow $tdd` finds both refs.
 * - When `slashInvocation` is provided, its skill is included as a `source: "slash"` ref;
 *   it remains first in the returned list and wins on dedupe (same name → drop inline duplicate).
 * - Inline refs that don't resolve are silently dropped.
 * - Output is deduped (first-appearance wins; slash beats inline). Empty array when there are none.
 */
export async function resolveInlineSkillRefsForSend(options: {
  messageText: string;
  slashInvocation: SkillInvocation | null;
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  candidates?: InlineSkillCandidate[];
}): Promise<AgentSkillReference[]> {
  const refs: AgentSkillReference[] = [];

  if (options.slashInvocation) {
    const descriptor = options.slashInvocation.descriptor;
    refs.push({ skillName: descriptor.name, scope: descriptor.scope, source: "slash" });
  }

  const candidates = (
    options.candidates ?? extractInlineSkillReferenceCandidates(options.messageText)
  ).filter((candidate) => !isMcpPromptCommandKey(candidate.skillName));
  if (candidates.length > 0) {
    const inlineRefs = await resolveInlineSkillReferences({
      candidates,
      agentSkillDescriptors: options.agentSkillDescriptors,
      api: options.api,
      discovery: options.discovery,
    });
    refs.push(...inlineRefs);
  }

  return dedupeAgentSkillRefs(refs);
}

export async function resolveMcpPromptRefsForSend(options: {
  messageText: string;
  slashInvocation: MCPPromptInvocation | null;
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  candidates?: InlineSkillCandidate[];
  signal?: AbortSignal;
}): Promise<{ refs: MCPPromptReference[]; error?: string }> {
  const refs: MCPPromptReference[] = [];
  if (options.slashInvocation) {
    const invocation = options.slashInvocation;
    refs.push({
      serverName: invocation.descriptor.serverName,
      promptName: invocation.descriptor.promptName,
      commandKey: invocation.descriptor.commandKey,
      source: "slash",
      arguments: invocation.arguments,
    });
  }

  const candidates = (
    options.candidates ?? extractInlineSkillReferenceCandidates(options.messageText)
  ).filter((candidate) => isMcpPromptCommandKey(candidate.skillName));
  if (candidates.length === 0) return { refs };

  const descriptors = await loadMcpPromptDescriptors({
    descriptors: options.descriptors,
    api: options.api,
    discovery: options.discovery,
    commandKeys: candidates.map((candidate) => candidate.skillName),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!descriptors) return { refs };

  const isInlineInvocable = (descriptor: MCPPromptDescriptor) =>
    !(descriptor.arguments ?? []).some((argument) => argument.required);
  for (const candidate of candidates) {
    const prompt = findPromptDescriptor(descriptors, candidate.skillName, isInlineInvocable);
    if (!prompt) {
      // Same orphaned-key ambiguity as the slash path: a new collision
      // suffixed the keys, so block the send instead of dropping the ref.
      const baseMatches = descriptors.filter(
        (descriptor) =>
          buildMcpPromptBaseKey(descriptor.serverName, descriptor.promptName) ===
            candidate.skillName && isInlineInvocable(descriptor)
      );
      if (baseMatches.length > 0) {
        const suggestions = baseMatches
          .map((descriptor) => `$${descriptor.commandKey}`)
          .join(" or ");
        return {
          refs: [],
          error: `'$${candidate.skillName}' no longer matches an MCP prompt key; did you mean ${suggestions}?`,
        };
      }
      continue;
    }
    refs.push({
      serverName: prompt.serverName,
      promptName: prompt.promptName,
      commandKey: prompt.commandKey,
      source: "inline",
    });
  }
  return { refs: dedupeMcpPromptRefs(refs) };
}

/** Returns true when any ref's scope is "project" (used by creation flow to force disableWorkspaceAgents). */
export function hasProjectScopedSkillRef(refs: AgentSkillReference[]): boolean {
  return refs.some((ref) => ref.scope === "project");
}

export function validateCreationRuntime(
  runtime: ParsedRuntime,
  coderPresetCount: number
): CreationRuntimeValidationError | null {
  if (runtime.mode === "docker") {
    return runtime.image.trim() ? null : { mode: "docker", kind: "missingImage" };
  }

  if (runtime.mode === "ssh") {
    if (runtime.coder) {
      if (runtime.coder.existingWorkspace) {
        // Existing mode: workspace name is required
        if (!(runtime.coder.workspaceName ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderWorkspace" };
        }
      } else {
        // New mode: template is required
        if (!(runtime.coder.template ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderTemplate" };
        }
        // Preset required when 2+ presets exist
        const requiresPreset = coderPresetCount >= 2;
        if (requiresPreset && !(runtime.coder.preset ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderPreset" };
        }
      }
      return null;
    }

    return runtime.host.trim() ? null : { mode: "ssh", kind: "missingHost" };
  }

  return null;
}

export function filePartsToChatAttachments(
  fileParts: FilePart[],
  idPrefix: string
): ChatAttachment[] {
  return fileParts.map((part, index) => ({
    kind: "provider",
    id: `${idPrefix}-${index}`,
    url: part.url,
    mediaType: part.mediaType,
    filename: part.filename,
  }));
}
