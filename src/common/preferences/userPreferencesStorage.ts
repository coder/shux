import {
  LaunchBehaviorSchema,
  parseThemePreference,
  pruneUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_STORAGE_MAX,
} from "@/common/constants/ui";
import {
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  BASH_COLLAPSED_SUMMARY_MODES,
  EDITOR_CONFIG_KEY,
  GLOBAL_SCOPE_ID,
  LAUNCH_BEHAVIOR_KEY,
  PROJECT_ORDER_KEY,
  PROVIDER_OPTIONS_ANTHROPIC_KEY,
  PROVIDER_OPTIONS_GOOGLE_KEY,
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  TERMINAL_BADGE_CONFIG_KEY,
  TERMINAL_FONT_CONFIG_KEY,
  TRANSCRIPT_DENSITIES,
  TRANSCRIPT_DENSITY_KEY,
  UI_THEME_KEY,
  VIM_ENABLED_KEY,
  getAgentIdKey,
  getAutoCompactionThresholdKey,
  getLastRuntimeConfigKey,
  getModelKey,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getProjectScopeId,
  getReviewDefaultBaseKey,
  getThinkingLevelKey,
  getTrunkBranchKey,
  normalizeEditorConfig,
  normalizeTerminalBadgeConfig,
  normalizeTerminalFontConfig,
  type BashCollapsedSummaryMode,
  type LaunchBehavior,
  type TranscriptDensity,
} from "@/common/constants/storage";
import { MuxProviderOptionsSchema } from "@/common/schemas/providerOptions";
import {
  isRecord,
  parseAgentId,
  parseBoolean,
  parseEnum,
  parseModelString,
  parseNonEmptyString,
  parseRecord,
  parseStringArray,
  parseThinkingLevel,
} from "@/common/preferences/userPreferenceParsing";

