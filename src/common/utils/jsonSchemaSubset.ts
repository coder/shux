import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import type AjvCore from "ajv/dist/core";
import type { RegExpEngine } from "ajv/dist/types";
import { RE2JS } from "re2js";

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

/**
 * Bounds of the schemas the validator judges. Every traversal of a schema in
 * this module and its callers is bounded by the depth, so a third-party schema
 * cannot overflow the stack before it is judged. Compiling a schema is linear
 * in its size: its node count (every object, array, and primitive in the
 * document) and its text (every key and string value, which the cache key,
 * the clone the contract layer widens, and each compiled pattern copy). The
 * contract layer compiles each optional property's sub-schema on top, so the
 * size bounds keep one schema's synchronous work on the main process bounded
 * too. Past any bound the schema is outside the subset.
 */
export const JSON_SCHEMA_SUBSET_MAX_DEPTH = 64;
export const JSON_SCHEMA_SUBSET_MAX_NODES = 2048;
export const JSON_SCHEMA_SUBSET_MAX_CHARS = 256 * 1024;

/**
 * The dialects this validator speaks. A schema is judged in the dialect its
 * `$schema` declares: draft-07 Ajv would silently ignore 2020-12 keywords such
 * as `dependentRequired` and `prefixItems`, and a verdict in the wrong dialect
 * is worse than none. That cuts both ways, so no dialect stands in for
 * another: draft-06 has no `if`/`then`/`else`, and a draft-07 verdict on a
 * draft-06 schema would enforce keywords its server ignores. An undeclared
 * dialect is draft-07, the default of the JSON Schema emitters this app meets
 * (zod v3, OpenAPI tooling).
 */
export type Dialect = "draft-07" | "2019-09" | "2020-12";

const DIALECT_BY_SCHEMA_URI = new Map<string, Dialect>([
  ["json-schema.org/draft-07/schema", "draft-07"],
  ["json-schema.org/draft/2019-09/schema", "2019-09"],
  ["json-schema.org/draft/2020-12/schema", "2020-12"],
]);

/** A least-recently-used cache of at most `maxEntries` values. */
class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-insert so Map iteration order doubles as recency order.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest != null) {
        this.entries.delete(oldest);
      }
    }
  }
}

// Patterns come from third-party schemas and are evaluated on model output
// (`pattern` on strings, `patternProperties` on keys), so they run on RE2,
// which matches in time linear in the input: with a backtracking engine, a
// server-authored pattern and a model-chosen key could hold the main process
// for minutes. A pattern outside RE2's syntax (backreferences, lookarounds,
// which JSON Schema itself recommends against) does not compile, so a schema
// that carries one is outside the subset. Compiled patterns are cached like
// compiled schemas, and the cache holds every pattern of a schema in the
// subset (a schema has fewer patterns than nodes), so compiling a schema, or
// matching every key of a payload against its patterns in order, never evicts
// its own patterns.
const PATTERN_CACHE_MAX_ENTRIES = JSON_SCHEMA_SUBSET_MAX_NODES;
const patternCache = new LruCache<RE2JS>(PATTERN_CACHE_MAX_ENTRIES);

