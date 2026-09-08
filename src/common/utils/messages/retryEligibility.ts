import type { DisplayedMessage } from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";
import type { RuntimeStatusEvent, StreamAbortReasonSnapshot } from "@/common/types/stream";
import { isCompletedSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";

/**
 * Debug flag to force all errors to be retryable.
 * Set in browser console: window.__MUX_FORCE_ALL_RETRYABLE = true
 *
 * Useful for testing retry/backoff logic without needing to simulate
 * specific network conditions or rate limits.
 *
 * Note: If you set this flag after an error occurs, you may need to
 * trigger a manual retry first (click "Retry" button) to clear the
 * stored non-retryable error state.
 */
const FORCE_ALL_RETRYABLE_FLAG = "__MUX_FORCE_ALL_RETRYABLE";

export const PENDING_STREAM_START_GRACE_PERIOD_MS = 15000; // 15 seconds

/**
 * Check if the debug flag to force all errors to be retryable is enabled.
 *
 * Uses globalThis instead of window so this utility stays safe for backend usage.
 */
function isForceAllRetryableEnabled(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __MUX_FORCE_ALL_RETRYABLE?: boolean;
  };

  return runtime[FORCE_ALL_RETRYABLE_FLAG] === true;
}

/**
 * Error types that should NOT be auto-retried because they require user action
 * These errors won't resolve on their own - the user must fix the underlying issue
 */
const PROVIDER_CONFIG_FIXABLE_STREAM_ERRORS = [
  "authentication", // Bad API key - user must fix credentials
  "quota", // Billing/usage limits - user must upgrade or wait for reset
] as const satisfies readonly StreamErrorType[];

const PROVIDER_CONFIG_FIXABLE_SEND_ERRORS = [
  "api_key_not_found",
  "oauth_not_connected",
  "provider_disabled",
] as const;

const NON_RETRYABLE_STREAM_ERRORS = [
  ...PROVIDER_CONFIG_FIXABLE_STREAM_ERRORS,
  "model_not_found", // Invalid model - user must select different model
  "context_exceeded", // Message too long - user must reduce context
  "context_budget_blocked", // Local preflight failed; retrying unchanged cannot fit
  "aborted", // User cancelled - should not auto-retry
  "runtime_not_ready", // Container/runtime unavailable - permanent failure
  "model_refusal", // Provider declined to answer - retrying the same request will refuse again
  "agent_resolution", // Strict explicit-agent contract failure - deterministic, retrying reproduces it
] as const satisfies readonly StreamErrorType[];

const NON_RETRYABLE_STREAM_ERROR_SET = new Set<string>(NON_RETRYABLE_STREAM_ERRORS);
const PROVIDER_CONFIG_FIXABLE_ERROR_SET = new Set<string>([
  ...PROVIDER_CONFIG_FIXABLE_STREAM_ERRORS,
  ...PROVIDER_CONFIG_FIXABLE_SEND_ERRORS,
]);

export function isProviderConfigFixableError(type: string): boolean {
  return PROVIDER_CONFIG_FIXABLE_ERROR_SET.has(type);
}

/**
 * Check if a SendMessageError (from resumeStream failures) is non-retryable
 */
export function isNonRetryableSendError(error: { type: string }): boolean {
  // Debug flag: force all errors to be retryable
  if (isForceAllRetryableEnabled()) {
    return false;
  }

  if (PROVIDER_CONFIG_FIXABLE_ERROR_SET.has(error.type)) {
    return true;
  }

  switch (error.type) {
    case "provider_not_supported": // Unsupported provider - user must switch
    case "model_not_available": // Model missing from fetched provider catalog - user must refresh or switch
    case "invalid_model_string": // Bad model format - user must fix
    case "incompatible_workspace": // Workspace from newer mux version - user must upgrade
    case "runtime_not_ready": // Container doesn't exist - user must recreate workspace
    case "policy_denied": // Policy blocks won't resolve automatically
    case "context_budget_exceeded": // Parent may roll over explicitly; never retry the oversized request
    case "context_budget_blocked":
      return true;
    case "runtime_start_failed": // Runtime is starting - transient, worth retrying
    case "unknown":
    default:
      return false; // Transient or unknown errors might resolve on their own
  }
}

