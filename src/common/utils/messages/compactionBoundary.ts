import assert from "@/common/utils/assert";
import {
  CONTEXT_BOUNDARY_KINDS,
  type ContextBoundaryKind,
} from "@/common/constants/contextBoundary";
import { isPositiveInteger } from "@/common/utils/numbers";
import { hasProviderReplayableContent } from "@/common/utils/messages/providerEligibility";

import type { MuxMessage } from "@/common/types/message";
import { isTokenBudgetInternalMessage } from "@/common/types/message";

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
 * Start sequence of the history segment `messages` belong to (the largest
 * `historySegment` stamp among them; 0 for legacy rows and the first
 * segment). Every row of a segment carries the same stamp, so any non-empty
 * subset of the segment yields the same value; a full clear opens a segment
 * with a strictly larger start (HistoryService).
 */
export function historySegmentStart(messages: readonly MuxMessage[]): number {
  let start = 0;
  for (const message of messages) {
    const segment = message.metadata?.historySegment;
    if (typeof segment !== "number" || !Number.isSafeInteger(segment) || segment < 0) continue;
    if (segment > start) start = segment;
  }
  return start;
}

/**
 * The compaction epoch `messages` (an active-context read) belong to, as the
 * workspace-memory write policy keys it: the latest durable boundary's
 * history sequence, or `-(segmentStart + 1)` before any boundary of the
 * segment (-1 in the first segment, as before the stamp existed). Sequences
 * never recur across full clears (each clear opens a segment above every
 * sequence used so far), so neither identity is ever reused for a different
 * conversation: a turn that recorded its policy under the pre-clear identity
 * cannot pass as one of the post-clear epoch, however the clear and its
 * appends interleave across backends. Compaction completion reports the same
 * value as `closingPolicyEpoch`, so the completion-side observation and every
 * backend's turn records agree on which epoch a value belongs to.
 */
export function workspaceMemoryPolicyEpochOf(messages: readonly MuxMessage[]): number {
  return latestContextBoundaryHistorySequence(messages) ?? -(historySegmentStart(messages) + 1);
}

/**
 * The policy epoch a compaction closed: `closingPolicyEpoch` when the
 * completion recorded it, else the identity older builds used (the previous
 * boundary's sequence, -1 before any) so persisted legacy records still key
 * their turns' stamps.
 */
export function compactionClosingPolicyEpoch(metadata: {
  closingPolicyEpoch?: number;
  previousBoundaryHistorySequence?: number;
}): number {
  return metadata.closingPolicyEpoch ?? metadata.previousBoundaryHistorySequence ?? -1;
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

/**
 * Whether the active epoch already holds a turn other than the one being
 * started (`currentBatch`: the request's user row plus its prelude snapshot
 * ids). Feeds the unknown-history rule of the workspace-memory write policy
 * (WorkspaceService.recordWorkspaceMemoryWritable): an epoch with prior turns
 * this process never recorded a policy for cannot be vouched for. Not turns:
 * compaction request rows (they open an epoch), RLM keep-recent copies (the
 * previous epoch's turns re-appended after the boundary; the harvest gate
 * skips them too, and counting them would make another backend's first turn
 * of the new epoch — racing the compacting backend's asynchronous policy
 * carry — record an unknown-history deny for an all-writable epoch), and
 * token-budget control rows (rollover lead-in, budget warning: backend
 * template text prepended to the turn they precede; the harvest gate exempts
 * them for the same reason, and counting one would record a false
 * unknown-history deny for a fresh, otherwise writable epoch).
 */
export function epochHasPriorTurnRows(
  activeContextMessages: readonly MuxMessage[],
  currentTurn: { userMessageId: string | undefined; preludeMessageIds: ReadonlySet<string> }
): boolean {
  // Batches are matched by row id: two user rows sharing one id (persisted
  // history is raw JSON) would both read as the current batch, hiding the
  // earlier one from this check and from the harvest gate's coverage — so a
  // duplicated id is itself an unaccounted prior turn (fail closed). A
  // prelude listing exempts only rows of prelude shape (isRequestPreludeRow):
  // an ordinary user turn named there stays a prior turn.
  const duplicated = duplicateUserMessageIds(activeContextMessages);
  return activeContextMessages.some(
    (message) =>
      message.role === "user" &&
      (duplicated.has(message.id) ||
        !(
          message.id === currentTurn.userMessageId ||
          (currentTurn.preludeMessageIds.has(message.id) && isRequestPreludeRow(message))
        )) &&
      message.metadata?.muxMetadata?.type !== "compaction-request" &&
      message.metadata?.rlmPreservedTailCopy !== true &&
      !isTokenBudgetInternalMessage(message)
  );
}

/**
 * Whether a row has the shape of a request prelude row — one the backend
 * appends with a turn and lists in the user row's `requestPreludeMessageIds`
 * (@mention/skill/MCP snapshots, family payloads): always `synthetic`. The
 * id-keyed policy accounting (prior-turn check, harvest coverage, tail-copy
 * stamps) honors a prelude listing only for such rows, so a listing that
 * names an ordinary user turn (persisted history is raw JSON) cannot make
 * that turn read as accounted for.
 */
export function isRequestPreludeRow(message: MuxMessage): boolean {
  return message.metadata?.synthetic === true;
}

/**
 * Ids carried by more than one user row of `messages`. The policy checks
 * account for user rows by id (a turn's batch is its user row plus the
 * prelude ids that row lists), so an id shared by two rows would let the
 * accounting of one vouch for the other; callers treat such ids as
 * unaccounted for.
 */
export function duplicateUserMessageIds(messages: readonly MuxMessage[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (seen.has(message.id)) duplicated.add(message.id);
    else seen.add(message.id);
  }
  return duplicated;
}
