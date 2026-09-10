import { MemoryBrowser } from "@/browser/features/Memory/MemoryBrowser";

/**
 * Settings → Memory (experiment: "memory") — manages GLOBAL memory files
 * without a workspace: the memory.* routes are called with workspaceId null,
 * so only the global scope (~/.xum/memory/global) is reachable. Project/workspace
 * memories are curated from each workspace's Memory tab instead.
 */
export function MemorySection() {
  return (
    // flex-1/min-h-0 lets the file editor (and the browser list) fill the
    // remaining settings-page height instead of collapsing to its min-height.
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Global Memories</h3>
        <p className="text-muted text-xs">
          Memory files the agent shares across every project and workspace. Project and workspace
          memories live in the Memory tab of each workspace.
        </p>
      </div>
      {/* Bordered panel so the editable area is visually distinct from the
          settings page background (the sidebar Memory tab has its own chrome). */}
      <div className="border-border-light flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <MemoryBrowser workspaceId={null} scopes={["global"]} />
      </div>
    </div>
  );
}
