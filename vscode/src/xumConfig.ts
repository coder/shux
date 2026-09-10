import { Config } from "xum/node/config";
import assert from "node:assert";

import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "xum/common/types/workspace";
import { type ExtensionMetadata, readExtensionMetadata } from "xum/node/utils/extensionMetadata";
import { createRuntime } from "xum/node/runtime/runtimeFactory";

import type { ApiClient } from "./api/client";

/**
 * Workspace with extension metadata for display in VS Code extension.
 */

const DEFAULT_WORKSPACE_LIST_TIMEOUT_MS = 5_000;

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  assert(timeoutMs > 0, "timeoutMs must be positive");

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
    });
  });
}
export interface WorkspaceWithContext extends FrontendWorkspaceMetadata {
  extensionMetadata?: ExtensionMetadata;
}

function enrichAndSort(
  workspaces: FrontendWorkspaceMetadata[],
  extensionMeta: Map<string, ExtensionMetadata>
): WorkspaceWithContext[] {
  const enriched: WorkspaceWithContext[] = workspaces.map((ws) => {
    return {
      ...ws,
      extensionMetadata: extensionMeta.get(ws.id),
    };
  });

  // Sort by recency (extension metadata > createdAt > name)
  const recencyOf = (w: WorkspaceWithContext): number =>
    w.extensionMetadata?.recency ?? (w.createdAt ? Date.parse(w.createdAt) : 0);

  enriched.sort((a, b) => {
    const aRecency = recencyOf(a);
    const bRecency = recencyOf(b);
    if (aRecency !== bRecency) return bRecency - aRecency;
    return a.name.localeCompare(b.name);
  });

  return enriched;
}

export async function getAllWorkspacesFromFiles(options?: {
  timeoutMs?: number;
}): Promise<WorkspaceWithContext[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WORKSPACE_LIST_TIMEOUT_MS;

  const config = new Config();
  const workspaces = await promiseWithTimeout(
    config.getAllWorkspaceMetadata(),
    timeoutMs,
    "Read xum workspaces from files"
  );
  const extensionMeta = readExtensionMetadata();
  return enrichAndSort(workspaces, extensionMeta);
}

export async function getAllWorkspacesFromApi(
  client: ApiClient,
  options?: {
    timeoutMs?: number;
  }
): Promise<WorkspaceWithContext[]> {
  assert(client, "getAllWorkspacesFromApi requires client");

  const timeoutMs = options?.timeoutMs ?? DEFAULT_WORKSPACE_LIST_TIMEOUT_MS;

  const [workspaces, activityById] = await Promise.all([
    promiseWithTimeout(client.workspace.list(), timeoutMs, "xum API workspace.list"),
    promiseWithTimeout(
      // null = backend activity read failure; fall back to metadata-only sorting.
      client.workspace.activity.list() as Promise<Record<string, WorkspaceActivitySnapshot> | null>,
      timeoutMs,
      "xum API workspace.activity.list"
    ),
  ]);

  const extensionMeta = new Map<string, ExtensionMetadata>();
  for (const [workspaceId, activity] of Object.entries(activityById ?? {})) {
    extensionMeta.set(workspaceId, {
      recency: activity.recency,
      streaming: activity.streaming,
      lastModel: activity.lastModel,
      lastThinkingLevel: activity.lastThinkingLevel,
    });
  }

  return enrichAndSort(workspaces, extensionMeta);
}

/**
 * Get the workspace path for local or SSH workspaces.
 * Uses Runtime to compute path using main app's logic.
 */
export function getWorkspacePath(workspace: WorkspaceWithContext): string {
  const runtime = createRuntime(workspace.runtimeConfig, { projectPath: workspace.projectPath });
  return runtime.getWorkspacePath(workspace.projectPath, workspace.name);
}
