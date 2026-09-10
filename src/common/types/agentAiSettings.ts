/**
 * Shared contract for the unified agent AI-settings resolver.
 *
 * One field-wise precedence order (implemented in
 * src/common/utils/ai/resolveAgentAiSettings.ts) covers every execution
 * surface: interactive turns, delegated tasks, goals, heartbeats, compaction,
 * startup recovery, ACP, and CLI. Adapters gather these inputs from their
 * environment; the pure resolver only chooses values.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "./agentAiDefaults";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "./thinking";

/**
 * Which configured profile applies: "subagent" (delegated task runs) reads an
 * agent's sparse `subagent` override profile before its base fields;
 * "interactive" ignores the delegated profile entirely.
 */
export type AgentAiProfile = "interactive" | "subagent";

/** One candidate layer's field values, already gathered by an adapter. */
export interface AgentAiSettingsLayerValues {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  reasoningMode?: OpenAIReasoningMode;
}

/** Agent-definition frontmatter `ai` block defaults. */
export interface AgentAiDefinitionDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Maps a persisted target-workspace AI-settings bucket into a tier-2 layer.
 * Buckets always carry model + thinkingLevel, and an absent reasoningMode
 * means "standard" (see WorkspaceAISettingsSchema), so an existing bucket owns
 * the reasoning choice outright: lower tiers must not re-inject a configured
 * pro default over a workspace deliberately running standard. Calling-chat Exec
 * inheritance also preserves this choice. Generic fallback (tier 7) layers must
 * not use this mapping; there, absent reasoning falls through to the next layer.
 */
export function targetWorkspaceBucketToLayer(bucket: {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  reasoningMode?: OpenAIReasoningMode;
}): AgentAiSettingsLayerValues {
  return {
    model: bucket.model,
    thinkingLevel: bucket.thinkingLevel,
    reasoningMode: coerceOpenAIReasoningMode(bucket.reasoningMode) ?? "standard",
  };
}

export type AiSettingTier =
  | "explicit"
  | "workspace"
  | "config-subagent"
  | "parent-workspace-exec"
  | "config"
  | "definition"
  | "parent-runtime"
  | "fallback"
  | "default";

export interface AiSettingSource {
  tier: AiSettingTier;
  /** For config/definition tiers: the agent whose entry supplied the value. */
  agentId?: string;
}

/**
 * One declared ancestor from the target agent's `base` chain. Adapters pass
 * declared ancestors only; the resolver itself appends the implicit fallback
 * base (plan -> plan, otherwise exec) as a reasoningMode-only layer.
 */
export interface AgentAiAncestorLayer {
  agentId: string;
  definitionAiDefaults?: AgentAiDefinitionDefaults;
}

export interface ResolveAgentAiSettingsInput {
  targetAgentId: string;
  profile: AgentAiProfile;
  /** Tier 1: explicit invocation overrides (tool args, CLI flags, slash commands). */
  explicit?: {
    model?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
  };
  /** Tier 2: the target workspace's per-agent bucket (existing target workspaces only). */
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  /**
   * Calling-workspace Exec context for Exec sub-agents only: below explicit
   * sub-agent defaults, above global Exec defaults. Not an invocation override
   * or the active parent runtime model (which may be Plan).
   */
  parentWorkspaceExecSettings?: AgentAiSettingsLayerValues;
  /** Tiers 3 and 5: canonical configured defaults map. */
  agentAiDefaults?: AgentAiDefaults;
  /** Tier 4: the target agent's definition frontmatter `ai` block. */
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  /** Tier 5: declared ancestors ordered child to root, excluding the target itself. */
  ancestors?: readonly AgentAiAncestorLayer[];
  /** Tier 6: ephemeral parent runtime settings for a newly spawned task or continuation. */
  parentRuntime?: AgentAiSettingsLayerValues;
  /** Tier 7: root workspace or activity fallbacks, highest priority first. */
  fallbacks?: readonly AgentAiSettingsLayerValues[];
  /** Tier 8: system fallback model; DEFAULT_MODEL when omitted. */
  defaultModel?: string;
  providersConfig?: ProvidersConfigMap | null;
  /** Per-model minimum thinking floors (config.minThinkingLevelByModel). */
  minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  /**
   * Route-aware pro-mode availability computed by the adapter. When omitted the
   * resolver falls back to providersConfig-based capability gating.
   */
  proModeAvailable?: boolean;
}

export interface ResolvedAgentAiSettings {
  /** The user's or inherited preference; what persistence stores. */
  selected: {
    model: string;
    thinkingLevel: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
  };
  /** Provider-safe values after normalization, clamping, and capability gating. */
  effective: {
    model: string;
    thinkingLevel: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
  };
  sources: {
    model: AiSettingSource;
    thinkingLevel: AiSettingSource;
    reasoningMode?: AiSettingSource;
  };
  /** Skipped-candidate notes for adapters to log; never logged here. */
  diagnostics: string[];
}
