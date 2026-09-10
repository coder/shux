import React, { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import XumLogoDark from "@/browser/assets/logos/xum-logo-dark.svg?react";
import XumLogoLight from "@/browser/assets/logos/xum-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useDebouncedValue } from "@/browser/hooks/useDebouncedValue";
import { useRuntimeStatusStoreRaw } from "@/browser/stores/RuntimeStatusStore";
import { useWorkspaceStoreRaw, type WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  EXPANDED_PROJECTS_KEY,
  MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY,
  SIDEBAR_AGE_GROUPING_KEY,
  SIDEBAR_FLAT_MODE_KEY,
  SIDEBAR_HIDE_SUBAGENTS_KEY,
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getWorkspaceLastReadKey,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import { getDisplayTitleFromPersistedState } from "@/browser/hooks/useWorkspaceName";
import { DndProvider } from "react-dnd";
import { HTML5Backend, getEmptyImage } from "react-dnd-html5-backend";
import { useDrag, useDrop, useDragLayer } from "react-dnd";
import {
  sortProjectsByOrder,
  reorderProjects,
  normalizeOrder,
} from "@/common/utils/projectOrdering";
import { PROJECT_ORDER_KEY } from "@/common/constants/storage";
import {
  matchesKeybind,
  formatKeybind,
  isEditableElement,
  KEYBINDS,
} from "@/browser/utils/ui/keybinds";
import { useAPI } from "@/browser/contexts/API";
import {
  CUSTOM_EVENTS,
  getStorageChangeEvent,
  type CustomEventType,
} from "@/common/constants/events";
import { PlatformPaths } from "@/common/utils/paths";
import {
  partitionWorkspacesByAge,
  buildSortedWorkspacesFlat,
  partitionWorkspacesBySection,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
  computeWorkspaceDepthMap,
  computeDelegatedActivityByWorkspaceId,
  computeSubAgentsSummaryByWorkspaceId,
  excludeSubAgentRows,
  filterVisibleAgentRows,
  type WorkspaceSubAgentsSummary,
  computeAgentRowRenderMeta,
  findNextNonEmptyTier,
  getTierKey,
  getSectionExpandedKey,
  getSectionTierKey,
  orderMultiProjectSectionRows,
  resolveEffectiveSectionId,
  isSidebarSubAgentRunning,
  computeRowMetaForVisibleNodes,
  type AgentRowRenderMeta,
  type SidebarVisibleRowNode,
} from "@/browser/utils/ui/workspaceFiltering";
import {
  computePinnedDropOrder,
  computePinnedMoveOrderForWorkspace,
  locatePinnedBlock,
  type PinnedDropEdge,
  type PinnedMoveDirection,
} from "@/browser/utils/ui/pinnedReorder";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { SidebarCollapseButton } from "../SidebarCollapseButton/SidebarCollapseButton";
import { ConfirmationModal } from "../ConfirmationModal/ConfirmationModal";
import {
  buildArchiveConfirmDescription,
  buildArchiveConfirmWarning,
} from "@/browser/utils/archiveConfirmation";
import { ProjectDeleteConfirmationModal } from "../ProjectDeleteConfirmationModal/ProjectDeleteConfirmationModal";
import { useSettings } from "@/browser/contexts/SettingsContext";

import { AgentListItem, type WorkspaceSelection } from "../AgentListItem/AgentListItem";
import { SubAgentListItem } from "../AgentListItem/SubAgentListItem";
import {
  getAncestorRailX,
  getSubAgentChildStatusCenterX,
  getSubAgentParentRailX,
  getTaskGroupMemberDepth,
} from "../sidebarItemLayout";
import { TaskGroupListItem } from "./TaskGroupListItem";
import {
  collectActiveWorkflowGroupKeys,
  computeSidebarTaskGroups,
  computeTaskGroupMemberRowMeta,
  type SidebarTaskGroupModel,
} from "./sidebarTaskGroups";
import { TitleEditProvider, useTitleEdit } from "@/browser/contexts/WorkspaceTitleEditContext";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import {
  PositionedMenu,
  PositionedMenuItem,
} from "@/browser/components/PositionedMenu/PositionedMenu";
import {
  ChevronRight,
  EllipsisVertical,
  Folder,
  FolderOpen,
  KeyRound,
  Palette,
  Pencil,
  ScrollText,
  Trash,
  Plus,
} from "lucide-react";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import { PopoverError } from "../PopoverError/PopoverError";
import { SectionHeader } from "../SectionHeader/SectionHeader";
import { WorkspaceSectionDropZone } from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import { WorkspaceDragLayer } from "../WorkspaceDragLayer/WorkspaceDragLayer";
import { Separator } from "../Separator/Separator";
import { ScrollArea } from "../ScrollArea/ScrollArea";
import { getProjectDisplayName, getSubProjectsForParent } from "@/common/utils/subProjects";
import { getErrorMessage } from "@/common/utils/errors";
import { isMultiProject } from "@/common/utils/multiProject";
import { isWorkspacePinnable, isWorkspacePinned } from "@/common/utils/pin";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_SIDEBAR_SECTION_ID } from "@/common/constants/scratch";
import {
  MULTI_PROJECT_CONFIG_KEY,
  MULTI_PROJECT_SIDEBAR_SECTION_ID,
} from "@/common/constants/multiProject";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { HexColorPicker } from "react-colorful";
import { resolveSectionColor, SECTION_COLOR_PALETTE } from "@/common/constants/ui";

interface SectionConfig {
  id: string;
  name: string;
  color?: string;
}

/**
 * Pinned rows drag-reorder only within their visual block. Regular rows group
 * by project + section (NUL separator: cannot appear in paths); multi-project
 * rows share one flat section, so they get a single sentinel group regardless
 * of each row's primary projectPath.
 */
function getPinnedReorderGroup(projectPath: string, sectionId: string | undefined): string {
  return `${projectPath}\u0000${sectionId ?? ""}`;
}
const SCRATCH_PINNED_REORDER_GROUP = "\u0000scratch";
const MULTI_PROJECT_PINNED_REORDER_GROUP = "\u0000multi-project";
const FLAT_PINNED_REORDER_GROUP = "\u0000flat";

// Stable reference so hide-mode rows without descendants don't get a fresh
// object per render.
const EMPTY_HIDDEN_SUBAGENTS_SUMMARY: WorkspaceSubAgentsSummary = {
  subAgentCount: 0,
  runningSubAgentCount: 0,
  queuedSubAgentCount: 0,
  runningWorkflowRunCount: 0,
  queuedWorkflowRunCount: 0,
  runningWorkflowAgentCount: 0,
  queuedWorkflowAgentCount: 0,
  workflowRunIds: new Set<string>(),
};

// Re-export WorkspaceSelection for backwards compatibility
export type { WorkspaceSelection } from "../AgentListItem/AgentListItem";

// Draggable project item moved to module scope to avoid remounting on every parent render.
// Defining components inside another component causes a new function identity each render,
// which forces React to unmount/remount the subtree. That led to hover flicker and high CPU.

/**
 * Subscribe sidebar-level attention derivation to workspace updates.
 *
 * Project/section highlighting is computed in this parent component, so it must
 * re-render for both:
 * - unread storage writes (localStorage-backed "last read" timestamps)
 * - attention-relevant workspace transitions (streaming, awaiting question, system errors)
 */
interface WorkspaceAttentionSignal {
  isWorking: boolean;
  awaitingUserQuestion: boolean;
  hasSystemError: boolean;
  activeWorkflowRunIdsKey: string;
}

function getWorkspaceAttentionSignal(
  workspaceStore: WorkspaceStore,
  workspaceId: string
): WorkspaceAttentionSignal | null {
  try {
    const sidebarState = workspaceStore.getWorkspaceSidebarState(workspaceId);
    const isWorking =
      (sidebarState.canInterrupt ||
        sidebarState.isStarting ||
        sidebarState.activeWorkflowRunCount > 0 ||
        // An armed background bash monitor keeps the workspace "working" so collapsed
        // project/parent rows don't look idle while it waits to be woken.
        sidebarState.activeBashMonitorCount > 0) &&
      !sidebarState.awaitingUserQuestion;
    return {
      isWorking,
      awaitingUserQuestion: sidebarState.awaitingUserQuestion,
      activeWorkflowRunIdsKey: (sidebarState.activeWorkflowRunIds ?? []).join("\u0000"),
      hasSystemError: sidebarState.lastAbortReason?.reason === "system",
    };
  } catch {
    // Workspace may have been removed while subscriptions are being torn down.
    return null;
  }
}

function didWorkspaceAttentionSignalChange(
  prev: WorkspaceAttentionSignal | undefined,
  next: WorkspaceAttentionSignal
): boolean {
  if (!prev) {
    return true;
  }
  return (
    prev.activeWorkflowRunIdsKey !== next.activeWorkflowRunIdsKey ||
    prev.isWorking !== next.isWorking ||
    prev.awaitingUserQuestion !== next.awaitingUserQuestion ||
    prev.hasSystemError !== next.hasSystemError
  );
}

function useWorkspaceAttentionSubscription(
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>,
  workspaceStore: WorkspaceStore
): void {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const workspaceIds = new Set<string>();
    const workspaceLastReadKeys = new Set<string>();
    for (const workspaces of sortedWorkspacesByProject.values()) {
      for (const workspace of workspaces) {
        workspaceIds.add(workspace.id);
        workspaceLastReadKeys.add(getWorkspaceLastReadKey(workspace.id));
      }
    }

    if (workspaceIds.size === 0 && workspaceLastReadKeys.size === 0) {
      return;
    }

    const bumpVersion = () => {
      setVersion((currentVersion) => currentVersion + 1);
    };
    const attentionSignalsByWorkspaceId = new Map<string, WorkspaceAttentionSignal>();
    for (const workspaceId of workspaceIds) {
      const signal = getWorkspaceAttentionSignal(workspaceStore, workspaceId);
      if (signal) {
        attentionSignalsByWorkspaceId.set(workspaceId, signal);
      }
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key && workspaceLastReadKeys.has(event.key)) {
        bumpVersion();
      }
    };

    const unsubscribeWorkspaceStore = Array.from(workspaceIds.values()).map((workspaceId) =>
      workspaceStore.subscribeKey(workspaceId, () => {
        const nextSignal = getWorkspaceAttentionSignal(workspaceStore, workspaceId);
        if (!nextSignal) {
          return;
        }

        const previousSignal = attentionSignalsByWorkspaceId.get(workspaceId);
        if (!didWorkspaceAttentionSignalChange(previousSignal, nextSignal)) {
          return;
        }

        attentionSignalsByWorkspaceId.set(workspaceId, nextSignal);
        bumpVersion();
      })
    );
    window.addEventListener("storage", handleStorage);
    for (const key of workspaceLastReadKeys) {
      window.addEventListener(getStorageChangeEvent(key), bumpVersion);
    }

    return () => {
      for (const unsubscribe of unsubscribeWorkspaceStore) {
        unsubscribe();
      }
      window.removeEventListener("storage", handleStorage);
      for (const key of workspaceLastReadKeys) {
        window.removeEventListener(getStorageChangeEvent(key), bumpVersion);
      }
    };
  }, [sortedWorkspacesByProject, workspaceStore]);
}

// Keep the project header visible while scrolling through long workspace lists.
// Project rows are also drag handles, so disable text selection to avoid
// highlighting the whole sidebar before a reorder gesture locks in.
// pr-2 matches AgentListItem LIST_ITEM_BASE_CLASSES so project kebab aligns with workspace rows.
const PROJECT_ITEM_BASE_CLASS =
  "group sticky top-0 z-30 py-2 pl-2 pr-1 flex select-none items-center border-l-transparent bg-surface-primary transition-colors duration-150";

// Shared classes for the chevron toggle buttons on project/section headers.
const PROJECT_TOGGLE_BUTTON_CLASSES =
  "text-secondary hover:bg-hover hover:border-border-light mr-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 transition-all duration-200";

function getProjectFallbackLabel(projectPath: string): string {
  const abbreviatedPath = PlatformPaths.abbreviate(projectPath);
  const { basename } = PlatformPaths.splitAbbreviated(abbreviatedPath);
  return basename;
}

function getProjectNameFromPath(path: string): string {
  if (!path || typeof path !== "string") {
    return "Unknown";
  }
  return PlatformPaths.getProjectName(path);
}

function normalizeDisplayNameInput(value: string): string | null {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function getProjectItemClassName(opts: {
  isDragging: boolean;
  isOver: boolean;
  selected: boolean;
}): string {
  return cn(
    PROJECT_ITEM_BASE_CLASS,
    opts.isDragging ? "cursor-grabbing opacity-35 [&_*]:!cursor-grabbing" : "cursor-grab",
    opts.isOver && "bg-accent/[0.08]",
    opts.selected && "bg-hover border-l-accent",
    "hover:[&_button]:opacity-100 hover:[&_button]:pointer-events-auto hover:[&_[data-drag-handle]]:opacity-100"
  );
}
type DraggableProjectItemProps = React.PropsWithChildren<{
  projectPath: string;
  onReorder: (draggedPath: string, targetPath: string) => void;
  selected?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  role?: string;
  tabIndex?: number;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-label"?: string;
  "data-project-path"?: string;
}>;

const DraggableProjectItem: React.FC<DraggableProjectItemProps> = ({
  projectPath,
  onReorder,
  children,
  selected,
  ...rest
}) => {
  const [{ isDragging }, drag, dragPreview] = useDrag(
    () => ({
      type: "PROJECT",
      item: { type: "PROJECT" as const, projectPath },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [projectPath]
  );

  // Hide native drag preview; we render a custom preview via DragLayer
  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  const [{ isOver }, drop] = useDrop(
    () => ({
      accept: "PROJECT",
      drop: (item: { projectPath: string }) => {
        if (item.projectPath !== projectPath) {
          onReorder(item.projectPath, projectPath);
        }
      },
      collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) }),
    }),
    [projectPath, onReorder]
  );

  return (
    <div
      ref={(node) => drag(drop(node))}
      className={getProjectItemClassName({
        isDragging,
        isOver,
        selected: !!selected,
      })}
      {...rest}
    >
      {children}
    </div>
  );
};

/**
 * Wrapper that fetches draft data from localStorage and renders via unified AgentListItem.
 * Keeps data-fetching logic colocated with sidebar while delegating rendering to shared component.
 */
interface DraftAgentListItemWrapperProps {
  projectPath: string;
  draftId: string;
  draftNumber: number;
  isSelected: boolean;
  sectionId?: string;
  onVisibilityChange?: (isVisible: boolean) => void;
  projectBadgeName?: string;
  projectBadgeColor?: string;
  onOpen: () => void;
  onDelete: () => void;
}

/** Per-row options the coalesced list pipeline passes to a list's row renderer. */
interface CoalescedRowRenderOptions {
  sectionId?: string;
  /** undefined = fall back to the list's base meta; null = render without meta. */
  rowRenderMeta?: AgentRowRenderMeta | null;
  depthOverride?: number;
  keyOverride?: string;
  subAgentConnectorLayout?: "default" | "task-group-member";
  taskGroupHeaderTitle?: string;
}

/** List-specific inputs for the shared coalesced workspace list pipeline. */
interface CoalescedWorkspaceListContext {
  sectionId?: string;
  tierKeyPrefix: string;
  /** Grouped lists indent age-tier toggles to align with folder content. */
  tierButtonClassName?: string;
  depthByWorkspaceId: Record<string, number>;
  baseRowMetaByWorkspaceId: ReadonlyMap<string, AgentRowRenderMeta>;
  renderRow: (
    metadata: FrontendWorkspaceMetadata,
    opts?: CoalescedRowRenderOptions
  ) => React.ReactNode;
}

// Debounce delay for sidebar preview updates during typing.
// Prevents constant re-renders while still providing timely feedback.
const DRAFT_PREVIEW_DEBOUNCE_MS = 1000;

function isDraftVisible(
  projectPath: string,
  draftId: string,
  values?: {
    draftPrompt?: string;
    workspaceNameState?: unknown;
    draftAttachments?: unknown[];
  }
): boolean {
  const scopeId = getDraftScopeId(projectPath, draftId);
  const draftPrompt = values?.draftPrompt ?? readPersistedState<string>(getInputKey(scopeId), "");
  const workspaceNameState =
    values?.workspaceNameState ??
    readPersistedState<unknown>(getWorkspaceNameStateKey(scopeId), null);
  const draftAttachments =
    values?.draftAttachments ?? readPersistedState<unknown[]>(getInputAttachmentsKey(scopeId), []);

  const hasTextContent = typeof draftPrompt === "string" && draftPrompt.trim().length > 0;
  const hasAttachments = Array.isArray(draftAttachments) && draftAttachments.length > 0;
  const hasNameState = workspaceNameState !== null;
  return hasTextContent || hasAttachments || hasNameState;
}

