import React from "react";
import type { ContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { Popover, PopoverAnchor, PopoverContent } from "@/browser/components/Popover/Popover";
import { cn } from "@/common/lib/utils";

// ---------------------------------------------------------------------------
// PositionedMenu — Popover anchored at a fixed {x, y} screen position
// ---------------------------------------------------------------------------

interface PositionedMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: ContextMenuPosition | null;
  children: React.ReactNode;
  /** Tailwind width class (default: "w-[180px]") */
  className?: string;
  /**
   * Keyboard handler for menu-scoped shortcuts. Attached to the popover
   * content, which receives focus when the menu opens.
   */
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

/**
 * A lightweight popover menu anchored at an arbitrary screen position.
 *
 * Replaces the duplicated Popover+PopoverAnchor+invisible-span boilerplate
 * used across ChatPane transcript, AgentListItem draft, etc.
 */
export function PositionedMenu(props: PositionedMenuProps) {
  const [isPlaced, setIsPlaced] = React.useState(false);

  // Anchor via a Radix virtual ref measured in viewport coordinates instead of
  // a `position: fixed` <span>. Fixed-position elements resolve against the
  // nearest transformed ancestor, so a span rendered inside e.g. DialogContent
  // (centered with translate(-50%,-50%)) landed offset from the cursor. A
  // virtual rect is consumed by Floating UI directly in viewport space and is
  // immune to the caller's ancestor transforms.
  const positionRef = React.useRef(props.position);
  positionRef.current = props.position;
  const virtualAnchorRef = React.useRef({
    getBoundingClientRect: () =>
      DOMRect.fromRect({
        x: positionRef.current?.x ?? 0,
        y: positionRef.current?.y ?? 0,
        width: 0,
        height: 0,
      }),
  });

  // Keep content invisible for one animation frame after opening/repositioning.
  // This gives Radix/Floating UI time to compute final placement and avoids a
  // first-frame flash at fallback coordinates.
  React.useLayoutEffect(() => {
    if (!props.open) {
      setIsPlaced(false);
      return;
    }

    setIsPlaced(false);
    const frame = requestAnimationFrame(() => {
      setIsPlaced(true);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [props.open, props.position?.x, props.position?.y]);

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      {props.position && <PopoverAnchor virtualRef={virtualAnchorRef} />}
      <PopoverContent
        align="start"
        side="right"
        sideOffset={0}
        className={cn("min-w-0! bg-surface-primary p-1", props.className ?? "w-[180px]")}
        style={{ visibility: !props.open || isPlaced ? "visible" : "hidden" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// PositionedMenuItem — icon + label + optional shortcut hint
// ---------------------------------------------------------------------------

interface PositionedMenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Optional keybind hint (e.g. "⌘K") rendered as muted text on the right */
  shortcut?: string;
  disabled?: boolean;
  variant?: "default" | "destructive";
}

/**
 * Standard menu item button with icon, label, and optional keybind hint.
 *
 * Matches the styling used in AgentListItem overflow menus so all
 * positioned menus share a consistent look.
 */
export function PositionedMenuItem(props: PositionedMenuItemProps) {
  const isDestructive = props.variant === "destructive";

  return (
    <button
      type="button"
      disabled={props.disabled}
      className={cn(
        "bg-surface-primary w-full rounded-sm p-2 text-left text-xs whitespace-nowrap disabled:pointer-events-none disabled:opacity-50",
        isDestructive
          ? "text-content-destructive hover:bg-content-destructive/10 hover:text-destructive"
          : "text-content-secondary hover:bg-hover"
      )}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick(e);
      }}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3">{props.icon}</span>
        {props.label}
        {props.shortcut && (
          <span className="text-muted ml-auto hidden text-[10px] sm:inline">
            ({props.shortcut})
          </span>
        )}
      </span>
    </button>
  );
}
