import { describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Tool } from "ai";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  MEMORY_INTUITION_MAX_USES_PER_TURN,
  MEMORY_INTUITION_TIMEOUT_MS,
} from "@/common/constants/memory";
import { IntuitionToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { Config } from "@/node/config";
import { InitStateManager } from "@/node/services/initStateManager";
import { MemoryService } from "@/node/services/memoryService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { createIntuitionTool } from "./intuition";
import { memoryScopeContextFromToolConfig } from "./memory";
import { TestTempDir, createTestToolConfig, mockToolCallOptions } from "./testHelpers";

const rememberedPath = "/memories/global/remembered.md";
const candidatePath = "/memories/global/candidate.md";
const memory = {
  path: rememberedPath,
  relevance: 0.9,
  excerpt: "Use explicit locks.",
  why: "Protect the shared write.",
};
const candidate = { path: candidatePath, relevance: 0.5, excerpt: "", why: "Possibly relevant." };

function reportingModel(
  items = [memory, memory, candidate],
  capture?: (options: LanguageModelV3CallOptions) => void,
  readPath = candidatePath
) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: (options) => {
      capture?.(options);
      const first = step++ === 0;
      const chunks: LanguageModelV3StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: first ? "memory_read" : "intuition_report",
          input: JSON.stringify(first ? { path: readPath } : { items }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 5, cacheRead: 3, cacheWrite: 2 },
            outputTokens: { total: 4, text: 3, reasoning: 1 },
          },
          providerMetadata: { anthropic: { cacheCreationInputTokens: 2 } },
        },
      ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

async function fixture(empty = false, thinkingLevel?: ThinkingLevel, metadataModel?: string) {
  const temp = new TestTempDir("intuition-tool");
  const root = path.join(temp.path, "xum");
  await fs.mkdir(path.join(root, "memory/global"), { recursive: true });
  if (!empty) {
    await fs.writeFile(path.join(root, "memory/global/remembered.md"), memory.excerpt);
    await fs.writeFile(path.join(root, "memory/global/candidate.md"), "Check the write path.");
  }
  const hostConfig = new Config(root);
  const meta = new MemoryMetaService(root);
  const memoryService = new MemoryService(hostConfig, meta);
  const controller = new AbortController();
  const createModel = mock((_modelString: string) =>
    Promise.resolve({
      model: reportingModel(),
      ...(metadataModel ? { metadataModel } : {}),
      optionsModelString: "openai:intuition-model",
      optionsProvidersConfig: null,
    })
  );
  const resolveAgentBody = mock(() =>
    Promise.resolve("Read memories and report relevant evidence.")
  );
  const reportModelUsage = mock<
    NonNullable<ReturnType<typeof createTestToolConfig>["reportModelUsage"]>
  >(() => undefined);
  const config = {
    ...createTestToolConfig(temp.path),
    experiments: { memory: true },
    memoryService,
    reportModelUsage,
    intuitionRuntime: {
      modelString: "openai:intuition-model",
      thinkingLevel,
      maxUsesPerTurn: MEMORY_INTUITION_MAX_USES_PER_TURN,
      usesThisTurn: 0,
      createModel,
      resolveAgentBody,
      abortSignal: controller.signal,
    },
  };
  return {
    config,
    hostConfig,
    meta,
    memoryService,
    controller,
    createModel,
    resolveAgentBody,
    reportModelUsage,
    [Symbol.dispose]: () => temp[Symbol.dispose](),
  };
}

async function execute(tool: Tool, abortSignal?: AbortSignal) {
  expect(tool.execute).toBeDefined();
  return IntuitionToolResultSchema.parse(
    await tool.execute!(
      { cue: "protect concurrent writes" },
      { ...mockToolCallOptions, abortSignal }
    )
  );
}

