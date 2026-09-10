import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";
import { generateXumTypes, getCachedXumTypes, clearTypeCache } from "./typeGenerator";

/**
 * Create a mock tool with the given schema and optional execute function.
 */
function createMockTool(schema: z.ZodType, hasExecute = true): Tool {
  return {
    description: "Mock tool",
    inputSchema: schema,
    execute: hasExecute ? () => Promise.resolve({ success: true }) : undefined,
  } as unknown as Tool;
}

describe("generateXumTypes", () => {
  test("generates interface from tool input schema", async () => {
    const fileReadTool = createMockTool(
      z.object({
        filePath: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      })
    );

    const types = await generateXumTypes({ file_read: fileReadTool });

    expect(types).toContain("interface FileReadArgs");
    expect(types).toContain("filePath: string");
    expect(types).toContain("offset?: number");
    expect(types).toContain("limit?: number");
  });

  test("returns result types directly (not Promise, due to Asyncify)", async () => {
    const fileReadTool = createMockTool(
      z.object({
        filePath: z.string(),
      })
    );

    const types = await generateXumTypes({ file_read: fileReadTool });

    // Asyncify makes async host functions appear synchronous to QuickJS
    expect(types).toContain("function file_read(args: FileReadArgs): FileReadResult");
    expect(types).not.toContain("Promise<FileReadResult>");
  });

  test("generates result type from Zod schema (not hardcoded)", async () => {
    const fileReadTool = createMockTool(
      z.object({
        filePath: z.string(),
      })
    );

    const types = await generateXumTypes({ file_read: fileReadTool });

    // Should include FileReadResult type definition
    expect(types).toContain("type FileReadResult =");
    // Should include fields from the actual Zod schema in toolDefinitions.ts
    expect(types).toContain("file_size");
    expect(types).toContain("modifiedTime");
    expect(types).toContain("lines_read");
    expect(types).toContain("content");
  });

  test("generates optional properties for fields with .default()", async () => {
    const tool = createMockTool(
      z.object({
        script: z.string().describe("Required field"),
        run_in_background: z.boolean().default(false).describe("Has default"),
        timeout_secs: z.number().default(60).describe("Has default"),
      })
    );

    const types = await generateXumTypes({ my_tool: tool });

    // Fields with .default() should be optional (matching Zod input type)
    expect(types).toContain("run_in_background?:");
    expect(types).toContain("timeout_secs?:");
    // Fields without .default() should remain required
    expect(types).toMatch(/\bscript: string\b/);
    expect(types).not.toContain("script?:");
  });

  test("generates discriminated union result types with success: true/false", async () => {
    const bashTool = createMockTool(
      z.object({
        script: z.string(),
        timeout_secs: z.number(),
        run_in_background: z.boolean().default(false),
        display_name: z.string(),
      })
    );

    const types = await generateXumTypes({ bash: bashTool });

    // Should have success branches
    expect(types).toContain("success: true");
    expect(types).toContain("success: false");
    // Should have discriminated union (multiple object types joined by |)
    expect(types).toMatch(/\{[^}]*success: true[^}]*\}[^|]*\|[^{]*\{/);
  });

  test("generates result types for RLM family messaging tools (not unknown)", async () => {
    const messageArgs = z.object({ message: z.string() });
    const types = await generateXumTypes({
      task_message_parent: createMockTool(messageArgs),
      task_message_sibling: createMockTool(z.object({ task_id: z.string(), message: z.string() })),
    });

    // Both tools must resolve through catalog result schemas so the kernel sees their
    // status discriminants instead of an opaque unknown return type.
    expect(types).toContain(
      "function task_message_parent(args: TaskMessageParentArgs): TaskMessageParentResult"
    );
    expect(types).toContain(
      "function task_message_sibling(args: TaskMessageSiblingArgs): TaskMessageSiblingResult"
    );
    expect(types).not.toContain("): unknown");
    expect(types).toContain('status: "sent"');
  });

  test("handles MCP tools with MCPCallToolResult", async () => {
    const mcpTool = createMockTool(
      z.object({
        issue_title: z.string(),
        issue_body: z.string(),
      })
    );

    const types = await generateXumTypes({ mcp__github__create_issue: mcpTool });

    // MCP tools also return directly (not Promise) due to Asyncify
    expect(types).toContain(
      "function mcp__github__create_issue(args: McpGithubCreateIssueArgs): MCPCallToolResult"
    );
    expect(types).not.toContain("Promise<MCPCallToolResult>");
    expect(types).toContain("type MCPCallToolResult");
    // MCP result type should have content array
    expect(types).toContain("content: Array<");
  });

  test("only includes MCPCallToolResult when MCP tools present", async () => {
    const fileReadTool = createMockTool(
      z.object({
        filePath: z.string(),
      })
    );

    const types = await generateXumTypes({ file_read: fileReadTool });

    expect(types).not.toContain("MCPCallToolResult");
  });

  test("generates a typed result for mcp_prompt_get", async () => {
    const promptGetTool = createMockTool(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.string()).nullish(),
      })
    );

    const types = await generateXumTypes({ mcp_prompt_get: promptGetTool });

    expect(types).toContain("type McpPromptGetResult =");
    expect(types).toContain("mcp_prompt_get(args: McpPromptGetArgs): McpPromptGetResult");
    expect(types).not.toContain("mcp_prompt_get(args: McpPromptGetArgs): unknown");
  });

  test("handles tools without known result type (returns unknown)", async () => {
    const customTool = createMockTool(
      z.object({
        input: z.string(),
      })
    );

    const types = await generateXumTypes({ custom_tool: customTool });

    expect(types).toContain("function custom_tool(args: CustomToolArgs): unknown");
    expect(types).not.toContain("Promise<unknown>");
    expect(types).not.toContain("CustomToolResult");
  });

  test("declares console global", async () => {
    const types = await generateXumTypes({});

    expect(types).toContain("declare var console");
    expect(types).toContain("log(...args: unknown[]): void");
    expect(types).toContain("warn(...args: unknown[]): void");
    expect(types).toContain("error(...args: unknown[]): void");
  });

  test("converts snake_case tool names to PascalCase for types", async () => {
    const tool = createMockTool(
      z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      })
    );

    const types = await generateXumTypes({ file_edit_replace_string: tool });

    expect(types).toContain("FileEditReplaceStringArgs");
    expect(types).toContain("FileEditReplaceStringResult");
  });

  test("sorts tools alphabetically for deterministic output", async () => {
    const tools = {
      z_last: createMockTool(z.object({ x: z.string() })),
      a_first: createMockTool(z.object({ y: z.string() })),
      m_middle: createMockTool(z.object({ z: z.string() })),
    };

    const types = await generateXumTypes(tools);

    // Find positions of each function declaration
    const aPos = types.indexOf("function a_first");
    const mPos = types.indexOf("function m_middle");
    const zPos = types.indexOf("function z_last");

    expect(aPos).toBeLessThan(mPos);
    expect(mPos).toBeLessThan(zPos);
  });

  test("generates all bridgeable tool types correctly", async () => {
    // Test all 8 bridgeable tools have proper result types
    const tools = {
      bash: createMockTool(z.object({ script: z.string() })),
      bash_output: createMockTool(z.object({ process_id: z.string() })),
      bash_background_list: createMockTool(z.object({})),
      bash_background_terminate: createMockTool(z.object({ process_id: z.string() })),
      file_read: createMockTool(z.object({ filePath: z.string() })),
      file_edit_insert: createMockTool(z.object({ path: z.string() })),
      file_edit_replace_string: createMockTool(z.object({ path: z.string() })),
      web_fetch: createMockTool(z.object({ url: z.string() })),
    };

    const types = await generateXumTypes(tools);

    // All should have result types (not unknown)
    expect(types).toContain("BashResult");
    expect(types).toContain("BashOutputResult");
    expect(types).toContain("BashBackgroundListResult");
    expect(types).toContain("BashBackgroundTerminateResult");
    expect(types).toContain("FileReadResult");
    expect(types).toContain("FileEditInsertResult");
    expect(types).toContain("FileEditReplaceStringResult");
    expect(types).toContain("WebFetchResult");

    // None should be unknown (no Promise since Asyncify makes calls sync)
    expect(types).not.toContain("function bash(args: BashArgs): unknown");
    expect(types).not.toContain("function file_read(args: FileReadArgs): unknown");
  });

  test("heartbeat tool gets a typed result so sandbox code can check result.success", async () => {
    const types = await generateXumTypes({
      heartbeat: createMockTool(z.object({ action: z.string() })),
    });
    expect(types).toContain("HeartbeatResult");
    expect(types).not.toContain("function heartbeat(args: HeartbeatArgs): unknown");
  });

  test("memory tool gets a typed result so sandbox code can check result.success", async () => {
    const types = await generateXumTypes({
      memory: createMockTool(z.object({ command: z.string() })),
    });
    expect(types).toContain("MemoryResult");
    expect(types).not.toContain("function memory(args: MemoryArgs): unknown");
  });

  test("handles JSON Schema input (MCP tools)", async () => {
    // MCP tools come with JSON Schema, not Zod
    const mcpTool = {
      description: "Mock MCP tool",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          owner: { type: "string" },
        },
        required: ["repo", "owner"],
      },
      execute: () => Promise.resolve({ content: [] }),
    } as unknown as Tool;

    const types = await generateXumTypes({ mcp__github__list_repos: mcpTool });

    expect(types).toContain("interface McpGithubListReposArgs");
    expect(types).toContain("repo: string");
    expect(types).toContain("owner: string");
  });

  test("does not strip defaults from raw JSON Schema (MCP tools)", async () => {
    // MCP tools come with JSON Schema, not Zod. JSON Schema `default` is
    // advisory metadata and does not make the property optional.
    const mcpTool = {
      description: "Mock MCP tool with defaults",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", default: "my-repo" },
          owner: { type: "string" },
        },
        required: ["repo", "owner"],
      },
      execute: () => Promise.resolve({ content: [] }),
    } as unknown as Tool;

    const types = await generateXumTypes({ mcp__github__list_repos: mcpTool });

    // `repo` must remain required even though it has a `default`
    expect(types).toContain("repo: string");
    expect(types).not.toContain("repo?:");
    expect(types).toContain("owner: string");
  });
  test("handles empty tool set", async () => {
    const types = await generateXumTypes({});

    expect(types).toContain("declare namespace xum {");
    expect(types).toContain("declare const mux: typeof xum;");
    expect(types).not.toContain("declare namespace mux {");
    expect(types).toContain("}");
    expect(types).toContain("declare var console");
  });
});

