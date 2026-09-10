import { z } from "zod";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { isDurableContextBoundaryMarker } from "./compactionBoundary";

export function getHistoryItemId(message: MuxMessage): string {
  const sequence = message.metadata?.historySequence;
  return Number.isSafeInteger(sequence) && sequence! >= 0 ? String(sequence) : `m:${message.id}`;
}
export function getContextWindowId(message?: MuxMessage): string {
  return message && isDurableContextBoundaryMarker(message)
    ? `w:${getHistoryItemId(message)}`
    : "w:0";
}
const rolloverMetadataSchema: z.ZodType<
  Extract<MuxMessageMetadata, { type: "context-window-rollover" }>
> = z.object({
  type: z.literal("context-window-rollover"),
  rolloverId: z.string().trim().min(1),
  reason: z.enum(["on-send", "mid-stream", "context-exceeded", "model-requested"]),
  previousWindowId: z.string().trim().min(1),
  flushOpportunity: z.boolean(),
  contextTokens: z.number().finite().nonnegative(),
  maxTokens: z.number().finite().positive(),
});
const rolloverBoundarySchema = z.object({
  id: z.string().min(1),
  role: z.literal("assistant"),
  parts: z.tuple([]),
  metadata: z.object({
    contextBoundaryKind: z.literal("reset"),
    // Rejected capsules, copied tails, and incomplete rows cannot authorize
    // crossing a manual reset. Other writer-added envelope metadata is allowed.
    contextBudgetRejected: z.literal(false).optional(),
    contextBudgetRejectedMessage: z.never().optional(),
    rlmPreservedTailCopy: z.literal(false).optional(),
    partial: z.literal(false).optional(),
    muxMetadata: rolloverMetadataSchema,
  }),
});

/** A reset is private unless the whole persisted row validates as a rollover.
 * Raw evidence still protects malformed roles, metadata and unreadable rows.
 */
export function isManualHistoryReset(message: MuxMessage | null, possibleReset = false): boolean {
  return (
    (possibleReset || message?.metadata?.contextBoundaryKind === "reset") &&
    !rolloverBoundarySchema.safeParse(message).success
  );
}
