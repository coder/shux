/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import type {
  AppConfigMigrations,
  ModelFallbacks,
  UpdateChannel,
} from "@/common/config/schemas/appConfigOnDisk";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import type { SettingsBackup } from "@/common/config/schemas/settingsBackup";
import type { z } from "zod";
import type { ProjectConfigSchema, WorkspaceConfigSchema } from "../orpc/schemas";
import type { AgentAiDefaults } from "./agentAiDefaults";
import type { RuntimeEnablementId } from "./runtime";
import type { TaskSettings } from "./tasks";
import type { LayoutPresetsConfig } from "./uiLayouts";
import type { OpenAIReasoningMode, ThinkingLevel } from "./thinking";
import type { GoalDefaults } from "@/constants/goals";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type { UpdateChannel };

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
  /**
   * Update channel preference for Electron desktop app. Defaults to "stable".
   */
  updateChannel?: UpdateChannel;
  /**
   * Bind host/interface for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to 127.0.0.1 (localhost only).
   * When set to 0.0.0.0 or ::, mux can be reachable from other devices on your LAN/VPN.
   * When set to a Tailscale interface address, mux listens only on that tailnet device.
   */
  apiServerBindHost?: string;
  /**
   * Port for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to port 0 (random available port).
   */
  apiServerPort?: number;
  /**
   * When true, the desktop HTTP server also serves the mux web UI at /.
   *
   * This enables other devices (LAN/VPN) to open mux in a browser.
   */
  apiServerServeWebUi?: boolean;
  /**
   * Advertise the API server on the local network via mDNS/Bonjour (DNS-SD).
   *
   * When unset, mux uses "auto" behavior (advertise only when apiServerBindHost is non-loopback).
   */
  mdnsAdvertisementEnabled?: boolean;
  /** Optional mDNS DNS-SD service instance name override. */
  mdnsServiceName?: string;
  /** SSH hostname/alias for this machine (used for editor deep links in browser mode) */
  serverSshHost?: string;
  /**
   * Optional GitHub username allowed to authenticate server/browser mode via Device Flow.
   *
   * When unset, GitHub login is disabled and token-only auth remains in effect.
   */
  serverAuthGithubOwner?: string;
  /**
   * Default parent directory for new projects (cloning and bare-name creation).
   *
   * When unset, falls back to getXumProjectsDir() (~/.xum/projects).
   */
  defaultProjectDir?: string;
  /** IDs of splash screens that have been viewed */
  viewedSplashScreens?: string[];
  /** User preferences shared across local browser origins through ~/.xum/config.json. */
  userPreferences?: UserPreferences;
  /** Global task settings (agent sub-workspaces, queue limits, nesting depth) */
  taskSettings?: TaskSettings;
  /** UI layout presets + hotkeys (shared via ~/.xum/config.json). */
  layoutPresets?: LayoutPresetsConfig;
  /** Let chat transcripts use the full chat pane width instead of the default readable column. */
  chatTranscriptFullWidth?: boolean;
  /**
   * Xum Gateway routing preferences (shared via ~/.xum/config.json).
   * Mirrors browser localStorage so switching server ports doesn't reset the UI.
   */
  muxGatewayEnabled?: boolean;
  /** Enable recording AI SDK devtools logs to ~/.xum/sessions/<workspace>/devtools.jsonl */
  llmDebugLogs?: boolean;
  /** Default heartbeat prompt used when a workspace heartbeat does not set its own message. */
  heartbeatDefaultPrompt?: string;
  /** Default heartbeat interval used when a workspace heartbeat does not set its own cadence. */
  heartbeatDefaultIntervalMs?: number;
  /** Global defaults for new workspace goals. */
  goalDefaults?: GoalDefaults;
  muxGatewayModels?: string[];
  routePriority?: string[];
  routeOverrides?: Record<string, string>;
  /**
   * Per-model minimum thinking level (keyed by canonical model id). Hides thinking
   * levels below the floor in the thinking slider. Omitted entries fall back to the
   * built-in default (medium for reasoning-capable models).
   */
  minThinkingLevelByModel?: Record<string, ThinkingLevel>;

  /**
   * Per-model refusal-fallback chains (keyed by canonical source model). When a
   * model refuses, the turn retries or continues on the next chain model.
   */
  modelFallbacks?: ModelFallbacks;

  /**
   * Named model classes (e.g. large/medium/small → a model alias or
   * "provider:model" id with an optional "+thinking" suffix, one-shot syntax).
   * Indirection layer so bindings survive model churn; consumed by per-skill
   * model routing.
   */
  modelClasses?: Record<string, string>;
  /**
   * Per-skill routing table (skill name → class name in modelClasses). Wins
   * over a skill's own frontmatter metadata "model-class" binding.
   */
  skillModelClasses?: Record<string, string>;

  /**
   * Default model used for new workspaces (shared via ~/.xum/config.json).
   * Mirrors the browser localStorage cache (DEFAULT_MODEL_KEY).
   */
  defaultModel?: string;
  /** Global advisor model override for the experimental advisor tool. */
  advisorModelString?: string;
  /** Global advisor reasoning override for the experimental advisor tool. */
  advisorThinkingLevel?: ThinkingLevel;
  /** Advisor Pro/Standard selection, independent of effort and the parent chat mode. */
  advisorReasoningMode?: OpenAIReasoningMode;
  /** Positive per-turn advisor cap; null/undefined means unlimited. */
  advisorMaxUsesPerTurn?: number | null;
  /** Positive max-output-tokens cap for advisor responses; null/undefined means unlimited. */
  advisorMaxOutputTokens?: number | null;
  /**
   * Hidden model IDs (shared via ~/.xum/config.json).
   * Mirrors the browser localStorage cache (HIDDEN_MODELS_KEY).
   */
  hiddenModels?: string[];
  /**
   * Default model/thinking/reasoning overrides per agentId. Base fields are the
   * interactive profile; the sparse nested `subagent` profile holds
   * delegated-run differences (see AgentAiDefaultsEntrySchema).
   */
  agentAiDefaults?: AgentAiDefaults;
  /** Internal one-time migration markers. Not surfaced in user-facing config UI. */
  migrations?: AppConfigMigrations;
  /** Use built-in SSH2 library instead of system OpenSSH for remote connections (non-Windows only) */
  useSSH2Transport?: boolean;

  /** Xum Governor server URL (normalized origin, no trailing slash) */
  muxGovernorUrl?: string;
  /** Xum Governor OAuth access token (secret - never return to UI) */
  muxGovernorToken?: string;

  /**
   * What to do with a dedicated mux-created Coder workspace when its chat is archived.
   * Defaults to `"stop"` to preserve existing behavior.
   */
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;

  /**
   * What to do with mux-managed worktree checkouts when a chat is archived.
   *
   * - `"keep"`: leave the checkout on disk.
   * - `"delete"`: delete the checkout without a restore snapshot.
   * - `"snapshot"`: capture a durable restore snapshot, then delete the checkout.
   *
   * Defaults to `"keep"` when absent from config.json.
   */
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;

  /**
   * Legacy boolean shim for downgrade compatibility.
   *
   * Stored as `true` only for the new `worktreeArchiveBehavior: "delete"` mode.
   * `false` disables deletion for older builds and is also used for `"snapshot"`.
   */
  deleteWorktreeOnArchive?: boolean;

  /**
   * Legacy boolean shim for downgrade compatibility.
   *
   * Stored as `false` only (undefined behaves as true) to keep config.json minimal.
   */
  stopCoderWorkspaceOnArchive?: boolean;

  /** Global default runtime for new workspaces. */
  defaultRuntime?: RuntimeEnablementId;

  /**
   * Override the default shell for local integrated terminals.
   *
   * When set, all local terminals (not SSH/Docker/Devcontainer) spawn this shell
   * instead of auto-detecting from $SHELL or platform defaults.
   *
   * Accepts an absolute path (e.g. "/usr/bin/fish") or a command name (e.g. "fish").
   */
  terminalDefaultShell?: string;

  /**
   * Runtime enablement overrides (shared via ~/.xum/config.json).
   * Defaults to enabled; store `false` only to keep config.json minimal.
   */
  runtimeEnablement?: Partial<Record<RuntimeEnablementId, false>>;

  settingsBackup?: SettingsBackup;

  /**
   * Legacy 1Password account name. The integration was removed; the value is
   * preserved across saves (never used at runtime) so downgrading restores a
   * working 1Password setup without re-entering the account.
   */
  legacyOnePasswordAccountName?: string;
}
