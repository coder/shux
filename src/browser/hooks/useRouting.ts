import { useCallback, useSyncExternalStore } from "react";
import { useAPI } from "@/browser/contexts/API";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  availableRoutes as listAvailableRoutes,
  resolveRoute as resolveRouteForModel,
  type AvailableRoute,
  type RouteContext,
} from "@/common/routing";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { isGatewayModelAccessibleForUi } from "@/browser/utils/policyUi";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";

import { useProvidersConfig } from "./useProvidersConfig";

const DEFAULT_ROUTE_PRIORITY = ["direct"];
// Stable fallback so snapshot-less renders don't churn referential equality.
const EMPTY_ROUTE_OVERRIDES: Record<string, string> = {};

function getRouteDisplayName(route: string): string {
  if (route === "direct") {
    return "Direct";
  }

  if (route in PROVIDER_DEFINITIONS) {
    return PROVIDER_DEFINITIONS[route as ProviderName].displayName;
  }

  return route;
}

export interface RoutingState {
  /** Ordered route priority list */
  routePriority: string[];
  /** Per-model route overrides */
  routeOverrides: Record<string, string>;

  /** What route will be used for a given canonical model? */
  resolveRoute(canonicalModel: string): {
    route: string;
    isAuto: boolean;
    displayName: string;
  };

  /** Actual route for a raw selection, including policy-aware explicit gateway fallback. */
  resolveEffectiveRoute: (modelString: string) => string;

  /** What route would be used if all per-model overrides were cleared? */
  resolveAutoRoute(canonicalModel: string): {
    route: string;
    isAuto: true;
    displayName: string;
  };

  /** Which routes can reach a given model's origin? */
  availableRoutes(canonicalModel: string): AvailableRoute[];

  /** Replace both route priority and per-model overrides together */
  setRoutePreferences(priority: string[], overrides: Record<string, string>): void;

  /** Set the full priority list (drag-reorder) */
  setRoutePriority(priority: string[]): void;

  /** Set/clear a per-model override */
  setRouteOverride(canonicalModel: string, route: string | null): void;
}

export function useRouting(): RoutingState {
  const { api } = useAPI();
  const { config: providersConfig } = useProvidersConfig();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  // Shared AppConfigStore (one fetch + one onConfigChanged subscription per
  // app session) instead of per-mount fetches: surfaces render one picker per
  // row, so per-instance subscriptions fanned out O(rows) backend reads.
  const store = getAppConfigStore();
  const appConfig = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const routePriority = appConfig?.routePriority ?? DEFAULT_ROUTE_PRIORITY;
  const routeOverrides = appConfig?.routeOverrides ?? EMPTY_ROUTE_OVERRIDES;

  const isConfigured = useCallback(
    (provider: string) =>
      providersConfig?.[provider]?.isConfigured === true &&
      providersConfig?.[provider]?.isEnabled !== false,
    [providersConfig]
  );

  // Policy-aware so route pickers, availability, and resolution never offer a
  // gateway route the backend rejects at send time.
  const isGatewayModelAccessible = useCallback(
    (gateway: string, modelId: string) =>
      isGatewayModelAccessibleForUi(effectivePolicy, providersConfig, gateway, modelId),
    [effectivePolicy, providersConfig]
  );

  const persistRoutePreferences = useCallback(
    (priority: string[], overrides: Record<string, string>) => {
      if (!api?.config?.updateRoutePreferences) {
        return;
      }

      api.config
        .updateRoutePreferences({
          routePriority: priority,
          routeOverrides: overrides,
        })
        .catch(() => {
          // The optimistic update landed in the shared singleton store, so a
          // failed write must re-fetch or the stale route survives navigation
          // (same recovery as useMinThinkingLevels).
          void store.refresh();
        });
    },
    [api, store]
  );

  const setRoutePreferences = useCallback(
    (priority: string[], overrides: Record<string, string>) => {
      store.updateOptimistically({ routePriority: priority, routeOverrides: overrides });
      persistRoutePreferences(priority, overrides);
    },
    [persistRoutePreferences, store]
  );

  const setRoutePriority = useCallback(
    (priority: string[]) => {
      setRoutePreferences(priority, routeOverrides);
    },
    [routeOverrides, setRoutePreferences]
  );

  const setRouteOverride = useCallback(
    (canonicalModel: string, route: string | null) => {
      const key = normalizeToCanonical(canonicalModel);
      const nextOverrides = { ...routeOverrides };
      if (route == null) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = route;
      }

      setRoutePreferences(routePriority, nextOverrides);
    },
    [routeOverrides, routePriority, setRoutePreferences]
  );

  const resolveRoute = useCallback(
    (canonicalModel: string) => {
      const normalized = normalizeToCanonical(canonicalModel);
      // Resolve routes from the same canonical key space used for per-model overrides.
      const resolved: RouteContext = resolveRouteForModel(
        normalized,
        routePriority,
        routeOverrides,
        isConfigured,
        isGatewayModelAccessible
      );

      const route = resolved.routeProvider === resolved.origin ? "direct" : resolved.routeProvider;
      const override = routeOverrides[normalized];
      const overrideUsed =
        override != null &&
        (override === "direct" || override === resolved.origin
          ? route === "direct"
          : route === override);

      return {
        route,
        isAuto: !overrideUsed,
        displayName: getRouteDisplayName(route),
      };
    },
    [isConfigured, isGatewayModelAccessible, routeOverrides, routePriority]
  );

  const resolveEffectiveRoute = (modelString: string): string => {
    const [prefix] = modelString.split(":", 1);
    if (isCustomProviderConfig(providersConfig?.[prefix])) return "direct";

    let routeModel = modelString;
    if (modelString.startsWith("coder:")) {
      if (
        isConfigured("coder") &&
        isGatewayModelAccessible("coder", modelString.slice("coder:".length))
      ) {
        return "coder";
      }
      // Mirror the backend's type-derived fallback. Treat-as aliases describe
      // capabilities only; they must never redirect a request to another provider.
      routeModel = resolveCoderGatewayMetadataModel(modelString, providersConfig) ?? modelString;
    }
    const resolved = resolveRouteForModel(
      routeModel,
      routePriority,
      routeOverrides,
      isConfigured,
      isGatewayModelAccessible
    );
    return resolved.routeProvider === resolved.origin ? "direct" : resolved.routeProvider;
  };

  // Resolve ignoring per-model overrides — answers "what would Auto pick?"
  const resolveAutoRoute = useCallback(
    (canonicalModel: string) => {
      const normalized = normalizeToCanonical(canonicalModel);
      const resolved: RouteContext = resolveRouteForModel(
        normalized,
        routePriority,
        {}, // empty overrides — priority-walk only
        isConfigured,
        isGatewayModelAccessible
      );

      const route = resolved.routeProvider === resolved.origin ? "direct" : resolved.routeProvider;
      return {
        route,
        isAuto: true as const,
        displayName: getRouteDisplayName(route),
      };
    },
    [isConfigured, isGatewayModelAccessible, routePriority]
  );

  const availableRoutes = useCallback(
    (canonicalModel: string): AvailableRoute[] =>
      listAvailableRoutes(canonicalModel, isConfigured, isGatewayModelAccessible),
    [isConfigured, isGatewayModelAccessible]
  );

  return {
    routePriority,
    routeOverrides,
    resolveRoute,
    resolveEffectiveRoute,
    resolveAutoRoute,
    availableRoutes,
    setRoutePreferences,
    setRoutePriority,
    setRouteOverride,
  };
}
