import { z } from "zod";

import {
  AgentPluginGitSourceSchema,
  AgentPluginImportedComponentsSchema,
  AgentPluginInstallEntrySchema,
} from "@/common/config/schemas/agentPluginInstalls";

/**
 * oRPC shapes for the managed Agent Plugin installer (agent-plugins
 * experiment). Registry entry + source schemas are shared with the on-disk
 * config schema (single source of truth).
 */

export { AgentPluginGitSourceSchema, AgentPluginInstallEntrySchema };

export const AgentPluginPreviewSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export const AgentPluginPreviewMcpServerSchema = z.object({
  serverName: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** Human-readable command line (stdio) or URL (remote) shown in the consent preview. */
  summary: z.string(),
});

/** Offline full inventory of the locked installed tree, separate from its saved imports. */
export const AgentPluginComponentsSchema = z.object({
  lockedSha: z.string(),
  /** Full installed-tree content receipt; lockedSha alone does not detect local edits. */
  contentHash: z.string(),
  skills: z.array(AgentPluginPreviewSkillSchema),
  mcpServers: z.array(AgentPluginPreviewMcpServerSchema),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
});
export type AgentPluginComponents = z.infer<typeof AgentPluginComponentsSchema>;

/**
 * Executable hooks.js disclosure: hooks load automatically after install and
 * can observe/rewrite/block tool calls, so consent must surface them.
 */
export const AgentPluginPreviewHookSchema = z.object({
  /** Plugin-relative path to the hook entry file (e.g. "hooks.js"). */
  path: z.string(),
  /** Tool names the manifest requests visibility into (empty = least privilege, no tools). */
  toolGrants: z.array(z.string()),
});

/** Composer slash command declared by the manifest (data-driven expansion). */
export const AgentPluginPreviewSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

/** Manifest metadata surfaced in the consent preview (UI-safe projection of plugin.json). */
export const AgentPluginManifestSummarySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  authorName: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
});

/**
 * Everything a user consents to before anything is written: the resolved
 * source + SHA, the manifest, every skill, and every MCP server command line.
 */
export const AgentPluginInstallPreviewSchema = z.object({
  source: AgentPluginGitSourceSchema,
  /** Commit SHA the preview was computed from; install verifies it gets the same tree. */
  lockedSha: z.string(),
  manifest: AgentPluginManifestSummarySchema,
  skills: z.array(AgentPluginPreviewSkillSchema),
  mcpServers: z.array(AgentPluginPreviewMcpServerSchema),
  /** Present when the plugin ships an executable hooks.js (absent = no hooks). */
  hook: AgentPluginPreviewHookSchema.optional(),
  /** Agent definition files (agents/*.md) that become selectable agents. */
  agents: z.array(z.string()),
  /** Executable workflow scripts (workflows/*.js) invokable after install. */
  workflows: z.array(z.string()),
  /** Composer slash commands the manifest contributes. */
  slashCommands: z.array(AgentPluginPreviewSlashCommandSchema),
  /** Manifest warnings + component diagnostics from validating the staged clone. */
  warnings: z.array(z.string()),
  /** Final install directory (~/.mux/plugins/<name>). */
  targetPath: z.string(),
});

export const AgentPluginListItemSchema = z.object({
  name: z.string(),
  /** True when a registry entry exists; unmanaged dirs found by discovery are read-only. */
  managed: z.boolean(),
  /** False for managed entries whose directory vanished (registry self-heal display). */
  present: z.boolean(),
  /** Display location, e.g. "~/.mux/plugins/demo". */
  location: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  source: AgentPluginGitSourceSchema.optional(),
  lockedSha: z.string().optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
  importedSkillCount: z.number().int().nonnegative().optional(),
  importedMcpServerCount: z.number().int().nonnegative().optional(),
  /** Available counts include components not yet imported. */
  skillCount: z.number().int().nonnegative(),
  mcpServerCount: z.number().int().nonnegative(),
});

export const AgentPluginUpdateCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["up-to-date", "update-available", "tag-moved", "pinned", "error"]),
  /** Remote tip SHA for update-available / tag-moved. */
  remoteSha: z.string().optional(),
  /** Error detail when status is "error". */
  message: z.string().optional(),
});

/**
 * One consent-relevant difference between the installed tree and a staged
 * update (see installService capabilitySurface). `before`/`after` carry the
 * human-readable value on each side so the user can judge the change instead
 * of only being told that something changed; additions have no `before`.
 */
export const AgentPluginCapabilityChangeSchema = z.object({
  summary: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
});

