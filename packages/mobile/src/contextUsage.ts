import type { ChatSettings, SettingsData } from "./settings";
import { normalizeToCanonical, supports1MContext } from "../../../src/common/utils/ai/models";
import { resolveModelForMetadata } from "../../../src/common/utils/providers/modelEntries";
import { calculateTokenMeterData } from "../../../src/common/utils/tokens/tokenMeterUtils";
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

export function getContextMeterData(
  messages: MuxMessage[],
  options: ChatSettings | null,
  providers?: SettingsData["providers"],
  streamingMessageId?: string | null
) {
  // A picker change targets the next request, not the turn still using this context.
  const activeModel = streamingMessageId
    ? messages.find((message) => message.id === streamingMessageId)?.metadata?.model
    : undefined;
  const model = activeModel ?? options?.model ?? "unknown";
  const anthropic = options?.providerOptions?.anthropic;
  const canonical = normalizeToCanonical(model);
  const metadataModel = resolveModelForMetadata(model, providers ?? null);
  // Use synced per-model intent, but never advertise beta capacity when ZDR disables it.
  const use1M =
    supports1MContext(model, providers) &&
    anthropic?.disableBetaFeatures !== true &&
    (anthropic?.use1MContext === true ||
      (anthropic?.use1MContextModels?.some(
        (enabled) => enabled === model || enabled === canonical || enabled === metadataModel
      ) ??
        false));
  return calculateTokenMeterData(getContextUsage(messages, model), model, use1M, false, providers);
}
