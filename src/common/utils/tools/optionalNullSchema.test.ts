import { describe, expect, test } from "bun:test";

import { OPTIONAL_PLACEHOLDER_MAX_JUDGED } from "@/common/constants/toolLimits";
import {
  createOptionalNullSchemaContract,
  stripOmissionPlaceholders,
  widenOptionalPropertiesToNullable,
  type OmissionPlaceholderOptions,
} from "./optionalNullSchema";

// MCP arguments treat an optional "" as an omission; workflow reports do not.
const MCP: OmissionPlaceholderOptions = { emptyStringIsOmission: true };
const WORKFLOW: OmissionPlaceholderOptions = { emptyStringIsOmission: false };
const restoreMcp = (schema: unknown, value: unknown) =>
  stripOmissionPlaceholders(schema, value, MCP);

describe("optional null JSON Schema contract", () => {
  test("round trips a Linear-shaped optional argument schema", () => {
    const source = {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string" },
        cursor: { type: "string" },
        statusUpdateType: { type: "string", enum: ["project", "initiative"] },
        nullableNote: { type: ["string", "null"] },
      },
      additionalProperties: false,
    };

    const modelSchema = widenOptionalPropertiesToNullable(source);

    expect(modelSchema).toEqual({
      ...source,
      properties: {
        issueId: { type: "string" },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        statusUpdateType: {
          anyOf: [{ type: "string", enum: ["project", "initiative"] }, { type: "null" }],
        },
        nullableNote: { type: ["string", "null"] },
      },
    });
    expect(source.properties.cursor).toEqual({ type: "string" });
    expect(
      restoreMcp(source, {
        issueId: "CODAGT-709",
        cursor: "",
        statusUpdateType: null,
        nullableNote: null,
      })
    ).toEqual({ issueId: "CODAGT-709", nullableNote: null });
  });

  test("strips empty strings only for optional properties", () => {
    const source = {
      type: "object",
      required: ["project_id"],
      properties: {
        project_id: { type: "string" },
        assignee_id: { type: "string" },
        search: { type: "string" },
        labels: { type: "array" },
        milestone: { type: ["string", "null"] },
        nested: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, detail: { type: "string" } },
        },
      },
    };

    // A required "" is never dropped; the server stays the arbiter of its
    // validity. null and [] pass through where the source accepts them.
    expect(
      restoreMcp(source, {
        project_id: "",
        assignee_id: "",
        search: "",
        labels: [],
        milestone: null,
        nested: { id: "", detail: "" },
      })
    ).toEqual({ project_id: "", labels: [], milestone: null, nested: { id: "" } });

    const untouched = { project_id: "42332", search: "bug" };
    expect(restoreMcp(source, untouched)).toEqual(untouched);
    expect(restoreMcp(source, undefined)).toBeUndefined();
  });

  test("keeps optional empty strings for workflow reports while still dropping rejected nulls", () => {
    const source = {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" },
        detail: { type: "string" },
        score: { type: "number" },
        nested: { type: "object", properties: { note: { type: "string" } } },
      },
    };
    const payload = { summary: "done", detail: "", score: null, nested: { note: "" } };

    // A workflow script may read `detail === ""` back, so it stays; the null the
    // schema rejects is still a placeholder.
    expect(stripOmissionPlaceholders(source, payload, WORKFLOW)).toEqual({
      summary: "done",
      detail: "",
      nested: { note: "" },
    });
    expect(stripOmissionPlaceholders(source, payload, MCP)).toEqual({
      summary: "done",
      nested: {},
    });
  });

  test("preserves optional-property annotations on the widened schema", () => {
    const source = {
      type: "object",
      properties: {
        cursor: { type: "string", title: "Cursor", description: "Continue from this cursor" },
      },
    };

    expect(widenOptionalPropertiesToNullable(source)).toMatchObject({
      properties: {
        cursor: {
          title: "Cursor",
          description: "Continue from this cursor",
          anyOf: [source.properties.cursor, { type: "null" }],
        },
      },
    });
  });

  test("restores nested optional values in arrays and unions", () => {
    const source = {
      type: "object",
      required: ["values"],
      properties: {
        values: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      },
      additionalProperties: false,
    };

    expect(widenOptionalPropertiesToNullable(source)).toMatchObject({
      properties: {
        values: {
          anyOf: [
            {
              items: {
                properties: {
                  label: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
            },
          ],
        },
      },
    });
    expect(restoreMcp(source, { values: [{ label: null }] })).toEqual({
      values: [{}],
    });
  });

  test("preserves a raw value accepted by another union branch", () => {
    const source = {
      anyOf: [
        {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["value"],
          properties: { value: { type: ["string", "null"] } },
          additionalProperties: false,
        },
      ],
    };

    expect(restoreMcp(source, { value: null })).toEqual({ value: null });
  });

  test("restores optional placeholders inside the union branch that accepts the raw value", () => {
    const source = {
      anyOf: [
        {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { const: "ok" },
            query: { type: "string" },
            note: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["kind", "message"],
          properties: { kind: { const: "error" }, message: { type: "string" } },
        },
      ],
    };

    // The "ok" branch accepts the raw object, but its optional `query` still
    // holds a placeholder that would reach the server.
    expect(restoreMcp(source, { kind: "ok", query: "", note: "kept" })).toEqual({
      kind: "ok",
      note: "kept",
    });
    // A required property inside the accepting branch is never a placeholder.
    expect(restoreMcp(source, { kind: "error", message: "" })).toEqual({
      kind: "error",
      message: "",
    });
  });

  test("evaluates conditional and negated schemas when deciding nullability", () => {
    const source = {
      type: "object",
      properties: {
        // Rejects null only through the conditional.
        conditional: { if: { const: null }, then: false },
        // Accepts null only through the conditional.
        nullableViaElse: { if: { type: "string" }, then: { minLength: 1 }, else: { const: null } },
        negated: { not: { type: "null" } },
      },
    };

    expect(widenOptionalPropertiesToNullable(source)).toMatchObject({
      properties: {
        conditional: { anyOf: [{ if: { const: null }, then: false }, { type: "null" }] },
        nullableViaElse: source.properties.nullableViaElse,
        negated: { anyOf: [{ not: { type: "null" } }, { type: "null" }] },
      },
    });
    expect(
      stripOmissionPlaceholders(
        source,
        { conditional: null, nullableViaElse: null, negated: null },
        WORKFLOW
      )
    ).toEqual({ nullableViaElse: null });
  });

  test("restores array items declared inside allOf", () => {
    const source = {
      type: "object",
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          allOf: [
            {
              items: {
                type: "object",
                properties: { note: { type: "string" } },
              },
            },
          ],
        },
      },
    };

    expect(widenOptionalPropertiesToNullable(source)).toMatchObject({
      properties: {
        rows: {
          allOf: [
            { items: { properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
          ],
        },
      },
    });
    expect(restoreMcp(source, { rows: [{ note: null }, { note: "kept" }] })).toEqual({
      rows: [{}, { note: "kept" }],
    });
  });

  test.each(["$ref", "$dynamicRef", "$recursiveRef"])(
    "falls back to non-strict decoding for schemas with %s",
    (keyword) => {
      const source = {
        type: "object",
        properties: { value: { [keyword]: "#/$defs/value" } },
        $defs: { value: { type: "string" } },
      };
      const contract = createOptionalNullSchemaContract(source, MCP);

      expect(contract.strict).toBe(false);
      expect(contract.modelSchema).toEqual(source);
      // Nullability behind a reference is unknown, so null stays; "" is a
      // placeholder regardless of type, so it still goes.
      expect(contract.restore({ value: null })).toEqual({ value: null });
      expect(contract.restore({ value: "" })).toEqual({});
    }
  );

  test("handles boolean schemas without changing explicit valid nulls", () => {
    const source = {
      type: "object",
      properties: { anything: true, impossible: false },
    };

    expect(widenOptionalPropertiesToNullable(source)).toEqual({
      ...source,
      properties: {
        anything: true,
        impossible: { anyOf: [false, { type: "null" }] },
      },
    });
    expect(restoreMcp(source, { anything: null, impossible: null })).toEqual({
      anything: null,
    });
  });

  test("applies root property constraints before matching a union branch", () => {
    const source = {
      type: "object",
      properties: { value: { type: "string" } },
      anyOf: [{ type: "object" }],
    };

    expect(restoreMcp(source, { value: null })).toEqual({});
  });

  test("preserves an empty string the selected union branch requires", () => {
    const source = {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { enum: ["ok", "error"] },
        message: { type: "string" },
        detail: { type: "string" },
      },
      oneOf: [
        { properties: { kind: { const: "ok" } } },
        { properties: { kind: { const: "error" } }, required: ["message"] },
      ],
    };

    // Root marks `message` optional, but the "error" branch requires it, so
    // `""` is a value there and not an omission placeholder.
    expect(restoreMcp(source, { kind: "error", message: "", detail: "" })).toEqual({
      kind: "error",
      message: "",
    });
    // The "ok" branch does not require it, so the placeholder still goes.
    expect(restoreMcp(source, { kind: "ok", message: "" })).toEqual({ kind: "ok" });
    // Null placeholders on other properties do not block branch selection.
    expect(restoreMcp(source, { kind: "error", message: "", detail: null })).toEqual({
      kind: "error",
      message: "",
    });
  });

  test("keeps the raw shape when stripping would only switch to a sibling branch", () => {
    const source = {
      type: "object",
      required: ["kind"],
      properties: { kind: { const: "a" }, message: { type: "string" } },
      oneOf: [
        { required: ["message"] },
        { properties: { kind: { const: "a" } }, additionalProperties: false },
      ],
    };

    // The raw value satisfies the first branch, which requires `message`; the
    // stripped value would satisfy the second. The raw match wins.
    expect(restoreMcp(source, { kind: "a", message: "" })).toEqual({ kind: "a", message: "" });
  });

  test.each(["allOf", "anyOf"] as const)(
    "preserves a parent-required property declared inside %s",
    (keyword) => {
      const source = {
        type: "object",
        required: ["value"],
        [keyword]: [{ properties: { value: { type: "string" } } }],
      };

      expect(widenOptionalPropertiesToNullable(source)).toEqual(source);
      expect(restoreMcp(source, { value: null })).toEqual({ value: null });
    }
  );

  test("keeps a placeholder that a satisfied condition requires for this instance", () => {
    const source = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { mode: { type: "string" }, query: { type: "string" } },
          if: { properties: { mode: { const: "search" } }, required: ["mode"] },
          then: { required: ["query"] },
        },
      },
    };

    // `query` is only required when mode is "search"; the model's "" is then a
    // real (empty) query, not an omission.
    expect(restoreMcp(source, { filter: { mode: "search", query: "" } })).toEqual({
      filter: { mode: "search", query: "" },
    });
    expect(restoreMcp(source, { filter: { mode: "recent", query: "" } })).toEqual({
      filter: { mode: "recent" },
    });
  });

  test("keeps placeholders that property dependencies require, chained", () => {
    const source = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      dependencies: { a: ["b"], b: ["c"] },
    };

    // Putting `b` back activates the requirement on `c`.
    expect(restoreMcp(source, { a: "x", b: "", c: "" })).toEqual({ a: "x", b: "", c: "" });
    expect(restoreMcp(source, { b: "", c: "" })).toEqual({});
  });

  test("keeps a placeholder that a union inside a satisfied condition requires", () => {
    const source = {
      type: "object",
      properties: {
        mode: { type: "string" },
        query: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
      },
      if: { properties: { mode: { const: "search" } }, required: ["mode"] },
      then: { anyOf: [{ required: ["query"] }, { required: ["ids"] }] },
    };

    expect(restoreMcp(source, { mode: "search", query: "" })).toEqual({
      mode: "search",
      query: "",
    });
    // `ids` satisfies the union, so `query` is a plain omission here.
    expect(restoreMcp(source, { mode: "search", query: "", ids: ["a"] })).toEqual({
      mode: "search",
      ids: ["a"],
    });
    expect(restoreMcp(source, { mode: "recent", query: "" })).toEqual({ mode: "recent" });
  });

  test("keeps a placeholder that a constraint other than required needs", () => {
    const source = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      minProperties: 2,
    };

    expect(restoreMcp(source, { a: "x", b: "" })).toEqual({ a: "x", b: "" });
    expect(restoreMcp(source, { a: "x", b: "y", c: "" })).toEqual({ a: "x", b: "y" });
  });

  test("deletes rejected nulls before judging empty strings", () => {
    const source = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      minProperties: 1,
    };

    // The null can never stay, so it must not count toward minProperties when
    // deciding whether "" may go.
    expect(restoreMcp(source, { a: "", b: null })).toEqual({ a: "" });
  });

  test("keeps every optional empty string instead of judging an unbounded number one by one", () => {
    const names = Array.from({ length: OPTIONAL_PLACEHOLDER_MAX_JUDGED + 1 }, (_, i) => `p${i}`);
    const source = {
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      minProperties: 2,
    };
    const value = Object.fromEntries(names.map((name) => [name, ""]));

    // The plain reading ({}) is rejected, and there are too many "" to judge
    // each deletion, so the valid payload stays whole.
    expect(restoreMcp(source, value)).toEqual(value);
    // One fewer, and the judgement runs.
    const { p0: _p0, ...judged } = value;
    expect(Object.keys(restoreMcp(source, judged) as object)).toHaveLength(2);
  });

  test("restores payloads for a schema that declares a dialect the validator does not load", () => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };

    expect(restoreMcp(source, { a: "", b: "" })).toEqual({ a: "" });
  });

  test("falls back to the required list when the schema is outside the validator subset", () => {
    const source = {
      type: "object",
      $defs: { text: { type: "string" } },
      properties: { title: { $ref: "#/$defs/text" }, note: { $ref: "#/$defs/text" } },
      required: ["title"],
    };

    expect(restoreMcp(source, { title: "", note: "" })).toEqual({ title: "" });
  });
});
