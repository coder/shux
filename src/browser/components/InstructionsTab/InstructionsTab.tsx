import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, RefreshCw } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { ErrorBoundary } from "@/browser/components/ErrorBoundary/ErrorBoundary";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { ChatInstructionsPanel } from "./AdditionalSystemContextScratchpad";
import { isAbortError } from "@/browser/utils/isAbortError";
import { setWorkspaceInstructionsFileCount } from "@/browser/utils/workspaceInstructionsStore";
import { cn } from "@/common/lib/utils";
import {
  INSTRUCTION_SCOPE,
  type InstructionFile,
  type InstructionScope,
  type InstructionSet,
  type WorkspaceInstructions,
} from "@/common/types/instructions";
import { getErrorMessage } from "@/common/utils/errors";
import { formatBytes } from "@/common/utils/formatBytes";

interface InstructionsTabProps {
  workspaceId: string;
}

/**
 * The Instructions panel renders the structured `WorkspaceInstructions` payload
 * returned by `workspace.getInstructions`. The same `InstructionFile` objects
 * the agent sees are rendered here — type-system parity with `buildSystemMessage`
 * is enforced by sharing `@/common/types/instructions`.
 */
export function InstructionsTab(props: InstructionsTabProps) {
  return (
    <ErrorBoundary workspaceInfo="Instructions tab">
      <InstructionsTabImpl workspaceId={props.workspaceId} />
    </ErrorBoundary>
  );
}

