import type { TaskSettings as TaskSettingsOnDisk } from "@/common/config/schemas/taskSettings";
import { TASK_SETTINGS_LIMITS } from "@/common/config/schemas/taskSettings";
import assert from "@/common/utils/assert";

export { TASK_SETTINGS_LIMITS } from "@/common/config/schemas/taskSettings";

// Normalized runtime settings always include numeric task limits.
export type TaskSettings = Required<
  Pick<TaskSettingsOnDisk, "maxParallelAgentTasks" | "maxTaskNestingDepth">
> &
  Omit<TaskSettingsOnDisk, "maxParallelAgentTasks" | "maxTaskNestingDepth">;

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxParallelAgentTasks: TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default,
  maxTaskNestingDepth: TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default,
  proposePlanImplementReplacesChatHistory: false,
  // Completed user-spawned sub-agents are durable workspace records. Archive is reversible;
  // explicit remove owns irreversible cleanup. Workflow-owned tasks keep their transient cleanup.
  preserveSubagentsUntilArchive: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function normalizeTaskSettings(raw: unknown): TaskSettings {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const maxParallelAgentTasks = clampInt(
    record.maxParallelAgentTasks,
    DEFAULT_TASK_SETTINGS.maxParallelAgentTasks,
    TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min,
    TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max
  );
  const maxTaskNestingDepth = clampInt(
    record.maxTaskNestingDepth,
    DEFAULT_TASK_SETTINGS.maxTaskNestingDepth,
    TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min,
    TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max
  );

  const proposePlanImplementReplacesChatHistory =
    typeof record.proposePlanImplementReplacesChatHistory === "boolean"
      ? record.proposePlanImplementReplacesChatHistory
      : (DEFAULT_TASK_SETTINGS.proposePlanImplementReplacesChatHistory ?? false);

  // Legacy compatibility field: modern user-owned sub-agents always persist until explicit remove.
  // Keep writing true so older builds choose their most conservative retention behavior.
  const preserveSubagentsUntilArchive = true;

  const result: TaskSettings = {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
    proposePlanImplementReplacesChatHistory,
    preserveSubagentsUntilArchive,
  };

  assert(
    Number.isInteger(maxParallelAgentTasks),
    "normalizeTaskSettings: maxParallelAgentTasks must be an integer"
  );
  assert(
    Number.isInteger(maxTaskNestingDepth),
    "normalizeTaskSettings: maxTaskNestingDepth must be an integer"
  );

  assert(
    typeof proposePlanImplementReplacesChatHistory === "boolean",
    "normalizeTaskSettings: proposePlanImplementReplacesChatHistory must be a boolean"
  );
  assert(
    typeof preserveSubagentsUntilArchive === "boolean",
    "normalizeTaskSettings: preserveSubagentsUntilArchive must be a boolean"
  );

  return result;
}
