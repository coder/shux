import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { useExperiment, useExperimentValue } from "@/browser/contexts/ExperimentsContext";
import {
  getExperimentList,
  getExperimentPlatformRestrictionLabel,
  EXPERIMENT_IDS,
  EXPERIMENTS,
  isExperimentSupportedOnPlatform,
  type ExperimentId,
} from "@/common/constants/experiments";
import { getErrorMessage } from "@/common/utils/errors";
import { Switch } from "@/browser/components/Switch/Switch";
import { Button } from "@/browser/components/Button/Button";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import type { ApiServerStatus, DesktopPrereqStatus } from "@/common/orpc/types";
import { Input } from "@/browser/components/Input/Input";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { AdvisorToolExperimentConfig } from "./AdvisorToolExperimentConfig";
import { HeartbeatDefaultsControls } from "./HeartbeatSection";

const PORTABLE_DESKTOP_INSTALL_URL = "https://github.com/coder/portabledesktop";

// Sub-experiments of Agent Memory: hidden from the flat list and rendered in a
// nested panel under the parent toggle, since they are no-ops while memory is off.
const MEMORY_SUB_EXPERIMENT_IDS: readonly ExperimentId[] = [
  EXPERIMENT_IDS.MEMORY_HOT_SET,
  EXPERIMENT_IDS.MEMORY_INTUITION,
  EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
];

// Sub-experiments of Programmatic Tool Calling: same nesting treatment — RLM
// mode is a no-op while PTC is off (code_execution is never assembled).
const PTC_SUB_EXPERIMENT_IDS: readonly ExperimentId[] = [EXPERIMENT_IDS.RLM];

type SettingsConfig = Awaited<ReturnType<APIClient["config"]["getConfig"]>>;

interface ExperimentRowProps {
  experimentId: ExperimentId;
  name: string;
  description: string;
  disabled?: boolean;
  availabilityMessage?: string | null;
  onToggle?: (enabled: boolean) => void;
}

function ExperimentRow(props: ExperimentRowProps) {
  const [enabled, setEnabled] = useExperiment(props.experimentId);
  const telemetry = useTelemetry();
  const { availabilityMessage, disabled = false, onToggle, experimentId } = props;

  const handleToggle = useCallback(
    (value: boolean) => {
      if (disabled) {
        return;
      }

      setEnabled(value);
      // Track the override for analytics
      telemetry.experimentOverridden(experimentId, value);
      onToggle?.(value);
    },
    [disabled, setEnabled, telemetry, experimentId, onToggle]
  );

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">{props.name}</div>
        <div className="text-muted mt-0.5 text-xs">{props.description}</div>
        {availabilityMessage && (
          <div className="text-muted mt-1 flex items-center gap-1 text-xs">
            <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span>{availabilityMessage}</span>
          </div>
        )}
      </div>
      <Switch
        checked={enabled}
        disabled={disabled}
        onCheckedChange={handleToggle}
        aria-label={`Toggle ${props.name}`}
        title={availabilityMessage ?? undefined}
      />
    </div>
  );
}

