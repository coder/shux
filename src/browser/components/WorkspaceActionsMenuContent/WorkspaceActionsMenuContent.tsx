import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import {
  GitBranch,
  HeartPulse,
  History,
  Maximize2,
  Pencil,
  Pin,
  PinOff,
  Server,
  Square,
} from "lucide-react";
import React from "react";

interface WorkspaceActionButtonProps {
  label: string;
  shortcut?: string;
  shortcutClassName?: string;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

function WorkspaceActionButton(props: WorkspaceActionButtonProps) {
  return (
    <button
      type="button"
      className="text-content-secondary bg-surface-primary hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap"
      onClick={props.onClick}
      data-testid={props.testId}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3">{props.icon}</span>
        {props.label}
        {props.shortcut && (
          <span className={`text-muted ml-auto text-[10px] ${props.shortcutClassName ?? ""}`}>
            ({props.shortcut})
          </span>
        )}
      </span>
    </button>
  );
}

interface WorkspaceActionsMenuContentProps {
  /** Workspace title actions only make sense in the left sidebar where title text is visible. */
  onEditTitle?: (() => void) | null;
  /** Workspace-level settings action currently surfaced from the workspace menu bar. */
  onConfigureMcp?: (() => void) | null;
  /** Experiment-gated workspace heartbeat settings action. */
  onConfigureHeartbeat?: (() => void) | null;
  /** Mobile workspace-header action: open immersive review in full-screen touch mode. */
  onOpenTouchFullscreenReview?: (() => void) | null;
  onEnterImmersiveReview?: (() => void) | null;
  /** Small-viewport action: open the timeline dialog (the right sidebar hosting the tab is hidden there). */
  onOpenTimeline?: (() => void) | null;
  onStopRuntime?: (() => void) | null;
  onForkChat?: ((anchorEl: HTMLElement) => void) | null;
  /** Pin/unpin toggle; pass null on sub-agent rows (only root chats are pinnable). */
  onTogglePinned?: (() => void) | null;
  isPinned?: boolean;
  onArchiveChat?: ((anchorEl: HTMLElement) => void) | null;
  onCloseMenu: () => void;
  shortcutClassName?: string;
  configureMcpTestId?: string;
}

/**
 * Shared menu content for workspace actions, used by both sidebar rows and the workspace menu bar.
 * Keeping these actions centralized prevents menu drift between entry points.
 */
export const WorkspaceActionsMenuContent: React.FC<WorkspaceActionsMenuContentProps> = (props) => {
  return (
    <>
      {props.onEditTitle && (
        <WorkspaceActionButton
          label="Edit chat title"
          shortcut={formatKeybind(KEYBINDS.EDIT_WORKSPACE_TITLE)}
          shortcutClassName={props.shortcutClassName}
          icon={<Pencil className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onEditTitle?.();
          }}
        />
      )}
      {props.onConfigureMcp && (
        <WorkspaceActionButton
          label="Configure MCP servers"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_MCP)}
          shortcutClassName={props.shortcutClassName}
          icon={<Server className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureMcp?.();
          }}
          testId={props.configureMcpTestId}
        />
      )}
      {props.onConfigureHeartbeat && (
        <WorkspaceActionButton
          label="Configure heartbeat"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_HEARTBEAT)}
          shortcutClassName={props.shortcutClassName}
          icon={<HeartPulse className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureHeartbeat?.();
          }}
        />
      )}
      {props.onOpenTouchFullscreenReview && (
        <WorkspaceActionButton
          label="Mobile full-screen review"
          icon={<Maximize2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenTouchFullscreenReview?.();
          }}
        />
      )}
      {props.onEnterImmersiveReview && (
        <WorkspaceActionButton
          label="Immersive review"
          shortcut={formatKeybind(KEYBINDS.TOGGLE_REVIEW_IMMERSIVE)}
          shortcutClassName={props.shortcutClassName}
          icon={<Maximize2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onEnterImmersiveReview?.();
          }}
        />
      )}
      {props.onOpenTimeline && (
        <WorkspaceActionButton
          label="Timeline"
          shortcut={formatKeybind(KEYBINDS.OPEN_TIMELINE_DIALOG)}
          shortcutClassName={props.shortcutClassName}
          icon={<History className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenTimeline?.();
          }}
          testId="workspace-timeline-button"
        />
      )}
      {props.onStopRuntime && (
        <WorkspaceActionButton
          label="Stop container"
          icon={<Square className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onStopRuntime?.();
          }}
        />
      )}
      {props.onForkChat && (
        <WorkspaceActionButton
          label="Fork chat"
          icon={<GitBranch className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onForkChat?.(e.currentTarget);
          }}
        />
      )}
      {props.onTogglePinned && (
        <WorkspaceActionButton
          label={props.isPinned ? "Unpin chat" : "Pin chat"}
          shortcut={formatKeybind(KEYBINDS.PIN_WORKSPACE)}
          shortcutClassName={props.shortcutClassName}
          icon={
            props.isPinned ? (
              <PinOff className="h-3 w-3 shrink-0" />
            ) : (
              <Pin className="h-3 w-3 shrink-0" />
            )
          }
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onTogglePinned?.();
          }}
        />
      )}
      {props.onArchiveChat && (
        <WorkspaceActionButton
          label="Archive chat"
          shortcut={formatKeybind(KEYBINDS.ARCHIVE_WORKSPACE)}
          shortcutClassName={props.shortcutClassName}
          icon={<ArchiveIcon className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onArchiveChat?.(e.currentTarget);
          }}
        />
      )}
    </>
  );
};
