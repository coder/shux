import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getErrorMessage } from "@/common/utils/errors";

interface MultiProjectOption {
  projectPath: string;
  projectName: string;
}

interface MultiProjectWorkspaceCreateModalProps {
  isOpen: boolean;
  projectOptions: MultiProjectOption[];
  onClose: () => void;
  onConfirm: (projectPaths: string[]) => Promise<void>;
}

export function MultiProjectWorkspaceCreateModal(props: MultiProjectWorkspaceCreateModalProps) {
  const multiProjectWorkspacesEnabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
  const [selectedProjectPaths, setSelectedProjectPaths] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    setSelectedProjectPaths([]);
    setErrorMessage(null);
  }, [props.isOpen]);

  if (!multiProjectWorkspacesEnabled) {
    return null;
  }

  const toggleProject = (projectPath: string, checked: boolean) => {
    setSelectedProjectPaths((previous) => {
      const wasSelected = previous.includes(projectPath);
      if (checked && !wasSelected) {
        return [...previous, projectPath];
      }
      if (!checked && wasSelected) {
        return previous.filter((path) => path !== projectPath);
      }
      return previous;
    });
  };

  const handleConfirm = async () => {
    if (selectedProjectPaths.length < 2 || isCreating) {
      return;
    }

    setIsCreating(true);
    setErrorMessage(null);

    try {
      await props.onConfirm(selectedProjectPaths);
      props.onClose();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = selectedProjectPaths.length >= 2 && !isCreating;
  const hasEnoughProjects = props.projectOptions.length >= 2;

  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isCreating) {
          props.onClose();
        }
      }}
    >
      <DialogContent showCloseButton={!isCreating} maxWidth="540px">
        <DialogHeader>
          <DialogTitle>New Multi-Project Workspace</DialogTitle>
          <DialogDescription>
            Select at least two projects. Xum will create a shared workspace across the selected
            projects.
          </DialogDescription>
        </DialogHeader>

        {!hasEnoughProjects ? (
          <p className="text-muted text-sm">
            Add at least two projects before creating a multi-project workspace.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-muted text-xs">
              Selected {selectedProjectPaths.length} of {props.projectOptions.length} projects
            </p>
            <div className="border-border-medium bg-modal-bg max-h-72 space-y-1 overflow-y-auto rounded border p-2">
              {props.projectOptions.map((project) => {
                const isSelected = selectedProjectPaths.includes(project.projectPath);
                const checkboxId = `multi-project-checkbox-${project.projectPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

                return (
                  <label
                    key={project.projectPath}
                    htmlFor={checkboxId}
                    className="hover:bg-hover flex cursor-pointer items-start gap-2 rounded px-2 py-1.5"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={isSelected}
                      disabled={isCreating}
                      onCheckedChange={(checked) => {
                        toggleProject(project.projectPath, checked === true);
                      }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {project.projectName}
                      </span>
                      <span className="text-muted block truncate font-mono text-xs">
                        {project.projectPath}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {errorMessage && <p className="text-error text-xs">{errorMessage}</p>}

        <DialogFooter>
          <Button variant="secondary" onClick={props.onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={!canCreate}>
            {isCreating ? "Creating..." : "Create Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
