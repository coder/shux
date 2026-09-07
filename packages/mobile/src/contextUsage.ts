import type { MuxMessage } from "../../../src/common/types/message";
import { getContextBoundaryKind } from "../../../src/common/utils/messages/compactionBoundary";
import { createDisplayUsage } from "../../../src/common/utils/tokens/displayUsage";

export function getContextUsage(messages: MuxMessage[], model: string) {
  // Like desktop, use the latest request in the current epoch, never session totals.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const boundary = getContextBoundaryKind(message);
    if (boundary === "reset") return undefined;
    const metadata = message.metadata;
    if (
      message.role === "assistant" &&
      (boundary || !metadata?.compacted) &&
      metadata?.contextUsage
    ) {
      return createDisplayUsage(
        metadata.contextUsage,
        metadata.model ?? model,
        boundary ? undefined : (metadata.contextProviderMetadata ?? metadata.providerMetadata),
        metadata.metadataModel
      );
    }
    if (boundary) return undefined;
  }
  return undefined;
}
