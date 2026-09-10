import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as zod4Core from "zod/v4/core";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";

describe("proxifyOrpc schema enhancement", () => {
  describe("describeZodType", () => {
    // Helper to get description from a schema via JSON Schema conversion
    function getJsonSchemaDescription(schema: z.ZodTypeAny): string | undefined {
      const jsonSchema = zod4Core.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
        override: (ctx) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
          const meta = (ctx.zodSchema as any).meta?.();
          if (meta) Object.assign(ctx.jsonSchema, meta);
        },
      });
      return jsonSchema.description;
    }

    test("described object schema has description in JSON Schema", () => {
      const schema = z.object({ foo: z.string() }).describe("Test description");
      const desc = getJsonSchemaDescription(schema);
      expect(desc).toBe("Test description");
    });

    test("enum values are preserved in JSON Schema", () => {
      const schema = z.enum(["a", "b", "c"]);
      const jsonSchema = zod4Core.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
      });
      expect(jsonSchema.enum).toEqual(["a", "b", "c"]);
    });

    test("optional fields are marked in JSON Schema", () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });
      const jsonSchema = zod4Core.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
        override: (ctx) => {
          if (ctx.zodSchema?.constructor?.name === "ZodOptional") {
            ctx.jsonSchema.optional = true;
          }
        },
      });
      expect(jsonSchema.required).toContain("required");
      expect(jsonSchema.required).not.toContain("optional");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      expect((jsonSchema.properties as any)?.optional?.optional).toBe(true);
    });
  });

  describe("void schema handling", () => {
    test("void schema converts to empty JSON Schema object", () => {
      // In the actual proxifyOrpc, void schemas are converted to z.object({})
      const emptyObj = z.object({});
      const jsonSchema = zod4Core.toJSONSchema(emptyObj, {
        io: "input",
        unrepresentable: "any",
      });
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toEqual({});
    });
  });

  describe("nested object descriptions", () => {
    test("described nested object preserves description", () => {
      const nested = z
        .object({
          field1: z.string(),
          field2: z.number(),
        })
        .describe("Required: field1: string, field2: number");

      const parent = z.object({
        nested,
      });

      const jsonSchema = zod4Core.toJSONSchema(parent, {
        io: "input",
        unrepresentable: "any",
        override: (ctx) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
          const meta = (ctx.zodSchema as any).meta?.();
          if (meta) Object.assign(ctx.jsonSchema, meta);
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const nestedJsonSchema = (jsonSchema.properties as any)?.nested;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(nestedJsonSchema?.description).toBe("Required: field1: string, field2: number");
    });
  });
});

describe("proxifyOrpc CLI help output", () => {
  test("workspace resume-stream shows options description", () => {
    const r = router();
    const proxied = proxifyOrpc(r, { baseUrl: "http://localhost:8080" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const resumeStream = (proxied as any).workspace?.resumeStream;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const inputSchema = resumeStream?.["~orpc"]?.inputSchema;

    // The options field should have a description
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const optionsField = inputSchema?.def?.shape?.options;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(optionsField?.description).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(optionsField?.description).toContain("model: string");
  });

  test("enhanced schema preserves _zod property for JSON Schema conversion", () => {
    const r = router();
    const proxied = proxifyOrpc(r, { baseUrl: "http://localhost:8080" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const resumeStream = (proxied as any).workspace?.resumeStream;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const inputSchema = resumeStream?.["~orpc"]?.inputSchema;

    // Must have _zod for trpc-cli to detect Zod 4
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(inputSchema?._zod).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(inputSchema?._zod?.version?.major).toBe(4);

    // _zod.def should have the enhanced shape
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const zodDefOptions = inputSchema?._zod?.def?.shape?.options;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(zodDefOptions?.description).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(zodDefOptions?.description).toContain("model: string");
  });

  test("enhanced schema preserves the Standard Schema validator", async () => {
    const r = router();
    const proxied = proxifyOrpc(r, { baseUrl: "http://localhost:8080" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const resumeStream = (proxied as any).workspace?.resumeStream;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const inputSchema = resumeStream?.["~orpc"]?.inputSchema;

    // oRPC validates call inputs via schema["~standard"].validate. Zod keeps
    // `~standard` non-enumerable, so the enhancement clone used to drop it and
    // every enhanced procedure crashed at call time ("reading 'validate'").
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const standard = inputSchema?.["~standard"];
    expect(standard).toBeDefined();
    // The validator must actually run and flag invalid input.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const result = await standard.validate({});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result.issues).toBeDefined();
  });

  test("JSON Schema for options includes description", () => {
    const r = router();
    const proxied = proxifyOrpc(r, { baseUrl: "http://localhost:8080" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const resumeStream = (proxied as any).workspace?.resumeStream as unknown;

    const inputSchema = (
      resumeStream as { ["~orpc"]?: { inputSchema?: z.ZodTypeAny } } | undefined
    )?.["~orpc"]?.inputSchema;

    expect(inputSchema).toBeDefined();
    if (!inputSchema) throw new Error("Expected input schema");

    // Convert to JSON Schema (what trpc-cli does)
    const jsonSchema = zod4Core.toJSONSchema(inputSchema, {
      io: "input",
      unrepresentable: "any",
      override: (ctx) => {
        if (ctx.zodSchema?.constructor?.name === "ZodOptional") {
          ctx.jsonSchema.optional = true;
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const meta = (ctx.zodSchema as any).meta?.();
        if (meta) Object.assign(ctx.jsonSchema, meta);
      },
    });

    // The options property should have a description
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const optionsJsonSchema = (jsonSchema.properties as any)?.options;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(optionsJsonSchema?.description).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(optionsJsonSchema?.description).toContain("model: string");
  });
});
