import { useEffect, useState } from "react";
import type { MobileClient } from "./api";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import { isWorkspaceArchived } from "../../../src/common/utils/archive";
import { SCRATCH_PROJECT_CONFIG_KEY } from "../../../src/common/constants/scratch";
import { linkedAbortController } from "./useConnection";

export type Projects = Awaited<ReturnType<MobileClient["projects"]["list"]>>;
export function useProjects(client: MobileClient, signal: AbortSignal) {
  const [projects, setProjects] = useState<Projects>([]);
  const [workspaces, setWorkspaces] = useState<FrontendWorkspaceMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = linkedAbortController(signal);
    setLoading(true);
    setError(null);
    if (signal.aborted) {
      setLoading(false);
      return;
    }
    let projectRequest: AbortController | null = null;
    let projectsLoaded = false;
    let workspacesLoaded = false;
    function finishLoading() {
      if (projectsLoaded && workspacesLoaded) setLoading(false);
    }
    function fail(cause: unknown) {
      if (controller.signal.aborted) return;
      controller.abort();
      setError(cause instanceof Error ? cause.message : "Could not load projects or workspaces.");
      setLoading(false);
    }
    function refreshProjects() {
      if (controller.signal.aborted) return;
      // Keep consuming invalidations while reading: an older response must never
      // overwrite a newer catalog used by the navigator and workspace picker.
      projectRequest?.abort();
      const request = linkedAbortController(controller.signal);
      projectRequest = request;
      client.projects
        .list(undefined, { signal: request.signal })
        .then(
          (projectList) => {
            if (request.signal.aborted) return;
            // Scratch chats have their own creation path, not a git worktree target.
            setProjects(projectList.filter(([path]) => path !== SCRATCH_PROJECT_CONFIG_KEY));
            projectsLoaded = true;
            finishLoading();
          },
          (cause: unknown) => {
            if (!request.signal.aborted) fail(cause);
          }
        )
        .finally(() => request.abort());
    }
    async function load() {
      // Register both sources before reading either snapshot so changes cannot be missed.
      const [events, configEvents] = await Promise.all([
        client.workspace.onMetadata(undefined, { signal: controller.signal }),
        client.config.onConfigChanged(undefined, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const watching = Promise.all([
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Notifications have no payload.
          for await (const _ of configEvents) {
            if (controller.signal.aborted) return;
            refreshProjects();
          }
          if (!controller.signal.aborted)
            throw new Error("Project updates disconnected. Refresh the list to reconnect.");
        })(),
        (async () => {
          const workspaceList = await client.workspace.list(undefined, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setWorkspaces(workspaceList);
          workspacesLoaded = true;
          finishLoading();
          for await (const event of events) {
            if (controller.signal.aborted) return;
            setWorkspaces((current) => {
              const rest = current.filter((workspace) => workspace.id !== event.workspaceId);
              return event.metadata &&
                !isWorkspaceArchived(event.metadata.archivedAt, event.metadata.unarchivedAt)
                ? [...rest, event.metadata]
                : rest;
            });
          }
          if (!controller.signal.aborted)
            throw new Error("Workspace updates disconnected. Refresh the list to reconnect.");
        })(),
      ]);
      refreshProjects();
      await watching;
    }
    load().catch(fail);
    return () => controller.abort();
  }, [client, signal, generation]);
  return {
    projects,
    workspaces,
    loading,
    error,
    retry: () => setGeneration((value) => value + 1),
    addWorkspace: (workspace: FrontendWorkspaceMetadata) =>
      setWorkspaces((current) => [
        ...current.filter((item) => item.id !== workspace.id),
        workspace,
      ]),
  };
}
