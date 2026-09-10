import React, { useState, useCallback, useEffect } from "react";
import { Terminal, X, Loader2, FileText } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import { BackgroundBashOutputDialog } from "../BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import { ChatInputDecoration } from "../ChatPane/ChatInputDecoration";
import { formatDuration } from "@/common/utils/formatDuration";
import {
  useBackgroundBashTerminatingIds,
  useBackgroundProcesses,
} from "@/browser/stores/BackgroundBashStore";
import { useBackgroundBashActions } from "@/browser/contexts/BackgroundBashContext";

/**
 * Truncate script to reasonable display length.
 */
function truncateScript(script: string, maxLength = 60): string {
  // First line only, truncated
  const firstLine = script.split("\n")[0] ?? script;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return firstLine.slice(0, maxLength - 3) + "...";
}

interface BackgroundProcessesBannerProps {
  workspaceId: string;
}

/**
 * Banner showing running background processes.
 * Displays "N running bashes" which expands on click to show details.
 */
export const BackgroundProcessesBanner: React.FC<BackgroundProcessesBannerProps> = (props) => {
  const [viewingProcessId, setViewingProcessId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setTick] = useState(0);
  const processes = useBackgroundProcesses(props.workspaceId);
  const terminatingIds = useBackgroundBashTerminatingIds(props.workspaceId);
  const { terminate } = useBackgroundBashActions();

  // Keep running processes visible, plus exited processes whose monitor matched but whose
  // wake has not been delivered yet — otherwise a one-shot watcher that matched and exited
  // vanishes from the banner and looks like a lost wake.
  const visibleProcesses = processes.filter(
    (p) => p.status === "running" || p.monitor?.pendingWakeKind != null
  );
  const viewingProcess = processes.find((p) => p.id === viewingProcessId) ?? null;
  const count = visibleProcesses.length;
  const hasRunning = visibleProcesses.some((p) => p.status === "running");

  // Update duration display every second when expanded (exited processes show no duration)
  useEffect(() => {
    if (!isExpanded || !hasRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExpanded, hasRunning]);

  const handleViewOutput = useCallback((processId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setViewingProcessId(processId);
  }, []);

  const handleTerminate = useCallback(
    (processId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      terminate(processId);
    },
    [terminate]
  );

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Don't render if no running processes and no dialog open.
  if (count === 0 && !viewingProcessId) {
    return null;
  }

  return (
    <>
      {count > 0 && (
        <ChatInputDecoration
          expanded={isExpanded}
          onToggle={handleToggle}
          contentClassName="max-h-48 space-y-1.5 overflow-y-auto py-2"
          summary={
            <>
              <Terminal className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
              <span className="text-muted group-hover:text-secondary transition-colors">
                <span className="font-medium">{count}</span>
                {" background bash"}
                {count !== 1 && "es"}
              </span>
            </>
          }
          renderExpanded={() =>
            visibleProcesses.map((proc) => {
              const isTerminating = terminatingIds.has(proc.id);
              return (
                <div
                  key={proc.id}
                  className={cn(
                    "hover:bg-hover flex items-center justify-between gap-3 rounded px-2 py-1.5",
                    "transition-colors",
                    isTerminating && "pointer-events-none opacity-50"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate font-mono text-xs" title={proc.script}>
                      {proc.displayName ?? truncateScript(proc.script)}
                    </div>
                    {proc.monitor && (
                      <>
                        <div className="text-muted truncate text-[10px]">
                          watching /{proc.monitor.filter}/ · {proc.monitor.totalMatches} match
                          {proc.monitor.totalMatches === 1 ? "" : "es"}
                          {proc.monitor.stopped ? " · stopped" : ""}
                        </div>
                        {/* Own non-truncating line: appended to the watching line above,
                            a long filter would right-ellipsize this away on narrow
                            widths — hiding the only explanation for an exited row. */}
                        {proc.monitor.pendingWakeKind != null && (
                          <div className="text-secondary text-[10px]">
                            {/* settled wakes report a process exit without any filter match;
                                monitor-lost wakes report a terminated watcher, not a match */}
                            {proc.monitor.pendingWakeKind === "match"
                              ? "match found — waking agent…"
                              : proc.monitor.pendingWakeKind === "settled"
                                ? "process settled — waking agent…"
                                : "monitor lost — waking agent…"}
                          </div>
                        )}
                      </>
                    )}
                    {/* Rows synthesized from a durable pending wake (process gone after
                        restart) carry no real pid. */}
                    {proc.pid > 0 && (
                      <div className="text-muted font-mono text-[10px]">pid {proc.pid}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Exited-but-wake-pending rows have no live duration to increment */}
                    {proc.status === "running" && (
                      <span className="text-muted text-[10px] tabular-nums">
                        {formatDuration(Date.now() - proc.startTime)}
                      </span>
                    )}
                    {/* Rows synthesized from a durable pending wake have no manager entry
                        behind them, so fetching output is guaranteed to fail. Keyed on the
                        explicit marker, not the pid: migrated processes also use pid 0 but
                        remain fully queryable. */}
                    {proc.synthesized !== true && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={isTerminating}
                            onClick={(e) => handleViewOutput(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-secondary rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            <FileText size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>View output</TooltipContent>
                      </Tooltip>
                    )}
                    {/* Nothing to terminate once the process has exited */}
                    {proc.status === "running" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={isTerminating}
                            onClick={(e) => handleTerminate(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-error rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            {isTerminating ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <X size={14} />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Terminate process</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })
          }
        />
      )}

      {viewingProcessId && (
        <BackgroundBashOutputDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setViewingProcessId(null);
            }
          }}
          workspaceId={props.workspaceId}
          processId={viewingProcessId}
          displayName={viewingProcess?.displayName}
          script={viewingProcess?.script}
        />
      )}
    </>
  );
};
