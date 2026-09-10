import { useWorkspacePR, useWorkspaceStack } from "@/browser/stores/PRStatusStore";
import { PRLinkBadge } from "../PRLinkBadge/PRLinkBadge";
import { PRStackBadge } from "../PRStackBadge/PRStackBadge";

interface WorkspaceLinksProps {
  workspaceId: string;
  /** Applied to each badge so callers can hide them without leaving empty flex items. */
  className?: string;
  menuDirection?: "up" | "down";
}

export function WorkspaceLinks(props: WorkspaceLinksProps) {
  const workspacePR = useWorkspacePR(props.workspaceId);
  const workspaceStack = useWorkspaceStack(props.workspaceId);

  if (!workspacePR && !workspaceStack) {
    return null;
  }

  return (
    <>
      {workspacePR && <PRLinkBadge prLink={workspacePR} className={props.className} />}
      {workspaceStack && (
        <PRStackBadge
          stack={workspaceStack}
          className={props.className}
          menuDirection={props.menuDirection}
        />
      )}
    </>
  );
}