/**
 * Check if a stream-error type is non-retryable.
 */
export function isNonRetryableStreamError(error: { type: string }): boolean {
  // Debug flag: force all errors to be retryable
  if (isForceAllRetryableEnabled()) {
    return false;
  }

  return NON_RETRYABLE_STREAM_ERROR_SET.has(error.type);
}

interface InterruptionContext {
  hasInterruptedStream: boolean;
  isEligibleForAutoRetry: boolean;
}

function shouldSuppressAutoRetry(
  lastAbortReason: StreamAbortReasonSnapshot | null | undefined
): boolean {
  return lastAbortReason?.reason === "user" || lastAbortReason?.reason === "startup";
}

/**
 * True when a turn was interrupted before its first token: the transcript tail is
 * the user message (no assistant/tool row yet) and the abort was user/startup
 * (RetryBarrier suppressed). shouldShowInterruptedBarrier never marks a user
 * message, so callers use this to still offer "continue" on the interrupted tail.
 */
export function isPreTokenInterruptedUserTurn(
  tail: DisplayedMessage | undefined,
  lastAbortReason: StreamAbortReasonSnapshot | null | undefined
): boolean {
  return (
    tail?.type === "user" && !tail.contextBudgetRejected && shouldSuppressAutoRetry(lastAbortReason)
  );
}

function isDecorativeTranscriptMessage(message: DisplayedMessage): boolean {
  return (
    message.type === "history-hidden" ||
    message.type === "workspace-init" ||
    message.type === "compaction-boundary"
  );
}

