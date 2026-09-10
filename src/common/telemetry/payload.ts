/**
 * Telemetry Payload Definitions
 *
 * This file defines all data structures sent to PostHog for user transparency.
 * Users can inspect this file to understand exactly what telemetry data is collected.
 *
 * PRIVACY GUIDELINES:
 * - Randomly generated IDs (e.g., workspace IDs, session IDs) can be sent verbatim
 *   as they contain no user information and are not guessable.
 * - Display names, project names, file paths, or anything that could reveal the
 *   nature of the user's work MUST NOT be sent, even if hashed.
 *   Hashing is vulnerable to rainbow table attacks and brute-force, especially
 *   for common project names or predictable patterns.
 * - For numerical metrics that could leak information (like message lengths), use
 *   base-2 rounding (e.g., 128, 256, 512) to preserve privacy while enabling analysis.
 * - When in doubt, don't send it. Privacy is paramount.
 *
 * NOTE: Base properties (version, backend_platform, electronVersion, nodeVersion,
 * bunVersion) are automatically added by the backend TelemetryService. Frontend
 * code only needs to provide event-specific properties.
 */

import type { z } from "zod";
import type { AdvisorCallCompletedPropertiesSchema } from "@/common/orpc/schemas/telemetry";
import type { RuntimeMode } from "@/common/types/runtime";

/**
 * Base properties included with all telemetry events
 * These are added by the backend, not the frontend
 */
export interface BaseTelemetryProperties {
  /** Application version */
  version: string;
  /** Backend operating system platform (darwin, win32, linux) - where Node.js/backend runs */
  backend_platform: NodeJS.Platform | "unknown";
  /** Electron version (if running in Electron) */
  electronVersion: string;
  /** Node.js version */
  nodeVersion: string;
  /** Bun version (if running in Bun) */
  bunVersion: string;
}

/**
 * Application lifecycle events
 */
export interface AppStartedPayload {
  /** Whether this is the first app launch */
  isFirstLaunch: boolean;
  /** Whether vim mode is enabled at startup */
  vimModeEnabled: boolean;
}

/**
 * Runtime type for telemetry - derived from RuntimeMode to stay in sync.
 * Values: 'local' (project-dir), 'worktree' (git worktree isolation), 'ssh' (remote), 'docker' (container)
 */
export type TelemetryRuntimeType = RuntimeMode;

/**
 * Frontend platform info - browser/client environment
 * Useful when backend runs on different machine (e.g., mux server mode)
 */
export interface FrontendPlatformInfo {
  /** Browser user agent string (safe, widely shared) */
  userAgent: string;
  /** Client platform from navigator.platform */
  platform: string;
}

/**
 * Workspace events
 */
export interface WorkspaceCreatedPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
  /** Runtime type for the workspace */
  runtimeType: TelemetryRuntimeType;
  /** Frontend platform info */
  frontendPlatform: FrontendPlatformInfo;
}

export interface WorkspaceSwitchedPayload {
  /** Previous workspace ID (randomly generated, safe to send) */
  fromWorkspaceId: string;
  /** New workspace ID (randomly generated, safe to send) */
  toWorkspaceId: string;
}

/**
 * Thinking level for extended thinking feature
 */
export type TelemetryThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Chat/AI interaction events
 */
export interface MessageSentPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
  /** Full model identifier (e.g., 'anthropic/claude-3-5-sonnet-20241022') */
  model: string;
  /** Agent id (e.g., 'plan', 'exec', 'explore'). Optional for legacy clients. */
  agentId?: string;
  /** Message length rounded to nearest power of 2 (e.g., 128, 256, 512, 1024) */
  message_length_b2: number;
  /** Runtime type for the workspace */
  runtimeType: TelemetryRuntimeType;
  /** Frontend platform info */
  frontendPlatform: FrontendPlatformInfo;
  /** Extended thinking level */
  thinkingLevel: TelemetryThinkingLevel;
}

/**
 * MCP usage events
 */
export type TelemetryMCPTransportMode = "none" | "stdio_only" | "http_only" | "sse_only" | "mixed";

