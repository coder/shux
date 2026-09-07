import { tmpdir } from "node:os";
import { prepareToolSearch, type ToolSearchRuntime } from "@/common/utils/tools/toolCatalog";
import { createToolSearchTool } from "./tools/toolSearch";
import { createTestToolConfig } from "./tools/testHelpers";
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { evaluateStepBudget } from "@/common/utils/compaction/contextBudget";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";

describe("settled context hard ceiling", () => {
  test.each(["inactive", "activation-fits", "activation-overflow", "search-off"] as const)(
    "checks actual active schemas before each provider step (%s)",
    async (mode) => {
      const h = await createTestHistoryService();
      const workspaceId = "catalog-budget";
      const messageId = "catalog-assistant";
      let providerCalls = 0;
      const searchRuntime: ToolSearchRuntime = {};
      const tools = {
        tool_catalog_search: createToolSearchTool({
          ...createTestToolConfig(h.tempDir),
          toolSearchRuntime: searchRuntime,
        }),
        mcp_large: tool({
          description: "Large catalog schema",
          inputSchema: z.object({
            argument: z.string().describe("漢".repeat(mode === "activation-fits" ? 100 : 10000)),
          }),
        }),
      };
      const search = prepareToolSearch({ tools, mcpToolNames: ["mcp_large"] });
      searchRuntime.state = search.state;
      const model = new MockLanguageModelV3({
        doStream: (request) => {
          providerCalls++;
          const activate = providerCalls === 1 && mode !== "inactive" && mode !== "search-off";
          expect(request.tools?.some((entry) => entry.name === "mcp_large")).toBe(
            providerCalls > 1
          );
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                ...(activate
                  ? [
                      {
                        type: "tool-call" as const,
                        toolCallId: "activation",
                        toolName: "tool_catalog_search",
                        input: '{"query":"mcp_large"}',
                      },
                    ]
                  : [
                      { type: "text-start" as const, id: "answer" },
                      { type: "text-delta" as const, id: "answer", delta: "Done" },
                      { type: "text-end" as const, id: "answer" },
                    ]),
                {
                  type: "finish",
                  finishReason: {
                    unified: activate ? "tool-calls" : "stop",
                    raw: activate ? "tool_calls" : "stop",
                  },
                  usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        },
      });
      const manager = new StreamManager(h.historyService);
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "context-budget-stream-"));
      try {
        expect(
          (
            await h.historyService.appendManyToHistory(workspaceId, [
              createMuxMessage("user", "user", "Use the catalog"),
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
          messages: [{ role: "user", content: "Use the catalog" }],
          system: "Use tools",
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          tools: search.tools,
          toolSearchState: mode === "search-off" ? undefined : search.state,
          contextBudgetLimit: 10000,
        });
        expect(started.success).toBe(true);
        if (!started.success) throw new Error("Expected stream construction");
        const completion = await started.data.completion;
        const blocked = mode === "activation-overflow" || mode === "search-off";
        expect(completion.status).toBe(blocked ? "failed" : "completed");
        if (completion.status === "failed") {
          expect(completion.streamError.errorType).toBe("context_budget_blocked");
          expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
        }
        expect(providerCalls).toBe(mode === "search-off" ? 0 : mode === "activation-fits" ? 2 : 1);
        const activated = [...search.state!.activatedToolNames];
        expect(activated).toEqual(mode.startsWith("activation") ? ["mcp_large"] : []);
        expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const toolResults = history.data.flatMap((row) =>
          row.parts.filter((part) => part.type === "dynamic-tool")
        );
        expect(toolResults).toHaveLength(activated.length);
        if (activated.length)
          expect(toolResults[0]).toMatchObject({
            toolCallId: "activation",
            state: "output-available",
            output: { matches: [{ name: "mcp_large" }] },
          });
        expect(
          history.data.some((row) => row.metadata?.muxMetadata?.type === "context-window-rollover")
        ).toBe(false);
      } finally {
        await manager.stopStream(workspaceId);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await h.cleanup();
      }
    }
  );

  test.each(["thinking", "fallback"] as const)(
    "late %s rebuild uses its actual messages and model limit before provider dispatch",
    async (mode) => {
      const h = await createTestHistoryService();
      const manager = new StreamManager(h.historyService);
      const workspaceId = "rebuilt-budget";
      const messageId = "rebuilt-assistant";
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "context-budget-stream-"));
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const primary = new MockLanguageModelV3({
        doStream: () => {
          primaryCalls++;
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "finish",
                  finishReason: { unified: "content-filter", raw: "refusal" },
                  usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 0, text: 0, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        },
      });
      const fallback = new MockLanguageModelV3({
        doStream: () => {
          fallbackCalls++;
          throw new Error("Oversized rebuilt request reached the provider");
        },
      });
      const large = "漢".repeat(10000);
      try {
        expect(
          (
            await h.historyService.appendManyToHistory(workspaceId, [
              createMuxMessage("user", "user", "Small request"),
              createMuxMessage(messageId, "assistant", ""),
            ])
          ).success
        ).toBe(true);
        const started = await manager.startStream({
          workspaceId,
          messageId,
          historySequence: 1,
          model: primary,
          modelString: "openai:gpt-4o",
          messages: [{ role: "user", content: "Small request" }],
          system: "Small system",
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          contextBudgetLimit: mode === "fallback" ? 100000 : 10000,
          ...(mode === "thinking"
            ? {
                thinkingOverrideState: { pending: "high" as const },
                rebuildProviderOptionsForThinkingLevel: () => ({
                  providerOptions: {},
                  effectiveLevel: "high" as const,
                }),
                rebuildFirstStepForThinkingLevel: () =>
                  Promise.resolve([{ role: "user" as const, content: large }]),
              }
            : {
                modelFallback: {
                  chain: ["openai:gpt-4o-mini"],
                  prepare: (modelString: string) =>
                    Promise.resolve({
                      success: true as const,
                      data: {
                        model: fallback,
                        modelString,
                        messages: [{ role: "user" as const, content: "Small request" }],
                        system: "Small system",
                        tools: {
                          activated: tool({ description: large, inputSchema: z.object({}) }),
                        },
                        contextBudgetLimit: 10000,
                      },
                    }),
                },
              }),
        });
        if (!started.success) throw new Error("Expected stream construction");
        const completion = await started.data.completion;
        expect(completion).toMatchObject({
          status: "failed",
          streamError: { errorType: "context_budget_blocked" },
        });
        if (completion.status === "failed") {
          expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
          expect(completion.streamError.error).toContain(
            mode === "fallback" ? "openai:gpt-4o-mini" : "openai:gpt-4o"
          );
        }
        expect(primaryCalls).toBe(mode === "fallback" ? 1 : 0);
        expect(fallbackCalls).toBe(0);
      } finally {
        await manager.stopStream(workspaceId);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await h.cleanup();
      }
    }
  );

  test("dense outputs stop before a second provider call at auto-off and retain every paired result", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "dense-output-hard-stop";
    const messageId = "assistant-hard-stop";
    const outputs = ["🦊".repeat(50000), "second sibling completed"];
    let providerCalls = 0;
    const executed: number[] = [];
    const model = new MockLanguageModelV3({
      doStream: () => {
        providerCalls += 1;
        if (providerCalls > 1)
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "unexpected" },
                { type: "text-delta", id: "unexpected", delta: "unexpected second request" },
                { type: "text-end", id: "unexpected" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "first", toolName: "produce", input: '{"index":0}' },
              {
                type: "tool-call",
                toolCallId: "second",
                toolName: "produce",
                input: '{"index":1}',
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 10, text: 10, reasoning: 0 },
                },
              },
            ],
          }),
        });
      },
    });
    const manager = new StreamManager(h.historyService);
    const runtimeDir = path.join(h.tempDir, "runtime");
    await fs.mkdir(runtimeDir);
    try {
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("user", "user", "Run both tools"),
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
        messages: [{ role: "user", content: "Run both tools" }],
        system: "Run tools",
        runtime: new LocalRuntime(h.tempDir),
        providedRuntimeTempDir: runtimeDir,
        tools: {
          produce: tool({
            inputSchema: z.object({ index: z.number() }),
            execute: ({ index }) => {
              executed.push(index);
              return outputs[index];
            },
          }),
        },
        onStepSettled: (step) => {
          expect(Math.ceil(step.toolResultChars / 4) + 1010).toBeLessThan(119808);
          expect(step.toolResultTokens).toBeGreaterThan(119808);
          return Promise.resolve(
            evaluateStepBudget({
              contextTokens: step.usage?.inputTokens ?? 0,
              outputTokens: step.usage?.outputTokens ?? 0,
              toolResultChars: step.toolResultChars,
              imageParts: step.imageParts,
              toolResultTokens: step.toolResultTokens,
              modelContextLimit: 128000,
              threshold: 1,
              warningEmitted: false,
            }).decision
          );
        },
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error("Expected stream startup");
      const completion = await started.data.completion;
      expect(completion).toMatchObject({
        status: "failed",
        streamError: { errorType: "context_budget_blocked" },
      });
      if (completion.status === "failed")
        expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
      expect(providerCalls).toBe(1);
      expect(executed).toEqual([0, 1]);
      expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
      const history = await h.historyService.getLastMessages(workspaceId, 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      const resultParts = history.data
        .find((row) => row.id === messageId)
        ?.parts.filter((part) => part.type === "dynamic-tool");
      expect(resultParts).toHaveLength(2);
      expect(
        resultParts?.map((part) => ({
          id: part.toolCallId,
          state: part.state,
          output: part.state === "output-available" ? part.output : undefined,
        }))
      ).toEqual([
        { id: "first", state: "output-available", output: outputs[0] },
        { id: "second", state: "output-available", output: outputs[1] },
      ]);
      expect(
        history.data.some(
          (row) =>
            row.metadata?.muxMetadata?.type === "context-window-rollover" ||
            row.metadata?.muxMetadata?.type === "context-budget-warning"
        )
      ).toBe(false);
      expect(history.data.filter((row) => row.role === "user")).toHaveLength(1);
    } finally {
      await manager.stopStream(workspaceId);
      await h.cleanup();
    }
  }, 20000);
});