/** Ties an update confirmation to the exact trees the user reviewed. */
export const AgentPluginUpdateConsentSchema = z.object({
  /** lockedSha of the install the review compared against. */
  fromSha: z.string(),
  /** Commit the review staged; update installs exactly this commit. */
  toSha: z.string(),
});

/**
 * Update review: what applying the pending update would change in the
 * plugin's capability surface. Empty `changes` means the update applies
 * without re-consent.
 */
export const AgentPluginUpdateReviewSchema = z.object({
  name: z.string(),
  fromSha: z.string(),
  toSha: z.string(),
  /** Staged manifest version, when declared. */
  version: z.string().optional(),
  changes: z.array(AgentPluginCapabilityChangeSchema),
  /** Manifest warnings + component diagnostics from validating the staged clone. */
  warnings: z.array(z.string()),
});

export type AgentPluginCapabilityChange = z.infer<typeof AgentPluginCapabilityChangeSchema>;
export type AgentPluginUpdateConsent = z.infer<typeof AgentPluginUpdateConsentSchema>;
export type AgentPluginUpdateReview = z.infer<typeof AgentPluginUpdateReviewSchema>;
export type AgentPluginPreviewSkill = z.infer<typeof AgentPluginPreviewSkillSchema>;
export type AgentPluginPreviewMcpServer = z.infer<typeof AgentPluginPreviewMcpServerSchema>;
export type AgentPluginPreviewHook = z.infer<typeof AgentPluginPreviewHookSchema>;
export type AgentPluginManifestSummary = z.infer<typeof AgentPluginManifestSummarySchema>;
export type AgentPluginInstallPreview = z.infer<typeof AgentPluginInstallPreviewSchema>;
export type AgentPluginListItem = z.infer<typeof AgentPluginListItemSchema>;
export type AgentPluginUpdateCheck = z.infer<typeof AgentPluginUpdateCheckSchema>;

/**
 * Agent Plugins (agent-plugins.org) oRPC schemas: manifest-contributed slash
 * commands and the per-workspace composition inspector payload.
 */

/** Slash command contributed by an Agent Plugin manifest (`contributes.slashCommands`). */
export const PluginSlashCommandDescriptorSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  /** Replacement text inserted into the composer when the command is invoked. */
  expansion: z.string().min(1),
  pluginName: z.string().min(1),
  scope: z.enum(["project", "global"]),
});
export type PluginSlashCommandDescriptor = z.infer<typeof PluginSlashCommandDescriptorSchema>;

/** One artifact row in the workspace composition (effective or shadowed). */
export const WorkspaceCompositionEntrySchema = z.object({
  name: z.string().min(1),
  /** Layer providing the artifact: built-in | global | project | plugin:<name>. */
  source: z.string().min(1),
  description: z.string().optional(),
  /** Source label of the higher-precedence entry overriding this one (absent = effective). */
  shadowedBy: z.string().optional(),
});
export type WorkspaceCompositionEntry = z.infer<typeof WorkspaceCompositionEntrySchema>;

export const WorkspaceCompositionPluginSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "global"]),
  rootPath: z.string().min(1),
  version: z.string().optional(),
  /** Component kinds the plugin contributes (skills, mcp, agents, workflows, hooks, slashCommands). */
  components: z.array(z.string()),
});
export type WorkspaceCompositionPlugin = z.infer<typeof WorkspaceCompositionPluginSchema>;

export const WorkspaceCompositionDiagnosticSchema = z.object({
  path: z.string(),
  scope: z.enum(["project", "global"]),
  severity: z.enum(["warning", "error"]),
  message: z.string(),
});

/**
 * Effective per-workspace composition by artifact kind — the `--dump-config`
 * analog. One bulk structure so the inspector needs a single oRPC call.
 */
export const WorkspaceCompositionSchema = z.object({
  agentPluginsEnabled: z.boolean(),
  /** Discovered plugins (manifest parsing/validation is NOT experiment-gated). */
  plugins: z.array(WorkspaceCompositionPluginSchema),
  diagnostics: z.array(WorkspaceCompositionDiagnosticSchema),
  skills: z.array(WorkspaceCompositionEntrySchema),
  agents: z.array(WorkspaceCompositionEntrySchema),
  workflows: z.array(WorkspaceCompositionEntrySchema),
  mcpServers: z.array(WorkspaceCompositionEntrySchema),
  slashCommands: z.array(WorkspaceCompositionEntrySchema),
  hooks: z.array(WorkspaceCompositionEntrySchema),
});
export type WorkspaceComposition = z.infer<typeof WorkspaceCompositionSchema>;
