/**
 * Unified workspace metadata type used throughout the application.
 * This is the single source of truth for workspace information.
 *
 * ID vs Name:
 * - `id`: Stable unique identifier (10 hex chars for new workspaces, legacy format for old)
 *   Generated once at creation, never changes
 * - `name`: User-facing mutable name (e.g., "feature-branch")
 *   Can be changed via rename operation
 *
 * For legacy workspaces created before stable IDs:
 * - id and name are the same (e.g., "mux-stable-ids")
 * For new workspaces:
 * - id is a random 10 hex char string (e.g., "a1b2c3d4e5")
 * - name is the branch/workspace name (e.g., "feature-branch")
 *
 * Path handling:
 * - Worktree paths are computed on-demand via config.getWorkspacePath(projectPath, name)
 * - Directory name uses workspace.name (the branch name)
 * - This avoids storing redundant derived data
 */
import type { z } from "zod";
import type {
  FrontendWorkspaceMetadataSchema,
  GitStatusSchema,
  ProjectRefSchema,
  WorkspaceActivitySnapshotSchema,
  WorkspaceMetadataSchema,
} from "../orpc/schemas";

import type {
  WorkspaceRemoveResultSchema,
  WorkspaceRemovalDescendantSchema,
} from "../orpc/schemas/workspace";

export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/**
 * Git status for a workspace (ahead/behind relative to origin's primary branch)
 */
export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * Frontend workspace metadata enriched with computed paths.
 * Backend computes these paths to avoid duplication of path construction logic.
 * Follows naming convention: Backend types vs Frontend types.
 */
export type FrontendWorkspaceMetadata = z.infer<typeof FrontendWorkspaceMetadataSchema>;

export type WorkspaceActivitySnapshot = z.infer<typeof WorkspaceActivitySnapshotSchema>;

export type WorkspaceRemoveResult = z.infer<typeof WorkspaceRemoveResultSchema>;
export type WorkspaceRemovalDescendant = z.infer<typeof WorkspaceRemovalDescendantSchema>;