function DraftAgentListItemWrapper(props: DraftAgentListItemWrapperProps) {
  const scopeId = getDraftScopeId(props.projectPath, props.draftId);
  const onVisibilityChange = props.onVisibilityChange;

  const [draftPrompt] = usePersistedState<string>(getInputKey(scopeId), "", {
    listener: true,
  });

  const [workspaceNameState] = usePersistedState<unknown>(getWorkspaceNameStateKey(scopeId), null, {
    listener: true,
  });
  const [draftAttachments] = usePersistedState<unknown[]>(getInputAttachmentsKey(scopeId), [], {
    listener: true,
  });

  // Debounce the preview values to avoid constant sidebar updates while typing.
  const debouncedPrompt = useDebouncedValue(draftPrompt, DRAFT_PREVIEW_DEBOUNCE_MS);
  const debouncedNameState = useDebouncedValue(workspaceNameState, DRAFT_PREVIEW_DEBOUNCE_MS);

  // Keep empty drafts reusable without immediately surfacing them in the sidebar.
  // Show the row when the draft has any user-provided content (typed text,
  // attachments, or workspace-name edits), mirroring the isDraftEmpty() contract
  // so non-empty drafts never become hidden orphans.
  // Uses raw (non-debounced) values so the row appears immediately, while the
  // preview text below still updates at the debounced cadence.
  const isVisible = isDraftVisible(props.projectPath, props.draftId, {
    draftPrompt,
    workspaceNameState,
    draftAttachments: Array.isArray(draftAttachments) ? draftAttachments : [],
  });

  useEffect(() => {
    onVisibilityChange?.(isVisible);
  }, [isVisible, onVisibilityChange]);

  if (!isVisible) {
    return null;
  }

  const workspaceTitle = getDisplayTitleFromPersistedState(debouncedNameState);

  // Collapse whitespace so multi-line prompts show up nicely as a single-line preview.
  const promptPreview =
    typeof debouncedPrompt === "string" ? debouncedPrompt.trim().replace(/\s+/g, " ") : "";

  const titleText = workspaceTitle.trim().length > 0 ? workspaceTitle.trim() : "Draft";

  return (
    <AgentListItem
      variant="draft"
      projectPath={props.projectPath}
      isSelected={props.isSelected}
      sectionId={props.sectionId}
      projectBadgeName={props.projectBadgeName}
      projectBadgeColor={props.projectBadgeColor}
      draft={{
        draftId: props.draftId,
        draftNumber: props.draftNumber,
        title: titleText,
        promptPreview,
        onOpen: props.onOpen,
        onDelete: props.onDelete,
      }}
    />
  );
}

