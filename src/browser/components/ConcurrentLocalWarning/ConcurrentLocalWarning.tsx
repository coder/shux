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
 * Counts unrelated local agents sharing this checkout, without cycling their identities.
 */
export function useConcurrentLocalAgentCount(props: ConcurrentLocalWarningProps): number {
  const isLocalProject = isLocalProjectRuntime(props.runtimeConfig);
  const { workspaceMetadata } = useWorkspaceContext();
  const store = useWorkspaceStoreRaw();

  // Sub-agents share their family's checkout intentionally, not as competing local agents.
  const rootWorkspaceId =
    workspaceMetadata.get(props.workspaceId)?.rootWorkspaceId ?? props.workspaceId;
  const otherLocalWorkspaces = Array.from(workspaceMetadata.values()).filter(
    (meta) =>
      isLocalProject &&
      meta.projectPath === props.projectPath &&
      isLocalProjectRuntime(meta.runtimeConfig) &&
      (meta.rootWorkspaceId ?? meta.id) !== rootWorkspaceId
  );

  const streamingCount = useSyncExternalStore(
    (listener) => {
      const unsubscribers = otherLocalWorkspaces.map((meta) =>
        store.subscribeKey(meta.id, listener)
      );
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    () =>
      otherLocalWorkspaces.filter((meta) => {
        try {
          return store.getWorkspaceSidebarState(meta.id).canInterrupt;
        } catch {
          // Workspace may not be registered yet, skip.
          return false;
        }
      }).length,
    () => 0
  );
  const scope = JSON.stringify([
    rootWorkspaceId,
    props.projectPath,
    otherLocalWorkspaces.map((meta) => meta.id).sort(),
  ]);
  const heldCount = useRef({ scope, count: streamingCount });
  if (streamingCount > 0) heldCount.current = { scope, count: streamingCount };
  const { displayPhase } = useWorkspaceStreamingStatusPhase(
    streamingCount > 0 ? "streaming" : null
  );

  // Hold brief handoffs, but clear immediately when eligibility changes rather than
  // carrying a stale warning into another family, project, or isolated checkout.
  return displayPhase && heldCount.current.scope === scope ? heldCount.current.count : 0;
}

interface ConcurrentLocalWarningViewProps {
  agentCount: number;
  className?: string;
}

export const ConcurrentLocalWarningDecoration: React.FC<ConcurrentLocalWarningViewProps> = (
  props
) => {
  const columnWidthClass = useChatDockColumnWidthClass();
  return (
    <div
      className={cn("bg-surface-primary", CHAT_DOCK_GUTTER_CLASS)}
      data-component="ConcurrentLocalWarningDecoration"
    >
      <div
        role="status"
        className={cn(
          "text-muted flex h-6 items-center gap-2 text-xs leading-none",
          columnWidthClass,
          props.className
        )}
      >
        <AlertTriangle aria-hidden="true" className="text-warning size-3.5 shrink-0" />
        <span className="counter-nums min-w-0 truncate">
          {props.agentCount} other local agent{props.agentCount === 1 ? "" : "s"} running — may
          interfere
        </span>
      </div>
    </div>
  );
};
