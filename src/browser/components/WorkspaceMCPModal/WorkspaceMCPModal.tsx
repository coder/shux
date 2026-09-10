import React, { useCallback, useEffect, useRef, useState } from "react";
import { Server, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Switch } from "@/browser/components/Switch/Switch";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { ToolSelector } from "@/browser/components/ToolSelector/ToolSelector";

interface WorkspaceMCPModalProps {
  workspaceId: string;
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const WorkspaceMCPModal: React.FC<WorkspaceMCPModalProps> = ({
  workspaceId,
  projectPath,
  open,
  onOpenChange,
}) => {
  const settings = useSettings();
  const { api } = useAPI();

  // State for project servers and workspace overrides
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [overrides, setOverrides] = useState<WorkspaceMCPOverrides>({});
  // Revision of the loaded overrides snapshot. Saves pass it back so the
  // backend can reject stale snapshots (e.g. after a plugin uninstall pruned
  // this workspace's plugin: keys while the dialog was open).
  const [overridesRevision, setOverridesRevision] = useState<string | null>(null);
  const [loadingTools, setLoadingTools] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use shared cache for tool test results
  const { getTools, setResult, reload: reloadCache } = useMCPTestCache(projectPath, workspaceId);

  // Ref so the effect can call reloadCache without depending on its identity.
  // We only want to re-fire the effect when the modal opens (open/api/ids change),
  // not when the cache hook recreates the reload callback.
  const reloadCacheRef = useRef(reloadCache);
  reloadCacheRef.current = reloadCache;

  // Load project servers and workspace overrides when modal opens
  useEffect(() => {
    if (!open || !api) return;

    // Reload cache when modal opens
    reloadCacheRef.current();

    const loadData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [projectServers, workspaceOverrides] = await Promise.all([
          // workspaceId scopes Agent Plugins servers to this workspace's active
          // checkout (and hides them entirely for off-host workspaces).
          api.mcp.list({ projectPath, workspaceId }),
          api.workspace.mcp.get({ workspaceId }),
        ]);
        setServers(projectServers ?? {});
        setOverrides(workspaceOverrides.overrides ?? {});
        setOverridesRevision(workspaceOverrides.revision);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load MCP configuration");
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, [open, api, projectPath, workspaceId]);

  // Fetch/refresh tools for a server
  const fetchTools = useCallback(
    async (serverName: string) => {
      if (!api) return;
      setLoadingTools((prev) => ({ ...prev, [serverName]: true }));
      try {
        const result = await api.mcp.test({ projectPath, name: serverName, workspaceId });
        setResult(serverName, result);
        if (!result.success) {
          setError(`Failed to fetch tools for ${serverName}: ${result.error}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to fetch tools for ${serverName}`);
      } finally {
        setLoadingTools((prev) => ({ ...prev, [serverName]: false }));
      }
    },
    [api, projectPath, workspaceId, setResult]
  );

  /**
   * Determine if a server is effectively enabled for this workspace.
   * Logic:
   * - If in enabledServers: enabled (overrides project disabled)
   * - If in disabledServers: disabled (overrides project enabled)
   * - Otherwise: use project-level state (info.disabled)
   */
  const isServerEnabled = useCallback(
    (serverName: string, projectDisabled: boolean): boolean => {
      if (overrides.enabledServers?.includes(serverName)) return true;
      if (overrides.disabledServers?.includes(serverName)) return false;
      return !projectDisabled;
    },
    [overrides.enabledServers, overrides.disabledServers]
  );

  // Toggle server enabled/disabled for workspace
  const toggleServerEnabled = useCallback(
    (serverName: string, enabled: boolean, projectDisabled: boolean) => {
      setOverrides((prev) => {
        const currentEnabled = prev.enabledServers ?? [];
        const currentDisabled = prev.disabledServers ?? [];

        let newEnabled: string[];
        let newDisabled: string[];

        if (enabled) {
          // Enabling the server
          newDisabled = currentDisabled.filter((s) => s !== serverName);
          if (projectDisabled) {
            // Need explicit enable to override project disabled
            newEnabled = [...currentEnabled, serverName];
          } else {
            // Project already enabled, just remove from disabled list
            newEnabled = currentEnabled.filter((s) => s !== serverName);
          }
        } else {
          // Disabling the server
          newEnabled = currentEnabled.filter((s) => s !== serverName);
          if (projectDisabled) {
            // Project already disabled, just remove from enabled list
            newDisabled = currentDisabled.filter((s) => s !== serverName);
          } else {
            // Need explicit disable to override project enabled
            newDisabled = [...currentDisabled, serverName];
          }
        }

        return {
          ...prev,
          enabledServers: newEnabled.length > 0 ? newEnabled : undefined,
          disabledServers: newDisabled.length > 0 ? newDisabled : undefined,
        };
      });
    },
    []
  );

  // Check if all tools are allowed (no allowlist set)
  const hasNoAllowlist = useCallback(
    (serverName: string): boolean => {
      return !overrides.toolAllowlist?.[serverName];
    },
    [overrides.toolAllowlist]
  );

  // Toggle tool in allowlist
  const toggleToolAllowed = useCallback(
    (serverName: string, toolName: string, allowed: boolean) => {
      const allTools = getTools(serverName) ?? [];
      setOverrides((prev) => {
        const currentAllowlist = prev.toolAllowlist ?? {};
        const serverAllowlist = currentAllowlist[serverName];

        let newServerAllowlist: string[];
        if (allowed) {
          // Adding tool to allowlist
          if (!serverAllowlist) {
            // No allowlist yet - create one with all tools except this one removed
            // Actually, if we're adding and there's no allowlist, all are already allowed
            // So we don't need to do anything
            return prev;
          }
          newServerAllowlist = [...serverAllowlist, toolName];
        } else {
          // Removing tool from allowlist
          if (!serverAllowlist) {
            // No allowlist yet - create one with all tools except this one
            newServerAllowlist = allTools.filter((t) => t !== toolName);
          } else {
            newServerAllowlist = serverAllowlist.filter((t) => t !== toolName);
          }
        }

        // If allowlist contains all tools, remove it (same as no restriction)
        const newAllowlist = { ...currentAllowlist };
        if (newServerAllowlist.length === allTools.length) {
          delete newAllowlist[serverName];
        } else {
          newAllowlist[serverName] = newServerAllowlist;
        }

        return {
          ...prev,
          toolAllowlist: Object.keys(newAllowlist).length > 0 ? newAllowlist : undefined,
        };
      });
    },
    [getTools]
  );

  // Set "all tools allowed" for a server (remove from allowlist)
  const setAllToolsAllowed = useCallback((serverName: string) => {
    setOverrides((prev) => {
      const newAllowlist = { ...prev.toolAllowlist };
      delete newAllowlist[serverName];
      return {
        ...prev,
        toolAllowlist: Object.keys(newAllowlist).length > 0 ? newAllowlist : undefined,
      };
    });
  }, []);

  // Set "no tools allowed" for a server (empty allowlist)
  const setNoToolsAllowed = useCallback((serverName: string) => {
    setOverrides((prev) => {
      return {
        ...prev,
        toolAllowlist: {
          ...prev.toolAllowlist,
          [serverName]: [],
        },
      };
    });
  }, []);

  // Save overrides
  const handleSave = useCallback(async () => {
    if (!api || overridesRevision === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.workspace.mcp.set({
        workspaceId,
        overrides,
        expectedRevision: overridesRevision,
      });
      if (!result.success) {
        setError(result.error);
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [api, workspaceId, overrides, overridesRevision, onOpenChange]);

  const serverEntries = Object.entries(servers);

  const handleOpenProjectSettings = useCallback(() => {
    onOpenChange(false);
    settings.open("mcp");
  }, [onOpenChange, settings]);
  const hasServers = serverEntries.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Workspace MCP Configuration
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted h-6 w-6 animate-spin" />
          </div>
        ) : !hasServers ? (
          <div className="text-muted py-8 text-center">
            <p>No MCP servers configured for this project.</p>
            <p className="mt-2 text-sm">
              Configure servers in{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 align-baseline"
                onClick={handleOpenProjectSettings}
              >
                Settings → MCP
              </Button>{" "}
              to use them here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-muted flex-1 pr-3 text-sm">
                Customize which MCP servers and tools are available in this workspace. Changes only
                affect this workspace.
              </p>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>

            {error && (
              <div className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-4">
              {serverEntries.map(([name, info]) => {
                const projectDisabled = info.disabled;
                const effectivelyEnabled = isServerEnabled(name, projectDisabled);
                const tools = getTools(name);
                const isLoadingTools = loadingTools[name];
                const allowedTools = overrides.toolAllowlist?.[name] ?? tools ?? [];
                // Agent Plugin servers keep the instance key as the override
                // name but display readable provenance (plugin/server).
                const displayName = info.plugin
                  ? `${info.plugin.pluginName}/${info.plugin.serverName}`
                  : name;

                return (
                  <div
                    key={name}
                    className={cn(
                      "border-border rounded-lg border p-4",
                      !effectivelyEnabled && "opacity-50"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {/* min-w-0 chain: repo-controlled plugin/server names can be
                          long unbroken tokens; without it they push the Fetch
                          Tools button past the dialog edge at narrow widths. */}
                      <div className="flex min-w-0 items-center gap-3">
                        <Switch
                          checked={effectivelyEnabled}
                          onCheckedChange={(checked) =>
                            toggleServerEnabled(name, checked, projectDisabled)
                          }
                          aria-label={`Toggle ${displayName} MCP server`}
                        />
                        <div className="min-w-0">
                          {/* wrap-anywhere (not truncate/break-words): repo-controlled
                              names must stay fully readable, and only overflow-wrap:
                              anywhere shrinks intrinsic min-content so the dialog's
                              grid track cannot be inflated by an unbroken token. */}
                          <div className="font-medium wrap-anywhere">{displayName}</div>
                          {info.plugin ? (
                            <div className="text-muted text-xs wrap-anywhere">
                              Agent Plugin ({info.plugin.sourceScope} · {info.plugin.sourceLocation}
                              ) — disabled by default
                            </div>
                          ) : (
                            projectDisabled && (
                              <div className="text-muted text-xs">(disabled at project level)</div>
                            )
                          )}
                        </div>
                      </div>
                      {effectivelyEnabled && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void fetchTools(name)}
                          disabled={isLoadingTools}
                        >
                          {isLoadingTools ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : tools ? (
                            "Refresh Tools"
                          ) : (
                            "Fetch Tools"
                          )}
                        </Button>
                      )}
                    </div>

                    {/* Tool allowlist section */}
                    {effectivelyEnabled && tools && tools.length > 0 && (
                      <div className="mt-4 border-t pt-4">
                        <ToolSelector
                          availableTools={tools}
                          allowedTools={allowedTools}
                          onToggle={(tool, allowed) => toggleToolAllowed(name, tool, allowed)}
                          onSelectAll={() => setAllToolsAllowed(name)}
                          onSelectNone={() => setNoToolsAllowed(name)}
                        />
                        {!hasNoAllowlist(name) && (
                          <div className="text-muted mt-2 text-xs">
                            {allowedTools.length} of {tools.length} tools enabled
                          </div>
                        )}
                      </div>
                    )}

                    {effectivelyEnabled && tools?.length === 0 && (
                      <div className="text-muted mt-2 text-sm">No tools available</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
