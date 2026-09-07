import { describe, expect, spyOn, test } from "bun:test";
import { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { createTestHistoryService } from "./testHistoryService";
import { createMuxMessage } from "@/common/types/message";
import type { StreamAbortEvent } from "@/common/types/stream";

// Exercise the real facade's pending-start registration and cancellation handle,
// including the mock-mode shortcut that returns before a player handle exists.
describe("AIService startup completion", () => {
  test.each(["user", "system"] as const)(
    "preserves %s cancellation reason without inventing a delivered abort",
    async (abortReason) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      const init = new InitStateManager(config);
      const service = new AIService(config, historyService, init, new ProviderService(config));
      service.enableMockMode();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      spyOn(init, "waitForInit").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const aborts: StreamAbortEvent[] = [];
      service.on("stream-abort", (event) => {
        aborts.push(event as StreamAbortEvent);
      });
      let registeredId: string | undefined;
      const started = service.streamMessage({
        workspaceId: "startup",
        modelString: "openai:gpt-4o",
        messages: [createMuxMessage("user", "user", "hello")],
        onStreamStarting: (messageId) => {
          registeredId = messageId;
        },
      });
      try {
        // Registration must be synchronous even when init has not run yet.
        expect(registeredId).toBeDefined();
        await entered.promise;
        await service.stopStream("startup", { abortReason });
        release.resolve();
        const result = await started;
        if (!result.success) throw new Error(JSON.stringify(result.error));
        expect(result.data.messageId).toBe(registeredId!);
        expect(await result.data.completion).toEqual({ status: "aborted", abortReason });
        expect(aborts).toMatchObject([{ messageId: registeredId, abortReason }]);
      } finally {
        release.resolve();
        await started;
        await cleanup();
      }
    }
  );
});