function InstructionsTabImpl(props: InstructionsTabProps) {
  const { api } = useAPI();
  const [data, setData] = useState<WorkspaceInstructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.workspace
      .getInstructions({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
        // Publish to the shared store so the tab-strip label can render the
        // count badge even when this panel is not the active tab.
        setWorkspaceInstructionsFileCount(props.workspaceId, result.files.length);
      })
      .catch((err) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(getErrorMessage(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, props.workspaceId, refreshTick]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        totalTokens={data?.totalTokens ?? null}
        fileCount={data?.files.length ?? 0}
        loading={loading}
        onRefresh={refresh}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChatInstructionsPanel workspaceId={props.workspaceId} />
        {error && <ErrorBanner message={error} />}
        {!error && !loading && data?.files.length === 0 && <EmptyState />}
        {data && data.files.length > 0 && <InstructionsBody data={data} />}
        {loading && !data && <LoadingState />}
      </div>
    </div>
  );
}

interface HeaderProps {
  totalTokens: number | null;
  fileCount: number;
  loading: boolean;
  onRefresh: () => void;
}

function Header({ totalTokens, fileCount, loading, onRefresh }: HeaderProps) {
  return (
    <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex items-baseline gap-3 text-xs">
        <span className="font-medium">Instructions context</span>
        <span className="text-muted">
          {fileCount === 0 ? "no files" : fileCount === 1 ? "1 file" : `${fileCount} files`}
          {totalTokens != null && (
            <>
              <span className="mx-1">·</span>
              <span className="counter-nums">~{formatTokens(totalTokens)} tokens</span>
            </>
          )}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-foreground rounded p-1 transition-colors disabled:opacity-50"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh instructions"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Re-read AGENTS.md files</TooltipContent>
      </Tooltip>
    </div>
  );
}

function InstructionsBody({ data }: { data: WorkspaceInstructions }) {
  // Render structured groups so the panel layout reflects the prompt structure.
  const groups: Array<{ title: string; sets: InstructionSet[] }> = [];
  if (data.sources.global.length > 0) {
    groups.push({ title: "Global", sets: data.sources.global });
  }
  const workspaceSets = data.sources.context.filter((s) => s.scope === INSTRUCTION_SCOPE.WORKSPACE);
  if (workspaceSets.length > 0) {
    groups.push({ title: "Workspace", sets: workspaceSets });
  }
  const subProjectSets = data.sources.context.filter(
    (s) => s.scope === INSTRUCTION_SCOPE.SUBPROJECT
  );
  if (subProjectSets.length > 0) {
    groups.push({ title: "Sub-project", sets: subProjectSets });
  }
  const projectSets = data.sources.context.filter((s) => s.scope === INSTRUCTION_SCOPE.PROJECT);
  if (projectSets.length > 0) {
    groups.push({ title: "Projects", sets: projectSets });
  }

  return (
    <ul className="divide-border divide-y">
      {groups.map((group) => (
        <li key={group.title}>
          <div className="text-muted px-3 py-1.5 text-[10px] font-semibold tracking-wider uppercase">
            {group.title}
          </div>
          <ul>
            {group.sets.flatMap((set) =>
              set.files.map((file) => (
                <FileRow key={file.path} file={file} projectName={set.projectName ?? undefined} />
              ))
            )}
          </ul>
        </li>
      ))}
    </ul>
  );
}

interface FileRowProps {
  file: InstructionFile;
  /** Denormalized from the parent set for quick display in the row. */
  projectName?: string;
}

function FileRow({ file, projectName }: FileRowProps) {
  const [expanded, setExpanded] = useState(false);

  // Show ~3 lines as a preview when collapsed; fall back to a character cap so
  // long single-line files still get truncated.
  const previewLines = file.content.split("\n").slice(0, 3).join("\n");
  const preview = previewLines.length > 240 ? `${previewLines.slice(0, 240)}…` : previewLines;
  const hasMore = file.content.length > preview.length || file.content.split("\n").length > 3;

  return (
    <li className="border-border/50 border-b last:border-b-0">
      {/* Header is the click target. The preview/expanded body lives in a sibling
          container at the same indentation so toggling never shifts the text
          horizontally — only the body's height changes. Putting the body
          outside the <button> also lets users select/scroll long files
          without accidentally collapsing the row. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:bg-accent/30 flex w-full items-start gap-2 px-3 pt-2 text-left transition-colors"
        aria-expanded={expanded}
      >
        {hasMore ? (
          expanded ? (
            <ChevronDown className="text-muted mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted mt-0.5 h-3.5 w-3.5 shrink-0" />
          )
        ) : (
          <FileText className="text-muted mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">
              {file.filename}
              {file.isLocal && (
                <span className="text-muted ml-1 text-[10px] font-normal">(local)</span>
              )}
            </span>
            <ScopeBadge scope={file.scope} projectName={projectName} />
            {/* Xum-dedicated files (~/.xum/AGENTS.md, <dir>/.xum/AGENTS.md) are the
                only sources where scoped Model:/Mode: directives are honored. */}
            {file.xumOnly && (
              <span className="text-muted bg-muted/20 shrink-0 rounded px-1.5 py-0.5 text-[9px] tracking-wider uppercase">
                mux-only
              </span>
            )}
            <span className="text-muted ml-auto shrink-0 text-[10px] tabular-nums">
              {file.tokens != null && <>~{formatTokens(file.tokens)}t · </>}
              {formatBytes(file.bytes)}
            </span>
          </div>
          <div className="text-muted mt-0.5 truncate font-mono text-[10px]" title={file.path}>
            {file.path}
          </div>
        </div>
      </button>
      {/* The body's left padding is calibrated so the text inside its <pre>
          starts exactly where the column inside the button starts — at
          `px-3 (12px) + icon h-3.5 (14px) + gap-2 (8px) = 34px` from the row
          edge. We give the body wrapper `pl-[26px]` and the inner <pre>s a
          matching `px-2 py-1` so:
            - text x-position = 26px + 8px = 34px (matches the column)
            - text y-position is identical between preview and expanded
              because both <pre>s share the same `mt-1 px-2 py-1`.
          The preview keeps an invisible border so its box height matches the
          expanded box exactly, eliminating any vertical jump. Putting the
          body outside the <button> also lets users select/scroll long files
          without accidentally collapsing the row. */}
      <div className="pr-3 pb-2 pl-[26px]">
        {!expanded && preview && (
          <pre className="text-muted mt-1 line-clamp-3 overflow-hidden rounded border border-transparent px-2 py-1 text-[11px] whitespace-pre-wrap">
            {preview}
          </pre>
        )}
        {expanded && (
          <pre className="bg-muted/10 border-border/50 mt-1 max-h-[60vh] overflow-auto rounded border px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
            {file.content}
          </pre>
        )}
      </div>
    </li>
  );
}

function ScopeBadge({ scope, projectName }: { scope: InstructionScope; projectName?: string }) {
  const label =
    scope === INSTRUCTION_SCOPE.GLOBAL
      ? "global"
      : scope === INSTRUCTION_SCOPE.WORKSPACE
        ? "workspace"
        : scope === INSTRUCTION_SCOPE.SUBPROJECT
          ? "sub-project"
          : projectName
            ? `project: ${projectName}`
            : "project";
  return (
    <span className="text-muted bg-muted/20 rounded px-1.5 py-0.5 text-[9px] tracking-wider uppercase">
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="text-muted flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 text-center text-xs">
      <FileText className="h-6 w-6 opacity-50" />
      <p>No instruction files loaded for this workspace.</p>
      <p className="text-[10px]">
        Add an <code className="bg-muted/30 rounded px-1">AGENTS.md</code> at the workspace root or
        in <code className="bg-muted/30 rounded px-1">~/.xum/</code> to provide context.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="text-muted flex h-full min-h-[120px] items-center justify-center text-xs">
      Loading instructions…
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive m-3 rounded border px-3 py-2 text-xs">
      Failed to load instructions: {message}
    </div>
  );
}

/**
 * Format token counts compactly: 1234 → "1.2k", 12345 → "12k".
 * Keeps the badge fixed-width-ish without needing tabular-nums tricks.
 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