describe("getCachedXumTypes", () => {
  beforeEach(() => {
    clearTypeCache();
  });

  test("invalidates cache when tool schema changes", async () => {
    const toolV1 = createMockTool(z.object({ name: z.string() }));
    const toolV2 = createMockTool(z.object({ name: z.string(), age: z.number() }));

    const types1 = await getCachedXumTypes({ my_tool: toolV1 });
    expect(types1).toContain("name: string");
    expect(types1).not.toContain("age");

    // Same tool name, different schema - should regenerate
    const types2 = await getCachedXumTypes({ my_tool: toolV2 });
    expect(types2).toContain("name: string");
    expect(types2).toContain("age: number");
  });

  test("invalidates cache when tool description changes", async () => {
    const tool1: Tool = {
      description: "Version 1",
      inputSchema: z.object({ x: z.string() }),
      execute: () => Promise.resolve({ success: true }),
    } as unknown as Tool;

    const tool2: Tool = {
      description: "Version 2",
      inputSchema: z.object({ x: z.string() }),
      execute: () => Promise.resolve({ success: true }),
    } as unknown as Tool;

    const types1 = await getCachedXumTypes({ my_tool: tool1 });
    expect(types1).toContain("Version 1");

    const types2 = await getCachedXumTypes({ my_tool: tool2 });
    expect(types2).toContain("Version 2");
  });

  test("returns cached types when tools are identical", async () => {
    const tool = createMockTool(z.object({ value: z.string() }));

    const types1 = await getCachedXumTypes({ my_tool: tool });
    const types2 = await getCachedXumTypes({ my_tool: tool });

    // Should be the exact same object reference (cached)
    expect(types1).toBe(types2);
  });

  test("kernel mode is part of the cache identity (RLM on/off must not share types)", async () => {
    const tool = createMockTool(z.object({ prompt: z.string() }));

    const kernelOff = await getCachedXumTypes({ task: tool });
    const kernelOn = await getCachedXumTypes({ task: tool }, { kernel: true });
    expect(kernelOff).not.toContain("task_spawn");
    expect(kernelOn).toContain("function task_spawn(args: TaskArgs): TaskSpawnResult;");
    // Re-fetching kernel-off after kernel-on must not serve stale kernel types.
    expect(await getCachedXumTypes({ task: tool })).toBe(kernelOff);
  });
});

describe("kernel declarations (RLM)", () => {
  test("RLM off: no kernel members in the generated namespace", async () => {
    const tool = createMockTool(z.object({ prompt: z.string() }));
    const types = await generateXumTypes({ task: tool });
    expect(types).not.toContain("task_spawn");
    expect(types).not.toContain("function events()");
  });

  test("kernel mode declares task_spawn (reusing TaskArgs) and events", async () => {
    const tool = createMockTool(z.object({ prompt: z.string() }));
    const types = await generateXumTypes({ task: tool }, { kernel: true });
    expect(types).toContain("function task_spawn(args: TaskArgs): TaskSpawnResult;");
    expect(types).toContain("function events(): HostEvent[];");
    expect(types).toContain('type HostEvent = { type: "task-terminal";');
  });

  test("kernel mode without a bridged task tool declares events but not task_spawn", async () => {
    const tool = createMockTool(z.object({ filePath: z.string() }));
    const types = await generateXumTypes({ file_read: tool }, { kernel: true });
    expect(types).not.toContain("task_spawn");
    expect(types).toContain("function events(): HostEvent[];");
  });
});
