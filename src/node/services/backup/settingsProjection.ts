import { z } from "zod";
import { AppConfigOnDiskSchema, GoalDefaultsSchema } from "@/common/config/schemas/appConfigOnDisk";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ProjectsConfig } from "@/common/types/project";
import { normalizeTaskSettings } from "@/common/types/tasks";
import { coerceOpenAIReasoningMode, coerceThinkingLevel } from "@/common/types/thinking";
import { isLayoutPresetsConfigEmpty, normalizeLayoutPresetsConfig } from "@/common/types/uiLayouts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { normalizeGoalDefaults } from "@/constants/goals";
import {
  normalizeAiDefaultsModelStrings,
  normalizeMinThinkingLevelByModel,
  normalizeModelFallbacks,
  normalizeOptionalModelString,
  normalizeOptionalModelStringArray,
  normalizeRuntimeEnablementId,
  normalizeRuntimeEnablementOverrides,
  parseOptionalHeartbeatIntervalMs,
  parseOptionalNonEmptyString,
  parseOptionalPositiveInteger,
} from "@/node/config";

/**
 * The top-level config.json settings a backup carries. Everything else stays local, so an
 * addition fails closed until it is listed here:
 * - bound to the machine or its network: apiServerBindHost, apiServerPort, apiServerServeWebUi,
 *   mdnsAdvertisementEnabled, mdnsServiceName, serverSshHost, serverAuthGithubOwner,
 *   defaultProjectDir, terminalDefaultShell, updateChannel, useSSH2Transport;
 * - secrets and enrollment: muxGovernorUrl, muxGovernorToken;
 * - derived from providers.jsonc credentials, which are never exported (see
 *   providerService.syncGatewayLifecycleEffect): routePriority, routeOverrides, and the legacy
 *   muxGatewayEnabled and muxGatewayModels;
 * - destructive archive policies: coderWorkspaceArchiveBehavior and worktreeArchiveBehavior
 *   (with their legacy deleteWorktreeOnArchive and stopCoderWorkspaceOnArchive spellings). A
 *   repository-controlled "delete" would make every later archive remove worktrees and Coder
 *   workspaces, and unpushed work with them, with no prompt naming the policy;
 * - save-time projections and internal state: subagentAiDefaults, preferredCompactionModel
 *   (unused), projects (the project bundle), viewedSplashScreens, migrations, writeId,
 *   settingsBackup, onePasswordAccountName.
 * userPreferences has its own projection, projectBackupPreferences.
 */
const BACKED_UP_SETTINGS_KEYS = [
  "agentAiDefaults",
  "defaultModel",
  "hiddenModels",
  "minThinkingLevelByModel",
  "modelFallbacks",
  "advisorModelString",
  "advisorThinkingLevel",
  "advisorReasoningMode",
  "advisorMaxUsesPerTurn",
  "advisorMaxOutputTokens",
  "taskSettings",
  "heartbeatDefaultPrompt",
  "heartbeatDefaultIntervalMs",
  "goalDefaults",
  "chatTranscriptFullWidth",
  "llmDebugLogs",
  "runtimeEnablement",
  "defaultRuntime",
  "layoutPresets",
] as const satisfies ReadonlyArray<keyof ProjectsConfig & keyof typeof AppConfigOnDiskSchema.shape>;

type BackedUpSettingsKey = (typeof BACKED_UP_SETTINGS_KEYS)[number];

/**
 * A backup's settings block. Every key an export writes is present, so a value the user reset
 * to its default (cleared agent overrides, deleted fallback chains) round-trips as that default
 * rather than as a gap the restore would fill from the target. `null` is the JSON spelling of
 * an unset value; a key that is absent, as in a block an older build wrote, keeps the local value.
 */
export type BackupSettings = {
  [K in BackedUpSettingsKey]?: NonNullable<ProjectsConfig[K]> | null;
};

export interface BackupSettingsRead {
  /** The keys this build can apply; undefined when the document carries no settings block. */
  settings: BackupSettings | undefined;
  /**
   * Keys whose values fail this build's schema, so a restore keeps the local value: a newer
   * build's export (a thinking level or runtime this build predates) or a damaged document.
   * Reported rather than failing the restore, which would strand every other backed-up file
   * behind an upgrade.
   */
  unsupported: string[];
}

/**
 * The canonical in-memory value of each setting, using the same normalization Config applies
 * on save and load. Export, read, merge, and the post-write check all go through this table, so
 * a schema-valid but non-canonical document (a padded model string, an unsanitized fallback
 * chain) compares equal to what config.json holds after the write. Unset resolves to what a
 * loaded config holds when the key is absent: `undefined` for optional settings, the default
 * for settings load always fills in.
 */
