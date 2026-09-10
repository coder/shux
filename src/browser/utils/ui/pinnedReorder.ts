import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { isMultiProject } from "@/common/utils/multiProject";
import { isWorkspacePinned, recomposePinnedOrder } from "@/common/utils/pin";
import { getSubProjectsForParent } from "@/common/utils/subProjects";
import {
  orderMultiProjectSectionRows,
  partitionWorkspacesBySection,
  resolveEffectiveSectionId,
} from "./workspaceFiltering";

/** Single definitions for the reorder unions shared by DnD, keybind, and palette code. */
export type PinnedMoveDirection = "up" | "down";
export type PinnedDropEdge = "before" | "after";

/**
 * Flat-mode block options, mirroring the sidebar's render gates so the
 * reorder block never contains rows the user cannot see (a move would
 * otherwise swap with an invisible row and appear to do nothing).
 */
export interface FlatPinnedBlockOptions {
  /** The multi-project experiment gate applied to the flat chat list. */
  multiProjectEnabled: boolean;
}

/**
 * A workspace's pinned surroundings, both in displayed order:
 * - `fullOrder`: every pinned id of its config bucket. Reorder requests always
 *   send the full bucket order so the backend never has to guess scope.
 * - `blockIds`: pinned ids of its own visual block (sections partition the
 *   sorted list, so each partition renders its own pinned block). Reorder UX
 *   moves rows within one block only.
 */
export interface PinnedBlock {
  fullOrder: string[];
  blockIds: string[];
}

/**
 * Multi-project and scratch rows each render as one flat section regardless of
 * which bucket they came from. Rows are re-sorted with the same helper the
 * sidebar uses so the resolved block order always matches the rendered order,
 * even when rows were collected from different primary-project buckets.
 */
function collectFlatSectionRows(
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>,
  includeRow: (row: FrontendWorkspaceMetadata) => boolean
): FrontendWorkspaceMetadata[] {
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const rows of sortedWorkspacesByProject.values()) {
    for (const row of rows) {
      if (includeRow(row)) {
        byId.set(row.id, row);
      }
    }
  }
  return orderMultiProjectSectionRows(Array.from(byId.values()));
}

/**
 * Resolve the pinned block containing `meta`, mirroring the sidebar renderer:
 * multi-project rows form one flat block; regular rows partition by their
 * effective section. In flat sidebar mode all pinned roots instead form one
 * unified block across projects. Returns null when the workspace is not a
 * rendered pinned row (unpinned, or missing from the sorted map).
 */
export function locatePinnedBlock(
  meta: FrontendWorkspaceMetadata,
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>,
  userProjects: Map<string, ProjectConfig>,
  flatMode: FlatPinnedBlockOptions | false = false
): PinnedBlock | null {
  if (!isWorkspacePinned(meta)) return null;

  if (flatMode !== false) {
    const pinnedIds = collectFlatSectionRows(
      sortedWorkspacesByProject,
      (row) => flatMode.multiProjectEnabled || !isMultiProject(row)
    )
      .filter((row) => row.parentWorkspaceId == null && isWorkspacePinned(row))
      .map((row) => row.id);
    if (!pinnedIds.includes(meta.id)) return null;
    return { fullOrder: pinnedIds, blockIds: pinnedIds };
  }

  // Scratch chats render as one flat "Chats" section, but each row's
  // projectPath is its own app-managed workdir, so the per-projectPath
  // partitioning below would isolate every row into a block of one and
  // swallow reorders. Treat them like the multi-project section instead.
  if (meta.kind === "scratch") {
    const pinnedIds = collectFlatSectionRows(
      sortedWorkspacesByProject,
      (row) => row.kind === "scratch"
    )
      .filter(isWorkspacePinned)
      .map((row) => row.id);
    if (!pinnedIds.includes(meta.id)) return null;
    return { fullOrder: pinnedIds, blockIds: pinnedIds };
  }

  if (isMultiProject(meta)) {
    const pinnedIds = collectFlatSectionRows(sortedWorkspacesByProject, isMultiProject)
      .filter(isWorkspacePinned)
      .map((row) => row.id);
    if (!pinnedIds.includes(meta.id)) return null;
    return { fullOrder: pinnedIds, blockIds: pinnedIds };
  }

  const rows = sortedWorkspacesByProject.get(meta.projectPath) ?? [];
  const fullOrder = rows.filter(isWorkspacePinned).map((row) => row.id);
  if (!fullOrder.includes(meta.id)) return null;

  const sections = getSubProjectsForParent(meta.projectPath, userProjects).map(
    ([subProjectPath]) => ({ id: subProjectPath })
  );
  const { unsectioned, bySectionId } = partitionWorkspacesBySection(rows, sections);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sectionIds = new Set(sections.map((section) => section.id));
  const effectiveSectionId = resolveEffectiveSectionId(meta, byId, sectionIds);
  const partitionRows = effectiveSectionId
    ? (bySectionId.get(effectiveSectionId) ?? [])
    : unsectioned;
  const blockIds = partitionRows.filter(isWorkspacePinned).map((row) => row.id);
  return { fullOrder, blockIds };
}

/**
 * Full new pinned order (for the whole bucket) after moving `workspaceId` one
 * step up/down within its block. Null when the move is a no-op (not in the
 * block, or already at the edge).
 */
export function computePinnedMoveOrder(
  block: PinnedBlock,
  workspaceId: string,
  direction: PinnedMoveDirection
): string[] | null {
  const index = block.blockIds.indexOf(workspaceId);
  if (index === -1) return null;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= block.blockIds.length) return null;
  const reordered = [...block.blockIds];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return recomposePinnedOrder(block.fullOrder, block.blockIds, reordered);
}

/**
 * Locate `meta`'s pinned block and compute the order after moving it one step.
 * Shared by the sidebar keybind and palette handlers so their behavior cannot
 * drift. Null when the workspace is not a rendered pinned row or the move is a
 * no-op.
 */
export function computePinnedMoveOrderForWorkspace(
  meta: FrontendWorkspaceMetadata,
  direction: PinnedMoveDirection,
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>,
  userProjects: Map<string, ProjectConfig>,
  flatMode: FlatPinnedBlockOptions | false = false
): string[] | null {
  const block = locatePinnedBlock(meta, sortedWorkspacesByProject, userProjects, flatMode);
  if (!block) return null;
  return computePinnedMoveOrder(block, meta.id, direction);
}

/**
 * Full new pinned order after dropping `draggedId` onto the before/after edge
 * of `targetId` within the same block. Null when nothing would change.
 */
export function computePinnedDropOrder(
  block: PinnedBlock,
  draggedId: string,
  targetId: string,
  edge: PinnedDropEdge
): string[] | null {
  if (draggedId === targetId) return null;
  if (!block.blockIds.includes(draggedId)) return null;
  const without = block.blockIds.filter((id) => id !== draggedId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex === -1) return null;
  const insertAt = edge === "before" ? targetIndex : targetIndex + 1;
  const reordered = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
  if (reordered.every((id, i) => id === block.blockIds[i])) return null;
  return recomposePinnedOrder(block.fullOrder, block.blockIds, reordered);
}
