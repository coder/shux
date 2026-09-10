import { tool } from "ai";

import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { MCPPromptGetToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";

// Same disclosure budget as the skills index in agent_skill_read.
const MAX_PROMPTS = 50;
// Prompt/argument descriptions are server-controlled; clamp them so one
// hostile or verbose server cannot inflate every request's tool schema.
const MAX_PROMPT_DESCRIPTION_CHARS = 200;
const MAX_ARGUMENT_DESCRIPTION_CHARS = 100;
const MAX_ARGUMENT_HINT_CHARS = 300;
const MAX_INDEX_CHARS = 10_000;
// Names-only tail: keys past the full-entry budget stay discoverable and
// invocable (the missing-required-argument error recovers argument names).
const MAX_NAME_TAIL_CHARS = 2_000;
// Unknown-name errors provide discovery beyond the description budget;
// substring filtering keeps oversized catalogs searchable.
const MAX_ERROR_KEYS_CHARS = 20_000;
const MAX_ERROR_TEXT_CHARS = 2_000;
// Server names are unbounded map keys; clamp before interpolation so one name
// cannot consume the index budget or copy megabytes per send.
const MAX_SERVER_NAME_CHARS = 100;

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

interface PromptLookup {
  byCommandKey: Map<string, MCPPromptDescriptor>;
  byStableKey: Map<string, MCPPromptDescriptor>;
}

// The manager memoizes descriptor arrays per catalog snapshot, so keying on
// the array reference builds each lookup once per refresh instead of scanning
// the whole catalog on every valid invocation.
const promptLookups = new WeakMap<MCPPromptDescriptor[], PromptLookup>();

function promptLookupFor(prompts: MCPPromptDescriptor[]): PromptLookup {
  let lookup = promptLookups.get(prompts);
  if (!lookup) {
    const byCommandKey = new Map<string, MCPPromptDescriptor>();
    const byStableKey = new Map<string, MCPPromptDescriptor>();
    // Keep the first descriptor for each duplicate key to match composer
    // catalog-order resolution.
    for (const descriptor of prompts) {
      const commandKey = descriptor.commandKey;
      if (!byCommandKey.has(commandKey)) {
        byCommandKey.set(commandKey, descriptor);
      }
      const stableKey = descriptor.stableKey;
      if (!byStableKey.has(stableKey)) {
        byStableKey.set(stableKey, descriptor);
      }
    }
    lookup = { byCommandKey, byStableKey };
    promptLookups.set(prompts, lookup);
  }
  return lookup;
}

function formatArgumentHint(descriptor: MCPPromptDescriptor): string {
  const args = descriptor.arguments ?? [];
  if (args.length === 0) {
    return "";
  }
  // Stop at the hint budget as defense in depth against unexpectedly large
  // descriptor arrays (production arrays arrive bounded by normalization).
  const parts: string[] = [];
  let chars = 0;
  for (const argument of args) {
    const marker = argument.required === true ? "" : "?";
    const part =
      argument.description == null
        ? `${argument.name}${marker}`
        : `${argument.name}${marker}: ${clampText(argument.description, MAX_ARGUMENT_DESCRIPTION_CHARS)}`;
    parts.push(part);
    chars += part.length + 2;
    if (chars > MAX_ARGUMENT_HINT_CHARS) {
      break;
    }
  }
  return clampText(` (args: ${parts.join("; ")})`, MAX_ARGUMENT_HINT_CHARS);
}

/**
 * Build dynamic mcp_prompt_get tool description with the available prompts.
 * Injects the prompt index directly into the tool description so the model
 * discovers prompts adjacent to the tool call schema (same mechanic as
 * agent_skill_read's skill index).
 */
function buildMcpPromptGetDescription(prompts: MCPPromptDescriptor[]): string {
  const baseDescription = TOOL_DEFINITIONS.mcp_prompt_get.description;
  if (prompts.length === 0) {
    return baseDescription;
  }

  const promptLines: string[] = [];
  let indexChars = 0;
  // Stop each phase at its first budget miss so the send path never scans the
  // undisclosed catalog tail; the omitted remainder is derived from
  // prompts.length. A key is never cut mid-name: a partial key is not
  // invocable.
  let indexBudgetExhausted = false;
  const tailShown: string[] = [];
  let tailChars = 0;
  let tailOmitted = 0;
  for (const descriptor of prompts) {
    if (promptLines.length < MAX_PROMPTS && !indexBudgetExhausted) {
      const description = clampText(
        descriptor.description ?? "MCP prompt",
        MAX_PROMPT_DESCRIPTION_CHARS
      );
      const line = `- ${descriptor.commandKey}${formatArgumentHint(descriptor)}: ${description} (server: ${clampText(descriptor.serverName, MAX_SERVER_NAME_CHARS)})`;
      if (indexChars + line.length <= MAX_INDEX_CHARS) {
        promptLines.push(line);
        indexChars += line.length;
        continue;
      }
      indexBudgetExhausted = true;
    }
    const key = descriptor.commandKey;
    if (tailChars + key.length + 2 > MAX_NAME_TAIL_CHARS) {
      tailOmitted = prompts.length - promptLines.length - tailShown.length;
      break;
    }
    tailShown.push(key);
    tailChars += key.length + 2;
  }

  if (tailShown.length > 0) {
    promptLines.push(`(more prompts, names only: ${tailShown.join(", ")})`);
  }
  if (tailOmitted > 0) {
    promptLines.push(
      `(+${tailOmitted} more not shown; call this tool with a full or partial name to search all prompt keys)`
    );
  }

  return `${baseDescription}\n\nAvailable MCP prompts:\n${promptLines.join("\n")}`;
}

/**
 * MCP prompt get tool factory. Resolves a prompt by its command key against
 * the stream's descriptor snapshot and fetches the flattened prompt text
 * through MCPServerManager.
 */
export const createMcpPromptGetTool: ToolFactory = (config: ToolConfiguration) => {
  const runtime = config.mcpPromptRuntime;
  const prompts = runtime?.prompts ?? [];

  return tool({
    description: buildMcpPromptGetDescription(prompts),
    inputSchema: TOOL_DEFINITIONS.mcp_prompt_get.schema,
    execute: async (
      { name, arguments: args, list_offset: listOffset },
      { abortSignal }
    ): Promise<MCPPromptGetToolResult> => {
      if (!runtime) {
        return { success: false, error: "Tool misconfigured: no MCP prompt runtime." };
      }

      // Exact commandKey takes precedence so a stableKey alias cannot shadow
      // a prompt's current key, matching composer resolution.
      const lookup = promptLookupFor(prompts);
      const descriptor = lookup.byCommandKey.get(name) ?? lookup.byStableKey.get(name);
      // Model-provided, so clamp its echo in error text.
      const shownName = clampText(name, MAX_ERROR_TEXT_CHARS);
      if (!descriptor) {
        // Unknown-name searches scan once, retaining only keys within the
        // error budget. list_offset pages past earlier keys so all stay
        // reachable when substring narrowing cannot distinguish them.
        const needle = name.toLowerCase();
        const offset = listOffset ?? 0;
        const matched: string[] = [];
        let matchedChars = 0;
        let matchedFull = false;
        let matchedCount = 0;
        let matchedSkipped = 0;
        const all: string[] = [];
        let allChars = 0;
        let allFull = false;
        let allSkipped = 0;
        for (const candidate of prompts) {
          const key = candidate.commandKey;
          if (allSkipped < offset) {
            allSkipped++;
          } else if (!allFull && allChars + key.length + 2 <= MAX_ERROR_KEYS_CHARS) {
            all.push(key);
            allChars += key.length + 2;
          } else {
            allFull = true;
          }
          if (key.toLowerCase().includes(needle)) {
            matchedCount++;
            if (matchedSkipped < offset) {
              matchedSkipped++;
            } else if (!matchedFull && matchedChars + key.length + 2 <= MAX_ERROR_KEYS_CHARS) {
              matched.push(key);
              matchedChars += key.length + 2;
            } else {
              matchedFull = true;
            }
          }
        }
        const useMatches = matchedCount > 0;
        const label = useMatches ? `Prompts matching '${shownName}'` : "Available prompts";
        const shown = useMatches ? matched : all;
        const skipped = useMatches ? matchedSkipped : allSkipped;
        const omitted = useMatches
          ? matchedCount - matchedSkipped - matched.length
          : prompts.length - allSkipped - all.length;
        return {
          success: false,
          error: `Unknown MCP prompt '${shownName}'. ${label}${
            skipped > 0 ? ` (after skipping ${skipped})` : ""
          }: ${shown.join(", ")}${
            omitted > 0
              ? ` (+${omitted} more; use a longer partial name to narrow, or repeat with list_offset=${skipped + shown.length} to continue)`
              : ""
          }`,
        };
      }

      const argumentValues = args ?? {};
      // Single pass over the server-controlled arguments array, accumulating
      // only names that fit the error budget; the rest are just counted.
      const missingNames: string[] = [];
      let missingChars = 0;
      let missingOmitted = 0;
      for (const argument of descriptor.arguments ?? []) {
        if (argument.required !== true) {
          continue;
        }
        // Own-property check: an argument named after an inherited
        // Object.prototype member (constructor, toString, __proto__) must not
        // count as provided via prototype lookup.
        if (Object.hasOwn(argumentValues, argument.name) && argumentValues[argument.name] != null) {
          continue;
        }
        if (missingChars + argument.name.length + 2 <= MAX_ERROR_TEXT_CHARS) {
          missingNames.push(argument.name);
          missingChars += argument.name.length + 2;
        } else {
          missingOmitted++;
        }
      }
      if (missingNames.length > 0 || missingOmitted > 0) {
        return {
          success: false,
          error: `Missing required argument(s) for '${descriptor.commandKey}': ${missingNames.join(", ")}${
            missingOmitted > 0 ? ` (+${missingOmitted} more)` : ""
          }`,
        };
      }

      try {
        const result = await runtime.getPrompt(
          descriptor.serverName,
          descriptor.promptName,
          argumentValues,
          abortSignal !== undefined ? { signal: abortSignal } : undefined
        );
        return {
          success: true,
          // MCPServerManager caps text for both tool and composer callers.
          text: result.text,
          ...(result.description !== undefined
            ? { description: clampText(result.description, MAX_PROMPT_DESCRIPTION_CHARS) }
            : {}),
        };
      } catch (error) {
        return { success: false, error: clampText(getErrorMessage(error), MAX_ERROR_TEXT_CHARS) };
      }
    },
  });
};
