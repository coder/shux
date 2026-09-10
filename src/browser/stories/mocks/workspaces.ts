import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { NOW, STABLE_TIMESTAMP } from "../storyTime";

// ═══════════════════════════════════════════════════════════════════════════════
// STABLE TIMESTAMPS
// ═══════════════════════════════════════════════════════════════════════════════

export { NOW, STABLE_TIMESTAMP };

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════
export interface WorkspaceFixture {
  id: string;
  name: string;
  projectPath: string;
  projectName: string;
  runtimeConfig?: RuntimeConfig;
  createdAt?: string;
  parentWorkspaceId?: string;
  taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
  bestOf?: FrontendWorkspaceMetadata["bestOf"];
  workflowTask?: FrontendWorkspaceMetadata["workflowTask"];
  title?: string;
  transcriptOnly?: boolean;
  pinnedAt?: string;
}

/** Create a workspace with sensible defaults */
export function createWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string }
): FrontendWorkspaceMetadata {
  const projectPath = opts.projectPath ?? `/home/user/projects/${opts.projectName}`;
  const safeName = opts.name.replace(/\//g, "-");
  return {
    id: opts.id,
    name: opts.name,
    projectPath,
    projectName: opts.projectName,
    namedWorkspacePath: `/home/user/.mux/src/${opts.projectName}/${safeName}`,
    runtimeConfig: opts.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    // Default to current time so workspaces aren't filtered as "old" by age-based UI
    createdAt: opts.createdAt ?? new Date().toISOString(),
    title: opts.title,
    parentWorkspaceId: opts.parentWorkspaceId,
    taskStatus: opts.taskStatus,
    bestOf: opts.bestOf,
    workflowTask: opts.workflowTask,
    transcriptOnly: opts.transcriptOnly,
    pinnedAt: opts.pinnedAt,
  };
}

/** Create SSH workspace */
export function createSSHWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string; host: string }
): FrontendWorkspaceMetadata {
  return createWorkspace({
    ...opts,
    runtimeConfig: {
      type: "ssh",
      host: opts.host,
      srcBaseDir: "/home/user/.mux/src",
    },
  });
}

/** Create local project-dir workspace (no isolation, uses project path directly) */
export function createLocalWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string }
): FrontendWorkspaceMetadata {
  return createWorkspace({
    ...opts,
    runtimeConfig: { type: "local" },
  });
}

/** Create workspace with incompatible runtime (for downgrade testing) */
export function createIncompatibleWorkspace(
  opts: Partial<WorkspaceFixture> & {
    id: string;
    name: string;
    projectName: string;
    incompatibleReason?: string;
  }
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace(opts),
    incompatibleRuntime:
      opts.incompatibleReason ??
      "This workspace was created with a newer version of xum.\nPlease upgrade xum to use this workspace.",
  };
}

/** Create an archived workspace (archived = archivedAt set, no unarchivedAt) */
export function createArchivedWorkspace(
  opts: Partial<WorkspaceFixture> & {
    id: string;
    name: string;
    projectName: string;
    archivedAt?: string;
  }
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace(opts),
    archivedAt: opts.archivedAt ?? new Date(NOW - 86400000).toISOString(), // 1 day ago
    // No unarchivedAt means it's archived (archivedAt > unarchivedAt where unarchivedAt is undefined)
  };
}

/** Create project config from workspaces */
export function createProjectConfig(workspaces: FrontendWorkspaceMetadata[]): ProjectConfig {
  return {
    workspaces: workspaces.map((ws) => ({
      path: ws.namedWorkspacePath,
      id: ws.id,
      name: ws.name,
    })),
  };
}

/** Group workspaces into projects Map */
export function groupWorkspacesByProject(
  workspaces: FrontendWorkspaceMetadata[]
): Map<string, ProjectConfig> {
  const projects = new Map<string, ProjectConfig>();
  const byProject = new Map<string, FrontendWorkspaceMetadata[]>();

  for (const ws of workspaces) {
    const existing = byProject.get(ws.projectPath) ?? [];
    existing.push(ws);
    byProject.set(ws.projectPath, existing);
  }

  for (const [path, wsList] of byProject) {
    projects.set(path, createProjectConfig(wsList));
  }

  return projects;
}