export function PortableDesktopExperimentWarning() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP);
  const { api } = useAPI();
  const [prereqStatus, setPrereqStatus] = useState<DesktopPrereqStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadPrereqStatus = useCallback(async () => {
    if (!enabled || !api) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setError(null);

    try {
      // This warning lives on /settings/experiments, where selectedWorkspace is intentionally
      // URL-derived and null. Probe the machine-level desktop prerequisite instead of a
      // workspace-scoped capability so the warning still renders on settings routes.
      const nextStatus = await api.desktop.getPrereqStatus();
      if (requestIdRef.current !== requestId) {
        return;
      }

      setPrereqStatus(nextStatus);
    } catch (e) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      setError(getErrorMessage(e));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled || !api) {
      requestIdRef.current += 1;
      setPrereqStatus(null);
      setLoading(false);
      setRestarting(false);
      setError(null);
      return;
    }

    loadPrereqStatus().catch(() => {
      // loadPrereqStatus handles error state.
    });
  }, [api, enabled, loadPrereqStatus]);

  const handleRestart = useCallback(async () => {
    if (!api) {
      return;
    }

    setError(null);
    setRestarting(true);

    try {
      const restartResult = await api.general.restartApp();
      if (!restartResult.supported) {
        setError(restartResult.message);
        return;
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setRestarting(false);
    }
  }, [api]);

  const isBinaryMissing = !prereqStatus?.available && prereqStatus?.reason === "binary_not_found";

  if (!enabled || !isBinaryMissing) {
    return null;
  }

  return (
    <div className="pb-3">
      <div className="bg-warning/10 border-warning/30 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-2">
          <div>
            The <code className="font-mono">portabledesktop</code> binary was not found in PATH, so
            Portable Desktop is currently disabled. Install it from{" "}
            <a
              href={PORTABLE_DESKTOP_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              {PORTABLE_DESKTOP_INSTALL_URL}
            </a>{" "}
            to enable this feature. If you installed it into a location that xum can already see,
            choose Check again. If you changed PATH after xum launched, restart xum to pick it up.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                void loadPrereqStatus();
              }}
              disabled={restarting}
            >
              {loading ? "Checking…" : "Check again"}
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                void handleRestart();
              }}
              disabled={loading || restarting}
            >
              {restarting ? "Restarting…" : "Restart Xum"}
            </Button>
          </div>
          {error && <div className="text-[11px]">{error}</div>}
        </div>
      </div>
    </div>
  );
}

const TAILSCALE_BIND_HOST_MODE_PREFIX = "tailscale:";

type BindHostMode =
  | "localhost"
  | "all"
  | "custom"
  | `${typeof TAILSCALE_BIND_HOST_MODE_PREFIX}${string}`;
type PortMode = "random" | "fixed";

function getTailscaleBindHostMode(address: string): BindHostMode {
  return `${TAILSCALE_BIND_HOST_MODE_PREFIX}${address}`;
}

function getTailscaleBindHostAddress(mode: BindHostMode): string | null {
  if (!mode.startsWith(TAILSCALE_BIND_HOST_MODE_PREFIX)) {
    return null;
  }

  const address = mode.slice(TAILSCALE_BIND_HOST_MODE_PREFIX.length).trim();
  return address ? address : null;
}

function formatTailscaleBindHostLabel(host: ApiServerStatus["tailscaleBindHosts"][number]): string {
  const protocol = host.family === "IPv6" ? "IPv6" : "IPv4";
  return `Tailscale ${host.interfaceName} (${host.address}, ${protocol})`;
}

