import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { LEFT_SIDEBAR_COLLAPSED_WIDTH_PX, LEFT_SIDEBAR_DEFAULT_WIDTH_PX } from "@/constants/layout";
import ProjectSidebar from "../ProjectSidebar/ProjectSidebar";
import { TitleBar } from "../TitleBar/TitleBar";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface LeftSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  widthPx?: number;
  isResizing?: boolean;
  onStartResize?: (e: React.MouseEvent) => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

export function LeftSidebar(props: LeftSidebarProps) {
  const {
    collapsed,
    onToggleCollapsed,
    widthPx,
    isResizing,
    onStartResize,
    ...projectSidebarProps
  } = props;
  const isDesktop = isDesktopMode();
  // Match the CSS gate for the mobile "overlay" sidebar (width-only, any pointer
  // type); we don't show a drag handle in that mode since CSS pins the width.
  const isMobileOverlay =
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

  const handleBeforeOpenSettings = () => {
    // Keep settings navigation escapable on narrow viewports by dismissing the
    // off-canvas sidebar as soon as the user opens settings from this sidebar.
    if (!collapsed && isMobileOverlay) {
      onToggleCollapsed();
    }
  };

  const width = collapsed
    ? `${LEFT_SIDEBAR_COLLAPSED_WIDTH_PX}px`
    : `${widthPx ?? LEFT_SIDEBAR_DEFAULT_WIDTH_PX}px`;

  return (
    <>
      {/* Overlay backdrop - only visible on mobile when sidebar is open. Unmounted (not
          hidden via opacity/!hidden) when collapsed, and the dim+blur is painted on a
          pseudo-element: iOS/iPadOS 26 WebKit samples background-color/backdrop-filter on
          any mounted fixed element (hidden or visible) to synthesize a Liquid Glass blur
          over the status bar, but ignores pseudo-elements/absolute children. */}
      {!collapsed && (
        <div
          className="mobile-overlay fixed inset-0 z-40 hidden before:absolute before:inset-0 before:bg-black/50 before:backdrop-blur-sm"
          onClick={onToggleCollapsed}
        />
      )}

      {/* Sidebar */}
      <div
        data-testid="left-sidebar"
        className={cn(
          "h-full bg-sidebar border-r border-border flex flex-col shrink-0 overflow-hidden relative z-20",
          !isResizing && "transition-[width] duration-200",
          "mobile-sidebar",
          collapsed && "mobile-sidebar-collapsed",
          // In desktop mode when collapsed, start border below titlebar height (32px)
          // so it aligns with titlebar bottom edge and doesn't cut through traffic lights
          isDesktop &&
            collapsed &&
            "border-r-0 after:absolute after:right-0 after:top-8 after:bottom-0 after:w-px after:bg-border"
        )}
        style={{ width }}
      >
        {!collapsed && <TitleBar onBeforeOpenSettings={handleBeforeOpenSettings} />}
        <ProjectSidebar
          {...projectSidebarProps}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
        />

        {!collapsed && !isMobileOverlay && onStartResize && (
          <div
            data-testid="left-sidebar-resize-handle"
            className={cn(
              "absolute right-0 top-0 bottom-0 w-0.5 z-10 cursor-col-resize transition-[background] duration-150",
              isResizing ? "bg-accent" : "bg-border-light hover:bg-accent"
            )}
            onMouseDown={(e) => onStartResize(e)}
          />
        )}
      </div>
    </>
  );
}
