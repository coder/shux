import type { APIClient } from "@/browser/contexts/API";
import {
  syncPersistedStateFromBackend,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_RUNTIME_KEY,
  HIDDEN_MODELS_KEY,
  RUNTIME_ENABLEMENT_KEY,
} from "@/common/constants/storage";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";

export type ConfigMirrorSource = Pick<
  Awaited<ReturnType<APIClient["config"]["getConfig"]>>,
  "defaultModel" | "hiddenModels" | "agentAiDefaults" | "runtimeEnablement" | "defaultRuntime"
>;

/**
 * Model, agent, and runtime defaults live in config.json, but the renderer reads them from
 * localStorage mirrors seeded from the backend. Seeding runs at startup and again after a
 * settings restore, which rewrites config behind the mirrors: without the re-seed the next
 * hide/unhide would persist the stale list over the restored one. The backend is authoritative,
 * so a value it no longer holds clears the mirror too; `skipKeys` protects local writes the
 * startup seed must not overwrite.
 */
export function seedConfigMirrors(
  cfg: ConfigMirrorSource,
  skipKeys: ReadonlySet<string> = new Set()
): void {
  updatePersistedState(AGENT_AI_DEFAULTS_KEY, normalizeAgentAiDefaults(cfg.agentAiDefaults ?? {}));
  if (!skipKeys.has(DEFAULT_MODEL_KEY)) {
    syncPersistedStateFromBackend(DEFAULT_MODEL_KEY, cfg.defaultModel);
  }
  if (!skipKeys.has(HIDDEN_MODELS_KEY)) {
    syncPersistedStateFromBackend(HIDDEN_MODELS_KEY, cfg.hiddenModels);
  }
  updatePersistedState(RUNTIME_ENABLEMENT_KEY, cfg.runtimeEnablement);
  updatePersistedState(DEFAULT_RUNTIME_KEY, cfg.defaultRuntime);
}