// Custom drag layer to show a semi-transparent preview and enforce grabbing cursor
interface ProjectDragItem {
  type: "PROJECT";
  projectPath: string;
}
const ProjectDragLayer: React.FC = () => {
  const dragState = useDragLayer<{
    isDragging: boolean;
    item: unknown;
    currentOffset: { x: number; y: number } | null;
  }>((monitor) => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    currentOffset: monitor.getClientOffset(),
  }));
  const isDragging = dragState.isDragging;
  const item = dragState.item as ProjectDragItem | null;
  const currentOffset = dragState.currentOffset;

  React.useEffect(() => {
    if (!isDragging) return;
    const originalBody = document.body.style.cursor;
    const originalHtml = document.documentElement.style.cursor;
    document.body.style.cursor = "grabbing";
    document.documentElement.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = originalBody;
      document.documentElement.style.cursor = originalHtml;
    };
  }, [isDragging]);

  if (!isDragging || !currentOffset || !item?.projectPath || item.type !== "PROJECT") return null;

  const abbrevPath = PlatformPaths.abbreviate(item.projectPath);
  const { basename } = PlatformPaths.splitAbbreviated(abbrevPath);

  return (
    <div className="pointer-events-none fixed inset-0 z-9999 cursor-grabbing">
      <div style={{ transform: `translate(${currentOffset.x + 10}px, ${currentOffset.y + 10}px)` }}>
        <div className={cn(PROJECT_ITEM_BASE_CLASS, "w-fit max-w-64 rounded-sm shadow-lg")}>
          <span className="text-secondary mr-2 flex h-5 w-5 shrink-0 items-center justify-center">
            <ChevronRight className="h-4 w-4" />
          </span>
          <div className="flex min-w-0 flex-1 items-center pr-2">
            <span className="text-foreground truncate text-sm font-medium">{basename}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Handles F2 (edit title) and Shift+F2 (generate new title) keybinds.
 * Rendered inside TitleEditProvider so it can access useTitleEdit().
 */
function SidebarTitleEditKeybinds(props: {
  selectedWorkspace: WorkspaceSelection | undefined;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  collapsed: boolean;
}) {
  const { requestEdit, wrapGenerateTitle } = useTitleEdit();
  const { api } = useAPI();

  const regenerateTitleForWorkspace = useCallback(
    (workspaceId: string) => {
      wrapGenerateTitle(workspaceId, () => {
        if (!api) {
          return Promise.resolve({ success: false, error: "Not connected to server" });
        }
        return api.workspace.regenerateTitle({ workspaceId });
      });
    },
    [wrapGenerateTitle, api]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (props.collapsed) return;
      if (!props.selectedWorkspace) return;
      if (isEditableElement(e.target)) return;
      const wsId = props.selectedWorkspace.workspaceId;

      if (matchesKeybind(e, KEYBINDS.EDIT_WORKSPACE_TITLE)) {
        e.preventDefault();
        const meta = props.sortedWorkspacesByProject
          .get(props.selectedWorkspace.projectPath)
          ?.find((m) => m.id === wsId);
        const displayTitle = meta?.title ?? meta?.name ?? "";
        requestEdit(wsId, displayTitle);
      } else if (matchesKeybind(e, KEYBINDS.GENERATE_WORKSPACE_TITLE)) {
        e.preventDefault();
        regenerateTitleForWorkspace(wsId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    props.collapsed,
    props.selectedWorkspace,
    props.sortedWorkspacesByProject,
    requestEdit,
    regenerateTitleForWorkspace,
  ]);

  useEffect(() => {
    const handleGenerateTitleRequest: EventListener = (event) => {
      const customEvent = event as CustomEventType<
        typeof CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED
      >;
      regenerateTitleForWorkspace(customEvent.detail.workspaceId);
    };

    window.addEventListener(
      CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED,
      handleGenerateTitleRequest
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED,
        handleGenerateTitleRequest
      );
    };
  }, [regenerateTitleForWorkspace]);

  return null;
}

interface ProjectSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

function didUntrackedPathSetChange(
  acknowledgedUntrackedPaths: string[],
  latestUntrackedPaths: string[]
): boolean {
  if (acknowledgedUntrackedPaths.length !== latestUntrackedPaths.length) {
    return true;
  }

  const acknowledgedSet = new Set(acknowledgedUntrackedPaths);
  return latestUntrackedPaths.some((path) => !acknowledgedSet.has(path));
}

const ProjectSidebarInner: React.FC<ProjectSidebarProps> = ({
  collapsed,
  onToggleCollapsed,
  sortedWorkspacesByProject,
  workspaceRecency,
}) => {
  // Use the narrow actions context — does NOT subscribe to workspaceMetadata
  // changes, preventing the entire sidebar tree from re-rendering on every
  // workspace create/archive/rename.
  const {
    selectedWorkspace,
    setSelectedWorkspace: onSelectWorkspace,
    preflightArchiveWorkspace,
    archiveWorkspace: onArchiveWorkspace,
    archivingWorkspaceIds,
    removeWorkspace,
    updateWorkspaceTitle: onUpdateTitle,
    setWorkspacePinned,
    reorderPinnedWorkspaces,
    refreshWorkspaceMetadata,
    pendingNewWorkspaceProject,
    pendingNewWorkspaceDraftId,
    workspaceDraftsByProject,
    workspaceDraftPromotionsByProject,
    createWorkspaceDraft,
    openWorkspaceDraft,
    deleteWorkspaceDraft,
  } = useWorkspaceActions();
  const workspaceStore = useWorkspaceStoreRaw();
  useWorkspaceAttentionSubscription(sortedWorkspacesByProject, workspaceStore);
  const runtimeStatusStore = useRuntimeStatusStoreRaw();
  const { navigateToProject } = useRouter();
  const { api } = useAPI();
  const { confirm: confirmDialog } = useConfirmDialog();
  const settings = useSettings();

  // Get project state and operations from context
  const {
    userProjects,
    openProjectCreateModal: onAddProject,
    removeProject: onRemoveProject,
    getRemovalBlockers,
    updateDisplayName,
    updateColor: updateProjectColor,
    assignWorkspaceToSubProject,
  } = useProjectContext();

  // Theme for logo variant
  const { theme } = useTheme();
  const XumLogo = theme === "dark" || theme.endsWith("-dark") ? XumLogoDark : XumLogoLight;
  const multiProjectWorkspacesEnabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);

  // Mobile breakpoint for auto-closing sidebar
  const MOBILE_BREAKPOINT = 768;
  const projectListScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileScrollTopRef = useRef(0);
  const wasCollapsedRef = useRef(collapsed);

  const normalizeMobileScrollTop = useCallback((scrollTop: number): number => {
    return Number.isFinite(scrollTop) ? Math.max(0, Math.round(scrollTop)) : 0;
  }, []);

  const persistMobileSidebarScrollTop = useCallback(
    (scrollTop: number) => {
      if (window.innerWidth > MOBILE_BREAKPOINT) {
        return;
      }

      // Keep the last viewed list position so reopening the touch sidebar returns
      // users to where they were browsing instead of jumping back to the top.
      const normalizedScrollTop = normalizeMobileScrollTop(scrollTop);
      updatePersistedState<number>(MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY, normalizedScrollTop, 0);
    },
    [MOBILE_BREAKPOINT, normalizeMobileScrollTop]
  );

  useEffect(() => {
    if (collapsed || window.innerWidth > MOBILE_BREAKPOINT) {
      return;
    }

    const persistedScrollTop = readPersistedState<unknown>(MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY, 0);
    const normalizedScrollTop =
      typeof persistedScrollTop === "number" ? normalizeMobileScrollTop(persistedScrollTop) : 0;
    mobileScrollTopRef.current = normalizedScrollTop;

    if (projectListScrollRef.current) {
      projectListScrollRef.current.scrollTop = normalizedScrollTop;
    }
  }, [collapsed, MOBILE_BREAKPOINT, normalizeMobileScrollTop]);

  useEffect(() => {
    const wasCollapsed = wasCollapsedRef.current;

    if (!wasCollapsed && collapsed) {
      persistMobileSidebarScrollTop(mobileScrollTopRef.current);
    }

    wasCollapsedRef.current = collapsed;
  }, [collapsed, persistMobileSidebarScrollTop]);

  const handleProjectListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      mobileScrollTopRef.current = normalizeMobileScrollTop(event.currentTarget.scrollTop);
    },
    [normalizeMobileScrollTop]
  );

  // Wrapper to close sidebar on mobile after workspace selection
  const handleSelectWorkspace = useCallback(
    (selection: WorkspaceSelection) => {
      onSelectWorkspace(selection);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [onSelectWorkspace, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  // Wrapper to close sidebar on mobile after adding workspace
  const handleAddWorkspace = useCallback(
    (projectPath: string, subProjectPath?: string) => {
      createWorkspaceDraft(projectPath, subProjectPath);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [createWorkspaceDraft, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  // Wrapper to close sidebar on mobile after opening an existing draft
  const handleOpenWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string) => {
      openWorkspaceDraft(projectPath, draftId);
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
    },
    [openWorkspaceDraft, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]
  );

  const handleGoHome = useCallback(() => {
    // Selecting null delegates to WorkspaceContext's home-navigation + selection reset flow.
    onSelectWorkspace(null);
    // Close sidebar on mobile
    if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
      persistMobileSidebarScrollTop(mobileScrollTopRef.current);
      onToggleCollapsed();
    }
  }, [onSelectWorkspace, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop]);
  // Workspace-specific subscriptions moved to AgentListItem component

  // Store as array in localStorage, convert to Set for usage
  const [expandedProjectsArray, setExpandedProjectsArray] = usePersistedState<string[]>(
    EXPANDED_PROJECTS_KEY,
    []
  );
  // Handle corrupted localStorage data (old Set stored as {}).
  // Use a plain array with .includes() instead of new Set() on every render —
  // the React Compiler cannot stabilize Set allocations (see AGENTS.md).
  // For typical sidebar sizes (< 20 projects) .includes() is equivalent perf.
  const expandedProjectsList = Array.isArray(expandedProjectsArray) ? expandedProjectsArray : [];

  // Track which projects have old workspaces expanded (per-project, per-tier)
  // Key format: getTierKey(projectPath, tierIndex) where tierIndex is 0, 1, 2 for 1/7/30 days
  const [expandedOldWorkspaces, setExpandedOldWorkspaces] = usePersistedState<
    Record<string, boolean>
  >("expandedOldWorkspaces", {});

  // Whether workspaces are grouped under collapsible "Older than X days" tiers.
  // Toggled from Settings → General; listener keeps the sidebar live-updated.
  const [ageGroupingEnabled] = usePersistedState<boolean>(SIDEBAR_AGE_GROUPING_KEY, true, {
    listener: true,
  });

  const [flatSidebarEnabled] = usePersistedState<boolean>(SIDEBAR_FLAT_MODE_KEY, false, {
    listener: true,
  });

  // Opt-in: hide sub-agent rows and summarize them on parent rows instead.
  const [hideSubAgentRows] = usePersistedState<boolean>(SIDEBAR_HIDE_SUBAGENTS_KEY, false, {
    listener: true,
  });

  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = usePersistedState<Record<string, boolean>>(
    "expandedSections",
    {}
  );

  // Track parent workspaces whose reported child tasks are expanded.
  const [expandedCompletedSubAgents, setExpandedCompletedSubAgents] = usePersistedState<
    Record<string, boolean>
  >("expandedCompletedSubAgents", {});
  const toggleCompletedChildrenExpansion = useCallback(
    (workspaceId: string) => {
      setExpandedCompletedSubAgents((prev) => ({
        ...prev,
        [workspaceId]: !(prev[workspaceId] ?? false),
      }));
    },
    [setExpandedCompletedSubAgents]
  );
  const expandedCompletedParentIds = new Set<string>();
  for (const workspaces of sortedWorkspacesByProject.values()) {
    for (const workspace of workspaces) {
      // Persistence and presentation are intentionally independent: durable inactive tasks stay
      // collapsed until the user asks to inspect them, so history never crowds the active list.
      if (expandedCompletedSubAgents[workspace.id] === true) {
        expandedCompletedParentIds.add(workspace.id);
      }
    }
  }

  // Task-group expansion survives reloads (D7). Keys are namespaced per group
  // kind: task:<parentWorkspaceId>:<groupId> / workflow:<parentWorkspaceId>:<runId>.
  const [expandedTaskGroups, setExpandedTaskGroups] = usePersistedState<Record<string, boolean>>(
    "expandedTaskGroups",
    {}
  );
  // D6: a workflow group that is (or was, this session) active defaults to
  // expanded and must not auto-collapse when its members finish mid-session.
  // The render-time ref keeps that default sticky; an explicit toggle wins.
  const sessionActiveTaskGroupKeysRef = useRef<Set<string>>(new Set());
  // Workflow-owned worker workspaces are transient. Cache the run-level group model separately so
  // an active workflow keeps a stable sidebar header between sequential steps after its worker row
  // has been deleted; inactive child rows themselves remain absent.
  const retainedWorkflowTaskGroupsRef = useRef<Map<string, SidebarTaskGroupModel>>(new Map());
  // Same transience problem for the hidden-sub-agents summary: retain each
  // run's workflow name past its workers so runs between sequential steps stay
  // labeled; entries are pruned once the owning workspace drops the run.
  const workflowRunNamesRef = useRef<Map<string, { ownerWorkspaceId: string; name: string }>>(
    new Map()
  );
  const toggleTaskGroupExpansion = (storageKey: string, isCurrentlyExpanded: boolean) => {
    setExpandedTaskGroups((prev) => ({
      ...prev,
      [storageKey]: !isCurrentlyExpanded,
    }));
  };

  const [removingWorkspaceIds, setRemovingWorkspaceIds] = useState<Set<string>>(new Set());
  const [draftVisibilityByProject, setDraftVisibilityByProject] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const workspaceArchiveError = usePopoverError();
  const workspaceForkError = usePopoverError();
  const workspaceStopRuntimeError = usePopoverError();
  const workspaceRemoveError = usePopoverError();
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    workspaceId: string;
    displayTitle: string;
    buttonElement?: HTMLElement;
    /** When set, the confirmation warns about permanent deletion of untracked files. */
    untrackedPaths?: string[];
    /** Whether the workspace has an active stream that will be interrupted. */
    isStreaming?: boolean;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    projectPath: string;
    projectName: string;
    activeCount: number;
    archivedCount: number;
  } | null>(null);
  const projectRemoveError = usePopoverError();
  const sectionRemoveError = usePopoverError();

  const handleDraftVisibilityChange = useCallback(
    (projectPath: string, draftId: string, isVisible: boolean) => {
      setDraftVisibilityByProject((prev) => {
        const existing = prev[projectPath] ?? {};
        if (existing[draftId] === isVisible) {
          return prev;
        }

        return {
          ...prev,
          [projectPath]: {
            ...existing,
            [draftId]: isVisible,
          },
        };
      });
    },
    []
  );

  const projectContextMenu = useContextMenuPosition({ longPress: true });
  const [projectMenuTargetPath, setProjectMenuTargetPath] = useState<string | null>(null);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  const [editingProjectDisplayName, setEditingProjectDisplayName] = useState("");
  const [autoEditingSection, setAutoEditingSection] = useState<{
    projectPath: string;
    sectionId: string;
  } | null>(null);
  const [showProjectColorPicker, setShowProjectColorPicker] = useState(false);
  const [projectColorHexInput, setProjectColorHexInput] = useState("");
  const [projectColorPickerValue, setProjectColorPickerValue] = useState("#000000");
  const [projectColorPickerDirty, setProjectColorPickerDirty] = useState(false);
  const skipNextProjectNameBlurCommitRef = useRef(false);

  // Use functional update to avoid stale closure issues when clicking rapidly
  const toggleProject = useCallback(
    (projectPath: string) => {
      setExpandedProjectsArray((prev) => {
        const prevSet = new Set(Array.isArray(prev) ? prev : []);
        if (prevSet.has(projectPath)) {
          prevSet.delete(projectPath);
        } else {
          prevSet.add(projectPath);
        }
        return Array.from(prevSet);
      });
    },
    [setExpandedProjectsArray]
  );

  const handleAddScratchWorkspace = useCallback(() => {
    setExpandedProjectsArray((prev) => {
      const expanded = Array.isArray(prev) ? prev : [];
      return expanded.includes(SCRATCH_SIDEBAR_SECTION_ID)
        ? expanded
        : [...expanded, SCRATCH_SIDEBAR_SECTION_ID];
    });
    handleAddWorkspace(SCRATCH_PROJECT_CONFIG_KEY);
  }, [handleAddWorkspace, setExpandedProjectsArray]);

  const toggleSection = (projectPath: string, sectionId: string) => {
    const key = getSectionExpandedKey(projectPath, sectionId);
    setExpandedSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleForkWorkspace = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      if (!api) {
        workspaceForkError.showError(workspaceId, "Not connected to server");
        return;
      }

      let anchor: { top: number; left: number } | undefined;
      if (buttonElement) {
        const rect = buttonElement.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        };
      }

      try {
        const result = await forkWorkspace({
          client: api,
          sourceWorkspaceId: workspaceId,
        });
        if (result.success) {
          return;
        }
        workspaceForkError.showError(workspaceId, result.error ?? "Failed to fork chat", anchor);
      } catch (error) {
        // IPC/transport failures throw instead of returning { success: false }
        const message = getErrorMessage(error);
        workspaceForkError.showError(workspaceId, message, anchor);
      }
    },
    [api, workspaceForkError]
  );

  const handleStopRuntime = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      let anchor: { top: number; left: number } | undefined;
      if (buttonElement) {
        const rect = buttonElement.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        };
      }

      if (!api) {
        workspaceStopRuntimeError.showError(workspaceId, "Not connected to server", anchor);
        return;
      }

      try {
        const result = await api.workspace.stopRuntime({ workspaceId });
        if (!result.success) {
          workspaceStopRuntimeError.showError(
            workspaceId,
            result.error ?? "Failed to stop container",
            anchor
          );
          return;
        }

        // A successful stop should hide the running indicator and menu action without
        // forcing rows to own their own optimistic runtime state.
        runtimeStatusStore.invalidateWorkspace(workspaceId);
      } catch (error) {
        workspaceStopRuntimeError.showError(workspaceId, getErrorMessage(error), anchor);
      }
    },
    [api, runtimeStatusStore, workspaceStopRuntimeError]
  );

  const performArchiveWorkspace = useCallback(
    async (
      workspaceId: string,
      buttonElement?: HTMLElement,
      acknowledgedUntrackedPaths?: string[]
    ) => {
      const result = await onArchiveWorkspace(
        workspaceId,
        acknowledgedUntrackedPaths ? { acknowledgedUntrackedPaths } : undefined
      );
      if (result.success && result.data?.kind === "confirm-lossy-untracked-files") {
        const metadata = workspaceStore.getWorkspaceMetadata(workspaceId);
        const displayTitle = metadata?.title ?? metadata?.name ?? workspaceId;
        const aggregator = workspaceStore.getAggregator(workspaceId);
        const hasActiveStreams = aggregator?.hasInterruptibleActiveStream() ?? false;
        const pendingStreamStartTime = aggregator?.getPendingStreamStartTime();
        const isStarting = pendingStreamStartTime != null && !hasActiveStreams;
        const awaitingUserQuestion = aggregator?.hasAwaitingUserQuestion() ?? false;
        const isStreaming = (hasActiveStreams || isStarting) && !awaitingUserQuestion;
        setArchiveConfirmation({
          workspaceId,
          displayTitle,
          buttonElement,
          untrackedPaths: result.data.paths,
          // The retry path already handled any earlier streaming warning. Only surface the
          // interruption warning again when the archive attempt has not yet been confirmed.
          isStreaming: acknowledgedUntrackedPaths == null ? isStreaming : false,
        });
        return false;
      }
      if (!result.success) {
        if (acknowledgedUntrackedPaths != null) {
          // Archive may fail if new untracked files appear between confirmation and capture.
          // Re-run preflight so we can reopen the modal with the latest paths.
          const preflight = await preflightArchiveWorkspace(workspaceId);
          if (preflight.success && preflight.data?.kind === "confirm-lossy-untracked-files") {
            const pathsChanged = didUntrackedPathSetChange(
              acknowledgedUntrackedPaths,
              preflight.data.paths
            );
            if (pathsChanged) {
              const metadata = workspaceStore.getWorkspaceMetadata(workspaceId);
              const displayTitle = metadata?.title ?? metadata?.name ?? workspaceId;
              setArchiveConfirmation({
                workspaceId,
                displayTitle,
                buttonElement,
                untrackedPaths: preflight.data.paths,
                isStreaming: (() => {
                  const aggregator = workspaceStore.getAggregator(workspaceId);
                  if (!aggregator) return false;
                  const hasActiveStreams = aggregator.hasInterruptibleActiveStream();
                  const isStarting =
                    aggregator.getPendingStreamStartTime() !== null && !hasActiveStreams;
                  const awaitingUserQuestion = aggregator.hasAwaitingUserQuestion();
                  return (hasActiveStreams || isStarting) && !awaitingUserQuestion;
                })(),
              });
              return false;
            }
          }
        }

        const error = result.error ?? "Failed to archive chat";
        // Archive failures can be long-lived workflow errors (for example, untracked-file safety
        // checks) that users should notice near the active workspace content, not pinned beside a
        // left-sidebar row that may be far from their current focus. Use the shared toast fallback
        // position so archive errors match other top-right UI error surfaces.
        workspaceArchiveError.showError(workspaceId, error);
        return false;
      }
      return true;
    },
    [onArchiveWorkspace, preflightArchiveWorkspace, workspaceArchiveError, workspaceStore]
  );

  const hasActiveStream = useCallback(
    (workspaceId: string) => {
      const aggregator = workspaceStore.getAggregator(workspaceId);
      if (!aggregator) return false;
      const hasActiveStreams = aggregator.hasInterruptibleActiveStream();
      const isStarting = aggregator.getPendingStreamStartTime() !== null && !hasActiveStreams;
      const awaitingUserQuestion = aggregator.hasAwaitingUserQuestion();
      return (hasActiveStreams || isStarting) && !awaitingUserQuestion;
    },
    [workspaceStore]
  );

  const workspaceHasAttention = useCallback(
    (workspace: FrontendWorkspaceMetadata) => {
      const workspaceId = workspace.id;
      const attentionSignal = getWorkspaceAttentionSignal(workspaceStore, workspaceId);
      const isWorking = attentionSignal?.isWorking === true;
      const awaitingUserQuestion = attentionSignal?.awaitingUserQuestion === true;
      const hasError = attentionSignal?.hasSystemError === true;
      const isRemoving = workspace.isRemoving === true;
      const isArchiving = archivingWorkspaceIds.has(workspaceId);
      const isInitializing = workspace.isInitializing === true;
      const isSelected = selectedWorkspace?.workspaceId === workspaceId;
      const recencyTimestamp = workspaceRecency[workspaceId] ?? null;
      const lastReadTimestamp = readPersistedState<number | null>(
        getWorkspaceLastReadKey(workspaceId),
        null
      );
      const isUnread =
        !isSelected &&
        recencyTimestamp !== null &&
        lastReadTimestamp !== null &&
        recencyTimestamp > lastReadTimestamp;

      return (
        isWorking ||
        awaitingUserQuestion ||
        hasError ||
        isInitializing ||
        isRemoving ||
        isArchiving ||
        isUnread
      );
    },
    [archivingWorkspaceIds, selectedWorkspace?.workspaceId, workspaceRecency, workspaceStore]
  );

  const handleArchiveWorkspace = useCallback(
    async (workspaceId: string, buttonElement?: HTMLElement) => {
      // The keyboard shortcut bypasses the row's disabled state, so guard here as well.
      if (archivingWorkspaceIds.has(workspaceId)) return;
      const metadata = workspaceStore.getWorkspaceMetadata(workspaceId);
      const displayTitle = metadata?.title ?? metadata?.name ?? workspaceId;
      const isStreaming = hasActiveStream(workspaceId);

      // Run preflight to check for untracked files that can't be preserved.
      const preflight = await preflightArchiveWorkspace(workspaceId);
      if (!preflight.success) {
        workspaceArchiveError.showError(
          workspaceId,
          preflight.error ?? "Failed to check archive readiness"
        );
        return;
      }

      const untrackedPaths =
        preflight.data?.kind === "confirm-lossy-untracked-files" ? preflight.data.paths : undefined;

      if (isStreaming || untrackedPaths) {
        // Show a single combined confirmation dialog for streaming + untracked-file warnings.
        setArchiveConfirmation({
          workspaceId,
          displayTitle,
          buttonElement,
          untrackedPaths,
          isStreaming,
        });
        return;
      }

      await performArchiveWorkspace(workspaceId, buttonElement);
    },
    [
      archivingWorkspaceIds,
      hasActiveStream,
      performArchiveWorkspace,
      preflightArchiveWorkspace,
      workspaceArchiveError,
      workspaceStore,
    ]
  );

  const handleArchiveWorkspaceConfirm = useCallback(async () => {
    if (!archiveConfirmation) {
      return;
    }

    const confirmation = archiveConfirmation;
    setArchiveConfirmation(null);
    await performArchiveWorkspace(
      confirmation.workspaceId,
      confirmation.buttonElement,
      confirmation.untrackedPaths
    );
  }, [archiveConfirmation, performArchiveWorkspace]);

  const handleArchiveWorkspaceCancel = useCallback(() => {
    setArchiveConfirmation(null);
  }, []);

  const showProjectRemoveError = useCallback(
    (
      projectPath: string,
      error: {
        type: string;
        message?: string;
        activeCount?: number;
        archivedCount?: number;
      },
      // Callers pass precomputed coordinates because the triggering button may
      // already be unmounted by the time an awaited removal/preflight settles.
      anchor?: { top: number; left: number }
    ) => {
      let message: string;
      if (error.type === "workspace_blockers") {
        const parts: string[] = [];
        const activeCount = error.activeCount ?? 0;
        const archivedCount = error.archivedCount ?? 0;

        if (activeCount > 0) {
          parts.push(`${activeCount} active`);
        }
        if (archivedCount > 0) {
          parts.push(`${archivedCount} archived`);
        }
        message = `Has ${parts.join(" and ")} workspace(s)`;
      } else if (error.type === "project_not_found") {
        message = "Project not found";
      } else {
        message = error.message ?? "Failed to remove project";
      }

      projectRemoveError.showError(projectPath, message, anchor);
    },
    [projectRemoveError]
  );

  const removeProjectWithFeedback = useCallback(
    async (
      projectPath: string,
      options?: { force?: boolean },
      anchor?: { top: number; left: number }
    ) => {
      const result = await onRemoveProject(projectPath, options);
      if (!result.success) {
        showProjectRemoveError(projectPath, result.error, anchor);
      }
      return result;
    },
    [onRemoveProject, showProjectRemoveError]
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmation) {
      return;
    }

    const result = await removeProjectWithFeedback(deleteConfirmation.projectPath, {
      force: true,
    });
    if (result.success) {
      setDeleteConfirmation(null);
    }
  }, [deleteConfirmation, removeProjectWithFeedback]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmation(null);
  }, []);
  const handleCancelWorkspaceCreation = useCallback(
    async (workspaceId: string) => {
      // Give immediate UI feedback (spinner / disabled row) while deletion is in-flight.
      setRemovingWorkspaceIds((prev) => new Set(prev).add(workspaceId));

      try {
        const result = await removeWorkspace(workspaceId, { force: true });
        if (!result.success) {
          workspaceRemoveError.showError(
            workspaceId,
            result.error ?? "Failed to cancel workspace creation"
          );
        }
      } finally {
        setRemovingWorkspaceIds((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [removeWorkspace, workspaceRemoveError]
  );

  const handleRemoveSection = async (
    projectPath: string,
    subProjectPath: string,
    buttonElement?: HTMLElement
  ) => {
    // Capture the anchor location up front because the sub-project action menu unmounts its
    // button immediately after click; failures still need stable error placement.
    const anchor =
      buttonElement != null
        ? (() => {
            const buttonRect = buttonElement.getBoundingClientRect();
            return {
              top: buttonRect.top + window.scrollY,
              left: buttonRect.right + 10,
            };
          })()
        : undefined;

    // Removing a sub-project unregisters it and clears the cwd pointer from its workspaces.
    // projects.list excludes archived workspaces, so this count covers live ones only;
    // that matches the sidebar view this dialog describes, and the action itself is
    // non-destructive (workspaces just move back to the parent project).
    const workspacesInSection = (userProjects.get(projectPath)?.workspaces ?? []).filter(
      (workspace) => workspace.subProjectPath === subProjectPath
    );

    if (workspacesInSection.length > 0) {
      const ok = await confirmDialog({
        title: "Remove sub-project?",
        description: `${workspacesInSection.length} workspace(s) in this sub-project will move back to the parent project.`,
        confirmLabel: "Remove",
        confirmVariant: "destructive",
      });
      if (!ok) {
        return;
      }
    }

    const result = await onRemoveProject(subProjectPath);
    if (!result.success) {
      const error = getErrorMessage(result.error) || "Failed to remove sub-project";
      sectionRemoveError.showError(subProjectPath, error, anchor);
    }
  };

  const handleOpenSecrets = useCallback(
    (projectPath: string) => {
      // Collapse the off-canvas sidebar on mobile before navigating so the
      // settings page is immediately accessible without a backdrop blocking it.
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
      // Navigate to Settings → Secrets with the project pre-selected.
      settings.open("secrets", { secretsProjectPath: projectPath });
    },
    [MOBILE_BREAKPOINT, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop, settings]
  );

  const handleOpenInstructions = useCallback(
    (projectPath: string) => {
      // Same mobile collapse behavior as handleOpenSecrets.
      if (window.innerWidth <= MOBILE_BREAKPOINT && !collapsed) {
        persistMobileSidebarScrollTop(mobileScrollTopRef.current);
        onToggleCollapsed();
      }
      // Navigate to Settings → Instructions with the project pre-selected.
      settings.open("instructions", { instructionsProjectPath: projectPath });
    },
    [MOBILE_BREAKPOINT, collapsed, onToggleCollapsed, persistMobileSidebarScrollTop, settings]
  );

  const closeProjectContextMenu = useCallback(() => {
    projectContextMenu.close();
    setProjectMenuTargetPath(null);
    setShowProjectColorPicker(false);
    setProjectColorPickerDirty(false);
  }, [projectContextMenu]);

  const handleProjectMenuOpenChange = useCallback(
    (open: boolean) => {
      projectContextMenu.onOpenChange(open);
      if (!open) {
        setProjectMenuTargetPath(null);
        setShowProjectColorPicker(false);
        setProjectColorPickerDirty(false);
      }
    },
    [projectContextMenu]
  );

  const handleOpenProjectMenu = useCallback(
    (event: React.MouseEvent, projectPath: string) => {
      setProjectMenuTargetPath(projectPath);
      setShowProjectColorPicker(false);
      setProjectColorPickerDirty(false);
      projectContextMenu.onContextMenu(event);
    },
    [projectContextMenu]
  );

  const handleProjectContextMenuTouchStart = useCallback(
    (event: React.TouchEvent, projectPath: string) => {
      setProjectMenuTargetPath(projectPath);
      setShowProjectColorPicker(false);
      setProjectColorPickerDirty(false);
      projectContextMenu.touchHandlers.onTouchStart(event);
    },
    [projectContextMenu]
  );

  // Monotonic token so a slower earlier removal preflight can never overwrite
  // the confirmation dialog (or trigger removal) for a project the user
  // selected afterwards.
  const removalPreflightSeq = useRef(0);

  const handleRequestProjectRemoval = useCallback(
    async (projectPath: string, buttonElement?: HTMLElement) => {
      const projectConfig = userProjects.get(projectPath);
      if (!projectConfig) {
        return;
      }

      const projectName = projectConfig.displayName ?? getProjectNameFromPath(projectPath);
      // Capture the anchor up front: the context menu closes (unmounting the
      // button) while the preflight below is awaited, and a disconnected
      // element would resolve to zero coordinates.
      const anchor =
        buttonElement != null
          ? (() => {
              const rect = buttonElement.getBoundingClientRect();
              return { top: rect.top + window.scrollY, left: rect.right + 10 };
            })()
          : undefined;
      // projects.list excludes archived workspaces (read-side projection), so
      // blocker counts come from a read-only backend preflight instead of the
      // embedded workspace arrays. remove() is deliberately NOT used as the
      // probe: it prunes stale workspace entries and deletes the project when
      // nothing remains, which must not happen before the user confirms.
      const seq = ++removalPreflightSeq.current;
      let counts: { activeCount: number; archivedCount: number };
      try {
        counts = await getRemovalBlockers(projectPath);
      } catch (error) {
        if (seq === removalPreflightSeq.current) {
          showProjectRemoveError(
            projectPath,
            { type: "unknown", message: getErrorMessage(error) },
            anchor
          );
        }
        return;
      }
      if (seq !== removalPreflightSeq.current) {
        return;
      }
      if (counts.activeCount + counts.archivedCount > 0) {
        setDeleteConfirmation({
          projectPath,
          projectName,
          activeCount: counts.activeCount,
          archivedCount: counts.archivedCount,
        });
        return;
      }

      void removeProjectWithFeedback(projectPath, undefined, anchor);
    },
    [getRemovalBlockers, removeProjectWithFeedback, showProjectRemoveError, userProjects]
  );

  const cancelProjectDisplayNameEditing = useCallback(() => {
    setEditingProjectPath(null);
    setEditingProjectDisplayName("");
  }, []);

  const commitProjectDisplayNameEdit = useCallback(
    async (projectPath: string, nextDisplayName: string) => {
      const normalizedDisplayName = normalizeDisplayNameInput(nextDisplayName);
      const result = await updateDisplayName(projectPath, normalizedDisplayName);
      if (!result.success) {
        console.error("Failed to update project display name:", result.error);
        return;
      }
      setEditingProjectPath((currentPath) => {
        if (currentPath === projectPath) {
          setEditingProjectDisplayName("");
          return null;
        }
        return currentPath;
      });
    },
    [updateDisplayName]
  );

  const handleProjectMenuEditName = useCallback(() => {
    if (!projectMenuTargetPath) {
      return;
    }

    const projectConfig = userProjects.get(projectMenuTargetPath);
    if (!projectConfig) {
      closeProjectContextMenu();
      return;
    }

    // Escape can leave the skip-blur flag set when the input unmounts before a blur event fires.
    // Clear it when a fresh edit session starts so the next blur commits as expected.
    skipNextProjectNameBlurCommitRef.current = false;
    const currentDisplayName =
      projectConfig.displayName ?? getProjectFallbackLabel(projectMenuTargetPath);
    setEditingProjectPath(projectMenuTargetPath);
    setEditingProjectDisplayName(currentDisplayName);
    closeProjectContextMenu();
  }, [closeProjectContextMenu, projectMenuTargetPath, userProjects]);

  const handleProjectMenuManageSecrets = useCallback(() => {
    if (!projectMenuTargetPath) {
      return;
    }

    handleOpenSecrets(projectMenuTargetPath);
    closeProjectContextMenu();
  }, [closeProjectContextMenu, handleOpenSecrets, projectMenuTargetPath]);

  const handleProjectMenuInstructions = useCallback(() => {
    if (!projectMenuTargetPath) {
      return;
    }

    handleOpenInstructions(projectMenuTargetPath);
    closeProjectContextMenu();
  }, [closeProjectContextMenu, handleOpenInstructions, projectMenuTargetPath]);

  const handleProjectMenuDelete = useCallback(
    (buttonElement?: HTMLElement) => {
      if (!projectMenuTargetPath) {
        return;
      }

      void handleRequestProjectRemoval(projectMenuTargetPath, buttonElement);
      closeProjectContextMenu();
    },
    [closeProjectContextMenu, handleRequestProjectRemoval, projectMenuTargetPath]
  );

  const handleProjectMenuAddSubFolder = useCallback(() => {
    closeProjectContextMenu();
    onAddProject(projectMenuTargetPath ? { initialPath: projectMenuTargetPath } : undefined);
  }, [closeProjectContextMenu, onAddProject, projectMenuTargetPath]);

  const projectMenuTargetConfig = projectMenuTargetPath
    ? (userProjects.get(projectMenuTargetPath) ?? null)
    : null;
  const projectMenuResolvedColor = resolveSectionColor(projectMenuTargetConfig?.color);

  // HexColorPicker emits on every drag tick; debounce project color writes so we
  // don't flood IPC + project refreshes while the user drags through hues.
  const debouncedProjectColorPickerValue = useDebouncedValue(projectColorPickerValue, 150);

  const handleProjectMenuColorClick = useCallback(() => {
    if (!projectMenuTargetPath) {
      return;
    }
    setShowProjectColorPicker((prev) => {
      const next = !prev;
      if (next) {
        setProjectColorHexInput(projectMenuResolvedColor);
        setProjectColorPickerValue(projectMenuResolvedColor);
      }
      setProjectColorPickerDirty(false);
      return next;
    });
  }, [projectMenuResolvedColor, projectMenuTargetPath]);

  const handleProjectColorChange = useCallback(
    async (color: string) => {
      if (!projectMenuTargetPath) {
        return;
      }
      const result = await updateProjectColor(projectMenuTargetPath, color);
      if (!result.success) {
        console.error("Failed to update project color:", result.error);
      }
    },
    [projectMenuTargetPath, updateProjectColor]
  );

  useEffect(() => {
    if (!showProjectColorPicker || !projectColorPickerDirty) {
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(debouncedProjectColorPickerValue)) {
      return;
    }
    if (debouncedProjectColorPickerValue === projectMenuResolvedColor) {
      return;
    }

    void handleProjectColorChange(debouncedProjectColorPickerValue);
  }, [
    debouncedProjectColorPickerValue,
    handleProjectColorChange,
    projectColorPickerDirty,
    projectMenuResolvedColor,
    showProjectColorPicker,
  ]);

  // UI preference: project order persists in localStorage
  const [projectOrder, setProjectOrder] = usePersistedState<string[]>(PROJECT_ORDER_KEY, []);

  // Build a stable signature of the project keys so effects don't fire on Map identity churn
  const projectPathsSignature = React.useMemo(() => {
    // sort to avoid order-related churn
    const keys = Array.from(userProjects.keys()).sort();
    return keys.join("\u0001"); // use non-printable separator
  }, [userProjects]);

  // Normalize order when the set of projects changes (not on every parent render)
  useEffect(() => {
    // Skip normalization if projects haven't loaded yet (empty Map on initial render)
    // This prevents clearing projectOrder before projects load from backend
    if (userProjects.size === 0) {
      return;
    }

    const normalized = normalizeOrder(projectOrder, userProjects);
    if (
      normalized.length !== projectOrder.length ||
      normalized.some((p, i) => p !== projectOrder[i])
    ) {
      setProjectOrder(normalized);
    }
    // Only re-run when project keys change (projectPathsSignature captures projects Map keys)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPathsSignature]);

  // Memoize sorted project PATHS (not entries) to avoid capturing stale config objects.
  // Sorting depends only on keys + order; we read configs from the live Map during render.
  const sortedProjectPaths = React.useMemo(
    () =>
      sortProjectsByOrder(userProjects, projectOrder)
        .filter(([, config]) => !config.parentProjectPath)
        .map(([p]) => p),
    // projectPathsSignature captures projects Map keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPathsSignature, projectOrder]
  );

  const isWorkspaceLiveActive = (workspaceId: string): boolean => {
    const signal = getWorkspaceAttentionSignal(workspaceStore, workspaceId);
    return signal?.isWorking === true;
  };
  const getActiveWorkflowRunIds = (workspaceId: string): readonly string[] => {
    try {
      return workspaceStore.getWorkspaceSidebarState(workspaceId).activeWorkflowRunIds ?? [];
    } catch {
      return [];
    }
  };
  const isWorkflowRunActive = (workspaceId: string, runId: string): boolean =>
    getActiveWorkflowRunIds(workspaceId).includes(runId);
  const allSidebarWorkspaces = Array.from(sortedWorkspacesByProject.values()).flat();
  // Mirror the grouped collection's experiment gate: multi-project chats stay
  // hidden in flat mode too while the experiment is off.
  const flatWorkspaces = flatSidebarEnabled
    ? buildSortedWorkspacesFlat(
        multiProjectWorkspacesEnabled
          ? allSidebarWorkspaces
          : allSidebarWorkspaces.filter((workspace) => !isMultiProject(workspace)),
        workspaceRecency
      )
    : [];
  // Draft-to-workspace promotions: like grouped mode, the just-created
  // workspace renders in its draft's position, so it must be suppressed from
  // the normal rows or the same chat appears twice during creation.
  // Drafts follow the same experiment gate as flatWorkspaces: _multi drafts
  // (and their promotions) stay hidden in flat mode while the experiment is off.
  const isGatedFlatDraftBucket = (projectPath: string): boolean =>
    !multiProjectWorkspacesEnabled && projectPath === MULTI_PROJECT_CONFIG_KEY;
  const flatDraftPromotionsByDraftId = new Map<string, FrontendWorkspaceMetadata>();
  if (flatSidebarEnabled) {
    for (const [projectPath, drafts] of Object.entries(workspaceDraftsByProject)) {
      if (isGatedFlatDraftBucket(projectPath)) continue;
      const promotions = workspaceDraftPromotionsByProject[projectPath] ?? {};
      for (const draft of drafts) {
        const promoted = promotions[draft.draftId];
        if (promoted) {
          flatDraftPromotionsByDraftId.set(draft.draftId, promoted);
        }
      }
    }
  }
  const flatPromotedWorkspaceIds = new Set(
    [...flatDraftPromotionsByDraftId.values()].map((metadata) => metadata.id)
  );
  const flatRowsBeforePromotionFilter = hideSubAgentRows
    ? excludeSubAgentRows(flatWorkspaces)
    : flatWorkspaces;
  const flatRowsForDisplay =
    flatPromotedWorkspaceIds.size > 0
      ? flatRowsBeforePromotionFilter.filter(
          (workspace) => !flatPromotedWorkspaceIds.has(workspace.id)
        )
      : flatRowsBeforePromotionFilter;
  const flatDepthByWorkspaceId = computeWorkspaceDepthMap(flatRowsForDisplay);
  const visibleFlatWorkspaces = filterVisibleAgentRows(
    flatRowsForDisplay,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  const flatRowMetaByWorkspaceId = computeAgentRowRenderMeta(
    flatRowsForDisplay,
    flatDepthByWorkspaceId,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  // Pinned-at-the-top invariant vs drafts: pinned roots (their subtrees stay
  // adjacent and never age out) render as their own segment above the draft
  // rows, so adding a draft never displaces the user's pinned chats.
  const flatPinnedRowIds = new Set<string>();
  if (flatSidebarEnabled) {
    let inPinnedSubtree = false;
    for (const row of flatRowsForDisplay) {
      if ((flatDepthByWorkspaceId[row.id] ?? 0) === 0) {
        inPinnedSubtree = isWorkspacePinned(row);
      }
      if (inPinnedSubtree) flatPinnedRowIds.add(row.id);
    }
  }
  const visiblePinnedFlatWorkspaces = visibleFlatWorkspaces.filter((row) =>
    flatPinnedRowIds.has(row.id)
  );
  const visibleUnpinnedFlatWorkspaces = visibleFlatWorkspaces.filter(
    (row) => !flatPinnedRowIds.has(row.id)
  );
  if (flatSidebarEnabled) {
    // Track runs that are (or were, this session) active so their groups stay
    // mounted across step gaps (mirrors the grouped per-project seeding).
    for (const key of collectActiveWorkflowGroupKeys(flatRowsForDisplay, {
      isWorkspaceLiveActive,
    })) {
      sessionActiveTaskGroupKeysRef.current.add(key);
    }
  }
  // Learn run names while a worker row still carries them (workers are deleted
  // after reporting), then drop names whose run is no longer active.
  for (const workspace of allSidebarWorkspaces) {
    const workflowTask = workspace.workflowTask;
    if (workflowTask?.workflowName != null && workspace.parentWorkspaceId != null) {
      workflowRunNamesRef.current.set(workflowTask.runId, {
        ownerWorkspaceId: workspace.parentWorkspaceId,
        name: workflowTask.workflowName,
      });
    }
  }
  for (const [runId, entry] of workflowRunNamesRef.current) {
    if (!isWorkflowRunActive(entry.ownerWorkspaceId, runId)) {
      workflowRunNamesRef.current.delete(runId);
    }
  }
  const getWorkflowRunName = (runId: string): string | undefined =>
    workflowRunNamesRef.current.get(runId)?.name;
  const delegatedActivityByWorkspaceId = computeDelegatedActivityByWorkspaceId(
    allSidebarWorkspaces,
    { isWorkspaceLiveActive }
  );
  const subAgentsSummaryByWorkspaceId = hideSubAgentRows
    ? computeSubAgentsSummaryByWorkspaceId(allSidebarWorkspaces, {
        isWorkspaceLiveActive,
        getActiveWorkflowRunIds,
        getWorkflowRunName,
      })
    : null;
  // In hide mode every row gets at least the empty summary: rows without
  // counted descendants still show a workflow line for their own active runs
  // (step gaps between transient workers leave no countable descendants).
  const getHiddenSubAgentsSummary = (workspaceId: string): WorkspaceSubAgentsSummary | undefined =>
    subAgentsSummaryByWorkspaceId
      ? (subAgentsSummaryByWorkspaceId.get(workspaceId) ?? EMPTY_HIDDEN_SUBAGENTS_SUMMARY)
      : undefined;

  const singleProjectWorkspacesByProject = new Map<string, FrontendWorkspaceMetadata[]>();
  const scratchWorkspacesById = new Map<string, FrontendWorkspaceMetadata>();
  const multiProjectWorkspacesById = new Map<string, FrontendWorkspaceMetadata>();
  const workspaceAttentionById = new Map<string, boolean>();

  for (const [projectPath, workspaces] of sortedWorkspacesByProject) {
    const singleProjectWorkspaces: FrontendWorkspaceMetadata[] = [];
    for (const workspace of workspaces) {
      workspaceAttentionById.set(
        workspace.id,
        workspaceHasAttention(workspace) ||
          (delegatedActivityByWorkspaceId.get(workspace.id)?.activeCount ?? 0) > 0
      );
      if (workspace.kind === "scratch") {
        scratchWorkspacesById.set(workspace.id, workspace);
        continue;
      }
      if (isMultiProject(workspace)) {
        if (multiProjectWorkspacesEnabled) {
          multiProjectWorkspacesById.set(workspace.id, workspace);
        }
        continue;
      }

      singleProjectWorkspaces.push(workspace);
    }
    singleProjectWorkspacesByProject.set(projectPath, singleProjectWorkspaces);
  }

  const scratchWorkspaces = orderMultiProjectSectionRows(
    Array.from(scratchWorkspacesById.values())
  );
  // Sub-agent rows render nested under their parent, so section counts skip
  // them (orphans and malformed-cycle rows still count, matching display).
  const topLevelScratchWorkspaces = excludeSubAgentRows(scratchWorkspaces);
  const scratchRowsForDisplay = hideSubAgentRows ? topLevelScratchWorkspaces : scratchWorkspaces;
  const scratchDepthByWorkspaceId = computeWorkspaceDepthMap(scratchRowsForDisplay);
  const visibleScratchWorkspaces = filterVisibleAgentRows(
    scratchRowsForDisplay,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  const scratchRowMetaByWorkspaceId = computeAgentRowRenderMeta(
    scratchRowsForDisplay,
    scratchDepthByWorkspaceId,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  const isScratchSectionExpanded = expandedProjectsList.includes(SCRATCH_SIDEBAR_SECTION_ID);
  const scratchDrafts = (workspaceDraftsByProject[SCRATCH_PROJECT_CONFIG_KEY] ?? [])
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  // Re-sort across primary-project buckets so pinned rows form one correctly
  // ordered block (cross-primary pinned reorders would otherwise snap back).
  const multiProjectWorkspaces = orderMultiProjectSectionRows(
    Array.from(multiProjectWorkspacesById.values())
  );
  const topLevelMultiProjectWorkspaces = excludeSubAgentRows(multiProjectWorkspaces);
  const multiProjectRowsForDisplay = hideSubAgentRows
    ? topLevelMultiProjectWorkspaces
    : multiProjectWorkspaces;
  const multiProjectDepthByWorkspaceId = computeWorkspaceDepthMap(multiProjectRowsForDisplay);
  const visibleMultiProjectWorkspaces = filterVisibleAgentRows(
    multiProjectRowsForDisplay,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  const multiProjectRowMetaByWorkspaceId = computeAgentRowRenderMeta(
    multiProjectRowsForDisplay,
    multiProjectDepthByWorkspaceId,
    expandedCompletedParentIds,
    { isWorkspaceLiveActive }
  );
  const isMultiProjectSectionExpanded = expandedProjectsList.includes(
    MULTI_PROJECT_SIDEBAR_SECTION_ID
  );

  const flatDrafts = Object.entries(workspaceDraftsByProject)
    .filter(([projectPath]) => !isGatedFlatDraftBucket(projectPath))
    .flatMap(([projectPath, drafts]) => drafts.map((draft) => ({ projectPath, draft })))
    .sort((a, b) => b.draft.createdAt - a.draft.createdAt);
  // Project headers render in both modes: grouped mode nests each project's
  // chats under its header, while flat mode appends the headers below the
  // flat chat list as a compact management section (per-project new chat,
  // rename, color, delete) so core project operations stay reachable via
  // mouse/touch without leaving flat mode.
  const projectHeaderPaths = sortedProjectPaths;
  const getProjectBadge = (projectPath: string): { name: string; color: string } => {
    const config = userProjects.get(projectPath);
    return {
      name: config?.displayName ?? getProjectFallbackLabel(projectPath),
      color: resolveSectionColor(config?.color),
    };
  };
  // Flat mode drops the section headers that used to convey sub-project
  // scope, so rows scoped to a valid sub-project badge with a hierarchical
  // "Parent / Sub" label: sub-project names are only unique within their
  // parent, so the bare sub name (badge text and aria-label both derive from
  // it) could collide across projects. Stale references (deleted sections)
  // fall back to the parent badge, mirroring getDraftSectionId's validation.
  const resolveSubProjectBadge = (
    parentProjectPath: string,
    subProjectPath: string | null | undefined
  ): { name: string; color: string } | undefined => {
    if (typeof subProjectPath !== "string") return undefined;
    const config = userProjects.get(subProjectPath);
    if (config?.parentProjectPath !== parentProjectPath) return undefined;
    return {
      name: `${getProjectBadge(parentProjectPath).name} / ${getProjectDisplayName(subProjectPath, config)}`,
      color: resolveSectionColor(config.color),
    };
  };
  // The _multi bucket is a system key excluded from userProjects, so both
  // chats and drafts label it explicitly instead of leaking the internal key.
  const multiProjectBadge = { name: "Multi-project", color: resolveSectionColor(undefined) };
  const getFlatProjectBadge = (
    workspace: FrontendWorkspaceMetadata
  ): { name: string; color: string } | undefined => {
    if (workspace.parentWorkspaceId != null || workspace.kind === "scratch") return undefined;
    if (isMultiProject(workspace)) {
      return multiProjectBadge;
    }
    return (
      resolveSubProjectBadge(workspace.projectPath, workspace.subProjectPath) ??
      getProjectBadge(workspace.projectPath)
    );
  };
  const getFlatDraftBadge = (
    projectPath: string,
    subProjectPath: string | null | undefined
  ): { name: string; color: string } | undefined =>
    projectPath === SCRATCH_PROJECT_CONFIG_KEY
      ? undefined
      : projectPath === MULTI_PROJECT_CONFIG_KEY
        ? multiProjectBadge
        : (resolveSubProjectBadge(projectPath, subProjectPath) ?? getProjectBadge(projectPath));

  const handleReorder = useCallback(
    (draggedPath: string, targetPath: string) => {
      const next = reorderProjects(projectOrder, userProjects, draggedPath, targetPath);
      setProjectOrder(next);
    },
    [projectOrder, userProjects, setProjectOrder]
  );

  // Pinned-chat reordering, shared by row drag-drop and the move keybinds.
  // locatePinnedBlock mirrors renderer partitioning (sections, multi-project
  // list), so moves stay within the row's visual pinned block while the
  // request carries the bucket's full pinned order.
  const handlePinnedReorderDrop = useCallback(
    (draggedId: string, targetId: string, edge: PinnedDropEdge) => {
      const targetMeta = workspaceStore.getWorkspaceMetadata(targetId);
      if (!targetMeta) return;
      const block = locatePinnedBlock(
        targetMeta,
        sortedWorkspacesByProject,
        userProjects,
        flatSidebarEnabled ? { multiProjectEnabled: multiProjectWorkspacesEnabled } : false
      );
      if (!block) return;
      const order = computePinnedDropOrder(block, draggedId, targetId, edge);
      if (order) void reorderPinnedWorkspaces(order);
    },
    [
      workspaceStore,
      sortedWorkspacesByProject,
      userProjects,
      flatSidebarEnabled,
      multiProjectWorkspacesEnabled,
      reorderPinnedWorkspaces,
    ]
  );

  /**
   * Move the selected pinned chat within its visual block. Returns whether the
   * shortcut applies to this workspace: true for pinned rows (even edge
   * no-ops, so the key is still consumed deterministically), false for
   * unpinned/sub-agent selections so the keydown handler leaves the event
   * untouched for other handlers instead of swallowing it globally.
   */
  const movePinnedWorkspace = useCallback(
    (workspaceId: string, direction: PinnedMoveDirection): boolean => {
      const meta = workspaceStore.getWorkspaceMetadata(workspaceId);
      if (!meta || !isWorkspacePinned(meta)) return false;
      const order = computePinnedMoveOrderForWorkspace(
        meta,
        direction,
        sortedWorkspacesByProject,
        userProjects,
        flatSidebarEnabled ? { multiProjectEnabled: multiProjectWorkspacesEnabled } : false
      );
      if (order) void reorderPinnedWorkspaces(order);
      return true;
    },
    [
      workspaceStore,
      sortedWorkspacesByProject,
      userProjects,
      flatSidebarEnabled,
      multiProjectWorkspacesEnabled,
      reorderPinnedWorkspaces,
    ]
  );

  const hasProjectMenuTarget = projectMenuTargetPath !== null;

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Sub-project workspaces share the parent worktree, so recover the child
      // target from the live sidebar metadata before opening a sibling draft.
      if (matchesKeybind(e, KEYBINDS.NEW_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        // Resolve the effective section ID exactly the way the renderer does:
        // honor the workspace's own subProjectPath when it still exists,
        // otherwise inherit from the parent workspace. This keeps Ctrl+N in
        // lockstep with the visible section and avoids forwarding deleted
        // sub-project paths that workspace.create would reject.
        // Scratch chats are bucketed under the scratch config key while their
        // selection projectPath is the app-managed workdir, so the bucket
        // lookup below misses them; check kind via the store by ID first.
        if (
          workspaceStore.getWorkspaceMetadata(selectedWorkspace.workspaceId)?.kind === "scratch"
        ) {
          handleAddScratchWorkspace();
          return;
        }
        const projectWorkspaces =
          sortedWorkspacesByProject.get(selectedWorkspace.projectPath) ?? [];
        const byId = new Map(projectWorkspaces.map((m) => [m.id, m]));
        const meta = byId.get(selectedWorkspace.workspaceId);
        const validSectionIds = new Set(
          getSubProjectsForParent(selectedWorkspace.projectPath, userProjects).map(
            ([subPath]) => subPath
          )
        );
        const subProjectPath = meta
          ? resolveEffectiveSectionId(meta, byId, validSectionIds)
          : undefined;
        handleAddWorkspace(selectedWorkspace.projectPath, subProjectPath);
      } else if (matchesKeybind(e, KEYBINDS.ARCHIVE_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        void handleArchiveWorkspace(selectedWorkspace.workspaceId);
      } else if (matchesKeybind(e, KEYBINDS.PIN_WORKSPACE) && selectedWorkspace) {
        e.preventDefault();
        // Only root chats are pinnable; a selected sub-agent row is a no-op.
        // Look up by id in the store rather than indexing sortedWorkspacesByProject
        // by projectPath: multi-project workspaces are bucketed under the internal
        // multi-project config key, not their primary project path.
        const meta = workspaceStore.getWorkspaceMetadata(selectedWorkspace.workspaceId);
        if (meta && isWorkspacePinnable(meta)) {
          void setWorkspacePinned(selectedWorkspace.workspaceId, !isWorkspacePinned(meta));
        }
      } else if (matchesKeybind(e, KEYBINDS.MOVE_PINNED_UP) && selectedWorkspace) {
        // Consume the shortcut only when it applies (selected row is pinned);
        // otherwise let the event fall through to other handlers.
        if (movePinnedWorkspace(selectedWorkspace.workspaceId, "up")) {
          e.preventDefault();
        }
      } else if (matchesKeybind(e, KEYBINDS.MOVE_PINNED_DOWN) && selectedWorkspace) {
        if (movePinnedWorkspace(selectedWorkspace.workspaceId, "down")) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeProjectContextMenu,
    selectedWorkspace,
    handleAddScratchWorkspace,
    handleAddWorkspace,
    handleArchiveWorkspace,
    setWorkspacePinned,
    movePinnedWorkspace,
    sortedWorkspacesByProject,
    userProjects,
    workspaceStore,
  ]);

  const archiveConfirmationUntrackedPaths = archiveConfirmation?.untrackedPaths;
  const archiveConfirmationIsStreaming = archiveConfirmation?.isStreaming ?? false;

  // ── Shared coalesced list pipeline ──────────────────────────────────────
  // One rendering pipeline for every workspace list (grouped project sections
  // and the flat chat list): age tiers, task-group coalescing (best-of and
  // workflow runs), retained workflow headers, and connector geometry. Only
  // row presentation differs per list, injected via ctx.renderRow.
  const renderCoalescedWorkspaceList = (
    workspaces: FrontendWorkspaceMetadata[],
    allRowsForTaskGroupCoalescing: FrontendWorkspaceMetadata[],
    ctx: CoalescedWorkspaceListContext
  ): React.ReactNode => {
    // With age grouping disabled, keep every workspace in the recent path
    // (flat recency-sorted list); full-length empty buckets preserve
    // tier-index assumptions below.
    const { recent: topVisibleRows, buckets } = ageGroupingEnabled
      ? partitionWorkspacesByAge(workspaces, workspaceRecency)
      : {
          recent: workspaces,
          buckets: AGE_THRESHOLDS_DAYS.map((): FrontendWorkspaceMetadata[] => []),
        };

    const expandedTierVisibleIds = new Set<string>();
    const markExpandedTierRowsVisible = (tierIndex: number): void => {
      const bucket = buckets[tierIndex];
      const remainingCount = buckets
        .slice(tierIndex)
        .reduce((sum, bucketRows) => sum + bucketRows.length, 0);
      if (remainingCount === 0) {
        return;
      }

      const tierKey = `${ctx.tierKeyPrefix}:${tierIndex}`;
      const isTierExpanded = expandedOldWorkspaces[tierKey] ?? false;
      if (!isTierExpanded) {
        return;
      }

      for (const workspace of bucket) {
        expandedTierVisibleIds.add(workspace.id);
      }

      const nextTier = findNextNonEmptyTier(buckets, tierIndex + 1);
      if (nextTier !== -1) {
        markExpandedTierRowsVisible(nextTier);
      }
    };

    const firstTier = findNextNonEmptyTier(buckets, 0);
    if (firstTier !== -1) {
      markExpandedTierRowsVisible(firstTier);
    }

    // Connector geometry should match the rows users can currently see,
    // not hidden siblings parked behind collapsed age tiers.
    const visibleRowIds = new Set<string>([
      ...topVisibleRows.map((workspace) => workspace.id),
      ...expandedTierVisibleIds,
    ]);
    const visibleRows = workspaces.filter((workspace) => visibleRowIds.has(workspace.id));
    // Coalesce grouped task rows (best-of + workflow runs)
    // before deriving connector geometry: headers join the row model
    // as synthetic nodes so trunks/elbows stay continuous (D5).
    const taskGroups = computeSidebarTaskGroups({
      rows: visibleRows,
      allRows: allRowsForTaskGroupCoalescing,
      selectedWorkspaceId: selectedWorkspace?.workspaceId,
      isWorkspaceLiveActive,
    });

    for (const group of taskGroups.groupsByStorageKey.values()) {
      if (
        group.kind === "workflow" &&
        (group.hasActiveMember || sessionActiveTaskGroupKeysRef.current.has(group.storageKey))
      ) {
        retainedWorkflowTaskGroupsRef.current.set(group.storageKey, group);
      }
    }

    const retainedWorkflowGroupsByParentId = new Map<string, SidebarTaskGroupModel[]>();
    for (const [storageKey, retainedGroup] of retainedWorkflowTaskGroupsRef.current) {
      if (taskGroups.groupsByStorageKey.has(storageKey)) {
        continue;
      }
      if (!isWorkflowRunActive(retainedGroup.parentWorkspaceId, retainedGroup.id)) {
        retainedWorkflowTaskGroupsRef.current.delete(storageKey);
        sessionActiveTaskGroupKeysRef.current.delete(storageKey);
        continue;
      }
      // The parent's hidden-sub-agents summary replaces retained
      // workflow headers while sub-agent rows are hidden.
      if (hideSubAgentRows) {
        continue;
      }
      if (!visibleRowIds.has(retainedGroup.parentWorkspaceId)) {
        continue;
      }

      const groups = retainedWorkflowGroupsByParentId.get(retainedGroup.parentWorkspaceId) ?? [];
      groups.push({
        ...retainedGroup,
        displayMembers: [],
        // The workflow run itself remains active between transient worker
        // steps, without inventing a running member-task count.
        runningCount: 0,
        queuedCount: 0,
        runActiveWithoutMembers: true,
        hasActiveMember: true,
      });
      retainedWorkflowGroupsByParentId.set(retainedGroup.parentWorkspaceId, groups);
    }

    const rowNodes: SidebarVisibleRowNode[] = [];
    const seenGroupKeys = new Set<string>();
    for (const workspace of visibleRows) {
      const groupKey = taskGroups.memberGroupStorageKeyByWorkspaceId.get(workspace.id);
      const group = groupKey != null ? taskGroups.groupsByStorageKey.get(groupKey) : undefined;
      if (group != null) {
        if (seenGroupKeys.has(group.storageKey)) {
          continue;
        }
        seenGroupKeys.add(group.storageKey);
        const anchorMeta = ctx.baseRowMetaByWorkspaceId.get(workspace.id);
        const headerDepth = anchorMeta?.depth ?? ctx.depthByWorkspaceId[workspace.id] ?? 0;
        rowNodes.push({
          id: group.storageKey,
          parentId: anchorMeta?.visibleParentWorkspaceId ?? group.parentWorkspaceId,
          depth: headerDepth,
          isRunning: group.runningCount > 0,
          baseMeta: {
            depth: headerDepth,
            rowKind: "subagent",
            connectorPosition: "single",
            connectorStartsAtParent: false,
            sharedTrunkActiveThroughRow: false,
            sharedTrunkActiveBelowRow: false,
            ancestorTrunks: [],
            hasHiddenCompletedChildren: false,
            visibleCompletedChildrenCount: 0,
          },
        });
        continue;
      }

      const baseRowMeta = ctx.baseRowMetaByWorkspaceId.get(workspace.id);
      if (!baseRowMeta) {
        continue;
      }
      rowNodes.push({
        id: workspace.id,
        parentId: baseRowMeta.visibleParentWorkspaceId ?? workspace.parentWorkspaceId,
        depth: baseRowMeta.depth,
        isRunning: isSidebarSubAgentRunning(workspace, {
          isWorkspaceLiveActive,
        }),
        baseMeta: baseRowMeta,
      });
      for (const retainedGroup of retainedWorkflowGroupsByParentId.get(workspace.id) ?? []) {
        const headerDepth = baseRowMeta.depth + 1;
        rowNodes.push({
          id: retainedGroup.storageKey,
          parentId: workspace.id,
          depth: headerDepth,
          isRunning: true,
          baseMeta: {
            depth: headerDepth,
            rowKind: "subagent",
            connectorPosition: "single",
            connectorStartsAtParent: false,
            sharedTrunkActiveThroughRow: false,
            sharedTrunkActiveBelowRow: false,
            ancestorTrunks: [],
            hasHiddenCompletedChildren: false,
            visibleCompletedChildrenCount: 0,
          },
        });
      }
    }
    const rowMetaByVisibleWorkspaceId = computeRowMetaForVisibleNodes(rowNodes);

    // Expanded members hang off their header row, so their connector
    // meta derives from the header's computed geometry.
    const memberMetaByWorkspaceId = new Map<string, AgentRowRenderMeta>();
    for (const group of taskGroups.groupsByStorageKey.values()) {
      const headerMeta = rowMetaByVisibleWorkspaceId.get(group.storageKey);
      if (headerMeta == null) {
        continue;
      }
      for (const [memberId, memberMeta] of computeTaskGroupMemberRowMeta({
        group,
        headerMeta,
        headerDepth: headerMeta.depth,
        isWorkspaceLiveActive,
      })) {
        memberMetaByWorkspaceId.set(memberId, memberMeta);
      }
    }

    const renderTaskGroupRows = (group: SidebarTaskGroupModel): React.ReactNode[] => {
      const headerMeta = rowMetaByVisibleWorkspaceId.get(group.storageKey);
      const headerDepth =
        headerMeta?.depth ??
        ctx.depthByWorkspaceId[group.anchorId] ??
        (ctx.depthByWorkspaceId[group.parentWorkspaceId] ?? -1) + 1;

      if (group.kind === "workflow" && group.hasActiveMember) {
        sessionActiveTaskGroupKeysRef.current.add(group.storageKey);
      }
      const defaultExpanded =
        group.kind === "workflow" &&
        (group.hasActiveMember || sessionActiveTaskGroupKeysRef.current.has(group.storageKey));
      const isExpanded = expandedTaskGroups[group.storageKey] ?? defaultExpanded;
      const isGroupSelected = group.allMembers.some(
        (member) => member.id === selectedWorkspace?.workspaceId
      );

      const headerRow = (
        <TaskGroupListItem
          groupId={group.id}
          title={group.title}
          kind={group.kind}
          sectionId={ctx.sectionId}
          depth={headerDepth}
          totalCount={group.totalCount}
          visibleCount={group.displayMembers.length}
          completedCount={group.completedCount}
          isRunActive={group.runActiveWithoutMembers === true}
          runningCount={group.runningCount}
          queuedCount={group.queuedCount}
          interruptedCount={group.interruptedCount}
          isExpanded={isExpanded}
          isSelected={isGroupSelected}
          onToggle={() => {
            toggleTaskGroupExpansion(group.storageKey, isExpanded);
          }}
        />
      );
      const renderedRows: React.ReactNode[] = [
        headerMeta != null ? (
          <SubAgentListItem
            key={`task-group:${group.storageKey}`}
            connectorPosition={headerMeta.connectorPosition}
            connectorStartsAtParent={headerMeta.connectorStartsAtParent}
            sharedTrunkActiveThroughRow={headerMeta.sharedTrunkActiveThroughRow}
            sharedTrunkActiveBelowRow={headerMeta.sharedTrunkActiveBelowRow}
            ancestorTrunks={headerMeta.ancestorTrunks.map((trunk) => ({
              left: getAncestorRailX(trunk.depth, "default"),
              active: trunk.active,
            }))}
            connectorRailX={getSubAgentParentRailX(headerDepth, "default")}
            childStatusCenterX={getSubAgentChildStatusCenterX(headerDepth)}
            isSelected={isGroupSelected}
            isElbowActive={group.runActiveWithoutMembers === true || group.runningCount > 0}
          >
            {headerRow}
          </SubAgentListItem>
        ) : (
          <React.Fragment key={`task-group:${group.storageKey}`}>{headerRow}</React.Fragment>
        ),
      ];

      if (isExpanded) {
        for (const member of group.displayMembers) {
          renderedRows.push(
            ctx.renderRow(member, {
              sectionId: ctx.sectionId,
              rowRenderMeta: memberMetaByWorkspaceId.get(member.id) ?? null,
              depthOverride: getTaskGroupMemberDepth(headerDepth),
              keyOverride: `task-group-member:${group.storageKey}:${member.id}`,
              subAgentConnectorLayout: "task-group-member",
              taskGroupHeaderTitle: group.title,
            })
          );
        }
      }
      return renderedRows;
    };

    const renderWorkspaceRows = (rows: FrontendWorkspaceMetadata[]): React.ReactNode[] => {
      const renderedRows: React.ReactNode[] = [];

      for (const workspace of rows) {
        const groupKey = taskGroups.memberGroupStorageKeyByWorkspaceId.get(workspace.id);
        const group = groupKey != null ? taskGroups.groupsByStorageKey.get(groupKey) : undefined;
        if (group == null) {
          renderedRows.push(
            ctx.renderRow(workspace, {
              sectionId: ctx.sectionId,
              rowRenderMeta: rowMetaByVisibleWorkspaceId.get(workspace.id),
            })
          );
          for (const retainedGroup of retainedWorkflowGroupsByParentId.get(workspace.id) ?? []) {
            renderedRows.push(...renderTaskGroupRows(retainedGroup));
          }
          continue;
        }

        if (group.anchorId !== workspace.id) {
          // Non-anchor members render under the group header at the
          // anchor's position (D5), so suppress them here.
          continue;
        }

        renderedRows.push(...renderTaskGroupRows(group));
      }

      return renderedRows;
    };

    const renderTier = (tierIndex: number): React.ReactNode => {
      const bucket = buckets[tierIndex];
      const remainingCount = buckets.slice(tierIndex).reduce((sum, b) => sum + b.length, 0);

      if (remainingCount === 0) return null;

      const tierKey = `${ctx.tierKeyPrefix}:${tierIndex}`;
      const isTierExpanded = expandedOldWorkspaces[tierKey] ?? false;
      const thresholdDays = AGE_THRESHOLDS_DAYS[tierIndex];
      const thresholdLabel = formatDaysThreshold(thresholdDays);
      const displayCount = isTierExpanded ? bucket.length : remainingCount;

      return (
        <React.Fragment key={tierKey}>
          <button
            onClick={() => {
              setExpandedOldWorkspaces((prev) => ({
                ...prev,
                [tierKey]: !prev[tierKey],
              }));
            }}
            aria-label={
              isTierExpanded
                ? `Collapse workspaces older than ${thresholdLabel}`
                : `Expand workspaces older than ${thresholdLabel}`
            }
            aria-expanded={isTierExpanded}
            className={cn(
              "text-muted border-hover hover:text-label [&:hover_.arrow]:text-label flex w-full cursor-pointer items-center gap-1 border-t border-none bg-transparent px-3 py-2 text-xs font-medium transition-all duration-150 hover:bg-white/3",
              ctx.tierButtonClassName
            )}
          >
            <span
              className="arrow text-dim text-[11px] transition-transform duration-200 ease-in-out"
              style={{
                transform: isTierExpanded ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </span>
            <div className="flex items-center gap-1.5">
              <span>Older than {thresholdLabel}</span>
              <span className="text-dim font-normal">({displayCount})</span>
            </div>
          </button>
          {isTierExpanded && (
            <>
              {renderWorkspaceRows(bucket)}
              {(() => {
                const nextTier = findNextNonEmptyTier(buckets, tierIndex + 1);
                return nextTier !== -1 ? renderTier(nextTier) : null;
              })()}
            </>
          )}
        </React.Fragment>
      );
    };

    return (
      <>
        {renderWorkspaceRows(topVisibleRows)}
        {firstTier !== -1 && renderTier(firstTier)}
      </>
    );
  };

  const renderFlatRow = (
    metadata: FrontendWorkspaceMetadata,
    opts?: CoalescedRowRenderOptions
  ): React.ReactNode => {
    const rowRenderMeta =
      opts?.rowRenderMeta === undefined
        ? flatRowMetaByWorkspaceId.get(metadata.id)
        : (opts.rowRenderMeta ?? undefined);
    const badge = getFlatProjectBadge(metadata);
    return (
      <AgentListItem
        key={opts?.keyOverride ?? metadata.id}
        metadata={metadata}
        projectPath={metadata.projectPath}
        projectName={metadata.projectName}
        projectBadgeName={badge?.name}
        projectBadgeColor={badge?.color}
        isSelected={selectedWorkspace?.workspaceId === metadata.id}
        isArchiving={archivingWorkspaceIds.has(metadata.id)}
        isRemoving={removingWorkspaceIds.has(metadata.id) || metadata.isRemoving === true}
        onSelectWorkspace={handleSelectWorkspace}
        onForkWorkspace={handleForkWorkspace}
        onStopRuntime={handleStopRuntime}
        onArchiveWorkspace={handleArchiveWorkspace}
        onCancelCreation={handleCancelWorkspaceCreation}
        depth={
          opts?.depthOverride ?? rowRenderMeta?.depth ?? flatDepthByWorkspaceId[metadata.id] ?? 0
        }
        pinnedReorderGroup={FLAT_PINNED_REORDER_GROUP}
        onPinnedReorderDrop={handlePinnedReorderDrop}
        rowRenderMeta={rowRenderMeta}
        subAgentConnectorLayout={opts?.subAgentConnectorLayout}
        taskGroupHeaderTitle={opts?.taskGroupHeaderTitle}
        isWorkspaceLiveActive={isWorkspaceLiveActive(metadata.id)}
        delegatedActivity={delegatedActivityByWorkspaceId.get(metadata.id)}
        hiddenSubAgentsSummary={getHiddenSubAgentsSummary(metadata.id)}
        getWorkflowRunName={getWorkflowRunName}
        completedChildrenExpanded={expandedCompletedParentIds.has(metadata.id)}
        onToggleCompletedChildren={toggleCompletedChildrenExpansion}
      />
    );
  };

  const flatSidebarContent = (
    <div className="py-1">
      <button
        onClick={handleAddScratchWorkspace}
        className="text-secondary hover:bg-hover mx-2 mb-1 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs"
      >
        <Plus className="h-3.5 w-3.5" />
        New chat
      </button>
      {renderCoalescedWorkspaceList(visiblePinnedFlatWorkspaces, flatRowsForDisplay, {
        tierKeyPrefix: "flat",
        depthByWorkspaceId: flatDepthByWorkspaceId,
        baseRowMetaByWorkspaceId: flatRowMetaByWorkspaceId,
        renderRow: renderFlatRow,
      })}
      {flatDrafts.map(({ projectPath, draft }, index) => {
        const promotedMetadata = flatDraftPromotionsByDraftId.get(draft.draftId);
        if (promotedMetadata) {
          // The just-created workspace renders in the draft's position while
          // the draft entry is still present (grouped mode does the same).
          const liveMetadata =
            flatWorkspaces.find((workspace) => workspace.id === promotedMetadata.id) ??
            promotedMetadata;
          return <React.Fragment key={draft.draftId}>{renderFlatRow(liveMetadata)}</React.Fragment>;
        }
        const isSelected =
          pendingNewWorkspaceProject === projectPath &&
          pendingNewWorkspaceDraftId === draft.draftId;
        const draftBadge = getFlatDraftBadge(projectPath, draft.subProjectPath);
        return (
          <DraftAgentListItemWrapper
            key={draft.draftId}
            projectPath={projectPath}
            draftId={draft.draftId}
            draftNumber={index + 1}
            isSelected={isSelected}
            projectBadgeName={draftBadge?.name}
            projectBadgeColor={draftBadge?.color}
            onVisibilityChange={(isVisible) => {
              handleDraftVisibilityChange(projectPath, draft.draftId, isVisible);
            }}
            onOpen={() => handleOpenWorkspaceDraft(projectPath, draft.draftId)}
            onDelete={() => {
              if (isSelected) {
                // Mirror grouped-mode deletion: hand selection to an adjacent
                // remaining draft, falling back to the project route only when
                // this was the last one.
                const fallback = flatDrafts[index + 1] ?? flatDrafts[index - 1];
                if (fallback) {
                  openWorkspaceDraft(fallback.projectPath, fallback.draft.draftId);
                } else {
                  navigateToProject(projectPath);
                }
              }
              deleteWorkspaceDraft(projectPath, draft.draftId);
            }}
          />
        );
      })}
      {renderCoalescedWorkspaceList(visibleUnpinnedFlatWorkspaces, flatRowsForDisplay, {
        tierKeyPrefix: "flat",
        depthByWorkspaceId: flatDepthByWorkspaceId,
        baseRowMetaByWorkspaceId: flatRowMetaByWorkspaceId,
        renderRow: renderFlatRow,
      })}
    </div>
  );

  return (
    <TitleEditProvider onUpdateTitle={onUpdateTitle}>
      <SidebarTitleEditKeybinds
        selectedWorkspace={selectedWorkspace ?? undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        collapsed={collapsed}
      />
      <DndProvider backend={HTML5Backend}>
        <ProjectDragLayer />
        <WorkspaceDragLayer />
        <div
          className={cn(
            // The sidebar doubles as a drag surface, so keep copy selection disabled
            // unless a child input explicitly opts back into text selection.
            "font-primary bg-surface-primary border-border-light relative flex flex-1 select-none flex-col overflow-hidden border-r",
            // In desktop mode when collapsed, hide border (LeftSidebar handles the partial border)
            isDesktopMode() && collapsed && "border-r-0"
          )}
          role="navigation"
          aria-label="Projects"
        >
          {!collapsed && (
            <>
              <div className="border-dark flex items-center justify-between border-b py-3 pr-3 pl-4">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    onClick={handleGoHome}
                    className="shrink-0 cursor-pointer border-none bg-transparent p-0"
                    aria-label="Home"
                  >
                    <XumLogo className="h-5 w-auto" aria-hidden="true" />
                  </button>
                </div>
                <button
                  onClick={() => onAddProject()}
                  aria-label="Add project"
                  className="text-secondary hover:bg-hover hover:border-border-light flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-1.5 text-xs transition-all duration-200"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Add Project</span>
                </button>
              </div>
              <ScrollArea
                className="flex-1"
                viewportRef={projectListScrollRef}
                onViewportScroll={handleProjectListScroll}
                viewportClassName="overflow-x-hidden"
              >
                {flatSidebarEnabled && flatSidebarContent}
                {!flatSidebarEnabled && (
                  <div>
                    <div className={PROJECT_ITEM_BASE_CLASS}>
                      <button
                        onClick={() => toggleProject(SCRATCH_SIDEBAR_SECTION_ID)}
                        aria-label={`${isScratchSectionExpanded ? "Collapse" : "Expand"} scratch chats`}
                        className={PROJECT_TOGGLE_BUTTON_CLASSES}
                      >
                        <ChevronRight
                          className="h-4 w-4 transition-transform duration-200"
                          style={{
                            transform: isScratchSectionExpanded ? "rotate(90deg)" : "rotate(0deg)",
                          }}
                        />
                      </button>
                      <div className="flex min-w-0 flex-1 items-center pr-1">
                        <span className="text-foreground truncate text-sm font-medium">Chats</span>
                        {(scratchWorkspaces.length > 0 || scratchDrafts.length > 0) && (
                          <span className="text-muted ml-2 text-xs">
                            ({topLevelScratchWorkspaces.length + scratchDrafts.length})
                          </span>
                        )}
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              handleAddScratchWorkspace();
                            }}
                            aria-label="New scratch chat"
                            className="text-content-secondary hover:bg-hover hover:border-border-light flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>New scratch chat</TooltipContent>
                      </Tooltip>
                    </div>
                    {isScratchSectionExpanded && (
                      <div className="pt-1 pb-1">
                        {scratchDrafts.map((draft, index) => {
                          const isSelected =
                            pendingNewWorkspaceProject === SCRATCH_PROJECT_CONFIG_KEY &&
                            pendingNewWorkspaceDraftId === draft.draftId;
                          return (
                            <DraftAgentListItemWrapper
                              key={draft.draftId}
                              projectPath={SCRATCH_PROJECT_CONFIG_KEY}
                              draftId={draft.draftId}
                              draftNumber={index + 1}
                              isSelected={isSelected}
                              onVisibilityChange={(isVisible) => {
                                handleDraftVisibilityChange(
                                  SCRATCH_PROJECT_CONFIG_KEY,
                                  draft.draftId,
                                  isVisible
                                );
                              }}
                              onOpen={() =>
                                handleOpenWorkspaceDraft(SCRATCH_PROJECT_CONFIG_KEY, draft.draftId)
                              }
                              onDelete={() => {
                                if (isSelected) {
                                  navigateToProject(SCRATCH_PROJECT_CONFIG_KEY);
                                }
                                deleteWorkspaceDraft(SCRATCH_PROJECT_CONFIG_KEY, draft.draftId);
                              }}
                            />
                          );
                        })}
                        {visibleScratchWorkspaces.map((metadata) => {
                          const rowRenderMeta = scratchRowMetaByWorkspaceId.get(metadata.id);
                          return (
                            <AgentListItem
                              key={metadata.id}
                              metadata={metadata}
                              projectPath={metadata.projectPath}
                              projectName={metadata.projectName}
                              isSelected={selectedWorkspace?.workspaceId === metadata.id}
                              isArchiving={archivingWorkspaceIds.has(metadata.id)}
                              isRemoving={
                                removingWorkspaceIds.has(metadata.id) ||
                                metadata.isRemoving === true
                              }
                              onSelectWorkspace={handleSelectWorkspace}
                              onForkWorkspace={handleForkWorkspace}
                              onArchiveWorkspace={handleArchiveWorkspace}
                              onCancelCreation={handleCancelWorkspaceCreation}
                              depth={
                                rowRenderMeta?.depth ?? scratchDepthByWorkspaceId[metadata.id] ?? 0
                              }
                              pinnedReorderGroup={SCRATCH_PINNED_REORDER_GROUP}
                              onPinnedReorderDrop={handlePinnedReorderDrop}
                              rowRenderMeta={rowRenderMeta}
                              isWorkspaceLiveActive={isWorkspaceLiveActive(metadata.id)}
                              delegatedActivity={delegatedActivityByWorkspaceId.get(metadata.id)}
                              hiddenSubAgentsSummary={getHiddenSubAgentsSummary(metadata.id)}
                              getWorkflowRunName={getWorkflowRunName}
                              completedChildrenExpanded={expandedCompletedParentIds.has(
                                metadata.id
                              )}
                              onToggleCompletedChildren={toggleCompletedChildrenExpansion}
                            />
                          );
                        })}
                        {scratchWorkspaces.length === 0 && scratchDrafts.length === 0 && (
                          <button
                            onClick={handleAddScratchWorkspace}
                            className="text-muted hover:bg-hover mx-2 w-[calc(100%-1rem)] rounded px-2 py-2 text-left text-xs"
                          >
                            Start a scratch chat
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {!flatSidebarEnabled && multiProjectWorkspaces.length > 0 && (
                  <div>
                    <div className={PROJECT_ITEM_BASE_CLASS}>
                      <button
                        onClick={() => toggleProject(MULTI_PROJECT_SIDEBAR_SECTION_ID)}
                        aria-label={`${isMultiProjectSectionExpanded ? "Collapse" : "Expand"} multi-project workspaces`}
                        className={PROJECT_TOGGLE_BUTTON_CLASSES}
                      >
                        <span className="relative flex h-4 w-4 items-center justify-center">
                          <ChevronRight
                            className="absolute inset-0 h-4 w-4 opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100"
                            style={{
                              transform: isMultiProjectSectionExpanded
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            }}
                          />
                          {isMultiProjectSectionExpanded ? (
                            <FolderOpen className="h-4 w-4 transition-opacity duration-200 group-hover:opacity-0" />
                          ) : (
                            <Folder className="h-4 w-4 transition-opacity duration-200 group-hover:opacity-0" />
                          )}
                        </span>
                      </button>
                      <div className="flex min-w-0 flex-1 items-center pr-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          Multi-Project
                        </span>
                        <span className="text-muted ml-2 text-xs">
                          ({topLevelMultiProjectWorkspaces.length})
                        </span>
                      </div>
                    </div>
                    {isMultiProjectSectionExpanded && (
                      <div className="pt-1 pb-1">
                        {visibleMultiProjectWorkspaces.map((metadata) => {
                          const rowRenderMeta = multiProjectRowMetaByWorkspaceId.get(metadata.id);

                          return (
                            <AgentListItem
                              key={metadata.id}
                              metadata={metadata}
                              projectPath={metadata.projectPath}
                              projectName={metadata.projectName}
                              isSelected={selectedWorkspace?.workspaceId === metadata.id}
                              isArchiving={archivingWorkspaceIds.has(metadata.id)}
                              isRemoving={
                                removingWorkspaceIds.has(metadata.id) ||
                                metadata.isRemoving === true
                              }
                              onSelectWorkspace={handleSelectWorkspace}
                              onForkWorkspace={handleForkWorkspace}
                              onArchiveWorkspace={handleArchiveWorkspace}
                              onCancelCreation={handleCancelWorkspaceCreation}
                              depth={
                                rowRenderMeta?.depth ??
                                multiProjectDepthByWorkspaceId[metadata.id] ??
                                0
                              }
                              pinnedReorderGroup={MULTI_PROJECT_PINNED_REORDER_GROUP}
                              onPinnedReorderDrop={handlePinnedReorderDrop}
                              rowRenderMeta={rowRenderMeta}
                              isWorkspaceLiveActive={isWorkspaceLiveActive(metadata.id)}
                              delegatedActivity={delegatedActivityByWorkspaceId.get(metadata.id)}
                              hiddenSubAgentsSummary={getHiddenSubAgentsSummary(metadata.id)}
                              getWorkflowRunName={getWorkflowRunName}
                              completedChildrenExpanded={expandedCompletedParentIds.has(
                                metadata.id
                              )}
                              onToggleCompletedChildren={toggleCompletedChildrenExpansion}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {!flatSidebarEnabled &&
                projectHeaderPaths.length === 0 &&
                multiProjectWorkspaces.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-muted mb-4 text-[13px]">No projects</p>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={handleAddScratchWorkspace}
                        className="bg-accent hover:bg-accent-dark cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white transition-colors duration-200"
                      >
                        Start a scratch chat
                      </button>
                      <button
                        onClick={() => onAddProject()}
                        className="border-border-light text-secondary hover:bg-hover cursor-pointer rounded border px-4 py-2 text-[13px] transition-colors duration-200"
                      >
                        Add Project
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {flatSidebarEnabled && projectHeaderPaths.length > 0 && (
                      <div className="text-muted border-hover mt-1 border-t px-3 py-2 text-xs font-medium">
                        Projects
                      </div>
                    )}
                    {projectHeaderPaths.map((projectPath) => {
                      const config = userProjects.get(projectPath);
                      if (!config) return null;
                      const projectFolderColor = config.color
                        ? resolveSectionColor(config.color)
                        : undefined;
                      const projectName = getProjectNameFromPath(projectPath);
                      const sanitizedProjectId =
                        projectPath.replace(/[^a-zA-Z0-9_-]/g, "-") || "root";
                      const workspaceListId = `workspace-list-${sanitizedProjectId}`;
                      const isExpanded = expandedProjectsList.includes(projectPath);
                      const displayProjectName =
                        config.displayName ?? getProjectFallbackLabel(projectPath);
                      const isEditingProjectDisplayName = editingProjectPath === projectPath;
                      const projectWorkspaces =
                        singleProjectWorkspacesByProject.get(projectPath) ?? [];
                      const topLevelProjectWorkspaces = excludeSubAgentRows(projectWorkspaces);
                      const projectAgentCount = topLevelProjectWorkspaces.length;
                      const projectHasAttention = projectWorkspaces.some(
                        (workspace) => workspaceAttentionById.get(workspace.id) === true
                      );

                      // Shared by the grouped section drop zones and the flat
                      // management rows so chats can be assigned to (or cleared
                      // from) a sub-project in both modes.
                      const handleWorkspaceSectionDrop = (
                        workspaceId: string,
                        targetSectionId: string | null
                      ) => {
                        void (async () => {
                          const result = await assignWorkspaceToSubProject(
                            projectPath,
                            workspaceId,
                            targetSectionId
                          );
                          if (result.success) {
                            // Refresh workspace metadata so UI shows updated sectionId
                            await refreshWorkspaceMetadata();
                          }
                        })();
                      };

                      const projectHeaderRow = (
                        <DraggableProjectItem
                          projectPath={projectPath}
                          onReorder={handleReorder}
                          selected={false}
                          onClick={() => {
                            if (projectContextMenu.suppressClickIfLongPress()) {
                              return;
                            }
                            if (isEditingProjectDisplayName) {
                              return;
                            }
                            handleAddWorkspace(projectPath);
                          }}
                          onContextMenu={(event) => handleOpenProjectMenu(event, projectPath)}
                          onTouchStart={(event) =>
                            handleProjectContextMenuTouchStart(event, projectPath)
                          }
                          onTouchEnd={projectContextMenu.touchHandlers.onTouchEnd}
                          onTouchMove={projectContextMenu.touchHandlers.onTouchMove}
                          onKeyDown={(e: React.KeyboardEvent) => {
                            // Ignore key events from child buttons
                            if (e.target instanceof HTMLElement && e.target !== e.currentTarget) {
                              return;
                            }
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleAddWorkspace(projectPath);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={flatSidebarEnabled ? undefined : isExpanded}
                          aria-controls={flatSidebarEnabled ? undefined : workspaceListId}
                          aria-label={`Create workspace in ${projectName}`}
                          data-project-path={projectPath}
                        >
                          {flatSidebarEnabled ? (
                            // Flat mode has no per-project chat nesting to
                            // expand, so the folder renders as a static icon.
                            <span className="text-secondary mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center">
                              <Folder
                                className="h-4 w-4"
                                style={
                                  projectFolderColor ? { color: projectFolderColor } : undefined
                                }
                              />
                            </span>
                          ) : (
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleProject(projectPath);
                              }}
                              aria-label={`${isExpanded ? "Collapse" : "Expand"} project ${projectName}`}
                              data-project-path={projectPath}
                              className={PROJECT_TOGGLE_BUTTON_CLASSES}
                            >
                              <span className="relative flex h-4 w-4 items-center justify-center">
                                <ChevronRight
                                  className="absolute inset-0 h-4 w-4 opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100"
                                  style={{
                                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                  }}
                                />
                                {isExpanded ? (
                                  <FolderOpen
                                    className="h-4 w-4 transition-opacity duration-200 group-hover:opacity-0"
                                    style={
                                      projectFolderColor ? { color: projectFolderColor } : undefined
                                    }
                                  />
                                ) : (
                                  <Folder
                                    className="h-4 w-4 transition-opacity duration-200 group-hover:opacity-0"
                                    style={
                                      projectFolderColor ? { color: projectFolderColor } : undefined
                                    }
                                  />
                                )}
                              </span>
                            </button>
                          )}
                          <div
                            className="flex min-w-0 flex-1 items-center pr-1"
                            onContextMenu={(event) => handleOpenProjectMenu(event, projectPath)}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                {isEditingProjectDisplayName ? (
                                  <input
                                    value={editingProjectDisplayName}
                                    autoFocus
                                    aria-label={`Edit project name for ${projectName}`}
                                    className="bg-background text-foreground border-border-light h-6 w-full rounded border px-2 text-sm"
                                    onClick={(event) => event.stopPropagation()}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onContextMenu={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                      setEditingProjectDisplayName(event.target.value);
                                    }}
                                    onKeyDown={(event) => {
                                      stopKeyboardPropagation(event);
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        skipNextProjectNameBlurCommitRef.current = true;
                                        cancelProjectDisplayNameEditing();
                                        return;
                                      }

                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    onBlur={(event) => {
                                      event.stopPropagation();
                                      if (skipNextProjectNameBlurCommitRef.current) {
                                        skipNextProjectNameBlurCommitRef.current = false;
                                        return;
                                      }
                                      void commitProjectDisplayNameEdit(
                                        projectPath,
                                        event.currentTarget.value
                                      );
                                    }}
                                  />
                                ) : (
                                  <div className="text-muted-dark flex min-w-0 items-baseline gap-1.5 text-sm">
                                    <span
                                      className={cn(
                                        "min-w-0 flex-1 truncate font-medium",
                                        projectHasAttention
                                          ? "text-content-primary"
                                          : "text-content-secondary"
                                      )}
                                    >
                                      {displayProjectName}
                                    </span>
                                    <span
                                      className={cn(
                                        "shrink-0 text-xs",
                                        projectHasAttention
                                          ? "text-content-secondary"
                                          : "text-muted"
                                      )}
                                    >
                                      ({projectAgentCount})
                                    </span>
                                  </div>
                                )}
                              </TooltipTrigger>
                              <TooltipContent align="start">{projectPath}</TooltipContent>
                            </Tooltip>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleAddWorkspace(projectPath);
                                }}
                                aria-label={`New chat in ${projectName}`}
                                data-project-path={projectPath}
                                className="text-content-secondary hover:bg-hover hover:border-border-light pointer-events-none flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent text-sm leading-none opacity-0 transition-all duration-200 focus-visible:pointer-events-auto focus-visible:opacity-100"
                              >
                                <Plus className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              New chat ({formatKeybind(KEYBINDS.NEW_WORKSPACE)})
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleOpenProjectMenu(event, projectPath);
                                }}
                                aria-label={`Project options for ${projectName}`}
                                data-project-path={projectPath}
                                className={cn(
                                  "text-content-secondary hover:bg-hover hover:border-border-light flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent transition-all duration-200 focus-visible:pointer-events-auto focus-visible:opacity-100",
                                  projectContextMenu.isOpen && projectMenuTargetPath === projectPath
                                    ? "pointer-events-auto opacity-100"
                                    : "pointer-events-none opacity-0"
                                )}
                              >
                                <EllipsisVertical className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent align="end">Project options</TooltipContent>
                          </Tooltip>
                        </DraggableProjectItem>
                      );

                      return (
                        <div key={projectPath}>
                          {flatSidebarEnabled ? (
                            // Dropping a chat on the project header clears its
                            // sub-project assignment, mirroring the grouped
                            // unsectioned drop zone.
                            <WorkspaceSectionDropZone
                              projectPath={projectPath}
                              sectionId={null}
                              onDrop={handleWorkspaceSectionDrop}
                              testId={`flat-unsection-drop-${sanitizedProjectId}`}
                            >
                              {projectHeaderRow}
                            </WorkspaceSectionDropZone>
                          ) : (
                            projectHeaderRow
                          )}

                          {/* Flat mode keeps sub-project management reachable:
                              the same SectionHeader controls (scoped new chat,
                              rename, color, delete) render as compact rows with
                              nothing nested beneath them. */}
                          {flatSidebarEnabled &&
                            getSubProjectsForParent(projectPath, userProjects).map(
                              ([subProjectPath, subProjectConfig]) => {
                                const sectionRows = topLevelProjectWorkspaces.filter(
                                  (workspace) => workspace.subProjectPath === subProjectPath
                                );
                                // Grouped mode counts a section's drafts too;
                                // mirror that so toggling modes never changes
                                // the displayed count.
                                const sectionDraftCount = (
                                  workspaceDraftsByProject[projectPath] ?? []
                                ).filter((draft) => draft.subProjectPath === subProjectPath).length;
                                const shouldAutoEditSection =
                                  autoEditingSection?.projectPath === projectPath &&
                                  autoEditingSection?.sectionId === subProjectPath;
                                return (
                                  <WorkspaceSectionDropZone
                                    key={subProjectPath}
                                    projectPath={projectPath}
                                    sectionId={subProjectPath}
                                    onDrop={handleWorkspaceSectionDrop}
                                    className="pl-4"
                                  >
                                    <SectionHeader
                                      section={{
                                        id: subProjectPath,
                                        name: getProjectDisplayName(
                                          subProjectPath,
                                          subProjectConfig
                                        ),
                                        color: subProjectConfig.color,
                                      }}
                                      isExpanded={false}
                                      workspaceCount={sectionRows.length + sectionDraftCount}
                                      hasAttention={sectionRows.some(
                                        (workspace) =>
                                          workspaceAttentionById.get(workspace.id) === true
                                      )}
                                      onAddWorkspace={() => {
                                        handleAddWorkspace(projectPath, subProjectPath);
                                      }}
                                      onRename={(name) => {
                                        if (shouldAutoEditSection) {
                                          setAutoEditingSection(null);
                                        }
                                        void updateDisplayName(subProjectPath, name);
                                      }}
                                      onChangeColor={(color) => {
                                        void updateProjectColor(subProjectPath, color);
                                      }}
                                      autoStartEditing={shouldAutoEditSection}
                                      onAutoCreateAbandon={
                                        shouldAutoEditSection
                                          ? () => {
                                              void (async () => {
                                                setAutoEditingSection(null);
                                                await handleRemoveSection(
                                                  projectPath,
                                                  subProjectPath
                                                );
                                              })();
                                            }
                                          : undefined
                                      }
                                      onAutoCreateRenameCancel={
                                        shouldAutoEditSection
                                          ? () => {
                                              setAutoEditingSection(null);
                                            }
                                          : undefined
                                      }
                                      onDelete={(anchorEl) => {
                                        void handleRemoveSection(
                                          projectPath,
                                          subProjectPath,
                                          anchorEl
                                        );
                                      }}
                                    />
                                  </WorkspaceSectionDropZone>
                                );
                              }
                            )}

                          {!flatSidebarEnabled && isExpanded && (
                            <div
                              id={workspaceListId}
                              role="region"
                              aria-label={`Workspaces for ${projectName}`}
                              className="pt-1"
                            >
                              {(() => {
                                // Archived workspaces are excluded from workspaceMetadata so won't appear here

                                const draftsForProject =
                                  workspaceDraftsByProject[projectPath] ?? [];
                                const activeDraftIds = new Set(
                                  draftsForProject.map((draft) => draft.draftId)
                                );
                                const draftPromotionsForProject =
                                  workspaceDraftPromotionsByProject[projectPath] ?? {};
                                const activeDraftPromotions = Object.fromEntries(
                                  Object.entries(draftPromotionsForProject).filter(([draftId]) =>
                                    activeDraftIds.has(draftId)
                                  )
                                );
                                const promotedWorkspaceIds = new Set(
                                  Object.values(activeDraftPromotions).map(
                                    (metadata) => metadata.id
                                  )
                                );
                                const projectRowsForDisplay = hideSubAgentRows
                                  ? topLevelProjectWorkspaces
                                  : projectWorkspaces;
                                const workspacesForNormalRendering = projectRowsForDisplay.filter(
                                  (workspace) => !promotedWorkspaceIds.has(workspace.id)
                                );
                                const sections: SectionConfig[] = getSubProjectsForParent(
                                  projectPath,
                                  userProjects
                                ).map(([subProjectPath, subProjectConfig]) => ({
                                  id: subProjectPath,
                                  name: getProjectDisplayName(subProjectPath, subProjectConfig),
                                  color: subProjectConfig.color,
                                }));
                                const depthByWorkspaceId =
                                  computeWorkspaceDepthMap(projectWorkspaces);
                                // Track runs that are (or were, this session) active so their
                                // groups stay mounted across step gaps where every member is
                                // momentarily terminal (no flash-out between sequential steps).
                                for (const key of collectActiveWorkflowGroupKeys(
                                  workspacesForNormalRendering,
                                  { isWorkspaceLiveActive }
                                )) {
                                  sessionActiveTaskGroupKeysRef.current.add(key);
                                }
                                const visibleWorkspacesForNormalRendering = filterVisibleAgentRows(
                                  workspacesForNormalRendering,
                                  expandedCompletedParentIds,
                                  { isWorkspaceLiveActive }
                                );
                                const baseRowMetaByWorkspaceId = computeAgentRowRenderMeta(
                                  workspacesForNormalRendering,
                                  depthByWorkspaceId,
                                  expandedCompletedParentIds,
                                  { isWorkspaceLiveActive }
                                );
                                const sortedDrafts = draftsForProject
                                  .slice()
                                  .sort((a, b) => b.createdAt - a.createdAt);
                                const draftVisibilityForProject =
                                  draftVisibilityByProject[projectPath] ?? {};
                                const hasVisibleDrafts = sortedDrafts.some((draft) => {
                                  const reactiveVisibility =
                                    draftVisibilityForProject[draft.draftId];
                                  return (
                                    reactiveVisibility ?? isDraftVisible(projectPath, draft.draftId)
                                  );
                                });
                                const projectHasNoAgentsOrDrafts =
                                  projectWorkspaces.length === 0 && !hasVisibleDrafts;
                                const draftNumberById = new Map(
                                  sortedDrafts.map(
                                    (draft, index) => [draft.draftId, index + 1] as const
                                  )
                                );
                                const getDraftSectionId = (
                                  draft: (typeof sortedDrafts)[number]
                                ): string | null =>
                                  typeof draft.subProjectPath === "string" &&
                                  userProjects.get(draft.subProjectPath)?.parentProjectPath ===
                                    projectPath
                                    ? draft.subProjectPath
                                    : null;

                                // Drafts can reference a section that has since been deleted.
                                // Treat those as unsectioned so they remain accessible.
                                const unsectionedDrafts: typeof sortedDrafts = [];
                                const draftsBySectionId = new Map<string, typeof sortedDrafts>();
                                for (const draft of sortedDrafts) {
                                  const sectionId = getDraftSectionId(draft);
                                  if (sectionId === null) {
                                    unsectionedDrafts.push(draft);
                                    continue;
                                  }

                                  const existing = draftsBySectionId.get(sectionId);
                                  if (existing) {
                                    existing.push(draft);
                                  } else {
                                    draftsBySectionId.set(sectionId, [draft]);
                                  }
                                }

                                const renderWorkspace = (
                                  metadata: FrontendWorkspaceMetadata,
                                  sectionId?: string,
                                  rowRenderMetaOverride?: AgentRowRenderMeta | null,
                                  depthOverride?: number,
                                  keyOverride?: string,
                                  subAgentConnectorLayout?: "default" | "task-group-member",
                                  taskGroupHeaderTitle?: string
                                ) => {
                                  const rowRenderMeta =
                                    rowRenderMetaOverride === undefined
                                      ? baseRowMetaByWorkspaceId.get(metadata.id)
                                      : (rowRenderMetaOverride ?? undefined);

                                  return (
                                    <AgentListItem
                                      key={keyOverride ?? metadata.id}
                                      metadata={metadata}
                                      projectPath={projectPath}
                                      projectName={projectName}
                                      isSelected={selectedWorkspace?.workspaceId === metadata.id}
                                      isArchiving={archivingWorkspaceIds.has(metadata.id)}
                                      isRemoving={
                                        removingWorkspaceIds.has(metadata.id) ||
                                        metadata.isRemoving === true
                                      }
                                      onSelectWorkspace={handleSelectWorkspace}
                                      onForkWorkspace={handleForkWorkspace}
                                      onStopRuntime={handleStopRuntime}
                                      onArchiveWorkspace={handleArchiveWorkspace}
                                      onCancelCreation={handleCancelWorkspaceCreation}
                                      depth={
                                        depthOverride ??
                                        rowRenderMeta?.depth ??
                                        depthByWorkspaceId[metadata.id] ??
                                        0
                                      }
                                      sectionId={sectionId}
                                      pinnedReorderGroup={getPinnedReorderGroup(
                                        projectPath,
                                        sectionId
                                      )}
                                      onPinnedReorderDrop={handlePinnedReorderDrop}
                                      rowRenderMeta={rowRenderMeta}
                                      subAgentConnectorLayout={subAgentConnectorLayout}
                                      taskGroupHeaderTitle={taskGroupHeaderTitle}
                                      isWorkspaceLiveActive={isWorkspaceLiveActive(metadata.id)}
                                      delegatedActivity={delegatedActivityByWorkspaceId.get(
                                        metadata.id
                                      )}
                                      hiddenSubAgentsSummary={getHiddenSubAgentsSummary(
                                        metadata.id
                                      )}
                                      getWorkflowRunName={getWorkflowRunName}
                                      completedChildrenExpanded={expandedCompletedParentIds.has(
                                        metadata.id
                                      )}
                                      onToggleCompletedChildren={toggleCompletedChildrenExpansion}
                                    />
                                  );
                                };

                                const renderDraft = (
                                  draft: (typeof sortedDrafts)[number]
                                ): React.ReactNode => {
                                  const sectionId = getDraftSectionId(draft);
                                  const promotedMetadata = activeDraftPromotions[draft.draftId];

                                  if (promotedMetadata) {
                                    const liveMetadata =
                                      projectWorkspaces.find(
                                        (workspace) => workspace.id === promotedMetadata.id
                                      ) ?? promotedMetadata;
                                    return renderWorkspace(liveMetadata, sectionId ?? undefined);
                                  }

                                  const draftNumber = draftNumberById.get(draft.draftId) ?? 0;
                                  const isSelected =
                                    pendingNewWorkspaceProject === projectPath &&
                                    pendingNewWorkspaceDraftId === draft.draftId;

                                  return (
                                    <DraftAgentListItemWrapper
                                      key={draft.draftId}
                                      projectPath={projectPath}
                                      draftId={draft.draftId}
                                      draftNumber={draftNumber}
                                      isSelected={isSelected}
                                      sectionId={sectionId ?? undefined}
                                      onVisibilityChange={(isVisible) => {
                                        handleDraftVisibilityChange(
                                          projectPath,
                                          draft.draftId,
                                          isVisible
                                        );
                                      }}
                                      onOpen={() =>
                                        handleOpenWorkspaceDraft(projectPath, draft.draftId)
                                      }
                                      onDelete={() => {
                                        if (isSelected) {
                                          const currentIndex = sortedDrafts.findIndex(
                                            (d) => d.draftId === draft.draftId
                                          );
                                          const fallback =
                                            currentIndex >= 0
                                              ? (sortedDrafts[currentIndex + 1] ??
                                                sortedDrafts[currentIndex - 1])
                                              : undefined;

                                          if (fallback) {
                                            openWorkspaceDraft(projectPath, fallback.draftId);
                                          } else {
                                            navigateToProject(sectionId ?? projectPath);
                                          }
                                        }

                                        deleteWorkspaceDraft(projectPath, draft.draftId);
                                      }}
                                    />
                                  );
                                };

                                // Render age tiers for a list of workspaces
                                const renderAgeTiers = (
                                  workspaces: FrontendWorkspaceMetadata[],
                                  tierKeyPrefix: string,
                                  sectionId?: string,
                                  allRowsForTaskGroupCoalescing: FrontendWorkspaceMetadata[] = workspaces
                                ): React.ReactNode =>
                                  renderCoalescedWorkspaceList(
                                    workspaces,
                                    allRowsForTaskGroupCoalescing,
                                    {
                                      sectionId,
                                      tierKeyPrefix,
                                      // Tier toggles align with folder-nested content.
                                      tierButtonClassName: "pl-7",
                                      depthByWorkspaceId,
                                      baseRowMetaByWorkspaceId,
                                      renderRow: (metadata, opts) =>
                                        renderWorkspace(
                                          metadata,
                                          opts?.sectionId,
                                          opts?.rowRenderMeta,
                                          opts?.depthOverride,
                                          opts?.keyOverride,
                                          opts?.subAgentConnectorLayout,
                                          opts?.taskGroupHeaderTitle
                                        ),
                                    }
                                  );

                                // Partition both the full section membership and the filtered visible rows.
                                // Best-of grouping stays leaf-only by consulting the unfiltered section data,
                                // while actual rendering still follows the visible hierarchy.
                                const {
                                  unsectioned: allUnsectionedForNormalRendering,
                                  bySectionId: allBySectionIdForNormalRendering,
                                } = partitionWorkspacesBySection(
                                  workspacesForNormalRendering,
                                  sections
                                );
                                const { unsectioned, bySectionId } = partitionWorkspacesBySection(
                                  visibleWorkspacesForNormalRendering,
                                  sections
                                );

                                // Render section with its workspaces
                                const renderSection = (section: SectionConfig) => {
                                  const sectionWorkspaces = bySectionId.get(section.id) ?? [];
                                  const sectionAllWorkspaces =
                                    allBySectionIdForNormalRendering.get(section.id) ?? [];
                                  const sectionDrafts = draftsBySectionId.get(section.id) ?? [];
                                  const sectionHasPromotedAttention = sectionDrafts.some(
                                    (draft) => {
                                      const promotedMetadata = activeDraftPromotions[draft.draftId];
                                      return promotedMetadata
                                        ? workspaceAttentionById.get(promotedMetadata.id) === true
                                        : false;
                                    }
                                  );
                                  const sectionHasAttention =
                                    sectionAllWorkspaces.some(
                                      (workspace) =>
                                        workspaceAttentionById.get(workspace.id) === true
                                    ) || sectionHasPromotedAttention;

                                  const sectionExpandedKey = getSectionExpandedKey(
                                    projectPath,
                                    section.id
                                  );
                                  const isSectionExpanded =
                                    expandedSections[sectionExpandedKey] ?? true;
                                  const shouldAutoEditSection =
                                    autoEditingSection?.projectPath === projectPath &&
                                    autoEditingSection?.sectionId === section.id;

                                  return (
                                    <WorkspaceSectionDropZone
                                      key={section.id}
                                      projectPath={projectPath}
                                      sectionId={section.id}
                                      onDrop={handleWorkspaceSectionDrop}
                                    >
                                      <SectionHeader
                                        section={section}
                                        isExpanded={isSectionExpanded}
                                        workspaceCount={
                                          sectionWorkspaces.length + sectionDrafts.length
                                        }
                                        hasAttention={sectionHasAttention}
                                        onToggleExpand={() =>
                                          toggleSection(projectPath, section.id)
                                        }
                                        onAddWorkspace={() => {
                                          // Create workspace in this section
                                          handleAddWorkspace(projectPath, section.id);
                                        }}
                                        onRename={(name) => {
                                          if (shouldAutoEditSection) {
                                            setAutoEditingSection(null);
                                          }
                                          void updateDisplayName(section.id, name);
                                        }}
                                        onChangeColor={(color) => {
                                          void updateProjectColor(section.id, color);
                                        }}
                                        autoStartEditing={shouldAutoEditSection}
                                        onAutoCreateAbandon={
                                          shouldAutoEditSection
                                            ? () => {
                                                void (async () => {
                                                  setAutoEditingSection(null);
                                                  await handleRemoveSection(
                                                    projectPath,
                                                    section.id
                                                  );
                                                })();
                                              }
                                            : undefined
                                        }
                                        onAutoCreateRenameCancel={
                                          shouldAutoEditSection
                                            ? () => {
                                                setAutoEditingSection(null);
                                              }
                                            : undefined
                                        }
                                        onDelete={(anchorEl) => {
                                          void handleRemoveSection(
                                            projectPath,
                                            section.id,
                                            anchorEl
                                          );
                                        }}
                                      />
                                      {isSectionExpanded && (
                                        <div className="pb-1">
                                          {sectionDrafts.map((draft) => renderDraft(draft))}
                                          {sectionWorkspaces.length > 0 ? (
                                            renderAgeTiers(
                                              sectionWorkspaces,
                                              getSectionTierKey(projectPath, section.id, 0).replace(
                                                ":tier:0",
                                                ":tier"
                                              ),
                                              section.id,
                                              sectionAllWorkspaces
                                            )
                                          ) : sectionDrafts.length === 0 ? (
                                            <div className="text-muted px-3 py-2 text-center text-xs italic">
                                              No chats in this sub-project
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </WorkspaceSectionDropZone>
                                  );
                                };

                                return (
                                  <>
                                    {projectHasNoAgentsOrDrafts && (
                                      <div className="text-content-disabled py-2 pl-12 text-xs">
                                        Empty
                                      </div>
                                    )}
                                    {/* Unsectioned workspaces first - always show drop zone when sections exist */}
                                    {sections.length > 0 ? (
                                      <WorkspaceSectionDropZone
                                        projectPath={projectPath}
                                        sectionId={null}
                                        onDrop={handleWorkspaceSectionDrop}
                                        testId="unsectioned-drop-zone"
                                      >
                                        {unsectionedDrafts.map((draft) => renderDraft(draft))}
                                        {unsectioned.length > 0 ? (
                                          renderAgeTiers(
                                            unsectioned,
                                            getTierKey(projectPath, 0).replace(":0", ""),
                                            undefined,
                                            allUnsectionedForNormalRendering
                                          )
                                        ) : unsectionedDrafts.length === 0 ? (
                                          <div className="text-muted px-3 py-2 text-center text-xs italic">
                                            No unsectioned chats
                                          </div>
                                        ) : null}
                                      </WorkspaceSectionDropZone>
                                    ) : (
                                      <>
                                        {unsectionedDrafts.map((draft) => renderDraft(draft))}
                                        {unsectioned.length > 0 &&
                                          renderAgeTiers(
                                            unsectioned,
                                            getTierKey(projectPath, 0).replace(":0", ""),
                                            undefined,
                                            allUnsectionedForNormalRendering
                                          )}
                                      </>
                                    )}

                                    {/* Sections */}
                                    {sections.map(renderSection)}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </ScrollArea>
            </>
          )}
          <SidebarCollapseButton
            collapsed={collapsed}
            onToggle={onToggleCollapsed}
            side="left"
            shortcut={formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)}
          />
          <PositionedMenu
            open={projectContextMenu.isOpen}
            onOpenChange={handleProjectMenuOpenChange}
            position={projectContextMenu.position}
          >
            <PositionedMenuItem
              icon={<Pencil className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Edit name"
              disabled={!hasProjectMenuTarget}
              onClick={() => {
                handleProjectMenuEditName();
              }}
            />
            <PositionedMenuItem
              icon={<Plus className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Add sub-project"
              disabled={!hasProjectMenuTarget}
              onClick={() => {
                handleProjectMenuAddSubFolder();
              }}
            />
            <PositionedMenuItem
              icon={<KeyRound className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Manage secrets"
              disabled={!hasProjectMenuTarget}
              onClick={() => {
                handleProjectMenuManageSecrets();
              }}
            />
            <PositionedMenuItem
              icon={<ScrollText className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Instructions"
              disabled={!hasProjectMenuTarget}
              onClick={() => {
                handleProjectMenuInstructions();
              }}
            />
            <PositionedMenuItem
              icon={<Palette className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Change color"
              disabled={!hasProjectMenuTarget}
              onClick={() => {
                handleProjectMenuColorClick();
              }}
            />
            {showProjectColorPicker && hasProjectMenuTarget && (
              <div className="bg-background border-border mx-1 my-1 rounded border p-2">
                <div className="mb-2 grid grid-cols-5 gap-1">
                  {SECTION_COLOR_PALETTE.map(([name, color]) => (
                    <button
                      key={color}
                      onClick={() => {
                        void handleProjectColorChange(color);
                        setProjectColorHexInput(color);
                        setProjectColorPickerValue(color);
                        setProjectColorPickerDirty(false);
                        setShowProjectColorPicker(false);
                      }}
                      className={cn(
                        "h-5 w-5 rounded border-2 transition-transform hover:scale-110",
                        projectMenuResolvedColor === color ? "border-white" : "border-transparent"
                      )}
                      style={{ backgroundColor: color }}
                      aria-label={`Set project color to ${name}`}
                    />
                  ))}
                </div>
                <div className="section-color-picker">
                  <HexColorPicker
                    color={projectColorPickerValue}
                    onChange={(newColor) => {
                      setProjectColorHexInput(newColor);
                      setProjectColorPickerValue(newColor);
                      setProjectColorPickerDirty(true);
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={projectColorHexInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setProjectColorHexInput(value);
                      if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                        setProjectColorPickerValue(value);
                        setProjectColorPickerDirty(false);
                        void handleProjectColorChange(value);
                      }
                    }}
                    className="bg-background/50 text-foreground w-full rounded border border-white/20 px-1.5 py-0.5 text-xs outline-none select-text"
                  />
                </div>
              </div>
            )}
            <Separator />
            <PositionedMenuItem
              icon={<Trash className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
              label="Delete..."
              variant="destructive"
              disabled={!hasProjectMenuTarget}
              onClick={(event) => {
                handleProjectMenuDelete(event.currentTarget);
              }}
            />
          </PositionedMenu>

          <ConfirmationModal
            isOpen={archiveConfirmation !== null}
            title={
              archiveConfirmationUntrackedPaths
                ? "Archive workspace with untracked files?"
                : archiveConfirmation
                  ? `Archive "${archiveConfirmation.displayTitle}" while streaming?`
                  : "Archive chat?"
            }
            description={buildArchiveConfirmDescription(
              archiveConfirmationIsStreaming,
              archiveConfirmationUntrackedPaths
            )}
            warning={buildArchiveConfirmWarning(
              archiveConfirmationIsStreaming,
              archiveConfirmationUntrackedPaths
            )}
            confirmLabel={
              archiveConfirmationUntrackedPaths ? "Archive and delete files" : "Archive"
            }
            confirmVariant="destructive"
            onConfirm={handleArchiveWorkspaceConfirm}
            onCancel={handleArchiveWorkspaceCancel}
          />
          <ProjectDeleteConfirmationModal
            isOpen={deleteConfirmation !== null}
            projectName={deleteConfirmation?.projectName ?? ""}
            activeCount={deleteConfirmation?.activeCount ?? 0}
            archivedCount={deleteConfirmation?.archivedCount ?? 0}
            onConfirm={handleDeleteConfirm}
            onCancel={handleDeleteCancel}
          />
          <PopoverError
            error={workspaceArchiveError.error}
            prefix="Failed to archive chat"
            onDismiss={workspaceArchiveError.clearError}
          />
          <PopoverError
            error={workspaceStopRuntimeError.error}
            prefix="Failed to stop container"
            onDismiss={workspaceStopRuntimeError.clearError}
          />
          <PopoverError
            error={workspaceForkError.error}
            prefix="Failed to fork chat"
            onDismiss={workspaceForkError.clearError}
          />
          <PopoverError
            error={workspaceRemoveError.error}
            prefix="Failed to cancel workspace creation"
            onDismiss={workspaceRemoveError.clearError}
          />
          <PopoverError
            error={projectRemoveError.error}
            prefix="Failed to remove project"
            onDismiss={projectRemoveError.clearError}
          />
          <PopoverError
            error={sectionRemoveError.error}
            prefix="Failed to remove sub-project"
            onDismiss={sectionRemoveError.clearError}
          />
          {!(isDesktopMode() && collapsed) && (
            // Keep the sidebar divider above sticky row content and scroll-layer visuals.
            <div
              aria-hidden
              className="bg-border-light pointer-events-none absolute inset-y-0 right-0 z-40 w-px"
            />
          )}
        </div>
      </DndProvider>
    </TitleEditProvider>
  );
};

// Memoize to prevent re-renders when props haven't changed
const ProjectSidebar = React.memo(ProjectSidebarInner);

export default ProjectSidebar;
