import { Bot, X } from "lucide-react";

interface AgentsInitBannerProps {
  onRunInit: () => void | Promise<void>;
  onDismiss: () => void;
}

/**
 * Banner prompting the user to run /init to create an AGENTS.md.
 * Shown on the project creation screen for newly added projects.
 */
export function AgentsInitBanner(props: AgentsInitBannerProps) {
  return (
    <div
      className="bg-bg-dark border-border-medium flex items-center gap-3 rounded-lg border px-4 py-3"
      data-testid="agents-init-banner"
    >
      <Bot className="text-muted-foreground h-5 w-5 shrink-0" />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">
          Initialize this repo for better results
        </span>
        <span className="text-muted-foreground text-xs">
          Add or improve an{" "}
          <code className="bg-bg-dark-hover rounded px-1 font-mono">AGENTS.md</code>
          so Xum learns your repo’s commands, conventions, and constraints.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void props.onRunInit()}
          className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
          data-testid="agents-init-run"
        >
          Run /init
        </button>
        <button
          type="button"
          onClick={props.onDismiss}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground inline-flex items-center rounded p-1 transition-colors"
          data-testid="agents-init-dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
