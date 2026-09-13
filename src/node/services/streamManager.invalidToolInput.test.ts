import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createMuxMessage } from "@/common/types/message";
import { AdvisorToolInputSchema } from "@/common/utils/tools/toolDefinitions";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";

describe("StreamManager - invalid tool input", () => {
  test("the model's same-turn retry and the persisted history both get the concise summary", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "invalid-tool-input";
    const messageId = "invalid-tool-input-assistant";
    const toolCallId = "advisor-invalid-call";
    const oversized = "x".repeat(2100);
    let providerCalls = 0;
    let retryPrompt: LanguageModelV3Prompt | undefined;
    const model = new MockLanguageModelV3({
      doStream: (request) => {
        providerCalls++;
        if (providerCalls === 2) retryPrompt = request.prompt;
        const usage = {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        };
        const chunks: LanguageModelV3StreamPart[] =
          providerCalls === 1
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId,
                  toolName: "advisor",
                  input: JSON.stringify({ question: oversized }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "Done" },
                { type: "text-end", id: "answer" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
      },
    });
    const manager = new StreamManager(h.historyService);
    const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "invalid-tool-input-stream-"));
    try {
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("user", "user", "Ask the advisor"),
            createMuxMessage(messageId, "assistant", ""),
          ])
        ).success
      ).toBe(true);
      const started = await manager.startStream({
        workspaceId,
        messageId,
        historySequence: 1,
        model,
        modelString: "openai:gpt-4o",
        messages: [{ role: "user", content: "Ask the advisor" }],
        system: "Use tools",
        runtime: new LocalRuntime(h.tempDir),
        providedRuntimeTempDir: runtimeDir,
        tools: {
          advisor: tool({
            description: "test advisor",
            inputSchema: AdvisorToolInputSchema,
            execute: (): Promise<{ advice: string }> =>
              Promise.reject(new Error("invalid input must not execute")),
          }),
        },
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error("Expected stream construction");
      const completion = await started.data.completion;
      expect(completion.status).toBe("completed");
      expect(providerCalls).toBe(2);

      // Same turn: streamText feeds the rejected call's tool-result straight into the
      // next step, so the retry prompt is where the SDK's input-echoing text would land.
      const retryToolResult = retryPrompt
        ?.flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
      if (retryToolResult?.type !== "tool-result") throw new Error("Expected a tool-result");
      expect(retryToolResult.output.type).toBe("error-text");
      if (retryToolResult.output.type !== "error-text") throw new Error("Expected error-text");
      const summary = retryToolResult.output.value;
      expect(summary).toContain("advisor");
      expect(summary).toContain("question");
      expect(summary).toContain("2000");
      expect(summary).toContain("received 2100 characters");
      expect(summary).not.toContain("xxxx");
      expect(summary.length).toBeLessThan(300);

      // Later turns: the persisted tool part carries the same summary.
      expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const toolPart = history.data
        .find((row) => row.id === messageId)
        ?.parts.find((part) => part.type === "dynamic-tool");
      expect(toolPart).toMatchObject({
        toolCallId,
        state: "output-available",
        output: { success: false, error: summary },
      });
    } finally {
      await manager.stopStream(workspaceId);
      await fs.rm(runtimeDir, { recursive: true, force: true });
      await h.cleanup();
    }
  });
});
