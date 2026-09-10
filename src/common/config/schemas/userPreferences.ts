import { z } from "zod";

import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_STORAGE_MAX,
} from "@/common/constants/ui";
import {
  BASH_COLLAPSED_SUMMARY_MODES,
  EDITOR_TYPES,
  TERMINAL_BADGE_POSITIONS,
  TRANSCRIPT_DENSITIES,
  normalizeEditorConfig,
  normalizeTerminalBadgeConfig,
  normalizeTerminalFontConfig,
  type BashCollapsedSummaryMode,
  type EditorConfig,
  type LaunchBehavior,
  type TerminalBadgeConfig,
  type TerminalFontConfig,
  type TranscriptDensity,
} from "@/common/constants/storage";
import { MuxProviderOptionsSchema } from "@/common/schemas/providerOptions";
import { ThinkingLevelSchema } from "@/common/types/thinking";
import {
  isRecord,
  parseAgentId,
  parseBoolean,
  parseEnum,
  parseModelString,
  parseNonEmptyString,
  parseStringArray,
  parseThinkingLevel,
} from "@/common/preferences/userPreferenceParsing";

export const ThemePreferenceSchema = z.enum([
  "auto",
  "light",
  "dark",
  "flexoki-light",
  "flexoki-dark",
]);
export type ThemePreferenceConfig = z.infer<typeof ThemePreferenceSchema>;

export const LaunchBehaviorSchema = z.enum(["dashboard", "new-chat", "last-workspace"]);

