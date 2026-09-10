import { describe, expect, test } from "bun:test";
import { validateJsonSchemaSubset, validateJsonSchemaSubsetSchema } from "./jsonSchemaSubset";

describe("validateJsonSchemaSubset", () => {
  test("validates schemas without requiring an example value", () => {
    expect(
      validateJsonSchemaSubsetSchema({
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
        additionalProperties: false,
      })
    ).toEqual({ success: true });

    expect(validateJsonSchemaSubsetSchema({ type: ["string", "null"] })).toEqual({
      success: true,
    });
  });

  test("accepts nested objects that satisfy required properties and primitive types", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        required: ["claims"],
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              required: ["text", "confidence"],
              properties: {
                text: { type: "string" },
                confidence: { type: "number" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      { claims: [{ text: "Workflow runs are durable", confidence: 0.8 }] }
    );

    expect(result).toEqual({ success: true });
  });

  test("returns actionable paths for missing required properties and type errors", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        required: ["summary", "sources"],
        properties: {
          summary: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      },
      { sources: ["one", 2] }
    );

    expect(result).toEqual({
      success: false,
      errors: [
        { path: "$.summary", message: "Required property is missing" },
        { path: "$.sources[1]", message: "Expected string, got number" },
      ],
    });
  });

  test("supports richer JSON Schema keywords", () => {
    expect(validateJsonSchemaSubset({ type: "string", pattern: "^ok$" }, "ok")).toEqual({
      success: true,
    });

    expect(
      validateJsonSchemaSubset(
        {
          type: "object",
          required: ["kind", "value", "tags"],
          properties: {
            kind: { const: "answer" },
            value: {
              oneOf: [
                { type: "string", minLength: 3 },
                { type: "number", minimum: 10 },
              ],
            },
            tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
          },
        },
        { kind: "answer", value: "yes", tags: ["a"] }
      )
    ).toEqual({ success: true });
  });

  test("supports anyOf and allOf composition", () => {
    expect(
      validateJsonSchemaSubset(
        {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { anyOf: [{ type: "string", minLength: 2 }, { const: 0 }] },
            label: { allOf: [{ type: "string" }, { minLength: 3 }, { maxLength: 8 }] },
          },
        },
        { id: "ok", label: "valid" }
      )
    ).toEqual({ success: true });

    const result = validateJsonSchemaSubset(
      {
        type: "object",
        required: ["id", "label"],
        properties: {
          id: { anyOf: [{ type: "string", minLength: 2 }, { const: 0 }] },
          label: { allOf: [{ type: "string" }, { minLength: 3 }, { maxLength: 8 }] },
        },
      },
      { id: false, label: "xy" }
    );

    expect(result.success).toBe(false);
  });

  test("supports JSON Schema type unions", () => {
    expect(validateJsonSchemaSubset({ type: ["string", "null"] }, null)).toEqual({
      success: true,
    });

    expect(validateJsonSchemaSubset({ type: ["string", "null"] }, 42)).toEqual({
      success: false,
      errors: [{ path: "$", message: "Expected string or null, got number" }],
    });
  });

  test("accepts nulls that are included in nullable enums", () => {
    expect(
      validateJsonSchemaSubset({ type: ["string", "null"], enum: ["low", "high", null] }, null)
    ).toEqual({ success: true });
  });

  test("supports schema-valued additionalProperties", () => {
    expect(
      validateJsonSchemaSubset(
        { type: "object", additionalProperties: { type: "string" } },
        { extra: "ok" }
      )
    ).toEqual({ success: true });

    const result = validateJsonSchemaSubset(
      { type: "object", additionalProperties: { type: "string" } },
      { extra: 42 }
    );

    expect(result.success).toBe(false);
  });

  test("can require workflow tool schemas to be top-level objects", () => {
    expect(
      validateJsonSchemaSubsetSchema(
        { type: "object", properties: { summary: { type: "string" } } },
        {
          requireObjectSchema: true,
        }
      )
    ).toEqual({ success: true });

    expect(validateJsonSchemaSubsetSchema({}, { requireObjectSchema: true })).toEqual({
      success: false,
      errors: [
        {
          path: "$.type",
          message:
            "Workflow agent schemas must be object schemas; wrap scalar or array results in an object field",
        },
      ],
    });

    expect(
      validateJsonSchemaSubsetSchema({ type: "string" }, { requireObjectSchema: true })
    ).toEqual({
      success: false,
      errors: [
        {
          path: "$.type",
          message:
            "Workflow agent schemas must be object schemas; wrap scalar or array results in an object field",
        },
      ],
    });
  });

  test("rejects $ref and overly deep schemas", () => {
    expect(validateJsonSchemaSubsetSchema({ $ref: "#/defs/value" })).toEqual({
      success: false,
      errors: [{ path: "$", message: "$ref is not supported in workflow schemas" }],
    });

    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 66; i += 1) {
      schema = { type: "object", properties: { nested: schema } };
    }

    const result = validateJsonSchemaSubsetSchema(schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.message).toBe("Schema is too deeply nested");
    }
  });

  test("supports enum, integer, and additionalProperties false", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        properties: {
          status: { enum: ["pass", "fail"] },
          count: { type: "integer" },
        },
        additionalProperties: false,
      },
      { status: "maybe", count: 1.5, extra: true }
    );

    expect(result).toEqual({
      success: false,
      errors: [
        { path: "$.status", message: "Expected one of: pass, fail" },
        { path: "$.count", message: "Expected integer, got number" },
        { path: "$.extra", message: "Additional property is not allowed" },
      ],
    });
  });

  test("treats $id as the document's identity, not part of the instance contract", () => {
    // Two different schemas that share an `$id` would collide in Ajv's registry
    // if the identity reached it.
    const id = "urn:xum:test:shared-id";
    expect(validateJsonSchemaSubset({ $id: id, type: "string" }, "text")).toEqual({
      success: true,
    });
    expect(validateJsonSchemaSubset({ $id: id, type: "number" }, 1)).toEqual({ success: true });
  });

  test("keeps validating schemas after compiling one whose $id names a meta-schema", () => {
    // Registering this schema under the draft-07 URI, or deleting that URI when
    // the compiled schema is released, would disable schema validation for the
    // whole process.
    expect(
      validateJsonSchemaSubset(
        { $id: "http://json-schema.org/draft-07/schema#", type: "string" },
        "x"
      )
    ).toEqual({ success: true });
    expect(validateJsonSchemaSubsetSchema({ type: "object", properties: "oops" }).success).toBe(
      false
    );
  });

  test("validates a schema that declares a dialect this validator does not load", () => {
    // zod v4 emits a 2020-12 `$schema`; the dialect declaration describes the
    // document, so it must neither throw nor change the verdict.
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" };
    expect(validateJsonSchemaSubset(schema, "text")).toEqual({ success: true });
    expect(validateJsonSchemaSubset(schema, 1).success).toBe(false);
  });

  test("keeps validating correctly once the compiled-validator cache has evicted entries", () => {
    const first = { type: "object", properties: { keep: { const: "first" } } };
    expect(validateJsonSchemaSubset(first, { keep: "first" })).toEqual({ success: true });

    // More distinct schemas than the cache holds, so `first` is evicted and
    // later recompiled.
    for (let i = 0; i < 600; i += 1) {
      expect(validateJsonSchemaSubset({ type: "integer", minimum: i }, i)).toEqual({
        success: true,
      });
    }

    expect(validateJsonSchemaSubset(first, { keep: "first" })).toEqual({ success: true });
    expect(validateJsonSchemaSubset(first, { keep: "other" }).success).toBe(false);
  });
});
