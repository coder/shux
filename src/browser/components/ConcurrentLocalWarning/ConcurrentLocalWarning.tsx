import React from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { useChatDockColumnWidthClass } from "@/browser/components/ChatPane/chatDockColumn";
import { cn } from "@/common/lib/utils";
import { isLocalProjectRuntime } from "@/common/types/runtime";

/** Warn about checkout sharing, not momentary stream activity. */
export function ConcurrentLocalWarning(props: { workspaceId: string }) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const current = workspaceMetadata.get(props.workspaceId);
  if (
    !current ||
    !hasWorkspaceRepository(current) ||
    current.transcriptOnly ||
    !isLocalProjectRuntime(current.runtimeConfig)
  ) {
    return null;
  }

  // User rationale: activity can drop between requests, retries, and tool/agent handoffs.
  // No timeout can make an activity-gated warning flash-free. Checkout sharing is durable:
  // keep one static warning until metadata removes the conflict, even while agents are idle.
  // The metadata context contains only unarchived workspaces; same-family sharing is intentional.
  const rootWorkspaceId = current.rootWorkspaceId ?? props.workspaceId;
  const sharesCheckout = Array.from(workspaceMetadata.values()).some(
    (meta) =>
      hasWorkspaceRepository(meta) &&
      !meta.transcriptOnly &&
      meta.projectPath === current.projectPath &&
      isLocalProjectRuntime(meta.runtimeConfig) &&
      (meta.rootWorkspaceId ?? meta.id) !== rootWorkspaceId
  );
  return sharesCheckout ? <ConcurrentLocalWarningDecoration /> : null;
}

interface ConcurrentLocalWarningViewProps {
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
        <span className="min-w-0 truncate">Shared local checkout — agents may interfere</span>
      </div>
    </div>
  );
};
