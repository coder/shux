/**
 * Telemetry ORPC schemas
 *
 * Defines input/output schemas for backend telemetry endpoints.
 * Telemetry is controlled by MUX_DISABLE_TELEMETRY env var on the backend.
 */

import { z } from "zod";
import { ThinkingLevelSchema } from "../../types/thinking";
import { MCPTransportSchema } from "./mcp";
import { RuntimeModeSchema } from "./runtime";

// Error context enum (matches payload.ts)
const ErrorContextSchema = z.enum([
  "workspace-creation",
  "workspace-deletion",
  "workspace-switch",
  "message-send",
  "message-stream",
  "project-add",
  "project-remove",
  "git-operation",
]);

// Runtime type - derived from RuntimeModeSchema to stay in sync
const TelemetryRuntimeTypeSchema = RuntimeModeSchema;

// Frontend platform info (matches payload.ts FrontendPlatformInfo)
const FrontendPlatformInfoSchema = z.object({
  userAgent: z.string(),
  platform: z.string(),
});

// Command type enum (matches payload.ts TelemetryCommandType)
const TelemetryCommandTypeSchema = z.enum([
  "clear",
  "clear:hard",
  "clear:soft",
  "compact",
  "new",
  "fork",
  "vim",
  "model",
  "mode",
  "plan",
  "providers",
  "goal",
  "workflow",
]);

// Individual event payload schemas
const AppStartedPropertiesSchema = z.object({
  isFirstLaunch: z.boolean(),
  vimModeEnabled: z.boolean(),
});

const WorkspaceCreatedPropertiesSchema = z.object({
  workspaceId: z.string(),
  runtimeType: TelemetryRuntimeTypeSchema,
  frontendPlatform: FrontendPlatformInfoSchema,
});

const WorkspaceSwitchedPropertiesSchema = z.object({
  fromWorkspaceId: z.string(),
  toWorkspaceId: z.string(),
});

const MessageSentPropertiesSchema = z.object({
  workspaceId: z.string(),
  model: z.string(),
  agentId: z.string().min(1).optional().catch(undefined),
  message_length_b2: z.number(),
  runtimeType: TelemetryRuntimeTypeSchema,
  frontendPlatform: FrontendPlatformInfoSchema,
  thinkingLevel: ThinkingLevelSchema,
});

// MCP transport mode enum (matches payload.ts TelemetryMCPTransportMode)
const TelemetryMCPTransportModeSchema = z.enum([
  "none",
  "stdio_only",
  "http_only",
  "sse_only",
  "mixed",
]);

const MCPContextInjectedPropertiesSchema = z.object({
  workspaceId: z.string(),
  model: z.string(),
  agentId: z.string().min(1).optional().catch(undefined),
  runtimeType: TelemetryRuntimeTypeSchema,

  mcp_server_enabled_count: z.number(),
  mcp_server_started_count: z.number(),
  mcp_server_failed_count: z.number(),

  mcp_tool_count: z.number(),
  total_tool_count: z.number(),
  builtin_tool_count: z.number(),

  mcp_transport_mode: TelemetryMCPTransportModeSchema,
  mcp_has_http: z.boolean(),
  mcp_has_sse: z.boolean(),
  mcp_has_stdio: z.boolean(),
  mcp_auto_fallback_count: z.number(),
  mcp_setup_duration_ms_b2: z.number(),
});

const TelemetryMCPTestErrorCategorySchema = z.enum([
  "timeout",
  "connect",
  "http_status",
  "unknown",
]);

const MCPServerTestedPropertiesSchema = z.object({
  transport: MCPTransportSchema,
  success: z.boolean(),
  duration_ms_b2: z.number(),
  error_category: TelemetryMCPTestErrorCategorySchema.optional(),
});

const TelemetryMCPServerConfigActionSchema = z.enum([
  "add",
  "edit",
  "remove",
  "enable",
  "disable",
  "set_tool_allowlist",
  "set_headers",
]);

const StatsTabOpenedPropertiesSchema = z.object({
  viewMode: z.enum(["session", "last-request"]),
  showModeBreakdown: z.boolean(),
});

const StreamTimingComputedPropertiesSchema = z.object({
  model: z.string(),
  agentId: z.string().min(1).optional().catch(undefined),
  duration_b2: z.number(),
  ttft_ms_b2: z.number(),
  tool_ms_b2: z.number(),
  streaming_ms_b2: z.number(),
  tool_percent_bucket: z.number(),
  invalid: z.boolean(),
});

const StreamTimingInvalidPropertiesSchema = z.object({
  reason: z.string(),
});

const MCPServerConfigChangedPropertiesSchema = z.object({
  action: TelemetryMCPServerConfigActionSchema,
  transport: MCPTransportSchema,
  has_headers: z.boolean(),
  uses_secret_headers: z.boolean(),
  tool_allowlist_size_b2: z.number().optional(),
});

const TelemetryMCPOAuthFlowErrorCategorySchema = z.enum([
  "timeout",
  "cancelled",
  "state_mismatch",
  "provider_error",
  "unknown",
]);

const MCPOAuthFlowStartedPropertiesSchema = z.object({
  transport: MCPTransportSchema,
  has_scope_hint: z.boolean(),
  has_resource_metadata_hint: z.boolean(),
});

const MCPOAuthFlowCompletedPropertiesSchema = z.object({
  transport: MCPTransportSchema,
  duration_ms_b2: z.number(),
  has_scope_hint: z.boolean(),
  has_resource_metadata_hint: z.boolean(),
});

