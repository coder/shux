/**
 * Tests for ToolBridge
 */

import { describe, it, expect, mock } from "bun:test";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import { ToolBridge, MAX_PENDING_ATTACHMENT_BYTES, type KernelBridgeOptions } from "./toolBridge";
import {
  DISPLAY_DATA_STUB,
  MEDIA_BUDGET_EXCEEDED_STUB,
  MEDIA_DATA_STUB,
  mediaUnsupportedStub,
} from "@/common/utils/attachments/toolAttachmentParts";
import { jsonSchema, type Tool } from "ai";
import type { IJSRuntime, RuntimeLimits } from "./runtime";
import type { PTCEvent, PTCExecutionResult } from "./types";
import { z } from "zod";

// Helper to create a mock runtime for testing
function createMockRuntime(overrides: Partial<IJSRuntime> = {}): IJSRuntime {
  const defaultResult: PTCExecutionResult = {
    success: true,
    result: undefined,
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 0,
  };

  return {
    eval: mock(() => Promise.resolve(defaultResult)),
    registerFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerObject: mock(
      (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
    ),
    registerPromiseFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerSyncFunction: mock((_name: string, _fn: () => unknown) => undefined),
    setVarsProperty: mock((_key: string, _value: string) => undefined),
    setKernelRecordBounds: mock(() => undefined),
    setCaptureResultSanitizer: mock(() => undefined),
    setPendingJobGate: mock((_gate: (run: () => void) => void) => undefined),
    setLimits: mock((_limits: RuntimeLimits) => undefined),
    onEvent: mock((_handler: (event: PTCEvent) => void) => undefined),
    abort: mock(() => undefined),
    getAbortSignal: mock(() => undefined),
    takeActiveHostCallId: mock(() => undefined),
    dispose: mock(() => undefined),
    [Symbol.dispose]: mock(() => undefined),
    ...overrides,
  };
}

// Create a mock tool for testing - executeFn can be sync, will be wrapped
function createMockTool(
  name: string,
  schema: z.ZodType,
  executeFn?: (args: unknown) => unknown
): Tool {
  const tool: Tool = {
    description: `Mock ${name} tool`,
    inputSchema: schema,
    ...(executeFn ? { execute: (args) => Promise.resolve(executeFn(args)) } : {}),
  };
  return tool;
}

describe("ToolBridge", () => {
  describe("constructor", () => {
    it("filters out excluded tools", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        code_execution: createMockTool("code_execution", z.object({}), () => ({})),
        ask_user_question: createMockTool("ask_user_question", z.object({}), () => ({})),
        propose_plan: createMockTool("propose_plan", z.object({}), () => ({})),
        todo_write: createMockTool("todo_write", z.object({}), () => ({})),
        todo_read: createMockTool("todo_read", z.object({}), () => ({})),
        status_set: createMockTool("status_set", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("code_execution");
      expect(names).not.toContain("ask_user_question");
      expect(names).not.toContain("propose_plan");
      expect(names).not.toContain("todo_write");
      expect(names).not.toContain("todo_read");
      expect(names).not.toContain("status_set");
    });

    it("filters out tools without execute function", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        web_search: createMockTool("web_search", z.object({})), // No execute
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("web_search");
    });
  });

  describe("getBridgeableToolNames", () => {
    it("returns list of bridgeable tool names", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        bash: createMockTool("bash", z.object({}), () => ({})),
        web_fetch: createMockTool("web_fetch", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toHaveLength(3);
      expect(names).toContain("file_read");
      expect(names).toContain("bash");
      expect(names).toContain("web_fetch");
    });
  });

  describe("register", () => {
    it("registers the same tools object under xum and mux", () => {
      const mockRegisterObject = mock(
        (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      bridge.register(mockRuntime);

      expect(mockRegisterObject).toHaveBeenCalledTimes(2);
      const calls = mockRegisterObject.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >;
      expect(calls.map(([name]) => name)).toEqual(["xum", "mux"]);
      const [, xumObj] = calls[0];
      const [, muxObj] = calls[1];
      expect(muxObj).toBe(xumObj);
      expect(typeof xumObj.file_read).toBe("function");
    });

    it("enforces capability grants: denied tools are excluded, stubbed, and never leak", async () => {
      const executed = mock(() => ({ result: "ok" }));
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), executed),
        bash: createMockTool("bash", z.object({}), executed),
      };

      const bridge = new ToolBridge(tools, {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      });

      // Denied tool is not advertised as bridgeable...
      expect(bridge.getBridgeableToolNames()).toEqual(["file_read"]);
      // ...and must not leak into the model-visible non-bridgeable set either.
      expect(Object.keys(bridge.getNonBridgeableTools())).toEqual([]);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      // Granted tool executes.
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      await fileRead({});
      expect(executed).toHaveBeenCalledTimes(1);

      // Denied tool is stubbed with a clear capability error, not a crash.
      const bash = registeredMux.bash as (...args: unknown[]) => Promise<unknown>;
      try {
        await bash({});
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Capability denied: xum.bash is not granted");
      }
      expect(executed).toHaveBeenCalledTimes(1); // bash never ran
    });

    it("validates arguments before executing tool", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      // Create a simple mock runtime that captures registered functions
      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      // Call with invalid args - should throw
      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ wrongField: "test" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Invalid arguments for file_read");
      }

      // Call with valid args - should succeed
      await fileRead({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("passes args through for JSON-Schema (MCP-style) tools", async () => {
      // MCP tools carry the AI SDK's jsonSchema() wrapper instead of a Zod
      // schema. Regression: validateArgs called schema.safeParse on it and
      // every kernel-bridged MCP call died with a TypeError.
      const mockExecute = mock((args: unknown) => ({ echoed: args }));
      const tools: Record<string, Tool> = {
        mcp_search: {
          description: "MCP-style tool",
          inputSchema: jsonSchema<{ query?: string }>({
            type: "object",
            properties: { query: { type: "string" } },
          }),
          execute: (args) => Promise.resolve(mockExecute(args)),
        },
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      const search = registeredMux.mcp_search as (...args: unknown[]) => Promise<unknown>;
      const result = await search({ query: "eng" });

      // Args flow through untouched — the MCP server is the validator of record.
      expect(mockExecute).toHaveBeenCalledWith({ query: "eng" });
      expect(result).toEqual({ echoed: { query: "eng" } });
    });

    it("normalizes a zero-argument call to empty args", async () => {
      // Guests may call mux.tool() with no arguments. Providers always send an
      // args object and downstream consumers (MCP servers, Zod object schemas)
      // assume one — undefined must become {} so the call behaves like the
      // provider path instead of dying with an opaque TypeError downstream.
      const mcpExecute = mock((args: unknown) => ({ echoed: args }));
      const zodExecute = mock(() => ({ ok: true }));
      const tools: Record<string, Tool> = {
        mcp_list: {
          description: "MCP-style tool with only optional params",
          inputSchema: jsonSchema<{ limit?: number }>({
            type: "object",
            properties: { limit: { type: "number" } },
          }),
          execute: (args) => Promise.resolve(mcpExecute(args)),
        },
        file_read: createMockTool("file_read", z.object({}), zodExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      const mcpList = registeredMux.mcp_list as (...args: unknown[]) => Promise<unknown>;
      await mcpList();
      expect(mcpExecute).toHaveBeenCalledWith({});

      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      await fileRead();
      expect(zodExecute).toHaveBeenCalledTimes(1);
    });

    it("honors a jsonSchema wrapper's custom validator (reject + normalize)", async () => {
      const mockExecute = mock((args: unknown) => ({ echoed: args }));
      const tools: Record<string, Tool> = {
        mcp_guarded: {
          description: "JSON-Schema tool with a wrapper validator",
          inputSchema: jsonSchema<{ query: string }>(
            { type: "object", properties: { query: { type: "string" } } },
            {
              // Async on purpose: covers the awaited PromiseLike path. Rejects
              // invalid input and normalizes valid input, like direct AI SDK
              // calls that honor Schema.validate.
              validate: (value) => {
                const query = (value as { query?: unknown }).query;
                return Promise.resolve(
                  typeof query === "string"
                    ? { success: true as const, value: { query: query.trim() } }
                    : { success: false as const, error: new Error("query must be a string") }
                );
              },
            }
          ),
          execute: (args) => Promise.resolve(mockExecute(args)),
        },
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      const guarded = registeredMux.mcp_guarded as (...args: unknown[]) => Promise<unknown>;

      // Rejection surfaces as a readable bridge error and never reaches execute.
      try {
        await guarded({ query: 42 });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Invalid arguments for mcp_guarded");
        expect(String(e)).toContain("query must be a string");
      }
      expect(mockExecute).not.toHaveBeenCalled();

      // Valid input reaches execute with the validator's normalized value.
      const result = await guarded({ query: "  eng  " });
      expect(mockExecute).toHaveBeenCalledWith({ query: "eng" });
      expect(result).toEqual({ echoed: { query: "eng" } });
    });

    it("does not execute after an abort that lands during async validation", async () => {
      const controller = new AbortController();
      const mockExecute = mock((_args: unknown) => ({ ok: true }));
      const tools: Record<string, Tool> = {
        mcp_slow: {
          description: "JSON-Schema tool whose validator races an abort",
          inputSchema: jsonSchema<{ q?: string }>(
            { type: "object", properties: { q: { type: "string" } } },
            {
              validate: (value) => {
                // Abort lands while validation is outstanding; validation
                // itself still succeeds.
                controller.abort();
                return Promise.resolve({ success: true as const, value: value as { q?: string } });
              },
            }
          ),
          execute: (args) => Promise.resolve(mockExecute(args)),
        },
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(
        createMockRuntime({
          registerObject: mockRegisterObject,
          getAbortSignal: mock(() => controller.signal),
        })
      );

      const slow = registeredMux.mcp_slow as (...args: unknown[]) => Promise<unknown>;
      try {
        await slow({ q: "x" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Execution aborted");
      }
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("rejects instead of hanging when an aborted wrapper validator never settles", async () => {
      const controller = new AbortController();
      const mockExecute = mock((_args: unknown) => ({ ok: true }));
      const tools: Record<string, Tool> = {
        mcp_hang: {
          description: "JSON-Schema tool whose validator never settles",
          inputSchema: jsonSchema<{ q?: string }>(
            { type: "object", properties: { q: { type: "string" } } },
            {
              // Hangs forever; only the abort race can settle the call.
              validate: () => new Promise<never>(() => undefined),
            }
          ),
          execute: (args) => Promise.resolve(mockExecute(args)),
        },
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(
        createMockRuntime({
          registerObject: mockRegisterObject,
          getAbortSignal: mock(() => controller.signal),
        })
      );

      const hang = registeredMux.mcp_hang as (...args: unknown[]) => Promise<unknown>;
      const pending = hang({ q: "x" });
      // Flush pending microtasks so the call is suspended on the validator,
      // then abort mid-validation (exercises the race's listener path rather
      // than the already-aborted pre-check).
      await new Promise((r) => setImmediate(r));
      controller.abort();
      try {
        await pending;
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Execution aborted");
      }
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("serializes non-JSON values", async () => {
      // Tool that returns a non-plain object (with circular reference)
      const circularObj: Record<string, unknown> = { a: 1 };
      circularObj.self = circularObj;

      const mockExecute = mock(() => circularObj);

      const tools: Record<string, Tool> = {
        circular: createMockTool("circular", z.object({}), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      const result = await registeredMux.circular({});
      expect(result).toEqual({ error: "Result not JSON-serializable" });
    });

    it("uses runtime abort signal for tool cancellation", async () => {
      const mockExecute = mock((_args: unknown) => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      // Provide an abort signal via getAbortSignal
      const abortController = new AbortController();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      await registeredMux.file_read({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("throws if runtime abort signal is already aborted", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );

      // Pre-abort the signal
      const abortController = new AbortController();
      abortController.abort();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ filePath: "test.txt" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Execution aborted");
      }
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("RLM kernel namespace (task_spawn + events)", () => {
    const taskSchema = z.object({
      prompt: z.string(),
      title: z.string(),
      run_in_background: z.boolean().nullish(),
    });

    interface Captured {
      mux: Record<string, (...args: unknown[]) => Promise<unknown>>;
      sync: Record<string, (...args: unknown[]) => unknown>;
    }

    function registerCapturing(
      bridge: ToolBridge,
      kernel?: KernelBridgeOptions,
      runtimeOverrides: Partial<IJSRuntime> = {}
    ) {
      const captured: Captured = { mux: {}, sync: {} };
      const mockRuntime = createMockRuntime({
        registerObject: (
          name: string,
          obj: Record<string, (...args: unknown[]) => Promise<unknown>>,
          syncMethods?: Record<string, (...args: unknown[]) => unknown>
        ) => {
          if (name === "mux") {
            captured.mux = obj;
            captured.sync = syncMethods ?? {};
          }
        },
        ...runtimeOverrides,
      });
      bridge.register(mockRuntime, kernel);
      return captured;
    }

    it("without kernel options, task_spawn and events are absent from the namespace", () => {
      const bridge = new ToolBridge({
        task: createMockTool("task", taskSchema, () => ({ taskId: "t1", status: "queued" })),
      });
      const captured = registerCapturing(bridge);
      expect(captured.mux.task_spawn).toBeUndefined();
      expect(captured.sync.events).toBeUndefined();
    });

    it("task_spawn forces run_in_background and returns the admission handle without waiting", async () => {
      let receivedArgs: unknown;
      const taskTool = createMockTool("task", taskSchema, (args) => {
        receivedArgs = args;
        // Background admission result: returned immediately after create.
        return { status: "queued", taskId: "child-1" };
      });

      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      const handle = await taskSpawn({
        prompt: "do it",
        title: "Worker",
        run_in_background: false, // guest cannot opt out of background admission
      });
      expect(handle).toEqual({ taskId: "child-1", status: "spawned" });
      expect((receivedArgs as { run_in_background?: boolean }).run_in_background).toBe(true);
    });

    it("task_spawn maps grouped admissions to taskIds", async () => {
      const taskTool = createMockTool("task", taskSchema, () => ({
        status: "queued",
        taskIds: ["c1", "c2"],
      }));
      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      expect(await taskSpawn({ prompt: "p", title: "T" })).toEqual({
        taskIds: ["c1", "c2"],
        status: "spawned",
      });
    });

    it("concurrent task_spawn calls receive distinct toolCallIds", async () => {
      // The task tool derives its best-of group ID from toolCallId, so two
      // grouped spawns launched in the same millisecond (Promise.all) must
      // not share an ID — colliding IDs merge independent launches into one
      // cohort and mix completion/winner selection across prompts.
      const seenToolCallIds: string[] = [];
      const taskTool: Tool = {
        description: "Mock task tool",
        inputSchema: taskSchema,
        execute: (_args, options) => {
          seenToolCallIds.push(options.toolCallId);
          return Promise.resolve({ status: "queued", taskId: `child-${seenToolCallIds.length}` });
        },
      };
      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      // 20 concurrent launches: with millisecond-timestamp IDs these land in
      // the same ms and collide; collision-free IDs must all be unique.
      await Promise.all(
        Array.from({ length: 20 }, (_v, i) => taskSpawn({ prompt: `p${i}`, title: "T" }))
      );
      expect(seenToolCallIds).toHaveLength(20);
      expect(new Set(seenToolCallIds).size).toBe(20);
    });

    it("task_spawn is denied by the same grant as task", async () => {
      const executed = mock(() => ({ status: "queued", taskId: "never" }));
      const bridge = new ToolBridge(
        { task: createMockTool("task", taskSchema, executed) },
        { version: 1, bridgeTools: { allow: [] }, vars: true, hostEvents: true }
      );
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      try {
        await taskSpawn({ prompt: "p", title: "T" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Capability denied: mux.task_spawn is not granted");
      }
      expect(executed).not.toHaveBeenCalled();
    });

    it("events drains the kernel queue; denied without the hostEvents grant", () => {
      const queue: unknown[] = [{ type: "task-terminal", taskId: "c1" }];
      const bridge = new ToolBridge({
        task: createMockTool("task", taskSchema, () => ({ taskId: "t", status: "queued" })),
      });
      const captured = registerCapturing(bridge, {
        drainHostEvents: () => queue.splice(0, queue.length),
      });
      expect(captured.sync.events()).toEqual([{ type: "task-terminal", taskId: "c1" }]);
      expect(captured.sync.events()).toEqual([]);

      const denied = new ToolBridge(
        { task: createMockTool("task", taskSchema, () => ({ taskId: "t", status: "queued" })) },
        { version: 1, bridgeTools: { allow: "all" }, vars: true, hostEvents: false }
      );
      const deniedCaptured = registerCapturing(denied, { drainHostEvents: () => [] });
      expect(() => deniedCaptured.sync.events()).toThrow(
        /Capability denied: mux\.events is not granted/
      );
    });

    describe("mux.load", () => {
      const fileReadTool = () =>
        createMockTool("file_read", z.object({ path: z.string() }), () => ({ content: "x" }));
      const loaded = {
        content: "line1\nline2",
        bytes: 11,
        lines: 2,
        preview: "line1\nline2",
      };

      it("writes content into vars via the runtime and returns only the bounded summary", async () => {
        const setVarsProperty = mock((_key: string, _value: string) => undefined);
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          { drainHostEvents: () => [], loadFile: () => Promise.resolve(loaded) },
          { setVarsProperty }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        const summary = await load({ path: "a.txt", key: "data" });
        // Content reaches the guest heap through setVarsProperty only.
        expect(setVarsProperty).toHaveBeenCalledWith("data", loaded.content);
        expect(summary).toEqual({ key: "data", bytes: 11, lines: 2, preview: "line1\nline2" });
      });

      it("tracks successful load keys host-side, immune to record bounding (r67)", async () => {
        // Retention bookkeeping must not depend on the model-visible record:
        // an oversized hookResult annotation can get a load record replaced
        // by a keyless __kernelBounded marker, so keys are recorded at the
        // moment the vars write succeeds and drained by code_execution.
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          { drainHostEvents: () => [], loadFile: () => Promise.resolve(loaded) },
          { setVarsProperty: mock((_key: string, _value: string) => undefined) }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        await load({ path: "a.txt", key: "data" });
        await load({ path: "a.txt", key: "data" }); // same key: deduplicated
        await load({ path: "b.txt", key: "other" });
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual(["data", "other"]);
        // One-shot drain: the next call yields only newer loads.
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual([]);
      });

      it("passes the kernel abort signal to the loader and refuses to mutate vars after abort", async () => {
        // Without propagation, a stalled remote read rides RemoteRuntime's
        // 300s cat timeout regardless of the execution deadline; and an abort
        // landing mid-read must not write the loaded content into vars.
        const controller = new AbortController();
        const setVarsProperty = mock((_key: string, _value: string) => undefined);
        let loaderSignal: AbortSignal | undefined;
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          {
            drainHostEvents: () => [],
            loadFile: (args: { path: string; abortSignal?: AbortSignal }) => {
              loaderSignal = args.abortSignal;
              // Abort lands while the read is in flight.
              controller.abort();
              return Promise.resolve(loaded);
            },
          },
          { setVarsProperty, getAbortSignal: () => controller.signal }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("Execution aborted");
        }
        expect(loaderSignal).toBe(controller.signal);
        expect(setVarsProperty).not.toHaveBeenCalled();
        // A load that never wrote vars must not register a retention key (r67).
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual([]);
      });

      it("is absent without a loader, and absent when file_read is not bridged", () => {
        const noLoader = registerCapturing(new ToolBridge({ file_read: fileReadTool() }), {
          drainHostEvents: () => [],
        });
        expect(noLoader.mux.load).toBeUndefined();

        const noFileRead = registerCapturing(new ToolBridge({}), {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        expect(noFileRead.mux.load).toBeUndefined();
      });

      it("is denied by file_read's grant and rejects reserved keys", async () => {
        const denied = new ToolBridge(
          { file_read: fileReadTool() },
          { version: 1, bridgeTools: { allow: [] }, vars: true, hostEvents: true }
        );
        const deniedCaptured = registerCapturing(denied, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const deniedLoad = deniedCaptured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await deniedLoad({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("Capability denied: mux.load is not granted");
        }

        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(bridge, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "__handleSeq" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("reserved");
        }
      });

      it("requires the vars grant (content has nowhere to live without it)", async () => {
        const bridge = new ToolBridge(
          { file_read: fileReadTool() },
          { version: 1, bridgeTools: { allow: "all" }, vars: false, hostEvents: true }
        );
        const captured = registerCapturing(bridge, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("requires the vars grant");
        }
      });
    });
  });
});

describe("attachment part stripping", () => {
  const mediaPart = {
    type: "media" as const,
    data: "BASE64DATA",
    mediaType: "image/png",
    filename: "board.png",
  };
  const contentResult = {
    type: "content",
    value: [{ type: "text", text: "[Attachment prepared: board.png]" }, mediaPart],
  };

  function registerCapturingXum(bridge: ToolBridge) {
    const captured: { xum: Record<string, (...args: unknown[]) => Promise<unknown>> } = { xum: {} };
    const runtime = createMockRuntime({
      registerObject: (
        name: string,
        obj: Record<string, (...args: unknown[]) => Promise<unknown>>
      ) => {
        if (name === "xum") {
          captured.xum = obj;
        }
      },
    });
    bridge.register(runtime);
    return { captured, runtime };
  }

  it("strips media from bridged content results and drains it per runtime", async () => {
    const bridge = new ToolBridge({
      attach_file: createMockTool(
        "attach_file",
        z.object({ path: z.string() }),
        () => contentResult
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    const sandboxValue = (await captured.xum.attach_file({ path: "/board.png" })) as {
      type: string;
      value: Array<{ type: string; text?: string }>;
    };
    expect(JSON.stringify(sandboxValue)).not.toContain("BASE64DATA");
    expect(sandboxValue.type).toBe("content");
    expect(sandboxValue.value).toHaveLength(2);
    expect(sandboxValue.value[1]).toEqual({ type: "text", text: MEDIA_DATA_STUB });

    expect(bridge.drainPendingAttachments(runtime)).toEqual([mediaPart]);
    // Drain empties the pending set
    expect(bridge.drainPendingAttachments(runtime)).toEqual([]);
  });

  it("attributes stripped media to the invoking runtime", async () => {
    const bridge = new ToolBridge({
      attach_file: createMockTool(
        "attach_file",
        z.object({ path: z.string() }),
        () => contentResult
      ),
    });
    const a = registerCapturingXum(bridge);
    const b = registerCapturingXum(bridge);

    await a.captured.xum.attach_file({ path: "/a.png" });
    expect(bridge.drainPendingAttachments(b.runtime)).toEqual([]);
    expect(bridge.drainPendingAttachments(a.runtime)).toEqual([mediaPart]);

    await b.captured.xum.attach_file({ path: "/b.png" });
    expect(bridge.drainPendingAttachments(b.runtime)).toEqual([mediaPart]);
  });

  it("counts supported media metadata toward the aggregate budget", async () => {
    const bigData = "a".repeat(MAX_PENDING_ATTACHMENT_BYTES - 512);
    const bigPart = { type: "media", data: bigData, mediaType: "image/png" };
    const oversizedFilename = "x".repeat(1024);
    const smallPart = {
      type: "media",
      data: "b",
      mediaType: "application/pdf",
      filename: oversizedFilename,
    };
    const bridge = new ToolBridge({
      attach_file: createMockTool("attach_file", z.object({ path: z.string() }), (args) =>
        (args as { path: string }).path === "/big.png"
          ? { type: "content", value: [bigPart] }
          : { type: "content", value: [smallPart] }
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    const first = (await captured.xum.attach_file({ path: "/big.png" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(first.value[0]).toEqual({ type: "text", text: MEDIA_DATA_STUB });

    // Second attach would push the aggregate over budget: it must be refused
    // with the budget stub and must NOT be carried host-side.
    const second = (await captured.xum.attach_file({ path: "/small.pdf" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(second.value[0]).toEqual({ type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB });
    expect(JSON.stringify(second)).not.toContain(oversizedFilename);

    const drained = bridge.drainPendingAttachments(runtime);
    expect(drained).toHaveLength(1);
    expect(drained[0].data).toBe(bigData);
  });

  it("caps carried attachment parts per execution", async () => {
    const total = MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST + 2;
    const parts = Array.from({ length: total }, (_, index) => ({
      type: "media",
      data: "data-" + index,
      mediaType: "image/png",
    }));
    const bridge = new ToolBridge({
      attach_file: createMockTool("attach_file", z.object({ path: z.string() }), () => ({
        type: "content",
        value: parts,
      })),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    const sandboxValue = (await captured.xum.attach_file({ path: "/many" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(sandboxValue.value).toHaveLength(total);
    expect(sandboxValue.value.slice(MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST)).toEqual([
      { type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB },
      { type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB },
    ]);
    expect(bridge.drainPendingAttachments(runtime)).toHaveLength(
      MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST
    );
  });

  it("register clears stale pending attachments for that runtime", async () => {
    const bridge = new ToolBridge({
      attach_file: createMockTool(
        "attach_file",
        z.object({ path: z.string() }),
        () => contentResult
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);
    await captured.xum.attach_file({ path: "/board.png" });

    // Re-register simulates the next execution's setup: stale media from a
    // crashed prior eval must not leak into the new eval's drain.
    bridge.register(runtime);
    expect(bridge.drainPendingAttachments(runtime)).toEqual([]);
  });

  it("leaves non-content results unchanged but strips unsupported media", async () => {
    const bashResult = { success: true, output: "plain output" };
    const unsupportedMedia = {
      type: "content",
      value: [{ type: "media", data: "RAWBYTES", mediaType: "application/x-custom" }],
    };
    const bridge = new ToolBridge({
      bash: createMockTool("bash", z.object({ script: z.string() }), () => bashResult),
      attach_file: createMockTool(
        "attach_file",
        z.object({ path: z.string() }),
        () => unsupportedMedia
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    expect(await captured.xum.bash({ script: "true" })).toEqual(bashResult);
    const sandboxValue = (await captured.xum.attach_file({ path: "/x.bin" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(sandboxValue.value[0]).toEqual({
      type: "text",
      text: mediaUnsupportedStub("application/x-custom"),
    });
    // Unsupported media is discarded rather than forwarded to the provider.
    expect(bridge.drainPendingAttachments(runtime)).toEqual([]);
  });

  it("bounds unsupported media types in sandbox-visible placeholders", async () => {
    const oversizedMediaType = `audio/${"x".repeat(4096)}`;
    const bridge = new ToolBridge({
      attach_file: createMockTool("attach_file", z.object({ path: z.string() }), () => ({
        type: "content",
        value: [{ type: "media", data: "", mediaType: oversizedMediaType }],
      })),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    const sandboxValue = await captured.xum.attach_file({ path: "/audio.bin" });
    const serialized = JSON.stringify(sandboxValue);
    expect(serialized.length).toBeLessThan(512);
    expect(serialized).not.toContain("x".repeat(200));
    expect(bridge.drainPendingAttachments(runtime)).toEqual([]);
  });

  it("counts discarded unsupported media against the aggregate budget", async () => {
    const bigData = "a".repeat(MAX_PENDING_ATTACHMENT_BYTES - 512);
    const bridge = new ToolBridge({
      attach_file: createMockTool("attach_file", z.object({ path: z.string() }), (args) =>
        (args as { path: string }).path === "/audio.bin"
          ? {
              type: "content",
              value: [{ type: "media", data: bigData, mediaType: "audio/wav" }],
            }
          : {
              type: "content",
              value: [{ type: "media", data: "b".repeat(1024), mediaType: "image/png" }],
            }
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    const unsupported = (await captured.xum.attach_file({ path: "/audio.bin" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(unsupported.value[0]).toEqual({ type: "text", text: mediaUnsupportedStub("audio/wav") });

    const supported = (await captured.xum.attach_file({ path: "/image.png" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(supported.value[0]).toEqual({ type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB });
    expect(bridge.drainPendingAttachments(runtime)).toEqual([]);
  });

  it("strips display_file parts onto the carrier with a display stub", async () => {
    const displayPart = {
      type: "display_file" as const,
      data: "RElTUExBWQ==",
      mediaType: "text/markdown",
      filename: "notes.md",
      providerOptions: { mux: { displayOnly: true as const, size: 7 } },
    };
    const displayResult = {
      type: "content",
      value: [{ type: "text", text: "[File shown to user: notes.md]" }, displayPart],
    };
    const bridge = new ToolBridge({
      attach_file: createMockTool(
        "attach_file",
        z.object({ path: z.string() }),
        () => displayResult
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    // Display-only bytes are user-preview data, but leaving them inline lets
    // guests grow host-side records without bound: they ride the carrier and
    // render from the code_execution card instead of the nested result.
    const sandboxValue = (await captured.xum.attach_file({ path: "/notes.md" })) as {
      value: Array<{ type: string; data?: string; filename?: string }>;
    };
    expect(JSON.stringify(sandboxValue)).not.toContain("RElTUExBWQ==");
    expect(sandboxValue.value[1].type).toBe("display_file");
    expect(sandboxValue.value[1].data).toBe(DISPLAY_DATA_STUB);
    expect(sandboxValue.value[1].filename).toBe("notes.md");

    expect(bridge.drainPendingAttachments(runtime)).toEqual([displayPart]);
  });

  it("counts display_file metadata toward the aggregate attachment budget", async () => {
    const bigData = "a".repeat(MAX_PENDING_ATTACHMENT_BYTES - 512);
    const oversizedMetadata = "x".repeat(1024);
    const bridge = new ToolBridge({
      attach_file: createMockTool("attach_file", z.object({ path: z.string() }), (args) =>
        (args as { path: string }).path === "/big.png"
          ? { type: "content", value: [{ type: "media", data: bigData, mediaType: "image/png" }] }
          : {
              type: "content",
              value: [
                {
                  type: "display_file",
                  data: "b",
                  mediaType: "text/markdown",
                  providerOptions: {
                    mux: { displayOnly: true, size: 1 },
                    external: oversizedMetadata,
                  },
                },
              ],
            }
      ),
    });
    const { captured, runtime } = registerCapturingXum(bridge);

    await captured.xum.attach_file({ path: "/big.png" });
    // The media part above nearly exhausted the shared budget: the display
    // part must be refused with the budget stub and not carried host-side.
    const second = (await captured.xum.attach_file({ path: "/notes.md" })) as {
      value: Array<{ type: string; text?: string }>;
    };
    expect(second.value[0]).toEqual({ type: "text", text: MEDIA_BUDGET_EXCEEDED_STUB });
    expect(JSON.stringify(second)).not.toContain(oversizedMetadata);

    const drained = bridge.drainPendingAttachments(runtime);
    expect(drained).toHaveLength(1);
    expect(drained[0].type).toBe("media");
  });
});
