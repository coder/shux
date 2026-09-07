import assert from "@/common/utils/assert";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import type { MuxMessage } from "@/common/types/message";

/** Older builds ignore the rejection flag, but already exclude empty, completed assistant rows. */
export function createContextBudgetRejectedMessage(message: MuxMessage): MuxMessage {
  assert(message.role !== "system", "Only request payloads can be rejected");
  const { contextBudgetRejectedMessage, ...originalMetadata } = message.metadata ?? {};
  const original =
    message.metadata?.contextBudgetRejected === true &&
    message.role === "assistant" &&
    message.parts.length === 0 &&
    contextBudgetRejectedMessage != null
      ? contextBudgetRejectedMessage
      : { role: message.role, parts: message.parts, metadata: originalMetadata };

  // Allowlist the outer metadata: old readers must not rehydrate snapshots, command controls,
  // or retry state from the original payload, even though its bytes remain available for display.
  return {
    id: message.id,
    role: "assistant",
    parts: [],
    metadata: {
      historySequence: message.metadata?.historySequence,
      timestamp: message.metadata?.timestamp,
      synthetic: true,
      uiVisible: false,
      contextBudgetRejected: true,
      contextBudgetRejectedMessage: original,
    },
  };
}

/** Display/export projection ONLY. Never pass this virtual message back to provider/history reads. */
export function restoreContextBudgetRejectedMessageForDisplay(message: MuxMessage): MuxMessage {
  const original = message.metadata?.contextBudgetRejectedMessage;
  if (
    !message.metadata?.contextBudgetRejected ||
    message.role !== "assistant" ||
    message.parts.length !== 0 ||
    original == null
  )
    return message;

  // Nested metadata is inert persisted data, so validate it before using ordinary display paths.
  const parsed = MuxMessageSchema.safeParse({ ...original, id: message.id });
  if (!parsed.success || parsed.data.role === "system") return message;
  return {
    ...parsed.data,
    metadata: {
      ...parsed.data.metadata,
      historySequence: message.metadata.historySequence,
      timestamp: message.metadata.timestamp,
      contextBudgetRejected: true,
      contextBudgetRejectedMessage: undefined,
    },
  };
}
