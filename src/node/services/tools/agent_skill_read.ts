import { tool } from "ai";

import type { AgentSkillReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { getErrorMessage } from "@/common/utils/errors";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";

/**
 * Build dynamic agent_skill_read tool description with available skills.
 * Injects the list of available skills directly into the tool description
 * so the model sees them adjacent to the tool call schema.
 */
function buildSkillReadDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.agent_skill_read.description;
  // Filter out unadvertised skills (advertise: false or disable-model-invocation: true,
  // normalized into descriptor.advertise) from the tool description.
  // Unadvertised skills can still be invoked via /skill-name or agent_skill_read.
  const skills = (config.availableSkills ?? []).filter((s) => s.advertise !== false);

  if (skills.length === 0) {
    return baseDescription;
  }

  const MAX_SKILLS = 50;
  const shown = skills.slice(0, MAX_SKILLS);
  const omitted = skills.length - shown.length;

  const skillLines = shown.map((skill) => {
    const line = `- ${skill.name}: ${skill.description} (scope: ${skill.scope})`;
    // whenToUse (when_to_use/when-to-use frontmatter) is extra model-facing guidance;
    // keep it on the same index line to stay token-lean.
    return skill.whenToUse == null ? line : `${line} When to use: ${skill.whenToUse}`;
  });
  if (omitted > 0) {
    skillLines.push(`(+${omitted} more not shown)`);
  }

  const usageHint = `\nTo read referenced files inside a skill directory:\n- agent_skill_read_file({ name: "<skill-name>", filePath: "references/whatever.txt" })`;

  return `${baseDescription}\n\nAvailable skills:\n${skillLines.join("\n")}${usageHint}`;
}

/**
 * Agent Skill read tool factory.
 * Reads and validates a skill's SKILL.md from project-local or global skills roots.
 */
export const createAgentSkillReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: buildSkillReadDescription(config),
    inputSchema: TOOL_DEFINITIONS.agent_skill_read.schema,
    execute: async ({ name }): Promise<AgentSkillReadToolResult> => {
      const workspacePath = config.cwd;
      if (!workspacePath) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // Defensive: validate again even though inputSchema should guarantee shape.
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        // claude-skills-compat experiment: allow reading skills discovered from .claude roots.
        const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
        // agent-plugins experiment: allow reading skills discovered from Agent Plugins.
        const includeAgentPlugins = config.experiments?.agentPlugins === true;
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath,
          xumScope: config.xumScope ?? null,
          includeClaudeSkills,
          includeAgentPlugins,
        });
        const resolved = await readAgentSkill(
          skillCtx.runtime,
          skillCtx.workspacePath,
          parsedName.data,
          {
            roots: skillCtx.roots,
            containment: skillCtx.containment,
            includeClaudeSkills,
            includeAgentPlugins,
          }
        );
        return {
          success: true,
          skill: resolved.package,
        };
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
