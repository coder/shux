import { getModelKey } from "@/common/constants/storage";
import { modelSelectionEqualityKey } from "@/common/utils/ai/models";
import { readPersistedString, updatePersistedState } from "@/browser/hooks/usePersistedState";

export type ModelChangeOrigin = "user" | "agent" | "sync";

interface ExplicitModelChange {
  model: string;
  origin: ModelChangeOrigin;
  previousModel: string | null;
}

// User request: keep origin tracking in-memory so UI-only warnings don't add persistence complexity.
const pendingExplicitChanges = new Map<string, ExplicitModelChange>();

// Coder identities stay raw so switches between coder:<instance>/<model> and the
// direct <provider>:<model> are tracked as explicit actions; passthrough gateway
// aliases (mux-gateway:openai/x) still collapse so persisted rewrites keep matching.
const normalizeExplicitModel = (model: string): string => modelSelectionEqualityKey(model);

export function recordWorkspaceModelChange(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  if (origin === "sync") return;

  const normalized = normalizeExplicitModel(model);
  const current = readPersistedString(getModelKey(workspaceId));
  const normalizedCurrent = current ? normalizeExplicitModel(current) : null;

  // Avoid leaving stale explicit-change entries when the effective model doesn't change
  // (ex: user re-selects the current model, or callers pass gateway-vs-canonical equivalents).
  // Without this guard, a later sync-driven away→back transition could incorrectly consume the
  // lingering entry and surface a warning that wasn't explicitly triggered.
  if (normalizedCurrent === normalized) {
    return;
  }

  pendingExplicitChanges.set(workspaceId, {
    model: normalized,
    origin,
    previousModel: normalizedCurrent,
  });
}

export function consumeWorkspaceModelChange(
  workspaceId: string,
  model: string
): ModelChangeOrigin | null {
  const entry = pendingExplicitChanges.get(workspaceId);
  if (!entry) return null;

  const normalized = normalizeExplicitModel(model);

  if (entry.model === normalized) {
    pendingExplicitChanges.delete(workspaceId);
    return entry.origin;
  }

  // If the store reports the model from before the explicit change (e.g., rapid A→B selection
  // where we briefly observe A while tracking B), keep the newest entry.
  if (entry.previousModel === normalized) {
    return null;
  }

  // Model diverged somewhere else; the entry is stale and should not be consumed later.
  pendingExplicitChanges.delete(workspaceId);
  return null;
}

export function setWorkspaceModelWithOrigin(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  recordWorkspaceModelChange(workspaceId, model, origin);
  updatePersistedState(getModelKey(workspaceId), model);
}