const NORMALIZE: { [K in BackedUpSettingsKey]: (value: unknown) => ProjectsConfig[K] } = {
  agentAiDefaults: (value) => normalizeAiDefaultsModelStrings(normalizeAgentAiDefaults(value)),
  defaultModel: normalizeOptionalModelString,
  hiddenModels: normalizeOptionalModelStringArray,
  minThinkingLevelByModel: normalizeMinThinkingLevelByModel,
  modelFallbacks: normalizeModelFallbacks,
  advisorModelString: parseOptionalNonEmptyString,
  advisorThinkingLevel: coerceThinkingLevel,
  advisorReasoningMode: coerceOpenAIReasoningMode,
  // null is how config.json spells an explicit "unlimited" cap and is kept as written.
  advisorMaxUsesPerTurn: (value) => (value === null ? null : parseOptionalPositiveInteger(value)),
  advisorMaxOutputTokens: (value) => (value === null ? null : parseOptionalPositiveInteger(value)),
  taskSettings: normalizeTaskSettings,
  heartbeatDefaultPrompt: parseOptionalNonEmptyString,
  heartbeatDefaultIntervalMs: parseOptionalHeartbeatIntervalMs,
  goalDefaults: (value) => normalizeGoalDefaults(GoalDefaultsSchema.safeParse(value).data),
  chatTranscriptFullWidth: (value) => value === true,
  llmDebugLogs: (value) => value === true,
  runtimeEnablement: normalizeRuntimeEnablementOverrides,
  defaultRuntime: normalizeRuntimeEnablementId,
  layoutPresets: (value) => {
    const normalized = normalizeLayoutPresetsConfig(value);
    return isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized;
  },
};

/**
 * The on-disk schema leaves layoutPresets unknown and its normalizer reads a version it does not
 * know as an empty config, which a restore would turn into deleting the target's presets. Pin
 * the versions this build migrates so a newer document is reported as unsupported instead.
 */
const LAYOUT_PRESETS_SCHEMA = z
  .object({ version: z.union([z.literal(1), z.literal(2)]) })
  .passthrough();

/**
 * Per-key schemas rather than one picked object: the on-disk schema is passthrough, which would
 * carry any key of a repository-controlled document into the config, and each key accepts null.
 */
function fieldSchema(key: BackedUpSettingsKey): z.ZodType {
  const schema = key === "layoutPresets" ? LAYOUT_PRESETS_SCHEMA : AppConfigOnDiskSchema.shape[key];
  return schema.nullable();
}

function setSetting<K extends BackedUpSettingsKey>(
  target: BackupSettings,
  key: K,
  value: ProjectsConfig[K]
): void {
  target[key] = (value ?? null) as BackupSettings[K];
}

function assignSetting<K extends BackedUpSettingsKey>(
  target: ProjectsConfig,
  key: K,
  value: unknown
): void {
  target[key] = NORMALIZE[key](value);
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function projectBackupSettings(config: ProjectsConfig): BackupSettings {
  const projected: BackupSettings = {};
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    setSetting(projected, key, NORMALIZE[key](config[key]));
  }
  return copyJson(projected);
}

/** Reads and canonicalizes the `settings` block of a preferences document. */
export function readBackupSettings(document: unknown): BackupSettingsRead {
  if (!isPlainObject(document) || document.settings === undefined) {
    return { settings: undefined, unsupported: [] };
  }
  const block = document.settings;
  if (!isPlainObject(block)) {
    return { settings: undefined, unsupported: ["settings (not an object)"] };
  }
  const settings: BackupSettings = {};
  const unsupported: string[] = [];
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    if (!(key in block)) continue;
    const parsed = fieldSchema(key).safeParse(block[key]);
    if (parsed.success) {
      setSetting(settings, key, NORMALIZE[key](parsed.data));
    } else {
      unsupported.push(key);
    }
  }
  return { settings, unsupported };
}

/** Each key the block carries replaces the local value; keys it lacks keep the local value. */
export function mergeBackupSettings(
  current: ProjectsConfig,
  settings: BackupSettings
): ProjectsConfig {
  const merged: ProjectsConfig = { ...current };
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    if (key in settings) assignSetting(merged, key, settings[key]);
  }
  if (settings.hiddenModels != null) {
    // As Config.updateModelPreferences does: the restored list is now the user's, so the
    // default seeding must not claim it.
    merged.migrations = { ...current.migrations, hiddenModelsInitialized: true };
  }
  return merged;
}