export function getLastNonDecorativeMessage(
  messages: DisplayedMessage[]
): DisplayedMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (!isDecorativeTranscriptMessage(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Latest transcript row that belongs to the retry lifecycle. */
function isDisplayOnlyCompletedSubagentReport(message: DisplayedMessage): boolean {
  return (
    message.type === "user" &&
    !message.contextBudgetRejected &&
    message.isSynthetic === true &&
    message.isUiVisible === true &&
    isCompletedSubagentReportEnvelope(message.content)
  );
}

export function getLastMainRetryCandidateMessage(
  messages: DisplayedMessage[]
): DisplayedMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (
      isDecorativeTranscriptMessage(candidate) ||
      isDisplayOnlyCompletedSubagentReport(candidate)
    ) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Check if messages contain an interrupted stream
 *
 * Used by AIView to determine if RetryBarrier should be shown.
 * Shows retry UI for ALL interrupted streams, including non-retryable errors
 * (so users can manually retry after fixing the issue).
 *
 * Returns true if:
 * 1. Last message is a stream-error (any type - user may have fixed the issue)
 * 2. Last message is a partial assistant/tool/reasoning message
 * 3. Last message is a user message (indicating we sent it but never got a response)
 *    - This handles app restarts during slow model responses (models can take 30-60s to first token)
 *    - User messages are only at the end when response hasn't started/completed
 *    - EXCEPT: Not if recently sent (within PENDING_STREAM_START_GRACE_PERIOD_MS) - prevents flash during normal send flow
 */
function computeHasInterruptedStream(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null
): boolean {
  if (messages.length === 0) return false;

  // Don't show retry barrier if user message was sent very recently (within the grace period)
  // This prevents flash during normal send flow while stream-start event arrives
  // After the grace period, assume something is wrong and show the barrier
  if (pendingStreamStartTime !== null) {
    const elapsed = Date.now() - pendingStreamStartTime;
    if (elapsed < PENDING_STREAM_START_GRACE_PERIOD_MS) return false;
  }

  const lastMessage = getLastMainRetryCandidateMessage(messages);
  if (!lastMessage) return false;
  if (lastMessage.type === "user" && lastMessage.contextBudgetRejected) return false;

  // Don't show retry barrier if workspace init is still running AND no error has occurred yet.
  // The backend waits for init to complete before starting the stream.
  // However, if a stream-error already exists, we should show retry (init timeout or other failure).
  const initMessage = messages.find((m) => m.type === "workspace-init");
  if (
    initMessage?.type === "workspace-init" &&
    initMessage.status === "running" &&
    lastMessage.type !== "stream-error"
  ) {
    return false;
  }

  // Don't show retry barrier if runtime bring-up is still in progress (for example a stopped
  // Coder workspace that is still starting). Generic post-runtime startup breadcrumbs must not
  // suppress retry UI, or a later stall in tool loading/request prep would hide the interruption.
  if (
    runtimeStatus?.source !== "startup" &&
    runtimeStatus !== null &&
    lastMessage.type !== "stream-error"
  ) {
    return false;
  }

  // ask_user_question is a special case: an unfinished tool call represents an
  // intentional "waiting for user input" state, not a stream interruption.
  //
  // Treating it as interrupted causes RetryBarrier + auto-resume to fire on app
  // restart, which re-runs the LLM call and re-asks the questions.
  if (
    lastMessage.type === "tool" &&
    lastMessage.toolName === "ask_user_question" &&
    lastMessage.status === "executing"
  ) {
    return false;
  }

  // These terminal failures require a new request or workspace, not replaying the same turn.
  if (
    lastMessage.type === "stream-error" &&
    (lastMessage.errorType === "runtime_not_ready" ||
      lastMessage.errorType === "context_budget_blocked")
  ) {
    return false;
  }

  return (
    lastMessage.type === "stream-error" ||
    lastMessage.type === "user" || // No response received yet (app restart during slow model)
    (lastMessage.type === "assistant" && lastMessage.isPartial === true) ||
    (lastMessage.type === "tool" && lastMessage.isPartial === true) ||
    (lastMessage.type === "reasoning" && lastMessage.isPartial === true)
  );
}

/**
 * Shared interruption + retry eligibility helper.
 */
export function getInterruptionContext(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): InterruptionContext {
  const hasInterrupted = computeHasInterruptedStream(
    messages,
    pendingStreamStartTime,
    runtimeStatus
  );

  if (!hasInterrupted) {
    return { hasInterruptedStream: false, isEligibleForAutoRetry: false };
  }

  // User-initiated aborts (Ctrl+C/Escape) are intentional, not errors.
  // Don't show the warning RetryBarrier - just the subtle InterruptedBarrier line.
  if (shouldSuppressAutoRetry(lastAbortReason)) {
    return { hasInterruptedStream: false, isEligibleForAutoRetry: false };
  }

  const lastMessage = getLastMainRetryCandidateMessage(messages);
  if (!lastMessage) {
    return { hasInterruptedStream: false, isEligibleForAutoRetry: false };
  }

  if (lastMessage.type === "stream-error") {
    // Debug flag: force all errors to be retryable
    if (isForceAllRetryableEnabled()) {
      return { hasInterruptedStream: true, isEligibleForAutoRetry: true };
    }
    return {
      hasInterruptedStream: true,
      isEligibleForAutoRetry: !isNonRetryableStreamError({ type: lastMessage.errorType }),
    };
  }

  // Other interrupted states (partial messages, user messages) are auto-retryable
  return { hasInterruptedStream: true, isEligibleForAutoRetry: true };
}

export function hasInterruptedStream(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): boolean {
  return getInterruptionContext(messages, pendingStreamStartTime, runtimeStatus, lastAbortReason)
    .hasInterruptedStream;
}

/**
 * Check if messages are eligible for automatic retry
 *
 * Used by retry status consumers to determine if a stream interruption is auto-retry eligible.
 * Returns false for errors that require user action (authentication, quota, etc.),
 * but still allows manual retry via RetryBarrier UI.
 *
 * This separates auto-retry logic from manual retry UI:
 * - Manual retry: Always available for any error (hasInterruptedStream)
 * - Auto retry: Only for transient errors that might resolve on their own
 */
export function isEligibleForAutoRetry(
  messages: DisplayedMessage[],
  pendingStreamStartTime: number | null = null,
  runtimeStatus: RuntimeStatusEvent | null = null,
  lastAbortReason: StreamAbortReasonSnapshot | null = null
): boolean {
  return getInterruptionContext(messages, pendingStreamStartTime, runtimeStatus, lastAbortReason)
    .isEligibleForAutoRetry;
}