export interface MCPContextInjectedPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
  /** Full model identifier */
  model: string;
  /** Active agent definition id (e.g. "plan", "exec", "explore"). Optional for backwards compatibility. */
  agentId?: string;
  /** Runtime type for the workspace */
  runtimeType: TelemetryRuntimeType;

  /** How many servers are enabled for this workspace message */
  mcp_server_enabled_count: number;
  /** How many servers successfully started (client created + tools fetched) */
  mcp_server_started_count: number;
  /** How many enabled servers failed to start */
  mcp_server_failed_count: number;

  /** MCP tools injected into the model request */
  mcp_tool_count: number;
  /** Total tools injected into the model request (built-in + MCP) */
  total_tool_count: number;
  /** Built-in tool count injected into the model request */
  builtin_tool_count: number;

  /** Effective transport mix for *started* servers (auto transport is resolved to http/sse) */
  mcp_transport_mode: TelemetryMCPTransportMode;
  /** Whether any started server uses HTTP (auto transport resolves to http/sse at runtime) */
  mcp_has_http: boolean;
  /** Whether any started server uses legacy SSE */
  mcp_has_sse: boolean;
  /** Whether any started server uses stdio */
  mcp_has_stdio: boolean;

  /** Number of servers that required auto-fallback from HTTP to SSE */
  mcp_auto_fallback_count: number;

  /** Time spent preparing MCP servers/tools (ms, rounded to nearest power of 2) */
  mcp_setup_duration_ms_b2: number;
}

export type TelemetryMCPServerTransport = "stdio" | "http" | "sse" | "auto";
export type TelemetryMCPTestErrorCategory = "timeout" | "connect" | "http_status" | "unknown";

export interface MCPServerTestedPayload {
  transport: TelemetryMCPServerTransport;
  success: boolean;
  duration_ms_b2: number;
  /** Error category when success=false (no raw error messages for privacy) */
  error_category?: TelemetryMCPTestErrorCategory;
}

export type TelemetryMCPServerConfigAction =
  | "add"
  | "edit"
  | "remove"
  | "enable"
  | "disable"
  | "set_tool_allowlist"
  | "set_headers";

export interface MCPServerConfigChangedPayload {
  action: TelemetryMCPServerConfigAction;
  transport: TelemetryMCPServerTransport;
  has_headers: boolean;
  uses_secret_headers: boolean;
  /** Only set when action=set_tool_allowlist */
  tool_allowlist_size_b2?: number;
}

export type TelemetryMCPOAuthFlowErrorCategory =
  | "timeout"
  | "cancelled"
  | "state_mismatch"
  | "provider_error"
  | "unknown";

export interface MCPOAuthFlowStartedPayload {
  transport: TelemetryMCPServerTransport;
  has_scope_hint: boolean;
  has_resource_metadata_hint: boolean;
}

export interface MCPOAuthFlowCompletedPayload {
  transport: TelemetryMCPServerTransport;
  duration_ms_b2: number;
  has_scope_hint: boolean;
  has_resource_metadata_hint: boolean;
}

export interface MCPOAuthFlowFailedPayload {
  transport: TelemetryMCPServerTransport;
  duration_ms_b2: number;
  has_scope_hint: boolean;
  has_resource_metadata_hint: boolean;
  error_category: TelemetryMCPOAuthFlowErrorCategory;
}
/**
 * Stats tab event - tracks when users view timing stats.
 */
export interface StatsTabOpenedPayload {
  viewMode: "session" | "last-request";
  showModeBreakdown: boolean;
}

/**
 * Stream timing computed - emitted by backend timing pipeline.
 *
 * All numeric metrics are base-2 rounded or bucketed to preserve privacy.
 */
export interface StreamTimingComputedPayload {
  model: string;
  agentId?: string;
  duration_b2: number;
  ttft_ms_b2: number;
  tool_ms_b2: number;
  streaming_ms_b2: number;
  tool_percent_bucket: number;
  invalid: boolean;
}

/**
 * Stream timing invalid - emitted when any computed % would exceed 100%,
 * durations are negative, or values are NaN.
 */
export interface StreamTimingInvalidPayload {
  reason: string;
}

/** Advisor cache measurements use rounded values, not prompt content. */
export type AdvisorCallCompletedPayload = z.infer<typeof AdvisorCallCompletedPropertiesSchema>;

export interface StreamCompletedPayload {
  /** Model used for generation */
  model: string;
  /** Whether the stream was interrupted by user vs natural completion */
  wasInterrupted: boolean;
  /** Duration in seconds, rounded to nearest power of 2 */
  duration_b2: number;
  /** Output tokens, rounded to nearest power of 2 */
  output_tokens_b2: number;
}

/**
 * Compaction completion event - tracks when history compaction finishes
 */