function ConfigurableBindUrlControls() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.CONFIGURABLE_BIND_URL);
  const { api } = useAPI();

  const [status, setStatus] = useState<ApiServerStatus | null>(null);
  const [hostMode, setHostMode] = useState<BindHostMode>("localhost");
  const [customHost, setCustomHost] = useState<string>("");
  const [serveWebUi, setServeWebUi] = useState(false);
  const [portMode, setPortMode] = useState<PortMode>("random");
  const [fixedPort, setFixedPort] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const syncFormFromStatus = useCallback((next: ApiServerStatus) => {
    const configuredHost = next.configuredBindHost;

    if (!configuredHost || configuredHost === "127.0.0.1" || configuredHost === "localhost") {
      setHostMode("localhost");
      setCustomHost("");
    } else if (configuredHost === "0.0.0.0") {
      setHostMode("all");
      setCustomHost("");
    } else {
      const tailscaleHost = next.tailscaleBindHosts.find((host) => host.address === configuredHost);
      if (tailscaleHost) {
        setHostMode(getTailscaleBindHostMode(tailscaleHost.address));
        setCustomHost("");
      } else {
        setHostMode("custom");
        setCustomHost(configuredHost);
      }
    }

    setServeWebUi(next.configuredServeWebUi);
    const configuredPort = next.configuredPort;
    if (!configuredPort) {
      setPortMode("random");
      setFixedPort("");
    } else {
      setPortMode("fixed");
      setFixedPort(String(configuredPort));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    if (!api) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setError(null);

    try {
      const next = await api.server.getApiServerStatus();
      if (requestIdRef.current !== requestId) {
        return;
      }

      setStatus(next);
      syncFormFromStatus(next);
    } catch (e) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      setError(getErrorMessage(e));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [api, syncFormFromStatus]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    loadStatus().catch(() => {
      // loadStatus handles error state
    });
  }, [enabled, loadStatus]);

  const handleApply = useCallback(async () => {
    if (!api) {
      return;
    }

    setError(null);

    let bindHost: string | null;
    const tailscaleBindHost = getTailscaleBindHostAddress(hostMode);
    if (hostMode === "localhost") {
      bindHost = null;
    } else if (hostMode === "all") {
      bindHost = "0.0.0.0";
    } else if (tailscaleBindHost) {
      bindHost = tailscaleBindHost;
    } else {
      const trimmed = customHost.trim();
      if (!trimmed) {
        setError("Custom bind host is required.");
        return;
      }
      bindHost = trimmed;
    }

    let port: number | null;
    if (portMode === "random") {
      port = null;
    } else {
      const parsed = Number.parseInt(fixedPort, 10);

      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        setError("Port must be an integer.");
        return;
      }

      if (parsed === 0) {
        setError("Port 0 means random. Choose “Random” instead.");
        return;
      }

      if (parsed < 1 || parsed > 65535) {
        setError("Port must be between 1 and 65535.");
        return;
      }

      port = parsed;
    }

    setSaving(true);

    try {
      const next = await api.server.setApiServerSettings({
        bindHost,
        port,
        serveWebUi: serveWebUi ? true : null,
      });
      setStatus(next);
      syncFormFromStatus(next);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [api, hostMode, portMode, customHost, fixedPort, serveWebUi, syncFormFromStatus]);

  if (!enabled) {
    return null;
  }

  if (!api) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-muted text-xs">Connect to xum to configure this setting.</div>
      </div>
    );
  }

  const tailscaleBindHosts = status?.tailscaleBindHosts ?? [];
  const encodedToken = status?.token ? encodeURIComponent(status.token) : null;
  const localWebUiUrl = status?.baseUrl ? `${status.baseUrl}/` : null;
  const localWebUiUrlWithToken =
    status?.baseUrl && encodedToken ? `${status.baseUrl}/?token=${encodedToken}` : null;
  const networkWebUiUrls = status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/`) ?? [];
  const networkWebUiUrlsWithToken = encodedToken
    ? (status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/?token=${encodedToken}`) ?? [])
    : [];
  const localDocsUrl = status?.baseUrl ? `${status.baseUrl}/api/docs` : null;
  const networkDocsUrls = status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/api/docs`) ?? [];

  return (
    <div className="bg-background-secondary space-y-4 px-4 py-3">
      <div className="text-warning text-xs">
        Exposes xum’s API server to your LAN/VPN. Devices on your local network can connect if they
        have the auth token. Traffic is unencrypted HTTP; enable only on trusted networks (Tailscale
        recommended).
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Bind host</div>
            <div className="text-muted text-xs">Where xum listens for HTTP + WS connections</div>
          </div>
          <Select value={hostMode} onValueChange={(value) => setHostMode(value as BindHostMode)}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-64 cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="localhost">Localhost only (127.0.0.1)</SelectItem>
              <SelectItem value="all">All interfaces (0.0.0.0)</SelectItem>
              {tailscaleBindHosts.length > 0 ? (
                tailscaleBindHosts.map((host) => (
                  <SelectItem
                    key={`${host.family}:${host.address}`}
                    value={getTailscaleBindHostMode(host.address)}
                  >
                    {formatTailscaleBindHostLabel(host)}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="tailscale-unavailable" disabled>
                  {loading ? "Loading Tailscale devices…" : "Tailscale device not detected"}
                </SelectItem>
              )}
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {hostMode === "custom" && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Custom host</div>
              <div className="text-muted text-xs">Example: 192.168.1.10 or 100.x.y.z</div>
            </div>
            <Input
              value={customHost}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomHost(e.target.value)}
              placeholder="e.g. 192.168.1.10"
              className="border-border-medium bg-background-secondary h-9 w-64"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Port</div>
            <div className="text-muted text-xs">
              Use a fixed port to avoid changing URLs each time xum restarts
            </div>
          </div>
          <Select value={portMode} onValueChange={(value) => setPortMode(value as PortMode)}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-64 cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="random">Random (changes on restart)</SelectItem>
              <SelectItem value="fixed">Fixed…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {portMode === "fixed" && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Fixed port</div>
              <div className="text-muted text-xs">1–65535</div>
            </div>
            <Input
              value={fixedPort}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFixedPort(e.target.value)}
              placeholder="e.g. 9999"
              className="border-border-medium bg-background-secondary h-9 w-64"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Serve xum web UI</div>
            <div className="text-muted text-xs">
              Serve the xum web interface at / (browser mode)
            </div>
          </div>
          <Switch
            checked={serveWebUi}
            onCheckedChange={(value) => setServeWebUi(value)}
            aria-label="Toggle serving xum web UI"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-muted text-xs">
            {loading
              ? "Loading server status…"
              : status?.running
                ? "Server is running"
                : "Server is not running"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                loadStatus().catch((e) => {
                  setError(getErrorMessage(e));
                });
              }}
              disabled={loading || saving}
            >
              Refresh
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                handleApply().catch((e) => {
                  setError(getErrorMessage(e));
                });
              }}
              disabled={loading || saving}
            >
              {saving ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>

        {error && <div className="text-error text-xs">{error}</div>}
      </div>

      {status && (
        <div className="space-y-2">
          <div className="text-foreground text-sm font-medium">Connection info</div>

          {localDocsUrl && (
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-muted text-xs">Local docs URL</div>
                <div className="font-mono text-xs break-all">{localDocsUrl}</div>
              </div>
              <CopyButton text={localDocsUrl} />
            </div>
          )}

          {networkDocsUrls.length > 0 ? (
            <div className="space-y-2">
              {networkDocsUrls.map((docsUrl) => (
                <div key={docsUrl} className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-muted text-xs">Network docs URL</div>
                    <div className="font-mono text-xs break-all">{docsUrl}</div>
                  </div>
                  <CopyButton text={docsUrl} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted text-xs">
              No network URLs detected (bind host may still be localhost).
            </div>
          )}

          {status.configuredServeWebUi ? (
            <>
              {(localWebUiUrlWithToken ?? localWebUiUrl) && (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-muted text-xs">Local web UI URL</div>
                    <div className="font-mono text-xs break-all">
                      {localWebUiUrlWithToken ?? localWebUiUrl}
                    </div>
                  </div>
                  <CopyButton text={localWebUiUrlWithToken ?? localWebUiUrl ?? ""} />
                </div>
              )}

              {(encodedToken ? networkWebUiUrlsWithToken : networkWebUiUrls).length > 0 ? (
                <div className="space-y-2">
                  {(encodedToken ? networkWebUiUrlsWithToken : networkWebUiUrls).map((uiUrl) => (
                    <div key={uiUrl} className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="text-muted text-xs">Network web UI URL</div>
                        <div className="font-mono text-xs break-all">{uiUrl}</div>
                      </div>
                      <CopyButton text={uiUrl} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted text-xs">
                  No network URLs detected for the web UI (bind host may still be localhost).
                </div>
              )}
            </>
          ) : (
            <div className="text-muted text-xs">
              Web UI serving is disabled (enable “Serve xum web UI” and Apply to access /).
            </div>
          )}

          {status.token && (
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-muted text-xs">Auth token</div>
                <div className="font-mono text-xs break-all">{status.token}</div>
              </div>
              <CopyButton text={status.token} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ExperimentSettingsPanelProps {
  children: React.ReactNode;
}

function ExperimentSettingsPanel(props: ExperimentSettingsPanelProps) {
  return <div className="bg-background-secondary px-4 py-3">{props.children}</div>;
}

// Renders a parent experiment's sub-experiment toggles as a nested list.
// Extracted so the nested-config call sites mirror their siblings
// (AdvisorToolExperimentConfig, HeartbeatDefaultsControls) instead of
// inlining the map in the section render.
function SubExperimentRows(props: { experimentIds: readonly ExperimentId[] }) {
  return (
    <div className="divide-border-light divide-y">
      {props.experimentIds.map((subId) => {
        const subExp = EXPERIMENTS[subId];
        return (
          <ExperimentRow
            key={subId}
            experimentId={subId}
            name={subExp.name}
            description={subExp.description}
          />
        );
      })}
    </div>
  );
}

export function ExperimentsSection() {
  const allExperiments = getExperimentList();
  const { api } = useAPI();
  const advisorToolEnabled = useExperimentValue(EXPERIMENT_IDS.ADVISOR_TOOL);
  const workspaceHeartbeatsEnabled = useExperimentValue(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const ptcEnabled = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const settingsConfigRequestRef = useRef<{
    api: APIClient;
    request: Promise<SettingsConfig>;
  } | null>(null);

  useEffect(() => {
    settingsConfigRequestRef.current = null;
  }, [api]);

  const loadExperimentSettingsConfig = useCallback(() => {
    if (!api) {
      return Promise.reject(new Error("Cannot load settings config before API connection."));
    }

    const cachedRequest = settingsConfigRequestRef.current;
    if (cachedRequest?.api === api) {
      return cachedRequest.request;
    }

    const request = api.config.getConfig();
    settingsConfigRequestRef.current = { api, request };
    request.then(
      () => {
        if (settingsConfigRequestRef.current?.request === request) {
          settingsConfigRequestRef.current = null;
        }
      },
      () => {
        if (settingsConfigRequestRef.current?.request === request) {
          settingsConfigRequestRef.current = null;
        }
      }
    );
    return request;
  }, [api]);

  // Only show user-overridable experiments (non-overridable ones are hidden since users can't
  // change them). Sub-experiments render nested under their parent row instead.
  const experiments = useMemo(
    () =>
      allExperiments.filter(
        (exp) =>
          exp.showInSettings !== false &&
          !MEMORY_SUB_EXPERIMENT_IDS.includes(exp.id) &&
          !PTC_SUB_EXPERIMENT_IDS.includes(exp.id)
      ),
    [allExperiments]
  );

  const handleConfigurableBindUrlToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        return;
      }

      api?.server
        .setApiServerSettings({ bindHost: null, port: null, serveWebUi: null })
        .catch(() => {
          // ignore
        });
    },
    [api]
  );

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Experimental features that are still in development. Enable at your own risk.
      </p>
      <div className="divide-border-light divide-y">
        {experiments.map((exp) => {
          const isSupported = isExperimentSupportedOnPlatform(exp, window.api?.platform);
          const availabilityMessage = isSupported
            ? null
            : getExperimentPlatformRestrictionLabel(exp);

          return (
            <React.Fragment key={exp.id}>
              <ExperimentRow
                experimentId={exp.id}
                name={exp.name}
                description={exp.description}
                disabled={!isSupported}
                availabilityMessage={availabilityMessage}
                onToggle={
                  exp.id === EXPERIMENT_IDS.CONFIGURABLE_BIND_URL
                    ? handleConfigurableBindUrlToggle
                    : undefined
                }
              />
              {exp.id === EXPERIMENT_IDS.ADVISOR_TOOL && advisorToolEnabled && (
                <AdvisorToolExperimentConfig />
              )}
              {exp.id === EXPERIMENT_IDS.WORKSPACE_HEARTBEATS && workspaceHeartbeatsEnabled && (
                <ExperimentSettingsPanel>
                  <HeartbeatDefaultsControls
                    loadConfig={api ? loadExperimentSettingsConfig : undefined}
                  />
                </ExperimentSettingsPanel>
              )}
              {exp.id === EXPERIMENT_IDS.MEMORY && memoryEnabled && (
                <ExperimentSettingsPanel>
                  <SubExperimentRows experimentIds={MEMORY_SUB_EXPERIMENT_IDS} />
                </ExperimentSettingsPanel>
              )}
              {exp.id === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING && ptcEnabled && (
                <ExperimentSettingsPanel>
                  <SubExperimentRows experimentIds={PTC_SUB_EXPERIMENT_IDS} />
                </ExperimentSettingsPanel>
              )}
              {exp.id === EXPERIMENT_IDS.PORTABLE_DESKTOP && <PortableDesktopExperimentWarning />}
              {exp.id === EXPERIMENT_IDS.CONFIGURABLE_BIND_URL && <ConfigurableBindUrlControls />}
            </React.Fragment>
          );
        })}
      </div>
      {experiments.length === 0 && (
        <p className="text-muted py-4 text-center text-sm">
          No experiments available at this time.
        </p>
      )}
    </div>
  );
}
