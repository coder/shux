import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";

export interface JsonSchemaValidationError {
  path: string;
  message: string;
}

export type JsonSchemaSubsetValidationResult =
  | { success: true }
  | { success: false; errors: JsonSchemaValidationError[] };

export function formatJsonSchemaValidationErrors(
  errors: readonly JsonSchemaValidationError[],
  options?: { maxErrors?: number }
): string {
  const visibleErrors =
    options?.maxErrors === undefined ? errors : errors.slice(0, options.maxErrors);
  return visibleErrors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

// Ajv compiles schemas for this module; it is not their registry
// (`addUsedSchema: false`). Compiled validators are looked up by schema text
// below, never by `$id`.
const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: true, addUsedSchema: false });

// Compiled validators are reused by schema text so repeated validation of one
// schema skips Ajv code generation. Schemas can come from third parties (an MCP
// server may return fresh tool schemas on every catalog refresh), so the cache
// is bounded: least-recently-used entries are evicted, and Ajv's own per-object
// cache is released right after compilation so only this map retains code.
const VALIDATOR_CACHE_MAX_ENTRIES = 512;
const validatorCache = new Map<string, ValidateFunction>();

/**
 * The schema as Ajv sees it. `$schema` and `$id` describe the schema document,
 * not the instance: `$schema` names a dialect this Ajv instance may not know
 * (zod v4 emits 2020-12, which would throw), and `$id` is an identity in Ajv's
 * shared registry, where a third-party value can collide with a meta-schema or
 * delete it when the compiled schema is released. `$ref` is rejected, so
 * neither keyword affects validation.
 */
function toValidatorSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, $id, ...validatorSchema } = schema;
  return validatorSchema;
}

export function validateJsonSchemaSubsetSchema(
  schema: unknown,
  options?: { requireObjectSchema?: boolean }
): JsonSchemaSubsetValidationResult {
  if (!isPlainRecord(schema)) {
    return { success: false, errors: [{ path: "$", message: "Schema must be an object" }] };
  }
  if (options?.requireObjectSchema === true && schema.type !== "object") {
    return {
      success: false,
      errors: [
        {
          path: "$.type",
          message:
            "Workflow agent schemas must be object schemas; wrap scalar or array results in an object field",
        },
      ],
    };
  }
  const refError = findRefKeyword(schema, "$", 0);
  if (refError != null) {
    return { success: false, errors: [refError] };
  }

  try {
    if (!ajv.validateSchema(toValidatorSchema(schema))) {
      return {
        success: false,
        errors: normalizeAjvErrors(ajv.errors ?? [], undefined, schema, { schemaErrors: true }),
      };
    }
    compileSchema(schema);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      errors: [{ path: "$", message: error instanceof Error ? error.message : "Invalid schema" }],
    };
  }
}

export function validateJsonSchemaSubset(
  schema: unknown,
  value: unknown
): JsonSchemaSubsetValidationResult {
  const schemaValidation = validateJsonSchemaSubsetSchema(schema);
  if (!schemaValidation.success) {
    return schemaValidation;
  }

  const validate = compileSchema(schema);
  if (validate(value)) {
    return { success: true };
  }

  return { success: false, errors: normalizeAjvErrors(validate.errors ?? [], value, schema) };
}

function compileSchema(schema: unknown): ValidateFunction {
  const validatorSchema = isPlainRecord(schema) ? toValidatorSchema(schema) : schema;
  const key = JSON.stringify(validatorSchema);
  const cached = validatorCache.get(key);
  if (cached != null) {
    // Re-insert so Map iteration order doubles as recency order.
    validatorCache.delete(key);
    validatorCache.set(key, cached);
    return cached;
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(validatorSchema as AnySchema);
  } finally {
    // Ajv caches every schema object it compiles; `$ref` is rejected above, so
    // the compiled closure stands alone and only this module's map retains it.
    ajv.removeSchema(validatorSchema as AnySchema);
  }
  validatorCache.set(key, validate);
  if (validatorCache.size > VALIDATOR_CACHE_MAX_ENTRIES) {
    const oldest = validatorCache.keys().next().value;
    if (oldest != null) {
      validatorCache.delete(oldest);
    }
  }
  return validate;
}