describe("intuition tool", () => {
  it("returns verified recall, accounts total usage in the pinned model, and records only unique recognized paths", async () => {
    using f = await fixture(false, undefined, "openai:pinned-pricing-model");
    const result = await execute(createIntuitionTool(f.config));
    expect(result).toMatchObject({
      kind: "recognized",
      memories: [memory],
      candidates: [{ path: candidatePath, relevance: 0.5 }],
      model: f.config.intuitionRuntime.modelString,
    });
    const entries = await f.meta.getEntries();
    expect([...entries.keys()]).toEqual(["global:remembered.md"]);
    expect(entries.get("global:remembered.md")).toMatchObject({ accessCount: 1 });
    expect(f.createModel).toHaveBeenCalledWith(f.config.intuitionRuntime.modelString);
    expect(f.reportModelUsage).toHaveBeenCalledTimes(1);
    expect(f.reportModelUsage.mock.calls[0][0].timestamp).toBeGreaterThan(0);
    expect(f.reportModelUsage.mock.calls[0][0]).toMatchObject({
      source: "tool",
      toolName: "intuition",
      model: f.config.intuitionRuntime.modelString,
      metadataModel: "openai:pinned-pricing-model",
      toolCallId: mockToolCallOptions.toolCallId,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 4 } },
    });
  });

  it("passes creation-time provider options for required reasoning while keeping ordinary thinking off", async () => {
    using f = await fixture();
    const calls: LanguageModelV3CallOptions[] = [];
    // Raw selection is a private alias, not the wire identity pinned by the factory.
    f.config.intuitionRuntime.modelString = "coder:private/recall";
    f.createModel.mockImplementation(() =>
      Promise.resolve({
        model: reportingModel([], (options) => calls.push(options)),
        optionsModelString: "openrouter:moonshotai/kimi-k3",
        optionsProvidersConfig: null,
      })
    );
    await execute(createIntuitionTool(f.config));
    expect(calls[0].providerOptions).toMatchObject({
      openrouter: { reasoning: { effort: "max" } },
    });
    calls.length = 0;
    f.createModel.mockImplementation(() =>
      Promise.resolve({
        model: reportingModel([], (options) => calls.push(options)),
        optionsModelString: "openrouter:moonshotai/kimi-k2.5",
        optionsProvidersConfig: null,
      })
    );
    await execute(createIntuitionTool(f.config));
    expect(calls[0].providerOptions?.openrouter).toBeUndefined();
  });

  it.each([
    { thinkingLevel: undefined, model: "openai:gpt-5.6-sol", effort: "none" },
    { thinkingLevel: "high", model: "openai:gpt-5.6-sol", effort: "high" },
    { thinkingLevel: "max", model: "openai:gpt-5.2", effort: "xhigh" },
  ] satisfies Array<{ thinkingLevel: ThinkingLevel | undefined; model: string; effort: string }>)(
    "sends configured $thinkingLevel effort as $effort for the pinned $model",
    async ({ thinkingLevel, model, effort }) => {
      using f = await fixture();
      const calls: LanguageModelV3CallOptions[] = [];
      f.config.intuitionRuntime.modelString = "coder:private/recall";
      f.config.intuitionRuntime.thinkingLevel = thinkingLevel;
      f.createModel.mockImplementation(() =>
        Promise.resolve({
          model: reportingModel([], (options) => calls.push(options)),
          optionsModelString: model,
          optionsProvidersConfig: null,
        })
      );
      const result = await execute(createIntuitionTool(f.config));
      expect(result.kind).toBe("uncertain");
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.providerOptions?.openai?.reasoningEffort).toBe(effort);
      }
    }
  );

  it.each(["chatCompletions", "responses"] as const)(
    "uses pinned OpenAI %s options for non-Off reasoning",
    async (wireFormat) => {
      using f = await fixture(false, "high");
      const calls: LanguageModelV3CallOptions[] = [];
      f.createModel.mockImplementation(() =>
        Promise.resolve({
          model: reportingModel([], (options) => calls.push(options)),
          optionsModelString: "openai:gpt-5.6-sol",
          optionsProvidersConfig: null,
          optionsMuxProviderOptions: { openai: { wireFormat } },
          optionsRouteProvider: "openai",
        })
      );
      const result = await execute(createIntuitionTool(f.config));
      expect(result.kind).toBe("uncertain");
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const options = call.providerOptions?.openai;
        expect(options?.reasoningEffort).toBe("high");
        if (wireFormat === "chatCompletions") {
          expect(options).not.toHaveProperty("reasoningSummary");
          expect(options).not.toHaveProperty("include");
          expect(options).not.toHaveProperty("truncation");
        } else {
          expect(options).toMatchObject({
            reasoningSummary: "detailed",
            include: ["reasoning.encrypted_content"],
            truncation: "disabled",
          });
        }
      }
    }
  );

  it("uses the pinned gateway route for a canonical origin model", async () => {
    using f = await fixture(false, "high");
    const calls: LanguageModelV3CallOptions[] = [];
    f.createModel.mockImplementation(() =>
      Promise.resolve({
        model: reportingModel([], (options) => calls.push(options)),
        optionsModelString: "openai:gpt-5.6-sol",
        optionsProvidersConfig: null,
        optionsRouteProvider: "openrouter",
      })
    );
    const result = await execute(createIntuitionTool(f.config));
    expect(result.kind).toBe("uncertain");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.providerOptions?.openrouter).toMatchObject({ reasoning: { effort: "high" } });
      expect(call.providerOptions?.openai).toBeUndefined();
    }
  });

  it.each([false, true])(
    "honors path-specific shell hooks for nested reads and verification-only reports (read denied path: %s)",
    async (readDeniedPath) => {
      using f = await fixture();
      const hooksDir = path.join(f.config.cwd, ".xum");
      await fs.mkdir(hooksDir, { recursive: true });
      await fs.writeFile(
        path.join(hooksDir, "tool_pre"),
        `#!/bin/bash
if [ "$XUM_TOOL" = memory ] && [ "$XUM_TOOL_INPUT_COMMAND" = view ]; then
  printf 'pre:%s\n' "$XUM_TOOL_INPUT_FILE_PATH" >> "$PWD/hook-audit"
  if [ "$XUM_TOOL_INPUT_FILE_PATH" = "${rememberedPath}" ]; then
    echo 'private memory denied'
    exit 1
  fi
fi
`,
        { mode: 0o755 }
      );
      await fs.writeFile(
        path.join(hooksDir, "tool_post"),
        `#!/bin/bash
if [ "$XUM_TOOL" = memory ]; then
  printf 'post:%s\n' "$XUM_TOOL_INPUT_FILE_PATH" >> "$PWD/hook-audit"
  echo 'scan audited'
fi
`,
        { mode: 0o755 }
      );
      const prompts: string[] = [];
      f.createModel.mockImplementation(() =>
        Promise.resolve({
          model: reportingModel(
            [memory, candidate],
            (options) => prompts.push(JSON.stringify(options.prompt)),
            readDeniedPath ? rememberedPath : candidatePath
          ),
          optionsModelString: "openai:intuition-model",
          optionsProvidersConfig: null,
        })
      );
      const reads = spyOn(f.memoryService, "readFileWithSha");
      const result = await execute(createIntuitionTool({ ...f.config, trusted: true }));
      expect(result.kind).toBe("uncertain");
      expect(reads.mock.calls.map((call) => call[1])).toEqual(
        readDeniedPath ? [] : [candidatePath]
      );
      expect(prompts[1]).not.toContain(memory.excerpt);
      expect(prompts[1]).toContain(
        readDeniedPath ? "private memory denied" : "Check the write path."
      );
      if (!readDeniedPath) expect(prompts[1]).toContain("scan audited");
      expect((await f.meta.getEntries()).size).toBe(0);
      const audit = await fs.readFile(path.join(f.config.cwd, "hook-audit"), "utf8");
      expect(audit).toContain(`pre:${rememberedPath}`);
      expect(audit).not.toContain(`post:${rememberedPath}`);
      if (!readDeniedPath) expect(audit).toContain(`post:${candidatePath}`);
    }
  );

  it("leaves candidate scans out of recall metadata", async () => {
    using f = await fixture();
    f.createModel.mockImplementation(() =>
      Promise.resolve({
        model: reportingModel([candidate]),
        optionsModelString: "openai:intuition-model",
        optionsProvidersConfig: null,
      })
    );
    expect(await execute(createIntuitionTool(f.config))).toMatchObject({
      kind: "uncertain",
      candidates: [{ path: candidatePath }],
    });
    expect((await f.meta.getEntries()).size).toBe(0);
  });

  it("skips model, body, and usage for an empty index, including through registration without runtime init", async () => {
    using f = await fixture(true);
    const init = new InitStateManager(f.hostConfig);
    const waitForInit = spyOn(init, "waitForInit").mockImplementation(() =>
      Promise.reject(new Error("runtime must not initialize"))
    );
    try {
      const tools = await getToolsForModel("openai:gpt-5.2", f.config, f.config.workspaceId!, init);
      expect(tools.intuition).toBeDefined();
      expect(tools.memory).toBeDefined();
      const result = await execute(tools.intuition);
      expect(result).toMatchObject({
        kind: "uncertain",
        candidates: [],
        stats: { indexEntriesConsidered: 0, timedOut: false },
      });
      expect(result.kind === "uncertain" && typeof result.note === "string").toBe(true);
      expect(waitForInit).not.toHaveBeenCalled();
      expect(f.createModel).not.toHaveBeenCalled();
      expect(f.resolveAgentBody).not.toHaveBeenCalled();
      expect(f.reportModelUsage).not.toHaveBeenCalled();
      const disabled = await getToolsForModel(
        "openai:gpt-5.2",
        { ...f.config, experiments: { memory: false } },
        f.config.workspaceId!,
        init
      );
      expect(disabled.intuition).toBeUndefined();
      expect(disabled.memory).toBeUndefined();
    } finally {
      waitForInit.mockRestore();
    }
  });

  it("reserves concurrent uses before awaiting and resets the cap for a new turn", async () => {
    using f = await fixture(true);
    const tool = createIntuitionTool(f.config);
    const retryTool = createIntuitionTool(f.config);
    const results = await Promise.all(
      Array.from({ length: MEMORY_INTUITION_MAX_USES_PER_TURN + 1 }, (_, i) =>
        execute(i % 2 ? retryTool : tool)
      )
    );
    expect(results.map((r) => r.kind)).toEqual([
      "uncertain",
      "uncertain",
      "uncertain",
      "limit_reached",
    ]);
    expect((await execute(createIntuitionTool(f.config))).kind).toBe("limit_reached");
    const nextTurn = {
      ...f.config,
      intuitionRuntime: { ...f.config.intuitionRuntime, usesThisTurn: 0 },
    };
    expect((await execute(createIntuitionTool(nextTurn))).kind).toBe("uncertain");
  });

  it("preserves verified recall when usage reporting throws", async () => {
    using f = await fixture();
    f.reportModelUsage.mockImplementation(() => {
      throw new Error("telemetry offline");
    });
    expect((await execute(createIntuitionTool(f.config))).kind).toBe("recognized");
    expect((await f.meta.getEntries()).size).toBe(1);
  });

  it("maps setup failures and caller cancellation to errors without counting recall", async () => {
    using f = await fixture();
    f.createModel.mockImplementationOnce(() => Promise.reject(new Error("provider unavailable")));
    const tool = createIntuitionTool(f.config);
    expect(await execute(tool)).toMatchObject({ kind: "error", isError: true });
    expect(await execute(tool, AbortSignal.abort())).toMatchObject({
      kind: "error",
      isError: true,
    });
    f.reportModelUsage.mockImplementation(() => {
      f.controller.abort();
    });
    expect(await execute(tool, new AbortController().signal)).toMatchObject({
      kind: "error",
      isError: true,
    });
    expect((await f.meta.getEntries()).size).toBe(0);
  });

  it("returns committed recall when cancellation races with metadata persistence", async () => {
    using f = await fixture();
    const recordRecall = f.memoryService.recordRecall.bind(f.memoryService);
    const recall = spyOn(f.memoryService, "recordRecall").mockImplementation(async (ctx, path) => {
      await recordRecall(ctx, path);
      f.controller.abort();
    });
    try {
      const result = await execute(createIntuitionTool(f.config));
      expect(result).toMatchObject({ kind: "recognized", memories: [memory] });
      expect(recall).toHaveBeenCalledTimes(1);
      expect((await f.meta.getEntries()).get("global:remembered.md")?.accessCount).toBe(1);
    } finally {
      recall.mockRestore();
    }
  });

  it(
    "maps an internal timeout to uncertainty, not cancellation",
    async () => {
      using f = await fixture();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.createModel.mockImplementation(() => {
        started();
        return new Promise(() => {
          /* hung provider setup */
        });
      });
      const timer = spyOn(globalThis, "setTimeout");
      const pending = execute(createIntuitionTool(f.config));
      try {
        await ready;
        const expire = timer.mock.calls.find(
          ([, delay]) => delay === MEMORY_INTUITION_TIMEOUT_MS
        )?.[0];
        if (typeof expire !== "function") throw new Error("Expected intuition deadline");
        expire();
        const result = await pending;
        expect(result).toMatchObject({
          kind: "uncertain",
          candidates: [],
          stats: { timedOut: true },
        });
        expect(result.kind === "uncertain" && typeof result.note === "string").toBe(true);
        expect((await f.meta.getEntries()).size).toBe(0);
      } finally {
        timer.mockRestore();
      }
    },
    MEMORY_INTUITION_TIMEOUT_MS + 5000
  );

  it("uses stable project identity and disables ambiguous multi-project memory", async () => {
    using f = await fixture(true);
    const config = { ...f.config, workspaceProjectPath: "/stable/project" };
    expect(memoryScopeContextFromToolConfig(config)).toMatchObject({
      checkoutCwd: config.cwd,
      workspaceId: config.workspaceId,
      projectPath: "/stable/project",
    });
    expect(
      memoryScopeContextFromToolConfig({
        ...config,
        projects: [
          { projectPath: "/one", projectName: "one" },
          { projectPath: "/two", projectName: "two" },
        ],
      }).projectPath
    ).toBe("");
  });
});