export const UserPreferencesSchema = z.object({
  appearance: z
    .object({
      theme: ThemePreferenceSchema.optional(),
      transcriptDensity: z.enum(TRANSCRIPT_DENSITIES).optional(),
      bashCollapsedSummaryMode: z.enum(BASH_COLLAPSED_SUMMARY_MODES).optional(),
      terminalFontConfig: z
        .object({
          fontFamily: z.string().min(1),
          fontSize: z.number().positive(),
        })
        .optional(),
      terminalBadgeConfig: z
        .object({
          enabled: z.boolean(),
          template: z.string(),
          position: z.enum(TERMINAL_BADGE_POSITIONS),
          opacity: z.number().min(0).max(1),
          fontSize: z.number().positive(),
        })
        .optional(),
      editorConfig: z
        .object({
          editor: z.enum(EDITOR_TYPES),
          customCommand: z.string().min(1).optional(),
        })
        .optional(),
      vimEnabled: z.boolean().optional(),
    })
    .optional(),
  navigation: z
    .object({
      launchBehavior: LaunchBehaviorSchema.optional(),
      projectOrder: z.array(z.string()).optional(),
    })
    .optional(),
  ai: z
    .object({
      globalDefaults: z
        .object({
          agentId: z.string().min(1).optional(),
          thinkingLevel: ThinkingLevelSchema.optional(),
        })
        .optional(),
      projectDefaults: z
        .record(
          z.string(),
          z.object({
            agentId: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            thinkingLevel: ThinkingLevelSchema.optional(),
          })
        )
        .optional(),
      providerOptions: z
        .object({
          anthropic: MuxProviderOptionsSchema.shape.anthropic,
          google: MuxProviderOptionsSchema.shape.google,
        })
        .optional(),
      autoCompactionThresholdByModel: z
        .record(
          z.string(),
          z.number().min(AUTO_COMPACTION_THRESHOLD_MIN).max(AUTO_COMPACTION_THRESHOLD_STORAGE_MAX)
        )
        .optional(),
    })
    .optional(),
  workspaceCreation: z
    .object({
      byProject: z
        .record(
          z.string(),
          z.object({
            trunkBranch: z.string().min(1).optional(),
            lastRuntimeConfig: z.record(z.string(), z.unknown()).optional(),
            notifyOnResponseAutoEnable: z.boolean().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  notifications: z
    .object({
      notifyOnResponseByWorkspace: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  review: z
    .object({
      includeUncommitted: z.boolean().optional(),
      defaultBaseByProject: z.record(z.string(), z.string().min(1)).optional(),
    })
    .optional(),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export function parseThemePreference(value: unknown): ThemePreferenceConfig | undefined {
  const parsed = ThemePreferenceSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  if (typeof value === "string" && value.endsWith("-light")) {
    return "light";
  }

  if (typeof value === "string" && value.endsWith("-dark")) {
    return "dark";
  }

  return undefined;
}

function parseTerminalFontConfig(value: unknown): TerminalFontConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeTerminalFontConfig(value);
}

function parseTerminalBadgeConfig(value: unknown): TerminalBadgeConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeTerminalBadgeConfig(value);
}

function parseEditorConfig(value: unknown): EditorConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeEditorConfig(value);
}

function parseProviderOptions(
  value: unknown
): NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]> = {};
  const anthropic = MuxProviderOptionsSchema.shape.anthropic.safeParse(value.anthropic);
  if (anthropic.success && anthropic.data && Object.keys(anthropic.data).length > 0) {
    out.anthropic = anthropic.data;
  }

  const google = MuxProviderOptionsSchema.shape.google.safeParse(value.google);
  if (google.success && google.data && Object.keys(google.data).length > 0) {
    out.google = google.data;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLastRuntimeConfig(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.keys(value).length > 0 ? value : undefined;
}

function parseAutoCompactionThresholds(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, number> = {};
  for (const [model, threshold] of Object.entries(value)) {
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < AUTO_COMPACTION_THRESHOLD_MIN ||
      threshold > AUTO_COMPACTION_THRESHOLD_STORAGE_MAX
    ) {
      continue;
    }

    out[model] = threshold;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseProjectDefaults(
  value: unknown
): NonNullable<UserPreferences["ai"]>["projectDefaults"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: NonNullable<NonNullable<UserPreferences["ai"]>["projectDefaults"]> = {};
  for (const [projectPath, rawEntry] of Object.entries(value)) {
    if (!isRecord(rawEntry)) {
      continue;
    }

    const entry: NonNullable<NonNullable<UserPreferences["ai"]>["projectDefaults"]>[string] = {};
    const agentId = parseAgentId(rawEntry.agentId);
    if (agentId) {
      entry.agentId = agentId;
    }

    const model = parseModelString(rawEntry.model);
    if (model) {
      entry.model = model;
    }

    const thinkingLevel = parseThinkingLevel(rawEntry.thinkingLevel);
    if (thinkingLevel) {
      entry.thinkingLevel = thinkingLevel;
    }

    if (Object.keys(entry).length > 0) {
      out[projectPath] = entry;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseWorkspaceCreationByProject(
  value: unknown
): NonNullable<UserPreferences["workspaceCreation"]>["byProject"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: NonNullable<NonNullable<UserPreferences["workspaceCreation"]>["byProject"]> = {};
  for (const [projectPath, rawEntry] of Object.entries(value)) {
    if (!isRecord(rawEntry)) {
      continue;
    }

    const entry: NonNullable<
      NonNullable<UserPreferences["workspaceCreation"]>["byProject"]
    >[string] = {};
    const trunkBranch = parseNonEmptyString(rawEntry.trunkBranch);
    if (trunkBranch) {
      entry.trunkBranch = trunkBranch;
    }

    const lastRuntimeConfig = parseLastRuntimeConfig(rawEntry.lastRuntimeConfig);
    if (lastRuntimeConfig) {
      entry.lastRuntimeConfig = lastRuntimeConfig;
    }

    const autoEnable = parseBoolean(rawEntry.notifyOnResponseAutoEnable);
    if (autoEnable !== undefined) {
      entry.notifyOnResponseAutoEnable = autoEnable;
    }

    if (Object.keys(entry).length > 0) {
      out[projectPath] = entry;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseBooleanRecord(value: unknown): Record<string, boolean> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, boolean> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "boolean") {
      out[key] = rawValue;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const parsed = parseNonEmptyString(rawValue);
    if (parsed) {
      out[key] = parsed;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneEmpty(child);
    if (pruned !== undefined) {
      out[key] = pruned;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function pruneUserPreferences(
  value: UserPreferences | undefined
): UserPreferences | undefined {
  const pruned = pruneEmpty(value);
  return isRecord(pruned) ? (pruned as UserPreferences) : undefined;
}

export function normalizeUserPreferences(value: unknown): UserPreferences | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const preferences: UserPreferences = {};

  if (isRecord(value.appearance)) {
    const appearance: NonNullable<UserPreferences["appearance"]> = {};
    const theme = parseThemePreference(value.appearance.theme);
    if (theme) {
      appearance.theme = theme;
    }

    const transcriptDensity = parseEnum<TranscriptDensity>(
      TRANSCRIPT_DENSITIES,
      value.appearance.transcriptDensity
    );
    if (transcriptDensity) {
      appearance.transcriptDensity = transcriptDensity;
    }

    const bashMode = parseEnum<BashCollapsedSummaryMode>(
      BASH_COLLAPSED_SUMMARY_MODES,
      value.appearance.bashCollapsedSummaryMode
    );
    if (bashMode) {
      appearance.bashCollapsedSummaryMode = bashMode;
    }

    const terminalFontConfig = parseTerminalFontConfig(value.appearance.terminalFontConfig);
    if (terminalFontConfig) {
      appearance.terminalFontConfig = terminalFontConfig;
    }

    const terminalBadgeConfig = parseTerminalBadgeConfig(value.appearance.terminalBadgeConfig);
    if (terminalBadgeConfig) {
      appearance.terminalBadgeConfig = terminalBadgeConfig;
    }

    const editorConfig = parseEditorConfig(value.appearance.editorConfig);
    if (editorConfig) {
      appearance.editorConfig = editorConfig;
    }

    const vimEnabled = parseBoolean(value.appearance.vimEnabled);
    if (vimEnabled !== undefined) {
      appearance.vimEnabled = vimEnabled;
    }

    preferences.appearance = appearance;
  }

  if (isRecord(value.navigation)) {
    const navigation: NonNullable<UserPreferences["navigation"]> = {};
    const launchBehavior = parseEnum<LaunchBehavior>(
      LaunchBehaviorSchema.options,
      value.navigation.launchBehavior
    );
    if (launchBehavior) {
      navigation.launchBehavior = launchBehavior;
    }

    const projectOrder = parseStringArray(value.navigation.projectOrder);
    if (projectOrder) {
      navigation.projectOrder = projectOrder;
    }

    preferences.navigation = navigation;
  }

  if (isRecord(value.ai)) {
    const ai: NonNullable<UserPreferences["ai"]> = {};
    if (isRecord(value.ai.globalDefaults)) {
      const globalDefaults: NonNullable<NonNullable<UserPreferences["ai"]>["globalDefaults"]> = {};
      const agentId = parseAgentId(value.ai.globalDefaults.agentId);
      if (agentId) {
        globalDefaults.agentId = agentId;
      }

      const thinkingLevel = parseThinkingLevel(value.ai.globalDefaults.thinkingLevel);
      if (thinkingLevel) {
        globalDefaults.thinkingLevel = thinkingLevel;
      }

      ai.globalDefaults = globalDefaults;
    }

    ai.projectDefaults = parseProjectDefaults(value.ai.projectDefaults);
    ai.providerOptions = parseProviderOptions(value.ai.providerOptions);
    ai.autoCompactionThresholdByModel = parseAutoCompactionThresholds(
      value.ai.autoCompactionThresholdByModel
    );
    preferences.ai = ai;
  }

  if (isRecord(value.workspaceCreation)) {
    const workspaceCreation: NonNullable<UserPreferences["workspaceCreation"]> = {};
    workspaceCreation.byProject = parseWorkspaceCreationByProject(
      value.workspaceCreation.byProject
    );
    preferences.workspaceCreation = workspaceCreation;
  }

  if (isRecord(value.notifications)) {
    const notifications: NonNullable<UserPreferences["notifications"]> = {};
    notifications.notifyOnResponseByWorkspace = parseBooleanRecord(
      value.notifications.notifyOnResponseByWorkspace
    );
    preferences.notifications = notifications;
  }

  if (isRecord(value.review)) {
    const review: NonNullable<UserPreferences["review"]> = {};
    const includeUncommitted = parseBoolean(value.review.includeUncommitted);
    if (includeUncommitted !== undefined) {
      review.includeUncommitted = includeUncommitted;
    }

    review.defaultBaseByProject = parseStringRecord(value.review.defaultBaseByProject);
    preferences.review = review;
  }

  return pruneUserPreferences(preferences);
}
