import React from "react";

import { cn } from "@/common/lib/utils";
import { getArchivedWorkspacesExpandedKey } from "@/common/constants/storage";
import { isWorktreeRuntime } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { ChevronDown, ChevronRight, FolderX, Loader2, Search, Trash2 } from "lucide-react";
import { ArchiveIcon, ArchiveRestoreIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { RuntimeBadge } from "../RuntimeBadge/RuntimeBadge";
import { Skeleton } from "../Skeleton/Skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/Dialog/Dialog";
import { ForceDeleteModal } from "../ForceDeleteModal/ForceDeleteModal";
import { Button } from "@/browser/components/Button/Button";
import { PopoverError } from "@/browser/components/PopoverError/PopoverError";
import type { z } from "zod";
import type { SessionUsageFileSchema } from "@/common/orpc/schemas/chatStats";
import {
  sumUsageHistory,
  getTotalCost,
  formatCostWithDollar,
} from "@/common/utils/tokens/usageAggregator";
import { useOptimisticBatchLRU } from "@/browser/hooks/useOptimisticBatchLRU";
import { sessionCostCache } from "@/browser/utils/sessionCostCache";

type SessionUsageFile = z.infer<typeof SessionUsageFileSchema>;

interface ArchivedWorkspacesProps {
  projectPath: string;
  projectName: string;
  workspaces: FrontendWorkspaceMetadata[];
  /** Called after a workspace is unarchived or deleted to refresh the list */
  onWorkspacesChanged?: () => void;
}

interface BulkOperationState {
  type: "restore" | "delete" | "deleteWorktree";
  total: number;
  completed: number;
  current: string | null;
  errors: string[];
}

function canDeleteManagedWorktree(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    isWorktreeRuntime(workspace.runtimeConfig) &&
    workspace.transcriptOnly !== true &&
    // isolation:none tasks reuse an ancestor checkout, so they do not own local worktree state.
    workspace.taskIsolation !== "none"
  );
}