function compilePattern(pattern: string): RE2JS {
  const cached = patternCache.get(pattern);
  if (cached != null) {
    return cached;
  }
  const compiled = RE2JS.compile(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Compile a JSON Schema pattern into a verdict on text, by the validator's own
 * engine. A pattern the validator cannot compile matches nothing.
 */
export function compileJsonSchemaPattern(pattern: string): (text: string) => boolean {
  try {
    const compiled = compilePattern(pattern);
    return (text) => compiled.matcher(text).find();
  } catch {
    return () => false;
  }
}

// Ajv keys each compiled pattern by `toString()` within one compilation.
// `code` is only emitted into standalone validator source, which this module
// never generates.
const linearRegExp: RegExpEngine = Object.assign(
  (pattern: string) => {
    const compiled = compilePattern(pattern);
    return { test: (text: string) => compiled.matcher(text).find(), toString: () => pattern };
  },
  { code: "linearRegExp" }
);

// Ajv compiles schemas for this module; it is not their registry
// (`addUsedSchema: false`). Compiled validators are looked up by schema text
// below, never by `$id`.
const AJV_OPTIONS = {
  allErrors: true,
  strict: false,
  validateSchema: true,
  addUsedSchema: false,
  code: { regExp: linearRegExp },
};
const validators: Record<Dialect, AjvCore> = {
  "draft-07": new Ajv(AJV_OPTIONS),
  "2019-09": new Ajv2019(AJV_OPTIONS),
  "2020-12": new Ajv2020(AJV_OPTIONS),
};

function getDialect(schema: Record<string, unknown>): Dialect | null {
  if (schema.$schema === undefined) {
    return "draft-07";
  }
  if (typeof schema.$schema !== "string") {
    return null;
  }
  const uri = schema.$schema.replace(/^https?:\/\//u, "").replace(/#$/u, "");
  return DIALECT_BY_SCHEMA_URI.get(uri) ?? null;
}

/**
 * The dialect a caller walking `schema` reads its keywords in: the one its
 * `$schema` declares, else draft-07. A schema in a dialect this validator does
 * not speak is outside the subset, and its walk reads it as draft-07 too, the
 * dialect the keywords it shares with (draft-04's `items` and
 * `additionalItems`) are spelled in.
 */
export function getJsonSchemaDialect(schema: unknown): Dialect {
  return (isPlainRecord(schema) ? getDialect(schema) : null) ?? "draft-07";
}

/** A schema as its dialect's Ajv sees it (see toValidatorTarget). */
interface ValidatorTarget {
  dialect: Dialect;
  ajv: AjvCore;
  schema: Record<string, unknown>;
}

/**
 * `$schema` and `$id` describe the schema document, not the instance:
 * `$schema` selects the dialect, and `$id` is an identity in Ajv's shared
 * registry, where a third-party value can collide with a meta-schema or delete
 * it when the compiled schema is released. `$ref` is rejected, so neither
 * keyword affects validation once the dialect is chosen. Null when the dialect
 * is one this validator does not speak.
 */
function toValidatorTarget(schema: Record<string, unknown>): ValidatorTarget | null {
  const dialect = getDialect(schema);
  if (dialect == null) {
    return null;
  }
  const { $schema, $id, ...structure } = schema;
  return { dialect, ajv: validators[dialect], schema: structure };
}

// Compiled validators are reused by schema text so repeated validation of one
// schema skips Ajv code generation. Schemas can come from third parties (an MCP
// server may return fresh tool schemas on every catalog refresh), so the cache
// is bounded: least-recently-used entries are evicted, and Ajv's own per-object
// cache is released right after compilation so only this map retains code.
const VALIDATOR_CACHE_MAX_ENTRIES = 512;
const validatorCache = new LruCache<ValidateFunction>(VALIDATOR_CACHE_MAX_ENTRIES);

type CompiledJsonSchema =
  | { success: true; validate: ValidateFunction }
  | { success: false; errors: JsonSchemaValidationError[] };

function compileJsonSchema(
  schema: unknown,
  options?: { requireObjectSchema?: boolean }
): CompiledJsonSchema {
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
  const subsetError = findSubsetViolation(schema, "$", 0, { nodes: 0, chars: 0 });
  if (subsetError != null) {
    return { success: false, errors: [subsetError] };
  }
  const target = toValidatorTarget(schema);
  if (target == null) {
    return {
      success: false,
      errors: [{ path: "$.$schema", message: "Unsupported JSON Schema dialect" }],
    };
  }

  try {
    if (!target.ajv.validateSchema(target.schema)) {
      return {
        success: false,
        errors: normalizeAjvErrors(target.ajv.errors ?? [], undefined, schema, {
          schemaErrors: true,
        }),
      };
    }
    return { success: true, validate: compileSchema(target) };
  } catch (error) {
    return {
      success: false,
      errors: [{ path: "$", message: error instanceof Error ? error.message : "Invalid schema" }],
    };
  }
}

export function validateJsonSchemaSubsetSchema(
  schema: unknown,
  options?: { requireObjectSchema?: boolean }
): JsonSchemaSubsetValidationResult {
  const compiled = compileJsonSchema(schema, options);
  return compiled.success ? { success: true } : compiled;
}

/**
 * Compile a schema once so repeated verdicts cost only the instance, not the
 * schema (its serialization for the cache key and its meta-validation). Null
 * when the schema is outside the supported subset (see
 * validateJsonSchemaSubsetSchema).
 */
export function compileJsonSchemaSubset(schema: unknown): ((value: unknown) => boolean) | null {
  const compiled = compileJsonSchema(schema);
  if (!compiled.success) {
    return null;
  }
  const validate = compiled.validate;
  return (value) => validate(value);
}

export function validateJsonSchemaSubset(
  schema: unknown,
  value: unknown
): JsonSchemaSubsetValidationResult {
  const compiled = compileJsonSchema(schema);
  if (!compiled.success) {
    return compiled;
  }
  if (compiled.validate(value)) {
    return { success: true };
  }
  return {
    success: false,
    errors: normalizeAjvErrors(compiled.validate.errors ?? [], value, schema),
  };
}

function compileSchema(target: ValidatorTarget): ValidateFunction {
  const key = `${target.dialect}\n${JSON.stringify(target.schema)}`;
  const cached = validatorCache.get(key);
  if (cached != null) {
    return cached;
  }
  let validate: ValidateFunction;
  try {
    validate = target.ajv.compile(target.schema as AnySchema);
  } finally {
    // Ajv caches every schema object it compiles; `$ref` is rejected above, so
    // the compiled closure stands alone and only this module's map retains it.
    target.ajv.removeSchema(target.schema as AnySchema);
  }
  validatorCache.set(key, validate);
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

// Reference resolution is not implemented, so a schema that uses any reference
// keyword is outside the subset.
const REFERENCE_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef"] as const;

/** The size of the schema walked so far (see JSON_SCHEMA_SUBSET_MAX_NODES). */
interface SchemaSize {
  nodes: number;
  chars: number;
}

/** The first way `schema` falls outside the subset: too deep, too large, or a reference. */
function findSubsetViolation(
  schema: unknown,
  path: string,
  depth: number,
  size: SchemaSize
): JsonSchemaValidationError | null {
  if (depth > JSON_SCHEMA_SUBSET_MAX_DEPTH) {
    return { path, message: "Schema is too deeply nested" };
  }
  size.nodes += 1;
  if (typeof schema === "string") {
    size.chars += schema.length;
  }
  if (size.nodes > JSON_SCHEMA_SUBSET_MAX_NODES || size.chars > JSON_SCHEMA_SUBSET_MAX_CHARS) {
    return { path, message: "Schema is too large" };
  }
  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries()) {
      const error = findSubsetViolation(item, `${path}[${index}]`, depth + 1, size);
      if (error != null) return error;
    }
    return null;
  }
  if (!isPlainRecord(schema)) {
    return null;
  }
  for (const keyword of REFERENCE_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      return { path, message: `${keyword} is not supported` };
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    // The value is a node, so its visit judges the key's length too.
    size.chars += key.length;
    const error = findSubsetViolation(value, `${path}.${key}`, depth + 1, size);
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
