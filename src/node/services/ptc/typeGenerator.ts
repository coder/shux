/**
 * Type Generator for PTC
 *
 * Generates `.d.ts` TypeScript declarations from tool schemas.
 * Used to:
 * 1. Inform the model about available tools and their signatures
 * 2. Validate agent code with TypeScript before QuickJS execution
 *
 * Input types are generated from Zod schemas via JSON Schema conversion.
 * Result types are generated from Zod schemas in toolDefinitions.ts (single source of truth).
 */

import { createHash } from "crypto";
import { z } from "zod";
import { compile } from "json-schema-to-typescript";
import type { Tool } from "ai";
import { getToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { TASK_TERMINAL_EVENT_TYPE } from "@/constants/sandboxEvents";

/** Options for mux type generation. */
export interface XumTypesOptions {
  /**
   * RLM kernel mode (persistent mount): declare the fire-and-forget spawn +
   * host-event drain members. RLM off => these never enter the generated
   * types, keeping non-kernel provider requests byte-identical.
   */
  kernel?: boolean;
  /**
   * mux.load available (kernel mode + a host file loader + file_read
   * bridged): declare the bulk-ingestion member. Kept separate from `kernel`
   * because load has an extra availability requirement (workspace file
   * context) that task_spawn/events do not.
   */
  load?: boolean;
}

/**
 * MCP result type - protocol-defined, same for all MCP tools.
 */
const MCP_RESULT_TYPE = `type MCPCallToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; text?: string; blob?: string } }
  >;
  isError?: boolean;
};`;

// ============================================================================
// Caching
// ============================================================================

/**
 * Unified cache structure for all type generation artifacts.
 */
interface TypeCache {
  /** Full generated .d.ts content, keyed by tool set hash */
  fullTypes: Map<string, string>;
  /** Individual result type strings, keyed by tool name */
  resultTypes: Map<string, string>;
}

const cache: TypeCache = {
  fullTypes: new Map(),
  resultTypes: new Map(),
};

/**
 * Clear all type caches. Call for test isolation or when tool schemas might have changed.
 */
export function clearTypeCache(): void {
  cache.fullTypes.clear();
  cache.resultTypes.clear();
}

/**
 * Hash tool definitions (names, schemas, descriptions) to detect when tools change.
 * This ensures cache invalidation when schemas are updated, not just when tool names change.
 */
function hashToolDefinitions(tools: Record<string, Tool>): string {
  const sortedNames = Object.keys(tools).sort();
  const toolData = sortedNames.map((name) => {
    const tool = tools[name];
    return {
      name,
      schema: getInputJsonSchema(tool),
      description: tool.description ?? "",
    };
  });
  return createHash("md5").update(JSON.stringify(toolData)).digest("hex");
}

/**
 * Get cached xum types or generate new ones if tool definitions changed.
 */
export async function getCachedXumTypes(
  tools: Record<string, Tool>,
  options?: XumTypesOptions
): Promise<string> {
  // Kernel mode changes the generated declarations, so it is part of the
  // cache identity — one workspace with RLM on must not serve another's
  // RLM-off types (or vice versa).
  const hash = `${hashToolDefinitions(tools)}|kernel=${options?.kernel === true}|load=${options?.load === true}`;
  const cached = cache.fullTypes.get(hash);
  if (cached) {
    return cached;
  }

  const types = await generateXumTypes(tools, options);
  cache.fullTypes.set(hash, types);
  return types;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert snake_case or kebab-case to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .split(/[_-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Remove fields with "default" values from the "required" array so
 * json-schema-to-typescript generates optional (`?`) properties.
 *
 * Why this is needed: Zod's `.default(value)` makes the *input* optional
 * (safeParse fills in the default) but z.toJSONSchema() keeps the field in
 * "required" — JSON Schema treats "required" and "default" as orthogonal
 * concepts. json-schema-to-typescript then faithfully maps "required" →
 * non-optional TS property, producing types that don't match runtime behavior.
 *
 * Important: Only apply this to JSON Schema that came from Zod. For raw JSON
 * Schema (e.g. MCP tool parameters), `default` is advisory metadata and does
 * not imply optional input.
 */
function removeDefaultsFromRequired(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  const properties = result.properties as Record<string, Record<string, unknown>> | undefined;
  const required = result.required as string[] | undefined;

  if (properties && required) {
    result.required = required.filter((key) => {
      const prop = properties[key];
      return prop == null || !("default" in prop);
    });
  }

  return result;
}

/**
 * Indent each line of a string.
 */
function indent(str: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

/**
 * Extract JSON Schema from a tool, handling both Zod schemas and raw JSON Schema.
 */
function getInputJsonSchema(tool: Tool): Record<string, unknown> {
  const toolRecord = tool as { inputSchema?: unknown; parameters?: unknown };
  const schema = toolRecord.inputSchema ?? toolRecord.parameters;

  if (!schema) {
    return { type: "object", properties: {}, required: [] };
  }

  // Check if it's a Zod schema (has _def property)
  if (typeof schema === "object" && "_def" in schema) {
    // Zod `.default(...)` makes inputs optional, but z.toJSONSchema() keeps
    // those fields in the "required" array. Strip them so the generated TS
    // types match runtime behavior.
    return removeDefaultsFromRequired(
      z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>
    );
  }

  // Already JSON Schema — leave required array untouched; `default` is advisory
  // metadata and does not imply optional input.
  return schema as Record<string, unknown>;
}

/**
 * Get result type string for a built-in tool.
 * Uses Zod schema → JSON Schema → TypeScript string pipeline.
 * Results are cached by tool name.
 *
 * @returns TypeScript type string or null if no schema exists
 */
async function getResultTypeString(toolName: string): Promise<string | null> {
  // Check cache first
  if (cache.resultTypes.has(toolName)) {
    return cache.resultTypes.get(toolName)!;
  }

  const schema = getToolResultSchema(toolName);
  if (!schema) return null;

  // Convert Zod → JSON Schema → TypeScript
  const jsonSchema = z.toJSONSchema(schema);
  const tsOutput = await compile(
    jsonSchema as Parameters<typeof compile>[0],
    `${pascalCase(toolName)}Result`,
    {
      bannerComment: "",
      ignoreMinAndMaxItems: true,
    }
  );

  // Extract just the type definition body (after "export type X = ")
  // The compile output looks like: "export type FooResult = { ... } | { ... };"
  // Use regex to match the declaration pattern, avoiding false matches on `=` in type body
  const typeBodyRegex = /^export\s+type\s+\w+\s*=\s*([\s\S]+?);?\s*$/;
  const match = typeBodyRegex.exec(tsOutput);
  if (!match) return null;

  const result = match[1].trim();

  if (result) {
    cache.resultTypes.set(toolName, result);
  }
  return result;
}

// ============================================================================
// Main Generator
// ============================================================================

/**
 * Generate TypeScript declaration file content for all bridgeable tools.
 *
 * @param tools Record of tool name to Tool, already filtered to bridgeable tools only
 * @returns `.d.ts` content as a string
 */
export async function generateXumTypes(
  tools: Record<string, Tool>,
  options?: XumTypesOptions
): Promise<string> {
  const lines: string[] = ["declare namespace xum {"];
  let mcpToolsPresent = false;

  // Sort tool names for deterministic output
  const sortedNames = Object.keys(tools).sort();

  for (const name of sortedNames) {
    const tool = tools[name];
    const isMcp = name.startsWith("mcp__");

    // Generate arg interface from JSON Schema
    const inputSchema = getInputJsonSchema(tool);
    const argsTypeName = `${pascalCase(name)}Args`;

    try {
      const argInterface = await compile(
        inputSchema as Parameters<typeof compile>[0],
        argsTypeName,
        {
          bannerComment: "",
          ignoreMinAndMaxItems: true, // Clean Type[] instead of verbose tuple unions
        }
      );
      // Strip "export " prefix and add to output
      const stripped = argInterface.replace(/^export /gm, "");
      lines.push(indent(stripped.trim(), 2));
    } catch {
      // Fallback for schemas that can't be compiled
      lines.push(`  interface ${argsTypeName} { [key: string]: unknown; }`);
    }

    // Add JSDoc comment with tool description (first line only)
    // AI SDK 7 allows function-valued descriptions; mux tools only use strings.
    const description = typeof tool.description === "string" ? tool.description : "";
    if (description) {
      const firstLine = description.split("\n")[0].trim();
      if (firstLine) {
        lines.push(`  /** ${firstLine} */`);
      }
    }

    // Add function declaration with appropriate result type
    // Note: Asyncify makes async host functions appear synchronous to QuickJS,
    // so we declare them as returning T directly, not Promise<T>
    if (isMcp) {
      mcpToolsPresent = true;
      lines.push(`  function ${name}(args: ${argsTypeName}): MCPCallToolResult;`);
    } else {
      const resultType = await getResultTypeString(name);
      if (resultType) {
        const resultTypeName = `${pascalCase(name)}Result`;
        lines.push(`  type ${resultTypeName} = ${resultType};`);
        lines.push(`  function ${name}(args: ${argsTypeName}): ${resultTypeName};`);
      } else {
        // Unknown tool - return unknown
        lines.push(`  function ${name}(args: ${argsTypeName}): unknown;`);
      }
    }

    lines.push(""); // Blank line between tools
  }

  // RLM kernel members. Hand-authored declarations (no backing Zod tool
  // schema): task_spawn wraps the task tool host-side and events drains the
  // mount's host event queue — keep in sync with ToolBridge.addKernelMethods
  // and SandboxHostService.postTaskTerminalEvent.
  if (options?.kernel === true) {
    // task_spawn reuses TaskArgs, so it is only declarable when the task tool
    // itself is bridged (grant-denied task => no task_spawn either).
    if ("task" in tools) {
      lines.push(
        "  /** Fire-and-forget spawn: same args as mux.task but returns as soon as the child is admitted — it never waits for completion. The terminal report is delivered to the host event queue; drain with mux.events() in a later call. */"
      );
      lines.push(
        '  type TaskSpawnResult = { taskId: string; status: "spawned" } | { taskIds: string[]; status: "spawned" };'
      );
      lines.push("  function task_spawn(args: TaskArgs): TaskSpawnResult;");
      lines.push("");
    }
    lines.push(
      "  /** Drain queued host→guest events (spawned-task terminal reports). Synchronous — safe to call anywhere. Best-effort: an app restart drops undrained events, but every report still reaches the parent via the top-level task wake. Oversized reports arrive as reportHandle (full text at that vars handle) instead of reportMarkdown — or, when the kernel was busy at completion time, as a bounded reportMarkdown preview (full report still available at top level). */"
    );
    lines.push(
      `  type HostEvent = { type: "${TASK_TERMINAL_EVENT_TYPE}"; taskId: string; status: "completed"; reportMarkdown?: string; reportHandle?: { handle: string; preview: string; size: number } };`
    );
    lines.push("  function events(): HostEvent[];");
    lines.push("");
    // mux.load: bulk file ingestion — keep in sync with
    // ToolBridge.addKernelMethods and createKernelFileLoader.
    if (options.load === true) {
      lines.push(
        "  /** Bulk file ingestion: reads the WHOLE file host-side into vars[key] as a string (no 16KB/1000-line pagination cap) and returns only this bounded summary — the content itself never enters your context. Same path resolution and capability grant as file_read. hookResult is present only when a repo tool hook or plugin middleware annotated the read (warnings, notices). */"
      );
      // r58: hookResult must be declared — kernel programs are TypeScript-
      // analyzed before execution, so an undeclared runtime property is
      // unreachable to guest code (keep in sync with ToolBridge's load record).
      lines.push(
        "  type LoadResult = { key: string; bytes: number; lines: number; preview: string; hookResult?: unknown };"
      );
      lines.push("  function load(args: { path: string; key: string }): LoadResult;");
      lines.push("");
    }
  }

  // Add MCP result type if any MCP tools are present
  if (mcpToolsPresent) {
    lines.push(indent(MCP_RESULT_TYPE, 2));
    lines.push("");
  }

  lines.push("}");
  lines.push("");

  // Keep the old scripting namespace as a type-compatible alias for saved snippets.
  lines.push("declare const mux: typeof xum;");
  lines.push("");

  // Add console global declaration
  lines.push(
    "declare var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };"
  );
  lines.push("");

  return lines.join("\n");
}
