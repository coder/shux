import React, { useRef, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { useWorkspaceStreamingStatusPhase } from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { useChatDockColumnWidthClass } from "@/browser/components/ChatPane/chatDockColumn";
import { cn } from "@/common/lib/utils";
import { isLocalProjectRuntime } from "@/common/types/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";

interface ConcurrentLocalWarningProps {
  workspaceId: string;
  projectPath: string;
  runtimeConfig?: RuntimeConfig;
}

/**
 * Returns the name of another local-project workspace that is actively streaming in the same
 * project directory, or null when there is no conflicting local stream to warn about.
 */
export function useConcurrentLocalStreamingWorkspaceName(
  props: ConcurrentLocalWarningProps
): string | null {
  const isLocalProject = isLocalProjectRuntime(props.runtimeConfig);
  const { workspaceMetadata } = useWorkspaceContext();
  const store = useWorkspaceStoreRaw();

  // Sub-agents share their family's checkout intentionally, not as competing local agents.
  const getRootWorkspaceId = (id: string): string => {
    const visited = new Set<string>();
    while (!visited.has(id)) {
      visited.add(id);
      const parentId = workspaceMetadata.get(id)?.parentWorkspaceId;
      if (!parentId) break;
      id = parentId;
    }
    return id;
  };
  const rootWorkspaceId = getRootWorkspaceId(props.workspaceId);
  const otherLocalWorkspaces = Array.from(workspaceMetadata.values()).filter(
    (meta) =>
      isLocalProject &&
      meta.projectPath === props.projectPath &&
      isLocalProjectRuntime(meta.runtimeConfig) &&
      getRootWorkspaceId(meta.id) !== rootWorkspaceId
  );

  const streamingWorkspaceId = useSyncExternalStore(
    (listener) => {
      const unsubscribers = otherLocalWorkspaces.map((meta) =>
        store.subscribeKey(meta.id, listener)
      );
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    () =>
      otherLocalWorkspaces.find((meta) => {
        try {
          return store.getWorkspaceSidebarState(meta.id).canInterrupt;
        } catch {
          // Workspace may not be registered yet, skip.
          return false;
        }
      })?.id ?? null,
    () => null
  );
  const lastStreamingIdRef = useRef(streamingWorkspaceId);
  if (streamingWorkspaceId !== null) {
    lastStreamingIdRef.current = streamingWorkspaceId;
  }
  const { displayPhase } = useWorkspaceStreamingStatusPhase(
    streamingWorkspaceId === null ? null : "streaming"
  );

  // Hold brief activity handoffs only while the workspace is still a potential conflict.
  // Resolve the held identity against current candidates rather than retaining a stale name.
  return displayPhase === null
    ? null
    : (otherLocalWorkspaces.find((meta) => meta.id === lastStreamingIdRef.current)?.name ?? null);
}

interface ConcurrentLocalWarningViewProps {
  streamingWorkspaceName: string;
  className?: string;
}

export const ConcurrentLocalWarningView: React.FC<ConcurrentLocalWarningViewProps> = (props) => {
  return (
    <div
      role="status"
      className={cn("text-muted flex h-6 items-center gap-2 text-xs leading-none", props.className)}
    >
      <AlertTriangle aria-hidden="true" className="text-warning size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="text-foreground font-medium">{props.streamingWorkspaceName}</span> is also
        running in this project directory — agents may interfere
      </span>
    </div>
  );
};

export const ConcurrentLocalWarningDecoration: React.FC<ConcurrentLocalWarningViewProps> = (
  props
) => {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div
      className={cn("bg-surface-primary", CHAT_DOCK_GUTTER_CLASS)}
      data-component="ConcurrentLocalWarningDecoration"
    >
      <ConcurrentLocalWarningView
        streamingWorkspaceName={props.streamingWorkspaceName}
        className={cn(columnWidthClass, props.className)}
      />
    </div>
  );
};
