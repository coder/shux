import React, { useEffect } from "react";
import { ArrowLeftRight, Github, MessageCircle } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { GitStatusIndicatorMode } from "../GitStatusIndicatorView/GitStatusIndicatorView";
import { isDevcontainerRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { getDevcontainerStatusChip } from "@/browser/utils/runtimeUi";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { isMultiProject } from "@/common/utils/multiProject";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  pinTimelineRevealTarget,
  useWorkspaceLastUserPromptInfo,
  useWorkspaceRoundedStreamingTps,
  useWorkspaceSidebarState,
  useWorkspaceStoreRaw,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspacePR } from "@/browser/stores/PRStatusStore";
import { useRuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";
import { SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { RuntimeBadge } from "../RuntimeBadge/RuntimeBadge";
import { BranchSelector } from "../BranchSelector/BranchSelector";
import { GitStatusIndicator } from "../GitStatusIndicator/GitStatusIndicator";
import { MultiProjectGitStatusIndicator } from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import { WorkspaceLinks } from "../WorkspaceLinks/WorkspaceLinks";
import { Popover, PopoverTrigger, PopoverContent } from "../Popover/Popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { revealTimelineTarget, type TimelineRevealResult } from "@/browser/utils/timelineReveal";
import {
  formatKeybind,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";

interface WorkspaceFooterBarProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
}

function WorkspaceDriftIndicator(props: {
  workspaceId: string;
  projectPath: string;
  isWorking: boolean;
  showMultiProjectStatus: boolean;
}) {
  const gitStatus = useGitStatus(props.workspaceId);

  if (props.showMultiProjectStatus) {
    // No mode toggle: the multi-project indicator shows a repo-level summary and
    // has no lines/commits modes, so a toggle here would silently rewrite the
    // shared preference without changing anything on screen.
    return (
      <MultiProjectGitStatusIndicator
        workspaceId={props.workspaceId}
        tooltipPosition="bottom"
        isWorking={props.isWorking}
      />
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <DriftModeToggle />
      <GitStatusIndicator
        gitStatus={gitStatus}
        workspaceId={props.workspaceId}
        projectPath={props.projectPath}
        tooltipPosition="bottom"
        isWorking={props.isWorking}
      />
    </div>
  );
}

/** Shares the divergence dialog's persisted mode key so both surfaces stay in sync. */
function DriftModeToggle() {
  const [mode, setMode] = usePersistedState<GitStatusIndicatorMode>(
    GIT_STATUS_INDICATOR_MODE_KEY,
    "line-delta",
    { listener: true }
  );
  const isLineDelta = mode === "line-delta";
  const toggleMode = () => setMode((prev) => (prev === "line-delta" ? "divergence" : "line-delta"));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_DRIFT_MODE)) {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted hover:text-foreground focus-visible:ring-accent flex shrink-0 cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 transition-colors focus-visible:ring-1"
          onClick={toggleMode}
          onKeyDown={stopKeyboardPropagation}
        >
          {isLineDelta ? "Lines" : "Commits"}
          <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        Show {isLineDelta ? "commits" : "lines"} ({formatKeybind(KEYBINDS.TOGGLE_DRIFT_MODE)})
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceBranchControls(props: {
  workspaceId: string;
  workspaceName: string;
  devcontainerChip: ReturnType<typeof getDevcontainerStatusChip>;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <BranchSelector
        key={props.workspaceId}
        workspaceId={props.workspaceId}
        workspaceName={props.workspaceName}
      />
      {props.devcontainerChip && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-tight font-medium",
            props.devcontainerChip.className
          )}
        >
          {props.devcontainerChip.label}
        </span>
      )}
    </div>
  );
}

function FooterRepositoryLabel(props: { workspaceId: string; projectLabel: string }) {
  const workspacePR = useWorkspacePR(props.workspaceId);

  if (!workspacePR) {
    return <FooterProjectLabel projectLabel={props.projectLabel} />;
  }

  // The slug comes from a parsed github.com PR URL, so the repo page is always this host.
  const slug = `${workspacePR.owner}/${workspacePR.repo}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={`https://github.com/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="workspace-footer-repository"
          className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors focus-visible:ring-1"
        >
          <Github className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="font-mono">{slug}</span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="top">Open on GitHub</TooltipContent>
    </Tooltip>
  );
}

