import { describe, expect, test } from "bun:test";

import {
  createOptionalNullSchemaContract,
  stripOmissionPlaceholders,
  widenOptionalPropertiesToNullable,
} from "./optionalNullSchema";

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
      stripOmissionPlaceholders(source, {
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
      stripOmissionPlaceholders(source, {
        project_id: "",
        assignee_id: "",
        search: "",
        labels: [],
        milestone: null,
        nested: { id: "", detail: "" },
      })
    ).toEqual({ project_id: "", labels: [], milestone: null, nested: { id: "" } });

    const untouched = { project_id: "42332", search: "bug" };
    expect(stripOmissionPlaceholders(source, untouched)).toEqual(untouched);
    expect(stripOmissionPlaceholders(source, undefined)).toBeUndefined();
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
    expect(stripOmissionPlaceholders(source, { values: [{ label: null }] })).toEqual({
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

    expect(stripOmissionPlaceholders(source, { value: null })).toEqual({ value: null });
  });

  test.each(["$ref", "$dynamicRef", "$recursiveRef"])(
    "falls back to non-strict decoding for schemas with %s",
    (keyword) => {
      const source = {
        type: "object",
        properties: { value: { [keyword]: "#/$defs/value" } },
        $defs: { value: { type: "string" } },
      };
      const contract = createOptionalNullSchemaContract(source);

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
    expect(stripOmissionPlaceholders(source, { anything: null, impossible: null })).toEqual({
      anything: null,
    });
  });

  test("applies root property constraints before matching a union branch", () => {
    const source = {
      type: "object",
      properties: { value: { type: "string" } },
      anyOf: [{ type: "object" }],
    };

    expect(stripOmissionPlaceholders(source, { value: null })).toEqual({});
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
      expect(stripOmissionPlaceholders(source, { value: null })).toEqual({ value: null });
    }
  );
});
