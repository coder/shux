/**
 * Tests for code_execution tool
 */

import { describe, it, expect, mock } from "bun:test";
import { createCodeExecutionTool, clearTypeCaches, type MountRunner } from "./code_execution";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import { extractAttachmentsFromToolOutput } from "@/node/utils/messages/toolResultAttachments";
import { DISPLAY_DATA_STUB, MEDIA_DATA_STUB } from "@/common/utils/attachments/toolAttachmentParts";
import type { Tool, ToolExecutionOptions } from "ai";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { z } from "zod";
import { DisposableTempDir } from "@/node/services/tempDir";
import { SandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { createKernelFileLoader } from "@/node/services/tools/kernelFileLoad";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RESULT_HANDLE_VARS_CAP_BYTES, VARS_SNAPSHOT_MAX_BYTES } from "@/constants/resultHandles";
import { KERNEL_RETAINED_MEDIA_BUDGET_BYTES } from "@/constants/kernelOutput";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

/**
 * Realistic mock result shapes matching actual tool result schemas.
 */
const mockResults = {
  file_read: {
    success: true as const,
    content: "mock file content",
    file_size: 100,
    modifiedTime: "2025-01-01T00:00:00Z",
    lines_read: 5,
  },
  bash: {
    success: true as const,
    output: "mock output",
    exitCode: 0,
    wall_duration_ms: 10,
  },
};

// Create a mock tool for testing - accepts sync functions
function createMockTool(
  name: string,
  schema: z.ZodType,
  executeFn?: (args: unknown) => unknown
): Tool {
  const defaultResult = mockResults[name as keyof typeof mockResults];
  const tool: Tool = {
    description: `Mock ${name} tool`,
    inputSchema: schema,
    execute: executeFn
      ? (args) => Promise.resolve(executeFn(args))
      : () => Promise.resolve(defaultResult ?? { success: true }),
  };
  return tool;
}

