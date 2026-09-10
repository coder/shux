import React, { useCallback, useEffect, useState } from "react";
import type { ProjectConfig } from "@/common/types/project";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import {
  formatProjectHierarchyLabel,
  getFirstTopLevelProjectPath,
  getTopLevelProjectEntries,
} from "@/common/utils/subProjects";

// Workspaces are owned by top-level projects (sub-project rows only re-point
// cwd/AGENTS.md context), so instructions on a sub-project entry would never
// be applied. Mirror the Secrets page and keep sub-projects out of the picker.
function isProjectInstructionsTarget(
  userProjects: Map<string, ProjectConfig>,
  projectPath: string
): boolean {
  const project = userProjects.get(projectPath);
  return project !== undefined && project.parentProjectPath == null;
}

export const InstructionsSection: React.FC = () => {
  const { userProjects, updateCustomInstructions } = useProjectContext();
  const { instructionsProjectPath, setInstructionsProjectPath } = useSettings();
  const projectList = getTopLevelProjectEntries(userProjects).map(([projectPath]) => projectPath);

  const [selectedProject, setSelectedProject] = useState<string>("");
  // null = untouched: the textarea shows the saved value for the selection.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Consume the one-shot project hint from the sidebar menu, falling back to
  // the first project. Projects load asynchronously, so the hint stays alive
  // until its project appears. One effect, hint first: as separate effects
  // both fired on mount against an empty selection and the later default
  // update won the batch, opening the editor on the wrong project.
  useEffect(() => {
    if (
      instructionsProjectPath &&
      isProjectInstructionsTarget(userProjects, instructionsProjectPath)
    ) {
      setSelectedProject(instructionsProjectPath);
      setDraft(null);
      setError(null);
      setInstructionsProjectPath(null);
      return;
    }
    if (selectedProject && isProjectInstructionsTarget(userProjects, selectedProject)) {
      return;
    }
    setSelectedProject(getFirstTopLevelProjectPath(userProjects) ?? "");
  }, [instructionsProjectPath, selectedProject, userProjects, setInstructionsProjectPath]);

  const savedInstructions = selectedProject
    ? (userProjects.get(selectedProject)?.customInstructions ?? "")
    : "";
  const draftValue = draft ?? savedInstructions;
  const isDirty = draftValue !== savedInstructions;

  const handleSelectProject = useCallback((projectPath: string) => {
    setSelectedProject(projectPath);
    setDraft(null);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedProject) return;
    setSaving(true);
    setError(null);
    const result = await updateCustomInstructions(
      selectedProject,
      draftValue.trim() ? draftValue : null
    );
    if (result.success) {
      setDraft(null);
    } else {
      setError(result.error ?? "Failed to save instructions");
    }
    setSaving(false);
  }, [draftValue, selectedProject, updateCustomInstructions]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted text-xs">
          Custom instructions are appended to the system prompt of every workspace in the selected
          project. They are stored in <code className="text-accent">~/.mux/config.json</code> (kept
          out of source control).
        </p>
        <p className="text-muted mt-1 text-xs">
          For instructions shared with all agents and contributors, use the project&apos;s{" "}
          <code className="text-accent">AGENTS.md</code>; for global personal instructions, use{" "}
          <code className="text-accent">~/.xum/AGENTS.md</code>.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-foreground text-sm">Project</div>
          <div className="text-muted text-xs">Select a project to configure</div>
        </div>
        <Select value={selectedProject} onValueChange={handleSelectProject}>
          <SelectTrigger
            className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
            aria-label="Project"
          >
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projectList.map((projectPath) => (
              <SelectItem key={projectPath} value={projectPath}>
                {formatProjectHierarchyLabel(projectPath, userProjects)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {projectList.length === 0 ? (
        <p className="text-muted text-xs">Add a project to configure its instructions.</p>
      ) : (
        <div>
          <label htmlFor="project-custom-instructions" className="block">
            <div className="text-foreground text-sm font-medium">Custom instructions</div>
          </label>
          <textarea
            id="project-custom-instructions"
            rows={10}
            value={draftValue}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
              // Enter intentionally inserts a newline; Cmd/Ctrl+Enter saves,
              // matching the multi-line textarea convention (see GoalTab).
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (isDirty && selectedProject && !saving) {
                  void handleSave();
                }
              }
            }}
            disabled={!selectedProject || saving}
            className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent mt-3 min-h-[200px] w-full resize-y rounded-md border p-3 font-mono text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="e.g. Always run the test suite before committing. Prefer functional patterns."
            aria-label="Project custom instructions"
          />

          {error && (
            <div className="bg-destructive/10 text-destructive mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
              {error}
            </div>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              disabled={!isDirty || saving}
            >
              Reset
            </Button>
            <Button
              onClick={() => {
                void handleSave();
              }}
              disabled={!isDirty || !selectedProject || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
