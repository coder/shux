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

  test("judges a null by the union branch in force when branches disagree on nullability", () => {
    const source = {
      oneOf: [
        {
          type: "object",
          required: ["kind", "value"],
          properties: { kind: { const: "nullable" }, value: { type: ["string", "null"] } },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["kind"],
          properties: { kind: { const: "optional" }, value: { type: "string" } },
          additionalProperties: false,
        },
      ],
    };

    expect(restoreMcp(source, { kind: "nullable", value: null })).toEqual({
      kind: "nullable",
      value: null,
    });
    expect(restoreMcp(source, { kind: "optional", value: null })).toEqual({ kind: "optional" });
  });

  test("keeps a null that an open union branch accepts", () => {
    const source = {
      anyOf: [
        {
          type: "object",
          required: ["kind"],
          properties: { kind: { const: "typed" }, value: { type: "string" } },
        },
        // Declares no `value`, so any `value` satisfies it.
        { type: "object", required: ["kind"], properties: { kind: { const: "untyped" } } },
      ],
    };

    expect(restoreMcp(source, { kind: "untyped", value: null })).toEqual({
      kind: "untyped",
      value: null,
    });
    expect(restoreMcp(source, { kind: "typed", value: null })).toEqual({ kind: "typed" });
  });

  test("tells a property whose name contains a slash apart from a nested property", () => {
    const source = {
      type: "object",
      properties: {
        "a/b": { type: "string" },
        a: { type: "object", properties: { b: { type: "string" } } },
      },
    };

    expect(restoreMcp(source, { "a/b": "", a: { b: "" } })).toEqual({ a: {} });
    expect(restoreMcp(source, { "a/b": null, a: { b: null } })).toEqual({ a: {} });
  });

  test("restores placeholders inside dictionary values", () => {
    const entry = { type: "object", properties: { note: { type: "string" } } };
    const source = {
      type: "object",
      properties: {
        byId: { type: "object", additionalProperties: entry },
        byPrefix: { type: "object", patternProperties: { "^x-": entry } },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    };

    expect(
      restoreMcp(source, {
        byId: { first: { note: "" }, second: { note: null } },
        byPrefix: { "x-a": { note: "" }, other: { note: "" } },
        env: { DEBUG: "" },
      })
    ).toEqual({
      byId: { first: {}, second: {} },
      // `other` matches no pattern, so nothing declares its `note`.
      byPrefix: { "x-a": {}, other: { note: "" } },
      // A dictionary entry is data the model chose, not a declared optional property.
      env: { DEBUG: "" },
    });
  });

  test("matches dictionary keys with the validator's pattern engine", () => {
    // Patterns run on a linear-time engine because the key is model-chosen and
    // the restore hook runs before any tool deadline. A pattern that engine
    // cannot compile puts the schema outside the subset and governs nothing.
    const entry = { type: "object", properties: { note: { type: "string" } } };
    const source = {
      type: "object",
      patternProperties: { "^(?=x)x-": entry, "^y-": entry },
    };

    expect(restoreMcp(source, { "x-a": { note: "" }, "y-a": { note: "" } })).toEqual({
      "x-a": { note: "" },
      "y-a": {},
    });
  });

  test("restores placeholders in tuple items past the prefix", () => {
    const tail = { type: "object", properties: { note: { type: "string" } } };
    const rows = ["head", { note: "" }, { note: null }];
    const draft07 = {
      type: "object",
      properties: { rows: { type: "array", items: [{ type: "string" }], additionalItems: tail } },
    };
    const draft2020 = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { rows: { type: "array", prefixItems: [{ type: "string" }], items: tail } },
    };

    expect(restoreMcp(draft07, { rows })).toEqual({ rows: ["head", {}, {}] });
    expect(restoreMcp(draft2020, { rows })).toEqual({ rows: ["head", {}, {}] });
  });

  test("reads tuple keywords in the schema's dialect", () => {
    // Draft-07 has no `prefixItems`, so its validator ignores one; reading it
    // anyway would let a schema that governs nothing delete a null the
    // schema that does govern accepts.
    const strict = { type: "object", properties: { note: { type: "string" } } };
    const nullable = { type: "object", properties: { note: { type: ["string", "null"] } } };
    const draft07 = {
      type: "object",
      properties: { rows: { type: "array", prefixItems: [strict], items: nullable } },
    };
    const draft2020 = { $schema: "https://json-schema.org/draft/2020-12/schema", ...draft07 };
    const rows = [{ note: null }];

    expect(restoreMcp(draft07, { rows })).toEqual({ rows });
    expect(restoreMcp(draft2020, { rows })).toEqual({ rows: [{}] });
  });

  test("restores a placeholder named __proto__ as an own property", () => {
    // Once the own property is deleted, `parent.__proto__ = ""` reaches
    // Object.prototype's accessor and the key never returns.
    const source = {
      type: "object",
      minProperties: 2,
      properties: { ["__proto__"]: { type: "string" }, other: { type: "string" } },
    };
    const restored = restoreMcp(source, JSON.parse('{"__proto__":"","other":"x"}'));

    expect(Object.getOwnPropertyDescriptor(restored, "__proto__")?.value).toBe("");
  });

  test("returns placeholders to the omitted reading until the root accepts", () => {
    // Every branch requires `a`, and only the first accepts it as null, so the
    // model's payload, the omitted reading, and any reading without `a` are
    // rejected: judging from the model's payload would omit `a` first.
    const source = {
      anyOf: [
        {
          type: "object",
          required: ["a"],
          properties: {
            a: { type: ["string", "null"] },
            b: { type: "string" },
            c: { type: "string" },
          },
        },
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
      ],
    };

    expect(restoreMcp(source, { a: null, b: null, c: null })).toEqual({ a: null });
  });

  test("judges a named property by the patterns that match it too", () => {
    const source = {
      type: "object",
      properties: { "x-id": { type: ["string", "null"] } },
      patternProperties: { "^x-": { type: "string" } },
    };

    // The named declaration accepts null; the pattern that also governs the
    // name does not, so the payload is rejected while the null stays.
    expect(restoreMcp(source, { "x-id": null })).toEqual({});
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

  test("prefers the plain reading when the schema accepts both readings", () => {
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
    // stripped value satisfies the second. An optional "" is an omission
    // whenever the schema accepts the omission.
    expect(restoreMcp(source, { kind: "a", message: "" })).toEqual({ kind: "a" });
    // Without the second branch, the "" is what keeps the payload valid.
    expect(restoreMcp({ ...source, oneOf: [source.oneOf[0]] }, { kind: "a", message: "" })).toEqual(
      { kind: "a", message: "" }
    );
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

  test("keeps a placeholder that an ancestor condition requires", () => {
    const source = {
      type: "object",
      properties: {
        mode: { type: "string" },
        config: { type: "object", properties: { query: { type: "string" } } },
      },
      if: { properties: { mode: { const: "search" } }, required: ["mode"] },
      then: { properties: { config: { required: ["query"] } } },
    };

    expect(restoreMcp(source, { mode: "search", config: { query: "" } })).toEqual({
      mode: "search",
      config: { query: "" },
    });
    expect(restoreMcp(source, { mode: "recent", config: { query: "" } })).toEqual({
      mode: "recent",
      config: {},
    });
  });

  test("judges the payload in the dialect the schema declares", () => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      dependentRequired: { a: ["b"] },
    };

    expect(restoreMcp(source, { a: "x", b: "" })).toEqual({ a: "x", b: "" });
    // Without the declaration the schema is draft-07, where `dependentRequired`
    // does not exist, so `b` is a plain omission.
    const { $schema: _dialect, ...draft07 } = source;
    expect(restoreMcp(draft07, { a: "x", b: "" })).toEqual({ a: "x" });
  });

  test("leaves a schema in a dialect the validator does not speak alone", () => {
    const source = {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };
    const contract = createOptionalNullSchemaContract(source, MCP);

    expect(contract.strict).toBe(false);
    expect(contract.modelSchema).toEqual(source);
    expect(contract.restore({ a: "", b: "" })).toEqual({ a: "" });
  });

  test("leaves a schema too deep to judge alone without walking it", () => {
    let source: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 100_000; depth++) {
      source = { type: "object", properties: { a: source } };
    }
    const contract = createOptionalNullSchemaContract(source, MCP);

    expect(contract.strict).toBe(false);
    expect(contract.modelSchema).toBe(source);
    expect(contract.restore({ a: { a: "" } })).toEqual({ a: {} });
  });

  test("leaves a schema too large to judge alone without compiling its properties", () => {
    // Every optional property costs one validator compilation when widened, so
    // an MCP server's schema width must not set the main process's work.
    const source = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 10_000 }, (_, i) => [`p${i}`, { type: "string", description: `${i}` }])
      ),
    };
    const contract = createOptionalNullSchemaContract(source, MCP);

    expect(contract.strict).toBe(false);
    expect(contract.modelSchema).toBe(source);
    expect(contract.restore({ p0: "", p1: "x" })).toEqual({ p1: "x" });
  });

  test("widens optional properties wherever the schema declares them", () => {
    const entry = { type: "object", properties: { note: { type: "string" } } };
    const widened = {
      type: "object",
      properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } },
    };
    const source = {
      type: "object",
      required: ["byId", "byPrefix", "rows"],
      properties: {
        byId: { type: "object", additionalProperties: entry },
        byPrefix: { type: "object", patternProperties: { "^x-": entry } },
        rows: { type: "array", items: [{ type: "string" }], additionalItems: entry },
      },
      if: { required: ["byId"] },
      then: { properties: { extra: entry } },
    };

    expect(widenOptionalPropertiesToNullable(source)).toMatchObject({
      properties: {
        byId: { additionalProperties: widened },
        byPrefix: { patternProperties: { "^x-": widened } },
        rows: { additionalItems: widened },
      },
      // `if` is a test, not a contract: widening it would change what it matches.
      if: { required: ["byId"] },
      then: { properties: { extra: widened } },
    });
  });

  test("widens tuple items in the schema's dialect", () => {
    const entry = { type: "object", properties: { note: { type: "string" } } };
    const widened = {
      type: "object",
      properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } },
    };
    // One object per keyword: the clone keeps shared references shared.
    const draft07 = {
      type: "object",
      required: ["tuple"],
      properties: {
        tuple: {
          type: "array",
          prefixItems: [structuredClone(entry)],
          items: structuredClone(entry),
          additionalItems: structuredClone(entry),
        },
      },
    };
    const draft2020 = { $schema: "https://json-schema.org/draft/2020-12/schema", ...draft07 };

    // Each dialect's validator ignores the other's tuple keywords, so widening
    // them would invite placeholders `restore` never sees.
    expect(widenOptionalPropertiesToNullable(draft07)).toMatchObject({
      properties: { tuple: { prefixItems: [entry], items: widened, additionalItems: entry } },
    });
    expect(widenOptionalPropertiesToNullable(draft2020)).toMatchObject({
      properties: { tuple: { prefixItems: [widened], items: widened, additionalItems: entry } },
    });
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
