import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import writeFileAtomic from "write-file-atomic";
import { Effect, Semaphore } from "effect";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { log } from "@/node/services/log";
import { ProvidersConfigStore } from "./providersConfigStore";
import { FileLeaseManager } from "./fileLeaseManager";
import { SecretsStore } from "./secretsStore";
import { WorkspaceSessionLocator } from "./sessionLocator";
import type { WorkspaceMetadata, FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Result } from "@/common/types/result";
import assert from "node:assert/strict";
import type {
  Workspace,
  ProjectConfig,
  ProjectsConfig,
  UpdateChannel,
} from "@/common/types/project";
import type {
  AppConfigMigrations,
  AppConfigOnDisk,
  BaseProviderConfig as ProviderConfig,
  ModelFallbacks,
} from "@/common/config/schemas";
import {
  DEFAULT_MODEL_FALLBACKS,
  LEGACY_DEFAULT_MODEL_FALLBACKS,
  sanitizeModelFallbacks,
} from "@/common/utils/ai/modelFallbacks";
import { DEFAULT_TASK_SETTINGS, normalizeTaskSettings } from "@/common/types/tasks";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import { SettingsBackupSchema } from "@/common/config/schemas/settingsBackup";
import {
  isLayoutPresetsConfigEmpty,
  normalizeLayoutPresetsConfig,
  type LayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import {
  deriveLegacySubagentAiDefaultsProjection,
  mergeLegacySubagentAiDefaults,
  normalizeAgentAiDefaults,
} from "@/common/types/agentAiDefaults";
import {
  isWorktreeRuntime,
  normalizeRuntimeEnablement,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import { SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { LEGACY_MUX_PRODUCT_NAME, LEGACY_MUX_PRODUCT_SLUG } from "@/common/compat/legacyMux";
import { XUM_PRODUCT_NAME, XUM_PRODUCT_SLUG } from "@/common/constants/product";
import { DEFAULT_HIDDEN_MODELS } from "@/common/constants/knownModels";
import { GATEWAY_PROVIDERS } from "@/common/constants/providers";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  isCoderWorkspaceArchiveBehavior,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  isWorktreeArchiveBehavior,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";
import { PlatformPaths } from "@/common/utils/paths";
import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  isHeartbeatTrigger,
  isHeartbeatWhenBusy,
  isValidHeartbeatScheduleUpdatedAt,
} from "@/constants/heartbeat";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import {
  isValidModelFormat,
  normalizeSelectedModel,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import { ensurePrivateDirSync } from "@/node/utils/fs";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { isProviderAutoRouteEligible } from "@/node/utils/providerRequirements";
import { getContainerName as getDockerContainerName } from "@/node/runtime/DockerRuntime";
import { deriveProjectHierarchy } from "@/common/utils/subProjects";
import {
  type ProjectRegistrationLockHandle,
  tryProjectRegistrationFileLock,
  withProjectRegistrationFileLock,
} from "@/node/config/projectRegistrationLock";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

// Re-export project/provider types from dedicated schema/types files (for preload usage)
export type { Workspace, ProjectConfig, ProjectsConfig, ProviderConfig };
export { FileLeaseManager } from "./fileLeaseManager";
export { ProvidersConfigStore, type ProvidersConfig } from "./providersConfigStore";
export { SecretsStore } from "./secretsStore";
export { WorkspaceSessionLocator } from "./sessionLocator";

/** True only for fs errors whose errno code is ENOENT (genuinely missing path). */
function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isValidHeartbeatIntervalMs(intervalMs: unknown): intervalMs is number {
  return (
    typeof intervalMs === "number" &&
    Number.isInteger(intervalMs) &&
    intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
    intervalMs <= HEARTBEAT_MAX_INTERVAL_MS
  );
}

function isWorkspaceHeartbeatContextMode(
  value: unknown
): value is NonNullable<NonNullable<WorkspaceMetadata["heartbeat"]>["contextMode"]> {
  return (
    typeof value === "string" &&
    HEARTBEAT_CONTEXT_MODE_VALUES.some((candidate) => candidate === value)
  );
}

function normalizeWorkspaceMetadataHeartbeat(
  heartbeat: Workspace["heartbeat"] | undefined,
  config: ProjectsConfig
): WorkspaceMetadata["heartbeat"] | undefined {
  if (!heartbeat) {
    return undefined;
  }

  const persisted = heartbeat as Partial<NonNullable<Workspace["heartbeat"]>>;
  const defaultIntervalMs = isValidHeartbeatIntervalMs(config.heartbeatDefaultIntervalMs)
    ? config.heartbeatDefaultIntervalMs
    : HEARTBEAT_DEFAULT_INTERVAL_MS;
  const message = typeof persisted.message === "string" ? persisted.message : undefined;
  const contextMode = isWorkspaceHeartbeatContextMode(persisted.contextMode)
    ? persisted.contextMode
    : undefined;
  // Copy schedule fields through so metadata consumers (frontend modal, HeartbeatService's
  // metadata-event handler) see persisted values instead of silently falling back to the
  // read-time defaults. Invalid values are dropped (self-healing), which resolves to the
  // same defaults resolveHeartbeatSchedulePolicy would apply.
  const trigger = isHeartbeatTrigger(persisted.trigger) ? persisted.trigger : undefined;
  const whenBusy = isHeartbeatWhenBusy(persisted.whenBusy) ? persisted.whenBusy : undefined;
  const scheduleUpdatedAt = isValidHeartbeatScheduleUpdatedAt(persisted.scheduleUpdatedAt)
    ? persisted.scheduleUpdatedAt
    : undefined;

  return {
    enabled: persisted.enabled === true,
    intervalMs: isValidHeartbeatIntervalMs(persisted.intervalMs)
      ? persisted.intervalMs
      : defaultIntervalMs,
    ...(message != null ? { message } : {}),
    ...(contextMode != null ? { contextMode } : {}),
    ...(trigger != null ? { trigger } : {}),
    ...(whenBusy != null ? { whenBusy } : {}),
    ...(scheduleUpdatedAt != null ? { scheduleUpdatedAt } : {}),
  };
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

interface LegacyTaskVariantGroup {
  groupId: string;
  index: number;
  total: number;
  kind: "variants";
  label?: string;
}

interface LegacyTaskVariantWorkspace {
  id: string;
  projectPath: string;
  parentWorkspaceId?: string;
  agentId?: string;
  agentType?: string;
  title?: string;
  createdAt?: string;
  taskStatus?: Workspace["taskStatus"];
  bestOf: LegacyTaskVariantGroup;
}

function parseLegacyTaskVariantGroup(value: unknown): LegacyTaskVariantGroup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const groupId = parseOptionalNonEmptyString(record.groupId);
  const label = parseOptionalNonEmptyString(record.label);
  const index = record.index;
  const total = record.total;
  if (
    record.kind !== "variants" ||
    !groupId ||
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(total) ||
    (total as number) < 2 ||
    (index as number) >= (total as number)
  ) {
    return undefined;
  }

  return {
    groupId,
    index: index as number,
    total: total as number,
    kind: "variants",
    ...(label ? { label } : {}),
  };
}

function isLegacyTaskVariantGroup(value: unknown): boolean {
  return parseLegacyTaskVariantGroup(value) != null;
}

function normalizeWorkspaceBestOf(value: unknown): WorkspaceMetadata["bestOf"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  // Variants were coupled to one-off sibling lanes. Persistent sub-agents need stable identities,
  // so legacy variant children intentionally load as ordinary children instead of retaining a
  // grouping that current code can no longer continue coherently.
  if (isLegacyTaskVariantGroup(record)) {
    return undefined;
  }

  const groupId = parseOptionalNonEmptyString(record.groupId);
  const index = record.index;
  const total = record.total;
  if (
    !groupId ||
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(total) ||
    (total as number) < 2 ||
    (index as number) >= (total as number)
  ) {
    return undefined;
  }

  return { groupId, index: index as number, total: total as number };
}

function parseOptionalEnvBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}
function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseUpdateChannel(value: unknown): UpdateChannel | undefined {
  if (value === "stable" || value === "nightly") {
    return value;
  }

  return undefined;
}

function parseCoderWorkspaceArchiveBehavior(
  value: unknown
): CoderWorkspaceArchiveBehavior | undefined {
  return isCoderWorkspaceArchiveBehavior(value) ? value : undefined;
}

function parseWorktreeArchiveBehavior(value: unknown): WorktreeArchiveBehavior | undefined {
  return isWorktreeArchiveBehavior(value) ? value : undefined;
}

function resolveDeleteWorktreeOnArchive(deleteWorktreeOnArchive: unknown): boolean {
  return parseOptionalBoolean(deleteWorktreeOnArchive) ?? false;
}

function resolveWorktreeArchiveBehavior(
  worktreeArchiveBehavior: unknown,
  deleteWorktreeOnArchive: unknown
): WorktreeArchiveBehavior {
  const parsedBehavior = parseWorktreeArchiveBehavior(worktreeArchiveBehavior);
  if (parsedBehavior !== undefined) {
    return parsedBehavior;
  }

  return resolveDeleteWorktreeOnArchive(deleteWorktreeOnArchive)
    ? "delete"
    : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
}

function getLegacyDeleteWorktreeOnArchiveValue(
  worktreeArchiveBehavior: WorktreeArchiveBehavior
): boolean {
  return worktreeArchiveBehavior === "delete";
}

function resolveWorktreeArchiveBehaviorForSave(
  config: Pick<ProjectsConfig, "worktreeArchiveBehavior" | "deleteWorktreeOnArchive">
): WorktreeArchiveBehavior {
  const parsedBehavior = parseWorktreeArchiveBehavior(config.worktreeArchiveBehavior);
  if (parsedBehavior != null) {
    return parsedBehavior;
  }

  return resolveDeleteWorktreeOnArchive(config.deleteWorktreeOnArchive)
    ? "delete"
    : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
}

function resolveCoderWorkspaceArchiveBehavior(
  coderWorkspaceArchiveBehavior: unknown,
  stopCoderWorkspaceOnArchive: unknown
): CoderWorkspaceArchiveBehavior {
  const parsedBehavior = parseCoderWorkspaceArchiveBehavior(coderWorkspaceArchiveBehavior);
  if (parsedBehavior !== undefined) {
    return parsedBehavior;
  }

  return parseOptionalBoolean(stopCoderWorkspaceOnArchive) === false
    ? "keep"
    : DEFAULT_CODER_ARCHIVE_BEHAVIOR;
}

function getLegacyStopCoderWorkspaceOnArchiveValue(
  coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior
): false | undefined {
  return coderWorkspaceArchiveBehavior === "keep" ? false : undefined;
}

function resolveCoderWorkspaceArchiveBehaviorForSave(
  config: Pick<ProjectsConfig, "coderWorkspaceArchiveBehavior" | "stopCoderWorkspaceOnArchive">
): CoderWorkspaceArchiveBehavior {
  const parsedBehavior = parseCoderWorkspaceArchiveBehavior(config.coderWorkspaceArchiveBehavior);
  if (parsedBehavior != null) {
    return parsedBehavior;
  }

  if (config.stopCoderWorkspaceOnArchive === false) {
    return "keep";
  }

  return DEFAULT_CODER_ARCHIVE_BEHAVIOR;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}
function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRouteOverridesRecord(value: unknown): Record<string, string> | undefined {
  const parsed = parseOptionalStringRecord(value);
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, route] of Object.entries(parsed)) {
    out[normalizeToCanonical(key)] = route;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize the per-model minimum thinking level map. Keys are canonicalized and
 * values that aren't valid thinking levels are dropped, keeping a malformed config
 * from bricking startup (self-healing on load).
 */
function normalizeMinThinkingLevelByModel(
  value: unknown
): Record<string, ThinkingLevel> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, ThinkingLevel> = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    const coerced = coerceThinkingLevel(level);
    if (coerced !== undefined) {
      // Gateway-preserving key: explicit coder:<instance>/<model> floors
      // must not collapse into (and clobber) the direct provider's entry.
      out[normalizeSelectedModel(key)] = coerced;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeModelFallbacks(value: unknown): ModelFallbacks | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  // Lenient-on-read: sanitizeModelFallbacks canonicalizes keys, drops
  // self-fallbacks/duplicates/empty chains, and caps chain length, so malformed
  // entries self-heal instead of breaking config load or sends.
  const sanitizedEntries: ModelFallbacks = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as { enabled?: unknown; triggers?: unknown; models?: unknown };
    if (!Array.isArray(candidate.models)) {
      continue;
    }
    sanitizedEntries[key] = {
      ...(typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {}),
      ...(Array.isArray(candidate.triggers)
        ? {
            triggers: candidate.triggers.filter((t): t is "model_refusal" => t === "model_refusal"),
          }
        : {}),
      models: candidate.models.filter((m): m is string => typeof m === "string"),
    };
  }

  const sanitized = sanitizeModelFallbacks(sanitizedEntries);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function normalizeOptionalModelString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  // Reject malformed mux-gateway strings ("mux-gateway:provider" without "/model").
  if (trimmed.startsWith("mux-gateway:") && !trimmed.includes("/")) {
    return undefined;
  }

  const normalized = normalizeSelectedModel(trimmed);
  if (!isValidModelFormat(normalized)) {
    return undefined;
  }

  return normalized;
}

function normalizeOptionalModelStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const normalized = normalizeOptionalModelString(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function normalizeAiDefaultsModelStrings<
  T extends Record<string, { modelString?: string; subagent?: { modelString?: string } }>,
>(value: T): T {
  let modified = false;
  const normalizedEntries = Object.entries(value).map(([id, entry]) => {
    const normalizedModelString = normalizeOptionalModelString(entry.modelString);
    const normalizedSubagentModelString = entry.subagent
      ? normalizeOptionalModelString(entry.subagent.modelString)
      : undefined;
    const subagentChanged =
      entry.subagent != null && normalizedSubagentModelString !== entry.subagent.modelString;
    if (normalizedModelString !== entry.modelString || subagentChanged) {
      modified = true;
      return [
        id,
        {
          ...entry,
          modelString: normalizedModelString,
          ...(entry.subagent
            ? { subagent: { ...entry.subagent, modelString: normalizedSubagentModelString } }
            : {}),
        },
      ];
    }

    return [id, entry];
  });

  return modified ? (Object.fromEntries(normalizedEntries) as T) : value;
}

function normalizeConfigMigrations(value: unknown): AppConfigMigrations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  // Pass through every true-valued flag, including ones this version does not
  // know about. Migration flags from newer app versions must survive a
  // downgrade-to-here + save, otherwise their one-time migrations re-run after
  // re-upgrade (e.g. re-seeding defaults a user deleted).
  const migrations: AppConfigMigrations = {};
  for (const [flag, flagValue] of Object.entries(record)) {
    if (flagValue === true) {
      migrations[flag] = true;
    }
  }
  return migrations;
}

function parseOptionalPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < 0 || value > 65535) {
    return undefined;
  }

  return value;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value <= 0) {
    return undefined;
  }

  return value;
}

function parseOptionalThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return coerceThinkingLevel(value);
}

function parseOptionalHeartbeatIntervalMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < HEARTBEAT_MIN_INTERVAL_MS || value > HEARTBEAT_MAX_INTERVAL_MS) {
    return undefined;
  }

  return value;
}

function normalizeRuntimeEnablementId(value: unknown): RuntimeEnablementId | undefined {
  const trimmed = parseOptionalNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (RUNTIME_ENABLEMENT_IDS.includes(normalized as RuntimeEnablementId)) {
    return normalized as RuntimeEnablementId;
  }

  return undefined;
}