export interface UserPreferenceStorageArea {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface StoredUserPreferenceEntry {
  key: string;
  value: unknown;
}

const PROJECT_SCOPE_PREFIX = "__project__/";
const STATIC_USER_PREFERENCE_KEYS = new Set<string>([
  UI_THEME_KEY,
  TRANSCRIPT_DENSITY_KEY,
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  TERMINAL_BADGE_CONFIG_KEY,
  TERMINAL_FONT_CONFIG_KEY,
  EDITOR_CONFIG_KEY,
  VIM_ENABLED_KEY,
  LAUNCH_BEHAVIOR_KEY,
  PROJECT_ORDER_KEY,
  PROVIDER_OPTIONS_ANTHROPIC_KEY,
  PROVIDER_OPTIONS_GOOGLE_KEY,
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  getAgentIdKey(GLOBAL_SCOPE_ID),
  getThinkingLevelKey(GLOBAL_SCOPE_ID),
]);

const DYNAMIC_USER_PREFERENCE_PREFIXES = [
  getAgentIdKey(PROJECT_SCOPE_PREFIX),
  getModelKey(PROJECT_SCOPE_PREFIX),
  getThinkingLevelKey(PROJECT_SCOPE_PREFIX),
  getAutoCompactionThresholdKey(""),
  getTrunkBranchKey(""),
  getLastRuntimeConfigKey(""),
  getNotifyOnResponseAutoEnableKey(""),
  getNotifyOnResponseKey(""),
  getReviewDefaultBaseKey(""),
] as const;

function cloneUserPreferences(preferences: UserPreferences | undefined): UserPreferences {
  return preferences ? (JSON.parse(JSON.stringify(preferences)) as UserPreferences) : {};
}

function parseStoredValue(raw: string | null): unknown {
  if (raw === null || raw === "undefined") {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseLaunchBehavior(value: unknown): LaunchBehavior | undefined {
  return parseEnum<LaunchBehavior>(LaunchBehaviorSchema.options, value);
}

function parseThreshold(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= AUTO_COMPACTION_THRESHOLD_MIN &&
    value <= AUTO_COMPACTION_THRESHOLD_STORAGE_MAX
    ? value
    : undefined;
}

function parseProjectScope(key: string, prefix: string): string | undefined {
  if (!key.startsWith(prefix)) {
    return undefined;
  }

  const scopeId = key.slice(prefix.length);
  return scopeId.startsWith(PROJECT_SCOPE_PREFIX) && scopeId.length > PROJECT_SCOPE_PREFIX.length
    ? scopeId.slice(PROJECT_SCOPE_PREFIX.length)
    : undefined;
}

function readSuffix(key: string, prefix: string): string | undefined {
  if (!key.startsWith(prefix)) {
    return undefined;
  }

  const suffix = key.slice(prefix.length);
  return suffix.length > 0 ? suffix : undefined;
}

function getPreferenceKind(key: string): string | undefined {
  if (STATIC_USER_PREFERENCE_KEYS.has(key)) {
    return key;
  }

  return DYNAMIC_USER_PREFERENCE_PREFIXES.find((prefix) => key.startsWith(prefix));
}

export function isUserPreferenceStorageKey(key: string): boolean {
  return getPreferenceKind(key) !== undefined;
}

function ensureAppearance(
  preferences: UserPreferences
): NonNullable<UserPreferences["appearance"]> {
  preferences.appearance ??= {};
  return preferences.appearance;
}

function ensureNavigation(
  preferences: UserPreferences
): NonNullable<UserPreferences["navigation"]> {
  preferences.navigation ??= {};
  return preferences.navigation;
}

function ensureAi(preferences: UserPreferences): NonNullable<UserPreferences["ai"]> {
  preferences.ai ??= {};
  return preferences.ai;
}

function ensureGlobalAiDefaults(
  preferences: UserPreferences
): NonNullable<NonNullable<UserPreferences["ai"]>["globalDefaults"]> {
  const ai = ensureAi(preferences);
  ai.globalDefaults ??= {};
  return ai.globalDefaults;
}

function ensureProjectAiDefaults(
  preferences: UserPreferences,
  projectPath: string
): NonNullable<NonNullable<UserPreferences["ai"]>["projectDefaults"]>[string] {
  const ai = ensureAi(preferences);
  ai.projectDefaults ??= {};
  ai.projectDefaults[projectPath] ??= {};
  return ai.projectDefaults[projectPath];
}

function ensureProviderOptions(
  preferences: UserPreferences
): NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]> {
  const ai = ensureAi(preferences);
  ai.providerOptions ??= {};
  return ai.providerOptions;
}

function ensureWorkspaceCreationProject(
  preferences: UserPreferences,
  projectPath: string
): NonNullable<NonNullable<UserPreferences["workspaceCreation"]>["byProject"]>[string] {
  preferences.workspaceCreation ??= {};
  preferences.workspaceCreation.byProject ??= {};
  preferences.workspaceCreation.byProject[projectPath] ??= {};
  return preferences.workspaceCreation.byProject[projectPath];
}

function ensureNotifications(
  preferences: UserPreferences
): NonNullable<UserPreferences["notifications"]> {
  preferences.notifications ??= {};
  return preferences.notifications;
}

function ensureReview(preferences: UserPreferences): NonNullable<UserPreferences["review"]> {
  preferences.review ??= {};
  return preferences.review;
}

export function applyStoredUserPreference(
  preferences: UserPreferences | undefined,
  key: string,
  value: unknown
): UserPreferences | undefined {
  const next = cloneUserPreferences(preferences);

  if (key === UI_THEME_KEY) {
    const parsed = parseThemePreference(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).theme = parsed;
    return pruneUserPreferences(next);
  }

  if (key === TRANSCRIPT_DENSITY_KEY) {
    const parsed = parseEnum<TranscriptDensity>(TRANSCRIPT_DENSITIES, value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).transcriptDensity = parsed;
    return pruneUserPreferences(next);
  }

  if (key === BASH_COLLAPSED_SUMMARY_MODE_KEY) {
    const parsed = parseEnum<BashCollapsedSummaryMode>(BASH_COLLAPSED_SUMMARY_MODES, value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).bashCollapsedSummaryMode = parsed;
    return pruneUserPreferences(next);
  }

  if (key === TERMINAL_FONT_CONFIG_KEY) {
    if (!isRecord(value)) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).terminalFontConfig = normalizeTerminalFontConfig(value);
    return pruneUserPreferences(next);
  }

  if (key === TERMINAL_BADGE_CONFIG_KEY) {
    if (!isRecord(value)) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).terminalBadgeConfig = normalizeTerminalBadgeConfig(value);
    return pruneUserPreferences(next);
  }