/** Must not shrink: the bar scrolls, so a shrinking item collapses to zero width. */
function FooterProjectLabel(props: { projectLabel: string }) {
  return (
    <span className="text-muted max-w-40 shrink-0 truncate font-mono">{props.projectLabel}</span>
  );
}

/** Subscribe at the leaf so streaming deltas do not re-render the transcript subtree. */
function FooterUsageStats(props: { workspaceId: string }) {
  const usage = useWorkspaceUsage(props.workspaceId);
  // Chrome only paints a rounded value; keep identical provider chunks from committing/layouting it.
  const roundedTps = useWorkspaceRoundedStreamingTps(props.workspaceId);

  if (usage.totalTokens <= 0 && roundedTps === null) {
    return null;
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-foreground counter-nums">
        {formatTokens(usage.totalTokens)} <span className="text-muted">tok</span>
      </span>
      {roundedTps !== null && (
        <span className="text-foreground counter-nums">
          {roundedTps} <span className="text-muted">t/s</span>
        </span>
      )}
    </span>
  );
}

function FooterLastPrompt(props: { workspaceId: string }) {
  const lastPrompt = useWorkspaceLastUserPromptInfo(props.workspaceId);
  const workspaceStore = useWorkspaceStoreRaw();
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const revealButtonRef = React.useRef<HTMLButtonElement>(null);
  const revealOperationRef = React.useRef(0);
  const lastPromptMessageId = lastPrompt?.messageId;
  const [revealState, setRevealState] = React.useState<
    "idle" | "revealing" | "not-found" | "error"
  >("idle");

  useEffect(() => {
    revealOperationRef.current += 1;
    setRevealState("idle");
    return () => {
      revealOperationRef.current += 1;
    };
  }, [lastPromptMessageId]);

  // Reset open state when the prompt disappears so a later prompt cannot inherit it.
  useEffect(() => {
    if (lastPromptMessageId == null) {
      setOpen(false);
      setTooltipOpen(false);
      setRevealState("idle");
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SHOW_LAST_PROMPT)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lastPromptMessageId]);

  useEffect(() => {
    if (open) {
      return;
    }
    revealOperationRef.current += 1;
    setRevealState("idle");
  }, [open]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        !open ||
        !matchesKeybind(event, KEYBINDS.REVEAL_LAST_PROMPT) ||
        isEditableElement(event.target)
      ) {
        return;
      }
      event.preventDefault();
      if (revealButtonRef.current && !revealButtonRef.current.disabled) {
        revealButtonRef.current.click();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (lastPrompt === null) {
    return null;
  }

  const handleReveal = () => {
    if (revealState === "revealing") {
      return;
    }

    setRevealState("revealing");
    const operation = ++revealOperationRef.current;
    revealTimelineTarget({
      workspaceId: props.workspaceId,
      getTarget: () => ({ messageId: lastPrompt.messageId }),
      workspaceStore,
      pinTarget: pinTimelineRevealTarget,
      isCancelled: () => operation !== revealOperationRef.current,
    })
      .then((result: TimelineRevealResult) => {
        if (result === "cancelled" || operation !== revealOperationRef.current) {
          return;
        }
        if (result === "revealed") {
          setOpen(false);
          setRevealState("idle");
        } else {
          setRevealState(result);
        }
      })
      .catch(() => {
        if (operation === revealOperationRef.current) {
          setRevealState("error");
        }
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The prompt itself opens in a popover rather than a hover tooltip: touch has no
          hover, and keyboard users need a focus target. The tooltip only carries the hint. */}
      <Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 transition-colors focus-visible:ring-1"
              data-testid="workspace-footer-last-prompt"
              onKeyDown={stopKeyboardPropagation}
            >
              <MessageCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
              Last prompt
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          Show last prompt ({formatKeybind(KEYBINDS.SHOW_LAST_PROMPT)})
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="max-h-60 w-auto max-w-[min(25rem,var(--radix-popover-content-available-width,25rem))] overflow-y-auto p-3 text-xs leading-relaxed break-words"
      >
        <div className="whitespace-pre-wrap">{lastPrompt.text}</div>
        <button
          type="button"
          ref={revealButtonRef}
          data-testid="workspace-footer-last-prompt-reveal"
          disabled={revealState === "revealing"}
          onClick={handleReveal}
          className="border-border bg-surface-primary text-content-primary hover:bg-hover focus-visible:ring-accent mt-3 rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
        >
          {revealState === "revealing" ? "Revealing…" : "Reveal in transcript"}
        </button>
        {revealState === "not-found" ? (
          <div className="text-muted mt-1.5 text-[10px]">Prompt not found in the transcript</div>
        ) : revealState === "error" ? (
          <div className="text-muted mt-1.5 text-[10px]">Reveal unavailable</div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export const WorkspaceFooterBar: React.FC<WorkspaceFooterBarProps> = (props) => {
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceEntry = workspaceMetadata.get(props.workspaceId);
  const hasRepository = hasWorkspaceRepository(workspaceEntry);
  const showMultiProjectStatus = workspaceEntry != null && isMultiProject(workspaceEntry);

  // Metadata uses the top-level project name, so include a known sub-project path to preserve
  // the workspace's full project context.
  const { userProjects } = useProjectContext();
  const subProjectPath = workspaceEntry?.subProjectPath;
  const projectLabel =
    workspaceEntry?.kind === "scratch"
      ? SCRATCH_PROJECT_NAME
      : subProjectPath && userProjects.has(subProjectPath)
        ? formatProjectHierarchyLabel(subProjectPath, userProjects)
        : props.projectName;

  const { canInterrupt, isStarting, awaitingUserQuestion } = useWorkspaceSidebarState(
    props.workspaceId
  );
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;

  const runtimeStatus = useRuntimeStatus(props.workspaceId);
  const devcontainerChip = isDevcontainerRuntime(props.runtimeConfig)
    ? getDevcontainerStatusChip(runtimeStatus)
    : null;

  return (
    // Narrow layouts drop the app root's bottom inset, so this row owns it: a capped clearance for
    // the home indicator instead of the full inset, whose reserved band is the empty space we are
    // reclaiming. Wider layouts still take their clearance from the root.
    <footer
      data-testid="workspace-footer-bar"
      className="bg-sidebar border-border-light shrink-0 border-t [@media(max-width:768px)]:pb-[min(env(safe-area-inset-bottom,0px),8px)]"
    >
      {/* min-h rather than a fixed height: mobile raises these buttons to 44px touch targets, and a
        capped row would clip them along the same axis overflow-x-auto makes scrollable. */}
      <div className="scrollbar-none flex min-h-7 items-center gap-2 overflow-x-auto px-2 text-xs whitespace-nowrap">
        <RuntimeBadge
          runtimeConfig={props.runtimeConfig}
          isWorking={isWorking}
          workspacePath={props.namedWorkspacePath}
          workspaceName={props.workspaceName}
          tooltipSide="top"
        />
        {/* Narrow layouts show it in the header, where it cannot scroll out of view with this row. */}
        <WorkspaceLinks
          workspaceId={props.workspaceId}
          className="[@media(max-width:768px)]:hidden"
          menuDirection="up"
        />
        {hasRepository && (
          <>
            <WorkspaceDriftIndicator
              workspaceId={props.workspaceId}
              projectPath={props.projectPath}
              isWorking={isWorking}
              showMultiProjectStatus={showMultiProjectStatus}
            />
            <FooterRepositoryLabel workspaceId={props.workspaceId} projectLabel={projectLabel} />
            <WorkspaceBranchControls
              workspaceId={props.workspaceId}
              workspaceName={props.workspaceName}
              devcontainerChip={devcontainerChip}
            />
          </>
        )}
        {!hasRepository && <FooterProjectLabel projectLabel={projectLabel} />}
        <FooterUsageStats workspaceId={props.workspaceId} />
        <FooterLastPrompt workspaceId={props.workspaceId} />
      </div>
    </footer>
  );
};
