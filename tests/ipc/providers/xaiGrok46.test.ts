import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isStreamEnd } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { HistoryService } from "@/node/services/historyService";
import {
  assertStreamSuccess,
  configureTestRetries,
  createStreamCollector,
  sendMessageWithModel,
} from "../helpers";
import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["XAI_API_KEY"]);
}

const DISABLE_TOOLS: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

function hasXaiEncryptedReasoning(messages: MuxMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (part.type !== "reasoning") continue;
      const encrypted = part.providerOptions?.xai?.reasoningEncryptedContent;
      if (typeof encrypted === "string" && encrypted.length > 0) {
        return true;
      }
    }
  }
  return false;
}

async function waitForTerminal(
  collector: ReturnType<typeof createStreamCollector>,
  timeoutMs: number
) {
  const terminalEvent = await Promise.race([
    collector.waitForEvent("stream-end", timeoutMs),
    collector.waitForEvent("stream-error", timeoutMs),
  ]);
  if (!terminalEvent) {
    throw new Error("Expected terminal stream event from Grok 4.6");
  }
  if (terminalEvent.type === "stream-error") {
    throw new Error(`Grok 4.6 stream failed: ${terminalEvent.error}`);
  }
  if (!isStreamEnd(terminalEvent)) {
    throw new Error(`Expected stream-end event, received ${terminalEvent.type}`);
  }
  return terminalEvent;
}

describeIntegration("xAI Grok 4.6 integration", () => {
  configureTestRetries(3);

  test("streams a priority request and reports exact billed cost metadata", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("xai", "grok-4-6");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    try {
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        "Reply with exactly: GROK46_OK",
        KNOWN_MODELS.GROK_46.id,
        {
          // Grok 4.6's built-in minimum thinking floor is medium.
          thinkingLevel: "medium",
          providerOptions: {
            xai: {
              serviceTier: "priority",
              searchParameters: { mode: "off" },
            },
          },
        }
      );

      expect(result.success).toBe(true);

      const streamEnd = await waitForTerminal(collector, 60_000);

      assertStreamSuccess(collector);
      expect(streamEnd.metadata.model).toBe(KNOWN_MODELS.GROK_46.id);
      expect(streamEnd.metadata.thinkingLevel).toBe("medium");

      const xaiMetadata = streamEnd.metadata.providerMetadata?.xai as
        | { costInUsdTicks?: unknown }
        | undefined;
      expect(typeof xaiMetadata?.costInUsdTicks).toBe("number");
      expect(xaiMetadata?.costInUsdTicks).toBeGreaterThan(0);
      expect(collector.getStreamContent().trim().length).toBeGreaterThan(0);
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 90_000);

  test("multi-turn with default store=false keeps encrypted reasoning and continues cleanly", async () => {
    // Grok 4.6 Responses always use store=false in Mux (ZDR-safe default).
    // With store=false, xAI returns reasoning.encrypted_content which Mux must
    // persist and replay; otherwise the second turn fails or loses quality.
    const { env, workspaceId, cleanup } = await setupWorkspace("xai", "grok-4-6-zdr");
    const historyService = new HistoryService(env.config);

    try {
      const firstCollector = createStreamCollector(env.orpc, workspaceId);
      firstCollector.start();
      await firstCollector.waitForSubscription();

      const firstResult = await sendMessageWithModel(
        env,
        workspaceId,
        [
          "Think carefully about this secret codeword for the rest of the chat: MUXZDR42.",
          "Do not mention the codeword yet.",
          "Reply with exactly: READY",
        ].join(" "),
        KNOWN_MODELS.GROK_46.id,
        {
          thinkingLevel: "medium",
          toolPolicy: DISABLE_TOOLS,
          // Explicitly exercise the non-store path (also the product default).
          providerOptions: {
            xai: {
              store: false,
            },
          },
        }
      );
      expect(firstResult.success).toBe(true);

      const firstEnd = await waitForTerminal(firstCollector, 90_000);
      assertStreamSuccess(firstCollector);
      expect(firstCollector.getStreamContent()).toMatch(/READY/i);
      firstCollector.stop();

      // Prove encrypted reasoning landed in persisted history under store=false.
      const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(historyResult.success).toBe(true);
      if (!historyResult.success) {
        throw new Error(historyResult.error);
      }
      expect(hasXaiEncryptedReasoning(historyResult.data)).toBe(true);

      // Second turn must succeed by replaying encrypted reasoning without server storage.
      const secondCollector = createStreamCollector(env.orpc, workspaceId);
      secondCollector.start();
      await secondCollector.waitForSubscription();

      const secondResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Now reply with exactly the secret codeword and nothing else.",
        KNOWN_MODELS.GROK_46.id,
        {
          thinkingLevel: "medium",
          toolPolicy: DISABLE_TOOLS,
          providerOptions: {
            xai: {
              store: false,
            },
          },
        }
      );
      expect(secondResult.success).toBe(true);

      await waitForTerminal(secondCollector, 90_000);
      assertStreamSuccess(secondCollector);

      expect(secondCollector.getStreamContent()).toMatch(/MUXZDR42/);
      expect(firstEnd.metadata.model).toBe(KNOWN_MODELS.GROK_46.id);
      secondCollector.stop();
    } finally {
      await cleanup();
    }
  }, 180_000);
});
