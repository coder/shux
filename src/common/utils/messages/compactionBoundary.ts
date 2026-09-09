import assert from "@/common/utils/assert";
import {
  CONTEXT_BOUNDARY_KINDS,
  type ContextBoundaryKind,
} from "@/common/constants/contextBoundary";
import { isPositiveInteger } from "@/common/utils/numbers";
import { hasProviderReplayableContent } from "@/common/utils/messages/providerEligibility";

import type { MuxMessage } from "@/common/types/message";

export { CONTEXT_BOUNDARY_KINDS };

export function isDurableCompactedMarker(
  value: unknown
): value is true | "user" | "idle" | "heartbeat" {
  return value === true || value === "user" || value === "idle" || value === "heartbeat";
}

export function isDurableCompactionBoundaryMarker(message: MuxMessage | undefined): boolean {
  if (message?.metadata?.compactionBoundary !== true) {
    return false;
  }

  if (message.role !== "assistant") {
    return false;
  }

  // Self-healing read path: malformed persisted boundary metadata should be ignored,
  // not crash request assembly.
  if (!isDurableCompactedMarker(message.metadata.compacted)) {
    return false;
  }

  const epoch = message.metadata.compactionEpoch;
  if (!isPositiveInteger(epoch)) {
    return false;
  }

  return true;
}

export function isDurableContextResetBoundaryMarker(message: MuxMessage | undefined): boolean {
  if (message?.metadata?.contextBoundaryKind !== CONTEXT_BOUNDARY_KINDS.RESET) {
    return false;
  }

  // Context resets are transcript structure, not model content. Persist them as
  // assistant rows so existing chat event and display plumbing can carry them.
  if (message.role !== "assistant") {
    return false;
  }

  return true;
}

export function getContextBoundaryKind(
  message: MuxMessage | undefined
): ContextBoundaryKind | null {
  if (isDurableContextResetBoundaryMarker(message)) {
    return CONTEXT_BOUNDARY_KINDS.RESET;
  }

  if (isDurableCompactionBoundaryMarker(message)) {
    return CONTEXT_BOUNDARY_KINDS.COMPACTION;
  }

  return null;
}

export function isDurableContextBoundaryMarker(message: MuxMessage | undefined): boolean {
  return getContextBoundaryKind(message) !== null;
}

/**
 * History sequence of the latest durable context boundary among `messages`
 * (any kind), or undefined when there is none. Identifies the compaction
 * epoch the rows after it belong to: compaction completion metadata carries it
 * as `previousBoundaryHistorySequence`, and the workspace-memory policy
 * accumulator is bound to it (WorkspaceService.recordWorkspaceMemoryWritable).
 */
export function latestContextBoundaryHistorySequence(
  messages: readonly MuxMessage[]
): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!isDurableContextBoundaryMarker(message)) continue;
    const sequence = message.metadata?.historySequence;
    if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) continue;
    if (latest === undefined || sequence > latest) latest = sequence;
  }
  return latest;
}

/**
 * Locate the latest durable context boundary in reverse chronological order.
 *
 * Returns the index of the newest message tagged with valid boundary metadata,
 * or `-1` when no durable boundary exists in the provided history.
 */
export function findLatestContextBoundaryIndex(messages: MuxMessage[]): number {
  assert(Array.isArray(messages), "findLatestContextBoundaryIndex requires a message array");

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isDurableContextBoundaryMarker(messages[i])) {
      return i;
    }
  }

  return -1;
}

/** Backwards-compatible compaction-only lookup for existing call sites and tests. */
export function findLatestCompactionBoundaryIndex(messages: MuxMessage[]): number {
  assert(Array.isArray(messages), "findLatestCompactionBoundaryIndex requires a message array");

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isDurableCompactionBoundaryMarker(messages[i])) {
      return i;
    }
  }

  return -1;
}

/**
 * Slice request payload history from the latest compaction boundary (inclusive).
 *
 * This is request-only and must not be used to mutate persisted replay history.
 */
export function sliceMessagesFromLatestCompactionBoundary(messages: MuxMessage[]): MuxMessage[] {
  const boundaryIndex = findLatestCompactionBoundaryIndex(messages);
  if (boundaryIndex === -1) {
    return messages;
  }

  assert(
    boundaryIndex >= 0 && boundaryIndex < messages.length,
    "compaction boundary index must be within message history bounds"
  );

  const sliced = messages.slice(boundaryIndex);
  assert(sliced.length > 0, "compaction boundary slicing must retain at least one message");
  assert(
    isDurableCompactionBoundaryMarker(sliced[0]),
    "compaction boundary slicing must start on a durable compaction boundary message"
  );

  return sliced;
}

export function isProviderEligibleMessage(
  message: MuxMessage,
  options?: Parameters<typeof hasProviderReplayableContent>[1]
): boolean {
  if (isDurableContextResetBoundaryMarker(message)) {
    return false;
  }

  return hasProviderReplayableContent(message, options);
}

export function hasProviderEligibleMessages(
  messages: MuxMessage[],
  options?: Parameters<typeof hasProviderReplayableContent>[1]
): boolean {
  assert(Array.isArray(messages), "hasProviderEligibleMessages requires a message array");
  return messages.some((message) => isProviderEligibleMessage(message, options));
}

/**
 * Slice provider payload history from the latest Context Boundary.
 *
 * Compaction boundaries remain provider-visible because they carry summaries.
 * Context reset boundaries are provider-invisible, so the active window starts
 * after the reset marker.
 */
export function sliceMessagesForProviderFromLatestContextBoundary(
  messages: MuxMessage[]
): MuxMessage[] {
  const boundaryIndex = findLatestContextBoundaryIndex(messages);
  if (boundaryIndex === -1) {
    return messages;
  }

  assert(
    boundaryIndex >= 0 && boundaryIndex < messages.length,
    "context boundary index must be within message history bounds"
  );

  const boundaryKind = getContextBoundaryKind(messages[boundaryIndex]);
  assert(boundaryKind !== null, "context boundary slicing must start from a durable boundary");

  return boundaryKind === CONTEXT_BOUNDARY_KINDS.RESET
    ? messages.slice(boundaryIndex + 1)
    : messages.slice(boundaryIndex);
}
