import { asSchema, type FlexibleSchema } from "ai";

/**
 * Extract the JSON schema from a runtime tool entry without ever throwing.
 * Tool maps mix shapes that `asSchema` alone cannot normalize — passing a
 * plain object to `asSchema` makes it assume a lazy-schema function and call
 * it, throwing `TypeError: schema is not a function`:
 * - MCP/dynamic tools (and their sanitizeToolSchemaForOpenAI copies) carry
 *   `.inputSchema` wrappers exposing a `jsonSchema` getter that may lack the
 *   AI SDK schema symbol.
 * - sanitizeToolSchemaForOpenAI rewrites v3-style `.parameters` (and custom
 *   adapters declare `.parameters`/`.schema`) as plain JSON Schema objects.
 * A fingerprinting failure here would silently drop the whole turn-envelope
 * row and break "model-visible ⟹ logged", so every branch degrades to a
 * hashable value instead of propagating.
 */
export function extractToolJsonSchema(rawTool: unknown): unknown {
  const record =
    rawTool !== null && typeof rawTool === "object"
      ? (rawTool as { inputSchema?: unknown; parameters?: unknown; schema?: unknown })
      : undefined;
  const rawSchema = record?.inputSchema ?? record?.parameters ?? record?.schema;
  if (rawSchema == null) {
    // Sparse/schema-less entries fingerprint as the AI SDK empty object schema.
    return asSchema(undefined).jsonSchema;
  }
  if (typeof rawSchema === "object") {
    // jsonSchema() wrappers and MCP inputSchema wrappers expose the actual
    // JSON schema via a `jsonSchema` property/getter; unwrap it directly
    // (identical to what asSchema returns for symbol-bearing wrappers).
    const wrapped = (rawSchema as { jsonSchema?: unknown }).jsonSchema;
    if (wrapped !== null && typeof wrapped === "object") {
      return wrapped;
    }
    // Plain JSON Schema objects are already the schema. `~standard` excludes
    // standard-schema instances (zod), which asSchema must convert instead.
    if (typeof (rawSchema as { type?: unknown }).type === "string" && !("~standard" in rawSchema)) {
      return rawSchema;
    }
  }
  try {
    // asSchema normalizes the remaining FlexibleSchema forms (zod v3/v4,
    // symbol-bearing Schema instances, lazy schema functions).
    return asSchema(rawSchema as FlexibleSchema<unknown>).jsonSchema;
  } catch {
    // Unknown shape: fingerprint the raw value rather than aborting emission.
    return rawSchema;
  }
}
