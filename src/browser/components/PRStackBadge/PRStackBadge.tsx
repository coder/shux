import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  GitPullRequest,
  Layers,
  Rocket,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import type { WorkspaceStackBranch, WorkspaceStackInfo } from "@/common/types/links";

export interface PRStackBadgeProps {
  stack: WorkspaceStackInfo;
  menuDirection?: "up" | "down";
  className?: string;
}

interface BranchStatusDisplay {
  Icon: LucideIcon;
  colorClass: string;
  label: string;
}

function getBranchStatusDisplay(branch: WorkspaceStackBranch): BranchStatusDisplay {
  if (!branch.pr) {
    return { Icon: GitBranch, colorClass: "text-muted", label: "No pull request" };
  }
  if (branch.pr.state === "MERGED") {
    return { Icon: Check, colorClass: "text-purple-500", label: "Merged" };
  }
  if (branch.pr.state === "CLOSED") {
    return { Icon: X, colorClass: "text-danger-soft", label: "Closed" };
  }
  if (branch.pr.isDraft) {
    return { Icon: GitPullRequest, colorClass: "text-muted", label: "Draft" };
  }
  if (branch.pr.state === "QUEUED") {
    return { Icon: Rocket, colorClass: "text-warning", label: "Queued" };
  }
  if (branch.needsRebase) {
    return { Icon: AlertCircle, colorClass: "text-warning", label: "Needs rebase" };
  }
  return { Icon: GitPullRequest, colorClass: "text-success", label: "Open" };
}

function StackBranchRow(props: { branch: WorkspaceStackBranch; onNavigate: () => void }) {
  const display = getBranchStatusDisplay(props.branch);
  const content = (
    <>
      <span className={cn("mt-0.5 shrink-0", display.colorClass)} aria-label={display.label}>
        <display.Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {props.branch.pr?.title ?? props.branch.branch}
        </span>
        <span className="text-muted block truncate text-[10px]">
          {props.branch.pr ? `#${props.branch.pr.number} · ` : ""}
          {props.branch.branch}
        </span>
      </span>
    </>
  );
  const className = cn(
    "flex min-w-0 items-start gap-2 px-3 py-2 text-left",
    props.branch.isCurrent && "bg-hover",
    props.branch.pr?.url && "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
  );

  if (props.branch.pr?.url) {
    return (
      <a
        href={props.branch.pr.url}
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        data-testid="stack-branch-row"
        data-branch={props.branch.branch}
        aria-current={props.branch.isCurrent ? "true" : undefined}
        className={className}
        onClick={props.onNavigate}
      >
        {content}
      </a>
    );
  }

  return (
    <div
      role="menuitem"
      aria-disabled="true"
      data-testid="stack-branch-row"
      data-branch={props.branch.branch}
      aria-current={props.branch.isCurrent ? "true" : undefined}
      className={cn(className, "text-muted")}
    >
      {content}
    </div>
  );
}

export function PRStackBadge(props: PRStackBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const containerRef = useRef<HTMLDivElement>(null);
  const menuDirection = props.menuDirection ?? "down";

  const toggleMenu = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }

    const trigger = containerRef.current?.getBoundingClientRect();
    if (!trigger) {
      return;
    }

    const viewportMargin = 8;
    const menuWidth = Math.min(288, window.innerWidth - viewportMargin * 2);
    const left = Math.min(
      Math.max(trigger.right - menuWidth, viewportMargin),
      window.innerWidth - menuWidth - viewportMargin
    );
    setMenuStyle({
      left,
      width: menuWidth,
      ...(menuDirection === "up"
        ? { bottom: window.innerHeight - trigger.top + 4 }
        : { top: trigger.bottom + 4 }),
    });
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className={cn("relative shrink-0", props.className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          setIsOpen(false);
        }
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted h-6 shrink-0 gap-1 px-2 text-xs font-medium"
        aria-label={`View stack with ${props.stack.branches.length} branches`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={toggleMenu}
      >
        <Layers className="h-3 w-3" />
        <span className="counter-nums">{props.stack.branches.length}</span>
        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </Button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Pull request stack"
          className="bg-surface-primary border-border-light fixed z-[1020] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border shadow-lg"
          style={menuStyle}
        >
          <div className="max-h-80 overflow-y-auto py-1">
            {[...props.stack.branches].reverse().map((branch) => (
              <StackBranchRow
                key={branch.branch}
                branch={branch}
                onNavigate={() => setIsOpen(false)}
              />
            ))}
            <div
              role="menuitem"
              aria-disabled="true"
              data-testid="stack-trunk-row"
              className="text-muted border-border-light flex items-center gap-2 border-t px-3 py-2 text-xs"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{props.stack.trunk}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
