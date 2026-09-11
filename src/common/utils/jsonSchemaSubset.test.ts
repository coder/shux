import { describe, expect, test } from "bun:test";
import {
  JSON_SCHEMA_SUBSET_MAX_CHARS,
  JSON_SCHEMA_SUBSET_MAX_NODES,
  createSchemaBudget,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "./jsonSchemaSubset";

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
      errors: [{ path: "$", message: "$ref is not supported" }],
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

  test("rejects a schema with more nodes than it will compile", () => {
    // Compilation is linear in the node count, and a server-authored schema
    // can be as wide as it likes; a shallow schema must be bounded too.
    const wide = (properties: number) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: properties }, (_, i) => [`p${i}`, { type: "string" }])
      ),
    });

    const result = validateJsonSchemaSubsetSchema(wide(JSON_SCHEMA_SUBSET_MAX_NODES));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.message).toBe("Schema is too large");
    }
    expect(validateJsonSchemaSubsetSchema(wide(JSON_SCHEMA_SUBSET_MAX_NODES / 4))).toEqual({
      success: true,
    });
  });

  test("rejects a schema with more text than it will compile", () => {
    // A string is one node however long it is, and the cache key, the clone,
    // and a compiled pattern each copy every character of it.
    const text = "x".repeat(JSON_SCHEMA_SUBSET_MAX_CHARS);
    for (const schema of [
      { type: "string", description: text },
      { type: "object", properties: { [text]: { type: "string" } } },
    ]) {
      const result = validateJsonSchemaSubsetSchema(schema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.message).toBe("Schema is too large");
      }
    }
    expect(
      validateJsonSchemaSubsetSchema({
        type: "string",
        description: text.slice(0, JSON_SCHEMA_SUBSET_MAX_CHARS / 4),
      })
    ).toEqual({ success: true });
  });

  test("charges every schema from one source to the budget it shares", () => {
    // Many schemas that each fit the per-schema bound are unbounded together;
    // a source's budget pays for each walk and runs out.
    const wide = (properties: number) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: properties }, (_, i) => [`p${i}`, { type: "string" }])
      ),
    });
    const budget = createSchemaBudget(1);
    // Two nodes per property plus the root's three: three fit the budget of
    // one maximal schema, the fourth does not.
    const schema = wide(JSON_SCHEMA_SUBSET_MAX_NODES / 8);

    for (let i = 0; i < 3; i += 1) {
      expect(validateJsonSchemaSubsetSchema(schema, { budget })).toEqual({ success: true });
    }
    const spent = validateJsonSchemaSubsetSchema(schema, { budget });
    expect(spent.success).toBe(false);
    if (!spent.success) {
      expect(spent.errors[0]?.message).toBe("Schema is too large");
    }
    // The budget bounds its source, not the schema: the same schema still
    // compiles on its own.
    expect(validateJsonSchemaSubsetSchema(schema)).toEqual({ success: true });
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

  test("judges a schema in the dialect it declares", () => {
    // zod v4 emits a 2020-12 `$schema`. Draft-07 Ajv ignores 2020-12 keywords,
    // so the verdict must come from a 2020-12 validator.
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      dependentRequired: { a: ["b"] },
    };
    expect(validateJsonSchemaSubset(schema, { a: "x" }).success).toBe(false);
    expect(validateJsonSchemaSubset(schema, { a: "x", b: "y" })).toEqual({ success: true });
    // Undeclared means draft-07, where the keyword does not exist.
    const { $schema: _dialect, ...draft07 } = schema;
    expect(validateJsonSchemaSubset(draft07, { a: "x" })).toEqual({ success: true });
  });

  test("rejects a schema in a dialect it does not speak", () => {
    // Draft-06 lacks `if`/`then`/`else`, so a draft-07 verdict would enforce
    // keywords a draft-06 server ignores; no loaded dialect stands in for it.
    for (const uri of [
      "http://json-schema.org/draft-04/schema#",
      "http://json-schema.org/draft-06/schema#",
    ]) {
      const result = validateJsonSchemaSubsetSchema({ $schema: uri, type: "string" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.path).toBe("$.$schema");
      }
    }
  });

  test("matches patterns in time linear in the input", () => {
    // A backtracking engine backtracks exponentially to reject this input; the
    // pattern is server-authored and the key is model-chosen.
    const key = "a".repeat(44);
    const dictionary = {
      type: "object",
      patternProperties: { "^(a*)*$": { type: "string" } },
      additionalProperties: false,
    };
    expect(validateJsonSchemaSubset(dictionary, { [key]: "x" })).toEqual({ success: true });

    const start = performance.now();
    expect(validateJsonSchemaSubset(dictionary, { [`${key}!`]: "x" }).success).toBe(false);
    expect(performance.now() - start).toBeLessThan(250);
  });

  test("rejects a pattern outside the linear engine's syntax", () => {
    // JSON Schema recommends against lookarounds and backreferences; RE2 has neither.
    for (const pattern of ["(?=a)a", "(a)\\1"]) {
      expect(validateJsonSchemaSubsetSchema({ type: "string", pattern }).success).toBe(false);
    }
    expect(validateJsonSchemaSubsetSchema({ type: "string", pattern: "^(?:a|b)+$" })).toEqual({
      success: true,
    });
  });

  test("keeps schemas of different dialects apart in the validator cache", () => {
    const structure = { type: "array", prefixItems: [{ type: "string" }] };
    expect(validateJsonSchemaSubset(structure, [1])).toEqual({ success: true });
    expect(
      validateJsonSchemaSubset(
        { $schema: "https://json-schema.org/draft/2020-12/schema", ...structure },
        [1]
      ).success
    ).toBe(false);
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
