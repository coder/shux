import { z } from "zod";
import { ThinkingLevelSchema } from "../../types/thinking";

/**
 * Success payload of an accepted (non-queued) send — the single source for
 * both the oRPC output schema (workspace.sendMessage) and the backend's
 * SendMessageAccepted type, so the wire shape and the compile-time shape can
 * never drift.
 */
export const SendMessageAcceptedSchema = z.object({
  // Class model applied by skill routing — lets the frontend attribute send
  // telemetry to the model that actually streams. Absent when no routing
  // occurred or the send was queued for later dispatch.
  routedModel: z.string().optional(),
  // Thinking level routing replaced (class suffix or re-resolved numeric
  // one-shot); absent when the ambient thinking level applies.
  routedThinkingLevel: ThinkingLevelSchema.optional(),
  // True when the send was QUEUED behind a busy turn (class routing has not
  // resolved yet, so the absence of routedModel means "unknown", not
  // "unrouted"), or when its dispatch is otherwise settled after this
  // response (compaction-deferred and background-started skill sends). The
  // backend attributes such a send when it actually streams — telemetry here
  // must not attribute the ambient model to it.
  queued: z.boolean().optional(),
  // True when the turn was ACCEPTED (its rows are durable) but never reached
  // a provider — a late consent refusal or a canceled startup surfaced as a
  // visible stream error instead. No request occurred, so send telemetry must
  // not attribute the ambient model to it.
  acceptedWithoutStream: z.boolean().optional(),
});

/**
 * Discriminated union for all possible sendMessage errors.
 *
 * The frontend is responsible for language and messaging for api_key_not_found,
 * oauth_not_connected, provider_disabled, provider_not_supported, and
 * model_not_available errors.
 * Other error types include details needed for display.
 */
export const SendMessageErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key_not_found"), provider: z.string() }),
  z.object({ type: z.literal("oauth_not_connected"), provider: z.string() }),
  z.object({ type: z.literal("provider_disabled"), provider: z.string() }),
  z.object({ type: z.literal("provider_not_supported"), provider: z.string() }),
  z.object({ type: z.literal("model_not_available"), provider: z.string(), modelId: z.string() }),
  z.object({ type: z.literal("invalid_model_string"), message: z.string() }),
  z.object({ type: z.literal("incompatible_workspace"), message: z.string() }),
  z.object({ type: z.literal("runtime_not_ready"), message: z.string() }),
  z.object({ type: z.literal("runtime_start_failed"), message: z.string() }), // Transient - retryable
  z.object({ type: z.literal("policy_denied"), message: z.string() }),
  z.object({
    type: z.literal("context_budget_exceeded"),
    model: z.string(),
    estimate: z.number().finite().nonnegative(),
    hardCeiling: z.number().finite(),
  }),
  z.object({ type: z.literal("context_budget_blocked"), message: z.string() }),
  z.object({ type: z.literal("unknown"), raw: z.string() }),
]);

/**
 * Stream error types - categorizes errors during AI streaming
 * Used across backend (StreamManager) and frontend (StreamErrorMessage)
 */
export const StreamErrorTypeSchema = z.enum([
  "authentication", // API key issues, 401 errors
  "rate_limit", // 429 rate limiting
  "server_error", // 5xx server errors
  "api", // Generic API errors
  "retry_failed", // Retry exhausted
  "aborted", // User aborted
  "network", // Network/fetch errors
  "context_exceeded", // Context length/token limit exceeded
  "context_budget_blocked", // Local assembled-request preflight refused an oversized request
  "quota", // Usage quota/billing limits
  "model_not_found", // Model does not exist
  "runtime_not_ready", // Container/runtime doesn't exist or failed to start (permanent)
  "runtime_start_failed", // Runtime is starting or temporarily unavailable (retryable)
  "empty_output", // Provider ended the stream without any assistant-visible output
  "stream_truncated", // Provider stream closed before its terminal finish event
  "max_output_tokens", // Provider truncated the response at max_tokens (finishReason: "length")
  "model_refusal", // Provider declined to answer (refusal/content-filter); retrying the same request will refuse again
  "agent_resolution", // Strict explicit-agent contract failure (agent missing/hidden/disabled/provenance changed); deterministic, retrying reproduces it
  "unknown", // Catch-all
]);

export const NameGenerationErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authentication"),
    authKind: z.enum(["api_key_missing", "oauth_not_connected", "invalid_credentials"]),
    provider: z.string().nullish(),
    raw: z.string().nullish(),
  }),
  z.object({
    type: z.literal("permission_denied"),
    provider: z.string().nullish(),
    raw: z.string().nullish(),
  }),
  z.object({
    type: z.literal("policy"),
    provider: z.string().nullish(),
    raw: z.string().nullish(),
  }),
  z.object({ type: z.literal("rate_limit"), raw: z.string().nullish() }),
  z.object({ type: z.literal("quota"), raw: z.string().nullish() }),
  z.object({ type: z.literal("service_unavailable"), raw: z.string().nullish() }),
  z.object({ type: z.literal("network"), raw: z.string().nullish() }),
  z.object({ type: z.literal("configuration"), raw: z.string().nullish() }),
  z.object({ type: z.literal("unknown"), raw: z.string() }),
]);

/**
 * Discriminated union for project removal errors.
 * workspace_blockers carries exact active/archived counts so the frontend can render
 * precise messaging without parsing strings.
 */
export const ProjectRemoveErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workspace_blockers"),
    activeCount: z.number().int().nonnegative(),
    archivedCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("project_not_found") }),
  z.object({ type: z.literal("unknown"), message: z.string() }),
]);