/** Group workspaces by time period for timeline display */
function groupByTimePeriod(
  workspaces: FrontendWorkspaceMetadata[]
): Map<string, FrontendWorkspaceMetadata[]> {
  const groups = new Map<string, FrontendWorkspaceMetadata[]>();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const lastMonth = new Date(today.getTime() - 30 * 86400000);

  // Sort by archivedAt descending (most recent first)
  const sorted = [...workspaces].sort((a, b) => {
    const aTime = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
    const bTime = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
    return bTime - aTime;
  });

  for (const ws of sorted) {
    const archivedDate = ws.archivedAt ? new Date(ws.archivedAt) : null;
    let period: string;

    if (!archivedDate) {
      period = "Unknown";
    } else if (archivedDate >= today) {
      period = "Today";
    } else if (archivedDate >= yesterday) {
      period = "Yesterday";
    } else if (archivedDate >= lastWeek) {
      period = "This Week";
    } else if (archivedDate >= lastMonth) {
      period = "This Month";
    } else {
      // Group by month/year for older items
      period = archivedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    const existing = groups.get(period) ?? [];
    existing.push(ws);
    groups.set(period, existing);
  }

  return groups;
}

/** Flatten grouped workspaces back to ordered array for index-based selection */
function flattenGrouped(
  grouped: Map<string, FrontendWorkspaceMetadata[]>
): FrontendWorkspaceMetadata[] {
  const result: FrontendWorkspaceMetadata[] = [];
  for (const workspaces of grouped.values()) {
    result.push(...workspaces);
  }
  return result;
}

/**
 * Preserve selection order among peers while ensuring descendants are deleted before parents.
 * This keeps bulk deletion deterministic and prevents the backend's orphan guard from turning a
 * single subtree deletion into a partial operation that needs a second attempt.
 */
function sortWorkspaceIdsDeepestFirst(
  workspaceIds: readonly string[],
  workspaces: readonly FrontendWorkspaceMetadata[]
): string[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const depthById = new Map<string, number>();

  const getDepth = (workspaceId: string, visiting: Set<string>): number => {
    const cached = depthById.get(workspaceId);
    if (cached != null) return cached;
    if (visiting.has(workspaceId)) return 0;

    const workspace = workspaceById.get(workspaceId);
    const parentWorkspaceId = workspace?.parentWorkspaceId;
    if (parentWorkspaceId == null || !workspaceById.has(parentWorkspaceId)) {
      depthById.set(workspaceId, 0);
      return 0;
    }

    visiting.add(workspaceId);
    const depth = Math.min(getDepth(parentWorkspaceId, visiting) + 1, 32);
    visiting.delete(workspaceId);
    depthById.set(workspaceId, depth);
    return depth;
  };

  return workspaceIds
    .map((workspaceId, index) => ({
      workspaceId,
      index,
      depth: getDepth(workspaceId, new Set()),
    }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map(({ workspaceId }) => workspaceId);
}

/** Calculate total cost from a SessionUsageFile by summing all model usages */
function getSessionTotalCost(usage: SessionUsageFile | undefined): number | undefined {
  if (!usage) return undefined;
  const aggregated = sumUsageHistory(Object.values(usage.byModel));
  return getTotalCost(aggregated);
}

/** Cost badge component with size variants for different scopes.
 * Shows a shimmer skeleton while loading to prevent layout flash. */
const CostBadge: React.FC<{
  cost: number | undefined;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}> = ({ cost, loading = false, size = "md", className }) => {
  const sizeStyles = {
    sm: "px-1 py-0.5 text-[10px]",
    md: "px-1.5 py-0.5 text-xs",
    lg: "px-2 py-0.5 text-sm",
  };
  // Skeleton sizes that reserve the same space as a typical cost value (e.g., "$0.12")
  const skeletonSizes = {
    sm: "h-4 w-[5ch]",
    md: "h-5 w-[6ch]",
    lg: "h-6 w-[7ch]",
  };

  // Show skeleton while loading and no cached value available
  if (cost === undefined) {
    if (!loading) return null;
    return (
      <Skeleton
        variant="shimmer"
        className={cn(skeletonSizes[size], sizeStyles[size], className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "text-muted inline-flex items-center rounded bg-white/5 tabular-nums",
        sizeStyles[size],
        className
      )}
    >
      {formatCostWithDollar(cost)}
    </span>
  );
};

/** Progress modal for bulk operations */
const BulkProgressModal: React.FC<{
  operation: BulkOperationState;
  onClose: () => void;
}> = ({ operation, onClose }) => {
  const percentage = Math.round((operation.completed / operation.total) * 100);
  const isComplete = operation.completed === operation.total;
  const actionLabels: Record<
    BulkOperationState["type"],
    { inProgressTitle: string; actionPast: string; itemLabel: string }
  > = {
    restore: {
      inProgressTitle: "Restoring Workspaces",
      actionPast: "restored",
      itemLabel: "workspace",
    },
    delete: {
      inProgressTitle: "Deleting Workspaces",
      actionPast: "deleted",
      itemLabel: "workspace",
    },
    deleteWorktree: {
      inProgressTitle: "Deleting Managed Worktrees",
      actionPast: "deleted",
      itemLabel: "managed worktree",
    },
  };
  const labels = actionLabels[operation.type];

  return (
    <Dialog open onOpenChange={(open) => !open && isComplete && onClose()}>
      <DialogContent maxWidth="400px" showCloseButton={isComplete}>
        <DialogHeader>
          <DialogTitle>{isComplete ? "Complete" : labels.inProgressTitle}</DialogTitle>
          <DialogDescription>
            {isComplete ? (
              <>
                Successfully {labels.actionPast} {operation.completed} {labels.itemLabel}
                {operation.completed !== 1 && "s"}
                {operation.errors.length > 0 && ` (${operation.errors.length} failed)`}
              </>
            ) : (
              <>
                {operation.completed} of {operation.total} complete
                {operation.current && <> — {operation.current}</>}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Progress bar */}
        <div className="bg-separator h-2 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full transition-all duration-300",
              operation.type === "restore" ? "bg-green-500" : "bg-red-500"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Errors */}
        {operation.errors.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded bg-red-500/10 p-2 text-xs text-red-400">
            {operation.errors.map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        )}

        {isComplete && (
          <DialogFooter className="justify-center">
            <Button variant="secondary" onClick={onClose} className="w-full">
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Section showing archived workspaces for a project.
 * Appears on the project page when there are archived workspaces.
 */
export const ArchivedWorkspaces: React.FC<ArchivedWorkspacesProps> = ({
  projectPath: _projectPath,
  projectName: _projectName,
  workspaces,
  onWorkspacesChanged,
}) => {
  const [isExpanded, setIsExpanded] = usePersistedState(
    getArchivedWorkspacesExpandedKey(_projectPath),
    false
  );
  const archivedRegionId = React.useId();

  const { unarchiveWorkspace, removeWorkspace, setSelectedWorkspace } = useWorkspaceContext();
  const { api } = useAPI();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [processingIds, setProcessingIds] = React.useState<Set<string>>(new Set());
  const [deleteWorktreeIds, setDeleteWorktreeIds] = React.useState<Set<string>>(new Set());
  const [forceDeleteModal, setForceDeleteModal] = React.useState<{
    workspaceId: string;
    error: string;
  } | null>(null);
  const deleteWorktreeError = usePopoverError();
  const unarchiveError = usePopoverError();

  // Bulk selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null);
  const [bulkOperation, setBulkOperation] = React.useState<BulkOperationState | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState(false);

  const handleToggleExpanded = () => {
    setIsExpanded((prev) => {
      const next = !prev;

      // Clear selection when collapsing so hidden items can't be bulk-acted later.
      if (!next) {
        setSelectedIds(new Set());
        setLastClickedId(null);
        setBulkDeleteConfirm(false);
      }

      return next;
    });
  };

  // Cost data with optimistic caching - shows cached costs immediately, fetches fresh in background
  const workspaceIds = React.useMemo(() => workspaces.map((w) => w.id), [workspaces]);

  // Memoize fetchBatch so the hook doesn't refetch on every local state change.
  const fetchWorkspaceCosts = React.useCallback(
    async (ids: string[]) => {
      if (!api) return {};

      const usageData = await api.workspace.getSessionUsageBatch({ workspaceIds: ids });

      // Compute costs from usage data and return as record
      const costs: Record<string, number | undefined> = {};
      for (const id of ids) {
        costs[id] = getSessionTotalCost(usageData[id]);
      }
      return costs;
    },
    [api]
  );

  const { values: costsByWorkspace, status: costsStatus } = useOptimisticBatchLRU({
    keys: workspaceIds,
    cache: sessionCostCache,
    skip: !api,
    fetchBatch: fetchWorkspaceCosts,
  });
  const costsLoading = costsStatus === "idle" || costsStatus === "loading";

  // Filter workspaces by search query (frontend-only)
  const filteredWorkspaces = searchQuery.trim()
    ? workspaces.filter((ws) => {
        const query = searchQuery.toLowerCase();
        const title = (ws.title ?? ws.name).toLowerCase();
        const name = ws.name.toLowerCase();
        return title.includes(query) || name.includes(query);
      })
    : workspaces;

  const groupedWorkspaces = groupByTimePeriod(filteredWorkspaces);
  const flatWorkspaces = flattenGrouped(groupedWorkspaces);

  // Calculate total cost and per-period costs from cached/fetched values
  const totalCost = React.useMemo(() => {
    let sum = 0;
    let hasCost = false;
    for (const ws of workspaces) {
      const cost = costsByWorkspace[ws.id];
      if (cost !== undefined) {
        sum += cost;
        hasCost = true;
      }
    }
    return hasCost ? sum : undefined;
  }, [workspaces, costsByWorkspace]);

  const periodCosts = React.useMemo(() => {
    const costs = new Map<string, number | undefined>();
    for (const [period, periodWorkspaces] of groupedWorkspaces) {
      let sum = 0;
      let hasCost = false;
      for (const ws of periodWorkspaces) {
        const cost = costsByWorkspace[ws.id];
        if (cost !== undefined) {
          sum += cost;
          hasCost = true;
        }
      }
      costs.set(period, hasCost ? sum : undefined);
    }
    return costs;
  }, [groupedWorkspaces, costsByWorkspace]);

  // workspaces prop should already be filtered to archived only
  if (workspaces.length === 0) {
    return null;
  }

  // Handle checkbox click with shift-click range selection
  const handleCheckboxClick = (workspaceId: string, event: React.MouseEvent) => {
    const isShiftClick = event.shiftKey;

    setSelectedIds((prev) => {
      const next = new Set(prev);

      if (isShiftClick && lastClickedId) {
        // Range selection
        const lastIndex = flatWorkspaces.findIndex((w) => w.id === lastClickedId);
        const currentIndex = flatWorkspaces.findIndex((w) => w.id === workspaceId);

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);

          for (let i = start; i <= end; i++) {
            next.add(flatWorkspaces[i].id);
          }
        }
      } else {
        // Toggle single selection
        if (next.has(workspaceId)) {
          next.delete(workspaceId);
        } else {
          next.add(workspaceId);
        }
      }

      return next;
    });

    setLastClickedId(workspaceId);
    setBulkDeleteConfirm(false); // Clear confirmation when selection changes
  };

  // Select/deselect all filtered workspaces
  const handleSelectAll = () => {
    const allFilteredIds = new Set(filteredWorkspaces.map((w) => w.id));
    const allSelected = filteredWorkspaces.every((w) => selectedIds.has(w.id));

    if (allSelected) {
      // Deselect all filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      setSelectedIds((prev) => new Set([...prev, ...allFilteredIds]));
    }
    setBulkDeleteConfirm(false); // Clear confirmation when selection changes
  };

  const handleBulkRestore = async () => {
    const idsToRestore = Array.from(selectedIds);
    setBulkOperation({
      type: "restore",
      total: idsToRestore.length,
      completed: 0,
      current: null,
      errors: [],
    });

    for (let i = 0; i < idsToRestore.length; i++) {
      const id = idsToRestore[i];
      const ws = workspaces.find((w) => w.id === id);
      setBulkOperation((prev) => (prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev));

      try {
        const result = await unarchiveWorkspace(id);
        if (!result.success) {
          setBulkOperation((prev) =>
            prev
              ? {
                  ...prev,
                  errors: [
                    ...prev.errors,
                    `Failed to restore ${ws?.name ?? id}${result.error ? `: ${result.error}` : ""}`,
                  ],
                }
              : prev
          );
        }
      } catch {
        setBulkOperation((prev) =>
          prev ? { ...prev, errors: [...prev.errors, `Failed to restore ${ws?.name ?? id}`] } : prev
        );
      }

      setBulkOperation((prev) => (prev ? { ...prev, completed: i + 1 } : prev));
    }

    setSelectedIds(new Set());
    onWorkspacesChanged?.();
  };

  // Bulk delete (always force: true) - requires confirmation
  const handleBulkDelete = async () => {
    setBulkDeleteConfirm(false);
    const idsToDelete = sortWorkspaceIdsDeepestFirst(Array.from(selectedIds), workspaces);
    setBulkOperation({
      type: "delete",
      total: idsToDelete.length,
      completed: 0,
      current: null,
      errors: [],
    });

    for (let i = 0; i < idsToDelete.length; i++) {
      const id = idsToDelete[i];
      const ws = workspaces.find((w) => w.id === id);
      setBulkOperation((prev) => (prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev));

      try {
        const result = await removeWorkspace(id, { force: true });
        if (!result.success) {
          setBulkOperation((prev) =>
            prev
              ? {
                  ...prev,
                  errors: [
                    ...prev.errors,
                    `Failed to delete ${ws?.name ?? id}${result.error ? `: ${result.error}` : ""}`,
                  ],
                }
              : prev
          );
        }
      } catch {
        setBulkOperation((prev) =>
          prev ? { ...prev, errors: [...prev.errors, `Failed to delete ${ws?.name ?? id}`] } : prev
        );
      }

      setBulkOperation((prev) => (prev ? { ...prev, completed: i + 1 } : prev));
    }

    setSelectedIds(new Set());
    onWorkspacesChanged?.();
  };

  const handleUnarchive = async (workspaceId: string, anchorEl?: HTMLElement) => {
    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await unarchiveWorkspace(workspaceId);
      if (result.success) {
        // Select the workspace after unarchiving
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          setSelectedWorkspace({
            workspaceId: workspace.id,
            projectPath: workspace.projectPath,
            projectName: workspace.projectName,
            namedWorkspacePath: workspace.namedWorkspacePath,
          });
        }
        onWorkspacesChanged?.();
        return;
      }

      if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        unarchiveError.showError(workspaceId, result.error ?? "Failed to restore workspace", {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        });
      } else {
        unarchiveError.showError(workspaceId, result.error ?? "Failed to restore workspace");
      }
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const handleBulkDeleteWorktree = async () => {
    if (!api) {
      return;
    }

    const idsToDeleteWorktree = Array.from(selectedIds).filter((id) => {
      const workspace = workspaces.find((candidate) => candidate.id === id);
      return workspace ? canDeleteManagedWorktree(workspace) : false;
    });
    if (idsToDeleteWorktree.length === 0) {
      return;
    }

    setBulkOperation({
      type: "deleteWorktree",
      total: idsToDeleteWorktree.length,
      completed: 0,
      current: null,
      errors: [],
    });

    for (let i = 0; i < idsToDeleteWorktree.length; i++) {
      const id = idsToDeleteWorktree[i];
      const ws = workspaces.find((workspace) => workspace.id === id);
      setBulkOperation((prev) => (prev ? { ...prev, current: ws?.title ?? ws?.name ?? id } : prev));
      setProcessingIds((prev) => new Set(prev).add(id));
      setDeleteWorktreeIds((prev) => new Set(prev).add(id));

      try {
        const result = await api.workspace.deleteWorktree({ workspaceId: id });
        if (!result.success) {
          setBulkOperation((prev) =>
            prev
              ? {
                  ...prev,
                  errors: [
                    ...prev.errors,
                    `Failed to delete managed worktree for ${ws?.name ?? id}${result.error ? `: ${result.error}` : ""}`,
                  ],
                }
              : prev
          );
        }
      } catch {
        setBulkOperation((prev) =>
          prev
            ? {
                ...prev,
                errors: [...prev.errors, `Failed to delete managed worktree for ${ws?.name ?? id}`],
              }
            : prev
        );
      } finally {
        setDeleteWorktreeIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }

      setBulkOperation((prev) => (prev ? { ...prev, completed: i + 1 } : prev));
    }

    setSelectedIds(new Set());
    onWorkspacesChanged?.();
  };

  const handleDeleteWorktree = async (workspaceId: string, anchorEl?: HTMLElement) => {
    const rect = anchorEl?.getBoundingClientRect();
    const anchor = rect ? { top: rect.top + window.scrollY, left: rect.right + 10 } : undefined;

    if (!api) {
      deleteWorktreeError.showError(workspaceId, "Not connected to server", anchor);
      return;
    }

    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    setDeleteWorktreeIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await api.workspace.deleteWorktree({ workspaceId });
      if (result.success) {
        onWorkspacesChanged?.();
        return;
      }

      deleteWorktreeError.showError(
        workspaceId,
        result.error ?? "Failed to delete managed worktree",
        anchor
      );
    } catch (error) {
      deleteWorktreeError.showError(workspaceId, getErrorMessage(error), anchor);
    } finally {
      setDeleteWorktreeIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const handleDelete = async (workspaceId: string, options?: { bypassForceConfirm?: boolean }) => {
    setProcessingIds((prev) => new Set(prev).add(workspaceId));
    try {
      const result = await removeWorkspace(workspaceId);
      if (result.success) {
        onWorkspacesChanged?.();
        return;
      }

      // Shift-click: skip force-delete confirmation, auto-force immediately.
      if (options?.bypassForceConfirm) {
        const forced = await removeWorkspace(workspaceId, { force: true });
        if (forced.success) {
          onWorkspacesChanged?.();
          return;
        }

        // Force delete also failed — fall through to show modal with the error.
        setForceDeleteModal({
          workspaceId,
          error: forced.error ?? result.error ?? "Failed to remove workspace",
        });
        return;
      }

      setForceDeleteModal({
        workspaceId,
        error: result.error ?? "Failed to remove workspace",
      });
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const hasSelection = selectedIds.size > 0;
  const hasBulkDeleteWorktreeSelection = workspaces.some(
    (workspace) => selectedIds.has(workspace.id) && canDeleteManagedWorktree(workspace)
  );
  const allFilteredSelected =
    filteredWorkspaces.length > 0 && filteredWorkspaces.every((w) => selectedIds.has(w.id));

  return (
    <>
      {/* Bulk operation progress modal */}

      <ForceDeleteModal
        isOpen={forceDeleteModal !== null}
        workspaceId={forceDeleteModal?.workspaceId ?? ""}
        error={forceDeleteModal?.error ?? ""}
        onClose={() => setForceDeleteModal(null)}
        onForceDelete={async (workspaceId) => {
          const result = await removeWorkspace(workspaceId, { force: true });
          if (!result.success) {
            throw new Error(result.error ?? "Force delete failed");
          }
          onWorkspacesChanged?.();
        }}
      />
      <PopoverError
        error={unarchiveError.error}
        prefix="Failed to restore workspace"
        onDismiss={unarchiveError.clearError}
      />
      <PopoverError
        error={deleteWorktreeError.error}
        prefix="Failed to delete managed worktree"
        onDismiss={deleteWorktreeError.clearError}
      />
      {bulkOperation && (
        <BulkProgressModal operation={bulkOperation} onClose={() => setBulkOperation(null)} />
      )}

      <div className="border-border rounded-lg border">
        {/* Header with bulk actions */}
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={handleToggleExpanded}
            className="text-muted hover:text-foreground rounded p-1 transition-colors hover:bg-white/10"
            aria-label={isExpanded ? "Collapse archived workspaces" : "Expand archived workspaces"}
            aria-expanded={isExpanded}
            aria-controls={archivedRegionId}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          <ArchiveIcon className="text-muted h-4 w-4" />
          <span className="text-foreground font-medium">
            Archived Workspaces ({workspaces.length})
          </span>
          <CostBadge cost={totalCost} loading={costsLoading} size="lg" />
          <span className="flex-1" />
          {isExpanded && hasSelection && (
            <div className="flex items-center gap-2">
              <span className="text-muted text-xs">{selectedIds.size} selected</span>
              {bulkDeleteConfirm ? (
                <>
                  <span className="text-muted text-xs">
                    Delete permanently (also deletes local branches)?
                  </span>
                  <button
                    onClick={() => void handleBulkDelete()}
                    className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                  >
                    Yes, delete {selectedIds.size}
                  </button>
                  <button
                    onClick={() => setBulkDeleteConfirm(false)}
                    className="text-muted hover:text-foreground text-xs"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => void handleBulkRestore()}
                        className="text-muted hover:text-foreground rounded p-1 transition-colors hover:bg-white/10"
                        aria-label="Restore selected"
                      >
                        <ArchiveRestoreIcon className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Restore selected</TooltipContent>
                  </Tooltip>
                  {hasBulkDeleteWorktreeSelection && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => void handleBulkDeleteWorktree()}
                          className="text-muted rounded p-1 transition-colors hover:bg-white/10 hover:text-orange-300"
                          aria-label="Remove local checkouts for selected"
                        >
                          <FolderX className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Remove local checkouts</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setBulkDeleteConfirm(true)}
                        className="text-muted rounded p-1 transition-colors hover:bg-white/10 hover:text-red-400"
                        aria-label="Delete selected"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Delete selected permanently (local branches too)
                    </TooltipContent>
                  </Tooltip>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-muted hover:text-foreground ml-1 text-xs"
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {isExpanded && (
          <div
            id={archivedRegionId}
            role="region"
            aria-label="Archived workspaces"
            className="border-border border-t"
          >
            {/* Search input with select all */}
            {workspaces.length > 1 && (
              <div className="border-border flex items-center gap-2 border-b px-4 py-2">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={handleSelectAll}
                  className="h-4 w-4 rounded border-gray-600 bg-transparent"
                  aria-label="Select all"
                />
                {workspaces.length > 3 && (
                  <div className="relative flex-1">
                    <Search className="text-muted pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search archived workspaces or branches..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-bg-dark placeholder:text-muted text-foreground focus:border-border-light w-full rounded border border-transparent py-1.5 pr-3 pl-8 text-sm focus:outline-none"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Timeline grouped list */}
            <div>
              {filteredWorkspaces.length === 0 ? (
                <div className="text-muted px-4 py-6 text-center text-sm">
                  No workspaces match {`"${searchQuery}"`}
                </div>
              ) : (
                Array.from(groupedWorkspaces.entries()).map(([period, periodWorkspaces]) => (
                  <div key={period}>
                    {/* Period header */}
                    <div className="bg-bg-dark text-muted flex items-center gap-2 px-4 py-1.5 text-xs font-medium">
                      <span>{period}</span>
                      <CostBadge cost={periodCosts.get(period)} loading={costsLoading} />
                    </div>
                    {/* Workspaces in this period */}
                    {periodWorkspaces.map((workspace) => {
                      const isProcessing = processingIds.has(workspace.id) || workspace.isRemoving;
                      const isSelected = selectedIds.has(workspace.id);
                      const workspaceNameForTooltip =
                        workspace.title && workspace.title !== workspace.name
                          ? workspace.name
                          : undefined;
                      const displayTitle = workspace.title ?? workspace.name;
                      const canDeleteWorktree = canDeleteManagedWorktree(workspace);
                      const isDeletingWorktree = deleteWorktreeIds.has(workspace.id);

                      return (
                        <div
                          key={workspace.id}
                          className={cn(
                            "border-border flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0",
                            isProcessing && "opacity-50",
                            isSelected && "bg-white/5"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onClick={(e) => handleCheckboxClick(workspace.id, e)}
                            onChange={() => undefined} // Controlled by onClick for shift-click support
                            className="h-4 w-4 rounded border-gray-600 bg-transparent"
                            aria-label={`Select ${displayTitle}`}
                          />
                          <RuntimeBadge
                            runtimeConfig={workspace.runtimeConfig}
                            isWorking={false}
                            workspacePath={workspace.namedWorkspacePath}
                            workspaceName={workspaceNameForTooltip}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground truncate text-sm font-medium">
                              {displayTitle}
                            </div>
                            <div className="flex items-center gap-2">
                              {workspace.archivedAt && (
                                <span className="text-muted text-xs">
                                  {new Date(workspace.archivedAt).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                              <CostBadge
                                cost={costsByWorkspace[workspace.id]}
                                loading={costsLoading}
                                size="sm"
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={(event) =>
                                    void handleUnarchive(workspace.id, event.currentTarget)
                                  }
                                  disabled={isProcessing}
                                  className="text-muted hover:text-foreground rounded p-1.5 transition-colors hover:bg-white/10 disabled:opacity-50"
                                  aria-label={`Restore workspace ${displayTitle}`}
                                >
                                  <ArchiveRestoreIcon className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>Restore to sidebar</TooltipContent>
                            </Tooltip>
                            {canDeleteWorktree && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={(event) =>
                                      void handleDeleteWorktree(workspace.id, event.currentTarget)
                                    }
                                    disabled={isProcessing}
                                    className="text-muted rounded p-1.5 transition-colors hover:bg-white/10 hover:text-orange-300 disabled:opacity-50"
                                    aria-label={`Remove local checkout for workspace ${displayTitle}`}
                                  >
                                    {isDeletingWorktree ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <FolderX className="h-4 w-4" />
                                    )}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>Remove local checkout</TooltipContent>
                              </Tooltip>
                            )}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={(event) =>
                                    void handleDelete(workspace.id, {
                                      bypassForceConfirm: event.shiftKey,
                                    })
                                  }
                                  disabled={isProcessing}
                                  className="text-muted rounded p-1.5 transition-colors hover:bg-white/10 hover:text-red-400 disabled:opacity-50"
                                  aria-label={`Delete workspace ${displayTitle}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>Delete permanently (local branch too)</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};
