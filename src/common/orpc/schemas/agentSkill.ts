import { z } from "zod";

export const AgentSkillScopeSchema = z.enum(["project", "global", "built-in"]);

/**
 * Skill name per agentskills.io
 * - 1–64 chars
 * - lowercase letters/numbers/hyphens
 * - no leading/trailing hyphen
 * - no consecutive hyphens
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const AgentSkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),

  // When false, skill is NOT listed in the tool description's skill index.
  // Unadvertised skills can still be invoked via /skill-name or agent_skill_read({ name: "skill-name" }).
  // Use for internal orchestration skills, sub-agent-only skills, or power-user workflows.
  advertise: z.boolean().optional(),

  // Ecosystem-standard spelling (Claude Code extension, recognized by other agent tools).
  // `disable-model-invocation: true` behaves like `advertise: false`: the skill is hidden
  // from model-facing indexes but stays user-invocable via /skill-name.
  "disable-model-invocation": z.boolean().optional(),

  // Ecosystem-standard (Claude Code / VS Code Copilot) inverse counterpart of
  // disable-model-invocation. When false, the skill is hidden from USER-facing invocation
  // surfaces (slash menu, $-inline suggestions, command palette skill lists, ACP
  // availableCommands) and is not resolvable via typed /skill-name or $skill-name.
  // Model-facing behavior (agent_skill_read index/read, agent_skill_list) is unaffected.
  // Default (absent) = invocable.
  "user-invocable": z.boolean().optional(),

  // Ecosystem-standard (Claude Code) hint shown next to user-facing invocation surfaces
  // describing expected arguments, e.g. "[issue-number]".
  "argument-hint": z.string().min(1).max(200).optional(),

  // Extra model-facing guidance appended to the skill's entry in the agent_skill_read
  // tool-description index. Both spellings are accepted: `when_to_use` (used by the
  // obra/superpowers ecosystem) and `when-to-use` (kebab-case, matching the other
  // Claude-Code-style keys above).
  when_to_use: z.string().min(1).max(1024).optional(),
  "when-to-use": z.string().min(1).max(1024).optional(),
});

/**
 * Effective `advertise` value for a skill descriptor, honoring both spellings:
 * - `advertise: false` (mux-specific)
 * - `disable-model-invocation: true` (ecosystem-standard, Claude Code compatible)
 *
 * When both are present the most restrictive wins, so either opt-out hides the skill.
 * Descriptor construction must use this instead of reading `frontmatter.advertise` directly.
 */
export function resolveSkillAdvertise(
  frontmatter: Pick<
    z.infer<typeof AgentSkillFrontmatterSchema>,
    "advertise" | "disable-model-invocation"
  >
): boolean | undefined {
  if (frontmatter["disable-model-invocation"] === true) {
    return false;
  }
  return frontmatter.advertise;
}

/**
 * Effective `userInvocable` value for a skill descriptor.
 *
 * `user-invocable: false` hides the skill from user-facing invocation surfaces without
 * affecting model-facing surfaces (the inverse of disable-model-invocation).
 * Descriptor construction must use this instead of reading the raw frontmatter key.
 */
export function resolveSkillUserInvocable(
  frontmatter: Pick<z.infer<typeof AgentSkillFrontmatterSchema>, "user-invocable">
): boolean | undefined {
  return frontmatter["user-invocable"];
}

/**
 * Effective `whenToUse` guidance for a skill descriptor, honoring both spellings.
 *
 * Prefers `when_to_use` (obra/superpowers ecosystem spelling) over `when-to-use`
 * when both are present. Descriptor construction must use this instead of reading
 * the raw frontmatter keys.
 */
export function resolveSkillWhenToUse(
  frontmatter: Pick<z.infer<typeof AgentSkillFrontmatterSchema>, "when_to_use" | "when-to-use">
): string | undefined {
  return frontmatter.when_to_use ?? frontmatter["when-to-use"];
}

export const AgentSkillDescriptorSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  scope: AgentSkillScopeSchema,
  advertise: z.boolean().optional(),
  /** Normalized `user-invocable` frontmatter (false = hidden from user-facing invocation surfaces). */
  userInvocable: z.boolean().optional(),
  /** Normalized `argument-hint` frontmatter (expected-arguments hint for user-facing surfaces). */
  argumentHint: z.string().min(1).max(200).optional(),
  /** Normalized `when_to_use`/`when-to-use` frontmatter (extra model-facing index guidance). */
  whenToUse: z.string().min(1).max(1024).optional(),
  /** Agent Plugins: contributing plugin name (absent for non-plugin skills). */
  pluginName: z.string().min(1).optional(),
});

export const AgentSkillPackageSchema = z
  .object({
    scope: AgentSkillScopeSchema,
    directoryName: SkillNameSchema,
    frontmatter: AgentSkillFrontmatterSchema,
    body: z.string(),
  })
  .refine((value) => value.directoryName === value.frontmatter.name, {
    message: "SKILL.md frontmatter.name must match the parent directory name",
    path: ["frontmatter", "name"],
  });

// Diagnostics (invalid skill discovery)
export const AgentSkillIssueSchema = z.object({
  /** Directory name under the skills root (may be invalid / non-kebab-case). */
  directoryName: z.string().min(1),
  scope: AgentSkillScopeSchema,
  /** User-facing path to the problematic skill (typically .../<dir>/SKILL.md). */
  displayPath: z.string().min(1),
  /** What went wrong while trying to load the skill. */
  message: z.string().min(1),
  /** Optional fix suggestion. */
  hint: z.string().min(1).optional(),
});
