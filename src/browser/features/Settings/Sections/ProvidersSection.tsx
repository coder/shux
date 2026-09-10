import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type DragEndEvent,
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { getAllowedProvidersForUi } from "@/browser/utils/policyUi";
import { ProviderIcon, ProviderWithIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  formatMuxGatewayBalance,
  useMuxGatewayAccountStatus,
} from "@/browser/hooks/useMuxGatewayAccountStatus";
import { useRouting } from "@/browser/hooks/useRouting";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";
import { getErrorMessage } from "@/common/utils/errors";

import { repairLocalModelPreferencesForRemovedProvider } from "@/browser/utils/modelPreferenceRepair";
import {
  CUSTOM_PROVIDER_TYPES,
  formatProviderDisplayName,
  isBuiltInProvider,
  isCustomProviderConfig,
  isCustomProviderType,
  validateCustomProviderBaseUrl,
  validateCustomProviderId,
  type CustomProviderType,
} from "@/common/utils/providers/customProviders";
import type { AddCustomProviderInput, ProviderConfigInfo } from "@/common/orpc/types";
import type { ServiceTier, XAIServiceTier } from "@/common/config/schemas/providersConfig";
import type { Result } from "@/common/types/result";
import { CODER_OAUTH_SERVER_START_PATH } from "@/common/constants/coderOAuth";

type MuxGatewayLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";
type CodexOauthFlowStatus = "idle" | "starting" | "waiting" | "error";
type CopilotLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

const CUSTOM_PROVIDER_TYPE_LABELS: Record<CustomProviderType, string> = {
  "openai-compatible": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

const OPENAI_SERVICE_TIER_UNSET = "unset";

type OpenAIServiceTier = ServiceTier;
type OpenAIServiceTierSelectValue = typeof OPENAI_SERVICE_TIER_UNSET | OpenAIServiceTier;

function isOpenAIServiceTier(value: string): value is OpenAIServiceTier {
  return value === "auto" || value === "default" || value === "flex" || value === "priority";
}

function isXAIServiceTier(value: string): value is XAIServiceTier {
  return value === "default" || value === "priority";
}

interface CodexOauthDeviceFlow {
  flowId: string;
  userCode: string;
  verifyUrl: string;
}

interface OAuthMessage {
  type?: unknown;
  state?: unknown;
  ok?: unknown;
  error?: unknown;
}

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

/**
 * Flow ID for a Coder login. It doubles as the OAuth `state` (CSRF token), so
 * it must be unguessable: derived from getRandomValues, which — unlike
 * Crypto.randomUUID — is available outside secure contexts too (Xum's browser
 * UI can be served from a plain-HTTP remote origin, where randomUUID is
 * undefined and would throw before the login even started).
 */
function createCoderLoginFlowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Browser/server-mode "Login with Coder": the Xum server registers the flow
 * with a redirect URI on its own origin (built server-side from the request
 * host, so the OAuth callback reaches the server no matter where the browser
 * runs). A raw HTTP route rather than oRPC because only the HTTP request
 * carries that public host; the rest of the flow (wait/cancel) stays on oRPC.
 */
async function startCoderServerFlow(
  backendBaseUrl: string,
  deploymentUrl: string,
  flowId: string
): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
  const startUrl = new URL(`${backendBaseUrl}${CODER_OAUTH_SERVER_START_PATH}`);
  startUrl.searchParams.set("deploymentUrl", deploymentUrl);
  startUrl.searchParams.set("flowId", flowId);
  const authToken = getServerAuthToken();
  const res = await fetch(startUrl, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const prefix = (await res.text()).trim().slice(0, 80);
    return {
      success: false,
      error: `Unexpected response from ${startUrl.pathname} (expected JSON, got ${
        contentType || "unknown"
      }): ${prefix}`,
    };
  }
  const json = (await res.json()) as { authorizeUrl?: unknown; flowId?: unknown; error?: unknown };
  if (!res.ok) {
    return {
      success: false,
      error: typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
    };
  }
  if (typeof json.authorizeUrl !== "string" || typeof json.flowId !== "string") {
    return { success: false, error: `Invalid response from ${startUrl.pathname}` };
  }
  return { success: true, data: { flowId: json.flowId, authorizeUrl: json.authorizeUrl } };
}

interface FieldConfig {
  key: string;
  label: string;
  placeholder: string;
  type: "secret" | "text";
  optional?: boolean;
}

function isCustomProviderInfo(
  providerInfo: ProviderConfigInfo | undefined
): providerInfo is ProviderConfigInfo & {
  isCustom: true;
  providerType: CustomProviderType;
} {
  return providerInfo?.isCustom === true && isCustomProviderConfig(providerInfo);
}

/**
 * Get provider-specific field configuration.
 * Most providers use API Key + Base URL, but some (like Bedrock) have different needs.
 */
function getProviderFields(provider: string, providerInfo?: ProviderConfigInfo): FieldConfig[] {
  if (isCustomProviderInfo(providerInfo)) {
    return [
      {
        key: "displayName",
        label: "Display name",
        placeholder: "My custom provider",
        type: "text",
      },
      {
        key: "apiKey",
        label: "API key",
        placeholder: "Enter API key",
        type: "secret",
        optional: true,
      },
      {
        key: "apiKeyFile",
        label: "API key file",
        placeholder: "~/.config/coder/session_token",
        type: "text",
        optional: true,
      },
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://api.example.com/v1",
        type: "text",
      },
    ];
  }

  if (!isBuiltInProvider(provider)) {
    return [];
  }

  if (provider === "bedrock") {
    return [
      { key: "region", label: "Region", placeholder: "us-east-1", type: "text" },
      {
        key: "profile",
        label: "AWS Profile",
        placeholder: "my-sso-profile",
        type: "text",
        optional: true,
      },
      {
        key: "bearerToken",
        label: "Bearer Token",
        placeholder: "AWS_BEARER_TOKEN_BEDROCK",
        type: "secret",
        optional: true,
      },
      {
        key: "accessKeyId",
        label: "Access Key ID",
        placeholder: "AWS Access Key ID",
        type: "secret",
        optional: true,
      },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        placeholder: "AWS Secret Access Key",
        type: "secret",
        optional: true,
      },
    ];
  }

  if (provider === "mux-gateway") {
    return [];
  }

  if (provider === "github-copilot") {
    return []; // OAuth-based, no manual key entry
  }

  // Guarded on isCustom: an upgraded install may carry a custom
  // custom provider named "coder" that intentionally shadows the
  // built-in (see detectAndLogShadowedProviders); it must keep its custom
  // API key/base URL fields instead of the built-in deployment field.
  if (provider === "coder" && providerInfo?.isCustom !== true) {
    // OAuth-based ("Login with Coder"); only the deployment URL is entered manually.
    return [
      {
        key: "deploymentUrl",
        label: "Deployment URL",
        placeholder: "https://coder.example.com",
        type: "text",
      },
    ];
  }

  // Default for most providers
  return [
    { key: "apiKey", label: "API Key", placeholder: "Enter API key", type: "secret" },
    {
      key: "apiKeyFile",
      label: "API Key File",
      placeholder: "~/.config/coder/session_token",
      type: "text",
      optional: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "https://api.example.com",
      type: "text",
      optional: true,
    },
  ];
}

/**
 * URLs to create/manage API keys for each provider.
 */
const PROVIDER_KEY_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/app/apikey",
  xai: "https://console.x.ai/team/default/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  moonshotai: "https://platform.moonshot.ai/console/api-keys",
  zai: "https://z.ai/manage-apikey/apikey-list",
  openrouter: "https://openrouter.ai/settings/keys",
  // bedrock: AWS credential chain, no simple key URL
  // ollama: local service, no key needed
};

interface RoutePriorityItem {
  route: string;
  displayName: string;
  provider: ProviderName | null;
}

function SortableRoutePriorityItem(props: { item: RoutePriorityItem }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.item.route,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="border-border-light bg-background-secondary flex items-center gap-2 rounded-md border px-2 py-1.5"
    >
      <button
        type="button"
        className="text-muted hover:text-foreground cursor-grab rounded p-0.5 active:cursor-grabbing"
        aria-label={`Reorder ${props.item.displayName}`}
        {...attributes}
        {...(listeners ?? {})}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {props.item.provider ? (
        <ProviderWithIcon
          provider={props.item.provider}
          displayName
          className="text-foreground text-xs font-medium"
        />
      ) : (
        <span className="text-foreground text-xs font-medium">{props.item.displayName}</span>
      )}
      {isDragging && <span className="text-muted ml-auto text-[10px]">Moving…</span>}
    </li>
  );
}