function normalizeRuntimeEnablementOverrides(
  value: unknown
): Partial<Record<RuntimeEnablementId, false>> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const overrides: Partial<Record<RuntimeEnablementId, false>> = {};

  for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
    // Default ON: store `false` only so config.json stays minimal.
    if (record[runtimeId] === false) {
      overrides[runtimeId] = false;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function normalizeProjectKind(value: unknown): "user" | "system" | undefined {
  if (value === "user" || value === "system") {
    return value;
  }

  return undefined;
}

function normalizePersistedWorkspace(
  workspace: ProjectConfig["workspaces"][number]
): ProjectConfig["workspaces"][number] {
  const persisted = workspace as ProjectConfig["workspaces"][number] &
    Record<string, unknown> & {
      workflowSchedule?: unknown;
    };
  const hasLegacyWorkflowSchedule = Object.hasOwn(persisted, "workflowSchedule");
  const hasBestOf = Object.hasOwn(persisted, "bestOf");
  // Legacy alias: tasks stamped by builds where "PTC Exclusive Mode" was a
  // separate experiment may carry only programmaticToolCallingExclusive. The
  // merged PTC experiment activates exactly that posture, so resumed tasks
  // must read it as programmaticToolCalling (`true` wins over an explicit
  // false, matching the schema preprocess and backend feature-flag alias).
  // This is the runtime path: loadConfigOrDefault does not parse workspaces
  // through WorkspaceConfigSchema, so the schema-level alias alone never runs
  // here. The legacy key is retained for downgrade compatibility.
  const taskExperiments =
    typeof persisted.taskExperiments === "object" && persisted.taskExperiments !== null
      ? (persisted.taskExperiments as Record<string, unknown>)
      : undefined;
  const hasLegacyPtcExclusive =
    taskExperiments?.programmaticToolCallingExclusive === true &&
    taskExperiments.programmaticToolCalling !== true;
  if (!hasLegacyWorkflowSchedule && !hasBestOf && !hasLegacyPtcExclusive) {
    return workspace;
  }

  const nextWorkspace = { ...persisted };
  delete nextWorkspace.workflowSchedule;

  if (hasLegacyPtcExclusive) {
    // Spreading the typed field copies ALL persisted keys at runtime —
    // including the legacy one, which stays for downgrade compatibility.
    nextWorkspace.taskExperiments = {
      ...persisted.taskExperiments,
      programmaticToolCalling: true,
    };
  }

  if (hasBestOf) {
    const bestOf = normalizeWorkspaceBestOf(persisted.bestOf);
    if (bestOf) {
      nextWorkspace.bestOf = bestOf;
    } else {
      delete nextWorkspace.bestOf;
    }
  }

  return nextWorkspace;
}

function normalizeProjectRuntimeSettings(projectConfig: ProjectConfig): ProjectConfig {
  // Per-project runtime overrides are optional; keep config.json sparse by persisting only explicit
  // overrides (false enablement + explicit default runtime selections).
  if (!projectConfig || typeof projectConfig !== "object") {
    return { workspaces: [] };
  }

  const record = projectConfig as ProjectConfig & {
    runtimeEnablement?: unknown;
    defaultRuntime?: unknown;
    runtimeOverridesEnabled?: unknown;
    projectKind?: unknown;
    customInstructions?: unknown;
    codeWorkspaceSyncPath?: unknown;
  };
  const runtimeEnablement = normalizeRuntimeEnablementOverrides(record.runtimeEnablement);
  const defaultRuntime = normalizeRuntimeEnablementId(record.defaultRuntime);
  const runtimeOverridesEnabled = record.runtimeOverridesEnabled === true ? true : undefined;

  const next = { ...record };
  delete (next as ProjectConfig & { sections?: unknown }).sections;
  if (runtimeEnablement) {
    next.runtimeEnablement = runtimeEnablement;
  } else {
    delete next.runtimeEnablement;
  }

  if (runtimeOverridesEnabled) {
    next.runtimeOverridesEnabled = runtimeOverridesEnabled;
  } else {
    delete next.runtimeOverridesEnabled;
  }

  if (defaultRuntime) {
    next.defaultRuntime = defaultRuntime;
  } else {
    delete next.defaultRuntime;
  }

  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  next.workspaces = workspaces.map(normalizePersistedWorkspace);

  const projectKind = normalizeProjectKind(record.projectKind);
  if (projectKind !== undefined) {
    next.projectKind = projectKind;
  } else {
    delete next.projectKind;
  }

  // config.json is hand-editable: a non-string customInstructions would fail
  // the projects.list output schema (z.string()) and brick the whole project
  // list, so discard malformed values here where both load and save pass.
  if (typeof record.customInstructions === "string" && record.customInstructions.trim()) {
    next.customInstructions = record.customInstructions;
  } else {
    delete next.customInstructions;
  }

  // Same hand-edit hazard as customInstructions above.
  if (typeof record.codeWorkspaceSyncPath === "string" && record.codeWorkspaceSyncPath.trim()) {
    next.codeWorkspaceSyncPath = record.codeWorkspaceSyncPath;
  } else {
    delete next.codeWorkspaceSyncPath;
  }

  // Legacy named workflow schedules are intentionally dropped while workflow
  // scheduling is disabled during the explicit script_path migration.
  delete (next as ProjectConfig & { workflowSchedules?: unknown }).workflowSchedules;

  return next;
}
/**
 * The built-in Chat with Mux workspace (removed in #3123) lived in a hidden
 * `<xumHome>/system/Mux` project. Real upgraded installs still carry that
 * shipped path/title; later xum-branded leftovers use system/Xum and
 * "Chat with Xum". The removal shipped no config migration, so upgraded
 * installs kept the entry: invisible in the UI (system projects are filtered
 * out) but still swept by config-driven background jobs like
 * AgentStatusService, which sent its stale transcript to the LLM on every
 * launch. Drop both generations on load. Older builds recreate the entry on
 * downgrade; this cleanup re-runs on the next upgrade. The workspace's session
 * data is preserved for downgrades: cleanupOrphanSessionDirs exempts the
 * stable mux-chat id from orphan reaping.
 */
const LEGACY_SYSTEM_CHAT_PROJECT_NAMES = new Set<string>([
  LEGACY_MUX_PRODUCT_NAME,
  XUM_PRODUCT_NAME,
]);
const LEGACY_SYSTEM_CHAT_TITLES = new Set<string>([
  `Chat with ${LEGACY_MUX_PRODUCT_NAME}`,
  `Chat with ${XUM_PRODUCT_NAME}`,
]);
const LEGACY_SYSTEM_CHAT_NAMES = new Set<string>([
  `chat-with-${LEGACY_MUX_PRODUCT_SLUG}`,
  `chat-with-${XUM_PRODUCT_SLUG}`,
]);
const LEGACY_SYSTEM_CHAT_AGENT_IDS = new Set<string>([LEGACY_MUX_PRODUCT_SLUG, XUM_PRODUCT_SLUG]);

function removeLegacyMuxChatEntries(projects: Map<string, ProjectConfig>): boolean {
  // Match by path shape (basename Mux or Xum under "system") rather than the
  // current root dir so stale entries from other roots (e.g. a ~/.xum entry
  // seen by a ~/.xum-dev build) are cleaned too.
  const isSystemMuxPath = (candidate: string): boolean =>
    LEGACY_SYSTEM_CHAT_PROJECT_NAMES.has(path.basename(candidate)) &&
    path.basename(path.dirname(candidate)) === "system";

  let modified = false;
  for (const [projectPath, projectConfig] of projects) {
    const projectIsSystemMux = isSystemMuxPath(projectPath);

    const remaining = projectConfig.workspaces.filter((workspace) => {
      if (workspace.id !== "mux-chat") {
        return true;
      }
      // The subproject merge below may have already relocated the entry into
      // an ancestor project (e.g. ~/.xum registered as a project) on an
      // earlier load, stamping subProjectPath with the original system/Mux
      // (or later system/Xum) path. Match the entry in either location.
      // typeof guard: config JSON is unvalidated at runtime, and a corrupted
      // non-string subProjectPath would make path.basename throw, collapsing
      // the whole config load to empty defaults.
      const legacyProjectPath = projectIsSystemMux
        ? projectPath
        : typeof workspace.subProjectPath === "string" && isSystemMuxPath(workspace.subProjectPath)
          ? workspace.subProjectPath
          : null;
      if (legacyProjectPath === null) {
        return true;
      }
      // Keep unrelated workspaces whose generated id happens to be "mux-chat";
      // only entries carrying the built-in workspace's markers are legacy.
      const looksLikeLegacyMuxChat =
        (workspace.agentId != null && LEGACY_SYSTEM_CHAT_AGENT_IDS.has(workspace.agentId)) ||
        workspace.path === legacyProjectPath ||
        (workspace.name != null && LEGACY_SYSTEM_CHAT_NAMES.has(workspace.name)) ||
        (workspace.title != null && LEGACY_SYSTEM_CHAT_TITLES.has(workspace.title));
      return !looksLikeLegacyMuxChat;
    });

    const removedEntries = remaining.length !== projectConfig.workspaces.length;
    if (removedEntries) {
      projectConfig.workspaces = remaining;
      modified = true;
    }

    // Delete the system Mux/Xum project once empty. The already-empty +
    // projectKind check covers the shell left behind when the subproject
    // merge relocated its only workspace into a parent project.
    if (
      projectIsSystemMux &&
      remaining.length === 0 &&
      (removedEntries || projectConfig.projectKind === "system")
    ) {
      projects.delete(projectPath);
      modified = true;
    }
  }
  return modified;
}

interface ConfigLoadFailureState {
  /** Signature (content + error + backup detail) of the last logged load failure, for log dedupe. */
  failureSignature: string | null;
  /**
   * Content hash of corrupt config bytes whose sidecar backup was verified on disk during
   * the most recent failed load (re-checked every failed load, never trusted across loads).
   */
  backupSignature: string | null;
}

// Process-scoped, keyed by config file path: production creates short-lived Config
// instances (e.g. runtimeFactory per runtime check), so instance-local dedupe would
// re-log the same corrupt-config error once per instance.
const configLoadFailureStates = new Map<string, ConfigLoadFailureState>();

function configLoadFailureState(configFile: string): ConfigLoadFailureState {
  let state = configLoadFailureStates.get(configFile);
  if (!state) {
    state = { failureSignature: null, backupSignature: null };
    configLoadFailureStates.set(configFile, state);
  }
  return state;
}

/**
 * Config - Centralized configuration management
 *
 * Encapsulates all config paths and operations, making them dependency-injectable
 * and testable. Pass a custom rootDir for tests to avoid polluting ~/.xum
 */

function normalizeAdvisorPositiveInteger(value: number | null, label: string): number | null {
  if (value == null) {
    return null;
  }
  assert(Number.isInteger(value), `${label} must be an integer`);
  assert(value > 0, `${label} must be positive`);
  return value;
}

/**
 * What an edit already holds of the project registration lock when it enters the queue:
 * `held` (issued inside a window, or re-run under a lock editConfig took for it), or `none`.
 */
type RegistrationLockState =
  | { kind: "held"; lock: ProjectRegistrationLockHandle }
  | { kind: "none" };

/**
 * Thrown inside the edit queue when the edit could not take the registration file lock in
 * its slot; `rerun` is the edit's re-run under the lock, already queued behind the edits
 * waiting for it (see Config.lockWaiters).
 */
class ProjectRegistrationLockContended extends Error {
  constructor(readonly rerun: Promise<void>) {
    super("project registration lock held elsewhere");
    this.name = "ProjectRegistrationLockContended";
  }
}

export class Config {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly srcDir: string;
  private readonly configFile: string;
  private readonly providersConfigStore: ProvidersConfigStore;
  private readonly emitter = new EventEmitter();
  /**
   * Legacy variant grouping is hidden from the current runtime but retained here so unrelated
   * config writes remain downgrade-safe. Entries are keyed by stable child workspace ID.
   */
  private readonly legacyTaskVariantGroups = new Map<string, LegacyTaskVariantWorkspace>();
  private readonly legacyTaskVariantMetadataOnlyIds = new Set<string>();
  /**
   * Serializes editConfig calls; see editConfig for why. An Effect Semaphore (FIFO
   * permits) replaces the old promise-chain queue 1:1: each edit holds the single
   * permit for its whole read-modify-write cycle, and a failed edit releases its
   * permit on the way out, which preserves the old queue-keep-alive behavior (one
   * edit's failure never wedges later edits).
   */
  private readonly editSemaphore = Semaphore.makeUnsafe(1);
  /**
   * The edits that left their queue slot to wait for the registration file lock, as a chain
   * in slot order; null while none is waiting. The file lock is not fair — waiters poll it,
   * and two polling independently would acquire in arbitrary order, so the later of two
   * edits could write first and the earlier one then overwrite it, reversing the order
   * editConfig promises. Waiting edits therefore re-run one after another off this chain,
   * and while it is non-empty every edit reaching its slot joins the tail instead of trying
   * the lock: it would otherwise take a lock that had just been released ahead of an edit
   * that has been waiting for it since before the later edit was issued.
   */
  private lockWaiters: Promise<void> | null = null;
  /** One-shot guard for the queued load-time migration persist; see loadConfigOrDefault. */
  private migrationPersist: Promise<void> | null = null;

  constructor(rootDir?: string, providersConfigStore?: ProvidersConfigStore) {
    const sessionLocator = new WorkspaceSessionLocator(rootDir);
    this.rootDir = sessionLocator.rootDir;
    this.sessionsDir = sessionLocator.sessionsDir;
    this.srcDir = sessionLocator.srcDir;
    this.configFile = path.join(this.rootDir, "config.json");
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(this.rootDir);
  }

  private rememberLegacyTaskVariantWorkspace(
    projectPath: string,
    value: unknown,
    source: "config" | "metadata" = "config"
  ): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }

    const record = value as Record<string, unknown>;
    const id = parseOptionalNonEmptyString(record.id);
    const bestOf = parseLegacyTaskVariantGroup(record.bestOf);
    if (!id || !bestOf) {
      return;
    }

    const taskStatus = record.taskStatus;
    const parsedTaskStatus =
      taskStatus === "queued" ||
      taskStatus === "starting" ||
      taskStatus === "running" ||
      taskStatus === "awaiting_report" ||
      taskStatus === "interrupted" ||
      taskStatus === "reported"
        ? taskStatus
        : undefined;

    if (source === "metadata") {
      this.legacyTaskVariantMetadataOnlyIds.add(id);
    } else {
      this.legacyTaskVariantMetadataOnlyIds.delete(id);
    }
    this.legacyTaskVariantGroups.set(id, {
      id,
      projectPath: stripTrailingSlashes(projectPath),
      parentWorkspaceId: parseOptionalNonEmptyString(record.parentWorkspaceId),
      agentId: parseOptionalNonEmptyString(record.agentId),
      agentType: parseOptionalNonEmptyString(record.agentType),
      title: parseOptionalNonEmptyString(record.title),
      createdAt: parseOptionalNonEmptyString(record.createdAt),
      taskStatus: parsedTaskStatus,
      bestOf,
    });
  }

  getLegacyTaskVariantGroup(workspaceId: string): LegacyTaskVariantGroup | undefined {
    const bestOf = this.legacyTaskVariantGroups.get(workspaceId)?.bestOf;
    return bestOf ? { ...bestOf } : undefined;
  }

  listLegacyTaskVariantWorkspaces(parentWorkspaceId: string): LegacyTaskVariantWorkspace[] {
    return Array.from(this.legacyTaskVariantGroups.values())
      .filter((workspace) => workspace.parentWorkspaceId === parentWorkspaceId)
      .map((workspace) => ({ ...workspace, bestOf: { ...workspace.bestOf } }));
  }

  onConfigChanged(callback: () => void): () => void {
    this.emitter.on("configChanged", callback);
    return () => {
      this.emitter.off("configChanged", callback);
    };
  }

  private notifyConfigChanged(): void {
    this.emitter.emit("configChanged");
  }

  /**
   * Derive routePriority from currently-configured gateway providers.
   * Returns a priority array when at least one gateway is configured,
   * undefined otherwise — letting callers fall back to their own defaults.
   */
  private seedRoutePriorityFromProviders(): string[] | undefined {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const priority: string[] = [];

    for (const gw of GATEWAY_PROVIDERS) {
      if (isProviderAutoRouteEligible(gw, providersConfig[gw] ?? {})) {
        priority.push(gw);
      }
    }
    priority.push("direct");

    return priority.length > 1 ? priority : undefined;
  }

  private handleConfigLoadFailure(rawBytes: Buffer | undefined, error: unknown): void {
    const state = configLoadFailureState(this.configFile);
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Backup confirmation is keyed on content alone: the same corrupt bytes need only one
    // sidecar regardless of which error message they produced.
    const contentSignature =
      rawBytes !== undefined ? crypto.createHash("sha256").update(rawBytes).digest("hex") : null;

    // Re-verify preservation against the disk on every failed load rather than trusting a
    // cached confirmation: a sidecar deleted or truncated since the last load must re-block
    // the edit gate (and be re-created) or a defaults write would destroy the only copy.
    let backupStatus = "No backup was created because the file contents could not be read.";
    // The actionable part of backupStatus (verified sidecar path, or the failure error);
    // folded into the log-dedupe signature so any change in remediation logs again.
    let backupDetail = "<unreadable>";
    let backupConfirmed = false;
    if (rawBytes !== undefined) {
      try {
        const configDir = path.dirname(this.configFile);
        const corruptPrefix = `${path.basename(this.configFile)}.corrupt-`;
        // Reuse a byte-identical sidecar only if it can also be secured: one from an older
        // build may be world-readable, so tighten it to 0600 before trusting it as the
        // backup. Skip candidates that are unreadable or untightenable (e.g. owned by
        // another user) and keep scanning; a later usable duplicate must still be found
        // even when creating a fresh sidecar would fail (read-only dir, full disk).
        let reusedPath: string | null = null;
        for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(corruptPrefix)) {
            continue;
          }
          const candidatePath = path.join(configDir, entry.name);
          try {
            if (fs.readFileSync(candidatePath).equals(rawBytes)) {
              fs.chmodSync(candidatePath, 0o600);
              reusedPath = candidatePath;
              break;
            }
          } catch {
            // Unusable candidate; keep scanning.
          }
        }
        if (reusedPath) {
          backupStatus = `Backup skipped because identical bytes already exist at ${reusedPath}.`;
          backupDetail = reusedPath;
        } else {
          // Write the bytes that actually failed parsing (not a re-read of the file, which
          // another process may have replaced), leaving the corrupt source in place so
          // throwOnError cleanup guards continue to reject it. "wx" creates exclusively;
          // on a same-millisecond collision retry with a suffix instead of overwriting an
          // earlier snapshot. Mode 0600 because config.json can hold credentials (e.g.
          // muxGovernorToken) that the source file's permissions may protect.
          const basePath = `${this.configFile}.corrupt-${Date.now()}`;
          let backupPath = basePath;
          for (let suffix = 1; ; suffix++) {
            try {
              fs.writeFileSync(backupPath, rawBytes, { flag: "wx", mode: 0o600 });
              break;
            } catch (writeError) {
              if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
                throw writeError;
              }
              backupPath = `${basePath}-${suffix}`;
            }
          }
          // The creation mode is reduced by the process umask (a 0777 umask yields an
          // owner-unreadable file); chmod is not, so pin the final mode explicitly.
          fs.chmodSync(backupPath, 0o600);
          backupStatus = `The original bytes were backed up to ${backupPath}.`;
          backupDetail = backupPath;
        }
        backupConfirmed = true;
      } catch (backupError) {
        const backupErrorMessage =
          backupError instanceof Error ? backupError.message : String(backupError);
        backupStatus = `Backup failed (${backupErrorMessage}); it will be retried on the next load, and settings changes will not overwrite config.json until a backup succeeds.`;
        // Node fs errors embed the attempted (timestamped) sidecar path in the message, so
        // dedupe on the stable errno code where present or repeated ENOSPC/EACCES failures
        // would log on every load.
        const backupErrorCode = (backupError as NodeJS.ErrnoException).code;
        backupDetail = `failed: ${backupErrorCode ?? backupErrorMessage}`;
      }
    }
    // Until a sidecar is confirmed for these exact bytes, enqueueConfigEdit refuses to
    // overwrite the corrupt source.
    state.backupSignature = backupConfirmed ? contentSignature : null;

    // Dedupe on content + error + actionable backup detail: repeated loads of the same
    // state stay silent, while any change in remediation (backup gained or lost, sidecar
    // verified at a different path, a different backup error) replaces stale guidance.
    const logSignature = crypto
      .createHash("sha256")
      .update(rawBytes ?? "<config unreadable>")
      .update("\0")
      .update(errorMessage)
      .update("\0")
      .update(backupDetail)
      .digest("hex");
    if (logSignature === state.failureSignature) {
      return;
    }
    state.failureSignature = logSignature;

    const guidance =
      rawBytes === undefined
        ? `Check that ${this.configFile} is a regular file readable by this user.`
        : `Fix the reported problem in ${this.configFile} or restore it from the backup.`;
    log.error(
      `Failed to load config file ${this.configFile}: ${errorMessage}. ${backupStatus} ${guidance} Xum will continue with default settings and may rewrite config.json with defaults at any time, including at startup, so use the backup to recover your original settings.`
    );
  }

  /**
   * Maximal superset of workspace ids present in the RAW persisted config,
   * for destructive "id is not in config" decisions (extension-metadata
   * pruning, orphan session-dir cleanup).
   *
   * loadConfigOrDefault's validation/normalization is LOSSY: entries it
   * filters or discards (invalid project paths, malformed pairs, entries a
   * migration rewrites) simply vanish from the normalized view, so a pruner
   * keyed on that view would treat their live workspaces as removed and
   * delete their data. This scan instead walks the raw `projects` subtree
   * and collects every string `id` it can find, without judging validity —
   * over-collection merely retains a stale entry a little longer, while
   * under-collection destroys live data. Callers should union this with the
   * normalized view (which contains ids created by in-memory migrations).
   *
   * Throws when the file exists but cannot be read/parsed or the root is not
   * a plain object; a missing file resolves as an empty set (fresh install).
   */
  readPersistedWorkspaceIdSuperset(): Set<string> {
    return this.readPersistedWorkspaceIdEvidence().ids;
  }

  /**
   * readPersistedWorkspaceIdSuperset plus a completeness signal: whether any
   * persisted workspace entry lacks an inline string id. Only such id-less
   * (legacy) entries can be registered "raw-invisibly" — their stable id
   * lives in the session metadata.json, which only the authoritative
   * enumeration resolves. When this reports false, the raw id set is
   * complete registration evidence and callers can skip that per-workspace
   * enumeration. Detection is conservative in the destructive direction:
   * any workspaces container whose entries cannot be verified to carry ids
   * reports true (over-reporting merely costs an extra enumeration, while
   * under-reporting could let a pruner delete a live legacy workspace).
   */
  readPersistedWorkspaceIdEvidence(): {
    ids: Set<string>;
    hasWorkspaceEntriesWithoutIds: boolean;
  } {
    const ids = new Set<string>();
    let hasWorkspaceEntriesWithoutIds = false;
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFile, "utf-8");
    } catch (error) {
      // No existsSync probe: it also returns false for EACCES/ENOTDIR/EIO,
      // which would report a transiently unreadable config as an empty id
      // set and let destructive callers treat every workspace as removed.
      // Only a genuinely missing file is a healthy empty set (fresh install).
      if (isEnoentError(error)) {
        return { ids, hasWorkspaceEntriesWithoutIds };
      }
      throw error;
    }
    const parsedValue: unknown = JSON.parse(raw);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      throw new Error("Config root must be a JSON object");
    }
    const hasInlineStringId = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") {
        return false;
      }
      const id = (value as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0;
    };
    // Collect ids ONLY from the direct entries of `projects[*][1].workspaces`
    // — never from arbitrary nested objects. Workspace entries carry nested
    // id-bearing objects (e.g. taskPendingGuidance items) and can even carry
    // nested `workspaces`-keyed fields written by other builds; ids found
    // there can reference OTHER (including removed) workspaces, and treating
    // them as registered corrupts registration evidence (aborted deletions,
    // lifted tombstones, ghost activity probes) and unbounds the activity
    // scope. Under-collection stays safe: any workspaces container whose
    // entries cannot be verified (id-less entry, non-array container) flips
    // the incompleteness flag, routing callers to the strict enumeration.
    //
    // The OUTER structure must be interpretable too, or the id set cannot be
    // proven complete: a present non-array `projects`, a non-pair element, a
    // non-object project config, or a project config with no workspaces key
    // at all may be a mangled remnant of real registrations. Only an absent
    // projects key is healthy emptiness (the strict loader accepts it).
    // A malformed sibling project only flips the flag — ids from the
    // remaining well-formed projects are still collected.
    const projects = (parsedValue as { projects?: unknown }).projects;
    if (projects !== undefined) {
      if (!Array.isArray(projects)) {
        hasWorkspaceEntriesWithoutIds = true;
      } else {
        for (const pair of projects) {
          const projectConfig: unknown = Array.isArray(pair) ? pair[1] : undefined;
          if (
            projectConfig === null ||
            typeof projectConfig !== "object" ||
            Array.isArray(projectConfig)
          ) {
            hasWorkspaceEntriesWithoutIds = true;
            continue;
          }
          const workspaces = (projectConfig as { workspaces?: unknown }).workspaces;
          if (!Array.isArray(workspaces)) {
            // A missing key or a PRESENT container in any non-array shape is
            // uninterpretable evidence — the original entries may have been
            // mangled, so the raw id set cannot be proven complete.
            hasWorkspaceEntriesWithoutIds = true;
            continue;
          }
          for (const entry of workspaces) {
            if (hasInlineStringId(entry)) {
              ids.add((entry as { id: string }).id);
            } else {
              hasWorkspaceEntriesWithoutIds = true;
            }
          }
        }
      }
    }
    return { ids, hasWorkspaceEntriesWithoutIds };
  }

  loadConfigOrDefault(options?: { throwOnError?: boolean }): ProjectsConfig {
    // Read as a Buffer and hand the same snapshot to the failure handler: backing up via a
    // second read could preserve a concurrent writer's replacement instead of the bytes that
    // actually failed parsing.
    let rawBytes: Buffer | undefined;
    try {
      try {
        rawBytes = fs.readFileSync(this.configFile);
      } catch (readError) {
        // No existsSync probe: it also returns false for EACCES/ENOTDIR/EIO,
        // which would silently select the fresh-install default while the
        // config is merely transiently unreadable — in strict mode that
        // empty view feeds destructive "not in config" decisions. Route
        // non-ENOENT failures through the shared failure path below
        // (throwOnError callers rethrow); only ENOENT means missing.
        if (!isEnoentError(readError)) {
          throw readError;
        }
      }
      if (rawBytes !== undefined) {
        const parsedValue: unknown = JSON.parse(rawBytes.toString("utf-8"));
        if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
          throw new Error("Config root must be a JSON object");
        }
        const parsed = parsedValue as Partial<AppConfigOnDisk> & Record<string, unknown>;
        let configModified = false;
        let shouldInvalidateSessionUsageCaches = false;

        const normalizeNestedModelStrings = (value: unknown): boolean => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
          }

          let modified = false;
          for (const entry of Object.values(value as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              continue;
            }

            const modelString = (entry as { modelString?: unknown }).modelString;
            if (typeof modelString !== "string") {
              continue;
            }

            const normalized = normalizeSelectedModel(modelString.trim());
            if (normalized !== modelString) {
              (entry as { modelString?: string }).modelString = normalized;
              modified = true;
            }
          }

          return modified;
        };

        const normalizeLegacyGatewayModel = (value: string): string | undefined => {
          const trimmed = value.trim();
          if (!trimmed) {
            return undefined;
          }

          const legacyModelString = trimmed.includes(":") ? trimmed : trimmed.replace("/", ":");
          const canonicalModel = normalizeToCanonical(legacyModelString);
          return isValidModelFormat(canonicalModel) ? canonicalModel : undefined;
        };

        // Migrate legacy gateway settings to the new route-based system.
        // Legacy keys are intentionally preserved on disk for downgrade compatibility —
        // older versions still read muxGatewayEnabled / muxGatewayModels directly.
        if (
          (parsed.muxGatewayModels != null || parsed.muxGatewayEnabled != null) &&
          !Array.isArray(parsed.routePriority)
        ) {
          let nextPriority = this.seedRoutePriorityFromProviders() ?? ["direct"];
          if (parsed.muxGatewayEnabled === false) {
            nextPriority = nextPriority.filter((route) => route !== "mux-gateway");
            if (nextPriority.length === 0) {
              nextPriority = ["direct"];
            }
          }
          parsed.routePriority = nextPriority;
          configModified = true;

          if (parsed.muxGatewayEnabled !== false) {
            const legacyModels = parseOptionalStringArray(parsed.muxGatewayModels) ?? [];
            if (legacyModels.length > 0) {
              const mergedRouteOverrides =
                normalizeRouteOverridesRecord(parsed.routeOverrides) ?? {};
              let routeOverridesModified = false;

              for (const legacyModel of legacyModels) {
                const canonicalModel = normalizeLegacyGatewayModel(legacyModel);
                if (!canonicalModel || Object.hasOwn(mergedRouteOverrides, canonicalModel)) {
                  continue;
                }

                mergedRouteOverrides[canonicalModel] = "mux-gateway";
                routeOverridesModified = true;
              }

              if (routeOverridesModified) {
                parsed.routeOverrides = mergedRouteOverrides;
                shouldInvalidateSessionUsageCaches = true;
              }
            }
          }
        }

        // Seed routePriority only when the field does not exist yet.
        // Once routePriority is an array, it becomes user-owned state, so
        // read-time backfill is intentionally skipped here. Credential-driven
        // gateway additions/removals are handled at write time by
        // providerService.syncGatewayLifecycle().
        if (!Array.isArray(parsed.routePriority)) {
          const seeded = this.seedRoutePriorityFromProviders();
          if (seeded) {
            parsed.routePriority = seeded;
            configModified = true;
          }
        }

        if (
          Array.isArray(parsed.routePriority) &&
          parsed.routePriority.includes("mux-gateway") &&
          parsed.muxGatewayEnabled === false
        ) {
          // Once routePriority exists, it is the authoritative routing signal. Clear a stale
          // legacy disable flag so downgrade-compat data cannot veto an explicitly enabled gateway.
          delete parsed.muxGatewayEnabled;
          configModified = true;
        }

        // Normalize persisted model preferences while preserving explicit gateway selections.
        if (typeof parsed.defaultModel === "string") {
          const normalized = normalizeSelectedModel(parsed.defaultModel.trim());
          if (normalized !== parsed.defaultModel) {
            parsed.defaultModel = normalized;
            configModified = true;
            shouldInvalidateSessionUsageCaches = true;
          }
        }

        if (Array.isArray(parsed.hiddenModels)) {
          const sourceHiddenModels = parsed.hiddenModels.filter(
            (model): model is string => typeof model === "string"
          );
          const normalizedHiddenModels = sourceHiddenModels.map((model) =>
            normalizeSelectedModel(model.trim())
          );

          if (
            sourceHiddenModels.length !== parsed.hiddenModels.length ||
            !areStringArraysEqual(sourceHiddenModels, normalizedHiddenModels)
          ) {
            parsed.hiddenModels = normalizedHiddenModels;
            configModified = true;
            shouldInvalidateSessionUsageCaches = true;
          }
        }

        if (normalizeNestedModelStrings(parsed.agentAiDefaults)) {
          configModified = true;
          shouldInvalidateSessionUsageCaches = true;
        }
        if (normalizeNestedModelStrings(parsed.subagentAiDefaults)) {
          configModified = true;
          shouldInvalidateSessionUsageCaches = true;
        }

        // Config is stored as array of [path, config] pairs.
        // Older/newer files may omit `projects`; treat missing/invalid values as an empty map
        // so top-level settings (provider/runtime/server preferences) still load.
        //
        // Strict mode must NOT accept that lenient normalization: callers that
        // make destructive "id is not in config" decisions (extension-metadata
        // pruning, orphan session-dir cleanup) would interpret a structurally
        // invalid-but-parseable file (e.g. `projects: {}` or a non-array
        // `workspaces`) as an empty/partial workspace set and delete live
        // data. A genuinely ABSENT `projects` key stays valid in strict mode:
        // it is how older/newer builds persist a config with no projects.
        if (options?.throwOnError && parsed.projects !== undefined) {
          if (!Array.isArray(parsed.projects)) {
            throw new Error("Config projects must be an array of [path, config] pairs");
          }
          for (const pair of parsed.projects) {
            if (!Array.isArray(pair)) {
              throw new Error("Config projects entries must be [path, config] pairs");
            }
            const projectKey: unknown = pair[0];
            // The lenient normalization below silently drops the WHOLE
            // project when its key is empty or non-string ("Filtering out
            // project with invalid path"), and an id-less legacy workspace
            // inside it is raw-invisible too (its stable id lives only in
            // session metadata.json, which only the normalized enumeration
            // resolves). Accepting the pair here would hand destructive
            // strict callers an authoritative id set missing every one of
            // that project's workspaces — the startup prune would then
            // permanently delete their recency/goal/status snapshots.
            if (typeof projectKey !== "string" || projectKey.length === 0) {
              throw new Error("Config project entries must have a non-empty string path");
            }
            const projectConfig: unknown = pair[1];
            // Arrays pass typeof "object": lenient normalization would turn
            // an array-valued project config into a project with no
            // workspaces, and destructive strict callers would then classify
            // every one of its workspaces as removed.
            if (
              projectConfig === null ||
              typeof projectConfig !== "object" ||
              Array.isArray(projectConfig)
            ) {
              throw new Error("Config project entries must be objects");
            }
            const workspaces = (projectConfig as { workspaces?: unknown }).workspaces;
            // ProjectConfigSchema persists `workspaces` as a REQUIRED array,
            // so a present project entry without the key is mangled state
            // (readPersistedWorkspaceIdEvidence flags it incomplete too).
            // Accepting it here would hand destructive callers an
            // authoritatively-empty workspace set for that project.
            if (!Array.isArray(workspaces)) {
              throw new Error("Config project workspaces must be an array");
            }
            for (const workspaceEntry of workspaces) {
              // WorkspaceSchema persists workspace entries as objects; a
              // non-object entry is mangled state whose identity cannot be
              // established.
              if (
                workspaceEntry === null ||
                typeof workspaceEntry !== "object" ||
                Array.isArray(workspaceEntry)
              ) {
                throw new Error("Config workspace entries must be objects");
              }
              const workspaceId = (workspaceEntry as { id?: unknown }).id;
              // A truthy non-string id (42, {}) would ride the modern-entry
              // branch of getAllWorkspaceMetadata as the authoritative id,
              // so the prune's known set would omit the workspace's REAL
              // string identity and delete its activity snapshot. Nullish
              // ids stay valid: legacy entries resolve their stable id
              // through session metadata.json, and the strict guard there
              // fails closed when that resolution yields no usable id.
              if (
                workspaceId != null &&
                !(typeof workspaceId === "string" && workspaceId.length > 0)
              ) {
                throw new Error("Config workspace ids must be non-empty strings");
              }
            }
          }
        }
        const rawPairs = Array.isArray(parsed.projects) ? parsed.projects : [];
        // Migrate: normalize project paths by stripping trailing slashes
        // This fixes configs created with paths like "/home/user/project/"
        // Also filter out any malformed entries (null/undefined paths)
        // Rebuild config-backed entries from the current on-disk snapshot. Metadata-only entries
        // survive until the legacy metadata migration writes them into config.json below.
        for (const workspaceId of this.legacyTaskVariantGroups.keys()) {
          if (!this.legacyTaskVariantMetadataOnlyIds.has(workspaceId)) {
            this.legacyTaskVariantGroups.delete(workspaceId);
          }
        }
        const normalizedPairs = rawPairs
          .filter(([projectPath]) => {
            if (!projectPath || typeof projectPath !== "string") {
              log.warn("Filtering out project with invalid path", { projectPath });
              return false;
            }
            return true;
          })
          .map(([projectPath, projectConfig]) => {
            if (Array.isArray(projectConfig?.workspaces)) {
              for (const workspace of projectConfig.workspaces) {
                this.rememberLegacyTaskVariantWorkspace(projectPath, workspace);
              }
            }
            const normalizedProjectConfig = normalizeProjectRuntimeSettings(projectConfig);
            return [stripTrailingSlashes(projectPath), normalizedProjectConfig] as [
              string,
              ProjectConfig,
            ];
          });
        const projectsMap = deriveProjectHierarchy(new Map<string, ProjectConfig>(normalizedPairs));

        // Run before the subproject merge below so a hierarchy edge case
        // cannot relocate a legacy workspace into a parent project first.
        if (removeLegacyMuxChatEntries(projectsMap)) {
          configModified = true;
        }

        for (const [projectPath, projectConfig] of projectsMap) {
          const parentProjectPath = projectConfig.parentProjectPath;
          if (!parentProjectPath || projectConfig.workspaces.length === 0) {
            continue;
          }
          const parentProject = projectsMap.get(parentProjectPath);
          if (!parentProject) {
            continue;
          }
          parentProject.workspaces.push(
            ...projectConfig.workspaces.map((workspace) => ({
              ...workspace,
              subProjectPath: workspace.subProjectPath ?? projectPath,
            }))
          );
          projectConfig.workspaces = [];
          configModified = true;
        }

        // Persistent sub-agents must survive a downgrade too. On first load of this behavior,
        // rewrite the previous false/missing default before TaskService startup can create durable
        // children; older builds will then keep their reported histories. The migration marker
        // makes this a one-time default change rather than permanently overriding explicit config.
        const retentionMigrations = normalizeConfigMigrations(parsed.migrations);
        if (retentionMigrations.persistentSubagentsDefaulted !== true) {
          parsed.taskSettings = {
            ...(parsed.taskSettings ?? {}),
            preserveSubagentsUntilArchive: true,
          };
          parsed.migrations = {
            ...retentionMigrations,
            persistentSubagentsDefaulted: true,
          };
          configModified = true;
        }
        if (parsed.taskSettings?.preserveSubagentsUntilArchive !== true) {
          parsed.taskSettings = {
            ...(parsed.taskSettings ?? {}),
            preserveSubagentsUntilArchive: true,
          };
          configModified = true;
        }
        const taskSettings = normalizeTaskSettings(parsed.taskSettings);

        const muxGatewayEnabled = parseOptionalBoolean(parsed.muxGatewayEnabled);
        const muxGatewayModels = parseOptionalStringArray(parsed.muxGatewayModels);
        const routePriority = parseOptionalStringArray(parsed.routePriority);
        const routeOverrides = normalizeRouteOverridesRecord(parsed.routeOverrides);
        const minThinkingLevelByModel = normalizeMinThinkingLevelByModel(
          parsed.minThinkingLevelByModel
        );
        // One-time seed of the default refusal-fallback chains (e.g. Fable →
        // Opus). Guarded by migrations.defaultModelFallbacksSeeded so the
        // seed is applied exactly once: users who later edit or delete the
        // default chains are not overridden on subsequent loads/updates.
        // defaultModelFallbacksSeededFable51 re-runs the gap-check once after
        // the fable alias moved to Fable 5.1: pre-5.1 configs only have a
        // chain for the old source key, and the new key is a new default that
        // deserves one seed of its own (still never overwriting an existing
        // 5.1 chain).
        const migrationsBeforeSeed = normalizeConfigMigrations(parsed.migrations);
        if (
          migrationsBeforeSeed.defaultModelFallbacksSeeded !== true ||
          migrationsBeforeSeed.defaultModelFallbacksSeededFable51 !== true
        ) {
          // Gap-check against the RAW on-disk map with canonicalized keys, not
          // the sanitized map: a hand-edited entry whose chain sanitizes away
          // (e.g. {enabled:false, models:[]}) is still user intent and must not
          // be overwritten. Merging into the raw map also keeps unrelated
          // chains byte-identical on disk (lenient-on-read preserved).
          const rawFallbacks =
            typeof parsed.modelFallbacks === "object" &&
            parsed.modelFallbacks !== null &&
            !Array.isArray(parsed.modelFallbacks)
              ? (parsed.modelFallbacks as Record<string, unknown>)
              : {};
          const existingCanonicalKeys = new Set(
            Object.keys(rawFallbacks).map((key) => normalizeToCanonical(key).trim())
          );
          // Completing the original seed pass claims defaultModelFallbacksSeeded,
          // which downgraded builds trust for their own (pre-5.1) default keys;
          // seed those legacy chains too so a downgrade keeps refusal fallback.
          const seedDefaults =
            migrationsBeforeSeed.defaultModelFallbacksSeeded !== true
              ? { ...LEGACY_DEFAULT_MODEL_FALLBACKS, ...DEFAULT_MODEL_FALLBACKS }
              : DEFAULT_MODEL_FALLBACKS;
          const missingDefaults = Object.fromEntries(
            Object.entries(seedDefaults).filter(
              ([sourceModel]) => !existingCanonicalKeys.has(sourceModel)
            )
          );
          if (Object.keys(missingDefaults).length > 0) {
            // Write through the raw-record view: user entries are deliberately
            // kept unvalidated on disk (normalizeModelFallbacks sanitizes on
            // every read), so the merged map is not a ModelFallbacks yet.
            const rawParsed: Record<string, unknown> = parsed;
            rawParsed.modelFallbacks = { ...rawFallbacks, ...missingDefaults };
          }
          parsed.migrations = {
            ...migrationsBeforeSeed,
            defaultModelFallbacksSeeded: true,
            defaultModelFallbacksSeededFable51: true,
          };
          configModified = true;
        }

        const modelFallbacks = normalizeModelFallbacks(parsed.modelFallbacks);

        const defaultModel = normalizeOptionalModelString(parsed.defaultModel);
        const advisorModelString = parseOptionalNonEmptyString(parsed.advisorModelString);
        const advisorThinkingLevel = parseOptionalThinkingLevel(parsed.advisorThinkingLevel);
        const advisorMaxUsesPerTurn =
          parsed.advisorMaxUsesPerTurn === null
            ? null
            : parseOptionalPositiveInteger(parsed.advisorMaxUsesPerTurn);
        const advisorMaxOutputTokens =
          parsed.advisorMaxOutputTokens === null
            ? null
            : parseOptionalPositiveInteger(parsed.advisorMaxOutputTokens);
        const hiddenMigrations = normalizeConfigMigrations(parsed.migrations);
        const existingHiddenModels = normalizeOptionalModelStringArray(parsed.hiddenModels);
        if (hiddenMigrations.daybreakModelsHidden !== true) {
          // Seed once, without losing unrelated hides or re-hiding models users later enable.
          parsed.migrations = {
            ...hiddenMigrations,
            daybreakModelsHidden: true,
            hiddenModelsInitialized:
              hiddenMigrations.hiddenModelsInitialized === true ||
              existingHiddenModels !== undefined,
          };
          parsed.hiddenModels = [
            ...new Set([...(existingHiddenModels ?? []), ...DEFAULT_HIDDEN_MODELS]),
          ];
          configModified = true;
        }
        const hiddenModels = normalizeOptionalModelStringArray(parsed.hiddenModels);
        // Legacy root subagentAiDefaults (written by older builds and by the
        // save-time downgrade projection) folds into the canonical nested
        // `subagent` profile here; nothing outside this load and the save
        // projection may read or write the legacy root map.
        const agentAiDefaults = mergeLegacySubagentAiDefaults(
          normalizeAgentAiDefaults(parsed.agentAiDefaults),
          parsed.subagentAiDefaults
        );

        if (shouldInvalidateSessionUsageCaches) {
          // Invalidate stale usage caches only when model id formats changed.
          try {
            if (fs.existsSync(this.sessionsDir)) {
              for (const sessionEntry of fs.readdirSync(this.sessionsDir, {
                withFileTypes: true,
              })) {
                if (!sessionEntry.isDirectory()) {
                  continue;
                }

                const usagePath = path.join(
                  path.join(this.sessionsDir, sessionEntry.name),
                  "session-usage.json"
                );
                if (fs.existsSync(usagePath)) {
                  fs.rmSync(usagePath, { force: true });
                }
              }
            }
          } catch (error) {
            // Best-effort cleanup; never fail startup on cache invalidation issues.
            log.warn("Failed to invalidate session usage cache during config migration", { error });
          }
        }

        if (configModified && this.migrationPersist == null) {
          // Persist load-time migrations through the serialized editConfig queue instead of
          // writing `parsed` synchronously here: a sync write bypasses the queue, so a
          // concurrent editConfig write landing between this load's read and the write-back
          // would be clobbered with stale data (same lost-update class that resurrected
          // removed workspaces via the old public saveConfig). Migrations are idempotent and
          // re-applied on every load, so the identity transform re-reads disk, re-runs them,
          // and persists the migrated form under the queue. One-shot guard: while a persist
          // is in flight, the loads it performs internally must not re-schedule.
          this.migrationPersist = this.enqueueGatedConfigEdit((migratedConfig) => migratedConfig)
            .catch((error: unknown) => {
              // Keep startup resilient even if persisting migration fails.
              log.warn("Failed to persist migrated config", { error });
            })
            .finally(() => {
              this.migrationPersist = null;
            });
        }

        const coderWorkspaceArchiveBehavior = resolveCoderWorkspaceArchiveBehavior(
          parsed.coderWorkspaceArchiveBehavior,
          parsed.stopCoderWorkspaceOnArchive
        );
        const worktreeArchiveBehavior = resolveWorktreeArchiveBehavior(
          parsed.worktreeArchiveBehavior,
          parsed.deleteWorktreeOnArchive
        );
        const deleteWorktreeOnArchive =
          getLegacyDeleteWorktreeOnArchiveValue(worktreeArchiveBehavior);
        const stopCoderWorkspaceOnArchive = getLegacyStopCoderWorkspaceOnArchiveValue(
          coderWorkspaceArchiveBehavior
        );
        const updateChannel = parseUpdateChannel(parsed.updateChannel);

        const runtimeEnablement = normalizeRuntimeEnablementOverrides(parsed.runtimeEnablement);
        const defaultRuntime = normalizeRuntimeEnablementId(parsed.defaultRuntime);

        const userPreferences = normalizeUserPreferences(parsed.userPreferences);
        const migrations = normalizeConfigMigrations(parsed.migrations);
        if (parsed.userPreferences !== undefined) {
          migrations.userPreferencesInitialized = true;
        }

        const layoutPresetsRaw = normalizeLayoutPresetsConfig(parsed.layoutPresets);
        const layoutPresets = isLayoutPresetsConfigEmpty(layoutPresetsRaw)
          ? undefined
          : layoutPresetsRaw;

        // Also forget the confirmed backup: after a healthy load the user may prune sidecars,
        // so a later re-corruption must re-verify the backup on disk.
        configLoadFailureStates.delete(this.configFile);
        return {
          projects: projectsMap,
          apiServerBindHost: parseOptionalNonEmptyString(parsed.apiServerBindHost),
          apiServerServeWebUi: parseOptionalBoolean(parsed.apiServerServeWebUi) ? true : undefined,
          apiServerPort: parseOptionalPort(parsed.apiServerPort),
          mdnsAdvertisementEnabled: parseOptionalBoolean(parsed.mdnsAdvertisementEnabled),
          mdnsServiceName: parseOptionalNonEmptyString(parsed.mdnsServiceName),
          serverSshHost: parsed.serverSshHost,
          serverAuthGithubOwner: parseOptionalNonEmptyString(parsed.serverAuthGithubOwner),
          defaultProjectDir: parseOptionalNonEmptyString(parsed.defaultProjectDir),
          viewedSplashScreens: parsed.viewedSplashScreens,
          userPreferences,
          layoutPresets,
          taskSettings,
          chatTranscriptFullWidth: parseOptionalBoolean(parsed.chatTranscriptFullWidth),
          muxGatewayEnabled,
          llmDebugLogs: parseOptionalBoolean(parsed.llmDebugLogs),
          heartbeatDefaultPrompt: parseOptionalNonEmptyString(parsed.heartbeatDefaultPrompt),
          heartbeatDefaultIntervalMs: parseOptionalHeartbeatIntervalMs(
            parsed.heartbeatDefaultIntervalMs
          ),
          goalDefaults: normalizeGoalDefaults(parsed.goalDefaults),
          muxGatewayModels,
          routePriority,
          routeOverrides,
          minThinkingLevelByModel,
          modelFallbacks,
          defaultModel,
          advisorModelString,
          advisorThinkingLevel,
          advisorMaxUsesPerTurn,
          advisorMaxOutputTokens,
          hiddenModels,
          agentAiDefaults,
          migrations,
          useSSH2Transport: parseOptionalBoolean(parsed.useSSH2Transport),
          muxGovernorUrl: parseOptionalNonEmptyString(parsed.muxGovernorUrl),
          muxGovernorToken: parseOptionalNonEmptyString(parsed.muxGovernorToken),
          coderWorkspaceArchiveBehavior,
          worktreeArchiveBehavior,
          deleteWorktreeOnArchive,
          stopCoderWorkspaceOnArchive,
          terminalDefaultShell: parseOptionalNonEmptyString(parsed.terminalDefaultShell),
          updateChannel,
          defaultRuntime,
          runtimeEnablement,
          // Validated here rather than trusted: a hand-edited or older-build value that fails the
          // schema would otherwise reach the IPC output validator and fail the whole settings
          // read, so one bad field would report a load failure for every setting on the screen.
          settingsBackup: SettingsBackupSchema.optional()
            .catch(undefined)
            .parse(parsed.settingsBackup),
          legacyOnePasswordAccountName: parseOptionalNonEmptyString(parsed.onePasswordAccountName),
        };
      } else {
        configLoadFailureStates.delete(this.configFile);
      }
    } catch (error) {
      this.handleConfigLoadFailure(rawBytes, error);
      if (options?.throwOnError) {
        throw error;
      }
    }

    // Return default config
    return {
      projects: new Map(),
      taskSettings: DEFAULT_TASK_SETTINGS,
      agentAiDefaults: {},
      routePriority: this.seedRoutePriorityFromProviders(),
      coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
      deleteWorktreeOnArchive: false,
      // Fresh installs get the default refusal-fallback chains immediately; the
      // migration flag rides along so the first save locks in seed-once
      // semantics (later loads never re-apply the defaults).
      modelFallbacks: { ...LEGACY_DEFAULT_MODEL_FALLBACKS, ...DEFAULT_MODEL_FALLBACKS },
      hiddenModels: [...DEFAULT_HIDDEN_MODELS],
      migrations: {
        daybreakModelsHidden: true,
        defaultModelFallbacksSeeded: true,
        defaultModelFallbacksSeededFable51: true,
        persistentSubagentsDefaulted: true,
      },
    };
  }

  /**
   * Write the full config snapshot to disk (atomic write, log-and-swallow errors).
   *
   * PRIVATE on purpose: this is editConfig's write primitive only. Direct external
   * callers used to write stale full snapshots outside the editConfig queue, which
   * caused lost-update races — e.g. a snapshot read before a concurrent
   * removeWorkspace() and written after it resurrected the removed workspace entry
   * as a permanent sidebar ghost. All mutations must go through editConfig so each
   * write is derived from a fresh serialized read.
   *
   * Kept as a Promise facade (tests spy on it with Promise mocks to simulate
   * swallowed writes); saveConfigEffect below holds the actual pipeline.
   */
  private saveConfig(config: ProjectsConfig): Promise<void> {
    return Effect.runPromise(this.saveConfigEffect(config));
  }

  /**
   * Never fails: the whole pipeline folds every failure and defect into the same
   * log-and-swallow the old try/catch applied (total catch discipline).
   */
  private saveConfigEffect(config: ProjectsConfig): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (!fs.existsSync(self.rootDir)) {
        ensurePrivateDirSync(self.rootDir);
      }

      const data: Partial<Record<keyof AppConfigOnDisk, unknown>> & {
        projects: Array<[string, ProjectConfig]>;
      } = {
        // Stamped by every save; see configFileWriteGeneration.
        writeId: crypto.randomUUID(),
        projects: Array.from(config.projects.entries()).map(([projectPath, projectConfig]) => {
          const normalizedProjectConfig = normalizeProjectRuntimeSettings(projectConfig);
          const persistedProjectConfig = {
            ...normalizedProjectConfig,
            workspaces: normalizedProjectConfig.workspaces.map((workspace) => ({ ...workspace })),
          };
          for (const workspace of persistedProjectConfig.workspaces) {
            const workspaceId = parseOptionalNonEmptyString(workspace.id);
            const legacy = workspaceId ? self.legacyTaskVariantGroups.get(workspaceId) : undefined;
            if (legacy && workspace.bestOf == null) {
              // Keep downgrade-only metadata on disk without exposing it to current runtime types,
              // UI grouping, or provider-facing task schemas.
              // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
              (workspace as unknown as Record<string, unknown>).bestOf = { ...legacy.bestOf };
            }
          }
          return [projectPath, persistedProjectConfig] as [string, ProjectConfig];
        }),
        taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
      };

      const muxGatewayEnabled = parseOptionalBoolean(config.muxGatewayEnabled);
      if (muxGatewayEnabled !== undefined) {
        data.muxGatewayEnabled = muxGatewayEnabled;
      }

      const chatTranscriptFullWidth = parseOptionalBoolean(config.chatTranscriptFullWidth);
      if (chatTranscriptFullWidth === true) {
        data.chatTranscriptFullWidth = true;
      }

      const llmDebugLogs = parseOptionalBoolean(config.llmDebugLogs);
      if (llmDebugLogs !== undefined) {
        data.llmDebugLogs = llmDebugLogs;
      }

      const heartbeatDefaultPrompt = parseOptionalNonEmptyString(config.heartbeatDefaultPrompt);
      if (heartbeatDefaultPrompt) {
        data.heartbeatDefaultPrompt = heartbeatDefaultPrompt;
      }

      const heartbeatDefaultIntervalMs = parseOptionalHeartbeatIntervalMs(
        config.heartbeatDefaultIntervalMs
      );
      if (heartbeatDefaultIntervalMs !== undefined) {
        data.heartbeatDefaultIntervalMs = heartbeatDefaultIntervalMs;
      }

      if (config.goalDefaults) {
        data.goalDefaults = normalizeGoalDefaults(config.goalDefaults);
      }

      const muxGatewayModels = parseOptionalStringArray(config.muxGatewayModels);
      if (muxGatewayModels !== undefined) {
        data.muxGatewayModels = muxGatewayModels;
      }

      const defaultModel = normalizeOptionalModelString(config.defaultModel);
      if (defaultModel !== undefined) {
        data.defaultModel = defaultModel;
      }

      const advisorModelString = parseOptionalNonEmptyString(config.advisorModelString);
      if (advisorModelString !== undefined) {
        data.advisorModelString = advisorModelString;
      }

      const advisorThinkingLevel = parseOptionalThinkingLevel(config.advisorThinkingLevel);
      if (advisorThinkingLevel !== undefined) {
        data.advisorThinkingLevel = advisorThinkingLevel;
      }

      if (config.advisorMaxUsesPerTurn === null) {
        data.advisorMaxUsesPerTurn = null;
      } else {
        const advisorMaxUsesPerTurn = parseOptionalPositiveInteger(config.advisorMaxUsesPerTurn);
        if (advisorMaxUsesPerTurn !== undefined) {
          data.advisorMaxUsesPerTurn = advisorMaxUsesPerTurn;
        }
      }

      if (config.advisorMaxOutputTokens === null) {
        data.advisorMaxOutputTokens = null;
      } else {
        const advisorMaxOutputTokens = parseOptionalPositiveInteger(config.advisorMaxOutputTokens);
        if (advisorMaxOutputTokens !== undefined) {
          data.advisorMaxOutputTokens = advisorMaxOutputTokens;
        }
      }

      const hiddenModels = normalizeOptionalModelStringArray(config.hiddenModels);
      if (hiddenModels !== undefined) {
        data.hiddenModels = hiddenModels;
      }

      const routePriority = parseOptionalStringArray(config.routePriority);
      if (routePriority !== undefined) {
        data.routePriority = routePriority;
      }

      const routeOverrides = normalizeRouteOverridesRecord(config.routeOverrides);
      if (routeOverrides !== undefined) {
        data.routeOverrides = routeOverrides;
      }

      const minThinkingLevelByModel = normalizeMinThinkingLevelByModel(
        config.minThinkingLevelByModel
      );
      if (minThinkingLevelByModel !== undefined) {
        data.minThinkingLevelByModel = minThinkingLevelByModel;
      }

      const modelFallbacks = normalizeModelFallbacks(config.modelFallbacks);
      if (modelFallbacks !== undefined) {
        data.modelFallbacks = modelFallbacks;
      }

      const apiServerBindHost = parseOptionalNonEmptyString(config.apiServerBindHost);
      if (apiServerBindHost) {
        data.apiServerBindHost = apiServerBindHost;
      }

      const apiServerServeWebUi = parseOptionalBoolean(config.apiServerServeWebUi);
      if (apiServerServeWebUi) {
        data.apiServerServeWebUi = true;
      }

      const apiServerPort = parseOptionalPort(config.apiServerPort);
      if (apiServerPort !== undefined) {
        data.apiServerPort = apiServerPort;
      }

      const mdnsAdvertisementEnabled = parseOptionalBoolean(config.mdnsAdvertisementEnabled);
      if (mdnsAdvertisementEnabled !== undefined) {
        data.mdnsAdvertisementEnabled = mdnsAdvertisementEnabled;
      }

      const mdnsServiceName = parseOptionalNonEmptyString(config.mdnsServiceName);
      if (mdnsServiceName) {
        data.mdnsServiceName = mdnsServiceName;
      }

      if (config.serverSshHost) {
        data.serverSshHost = config.serverSshHost;
      }
      const serverAuthGithubOwner = parseOptionalNonEmptyString(config.serverAuthGithubOwner);
      if (serverAuthGithubOwner) {
        data.serverAuthGithubOwner = serverAuthGithubOwner;
      }
      const defaultProjectDir = parseOptionalNonEmptyString(config.defaultProjectDir);
      if (defaultProjectDir) {
        data.defaultProjectDir = defaultProjectDir;
      }
      const userPreferences = normalizeUserPreferences(config.userPreferences);
      if (userPreferences) {
        data.userPreferences = userPreferences;
      }

      if (config.layoutPresets) {
        const normalized = normalizeLayoutPresetsConfig(config.layoutPresets);
        if (!isLayoutPresetsConfigEmpty(normalized)) {
          data.layoutPresets = normalized;
        }
      }
      if (config.viewedSplashScreens) {
        data.viewedSplashScreens = config.viewedSplashScreens;
      }
      if (config.agentAiDefaults && Object.keys(config.agentAiDefaults).length > 0) {
        const normalizedAgentAiDefaults = normalizeAiDefaultsModelStrings(config.agentAiDefaults);
        data.agentAiDefaults = normalizedAgentAiDefaults;

        // Downgrade-compatibility projection only: older builds resolve
        // delegated runs from the legacy root map. Never read back at runtime;
        // load folds it into the nested `subagent` profile.
        const legacySubagent = deriveLegacySubagentAiDefaultsProjection(normalizedAgentAiDefaults);
        if (Object.keys(legacySubagent).length > 0) {
          data.subagentAiDefaults = legacySubagent;
        }
      }

      const migrations = normalizeConfigMigrations(config.migrations);
      // Any true flag (known or from a newer version) must persist; the spread
      // below writes them all, so gate only on presence.
      if (
        Object.keys(migrations).length > 0 ||
        config.userPreferences !== undefined ||
        config.agentAiDefaults?.exec != null
      ) {
        data.migrations = {
          ...migrations,
          ...(config.userPreferences !== undefined ? { userPreferencesInitialized: true } : {}),
          // Written for downgrade compatibility so older builds do not re-run
          // their exec split migration against the projected legacy map.
          ...(config.agentAiDefaults?.exec != null ? { execSubagentDefaultsSplit: true } : {}),
        };
      }

      if (config.useSSH2Transport !== undefined) {
        data.useSSH2Transport = config.useSSH2Transport;
      }

      const muxGovernorUrl = parseOptionalNonEmptyString(config.muxGovernorUrl);
      if (muxGovernorUrl) {
        data.muxGovernorUrl = muxGovernorUrl;
      }

      const muxGovernorToken = parseOptionalNonEmptyString(config.muxGovernorToken);
      if (muxGovernorToken) {
        data.muxGovernorToken = muxGovernorToken;
      }

      const coderWorkspaceArchiveBehavior = resolveCoderWorkspaceArchiveBehaviorForSave(config);
      data.coderWorkspaceArchiveBehavior = coderWorkspaceArchiveBehavior;

      const worktreeArchiveBehavior = resolveWorktreeArchiveBehaviorForSave(config);
      data.worktreeArchiveBehavior = worktreeArchiveBehavior;

      const stopCoderWorkspaceOnArchive = getLegacyStopCoderWorkspaceOnArchiveValue(
        coderWorkspaceArchiveBehavior
      );
      if (stopCoderWorkspaceOnArchive !== undefined) {
        data.stopCoderWorkspaceOnArchive = stopCoderWorkspaceOnArchive;
      }

      data.deleteWorktreeOnArchive = getLegacyDeleteWorktreeOnArchiveValue(worktreeArchiveBehavior);

      const terminalDefaultShell = parseOptionalNonEmptyString(config.terminalDefaultShell);
      if (terminalDefaultShell) {
        data.terminalDefaultShell = terminalDefaultShell;
      }

      const updateChannel = parseUpdateChannel(config.updateChannel);
      if (updateChannel) {
        data.updateChannel = updateChannel;
      }

      const runtimeEnablement = normalizeRuntimeEnablementOverrides(config.runtimeEnablement);
      if (runtimeEnablement) {
        data.runtimeEnablement = runtimeEnablement;
      }

      const defaultRuntime = normalizeRuntimeEnablementId(config.defaultRuntime);
      if (defaultRuntime !== undefined) {
        data.defaultRuntime = defaultRuntime;
      }

      if (config.settingsBackup) {
        data.settingsBackup = config.settingsBackup;
      }

      // Round-trip the legacy 1Password account name so unrelated saves don't
      // delete it from config.json; downgrades depend on it to reinitialize.
      const legacyOnePasswordAccountName = parseOptionalNonEmptyString(
        config.legacyOnePasswordAccountName
      );
      if (legacyOnePasswordAccountName) {
        data.onePasswordAccountName = legacyOnePasswordAccountName;
      }

      const persistedWorkspaceIds = new Set<string>();
      for (const [, project] of data.projects) {
        for (const workspace of project.workspaces) {
          const workspaceId = parseOptionalNonEmptyString(workspace.id);
          if (workspaceId) {
            persistedWorkspaceIds.add(workspaceId);
          }
        }
      }
      yield* Effect.tryPromise({
        try: async () => writeFileAtomic(self.configFile, JSON.stringify(data, null, 2), "utf-8"),
        catch: (error) => error,
      });
      for (const workspaceId of self.legacyTaskVariantGroups.keys()) {
        if (!persistedWorkspaceIds.has(workspaceId)) {
          // A load-time settings migration can save before getAllWorkspaceMetadata's queued
          // identity migration adds this legacy workspace ID. Keep metadata-only entries alive
          // until a later save can attach them to the migrated config record.
          if (!self.legacyTaskVariantMetadataOnlyIds.has(workspaceId)) {
            self.legacyTaskVariantGroups.delete(workspaceId);
          }
        } else {
          self.legacyTaskVariantMetadataOnlyIds.delete(workspaceId);
        }
      }
    }).pipe(
      // Mirror the old whole-pipeline try/catch: fold both the typed write failure and
      // any defect thrown by the synchronous serialization above into the same
      // log-and-swallow, so this pipeline never fails.
      Effect.catch((error) => Effect.sync(() => log.error("Error saving config:", error))),
      Effect.catchDefect((error) => Effect.sync(() => log.error("Error saving config:", error)))
    );
  }

  /**
   * The config file as a write generation, for a caller that reads the project registry at
   * two points and needs to know whether anything was written in between — a registration, a
   * removal, or a removal and a re-registration with identical config, which the registry's
   * content alone cannot show. Two parts: the `writeId` every save of this class stamps into
   * the file, a fresh random value that two writes cannot share even when they write the same
   * bytes (a timestamp can, on a filesystem with coarse mtimes, and so can an inode the
   * allocator hands out again); and the file's inode, mtime, and size, for writers that do
   * not stamp (an older build, the config tool), whose writes at least usually change those.
   * "absent" when there is no file.
   */
  async configFileWriteGeneration(): Promise<string> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.configFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    let writeId = "-";
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.configFile, "utf-8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { writeId?: unknown }).writeId === "string"
      ) {
        writeId = (parsed as { writeId: string }).writeId;
      }
    } catch {
      // Unreadable or not JSON: the stat part still distinguishes most writes, and the
      // caller's content comparison the rest it cares about.
    }
    return `${writeId}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  }

  /**
   * Edit config atomically using a transformation function
   * @param fn Function that takes current config and returns modified config
   *
   * Edits are serialized on an internal queue: each edit's read happens only
   * after the previous edit's write has landed. Without this, concurrent edits
   * (e.g. parallel task launches updating taskStatus) read the same snapshot
   * and the later write silently clobbers the earlier one.
   *
   * An edit that adds or removes a project key additionally runs under the project
   * registration lock (see `withProjectRegistrationLock`), whichever service it comes from,
   * so a settings-backup restore writing project memory never has the project set change
   * underneath it. A caller already holding that lock passes `withinRegistrationLock`.
   */
  async editConfig(
    fn: (config: ProjectsConfig) => ProjectsConfig,
    options: { withinRegistrationLock?: ProjectRegistrationLockHandle } = {}
  ): Promise<void> {
    if (options.withinRegistrationLock !== undefined) {
      return this.enqueueConfigEdit(fn, { kind: "held", lock: options.withinRegistrationLock });
    }
    return this.enqueueGatedConfigEdit(fn);
  }

  /**
   * The cross-process gate for an edit issued outside any registration window; shared by
   * editConfig and the load-time migration persist (which must not call the public, commonly
   * spied editConfig). Every edit persists the whole config, project map included, from the
   * bytes its transform read, so every edit's read and write have to happen under the
   * cross-process lock or a registration another process makes in between is silently
   * dropped by this process's save — even by an edit that never touched the project set.
   */
  private async enqueueGatedConfigEdit(
    fn: (config: ProjectsConfig) => ProjectsConfig
  ): Promise<void> {
    // Straight into the queue, in call order: the edit takes its own hold of the file lock
    // inside its slot, at write time. When the lock is held elsewhere — another process, or
    // a restore, import, or create window in this one — the edit fails the slot before
    // writing and is re-run once it has waited for the lock, outside the queue (so an edit
    // issued inside the window is not held up behind its wait) but behind the edits already
    // waiting (see lockWaiters). Its first run was discarded: nothing it mutated survives,
    // since loadConfigOrDefault parses fresh bytes on every call.
    try {
      return await this.enqueueConfigEdit(fn, { kind: "none" });
    } catch (error) {
      if (!(error instanceof ProjectRegistrationLockContended)) throw error;
      return error.rerun;
    }
  }

  /**
   * Queues `fn` to re-run under the registration file lock after every edit already waiting
   * for it, and records the chain's new tail. Called synchronously from the edit's queue
   * slot, so the chain order is the slot order.
   */
  private joinLockWaiters(fn: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    const rerun = (this.lockWaiters ?? Promise.resolve()).then(() =>
      withProjectRegistrationFileLock(this.rootDir, (lock) =>
        this.enqueueConfigEdit(fn, { kind: "held", lock })
      )
    );
    // The tail settles either way, so one edit's failure never wedges the ones behind it.
    const tail: Promise<void> = rerun.then(
      () => this.leaveLockWaiters(tail),
      () => this.leaveLockWaiters(tail)
    );
    this.lockWaiters = tail;
    return rerun;
  }

  private leaveLockWaiters(tail: Promise<void>): void {
    if (this.lockWaiters === tail) this.lockWaiters = null;
  }

  getClientConfig() {
    const config = this.loadConfigOrDefault();
    const muxGovernorUrl = config.muxGovernorUrl ?? null;
    return {
      userPreferencesInitialized: config.migrations?.userPreferencesInitialized === true,
      userPreferences: config.userPreferences,
      taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
      muxGatewayEnabled: config.muxGatewayEnabled,
      muxGatewayModels: config.muxGatewayModels,
      routePriority: config.routePriority,
      routeOverrides: config.routeOverrides,
      minThinkingLevelByModel: config.minThinkingLevelByModel,
      modelFallbacks: config.modelFallbacks,
      defaultModel: config.defaultModel,
      advisorModelString: config.advisorModelString ?? null,
      advisorThinkingLevel: config.advisorThinkingLevel ?? null,
      advisorMaxUsesPerTurn: config.advisorMaxUsesPerTurn,
      advisorMaxOutputTokens: config.advisorMaxOutputTokens,
      hiddenModels: config.hiddenModels,
      hiddenModelsInitialized: config.migrations?.hiddenModelsInitialized === true,
      coderWorkspaceArchiveBehavior:
        config.coderWorkspaceArchiveBehavior ?? DEFAULT_CODER_ARCHIVE_BEHAVIOR,
      worktreeArchiveBehavior: config.worktreeArchiveBehavior ?? DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
      runtimeEnablement: normalizeRuntimeEnablement(config.runtimeEnablement),
      defaultRuntime: config.defaultRuntime ?? null,
      agentAiDefaults: config.agentAiDefaults ?? {},
      muxGovernorUrl,
      muxGovernorEnrolled: Boolean(config.muxGovernorUrl && config.muxGovernorToken),
      chatTranscriptFullWidth: config.chatTranscriptFullWidth === true,
      llmDebugLogs: config.llmDebugLogs === true,
      heartbeatDefaultPrompt: config.heartbeatDefaultPrompt ?? undefined,
      heartbeatDefaultIntervalMs: config.heartbeatDefaultIntervalMs ?? undefined,
      goalDefaults: normalizeGoalDefaults(config.goalDefaults ?? DEFAULT_GOAL_DEFAULTS),
    };
  }

  async updateMuxGatewayPrefs(input: {
    muxGatewayEnabled: boolean;
    muxGatewayModels: string[];
  }): Promise<void> {
    await this.editConfig((config) => ({
      ...config,
      muxGatewayEnabled: input.muxGatewayEnabled ? undefined : false,
      muxGatewayModels: [...new Set(input.muxGatewayModels)].sort(),
    }));
  }

  async updateCoderPrefs(input: {
    coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
    worktreeArchiveBehavior: WorktreeArchiveBehavior;
  }): Promise<void> {
    await this.editConfig((config) => ({ ...config, ...input }));
  }

  async updateChatTranscriptFullWidth(enabled: boolean): Promise<void> {
    await this.editConfig((config) => {
      if (enabled) config.chatTranscriptFullWidth = true;
      else delete config.chatTranscriptFullWidth;
      return config;
    });
  }

  async updateLlmDebugLogs(enabled: boolean): Promise<void> {
    await this.editConfig((config) => ({ ...config, llmDebugLogs: enabled }));
  }

  async updateHeartbeatDefaultPrompt(defaultPrompt: string | null | undefined): Promise<void> {
    await this.editConfig((config) => {
      const trimmed = defaultPrompt?.trim();
      if (trimmed) config.heartbeatDefaultPrompt = trimmed;
      else delete config.heartbeatDefaultPrompt;
      return config;
    });
  }

  async updateHeartbeatDefaultIntervalMs(intervalMs: number | null | undefined): Promise<void> {
    await this.editConfig((config) => {
      if (intervalMs != null) config.heartbeatDefaultIntervalMs = intervalMs;
      else delete config.heartbeatDefaultIntervalMs;
      return config;
    });
  }

  async updateGoalDefaults(
    goalDefaults: Parameters<typeof normalizeGoalDefaults>[0]
  ): Promise<void> {
    await this.editConfig((config) => ({
      ...config,
      goalDefaults: normalizeGoalDefaults(goalDefaults),
    }));
  }

  async unenrollMuxGovernor(): Promise<void> {
    await this.editConfig(({ muxGovernorUrl: _url, muxGovernorToken: _token, ...rest }) => rest);
  }

  async updateAgentAiDefaults(agentAiDefaults: unknown): Promise<void> {
    await this.editConfig((config) => {
      const normalized = normalizeAgentAiDefaults(agentAiDefaults);
      return {
        ...config,
        agentAiDefaults: Object.keys(normalized).length > 0 ? normalized : undefined,
      };
    });
  }

  async markSplashScreenViewed(splashId: string): Promise<void> {
    await this.editConfig((config) => {
      const viewed = config.viewedSplashScreens ?? [];
      if (!viewed.includes(splashId)) viewed.push(splashId);
      return { ...config, viewedSplashScreens: viewed };
    });
  }

  async saveLayoutPresets(layoutPresets: LayoutPresetsConfig): Promise<void> {
    await this.editConfig((config) => {
      const normalized = normalizeLayoutPresetsConfig(layoutPresets);
      return {
        ...config,
        layoutPresets: isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized,
      };
    });
  }

  async updateRoutePreferences(input: {
    routePriority: ProjectsConfig["routePriority"];
    routeOverrides?: ProjectsConfig["routeOverrides"];
    validateRouteOverrides: (overrides: Record<string, string>) => Result<void, string>;
  }): Promise<void> {
    const routeOverrides = input.routeOverrides ?? this.loadConfigOrDefault().routeOverrides ?? {};
    const validation = input.validateRouteOverrides(routeOverrides);
    if (!validation.success) {
      throw new Error(validation.error);
    }

    await this.editConfig((config) => ({
      ...config,
      routePriority: input.routePriority,
      routeOverrides,
    }));
  }

  async updateMinThinkingLevels(
    minThinkingLevelByModel: ProjectsConfig["minThinkingLevelByModel"]
  ): Promise<void> {
    await this.editConfig((config) => ({ ...config, minThinkingLevelByModel }));
  }

  async updateModelFallbacks(modelFallbacks: ModelFallbacks): Promise<void> {
    const sanitized = sanitizeModelFallbacks(modelFallbacks);
    await this.editConfig((config) => ({
      ...config,
      modelFallbacks: Object.keys(sanitized).length > 0 ? sanitized : undefined,
    }));
  }

  async updateModelPreferences(input: {
    defaultModel?: string;
    hiddenModels?: string[];
  }): Promise<void> {
    await this.editConfig((config) => {
      const next = { ...config };
      if (input.defaultModel !== undefined) {
        next.defaultModel = normalizeOptionalModelString(input.defaultModel);
      }
      if (input.hiddenModels !== undefined) {
        next.hiddenModels = normalizeOptionalModelStringArray(input.hiddenModels) ?? [];
        next.migrations = { ...next.migrations, hiddenModelsInitialized: true };
      }
      return next;
    });
  }

  async updateRuntimeEnablement(input: {
    runtimeEnablement?: Partial<Record<RuntimeEnablementId, boolean>> | null;
    defaultRuntime?: RuntimeEnablementId | null;
    runtimeOverridesEnabled?: boolean | null;
    projectPath?: string | null;
  }): Promise<void> {
    await this.editConfig((config) => {
      const shouldUpdateRuntimeEnablement = input.runtimeEnablement !== undefined;
      const shouldUpdateDefaultRuntime = input.defaultRuntime !== undefined;
      const shouldUpdateOverridesEnabled = input.runtimeOverridesEnabled !== undefined;
      const projectPath = input.projectPath?.trim();

      if (
        !shouldUpdateRuntimeEnablement &&
        !shouldUpdateDefaultRuntime &&
        !shouldUpdateOverridesEnabled
      ) {
        return config;
      }

      const runtimeEnablement =
        input.runtimeEnablement == null
          ? undefined
          : normalizeRuntimeEnablementOverrides(input.runtimeEnablement);
      const defaultRuntime = input.defaultRuntime ?? undefined;
      const runtimeOverridesEnabled = input.runtimeOverridesEnabled === true ? true : undefined;

      if (projectPath) {
        const project = config.projects.get(projectPath);
        if (!project) {
          log.warn("Runtime settings update requested for missing project", { projectPath });
          return config;
        }

        const nextProject = { ...project };
        if (shouldUpdateRuntimeEnablement) {
          if (runtimeEnablement) nextProject.runtimeEnablement = runtimeEnablement;
          else delete nextProject.runtimeEnablement;
        }
        if (shouldUpdateDefaultRuntime) {
          if (defaultRuntime) nextProject.defaultRuntime = defaultRuntime;
          else delete nextProject.defaultRuntime;
        }
        if (shouldUpdateOverridesEnabled) {
          if (runtimeOverridesEnabled) nextProject.runtimeOverridesEnabled = true;
          else delete nextProject.runtimeOverridesEnabled;
        }
        const nextProjects = new Map(config.projects);
        nextProjects.set(projectPath, nextProject);
        return { ...config, projects: nextProjects };
      }

      const next = { ...config };
      if (shouldUpdateRuntimeEnablement) {
        next.runtimeEnablement = runtimeEnablement;
      }
      if (shouldUpdateDefaultRuntime) {
        next.defaultRuntime = defaultRuntime;
      }
      return next;
    });
  }

  async saveUserConfig(input: {
    taskSettings?: unknown;
    userPreferences?: unknown;
    advisorModelString?: string | null;
    advisorThinkingLevel?: string | null;
    advisorMaxUsesPerTurn?: number | null;
    advisorMaxOutputTokens?: number | null;
    agentAiDefaults?: unknown;
  }): Promise<void> {
    await this.editConfig((config) => {
      const result = { ...config };

      if (input.taskSettings != null) {
        const inputRecord =
          input.taskSettings && typeof input.taskSettings === "object"
            ? (input.taskSettings as Record<string, unknown>)
            : {};
        const definedInput = Object.fromEntries(
          Object.entries(inputRecord).filter(([, value]) => value !== undefined)
        );
        // Preserve optional flags when older settings clients send only the required limits.
        result.taskSettings = normalizeTaskSettings({
          ...normalizeTaskSettings(config.taskSettings),
          ...definedInput,
        });
      }

      if (input.userPreferences !== undefined) {
        result.userPreferences = normalizeUserPreferences(input.userPreferences);
        result.migrations = {
          ...(result.migrations ?? {}),
          userPreferencesInitialized: true,
        };
      }

      if (input.advisorModelString !== undefined) {
        result.advisorModelString = parseOptionalNonEmptyString(input.advisorModelString);
      }
      if (input.advisorThinkingLevel !== undefined) {
        result.advisorThinkingLevel = parseOptionalThinkingLevel(input.advisorThinkingLevel);
      }
      if (input.advisorMaxUsesPerTurn !== undefined) {
        result.advisorMaxUsesPerTurn = normalizeAdvisorPositiveInteger(
          input.advisorMaxUsesPerTurn,
          "Advisor max uses per turn"
        );
      }
      if (input.advisorMaxOutputTokens !== undefined) {
        result.advisorMaxOutputTokens = normalizeAdvisorPositiveInteger(
          input.advisorMaxOutputTokens,
          "Advisor max output tokens"
        );
      }
      if (input.agentAiDefaults !== undefined) {
        const normalized = normalizeAgentAiDefaults(input.agentAiDefaults);
        result.agentAiDefaults = Object.keys(normalized).length > 0 ? normalized : undefined;
      }

      return result;
    });
  }

  /**
   * Internal queue primitive shared by editConfig and the load-time migration persist.
   * The migration persist must not call the public editConfig: that method is commonly
   * spied/overridden in tests, and the internally scheduled write is an implementation
   * detail rather than a caller-initiated mutation.
   */
  private enqueueConfigEdit(
    fn: (config: ProjectsConfig) => ProjectsConfig,
    registrationLock: RegistrationLockState
  ): Promise<void> {
    // Defer the fiber start to a microtask: Effect.runPromise executes fibers
    // synchronously on the caller's stack until the first async boundary, but the old
    // promise-chain queue always ran edit bodies on a later microtask.
    // loadConfigOrDefault's one-shot migrationPersist guard depends on that ordering:
    // the edit body's own loadConfigOrDefault must observe the `this.migrationPersist`
    // assignment, or a load-time migration would schedule its persist twice.
    // Effect failures reject this promise with the raw error (v4 runPromise does not
    // wrap causes), so callers observe the same rejections as before.
    return Promise.resolve().then(() =>
      Effect.runPromise(this.enqueueConfigEditEffect(fn, registrationLock))
    );
  }

  /**
   * Semaphore(1)-serialized edit pipeline: FIFO permits guarantee each edit's read
   * happens only after the previous edit's write has landed, replacing the old
   * promise-chain queue 1:1. The body is uninterruptible so an interruption can never
   * separate the corrupt-file gate from the write it approves, or drop the change
   * notification after a write landed; waiting for the permit stays interruptible (a
   * fiber cancelled while waiting never runs its edit).
   */
  private enqueueConfigEditEffect(
    fn: (config: ProjectsConfig) => ProjectsConfig,
    registrationLock: RegistrationLockState
  ): Effect.Effect<void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    /**
     * The transform on fresh bytes. Invoked exactly once per edit, since `fn` need not be
     * pure (callers run their own updaters and record results inside it): only after the
     * edit holds the lock it will write under, so no invocation's result is discarded.
     */
    const transform = (): ProjectsConfig => fn(self.loadConfigOrDefault());
    const write = Effect.fn(function* (
      newConfig: ProjectsConfig,
      lock: ProjectRegistrationLockHandle
    ) {
      // Effect.try keeps the pre-Effect contract: a rejected corrupt-file gate reaches the
      // caller as the raw original error.
      yield* Effect.try({
        try: () => self.assertConfigWritable(),
        catch: (error) => error,
      });
      // Every save happens under this process's hold of the registration lock: immediately
      // before the write, confirm the hold is still ours (see ProjectRegistrationLockHandle).
      // A whole-config save from a hold another process reclaimed would drop whatever that
      // process registered meanwhile, whether or not this edit touched the project set.
      yield* Effect.tryPromise({ try: () => lock.assertStillOwned(), catch: (error) => error });
      // Route through the saveConfig Promise facade (not saveConfigEffect) so test
      // spies on saveConfig keep intercepting the serialized write.
      yield* Effect.promise(async () => self.saveConfig(newConfig));
      // Backend-initiated config edits (for example gateway auth changes) use this signal
      // so frontend subscribers can refresh derived state without polling.
      self.notifyConfigChanged();
    });
    return this.editSemaphore.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          // Effect.try keeps the pre-Effect contract: a throwing transform or a rejected
          // corrupt-file gate reaches the caller as the raw original error.
          if (registrationLock.kind === "held") {
            const newConfig = yield* Effect.try({
              try: () => {
                const result = transform();
                self.assertConfigWritable();
                return result;
              },
              catch: (error) => error,
            });
            return yield* write(newConfig, registrationLock.lock);
          }
          // The gate runs here, before any lock work, so an unreadable config is refused for
          // that reason and not for a lockfile it could not create; `write` re-checks it
          // before saving. The load is what records a failed read for the gate; `fn` is not
          // invoked until the edit holds the lock.
          yield* Effect.try({
            try: () => {
              self.loadConfigOrDefault();
              self.assertConfigWritable();
            },
            catch: (error) => error,
          });
          // The file lock is tried here, inside the queue slot so the edit keeps its order.
          // Held elsewhere — by another process, or by a window in this one — the edit fails
          // the slot and editConfig waits for the lock outside the queue, behind any edit
          // already waiting; while one is, the lock is not even tried, since taking it would
          // put this edit ahead of that one. The transform runs only under the lock, on the
          // bytes as they are: whoever held it may have written config.json meanwhile.
          yield* Effect.tryPromise({
            try: async () => {
              if (self.lockWaiters !== null) {
                throw new ProjectRegistrationLockContended(self.joinLockWaiters(fn));
              }
              await using lock = await tryProjectRegistrationFileLock(self.rootDir);
              if (lock === null)
                throw new ProjectRegistrationLockContended(self.joinLockWaiters(fn));
              await Effect.runPromise(write(transform(), lock));
            },
            catch: (error) => error,
          });
        })
      )
    );
  }

  /**
   * The corrupt-file gate an edit passes immediately before writing. If the load failed,
   * writing would replace the corrupt file with defaults. Only proceed when the bytes on
   * disk right now are the ones with a confirmed sidecar: no confirmed backup, a concurrent
   * replacement since the load, or an unreadable file all reject the edit so callers do not
   * treat the mutation as durable (unlike saveConfig's log-and-swallow of unexpected I/O
   * errors, this skip is deliberate). A missing file is safe to overwrite. This cannot fully
   * close the cross-process race (that needs file locking, which editConfig has never had);
   * it binds the approval to the current bytes and shrinks the window to the atomic write
   * itself.
   */
  private assertConfigWritable(): void {
    const failureState = configLoadFailureStates.get(this.configFile);
    if (!failureState) return;
    const rejectEdit = (reason: string): never => {
      const message = `Skipping config write to ${this.configFile}: ${reason}`;
      log.error(message);
      throw new Error(message);
    };
    if (failureState.backupSignature === null) {
      rejectEdit(
        "the existing corrupt config has no confirmed backup yet. Fix the reported backup failure or move the corrupt file aside, then retry."
      );
    }
    let currentSignature: string | null = null;
    try {
      const currentBytes = fs.readFileSync(this.configFile);
      currentSignature = crypto.createHash("sha256").update(currentBytes).digest("hex");
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
        rejectEdit(
          `the file could not be re-read before writing (${readError instanceof Error ? readError.message : String(readError)}). Retry the settings change.`
        );
      }
    }
    if (currentSignature !== null && currentSignature !== failureState.backupSignature) {
      rejectEdit(
        "the file changed after this edit loaded it and the new content has no confirmed backup. Retry the settings change."
      );
    }
  }

  getUpdateChannel(): UpdateChannel {
    const config = this.loadConfigOrDefault();
    return config.updateChannel === "nightly" ? "nightly" : "stable";
  }

  getLlmDebugLogsEnabled(): boolean {
    return this.loadConfigOrDefault().llmDebugLogs === true;
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    await this.editConfig((config) => {
      config.updateChannel = channel;
      return config;
    });
  }

  /**
   * mDNS advertisement enablement.
   *
   * - true: attempt to advertise (will warn if the API server is loopback-only)
   * - false: never advertise
   * - undefined: "auto" (advertise only when the API server is LAN-reachable)
   */
  getMdnsAdvertisementEnabled(): boolean | undefined {
    const envOverride = parseOptionalEnvBoolean(
      resolveXumEnvironmentValue("MDNS_ADVERTISE", process.env)
    );
    if (envOverride !== undefined) {
      return envOverride;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsAdvertisementEnabled;
  }

  /** Optional DNS-SD service instance name override. */
  getMdnsServiceName(): string | undefined {
    const envName = parseOptionalNonEmptyString(
      resolveXumEnvironmentValue("MDNS_SERVICE_NAME", process.env)
    );
    if (envName) {
      return envName;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsServiceName;
  }

  /**
   * Get the configured SSH hostname for this server (used for editor deep links in browser mode).
   */
  getServerSshHost(): string | undefined {
    const config = this.loadConfigOrDefault();
    return config.serverSshHost;
  }

  /**
   * Get the configured GitHub username allowed to authenticate server/browser mode.
   */
  getServerAuthGithubOwner(): string | undefined {
    const envOwner = parseOptionalNonEmptyString(
      resolveXumEnvironmentValue("SERVER_AUTH_GITHUB_OWNER", process.env)
    );
    if (envOwner) {
      return envOwner;
    }

    const config = this.loadConfigOrDefault();
    return config.serverAuthGithubOwner;
  }
  private getProjectName(projectPath: string): string {
    return PlatformPaths.getProjectName(projectPath);
  }

  /**
   * Generate a stable unique workspace ID.
   * Uses 10 random hex characters for readability while maintaining uniqueness.
   *
   * Example: "a1b2c3d4e5"
   */
  generateStableId(): string {
    // Generate 5 random bytes and convert to 10 hex chars
    return crypto.randomBytes(5).toString("hex");
  }

  /**
   * DEPRECATED: Generate legacy workspace ID from project and workspace paths.
   * This method is used only for legacy workspace migration to look up old workspaces.
   * New workspaces use generateStableId() which returns a random stable ID.
   *
   * DO NOT use this method or its format to construct workspace IDs anywhere in the codebase.
   * Workspace IDs are backend implementation details and must only come from backend operations.
   */
  generateLegacyId(projectPath: string, workspacePath: string): string {
    const projectBasename = this.getProjectName(projectPath);
    const workspaceBasename = PlatformPaths.basename(workspacePath);
    return `${projectBasename}-${workspaceBasename}`;
  }

  /**
   * Get the workspace directory path for a given directory name.
   * The directory name is the workspace name (branch name).
   */

  /**
   * Add paths to WorkspaceMetadata to create FrontendWorkspaceMetadata.
   * Helper to avoid duplicating path computation logic.
   */
  private async addPathsToMetadata(
    metadata: WorkspaceMetadata,
    workspacePath: string,
    _projectPath: string
  ): Promise<FrontendWorkspaceMetadata> {
    const result: FrontendWorkspaceMetadata = {
      ...metadata,
      namedWorkspacePath: workspacePath,
    };

    // Check for incompatible runtime configs (from newer xum versions)
    if (isIncompatibleRuntimeConfig(metadata.runtimeConfig)) {
      result.incompatibleRuntime =
        `This workspace was created with a newer version of ${XUM_PRODUCT_NAME}. ` +
        `Please upgrade ${XUM_PRODUCT_NAME} to use this workspace.`;
    }

    // Mark worktree workspaces with missing checkout directories as transcript-only.
    // Queued/starting agent tasks can briefly exist without a provisioned checkout, so keep
    // those workspaces interactive until the checkout is created.
    const workspacePathExists = await fs.promises
      .access(workspacePath)
      .then(() => true)
      .catch(() => false);
    if (
      isWorktreeRuntime(metadata.runtimeConfig) &&
      metadata.taskStatus !== "queued" &&
      metadata.taskStatus !== "starting" &&
      !workspacePathExists
    ) {
      result.transcriptOnly = true;
    }

    return result;
  }

  /**
   * Find a workspace by ID.
   * @returns Stored config project key plus a separate attribution project path, or null
   */
  findWorkspace(
    workspaceId: string,
    options?: {
      /**
       * Propagate failures that hide a workspace's identity (unreadable or
       * unparseable config / legacy session metadata.json) instead of
       * skipping the entry. Callers making destructive "id is not
       * registered" decisions must use this: a lenient miss is
       * indistinguishable from a genuine absence.
       */
      throwOnError?: boolean;
    }
  ): {
    workspacePath: string;
    projectPath: string;
    attributionProjectPath?: string;
    projects?: Workspace["projects"];
    workspaceName?: string;
    parentWorkspaceId?: string;
    pendingAutoTitle?: boolean;
  } | null {
    const config = this.loadConfigOrDefault({ throwOnError: options?.throwOnError });

    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        const attributionProjectPath = workspace.projects?.[0]?.projectPath ?? projectPath;

        // NEW FORMAT: Check config first (primary source of truth after migration)
        if (workspace.id === workspaceId) {
          return {
            workspacePath: workspace.path,
            // Keep the stored config bucket key so mutation callers can round-trip into
            // config.projects.get(projectPath), even for multi-project workspaces under _multi.
            projectPath,
            attributionProjectPath,
            projects: workspace.projects,
            workspaceName: workspace.name,
            parentWorkspaceId: workspace.parentWorkspaceId,
            pendingAutoTitle: workspace.pendingAutoTitle,
          };
        }

        // LEGACY FORMAT: Fall back to metadata.json and legacy ID for unmigrated workspaces
        if (!workspace.id) {
          // Extract workspace basename (could be stable ID or legacy name)
          const workspaceBasename =
            workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

          // Try loading metadata with basename as ID (works for old workspaces)
          const metadataPath = path.join(
            path.join(this.sessionsDir, workspaceBasename),
            "metadata.json"
          );
          try {
            const data = fs.readFileSync(metadataPath, "utf-8");
            const metadata = JSON.parse(data) as WorkspaceMetadata;
            this.rememberLegacyTaskVariantWorkspace(projectPath, metadata, "metadata");
            // Parseable-but-id-less metadata (e.g. `{}`) leaves this entry's
            // identity unknowable: strict callers (the extension-metadata
            // discard) must not conclude "not registered" from it, or a live
            // workspace whose stable id lived only here gets its activity
            // deleted and write-tombstoned. Mirrors the strict enumeration
            // guard in getAllWorkspaceMetadata. The catch below rethrows this
            // for strict callers and keeps ignoring it for lenient ones.
            if (
              options?.throwOnError &&
              !(typeof metadata.id === "string" && metadata.id.length > 0)
            ) {
              throw new Error(
                `Legacy workspace metadata at ${metadataPath} resolved without a usable id`
              );
            }
            if (metadata.id === workspaceId) {
              return {
                workspacePath: workspace.path,
                projectPath,
                attributionProjectPath,
                projects: metadata.projects ?? workspace.projects,
                workspaceName: undefined,
                parentWorkspaceId: undefined,
              };
            }
          } catch (error) {
            // A genuinely missing file is the common case (most entries have
            // no legacy metadata.json). The entry's identity may live in an
            // unreadable/unparseable one though, so strict callers must not
            // conclude "absent" from a failed lookup.
            if (!isEnoentError(error) && options?.throwOnError) {
              throw error;
            }
            // Ignore errors, try legacy ID
          }

          // Authoritative legacy path: getAllWorkspaceMetadata resolves an
          // id-less entry's stable id from sessions/<generated-legacy-id>/
          // metadata.json (NOT the basename path above). Callers verifying
          // "is this id still registered" (e.g. the extension-metadata
          // discard) must see the same identity, or a stable id that lives
          // only in that file would be reported absent while its workspace
          // remains registered.
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          const legacyMetadataPath = path.join(
            path.join(this.sessionsDir, legacyId),
            "metadata.json"
          );
          try {
            const legacyData = fs.readFileSync(legacyMetadataPath, "utf-8");
            const legacyMetadata = JSON.parse(legacyData) as WorkspaceMetadata;
            this.rememberLegacyTaskVariantWorkspace(projectPath, legacyMetadata, "metadata");
            // Same unknowable-identity guard as the basename lookup above:
            // this is the authoritative file getAllWorkspaceMetadata resolves
            // stable ids from, so an id-less parse here must fail closed in
            // strict mode rather than fall through to "not registered".
            if (
              options?.throwOnError &&
              !(typeof legacyMetadata.id === "string" && legacyMetadata.id.length > 0)
            ) {
              throw new Error(
                `Legacy workspace metadata at ${legacyMetadataPath} resolved without a usable id`
              );
            }
            if (legacyMetadata.id === workspaceId) {
              return {
                workspacePath: workspace.path,
                projectPath,
                attributionProjectPath,
                projects: legacyMetadata.projects ?? workspace.projects,
                workspaceName: undefined,
                parentWorkspaceId: undefined,
              };
            }
          } catch (error) {
            // Same strict-mode contract as the basename lookup above.
            if (!isEnoentError(error) && options?.throwOnError) {
              throw error;
            }
            // Ignore errors, try legacy ID
          }

          // Try legacy ID format as last resort
          if (legacyId === workspaceId) {
            return {
              workspacePath: workspace.path,
              projectPath,
              attributionProjectPath,
              projects: workspace.projects,
              workspaceName: undefined,
              parentWorkspaceId: undefined,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Workspace Path Architecture:
   *
   * Workspace paths are computed on-demand from projectPath + workspace name using
   * config.getWorkspacePath(projectPath, directoryName). This ensures a single source of truth.
   *
   * - Worktree directory name: uses workspace.name (the branch name)
   * - Workspace ID: stable random identifier for identity and sessions (not used for directories)
   *
   * Backend: Uses getWorkspacePath(metadata.projectPath, metadata.name) for workspace directory paths
   * Frontend: Gets enriched metadata with paths via IPC (FrontendWorkspaceMetadata)
   *
   * WorkspaceMetadata.workspacePath is deprecated and will be removed. Use computed
   * paths from getWorkspacePath() or getWorkspacePaths() instead.
   */

  /**
   * Get all workspace metadata by loading config and metadata files.
   *
   * Returns FrontendWorkspaceMetadata with paths already computed.
   * This eliminates the need for separate "enrichment" - paths are computed
   * once during the loop when we already have all the necessary data.
   *
   * NEW BEHAVIOR: Config is the primary source of truth
   * - If workspace has id/name/createdAt in config, use those directly
   * - If workspace only has path, fall back to reading metadata.json
   * - Migrate old workspaces by copying metadata from files to config
   *
   * This centralizes workspace metadata in config.json and eliminates the need
   * for scattered metadata.json files (kept for backward compat with older versions).
   *
   * GUARANTEE: Every workspace returned will have a createdAt timestamp.
   * If missing from config or legacy metadata, a new timestamp is assigned and
   * saved to config for subsequent loads.
   */
  async getAllWorkspaceMetadata(options?: {
    /**
     * Throw on config read/parse failure instead of silently resolving with
     * the empty default. Callers that make destructive decisions based on
     * "workspace is not in config" (e.g. extension-metadata pruning) must use
     * this: the swallowed-failure default is indistinguishable from a truly
     * empty config. A missing config file still resolves as empty (healthy
     * fresh install), matching loadConfigOrDefault.
     */
    throwOnError?: boolean;
    /**
     * Out-parameter collecting ADDITIONAL stable ids that findWorkspace()
     * can resolve for id-less legacy entries but that are not the returned
     * entry's primary id: when both compatibility files
     * (sessions/<basename>/metadata.json and
     * sessions/<generated-legacy-id>/metadata.json) exist with different
     * ids, only the first becomes the metadata entry, yet the second
     * identity remains registered for targeted lookups. Destructive callers
     * building "known id" sets must include these aliases or they would
     * delete activity data findWorkspace still vouches for.
     */
    legacyAliasIds?: Set<string>;
  }): Promise<FrontendWorkspaceMetadata[]> {
    const config = this.loadConfigOrDefault({ throwOnError: options?.throwOnError });
    const workspaceMetadata: FrontendWorkspaceMetadata[] = [];
    // Read-time migrations recorded here are re-applied to a FRESH config snapshot inside
    // editConfig below. Persisting the local `config` snapshot directly (the old
    // saveConfig(config) call) raced concurrent removeWorkspace() edits and resurrected
    // removed workspace entries (lost-update). Each `apply` only fills still-missing fields
    // (??=), so re-application onto fresh state is idempotent and never clobbers newer data.
    const pendingWorkspaceMigrations: Array<{
      projectPath: string;
      /** Entry id as persisted on disk BEFORE this load's in-memory migrations. */
      persistedWorkspaceId: string | undefined;
      workspacePath: string;
      apply: (entry: Workspace) => void;
    }> = [];

    for (const [projectPath, projectConfig] of config.projects) {
      // Validate project path is not empty (defensive check for corrupted config)
      if (!projectPath) {
        log.warn("Skipping project with empty path in config", {
          workspaceCount: projectConfig.workspaces?.length ?? 0,
        });
        continue;
      }

      const projectName = this.getProjectName(projectPath);

      for (const workspace of projectConfig.workspaces) {
        // Extract workspace basename from path (could be stable ID or legacy name)
        const workspaceBasename =
          workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

        // Captured BEFORE any in-memory migration mutates workspace.id: the queued
        // replay must retarget by persisted identity, never by path alone — paths are
        // reusable after deletion, and applying a stale migration to a replacement
        // workspace at the same path would leak the old workspace's settings into it.
        const persistedWorkspaceId = workspace.id;
        const recordWorkspaceMigration = (
          migrationProjectPath: string,
          workspacePath: string,
          apply: (entry: Workspace) => void
        ) => {
          pendingWorkspaceMigrations.push({
            projectPath: migrationProjectPath,
            persistedWorkspaceId,
            workspacePath,
            apply,
          });
        };

        const workspaceProjects = workspace.projects?.length ? workspace.projects : undefined;
        const primaryWorkspaceProject = workspaceProjects?.[0];
        const resolvedProjectPath =
          workspace.kind === "scratch"
            ? workspace.path
            : (primaryWorkspaceProject?.projectPath ?? projectPath);
        const resolvedProjectName =
          workspace.kind === "scratch"
            ? SCRATCH_PROJECT_NAME
            : workspaceProjects
              ? workspaceProjects.map((projectRef) => projectRef.projectName).join("+")
              : projectName;

        try {
          // NEW FORMAT: If workspace has metadata in config, use it directly
          if (workspace.id && workspace.name) {
            const metadata: WorkspaceMetadata = {
              kind: workspace.kind,
              id: workspace.id,
              name: workspace.name,
              title: workspace.title,
              pendingAutoTitle: workspace.pendingAutoTitle,
              forkFamilyBaseName: workspace.forkFamilyBaseName,
              projectName: resolvedProjectName,
              projectPath: resolvedProjectPath,
              // GUARANTEE: All workspaces must have createdAt (assign now if missing)
              createdAt: workspace.createdAt ?? new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig (apply default if missing)
              runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              heartbeat: normalizeWorkspaceMetadataHeartbeat(workspace.heartbeat, config),
              goalDefaults: workspace.goalDefaults,
              // Display defaults stay ephemeral: no raw Exec bucket means no saved Exec choice.
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              agentId: workspace.agentId,
              tags: workspace.tags,
              workflowTask: workspace.workflowTask,
              bestOf: normalizeWorkspaceBestOf(workspace.bestOf),
              taskStatus: workspace.taskStatus,
              taskPendingGuidance: workspace.taskPendingGuidance,
              taskLaunchError: workspace.taskLaunchError,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              taskIsolation: workspace.taskIsolation,
              taskDesktopOwnerWorkspaceId: workspace.taskDesktopOwnerWorkspaceId,
              taskSticky: workspace.taskSticky,
              taskExecutionId: workspace.taskExecutionId,
              taskExecutionStatus: workspace.taskExecutionStatus,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              pinnedAt: workspace.pinnedAt,
              projects: workspaceProjects,
              subProjectPath: workspace.subProjectPath,
            };

            // Migrate missing createdAt to config for next load
            if (!workspace.createdAt) {
              workspace.createdAt = metadata.createdAt;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.createdAt ??= metadata.createdAt;
              });
            }

            if (!workspace.runtimeConfig) {
              workspace.runtimeConfig = metadata.runtimeConfig;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.runtimeConfig ??= metadata.runtimeConfig;
              });
            }

            if (!workspace.projects && metadata.projects) {
              workspace.projects = metadata.projects;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.projects ??= metadata.projects;
              });
            }

            // Populate containerName for Docker workspaces (computed from project path and workspace name)
            if (
              metadata.runtimeConfig?.type === "docker" &&
              !metadata.runtimeConfig.containerName
            ) {
              metadata.runtimeConfig = {
                ...metadata.runtimeConfig,
                containerName: getDockerContainerName(metadata.projectPath, metadata.name),
              };
            }

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
            continue; // Skip metadata file lookup
          }

          // LEGACY FORMAT: Fall back to reading metadata.json.
          // findWorkspace resolves an id-less entry's stable id from EITHER
          // sessions/<generated-legacy-id>/metadata.json or
          // sessions/<workspace-basename>/metadata.json (old layout).
          // Enumerate BOTH candidates: destructive callers (the
          // extension-metadata prune) classify ids as stale against this
          // enumeration, so a stable id that findWorkspace can resolve but
          // this walk cannot would be deleted as unknown.
          // The generated-legacy record stays CANONICAL when both exist:
          // this walk's primary id feeds the read-time config migration, and
          // it historically consulted only the generated-legacy file — making
          // a (potentially stale) basename-side file primary would rewrite
          // the workspace's persisted stable id on upgrade and orphan its
          // session history. The basename id is surfaced as an alias below;
          // it becomes primary only when it is the sole surviving record.
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          let metadataFound = false;

          let metadataPath = "";
          let legacyMetadataRaw: string | undefined;
          const candidateIds =
            workspaceBasename === legacyId ? [legacyId] : [legacyId, workspaceBasename];
          for (const candidateId of candidateIds) {
            const candidatePath = path.join(
              path.join(this.sessionsDir, candidateId),
              "metadata.json"
            );
            let candidateRaw: string | undefined;
            try {
              candidateRaw = fs.readFileSync(candidatePath, "utf-8");
            } catch (readError) {
              // Missing is normal (most entries never had a legacy
              // metadata.json). Any other failure means the workspace's
              // authoritative stable id is unknowable right now — surface it
              // to the catch below instead of silently substituting the
              // generated legacy path id via the !metadataFound branch.
              if (!isEnoentError(readError)) {
                // Secondary-candidate failure with a usable canonical
                // record already in hand: lenient loads keep the canonical
                // identity instead of discarding it for skeletal path-id
                // fallback metadata (which would surface the workspace
                // under the WRONG id with its session history apparently
                // missing). Destructive strict enumeration still fails
                // closed — the unreadable alias file may hide a registered
                // identity.
                if (legacyMetadataRaw !== undefined && !options?.throwOnError) {
                  continue;
                }
                throw readError;
              }
              continue;
            }
            if (legacyMetadataRaw === undefined) {
              legacyMetadataRaw = candidateRaw;
              metadataPath = candidatePath;
              continue;
            }
            // A SECOND resolvable compatibility file: findWorkspace() tries
            // every candidate, so its id stays registered for targeted
            // lookups even though only the first file becomes the metadata
            // entry. Surface it through the legacyAliasIds out-parameter so
            // destructive known-id sets retain it. findWorkspace consults
            // candidate files only for id-less entries; for a partially
            // migrated entry (inline id, no name) the alias is
            // over-inclusive, which errs toward retention, never deletion.
            // A corrupt or id-less second file leaves the alias identity
            // unknowable — fail closed in strict mode, mirroring the
            // primary lookup guards.
            let aliasMetadata: WorkspaceMetadata | undefined;
            try {
              aliasMetadata = JSON.parse(candidateRaw) as WorkspaceMetadata;
            } catch (parseError) {
              if (options?.throwOnError) {
                throw parseError;
              }
            }
            const aliasId = aliasMetadata?.id;
            if (typeof aliasId === "string" && aliasId.length > 0) {
              options?.legacyAliasIds?.add(aliasId);
            } else if (aliasMetadata !== undefined && options?.throwOnError) {
              throw new Error(
                `Legacy workspace metadata at ${candidatePath} resolved without a usable id`
              );
            }
          }
          if (legacyMetadataRaw !== undefined) {
            const metadata = JSON.parse(legacyMetadataRaw) as WorkspaceMetadata;
            const persistedAgentSettings = metadata.aiSettingsByAgent;
            this.rememberLegacyTaskVariantWorkspace(projectPath, metadata, "metadata");

            // Ensure required fields are present
            if (!metadata.name) metadata.name = workspaceBasename;
            if (!metadata.projectPath) metadata.projectPath = resolvedProjectPath;
            if (!metadata.projectName) metadata.projectName = resolvedProjectName;
            metadata.projects ??= workspaceProjects;

            // GUARANTEE: All workspaces must have createdAt
            metadata.createdAt ??= new Date().toISOString();

            // GUARANTEE: All workspaces must have runtimeConfig
            metadata.runtimeConfig ??= DEFAULT_RUNTIME_CONFIG;

            // Preserve any config-only fields that may not exist in legacy metadata.json
            metadata.kind ??= workspace.kind;
            metadata.aiSettingsByAgent ??=
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined);
            metadata.aiSettings ??= workspace.aiSettings;
            metadata.heartbeat ??= workspace.heartbeat;

            // Preserve tree/task metadata when present in config (metadata.json won't have it)
            metadata.parentWorkspaceId ??= workspace.parentWorkspaceId;
            metadata.agentType ??= workspace.agentType;
            metadata.agentId ??= workspace.agentId;
            metadata.workflowTask ??= workspace.workflowTask;
            metadata.bestOf = isLegacyTaskVariantGroup(metadata.bestOf)
              ? undefined
              : (normalizeWorkspaceBestOf(metadata.bestOf) ??
                normalizeWorkspaceBestOf(workspace.bestOf));
            metadata.taskStatus ??= workspace.taskStatus;
            metadata.taskPendingGuidance ??= workspace.taskPendingGuidance;
            metadata.taskLaunchError ??= workspace.taskLaunchError;
            metadata.reportedAt ??= workspace.reportedAt;
            metadata.taskModelString ??= workspace.taskModelString;
            metadata.taskThinkingLevel ??= workspace.taskThinkingLevel;
            metadata.taskPrompt ??= workspace.taskPrompt;
            metadata.taskTrunkBranch ??= workspace.taskTrunkBranch;
            // Preserve archived timestamps from config
            metadata.archivedAt ??= workspace.archivedAt;
            metadata.unarchivedAt ??= workspace.unarchivedAt;
            // Preserve sub-project assignment from config.
            metadata.subProjectPath ??= workspace.subProjectPath;
            metadata.forkFamilyBaseName ??= workspace.forkFamilyBaseName;
            metadata.tags ??= workspace.tags;

            // Persisted config identity fields win over metadata.json values. The queued
            // migration below uses ??= (it must never clobber concurrent edits), so any
            // field already present in config keeps its persisted value — returning a
            // different value here would hand the UI an ID that findWorkspace cannot
            // resolve until the next reload.
            metadata.id = workspace.id ?? metadata.id;
            // Strict callers make destructive "id is not known" decisions (the
            // extension-metadata prune): metadata.json that parses but carries
            // no usable id (e.g. `{}`, or a non-object like an array) resolves
            // to an id-less entry here, and the workspace's REAL stable id —
            // recorded nowhere else — would be classified as stale and its
            // activity data permanently deleted. Successful JSON parsing does
            // not establish identity; fail closed instead.
            if (
              options?.throwOnError &&
              !(typeof metadata.id === "string" && metadata.id.length > 0)
            ) {
              throw new Error(
                `Legacy workspace metadata at ${metadataPath} resolved without a usable id`
              );
            }
            metadata.name = workspace.name ?? metadata.name;
            metadata.createdAt = workspace.createdAt ?? metadata.createdAt;
            metadata.runtimeConfig = workspace.runtimeConfig ?? metadata.runtimeConfig;

            // Migrate genuine metadata buckets, never the display fallback above.
            if (!workspace.aiSettingsByAgent && persistedAgentSettings) {
              workspace.aiSettingsByAgent = persistedAgentSettings;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.aiSettingsByAgent ??= persistedAgentSettings;
              });
            }

            if (!workspace.heartbeat && metadata.heartbeat) {
              workspace.heartbeat = metadata.heartbeat;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.heartbeat ??= metadata.heartbeat;
              });
            }

            // Migrate to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            workspace.forkFamilyBaseName = metadata.forkFamilyBaseName;
            recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
              entry.id ??= metadata.id;
              entry.name ??= metadata.name;
              entry.createdAt ??= metadata.createdAt;
              entry.runtimeConfig ??= metadata.runtimeConfig;
              entry.forkFamilyBaseName ??= metadata.forkFamilyBaseName;
            });

            if (!workspace.projects && metadata.projects) {
              workspace.projects = metadata.projects;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.projects ??= metadata.projects;
              });
            }

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
            metadataFound = true;
          }

          // No metadata found anywhere - create basic metadata
          if (!metadataFound) {
            const legacyId = this.generateLegacyId(projectPath, workspace.path);
            const metadata: WorkspaceMetadata = {
              kind: workspace.kind,
              // Prefer already-persisted identity fields: the queued ??= migration below
              // keeps existing config values, so returning a generated legacyId for a
              // partially-migrated entry that already has an id would expose an ID that
              // findWorkspace cannot resolve until the next reload.
              id: workspace.id ?? legacyId,
              name: workspace.name ?? workspaceBasename,
              projectName: resolvedProjectName,
              projectPath: resolvedProjectPath,
              // GUARANTEE: All workspaces must have createdAt
              createdAt: workspace.createdAt ?? new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig
              runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              heartbeat: workspace.heartbeat,
              goalDefaults: workspace.goalDefaults,
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              agentId: workspace.agentId,
              tags: workspace.tags,
              workflowTask: workspace.workflowTask,
              bestOf: normalizeWorkspaceBestOf(workspace.bestOf),
              taskStatus: workspace.taskStatus,
              taskPendingGuidance: workspace.taskPendingGuidance,
              taskLaunchError: workspace.taskLaunchError,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              taskIsolation: workspace.taskIsolation,
              taskDesktopOwnerWorkspaceId: workspace.taskDesktopOwnerWorkspaceId,
              taskSticky: workspace.taskSticky,
              taskExecutionId: workspace.taskExecutionId,
              taskExecutionStatus: workspace.taskExecutionStatus,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              pinnedAt: workspace.pinnedAt,
              projects: workspaceProjects,
              subProjectPath: workspace.subProjectPath,
            };

            // Save to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
              entry.id ??= metadata.id;
              entry.name ??= metadata.name;
              entry.createdAt ??= metadata.createdAt;
              entry.runtimeConfig ??= metadata.runtimeConfig;
            });

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
          }
        } catch (error) {
          // Strict callers make destructive "id is not known" decisions (the
          // extension-metadata prune): for a legacy entry whose stable id
          // lives only in its unreadable/unparseable metadata.json, the
          // generated-path-id fallback below would classify the real id's
          // entries as stale. Propagate the identity-lookup failure instead.
          if (options?.throwOnError) {
            throw error;
          }
          log.error(`Failed to load/migrate workspace metadata:`, error);
          // Fallback to basic metadata if migration fails
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          const metadata: WorkspaceMetadata = {
            kind: workspace.kind,
            // Same invariant as the branches above: never return an ID/name that
            // diverges from a value already persisted in config.
            id: workspace.id ?? legacyId,
            name: workspace.name ?? workspaceBasename,
            projectName: resolvedProjectName,
            projectPath: resolvedProjectPath,
            // GUARANTEE: All workspaces must have createdAt (even in error cases)
            createdAt: workspace.createdAt ?? new Date().toISOString(),
            // GUARANTEE: All workspaces must have runtimeConfig (even in error cases)
            runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
            aiSettings: workspace.aiSettings,
            heartbeat: workspace.heartbeat,
            goalDefaults: workspace.goalDefaults,
            aiSettingsByAgent:
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined),
            parentWorkspaceId: workspace.parentWorkspaceId,
            agentType: workspace.agentType,
            agentId: workspace.agentId,
            tags: workspace.tags,
            workflowTask: workspace.workflowTask,
            bestOf: workspace.bestOf,
            taskStatus: workspace.taskStatus,
            taskPendingGuidance: workspace.taskPendingGuidance,
            taskLaunchError: workspace.taskLaunchError,
            reportedAt: workspace.reportedAt,
            taskModelString: workspace.taskModelString,
            taskThinkingLevel: workspace.taskThinkingLevel,
            taskPrompt: workspace.taskPrompt,
            taskTrunkBranch: workspace.taskTrunkBranch,
            taskIsolation: workspace.taskIsolation,
            taskDesktopOwnerWorkspaceId: workspace.taskDesktopOwnerWorkspaceId,
            taskSticky: workspace.taskSticky,
            taskExecutionId: workspace.taskExecutionId,
            taskExecutionStatus: workspace.taskExecutionStatus,
            projects: workspaceProjects,
            subProjectPath: workspace.subProjectPath,
          };

          workspaceMetadata.push(
            await this.addPathsToMetadata(metadata, workspace.path, projectPath)
          );
        }
      }
    }

    // Persist migrated workspace fields under the editConfig queue, re-resolving each
    // entry from the fresh snapshot. Entries removed concurrently are skipped so this
    // write can never resurrect them. Matching is by persisted identity: entries with
    // an id must match by id, and only id-less legacy entries may match by path — a
    // path match with a different id is a replacement workspace that must not inherit
    // the removed workspace's migrated settings.
    if (pendingWorkspaceMigrations.length > 0) {
      await this.editConfig((freshConfig) => {
        for (const migration of pendingWorkspaceMigrations) {
          const project = freshConfig.projects.get(migration.projectPath);
          const entry = migration.persistedWorkspaceId
            ? project?.workspaces.find(
                (candidate) => candidate.id === migration.persistedWorkspaceId
              )
            : project?.workspaces.find(
                (candidate) => candidate.path === migration.workspacePath && !candidate.id
              );
          if (!entry) continue; // workspace removed concurrently — do not resurrect
          migration.apply(entry);
        }
        return freshConfig;
      });
    }

    return workspaceMetadata;
  }

  /**
   * Add a workspace to config.json (single source of truth for workspace metadata).
   * Creates project entry if it doesn't exist.
   *
   * @param projectPath Absolute path to the project
   * @param metadata Workspace metadata to save
   */
  async addWorkspace(
    projectPath: string,
    metadata: WorkspaceMetadata & { namedWorkspacePath?: string }
  ): Promise<void> {
    await this.editConfig((config) => {
      let project = config.projects.get(projectPath);

      if (!project) {
        project = { workspaces: [] };
        config.projects.set(projectPath, project);
      }

      // Check if workspace already exists (by ID)
      const existingIndex = project.workspaces.findIndex((w) => w.id === metadata.id);

      // Use provided namedWorkspacePath if available (runtime-aware),
      // otherwise fall back to worktree-style path for legacy compatibility
      const projectName = this.getProjectName(projectPath);
      const workspacePath =
        metadata.namedWorkspacePath ?? path.join(this.srcDir, projectName, metadata.name);
      const workspaceEntry: Workspace = {
        path: workspacePath,
        kind: metadata.kind,
        id: metadata.id,
        name: metadata.name,
        title: metadata.title,
        pendingAutoTitle: metadata.pendingAutoTitle,
        forkFamilyBaseName: metadata.forkFamilyBaseName,
        createdAt: metadata.createdAt,
        aiSettingsByAgent: metadata.aiSettingsByAgent,
        runtimeConfig: metadata.runtimeConfig,
        aiSettings: metadata.aiSettings,
        heartbeat: metadata.heartbeat,
        goalDefaults: metadata.goalDefaults,
        parentWorkspaceId: metadata.parentWorkspaceId,
        agentType: metadata.agentType,
        agentId: metadata.agentId,
        tags: metadata.tags,
        workflowTask: metadata.workflowTask,
        bestOf: normalizeWorkspaceBestOf(metadata.bestOf),
        taskStatus: metadata.taskStatus,
        taskPendingGuidance: metadata.taskPendingGuidance,
        taskLaunchError: metadata.taskLaunchError,
        reportedAt: metadata.reportedAt,
        taskModelString: metadata.taskModelString,
        taskThinkingLevel: metadata.taskThinkingLevel,
        taskPrompt: metadata.taskPrompt,
        taskTrunkBranch: metadata.taskTrunkBranch,
        taskIsolation: metadata.taskIsolation,
        taskDesktopOwnerWorkspaceId: metadata.taskDesktopOwnerWorkspaceId,
        taskSticky: metadata.taskSticky,
        taskExecutionId: metadata.taskExecutionId,
        taskExecutionStatus: metadata.taskExecutionStatus,
        archivedAt: metadata.archivedAt,
        unarchivedAt: metadata.unarchivedAt,
        pinnedAt: metadata.pinnedAt,
        projects: metadata.projects,
        subProjectPath: metadata.subProjectPath,
      };

      if (existingIndex >= 0) {
        // Update existing workspace
        project.workspaces[existingIndex] = workspaceEntry;
      } else {
        // Add new workspace
        project.workspaces.push(workspaceEntry);
      }

      return config;
    });
  }

  /**
   * Remove a workspace from config.json
   *
   * @param workspaceId ID of the workspace to remove
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.editConfig((config) => {
      let workspaceFound = false;

      for (const [_projectPath, project] of config.projects) {
        const index = project.workspaces.findIndex((w) => w.id === workspaceId);
        if (index !== -1) {
          project.workspaces.splice(index, 1);
          workspaceFound = true;
          // We don't break here in case duplicates exist (though they shouldn't)
        }
      }

      if (!workspaceFound) {
        log.warn(`Workspace ${workspaceId} not found in config during removal`);
      }

      return config;
    });
  }

  /**
   * Update workspace metadata fields (e.g., regenerate missing title/branch)
   * Used to fix incomplete metadata after errors or restarts
   */
  async updateWorkspaceMetadata(
    workspaceId: string,
    updates: Partial<Pick<WorkspaceMetadata, "name" | "runtimeConfig">>
  ): Promise<void> {
    await this.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          if (updates.name !== undefined) workspace.name = updates.name;
          if (updates.runtimeConfig !== undefined) workspace.runtimeConfig = updates.runtimeConfig;
          return config;
        }
      }
      throw new Error(`Workspace ${workspaceId} not found in config`);
    });
  }
}

export interface ConfigStores {
  config: Config;
  sessionLocator: WorkspaceSessionLocator;
  providersConfigStore: ProvidersConfigStore;
  secretsStore: SecretsStore;
  fileLeaseManager: FileLeaseManager;
}

export function createConfigStores(rootDir?: string): ConfigStores {
  const sessionLocator = new WorkspaceSessionLocator(rootDir);
  const providersConfigStore = new ProvidersConfigStore(sessionLocator.rootDir);
  const secretsStore = new SecretsStore(sessionLocator.rootDir);
  const fileLeaseManager = new FileLeaseManager(sessionLocator.rootDir);
  const config = new Config(sessionLocator.rootDir, providersConfigStore);
  return { config, sessionLocator, providersConfigStore, secretsStore, fileLeaseManager };
}

const defaultStores = createConfigStores();
export const defaultConfig = defaultStores.config;
