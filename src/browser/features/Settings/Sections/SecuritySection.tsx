import { useRef, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAPI } from "@/browser/contexts/API";

/**
 * Security settings section — manages per-project trust state.
 * Trusted projects can run hooks and scripts (.xum/tool_env, tool_pre, tool_post, git hooks).
 * Untrusted projects have all hook/script execution disabled.
 */
export function SecuritySection() {
  const { api } = useAPI();
  const { userProjects, refreshProjects } = useProjectContext();
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const handleToggleTrust = async (projectPath: string, currentlyTrusted: boolean) => {
    if (!api || pendingRef.current) return;
    pendingRef.current = true;
    try {
      setPendingPath(projectPath);
      await api.projects.setTrust({ projectPath, trusted: !currentlyTrusted });
      await refreshProjects();
    } catch {
      // Best-effort — config refresh will reflect actual state
    } finally {
      pendingRef.current = false;
      setPendingPath(null);
    }
  };

  const projectEntries = Array.from(userProjects.entries());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Project Trust</h3>
        <p className="text-muted text-xs">
          Trusted projects can run hooks and scripts from the repository. Untrusted projects have
          all hook and script execution disabled for security.
        </p>
      </div>
      {projectEntries.length === 0 ? (
        <p className="text-muted text-sm">No projects added yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {projectEntries.map(([path, config]) => {
            const trusted = config.trusted === true;
            const name = path.split(/[/\\]/).pop() ?? path;
            return (
              <div
                key={path}
                className="border-border-medium flex items-center gap-3 rounded-md border px-3 py-2"
              >
                {trusted ? (
                  <ShieldCheck className="text-success size-4 shrink-0" />
                ) : (
                  <ShieldOff className="text-muted size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-sm">{name}</div>
                  <div className="text-muted truncate text-xs">{path}</div>
                </div>
                <Button
                  size="sm"
                  variant={trusted ? "outline" : "default"}
                  disabled={pendingPath != null}
                  aria-label={`${trusted ? "Revoke trust for" : "Trust"} ${name}`}
                  onClick={() => {
                    void handleToggleTrust(path, trusted);
                  }}
                >
                  {pendingPath === path ? "Saving…" : trusted ? "Revoke trust" : "Trust"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