function normalizeAjvErrors(
  errors: readonly ErrorObject[],
  rootValue?: unknown,
  rootSchema?: unknown,
  options?: { schemaErrors?: boolean }
): JsonSchemaValidationError[] {
  return errors
    .map((error) => ({
      path: getErrorPath(error, options),
      message: getErrorMessage(error, rootValue, rootSchema),
      keyword: error.keyword,
    }))
    .sort((a, b) => getErrorSortWeight(a.keyword) - getErrorSortWeight(b.keyword))
    .map(({ path, message }) => ({ path, message }));
}

function getErrorSortWeight(keyword: string): number {
  if (keyword === "required") return 0;
  if (keyword === "enum") return 1;
  if (keyword === "type") return 2;
  if (keyword === "additionalProperties") return 99;
  return 10;
}

function getErrorPath(error: ErrorObject, options?: { schemaErrors?: boolean }): string {
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `${toDollarPath(error.instancePath)}.${error.params.missingProperty}`;
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    return `${toDollarPath(error.instancePath)}.${error.params.additionalProperty}`;
  }
  if (error.instancePath.length > 0) {
    return toDollarPath(error.instancePath);
  }
  if (options?.schemaErrors === true && error.schemaPath.length > 0) {
    return toDollarPath(error.schemaPath.replace(/^#\/?/u, "/"));
  }
  return "$";
}

function getErrorMessage(error: ErrorObject, rootValue?: unknown, rootSchema?: unknown): string {
  switch (error.keyword) {
    case "required":
      return "Required property is missing";
    case "type": {
      const expected = Array.isArray(error.params.type)
        ? error.params.type.join(" or ")
        : String(error.params.type);
      return `Expected ${expected}, got ${getJsonType(getValueAtPointer(rootValue, error.instancePath))}`;
    }
    case "enum": {
      const enumSchema =
        (error as ErrorObject & { schema?: unknown; parentSchema?: { enum?: unknown } }).schema ??
        (error as ErrorObject & { parentSchema?: { enum?: unknown } }).parentSchema?.enum ??
        getValueAtPointer(rootSchema, error.schemaPath.replace(/^#\/?/u, "/"));
      const allowedValues = Array.isArray(enumSchema)
        ? enumSchema.map(String).join(", ")
        : "the allowed values";
      return `Expected one of: ${allowedValues}`;
    }
    case "additionalProperties":
      return "Additional property is not allowed";
    default:
      return error.message ?? `JSON Schema validation failed: ${error.keyword}`;
  }
}

function getValueAtPointer(rootValue: unknown, pointer: string): unknown {
  let current = rootValue;
  for (const part of pointer.split("/").filter(Boolean).map(unescapePointer)) {
    if (Array.isArray(current) && /^\d+$/u.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (current != null && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

function toDollarPath(pointer: string): string {
  if (pointer === "" || pointer === "/") {
    return "$";
  }
  return (
    "$" +
    pointer
      .split("/")
      .filter(Boolean)
      .map((part) => (/^\d+$/u.test(part) ? `[${part}]` : `.${unescapePointer(part)}`))
      .join("")
  );
}

function unescapePointer(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function findRefKeyword(
  schema: unknown,
  path: string,
  depth: number
): JsonSchemaValidationError | null {
  if (depth > 64) {
    return { path, message: "Schema is too deeply nested" };
  }
  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries()) {
      const error = findRefKeyword(item, `${path}[${index}]`, depth + 1);
      if (error != null) return error;
    }
    return null;
  }
  if (!isPlainRecord(schema)) {
    return null;
  }
  if (Object.hasOwn(schema, "$ref")) {
    return { path, message: "$ref is not supported in workflow schemas" };
  }
  for (const [key, value] of Object.entries(schema)) {
    const error = findRefKeyword(value, `${path}.${key}`, depth + 1);
    if (error != null) return error;
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
