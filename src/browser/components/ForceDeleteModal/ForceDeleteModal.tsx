import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  ErrorSection,
  ErrorLabel,
  ErrorCodeBlock,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";
import type { WorkspaceRemovalDescendant, WorkspaceRemoveResult } from "@/common/types/workspace";

interface ForceDeleteModalProps {
  isOpen: boolean;
  workspaceId: string;
  error: string;
  descendants?: WorkspaceRemovalDescendant[];
  onClose: () => void;
  onForceDelete: (
    workspaceId: string,
    acknowledgedDescendantIds?: string[]
  ) => Promise<WorkspaceRemoveResult>;
}

export const ForceDeleteModal: React.FC<ForceDeleteModalProps> = (props) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [failure, setFailure] = useState<WorkspaceRemoveResult | null>(null);
  const error = failure?.error ?? props.error;
  const descendants = failure ? (failure.descendants ?? []) : (props.descendants ?? []);
  const hasDescendants = descendants.length > 0;
  const hasActiveDescendants = descendants.some((descendant) => descendant.active);

  const performForceDelete = async () => {
    setIsDeleting(true);
    try {
      // Force alone does not authorize child deletion. Send only the scope shown in this dialog.
      const result = await props.onForceDelete(
        props.workspaceId,
        hasDescendants ? descendants.map((descendant) => descendant.workspaceId) : undefined
      );
      if (result.success) {
        props.onClose();
      } else {
        setFailure(result);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleForceDelete = () => {
    if (isDeleting || hasActiveDescendants) return;
    performForceDelete().catch((err: unknown) => {
      setFailure({ success: false, error: getErrorMessage(err), descendants });
    });
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && !isDeleting) props.onClose();
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableElement(e.target)) return;
    stopKeyboardPropagation(e);
    if (isDeleting) return;
    if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_YES)) {
      e.preventDefault();
      return handleForceDelete();
    } else if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_NO)) {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        maxWidth="600px"
        maxHeight="90vh"
        showCloseButton={false}
        onKeyDown={handleDialogKeyDown}
      >
        <DialogHeader>
          <DialogTitle>
            {hasActiveDescendants
              ? "Cannot Delete Workspace"
              : hasDescendants
                ? "Delete Workspace and Descendants?"
                : "Force Delete Workspace?"}
          </DialogTitle>
          <DialogDescription>
            {hasActiveDescendants
              ? "Stop the active descendants before deleting this workspace."
              : "The workspace could not be removed normally."}
          </DialogDescription>
        </DialogHeader>
        <ErrorSection>
          <ErrorLabel>Deletion Error</ErrorLabel>
          <ErrorCodeBlock>{error}</ErrorCodeBlock>
        </ErrorSection>

        {hasDescendants && (
          <section aria-label="Descendant workspaces" className="min-w-0 space-y-2 text-sm">
            <p>Deletion includes these descendants, deepest-first:</p>
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {descendants.map((descendant) => (
                <li key={descendant.workspaceId} className="min-w-0 break-words">
                  <span>{descendant.title}</span>
                  <span className="text-muted block text-xs break-all">
                    {descendant.workspaceId} — {descendant.active ? "Active" : "Inactive"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!hasActiveDescendants && (
          <WarningBox>
            <WarningTitle>This action cannot be undone</WarningTitle>
            <WarningText>
              {hasDescendants
                ? "Deletion permanently removes this workspace and the listed descendants, including their histories and local branches. Uncommitted work can be lost."
                : error.includes("unpushed commits:")
                  ? "Force deletion permanently removes this workspace and its local branch, including the unpushed commits shown above."
                  : "Force deletion permanently removes this workspace and its local branch. Uncommitted work and other data can be lost."}
            </WarningText>
          </WarningBox>
        )}

        <DialogFooter className="flex-wrap justify-center">
          <Button variant="secondary" onClick={props.onClose} disabled={isDeleting}>
            {hasActiveDescendants ? "Close" : "Cancel"}
            <span aria-hidden="true" className="ml-2 hidden font-mono text-xs sm:inline">
              N
            </span>
          </Button>
          {!hasActiveDescendants && (
            <Button
              variant="destructive"
              className="h-auto whitespace-normal"
              onClick={handleForceDelete}
              disabled={isDeleting}
            >
              {isDeleting
                ? "Deleting..."
                : hasDescendants
                  ? "Delete Workspace and Descendants"
                  : "Force Delete"}
              <span aria-hidden="true" className="ml-2 hidden font-mono text-xs sm:inline">
                Y
              </span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
