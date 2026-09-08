import { useEffect, useState } from "react";
import type { MobileClient } from "./api";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import type { ServerChangeEvent } from "../../../src/common/orpc/schemas/api";
import { isWorkspaceArchived } from "../../../src/common/utils/archive";
import { SCRATCH_PROJECT_CONFIG_KEY } from "../../../src/common/constants/scratch";
import { linkedAbortController } from "./useConnection";
import { watchServerChanges } from "./streams";

export type Projects = Awaited<ReturnType<MobileClient["projects"]["list"]>>;
type MetadataEvent = Extract<ServerChangeEvent, { type: "metadata" }>;

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
    const loaded = { projects: false, workspaces: false };
    let failed: object | null = null;
    /**
     * One snapshot reader per catalog. Invalidations keep arriving while a read is
     * pending, and only the newest read may publish. A failed read exposes retry
     * without discarding the catalog that is already on screen; the next successful
     * read of the same catalog clears that error.
     */
    function reader<T>(
      read: (signal: AbortSignal) => Promise<T>,
      apply: (value: T) => void,
      onFailure?: () => void
    ) {
      const self = {};
      let pending: AbortController | null = null;
      return () => {
        if (controller.signal.aborted) return;
        pending?.abort();
        const request = linkedAbortController(controller.signal);
        pending = request;
        read(request.signal)
          .then(
            (value) => {
              if (request.signal.aborted) return;
              apply(value);
              if (failed === self) {
                failed = null;
                setError(null);
              }
              if (loaded.projects && loaded.workspaces) setLoading(false);
            },
            (cause: unknown) => {
              if (request.signal.aborted) return;
              failed = self;
              setError(
                cause instanceof Error ? cause.message : "Could not load projects or workspaces."
              );
              setLoading(false);
              onFailure?.();
            }
          )
          .finally(() => request.abort());
      };
    }
    const refreshProjects = reader(
      (signal) => client.projects.list(undefined, { signal }),
      (projectList) => {
        // Scratch chats have their own creation path, not a git worktree target.
        setProjects(projectList.filter(([path]) => path !== SCRATCH_PROJECT_CONFIG_KEY));
        loaded.projects = true;
      }
    );
    function applyMetadata(event: MetadataEvent) {
      setWorkspaces((current) => {
        const rest = current.filter((workspace) => workspace.id !== event.workspaceId);
        return event.metadata &&
          !isWorkspaceArchived(event.metadata.archivedAt, event.metadata.unarchivedAt)
          ? [...rest, event.metadata]
          : rest;
      });
    }
    // Events observed while a snapshot is in flight are newer than the snapshot's
    // view, so they are held back and applied on top of it.
    let heldMetadata: MetadataEvent[] | null = null;
    function releaseMetadata() {
      for (const event of heldMetadata ?? []) applyMetadata(event);
      heldMetadata = null;
    }
    const refreshWorkspaces = reader(
      (signal) => client.workspace.list(undefined, { signal }),
      (workspaceList) => {
        setWorkspaces(workspaceList);
        loaded.workspaces = true;
        releaseMetadata();
      },
      releaseMetadata
    );
    // The change stream is registered before either snapshot is read, so changes
    // during a read cannot be missed; a reopened stream re-reads both because
    // changes may have happened while it was down.
    watchServerChanges(client, {
      signal: controller.signal,
      onOpen: () => {
        heldMetadata = [];
        refreshWorkspaces();
        refreshProjects();
      },
      onEvent: (event) => {
        if (event.type === "config") refreshProjects();
        else if (event.type === "metadata")
          if (heldMetadata) heldMetadata.push(event);
          else applyMetadata(event);
      },
    }).catch(() => {
      // Only a rejected credential ends the stream; everything else retries.
      if (controller.signal.aborted) return;
      setError("The server rejected this session. Retry to reconnect or sign in again.");
      setLoading(false);
      controller.abort();
    });
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