  if (key === EDITOR_CONFIG_KEY) {
    if (!isRecord(value)) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).editorConfig = normalizeEditorConfig(value);
    return pruneUserPreferences(next);
  }

  if (key === VIM_ENABLED_KEY) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    ensureAppearance(next).vimEnabled = parsed;
    return pruneUserPreferences(next);
  }

  if (key === LAUNCH_BEHAVIOR_KEY) {
    const parsed = parseLaunchBehavior(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureNavigation(next).launchBehavior = parsed;
    return pruneUserPreferences(next);
  }

  if (key === PROJECT_ORDER_KEY) {
    const parsed = parseStringArray(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureNavigation(next).projectOrder = parsed;
    return pruneUserPreferences(next);
  }

  if (key === getAgentIdKey(GLOBAL_SCOPE_ID)) {
    const parsed = parseAgentId(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureGlobalAiDefaults(next).agentId = parsed;
    return pruneUserPreferences(next);
  }

  if (key === getThinkingLevelKey(GLOBAL_SCOPE_ID)) {
    const parsed = parseThinkingLevel(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureGlobalAiDefaults(next).thinkingLevel = parsed;
    return pruneUserPreferences(next);
  }

  const projectAgentPath = parseProjectScope(key, "agentId:");
  if (projectAgentPath) {
    const parsed = parseAgentId(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureProjectAiDefaults(next, projectAgentPath).agentId = parsed;
    return pruneUserPreferences(next);
  }

  const projectModelPath = parseProjectScope(key, "model:");
  if (projectModelPath) {
    const parsed = parseModelString(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureProjectAiDefaults(next, projectModelPath).model = parsed;
    return pruneUserPreferences(next);
  }

  const projectThinkingPath = parseProjectScope(key, "thinkingLevel:");
  if (projectThinkingPath) {
    const parsed = parseThinkingLevel(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureProjectAiDefaults(next, projectThinkingPath).thinkingLevel = parsed;
    return pruneUserPreferences(next);
  }

  if (key === PROVIDER_OPTIONS_ANTHROPIC_KEY) {
    const parsed = MuxProviderOptionsSchema.shape.anthropic.safeParse(value);
    if (!parsed.success || !parsed.data || Object.keys(parsed.data).length === 0) {
      return removeStoredUserPreference(next, key);
    }
    ensureProviderOptions(next).anthropic = parsed.data;
    return pruneUserPreferences(next);
  }

  if (key === PROVIDER_OPTIONS_GOOGLE_KEY) {
    const parsed = MuxProviderOptionsSchema.shape.google.safeParse(value);
    if (!parsed.success || !parsed.data || Object.keys(parsed.data).length === 0) {
      return removeStoredUserPreference(next, key);
    }
    ensureProviderOptions(next).google = parsed.data;
    return pruneUserPreferences(next);
  }

  const thresholdModel = readSuffix(key, getAutoCompactionThresholdKey(""));
  if (thresholdModel) {
    const parsed = parseThreshold(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    const ai = ensureAi(next);
    ai.autoCompactionThresholdByModel ??= {};
    ai.autoCompactionThresholdByModel[thresholdModel] = parsed;
    return pruneUserPreferences(next);
  }

  const trunkProjectPath = readSuffix(key, getTrunkBranchKey(""));
  if (trunkProjectPath) {
    const parsed = parseNonEmptyString(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureWorkspaceCreationProject(next, trunkProjectPath).trunkBranch = parsed;
    return pruneUserPreferences(next);
  }

  const runtimeProjectPath = readSuffix(key, getLastRuntimeConfigKey(""));
  if (runtimeProjectPath) {
    const parsed = parseRecord(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    ensureWorkspaceCreationProject(next, runtimeProjectPath).lastRuntimeConfig = parsed;
    return pruneUserPreferences(next);
  }

  const autoNotifyProjectPath = readSuffix(key, getNotifyOnResponseAutoEnableKey(""));
  if (autoNotifyProjectPath) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    ensureWorkspaceCreationProject(next, autoNotifyProjectPath).notifyOnResponseAutoEnable = parsed;
    return pruneUserPreferences(next);
  }

  const notifyWorkspaceId = readSuffix(key, getNotifyOnResponseKey(""));
  if (notifyWorkspaceId) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    const notifications = ensureNotifications(next);
    notifications.notifyOnResponseByWorkspace ??= {};
    notifications.notifyOnResponseByWorkspace[notifyWorkspaceId] = parsed;
    return pruneUserPreferences(next);
  }

  if (key === REVIEW_INCLUDE_UNCOMMITTED_KEY) {
    const parsed = parseBoolean(value);
    if (parsed === undefined) {
      return removeStoredUserPreference(next, key);
    }
    ensureReview(next).includeUncommitted = parsed;
    return pruneUserPreferences(next);
  }

  const reviewDefaultProjectPath = readSuffix(key, getReviewDefaultBaseKey(""));
  if (reviewDefaultProjectPath) {
    const parsed = parseNonEmptyString(value);
    if (!parsed) {
      return removeStoredUserPreference(next, key);
    }
    const review = ensureReview(next);
    review.defaultBaseByProject ??= {};
    review.defaultBaseByProject[reviewDefaultProjectPath] = parsed;
    return pruneUserPreferences(next);
  }

  return pruneUserPreferences(next);
}

export function removeStoredUserPreference(
  preferences: UserPreferences | undefined,
  key: string
): UserPreferences | undefined {
  const next = cloneUserPreferences(preferences);

  if (key === UI_THEME_KEY) delete next.appearance?.theme;
  else if (key === TRANSCRIPT_DENSITY_KEY) delete next.appearance?.transcriptDensity;
  else if (key === BASH_COLLAPSED_SUMMARY_MODE_KEY)
    delete next.appearance?.bashCollapsedSummaryMode;
  else if (key === TERMINAL_FONT_CONFIG_KEY) delete next.appearance?.terminalFontConfig;
  else if (key === TERMINAL_BADGE_CONFIG_KEY) delete next.appearance?.terminalBadgeConfig;
  else if (key === EDITOR_CONFIG_KEY) delete next.appearance?.editorConfig;
  else if (key === VIM_ENABLED_KEY) delete next.appearance?.vimEnabled;
  else if (key === LAUNCH_BEHAVIOR_KEY) delete next.navigation?.launchBehavior;
  else if (key === PROJECT_ORDER_KEY) delete next.navigation?.projectOrder;
  else if (key === getAgentIdKey(GLOBAL_SCOPE_ID)) delete next.ai?.globalDefaults?.agentId;
  else if (key === getThinkingLevelKey(GLOBAL_SCOPE_ID))
    delete next.ai?.globalDefaults?.thinkingLevel;
  else if (key === PROVIDER_OPTIONS_ANTHROPIC_KEY) delete next.ai?.providerOptions?.anthropic;
  else if (key === PROVIDER_OPTIONS_GOOGLE_KEY) delete next.ai?.providerOptions?.google;
  else if (key === REVIEW_INCLUDE_UNCOMMITTED_KEY) delete next.review?.includeUncommitted;
  else {
    const projectAgentPath = parseProjectScope(key, "agentId:");
    const projectModelPath = parseProjectScope(key, "model:");
    const projectThinkingPath = parseProjectScope(key, "thinkingLevel:");
    const thresholdModel = readSuffix(key, getAutoCompactionThresholdKey(""));
    const trunkProjectPath = readSuffix(key, getTrunkBranchKey(""));
    const runtimeProjectPath = readSuffix(key, getLastRuntimeConfigKey(""));
    const autoNotifyProjectPath = readSuffix(key, getNotifyOnResponseAutoEnableKey(""));
    const notifyWorkspaceId = readSuffix(key, getNotifyOnResponseKey(""));
    const reviewDefaultProjectPath = readSuffix(key, getReviewDefaultBaseKey(""));

    if (projectAgentPath) delete next.ai?.projectDefaults?.[projectAgentPath]?.agentId;
    else if (projectModelPath) delete next.ai?.projectDefaults?.[projectModelPath]?.model;
    else if (projectThinkingPath)
      delete next.ai?.projectDefaults?.[projectThinkingPath]?.thinkingLevel;
    else if (thresholdModel) delete next.ai?.autoCompactionThresholdByModel?.[thresholdModel];
    else if (trunkProjectPath)
      delete next.workspaceCreation?.byProject?.[trunkProjectPath]?.trunkBranch;
    else if (runtimeProjectPath)
      delete next.workspaceCreation?.byProject?.[runtimeProjectPath]?.lastRuntimeConfig;
    else if (autoNotifyProjectPath)
      delete next.workspaceCreation?.byProject?.[autoNotifyProjectPath]?.notifyOnResponseAutoEnable;
    else if (notifyWorkspaceId)
      delete next.notifications?.notifyOnResponseByWorkspace?.[notifyWorkspaceId];
    else if (reviewDefaultProjectPath)
      delete next.review?.defaultBaseByProject?.[reviewDefaultProjectPath];
  }

  return pruneUserPreferences(next);
}

export function entriesFromUserPreferences(
  preferences: UserPreferences | undefined
): StoredUserPreferenceEntry[] {
  const entries: StoredUserPreferenceEntry[] = [];
  if (!preferences) {
    return entries;
  }

  const appearance = preferences.appearance;
  if (appearance?.theme !== undefined) entries.push({ key: UI_THEME_KEY, value: appearance.theme });
  if (appearance?.transcriptDensity !== undefined)
    entries.push({ key: TRANSCRIPT_DENSITY_KEY, value: appearance.transcriptDensity });
  if (appearance?.bashCollapsedSummaryMode !== undefined)
    entries.push({
      key: BASH_COLLAPSED_SUMMARY_MODE_KEY,
      value: appearance.bashCollapsedSummaryMode,
    });
  if (appearance?.terminalFontConfig !== undefined)
    entries.push({ key: TERMINAL_FONT_CONFIG_KEY, value: appearance.terminalFontConfig });
  if (appearance?.terminalBadgeConfig !== undefined)
    entries.push({ key: TERMINAL_BADGE_CONFIG_KEY, value: appearance.terminalBadgeConfig });
  if (appearance?.editorConfig !== undefined)
    entries.push({ key: EDITOR_CONFIG_KEY, value: appearance.editorConfig });
  if (appearance?.vimEnabled !== undefined)
    entries.push({ key: VIM_ENABLED_KEY, value: appearance.vimEnabled });

  const navigation = preferences.navigation;
  if (navigation?.launchBehavior !== undefined)
    entries.push({ key: LAUNCH_BEHAVIOR_KEY, value: navigation.launchBehavior });
  if (navigation?.projectOrder !== undefined)
    entries.push({ key: PROJECT_ORDER_KEY, value: navigation.projectOrder });

  const ai = preferences.ai;
  if (ai?.globalDefaults?.agentId !== undefined)
    entries.push({ key: getAgentIdKey(GLOBAL_SCOPE_ID), value: ai.globalDefaults.agentId });
  if (ai?.globalDefaults?.thinkingLevel !== undefined)
    entries.push({
      key: getThinkingLevelKey(GLOBAL_SCOPE_ID),
      value: ai.globalDefaults.thinkingLevel,
    });

  for (const [projectPath, defaults] of Object.entries(ai?.projectDefaults ?? {})) {
    const scopeId = getProjectScopeId(projectPath);
    if (defaults.agentId !== undefined)
      entries.push({ key: getAgentIdKey(scopeId), value: defaults.agentId });
    if (defaults.model !== undefined)
      entries.push({ key: getModelKey(scopeId), value: defaults.model });
    if (defaults.thinkingLevel !== undefined)
      entries.push({ key: getThinkingLevelKey(scopeId), value: defaults.thinkingLevel });
  }

  if (ai?.providerOptions?.anthropic !== undefined)
    entries.push({ key: PROVIDER_OPTIONS_ANTHROPIC_KEY, value: ai.providerOptions.anthropic });
  if (ai?.providerOptions?.google !== undefined)
    entries.push({ key: PROVIDER_OPTIONS_GOOGLE_KEY, value: ai.providerOptions.google });

  for (const [model, threshold] of Object.entries(ai?.autoCompactionThresholdByModel ?? {})) {
    entries.push({ key: getAutoCompactionThresholdKey(model), value: threshold });
  }

  for (const [projectPath, defaults] of Object.entries(
    preferences.workspaceCreation?.byProject ?? {}
  )) {
    if (defaults.trunkBranch !== undefined)
      entries.push({ key: getTrunkBranchKey(projectPath), value: defaults.trunkBranch });
    if (defaults.lastRuntimeConfig !== undefined)
      entries.push({
        key: getLastRuntimeConfigKey(projectPath),
        value: defaults.lastRuntimeConfig,
      });
    if (defaults.notifyOnResponseAutoEnable !== undefined)
      entries.push({
        key: getNotifyOnResponseAutoEnableKey(projectPath),
        value: defaults.notifyOnResponseAutoEnable,
      });
  }

  for (const [workspaceId, enabled] of Object.entries(
    preferences.notifications?.notifyOnResponseByWorkspace ?? {}
  )) {
    entries.push({ key: getNotifyOnResponseKey(workspaceId), value: enabled });
  }

  if (preferences.review?.includeUncommitted !== undefined)
    entries.push({
      key: REVIEW_INCLUDE_UNCOMMITTED_KEY,
      value: preferences.review.includeUncommitted,
    });
  for (const [projectPath, defaultBase] of Object.entries(
    preferences.review?.defaultBaseByProject ?? {}
  )) {
    entries.push({ key: getReviewDefaultBaseKey(projectPath), value: defaultBase });
  }

  return entries;
}

export function readStoredUserPreferenceValue(
  storage: UserPreferenceStorageArea,
  key: string
): unknown {
  return parseStoredValue(storage.getItem(key));
}

export function getStoredUserPreferenceEntries(
  storage: UserPreferenceStorageArea
): StoredUserPreferenceEntry[] {
  const entries: StoredUserPreferenceEntry[] = [];
  for (const key of getStoredUserPreferenceKeys(storage)) {
    const next = applyStoredUserPreference(undefined, key, parseStoredValue(storage.getItem(key)));
    const entry = entriesFromUserPreferences(next).find((candidate) => candidate.key === key);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export function getStoredUserPreferenceKeys(storage: UserPreferenceStorageArea): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || seen.has(key) || !isUserPreferenceStorageKey(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function hasUserPreferenceEntry(
  preferences: UserPreferences | undefined,
  key: string
): boolean {
  return entriesFromUserPreferences(preferences).some((entry) => entry.key === key);
}
