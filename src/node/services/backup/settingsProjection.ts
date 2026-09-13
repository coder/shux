import { z } from "zod";
import { AppConfigOnDiskSchema } from "@/common/config/schemas/appConfigOnDisk";
import type { ProjectsConfig } from "@/common/types/project";
import { normalizeTaskSettings } from "@/common/types/tasks";
import { isLayoutPresetsConfigEmpty, normalizeLayoutPresetsConfig } from "@/common/types/uiLayouts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { normalizeGoalDefaults } from "@/constants/goals";

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
 * - save-time projections and internal state: subagentAiDefaults, deleteWorktreeOnArchive,
 *   stopCoderWorkspaceOnArchive, preferredCompactionModel (unused), projects (the project
 *   bundle), viewedSplashScreens, migrations, writeId, settingsBackup, onePasswordAccountName.
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
  "coderWorkspaceArchiveBehavior",
  "worktreeArchiveBehavior",
  "runtimeEnablement",
  "defaultRuntime",
  "layoutPresets",
] as const satisfies ReadonlyArray<keyof ProjectsConfig & keyof typeof AppConfigOnDiskSchema.shape>;

type BackedUpSettingsKey = (typeof BACKED_UP_SETTINGS_KEYS)[number];

const pickMask = Object.fromEntries(BACKED_UP_SETTINGS_KEYS.map((key) => [key, true])) as Record<
  BackedUpSettingsKey,
  true
>;

/**
 * Rewrapped in a plain z.object because `pick` inherits the on-disk schema's passthrough, which
 * would carry any key of a repository-controlled document into the config.
 */
export const BackupSettingsSchema = z.object(AppConfigOnDiskSchema.pick(pickMask).shape);

export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function projectBackupSettings(config: ProjectsConfig): BackupSettings {
  const picked: Partial<Record<BackedUpSettingsKey, unknown>> = {};
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    if (config[key] !== undefined) picked[key] = config[key];
  }
  // Mirrors what a saved config loads back as, so a fresh install's first export, the export
  // after its first save, and the post-restore check agree: goalDefaults always resolves to the
  // effective defaults; an empty agent map, empty layouts, and a false full-width flag are absent.
  picked.goalDefaults = normalizeGoalDefaults(config.goalDefaults);
  if (config.agentAiDefaults !== undefined && Object.keys(config.agentAiDefaults).length === 0) {
    delete picked.agentAiDefaults;
  }
  if (config.layoutPresets !== undefined) {
    const layoutPresets = normalizeLayoutPresetsConfig(config.layoutPresets);
    if (isLayoutPresetsConfigEmpty(layoutPresets)) delete picked.layoutPresets;
    else picked.layoutPresets = layoutPresets;
  }
  if (config.chatTranscriptFullWidth !== true) delete picked.chatTranscriptFullWidth;
  return BackupSettingsSchema.parse(copyJson(picked));
}

/**
 * Throws on a malformed `settings` block so the payload readers reject the backup before a
 * restore writes anything.
 */
export function readBackupSettings(document: unknown): BackupSettings | undefined {
  if (!isPlainObject(document) || document.settings === undefined) return undefined;
  const parsed = BackupSettingsSchema.safeParse(document.settings);
  if (parsed.success) return parsed.data;
  // The message reaches the Backup screen, so name the offending fields instead of dumping
  // the raw issue list.
  const issues = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "settings"}: ${issue.message}`);
  throw new Error(`Backup preferences.json has an invalid settings block (${issues.join("; ")})`);
}

/**
 * Each key the backup carries replaces the local value wholesale; absent keys keep the local
 * value, which is how machine-local settings survive a restore.
 */
export function mergeBackupSettings(
  current: ProjectsConfig,
  settings: BackupSettings
): ProjectsConfig {
  const { layoutPresets, taskSettings, ...rest } = settings;
  const merged: ProjectsConfig = { ...current, ...rest };
  if (taskSettings !== undefined) {
    merged.taskSettings = normalizeTaskSettings(taskSettings);
  }
  if (layoutPresets !== undefined) {
    merged.layoutPresets = normalizeLayoutPresetsConfig(layoutPresets);
  }
  if (settings.hiddenModels !== undefined) {
    // As Config.updateModelPreferences does: the restored list is now the user's, so the
    // default seeding must not claim it.
    merged.migrations = { ...current.migrations, hiddenModelsInitialized: true };
  }
  return merged;
}
