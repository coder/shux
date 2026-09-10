import React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { WorkspaceModeAISync } from "@/browser/components/WorkspaceModeAISync/WorkspaceModeAISync";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { WorkspaceShell } from "../WorkspaceShell/WorkspaceShell";

interface AIViewProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string; // User-friendly path for display and terminal
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** If set, workspace is incompatible (from newer mux version) and this error should be displayed */
  incompatibleRuntime?: string;
  /** True if workspace is still being initialized (postCreateSetup or initWorkspace running) */
  isInitializing?: boolean;
}

/**
 * Incompatible workspace error display.
 * Shown when a workspace was created with a newer version of xum.
 */
const IncompatibleWorkspaceView: React.FC<{ message: string; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("flex h-full w-full flex-col items-center justify-center p-8", className)}>
    <div className="max-w-md text-center">
      <div className="mb-4 flex justify-center">
        <AlertTriangle aria-hidden="true" className="text-warning h-10 w-10" />
      </div>
      <h2 className="mb-2 text-xl font-semibold text-[var(--color-text-primary)]">
        Incompatible Workspace
      </h2>
      <p className="mb-4 text-[var(--color-text-secondary)]">{message}</p>
      <p className="text-sm text-[var(--color-text-tertiary)]">
        You can delete this workspace and create a new one, or upgrade xum to use it.
      </p>
    </div>
  </div>
);

// Wrapper component that provides the agent and thinking contexts
export const AIView: React.FC<AIViewProps> = (props) => {
  // Early return for incompatible workspaces - no hooks called in this path
  if (props.incompatibleRuntime) {
    return (
      <IncompatibleWorkspaceView message={props.incompatibleRuntime} className={props.className} />
    );
  }

  return (
    <AgentProvider workspaceId={props.workspaceId} projectPath={props.projectPath}>
      <WorkspaceModeAISync workspaceId={props.workspaceId} />
      <ThinkingProvider workspaceId={props.workspaceId}>
        <BackgroundBashProvider workspaceId={props.workspaceId}>
          <WorkspaceShell {...props} />
        </BackgroundBashProvider>
      </ThinkingProvider>
    </AgentProvider>
  );
};
