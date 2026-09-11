import { describe, expect, test } from "bun:test";

import { createMCPTool, createMCPToolContract, createMCPToolInputSchema } from "./mcpClient";

describe("createMCPToolInputSchema", () => {
  test("exposes a nullable model contract and restores the server contract", async () => {
    const inputSchema = createMCPToolInputSchema({
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string" },
        cursor: { type: "string" },
        statusUpdateType: { type: "string", enum: ["project", "initiative"] },
      },
      additionalProperties: false,
    });

    expect(inputSchema.jsonSchema).toMatchObject({
      required: ["issueId"],
      additionalProperties: false,
      properties: {
        issueId: { type: "string" },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        statusUpdateType: {
          anyOf: [{ type: "string", enum: ["project", "initiative"] }, { type: "null" }],
        },
      },
    });

    // Both placeholders a model uses for an omitted optional argument are
    // removed before tools/call: strict-mode `null` and habitual `""` (#2887).
    expect(
      await inputSchema.validate?.({
        issueId: "CODAGT-709",
        cursor: "",
        statusUpdateType: null,
      })
    ).toEqual({
      success: true,
      value: { issueId: "CODAGT-709" },
    });
  });

  test.each(["$ref", "$dynamicRef", "$recursiveRef"])(
    "uses the non-strict fallback for schemas with %s",
    async (keyword) => {
      const source = {
        type: "object",
        properties: { value: { [keyword]: "#/$defs/value" } },
        $defs: { value: { type: "string" } },
      };
      const contract = createMCPToolContract(source);

      expect(contract.strict).toBe(false);
      expect(contract.inputSchema.jsonSchema as Record<string, unknown>).toEqual({
        ...source,
        additionalProperties: false,
      });
      expect(await contract.inputSchema.validate?.({ value: null })).toEqual({
        success: true,
        value: { value: null },
      });
    }
  );

  test("does not close a composed root schema with synthetic empty properties", () => {
    const inputSchema = createMCPToolInputSchema({
      type: "object",
      allOf: [
        {
          type: "object",
          properties: { value: { type: "string" } },
        },
      ],
    });

    expect(inputSchema.jsonSchema).not.toHaveProperty("additionalProperties");
    expect(inputSchema.jsonSchema).not.toHaveProperty("properties");
  });

  test("preserves dictionary schemas", () => {
    const inputSchema = createMCPToolInputSchema({
      type: "object",
      additionalProperties: { type: "string" },
    });

    expect(inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    });
  });
});

describe("createMCPTool", () => {
  test("restores arguments at the execute boundary", async () => {
    const calls: unknown[] = [];
    const tool = createMCPTool(
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" }, limit: { type: "integer" } },
        },
      },
      (args) => {
        calls.push(args);
        return Promise.resolve({ content: [] });
      }
    );

    // Input parsing did not run: a direct caller, or middleware that rewrites
    // parsed arguments, hands execute the placeholders themselves.
    await tool.execute?.(
      { q: "", limit: null },
      { toolCallId: "call", messages: [], context: undefined }
    );

    expect(calls).toEqual([{}]);
  });

  test("leaves a tool's schema alone once its catalog's budget is spent", () => {
    // Each schema fits on its own; the catalog pays for them together.
    const definition = {
      name: "search",
      inputSchema: { type: "object" as const, properties: { q: { type: "string" } } },
    };
    const callTool = () => Promise.resolve({ content: [] });
    const budget = { nodes: 10, chars: 10_000 };
    const [first, second] = [
      createMCPTool(definition, callTool, budget),
      createMCPTool(definition, callTool, budget),
    ].map((tool) => {
      const inputSchema = tool.inputSchema as { jsonSchema?: { properties: { q: unknown } } };
      return { strict: tool.strict, q: inputSchema.jsonSchema?.properties.q };
    });

    expect(first).toEqual({
      strict: undefined,
      q: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    expect(second).toEqual({ strict: false, q: { type: "string" } });
  });
});
