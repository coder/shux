import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import type { APIClient } from "@/browser/contexts/API";
import {
  mergeGoalDefaults,
  resolveGoalSetIntent,
  type WorkspaceGoalDefaultsOverride,
} from "@/common/utils/goals/resolveGoalSetIntent";

export { mergeGoalDefaults, resolveGoalSetIntent, type WorkspaceGoalDefaultsOverride };

/**
 * Load *effective* goal defaults via the API client.
 *
 * When `workspaceId` is provided, the per-workspace override (if any) is
 * layered on top of the global defaults, so callers (slash command, command
 * palette, GoalTab create form) all see the same effective values. When
 * omitted, only the global defaults are returned — this keeps the helper
 * usable from contexts that don't yet know which workspace they're acting
 * against (rare today; mainly tests and the global Settings UI).
 *
 * Falls back to `DEFAULT_GOAL_DEFAULTS` on any error so a missing or
 * disconnected config never blocks goal creation. Errors loading the
 * workspace override are also swallowed — global defaults still apply.
 */
export async function loadGoalDefaults(
  api: APIClient,
  workspaceId?: string
): Promise<GoalDefaults> {
  let globalDefaults: GoalDefaults;
  try {
    const config = await api.config?.getConfig?.();
    globalDefaults = normalizeGoalDefaults(config?.goalDefaults ?? DEFAULT_GOAL_DEFAULTS);
  } catch {
    globalDefaults = { ...DEFAULT_GOAL_DEFAULTS };
  }

  if (!workspaceId) {
    return globalDefaults;
  }

  let override: WorkspaceGoalDefaultsOverride | null = null;
  try {
    override = (await api.workspace?.goalDefaults?.get?.({ workspaceId })) ?? null;
  } catch {
    override = null;
  }
  return mergeGoalDefaults(globalDefaults, override);
}