function GatewayRoutePriorityList({
  routePriority,
  onChangeRoutePriority,
}: {
  routePriority: string[];
  onChangeRoutePriority: (priority: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    })
  );

  const routeItems = useMemo<RoutePriorityItem[]>(() => {
    return routePriority.map((route) => {
      if (route === "direct") {
        return {
          route,
          displayName: "Direct",
          provider: null,
        };
      }

      if (!(route in PROVIDER_DEFINITIONS)) {
        return {
          route,
          displayName: route,
          provider: null,
        };
      }

      return {
        route,
        displayName: PROVIDER_DEFINITIONS[route as ProviderName].displayName,
        provider: route as ProviderName,
      };
    });
  }, [routePriority]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }

      const fromIndex = routePriority.indexOf(String(active.id));
      const toIndex = routePriority.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) {
        return;
      }

      onChangeRoutePriority(arrayMove(routePriority, fromIndex, toIndex));
    },
    [onChangeRoutePriority, routePriority]
  );

  return (
    <div className="border-border-medium bg-background-secondary/50 space-y-2 rounded-md border px-3 py-2">
      <div>
        <div className="text-foreground text-xs font-medium">Route priority</div>
        <div className="text-muted text-xs">Drag to choose gateway order for auto routing.</div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={routePriority} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {routeItems.map((item) => (
              <SortableRoutePriorityItem key={item.route} item={item} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

export function ProvidersSection() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;

  const {
    providersExpandedProvider,
    setProvidersExpandedProvider,
    providersStartCoderLogin,
    setProvidersStartCoderLogin,
  } = useSettings();

  const { api } = useAPI();
  const { config, loading: configLoading, refresh, updateOptimistically } = useProvidersConfig();
  const { workspaceMetadata, selectedWorkspace, refreshWorkspaceMetadata } = useWorkspaceContext();
  const visibleProviders = useMemo(
    () => getAllowedProvidersForUi(effectivePolicy, config),
    [effectivePolicy, config]
  );
  const {
    data: muxGatewayAccountStatus,
    error: muxGatewayAccountError,
    isLoading: muxGatewayAccountLoading,
    refresh: refreshMuxGatewayAccountStatus,
  } = useMuxGatewayAccountStatus();

  const [openaiServiceTierSelectOverride, setOpenaiServiceTierSelectOverride] =
    useState<OpenAIServiceTierSelectValue | null>(null);
  const [xaiServiceTierSaving, setXAIServiceTierSaving] = useState(false);
  // Persist OpenAI ZDR store toggles before publishing UI state so a failed write
  // cannot leave the dropdown claiming disabled while requests still send store=true.
  // xAI frontier Grok always uses store=false in the request path (no settings surface).
  const [openaiStoreSaving, setOpenAIStoreSaving] = useState(false);

  const routing = useRouting();

  const providerGroups = useMemo(() => {
    const groups: Record<"direct" | "gateway" | "local" | "custom", string[]> = {
      direct: [],
      gateway: [],
      local: [],
      custom: [],
    };
    const policyAllowedSet = new Set(visibleProviders);

    for (const provider of visibleProviders) {
      if (!isBuiltInProvider(provider) || isCustomProviderInfo(config?.[provider])) {
        continue;
      }

      groups[PROVIDER_DEFINITIONS[provider].kind].push(provider);
    }

    for (const [provider, providerInfo] of Object.entries(config ?? {})) {
      if (!policyAllowedSet.has(provider) || !isCustomProviderInfo(providerInfo)) {
        continue;
      }

      groups.custom.push(provider);
    }

    return groups;
  }, [config, visibleProviders]);

  const displayedRoutePriority = useMemo(() => {
    const priority = routing.routePriority.filter(
      (route) => route === "direct" || providerGroups.gateway.includes(route)
    );

    if (!priority.includes("direct")) {
      priority.push("direct");
    }

    return priority;
  }, [providerGroups.gateway, routing.routePriority]);

  const hiddenRoutePriority = useMemo(
    () => routing.routePriority.filter((route) => !displayedRoutePriority.includes(route)),
    [displayedRoutePriority, routing.routePriority]
  );

  const handleRoutePriorityChange = useCallback(
    (priority: string[]) => {
      routing.setRoutePriority([...priority, ...hiddenRoutePriority]);
    },
    [hiddenRoutePriority, routing]
  );

  const backendBaseUrl = getBrowserBackendBaseUrl();
  const backendOrigin = (() => {
    try {
      return new URL(backendBaseUrl).origin;
    } catch {
      return window.location.origin;
    }
  })();

  const isDesktop = !!window.api;

  // The "Connect (Browser)" OAuth flow requires a redirect back to this origin,
  // which only works when the host is the user's local machine. On a remote mux
  // server the redirect would land on the server, not the user's browser.
  const isRemoteServer =
    !isDesktop && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  const [codexOauthStatus, setCodexOauthStatus] = useState<CodexOauthFlowStatus>("idle");
  const [codexOauthError, setCodexOauthError] = useState<string | null>(null);

  const codexOauthAttemptRef = useRef(0);
  const [codexOauthDesktopFlowId, setCodexOauthDesktopFlowId] = useState<string | null>(null);
  const [codexOauthDeviceFlow, setCodexOauthDeviceFlow] = useState<CodexOauthDeviceFlow | null>(
    null
  );
  const [codexOauthAuthorizeUrl, setCodexOauthAuthorizeUrl] = useState<string | null>(null);

  const codexOauthIsConnected = config?.openai?.codexOauthSet === true;
  const openaiApiKeySet = config?.openai?.apiKeySet === true || !!config?.openai?.apiKeySource;
  const codexOauthDefaultAuth =
    config?.openai?.codexOauthDefaultAuth === "apiKey" ? "apiKey" : "oauth";
  const codexOauthDefaultAuthIsEditable = codexOauthIsConnected && openaiApiKeySet;

  const codexOauthLoginInProgress =
    codexOauthStatus === "starting" || codexOauthStatus === "waiting";

  const startCodexOauthBrowserConnect = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Xum API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow before starting a new one.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");

      if (!isDesktop) {
        const startResult = await api.codexOauth.startDeviceFlow();

        if (attempt !== codexOauthAttemptRef.current) {
          if (startResult.success) {
            void api.codexOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
          }
          return;
        }

        if (!startResult.success) {
          setCodexOauthStatus("error");
          setCodexOauthError(startResult.error);
          return;
        }

        setCodexOauthDeviceFlow({
          flowId: startResult.data.flowId,
          userCode: startResult.data.userCode,
          verifyUrl: startResult.data.verifyUrl,
        });
        setCodexOauthStatus("waiting");

        // Keep device-code login manual per user request: we only open the
        // verification page from the explicit "Copy & Open" action.
        const waitResult = await api.codexOauth.waitForDeviceFlow({
          flowId: startResult.data.flowId,
        });

        if (attempt !== codexOauthAttemptRef.current) {
          return;
        }

        if (!waitResult.success) {
          setCodexOauthStatus("error");
          setCodexOauthError(waitResult.error);
          return;
        }

        setCodexOauthStatus("idle");
        setCodexOauthDeviceFlow(null);
        setCodexOauthAuthorizeUrl(null);
        await refresh();
        return;
      }

      const startResult = await api.codexOauth.startDesktopFlow();

      if (attempt !== codexOauthAttemptRef.current) {
        if (startResult.success) {
          void api.codexOauth.cancelDesktopFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(startResult.error);
        return;
      }

      const { flowId, authorizeUrl } = startResult.data;
      setCodexOauthDesktopFlowId(flowId);
      setCodexOauthAuthorizeUrl(authorizeUrl);
      setCodexOauthStatus("waiting");

      const waitResult = await api.codexOauth.waitForDesktopFlow({ flowId });

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!waitResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(waitResult.error);
        return;
      }

      setCodexOauthStatus("idle");
      setCodexOauthDesktopFlowId(null);
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const startCodexOauthDeviceConnect = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Xum API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow before starting a new one.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");
      const startResult = await api.codexOauth.startDeviceFlow();

      if (attempt !== codexOauthAttemptRef.current) {
        if (startResult.success) {
          void api.codexOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(startResult.error);
        return;
      }

      setCodexOauthDeviceFlow({
        flowId: startResult.data.flowId,
        userCode: startResult.data.userCode,
        verifyUrl: startResult.data.verifyUrl,
      });
      setCodexOauthStatus("waiting");

      const waitResult = await api.codexOauth.waitForDeviceFlow({
        flowId: startResult.data.flowId,
      });

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!waitResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(waitResult.error);
        return;
      }

      setCodexOauthStatus("idle");
      setCodexOauthDeviceFlow(null);
      setCodexOauthAuthorizeUrl(null);
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const disconnectCodexOauth = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Xum API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");
      const result = await api.codexOauth.disconnect();

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!result.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(result.error);
        return;
      }

      updateOptimistically("openai", { codexOauthSet: false });
      setCodexOauthStatus("idle");
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const [muxGatewayLoginStatus, setMuxGatewayLoginStatus] = useState<MuxGatewayLoginStatus>("idle");
  const cancelCodexOauth = () => {
    codexOauthAttemptRef.current++;

    if (api) {
      if (codexOauthDesktopFlowId) {
        void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
      }
      if (codexOauthDeviceFlow) {
        void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
      }
    }

    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);
    setCodexOauthStatus("idle");
    setCodexOauthError(null);
  };

  const [muxGatewayLoginError, setMuxGatewayLoginError] = useState<string | null>(null);

  const muxGatewayLoginAttemptRef = useRef(0);
  const [muxGatewayDesktopFlowId, setMuxGatewayDesktopFlowId] = useState<string | null>(null);
  const [muxGatewayServerState, setMuxGatewayServerState] = useState<string | null>(null);

  const [muxGatewayAuthorizeUrl, setMuxGatewayAuthorizeUrl] = useState<string | null>(null);

  const cancelMuxGatewayLogin = () => {
    muxGatewayLoginAttemptRef.current++;

    if (isDesktop && api && muxGatewayDesktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: muxGatewayDesktopFlowId });
    }

    setMuxGatewayDesktopFlowId(null);
    setMuxGatewayServerState(null);
    setMuxGatewayAuthorizeUrl(null);
    setMuxGatewayLoginStatus("idle");
    setMuxGatewayLoginError(null);
  };

  const clearMuxGatewayCredentials = () => {
    if (!api) {
      return;
    }

    cancelMuxGatewayLogin();
    updateOptimistically("mux-gateway", { couponCodeSet: false });

    void api.providers.setProviderConfig({
      provider: "mux-gateway",
      keyPath: ["couponCode"],
      value: "",
    });
    void api.providers.setProviderConfig({
      provider: "mux-gateway",
      keyPath: ["voucher"],
      value: "",
    });
  };

  const startMuxGatewayLogin = async () => {
    const attempt = ++muxGatewayLoginAttemptRef.current;

    try {
      setMuxGatewayLoginError(null);
      setMuxGatewayDesktopFlowId(null);
      setMuxGatewayServerState(null);
      setMuxGatewayAuthorizeUrl(null);

      if (isDesktop) {
        if (!api) {
          setMuxGatewayLoginStatus("error");
          setMuxGatewayLoginError("Xum API not connected.");
          return;
        }

        setMuxGatewayLoginStatus("starting");
        const startResult = await api.muxGatewayOauth.startDesktopFlow();

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          if (startResult.success) {
            void api.muxGatewayOauth.cancelDesktopFlow({ flowId: startResult.data.flowId });
          }
          return;
        }

        if (!startResult.success) {
          setMuxGatewayLoginStatus("error");
          setMuxGatewayLoginError(startResult.error);
          return;
        }

        const { flowId, authorizeUrl } = startResult.data;
        setMuxGatewayDesktopFlowId(flowId);
        setMuxGatewayAuthorizeUrl(authorizeUrl);
        setMuxGatewayLoginStatus("waiting");

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        const waitResult = await api.muxGatewayOauth.waitForDesktopFlow({ flowId });

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        if (waitResult.success) {
          setMuxGatewayLoginStatus("success");
          void refreshMuxGatewayAccountStatus();

          return;
        }

        setMuxGatewayAuthorizeUrl(null);
        setMuxGatewayLoginStatus("error");
        setMuxGatewayLoginError(waitResult.error);
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      setMuxGatewayLoginStatus("starting");

      const startUrl = new URL(`${backendBaseUrl}/auth/mux-gateway/start`);
      const authToken = getServerAuthToken();

      const res = await fetch(startUrl, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const body = await res.text();
        const prefix = body.trim().slice(0, 80);
        throw new Error(
          `Unexpected response from ${startUrl.toString()} (expected JSON, got ${
            contentType || "unknown"
          }): ${prefix}`
        );
      }

      const json = (await res.json()) as {
        authorizeUrl?: unknown;
        state?: unknown;
        error?: unknown;
      };

      if (!res.ok) {
        const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        throw new Error(message);
      }

      if (attempt !== muxGatewayLoginAttemptRef.current) {
        return;
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      setMuxGatewayServerState(json.state);
      setMuxGatewayAuthorizeUrl(json.authorizeUrl);
      setMuxGatewayLoginStatus("waiting");
    } catch (err) {
      if (attempt !== muxGatewayLoginAttemptRef.current) {
        return;
      }

      const message = getErrorMessage(err);
      setMuxGatewayAuthorizeUrl(null);
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(message);
    }
  };

  useEffect(() => {
    const attempt = muxGatewayLoginAttemptRef.current;

    if (isDesktop || muxGatewayLoginStatus !== "waiting" || !muxGatewayServerState) {
      return;
    }

    const handleMessage = (event: MessageEvent<OAuthMessage>) => {
      if (event.origin !== backendOrigin) return;
      if (muxGatewayLoginAttemptRef.current !== attempt) return;

      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "mux-gateway-oauth") return;
      if (data.state !== muxGatewayServerState) return;

      if (data.ok === true) {
        setMuxGatewayAuthorizeUrl(null);
        setMuxGatewayLoginStatus("success");
        void refreshMuxGatewayAccountStatus();

        return;
      }

      const msg = typeof data.error === "string" ? data.error : "Login failed";
      setMuxGatewayAuthorizeUrl(null);
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(msg);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    isDesktop,
    muxGatewayLoginStatus,
    muxGatewayServerState,
    backendOrigin,
    refreshMuxGatewayAccountStatus,
  ]);
  const muxGatewayCouponCodeSet = config?.["mux-gateway"]?.couponCodeSet ?? false;
  const muxGatewayLoginInProgress =
    muxGatewayLoginStatus === "waiting" || muxGatewayLoginStatus === "starting";
  const muxGatewayIsLoggedIn = muxGatewayCouponCodeSet || muxGatewayLoginStatus === "success";

  const muxGatewayAuthStatusText = muxGatewayIsLoggedIn ? "Logged in" : "Not logged in";

  const muxGatewayLoginButtonLabel =
    muxGatewayLoginStatus === "error"
      ? "Try again"
      : muxGatewayLoginInProgress
        ? "Waiting for login..."
        : muxGatewayIsLoggedIn
          ? "Re-login to Xum Gateway"
          : "Login to Xum Gateway";

  // --- GitHub Copilot Device Code Flow ---
  const [copilotLoginStatus, setCopilotLoginStatus] = useState<CopilotLoginStatus>("idle");
  const [copilotLoginError, setCopilotLoginError] = useState<string | null>(null);
  const [copilotFlowId, setCopilotFlowId] = useState<string | null>(null);
  const [copilotUserCode, setCopilotUserCode] = useState<string | null>(null);
  const [copilotVerificationUri, setCopilotVerificationUri] = useState<string | null>(null);
  const copilotLoginAttemptRef = useRef(0);
  const copilotFlowIdRef = useRef<string | null>(null);

  const copilotApiKeySet = config?.["github-copilot"]?.apiKeySet ?? false;
  const copilotLoginInProgress =
    copilotLoginStatus === "waiting" || copilotLoginStatus === "starting";
  const copilotIsLoggedIn = copilotApiKeySet || copilotLoginStatus === "success";

  const cancelCopilotLogin = () => {
    copilotLoginAttemptRef.current++;
    if (api && copilotFlowId) {
      void api.copilotOauth.cancelDeviceFlow({
        flowId: copilotFlowId,
      });
    }
    setCopilotFlowId(null);
    copilotFlowIdRef.current = null;
    setCopilotUserCode(null);
    setCopilotVerificationUri(null);
    setCopilotLoginStatus("idle");
    setCopilotLoginError(null);
  };

  // Cancel any in-flight Copilot login if the component unmounts.
  // Use a ref for api so this only fires on true unmount, not on api identity
  // changes (e.g. reconnection), which would spuriously cancel active flows.
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    return () => {
      if (copilotFlowIdRef.current && apiRef.current) {
        void apiRef.current.copilotOauth.cancelDeviceFlow({ flowId: copilotFlowIdRef.current });
      }
    };
  }, []);

  const clearCopilotCredentials = () => {
    if (!api) return;
    cancelCopilotLogin();
    updateOptimistically("github-copilot", { apiKeySet: false });
    void api.providers.setProviderConfig({
      provider: "github-copilot",
      keyPath: ["apiKey"],
      value: "",
    });
  };

  const startCopilotLogin = async () => {
    const attempt = ++copilotLoginAttemptRef.current;
    try {
      setCopilotLoginError(null);
      setCopilotLoginStatus("starting");

      if (!api) {
        setCopilotLoginStatus("error");
        setCopilotLoginError("API not connected.");
        return;
      }

      // Best-effort: cancel any in-progress flow before starting a new one.
      if (copilotFlowIdRef.current) {
        void api.copilotOauth.cancelDeviceFlow({ flowId: copilotFlowIdRef.current });
        copilotFlowIdRef.current = null;
        setCopilotFlowId(null);
      }

      const startResult = await api.copilotOauth.startDeviceFlow();

      if (attempt !== copilotLoginAttemptRef.current) {
        if (startResult.success) {
          void api.copilotOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCopilotLoginStatus("error");
        setCopilotLoginError(startResult.error);
        return;
      }

      const { flowId, verificationUri, userCode } = startResult.data;
      setCopilotFlowId(flowId);
      copilotFlowIdRef.current = flowId;
      setCopilotUserCode(userCode);
      setCopilotVerificationUri(verificationUri);
      setCopilotLoginStatus("waiting");

      // Keep device-code login manual per user request: we only open the
      // verification page from the explicit "Copy & Open" action.

      // Wait for flow to complete (polling happens on backend)
      const waitResult = await api.copilotOauth.waitForDeviceFlow({ flowId });

      if (attempt !== copilotLoginAttemptRef.current) return;

      if (waitResult.success) {
        setCopilotLoginStatus("success");
        return;
      }

      setCopilotLoginStatus("error");
      setCopilotLoginError(waitResult.error);
    } catch (err) {
      if (attempt !== copilotLoginAttemptRef.current) return;
      const message = getErrorMessage(err);
      setCopilotLoginStatus("error");
      setCopilotLoginError(message);
    }
  };

  // --- Coder OAuth ("Login with Coder") ---
  const [coderLoginStatus, setCoderLoginStatus] = useState<CodexOauthFlowStatus>("idle");
  const [coderLoginError, setCoderLoginError] = useState<string | null>(null);
  const [coderFlowId, setCoderFlowId] = useState<string | null>(null);
  const [coderAuthorizeUrl, setCoderAuthorizeUrl] = useState<string | null>(null);
  const coderLoginAttemptRef = useRef(0);

  const coderOauthIsConnected = config?.coder?.coderOauthSet === true;
  // Presence of ANY stored credential (even one minted for a different
  // deployment URL): it stays disconnectable — disconnect revokes against the
  // blob's own issuer — otherwise editing the URL would strand a live
  // full-privilege credential with no way to revoke it from the UI.
  const coderOauthCredentialStored = config?.coder?.coderOauthCredentialStored === true;
  const coderDeploymentUrl = config?.coder?.deploymentUrl ?? "";
  const coderLoginInProgress = coderLoginStatus === "starting" || coderLoginStatus === "waiting";

  // Manual AI Gateway model re-discovery: newly configured providers/models
  // on the deployment otherwise only appear after a re-login.
  const [coderModelRefreshState, setCoderModelRefreshState] = useState<
    { kind: "idle" } | { kind: "refreshing" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Synchronous reentrancy guard: the button's disabled={refreshing} prop
  // lags a render behind, so repeated or programmatic activation could start
  // overlapping refreshes whose state updates race. The ref flips before the
  // first await, making the second activation a deterministic no-op.
  const coderModelRefreshInFlightRef = useRef(false);
  const refreshCoderModels = async () => {
    if (!api || coderModelRefreshInFlightRef.current) {
      return;
    }
    coderModelRefreshInFlightRef.current = true;
    setCoderModelRefreshState({ kind: "refreshing" });
    try {
      const result = await api.coderOauth.refreshModels();
      if (!result.success) {
        setCoderModelRefreshState({ kind: "error", message: result.error });
        return;
      }
      setCoderModelRefreshState({ kind: "idle" });
      await refresh();
    } catch (err) {
      setCoderModelRefreshState({ kind: "error", message: getErrorMessage(err) });
    } finally {
      coderModelRefreshInFlightRef.current = false;
    }
  };

  const cancelCoderLogin = async () => {
    coderLoginAttemptRef.current++;
    // Await backend cancellation BEFORE dismissing the attempt: Cancel can
    // race the OAuth callback/token exchange, and only when cancelDesktopFlow
    // returns has the backend settled which of them won. Dropping the local
    // state first would show an idle "cancelled" attempt while the exchange
    // commits a connected account behind it.
    if (api && coderFlowId) {
      try {
        await api.coderOauth.cancelDesktopFlow({ flowId: coderFlowId });
      } catch {
        // Backend unreachable — clear local state regardless.
      }
    }
    setCoderFlowId(null);
    setCoderAuthorizeUrl(null);
    setCoderLoginStatus("idle");
    setCoderLoginError(null);
    // The exchange may have won the race: re-fetch so Settings reflects the
    // authoritative backend outcome (connected vs not).
    await refresh();
  };

  // useCallback for effect-dep stability, not memoization: the one-shot
  // startCoderLogin hint effect below lists this function as a dependency.
  const startCoderLogin = useCallback(async () => {
    const attempt = ++coderLoginAttemptRef.current;

    if (!api) {
      setCoderLoginStatus("error");
      setCoderLoginError("Xum API not connected.");
      return;
    }

    // Cancel any in-progress flow before starting a new one — awaited, so the
    // old flow cannot commit a login after this replacement attempt begins.
    if (coderFlowId) {
      try {
        await api.coderOauth.cancelDesktopFlow({ flowId: coderFlowId });
      } catch {
        // Proceed anyway; the backend's last-committed-login-wins semantics
        // still bound the damage if the old flow survives.
      }
      if (attempt !== coderLoginAttemptRef.current) return;
    }

    setCoderLoginError(null);
    setCoderAuthorizeUrl(null);

    const deploymentUrl = coderDeploymentUrl.trim();
    if (!deploymentUrl) {
      setCoderFlowId(null);
      setCoderLoginStatus("error");
      setCoderLoginError("Set the deployment URL first.");
      return;
    }

    // Generate the flow ID client-side and expose it BEFORE the start RPC:
    // startDesktopFlow can stall on backend network calls, and Cancel must be
    // able to reach the attempt (the backend pre-cancels IDs it hasn't
    // registered yet) instead of abandoning only the frontend state.
    const flowId = createCoderLoginFlowId();
    setCoderFlowId(flowId);

    try {
      setCoderLoginStatus("starting");
      // Desktop: loopback listener on this machine. Browser (local or remote
      // server): the redirect lands on the Xum server's own callback route.
      const startResult = isDesktop
        ? await api.coderOauth.startDesktopFlow({ deploymentUrl, flowId })
        : await startCoderServerFlow(backendBaseUrl, deploymentUrl, flowId);

      if (attempt !== coderLoginAttemptRef.current) {
        // cancelCoderLogin already cancelled this flowId; nothing to clean up.
        return;
      }

      if (!startResult.success) {
        setCoderFlowId(null);
        setCoderLoginStatus("error");
        setCoderLoginError(startResult.error);
        return;
      }

      const { authorizeUrl } = startResult.data;
      setCoderAuthorizeUrl(authorizeUrl);
      setCoderLoginStatus("waiting");

      const waitResult = await api.coderOauth.waitForDesktopFlow({ flowId });

      if (attempt !== coderLoginAttemptRef.current) return;

      if (!waitResult.success) {
        setCoderLoginStatus("error");
        setCoderLoginError(waitResult.error);
        return;
      }

      setCoderLoginStatus("idle");
      setCoderFlowId(null);
      setCoderAuthorizeUrl(null);
      await refresh();
    } catch (err) {
      if (attempt !== coderLoginAttemptRef.current) return;
      setCoderLoginStatus("error");
      setCoderLoginError(getErrorMessage(err));
    }
  }, [api, coderFlowId, coderDeploymentUrl, refresh, isDesktop, backendBaseUrl]);

  const disconnectCoderOauth = async () => {
    const attempt = ++coderLoginAttemptRef.current;
    if (!api) return;

    // Awaited: an unsettled flow could otherwise commit a login AFTER the
    // disconnect below cleared credentials, silently reconnecting the account.
    if (coderFlowId) {
      try {
        await api.coderOauth.cancelDesktopFlow({ flowId: coderFlowId });
      } catch {
        // Proceed with disconnect regardless.
      }
      if (attempt !== coderLoginAttemptRef.current) return;
    }
    setCoderFlowId(null);
    setCoderAuthorizeUrl(null);
    setCoderLoginError(null);
    setCoderLoginStatus("idle");

    try {
      const result = await api.coderOauth.disconnect();

      if (attempt !== coderLoginAttemptRef.current) return;

      if (!result.success) {
        setCoderLoginStatus("error");
        setCoderLoginError(result.error);
        return;
      }

      updateOptimistically("coder", { coderOauthSet: false, coderOauthCredentialStored: false });
      await refresh();
    } catch (err) {
      if (attempt !== coderLoginAttemptRef.current) return;
      setCoderLoginStatus("error");
      setCoderLoginError(getErrorMessage(err));
    }
  };

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const [customProviderFormOpen, setCustomProviderFormOpen] = useState(false);
  const [customProviderId, setCustomProviderId] = useState("");
  const [customProviderType, setCustomProviderType] =
    useState<CustomProviderType>("openai-compatible");
  const [customProviderDisplayName, setCustomProviderDisplayName] = useState("");
  const [customProviderBaseUrl, setCustomProviderBaseUrl] = useState("");
  const [customProviderApiKey, setCustomProviderApiKey] = useState("");
  const [customProviderApiKeyFile, setCustomProviderApiKeyFile] = useState("");
  const [customProviderInitialModelId, setCustomProviderInitialModelId] = useState("");
  const [customProviderSubmitError, setCustomProviderSubmitError] = useState<string | null>(null);
  const [customProviderNotice, setCustomProviderNotice] = useState<string | null>(null);
  const [customProviderSubmitAttempted, setCustomProviderSubmitAttempted] = useState(false);
  const [customProviderTouchedFields, setCustomProviderTouchedFields] = useState({
    providerId: false,
    displayName: false,
    baseUrl: false,
  });
  const [customProviderSubmitting, setCustomProviderSubmitting] = useState(false);
  const [customProviderRemoveErrors, setCustomProviderRemoveErrors] = useState<
    Record<string, string>
  >({});
  const [customProviderRemoving, setCustomProviderRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!providersExpandedProvider) {
      return;
    }

    setExpandedProvider(providersExpandedProvider);
    setProvidersExpandedProvider(null);
  }, [providersExpandedProvider, setProvidersExpandedProvider]);

  // One-shot hint from the "Settings: Login with Coder" command: start the
  // OAuth login as soon as the providers config has loaded (startCoderLogin
  // reads the configured deployment URL from it — invoking earlier would
  // always fail with "Set the deployment URL first."). startCoderLogin handles
  // the error cases (missing URL, no API) with inline feedback in the expanded
  // Coder section.
  useEffect(() => {
    if (!providersStartCoderLogin || configLoading) {
      return;
    }

    setProvidersStartCoderLogin(false);
    void startCoderLogin();
  }, [providersStartCoderLogin, setProvidersStartCoderLogin, configLoading, startCoderLogin]);

  useEffect(() => {
    if (expandedProvider !== "mux-gateway" || !muxGatewayIsLoggedIn) {
      return;
    }

    // Fetch lazily when the user expands the Xum Gateway provider.
    //
    // Important: avoid auto-retrying after a failure. If the request fails,
    // `muxGatewayAccountStatus` remains null and we'd otherwise trigger a refresh
    // on every render while the provider stays expanded.
    if (muxGatewayAccountStatus || muxGatewayAccountLoading || muxGatewayAccountError) {
      return;
    }

    void refreshMuxGatewayAccountStatus();
  }, [
    expandedProvider,
    muxGatewayAccountError,
    muxGatewayAccountLoading,
    muxGatewayAccountStatus,
    muxGatewayIsLoggedIn,
    refreshMuxGatewayAccountStatus,
  ]);
  const [editingField, setEditingField] = useState<{
    provider: string;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleToggleProvider = (provider: string) => {
    setExpandedProvider((prev) => {
      const next = prev === provider ? null : provider;
      if (prev === "mux-gateway" && next !== "mux-gateway") {
        cancelMuxGatewayLogin();
      }
      if (prev === "github-copilot" && next !== "github-copilot") {
        cancelCopilotLogin();
      }
      return next;
    });
    setEditingField(null);
  };

  const handleStartEdit = (provider: string, field: string, fieldConfig: FieldConfig) => {
    setEditingField({ provider, field });
    // For secrets, start empty since we only show masked value
    // For text fields, show current value
    const currentValue = getFieldValue(provider, field);
    setEditValue(fieldConfig.type === "text" && currentValue ? currentValue : "");
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setEditValue("");
    setShowPassword(false);
  };

  const handleSaveEdit = useCallback(() => {
    if (!editingField || !api) return;

    const { provider, field } = editingField;

    // Optimistic update for instant feedback
    if (field === "apiKey") {
      updateOptimistically(provider, {
        apiKeySet: editValue !== "",
        apiKeySource: editValue !== "" ? "config" : undefined,
      });
    } else if (field === "displayName") {
      updateOptimistically(provider, { displayName: editValue || undefined });
    } else if (field === "baseUrl") {
      const nextBaseUrl = editValue || undefined;
      updateOptimistically(provider, {
        baseUrl: nextBaseUrl,
        baseUrlSource: nextBaseUrl ? "config" : undefined,
        baseUrlResolved: nextBaseUrl,
      });
    } else if (field === "apiKeyFile") {
      updateOptimistically(provider, { apiKeyFile: editValue || undefined });
    } else if (field === "deploymentUrl") {
      // The Coder login handler reads config.coder.deploymentUrl; without this
      // optimistic update, clicking Login right after saving would use the
      // previous URL until the async provider refresh lands.
      updateOptimistically(provider, { deploymentUrl: editValue || undefined });
    }

    setEditingField(null);
    setEditValue("");
    setShowPassword(false);

    // Save in background
    void api.providers.setProviderConfig({ provider, keyPath: [field], value: editValue });
  }, [api, editingField, editValue, updateOptimistically]);

  // Per-provider write sequencing: rapid selections queue in click order and
  // only the NEWEST write's failure reconciles shared state, so a stale
  // completion cannot roll back or resurrect an older selection. Sequence
  // numbers are globally monotonic so a queued write can never match a
  // same-named provider re-added after removal.
  const providerTypeWritesRef = useRef(new Map<string, { seq: number; chain: Promise<void> }>());
  const providerTypeWriteSeqRef = useRef(0);

  // Plain function: React Compiler handles memoization.
  const handleCustomProviderTypeChange = (
    provider: string,
    next: CustomProviderType,
    previous: CustomProviderType | undefined
  ) => {
    if (!api) return;

    const writes = providerTypeWritesRef.current;
    const entry = writes.get(provider) ?? { seq: 0, chain: Promise.resolve() };
    const seq = ++providerTypeWriteSeqRef.current;
    const chain = entry.chain.then(async () => {
      if (writes.get(provider)?.seq !== seq) {
        // Superseded by a newer selection, or the provider was removed while
        // this write was queued; issuing it would resurrect the removed
        // entry (setConfig creates absent provider sections).
        return;
      }
      try {
        const result = await api.providers.setProviderConfig({
          provider,
          keyPath: ["providerType"],
          value: next,
        });
        if (!result.success) {
          throw new Error(result.error);
        }
      } catch {
        if (writes.get(provider)?.seq !== seq) {
          return; // Stale: a newer selection owns the shared state.
        }
        // The format decides the request wire protocol, so an optimistic
        // value that failed to persist (policy denial, lock/write failure)
        // must not keep advertising an adapter the backend never adopted.
        // Restore the previous value first: refresh() is best-effort and
        // keeps the optimistic state when the refetch itself fails.
        updateOptimistically(provider, { providerType: previous });
        void refresh();
      }
    });
    writes.set(provider, { seq, chain });
    updateOptimistically(provider, { providerType: next });
  };

  const handleClearField = useCallback(
    (provider: string, field: string) => {
      if (!api) return;

      // Optimistic update for instant feedback
      if (field === "apiKey") {
        updateOptimistically(provider, {
          apiKeySet: false,
          apiKeySource: undefined,
        });
      } else if (field === "baseUrl") {
        updateOptimistically(provider, {
          baseUrl: undefined,
          baseUrlSource: undefined,
          baseUrlResolved: undefined,
        });
      } else if (field === "apiKeyFile") {
        updateOptimistically(provider, { apiKeyFile: undefined });
      } else if (field === "deploymentUrl") {
        // Keep the login handler's view (config.coder.deploymentUrl) in sync;
        // see handleSaveEdit.
        updateOptimistically(provider, { deploymentUrl: undefined });
      }

      // Save in background
      void api.providers.setProviderConfig({ provider, keyPath: [field], value: "" });
    },
    [api, updateOptimistically]
  );

  const isEnabled = (provider: string): boolean => {
    return config?.[provider]?.isEnabled ?? true;
  };

  /** Check if provider is configured (uses backend-computed isConfigured) */
  const isConfigured = (provider: string): boolean => {
    return config?.[provider]?.isConfigured ?? false;
  };

  const hasAnyConfiguredProvider = useMemo(
    () => Object.values(config ?? {}).some((providerConfig) => providerConfig.isConfigured),
    [config]
  );

  const handleProviderEnabledChange = useCallback(
    (provider: string, nextEnabled: boolean) => {
      if (!api || provider === "mux-gateway") {
        return;
      }

      updateOptimistically(provider, {
        isEnabled: nextEnabled,
        ...(nextEnabled ? {} : { isConfigured: false }),
      });

      // Persist only `enabled: false` for disabled providers. Re-enabling removes the key.
      void api.providers.setProviderConfig({
        provider,
        keyPath: ["enabled"],
        value: nextEnabled ? "" : "false",
      });
    },
    [api, updateOptimistically]
  );

  const getFieldValue = (provider: string, field: string): string | undefined => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return undefined;

    // For bedrock, check aws nested object for region/profile
    if (provider === "bedrock" && (field === "region" || field === "profile")) {
      return field === "region" ? providerConfig.aws?.region : providerConfig.aws?.profile;
    }

    // For standard fields like baseUrl
    const value = providerConfig[field as keyof typeof providerConfig];
    return typeof value === "string" ? value : undefined;
  };

  const getFieldDisplayValue = (provider: string, field: string): string | undefined => {
    const fieldValue = getFieldValue(provider, field);
    if (field !== "baseUrl") {
      return fieldValue;
    }

    const providerConfig = config?.[provider];
    if (providerConfig?.baseUrlSource && typeof providerConfig.baseUrlResolved === "string") {
      return providerConfig.baseUrlResolved;
    }

    return fieldValue;
  };

  const isFieldSet = (provider: string, field: string, fieldConfig: FieldConfig): boolean => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return false;

    if (fieldConfig.type === "secret") {
      // For apiKey, we have apiKeySet from the sanitized config
      if (field === "apiKey") return providerConfig.apiKeySet ?? false;

      // For AWS secrets, check the aws nested object
      if (provider === "bedrock" && providerConfig.aws) {
        const { aws } = providerConfig;
        switch (field) {
          case "bearerToken":
            return aws.bearerTokenSet ?? false;
          case "accessKeyId":
            return aws.accessKeyIdSet ?? false;
          case "secretAccessKey":
            return aws.secretAccessKeySet ?? false;
        }
      }
      return false;
    }
    return !!getFieldValue(provider, field);
  };

  const markCustomProviderFieldTouched = (field: keyof typeof customProviderTouchedFields) => {
    setCustomProviderTouchedFields((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  };

  const trimmedCustomProviderId = customProviderId.trim();
  const customProviderIdValidation = validateCustomProviderId(trimmedCustomProviderId);
  const trimmedCustomProviderDisplayName = customProviderDisplayName.trim();
  const customProviderDisplayNameError =
    trimmedCustomProviderDisplayName.length === 0 ? "Display name is required." : null;
  const trimmedCustomProviderBaseUrl = customProviderBaseUrl.trim();
  const customProviderBaseUrlValidation = validateCustomProviderBaseUrl(
    trimmedCustomProviderBaseUrl
  );
  const customProviderBaseUrlError = customProviderBaseUrlValidation.ok
    ? null
    : customProviderBaseUrlValidation.reason;
  const showCustomProviderIdError =
    !customProviderIdValidation.ok &&
    (customProviderTouchedFields.providerId || customProviderSubmitAttempted);
  const showCustomProviderDisplayNameError =
    customProviderDisplayNameError != null &&
    (customProviderTouchedFields.displayName || customProviderSubmitAttempted);
  const showCustomProviderBaseUrlError =
    customProviderBaseUrlError != null &&
    (customProviderTouchedFields.baseUrl || customProviderSubmitAttempted);

  const clearCustomProviderForm = useCallback(() => {
    setCustomProviderId("");
    setCustomProviderType("openai-compatible");
    setCustomProviderDisplayName("");
    setCustomProviderBaseUrl("");
    setCustomProviderApiKey("");
    setCustomProviderApiKeyFile("");
    setCustomProviderInitialModelId("");
    setCustomProviderSubmitError(null);
    setCustomProviderSubmitAttempted(false);
    setCustomProviderTouchedFields({ providerId: false, displayName: false, baseUrl: false });
  }, []);

  const clearCustomProviderRemoveError = useCallback((provider: string) => {
    setCustomProviderRemoveErrors((prev) => {
      if (!Object.hasOwn(prev, provider)) {
        return prev;
      }

      const next = { ...prev };
      delete next[provider];
      return next;
    });
  }, []);

  const handleAddCustomProvider = useCallback(async () => {
    setCustomProviderSubmitAttempted(true);

    if (!api) {
      setCustomProviderSubmitError("Xum API not connected.");
      return;
    }

    const provider = customProviderId.trim();
    const displayName = customProviderDisplayName.trim();
    const baseUrl = customProviderBaseUrl.trim();
    const apiKey = customProviderApiKey.trim();
    const apiKeyFile = customProviderApiKeyFile.trim();
    const initialModelId = customProviderInitialModelId.trim();
    const providerIdValidation = validateCustomProviderId(provider);
    if (
      !providerIdValidation.ok ||
      displayName.length === 0 ||
      !validateCustomProviderBaseUrl(baseUrl).ok
    ) {
      setCustomProviderSubmitError(null);
      return;
    }

    const models: AddCustomProviderInput["models"] = initialModelId ? [initialModelId] : undefined;
    const input: AddCustomProviderInput = {
      provider,
      providerType: customProviderType,
      displayName,
      baseUrl,
      apiKey: apiKey || undefined,
      apiKeyFile: apiKeyFile || undefined,
      models,
    };

    setCustomProviderSubmitting(true);
    setCustomProviderSubmitError(null);
    setCustomProviderNotice(null);
    try {
      const result = await api.providers.addCustomProvider(input);
      if (!result.success) {
        setCustomProviderSubmitError(result.error.message);
        return;
      }
    } catch {
      setCustomProviderSubmitError("Failed to add custom provider.");
      return;
    } finally {
      setCustomProviderSubmitting(false);
    }

    clearCustomProviderForm();
    setCustomProviderFormOpen(false);
    setCustomProviderSubmitError(null);

    try {
      await refresh();
    } catch {
      setCustomProviderNotice(
        "Provider added, but refreshing the provider list failed. It may appear after reopening settings."
      );
    }

    setExpandedProvider(provider);
    setProvidersExpandedProvider(provider);
  }, [
    api,
    customProviderApiKey,
    customProviderApiKeyFile,
    customProviderBaseUrl,
    customProviderType,
    customProviderDisplayName,
    customProviderId,
    customProviderInitialModelId,
    clearCustomProviderForm,
    refresh,
    setProvidersExpandedProvider,
  ]);

  const handleCustomProviderFormSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleAddCustomProvider();
    },
    [handleAddCustomProvider]
  );

  const handleRemoveCustomProvider = useCallback(
    async (provider: string) => {
      if (!api) {
        setCustomProviderRemoveErrors((prev) => ({
          ...prev,
          [provider]: "Xum API not connected.",
        }));
        return;
      }

      const confirmed = window.confirm(
        `Remove custom provider "${provider}"? This deletes its saved settings.`
      );
      if (!confirmed) {
        return;
      }

      // Invalidate queued format writes: a write draining after removal
      // would recreate the entry (setConfig creates absent sections).
      providerTypeWritesRef.current.delete(provider);

      const workspaceIds = new Set(workspaceMetadata.keys());
      if (selectedWorkspace) {
        workspaceIds.add(selectedWorkspace.workspaceId);
      }

      clearCustomProviderRemoveError(provider);
      setCustomProviderNotice(null);
      setCustomProviderRemoving(provider);
      try {
        const result = await api.providers.removeCustomProvider({ provider });
        if (!result.success && result.error.code !== "config_repair_failed") {
          setCustomProviderRemoveErrors((prev) => ({
            ...prev,
            [provider]: result.error.message,
          }));
          // The provider survives, but its queued format writes were already
          // invalidated above; refetch backend truth so an unpersisted
          // optimistic format cannot linger.
          void refresh();
          return;
        }
        if (!result.success && result.error.code === "config_repair_failed") {
          setCustomProviderNotice(
            "Provider removed, but updating saved preferences failed. You may need to clear stale model defaults manually."
          );
        }

        try {
          try {
            await refresh();
          } catch {
            // Browser cache repair still needs to run after backend removal succeeds.
          }
          try {
            await refreshWorkspaceMetadata();
          } catch {
            // Browser cache repair still needs to run after backend removal succeeds.
          }
        } finally {
          repairLocalModelPreferencesForRemovedProvider(provider, workspaceIds);
        }

        setExpandedProvider((prev) => (prev === provider ? null : prev));
        setProvidersExpandedProvider(null);
        setEditingField((prev) => (prev?.provider === provider ? null : prev));
      } catch {
        setCustomProviderRemoveErrors((prev) => ({
          ...prev,
          [provider]: "Failed to remove custom provider.",
        }));
        // Same reconciliation as the structured-failure path above.
        void refresh();
      } finally {
        setCustomProviderRemoving((prev) => (prev === provider ? null : prev));
      }
    },
    [
      api,
      clearCustomProviderRemoveError,
      refresh,
      refreshWorkspaceMetadata,
      selectedWorkspace,
      setProvidersExpandedProvider,
      workspaceMetadata,
    ]
  );

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Configure API keys and endpoints for AI providers. Keys are stored in{" "}
        <code className="text-accent">~/.xum/providers.jsonc</code>
      </p>

      {policyState.status.state === "enforced" && (
        <div className="border-border-medium bg-background-secondary/50 text-muted flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <span>Your settings are controlled by a policy.</span>
        </div>
      )}

      {customProviderNotice && (
        <div className="border-warning/40 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
          {customProviderNotice}
        </div>
      )}

      {(
        [
          { key: "direct", label: "Direct Providers", providers: providerGroups.direct },
          { key: "gateway", label: "Gateways", providers: providerGroups.gateway },
          { key: "local", label: "Local", providers: providerGroups.local },
          { key: "custom", label: "Custom providers", providers: providerGroups.custom },
        ] as const
      ).map((section) => {
        if (section.providers.length === 0 && section.key !== "custom") {
          return null;
        }

        return (
          <div key={section.key} className="space-y-2">
            <div className="text-muted text-xs font-medium tracking-wide uppercase">
              {section.label}
            </div>
            {section.key === "gateway" && displayedRoutePriority.length > 0 && (
              <GatewayRoutePriorityList
                routePriority={displayedRoutePriority}
                onChangeRoutePriority={handleRoutePriorityChange}
              />
            )}
            {section.providers.map((provider) => {
              const providerInfo = config?.[provider];
              const isExpanded = expandedProvider === provider;
              const enabled = isEnabled(provider);
              const configured = isConfigured(provider);
              const fields = getProviderFields(provider, providerInfo);
              const providerDefinition = isBuiltInProvider(provider)
                ? PROVIDER_DEFINITIONS[provider]
                : null;
              const providerDisplayName = formatProviderDisplayName(provider, providerInfo);
              const providerKeyUrl = isBuiltInProvider(provider)
                ? PROVIDER_KEY_URLS[provider]
                : undefined;
              const apiKeySource = providerInfo?.apiKeySource;
              const gatewayRouteTargets =
                providerDefinition?.kind === "gateway" ? (providerDefinition.routes ?? []) : [];
              const isCustom = isCustomProviderInfo(providerInfo);
              const statusDotColor = !enabled
                ? "bg-warning"
                : configured
                  ? "bg-success"
                  : "bg-border-medium";
              const statusDotTitle = !enabled
                ? "Disabled"
                : configured
                  ? "Configured"
                  : "Not configured";

              return (
                <div
                  key={provider}
                  className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
                >
                  {/* Provider header */}
                  <Button
                    variant="ghost"
                    onClick={() => handleToggleProvider(provider)}
                    className="flex h-auto w-full items-center justify-between rounded-none px-4 py-3 text-left"
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? (
                        <ChevronDown className="text-muted h-4 w-4" />
                      ) : (
                        <ChevronRight className="text-muted h-4 w-4" />
                      )}
                      <span className="text-foreground inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap">
                        <ProviderIcon provider={provider} />
                        <span>{providerDisplayName}</span>
                      </span>
                    </div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className={`h-2 w-2 rounded-full ${statusDotColor}`}
                            title={statusDotTitle}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{statusDotTitle}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Button>

                  {/* Provider settings */}
                  {isExpanded && (
                    <div className="border-border-medium space-y-3 border-t px-4 py-3">
                      {isBuiltInProvider(provider) && isCustom && (
                        <div className="border-warning/40 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
                          This custom provider id now matches a built-in provider. Xum will keep
                          using your custom configuration.
                        </div>
                      )}
                      {provider !== "mux-gateway" && (
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <label className="text-foreground block text-xs font-medium">
                              Enabled
                            </label>
                            <span className="text-muted text-xs">
                              Disable this provider without deleting saved credentials.
                            </span>
                          </div>
                          <Switch
                            checked={enabled}
                            onCheckedChange={(nextChecked) =>
                              handleProviderEnabledChange(provider, nextChecked)
                            }
                            aria-label={`Toggle ${provider} provider`}
                            disabled={!api}
                          />
                        </div>
                      )}

                      {/* Quick link to get API key */}
                      {providerKeyUrl && (
                        <div className="space-y-1">
                          <a
                            href={providerKeyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted hover:text-accent inline-flex items-center gap-1 text-xs transition-colors"
                          >
                            Get API Key
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                          {configured &&
                            config?.[provider]?.apiKeySet === false &&
                            // OpenAI can be configured via ChatGPT OAuth, not just env vars
                            !(provider === "openai" && codexOauthIsConnected) &&
                            (apiKeySource === "env" || apiKeySource === "file") && (
                              <div className="text-muted text-xs">
                                {apiKeySource === "file"
                                  ? "Set by API key file."
                                  : "Set by env vars."}
                              </div>
                            )}
                        </div>
                      )}

                      {gatewayRouteTargets.length > 0 && (
                        <div>
                          <label className="text-foreground block text-xs font-medium">
                            Routes to
                          </label>
                          <span className="text-muted text-xs">
                            {gatewayRouteTargets
                              .map(
                                (targetProvider) => PROVIDER_DEFINITIONS[targetProvider].displayName
                              )
                              .join(", ")}
                          </span>
                        </div>
                      )}

                      {provider === "mux-gateway" && (
                        <div className="space-y-2">
                          <div>
                            <label className="text-foreground block text-xs font-medium">
                              Authentication
                            </label>
                            <span className="text-muted text-xs">{muxGatewayAuthStatusText}</span>
                          </div>

                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  void startMuxGatewayLogin();
                                }}
                                disabled={muxGatewayLoginInProgress}
                              >
                                {muxGatewayLoginButtonLabel}
                              </Button>

                              {muxGatewayLoginStatus === "waiting" && muxGatewayAuthorizeUrl && (
                                <Button
                                  size="sm"
                                  aria-label="Copy and open Xum Gateway authorization page"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(muxGatewayAuthorizeUrl);
                                    window.open(muxGatewayAuthorizeUrl, "_blank", "noopener");
                                  }}
                                  className="h-8 px-3 text-xs"
                                >
                                  Copy & Open Xum Gateway
                                </Button>
                              )}

                              {muxGatewayLoginInProgress && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={cancelMuxGatewayLogin}
                                >
                                  Cancel
                                </Button>
                              )}

                              {muxGatewayIsLoggedIn && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={clearMuxGatewayCredentials}
                                >
                                  Log out
                                </Button>
                              )}
                            </div>

                            {muxGatewayLoginStatus === "waiting" && (
                              <p className="text-muted inline-flex items-center gap-2 text-xs">
                                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                                Waiting for authorization...
                              </p>
                            )}

                            {muxGatewayLoginStatus === "error" && muxGatewayLoginError && (
                              <p className="text-destructive text-xs">
                                Login failed: {muxGatewayLoginError}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {provider === "mux-gateway" && muxGatewayIsLoggedIn && (
                        <div className="border-border-light space-y-2 border-t pt-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <label className="text-foreground block text-xs font-medium">
                                Account
                              </label>
                              <span className="text-muted text-xs">
                                Balance and limits from Xum Gateway
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                void refreshMuxGatewayAccountStatus();
                              }}
                              disabled={muxGatewayAccountLoading}
                            >
                              {muxGatewayAccountLoading ? "Refreshing..." : "Refresh"}
                            </Button>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <span className="text-muted text-xs">Balance</span>
                            <span className="text-foreground font-mono text-xs">
                              {formatMuxGatewayBalance(
                                muxGatewayAccountStatus?.remaining_microdollars
                              )}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <span className="text-muted text-xs">Concurrent requests per user</span>
                            <span className="text-foreground font-mono text-xs">
                              {muxGatewayAccountStatus?.ai_gateway_concurrent_requests_per_user ??
                                "—"}
                            </span>
                          </div>

                          {muxGatewayAccountError && (
                            <p className="text-destructive text-xs">{muxGatewayAccountError}</p>
                          )}
                        </div>
                      )}

                      {provider === "github-copilot" && (
                        <div className="space-y-2">
                          <div>
                            <label className="text-foreground block text-xs font-medium">
                              Authentication
                            </label>
                            <span className="text-muted text-xs">
                              {copilotIsLoggedIn ? "Logged in" : "Not logged in"}
                            </span>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  void startCopilotLogin();
                                }}
                                disabled={copilotLoginInProgress}
                              >
                                {copilotLoginStatus === "error"
                                  ? "Try again"
                                  : copilotLoginInProgress
                                    ? "Waiting for authorization..."
                                    : copilotIsLoggedIn
                                      ? "Re-login with GitHub"
                                      : "Login with GitHub"}
                              </Button>

                              {copilotLoginInProgress && (
                                <Button variant="secondary" size="sm" onClick={cancelCopilotLogin}>
                                  Cancel
                                </Button>
                              )}

                              {copilotIsLoggedIn && (
                                <Button variant="ghost" size="sm" onClick={clearCopilotCredentials}>
                                  Log out
                                </Button>
                              )}
                            </div>

                            {copilotLoginStatus === "waiting" && copilotUserCode && (
                              <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                                <p className="text-muted text-xs">Enter this code on GitHub:</p>
                                <div className="flex items-center gap-2">
                                  <code className="text-foreground text-lg font-bold tracking-widest">
                                    {copilotUserCode}
                                  </code>
                                  <Button
                                    size="sm"
                                    aria-label="Copy and open GitHub verification page"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(copilotUserCode);
                                      if (copilotVerificationUri) {
                                        window.open(copilotVerificationUri, "_blank", "noopener");
                                      }
                                    }}
                                    className="h-8 px-3 text-xs"
                                    disabled={!copilotVerificationUri}
                                  >
                                    Copy & Open GitHub
                                  </Button>
                                </div>
                                <p className="text-muted inline-flex items-center gap-2 text-xs">
                                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                                  Waiting for authorization...
                                </p>
                              </div>
                            )}

                            {copilotLoginStatus === "error" && copilotLoginError && (
                              <p className="text-destructive text-xs">
                                Login failed: {copilotLoginError}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {fields.map((fieldConfig) => {
                        const isEditing =
                          editingField?.provider === provider &&
                          editingField?.field === fieldConfig.key;
                        const fieldValue = getFieldValue(provider, fieldConfig.key);
                        const fieldDisplayValue = getFieldDisplayValue(provider, fieldConfig.key);
                        const fieldIsSet = isFieldSet(provider, fieldConfig.key, fieldConfig);
                        const showOpenAIBaseUrlHint =
                          fieldConfig.key === "baseUrl" &&
                          provider === "openai" &&
                          !isCustom &&
                          // The hint's advice is already applied once Chat
                          // Completions is selected.
                          config?.openai?.wireFormat !== "chatCompletions" &&
                          ((fieldDisplayValue?.trim().length ?? 0) > 0 ||
                            (isEditing && editValue.trim().length > 0));

                        return (
                          <div key={fieldConfig.key}>
                            <label className="text-muted mb-1 block text-xs">
                              {fieldConfig.label}
                              {fieldConfig.optional && (
                                <span className="text-dim"> (optional)</span>
                              )}
                            </label>
                            {isEditing ? (
                              <div className="flex gap-2">
                                <input
                                  type={
                                    fieldConfig.type === "secret" && !showPassword
                                      ? "password"
                                      : "text"
                                  }
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  placeholder={fieldConfig.placeholder}
                                  className="bg-modal-bg border-border-medium focus:border-accent flex-1 rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                                  autoFocus
                                  onKeyDown={createEditKeyHandler({
                                    onSave: handleSaveEdit,
                                    onCancel: handleCancelEdit,
                                  })}
                                />
                                {fieldConfig.type === "secret" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="text-muted hover:text-foreground h-6 w-6"
                                    title={showPassword ? "Hide password" : "Show password"}
                                  >
                                    {showPassword ? (
                                      <EyeOff className="h-4 w-4" />
                                    ) : (
                                      <Eye className="h-4 w-4" />
                                    )}
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={handleSaveEdit}
                                  className="h-6 w-6 text-green-500 hover:text-green-400"
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={handleCancelEdit}
                                  className="text-muted hover:text-foreground h-6 w-6"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center justify-between">
                                  <span className="text-foreground flex items-center gap-1 font-mono text-xs">
                                    {fieldConfig.type === "secret"
                                      ? fieldIsSet
                                        ? "••••••••"
                                        : config?.[provider]?.apiKeySource === "keyless"
                                          ? "No API key required"
                                          : "Not set"
                                      : (fieldDisplayValue ?? "Default")}
                                  </span>
                                  <div className="flex gap-2">
                                    {(fieldConfig.type === "text"
                                      ? !!fieldValue
                                      : fieldConfig.type === "secret" && fieldIsSet) && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleClearField(provider, fieldConfig.key)}
                                        className="text-muted hover:text-error h-auto px-1 py-0 text-xs"
                                      >
                                        Clear
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        handleStartEdit(provider, fieldConfig.key, fieldConfig)
                                      }
                                      className="text-accent hover:text-accent-light h-auto px-1 py-0 text-xs"
                                    >
                                      {fieldIsSet || fieldValue ? "Change" : "Set"}
                                    </Button>
                                  </div>
                                </div>
                                {fieldConfig.key === "baseUrl" &&
                                  config?.[provider]?.baseUrlSource === "env" &&
                                  config?.[provider]?.baseUrlResolved && (
                                    <div className="text-muted mt-1 text-xs">Set by env vars.</div>
                                  )}
                              </>
                            )}
                            {showOpenAIBaseUrlHint && (
                              <p className="text-muted mt-1 text-xs">
                                The OpenAI provider uses the Responses API by default. For
                                llama.cpp, vLLM, and LM Studio endpoints, set Wire format to Chat
                                completions below or use Add provider to create a custom
                                OpenAI-compatible provider.
                              </p>
                            )}
                          </div>
                        );
                      })}

                      {/* Coder: OAuth login against the configured deployment.
                          Hidden when a custom provider named
                          "coder" shadows the built-in — that entry keeps its
                          custom config and has no OAuth flow. */}
                      {provider === "coder" && !isCustom && (
                        <div className="space-y-2">
                          <div>
                            <label className="text-foreground block text-xs font-medium">
                              Authentication
                            </label>
                            <span className="text-muted text-xs">
                              {coderLoginStatus === "starting"
                                ? "Starting..."
                                : coderLoginStatus === "waiting"
                                  ? "Waiting for login..."
                                  : coderOauthIsConnected
                                    ? "Connected"
                                    : "Not connected"}
                            </span>
                          </div>

                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  void startCoderLogin();
                                }}
                                disabled={!api || coderLoginInProgress}
                              >
                                {coderLoginStatus === "error"
                                  ? "Try again"
                                  : coderOauthIsConnected
                                    ? "Re-login with Coder"
                                    : "Login with Coder"}
                              </Button>

                              {coderLoginStatus === "waiting" && coderAuthorizeUrl && (
                                <Button
                                  size="sm"
                                  aria-label="Copy and open Coder authorization page"
                                  onClick={() => {
                                    // Open first: navigator.clipboard is undefined outside
                                    // secure contexts (plain-HTTP remote origins), and a throw
                                    // there must not swallow the navigation.
                                    window.open(coderAuthorizeUrl, "_blank", "noopener");
                                    void navigator.clipboard?.writeText(coderAuthorizeUrl);
                                  }}
                                  className="h-8 px-3 text-xs"
                                >
                                  Copy & Open Coder
                                </Button>
                              )}

                              {coderLoginInProgress && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    void cancelCoderLogin();
                                  }}
                                >
                                  Cancel
                                </Button>
                              )}

                              {coderOauthIsConnected && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    // Not fire-and-forget: failures stay observable by
                                    // settling into coderModelRefreshState. The body
                                    // handles its own errors; this catch surfaces any
                                    // unexpected rejection in the same error state.
                                    refreshCoderModels().catch((err: unknown) => {
                                      setCoderModelRefreshState({
                                        kind: "error",
                                        message: getErrorMessage(err),
                                      });
                                    });
                                  }}
                                  disabled={
                                    !api ||
                                    coderLoginInProgress ||
                                    coderModelRefreshState.kind === "refreshing"
                                  }
                                >
                                  {coderModelRefreshState.kind === "refreshing"
                                    ? "Refreshing..."
                                    : "Refresh models"}
                                </Button>
                              )}

                              {coderOauthCredentialStored && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    void disconnectCoderOauth();
                                  }}
                                  disabled={!api || coderLoginInProgress}
                                >
                                  Disconnect
                                </Button>
                              )}
                            </div>

                            {coderLoginStatus === "waiting" && (
                              <p className="text-muted inline-flex items-center gap-2 text-xs">
                                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                                Waiting for authorization...
                              </p>
                            )}

                            {coderLoginStatus === "error" && coderLoginError && (
                              <p className="text-destructive text-xs">
                                Login failed: {coderLoginError}
                              </p>
                            )}

                            {coderModelRefreshState.kind === "error" && (
                              <p className="text-destructive text-xs">
                                Model refresh failed: {coderModelRefreshState.message}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Anthropic: prompt cache TTL */}
                      {provider === "anthropic" && (
                        <>
                          <div className="border-border-light border-t pt-3">
                            <div className="mb-1 flex items-center gap-1">
                              <label className="text-muted block text-xs">Prompt cache TTL</label>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <HelpIndicator aria-label="Anthropic prompt cache TTL help">
                                      ?
                                    </HelpIndicator>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <div className="max-w-[280px]">
                                      <div className="font-semibold">Prompt cache TTL</div>
                                      <div className="mt-1">
                                        Default is <span className="font-semibold">5m</span>. Use{" "}
                                        <span className="font-semibold">1h</span> for longer
                                        workflows at a higher cache-write cost.
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>

                            <Select
                              value={config?.anthropic?.cacheTtl === "1h" ? "1h" : "default"}
                              onValueChange={(next) => {
                                if (!api) {
                                  return;
                                }
                                if (next !== "default" && next !== "1h") {
                                  return;
                                }

                                const cacheTtl = next === "1h" ? "1h" : undefined;
                                updateOptimistically("anthropic", { cacheTtl });
                                void api.providers.setProviderConfig({
                                  provider: "anthropic",
                                  keyPath: ["cacheTtl"],
                                  // Empty string clears providers.jsonc key; backend defaults to 5m when unset.
                                  value: next === "1h" ? "1h" : "",
                                });
                              }}
                            >
                              <SelectTrigger className="w-40">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">Default (5m)</SelectItem>
                                <SelectItem value="1h">1 hour</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="border-border-light border-t pt-3">
                            <div className="mb-1 flex items-center gap-1">
                              <label className="text-muted block text-xs">Beta features</label>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <HelpIndicator aria-label="Anthropic beta features help">
                                      ?
                                    </HelpIndicator>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <div className="max-w-[260px]">
                                      <div className="font-semibold">Anthropic beta features</div>
                                      <div className="mt-1">
                                        Controls Anthropic beta features such as the older Sonnet 1M
                                        context beta and prompt caching. Disable for zero data
                                        retention (ZDR) environments where beta features are not
                                        eligible.
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                            <Select
                              value={
                                config?.anthropic?.disableBetaFeatures ? "disabled" : "enabled"
                              }
                              onValueChange={(next) => {
                                if (!api) return;
                                if (next !== "enabled" && next !== "disabled") return;

                                const disableBetaFeatures = next === "disabled" ? true : undefined;
                                updateOptimistically("anthropic", { disableBetaFeatures });
                                void api.providers.setProviderConfig({
                                  provider: "anthropic",
                                  keyPath: ["disableBetaFeatures"],
                                  value: next === "disabled" ? true : "",
                                });
                              }}
                            >
                              <SelectTrigger className="w-40">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="enabled">enabled</SelectItem>
                                <SelectItem value="disabled">disabled</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      )}

                      {/* OpenAI: ChatGPT OAuth + service tier */}
                      {provider === "openai" &&
                        (() => {
                          const openAIWireFormat = providerInfo?.wireFormat ?? "responses";
                          const openAIWebSocketTransportVisible = openAIWireFormat === "responses";
                          return (
                            <div className="border-border-light space-y-3 border-t pt-3">
                              <div>
                                <label className="text-foreground block text-xs font-medium">
                                  ChatGPT (Codex) OAuth
                                </label>
                                <span className="text-muted text-xs">
                                  {codexOauthStatus === "starting"
                                    ? "Starting..."
                                    : codexOauthStatus === "waiting"
                                      ? "Waiting for login..."
                                      : codexOauthIsConnected
                                        ? "Connected"
                                        : "Not connected"}
                                </span>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                {!isRemoteServer && (
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      void startCodexOauthBrowserConnect();
                                    }}
                                    disabled={!api || codexOauthLoginInProgress}
                                  >
                                    Connect (Browser)
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => {
                                    void startCodexOauthDeviceConnect();
                                  }}
                                  disabled={!api || codexOauthLoginInProgress}
                                >
                                  Connect (Device)
                                </Button>

                                {codexOauthStatus === "waiting" &&
                                  !codexOauthDeviceFlow &&
                                  codexOauthAuthorizeUrl && (
                                    <Button
                                      size="sm"
                                      aria-label="Copy and open OpenAI authorization page"
                                      onClick={() => {
                                        void navigator.clipboard.writeText(codexOauthAuthorizeUrl);
                                        window.open(codexOauthAuthorizeUrl, "_blank", "noopener");
                                      }}
                                      className="h-8 px-3 text-xs"
                                    >
                                      Copy & Open OpenAI
                                    </Button>
                                  )}

                                {codexOauthLoginInProgress && (
                                  <Button variant="secondary" size="sm" onClick={cancelCodexOauth}>
                                    Cancel
                                  </Button>
                                )}

                                {codexOauthIsConnected && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      void disconnectCodexOauth();
                                    }}
                                    disabled={!api || codexOauthLoginInProgress}
                                  >
                                    Disconnect
                                  </Button>
                                )}
                              </div>

                              {codexOauthDeviceFlow && (
                                <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                                  <p className="text-muted text-xs">
                                    Enter this code on the OpenAI verification page:
                                  </p>
                                  <div className="flex items-center gap-2">
                                    <code className="text-foreground text-lg font-bold tracking-widest">
                                      {codexOauthDeviceFlow.userCode}
                                    </code>
                                    <Button
                                      size="sm"
                                      aria-label="Copy and open OpenAI verification page"
                                      onClick={() => {
                                        void navigator.clipboard.writeText(
                                          codexOauthDeviceFlow.userCode
                                        );
                                        window.open(
                                          codexOauthDeviceFlow.verifyUrl,
                                          "_blank",
                                          "noopener"
                                        );
                                      }}
                                      className="h-8 px-3 text-xs"
                                    >
                                      Copy & Open OpenAI
                                    </Button>
                                  </div>
                                  <p className="text-muted inline-flex items-center gap-2 text-xs">
                                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                                    Waiting for authorization...
                                  </p>
                                </div>
                              )}

                              {codexOauthStatus === "waiting" && !codexOauthDeviceFlow && (
                                <p className="text-muted inline-flex items-center gap-2 text-xs">
                                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                                  Waiting for authorization...
                                </p>
                              )}

                              {codexOauthStatus === "error" && codexOauthError && (
                                <p className="text-destructive text-xs">{codexOauthError}</p>
                              )}

                              <div className="border-border-light space-y-2 border-t pt-3">
                                <div>
                                  <label className="text-muted block text-xs">
                                    Default auth (when both are set)
                                  </label>
                                  <p className="text-muted text-xs">
                                    Applies to models that support both ChatGPT OAuth and API keys
                                    (e.g. <code className="text-accent">gpt-5.5</code>).
                                  </p>
                                </div>

                                <ToggleGroup
                                  type="single"
                                  value={codexOauthDefaultAuth}
                                  onValueChange={(next) => {
                                    if (!api) return;
                                    if (next !== "oauth" && next !== "apiKey") {
                                      return;
                                    }

                                    updateOptimistically("openai", { codexOauthDefaultAuth: next });
                                    void api.providers.setProviderConfig({
                                      provider: "openai",
                                      keyPath: ["codexOauthDefaultAuth"],
                                      value: next,
                                    });
                                  }}
                                  size="sm"
                                  className="h-9"
                                  disabled={!api || !codexOauthDefaultAuthIsEditable}
                                >
                                  <ToggleGroupItem
                                    value="oauth"
                                    size="sm"
                                    className="h-7 px-3 text-[13px]"
                                  >
                                    Use ChatGPT OAuth by default
                                  </ToggleGroupItem>
                                  <ToggleGroupItem
                                    value="apiKey"
                                    size="sm"
                                    className="h-7 px-3 text-[13px]"
                                  >
                                    Use OpenAI API key by default
                                  </ToggleGroupItem>
                                </ToggleGroup>

                                <p className="text-muted text-xs">
                                  ChatGPT OAuth costs use API-equivalent estimates. Your plan may
                                  include usage or charge credits. API keys use OpenAI platform
                                  billing.
                                </p>

                                {!codexOauthDefaultAuthIsEditable && (
                                  <p className="text-muted text-xs">
                                    Connect ChatGPT OAuth and set an OpenAI API key to change this
                                    setting.
                                  </p>
                                )}
                              </div>

                              <div className="border-border-light border-t pt-3">
                                <div className="mb-1 flex items-center gap-1">
                                  <label className="text-muted block text-xs">Service tier</label>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <HelpIndicator aria-label="OpenAI service tier help">
                                          ?
                                        </HelpIndicator>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className="max-w-[260px]">
                                          <div className="font-semibold">OpenAI service tier</div>
                                          <div className="mt-1">
                                            <span className="font-semibold">auto</span>: standard
                                            behavior.
                                          </div>
                                          <div>
                                            <span className="font-semibold">priority</span>: lower
                                            latency, higher cost.
                                          </div>
                                          <div>
                                            <span className="font-semibold">flex</span>: lower cost,
                                            higher latency.
                                          </div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                                <Select
                                  value={
                                    openaiServiceTierSelectOverride ??
                                    config?.openai?.serviceTier ??
                                    OPENAI_SERVICE_TIER_UNSET
                                  }
                                  onValueChange={(next) => {
                                    if (!api) return;

                                    if (next === OPENAI_SERVICE_TIER_UNSET) {
                                      setOpenaiServiceTierSelectOverride(OPENAI_SERVICE_TIER_UNSET);
                                      void api.providers
                                        .setProviderConfig({
                                          provider: "openai",
                                          keyPath: ["serviceTier"],
                                          value: "",
                                        })
                                        .then(() => refresh())
                                        .finally(() => setOpenaiServiceTierSelectOverride(null));
                                      return;
                                    }

                                    if (!isOpenAIServiceTier(next)) {
                                      return;
                                    }

                                    setOpenaiServiceTierSelectOverride(null);
                                    updateOptimistically("openai", { serviceTier: next });
                                    void api.providers.setProviderConfig({
                                      provider: "openai",
                                      keyPath: ["serviceTier"],
                                      value: next,
                                    });
                                  }}
                                >
                                  <SelectTrigger className="w-64">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={OPENAI_SERVICE_TIER_UNSET}>
                                      Not configured (omit service_tier)
                                    </SelectItem>
                                    <SelectItem value="auto">auto</SelectItem>
                                    <SelectItem value="default">default</SelectItem>
                                    <SelectItem value="flex">flex</SelectItem>
                                    <SelectItem value="priority">priority</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="border-border-light border-t pt-3">
                                <div className="mb-1 flex items-center gap-1">
                                  <label className="text-muted block text-xs">Wire format</label>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <HelpIndicator aria-label="OpenAI wire format help">
                                          ?
                                        </HelpIndicator>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className="max-w-[260px]">
                                          <div className="font-semibold">OpenAI wire format</div>
                                          <div className="mt-1">
                                            <span className="font-semibold">responses</span>: modern
                                            API with persistence and built-in tools (default).
                                          </div>
                                          <div>
                                            <span className="font-semibold">chat completions</span>:
                                            legacy /chat/completions endpoint. Use if your provider
                                            doesn&apos;t support the Responses API (e.g. Azure Gov).
                                          </div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                                <Select
                                  value={config?.openai?.wireFormat ?? "responses"}
                                  onValueChange={(next) => {
                                    if (!api) return;
                                    if (next !== "responses" && next !== "chatCompletions") return;

                                    updateOptimistically("openai", { wireFormat: next });
                                    void api.providers.setProviderConfig({
                                      provider: "openai",
                                      keyPath: ["wireFormat"],
                                      value: next,
                                    });
                                  }}
                                >
                                  <SelectTrigger className="w-40">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="responses">responses</SelectItem>
                                    <SelectItem value="chatCompletions">
                                      chat completions
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              {openAIWebSocketTransportVisible && (
                                <div className="border-border-light border-t pt-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <label className="text-foreground block text-xs font-medium">
                                        WebSocket transport
                                      </label>
                                      <span className="text-muted text-xs">
                                        Experimental: uses OpenAI&apos;s Responses WebSocket
                                        transport for streaming Responses API requests. Unsupported
                                        endpoints may fail.
                                      </span>
                                    </div>
                                    <Switch
                                      checked={config?.openai?.webSocketTransportEnabled === true}
                                      disabled={!api}
                                      onCheckedChange={(nextChecked) => {
                                        if (!api) return;

                                        const webSocketTransportEnabled = nextChecked
                                          ? true
                                          : undefined;
                                        updateOptimistically("openai", {
                                          webSocketTransportEnabled,
                                        });
                                        void api.providers.setProviderConfig({
                                          provider: "openai",
                                          keyPath: ["webSocketTransportEnabled"],
                                          value: nextChecked ? true : "",
                                        });
                                      }}
                                      aria-label="WebSocket transport"
                                    />
                                  </div>
                                </div>
                              )}

                              <div className="border-border-light border-t pt-3">
                                <div className="mb-1 flex items-center gap-1">
                                  <label className="text-muted block text-xs">
                                    Response storage
                                  </label>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <HelpIndicator aria-label="OpenAI response storage help">
                                          ?
                                        </HelpIndicator>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className="max-w-[260px]">
                                          <div className="font-semibold">
                                            OpenAI response storage
                                          </div>
                                          <div className="mt-1">
                                            <span className="font-semibold">enabled</span>: OpenAI
                                            stores responses for retrieval and context (default).
                                          </div>
                                          <div>
                                            <span className="font-semibold">disabled</span>:
                                            responses are not stored. Required for zero data
                                            retention (ZDR) endpoints.
                                          </div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                                <Select
                                  value={config?.openai?.store === false ? "disabled" : "enabled"}
                                  disabled={openaiStoreSaving}
                                  onValueChange={(next) => {
                                    if (!api || openaiStoreSaving) return;
                                    if (next !== "enabled" && next !== "disabled") return;

                                    const store = next === "disabled" ? false : undefined;
                                    setOpenAIStoreSaving(true);
                                    void api.providers
                                      .setProviderConfig({
                                        provider: "openai",
                                        keyPath: ["store"],
                                        value: next === "disabled" ? false : "",
                                      })
                                      .then(
                                        (result) => {
                                          if (result.success) {
                                            updateOptimistically("openai", { store });
                                            return undefined;
                                          }
                                          return refresh();
                                        },
                                        () => refresh()
                                      )
                                      .finally(() => setOpenAIStoreSaving(false));
                                  }}
                                >
                                  <SelectTrigger className="w-40">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="enabled">enabled</SelectItem>
                                    <SelectItem value="disabled">disabled</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          );
                        })()}

                      {provider === "xai" && (
                        <div className="border-border-light border-t pt-3">
                          <div className="mb-1 flex items-center gap-1">
                            <label className="text-muted block text-xs">Processing mode</label>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <HelpIndicator aria-label="xAI processing mode help">
                                    ?
                                  </HelpIndicator>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <div className="max-w-[260px]">
                                    <div className="font-semibold">xAI processing mode</div>
                                    <div className="mt-1">
                                      <span className="font-semibold">standard</span>: normal
                                      scheduling and token pricing.
                                    </div>
                                    <div>
                                      <span className="font-semibold">fast</span>: priority
                                      scheduling for lower latency at 2× token pricing.
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                          <Select
                            value={config?.xai?.serviceTier ?? "default"}
                            disabled={xaiServiceTierSaving}
                            onValueChange={(next) => {
                              if (!api || xaiServiceTierSaving || !isXAIServiceTier(next)) return;

                              // Persist before publishing the new tier so the composer cannot
                              // observe Fast mode until the backend will apply it to requests.
                              setXAIServiceTierSaving(true);
                              void api.providers
                                .setProviderConfig({
                                  provider: "xai",
                                  keyPath: ["serviceTier"],
                                  value: next,
                                })
                                .then(
                                  (result) => {
                                    if (result.success) {
                                      updateOptimistically("xai", { serviceTier: next });
                                      return undefined;
                                    }
                                    return refresh();
                                  },
                                  () => refresh()
                                )
                                .finally(() => setXAIServiceTierSaving(false));
                            }}
                          >
                            <SelectTrigger className="w-48 max-w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">standard</SelectItem>
                              <SelectItem value="priority">fast (priority)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {isCustom && (
                        <div className="border-border-light space-y-3 border-t pt-3">
                          <div className="flex items-center justify-between gap-3">
                            <label className="text-foreground block text-xs font-medium">
                              API format
                            </label>
                            <Select
                              value={providerInfo.providerType}
                              onValueChange={(next) => {
                                if (isCustomProviderType(next)) {
                                  handleCustomProviderTypeChange(
                                    provider,
                                    next,
                                    providerInfo.providerType
                                  );
                                }
                              }}
                            >
                              <SelectTrigger className="w-56 max-w-full" aria-label="API format">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CUSTOM_PROVIDER_TYPES.map((providerType) => (
                                  <SelectItem key={providerType} value={providerType}>
                                    {CUSTOM_PROVIDER_TYPE_LABELS[providerType]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="border-border-light flex items-center justify-between gap-3 border-t pt-3">
                            <div>
                              <label className="text-foreground block text-xs font-medium">
                                Remove custom provider
                              </label>
                              <span className="text-muted text-xs">
                                Delete this provider from saved settings.
                              </span>
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                void handleRemoveCustomProvider(provider);
                              }}
                              disabled={!api || customProviderRemoving === provider}
                            >
                              {customProviderRemoving === provider ? "Removing..." : "Remove"}
                            </Button>
                          </div>
                          {customProviderRemoveErrors[provider] && (
                            <p className="text-destructive text-xs">
                              {customProviderRemoveErrors[provider]}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {section.key === "custom" && (
              <div className="border-border-medium bg-background-secondary/50 space-y-3 rounded-md border px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-foreground text-xs font-medium">Add a custom provider</div>
                    <div className="text-muted text-xs">
                      Add providers that use OpenAI Chat Completions, OpenAI Responses, or Anthropic
                      Messages.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setCustomProviderFormOpen((prev) => {
                        const next = !prev;
                        if (!next) {
                          clearCustomProviderForm();
                        } else {
                          setCustomProviderSubmitError(null);
                          setCustomProviderSubmitAttempted(false);
                          setCustomProviderTouchedFields({
                            providerId: false,
                            displayName: false,
                            baseUrl: false,
                          });
                        }
                        return next;
                      });
                    }}
                  >
                    {customProviderFormOpen ? "Cancel" : "Add provider"}
                  </Button>
                </div>

                {customProviderFormOpen && (
                  <form className="space-y-3" onSubmit={handleCustomProviderFormSubmit}>
                    <label className="block space-y-1">
                      <span className="text-muted text-xs">Provider ID</span>
                      <input
                        value={customProviderId}
                        onChange={(event) => {
                          setCustomProviderId(event.target.value);
                          if (event.target.value.trim().length > 0) {
                            markCustomProviderFieldTouched("providerId");
                          }
                        }}
                        onBlur={() => markCustomProviderFieldTouched("providerId")}
                        placeholder="acme-openai"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      {showCustomProviderIdError && (
                        <span className="text-destructive block text-xs">
                          {customProviderIdValidation.reason}
                        </span>
                      )}
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">Display name</span>
                      <input
                        value={customProviderDisplayName}
                        onChange={(event) => {
                          setCustomProviderDisplayName(event.target.value);
                          if (event.target.value.trim().length > 0) {
                            markCustomProviderFieldTouched("displayName");
                          }
                        }}
                        onBlur={() => markCustomProviderFieldTouched("displayName")}
                        placeholder="Acme OpenAI"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 text-xs focus:outline-none"
                      />
                      {showCustomProviderDisplayNameError && (
                        <span className="text-destructive block text-xs">
                          {customProviderDisplayNameError}
                        </span>
                      )}
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">API format</span>
                      <Select
                        value={customProviderType}
                        onValueChange={(next) => {
                          if (isCustomProviderType(next)) {
                            setCustomProviderType(next);
                          }
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="API format">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CUSTOM_PROVIDER_TYPES.map((providerType) => (
                            <SelectItem key={providerType} value={providerType}>
                              {CUSTOM_PROVIDER_TYPE_LABELS[providerType]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">Base URL</span>
                      <input
                        value={customProviderBaseUrl}
                        onChange={(event) => {
                          setCustomProviderBaseUrl(event.target.value);
                          if (event.target.value.trim().length > 0) {
                            markCustomProviderFieldTouched("baseUrl");
                          }
                        }}
                        onBlur={() => markCustomProviderFieldTouched("baseUrl")}
                        placeholder="https://api.acme.test/v1"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                      {showCustomProviderBaseUrlError && (
                        <span className="text-destructive block text-xs">
                          {customProviderBaseUrlError}
                        </span>
                      )}
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">API key (optional)</span>
                      <input
                        type="password"
                        value={customProviderApiKey}
                        onChange={(event) => setCustomProviderApiKey(event.target.value)}
                        placeholder="Enter API key"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">API key file (optional)</span>
                      <input
                        value={customProviderApiKeyFile}
                        onChange={(event) => setCustomProviderApiKeyFile(event.target.value)}
                        placeholder="~/.config/provider/token"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="text-muted text-xs">Initial model ID (optional)</span>
                      <input
                        value={customProviderInitialModelId}
                        onChange={(event) => setCustomProviderInitialModelId(event.target.value)}
                        placeholder="gpt-4o-mini"
                        className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      />
                    </label>

                    {customProviderSubmitError && (
                      <p className="text-destructive text-xs">{customProviderSubmitError}</p>
                    )}

                    <div className="flex justify-end">
                      <Button type="submit" size="sm" disabled={!api || customProviderSubmitting}>
                        {customProviderSubmitting ? "Adding..." : "Add custom provider"}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        );
      })}

      {config && !hasAnyConfiguredProvider && (
        <div className="border-warning/40 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
          No providers are currently enabled. You won&apos;t be able to send messages until you
          enable a provider.
        </div>
      )}
    </div>
  );
}
