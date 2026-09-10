import { z } from "zod";
import { CoderWorkspaceConfigSchema } from "./coder";

export const RuntimeModeSchema = z.enum(["local", "worktree", "ssh", "docker", "devcontainer"]);

export { RuntimeEnablementIdSchema } from "@/common/schemas/ids";

/**
 * Runtime configuration union type.
 *
 * COMPATIBILITY NOTE:
 * - `type: "local"` with `srcBaseDir` = legacy worktree config (for backward compat)
 * - `type: "local"` without `srcBaseDir` = new project-dir runtime
 * - `type: "worktree"` = explicit worktree runtime (new workspaces)
 *
 * This allows two-way compatibility: users can upgrade/downgrade without breaking workspaces.
 */
// Common field for background process output directory
const bgOutputDirField = z
  .string()
  .optional()
  .meta({ description: "Directory for background process output (e.g., /tmp/mux-bashes)" });

export const DevcontainerConfigInfoSchema = z.object({
  path: z.string(),
  label: z.string(),
});

/**
 * Runtime availability status - discriminated union that can carry mode-specific data.
 * Most runtimes use the simple available/unavailable shape; devcontainer carries extra
 * config info when available.
 *
 * IMPORTANT: The configs-bearing shape MUST come before the plain `{ available: true }`
 * shape in the union. Zod matches the first valid schema, so if the plain shape comes
 * first, it will match and strip the `configs` field from devcontainer responses.
 */
export const RuntimeAvailabilityStatusSchema = z.union([
  // Devcontainer-specific: available with configs (must be first to preserve configs)
  z.object({
    available: z.literal(true),
    configs: z.array(DevcontainerConfigInfoSchema),
    cliVersion: z.string().optional(),
  }),
  // Generic: available without extra data
  z.object({ available: z.literal(true) }),
  // Unavailable with reason
  z.object({ available: z.literal(false), reason: z.string() }),
]);

export const RuntimeAvailabilitySchema = z.object({
  local: RuntimeAvailabilityStatusSchema,
  worktree: RuntimeAvailabilityStatusSchema,
  ssh: RuntimeAvailabilityStatusSchema,
  docker: RuntimeAvailabilityStatusSchema,
  devcontainer: RuntimeAvailabilityStatusSchema,
});
export const RuntimeConfigSchema = z.union([
  // Legacy local with srcBaseDir (treated as worktree)
  z.object({
    type: z.literal("local"),
    srcBaseDir: z.string().meta({
      description: "Base directory where all workspaces are stored (legacy worktree config)",
    }),
    bgOutputDir: bgOutputDirField,
  }),
  // New project-dir local (no srcBaseDir)
  z.object({
    type: z.literal("local"),
    bgOutputDir: bgOutputDirField,
  }),
  // Explicit worktree runtime
  z.object({
    type: z.literal("worktree"),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory where all workspaces are stored (e.g., ~/.xum/src)" }),
    bgOutputDir: bgOutputDirField,
  }),
  // SSH runtime
  z.object({
    type: z.literal("ssh"),
    host: z
      .string()
      .meta({ description: "SSH host (can be hostname, user@host, or SSH config alias)" }),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory on remote host where all workspaces are stored" }),
    bgOutputDir: bgOutputDirField,
    identityFile: z
      .string()
      .optional()
      .meta({ description: "Path to SSH private key (if not using ~/.ssh/config or ssh-agent)" }),
    port: z.number().optional().meta({ description: "SSH port (default: 22)" }),
    coder: CoderWorkspaceConfigSchema.optional().meta({
      description: "Coder workspace configuration (when using Coder as SSH backend)",
    }),
  }),
  // Docker runtime - each workspace runs in its own container
  z.object({
    type: z.literal("docker"),
    image: z.string().meta({ description: "Docker image to use (e.g., node:20)" }),
    containerName: z
      .string()
      .optional()
      .meta({ description: "Container name (populated after workspace creation)" }),
    shareCredentials: z.boolean().optional().meta({
      description: "Forward SSH agent and mount ~/.gitconfig read-only",
    }),
  }),
  // Devcontainer runtime - uses devcontainer CLI to build/run containers from devcontainer.json
  z.object({
    type: z.literal("devcontainer"),
    configPath: z
      .string()
      .meta({ description: "Path to devcontainer.json (relative to project root)" }),
    shareCredentials: z.boolean().optional().meta({
      description: "Forward SSH agent and mount ~/.gitconfig read-only",
    }),
  }),
]);