const MCPOAuthFlowFailedPropertiesSchema = z.object({
  transport: MCPTransportSchema,
  duration_ms_b2: z.number(),
  has_scope_hint: z.boolean(),
  has_resource_metadata_hint: z.boolean(),
  error_category: TelemetryMCPOAuthFlowErrorCategorySchema,
});

export const AdvisorCallCompletedPropertiesSchema = z.object({
  call_id: z.string(),
  parent_turn_id: z.string().optional(),
  provider_route: z.string().nullable(),
  workspaceId: z.string().optional(),
  model: z.string(),
  outcome: z.enum(["success", "error", "cancelled"]),
  call_index: z.number(),
  // This gap covers the current tool instance, not the whole workspace history.
  previous_call_gap_ms_b2: z.number().nullable(),
  duration_ms_b2: z.number(),
  time_to_first_token_ms_b2: z.number().nullable(),
  usage_available: z.boolean(),
  input_tokens_b2: z.number().nullable(),
  uncached_input_tokens_b2: z.number().nullable(),
  cache_read_tokens_b2: z.number().nullable(),
  cache_write_tokens_b2: z.number().nullable(),
  output_tokens_b2: z.number().nullable(),
  // Request markers do not prove that the provider accepts or reuses the cache.
  cache_marker_count: z.number(),
  cache_ttl: z.enum(["5m", "1h", "mixed", "unknown"]),
  // Estimates use catalog rates, not invoice charges. Null means unknown.
  input_cost_usd_b2: z.number().nullable(),
  cache_write_premium_usd_b2: z.number().nullable(),
  cache_read_savings_usd_b2: z.number().nullable(),
  cache_net_savings_usd_b2: z.number().nullable(),
});

const StreamCompletedPropertiesSchema = z.object({
  model: z.string(),
  wasInterrupted: z.boolean(),
  duration_b2: z.number(),
  output_tokens_b2: z.number(),
});

const CompactionCompletedPropertiesSchema = z.object({
  model: z.string(),
  duration_b2: z.number(),
  input_tokens_b2: z.number(),
  output_tokens_b2: z.number(),
  compaction_source: z.enum(["manual", "idle"]),
});

const ProviderConfiguredPropertiesSchema = z.object({
  provider: z.string(),
  keyType: z.string(),
});

const CommandUsedPropertiesSchema = z.object({
  command: TelemetryCommandTypeSchema,
});

const VoiceTranscriptionPropertiesSchema = z.object({
  audio_duration_b2: z.number(),
  success: z.boolean(),
});

const ErrorOccurredPropertiesSchema = z.object({
  errorType: z.string(),
  context: ErrorContextSchema,
});

const ExperimentOverriddenPropertiesSchema = z.object({
  experimentId: z.string(),
  userChoice: z.boolean(),
});

// Union of all telemetry events
export const TelemetryEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("advisor_call_completed"),
    properties: AdvisorCallCompletedPropertiesSchema,
  }),
  z.object({
    event: z.literal("app_started"),
    properties: AppStartedPropertiesSchema,
  }),
  z.object({
    event: z.literal("workspace_created"),
    properties: WorkspaceCreatedPropertiesSchema,
  }),
  z.object({
    event: z.literal("workspace_switched"),
    properties: WorkspaceSwitchedPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_context_injected"),
    properties: MCPContextInjectedPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_server_tested"),
    properties: MCPServerTestedPropertiesSchema,
  }),
  z.object({
    event: z.literal("stats_tab_opened"),
    properties: StatsTabOpenedPropertiesSchema,
  }),
  z.object({
    event: z.literal("stream_timing_computed"),
    properties: StreamTimingComputedPropertiesSchema,
  }),
  z.object({
    event: z.literal("stream_timing_invalid"),
    properties: StreamTimingInvalidPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_server_config_changed"),
    properties: MCPServerConfigChangedPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_oauth_flow_started"),
    properties: MCPOAuthFlowStartedPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_oauth_flow_completed"),
    properties: MCPOAuthFlowCompletedPropertiesSchema,
  }),
  z.object({
    event: z.literal("mcp_oauth_flow_failed"),
    properties: MCPOAuthFlowFailedPropertiesSchema,
  }),
  z.object({
    event: z.literal("message_sent"),
    properties: MessageSentPropertiesSchema,
  }),
  z.object({
    event: z.literal("stream_completed"),
    properties: StreamCompletedPropertiesSchema,
  }),
  z.object({
    event: z.literal("compaction_completed"),
    properties: CompactionCompletedPropertiesSchema,
  }),
  z.object({
    event: z.literal("provider_configured"),
    properties: ProviderConfiguredPropertiesSchema,
  }),
  z.object({
    event: z.literal("command_used"),
    properties: CommandUsedPropertiesSchema,
  }),
  z.object({
    event: z.literal("voice_transcription"),
    properties: VoiceTranscriptionPropertiesSchema,
  }),
  z.object({
    event: z.literal("error_occurred"),
    properties: ErrorOccurredPropertiesSchema,
  }),
  z.object({
    event: z.literal("experiment_overridden"),
    properties: ExperimentOverriddenPropertiesSchema,
  }),
]);

// API schemas - only track endpoint, enabled state controlled by env var
export const telemetry = {
  track: {
    input: TelemetryEventSchema,
    output: z.void(),
  },
  status: {
    input: z.void(),
    output: z.object({
      /** True if telemetry is actively running (false in dev mode) */
      enabled: z.boolean(),
      /** True only if user explicitly set MUX_DISABLE_TELEMETRY=1 */
      explicit: z.boolean(),
    }),
  },
};