describe("createCodeExecutionTool", () => {
  const runtimeFactory = new QuickJSRuntimeFactory();

  describe("tool creation", () => {
    it("creates tool with description containing available tools", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        bash: createMockTool("bash", z.object({ script: z.string() }), () => ({ output: "ok" })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions instead of prose
      expect(desc).toContain("declare namespace xum");
      expect(desc).toContain("declare const mux: typeof xum");
      expect(desc).toContain("function file_read");
      expect(desc).toContain("function bash");
    });

    it("excludes UI-specific tools from description", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        todo_write: createMockTool("todo_write", z.object({ todos: z.array(z.string()) }), () => ({
          success: true,
        })),
        status_set: createMockTool("status_set", z.object({ message: z.string() }), () => ({
          success: true,
        })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions
      expect(desc).toContain("function file_read");
      expect(desc).not.toContain("function todo_write");
      expect(desc).not.toContain("function status_set");
    });

    it("excludes provider-native tools without execute function", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        web_search: {
          description: "Provider-native search",
          inputSchema: z.object({ query: z.string() }),
          // No execute function - provider handles this
        } satisfies Tool,
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions
      expect(desc).toContain("function file_read");
      expect(desc).not.toContain("function web_search");
    });
  });

  describe("kernel-first description preamble (RLM + exclusive posture)", () => {
    // Never invoked: these tests only inspect the model-facing description,
    // which is settled at creation time.
    const unusedMount: MountRunner = () => Promise.reject(new Error("not executed"));
    const baseTools = (): Record<string, Tool> => ({
      file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
    });

    it("prepends the preamble only when kernelFirst is set on a persistent mount", async () => {
      const withPreamble = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(baseTools()),
        undefined,
        unusedMount,
        { kernelFirst: true }
      );
      const kernelOnly = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(baseTools()),
        undefined,
        unusedMount
      );

      const preambleDesc = (withPreamble as { description?: string }).description ?? "";
      expect(preambleDesc.startsWith("**Kernel-first workflow:**")).toBe(true);
      // The kernel addendum stays too — the preamble is additive.
      expect(preambleDesc).toContain("Persistent kernel");

      // RLM without exclusive (or the env-var mount override): kernel notes
      // only, byte-identical to the pre-preamble kernel description.
      const kernelDesc = (kernelOnly as { description?: string }).description ?? "";
      expect(kernelDesc).not.toContain("Kernel-first");
      expect(preambleDesc.endsWith(kernelDesc)).toBe(true);
    });

    it("ignores kernelFirst without a persistent mount (never advertise a missing kernel)", async () => {
      const ephemeralWithFlag = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(baseTools()),
        undefined,
        undefined,
        { kernelFirst: true }
      );
      const ephemeral = await createCodeExecutionTool(runtimeFactory, new ToolBridge(baseTools()));

      expect(ephemeralWithFlag.description).toBe(ephemeral.description ?? "");
      expect(ephemeralWithFlag.description).not.toContain("Kernel-first");
    });

    it("mentions task_spawn/events only when the task tool is bridgeable", async () => {
      const withTask = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({
          ...baseTools(),
          task: createMockTool("task", z.object({ prompt: z.string() })),
        }),
        undefined,
        unusedMount,
        { kernelFirst: true }
      );
      const withoutTask = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(baseTools()),
        undefined,
        unusedMount,
        { kernelFirst: true }
      );

      expect(withTask.description).toContain("xum.task_spawn");
      expect(withoutTask.description).not.toContain("task_spawn");
    });
  });

  describe("static analysis", () => {
    it("rejects code with syntax errors", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const x = {" }, // Unclosed brace
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
    });

    it("includes line numbers for syntax errors with invalid tokens", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      // Invalid token @ on line 2 - parser detects it on the exact line
      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = @;\nconst z = 3;" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("(line 2)");
    });

    it("rejects code using unavailable globals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const env = process.env" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("process");
    });

    it("includes line numbers for unavailable globals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = 2;\nconst env = process.env" }, // process on line 3
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("(line 3)");
    });

    it("rejects code using require()", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'const fs = require("fs")' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("require");
    });

    it("does not reject 'require(' inside string literals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        {
          code: 'return "this is a string containing require(fs) but should be allowed"',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toContain("require(");
    });

    it("does not reject 'import(' inside string literals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'return `this is a template string containing import("fs")`' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toContain("import(");
    });

    it("rejects code using dynamic import()", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'return import("fs")' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("Dynamic import() is not available");
    });

    it("surfaces runtime validation errors for wrong tool args", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst result = mux.bash({ scriptz: 'ls' });" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toContain("script");
    });

    it("surfaces runtime errors for calling non-existent tools", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = 2;\nmux.nonexistent({ arg: 1 });" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toMatch(/nonexistent|not a function/i);
    });
  });

  describe("code execution", () => {
    it("executes simple code and returns result", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "return 1 + 2" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    it("normalizes non-JSON guest values so the output survives strict JSONValue validation", async () => {
      // Regression: console.log(undefined) / returned undefined fields used to
      // reach the AI SDK verbatim, failing ModelMessage validation on the next
      // step and killing the live stream (AI_InvalidPromptError) — while the
      // retry, rebuilt from JSON-rehydrated history, succeeded.
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        {
          code: "console.log(undefined); return { a: undefined, arr: [undefined, 1], nan: NaN };",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      // The live object must equal its own JSON round-trip (what a reloaded
      // history would contain), so first-run and retry behavior are identical.
      const roundTripped = JSON.parse(JSON.stringify(result)) as PTCExecutionResult;
      expect(result).toEqual(roundTripped);
      expect(result.result).toEqual({ arr: [null, 1], nan: null });
      expect(result.consoleOutput[0]?.args).toEqual([null]);
    });

    it("captures console.log output", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'console.log("hello", 123); return "done"' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toBe("done");
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[0].args).toEqual(["hello", 123]);
    });

    it("records tool execution time", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "return 42" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("tool bridge integration", () => {
    it("calls bridged tools and returns results", async () => {
      const mockExecute = mock((args: unknown) => {
        const { filePath } = args as { filePath: string };
        return {
          success: true as const,
          content: `Content of ${filePath}`,
          file_size: 100,
          modifiedTime: "2025-01-01T00:00:00Z",
          lines_read: 1,
        };
      });

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      for (const ns of ["xum", "mux"] as const) {
        const result = (await tool.execute!(
          { code: `return ${ns}.file_read({ filePath: "test.txt" })` },
          mockToolCallOptions
        )) as PTCExecutionResult;

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({
          content: "Content of test.txt",
          success: true,
        });
      }
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it("records tool calls in result", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: 'mux.file_read({ filePath: "a.txt" }); return "done"' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("file_read");
      expect(result.toolCalls[0].args).toEqual({ filePath: "a.txt" });
      expect(result.toolCalls[0].result).toMatchObject({
        content: "mock file content",
        success: true,
      });
      expect(result.toolCalls[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("validates tool arguments against schema at runtime", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "return mux.file_read({ wrongField: 123 })" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toMatch(/filePath|required|validation/i);
    });

    it("handles tool execution errors gracefully", async () => {
      const mockTools: Record<string, Tool> = {
        failing_tool: createMockTool("failing_tool", z.object({}), () => {
          throw new Error("Tool failed!");
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "return mux.failing_tool({})" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool failed!");
      // Should still record the failed tool call
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].error).toContain("Tool failed!");
    });

    it("returns partial results when execution fails mid-way", async () => {
      let callCount = 0;
      const mockTools: Record<string, Tool> = {
        counter: createMockTool("counter", z.object({}), () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("Second call failed");
          }
          return { count: callCount };
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        {
          code: `
            mux.counter({});
            mux.counter({}); // This one fails
            mux.counter({}); // Never reached
            return "done";
          `,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].result).toEqual({ count: 1 });
      expect(result.toolCalls[1].error).toContain("Second call failed");
    });
  });

  describe("event streaming", () => {
    it("emits events for tool calls", async () => {
      const events: PTCEvent[] = [];
      const onEvent = (event: PTCEvent) => events.push(event);

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(mockTools),
        onEvent
      );

      await tool.execute!(
        { code: 'return mux.file_read({ filePath: "test.txt" })' },
        mockToolCallOptions
      );

      const toolCallEvents = events.filter(
        (e) => e.type === "tool-call-start" || e.type === "tool-call-end"
      );
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].type).toBe("tool-call-start");
      expect(toolCallEvents[1].type).toBe("tool-call-end");
    });

    it("emits events for console output", async () => {
      const events: PTCEvent[] = [];
      const onEvent = (event: PTCEvent) => events.push(event);

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}), onEvent);

      await tool.execute!(
        { code: 'console.log("test"); console.warn("warning"); return 1' },
        mockToolCallOptions
      );

      const consoleEvents = events.filter((e) => e.type === "console");
      expect(consoleEvents).toHaveLength(2);
      expect(consoleEvents[0].level).toBe("log");
      expect(consoleEvents[1].level).toBe("warn");
    });
  });

  describe("abort handling", () => {
    it("aborts execution when signal is triggered", async () => {
      const mockTools: Record<string, Tool> = {
        slow_tool: createMockTool("slow_tool", z.object({}), async () => {
          // Simulate slow operation
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { done: true };
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const abortController = new AbortController();

      // Abort immediately
      abortController.abort();

      const result = (await tool.execute!(
        { code: "return mux.slow_tool({})" },
        {
          toolCallId: "test-1",
          messages: [],
          context: undefined,
          abortSignal: abortController.signal,
        }
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("abort");
    });
  });

  describe("type caching", () => {
    it("returns consistent types for same tool set", async () => {
      clearTypeCaches();

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      const tool1 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const tool2 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc1 = (tool1 as { description?: string }).description ?? "";
      const desc2 = (tool2 as { description?: string }).description ?? "";

      expect(desc1).toBe(desc2);
      expect(desc1).toContain("function file_read");
    });

    it("regenerates types when tool set changes", async () => {
      clearTypeCaches();

      const tools1: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };
      const tools2: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        bash: createMockTool("bash", z.object({ script: z.string() }), () => ({
          output: "ok",
        })),
      };

      const tool1 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools1));
      const tool2 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools2));

      const desc1 = (tool1 as { description?: string }).description ?? "";
      const desc2 = (tool2 as { description?: string }).description ?? "";

      expect(desc1).not.toBe(desc2);
      expect(desc1).not.toContain("function bash");
      expect(desc2).toContain("function bash");
    });

    it("persistent mount shares vars across two separate code_execution calls and a simulated restart", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-code-exec",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      // Call 1 writes vars; call 2 (a separate tool call) reads them.
      const first = (await tool.execute!(
        { code: "vars.total = 40; return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(first.success).toBe(true);
      expect(first.result).toBe(40);

      const second = (await tool.execute!(
        { code: "vars.total += 2; return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(second.success).toBe(true);
      expect(second.result).toBe(42);

      // Simulated restart: fresh host restores the per-call snapshot.
      await host.disposeScope("ws-code-exec");
      const host2 = new SandboxHostService();
      const tool2 = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        (fn) =>
          host2.withPersistentMount(
            {
              lifetime: "persistent",
              runtimeFactory,
              scopeKey: "ws-code-exec",
              sessionDir: tmp.path,
            },
            fn
          )
      );
      const third = (await tool2.execute!(
        { code: "return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(third.success).toBe(true);
      expect(third.result).toBe(42);
      await host2.disposeScope("ws-code-exec");
    });

    it("persists vars mutated before a failed eval so memory and disk agree", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-failed-eval",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      const seed = (await tool.execute!(
        { code: "vars.state = 'initial'; return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(seed.success).toBe(true);

      // Guest mutates vars, THEN throws: the live guest keeps the mutation,
      // so the snapshot must too — a restart must not resurrect 'initial'.
      const failed = (await tool.execute!(
        { code: "vars.state = 'mutated-before-throw'; throw new Error('boom');" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(failed.success).toBe(false);

      // Simulated restart: fresh host restores the latest snapshot.
      await host.disposeScope("ws-failed-eval");
      const host2 = new SandboxHostService();
      const tool2 = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        (fn) =>
          host2.withPersistentMount(
            {
              lifetime: "persistent",
              runtimeFactory,
              scopeKey: "ws-failed-eval",
              sessionDir: tmp.path,
            },
            fn
          )
      );
      const after = (await tool2.execute!(
        { code: "return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(after.success).toBe(true);
      expect(after.result).toBe("mutated-before-throw");
      await host2.disposeScope("ws-failed-eval");
    });

    it("recovers from unsnapshottable vars by rebuilding the mount from the last durable snapshot", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-cyclic-vars",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      const seed = (await tool.execute!(
        { code: "vars.state = 'durable'; return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(seed.success).toBe(true);

      // Guest makes vars cyclic (unsnapshottable) and throws: the snapshot
      // fails, so the live mount must be disposed rather than kept with state
      // that disk can never reflect.
      const poisoned = (await tool.execute!(
        { code: "vars.self = vars; throw new Error('boom');" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(poisoned.success).toBe(false);

      // Next call rebuilds the mount from the last durable snapshot: the
      // cyclic mutation is gone, the seeded value is restored.
      const recovered = (await tool.execute!(
        { code: "return { state: vars.state, self: typeof vars.self };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(recovered.success).toBe(true);
      expect(recovered.result).toEqual({ state: "durable", self: "undefined" });
      await host.disposeScope("ws-cyclic-vars");
    });

    it("clearTypeCaches forces regeneration", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      // First call to populate cache
      await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      // Clear and verify new generation works
      clearTypeCaches();

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const desc = (tool as { description?: string }).description ?? "";
      expect(desc).toContain("function file_read");
    });
  });

  describe("result handle offloading (RLM persistent kernel)", () => {
    // Serializes to well over the 16KB offload threshold.
    const bigPayload = { data: "x".repeat(20_000) };
    const bigSerialized = JSON.stringify(bigPayload);

    const bigFetchTools: Record<string, Tool> = {
      big_fetch: createMockTool("big_fetch", z.object({}), () => bigPayload),
    };

    const persistentRunner = (host: SandboxHostService, scopeKey: string, sessionDir: string) =>
      ((fn) =>
        host.withPersistentMount(
          { lifetime: "persistent", runtimeFactory, scopeKey, sessionDir },
          fn
        )) satisfies MountRunner;

    it("suppresses oversized nested results into compact records: no inline value, no handle machinery", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(bigFetchTools),
        undefined,
        persistentRunner(host, "ws-offload", tmp.path)
      );

      const result = (await tool.execute!(
        { code: "const r = mux.big_fetch({}); return r.data.length;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      // The running guest code received the FULL value (in-kernel data is free).
      expect(result.result).toBe(20_000);

      // The model-visible record is a compact summary — never the value.
      const record = result.toolCalls[0];
      expect(record.result).toBeUndefined();
      expect(record.error).toBeUndefined();
      expect(record.ok).toBe(true);
      expect(record.bytes).toBe(Buffer.byteLength(bigSerialized, "utf8"));
      expect(record.toolName).toBe("big_fetch");

      // Nested records carry no payload, so no result-handle rows are created
      // for them (r4 offload now applies to the top-level return value only).
      const journal = new DurableEventJournal(tmp.path);
      const events = await journal.read();
      expect(events.filter((e) => e.kind === "result-handle")).toHaveLength(0);
      await host.disposeScope("ws-offload");
    });

    it("keeps results on persistence-critical records (file_edit_*/agent_skill_read) in kernel mode", async () => {
      // Post-compaction persistence extractors mine nested file_edit_* diffs
      // (extractEditedFileDiffs) and agent_skill_read snapshots
      // (loadedSkillSnapshots) from history; suppressing these like ordinary
      // kernel records would silently lose that context after compaction.
      using tmp = new DisposableTempDir("code-exec-persist-records");
      const host = new SandboxHostService();
      const tools: Record<string, Tool> = {
        file_edit_insert: createMockTool(
          "file_edit_insert",
          z.object({ path: z.string() }),
          () => ({
            success: true,
            diff: "@@ -0,0 +1 @@\n+hello",
          })
        ),
        agent_skill_read: createMockTool(
          "agent_skill_read",
          z.object({ name: z.string() }),
          () => ({
            success: true,
            skill: { frontmatter: { name: "demo" }, body: "Body" },
          })
        ),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-persist-records", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: 'mux.file_edit_insert({path: "/a.ts"}); mux.agent_skill_read({name: "demo"}); return true;',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const editRecord = result.toolCalls.find((r) => r.toolName === "file_edit_insert");
      expect((editRecord?.result as { diff?: string })?.diff).toContain("+hello");
      const skillRecord = result.toolCalls.find((r) => r.toolName === "agent_skill_read");
      const skill = (skillRecord?.result as { skill?: { body?: string } })?.skill;
      expect(skill?.body).toBe("Body");
      await host.disposeScope("ws-persist-records");
    });

    it("keeps oversized persistence results while carrying media separately", async () => {
      // Creation-time bounding replaces results over the 16KB threshold with
      // a __kernelBounded marker before compaction runs, so the persistence
      // exemption must preserve the diff while media rides only the carrier.
      using tmp = new DisposableTempDir("code-exec-exempt-bounds");
      const host = new SandboxHostService();
      const bigDiff = `@@ -0,0 +1 @@\n+${"x".repeat(20_000)}`;
      const mediaData = "aGVsbG8=";
      const tools: Record<string, Tool> = {
        file_edit_replace_string: createMockTool(
          "file_edit_replace_string",
          z.object({ path: z.string() }),
          () => ({ success: true, diff: bigDiff })
        ),
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          type: "content",
          value: [
            { type: "text", text: "took a screenshot" },
            { type: "media", mediaType: "image/png", data: mediaData },
          ],
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-exempt-bounds", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: 'mux.file_edit_replace_string({path: "/big.ts"}); mux.mcp__shots__take({}); return true;',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const editRecord = result.toolCalls.find((r) => r.toolName === "file_edit_replace_string");
      expect((editRecord?.result as { diff?: string })?.diff).toBe(bigDiff);

      const shotRecord = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      expect(shotRecord?.result).toBeUndefined();
      expect(shotRecord?.ok).toBe(true);
      expect(shotRecord?.bytes).toBeGreaterThan(0);
      // The raw bytes ride the attachments carrier for request-time extraction.
      expect(result.attachments).toEqual([
        { type: "media", mediaType: "image/png", data: mediaData },
      ]);
      await host.disposeScope("ws-exempt-bounds");
    });

    it("bounds oversized diffs at a hunk boundary at capture (parseable prefix + truncation flag)", async () => {
      // generateDiff is unbounded upstream; a >50k diff must be bounded at
      // capture — but a mid-hunk slice is unparseable (parsePatch throws,
      // combineDiffs falls back to only the LAST diff, erasing this edit), so
      // whole hunks are kept and diffTruncated carries the loss signal.
      using tmp = new DisposableTempDir("code-exec-oversized-diff");
      const host = new SandboxHostService();
      const hunk1 = `@@ -1,0 +1,1 @@\n+${"a".repeat(30_000)}\n`;
      const hunk2 = `@@ -5,0 +7,1 @@\n+${"b".repeat(30_000)}\n`;
      const hugeDiff = `${hunk1}${hunk2}`;
      const tools: Record<string, Tool> = {
        file_edit_insert: createMockTool(
          "file_edit_insert",
          z.object({ path: z.string() }),
          () => ({
            success: true,
            diff: hugeDiff,
          })
        ),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-oversized-diff", tmp.path)
      );

      const result = (await tool.execute!(
        { code: 'mux.file_edit_insert({path: "/huge.ts"}); return true;' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "file_edit_insert");
      const retained = record?.result as { diff?: string; diffTruncated?: boolean };
      // The first whole hunk is retained; the second (which would cross the
      // cap) is dropped, and the truncation is flagged for the extractor.
      expect(retained?.diff).toBe(hunk1);
      expect(retained?.diffTruncated).toBe(true);
      await host.disposeScope("ws-oversized-diff");
    });

    it("preserves the edit path on a bounded-args marker", async () => {
      // Inserting >2KiB of content bounds the record's ARGS to a
      // __kernelBounded marker; without the merged-back path, extractors
      // could not attribute the retained diff and would silently drop the
      // successful edit from post-compaction context (round 8, P1).
      using tmp = new DisposableTempDir("code-exec-bounded-edit-args");
      const host = new SandboxHostService();
      const tools: Record<string, Tool> = {
        file_edit_insert: createMockTool(
          "file_edit_insert",
          z.object({ path: z.string(), content: z.string() }),
          () => ({ success: true, diff: "@@ -1,0 +1,1 @@\n+hello\n" })
        ),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-bounded-edit-args", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: 'mux.file_edit_insert({path: "/kept.ts", content: "x".repeat(5000)}); return true;',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "file_edit_insert");
      const args = record?.args as {
        __kernelBounded?: boolean;
        path?: string;
        preview?: string;
      };
      expect(args.__kernelBounded).toBe(true);
      expect(args.path).toBe("/kept.ts");
      // The oversized content itself stays bounded to the marker preview.
      expect(JSON.stringify(args).length).toBeLessThan(4 * 1024);
      expect((record?.result as { diff?: string })?.diff).toContain("+hello");
      await host.disposeScope("ws-bounded-edit-args");
    });

    it("budgets media containers at capture in classic (non-kernel) mode too", async () => {
      // Exclusive PTC makes the bridge the only route to executable MCP
      // tools even without RLM, and records/events persist into session
      // history in every mode while request-time extraction rewrites only
      // the provider copy — so the aggregate media budget must apply to
      // ephemeral registrations as well (round 8). Top-level {type:"content"}
      // carriers are stripped by the bridge before guests or records see them,
      // so the budget's remaining job is media under WRAPPER shapes the
      // attachments carrier does not handle.
      const bigImage = "A".repeat(2 * 1024 * 1024);
      const tools: Record<string, Tool> = {
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [
              { type: "media", mediaType: "image/png", data: bigImage },
              { type: "media", mediaType: "image/png", data: bigImage },
            ],
          },
        })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools));

      const result = (await tool.execute!(
        // The guest still receives the full container: only the RECORD is
        // sanitized.
        { code: "const r = mux.mcp__shots__take({}); return r.shot.value[1].data.length;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      expect(result.result).toBe(bigImage.length);
      const record = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      const value = (
        record?.result as {
          shot?: { value?: Array<{ type?: string; data?: string; text?: string }> };
        }
      )?.shot?.value;
      expect(value?.[0]?.data).toBe(bigImage);
      expect(value?.[1]?.type).toBe("text");
      expect(value?.[1]?.text).toContain("aggregate media budget exceeded");
    });

    it("shares one classic-mode capture budget across calls in an execution", async () => {
      // Classic mode has no kernel caps and no retained-result budget, so a
      // fresh per-call media allowance would let a model-authored loop of
      // bridged media calls persist unbounded multi-megabyte records (r19).
      // One shared per-execution budget bounds the sum: later calls' media
      // degrade to placeholders. Wrapped containers bypass the bridge's
      // carrier strip, so the raw payloads reach capture.
      const image = "A".repeat(1_300_000);
      const tools: Record<string, Tool> = {
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [{ type: "media", mediaType: "image/png", data: image }],
          },
        })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools));

      const result = (await tool.execute!(
        { code: "for (let i = 0; i < 3; i++) { mux.mcp__shots__take({}); } return true;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const records = result.toolCalls.filter((r) => r.toolName === "mcp__shots__take");
      expect(records).toHaveLength(3);
      const partOf = (record: (typeof records)[number]) =>
        (
          record.result as {
            shot?: { value?: Array<{ type?: string; data?: string; text?: string }> };
          }
        )?.shot?.value?.[0];
      // Two ~1.3MB images fit the shared 3MiB budget; the third exceeds it.
      expect(partOf(records[0])?.data).toBe(image);
      expect(partOf(records[1])?.data).toBe(image);
      expect(partOf(records[2])?.type).toBe("text");
      expect(partOf(records[2])?.text).toContain("aggregate media budget exceeded");
    });

    it("sanitizes media containers passed as args to another bridged call in classic mode", async () => {
      // `const img = mux.<mediaTool>({}); mux.<consumer>({payload: img})`
      // copies the container into the consumer record's ARGS and start/end
      // events; without bounding, repeated passes persist unbudgeted base64
      // (r22). Args share the same per-execution capture budget as results.
      // The wrapped container bypasses the bridge's carrier strip, so the
      // guest holds RAW media to copy into the consumer's args.
      const image = "A".repeat(1_300_000);
      const tools: Record<string, Tool> = {
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [{ type: "media", mediaType: "image/png", data: image }],
          },
        })),
        mcp__sink__send: createMockTool("mcp__sink__send", z.object({}).passthrough(), () => ({
          ok: true,
        })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools));

      const result = (await tool.execute!(
        {
          code:
            "const img = mux.mcp__shots__take({}); " +
            "mux.mcp__sink__send({payload: img}); " +
            "mux.mcp__sink__send({payload: img}); return true;",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const sinkRecords = result.toolCalls.filter((r) => r.toolName === "mcp__sink__send");
      expect(sinkRecords).toHaveLength(2);
      const argPart = (record: (typeof sinkRecords)[number]) =>
        (
          record.args as {
            payload?: {
              shot?: { value?: Array<{ type?: string; data?: string; text?: string }> };
            };
          }
        )?.payload?.shot?.value?.[0];
      // Result (1.3MB) + first args copy (1.3MB) fit the shared 3MiB budget;
      // the second args copy exceeds it and degrades to a placeholder.
      expect(argPart(sinkRecords[0])?.data).toBe(image);
      expect(argPart(sinkRecords[1])?.type).toBe("text");
      expect(argPart(sinkRecords[1])?.text).toContain("aggregate media budget exceeded");
    });

    it("charges retained results against one execution-wide budget", async () => {
      // Retention bypasses the per-record 16KiB kernel cap by design, but a
      // loop of retained calls (each up to ~3MiB of media) must not grow
      // toolCalls and streamed history without limit (round 10): once the
      // execution-wide budget is exhausted, further oversized results fall
      // back to normal bounding and compaction drops them with honest sizes.
      using tmp = new DisposableTempDir("code-exec-exec-budget");
      const host = new SandboxHostService();
      const imageData = "A".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES - 1024);
      const bigDiff = `@@ -1,0 +1,1 @@\n+${"d".repeat(30_000)}\n@@ -9,0 +10,1 @@\n+${"e".repeat(30_000)}\n`;
      const tools: Record<string, Tool> = {
        // Wrapped so the raw payload reaches capture instead of the bridge's
        // carrier strip.
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [{ type: "media", mediaType: "image/png", data: imageData }],
          },
        })),
        file_edit_insert: createMockTool(
          "file_edit_insert",
          z.object({ path: z.string() }),
          () => ({
            success: true,
            diff: bigDiff,
          })
        ),
        file_edit_replace_string: createMockTool(
          "file_edit_replace_string",
          z.object({ path: z.string() }),
          () => ({ success: false, diff: bigDiff })
        ),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-exec-budget", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code:
            "for (let i = 0; i < 5; i++) { mux.mcp__shots__take({}); } " +
            'mux.file_edit_insert({path: "/after-budget.ts"}); ' +
            'mux.file_edit_replace_string({path: "/after-budget-failed.ts"}); return true;',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const records = result.toolCalls.filter((r) => r.toolName === "mcp__shots__take");
      expect(records).toHaveLength(5);
      // First four ~3MiB containers fit the 12MiB execution budget and are
      // retained; the fifth exceeds it, gets normally bounded at capture, and
      // compaction drops the non-exempt marker while reporting the true size.
      for (const record of records.slice(0, 4)) {
        const value = (record.result as { shot?: { value?: Array<{ data?: string }> } })?.shot
          ?.value;
        expect(value?.[0]?.data).toBe(imageData);
      }
      const overflow = records[4];
      expect(overflow.result).toBeUndefined();
      expect(overflow.ok).toBe(true);
      expect(overflow.bytes).toBeGreaterThan(3_000_000);

      // Persistence-critical records after overflow: the name-based
      // exemption must not preserve the __kernelBounded marker as a result —
      // compaction emits the normal {ok, bytes} summary so edit extractors
      // keep PATH attribution (round 12), and a FAILED edit's success bit
      // survives through the marker instead of misreporting ok:true.
      const editOk = result.toolCalls.find((r) => r.toolName === "file_edit_insert");
      expect(editOk?.result).toBeUndefined();
      expect(editOk?.ok).toBe(true);
      expect((editOk?.args as { path?: string })?.path).toBe("/after-budget.ts");
      const editFailed = result.toolCalls.find((r) => r.toolName === "file_edit_replace_string");
      expect(editFailed?.result).toBeUndefined();
      expect(editFailed?.ok).toBe(false);
      await host.disposeScope("ws-exec-budget");
    });

    it("sanitizes returned and console-logged media containers in classic mode", async () => {
      // Classic executions have no offload stage: `return xum.<mediaTool>()`
      // assigns the guest value directly to the outer PTCExecutionResult
      // result, which persists into partial.json/chat.jsonl — the
      // record-level sanitizer alone leaves that copy unbudgeted (round 9).
      // Console args are sanitized at CAPTURE (streamed events included);
      // over-budget console records are separately dropped whole by the
      // console capture budget, so the observable case here is unsupported
      // media riding under that budget.
      const bigImage = "A".repeat(2 * 1024 * 1024);
      const audioData = "d2F2".repeat(50);
      const tools: Record<string, Tool> = {
        // Wrapped: raw media reaches the guest/records. The rec tool below
        // stays a top-level carrier; the bridge stubs its audio data, and
        // capture still bounds the stubbed unsupported part to a placeholder.
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [
              { type: "media", mediaType: "image/png", data: bigImage },
              { type: "media", mediaType: "image/png", data: bigImage },
            ],
          },
        })),
        mcp__rec__capture: createMockTool("mcp__rec__capture", z.object({}), () => ({
          type: "content",
          value: [{ type: "media", mediaType: "audio/wav", data: audioData }],
        })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools));

      const result = (await tool.execute!(
        {
          // Wrapped, not returned at the root: the sanitizer must walk the
          // whole value graph (round 10), a root-only check would miss this.
          code: "const r = mux.mcp__shots__take({}); console.log(mux.mcp__rec__capture({})); return { wrapped: r };",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const outer = (
        result.result as {
          wrapped?: {
            shot?: { value?: Array<{ type?: string; data?: string; text?: string }> };
          };
        }
      )?.wrapped?.shot?.value;
      // The outer return draws from the SAME execution allowance as the
      // nested record (r29): the record capture already retained the first
      // ~2MiB image out of the 3MiB budget, so the returned copy of the same
      // container cannot retain it AGAIN — both copies exceeding the shared
      // remainder collapse to placeholders instead of doubling the bound.
      expect(outer?.[0]?.type).toBe("text");
      expect(outer?.[0]?.text).toContain("aggregate media budget exceeded");
      expect(outer?.[1]?.type).toBe("text");
      expect(outer?.[1]?.text).toContain("aggregate media budget exceeded");
      // The payload itself is not lost: the nested record retains it.
      const shotsRecord = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      const recordValue = (shotsRecord?.result as { shot?: { value?: Array<{ data?: string }> } })
        ?.shot?.value;
      expect(recordValue?.[0]?.data).toBe(bigImage);

      const consoleArg = (
        result.consoleOutput[0]?.args[0] as {
          value?: Array<{ type?: string; text?: string }>;
        }
      )?.value;
      expect(consoleArg?.[0]?.type).toBe("text");
      expect(consoleArg?.[0]?.text).toContain("not supported as a model attachment");
      expect(JSON.stringify(result.consoleOutput)).not.toContain(audioData);
    });

    it("charges retained media against an aggregate budget", async () => {
      // MCP applies only a per-part guard: many individually-allowed images
      // must not persist unbounded aggregate base64 into records/events.
      using tmp = new DisposableTempDir("code-exec-media-budget");
      const host = new SandboxHostService();
      const bigImage = "A".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES - 100);
      const secondImage = "B".repeat(500);
      const tools: Record<string, Tool> = {
        // Wrapped so the raw payload reaches capture instead of the bridge's
        // carrier strip.
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          shot: {
            type: "content",
            value: [
              { type: "media", mediaType: "image/png", data: bigImage },
              { type: "media", mediaType: "image/png", data: secondImage },
            ],
          },
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-media-budget", tmp.path)
      );

      const result = (await tool.execute!(
        { code: "mux.mcp__shots__take({}); return true;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      const value = (
        record?.result as {
          shot?: { value?: Array<{ type?: string; data?: string; text?: string }> };
        }
      )?.shot?.value;
      expect(value?.[0]?.data).toBe(bigImage);
      expect(value?.[1]?.type).toBe("text");
      expect(value?.[1]?.text).toContain("aggregate media budget exceeded");
      await host.disposeScope("ws-media-budget");
    });

    it("keeps media exempt when a server result spoofs the __kernelBounded field", async () => {
      // The overflow marker's boolean is unnamespaced: a bridged server
      // result can carry its own __kernelBounded field alongside real media,
      // and marker-first compaction would drop the retained payload before
      // request-time extraction could attach it (r27). Genuine markers never
      // contain extractable media, so the media exemption wins.
      using tmp = new DisposableTempDir("code-exec-marker-spoof");
      const host = new SandboxHostService();
      const image = "A".repeat(500);
      const tools: Record<string, Tool> = {
        // Wrapped: a top-level carrier would be rebuilt as a bare {type,value}
        // by the bridge's strip, silently dropping the spoofed field; the
        // wrapper keeps the spoof adjacent to RAW retained media (the r27
        // marker-vs-media compaction race this test exists for).
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          __kernelBounded: true,
          shot: {
            type: "content",
            value: [{ type: "media", mediaType: "image/png", data: image }],
          },
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-marker-spoof", tmp.path)
      );

      const result = (await tool.execute!(
        { code: "mux.mcp__shots__take({}); return true;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      const value = (record?.result as { shot?: { value?: Array<{ data?: string }> } })?.shot
        ?.value;
      expect(value?.[0]?.data).toBe(image);
      await host.disposeScope("ws-marker-spoof");
    });

    it("bounds unsupported parts of mixed media containers at capture", async () => {
      // A mixed top-level container is stripped by the bridge: the image's
      // bytes ride the attachments carrier while the unsupported audio payload
      // (up to 8 MiB per part) is discarded; neither may persist raw into the
      // record/chat.jsonl, and capture still bounds the stubbed audio part to
      // a placeholder.
      using tmp = new DisposableTempDir("code-exec-mixed-media");
      const host = new SandboxHostService();
      const audioData = "d2F2".repeat(50);
      const tools: Record<string, Tool> = {
        mcp__shots__take: createMockTool("mcp__shots__take", z.object({}), () => ({
          type: "content",
          value: [
            { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
            { type: "media", mediaType: "audio/wav", data: audioData },
          ],
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-mixed-media", tmp.path)
      );

      const result = (await tool.execute!(
        { code: "mux.mcp__shots__take({}); return true;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "mcp__shots__take");
      expect(record?.result).toBeUndefined();
      expect(record?.ok).toBe(true);
      expect(record?.bytes).toBeGreaterThan(0);
      expect(JSON.stringify(record)).not.toContain(audioData);
      expect(result.attachments).toEqual([
        { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
      ]);
      await host.disposeScope("ws-mixed-media");
    });

    it("does not exempt unsupported media (audio) from kernel record suppression", async () => {
      // Request-time extraction only consumes supported attachment types
      // (images/PDF); exempting audio/blob media would leave raw base64 in
      // persisted records and provider requests with no attachment payoff.
      using tmp = new DisposableTempDir("code-exec-audio-bounds");
      const host = new SandboxHostService();
      const tools: Record<string, Tool> = {
        mcp__rec__capture: createMockTool("mcp__rec__capture", z.object({}), () => ({
          type: "content",
          value: [{ type: "media", mediaType: "audio/wav", data: "d2F2" }],
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        undefined,
        persistentRunner(host, "ws-audio-bounds", tmp.path)
      );

      const result = (await tool.execute!(
        { code: "mux.mcp__rec__capture({}); return true;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.toolCalls.find((r) => r.toolName === "mcp__rec__capture");
      expect(record?.result).toBeUndefined();
      expect(record?.ok).toBe(true);
      await host.disposeScope("ws-audio-bounds");
    });

    it("marks compact records not-ok when the tool resolved with success:false", async () => {
      // file_read-style tools resolve normally with {success:false} for
      // missing/oversized/directory paths — no thrown error. The compact
      // record drops `result`, and post-compaction read tracking trusts its
      // ok bit: ok:true here would advertise a never-read path in the
      // already-read-files attachment (r22).
      using tmp = new DisposableTempDir("code-exec-result-failure");
      const host = new SandboxHostService();
      const failingReadTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ path: z.string() }), () => ({
          success: false,
          error: "File not found",
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(failingReadTools),
        undefined,
        persistentRunner(host, "ws-result-failure", tmp.path)
      );

      const result = (await tool.execute!(
        { code: 'const r = mux.file_read({path: "/missing.txt"}); return r.success;' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      // Guest code saw the structured failure result.
      expect(result.result).toBe(false);
      // The compact record folds the result's success bit into ok.
      const record = result.toolCalls[0];
      expect(record.toolName).toBe("file_read");
      expect(record.error).toBeUndefined();
      expect(record.ok).toBe(false);
      await host.disposeScope("ws-result-failure");
    });

    it("keeps failure status when the failing result is oversized and capture-bounded", async () => {
      // A failing result over the kernel result cap is replaced with a
      // __kernelBounded marker at creation; the success bit must survive onto
      // EVERY marker (r29 — not just the retained-budget branch), or
      // compaction would report the failed call ok:true and read tracking
      // would advertise a never-read path.
      using tmp = new DisposableTempDir("code-exec-oversized-failure");
      const host = new SandboxHostService();
      const failingReadTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ path: z.string() }), () => ({
          success: false,
          error: `Backend failure: ${"x".repeat(64 * 1024)}`,
        })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(failingReadTools),
        undefined,
        persistentRunner(host, "ws-oversized-failure", tmp.path)
      );

      const result = (await tool.execute!(
        { code: 'const r = mux.file_read({path: "/missing.txt"}); return r.success;' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      expect(result.result).toBe(false);
      const record = result.toolCalls[0];
      expect(record.toolName).toBe("file_read");
      expect(record.error).toBeUndefined();
      expect(record.ok).toBe(false);
      await host.disposeScope("ws-oversized-failure");
    });

    it("bounds nested-call args/results at creation: emitted events never carry full payloads", async () => {
      // Post-eval compaction cannot protect the stream path: nested events
      // land in partial/final session history via the stream manager, so a
      // guest looping `xum.sink({content: vars.large})` would grow history
      // without bound unless capture is bounded at CREATION time.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const sinkTools: Record<string, Tool> = {
        big_fetch: createMockTool("big_fetch", z.object({}), () => bigPayload),
        sink: createMockTool("sink", z.object({ content: z.string() }), () => "ok"),
      };
      const emitted: Array<{ toolName?: string; args?: unknown; result?: unknown }> = [];
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(sinkTools),
        (event) => {
          emitted.push(event as { toolName?: string; args?: unknown; result?: unknown });
        },
        persistentRunner(host, "ws-event-bound", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: "const r = mux.big_fetch({}); for (let i = 0; i < 3; i++) { mux.sink({content: r.data}); } return true;",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      // Every emitted event for the large-arg sink calls is bounded: no
      // event carries the 20KB payload.
      const sinkEvents = emitted.filter((e) => e.toolName === "sink");
      expect(sinkEvents.length).toBeGreaterThan(0);
      for (const event of sinkEvents) {
        const serialized = JSON.stringify(event.args) ?? "";
        expect(serialized.length).toBeLessThan(4 * 1024);
        const marker = event.args as { __kernelBounded?: boolean; bytes?: number };
        expect(marker.__kernelBounded).toBe(true);
        expect(marker.bytes).toBeGreaterThan(10_000);
      }
      // big_fetch's oversized RESULT is bounded in its event too.
      const fetchEnd = emitted.find(
        (e) => e.toolName === "big_fetch" && (e as { type?: string }).type === "tool-call-end"
      );
      expect(fetchEnd).toBeDefined();
      const fetchResult = fetchEnd!.result as { __kernelBounded?: boolean; bytes?: number };
      expect(fetchResult.__kernelBounded).toBe(true);
      await host.disposeScope("ws-event-bound");
    });

    it("threads the nested record callId into bridged execute options", async () => {
      // The UI keys nested cards and live events (workflow-run-attached,
      // task-created, live bash output) by the PTC record callId; execute()
      // must observe the SAME id or those events target an id no rendered
      // card carries.
      using tmp = new DisposableTempDir("code-exec-callid");
      const host = new SandboxHostService();
      const executed: Array<{ toolCallId: string; tag: string }> = [];
      const probeTool: Tool = {
        description: "Probe tool",
        inputSchema: z.object({ tag: z.string() }),
        execute: (args, options) => {
          executed.push({ toolCallId: options.toolCallId, tag: (args as { tag: string }).tag });
          return Promise.resolve({ success: true });
        },
      };
      const emitted: Array<{
        type?: string;
        callId?: string;
        toolName?: string;
        args?: { tag?: string };
      }> = [];
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ probe: probeTool }),
        (event) => emitted.push(event as (typeof emitted)[number]),
        persistentRunner(host, "ws-callid", tmp.path)
      );

      const result = (await tool.execute!(
        { code: 'mux.probe({tag: "a"}); mux.probe({tag: "b"}); return true;' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const starts = emitted.filter((e) => e.type === "tool-call-start" && e.toolName === "probe");
      expect(starts).toHaveLength(2);
      expect(executed).toHaveLength(2);
      for (const call of executed) {
        const start = starts.find((e) => e.args?.tag === call.tag);
        expect(start?.callId).toBe(call.toolCallId);
      }
      expect(executed[0].toolCallId).not.toBe(executed[1].toolCallId);
      await host.disposeScope("ws-callid");
    });

    it("retains workflow identity on kernel-bounded workflow_run args and results", async () => {
      // Oversized workflow launches and results collapse to markers, but the
      // transcript card needs script_path (display) and runId/status (durable
      // run refetch) to render the live workflow instead of raw JSON.
      using tmp = new DisposableTempDir("code-exec-wf-bound");
      const host = new SandboxHostService();
      const workflowTools: Record<string, Tool> = {
        workflow_run: createMockTool(
          "workflow_run",
          z.object({ script_path: z.string(), args: z.unknown() }),
          () => ({
            status: "completed",
            runId: "wfr_bounded",
            result: { reportMarkdown: "r".repeat(64 * 1024) },
          })
        ),
      };
      const emitted: Array<{ type?: string; toolName?: string; args?: unknown; result?: unknown }> =
        [];
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(workflowTools),
        (event) => emitted.push(event as (typeof emitted)[number]),
        persistentRunner(host, "ws-wf-bound", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: 'const r = mux.workflow_run({script_path: "skill://demo/workflow.js", args: {problem: "p".repeat(4096)}}); return r.runId;',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      // The guest still sees the full result.
      expect(result.result).toBe("wfr_bounded");

      const end = emitted.find((e) => e.type === "tool-call-end" && e.toolName === "workflow_run");
      expect(end).toBeDefined();
      const argsMarker = end!.args as { __kernelBounded?: boolean; script_path?: string };
      expect(argsMarker.__kernelBounded).toBe(true);
      expect(argsMarker.script_path).toBe("skill://demo/workflow.js");
      const resultMarker = end!.result as {
        __kernelBounded?: boolean;
        runId?: string;
        status?: string;
      };
      expect(resultMarker.__kernelBounded).toBe(true);
      expect(resultMarker.runId).toBe("wfr_bounded");
      expect(resultMarker.status).toBe("completed");
      await host.disposeScope("ws-wf-bound");
    });

    it("bounds oversized nested-call args in compact records (no echo of kernel data)", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const sinkTools: Record<string, Tool> = {
        big_fetch: createMockTool("big_fetch", z.object({}), () => bigPayload),
        sink: createMockTool("sink", z.object({ content: z.string() }), () => "ok"),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(sinkTools),
        undefined,
        persistentRunner(host, "ws-args-bound", tmp.path)
      );

      // Kernel data passed as a nested tool's args must not be echoed back
      // through the compact record — that would reopen the context leak that
      // result suppression closed.
      const result = (await tool.execute!(
        {
          code: "const r = mux.big_fetch({}); mux.sink({content: r.data}); return r.data.length;",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const sinkRecord = result.toolCalls.find((r) => r.toolName === "sink");
      expect(sinkRecord).toBeDefined();
      // Bounded at creation time (runtime kernel record bounds); the compact
      // pass passes the marker through without double-wrapping.
      const args = sinkRecord!.args as {
        __kernelBounded?: boolean;
        preview?: string;
        bytes?: number;
      };
      expect(args.__kernelBounded).toBe(true);
      expect(typeof args.preview).toBe("string");
      expect(args.preview!.length).toBeLessThan(3 * 1024);
      expect(args.bytes).toBeGreaterThan(10_000);
      // Small args pass through untouched.
      const fetchRecord = result.toolCalls.find((r) => r.toolName === "big_fetch");
      expect(fetchRecord!.args).toEqual({});
      await host.disposeScope("ws-args-bound");
    });

    it("bounds oversized nested-call ERRORS in records and events (no guest-path echo)", async () => {
      // Host error messages can embed guest data verbatim — ENAMETOOLONG
      // echoes a multi-megabyte path — and record errors stay model-visible
      // through compaction, so they must be bounded at creation and again
      // before return like args/results.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const hugePathErrorTools: Record<string, Tool> = {
        touchy: createMockTool("touchy", z.object({ path: z.string() }), (input) => {
          throw new Error(
            `ENAMETOOLONG: name too long, open '${(input as { path: string }).path}'`
          );
        }),
      };
      const emitted: Array<{ toolName?: string; error?: string }> = [];
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(hugePathErrorTools),
        (event) => {
          emitted.push(event as { toolName?: string; error?: string });
        },
        persistentRunner(host, "ws-error-bound", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: "try { mux.touchy({path: 'x'.repeat(2_000_000)}); } catch (e) {} return 'done';",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      // The compact record's error is bounded, reporting the true size.
      const record = result.toolCalls.find((r) => r.toolName === "touchy");
      expect(record).toBeDefined();
      expect(record!.error).toBeDefined();
      expect(record!.error!.length).toBeLessThan(4 * 1024);
      expect(record!.error).toContain("truncated");
      // Emitted events (streamed into session history) are bounded too.
      const errorEvents = emitted.filter((e) => e.toolName === "touchy" && e.error !== undefined);
      expect(errorEvents.length).toBeGreaterThan(0);
      for (const event of errorEvents) {
        expect(event.error!.length).toBeLessThan(4 * 1024);
      }
      await host.disposeScope("ws-error-bound");
    });

    it("bounds oversized errors by UTF-8 bytes, not UTF-16 code units", async () => {
      // The cap is a byte budget: multibyte text sliced by code units would
      // retain ~3x the nominal cap (3 UTF-8 bytes per CJK char) and bypass
      // the model-context bound the cap documents.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const multibyteErrorTools: Record<string, Tool> = {
        touchy: createMockTool("touchy", z.object({ path: z.string() }), (input) => {
          throw new Error(
            `ENAMETOOLONG: name too long, open '${(input as { path: string }).path}'`
          );
        }),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(multibyteErrorTools),
        () => undefined,
        persistentRunner(host, "ws-error-bound-mb", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: "try { mux.touchy({path: 'あ'.repeat(1_000_000)}); } catch (e) {} return 'done';",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.toolCalls.find((r) => r.toolName === "touchy");
      expect(record?.error).toBeDefined();
      expect(record!.error).toContain("truncated");
      // Byte length (not just code-unit length) stays within the cap plus the
      // truncation marker's small overhead.
      expect(Buffer.byteLength(record!.error!, "utf8")).toBeLessThan(3 * 1024);
      await host.disposeScope("ws-error-bound-mb");
    });

    it("bounds capture-time events by UTF-8 bytes, not UTF-16 code units", async () => {
      // Emitted events are bounded at CAPTURE time inside the runtime and
      // stream straight into session history — post-eval compaction never
      // re-bounds them — so the runtime's own truncation must slice by UTF-8
      // bytes: code-unit slicing retains ~3x the byte cap for CJK text.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const multibyteTools: Record<string, Tool> = {
        sink: createMockTool("sink", z.object({ content: z.string() }), () => "ok"),
        touchy: createMockTool("touchy", z.object({ path: z.string() }), (input) => {
          throw new Error(
            `ENAMETOOLONG: name too long, open '${(input as { path: string }).path}'`
          );
        }),
      };
      const emitted: Array<{ toolName?: string; args?: unknown; error?: string }> = [];
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(multibyteTools),
        (event) => {
          emitted.push(event as { toolName?: string; args?: unknown; error?: string });
        },
        persistentRunner(host, "ws-event-bound-mb", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code:
            "mux.sink({content: 'あ'.repeat(100_000)}); " +
            "try { mux.touchy({path: 'あ'.repeat(100_000)}); } catch (e) {} return 'done';",
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      // Oversized multibyte args: the capture-time preview stays within the
      // byte cap (plus small marker overhead), not just within the same
      // number of code units.
      const sinkEvents = emitted.filter((e) => e.toolName === "sink" && e.args !== undefined);
      expect(sinkEvents.length).toBeGreaterThan(0);
      for (const event of sinkEvents) {
        const marker = event.args as { __kernelBounded?: boolean; preview?: string };
        expect(marker.__kernelBounded).toBe(true);
        expect(Buffer.byteLength(marker.preview!, "utf8")).toBeLessThan(3 * 1024);
      }
      // Oversized multibyte errors: same byte-safe bound at capture time.
      const errorEvents = emitted.filter((e) => e.toolName === "touchy" && e.error !== undefined);
      expect(errorEvents.length).toBeGreaterThan(0);
      for (const event of errorEvents) {
        expect(Buffer.byteLength(event.error!, "utf8")).toBeLessThan(3 * 1024);
      }
      await host.disposeScope("ws-event-bound-mb");
    });

    it("truncates over-cap return values to a bounded preview (no handle, no inline value)", async () => {
      // A value over the retention cap can be neither a handle (retention
      // would protect it while it blows the snapshot budget) nor inline (it
      // would defeat context isolation and can exceed the provider context).
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-overcap", tmp.path)
      );

      const overCap = RESULT_HANDLE_VARS_CAP_BYTES + 1024;
      const result = (await tool.execute!(
        { code: `return "x".repeat(${overCap});` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.result as {
        truncated?: boolean;
        handle?: string;
        preview?: string;
        size?: number;
      };
      expect(record.truncated).toBe(true);
      expect(record.handle).toBeUndefined();
      expect(record.size).toBeGreaterThan(overCap);
      // Bounded: the preview must be a tiny fraction of the value.
      expect(record.preview!.length).toBeLessThan(4096);
      await host.disposeScope("ws-overcap");
    });

    it("truncates handle-tier returns when the guest made vars unusable (store failure)", async () => {
      // r14: a failed store must never keep the FULL value inline — a
      // prompt-influenced program could push megabytes into durable
      // history/provider context; the record must be the same bounded
      // truncated shape as the over-cap tier. Since r28 normalizes null and
      // primitive vars back to a plain object, the store-failure vector is a
      // write-swallowing Proxy: the assignment "succeeds" but stores nothing,
      // and the in-eval read-back check fails the store cleanly.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-store-fail", tmp.path)
      );

      const size = 100_000; // well over the threshold, far under the cap
      const result = (await tool.execute!(
        {
          code: `vars = new Proxy({}, { set: function() { return true; } }); return "z".repeat(${size});`,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.result as { truncated?: boolean; handle?: string; preview?: string };
      expect(record.truncated).toBe(true);
      expect(record.handle).toBeUndefined();
      // Bounded: nothing model-visible carries the full payload.
      expect(JSON.stringify(result).length).toBeLessThan(16 * 1024);
      await host.disposeScope("ws-store-fail");
    });

    it("recovers a guest-primitive vars: the advertised handle actually resolves", async () => {
      // Codex r28: `vars = 1` (unlike `vars = null`) did not throw on
      // property writes in non-strict guest code — the handle assignment
      // silently no-oped, storeResultHandle still returned the key, and the
      // model was told to slice vars.__h1 which never existed. The store now
      // normalizes the (already unusable) primitive namespace back to a
      // plain object, so the handle must be real and usable in a follow-up.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-primitive-vars", tmp.path)
      );

      const result = (await tool.execute!(
        { code: `vars = 1; return "z".repeat(100_000);` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.result as { truncated?: boolean; handle?: string };
      expect(record.truncated).toBeUndefined();
      expect(record.handle).toBe("vars.__h1");

      const followUp = (await tool.execute!(
        { code: "return vars.__h1.length;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(followUp.success).toBe(true);
      expect(followUp.result).toBe(100_000);
      await host.disposeScope("ws-primitive-vars");
    });

    it("truncates unserializable returns (BigInt bypass of the offload tiers)", async () => {
      // r22: an unserializable return made offloadValue's JSON.stringify
      // throw, and the catch left the value inline — bypassing the r14
      // offload/retention tiers and then breaking HistoryService's plain
      // stringify at persistence. On this runtime's dump implementation a
      // bare BigInt is the vector that reaches the catch (objects containing
      // BigInts collapse to "[object Object]" and arrays to a join string in
      // dump's own JSON fallback — both flow through the normal tiers).
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-bigint-return", tmp.path)
      );

      const result = (await tool.execute!(
        { code: `return 10n ** 20n;` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.result as { truncated?: boolean; handle?: string; note?: string };
      expect(record.truncated).toBe(true);
      expect(record.handle).toBeUndefined();
      expect(record.note).toContain("not JSON-serializable");
      // The whole model-visible/durable result is bounded AND persistable
      // (a plain stringify must not throw — that is what broke persistence).
      expect(JSON.stringify(result).length).toBeLessThan(16 * 1024);
      await host.disposeScope("ws-bigint-return");
    });

    it("rewrites an advertised handle to a truncated record when the snapshot budget rejects it", async () => {
      // Pre-existing unmanaged guest vars can push the FULL snapshot over
      // budget even when the new handle itself is under the retention cap;
      // retention cannot evict unmanaged vars, the persist fails, and the
      // mount is disposed — the promised handle would not survive to the next
      // call, so the model must never see it.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-budget-rewrite", tmp.path)
      );

      // Call 1: fill unmanaged vars close to the snapshot budget (durable).
      const bigBytes = VARS_SNAPSHOT_MAX_BYTES - 128 * 1024;
      const first = (await tool.execute!(
        { code: `vars.big = "x".repeat(${bigBytes}); return true;` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(first.success).toBe(true);

      // Call 2: a handle-eligible return (>16KB, under the retention cap)
      // pushes the snapshot over budget.
      const second = (await tool.execute!(
        { code: `return "y".repeat(${256 * 1024});` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(second.success).toBe(true);

      const record = second.result as { truncated?: boolean; handle?: string };
      expect(record.truncated).toBe(true);
      expect(record.handle).toBeUndefined();
      // The model is told why via the kernel console notice.
      const notice = second.consoleOutput.find(
        (entry) => typeof entry.args[0] === "string" && entry.args[0].startsWith("[kernel]")
      );
      expect(notice).toBeDefined();
      // r28: the durable handle row/blob is published only after the snapshot
      // commits — a failed persist must leave NO result-handle event, or
      // provenance (and metrics handle-adoption counts) would claim a handle
      // the model never received.
      const journal = new DurableEventJournal(tmp.path);
      const events = await journal.read();
      expect(events.filter((e) => e.kind === "result-handle")).toHaveLength(0);
      await host.disposeScope("ws-budget-rewrite");
    });

    it("rewrites an advertised handle when vars become unsnapshottable (non-budget persist failure)", async () => {
      // A cycle created in the same call makes snapshotVars throw a plain
      // error (not the budget error); the mount is disposed and the handle
      // does not survive, so the rewrite must apply to EVERY persist failure.
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-cycle-rewrite", tmp.path)
      );

      const result = (await tool.execute!(
        {
          code: `vars.cycle = {}; vars.cycle.self = vars.cycle; return "y".repeat(${64 * 1024});`,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);

      const record = result.result as { truncated?: boolean; handle?: string };
      expect(record.truncated).toBe(true);
      expect(record.handle).toBeUndefined();
      // r28: no published handle event either (see the budget-rewrite test).
      const journal = new DurableEventJournal(tmp.path);
      const events = await journal.read();
      expect(events.filter((e) => e.kind === "result-handle")).toHaveLength(0);
      await host.disposeScope("ws-cycle-rewrite");
    });

    it("handle vars survive a simulated restart: a later eval after remount can slice vars.__hN", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(bigFetchTools),
        undefined,
        persistentRunner(host, "ws-offload-restart", tmp.path)
      );
      // Handle vars come from RETURN-VALUE offload (nested records are
      // compact summaries in kernel mode and create no handles).
      const first = (await tool.execute!(
        { code: "return mux.big_fetch({});" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(first.success).toBe(true);

      // Simulated restart: fresh host restores the vars snapshot.
      await host.disposeScope("ws-offload-restart");
      const host2 = new SandboxHostService();
      const tool2 = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(bigFetchTools),
        undefined,
        persistentRunner(host2, "ws-offload-restart", tmp.path)
      );
      const after = (await tool2.execute!(
        { code: "return vars.__h1.data.length;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(after.success).toBe(true);
      expect(after.result).toBe(20_000);
      await host2.disposeScope("ws-offload-restart");
    });

    it("suppresses even sub-threshold nested results (kernel records are never inline, any size)", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const smallTools: Record<string, Tool> = {
        small_fetch: createMockTool("small_fetch", z.object({}), () => ({ data: "small" })),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(smallTools),
        undefined,
        persistentRunner(host, "ws-small", tmp.path)
      );
      const result = (await tool.execute!(
        { code: "const r = mux.small_fetch({}); return r;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      // The sub-threshold RETURN value stays inline (the model's channel)...
      expect(result.result).toEqual({ data: "small" });
      // ...but the nested record is a compact summary even below the r4
      // offload threshold.
      const record = result.toolCalls[0];
      expect(record.result).toBeUndefined();
      expect(record.ok).toBe(true);
      expect(record.bytes).toBe(Buffer.byteLength(JSON.stringify({ data: "small" }), "utf8"));

      const journal = new DurableEventJournal(tmp.path);
      const events = await journal.read();
      expect(events.filter((e) => e.kind === "result-handle")).toHaveLength(0);
      await host.disposeScope("ws-small");
    });

    it("keeps the failing nested call's error visible in its compact record", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const failTools: Record<string, Tool> = {
        boom: createMockTool("boom", z.object({}), () => {
          throw new Error("backend exploded");
        }),
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(failTools),
        undefined,
        persistentRunner(host, "ws-fail", tmp.path)
      );
      const result = (await tool.execute!(
        { code: "mux.boom({}); return 'unreachable';" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      // Execution failed; the error message and the failing call's compact
      // record must stay model-visible so the model can retry intelligently.
      expect(result.success).toBe(false);
      expect(result.error).toContain("backend exploded");
      const record = result.toolCalls[0];
      expect(record.result).toBeUndefined();
      expect(record.ok).toBe(false);
      expect(record.bytes).toBe(0);
      expect(record.error).toContain("backend exploded");
      await host.disposeScope("ws-fail");
    });

    it("caps kernel console output with a truncation notice; RLM-off console is untouched", async () => {
      using tmp = new DisposableTempDir("code-exec-console");
      const host = new SandboxHostService();
      // Two oversized logs: the first is truncated at the cap boundary, the
      // second is dropped entirely — both accounted for in the notice.
      const code = "console.log('a'.repeat(20000)); console.log('b'.repeat(5000)); return 'done';";
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-console", tmp.path)
      );
      const result = (await tool.execute!({ code }, mockToolCallOptions)) as PTCExecutionResult;
      expect(result.success).toBe(true);
      expect(result.consoleOutput).toHaveLength(2);
      const [head, notice] = result.consoleOutput;
      expect(String(head.args[0])).toContain("…[truncated]");
      expect(String(head.args[0]).length).toBeLessThan(17_000);
      expect(notice.level).toBe("warn");
      expect(String(notice.args[0])).toContain("console output truncated");
      expect(String(notice.args[0])).toContain("2 record(s)");
      await host.disposeScope("ws-console");

      // RLM off (no mount): byte-identical console behavior — nothing capped.
      const ephemeralTool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));
      const ephemeralResult = (await ephemeralTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(ephemeralResult.consoleOutput).toHaveLength(2);
      expect(ephemeralResult.consoleOutput[0].args[0]).toBe("a".repeat(20000));
      expect(ephemeralResult.consoleOutput[1].args[0]).toBe("b".repeat(5000));
    });

    it("offloads oversized return values with a follow-up hint", async () => {
      using tmp = new DisposableTempDir("code-exec-offload");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        persistentRunner(host, "ws-return", tmp.path)
      );
      const result = (await tool.execute!(
        { code: "return { data: 'y'.repeat(20000) };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const record = result.result as {
        handle: string;
        preview: string;
        size: number;
        hint: string;
      };
      expect(record.handle).toBe("vars.__h1");
      expect(record.size).toBeGreaterThan(20_000);
      expect(record.hint).toContain("vars.__h1");

      const followUp = (await tool.execute!(
        { code: "return vars.__h1.data.length;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(followUp.result).toBe(20_000);

      const journal = new DurableEventJournal(tmp.path);
      const events = await journal.read();
      const handleEvents = events.filter((e) => e.kind === "result-handle");
      expect(handleEvents).toHaveLength(1);
      await host.disposeScope("ws-return");
    });

    it("does not offload without a persistent mount (RLM off): full results stay inline", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(bigFetchTools));
      const result = (await tool.execute!(
        { code: "const r = mux.big_fetch({}); return r;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      // Both the return value and the nested record carry the full value,
      // byte-identical to pre-RLM behavior.
      expect(result.result).toEqual(bigPayload);
      expect(result.toolCalls[0].result).toEqual(bigPayload);
    });
  });

  describe("RLM kernel: fire-and-forget spawn + host events", () => {
    const taskSchema = z.object({
      prompt: z.string(),
      title: z.string(),
      run_in_background: z.boolean().nullish(),
    });

    const kernelRunner = (host: SandboxHostService, scopeKey: string, sessionDir: string) =>
      ((fn) =>
        host.withPersistentMount(
          { lifetime: "persistent", runtimeFactory, scopeKey, sessionDir },
          fn
        )) satisfies MountRunner;

    it("mux.task_spawn returns in-eval while the child is still pending; a later eval drains the terminal event", async () => {
      using tmp = new DisposableTempDir("code-exec-kernel");
      const host = new SandboxHostService();
      let receivedArgs: unknown;
      const taskTool = createMockTool("task", taskSchema, (args) => {
        receivedArgs = args;
        // Background admission result: the child keeps running after this.
        return { status: "queued", taskId: "child-1" };
      });

      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ task: taskTool }),
        undefined,
        kernelRunner(host, "ws-kernel", tmp.path)
      );

      // Spawn + drain in ONE eval: the admission handle comes back while the
      // child has not completed, so no terminal event exists yet.
      const spawn = (await tool.execute!(
        {
          code: 'const h = mux.task_spawn({ prompt: "p", title: "T" }); return { h, events: mux.events() };',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(spawn.success).toBe(true);
      expect(spawn.result).toEqual({ h: { taskId: "child-1", status: "spawned" }, events: [] });
      // Guest cannot opt out of background admission.
      expect((receivedArgs as { run_in_background?: boolean }).run_in_background).toBe(true);

      // Child reaches its terminal report (taskService finalize path).
      await host.postTaskTerminalEvent("ws-kernel", {
        taskId: "child-1",
        status: "completed",
        reportMarkdown: "done",
      });

      const drain = (await tool.execute!(
        { code: "return mux.events();" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(drain.success).toBe(true);
      expect(drain.result).toEqual([
        { type: "task-terminal", taskId: "child-1", status: "completed", reportMarkdown: "done" },
      ]);

      // Queue drained: subsequent evals see nothing.
      const empty = (await tool.execute!(
        { code: "return mux.events();" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(empty.result).toEqual([]);
      await host.disposeScope("ws-kernel");
    });

    it("RLM off (no mount): task_spawn and events are absent from namespace, types, and description", async () => {
      const taskTool = createMockTool("task", taskSchema, () => ({
        status: "queued",
        taskId: "x",
      }));
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ task: taskTool })
      );
      expect(tool.description).not.toContain("task_spawn");

      const probe = (await tool.execute!(
        { code: "return { spawn: typeof mux.task_spawn, events: typeof mux.events };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(probe.success).toBe(true);
      expect(probe.result).toEqual({ spawn: "undefined", events: "undefined" });
    });

    it("kernel mode advertises task_spawn/events in the type defs embedded in the description", async () => {
      using tmp = new DisposableTempDir("code-exec-kernel");
      const host = new SandboxHostService();
      const taskTool = createMockTool("task", taskSchema, () => ({
        status: "queued",
        taskId: "x",
      }));
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ task: taskTool }),
        undefined,
        kernelRunner(host, "ws-kernel-desc", tmp.path)
      );
      expect(tool.description).toContain("function task_spawn(args: TaskArgs): TaskSpawnResult;");
      expect(tool.description).toContain("function events(): HostEvent[];");
      await host.disposeScope("ws-kernel-desc");
    });
  });

  describe("RLM kernel: mux.load bulk ingestion", () => {
    const fileReadSchema = z.object({
      path: z.string(),
      offset: z.number().nullish(),
      limit: z.number().nullish(),
    });
    const fileReadTools = (): Record<string, Tool> => ({
      file_read: createMockTool("file_read", fileReadSchema, () => mockResults.file_read),
    });

    const kernelRunner = (host: SandboxHostService, scopeKey: string, sessionDir: string) =>
      ((fn) =>
        host.withPersistentMount(
          { lifetime: "persistent", runtimeFactory, scopeKey, sessionDir },
          fn
        )) satisfies MountRunner;

    it("loads a >100KB file into vars with only {key, bytes, lines, preview} visible", async () => {
      using tmp = new DisposableTempDir("code-exec-load");
      // ~130KB, 2000 lines, with a needle that must never be model-visible.
      const line = "x".repeat(64);
      const contentLines = Array.from({ length: 2000 }, (_, i) =>
        i === 1500 ? `NEEDLE_${i}_SECRET` : line
      );
      const content = contentLines.join("\n");
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(100 * 1024);
      await fs.writeFile(nodePath.join(tmp.path, "orders.jsonl"), content, "utf8");

      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load", tmp.path),
        {
          loadFile: createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) }),
        }
      );

      // Same-eval use: load then immediately compute over vars[key].
      const result = (await tool.execute!(
        {
          code: 'const s = mux.load({ path: "orders.jsonl", key: "orders" }); return { s, len: vars.orders.length };',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const returned = result.result as {
        s: { key: string; bytes: number; lines: number; preview: string };
        len: number;
      };
      expect(returned.len).toBe(content.length);
      expect(returned.s.key).toBe("orders");
      expect(returned.s.bytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(returned.s.lines).toBe(2000);
      expect(returned.s.preview.length).toBeLessThanOrEqual(512);
      expect(content.startsWith(returned.s.preview)).toBe(true);

      // The load record keeps its bounded summary (exempt from compaction).
      const loadRecord = result.toolCalls[0];
      expect(loadRecord.toolName).toBe("load");
      expect(loadRecord.result).toEqual(returned.s);

      // Nothing model-visible contains the file body.
      expect(JSON.stringify(result)).not.toContain("NEEDLE_1500_SECRET");

      // Later evals (and the vars snapshot) retain the loaded content.
      const followUp = (await tool.execute!(
        { code: "return vars.orders.split('\\n')[1500];" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(followUp.result).toBe("NEEDLE_1500_SECRET");
      await host.disposeScope("ws-load");
    });

    it("fails the load honestly when a guest Proxy vars swallows writes", async () => {
      // Codex r29: the r28 handle-store verify did not cover mux.load's
      // setVarsProperty path — a Proxy with lying set/defineProperty traps
      // "accepted" the write while storing nothing, so the model saw a
      // successful {key, bytes, lines, preview} record for a key that never
      // existed (and the snapshot durably committed the miss).
      using tmp = new DisposableTempDir("code-exec-load");
      await fs.writeFile(nodePath.join(tmp.path, "x.txt"), "hello world", "utf8");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load-proxy", tmp.path),
        {
          loadFile: createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) }),
        }
      );

      const result = (await tool.execute!(
        {
          code: `
            vars = new Proxy({}, {
              set: function () { return true; },
              defineProperty: function () { return true; },
            });
            let error = "";
            try { mux.load({ path: "x.txt", key: "data" }); } catch (e) { error = String(e); }
            return { error, missing: typeof vars.data };
          `,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const returned = result.result as { error: string; missing: string };
      expect(returned.error).toContain("did not store");
      expect(returned.missing).toBe("undefined");
      // The compact record reports the failure — never a fake success summary.
      const record = result.toolCalls.find((r) => r.toolName === "load");
      expect(record?.error).toBeDefined();
      expect(record?.result).toBeUndefined();

      // A genuine load (vars restored) still succeeds.
      const recovered = (await tool.execute!(
        {
          code: 'vars = {}; const s = mux.load({ path: "x.txt", key: "data" }); return { s, len: vars.data.length };',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(recovered.success).toBe(true);
      expect((recovered.result as { len: number }).len).toBe("hello world".length);
      await host.disposeScope("ws-load-proxy");
    });

    it("rewrites load records as failures when the post-load snapshot exceeds the budget", async () => {
      // r14: a successful mux.load can push vars past the snapshot budget
      // (new load keys are protected from retention eviction). persistVars
      // throws, the mount is disposed, and the NEXT call restores a snapshot
      // WITHOUT the loaded key — so the load record must not keep telling
      // the model the key exists.
      using tmp = new DisposableTempDir("code-exec-load");
      // Loads cap at MAX_FILE_SIZE (1MB), so cross the 8MB snapshot budget
      // with pre-existing unmanaged vars plus one near-cap load.
      const bigBytes = VARS_SNAPSHOT_MAX_BYTES - 512 * 1024;
      const fileBytes = 900 * 1024;
      await fs.writeFile(nodePath.join(tmp.path, "big.jsonl"), "y".repeat(fileBytes), "utf8");

      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load-budget", tmp.path),
        {
          loadFile: createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) }),
        }
      );

      // Call 1: fill unmanaged vars close to the budget (durable snapshot).
      const first = (await tool.execute!(
        { code: `vars.big = "x".repeat(${bigBytes}); return true;` },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(first.success).toBe(true);

      // Call 2: the load succeeds in-kernel but the post-call snapshot
      // cannot fit — the loaded key will NOT survive to the next call.
      const second = (await tool.execute!(
        { code: 'const s = mux.load({ path: "big.jsonl", key: "orders" }); return s.bytes;' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(second.success).toBe(true);
      const loadRecord = second.toolCalls.find((record) => record.toolName === "load");
      expect(loadRecord).toBeDefined();
      // The record must reflect reality: no surviving key may be promised.
      expect(loadRecord!.error).toBeDefined();
      expect(loadRecord!.result).toBeUndefined();
      // The model is told why via the kernel console notice.
      const notice = second.consoleOutput.find(
        (entry) => typeof entry.args[0] === "string" && entry.args[0].startsWith("[kernel]")
      );
      expect(notice).toBeDefined();

      // The next call's restored snapshot indeed lacks the key (and keeps
      // the last durable state).
      const third = (await tool.execute!(
        { code: "return { orders: typeof vars.orders, big: vars.big.length };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(third.result).toEqual({ orders: "undefined", big: bigBytes });
      await host.disposeScope("ws-load-budget");
    });

    it("fails the call as a retryable conflict when a foreign instance persists mid-eval (r68)", async () => {
      // The lease-time lineage check (r67) cannot see a foreign persist that
      // lands WHILE the eval runs; the persist precondition refuses it, but
      // reporting the eval as successful would silently drop this call's
      // vars mutations and leave stale computed results model-visible.
      using tmp = new DisposableTempDir("code-exec-conflict");
      const hostA = new SandboxHostService();
      const hostB = new SandboxHostService();
      const scopeKey = "ws-snap-conflict";
      // Bridged tool that lands a foreign backend's persist inside our eval
      // window — deterministic stand-in for a concurrent instance.
      const sabotage = createMockTool("sabotage", z.object({}), async () => {
        const mountB = await hostB.acquireMount({
          lifetime: "persistent",
          runtimeFactory,
          scopeKey,
          sessionDir: tmp.path,
        });
        await mountB.runtime.eval('vars.foreign = "won"; return true;');
        await mountB.persistVars();
        return { ok: true };
      });
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ sabotage }),
        undefined,
        kernelRunner(hostA, scopeKey, tmp.path)
      );

      const conflicted = (await tool.execute!(
        { code: 'mux.sabotage({}); vars.mine = "lost"; return "computed-from-stale";' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(conflicted.success).toBe(false);
      expect(conflicted.error).toContain("persisted by another instance");
      // The sabotage call COMPLETED inside the eval: its external effects are
      // not rolled back, so the error must instruct reconciliation, not a
      // blanket replay (r69).
      expect(conflicted.error).toContain("NOT rolled back");
      expect(conflicted.error).toContain("sabotage");
      expect(conflicted.error).not.toContain("Re-run this call.");
      expect(conflicted.result).toBeUndefined();

      // The next call rebuilds from the FOREIGN snapshot: the conflicted
      // call's mutation is gone and the foreign write is visible.
      const next = (await tool.execute!(
        { code: "return { mine: typeof vars.mine, foreign: vars.foreign };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(next.success).toBe(true);
      expect(next.result).toEqual({ mine: "undefined", foreign: "won" });
      await hostB.disposeScope(scopeKey);
      await hostA.disposeScope(scopeKey);
    });

    it("treats REJECTED nested calls as potentially side-effecting after a conflict (r70)", async () => {
      using tmp = new DisposableTempDir("code-exec-conflict");
      const hostA = new SandboxHostService();
      const hostB = new SandboxHostService();
      const scopeKey = "ws-snap-conflict-rejected";
      // The bridged call mutates externally (here: the foreign persist) and
      // THEN rejects — e.g. a post-tool hook throwing after the main
      // operation completed. Its record carries an error, but that is not
      // proof of no side effect, so the conflict advice must still warn.
      const sabotage = createMockTool("sabotage", z.object({}), async () => {
        const mountB = await hostB.acquireMount({
          lifetime: "persistent",
          runtimeFactory,
          scopeKey,
          sessionDir: tmp.path,
        });
        await mountB.runtime.eval('vars.foreign = "won"; return true;');
        await mountB.persistVars();
        throw new Error("sabotage failed after the foreign persist");
      });
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({ sabotage }),
        undefined,
        kernelRunner(hostA, scopeKey, tmp.path)
      );

      const conflicted = (await tool.execute!(
        {
          code: 'try { mux.sabotage({}); } catch (e) {} vars.mine = "lost"; return "stale";',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(conflicted.success).toBe(false);
      expect(conflicted.error).toContain("persisted by another instance");
      expect(conflicted.error).toContain("NOT rolled back");
      expect(conflicted.error).toContain("sabotage");
      expect(conflicted.error).not.toContain("Re-run this call.");
      await hostB.disposeScope(scopeKey);
      await hostA.disposeScope(scopeKey);
    });

    it("advises a plain re-run when the conflicted eval invoked only loads (r70)", async () => {
      using tmp = new DisposableTempDir("code-exec-conflict");
      const hostA = new SandboxHostService();
      const hostB = new SandboxHostService();
      const scopeKey = "ws-snap-conflict-rerun";
      // The foreign persist lands inside the LOADER (a read — loads carry no
      // external side effects, and their vars entries did not survive the
      // conflict anyway), so a plain re-run is safe advice.
      const foreignPersistingLoader = async () => {
        const mountB = await hostB.acquireMount({
          lifetime: "persistent",
          runtimeFactory,
          scopeKey,
          sessionDir: tmp.path,
        });
        await mountB.runtime.eval('vars.foreign = "won"; return true;');
        await mountB.persistVars();
        return { content: "hello", bytes: 5, lines: 1, preview: "hello" };
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(hostA, scopeKey, tmp.path),
        { loadFile: foreignPersistingLoader }
      );

      const conflicted = (await tool.execute!(
        { code: 'mux.load({ path: "x.txt", key: "data" }); return "stale";' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(conflicted.success).toBe(false);
      expect(conflicted.error).toContain("persisted by another instance");
      expect(conflicted.error).toContain("Re-run this call.");
      expect(conflicted.error).not.toContain("NOT rolled back");
      // The load record carries the conflict-specific re-issue advice.
      const loadRecord = conflicted.toolCalls.find((record) => record.toolName === "load");
      expect(loadRecord?.error).toContain("changed this workspace's kernel state");
      await hostB.disposeScope(scopeKey);
      await hostA.disposeScope(scopeKey);
    });

    it("rejects reserved __ keys and surfaces loader errors as catchable guest errors", async () => {
      using tmp = new DisposableTempDir("code-exec-load");
      const host = new SandboxHostService();
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load-err", tmp.path),
        {
          loadFile: createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) }),
        }
      );
      const result = (await tool.execute!(
        {
          code: `
            const errors = [];
            try { mux.load({ path: "x.txt", key: "__h1" }); } catch (e) { errors.push(String(e)); }
            try { mux.load({ path: "missing.txt", key: "data" }); } catch (e) { errors.push(String(e)); }
            return errors;
          `,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      const errors = result.result as string[];
      expect(errors[0]).toContain("reserved");
      expect(errors[1].length).toBeGreaterThan(0);
      await host.disposeScope("ws-load-err");
    });

    it("honors grants: file_read denied => mux.load denied", async () => {
      using tmp = new DisposableTempDir("code-exec-load");
      const host = new SandboxHostService();
      const grants = {
        version: 1 as const,
        bridgeTools: { allow: [] as string[] },
        vars: true,
        hostEvents: true,
      };
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools(), grants),
        undefined,
        kernelRunner(host, "ws-load-denied", tmp.path),
        {
          loadFile: createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) }),
        }
      );
      const result = (await tool.execute!(
        {
          code: 'try { mux.load({ path: "x", key: "k" }); } catch (e) { return String(e); } return "no error";',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      expect(result.result).toContain("Capability denied");
      await host.disposeScope("ws-load-denied");
    });

    it("ephemeral mode (RLM off): mux.load absent from namespace, types, and description", async () => {
      const baseline = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools())
      );
      // Even with a loader configured, no persistent mount => no load.
      const noMountTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        undefined,
        { loadFile: () => Promise.resolve({ content: "", bytes: 0, lines: 0, preview: "" }) }
      );
      expect(noMountTool.description).not.toContain("function load(");
      expect(noMountTool.description).not.toContain("Bulk file ingestion");
      const probe = (await noMountTool.execute!(
        { code: "return typeof mux.load;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(probe.success).toBe(true);
      expect(probe.result).toBe("undefined");
      // Baseline instance without a loader matches byte-for-byte.
      expect(noMountTool.description).toBe(baseline.description);
    });

    it("kernel mode advertises mux.load in type defs only when a loader exists and file_read is bridged", async () => {
      using tmp = new DisposableTempDir("code-exec-load");
      const host = new SandboxHostService();
      const loader = createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) });
      const withLoader = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load-types", tmp.path),
        { loadFile: loader }
      );
      expect(withLoader.description).toContain(
        "function load(args: { path: string; key: string }): LoadResult;"
      );
      expect(withLoader.description).toContain("Bulk file ingestion");

      const withoutLoader = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(fileReadTools()),
        undefined,
        kernelRunner(host, "ws-load-types", tmp.path)
      );
      expect(withoutLoader.description).not.toContain("function load(");

      // file_read not bridged => load absent even with a loader.
      const withoutFileRead = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        kernelRunner(host, "ws-load-types", tmp.path),
        { loadFile: loader }
      );
      expect(withoutFileRead.description).not.toContain("function load(");
      await host.disposeScope("ws-load-types");
    });
  });
});

describe("nested attachment delivery", () => {
  const runtimeFactory = new QuickJSRuntimeFactory();
  const mediaPart = {
    type: "media" as const,
    data: "QkFTRTY0REFUQQ==",
    mediaType: "image/png",
    filename: "board.png",
  };

  function attachFileTool(): Tool {
    return createMockTool("attach_file", z.object({ path: z.string() }), () => ({
      type: "content",
      value: [{ type: "text", text: "[Attachment prepared: board.png]" }, mediaPart],
    }));
  }

  it("re-attaches media stripped from nested tool results onto the execution result", async () => {
    const tool = await createCodeExecutionTool(
      runtimeFactory,
      new ToolBridge({ attach_file: attachFileTool() })
    );

    const result = (await tool.execute!(
      { code: 'return xum.attach_file({ path: "/board.png" });', timeout_secs: null },
      mockToolCallOptions
    )) as PTCExecutionResult;

    expect(result.success).toBe(true);
    // Original media rides the top-level result for the request-path lift
    expect(result.attachments).toEqual([mediaPart]);
    const sandboxVisible = JSON.stringify({ result: result.result, toolCalls: result.toolCalls });
    expect(sandboxVisible).not.toContain(mediaPart.data);
    const extracted = extractAttachmentsFromToolOutput(result);
    expect(extracted?.attachments).toEqual([
      { data: mediaPart.data, mediaType: mediaPart.mediaType, filename: mediaPart.filename },
    ]);

    const returned = result.result as { value: Array<{ type: string; text?: string }> };
    expect(returned.value[1]).toEqual({ type: "text", text: MEDIA_DATA_STUB });
  });

  it("re-attaches display-only files stripped from nested tool results", async () => {
    const displayPart = {
      type: "display_file" as const,
      data: "RElTUExBWQ==",
      mediaType: "text/markdown",
      filename: "notes.md",
      providerOptions: { mux: { displayOnly: true as const, size: 7 } },
    };
    const tool = await createCodeExecutionTool(
      runtimeFactory,
      new ToolBridge({
        attach_file: createMockTool("attach_file", z.object({ path: z.string() }), () => ({
          type: "content",
          value: [displayPart],
        })),
      })
    );

    const result = (await tool.execute!(
      { code: 'return xum.attach_file({ path: "/notes.md" });', timeout_secs: null },
      mockToolCallOptions
    )) as PTCExecutionResult;

    expect(result.success).toBe(true);
    // Display bytes ride the carrier for UI rendering; sandbox-visible values
    // only carry the stubbed shape so host-side records stay bounded.
    expect(result.attachments).toEqual([displayPart]);
    const sandboxVisible = JSON.stringify({ result: result.result, toolCalls: result.toolCalls });
    expect(sandboxVisible).not.toContain(displayPart.data);
    const returned = result.result as { value: Array<{ type: string; data?: string }> };
    expect(returned.value[0].type).toBe("display_file");
    expect(returned.value[0].data).toBe(DISPLAY_DATA_STUB);
  });

  it("omits attachments when no nested tool produced media", async () => {
    const tool = await createCodeExecutionTool(
      runtimeFactory,
      new ToolBridge({
        bash: createMockTool("bash", z.object({ script: z.string() }), () => ({
          success: true,
          output: "ok",
        })),
      })
    );

    const result = (await tool.execute!(
      { code: 'return xum.bash({ script: "true" });', timeout_secs: null },
      mockToolCallOptions
    )) as PTCExecutionResult;

    expect(result.success).toBe(true);
    expect(result.attachments).toBeUndefined();
  });
});
