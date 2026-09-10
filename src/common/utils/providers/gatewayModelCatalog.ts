import type { ProviderModelEntry } from "@/common/orpc/types";

import { normalizeCopilotModelId } from "@/common/utils/copilot/modelRouting";
import { maybeGetProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isProviderModelAccessibleFromAuthoritativeCatalog(
  provider: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined,
  // Coder-only: the AI Bridge catalog discovered at login. `models` alone
  // cannot gate routing because it also carries manually added entries — a
  // manual-only list left behind by a fresh login must not read as an
  // exhaustive catalog.
  discoveredModels: string[] | undefined,
  // Coder-only: durable user removals (see applyCoderModelEdit). Checked
  // before every other branch — including the unknown-catalog fail-open —
  // because an explicit removal must hold even while discovery is pending
  // or failed, or routePriority could route the removed model through Coder
  // instead of the user's configured fallback.
  removedModels?: string[]
): boolean {
  // Coder routing is gated on the discovered AI Bridge catalog: the bridge
  // only serves models its upstreams expose, so routing any other model
  // through Coder would fail at the bridge instead of falling back to a
  // configured direct provider. A present `discoveredModels` (including an
  // empty one) marks the catalog as known — `models` (the user-visible union
  // of discovered + manual entries) is then the accessible set, so manual
  // additions stay routable and user removals are respected. A MISSING
  // `discoveredModels` means the catalog is unknown (login clears it and
  // discovery is pending, or discovery failed transiently and was not
  // persisted): stay permissive so a temporary /models outage cannot strand
  // routing until the next login.
  if (provider === "coder") {
    if (removedModels?.includes(modelId)) {
      return false;
    }
    if (!Array.isArray(discoveredModels)) {
      return true;
    }
    // Hand-edited configs may drop `models` while keeping the marker; fall
    // back to the catalog itself rather than blanket-blocking every model.
    if (!Array.isArray(models)) {
      return discoveredModels.includes(modelId);
    }
    for (const entry of models) {
      const configuredModelId = maybeGetProviderModelEntryId(entry);
      if (configuredModelId != null && configuredModelId === modelId) {
        return true;
      }
    }
    return false;
  }

  // Most provider config model lists are user-managed custom entries, not exhaustive
  // server catalogs. GitHub Copilot is the other exception because OAuth refresh
  // stores the full model catalog returned by Copilot's /models endpoint.
  if (provider !== "github-copilot") {
    return true;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeCopilotModelId(modelId);
  let foundValidEntry = false;
  for (const entry of models) {
    const configuredModelId = maybeGetProviderModelEntryId(entry);
    if (configuredModelId == null) {
      continue;
    }

    foundValidEntry = true;
    if (normalizeCopilotModelId(configuredModelId) === normalizedModelId) {
      return true;
    }
  }

  return !foundValidEntry;
}

export function isGatewayModelAccessibleFromAuthoritativeCatalog(
  gateway: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined,
  discoveredModels: string[] | undefined,
  removedModels?: string[]
): boolean {
  return isProviderModelAccessibleFromAuthoritativeCatalog(
    gateway,
    modelId,
    models,
    discoveredModels,
    removedModels
  );
}
