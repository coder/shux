import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { cn } from "@/common/lib/utils";
import { CREATION_COLUMN_MAX_WIDTH_CLASS } from "@/constants/layout";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { ChatInput } from "@/browser/features/ChatInput";
import type { ChatInputAPI, WorkspaceCreatedOptions } from "@/browser/features/ChatInput/types";
import { hasConfiguredProvider, useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { ConfigureProvidersPrompt } from "@/browser/components/ConfigureProvidersPrompt/ConfigureProvidersPrompt";
import { ConfiguredProvidersBar } from "@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { ArchivedWorkspaces } from "@/browser/components/ArchivedWorkspaces/ArchivedWorkspaces";
import { Button } from "@/browser/components/Button/Button";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";

interface ScratchPageProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  pendingDraftId?: string | null;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => void;
}

async function listArchivedScratchWorkspaces(api: APIClient | null) {
  if (!api) return [];
  const archived = await api.workspace.list({ archived: true });
  return archived.filter((workspace) => workspace.kind === "scratch");
}

export function ScratchPage(props: ScratchPageProps) {
  const { api } = useAPI();
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<FrontendWorkspaceMetadata[]>([]);
  const didAutoFocusRef = useRef(false);
  const { config: providersConfig, loading: providersLoading } = useProvidersConfig();
  const hasProviders = hasConfiguredProvider(providersConfig);

  async function refreshArchivedWorkspaces() {
    setArchivedWorkspaces(await listArchivedScratchWorkspaces(api));
  }

  useEffect(() => {
    let ignore = false;
    listArchivedScratchWorkspaces(api)
      .then((archived) => {
        if (!ignore) setArchivedWorkspaces(archived);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [api]);

  function handleChatReady(api: ChatInputAPI) {
    if (didAutoFocusRef.current) return;
    didAutoFocusRef.current = true;
    api.focus();
  }

  return (
    <AgentProvider projectPath={SCRATCH_PROJECT_CONFIG_KEY}>
      <ThinkingProvider projectPath={SCRATCH_PROJECT_CONFIG_KEY}>
        <div className="bg-surface-primary relative flex flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "bg-sidebar border-border-light mobile-sticky-header flex shrink-0 items-center border-b px-2 [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
              isDesktopMode() ? "h-10 titlebar-drag" : "h-8"
            )}
          >
            {props.leftSidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                onClick={props.onToggleLeftSidebarCollapsed}
                aria-label="Open sidebar menu"
                className={cn(
                  "hidden mobile-menu-btn h-6 w-6 shrink-0 text-muted hover:text-foreground",
                  isDesktopMode() && "titlebar-no-drag"
                )}
              >
                <Menu className="h-4 w-4" />
              </Button>
            )}
          </div>
          {/* mobile-header-spacer keeps content below the fixed mobile header on touch devices. */}
          <div className="mobile-header-spacer min-h-0 flex-1 overflow-y-auto">
            <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-6">
              <div className={cn("flex w-full flex-col gap-4", CREATION_COLUMN_MAX_WIDTH_CLASS)}>
                {!providersLoading && !hasProviders ? (
                  <ConfigureProvidersPrompt />
                ) : (
                  <>
                    <ChatInput
                      key={`${SCRATCH_PROJECT_CONFIG_KEY}:${props.pendingDraftId ?? "__pending__"}`}
                      variant="creation"
                      kind="scratch"
                      projectPath={SCRATCH_PROJECT_CONFIG_KEY}
                      projectName={SCRATCH_PROJECT_NAME}
                      pendingDraftId={props.pendingDraftId}
                      onReady={handleChatReady}
                      onWorkspaceCreated={props.onWorkspaceCreated}
                    />
                    {providersLoading ? (
                      <div className="flex items-center justify-center gap-2 py-1.5">
                        <Skeleton className="h-7 w-32" />
                      </div>
                    ) : (
                      providersConfig && (
                        <ConfiguredProvidersBar providersConfig={providersConfig} />
                      )
                    )}
                  </>
                )}
              </div>
            </div>
            {archivedWorkspaces.length > 0 && (
              <div className="flex justify-center px-4 pb-4">
                <div className={cn("w-full", CREATION_COLUMN_MAX_WIDTH_CLASS)}>
                  <ArchivedWorkspaces
                    projectPath={SCRATCH_PROJECT_CONFIG_KEY}
                    projectName={SCRATCH_PROJECT_NAME}
                    workspaces={archivedWorkspaces}
                    onWorkspacesChanged={() => {
                      refreshArchivedWorkspaces().catch(() => undefined);
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </ThinkingProvider>
    </AgentProvider>
  );
}