export interface CompactionCompletedPayload {
  /** Model used for compaction */
  model: string;
  /** Duration in seconds, rounded to nearest power of 2 */
  duration_b2: number;
  /** Input tokens (pre-compaction history size), rounded to nearest power of 2 */
  input_tokens_b2: number;
  /** Output tokens (post-compaction summary size), rounded to nearest power of 2 */
  output_tokens_b2: number;
  /** Whether this compaction was user-triggered vs idle */
  compaction_source: "manual" | "idle";
}

/**
 * Provider configuration event - tracks when users set up providers
 * Note: Only tracks that a key was set, never the actual value
 */
export interface ProviderConfiguredPayload {
  /** Provider name (e.g., 'anthropic', 'openai', 'mux-gateway') */
  provider: string;
  /** Key type that was configured (e.g., 'apiKey', 'couponCode', 'baseUrl') */
  keyType: string;
}

/**
 * Slash command types for telemetry (no arguments/values)
 */
export type TelemetryCommandType =
  | "clear"
  | "clear:hard"
  | "clear:soft"
  | "compact"
  | "new"
  | "fork"
  | "vim"
  | "model"
  | "mode"
  | "plan"
  | "providers"
  | "goal"
  | "workflow";

/**
 * Command usage event - tracks slash command usage patterns
 */
export interface CommandUsedPayload {
  /** Command type (without arguments for privacy) */
  command: TelemetryCommandType;
}

/**
 * Voice transcription event - tracks voice input usage
 */
export interface VoiceTranscriptionPayload {
  /** Duration of audio in seconds, rounded to nearest power of 2 */
  audio_duration_b2: number;
  /** Whether the transcription succeeded */
  success: boolean;
}

/**
 * Error tracking context types (explicit enum for transparency)
 */
export type ErrorContext =
  | "workspace-creation"
  | "workspace-deletion"
  | "workspace-switch"
  | "message-send"
  | "message-stream"
  | "project-add"
  | "project-remove"
  | "git-operation";

/**
 * Error tracking events
 */
export interface ErrorOccurredPayload {
  /** Error type/name */
  errorType: string;
  /** Error context - where the error occurred */
  context: ErrorContext;
}

/**
 * Experiment override event - tracks when users manually toggle experiments
 * This helps measure opt-out rates and understand user preferences
 */
export interface ExperimentOverriddenPayload {
  /** Experiment identifier (e.g., 'agent-browser') */
  experimentId: string;
  /** What the user chose (true = enabled, false = disabled) */
  userChoice: boolean;
}

/**
 * Union type of all telemetry event payloads
 * Frontend sends these; backend adds BaseTelemetryProperties before forwarding to PostHog
 */
export type TelemetryEventPayload =
  | { event: "advisor_call_completed"; properties: AdvisorCallCompletedPayload }
  | { event: "app_started"; properties: AppStartedPayload }
  | { event: "workspace_created"; properties: WorkspaceCreatedPayload }
  | { event: "workspace_switched"; properties: WorkspaceSwitchedPayload }
  | { event: "message_sent"; properties: MessageSentPayload }
  | { event: "mcp_context_injected"; properties: MCPContextInjectedPayload }
  | { event: "mcp_server_tested"; properties: MCPServerTestedPayload }
  | { event: "mcp_server_config_changed"; properties: MCPServerConfigChangedPayload }
  | { event: "mcp_oauth_flow_started"; properties: MCPOAuthFlowStartedPayload }
  | { event: "mcp_oauth_flow_completed"; properties: MCPOAuthFlowCompletedPayload }
  | { event: "mcp_oauth_flow_failed"; properties: MCPOAuthFlowFailedPayload }
  | { event: "stats_tab_opened"; properties: StatsTabOpenedPayload }
  | { event: "stream_timing_computed"; properties: StreamTimingComputedPayload }
  | { event: "stream_timing_invalid"; properties: StreamTimingInvalidPayload }
  | { event: "stream_completed"; properties: StreamCompletedPayload }
  | { event: "compaction_completed"; properties: CompactionCompletedPayload }
  | { event: "provider_configured"; properties: ProviderConfiguredPayload }
  | { event: "command_used"; properties: CommandUsedPayload }
  | { event: "voice_transcription"; properties: VoiceTranscriptionPayload }
  | { event: "error_occurred"; properties: ErrorOccurredPayload }
  | { event: "experiment_overridden"; properties: ExperimentOverriddenPayload };
