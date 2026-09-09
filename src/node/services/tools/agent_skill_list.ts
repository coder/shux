import * as fsPromises from "fs/promises";
import os from "node:os";
import * as path from "path";
import { tool } from "ai";

import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import {
  AgentSkillDescriptorSchema,
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { PLUGIN_REGISTRY_FILE_NAME } from "@/node/services/agentPlugins/registry";
import { discoverAgentPlugins } from "@/node/services/agentPlugins/discovery";
import {
  discoverAgentSkills,
  getDefaultAgentSkillsRoots,
  getProjectSkillRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { ensurePathContained, hasErrorCode } from "./skillFileUtils";

interface AgentSkillListToolArgs {
  includeUnadvertised?: boolean | null;
}

async function listSkillDirectories(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(skillsRoot, { withFileTypes: true });
    // Include symlinked entries: skill package managers install skills by
    // symlinking directories into skills roots. readSkillDescriptor enforces
    // realpath containment per skill, so escaping symlinks stay rejected.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    log.warn(
      `Skipping skills root '${skillsRoot}' because directory entries could not be read: ${getErrorMessage(error)}`
    );
    return [];
  }
}

async function readSkillDescriptor(
  skillsRoot: string,
  directoryNameRaw: string,
  scope: "global" | "project",
  containmentRoot: string
): Promise<AgentSkillDescriptor | null> {
  const parsedDirectoryName = SkillNameSchema.safeParse(directoryNameRaw);
  if (!parsedDirectoryName.success) {
    log.warn(
      `Skipping invalid ${scope} skill directory name '${directoryNameRaw}' in ${skillsRoot}`
    );
    return null;
  }

  const directoryName = parsedDirectoryName.data;
  const skillDir = path.join(skillsRoot, directoryName);
  const skillFilePath = path.join(skillDir, "SKILL.md");

  // SECURITY: validate that BOTH the skill directory and SKILL.md canonical
  // paths stay within the containment root before any read. Checking only the
  // file would let a skill-dir symlink resolve outside containment while its
  // SKILL.md symlinks back inside, advertising a skill whose sibling files
  // agent_skill_read_file would then read from the external location.
  let containedPath: string;
  try {
    await ensurePathContained(containmentRoot, skillDir);
    containedPath = await ensurePathContained(containmentRoot, skillFilePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
      );
      return null;
    }
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md escapes containment root`
    );
    return null;
  }

  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stat = await fsPromises.stat(containedPath);
  } catch {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
    );
    return null;
  }

  if (!stat.isFile()) {
    log.warn(`Skipping ${scope} skill '${directoryName}' because SKILL.md is not a regular file`);
    return null;
  }

  if (stat.size > MAX_FILE_SIZE) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is too large (${stat.size} bytes)`
    );
    return null;
  }

  let content: string;
  try {
    content = await fsPromises.readFile(containedPath, "utf-8");
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md could not be read: ${getErrorMessage(error)}`
    );
    return null;
  }

  try {
    const parsed = parseSkillMarkdown({
      content,
      byteSize: stat.size,
      directoryName,
    });

    const descriptorResult = AgentSkillDescriptorSchema.safeParse({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope,
      advertise: resolveSkillAdvertise(parsed.frontmatter),
      userInvocable: resolveSkillUserInvocable(parsed.frontmatter),
      argumentHint: parsed.frontmatter["argument-hint"],
      whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
    });

    if (!descriptorResult.success) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because descriptor validation failed: ${descriptorResult.error.message}`
      );
      return null;
    }

    return descriptorResult.data;
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is invalid: ${getErrorMessage(error)}`
    );
    return null;
  }
}

export const createAgentSkillListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_list.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_list.schema,
    execute: async ({
      includeUnadvertised,
    }: AgentSkillListToolArgs): Promise<AgentSkillListToolResult> => {
      if (!config.cwd || config.cwd.trim().length === 0) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // claude-skills-compat experiment: also list read-only .claude/skills roots.
      const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
      // agent-plugins experiment: also list read-only Agent Plugins skill roots.
      const includeAgentPlugins = config.experiments?.agentPlugins === true;

      try {
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          xumScope: config.xumScope ?? null,
          includeClaudeSkills,
          includeAgentPlugins,
        });

        if (skillCtx.kind === "project-runtime") {
          // Runtime discovery mirrors the shared default roots contract so project-runtime
          // listings include .xum/skills and .agents/skills plus ~/.xum/skills and ~/.agents/skills.
          const roots =
            skillCtx.roots ??
            getDefaultAgentSkillsRoots(skillCtx.runtime, skillCtx.workspacePath, {
              includeClaudeSkills,
              includeAgentPlugins,
            });

          const discovered = await discoverAgentSkills(skillCtx.runtime, skillCtx.workspacePath, {
            roots,
            containment: skillCtx.containment,
            dedupeByName: false,
          });
          const seenByScope = new Set<string>();
          const skills = discovered
            .filter((skill) => skill.scope !== "built-in")
            .filter((skill) => {
              const scopeKey = `${skill.scope}:${skill.name}`;
              if (seenByScope.has(scopeKey)) {
                return false;
              }
              seenByScope.add(scopeKey);
              return true;
            })
            .filter((skill) => includeUnadvertised === true || skill.advertise !== false)
            .sort((a, b) => a.name.localeCompare(b.name));

          return {
            success: true,
            skills,
          };
        }

        const { xumScope } = config;
        if (!xumScope) {
          throw new Error("agent_skill_list requires xumScope");
        }

        const userHome = os.homedir();

        // Always list global skills; also list project skills when in a project workspace.
        const roots: Array<{
          skillsRoot: string;
          containmentRoot: string;
          scope: "global" | "project";
          importedSkills?: readonly string[];
        }> = [
          {
            skillsRoot: path.join(xumScope.xumHome, "skills"),
            containmentRoot: xumScope.xumHome,
            scope: "global",
          },
          {
            skillsRoot: path.join(userHome, ".agents", "skills"),
            containmentRoot: userHome,
            scope: "global",
          },
        ];
        if (includeClaudeSkills) {
          // claude-skills-compat: lowest-precedence global root, contained at the user home
          // exactly like ~/.agents/skills.
          roots.push({
            skillsRoot: path.join(userHome, ".claude", "skills"),
            containmentRoot: userHome,
            scope: "global",
          });
        }
        if (xumScope.type === "project") {
          if (skillCtx.roots == null) {
            throw new Error("Project-local skill context requires explicit roots");
          }
          const containmentRoot = xumScope.checkoutRoot ?? xumScope.projectRoot;
          roots.unshift(
            ...getProjectSkillRoots(skillCtx.roots).map((skillsRoot) => ({
              // Project skills are nearest-directory first, before global ones.
              skillsRoot,
              containmentRoot,
              scope: "project" as const,
            }))
          );
        }

        if (includeAgentPlugins) {
          // agent-plugins experiment: expand plugin containers into per-plugin skills/ roots.
          // Containers anchor at the CHECKOUT root (matching buildProjectLocalRoots):
          // for subProjectPath workspaces `projectRoot` is the execution
          // subdirectory, but plugins live at the checkout level.
          const pluginAnchor =
            xumScope.type === "project" ? (xumScope.checkoutRoot ?? xumScope.projectRoot) : null;
          const pluginContainers = [
            ...(pluginAnchor != null
              ? [
                  ...listProjectMetadataRelativePaths("plugins").map((relativePath) => ({
                    path: path.join(pluginAnchor, relativePath),
                    scope: "project" as const,
                  })),
                  {
                    path: path.join(pluginAnchor, ".agents", "plugins"),
                    scope: "project" as const,
                  },
                ]
              : []),
            {
              path: path.join(xumScope.xumHome, "plugins"),
              scope: "global" as const,
              registryPath: path.join(xumScope.xumHome, PLUGIN_REGISTRY_FILE_NAME),
            },
            { path: path.join(userHome, ".agents", "plugins"), scope: "global" as const },
          ];
          const { plugins } = await discoverAgentPlugins(pluginContainers);
          for (const plugin of plugins) {
            if (plugin.skillsDir == null) {
              continue;
            }
            // Project plugin roots keep the repo-symlink posture of other project
            // roots: the plugin root itself must stay inside the checkout root.
            if (plugin.scope === "project" && pluginAnchor != null) {
              try {
                await ensurePathContained(pluginAnchor, plugin.rootPath);
              } catch {
                log.warn(
                  `Skipping project plugin '${plugin.name}': plugin root resolves outside the project root`
                );
                continue;
              }
            }
            // Per-skill containment anchors at the plugin root (§4.1).
            roots.push({
              skillsRoot: plugin.skillsDir,
              containmentRoot: plugin.rootPath,
              scope: plugin.scope,
              importedSkills: plugin.importedComponents?.skills,
            });
          }
        }

        const skills: AgentSkillDescriptor[] = [];
        const seenByScope = new Set<string>();
        for (const { skillsRoot, containmentRoot, scope, importedSkills } of roots) {
          let skillsRootReal: string;
          try {
            skillsRootReal = await fsPromises.realpath(skillsRoot);
          } catch (error) {
            log.warn(
              `Skipping ${scope} skills root '${skillsRoot}' because path could not be resolved: ${getErrorMessage(error)}`
            );
            continue;
          }

          // Skip roots that resolve outside their containment boundary
          // (e.g., project .mux is a symlink to an external directory).
          try {
            await ensurePathContained(containmentRoot, skillsRootReal);
          } catch {
            log.warn(`Skipping ${scope} skills root: resolves outside containment root`);
            continue;
          }

          const directoryNames = await listSkillDirectories(skillsRootReal);
          for (const directoryName of directoryNames) {
            // Skipped plugin skills must not claim a same-named fallback in this manual scan.
            if (importedSkills != null && !importedSkills.includes(directoryName)) continue;
            // SECURITY: symlinked skill directories are allowed only through
            // readSkillDescriptor's realpath containment check, which rejects
            // entries resolving outside the containment root. This matches the
            // posture of stream discovery and plugin roots.
            const descriptor = await readSkillDescriptor(
              skillsRootReal,
              directoryName,
              scope,
              containmentRoot
            );
            if (!descriptor) {
              continue;
            }

            const scopeKey = `${scope}:${descriptor.name}`;
            if (seenByScope.has(scopeKey)) {
              continue;
            }
            seenByScope.add(scopeKey);

            if (includeUnadvertised !== true && descriptor.advertise === false) {
              continue;
            }

            skills.push(descriptor);
          }
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));

        return {
          success: true,
          skills:
            includeUnadvertised === true
              ? skills
              : skills.filter((skill) => skill.advertise !== false),
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list skills: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
