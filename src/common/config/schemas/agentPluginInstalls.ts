import { z } from "zod";

import {
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  AGENT_PLUGIN_NAME_PATTERN,
  isValidAgentPluginName,
} from "@/common/utils/agentPluginName";

/**
 * Managed Agent Plugin install registry — persisted as `~/.mux/plugins.json`
 * with the shape `{ plugins: AgentPluginInstallEntry[] }`.
 *
 * A standalone file (not a `~/.mux/config.json` section) on purpose: older
 * builds rebuild config.json from known fields on every save, so a downgrade
 * would silently drop an embedded registry. A file older builds never touch
 * survives upgrade↔downgrade round-trips. The install service additionally
 * rewrites the file from its RAW entry list (entries validated per-element
 * on read, matched by `name` on mutation), so entries and fields written by
 * newer builds survive mutations on this build.
 *
 * Semantics (mirroring lazy.nvim / Claude Code): `source.ref` is the tracking
 * channel and `lockedSha` is what is actually on disk and runs. Install
 * resolves ref → SHA and records both; the runtime never follows a branch
 * implicitly — updates apply only on explicit user action.
 *
 * The registry records provenance and optional component imports. Plugin discovery
 * (src/node/services/agentPlugins/discovery.ts) remains the source of truth
 * for what loads, so drift between registry and disk self-heals: directories
 * without a registry entry show as "unmanaged", entries without a directory
 * show as "missing".
 */

export const AgentPluginGitSourceSchema = z.object({
  type: z.literal("git"),
  /** Normalized clone URL (https or ssh) derived from the user's input. */
  url: z.string().min(1),
  /** Tracking ref: branch name, tag name, or full 40-hex commit SHA. */
  ref: z.string().min(1),
  /**
   * How `ref` is treated by update checks: branches track their remote tip,
   * tags are pinned but warn when the tag moves, commits are fully pinned.
   */
  refType: z.enum(["branch", "tag", "commit"]),
  /**
   * Repo-relative directory of the plugin for monorepo installs. Parsed and
   * persisted from day one so the descriptor grammar is stable, but v1
   * rejects subpath installs (sparse-checkout staging lands in v2).
   */
  subpath: z.string().optional(),
});

/**
 * Tagged union so future source kinds (`path`, `archive`, `catalog`) slot in
 * without a registry migration.
 */
export const AgentPluginInstallSourceSchema = z.discriminatedUnion("type", [
  AgentPluginGitSourceSchema,
]);

/** Absent on legacy installs (import everything); present arrays are exact allowlists. */
export const AgentPluginImportedComponentsSchema = z.object({
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
});
export type AgentPluginImportedComponents = z.infer<typeof AgentPluginImportedComponentsSchema>;

export const AgentPluginInstallEntrySchema = z.object({
  /**
   * plugin.json `name`; also the directory name under `~/.mux/plugins`.
   * Pattern-enforced because it is joined into filesystem paths that
   * uninstall deletes recursively — `.`/`..`/separators must never validate.
   */
  name: z
    .string()
    .max(AGENT_PLUGIN_NAME_MAX_LENGTH)
    .regex(AGENT_PLUGIN_NAME_PATTERN)
    // Full validator on top of the grammar: also rejects Windows-reserved
    // device names, which pattern+length alone admit.
    .refine(isValidAgentPluginName, { message: "reserved or invalid plugin name" }),
  /** v1 installs are global-only; the installer never writes into project checkouts. */
  scope: z.literal("global"),
  source: AgentPluginInstallSourceSchema,
  /** Commit SHA of the tree installed on disk (what actually runs). */
  lockedSha: z.string().min(1),
  /** ISO-8601 install timestamp. */
  installedAt: z.string().min(1),
  /** ISO-8601 timestamp of the most recent applied update. */
  updatedAt: z.string().optional(),
  /** Cached manifest metadata so the list UI works offline / when the dir is missing. */
  manifest: z
    .object({
      version: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  importedComponents: AgentPluginImportedComponentsSchema.optional(),
  /** Reserved: per-plugin opt-in auto-update. Unused in v1 — updates are badge + manual. */
  autoUpdate: z.boolean().optional(),
});

export const AgentPluginInstallsSchema = z.array(AgentPluginInstallEntrySchema);

export type AgentPluginGitSource = z.infer<typeof AgentPluginGitSourceSchema>;
export type AgentPluginInstallSource = z.infer<typeof AgentPluginInstallSourceSchema>;
export type AgentPluginInstallEntry = z.infer<typeof AgentPluginInstallEntrySchema>;
